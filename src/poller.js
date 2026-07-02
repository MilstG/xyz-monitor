"use strict";
// Owns all Hyperliquid I/O. Polls the universe, backfills candle history, samples OI,
// and maintains two cached payloads (/api/snapshot and /api/daily) that clients read.
const { fetchMetaAndCtxs, fetchCandles, sleep } = require("./hyperliquid");
const { featuresFromHourly, oiDeltaPct, fundingAvg, meanPairwiseCorr } = require("./compute");
const { classify } = require("./sectors");

const HOUR = 3600 * 1000, DAY = 86400 * 1000;
const TF = { h1: HOUR, h4: 4 * HOUR, d1: DAY, d7: 7 * DAY, d30: 30 * DAY };
const SP_ALIASES = ["SPX", "SPX500", "SP500", "US500", "USSPX500", "SP500USD", "SPXUSD", "GSPC", "SP", "US500USD"];

const OI_MIN_GAP = 4.5 * 60 * 1000;   // store at most one OI sample per ~5 min
const OI_RETENTION = 31 * DAY;        // keep 31 days of OI history
const HOURLY_STALE = 10 * 60 * 1000;  // refresh hourly features every 10 min
const DAILY_STALE = 6 * 3600 * 1000;  // refresh daily candles every 6 h
const UNIVERSE_MS = 30 * 1000;        // poll price/funding/vol/OI + detect new markets
const FAIL_BACKOFF = 60 * 1000;       // after a failed candle fetch, wait >= this before retrying that coin
const REGIME_LOOKBACK = 30;           // days of daily returns for the market-wide correlation
const REGIME_TOPN = 40;               // correlation is measured across the top-N markets by volume
const REGIME_SAMPLE_MS = 30 * 60 * 1000;  // append one correlation sample to history every 30 min
const REGIME_RETENTION = 90 * DAY;    // keep ~90 days of samples to percentile against
const REGIME_MIN_SAMPLES = 8;         // don't report a percentile until the baseline has this many

function num(x) { const v = typeof x === "number" ? x : parseFloat(x); return Number.isFinite(v) ? v : null; }

