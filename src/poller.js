"use strict";
// Owns all Hyperliquid I/O. Polls the universe, backfills candle history, samples OI,
// and maintains two cached payloads (/api/snapshot and /api/daily) that clients read.
const { fetchMetaAndCtxs, fetchCandles, sleep } = require("./hyperliquid");
const { featuresFromHourly, oiDeltaPct } = require("./compute");

const HOUR = 3600 * 1000, DAY = 86400 * 1000;
const TF = { h1: HOUR, h4: 4 * HOUR, d1: DAY, d7: 7 * DAY, d30: 30 * DAY };
const SP_ALIASES = ["SPX", "SPX500", "SP500", "US500", "USSPX500", "SP500USD", "SPXUSD", "GSPC", "SP", "US500USD"];

const OI_MIN_GAP = 4.5 * 60 * 1000;   // store at most one OI sample per ~5 min
const OI_RETENTION = 31 * DAY;        // keep 31 days of OI history
const HOURLY_STALE = 10 * 60 * 1000;  // refresh hourly features every 10 min
const DAILY_STALE = 6 * 3600 * 1000;  // refresh daily candles every 6 h
const UNIVERSE_MS = 30 * 1000;        // poll price/funding/vol/OI + detect new markets

function num(x) { const v = typeof x === "number" ? x : parseFloat(x); return Number.isFinite(v) ? v : null; }

