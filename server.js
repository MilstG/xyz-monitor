"use strict";
const path = require("path");
const fs = require("fs");
const crypto = require("crypto");
const zlib = require("zlib");
const Fastify = require("fastify");
const { openStore } = require("./src/store");
const { createPoller } = require("./src/poller");

// Build stamp. Bumped on every delivery; shipped in /api/health, the snapshot payload and
// the UI status line — one glance answers "is the live site actually running this build?"
// (most historical "it doesn't work" reports were stale deploys, not bugs).
const VERSION = "2026.07.22-03";

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
// AI admin gate. AI generation (ask-terminal fallback + report generation) is LOCKED by default
// and only opens after someone enters ADMIN_PASSWORD via `admin unlock` in the terminal. The
// unlock is a stateless HMAC cookie (xyzai), signed with a secret derived from ADMIN_PASSWORD —
// so rotating the admin password on Railway revokes every outstanding unlock, and an UNSET admin
// password mints no valid token, leaving the gate closed (fail-closed, never fail-open). There is
// deliberately no header/Basic-auth bypass: scripts can't unlock, so AI stays browser+password only.
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || "";
const AI_UNLOCK_SECRET = crypto.createHash("sha256").update(`xyzmon-ai-unlock|${ADMIN_PASSWORD}`).digest();
const AI_UNLOCK_MS = 24 * 3600 * 1000;   // hard ceiling on an unlock's life, even if the browser restores its session

function log(msg) { console.log(new Date().toISOString() + " " + msg); }

const store = openStore(DATA_DIR);
// Definitive volume-persistence check: boot #1 on every deploy = the data dir is ephemeral
// (DATA_DIR not pointing at the volume mount, or no volume attached). Boot #N, first boot
// dating back days = the volume is fine and every warm cache above it can be trusted.
const HEARTBEAT = store.heartbeat();
log(`Volume heartbeat: boot #${HEARTBEAT.boots} on this data dir (first boot ${new Date(HEARTBEAT.firstBoot).toISOString()}) — ` +
  (HEARTBEAT.boots > 1 ? "volume IS persisting" : "if this says boot #1 again next deploy, the volume is NOT persisting (check DATA_DIR vs the mount path)"));
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
    if (gz === undefined) { gz = zlib.gzipSync(s); gzipCache.set(body, gz); }
    reply.header("content-encoding", "gzip");
    reply.header("vary", "accept-encoding");
    return reply.send(gz);
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

// The login page, served inline for any unauthenticated navigation (no extra file, no native
// Basic-auth popup). Styling mirrors the app's dark palette.
const LOGIN_HTML = `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>xyz-monitor — sign in</title>
<style>
:root{--bg:#0E1116;--panel:#151A21;--border:#262E39;--text:#E8E3D7;--muted:#7E8794;--accent:#E3A53C;--down:#E5604D;
--mono:'JetBrains Mono',ui-monospace,Menlo,Consolas,monospace;--disp:'Space Grotesk',system-ui,sans-serif}
*{box-sizing:border-box}html,body{margin:0;height:100%;background:var(--bg);color:var(--text);font-family:var(--disp)}
body{display:flex;align-items:center;justify-content:center;padding:20px}
.card{width:100%;max-width:360px;background:var(--panel);border:1px solid var(--border);border-radius:10px;padding:28px 26px 22px}
.wm{font-size:24px;font-weight:700;letter-spacing:-.5px}.wm b{color:var(--accent)}
.sub{color:var(--muted);font-size:12.5px;margin:4px 0 22px}
label{display:block;font-size:10.5px;text-transform:uppercase;letter-spacing:.9px;color:var(--muted);margin-bottom:6px}
input{width:100%;background:var(--bg);border:1px solid var(--border);border-radius:6px;color:var(--text);
font-family:var(--mono);font-size:15px;padding:10px 12px;outline:none}
input:focus{border-color:var(--accent)}
button{width:100%;margin-top:14px;background:var(--accent);border:none;border-radius:6px;color:#000;
font-family:var(--disp);font-size:14px;font-weight:600;padding:11px;cursor:pointer}
button:disabled{opacity:.55;cursor:default}
.err{color:var(--down);font-size:12.5px;min-height:17px;margin-top:10px;font-family:var(--mono)}
</style></head><body>
<div class="card">
  <div class="wm">xyz<b>·</b>monitor</div>
  <div class="sub">private terminal — enter the shared password</div>
  <label for="pw">password</label>
  <input id="pw" type="password" autocomplete="current-password" autofocus>
  <button id="go">Enter</button>
  <div class="err" id="err"></div>
</div>
<script>
var pw=document.getElementById('pw'),go=document.getElementById('go'),err=document.getElementById('err');
async function submit(){ if(!pw.value||go.disabled) return; go.disabled=true; err.textContent='';
  try{ var r=await fetch('/login',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({password:pw.value})});
    var d=await r.json().catch(function(){return {};});
    if(r.ok&&d.ok){ location.replace('/'); return; }
    err.textContent=(d&&d.error)||('HTTP '+r.status); }
  catch(e){ err.textContent='network error — try again'; }
  go.disabled=false; pw.select(); }
go.addEventListener('click',submit);
pw.addEventListener('keydown',function(e){ if(e.key==='Enter') submit(); });
</script></body></html>`;

