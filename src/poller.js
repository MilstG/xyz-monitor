"use strict";
// Owns all Hyperliquid I/O. Polls the universe, backfills candle history, samples OI,
// and maintains two cached payloads (/api/snapshot and /api/daily) that clients read.
const { fetchMetaAndCtxs, fetchCandles, fetchFundingHistory, sleep } = require("./hyperliquid");
const { featuresFromHourly, oiDeltaPct, fundingAvg, meanPairwiseCorr,
  cashAnchors, overnightAnchors, weekendAnchors, runHolds, sessionComposite, activityClock, dowClock,
  pca2, hourReturnMeans, pearson } = require("./compute");
const { classify } = require("./sectors");

const HOUR = 3600 * 1000, DAY = 86400 * 1000;
const TF = { h1: HOUR, h4: 4 * HOUR, d1: DAY, d7: 7 * DAY, d30: 30 * DAY };
const SP_ALIASES = ["SPX", "SPX500", "SP500", "US500", "USSPX500", "SP500USD", "SPXUSD", "GSPC", "SP", "US500USD"];

const OI_MIN_GAP = 4.5 * 60 * 1000;   // store at most one OI sample per ~5 min
const OI_RETENTION = 31 * DAY;        // keep 31 days of OI history
const HOURLY_STALE = 10 * 60 * 1000;  // refresh hourly features every 10 min
const HOURLY_HISTORY_DAYS = 60;       // rolling hourly-OHLCV window retained for time-of-day / session analytics
const HOURLY_FEAT_DAYS = 31;          // window actually fed to featuresFromHourly (keep features identical to before)
const HOURLY_FETCH_WEIGHT = 50;       // rate-limit weight for the wider hourly candle pull
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

