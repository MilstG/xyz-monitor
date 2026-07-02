"use strict";
const path = require("path");
const Fastify = require("fastify");
const { openStore } = require("./src/store");
const { createPoller } = require("./src/poller");

const DEX = process.env.DEX || "xyz";
const PORT = Number(process.env.PORT || 3000);
const HOST = "0.0.0.0";
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, "data");
const SITE_PASSWORD = process.env.SITE_PASSWORD || ""; // set to require a shared password
const SITE_USER = process.env.SITE_USER || "friend";

function log(msg) { console.log(new Date().toISOString() + " " + msg); }

const store = openStore(DATA_DIR);
const poller = createPoller({ dex: DEX, store, log });

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
        if (u === SITE_USER && p === SITE_PASSWORD) return;
      }
      reply.header("WWW-Authenticate", 'Basic realm="xyz-monitor"').code(401).send("Authentication required");
    });
    log("Access control: shared-password protection ENABLED");
  }

  await fastify.register(require("@fastify/compress"), { global: true, encodings: ["gzip", "deflate"] });
  await fastify.register(require("@fastify/static"), { root: path.join(__dirname, "public"), prefix: "/" });

  fastify.get("/api/snapshot", (req, reply) =>
    serveCached(req, reply, poller.getSnapshot(), { ts: 0, dataTs: 0, benchCoin: null, markets: [] }));
  fastify.get("/api/daily", (req, reply) =>
    serveCached(req, reply, poller.getDaily(), { ts: 0, daily: {} }));
  fastify.get("/api/series", (req, reply) => {
    reply.header("cache-control", "no-store");
    const coin = (req.query && req.query.coin) || "";
    return poller.getSeries(coin) || { oi: [], funding: [] };
  });
  fastify.get("/api/health", () => ({ ok: true, ...poller.stats(), ts: Date.now() }));

  await fastify.listen({ port: PORT, host: HOST });
  log(`Listening on ${HOST}:${PORT} (dex=${DEX}, data=${DATA_DIR})`);
  poller.start().catch((e) => log("poller start error: " + (e && e.message)));
}

main().catch((e) => { console.error(e); process.exit(1); });

function shutdown() { try { poller.persistFeatures(); } catch (_) {} store.close(); process.exit(0); }
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
