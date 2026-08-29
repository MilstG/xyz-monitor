"use strict";
const path = require("path");
const fs = require("fs");
const crypto = require("crypto");
const zlib = require("zlib");
const gzipAsync = require("util").promisify(zlib.gzip);   // -08: threadpool gzip for the cached-serve path
const Fastify = require("fastify");
const { openStore } = require("./src/store");
const { createPoller } = require("./src/poller");
const { openAccounts, PW_MIN: ACCOUNT_PW_MIN, DM_MAX_LEN: ACCOUNT_DM_MAX,
  FILE_MAX: ACCOUNT_DM_FILE_MAX } = require("./src/accounts");
const { featureGateFor, resolveFeatures } = require("./src/compute");

// Build stamp. Bumped on every delivery; shipped in /api/health, the snapshot payload and
// the UI status line — one glance answers "is the live site actually running this build?"
// (most historical "it doesn't work" reports were stale deploys, not bugs).
const VERSION = "2026.09.01-48";

// ===== event-loop delay instrumentation (build 2026.07.29-05, Phase 0 of the perf batch) =====
// The decision gate for any worker-thread work: measure BEFORE architecting. Armed here, before the
// store opens and before createPoller, so the histogram observes every build tick from the first
// one — arming it after poller start would blind it to exactly the boot-build stalls we care about.
// resolution 20ms: coarse enough to be ~free, fine enough that a 50ms+ stall (the gate threshold)
// is never missed. Nanosecond readings are converted to ms at the read site, 1 decimal.
const { monitorEventLoopDelay } = require("perf_hooks");
const loopHist = monitorEventLoopDelay({ resolution: 20 });
loopHist.enable();
const LOOP_WINDOW = 6 * 3600e3;   // histogram reset cadence; one ring point per window
const LOOP_RING_MAX = 28;         // 7 days at 6h — the full decision-gate observation period
const loopMs = (ns) => Math.round(ns / 1e5) / 10;
function loopSample() {
  return { p50: loopMs(loopHist.percentile(50)), p99: loopMs(loopHist.percentile(99)), max: loopMs(loopHist.max) };
}

const DEX = process.env.DEX || "xyz";
const PORT = Number(process.env.PORT || 3000);
const HOST = "0.0.0.0";
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, "data");
const SITE_PASSWORD = process.env.SITE_PASSWORD || ""; // set to require a shared password
const SITE_USER = process.env.SITE_USER || "friend";
const SESSION_DAYS = Number(process.env.SESSION_DAYS || 30);
// Session-signing secret. Derived from the credentials unless overridden, so changing the
// password on Railway invalidates every outstanding session with zero extra config, while
// plain restarts/redeploys keep everyone logged in.
const SESSION_SECRET = process.env.SESSION_SECRET
  ? crypto.createHash("sha256").update(String(process.env.SESSION_SECRET)).digest()
  : crypto.createHash("sha256").update(`xyzmon-session|${SITE_USER}|${SITE_PASSWORD}`).digest();
// ---- per-browser alert ownership -----------------------------------------------------------
// The app has ONE shared site password and no user accounts, so there is no "who" to attribute a
// linked Telegram account to. That was a real hole: alert delivery was designed per-person, but the
// management surface had no notion of person, so the first Telegram linked became a global row every
// visitor could see and nobody else could add alongside meaningfully.
//
// This is the smallest thing that closes it without inventing a login system: an opaque, signed,
// long-lived handle minted per browser. It is not a privilege — it grants nothing except the ability
// to see and manage the recipients linked FROM that browser. It is signed so it cannot be forged,
// and random so it cannot be guessed; whoever holds it controls those recipients, exactly like the
// session cookie itself. Admin sees and manages everything regardless.
const OWNER_SECRET = crypto.createHash("sha256").update(`xyzmon-alert-owner|${SITE_USER}|${SITE_PASSWORD}`).digest();
function signOwner(id) {
  return id + "." + crypto.createHmac("sha256", OWNER_SECRET).update("own|" + id).digest("base64url");
}
function ownerOf(tok) {
  if (!tok || typeof tok !== "string" || tok.length > 128) return null;
  const i = tok.indexOf(".");
  if (i <= 0) return null;
  const id = tok.slice(0, i);
  let ok = false;
  try {
    const want = Buffer.from(signOwner(id));
    const got = Buffer.from(tok);
    ok = want.length === got.length && crypto.timingSafeEqual(want, got);
  } catch (_) { ok = false; }
  return ok ? id : null;
}
// Reads the caller's handle, minting one if they don't have it yet. Lazy on purpose: a visitor who
// never opens the alerts panel never gets a cookie.
function ensureOwner(req, reply) {
  const existing = ownerOf(getCookie(req, "xyzown"));
  if (existing) return existing;
  const id = crypto.randomBytes(12).toString("base64url");
  reply.header("set-cookie", "xyzown=" + signOwner(id) + cookieAttrs(req, 400 * 24 * 3600) + "; HttpOnly");
  return id;
}

// AI admin gate. AI generation (ask-terminal fallback + report generation) is LOCKED by default
// and only opens after someone enters ADMIN_PASSWORD via `admin unlock` in the terminal. The
// unlock is a stateless HMAC cookie (xyzai), signed with a secret derived from ADMIN_PASSWORD —
// so rotating the admin password on Railway revokes every outstanding unlock, and an UNSET admin
// password mints no valid token, leaving the gate closed (fail-closed, never fail-open). There is
// deliberately no header/Basic-auth bypass: scripts can't unlock, so AI stays browser+password only.
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || "";
const AI_UNLOCK_SECRET = crypto.createHash("sha256").update(`xyzmon-ai-unlock|${ADMIN_PASSWORD}`).digest();
const AI_UNLOCK_MS = 24 * 3600 * 1000;   // hard ceiling on an unlock's life, even if the browser restores its session
// Admin VIEW is a separate, longer lease than the AI unlock above, and deliberately so: seeing the
// admin tabs costs nothing, while generating a report spends real OpenAI budget. Merging them would
// force one of the two to be wrong — either you re-authenticate to look at a table, or a 30-day
// cookie can spend money. So: xyzadm = 30d admin view, xyzai = browser-session AI spend, both
// derived from ADMIN_PASSWORD (rotate it and every outstanding token of BOTH kinds dies).
// The label in the secret differs from the AI one on purpose — with a shared secret an xyzai token
// would validate as xyzadm and the short lease would silently become a long one.
const ADMIN_VIEW_SECRET = crypto.createHash("sha256").update(`xyzmon-admin-view|${ADMIN_PASSWORD}`).digest();
const ADMIN_DAYS = Number(process.env.ADMIN_DAYS || 30);

function log(msg) { console.log(new Date().toISOString() + " " + msg); }

const store = openStore(DATA_DIR);
// ---- accounts, invites and direct messages --------------------------------------------------
// Its own SQLite file on the same volume. Deliberately separate from the market caches: none of
// this is market data, none of it is on the 15s path, and all of it wants transactions rather
// than the whole-file tmp+rename discipline the JSON caches use.
const ACCOUNTS = openAccounts(DATA_DIR, { sessionDays: SESSION_DAYS });
// How long a DM sits unread before it is worth interrupting somebody's evening over. The delay IS
// the feature: without it two people typing at each other generate a push per line.
const DM_ESCALATE_MS = Number(process.env.DM_ESCALATE_MS || 5 * 60 * 1000);
// The legacy shared-password door. Once accounts exist it stays open only while the operator is
// still migrating people, and it lands them on the claim page rather than straight into the app.
const LEGACY_DOOR = process.env.LEGACY_SHARED_PASSWORD !== "0";
// Definitive volume-persistence check: boot #1 on every deploy = the data dir is ephemeral
// (DATA_DIR not pointing at the volume mount, or no volume attached). Boot #N, first boot
// dating back days = the volume is fine and every warm cache above it can be trusted.
const HEARTBEAT = store.heartbeat();
log(`Volume heartbeat: boot #${HEARTBEAT.boots} on this data dir (first boot ${new Date(HEARTBEAT.firstBoot).toISOString()}) — ` +
  (HEARTBEAT.boots > 1 ? "volume IS persisting" : "if this says boot #1 again next deploy, the volume is NOT persisting (check DATA_DIR vs the mount path)"));
// Loop-delay ring: [t, p50, p99, max] per closed 6h window, plus the worst stall ever seen with its
// timestamp (a boot spike must stay attributable, not pollute the rolling read forever — which is
// also why the histogram resets each window instead of accumulating since boot). Persisted to the
// volume with the same atomic tmp+rename discipline as every other /data write, because the whole
// point is a WEEK of evidence for the worker-thread decision gate — a redeploy must not wipe it.
const LOOP_FILE = path.join(DATA_DIR, "loop-history.json");
let loopRing = [], loopMaxEver = null, loopResetAt = Date.now();
try {
  const j = JSON.parse(fs.readFileSync(LOOP_FILE, "utf8"));
  if (Array.isArray(j.ring)) loopRing = j.ring.slice(-LOOP_RING_MAX);
  if (j.maxEver && j.maxEver.v > 0) loopMaxEver = j.maxEver;
} catch (_) {}
function persistLoopSync() {
  try {
    const tmp = LOOP_FILE + ".tmp";
    fs.writeFileSync(tmp, JSON.stringify({ ring: loopRing, maxEver: loopMaxEver }));
    fs.renameSync(tmp, LOOP_FILE);
  } catch (_) {}
}
function rollLoopWindow() {
  // Always record: a window of near-zeros is honest data (an idle loop), and the unconditional
  // sample-then-reset ordering can never record an empty window in place of a real one.
  const s = loopSample();
  loopRing.push([Date.now(), s.p50, s.p99, s.max]);
  if (loopRing.length > LOOP_RING_MAX) loopRing = loopRing.slice(-LOOP_RING_MAX);
  if (!loopMaxEver || s.max > loopMaxEver.v) loopMaxEver = { v: s.max, t: Date.now() };
  loopHist.reset(); loopResetAt = Date.now();
  persistLoopSync();
  log(`event loop window closed: p50 ${s.p50}ms p99 ${s.p99}ms max ${s.max}ms (${loopRing.length}/${LOOP_RING_MAX} ring points)`);
}
setInterval(rollLoopWindow, LOOP_WINDOW).unref();

// Kill-switch: CRYPTO=0 disables main-dex polling entirely — one-variable rollback on Railway.
const CRYPTO = process.env.CRYPTO !== "0";
const poller = createPoller({ dex: DEX, store, log, version: VERSION, crypto: CRYPTO });
log(`Crypto (Hyperliquid main dex): ${CRYPTO ? "ENABLED — top-60 perps, 31d hourly / 90d daily retention" : "disabled via CRYPTO=0"}`);

// Weak ETag from the payload's data version so an unchanged snapshot revalidates to 304
// (browsers polling every 30s get a tiny empty response instead of the full table).
function etagFor(body) { return 'W/"' + (body.dataTs != null ? body.dataTs : (body.ts || 0)) + '"'; }
// Serialization cache keyed on the payload OBJECT itself (WeakMap): the poller replaces its cache
// objects wholesale on each content change, so the same object reference implies the same JSON. This
// turns the per-request JSON.stringify of the ~0.5 MB snapshot (once per polling client, every 30s)
// into one stringify per content change. Keyed on identity, not the ETag string, so two routes that
// happen to share a dataTs value can never serve each other's body. Auto-GC'd when the object is
// replaced. Fallback literals are fresh objects (WeakMap miss) but tiny, so re-stringifying is free.
const serialCache = new WeakMap();
// Second layer keyed on the same payload OBJECT: the gzipped Buffer of its serialization. Without
// this, @fastify/compress re-gzips the ~0.5 MB snapshot for EVERY polling client every cycle — the
// dominant per-request cost once serialization itself is cached. One compress per content change,
// shared across all clients, auto-GC'd when the poller swaps the cache object.
const gzipCache = new WeakMap();
// Uniform-stride downsample of a [[t, v], ...] track to at most `cap` points, keeping the last
// (live-edge) sample exact so the sparkline's right edge still reflects the current value.
const SERIES_CAP = 1500;
function downsampleSeries(arr, cap) {
  if (!Array.isArray(arr) || arr.length <= cap) return arr || [];
  const step = arr.length / cap, out = [];
  for (let i = 0; i < cap; i++) out.push(arr[Math.floor(i * step)]);
  const last = arr[arr.length - 1];
  if (out[out.length - 1] !== last) out.push(last);
  return out;
}
function serveCached(req, reply, payload, fallback) {
  const body = payload || fallback;
  const tag = etagFor(body);
  return sendCachedBody(req, reply, body, tag);
}
// Shared tail of the cached-serve path: ETag 304 short-circuit, then the WeakMap-memoized
// serialize + pre-gzip. Split out so serveKeyed (below) can supply its own ETag without
// duplicating the compression plumbing.
function sendCachedBody(req, reply, body, tag) {
  reply.header("cache-control", "no-cache");
  reply.header("etag", tag);
  if (req.headers["if-none-match"] === tag) { reply.code(304).send(); return; }
  let s = serialCache.get(body);
  if (s === undefined) { s = JSON.stringify(body); serialCache.set(body, s); }
  reply.header("content-type", "application/json; charset=utf-8");
  if (s.length >= 1024 && /\bgzip\b/.test(req.headers["accept-encoding"] || "")) {
    let gz = gzipCache.get(body);
    if (gz === undefined) {
      // Threadpool offload (build 2026.07.29-08): zlib.gzip runs on libuv's worker threads, so the
      // ~0.5 MB compress no longer holds the event loop even the one time per content change it
      // runs. The PROMISE is memoized immediately, so concurrent first requests share one
      // compression instead of racing; the resolved Buffer then replaces it in the cache and every
      // later request takes the synchronous fast path exactly as before.
      gz = gzipAsync(s).then((buf) => { gzipCache.set(body, buf); return buf; });
      gzipCache.set(body, gz);
    }
    reply.header("content-encoding", "gzip");
    reply.header("vary", "accept-encoding");
    return Buffer.isBuffer(gz) ? reply.send(gz) : gz.then((buf) => reply.send(buf));
  }
  return reply.send(s);   // under threshold or client can't gzip — @fastify/compress handles the rest
}
// Per-coin cached serve for candles/series. The poller builds these payloads FRESH on every call
// (fresh arrays, so the WeakMap serialize/gzip memo can never hit) and they carry no dataTs, so
// etagFor would hand every coin the SAME W/"0" tag — a client's If-None-Match could then be
// answered with a 304 for a DIFFERENT coin's chart. Both problems are fixed here: the ETag is an
// explicit content key (coin + query shape + the spine's own update stamp), so it's unique per
// (coin, timeframe, data version) and collisions are impossible; and a small bounded identity
// cache holds the built object under that key, giving the serialize+gzip memo a stable reference
// to hit on the tf-toggle spam these routes actually see. A new content version yields a new key,
// so a stale body is never served — the map just accumulates a superseded entry, pruned by size.
const keyedCache = new Map();   // etagKey -> built payload object (stable identity for the memos)
function serveKeyed(req, reply, etagKey, build, fallback) {
  const tag = 'W/"' + etagKey + '"';
  if (req.headers["if-none-match"] === tag) { reply.header("etag", tag).header("cache-control", "no-cache").code(304).send(); return; }
  let body = keyedCache.get(etagKey);
  if (body === undefined) {
    body = build() || fallback;
    keyedCache.set(etagKey, body);
    if (keyedCache.size > 800) { let i = 0; for (const k of keyedCache.keys()) { keyedCache.delete(k); if (++i >= 400) break; } }
  }
  return sendCachedBody(req, reply, body, tag);
}

// Constant-time credential check: hash both sides to equal length, then timingSafeEqual.
// Plain === leaks match length/position through response timing; hashing first also makes
// the comparison safe for unequal-length inputs (timingSafeEqual throws on those).
const sha = (s) => crypto.createHash("sha256").update(String(s)).digest();
function credsOk(u, p) {
  const uOk = crypto.timingSafeEqual(sha(u), sha(SITE_USER));
  const pOk = crypto.timingSafeEqual(sha(p), sha(SITE_PASSWORD));
  return (uOk & pOk) === 1;   // bitwise: both comparisons always execute (no short-circuit timing)
}

// ===== Session cookies (HMAC-signed, stateless) =====
// Token = "<expiryMs>.<base64url hmac(secret, expiryMs)>". Nothing stored server-side: verify =
// recompute the signature and constant-time compare, then check expiry. 30 days by default.
function signSession(expMs) {
  return expMs + "." + crypto.createHmac("sha256", SESSION_SECRET).update(String(expMs)).digest("base64url");
}
function sessionOk(tok) {
  if (!tok || tok.length > 128) return false;
  const dot = tok.indexOf(".");
  if (dot < 1) return false;
  const exp = Number(tok.slice(0, dot));
  if (!Number.isFinite(exp) || exp < Date.now()) return false;
  const a = Buffer.from(tok), b = Buffer.from(signSession(exp));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}
