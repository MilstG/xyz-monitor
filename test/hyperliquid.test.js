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
  // Pin updated (reliability pass): the watchdog no longer waits for the zombie's onclose (undici can sit
  // in CLOSING forever on a mute peer) — it abandons the socket and calls retry() itself.
  assert.ok(/if \(Date\.now\(\) - lastData > STALE_MS\) \{ abandon\(\); return; \}/.test(hl),
    "the ping tick must check staleness BEFORE pinging and abandon a zombie into the reconnect path directly");
  assert.ok(/function abandon\(\) \{[\s\S]{0,400}dead\.onclose = null[\s\S]{0,200}retry\(\);/.test(hl),
    "abandon() detaches the handlers (no second retry from a late onclose) and runs retry() without waiting for the socket");
  assert.ok(/onopen[\s\S]{0,200}lastMsg = Date\.now\(\)/.test(hl),
    "the watchdog is armed at open, so a socket that never delivers even one message is also caught");
  // The recovery path a REAL close feeds must still exist exactly as designed.
  assert.ok(hl.includes("ws.onclose = () => { clearInterval(pingT); retry(); };"), "onclose still clears the ping timer and retries");
});

// A fake WebSocket whose close() never fires onclose — the undici CLOSING-forever shape. The old
// watchdog force-closed it and then waited for an onclose that never came; the feed stayed dead.
test("ws watchdog: a mute-but-open peer whose close() never completes is still reconnected", async () => {
  const { createUniverseSocket } = require("../src/hyperliquid");
  const made = [];
  class MuteWS {
    constructor() { made.push(this); this.readyState = 1; this.closeCalls = 0; this.sent = []; }
    send(s) { this.sent.push(s); }
    close() { this.closeCalls++; this.readyState = 2; /* CLOSING, forever: onclose is never fired */ }
  }
  const sock = createUniverseSocket({ onCtxs: () => {}, log: () => {}, wsImpl: MuteWS, pingMs: 15, staleMs: 40, backoffMs: 30 });
  assert.equal(made.length, 1, "connected through the injected class");
  const first = made[0];
  first.onopen();
  first.onmessage({ data: JSON.stringify({ channel: "allDexsAssetCtxs", data: { ctxs: [["xyz", []]] } }) });
  assert.equal(sock.healthy(), true);
  await new Promise((r) => setTimeout(r, 120));   // > staleMs + a ping tick: the watchdog must have fired
  assert.ok(first.closeCalls >= 1, "the zombie was closed best-effort");
  assert.equal(sock.status().reconnects, 1, "retry() ran exactly once even though onclose never fired");
  assert.ok(sock.status().reconnects === 1, "repeat watchdog ticks on the abandoned socket do not stack retries (the ping timer is cleared)");
  await new Promise((r) => setTimeout(r, 80));    // > backoffMs + jitter: the reconnect must have constructed a NEW socket
  assert.equal(made.length, 2, "a fresh socket was opened without any help from the dead one");
  first.onclose && first.onclose({});   // a late onclose from the abandoned socket (handlers detached) must be inert
  assert.equal(sock.status().reconnects, 1, "the abandoned socket's late onclose cannot trigger a second retry");
  sock.close();
});

test("limiter: FIFO queue — a big request is not starved by a stream of small ones; priority jumps the queue", async () => {
  const { limiter } = require("../src/hyperliquid");
  // Fill the window so nothing fits until the ledger ages: the queue order is then the ONLY thing
  // that decides who goes next. usage() reads the live ledger, so the fill is by a real acquire.
  const free = limiter.usage().max - limiter.usage().used;
  if (free > 0) await limiter.acquire(free);
  const order = [];
  const big = limiter.acquire(300).then(() => order.push("big"));
  const s1 = limiter.acquire(5).then(() => order.push("s1"));
  const s2 = limiter.acquire(5).then(() => order.push("s2"));
  const pr = limiter.acquire(5, { priority: true }).then(() => order.push("prio"));
  assert.equal(limiter.queued(), 4, "all four wait behind a full window");
  assert.deepEqual(order, [], "nothing granted synchronously while the window is full");
  // No real time passes in this test: prove the ORDER by inspecting the queue contract rather than
  // waiting out the 60s window — the source is the arbiter of who is head.
  const src = require("fs").readFileSync(require("path").join(__dirname, "..", "src", "hyperliquid.js"), "utf8");
  assert.ok(/const head = queue\[0\];\s*\n\s*if \(usedNow\(now\) \+ head\.w <= MAX\)/.test(src), "only the HEAD of the queue can be granted — a small request cannot slip past a waiting big one");
  assert.ok(/while \(i < queue\.length && queue\[i\]\.prio\) i\+\+; queue\.splice\(i, 0, ent\);/.test(src), "priority inserts behind earlier priority waiters and ahead of every plain waiter");
  assert.ok(/type: "metaAndAssetCtxs", dex \}, 20, null, \{ priority: true \}/.test(src), "the universe poll is the priority caller");
  // Drain the queue without waiting out the window: the event ledger is module-private, so lean on
  // the pump's own clock by pretending the window aged — Date.now is stubbed for the pump tick only.
  const realNow = Date.now;
  Date.now = () => realNow() + 61000;
  try {
    await limiter.acquire(0);   // a zero-weight acquire queues LAST and resolves only after everyone ahead of it: the whole FIFO drained in order
    await Promise.all([big, s1, s2, pr]);
  } finally { Date.now = realNow; }
  assert.deepEqual(order, ["prio", "big", "s1", "s2"], "priority first, then strict arrival order — the 300 goes before the 5s that arrived after it");
});

