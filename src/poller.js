"use strict";
// Owns all Hyperliquid I/O. Polls the universe, backfills candle history, samples OI,
// and maintains two cached payloads (/api/snapshot and /api/daily) that clients read.
const { fetchMetaAndCtxs, fetchCandles, fetchFundingHistory, sleep, limiterUsage, createUniverseSocket } = require("./hyperliquid");
const {
  studyBigMove, studyBreakout, studyBreakdown, studyVolShift, studyGapFade, studyFundFlip, confSplit, studyOIFlush, studyFPDiv, compressionNow, offDriftStats, retStd, dailyRets, stdev, stopGeometryOk, fadeStats,
  EV_META, playbook, marketSessions, summarizeEvents, shouldPromote, stopTouched, detectMAPull, detectReclaim, detectFailBrk, detectPead, detectLiqFlush,
} = require("./compute");
const { featuresFromHourly, oiDeltaPct, fundingAvg, meanPairwiseCorr,
  cashAnchors, overnightAnchors, weekendAnchors, runHolds, sessionComposite, activityClock, dowClock, priceAsOf,
  pca2, hourReturnMeans, hourReturnStats, pearson,
  fourHourReturns, tapeRedStats, rvolMulti } = require("./compute");
const { etDayStr, earnDayDiff, parseEarningsCalendar, mergeEarnPrints, earnReactionsFor, recentEarnPrints, earnChunks, purgeStalePrints, reconcileEarnPrints } = require("./compute");
const { bucketCandles, trendLadder, trendRead, withFormingDaily, stackedRun, TREND_TFS, ribbonWidth, TREND_TF_MS, median } = require("./compute");
const { classify } = require("./sectors");

const HOUR = 3600 * 1000, DAY = 86400 * 1000;
const TF = { h1: HOUR, h4: 4 * HOUR, d1: DAY, d7: 7 * DAY, d30: 30 * DAY };
const SP_ALIASES = ["SPX", "SPX500", "SP500", "US500", "USSPX500", "SP500USD", "SPXUSD", "GSPC", "SP", "US500USD"];

const OI_MIN_GAP = 4.5 * 60 * 1000;   // store at most one OI sample per ~5 min
const OI_RETENTION = 365 * DAY;       // keep a YEAR of OI history (hourly-thinned past 31d) — the raw material for squeeze/fundflip base rates
const OI_FULL_RES = 31 * DAY;         // full ~5-min resolution window; older samples thin to one per hour
const HOURLY_STALE = 10 * 60 * 1000;  // refresh hourly features every 10 min
const HOURLY_HISTORY_DAYS = 180;      // rolling hourly-OHLCV window (API serves ~5000 most-recent candles = ~208d hard cap; 180d fits one call and triples the gap-study samples)
const HOURLY_FEAT_DAYS = 31;          // window actually fed to featuresFromHourly (keep features identical to before)
const HOURLY_FETCH_WEIGHT = 130;      // rate-limit weight for the cold 180d hourly pull (one-time per market)
// ---- red-tape resilience + RVOL (tunables) ---------------------------------------------------
const RED_LOOKBACK = 31 * DAY;        // fixed 31d sample on BOTH scopes so "DownCap 31d" means the same thing everywhere
const RED_BREADTH = 0.70;             // a 4h bar is "red tape" when >=70% of the scope's reporting names printed red...
const RED_MIN_CROSS = 10;             // ...among at least this many reporting names, with a negative cross-sectional median
const RED_MIN_BARS = 20;              // per-market gate: fewer matched red bars than this -> dash, never a thin character read
// ---- crypto (Hyperliquid main dex) ----------------------------------------------------------
// Top-N main-dex perps ride the same machinery with a LIGHTER footprint: 31d retention across
// the board (hourly spine, dailies, OI — no 365d tier: that exists to feed studies crypto does
// not participate in). Crypto rows NEVER enter signals, studies, the ledger, pooling, or the
// regime aggregate — enforced by keeping activeMarkets() xyz-pure and giving main its own list.
const MAIN_DEX = "";                  // Hyperliquid main perp universe
const MAIN_BENCH = "BTC";
const MAIN_TOP_N = 60;                // selected by 24h notional volume, recomputed once per UTC day
const MAIN_HIST_DAYS = 31;
const MAIN_DAILY_DAYS = 92;           // crypto DAILY-candle window: 90d of chart plus EMA21 seed headroom.
                                      // Hourly stays 31d — the bump serves the D1 ladder rung, the drawer's
                                      // 90d sparkline, and the AI report's daily chart; Hyperliquid backfills
                                      // the whole window in one call, so it fills on the first refresh cycle.
const MAIN_HOURLY_WEIGHT = 35;        // 31d spine pull
const MAIN_DAILY_WEIGHT = 8;          // 92d daily pull (same request weight — one candleSnapshot either way)
const HOURLY_TAIL_WEIGHT = 20;        // steady-state refresh only pulls the last ~48h and merges — cheaper than the old full-window re-pull
const FUNDING_HISTORY_DAYS = 60;      // rolling hourly funding-rate window (aligned with the price spine)
const FUNDING_FETCH_WEIGHT = 20;      // rate-limit weight for a fundingHistory pull
const FUNDING_PROBE_MIN = 8;          // if the first N (highest-vol) backfills all return nothing, treat
const DAILY_STALE = 6 * 3600 * 1000;  // refresh daily candles every 6 h
const UNIVERSE_MS = 30 * 1000;        // poll price/funding/vol/OI + detect new markets
const FAIL_BACKOFF = 60 * 1000;       // after a failed candle fetch, wait >= this before retrying that coin
const HOURLY_PASS_THRESHOLD = 0.9;    // start daily backfill once this fraction of markets have hourly features
const ANALYTICS_MS = 3 * 60 * 1000;   // recompute the session / time-of-day analytics payload every 3 min
const HOURLY_PERSIST_MS = 10 * 60 * 1000;   // save the raw hourly spine to /data so it survives redeploys
                                      // (so a few permanently-unfetchable markets can't block all daily data)
const REGIME_LOOKBACK = 30;           // days of daily returns for the market-wide correlation
const REGIME_TOPN = 40;               // correlation is measured across the top-N markets by volume
const REGIME_SAMPLE_MS = 30 * 60 * 1000;  // append one correlation sample to history every 30 min
const REGIME_RETENTION = 90 * DAY;    // keep ~90 days of samples to percentile against
const REGIME_MIN_SAMPLES = 8;         // don't report a percentile until the baseline has this many
// ---- earnings calendar (Finnhub) -------------------------------------------------------------
// One GET per refresh covers the whole 14d window for every symbol; we filter to our xyz equities.
// External dependency is data-only (env FINNHUB_TOKEN, no package) and fully degradable: token
// missing or endpoint down -> the tab says so and badges vanish; nothing else is touched.
const EARN_WINDOW_DAYS = 14;          // forward calendar window served to the tab
const EARN_STALE = 6 * 3600 * 1000;   // refetch when the last GOOD fetch is older than this
const EARN_RETRY_MS = 30 * 60 * 1000; // staleness check cadence (doubles as failure retry)
const EARN_ALIAS = { BRKB: "BRK.B" }; // xyz ticker -> US exchange symbol where they differ
// Signals whose claim spans a session boundary (drift, gap, breakout follow-through): an earnings
// print inside the horizon is a different return distribution than the study sample, so the
// evidence contribution is capped — same mechanism and same cap as the no-live-edge guard.
const EARN_GUARD = new Set(["breakout", "breakdown", "gap", "ondrift"]);
function num(x) { const v = typeof x === "number" ? x : parseFloat(x); return Number.isFinite(v) ? v : null; }
// Payload-trim helpers: the snapshot ships hundreds of derived floats per market at full
// double precision (17 digits) — quantizing to what the UI can actually display cuts the
// JSON 30-50% without changing a single rendered pixel. `rnd` = fixed decimals (for %
// values), `sig` = significant digits (for prices, which span 6 orders of magnitude).
function rnd(x, dp) { return Number.isFinite(x) ? +x.toFixed(dp) : null; }
function sig(x, n) { return Number.isFinite(x) ? (x === 0 ? 0 : +x.toPrecision(n)) : null; }

