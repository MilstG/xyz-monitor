"use strict";
const path = require("path");
const fs = require("fs");
const crypto = require("crypto");
const zlib = require("zlib");
const gzipAsync = require("util").promisify(zlib.gzip);   // -08: threadpool gzip for the cached-serve path
const Fastify = require("fastify");
const { openStore } = require("./src/store");
const { createUsageGate } = require("./src/usage-gate");
const { createPoller } = require("./src/poller");
const { openAccounts, PW_MIN: ACCOUNT_PW_MIN, DM_MAX_LEN: ACCOUNT_DM_MAX,
  FILE_MAX: ACCOUNT_DM_FILE_MAX } = require("./src/accounts");
const { featureGateFor, resolveFeatures, featureVisible, parseAlertCmd, ALERT_HELP, RULE_OP_LABEL, validateCard, cardText, tgReactOut, tgReactIn } = require("./src/compute");

// Build stamp. Bumped on every delivery; shipped in /api/health, the snapshot payload and
// the UI status line — one glance answers "is the live site actually running this build?"
// (most historical "it doesn't work" reports were stale deploys, not bugs).
const VERSION = "2026.09.24-112";
// (build 2026.09.24-107) Distinguishes this process from the last one in ETags built on
// per-process counters (a restart must never 304 a client onto a different body).
const BOOT_NONCE = Date.now().toString(36) + crypto.randomBytes(3).toString("hex");

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
// Session-signing secret for the LEGACY shared-password door: see the derivation next to ACCOUNTS
// below. It still folds the password in, so changing the password on Railway invalidates every
// outstanding legacy session with zero extra config, while plain restarts keep everyone logged in.
let SESSION_SECRET = null;
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
// Derived next to ACCOUNTS below, from the random on-disk key — never from the password alone.
let OWNER_SECRET = null;
// The pre-accounts derivation. Still ACCEPTED on verify (never used to sign) while a real password
// exists, so nobody's alert-owner handle changes underneath their linked recipients; with no
// password it is a public constant and must not verify anything.
const OWNER_SECRET_LEGACY = SITE_PASSWORD
  ? crypto.createHash("sha256").update(`xyzmon-alert-owner|${SITE_USER}|${SITE_PASSWORD}`).digest() : null;
