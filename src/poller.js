"use strict";
// Owns all Hyperliquid I/O. Polls the universe, backfills candle history, samples OI,
// and maintains two cached payloads (/api/snapshot and /api/daily) that clients read.
const { fetchMetaAndCtxs, fetchCandles, fetchFundingHistory, sleep, limiterUsage, createUniverseSocket } = require("./hyperliquid");
const {
  studyBigMove, studyBreakout, studyBreakdown, studyVolShift, studyGapFade, studyFundFlip, confSplit, studyOIFlush, studyFPDiv, compressionNow, offDriftStats, retStd, dailyRets, stdev,
  EV_META, playbook, marketSessions, summarizeEvents, shouldPromote, stopTouched,
} = require("./compute");
const { featuresFromHourly, oiDeltaPct, fundingAvg, meanPairwiseCorr,
  cashAnchors, overnightAnchors, weekendAnchors, runHolds, sessionComposite, activityClock, dowClock, priceAsOf,
  pca2, hourReturnMeans, hourReturnStats, pearson } = require("./compute");
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
// ---- crypto (Hyperliquid main dex) ----------------------------------------------------------
// Top-N main-dex perps ride the same machinery with a LIGHTER footprint: 31d retention across
// the board (hourly spine, dailies, OI — no 365d tier: that exists to feed studies crypto does
// not participate in). Crypto rows NEVER enter signals, studies, the ledger, pooling, or the
// regime aggregate — enforced by keeping activeMarkets() xyz-pure and giving main its own list.
const MAIN_DEX = "";                  // Hyperliquid main perp universe
const MAIN_BENCH = "BTC";
const MAIN_TOP_N = 60;                // selected by 24h notional volume, recomputed once per UTC day
const MAIN_HIST_DAYS = 31;
const MAIN_HOURLY_WEIGHT = 35;        // 31d spine pull
const MAIN_DAILY_WEIGHT = 8;          // 40d daily pull
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

function num(x) { const v = typeof x === "number" ? x : parseFloat(x); return Number.isFinite(v) ? v : null; }
// Payload-trim helpers: the snapshot ships hundreds of derived floats per market at full
// double precision (17 digits) — quantizing to what the UI can actually display cuts the
// JSON 30-50% without changing a single rendered pixel. `rnd` = fixed decimals (for %
// values), `sig` = significant digits (for prices, which span 6 orders of magnitude).
function rnd(x, dp) { return Number.isFinite(x) ? +x.toFixed(dp) : null; }
function sig(x, n) { return Number.isFinite(x) ? (x === 0 ? 0 : +x.toPrecision(n)) : null; }