function getCookie(req, name) {
  const h = req.headers.cookie || "";
  for (const part of h.split(";")) {
    const p = part.trim();
    if (p.startsWith(name + "=")) return p.slice(name.length + 1);
  }
  return null;
}
function cookieAttrs(req, maxAgeSec) {
  // Railway terminates TLS and forwards proto — mark Secure whenever the client came over https.
  const secure = (req.headers["x-forwarded-proto"] || req.protocol) === "https" ? "; Secure" : "";
  return `; Path=/; SameSite=Lax; Max-Age=${maxAgeSec}${secure}`;
}
function setSessionCookies(reply, req, maxAgeSec, token) {
  reply.header("set-cookie", [
    // The real session — HttpOnly, invisible to page JS.
    "xyzsess=" + (token || "x") + cookieAttrs(req, maxAgeSec) + "; HttpOnly",
    // JS-visible marker with the same lifetime, so the UI knows to show the logout button.
    // Carries no secret: forging it gets you a logout button, not access.
    "xyzauth=1" + cookieAttrs(req, maxAgeSec),
  ]);
}

// ===== AI-unlock cookie (HttpOnly, browser-session-lived, HMAC-signed) =====
// Same stateless shape as the session token, but signed with AI_UNLOCK_SECRET and capped at 24h.
// The cookie carries NO Max-Age, so it is a session cookie that dies when the browser closes; the
// signed expiry inside it is the belt-and-suspenders hard cap on top of that.
function signAiUnlock(expMs) {
  return expMs + "." + crypto.createHmac("sha256", AI_UNLOCK_SECRET).update("ai|" + expMs).digest("base64url");
}
function aiUnlockOk(tok) {
  if (!ADMIN_PASSWORD || !tok || tok.length > 128) return false;   // no admin password set => gate stays closed
  const dot = tok.indexOf(".");
  if (dot < 1) return false;
  const exp = Number(tok.slice(0, dot));
  if (!Number.isFinite(exp) || exp < Date.now()) return false;
  const a = Buffer.from(tok), b = Buffer.from(signAiUnlock(exp));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}
function aiCookieAttrs(req, clear) {
  const secure = (req.headers["x-forwarded-proto"] || req.protocol) === "https" ? "; Secure" : "";
  // No Max-Age on set => browser-session cookie (gone on close). Max-Age=0 on clear => delete now.
  return `; Path=/; SameSite=Lax${clear ? "; Max-Age=0" : ""}${secure}; HttpOnly`;
}
function setAiUnlockCookie(reply, req, token) { reply.header("set-cookie", "xyzai=" + token + aiCookieAttrs(req, false)); }
function clearAiUnlockCookie(reply, req) { reply.header("set-cookie", "xyzai=x" + aiCookieAttrs(req, true)); }

// ===== admin-view cookie (HttpOnly, 30d, HMAC-signed) =====
// Same stateless shape as the session token. Two cookies go out together: xyzadm carries the signed
// token, xyzadmin=1 is a JS-visible marker with no secret in it (forging it gets you an Admin tab
// whose every route still 403s — the server never trusts it). Fastify appends repeated set-cookie
// headers rather than overwriting, so this composes with setSessionCookies in one response.
function signAdminView(expMs) {
  return expMs + "." + crypto.createHmac("sha256", ADMIN_VIEW_SECRET).update("adm|" + expMs).digest("base64url");
}
function adminViewOk(tok) {
  if (!ADMIN_PASSWORD || !tok || tok.length > 128) return false;   // unset admin password => fail closed
  const dot = tok.indexOf(".");
  if (dot < 1) return false;
  const exp = Number(tok.slice(0, dot));
  if (!Number.isFinite(exp) || exp < Date.now()) return false;
  const a = Buffer.from(tok), b = Buffer.from(signAdminView(exp));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}