function signOwnerWith(secret, id) {
  return id + "." + crypto.createHmac("sha256", secret).update("own|" + id).digest("base64url");
}
function signOwner(id) { return signOwnerWith(OWNER_SECRET, id); }
// The id half must have the shape ensureOwner mints (randomBytes(12).base64url = 16 chars).
// The legacy MAC key is derived from SITE_PASSWORD, which every shared-password member knows, so
// without this a member could sign ANY id — and redeem/claim adopt the prior id as the account
// uid. accounts.js re-checks the same shape (adoptableUid); this is the outer wall.
const OWNER_ID_RE = /^[A-Za-z0-9_-]{12,32}$/;
function ownerOf(tok) {
  if (!tok || typeof tok !== "string" || tok.length > 128) return null;
  const i = tok.indexOf(".");
  if (i <= 0) return null;
  const id = tok.slice(0, i);
  if (!OWNER_ID_RE.test(id)) return null;
  const got = Buffer.from(tok);
  for (const secret of [OWNER_SECRET, OWNER_SECRET_LEGACY]) {
    if (!secret) continue;
    try {
      const want = Buffer.from(signOwnerWith(secret, id));
      if (want.length === got.length && crypto.timingSafeEqual(want, got)) return id;
    } catch (_) {}
  }
  return null;
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
// Both admin-cookie keys are derived NEXT TO ACCOUNTS below (HMAC of the on-disk random secret
// with the label `xyzmon-ai-unlock|<password>`), not sha256 of the password alone: the old
// derivation had no random material, so a captured cookie was an offline dictionary attack on
// ADMIN_PASSWORD — every candidate password gives a candidate key, and one HMAC check per
// candidate tells you when you have it. Rotate-to-revoke is unchanged (the password is still in
// the label); what changed is that the label alone no longer determines the key.
let AI_UNLOCK_SECRET = null;
const AI_UNLOCK_MS = 24 * 3600 * 1000;   // hard ceiling on an unlock's life, even if the browser restores its session
// Admin VIEW is a separate, longer lease than the AI unlock above, and deliberately so: seeing the
// admin tabs costs nothing, while generating a report spends real OpenAI budget. Merging them would
// force one of the two to be wrong — either you re-authenticate to look at a table, or a 30-day
// cookie can spend money. So: xyzadm = 30d admin view, xyzai = browser-session AI spend, both
// derived from ADMIN_PASSWORD (rotate it and every outstanding token of BOTH kinds dies).
// The label in the secret differs from the AI one on purpose — with a shared secret an xyzai token
// would validate as xyzadm and the short lease would silently become a long one.
let ADMIN_VIEW_SECRET = null;   // `xyzmon-admin-view|<password>` label, derived below with the AI one
const ADMIN_DAYS = Number(process.env.ADMIN_DAYS || 30);

// XYZ_QUIET silences the boot narration when server.js is built by the test suite.
function log(msg) { if (!process.env.XYZ_QUIET) console.log(new Date().toISOString() + " " + msg); }

// Say the dangerous defaults out loud once. Nothing here exits: a deploy that boots with a
// warning beats one that dies on a variable the operator meant to set later, and the volume
// heartbeat below already makes an ephemeral DATA_DIR self-evident on the second boot.
{
  const onRailway = !!process.env.RAILWAY_ENVIRONMENT;
  const warn = [];
  if (!process.env.DATA_DIR) warn.push("DATA_DIR is unset — data lives in ./data inside the container" + (onRailway ? " and WILL NOT survive a redeploy: point it at the volume mount" : ""));
  if (!SITE_PASSWORD) warn.push("SITE_PASSWORD is unset — the site is open to anyone with the URL; AI routes and /claim stay closed");
  if (!process.env.SEC_CONTACT) warn.push("SEC_CONTACT is unset — SEC requests go out with a placeholder contact, which their fair-access policy may block");
  for (const w of warn) log("WARNING: " + w);
}
const store = openStore(DATA_DIR);
// ---- accounts, invites and direct messages --------------------------------------------------
// Its own SQLite file on the same volume. Deliberately separate from the market caches: none of
// this is market data, none of it is on the 15s path, and all of it wants transactions rather
// than the whole-file tmp+rename discipline the JSON caches use.
const ACCOUNTS = openAccounts(DATA_DIR, { sessionDays: SESSION_DAYS });
// (build 2026.09.24-110 follow-up) This deployment serves VERSION: it joins the short known-builds
// list (the current build + the 3 before it) a usage beacon's build stamp is checked against.
try { ACCOUNTS.usageBuildSeen(VERSION); } catch (_) {}
// The legacy-door secrets, keyed by the accounts' random secret so they are never guessable. The
// old derivation hashed `xyzmon-session|user|password` directly: with SITE_PASSWORD unset (the
// documented open posture) that was a constant anyone could recompute, and a forged legacy token
// satisfied sessionOk at /claim (mint an account — the first one admin) and the AI-cost gate.
SESSION_SECRET = process.env.SESSION_SECRET
  ? crypto.createHash("sha256").update(String(process.env.SESSION_SECRET)).digest()
  : ACCOUNTS.deriveKey(`legacy-session|${SITE_USER}|${SITE_PASSWORD}`);
OWNER_SECRET = ACCOUNTS.deriveKey("alert-owner");
AI_UNLOCK_SECRET = ACCOUNTS.deriveKey(`xyzmon-ai-unlock|${ADMIN_PASSWORD}`);
ADMIN_VIEW_SECRET = ACCOUNTS.deriveKey(`xyzmon-admin-view|${ADMIN_PASSWORD}`);
// How long a DM sits unread before it is worth interrupting somebody's evening over. The delay IS
// the feature: without it two people typing at each other generate a push per line.
const DM_ESCALATE_MS = Number(process.env.DM_ESCALATE_MS || 5 * 60 * 1000);
// The legacy shared-password door. Once accounts exist it stays open only while the operator is
// still migrating people, and it lands them on the claim page rather than straight into the app.
// No shared password means no shared-password door: with SITE_PASSWORD empty, credsOk and the
// legacy token would otherwise both accept a caller who knows nothing.
const LEGACY_DOOR = !!SITE_PASSWORD && process.env.LEGACY_SHARED_PASSWORD !== "0";
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
// Built in main(), after the OI log has streamed in (store.preloadOI): its constructor is
// synchronous and used to read the whole year-long log with readFileSync on the event loop.
let poller = null;
// The live SSE registry, exposed by buildServer so shutdown can close every stream. Block-scoped
// inside buildServer before this, which made the shutdown loop a swallowed ReferenceError: streams
// were never closed on SIGTERM and the deploy notice they carry never went out.
let SSE_REGISTRY = null;
let USAGE_SWEEP = null;   // (build 2026.09.24-110 follow-up) buildServer's usage sweep, for main() and shutdown
let USAGE_REGRESS = null;   // (build 2026.09.24-111) buildServer's post-deploy regression check, for main()'s 60s flush

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
//
// Byte-bounded LRU (build 2026.09.24-102). The cap used to be 800 ENTRIES with insertion-order
// eviction, whatever their size — 800 deep-candle payloads is hundreds of MB — and each entry held
// the built object while the WeakMap memos held its string and gzip Buffer beside it. An entry is
// now just what is served: the serialized string (built once, the object is then dropped) and its
// gzip Buffer once compressed, both counted against KEYED_MAX_BYTES; a hit moves the entry to the
// most-recent end; eviction takes the least-recently used until both caps hold. An optional `slot`
// names the payload a key is a VERSION of (one chart, one coin's series): a new version replaces
// the previous one instead of piling up next to it — the tf-candle key folds a ~0.1% price bucket
// (the forming bar's live close) and would otherwise mint a fresh entry on every small move.
const KEYED_MAX_BYTES = 64 * 1024 * 1024, KEYED_MAX_ENTRIES = 800;
function makeKeyedCache(maxBytes, maxEntries) {
  const map = new Map(), slots = new Map();   // key -> { key, s, gz, bytes, slot, live }; slot -> key
  let bytes = 0;
  const drop = (k) => {
    const e = map.get(k); if (!e) return;
    map.delete(k); bytes -= e.bytes; e.live = false;
    if (e.slot != null && slots.get(e.slot) === k) slots.delete(e.slot);
  };
  const evict = () => { for (const k of map.keys()) { if (bytes <= maxBytes && map.size <= maxEntries) break; drop(k); } };
  return {
    get(k) { const e = map.get(k); if (e) { map.delete(k); map.set(k, e); } return e; },   // LRU touch
    put(k, s, slot) {
      drop(k);
      if (slot != null) { const prev = slots.get(slot); if (prev !== undefined) drop(prev); slots.set(slot, k); }
      const e = { key: k, s, gz: null, bytes: s.length, slot: slot == null ? null : slot, live: true };
      map.set(k, e); bytes += e.bytes; evict();
      return e;
    },
    // The compressed Buffer joins the entry's account when it lands (if the entry is still live).
    addGz(e, buf) { e.gz = buf; if (e.live && map.get(e.key) === e) { e.bytes += buf.length; bytes += buf.length; evict(); } },
    stats: () => ({ entries: map.size, bytes, slots: slots.size }),
    keys: () => [...map.keys()],
  };
}
const keyedCache = makeKeyedCache(KEYED_MAX_BYTES, KEYED_MAX_ENTRIES);
function serveKeyed(req, reply, etagKey, build, fallback, slot) {
  const tag = 'W/"' + etagKey + '"';
  if (req.headers["if-none-match"] === tag) { reply.header("etag", tag).header("cache-control", "no-cache").code(304).send(); return; }
  let e = keyedCache.get(etagKey);
  if (e === undefined) e = keyedCache.put(etagKey, JSON.stringify(build() || fallback), slot);
  // Same response as sendCachedBody gives for the object: headers, the >=1KB gzip rule, threadpool
  // compression shared by concurrent first requests, then the Buffer on the synchronous path.
  reply.header("cache-control", "no-cache");
  reply.header("etag", tag);
  reply.header("content-type", "application/json; charset=utf-8");
  if (e.s.length >= 1024 && /\bgzip\b/.test(req.headers["accept-encoding"] || "")) {
    let gz = e.gz;
    if (gz === null) { const ent = e; gz = e.gz = gzipAsync(e.s).then((buf) => { keyedCache.addGz(ent, buf); return buf; }); }
    reply.header("content-encoding", "gzip");
    reply.header("vary", "accept-encoding");
    return Buffer.isBuffer(gz) ? reply.send(gz) : gz.then((buf) => reply.send(buf));
  }
  return reply.send(e.s);
}

// SSE write with backpressure (build 2026.09.24-101). Every frame used to be written blind: a
// client that stopped reading (a phone asleep on a half-dead connection, a stalled proxy) kept its
// socket "open" while Node buffered every snapshot poke, DM and heartbeat for it in memory, without
// bound, for as long as the TCP connection lingered. Now a stream whose unflushed buffer is past
// SSE_MAX_BUFFERED is dropped — detached and destroyed; EventSource reconnects on its own and the
// hello frame resyncs it — and a destroyed or ended socket is detached instead of written to.
// Returns true when the frame was queued.
const SSE_MAX_BUFFERED = 64 * 1024;
function sseWriteTo(entry, frame, detach) {
  const res = entry && entry.res;
  if (!res || res.destroyed || res.writableEnded) { if (detach) detach(entry); return false; }
  if ((res.writableLength || 0) > SSE_MAX_BUFFERED) {
    if (detach) detach(entry);
    try { res.destroy(); } catch (_) {}
    return false;
  }
  try { res.write(frame); return true; } catch (_) { return false; }
}

// Constant-time credential check: hash both sides to equal length, then timingSafeEqual.
// Plain === leaks match length/position through response timing; hashing first also makes
// the comparison safe for unequal-length inputs (timingSafeEqual throws on those).
const sha = (s) => crypto.createHash("sha256").update(String(s)).digest();
function credsOk(u, p) {
  if (!SITE_PASSWORD) return false;   // an empty password is "no password", never "any password"
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
  const secure = ((TRUST_PROXY && req.headers["x-forwarded-proto"]) || req.protocol) === "https" ? "; Secure" : "";
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
  const secure = ((TRUST_PROXY && req.headers["x-forwarded-proto"]) || req.protocol) === "https" ? "; Secure" : "";
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
// Two token shapes share the cookie:
//   break-glass  "<exp>.<mac>"                 minted by the ADMIN_PASSWORD login / `admin unlock`
//   account      "<uid>.<epoch>.<exp>.<mac>"   minted at sign-in for a flagged account
// The account form is BOUND to the account: verifying it re-reads the live user row and requires
// enabled + isAdmin + the same epoch. Before this the cookie was signed over the expiry alone, so
// a demoted or disabled admin kept /api/access and the DM read-through for up to ADMIN_DAYS, with
// audit rows attributed to "legacy-admin". The break-glass form stays uid-less on purpose: it is
// how an operator gets back in after locking themselves out of their own account.
function signAdminView(expMs, uid, epoch) {
  if (uid != null) return uid + "." + epoch + "." + expMs + "." + crypto.createHmac("sha256", ADMIN_VIEW_SECRET)
    .update("adm|" + uid + "|" + epoch + "|" + expMs).digest("base64url");
  return expMs + "." + crypto.createHmac("sha256", ADMIN_VIEW_SECRET).update("adm|" + expMs).digest("base64url");
}
function adminViewOk(tok) {
  if (!ADMIN_PASSWORD || !tok || tok.length > 256) return false;   // unset admin password => fail closed
  const p = tok.split(".");
  if (p.length !== 2 && p.length !== 4) return false;
  const exp = Number(p[p.length - 2]);
  if (!Number.isFinite(exp) || exp < Date.now()) return false;
  let want;
  if (p.length === 4) {
    const u = ACCOUNTS.getUser(p[0]);
    if (!u || !u.isAdmin || u.disabledAt || String(u.epoch) !== p[1]) return false;
    want = signAdminView(exp, p[0], p[1]);
  } else want = signAdminView(exp);
  const a = Buffer.from(tok), b = Buffer.from(want);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}
// Who an admin cookie speaks for: the account uid for the bound form, null for break-glass.
function adminViewUid(tok) {
  if (!adminViewOk(tok)) return null;
  const p = String(tok).split(".");
  return p.length === 4 ? p[0] : null;
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

// The IP a rate limiter may key on. X-Forwarded-For is client-writable except for the LAST
// element, which the edge proxy in front of this service appends itself — taking the first
// element (the old behavior) let any caller mint a fresh key per request and walk straight
// past every damper below. ASSUMPTION, stated: TRUST_PROXY=1 means exactly one trusted proxy
// sits in front and it APPENDS its own element (Railway's edge does). Behind two proxies the
// last element is the inner proxy's address and every caller shares one damper key — set
// TRUST_PROXY=0 and key on the socket, or terminate at a single edge.
// Behind Railway's edge the forwarded headers are trustworthy and the socket peer is the proxy;
// exposed directly they are whatever the client typed. TRUST_PROXY=0 switches both the client-IP
// damper key and the Secure-cookie decision to the socket's own view.
const TRUST_PROXY = process.env.TRUST_PROXY !== "0";
function clientIp(req) {
  const xff = TRUST_PROXY ? String(req.headers["x-forwarded-for"] || "").split(",").pop().trim() : "";
  return xff || String(req.ip || "");
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
  // Size cap: evict the OLDEST half rather than clear() — a spoofed-IP flood used to wipe every
  // live lockout the moment it filled the table, which made the flood itself the way past the
  // damper. A Map iterates in insertion order; the delete+set below moves a re-offending IP to
  // the young end, so "oldest" means least recently failed, not first ever seen.
  if (loginFails.size > 5000) { let i = 0; for (const k of loginFails.keys()) { loginFails.delete(k); if (++i >= 2500) break; } }
  const e = loginFails.get(ip) || { n: 0, until: 0 };
  e.n++;
  if (e.n >= LOCK_AFTER) { e.until = Date.now() + LOCK_MS; e.n = 0; }
  loginFails.delete(ip); loginFails.set(ip, e);
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
// ===== Content-Security-Policy, report-only ====================================================
// Every HTML page the server emits carries a per-request nonce on its inline scripts and a
// Content-Security-Policy-Report-Only header naming that nonce. Report-only on purpose: the client
// renders through innerHTML in hundreds of places and members type prose into notes and messages,
// so the policy is worth having, but an enforcing header that broke one chart would cost more than
// it protected. Violations post to /api/csp-report, are counted on /api/health, and the log says
// what fired — the operator flips to enforcing once the report stays quiet. The nonce is stamped in
// the onSend hook, so a page author only has to write the slot into a <script> tag.
const CSP_NONCE_SLOT = "{{csp-nonce}}";
// CSP_ENFORCE=1 flips the same policy from report-only to enforced. Report-only stays the default
// because the client's surface is large (23 tabs, chart rasters, blob workers) and the operator
// should watch /api/health's csp ledger stay at zero through a few days of real use before turning
// a violation from a diagnostic into a broken page. The policy text is shared, so what was
// observed clean under report-only is exactly what enforcement blocks.
const CSP_ENFORCE = String(process.env.CSP_ENFORCE || "0") === "1";
const CSP_HEADER = CSP_ENFORCE ? "content-security-policy" : "content-security-policy-report-only";
const cspPolicy = (nonce) => [
  "default-src 'self'",
  `script-src 'self' 'nonce-${nonce}'`,
  "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",   // style="" attributes are everywhere in the client's templates
  "font-src 'self' https://fonts.gstatic.com data:",
  "img-src 'self' data: blob: https:",                                // tweet-card avatars and chart rasters
  "connect-src 'self'",
  "worker-src 'self'", "manifest-src 'self'",
  "object-src 'none'", "base-uri 'self'", "form-action 'self'", "frame-ancestors 'none'",
  "report-uri /api/csp-report", "report-to csp",
].join("; ");
// Violation ledger: a count and the last few distinct (directive, blocked) pairs. Memory only —
// a report is a diagnostic, and a deploy that clears it is a deploy that may have fixed it.
const CSP_REPORTS = { n: 0, dropped: 0, recent: [], minute: 0, inMinute: 0, lastLog: 0 };
function cspRecord(body) {
  const items = Array.isArray(body) ? body.map((r) => r && r.body).filter(Boolean)
    : body && body["csp-report"] ? [body["csp-report"]] : body && typeof body === "object" ? [body] : [];
  const min = Math.floor(Date.now() / 60000);
  if (min !== CSP_REPORTS.minute) { CSP_REPORTS.minute = min; CSP_REPORTS.inMinute = 0; }
  for (const r of items) {
    if (++CSP_REPORTS.inMinute > 120) { CSP_REPORTS.dropped++; continue; }   // a page in a loop is not 10k log lines
    const directive = String(r["effective-directive"] || r.effectiveDirective || r["violated-directive"] || r.violatedDirective || "?").slice(0, 60);
    const blocked = String(r["blocked-uri"] || r.blockedURL || r.blockedURI || "").slice(0, 160);
    const source = String(r["source-file"] || r.sourceFile || "").slice(0, 160);
    const line = Number(r["line-number"] || r.lineNumber) || 0;
    CSP_REPORTS.n++;
    const key = directive + "|" + blocked + "|" + source + "|" + line;
    const seen = CSP_REPORTS.recent.find((x) => x.key === key);
    if (seen) { seen.n++; seen.t = Date.now(); }
    else { CSP_REPORTS.recent.unshift({ key, directive, blocked, source, line, n: 1, t: Date.now() }); CSP_REPORTS.recent.length = Math.min(CSP_REPORTS.recent.length, 20); }
    if (Date.now() - CSP_REPORTS.lastLog > 60000) { CSP_REPORTS.lastLog = Date.now(); log(`CSP report: ${directive} blocked ${blocked || "(inline)"} at ${source || "?"}:${line}`); }
  }
}

// JSON destined for the inside of an inline <script>. JSON.stringify is not HTML-safe: a string
// value holding "</script>" ends the block early and whatever follows runs as markup — a ?next=
// path on the login page, a renamed display name in the shell's window.__ME. The escapes are
// valid JSON (the browser parses them back to the same characters), so the page reads exactly
// what the server meant; U+2028/9 are line terminators in older engines and get the same care.
// Every JSON.stringify whose output lands in HTML goes through this — grep before adding one.
function jsonForScript(v) {
  return JSON.stringify(v).replace(/</g, "\\u003c").replace(/>/g, "\\u003e").replace(/&/g, "\\u0026")
    .replace(/\u2028/g, "\\u2028").replace(/\u2029/g, "\\u2029");
}
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
'<link rel="icon" href="/icon.svg" type="image/svg+xml">' +
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
'<script nonce="' + CSP_NONCE_SLOT + '">' + AUTH_JS + '</script>' +
'<script nonce="' + CSP_NONCE_SLOT + '">window.__AUTH=' + jsonForScript({ action, mode, next: o.next || null }) + ';authInit();</script>' +
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
"if(c)body.code=c.value;if(A.next)body.next=A.next;" +
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

// buildServer() wires the poller and every route and returns the Fastify instance WITHOUT
// listening or starting the poller. main() is the process entry; the test suite requires this
// file as a module and drives buildServer() through fastify.inject(), which is the only way the
// auth gate, cookies and admin lease can be tested as behaviour rather than as source text.
async function buildServer() {
  {
    const t0 = Date.now();
    const n = await store.preloadOI();
    log(`OI log streamed in: ${n} sample(s) in ${Date.now() - t0}ms`);
  }
  // XYZ_NO_NET: the HTTP test suite builds this server without starting the poller, but a route can
  // still kick an on-demand fetch (the positions lane). Under the switch that fetch fails fast and
  // locally, so a test never reaches Hyperliquid and never waits on a timeout.
  const noNet = process.env.XYZ_NO_NET ? () => Promise.reject(new Error("outbound network disabled (XYZ_NO_NET)")) : undefined;
  poller = createPoller({ dex: DEX, store, log, version: VERSION, crypto: CRYPTO, posFetch: noNet });
  log(`Crypto (Hyperliquid main dex): ${CRYPTO ? "ENABLED — top-60 perps, 31d hourly / 90d daily retention" : "disabled via CRYPTO=0"}`);
  const fastify = Fastify({ logger: false });

  // Fastify's default 500 body echoes err.message — for a SQLite bind failure that is "Provided
  // value cannot be bound to SQLite parameter", i.e. which driver, which layer, and that the
  // query shape reached a statement. Every 5xx now answers one fixed shape with a random id that
  // is also written to the log, so the operator can find the stack from a screenshot without the
  // stack ever leaving the process. 4xx errors (body limits, unsupported media types, bad JSON)
  // keep Fastify's own shape: those messages are the contract the client reads.
  const { STATUS_CODES } = require("http");
  fastify.setErrorHandler((err, req, reply) => {
    reply.header("cache-control", "no-store");
    const sc = Number(err && err.statusCode) || 500;
    if (sc < 500) return reply.code(sc).send({ statusCode: sc, code: err.code, error: STATUS_CODES[sc], message: err.message });
    const id = crypto.randomBytes(6).toString("hex");
    log(`ERROR ${id} ${req.method} ${String(req.url || "").split("?")[0]}: ${(err && err.stack) || err}`);   // path only — never a query string
    return reply.code(sc).send({ error: "internal", id });
  });

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
    // Break-glass: the ADMIN_PASSWORD login mints a legacy token beside its admin lease, and that
    // lease is ADMIN_PASSWORD-derived (fail-closed when unset) — so it authenticates even with the
    // legacy door shut.
    if (adminViewOk(getCookie(req, "xyzadm"))) return true;
    const hdr = req.headers.authorization || "";
    const [scheme, enc] = hdr.split(" ");
    if (scheme === "Basic" && enc && SITE_PASSWORD) {
      // The same per-IP damper /login spends. Basic had none: the shared password could be
      // guessed at wire speed through any /api route, cookie-free, while the login page locked
      // after eight. A locked IP is refused without the compare; a wrong pair counts ONCE per
      // request however many hooks ask (the raw request carries the mark).
      const ip = clientIp(req);
      if (loginLockedFor(ip)) { req.raw.xyzBasicLocked = true; return false; }   // the site gate answers 429 to this mark
      const s = Buffer.from(enc, "base64").toString();
      const i = s.indexOf(":");
      if (i >= 0 && credsOk(s.slice(0, i), s.slice(i + 1))) { loginFails.delete(ip); return true; }
      if (!req.raw.xyzBasicCounted) { req.raw.xyzBasicCounted = true; loginFail(ip); }
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
  // The calls scoreboard's fixed horizons read the poller's daily spine; the desk digest reads
  // the member's own calls record. Both injected here — neither module reaches into the other.
  ACCOUNTS.setPxHistory((coin, atTs) => (poller.dailyCloseAt ? poller.dailyCloseAt(coin, atTs) : null));
  // Call targets (build 2026.09.24-95): a target's hit or stop is decided on the same 5-minute
  // archive the level scanner and the sweep detector read — injected, so accounts.js never opens it.
  ACCOUNTS.setBarSource((coin, from, to) => (store.readCandles ? store.readCandles(coin, from, to) : []));
  // The digest's record is the last 30 days of CLOSED calls; the board reads the lifetime.
  // (build 2026.09.24-110) A Telegram linked through /start CODE counts once for its account (usage funnel).
  if (poller.setPushLinkHook) poller.setPushLinkHook((owner) => ACCOUNTS.usageAct(owner, "telegram-link"));
  if (poller.setDeskSource) poller.setDeskSource((uid) => ACCOUNTS.calls(uid, { limit: 100, windowMs: 30 * 86400e3 }));

  // ---- tweet preview cards ---------------------------------------------------------------------
  // A message carrying an x.com/twitter.com status link gets a preview card: author, handle, text,
  // one click out. X's public oEmbed endpoint answers without any API key; ONE fetch per tweet id,
  // cached, fetched in the background — the message ships immediately and the thread is poked with
  // a refresh hint when the card lands. X's embed HTML is never stored and never rendered (it can
  // carry script): only the parsed fields travel, and the client escapes them like any body text.
  const { tweetLinkId, tweetFromOembed } = require("./src/compute");
  const tweetCache = new Map();           // tweet id -> { ok, at, pub? }
  const tweetInflight = new Set();
  const TWEET_RETRY_MS = 10 * 60e3, TWEET_CACHE_MAX = 500;
  async function tweetFetch(id, thread) {
    if (tweetInflight.has(id)) return;
    tweetInflight.add(id);
    try {
      const ctl = new AbortController();
      const to = setTimeout(() => ctl.abort(), 6000);
      let j = null;
      try {
        const r = await fetch("https://publish.twitter.com/oembed?omit_script=1&dnt=1&url="
          + encodeURIComponent("https://twitter.com/i/status/" + id),
          { signal: ctl.signal, headers: { accept: "application/json" } });
        if (r.ok) j = await r.json();
      } finally { clearTimeout(to); }
      const pub = j ? tweetFromOembed(j, id) : null;
      // Thumbnail, best-effort: the syndication endpoint is unauthenticated but undocumented, so
      // a failure here costs only the picture — the card still ships. Only a pbs.twimg.com https
      // URL is accepted; anything else in the answer is not an image we will point a client at.
      if (pub && pub.media) {
        try {
          const tok = ((Number(id) / 1e15) * Math.PI).toString(36).replace(/(0+|\.)/g, "");
          const c2 = new AbortController();
          const t2 = setTimeout(() => c2.abort(), 6000);
          try {
            const r2 = await fetch("https://cdn.syndication.twimg.com/tweet-result?id=" + id + "&lang=en&token=" + tok,
              { signal: c2.signal, headers: { accept: "application/json" } });
            if (r2.ok) {
              const j2 = await r2.json();
              const ph = (j2 && j2.photos && j2.photos[0] && j2.photos[0].url)
                || (j2 && j2.mediaDetails && j2.mediaDetails[0] && j2.mediaDetails[0].media_url_https) || "";
              if (/^https:\/\/pbs\.twimg\.com\//.test(String(ph)))
                pub.img = String(ph) + (String(ph).includes("?") ? "" : "?name=small");
            }
          } finally { clearTimeout(t2); }
        } catch (_) { /* no picture, still a card */ }
      }
      if (tweetCache.size > TWEET_CACHE_MAX) tweetCache.delete(tweetCache.keys().next().value);   // oldest out, not everything out: clear() refetched every good card at once
      tweetCache.set(id, pub ? { ok: true, at: Date.now(), pub } : { ok: false, at: Date.now() });
    } catch (_) { tweetCache.set(id, { ok: false, at: Date.now() }); }
    finally { tweetInflight.delete(id); }
    if (thread) dmPoke(thread, { refresh: Number(thread) });
  }
  ACCOUNTS.setTweetSource((body, thread) => {
    const id = tweetLinkId(body);
    if (!id) return null;
    const e = tweetCache.get(id);
    if (e && e.ok) return e.pub;
    if (e && Date.now() - e.at < TWEET_RETRY_MS) return { ok: false };
    tweetFetch(id, thread);              // background; the poke re-renders the thread when it lands
    return e ? { ok: false } : null;     // a stale failure keeps the honest stub while retrying
  });

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
  // ---- cross-site writes ------------------------------------------------------------------------
  // Every cookie here is SameSite=Lax, which already keeps a cross-site POST from carrying the
  // session. This is the second lock: a browser that says the request came from another site
  // (Sec-Fetch-Site: cross-site) gets 403 on any state-changing verb before a handler runs,
  // whatever cookies it managed to attach. Reads are untouched; browsers that predate the header
  // send nothing and fall through to the cookie rule; scripts and curl send nothing either.
  // Registered first so it runs first.
  fastify.addHook("onRequest", async (req, reply) => {
    if (req.method === "GET" || req.method === "HEAD" || req.method === "OPTIONS") return;
    if (String(req.headers["sec-fetch-site"] || "").toLowerCase() === "cross-site")
      return reply.code(403).header("cache-control", "no-store").send({ error: "cross-site request refused" });
  });
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
          || u === "/reset" || u === "/reset/code"
          // The invite-request hand is FOR people with no session — behind the gate it was
          // unreachable by exactly its stated audience. The route is its own throttle (1/IP-hour).
          || u === "/api/dm/request-invite"
          // CSP violation reports come from the login page too, where nobody has a session yet.
          || u === "/api/csp-report"
          // A site icon is not protected content, and 401ing it only puts a spurious console
          // error on the login page of every signed-out visitor.
          || u === "/icon.svg" || u === "/manifest.webmanifest" || u === "/favicon.ico") return;
      // A legacy shared-password session authenticates but does not IDENTIFY. Once accounts exist,
      // send those callers to /claim rather than into an app where every personal surface would
      // 401 at them with no explanation. Break-glass admins are exempt: ADMIN_PASSWORD is how an
      // operator gets back in when they have locked themselves out of their own account.
      if (reqAuthed(req)) {
        if (!meOf(req) && ACCOUNTS.countUsers() > 0 && !adminViewOk(getCookie(req, "xyzadm"))) {
          if (u.startsWith("/api/")) return reply.code(401).header("cache-control", "no-store")
            .send({ error: "claim-account", detail: "this terminal now has accounts — visit /claim" });
          return reply.redirect("/claim", 302);
        }
        return;
      }
      // CRITICAL: in an async hook, reply.send() alone does NOT stop the lifecycle — the
      // route handler still runs and double-sends (here: @fastify/static also answered "/",
      // corrupting the response into a body-less 401 that hangs the browser). Returning the
      // reply is what short-circuits. This exact bug shipped in the original Basic-auth gate
      // and lay dormant until the first deploy with SITE_PASSWORD actually set.
      // A locked IP presenting Basic is told so, with a Retry-After, instead of a 401 it would
      // keep retrying at wire speed. The mark, not a re-read of the lock: the attempt that trips
      // the lock still answers 401, exactly as /login's eighth wrong password does.
      if (req.raw.xyzBasicLocked) {
        const min = loginLockedFor(clientIp(req)) || 1;
        return reply.code(429).header("retry-after", String(min * 60)).header("cache-control", "no-store")
          .send({ error: "too many attempts", lockedMin: min });
      }
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
    // (build 2026.09.24-110) Each tab's 30-day reach from the Usage aggregates, for the "quiet" flag
    // on these rows: the same numbers the Usage fold's tab table shows at 30d. Best-effort — a
    // failure here must never cost the operator the switchboard.
    let usage;
    try { usage = usageReach(); } catch (_) { usage = null; }
    return Object.assign({}, poller.getFeatures(true), { usage });
  });
  // 8 KB cap — the payload is { key, state }; anything larger is malformed or hostile (413).
  fastify.post("/api/features", { bodyLimit: 8 * 1024 }, async (req, reply) => {
    reply.header("cache-control", "no-store");
    const b = req.body || {};
    const key = String(b.key || "");
    let was = null;
    try { was = require("./src/compute").featureState(poller.getFlags(), key); } catch (_) {}
    const r = poller.setFlag(key, String(b.state || ""), isAdmin(req));
    // (build 2026.09.24-111) a write that MOVED the resolved gate is a marker on the Usage chart
    // (operator config history: no uid); a same-state write is not a change.
    if (r.ok && r.state !== was) { try { ACCOUNTS.usageMark("gate", key + "=" + r.state); } catch (_) {} }
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
    // (build 2026.09.24-111) Usage markers: a tab moved ('<view>><group>') or a menu renamed ('#<group>';
    // the label itself is not kept)
    if (r.ok) { try { ACCOUNTS.usageMark("nav", b.view != null ? String(b.view) + ">" + String(b.group || "") : "#" + String(b.key || "")); } catch (_) {} }
    return reply.code(r.ok ? 200 : (r.error === "forbidden" ? 403 : r.error === "write-failed" ? 503 : 400)).send(r);
  });

  // ===== identity: sign in, join, claim, bootstrap ==============================================
  // Session cookies are minted in exactly one place so a route can never accidentally issue one
  // with the wrong lifetime, and the JS-visible marker always travels with the real token.
  const signIn = (reply, req, user, token) => {
    setSessionCookies(reply, req, SESSION_DAYS * 86400, token);
    // An account-flagged admin gets the view lease too, so the Admin tab paints on the first frame
    // instead of after a round trip. It is a mirror of the flag, never the source of it.
    if (user && user.isAdmin) {
      const row = ACCOUNTS.getUser(user.uid) || {};
      setAdminCookies(reply, req, ADMIN_DAYS * 86400, signAdminView(Date.now() + ADMIN_DAYS * 864e5, user.uid, row.epoch));
    }
  };
  const inviteCookie = (reply, req, code) =>
    reply.header("set-cookie", "xyzinv=" + encodeURIComponent(code) + cookieAttrs(req, code ? 900 : 0) + "; HttpOnly");
  const htmlNoStore = (reply) => reply.header("cache-control", "no-store").type("text/html; charset=utf-8");

  // ---- the scrypt admission gate ---------------------------------------------------------------
  // Password hashing runs on libuv's threadpool now (accounts.js), which stops it stalling the
  // event loop — but the pool is four threads shared with gzip, DNS and file reads, and a caller
  // who can queue a thousand derivations still starves everything behind them. So at most
  // PW_INFLIGHT_MAX derivations are in flight at once; the rest answer 503 + Retry-After and the
  // login page shows the error text. Per-process, not per-IP: it is the pool being protected,
  // not the caller being judged (the IP damper does that).
  const PW_INFLIGHT_MAX = 8;
  let pwInflight = 0;
  const PW_BUSY = { ok: false, error: "the server is busy checking passwords — try again in a moment" };
  const pwBusy = (reply) => {
    if (pwInflight < PW_INFLIGHT_MAX) return false;
    reply.code(503).header("retry-after", "2").header("cache-control", "no-store");
    return true;
  };
  async function withPw(fn) { pwInflight++; try { return await fn(); } finally { pwInflight--; } }

  // ?next= carries the tab and ticker a session-expired banner was sitting on. Same-origin paths
  // only — never a scheme, never a protocol-relative //host. An allow-list of characters, not a
  // deny-list of whitespace: the value is echoed into the login page's inline script (through
  // jsonForScript) and into a redirect, and "</script>" is not a path anybody needs to land on.
  const safeNext = (v) => { v = String(v == null ? "" : v); return /^\/(?!\/)[A-Za-z0-9_\-./?=&%#]{0,199}$/.test(v) ? v : null; };
  fastify.get("/login", (req, reply) => {
    const next = safeNext(req.query && req.query.next);
    if (meOf(req)) return reply.redirect(next || "/", 302);
    return htmlNoStore(reply).send(authPage({ mode: "signin", next }));
  });

  // One prompt, four outcomes, checked in this order:
  //   1. handle + password matches an account      -> that account's session
  //   2. ADMIN_PASSWORD                            -> break-glass session + admin lease
  //      (and, when no account exists yet, the bootstrap door)
  //   3. the legacy shared password                -> a session that can ONLY reach /claim
  //   4. nothing                                   -> 401, and the IP damper counts it
  fastify.post("/login", { bodyLimit: 8 * 1024 }, async (req, reply) => {
    const ip = clientIp(req);
    const lockedMin = loginLockedFor(ip);
    if (lockedMin) { reply.code(429); return { ok: false, error: `too many attempts — locked for ${lockedMin} min` }; }
    const b = req.body || {};
    const handle = String(b.handle == null ? "" : b.handle).trim();
    const pw = String(b.password == null ? "" : b.password);

    if (handle) {
      if (pwBusy(reply)) return PW_BUSY;
      const r = await withPw(() => ACCOUNTS.login(handle, pw));
      if (r.ok) {
        loginFails.delete(ip);
        signIn(reply, req, r.user, r.token);
        log(`sign-in: ${r.user.handle}${r.user.isAdmin ? " (admin)" : ""}`);
        return { ok: true, next: safeNext(b.next) || "/" };
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
      loginFail(clientIp(req));   // a rejected code counts like a wrong password: 60-bit codes make guessing impractical, the damper makes it pointless
      log(`invite: rejected a ${r.state || "unknown"} code`);
      return htmlNoStore(reply).code(410).send(deadInvitePage(r.state));
    }
    log("invite: opened (code redacted)");
    inviteCookie(reply, req, r.invite.code);
    return reply.redirect("/join", 302);
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
    const ip = clientIp(req);
    if (loginLockedFor(ip)) { reply.code(429); return { ok: false, error: "too many attempts — try again shortly" }; }
    const code = decodeURIComponent(getCookie(req, "xyzinv") || "");
    const b = req.body || {};
    // The prior signed handle is what makes the migration free: it becomes the new uid, so every
    // alert recipient and rule already keyed to it belongs to the account without being rewritten.
    const prior = ownerOf(getCookie(req, "xyzown"));
    if (pwBusy(reply)) return PW_BUSY;
    const r = await withPw(() => ACCOUNTS.redeem(code, b.handle, b.password, prior));
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
  // Signed, like xyzown. The raw handle in an unsigned cookie let anyone hand-set xyzotp=<victim>
  // and spend the victim's five guesses — or, holding an intercepted code, reset their password —
  // without that browser ever having asked for a code. The MAC covers the handle AND an expiry; a
  // value that does not verify reads as no cookie at all, so the flow starts over.
  const OTP_SECRET = ACCOUNTS.deriveKey("otp-step");
  const OTP_STEP_MS = 15 * 60e3;
  const otpSign = (enc, exp) => crypto.createHmac("sha256", OTP_SECRET).update("otp|" + enc + "|" + exp).digest("base64url");
  const otpCookie = (reply, req, handle) => {
    const enc = encodeURIComponent(handle || ""), exp = Date.now() + OTP_STEP_MS;
    const val = handle ? enc + "." + exp + "." + otpSign(enc, exp) : "x";
    reply.header("set-cookie", "xyzotp=" + val + cookieAttrs(req, handle ? Math.round(OTP_STEP_MS / 1000) : 0) + "; HttpOnly");
  };
  const otpHandleOf = (tok) => {
    if (!tok || typeof tok !== "string" || tok.length > 400) return "";
    const p = tok.split(".");
    if (p.length < 3) return "";
    const mac = p.pop(), exp = Number(p.pop()), enc = p.join(".");   // a handle may hold dots; the mac and expiry never do
    if (!Number.isFinite(exp) || exp < Date.now()) return "";
    const a = Buffer.from(mac), b = Buffer.from(otpSign(enc, exp));
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return "";
    try { return decodeURIComponent(enc); } catch (_) { return ""; }
  };

  fastify.get("/reset", (req, reply) => {
    if (meOf(req)) return reply.redirect("/", 302);
    return htmlNoStore(reply).send(authPage({ mode: "forgot" }));
  });
  // /reset is its own lever: every post forces a Telegram send past quiet hours, so it gets a
  // per-IP allowance of its own (the login damper only counted wrong passwords, never resets).
  const resetHits = new Map();
  const RESET_PER_HOUR = 5;
  const resetAllowed = (ip) => {
    const now = Date.now(), a = (resetHits.get(ip) || []).filter((t) => now - t < 3600e3);
    if (a.length >= RESET_PER_HOUR) { resetHits.set(ip, a); return false; }
    a.push(now); resetHits.set(ip, a);
    if (resetHits.size > 5000) resetHits.delete(resetHits.keys().next().value);
    return true;
  };
  fastify.post("/reset", { bodyLimit: 4 * 1024 }, async (req, reply) => {
    const ip = clientIp(req);
    if (loginLockedFor(ip) || !resetAllowed(ip)) { reply.code(429); return { ok: false, error: "too many attempts — try again shortly" }; }
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
    if (meOf(req)) return reply.redirect("/", 302);
    if (!otpHandleOf(getCookie(req, "xyzotp"))) return reply.redirect("/reset", 302);
    return htmlNoStore(reply).send(authPage({ mode: "otp" }));
  });
  fastify.post("/reset/code", { bodyLimit: 8 * 1024 }, async (req, reply) => {
    const ip = clientIp(req);
    if (loginLockedFor(ip)) { reply.code(429); return { ok: false, error: "too many attempts — try again shortly" }; }
    const handle = otpHandleOf(getCookie(req, "xyzotp"));   // signed: a hand-set cookie reads as none
    if (!handle) { reply.code(400); return { ok: false, error: "start again from the reset page" }; }
    const b = req.body || {};
    if (pwBusy(reply)) return PW_BUSY;
    const r = await withPw(() => ACCOUNTS.otpVerify(handle, b.code, b.password));
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
    if (meOf(req)) return reply.redirect("/", 302);
    if (!LEGACY_DOOR || !sessionOk(getCookie(req, "xyzsess"))) return reply.redirect("/login", 302);
    return htmlNoStore(reply).send(authPage({ mode: "claim" }));
  });
  fastify.post("/claim", { bodyLimit: 8 * 1024 }, async (req, reply) => {
    if (meOf(req)) { reply.code(409); return { ok: false, error: "you already have an account" }; }
    if (!LEGACY_DOOR || !sessionOk(getCookie(req, "xyzsess"))) { reply.code(401); return { ok: false, error: "sign in first" }; }
    const b = req.body || {};
    if (pwBusy(reply)) return PW_BUSY;
    const r = await withPw(() => ACCOUNTS.claim(b.handle, b.password, ownerOf(getCookie(req, "xyzown"))));
    if (!r.ok) { reply.code(400); return { ok: false, error: r.error, field: r.field || null }; }
    signIn(reply, req, r.user, r.token);
    log(`account claimed: ${r.user.handle}${r.adopted ? " (carried over existing alerts)" : ""}`);
    return { ok: true, next: "/" };
  });

  // ---- bootstrap ---------------------------------------------------------------------------------
  // Account #1, created by whoever holds ADMIN_PASSWORD, because there is nobody yet who could have
  // issued an invite. Closes for good the moment any account exists.
  fastify.get("/bootstrap", (req, reply) => {
    if (ACCOUNTS.countUsers() > 0) return reply.redirect("/login", 302);
    if (!adminViewOk(getCookie(req, "xyzadm"))) return reply.redirect("/login", 302);
    return htmlNoStore(reply).send(authPage({ mode: "bootstrap" }));
  });
  fastify.post("/bootstrap", { bodyLimit: 8 * 1024 }, async (req, reply) => {
    if (!adminViewOk(getCookie(req, "xyzadm"))) { reply.code(403); return { ok: false, error: "forbidden" }; }
    const b = req.body || {};
    if (pwBusy(reply)) return PW_BUSY;
    const r = await withPw(() => ACCOUNTS.bootstrap(b.handle, b.password, ownerOf(getCookie(req, "xyzown"))));
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
  fastify.post("/api/account", { bodyLimit: 8 * 1024 }, async (req, reply) => {
    reply.header("cache-control", "no-store");
    const me = meOf(req);
    if (!me) return reply.code(401).send({ ok: false, error: "sign in first" });
    const b = req.body || {};
    if (pwBusy(reply)) return PW_BUSY;
    const r = await withPw(() => ACCOUNTS.login(me.handle, String(b.current == null ? "" : b.current)));
    if (!r.ok) return reply.code(403).send({ ok: false, error: "current password is wrong", field: "current" });
    const set = await withPw(() => ACCOUNTS.setPassword(me.uid, b.password));
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
    const by = me ? me.uid : (adminViewUid(getCookie(req, "xyzadm")) || "legacy-admin");
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
    else if (op === "rename") r = ACCOUNTS.renameUser(uid, b.handle);
    else r = { ok: false, error: "unknown operation" };
    if (r.ok && op === "mint") log(`invite minted by ${me ? me.handle : "admin"}${b.label ? " for " + String(b.label).slice(0, 32) : ""}`);
    if (r.ok && (op === "disable" || op === "admin" || op === "signout" || op === "rename")) log(`access: ${op} on ${(ACCOUNTS.getUser(uid) || {}).handle || uid}`);
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
  // Query keys repeat (?by=a&by=b) and a JSON body may carry an array where a scalar is expected;
  // either used to reach a SQLite bind as an array and 500 with the driver's own message. The
  // first value wins and the rest is dropped before anything can reach a statement.
  const one = (v) => (Array.isArray(v) ? v[0] : v);
  const str = (v) => (v == null ? null : String(one(v)));

  // Promote a price-stamped message into the notes book. The note KEEPS the message's own timestamp
  // and price: the whole point is that the claim was made then, at that mark — re-stamping it now
  // would turn last Tuesday's call at 113.90 into a different, false claim about today.
  // Gated on admin because the notes book itself is (`notes` is def:"admin" in the manifest); this
  // route must not become a side door into a feature the manifest closed.
  function promoteToNote(me, req, id) {
    if (!isAdmin(req)) return { ok: false, error: "the notes book is operator-only on this deployment" };
    const rec = ACCOUNTS.calls(me.uid, { limit: 500 }).calls.find((c) => c.id === +id);
    if (!rec) return { ok: false, error: "that message has no ticker stamp to promote" };
    const body = rec.body + "\n\n— from messages, " + rec.sender + " in " + rec.threadName;
    const r = poller.createNote(rec.ref, body, true, { at: rec.ts, px: rec.refPx });
    if (!r.ok) return { ok: false, error: r.error === "not-admin" ? "operator only" : r.error };
    log("call promoted to note: " + rec.ref + " by " + me.handle);
    return { ok: true, note: r.note, thread: rec.thread };
  }

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

  // A visitor with no account can raise a hand: one ops ping to the operator per IP-hour, nothing
  // stored, nothing echoed back — the operator mints the invite (or doesn't) like any other.
  const inviteAsk = new Map();   // ip -> last ask
  fastify.post("/api/dm/request-invite", { bodyLimit: 2 * 1024 }, (req, reply) => {
    reply.header("cache-control", "no-store");
    if (meOf(req)) return { ok: true, already: true };
    const ip = clientIp(req);
    if (Date.now() - (inviteAsk.get(ip) || 0) < 3600e3) return { ok: true, sent: true };   // idempotent to the asker — no spam lever
    // Purge expired entries before the size cap; clear() as the fallback wiped every legitimate
    // IP's throttle the moment an attacker filled the table.
    if (inviteAsk.size > 2000) {
      const cut = Date.now() - 3600e3;
      for (const [k, t] of inviteAsk) if (t < cut) inviteAsk.delete(k);
      if (inviteAsk.size > 2000) return { ok: true, sent: true };   // still full of live keys: swallow, never wipe
    }
    inviteAsk.set(ip, Date.now());
    // The name rides into a Telegram HTML message: markup-significant characters go, at the door.
    const who = String((req.body || {}).name || "").replace(/[<>&\u0000-\u001f]/g, " ").replace(/\s+/g, " ").trim().slice(0, 60);
    if (poller.pushOpsNow) poller.pushOpsNow("invite request",
      "Somebody at the terminal asked for a Messages invite" + (who ? ": “" + who + "”" : "") + ". Mint one in the admin panel.");
    log("invite requested from the messages tab" + (who ? " (" + who + ")" : ""));
    return { ok: true, sent: true };
  });

  fastify.get("/api/dm", (req, reply) => {
    reply.header("cache-control", "no-store");
    const me = dmMe(req, reply); if (!me) return;
    // The directory is simply the member list: at this size a request-to-connect flow is ceremony.
    // `tg` per member and `meTg` for the caller: whether an unmuted Telegram is linked to that
    // ACCOUNT. It is what decides if an away member gets nudged about unread messages — surfaced
    // so "did my message reach anyone" stops being unanswerable from the tab.
    const tgLinked = (uid) => !!(poller.pushRecipientsFor && poller.pushRecipientsFor(uid).length);
    return { ok: true, me: ACCOUNTS.pub(me), threads: ACCOUNTS.threads(me.uid),
      members: ACCOUNTS.listUsers().filter((u) => u.uid !== me.uid && !u.disabled)
        .map((u) => Object.assign({ tg: tgLinked(u.uid) }, u)),
      boards: ACCOUNTS.listBoards(me.uid),
      meTg: tgLinked(me.uid),
      online: [...dmOnline()], maxLen: ACCOUNT_DM_MAX,
      reactions: ACCOUNTS.REACTIONS, maxFile: ACCOUNT_DM_FILE_MAX,
      watching: ACCOUNTS.watchList(me.uid), admin: isAdmin(req),
      // Said out loud, in the payload the tab renders from. People write differently when they
      // believe a message is private, and this deployment's operator can read every one of them —
      // so the tab says so rather than letting the assumption stand.
      operatorReadsAll: true };
  });
  // ---- synced UI prefs: the markets watchlist and the saved layouts, per ACCOUNT ---------------
  // localStorage stays the working copy (a signed-out visitor keeps everything they had); an
  // account adds a server copy that every device of that member converges on. A write pokes the
  // member's OTHER streams with {prefs:{ts}} — same contract as dm: a version, never a payload.
  fastify.get("/api/prefs", (req, reply) => {
    reply.header("cache-control", "no-store");
    const me = dmMe(req, reply); if (!me) return;
    return { ok: true, prefs: ACCOUNTS.prefsGet(me.uid) };
  });
  fastify.post("/api/prefs", { bodyLimit: 96 * 1024 }, (req, reply) => {
    reply.header("cache-control", "no-store");
    const me = dmMe(req, reply); if (!me) return;
    const b = req.body || {};
    const r = ACCOUNTS.prefsPut(me.uid, String(b.key || ""), b.value, b.ts);
    if (!r.ok) return reply.code(400).send(r);
    if (r.stored) {
      const frame = "data: " + JSON.stringify({ prefs: { key: String(b.key), ts: r.ts, from: String(b.tab || "") } }) + "\n\n";
      const set = sseByUid.get(me.uid);
      if (set) for (const e of set) sseWrite(e, frame);
    }
    return r;
  });
  // ===== usage beacon + "Your usage" (build 2026.09.24-109) ======================================
  // First-party, members only: which tab is on screen and for how long, rolled into daily
  // aggregates (accounts.js usage_day). The beacon carries {tabs:{view -> visible ms}, pwa} and
  // nothing else — no tickers, no search text, no filters, and the device class is derived HERE
  // from the User-Agent and stored as one of three words; the UA itself is never kept.
  // Public (signed-out) tracking is a server flag, OFF by default, and even on it only acknowledges:
  // the anonymous-visitor bucket is deliberately NOT built (the owner decided: off; build -110 kept
  // it that way rather than ship an id path nobody switched on).
  const USAGE_PUBLIC = process.env.USAGE_PUBLIC === "1";
  const USAGE_MIN_GAP_MS = 30000;          // one accepted beacon per member PAGE SESSION per 30s; earlier ones are held (-110 follow-up)
  const USAGE_MAX_FLUSH_MS = 120000;       // a beacon never claims more than 2 min of screen time
  const USAGE_TABS = () => require("./src/compute").FEATURES.filter((f) => f.kind === "tab").map((f) => {
    const g = require("./src/compute").featureState(poller.getFlags(), f.key);
    return { key: f.key, label: f.label, gate: f.key === "dm" && g === "public" ? "members" : g };   // Messages needs an account whatever its flag
  });
  const USAGE_TAB_KEYS = new Set(require("./src/compute").FEATURES.filter((f) => f.kind === "tab").map((f) => f.key));
  // (build 2026.09.24-110 follow-up) The rate gate, per (member, page session): an early beacon is
  // HELD and merged into the session's next accepted one (or released by the 60s flush), never
  // dropped; accepted time is clamped to the session's wall time and a per-member budget of 2×
  // wall time. The whole design and its bounds: src/usage-gate.js.
  const usageGate = createUsageGate({ minGapMs: USAGE_MIN_GAP_MS, maxFlushMs: USAGE_MAX_FLUSH_MS });
  function usageDevice(ua, pwa) {
    const s = String(ua || "");
    const cls = /iPad|Tablet|PlayBook|Silk|Android(?!.*Mobile)/i.test(s) ? "tablet" : /Mobi|iPhone|iPod|Android/i.test(s) ? "mobile" : "desktop";
    return cls + (pwa === true ? "-pwa" : "");
  }
  // (build 2026.09.24-110) The beacon's other fields, all optional, all validated here:
  //   acts  {csv|drawer-open -> n}: the two actions that happen only in the browser. Every other
  //         counter is incremented server-side at its own authenticated call, so the beacon may
  //         not claim them; each count is clamped to USAGE_MAX_ACTS.
  //   b     the build this tab runs (its first snapshot's stamp) — the stale-build count reads it.
  //         (-110 follow-up) perf and errs are kept only when b is a build this deployment served.
  //   s     (-110 follow-up) a random id minted once per page load: the rate gate's session key.
  //   perf  ms from navigation start to the first markets-table paint, once per page load.
  //   errs  [{m, f, l, c}]: deduped client-side by message + file:line; the message is cut to 200
  //         characters, the file to a same-site path (never a query string), c = hits (clamped).
  //         Browser-supplied text: stored as data, escaped by every reader, never interpreted.
  //   h     (build 2026.09.24-111) the beacon's minutes per clock hour, {UTC hour index -> ms} (an ET
  //         hour is a whole UTC hour): the heatmap's buckets. Shape-checked here (integer keys, at
  //         most 8, positive ms, each ≤ 2 min); the gate keeps only the hours of the beacon's own
  //         wall-time window and scales them to the accepted time (usage-gate.js).
  //   ld    (-111) 1 on a page load's first beacon: the regression check's page-load count, under a
  //         known build only, once per page session (the gate) and ≤ 200 per member per day.
  const USAGE_BEACON_ACTS = new Set(["csv", "drawer-open"]);
  const USAGE_MAX_ACTS = 50, USAGE_MAX_ERRS = 5, USAGE_ERR_MSG = 200, USAGE_ERR_LOC = 120, USAGE_MAX_HRS = 8;
  // (build 2026.09.24-111) The last beacon's build per member now lives in accounts.js (usageLastBuild),
  // written with the 60s flush, so a restart no longer zeroes the stale-build count.
  const USAGE_STALE_MS = 3600 * 1000;
  // Strip control characters (and the bidi/zero-width ones a hostile message would use to lie about
  // what it says) — the text still goes through esc() everywhere it is shown.
  // Cut by code point, not UTF-16 unit, so an emoji at the boundary is never left half a pair.
  const usageClean = (x, n) => Array.from(String(x == null ? "" : x).slice(0, n * 2).replace(/[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2066-\u2069]/g, " ").replace(/\s+/g, " ").trim()).slice(0, n).join("");
  function usageLoc(f, l) {
    let s = String(f == null ? "" : f);
    s = s.replace(/[?#].*$/, "").replace(/^[a-z][a-z0-9+.-]*:\/\/[^/]*/i, "");   // no query, no hash, no origin
    s = s.replace(/[^\w\-./@~+]/g, "_").slice(-USAGE_ERR_LOC + 8) || "?";
    const line = Math.trunc(Number(l));
    return s + ":" + (Number.isFinite(line) && line > 0 && line < 1e7 ? line : 0);
  }
  // (build 2026.09.24-110 follow-up) Quoted text in an error message is often the user's data (a
  // JSON.parse of a pasted value, a selector built from input): each '…', "…" or `…` run is replaced
  // by its quotes around an ellipsis, and an unclosed quote hides everything after it. The browser
  // does the same before sending (public/js/usage.js usUnquote); this is the one that counts.
  function usageUnquote(m) {
    const s = String(m == null ? "" : m);
    let out = "";
    for (let i = 0; i < s.length; i++) {
      const c = s[i];
      if (c !== "'" && c !== '"' && c !== "`") { out += c; continue; }
      if (c === "'" && /\w/.test(s[i - 1] || "") && /\w/.test(s[i + 1] || "")) { out += c; continue; }   // don't, can't
      const j = s.indexOf(c, i + 1);
      if (j < 0) { out += c + "\u2026"; break; }                                                          // unclosed: hide the rest
      out += c + "\u2026" + c; i = j;
    }
    return out;
  }
  // Validate one beacon body. Returns {tabs, pwa, acts, build, rawBuild, sid, perf, errs} (any
  // possibly empty) or {error}; the wall-time clamp is the gate's (usage-gate.js). text/plain is
  // what sendBeacon sends a string as.
  function usageClamp(body) {
    let b = body;
    if (typeof b === "string") { try { b = JSON.parse(b); } catch (_) { return { error: "bad json" }; } }
    if (!b || typeof b !== "object" || Array.isArray(b)) return { error: "bad body" };
    if (b.tabs != null && (typeof b.tabs !== "object" || Array.isArray(b.tabs))) return { error: "bad body" };
    const tabs = {};
    let tot = 0;
    for (const [k, v] of Object.entries(b.tabs || {})) {
      if (!USAGE_TAB_KEYS.has(k)) continue;                 // unknown view names are dropped, never stored
      const ms = Math.round(Number(v));
      if (!Number.isFinite(ms) || ms <= 0) continue;
      tabs[k] = ms; tot += ms;
    }
    // (-110 follow-up) No claim above the 2-minute ceiling even before the gate's wall-time clamp.
    if (tot > USAGE_MAX_FLUSH_MS) { const f = USAGE_MAX_FLUSH_MS / tot; for (const k of Object.keys(tabs)) tabs[k] = Math.floor(tabs[k] * f); }
    const acts = {};
    if (b.acts && typeof b.acts === "object" && !Array.isArray(b.acts)) {
      for (const [k, v] of Object.entries(b.acts)) {
        if (!USAGE_BEACON_ACTS.has(k)) continue;            // server-side counters cannot be claimed by a beacon
        const n = Math.trunc(Number(v));
        if (Number.isFinite(n) && n > 0) acts[k] = Math.min(USAGE_MAX_ACTS, n);
      }
    }
    // (-110 follow-up) The stamp is BELIEVED (perf and errors kept under it) only when it is a build
    // this deployment served; otherwise the beacon keeps its screen time and counters, and loses
    // those two. The well-formed raw stamp still feeds the in-memory stale-build count.
    const rawBuild = typeof b.b === "string" && /^[0-9A-Za-z.\-]{1,32}$/.test(b.b) ? b.b : null;
    const build = rawBuild && ACCOUNTS.usageBuildKnown(rawBuild) ? rawBuild : null;
    const sid = typeof b.s === "string" && /^[0-9A-Za-z]{8,24}$/.test(b.s) ? b.s : "";
    const pv = Math.round(Number(b.perf));
    const perf = build && Number.isFinite(pv) && pv > 0 && pv <= 120000 ? pv : null;
    const errs = [];
    if (Array.isArray(b.errs)) {
      const seen = new Set();
      for (const e of b.errs.slice(0, USAGE_MAX_ERRS * 4)) {   // dedupe first, then keep the first five
        if (errs.length >= USAGE_MAX_ERRS) break;
        if (!e || typeof e !== "object") continue;
        const msg = usageClean(usageUnquote(String(e.m == null ? "" : e.m).slice(0, 4 * USAGE_ERR_MSG)), USAGE_ERR_MSG) || "(no message)";
        const loc = usageLoc(e.f, e.l);
        const c = Math.trunc(Number(e.c));
        const k = loc + "\u0001" + msg;
        if (seen.has(k)) continue; seen.add(k);
        errs.push({ msg, loc, c: Number.isFinite(c) && c > 0 ? Math.min(USAGE_MAX_ACTS, c) : 1 });
      }
    }
    const hrs = {};
    if (b.h && typeof b.h === "object" && !Array.isArray(b.h)) {
      for (const [k, v] of Object.entries(b.h).slice(0, USAGE_MAX_HRS)) {
        if (!/^\d{1,9}$/.test(k)) continue;
        const ms = Math.round(Number(v));
        if (Number.isFinite(ms) && ms > 0) hrs[k] = Math.min(USAGE_MAX_FLUSH_MS, ms);
      }
    }
    // (build 2026.09.24-112) sitewide tab paths, the entry tab and control counts (usageSiteClamp)
    const site = usageSiteClamp(b);
    return { tabs, pwa: b.pwa === true, acts, build, rawBuild, sid, perf, errs: build ? errs : [], hrs, load: !!build && b.ld === 1,
      tr: site.tr, en: site.en, ctl: site.ctl };
  }
  // (build 2026.09.24-112) The beacon's sitewide fields, all optional, all validated against allowlists:
  //   tr   {'<from>><to>' -> n}: tab→tab transitions; both ends must be tab ids of the feature manifest
  //        and differ; ≤ USAGE_MAX_TR_KEYS keys, each n clamped to USAGE_MAX_TR_N. The gate clamps the
  //        total again to what the accepted wall time allows (one per 2s dwell).
  //   en   the page load's entry tab (a tab id), once per page session (the gate).
  //   ctl  {'<group>.<control>[=<value>]' -> n}: control uses; the key must be in the US_CONTROLS
  //        allowlist (public/js/usage.js, parsed by src/usage-controls.js — the same text the browser
  //        runs); ≤ USAGE_MAX_CTL_KEYS keys, each n clamped to USAGE_MAX_CTL_N.
  // Every key is checked against a Set, so '__proto__', 'constructor' and friends are simply unknown;
  // the output objects are null-prototype all the same. accounts.js stores all three under uid '0'.
  const USAGE_MAX_TR_KEYS = 40, USAGE_MAX_TR_N = 30, USAGE_MAX_CTL_KEYS = 40, USAGE_MAX_CTL_N = 20;
  const USAGE_CTL = require("./src/usage-controls").usageControls();
  if (USAGE_CTL.error) log("usage: control allowlist unavailable (" + USAGE_CTL.error + ") — control counts are dropped");
  const usageObj = (x) => x && typeof x === "object" && !Array.isArray(x);
  function usageSiteClamp(b) {
    const tr = Object.create(null), ctl = Object.create(null);
    if (usageObj(b.tr)) {
      let n = 0;
      for (const [k, v] of Object.entries(b.tr)) {
        if (n >= USAGE_MAX_TR_KEYS) break;
        const i = typeof k === "string" ? k.indexOf(">") : -1;
        if (i < 0) continue;
        const from = k.slice(0, i), to = k.slice(i + 1);
        if (from === to || !USAGE_TAB_KEYS.has(from) || !USAGE_TAB_KEYS.has(to)) continue;
        const c = Math.trunc(Number(v));
        if (!Number.isFinite(c) || c <= 0) continue;
        tr[k] = Math.min(USAGE_MAX_TR_N, c); n++;
      }
    }
    if (usageObj(b.ctl)) {
      let n = 0;
      for (const [k, v] of Object.entries(b.ctl)) {
        if (n >= USAGE_MAX_CTL_KEYS) break;
        if (!USAGE_CTL.keys.has(k)) continue;
        const c = Math.trunc(Number(v));
        if (!Number.isFinite(c) || c <= 0) continue;
        ctl[k] = Math.min(USAGE_MAX_CTL_N, c); n++;
      }
    }
    const en = typeof b.en === "string" && USAGE_TAB_KEYS.has(b.en) ? b.en : null;
    return { tr, en, ctl };
  }
  function usageStore(uid, p, now) {
    const r = ACCOUNTS.usageRecord(uid, p.tabs, p.dev, now, { acts: p.acts, build: p.build, perf: p.perf, errs: p.errs, hrs: p.hrs, load: p.load,
      tr: p.tr, en: p.en, ctl: p.ctl });   // (build 2026.09.24-112) stored sitewide, without the uid
    if (r.stored) ACCOUNTS.touch(uid);
    return r;
  }
  fastify.post("/api/usage", { bodyLimit: 4 * 1024 }, (req, reply) => {
    reply.header("cache-control", "no-store");
    const me = meOf(req);
    if (!me) return reply.code(204).send();                 // signed out: nothing is collected (public tracking is OFF; the visitor id is deliberately not built)
    if (ACCOUNTS.usagePaused(me.uid)) return reply.code(204).send();
    const now = Date.now();
    const c = usageClamp(req.body);
    if (c.error) return reply.code(400).send({ ok: false, error: c.error });
    if (c.rawBuild) ACCOUNTS.usageLastBuild(me.uid, c.rawBuild, now);   // (-111) persisted with the flush
    c.dev = usageDevice(req.headers["user-agent"], c.pwa);
    // (-110 follow-up) held early beacons get the same 204: sendBeacon never sees the answer anyway
    const g = usageGate.offer(me.uid, c.sid, c, now, (uid, p) => usageStore(uid, p, now));
    if (g.busy) return reply.code(429).header("retry-after", String(Math.ceil(USAGE_MIN_GAP_MS / 1000))).send();
    if (g.accept) usageStore(me.uid, g.accept, now);
    return reply.code(204).send();
  });
  // Members whose last beacon inside the hour came from a build other than this one: tabs still
  // running an old bundle after a deploy (the reload toast is what fixes them). (-111) Counted from
  // the persisted per-member row, so it survives the restart that the deploy itself is.
  const usageStale = (now) => ACCOUNTS.usageStale(VERSION, now != null ? now : Date.now(), USAGE_STALE_MS);
  // Reach per tab over the full 30-day window, for Admin → Feature visibility (build 2026.09.24-110).
  // quiet = under 10% of the members active in the window opened it at all.
  // (-110 follow-up) GET /api/features calls this on every read: memoized on the flush generation,
  // the tab list (gates move with the flags) and the hour (the 30-day window rolls), and computed
  // with the summary's lite mode (no cohorts, no error texts).
  let usageReachMemo = null;
  function usageReach() {
    if (ACCOUNTS.usagePending()) ACCOUNTS.usageFlush();
    const tl = USAGE_TABS();
    const key = [ACCOUNTS.usageGen(), JSON.stringify(tl), Math.floor(Date.now() / 3600000)].join("|");
    if (usageReachMemo && usageReachMemo.key === key) return usageReachMemo.val;
    const s = ACCOUNTS.usageSummary({ r: ACCOUNTS.USAGE_KEEP_DAYS, tabs: tl, lite: true });
    const tabs = {};
    for (const t of s.tabs) tabs[t.key] = { users: t.users, reach: t.reach, quiet: t.reach != null && t.reach < 0.1 && s.kpi.activeRange > 0 };
    const val = { r: s.r, active: s.kpi.activeRange, tabs };
    usageReachMemo = { key, val };
    return val;
  }
  // (-110 follow-up) Held early beacons whose page never sent a follow-up land on the regular flush.
  // `all` (shutdown) releases every held payload, past its gap or not — clamped all the same.
  function usageSweep(now, all) { const t = now != null ? now : Date.now(); usageGate.sweep(t, (uid, p) => usageStore(uid, p, t), all); }
  USAGE_SWEEP = usageSweep;   // main()'s 60s flush and shutdown reach it here (buildServer's scope)
  fastify.decorate("usageSweep", usageSweep);
  // Server-side action counters (build 2026.09.24-110): one call per authenticated action, a no-op
  // for a signed-out caller, a paused member or a word outside the allowlist (accounts.js decides).
  const usageActFor = (uid, key) => { try { if (uid) ACCOUNTS.usageAct(uid, key); } catch (_) {} };
  fastify.get("/api/usage/me", (req, reply) => {
    reply.header("cache-control", "no-store");
    const me = dmMe(req, reply); if (!me) return;
    return ACCOUNTS.usageMine(me.uid, USAGE_TABS());
  });
  fastify.post("/api/usage/pause", { bodyLimit: 1024 }, (req, reply) => {
    reply.header("cache-control", "no-store");
    const me = dmMe(req, reply); if (!me) return;
    const r = ACCOUNTS.setUsagePaused(me.uid, !!(req.body || {}).paused);
    if (r.ok && r.paused) usageGate.forget(me.uid);
    return r;
  });
  fastify.get("/api/dm/sync", (req, reply) => {
    reply.header("cache-control", "no-store");
    const me = dmMe(req, reply); if (!me) return;
    const q = req.query || {};
    return ACCOUNTS.sync(me.uid, one(q.since), one(q.limit));
  });
  fastify.get("/api/dm/search", (req, reply) => {
    reply.header("cache-control", "no-store");
    const me = dmMe(req, reply); if (!me) return;
    const q = req.query || {};
    return ACCOUNTS.search(me.uid, str(q.q), one(q.limit), one(q.thread));
  });

  // ===== browser push (build 2026.09.11-66) =====================================================
  // The offline escalation's second leg: a member with no Telegram (or who just prefers the
  // browser) can get the SAME digests as web push. Subscriptions are stored per account; VAPID
  // keys are minted once and persist on the volume, so a redeploy never invalidates the desk's
  // subscriptions. Delivery rides the escalation sweep below — same eligibility, same delay,
  // same mention/watch piercing, zero new policy.
  const WEBPUSH = (() => {
    let wp = null;
    try { wp = require("web-push"); } catch (_) { log("web-push module missing — browser push disabled"); return null; }
    const keyFile = path.join(DATA_DIR, "webpush-keys.json");
    let keys = null;
    try { keys = JSON.parse(fs.readFileSync(keyFile, "utf8")); } catch (_) {}
    if (!keys || !keys.publicKey || !keys.privateKey) {
      keys = wp.generateVAPIDKeys();
      try { fs.writeFileSync(keyFile, JSON.stringify(keys)); } catch (e) { log("WARN: could not persist VAPID keys (" + e.message + ") — subscriptions will not survive a redeploy"); }
      log("browser push: minted new VAPID keys");
    }
    // The subject is a contact hint for push services, not an identity — deliberately generic.
    wp.setVapidDetails(process.env.PUSH_VAPID_SUBJECT || "mailto:ops@example.com", keys.publicKey, keys.privateKey);
    return { wp, publicKey: keys.publicKey };
  })();
  fastify.get("/api/dm/push-key", (req, reply) => {
    reply.header("cache-control", "no-store");
    const me = dmMe(req, reply); if (!me) return;
    return WEBPUSH ? { ok: true, key: WEBPUSH.publicKey } : { ok: false, error: "push disabled" };
  });
  fastify.post("/api/dm/push-sub", { bodyLimit: 4 * 1024 }, (req, reply) => {
    reply.header("cache-control", "no-store");
    const me = dmMe(req, reply); if (!me) return;
    const b = req.body || {};
    if (b.remove) return ACCOUNTS.webPushDrop(me.uid, String(b.remove));
    const r = ACCOUNTS.webPushAdd(me.uid, b.sub, String(req.headers["user-agent"] || ""));
    if (!r.ok) return reply.code(400).send(r);
    log("browser push subscription registered for " + me.handle);
    usageActFor(me.uid, "push-enable");   // (build 2026.09.24-110)
    return r;
  });
  // One digest to every live subscription of a member; endpoints the push service has declared
  // dead (404/410) are dropped on the spot. Returns true if anything was accepted.
  async function webPushSend(uid, payload) {
    if (!WEBPUSH) return false;
    const subs = ACCOUNTS.webPushFor(uid);
    if (!subs.length) return false;
    let sent = 0;
    for (const sub of subs) {
      try { await WEBPUSH.wp.sendNotification(sub, JSON.stringify(payload), { TTL: 3600 }); sent++; }
      catch (e) {
        const sc = e && e.statusCode;
        if (sc === 404 || sc === 410) ACCOUNTS.webPushDropDead(sub.endpoint);
      }
    }
    return sent > 0;
  }
  // Attachments arrive base64 in a JSON body rather than multipart: it costs ~33% on the wire for
  // an 8 MB ceiling and saves a dependency in a codebase that has deliberately stayed at four.
  fastify.post("/api/dm/upload", { bodyLimit: 14 * 1024 * 1024 }, (req, reply) => {
    reply.header("cache-control", "no-store");
    const me = dmMe(req, reply); if (!me) return;
    const b = req.body || {};
    let buf;
    try { buf = Buffer.from(String(b.data || ""), "base64"); }
    catch (_) { return reply.code(400).send({ ok: false, error: "that upload was malformed" }); }
    const r = ACCOUNTS.putFile(me.uid, one(b.thread), str(b.name), buf);
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
    // Audio must be inline or <audio> playback is blocked (Firefox honors attachment on media);
    // the sandboxed CSP below still applies if somebody browses to it directly.
    const dispo = (r.file.inline || /^audio\//.test(r.file.mime)) ? "inline" : "attachment";
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
  // The calls record: every price-stamped message, with the move since it was sent. This is what
  // the stamp is FOR — without somewhere to read them together, each call dies in the conversation
  // it was made in.
  fastify.get("/api/dm/calls", (req, reply) => {
    reply.header("cache-control", "no-store");
    const me = dmMe(req, reply); if (!me) return;
    const q = req.query || {};
    // An operator can read the whole desk's record; everyone else sees the calls made in the
    // conversations they are actually in.
    return ACCOUNTS.calls(me.uid, { by: str(q.by) || null, limit: one(q.limit), all: isAdmin(req) && one(q.all) === "1" });
  });
  // Call targets (build 2026.09.24-95): the same record, narrowed to the calls that named a price and
  // a date — open ones with how far along they are, resolved ones with how they resolved — and the
  // binary record per person. A read over ACCOUNTS.calls, so the scope (your conversations; the
  // operator's all-view) and the cleared-history floor are exactly the board's.
  fastify.get("/api/dm/targets", (req, reply) => {
    reply.header("cache-control", "no-store");
    const me = dmMe(req, reply); if (!me) return;
    const q = req.query || {};
    const r = ACCOUNTS.calls(me.uid, { by: str(q.by) || null, limit: 500, all: isAdmin(req) && one(q.all) === "1" });
    const tg = r.calls.filter((c) => c.tg);
    return { ok: true, open: tg.filter((c) => !c.tg.res && !c.closed), resolved: tg.filter((c) => c.tg.res || c.closed),
      summary: r.summary.filter((e) => e.tg).map((e) => ({ uid: e.uid, who: e.who, tg: e.tg })) };
  });
  // The operator's "resolve now": the same sweep the minute timer runs, on demand. Admin-only — it
  // posts into conversations under their authors' names, which is not a member's button to press.
  fastify.post("/api/dm/targets", { bodyLimit: 1024 }, (req, reply) => {
    reply.header("cache-control", "no-store");
    const me = dmMe(req, reply); if (!me) return;
    if (!isAdmin(req)) return reply.code(403).send({ ok: false, error: "forbidden" });
    return { ok: true, resolved: targetTick() };
  });
  fastify.get("/api/dm/export/:id", (req, reply) => {
    reply.header("cache-control", "no-store");
    const me = dmMe(req, reply); if (!me) return;
    const r = ACCOUNTS.exportThread(me.uid, (req.params || {}).id);
    if (!r.ok) return reply.code(404).send(r);
    const stamp = new Date().toISOString().slice(0, 10);
    return reply
      .header("content-disposition", 'attachment; filename="messages-' + r.thread + "-" + stamp + '.json"')
      .send(r);
  });
  fastify.get("/api/dm/:id", (req, reply) => {
    reply.header("cache-control", "no-store");
    const me = dmMe(req, reply); if (!me) return;
    const q = req.query || {};
    const r = ACCOUNTS.history(me.uid, (req.params || {}).id, one(q.before), one(q.limit));
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
    // The scalar fields, once, before the verb dispatch: every branch below binds one of these.
    for (const k of ["id", "thread", "fileId", "replyTo", "to", "watch", "pin", "close", "reopen", "clearHistory", "deleteGroup", "joinBoard", "read", "uid", "callClose", "callExtend", "callDrop"])
      if (Array.isArray(b[k])) b[k] = b[k][0];
    let r;
    if (b.typing) {
      // Fire and forget: typing is a hint, and a hint that can fail loudly is worse than no hint.
      if (ACCOUNTS.isMember(b.thread, me.uid)) {
        dmTypingSet(Number(b.thread), me.uid);
        dmPoke(b.thread, { typing: { thread: Number(b.thread), uids: dmTypingOf(Number(b.thread), null) } });
      }
      return { ok: true };
    }
    if (b.watch != null) r = ACCOUNTS.setWatch(me.uid, b.watch, b.on !== false);
    else if (b.pin != null) r = ACCOUNTS.pin(me.uid, b.pin, b.on !== false);
    else if (b.toNote && b.id != null) r = promoteToNote(me, req, b.id);
    else if (b.board) r = ACCOUNTS.createBoard(me.uid, b.title);
    else if (b.joinBoard != null) r = ACCOUNTS.joinBoard(me.uid, b.joinBoard);
    else if (b.group) r = ACCOUNTS.createGroup(me.uid, b.title, b.members);
    else if (b.addMembers) r = ACCOUNTS.addMembers(me.uid, b.thread, b.members, isAdmin(req));
    else if (b.removeMember) r = ACCOUNTS.removeMember(me.uid, b.thread, String(b.uid || ""), isAdmin(req));
    else if (b.leave) r = ACCOUNTS.leaveGroup(me.uid, b.thread);
    else if (b.rename) r = ACCOUNTS.renameGroup(me.uid, b.thread, b.title, isAdmin(req));
    else if (b.deleteGroup != null) {
      r = ACCOUNTS.deleteGroup(me.uid, b.deleteGroup, isAdmin(req));
      if (r.ok) {
        log("group deleted by " + me.handle + (r.title ? ": " + r.title.slice(0, 40) : ""));
        // The thread is gone, so dmPoke (which resolves members) has nobody to resolve — wake the
        // collected members directly with a `gone` hint so their rails drop it now, not at the
        // next full load.
        const frame = "data: " + JSON.stringify({ dm: { seq: ACCOUNTS.msgSeq(), gone: r.deleted } }) + "\n\n";
        for (const uid of r.peers || []) { const set = sseByUid.get(uid); if (set) for (const e2 of set) sseWrite(e2, frame); }
      }
    }
    // Close and clear are per-viewer state: no dmPoke — nobody else's screen changed.
    else if (b.close != null) r = ACCOUNTS.closeThread(me.uid, b.close);
    else if (b.reopen != null) r = ACCOUNTS.reopenThread(me.uid, b.reopen);
    else if (b.clearHistory != null) r = ACCOUNTS.clearHistory(me.uid, b.clearHistory);
    else if (b.react) { r = ACCOUNTS.react(me.uid, b.id, String(b.emoji || "")); if (r.ok) dmTgReact(r.message.id); }
    else if (b.read != null || b.markRead) r = ACCOUNTS.markRead(me.uid, b.thread, b.read);
    else if (b.mute != null) r = ACCOUNTS.setMuted(me.uid, b.thread, !!b.mute);
    else if (b.boardNotify != null) r = ACCOUNTS.setBoardNotify(me.uid, b.thread, !!b.boardNotify);
    else if (b.tgSync != null) {
      // The box needs a phone to mirror into. Refused rather than stored: a flag with nothing
      // behind it would look like sync and deliver nothing.
      const chats = poller.pushRecipientsFor ? poller.pushRecipientsFor(me.uid) : [];
      if (b.tgSync && !chats.length) return reply.code(400).send({ ok: false, error: "link a Telegram in the alerts panel first" });
      r = ACCOUNTS.setTgSync(me.uid, b.thread, !!b.tgSync);
      if (r.ok && poller.pushEnqueueNow) {
        // Told on the phone, where it changes what typing does. Forced: it is not an alert, and
        // a person switching sync on wants to know it took before they type into it.
        const note = b.tgSync
          ? "\u21c4 <b>Syncing \u201c" + tgEsc(r.name) + "\u201d</b>\nMessages there arrive here as they happen, and anything you type here posts there. Untick the box in Messages to stop."
          : "\u21c4 Sync off for \u201c" + tgEsc(r.name) + "\u201d.";
        for (const chat of chats) { poller.pushEnqueueNow(chat, note, true); if (b.tgSync) dmReplyTarget.set(String(chat), { thread: r.thread, at: Date.now() }); }
      }
    }
    else if (typeof b.alert === "string") {
      if (!ACCOUNTS.isMember(b.thread, me.uid)) return reply.code(400).send({ ok: false, error: "no such conversation" });
      r = dmAlertCmd(me, b.alert, b.thread, {});
    }
    else if (b.card != null) {
      // Share to chat (build 2026.09.21-84): a screener card into a conversation (or to a person,
      // which opens the pair thread as a plain send does). The card is validated and its text
      // body rendered HERE, never taken from the client, so search, export and the phone all
      // read one server-made rendering. `call` stamps the card's own ticker as a price call. A
      // note travels as a SECOND, ordinary message right after it — searchable, editable,
      // quotable — and its failure never un-sends the card.
      const v = validateCard(b.card);
      if (!v.ok) return reply.code(400).send({ ok: false, error: "that card can't be shared (" + v.error + ")" });
      // A chart card (build 2026.09.24-98) is the caption of a picture: the PNG was uploaded into
      // this thread first (the /ratio road), and send() holds it to the same thread-and-owner rule
      // as any attachment. No picture, no chart card; the screener kinds never carry one.
      if (v.card.kind === "chart" && !b.fileId) return reply.code(400).send({ ok: false, error: "that card can't be shared (no-image)" });
      r = ACCOUNTS.send(me.uid, String(b.to || ""), cardText(v.card), coinForSymbol,
        { thread: b.thread || null, card: v.card, stampSym: b.call && v.card.t ? v.card.t : null,
          fileId: v.card.kind === "chart" ? String(b.fileId) : null });
      if (r.ok) usageActFor(me.uid, "share");   // (build 2026.09.24-110) the count, never the card
      if (r.ok && typeof b.body === "string" && b.body.trim()) {
        const note = ACCOUNTS.send(me.uid, null, b.body, coinForSymbol, { thread: r.thread });
        r.note = note.ok ? note.message : null;
      }
    }
    // The call lifecycle (build 2026.09.22-88): the author closes a call early at the live mark,
    // or extends its horizon while it is open. Both change an existing row, so the room is told
    // to re-pull it (the `refresh` hint an edit already uses) rather than to expect a new id.
    else if (b.callClose != null) { r = ACCOUNTS.callClose(me.uid, b.callClose); if (r.ok) dmPoke(r.thread, { refresh: Number(r.thread) }); }
    else if (b.callExtend != null) { r = ACCOUNTS.callExtend(me.uid, b.callExtend, b.days); if (r.ok) dmPoke(r.thread, { refresh: Number(r.thread) }); }
    // Moderation (build 2026.09.23-94): the operator may strike a call from the record, and edit
    // or delete anybody's message. The authz is the admin flag, decided HERE and passed down —
    // accounts.js never reads a cookie — and a moderated row is announced with the `refresh`
    // hint so every open copy of the conversation repaints the bubble now, not at the next
    // sync (an id-cursor sync never re-delivers an old row). The act is audited in the store.
    else if (b.callDrop != null) {
      if (!isAdmin(req)) return reply.code(403).send({ ok: false, error: "forbidden" });
      r = ACCOUNTS.callDrop(me.uid, b.callDrop, true);
      if (r.ok) { log("operator " + me.handle + " struck a call from the record (message " + r.message.id + ")"); dmPoke(r.thread, { refresh: Number(r.thread) }); }
    }
    else if (b.drop && b.id != null) {
      r = ACCOUNTS.drop(me.uid, b.id, isAdmin(req));
      if (r.ok) dmTgRepaint(r.message.id);   // Telegram sync (build 2026.09.24-99): the mirrored copy goes too
      if (r.ok && r.moderated) { log("operator " + me.handle + " deleted message " + r.message.id + " by " + r.message.sender); dmPoke(r.thread, { refresh: Number(r.thread) }); }
    }
    else if (b.id != null) {
      r = ACCOUNTS.edit(me.uid, b.id, b.body, isAdmin(req));
      if (r.ok) dmTgRepaint(r.message.id);   // Telegram sync (build 2026.09.24-99): the mirrored copy is rewritten, moderation included
      if (r.ok && r.moderated) { log("operator " + me.handle + " edited message " + r.message.id + " by " + r.message.sender); dmPoke(r.thread, { refresh: Number(r.thread) }); }
    }
    else {
      // A terminal command's output posted into the thread (build 2026.09.11-69). The manifest
      // keys own no route — this verb shares /api/dm with every other send — so the gate is
      // here, on the fields that make a send a command result: dm.terminal for any `cmd`,
      // dm.ask on top of it for one the AI answered. Admin-locked by default on the AI half;
      // the feature panel flips either without a deploy. 403 with the key, same shape the route
      // gate answers, so the client can say which switch is closed rather than "could not send".
      if (typeof b.cmd === "string") {
        const adm = isAdmin(req), flags = poller.getFlags();
        const closed = !featureVisible(flags, "dm.terminal", adm) ? "dm.terminal"
          : (b.cmdAi && !featureVisible(flags, "dm.ask", adm)) ? "dm.ask" : null;
        if (closed) return reply.code(403).send({ ok: false, error: "feature-gated", feature: closed });
      }
      // An applied reading rides as `call: {side, days}` — the sender's explicit choice, made in
      // the composer before the send; accounts.js bounds both and the words decide otherwise.
      const co = b.call && typeof b.call === "object" ? b.call : null;
      r = ACCOUNTS.send(me.uid, String(b.to || ""), b.body, coinForSymbol,
        { thread: b.thread || null, fileId: b.fileId == null ? null : String(b.fileId), replyTo: b.replyTo || null,
          cmd: typeof b.cmd === "string" ? b.cmd : null, cmdAi: !!b.cmdAi,
          callSide: co && (co.side === "long" || co.side === "short") ? co.side : null, callDays: co && co.days != null ? +co.days : null });
    }
    if (!r.ok) return reply.code(r.retry ? 429 : 400).send(r);
    // Wake everybody in the conversation. The frame carries a sequence number, never the message —
    // the client reacts by running the same sync pull it would have run on its own.
    if (r.thread) { dmPoke(r.thread); dmMirror(r.thread); }
    return r;
  });


  // ===== operator read-through ====================================================================
  // The owner of this deployment decided an operator may read every message on the terminal. It is
  // a SEPARATE surface from /api/dm on purpose: folding an admin bypass into the membership filter
  // would mean one bug in that filter hands an ordinary member the same reach. These routes never
  // consult membership, they are admin-gated at the door, and every read is written to an audit log
  // the panel shows — an operator who can read everything should leave a trace when they do.
  const adminOnly = (req, reply) => {
    if (isAdmin(req)) return true;
    reply.code(403).header("cache-control", "no-store").send({ ok: false, error: "forbidden" });
    return false;
  };
  const adminUid = (req) => { const me = meOf(req); return me ? me.uid : (adminViewUid(getCookie(req, "xyzadm")) || "legacy-admin"); };

  fastify.get("/api/access/dm", (req, reply) => {
    reply.header("cache-control", "no-store");
    if (!adminOnly(req, reply)) return;
    return { ok: true, threads: ACCOUNTS.adminThreads(one((req.query || {}).limit)) };
  });
  fastify.get("/api/access/dm/search", (req, reply) => {
    reply.header("cache-control", "no-store");
    if (!adminOnly(req, reply)) return;
    return ACCOUNTS.adminSearch(adminUid(req), str((req.query || {}).q), one((req.query || {}).limit));
  });
  fastify.get("/api/access/dm/audit", (req, reply) => {
    reply.header("cache-control", "no-store");
    if (!adminOnly(req, reply)) return;
    return { ok: true, entries: ACCOUNTS.adminAuditLog(one((req.query || {}).limit)) };
  });
  fastify.get("/api/access/dm/:id", (req, reply) => {
    reply.header("cache-control", "no-store");
    if (!adminOnly(req, reply)) return;
    const q = req.query || {};
    const r = ACCOUNTS.adminHistory(adminUid(req), (req.params || {}).id, one(q.before), one(q.limit));
    if (!r.ok) return reply.code(404).send(r);
    log("operator " + (meOf(req) ? meOf(req).handle : "(break-glass)") + " read thread " + r.thread);
    return r;
  });

  // Abandoned uploads — somebody picked a file and changed their mind — are referenced by nothing
  // and would otherwise sit on the volume forever. Deleting a message takes its attachment with it
  // at the time of the delete; this is only for the ones that never became a message at all.
  setInterval(() => {
    try {
      const n = ACCOUNTS.sweepFiles();
      if (n) log("dm: swept " + n + " abandoned upload(s)");
    } catch (e) { log("dm file sweep failed (isolated): " + (e && e.message)); }
    // Retention: 30d for a 1-to-1, 7d for groups and topics, pinned messages exempt. Runs on the
    // same cadence — a message a few minutes past its window is not a policy violation.
    try {
      const r = ACCOUNTS.sweepRetention();
      if (r) log("dm: retention removed " + r + " message(s) past their window");
    } catch (e) { log("dm retention sweep failed (isolated): " + (e && e.message)); }
  }, 30 * 60 * 1000).unref();

  // ---- the Telegram reply bridge -----------------------------------------------------------------
  // Which conversation a bare `/r` answers: the last one this chat was told about. Kept in memory
  // on purpose — it is a 30-minute convenience, and a stale mapping surviving a restart would route
  // somebody's reply into a conversation they had forgotten about.
  const dmReplyTarget = new Map();       // telegram chat id -> { thread, at }
  const DM_REPLY_CONTEXT_MS = 30 * 60 * 1000;
  if (poller.setDmBridge) poller.setDmBridge((chat, text, opts) => {
    const o = opts || {};
    const owner = poller.pushOwnerOf ? poller.pushOwnerOf(String(chat)) : "";
    const me = owner && ACCOUNTS.getUser(owner);
    // (build 2026.09.24-107) A disabled account is not linked: no post, edit, reaction or /alert.
    if (!me || me.disabledAt) return { ok: false, error: "This chat is not linked to an account." };
    // /alert from the phone: bound to the conversation this chat mirrors, if any; otherwise a
    // plain personal rule that reaches the phone through the rule class like one set in the panel.
    // Everything returned from here rides pushReply with parse_mode HTML: the help text has
    // literal <ticker> placeholders, and a note, a thread name or an echoed token is member text.
    // Escaped at the wire, once, never in the answer itself (the browser path escapes its own).
    if (o.alert) { const a = dmAlertCmd(me, text, ACCOUNTS.tgSyncThread(me.uid), { tg: true }); return a.ok ? { ok: true, text: tgEsc(a.text) } : { ok: false, error: tgEsc(a.error) }; }
    // Bare text (build 2026.09.21-83): into the synced conversation, or nowhere. `silent` rides
    // back so the wire spends no reply on a chat that never opted in.
    // The line's own Telegram id rides in (build 2026.09.24-99) and is mapped to the row it became,
    // so an edit made to it in Telegram, or a delete made to the row here, can find the other side.
    if (o.bare || o.file) {
      const r = o.file ? ACCOUNTS.bridgeSyncFile(me.uid, o.file.name, o.file.bytes, text) : ACCOUNTS.bridgeSyncText(me.uid, text);
      if (r.ok && r.thread) {
        if (o.tgId) ACCOUNTS.tgMapAdd(String(chat), o.tgId, [r.id], me.uid, "in", o.file ? 1 : 0);
        dmPoke(r.thread); dmMirror(r.thread); dmReplyTarget.set(String(chat), { thread: r.thread, at: Date.now() });
      }
      return r.ok ? { ok: true, thread: r.thread } : { ok: false, error: tgEsc(r.error), silent: !!r.silent };
    }
    // An edit made in Telegram to a line that came in over the bridge: the row is rewritten under
    // the same rules as an edit in the composer, the room repaints it, and every OTHER synced chat
    // carrying it is repainted too. An edit to anything unmapped is silently inert.
    if (o.edit) {
      const r = ACCOUNTS.bridgeEdit(me.uid, String(chat), o.tgId, text);
      if (r.ok) { dmPoke(r.thread, { refresh: Number(r.thread) }); dmTgRepaint(r.message.id); return { ok: true, thread: r.thread }; }
      return { ok: false, error: tgEsc(r.error), silent: !!r.silent };
    }
    // A reaction changed in Telegram. Only on a Telegram message that carries exactly ONE row (a
    // packed burst is ambiguous about which line was meant), and only reactions with a meaning in
    // the site's vocabulary; the rest are ignored without a word.
    if (o.reaction) {
      const pack = ACCOUNTS.tgMapPack(String(chat), o.reaction.tgId);
      const ids = [...new Set(pack.map((x) => x.msg))];
      if (ids.length !== 1) return { ok: false, error: "not-mapped", silent: true };
      const add = (o.reaction.added || []).map(tgReactIn).filter(Boolean), drop = (o.reaction.removed || []).map(tgReactIn).filter(Boolean);
      if (!add.length && !drop.length) return { ok: false, error: "no-meaning", silent: true };
      const r = ACCOUNTS.reactApply(me.uid, ids[0], add, drop);
      if (!r.ok) return { ok: false, error: tgEsc(r.error), silent: true };
      if (r.changed) { dmPoke(r.thread, { refresh: Number(r.thread) }); dmTgReact(ids[0], String(chat)); }
      return { ok: true, thread: r.thread };
    }
    const ctx = dmReplyTarget.get(String(chat));
    const thread = (ctx && Date.now() - ctx.at < DM_REPLY_CONTEXT_MS) ? ctx.thread : 0;
    const r = ACCOUNTS.bridgeReply(me.uid, text, thread);
    if (r.ok && r.thread) { dmPoke(r.thread); dmMirror(r.thread); dmReplyTarget.set(String(chat), { thread: r.thread, at: Date.now() }); }
    return r.ok ? { ok: true, text: "Sent." } : { ok: false, error: tgEsc(r.error) };
  }, { fileMax: ACCOUNT_DM_FILE_MAX });

  // ===== Telegram sync: the outbound mirror (build 2026.09.21-83) ================================
  // A member who ticked "sync to Telegram" on a conversation gets every message in it on their
  // phone AS IT HAPPENS, packed per tick, cursor-advanced only once actually enqueued. Runs after
  // every write that can add rows (a send, a bridge post, a group change, a rule fire) and on a
  // 30-second safety sweep for anything else — the cursor makes both idempotent. Deliberately
  // NOT the escalation digest: no five-minute wait, no unread test, no "are they online" test.
  // The person asked for this conversation live; being at the terminal does not change that.
  //   - Their OWN lines typed at the phone are never echoed back to it (the chat already shows them).
  //   - A chat inside its quiet window is skipped and the cursor HOLDS: the catch-up after the
  //     window is the last DM_MIRROR_MAX rows plus a count, never a night of chat in the outbox.
  //   - No reachable chat (unlinked, blocked → muted): cursor holds, and the digest + browser push
  //     remain the fallback exactly as they are for an unsynced conversation.
  //   - `force` on the enqueue: this is not an alert, and the hourly alert cap must not park a
  //     live conversation for an hour. Telegram's own per-chat pacing still applies in the drain.
  const DM_MIRROR_MAX = 10;
  const DM_MIRROR_CHARS = 3500;
  const DM_MIRROR_CAPTION = 700;    // Telegram caps a caption at 1024 visible characters; name + quote fit in the rest
  // `caption` (build 2026.09.24-99): the line under an uploaded photo or document, so it drops
  // the paperclip stub (the file is right there) and bounds the words to Telegram's caption size.
  const dmMirrorLine = (r0, caption) => {
    const r = caption && r0.body && r0.body.length > DM_MIRROR_CAPTION ? Object.assign({}, r0, { body: r0.body.slice(0, DM_MIRROR_CAPTION) + "\u2026" }) : r0;
    if (r.sys) return "<i>" + tgEsc(r.sys) + "</i>";
    let out = "<b>" + tgEsc(r.mine ? "you" : r.who) + "</b>";
    if (r.edited) out += " <i>\u00b7 edited" + (r.editedBy ? " by " + tgEsc(r.editedBy) : "") + "</i>";
    if (r.reply && r.reply.sender) out += "\n<i>\u21a9 " + tgEsc(r.reply.sender) + ": " + tgEsc(String(r.reply.body || "").slice(0, 80)) + "</i>";
    if (r.cmd) out += "\n\u25b8 " + tgEsc(r.cmd) + (r.body ? "\n<pre>" + tgEsc(r.body.slice(0, 1500)) + (r.body.length > 1500 ? "\u2026" : "") + "</pre>" : "");
    // A shared card: its header line as prose, the rest as the padded block the terminal drew.
    else if (r.card && r.body) { const nl = r.body.indexOf("\n"); out += "\n" + tgEsc(nl >= 0 ? r.body.slice(0, nl) : r.body) + (nl >= 0 ? "\n<pre>" + tgEsc(r.body.slice(nl + 1, nl + 1500)) + "</pre>" : ""); }
    else if (r.body) out += "\n" + tgEsc(r.body);
    if (r.file && !caption) out += "\n\ud83d\udcce " + tgEsc(r.file);
    return out;
  };
  // The tick's rows as SENDS, in order (build 2026.09.24-99): consecutive text rows pack into one
  // message as before, and a row carrying an attachment breaks the pack and goes as its own photo
  // or document with its line as the caption. Every part names the row ids it carries — the sync
  // map is written from them once Telegram answers with a message_id.
  function dmMirrorParts(m) {
    const kept = [];
    let used = 0, cut = 0;
    // Newest first for the budget, then back into order: the freshest lines are the ones a phone
    // must not lose to a long command dump above them.
    for (let i = m.rows.length - 1; i >= 0; i--) {
      const line = dmMirrorLine(m.rows[i]);
      if (used + line.length > DM_MIRROR_CHARS && kept.length) { cut = i + 1; break; }
      kept.unshift({ row: m.rows[i], line }); used += line.length + 2;
    }
    const skipped = m.skipped + cut;
    const parts = [];
    let cur = null;
    for (const k of kept) {
      if (k.row.fileId && !k.row.sys) { cur = null; parts.push({ file: k.row, text: dmMirrorLine(k.row, true), fallback: k.line, ids: [k.row.id] }); continue; }
      if (!cur) { cur = { lines: [], ids: [] }; parts.push(cur); }
      cur.lines.push(k.line); cur.ids.push(k.row.id);
    }
    for (const p of parts) if (p.lines) p.text = p.lines.join("\n\n");
    if (skipped) {
      const head = "<i>+" + skipped + " earlier message" + (skipped === 1 ? "" : "s") + " not mirrored \u2014 open Messages</i>";
      if (parts[0] && parts[0].lines) { parts[0].head = head; parts[0].text = head + "\n\n" + parts[0].text; } else parts.unshift({ text: head, ids: [] });
    }
    return parts;
  }
  // One part onto the outbox for one chat. A file goes as sendPhoto (the four raster types the
  // store verified, minus gif, which Telegram would flatten to a still) or sendDocument; if
  // Telegram refuses the upload the wire falls back to the plain line with the file's name.
  // (build 2026.09.24-107) The map row exists only once Telegram answers, so an edit or a delete
  // made here while the part still sat in the outbox found nothing to repaint and the phone got
  // the words as they were at enqueue. The part now carries its row ids and is rebuilt from the
  // CURRENT rows when the drain reaches it: every row deleted -> the send is dropped; edited ->
  // it goes out in its current wording. null = drop.
  function dmMirrorRebuild(uid, part) {
    let rows;
    try { rows = ACCOUNTS.mirrorRowsById(uid, part.ids); } catch (_) { return null; }
    const live = rows.filter((r) => !r.deleted && !(r.mine && r.via === "telegram"));
    if (!live.length) return null;
    if (part.file) return { caption: dmMirrorLine(live[0], true), fallback: dmMirrorLine(live[0]) };
    return { text: dmMirrorFit(live, part.head) };
  }
  // (build 2026.09.24-108 follow-up) The pack was sized at enqueue (<= DM_MIRROR_CHARS) but an edit
  // made while it sat in the outbox can grow a line to a 4000-character body (more once escaped), and
  // Telegram refuses anything over 4096 with a 400 — which dropped the WHOLE pack. The rebuilt text is
  // held to DM_MIRROR_CHARS: the longest bodies are shortened (cut in the raw words, before escaping,
  // so the HTML stays whole) and marked with an ellipsis; if the names/quotes alone still overflow,
  // the oldest lines give way to a count. Never dropped for length.
  function dmMirrorFit(rows, head) {
    const cap = DM_MIRROR_CHARS, keep = rows.map((r) => String(r.body || "").length);
    const lineOf = (r, i) => (keep[i] < String(r.body || "").length ? dmMirrorLine(Object.assign({}, r, { body: String(r.body).slice(0, keep[i]) + "\u2026" })) : dmMirrorLine(r));
    const join = (lines) => (head ? head + "\n\n" : "") + lines.join("\n\n");
    for (let k = 0; k < 64; k++) {
      const lines = rows.map(lineOf), text = join(lines);
      if (text.length <= cap) return text;
      let j = -1;
      for (let i = 0; i < rows.length; i++) if (keep[i] > 0 && (j < 0 || lines[i].length > lines[j].length)) j = i;
      if (j < 0) break;
      // Shrink in proportion: the escaped line is longer than the raw words ("&" -> "&amp;").
      keep[j] = Math.max(0, Math.min(keep[j] - 1, Math.floor(keep[j] * (lines[j].length - (text.length - cap) - 1) / lines[j].length)));
    }
    const lines = rows.map(lineOf);
    let n = 0;
    while (n < lines.length - 1 && join([
      "<i>+" + (n + 1) + " earlier line" + (n ? "s" : "") + " trimmed \u2014 open Messages</i>"].concat(lines.slice(n + 1))).length > cap) n++;
    const text = join(["<i>+" + (n + 1) + " earlier line" + (n ? "s" : "") + " trimmed \u2014 open Messages</i>"].concat(lines.slice(n + 1)));
    return text.length <= cap ? text : "<i>" + lines.length + " line" + (lines.length === 1 ? "" : "s") + " too long to mirror \u2014 open Messages</i>";
  }
  function dmMirrorSend(chat, uid, part) {
    const onSent = part.ids.length ? (res, it) => ACCOUNTS.tgMapAdd(chat, res && res.message_id, part.ids, uid, "out", it && it.file ? 1 : 0) : null;
    const rebuild = part.ids.length ? () => dmMirrorRebuild(uid, part) : null;
    if (!part.file) { poller.pushSyncNow(chat, part.text, { onSent, rebuild }); return; }
    const f = part.file, photo = f.fileInline && f.fileMime !== "image/gif";
    poller.pushSyncNow(chat, part.fallback, {
      method: photo ? "sendPhoto" : "sendDocument", payload: { caption: part.text, parse_mode: "HTML" }, onSent, fallback: part.fallback, rebuild,
      file: { field: photo ? "photo" : "document", name: f.file, mime: f.fileMime,
        load: () => { const rf = ACCOUNTS.readFile(uid, f.fileId); return rf.ok ? fs.readFileSync(rf.path) : null; } } });
  }
  function dmMirror(threadId, uidOnly) {
    if (!poller.pushEnqueueNow || !poller.pushRecipientsFor) return 0;
    let n = 0;
    let synced;
    try { synced = ACCOUNTS.tgSyncAll().filter((x) => x.thread === +threadId && (!uidOnly || x.uid === uidOnly)); }
    catch (e) { log("dm mirror lookup failed (isolated): " + (e && e.message)); return 0; }
    for (const { uid } of synced) {
      let m;
      try { m = ACCOUNTS.mirrorRows(uid, threadId, DM_MIRROR_MAX); } catch (e) { log("dm mirror read failed (isolated): " + (e && e.message)); continue; }
      if (!m || !m.upTo) continue;
      // One cursor per member, so one decision per member: if ANY of their chats is inside its
      // quiet window the whole member holds, and the catch-up after it reaches every chat.
      // Advancing for the awake chat would silently skip the rows for the sleeping one.
      const targets = poller.pushRecipientsFor(uid);
      if (!targets.length || targets.some((c) => poller.pushQuietNow && poller.pushQuietNow(c))) continue;
      // What you typed at the phone is already on the phone.
      const rows = m.rows.filter((r) => !(r.mine && r.via === "telegram"));
      if (rows.length) {
        const parts = dmMirrorParts(Object.assign({}, m, { rows }));
        for (const chat of targets) {
          for (const part of parts) {
            if (poller.pushSyncNow) dmMirrorSend(chat, uid, part);
            else poller.pushEnqueueNow(chat, part.fallback || part.text, true);
          }
          dmReplyTarget.set(String(chat), { thread: +threadId, at: Date.now() });
        }
        n++;
      }
      ACCOUNTS.markEscalated(uid, threadId, m.upTo);
    }
    return n;
  }
  // ===== Telegram sync: edits, deletions and reactions (build 2026.09.24-99) =====================
  // Everything already mirrored is found through the sync map (site row <-> Telegram message, per
  // chat) and changed in place: an edit here repaints the Telegram message carrying it; a delete
  // shrinks a packed message, or deletes it when nothing live is left; a reaction here sets the
  // bot's one reaction on it. Each is a queued outbox call like any send — same pacing, same 429
  // backoff — and a refusal from Telegram is logged and skipped, never retried into a wedge.
  // Limits that are Telegram's, not ours: a bot cannot edit a line the MEMBER typed (only delete
  // it, in a private chat), deleting a message older than 48 hours is refused, and a bot holds
  // ONE reaction per message — so the chat shows the conversation's most-used reaction.
  function dmTgTargets(msgId, skipChat) {
    let maps;
    try { maps = ACCOUNTS.tgMapFor(msgId); } catch (e) { log("tg sync map read failed (isolated): " + (e && e.message)); return []; }
    const seen = new Set(), out = [];
    for (const mp of maps) {
      const key = mp.chat + ":" + mp.tgId;
      if (seen.has(key) || mp.chat === skipChat) continue;
      seen.add(key);
      // A chat since unlinked or blocked has nothing to repaint into.
      if (!(poller.pushRecipientsFor ? poller.pushRecipientsFor(mp.uid) : []).includes(mp.chat)) continue;
      out.push(mp);
    }
    return out;
  }
  function dmTgRepaint(msgId) {
    if (!poller.pushSyncNow) return 0;
    let n = 0;
    for (const mp of dmTgTargets(msgId)) {
      try {
        if (mp.dir === "in") {
          // The member's own line: gone here means gone there (bots may delete incoming messages
          // in a private chat). An edit here to a line typed in Telegram cannot be carried back.
          const row = ACCOUNTS.mirrorRowsById(mp.uid, [mp.msg])[0];
          if (row && row.deleted) { poller.pushSyncNow(mp.chat, "", { method: "deleteMessage", payload: { message_id: mp.tgId } }); n++; }
          continue;
        }
        const ids = ACCOUNTS.tgMapPack(mp.chat, mp.tgId).filter((x) => x.dir === "out").map((x) => x.msg);
        const rows = ACCOUNTS.mirrorRowsById(mp.uid, ids);
        if (!rows.length) continue;          // no longer a member: their old chat is left as it was
        const live = rows.filter((r) => !r.deleted);
        if (!live.length) poller.pushSyncNow(mp.chat, "", { method: "deleteMessage", payload: { message_id: mp.tgId } });
        else if (mp.media) poller.pushSyncNow(mp.chat, "", { method: "editMessageCaption", payload: { message_id: mp.tgId, caption: dmMirrorLine(live[0], true), parse_mode: "HTML" } });
        else poller.pushSyncNow(mp.chat, "", { method: "editMessageText",
          payload: { message_id: mp.tgId, text: live.map((r) => dmMirrorLine(r)).join("\n\n"), parse_mode: "HTML", disable_web_page_preview: true } });
        n++;
      } catch (e) { log("tg sync repaint failed (isolated): " + (e && e.message)); }
    }
    return n;
  }
  function dmTgReact(msgId, skipChat) {
    if (!poller.pushSyncNow) return 0;
    let top;
    try { top = ACCOUNTS.reactTop(msgId); } catch (_) { return 0; }
    const tg = top ? tgReactOut(top) : null;
    let n = 0;
    for (const mp of dmTgTargets(msgId, skipChat)) {
      // A packed message is several lines in one bubble: a reaction on it would claim all of them.
      if (new Set(ACCOUNTS.tgMapPack(mp.chat, mp.tgId).map((x) => x.msg)).size !== 1) continue;
      poller.pushSyncNow(mp.chat, "", { method: "setMessageReaction",
        payload: { message_id: mp.tgId, reaction: tg ? [{ type: "emoji", emoji: tg }] : [] } });
      n++;
    }
    return n;
  }
  setInterval(() => {
    let pairs;
    try { pairs = ACCOUNTS.tgSyncAll(); } catch (_) { return; }
    for (const t of new Set(pairs.map((x) => x.thread))) { try { dmMirror(t); } catch (e) { log("dm mirror sweep failed (isolated): " + (e && e.message)); } }
  }, 30 * 1000).unref();

  // ===== usage, the operator's side (build 2026.09.24-109) =======================================
  // Beside the read-through, not inside it: adminOnly / adminUid are that block's gates, reused.
  // The sitewide panel is aggregates and is NOT logged; one member's drill-in IS (dm_audit
  // 'view-usage', shown in the All messages read log beside every message read). The panel body is
  // cached per range and keyed on the flush generation, the member count and who is online, so an
  // unchanged minute revalidates to a 304 like every other admin payload.
  const usageBodies = new Map();
  fastify.get("/api/admin/usage", (req, reply) => {
    if (!adminOnly(req, reply)) return;
    const r = Math.max(1, Math.min(ACCOUNTS.USAGE_KEEP_DAYS, Math.trunc(+one((req.query || {}).r) || 7)));
    if (ACCOUNTS.usagePending()) ACCOUNTS.usageFlush();
    const online = dmOnline();
    const stale = usageStale();   // (build 2026.09.24-110) in memory, so it joins the cache key
    const key = [BOOT_NONCE, ACCOUNTS.usageGen(), r, ACCOUNTS.countUsers(), [...online].sort().join(","), stale, Math.floor(Date.now() / 60000)].join(".");
    let hit = usageBodies.get(r);
    if (!hit || hit.key !== key) {
      // (build 2026.09.24-112) navOrder: the ribbon's movable tabs as the menus hold them now, for the
      // read-only "suggested order" line (a menu move is a usage_mark, which bumps the cache key)
      let navOrder = null;
      try { navOrder = poller.getNavGroups().reduce((a, g) => a.concat(g.views || []), []); } catch (_) {}
      const body = ACCOUNTS.usageSummary({ r, online, tabs: USAGE_TABS(), build: VERSION, stale, navOrder });
      body.publicOn = USAGE_PUBLIC; body.beacon = true;
      hit = { key, body, tag: 'W/"u' + crypto.createHash("sha1").update(key).digest("base64url").slice(0, 16) + '"' };
      usageBodies.set(r, hit);
    }
    return sendCachedBody(req, reply, hit.body, hit.tag);
  });
  fastify.get("/api/admin/usage/member", (req, reply) => {
    reply.header("cache-control", "no-store");
    if (!adminOnly(req, reply)) return;
    const r = ACCOUNTS.usageMember(adminUid(req), str((req.query || {}).h) || "", USAGE_TABS());
    if (!r.ok) return reply.code(404).send(r);
    return r;
  });
  // (build 2026.09.24-111) Error triage: the operator marks one distinct error (its signature —
  // '<file>|<message hash>', never text) resolved or open again. Admin-only; like every POST here it
  // is refused cross-site before any handler runs (the Sec-Fetch-Site hook) and rides SameSite=Lax
  // cookies. The list itself is in GET /api/admin/usage (health.triage); a toggle bumps its cache key.
  fastify.post("/api/admin/usage/errors", { bodyLimit: 1024 }, (req, reply) => {
    reply.header("cache-control", "no-store");
    if (!adminOnly(req, reply)) return;
    const b = req.body || {};
    const r = ACCOUNTS.usageTriageSet(typeof b.sig === "string" ? b.sig : "", b.resolved === true);
    if (!r.ok) return reply.code(r.error === "no such error" ? 404 : 400).send(r);
    return r;
  });
  // (build 2026.09.24-111) The post-deploy regression check, on main()'s 60s usage flush: once this
  // build is ready (≥ 20 page loads or 2h live), each condition that holds against the previous
  // known build is sent ONCE — through the ops lane (poller.pushOps: the ring, the operator's
  // Telegram and push, like every other server-health alert). The dedupe is a usage_mark row, so a
  // restart never re-sends. The alert names a file:line and counts; the browser-supplied message
  // goes out with markup characters removed (it rides a Telegram HTML message).
  const usageRegWord = (c) => {
    const tg = (x) => String(x == null ? "" : x).replace(/[<>&]/g, " ").slice(0, 120);
    if (c.kind === "new-errors") return c.n + " new error" + (c.n === 1 ? "" : "s") + " hit by \u2265" + ACCOUNTS.USAGE_REG.errMembers + " members \u2014 top: "
      + tg(c.top.loc) + (c.top.msg ? " \u00b7 " + tg(c.top.msg) : "") + " (" + c.top.members + " members, " + c.top.hits + " hits)";
    if (c.kind === "err-rate") return "error hits per page load up " + c.x.toFixed(1) + "\u00d7 (" + c.rate.toFixed(2) + " vs " + (c.ratePrev || 0).toFixed(2) + ", " + c.hits + " hits in " + c.loads + " loads)";
    if (c.kind === "perf") return "p75 first paint " + (c.p75 / 1000).toFixed(1) + "s vs " + (c.p75Prev / 1000).toFixed(1) + "s (+" + Math.round((c.p75 / c.p75Prev - 1) * 100) + "%)";
    return c.kind;
  };
  function usageRegressTick(now) {
    const t = now != null ? now : Date.now();
    const v = ACCOUNTS.usageRegress(VERSION, t);
    ACCOUNTS.usageTriageSweep(t);   // a resolved error that recurred on a newer build reopens even while nobody looks
    let sent = 0;
    if (v.state === "regression") for (const c of v.conds) {
      if (!ACCOUNTS.usageAlertOnce(VERSION, c.kind, t)) continue;
      sent++;
      if (poller && poller.pushOpsNow) poller.pushOpsNow("usage: regression on build " + VERSION, usageRegWord(c) + " \u2014 vs build " + v.prev + ". Admin \u00b7 Usage \u00b7 Client health.", "warn");
      log("usage regression alert (" + c.kind + "): build " + VERSION + " vs " + v.prev);
    }
    return { state: v.state, sent };
  }
  USAGE_REGRESS = usageRegressTick;
  fastify.decorate("usageRegressTick", usageRegressTick);
  // ===== /alert: threshold rules written in a conversation (build 2026.09.21-83) ==================
  // The same line works in a chat's composer and at the Telegram bot. A rule written IN a
  // conversation is bound to it: when it fires, the fire posts there under its author's name
  // (badged as a command result), so the whole room sees it, a synced phone mirrors it and the
  // offline digest nudges the rest. The rule itself is the existing owner-scoped engine — same
  // hysteresis, cooldown, cap and persistence as one written in the alerts panel.
  const ruleOpWord = (op) => RULE_OP_LABEL[op] || op;
  function dmAlertCmd(me, text, threadId, o) {
    const opts = o || {};
    const thread = threadId && ACCOUNTS.isMember(threadId, me.uid) ? +threadId : 0;
    const p = parseAlertCmd(text);
    if (!p.ok) return { ok: false, error: p.error };
    const where = (t) => (t ? (t === thread ? "here" : "in " + ((ACCOUNTS.threads(me.uid).find((x) => x.id === t) || {}).name || "another conversation")) : (opts.tg ? "here" : "on your phone"));
    if (p.action === "help") return { ok: true, text: ALERT_HELP + (thread ? "" : (opts.tg ? "\nNo conversation is synced to this chat, so an alert set here reaches only your phone." : "")), private: true };
    if (p.action === "list") {
      const mine = poller.getRules(me.uid, false).rules;
      return { ok: true, private: true, text: mine.length
        ? mine.map((r) => "#" + r.id + " \u00b7 " + r.text + (r.note ? " \u2014 " + r.note : "") + " \u2192 " + where(r.thread)).join("\n")
        : "No alerts yet. /alert NVDA > 200 sets one." };
    }
    if (p.action === "off") {
      const r = poller.deleteRule(p.id, me.uid, false);
      if (!r.ok) return { ok: false, error: r.error === "forbidden" ? "that alert isn't yours" : "no alert #" + p.id };
      const out = { ok: true, text: "\ud83d\udd15 alert #" + p.id + " off: " + r.rule.text };
      // Announced where it used to fire, so the room learns the watch is gone.
      if (r.rule.thread && ACCOUNTS.isMember(r.rule.thread, me.uid)) {
        const post = ACCOUNTS.send(me.uid, null, out.text, null, { thread: r.rule.thread, cmd: "alert off " + p.id });
        if (post.ok) { out.message = post.message; out.thread = post.thread; dmPoke(post.thread); dmMirror(post.thread); }
      }
      return out;
    }
    const rule = p.rule;
    if (rule.ticker) {
      const coin = coinForSymbol(rule.ticker);
      if (!coin) return { ok: false, error: "no market called " + rule.ticker + " on the board" };
      rule.coin = coin; delete rule.ticker;
    }
    rule.thread = thread;
    const r = poller.addRule(rule, me.uid);
    if (!r.ok) return { ok: false, error: r.error === "cap" ? "you already have the maximum number of alerts \u2014 /alert off one first" : "could not set that alert (" + r.error + ")" };
    usageActFor(me.uid, "alert");   // (build 2026.09.24-110) a rule created — from a chat, the bot or the panel below
    const line = "\ud83d\udd14 alert #" + r.rule.id + " \u00b7 " + r.rule.text + (r.rule.note ? " \u2014 " + r.rule.note : "") + " \u2192 fires " + where(thread);
    const out = { ok: true, text: line, rule: r.rule };
    if (thread) {
      const post = ACCOUNTS.send(me.uid, null, line, null, { thread, cmd: "alert " + String(text || "").replace(/\s+/g, " ").trim().slice(0, 120) });
      if (post.ok) { out.message = post.message; out.thread = post.thread; dmPoke(post.thread); dmMirror(post.thread); }
    }
    return out;
  }
  // The fire. Buffered a tick and posted once per conversation: a roster-wide rule ("any rvol >
  // 3") can trip on twenty names in one scan, and twenty posts would be a wall where one list is
  // the answer — and would trip the per-sender burst limit besides.
  // "NVDA · price crosses up through the 200d MA — now +3.00%": the rule's own sentence past its
  // scope (ev.rule is "<scope> · <sentence>"), then the value that tripped it.
  const sentence = (ev) => { const i = String(ev.rule || "").indexOf(" \u00b7 "); return i >= 0 ? ev.rule.slice(i + 3) : ev.label + " " + ruleOpWord(ev.op) + " " + ev.value; };
  const ruleFireBuf = new Map();   // "thread|owner" -> { thread, owner, evs: [] } — one post per author per conversation
  let ruleFireArmed = false;
  function ruleFireFlush() {
    ruleFireArmed = false;
    const batches = [...ruleFireBuf.values()]; ruleFireBuf.clear();
    for (const b of batches) {
      const thread = b.thread;
      // Membership re-checked at fire time: a rule outlives leaving the room, and must not post
      // into a conversation its author can no longer read. Not a silent drop either: the rule is
      // unbound (it becomes the plain personal rule it would have been) and THIS fire goes to the
      // author's phone directly, since the event on the wire was already marked quiet.
      if (!ACCOUNTS.isMember(thread, b.owner)) {
        const ids = [...new Set(b.evs.map((ev) => ev.ruleId))];
        for (const id of ids) { try { poller.setRuleThread(id, 0); } catch (_) {} }
        log("rule fire: author is no longer in conversation " + thread + " — rule(s) " + ids.map((i) => "#" + i).join(" ") + " unbound, fire sent to their phone");
        if (poller.pushEnqueueNow && poller.pushRecipientsFor) {
          const text = "\ud83d\udd14 <b>alert</b> (no longer in that conversation \u2014 now a personal alert)\n"
            + b.evs.map((ev) => tgEsc(ev.t + " \u00b7 " + sentence(ev) + " \u2014 now " + ev.now + (ev.note ? " \u00b7 " + ev.note : ""))).join("\n");
          for (const chat of poller.pushRecipientsFor(b.owner)) poller.pushEnqueueNow(chat, text, false);
        }
        continue;
      }
      const lines = b.evs.map((ev) => "\ud83d\udd14 " + ev.t + " \u00b7 " + sentence(ev) + " \u2014 now " + ev.now + (ev.note ? " \u00b7 " + ev.note : ""));
      const ids = [...new Set(b.evs.map((ev) => "#" + ev.ruleId))].join(" ");
      const post = ACCOUNTS.send(b.owner, null, lines.join("\n"), null, { thread, cmd: "alert " + ids + " fired" });
      if (!post.ok) { log("rule fire post failed: " + post.error); continue; }
      dmPoke(thread); dmMirror(thread);
    }
  }
  if (poller.setRuleSink) poller.setRuleSink((rule, ev) => {
    const key = rule.thread + "|" + (rule.owner || "");
    let b = ruleFireBuf.get(key);
    if (!b) { b = { thread: rule.thread, owner: rule.owner || "", evs: [] }; ruleFireBuf.set(key, b); }
    b.evs.push(ev);
    if (!ruleFireArmed) { ruleFireArmed = true; setImmediate(() => { try { ruleFireFlush(); } catch (e) { log("rule fire flush failed (isolated): " + (e && e.message)); } }); }
  });

  // ===== call targets: the resolver (build 2026.09.24-95) ============================================
  // Once a minute, every open target is checked against the 5m archive, the live mark and (past its
  // deadline) the deadline's daily close; ACCOUNTS.targetSweep writes each resolution once and hands
  // back the line to post. The post takes the road a bound /alert fire takes: a command result under
  // the AUTHOR's name, in the conversation the call was made in — so the room sees it, a synced phone
  // mirrors it and the offline digest nudges the rest. Nothing new on the wire. The stamped row is
  // re-pulled too (the `refresh` hint), so every open copy of the call repaints resolved. An author
  // who has left the room (or is over the burst cap) gets no post; the resolution stands on the row.
  function targetTick(now) {
    let done;
    try { done = ACCOUNTS.targetSweep(now); } catch (e) { log("target sweep failed (isolated): " + (e && e.message)); return 0; }
    for (const r of done) {
      dmPoke(r.thread, { refresh: Number(r.thread) });
      const post = ACCOUNTS.send(r.sender, null, r.text, null, { thread: r.thread, cmd: "target $" + String(r.ref).replace(/^xyz:/, "") + " " + r.res });
      if (!post.ok) { log("target post failed (message " + r.id + ", " + r.res + "): " + post.error); continue; }
      dmPoke(post.thread); dmMirror(post.thread);
    }
    return done.length;
  }
  setInterval(() => { try { targetTick(); } catch (e) { log("target tick failed (isolated): " + (e && e.message)); } }, 60 * 1000).unref();

  // Sign-out is a state change, so it answers POST. GET stays for the nav button's plain
  // navigation (location.href='/logout') — but only when the browser says the navigation came
  // from this origin or from nowhere (typed URL, bookmark): a cross-site <img src="/logout"> or
  // a link on somebody else's page used to sign the whole desk out at will. Non-browser callers
  // send no Sec-Fetch-Site and are not what the check is for.
  const logout = async (req, reply) => {
    if (req.method === "GET") {
      const site = String(req.headers["sec-fetch-site"] || "").toLowerCase();
      if (site && site !== "same-origin" && site !== "none")
        return reply.code(403).header("cache-control", "no-store").send({ error: "cross-site sign-out refused" });
    }
    setSessionCookies(reply, req, 0, null);   // Max-Age=0 deletes both cookies
    setAdminCookies(reply, req, 0, null);     // signing out drops elevation — never leave a stale admin lease
    clearAiUnlockCookie(reply, req);          // and the AI unlock, which outlives nothing
    return reply.redirect("/", 303);   // v5-forward signature (url, code) — the old order is deprecated
  };
  fastify.get("/logout", logout);
  fastify.post("/logout", logout);

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
  // The worker grew push handlers (build -66) and moved to its own file; the inline string
  // survives only as the fallback if the file ever goes missing — installability must not break.
  const PWA_SW = (() => {
    // The "{{build}}" slot names the ONLY asset stamp the worker may cache (build 2026.09.24-103) —
    // and makes every deploy's sw.js byte-different, so the browser installs the new worker and its
    // activate purges last build's asset cache.
    try { return fs.readFileSync(path.join(__dirname, "public", "sw.js"), "utf8").split("{{build}}").join(VERSION); }
    catch (_) { return "self.addEventListener('install',()=>self.skipWaiting());self.addEventListener('activate',e=>e.waitUntil(self.clients.claim()));self.addEventListener('fetch',()=>{});"; }
  })();
  fastify.get("/manifest.webmanifest", async (req, reply) => reply.type("application/manifest+json").header("cache-control", "no-cache").send(PWA_MANIFEST));
  fastify.get("/icon.svg", async (req, reply) => reply.type("image/svg+xml").header("cache-control", "no-cache").send(PWA_ICON));
  fastify.get("/sw.js", async (req, reply) => reply.type("text/javascript").header("cache-control", "no-cache").send(PWA_SW));

  // threshold: don't spend gzip CPU on bodies under 1 KB (health, channel lists, empty fallbacks) —
  // the compressed result is no smaller and often larger. Big payloads (snapshot, analytics) still compress.
  // Baseline hardening headers on EVERY response (API, shell, login page, static assets alike).
  // nosniff stops MIME confusion across the JSON/HTML mix; DENY forbids framing outright —
  // nothing here is ever legitimately embedded, and a framed login page is a phishing kit;
  // same-origin referrer keeps versioned asset URLs and API paths from leaking to any external
  // link a report might one day carry. The Content-Security-Policy rides the same hook, report-only
  // with a per-request nonce on the shell's inline scripts (see cspPolicy above).
  fastify.addHook("onSend", async (req, reply, payload) => {
    reply.header("x-content-type-options", "nosniff");
    reply.header("x-frame-options", "DENY");
    reply.header("referrer-policy", "same-origin");
    if (((TRUST_PROXY && req.headers["x-forwarded-proto"]) || req.protocol) === "https") reply.header("strict-transport-security", "max-age=15552000");
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
    // HTML pages: mint the nonce, stamp it into every slot and name it in the report-only policy.
    // Streams (static files) and JSON never carry the slot, so they pass through untouched. Last
    // in the hook on purpose: returning a payload ends it, and every header above must still land.
    if (typeof payload === "string" && /^text\/html/i.test(String(reply.getHeader("content-type") || ""))) {
      const nonce = crypto.randomBytes(16).toString("base64");
      reply.header(CSP_HEADER, cspPolicy(nonce));
      reply.header("reporting-endpoints", 'csp="/api/csp-report"');
      if (payload.includes(CSP_NONCE_SLOT)) return payload.split(CSP_NONCE_SLOT).join(nonce);
    }
  });

  await fastify.register(require("@fastify/compress"), { global: true, encodings: ["gzip", "deflate"], threshold: 1024 });
  await fastify.register(require("@fastify/static"), {
    root: path.join(__dirname, "public"),
    prefix: "/",
    index: false,   // index.html is served by the explicit routes below, version-stamped
    dotfiles: "deny",   // the plugin's default is allow: a stray .env copied into public/ would be served
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
  // The client is ES modules (build 2026.09.16-80): app.js is the entry and public/js/*.js are the
  // modules it imports. Every import specifier is stamped with ?v=VERSION at boot, so a module URL
  // is as immutable as the entry's — a browser can never pair this build's entry with last build's
  // module, and every module rides the immutable-cache tier below. The files on disk stay
  // unstamped: tests and editors read plain modules.
  // Dynamic import("./x.js") is stamped too (build 2026.09.24-103): core.js lazy-loads the tab-only
  // modules by literal specifier, and an unstamped lazy URL would be a SECOND module instance of a
  // file its eager neighbours import stamped — two copies of its state, and no immutable caching.
  const stampImports = (js) => js.replace(/((?:^|[\s;>(])import\s*(?:\(\s*|[^'"(]*?\s*from\s*)?["'])(\.{1,2}\/[^'"?]+\.js)(["'])/g, (m, a, spec, q) => a + spec + "?v=" + VERSION + q);
  // (build 2026.09.24-108) A stamped asset request from ANOTHER build is refused, not answered with
  // this build's bytes. The routes above ignore the query, so a tab open across a deploy that lazily
  // imported ./charts.js?v=<old> got THIS build's charts.js, whose stamped imports name
  // ./core.js?v=<new> — a second core.js instance with an empty state, and a tab that renders
  // nothing. 409 (no-store: never cached, by the browser or the service worker, which keeps 200s only)
  // makes the import fail; the client's lazy loader then offers the reload. Only when `v` is present
  // and different: unstamped and current-stamp requests are exactly as before.
  const STAMPED_ASSET = /^\/(?:app\.js|styles\.css|js\/[a-z0-9_-]+\.js)$/;
  fastify.addHook("onRequest", async (req, reply) => {
    const u = req.url, q = u.indexOf("?");
    if (q < 0 || !STAMPED_ASSET.test(u.slice(0, q))) return;
    const v = new URLSearchParams(u.slice(q + 1)).getAll("v");
    if (!v.length || (v.length === 1 && v[0] === VERSION)) return;
    reply.code(409).header("cache-control", "no-store").type("text/plain; charset=utf-8")
      .send("stale build: this server is on " + VERSION + " \u2014 reload the page");
    return reply;
  });
  const CLIENT_MODULES = (() => { try { return fs.readdirSync(path.join(__dirname, "public", "js")).filter((f) => /^[a-z0-9_-]+\.js$/.test(f)).sort(); } catch (_) { return []; } })();
  const PRECOMP = (() => {
    const out = {};
    for (const [route, file, type] of [["/app.js", "app.js", "text/javascript; charset=utf-8"],
                                       ["/styles.css", "styles.css", "text/css; charset=utf-8"],
                                       ...CLIENT_MODULES.map((f) => ["/js/" + f, "js/" + f, "text/javascript; charset=utf-8"])]) {
      try {
        let raw = fs.readFileSync(path.join(__dirname, "public", file));
        if (/\.js$/.test(file)) raw = Buffer.from(stampImports(raw.toString("utf8")), "utf8");
        const br = zlib.brotliCompressSync(raw, { params: {
          [zlib.constants.BROTLI_PARAM_QUALITY]: 11,
          [zlib.constants.BROTLI_PARAM_SIZE_HINT]: raw.length } });
        const gz = zlib.gzipSync(raw, { level: 9 });
        // Strong content identity for the ETag: two builds shipping identical bytes revalidate
        // across the deploy, and any byte change is a new tag — never keyed on VERSION alone.
        const tag = 'W/"' + crypto.createHash("sha1").update(raw).digest("base64url") + '"';
        out[route] = { raw, br, gz, type, tag };
        if (!file.startsWith("js/")) log(`precompressed ${file}: raw ${(raw.length / 1024).toFixed(0)} KB \u2192 br ${(br.length / 1024).toFixed(0)} KB \u00b7 gz ${(gz.length / 1024).toFixed(0)} KB`);
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
    // modulepreload hints (build 2026.09.24-103) carry the same stamp, or the preload would warm a
    // URL the entry's stamped imports never ask for.
    h = h.replace(/(<link rel="modulepreload" href="\/js\/[a-z0-9_-]+\.js)(")/g, (m, a, q) => a + "?v=" + VERSION + q);
    h = h.split("<script>").join(`<script nonce="${CSP_NONCE_SLOT}">`);   // inline scripts only: the src= tag never matches
    if (!a || !c) log("WARN: index.html asset tags drifted — version stamp incomplete (cache-busting degraded, app still serves)");
    const i = h.indexOf(FLAG_SLOT);
    if (i < 0) { log("WARN: index.html flag slot missing — feature visibility will not be injected (server gate still enforces; tabs may show and 403)"); return [h, ""]; }
    return [h.slice(0, i), h.slice(i + FLAG_SLOT.length)];
  })();
  // The pre-paint boot script, resolved for THIS caller: feature set, admin flag, nav labels and
  // identity. Nav labels ride it because the ribbon must paint with the admin's names on the FIRST
  // frame, or every load flashes the defaults before a fetch could correct them; identity rides it
  // for the same reason, so the header never shows a signed-out state to a signed-in member.
  // jsonForScript, not JSON.stringify: nav labels and display names are operator/member text,
  // and "</script><script>" in either used to run in every member's shell.
  const bootScript = (admin, me) =>
    "window.__FLAGS=" + jsonForScript(resolveFeatures(poller.getFlags(), admin)) +
    ";window.__ADMIN=" + (admin ? "true" : "false") +
    ";window.__NAVGROUPS=" + jsonForScript(poller.getNavGroups()) +
    ";window.__ME=" + jsonForScript(me ? Object.assign(ACCOUNTS.pub(me), { usagePaused: ACCOUNTS.usagePaused(me.uid) }) : null) + ";";   // -109: the beacon starts paused when the member paused it
  const serveIndex = (req, reply) => {
    const admin = isAdmin(req);
    const boot = bootScript(admin, meOf(req));
    // Already no-store, so there is no cache to poison with the wrong audience's shell — the reason
    // this per-request body is safe where a cached one would not be.
    return reply.header("cache-control", "no-store").type("text/html; charset=utf-8").send(INDEX_HEAD + boot + INDEX_TAIL);
  };
  fastify.get("/", serveIndex);
  fastify.get("/index.html", serveIndex);

  // ===== documentation (build 2026.09.21-85) ====================================================
  // /docs is the manual (public/docs.html) and /docs/ref/<page> the reference pages under docs/ —
  // two of them for members (explainer, howto), the rest for whoever wants the engine's detail.
  // Both are HTML the server emits, so they take the two stamps the shell takes: the caller's
  // resolved feature set (a section about a tab this member cannot see is never in the markup they
  // receive — same audience rule as the ribbon) and the CSP nonce on every inline script. Read once
  // at boot, build-stamped; a missing or unreadable file makes the route answer 404 and is said out
  // loud at boot rather than failing it — the app must never refuse to start because a manual moved.
  // Explicit routes win over @fastify/static by radix specificity, so /docs.html never reaches the
  // static fallback unstamped. No feature claims these paths, so the site gate alone decides.
  const loadDocPage = (file) => {
    try {
      return fs.readFileSync(file, "utf8")
        .split("<script>").join(`<script nonce="${CSP_NONCE_SLOT}">`)   // inline scripts only, same as the shell
        .split("{{build}}").join(VERSION);
    } catch (e) { log(`WARN: docs page ${path.basename(file)} unreadable (${e.message}) \u2014 its route answers 404`); return null; }
  };
  const DOCS_HTML = loadDocPage(path.join(__dirname, "public", "docs.html"));
  const serveDocs = (req, reply) => {
    if (!DOCS_HTML) return reply.code(404).header("cache-control", "no-store").send({ error: "docs not available" });
    const boot = bootScript(isAdmin(req), meOf(req));
    // Audience-specific like the shell, hence no-store like the shell.
    return reply.header("cache-control", "no-store").type("text/html; charset=utf-8")
      .send(DOCS_HTML.includes(FLAG_SLOT) ? DOCS_HTML.split(FLAG_SLOT).join(boot) : DOCS_HTML);
  };
  fastify.get("/docs", serveDocs);
  fastify.get("/docs.html", serveDocs);
  const DOC_REFS = { explainer: "xyz-monitor-explainer.html", howto: "xyz-monitor-how-to-use.html",
                     signals: "xyz-monitor-signal-reference.html",
                     features: "xyz-monitor-features.html",
                     map: "xyz-monitor-map.html", mechanics: "xyz-monitor-mechanics.html" };
  const DOC_REF_HTML = {};
  for (const [k, f] of Object.entries(DOC_REFS)) { const h = loadDocPage(path.join(__dirname, "docs", f)); if (h) DOC_REF_HTML[k] = h; }
  fastify.get("/docs/ref/:page", (req, reply) => {
    const h = DOC_REF_HTML[String(req.params.page || "")];
    if (!h) return reply.code(404).header("cache-control", "no-store").send({ error: "no such reference page", pages: Object.keys(DOC_REF_HTML) });
    return reply.header("cache-control", "no-cache").type("text/html; charset=utf-8").send(h);
  });
  // The screenshots the member guides embed live under docs/img/ and are served here, behind the
  // same gate as the pages that reference them. A strict name pattern is the whole path check —
  // no dots, no slashes, so nothing outside the folder can be named — and an unknown file is a
  // plain 404. no-cache like the pages: a redeploy that swaps a screenshot must show the new one.
  const DOC_IMG_DIR = path.join(__dirname, "docs", "img");
  const DOC_IMG_TYPES = { jpg: "image/jpeg", png: "image/png", webp: "image/webp", svg: "image/svg+xml" };
  fastify.get("/docs/ref/img/:file", (req, reply) => {
    const m = /^([a-z0-9-]{1,80})\.(jpg|png|webp|svg)$/.exec(String(req.params.file || ""));
    if (!m) return reply.code(404).header("cache-control", "no-store").send({ error: "no such image" });
    let buf;
    try { buf = fs.readFileSync(path.join(DOC_IMG_DIR, m[0])); }
    catch (_e) { return reply.code(404).header("cache-control", "no-store").send({ error: "no such image" }); }
    return reply.header("cache-control", "no-cache").type(DOC_IMG_TYPES[m[2]]).send(buf);
  });

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
    // The empty fallback always carries dataTs 0, so without mixing the error text into the validator
    // a freshly-recorded failure reason would sit behind a 304 and never reach the tab.
    const errKey = built ? "" : "-e" + (buildErr ? buildErr.length : 0);
    const tag = 'W/"' + scope + "-" + (body.dataTs != null ? body.dataTs : (body.ts || 0)) + errKey + '"';
    // Through the shared memoized serialize + threadpool gzip (build 2026.09.24-101), like
    // /api/funding: this route used to JSON.stringify the full analytics body on every non-304
    // request and leave compression to the per-response path. The built payload is one stable
    // object per rebuild, so the WeakMap memo hits for every client until the next build.
    return sendCachedBody(req, reply, body, tag);
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
  // D1 retest study (build 2026.09.24-96): the Trend board's D1 RETEST replayed over every name's
  // closed daily history vs the same names' stacked-but-not-retesting bars. Gated with the
  // Backtest tab (its manifest routes), admin while it soaks. ?u= scope, ?def= board|touch,
  // ?cd= cooldown bars — anything else normalises to the defaults server-side. The ETag is the
  // poller's walk signature (scope, definition, cooldown and every contributing name's walk
  // version), so a poll is a 304 until a closed bar actually changed what the study reads.
  fastify.get("/api/retest-study", (req, reply) => {
    const q = req.query || {};
    const body = poller.getD1Retest(q.u === "crypto" ? "crypto" : "stocks", String(q.def || ""), q.cd);
    // (build 2026.09.24-107) the build and this boot are in the tag, never only a per-process counter
    return sendCachedBody(req, reply, body, 'W/"rt-' + VERSION + "-" + BOOT_NONCE + "-" + body.key + '"');
  });
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
  // ---- adopting an already-linked Telegram -------------------------------------------------------
  // A member signs in on a terminal whose bot already messages their phone — linked before accounts
  // existed, or from a browser cookie that is not this account. Offered are ONLY chats no live
  // account owns (a teammate's properly-linked chat is never on the list), and ownership moves only
  // after a code sent TO that chat is typed back: control of the Telegram account is the proof,
  // exactly the claim /start makes.
  const adoptCandidates = (me) => (poller.pushAdoptRoster ? poller.pushAdoptRoster() : [])
    .filter((r) => r.owner !== me.uid && !(r.owner && ACCOUNTS.getUser(r.owner)))
    .map((r) => ({ chat: r.chat, name: r.name, mask: r.mask }));
  fastify.get("/api/alerts/adoptable", (req, reply) => {
    reply.header("cache-control", "no-store");
    const me = meOf(req);
    if (!me) return reply.code(401).send({ ok: false, error: "sign in first" });
    return { ok: true, candidates: adoptCandidates(me) };
  });
  fastify.post("/api/alerts/adopt", { bodyLimit: 4 * 1024 }, (req, reply) => {
    reply.header("cache-control", "no-store");
    const me = meOf(req);
    if (!me) return reply.code(401).send({ ok: false, error: "sign in first" });
    const b = req.body || {};
    const chat = String(b.chat || "");
    // The offer list is the authorization for a REQUEST: a chat owned by a live account cannot
    // even be asked about, so the code message never lands in a properly-linked teammate's chat.
    if (!adoptCandidates(me).some((c) => c.chat === chat))
      return reply.code(400).send({ ok: false, error: "that chat cannot be claimed" });
    if (b.code != null) {
      const r = poller.pushAdoptVerify(chat, me.uid, String(b.code || ""));
      if (r.ok) { log(`push: ${me.handle} adopted a linked Telegram (code-verified)`); usageActFor(me.uid, "telegram-link"); }   // (build 2026.09.24-110)
      return reply.code(r.ok ? 200 : 400).send(r);
    }
    const r = poller.pushAdoptRequest(chat, me.uid);
    if (!r.ok) return reply.code(r.error === "throttled" ? 429 : 400).send({ ok: false, error:
      r.error === "throttled" ? "too many codes sent to that chat — try again in a bit" : "that chat cannot be claimed" });
    poller.pushEnqueueNow(chat, "<b>Link this chat to " + tgEsc(me.display) + "?</b>\n"
      + "Someone signed in as <b>" + tgEsc(me.display) + "</b> on the terminal says this Telegram is theirs.\n"
      + "Their code is <b>" + r.code + "</b> — good for " + r.ttlMin + " minutes.\n"
      + "<i>If this isn't you, ignore this message and tell the operator.</i>", true);
    log("push: adopt code sent (chat masked) for " + me.handle);
    return { ok: true, sent: true, name: r.name };
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
    const fn = b.kind === "landscape" ? poller.landTest : b.kind === "desk" ? poller.deskTest : poller.briefTest;
    const r = await fn(b.chat || null, ownerFor(req, reply), true, !!b.fresh, !!b.operator || !!b.mine);
    return reply.code(r.ok ? 200 : 400).send(r);
  });

  // User-authored metric rules: the threshold alerts, group-shared and server-evaluated so they
  // keep firing with every tab closed. no-store — the list is small and edits must be visible to
  // the next reader immediately.
  fastify.get("/api/alerts/rules", (req, reply) => {
    const own = ownerFor(req, reply);
    const body = poller.getRules(own, isAdmin(req));
    // A conversation-bound rule names the conversation, for the caller who can see it. The poller
    // knows only the id; the name is this member's own view of the thread (a DM is named after
    // the other person), so it is resolved here and only for threads they are in.
    const me = meOf(req);
    if (me && body.rules.some((r) => r.thread)) {
      const names = new Map(ACCOUNTS.threads(me.uid).map((t) => [t.id, t.name]));
      for (const r of body.rules) if (r.thread) r.threadName = names.get(r.thread) || null;
    }
    return reply.header("cache-control", "no-store").send(body);
  });
  fastify.post("/api/alerts/rules", { bodyLimit: 16 * 1024 }, (req, reply) => {
    const b = req.body || {};
    const own = ownerFor(req, reply);
    // A conversation binding is only ever written by /alert from inside the conversation; the
    // panel form never sends one, and one arriving here is checked the same way (a member of it).
    if (b.del == null && b.thread) {
      const me = meOf(req);
      if (!me || !ACCOUNTS.isMember(b.thread, me.uid)) return reply.code(400).send({ ok: false, error: "no such conversation" });
    }
    const r = b.del != null ? poller.deleteRule(b.del, own, isAdmin(req)) : poller.addRule(b, own);
    if (r.ok && b.del == null) { const me = meOf(req); if (me) usageActFor(me.uid, "alert"); }   // (build 2026.09.24-110)
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
  // Pre-earnings setup cards (build 2026.09.24-100): names reporting within ~5 sessions — reaction
  // study + positioning into the print + implied-vs-typical + a rule-composed verdict line. Its
  // own route so live positioning never busts the calendar's 304; the poller keeps the payload
  // object (and so the ETag) while the content signature holds, rebuilding at most once a minute.
  fastify.get("/api/earnings/setups", (req, reply) =>
    serveCached(req, reply, poller.getEarnSetups(), { ts: 0, dataTs: 0, sessions: 5, runupD: 7, error: "not built yet", cards: [], count: 0 }));
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
  fastify.post("/api/earnings/void", { bodyLimit: 4 * 1024 }, (req, reply) => {
    if (!isAdmin(req)) return reply.code(403).send({ ok: false, error: "forbidden" });   // gate and authz are different axes: a flag flip must not open ledger tombstoning
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
      { coin, oi: [], funding: [] }, "series|" + coin);   // slot: a new stamp replaces the old version (build 2026.09.24-102)
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
  fastify.post("/api/news/channels", { bodyLimit: 8 * 1024 }, (req, reply) => {
    if (!isAdmin(req)) return reply.code(403).send({ ok: false, error: "forbidden" });   // same: the outbound fetch list is an operator's to set
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
  const grid5m = (v, up) => (v != null && v !== "" && Number.isFinite(+v) ? (up ? Math.ceil(+v / 300000) : Math.floor(+v / 300000)) * 300000 : "");
  const intOr = (v) => (v != null && v !== "" && Number.isFinite(+v) ? Math.trunc(+v) : "");
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
      // from/to snapped to the 5m grid BEFORE the key (a 1ms change used to mint a fresh entry).
      const from = grid5m(req.query.from, false), to = grid5m(req.query.to, true), max = intOr(req.query.max);
      const key = "candles5m|" + coin + "|" + from + "|" + to + "|" + max + "|" + (poller.getM5Stamp ? poller.getM5Stamp(coin) : 0);
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
    let key, slot;
    const cfast = req.query && req.query.fast, cslow = req.query && req.query.slow;
    const cpair = (cfast != null || cslow != null) ? `|ma:${cfast || ""}-${cslow || ""}` : "";
    if (tf) { const cs = poller.getCoinStamp(coin);
      const bucket = cs.px > 0 ? Math.round(Math.log(cs.px) * 1000) : 0;   // ~0.1% granularity, scale-free
      slot = "candles|" + coin + "|tf:" + String(tf).toLowerCase() + cpair;   // one live version per chart: a new price bucket or stamp replaces it (build 2026.09.24-102)
      key = slot + "|" + cs.st + "|" + bucket; }
    else { slot = "candles|" + coin + "|d:" + (days || 14); key = slot + "|" + poller.getCoinStamp(coin).st; }
    serveKeyed(req, reply, key, () => {
      if (tf) { const r = poller.getTfCandles(coin, tf, cfast, cslow); if (r) return r; }
      return { coin, candles: poller.getCandles(coin, days) };
    }, { coin, candles: [] }, slot);
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
    if (r && r.ok) { const me = meOf(req); if (me) usageActFor(me.uid, "ai-report"); }   // (build 2026.09.24-110)
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
    const r = poller.resetAiDay(String((req.body || {}).password || ""), req.ip);
    return reply.code(r.ok ? 200 : (r.error === "rate" ? 429 : r.error === "not-configured" ? 503 : 403)).send(r);
  });
  // Admin AI unlock: verify ADMIN_PASSWORD (same constant-time compare + shared lockout as the
  // budget reset), then mint the xyzai unlock cookie. This is the ONLY way to open AI generation;
  // there is no header/script path. Body is just { password } — 8 KB cap like the reset route.
  fastify.post("/api/ai-unlock", { bodyLimit: 8 * 1024 }, async (req, reply) => {
    reply.header("cache-control", "no-store");
    const r = poller.checkAdminPassword(String((req.body || {}).password || ""), req.ip);
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
  // The composer's backup reader (build 2026.09.22-89): a structured reading of one message's
  // call, for the sender to apply or ignore. Gated exactly as an ask from a chat (dm.ask over
  // ai.ask), because it spends the same budget.
  fastify.post("/api/dm/call-read", { bodyLimit: 8 * 1024 }, async (req, reply) => {
    reply.header("cache-control", "no-store");
    const me = dmMe(req, reply); if (!me) return;
    // ai.ask first (the operator's model-spend switch: off means nobody, admin included), then
    // dm.ask on top, exactly as an ask from a chat composer is gated.
    if (!featureVisible(poller.getFlags(), "ai.ask", isAdmin(req)))
      return reply.code(403).send({ ok: false, error: "feature-gated", feature: "ai.ask" });
    if (!featureVisible(poller.getFlags(), "dm.ask", isAdmin(req)))
      return reply.code(403).send({ ok: false, error: "feature-gated", feature: "dm.ask" });
    const b = req.body || {};
    const sym = String(b.sym || "").toUpperCase().slice(0, 16);
    if (!coinForSymbol(sym)) return reply.code(400).send({ ok: false, error: "no market called " + (sym || "?") + " on the board" });
    return poller.readCall(String(b.text || ""), sym, aiWho(req, reply));
  });
  fastify.post("/api/ask", { bodyLimit: 256 * 1024 }, async (req, reply) => {
    reply.header("cache-control", "no-store");
    const b = req.body || {};
    // Asked from a chat composer (ctx.via = "dm"): the answer is about to be posted where the
    // whole conversation reads it, so the dm.ask key applies ON TOP of ai.ask (which the route
    // gate already enforced above). Belt and braces with the /api/dm check: this one refuses the
    // spend, that one refuses the post; an honest client is stopped here before either costs.
    if (b.ctx && b.ctx.via === "dm" && !featureVisible(poller.getFlags(), "dm.ask", isAdmin(req)))
      return reply.code(403).send({ ok: false, error: "feature-gated", feature: "dm.ask" });
    const r = await poller.askBoard(b.q || "", b.ctx || {}, aiWho(req, reply));
    if (r && r.ok) { const me = meOf(req); if (me) usageActFor(me.uid, "ask"); }   // (build 2026.09.24-110) answered asks only
    return r;
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
  SSE_REGISTRY = sseClients;
  const sseByUid = new Map();            // uid -> Set(entry), for targeted delivery
  const SSE_MAX = 200;
  // A per-member cap on top of the global one: without it a single person with a wall of tabs open
  // can eat the whole pool and lock everybody else onto the poll fallback.
  const SSE_PER_USER = 4;
  // The uid-less entries (break-glass admin, legacy shared-password sessions, Basic auth) have no
  // uid to count under, so they had no cap beyond the global one: one such caller could hold all
  // 200 slots and lock every member onto the poll fallback. Keyed on the same client IP the
  // damper trusts, and only for entries with no uid — a member is counted by uid, never twice.
  const SSE_PER_IP = 4;
  const sseByIp = new Map();             // ip -> Set(entry), uid-less entries only
  function sseAttach(entry) {
    sseClients.add(entry);
    const key = entry.uid || entry.ip, map = entry.uid ? sseByUid : sseByIp;
    if (!key) return;
    let set = map.get(key);
    if (!set) { set = new Set(); map.set(key, set); }
    set.add(entry);
  }
  function sseDetach(entry) {
    sseClients.delete(entry);
    const key = entry.uid || entry.ip, map = entry.uid ? sseByUid : sseByIp;
    const set = key && map.get(key);
    if (set) { set.delete(entry); if (!set.size) map.delete(key); }
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
      v: VERSION, dm: me ? { seq: ACCOUNTS.msgSeq() } : undefined }) + "\n\n";
  }
  const sseWrite = (entry, frame) => sseWriteTo(entry, frame, sseDetach);
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
    const frame = "data: " + JSON.stringify({ dm: Object.assign({ seq: ACCOUNTS.msgSeq() }, extra || {}) }) + "\n\n";
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
    const ip = me ? "" : clientIp(req);
    if (!me && (sseByIp.get(ip) || { size: 0 }).size >= SSE_PER_IP) {
      reply.code(503).send({ error: "sse-per-ip-full" }); return;
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
    const entry = { res, uid: me ? me.uid : "", ip };
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
  setInterval(async () => {
    if (!poller.pushEnqueueNow) return;
    let pending;
    try { pending = ACCOUNTS.pendingEscalations(DM_ESCALATE_MS, (uid) => sseByUid.has(uid),
      (uid) => !!(poller.pushRecipientsFor && poller.pushRecipientsFor(uid).length)); }
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
      // The browser leg of the same escalation: identical eligibility (this loop), plain-text
      // payload — the service worker renders it as a system notification that opens Messages.
      let pushed = false;
      try {
        pushed = await webPushSend(p.uid, { title: p.from + (p.kind === "group" ? " (group)" : ""),
          body: p.n + " unread message" + (p.n === 1 ? "" : "s") + (p.lines.length ? " — " + p.lines[p.lines.length - 1].slice(0, 90) : ""),
          thread: p.thread });
      } catch (_) {}
      // Marked ONLY when something was actually sent. The old "mark either way" burned the
      // notification permanently for members with no Telegram linked — link one a day later and
      // the backlog would never nudge. Left unmarked, the rows come back each tick (a map lookup
      // and a skip, bounded by a desk's thread count) and go out as ONE digest the moment a chat
      // is linked or adopted.
      if (targets.length || pushed) ACCOUNTS.markEscalated(p.uid, p.thread, p.upTo);
    }
  }, 60 * 1000).unref();
  // Telegram sends with parse_mode HTML, so a message body is untrusted markup on that wire exactly
  // as it is in the browser. Escaped here, at the boundary, never stored escaped.
  const tgEsc = (x) => String(x == null ? "" : x)
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

  // `stale` says the poller has not landed a universe poll in five minutes. Still a 200: a 503 would
  // make Railway restart-loop a process whose only problem is upstream. Alert on the flag instead.
  const STALE_MS = 5 * 60 * 1000;
  // ---- positions overlay: the wallet on the account, the positions the lane read for it ---------
  poller.setWalletSource(() => ACCOUNTS.walletsAll());
  poller.setPosPoke((uid) => {
    const set = sseByUid.get(uid);
    if (!set) return;
    const frame = "data: " + JSON.stringify({ pos: { ts: Date.now() } }) + "\n\n";
    for (const e of set) sseWrite(e, frame);
  });
  fastify.get("/api/positions", (req, reply) => {
    reply.header("cache-control", "no-store");
    const me = dmMe(req, reply); if (!me) return;
    const w = ACCOUNTS.walletGet(me.uid);
    if (!w) return { ok: true, wallet: null, positions: [], summary: null, ts: 0, pending: false, err: null };
    return Object.assign({ ok: true, wallet: { addr: w.addr, label: w.label || null } }, poller.getPositions(me.uid, w.addr));
  });
  fastify.post("/api/positions", { bodyLimit: 4 * 1024 }, (req, reply) => {
    reply.header("cache-control", "no-store");
    const me = dmMe(req, reply); if (!me) return;
    const b = req.body || {};
    const r = b.remove ? ACCOUNTS.walletDrop(me.uid) : ACCOUNTS.walletSet(me.uid, b.addr, b.label);
    if (!r.ok) return reply.code(400).send(r);
    return r;
  });

  // Browsers post violations as application/csp-report (report-uri) or application/reports+json
  // (Reporting API); Fastify 415s both unless told how to read them. No auth: the login page is
  // covered by the policy and its visitor has no session by definition. 8 KB is generous for a report.
  fastify.addContentTypeParser(["application/csp-report", "application/reports+json"], { parseAs: "string", bodyLimit: 8192 },
    (req, body, done) => { try { done(null, JSON.parse(body)); } catch (_) { done(null, null); } });
  fastify.post("/api/csp-report", { bodyLimit: 8192 }, (req, reply) => {
    try { cspRecord(req.body); } catch (_) {}
    return reply.code(204).header("cache-control", "no-store").send();
  });
  fastify.get("/api/health", (req) => {
    // Railway's healthcheck (and any anonymous prober) is answered BEFORE the full picture is
    // built (build 2026.09.24-101): poller.stats() walks every lane, limiter and per-coin failure
    // map, and the anonymous body below never carried any of it. Same fields, same values.
    const admin = isAdmin(req);
    if (!admin && !reqAuthed(req)) {
      const lp = poller.lastPollAt();
      return { ok: true, version: VERSION, stale: lp > 0 && Date.now() - lp > STALE_MS, ts: Date.now() };
    }
    const full = { ok: true, version: VERSION,
      stale: poller.lastPollAt() > 0 && Date.now() - poller.lastPollAt() > STALE_MS, lastPollAgoMs: poller.lastPollAt() > 0 ? Date.now() - poller.lastPollAt() : null,
      volume: { boots: HEARTBEAT.boots, firstBoot: HEARTBEAT.firstBoot, dataDir: DATA_DIR },
      loop: { ...loopSample(), sinceMs: Date.now() - loopResetAt, windowMs: LOOP_WINDOW, maxEver: loopMaxEver, hist: loopRing },
      csp: { mode: CSP_ENFORCE ? "enforce" : "report-only", reports: CSP_REPORTS.n, dropped: CSP_REPORTS.dropped, recent: CSP_REPORTS.recent.map(({ key, ...r }) => r) },
      ...poller.stats(), ts: Date.now() };
    // Railway's healthcheck needs {ok} and nothing else. The full picture — the volume path, the
    // AI provider and model names, the backup repo, limiter usage, per-coin failure state, the
    // CSP ledger — describes the deployment and is the operator's. A signed-in member gets what
    // their own UI reads and no more: the freshness tray (public/js/data.js: lastPoll, failing
    // counts, earnings/news/filings stamps, loop, ticks) and the ask-budget chip (ai.askDayLeft).
    // Explicit allow-list, never a delete-list, so a field added to stats() later is admin-only
    // until somebody decides otherwise here.
    if (admin) return full;
    const e = full.earnings || {}, n = full.news || {}, ff = (n.filings && n.filings.fetch) || {}, ai = full.ai || {};
    return { ok: full.ok, version: full.version, stale: full.stale, lastPollAgoMs: full.lastPollAgoMs, loop: full.loop,
      lastPoll: full.lastPoll, active: full.active, failing: full.failing, ticks: full.ticks,
      earnings: { asOf: e.asOf, error: e.error },
      news: { fetchedAt: n.fetchedAt, error: n.error, filings: { fetch: { lastOk: ff.lastOk, forbidden: ff.forbidden, netFail: ff.netFail } } },
      ai: { enabled: ai.enabled, perDay: ai.perDay, dayLeft: ai.dayLeft, askPerDay: ai.askPerDay, askDayLeft: ai.askDayLeft },
      ts: full.ts };
  });

  return fastify;
}

async function main() {
  const fastify = await buildServer();
  await fastify.listen({ port: PORT, host: HOST });
  log(`Listening on ${HOST}:${PORT} (dex=${DEX}, data=${DATA_DIR}, build=${VERSION})`);
  // accounts.db backup: shortly after boot (a deploy is the moment a bad migration would show),
  // then daily. Seven rotated copies beside the database, or in ACCOUNTS_BACKUP_DIR.
  // Off the event loop since build 2026.09.24-101: backupAsync runs the VACUUM INTO in a worker
  // thread on its own connection (falls back to the in-process copy if a worker cannot start).
  const accountsBackup = () => ACCOUNTS.backupAsync(process.env.ACCOUNTS_BACKUP_DIR || null, 7).then((r) =>
    log(r.ok ? `accounts backup: ${r.file} (${(r.bytes / 1024).toFixed(0)} KB, ${r.kept} kept)` : `accounts backup FAILED: ${r.error}`))
    .catch((e) => log("accounts backup FAILED (isolated): " + (e && e.message)));
  setTimeout(accountsBackup, 5 * 60 * 1000).unref();
  setInterval(accountsBackup, 24 * 3600 * 1000).unref();
  // (build 2026.09.24-109) Usage: the pending beacon minutes land every 60s in one transaction
  // (and once more from ACCOUNTS.close() at shutdown); once a day, rows past the 30-day window
  // fold into the sitewide bucket and the per-member rows go.
  setInterval(() => { try { if (USAGE_SWEEP) USAGE_SWEEP(); } catch (e) { log("usage sweep FAILED: " + (e && e.message)); } try { ACCOUNTS.usageFlush(); } catch (e) { log("usage flush FAILED: " + (e && e.message)); }
    try { if (USAGE_REGRESS) USAGE_REGRESS(); } catch (e) { log("usage regression check FAILED: " + (e && e.message)); } }, 60 * 1000).unref();   // (build 2026.09.24-111)
  const usageRetain = () => { try { const r = ACCOUNTS.usageRetain(); if (r.dropped) log(`usage retention: ${r.dropped} per-member row(s) before ${r.cut} folded into sitewide totals`); } catch (e) { log("usage retention FAILED: " + (e && e.message)); } };
  setTimeout(usageRetain, 2 * 60 * 1000).unref();
  setInterval(usageRetain, 24 * 3600 * 1000).unref();
  poller.start().catch((e) => log("poller start error: " + (e && e.message)));
}

// _poller is a testing seam (build 2026.09.24-99): the Telegram sync suite binds chats and drains
// the outbox against a stubbed Bot API through it. Nothing in the app reads it.
module.exports = { buildServer, VERSION, _poller: () => poller, _sseWriteTo: sseWriteTo, SSE_MAX_BUFFERED,
  _makeKeyedCache: makeKeyedCache, _keyedStats: () => keyedCache.stats(), KEYED_MAX_BYTES, KEYED_MAX_ENTRIES };   // build 2026.09.24-102: LRU seams for the tests
if (require.main === module) main().catch((e) => { console.error(e); process.exit(1); });

// Graceful stop: flush EVERYTHING that persists on a timer, not just features + ledger — the
// hourly spine (10-min cadence), trigger dedupe state, and push recipients were previously left
// to whatever their last interval wrote. Railway's SIGTERM grace window is ample for the awaited
// spine stream; the guard makes a second signal during the flush a no-op instead of a re-entry.
let shuttingDown = false;
async function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  // Let in-flight async features/ledger writes settle first (build 2026.09.24-102), so the final
  // synchronous saves below are the last writes of those files; bounded, never holds the exit.
  try { if (store.drainWrites) await store.drainWrites(5000); } catch (_) {}
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
  const sseClients = SSE_REGISTRY || new Set();   // buildServer's registry; block-scoped there, so it has to be handed out
  try { for (const e of sseClients) { try { e.res.end(); } catch (_) {} } sseClients.clear(); } catch (_) {}   // entries are {res, uid}: res.end() on the entry was a swallowed TypeError
  try { store.close(); } catch (_) {}
  // (build 2026.09.24-107) a backup mid-VACUUM gets a moment to land; past it, close() drops its .tmp
  try { if (ACCOUNTS.backupDrain) await ACCOUNTS.backupDrain(3000); } catch (_) {}
  try { if (USAGE_SWEEP) USAGE_SWEEP(null, true); } catch (_) {}   // (build 2026.09.24-110 follow-up) held beacons land first
  try { ACCOUNTS.close(); } catch (_) {}   // checkpoints the WAL so a redeploy never leaves -wal/-shm behind
  process.exit(0);
}
if (require.main === module) { process.on("SIGTERM", shutdown); process.on("SIGINT", shutdown); }

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
  try { ACCOUNTS.close(); } catch (_) {}
  process.exit(1);
}
// Only as the process entry: under the test runner these would exit the runner itself.
if (require.main === module) {
  process.on("unhandledRejection", (e) => crashFlush("unhandledRejection", e));
  process.on("uncaughtException", (e) => crashFlush("uncaughtException", e));
}