function createPoller({ dex, store, log }) {
  const rows = new Map();          // coin -> row
  const hist = store.loadAll(Date.now() - OI_RETENTION); // coin -> [[ts, oi], ...]
  let order = [];
  let benchCoin = null;
  let snapshotCache = null, dailyCache = null, lastPoll = 0;
  let dailyVer = 0, dailySig = "";   // ETag version for /api/daily — bumps only when daily content changes
  const regimeHist = store.loadRegime(Date.now() - REGIME_RETENTION);   // [[ts, corr], ...]
  let curCorr = null, curCorrPct = null, curCorrN = 0, lastRegimeSample = 0;
  log(`Loaded ${regimeHist.length} regime-correlation sample(s)`);
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
      const f = (r.funding != null && isFinite(r.funding)) ? r.funding : null;
      h.push([now, r.oiBase, f]);
      store.insert(r.coin, now, r.oiBase, f);
      while (h.length && h[0][0] < cut) h.shift();
    }
  }

  // Per-market OI + funding history (for the ticker drawer sparklines).
  function getSeries(coin) {
    const h = hist.get(coin);
    if (!h) return { oi: [], funding: [] };
    const oi = [], funding = [];
    for (const s of h) { oi.push([s[0], s[1]]); if (s[2] != null) funding.push([s[0], s[2]]); }
    return { oi, funding };
  }

  function computeDoi(r) {
    const h = hist.get(r.coin), out = {};
    for (const k in TF) out[k] = oiDeltaPct(h, r.oiBase, TF[k]); // tolerance is derived inside oiDeltaPct
    return out;
  }

  // Time-weighted average funding per window, over the same interval as the ΔOI legs, so the
  // regime's funding corroboration is measured on matching windows rather than a point-in-time rate.
  function computeFundWin(r) {
    const h = hist.get(r.coin), out = {};
    for (const k in TF) out[k] = fundingAvg(h, TF[k]);
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
    let removed = 0;
    for (const k of [...rows.keys()]) if (!seen.has(k)) { rows.delete(k); hist.delete(k); removed++; }
    if (newCount || removed || benchCoin == null) benchCoin = detectBenchmark();
    sampleOI();
    lastPoll = Date.now();
    if (newCount || removed) buildSnapshot();
  }

  async function refreshHourly(coin) {
    const r = rows.get(coin);
    if (!r) return;
    const now = Date.now();
    if (r.px == null) { r.hourlyTs = now; return; }
    const c = await fetchCandles(coin, "1h", now - 31 * DAY, now, 33);
    const { ref, feat } = featuresFromHourly(c, now, HOUR, DAY);
    r.ref = ref; r.feat = feat; r.hourlyTs = Date.now(); r.isNew = false;
  }
  async function refreshDaily(coin) {
    const r = rows.get(coin);
    if (!r) return;
    const now = Date.now();
    const c = await fetchCandles(coin, "1d", now - 370 * DAY, now, 27);
    r.dailyRaw = c; r.dailyTs = Date.now(); r.isNew = false;
    buildDaily();
  }

  // Prioritise newly listed markets, then highest 24h volume. Skips coins already being
  // fetched (identified by `prefix`) so a second worker claims the next candidate instead of
  // spinning on the one the first worker already holds — this is what makes the doubled
  // hourly/daily workers actually run in parallel.
  function pick(needsFetch, prefix) {
    let best = null;
    for (const r of rows.values()) {
      if (r.delisted || !needsFetch(r)) continue;
      if (prefix && inflight.has(prefix + r.coin)) continue;
      if (!best || (r.isNew && !best.isNew) ||
          (r.isNew === best.isNew && (r.vol || 0) > (best.vol || 0))) best = r;
    }
    return best ? best.coin : null;
  }
  const needHourly = (r) => Date.now() - r.hourlyTs > HOURLY_STALE && Date.now() >= (r.hFailUntil || 0);
  const needDaily = (r) => (!r.dailyRaw || Date.now() - r.dailyTs > DAILY_STALE) && Date.now() >= (r.dFailUntil || 0);

  async function hourlyWorker() {
    for (;;) {
      const coin = pick(needHourly, "h:");
      if (!coin) { await sleep(2000); continue; }
      if (inflight.has("h:" + coin)) { await sleep(500); continue; }
      inflight.add("h:" + coin);
      try { await refreshHourly(coin); const r = rows.get(coin); if (r) r.hFail = 0; }
      catch (_) {
        const r = rows.get(coin);
        if (r) { r.hFail = (r.hFail || 0) + 1; r.hFailUntil = Date.now() + Math.min(FAIL_BACKOFF * r.hFail, 15 * 60 * 1000); }
      } finally { inflight.delete("h:" + coin); }
    }
  }
  // The default view needs only hourly data, so let it claim the full rate budget first;
  // daily (β + correlation) waits until every active market has its hourly features.
  function hourlyPassComplete() {
    let any = false;
    for (const r of rows.values()) {
      if (r.delisted) continue;
      any = true;
      if (!r.feat) return false;
    }
    return any;
  }
  async function dailyWorker() {
    for (;;) {
      if (!hourlyPassComplete()) { await sleep(1000); continue; }
      const coin = pick(needDaily, "d:");
      if (!coin) { await sleep(2000); continue; }
      if (inflight.has("d:" + coin)) { await sleep(800); continue; }
      inflight.add("d:" + coin);
      try { await refreshDaily(coin); const r = rows.get(coin); if (r) r.dFail = 0; }
      catch (_) {
        const r = rows.get(coin);
        if (r) { r.dFail = (r.dFail || 0) + 1; r.dFailUntil = Date.now() + Math.min(FAIL_BACKOFF * r.dFail, 15 * 60 * 1000); }
      } finally { inflight.delete("d:" + coin); }
    }
  }

  function activeMarkets() { return order.map((c) => rows.get(c)).filter(Boolean); }

  const _clsCache = new Map();
  function classifyCached(t) { let v = _clsCache.get(t); if (!v) { v = classify(t); _clsCache.set(t, v); } return v; }

  // ---- market regime: mean pairwise correlation across the top markets, percentiled vs history ----
  function computeCorrNow() {
    const top = activeMarkets()
      .filter((r) => !r.delisted && r.dailyRaw && r.dailyRaw.length >= 5)
      .sort((a, b) => (b.vol || 0) - (a.vol || 0))
      .slice(0, REGIME_TOPN);
    if (top.length < 3) return { corr: null, n: top.length };
    const { corr } = meanPairwiseCorr(top.map((r) => r.dailyRaw), REGIME_LOOKBACK);
    return { corr, n: top.length };
  }
  function percentileOf(v) {
    if (v == null) return null;
    let below = 0, cnt = 0;
    for (const s of regimeHist) { const c = s[1]; if (c == null || !isFinite(c)) continue; cnt++; if (c <= v) below++; }
    return cnt >= REGIME_MIN_SAMPLES ? Math.round((100 * below) / cnt) : null;
  }
  function sampleRegime() {
    const { corr, n } = computeCorrNow();
    curCorr = corr; curCorrN = n;
    const now = Date.now();
    if (corr != null && now - lastRegimeSample >= REGIME_SAMPLE_MS) {
      regimeHist.push([now, corr]);
      const cut = now - REGIME_RETENTION;
      while (regimeHist.length && regimeHist[0][0] < cut) regimeHist.shift();
      lastRegimeSample = now;
      store.saveRegime(regimeHist);
    }
    curCorrPct = percentileOf(corr);
  }

  function buildSnapshot() {
    sampleRegime();
    const markets = activeMarkets().map((r) => {
      const cl = classifyCached(r.ticker);
      return {
        coin: r.coin, ticker: r.ticker, delisted: !!r.delisted,
        px: r.px, prevDay: r.prevDay, funding: r.funding, vol: r.vol, oi: r.oi, oiBase: r.oiBase,
        oracle: r.oracle, d1: r.d1, ref: r.ref, feat: r.feat, doi: computeDoi(r), fundByWin: computeFundWin(r),
        sector: cl.sector, assetClass: cl.assetClass,
      };
    });
    snapshotCache = {
      ts: Date.now(), dataTs: lastPoll, dex, benchCoin, markets,
      regime: { corr: curCorr, corrPct: curCorrPct, corrN: curCorrN, corrSamples: regimeHist.length },
    };
  }
  function buildDaily() {
    const daily = {};
    let coins = 0, lens = 0;
    for (const r of activeMarkets()) if (r.dailyRaw) { daily[r.coin] = r.dailyRaw.map((k) => [k.t, k.c]); coins++; lens += r.dailyRaw.length; }
    const sig = coins + ":" + lens;
    if (sig !== dailySig) { dailySig = sig; dailyVer = Date.now(); }   // content changed -> new ETag
    dailyCache = { ts: Date.now(), dataTs: dailyVer, daily };
  }

  // ---- warm-cache persistence: survive restarts so redeploys serve instantly ----
  function hydrateFeatures() {
    const data = store.loadFeatures();
    if (!data || !data.markets) return 0;
    let n = 0;
    for (const coin in data.markets) {
      const m = data.markets[coin], r = getRow(coin);
      if (m.ref) r.ref = m.ref;
      if (m.feat) r.feat = m.feat;
      if (typeof m.hourlyTs === "number") r.hourlyTs = m.hourlyTs;
      if (typeof m.dailyTs === "number") r.dailyTs = m.dailyTs;
      if (Array.isArray(m.daily) && m.daily.length) r.dailyRaw = m.daily.map(([t, c]) => ({ t, c }));
      r.isNew = false;
      n++;
    }
    return n;
  }
  function persistFeatures() {
    const markets = {};
    for (const r of rows.values()) {
      if (r.delisted || (!r.feat && !r.dailyRaw)) continue;
      markets[r.coin] = {
        ref: r.ref || null, feat: r.feat || null,
        hourlyTs: r.hourlyTs || 0, dailyTs: r.dailyTs || 0,
        daily: r.dailyRaw ? r.dailyRaw.map((k) => [k.t, k.c]) : null,
      };
    }
    store.saveFeatures({ ts: Date.now(), markets });
  }

  async function maintenance() {
    try {
      const n = await store.prune(Date.now() - OI_RETENTION);
      if (n) log(`Pruned ${n} OI sample(s) older than 31d`);
    } catch (e) { log("prune failed: " + (e && e.message)); }
    const total = activeMarkets().filter((r) => !r.delisted).length;
    const pending = activeMarkets().filter((r) => !r.delisted && !r.dailyRaw).length;
    log(`Daily audit: ${total} active market(s), ${pending} awaiting history backfill`);
  }

  async function start() {
    const restored = hydrateFeatures();
    if (restored) log(`Restored cached features for ${restored} market(s) — serving warm`);
    await pollUniverse();
    buildSnapshot(); buildDaily();
    setInterval(pollUniverse, UNIVERSE_MS);
    hourlyWorker(); hourlyWorker();
    dailyWorker(); dailyWorker();
    setInterval(buildSnapshot, 15 * 1000);
    setInterval(buildDaily, 60 * 1000);
    setInterval(() => store.flush(), 30 * 1000);
    setInterval(persistFeatures, 120 * 1000);
    setInterval(maintenance, 24 * 3600 * 1000);
    setTimeout(maintenance, 60 * 1000);
  }

  return {
    start,
    getSnapshot: () => snapshotCache,
    getDaily: () => dailyCache,
    getSeries,
    persistFeatures,
    stats: () => ({ markets: rows.size, bench: benchCoin, oiCoins: hist.size, lastPoll }),
  };
}

module.exports = { createPoller };