function createPoller({ dex, store, log, version, crypto, aiFetch: aiFetchOpt }) {
  const rows = new Map();          // coin -> row
  const hist = store.loadAll(Date.now() - OI_RETENTION); // coin -> [[ts, oi], ...]
  let order = [];
  let benchCoin = null;
  let mainOrder = [], mainList = [], mainSel = new Set(), mainDay = 0;   // main-dex universe order / today's selection
  let snapshotCache = null, dailyCache = null, lastPoll = 0;
  let dailyVer = 0, dailySig = "";   // ETag version for /api/daily — bumps only when daily content changes
  let analyticsCache = null, analyticsVer = 0, analyticsSig = "";   // ETag version for /api/analytics
  let signalsCache = null, signalsVer = 0, signalsSig = "";         // ETag version for /api/signals
  let earnCache = null, earnVer = 0, earnSig = "", lastEarnOk = 0, earnErr = null;   // /api/earnings payload + freshness
  let trendCache = null, trendVer = 0, trendSig = "", trendBuilt = 0;   // /api/trend — lazy, memoized, ETag rides content
  const earnMap = new Map();   // ticker -> sorted upcoming [{d, s, eps}] for badge/guard proximity lookups
  let earnPrints = [], earnHistDone = false, earnStudy = {};   // past prints (persisted, self-accruing) + per-ticker reaction stats
  let earnVoids = new Set();   // operator tombstones (ticker|date): feed-garbage prints, permanently ignored at every ingest point
  const regimeHist = store.loadRegime(Date.now() - REGIME_RETENTION);   // [[ts, corr], ...]
  let curCorr = null, curCorrPct = null, curCorrN = 0, lastRegimeSample = 0;
  log(`Loaded ${regimeHist.length} regime-correlation sample(s)`);
  const inflight = new Set();
  // WebSocket universe accelerator: null until start(); REST remains authoritative for
  // membership. wsApplied counts ctx batches folded into rows (for /api/health).
  let sock = null, wsApplied = 0, lastWsApply = 0, universeTick = 0;
  // fundingHistory-endpoint support is unknown until probed against this dex; forward-fill + the
  // oi.log seed guarantee >=~31d of funding regardless, so this only gates the 60d backfill.
  let fundingHistoryEnabled = true, fundProbeTries = 0, fundProbeOk = 0;

  log(`Loaded persisted OI history for ${hist.size} market(s)`);

  function getRow(coin) {
    let r = rows.get(coin);
    if (!r) {
      r = {
        coin, ticker: coin.includes(":") ? coin.split(":")[1] : coin,
        uni: coin.includes(":") ? "xyz" : "main",
        px: null, prevDay: null, funding: null, vol: null, oi: null, oiBase: null, oracle: null, d1: null,
        ref: null, feat: null, dailyRaw: null, hourlyRaw: null, fundH: new Map(), fundBackfilled: false,
        hourlyTs: 0, dailyTs: 0, isNew: true, delisted: false,
      };
      rows.set(coin, r);
    }
    return r;
  }

  function detectBenchmark() {
    // xyz rows ONLY: the main dex lists SPX-style memecoin tickers (SPX6900 trades as "SPX"),
    // which would match the alias/regex below and silently hijack the equity benchmark —
    // poisoning beta, RS, gap-excess and the regime aggregate against a memecoin.
    for (const a of SP_ALIASES)
      for (const r of rows.values()) if (r.uni === "xyz" && !r.delisted && r.ticker.toUpperCase() === a) return r.coin;
    // Fallback for unseen variants: the token must END after optional digits (SPX, SPX500,
    // SPX-mini) — a trailing letter (SPXW, SPYDER) is a different instrument, not the index.
    for (const r of rows.values())
      if (r.uni === "xyz" && !r.delisted && /(?:^|[^A-Z])(?:SPX|SP500|S&P)\d*(?![A-Z0-9])/i.test(r.ticker)) return r.coin;
    return null;
  }

  function sampleOI() {
    const now = Date.now(), cut = now - OI_RETENTION;
    samplePrem(now);
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

  // Per-market hourly OHLCV spine (rolling ~HOURLY_HISTORY_DAYS): [[t,o,h,l,c,v], ...] oldest->newest.
  // Backs the time-of-day / session / boundary-hold analytics. Re-fetched wholesale on every hourly
  // refresh, so it self-heals after a restart (no separate persistence) — it just needs one refresh
  // cycle (<= HOURLY_STALE) to repopulate for markets that were serving warm from features.json.
  function getHourly(coin) {
    const r = rows.get(coin), c = r && r.hourlyRaw;
    if (!Array.isArray(c)) return [];
    const out = [];
    for (const k of c) {
      const t = +k.t, o = +k.o, h = +k.h, l = +k.l, cl = +k.c, v = +k.v;
      if (Number.isFinite(t) && Number.isFinite(cl))
        out.push([t, Number.isFinite(o) ? o : cl, Number.isFinite(h) ? h : cl, Number.isFinite(l) ? l : cl, cl, Number.isFinite(v) ? v : 0]);
    }
    return out;
  }
  function hourlyCoverage() {
    let coins = 0, candles = 0;
    for (const r of rows.values()) if (Array.isArray(r.hourlyRaw) && r.hourlyRaw.length) { coins++; candles += r.hourlyRaw.length; }
    return { coins, candles };
  }

  // Per-market hourly funding-rate series: [[hourTs, rate], ...] oldest->newest, rolling FUNDING_HISTORY_DAYS.
  // Built from three sources (oi.log seed, live forward-fill, best-effort fundingHistory backfill) and
  // deduped by hour, so the boundary engine can integrate funding cost over any hold window.
  function getFunding(coin) {
    const r = rows.get(coin);
    if (!r || !r.fundH || !r.fundH.size) return [];
    const cut = Date.now() - FUNDING_HISTORY_DAYS * DAY, out = [];
    for (const [t, rate] of r.fundH) if (t >= cut && Number.isFinite(rate)) out.push([t, rate]);
    out.sort((a, b) => a[0] - b[0]);
    return out;
  }
  function fundingCoverage() {
    let coins = 0, points = 0;
    for (const r of rows.values()) if (r.fundH && r.fundH.size) { coins++; points += r.fundH.size; }
    return { coins, points, endpoint: fundingHistoryEnabled ? "on" : "off(sampled)" };
  }
  // Seed the hourly funding series from persisted oi.log samples (one value per hour) so we start with
  // ~31d of funding history immediately, independent of whether fundingHistory works for this dex.
  function seedFundingFromOI() {
    let seeded = 0;
    for (const [coin, h] of hist) {
      const r = rows.get(coin); if (!r) continue;
      for (const s of h) { const t = s[0], f = s[2]; if (f != null && Number.isFinite(f)) { r.fundH.set(Math.floor(t / HOUR) * HOUR, f); } }
      if (r.fundH.size) seeded++;
    }
    if (seeded) log(`Seeded hourly funding from oi.log for ${seeded} market(s)`);
  }

  // Premium history: (mark - oracle) / oracle in bp, sampled every ~10 min, 7 days retained in
  // memory (~1k points/market). This is the baseline that turns "premium is +18bp" into
  // "premium is 2.6 sigma rich vs its own week" — the surveillance signal for HIP-3 synthetics.
  // Persisted (downsampled) inside features.json so redeploys keep the baseline.
  let lastPremSample = 0;
  function samplePrem(now) {
    if (now - lastPremSample < 10 * 60 * 1000) return;
    lastPremSample = now;
    const cut = now - 7 * DAY;
    for (const r of rows.values()) {
      if (r.delisted || r.px == null || !(r.oracle > 0)) continue;
      if (!r.premH) r.premH = [];
      r.premH.push([now, +((r.px / r.oracle - 1) * 1e4).toFixed(2)]);
      while (r.premH.length && r.premH[0][0] < cut) r.premH.shift();
    }
  }
  function premBaseline(r) {
    const h = r.premH;
    if (!h || h.length < 100) return null;   // ~17h of samples minimum before we trust a z-score
    let s = 0; for (const [, v] of h) s += v;
    const m = s / h.length;
    let q = 0; for (const [, v] of h) q += (v - m) * (v - m);
    const sd = Math.sqrt(q / (h.length - 1));
    return sd > 0.5 ? { m, sd, n: h.length } : null;   // degenerate flat baselines are useless
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
    const hourNow = Math.floor(Date.now() / HOUR) * HOUR;
    uni.forEach((u, i) => {
      const coin = u.name, ctx = ctxs[i] || {}, existed = rows.has(coin), r = getRow(coin);
      if (!existed && !u.isDelisted) { newCount++; log("NEW market detected: " + coin + " — queued for history backfill"); }
      const wasDelisted = r.delisted;
      r.delisted = !!u.isDelisted;
      if (r.delisted && !wasDelisted) r.delistedAt = Date.now();   // starts the heavy-data GC clock (see maintenance)
      if (!r.delisted) r.delistedAt = 0;
      foldCtx(r, ctx, hourNow);
      seen.add(coin);
    });
    if (crypto) await pollMainUniverse(seen, hourNow, (n) => { newCount += n; });
    let removed = 0;
    for (const k of [...rows.keys()]) if (!seen.has(k)) { rows.delete(k); hist.delete(k); removed++; }
    if (newCount || removed || benchCoin == null) benchCoin = detectBenchmark();
    sampleOI();
    lastPoll = Date.now();
    if (newCount || removed) buildSnapshot();
  }

  function foldCtx(r, ctx, hourNow) {
    const px = num(ctx.markPx) ?? num(ctx.midPx) ?? num(ctx.oraclePx);
    if (px != null) r.px = px;
    const pd = num(ctx.prevDayPx); if (pd != null) r.prevDay = pd;
    const fn = num(ctx.funding); if (fn != null) { r.funding = fn; r.fundH.set(hourNow, fn); }  // forward-fill the current hour
    const vl = num(ctx.dayNtlVlm); if (vl != null) r.vol = vl;
    const oc = num(ctx.oraclePx); if (oc != null) r.oracle = oc;
    const oi = num(ctx.openInterest);
    if (oi != null) { r.oiBase = oi; r.oi = r.px != null ? oi * r.px : null; }
    r.d1 = (r.px != null && r.prevDay) ? (r.px - r.prevDay) / r.prevDay * 100 : r.d1;
  }
  // Main-dex universe: fetch, select top-N by volume once per UTC day, fold contexts.
  // Deselected/delisted coins with existing rows are marked delisted (existing GC trims their
  // heavy data) and kept in `seen` so the removal sweep never deletes their warm state mid-day.
  async function pollMainUniverse(seen, hourNow, addNew) {
    let md = null;
    try { md = await fetchMetaAndCtxs(MAIN_DEX); }
    catch (e) { log("main-dex poll failed: " + e.message); }
    if (!md) { for (const k of rows.keys()) if (!k.includes(":")) seen.add(k); return; }   // failed poll must not delete crypto rows
    try {
    const mUni = (md[0] && md[0].universe) || [], mCtxs = md[1] || [];
    mainOrder = mUni.map((u) => u.name);
    const dayUTC = Math.floor(Date.now() / DAY);
    if (mainDay !== dayUTC || !mainSel.size) {
      const cand = [];
      mUni.forEach((u, i) => { if (!u.isDelisted) cand.push([u.name, num((mCtxs[i] || {}).dayNtlVlm) || 0]); });
      cand.sort((a, b) => b[1] - a[1]);
      const list = cand.slice(0, MAIN_TOP_N).map((c) => c[0]);
      if (!list.includes(MAIN_BENCH) && mUni.some((u) => u.name === MAIN_BENCH && !u.isDelisted)) list.unshift(MAIN_BENCH);
      const next = new Set(list);
      if (mainSel.size) {
        let j = 0, l = 0;
        for (const c of next) if (!mainSel.has(c)) j++;
        for (const c of mainSel) if (!next.has(c)) l++;
        if (j || l) log(`Crypto universe refresh: ${next.size} selected (+${j}/-${l})`);
      } else log(`Crypto universe: top ${next.size} main-dex perps by 24h volume`);
      mainSel = next; mainList = list; mainDay = dayUTC;
    }
    mUni.forEach((u, i) => {
      const coin = u.name;
      if (!mainSel.has(coin) || u.isDelisted) {
        const ex = rows.get(coin);
        if (ex) { if (!ex.delisted) { ex.delisted = true; ex.delistedAt = Date.now(); } seen.add(coin); }
        return;
      }
      const existed = rows.has(coin), r = getRow(coin);
      if (!existed) { addNew(1); log("NEW crypto market: " + coin + " — queued for history backfill"); }
      if (r.delisted) { r.delisted = false; r.delistedAt = 0; }
      foldCtx(r, mCtxs[i] || {}, hourNow);
      seen.add(coin);
    });
    } catch (e) {
      // Isolation guarantee: a malformed main-dex payload must NEVER abort pollUniverse —
      // that would stall lastPoll and the removal sweep and take the xyz universe down with it.
      log("main-dex processing failed (isolated, xyz unaffected): " + e.message);
      for (const k of rows.keys()) if (!k.includes(":")) seen.add(k);
    }
  }
  function mainMarkets() { return mainList.map((c) => rows.get(c)).filter((r) => r && !r.delisted); }
  // Fold a WebSocket allDexsAssetCtxs event into rows. The ctx array for our dex is
  // index-aligned with its universe order — the exact alignment metaAndAssetCtxs uses — so
  // we map by position against the `order` captured on the last REST poll. If lengths
  // disagree the universe changed since that poll: skip the batch and let the next REST
  // reconciliation re-sync membership rather than smearing contexts across the wrong coins.
  // Throttled to ~1 apply per 2s: sub-second pushes buy nothing when the snapshot rebuilds
  // every 15s, and the throttle keeps sampleOI/JSON churn negligible.
  function applyWsCtxs(tuples) {
    const now = Date.now();
    if (now - lastWsApply < 2000 || !order.length) return;
    let arr = null;
    for (const t of tuples) if (Array.isArray(t) && t[0] === dex && Array.isArray(t[1])) { arr = t[1]; break; }
    if (!arr || arr.length !== order.length) return;
    const hourNow = Math.floor(now / HOUR) * HOUR;
    for (let i = 0; i < order.length; i++) {
      const r = rows.get(order[i]);
      if (!r || r.delisted) continue;
      const ctx = arr[i] || {};
      const px = num(ctx.markPx) ?? num(ctx.midPx) ?? num(ctx.oraclePx);
      if (px != null) r.px = px;
      const pd = num(ctx.prevDayPx); if (pd != null) r.prevDay = pd;
      const fn = num(ctx.funding); if (fn != null) { r.funding = fn; r.fundH.set(hourNow, fn); }
      const vl = num(ctx.dayNtlVlm); if (vl != null) r.vol = vl;
      const oc = num(ctx.oraclePx); if (oc != null) r.oracle = oc;
      const oi = num(ctx.openInterest);
      if (oi != null) { r.oiBase = oi; r.oi = r.px != null ? oi * r.px : null; }
      r.d1 = (r.px != null && r.prevDay) ? (r.px - r.prevDay) / r.prevDay * 100 : r.d1;
    }
    if (crypto && mainOrder.length) {
      try {
        let ma = null;
        for (const t of tuples) if (Array.isArray(t) && t[0] === MAIN_DEX && Array.isArray(t[1])) { ma = t[1]; break; }
        if (ma && ma.length === mainOrder.length)
          for (let i = 0; i < mainOrder.length; i++) {
            const r = rows.get(mainOrder[i]);
            if (r && !r.delisted) foldCtx(r, ma[i] || {}, hourNow);
          }
      } catch (e) { log("main-dex WS fold failed (isolated): " + e.message); }
    }
    sampleOI();
    lastPoll = now; lastWsApply = now; wsApplied++;
  }

  async function refreshHourly(coin) {
    const r = rows.get(coin);
    if (!r) return;
    const now = Date.now();
    if (r.px == null) { r.hourlyTs = now; return; }
    // Cold start OR a spine restored from an older, shallower build: one wide 180d pull.
    // Steady state: fetch only the last ~48h tail and merge — the old design re-pulled the
    // full window every refresh, which at 180d would consume the entire rate budget.
    const histDays = r.uni === "main" ? MAIN_HIST_DAYS : HOURLY_HISTORY_DAYS;
    const spine = Array.isArray(r.hourlyRaw) ? r.hourlyRaw : null;
    const firstT = spine && spine.length ? +spine[0].t : Infinity;
    const deep = spine && spine.length > 48 && firstT <= now - (histDays - (r.uni === "main" ? 7 : 30)) * DAY;
    if (!deep) {
      const wide = await fetchCandles(coin, "1h", now - histDays * DAY, now, r.uni === "main" ? MAIN_HOURLY_WEIGHT : HOURLY_FETCH_WEIGHT);
      if (Array.isArray(wide)) r.hourlyRaw = wide;
      else if (!spine) r.hourlyRaw = null;           // keep a shallow spine over nothing if the wide pull fails
    } else {
      const lastT = +spine[spine.length - 1].t || 0;
      const tail = await fetchCandles(coin, "1h", Math.max(lastT - 2 * HOUR, now - 2 * DAY), now, HOURLY_TAIL_WEIGHT);
      if (Array.isArray(tail) && tail.length) {
        const firstNew = +tail[0].t;
        r.hourlyRaw = spine.filter((k) => +k.t < firstNew).concat(tail);
      }
    }
    { const cutOld = now - histDays * DAY;
      if (Array.isArray(r.hourlyRaw)) r.hourlyRaw = r.hourlyRaw.filter((k) => +k.t >= cutOld); }
    // Features are computed from ONLY the last 31 days so hi30/lo30, volH and volD are byte-identical
    // to the previous 31d fetch — the wider window must not leak into the feature math.
    const cut = now - HOURLY_FEAT_DAYS * DAY;
    const featWin = Array.isArray(r.hourlyRaw) ? r.hourlyRaw.filter((k) => +k.t >= cut) : [];
    const { ref, feat } = featuresFromHourly(featWin, now, HOUR, DAY);
    r.ref = ref; r.feat = feat; r.hourlyTs = Date.now(); r.isNew = false;
  }
  async function refreshDaily(coin) {
    const r = rows.get(coin);
    if (!r) return;
    const now = Date.now();
    const c = r.uni === "main"
      ? await fetchCandles(coin, "1d", now - MAIN_DAILY_DAYS * DAY, now, MAIN_DAILY_WEIGHT)
      : await fetchCandles(coin, "1d", now - 370 * DAY, now, 27);
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
      if (r.coin === benchCoin) return r.coin;   // benchmark first, always: RS, β, leaders and every correlation panel gate on its history
      if (!best || (r.isNew && !best.isNew) ||
          (r.isNew === best.isNew && (r.vol || 0) > (best.vol || 0))) best = r;
    }
    return best ? best.coin : null;
  }
  const needHourly = (r) => Date.now() - r.hourlyTs > HOURLY_STALE && Date.now() >= (r.hFailUntil || 0);
  // Closes-only dailies (warm-cache restores are [t,c]; live pulls carry full OHLC) count as
  // needing a fetch REGARDLESS of dailyTs. Without this, a warm restore brings back closes-only
  // bars plus the persisted (recent) dailyTs, and the 6h staleness gate keeps every market's
  // daily candles bodiless for up to 6h after each deploy — at a multiple-builds-per-day cadence
  // that made the Trend chart modal's 1D view permanently close-ticks. A warm boot now behaves
  // like a cold boot for the daily worker (the pre-warm-cache behavior); the warm closes still
  // serve every consumer in the interim, and full candles land as the queue drains.
  const dailyLacksOHLC = (r) => Array.isArray(r.dailyRaw) && r.dailyRaw.length > 0 && r.dailyRaw[r.dailyRaw.length - 1].o == null;
  const needDaily = (r) => (!r.dailyRaw || dailyLacksOHLC(r) || Date.now() - r.dailyTs > DAILY_STALE) && Date.now() >= (r.dFailUntil || 0);

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
  // Daily backfill waits for the hourly pass to be "mostly" done rather than 100% complete:
  // in a large heterogeneous universe a few markets may be permanently unfetchable (thematics /
  // synthetics with no candle history, null px, etc.), and requiring EVERY market to have hourly
  // features let a single straggler block ALL daily data (and thus every correlation feature) forever.
  // Once ~90% have features we start daily; the stragglers still get daily via pick(needDaily) — they
  // just lack correlation until (if ever) they resolve, instead of poisoning the whole board.
  function hourlyPassComplete() {
    let total = 0, done = 0;
    for (const r of rows.values()) {
      if (r.delisted) continue;
      total++;
      if (r.feat) done++;
    }
    return total > 0 && done >= total * HOURLY_PASS_THRESHOLD;
  }
  async function dailyWorker() {
    for (;;) {
      let coin = null;
      if (!hourlyPassComplete()) {
        // Carve-out: the benchmark's daily history is what leaders/β/RS/correlation panels gate
        // on, and it costs a single fetch — pull it immediately instead of making it wait the
        // ~4 minutes of hourly backfill on a cold volume. Everything else still yields.
        const b = benchCoin ? rows.get(benchCoin) : null;
        if (b && !b.delisted && needDaily(b) && !inflight.has("d:" + b.coin)) coin = b.coin;
        else { await sleep(1000); continue; }
      } else {
        coin = pick(needDaily, "d:");
      }
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

  // Best-effort 60d hourly-funding backfill via fundingHistory. HIP-3 dex support is uncertain, so:
  // per-coin backoff on failure, and if the first FUNDING_PROBE_MIN highest-volume markets all come
  // back empty we conclude the endpoint isn't available here and stop (forward-fill + oi.log seed remain).
  async function backfillFunding(coin) {
    const r = rows.get(coin); if (!r) return 0;
    const now = Date.now();
    const days = r && r.uni === "main" ? MAIN_HIST_DAYS : FUNDING_HISTORY_DAYS;
    const data = await fetchFundingHistory(coin, now - days * DAY, now, FUNDING_FETCH_WEIGHT);
    let n = 0;
    if (Array.isArray(data)) for (const e of data) {
      const t = num(e && (e.time ?? e.t)), rate = num(e && (e.fundingRate ?? e.funding));
      if (t != null && rate != null) { r.fundH.set(Math.floor(t / HOUR) * HOUR, rate); n++; }
    }
    r.fundBackfilled = true;      // don't re-pull a coin that legitimately returned nothing
    return n;
  }
  const needFunding = (r) => fundingHistoryEnabled && !r.fundBackfilled && Date.now() >= (r.fFailUntil || 0);
  async function fundingWorker() {
    for (;;) {
      if (!fundingHistoryEnabled) { await sleep(60000); continue; }
      const coin = pick(needFunding, "f:");
      if (!coin) { await sleep(5000); continue; }
      if (inflight.has("f:" + coin)) { await sleep(800); continue; }
      inflight.add("f:" + coin);
      try {
        const n = await backfillFunding(coin);
        fundProbeTries++; if (n > 0) fundProbeOk++;
        const r = rows.get(coin); if (r) r.fFail = 0;
      } catch (_) {
        fundProbeTries++;
        const r = rows.get(coin);
        if (r) { r.fFail = (r.fFail || 0) + 1; r.fFailUntil = Date.now() + Math.min(FAIL_BACKOFF * r.fFail, 15 * 60 * 1000); }
      } finally { inflight.delete("f:" + coin); }
      if (fundProbeTries >= FUNDING_PROBE_MIN && fundProbeOk === 0) {
        fundingHistoryEnabled = false;
        log("fundingHistory returned no data for this dex — using sampled funding (~31d) + live forward-fill");
      }
    }
  }

  function activeMarkets() { return order.map((c) => rows.get(c)).filter(Boolean); }

  const _clsCache = new Map();
  function classifyCached(t, uni) { const k = (uni || "xyz") + "|" + t; let v = _clsCache.get(k); if (!v) { v = classify(t, uni); _clsCache.set(k, v); } return v; }

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

  // Is the US cash market closed right now? Global (not per-market): drives the table's live
  // gap mode. Lives here — computed fresh in EVERY snapshot build (15s) — so the open↔closed
  // flip reaches clients on their normal snapshot poll instead of riding the slow /api/daily
  // path (60s rebuild × 15-min client refetch), which is what used to lag the mode ~15 min.
  function computeOffHours(nowMs) {
    const s = nowMs - 4 * DAY, e = nowMs + 4 * DAY;
    const wins = overnightAnchors(s, e).concat(weekendAnchors(s, e));
    for (const a of wins) if (nowMs >= a.enter && nowMs < a.exit) return { closed: true, closeT: a.enter, openT: a.exit };
    return { closed: false };
  }

  // Quantize one market's snapshot fields (see rnd/sig at top). Never mutates the row —
  // r.feat/r.ref are shared with persistence and the feature math.
  function trimRef(ref) {
    if (!ref) return ref || null;
    return { p1h: sig(ref.p1h, 9), p4h: sig(ref.p4h, 9), p7d: sig(ref.p7d, 9), p30d: sig(ref.p30d, 9) };
  }
  function trimFeat(f) {
    if (!f) return f || null;
    return {
      volH: sig(f.volH, 6), volD: sig(f.volD, 6), r2: rnd(f.r2, 4),
      hi30: sig(f.hi30, 9), lo30: sig(f.lo30, 9), volBase: rnd(f.volBase, 0), vwap30: sig(f.vwap30, 9),
      dr: Array.isArray(f.dr) ? f.dr.map((x) => rnd(x, 3)) : f.dr,
      px30: Array.isArray(f.px30) ? f.px30.map((x) => sig(x, 7)) : f.px30,
    };
  }
  function trimWin(o, digits) {
    if (!o) return o || null;
    const out = {};
    for (const k in o) out[k] = digits != null ? sig(o[k], digits) : rnd(o[k], 4);
    return out;
  }

  // ---- red-tape resilience: per-universe DownCap/Hit% off the retained hourly spines --------
  // Memoized to the set of (coin, hourlyTs) pairs in each universe — spines refresh every ~10 min
  // per market, so this recomputes at most that often, never on every 15s snapshot rebuild.
  let tapeCache = { xyz: { sig: "", redBars: 0, stats: new Map() }, main: { sig: "", redBars: 0, stats: new Map() } };
  function tapeStatsFor(uniKey, list) {
    const c = tapeCache[uniKey];
    let sig = "";
    for (const r of list) sig += r.coin + ":" + (r.hourlyTs || 0) + ";";
    if (sig === c.sig) return c;
    const now = Date.now(), cut = now - RED_LOOKBACK;
    const series = new Map();
    for (const r of list) {
      const hs = getHourly(r.coin);
      if (hs.length > 24) series.set(r.coin, fourHourReturns(hs, now, cut));
    }
    const { redBars, stats } = tapeRedStats(series, { breadth: RED_BREADTH, minBars: RED_MIN_BARS, minCross: RED_MIN_CROSS });
    tapeCache[uniKey] = { sig, redBars, stats };
    return tapeCache[uniKey];
  }

  function buildSnapshot() {
    sampleRegime();
    const tapeXyz = tapeStatsFor("xyz", activeMarkets());
    const tapeMain = crypto ? tapeStatsFor("main", mainMarkets()) : tapeCache.main;
    const RVOL_WINS = { h1: HOUR, h4: 4 * HOUR, d1: DAY };
    const nowMs = Date.now();
    const mapMarket = (r) => {
      const cl = classifyCached(r.ticker, r.uni);
      // Funding percentile: where the CURRENT rate sits in this market's own 31d hourly funding
      // distribution. 96 = the crowd is paying near its monthly extreme — the classic crypto
      // mean-reversion zone. Computed for every universe; extremes are just rarer on equities.
      let fundPct = null;
      try {
        if (r.funding != null && isFinite(r.funding)) {
          const fh = getFunding(r.coin), cut = Date.now() - 31 * DAY;
          let n = 0, le = 0;
          for (const k of fh) { if (!Array.isArray(k) || k[0] < cut || !isFinite(k[1])) continue; n++; if (k[1] <= r.funding) le++; }
          if (n >= 96) fundPct = Math.round((100 * le) / n);   // >=4 days of hourly samples before we claim a percentile
        }
      } catch (_) {}
      // Red-tape resilience (fixed 31d, 4h bars, breadth-defined red, universe-median reference)
      // + clock-hour-matched relative volume for the 1h/4h/1d windows. Both derive entirely from
      // the retained hourly spine — zero additional API weight.
      const tape = r.uni === "main" ? tapeMain : tapeXyz;
      const red = tape.stats.get(r.coin) || null;
      let rvol = null;
      try { const hs = getHourly(r.coin); if (hs.length > 24) rvol = rvolMulti(hs, RVOL_WINS, nowMs); } catch (_) {}
      return {
        fundPct, red, rvol,
        coin: r.coin, ticker: r.ticker, delisted: !!r.delisted, uni: r.uni,
        px: sig(r.px, 9), prevDay: sig(r.prevDay, 9), funding: sig(r.funding, 6),
        vol: rnd(r.vol, 0), oi: rnd(r.oi, 0), oiBase: sig(r.oiBase, 9),
        oracle: sig(r.oracle, 9), d1: rnd(r.d1, 4),
        ref: trimRef(r.ref), feat: trimFeat(r.feat),
        doi: trimWin(computeDoi(r)), fundByWin: trimWin(computeFundWin(r), 6),
        sector: cl.sector, assetClass: cl.assetClass,
      };
    };
    const markets = activeMarkets().map(mapMarket);
    // Crypto ships under its OWN key: snapshot.markets stays xyz-pure so every existing consumer
    // (tabs, studies, treemap, leaders) is untouched until the scope switcher lands in Build B.
    const mainMkts = crypto ? mainMarkets().map(mapMarket) : [];
    snapshotCache = {
      ts: Date.now(), dataTs: lastPoll, dex, benchCoin,
      benchMain: crypto ? MAIN_BENCH : null, mainMarkets: mainMkts, markets,
      redBars: { xyz: tapeXyz.redBars, main: crypto ? tapeMain.redBars : 0 },
      v: version || null,
      offHours: computeOffHours(Date.now()),
      // live warmup counts: h = markets without hourly features yet, d = markets with no daily
      // closes servable at all (no 370d backfill AND no hourly spine to derive from) — lets the
      // client show "N still backfilling" instead of a mystery placeholder, and poll accordingly
      warm: (() => { let h = 0, d = 0;
        for (const r of activeMarkets()) { if (r.delisted) continue;
          if (!r.feat) h++;
          if (!r.dailyRaw && !(r.hourlyRaw && r.hourlyRaw.length > 24)) d++; }
        return { h, d }; })(),
      regime: { corr: curCorr, corrPct: curCorrPct, corrN: curCorrN, corrSamples: regimeHist.length },
    };
  }
  // Derive daily closes from the array hourly spine (last candle per UTC day) so /api/daily — and the
  // client-side correlation that reads it — can populate from the hourly spine (available early, and what
  // the warm cache restores) instead of waiting on the separate rate-limited 370d daily backfill.
  function deriveDailyClose(hs) {
    const byDay = new Map();
    for (const k of hs) { const t = k[0], c = k[4]; if (!Number.isFinite(t) || !Number.isFinite(c)) continue; const d = Math.floor(t / DAY) * DAY; const cur = byDay.get(d); if (!cur || t >= cur[0]) byDay.set(d, [t, c]); }
    return [...byDay.entries()].sort((a, b) => a[0] - b[0]).map(([, v]) => [v[0] - (v[0] % DAY), v[1]]);
  }

  function buildDailyMain(daily, funding) {
    for (const r of mainMarkets()) {
      const hs = getHourly(r.coin);
      let dr = null;
      if (r.dailyRaw && r.dailyRaw.length >= 5) dr = r.dailyRaw.map((k) => [k.t, k.c]);
      else if (hs.length > 24) dr = deriveDailyClose(hs);   // UTC-floored by construction — correct for 24/7 markets
      if (dr && dr.length) daily[r.coin] = dr.slice(-(MAIN_DAILY_DAYS + 2));
      const fh = getFunding(r.coin);
      if (fh.length) {
        const byDay = new Map();
        for (const [t, rate] of fh) { const d = Math.floor(t / DAY) * DAY; byDay.set(d, (byDay.get(d) || 0) + rate); }
        funding[r.coin] = [...byDay.entries()].sort((a, b) => a[0] - b[0]).map(([d, f]) => [d, +f.toFixed(8)]);
      }
    }
  }
  function buildDaily() {
    const daily = {}, funding = {}, overnight = {}, liveClose = {};
    const nowMs = Date.now();
    const offHours = computeOffHours(nowMs);   // kept here too for client compatibility; the snapshot copy is the fresh one
    let coins = 0, lens = 0;
    for (const r of activeMarkets()) {
      const hs = getHourly(r.coin);   // normalized array spine [[t,o,h,l,c,v], ...]; the boundary engine + priceAsOf are array-indexed
      // daily closes: prefer the real 370d backfill; otherwise bootstrap from the hourly spine
      let dr = null;
      if (r.dailyRaw && r.dailyRaw.length >= 5) dr = r.dailyRaw.map((k) => [k.t, k.c]);
      else if (hs.length > 24) dr = deriveDailyClose(hs);
      if (dr && dr.length) { daily[r.coin] = dr; coins++; lens += dr.length; }

      const fh = getFunding(r.coin);                                    // hourly [t,rate] -> daily funding a 1x long pays (sum of the day's hourly rates)
      if (fh.length) {
        const byDay = new Map();
        for (const [t, rate] of fh) { const d = Math.floor(t / DAY) * DAY; byDay.set(d, (byDay.get(d) || 0) + rate); }
        funding[r.coin] = [...byDay.entries()].sort((a, b) => a[0] - b[0]).map(([d, f]) => [d, +f.toFixed(8)]);
      }
      // overnight + weekend holds (buy at close, sell before open) via the boundary engine; memoized to the spine version
      if (hs.length > 2) {
        if (r._ovTs !== r.hourlyTs) {
          const start = hs[0][0], end = hs[hs.length - 1][0];
          const anchors = overnightAnchors(start, end).concat(weekendAnchors(start, end));
          r._ovClose = runHolds(hs, fh, anchors).map((h) => [Math.floor(h.exit / DAY) * DAY, +h.gross.toFixed(8), +(h.funding || 0).toFixed(8)]).sort((a, b) => a[0] - b[0]);
          r._ovTs = r.hourlyTs;
        }
        if (r._ovClose && r._ovClose.length) overnight[r.coin] = r._ovClose;
        if (offHours.closed) { const pc = priceAsOf(hs, offHours.closeT, 3 * HOUR); if (pc > 0) liveClose[r.coin] = +pc.toFixed(8); }  // price at the last close, for the live in-progress gap
      }
    }
    const sig = coins + ":" + lens;
    if (sig !== dailySig) { dailySig = sig; dailyVer = Date.now(); }   // content changed -> new ETag
    if (crypto) buildDailyMain(daily, funding);
    dailyCache = { ts: Date.now(), dataTs: dailyVer, daily, funding, overnight, offHours, liveClose };
  }

  // ---- signal engine (served at /api/signals) ---------------------------------------------
  // Two layers. (1) Event studies: per market, per event, every historical occurrence and its
  // forward outcome — an honest conditional base rate with sample sizes, memoized to the data
  // version and recomputed only when history changes. (2) Live surveillance: which events are
  // active RIGHT NOW, ranked by unusualness x historical edge. No prediction, no composite
  // black box — every line is "this condition, this market's own base rate, this n."
  const EV_LABEL = {
    bigmove: "Big move", breakout: "30d-high breakout", volshift: "Vol expansion",
    gap: "Outsized gap", fundflip: "Funding flip", squeeze: "Squeeze setup",
    prem: "Premium dislocation", volume: "Volume surge",
    breakdown: "30d-low breakdown", unwind: "Long unwind",
    oiflush: "OI flush", fpdiv: "Funding\u2013price divergence", coil: "Range compression",
    ondrift: "Overnight drift",
    tretest: "Trend retest (long)", tretestdn: "Trend retest (short)",
  };
  // Daily-step OI series from the sampled history: nearest sample within 12h of each UTC
  // midnight. Feeds the flush study; cheap because hist is already in memory.
  function oiDailySeries(coin) {
    const arr = hist.get(coin);
    if (!arr || arr.length < 24) return null;
    const out = []; let j = 0;
    const d0 = Math.ceil(arr[0][0] / DAY) * DAY, d1 = Math.floor(arr[arr.length - 1][0] / DAY) * DAY;
    for (let d = d0; d <= d1; d += DAY) {
      while (j < arr.length - 1 && Math.abs(arr[j + 1][0] - d) <= Math.abs(arr[j][0] - d)) j++;
      if (Math.abs(arr[j][0] - d) <= 12 * HOUR && arr[j][1] > 0) out.push([d, arr[j][1]]);
    }
    return out.length >= 10 ? out : null;
  }
  function studiesFor(r, closes, dayFunding) {
    const oiArr = hist.get(r.coin);
    const sig = (r.hourlyTs || 0) + ":" + (closes ? closes.length : 0) + ":" + (dayFunding ? dayFunding.length : 0) + ":" + (oiArr ? oiArr.length : 0);
    if (r._stSig === sig && r._st) return r._st;
    const st = {};
    if (closes && closes.length >= 40) {
      st.bigmove = studyBigMove(closes);
      st.breakout = studyBreakout(closes);
      st.breakdown = studyBreakdown(closes);
      st.oiflush = studyOIFlush(closes, oiDailySeries(r.coin));
      st.coil = closes.length >= 140 ? compressionNow(closes) : null;
      st.fpdiv = studyFPDiv(closes, dayFunding);
      if (closes.length >= 140) st.volshift = studyVolShift(closes);
    }
    const hs = getHourly(r.coin);
    if (hs.length > 48) {
      const wins = overnightAnchors(hs[0][0], hs[hs.length - 1][0]).concat(weekendAnchors(hs[0][0], hs[hs.length - 1][0]));
      st.gap = studyGapFade(hs, wins, 3 * HOUR);
      st.ondrift = offDriftStats(hs, wins, 3 * HOUR);
    }
    if (dayFunding && dayFunding.length >= 8 && closes && closes.length >= 10) st.fundflip = studyFundFlip(dayFunding, closes);
    r._stSig = sig; r._st = st;
    return st;
  }

  // ---- signal ledger: the honesty loop -----------------------------------------------------
  // Every first firing of (coin, event) opens a ledger entry with the mark, the direction the
  // event implies, and when the claim resolves. The resolver revisits each entry at its horizon
  // and records the realized outcome UNDER THE SAME SIGN CONVENTION the study claims, so the
  // in-sample base rate and the live out-of-sample record are directly comparable. Event types
  // whose live record shows no edge get their evidence score capped automatically.
  let ledgerOpen = new Map(), ledgerClosed = [], ledgerDirty = false, recordCache = null, confCache = null, recordXCache = null, recordSets = null;
  // Episode re-arm gate: when a claim resolves while its condition is STILL firing, the key is
  // parked here and openLedger refuses to re-open it until the condition lapses for at least one
  // full build. Without this, one persistent episode (a premium dislocation across a closed
  // weekend, a big move firing all day) resolves and re-opens serially — pseudo-replication that
  // inflates n and over-feeds the blend. One episode, one claim. Applies to shadows too.
  const rearm = new Set(), firedNow = new Set();
  // ---- shadow variants: bounded self-improvement --------------------------------------------
  // Each gated event carries 2-3 candidate thresholds. Only the INCUMBENT emits visible signals;
  // every variant (incumbent included) silently ledgers shadow claims on identical bookkeeping,
  // so incumbent-vs-challenger comparisons are apples-to-apples out-of-sample. Promotion is by
  // shouldPromote() in compute.js — strict gates, logged, reversible, persisted with the ledger.
  const VARIANTS = {
    bigmove:  { param: "\u03c3\u2265", vals: [1.5, 2, 2.5] },
    gap:      { param: "gate \u03c3\u2265", vals: [0.5, 0.75, 1] },
    squeeze:  { param: "score\u2265", vals: [50, 60, 70] },
    fundflip: { param: "run\u2265", vals: [2, 3, 5] },
    unwind:   { param: "score\u2265", vals: [50, 60, 70] },
    oiflush:  { param: "\u03c3\u2264\u2212", vals: [1.5, 2, 2.5] },
  };
  let variantState = { bigmove: { inc: 1, hist: [] }, gap: { inc: 1, hist: [] }, squeeze: { inc: 1, hist: [] }, fundflip: { inc: 1, hist: [] }, unwind: { inc: 1, hist: [] }, oiflush: { inc: 1, hist: [] } };
  let variantStats = {};   // ev -> [ {n,hit,avg} per variant index ]
  const incVal = (ev) => VARIANTS[ev].vals[variantState[ev].inc];
  const R_UNIT_EVS = new Set(["bigmove", "breakout", "breakdown", "fundflip", "volshift", "oiflush", "fpdiv", "reclaim", "mapull", "failbrk", "pead", "fundext", "liqflush"]);
  const unitOf = (ev) => ev === "prem" ? "bp" : (R_UNIT_EVS.has(ev) ? "R" : "%");
  // coin|ev -> { t: ms, b: bool } — when THIS episode of the condition became continuously
  // present in the builds (b = stamped on the first build after a restart, where the condition
  // may predate the stamp). Resets the moment the condition lapses for a build. This is the
  // DISPLAY time; the ledger claim keeps its own t0/mark0 — the two legitimately differ when a
  // still-resolving claim's condition lapses and returns within one episode.
  const presentSince = new Map();
  function hydrateLedger() {
    const d = store.loadLedger();
    if (!d) return;
    if (Array.isArray(d.open)) for (const e of d.open) if (e && e.key) ledgerOpen.set(e.key, e);
    if (Array.isArray(d.closed)) {
      if (d.closed.length > 4000 && store.archiveClosed) store.archiveClosed(d.closed.slice(0, d.closed.length - 4000));
      ledgerClosed = d.closed.slice(-4000);
    }
    // Unit repair: breakdown/oiflush/fpdiv claims resolved before the normalization fix carry
    // raw-% outcomes despite an R-united claim — sd0 was stamped at fire but never applied at
    // resolution. sd0 survives on the entry, so the stored record is repaired in place rather
    // than discarded. Scoped to exactly these three events (the original three were always
    // normalized, just never rn-stamped) and keyed on the rn marker, so it is idempotent
    // across boots and inert once every stored entry has passed through.
    {
      const REPAIR_EVS = new Set(["breakdown", "oiflush", "fpdiv"]);
      let repaired = 0;
      for (const e of ledgerClosed) {
        if (!REPAIR_EVS.has(e.ev) || e.rn || !(e.sd0 > 0) || e.status !== "resolved" || !Number.isFinite(e.realized)) continue;
        e.realized = +(e.realized / e.sd0).toFixed(2);
        if (e.realizedS != null) e.realizedS = e.stopped ? +(e.realizedS / e.sd0).toFixed(2) : e.realized;
        e.win = e.realized > 0; if (e.realizedS != null) e.winS = e.realizedS > 0;
        e.rn = 1; repaired++;
      }
      if (repaired) { ledgerDirty = true; log(`Ledger unit repair: sigma-normalized ${repaired} stored breakdown/oiflush/fpdiv outcome(s) to R`); }
    }
    // Stop-geometry repair: stored claims whose stop sat on the WRONG side of entry (e.g. a
    // squeeze firing near the range bottom, "stop" mechanically landing above a long's mark).
    // Their stop-aware legs are fabrications — the first candle "touched" the level and a loss
    // got capped into a positive realizedS and a false winS. Repair: the stop never validly
    // existed, so the stop-aware leg falls back to the at-horizon truth. gv=1 marks the entry
    // geometry-void (kept for forensics); idempotent — repaired entries carry no stp.
    {
      let gfix = 0;
      for (const e of ledgerClosed) {
        if (e.gv || e.stp == null) continue;
        if (stopGeometryOk(e.psd || (e.dir >= 0 ? "long" : "short"), e.mark0, e.stp)) continue;
        e.gv = 1; e.stp = null;
        if (e.status === "resolved" && Number.isFinite(e.realized)) { e.realizedS = e.realized; e.winS = e.win; }
        else { e.realizedS = null; delete e.winS; }
        e.stopped = false; gfix++;
      }
      for (const e of ledgerOpen.values()) {
        if (e.gv || e.stp == null) continue;
        if (stopGeometryOk(e.psd || (e.dir >= 0 ? "long" : "short"), e.mark0, e.stp)) continue;
        e.gv = 1; e.stp = null; gfix++;   // open claim keeps resolving, just without a stop-aware leg
      }
      if (gfix) { ledgerDirty = true; log(`Ledger stop-geometry repair: voided ${gfix} inverted stop(s); stop-aware legs reverted to at-horizon truth`); }
    }
    // Play-sign repair: stored claims whose playbook side OPPOSES the event sign (gap faders)
    // were resolved event-signed — successful fades ledgered as losses, failed ones as wins,
    // and the stamped claim median carried the study's event sign. Flip outcomes, wins, and the
    // claim median (shallow copy — study objects are shared) into the units of the published
    // play. pn=1 marks play-signed entries; idempotent across boots.
    {
      const oppose = (e) => e.psd && ((e.psd === "long" ? 1 : -1) !== (e.dir >= 0 ? 1 : -1));
      let pfix = 0;
      for (const e of ledgerClosed) {
        if (e.pn || !oppose(e)) continue;
        if (e.status === "resolved" && Number.isFinite(e.realized)) {
          e.realized = +(-e.realized).toFixed(2); e.win = e.realized > 0;
          if (e.realizedS != null && isFinite(e.realizedS)) { e.realizedS = +(-e.realizedS).toFixed(2); e.winS = e.realizedS > 0; }
        }
        if (e.claim && Number.isFinite(e.claim.med)) e.claim = Object.assign({}, e.claim, { med: +(-e.claim.med).toFixed(2), fade: true });
        e.pn = 1; pfix++;
      }
      for (const e of ledgerOpen.values()) {
        if (e.pn || !oppose(e)) continue;
        if (e.claim && Number.isFinite(e.claim.med)) e.claim = Object.assign({}, e.claim, { med: +(-e.claim.med).toFixed(2), fade: true });
        e.pn = 1; pfix++;   // outcome will be play-signed at resolution regardless — psd drives the sign statelessly
      }
      if (pfix) { ledgerDirty = true; log(`Ledger play-sign repair: flipped ${pfix} fader claim(s) into the units of the published play`); }
    }
    if (Array.isArray(d.rearm)) for (const k of d.rearm) if (typeof k === "string") rearm.add(k);
    // Presence timelines: a restart must not restamp "since when this condition has been true".
    // Restored entries resume their episode; keys whose condition no longer holds are GC'd on
    // the first build. Only a key with NO saved timeline (first deploy of this feature, or a
    // lost volume) starts observation at boot, and that one is flagged in the payload.
    if (Array.isArray(d.present)) for (const p of d.present)
      if (Array.isArray(p) && typeof p[0] === "string" && Number.isFinite(p[1])) presentSince.set(p[0], { t: p[1], b: false });
    if (d.variants) for (const ev in variantState)
      if (d.variants[ev] && Number.isInteger(d.variants[ev].inc) && d.variants[ev].inc >= 0 && d.variants[ev].inc < VARIANTS[ev].vals.length)
        variantState[ev] = { inc: d.variants[ev].inc, hist: Array.isArray(d.variants[ev].hist) ? d.variants[ev].hist.slice(-20) : [] };
    recomputeRecord();
  }
  function persistLedger() {
    if (!ledgerDirty) return;
    store.saveLedger({ ts: Date.now(), open: [...ledgerOpen.values()], closed: ledgerClosed.slice(-4000), variants: variantState, rearm: [...rearm],
      present: [...presentSince].map(([k, v]) => [k, v.t]) });   // presence timelines survive restarts — a deploy is not a lapse
    ledgerDirty = false;
  }
  // Per-ticker signal history for the drawer: every VISIBLE claim the engine ever made on one
  // name — shadow-variant claims (vi) are internal bookkeeping and never surface here. Outcomes
  // ship in the unit they actually resolved in: R for sd0-stamped R-events (post-repair this is
  // all of them), legacy % for pre-normalization-epoch entries, which are flagged so the client
  // can label them honestly instead of mixing units silently.
  // Claim-history query for the Signals-tab browser and the drawer: filter by coin, by event
  // type, or both — every VISIBLE claim matching (shadow variants never surface). At least one
  // filter is required; an unfiltered dump has no consumer and would only invite misuse.
  // Outcomes ship in the unit they actually resolved in; pre-epoch legacy entries are flagged.
  function getLedgerFor(coin, ev) {
    if (!coin && !ev) return { coin: "", ev: "", ticker: "", open: [], closed: [], ts: Date.now() };
    const pub = (e, status) => ({
      ev: e.ev, label: EV_LABEL[e.ev] || e.ev, tk: e.ticker || e.coin, coin: e.coin, t0: e.t0,
      tR: status === "resolved" ? (e.tR || null) : null, status,
      side: e.psd || (e.dir >= 0 ? "long" : "short"),
      score0: Number.isFinite(e.score0) ? e.score0 : null,
      mark0: e.mark0 != null && isFinite(e.mark0) ? e.mark0 : null,
      mv: e.mv != null ? e.mv : null,
      pr: e.pr === true, conf: e.conf === true, boot: e.bt === 1, eg: e.eg === 1,
      claimMed: e.claim && Number.isFinite(e.claim.med) ? e.claim.med : null,
      realized: status === "resolved" && Number.isFinite(e.realized) ? e.realized : null,
      realizedS: status === "resolved" && e.realizedS != null && isFinite(e.realizedS) ? e.realizedS : null,
      stopped: e.stopped === true,
      win: status === "resolved" && Number.isFinite(e.realized) ? e.realized > 0 : null,
      unit: R_LEDGER_EVS.has(e.ev) ? (e.sd0 > 0 ? "R" : "%") : unitOf(e.ev),
      legacy: R_LEDGER_EVS.has(e.ev) && !(e.sd0 > 0),   // pre-sigma-epoch: excluded from aggregates, shown here labeled
      resolveAt: status === "open" ? e.resolveAt : undefined,
    });
    const match = (e) => e.vi == null && (!coin || e.coin === coin) && (!ev || e.ev === ev);
    let ticker = coin || "";
    const open = [], closed = [];
    for (const e of ledgerOpen.values())
      if (match(e)) { open.push(pub(e, "open")); if (coin) ticker = e.ticker || ticker; }
    for (const e of ledgerClosed)
      if (match(e)) { closed.push(pub(e, e.status === "void" ? "void" : "resolved")); if (coin) ticker = e.ticker || ticker; }
    if (coin) { const r = rows.get(coin); if (r && r.ticker) ticker = r.ticker; }
    open.sort((a, b) => b.t0 - a.t0);
    closed.sort((a, b) => (b.tR || b.t0) - (a.tR || a.t0));
    return { coin: coin || "", ev: ev || "", ticker, open, closed: closed.slice(0, 150), ts: Date.now() };
  }
  // One-shot raw dump for offline analysis (GET /api/export/ledger). Deliberately NOT the
  // curated getLedgerFor shape: no 150-entry cap, no field pruning — shadow variants and
  // legacy pre-sigma entries ship as-is, distinguishable but present. The export's job is
  // completeness; exclusion is the analysis's call, made offline with the glossary in hand.
  function getLedgerExport() {
    const closed = ledgerClosed, open = [...ledgerOpen.values()];
    let shadows = 0, legacy = 0, ctxFrom = null;
    for (const e of closed) {
      if (e.vi != null) shadows++;
      if (R_LEDGER_EVS.has(e.ev) && !(e.sd0 > 0)) legacy++;
      if (e.dow != null && (ctxFrom == null || e.t0 < ctxFrom)) ctxFrom = e.t0;
    }
    return {
      meta: {
        version: version || null, exportedAt: Date.now(),
        counts: { closed: closed.length, open: open.length, shadowsClosed: shadows, legacyClosed: legacy },
        retention: "closed entries are capped at the most recent 4000; older history is gone from this store",
        // Earliest closed entry carrying the fire-time context stamp (fnd/fndP/oi5/rngP/mktR/
        // ses/dow). Entries before this are thin — the analysis states its coverage boundary
        // instead of pretending the features were always there. Null until one such entry closes.
        ctxStampSince: ctxFrom,
        glossary: {
          ev: "event type", vi: "shadow-variant index (absent = the real, visible claim)",
          t0: "fire time (ms)", tR: "resolve time (ms)", mark0: "mark at fire",
          dir: "EVENT direction sign (a gap-fader's dir is the gap, not the trade)",
          psd: "published play side (long/short) — outcome sign follows this when present",
          sd0: "30d daily sigma at fire (R normalization); an R-united event WITHOUT sd0 is a legacy %-outcome entry",
          stp: "void level frozen at fire (stop-aware track)", mv: "playbook-target distance from mark at fire, %",
          score0: "signal score at fire", pr: "prime flag at fire", conf: "confluence flag at fire",
          bt: "opened on the first post-boot build (condition may predate the stamp)", eg: "episode-gap flag",
          tal: "daily trend ribbon aligned with the claim's side at fire (1/0; absent = unknown at fire)",
          realized: "at-horizon outcome, play-signed, in the event's unit",
          realizedS: "stop-aware outcome (void-level-capped)", stopped: "void level touched before horizon",
          fnd: "funding rate at fire", fndP: "funding percentile vs this market's own 31d hourly history (>=96 samples)",
          oi5: "5d open-interest change % at fire", rngP: "position in the 30d range at fire (0=low, 1=high)",
          mktR: "benchmark 24h move % at fire (BTC for the crypto universe, the SPX proxy for xyz)",
          gw: "gapfade shadow only: void width as a multiple of the market's own gap σ (1.0 or 1.5)",
          emv: "pead shadow only: the frozen earnings-reaction move, %",
          fpx: "fundext shadow only: funding percentile at fire (the gate reading)",
          oc24: "liqflush shadow only: the 24h open-interest change % at fire (the OI leg of the gate)",
          ses: "session bucket at fire, xyz only (rth / on / wknd)", dow: "UTC day-of-week at fire (0=Sun)",
        },
      },
      closed, open,
      variants: { state: variantState, stats: variantStats },
      ts: Date.now(),
    };
  }
  function resolveAtFor(ev, t0) {
    if (ev === "gap" || ev === "gapfade") {   // resolves at the close of the next cash session after firing
      for (const ses of marketSessions(t0, t0 + 6 * DAY)) if (ses.close > t0 && ses.open > t0) return ses.close;
      return t0 + 3 * DAY;
    }
    if (ev === "ondrift") {
      let n = 0;
      for (const ses of marketSessions(t0, t0 + 20 * DAY)) { if (ses.close <= t0) continue; n++; if (n === 6) return ses.open; }
      return t0 + 10 * DAY;
    }
    const m = EV_META[ev];
    return t0 + ((m && m.horizonMs) || DAY);
  }
  // ---- fire-time context stamp -------------------------------------------------------------
  // Frozen market state at the moment a claim opens, for post-hoc slicing of the record (the
  // offline analysis pass and, later, the loss autopsy read these). Short additive keys,
  // stamped ONLY when computable — an absent key is an honest unknown, never a null pad.
  // Applies to real and shadow claims alike (variant slices want the same features). Wrapped
  // whole in try/catch: bookkeeping serves the ledger, a stamp failure must never block a
  // claim from opening. Accrues out of sample from the build that ships it; older entries
  // stay thin and the export's meta declares the coverage boundary (ctxStampSince).
  // Funding percentile of `rate` within this market's own 31d hourly history, >=96-sample
  // floor — the SAME window and floor as the screener's funding-percentile column, shared by
  // the fire-time context stamp and the fundext gate so no two consumers can disagree.
  function fundPctileNow(coin, rate, t0) {
    if (rate == null || !isFinite(rate)) return null;
    const fh = getFunding(coin), cut = t0 - 31 * DAY;
    let n = 0, le = 0;
    for (const k of fh) { if (!Array.isArray(k) || k[0] < cut || !isFinite(k[1])) continue; n++; if (k[1] <= rate) le++; }
    return n >= 96 ? Math.round((100 * le) / n) : null;
  }
  function fireCtx(r, t0) {
    const c = {};
    try {
      if (r.funding != null && isFinite(r.funding)) {
        c.fnd = +(+r.funding).toPrecision(6);
        const fp = fundPctileNow(r.coin, r.funding, t0);
        if (fp != null) c.fndP = fp;
      }
      // 5d OI change % — from the same daily OI series the flush study consumes
      const oi = oiDailySeries(r.coin);
      if (oi && oi.length >= 6) {
        const base = oi[oi.length - 6][1];
        if (base > 0) c.oi5 = +((oi[oi.length - 1][1] / base - 1) * 100).toFixed(1);
      }
      // position inside the 30d range, 0 (at the low) .. 1 (at the high)
      const f = r.feat;
      if (f && f.hi30 > f.lo30 && r.px != null)
        c.rngP = +Math.min(1, Math.max(0, (r.px - f.lo30) / (f.hi30 - f.lo30))).toFixed(2);
      // benchmark 24h move at fire: BTC for the crypto universe, the resolved SPX proxy for xyz
      const b = r.uni === "main" ? rows.get(MAIN_BENCH) : (benchCoin ? rows.get(benchCoin) : null);
      if (b && b.d1 != null && isFinite(b.d1)) c.mktR = +(+b.d1).toFixed(2);
      c.dow = new Date(t0).getUTCDay();
      // session bucket, xyz only (crypto trades a continuous week): rth = inside a cash
      // session, wknd = the surrounding closed span exceeds a day (weekend/holiday), on = an
      // ordinary overnight. Derived from the same calendar the resolver's horizons use.
      if (r.uni === "xyz") {
        const ses = marketSessions(t0 - 6 * DAY, t0 + 2 * DAY);
        let inSes = false, prevClose = null, nextOpen = null;
        for (const s of ses) {
          if (s.open <= t0 && t0 < s.close) { inSes = true; break; }
          if (s.close <= t0 && (prevClose == null || s.close > prevClose)) prevClose = s.close;
          if (s.open > t0 && (nextOpen == null || s.open < nextOpen)) nextOpen = s.open;
        }
        c.ses = inSes ? "rth" : (prevClose != null && nextOpen != null && nextOpen - prevClose > DAY ? "wknd" : "on");
      }
    } catch (_) {}
    return c;
  }
  function openLedger(r, ev, sigEntry, dir, extra, vi) {
    const key = r.coin + "|" + ev + (vi != null ? "#" + vi : "");
    // mv = playbook-target distance from the mark at fire time, in % — lets the record be
    // sliced by actionable magnitude, matching the client's move filter exactly.
    const mv = vi == null && sigEntry.play && sigEntry.play.target != null && r.px > 0
      ? +(Math.abs(sigEntry.play.target / r.px - 1) * 100).toFixed(2) : null;
    const stp = vi == null && sigEntry.play && sigEntry.play.stop != null && sigEntry.play.stop > 0
      ? +(+sigEntry.play.stop).toPrecision(6) : null;   // void level frozen at fire — the stop-aware track resolves against it
    const psd = vi == null && sigEntry.play && (sigEntry.play.side === "long" || sigEntry.play.side === "short")
      ? sigEntry.play.side : null;   // trade side per the playbook; e.dir is the EVENT sign (a gap-fader's dir is the gap, not the trade)
    firedNow.add(key);
    if (rearm.has(key)) return null;   // episode already scored — wait for the condition to lapse
    let e = ledgerOpen.get(key);
    if (!e) {
      const t0 = Date.now();
      e = Object.assign({
        key, coin: r.coin, ticker: r.ticker, ev, t0,
        mark0: r.px, dir: dir == null ? 1 : dir,
        score0: sigEntry.score, reading0: sigEntry.reading,
        claim: sigEntry.study || null,
        resolveAt: resolveAtFor(ev, Date.now()),
      }, signalsBuildCount <= 1 ? { bt: 1 } : null,   // opened on the FIRST build after a restart/deploy: the condition may predate this stamp — flagged so identical boot-time timestamps explain themselves
      vi != null ? { vi } : null, mv != null ? { mv } : null,
      // Geometry gate: a stop is only stamped when it sits on the LOSS side of entry for the
      // claim's effective side. A composite firing away from its assumed range edge produces
      // mechanically inverted levels; stamping one turns the stop-aware track into a win
      // fabricator (see the MINIMAX squeeze: -20.79% at horizon, "stopped" at +10.68%). An
      // invalid stop means this claim simply has no stop-aware leg — at-horizon only.
      stp != null && stopGeometryOk(psd || (dir >= 0 ? "long" : "short"), r.px, stp) ? { stp } : null,
      psd ? { psd, pn: 1 } : null,   // pn: play-signed regime — outcomes/claim are in the units of the published play; hydrate repair keys on its absence
      extra || {});
      // Trend-alignment stamp (tal): was the DAILY ribbon stacked with the claim's side at fire?
      // Read from the already-built trend board (never recomputed here — a per-fire ladder walk
      // would be real work for a bookkeeping stamp). 1 = D1 aligned, 0 = on a board but D1 not
      // aligned; absent = the name wasn't board material at fire (score < 2 on both sides) or
      // the board wasn't built yet — an honest unknown, excluded from the split. Accrues out of
      // sample from this build forward; the AI report's trend-conditioned base rate reads it.
      if (vi == null && (psd || dir != null)) {
        const side = psd || (dir >= 0 ? "long" : "short");
        const tal = trendAlignAtFire(r.coin, side);
        if (tal != null) e.tal = tal;
      }
      // Fire-time context stamp (fnd/fndP/oi5/rngP/mktR/ses/dow) — assigned last so a stamp
      // key could never mask a core claim field even if one were ever added carelessly; the
      // stamp's keys are all novel today and the export glossary documents each.
      Object.assign(e, fireCtx(r, t0));
      ledgerOpen.set(key, e); ledgerDirty = true;
    }
    return e;
  }
  function resolveLedger() {
    const now = Date.now();
    for (const [key, e] of ledgerOpen) {
      if (now < e.resolveAt) continue;
      let realized = null;
      if (e.ev === "ondrift") {
        const hs = getHourly(e.coin);
        if (hs.length && now >= e.resolveAt) {
          const ses = marketSessions(e.t0, e.resolveAt + DAY);
          const parts = [];
          for (let si = 0; si + 1 < ses.length && parts.length < 5; si++) {
            if (ses[si].close <= e.t0) continue;
            const pc = priceAsOf(hs, ses[si].close, 3 * HOUR), po = priceAsOf(hs, ses[si + 1].open, 3 * HOUR);
            if (pc > 0 && po > 0) parts.push((po / pc - 1) * 100);
          }
          if (parts.length >= 3)
            realized = +((e.dir >= 0 ? 1 : -1) * parts.reduce((a, b) => a + b, 0)).toFixed(2);
        }
      } else if (e.ev === "prem") {
        const r = rows.get(e.coin);
        if (r && r.premH && r.premH.length && e.prem0 != null) {
          let best = null;
          for (const p of r.premH) if (!best || Math.abs(p[0] - e.resolveAt) < Math.abs(best[0] - e.resolveAt)) best = p;
          if (best && Math.abs(best[0] - e.resolveAt) < 3 * HOUR)
            realized = +(Math.sign(e.prem0) * (e.prem0 - best[1])).toFixed(1);   // bp recovered toward oracle
        }
      } else {
        const hs = getHourly(e.coin);
        const p0 = priceAsOf(hs, e.t0, 3 * HOUR) || e.mark0;
        const p1 = priceAsOf(hs, e.resolveAt, 3 * HOUR);
        if (p0 > 0 && p1 > 0) {
          // Outcomes are signed with the PLAY the engine published (psd, stamped at fire), not
          // the event: for the one family where they differ — proven gap faders — event-signing
          // recorded successful fades as losses and stopped-out fades as green stop-aware wins.
          // Claims without a side keep the event sign (identical for every aligned event).
          const sgn = e.psd ? (e.psd === "long" ? 1 : -1) : (e.dir >= 0 ? 1 : -1);
          realized = +(sgn * (p1 / p0 - 1) * 100).toFixed(2);
          // stop-aware parallel track: if the void level was touched before horizon, the claim's
          // stop-disciplined outcome is the (dir-signed) stop distance instead of the at-horizon
          // move. Same units as `realized`. Claims without a stop keep realizedS === realized.
          // Applies to ANY claim carrying a stop — strategy shadows (gapfade/reclaim/mapull)
          // stamp one at fire; plain threshold-variant shadows never do, so nothing changes
          // for them. This is what lets a shadow strategy accrue a stop-disciplined record.
          if (e.stp != null) {
            // The touch side follows where the stop SITS relative to entry, not e.dir: a proven
            // gap-FADER's void lies in the continuation direction (above entry on an up-gap,
            // dir=+1) — keying on e.dir would call the stop "touched" on the first candle.
            const below = e.stp < (e.mark0 || p0);
            if (!stopGeometryOk(e.psd || (e.dir >= 0 ? "long" : "short"), e.mark0, e.stp)) { e.gv = 1; e.stp = null; e.stopped = false; e.realizedS = realized; }
            else {
            const touched = stopTouched(hs, e.t0, e.resolveAt, below ? 1 : -1, e.stp);
            if (touched === true) { e.stopped = true; e.realizedS = +(sgn * (e.stp / p0 - 1) * 100).toFixed(2); }
            else if (touched === false) { e.stopped = false; e.realizedS = realized; }
            }
          }
          // Sigma-normalize EVERY R-united claim: the studies claim in R, so the ledger must
          // resolve in R. The original condition listed only bigmove/breakout/fundflip —
          // breakdown/oiflush/fpdiv joined the roster later with sd0 stamped but never applied,
          // so their raw-% outcomes contaminated the R aggregates, the claim curve, and the
          // study↔live Bayesian blend. rn=1 marks the entry as resolved-normalized (the epoch
          // marker the hydrate-time repair of stored entries keys on).
          if (R_LEDGER_EVS.has(e.ev) && e.sd0 > 0) {
            realized = +(realized / e.sd0).toFixed(2);   // same R units the study claims — claimed vs live stays apples-to-apples
            if (e.realizedS != null) e.realizedS = e.stopped ? +(e.realizedS / e.sd0).toFixed(2) : realized;
            e.rn = 1;
          }
        }
      }
      if (realized == null) {
        if (now > e.resolveAt + 2 * DAY) { e.status = "void"; ledgerClosed.push(e); ledgerOpen.delete(key); ledgerDirty = true; rearm.add(key); }
        continue;
      }
      if (e.realizedS == null && e.vi == null) e.realizedS = realized;   // no stop / unknowable touch -> tracks coincide
      e.status = "resolved"; e.realized = realized; e.win = realized > 0; e.tR = now;
      if (e.realizedS != null) e.winS = e.realizedS > 0;
      ledgerClosed.push(e); ledgerOpen.delete(key); ledgerDirty = true;
      rearm.add(key);   // no re-entry until the condition lapses for a full build
    }
    if (ledgerClosed.length > 4000) {
      // Archive before trim (findings ops item 1): the retention cap was silently discarding
      // the ledger's own history — the honesty loop's raw material. Overflow goes to the
      // append-only archive on the volume first; the cap then only bounds MEMORY, not the
      // record. Guarded so harness store mocks without the method keep working.
      if (store.archiveClosed) store.archiveClosed(ledgerClosed.slice(0, ledgerClosed.length - 4000));
      ledgerClosed = ledgerClosed.slice(-4000);
    }
    if (ledgerDirty) recomputeRecord();
  }
  // Aggregates one entry set into {record, recordX, confluence, recent}. Run once unfiltered
  // and once per move-filter threshold, so the accuracy panel can show the record of ONLY the
  // claims whose target magnitude you'd actually trade. Pre-filter entries lack mv and are
  // excluded from thresholded sets (they age out of the ledger naturally).
  function buildRecordSet(res, openEntries) {
    const per = {};
    for (const e of res) {
      const b = per[e.ev] || (per[e.ev] = { resolved: 0, wins: 0, rets: [], claims: [], retsS: [], winsS: 0, stopped: 0, nS: 0 });
      b.resolved++; if (e.win) b.wins++; b.rets.push(e.realized);
      if (e.realizedS != null) { b.nS++; b.retsS.push(e.realizedS); if (e.winS) b.winsS++; if (e.stopped) b.stopped++; }
      if (e.claim && Number.isFinite(e.claim.med)) b.claims.push(e.claim.med);
    }
    const out = {};
    for (const ev in per) {
      const b = per[ev], sm = summarizeEvents(b.rets);
      const w = b.rets.filter((x) => x > 0), l = b.rets.filter((x) => x <= 0);
      const wSum = w.reduce((a, c) => a + c, 0), lSum = l.reduce((a, c) => a + c, 0);
      out[ev] = { resolved: b.resolved, hit: b.resolved ? +(b.wins / b.resolved).toFixed(2) : null,
        med: sm.n ? sm.med : null, avg: sm.n ? sm.avg : null,
        avgWin: w.length ? +(wSum / w.length).toFixed(2) : null,
        avgLoss: l.length ? +(lSum / l.length).toFixed(2) : null,
        pf: w.length && l.length && lSum !== 0 ? +(wSum / Math.abs(lSum)).toFixed(2) : null,   // profit factor: gross wins / gross losses
        claimMed: b.claims.length ? +(b.claims.reduce((a, c) => a + c, 0) / b.claims.length).toFixed(2) : null,
        open: 0, unit: unitOf(ev) };
      if (b.nS) {   // stop-aware parallel track: outcome had the void level been honored as a stop
        const smS = summarizeEvents(b.retsS);
        const wS = b.retsS.filter((x) => x > 0), lS = b.retsS.filter((x) => x <= 0);
        const wsSum = wS.reduce((a, c) => a + c, 0), lsSum = lS.reduce((a, c) => a + c, 0);
        Object.assign(out[ev], { nS: b.nS, hitS: +(b.winsS / b.nS).toFixed(2), medS: smS.n ? smS.med : null,
          avgS: smS.n ? smS.avg : null, pfS: wS.length && lS.length && lsSum !== 0 ? +(wsSum / Math.abs(lsSum)).toFixed(2) : null,
          stopped: b.stopped });
      }
    }
    for (const e of openEntries) (out[e.ev] || (out[e.ev] = { resolved: 0, hit: null, med: null, avg: null, claimMed: null, open: 0, unit: unitOf(e.ev) })).open++;
    const cf = { confN: 0, confW: 0, soloN: 0, soloW: 0 };
    for (const e of res) {
      if (typeof e.conf !== "boolean") continue;
      if (e.conf) { cf.confN++; if (e.win) cf.confW++; } else { cf.soloN++; if (e.win) cf.soloW++; }
    }
    const conf = { confN: cf.confN, confHit: cf.confN ? +(cf.confW / cf.confN).toFixed(2) : null,
      soloN: cf.soloN, soloHit: cf.soloN ? +(cf.soloW / cf.soloN).toFixed(2) : null };
    conf.bonus = conf.confN >= 15 && conf.soloN >= 15 ? Math.max(0, Math.round((conf.confHit - conf.soloHit) * 40)) : 8;
    const hitOf = (v) => (v.length ? +(v.filter((e) => e.win).length / v.length).toFixed(2) : null);
    const buckets = [{ k: "<35", lo: 0, hi: 35 }, { k: "35\u201354", lo: 35, hi: 55 }, { k: "55+", lo: 55, hi: 1e9 }]
      .map((b) => { const v = res.filter((e) => Number.isFinite(e.score0) && e.score0 >= b.lo && e.score0 < b.hi); return { k: b.k, n: v.length, hit: hitOf(v) }; });
    const side = { long: null, short: null };
    { const sOf = (e) => e.psd ? (e.psd === "long" ? 1 : -1) : (e.dir >= 0 ? 1 : -1);
      const L = res.filter((e) => sOf(e) > 0), S = res.filter((e) => sOf(e) < 0);
      side.long = { n: L.length, hit: hitOf(L) }; side.short = { n: S.length, hit: hitOf(S) }; }
    const byT = {};
    for (const e of res) { const b = byT[e.ticker] || (byT[e.ticker] = { n: 0, w: 0 }); b.n++; if (e.win) b.w++; }
    const tl = Object.keys(byT).filter((t) => byT[t].n >= 5)
      .map((t) => ({ t, n: byT[t].n, hit: +(byT[t].w / byT[t].n).toFixed(2) }))
      .sort((a, b) => b.hit - a.hit);
    const last20 = res.slice(-20);
    let cum = 0, cumS = 0;
    const curve = res.filter((e) => unitOf(e.ev) === "R" && Number.isFinite(e.realized)).slice(-200)
      .map((e) => { cum = +(cum + e.realized).toFixed(2);
        cumS = +(cumS + (e.realizedS != null ? e.realizedS : e.realized)).toFixed(2);
        return [e.tR, cum, e.ticker, e.ev, e.realized, cumS, e.realizedS != null ? e.realizedS : e.realized, !!e.stopped]; });
    const recent = res.slice(-10).reverse()
      .map((e) => ({ ticker: e.ticker, ev: e.ev, t0: e.t0, tR: e.tR, realized: e.realized, win: !!e.win, unit: unitOf(e.ev),
        realizedS: e.realizedS != null ? e.realizedS : null, stopped: !!e.stopped }));
    return { record: out, confluence: conf,
      recordX: { buckets, side, tickers: tl.length ? { best: tl.slice(0, 3), worst: tl.slice(-3).reverse() } : null,
        form: { recentN: last20.length, recentHit: hitOf(last20), allHit: hitOf(res), allN: res.length }, curve },
      recent };
  }
  const MV_THRESHOLDS = [0, 0.5, 1, 2];
  const R_LEDGER_EVS = new Set(["bigmove", "breakout", "breakdown", "fundflip", "oiflush", "fpdiv", "reclaim", "mapull", "failbrk", "pead", "fundext", "liqflush"]);
  function recomputeRecord() {
    // Unit-epoch guard: entries opened before sigma-normalization (-16) lack sd0 and were
    // resolved in %, while the studies now claim in R. Mixing them poisons medians, averages,
    // the claimed column, the curve, and the blend — so they are excluded from ALL aggregates.
    const unitOk = (e) => !R_LEDGER_EVS.has(e.ev) || e.sd0 > 0;
    const resolved = ledgerClosed.filter((e) => e.status === "resolved" && e.vi == null && unitOk(e));
    const openReal = [...ledgerOpen.values()].filter((e) => e.vi == null);
    recordSets = {};
    for (const t of MV_THRESHOLDS) for (const pr of [false, true]) {
      const f = (x) => (t === 0 || (x.mv != null && x.mv >= t)) && (!pr || x.pr === true);
      recordSets[String(t) + (pr ? "p" : "")] = buildRecordSet(resolved.filter(f), openReal.filter(f));
    }
    recordCache = recordSets["0"].record;       // evidence blend + no-edge cap always use the FULL record
    confCache = recordSets["0"].confluence;
    recordXCache = recordSets["0"].recordX;
    const vagg = {};
    for (const e of ledgerClosed) {
      if (e.status !== "resolved" || e.vi == null) continue;
      const a = vagg[e.ev] || (vagg[e.ev] = []);
      (a[e.vi] || (a[e.vi] = [])).push(e.realized);
    }
    variantStats = {};
    for (const ev in vagg) variantStats[ev] = vagg[ev].map((rets) => {
      if (!rets || !rets.length) return { n: 0, hit: null, avg: null };
      const sm = summarizeEvents(rets);
      return { n: sm.n, hit: +(rets.filter((x) => x > 0).length / rets.length).toFixed(2), avg: sm.avg };
    });
  }
  function liveNoEdge(ev) {
    const rec = recordCache && recordCache[ev];
    return !!(rec && rec.resolved >= 10 && rec.hit != null && rec.hit < 0.5 && rec.med != null && rec.med <= 0);
  }
  // 0..50 evidence, EXPECTANCY-centered: only base rates that actually paid (mean direction-
  // signed outcome > 0) earn points; a negative-expectancy base rate earns ZERO and flags the
  // signal, no matter how unusual the live condition looks. Hit rate only adds on top of
  // positive expectancy. This is the main noise gate: "weird but historically unprofitable"
  // now sinks instead of riding its intensity score.
  function evPts(st, unit) {
    const scale = unit === "R" ? 0.5 : 0.8;   // +0.5R/event is strong edge; +0.8%/event was the % calibration
    if (st.avg == null) return Math.min(1, Math.abs(st.med) / (unit === "R" ? 1 : 1.5)) * 30 + Math.abs(st.hit - 0.5) * 2 * 20;
    if (st.avg <= 0) return 0;
    return Math.min(1, st.avg / scale) * 30 + Math.max(0, st.hit - 0.5) * 2 * 20;
  }
  // Evidence with Bayesian shrinkage toward the LIVE out-of-sample record: once an event type
  // has >=5 resolutions, the stats driving the score become a blend of the in-sample base rate
  // and the live record, weighted w = resolved/(resolved+25) — at 5 resolutions the study still
  // dominates (w=0.17), at 50 the live record does (w=0.67). Trust migrates continuously from
  // backtest to reality, in both directions: a live record BETTER than claimed now earns more.
  // Units align because the resolver scores ledgered events in the units the studies claim.
  function evidence(st, ev, pooled, unit) {
    const rec = recordCache && recordCache[ev];
    const scored = (stats, discount) => {
      if (rec && rec.resolved >= 5 && rec.hit != null && rec.avg != null && stats.avg != null) {
        const w = rec.resolved / (rec.resolved + 25);
        return { pts: evPts({ avg: (1 - w) * stats.avg + w * rec.avg, hit: (1 - w) * stats.hit + w * rec.hit }, unit) * discount,
          liveW: Math.round(w * 100) };
      }
      return { pts: evPts(stats, unit) * discount, liveW: null };
    };
    let base;
    if (st && st.n >= 8) { const b = scored(st, 1); base = { pts: b.pts, liveW: b.liveW, unproven: false, st, negexp: st.avg != null && st.avg <= 0 }; }
    else if (pooled && pooled.n >= 12) { const b = scored(pooled, 0.7); base = { pts: b.pts, liveW: b.liveW, unproven: true, st: st && st.n ? st : null, pooled, negexp: pooled.avg != null && pooled.avg <= 0 }; }
    else base = { pts: st && st.n ? 8 : 6, unproven: true, st: st && st.n ? st : null };
    base.unit = unit || "%";
    if (ev && liveNoEdge(ev)) { base.pts = Math.min(base.pts, 8); base.noedge = true; }   // hard guard stays on top of the blend
    return base;
  }
  function mkSignal(r, ev, valTxt, intensity, evd, extra) {
    return Object.assign({
      coin: r.coin, ticker: r.ticker, ev, label: EV_LABEL[ev], reading: valTxt,
      score: Math.round(Math.min(50, Math.max(0, intensity)) + evd.pts),
      evp: evd.pts,   // raw evidence points — internal handle for the earnings guard, deleted before the payload ships
      unproven: !!evd.unproven, noedge: !!evd.noedge, negexp: !!evd.negexp,
      liveW: evd.liveW || null,
      study: evd.st ? { n: evd.st.n, med: evd.st.med, hit: evd.st.hit, avg: evd.st.avg, unit: evd.unit } : null,
      pooled: evd.pooled ? { n: evd.pooled.n, med: evd.pooled.med, hit: evd.pooled.hit, avg: evd.pooled.avg, unit: evd.unit } : null,
    }, extra || {});
  }

  function checkPromotions() {
    for (const ev in VARIANTS) {
      const stats = variantStats[ev]; if (!stats) continue;
      const inc = variantState[ev].inc, incStats = stats[inc];
      let best = null;
      for (let vi = 0; vi < VARIANTS[ev].vals.length; vi++) {
        if (vi === inc || !stats[vi]) continue;
        if (shouldPromote(incStats, stats[vi]) && (!best || stats[vi].avg > stats[best].avg)) best = vi;
      }
      if (best != null) {
        const h = { t: Date.now(), from: VARIANTS[ev].vals[inc], to: VARIANTS[ev].vals[best],
          incN: incStats.n, incAvg: incStats.avg, chN: stats[best].n, chAvg: stats[best].avg };
        variantState[ev].inc = best;
        variantState[ev].hist.push(h); if (variantState[ev].hist.length > 20) variantState[ev].hist.shift();
        ledgerDirty = true;
        log(`Variant promotion: ${ev} threshold ${h.from} -> ${h.to} (incumbent ${h.incAvg} on n=${h.incN} vs challenger ${h.chAvg} on n=${h.chN}, out-of-sample)`);
      }
    }
  }
  // ---- strategy-shadow record: the Signals-tab panel's data --------------------------------
  // Whole candidate STRATEGIES (vs the threshold variants above) earning an out-of-sample
  // record before any promotion. This panel is read-only bookkeeping: aggregates over the
  // same ledger entries, computed server-side once per build — the client renders, never
  // re-derives. Labels/tips ship from here so the panel and the engine can't drift apart.
  const STRAT_DEFS = [
    { ev: "gapfade", label: "universal gap fade", unit: "%",
      split: [{ vi: 0, tag: "void 1.0\u03c3" }, { vi: 1, tag: "void 1.5\u03c3" }],
      tip: "every >=1\u03c3 gap, faded toward the prior close REGARDLESS of the per-name fade/continue record \u2014 the out-of-sample test of roster-wide gap mean reversion. Two void widths (1.0x and 1.5x this market's own gap \u03c3) run side by side on identical entries." },
    { ev: "reclaim", label: "breakdown reclaim", unit: "R",
      tip: "a fresh break of the prior 30d closing low that the mark has already reclaimed \u2014 long the sprung trap: stop at the flush low, target the measured move above the level. 5d horizon, R-united, stop-aware." },
    { ev: "failbrk", label: "failed-breakout fade", unit: "R",
      tip: "the short mirror: a fresh break ABOVE the prior 30d high that the mark has already lost \u2014 stop at the flush high, target the measured move below. 5d horizon. Motivated by the live record: breakout continuation ran negative expectancy." },
    { ev: "mapull", label: "MA50 pullback", unit: "R",
      tip: "rising 50d MA, price pulled back from >=4% above to touch it \u2014 long at the MA, stop 1\u03c3 below it, target the prior 30d closing high. 10d horizon." },
    { ev: "pead", label: "post-earnings drift", unit: "R",
      tip: "an earnings reaction >=1.5\u03c3 of the name's own daily vol, entered only after the reaction session completes, drifting WITH the move \u2014 stop 1\u03c3 back through the reaction close. 10d horizon, stocks only; accrues at earnings-season pace." },
    { ev: "fundext", label: "funding extreme fade", unit: "R",
      tip: "funding at the >=95th (or <=5th) percentile of this market's own 31d hourly history for a FULL day \u2014 fade the crowd toward the range mid, stop 1.5\u03c3 with them. 5d horizon, crypto only." },
    { ev: "liqflush", label: "cascade exhaustion", unit: "R",
      tip: "a >=2\u03c3 24h drop WITH a >=8% 24h open-interest drop \u2014 forced liquidations did the selling, not information. Long the exhaustion: stop 1\u03c3 below the post-flush mark, target the half-retrace of the flush. 3d horizon, crypto only. The frozen oc24 field records the OI leg for later slicing." },
  ];
  function shadowRecord() {
    const evs = new Set(STRAT_DEFS.map((d) => d.ev));
    const agg = new Map();
    const bucket = (ev, vi) => { const k = ev + "|" + (vi || 0); let b = agg.get(k); if (!b) { b = { r: [], s: [], open: 0 }; agg.set(k, b); } return b; };
    for (const e of ledgerClosed)
      if (evs.has(e.ev) && e.status === "resolved" && Number.isFinite(e.realized)) {
        const b = bucket(e.ev, e.vi);
        b.r.push(e.realized);
        if (e.realizedS != null && isFinite(e.realizedS)) b.s.push(e.realizedS);
      }
    for (const e of ledgerOpen.values()) if (evs.has(e.ev)) bucket(e.ev, e.vi).open++;
    const stat = (b) => !b ? { n: 0, open: 0 } : {
      n: b.r.length, open: b.open,
      hit: b.r.length ? +(b.r.filter((x) => x > 0).length / b.r.length).toFixed(2) : null,
      avg: b.r.length ? +(b.r.reduce((a, x) => a + x, 0) / b.r.length).toFixed(2) : null,
      avgS: b.s.length ? +(b.s.reduce((a, x) => a + x, 0) / b.s.length).toFixed(2) : null,
    };
    return STRAT_DEFS.map((d) => ({ ev: d.ev, label: d.label, unit: d.unit, tip: d.tip,
      rows: (d.split || [{ vi: 0, tag: null }]).map((sp) => Object.assign({ tag: sp.tag || null }, stat(agg.get(d.ev + "|" + sp.vi)))) }));
  }
  let signalsBuildCount = 0;   // builds since process start — build #1 is the post-boot catch-up where in-force conditions all open at once
  function buildSignals() {
    firedNow.clear();
    signalsBuildCount++;
    resolveLedger();
    checkPromotions();
    const out = [], now = Date.now();
    const dc = dailyCache || { daily: {}, funding: {}, liveClose: {}, offHours: { closed: false } };
    // pooled raw outcomes per assetClass x event (the small-n rescue for funding flips etc.)
    const pool = {};
    const pooledFor = (ac, ev, key) => { const b = pool[ac] && pool[ac][ev + ":" + key]; return b && b.length >= 12 ? summarizeEvents(b) : null; };
    const feed = (ac, ev, key, raws) => {
      if (!raws || !raws.length) return;
      const g = pool[ac] || (pool[ac] = {});
      (g[ev + ":" + key] || (g[ev + ":" + key] = [])).push(...raws);
    };
    const acOf = (r) => classifyCached(r.ticker).assetClass || "Other";
    let swingFails = 0, swingErr = null;   // strategy-shadow failures: counted per build, logged once, never fatal
    // per-ticker earnings prints for the pead shadow: built once per build, tiny array
    const earnPrintsByTk = new Map();
    for (const pr of earnPrints) { let a = earnPrintsByTk.get(pr.t); if (!a) { a = []; earnPrintsByTk.set(pr.t, a); } a.push(pr); }
    // pass 1: studies + pooling feed
    const prepped = [];
    for (const r of activeMarkets()) {
      if (r.delisted || r.px == null) continue;
      const closes = dc.daily[r.coin] || null, dayFunding = dc.funding[r.coin] || null;
      const st = studiesFor(r, closes, dayFunding);
      const ac = acOf(r);
      if (st.bigmove && st.bigmove.raw) { feed(ac, "bigmove", "d1", st.bigmove.raw.d1); }
      if (st.breakout && st.breakout.raw) { feed(ac, "breakout", "d5", st.breakout.raw.d5); }
      if (st.breakdown && st.breakdown.raw) { feed(ac, "breakdown", "d5", st.breakdown.raw.d5); }
      if (st.oiflush && st.oiflush.raw) { feed(ac, "oiflush", "d5", st.oiflush.raw.d5); }
      if (st.fpdiv && st.fpdiv.raw) { feed(ac, "fpdiv", "d3", st.fpdiv.raw.d3); }
      if (st.volshift && st.volshift.raw) { feed(ac, "volshift", "d5", st.volshift.raw.d5); }
      if (st.gap && st.gap.raw) { feed(ac, "gap", "session", st.gap.raw.session); }
      if (st.fundflip && st.fundflip.raw) { feed(ac, "fundflip", "d3", st.fundflip.raw.d3); }
      prepped.push({ r, closes, dayFunding, st, ac });
    }
    // benchmark live gap (for excess-gap readings)
    let gBench = null;
    { const b = benchCoin ? rows.get(benchCoin) : null, pc = benchCoin ? dc.liveClose[benchCoin] : null;
      if (dc.offHours && dc.offHours.closed && b && b.px != null && pc > 0) gBench = (b.px / pc - 1) * 100; }
    // pass 2: live detection
    for (const { r, closes, dayFunding, st, ac } of prepped) {
      const rets = closes ? dailyRets(closes) : [];
      const sd30 = retStd(rets.slice(-30), 15);

      if (sd30 > 0 && r.d1 != null) {
        const zMove = Math.abs(r.d1) / sd30, dir = r.d1 > 0 ? 1 : -1, vBM = incVal("bigmove");
        // shadow-ledger every variant the measure clears (incumbent included — identical bookkeeping)
        VARIANTS.bigmove.vals.forEach((v, vi) => { if (zMove >= v) openLedger(r, "bigmove", { score: 0, reading: "" }, dir, { sd0: +sd30.toFixed(3) }, vi); });
        if (zMove >= vBM) {
          const evd = evidence(st.bigmove && st.bigmove.d1, "bigmove", pooledFor(ac, "bigmove", "d1"), "R");
          const sig = mkSignal(r, "bigmove", `${r.d1 >= 0 ? "+" : ""}${r.d1.toFixed(1)}% today (${zMove.toFixed(1)}\u03c3 ${dir > 0 ? "up" : "down"})`,
            (zMove - vBM) * 20 + 20, evd, { horizon: EV_META.bigmove.horizon });
          { const mR = sig.study ? sig.study.med : (sig.pooled ? sig.pooled.med : null);   // R -> % via this market's own sigma
            sig.play = playbook("bigmove", { px: r.px, dir, sd30, med: mR != null && sd30 > 0 ? mR * sd30 : null }); }
          out.push(sig); openLedger(r, "bigmove", sig, dir, { sd0: +sd30.toFixed(3) });
        }
      }
      if (closes && closes.length >= 31) {
        let hi = -Infinity;
        for (let j = closes.length - 31; j < closes.length - 1; j++) if (closes[j][1] > hi) hi = closes[j][1];
        if (hi > 0 && r.px > hi && closes[closes.length - 2][1] <= hi) {
          const evd = evidence(st.breakout && st.breakout.d5, "breakout", pooledFor(ac, "breakout", "d5"), "R");
          const sig = mkSignal(r, "breakout", `mark ${((r.px / hi - 1) * 100).toFixed(1)}% above the prior 30d high`,
            ((r.px / hi - 1) * 100) * 12 + 15, evd, { horizon: EV_META.breakout.horizon });
          { const mR = sig.study ? sig.study.med : (sig.pooled ? sig.pooled.med : null);
            sig.play = playbook("breakout", { px: r.px, level: hi, med: mR != null && sd30 > 0 ? mR * sd30 : null }); }
          out.push(sig); if (sd30 > 0) openLedger(r, "breakout", sig, 1, { sd0: +sd30.toFixed(3) });
        }
        let lo = Infinity;
        for (let j = closes.length - 31; j < closes.length - 1; j++) if (closes[j][1] < lo) lo = closes[j][1];
        if (isFinite(lo) && lo > 0 && r.px < lo && closes[closes.length - 2][1] >= lo) {
          const evd = evidence(st.breakdown && st.breakdown.d5, "breakdown", pooledFor(ac, "breakdown", "d5"), "R");
          const sig = mkSignal(r, "breakdown", `mark ${((1 - r.px / lo) * 100).toFixed(1)}% below the prior 30d low`,
            ((1 - r.px / lo) * 100) * 12 + 15, evd, { horizon: EV_META.breakdown.horizon });
          { const mR = sig.study ? sig.study.med : (sig.pooled ? sig.pooled.med : null);
            sig.play = playbook("breakdown", { px: r.px, level: lo, med: mR != null && sd30 > 0 ? mR * sd30 : null }); }
          out.push(sig); if (sd30 > 0) openLedger(r, "breakdown", sig, -1, { sd0: +sd30.toFixed(3) });
        }
        // ---- swing shadow setups (findings follow-on): higher-timeframe, human-tradeable
        // structures earning their record invisibly (vi=0 never surfaces anywhere) before any
        // UI promotion. R-united via sd0, stop-stamped — detection math is pure in compute.js,
        // this is assembly only. ISOLATED per row: shadow bookkeeping must NEVER take down the
        // visible signal engine (the -79 outage: one market's string-typed closes threw here
        // and safeTick ate the whole build — board blank, claims half-opened, every 10 min).
        try { if (sd30 > 0 && r.px != null) {
          const rc = detectReclaim(closes, r.px);
          if (rc && stopGeometryOk("long", r.px, rc.stop))
            openLedger(r, "reclaim", { score: 0, reading: "" }, 1,
              { sd0: +sd30.toFixed(3), psd: "long", pn: 1, stp: rc.stop,
                mv: +(Math.abs(rc.target / r.px - 1) * 100).toFixed(2) }, 0);
          // failed-breakout fade: the short mirror — same trap structure, inverted (finding F2)
          const fb = detectFailBrk(closes, r.px);
          if (fb && stopGeometryOk("short", r.px, fb.stop))
            openLedger(r, "failbrk", { score: 0, reading: "" }, -1,
              { sd0: +sd30.toFixed(3), psd: "short", pn: 1, stp: fb.stop,
                mv: +(Math.abs(fb.target / r.px - 1) * 100).toFixed(2) }, 0);
          const mp = detectMAPull(closes, r.px, sd30);
          if (mp && stopGeometryOk("long", r.px, mp.stop))
            openLedger(r, "mapull", { score: 0, reading: "" }, 1,
              { sd0: +sd30.toFixed(3), psd: "long", pn: 1, stp: mp.stop,
                mv: +(Math.abs(mp.target / r.px - 1) * 100).toFixed(2) }, 0);
          // post-earnings drift, xyz only: enter with a completed outsized reaction (the
          // detector enforces completeness, freshness and the 1.5σ magnitude floor)
          if (r.uni === "xyz" && r.dailyRaw && r.dailyRaw.length >= 25) {
            const prints = earnPrintsByTk.get(r.ticker);
            const pd = prints ? detectPead(prints, r.dailyRaw, r.px, sd30) : null;
            if (pd && stopGeometryOk(pd.side, r.px, pd.stop))
              openLedger(r, "pead", { score: 0, reading: "" }, pd.side === "long" ? 1 : -1,
                { sd0: +sd30.toFixed(3), psd: pd.side, pn: 1, stp: pd.stop,
                  mv: +(Math.abs(pd.target / r.px - 1) * 100).toFixed(2), emv: pd.mv }, 0);
          }
          // cascade exhaustion, crypto only: >=2σ 24h drop WITH >=8% 24h OI drop — forced
          // liquidations did the selling; long the exhaustion once the leverage is gone
          if (r.uni === "main" && r.d1 != null) {
            const oh = hist.get(r.coin);
            let oiChg24 = null;
            if (oh && oh.length > 4) {
              const t24 = now - DAY;
              let base = null;
              for (const k of oh) if (Math.abs(k[0] - t24) <= 3 * HOUR && (base == null || Math.abs(k[0] - t24) < Math.abs(base[0] - t24))) base = k;
              const last = oh[oh.length - 1];
              if (base && base[1] > 0 && last && last[1] > 0) oiChg24 = +((last[1] / base[1] - 1) * 100).toFixed(1);
            }
            const lf = oiChg24 != null ? detectLiqFlush(r.d1, sd30, r.px, oiChg24) : null;
            if (lf && stopGeometryOk("long", r.px, lf.stop))
              openLedger(r, "liqflush", { score: 0, reading: "" }, 1,
                { sd0: +sd30.toFixed(3), psd: "long", pn: 1, stp: lf.stop,
                  mv: +(Math.abs(lf.target / r.px - 1) * 100).toFixed(2), oc24: oiChg24 }, 0);
          }
          // persistent funding extreme, crypto only: the crowd has been paying near its own
          // monthly extreme for a FULL DAY, not one spiky hour — fade it toward the range mid
          if (r.uni === "main" && r.feat && r.feat.hi30 > r.feat.lo30) {
            const pNow = fundPctileNow(r.coin, r.funding, now);
            let rate24 = null;
            { const fh = getFunding(r.coin), t24 = now - DAY;
              for (const k of fh) if (Math.abs(k[0] - t24) <= 3 * HOUR && (rate24 == null || Math.abs(k[0] - t24) < Math.abs(rate24[0] - t24))) rate24 = k;
            }
            const pPrev = rate24 ? fundPctileNow(r.coin, rate24[1], now) : null;
            if (pNow != null && pPrev != null) {
              const crowdLong = pNow >= 95 && pPrev >= 95 && r.funding > 0;
              const crowdShort = pNow <= 5 && pPrev <= 5 && r.funding < 0;
              if (crowdLong || crowdShort) {
                const side = crowdLong ? "short" : "long", sgn = crowdLong ? 1 : -1;
                const stpX = +(r.px * (1 + sgn * (1.5 * sd30) / 100)).toPrecision(6);
                const tgt = (r.feat.hi30 + r.feat.lo30) / 2;
                const tgtOk = crowdLong ? tgt < r.px : tgt > r.px;   // range mid must sit on the profit side
                if (tgtOk && stopGeometryOk(side, r.px, stpX))
                  openLedger(r, "fundext", { score: 0, reading: "" }, crowdLong ? 1 : -1,
                    { sd0: +sd30.toFixed(3), psd: side, pn: 1, stp: stpX,
                      mv: +(Math.abs(tgt / r.px - 1) * 100).toFixed(2), fpx: pNow }, 0);
              }
            }
          }
        } } catch (e) { swingFails++; swingErr = (e && e.message) || String(e); }
        // OI flush: 7d ΔOI at a −σ extreme of its own distribution, into a decline
        if (st.oiflush && st.oiflush.cur && st.oiflush.cur.sd > 0) {
          const doiNow = computeDoi(r);
          if (doiNow && doiNow.d7 != null && r.d7 != null && isFinite(r.d7)) {
            const zF = (doiNow.d7 - st.oiflush.cur.mu) / st.oiflush.cur.sd;
            VARIANTS.oiflush.vals.forEach((v, vi) => { if (zF <= -v && r.d7 < 0 && sd30 > 0) openLedger(r, "oiflush", { score: 0, reading: "" }, 1, { sd0: +sd30.toFixed(3) }, vi); });
            if (zF <= -incVal("oiflush") && r.d7 < 0) {
              const evd = evidence(st.oiflush.d5, "oiflush", pooledFor(ac, "oiflush", "d5"), "R");
              const sig = mkSignal(r, "oiflush", `\u0394OI7d ${doiNow.d7.toFixed(1)}% (${zF.toFixed(1)}\u03c3 flush) into a ${r.d7.toFixed(1)}% decline`,
                (-zF - incVal("oiflush")) * 18 + 18, evd, { horizon: EV_META.oiflush.horizon });
              { const mR = sig.study ? sig.study.med : (sig.pooled ? sig.pooled.med : null);
                sig.play = playbook("oiflush", { px: r.px, sd30, med: mR != null && sd30 > 0 ? mR * sd30 : null }); }
              out.push(sig); if (sd30 > 0) openLedger(r, "oiflush", sig, 1, { sd0: +sd30.toFixed(3) });
            }
          }
        }
        // Funding–price divergence: trajectory against tape, both directions
        if (st.fpdiv && sd30 > 0 && r.d7 != null && isFinite(r.d7)) {
          const fwD = computeFundWin(r);
          if (fwD && fwD.d1 != null && fwD.d7 != null) {
            const EPS_H = 5e-6, z7 = r.d7 / (sd30 * Math.sqrt(7));
            let dDir = 0;
            if (z7 >= 0.8 && fwD.d1 < fwD.d7 - EPS_H) dDir = 1;
            else if (z7 <= -0.8 && fwD.d1 > fwD.d7 + EPS_H) dDir = -1;
            if (dDir) {
              const evd = evidence(st.fpdiv.d3, "fpdiv", pooledFor(ac, "fpdiv", "d3"), "R");
              const sig = mkSignal(r, "fpdiv", `${dDir > 0 ? "strength" : "weakness"} (${z7.toFixed(1)}\u03c3 7d) while funding ${dDir > 0 ? "falls" : "rises"} \u2014 ${dDir > 0 ? "shorts pressing" : "longs averaging down"}`,
                (Math.abs(z7) - 0.8) * 20 + 16, evd, { horizon: EV_META.fpdiv.horizon });
              { const mR = sig.study ? sig.study.med : (sig.pooled ? sig.pooled.med : null);
                sig.play = playbook("fpdiv", { px: r.px, dir: dDir, sd30, med: mR != null && sd30 > 0 ? mR * sd30 : null }); }
              out.push(sig); openLedger(r, "fpdiv", sig, dDir, { sd0: +sd30.toFixed(3) });
            }
          }
        }
      }
      if (rets.length >= 130) {
        const vols = [];
        for (let i = 10; i <= rets.length; i++) vols.push(retStd(rets.slice(i - 10, i), 8));
        const cur = vols[vols.length - 1], hist = vols.slice(-121, -1).filter((x) => x != null);
        if (cur != null && hist.length >= 60) {
          const p90 = [...hist].sort((a, b) => a - b)[Math.floor(hist.length * 0.9)];
          if (cur > p90) {
            const evd = evidence(st.volshift && st.volshift.d5, "volshift", pooledFor(ac, "volshift", "d5"), "R");
            const sig = mkSignal(r, "volshift", `10d vol ${cur.toFixed(1)}%/d vs p90 ${p90.toFixed(1)}%/d`,
              (cur / p90 - 1) * 60 + 12, evd, { horizon: EV_META.volshift.horizon });
            sig.play = playbook("volshift", {});
            out.push(sig);   // no ledger: no directional claim to resolve
          }
        }
      }
      if (dc.offHours && dc.offHours.closed && st.gap && st.gap.sd > 0) {
        const pc = dc.liveClose[r.coin];
        if (pc > 0) {
          const g = (r.px / pc - 1) * 100, gz = Math.abs(g) / st.gap.sd;
          VARIANTS.gap.vals.forEach((v, vi) => { if (gz >= v) openLedger(r, "gap", { score: 0, reading: "" }, g >= 0 ? 1 : -1, null, vi); });
          // Universal size-conditioned fade (findings S1+S5): every >=1σ gap shadow-ledgers a
          // fade claim in BOTH void widths — 1.0x and 1.5x this market's own gap σ — with the
          // prior close as target, REGARDLESS of the per-name fade/continue record. This is the
          // out-of-sample test of the roster-wide mean-reversion structure the analysis found;
          // play-signed against the gap with a real stop so the stop-disciplined record accrues.
          // vi != null keeps it invisible everywhere until it earns anything.
          try { if (gz >= 1) {
            const fsd = g >= 0 ? "short" : "long", fdir = g >= 0 ? 1 : -1;
            const mvF = +(Math.abs(pc / r.px - 1) * 100).toFixed(2);
            [1, 1.5].forEach((w, vi) => {
              const stpF = +(r.px * (1 + fdir * (w * st.gap.sd) / 100)).toPrecision(6);
              if (stopGeometryOk(fsd, r.px, stpF))
                openLedger(r, "gapfade", { score: 0, reading: "" }, fdir,
                  { psd: fsd, pn: 1, stp: stpF, mv: mvF, gw: w }, vi);
            });
          } } catch (e) { swingFails++; swingErr = (e && e.message) || String(e); }
          if (gz >= incVal("gap")) {
            const exc = gBench != null && r.coin !== benchCoin ? g - gBench : null;
            // Play units for faders: when this market's own record says gaps FADE (the exact
            // condition the playbook keys on), the study handed to scoring — and therefore the
            // claim stamped on the ledger — is flipped into the units of the play the engine
            // actually publishes. Without this, proven faders were tagged `neg exp` (evidence
            // zeroed, never prime) while the card simultaneously told you to fade the gap.
            const gs0 = st.gap.session;
            const gs = gs0 && gs0.n >= 8 && gs0.med != null && gs0.med < 0 ? fadeStats(gs0) : gs0;
            const evd = evidence(gs, "gap", pooledFor(ac, "gap", "session"), "%");
            const reading = `${g >= 0 ? "+" : ""}${g.toFixed(2)}% since the last close (${(Math.abs(g) / st.gap.sd).toFixed(1)}\u03c3 of its gaps)`
              + (exc != null ? ` \u00b7 S&P ${gBench >= 0 ? "+" : ""}${gBench.toFixed(2)}%, excess ${exc >= 0 ? "+" : ""}${exc.toFixed(2)}%` : "");
            const sig = mkSignal(r, "gap", reading,
              (Math.abs(g) / st.gap.sd) * 14 + (exc != null ? Math.min(16, Math.abs(exc) / st.gap.sd * 12) : 0),
              evd, { horizon: EV_META.gap.horizon });
            sig.play = playbook("gap", { px: r.px, closePx: pc, gapDir: g >= 0 ? 1 : -1, gapSd: st.gap.sd, med: gs0 ? gs0.med : null, n: gs0 ? gs0.n : 0 });   // playbook detects the fade from the EVENT-signed record
            out.push(sig); openLedger(r, "gap", sig, g >= 0 ? 1 : -1);
          }
        }
      }
      if (dayFunding && dayFunding.length >= 4) {
        const last = dayFunding[dayFunding.length - 1], s0 = Math.sign(last[1]);
        let run = 0;
        for (let i = dayFunding.length - 2; i >= 0; i--) { const sg = Math.sign(dayFunding[i][1]); if (sg === 0 || sg === s0) break; run++; if (run >= 10) break; }
        if (s0 !== 0 && sd30 > 0)
          VARIANTS.fundflip.vals.forEach((v, vi) => { if (run >= v) openLedger(r, "fundflip", { score: 0, reading: "" }, s0, { sd0: +sd30.toFixed(3) }, vi); });
        if (s0 !== 0 && run >= incVal("fundflip")) {
          const evd = evidence(st.fundflip && st.fundflip.d3, "fundflip", pooledFor(ac, "fundflip", "d3"), "R");
          const sig = mkSignal(r, "fundflip", `day funding flipped ${s0 > 0 ? "positive (longs now pay)" : "negative (shorts now pay)"} after ${run}+ days the other way`,
            22, evd, { horizon: EV_META.fundflip.horizon });
          sig.play = playbook("fundflip", { dir: s0, px: r.px, sd30 });   // px + σ give the play its 1σ stop (findings ops item 3)
          out.push(sig); if (sd30 > 0) openLedger(r, "fundflip", sig, s0, { sd0: +sd30.toFixed(3) });
        }
      }
      const fw = computeFundWin(r), doi = computeDoi(r), f = r.feat;
      const fw7 = fw ? fw.d7 : null;
      if (fw7 != null && isFinite(fw7)) {
        const fAPR = fw7 * 24 * 365 * 100, crowd = fAPR < 0 ? Math.tanh(-fAPR / 35) : 0;
        if (crowd > 0) {
          const fuel = doi && doi.d7 != null ? Math.tanh(Math.max(0, doi.d7) / 8) : 0;
          let trig = 0.5;
          if (f && f.hi30 > f.lo30 && r.px != null) trig = Math.min(1, Math.max(0, (r.px - f.lo30) / (f.hi30 - f.lo30)));
          const sqz = Math.round(100 * crowd * (0.45 + 0.30 * fuel + 0.25 * trig));
          VARIANTS.squeeze.vals.forEach((v, vi) => { if (sqz >= v) openLedger(r, "squeeze", { score: 0, reading: "" }, 1, null, vi); });
          if (sqz >= incVal("squeeze")) {
            const evd = evidence(null, "squeeze", null, "%");
            const sig = mkSignal(r, "squeeze", `score ${sqz} \u2014 shorts paying ${Math.abs(fAPR).toFixed(0)}% APR, \u0394OI7d ${doi && doi.d7 != null ? (doi.d7 >= 0 ? "+" : "") + doi.d7.toFixed(1) + "%" : "n/a"}`,
              (sqz - incVal("squeeze")) * 1.1 + 15, evd, { horizon: EV_META.squeeze.horizon });
            sig.play = playbook("squeeze", { hi30: f ? f.hi30 : null, lo30: f ? f.lo30 : null });
            out.push(sig); openLedger(r, "squeeze", sig, 1);
          }
        }
        // Bearish mirror: crowded LONGS paying + OI building + price near range LOWS.
        const CARRY_APR = 12;   // typical equity-perp long carry (%APR): crowding starts ABOVE the norm, not above zero
        const crowdL = fAPR > CARRY_APR ? Math.tanh((fAPR - CARRY_APR) / 35) : 0;
        if (crowdL > 0) {
          const fuel = doi && doi.d7 != null ? Math.tanh(Math.max(0, doi.d7) / 8) : 0;
          let trigL = 0.5;
          if (f && f.hi30 > f.lo30 && r.px != null) trigL = 1 - Math.min(1, Math.max(0, (r.px - f.lo30) / (f.hi30 - f.lo30)));
          const unw = Math.round(100 * crowdL * (0.45 + 0.30 * fuel + 0.25 * trigL));
          VARIANTS.unwind.vals.forEach((v, vi) => { if (unw >= v) openLedger(r, "unwind", { score: 0, reading: "" }, -1, null, vi); });
          if (unw >= incVal("unwind")) {
            const evd = evidence(null, "unwind", null, "%");
            const sig = mkSignal(r, "unwind", `score ${unw} \u2014 longs paying ${fAPR.toFixed(0)}% APR, \u0394OI7d ${doi && doi.d7 != null ? (doi.d7 >= 0 ? "+" : "") + doi.d7.toFixed(1) + "%" : "n/a"}`,
              (unw - incVal("unwind")) * 1.1 + 15, evd, { horizon: EV_META.unwind.horizon });
            sig.play = playbook("unwind", { hi30: f ? f.hi30 : null, lo30: f ? f.lo30 : null });
            out.push(sig); openLedger(r, "unwind", sig, -1);
          }
        }
      }
      const pb = premBaseline(r);
      if (pb && r.oracle > 0) {
        const prem = (r.px / r.oracle - 1) * 1e4, z = (prem - pb.m) / pb.sd;
        if (Math.abs(z) >= 2 && Math.abs(prem) >= 5) {
          const evd = evidence(null, "prem", null);
          const sig = mkSignal(r, "prem", `${prem >= 0 ? "+" : ""}${prem.toFixed(1)}bp vs oracle (${z >= 0 ? "+" : ""}${z.toFixed(1)}\u03c3 of its 7d baseline)`,
            (Math.abs(z) - 2) * 12 + 18, evd,
            { horizon: dc.offHours && dc.offHours.closed ? "cash market closed \u2014 live off-hours price discovery" : EV_META.prem.horizon });
          sig.play = playbook("prem", { prem, oracle: r.oracle, closed: !!(dc.offHours && dc.offHours.closed) });
          out.push(sig); openLedger(r, "prem", sig, prem >= 0 ? -1 : 1, { prem0: +prem.toFixed(1) });
        }
      }
      if (f && f.volBase > 0 && r.vol != null && r.vol / f.volBase >= 2.5) {
        const sig = mkSignal(r, "volume", `24h volume ${(r.vol / f.volBase).toFixed(1)}\u00d7 its 30d norm`,
          (r.vol / f.volBase - 2.5) * 10 + 12, { pts: 6, unproven: true }, { horizon: EV_META.volume.horizon });
        sig.play = playbook("volume", {});
        out.push(sig);
      }
      if (st.coil && st.coil.coiled) {
        // Context only: no ledger claim, no direction. Feeds direction-aware confluence — a
        // breakout/breakdown firing OUT of compression is the configuration worth extra score.
        const sig = mkSignal(r, "coil", `10d realized vol at its ${st.coil.pct}th pctile of the trailing 120 \u2014 coiled`,
          (10 - st.coil.pct) * 1.5 + 10, { pts: 6, unproven: true }, { horizon: EV_META.coil.horizon });
        sig.play = playbook("coil", {});
        out.push(sig);
      }
    }
    // ---- trend retest -> ledger signal ------------------------------------------------------
    // The Trend board's RETEST badge, promoted to a ledgered claim with frozen geometry. The
    // condition IS the badge: a board-visible row (score >= 3 by trendRead's own gate, top-10 by
    // rank) whose retesting rung probed the 13/21 zone while the close held EMA21. Everything is
    // read from the SAME buildTrend output the tab renders — never re-derived here — so signal
    // and board cannot disagree (the modal lesson, applied to the ledger). Frozen at fire:
    // entry = mark, void = the rung's EMA21 (ladder value), target = the rung's prior swing
    // (null-tolerant: no valid swing -> no target, mv stays null, the claim still ledgers with
    // its stop-aware leg). Board score / rung / rrv / age ride along as recorded features —
    // recorded, NOT gated: the ledger decides which slices earn trust, not the trigger.
    // Stocks/macro universe only, like every ledgered event; crypto enrollment is the separate
    // crypto-signals project. Outcomes in raw % (not sigma-R): there is no in-sample study to
    // stay unit-compatible with — this event earns its record purely out of sample.
    {
      if (!trendCache || now - trendBuilt > TREND_MS) { try { buildTrend(); } catch (e) { log("buildTrend error in signals: " + (e && e.message)); } }
      if (trendCache) {
        for (const side of ["long", "short"]) {
          const ev = side === "long" ? "tretest" : "tretestdn";
          for (const e of (trendCache[side].stocks || [])) {
            if (!e.retest) continue;
            const r = rows.get(e.coin);
            if (!r || r.delisted || !(r.px > 0)) continue;
            const cell = e.tf && e.tf[e.retest];
            if (!cell || !(cell.e21 > 0)) continue;
            const dir = side === "long" ? 1 : -1;
            const evd = evidence(null, ev, null, "%");
            const reading = `${e.retest} retest \u2014 pullback into the 13/21 zone of a ${e.score}/4 stacked ${side === "long" ? "uptrend" : "downtrend"}, close holding EMA21`
              + (e.rrv != null ? ` \u00b7 zone volume ${e.rrv.toFixed(1)}\u00d7` : "")
              + (e.age != null ? ` \u00b7 trend age ${e.age}${e.ageCap ? "+" : ""}d` : "");
            const sigT = mkSignal(r, ev, reading,
              10 + 8 * e.score + (e.rrv != null && e.rrv <= 1 ? 6 : 0),   // quiet pullbacks (rrv <= 1x) read healthier than fought ones — small nudge, recorded either way
              evd, { horizon: EV_META[ev].horizon });
            sigT.play = playbook(ev, { tf: e.retest, score: e.score, e21: cell.e21, swing: e.swing != null ? e.swing : null, px: r.px });
            out.push(sigT);
            openLedger(r, ev, sigT, dir, { tf: e.retest, tsc: e.score, rrv: e.rrv != null ? +e.rrv.toFixed(2) : null, tage: e.age != null ? e.age : null });
          }
        }
      }
    }
    // freshness: trigger time + age on every signal. Ledgered events use their ledger entry;
    // the rest use a light first-seen map. Past its horizon a signal decays, past 2x it drops.
    // Overnight-drift anomaly: each market's summed off-hours drift over its last ~21 closed
    // windows, z-scored ACROSS THE UNIVERSE. |z|>=2 with |drift|>=1% absolute fires a claim on
    // the NEXT 5 overnight windows, held close->open — resolved by a dedicated branch, since
    // the outcome is a sum of windows, not one span. Record-only evidence: this event ships
    // without a per-market backtest (stated on the card) and earns trust purely out of sample.
    {
      const rowsD = [];
      for (const r of activeMarkets()) {
        if (r.delisted || !r._st || !r._st.ondrift) continue;
        rowsD.push([r, r._st.ondrift.drift30]);
      }
      if (rowsD.length >= 25) {
        const vals = rowsD.map((k) => k[1]);
        const mu = vals.reduce((a, b) => a + b, 0) / vals.length, sdD = stdev(vals);
        if (sdD > 0) for (const [r, d30] of rowsD) {
          const z = (d30 - mu) / sdD;
          if (Math.abs(z) < 2 || Math.abs(d30) < 1) continue;
          const dir = d30 > 0 ? 1 : -1;
          const evd = evidence(null, "ondrift", null, "%");
          const sig = mkSignal(r, "ondrift", `${d30 >= 0 ? "+" : ""}${d30.toFixed(1)}% off-hours drift over ~21 windows (${z.toFixed(1)}\u03c3 vs universe)`,
            (Math.abs(z) - 2) * 16 + 18, evd, { horizon: EV_META.ondrift.horizon });
          sig.play = playbook("ondrift", { dir });
          out.push(sig); openLedger(r, "ondrift", sig, dir);
        }
      }
    }
    const kept = [], live = new Set();
    for (const g of out) {
      // Earnings guard: a report today/tomorrow (ET) sits inside the horizon of session-spanning
      // claims. The study sample excludes no prints, but a known binary catalyst ahead is a PRIOR
      // the base rate can't see — so the evidence contribution is capped at the same 8 points the
      // no-live-edge guard uses, and the signal wears the flag. Intensity is untouched: the
      // condition is real; only the borrowed statistical confidence is trimmed.
      if (EARN_GUARD.has(g.ev)) {
        const ep = earnProx(g.ticker);
        if (ep && ep.diff <= 1) {
          g.earn = { d: ep.e.d, s: ep.e.s, prox: ep.diff };
          if (g.evp > 8) { g.score = Math.max(0, Math.round(g.score - (g.evp - 8))); g.earnguard = true; }
          // Ledger accounting for the earnings-conditioned split: the claim is stamped when it
          // was in force within 1 ET day of a scheduled print (stamped once; a claim opened
          // earlier that lives into the window earns the tag — its horizon contains the print).
          const eG = ledgerOpen.get(g.coin + "|" + g.ev);
          if (eG && eG.eg == null) { eG.eg = 1; ledgerDirty = true; }
        }
      }
      delete g.evp;
      // structure: median-target vs invalidation R/R, folded into the score. Poor structure
      // (rr < 0.8) costs 20%; clean structure (rr >= 1.5) earns a nudge. Then `prime` marks
      // setups clearing EVERY bar: hit >= 60%, positive expectancy, sound structure, not
      // unproven/decayed/no-edge — the ones worth emphasizing.
      const rr0 = rows.get(g.coin);
      if (g.play && g.play.target != null && g.play.stop != null && rr0 && rr0.px > 0) {
        const dn = Math.abs(g.play.stop - rr0.px);
        if (dn > 0) {
          g.rr = +(Math.abs(g.play.target - rr0.px) / dn).toFixed(2);
          if (g.rr < 0.8) { g.score = Math.round(g.score * 0.8); g.poorRR = true; }
          else if (g.rr >= 1.5) g.score += 4;
        }
      }
      const bs = g.study && g.study.n >= 8 ? g.study : g.pooled;
      if (bs && bs.hit >= 0.6 && bs.avg > 0 && !g.noedge && !g.negexp && !g.earn && (g.rr == null || g.rr >= 1.2)) { g.prime = true; g.score += 6; }
      const key = g.coin + "|" + g.ev;
      { const e0 = ledgerOpen.get(key);   // fire-time prime quality on the claim, stamped once
        if (e0 && e0.pr == null) { e0.pr = !!g.prime; ledgerDirty = true; } }
      live.add(key);
      // Card time = condition presence (this episode); claim details ship separately. Decay
      // stays on CLAIM age — the accounting object is what expires, not the display stamp.
      if (!presentSince.has(key)) presentSince.set(key, { t: now, b: signalsBuildCount <= 1 });
      const ps = presentSince.get(key);
      g.t0 = ps.t; g.age = now - ps.t; if (ps.b) g.sinceBoot = true;
      const e = ledgerOpen.get(key);
      if (e) {
        // The FROZEN claim: the ledger resolves against exactly these — mark, side, void, and
        // the target implied by the target-distance stamped at fire. The card must render
        // these, not a per-build recompute, or the display drifts while the accounting stands
        // still (moving targets on a frozen claim destroy trust in the record).
        const fTgt = e.mv != null && e.mark0 > 0 && (e.psd === "long" || e.psd === "short")
          ? +( e.mark0 * (1 + (e.psd === "long" ? 1 : -1) * e.mv / 100) ).toPrecision(6) : null;
        g.claim0 = { t: e.t0, px: e.mark0 != null && isFinite(e.mark0) ? e.mark0 : null,
          resolveAt: e.resolveAt, boot: e.bt === 1,
          side: e.psd || null, stop: e.stp != null ? e.stp : null, tgt: fTgt };
        const claimAge = now - e.t0, span = Math.max(1, e.resolveAt - e.t0);
        if (claimAge > 2 * span) continue;
        if (claimAge > span) { g.score = Math.round(g.score * 0.6); g.decayed = true; g.prime = false; }   // client shows the amber decaying state
      }
      kept.push(g);
    }
    for (const k of presentSince.keys()) if (!live.has(k)) presentSince.delete(k);   // condition lapsed for a build -> this episode's presence ends; next fire restamps
    // confluence: several independent conditions on one name compound
    const byCoin = {};
    for (const g of kept) (byCoin[g.coin] || (byCoin[g.coin] = [])).push(g);
    // Earned confluence: the bonus starts at the default 8/condition, but once the ledger has
    // >=15 resolutions on each side it scales to the MEASURED hit-rate lift of with-company
    // firings over solo ones — and drops to zero if agreement doesn't prove out.
    const confUnit = confCache && confCache.bonus != null ? confCache.bonus : 8;
    for (const c in byCoin) {
      const { conflict, companyFor } = confSplit(byCoin[c]);
      for (const g of byCoin[c]) {
        const k = companyFor(g);   // direction-aware: only same-side + context signals are company
        const e = ledgerOpen.get(g.coin + "|" + g.ev);
        if (e && e.conf == null) { e.conf = k > 1; ledgerDirty = true; }   // stamped once, at first observation
        if (conflict) {
          g.confl = true;   // long AND short fired on this coin — flagged, no bonus for anyone
          const gs = g.play && (g.play.side === "long" || g.play.side === "short") ? g.play.side : null;
          // Name the counterpart(s): the opposing signal can rank below the visible list or be
          // filtered out client-side — the chip must cite what it is conflicting with, or it
          // reads as a phantom.
          g.conflWith = byCoin[c]
            .filter((o) => o !== g && o.play && (o.play.side === "long" || o.play.side === "short") && o.play.side !== gs)
            .map((o) => ({ label: EV_LABEL[o.ev] || o.ev, side: o.play.side, score: o.score }));
        }
        if (k > 1) { g.conf = k; g.score = Math.min(100, g.score + Math.min(16, confUnit * (k - 1))); }
      }
    }
    kept.sort((a, b) => b.score - a.score);
    // The PAYLOAD is capped at the top 40 by score; the COUNT is the true number of live
    // conditions. Serving top.length as the count pinned the tab badge at "40" forever the
    // moment the universe produced >=40 concurrent conditions — the badge must move with
    // reality, the payload cap is a transport decision. `shown` carries the cap for the client.
    const top = kept.slice(0, 40);
    const shadows = shadowRecord();
    const sig = kept.length + "|" + top.map((g) => g.coin + g.ev + g.score).join(",")
      + "|" + shadows.map((g) => g.rows.map((r) => r.n + ":" + r.open).join(".")).join(",");   // shadow record changes must bust the ETag too
    if (sig !== signalsSig) { signalsSig = sig; signalsVer = Date.now(); }
    for (const k of rearm) if (!firedNow.has(k)) rearm.delete(k);   // condition lapsed -> episode over, key re-armed
    const variants = Object.keys(VARIANTS).map((ev) => ({
      ev, param: VARIANTS[ev].param, unit: unitOf(ev), cur: incVal(ev),
      vals: VARIANTS[ev].vals.map((v, vi) => Object.assign({ v, inc: vi === variantState[ev].inc },
        (variantStats[ev] && variantStats[ev][vi]) || { n: 0, hit: null, avg: null })),
      hist: variantState[ev].hist.slice(-3),
    }));
    const rs0 = recordSets && recordSets["0"];
    // Earnings-conditioned split for the guarded events: resolved outcomes partitioned by the
    // eg stamp. Sample sizes will be thin for months — shipped with honest n and rendered only
    // past a floor; this is the accounting groundwork, not a claim of significance.
    const earnSplit = {};
    for (const ev of EARN_GUARD) {
      const eg = [], reg = [];
      for (const e of ledgerClosed) {
        if (e.ev !== ev || e.status !== "resolved" || !Number.isFinite(e.realized)) continue;
        (e.eg === 1 ? eg : reg).push(e.realized);
      }
      if (eg.length) earnSplit[ev] = { eg: summarizeEvents(eg), reg: reg.length ? summarizeEvents(reg) : null };
    }
    if (swingFails) log(`strategy shadows failed on ${swingFails} market(s) this build (isolated, board unaffected): ${swingErr}`);
    signalsCache = { ts: now, dataTs: signalsVer, count: kept.length, shown: top.length, signals: top,
      record: recordCache || {}, confluence: confCache || null, recordX: recordXCache,
      records: recordSets, variants, shadows, recent: rs0 ? rs0.recent : [], earnSplit };
    persistLedger();
  }

  // ---- session / time-of-day analytics (served at /api/analytics) ----
  // The hourly-price and funding spines live only in poller memory (60d x ~100 markets), so the math
  // runs here on a slow interval and the browser is handed one compact, pre-aggregated payload rather
  // than raw candles. Slice 1 establishes the data path + coverage/readiness; the seven studies
  // (session decomposition, hour/funding clocks, day-of-week grid, clustering, seasonality) populate
  // `sections` in later slices.
  function buildAnalytics() {
    const READY_HOURS = 20 * 24;   // "ready" = >= ~20 trading days of hourly candles for the session studies
    const universe = activeMarkets()
      .filter((r) => !r.delisted)
      .map((r) => {
        const cl = classifyCached(r.ticker);
        return {
          coin: r.coin, ticker: r.ticker, sector: cl.sector, assetClass: cl.assetClass,
          hours: Array.isArray(r.hourlyRaw) ? r.hourlyRaw.length : 0,
          funding: r.fundH ? r.fundH.size : 0,
        };
      });
    const hc = hourlyCoverage(), fc = fundingCoverage();
    const equityMarkets = universe.filter((u) => u.assetClass === "Equity").length;
    const ready = universe.filter((u) => u.hours >= READY_HOURS).length;
    const sig = `${universe.length}:${hc.coins}:${hc.candles}:${fc.coins}:${fc.points}:${fc.endpoint}:${ready}`;
    if (sig !== analyticsSig) { analyticsSig = sig; analyticsVer = Date.now(); }   // content changed -> new ETag
    analyticsCache = {
      ts: Date.now(),
      dataTs: analyticsVer,
      window: { hourlyDays: HOURLY_HISTORY_DAYS, fundingDays: FUNDING_HISTORY_DAYS },
      coverage: {
        hourly: hc, funding: fc,
        markets: universe.length, equityMarkets, ready, readyHours: READY_HOURS,
      },
      universe,
      sections: (() => {
        const hourClock = buildActivityClocks();
        return {
          sessionDecomp: buildSessionDecomp(),
          hourClock,
          dow: buildDowHeatmap(),
          clusters: buildClusters(hourClock),
          seasonality: buildSeasonality(),
        };
      })(),
    };
  }

  // Session decomposition (the flagship): for the equity class, run overnight (close->open),
  // weekend (Fri close->Mon open) and cash (open->close) holds on each name's hourly spine, then
  // pool them into one equal-weight bet per calendar boundary and compound gross vs net-of-funding
  // equity curves. Net is only as deep as the funding spine, so each curve carries a per-boundary
  // funding-known fraction and a horizon timestamp — the client renders net as approximate before it.
  const SESSION_MIN_SPINE = 3 * 24;    // a ticker needs >= 3 days of hourly candles to contribute
  const SESSION_MIN_EQUITIES = 5;      // don't publish the study until the class is broad enough
  function buildSessionDecomp() {
    const now = Date.now();
    const end = Math.floor(now / HOUR) * HOUR;
    const start = end - HOURLY_HISTORY_DAYS * DAY;
    const tol = 3 * HOUR;
    const eq = activeMarkets().filter((r) =>
      !r.delisted && classifyCached(r.ticker).assetClass === "Equity" &&
      Array.isArray(r.hourlyRaw) && r.hourlyRaw.length >= SESSION_MIN_SPINE);
    if (eq.length < SESSION_MIN_EQUITIES) return { pending: true, equityCount: eq.length, need: SESSION_MIN_EQUITIES };
    const anchors = {
      overnight: overnightAnchors(start, end),
      weekend: weekendAnchors(start, end),
      cash: cashAnchors(start, end),
    };
    const sessions = {};
    for (const s of ["overnight", "weekend", "cash"]) {
      const perTicker = [];
      for (const r of eq) perTicker.push(runHolds(getHourly(r.coin), getFunding(r.coin), anchors[s], tol));
      sessions[s] = sessionComposite(perTicker);
    }
    const ov = sessions.overnight;
    return {
      window: { start, end, days: HOURLY_HISTORY_DAYS },
      equityCount: eq.length,
      fundingEndpoint: fundingCoverage().endpoint,
      sessions,
      headline: {   // the "buy at close, sell before open" story lives in the overnight session
        medianGross: ov.medianGross, medianNet: ov.medianNet,
        meanGross: ov.meanGross, meanNet: ov.meanNet,
        totGross: ov.totGross, totNet: ov.totNet,
        winNet: ov.winNet, nights: ov.n, breadth: ov.breadth,
        fundingHorizonTs: ov.fundingHorizonTs,
      },
    };
  }

  // Hour-of-day activity + funding clocks (the robust timing layer). Per ticker we bin the hourly
  // spine into 24 ET hours (range volatility, volume, funding rate), normalize vol/volume to each
  // ticker's own average (so the *shape* is comparable and poolable), and keep funding raw (real
  // cash). We also pool equal-weight per asset class and overall for a sensible default view.
  const CLOCK_MIN_SPINE = 5 * 24;   // need >= ~5 days so each ET hour has several samples
  function _nanmean(a) { let s = 0, n = 0; for (const x of a) if (Number.isFinite(x)) { s += x; n++; } return n ? s / n : null; }
  function _normTo(a, m) { return a.map((x) => (Number.isFinite(x) && m) ? x / m : (Number.isFinite(x) ? x : null)); }
  function _round(a, dp) { const f = Math.pow(10, dp); return a.map((x) => Number.isFinite(x) ? Math.round(x * f) / f : null); }
  function _poolClocks(list) {
    const vr = new Array(24), qr = new Array(24), fund = new Array(24), n = new Array(24).fill(0);
    for (let h = 0; h < 24; h++) {
      let vs = 0, vc = 0, qs = 0, qc = 0, fs = 0, fc = 0;
      for (const c of list) {
        if (Number.isFinite(c.vr[h])) { vs += c.vr[h]; vc++; }
        if (Number.isFinite(c.qr[h])) { qs += c.qr[h]; qc++; }
        if (Number.isFinite(c.fund[h])) { fs += c.fund[h]; fc++; }
        n[h] += c.n[h] || 0;
      }
      vr[h] = vc ? vs / vc : null; qr[h] = qc ? qs / qc : null; fund[h] = fc ? fs / fc : null;
    }
    return { vr: _round(vr, 3), qr: _round(qr, 3), fund: _round(fund, 9), n, count: list.length };
  }
  function buildActivityClocks() {
    const mkts = activeMarkets().filter((r) =>
      !r.delisted && Array.isArray(r.hourlyRaw) && r.hourlyRaw.length >= CLOCK_MIN_SPINE);
    if (mkts.length < 3) return { pending: true, count: mkts.length };
    const tickers = [];
    for (const r of mkts) {
      const cl = classifyCached(r.ticker);
      const raw = activityClock(getHourly(r.coin), getFunding(r.coin));
      const vm = _nanmean(raw.vol), qm = _nanmean(raw.volume);
      tickers.push({
        coin: r.coin, ticker: r.ticker, sector: cl.sector, assetClass: cl.assetClass,
        vr: _round(_normTo(raw.vol, vm), 3),
        qr: _round(_normTo(raw.volume, qm), 3),
        fund: _round(raw.fund, 9),
        n: raw.n.map((x) => x || 0),
        volAbsMean: vm != null ? +vm.toFixed(6) : null,
      });
    }
    const byClass = {};
    for (const c of [...new Set(tickers.map((t) => t.assetClass))]) byClass[c] = _poolClocks(tickers.filter((t) => t.assetClass === c));
    return { hours: 24, tz: "ET", metricDefault: "vol", tickers, pooled: { all: _poolClocks(tickers), byClass } };
  }

  // Day-of-week x hour-of-day 7x24 heatmap (the weekend-gap / Friday->Monday story). Per-ticker grids
  // are normalized to each name's own grand-mean cell then pooled equal-weight per asset class + all —
  // shipped pooled only (per-ticker weekday-hour cells are too thin over 60d, and it keeps the payload
  // lean). Weekend cells sit near-empty for equities and alive for 24/7 crypto/FX, which is the point.
  function _nanmean2(g) { let s = 0, n = 0; for (const row of g) for (const x of row) if (Number.isFinite(x)) { s += x; n++; } return n ? s / n : null; }
  function _normGrid(g, m) { return g.map((row) => row.map((x) => (Number.isFinite(x) && m) ? x / m : (Number.isFinite(x) ? x : null))); }
  function _roundGrid(g, dp) { const f = Math.pow(10, dp); return g.map((row) => row.map((x) => Number.isFinite(x) ? Math.round(x * f) / f : null)); }
  function _poolGrids(list) {
    const vol = Array.from({ length: 7 }, () => new Array(24)), volume = Array.from({ length: 7 }, () => new Array(24)), n = Array.from({ length: 7 }, () => new Array(24).fill(0));
    for (let d = 0; d < 7; d++) for (let h = 0; h < 24; h++) {
      let vs = 0, vc = 0, qs = 0, qc = 0;
      for (const c of list) {
        const a = c.volN[d][h], b = c.volumeN[d][h];
        if (Number.isFinite(a)) { vs += a; vc++; }
        if (Number.isFinite(b)) { qs += b; qc++; }
        n[d][h] += c.n[d][h] || 0;
      }
      vol[d][h] = vc ? vs / vc : null; volume[d][h] = qc ? qs / qc : null;
    }
    return { vol: _roundGrid(vol, 3), volume: _roundGrid(volume, 3), n, count: list.length };
  }
  function buildDowHeatmap() {
    const mkts = activeMarkets().filter((r) =>
      !r.delisted && Array.isArray(r.hourlyRaw) && r.hourlyRaw.length >= CLOCK_MIN_SPINE);
    if (mkts.length < 3) return { pending: true, count: mkts.length };
    const per = [];
    for (const r of mkts) {
      const cl = classifyCached(r.ticker), g = dowClock(getHourly(r.coin));
      per.push({ assetClass: cl.assetClass, volN: _normGrid(g.vol, _nanmean2(g.vol)), volumeN: _normGrid(g.volume, _nanmean2(g.volume)), n: g.n });
    }
    const byClass = {};
    for (const c of [...new Set(per.map((p) => p.assetClass))]) byClass[c] = _poolGrids(per.filter((p) => p.assetClass === c));
    return { hours: 24, tz: "ET", metricDefault: "vol", pooled: { all: _poolGrids(per), byClass } };
  }

  // Cross-ticker clustering on the normalized 24h volatility profile (when each name is alive). We
  // PCA the profiles to 2D so the scatter shows whether markets separate by asset class (a taxonomy
  // sanity check), and flag "oddballs" — names whose activity shape matches a different class's
  // centroid better than their own (e.g. an equity perp unusually alive overnight = speculation-led).
  const CLUSTER_MIN = 8;
  function buildClusters(hourClock) {
    if (!hourClock || hourClock.pending || !Array.isArray(hourClock.tickers)) return { pending: true, count: hourClock ? (hourClock.count || 0) : 0 };
    const ts = hourClock.tickers.filter((t) => Array.isArray(t.vr) && t.vr.filter(Number.isFinite).length >= 18);
    if (ts.length < CLUSTER_MIN) return { pending: true, count: ts.length, need: CLUSTER_MIN };
    // impute missing hours with the ticker's mean so every profile is a full 24-vector
    const rows = ts.map((t) => {
      const m = t.vr.filter(Number.isFinite).reduce((s, x, _, a) => s + x / a.length, 0) || 1;
      return t.vr.map((x) => (Number.isFinite(x) ? x : m));
    });
    const { coords, varExplained } = pca2(rows);
    // class centroids (mean profile per asset class)
    const classes = [...new Set(ts.map((t) => t.assetClass))];
    const centroid = {};
    for (const c of classes) {
      const members = rows.filter((_, i) => ts[i].assetClass === c);
      const cen = new Array(24).fill(0);
      for (const r of members) for (let h = 0; h < 24; h++) cen[h] += r[h] / members.length;
      centroid[c] = { vec: cen, count: members.length };
    }
    const points = ts.map((t, i) => {
      let ownCorr = null, best = null, bestCorr = -2;
      for (const c of classes) {
        if (centroid[c].count < 2) continue;                 // need a real class to compare against
        const corr = pearson(rows[i], centroid[c].vec);
        if (!Number.isFinite(corr)) continue;
        if (c === t.assetClass) ownCorr = corr;
        if (corr > bestCorr) { bestCorr = corr; best = c; }
      }
      const odd = best != null && best !== t.assetClass && ownCorr != null && (bestCorr - ownCorr) > 0.15;
      return {
        coin: t.coin, ticker: t.ticker, assetClass: t.assetClass, sector: t.sector,
        x: +coords[i][0].toFixed(4), y: +coords[i][1].toFixed(4),
        ownCorr: ownCorr == null ? null : +ownCorr.toFixed(3),
        bestClass: best, bestCorr: bestCorr <= -2 ? null : +bestCorr.toFixed(3), odd,
      };
    });
    const oddballs = points.filter((p) => p.odd).sort((a, b) => (b.bestCorr - b.ownCorr) - (a.bestCorr - a.ownCorr));
    return { points, classes, oddballs, varExplained: varExplained.map((v) => +v.toFixed(3)), count: ts.length };
  }

  // Return seasonality by ET hour (EXPLORATORY / quarantined). Default is a cross-sectional t-test per
  // hour (ticker = one observation, avoiding candle pseudo-replication) so we only highlight hours that
  // clear |t| >= 2. The client can also drill into one sector (cross-sectional over its members) or one
  // ticker (a within-name time series, each day = one observation — noisier, labeled with extra caution).
  // Never a standalone trade signal — the payload is significance-flagged.
  const SEASON_MIN = 8;
  function crossHours(meansList) {
    const perHour = Array.from({ length: 24 }, () => []);
    for (const means of meansList) for (let h = 0; h < 24; h++) if (Number.isFinite(means[h])) perHour[h].push(means[h]);
    const hours = [];
    for (let h = 0; h < 24; h++) {
      const a = perHour[h], n = a.length;
      if (n < 3) { hours.push({ h, mean: null, se: null, t: null, n }); continue; }
      const mean = a.reduce((s, x) => s + x, 0) / n;
      let v = 0; for (const x of a) v += (x - mean) * (x - mean);
      const sd = Math.sqrt(v / (n - 1)), se = sd / Math.sqrt(n);
      hours.push({ h, mean: +mean.toFixed(6), se: +se.toFixed(6), t: se > 0 ? +(mean / se).toFixed(2) : 0, n });
    }
    return { hours, sigCount: hours.filter((x) => x.t != null && Math.abs(x.t) >= 2).length };
  }
  function buildSeasonality() {
    const eq = activeMarkets().filter((r) =>
      !r.delisted && classifyCached(r.ticker).assetClass === "Equity" &&
      Array.isArray(r.hourlyRaw) && r.hourlyRaw.length >= CLOCK_MIN_SPINE);
    if (eq.length < SEASON_MIN) return { pending: true, count: eq.length, need: SEASON_MIN };
    const byTicker = {}, universe = [], sectorMeans = {}, allMeans = [];
    for (const r of eq) {
      const st = hourReturnStats(getHourly(r.coin));            // within-name time series (each day = one obs)
      byTicker[r.coin] = { hours: st.hours, sigCount: st.sigCount };
      const means = st.hours.map((x) => x.mean);                 // one mean per hour -> cross-sectional input
      allMeans.push(means);
      const sec = classifyCached(r.ticker).sector || "Unclassified";
      (sectorMeans[sec] = sectorMeans[sec] || []).push(means);
      universe.push({ coin: r.coin, ticker: r.ticker, sector: sec });
    }
    const bySector = {};
    for (const sec in sectorMeans) {
      if (sectorMeans[sec].length >= 3) bySector[sec] = Object.assign(crossHours(sectorMeans[sec]), { n: sectorMeans[sec].length });
    }
    universe.sort((a, b) => (a.ticker < b.ticker ? -1 : 1));
    return { equityCount: eq.length, all: crossHours(allMeans), bySector, byTicker, universe };
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
      if (Array.isArray(m.ph) && m.ph.length) { const cut = Date.now() - 7 * DAY; r.premH = m.ph.filter((x) => Array.isArray(x) && x[0] >= cut); }
      r.isNew = false;
      n++;
    }
    return n;
  }
  // ---- earnings calendar (Finnhub) ------------------------------------------------------------
  // Eligibility = live xyz EQUITIES only. ETFs, indices, FX, commodities, thematics and the
  // pre-IPO synthetics never report earnings; foreign listings without a US symbol (SMSN, KIOXIA,
  // SOFTBANK, ...) are eligible but simply won't match the feed — absent, never guessed.
  function earnEligible() {
    const m = new Map();
    for (const r of rows.values()) {
      if (r.uni !== "xyz" || r.delisted) continue;
      if (classifyCached(r.ticker).assetClass !== "Equity") continue;
      const T = String(r.ticker).toUpperCase();
      m.set((EARN_ALIAS[T] || T), { coin: r.coin, ticker: r.ticker });
    }
    return m;
  }
  function rebuildEarnMap(entries) {
    earnMap.clear();
    for (const e of entries) {
      let a = earnMap.get(e.t);
      if (!a) { a = []; earnMap.set(e.t, a); }
      a.push(e);   // entries arrive date-sorted, so each list is nearest-first
    }
  }
  // Nearest UPCOMING report for a ticker: { diff, e } with diff in ET calendar days (0 = today,
  // 1 = tomorrow). Past entries linger in the cache until the next refresh; they're skipped here.
  function earnProx(ticker) {
    const a = earnMap.get(ticker);
    if (!a) return null;
    for (const e of a) {
      const d = earnDayDiff(e.d, Date.now());
      if (d != null && d >= 0) return { diff: d, e };
    }
    return null;
  }
  function hydrateEarnings() {
    const data = store.loadEarnings ? store.loadEarnings() : null;
    if (!data || !Array.isArray(data.entries)) return false;
    earnSig = data.entries.map((e) => e.t + e.d + e.s).join(",");
    earnVer = data.ts || Date.now();
    lastEarnOk = data.ts || 0;   // honest: staleness counts from the fetch that produced it
    earnPrints = Array.isArray(data.prints) ? data.prints : [];
    earnVoids = new Set(Array.isArray(data.voids) ? data.voids.filter((v) => typeof v === "string") : []);
    if (earnVoids.size) earnPrints = earnPrints.filter((p) => !earnVoids.has(p.t + "|" + p.d));
    earnHistDone = data.histDone2 === true;   // versioned: the truncated v1 backfill does not count
    refreshEarnStudy(false);
    // No eligibility filter here — the universe may not be reconciled yet at boot, and an empty
    // eligible set must not blank the reported window. The first real fetch re-derives filtered.
    earnCache = { ts: Date.now(), dataTs: earnVer, asOf: data.ts || null, windowDays: EARN_WINDOW_DAYS,
      source: "finnhub", error: null, entries: data.entries, recent: recentEarnPrints(earnPrints, Date.now()),
      eligible: data.eligible || 0,
      study: earnStudy, printsN: earnPrints.length, histDone: earnHistDone };
    rebuildEarnMap(data.entries);
    return true;
  }
  // Recompute the per-ticker reaction study from persisted prints against the CURRENT daily
  // spines. Cheap (a few dozen tickers x <=40 prints), so it reruns on every earnings tick and
  // once ~10 min after boot when the daily backfill has had time to land opens. Bumps the ETag
  // only when the stats actually changed.
  function refreshEarnStudy(bump) {
    const byTicker = new Map();
    for (const p of earnPrints) { let a = byTicker.get(p.t); if (!a) { a = []; byTicker.set(p.t, a); } a.push(p); }
    const next = {};
    for (const [tk, prints] of byTicker) {
      let row = null;
      for (const r of rows.values()) if (r.uni === "xyz" && !r.delisted && r.ticker === tk) { row = r; break; }
      if (!row || !Array.isArray(row.dailyRaw) || row.dailyRaw.length < 3) continue;
      const st = earnReactionsFor(prints, row.dailyRaw);
      if (st) next[tk] = st;
    }
    const sigS = JSON.stringify(next);
    const changed = sigS !== JSON.stringify(earnStudy);
    earnStudy = next;
    if (changed && bump && earnCache) {
      earnVer = Date.now();
      earnCache = Object.assign({}, earnCache, { dataTs: earnVer, study: earnStudy, printsN: earnPrints.length });
    }
    return changed;
  }
  // Operator surgery for feed-garbage prints: removes ticker|date from the print history and
  // the reaction study, rebuilds the payload immediately (ETag bumped), and TOMBSTONES the key
  // so no future fetch — live window or backfill — can resurrect it. For phantoms the automatic
  // rules cannot reach: a feed that keeps asserting a report that never happened, with no
  // corrected row anywhere for reconciliation or the reschedule purge to fire on.
  function voidEarnPrint(ticker, dateStr) {
    const t = String(ticker || "").trim(), d = String(dateStr || "").trim();
    if (!t || !/^\d{4}-\d{2}-\d{2}$/.test(d)) return { ok: false, error: "need t (ticker) and d (YYYY-MM-DD)" };
    const k = t + "|" + d;
    const before = earnPrints.length;
    earnVoids.add(k);
    earnPrints = earnPrints.filter((p) => p.t + "|" + p.d !== k);
    const removed = before - earnPrints.length;
    refreshEarnStudy(false);
    if (earnCache) {
      earnVer = Date.now();
      const entries = (earnCache.entries || []).filter((e) => e.t + "|" + e.d !== k);
      earnCache = Object.assign({}, earnCache, { dataTs: earnVer, entries,
        recent: recentEarnPrints(earnPrints, Date.now()), study: earnStudy, printsN: earnPrints.length });
      rebuildEarnMap(entries);
    }
    if (store.saveEarnings) store.saveEarnings({ ts: lastEarnOk || Date.now(),
      entries: (earnCache && earnCache.entries) || [], eligible: (earnCache && earnCache.eligible) || 0,
      prints: earnPrints, histDone2: earnHistDone, voids: [...earnVoids] });
    log(`Earnings print VOIDED by operator: ${k} (${removed} history record(s) removed, tombstoned against feed re-assertion)`);
    return { ok: true, removed, tombstoned: k, printsN: earnPrints.length };
  }
  async function fetchEarnings() {
    const token = process.env.FINNHUB_TOKEN || "";
    const now = Date.now();
    if (!token) {
      // No token, no feed — say so once in the payload instead of silently serving nothing.
      if (!earnCache) earnCache = { ts: now, dataTs: 0, asOf: null, windowDays: EARN_WINDOW_DAYS,
        source: "finnhub", error: "FINNHUB_TOKEN not set", entries: [], recent: [], eligible: earnEligible().size };
      return;
    }
    const elig = earnEligible();
    if (!elig.size) return;   // universe not reconciled yet — the next tick will have it
    // Window reaches 5 days BACK so a print stays available while its actual lands (the feed
    // fills epsActual/revenueActual on the same calendar row after the report) and then
    // graduates into the persisted print history.
    const getCal = async (f, t) => {
      const res = await fetch(`https://finnhub.io/api/v1/calendar/earnings?from=${f}&to=${t}&token=${encodeURIComponent(token)}`,
        { headers: { accept: "application/json" }, signal: AbortSignal.timeout(20000) });
      if (!res.ok) throw new Error("HTTP " + res.status);
      return parseEarningsCalendar(await res.json(), elig);
    };
    // The free-tier calendar TRUNCATES long windows, serving the FAR end first — a 19-day
    // earnings-season pull returned only its last 9 days and silently dropped a same-day NFLX
    // report (observed 2026-07-16, confirmed by a single-day pull that returned the row with
    // actuals). Every pull therefore walks small disjoint date chunks, near dates first, paced
    // under the 60/min budget, deduped by ticker+date preferring the record with the actual.
    // Any chunk failing fails the whole pull — a PARTIAL window must never masquerade as the
    // feed's complete view (the purge below treats the window as authoritative for reschedules).
    const getCalChunked = async (fromMs, toMs, chunkDays, paceMs) => {
      const seen = new Map();
      for (const [f, t] of earnChunks(fromMs, toMs, chunkDays)) {
        const rows = await getCal(f, t);
        for (const e of rows) {
          const k = e.t + "|" + e.d, old = seen.get(k);
          if (!old || (e.epsA != null && old.epsA == null)) seen.set(k, e);
        }
        await sleep(paceMs);
      }
      const out = [...seen.values()];
      out.sort((a, b) => a.d < b.d ? -1 : a.d > b.d ? 1 : (a.t < b.t ? -1 : a.t > b.t ? 1 : 0));
      return out;
    };
    try {
      let parsed = await getCalChunked(now - 5 * DAY, now + EARN_WINDOW_DAYS * DAY, 3, 200);
      // Operator tombstones apply at the mouth of the pipe: a voided print never re-enters
      // entries, the reported window, or the print history, no matter what the feed asserts.
      if (earnVoids.size) parsed = parsed.filter((e) => !earnVoids.has(e.t + "|" + e.d));
      // One-time historical backfill for the reaction study — chunked for the same reason (the
      // original single ~1y pull was truncated to a sliver, which is why the study sat at "no
      // history" across the board). Flag is VERSIONED (histDone2): volumes that completed the
      // truncated v1 backfill re-run it chunked once; the print merge dedupes and upgrades in
      // place, so re-pulling is idempotent. Flagged done only on full chunk success.
      if (!earnHistDone) {
        try {
          const hist = await getCalChunked(now - 370 * DAY, now - 6 * DAY, 7, 300);
          earnPrints = mergeEarnPrints(earnPrints, hist, now);
          earnHistDone = true;
          log(`Earnings history backfill (chunked): ${hist.length} past print(s) retrieved (feed depth is whatever the free tier serves — study self-accrues from here)`);
        } catch (he) { log("Earnings history backfill failed (will retry): " + (he && he.message)); }
      }
      const entries = [], past = [];
      for (const e of parsed) ((earnDayDiff(e.d, now) >= 0) ? entries : past).push(e);
      // Stale-print hygiene BEFORE merge, two independent rules against the fetched window
      // (complete by construction — any chunk failure aborts the whole parse):
      // 1) back-window existence: a print in the refetched [now-5d, now-1d] range the feed no
      //    longer lists was retracted upstream (the IBM phantom with NO corrected row anywhere);
      // 2) reschedule: a past print whose ticker is still scheduled AHEAD for the same fiscal
      //    print is a placeholder-date phantom.
      earnPrints = reconcileEarnPrints(earnPrints, parsed, now);
      earnPrints = purgeStalePrints(earnPrints, parsed, now);
      // Today's reported rows stay in `entries` (diff 0) with actuals; anything older folds
      // into the print history. Upcoming entries with a schedule change simply re-ship.
      earnPrints = mergeEarnPrints(earnPrints, past.concat(entries.filter((e) => e.epsA != null)), now);
      if (earnVoids.size) earnPrints = earnPrints.filter((p) => !earnVoids.has(p.t + "|" + p.d));   // choke point: covers the backfill merge too
      lastEarnOk = now; earnErr = null;
      refreshEarnStudy(false);
      // Recently-reported window (past 2 ET days): derived from the persisted print history, not
      // the raw fetch — so it survives restarts for free and a late-landing actual upgrades the
      // row in place. Filtered to the CURRENT eligible universe so a delisted name can't linger.
      const eligT = new Set(); for (const v of elig.values()) eligT.add(v.ticker);
      const recent = recentEarnPrints(earnPrints, now).filter((p) => eligT.has(p.t));
      // The signature covers recent rows AND their actuals: a print rolling past midnight into
      // the reported window, or an actual filling in later, must bump the ETag or the client
      // revalidates to a 304 and never repaints the scoreboard.
      const sigE = entries.map((e) => e.t + e.d + e.s + (e.epsA != null ? "a" : "")).join(",")
        + "|" + recent.map((p) => p.t + p.d + (p.epsA != null ? "a" : "")).join(",")
        + "|" + JSON.stringify(earnStudy).length;
      if (sigE !== earnSig) { earnSig = sigE; earnVer = now; }
      earnCache = { ts: now, dataTs: earnVer, asOf: now, windowDays: EARN_WINDOW_DAYS,
        source: "finnhub", error: null, entries, recent, eligible: elig.size,
        study: earnStudy, printsN: earnPrints.length, histDone: earnHistDone };
      rebuildEarnMap(entries);
      if (store.saveEarnings) store.saveEarnings({ ts: now, entries, eligible: elig.size, prints: earnPrints, histDone2: earnHistDone, voids: [...earnVoids] });
      log(`Earnings calendar: ${entries.length} report(s) across ${new Set(entries.map((e) => e.t)).size} ticker(s) in the next ${EARN_WINDOW_DAYS}d, ${recent.length} reported in the past 2d (${elig.size} eligible equities; ${earnPrints.length} print(s) in history, study covers ${Object.keys(earnStudy).length})`);
    } catch (e) {
      // Failure keeps the last good entries and stamps the error — the tab shows the cache age
      // in amber instead of pretending freshness or blanking a working list.
      earnErr = (e && e.message) || "fetch failed";
      earnCache = Object.assign({ windowDays: EARN_WINDOW_DAYS, source: "finnhub", entries: [], recent: [], eligible: elig.size, asOf: null, dataTs: 0 },
        earnCache || {}, { ts: now, error: earnErr });
      log("Earnings fetch failed: " + earnErr);
    }
  }
  const earnTick = () => { fetchEarnings().catch((e) => log("earnings tick failed: " + (e && e.message))); };

  function persistFeatures() {
    const markets = {};
    for (const r of rows.values()) {
      if (r.delisted || (!r.feat && !r.dailyRaw)) continue;
      const ph = r.premH && r.premH.length
        ? (r.premH.length > 350 ? r.premH.filter((_, i) => i % Math.ceil(r.premH.length / 350) === 0) : r.premH)
        : null;
      markets[r.coin] = {
        ref: r.ref || null, feat: r.feat || null,
        hourlyTs: r.hourlyTs || 0, dailyTs: r.dailyTs || 0,
        daily: r.dailyRaw ? r.dailyRaw.map((k) => [k.t, k.c]) : null,
        ph,   // downsampled 7d premium baseline, so redeploys keep the dislocation z-scores warm
      };
    }
    store.saveFeatures({ ts: Date.now(), markets });
  }

  // Persist the raw 60d hourly spine so the session analytics survive redeploys instead of blanking
  // while the workers re-fetch. Candles are stored as compact [t,o,h,l,c,v] arrays (the six fields
  // getHourly reads); the current in-memory spine is already <= 60d, so no pruning is needed here.
  function persistHourly() {
    const hourly = {};
    for (const r of rows.values()) {
      if (r.delisted || !Array.isArray(r.hourlyRaw) || !r.hourlyRaw.length) continue;
      hourly[r.coin] = r.hourlyRaw.map((k) => [+k.t, +k.o, +k.h, +k.l, +k.c, +k.v]);
    }
    store.saveHourly({ ts: Date.now(), hourly });
  }
  function hydrateHourly() {
    const data = store.loadHourly();
    if (!data || !data.hourly) return 0;
    const cut = Date.now() - HOURLY_HISTORY_DAYS * DAY;
    let n = 0;
    for (const coin in data.hourly) {
      const arr = data.hourly[coin];
      if (!Array.isArray(arr) || !arr.length) continue;
      const out = [];
      for (const a of arr) if (Array.isArray(a) && a.length >= 6 && Number.isFinite(a[0]) && a[0] >= cut) out.push({ t: a[0], o: a[1], h: a[2], l: a[3], c: a[4], v: a[5] });
      if (!out.length) continue;
      getRow(coin).hourlyRaw = out;
      n++;
    }
    return n;
  }

  async function maintenance() {
    try {
      const isMain = (coin) => !coin.includes(":");
      const n = await store.prune(Date.now() - OI_RETENTION, Date.now() - OI_FULL_RES, isMain, Date.now() - MAIN_HIST_DAYS * DAY);
      if (n) log(`OI retention pass: ${n} sample(s) dropped/thinned (xyz: full 31d + hourly to 365d; crypto: flat 31d)`);
      // mirror the same shape in memory so the hist arrays track the on-disk store
      { const full = Date.now() - OI_FULL_RES, mainCut = Date.now() - MAIN_HIST_DAYS * DAY;
        for (const [coin, arr] of hist) {
          if (!arr.length) continue;
          if (isMain(coin)) {   // crypto: flat 31d, full resolution, nothing older
            if (arr[0][0] < mainCut) { const i = arr.findIndex((k) => k[0] >= mainCut); hist.set(coin, i > 0 ? arr.slice(i) : (i === 0 ? arr : [])); }
            continue;
          }
          if (arr[0][0] >= full) continue;
          const out = []; let lastHb = -1;
          for (const k of arr) {
            if (k[0] >= full) { out.push(k); continue; }
            const hb = Math.floor(k[0] / HOUR);
            if (hb !== lastHb) { out.push(k); lastHb = hb; }
          }
          if (out.length !== arr.length) hist.set(coin, out);
        } }
    } catch (e) { log("prune failed: " + (e && e.message)); }
    // Heavy-data GC for markets delisted > 7d. They stay in Hyperliquid's meta forever (so the
    // row itself must survive to keep the universe index-aligned for the WS feed), but there's
    // no reason to keep holding their 60d hourly spine, funding map and OI history in memory.
    const dcut = Date.now() - 7 * DAY;
    let swept = 0;
    for (const [coin, r] of rows) {
      if (!r.delisted || !r.delistedAt || r.delistedAt >= dcut) continue;
      if (r.hourlyRaw || r.dailyRaw || (r.fundH && r.fundH.size) || hist.has(coin)) {
        r.hourlyRaw = null; r.dailyRaw = null; r.ref = null; r.feat = null;
        if (r.fundH) r.fundH.clear();
        hist.delete(coin);
        swept++;
      }
    }
    if (swept) log(`Freed cached history for ${swept} market(s) delisted > 7d`);
    const total = activeMarkets().filter((r) => !r.delisted).length;
    const pending = activeMarkets().filter((r) => !r.delisted && !r.dailyRaw).length;
    const hc = hourlyCoverage();
    const fcut = Date.now() - FUNDING_HISTORY_DAYS * DAY;
    for (const r of rows.values()) if (r.fundH && r.fundH.size) for (const t of r.fundH.keys()) if (t < fcut) r.fundH.delete(t);
    const fc = fundingCoverage();
    log(`Daily audit: ${total} active market(s), ${pending} awaiting history backfill; hourly spine: ${hc.coins} market(s), ${hc.candles} candle(s); funding[${fc.endpoint}]: ${fc.coins} market(s), ${fc.points} hour(s)`);
  }

  async function start() {
    const restored = hydrateFeatures();
    if (restored) log(`Restored cached features for ${restored} market(s) — serving warm`);
    hydrateLedger();
    log(`Restored signal ledger: ${ledgerOpen.size} open, ${ledgerClosed.length} resolved — track record carries across this deploy`);
    const restoredHourly = hydrateHourly();
    if (restoredHourly) log(`Restored hourly spine for ${restoredHourly} market(s) — session analytics warm`);
    if (hydrateEarnings()) log(`Restored earnings calendar: ${earnCache.entries.length} report(s) — badges warm while Finnhub refreshes`);
    log(`AI reports: ${AI_KEY() ? "ENABLED" : "disabled (no ANTHROPIC_API_KEY / OPENAI_API_KEY)"} — provider ${AI_PROVIDER}, model ${AI_MODEL} (fallback ${AI_MODEL_FALLBACK}), TTL ${Math.round(AI_TTL_MS / 60000)} min, ${aiReports.size} cached report(s) restored`);
    await pollUniverse();
    seedFundingFromOI();
    buildSnapshot(); buildDaily(); buildAnalytics();
    // WebSocket accelerator: real-time price/funding/OI pushes at zero rate-limit weight.
    // While it's healthy the REST universe poll drops to every 5th tick (~150s) — it still
    // owns membership (names / new listings / delistings) and instantly resumes the full
    // 30s cadence the moment the socket goes quiet.
    sock = createUniverseSocket({ onCtxs: applyWsCtxs, log });
    setInterval(() => {
      universeTick++;
      if (sock && sock.enabled && sock.healthy() && universeTick % 5 !== 0) return;
      pollUniverse().catch(() => {});
    }, UNIVERSE_MS);
    hourlyWorker(); hourlyWorker();
    dailyWorker(); dailyWorker();
    fundingWorker();
    setInterval(buildSnapshot, 15 * 1000);
    setInterval(buildDaily, 60 * 1000);
    const safeTick = (fn, name) => () => { try { fn(); } catch (e) { log(name + " failed (isolated, server stays up): " + (e && e.message)); } };
    setInterval(safeTick(buildSignals, "buildSignals"), 10 * 60 * 1000);
    setTimeout(safeTick(buildSignals, "buildSignals"), 2 * 60 * 1000);   // first pass once early backfill has something to chew on
    // Off-site ledger backup: shortly after boot (the deploy IS the natural trigger — most
    // boots follow a build), then weekly. The blob-sha skip makes redundant runs free.
    if (BK_REPO && BK_TOKEN) {
      const bkTick = () => backupLedger().then((r) =>
        log(r.ok ? `Ledger backup: pushed ${r.pushed}, skipped ${r.skipped} (unchanged) -> ${BK_REPO}` : `Ledger backup failed (retries next cycle): ${r.error || "disabled"}`))
        .catch((e) => log("Ledger backup failed (isolated): " + (e && e.message)));
      setTimeout(bkTick, 10 * 60 * 1000);
      setInterval(bkTick, BK_MS);
      log(`Ledger backup: ENABLED -> ${BK_REPO}@${BK_BRANCH}, weekly + post-boot`);
    } else {
      log("Ledger backup: disabled (set LEDGER_BACKUP_REPO + GITHUB_TOKEN to enable off-site snapshots)");
    }
    setInterval(safeTick(buildAnalytics, "buildAnalytics"), ANALYTICS_MS);
    setInterval(() => store.flush(), 30 * 1000);
    setInterval(persistFeatures, 120 * 1000);
    setInterval(persistHourly, HOURLY_PERSIST_MS);
    setTimeout(persistHourly, 90 * 1000);   // early snapshot so even a quick redeploy keeps the spine warm
    setInterval(maintenance, 24 * 3600 * 1000);
    setTimeout(maintenance, 60 * 1000);
    // Earnings: first pull shortly after the universe reconciles; then one staleness check every
    // 30 min re-fires only when the last GOOD fetch is > 6h old — so a failed pull retries in
    // 30 min while a healthy one refreshes 4x/day. One HTTP GET each time; zero HL rate budget.
    setTimeout(earnTick, 20 * 1000);
    setInterval(() => { if (Date.now() - lastEarnOk > EARN_STALE) earnTick(); }, EARN_RETRY_MS);
    // Reaction study rerun after the daily backfill has had time to land full candles (opens
    // arrive with the live pull; the warm cache only carries closes) — bumps the ETag on change.
    setTimeout(() => { try { refreshEarnStudy(true); } catch (_) {} }, 10 * 60 * 1000);
  }

  // Per-market hourly OHLCV for the drawer candle chart: [[t,o,h,l,c,v], ...] over the last
  // `days` (default 14, capped at the retained spine). Values quantized like the snapshot.
  function getCandles(coin, days) {
    const d = Math.max(1, Math.min(HOURLY_HISTORY_DAYS, Number(days) || 14));
    const cut = Date.now() - d * DAY, out = [];
    for (const k of getHourly(coin)) {
      if (k[0] < cut) continue;
      out.push([k[0], sig(k[1], 9), sig(k[2], 9), sig(k[3], 9), sig(k[4], 9), rnd(k[5], 2)]);
    }
    return out;
  }

  // Ladder-timeframe candles for the Trend-tab chart modal (tf = 1h | 4h | 12h | 1d): EXACTLY
  // the series buildTrend feeds trendLadder for that rung — H1 is the spine's last 96 bars,
  // H4/H12 are UTC-aligned bucketCandles aggregations of the full spine, D1 is the daily series
  // through the withFormingDaily staleness guard. Same inputs means a client EMA walk over this
  // payload reproduces the ladder's EMAs bit-for-bit — the chart CANNOT disagree with the board
  // by construction (the modal's badges/read come from /api/trend either way; this guarantees
  // the plotted ribbon lands where those badges claim it is). Bars are [t,o,h,l,c]; o/h/l ride
  // through as null when the source bar carries closes only (warm-cache dailies, the synthetic
  // forming daily bar) — the client draws an honest close tick, never a fabricated flat candle.
  // `px` ships alongside so the client applies the SAME live-mark-drives-the-forming-bar
  // substitution trendLadder does before walking its EMAs.
  const TF_CANDLES = { "1h": 1, "4h": 4, "12h": 12, "1d": 0 };   // 0 = daily series, not a bucket width
  function getTfCandles(coin, tf) {
    const key = String(tf || "").toLowerCase();
    if (!(key in TF_CANDLES)) return null;
    const r = rows.get(coin);
    if (!r) return { coin, tf: key, px: null, minBars: 26, candles: [] };
    const q = (k) => [+k.t,
      k.o != null && isFinite(+k.o) ? sig(+k.o, 9) : null,
      k.h != null && isFinite(+k.h) ? sig(+k.h, 9) : null,
      k.l != null && isFinite(+k.l) ? sig(+k.l, 9) : null,
      sig(+k.c, 9)];
    let src = [];
    if (key === "1d") {
      const d1 = Array.isArray(r.dailyRaw) ? r.dailyRaw : [];
      src = withFormingDaily(d1, r.px, Date.now(), DAY) || [];
      // OHLC upgrade: warm-cache restores carry closes only, which renders as a bare close line.
      // The retained hourly spine holds the TRUE open/high/low of every recent day — aggregate it
      // (UTC-aligned, same bucketing the H12/H4 rungs use) and substitute into closes-only bars.
      // The official close is kept (it's what the ladder's EMAs walked — the chart may never
      // disagree with the board), with h/l clamped to include it. Real data, not a fallback.
      if (Array.isArray(r.hourlyRaw) && r.hourlyRaw.length > 24 && src.some((k) => k.o == null)) {
        const byDay = new Map();
        for (const b of bucketCandles(r.hourlyRaw, 24, HOUR))
          if (b && isFinite(+b.t) && b.o != null && isFinite(+b.o)) byDay.set(Math.floor(+b.t / DAY), b);
        src = src.map((k) => {
          if (k.o != null || !isFinite(+k.c)) return k;
          const d = byDay.get(Math.floor(+k.t / DAY));
          if (!d) return k;
          const c = +k.c;
          return { t: k.t, o: +d.o, h: Math.max(+d.h, c), l: Math.min(+d.l, c), c };
        });
      }
    } else if (key === "1h") {
      src = Array.isArray(r.hourlyRaw) ? r.hourlyRaw.slice(-96) : [];
    } else {
      src = Array.isArray(r.hourlyRaw) ? bucketCandles(r.hourlyRaw, TF_CANDLES[key], HOUR) : [];
    }
    const out = [];
    for (const k of src) { if (isFinite(+k.t) && isFinite(+k.c)) out.push(q(k)); }
    return { coin, tf: key, px: r.px != null && isFinite(+r.px) ? sig(+r.px, 9) : null, minBars: 26, candles: out };
  }

  // ---- trend leaderboard (served at /api/trend) ----
  // EMA 13/21 ribbon ladder across D1 · H12 · H4 · H1 for every live market, ranked into long and
  // short boards per universe. Assembly only — all math is in compute.js (unit-tested there).
  // Timeframe sourcing: H1 = the hourly spine as-is; H4/H12 = UTC-aligned aggregation of that
  // spine; D1 = the daily candle series (closes-only warm-cache shape degrades gracefully — the
  // zone probe falls back to closes, EMAs are unaffected). The forming bar's close is replaced by
  // the live mark inside trendLadder, so the board moves with price between candle refreshes.
  // A market missing ANY rung (new listing, shallow spine) is excluded and counted, never guessed.
  const TREND_MS = 3 * 60 * 1000;     // memo window — inputs only change on ~10-min candle refreshes anyway
  const TREND_TOP = 10;               // rows per universe per side, like the source board
  function buildTrend() {
    const now = Date.now();
    const sides = { long: { crypto: [], stocks: [] }, short: { crypto: [], stocks: [] } };
    let scanned = 0, excluded = 0;
    for (const r of rows.values()) {
      if (r.delisted) continue;
      if (r.px == null || !Array.isArray(r.hourlyRaw) || r.hourlyRaw.length < 26) { excluded++; continue; }
      const d1 = Array.isArray(r.dailyRaw) ? r.dailyRaw : null;
      if (!d1 || d1.length < 26) { excluded++; continue; }
      const d1g = withFormingDaily(d1, r.px, now, DAY);
      const lad = trendLadder(r.px, {
        D1: d1g,
        H12: bucketCandles(r.hourlyRaw, 12, HOUR),
        H4: bucketCandles(r.hourlyRaw, 4, HOUR),
        H1: r.hourlyRaw.slice(-96),
      });
      if (!lad) { excluded++; continue; }
      scanned++;
      const uni = r.uni === "main" ? "crypto" : "stocks";
      for (const side of ["long", "short"]) {
        const read = trendRead(side, lad);
        if (!read) continue;   // score < 2 — not board material on this side
        const s = lad[side];
        // e13/e21 ride along for the chart modal's retest-zone band — the band is the ladder's
        // OWN values, never a client recompute (deliberately NOT in the content signature: like
        // d21 they drift with price, and the modal's badges key off st/retest/read which are).
        const tf = {};
        for (const t of TREND_TFS) tf[t] = { st: lad.tf[t].st, d21: lad.tf[t].d21, e13: sig(lad.tf[t].e13, 9), e21: sig(lad.tf[t].e21, 9) };
        // Trend age: only meaningful when the D1 rung itself is aligned with this side — a 2/4
        // carried by lower rungs has no D1 trend to age. Days, exact per-bar EMA walk; capped
        // means the stack extends past available history ("at least", most relevant for crypto's
        // 31d retention where the ceiling is ~11 measurable bars).
        let age = null, ageCap = false;
        if (lad.tf.D1.st === (side === "long" ? "up" : "down")) {
          const sr = stackedRun(d1g, r.px, side);
          if (sr) { age = sr.run; ageCap = sr.capped; }
        }
        sides[side][uni].push({ coin: r.coin, t: r.ticker, score: s.score, tf, read: read.text,
          retest: read.retest, strength: +s.strength.toFixed(5), width: ribbonWidth(s), age, ageCap, vol: r.vol || 0 });
      }
    }
    for (const side of ["long", "short"]) for (const uni of ["crypto", "stocks"]) {
      // Rank: score first, then FRESH-FIRST within it — a day-3 stack outranks a day-40 runner at
      // the same score (the young trend is the entry; the old one is the chase). Ageless rows
      // (D1 not aligned) sort after aged ones; volume settles the rest.
      sides[side][uni].sort((a, b) => (b.score - a.score)
        || ((a.age == null ? Infinity : a.age) - (b.age == null ? Infinity : b.age))
        || (b.vol - a.vol));
      sides[side][uni] = sides[side][uni].slice(0, TREND_TOP).map(({ vol, ...e }) => e);
      // Retest volume read (rrv) — computed only for the rows that actually shipped (<= TREND_TOP
      // per board), so the extra work stays bounded regardless of universe size. The window is ONE
      // bar of the retesting timeframe, clock-hour matched against the same span on prior days
      // (rvolMulti, same construction as the Markets-table RVOL): ~1x or less = the pullback into
      // the zone is quiet (healthy continuation character), >=2x = heavy tape INTO the zone — the
      // level is being fought, not respected. Null when the volume baseline can't qualify — an
      // honest dash, mirroring every other RVOL surface. Deliberately NOT in the content
      // signature: like d21, it drifts with every completed hour, and versioning it would defeat
      // the ETag; it is fresh at retest onset because `retest` itself IS in the signature.
      for (const e of sides[side][uni]) {
        if (!e.retest) continue;
        try {
          const W = TREND_TF_MS[e.retest];
          const rv = W ? rvolMulti(getHourly(e.coin), { w: W }, now) : null;
          e.rrv = rv && rv.w != null ? rv.w : null;
        } catch (_) { e.rrv = null; }
        // Prior-swing level for the retest: the target the read alludes to ("prior swing high"),
        // computed from the SAME series builders the ladder consumed for that rung, for shipped
        // retest rows only (bounded work, like rrv). Long: the highest high (close when the bar
        // is closes-only) of the ~30 bars before the probe window; short: the lowest low. Null
        // when the lookback is too thin or the level sits on the wrong side of the mark — an
        // honest dash, never a fabricated target. Feeds the chart modal's target line and the
        // tretest ledger claim's frozen target; NOT in the content signature (fires with retest,
        // which is).
        e.swing = null;
        try {
          const rr = rows.get(e.coin);
          if (rr) {
            let ser = null;
            if (e.retest === "D1") ser = withFormingDaily(Array.isArray(rr.dailyRaw) ? rr.dailyRaw : [], rr.px, now, DAY);
            else if (e.retest === "H1") ser = Array.isArray(rr.hourlyRaw) ? rr.hourlyRaw.slice(-96) : null;
            else ser = Array.isArray(rr.hourlyRaw) ? bucketCandles(rr.hourlyRaw, e.retest === "H12" ? 12 : 4, HOUR) : null;
            if (ser && ser.length >= 13) {
              const win = ser.slice(Math.max(0, ser.length - 33), ser.length - 3);
              if (win.length >= 10 && rr.px > 0) {
                let lvl = null;
                for (const k of win) {
                  const v = side === "long"
                    ? (k.h != null && isFinite(+k.h) ? +k.h : +k.c)
                    : (k.l != null && isFinite(+k.l) ? +k.l : +k.c);
                  if (!isFinite(v)) continue;
                  lvl = lvl == null ? v : (side === "long" ? Math.max(lvl, v) : Math.min(lvl, v));
                }
                // target must sit on the PROFIT side of the mark, else it isn't a target
                if (lvl != null && (side === "long" ? lvl > rr.px * 1.001 : lvl < rr.px * 0.999)) e.swing = sig(lvl, 9);
              }
            }
          }
        } catch (_) { e.swing = null; }
      }
    }
    const sigTrend = JSON.stringify([["long", "short"].map((s) => ["crypto", "stocks"].map((u) =>
      sides[s][u].map((e) => [e.coin, e.score, e.retest, e.read, e.age])))]);
    if (sigTrend !== trendSig) { trendSig = sigTrend; trendVer = Date.now(); }
    trendBuilt = now;
    trendCache = { ts: now, dataTs: trendVer,
      params: { ema: [13, 21], tfs: TREND_TFS, retestBars: 3, top: TREND_TOP },
      coverage: { included: scanned, excluded },
      long: sides.long, short: sides.short };
  }
  function getTrend() {
    if (!trendCache || Date.now() - trendBuilt > TREND_MS) {
      try { buildTrend(); } catch (e) { log("buildTrend error: " + (e && e.message)); }
    }
    return trendCache;
  }
  // D1 alignment at claim open, read off the trend board already in memory. null = unknown
  // (not board material, or no board yet) — never guessed.
  function trendAlignAtFire(coin, side) {
    const tc = trendCache;
    if (!tc || !tc.long || !tc.short) return null;
    for (const s of ["long", "short"]) for (const uni of ["crypto", "stocks"]) {
      const list = (tc[s] && tc[s][uni]) || [];
      for (const e of list) if (e.coin === coin && e.tf && e.tf.D1) {
        const st = e.tf.D1.st;
        return ((side === "long" && st === "up") || (side === "short" && st === "down")) ? 1 : 0;
      }
    }
    return null;
  }

  // ===== AI analyst report (served at /api/ai-report) ============================================
  // One ticker, everything this server holds on it, compiled into a compact context object and
  // sent to the Anthropic API for a plain-language synthesis. Contract points, in order of
  // importance: (1) this is a SYNTHESIS layer, not a signal source — it reads the ledger and can
  // never write to it; (2) all arithmetic the card displays (R/R, EV, risk unit) is computed HERE
  // from the validated levels, never trusted from the model; (3) when a live claim exists, its
  // frozen stop IS the void level — a model that proposes a different one gets overwritten and
  // flagged; (4) coverage gaps and divergence flags are detector output passed TO the model as
  // facts — it narrates them, it cannot invent them; (5) generation is on-demand only and the
  // shared cache is the rate limit: the TTL cooldown is enforced server-side for everyone, and a
  // report invalidates early only on material change (new claim, claim resolved, earnings print).
  // Provider is auto-detected from whichever key is set (AI_PROVIDER overrides): Anthropic when
  // ANTHROPIC_API_KEY exists, else OpenAI when OPENAI_API_KEY exists. Per-provider defaults —
  // model, fallback, and the output-token budget (GPT-5.x bills its reasoning tokens against
  // max_completion_tokens, so the OpenAI budget is larger or reasoning can eat the whole
  // allowance and return an empty message). Switching providers is a Railway variable, not a code change.
  const AI_DEFAULTS = {
    anthropic: { model: "claude-fable-5", fb: "claude-opus-4-8", maxTokens: 3000 },
    openai: { model: "gpt-5.6-sol", fb: "gpt-5.6-terra", maxTokens: 8000 },
  };
  // ---- off-site ledger backup (weekly, GitHub contents API) --------------------------------
  // The volume is the only home of the track record; this pushes the raw persisted files
  // (ledger.json + ledger-archive.jsonl, byte-identical) to a private repo so a volume loss
  // can't erase the honesty loop. Disabled unless BOTH env vars are set; a failed push logs
  // and retries next cycle — it can never block or break anything else. Unchanged content is
  // detected via the git blob sha and skipped, so redeploy-driven runs don't spam commits.
  const BK_REPO = process.env.LEDGER_BACKUP_REPO || "";                     // "owner/repo"
  const BK_TOKEN = process.env.LEDGER_BACKUP_TOKEN || process.env.GITHUB_TOKEN || "";
  const BK_BRANCH = process.env.LEDGER_BACKUP_BRANCH || "main";
  const BK_MS = 7 * DAY;
  let backupLast = null, backupErr = null;
  const gitBlobSha = (content) =>
    require("crypto").createHash("sha1").update("blob " + Buffer.byteLength(content, "utf8") + "\0").update(content, "utf8").digest("hex");
  async function backupLedger(fetchImpl) {
    if (!BK_REPO || !BK_TOKEN) return { ok: false, disabled: true };
    const doFetch = fetchImpl || fetch;
    const hdrs = { authorization: "Bearer " + BK_TOKEN, accept: "application/vnd.github+json", "user-agent": "xyz-monitor" };
    try {
      const files = store.readBackupFiles ? store.readBackupFiles() : [];
      if (!files.length) return { ok: false, error: "nothing to back up (no persisted ledger yet)" };
      let pushed = 0, skipped = 0;
      for (const f of files) {
        const url = `https://api.github.com/repos/${BK_REPO}/contents/${f.name}`;
        const sha = gitBlobSha(f.content);
        let existing = null;
        const g = await doFetch(url + "?ref=" + encodeURIComponent(BK_BRANCH), { headers: hdrs });
        if (g && g.ok) { const j = await g.json(); if (j && j.sha) existing = j.sha; }
        if (existing === sha) { skipped++; continue; }   // byte-identical to what's already backed up
        const body = { message: `ledger backup ${new Date().toISOString().slice(0, 10)} (${version || "?"})`,
          content: Buffer.from(f.content, "utf8").toString("base64"), branch: BK_BRANCH };
        if (existing) body.sha = existing;
        const put = await doFetch(url, { method: "PUT", headers: hdrs, body: JSON.stringify(body) });
        if (!put || !put.ok) throw new Error(`PUT ${f.name} -> HTTP ${put ? put.status : "?"}`);
        pushed++;
      }
      backupLast = Date.now(); backupErr = null;
      return { ok: true, pushed, skipped, files: files.length };
    } catch (e) {
      backupErr = (e && e.message) || String(e);
      return { ok: false, error: backupErr };
    }
  }
  const AI_PROVIDER = (process.env.AI_PROVIDER
    || (process.env.ANTHROPIC_API_KEY ? "anthropic" : (process.env.OPENAI_API_KEY ? "openai" : "anthropic"))).toLowerCase();
  const AI_DEF = AI_DEFAULTS[AI_PROVIDER] || AI_DEFAULTS.anthropic;
  const AI_MODEL = process.env.AI_MODEL || AI_DEF.model;
  const AI_MODEL_FALLBACK = process.env.AI_MODEL_FALLBACK || AI_DEF.fb;
  const AI_KEY = () => AI_PROVIDER === "openai" ? (process.env.OPENAI_API_KEY || "") : (process.env.ANTHROPIC_API_KEY || "");
  const AI_TTL_MS = Math.max(5, Number(process.env.AI_REPORT_TTL_MIN) || 30) * 60 * 1000;
  // Bumped whenever the prompt/validator/schema changes shape: cached reports from an older
  // schema flip to "invalidated — report format updated" on the next read, so a deploy that
  // fixes the report is visible on the first regenerate, never hidden behind a running TTL.
  const AI_SCHEMA_V = 4;
  const AI_MAX_TOKENS = AI_DEF.maxTokens;
  const AI_TIMEOUT_MS = 120 * 1000;
  const AI_KINDS = new Set(["target", "flat", "void", "event"]);
  const AI_LEVEL_KINDS = new Set(["void", "target", "zone_low", "zone_high", "note"]);
  let aiReports = new Map();    // coin -> stored report (successes only; errors are returned, not cached)
  let aiGenerating = new Set();
  const aiFetch = aiFetchOpt || null;   // test hook: injected transport (the suite never touches the network)
  try {
    const saved = store.loadAiReports ? store.loadAiReports() : null;
    if (saved && Array.isArray(saved.reports))
      for (const rep of saved.reports) if (rep && rep.coin) aiReports.set(rep.coin, rep);
  } catch (_) {}
  function persistAiReports() {
    try { if (store.saveAiReports) store.saveAiReports({ ts: Date.now(), reports: [...aiReports.values()] }); } catch (_) {}
  }
  const pctOf = (px, ref) => (px != null && ref != null && isFinite(px) && isFinite(ref) && ref > 0)
    ? +((px / ref - 1) * 100).toFixed(2) : null;
  // Material-change stamp: claim counts + last earnings print for this name at generation time.
  // Freshness is recomputed from the SAME sources on every read — stateless, no hooks, self-healing.
  function aiStampFor(coin, ticker) {
    let openN = 0, closedN = 0;
    for (const e of ledgerOpen.values()) if (e.coin === coin && e.vi == null) openN++;
    for (const e of ledgerClosed) if (e.coin === coin && e.vi == null) closedN++;
    let lastPrintD = null;
    if (ticker) for (const p of earnPrints) if (p.t === ticker && (!lastPrintD || p.d > lastPrintD)) lastPrintD = p.d;
    return { openN, closedN, lastPrintD };
  }
  function aiInvalidReason(rep) {
    if ((rep.schemaV || 1) !== AI_SCHEMA_V) return "report format updated";
    const cur = aiStampFor(rep.coin, rep.ticker);
    const s = rep.ctxStamp || {};
    if (cur.openN > (s.openN || 0)) return "new signal claim opened";
    if (cur.closedN > (s.closedN || 0)) return "claim resolved";
    if ((cur.lastPrintD || null) !== (s.lastPrintD || null)) return "earnings print landed";
    return null;
  }
  // Coverage honesty: gaps in the retained series inside the report window. Computed, never
  // generated — the client renders these from the payload even if the model ignores them.
  function aiCoverage(coin, windowMs) {
    const now = Date.now(), cut = now - windowMs;
    const gapScan = (pts, maxGapMs) => {
      const gaps = []; let prev = null;
      for (const t of pts) {
        if (t < cut) { prev = t; continue; }
        if (prev != null && t - prev > maxGapMs) gaps.push({ from: Math.max(prev, cut), to: t, hours: +((t - prev) / HOUR).toFixed(1) });
        prev = t;
      }
      gaps.sort((a, b) => b.hours - a.hours);
      return gaps.slice(0, 3);
    };
    const hs = getHourly(coin).map((k) => k[0]);
    const oi = (hist.get(coin) || []).map((s) => s[0]);
    return { windowDays: Math.round(windowMs / DAY), hourlyGaps: gapScan(hs, 3 * HOUR), oiGaps: gapScan(oi, 6 * HOUR) };
  }
  // Divergence detectors: explicit thresholds, timestamped, passed to the model as facts.
  function aiFlags(r) {
    const flags = [];
    try {
      const oid = oiDailySeries(r.coin);
      const daily = Array.isArray(r.dailyRaw) ? r.dailyRaw.filter((k) => Number.isFinite(+k.c)) : [];
      if (oid && oid.length >= 4 && daily.length >= 4) {
        const o0 = oid[oid.length - 4][1], o1 = oid[oid.length - 1][1];
        const c0 = +daily[daily.length - 4].c, c1 = r.px != null && isFinite(r.px) ? +r.px : +daily[daily.length - 1].c;
        if (o0 > 0 && c0 > 0) {
          const dOi = (o1 / o0 - 1) * 100, dPx = (c1 / c0 - 1) * 100;
          if (dOi <= -6 && dPx >= -1)
            flags.push({ kind: "oi_distribution", t: oid[oid.length - 1][0],
              txt: `open interest fell ${Math.abs(dOi).toFixed(1)}% over 3 days while price held (${dPx >= 0 ? "+" : ""}${dPx.toFixed(1)}%) — positions leaving without price damage` });
          if (dOi >= 6 && dPx <= 1 && dPx >= -6) {
            const fh = getFunding(r.coin);
            let f2 = 0, n2 = 0, f7 = 0, n7 = 0;
            const now = Date.now();
            for (const [t, rate] of fh) { if (!isFinite(rate)) continue; if (t >= now - 2 * DAY) { f2 += rate; n2++; } if (t >= now - 7 * DAY) { f7 += rate; n7++; } }
            if (n2 >= 12 && n7 >= 48 && f2 / n2 < f7 / n7)
              flags.push({ kind: "oi_building_against", t: oid[oid.length - 1][0],
                txt: `open interest grew ${dOi.toFixed(1)}% over 3 days while price stalled and funding eased — positions building against the tape` });
          }
        }
      }
      if (signalsCache && Array.isArray(signalsCache.signals))
        for (const g of signalsCache.signals)
          if (g.coin === r.coin && (g.ev === "fpdiv" || g.ev === "oiflush"))
            flags.push({ kind: g.ev, t: (g.claim0 && g.claim0.t) || g.t0 || Date.now(),
              txt: (EV_LABEL[g.ev] || g.ev) + " signal live" + (g.play && g.play.side ? ` (${g.play.side})` : "") });
    } catch (_) {}
    return flags;
  }
  // The context compiler: everything the model sees, from data already in memory. D1/H12/H4 only —
  // H1 is deliberately excluded so the synthesis can't anchor on noise.
  function compileAiContext(coin) {
    const r = rows.get(coin);
    if (!r || r.delisted) return null;
    const now = Date.now();
    const uni = r.uni === "main" ? "crypto" : "stocks";
    const windowMs = Math.min(uni === "crypto" ? MAIN_DAILY_DAYS * DAY : 370 * DAY, 92 * DAY);
    const daily = Array.isArray(r.dailyRaw) ? r.dailyRaw.filter((k) => Number.isFinite(+k.t) && Number.isFinite(+k.c)) : [];
    const closes = daily.map((k) => +k.c);
    const px = r.px != null && isFinite(r.px) ? +r.px : (closes.length ? closes[closes.length - 1] : null);
    if (px == null) return null;
    const ctx = { coin, ticker: r.ticker || coin, universe: uni, asOf: now, px: sig(px, 9),
      benchmark: uni === "crypto" ? MAIN_BENCH : "SP500" };
    // -- market state ----------------------------------------------------------------------------
    ctx.market = {
      chg: { h1: pctOf(px, r.ref && r.ref.p1h), h4: pctOf(px, r.ref && r.ref.p4h),
        d1: r.d1 != null && isFinite(r.d1) ? +(+r.d1).toFixed(2) : null,
        d7: pctOf(px, r.ref && r.ref.p7d), d30: pctOf(px, r.ref && r.ref.p30d) },
      fundingAprPct: r.funding != null && isFinite(r.funding) ? +(r.funding * 24 * 365 * 100).toFixed(2) : null,
      vol24hUsd: r.vol != null ? Math.round(r.vol) : null, oiUsd: r.oi != null ? Math.round(r.oi) : null,
    };
    try {   // funding percentile in the name's own 31d hourly distribution (same construction as the table)
      if (r.funding != null && isFinite(r.funding)) {
        const fh = getFunding(r.coin), cut = now - 31 * DAY;
        let n = 0, le = 0;
        for (const k of fh) { if (!Array.isArray(k) || k[0] < cut || !isFinite(k[1])) continue; n++; if (k[1] <= r.funding) le++; }
        if (n >= 96) ctx.market.fundingPctile31d = Math.round((100 * le) / n);
      }
    } catch (_) {}
    try {   // OI deltas off the sampled history
      const arr = hist.get(coin);
      if (arr && arr.length > 4) {
        const last = arr[arr.length - 1];
        const at = (ms) => { for (let i = arr.length - 1; i >= 0; i--) if (arr[i][0] <= now - ms) return arr[i]; return null; };
        const a24 = at(DAY), a7 = at(7 * DAY);
        if (a24 && a24[1] > 0) ctx.market.oiChg24hPct = +((last[1] / a24[1] - 1) * 100).toFixed(2);
        if (a7 && a7[1] > 0) ctx.market.oiChg7dPct = +((last[1] / a7[1] - 1) * 100).toFixed(2);
      }
    } catch (_) {}
    // -- trend structure (D1 · H12 · H4 — H1 deliberately excluded) ------------------------------
    try {
      if (px != null && Array.isArray(r.hourlyRaw) && r.hourlyRaw.length >= 26 && daily.length >= 26) {
        const d1g = withFormingDaily(daily, px, now, DAY);
        const lad = trendLadder(px, { D1: d1g, H12: bucketCandles(r.hourlyRaw, 12, HOUR),
          H4: bucketCandles(r.hourlyRaw, 4, HOUR), H1: r.hourlyRaw.slice(-96) });
        if (lad) {
          const tf = {};
          for (const t of ["D1", "H12", "H4"]) tf[t] = { st: lad.tf[t].st, d21: lad.tf[t].d21,
            e13: sig(lad.tf[t].e13, 9), e21: sig(lad.tf[t].e21, 9) };
          const trend = { tf };
          for (const side of ["long", "short"]) {
            const read = trendRead(side, lad);
            if (read) { trend[side] = { score: lad[side].score, read: read.text, retest: read.retest }; }
            if (lad.tf.D1.st === (side === "long" ? "up" : "down")) {
              const sr = stackedRun(d1g, px, side);
              if (sr) trend.d1AgeDays = sr.run, trend.d1AgeCapped = !!sr.capped;
            }
          }
          ctx.trend = trend;
        }
      }
    } catch (_) {}
    // -- volatility regime + range position off daily closes -------------------------------------
    try {
      if (closes.length >= 20) {
        const rets = [];
        for (let i = 1; i < closes.length; i++) if (closes[i - 1] > 0) rets.push(Math.abs((closes[i] / closes[i - 1] - 1) * 100));
        const recent = rets.slice(-5), base = rets.slice(-60);
        if (recent.length >= 3 && base.length >= 20) {
          const cur = recent.reduce((a, b) => a + b, 0) / recent.length;
          let le = 0; for (const v of base) if (v <= cur) le++;
          ctx.volRegime = { avgAbsDaily5dPct: +cur.toFixed(2), pctileVs60d: Math.round((100 * le) / base.length) };
        }
        const win = closes.slice(-Math.min(closes.length, uni === "crypto" ? 90 : 90)).concat([px]);
        const lo = Math.min(...win), hi = Math.max(...win);
        if (hi > lo) ctx.volRegime = Object.assign(ctx.volRegime || {}, {
          rangePosPct: Math.round(((px - lo) / (hi - lo)) * 100), rangeLo: sig(lo, 9), rangeHi: sig(hi, 9) });
      }
    } catch (_) {}
    // -- benchmark decomposition: how much of the 7d move is beta ---------------------------------
    try {
      const benchC = uni === "crypto" ? MAIN_BENCH : benchCoin;
      const b = benchC != null ? rows.get(benchC) : null;
      const bd = b && Array.isArray(b.dailyRaw) ? b.dailyRaw.filter((k) => Number.isFinite(+k.c)).map((k) => +k.c) : [];
      if (bd.length >= 22 && closes.length >= 22) {
        const n = Math.min(bd.length, closes.length, 61);
        const ra = [], rb = [];
        for (let i = 1; i < n; i++) {
          const a0 = closes[closes.length - n + i - 1], a1 = closes[closes.length - n + i];
          const b0 = bd[bd.length - n + i - 1], b1 = bd[bd.length - n + i];
          if (a0 > 0 && b0 > 0) { ra.push(a1 / a0 - 1); rb.push(b1 / b0 - 1); }
        }
        if (ra.length >= 20) {
          const mb = rb.reduce((a, x) => a + x, 0) / rb.length, ma = ra.reduce((a, x) => a + x, 0) / ra.length;
          let cov = 0, varb = 0;
          for (let i = 0; i < ra.length; i++) { cov += (ra[i] - ma) * (rb[i] - mb); varb += (rb[i] - mb) * (rb[i] - mb); }
          if (varb > 0) {
            const beta = cov / varb;
            const own7 = pctOf(px, r.ref && r.ref.p7d);
            const bch7 = pctOf(b.px, b.ref && b.ref.p7d);
            if (own7 != null && bch7 != null)
              ctx.vsBenchmark = { beta: +beta.toFixed(2), own7dPct: own7, bench7dPct: bch7,
                betaExplainedPct: +(beta * bch7).toFixed(2), idiosyncraticPct: +(own7 - beta * bch7).toFixed(2) };
          }
        }
      }
    } catch (_) {}
    // -- live signals + frozen claim anchors ------------------------------------------------------
    try {
      const live = [];
      if (signalsCache && Array.isArray(signalsCache.signals))
        for (const g of signalsCache.signals) if (g.coin === coin) {
          const it = { ev: g.ev, label: EV_LABEL[g.ev] || g.ev, score: g.score };
          if (g.play) it.play = { side: g.play.side || null, bias: g.play.bias || null,
            target: g.play.target != null ? sig(+g.play.target, 9) : null,
            stop: g.play.stop != null ? sig(+g.play.stop, 9) : null };
          if (g.rr != null) it.rr = g.rr;
          if (g.study) it.base = { n: g.study.n, med: g.study.med, hit: g.study.hit, avg: g.study.avg, unit: g.study.unit };
          if (g.unproven) it.unproven = true;
          if (g.claim0) it.claim = { t0: g.claim0.t, mark0: g.claim0.px, side: g.claim0.side,
            stop: g.claim0.stop, target: g.claim0.tgt, resolveAt: g.claim0.resolveAt };
          live.push(it);
        }
      ctx.liveSignals = live;
      // The frozen geometry anchor: the highest-score live claim with a stop. The model MUST use
      // this stop as the void level; the validator enforces it.
      let anchor = null;
      for (const s of live) if (s.claim && s.claim.stop != null && (!anchor || (s.score || 0) > (anchor.score || 0)))
        anchor = { ev: s.ev, side: s.claim.side, stop: s.claim.stop, target: s.claim.target, t0: s.claim.t0, resolveAt: s.claim.resolveAt, score: s.score };
      if (anchor) { delete anchor.score; ctx.claimAnchor = anchor; }
    } catch (_) {}
    // -- ledger record: per-event per-name hit rates, D1-conditioned split, recent autopsy --------
    try {
      const per = {}, tal = { aligned: [], other: [] }, autopsy = [];
      for (const e of ledgerClosed) {
        if (e.coin !== coin || e.vi != null || e.status !== "resolved" || !Number.isFinite(e.realized)) continue;
        const inR = R_LEDGER_EVS.has(e.ev) && e.sd0 > 0;
        const b = per[e.ev] || (per[e.ev] = { label: EV_LABEL[e.ev] || e.ev, n: 0, wins: 0, sumR: 0, nR: 0 });
        b.n++; if (e.realized > 0) b.wins++;
        if (inR) { b.sumR += e.realized; b.nR++; }
        if (e.tal != null && inR) (e.tal === 1 ? tal.aligned : tal.other).push(e.realized);
      }
      for (const ev in per) { const b = per[ev];
        b.hit = +(b.wins / b.n).toFixed(2);
        if (b.nR >= 2) b.avgR = +(b.sumR / b.nR).toFixed(2);
        delete b.sumR; delete b.nR; delete b.wins; }
      ctx.record = per;
      if (tal.aligned.length >= 3 || tal.other.length >= 3) {
        const sum = (a) => ({ n: a.length, hit: a.length ? +(a.filter((x) => x > 0).length / a.length).toFixed(2) : null,
          avgR: a.length ? +(a.reduce((x, y) => x + y, 0) / a.length).toFixed(2) : null });
        ctx.recordTrendSplit = { d1Aligned: sum(tal.aligned), d1NotAligned: sum(tal.other),
          note: "accrues out of sample from the tal stamp epoch — thin n is honest, not hidden" };
      }
      const done = ledgerClosed.filter((e) => e.coin === coin && e.vi == null && e.status === "resolved" && Number.isFinite(e.realized))
        .sort((a, b) => (b.tR || b.t0) - (a.tR || a.t0)).slice(0, 3);
      for (const e of done) autopsy.push({ ev: e.ev, label: EV_LABEL[e.ev] || e.ev, t0: e.t0, tR: e.tR || null,
        realized: +(+e.realized).toFixed(2), unit: (R_LEDGER_EVS.has(e.ev) && e.sd0 > 0) ? "R" : "%",
        stopped: e.stopped === true, win: e.realized > 0, days: e.tR ? +(((e.tR - e.t0) / DAY).toFixed(1)) : null });
      ctx.recentClaims = autopsy;
      if (signalsCache && signalsCache.earnSplit) {
        const relevant = {};
        for (const ev in signalsCache.earnSplit) if (per[ev] || (ctx.liveSignals || []).some((s) => s.ev === ev)) relevant[ev] = signalsCache.earnSplit[ev];
        if (Object.keys(relevant).length) ctx.earnSplitGlobal = { note: "roster-wide, not per-name", split: relevant };
      }
    } catch (_) {}
    // -- equities extras: earnings event risk, filings note, sector context -----------------------
    if (uni === "stocks") {
      try {
        const tk = r.ticker || coin, e = {};
        if (earnCache && Array.isArray(earnCache.entries)) {
          const up = earnCache.entries.filter((x) => x.t === tk).sort((a, b) => (a.d < b.d ? -1 : 1))[0];
          if (up) e.next = { d: up.d, session: up.s || "TBD",
            inDays: Math.max(0, Math.round((Date.UTC(+up.d.slice(0, 4), +up.d.slice(5, 7) - 1, +up.d.slice(8, 10)) - Date.now()) / DAY)) };
        }
        if (earnStudy && earnStudy[tk]) e.reaction = earnStudy[tk];
        let last = null;
        for (const p of earnPrints) if (p.t === tk && p.epsA != null && (!last || p.d > last.d)) last = p;
        if (last) e.lastPrint = { d: last.d, session: last.s || null, eps: last.eps, epsA: last.epsA,
          beat: last.eps != null && last.epsA != null ? last.epsA > last.eps : null };
        if (e.next || e.reaction || e.lastPrint) ctx.earnings = e;
      } catch (_) {}
      try { const cl = classifyCached(r.ticker, r.uni);
        if (cl && cl.sector) {
          const peers = activeMarkets().filter((x) => !x.delisted && classifyCached(x.ticker, x.uni).sector === cl.sector);
          const with7 = peers.map((x) => ({ t: x.ticker, d7: pctOf(x.px, x.ref && x.ref.p7d) })).filter((x) => x.d7 != null)
            .sort((a, b) => b.d7 - a.d7);
          const rank = with7.findIndex((x) => x.t === r.ticker);
          ctx.sector = { name: cl.sector, assetClass: cl.assetClass || null,
            rank7d: rank >= 0 ? rank + 1 : null, of: with7.length,
            median7dPct: with7.length ? +median(with7.map((x) => x.d7)).toFixed(2) : null };
        }
      } catch (_) {}
    }
    ctx.flags = aiFlags(r);
    ctx.coverage = aiCoverage(coin, windowMs);
    return ctx;
  }
  const AI_SYSTEM = `You are the analyst layer of a private trading dashboard. You receive one JSON context object holding everything the server knows about a single perp market: price/momentum state, an EMA 13/21 trend ladder (daily, 12-hour and 4-hour rungs only), live signals with frozen claim geometry, this name's own out-of-sample signal track record, positioning (open interest, funding), benchmark beta decomposition, volatility regime, divergence flags, coverage gaps, and (for equities) earnings event risk and sector context.
Respond with ONLY a JSON object — no markdown fences, no preamble — with exactly these keys:
{"headline": string (<=60 chars, plain-language stance, e.g. "Constructive, leans long" or "Constructive, but earnings in 6 days"),
 "bias": "long"|"short"|"neutral",
 "synthesis": string (one paragraph, 3-6 sentences, plain human language a non-quant friend reads in 30 seconds; name the single dominant risk honestly),
 "evidence": array of 3-8 {"k": short label (<=16 chars, lowercase), "v": one plain-language sentence grounded in a specific number from the context},
 "eventRisk": string or null (equities with an upcoming print inside ~10 days: what the reaction study says and what holding through it means; otherwise null),
 "scenarios": array of 2-4 {"name": short plain description, "kind": "target"|"flat"|"void"|"event", "p": probability 0..1, "target": price level or null, "note": one sentence}. Probabilities must sum to ~1 and be anchored on the track record and base rates in the context, not vibes. "target" scenarios are THESIS-DIRECTION only — an adverse recovery against the bias is the "void" scenario (through the void level) or "flat", never a target. If an earnings print falls inside the scenario horizon, the middle scenario must be kind "event" — the print decides, treat it as a coin flip scaled by the reaction study, and say so.
 "invalidations": array of 1-5 plain sentences — observable conditions that would change the read,
 "action": {"stance": "enter_now"|"enter_on_pullback"|"take_profit"|"wait"|"no_trade", "entry": price or null, "note": one sentence on why this stance and what to watch}. The actionable read: offer an entry stance whenever the geometry supports one (a void and a target exist and the expected value at some entry is positive) — "enter_on_pullback" requires "entry" set to the pullback level (typically the zone), "enter_now" may leave entry null (the current price). When the honest answer is to stand aside — event about to decide, negative expected value, neutral read, thin data — say "wait" or "no_trade" and name the condition that would change it. Never invent a stance the scenario odds don't support.
 "levels": array of at most 4 {"value": price, "kind": "void"|"target"|"zone_low"|"zone_high", "label": <=60 chars} for chart annotation. Level discipline is strict: when bias is "long" or "short" you MUST include exactly one "void" level — the observable price where the read is dead (the frozen claim stop when claimAnchor exists, otherwise a structural level like the relevant swing low/high) — and exactly one "void" scenario resolving against it. At most one "target" level, optionally one zone_low+zone_high pair. NEVER annotate moving averages as levels (EMAs drift — the chart draws the live ribbon itself) and never annotate range bounds unless the bound IS the void or target. Levels must sit within roughly ±25% of the current price or they won't render.
Hard rules: if claimAnchor exists, its stop IS the void level — use exactly that number. Use only levels derivable from the context (range structure, claim geometry, prior swings implied by the data). Never mention timeframes below 4h. Cite the name's own numbers, not generic market lore. Where the data is thin (low n, coverage gaps, unknown trend split), say so plainly instead of smoothing over it. No investment-advice framing beyond describing the mechanical scenarios.`;
  // Validate the model's JSON, correct the void to frozen-claim geometry when one exists, and
  // compute every displayed number (risk unit, per-scenario R/R and payoff, EV) server-side.
  function validateAiReport(rawText, ctx) {
    let out;
    try {
      const clean = String(rawText || "").replace(/```json|```/g, "").trim();
      out = JSON.parse(clean.slice(clean.indexOf("{"), clean.lastIndexOf("}") + 1));
    } catch (_) { return { ok: false, error: "model returned unparseable JSON" }; }
    const px = ctx.px;
    const str = (v, max) => typeof v === "string" && v.trim().length > 0 && v.length <= max;
    if (!str(out.headline, 80)) return { ok: false, error: "bad headline" };
    if (!["long", "short", "neutral"].includes(out.bias)) return { ok: false, error: "bad bias" };
    if (!str(out.synthesis, 2600) || out.synthesis.length < 120) return { ok: false, error: "bad synthesis" };
    if (!Array.isArray(out.evidence) || out.evidence.length < 3 || out.evidence.length > 8
      || !out.evidence.every((e) => e && str(e.k, 20) && str(e.v, 320))) return { ok: false, error: "bad evidence" };
    if (out.eventRisk != null && !str(out.eventRisk, 500)) return { ok: false, error: "bad eventRisk" };
    if (!Array.isArray(out.invalidations) || out.invalidations.length < 1 || out.invalidations.length > 5
      || !out.invalidations.every((s) => str(s, 240))) return { ok: false, error: "bad invalidations" };
    if (!Array.isArray(out.scenarios) || out.scenarios.length < 2 || out.scenarios.length > 4) return { ok: false, error: "bad scenarios" };
    let psum = 0;
    for (const s of out.scenarios) {
      if (!s || !str(s.name, 90) || !AI_KINDS.has(s.kind) || typeof s.p !== "number" || !(s.p >= 0 && s.p <= 1)) return { ok: false, error: "bad scenario entry" };
      if (s.kind === "target" && !(Number.isFinite(s.target) && s.target > 0)) return { ok: false, error: "target scenario without a target level" };
      if (s.note != null && !str(s.note, 300)) return { ok: false, error: "bad scenario note" };
      psum += s.p;
    }
    if (!(psum >= 0.85 && psum <= 1.15)) return { ok: false, error: "scenario probabilities do not sum to 1" };
    for (const s of out.scenarios) s.p = +(s.p / psum).toFixed(3);
    if (out.scenarios.filter((s) => s.kind === "void").length > 1) return { ok: false, error: "multiple void scenarios" };
    const levels = [];
    if (out.levels != null) {
      if (!Array.isArray(out.levels) || out.levels.length > 4) return { ok: false, error: "bad levels (max 4)" };
      for (const l of out.levels) {
        if (!l || !Number.isFinite(l.value) || !AI_LEVEL_KINDS.has(l.kind) || !str(l.label, 80)) return { ok: false, error: "bad level entry" };
        // EMAs drift — a static dashed line labeled after one is stale the moment it's drawn, and
        // the chart draws the live ribbon itself. Mechanical ban, not a style preference.
        if (/\b(ema|sma)\d*\b|moving average/i.test(l.label)) return { ok: false, error: "moving averages are not chart levels" };
        if (!(l.value > px * 0.6 && l.value < px * 1.6)) return { ok: false, error: "level outside sanity bounds" };
        levels.push({ value: sig(+l.value, 9), kind: l.kind, label: l.label });
      }
    }
    if (levels.filter((l) => l.kind === "void").length > 1) return { ok: false, error: "multiple void levels" };
    if (levels.filter((l) => l.kind === "target").length > 1) return { ok: false, error: "multiple target levels" };
    // Frozen geometry wins: with a live claim, the void level IS the claim's stop. Model output
    // that disagrees is overwritten and flagged — the chart may never contradict the ledger.
    let corrected = false;
    // The override applies only when the read agrees with the claim's side (or is neutral): a
    // long claim's stop sits below price and is mechanically invalid as a SHORT read's void —
    // an opposing read must carry its own structural void, with the claim still visible in the
    // payload as context.
    const anchorSide = ctx.claimAnchor && ctx.claimAnchor.side ? ctx.claimAnchor.side : null;
    const anchorApplies = ctx.claimAnchor && ctx.claimAnchor.stop != null
      && (anchorSide == null || out.bias === "neutral" || out.bias === anchorSide);
    const anchorStop = anchorApplies ? +ctx.claimAnchor.stop : null;
    let voidL = levels.find((l) => l.kind === "void") || null;
    if (anchorStop != null) {
      if (!voidL) { voidL = { value: sig(anchorStop, 9), kind: "void", label: "void — frozen claim stop" }; levels.push(voidL); corrected = true; }
      else if (Math.abs(voidL.value - anchorStop) / anchorStop > 0.005) { voidL.value = sig(anchorStop, 9); voidL.label += " (corrected to frozen claim stop)"; corrected = true; }
    }
    // A directional read without a void is an unfalsifiable read — the entire R/R and EV promise
    // dies with it, so it fails validation instead of shipping dashes. Neutral reads may omit it.
    if (out.bias !== "neutral" && !voidL) return { ok: false, error: "directional read without a void level" };
    if (out.bias !== "neutral" && !out.scenarios.some((s) => s.kind === "void")) return { ok: false, error: "directional read without a void scenario" };
    // Void must sit on the LOSS side of the bias — a "void" above price on a long read is
    // mechanically inverted geometry, same class of bug as the stop-geometry gate on claims.
    if (voidL && out.bias === "long" && !(voidL.value < px)) return { ok: false, error: "long void must sit below price" };
    if (voidL && out.bias === "short" && !(voidL.value > px)) return { ok: false, error: "short void must sit above price" };
    // Server-side scenario math: risk unit = |px - void|; payoffs in R signed by the bias side.
    const sideSign = out.bias === "short" ? -1 : 1;
    const risk = voidL && Math.abs(px - voidL.value) > 0 ? Math.abs(px - voidL.value) : null;
    const scen = out.scenarios.map((s) => {
      const o = { name: s.name, kind: s.kind, p: s.p, target: s.kind === "target" ? sig(+s.target, 9) : null, note: s.note || null };
      if (risk != null) {
        if (s.kind === "target") { o.payoffR = +((sideSign * (o.target - px)) / risk).toFixed(2); o.rr = +Math.abs(o.payoffR).toFixed(2); }
        else if (s.kind === "void") o.payoffR = -1;
        else o.payoffR = 0;   // flat and event: no claimable edge — EV takes 0, the card says coin-flip for event
      }
      return o;
    });
    const ev = risk != null ? +scen.reduce((a, s) => a + s.p * (s.payoffR || 0), 0).toFixed(2) : null;
    // The actionable read: stance + entry validated, then all money math computed HERE at that
    // entry — including the improved pullback R/R the entry exists to capture. A stance the
    // geometry can't support (enter with no void/target) is a validation failure, and negative-EV
    // entries are downgraded to "wait" server-side rather than shipped as a plan.
    const AI_STANCES = new Set(["enter_now", "enter_on_pullback", "take_profit", "wait", "no_trade"]);
    const act = out.action;
    if (!act || typeof act !== "object" || !AI_STANCES.has(act.stance)) return { ok: false, error: "bad action stance" };
    if (act.note != null && !str(act.note, 300)) return { ok: false, error: "bad action note" };
    if (act.entry != null && (!Number.isFinite(act.entry) || !(act.entry > px * 0.6 && act.entry < px * 1.6))) return { ok: false, error: "action entry outside sanity bounds" };
    const targetL = levels.find((l) => l.kind === "target") || null;
    let action = { stance: act.stance, note: act.note ? String(act.note).trim() : null };
    if (act.stance === "enter_now" || act.stance === "enter_on_pullback") {
      if (voidL == null || targetL == null) return { ok: false, error: "actionable stance without void/target geometry" };
      if (act.stance === "enter_on_pullback" && act.entry == null) return { ok: false, error: "pullback stance without an entry level" };
      const entry = act.entry != null ? +act.entry : px;
      // entry must sit on the tradeable side of the void, same geometry class as everything else
      if (out.bias === "long" && !(entry > voidL.value)) return { ok: false, error: "long entry at or below the void" };
      if (out.bias === "short" && !(entry < voidL.value)) return { ok: false, error: "short entry at or above the void" };
      const eRisk = Math.abs(entry - voidL.value);
      if (!(eRisk > 0)) return { ok: false, error: "entry has zero risk distance" };
      const eScen = out.scenarios.map((s) => s.kind === "target" ? (sideSign * ((s.target != null ? +s.target : targetL.value) - entry)) / eRisk
        : s.kind === "void" ? -1 : 0);
      const eEv = +out.scenarios.reduce((a, s, i) => a + s.p * eScen[i], 0).toFixed(2);
      const eRR = +Math.abs((sideSign * (targetL.value - entry)) / eRisk).toFixed(2);
      if (eEv <= 0) {
        // the plan doesn't pay at this entry — an honest downgrade, stamped so the card can say why
        action = { stance: "wait", note: (action.note ? action.note + " " : "") + "(downgraded from an entry stance: expected value at the proposed entry was not positive)", downgraded: true };
      } else {
        action = Object.assign(action, { side: out.bias, entry: sig(entry, 9), entryIsMarket: act.entry == null,
          stop: voidL.value, target: targetL.value, riskPct: +((eRisk / entry) * 100).toFixed(2), rr: eRR, evR: eEv });
      }
    }
    return { ok: true, ai: { headline: out.headline.trim(), bias: out.bias, synthesis: out.synthesis.trim(),
      evidence: out.evidence.map((e) => ({ k: e.k.trim(), v: e.v.trim() })),
      eventRisk: out.eventRisk ? String(out.eventRisk).trim() : null,
      invalidations: out.invalidations.map((s) => s.trim()) },
      computed: { px0: sig(px, 9), levels, voidLevel: voidL ? voidL.value : null, riskAbs: risk != null ? sig(risk, 9) : null,
        riskPct: risk != null ? +((risk / px) * 100).toFixed(2) : null, correctedVoid: corrected, scenarios: scen, evR: ev, action } };
  }
  // Chart annotation marks, computed here from the ledger + prints — never model-invented.
  // FIRST FIRES ONLY: same-event entries chaining within 2 days of the prior entry's span are
  // one episode run (the same boundary the rearm machinery scores by) — only the run's first
  // entry marks the chart; the ledger underneath still records every fire. Each mark carries
  // its trade side (from the frozen psd — a gap-fader shorting an up-gap marks SHORT), its
  // status, and its resolved outcome, so the chart legend renders the same audit trail the
  // drawer shows without a second fetch.
  const AI_CTX_EVS = new Set(["coil", "volume", "prem"]);
  // Proven edge, using the SAME floors the signals engine's honesty badges use — n>=8 resolved
  // with positive average expectancy roster-wide (the "unproven" threshold), or this specific
  // name carrying its own strong record (n>=5, hit >= 60%). Computed directly off ledgerClosed
  // so the answer doesn't depend on whether a signals build has run yet. Legacy pre-sigma
  // outcomes are excluded from the R aggregates, exactly as everywhere else.
  const AI_MARK_MIN_N = 8, AI_MARK_NAME_N = 5, AI_MARK_NAME_HIT = 0.6;
  function aiEvEdge(ev, coin) {
    let n = 0, sum = 0, cn = 0, cw = 0;
    for (const e of ledgerClosed) {
      if (e.ev !== ev || e.vi != null || e.status !== "resolved" || !Number.isFinite(e.realized)) continue;
      if (R_LEDGER_EVS.has(e.ev) && !(e.sd0 > 0)) continue;   // legacy % outcomes stay out of the aggregates
      n++; sum += e.realized;
      if (e.coin === coin) { cn++; if (e.realized > 0) cw++; }
    }
    if (cn >= AI_MARK_NAME_N && cw / cn >= AI_MARK_NAME_HIT) return true;   // name-specific edge
    return n >= AI_MARK_MIN_N && sum / n > 0;                               // roster-wide proven edge
  }
  function aiMarks(coin, ticker, windowMs) {
    const now = Date.now(), cut = now - windowMs, marks = [];
    let suppressed = 0;
    const ents = [];
    for (const e of ledgerOpen.values()) if (e.coin === coin && e.vi == null) ents.push({ e, st: "open" });
    for (const e of ledgerClosed) if (e.coin === coin && e.vi == null && (e.status === "resolved" || e.status === "void"))
      ents.push({ e, st: e.status });
    ents.sort((a, b) => a.e.t0 - b.e.t0);
    const lastEnd = new Map();   // ev -> end of the last seen entry's span
    const edgeMemo = new Map();
    const hasEdge = (ev) => { if (!edgeMemo.has(ev)) edgeMemo.set(ev, aiEvEdge(ev, coin)); return edgeMemo.get(ev); };
    for (const { e, st } of ents) {
      const prev = lastEnd.get(e.ev);
      const runsOn = prev != null && e.t0 - prev <= 2 * DAY;
      lastEnd.set(e.ev, Math.max(prev || 0, e.tR || e.resolveAt || e.t0));
      if (runsOn || e.t0 < cut) continue;   // re-fire inside a live run — recorded, not re-marked
      // Proven-edge gate: unproven / negative-expectancy event types don't mark the chart —
      // they're noise on a price picture. Counted and disclosed, never silently dropped; the
      // ledger and the Signals tab carry the full record regardless.
      if (!hasEdge(e.ev)) { suppressed++; continue; }
      const kind = AI_CTX_EVS.has(e.ev) ? "ctx" : (e.psd || (e.dir >= 0 ? "long" : "short"));
      marks.push({ t: e.t0, kind, ev: e.ev, label: EV_LABEL[e.ev] || e.ev, status: st,
        realized: st === "resolved" && Number.isFinite(e.realized) ? +(+e.realized).toFixed(2) : null,
        unit: st === "resolved" ? ((R_LEDGER_EVS.has(e.ev) && e.sd0 > 0) ? "R" : unitOf(e.ev)) : null,
        days: e.tR ? +(((e.tR - e.t0) / DAY).toFixed(1)) : null });
    }
    if (ticker) for (const p of earnPrints) if (p.t === ticker) {
      const t = Date.UTC(+p.d.slice(0, 4), +p.d.slice(5, 7) - 1, +p.d.slice(8, 10));
      if (t < cut) continue;
      const beat = p.eps != null && p.epsA != null ? (p.epsA > p.eps ? "beat" : "miss") : null;
      marks.push({ t, kind: "earn", ev: "earnings", label: "Earnings print" + (beat ? " — " + beat : ""), status: null });
    }
    marks.sort((a, b) => a.t - b.t);
    return { marks: marks.slice(-20), suppressed };
  }
  async function callModel(model, ctx) {
    const doFetch = aiFetch || fetch;
    const ctrl = new AbortController();
    const to = setTimeout(() => ctrl.abort(), AI_TIMEOUT_MS);
    try {
      let res;
      if (AI_PROVIDER === "openai") {
        // OpenAI Chat Completions. max_completion_tokens (not max_tokens — GPT-5.x rejects the
        // old name) covers reasoning + output together, hence the larger budget. Body stays
        // minimal on purpose, same principle as the Anthropic path.
        res = await doFetch("https://api.openai.com/v1/chat/completions", {
          method: "POST",
          headers: { "content-type": "application/json", authorization: "Bearer " + AI_KEY() },
          body: JSON.stringify({ model, max_completion_tokens: AI_MAX_TOKENS,
            messages: [{ role: "system", content: AI_SYSTEM },
              { role: "user", content: "Context:\n" + JSON.stringify(ctx) }] }),
          signal: ctrl.signal,
        });
        if (!res.ok) { let msg = "HTTP " + res.status; try { const j = await res.json(); if (j && j.error && j.error.message) msg += " — " + j.error.message; } catch (_) {} return { ok: false, error: msg }; }
        const data = await res.json();
        const m = data && Array.isArray(data.choices) && data.choices[0] ? data.choices[0].message : null;
        if (m && m.refusal) return { ok: false, error: "model refused" };   // refusals ride a 200 here too
        const text = m && typeof m.content === "string" ? m.content : "";
        if (!text) return { ok: false, error: (data.choices && data.choices[0] && data.choices[0].finish_reason === "length")
          ? "reasoning consumed the token budget — empty output" : "empty model response" };
        return { ok: true, text, usage: data.usage || null };
      }
      res = await doFetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: { "content-type": "application/json", "x-api-key": AI_KEY(),
          "anthropic-version": "2023-06-01" },
        // Deliberately minimal body: Fable rejects some sampling params other models accept, and
        // its adaptive thinking must be left alone (an explicit thinking:disabled is a 400).
        body: JSON.stringify({ model, max_tokens: AI_MAX_TOKENS, system: AI_SYSTEM,
          messages: [{ role: "user", content: "Context:\n" + JSON.stringify(ctx) }] }),
        signal: ctrl.signal,
      });
      if (!res.ok) { let msg = "HTTP " + res.status; try { const j = await res.json(); if (j && j.error && j.error.message) msg += " — " + j.error.message; } catch (_) {} return { ok: false, error: msg }; }
      const data = await res.json();
      // A refusal arrives as HTTP 200 with stop_reason "refusal" — a failure for our purposes,
      // routed to the fallback model like any other.
      if (data && data.stop_reason === "refusal") return { ok: false, error: "model refused" };
      const text = data && Array.isArray(data.content)
        ? data.content.filter((b) => b && b.type === "text").map((b) => b.text).join("\n") : "";
      if (!text) return { ok: false, error: "empty model response" };
      return { ok: true, text, usage: data.usage || null };
    } catch (e) {
      return { ok: false, error: e && e.name === "AbortError" ? "model call timed out" : ("fetch failed: " + (e && e.message)) };
    } finally { clearTimeout(to); }
  }
  function aiAssemble(coin, ctx, validated, model) {
    const r = rows.get(coin);
    const rep = { coin, ticker: (r && r.ticker) || ctx.ticker || coin, uni: ctx.universe, ts: Date.now(),
      model, ttlMs: AI_TTL_MS, schemaV: AI_SCHEMA_V, ctxStamp: aiStampFor(coin, (r && r.ticker) || ctx.ticker),
      ai: validated.ai, computed: (() => { const mk = aiMarks(coin, (r && r.ticker) || ctx.ticker, 92 * DAY);
        return Object.assign({}, validated.computed,
          { marks: mk.marks, marksSuppressed: mk.suppressed, flags: ctx.flags || [], coverage: ctx.coverage || null,
            claimAnchor: ctx.claimAnchor || null }); })() };
    aiReports.set(coin, rep);
    persistAiReports();
    return rep;
  }
  function aiPublic(rep) {
    const age = Date.now() - rep.ts;
    const invalid = aiInvalidReason(rep);
    const fresh = age < (rep.ttlMs || AI_TTL_MS) && !invalid;
    return Object.assign({}, rep, { status: invalid ? "invalidated" : (fresh ? "fresh" : "stale"),
      invalidReason: invalid, ageMs: age, canRegen: !fresh,
      regenInMs: fresh ? Math.max(0, (rep.ttlMs || AI_TTL_MS) - age) : 0 });
  }
  function aiUniverseOk(coin) {
    const r = rows.get(coin);
    return !!(r && !r.delisted && (r.uni !== "main" || crypto));
  }
  function getAiReport(coin) {
    if (!coin || !aiUniverseOk(coin)) {
      const rep = coin ? aiReports.get(coin) : null;
      if (!rep) return { coin: coin || "", status: "none", error: coin ? "not in the live universe" : "coin required", ts: Date.now() };
    }
    const rep = aiReports.get(coin);
    if (!rep) return { coin, status: "none", canRegen: true, ts: Date.now(),
      enabled: !!(AI_KEY() || aiFetch), provider: AI_PROVIDER, model: AI_MODEL };
    return aiPublic(rep);
  }
  function listAiReports() {
    const out = [...aiReports.values()].map((rep) => {
      const p = aiPublic(rep);
      return { coin: p.coin, ticker: p.ticker, uni: p.uni, ts: p.ts, model: p.model,
        headline: p.ai && p.ai.headline, bias: p.ai && p.ai.bias, status: p.status,
        invalidReason: p.invalidReason, regenInMs: p.regenInMs, evR: p.computed && p.computed.evR };
    });
    out.sort((a, b) => b.ts - a.ts);
    return { ts: Date.now(), ttlMs: AI_TTL_MS, model: AI_MODEL, provider: AI_PROVIDER,
      enabled: !!(AI_KEY() || aiFetch), reports: out.slice(0, 30) };
  }
  async function generateAiReport(coin) {
    if (!coin || !aiUniverseOk(coin)) return { ok: false, error: "not in the live universe" };
    if (!AI_KEY() && !aiFetch) return { ok: false, error: "no AI API key set on the server (ANTHROPIC_API_KEY or OPENAI_API_KEY)" };
    const existing = aiReports.get(coin);
    if (existing) {
      const p = aiPublic(existing);
      // The cooldown is the group's rate limit, enforced HERE — the client's disabled button is
      // convenience, this check is the gate.
      if (!p.canRegen) return { ok: false, error: "cooldown", regenInMs: p.regenInMs, report: p };
    }
    if (aiGenerating.has(coin)) return { ok: false, error: "generation already running for this ticker" };
    aiGenerating.add(coin);
    try {
      const ctx = compileAiContext(coin);
      if (!ctx) return { ok: false, error: "not enough data compiled for this ticker yet" };
      let used = AI_MODEL, call = await callModel(AI_MODEL, ctx);
      let val = call.ok ? validateAiReport(call.text, ctx) : { ok: false, error: call.error };
      if (!val.ok) {
        log(`AI report ${coin}: ${AI_MODEL} failed (${val.error}) — falling back to ${AI_MODEL_FALLBACK}`);
        used = AI_MODEL_FALLBACK; call = await callModel(AI_MODEL_FALLBACK, ctx);
        val = call.ok ? validateAiReport(call.text, ctx) : { ok: false, error: call.error };
      }
      if (!val.ok) { log(`AI report ${coin}: fallback failed too (${val.error})`); return { ok: false, error: val.error }; }
      const rep = aiAssemble(coin, ctx, val, used);
      log(`AI report generated: ${coin} via ${used} (bias ${rep.ai.bias}, ev ${rep.computed.evR != null ? rep.computed.evR + "R" : "n/a"})`);
      return { ok: true, report: aiPublic(rep) };
    } finally { aiGenerating.delete(coin); }
  }

  return {
    start,
    getSnapshot: () => snapshotCache,
    getDaily: () => dailyCache,
    getAnalytics: () => analyticsCache,
    getSeries,
    getHourly,
    getFunding,
    getCandles,
    getTfCandles,
    getSignals: () => signalsCache,
    getEarnings: () => earnCache,
    voidEarnPrint,
    getTrend,
    buildTrendNow: buildTrend,   // harness: force a trend-board rebuild without waiting out the memo
    seedRowNow: (coin, fields) => Object.assign(getRow(coin), fields),   // harness: seed a synthetic market (px/spines) so builds are testable without network
    needDailyNow: (coin) => { const r = rows.get(coin); return !!(r && needDaily(r)); },   // harness: does the daily worker consider this market fetch-worthy right now
    getLedgerFor,
    getLedgerExport,
    openLedgerNow: (coin, ev, sigEntry, dir, extra, vi) =>   // harness: fire a claim directly so the context stamp is testable without a full signals build
      openLedger(getRow(coin), ev, sigEntry || { score: 0, reading: "" }, dir, extra, vi),
    // AI analyst report: cached read, on-demand generation (TTL cooldown enforced inside), and
    // the recent-reports list for the Report tab.
    getAiReport,
    generateAiReport,
    listAiReports,
    aiCompileNow: compileAiContext,   // harness: build the context object without any network
    aiValidateNow: validateAiReport,  // harness: run model text through the validator + server math
    aiMarksNow: aiMarks,              // harness: first-fire chart marks without a full generation
    aiIngestNow: (coin, rawText, model) => {   // harness: full ingest path minus the API call
      const ctx = compileAiContext(coin);
      if (!ctx) return { ok: false, error: "no context" };
      const val = validateAiReport(rawText, ctx);
      if (!val.ok) return val;
      return { ok: true, report: aiPublic(aiAssemble(coin, ctx, val, model || "test")) };
    },
    aiTouchStamp: (coin, patch) => {   // harness: shift a stored report's material-change stamp
      const rep = aiReports.get(coin);
      if (rep) Object.assign(rep.ctxStamp, patch || {});
      return rep ? rep.ctxStamp : null;
    },
    aiPatchReport: (coin, patch) => {   // harness: mutate a stored report's top-level fields (e.g. schemaV)
      const rep = aiReports.get(coin);
      if (rep) Object.assign(rep, patch || {});
      return !!rep;
    },
    backupLedgerNow: (f) => backupLedger(f),   // harness: run one backup cycle with an injected transport (the suite never touches the network)
    hydrateLedgerNow: hydrateLedger,   // harness: run hydration + unit repair without start()
    pollNow: pollUniverse,   // diagnostics + harness: force one universe reconciliation
    buildSignalsNow: buildSignals,   // harness: run a full signals build synchronously
    buildDailyNow: buildDaily,       // harness: populate daily closes so the signals loop has inputs
    persistFeatures,
    persistLedger: () => { ledgerDirty = true; persistLedger(); },
    // Rich health: fail/backoff counts, backfill queue depth, rate-limiter utilization and
    // WS status make "it looks stale" diagnosable from /api/health instead of Railway logs.
    stats: () => {
      const now = Date.now();
      let active = 0, hFailing = 0, dFailing = 0, fFailing = 0, pendH = 0, pendD = 0;
      for (const r of rows.values()) {
        if (r.delisted) continue;
        active++;
        if ((r.hFailUntil || 0) > now) hFailing++;
        if ((r.dFailUntil || 0) > now) dFailing++;
        if ((r.fFailUntil || 0) > now) fFailing++;
        if (!r.feat) pendH++;
        if (!r.dailyRaw) pendD++;
      }
      return {
        version: version || null,
        markets: rows.size, active, bench: benchCoin, oiCoins: hist.size,
        crypto: crypto ? { selected: mainList.length, active: mainMarkets().length, bench: MAIN_BENCH } : null,
        hourly: hourlyCoverage(), funding: fundingCoverage(), lastPoll,
        backfill: { hourlyPending: pendH, dailyPending: pendD },
        failing: { hourly: hFailing, daily: dFailing, funding: fFailing },
        signals: signalsCache ? signalsCache.count : 0,
        ledger: { open: ledgerOpen.size, resolved: ledgerClosed.length },
        earnings: { entries: earnCache ? earnCache.entries.length : 0, asOf: earnCache ? earnCache.asOf : null,
          prints: earnPrints.length, histDone: earnHistDone, studyTickers: Object.keys(earnStudy).length,
          error: earnCache ? earnCache.error : (earnErr || "not fetched yet") },
        backup: { enabled: !!(BK_REPO && BK_TOKEN), repo: BK_REPO || null, lastOk: backupLast, error: backupErr },
        ai: { enabled: !!(AI_KEY() || aiFetch), provider: AI_PROVIDER, model: AI_MODEL,
          fallback: AI_MODEL_FALLBACK, ttlMin: Math.round(AI_TTL_MS / 60000), reports: aiReports.size },
        rate: limiterUsage(),
        ws: sock ? Object.assign(sock.status(), { applied: wsApplied }) : { enabled: false },
      };
    },
  };
}

module.exports = { createPoller };