function createPoller({ dex, store, log }) {
  const rows = new Map();          // coin -> row
  const hist = store.loadAll(Date.now() - OI_RETENTION); // coin -> [[ts, oi], ...]
  let order = [];
  let benchCoin = null;
  let snapshotCache = null, dailyCache = null, lastPoll = 0;
  let dailyVer = 0, dailySig = "";   // ETag version for /api/daily — bumps only when daily content changes
  let analyticsCache = null, analyticsVer = 0, analyticsSig = "";   // ETag version for /api/analytics
  const regimeHist = store.loadRegime(Date.now() - REGIME_RETENTION);   // [[ts, corr], ...]
  let curCorr = null, curCorrPct = null, curCorrN = 0, lastRegimeSample = 0;
  log(`Loaded ${regimeHist.length} regime-correlation sample(s)`);
  const inflight = new Set();
  // fundingHistory-endpoint support is unknown until probed against this dex; forward-fill + the
  // oi.log seed guarantee >=~31d of funding regardless, so this only gates the 60d backfill.
  let fundingHistoryEnabled = true, fundProbeTries = 0, fundProbeOk = 0;

  log(`Loaded persisted OI history for ${hist.size} market(s)`);

  function getRow(coin) {
    let r = rows.get(coin);
    if (!r) {
      r = {
        coin, ticker: coin.includes(":") ? coin.split(":")[1] : coin,
        px: null, prevDay: null, funding: null, vol: null, oi: null, oiBase: null, oracle: null, d1: null,
        ref: null, feat: null, dailyRaw: null, hourlyRaw: null, fundH: new Map(), fundBackfilled: false,
        hourlyTs: 0, dailyTs: 0, isNew: true, delisted: false,
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
      if (!existed) { newCount++; log("NEW market detected: " + coin + " — queued for history backfill"); }
      r.delisted = !!u.isDelisted;
      const px = num(ctx.markPx) ?? num(ctx.midPx) ?? num(ctx.oraclePx);
      if (px != null) r.px = px;
      const pd = num(ctx.prevDayPx); if (pd != null) r.prevDay = pd;
      const fn = num(ctx.funding); if (fn != null) { r.funding = fn; r.fundH.set(hourNow, fn); }  // forward-fill the current hour
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
    // Pull the wider spine window in one call; retain it raw for time-of-day / session / boundary analytics.
    const c = await fetchCandles(coin, "1h", now - HOURLY_HISTORY_DAYS * DAY, now, HOURLY_FETCH_WEIGHT);
    r.hourlyRaw = Array.isArray(c) ? c : null;
    // Features are computed from ONLY the last 31 days so hi30/lo30, volH and volD are byte-identical
    // to the previous 31d fetch — the wider window must not leak into the feature math.
    const cut = now - HOURLY_FEAT_DAYS * DAY;
    const featWin = Array.isArray(c) ? c.filter((k) => k.t >= cut) : [];
    const { ref, feat } = featuresFromHourly(featWin, now, HOUR, DAY);
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

  // Best-effort 60d hourly-funding backfill via fundingHistory. HIP-3 dex support is uncertain, so:
  // per-coin backoff on failure, and if the first FUNDING_PROBE_MIN highest-volume markets all come
  // back empty we conclude the endpoint isn't available here and stop (forward-fill + oi.log seed remain).
  async function backfillFunding(coin) {
    const r = rows.get(coin); if (!r) return 0;
    const now = Date.now();
    const data = await fetchFundingHistory(coin, now - FUNDING_HISTORY_DAYS * DAY, now, FUNDING_FETCH_WEIGHT);
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

  // Return seasonality by ET hour (EXPLORATORY / quarantined). Each equity contributes one mean
  // intra-hour return per hour; we run a cross-sectional t-test per hour (ticker = one observation,
  // avoiding candle pseudo-replication) so the client can grey out the noise and only highlight
  // hours that clear |t| >= 2. Never a standalone trade signal — the payload is significance-flagged.
  const SEASON_MIN = 8;
  function buildSeasonality() {
    const eq = activeMarkets().filter((r) =>
      !r.delisted && classifyCached(r.ticker).assetClass === "Equity" &&
      Array.isArray(r.hourlyRaw) && r.hourlyRaw.length >= CLOCK_MIN_SPINE);
    if (eq.length < SEASON_MIN) return { pending: true, count: eq.length, need: SEASON_MIN };
    const perHour = Array.from({ length: 24 }, () => []);
    for (const r of eq) { const { ret } = hourReturnMeans(getHourly(r.coin)); for (let h = 0; h < 24; h++) if (Number.isFinite(ret[h])) perHour[h].push(ret[h]); }
    const hours = [];
    for (let h = 0; h < 24; h++) {
      const a = perHour[h], n = a.length;
      if (n < 3) { hours.push({ h, mean: null, se: null, t: null, n }); continue; }
      const mean = a.reduce((s, x) => s + x, 0) / n;
      let v = 0; for (const x of a) v += (x - mean) * (x - mean);
      const sd = Math.sqrt(v / (n - 1)), se = sd / Math.sqrt(n);
      hours.push({ h, mean: +mean.toFixed(6), se: +se.toFixed(6), t: se > 0 ? +(mean / se).toFixed(2) : 0, n });
    }
    return { equityCount: eq.length, hours, sigCount: hours.filter((x) => x.t != null && Math.abs(x.t) >= 2).length };
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
      const n = await store.prune(Date.now() - OI_RETENTION);
      if (n) log(`Pruned ${n} OI sample(s) older than 31d`);
    } catch (e) { log("prune failed: " + (e && e.message)); }
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
    const restoredHourly = hydrateHourly();
    if (restoredHourly) log(`Restored hourly spine for ${restoredHourly} market(s) — session analytics warm`);
    await pollUniverse();
    seedFundingFromOI();
    buildSnapshot(); buildDaily(); buildAnalytics();
    setInterval(pollUniverse, UNIVERSE_MS);
    hourlyWorker(); hourlyWorker();
    dailyWorker(); dailyWorker();
    fundingWorker();
    setInterval(buildSnapshot, 15 * 1000);
    setInterval(buildDaily, 60 * 1000);
    setInterval(buildAnalytics, ANALYTICS_MS);
    setInterval(() => store.flush(), 30 * 1000);
    setInterval(persistFeatures, 120 * 1000);
    setInterval(persistHourly, HOURLY_PERSIST_MS);
    setTimeout(persistHourly, 90 * 1000);   // early snapshot so even a quick redeploy keeps the spine warm
    setInterval(maintenance, 24 * 3600 * 1000);
    setTimeout(maintenance, 60 * 1000);
  }

  return {
    start,
    getSnapshot: () => snapshotCache,
    getDaily: () => dailyCache,
    getAnalytics: () => analyticsCache,
    getSeries,
    getHourly,
    getFunding,
    persistFeatures,
    stats: () => ({ markets: rows.size, bench: benchCoin, oiCoins: hist.size, hourly: hourlyCoverage(), funding: fundingCoverage(), lastPoll }),
  };
}

module.exports = { createPoller };
