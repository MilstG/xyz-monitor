"use strict";
const path = require("path");
const Fastify = require("fastify");
const { openStore } = require("./src/store");
const { createPoller } = require("./src/poller");

const DEX = process.env.DEX || "xyz";
const PORT = Number(process.env.PORT || 3000);
const HOST = "0.0.0.0";
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, "data");

function log(msg) { console.log(new Date().toISOString() + " " + msg); }

const store = openStore(DATA_DIR);
const poller = createPoller({ dex: DEX, store, log });

async function main() {
  const fastify = Fastify({ logger: false });

  await fastify.register(require("@fastify/compress"), { global: true, encodings: ["gzip", "deflate"] });
  await fastify.register(require("@fastify/static"), { root: path.join(__dirname, "public"), prefix: "/" });

  fastify.get("/api/snapshot", (req, reply) => {
    reply.header("cache-control", "no-store");
    return poller.getSnapshot() || { ts: 0, benchCoin: null, markets: [] };
  });
  fastify.get("/api/daily", (req, reply) => {
    reply.header("cache-control", "no-store");
    return poller.getDaily() || { ts: 0, daily: {} };
  });
  fastify.get("/api/health", () => ({ ok: true, ...poller.stats(), ts: Date.now() }));

  await fastify.listen({ port: PORT, host: HOST });
  log(`Listening on ${HOST}:${PORT} (dex=${DEX}, data=${DATA_DIR})`);
  poller.start().catch((e) => log("poller start error: " + (e && e.message)));
}

main().catch((e) => { console.error(e); process.exit(1); });

function shutdown() { store.close(); process.exit(0); }
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
