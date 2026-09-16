"use strict";
// hyperliquid.js and other clients. Split out of test.js (build 2026.09.16-80); order within the file is the original order.
const test = require("node:test");
const assert = require("node:assert");


test("perf: store source pins the async streamed NDJSON path (no whole-file stringify/parse regression)", () => {
  const fs = require("fs"), path = require("path");
  const st = fs.readFileSync(path.join(__dirname, "..", "src", "store.js"), "utf8");
  assert.ok(st.includes("hourly.ndjson"), "hourly spine must target the NDJSON file");
  assert.ok(/async saveHourly/.test(st), "saveHourly must be async (no synchronous 30MB write on the event loop)");
  assert.ok(st.includes("createWriteStream") && st.includes("streamHourly"), "streamed write + streamed read must both exist");
  assert.ok(st.includes("hourlyWriting"), "overlapping-write guard must exist");
  // the old blocking one-shot must be gone
  assert.ok(!/saveHourly\(data\) \{\s*try \{\s*const tmp = hourlyFile/.test(st), "the old synchronous saveHourly must not survive");
});

test("coinalyze client: call-unit pacing, symbol-cost batching, USD source-conversion pinned", () => {
  const fs = require("fs"), path = require("path");
  const hl = fs.readFileSync(path.join(__dirname, "..", "src", "hyperliquid.js"), "utf8");
  assert.ok(hl.includes("const MAX = 38;"), "coinalyze limiter must cap under the 40 calls/min ceiling");
  assert.ok(hl.includes("symbols.length"), "batched requests must charge one call-unit PER SYMBOL, not per request");
  assert.ok(hl.split("convert_to_usd").length - 1 >= 2, "liq + OI histories must request source-side USD conversion");
  assert.ok(hl.includes("retry-after"), "429s must honor Retry-After");
  assert.ok(hl.includes("createCoinalyze") && hl.includes("if (!key) return null;"), "no key -> no client, the lane never starts");
});

test("coinalyze client contract: header key, second-based windows, USD flag, per-symbol units", async () => {
  const { createCoinalyze } = require("../src/hyperliquid");
  const calls = [];
  const realFetch = global.fetch;
  global.fetch = async (url, opts) => {
    calls.push({ url: String(url), key: opts && opts.headers && opts.headers.api_key });
    return { ok: true, status: 200, json: async () => ([{ symbol: "BTCUSDT_PERP.A", history: [{ t: 1784900000, l: 1000, s: 500 }] }]) };
  };
  try {
    const cz = createCoinalyze({ key: "k-test", log: () => {} });
    assert.ok(cz, "client must construct with a key");
    assert.equal(createCoinalyze({ key: "", log: () => {} }), null, "no key -> no client");
    const from = 1784900000000, to = 1784903600000;
    const out = await cz.liqHistory(["BTCUSDT_PERP.A", "ETHUSDT_PERP.A"], "15min", from, to);
    assert.equal(out[0].symbol, "BTCUSDT_PERP.A");
    const u = new URL(calls[0].url);
    assert.equal(calls[0].key, "k-test", "api_key must travel as a header");
    assert.equal(u.searchParams.get("symbols"), "BTCUSDT_PERP.A,ETHUSDT_PERP.A", "batch = comma-joined symbols");
    assert.equal(u.searchParams.get("from"), String(Math.floor(from / 1000)), "windows in UNIX SECONDS, not ms");
    assert.equal(u.searchParams.get("to"), String(Math.floor(to / 1000)));
    assert.equal(u.searchParams.get("interval"), "15min");
    assert.equal(u.searchParams.get("convert_to_usd"), "true", "USD conversion is source-side, stored as-received");
    assert.equal(cz.usage().used, 2, "two symbols must charge two call-units against the 38/min budget");
    await cz.oiHistory(["BTCUSDT_PERP.A"], "15min", from, to);
    assert.equal(cz.usage().used, 3, "call-unit ledger accumulates across endpoints");
  } finally { global.fetch = realFetch; }
});

// ===== build 2026.07.27-14: hardening pass (audit items 1-6) ==================================

test("ws watchdog: a mute socket that never closes is force-closed into the reconnect path", () => {
  const fs = require("fs"), path = require("path");
  const hl = fs.readFileSync(path.join(__dirname, "..", "src", "hyperliquid.js"), "utf8");
  assert.ok(hl.includes("const WS_STALE_MS = 120000"), "staleness threshold pinned at 120s — two missed ping cycles of total silence");
  assert.ok(/if \(Date\.now\(\) - lastData > WS_STALE_MS\) \{ try \{ ws\.close\(\); \} catch \(_\) \{\} return; \}/.test(hl),
    "the ping tick must check staleness BEFORE pinging and force-close a zombie — close() routes into onclose -> backoff -> reconnect");
  assert.ok(/onopen[\s\S]{0,200}lastMsg = Date\.now\(\)/.test(hl),
    "the watchdog is armed at open, so a socket that never delivers even one message is also caught");
  // The recovery path the watchdog feeds must still exist exactly as designed.
  assert.ok(hl.includes("ws.onclose = () => { clearInterval(pingT); retry(); };"), "onclose still clears the ping timer and retries");
});

// The limiter charged one weight for up to three sends, and a 429 paused only the caller that saw
// it while everyone else kept firing at the 4% headroom.
test("audit -67: every Hyperliquid attempt is charged, a 429 pauses every caller, hard 4xx never retries", async () => {
  const { infoPost, limiter } = require("../src/hyperliquid");
  const mk = (status, headers) => async () => ({ ok: status < 400, status, headers: { get: (k) => (headers || {})[k] || null }, json: async () => ({ ok: 1 }) });
  const before = limiter.usage().used;
  await assert.rejects(infoPost({ type: "x" }, 5, mk(400)), /HTTP 400/);
  assert.equal(limiter.usage().used - before, 5, "one attempt, one charge — a 400 is the request's fault");
  let calls = 0;
  const flaky = async () => { calls++; return calls < 3 ? { ok: false, status: 429, headers: { get: () => "1" } } : { ok: true, status: 200, headers: { get: () => null }, json: async () => ({ ok: 1 }) }; };
  const t0 = Date.now();
  const r = await infoPost({ type: "y" }, 7, flaky);
  assert.deepEqual(r, { ok: 1 });
  assert.equal(calls, 3);
  assert.ok(limiter.usage().used - before >= 5 + 21, "each retry is charged (" + (limiter.usage().used - before) + ")");
  assert.ok(Date.now() - t0 >= 1900, "Retry-After of 1s was honoured on each 429, for everyone (" + (Date.now() - t0) + "ms)");
});

test("audit -67: the universe socket is healthy on DATA, not on pongs, and resets its backoff only after data", () => {
  const { createUniverseSocket } = require("../src/hyperliquid");
  const saved = globalThis.WebSocket;
  let inst = null;
  globalThis.WebSocket = class { constructor() { inst = this; this.readyState = 1; } send() {} close() { this.readyState = 3; if (this.onclose) this.onclose({}); } };
  try {
    const got = [];
    const sock = createUniverseSocket({ onCtxs: (c) => got.push(c), log: () => {} });
    inst.onopen();
    inst.onmessage({ data: JSON.stringify({ channel: "pong" }) });
    inst.onmessage({ data: JSON.stringify({ channel: "subscriptionResponse" }) });
    assert.equal(sock.healthy(), false, "pongs alone never make the feed healthy");
    inst.onmessage({ data: JSON.stringify({ channel: "allDexsAssetCtxs", data: { ctxs: [["xyz", []]] } }) });
    assert.equal(sock.healthy(), true, "a ctxs event does");
    assert.equal(got.length, 1);
    sock.close();
  } finally { globalThis.WebSocket = saved; }
  const src = require("fs").readFileSync(require("path").join(__dirname, "..", "src", "hyperliquid.js"), "utf8");
  assert.ok(/if \(Date\.now\(\) - lastData > WS_STALE_MS\)/.test(src), "the watchdog reads data silence, so a dead subscription on a live socket is force-closed and re-subscribed");
  assert.ok(/if \(!gotData\) \{ gotData = true; backoff = 1000; \}/.test(src) && !/onopen = \(\) => \{\s*\n\s*backoff = 1000;/.test(src), "backoff resets on first data, not on open");
});