async function main() {
  const fastify = Fastify({ logger: false });

  // True when a request carries a valid session cookie or correct HTTP Basic creds. Shared by the
  // optional site gate below AND the always-on AI-cost guard, so "authenticated" means one thing.
  const reqAuthed = (req) => {
    if (sessionOk(getCookie(req, "xyzsess"))) return true;
    const hdr = req.headers.authorization || "";
    const [scheme, enc] = hdr.split(" ");
    if (scheme === "Basic" && enc) {
      const s = Buffer.from(enc, "base64").toString();
      const i = s.indexOf(":");
      if (i >= 0 && credsOk(s.slice(0, i), s.slice(i + 1))) return true;
    }
    return false;
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
      // Second lock, layered over authentication: even a logged-in caller (browser OR script/Basic
      // auth) must present a valid AI-unlock cookie. There is no header shortcut, so the only way to
      // get one is `admin unlock <password>` in the terminal — AI stays browser+admin-password only.
      if (!aiUnlockOk(getCookie(req, "xyzai")))
        return reply.code(401).header("cache-control", "no-store").send({ error: "ai-locked", detail: "AI is locked — run 'admin unlock <password>' in the terminal to enable it for this session" });
    }
  });

  // Optional shared-password gate. Disabled unless SITE_PASSWORD is set. Two ways in:
  //   1. Session cookie from the login page (30-day HMAC token) — the normal browser path.
  //   2. HTTP Basic — kept so curl/scripts can still hit the API without a cookie jar.
  // NOTE: /api/health must stay open or Railway's healthcheck 401s and the deploy is
  // marked unhealthy (restart loop). /login (POST) and /logout must pass or nobody could
  // ever authenticate.
  if (SITE_PASSWORD) {
    fastify.addHook("onRequest", async (req, reply) => {
      const u = req.url.split("?")[0];
      if (u === "/api/health" || u === "/logout" || (u === "/login" && req.method === "POST")) return;
      if (reqAuthed(req)) return;
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

  // Login/logout exist regardless of the gate so a stale xyzauth cookie can always be cleared.
  fastify.post("/login", async (req, reply) => {
    if (!SITE_PASSWORD) return { ok: true };   // gate disabled — nothing to check
    const ip = String(req.headers["x-forwarded-for"] || req.ip).split(",")[0].trim();
    const lockedMin = loginLockedFor(ip);
    if (lockedMin) { reply.code(429); return { ok: false, error: `too many attempts — locked for ${lockedMin} min` }; }
    const b = req.body || {};
    const user = (b.user == null || b.user === "") ? SITE_USER : String(b.user);   // page sends password only; SITE_USER is implied
    if (!credsOk(user, String(b.password == null ? "" : b.password))) {
      loginFail(ip); reply.code(401); return { ok: false, error: "wrong password" };
    }
    loginFails.delete(ip);
    setSessionCookies(reply, req, SESSION_DAYS * 86400, signSession(Date.now() + SESSION_DAYS * 864e5));
    return { ok: true };
  });
  fastify.get("/logout", async (req, reply) => {
    setSessionCookies(reply, req, 0, null);   // Max-Age=0 deletes both cookies
    return reply.redirect("/", 303);   // v5-forward signature (url, code) — the old order is deprecated
  });

  // ===== PWA shell: manifest + icon + service worker, all served inline (no new repo files) =====
  // The service worker deliberately caches NOTHING: it exists only to satisfy installability
  // (Chrome requires a fetch handler for the install prompt). Every request falls through to the
  // network untouched — a caching SW is exactly the stale-client failure class the version-stamped
  // shell was built to kill (-84), and we are not reintroducing it for offline support nobody asked for.
  const PWA_MANIFEST = JSON.stringify({
    name: "Trade[XYZ] Markets Monitor", short_name: "Trade[XYZ]",
    start_url: "/", display: "standalone", background_color: "#0E1116", theme_color: "#0E1116",
    icons: [{ src: "/icon.svg", sizes: "any", type: "image/svg+xml", purpose: "any" }],
  });
  const PWA_ICON = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512"><rect width="512" height="512" rx="96" fill="#0E1116"/><rect x="24" y="24" width="464" height="464" rx="80" fill="none" stroke="#262E39" stroke-width="8"/><text x="256" y="300" text-anchor="middle" font-family="monospace" font-size="132" font-weight="700" fill="#E8B44B">[XYZ]</text></svg>`;
  const PWA_SW = "self.addEventListener('install',()=>self.skipWaiting());self.addEventListener('activate',e=>e.waitUntil(self.clients.claim()));self.addEventListener('fetch',()=>{});";
  fastify.get("/manifest.webmanifest", async (req, reply) => reply.type("application/manifest+json").header("cache-control", "no-cache").send(PWA_MANIFEST));
  fastify.get("/icon.svg", async (req, reply) => reply.type("image/svg+xml").header("cache-control", "no-cache").send(PWA_ICON));
  fastify.get("/sw.js", async (req, reply) => reply.type("text/javascript").header("cache-control", "no-cache").send(PWA_SW));

  // threshold: don't spend gzip CPU on bodies under 1 KB (health, channel lists, empty fallbacks) —
  // the compressed result is no smaller and often larger. Big payloads (snapshot, analytics) still compress.
  await fastify.register(require("@fastify/compress"), { global: true, encodings: ["gzip", "deflate"], threshold: 1024 });
  await fastify.register(require("@fastify/static"), {
    root: path.join(__dirname, "public"),
    prefix: "/",
    index: false,   // index.html is served by the explicit routes below, version-stamped
    // Force revalidation on every static asset. Without this, browsers heuristically cache
    // app.js/styles.css and a fresh deploy can look like nothing changed until a hard refresh —
    // the exact "I deployed but I don't see it" failure. ETags make revalidation a cheap 304.
    setHeaders(res) { res.setHeader("cache-control", "no-cache"); },
  });

  // Version-stamped shell: index.html is read once at boot with ?v=BUILD stamped onto the two
  // asset tags, so every deploy changes the asset URLs themselves — a browser can no longer
  // run last build's app.js against this build's API, whatever its cache heuristics think
  // (the -84 lesson: revalidation headers alone did not save a stale client). The shell is
  // no-store; the stamped assets keep the ETag revalidation path.
  const INDEX_HTML_STAMPED = (() => {
    let h = fs.readFileSync(path.join(__dirname, "public", "index.html"), "utf8");
    const a = h.includes('src="/app.js"'), c = h.includes('href="/styles.css"');
    h = h.replace('src="/app.js"', `src="/app.js?v=${VERSION}"`).replace('href="/styles.css"', `href="/styles.css?v=${VERSION}"`);
    if (!a || !c) log("WARN: index.html asset tags drifted — version stamp incomplete (cache-busting degraded, app still serves)");
    return h;
  })();
  const serveIndex = (req, reply) => reply.header("cache-control", "no-store").type("text/html; charset=utf-8").send(INDEX_HTML_STAMPED);
  fastify.get("/", serveIndex);
  fastify.get("/index.html", serveIndex);

  fastify.get("/api/snapshot", (req, reply) =>
    serveCached(req, reply, poller.getSnapshot(), { ts: 0, dataTs: 0, benchCoin: null, markets: [] }));
  fastify.get("/api/daily", (req, reply) =>
    serveCached(req, reply, poller.getDaily(), { ts: 0, daily: {} }));
  fastify.get("/api/analytics", (req, reply) =>
    serveCached(req, reply, poller.getAnalytics(), { ts: 0, dataTs: 0, coverage: {}, universe: [], sections: {} }));
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
    serveCached(req, reply, poller.getSignals(), { ts: 0, dataTs: 0, count: 0, signals: [] }));
  // Earnings calendar for the xyz equity universe (Finnhub-fed, 6h server refresh). ETag rides
  // dataTs like the other cached payloads, so an unchanged calendar revalidates to a 304.
  fastify.get("/api/earnings", (req, reply) =>
    serveCached(req, reply, poller.getEarnings(), { ts: 0, dataTs: 0, asOf: null, windowDays: 14, source: "finnhub", error: "not fetched yet", entries: [], recent: [], eligible: 0 }));
  // Operator surgery for feed-garbage earnings prints (e.g. a phantom report date the feed
  // asserted and never corrected): removes the print from history and the reaction study and
  // tombstones it so no future fetch can resurrect it. Session-gated like every route.
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
  // Claim-history browser: filter by ticker (coin=), by event type (ev=), or both. Powers the
  // drawer signal record and the Signals-tab full history search.
  fastify.get("/api/ledger", (req, reply) => {
    reply.header("cache-control", "no-store");
    const coin = (req.query && req.query.coin) || "";
    const ev = (req.query && req.query.ev) || "";
    return poller.getLedgerFor(coin, ev);
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
    return poller.getLedgerExport();
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
    if (req.query && (req.query.res === "5m" || req.query.res === "5")) {
      const from = req.query.from, to = req.query.to, max = req.query.max;
      const key = "candles5m|" + coin + "|" + (from || "") + "|" + (to || "") + "|" + (max || "") + "|" + (poller.getM5Stamp ? poller.getM5Stamp(coin) : 0);
      return serveKeyed(req, reply, key, () => poller.getCandles5m(coin, from, to, max), { coin, res: "5m", enabled: false, candles: [], coverage: { enabled: false } });
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
  fastify.get("/api/ai-report", (req, reply) => {
    reply.header("cache-control", "no-store");
    const coin = (req.query && req.query.coin) || "";
    return poller.getAiReport(coin);
  });
  fastify.post("/api/ai-report", async (req, reply) => {
    reply.header("cache-control", "no-store");
    const b = req.body || {};
    const r = await poller.generateAiReport(String(b.coin || ""));
    return reply.code(r.ok ? 200 : (r.error === "cooldown" || r.error === "daily-cap" ? 429 : 400)).send(r);
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
    return reply.code(200).send({ ok: true, ttlMs: AI_UNLOCK_MS });
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
    return { gated: !!ADMIN_PASSWORD, unlocked: aiUnlockOk(getCookie(req, "xyzai")) };
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
    return poller.askBoard(b.q || "", b.ctx || {});
  });
  fastify.get("/api/health", () => ({ ok: true, version: VERSION, volume: { boots: HEARTBEAT.boots, firstBoot: HEARTBEAT.firstBoot, dataDir: DATA_DIR }, ...poller.stats(), ts: Date.now() }));

  await fastify.listen({ port: PORT, host: HOST });
  log(`Listening on ${HOST}:${PORT} (dex=${DEX}, data=${DATA_DIR}, build=${VERSION})`);
  poller.start().catch((e) => log("poller start error: " + (e && e.message)));
}

main().catch((e) => { console.error(e); process.exit(1); });

function shutdown() { try { poller.persistFeatures(); } catch (_) {} try { poller.persistLedger(); } catch (_) {} store.close(); process.exit(0); }
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