function setAdminCookies(reply, req, maxAgeSec, token) {
  reply.header("set-cookie", [
    "xyzadm=" + (token || "x") + cookieAttrs(req, maxAgeSec) + "; HttpOnly",
    "xyzadmin=1" + cookieAttrs(req, maxAgeSec),
  ]);
}
// Constant-time ADMIN_PASSWORD compare for the login route. Deliberately NOT poller.checkAdminPassword:
// that one carries its own sliding lockout for the terminal unlock, and burning it on ordinary group
// logins would let a member with a fat finger lock the operator out of the panel. /login has its own
// per-IP damper, which is the right one to spend here.
function adminPwOk(pw) {
  if (!ADMIN_PASSWORD) return false;
  const a = Buffer.from(String(pw == null ? "" : pw), "utf8"), b = Buffer.from(ADMIN_PASSWORD, "utf8");
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

// Brute-force damper for /login: 8 wrong passwords from one IP = 15 min lockout. In-memory —
// a restart clears it, which is fine; this is a speed bump, not a vault. Map is size-capped
// so a spoofed-IP flood can't grow it unbounded.
const loginFails = new Map();
const LOCK_AFTER = 8, LOCK_MS = 15 * 60e3;
function loginLockedFor(ip) {
  const e = loginFails.get(ip);
  return (e && e.until > Date.now()) ? Math.ceil((e.until - Date.now()) / 60e3) : 0;
}
function loginFail(ip) {
  if (loginFails.size > 5000) loginFails.clear();
  const e = loginFails.get(ip) || { n: 0, until: 0 };
  e.n++;
  if (e.n >= LOCK_AFTER) { e.until = Date.now() + LOCK_MS; e.n = 0; }
  loginFails.set(ip, e);
}

// ===== auth pages (sign in / join / reset / claim) ============================================
// One inline template, five modes. Served for any unauthenticated navigation, exactly as the
// shared-password login page was: no extra file, no native Basic-auth popup, and the app's own
// palette so the door does not look like a different product from the room behind it.
//
// Modes:
//   signin    handle + password — the everyday door
//   join      an open invite: pick a handle and a password, account created on submit
//   reset     a reset link: new password only, the account is already named
//   claim     an existing member arriving on a legacy shared-password session
//   bootstrap the very first account, opened with ADMIN_PASSWORD when the user table is empty
//   dead      an invite that cannot be used, and why
function authPage(o) {
  const mode = o.mode || "signin";
  const esc = (x) => String(x == null ? "" : x)
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  const wantsHandle = mode === "join" || mode === "claim" || mode === "signin" || mode === "bootstrap" || mode === "forgot";
  const wantsCode = mode === "otp";
  const wantsPw = mode !== "dead" && mode !== "forgot";
  const newAccount = mode === "join" || mode === "claim" || mode === "bootstrap";
  const action = mode === "signin" ? "/login" : mode === "claim" ? "/claim"
    : mode === "bootstrap" ? "/bootstrap" : mode === "forgot" ? "/reset"
    : mode === "otp" ? "/reset/code" : "/join";
  const sub = {
    signin: "private terminal",
    join: esc(o.inviter || "the operator") + " invited you to the terminal",
    reset: "set a new password for " + esc(o.handle || "your account"),
    forgot: "we'll send a code to your linked Telegram",
    otp: "enter the code sent to your Telegram",
    claim: "this terminal now has accounts — claim yours",
    bootstrap: "first account — this one is the operator",
    dead: esc(o.reason || "this link cannot be used"),
  }[mode];
  const foot = {
    signin: '<a class="altin" href="/reset">Forgot your password?</a>',
    join: newAccountFoot(o),
    reset: "Setting a new password signs out every other device.",
    forgot: "No Telegram linked, or no code arrives? Ask the operator for a reset link instead.",
    otp: "The code is good for " + (o.ttlMin || 10) + " minutes and works once. Setting a new password signs out every other device.",
    claim: "Your alerts, rules and notes carry over — they are already yours.",
    bootstrap: "You are creating the operator account. Everyone else joins by invite.",
    dead: esc(o.hint || "Ask the operator for a fresh link."),
  }[mode];
  const rows = [];
  if (wantsHandle) rows.push(
    '<label for="h">handle</label>' +
    '<input id="h" autocomplete="' + (newAccount ? "username" : "username") + '" autocapitalize="off" ' +
    'autocorrect="off" spellcheck="false" value="' + esc(o.handle || "") + '"' +
    (newAccount ? ' placeholder="what everyone else will see you as"' : "") + ' autofocus>');
  if (wantsCode) rows.push(
    '<label for="c">code</label>' +
    '<input id="c" inputmode="numeric" autocomplete="one-time-code" maxlength="6" ' +
    'style="letter-spacing:.34em;text-align:center" autofocus>');
  if (wantsPw) rows.push(
    '<label for="p">' + (newAccount || mode === "reset" || mode === "otp" ? "choose a password" : "password") + '</label>' +
    '<input id="p" type="password" autocomplete="' + (newAccount || mode === "reset" || mode === "otp" ? "new-password" : "current-password") + '"' +
    (wantsHandle || wantsCode ? "" : " autofocus") + '>');
  const btn = { signin: "Sign in", join: "Create account", reset: "Set password",
    forgot: "Send a code", otp: "Set password",
    claim: "Claim account", bootstrap: "Create operator account", dead: "" }[mode];

  return '<!doctype html><html lang="en"><head><meta charset="utf-8">' +
'<meta name="viewport" content="width=device-width,initial-scale=1">' +
'<meta name="referrer" content="same-origin">' +
'<title>Milst Screener — ' + (mode === "signin" ? "sign in" : mode === "dead" ? "invite" : "join") + '</title>' +
'<style>' + AUTH_CSS + '</style></head><body>' +
'<div class="card">' +
  '<div class="wm">Milst <b>Screener</b></div>' +
  '<div class="sub">' + sub + '</div>' +
  rows.join("") +
  (btn ? '<button id="go">' + btn + '</button>' : "") +
  '<div class="err" id="err">' + esc(o.error || "") + '</div>' +
  '<div class="foot">' + foot + '</div>' +
  (mode === "dead" ? '<a class="alt" href="/login">Go to sign in</a>' : "") +
  (mode === "join" || mode === "reset" || mode === "forgot" || mode === "otp"
    ? '<a class="alt" href="/login">Back to sign in</a>' : "") +
'</div>' +
'<script>' + AUTH_JS + '</script>' +
'<script>window.__AUTH=' + JSON.stringify({ action, mode }) + ';authInit();</script>' +
'</body></html>';
}
function newAccountFoot(o) {
  const d = o.expiresAt ? Math.max(0, Math.round((o.expiresAt - Date.now()) / 86400000)) : 0;
  return "Passwords are " + ACCOUNT_PW_MIN + " characters or more. " +
    (o.expiresAt ? ("This invite works once and expires in " + (d <= 1 ? "under a day" : d + " days") + ".") : "");
}
const AUTH_CSS =
":root{--bg:#0E1116;--panel:#151A21;--border:#262E39;--text:#E8E3D7;--muted:#7E8794;--faint:#4C5662;--accent:#E3A53C;--down:#E5604D;" +
"--mono:'JetBrains Mono',ui-monospace,Menlo,Consolas,monospace;--disp:'Space Grotesk',system-ui,sans-serif}" +
"*{box-sizing:border-box}html,body{margin:0;height:100%;background:var(--bg);color:var(--text);font-family:var(--disp)}" +
"body{display:flex;align-items:center;justify-content:center;padding:20px}" +
".card{width:100%;max-width:370px;background:var(--panel);border:1px solid var(--border);border-radius:10px;padding:28px 26px 22px}" +
".wm{font-size:24px;font-weight:700;letter-spacing:-.5px}.wm b{color:var(--accent)}" +
".sub{color:var(--muted);font-size:12.5px;margin:4px 0 22px;line-height:1.5}" +
"label{display:block;font-size:10.5px;text-transform:uppercase;letter-spacing:.9px;color:var(--muted);margin:0 0 6px}" +
"input{width:100%;background:var(--bg);border:1px solid var(--border);border-radius:6px;color:var(--text);" +
"font-family:var(--mono);font-size:15px;padding:10px 12px;outline:none;margin-bottom:14px}" +
"input:focus{border-color:var(--accent)}input::placeholder{color:var(--faint);font-size:12.5px}" +
"input.bad{border-color:var(--down)}" +
"button{width:100%;margin-top:2px;background:var(--accent);border:none;border-radius:6px;color:#000;" +
"font-family:var(--disp);font-size:14px;font-weight:600;padding:11px;cursor:pointer}" +
"button:disabled{opacity:.55;cursor:default}" +
".err{color:var(--down);font-size:12.5px;min-height:17px;margin-top:10px;font-family:var(--mono);line-height:1.45}" +
".foot{color:var(--faint);font-size:11px;font-family:var(--mono);line-height:1.6;margin-top:12px}" +
".alt{display:block;margin-top:14px;color:var(--muted);font-size:11.5px;font-family:var(--mono);text-decoration:none}" +
".alt:hover{color:var(--accent)}" +
".altin{color:var(--muted);text-decoration:none}.altin:hover{color:var(--accent)}";
const AUTH_JS =
"function authInit(){var A=window.__AUTH||{},h=document.getElementById('h'),p=document.getElementById('p')," +
"c=document.getElementById('c')," +
"go=document.getElementById('go'),err=document.getElementById('err');if(!go)return;" +
"function submit(){if(go.disabled)return;go.disabled=true;err.textContent='';" +
"if(h)h.classList.remove('bad');if(p)p.classList.remove('bad');" +
"var body={};if(h)body.handle=h.value;if(p)body.password=p.value;" +
"if(c)body.code=c.value;" +
"fetch(A.action,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)})" +
".then(function(r){return r.json().catch(function(){return {};}).then(function(d){return {r:r,d:d};});})" +
".then(function(x){if(x.r.ok&&x.d.ok){location.replace(x.d.next||'/');return;}" +
"err.textContent=(x.d&&x.d.error)||('HTTP '+x.r.status);" +
"var f=x.d&&x.d.field;if(f==='handle'&&h){h.classList.add('bad');h.focus();h.select();}" +
"else if(f==='code'&&c){c.classList.add('bad');c.focus();c.select();}" +
"else if(p){p.classList.add('bad');p.focus();p.select();}go.disabled=false;})" +
".catch(function(){err.textContent='network error — try again';go.disabled=false;});}" +
"go.addEventListener('click',submit);" +
"[h,p,c].forEach(function(e){if(e)e.addEventListener('keydown',function(ev){if(ev.key==='Enter')submit();});});}";
const LOGIN_HTML = authPage({ mode: "signin" });

async function main() {
  const fastify = Fastify({ logger: false });

  // True when a request carries a valid session cookie or correct HTTP Basic creds. Shared by the
  // optional site gate below AND the always-on AI-cost guard, so "authenticated" means one thing.
  // The account session is checked FIRST and is the only path that carries a "who". The legacy
  // shared-password token stays valid underneath it so the accounts migration does not log the
  // group out on the deploy that introduces it; it authenticates without identifying, which is
  // exactly why a legacy caller is bounced to /claim before it can reach anything personal.
  const meOf = (req) => ACCOUNTS.sessionUser(getCookie(req, "xyzsess"));
  const reqAuthed = (req) => {
    if (meOf(req)) return true;
    if (LEGACY_DOOR && sessionOk(getCookie(req, "xyzsess"))) return true;
    const hdr = req.headers.authorization || "";
    const [scheme, enc] = hdr.split(" ");
    if (scheme === "Basic" && enc) {
      const s = Buffer.from(enc, "base64").toString();
      const i = s.indexOf(":");
      if (i >= 0 && credsOk(s.slice(0, i), s.slice(i + 1))) return true;
    }
    return false;
  };

  // True when the caller holds a valid admin-view cookie. Browser-only by design: there is no header
  // or Basic-auth path to admin, so a leaked script credential cannot flip feature visibility.
  // Two independent ways to be admin now: the isAdmin flag on your own account, or the legacy
  // ADMIN_PASSWORD-derived cookie kept as break-glass. The flag is the one that survives; the
  // cookie is what lets an operator back in when they have locked themselves out of their account.
  const isAdmin = (req) => {
    const me = meOf(req);
    if (me && me.isAdmin) return true;
    return adminViewOk(getCookie(req, "xyzadm"));
  };
  // ---- the price stamp -------------------------------------------------------------------------
  // A $TICKER in a message is resolved and priced off the SAME snapshot object the markets table
  // is painted from, so the number frozen into a message is by construction the number the sender
  // was looking at. Rebuilt only when the content clock moves — a message send costs a Map lookup,
  // never a fetch, which is the whole reason this feature is cheap enough to be worth having.
  let markTs = -1, markByCoin = new Map(), coinBySym = new Map();
  function refreshMarks() {
    const s = poller.getSnapshot();
    if (!s || s.dataTs === markTs) return;
    markTs = s.dataTs;
    const bc = new Map(), cs = new Map();
    for (const m of (s.markets || [])) {
      if (m.px != null) bc.set(m.coin, m.px);
      if (m.ticker) cs.set(String(m.ticker).toUpperCase(), m.coin);
      cs.set(String(m.coin).toUpperCase(), m.coin);
    }
    markByCoin = bc; coinBySym = cs;
  }
  const markForCoin = (coin) => { refreshMarks(); const v = markByCoin.get(coin); return Number.isFinite(v) ? v : null; };
  // A symbol the server does not know stays plain text rather than being stamped with nothing.
  const coinForSymbol = (sym) => { refreshMarks(); return coinBySym.get(String(sym || "").toUpperCase()) || null; };
  ACCOUNTS.setMarkSource(markForCoin);

  // The alert-ownership handle. A signed-in member IS their uid — which is precisely why redeem()
  // reuses an existing xyzown handle as the uid: every recipient and rule keyed by that string
  // keeps working with no migration at all. Only a caller with no account falls back to the cookie.
  const ownerFor = (req, reply) => {
    const me = meOf(req);
    if (me) { ACCOUNTS.touch(me.uid); return me.uid; }
    return ensureOwner(req, reply);
  };

  // Always-on guard for the paid AI-escalation endpoints. These spend real OpenAI/Anthropic budget,
  // so they must never answer an unauthenticated caller — including when SITE_PASSWORD is UNSET, a
  // posture where the rest of the (read-only, cache-served) site is deliberately open. Unauthed here
  // is a hard 401: the AI ask/report generation stays closed on the open web until a site password
  // exists. The terminal's local grammar is client-side and unaffected; only the AI fallback is gated.
  // Registered before the routes so it fires first; the optional full-site gate below still runs too.
  const AI_COST_PATHS = new Set(["/api/ask", "/api/ai-report"]);
  fastify.addHook("onRequest", async (req, reply) => {
    const u = req.url.split("?")[0];
    if (req.method === "POST" && AI_COST_PATHS.has(u)) {
      if (!reqAuthed(req))
        return reply.code(401).header("cache-control", "no-store").send({ error: "unauthorized", detail: "AI endpoints require authentication — set SITE_PASSWORD to enable them" });
      // DELIBERATE REVERSAL of the locked-by-default posture: AI generation is now OPEN to every
      // authenticated group member, capped per user (3 reports/day, 20/month, 5 asks/day) and by
      // the shared non-admin pools — the caps are enforced in the poller, where the budget state
      // lives. The xyzai unlock stopped being a gate and became an EXEMPTION: holding it (or the
      // xyzadm view) marks the caller admin — unlimited, burns nothing. Still no header path to
      // the exemption: `admin unlock <password>` in the terminal remains the only way in.
    }
  });
  // One place computes "who is asking" for the AI-cost routes: the signed xyzown handle keys the
  // per-user quota; admin = AI unlock OR admin view (both are ADMIN_PASSWORD-derived cookies).
  const aiWho = (req, reply) => ({ owner: ownerFor(req, reply),
    admin: aiUnlockOk(getCookie(req, "xyzai")) || isAdmin(req) });

  // Optional shared-password gate. Disabled unless SITE_PASSWORD is set. Two ways in:
  //   1. Session cookie from the login page (30-day HMAC token) — the normal browser path.
  //   2. HTTP Basic — kept so curl/scripts can still hit the API without a cookie jar.
  // NOTE: /api/health must stay open or Railway's healthcheck 401s and the deploy is
  // marked unhealthy (restart loop). /login (POST) and /logout must pass or nobody could
  // ever authenticate.
  if (SITE_PASSWORD) {
    fastify.addHook("onRequest", async (req, reply) => {
      const u = req.url.split("?")[0];
      // The doors themselves must pass or nobody could ever authenticate. /join is on the list
      // because an invited person has, by definition, no session yet.
      if (u === "/api/health" || u === "/logout" || u === "/login"
          || u === "/join" || u.startsWith("/join/") || u === "/claim" || u === "/bootstrap"
          || u === "/reset" || u === "/reset/code") return;
      // A legacy shared-password session authenticates but does not IDENTIFY. Once accounts exist,
      // send those callers to /claim rather than into an app where every personal surface would
      // 401 at them with no explanation. Break-glass admins are exempt: ADMIN_PASSWORD is how an
      // operator gets back in when they have locked themselves out of their own account.
      if (reqAuthed(req)) {
        if (!meOf(req) && ACCOUNTS.countUsers() > 0 && !adminViewOk(getCookie(req, "xyzadm"))) {
          if (u.startsWith("/api/")) return reply.code(401).header("cache-control", "no-store")
            .send({ error: "claim-account", detail: "this terminal now has accounts — visit /claim" });
          return reply.redirect(302, "/claim");
        }
        return;
      }
      // CRITICAL: in an async hook, reply.send() alone does NOT stop the lifecycle — the
      // route handler still runs and double-sends (here: @fastify/static also answered "/",
      // corrupting the response into a body-less 401 that hangs the browser). Returning the
      // reply is what short-circuits. This exact bug shipped in the original Basic-auth gate
      // and lay dormant until the first deploy with SITE_PASSWORD actually set.
      if (u.startsWith("/api/")) return reply.code(401).send({ error: "unauthorized" });
      return reply.code(401).header("cache-control", "no-store").type("text/html; charset=utf-8").send(LOGIN_HTML);
    });
    log(`Access control: shared-password protection ENABLED (login page + ${SESSION_DAYS}d sessions; Basic auth still accepted for scripts)`);
  }

  // ===== feature gate =====
  // Registered LAST so it runs after the site gate: an unauthenticated caller must get 401 (log in),
  // not 403 (you are not admin) — the two mean different things and the client acts on the difference.
  // The mapping route -> feature key lives in the manifest; FEATURE_NEVER_GATE (health, login, logout,
  // the unlock pair, /api/features) is honoured inside featureGateFor, so the escalation path can
  // never be closed by a flag write. Routes no feature claims pass through untouched — see the
  // ASYMMETRY note in compute.js before changing that.
  fastify.addHook("onRequest", async (req, reply) => {
    const blocked = featureGateFor(req.method, req.url, poller.getFlags(), isAdmin(req));
    if (!blocked) return;
    // Same lifecycle rule as the site gate above: RETURN the reply or the handler still runs and
    // double-sends. 403 not 404 — hiding the route's existence is the client's job (it never renders
    // a gated affordance), and a lying status code would make this impossible to debug from a log.
    return reply.code(403).header("cache-control", "no-store").send({ error: "feature-gated", feature: blocked });
  });
  {
    // Honest-null: with no ADMIN_PASSWORD set, nobody can hold an admin cookie, so every feature whose
    // resolved state is "admin" is closed to EVERYONE including the operator. That is the correct
    // fail-closed posture, but it is silent, so say it out loud once at boot rather than letting it
    // present as "the Actionable tab stopped working".
    const shut = require("./src/compute").FEATURES
      .filter((f) => require("./src/compute").featureState(poller.getFlags(), f.key) === "admin").map((f) => f.key);
    if (!ADMIN_PASSWORD && shut.length)
      log(`WARN: ADMIN_PASSWORD is unset — no admin cookie can be minted, so ${shut.length} admin-state feature(s) are closed to everyone: ${shut.join(", ")}`);
    else log(`Feature gate: ${shut.length} admin-state feature(s) (${ADMIN_DAYS}d admin lease; AI spend still needs a separate unlock)`);
  }

  // Both verbs are admin-only. GET was briefly open on the reasoning that a caller may read its own
  // resolved set — but the client gets that from the injected shell (window.__FLAGS), and the ONLY
  // caller of this route is the panel. Leaving it open therefore bought nothing and let a public
  // visitor enumerate every feature key and learn which ones are admin-only, which contradicts the
  // choice that gated features leave no trace. Still in FEATURE_NEVER_GATE, so no flag write can lock
  // the panel out of reading its own state — the admin check here is a separate axis from the gate.
  fastify.get("/api/features", (req, reply) => {
    reply.header("cache-control", "no-store");
    if (!isAdmin(req)) return reply.code(403).send({ error: "forbidden" });
    return poller.getFeatures(true);
  });
  // 8 KB cap — the payload is { key, state }; anything larger is malformed or hostile (413).
  fastify.post("/api/features", { bodyLimit: 8 * 1024 }, async (req, reply) => {
    reply.header("cache-control", "no-store");
    const b = req.body || {};
    const r = poller.setFlag(String(b.key || ""), String(b.state || ""), isAdmin(req));
    return reply.code(r.ok ? 200 : (r.error === "forbidden" ? 403 : r.error === "write-failed" ? 503 : 400)).send(r);
  });

  // One group per call, mirroring /api/features: the panel writes optimistically and rolls back on
  // failure, so a batch write would make a partial failure ambiguous. An empty label restores the
  // default rather than erroring — that is what clearing the box means.
  fastify.post("/api/nav-groups", { bodyLimit: 4 * 1024 }, async (req, reply) => {
    reply.header("cache-control", "no-store");
    const b = req.body || {};
    // Two operations, one route, distinguished by which field the body carries: {key,label}
    // renames a menu, {view,group} moves a tab into one.
    const r = b.view != null
      ? poller.setNavViewGroup(String(b.view || ""), String(b.group || ""), isAdmin(req))
      : poller.setNavGroupLabel(String(b.key || ""), String(b.label == null ? "" : b.label), isAdmin(req));
    return reply.code(r.ok ? 200 : (r.error === "forbidden" ? 403 : r.error === "write-failed" ? 503 : 400)).send(r);
  });

  // ===== identity: sign in, join, claim, bootstrap ==============================================
  // Session cookies are minted in exactly one place so a route can never accidentally issue one
  // with the wrong lifetime, and the JS-visible marker always travels with the real token.
  const signIn = (reply, req, user, token) => {
    setSessionCookies(reply, req, SESSION_DAYS * 86400, token);
    // An account-flagged admin gets the view lease too, so the Admin tab paints on the first frame
    // instead of after a round trip. It is a mirror of the flag, never the source of it.
    if (user && user.isAdmin) setAdminCookies(reply, req, ADMIN_DAYS * 86400, signAdminView(Date.now() + ADMIN_DAYS * 864e5));
  };
  const inviteCookie = (reply, req, code) =>
    reply.header("set-cookie", "xyzinv=" + encodeURIComponent(code) + cookieAttrs(req, code ? 900 : 0) + "; HttpOnly");
  const htmlNoStore = (reply) => reply.header("cache-control", "no-store").type("text/html; charset=utf-8");

  fastify.get("/login", (req, reply) => {
    if (meOf(req)) return reply.redirect(302, "/");
    return htmlNoStore(reply).send(authPage({ mode: "signin" }));
  });

  // One prompt, four outcomes, checked in this order:
  //   1. handle + password matches an account      -> that account's session
  //   2. ADMIN_PASSWORD                            -> break-glass session + admin lease
  //      (and, when no account exists yet, the bootstrap door)
  //   3. the legacy shared password                -> a session that can ONLY reach /claim
  //   4. nothing                                   -> 401, and the IP damper counts it
  fastify.post("/login", { bodyLimit: 8 * 1024 }, async (req, reply) => {
    const ip = String(req.headers["x-forwarded-for"] || req.ip).split(",")[0].trim();
    const lockedMin = loginLockedFor(ip);
    if (lockedMin) { reply.code(429); return { ok: false, error: `too many attempts — locked for ${lockedMin} min` }; }
    const b = req.body || {};
    const handle = String(b.handle == null ? "" : b.handle).trim();
    const pw = String(b.password == null ? "" : b.password);

    if (handle) {
      const r = ACCOUNTS.login(handle, pw);
      if (r.ok) {
        loginFails.delete(ip);
        signIn(reply, req, r.user, r.token);
        log(`sign-in: ${r.user.handle}${r.user.isAdmin ? " (admin)" : ""}`);
        return { ok: true, next: "/" };
      }
      // Fall through to the password-only doors below rather than failing here: an operator typing
      // ADMIN_PASSWORD into a form that also has a handle box should still get in.
    }

    if (adminPwOk(pw)) {
      loginFails.delete(ip);
      setSessionCookies(reply, req, SESSION_DAYS * 86400, signSession(Date.now() + SESSION_DAYS * 864e5));
      setAdminCookies(reply, req, ADMIN_DAYS * 86400, signAdminView(Date.now() + ADMIN_DAYS * 864e5));
      const empty = ACCOUNTS.countUsers() === 0;
      log("admin view granted via login" + (empty ? " (no accounts yet — routed to bootstrap)" : ""));
      return { ok: true, admin: true, next: empty ? "/bootstrap" : "/" };
    }

    if (LEGACY_DOOR && SITE_PASSWORD && credsOk(handle || SITE_USER, pw)) {
      loginFails.delete(ip);
      setSessionCookies(reply, req, SESSION_DAYS * 86400, signSession(Date.now() + SESSION_DAYS * 864e5));
      return { ok: true, next: "/claim" };
    }

    if (handle || pw) loginFail(ip);
    reply.code(401);
    return { ok: false, error: handle ? "wrong handle or password" : "wrong password" };
  });

  // ---- the invite door -------------------------------------------------------------------------
  // GET /join/:code does not render anything. It validates, moves the code into an HttpOnly cookie
  // and redirects to a bare /join. That redirect IS the security step: after it the code is no
  // longer in the address bar, the browser history, or any Referer header a later request carries.
  // The one access-log line that does hold it is written with the code redacted.
  fastify.get("/join/:code", (req, reply) => {
    const raw = String((req.params && req.params.code) || "");
    const r = ACCOUNTS.readInvite(raw);
    if (!r.ok) {
      inviteCookie(reply, req, "");
      log(`invite: rejected a ${r.state} code`);
      return htmlNoStore(reply).code(410).send(deadInvitePage(r.state));
    }
    log("invite: opened (code redacted)");
    inviteCookie(reply, req, r.invite.code);
    return reply.redirect(302, "/join");
  });

  const deadInvitePage = (state) => authPage({ mode: "dead",
    reason: state === "used" ? "this invite has already been used"
      : state === "expired" ? "this invite has expired"
      : state === "revoked" ? "this invite was revoked"
      : "that invite link isn't valid",
    hint: state === "used" ? "Invites work once. If that was you, sign in instead."
      : state === "revoked" ? "Ask the operator for a fresh link."
      : "Ask the operator for a fresh link." });

  fastify.get("/join", (req, reply) => {
    const code = decodeURIComponent(getCookie(req, "xyzinv") || "");
    const r = ACCOUNTS.readInvite(code);
    if (!r.ok) { inviteCookie(reply, req, ""); return htmlNoStore(reply).code(410).send(deadInvitePage(r.state)); }
    // Somebody already signed in who opens an invite must NOT silently burn it — that is a fresh
    // link spent because a member clicked their own forward twice.
    const me = meOf(req);
    if (me && r.invite.kind === "join") {
      return htmlNoStore(reply).send(authPage({ mode: "dead",
        reason: "you are already signed in as " + me.display,
        hint: "This invite is for somebody else. Sign out first if you meant to use it." }));
    }
    if (r.invite.kind === "reset")
      return htmlNoStore(reply).send(authPage({ mode: "reset", handle: r.target ? r.target.display : "your account" }));
    return htmlNoStore(reply).send(authPage({ mode: "join", inviter: r.inviter, expiresAt: r.invite.expiresAt }));
  });

  fastify.post("/join", { bodyLimit: 8 * 1024 }, async (req, reply) => {
    const ip = String(req.headers["x-forwarded-for"] || req.ip).split(",")[0].trim();
    if (loginLockedFor(ip)) { reply.code(429); return { ok: false, error: "too many attempts — try again shortly" }; }
    const code = decodeURIComponent(getCookie(req, "xyzinv") || "");
    const b = req.body || {};
    // The prior signed handle is what makes the migration free: it becomes the new uid, so every
    // alert recipient and rule already keyed to it belongs to the account without being rewritten.
    const prior = ownerOf(getCookie(req, "xyzown"));
    const r = ACCOUNTS.redeem(code, b.handle, b.password, prior);
    if (!r.ok) {
      if (r.state) loginFail(ip);
      reply.code(r.state ? 410 : 400);
      return { ok: false, error: r.error, field: r.field || null };
    }
    inviteCookie(reply, req, "");
    signIn(reply, req, r.user, r.token);
    log(r.reset ? `password reset completed for ${r.user.handle}`
      : `account created: ${r.user.handle}${r.adopted ? " (carried over existing alerts)" : ""}`);
    return { ok: true, next: "/" };
  });


  // ---- self-serve password reset by one-time code ------------------------------------------------
  // There is no mail server here, and adding one for a ten-person desk is not worth it. The
  // Telegram outbox already exists, with recipients, quiet hours and caps — so the code goes there.
  // A reset code is not an alert, so it is sent with the cap and the quiet window bypassed: a
  // password reset that waits until 8am is not a password reset.
  //
  // The handle travels in a short-lived HttpOnly cookie between the two steps rather than in a form
  // field, for the same reason the invite code does: it keeps the second step bound to the first,
  // so nobody can request a code for themselves and then verify against a different account.
  const otpCookie = (reply, req, handle) =>
    reply.header("set-cookie", "xyzotp=" + encodeURIComponent(handle || "") + cookieAttrs(req, handle ? 900 : 0) + "; HttpOnly");

  fastify.get("/reset", (req, reply) => {
    if (meOf(req)) return reply.redirect(302, "/");
    return htmlNoStore(reply).send(authPage({ mode: "forgot" }));
  });
  fastify.post("/reset", { bodyLimit: 4 * 1024 }, async (req, reply) => {
    const ip = String(req.headers["x-forwarded-for"] || req.ip).split(",")[0].trim();
    if (loginLockedFor(ip)) { reply.code(429); return { ok: false, error: "too many attempts — try again shortly" }; }
    const handle = String((req.body || {}).handle || "").trim();
    const r = ACCOUNTS.otpRequest(handle);
    // The SAME answer whether the handle exists, has no Telegram linked, or is over its send cap.
    // Anything else turns this endpoint into a directory of who has an account.
    otpCookie(reply, req, handle);
    if (r.sent) {
      const targets = poller.pushRecipientsFor ? poller.pushRecipientsFor(r.uid) : [];
      if (targets.length) {
        const text = "<b>Password reset</b>\nYour code is <b>" + r.code + "</b>\n"
          + "<i>Good for " + r.ttlMin + " minutes, and works once. If you didn't ask for this, tell the operator — "
          + "somebody knows your handle.</i>";
        for (const chat of targets) poller.pushEnqueueNow(chat, text, true);   // force: past quiet hours and the cap
        log("reset code sent to " + r.display);
      } else log("reset requested for " + r.display + " — no Telegram linked, nothing sent");
    }
    return { ok: true, next: "/reset/code" };
  });
  fastify.get("/reset/code", (req, reply) => {
    if (meOf(req)) return reply.redirect(302, "/");
    if (!getCookie(req, "xyzotp")) return reply.redirect(302, "/reset");
    return htmlNoStore(reply).send(authPage({ mode: "otp" }));
  });
  fastify.post("/reset/code", { bodyLimit: 8 * 1024 }, async (req, reply) => {
    const ip = String(req.headers["x-forwarded-for"] || req.ip).split(",")[0].trim();
    if (loginLockedFor(ip)) { reply.code(429); return { ok: false, error: "too many attempts — try again shortly" }; }
    const handle = decodeURIComponent(getCookie(req, "xyzotp") || "");
    if (!handle) { reply.code(400); return { ok: false, error: "start again from the reset page" }; }
    const b = req.body || {};
    const r = ACCOUNTS.otpVerify(handle, b.code, b.password);
    if (!r.ok) {
      // A wrong password on a CORRECT code is the user's own typo, not an attack — spending the IP
      // damper on it would lock somebody out of their own reset for fifteen minutes.
      if (!r.codeOk) loginFail(ip);
      reply.code(400);
      return { ok: false, error: r.error, field: r.field || "code" };
    }
    otpCookie(reply, req, "");
    signIn(reply, req, r.user, r.token);
    log("password reset by code: " + r.user.handle);
    return { ok: true, next: "/" };
  });

  // ---- legacy migration --------------------------------------------------------------------------
  // An existing member arriving on a shared-password session. Same account creation as an invite
  // redemption, no invite required, and only while the operator leaves the legacy door open.
  fastify.get("/claim", (req, reply) => {
    if (meOf(req)) return reply.redirect(302, "/");
    if (!LEGACY_DOOR || !sessionOk(getCookie(req, "xyzsess"))) return reply.redirect(302, "/login");
    return htmlNoStore(reply).send(authPage({ mode: "claim" }));
  });
  fastify.post("/claim", { bodyLimit: 8 * 1024 }, async (req, reply) => {
    if (meOf(req)) { reply.code(409); return { ok: false, error: "you already have an account" }; }
    if (!LEGACY_DOOR || !sessionOk(getCookie(req, "xyzsess"))) { reply.code(401); return { ok: false, error: "sign in first" }; }
    const b = req.body || {};
    const r = ACCOUNTS.claim(b.handle, b.password, ownerOf(getCookie(req, "xyzown")));
    if (!r.ok) { reply.code(400); return { ok: false, error: r.error, field: r.field || null }; }
    signIn(reply, req, r.user, r.token);
    log(`account claimed: ${r.user.handle}${r.adopted ? " (carried over existing alerts)" : ""}`);
    return { ok: true, next: "/" };
  });

  // ---- bootstrap ---------------------------------------------------------------------------------
  // Account #1, created by whoever holds ADMIN_PASSWORD, because there is nobody yet who could have
  // issued an invite. Closes for good the moment any account exists.
  fastify.get("/bootstrap", (req, reply) => {
    if (ACCOUNTS.countUsers() > 0) return reply.redirect(302, "/login");
    if (!adminViewOk(getCookie(req, "xyzadm"))) return reply.redirect(302, "/login");
    return htmlNoStore(reply).send(authPage({ mode: "bootstrap" }));
  });
  fastify.post("/bootstrap", { bodyLimit: 8 * 1024 }, async (req, reply) => {
    if (!adminViewOk(getCookie(req, "xyzadm"))) { reply.code(403); return { ok: false, error: "forbidden" }; }
    const b = req.body || {};
    const r = ACCOUNTS.bootstrap(b.handle, b.password, ownerOf(getCookie(req, "xyzown")));
    if (!r.ok) { reply.code(400); return { ok: false, error: r.error, field: r.field || null }; }
    signIn(reply, req, r.user, r.token);
    log(`operator account created: ${r.user.handle}`);
    return { ok: true, next: "/" };
  });

  // ---- who am I ----------------------------------------------------------------------------------
  fastify.get("/api/account", (req, reply) => {
    reply.header("cache-control", "no-store");
    const me = meOf(req);
    return { ok: true, me: me ? ACCOUNTS.pub(me) : null, legacy: !me && LEGACY_DOOR && sessionOk(getCookie(req, "xyzsess")),
      accounts: ACCOUNTS.countUsers(), pwMin: ACCOUNT_PW_MIN };
  });
  // Changing your own password bumps your epoch, which is what makes every other device sign out.
  fastify.post("/api/account", { bodyLimit: 8 * 1024 }, (req, reply) => {
    reply.header("cache-control", "no-store");
    const me = meOf(req);
    if (!me) return reply.code(401).send({ ok: false, error: "sign in first" });
    const b = req.body || {};
    const r = ACCOUNTS.login(me.handle, String(b.current == null ? "" : b.current));
    if (!r.ok) return reply.code(403).send({ ok: false, error: "current password is wrong", field: "current" });
    const set = ACCOUNTS.setPassword(me.uid, b.password);
    if (!set.ok) return reply.code(400).send({ ok: false, error: set.error, field: "password" });
    signIn(reply, req, set.user, set.token);   // keep THIS device signed in; the epoch bump drops the rest
    return { ok: true, signedOutOthers: true };
  });

  // ===== admin: the access panel ==================================================================
  fastify.get("/api/access", (req, reply) => {
    reply.header("cache-control", "no-store");
    if (!isAdmin(req)) return reply.code(403).send({ error: "forbidden" });
    const me = meOf(req);
    return { ok: true, me: me ? ACCOUNTS.pub(me) : null,
      members: ACCOUNTS.listUsers(), invites: ACCOUNTS.listInvites(),
      legacyDoor: LEGACY_DOOR && !!SITE_PASSWORD, ttls: [1, 7, 30], stats: ACCOUNTS.stats() };
  });
  // One route, several verbs in the body — the shape /api/notes and /api/baskets already use, so
  // the manifest gate covers the whole write surface at once.
  fastify.post("/api/access", { bodyLimit: 8 * 1024 }, (req, reply) => {
    reply.header("cache-control", "no-store");
    if (!isAdmin(req)) return reply.code(403).send({ ok: false, error: "forbidden" });
    const me = meOf(req);
    const by = me ? me.uid : "legacy-admin";
    const b = req.body || {};
    const op = String(b.op || "");
    const uid = String(b.uid || "");
    // An operator must not be able to lock themselves out with one misclick, and the last admin
    // standing must not be able to remove the only account that can issue the next invite.
    const lastAdmin = (target) => {
      const admins = ACCOUNTS.listUsers().filter((u) => u.isAdmin && !u.disabled);
      return admins.length <= 1 && admins.some((u) => u.uid === target);
    };
    let r;
    if (op === "mint") r = ACCOUNTS.mintInvite(by, b.label, b.days, "join");
    else if (op === "reset-link") {
      if (!ACCOUNTS.getUser(uid)) r = { ok: false, error: "no such account" };
      else r = ACCOUNTS.mintInvite(by, "reset for " + ACCOUNTS.getUser(uid).display, 1, "reset", uid);
    }
    else if (op === "revoke") r = ACCOUNTS.revokeInvite(String(b.code || ""));
    else if (op === "signout") r = ACCOUNTS.signOutEverywhere(uid);
    else if (op === "disable") r = lastAdmin(uid) ? { ok: false, error: "that is the last operator — promote somebody else first" } : ACCOUNTS.setDisabled(uid, true);
    else if (op === "enable") r = ACCOUNTS.setDisabled(uid, false);
    else if (op === "admin") r = (!b.on && lastAdmin(uid)) ? { ok: false, error: "that is the last operator — promote somebody else first" } : ACCOUNTS.setAdmin(uid, !!b.on);
    else r = { ok: false, error: "unknown operation" };
    if (r.ok && op === "mint") log(`invite minted by ${me ? me.handle : "admin"}${b.label ? " for " + String(b.label).slice(0, 32) : ""}`);
    if (r.ok && (op === "disable" || op === "admin" || op === "signout")) log(`access: ${op} on ${(ACCOUNTS.getUser(uid) || {}).handle || uid}`);
    return reply.code(r.ok ? 200 : 400).send(r);
  });

  // ===== direct messages ==========================================================================
  // Every route resolves the uid from the session and filters by participation. A thread id from
  // the client names a row; it never grants access to one.
  //
  // NOTE: none of these go through serveKeyed. Its keyedCache is a single shared Map keyed by a
  // string, so a per-user payload cached under a uid-less key would be served to the next caller —
  // exactly the leak this feature must not have. no-store, always.
  const dmMe = (req, reply) => {
    const me = meOf(req);
    if (!me) { reply.code(401).header("cache-control", "no-store").send({ ok: false, error: "sign in to use messages" }); return null; }
    ACCOUNTS.touch(me.uid);
    return me;
  };

  // Typing state is in memory and nowhere else. It expires on its own, it is worthless a second
  // later, and persisting it would mean a restart could claim somebody is mid-sentence.
  const dmTyping = new Map();            // threadId -> Map(uid -> expiresAt)
  const DM_TYPING_MS = 6000;
  function dmTypingSet(threadId, uid) {
    let m = dmTyping.get(threadId);
    if (!m) { m = new Map(); dmTyping.set(threadId, m); }
    m.set(uid, Date.now() + DM_TYPING_MS);
  }
  function dmTypingOf(threadId, exceptUid) {
    const m = dmTyping.get(threadId);
    if (!m) return [];
    const now = Date.now(), out = [];
    for (const [uid, exp] of m) {
      if (exp <= now) m.delete(uid);
      else if (uid !== exceptUid) out.push(uid);
    }
    if (!m.size) dmTyping.delete(threadId);
    return out;
  }

  fastify.get("/api/dm", (req, reply) => {
    reply.header("cache-control", "no-store");
    const me = dmMe(req, reply); if (!me) return;
    // The directory is simply the member list: at this size a request-to-connect flow is ceremony.
    return { ok: true, me: ACCOUNTS.pub(me), threads: ACCOUNTS.threads(me.uid),
      members: ACCOUNTS.listUsers().filter((u) => u.uid !== me.uid && !u.disabled),
      online: [...dmOnline()], maxLen: ACCOUNT_DM_MAX,
      reactions: ACCOUNTS.REACTIONS, maxFile: ACCOUNT_DM_FILE_MAX };
  });
  fastify.get("/api/dm/sync", (req, reply) => {
    reply.header("cache-control", "no-store");
    const me = dmMe(req, reply); if (!me) return;
    const q = req.query || {};
    return ACCOUNTS.sync(me.uid, q.since, q.limit);
  });
  fastify.get("/api/dm/search", (req, reply) => {
    reply.header("cache-control", "no-store");
    const me = dmMe(req, reply); if (!me) return;
    return ACCOUNTS.search(me.uid, (req.query || {}).q, (req.query || {}).limit);
  });
  // Attachments arrive base64 in a JSON body rather than multipart: it costs ~33% on the wire for
  // an 8 MB ceiling and saves a dependency in a codebase that has deliberately stayed at four.
  fastify.post("/api/dm/upload", { bodyLimit: 14 * 1024 * 1024 }, (req, reply) => {
    reply.header("cache-control", "no-store");
    const me = dmMe(req, reply); if (!me) return;
    const b = req.body || {};
    let buf;
    try { buf = Buffer.from(String(b.data || ""), "base64"); }
    catch (_) { return reply.code(400).send({ ok: false, error: "that upload was malformed" }); }
    const r = ACCOUNTS.putFile(me.uid, b.thread, b.name, buf);
    return reply.code(r.ok ? 200 : 400).send(r);
  });
  // Downloads are membership-checked, never id-checked: a forwarded link is not an access grant.
  // Only the four raster formats we verified by magic bytes render inline; everything else — SVG
  // and HTML above all, which are documents that can carry script — is forced to download.
  fastify.get("/api/dm/file/:id", (req, reply) => {
    const me = meOf(req);
    if (!me) return reply.code(401).header("cache-control", "no-store").send({ ok: false, error: "sign in first" });
    const r = ACCOUNTS.readFile(me.uid, (req.params || {}).id);
    if (!r.ok) return reply.code(404).header("cache-control", "no-store").send(r);
    const dispo = r.file.inline ? "inline" : "attachment";
    // The filename is quoted and RFC 5987-encoded; a name is a label, never a header injection.
    const safe = encodeURIComponent(r.file.name).replace(/['()]/g, escape);
    return reply
      .header("content-type", r.file.mime)
      .header("content-length", String(r.file.size))
      .header("content-disposition", dispo + "; filename*=UTF-8''" + safe)
      .header("x-content-type-options", "nosniff")
      .header("content-security-policy", "default-src 'none'; sandbox")
      .header("cache-control", "private, max-age=86400")
      .send(fs.createReadStream(r.path));
  });
  fastify.get("/api/dm/:id", (req, reply) => {
    reply.header("cache-control", "no-store");
    const me = dmMe(req, reply); if (!me) return;
    const q = req.query || {};
    const r = ACCOUNTS.history(me.uid, (req.params || {}).id, q.before, q.limit);
    if (!r.ok) return reply.code(404).send(r);
    r.typing = dmTypingOf(Number((req.params || {}).id), me.uid);
    return r;
  });
  // One route, many verbs in the body — the shape /api/notes and /api/baskets already use, so the
  // manifest gate covers the whole write surface at once and there is one place that decides who
  // may do what.
  fastify.post("/api/dm", { bodyLimit: 16 * 1024 }, (req, reply) => {
    reply.header("cache-control", "no-store");
    const me = dmMe(req, reply); if (!me) return;
    const b = req.body || {};
    let r;
    if (b.typing) {
      // Fire and forget: typing is a hint, and a hint that can fail loudly is worse than no hint.
      if (ACCOUNTS.isMember(b.thread, me.uid)) {
        dmTypingSet(Number(b.thread), me.uid);
        dmPoke(b.thread, { typing: { thread: Number(b.thread), uids: dmTypingOf(Number(b.thread), null) } });
      }
      return { ok: true };
    }
    if (b.group) r = ACCOUNTS.createGroup(me.uid, b.title, b.members);
    else if (b.addMembers) r = ACCOUNTS.addMembers(me.uid, b.thread, b.members);
    else if (b.removeMember) r = ACCOUNTS.removeMember(me.uid, b.thread, String(b.uid || ""));
    else if (b.leave) r = ACCOUNTS.leaveGroup(me.uid, b.thread);
    else if (b.rename) r = ACCOUNTS.renameGroup(me.uid, b.thread, b.title);
    else if (b.react) r = ACCOUNTS.react(me.uid, b.id, String(b.emoji || ""));
    else if (b.read != null || b.markRead) r = ACCOUNTS.markRead(me.uid, b.thread, b.read);
    else if (b.mute != null) r = ACCOUNTS.setMuted(me.uid, b.thread, !!b.mute);
    else if (b.drop && b.id != null) r = ACCOUNTS.drop(me.uid, b.id);
    else if (b.id != null) r = ACCOUNTS.edit(me.uid, b.id, b.body);
    else r = ACCOUNTS.send(me.uid, String(b.to || ""), b.body, coinForSymbol,
      { thread: b.thread || null, fileId: b.fileId || null });
    if (!r.ok) return reply.code(r.retry ? 429 : 400).send(r);
    // Wake everybody in the conversation. The frame carries a sequence number, never the message —
    // the client reacts by running the same sync pull it would have run on its own.
    if (r.thread) dmPoke(r.thread);
    return r;
  });

  // ---- the Telegram reply bridge -----------------------------------------------------------------
  // Which conversation a bare `/r` answers: the last one this chat was told about. Kept in memory
  // on purpose — it is a 30-minute convenience, and a stale mapping surviving a restart would route
  // somebody's reply into a conversation they had forgotten about.
  const dmReplyTarget = new Map();       // telegram chat id -> { thread, at }
  const DM_REPLY_CONTEXT_MS = 30 * 60 * 1000;
  if (poller.setDmBridge) poller.setDmBridge((chat, text) => {
    const owner = poller.pushOwnerOf ? poller.pushOwnerOf(String(chat)) : "";
    const me = owner && ACCOUNTS.getUser(owner);
    if (!me) return { ok: false, error: "This chat is not linked to an account." };
    const ctx = dmReplyTarget.get(String(chat));
    const thread = (ctx && Date.now() - ctx.at < DM_REPLY_CONTEXT_MS) ? ctx.thread : 0;
    const r = ACCOUNTS.bridgeReply(me.uid, text, thread);
    if (r.ok && r.thread) { dmPoke(r.thread); dmReplyTarget.set(String(chat), { thread: r.thread, at: Date.now() }); }
    return r.ok ? { ok: true, text: "Sent." } : { ok: false, error: r.error };
  });

  fastify.get("/logout", async (req, reply) => {
    setSessionCookies(reply, req, 0, null);   // Max-Age=0 deletes both cookies
    setAdminCookies(reply, req, 0, null);     // signing out drops elevation — never leave a stale admin lease
    clearAiUnlockCookie(reply, req);          // and the AI unlock, which outlives nothing
    return reply.redirect("/", 303);   // v5-forward signature (url, code) — the old order is deprecated
  });

  // ===== PWA shell: manifest + icon + service worker, all served inline (no new repo files) =====
  // The service worker deliberately caches NOTHING: it exists only to satisfy installability
  // (Chrome requires a fetch handler for the install prompt). Every request falls through to the
  // network untouched — a caching SW is exactly the stale-client failure class the version-stamped
  // shell was built to kill (-84), and we are not reintroducing it for offline support nobody asked for.
  const PWA_MANIFEST = JSON.stringify({
    name: "Milst Screener", short_name: "Milst",
    start_url: "/", display: "standalone", background_color: "#0E1116", theme_color: "#0E1116",
    icons: [{ src: "/icon.svg", sizes: "any", type: "image/svg+xml", purpose: "any" }],
  });
  const PWA_ICON = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512"><rect width="512" height="512" rx="96" fill="#0E1116"/><rect x="24" y="24" width="464" height="464" rx="80" fill="none" stroke="#262E39" stroke-width="8"/><text x="256" y="330" text-anchor="middle" font-family="monospace" font-size="210" font-weight="700" fill="#E8B44B">MS</text></svg>`;
  const PWA_SW = "self.addEventListener('install',()=>self.skipWaiting());self.addEventListener('activate',e=>e.waitUntil(self.clients.claim()));self.addEventListener('fetch',()=>{});";
  fastify.get("/manifest.webmanifest", async (req, reply) => reply.type("application/manifest+json").header("cache-control", "no-cache").send(PWA_MANIFEST));
  fastify.get("/icon.svg", async (req, reply) => reply.type("image/svg+xml").header("cache-control", "no-cache").send(PWA_ICON));
  fastify.get("/sw.js", async (req, reply) => reply.type("text/javascript").header("cache-control", "no-cache").send(PWA_SW));

  // threshold: don't spend gzip CPU on bodies under 1 KB (health, channel lists, empty fallbacks) —
  // the compressed result is no smaller and often larger. Big payloads (snapshot, analytics) still compress.
  // Baseline hardening headers on EVERY response (API, shell, login page, static assets alike).
  // nosniff stops MIME confusion across the JSON/HTML mix; DENY forbids framing outright —
  // nothing here is ever legitimately embedded, and a framed login page is a phishing kit;
  // same-origin referrer keeps versioned asset URLs and API paths from leaking to any external
  // link a report might one day carry. Deliberately NO Content-Security-Policy: the audience-
  // injected flag slot is an inline script by design, and a nonce pipeline buys nothing for a
  // password-gated single-page tool.
  fastify.addHook("onSend", async (req, reply) => {
    reply.header("x-content-type-options", "nosniff");
    reply.header("x-frame-options", "DENY");
    reply.header("referrer-policy", "same-origin");
    // Two-tier asset caching. Requests carrying the CURRENT build stamp (?v=<VERSION>) may
    // cache forever: the shell rewrites those URLs every deploy, so the URL itself is the
    // cache-buster and a new build is a new URL — immutable is safe by construction and saves
    // a revalidation round-trip per asset per load (app.js alone is ~700 KB raw). Everything
    // else — unstamped fetches, stale stamps from an old shell — keeps the static route's
    // forced revalidation, so a browser can never heuristically cache its way into the
    // "I deployed but I don't see it" failure the no-cache default exists for. Exact string
    // match on the whole query: a stale ?v= from last build fails the match and falls back to
    // revalidation, never to a year of wrong code.
    const q = req.url.indexOf("?");
    if (q >= 0 && req.url.slice(q + 1) === "v=" + VERSION && reply.statusCode === 200 && !req.url.startsWith("/api/"))
      reply.header("cache-control", "public, max-age=31536000, immutable");
  });

  await fastify.register(require("@fastify/compress"), { global: true, encodings: ["gzip", "deflate"], threshold: 1024 });
  await fastify.register(require("@fastify/static"), {
    root: path.join(__dirname, "public"),
    prefix: "/",
    index: false,   // index.html is served by the explicit routes below, version-stamped
    // Force revalidation by default; the stamped-asset immutable tier is applied in the onSend
    // hook below, which sees the request URL — setHeaders here only sees the raw response, and
    // the query string needed to verify the stamp is not reliably reachable from it.
    setHeaders(res) { res.setHeader("cache-control", "no-cache"); },
  });

  // ===== precompressed immutable assets (build 2026.07.29-06, Phase 1 of the perf batch) =========
  // The two stamped assets are immutable BY CONSTRUCTION (the ?v=VERSION URL is the cache-buster),
  // which makes maximum-effort compression free when amortized: brotli q11 runs ONCE at boot
  // (~1-2s, logged) instead of gzip running per cache miss, and brotli beats gzip by ~15-20% on JS
  // — a real first-load win on mobile, where app.js dominates the wire. Explicit routes win over
  // @fastify/static's wildcard by radix-tree specificity, so these take the hit path and static
  // remains the fallback for everything else. Degradation is deliberate and loud: if a read or
  // compress throws at boot, the route is simply not registered and @fastify/static serves the
  // file exactly as before — a failed optimization must never become a missing asset.
  // Negotiation order br → gzip → raw; content-encoding is set BEFORE @fastify/compress sees the
  // reply, which makes it skip these bodies (it never double-compresses an encoded payload).
  // cache-control starts at no-cache to match the static default; the onSend hook above runs at
  // send time and upgrades CURRENT-stamp requests to immutable, same as it always has — this
  // route changes the bytes on the wire, never the caching contract.
  const PRECOMP = (() => {
    const out = {};
    for (const [route, file, type] of [["/app.js", "app.js", "text/javascript; charset=utf-8"],
                                       ["/styles.css", "styles.css", "text/css; charset=utf-8"]]) {
      try {
        const raw = fs.readFileSync(path.join(__dirname, "public", file));
        const br = zlib.brotliCompressSync(raw, { params: {
          [zlib.constants.BROTLI_PARAM_QUALITY]: 11,
          [zlib.constants.BROTLI_PARAM_SIZE_HINT]: raw.length } });
        const gz = zlib.gzipSync(raw, { level: 9 });
        // Strong content identity for the ETag: two builds shipping identical bytes revalidate
        // across the deploy, and any byte change is a new tag — never keyed on VERSION alone.
        const tag = 'W/"' + crypto.createHash("sha1").update(raw).digest("base64url") + '"';
        out[route] = { raw, br, gz, type, tag };
        log(`precompressed ${file}: raw ${(raw.length / 1024).toFixed(0)} KB \u2192 br ${(br.length / 1024).toFixed(0)} KB \u00b7 gz ${(gz.length / 1024).toFixed(0)} KB`);
      } catch (e) { log(`WARN: precompress ${file} failed (${e.message}) \u2014 @fastify/static serves it per-request instead`); }
    }
    return out;
  })();
  for (const route of Object.keys(PRECOMP)) {
    fastify.get(route, async (req, reply) => {
      const a = PRECOMP[route];
      reply.header("vary", "accept-encoding").header("cache-control", "no-cache").type(a.type);
      if (req.headers["if-none-match"] === a.tag) return reply.header("etag", a.tag).code(304).send();
      reply.header("etag", a.tag);
      const ae = String(req.headers["accept-encoding"] || "");
      if (/\bbr\b/.test(ae)) return reply.header("content-encoding", "br").send(a.br);
      if (/\bgzip\b/.test(ae)) return reply.header("content-encoding", "gzip").send(a.gz);
      return reply.send(a.raw);
    });
  }

  // Version-stamped shell: index.html is read once at boot with ?v=BUILD stamped onto the two
  // asset tags, so every deploy changes the asset URLs themselves — a browser can no longer
  // run last build's app.js against this build's API, whatever its cache heuristics think
  // (the -84 lesson: revalidation headers alone did not save a stale client). The shell is
  // no-store; the stamped assets keep the ETag revalidation path.
  // The shell is now AUDIENCE-SPECIFIC: the resolved feature set is injected pre-paint so a gated tab
  // is never in the markup at all, rather than appearing for a frame and then being hidden by JS.
  // Split ONCE at boot around the placeholder so a request is a two-part concat, not a string scan of
  // a 23 KB document per hit. If the placeholder ever goes missing the split degrades to
  // "serve the shell unmodified" and the client falls back to showing everything — the ROUTES still
  // 403, so a failed injection costs a cosmetic leak, never actual access. Said out loud at boot.
  const FLAG_SLOT = "window.__FLAGS=null;window.__ADMIN=false;";
  const [INDEX_HEAD, INDEX_TAIL] = (() => {
    let h = fs.readFileSync(path.join(__dirname, "public", "index.html"), "utf8");
    const a = h.includes('src="/app.js"'), c = h.includes('href="/styles.css"');
    h = h.replace('src="/app.js"', `src="/app.js?v=${VERSION}"`).replace('href="/styles.css"', `href="/styles.css?v=${VERSION}"`);
    if (!a || !c) log("WARN: index.html asset tags drifted — version stamp incomplete (cache-busting degraded, app still serves)");
    const i = h.indexOf(FLAG_SLOT);
    if (i < 0) { log("WARN: index.html flag slot missing — feature visibility will not be injected (server gate still enforces; tabs may show and 403)"); return [h, ""]; }
    return [h.slice(0, i), h.slice(i + FLAG_SLOT.length)];
  })();
  // The pre-paint boot script, resolved for THIS caller: feature set, admin flag, nav labels and
  // identity. Nav labels ride it because the ribbon must paint with the admin's names on the FIRST
  // frame, or every load flashes the defaults before a fetch could correct them; identity rides it
  // for the same reason, so the header never shows a signed-out state to a signed-in member.
  const bootScript = (admin, me) =>
    "window.__FLAGS=" + JSON.stringify(resolveFeatures(poller.getFlags(), admin)) +
    ";window.__ADMIN=" + (admin ? "true" : "false") +
    ";window.__NAVGROUPS=" + JSON.stringify(poller.getNavGroups()) +
    ";window.__ME=" + JSON.stringify(me ? ACCOUNTS.pub(me) : null) + ";";
  const serveIndex = (req, reply) => {
    const admin = isAdmin(req);
    const boot = bootScript(admin, meOf(req));
    // Already no-store, so there is no cache to poison with the wrong audience's shell — the reason
    // this per-request body is safe where a cached one would not be.
    return reply.header("cache-control", "no-store").type("text/html; charset=utf-8").send(INDEX_HEAD + boot + INDEX_TAIL);
  };
  fastify.get("/", serveIndex);
  fastify.get("/index.html", serveIndex);

  fastify.get("/api/snapshot", (req, reply) =>
    serveCached(req, reply, poller.getSnapshot(), { ts: 0, dataTs: 0, benchCoin: null, markets: [] }));
  fastify.get("/api/daily", (req, reply) =>
    serveCached(req, reply, poller.getDaily(), { ts: 0, daily: {} }));
  fastify.get("/api/analytics", (req, reply) => {
    const scope = req.query && req.query.u === "crypto" ? "crypto" : "stocks";
    // When the cache is genuinely empty, ship the recorded build error with the fallback. Without
    // this the client can't distinguish "spines still warming" from "the build throws every cycle".
    const built = poller.getAnalytics(scope);
    const buildErr = poller.getAnalyticsErr ? poller.getAnalyticsErr(scope) : "";
    const body = built || { ts: 0, dataTs: 0, coverage: {}, universe: [], sections: {}, buildError: buildErr || null };
    // ETag must be scope-distinct: the two universes' dataTs values are both Date.now()-stamped and
    // can coincide to the millisecond at boot, which would let the browser 304 a crypto request with a
    // cached stocks body (or vice-versa) — both tabs then read a payload for the wrong universe. Prefix
    // the scope so the two URLs can never share a validator. (-17 fix.)
    reply.header("cache-control", "no-cache");
    // The empty fallback always carries dataTs 0, so without mixing the error text into the validator
    // a freshly-recorded failure reason would sit behind a 304 and never reach the tab.
    const errKey = built ? "" : "-e" + (buildErr ? buildErr.length : 0);
    const tag = 'W/"' + scope + "-" + (body.dataTs != null ? body.dataTs : (body.ts || 0)) + errKey + '"';
    reply.header("etag", tag);
    if (req.headers["if-none-match"] === tag) { return reply.code(304).send(); }
    reply.header("content-type", "application/json; charset=utf-8");
    return reply.send(JSON.stringify(body));
  });
  // Funding heatmap board — every market's carry over calendar time, at 1h / 8h / 24h.
  // Scope-prefixed ETag, for the same reason /api/analytics carries one: the two universes' dataTs
  // are both Date.now()-stamped and can coincide to the millisecond at boot, which would let a
  // browser 304 a crypto request with a cached stocks body. Prefixing the scope means the two URLs
  // can never share a validator.
  fastify.get("/api/funding", (req, reply) => {
    const scope = req.query && req.query.u === "crypto" ? "crypto" : "stocks";
    const body = poller.getFundingHeat(scope)
      || { ts: 0, dataTs: 0, scope, pending: true, count: 0, need: 5 };
    return sendCachedBody(req, reply, body,
      'W/"' + scope + "-" + (body.dataTs != null ? body.dataTs : (body.ts || 0)) + '"');
  });
  // Score duel: MOM vs MOM+ daily rank-IC record. Content only moves when a new IC day lands,
  // so serveCached's dataTs ETag makes this a 304 for nearly every poll.
  fastify.get("/api/duel", (req, reply) =>
    serveCached(req, reply, poller.getDuel(), { ts: 0, dataTs: 0, minN: 60, scopes: {} }));
  // EMA 13/21 trend ladder (D1 · H12 · H4 · H1) — ranked long/short leaderboards per universe.
  fastify.get("/api/trend", (req, reply) => {
    const q = req.query || {};
    // Custom MA pair → parametric board; absent or invalid pair → the canonical 13/21 board. Each
    // distinct pair produces a distinct body, so serveCached's content-signature ETag keys per pair.
    const data = (q.fast != null || q.slow != null) ? poller.getTrendPair(q.fast, q.slow) : null;
    return serveCached(req, reply, data || poller.getTrend(),
      { ts: 0, dataTs: 0, coverage: { included: 0, excluded: 0 }, long: { crypto: [], stocks: [] }, short: { crypto: [], stocks: [] } });
  });
  // Ranked live signals + their per-market historical base rates (event studies).
  fastify.get("/api/signals", (req, reply) =>
    serveCached(req, reply, poller.getSignals(isAdmin(req)), { ts: 0, dataTs: 0, count: 0, signals: [] }));

  // Trigger stream: the sequenced log of newly-fired setups. Consumers pass the last seq they
  // handled and get everything above it — restart-safe and refresh-safe in a way a timestamp is
  // not. no-store because the whole value is "what is new since MY cursor", which is per-caller.
  fastify.get("/api/triggers", (req, reply) => {
    const since = req.query && req.query.since;
    // Owner-scoped: rule events belong to whoever wrote the rule and must not appear in anyone
    // else's bell log. Market and server events are shared and unaffected.
    return reply.header("cache-control", "no-store").send(poller.getTriggers(since, ownerFor(req, reply), isAdmin(req)));
  });

  // ---- alert delivery (telegram push, slice A) ------------------------------------------------
  // Delivery state for the alerts panel: who is linked, the live link code, outbox depth, and the
  // last delivery outcomes. no-store — the whole payload is "what is true right now", and a link
  // code served from a cache is a code that has already expired.
  fastify.get("/api/alerts", (req, reply) => {
    const own = ownerFor(req, reply);
    return reply.header("cache-control", "no-store").send(poller.getPush(own, isAdmin(req)));
  });
  // Mint a single-use link code. The code, not the chat id, is what the human carries into the DM:
  // binding is proved in one direction so a typo cannot route someone's alerts to a stranger.
  fastify.post("/api/alerts/link", { bodyLimit: 4 * 1024 }, (req, reply) => {
    // The code carries the minting browser's handle, so whoever redeems it in Telegram is bound to
    // THAT browser — the link and the ownership are established in one step, unforgeably.
    const r = poller.pushMintCode(ownerFor(req, reply), isAdmin(req));
    return reply.code(r.ok ? 200 : 400).send(r);
  });
  fastify.post("/api/alerts/claim", { bodyLimit: 4 * 1024 }, (req, reply) => {
    const r = poller.pushClaim(String((req.body && req.body.chat) || ""), ownerFor(req, reply), isAdmin(req));
    return reply.code(r.ok ? 200 : (r.error === "forbidden" ? 403 : 400)).send(r);
  });
  fastify.post("/api/alerts/unlink", { bodyLimit: 4 * 1024 }, (req, reply) => {
    const r = poller.pushUnlink(String((req.body && req.body.chat) || ""), ownerFor(req, reply), isAdmin(req));
    return reply.code(r.ok ? 200 : (r.error === "forbidden" ? 403 : 400)).send(r);
  });
  // Per-recipient quiet hours and digest time. Separate from the class selection because they are
  // scheduling, not subscription — the same event can be wanted and still not wanted at 3am.
  fastify.post("/api/alerts/prefs", { bodyLimit: 8 * 1024 }, (req, reply) => {
    const b = req.body || {};
    const r = poller.pushSetPrefs(String(b.chat || ""), b, ownerFor(req, reply), isAdmin(req));
    return reply.code(r.ok ? 200 : (r.error === "forbidden" ? 403 : 400)).send(r);
  });
  fastify.post("/api/alerts/classes", { bodyLimit: 8 * 1024 }, (req, reply) => {
    const b = req.body || {};
    const r = poller.pushSetClasses(String(b.chat || ""), Array.isArray(b.classes) ? b.classes : null, ownerFor(req, reply), isAdmin(req));
    return reply.code(r.ok ? 200 : (r.error === "forbidden" ? 403 : 400)).send(r);
  });
  // Test fire: the only way to prove the wire without waiting for a real setup — and the only way
  // I can hand over a feature whose transport I cannot reach from a dev sandbox.
  fastify.post("/api/alerts/test", { bodyLimit: 4 * 1024 }, (req, reply) => {
    const r = poller.pushTest((req.body && req.body.chat) || null, ownerFor(req, reply), isAdmin(req));
    if (!r.ok && r.error === "cooldown") return reply.code(429).send(r);
    return reply.code(r.ok ? 200 : 400).send(r);
  });
  // Morning-brief test fire. ADMIN ONLY, unlike the plain test above: a brief costs a model call
  // and lands as two messages, so it is an operator tool for checking formatting, not something a
  // visitor should be able to trigger. `fresh` regenerates instead of re-serving the hour's cache —
  // that is the one that actually burns budget, so it is opt-in rather than the default.
  // `kind` selects which scheduled send is being tested. Folded into one route: the auth, the body
  // limit and the ownership check are identical, and a second near-clone endpoint is a second place
  // for that gate to drift.
  fastify.post("/api/alerts/brief-test", { bodyLimit: 4 * 1024 }, async (req, reply) => {
    if (!isAdmin(req)) return reply.code(403).send({ ok: false, error: "admin only" });
    const b = req.body || {};
    const fn = b.kind === "landscape" ? poller.landTest : poller.briefTest;
    const r = await fn(b.chat || null, ownerFor(req, reply), true, !!b.fresh, !!b.operator || !!b.mine);
    return reply.code(r.ok ? 200 : 400).send(r);
  });

  // User-authored metric rules: the threshold alerts, group-shared and server-evaluated so they
  // keep firing with every tab closed. no-store — the list is small and edits must be visible to
  // the next reader immediately.
  fastify.get("/api/alerts/rules", (req, reply) => {
    const own = ownerFor(req, reply);
    return reply.header("cache-control", "no-store").send(poller.getRules(own, isAdmin(req)));
  });
  fastify.post("/api/alerts/rules", { bodyLimit: 16 * 1024 }, (req, reply) => {
    const b = req.body || {};
    const own = ownerFor(req, reply);
    const r = b.del != null ? poller.deleteRule(b.del, own, isAdmin(req)) : poller.addRule(b, own);
    return reply.code(r.ok ? 200 : (r.error === "forbidden" ? 403 : 400)).send(r);
  });

  // Actionable board: names currently at a swing trigger, funding-net and ranked by expectancy.
  // Content-signature ETag via serveCached — the payload only moves when a claim opens, closes,
  // ages a bar, or its geometry re-prices against the live mark.
  fastify.get("/api/actionable", (req, reply) =>
    serveCached(req, reply, poller.getActionable(isAdmin(req)),
      { ts: 0, dataTs: 0, params: {}, coverage: {}, rows: [], count: 0 }));
  // Earnings calendar for the xyz equity universe (Finnhub-fed, 6h server refresh). ETag rides
  // dataTs like the other cached payloads, so an unchanged calendar revalidates to a 304.
  fastify.get("/api/earnings", (req, reply) =>
    serveCached(req, reply, poller.getEarnings(), { ts: 0, dataTs: 0, asOf: null, windowDays: 14, source: "finnhub", error: "not fetched yet", entries: [], recent: [], eligible: 0 }));
  // Housing / MBS board — FRED-fed, 6h server refresh. ETag rides dataTs like the other cached
  // payloads, so an unchanged board revalidates to a 304.
  fastify.get("/api/housing", (req, reply) =>
    serveCached(req, reply, poller.getHousing(), { ts: 0, dataTs: 0, asOf: null, error: "not fetched yet", series: {}, missing: [], pending: [] }));
  fastify.get("/api/liquidity", (req, reply) =>
    serveCached(req, reply, poller.getLiquidity(), { ts: 0, dataTs: 0, asOf: null, error: "not fetched yet", levels: {}, derived: null, missing: [] }));
  // Operator surgery for feed-garbage earnings prints (e.g. a phantom report date the feed
  // asserted and never corrected): removes the print from history and the reaction study and
  // tombstones it so no future fetch can resurrect it. Session-gated like every route.
  // Forced history backfill for the reaction study. Admin-only: it is an operator action that
  // spends the vendor's rate budget on a long chunk walk, and unlike the automatic one it runs
  // whatever the done-flag says.
  fastify.post("/api/earnings/backfill", { bodyLimit: 2 * 1024 }, async (req, reply) => {
    reply.header("cache-control", "no-store");
    if (!isAdmin(req)) return reply.code(403).send({ ok: false, error: "forbidden" });
    const b = req.body || {};
    const r = await poller.earnHistBackfillNow({ days: +b.days || undefined });
    return reply.code(r.ok ? 200 : 400).send(r);
  });
  fastify.post("/api/earnings/void", (req, reply) => {
    const b = req.body || {};
    const r = poller.voidEarnPrint(b.t, b.d);
    return reply.code(r.ok ? 200 : 400).send(r);
  });
  // Per-market OI + funding history — powers the drawer sparklines.
  fastify.get("/api/series", (req, reply) => {
    const coin = (req.query && req.query.coin) || "";
    // The drawer sparklines are a few hundred px wide; shipping the full 31d full-resolution track
    // (~9k points) is wasted bytes. Uniform-stride down to ~SERIES_CAP points, always keeping the
    // last (live-edge) sample exact. Shape is preserved; nothing downstream reads raw point count.
    // serveKeyed adds the ETag 304 (drawer reopen on the same name is a no-body round trip) and the
    // downsample+gzip is memoized on the built object until the coin's spine advances.
    serveKeyed(req, reply, "series|" + coin + "|" + poller.getCoinStamp(coin).st,
      () => { const s = poller.getSeries(coin) || { oi: [], funding: [] };
        return { coin, oi: downsampleSeries(s.oi, SERIES_CAP), funding: downsampleSeries(s.funding, SERIES_CAP) }; },
      { coin, oi: [], funding: [] });
  });
  // Crypto intraday correlation matrix (Correlation tab, crypto scope). w = 4h | 1d | 7d selects
  // the window (and its base bar: 5m / 15m / 1h). The poller builds it over the 5m archive and
  // memoizes per window; the ETag key folds the archive stamp so a fresh bar mints a fresh key and
  // toggle-spam on one window 304s. Ships the matrix + per-name close series on a shared grid, so
  // the pair view and COMP/G rebase off the exact numbers the matrix used — one source of truth.
  fastify.get("/api/corr-crypto", (req, reply) => {
    const win = (req.query && req.query.w) || "1d";
    return serveKeyed(req, reply, "corr-crypto|" + win + "|" + poller.getCryptoCorrStamp(win),
      () => poller.getCryptoCorr(win),
      { win, enabled: false, bar: null, times: [], coins: [], C: [], N: [], minOv: 0, reason: "not built yet" });
  });
  // Custom baskets (build 2026.07.28-06): registry + server-synthesized EW daily series, one
  // payload. Both routes are gated by the "baskets" manifest key (admin while it soaks). Visual
  // layer only — nothing served here ever feeds signal math or the alert emitters.
  fastify.get("/api/baskets", (req, reply) =>
    serveKeyed(req, reply, "baskets|" + poller.getBasketsStamp(), () => poller.getBasketsPayload(), { baskets: [], floor: 0.6 }));
  // One route, two verbs in the body: {name, members[]} creates, {name, drop:true} drops. The
  // gate matches the method-less manifest route string, so both verbs open and close together.
  fastify.post("/api/baskets", { bodyLimit: 8 * 1024 }, (req, reply) => {
    const b = req.body || {};
    const admin = isAdmin(req);
    const res = b.drop ? poller.dropBasket(b.name, admin) : poller.createBasket(b.name, b.members, admin);
    reply.header("cache-control", "no-store").send(res);
  });
  // Per-ticker notes (build 2026.08.24-01). GET is the whole book — bodies included — because the
  // Notes tab wants all of them and the drawer wants one name's worth; both are the same small
  // payload and it changes only when somebody writes. The markets table never calls this: it paints
  // its markers off the {n, ts, px} digest already riding the snapshot.
  fastify.get("/api/notes", (req, reply) =>
    serveKeyed(req, reply, "notes|" + poller.getNotesStamp(), () => poller.getNotesPayload(), { ts: 0, notes: [] }));
  // One route, three verbs in the body: {coin, body} creates, {id, body} edits, {id, drop:true}
  // deletes. Same shape as /api/baskets so the manifest gate covers the whole write surface at once.
  // bodyLimit is generous because a note is prose — the per-note ceiling is enforced in the poller.
  fastify.post("/api/notes", { bodyLimit: 16 * 1024 }, (req, reply) => {
    const b = req.body || {};
    const admin = isAdmin(req);
    const res = b.drop ? poller.dropNote(b.id, admin)
      : b.id != null ? poller.editNote(b.id, b.body, admin)
      : poller.createNote(b.coin, b.body, admin);
    reply.header("cache-control", "no-store").send(res);
  });
  // Ratio pair candles: server-computed from hourly ratio closes (basket legs synthesized hourly),
  // bucketed with the ladder's own bucketer, EMA200 over the full series before the wire trim —
  // the client only renders. Key folds the baskets stamp + a 5-minute clock bucket: edits and new
  // dailies mint fresh keys, tf-toggle spam inside a bucket 304s.
  fastify.get("/api/ratio", (req, reply) => {
    const q = req.query || {};
    const key = "ratio|" + (q.num || "") + "|" + (q.den || "") + "|" + (q.tf || "") + "|" + poller.getBasketsStamp() + "|" + Math.floor(Date.now() / 300000);
    return serveKeyed(req, reply, key, () => poller.getRatio(q.num, q.den, q.tf), { ok: false, error: "poller not ready" });
  });
  // Claim-history browser: filter by ticker (coin=), by event type (ev=), or both. Powers the
  // drawer signal record and the Signals-tab full history search.
  // Coinalyze deriv context (crypto drawer panel + CASC column detail). Per-coin fresh payloads
  // must go through serveKeyed (same reasoning as candles/series): the body carries live cooldown
  // and staleness fields, so the ETag key comes from poller.derivsKey — collision-proof per
  // (coin, content version, refresh stamp, as-of minute).
  fastify.get("/api/derivs", (req, reply) => {
    const coin = String((req.query && req.query.coin) || "");
    return serveKeyed(req, reply, "derivs|" + poller.derivsKey(coin), () => poller.getDerivs(coin),
      { coin, enabled: false, error: "unavailable" });
  });
  // Manual per-ticker refresh: cooldown is the group's rate limit, enforced in the poller —
  // the client's disabled button is convenience, this check is the gate. Cooldown maps to 429.
  fastify.post("/api/derivs/refresh", { bodyLimit: 8 * 1024 }, async (req, reply) => {
    const coin = String((req.body && req.body.coin) || "");
    const r = await poller.refreshDerivs(coin);
    if (!r.ok && r.error === "cooldown") return reply.code(429).send(r);
    if (!r.ok) return reply.code(400).send(r);
    return r;
  });
  // Fundamentals (equity drawer panel · Finnhub basic financials + profile2). Per-coin fresh
  // payloads via serveKeyed for the same reason as derivs: the body carries a live-derived trio
  // (market cap / P/E / P/S off the current mark), so poller.fundamentalsKey folds a coarse px
  // bucket — collision-proof per (coin, content version, cache stamp, px bucket).
  fastify.get("/api/fundamentals", (req, reply) => {
    const coin = String((req.query && req.query.coin) || "");
    return serveKeyed(req, reply, "fund|" + poller.fundamentalsKey(coin), () => poller.getFundamentals(coin),
      { coin, enabled: false, error: "unavailable" });
  });
  // Weekly classification audit (build 2026.08.05-02): admin-only, all four routes. GET serves the
  // folded record log (applied overlay entries + flagged holds + revert pins); the POSTs are the
  // panel's three verbs — revert an applied entry, resolve a flagged name to a chosen sector, and
  // run the audit now instead of waiting for Sunday. Everything writes through the poller's
  // validate-then-append path; nothing here touches the record log directly.
  fastify.get("/api/sector-audit", (req, reply) => {
    reply.header("cache-control", "no-store");
    if (!isAdmin(req)) return reply.code(403).send({ error: "forbidden" });
    return poller.getSectorAudit();
  });
  fastify.post("/api/sector-audit/revert", { bodyLimit: 4 * 1024 }, (req, reply) => {
    reply.header("cache-control", "no-store");
    if (!isAdmin(req)) return reply.code(403).send({ error: "forbidden" });
    const r = poller.sectorAuditRevert(String((req.body || {}).ticker || ""));
    return reply.code(r.ok ? 200 : 400).send(r);
  });
  fastify.post("/api/sector-audit/apply", { bodyLimit: 4 * 1024 }, (req, reply) => {
    reply.header("cache-control", "no-store");
    if (!isAdmin(req)) return reply.code(403).send({ error: "forbidden" });
    const b = req.body || {};
    const r = poller.sectorAuditApply(String(b.ticker || ""), String(b.sector || ""), String(b.ind || ""));
    return reply.code(r.ok ? 200 : 400).send(r);
  });
  fastify.post("/api/sector-audit/ack", { bodyLimit: 4 * 1024 }, (req, reply) => {
    reply.header("cache-control", "no-store");
    if (!isAdmin(req)) return reply.code(403).send({ error: "forbidden" });
    const r = poller.sectorAuditAck(String((req.body || {}).ticker || ""));
    return reply.code(r.ok ? 200 : 400).send(r);
  });
  fastify.post("/api/sector-audit/run", { bodyLimit: 4 * 1024 }, async (req, reply) => {
    reply.header("cache-control", "no-store");
    if (!isAdmin(req)) return reply.code(403).send({ error: "forbidden" });
    const r = await poller.sectorAuditRunNow();
    return reply.code(r.ok ? 200 : 409).send(r);
  });
  fastify.get("/api/ledger", (req, reply) => {
    reply.header("cache-control", "no-store");
    const coin = (req.query && req.query.coin) || "";
    const ev = (req.query && req.query.ev) || "";
    return poller.getLedgerFor(coin, ev, isAdmin(req));
  });
  // Telegram channel management: shared group config. GET = list + per-channel status,
  // POST = replace the list (validated server-side, persisted to the volume, applied within
  // seconds). Small and mutable — served uncached.
  fastify.get("/api/news/channels", (req, reply) => reply.header("cache-control", "no-store").send(poller.getTgChannels()));
  fastify.post("/api/news/channels", (req, reply) => {
    const r = poller.setTgChannels(req.body && req.body.channels);
    return reply.code(r.ok ? 200 : 400).send(r);
  });
  // News feed for the xyz universe: company headlines + macro tape, 72h retention, served
  // whole (the drawer slices client-side from the same payload — one fetch, one source).
  fastify.get("/api/news", (req, reply) =>
    serveCached(req, reply, poller.getNews(), { ts: 0, dataTs: 0, items: [], count: 0, fetchedAt: null, ttlHours: 72, error: "not fetched yet" }));
  // One-shot raw ledger dump for offline analysis: every retained closed claim (shadow
  // variants and legacy entries included), open claims, variant state, and an embedded field
  // glossary so the file is self-describing months later. Served as a browser download;
  // session-gated by the global hook like every /api route (Basic auth works for curl).
  // Deliberately under /api/export/ — NOT /api/ledger/export — so the route manifest's
  // exactly-once string pin on "/api/ledger" keeps counting one registration.
  fastify.get("/api/export/ledger", (req, reply) => {
    reply.header("cache-control", "no-store");
    reply.header("content-disposition", `attachment; filename="xyz-ledger-${new Date().toISOString().slice(0, 10)}.json"`);
    return poller.getLedgerExport(isAdmin(req));
  });
  // Hourly OHLCV for the drawer candle chart. days: 1..60, default 14. With tf=1h|4h|12h|1d the
  // response is instead the EXACT per-rung series the trend ladder consumes (Trend-tab chart
  // modal) — [t,o,h,l,c] bars plus the live mark, so the client's plotted EMAs reproduce the
  // board's to the last bit. Unknown tf values fall through to the legacy hourly shape.
  fastify.get("/api/candles", (req, reply) => {
    const coin = (req.query && req.query.coin) || "";
    const days = req.query && req.query.days;
    const tf = req.query && req.query.tf;
    // res=5m serves the on-disk 5-minute archive (from/to epoch-ms, optional max points), a
    // separate axis from tf= (ladder timeframes) and days= (hourly spine). Downsampled server-side;
    // ETag folds in the coin's last-captured-bar stamp so a new bar mints a fresh key. Same
    // serveKeyed path as the rest of the route (the manifest pins /api/candles -> serveKeyed).
    // res=1m RETIRED (build 2026.08.17-01): the FOCUS chart dropped its 3m timeframe, and with
    // 5m/15m/1h/4h all divisible by five, the chart now reads the local 5m ARCHIVE through the
    // res=5m branch below — the same series that fills the +1h columns. One source for board
    // and chart, zero live fetches on modal open, and the pre-open/overnight bars come free
    // because the perps trade (and the capture lane records) around the clock.
    if (req.query && (req.query.res === "5m" || req.query.res === "5")) {
      const from = req.query.from, to = req.query.to, max = req.query.max;
      const key = "candles5m|" + coin + "|" + (from || "") + "|" + (to || "") + "|" + (max || "") + "|" + (poller.getM5Stamp ? poller.getM5Stamp(coin) : 0);
      return serveKeyed(req, reply, key, () => poller.getCandles5m(coin, from, to, max), { coin, res: "5m", enabled: false, candles: [], coverage: { enabled: false } });
    }
    // res=4h / res=12h / res=1d serve the deep-history archive (12h/1d since -01, 4h since -03) —
    // seeded backward to
    // each listing's birth via the native window (~2.3y/6.8y/13.7y at these intervals), captured
    // forward on the closed-bar guard. Same serveKeyed discipline; the ETag folds in the
    // interval's own last-captured-bar stamp so a freshly closed day mints a fresh key.
    if (req.query && (req.query.res === "4h" || req.query.res === "12h" || req.query.res === "1d")) {
      const iv = req.query.res, from = req.query.from, to = req.query.to, max = req.query.max;
      const key = "candlesdeep|" + iv + "|" + coin + "|" + (from || "") + "|" + (to || "") + "|" + (max || "") + "|" + (poller.getDeepStamp ? poller.getDeepStamp(coin, iv) : 0);
      return serveKeyed(req, reply, key, () => poller.getCandlesDeep(coin, iv, from, to, max), { coin, res: iv, enabled: false, candles: [], coverage: { enabled: false } });
    }
    // Heaviest per-request payload on the board, and re-fetched on every tf-toggle in the report
    // and trend chart modals — exactly the traffic the ETag 304 + gzip memo pay off on. The tf
    // series carries a FORMING last bar whose close is the live mark (getTfCandles reads r.px),
    // which streams without bumping the spine stamp — so for tf requests the key also folds in a
    // coarse ~0.1% price bucket: instant toggle-spam at one price 304s, a real move mints a fresh
    // key, and the forming bar can never freeze against the tape (the one-code-path rule). The
    // legacy `days` hourly payload does no live-mark substitution client-side, so it keys on the
    // spine stamp alone.
    let key;
    const cfast = req.query && req.query.fast, cslow = req.query && req.query.slow;
    const cpair = (cfast != null || cslow != null) ? `|ma:${cfast || ""}-${cslow || ""}` : "";
    if (tf) { const cs = poller.getCoinStamp(coin);
      const bucket = cs.px > 0 ? Math.round(Math.log(cs.px) * 1000) : 0;   // ~0.1% granularity, scale-free
      key = "candles|" + coin + "|tf:" + String(tf).toLowerCase() + cpair + "|" + cs.st + "|" + bucket; }
    else key = "candles|" + coin + "|d:" + (days || 14) + "|" + poller.getCoinStamp(coin).st;
    serveKeyed(req, reply, key, () => {
      if (tf) { const r = poller.getTfCandles(coin, tf, cfast, cslow); if (r) return r; }
      return { coin, candles: poller.getCandles(coin, days) };
    }, { coin, candles: [] });
  });
  // AI analyst report: everything this server holds on one ticker, compiled and sent to the
  // Anthropic API (Fable, Opus fallback), validated, and cached for the whole group. GET serves
  // the cache with live freshness (fresh / stale / invalidated + reason); POST generates — the
  // TTL cooldown is enforced server-side (429), so the shared cache IS the group's rate limit.
  // Session-gated like every route; the API key never leaves the server.
  // FOCUS (build 2026.08.15-01): the frozen-at-open 6-seat watchlist — today's stamp, the +1h
  // fill, the cut line and yesterday's list, all verbatim from the poller's persisted state.
  // Keyed on the focus stamp alone: the payload only changes when a stamp, fill or day-roll
  // lands, so everything else 304s. Route gated by the "focus" manifest key.
  fastify.get("/api/focus", (req, reply) => {
    const key = "focus|" + poller.getFocusStamp();
    return serveKeyed(req, reply, key, () => poller.getFocus(), { state: "off", today: null, prev: null });
  });
  // FOCUS liquidity floors (build 2026.08.18-03), admin panel only. GET carries the structural
  // scan the panel's distribution is drawn from — no-store rather than keyed, because the scan
  // tracks the live tape and a stale histogram would have the operator calibrating a wall against
  // yesterday's volumes. Both verbs re-check the admin cookie on top of the manifest gate
  // (focus.limits): visibility and authz are separate axes and both must pass.
  fastify.get("/api/focus/limits", (req, reply) => {
    reply.header("cache-control", "no-store");
    if (!isAdmin(req)) return reply.code(403).send({ error: "forbidden" });
    return poller.getFocusLimits();
  });
  // 8 KB cap — the payload is { vol, oi }; anything larger is malformed or hostile (413).
  fastify.post("/api/focus/limits", { bodyLimit: 8 * 1024 }, (req, reply) => {
    reply.header("cache-control", "no-store");
    const b = req.body || {};
    const r = poller.setFocusLimits(b.vol, b.oi, isAdmin(req));
    if (!r.ok) return reply.code(r.error === "forbidden" ? 403 : r.error === "write-failed" ? 503 : 400).send(r);
    return reply.send({ ...r, scan: poller.getFocusLimits().scan });
  });
  // FUNDS / 13F whale lane (build 2026.08.16-01). ONE exact read path — list, per-fund detail and
  // season all ride query params on /api/whale so the manifest's exact-path gate is a single wall
  // over the whole tab. Detail and season resolve ticker matches asynchronously (the SEC name map
  // may need a fetch), so those two branches bypass serveKeyed's sync build and ship no-cache with
  // the stamp folded into a weak ETag by hand — same 304 economics, async-safe.
  fastify.get("/api/whale", async (req, reply) => {
    const qq = req.query || {};
    if (qq.fund) {
      const body = await poller.getWhaleFund(String(qq.fund), qq.full === "1");
      const tag = 'W/"whale-f|' + String(qq.fund) + "|" + (qq.full === "1" ? 1 : 0) + "|" + poller.getWhaleStamp() + '"';
      reply.header("cache-control", "no-cache").header("etag", tag);
      if (req.headers["if-none-match"] === tag) return reply.code(304).send();
      return reply.send(body);
    }
    if (qq.holds != null) {
      // "Who holds" reverse lookup — cached books only, zero EDGAR traffic per query. Same weak-
      // ETag treatment as the other async branches; the query rides the tag so results cache per
      // search term.
      const body = await poller.getWhaleHolds(String(qq.holds));
      const tag = 'W/"whale-h|' + String(qq.holds).slice(0, 40) + "|" + poller.getWhaleStamp() + '"';
      reply.header("cache-control", "no-cache").header("etag", tag);
      if (req.headers["if-none-match"] === tag) return reply.code(304).send();
      return reply.send(body);
    }
    if (qq.season != null) {
      const body = await poller.getWhaleSeasonQ(String(qq.season));
      const tag = 'W/"whale-s|' + String(qq.season) + "|" + poller.getWhaleStamp() + '"';
      reply.header("cache-control", "no-cache").header("etag", tag);
      if (req.headers["if-none-match"] === tag) return reply.code(304).send();
      return reply.send(body);
    }
    const key = "whale|" + poller.getWhaleStamp();
    return serveKeyed(req, reply, key, () => poller.getWhale(), { ts: 0, watch: [], window: null });
  });
  // Watchlist writes. The manifest's whale.write key gates audience; this handler RECHECKS the
  // admin cookie because gate and authz are different axes (the features-POST posture): flipping
  // the FUNDS tab public must never open the list to public edits. mark-seen is the one exception —
  // any authenticated viewer clearing their own unseen badge is UX, not authorship.
  fastify.post("/api/whale/watch", { bodyLimit: 8 * 1024 }, async (req, reply) => {
    reply.header("cache-control", "no-store");
    const b = req.body || {};
    const op = String(b.op || "");
    if (op === "seen") return poller.whaleSeen(String(b.key || ""));
    if (!isAdmin(req)) return reply.code(403).send({ ok: false, error: "forbidden" });
    if (op === "search") return poller.whaleSearch(String(b.q || ""));
    if (op === "pull") return poller.whalePull(String(b.key || ""));   // "find latest filing" — one on-demand EDGAR check, 60s/fund cooldown inside
    if (op === "ingest13f") { poller.whale13fIngestNow(b.q ? String(b.q) : undefined).catch(() => {}); return { ok: true, started: 1, note: "ingest running in the background \u2014 progress lands in the ops log; the data set is ~300MB, give it a few minutes" }; }
    if (op === "add") return poller.whaleAdd(+b.cik, String(b.name || ""));
    if (op === "rm") return poller.whaleRm(String(b.key || ""));
    if (op === "mute") return poller.whaleMute(String(b.key || ""), !!b.on);
    return reply.code(400).send({ ok: false, error: "unknown op" });
  });
  // CONGRESS lane phase 1 (build 2026.08.24-02): admin-only in BOTH directions while it soaks —
  // the read is gated too, so phase 1 ships with genuinely no public surface (the LIQUIDITY board's
  // posture). Phase 2 grows a feed on this same route and drops the gate on the GET once the parse
  // rate and the ticker-resolution rate are numbers worth printing.
  fastify.get("/api/congress", async (req, reply) => {
    reply.header("cache-control", "no-store");
    // No hardcoded admin check here on purpose: the route is registered in the feature manifest as
    // def:"admin", so the gate already refuses non-admins — and taking the lane public later is a
    // flag flip rather than an edit to this file. The POST below is a different axis and rechecks.
    const q = req.query || {};
    const lim = +q.limit || 25;
    if (q.watch) return { ok: true, watch: poller.congressWatchList() };
    if (q.ticker) return { ok: true, roll: poller.congressTickerRoll(String(q.ticker)) };
    if (q.feed) {
      const qq = q.q ? String(q.q).slice(0, 40) : null;
      // The selection and the VIEW of it are separate: total must count every row the filter
      // matches, not the page being returned, or the pager cannot know how many pages exist.
      const sel = { since: q.since ? String(q.since) : null, q: qq,
        ticker: q.ticker ? String(q.ticker) : null, starred: q.starred ? 1 : 0 };
      return { ok: true, status: poller.congressStatus(),
        feed: poller.congressFeed(Object.assign({ limit: lim, offset: +q.offset || 0,
          sort: q.sort ? String(q.sort) : null,
          dir: q.dir == null || q.dir === "" ? -1 : +q.dir }, sel)),
        total: poller.congressFeedCount(sel),
        // When a search comes up thin, the INDEX still knows whether that member filed at all.
        filers: qq ? poller.congressFilerSearch(qq) : null,
        watch: poller.congressWatchList() };
    }
    return { ok: true, status: poller.congressStatus(),
      filings: poller.congressFilings({ type: q.type ? String(q.type) : null, limit: lim }) };
  });
  fastify.post("/api/congress", { bodyLimit: 4 * 1024 }, async (req, reply) => {
    reply.header("cache-control", "no-store");
    if (!isAdmin(req)) return reply.code(403).send({ ok: false, error: "forbidden" });
    const b = req.body || {};
    const op = String(b.op || "");
    if (op === "ingest") { poller.congressIngestNow(b.year ? +b.year : undefined).catch(() => {});
      return { ok: true, started: 1, note: "index ingest running in the background \u2014 progress and the URL that answered land in the ops log" }; }
    if (op === "parse") { poller.congressParseNow(+b.n || undefined).catch(() => {});
      return { ok: true, started: 1, note: "parse run started \u2014 one document a second, progress in the ops log" }; }
    if (op === "ocr") { poller.congressOcrNow(+b.n || undefined).catch(() => {});
      return { ok: true, started: 1, note: "OCR run started \u2014 seconds per page, so this is slow by nature; progress in the ops log" }; }
    if (op === "diag") return poller.congressDiagNow(String(b.doc || ""));
    if (op === "requeue") return poller.congressRequeueNow(b.all ? "all" : null);
    if (op === "reticker") return poller.congressRetickerNow(+b.n || undefined);
    if (op === "watch") return poller.congressWatchSet(String(b.member || ""), b.on !== false, b.notify !== false);
    if (op === "backfill") { poller.congressBackfillNow(+b.years || undefined).catch(() => {});
      return { ok: true, started: 1, note: "backfill started \u2014 one prior year at a time, progress in the ops log" }; }
    if (op === "status") return { ok: true, status: poller.congressStatus() };
    return reply.code(400).send({ ok: false, error: "unknown op" });
  });
  // INSIDERS (build 2026.08.27-38): Section 16 Form 4 transactions. Read route only here; the
  // manifest registers it as def:"admin" so the gate refuses non-admins while the lane soaks, and
  // taking it public later is a flag flip rather than an edit to this file. The POST is a
  // different axis and rechecks admin regardless, exactly as the congress route documents.
  fastify.get("/api/insiders", async (req, reply) => {
    reply.header("cache-control", "no-store");
    const q = req.query || {};
    if (q.ticker && !q.feed) return { ok: true, roll: poller.insidersTickerRoll(String(q.ticker), +q.days || 90) };
    // The selection and the VIEW of it are separate: total counts every row the filter matches,
    // not the page being returned, or the pager cannot know how many pages exist.
    const sel = { q: q.q ? String(q.q).slice(0, 60) : null,
      ticker: q.ticker ? String(q.ticker) : null,
      codes: q.codes ? String(q.codes).slice(0, 30) : null,
      role: q.role ? String(q.role).slice(0, 20) : null,
      plan: q.plan === "only" || q.plan === "excl" ? q.plan : null,
      kind: q.kind === "S" || q.kind === "D" ? q.kind : null,
      minValue: q.minValue ? +q.minValue : null,
      // The range, and which of the form's two dates it applies to. Anything that is not a bare
      // ISO day is dropped rather than passed down — the store re-checks the shape too, but a
      // parameter that only ever holds a date should not carry anything else this far.
      from: /^\d{4}-\d{2}-\d{2}$/.test(String(q.from || "")) ? String(q.from) : null,
      to: /^\d{4}-\d{2}-\d{2}$/.test(String(q.to || "")) ? String(q.to) : null,
      dateOn: q.dateOn === "filed" ? "filed" : "traded" };
    return { ok: true, status: poller.insidersStatus(),
      feed: poller.insidersFeed(Object.assign({ limit: Math.min(200, +q.limit || 50), offset: +q.offset || 0,
        sort: q.sort ? String(q.sort) : null,
        dir: q.dir == null || q.dir === "" ? -1 : +q.dir }, sel)),
      total: poller.insidersFeedCount(sel) };
  });
  fastify.post("/api/insiders", { bodyLimit: 4 * 1024 }, async (req, reply) => {
    reply.header("cache-control", "no-store");
    if (!isAdmin(req)) return reply.code(403).send({ ok: false, error: "forbidden" });
    const b = req.body || {};
    const op = String(b.op || "");
    if (op === "parse") { poller.insidersParseNow(Math.min(50, +b.n || 10)).catch(() => {});
      return { ok: true, started: 1, note: "parse run started — two SEC reads per filing, progress in the ops log" }; }
    if (op === "requeue") return poller.insidersRequeueNow(!!b.all);
    if (op === "backfill") { poller.insidersBackfillNow({ days: +b.days || undefined }).catch(() => {});
      return { ok: true, started: 1, note: "history walk started — one SEC submissions read per roster name, progress in the ops log and on `insiders status`" }; }
    if (op === "status") return { ok: true, status: poller.insidersStatus() };
    return reply.code(400).send({ ok: false, error: "unknown op" });
  });
  fastify.get("/api/ai-report", (req, reply) => {
    reply.header("cache-control", "no-store");
    const coin = (req.query && req.query.coin) || "";
    return poller.getAiReport(coin, aiWho(req, reply));
  });
  fastify.post("/api/ai-report", async (req, reply) => {
    reply.header("cache-control", "no-store");
    const b = req.body || {};
    // b.coin may be a single name OR a group key (grp:sec:<sector> / grp:bkt:<T1+T2+...>) —
    // the poller routes on the prefix; caps and cooldown apply identically.
    const r = await poller.generateAiReport(String(b.coin || ""), aiWho(req, reply));
    const capped = r.error === "cooldown" || r.error === "daily-cap" || r.error === "user-day-cap" || r.error === "user-month-cap";
    return reply.code(r.ok ? 200 : (capped ? 429 : 400)).send(r);
  });
  // Admin reset of the AI report daily budget. Triggered from the ask terminal
  // (`admin reset-reports <password>`); the password is compared server-side against
  // ADMIN_PASSWORD only — never logged, never stored, never echoed. Fails closed (503)
  // when the env var is unset; a sliding-window failure lockout maps to 429.
  // 8 KB body cap — the payload is just { password }; anything larger is malformed or hostile (413).
  fastify.post("/api/ai-reset", { bodyLimit: 8 * 1024 }, async (req, reply) => {
    reply.header("cache-control", "no-store");
    const r = poller.resetAiDay(String((req.body || {}).password || ""));
    return reply.code(r.ok ? 200 : (r.error === "rate" ? 429 : r.error === "not-configured" ? 503 : 403)).send(r);
  });
  // Admin AI unlock: verify ADMIN_PASSWORD (same constant-time compare + shared lockout as the
  // budget reset), then mint the xyzai unlock cookie. This is the ONLY way to open AI generation;
  // there is no header/script path. Body is just { password } — 8 KB cap like the reset route.
  fastify.post("/api/ai-unlock", { bodyLimit: 8 * 1024 }, async (req, reply) => {
    reply.header("cache-control", "no-store");
    const r = poller.checkAdminPassword(String((req.body || {}).password || ""));
    if (!r.ok) return reply.code(r.error === "rate" ? 429 : r.error === "not-configured" ? 503 : 403).send(r);
    setAiUnlockCookie(reply, req, signAiUnlock(Date.now() + AI_UNLOCK_MS));
    // The terminal path is also an escalation path: someone who proves ADMIN_PASSWORD here gets the
    // admin view too, so `admin unlock` works identically to logging in with the admin password.
    setAdminCookies(reply, req, ADMIN_DAYS * 86400, signAdminView(Date.now() + ADMIN_DAYS * 864e5));
    return reply.code(200).send({ ok: true, ttlMs: AI_UNLOCK_MS, admin: true });
  });
  // Drop the unlock early (`admin lock`). No password needed to LOCK — locking never grants anything.
  fastify.post("/api/ai-lock", async (req, reply) => {
    reply.header("cache-control", "no-store");
    clearAiUnlockCookie(reply, req);
    return reply.code(200).send({ ok: true });
  });
  // UI hint: is the gate active, and does this caller currently hold a valid unlock? Lets the
  // terminal show the right lock state on open without exposing the HttpOnly cookie to page JS.
  fastify.get("/api/ai-status", (req, reply) => {
    reply.header("cache-control", "no-store");
    // gated:false now means "open with caps", not "no lock exists" — the client stops
    // prompting for a password on generation and shows the caller's own remaining budget.
    const admin = aiUnlockOk(getCookie(req, "xyzai")) || isAdmin(req);
    return Object.assign({ gated: false, unlocked: admin, admin: isAdmin(req) },
      poller.getAiQuota(ownerFor(req, reply), admin));
  });
  // Live GICS sectors with >=3 equity members — feeds the terminal's `report sector` command
  // and any picker UI. Cheap (curated classification over in-memory rows), session-gated.
  fastify.get("/api/ai-sectors", (req, reply) => {
    reply.header("cache-control", "no-store");
    return { ts: Date.now(), sectors: poller.listSectors() };
  });
  // Recent AI reports across all tickers — the Report tab's shared feed.
  fastify.get("/api/ai-reports", (req, reply) => {
    reply.header("cache-control", "no-store");
    return poller.listAiReports();
  });
  // Ask-the-board terminal, Tier-3 fallback. POST { q, ctx } — the client escalates here only
  // when its local grammar + NL layers can't resolve a question. Planner returns a grammar query
  // the CLIENT executes against its live rows (numbers stay the board's); analyst returns grounded
  // prose over the compact market bundle the client sends. Rate-limited + cached server-side.
  // 256 KB body cap — the client ships a compact ~160-name universe bundle here; a legitimate
  // payload is far under this, so the cap only catches oversized/abusive bodies (413).
  fastify.post("/api/ask", { bodyLimit: 256 * 1024 }, async (req, reply) => {
    reply.header("cache-control", "no-store");
    const b = req.body || {};
    return poller.askBoard(b.q || "", b.ctx || {}, aiWho(req, reply));
  });
  // On-demand external fundamentals for the ask terminal. Both endpoints are pull-through
  // caches over SEC EDGAR (24h TTL, 5-min error TTL) — the first ask for a name does the
  // round trip, everyone after reads the cache. Symbols are validated in the poller; an
  // unknown or non-fund symbol returns an honest { ok:false, error } the card renders as-is.
  fastify.get("/api/fund/:t", async (req, reply) => {
    reply.header("cache-control", "no-store");
    return poller.fundamentals(req.params.t || "");
  });
  fastify.get("/api/etf/:t", async (req, reply) => {
    reply.header("cache-control", "no-store");
    return poller.etfHoldings(req.params.t || "");
  });
  // ===== SSE version push (build 2026.07.29-07, Phase 2 of the perf batch) =====================
  // Pushes VERSIONS, never payloads: `{dataTs, alertVer, v}` on content-clock or alert-seq change.
  // The client reacts by running the exact snapshot fetch it already runs — which lands on the warm
  // serialize/gzip memos — so this changes WHEN clients pull, never WHAT they pull, and the one-
  // code-path contract is untouched. Alert latency drops from poll-cadence to ~1s; idle clients
  // during off-hours (frozen content clock) cost heartbeats only.
  //
  // Direct messages ride the SAME contract (build 2026.08.30-46). A send pushes `{dm:{seq}}` to the
  // two participants' connections ONLY, and they answer it with an ordinary /api/dm/sync pull. The
  // message body never travels on the stream, so a dropped frame loses nothing: the client's cursor
  // is authoritative and the next pull picks up whatever was missed. That is also why there is no
  // WebSocket here — sends are POSTs, and one-directional notification is all the stream owes us.
  //
  // The change detector is a 1s unref'd watcher over the SAME snapshotCache object clients fetch,
  // deliberately NOT an emitter threaded through poller.js: buildSnapshot has many call sites, a
  // missed one would be a silent latency regression, and a property read per second is free. The
  // worst-case extra second is invisible next to the poll interval it replaces.
  // Streams are hijacked from Fastify's pipeline (compress/onSend never touch them), so the
  // baseline security headers are written by hand here. Connection cap prevents fd exhaustion —
  // client #201 gets a 503 and its EventSource retry keeps it on the poll fallback, fully served.
  const sseClients = new Set();          // entries: { res, uid }
  const sseByUid = new Map();            // uid -> Set(entry), for targeted delivery
  const SSE_MAX = 200;
  // A per-member cap on top of the global one: without it a single person with a wall of tabs open
  // can eat the whole pool and lock everybody else onto the poll fallback.
  const SSE_PER_USER = 4;
  function sseAttach(entry) {
    sseClients.add(entry);
    if (!entry.uid) return;
    let set = sseByUid.get(entry.uid);
    if (!set) { set = new Set(); sseByUid.set(entry.uid, set); }
    set.add(entry);
  }
  function sseDetach(entry) {
    sseClients.delete(entry);
    const set = entry.uid && sseByUid.get(entry.uid);
    if (set) { set.delete(entry); if (!set.size) sseByUid.delete(entry.uid); }
  }
  // Presence, deliberately in memory and nowhere else: a live stream IS the signal, so there is
  // nothing to persist, nothing to expire, and nothing to be wrong across a restart.
  const dmOnline = () => new Set(sseByUid.keys());
  function sseFrame() {
    const s = poller.getSnapshot();
    return "data: " + JSON.stringify({ dataTs: s ? s.dataTs : 0, alertVer: s ? s.alertVer : 0, v: VERSION }) + "\n\n";
  }
  // The connect frame is the version frame plus the caller's OWN dm cursor, so a tab that slept
  // through a conversation catches up on its first byte instead of waiting for the next send.
  function sseHelloFrame(me) {
    const s = poller.getSnapshot();
    return "data: " + JSON.stringify({ dataTs: s ? s.dataTs : 0, alertVer: s ? s.alertVer : 0,
      v: VERSION, dm: me ? { seq: ACCOUNTS.stats().messages } : undefined }) + "\n\n";
  }
  const sseWrite = (entry, frame) => { try { entry.res.write(frame); } catch (_) {} };
  let sseLastTs = -1, sseLastAlert = -1;
  setInterval(() => {
    if (!sseClients.size) return;
    const s = poller.getSnapshot();
    const ts = s ? s.dataTs : 0, av = s ? (s.alertVer || 0) : 0;
    if (ts === sseLastTs && av === sseLastAlert) return;
    sseLastTs = ts; sseLastAlert = av;
    const frame = sseFrame();
    for (const e of sseClients) sseWrite(e, frame);
  }, 1000).unref();
  // One shared heartbeat, comment frames only: keeps proxies (Railway's edge included) from
  // reaping quiet streams, which off-hours streams otherwise always are.
  setInterval(() => {
    for (const e of sseClients) sseWrite(e, ": hb\n\n");
  }, 25000).unref();

  // Wake exactly the two people in a conversation. Everyone else's stream is untouched — a DM is
  // not an event the group is entitled to know happened.
  // `extra` lets an ephemeral hint (typing) ride the same targeted fan-out a send uses, rather
  // than opening a second channel with its own delivery story.
  function dmPoke(threadId, extra) {
    const peers = ACCOUNTS.threadPeers(threadId);
    if (!peers.length) return;
    const frame = "data: " + JSON.stringify({ dm: Object.assign({ seq: ACCOUNTS.stats().messages }, extra || {}) }) + "\n\n";
    for (const uid of peers) {
      const set = sseByUid.get(uid);
      if (set) for (const e of set) sseWrite(e, frame);
    }
  }

  fastify.get("/api/events", (req, reply) => {
    if (sseClients.size >= SSE_MAX) { reply.code(503).send({ error: "sse-full" }); return; }
    const me = meOf(req);
    if (me && (sseByUid.get(me.uid) || { size: 0 }).size >= SSE_PER_USER) {
      reply.code(503).send({ error: "sse-per-user-full" }); return;
    }
    reply.hijack();
    const res = reply.raw;
    res.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
      "connection": "keep-alive",
      "x-accel-buffering": "no",
      "x-content-type-options": "nosniff",
      "x-frame-options": "DENY",
      "referrer-policy": "same-origin",
    });
    // Identity is resolved ONCE, at connect. A session that expires mid-stream keeps delivering to
    // that connection until it drops, which is the same lifetime the browser tab already has.
    const entry = { res, uid: me ? me.uid : "" };
    // Initial frame on connect: the client syncs immediately instead of waiting for the first
    // change — and a reconnect after a missed deploy sees the new `v` on its first byte.
    try { res.write(sseHelloFrame(me)); } catch (_) {}
    sseAttach(entry);
    const drop = () => { sseDetach(entry); try { res.end(); } catch (_) {} };
    req.raw.on("close", drop);
    req.raw.on("error", drop);
  });

  // ===== offline escalation to Telegram ==========================================================
  // A DM to somebody with no live stream, still unread after DM_ESCALATE_MS, goes to their linked
  // Telegram as ONE digest per sender rather than one push per message. It reuses the outbox that
  // already exists — recipients, hourly caps and quiet hours all apply without a line of new
  // delivery code. Muted threads never escalate, and opening the terminal before the delay elapses
  // cancels it, because by then the member is online and the sweep skips them.
  setInterval(() => {
    if (!poller.pushEnqueueNow) return;
    let pending;
    try { pending = ACCOUNTS.pendingEscalations(DM_ESCALATE_MS, (uid) => sseByUid.has(uid)); }
    catch (e) { log("dm escalation sweep failed (isolated): " + (e && e.message)); return; }
    if (!pending.length) return;
    for (const p of pending) {
      // Their own recipients only. `owner` on a recipient IS the uid, which is the whole point of
      // reusing the xyzown handle as the account id.
      const targets = poller.pushRecipientsFor ? poller.pushRecipientsFor(p.uid) : [];
      if (targets.length) {
        const head = `<b>${tgEsc(p.from)}</b>${p.kind === "group" ? " (group)" : ""} · ${p.n} unread message${p.n === 1 ? "" : "s"}`;
        const body = p.lines.map((l) => "“" + tgEsc(l) + "”").join("\n");
        for (const chat of targets) {
          poller.pushEnqueueNow(chat, head + "\n" + body + "\n<i>Reply with /r your message.</i>");
          // Remember what this chat was last told about, so a bare `/r` has something to answer.
          dmReplyTarget.set(String(chat), { thread: p.thread, at: Date.now() });
        }
      }
      // Marked either way. With no Telegram linked there is nothing to send, and leaving it
      // unmarked would re-scan the same backlog every tick forever.
      ACCOUNTS.markEscalated(p.uid, p.thread, p.upTo);
    }
  }, 60 * 1000).unref();
  // Telegram sends with parse_mode HTML, so a message body is untrusted markup on that wire exactly
  // as it is in the browser. Escaped here, at the boundary, never stored escaped.
  const tgEsc = (x) => String(x == null ? "" : x)
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

  fastify.get("/api/health", () => ({ ok: true, version: VERSION, volume: { boots: HEARTBEAT.boots, firstBoot: HEARTBEAT.firstBoot, dataDir: DATA_DIR },
    // Live histogram read (current, still-open window) + the closed-window ring + worst-ever. The
    // live sample makes a stall visible within seconds of happening; the ring is the 7d evidence
    // trail the worker-thread decision gate reads. ~30 small numbers — negligible on the wire.
    loop: { ...loopSample(), sinceMs: Date.now() - loopResetAt, windowMs: LOOP_WINDOW, maxEver: loopMaxEver, hist: loopRing },
    ...poller.stats(), ts: Date.now() }));

  await fastify.listen({ port: PORT, host: HOST });
  log(`Listening on ${HOST}:${PORT} (dex=${DEX}, data=${DATA_DIR}, build=${VERSION})`);
  poller.start().catch((e) => log("poller start error: " + (e && e.message)));
}

main().catch((e) => { console.error(e); process.exit(1); });

// Graceful stop: flush EVERYTHING that persists on a timer, not just features + ledger — the
// hourly spine (10-min cadence), trigger dedupe state, and push recipients were previously left
// to whatever their last interval wrote. Railway's SIGTERM grace window is ample for the awaited
// spine stream; the guard makes a second signal during the flush a no-op instead of a re-entry.
let shuttingDown = false;
async function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  try { poller.persistFeatures(); } catch (_) {}
  try { poller.persistLedger(); } catch (_) {}
  try { poller.persistTriggers(); } catch (_) {}
  try { poller.persistPush(); } catch (_) {}
  try { await poller.persistHourly(); } catch (_) {}
  // Fold the still-open loop window into the ring before persisting: Railway redeploys arrive on
  // push cadence, often < 6h apart, and without this the ring would never accumulate a point.
  try { rollLoopWindow(); } catch (_) {}
  // Close every SSE stream: their EventSource auto-reconnects to the NEW build and receives the
  // fresh `v` in the initial frame — the push channel doubles as the fastest deploy notice.
  try { for (const res of sseClients) { try { res.end(); } catch (_) {} } sseClients.clear(); } catch (_) {}
  try { store.close(); } catch (_) {}
  process.exit(0);
}
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);

// Crash containment: Node >= 15 hard-crashes the process on ANY unhandled rejection, and with
// timer-cadence persistence a bare crash can drop up to 10 min of spine plus the buffered deriv
// appends. Keep the crash-by-default semantics (a rejection that escaped every isolated catch is
// a bug, and Railway restarts us) but spend the last moment on synchronous flushes — store.close()
// drains the append buffers and closes SQLite cleanly. No awaits here: the process is in an
// undefined state and the sync path must not depend on a live event loop.
function crashFlush(kind, err) {
  if (shuttingDown) return;
  shuttingDown = true;
  try { console.error(`[crash] ${kind}: ${(err && err.stack) || err}`); } catch (_) {}
  try { poller.persistFeatures(); } catch (_) {}
  try { poller.persistLedger(); } catch (_) {}
  try { poller.persistTriggers(); } catch (_) {}
  try { poller.persistPush(); } catch (_) {}
  try { persistLoopSync(); } catch (_) {}
  try { store.close(); } catch (_) {}
  process.exit(1);
}
process.on("unhandledRejection", (e) => crashFlush("unhandledRejection", e));
process.on("uncaughtException", (e) => crashFlush("uncaughtException", e));