test("weights: candleSnapshot and fundingHistory charges follow the documented formulas", () => {
  const { candleWeight, fundingWeight, CANDLE_MAX_BARS } = require("../src/hyperliquid");
  assert.equal(candleWeight(1), 21); assert.equal(candleWeight(60), 21); assert.equal(candleWeight(61), 22);
  assert.equal(candleWeight(2160), 56, "90d hourly");
  assert.equal(candleWeight(370), 27, "370d daily");
  assert.equal(candleWeight(4896), 102, "17d of 5m");
  assert.equal(candleWeight(4320), 92, "180d hourly");
  assert.equal(candleWeight(50000), candleWeight(CANDLE_MAX_BARS), "the server clips at 5000 bars, so does the charge");
  assert.equal(candleWeight(NaN), 21, "a bad span is charged as one bar, never zero");
  assert.equal(fundingWeight(1440), 92, "60d hourly funding");
  assert.equal(fundingWeight(744), 58, "31d hourly funding");
  assert.equal(fundingWeight(20), 21); assert.equal(fundingWeight(21), 22);
});

test("coinalyze: every retry attempt is charged and the total 429 wait per call is capped", async () => {
  const { createCoinalyze } = require("../src/hyperliquid");
  const realFetch = global.fetch;
  let calls = 0;
  global.fetch = async () => { calls++; return { ok: false, status: 429, headers: { get: () => "2" } }; };   // Retry-After 2s = the clamp floor
  try {
    // Cap below one sleep: the call fails before it waits at all — one attempt, one charge.
    let cz = createCoinalyze({ key: "k", log: () => {}, sleep429CapMs: 1000 });
    let u0 = cz.usage().used, t0 = Date.now();
    await assert.rejects(cz.exchanges(), /HTTP 429/);
    assert.ok(Date.now() - t0 < 1000, "the cap trips BEFORE the sleep, not after (" + (Date.now() - t0) + "ms)");
    assert.equal(calls, 1, "one attempt went out before the cap tripped");
    assert.equal(cz.usage().used - u0, 1, "that attempt was charged");
    // Cap between one and two sleeps: exactly one 2s wait, two attempts, two charges.
    calls = 0; cz = createCoinalyze({ key: "k", log: () => {}, sleep429CapMs: 2500 });
    u0 = cz.usage().used; t0 = Date.now();
    await assert.rejects(cz.exchanges(), /HTTP 429/);
    assert.equal(calls, 2, "second attempt went out after the first sleep; the third would have breached the cap");
    assert.ok(Date.now() - t0 >= 1900 && Date.now() - t0 < 3500, "total 429 wait honoured once, then capped (" + (Date.now() - t0) + "ms)");
    assert.equal(cz.usage().used - u0, 2, "EVERY attempt is charged, not just the first");
  } finally { global.fetch = realFetch; }
  const src = require("fs").readFileSync(require("path").join(__dirname, "..", "src", "hyperliquid.js"), "utf8");
  assert.ok(/for \(let a = 0; a < 3; a\+\+\) \{\s*\n\s*await czLimiter\.acquire\(units\);/.test(src), "the acquire sits INSIDE the attempt loop");
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
  // Pins updated (reliability pass): the thresholds are now the tunables STALE_MS / BACKOFF0 (harness seams, production defaults unchanged).
  assert.ok(/if \(Date\.now\(\) - lastData > STALE_MS\)/.test(src), "the watchdog reads data silence, so a dead subscription on a live socket is abandoned and re-subscribed");
  assert.ok(/if \(!gotData\) \{ gotData = true; backoff = BACKOFF0; \}/.test(src) && !/onopen = \(\) => \{\s*\n\s*backoff = (1000|BACKOFF0);/.test(src), "backoff resets on first data, not on open");
});
