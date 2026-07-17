"use strict";
const path = require("path");
const crypto = require("crypto");
const Fastify = require("fastify");
const { openStore } = require("./src/store");
const { createPoller } = require("./src/poller");

// Build stamp. Bumped on every delivery; shipped in /api/health, the snapshot payload and
// the UI status line — one glance answers "is the live site actually running this build?"
// (most historical "it doesn't work" reports were stale deploys, not bugs).
const VERSION = "2026.07.16-54";

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
// Kill-switch: FLOWS=0 disables the liquidation monitor (tape socket + cohort sweeps).
const FLOWS = process.env.FLOWS !== "0";
const poller = createPoller({ dex: DEX, store, log, version: VERSION, crypto: CRYPTO, flows: FLOWS });
log(`Crypto (Hyperliquid main dex): ${CRYPTO ? "ENABLED — top-60 perps, 31d retention" : "disabled via CRYPTO=0"}`);
log(`Flows (liquidation monitor): ${FLOWS ? "ENABLED — tape-harvested cohort + hot-lane liq sweeps, both universes" : "disabled via FLOWS=0"}`);

// Weak ETag from the payload's data version so an unchanged snapshot revalidates to 304
// (browsers polling every 30s get a tiny empty response instead of the full table).
function etagFor(body) { return 'W/"' + (body.dataTs != null ? body.dataTs : (body.ts || 0)) + '"'; }
function serveCached(req, reply, payload, fallback) {
  const body = payload || fallback;
  reply.header("cache-control", "no-cache");
  const tag = etagFor(body);
  reply.header("etag", tag);
  if (req.headers["if-none-match"] === tag) { reply.code(304).send(); return; }
  return body;
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
      if (sessionOk(getCookie(req, "xyzsess"))) return;
      const hdr = req.headers.authorization || "";
      const [scheme, enc] = hdr.split(" ");
      if (scheme === "Basic" && enc) {
        const s = Buffer.from(enc, "base64").toString();
        const i = s.indexOf(":");   // split on the FIRST colon only — passwords may contain colons
        if (i >= 0 && credsOk(s.slice(0, i), s.slice(i + 1))) return;
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

  await fastify.register(require("@fastify/compress"), { global: true, encodings: ["gzip", "deflate"] });
  await fastify.register(require("@fastify/static"), {
    root: path.join(__dirname, "public"),
    prefix: "/",
    // Force revalidation on every static asset. Without this, browsers heuristically cache
    // app.js/styles.css and a fresh deploy can look like nothing changed until a hard refresh —
    // the exact "I deployed but I don't see it" failure. ETags make revalidation a cheap 304.
    setHeaders(res) { res.setHeader("cache-control", "no-cache"); },
  });

  fastify.get("/api/snapshot", (req, reply) =>
    serveCached(req, reply, poller.getSnapshot(), { ts: 0, dataTs: 0, benchCoin: null, markets: [] }));
  fastify.get("/api/daily", (req, reply) =>
    serveCached(req, reply, poller.getDaily(), { ts: 0, daily: {} }));
  fastify.get("/api/analytics", (req, reply) =>
    serveCached(req, reply, poller.getAnalytics(), { ts: 0, dataTs: 0, coverage: {}, universe: [], sections: {} }));
  // EMA 13/21 trend ladder (D1 · H12 · H4 · H1) — ranked long/short leaderboards per universe.
  fastify.get("/api/trend", (req, reply) =>
    serveCached(req, reply, poller.getTrend(), { ts: 0, dataTs: 0, coverage: { included: 0, excluded: 0 }, long: { crypto: [], stocks: [] }, short: { crypto: [], stocks: [] } }));
  // Ranked live signals + their per-market historical base rates (event studies).
  fastify.get("/api/signals", (req, reply) =>
    serveCached(req, reply, poller.getSignals(), { ts: 0, dataTs: 0, count: 0, signals: [] }));
  // Earnings calendar for the xyz equity universe (Finnhub-fed, 6h server refresh). ETag rides
  // dataTs like the other cached payloads, so an unchanged calendar revalidates to a 304.
  fastify.get("/api/earnings", (req, reply) =>
    serveCached(req, reply, poller.getEarnings(), { ts: 0, dataTs: 0, asOf: null, windowDays: 14, source: "finnhub", error: "not fetched yet", entries: [], recent: [], eligible: 0 }));
  // Liquidation monitor — tracked-cohort positions ranked by distance to their liquidation
  // price, the per-market cascade ladder, and mark-crossed-liq events with sweep-confirmed
  // outcomes (hot lane re-sweeps at-risk books every ~15s).
  fastify.get("/api/liqs", (req, reply) =>
    serveCached(req, reply, poller.getLiqs(), { ts: 0, dataTs: 0, bands: [1, 2, 5, 10], coverage: {}, danger: [], ladder: { crypto: { coins: [], total: { long: [], short: [] } }, stocks: { coins: [], total: { long: [], short: [] } } }, events: [] }));
  // Per-market OI + funding history — powers the drawer sparklines.
  fastify.get("/api/series", (req, reply) => {
    reply.header("cache-control", "no-store");
    const coin = (req.query && req.query.coin) || "";
    return poller.getSeries(coin) || { oi: [], funding: [] };
  });
  // Claim-history browser: filter by ticker (coin=), by event type (ev=), or both. Powers the
  // drawer signal record and the Signals-tab full history search.
  fastify.get("/api/ledger", (req, reply) => {
    reply.header("cache-control", "no-store");
    const coin = (req.query && req.query.coin) || "";
    const ev = (req.query && req.query.ev) || "";
    return poller.getLedgerFor(coin, ev);
  });
  // Hourly OHLCV for the drawer candle chart. days: 1..60, default 14.
  fastify.get("/api/candles", (req, reply) => {
    reply.header("cache-control", "no-store");
    const coin = (req.query && req.query.coin) || "";
    const days = req.query && req.query.days;
    return { coin, candles: poller.getCandles(coin, days) };
  });
  fastify.get("/api/health", () => ({ ok: true, version: VERSION, volume: { boots: HEARTBEAT.boots, firstBoot: HEARTBEAT.firstBoot, dataDir: DATA_DIR }, ...poller.stats(), ts: Date.now() }));

  await fastify.listen({ port: PORT, host: HOST });
  log(`Listening on ${HOST}:${PORT} (dex=${DEX}, data=${DATA_DIR}, build=${VERSION})`);
  poller.start().catch((e) => log("poller start error: " + (e && e.message)));
}

main().catch((e) => { console.error(e); process.exit(1); });

function shutdown() { try { poller.persistFeatures(); } catch (_) {} try { poller.persistLedger(); } catch (_) {} try { poller.persistFlows(); } catch (_) {} store.close(); process.exit(0); }
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