function createPoller({ dex, store, log, version, crypto }) {
  const rows = new Map();          // coin -> row
  const hist = store.loadAll(Date.now() - OI_RETENTION); // coin -> [[ts, oi], ...]
  let order = [];
  let benchCoin = null;
  let mainOrder = [], mainList = [], mainSel = new Set(), mainDay = 0;   // main-dex universe order / today's selection
  let snapshotCache = null, dailyCache = null, lastPoll = 0;
  let dailyVer = 0, dailySig = "";   // ETag version for /api/daily — bumps only when daily content changes
  let analyticsCache = null, analyticsVer = 0, analyticsSig = "";   // ETag version for /api/analytics
  let signalsCache = null, signalsVer = 0, signalsSig = "";         // ETag version for /api/signals
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
      ? await fetchCandles(coin, "1d", now - 40 * DAY, now, MAIN_DAILY_WEIGHT)
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
      hi30: sig(f.hi30, 9), lo30: sig(f.lo30, 9), volBase: rnd(f.volBase, 0),
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

  function buildSnapshot() {
    sampleRegime();
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
      return {
        fundPct,
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
      if (dr && dr.length) daily[r.coin] = dr.slice(-MAIN_HIST_DAYS - 2);
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
  const R_UNIT_EVS = new Set(["bigmove", "breakout", "breakdown", "fundflip", "volshift", "oiflush", "fpdiv"]);
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
    if (Array.isArray(d.closed)) ledgerClosed = d.closed.slice(-4000);
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
  function getLedgerFor(coin) {
    if (!coin) return { coin: "", ticker: "", open: [], closed: [], ts: Date.now() };
    const pub = (e, status) => ({
      ev: e.ev, label: EV_LABEL[e.ev] || e.ev, t0: e.t0,
      tR: status === "resolved" ? (e.tR || null) : null, status,
      side: e.psd || (e.dir >= 0 ? "long" : "short"),
      score0: Number.isFinite(e.score0) ? e.score0 : null,
      mark0: e.mark0 != null && isFinite(e.mark0) ? e.mark0 : null,
      mv: e.mv != null ? e.mv : null,
      pr: e.pr === true, conf: e.conf === true, boot: e.bt === 1,
      claimMed: e.claim && Number.isFinite(e.claim.med) ? e.claim.med : null,
      realized: status === "resolved" && Number.isFinite(e.realized) ? e.realized : null,
      realizedS: status === "resolved" && e.realizedS != null && isFinite(e.realizedS) ? e.realizedS : null,
      stopped: e.stopped === true,
      win: status === "resolved" && Number.isFinite(e.realized) ? e.realized > 0 : null,
      unit: R_LEDGER_EVS.has(e.ev) ? (e.sd0 > 0 ? "R" : "%") : unitOf(e.ev),
      legacy: R_LEDGER_EVS.has(e.ev) && !(e.sd0 > 0),   // pre-sigma-epoch: excluded from aggregates, shown here labeled
      resolveAt: status === "open" ? e.resolveAt : undefined,
    });
    let ticker = coin;
    const open = [], closed = [];
    for (const e of ledgerOpen.values())
      if (e.coin === coin && e.vi == null) { open.push(pub(e, "open")); ticker = e.ticker || ticker; }
    for (const e of ledgerClosed)
      if (e.coin === coin && e.vi == null) { closed.push(pub(e, e.status === "void" ? "void" : "resolved")); ticker = e.ticker || ticker; }
    const r = rows.get(coin); if (r && r.ticker) ticker = r.ticker;
    open.sort((a, b) => b.t0 - a.t0);
    closed.sort((a, b) => (b.tR || b.t0) - (a.tR || a.t0));
    return { coin, ticker, open, closed: closed.slice(0, 150), ts: Date.now() };
  }
  function resolveAtFor(ev, t0) {
    if (ev === "gap") {   // resolves at the close of the next cash session after firing
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
      vi != null ? { vi } : null, mv != null ? { mv } : null, stp != null ? { stp } : null, psd ? { psd } : null, extra || {});
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
          realized = +((e.dir >= 0 ? 1 : -1) * (p1 / p0 - 1) * 100).toFixed(2);
          // stop-aware parallel track: if the void level was touched before horizon, the claim's
          // stop-disciplined outcome is the (dir-signed) stop distance instead of the at-horizon
          // move. Same units as `realized`. Claims without a stop keep realizedS === realized.
          if (e.vi == null && e.stp != null) {
            // The touch side follows where the stop SITS relative to entry, not e.dir: a proven
            // gap-FADER's void lies in the continuation direction (above entry on an up-gap,
            // dir=+1) — keying on e.dir would call the stop "touched" on the first candle.
            const below = e.stp < (e.mark0 || p0);
            const touched = stopTouched(hs, e.t0, e.resolveAt, below ? 1 : -1, e.stp);
            if (touched === true) { e.stopped = true; e.realizedS = +((e.dir >= 0 ? 1 : -1) * (e.stp / p0 - 1) * 100).toFixed(2); }
            else if (touched === false) { e.stopped = false; e.realizedS = realized; }
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
    if (ledgerClosed.length > 4000) ledgerClosed = ledgerClosed.slice(-4000);
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
  const R_LEDGER_EVS = new Set(["bigmove", "breakout", "breakdown", "fundflip", "oiflush", "fpdiv"]);
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
          if (gz >= incVal("gap")) {
            const exc = gBench != null && r.coin !== benchCoin ? g - gBench : null;
            const evd = evidence(st.gap.session, "gap", pooledFor(ac, "gap", "session"), "%");
            const reading = `${g >= 0 ? "+" : ""}${g.toFixed(2)}% since the last close (${(Math.abs(g) / st.gap.sd).toFixed(1)}\u03c3 of its gaps)`
              + (exc != null ? ` \u00b7 S&P ${gBench >= 0 ? "+" : ""}${gBench.toFixed(2)}%, excess ${exc >= 0 ? "+" : ""}${exc.toFixed(2)}%` : "");
            const sig = mkSignal(r, "gap", reading,
              (Math.abs(g) / st.gap.sd) * 14 + (exc != null ? Math.min(16, Math.abs(exc) / st.gap.sd * 12) : 0),
              evd, { horizon: EV_META.gap.horizon });
            sig.play = playbook("gap", { px: r.px, closePx: pc, gapDir: g >= 0 ? 1 : -1, gapSd: st.gap.sd, med: sig.study ? sig.study.med : null, n: sig.study ? sig.study.n : 0 });
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
          sig.play = playbook("fundflip", { dir: s0 });
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
      if (bs && bs.hit >= 0.6 && bs.avg > 0 && !g.noedge && !g.negexp && (g.rr == null || g.rr >= 1.2)) { g.prime = true; g.score += 6; }
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
    const top = kept.slice(0, 40);
    const sig = top.length + "|" + top.map((g) => g.coin + g.ev + g.score).join(",");
    if (sig !== signalsSig) { signalsSig = sig; signalsVer = Date.now(); }
    for (const k of rearm) if (!firedNow.has(k)) rearm.delete(k);   // condition lapsed -> episode over, key re-armed
    const variants = Object.keys(VARIANTS).map((ev) => ({
      ev, param: VARIANTS[ev].param, unit: unitOf(ev), cur: incVal(ev),
      vals: VARIANTS[ev].vals.map((v, vi) => Object.assign({ v, inc: vi === variantState[ev].inc },
        (variantStats[ev] && variantStats[ev][vi]) || { n: 0, hit: null, avg: null })),
      hist: variantState[ev].hist.slice(-3),
    }));
    const rs0 = recordSets && recordSets["0"];
    signalsCache = { ts: now, dataTs: signalsVer, count: top.length, signals: top,
      record: recordCache || {}, confluence: confCache || null, recordX: recordXCache,
      records: recordSets, variants, recent: rs0 ? rs0.recent : [] };
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
    setInterval(safeTick(buildAnalytics, "buildAnalytics"), ANALYTICS_MS);
    setInterval(() => store.flush(), 30 * 1000);
    setInterval(persistFeatures, 120 * 1000);
    setInterval(persistHourly, HOURLY_PERSIST_MS);
    setTimeout(persistHourly, 90 * 1000);   // early snapshot so even a quick redeploy keeps the spine warm
    setInterval(maintenance, 24 * 3600 * 1000);
    setTimeout(maintenance, 60 * 1000);
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

  return {
    start,
    getSnapshot: () => snapshotCache,
    getDaily: () => dailyCache,
    getAnalytics: () => analyticsCache,
    getSeries,
    getHourly,
    getFunding,
    getCandles,
    getSignals: () => signalsCache,
    getLedgerFor,
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
        rate: limiterUsage(),
        ws: sock ? Object.assign(sock.status(), { applied: wsApplied }) : { enabled: false },
      };
    },
  };
}

module.exports = { createPoller };
