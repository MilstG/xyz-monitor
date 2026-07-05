"use strict";
const path = require("path");
const crypto = require("crypto");
const Fastify = require("fastify");
const { openStore } = require("./src/store");
const { createPoller } = require("./src/poller");

// Build stamp. Bumped on every delivery; shipped in /api/health, the snapshot payload and
// the UI status line — one glance answers "is the live site actually running this build?"
// (most historical "it doesn't work" reports were stale deploys, not bugs).
const VERSION = "2026.07.04-11";

const DEX = process.env.DEX || "xyz";
const PORT = Number(process.env.PORT || 3000);
const HOST = "0.0.0.0";
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, "data");
const SITE_PASSWORD = process.env.SITE_PASSWORD || ""; // set to require a shared password
const SITE_USER = process.env.SITE_USER || "friend";

function log(msg) { console.log(new Date().toISOString() + " " + msg); }

const store = openStore(DATA_DIR);
// Definitive volume-persistence check: boot #1 on every deploy = the data dir is ephemeral
// (DATA_DIR not pointing at the volume mount, or no volume attached). Boot #N, first boot
// dating back days = the volume is fine and every warm cache above it can be trusted.
const HEARTBEAT = store.heartbeat();
log(`Volume heartbeat: boot #${HEARTBEAT.boots} on this data dir (first boot ${new Date(HEARTBEAT.firstBoot).toISOString()}) — ` +
  (HEARTBEAT.boots > 1 ? "volume IS persisting" : "if this says boot #1 again next deploy, the volume is NOT persisting (check DATA_DIR vs the mount path)"));
const poller = createPoller({ dex: DEX, store, log, version: VERSION });

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

async function main() {
  const fastify = Fastify({ logger: false });

  // Optional shared-password gate (HTTP Basic). Disabled unless SITE_PASSWORD is set.
  // NOTE: /api/health must stay open or Railway's healthcheck 401s and the deploy is
  // marked unhealthy (restart loop).
  if (SITE_PASSWORD) {
    fastify.addHook("onRequest", async (req, reply) => {
      if (req.url === "/api/health") return;
      const hdr = req.headers.authorization || "";
      const [scheme, enc] = hdr.split(" ");
      if (scheme === "Basic" && enc) {
        const [u, p] = Buffer.from(enc, "base64").toString().split(":");
        if (credsOk(u, p)) return;
      }
      reply.header("WWW-Authenticate", 'Basic realm="xyz-monitor"').code(401).send("Authentication required");
    });
    log("Access control: shared-password protection ENABLED");
  }

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
  // Ranked live signals + their per-market historical base rates (event studies).
  fastify.get("/api/signals", (req, reply) =>
    serveCached(req, reply, poller.getSignals(), { ts: 0, dataTs: 0, count: 0, signals: [] }));
  fastify.get("/api/series", (req, reply) => {
    reply.header("cache-control", "no-store");
    const coin = (req.query && req.query.coin) || "";
    return poller.getSeries(coin) || { oi: [], funding: [] };
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

function shutdown() { try { poller.persistFeatures(); } catch (_) {} try { poller.persistLedger(); } catch (_) {} store.close(); process.exit(0); }
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