function createPoller({ dex, store, log }) {
  const rows = new Map();          // coin -> row
  const hist = store.loadAll(Date.now() - OI_RETENTION); // coin -> [[ts, oi], ...]
  let order = [];
  let benchCoin = null;
  let snapshotCache = null, dailyCache = null;
  const inflight = new Set();

  log(`Loaded persisted OI history for ${hist.size} market(s)`);

  function getRow(coin) {
    let r = rows.get(coin);
    if (!r) {
      r = {
        coin, ticker: coin.includes(":") ? coin.split(":")[1] : coin,
        px: null, prevDay: null, funding: null, vol: null, oi: null, oiBase: null, oracle: null, d1: null,
        ref: null, feat: null, dailyRaw: null, hourlyTs: 0, dailyTs: 0, isNew: true, delisted: false,
      };
      rows.set(coin, r);
    }
    return r;
  }

  function detectBenchmark() {
    for (const a of SP_ALIASES)
      for (const r of rows.values()) if (!r.delisted && r.ticker.toUpperCase() === a) return r.coin;
    for (const r of rows.values())
      if (!r.delisted && /(?:^|[^A-Z])(SPX|SP500|S&P)/i.test(r.ticker)) return r.coin;
    return null;
  }

  function sampleOI() {
    const now = Date.now(), cut = now - OI_RETENTION;
    for (const r of rows.values()) {
      if (r.delisted || r.oiBase == null || !isFinite(r.oiBase)) continue;
      let h = hist.get(r.coin);
      if (!h) { h = []; hist.set(r.coin, h); }
      const last = h[h.length - 1];
      if (last && now - last[0] < OI_MIN_GAP) continue;
      h.push([now, r.oiBase]);
      store.insert(r.coin, now, r.oiBase);
      while (h.length && h[0][0] < cut) h.shift();
    }
  }

  function computeDoi(r) {
    const h = hist.get(r.coin), out = {};
    for (const k in TF) {
      const win = TF[k], tol = Math.max(15 * 60 * 1000, win * 0.25);
      out[k] = oiDeltaPct(h, r.oiBase, win, tol);
    }
    return out;
  }

  async function pollUniverse() {
    let data;
    try { data = await fetchMetaAndCtxs(dex); }
    catch (e) { log("universe poll failed: " + e.message); return; }
    const meta = data[0], ctxs = data[1], uni = (meta && meta.universe) || [];
    order = uni.map((u) => u.name);
    const seen = new Set();
    let newCount = 0;
    uni.forEach((u, i) => {
      const coin = u.name, ctx = ctxs[i] || {}, existed = rows.has(coin), r = getRow(coin);
      if (!existed) { newCount++; log("NEW market detected: " + coin + " — queued for history backfill"); }
      r.delisted = !!u.isDelisted;
      const px = num(ctx.markPx) ?? num(ctx.midPx) ?? num(ctx.oraclePx);
      if (px != null) r.px = px;
      const pd = num(ctx.prevDayPx); if (pd != null) r.prevDay = pd;
      const fn = num(ctx.funding); if (fn != null) r.funding = fn;
      const vl = num(ctx.dayNtlVlm); if (vl != null) r.vol = vl;
      const oc = num(ctx.oraclePx); if (oc != null) r.oracle = oc;
      const oi = num(ctx.openInterest);
      if (oi != null) { r.oiBase = oi; r.oi = r.px != null ? oi * r.px : null; }
      r.d1 = (r.px != null && r.prevDay) ? (r.px - r.prevDay) / r.prevDay * 100 : r.d1;
      seen.add(coin);
    });
    for (const k of [...rows.keys()]) if (!seen.has(k)) rows.delete(k);
    benchCoin = detectBenchmark();
    sampleOI();
    buildSnapshot();
  }

  async function refreshHourly(coin) {
    const r = rows.get(coin);
    if (!r) return;
    const now = Date.now();
    if (r.px == null) { r.hourlyTs = now; return; }
    const c = await fetchCandles(coin, "1h", now - 31 * DAY, now, 33);
    const { ref, feat } = featuresFromHourly(c, now, HOUR, DAY);
    r.ref = ref; r.feat = feat; r.hourlyTs = Date.now();
  }
  async function refreshDaily(coin) {
    const r = rows.get(coin);
    if (!r) return;
    const now = Date.now();
    const c = await fetchCandles(coin, "1d", now - 370 * DAY, now, 27);
    r.dailyRaw = c; r.dailyTs = Date.now(); r.isNew = false;
    buildDaily();
  }

  // Prioritise newly listed markets, then highest 24h volume.
  function pick(needsFetch) {
    let best = null;
    for (const r of rows.values()) {
      if (r.delisted || !needsFetch(r)) continue;
      if (!best || (r.isNew && !best.isNew) ||
          (r.isNew === best.isNew && (r.vol || 0) > (best.vol || 0))) best = r;
    }
    return best ? best.coin : null;
  }
  const needHourly = (r) => Date.now() - r.hourlyTs > HOURLY_STALE;
  const needDaily = (r) => !r.dailyRaw || Date.now() - r.dailyTs > DAILY_STALE;

  async function hourlyWorker() {
    for (;;) {
      const coin = pick(needHourly);
      if (!coin || inflight.has("h:" + coin)) { await sleep(500); continue; }
      inflight.add("h:" + coin);
      try { await refreshHourly(coin); } catch (_) {} finally { inflight.delete("h:" + coin); }
    }
  }
  async function dailyWorker() {
    for (;;) {
      const coin = pick(needDaily);
      if (!coin || inflight.has("d:" + coin)) { await sleep(800); continue; }
      inflight.add("d:" + coin);
      try { await refreshDaily(coin); } catch (_) {} finally { inflight.delete("d:" + coin); }
    }
  }

  function activeMarkets() { return order.map((c) => rows.get(c)).filter(Boolean); }

  function buildSnapshot() {
    const markets = activeMarkets().map((r) => ({
      coin: r.coin, ticker: r.ticker, delisted: !!r.delisted,
      px: r.px, prevDay: r.prevDay, funding: r.funding, vol: r.vol, oi: r.oi, oiBase: r.oiBase,
      oracle: r.oracle, d1: r.d1, ref: r.ref, feat: r.feat, doi: computeDoi(r),
    }));
    snapshotCache = { ts: Date.now(), dex, benchCoin, markets };
  }
  function buildDaily() {
    const daily = {};
    for (const r of activeMarkets()) if (r.dailyRaw) daily[r.coin] = r.dailyRaw.map((k) => [k.t, k.c]);
    dailyCache = { ts: Date.now(), daily };
  }

  function maintenance() {
    const n = store.prune(Date.now() - OI_RETENTION);
    if (n) log(`Pruned ${n} OI sample(s) older than 31d`);
    const total = activeMarkets().filter((r) => !r.delisted).length;
    const pending = activeMarkets().filter((r) => !r.delisted && !r.dailyRaw).length;
    log(`Daily audit: ${total} active market(s), ${pending} awaiting history backfill`);
  }

  async function start() {
    await pollUniverse();
    buildSnapshot(); buildDaily();
    setInterval(pollUniverse, UNIVERSE_MS);
    hourlyWorker(); hourlyWorker();
    dailyWorker(); dailyWorker();
    setInterval(buildSnapshot, 15 * 1000);
    setInterval(buildDaily, 60 * 1000);
    setInterval(() => store.flush(), 30 * 1000);
    setInterval(maintenance, 24 * 3600 * 1000);
    setTimeout(maintenance, 60 * 1000);
  }

  return {
    start,
    getSnapshot: () => snapshotCache,
    getDaily: () => dailyCache,
    stats: () => ({ markets: rows.size, bench: benchCoin, oiCoins: hist.size }),
  };
}

module.exports = { createPoller };
