"use strict";
// Owns all Hyperliquid I/O. Polls the universe, backfills candle history, samples OI,
// and maintains two cached payloads (/api/snapshot and /api/daily) that clients read.
const { fetchMetaAndCtxs, fetchCandles, fetchFundingHistory, sleep, limiterUsage, createUniverseSocket, createCoinalyze } = require("./hyperliquid");
const { czMergeHistory, cascadeFlags, derivRollup, aggDerivHourly } = require("./compute");
const { claimGeometryOk, clusterDays, evMeta, capPerUniverse, detectCascExhaust, latestCascade, tradeableNow } = require("./compute");
const { sectorAuditDecide, mergeSectorAudit, sectorAuditDue } = require("./compute");
const { FEATURES, FEATURE_STATES, featureFlagsSanitize, featureState, resolveFeatures, featureCounts, featureSettable, featureScopeVis, coinScope, scopeFilterSignals, scopeFilterActionable, scopeEventVisible, epLatSplit } = require("./compute");
const { validateBasket, basketCloses, ratioCloses, emaSeries, BASKET_FLOOR, BASKET_MIN_MEMBERS, BASKET_MAX_MEMBERS, BASKET_MAX_CUSTOM } = require("./compute");
const { MACRO_RELEASES, parseFredReleases, parseFredReleasesDates, fredObsSeries, yoyPct, momPct, momDelta, lastObs, macroExpectedObsMonth, buildMacroEntries, macroEntryState, macroWithin, etParts, macroStatText, FOMC_DECISIONS,
  briefMovers, briefRankGroups, briefBreadth, renderBrief, validateBriefProse, validateBriefSections, briefVisibleLen, BRIEF_GROUP_MIN, earnPrintRow, SCHED_KINDS, schedNormDays, schedResolve, schedDueAt, schedDaysLabel, validateLandProse, renderLandscape, briefSalvageProse } = require("./compute");
const {
  studyBigMove, studyBreakout, studyBreakdown, studyVolShift, studyGapFade, studyFundFlip, confSplit, studyOIFlush, studyFPDiv, compressionNow, offDriftStats, retStd, dailyRets, intrabarCross, stdev, stopGeometryOk, fadeStats,
  EV_META, playbook, marketSessions, summarizeEvents, shouldPromote, stopTouched, bracketTouch, volumeProfile, levelMap, detectMAPull, detectReclaim, detectFailBrk, detectPead, detectSweep, detectSwingPull, detectBaseBreak, detectEmaBreak, detectEmaRetest, regime200, nearestLevelBelow, structVoid, detectLvlTouch, vpTouchNodes, detectVpTouch, detectLevels, levelOutcomes, levelStudy, sessionRecords, anatomyEnrich, mondayStats, nakedStats, anatomyPool, detectWickFill, detectRoundFront, candleEvents, candlePool, pivotPool, anatomyTickerSummary,
} = require("./compute");
const { pxRingPush, pxRingRef, dipReclaim } = require("./compute");
const { focusSelect, focusGapSigma, focusLevelDist, firstHourStats, sessionCloseStats, FOCUS_CAP, FOCUS_PER_CLUSTER, focusPreview, focusDiff, FOCUS_PREVIEW_N, foldLiveMark,
  focusGate, focusLimits, FOCUS_HARD_VOL, FOCUS_HARD_OI, FOCUS_BELOW_N } = require("./compute");
const { featuresFromHourly, bucketOpens, oiDeltaPct, fundingAvg, meanPairwiseCorr, regimeAggregate,
  cashAnchors, overnightAnchors, weekendAnchors, utcDayAnchors, cryptoWeekendAnchors, runHolds, sessionComposite, activityClock, dowClock, priceAsOf,
  HOME_MKTS, homeCalCovered, homeCalHorizon, homeOvernightAnchors, homeWeekendAnchors, homeClosedWindows,
  pca2, hourReturnMeans, hourReturnStats, pearson,
  fourHourReturns, tapeRedStats, rvolMulti } = require("./compute");
const { pdfTextRuns, ptrRows, parsePtr } = require("./compute");
const { etDayStr, earnDayDiff, earnEntryState, parseEarningsCalendar, mergeEarnPrints, scrubPlaceholderActuals, earnReactionsFor, recentEarnPrints, earnChunks, purgeStalePrints, reconcileEarnPrints, mergeNews, newsRelevant, topicHit, parseTgPreview, attributeTg, parseEdgarAtom, linkEarningsFilings, pickXbrlFacts, parseNportHoldings } = require("./compute");
const { bucketCandles, trendLadder, trendRead, withFormingDaily, stackedRun, TREND_TFS, ribbonWidth, TREND_TF_MS, median, corrMatrix } = require("./compute");
const { closedBars, closedLadder, emaLast, emaCrossOutcomes, emaCrossStudy, emaAlertState } = require("./compute");
const { momPair, spearmanIC, duelStats, epResolve, epScore } = require("./compute");
const { hourlyPickTier, hourlyPickBetter } = require("./compute");
const { parse13FInfotable, whaleBook, whaleDelta, whaleNameKey, whaleIssuerKey, whaleWindow, whaleQOfPeriod, whaleSeason, whale13FScale } = require("./compute");
const { PTR_TICKERABLE, PTR_NO_TICKER } = require("./compute");
const { NAV_VIEW_ORDER, navGroupKeys, navLabelClean, navConfigSanitize, resolveNavGroups } = require("./compute");
const { carryR, netRR, setupEV, barsInTrigger, mergeActionable, ACT_TF_MS, lateR, trigKey, trigEligible, pushEligible, pushFmt, pushBatch, pushCodeOk, pushCodeNorm, levelHit, PUSH_CLASSES, PUSH_DEFAULT_CLASSES, PUSH_ADMIN_CLASSES, PUSH_CODE_ALPHABET, inQuietWindow, quietEndsAt, piercesQuiet, validateQuiet,
  RULE_METRICS, RULE_BY_K, RULE_OPS, RULE_OP_LABEL, ruleEval, ruleLabel, ruleFmtValue, validateRule } = require("./compute");
const { classify, nameAliases, companyName, displayName, macroLane, setSectorOverlay, PREIPO, homeMkt, homeAdr } = require("./sectors");

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
const MAIN_HIST_DAYS = 31;            // crypto OI archive + funding-history window (storage-bounded)
const MAIN_SPINE_DAYS = 90;           // crypto HOURLY PRICE-spine window (-17): 90d so the session studies
                                      // (levels, anatomy, candle behaviour, clocks, decomposition) run at the
                                      // same depth the equity side does. Decoupled from MAIN_HIST_DAYS on
                                      // purpose — the OI 5-min archive and funding stay 31d (storage cost);
                                      // only the price candles deepen. HL backfills the whole window in one
                                      // candleSnapshot call, so it fills on the first refresh after deploy.
const MAIN_DAILY_DAYS = 370;          // crypto DAILY-candle RETENTION (-20: was 92): 370d so MA200, the
                                      // structural-level detector and the swing-horizon shadows run at the
                                      // same daily depth the equity side does. Hyperliquid serves ~5000
                                      // candles per snapshot, so the deeper window is STILL one call and
                                      // fills on the first refresh cycle after deploy. Hourly stays 31d.
const MAIN_DAILY_PAYLOAD = 92;        // crypto DAILY bars ON THE WIRE (/api/daily): the drawer sparkline and
                                      // AI chart read 90d — retention deepened for the detectors, not to
                                      // quadruple every client's payload. Server-side consumers read the
                                      // full dailyRaw depth directly.
const MAIN_HOURLY_WEIGHT = 35;        // 90d spine pull (-17): one candleSnapshot, same request weight
const MAIN_DAILY_WEIGHT = 8;          // 370d daily pull (same request weight — one candleSnapshot either way)
const HOURLY_TAIL_WEIGHT = 20;        // steady-state refresh only pulls the last ~48h and merges — cheaper than the old full-window re-pull
// ---- Coinalyze derivatives context (crypto universe only) -------------------------------------
// Aggregated CEX liquidations + OI as CONTEXT for the Hyperliquid names — a different venue
// population than our book, permanently labeled as such in every payload. External dependency is
// data-only (env COINALYZE_API_KEY, no package) and fully degradable: key missing -> the lane
// never starts and payloads say so; fetch failing -> last-known-with-timestamp, staleness shown.
const CZ_SWEEP_MS = 15 * 60 * 1000;   // full-roster sweep cadence
const CZ_INTERVAL = "15min";          // fetch granularity; raw 15-min feeds the cascade math,
const CZ_BUCKET = 15 * 60 * 1000;     // the drawer chart reads the hourly aggregation
const CZ_SEED_MS = 14 * DAY;          // first-pull window (Coinalyze intraday retention is ~15-20d at 15min)
const CZ_RETENTION = 92 * DAY;        // OUR accumulated history (they delete theirs daily — this log is the baseline)
const CZ_REFRESH_CD = 60 * 1000;      // manual per-ticker refresh cooldown, server-enforced, shared across the group
const CZ_BATCH = 20;                  // symbols per batched request (their max)
const CZ_VENUES = ["Binance", "Bybit", "OKX"];   // deterministic single-venue preference per base asset
const CZ_QUOTES = new Set(["USDT", "USD", "USDC"]);
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
// ---- short-horizon mark-price ring (5m / 15m screener columns, build 2026.07.29-04) -----------
// Memory-only [t, px] ring per market, sampled on buildSnapshot's 15s cadence from the SAME live
// mark the row ships — one code path, zero new fetch lanes, zero disk. See compute.pxRingPush /
// pxRingRef for the honesty contract (strictly-increasing ring, tolerance-gated lookback).
const PX_RING_DEPTH_MS = 20 * 60 * 1000;   // 15m lookback + tolerance + slack; ~80 samples/market
const PX_RING_TOL_MS = 90 * 1000;          // max gap between the lookback target and its nearest sample — wider dashes
// ---- 5-minute OHLCV archive (build-forward, on-disk via node:sqlite) --------------------------
const FIVE_MIN = 5 * 60 * 1000;
const M5_RETENTION_DAYS = 370;        // rolling 5m archive; 370 (not 365) buys a few days of slack so a "1y" chart is never short
const M5_SEED_DAYS = 17;              // native candleSnapshot window at 5m (5000 * 5min ~= 17.36d) — the most one pull can return
const M5_STALE = 5 * 60 * 1000;       // capture each market's freshly CLOSED 5m bars about once per bar
const M5_FETCH_WEIGHT = 20;           // rate-limit weight per 5m tail pull (steady state returns only the last few bars)
const M5_SNAPSHOT_MS = 24 * 3600 * 1000;   // VACUUM-INTO off-copy of the archive once a day (it's the sole copy past the native window)
// ---- deep-history 12h/1d archive (build 2026.08.21-01) ---------------------------------------
// The native 5000-bar candleSnapshot window is ~2.3y at 4h, ~6.8y at 12h and ~13.7y at 1d, so unlike the 5m
// lane these tables seed BACKWARD to each listing's birth in ONE pull per market per interval,
// then capture forward on the same closed-bar guard. Feeds the CHARTS tab's 12H/1D panes only —
// the trend ladder's D1/H12 stay on their own frozen construction (withFormingDaily / spine
// buckets); on overlap the bars are the same exchange prints, but nothing re-derives across
// sources. Bars land on HL's own UTC grid, verbatim — no local re-anchoring: a daily bar on a
// 24/7 perp IS a UTC day, and re-cutting it here would invent a series the exchange never printed.
const DEEP_IVS = { "4h": 4 * HOUR, "12h": 12 * HOUR, "1d": 24 * HOUR };   // 4h joined -03: ~2.3y native window; the CHARTS 4H pane needs EMA200 depth the 20d intraday base cannot hold
const DEEP_STALE = 4 * HOUR;          // tail-pull cadence per (market, interval): a few closed bars/day exist at most
const DEEP_SEED_BARS = 4900;          // just under the native 5000-bar cap — the seed pull asks for everything servable
const DEEP_SEED_WEIGHT = 60;          // one-time cold pull per (market, interval): up to ~5000 bars in one response
const DEEP_TAIL_WEIGHT = 15;          // steady state returns a handful of bars
const SWEEP_LOOK_MS = 4 * HOUR;            // 5m tail scanned for a prior-session-level stop-run (~48 bars; detector needs >=12)
const RECLAIM_MIN_DIP_PCT = 0.35;          // min peak→trough depth (% of peak) before a dip-reclaim claim exists — below it the "dip" is xyz bar noise. Rides the sweep tail; crypto would need its own (much higher) floor when it gets a lane.
const SWEEP_FRAC = 0.25;                   // min wick pierce past the swept level, as a fraction of the window's median 5m range
const WICK_FRAC = 0.55;                    // min wick share of the bar's range for a fill claim (dominant wick, not a doji tail)
const WICK_SIZE_MULT = 1.1;                // the wick bar's range vs its own trailing-30 median — a real bar, not noise
const RNDF_LO_BAND = 0.05, RNDF_HI_BAND = 0.6;   // round-figure approach band, x the name's own sd30
// ---- crypto-native ledger events (build 2026.07.26-08) ---------------------------------------
const CASC_LOOK_MS = 24 * HOUR;            // how far back a liquidation cascade still counts as the operative structure
const FUNDEXT_HI = 90, FUNDEXT_LO = 10;    // funding percentile (own 31d) that counts as a crowded side
const FUNDEXT_HOURS = 24;                  // window the extreme's side must hold across — this is what makes it an EPISODE
const FUNDEXT_MIN_SAMPLES = 8;             // ...and the minimum hourly samples inside it before the claim is allowed to open
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
// Fundamentals (Finnhub basic financials + profile2) reuse the earnings gate AND its US-symbol
// aliasing — same "which names are real US equities" question. Rotation is deliberately slow:
// these numbers move quarterly, so each name re-fetches at most ~daily, a few per minute inside
// the shared 60/min Finnhub budget (news + earnings + this).
const FUND_ALIAS = EARN_ALIAS;
const FUND_BATCH = 3;              // tickers per 60s tick (2 calls each: metric + profile2)
const FUND_TTL = 22 * HOUR;        // a name is "due" only once its cache is this stale
// Signals whose claim spans a session boundary (drift, gap, breakout follow-through): an earnings
// print inside the horizon is a different return distribution than the study sample, so the
// evidence contribution is capped — same mechanism and same cap as the no-live-edge guard.
const EARN_GUARD = new Set(["breakout", "breakdown", "gap", "ondrift"]);
// Macro calendar (FOMC + FRED). Same degradation contract as earnings: env FRED_KEY, data-only,
// no package; unset key = macro rows absent with the reason on the payload, earnings untouched.
// The FOMC table needs no key and always serves. Refresh rides the earnings cadence (6h + 30min
// staleness retry), PLUS a refire when a release instant passed since the last good fetch — so
// an 8:30 print's actual lands on the tab within the half hour instead of waiting out the 6h.
const MACRO_STALE = EARN_STALE, MACRO_RETRY_MS = EARN_RETRY_MS;
function num(x) { const v = typeof x === "number" ? x : parseFloat(x); return Number.isFinite(v) ? v : null; }
// Payload-trim helpers: the snapshot ships hundreds of derived floats per market at full
// double precision (17 digits) — quantizing to what the UI can actually display cuts the
// JSON 30-50% without changing a single rendered pixel. `rnd` = fixed decimals (for %
// values), `sig` = significant digits (for prices, which span 6 orders of magnitude).
function rnd(x, dp) { return Number.isFinite(x) ? +x.toFixed(dp) : null; }
function sig(x, n) { return Number.isFinite(x) ? (x === 0 ? 0 : +x.toPrecision(n)) : null; }
const sigq = sig;   // alias for scopes that shadow `sig` locally (buildDaily declares its content-signature as `sig`)

function createPoller({ dex, store, log, version, crypto, aiFetch: aiFetchOpt, pushFetch: pushFetchOpt, extFetch: extFetchOpt, t13fCap: t13fCapOpt, congressGap: congressGapOpt }) {
  const rows = new Map();          // coin -> row
  const hist = store.loadAll(Date.now() - OI_RETENTION); // coin -> [[ts, oi], ...]
  let order = [];
  let benchCoin = null;
  let mainOrder = [], mainList = [], mainSel = new Set(), mainDay = 0;   // main-dex universe order / today's selection
  let snapshotCache = null, dailyCache = null, lastPoll = 0;
  // Full-depth crypto daily tuples for the SIGNAL LOOP (-28). The -20 wire cap
  // (MAIN_DAILY_PAYLOAD) was applied to dc.daily — which is also what the signals pass reads —
  // so every crypto detector needing more than ~92 closes (swpull's MA50 at 120, regime200 at
  // 210, the -28 EMA200 shadows at 216) was silently starved while the 370d retention sat
  // unread. Two consumers, two maps: the wire keeps its cap, the loop reads this one.
  const deepDaily = new Map();
  let snapVer = 0, lastSnapSig = "";   // /api/snapshot content clock: dataTs bumps only when a client-visible field changes (kept off the payload)
  let dailyVer = 0, dailySig = "";   // ETag version for /api/daily — bumps only when daily content changes
  let analyticsCache = null, analyticsVer = 0, analyticsSig = "";   // ETag version for /api/analytics (xyz)
  let analyticsCryptoCache = null, analyticsCryptoVer = 0, analyticsCryptoSig = "";   // ETag version for /api/analytics?u=crypto (-17)
  // Last build error per universe + a lazy-build cooldown. The sessions tab used to show a bare
  // "warming up the spines" whenever the cache was empty, which is indistinguishable from a build
  // that is failing every cycle — the reason the -17 breakage was invisible. Now the failure reason
  // is recorded and served, and the route can build on demand if the cache never populated.
  let analyticsErrMsg = "", analyticsCryptoErrMsg = "";
  let analyticsLazyTs = 0, analyticsCryptoLazyTs = 0;
  const ANALYTICS_LAZY_CD = 20 * 1000;   // at most one on-demand build attempt per universe per 20s
  // ---- tick instrumentation + the serialized build chain (build 2026.07.29-08, perf phase 3) ----
  // Phase 0 gave the event loop a histogram; this gives the histogram NAMES. Every scheduled tick
  // runs through timedTick, which records how long it ran and logs offenders — so "max 2573ms" on
  // the Loop dot stops being a mystery and becomes "buildAnalytics:crypto 2541ms". The worst
  // offenders ship on /api/health (stats().ticks) and surface in the tray tooltip.
  // Two honesty notes baked into the numbers: a SYNC tick's duration IS event-loop hold, so it
  // slow-logs at 250ms; an ASYNC (yielding) build's duration is wall time across its yields — it
  // holds the loop only in slices, so its floor is higher (a runaway build, not a stall).
  const SLOW_TICK_SYNC_MS = 250, SLOW_TICK_ASYNC_MS = 8000, TICK_TOP = 8;
  const tickStats = new Map();   // name -> { n, last, lastAt, worst, worstAt, slow, async }
  function tickRecord(name, ms, isAsync) {
    let s = tickStats.get(name);
    if (!s) { s = { n: 0, last: 0, lastAt: 0, worst: 0, worstAt: 0, slow: 0, async: !!isAsync }; tickStats.set(name, s); }
    s.n++; s.last = ms; s.lastAt = Date.now(); s.async = !!isAsync;
    if (ms > s.worst) { s.worst = ms; s.worstAt = s.lastAt; }
    if (ms >= (isAsync ? SLOW_TICK_ASYNC_MS : SLOW_TICK_SYNC_MS)) { s.slow++; log(`slow tick: ${name} ${isAsync ? "ran" : "held the loop"} ${ms}ms`); }
  }
  function timedTick(name, fn) {
    const t0 = Date.now();
    try {
      const r = fn();
      if (r && typeof r.then === "function")
        return r.then((v) => { tickRecord(name, Date.now() - t0, true); return v; },
          (e) => { tickRecord(name, Date.now() - t0, true); throw e; });
      tickRecord(name, Date.now() - t0, false);
      return r;
    } catch (e) { tickRecord(name, Date.now() - t0, false); throw e; }
  }
  const isAsyncFn = (fn) => fn && fn.constructor && fn.constructor.name === "AsyncFunction";
  // Cooperative yield for the heavy builds: hand the event loop back every few markets/sections so
  // HTTP responses, WS frames and timers interleave with a build instead of queueing behind it for
  // seconds. The math is untouched — only the pacing changes. But builds that yield can INTERLEAVE,
  // which synchronous execution used to forbid for free: buildSignals mutates the ledger mid-pass
  // and buildActionable reads it, so an interleaving would read a half-updated ledger. Every
  // yielding build therefore runs on ONE serialized promise chain — chainBuild — which restores
  // exactly the old mutual exclusion and doubles as the in-flight guard (a tick firing while its
  // own previous build still runs queues behind it rather than overlapping it). Prices sampled by a
  // yielding build can now move a second or two between the first market and the last; detectors
  // read the candle spines (append-only on the hour), so this widens nothing that matters.
  const buildYield = () => new Promise((r) => setImmediate(r));
  const BUILD_YIELD_EVERY = 12;   // markets between yields — a few ms of held loop per slice at current roster sizes
  let buildChain = Promise.resolve();
  function chainBuild(name, fn) {
    const run = () => timedTick(name, fn);
    const p = buildChain.then(run, run);
    // The chain itself must never carry a rejection forward (one failed build would poison every
    // later one), but the CALLER's handle keeps the rejection so safeTick can log it.
    buildChain = p.catch(() => {});
    return p;
  }
  let signalsCache = null, signalsVer = 0, signalsSig = "";         // ETag version for /api/signals
  let earnCache = null, earnVer = 0, earnSig = "", lastEarnOk = 0, earnErr = null;   // /api/earnings payload + freshness
  let trendCache = null, trendVer = 0, trendSig = "", trendBuilt = 0, trendByCoin = new Map();   // /api/trend — lazy, memoized, ETag rides content
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
        m5Ts: 0, m5LastTs: 0, m5Fail: 0, m5FailUntil: 0, m5SeededCursor: false,   // 5m archive capture cursor (see capture5m)
        pxRing: [],   // short-horizon mark samples ([t, px], memory-only) — the 5m/15m column source
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
  // Normalize any raw candle array into the packed numeric spine row shape [t,o,h,l,c,v]. Accepts
  // both the Hyperliquid REST object shape ({t,o,h,l,c,v} strings) and already-packed rows (disk /
  // re-normalization), so it's the one gate every hourlyRaw write passes through. o/h/l/v fall back
  // to the close / 0 — exactly the coercion the old getHourly conversion did, now applied ONCE at
  // write time instead of on every read.
  function packHours(arr) {
    const out = [];
    if (!Array.isArray(arr)) return out;
    for (const k of arr) {
      const isArr = Array.isArray(k);
      const t = +(isArr ? k[0] : k.t), cl = +(isArr ? k[4] : k.c);
      if (!Number.isFinite(t) || !Number.isFinite(cl)) continue;
      const o = +(isArr ? k[1] : k.o), h = +(isArr ? k[2] : k.h), l = +(isArr ? k[3] : k.l), v = +(isArr ? k[5] : k.v);
      out.push([t, Number.isFinite(o) ? o : cl, Number.isFinite(h) ? h : cl, Number.isFinite(l) ? l : cl, cl, Number.isFinite(v) ? v : 0]);
    }
    return out;
  }
  // Adapter back to the object shape [{t,o,h,l,c,v}] for the few remaining object-convention
  // consumers — featuresFromHourly and the H1 ladder rung / 1h chart serializer. Kept transient at
  // the call site and NEVER stored on a row, so the resident spine stays packed-only (the whole point
  // of the packed spine: r.hourlyRaw held both an object array and getHourly's packed copy before).
  function hoursToObj(arr) {
    return Array.isArray(arr) ? arr.map((k) => ({ t: k[0], o: k[1], h: k[2], l: k[3], c: k[4], v: k[5] })) : [];
  }
  // The hourly spine IS the packed normalized array now (see packHours), so getHourly is a direct
  // pass-through — no per-call rebuild, no second resident copy. Every array-indexed consumer
  // (priceAsOf, runHolds, rvolMulti, fourHourReturns, tape) reads r.hourlyRaw's rows as [t,o,h,l,c,v].
  function getHourly(coin) {
    const r = rows.get(coin);
    return r && Array.isArray(r.hourlyRaw) ? r.hourlyRaw : [];
  }
  function hourlyCoverage(U) {
    let coins = 0, candles = 0;
    const src = U ? U.roster() : [...rows.values()];
    for (const r of src) if (Array.isArray(r.hourlyRaw) && r.hourlyRaw.length) { coins++; candles += r.hourlyRaw.length; }
    return { coins, candles };
  }

  // UTC-aligned bucket aggregation of the hourly spine, memoized on the spine's ARRAY REFERENCE —
  // the same freshness contract getHourly uses (every spine mutation reassigns r.hourlyRaw, so
  // `r._bkRaw === c` can never serve a stale bucketing). buildTrend (every 3 min, both universes),
  // the /api/candles route (per request, no-store), the signals retest probe and the AI compiler
  // all aggregate the same ~750-candle spine to the same 4h/12h/24h widths on their own cadences;
  // each used to rebuild from scratch. The spine only changes on the ~10-min hourly refresh, so a
  // width is bucketed at most that often and every other caller reads the cached array. Consumers
  // (trendLadder, the candle serializer) read these arrays; none mutate them, so sharing is safe.
  function bucketsFor(r, width) {
    const c = r && r.hourlyRaw;
    if (!Array.isArray(c)) return [];
    if (r._bkRaw !== c) { r._bkRaw = c; r._bk = {}; }
    let out = r._bk[width];
    if (!out) { out = bucketCandles(c, width, HOUR); r._bk[width] = out; }
    return out;
  }

  // Per-market hourly funding-rate series: [[hourTs, rate], ...] oldest->newest, rolling FUNDING_HISTORY_DAYS.
  // Built from three sources (oi.log seed, live forward-fill, best-effort fundingHistory backfill) and
  // deduped by hour, so the boundary engine can integrate funding cost over any hold window.
  function getFunding(coin) {
    const r = rows.get(coin);
    if (!r || !r.fundH || !r.fundH.size) return [];
    // Memoize the sorted [t,rate] copy on this row's fund-mutation counter (bumped at every
    // r.fundH.set/delete/clear) plus the clock hour. buildDaily calls this per market every 60s and
    // the analytics + AI sites call it too; the underlying Map only changes when the row's funding is
    // written (each poll for active names, never for quiet ones), so the per-15s/60s re-sort was pure
    // waste. The hour key bounds the trailing-window drift to <=1h for names that stop updating.
    const hourKey = Math.floor(Date.now() / HOUR);
    if (r._fgVer === r._fVer && r._fgH === hourKey && r._fg) return r._fg;
    const cut = Date.now() - FUNDING_HISTORY_DAYS * DAY, out = [];
    for (const [t, rate] of r.fundH) if (t >= cut && Number.isFinite(rate)) out.push([t, rate]);
    out.sort((a, b) => a[0] - b[0]);
    r._fgVer = r._fVer; r._fgH = hourKey; r._fg = out;
    return out;
  }
  function fundingCoverage(U) {
    let coins = 0, points = 0;
    const src = U ? U.roster() : [...rows.values()];
    for (const r of src) if (r.fundH && r.fundH.size) { coins++; points += r.fundH.size; }
    return { coins, points, endpoint: fundingHistoryEnabled ? "on" : "off(sampled)" };
  }
  // Seed the hourly funding series from persisted oi.log samples (one value per hour) so we start with
  // ~31d of funding history immediately, independent of whether fundingHistory works for this dex.
  function seedFundingFromOI() {
    let seeded = 0;
    for (const [coin, h] of hist) {
      const r = rows.get(coin); if (!r) continue;
      for (const s of h) { const t = s[0], f = s[2]; if (f != null && Number.isFinite(f)) { r.fundH.set(Math.floor(t / HOUR) * HOUR, f); } }
      r._fVer = (r._fVer || 0) + 1;   // invalidate this row's getFunding memo
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

  // ===== Score duel: MOM vs MOM+ on daily forward rank IC (build 2026.07.24-07) ================
  // The adjudicator for the candidate momentum column. Once per UTC day the poller snapshots BOTH
  // scores for every name (canonical d1 basis — the duel is window-independent even though the
  // board follows the timeframe selector), and when the next day's snapshot lands it computes
  // per-scope Spearman rank IC of each score against the realized snapshot→snapshot return.
  // The verdict gate (n ≥ DUEL_MIN_N days, or |t| ≥ 2 on the paired ΔIC) lives server-side so
  // the panel can refuse to call a winner early — the anti-eyeball mechanism, same philosophy
  // as the backtest's IS/OOS split. State persists to the volume: an accruing out-of-sample
  // record must survive redeploys or it is not a record.
  const DUEL_RETENTION_D = 180, DUEL_MIN_N = 60, DUEL_MIN_NAMES = 8;
  let duel = { snaps: {}, ic: [] };
  let duelDirty = true, duelCache = null;
  function hydrateDuel() {
    try {
      const d = store.loadDuel();
      if (d && Array.isArray(d.ic)) duel = { snaps: d.snaps || {}, ic: d.ic };
    } catch (_) {}
  }
  function duelInputs(r) {
    const f = r.feat;
    if (!f || !(f.volH > 0) || r.px == null || !isFinite(r.px)) return null;
    const ref = r.ref || {};
    const pct = (p) => (p != null && isFinite(p) && p > 0) ? (r.px / p - 1) * 100 : null;
    const dw = computeDoi(r) || {}, fw = computeFundWin(r) || {};
    // funding percentile: same loop as the snapshot's fundPct — current rate vs the market's own
    // 31d hourly distribution, ≥96 samples before claiming one (an honest null beats a fake rank)
    let fundPct = null;
    try {
      if (r.funding != null && isFinite(r.funding) && r.fundH && r.fundH.size) {
        const cut = Date.now() - 31 * DAY;
        let n = 0, le = 0;
        for (const [t, rate] of r.fundH) { if (t < cut || !isFinite(rate)) continue; n++; if (rate <= r.funding) le++; }
        if (n >= 96) fundPct = Math.round((100 * le) / n);
      }
    } catch (_) {}
    const fh = (fw.d1 != null && isFinite(fw.d1)) ? fw.d1 : r.funding;   // window-avg funding, point-rate fallback
    return {
      h1: pct(ref.p1h), h4: pct(ref.p4h),
      d1: (r.d1 != null && isFinite(r.d1)) ? r.d1 : null,
      d7: pct(ref.p7d), d30: pct(ref.p30d),
      volH: f.volH, volD: f.volD, px: r.px, hi30: f.hi30, lo30: f.lo30,
      doi: (dw.d1 != null && isFinite(dw.d1)) ? dw.d1 : null,
      fundAPR: (fh != null && isFinite(fh)) ? fh * 24 * 365 * 100 : null,
      fundPct,
    };
  }
  function duelTick(nowMs, inject) {
    const now = nowMs || Date.now(), day = Math.floor(now / DAY);
    if (duel.snaps[day]) return;   // one snapshot per UTC day — cheap per-tick guard
    const snap = { xyz: {}, main: {} };
    const unis = inject || { xyz: activeMarkets(), main: crypto ? mainMarkets() : [] };
    for (const u of ["xyz", "main"]) {
      for (const r of unis[u] || []) {
        if (r.delisted) continue;
        let inp = null;
        try { inp = duelInputs(r); } catch (_) {}
        if (!inp) continue;
        const p = momPair(inp);
        if (p.mom == null || p.momp == null || !isFinite(p.mom) || !isFinite(p.momp)) continue;
        snap[u][r.coin] = [sig(p.mom, 6), sig(p.momp, 6), sig(r.px, 9)];
      }
    }
    // A near-empty snapshot (boot, features still hydrating) must NOT burn the day — retry next tick.
    if (Object.keys(snap.xyz).length + Object.keys(snap.main).length < DUEL_MIN_NAMES) return;
    duel.snaps[day] = snap;
    const prev = duel.snaps[day - 1];
    if (prev) {
      for (const u of ["xyz", "main"]) {
        const A = [], B = [], R = [];
        for (const coin in prev[u] || {}) {
          const p0 = prev[u][coin], p1 = snap[u] && snap[u][coin];
          if (!p1 || !(p0[2] > 0) || !(p1[2] > 0)) continue;
          A.push(p0[0]); B.push(p0[1]); R.push(p1[2] / p0[2] - 1);
        }
        if (A.length >= DUEL_MIN_NAMES) {
          const a = spearmanIC(A, R), b = spearmanIC(B, R);
          if (a != null && b != null) duel.ic.push({ d: day - 1, u, a: sig(a, 4), b: sig(b, 4), n: A.length });
        }
      }
    }
    for (const k of Object.keys(duel.snaps)) if (+k < day - 1) delete duel.snaps[k];   // only yesterday is ever needed again
    const cutD = day - DUEL_RETENTION_D;
    duel.ic = duel.ic.filter((row) => row.d >= cutD);
    duelDirty = true;
    try { store.saveDuel(duel); } catch (_) {}
  }
  function getDuel() {
    if (!duelDirty && duelCache) return duelCache;
    const scopes = {};
    for (const u of ["xyz", "main"]) {
      const rowsU = duel.ic.filter((row) => row.u === u).sort((x, y) => x.d - y.d);
      scopes[u] = {
        ic: rowsU.map((row) => [row.d, row.a, row.b, row.n]),
        stats: duelStats(rowsU.map((row) => ({ a: row.a, b: row.b })), DUEL_MIN_N),
      };
    }
    const lastD = duel.ic.length ? duel.ic[duel.ic.length - 1].d : 0;
    // dataTs is the ETag key: it must move exactly when content moves — a new IC day or a
    // retention drop both change ic.length, so the sum is collision-proof for this payload.
    duelCache = { ts: Date.now(), dataTs: lastD * DAY + duel.ic.length, minN: DUEL_MIN_N, scopes };
    duelDirty = false;
    return duelCache;
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
    const fn = num(ctx.funding); if (fn != null) { r.funding = fn; r.fundH.set(hourNow, fn); r._fVer = (r._fVer || 0) + 1; }  // forward-fill the current hour
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
      const fn = num(ctx.funding); if (fn != null) { r.funding = fn; r.fundH.set(hourNow, fn); r._fVer = (r._fVer || 0) + 1; }
      const vl = num(ctx.dayNtlVlm); if (vl != null) r.vol = vl;
      const oc = num(ctx.oraclePx); if (oc != null) r.oracle = oc;
      const oi = num(ctx.openInterest);
      if (oi != null) { r.oiBase = oi; r.oi = r.px != null ? oi * r.px : null; }
      r.d1 = (r.px != null && r.prevDay) ? (r.px - r.prevDay) / r.prevDay * 100 : r.d1;
    }
    // Fast lane. Level alerts read the LIVE mark, so they can run on the socket's cadence (~2s)
    // instead of waiting out their own 30s timer — and a void being taken is the one alert in this
    // system where the difference between 2 and 30 seconds is the difference between acting on it
    // and reading about it. Deliberately not extended to the metric rules: those read the snapshot
    // payload so they cannot outrun it without disagreeing with the board.
    try { if (typeof levelScan === "function") levelScan(); }
    catch (e) { log("levelScan on ws tick failed (isolated): " + (e && e.message)); }
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
    const histDays = r.uni === "main" ? MAIN_SPINE_DAYS : HOURLY_HISTORY_DAYS;
    const spine = Array.isArray(r.hourlyRaw) ? r.hourlyRaw : null;   // packed [[t,o,h,l,c,v], ...]
    const firstT = spine && spine.length ? +spine[0][0] : Infinity;
    const deep = spine && spine.length > 48 && firstT <= now - (histDays - (r.uni === "main" ? 14 : 30)) * DAY;
    if (!deep) {
      const wide = await fetchCandles(coin, "1h", now - histDays * DAY, now, r.uni === "main" ? MAIN_HOURLY_WEIGHT : HOURLY_FETCH_WEIGHT);
      if (Array.isArray(wide)) r.hourlyRaw = packHours(wide);
      else if (!spine) r.hourlyRaw = null;           // keep a shallow spine over nothing if the wide pull fails
    } else {
      const lastT = spine.length ? +spine[spine.length - 1][0] : 0;
      const tail = await fetchCandles(coin, "1h", Math.max(lastT - 2 * HOUR, now - 2 * DAY), now, HOURLY_TAIL_WEIGHT);
      const packedTail = packHours(tail);
      if (packedTail.length) {
        const firstNew = packedTail[0][0];
        r.hourlyRaw = spine.filter((k) => k[0] < firstNew).concat(packedTail);
      }
    }
    { const cutOld = now - histDays * DAY;
      if (Array.isArray(r.hourlyRaw)) r.hourlyRaw = r.hourlyRaw.filter((k) => k[0] >= cutOld); }
    // Features are computed from ONLY the last 31 days so hi30/lo30, volH and volD are byte-identical
    // to the previous 31d fetch — the wider window must not leak into the feature math.
    const cut = now - HOURLY_FEAT_DAYS * DAY;
    const featWin = Array.isArray(r.hourlyRaw) ? r.hourlyRaw.filter((k) => k[0] >= cut) : [];
    const { ref, feat } = featuresFromHourly(hoursToObj(featWin), now, HOUR, DAY);   // features read the object shape
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
  // Hourly lane only: past CLAIM_PRIORITY_AGE the ordering escalates — a coin holding an open,
  // announced claim outranks the volume order entirely (the fetch queue protects the same set
  // coverageScan alerts on: one predicate, one code path), and everything past the age outranks
  // fresh-ish names stalest-first, so no market can starve indefinitely just for being small.
  // Under a healthy budget nothing ever reaches the escalation age and the ordering is
  // byte-for-byte the historical one. Non-hourly lanes stay tier 0 always, untouched.
  const CLAIM_PRIORITY_AGE = 3 * HOURLY_STALE;   // past this spine age, staleness outranks volume
  const isOpenAnnounced = (e) => e.vi == null && e.alo === 1;   // shared with coverageScan — same set, one predicate
  function openClaimCoins() {
    const s = new Set();
    for (const e of ledgerOpen.values()) if (isOpenAnnounced(e)) s.add(e.coin);
    return s;
  }
  function pick(needsFetch, prefix) {
    const now = Date.now();
    const claims = prefix === "h:" ? openClaimCoins() : null;
    let best = null, bestKey = null;
    for (const r of rows.values()) {
      if (r.delisted || !needsFetch(r)) continue;
      if (prefix && inflight.has(prefix + r.coin)) continue;
      if (r.coin === benchCoin) return r.coin;   // benchmark first, always: RS, β, leaders and every correlation panel gate on its history
      const age = claims ? now - (r.hourlyTs || 0) : 0;
      const key = { tier: claims ? hourlyPickTier(age, claims.has(r.coin), CLAIM_PRIORITY_AGE) : 0,
        age, isNew: r.isNew, vol: r.vol };
      if (hourlyPickBetter(key, bestKey)) { best = r; bestKey = key; }
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
      catch (e) {
        const r = rows.get(coin);
        if (r) {
          r.hFail = (r.hFail || 0) + 1;
          // A coin carrying an open, announced claim never rides the escalating ceiling: its live
          // claim numbers are computed from this spine, so a persistently failing fetch retries
          // every FAIL_BACKOFF instead of every quarter hour. Everyone else keeps the escalation.
          const claim = openClaimCoins().has(coin);
          r.hFailUntil = Date.now() + (claim ? FAIL_BACKOFF : Math.min(FAIL_BACKOFF * r.hFail, 15 * 60 * 1000));
          // This catch used to be silent — a coin could back itself off to a 90-min-stale spine
          // with no trace in the log. One line per failed attempt, rate-ceilinged by the backoff.
          log(`hourly refresh failed for ${coin}: ${(e && e.message) || e} — fail #${r.hFail}, retry in ${Math.round((r.hFailUntil - Date.now()) / 1000)}s${claim ? " (open-claim: flat backoff)" : ""}`);
        }
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

  // ---- 5-minute archive capture -----------------------------------------------------------
  // Fold this market's freshly CLOSED 5m bars into the on-disk archive (src/store.js candles_5m).
  // Build-forward: the FIRST pull for a coin seeds the native ~17d window; thereafter we pull only
  // from just before the last stored bar (the idempotent upsert absorbs the one-bar overlap), so a
  // reconnect/redeploy resumes from the cursor rather than re-pulling. The FORMING bar is never
  // written — the same closed-vs-fresh guard the daily rebuild uses — so a bar lands exactly once,
  // when final. The instruments are 24/7 with no halts, so a missing bar in the covered range is
  // always a real capture gap, never a closure: we don't fabricate it, and if an outage exceeds the
  // native window the pre-window span is simply unrecoverable (the endpoint won't serve it) and
  // stays an honest hole that coverage count-vs-span reveals — nothing is invented to paper over it.
  function m5FilterClosed(raw, now) { return packHours(raw).filter((k) => k[0] + FIVE_MIN <= now); }
  async function capture5m(coin) {
    if (!store.candlesEnabled || !store.candlesEnabled()) return;
    const r = rows.get(coin);
    if (!r || r.delisted || r.px == null) return;
    const now = Date.now();
    // Resolve the cursor from disk once (survives redeploys), then track it in memory.
    if (!r.m5SeededCursor) { const cov = store.candleCoverage(coin); r.m5LastTs = cov.max || 0; r.m5SeededCursor = true; }
    const from = r.m5LastTs ? r.m5LastTs - FIVE_MIN : now - M5_SEED_DAYS * DAY;
    const raw = await fetchCandles(coin, "5m", from, now, M5_FETCH_WEIGHT);
    if (!Array.isArray(raw) || !raw.length) { r.m5Ts = now; return; }
    const closed = m5FilterClosed(raw, now);
    if (closed.length) { store.insertCandles(coin, closed); r.m5LastTs = Math.max(r.m5LastTs, closed[closed.length - 1][0]); }
    r.m5Ts = now;
  }
  // ---- 1m OPENING-HOUR lane (build 2026.08.18-04) ---------------------------------------------
  // A capture worker reserved for the FOCUS seats, running only between the stamp and the +1h
  // freeze. It exists because the shared 5m round-robin cannot make a promise about any individual
  // market: ~150 names compete on a 5-minute staleness check with per-coin fail backoff up to 15
  // minutes, which is longer than the entire window being measured. Four of six seats reaching
  // 10:37 with zero bars was that arithmetic, not bad luck. Six coins on their own lane at 20s
  // is ~0.3 req/s — a rounding error against the rate budget, and the seats can no longer lose.
  const M1_TICK = 20 * 1000;          // per-seat pull cadence: comfortably inside the 30s republish
  const M1_RETENTION_DAYS = 30;       // ~6 seats x 60 bars/day: the whole table is trivial
  const M1_PAD = 5 * 60 * 1000;       // capture a little before the open and after the freeze — the window's edges are the bars most likely to be missed
  function m1FilterClosed(raw, now) { return packHours(raw).filter((k) => k[0] + 60000 <= now); }
  async function capture1m(coin, from, to) {
    if (!store.candlesEnabled || !store.candlesEnabled() || !store.insertCandles1m) return 0;
    const r = rows.get(coin);
    if (!r || r.delisted || r.px == null) return 0;
    const now = Date.now();
    const raw = await fetchCandles(coin, "1m", from, Math.min(to, now), M5_FETCH_WEIGHT);
    if (!Array.isArray(raw) || !raw.length) return 0;
    // The FORMING bar is never written — same closed-vs-fresh guard the 5m lane uses, so a bar
    // lands exactly once, when final, and a re-pull absorbs the overlap through the upsert.
    const closed = m1FilterClosed(raw, now);
    return closed.length ? store.insertCandles1m(coin, closed) : 0;
  }
  // Which coins the lane owes bars to right now: the seated names, while today's window is open.
  // Reads focusState directly rather than taking a copy — a seat added by a late boot stamp is
  // covered from the moment it exists, with no second source of "who is seated".
  function m1Seats(now) {
    const st = focusState;
    if (!st || !st.rows || !st.rows.length) return null;
    if (st.day !== etDayStr(now)) return null;
    if (now < st.open - M1_PAD || now > st.open + HOUR + M1_PAD) return null;
    return { st, coins: st.rows.map((p) => p.coin).filter(Boolean) };
  }
  async function oneMinWorker() {
    for (;;) {
      const now = Date.now();
      const seats = (store.candlesEnabled && store.candlesEnabled()) ? m1Seats(now) : null;
      if (!seats) { await sleep(15000); continue; }      // outside the window this lane costs nothing
      const { st, coins } = seats;
      for (const coin of coins) {
        if (inflight.has("m1:" + coin)) continue;
        inflight.add("m1:" + coin);
        try { await capture1m(coin, st.open - M1_PAD, st.open + HOUR + M1_PAD); }
        catch (_) { /* one seat's failure must not cost the other five their window */ }
        finally { inflight.delete("m1:" + coin); }
      }
      await sleep(M1_TICK);
    }
  }
  // ---- deep 12h/1d capture (build 2026.08.21-01) ----------------------------------------------
  // Mirror of capture5m per interval: cursor resolved from disk once (survives redeploys), seed
  // pull reaches DEEP_SEED_BARS back (the endpoint clips to what exists — a young listing returns
  // its whole life, a crypto major returns years), tail pulls resume from just before the last
  // stored bar with the upsert absorbing the overlap. The FORMING bar is never written: a 1d bar
  // written mid-day would freeze a partial day as final and the next capture's upsert would then
  // silently rewrite "final" history — the closed-vs-fresh guard is what makes a bar land exactly
  // once, when it is what it will always be.
  function deepFilterClosed(iv, raw, now) { const w = DEEP_IVS[iv]; return w ? packHours(raw).filter((k) => k[0] + w <= now) : []; }
  async function captureDeep(coin, iv) {
    if (!store.candlesEnabled || !store.candlesEnabled() || !store.insertCandlesDeep) return;
    const w = DEEP_IVS[iv];
    const r = rows.get(coin);
    if (!w || !r || r.delisted || r.px == null) return;
    const now = Date.now();
    if (!r.deep) r.deep = {};
    let d = r.deep[iv];
    if (!d) { const cov = store.candleCoverageDeep(iv, coin); d = r.deep[iv] = { last: cov.max || 0, ts: 0, fail: 0, failUntil: 0 }; }
    const from = d.last ? d.last - w : now - DEEP_SEED_BARS * w;
    const raw = await fetchCandles(coin, iv, from, now, d.last ? DEEP_TAIL_WEIGHT : DEEP_SEED_WEIGHT);
    if (!Array.isArray(raw) || !raw.length) { d.ts = now; return; }
    const closed = deepFilterClosed(iv, raw, now);
    if (closed.length) { store.insertCandlesDeep(iv, coin, closed); d.last = Math.max(d.last, closed[closed.length - 1][0]); }
    d.ts = now;
  }
  // One worker walks BOTH intervals round-robin. Steady state is ~150 markets x 2 intervals on a
  // 4h staleness check — well under one request a minute; the cold seed spreads through the same
  // loop behind the per-(coin,interval) inflight guard + exponential fail backoff.
  const needDeep = (r, iv) => store.candlesEnabled && store.candlesEnabled() && r.px != null &&
    (!r.deep || !r.deep[iv] || (Date.now() - (r.deep[iv].ts || 0) > DEEP_STALE && Date.now() >= (r.deep[iv].failUntil || 0)));
  async function deepWorker() {
    for (;;) {
      if (!store.candlesEnabled || !store.candlesEnabled() || !store.insertCandlesDeep) { await sleep(60000); continue; }
      let served = false;
      for (const iv of Object.keys(DEEP_IVS)) {
        const coin = pick((r) => needDeep(r, iv), "dp" + iv + ":");
        if (!coin) continue;
        if (inflight.has("dp" + iv + ":" + coin)) continue;
        inflight.add("dp" + iv + ":" + coin);
        try { await captureDeep(coin, iv); const r = rows.get(coin); if (r && r.deep && r.deep[iv]) r.deep[iv].fail = 0; }
        catch (_) {
          const r = rows.get(coin);
          if (r && r.deep && r.deep[iv]) { const d = r.deep[iv]; d.fail = (d.fail || 0) + 1; d.failUntil = Date.now() + Math.min(FAIL_BACKOFF * d.fail, 15 * 60 * 1000); d.ts = Date.now(); }
        } finally { inflight.delete("dp" + iv + ":" + coin); }
        served = true;
      }
      await sleep(served ? 1500 : 15000);
    }
  }

  const need5m = (r) => store.candlesEnabled && store.candlesEnabled() && r.px != null &&
    Date.now() - (r.m5Ts || 0) > M5_STALE && Date.now() >= (r.m5FailUntil || 0);
  // One worker suffices: ~150 markets x a tiny tail pull spread over 5 min is well under 1 req/s.
  // Mirrors hourlyWorker's inflight guard + per-coin exponential fail backoff.
  async function fiveMinWorker() {
    for (;;) {
      if (!store.candlesEnabled || !store.candlesEnabled()) { await sleep(60000); continue; }
      const coin = pick(need5m, "m5:");
      if (!coin) { await sleep(2000); continue; }
      if (inflight.has("m5:" + coin)) { await sleep(500); continue; }
      inflight.add("m5:" + coin);
      try { await capture5m(coin); const r = rows.get(coin); if (r) r.m5Fail = 0; }
      catch (_) {
        const r = rows.get(coin);
        if (r) { r.m5Fail = (r.m5Fail || 0) + 1; r.m5FailUntil = Date.now() + Math.min(FAIL_BACKOFF * r.m5Fail, 15 * 60 * 1000); }
      } finally { inflight.delete("m5:" + coin); }
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
    if (n) r._fVer = (r._fVer || 0) + 1;   // invalidate this row's getFunding memo
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
  // Per-HOME-market open/closed state (build 2026.08.14-01): the same shape as computeOffHours
  // but anchored to KRX/TSE/HKEX for the foreign-home names. `nextT` is the next state change
  // either way (closed -> its open, open -> its close) so the client's countdown microline is a
  // single server-computed number — the client never re-derives calendars. `approx` flips when
  // `now` is past the curated holiday table's horizon (weekend-only degrade): the state is still
  // served, but consumers flag it as approximate rather than trusting it.
  function computeOffHoursHome(mk, nowMs) {
    const s = nowMs - 12 * DAY, e = nowMs + 12 * DAY;   // wide enough to bridge Golden Week / Chuseok spans
    const approx = !homeCalCovered(mk, new Date(nowMs + HOME_MKTS[mk].utcOff * HOUR).getUTCFullYear());
    const wins = homeClosedWindows(mk, s, e);
    for (const a of wins) if (nowMs >= a.enter && nowMs < a.exit)
      return { closed: true, closeT: a.enter, openT: a.exit, nextT: a.exit, approx: approx || undefined };
    // open now: the close of the current session = the enter of the next closed window
    let nxt = null;
    for (const a of wins) if (a.enter > nowMs && (nxt == null || a.enter < nxt)) nxt = a.enter;
    return { closed: false, nextT: nxt || undefined, approx: approx || undefined };
  }
  function homeStateAll(nowMs) {
    const out = {};
    for (const mk in HOME_MKTS) out[mk] = computeOffHoursHome(mk, nowMs);
    return out;
  }
  // Static wire defs for the client's chips/ribbon (wall-clock windows + fixed offset + the
  // curated calendar horizon). One producer: the client renders these, it never re-declares them.
  const HOME_MKTS_WIRE = {};
  for (const mk in HOME_MKTS) { const M = HOME_MKTS[mk];
    HOME_MKTS_WIRE[mk] = { ex: M.ex, off: M.utcOff, o: M.o, c: M.c, lunch: M.lunch || undefined, calThrough: homeCalHorizon(mk) }; }
  // Row -> its own market state: the foreign-home names read their home exchange, everything
  // else reads the US cash flag. dc is the daily cache (carries offHoursBy stamped at build).
  function rowOffState(dc, r) {
    const mk = homeMkt(r.ticker, r.uni);
    if (mk && dc && dc.offHoursBy && dc.offHoursBy[mk]) return dc.offHoursBy[mk];
    return dc ? dc.offHours : null;
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

  // Compact per-market fingerprint for the snapshot content signature (see buildSnapshot). Covers
  // every field mapMarket emits that a client renders: the scalars are already sig()-quantized and
  // the small nested objects are stringified (they only move on a poll / candle refresh anyway).
  function markSig(m) {
    return m.coin + "|" + m.px + "," + m.prevDay + "," + m.funding + "," + m.vol + "," + m.oi + ","
      + m.oiBase + "," + m.oracle + "," + m.d1 + "," + m.fundPct + "," + (m.delisted ? 1 : 0) + "," + (m.cascT || 0) + "," + (m.liq24 || 0)
      + "," + (m.tscore == null ? "" : m.tscore) + "," + (m.e21d == null ? "" : m.e21d)
      + "," + (m.p5m == null ? "" : m.p5m) + "," + (m.p15m == null ? "" : m.p15m)
      + "|" + (m.ref ? JSON.stringify(m.ref) : "") + (m.feat ? JSON.stringify(m.feat) : "")
      + (m.red ? JSON.stringify(m.red) : "") + (m.rvol ? JSON.stringify(m.rvol) : "")
      + (m.doi ? JSON.stringify(m.doi) : "") + (m.fundByWin ? JSON.stringify(m.fundByWin) : "") + ";";
  }
  // ---- volume profile + unified level map (build 2026.07.27-22) ------------------------------
  // One memoized {vp, map} per name. Bars: dailyRaw for depth (370d equity AND crypto since -20),
  // OVERLAID with the spine-derived daily buckets where they cover — the buckets carry the true
  // low and the summed hourly volume, which dailyRaw structurally lacks (no l; v absent on some
  // warm-cache bars). The recent window — exactly the part the profile's 1.5x recency weight
  // emphasizes — therefore rides true OHLCV; the old anchor degrades to half-range honestly.
  // detectLevels, the profile, and the EMA50/200 all read the SAME merged bars, so the map's
  // sources can never disagree about what a day looked like. Memo key: daily length + bucket
  // count — the profile moves when a day lands or the spine grows an hour, never on the 15s tick.
  // The one merged daily-bar source (-22, extracted -26): dailyRaw for depth (370d both
  // universes), overlaid with the spine-derived daily buckets where they cover — true lows and
  // summed hourly volume that dailyRaw structurally lacks. The profile, the level map, and the
  // EMA200 study all read THIS — three consumers, one definition of what a day looked like.
  function mergedDailyBars(r) {
    const dr = r && r.dailyRaw;
    if (!Array.isArray(dr)) return [];
    const db = bucketsFor(r, 24);
    const byDay = new Map();
    if (Array.isArray(db)) for (const b of db) if (b && isFinite(+b.t) && b.o != null) byDay.set(Math.floor(+b.t / DAY), b);
    const bars = [];
    for (const k of dr) {
      if (!k || !isFinite(+k.t) || !(+k.c > 0)) continue;
      const ov = byDay.get(Math.floor(+k.t / DAY));
      if (ov) bars.push({ t: +k.t, c: +ov.c, h: +ov.h, l: +ov.l, v: ov.v > 0 ? +ov.v : (+k.v > 0 ? +k.v : 0) });
      else { const c = +k.c, h = +k.h; bars.push({ t: +k.t, c, h: isFinite(h) && h > 0 ? h : c, l: c, v: +k.v > 0 ? +k.v : 0 }); }
    }
    return bars;
  }
  function volMapFor(r) {
    const dr = r && r.dailyRaw;
    if (!Array.isArray(dr) || dr.length < 30 || !(r.px > 0)) return null;
    const db = bucketsFor(r, 24);
    const memoK = dr.length + "|" + (Array.isArray(db) ? db.length : 0);
    if (r._vpK === memoK && r._vpM !== undefined) return r._vpM;
    let out = null;
    try {
      const bars = mergedDailyBars(r);
      const closes = bars.map((k) => [k.t, k.c]);
      const sd30 = retStd(dailyRets(closes).slice(-30), 15);
      if (bars.length >= 60 && sd30 > 0) {
        const vp = volumeProfile(bars, sd30);
        const str = detectLevels(bars, r.px, sd30);
        // EMA50/200 over the daily closes (chart-language dynamic levels, tagged as such in the
        // map — the AI validator's ban on EMAs-as-chart-levels is a different consumer and stands)
        const ema = (N) => { if (closes.length < N + 10) return null;
          const k2 = 2 / (N + 1); let e = closes[0][1];
          for (let i = 1; i < closes.length; i++) e = closes[i][1] * k2 + e * (1 - k2);
          return e > 0 ? e : null; };
        const map = levelMap({ str, vp, e50: ema(50), e200: ema(200) }, r.px, sd30);
        if (vp || map) out = { vp, map, sd30: +sd30.toFixed(3), dexVol: r.uni === "xyz" };
      }
    } catch (_) { out = null; }
    r._vpK = memoK; r._vpM = out;
    return out;
  }
  function buildSnapshot() {
    sampleRegime();
    // 5m/15m reference sampling rides the snapshot's own 15s cadence — one push per non-delisted
    // market in BOTH universes, taken before anything downstream can short-circuit, from the same
    // live mark mapMarket ships. Memory-only by design (see PX_RING_DEPTH_MS above).
    { const tR = Date.now();
      for (const r of rows.values()) if (!r.delisted && r.px != null) pxRingPush(r.pxRing || (r.pxRing = []), tR, r.px, PX_RING_DEPTH_MS); }
    const tapeXyz = tapeStatsFor("xyz", activeMarkets());
    const tapeMain = crypto ? tapeStatsFor("main", mainMarkets()) : tapeCache.main;
    const RVOL_WINS = { h1: HOUR, h4: 4 * HOUR, d1: DAY };
    const nowMs = Date.now();
    const rvolEndH = Math.floor(nowMs / HOUR);   // clock-hour bucket — half of the rvol memo key (spine ref is the other half)
    const mapMarket = (r) => {
      const cl = classifyCached(r.ticker, r.uni);
      // Funding percentile: where the CURRENT rate sits in this market's own 31d hourly funding
      // distribution. 96 = the crowd is paying near its monthly extreme — the classic crypto
      // mean-reversion zone. Computed for every universe; extremes are just rarer on equities.
      let fundPct = null;
      try {
        if (r.funding != null && isFinite(r.funding) && r.fundH && r.fundH.size) {
          // Read the funding Map DIRECTLY — a percentile is order-independent (a count of samples
          // at or below the current rate), so it never needed the sorted [t,rate] copy getFunding
          // builds. Skipping that per-market sort on every 15s tick is the point; the live Map is
          // the single source, so there's no staleness window.
          const cut = Date.now() - 31 * DAY;
          let n = 0, le = 0;
          for (const [t, rate] of r.fundH) { if (t < cut || !isFinite(rate)) continue; n++; if (rate <= r.funding) le++; }
          if (n >= 96) fundPct = Math.round((100 * le) / n);   // >=4 days of hourly samples before we claim a percentile
        }
      } catch (_) {}
      // Red-tape resilience (fixed 31d, 4h bars, breadth-defined red, universe-median reference)
      // + clock-hour-matched relative volume for the 1h/4h/1d windows. Both derive entirely from
      // the retained hourly spine — zero additional API weight.
      const tape = r.uni === "main" ? tapeMain : tapeXyz;
      const red = tape.stats.get(r.coin) || null;
      let rvol = null;
      try {
        const hs = getHourly(r.coin);
        if (hs.length > 24) {
          // rvolMulti's result only moves when a new hourly candle lands (spine ref changes) or the
          // clock hour rolls (rvolEndH changes) — otherwise it recomputes the same ~4k-entry notional
          // Map every 15s tick for nothing. Memoize on exactly those two keys.
          if (r._rvRaw === r.hourlyRaw && r._rvEndH === rvolEndH && r._rv !== undefined) rvol = r._rv;
          else { rvol = rvolMulti(hs, RVOL_WINS, nowMs); r._rvRaw = r.hourlyRaw; r._rvEndH = rvolEndH; r._rv = rvol; }
        }
      } catch (_) {}
      // Cascade flag (crypto only): the latest server-computed cascade within 24h, shipped as the
      // detail object (hover) plus a flat numeric sort key. Same czCasc the drawer panel reads —
      // the board and the chart can never disagree on whether a cascade fired.
      const casc = r.uni === "main" && cz ? czCascLatest(r.coin) : null;
      // 24h liquidation volume (aggregated CEX, USD source-converted): the SAME memoized rollup
      // object the drawer chips serve — one code path, board and drawer can never disagree.
      const droll = r.uni === "main" && cz ? czRoll.get(r.coin) : null;
      const tb = trendByCoin.get(r.coin);
      // Swing-R available (-22): distance to the next level-map target in the TREND direction /
      // distance to the D1 EMA21 void — how much structural room the next swing trade has, per
      // unit of risk, ranked universe-wide BEFORE any signal fires. Target = nearest map entry
      // on the trend side with confluence weight >= 0.7, pure-LVN entries excluded (thin volume
      // is a traversal feature, not a destination). Requires a trend side (the board's own) and
      // a live EMA21 — anything missing is an honest dash, never a guess. Levels are frozen-ish
      // (the map moves on daily cadence); the RATIO is computed here against the snapshot mark,
      // same convention as e21d.
      let swr, swrT, swrV, swrS;
      try {
        const vm = volMapFor(r);
        const e21v = tb && tb.e21 > 0 ? tb.e21 : null;
        if (vm && vm.map && e21v && tb && r.px > 0) {
          const distV = Math.abs(r.px / e21v - 1) * 100;
          let tgt = null;
          for (const it of vm.map.items) {
            if (!(it.w >= 0.7) || (it.srcs.length === 1 && it.srcs[0] === "lvn")) continue;
            if (tb.side === "long" ? it.v > r.px * 1.005 : it.v < r.px * 0.995) {
              if (tgt == null || (tb.side === "long" ? it.v < tgt.v : it.v > tgt.v)) tgt = it;
            }
          }
          if (tgt && distV > 0.05) {
            swr = +((Math.abs(tgt.v / r.px - 1) * 100) / distV).toFixed(2);
            swrT = tgt.v; swrV = sig(e21v, 9); swrS = tgt.srcs.join("+");
          }
        }
      } catch (_) {}
      // Anchored intraday opens (H / 4h / 12h UTC buckets) — computed HERE at snapshot time
      // against the live clock, never at hourly-refresh time: an anchor derived from a stale
      // `now` is the previous bucket wearing this one's label. Cheap: a reverse scan of the
      // spine's last ~13 rows per snapshot build.
      const bopen = bucketOpens(r.hourlyRaw, nowMs, HOUR);
      return {
        fundPct, red, rvol, swr, swrT, swrV, swrS,
        casc: casc || undefined, cascT: casc ? casc.t : undefined,
        liq24: droll ? (droll.ll24 || 0) + (droll.sl24 || 0) : undefined,
        liqL24: droll ? droll.ll24 : undefined, liqS24: droll ? droll.sl24 : undefined,
        coin: r.coin, ticker: r.ticker, delisted: !!r.delisted, uni: r.uni,
        // Notes digest (build 2026.08.24-01): {n, ts, px} — count, newest note's timestamp and
        // the mark it was written at. Exactly what the ticker cell needs to paint the post-it
        // and its age class; the bodies never ride the 15s poll. undefined when the name has
        // no notes, so a row costs nothing until somebody writes on it.
        nt: noteDigest(r.coin),
        // Signed so ONE metric expresses both sides: +4 fully stacked up, -4 fully stacked down.
        tscore: tb ? (tb.side === "long" ? tb.score : -tb.score) : undefined,
        e21d: (tb && tb.e21 > 0 && r.px > 0) ? rnd((r.px / tb.e21 - 1) * 100, 2) : undefined,
        // 5m/15m mark references from the in-memory ring — shipped as reference PRICES like
        // ref.p1h/p4h so the client derives the % the same way it does every other window (one
        // convention, one code path). Absent (undefined) during warm-up or across a feed gap
        // wider than PX_RING_TOL_MS at the lookback point: the client dashes, never guesses.
        p5m: sig(pxRingRef(r.pxRing, nowMs, 5 * 60 * 1000, PX_RING_TOL_MS), 9) ?? undefined,
        p15m: sig(pxRingRef(r.pxRing, nowMs, 15 * 60 * 1000, PX_RING_TOL_MS), 9) ?? undefined,
        // Anchored intraday opens — shipped as LEVELS like ref.p1h/p5m so the client derives the
        // % the same way it does every other window (one convention, one code path with D open).
        // Absent (undefined) when the spine hasn't reached the bucket boundary: the client
        // dashes, never measures against a stale anchor.
        hopenPx: sig(bopen.h, 9) ?? undefined,
        h4openPx: sig(bopen.h4, 9) ?? undefined,
        h12openPx: sig(bopen.h12, 9) ?? undefined,
        // dip-reclaim claim off the 5m archive tail (xyz only — the exact tail the sweep detector
        // reads). {d,r,m} = dip depth %, fraction reclaimed, minutes since the trough. Absent =
        // no fresh claim (dip under the floor, archive off, or crypto): the client dashes.
        bid: r.bidInfo ? { d: r.bidInfo.dip, r: r.bidInfo.rec, m: r.bidInfo.mins } : undefined,
        px: sig(r.px, 9), prevDay: sig(r.prevDay, 9), funding: sig(r.funding, 6),
        vol: rnd(r.vol, 0), oi: rnd(r.oi, 0), oiBase: sig(r.oiBase, 9),
        oracle: sig(r.oracle, 9), d1: rnd(r.d1, 4),
        ref: trimRef(r.ref), feat: trimFeat(r.feat),
        doi: trimWin(computeDoi(r)), fundByWin: trimWin(computeFundWin(r), 6),
        sector: cl.sector, assetClass: cl.assetClass,
        // Overlay provenance (build 2026.08.05-02): present ONLY when the classification came from
        // the sector-audit overlay ("cls" auto-classified, "grad" auto-graduated). Read off the
        // same classify() result as the sector itself — one code path, board and audit panel agree.
        secAuto: cl.auto || undefined,
        // Industry group (build -04): shipped ONLY when it differs from the sector — the client's
        // contract is `r.ind || r.sector`, so an absent field IS the fallback, not a gap. Keeps
        // the payload thin for the majority of instruments where the two coincide.
        ind: cl.ind !== cl.sector ? cl.ind : undefined,
        // Display name + macro news lane, both from the static sectors table. `nm` is a label
        // only; `mlane` declares whether this instrument HAS a topical news lane and what it is
        // scoped to, so the drawer never re-derives either. Both are undefined when unseeded —
        // the client renders the bare ticker and shows no tape, never a guess.
        nm: displayName(r.ticker, r.uni) || undefined,
        mlane: macroLane(r.ticker, r.uni) || undefined,
        // Home-market classification (build 2026.08.14-01): hm = the exchange whose session the
        // machinery is anchored to for this name (KR/JP/HK; absent = US, the default). hadr is
        // ADR context ONLY — a US-listed line whose home line leads it overnight; it never
        // changes anchoring. Both from the curated sectors table — one producer, never re-derived.
        hm: homeMkt(r.ticker, r.uni) || undefined,
        hadr: homeAdr(r.ticker) || undefined,
      };
    };
    const markets = activeMarkets().map(mapMarket);
    // Crypto ships under its OWN key: snapshot.markets stays xyz-pure so every existing consumer
    // (tabs, studies, treemap, leaders) is untouched until the scope switcher lands in Build B.
    const mainMkts = crypto ? mainMarkets().map(mapMarket) : [];
    const offHours = computeOffHours(Date.now());
    const homeState = homeStateAll(Date.now());   // KRX/TSE/HKEX open/closed + next flip, for chips/countdowns/live-gap mode on foreign-home rows
    // live warmup counts: h = markets without hourly features yet, d = markets with no daily
    // closes servable at all (no 370d backfill AND no hourly spine to derive from) — lets the
    // client show "N still backfilling" instead of a mystery placeholder, and poll accordingly
    let warmH = 0, warmD = 0;
    for (const r of activeMarkets()) { if (r.delisted) continue;
      if (!r.feat) warmH++;
      if (!r.dailyRaw && !(r.hourlyRaw && r.hourlyRaw.length > 24)) warmD++; }
    // Content signature over EVERYTHING a client renders, excluding ts/dataTs (which always move).
    // When it matches the previous build we keep the old snapshotCache OBJECT: same reference means
    // the same ETag — a real 304 for every polling client instead of a fresh ~0.5 MB download — and
    // the downstream serialize + gzip WeakMap caches (keyed on the object) stay warm. offHours, the
    // warm counts and the regime ride the signature so a session flip, a backfill completing, or a
    // correlation shift still busts it even when no price moved. Off-hours, when equities don't
    // trade, this idles the entire snapshot pipeline end to end (build, serialize, gzip, client render).
    let csig = "";
    for (const m of markets) csig += markSig(m);
    for (const m of mainMkts) csig += markSig(m);
    csig += "#" + (offHours.closed ? 1 : 0) + ":" + (offHours.closeT || 0) + ":" + (offHours.openT || 0)
      // Home-market flips ride the signature for the same reason the US one does: a KRX open at
      // 20:00 ET must flip SMSN's chip/live-gap on the next poll, even while the US board idles.
      + "#" + ["KR", "JP", "HK"].map((k) => (homeState[k].closed ? 1 : 0) + ":" + (homeState[k].nextT || 0)).join(",")
      + "#" + warmH + "," + warmD
      + "#" + sig(curCorr, 6) + "," + curCorrPct + "," + curCorrN + "," + regimeHist.length
      + "#" + tapeXyz.redBars + "," + (crypto ? tapeMain.redBars : 0)
      // The alert sequence rides the signature deliberately. A fired alert IS something the client
      // renders (the bell badge), and the snapshot object is FROZEN while the signature holds — so
      // shipping alertVer without signing it would hand every client a permanently stale sequence
      // exactly when the board is quiet, which is when alerts matter most.
      + "#" + trigSeq
      // Notes ride the signature for the same reason alertVer does: the digest is something the
      // client RENDERS, and the snapshot object is frozen while the signature holds — so a note
      // written on a quiet board would otherwise not surface its marker until an unrelated price
      // moved. One counter busts it for every row at once.
      + "#" + notesRev;
    if (snapshotCache && lastSnapSig === csig) return;   // nothing a client renders changed — keep the object
    lastSnapSig = csig; snapVer = Date.now();
    snapshotCache = {
      ts: snapVer, dataTs: snapVer, dex, benchCoin,
      // Lets the client pull the alert feed on the poll it already makes, instead of a second
      // timer with its own cadence and its own idea of "now".
      alertVer: trigSeq,
      benchMain: crypto ? MAIN_BENCH : null, mainMarkets: mainMkts, markets,
      redBars: { xyz: tapeXyz.redBars, main: crypto ? tapeMain.redBars : 0 },
      v: version || null,
      offHours,
      // Home sessions (build 2026.08.14-01): static defs (wall-clock windows, fixed UTC offset,
      // curated-calendar horizon) + the live per-market state. The client renders BOTH — chips,
      // rails, countdowns, the drawer ribbon — and computes neither.
      homeMkts: HOME_MKTS_WIRE, homeState,
      warm: { h: warmH, d: warmD },
      regime: { corr: curCorr, corrPct: curCorrPct, corrN: curCorrN, corrSamples: regimeHist.length },
    };
  }
  // Derive daily closes from the array hourly spine (last candle per UTC day) so /api/daily — and the
  // client-side correlation that reads it — can populate from the hourly spine (available early, and what
  // the warm cache restores) instead of waiting on the separate rate-limited 370d daily backfill.
  function deriveDailyClose(hs) {
    // [d, close, dayHigh, dayVol] per UTC day — close is the last hourly close, high the max hourly
    // high, vol the summed hourly volume. Extra columns are additive: every [t,c]-shaped consumer
    // (studies, correlation, old clients) keeps reading indices 0/1 untouched.
    const byDay = new Map();
    for (const k of hs) {
      const t = k[0], c = k[4]; if (!Number.isFinite(t) || !Number.isFinite(c)) continue;
      const d = Math.floor(t / DAY) * DAY; let cur = byDay.get(d);
      if (!cur) { cur = [t, c, -Infinity, 0]; byDay.set(d, cur); }
      if (t >= cur[0]) { cur[0] = t; cur[1] = c; }
      if (Number.isFinite(k[2]) && k[2] > cur[2]) cur[2] = k[2];
      if (Number.isFinite(k[5]) && k[5] > 0) cur[3] += k[5];
    }
    return [...byDay.entries()].sort((a, b) => a[0] - b[0])
      .map(([d, v]) => [d, v[1], Number.isFinite(v[2]) && v[2] > 0 ? sig(v[2], 7) : null, v[3] > 0 ? sig(v[3], 6) : null]);
  }

  // [t,c,h,v] tuples from a row's dailyRaw + hourly spine. Full-OHLC bars map directly. Closes-only
  // bars (a warm-cache hydrate, pre--06 files) keep their full depth for c but OVERLAY h/v from the
  // hourly spine for the days it covers — so the level-based backtest signals ship from minute one
  // after a redeploy instead of gating until the OHLC-upgrade queue drains. Older days simply carry
  // null h/v until the real backfill lands (btScore's per-day px fallback handles the seam).
  function dailyTuples(r, hs) {
    if (r.dailyRaw && r.dailyRaw.length >= 5) {
      if (!dailyLacksOHLC(r)) return r.dailyRaw.map((k) => [k.t, k.c, Number.isFinite(k.h) ? sigq(k.h, 7) : null, Number.isFinite(k.v) && k.v > 0 ? sigq(k.v, 6) : null]);
      const dv = hs.length > 24 ? new Map(deriveDailyClose(hs).map((k) => [k[0], k])) : null;
      return r.dailyRaw.map((k) => {   // a -06 warm file round-trips h/v on the bar itself — prefer those, spine-overlay only the gaps
        const e = dv && dv.get(Math.floor(k.t / DAY) * DAY);
        const h = Number.isFinite(k.h) ? sigq(k.h, 7) : (e ? e[2] : null);
        const v = Number.isFinite(k.v) && k.v > 0 ? sigq(k.v, 6) : (e ? e[3] : null);
        return [k.t, k.c, h, v];
      });
    }
    return hs.length > 24 ? deriveDailyClose(hs) : null;   // UTC-floored by construction — correct for 24/7 markets
  }
  function buildDailyMain(daily, funding, oi) {
    for (const r of mainMarkets()) {
      const hs = getHourly(r.coin);
      const dr = dailyTuples(r, hs);
      if (dr && dr.length) {
        deepDaily.set(r.coin, dr);                                 // full 370d for the signal loop — the whole point of the -20 retention
        daily[r.coin] = dr.slice(-(MAIN_DAILY_PAYLOAD + 2));       // -20: the wire stays at the ~90d the clients render
      }
      if (oi) { const os = oiDailySeries(r.coin); if (os) oi[r.coin] = os.map(([d, x]) => [d, sigq(x, 6)]); }
      const fh = getFunding(r.coin);
      if (fh.length) {
        const byDay = new Map();
        for (const [t, rate] of fh) { const d = Math.floor(t / DAY) * DAY; byDay.set(d, (byDay.get(d) || 0) + rate); }
        funding[r.coin] = [...byDay.entries()].sort((a, b) => a[0] - b[0]).map(([d, f]) => [d, +f.toFixed(8)]);
      }
    }
  }
  function buildDaily() {
    const daily = {}, funding = {}, overnight = {}, liveClose = {}, oi = {};
    let ohlcN = 0, oiN = 0;   // sig terms: names whose latest tuple carries a high, and total OI points — so OHLC upgrades and OI growth bust the cache despite unchanged bar counts
    const nowMs = Date.now();
    const offHours = computeOffHours(nowMs);   // kept here too for client compatibility; the snapshot copy is the fresh one
    const offHoursBy = homeStateAll(nowMs);    // per-HOME-market states — the foreign-home rows anchor to these, never to the US flag
    let coins = 0, lens = 0;
    for (const r of activeMarkets()) {
      const hs = getHourly(r.coin);   // normalized array spine [[t,o,h,l,c,v], ...]; the boundary engine + priceAsOf are array-indexed
      // daily closes: prefer the real 370d backfill; otherwise bootstrap from the hourly spine
      const dr = dailyTuples(r, hs);
      if (dr && dr.length) { daily[r.coin] = dr; coins++; lens += dr.length; if (!r.dailyRaw || !dailyLacksOHLC(r)) ohlcN++; }   // count natively-full names: each in-place OHLC upgrade moves this and busts the cache
      { const os = oiDailySeries(r.coin); if (os) { oi[r.coin] = os.map(([d, x]) => [d, sigq(x, 6)]); oiN += os.length; } }   // daily-step OI for the backtest's OI-change signal

      const fh = getFunding(r.coin);                                    // hourly [t,rate] -> daily funding a 1x long pays (sum of the day's hourly rates)
      if (fh.length) {
        const byDay = new Map();
        for (const [t, rate] of fh) { const d = Math.floor(t / DAY) * DAY; byDay.set(d, (byDay.get(d) || 0) + rate); }
        funding[r.coin] = [...byDay.entries()].sort((a, b) => a[0] - b[0]).map(([d, f]) => [d, +f.toFixed(8)]);
      }
      // overnight + weekend holds (buy at close, sell before open) via the boundary engine; memoized
      // to the spine version. RE-ANCHORED per row (build 2026.08.14-01): a foreign-home name's
      // close->open is its HOME exchange's boundary — 15:30 KST -> 09:00 KST next session for a
      // KRX name — never the ET one. The liveClose anchor keys off the SAME market's state, so the
      // live in-progress gap for SMSN runs while KRX is closed, not while NYSE is.
      if (hs.length > 2) {
        const hmk = homeMkt(r.ticker, r.uni);
        if (r._ovTs !== r.hourlyTs) {
          const start = hs[0][0], end = hs[hs.length - 1][0];
          const anchors = hmk
            ? homeOvernightAnchors(hmk, start, end).concat(homeWeekendAnchors(hmk, start, end))
            : overnightAnchors(start, end).concat(weekendAnchors(start, end));
          r._ovClose = runHolds(hs, fh, anchors).map((h) => [Math.floor(h.exit / DAY) * DAY, +h.gross.toFixed(8), +(h.funding || 0).toFixed(8)]).sort((a, b) => a[0] - b[0]);
          r._ovTs = r.hourlyTs;
        }
        if (r._ovClose && r._ovClose.length) overnight[r.coin] = r._ovClose;
        const oh = hmk ? offHoursBy[hmk] : offHours;
        if (oh.closed) { const pc = priceAsOf(hs, oh.closeT, 3 * HOUR); if (pc > 0) liveClose[r.coin] = +pc.toFixed(8); }  // price at the last close, for the live in-progress gap
      }
    }
    const sig = coins + ":" + lens + ":" + (offHours.closed ? 1 : 0) + ":" + ["KR", "JP", "HK"].map((k) => (offHoursBy[k].closed ? 1 : 0)).join("") + ":" + ohlcN + ":" + oiN;   // session flips bust it — the US one AND each home market's (a KRX close must refresh SMSN's liveClose even while NYSE is open)
    if (dailyCache && sig === dailySig) return;   // unchanged — keep the OBJECT so serialize/gzip caches stay warm + 304s flow
    dailySig = sig; dailyVer = Date.now();   // content changed -> new ETag + fresh object
    if (crypto) buildDailyMain(daily, funding, oi);
    dailyCache = { ts: Date.now(), dataTs: dailyVer, daily, funding, overnight, offHours, offHoursBy, liveClose, oi };
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
    casc: "Cascade exhaustion", fundext: "Funding extreme",
  };
  // ---- crypto enrollment (build 2026.07.26-08) ------------------------------------------------
  // The crypto side of the engine returns, as a WHITELIST rather than the blanket re-admission
  // that -87 attempted. Three classes of event are excluded, each for a structural reason and not
  // as a hedge:
  //   * impossible on a 24/7 tape — gap, gapfade, ondrift have no session boundary to measure;
  //     pead has no earnings; sweep's "prior session" does not exist as a distinct object.
  //   * no analogue — prem exists to price HIP-3 synthetics against their oracle while the cash
  //     market is shut. Main-dex oracle premium is arbitraged tight and carries nothing.
  //   * geometry not yet trustworthy — squeeze and unwind fire on a composite that routinely
  //     resolves away from the range edge their levels assume. The log-space rewrite stops them
  //     producing negative prices, but an inverted-at-fire level is still an inverted level, so
  //     they stay out of the crypto roster until the equity record says the trigger itself works.
  // Everything else runs, on crypto horizons, with claimGeometryOk enforcing the levels. casc and
  // fundext are crypto-only by nature (there is no equity liquidation cascade in our data).
  const MAIN_EVS = new Set([
    "bigmove", "breakout", "breakdown", "volshift", "coil", "volume",
    "fundflip", "oiflush", "fpdiv", "tretest", "tretestdn",
    "casc", "fundext",                                        // crypto-native
    "reclaim", "failbrk", "mapull", "wickfill", "roundfr",     // shadows
    "swpull", "basebrk", "basepj",                             // swing-horizon touch-mode shadows (-20)
    "emabrk", "emarts",                                        // EMA200 close-confirmed shadows (-28)
    "lvlhold", "lvlrej", "vphold", "vprej",                    // structural-level + volume-node touch shadows (2026.07.28-01/-02)
    "airead",                                                  // the Report tab's own record (never was this engine's)
  ]);
  // squeeze2/unwind2 follow their incumbents: the twins fire only where the visible squeeze/unwind
  // fire, and those are xyz-only until the equity record says the trigger itself works.
  const XYZ_ONLY_EVS = new Set(["gap", "gapfade", "ondrift", "pead", "sweep", "prem", "squeeze", "unwind", "squeeze2", "unwind2"]);
  const MAIN_ONLY_EVS = new Set(["casc", "fundext"]);
  // One gate every fire site and openLedger consults, so "which events does this universe run"
  // has exactly one answer in the codebase.
  function evAllowed(uni, ev) {
    if (uni === "main") return MAIN_EVS.has(ev);
    return !MAIN_ONLY_EVS.has(ev);
  }
  // Epoch of the rebuilt crypto engine. Stored crypto claims older than this were opened under the
  // additive geometry that produced negative targets — re-admitting them would seed the fresh
  // out-of-sample record with exactly the fabrications the gate now refuses to stamp. So the -101
  // purge stays, bounded to the pre-epoch era instead of running forever.
  const CRYPTO_EPOCH = Date.UTC(2026, 6, 26);   // 2026-07-26T00:00:00Z
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
      // Home-anchored windows for foreign-home names (build 2026.08.14-01): SMSN's gap σ and
      // overnight drift are measured across KRX boundaries, or they're measuring nothing.
      const hmk = homeMkt(r.ticker, r.uni);
      const wins = hmk
        ? homeOvernightAnchors(hmk, hs[0][0], hs[hs.length - 1][0]).concat(homeWeekendAnchors(hmk, hs[0][0], hs[hs.length - 1][0]))
        : overnightAnchors(hs[0][0], hs[hs.length - 1][0]).concat(weekendAnchors(hs[0][0], hs[hs.length - 1][0]));
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
  let ledgerOpen = new Map(), ledgerClosed = [], ledgerDirty = false, recordCache = null, recordCacheU = null, confCache = null, recordXCache = null, recordSets = null;
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
  const R_UNIT_EVS = new Set(["bigmove", "breakout", "breakdown", "fundflip", "volshift", "oiflush", "fpdiv", "reclaim", "mapull", "failbrk", "pead", "sweep", "airead", "casc", "fundext", "swpull", "basebrk", "basepj"]);
  // F3 blend half-life: how fast the live-record blend forgets. A resolution 120d old carries half
  // the weight of a fresh one in avgR/hitR. Deliberately generous — recency is a gentle tilt so a
  // decayed edge fades from the SCORE over a quarter rather than whipsawing on a bad fortnight; the
  // displayed all-time record is untouched. This is the one F3 tuning knob.
  const BLEND_HALFLIFE_MS = 120 * 86400e3;
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
    // Settled-board record restore: episodes ride the same blob (see persistLedger). Shape-guarded
    // so a pre-episode blob (no `board`) hydrates exactly as before, and a corrupt entry is
    // dropped rather than crashing the boot. Open episodes whose claims resolved while the server
    // was down are NOT dropped here — the next buildActionable's sweep resolves them normally.
    if (d.board && typeof d.board === "object") {
      boardEpSince = Number.isFinite(+d.board.since) ? +d.board.since : 0;
      boardEpDropped = Number.isFinite(+d.board.dropped) ? +d.board.dropped : 0;
      if (Array.isArray(d.board.open)) for (const ep of d.board.open)
        if (ep && typeof ep.k === "string" && ep.tShow > 0 && ep.void > 0) boardEp.set(ep.k, ep);
      if (Array.isArray(d.board.closed))
        boardEpClosed = d.board.closed.filter((e) => e && typeof e.k === "string" && e.kind && Number.isFinite(e.rE)).slice(-BOARD_EP_KEEP);
      // Evaluation stamps survive restarts — a deploy is not an evaluation, and rehydrated stamps
      // keep actEvalBoot from lower-bounding claims a previous process already timed properly.
      if (Array.isArray(d.board.evalT)) for (const t of d.board.evalT)
        if (Array.isArray(t) && typeof t[0] === "string" && Number.isFinite(t[1])) actEval.set(t[0], { t: t[1], b: t[2] ? 1 : 0 });
      // First-cohort repair, idempotent: episodes stamped on the record's very first scan
      // (tShow === the epoch itself) whose claims fired well before it were opened against rows
      // that may have been visible before the feature existed. Their shown stamp is the
      // feature's boot, not a surfacing — retro-marked bt so the headline lateness never blames
      // the board's gates for the record's own birth.
      { let fx = 0;
        const firstCohort = (e) => !e.bt && boardEpSince > 0 && e.tShow === boardEpSince
          && Number.isFinite(e.tFire) && e.tShow - e.tFire > BOARD_EP_BT_MS;
        for (const e of boardEpClosed) if (firstCohort(e)) { e.bt = 1; fx++; }
        for (const e of boardEp.values()) if (firstCohort(e)) { e.bt = 1; fx++; }
        if (fx) { ledgerDirty = true; log(`Settled-record repair: ${fx} first-cohort episode(s) retro-stamped bt — excluded from headline lateness`); } }
    }
    // Pre-epoch crypto purge. The -101 removal un-enrolled the main universe and dropped its
    // stored claims wholesale. The engine is back (2026.07.26-08) with log-space geometry, so the
    // purge is no longer permanent — but it is not lifted either: every crypto claim stamped
    // BEFORE the epoch was opened under the additive arithmetic that produced negative targets and
    // voids multiples of price away. Re-admitting those would seed a supposedly out-of-sample
    // record with exactly the fabrications claimGeometryOk now refuses, and the ledger's whole
    // worth is that its record is honest. So the era is dropped and the new engine starts from a
    // real zero. Universe is structural (xyz coins carry ":" in the id, main coins do not);
    // airead is exempt as always. Idempotent — after the first boot there is nothing left to drop.
    {
      const preEpoch = (e) => e && e.coin && !String(e.coin).includes(":") && e.ev !== "airead"
        && !(+e.t0 >= CRYPTO_EPOCH);
      let pOpen = 0, pClosed = 0;
      for (const [k, e] of [...ledgerOpen]) if (preEpoch(e)) { ledgerOpen.delete(k); pOpen++; }
      const kept = ledgerClosed.filter((e) => !preEpoch(e));
      pClosed = ledgerClosed.length - kept.length;
      ledgerClosed = kept;
      if (pOpen || pClosed) { ledgerDirty = true; log(`Pre-epoch crypto purge: dropped ${pOpen} open and ${pClosed} closed crypto claim(s) opened before the geometry fix (airead kept)`); }
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
    // Same purge for the episode/presence bookkeeping keyed `coin|ev...` — a crypto key here
    // would re-arm or restamp an episode for an engine that no longer exists.
    const cryptoKey = (k) => { const bar = k.indexOf("|"); return bar > 0 && !k.slice(0, bar).includes(":") && !k.slice(bar + 1).startsWith("airead"); };
    if (Array.isArray(d.rearm)) for (const k of d.rearm) if (typeof k === "string" && !cryptoKey(k)) rearm.add(k);
    // Presence timelines: a restart must not restamp "since when this condition has been true".
    // Restored entries resume their episode; keys whose condition no longer holds are GC'd on
    // the first build. Only a key with NO saved timeline (first deploy of this feature, or a
    // lost volume) starts observation at boot, and that one is flagged in the payload.
    if (Array.isArray(d.present)) for (const p of d.present)
      if (Array.isArray(p) && typeof p[0] === "string" && !cryptoKey(p[0]) && Number.isFinite(p[1])) presentSince.set(p[0], { t: p[1], b: false });
    if (d.variants) for (const ev in variantState)
      if (d.variants[ev] && Number.isInteger(d.variants[ev].inc) && d.variants[ev].inc >= 0 && d.variants[ev].inc < VARIANTS[ev].vals.length)
        variantState[ev] = { inc: d.variants[ev].inc, hist: Array.isArray(d.variants[ev].hist) ? d.variants[ev].hist.slice(-20) : [] };
    recomputeRecord();
  }
  function persistLedger() {
    if (!ledgerDirty) return;
    store.saveLedger({ ts: Date.now(), open: [...ledgerOpen.values()], closed: ledgerClosed.slice(-4000), variants: variantState, rearm: [...rearm],
      present: [...presentSince].map(([k, v]) => [k, v.t]),   // presence timelines survive restarts — a deploy is not a lapse
      board: { since: boardEpSince, dropped: boardEpDropped, open: [...boardEp.values()], closed: boardEpClosed.slice(-BOARD_EP_KEEP),
        evalT: [...actEval].map(([k, v]) => [k, v.t, v.b ? 1 : 0]) } });   // the board's own record rides the same blob — no new storage surface
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
  function getLedgerFor(coin, ev, isAdmin) {
    if (!coin && !ev) return { coin: "", ev: "", ticker: "", open: [], closed: [], ts: Date.now() };
    // Universe slice (2026.08.03-02): a caller without a universe's signals scope gets NO claims
    // from it — a coin-addressed query into the hidden universe returns the empty shape (same as a
    // name with no history: the claims do not exist for this audience), and an event-only query is
    // row-filtered so a "both"-universe event cannot smuggle hidden-universe rows out sideways.
    const vis = featureScopeVis(featureFlags, "signals", !!isAdmin);
    if (!vis.all && coin && !vis[coinScope(coin)])
      return { coin, ev: ev || "", ticker: "", open: [], closed: [], ts: Date.now() };
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
    const match = (e) => e.vi == null && (!coin || e.coin === coin) && (!ev || e.ev === ev)
      && (vis.all || vis[coinScope(e.coin)]);
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
  function getLedgerExport(isAdmin) {
    // Universe slice (2026.08.03-02): the export's job is completeness OF WHAT THIS AUDIENCE MAY
    // SEE. A scoped caller's dump excludes hidden-universe entries entirely (shadow variants of
    // those claims included — a vi row still names the coin), and the counts describe the shipped
    // file, not the withheld one.
    const vis = featureScopeVis(featureFlags, "signals", !!isAdmin);
    const inScope = (e) => vis.all || vis[coinScope(e.coin)];
    const closed = vis.all ? ledgerClosed : ledgerClosed.filter(inScope);
    const open = [...ledgerOpen.values()].filter(inScope);
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
          tgt: "playbook target level frozen at fire (absolute price)",
          alo: "this claim's opening was announced to the alert transports", als: "its void level has been announced as taken",
          alt: "its target has been announced as reached",
          score0: "signal score at fire", pr: "prime flag at fire", conf: "confluence flag at fire",
          bt: "opened on the first post-boot build (condition may predate the stamp)", eg: "episode-gap flag",
          tal: "daily trend ribbon aligned with the claim's side at fire (1/0; absent = unknown at fire)",
          realized: "at-horizon outcome, play-signed, in the event's unit",
          realizedS: "stop-aware outcome (void-level-capped)", stopped: "void level touched before horizon",
          tm: "touch-mode claim: first touch of the frozen target or void resolves it (untouched -> at-horizon mark at the timeout)",
          rb: "bracket outcome: t = target touched first, s = void touched first, m = neither (at-horizon)",
          amb: "bracket resolution was ambiguous: the resolving candle straddled BOTH frozen levels in one bar and was conservatively called a stop (F9 measurement — the outcome is unchanged, only flagged)",
          realizedB: "bracket-track outcome — capped at whichever frozen level was touched FIRST, at-horizon otherwise (symmetric fix to the stop-only cap; accrues from build -20)",
          r2: "MA200 regime at fire: +2 mark above MA200, +1 MA200 rising (3..0); absent = under 210 daily closes at fire",
          vr: "vol-regime percentile at fire: current 10d realized vol's rank within its trailing-120 baseline (0..100; absent = under 140 daily closes at fire)",
          ib: "breakout/breakdown only: the cross was intrabar at fire — only the live mark cleared the level, the last COMPLETED daily close had not (the study counts close-confirmed crosses; recorded, never gated)",
          fnd: "funding rate at fire", fndP: "funding percentile vs this market's own 31d hourly history (>=96 samples)",
          oi5: "5d open-interest change % at fire", rngP: "position in the 30d range at fire (0=low, 1=high)",
          mktR: "benchmark 24h move % at fire (BTC for the crypto universe, the SPX proxy for xyz)",
          gw: "gapfade shadow only: void width as a multiple of the market's own gap σ (1.0 or 1.5)",
          emv: "pead shadow only: the frozen earnings-reaction move, %",
          lvn: "structural-void families (lvlhold/lvlrej/squeeze2/unwind2): confirmed pivot touches on the anchoring cluster at fire",
          lva: "structural-void families: days since that cluster's most recent touch, at fire",
          vpw: "volume-node families (vphold/vprej): the anchoring node's share of total profile volume at fire, %",
          rm: "airead only: the model that authored the read (analyst accountability claims)",
          ses: "session bucket at fire, xyz only (rth / on / wknd)", dow: "UTC day-of-week at fire (0=Sun)",
        },
      },
      closed, open,
      variants: { state: variantState, stats: variantStats },
      ts: Date.now(),
    };
  }
  // Universe-aware: the session-calendar branches are xyz by construction (the events that use
  // them do not run on a 24/7 tape at all), and every other event reads evMeta, which serves the
  // compressed crypto clock for main rows. Wall-clock only for crypto — no calendar walk, because
  // there is no calendar.
  function resolveAtFor(ev, t0, uni) {
    if (uni !== "main") {
      if (ev === "gap" || ev === "gapfade") {   // resolves at the close of the next cash session after firing
        for (const ses of marketSessions(t0, t0 + 6 * DAY)) if (ses.close > t0 && ses.open > t0) return ses.close;
        return t0 + 3 * DAY;
      }
      if (ev === "ondrift") {
        let n = 0;
        for (const ses of marketSessions(t0, t0 + 20 * DAY)) { if (ses.close <= t0) continue; n++; if (n === 6) return ses.open; }
        return t0 + 10 * DAY;
      }
    }
    const m = evMeta(ev, uni);
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
  // the fire-time context stamp and the AI report's crypto positioning read so no two
  // consumers can disagree.
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
      // Crypto has no session, but it does have a liquidity clock: the Asia / Europe / US-overlap
      // split is the closest honest analogue, and it is the slice most likely to explain a crypto
      // event's record (a cascade at 04:00 UTC is a different animal from one at 14:00). UTC hour
      // buckets, not exchange sessions — nothing here pretends a venue opens or closes.
      if (r.uni === "main") {
        const h = new Date(t0).getUTCHours();
        c.hod = h < 7 ? "asia" : (h < 12 ? "eu" : (h < 21 ? "us" : "late"));
      }
    } catch (_) {}
    return c;
  }
  // Set when a REAL (vi==null) claim opens during a signals pass; consumed at the pass's end to
  // chain an immediate actionable rebuild (2026.08.03-07). A flag, not a call: openLedger runs
  // mid-pass with the ledger under mutation, and a bare buildActionable from here is exactly the
  // interleave chainBuild exists to forbid.
  let actKick = false;
  function openLedger(r, ev, sigEntry, dir, extra, vi) {
    // Universe enrollment, single-sourced through evAllowed: the crypto side runs the whitelisted
    // roster (MAIN_EVS) and nothing else, the equity side runs everything except the two
    // crypto-native events. Belt to the fire sites' suspenders — even a caller that forgets the
    // rule cannot ledger an event its universe does not run.
    if (r && !evAllowed(r.uni, ev)) return null;
    const key = r.coin + "|" + ev + (vi != null ? "#" + vi : "");
    const main = r && r.uni === "main";
    // mv = playbook-target distance from the mark at fire time, in % — lets the record be
    // sliced by actionable magnitude, matching the client's move filter exactly.
    const psd0 = sigEntry.play && (sigEntry.play.side === "long" || sigEntry.play.side === "short")
      ? sigEntry.play.side : (extra && extra.psd) || null;
    // Crypto claim-geometry gate: at 12-40%/day the loss-side check alone lets through voids a
    // hair from the mark and targets that are pure artifact. Levels that fail the gate are simply
    // NOT stamped — the claim still opens and resolves at-horizon, which is the honest degradation.
    // A refusal here is logged nowhere and costs nothing; stamping a bad level cost the whole
    // crypto engine last time. xyz keeps the original loss-side-only rule so its record stays
    // comparable across this build.
    const sdG = extra && extra.sd0 > 0 ? extra.sd0 : null;
    const geoOk = (lvl, kind) => {
      if (lvl == null || !(lvl > 0) || !(r.px > 0)) return false;
      if (!main) return true;
      if (!psd0) return false;   // crypto levels require a known side to be gated at all
      return kind === "stop"
        ? claimGeometryOk(psd0, r.px, lvl, null, sdG)
        : claimGeometryOk(psd0, r.px, null, lvl, sdG);
    };
    const tgt0 = sigEntry.play && sigEntry.play.target != null && geoOk(sigEntry.play.target, "target")
      ? sigEntry.play.target : null;
    const mv = vi == null && tgt0 != null && r.px > 0
      ? +(Math.abs(tgt0 / r.px - 1) * 100).toFixed(2) : null;
    const stp = vi == null && sigEntry.play && sigEntry.play.stop != null && geoOk(sigEntry.play.stop, "stop")
      ? +(+sigEntry.play.stop).toPrecision(6) : null;   // void level frozen at fire — the stop-aware track resolves against it
    // Forensic marker: a level WAS offered and the gate refused it. Distinguishes "this event type
    // has no void" (fundflip) from "this claim's void was an artifact" (a collapsed coin's range
    // arithmetic) when the record is audited later. Same key the hydrate repair uses.
    const geoRefused = main && vi == null && sigEntry.play
      && ((sigEntry.play.stop != null && stp == null) || (sigEntry.play.target != null && tgt0 == null));
    const psd = vi == null ? psd0 : null;   // trade side per the playbook; e.dir is the EVENT sign (a gap-fader's dir is the gap, not the trade)
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
        resolveAt: resolveAtFor(ev, Date.now(), r.uni),
      }, signalsBuildCount <= 1 ? { bt: 1 } : null,   // opened on the FIRST build after a restart/deploy: the condition may predate this stamp — flagged so identical boot-time timestamps explain themselves
      vi != null ? { vi } : null, mv != null ? { mv } : null,
      // The absolute target, frozen alongside the void. `mv` is a rounded distance and cannot be
      // turned back into a price without drift, and the level alerts must compare against exactly
      // the number the claim published — not a reconstruction of it.
      tgt0 != null && vi == null ? { tgt: tgt0 } : null,
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
      // Crypto geometry scrub, AFTER extra has been folded in. The shadow fire sites hand their
      // stop and target distance through `extra`, which lands past the visible path's gate — so
      // the gate is applied once more here, against the assembled entry, where every source of a
      // level has already written. Deliberately NOT gated on `vi`: shadows are exactly the path
      // that bypasses the visible check, so exempting them would leave the hole this block exists
      // to close. A failing void drops the stop-aware leg (gv marks it for forensics, matching the
      // hydrate repair's convention); a failing target drops mv, so the frozen-target
      // reconstruction downstream yields null rather than an artifact price.
      if (main) {
        const sideE = e.psd || (e.dir >= 0 ? "long" : "short");
        const sdE = e.sd0 > 0 ? e.sd0 : null;
        if (e.stp != null && !claimGeometryOk(sideE, e.mark0, e.stp, null, sdE)) { e.gv = 1; delete e.stp; }
        if (e.mv != null && e.mark0 > 0) {
          const tE = e.mark0 * (1 + (sideE === "long" ? 1 : -1) * e.mv / 100);
          if (!claimGeometryOk(sideE, e.mark0, null, tE, sdE)) { e.gv = 1; delete e.mv; }
        }
        // Touch-mode claims (-20) carry an ABSOLUTE frozen target through `extra` — gate it like
        // every other level. A failing target drops touch mode with it: first-touch resolution
        // against an artifact level is worse than no resolution convention at all; the claim
        // degrades to the at-horizon mark, which is the honest fallback everywhere else.
        if (e.tgt != null && !claimGeometryOk(sideE, e.mark0, null, e.tgt, sdE)) { e.gv = 1; delete e.tgt; delete e.tm; }
        if (geoRefused) e.gv = 1;
      }
      // MA200 regime at fire (-20): stamped for every claim (shadows included) when the row's
      // daily depth allows it — 2 = mark above the MA200, +1 = MA200 rising; absent = under 210
      // daily closes at fire, an honest unknown. Computed once per row per build in pass 2 and
      // read here so a per-fire MA walk never happens. The record SPLITS by this later; nothing
      // gates on it — whether below-200 pullbacks deserve exclusion is the ledger's question.
      if (r._r2 != null) e.r2 = r._r2;
      if (r._vr != null) e.vr = r._vr;   // vol-regime percentile at fire (F-vr) — recorded for later conditioned splits
      ledgerOpen.set(key, e); ledgerDirty = true;
      if (vi == null) actKick = true;   // a real claim opened -> the board's inputs changed NOW, not at the next timer
    }
    return e;
  }
  function resolveLedger() {
    const now = Date.now();
    for (const [key, e] of ledgerOpen) {
      // Touch-mode claims (-20) are scanned EVERY pass: a target hit on day 3 resolves on day 3,
      // not day 30 — the record accrues at the pace the trades actually conclude. Everything else
      // keeps the fixed-horizon gate unchanged.
      if (now < e.resolveAt && !(e.tm === 1 && e.stp != null && e.tgt != null)) continue;
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
        const sideE = e.psd || (e.dir >= 0 ? "long" : "short");
        // Touch-mode resolution (-20): the first touch of the frozen target or void IS the
        // outcome (bracketTouch — conservative: a candle touching both counts as the stop). No
        // touch yet and the timeout not reached -> the claim stays live. Untouched at the
        // timeout -> the same at-horizon mark every other claim records ("went nowhere" over a
        // 30d window is real information, not a void). tEnd is the claim's ACTUAL window end —
        // the touch time on an early resolution — and the BTC-excess leg reads it too, so the
        // benchmark is measured over exactly the days the claim was alive.
        let tEnd = e.resolveAt, pTouch = null;
        if (e.tm === 1 && e.stp != null && e.tgt != null) {
          const br = bracketTouch(hs, e.t0, Math.min(e.resolveAt, now), sideE, e.stp, e.tgt);
          if (br) { pTouch = br.level; tEnd = br.t; e.rb = br.hit === "target" ? "t" : "s"; if (br.amb) e.amb = 1; }   // F9: same-bar both-touch flagged
          else if (now < e.resolveAt) continue;
          else e.rb = "m";
        }
        const p0 = priceAsOf(hs, e.t0, 3 * HOUR) || e.mark0;
        const p1 = pTouch != null ? pTouch : priceAsOf(hs, tEnd, 3 * HOUR);
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
          if (e.tm === 1 && e.rb) {
            // Touch-mode: the bracket walk already decided the outcome — realized IS the touched
            // level's distance (or the at-horizon mark on "m"), so the stop-disciplined leg
            // coincides with it by construction. No second walk, no way to disagree.
            e.stopped = e.rb === "s";
            e.realizedS = realized;
          } else if (e.stp != null) {
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
          // Symmetric bracket track (-20): the stop-aware leg caps the void but lets a target
          // touch evaporate by horizon — a one-sided discipline that biased every stop-aware
          // record downward, worst on exactly the slow setups the swing work exists for.
          // realizedB caps BOTH sides: first touch of either frozen level is the outcome,
          // at-horizon otherwise. Accrues from this build forward on any claim carrying both
          // levels (n trails, same posture as when stop-tracking began at -22). Touch-mode
          // claims coincide with their own resolution by construction.
          if (e.tm === 1 && e.rb) e.realizedB = realized;
          else if (e.stp != null && e.tgt != null && e.gv !== 1) {
            const br = bracketTouch(hs, e.t0, e.resolveAt, sideE, e.stp, e.tgt);
            e.rb = br ? (br.hit === "target" ? "t" : "s") : "m";
            if (br && br.amb) e.amb = 1;   // F9: same-bar both-touch flagged on the bracket track
            e.realizedB = br ? +(sgn * (br.level / p0 - 1) * 100).toFixed(2) : realized;
          }
          // Sigma-normalize EVERY R-united claim: the studies claim in R, so the ledger must
          // resolve in R. The original condition listed only bigmove/breakout/fundflip —
          // breakdown/oiflush/fpdiv joined the roster later with sd0 stamped but never applied,
          // so their raw-% outcomes contaminated the R aggregates, the claim curve, and the
          // study↔live Bayesian blend. rn=1 marks the entry as resolved-normalized (the epoch
          // marker the hydrate-time repair of stored entries keys on).
          if (R_LEDGER_EVS.has(e.ev) && e.sd0 > 0) {
            const rawB = e.realizedB;   // captured before `realized` is rescaled below
            if (rawB != null) e.realizedB = e.rb === "m" ? null : +(rawB / e.sd0).toFixed(2);   // "m" leg re-tied to the normalized realized just after
            realized = +(realized / e.sd0).toFixed(2);   // same R units the study claims — claimed vs live stays apples-to-apples
            if (e.realizedB === null) e.realizedB = realized;   // the at-horizon bracket leg IS realized, in whatever unit realized is in
            if (e.realizedS != null) e.realizedS = e.stopped ? +(e.realizedS / e.sd0).toFixed(2) : realized;
            e.rn = 1;
          }
          // ---- BTC-excess leg (crypto only) --------------------------------------------------
          // Sixty perps at ~0.8 correlation to BTC means a raw record measures the tape at least
          // as much as the signal: forty longs firing into a green week all "win" for one reason.
          // So every crypto claim resolves TWICE — raw, and net of BTC's move over the claim's own
          // exact window, both in the same units. rx is the honest read of whether the event added
          // anything beyond being long crypto; raw stays the headline because it is what a trade
          // would have returned. Absent when BTC's spine can't cover the window — an honest gap,
          // never a zero (a null rx and rx=0 mean opposite things).
          if (e.coin && !String(e.coin).includes(":") && e.coin !== MAIN_BENCH) {
            const bh = getHourly(MAIN_BENCH);
            const b0 = priceAsOf(bh, e.t0, 3 * HOUR), b1 = priceAsOf(bh, tEnd, 3 * HOUR);   // tEnd = touch time on an early touch-mode resolution — the benchmark covers exactly the claim's live window
            if (b0 > 0 && b1 > 0) {
              const bench = (b1 / b0 - 1) * 100;
              let rx = sgn * ((p1 / p0 - 1) * 100 - bench);   // same side sign the raw leg used
              if (R_LEDGER_EVS.has(e.ev) && e.sd0 > 0) rx = rx / e.sd0;
              e.rx = +rx.toFixed(2);
              e.bmv = +bench.toFixed(2);   // BTC's own move over the window, for the autopsy
            }
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
      // Close the loop for anyone who was told this claim opened. Emitted HERE, inside the
      // resolver's own close path, so the number in the message is the number that entered the
      // record — a separate scan reading the closed list later could disagree with it.
      if (e.alo === 1 && e.vi == null) emitLedgerEvent(e, "resolved", null, now);
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
      const b = per[e.ev] || (per[e.ev] = { resolved: 0, wins: 0, rets: [], claims: [], retsS: [], winsS: 0, stopped: 0, nS: 0, ents: [], retsX: [], winsX: 0, retsB: [], winsB: 0, tchT: 0, tchS: 0, tchM: 0, amb: 0 });
      b.resolved++; if (e.win) b.wins++; b.rets.push(e.realized);
      b.ents.push(e);
      // BTC-excess leg, crypto only (rx is stamped only for main claims). Kept in its own bucket
      // so the raw record never silently becomes an excess record — they answer different
      // questions and the panel shows both.
      if (e.rx != null && Number.isFinite(e.rx)) { b.retsX.push(e.rx); if (e.rx > 0) b.winsX++; }
      if (e.realizedS != null) { b.nS++; b.retsS.push(e.realizedS); if (e.winS) b.winsS++; if (e.stopped) b.stopped++; }
      // symmetric bracket leg (-20): outcomes capped at whichever frozen level was touched FIRST
      if (e.realizedB != null && Number.isFinite(e.realizedB)) {
        b.retsB.push(e.realizedB); if (e.realizedB > 0) b.winsB++;
        if (e.rb === "t") b.tchT++; else if (e.rb === "s") b.tchS++; else b.tchM++;
        if (e.amb === 1) b.amb++;   // F9: same-bar both-touch ambiguities (resolved conservatively to stop)
      }
      if (e.claim && Number.isFinite(e.claim.med)) b.claims.push(e.claim.med);
    }
    const out = {};
    // F3 (2026.07.30-05): the score's live-record blend should weight RECENT resolutions more —
    // a signal whose edge decayed six months ago keeps earning glory-days points until enough
    // losers dilute an all-time mean, which at n=200 takes a long time. avgR/hitR are the same
    // outcomes weighted by exp(-age/halflife) on each resolution's resolve time (tR). ONLY the
    // blend reads these; the displayed record (avg/hit) stays honest all-time, so the panel never
    // silently redefines "the record" while the score quietly tracks the recent slice. A single
    // conservative half-life (BLEND_HALFLIFE_MS) — long enough that recency is a gentle tilt, not
    // a short-memory whipsaw; it is the one tuning knob and is documented as such.
    const nowRW = Date.now();
    for (const ev in per) {
      const b = per[ev], sm = summarizeEvents(b.rets);
      const w = b.rets.filter((x) => x > 0), l = b.rets.filter((x) => x <= 0);
      const wSum = w.reduce((a, c) => a + c, 0), lSum = l.reduce((a, c) => a + c, 0);
      // recency-weighted mean outcome + hit over this event's resolved entries
      let rwW = 0, rwR = 0, rwWin = 0;
      for (const e of b.ents) {
        if (!Number.isFinite(e.realized)) continue;
        const age = Math.max(0, nowRW - (+e.tR || +e.t0 || nowRW));
        const wt = Math.exp(-age / BLEND_HALFLIFE_MS);
        rwW += wt; rwR += wt * e.realized; if (e.realized > 0) rwWin += wt;
      }
      out[ev] = { resolved: b.resolved, hit: b.resolved ? +(b.wins / b.resolved).toFixed(2) : null,
        med: sm.n ? sm.med : null, avg: sm.n ? sm.avg : null,
        avgR: rwW > 0 ? +(rwR / rwW).toFixed(3) : null,   // F3: recency-weighted mean — blend-only
        hitR: rwW > 0 ? +(rwWin / rwW).toFixed(3) : null, // F3: recency-weighted hit share — blend-only
        avgWin: w.length ? +(wSum / w.length).toFixed(2) : null,
        avgLoss: l.length ? +(lSum / l.length).toFixed(2) : null,
        pf: w.length && l.length && lSum !== 0 ? +(wSum / Math.abs(lSum)).toFixed(2) : null,   // profit factor: gross wins / gross losses
        claimMed: b.claims.length ? +(b.claims.reduce((a, c) => a + c, 0) / b.claims.length).toFixed(2) : null,
        // Independence disclosure. n counts claims; cl counts the distinct UTC days they fired on.
        // On a universe correlated ~0.8 to one benchmark these diverge hard — forty longs opened
        // into one green day is n=40 and cl=1, and reading that as forty independent draws is the
        // single easiest way to fool yourself with this ledger. Shown next to n, always.
        cl: clusterDays(b.ents),
        open: 0, unit: unitOf(ev) };
      if (b.retsX.length) {   // BTC-excess parallel track: did the event beat simply being long crypto
        const smX = summarizeEvents(b.retsX);
        Object.assign(out[ev], { nX: b.retsX.length, hitX: +(b.winsX / b.retsX.length).toFixed(2),
          medX: smX.n ? smX.med : null, avgX: smX.n ? smX.avg : null });
      }
      if (b.nS) {   // stop-aware parallel track: outcome had the void level been honored as a stop
        const smS = summarizeEvents(b.retsS);
        const wS = b.retsS.filter((x) => x > 0), lS = b.retsS.filter((x) => x <= 0);
        const wsSum = wS.reduce((a, c) => a + c, 0), lsSum = lS.reduce((a, c) => a + c, 0);
        Object.assign(out[ev], { nS: b.nS, hitS: +(b.winsS / b.nS).toFixed(2), medS: smS.n ? smS.med : null,
          avgS: smS.n ? smS.avg : null, pfS: wS.length && lS.length && lsSum !== 0 ? +(wsSum / Math.abs(lsSum)).toFixed(2) : null,
          stopped: b.stopped });
      }
      if (b.retsB.length) {   // bracket track (-20): both frozen levels honored, first touch wins
        const smB = summarizeEvents(b.retsB);
        const wB = b.retsB.filter((x) => x > 0), lB = b.retsB.filter((x) => x <= 0);
        const wbSum = wB.reduce((a, c) => a + c, 0), lbSum = lB.reduce((a, c) => a + c, 0);
        Object.assign(out[ev], { nB: b.retsB.length, hitB: +(b.winsB / b.retsB.length).toFixed(2),
          medB: smB.n ? smB.med : null, avgB: smB.n ? smB.avg : null,
          pfB: wB.length && lB.length && lbSum !== 0 ? +(wbSum / Math.abs(lbSum)).toFixed(2) : null,
          tchT: b.tchT, tchS: b.tchS, tchM: b.tchM, amb: b.amb });
      }
    }
    for (const e of openEntries) (out[e.ev] || (out[e.ev] = { resolved: 0, hit: null, med: null, avg: null, claimMed: null, open: 0, unit: unitOf(e.ev) })).open++;
    const cf = { confN: 0, confW: 0, soloN: 0, soloW: 0, confRn: 0, soloRn: 0, confR: 0, soloR: 0 };
    for (const e of res) {
      if (typeof e.conf !== "boolean") continue;
      // Hit counts span every ledgered event (hit rate is unit-agnostic). The avg-R lift, though,
      // must NOT mix a +2% gap fade with a +1.5R breakout in one mean — it is accumulated over
      // R-united events ONLY, with its own n (confRn/soloRn). A pure-% coin therefore contributes
      // to the hit comparison but not the R comparison, which is the honest split.
      const isR = R_UNIT_EVS.has(e.ev) && Number.isFinite(e.realized);
      if (e.conf) { cf.confN++; if (e.win) cf.confW++; if (isR) { cf.confRn++; cf.confR += e.realized; } }
      else { cf.soloN++; if (e.win) cf.soloW++; if (isR) { cf.soloRn++; cf.soloR += e.realized; } }
    }
    const conf = { confN: cf.confN, confHit: cf.confN ? +(cf.confW / cf.confN).toFixed(2) : null,
      soloN: cf.soloN, soloHit: cf.soloN ? +(cf.soloW / cf.soloN).toFixed(2) : null,
      confAvg: cf.confRn ? +(cf.confR / cf.confRn).toFixed(3) : null,
      soloAvg: cf.soloRn ? +(cf.soloR / cf.soloRn).toFixed(3) : null,
      confRn: cf.confRn, soloRn: cf.soloRn };
    // F8 (2026.07.30-04): the earned bonus is driven by the AVG-R lift of with-company firings
    // over solo ones, not the hit-rate lift alone — confluence that raises hit while shrinking
    // average R is not an edge worth a score bonus. BOTH lifts must be non-negative to pay at all
    // (a hit gain bought with expectancy loss earns zero); the magnitude scales on the R lift.
    // The R lift needs its own >=15/15 floor (confRn/soloRn) because a coin roster heavy in %
    // events could clear the hit floor while the R comparison is still too thin to trust. When the
    // R evidence is thin but the hit floor is met, fall back to a gated flat bonus on hit lift
    // alone (never the old hit-magnitude scaling). Below the hit floor, the flat default (8) stands.
    if (conf.confN >= 15 && conf.soloN >= 15) {
      const hitLift = conf.confHit - conf.soloHit;
      if (conf.confRn >= 15 && conf.soloRn >= 15) {
        const avgLift = conf.confAvg - conf.soloAvg;
        conf.bonus = hitLift >= 0 && avgLift >= 0 ? Math.max(0, Math.round(avgLift * 20)) : 0;
      } else conf.bonus = hitLift > 0 ? 8 : 0;   // thin R evidence: proven-positive hit lift earns the flat unit, nothing speculative
    } else conf.bonus = 8;
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
  const R_LEDGER_EVS = new Set(["bigmove", "breakout", "breakdown", "fundflip", "oiflush", "fpdiv", "reclaim", "mapull", "failbrk", "pead", "sweep", "airead", "casc", "fundext", "swpull", "basebrk", "basepj", "emabrk", "emarts", "lvlhold", "lvlrej", "squeeze2", "unwind2", "vphold", "vprej"]);
  function recomputeRecord() {
    // Unit-epoch guard: entries opened before sigma-normalization (-16) lack sd0 and were
    // resolved in %, while the studies now claim in R. Mixing them poisons medians, averages,
    // the claimed column, the curve, and the blend — so they are excluded from ALL aggregates.
    const unitOk = (e) => !R_LEDGER_EVS.has(e.ev) || e.sd0 > 0;
    const resolved = ledgerClosed.filter((e) => e.status === "resolved" && e.vi == null && unitOk(e));
    const openReal = [...ledgerOpen.values()].filter((e) => e.vi == null);
    recordSets = {};
    const uniOf = (x) => x.coin && x.coin.includes(":") ? "x" : "m";
    for (const t of MV_THRESHOLDS) for (const pr of [false, true]) {
      const f = (x) => (t === 0 || (x.mv != null && x.mv >= t)) && (!pr || x.pr === true);
      const key = String(t) + (pr ? "p" : "");
      recordSets[key] = buildRecordSet(resolved.filter(f), openReal.filter(f));
      // per-universe splits (hard-separated tab views): identical machinery, filtered claims —
      // by-event records, slices, confluence AND recent resolutions all fall out per universe
      for (const u of ["m", "x"])
        recordSets[key + u] = buildRecordSet(resolved.filter((e) => f(e) && uniOf(e) === u), openReal.filter((e) => f(e) && uniOf(e) === u));
    }
    recordCache = recordSets["0"].record;       // full record: confluence bonus + anything not universe-scoped
    // F1 (2026.07.30-02): the study<->live Bayesian blend and the no-edge guard read the record of
    // the FIRING claim's OWN universe, never the mixed pot. A crypto bigmove resolves on a 12h clock
    // and an equity bigmove on a 1d clock (EV_META_MAIN) — blending an equity score toward crypto's
    // record (or vice versa) is exactly the cross-universe contamination the tab split already
    // refuses to render, leaking into the SCORE. recordCacheU carries the two scoped records so the
    // score honours the same wall the panels do. Scoped-ONLY by decision: a thin universe record
    // migrates trust slowly (the cl-weighted shrinkage below keeps a 2-day record near-weightless),
    // which is the honest behaviour; the ONLY fallback to the full pot is a genuinely empty scoped
    // set (crypto disabled -> no "x" claims ever), handled at the read site.
    recordCacheU = { m: recordSets["0m"].record, x: recordSets["0x"].record };
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
      if (!rets || !rets.length) return { n: 0, hit: null, avg: null, sd: null };
      const sm = summarizeEvents(rets);
      return { n: sm.n, hit: +(rets.filter((x) => x > 0).length / rets.length).toFixed(2), avg: sm.avg,
        sd: rets.length >= 2 ? +stdev(rets.filter(Number.isFinite)).toFixed(3) : null };   // dispersion for the SE-scaled promotion margin (F4)
    });
  }
  // The live record the score should read for a claim in universe `uni`. Scoped to the firing
  // claim's own universe (F1); falls back to the full record ONLY when the scoped set is genuinely
  // absent — i.e. crypto disabled, so the "x" record was never built and no "x" claim can ever
  // resolve. A merely THIN scoped record is used as-is: the cl-weighted shrinkage keeps it from
  // moving the score much until real resolutions accrue, which is the honest slow migration.
  function recFor(uni) {
    if (!recordCacheU) return recordCache;
    const scoped = uni === "main" ? recordCacheU.m : recordCacheU.x;
    return scoped || recordCache;   // {} is a valid (empty) scoped record and is kept; only null/undefined falls back
  }
  function liveNoEdge(ev, uni) {
    const src = recFor(uni), rec = src && src[ev];
    return !!(rec && rec.resolved >= 10 && rec.hit != null && rec.hit < 0.5 && rec.med != null && rec.med <= 0);
  }
  // Prime v2 predicate (F6): the asymmetric-profile path — an R-united event whose OWN-universe
  // LIVE record shows avg>=0.35R over n>=12 with profit factor>=1.5. This is the read that lets a
  // 45%-hit/+0.5R swing strategy be prime when the ledger proves it pays, which the hard hit>=0.6
  // gate structurally forbade. Shared closure so the build and the harness exercise identical code.
  function primeV2Live(uni, ev) {
    if (unitOf(ev) !== "R") return false;
    const src = recFor(uni), lr = src && src[ev];
    return !!(lr && lr.resolved >= 12 && lr.avg != null && lr.avg >= 0.35 && lr.pf != null && lr.pf >= 1.5);
  }
  // 0..50 evidence, EXPECTANCY-centered: only base rates that actually paid (mean direction-
  // signed outcome > 0) earn points; a negative-expectancy base rate earns ZERO and flags the
  // signal, no matter how unusual the live condition looks. Hit rate only adds on top of
  // positive expectancy. This is the main noise gate: "weird but historically unprofitable"
  // now sinks instead of riding its intensity score.
  function evPts(st, unit) {
    const scale = unit === "R" ? 0.5 : 0.8;   // +0.5R/event is strong edge; +0.8%/event was the % calibration
    // Fallback branch (no avg — a claim/pool that never carried an expectancy): mirror the main
    // branch's expectancy discipline rather than rewarding raw |med|/|hit-0.5|. A -1R median and
    // a 0.20 hit rate must not score identically to +1R and 0.80 (F7). Only a positive median and
    // above-even hit earn here, same posture as avg>0 below.
    if (st.avg == null) {
      if (st.med == null || st.med <= 0) return Math.max(0, (st.hit || 0) - 0.5) * 2 * 20;
      return Math.min(1, st.med / (unit === "R" ? 1 : 1.5)) * 30 + Math.max(0, (st.hit || 0) - 0.5) * 2 * 20;
    }
    if (st.avg <= 0) return 0;
    return Math.min(1, st.avg / scale) * 30 + Math.max(0, st.hit - 0.5) * 2 * 20;
  }
  // Evidence with Bayesian shrinkage toward the LIVE out-of-sample record (of the claim's OWN
  // universe, F1). Once an event type has >=5 resolutions the stats driving the score blend the
  // in-sample base rate with the live record, weighted w = cl/(cl+25) where cl is the count of
  // distinct UTC tape-DAYS the resolutions fell on, NOT the raw claim count (F2). On a universe
  // ~0.8-correlated to one benchmark, forty longs opened into one green day are one draw, not
  // forty — weighting by cl makes the trust-migration speed match the independence the panel
  // already discloses next to n. cl falls back to `resolved` for pre-cl cached records. Trust
  // migrates continuously in both directions: a live record better than claimed earns more.
  function evidence(st, ev, pooled, unit, uni) {
    const src = recFor(uni), rec = src && src[ev];
    const scored = (stats, discount) => {
      if (rec && rec.resolved >= 5 && rec.hit != null && rec.avg != null && stats.avg != null) {
        const eff = rec.cl != null && rec.cl > 0 ? rec.cl : rec.resolved;   // independent tape-days, not claim count
        const w = eff / (eff + 25);
        // F3: blend toward the RECENCY-WEIGHTED live record (avgR/hitR). Fall back to the all-time
        // avg/hit for pre-F3 cached records that never carried the weighted fields, so a stale blob
        // degrades to the -02 behaviour rather than throwing.
        const recAvg = rec.avgR != null ? rec.avgR : rec.avg;
        const recHit = rec.hitR != null ? rec.hitR : rec.hit;
        return { pts: evPts({ avg: (1 - w) * stats.avg + w * recAvg, hit: (1 - w) * stats.hit + w * recHit }, unit) * discount,
          liveW: Math.round(w * 100) };
      }
      return { pts: evPts(stats, unit) * discount, liveW: null };
    };
    let base;
    if (st && st.n >= 8) { const b = scored(st, 1); base = { pts: b.pts, liveW: b.liveW, unproven: false, st, negexp: st.avg != null && st.avg <= 0 }; }
    else if (pooled && pooled.n >= 12) { const b = scored(pooled, 0.7); base = { pts: b.pts, liveW: b.liveW, unproven: true, st: st && st.n ? st : null, pooled, negexp: pooled.avg != null && pooled.avg <= 0 }; }
    else base = { pts: st && st.n ? 8 : 6, unproven: true, st: st && st.n ? st : null };
    base.unit = unit || "%";
    if (ev && liveNoEdge(ev, uni)) { base.pts = Math.min(base.pts, 8); base.noedge = true; }   // hard guard stays on top of the blend
    return base;
  }
  function mkSignal(r, ev, valTxt, intensity, evd, extra) {
    return Object.assign({
      coin: r.coin, ticker: r.ticker, uni: r.uni, ev, label: EV_LABEL[ev], reading: valTxt,
      score: Math.round(Math.min(50, Math.max(0, intensity)) + evd.pts),
      evp: evd.pts,   // raw evidence points — internal handle for the earnings guard, deleted before the payload ships
      unproven: !!evd.unproven, noedge: !!evd.noedge, negexp: !!evd.negexp,
      liveW: evd.liveW || null,
      study: evd.st ? { n: evd.st.n, med: evd.st.med, hit: evd.st.hit, avg: evd.st.avg, unit: evd.unit } : null,
      pooled: evd.pooled ? { n: evd.pooled.n, med: evd.pooled.med, hit: evd.pooled.hit, avg: evd.pooled.avg, unit: evd.unit } : null,
    }, extra || {});
  }

  // F4 (2026.07.30-03): re-testing every build against slowly-drifting cumulative stats is a
  // multiple-comparisons channel — tens of thousands of evaluations will eventually cross any
  // fixed line by chance. Two bounds close it: a DAILY clock (evaluate at most once per ~20h) and
  // a MIN-DWELL (a threshold promoted within the last PROMO_DWELL_MS cannot be moved again).
  // Neither is persisted: a restart merely delays the next evaluation by up to a day, which is
  // harmless — the same posture the coverage re-arm clock takes. The dwell reads the last hist
  // entry's timestamp, which IS persisted with the ledger, so a fresh promotion survives a reboot
  // with its dwell intact.
  const PROMO_CHECK_MS = 20 * 3600e3;   // at most one promotion sweep per ~20h
  const PROMO_DWELL_MS = 10 * 86400e3;  // a just-promoted threshold holds for 10 days before it can move again
  let lastPromoCheck = 0;
  function checkPromotions(force) {
    const now = Date.now();
    if (!force && now - lastPromoCheck < PROMO_CHECK_MS) return;   // daily clock: skip until the window elapses
    lastPromoCheck = now;
    for (const ev in VARIANTS) {
      const stats = variantStats[ev]; if (!stats) continue;
      const st = variantState[ev];
      // Min-dwell: if the incumbent was set within the dwell window, leave it alone. The last
      // hist entry is the most recent promotion; its `t` is the incumbent's install time.
      const lastH = st.hist && st.hist.length ? st.hist[st.hist.length - 1] : null;
      if (lastH && Number.isFinite(lastH.t) && now - lastH.t < PROMO_DWELL_MS) continue;
      const inc = st.inc, incStats = stats[inc];
      let best = null;
      for (let vi = 0; vi < VARIANTS[ev].vals.length; vi++) {
        if (vi === inc || !stats[vi]) continue;
        if (shouldPromote(incStats, stats[vi]) && (!best || stats[vi].avg > stats[best].avg)) best = vi;
      }
      if (best != null) {
        const h = { t: Date.now(), from: VARIANTS[ev].vals[inc], to: VARIANTS[ev].vals[best],
          incN: incStats.n, incAvg: incStats.avg, chN: stats[best].n, chAvg: stats[best].avg };
        st.inc = best;
        st.hist.push(h); if (st.hist.length > 20) st.hist.shift();
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
    { ev: "gapfade", uni: "xyz", label: "universal gap fade", unit: "%",
      split: [{ vi: 0, tag: "void 1.0\u03c3" }, { vi: 1, tag: "void 1.5\u03c3" }],
      tip: "every >=1\u03c3 gap, faded toward the prior close REGARDLESS of the per-name fade/continue record \u2014 the out-of-sample test of roster-wide gap mean reversion. Two void widths (1.0x and 1.5x this market's own gap \u03c3) run side by side on identical entries." },
    { ev: "reclaim", uni: "both", label: "breakdown reclaim", unit: "R",
      tip: "a fresh break of the prior 30d closing low that the mark has already reclaimed \u2014 long the sprung trap: stop at the flush low, target the measured move above the level. 5d horizon, R-united, stop-aware." },
    { ev: "failbrk", uni: "both", label: "failed-breakout fade", unit: "R",
      tip: "the short mirror: a fresh break ABOVE the prior 30d high that the mark has already lost \u2014 stop at the flush high, target the measured move below. 5d horizon. Motivated by the live record: breakout continuation ran negative expectancy." },
    { ev: "mapull", uni: "both", label: "MA50 pullback", unit: "R",
      tip: "rising 50d MA, price pulled back from >=4% above to touch it \u2014 long at the MA, stop 1\u03c3 below it, target the prior 30d closing high. 10d horizon." },
    { ev: "swpull", uni: "both", label: "swing MA50 pullback", unit: "R",
      tip: "the swing-clock MA50 pullback: rising 50d MA, a >=2\u03c3 leg to pull back from, mark at the MA band \u2014 void 1.5\u03c3 below the MA, target the NEXT STRUCTURAL LEVEL >=2\u03c3 above. Touch-resolved: the first touch of target or void closes the claim (untouched at 30d [10d crypto] resolves at the horizon mark). This is the first ledger convention that can observe a multi-week trade at all." },
    { ev: "basebrk", uni: "both", label: "base breakout \u00b7 structural target", unit: "R",
      tip: "a 60-session base (total range capped at max(8%, 3\u03c3)) broken by a fresh close the mark still holds \u2014 void 1\u03c3 back inside the base, target the next structural level above. Touch-resolved at 30d [15d crypto]. Runs in parallel with the projected-target variant on IDENTICAL detections \u2014 the record decides which target school nets more R." },
    { ev: "basepj", uni: "both", label: "base breakout \u00b7 projected target", unit: "R",
      tip: "the SAME base-breakout detection with the measured-move target: base height projected above the break \u2014 bigger, hit less often. Touch-resolved at 30d [15d crypto]. The structural-target twin ledgers beside it; neither is promoted by argument." },
    { ev: "emabrk", uni: "both", label: "EMA200 breakout (D1)", unit: "R",
      tip: "close-confirmed D1 cross of the 200-EMA, buffered: the confirming CLOSE must clear the line by >=0.25\u03c3, with four closes below immediately before (the study's re-arm written as shape \u2014 chop cannot re-fire). Void half a \u03c3 back through the line, target the next structural level >=2\u03c3 above; no level, no claim. Touch-resolved, 30d [15d crypto]. Long side only \u2014 the -26 study's strongest prior; every other definition earns its stream through that panel first." },
    { ev: "emarts", uni: "both", label: "EMA200 retest hold (D1)", unit: "R",
      tip: "the bullish 200-EMA retest: a closed D1 bar TOUCHES the line from clear air above (prior close >=0.25\u03c3 over it, prior bar untouched \u2014 first touch of the episode) and CLOSES back above. Void a full \u03c3 below the line \u2014 the hold thesis dies there \u2014 target the next structural level >=2\u03c3 above. Touch-resolved, 30d [15d crypto]. Long side only; the bearish mirror stays study-tier until the -26 panel says it earns a stream." },
    { ev: "lvlhold", uni: "both", label: "structural support hold", unit: "R",
      tip: "a CLOSED daily bar probes a confirmed sup/flip pivot cluster inside the level detector's own tau band and closes back above it, mark still holding \u2014 long the defended level. The void sits half a \u03c3 BEHIND the level: the invalidation is the level itself, not a sigma construction, which is the whole thesis under test. Target = the next confirmed cluster >=1.5\u03c3 above; no cluster on either leg, no claim. Touch-resolved at 30d [15d crypto]. Cluster touch count and age ride as recorded features (lvn/lva) so the record can split strong flips from weak 2-touch levels." },
    { ev: "lvlrej", uni: "both", label: "structural resistance reject", unit: "R",
      tip: "the short mirror: a closed daily high probes a confirmed res/flip cluster and closes back below, mark still under it \u2014 void half a \u03c3 above the level, target the next confirmed cluster >=1.5\u03c3 below. Touch-resolved at 30d [15d crypto], same lvn/lva feature stamps. Reads the TRUE highs the merged daily bars carry." },
    { ev: "vphold", uni: "both", label: "volume-node hold", unit: "R",
      tip: "the lvlhold mechanics on the OTHER honest level source: a closed daily bar probes the nearest volume node below (POC or high-volume node from the 90d-weighted profile) inside the same tau band and closes back above it \u2014 void half a \u03c3 behind the node, target the next node >=1.5\u03c3 above, VP-pure on both legs so the record measures ONE level source. Touch-resolved at 30d [15d crypto]. vpw stamps the node's share of profile volume: acceptance is the VP analogue of a touch count, and the record can split heavy shelves from thin ones later." },
    { ev: "vprej", uni: "both", label: "volume-node reject", unit: "R",
      tip: "the short mirror: a closed daily high probes the nearest node overhead and closes back below, mark still under it \u2014 void half a \u03c3 above the node, target the next node >=1.5\u03c3 below. Touch-resolved at 30d [15d crypto], same vpw stamp. Together with vphold this is the out-of-sample answer to whether volume shelves defend like pivot clusters \u2014 measured on the ledger, not argued from the chart." },
    { ev: "squeeze2", uni: "xyz", label: "short squeeze \u00b7 structural void", unit: "R",
      tip: "the squeeze's structural-void twin: fires ONLY when the visible squeeze fires, carries the SAME playbook target read verbatim, and swaps the range-formula void for the nearest confirmed cluster on the loss side (0.3\u20133\u03c3 out, stop half a \u03c3 through it). One variable isolated \u2014 the stop-aware duel against the incumbent answers whether the tight structural stop's R:R gain survives its higher tag rate. No cluster in band, no twin. 3d horizon, R-united; the incumbent's % record stays untouched." },
    { ev: "unwind2", uni: "xyz", label: "long unwind \u00b7 structural void", unit: "R",
      tip: "the unwind's structural-void twin \u2014 identical trigger and target, void on the nearest confirmed cluster overhead (0.3\u20133\u03c3, stop half a \u03c3 through). The PURRDAT case measured: a formula void at three-quarters of the 30d range vs a confirmed flip a fraction as far from entry. The record, not the chart, decides which stop earns the board. 3d horizon, R-united." },
    { ev: "pead", uni: "xyz", label: "post-earnings drift", unit: "R",
      tip: "an earnings reaction >=1.5\u03c3 of the name's own daily vol, entered only after the reaction session completes, drifting WITH the move \u2014 stop 1\u03c3 back through the reaction close. 10d horizon, stocks only; accrues at earnings-season pace." },
    { ev: "sweep", uni: "xyz", label: "liquidity sweep (5m)", unit: "R",
      tip: "the failed-break reclaim one timeframe down: a 5m wick pierces the prior session's high or low and is rejected inside the bar, the reclaim holds, and the mark is back on the origin side \u2014 a stop-run that trapped the break and reversed. Void = the sweep extreme, target = level + 1x the trap depth. 1d horizon, R-united, stop-aware. Builds forward on the 5m archive; accrues out of sample." },
  ];
  function shadowRecord() {
    const evs = new Set(STRAT_DEFS.map((d) => d.ev));
    const agg = new Map();   // ev|vi|universe -> legs; universe is structural (xyz coins carry ":")
    const bucket = (ev, vi, coin) => {
      const k = ev + "|" + (vi || 0) + "|" + (coin && coin.includes(":") ? "xyz" : "main");
      let b = agg.get(k); if (!b) { b = { r: [], s: [], open: 0 }; agg.set(k, b); } return b;
    };
    for (const e of ledgerClosed)
      if (evs.has(e.ev) && e.status === "resolved" && Number.isFinite(e.realized)) {
        const b = bucket(e.ev, e.vi, e.coin);
        b.r.push(e.realized);
        if (e.realizedS != null && isFinite(e.realizedS)) b.s.push(e.realizedS);
      }
    for (const e of ledgerOpen.values()) if (evs.has(e.ev)) bucket(e.ev, e.vi, e.coin).open++;
    const stat = (b) => !b ? { n: 0, open: 0 } : {
      n: b.r.length, open: b.open,
      hit: b.r.length ? +(b.r.filter((x) => x > 0).length / b.r.length).toFixed(2) : null,
      avg: b.r.length ? +(b.r.reduce((a, x) => a + x, 0) / b.r.length).toFixed(2) : null,
      avgS: b.s.length ? +(b.s.reduce((a, x) => a + x, 0) / b.s.length).toFixed(2) : null,
    };
    // Both panels again (2026.07.26-08). The bucket's structural universe key never changed —
    // it is what keeps a stray main entry from ever counting into an xyz aggregate — so restoring
    // the crypto panel is one extra call, not a rework. STRAT_DEFS' `uni` field decides which
    // strategies each panel lists: gapfade/pead/sweep are xyz-only because a 24/7 tape has no gap
    // and no earnings, and the crypto panel simply does not show them.
    const panel = (u) => STRAT_DEFS.filter((d) => d.uni === "both" || d.uni === u)
      .map((d) => ({ ev: d.ev, label: d.label, unit: d.unit, tip: d.tip,
        rows: (d.split || [{ vi: 0, tag: null }]).map((sp) => Object.assign({ tag: sp.tag || null }, stat(agg.get(d.ev + "|" + sp.vi + "|" + u)))) }));
    return { xyz: panel("xyz"), main: crypto ? panel("main") : null };
  }
  let signalsBuildCount = 0;   // builds since process start — build #1 is the post-boot catch-up where in-force conditions all open at once
  async function buildSignals() {
    let yN = 0;   // yield counter — one buildYield() per BUILD_YIELD_EVERY markets, both passes
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
    // Crypto gets its own pooling bucket rather than an equity asset class. classifyCached would
    // happily label a perp "Other" and pool BTC's breakout outcomes with a utility's — the small-n
    // rescue is only a rescue when the prior it borrows is from something comparable.
    const acOf = (r) => (r.uni === "main" ? "Crypto" : (classifyCached(r.ticker).assetClass || "Other"));
    let swingFails = 0, swingErr = null;   // strategy-shadow failures: counted per build, logged once, never fatal
    // per-ticker earnings prints for the pead shadow: built once per build, tiny array
    const earnPrintsByTk = new Map();
    for (const pr of earnPrints) { let a = earnPrintsByTk.get(pr.t); if (!a) { a = []; earnPrintsByTk.set(pr.t, a); } a.push(pr); }
    // pass 1: studies + pooling feed — BOTH universes (build 2026.07.26-08). The -101 removal
    // un-enrolled crypto because the additive playbook geometry produced impossible claims on
    // collapsed coins (negative price targets, voids multiples of price away). That was an
    // arithmetic bug, not a verdict on the signals, and it is fixed at the source: playbook now
    // computes crypto levels multiplicatively (ctx.logGeo) and claimGeometryOk refuses anything
    // that still lands wrong. What -87 got wrong was re-admitting EVERYTHING; this enrollment is
    // a whitelist (MAIN_EVS via evAllowed), on crypto horizons (evMeta), with the BTC-excess leg
    // and the tape-day cluster count carrying the honesty this universe specifically needs.
    // Pooling stays universe-SEPARATED: an asset-class bucket that mixed BTC with NVDA would be
    // exactly the cross-universe contamination the scope split exists to prevent.
    const prepped = [];
    for (const r of activeMarkets().concat(crypto ? mainMarkets() : [])) {
      if (r.delisted || r.px == null) continue;
      if (++yN % BUILD_YIELD_EVERY === 0) await buildYield();
      const closes = deepDaily.get(r.coin) || dc.daily[r.coin] || null, dayFunding = dc.funding[r.coin] || null;   // -28: detectors read full depth; the wire's cap is the wire's business
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
      if (++yN % BUILD_YIELD_EVERY === 0) await buildYield();
      const rets = closes ? dailyRets(closes) : [];
      const sd30 = retStd(rets.slice(-30), 15);

      if (sd30 > 0 && r.d1 != null) {
        const zMove = Math.abs(r.d1) / sd30, dir = r.d1 > 0 ? 1 : -1, vBM = incVal("bigmove");
        // shadow-ledger every variant the measure clears (incumbent included — identical bookkeeping)
        VARIANTS.bigmove.vals.forEach((v, vi) => { if (zMove >= v) openLedger(r, "bigmove", { score: 0, reading: "" }, dir, { sd0: +sd30.toFixed(3) }, vi); });
        if (zMove >= vBM) {
          const evd = evidence(st.bigmove && st.bigmove.d1, "bigmove", pooledFor(ac, "bigmove", "d1"), "R", r.uni);
          const sig = mkSignal(r, "bigmove", `${r.d1 >= 0 ? "+" : ""}${r.d1.toFixed(1)}% today (${zMove.toFixed(1)}\u03c3 ${dir > 0 ? "up" : "down"})`,
            (zMove - vBM) * 20 + 20, evd, { horizon: evMeta("bigmove", r.uni).horizon });
          { const mR = sig.study ? sig.study.med : (sig.pooled ? sig.pooled.med : null);   // R -> % via this market's own sigma
            sig.play = playbook("bigmove", { logGeo: r.uni === "main", px: r.px, dir, sd30, med: mR != null && sd30 > 0 ? mR * sd30 : null }); }
          out.push(sig); openLedger(r, "bigmove", sig, dir, { sd0: +sd30.toFixed(3) });
        }
      }
      if (closes && closes.length >= 31) {
        let hi = -Infinity;
        for (let j = closes.length - 31; j < closes.length - 1; j++) if (closes[j][1] > hi) hi = closes[j][1];
        if (hi > 0 && r.px > hi && closes[closes.length - 2][1] <= hi) {
          const evd = evidence(st.breakout && st.breakout.d5, "breakout", pooledFor(ac, "breakout", "d5"), "R", r.uni);
          const sig = mkSignal(r, "breakout", `mark ${((r.px / hi - 1) * 100).toFixed(1)}% above the prior 30d high`,
            ((r.px / hi - 1) * 100) * 12 + 15, evd, { horizon: evMeta("breakout", r.uni).horizon });
          { const mR = sig.study ? sig.study.med : (sig.pooled ? sig.pooled.med : null);
            sig.play = playbook("breakout", { logGeo: r.uni === "main", px: r.px, level: hi, med: mR != null && sd30 > 0 ? mR * sd30 : null }); }
          // F5 (2026.07.30-05): the study counts CLOSE-confirmed first crosses; this site fires on
          // the live mark. ib=1 marks a claim where only the intrabar mark cleared the level — the
          // last COMPLETED close is still at/under it — so the record can later split intrabar
          // pokes from close-confirmed breakouts and a stricter variant earns its case with data,
          // not argument. The last bar is "forming" when its UTC day hasn't ended; the completed
          // reference is that bar otherwise. Recorded, never gated.
          const ibBO = intrabarCross(closes, hi, 1, now) ? 1 : 0;
          out.push(sig); if (sd30 > 0) openLedger(r, "breakout", sig, 1, { sd0: +sd30.toFixed(3), ib: ibBO });
        }
        let lo = Infinity;
        for (let j = closes.length - 31; j < closes.length - 1; j++) if (closes[j][1] < lo) lo = closes[j][1];
        if (isFinite(lo) && lo > 0 && r.px < lo && closes[closes.length - 2][1] >= lo) {
          const evd = evidence(st.breakdown && st.breakdown.d5, "breakdown", pooledFor(ac, "breakdown", "d5"), "R", r.uni);
          const sig = mkSignal(r, "breakdown", `mark ${((1 - r.px / lo) * 100).toFixed(1)}% below the prior 30d low`,
            ((1 - r.px / lo) * 100) * 12 + 15, evd, { horizon: evMeta("breakdown", r.uni).horizon });
          { const mR = sig.study ? sig.study.med : (sig.pooled ? sig.pooled.med : null);
            sig.play = playbook("breakdown", { logGeo: r.uni === "main", px: r.px, level: lo, med: mR != null && sd30 > 0 ? mR * sd30 : null }); }
          const ibBD = intrabarCross(closes, lo, -1, now) ? 1 : 0;   // F5: only the live mark broke down; last completed close still at/over the low
          out.push(sig); if (sd30 > 0) openLedger(r, "breakdown", sig, -1, { sd0: +sd30.toFixed(3), ib: ibBD });
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
          // ---- swing-horizon touch-mode shadows (-20) --------------------------------------
          // Structural targets from the daily-depth level detector, first-touch resolution
          // (tm=1 rides through `extra`; the frozen ABSOLUTE target ships as tgt so the
          // resolver and the level walk read exactly the claimed number, never a
          // reconstruction). lvlBars map dailyRaw for detectLevels: h rides the stored high
          // when present and falls back to the close (post-warm-boot bars); the low side falls
          // back likewise — these are LONG structures whose targets read HIGHS, so the
          // low-side blindness the levels study routes around does not bite here. The MA200
          // regime stamp is computed here once per row (r._r2) and read by openLedger at claim
          // creation; events firing EARLIER in the same pass read the prior build's stamp —
          // one build of staleness on a 200-session average is immaterial, and the first build
          // after boot simply leaves them unstamped (absent = honest unknown).
          { const r2v = regime200(closes, r.px);
            if (r2v != null) r._r2 = r2v; else delete r._r2; }
          // Vol-regime percentile at fire (vr): current 10d realized vol's rank within its
          // trailing-120 baseline — the same number the coil signal surfaces, so a claim's
          // recorded regime agrees with what the board shows. Stamped on the row here and read by
          // openLedger for every claim (like r._r2). The single most predictive conditioning
          // variable not yet on the ledger: "does this signal only work in quiet tape" becomes a
          // record query instead of a rebuild. Absent under 140 daily closes (coil's own floor) —
          // an honest unknown, excluded from any future split. Recorded, never gated.
          if (st.coil && Number.isFinite(st.coil.pct)) r._vr = st.coil.pct; else delete r._vr;
          const lvlBars = r.dailyRaw && r.dailyRaw.length >= 60
            ? r.dailyRaw.map((k) => { const c = +k.c, h = +k.h; return { c, h: Number.isFinite(h) && h > 0 ? h : c, l: c }; })
            : null;
          if (lvlBars) {
            const sp = detectSwingPull(closes, r.px, sd30, lvlBars);
            if (sp && stopGeometryOk("long", r.px, sp.stop))
              openLedger(r, "swpull", { score: 0, reading: "" }, 1,
                { sd0: +sd30.toFixed(3), psd: "long", pn: 1, stp: sp.stop, tgt: sp.target, tm: 1,
                  mv: +(Math.abs(sp.target / r.px - 1) * 100).toFixed(2) }, 0);
            const bb = detectBaseBreak(closes, r.px, sd30, lvlBars);
            if (bb && stopGeometryOk("long", r.px, bb.stop)) {
              // one detection, two claim geometries: the record — not an argument — decides
              // whether the measured move or the next structural level nets more R here
              if (bb.targetL != null)
                openLedger(r, "basebrk", { score: 0, reading: "" }, 1,
                  { sd0: +sd30.toFixed(3), psd: "long", pn: 1, stp: bb.stop, tgt: bb.targetL, tm: 1,
                    mv: +(Math.abs(bb.targetL / r.px - 1) * 100).toFixed(2) }, 0);
              if (bb.targetP != null)
                openLedger(r, "basepj", { score: 0, reading: "" }, 1,
                  { sd0: +sd30.toFixed(3), psd: "long", pn: 1, stp: bb.stop, tgt: bb.targetP, tm: 1,
                    mv: +(Math.abs(bb.targetP / r.px - 1) * 100).toFixed(2) }, 0);
            }
            // ---- EMA200 close-confirmed shadows (-28: stage two of the -26 study) ------------
            // Two streams only — the study's strongest priors (D1 buffered breakout, D1 support
            // retest hold), long side — not all twelve definitions; the study panel adjudicates
            // the rest, and a variant that shows excess there earns its own stream the same way.
            // Detectors read CLOSED daily bars only: the forming day is trimmed, so a cross that
            // exists at 2pm and dies by the close never fires — the exact discipline the study
            // measures. Touch-mode geometry frozen at fire, same convention as every -20 shadow.
            const nowD = Date.now();
            const ccl = closes.length && +closes[closes.length - 1][0] + DAY > nowD ? closes.slice(0, -1) : closes;
            const eb = detectEmaBreak(ccl, r.px, sd30, lvlBars);
            if (eb && stopGeometryOk("long", r.px, eb.stop))
              openLedger(r, "emabrk", { score: 0, reading: "" }, 1,
                { sd0: +sd30.toFixed(3), psd: "long", pn: 1, stp: eb.stop, tgt: eb.target, tm: 1,
                  mv: +(Math.abs(eb.target / r.px - 1) * 100).toFixed(2) }, 0);
            // the retest needs true daily lows for the touch — mergedDailyBars carries them
            // where the spine covers (which includes the firing bar by construction)
            const er = detectEmaRetest(closedBars(mergedDailyBars(r), DAY, nowD), r.px, sd30, lvlBars);
            if (er && stopGeometryOk("long", r.px, er.stop))
              openLedger(r, "emarts", { score: 0, reading: "" }, 1,
                { sd0: +sd30.toFixed(3), psd: "long", pn: 1, stp: er.stop, tgt: er.target, tm: 1,
                  mv: +(Math.abs(er.target / r.px - 1) * 100).toFixed(2) }, 0);
            // ---- structural-level touch shadows (2026.07.28-01) ------------------------------
            // The thesis under measurement: a claim fired NEXT TO a confirmed level needs no
            // sigma-wide guessed void — the level IS the invalidation, and the stop sits half a
            // σ behind it. Long: a closed D1 low probes a confirmed sup/flip cluster inside the
            // detector's own tau and closes back above; short: the mirror at res/flip, reading
            // the true highs the merged bars carry. Target = the next confirmed cluster >=1.5σ
            // in the trade direction — no cluster on either leg, no claim, honest null. Touch-
            // resolved like every -20 shadow. Cluster touch count / age ride as recorded
            // features (lvn/lva), recorded NOT gated: whether a 2-touch level earns the trust
            // of a 5-touch flip is the ledger's question. Same closed-bar discipline as -28:
            // the forming day is trimmed, so an intrabar probe that dies by the close never fires.
            const cdbT = closedBars(mergedDailyBars(r), DAY, nowD);
            const lhT = detectLvlTouch(cdbT, r.px, sd30, "long");
            if (lhT && stopGeometryOk("long", r.px, lhT.stop))
              openLedger(r, "lvlhold", { score: 0, reading: "" }, 1,
                { sd0: +sd30.toFixed(3), psd: "long", pn: 1, stp: lhT.stop, tgt: lhT.target, tm: 1,
                  mv: +(Math.abs(lhT.target / r.px - 1) * 100).toFixed(2), lvn: lhT.n, lva: lhT.ageD }, 0);
            const lrT = detectLvlTouch(cdbT, r.px, sd30, "short");
            if (lrT && stopGeometryOk("short", r.px, lrT.stop))
              openLedger(r, "lvlrej", { score: 0, reading: "" }, -1,
                { sd0: +sd30.toFixed(3), psd: "short", pn: 1, stp: lrT.stop, tgt: lrT.target, tm: 1,
                  mv: +(Math.abs(lrT.target / r.px - 1) * 100).toFixed(2), lvn: lrT.n, lva: lrT.ageD }, 0);
            // ---- volume-node touch shadows (2026.07.28-02): Phase 3 --------------------------
            // The same held-touch mechanics anchored on the OTHER honest level source: the
            // profile's POC + high-volume nodes, read from volMapFor's memoized build — one
            // computation, every consumer, the chart's VP and this fire site can never disagree
            // about where a node sits. Whether transacted-volume shelves defend the way pivot
            // clusters do has never been measured here; these two put it on the ledger out of
            // sample. vpw stamps the anchoring node's share of profile volume — acceptance is
            // the VP analogue of a touch count — recorded, not gated, like every feature stamp.
            const vmT = volMapFor(r);
            const vnodes = vmT && vmT.vp ? vpTouchNodes(vmT.vp) : null;
            if (vnodes && vnodes.length >= 2) {
              const vhT = detectVpTouch(vnodes, cdbT, r.px, sd30, "long");
              if (vhT && stopGeometryOk("long", r.px, vhT.stop))
                openLedger(r, "vphold", { score: 0, reading: "" }, 1,
                  { sd0: +sd30.toFixed(3), psd: "long", pn: 1, stp: vhT.stop, tgt: vhT.target, tm: 1,
                    mv: +(Math.abs(vhT.target / r.px - 1) * 100).toFixed(2), vpw: +(vhT.vw * 100).toFixed(2) }, 0);
              const vrT = detectVpTouch(vnodes, cdbT, r.px, sd30, "short");
              if (vrT && stopGeometryOk("short", r.px, vrT.stop))
                openLedger(r, "vprej", { score: 0, reading: "" }, -1,
                  { sd0: +sd30.toFixed(3), psd: "short", pn: 1, stp: vrT.stop, tgt: vrT.target, tm: 1,
                    mv: +(Math.abs(vrT.target / r.px - 1) * 100).toFixed(2), vpw: +(vrT.vw * 100).toFixed(2) }, 0);
            }
          }
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
          // intraday liquidity sweep (5m): the failed-break reclaim fired on a prior-session
          // high/low stop-run. xyz only for now — the ledger takes no crypto claim, and gating
          // here saves a per-row archive read across the main universe. The archive is optional
          // (node:sqlite) and range-queried, never resident; prior COMPLETED session = dailyRaw[-2]
          // (never the in-progress bar). Same isolated try — a bad read can't take the board down.
          if (r.uni === "xyz" && store.candlesEnabled && store.candlesEnabled() && r.dailyRaw && r.dailyRaw.length >= 2) {
            const pdr = r.dailyRaw[r.dailyRaw.length - 2], dayHi = pdr && +pdr.h, dayLo = pdr && +pdr.l;
            // ONE range-queried archive read feeds two studies: the sweep detector below and the
            // dip-reclaim ("strongest bid") read shipped on the wire. Reclaim has no prior-day
            // dependency, so it runs off the tail unconditionally; the sweep keeps its level gate.
            const tail5 = store.readCandles(r.coin, now - SWEEP_LOOK_MS, now);
            r.bidInfo = dipReclaim(tail5, r.px, now, RECLAIM_MIN_DIP_PCT);   // null = no honest claim right now
            if (dayHi > 0 && dayLo > 0) {
              const sw = detectSweep(tail5, dayHi, dayLo, r.px, SWEEP_FRAC);
              if (sw && stopGeometryOk(sw.side, r.px, sw.stop))
                openLedger(r, "sweep", { score: 0, reading: "" }, sw.side === "long" ? 1 : -1,
                  { sd0: +sd30.toFixed(3), psd: sw.side, pn: 1, stp: sw.stop,
                    mv: +(Math.abs(sw.target / r.px - 1) * 100).toFixed(2) }, 0);
            }
          }
          // outsized-wick fill + round-figure front-run (build -12): the Vectora-inspired ledger
          // pair, shipped as shadows like every setup before them. Wick bars come from the
          // spine-derived daily buckets (always full OHLC — dailyRaw goes closes-only after a
          // warm boot, which would blind the wick math), last CLOSED bucket only; the round
          // front-run rides the same closes tuples as the other swing shadows. xyz only: the
          // ledger takes no crypto claim, and gating here saves the bucket walk on main rows.
          if (r.uni === "xyz") {
            const db24 = bucketsFor(r, 24);
            if (Array.isArray(db24) && db24.length >= 32) {
              const wf = detectWickFill(db24.slice(0, -1), r.px, { frac: WICK_FRAC, sizeMult: WICK_SIZE_MULT });
              if (wf && stopGeometryOk(wf.side, r.px, wf.stop))
                openLedger(r, "wickfill", { score: 0, reading: "" }, wf.side === "long" ? 1 : -1,
                  { sd0: +sd30.toFixed(3), psd: wf.side, pn: 1, stp: wf.stop,
                    mv: +(Math.abs(wf.target / r.px - 1) * 100).toFixed(2) }, 0);
            }
            const rf = detectRoundFront(closes, r.px, sd30, { loBand: RNDF_LO_BAND, hiBand: RNDF_HI_BAND });
            if (rf && stopGeometryOk(rf.side, r.px, rf.stop))
              openLedger(r, "roundfr", { score: 0, reading: "" }, rf.side === "long" ? 1 : -1,
                { sd0: +sd30.toFixed(3), psd: rf.side, pn: 1, stp: rf.stop,
                  mv: +(Math.abs(rf.target / r.px - 1) * 100).toFixed(2) }, 0);
          }
        } } catch (e) { swingFails++; swingErr = (e && e.message) || String(e); }
        // OI flush: 7d ΔOI at a −σ extreme of its own distribution, into a decline
        if (st.oiflush && st.oiflush.cur && st.oiflush.cur.sd > 0) {
          const doiNow = computeDoi(r);
          if (doiNow && doiNow.d7 != null && r.d7 != null && isFinite(r.d7)) {
            const zF = (doiNow.d7 - st.oiflush.cur.mu) / st.oiflush.cur.sd;
            VARIANTS.oiflush.vals.forEach((v, vi) => { if (zF <= -v && r.d7 < 0 && sd30 > 0) openLedger(r, "oiflush", { score: 0, reading: "" }, 1, { sd0: +sd30.toFixed(3) }, vi); });
            if (zF <= -incVal("oiflush") && r.d7 < 0) {
              const evd = evidence(st.oiflush.d5, "oiflush", pooledFor(ac, "oiflush", "d5"), "R", r.uni);
              const sig = mkSignal(r, "oiflush", `\u0394OI7d ${doiNow.d7.toFixed(1)}% (${zF.toFixed(1)}\u03c3 flush) into a ${r.d7.toFixed(1)}% decline`,
                (-zF - incVal("oiflush")) * 18 + 18, evd, { horizon: evMeta("oiflush", r.uni).horizon });
              { const mR = sig.study ? sig.study.med : (sig.pooled ? sig.pooled.med : null);
                sig.play = playbook("oiflush", { logGeo: r.uni === "main", px: r.px, sd30, med: mR != null && sd30 > 0 ? mR * sd30 : null }); }
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
              const evd = evidence(st.fpdiv.d3, "fpdiv", pooledFor(ac, "fpdiv", "d3"), "R", r.uni);
              const sig = mkSignal(r, "fpdiv", `${dDir > 0 ? "strength" : "weakness"} (${z7.toFixed(1)}\u03c3 7d) while funding ${dDir > 0 ? "falls" : "rises"} \u2014 ${dDir > 0 ? "shorts pressing" : "longs averaging down"}`,
                (Math.abs(z7) - 0.8) * 20 + 16, evd, { horizon: evMeta("fpdiv", r.uni).horizon });
              { const mR = sig.study ? sig.study.med : (sig.pooled ? sig.pooled.med : null);
                sig.play = playbook("fpdiv", { logGeo: r.uni === "main", px: r.px, dir: dDir, sd30, med: mR != null && sd30 > 0 ? mR * sd30 : null }); }
              out.push(sig); openLedger(r, "fpdiv", sig, dDir, { sd0: +sd30.toFixed(3) });
            }
          }
        }
        // ---- crypto-native: cascade exhaustion ------------------------------------------------
        // The flagship crypto event, and the reason this universe is worth enrolling at all — no
        // equity analogue exists in our data. czCasc already flags buckets where a side's forced
        // liquidation notional spiked >=3sigma of its own trailing 24h WITH open interest dropping
        // in the same bucket: flow that actually cleared positioning, not just a busy bar. This
        // turns the latest such bucket into a claim whose void is the flush wick and whose target
        // is the pre-cascade close — both prices the tape printed, so there is no sigma
        // construction for claimGeometryOk to clamp. Aggregated CEX data (Coinalyze) drives the
        // trigger while the claim resolves on OUR Hyperliquid mark; that venue mismatch is real
        // and is disclosed on the card rather than smoothed over. Isolated in its own try: the
        // deriv lane is an optional external dependency and must never take the board down.
        if (r.uni === "main" && sd30 > 0 && cz) {
          try {
            const cf = latestCascade(czCasc.get(r.coin), now, CASC_LOOK_MS);
            const ce = cf ? detectCascExhaust(cf, getHourly(r.coin), r.px, { now }) : null;
            if (ce) {
              const evd = evidence(null, "casc", null, "R", r.uni);
              const ageH = Math.max(1, Math.round(ce.ageMs / HOUR));
              const sigC = mkSignal(r, "casc",
                `${ce.side === "long" ? "long" : "short"}-side cascade ${ageH}h ago \u2014 ${ce.liq >= 1e9 ? (ce.liq/1e9).toFixed(1)+"B" : ce.liq >= 1e6 ? (ce.liq/1e6).toFixed(1)+"M" : Math.round(ce.liq/1e3)+"K"} force-liquidated in one 15m bucket, OI ${ce.doiPct != null ? (ce.doiPct > 0 ? "+" : "") + ce.doiPct.toFixed(1) + "%" : "down"} with it; the flush ${ce.side === "long" ? "low" : "high"} has held since`,
                Math.max(10, 34 - ageH), evd, { horizon: evMeta("casc", r.uni).horizon, cexsrc: 1 });
              sigC.play = playbook("casc", { side: ce.side, stop: ce.stop, target: ce.target, doiPct: ce.doiPct });
              out.push(sigC);
              openLedger(r, "casc", sigC, ce.side === "long" ? 1 : -1,
                { sd0: +sd30.toFixed(3), cliq: ce.liq, cdoi: ce.doiPct, cage: ageH });
            }
          } catch (e) { swingFails++; swingErr = (e && e.message) || String(e); }
        }
        // ---- crypto-native: persistent funding extreme ----------------------------------------
        // The retired fundext, back with the thing it lacked: an episode definition. Funding at a
        // percentile extreme is a PERSISTENT condition — it can sit at the 97th percentile for
        // days — so a naive trigger serially re-opens claims on one episode and reports n=40 for
        // what is one observation. The ledger's rearm gate handles the re-entry, and the
        // persistence floor here (the condition must have been in force for FUNDEXT_HOURS of its
        // own history, not just this print) is what makes the episode an episode. Faded: crowded
        // long -> short it. Target is the geometric range mid, an observed structure; void a
        // 1.5sigma multiple beyond where the crowd is defending.
        if (r.uni === "main" && sd30 > 0 && r.funding != null && isFinite(r.funding)) {
          const fp = fundPctileNow(r.coin, r.funding, now);
          if (fp != null && (fp >= FUNDEXT_HI || fp <= FUNDEXT_LO)) {
            const crowdedLong = fp >= FUNDEXT_HI;
            const fDir = crowdedLong ? -1 : 1;   // the FADE direction
            // persistence: the same side's extreme must hold across the recent history, not one print
            const fh = getFunding(r.coin);
            let held = 0;
            for (let i = fh.length - 1; i >= 0 && fh[i][0] >= now - FUNDEXT_HOURS * HOUR; i--) {
              const v = fh[i][1];
              if (!isFinite(v)) continue;
              if (crowdedLong ? v > 0 : v < 0) held++; else { held = 0; break; }
            }
            if (held >= FUNDEXT_MIN_SAMPLES) {
              const fAPR = r.funding * 24 * 365 * 100;
              const evd = evidence(null, "fundext", null, "R", r.uni);
              const sigF = mkSignal(r, "fundext",
                `funding ${fAPR >= 0 ? "+" : ""}${fAPR.toFixed(0)}% APR \u2014 ${fp}th percentile of its own 31d, crowded ${crowdedLong ? "long" : "short"} for ${held}h+`,
                Math.abs(fp - 50) * 0.5 + 12, evd, { horizon: evMeta("fundext", r.uni).horizon });
              sigF.play = playbook("fundext", { logGeo: true, dir: fDir, px: r.px, sd30, pct: fp,
                hi30: r.feat ? r.feat.hi30 : null, lo30: r.feat ? r.feat.lo30 : null });
              out.push(sigF);
              openLedger(r, "fundext", sigF, fDir, { sd0: +sd30.toFixed(3), fxp: fp, fxh: held });
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
            const evd = evidence(st.volshift && st.volshift.d5, "volshift", pooledFor(ac, "volshift", "d5"), "R", r.uni);
            const sig = mkSignal(r, "volshift", `10d vol ${cur.toFixed(1)}%/d vs p90 ${p90.toFixed(1)}%/d`,
              (cur / p90 - 1) * 60 + 12, evd, { horizon: evMeta("volshift", r.uni).horizon });
            sig.play = playbook("volshift", {});
            out.push(sig);   // no ledger: no directional claim to resolve
          }
        }
      }
      const rOff = rowOffState(dc, r);   // foreign-home names gap on THEIR market's clock (2026.08.14-01)
      if (rOff && rOff.closed && st.gap && st.gap.sd > 0) {
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
            const evd = evidence(gs, "gap", pooledFor(ac, "gap", "session"), "%", r.uni);
            const reading = `${g >= 0 ? "+" : ""}${g.toFixed(2)}% since the last close (${(Math.abs(g) / st.gap.sd).toFixed(1)}\u03c3 of its gaps)`
              + (exc != null ? ` \u00b7 S&P ${gBench >= 0 ? "+" : ""}${gBench.toFixed(2)}%, excess ${exc >= 0 ? "+" : ""}${exc.toFixed(2)}%` : "");
            const sig = mkSignal(r, "gap", reading,
              (Math.abs(g) / st.gap.sd) * 14 + (exc != null ? Math.min(16, Math.abs(exc) / st.gap.sd * 12) : 0),
              evd, { horizon: evMeta("gap", r.uni).horizon });
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
          const evd = evidence(st.fundflip && st.fundflip.d3, "fundflip", pooledFor(ac, "fundflip", "d3"), "R", r.uni);
          const sig = mkSignal(r, "fundflip", `day funding flipped ${s0 > 0 ? "positive (longs now pay)" : "negative (shorts now pay)"} after ${run}+ days the other way`,
            22, evd, { horizon: evMeta("fundflip", r.uni).horizon });
          sig.play = playbook("fundflip", { logGeo: r.uni === "main", dir: s0, px: r.px, sd30 });   // px + σ give the play its 1σ stop (findings ops item 3)
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
            const evd = evidence(null, "squeeze", null, "%", r.uni);
            const sig = mkSignal(r, "squeeze", `score ${sqz} \u2014 shorts paying ${Math.abs(fAPR).toFixed(0)}% APR, \u0394OI7d ${doi && doi.d7 != null ? (doi.d7 >= 0 ? "+" : "") + doi.d7.toFixed(1) + "%" : "n/a"}`,
              (sqz - incVal("squeeze")) * 1.1 + 15, evd, { horizon: evMeta("squeeze", r.uni).horizon });
            sig.play = playbook("squeeze", { hi30: f ? f.hi30 : null, lo30: f ? f.lo30 : null });
            out.push(sig); openLedger(r, "squeeze", sig, 1);
            // Structural-void twin (2026.07.28-01): IDENTICAL trigger (this very fire), IDENTICAL
            // target (the play's own level, read verbatim), same at-horizon resolution — ONLY the
            // void changes: the nearest confirmed cluster on the loss side within 0.3-3σ, stop
            // half a σ through it. One variable isolated: at ≥30 resolutions the stop-aware duel
            // answers whether the tight structural stop's R:R gain survives its higher tag rate —
            // measured, not argued. No cluster in band, no twin: the incumbent still ledgers, the
            // twin only exists where the tape offers an invalidation to sit on. sd0 stamps the
            // twin R-united; the incumbent's %-record predates the sigma epoch and stays untouched.
            if (sd30 > 0) {
              const sv = structVoid(closedBars(mergedDailyBars(r), DAY, now), r.px, sd30, "long");
              const t2 = sig.play && Number.isFinite(sig.play.target) && sig.play.target > r.px ? sig.play.target : null;
              if (sv && t2 != null && stopGeometryOk("long", r.px, sv.stop))
                openLedger(r, "squeeze2", { score: 0, reading: "" }, 1,
                  { sd0: +sd30.toFixed(3), psd: "long", pn: 1, stp: sv.stop, tgt: t2,
                    mv: +(Math.abs(t2 / r.px - 1) * 100).toFixed(2), lvn: sv.n, lva: sv.ageD }, 0);
            }
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
            const evd = evidence(null, "unwind", null, "%", r.uni);
            const sig = mkSignal(r, "unwind", `score ${unw} \u2014 longs paying ${fAPR.toFixed(0)}% APR, \u0394OI7d ${doi && doi.d7 != null ? (doi.d7 >= 0 ? "+" : "") + doi.d7.toFixed(1) + "%" : "n/a"}`,
              (unw - incVal("unwind")) * 1.1 + 15, evd, { horizon: evMeta("unwind", r.uni).horizon });
            sig.play = playbook("unwind", { hi30: f ? f.hi30 : null, lo30: f ? f.lo30 : null });
            out.push(sig); openLedger(r, "unwind", sig, -1);
            // Structural-void twin — the PURRDAT case: a formula void parked at three-quarters of
            // the 30d range vs a confirmed flip a fraction as far from the entry. Same contract as
            // the squeeze twin above: identical trigger and target, void on the nearest confirmed
            // cluster overhead (0.3-3σ, stop half a σ through), no cluster in band -> no twin.
            if (sd30 > 0) {
              const sv = structVoid(closedBars(mergedDailyBars(r), DAY, now), r.px, sd30, "short");
              const t2 = sig.play && Number.isFinite(sig.play.target) && sig.play.target > 0 && sig.play.target < r.px ? sig.play.target : null;
              if (sv && t2 != null && stopGeometryOk("short", r.px, sv.stop))
                openLedger(r, "unwind2", { score: 0, reading: "" }, -1,
                  { sd0: +sd30.toFixed(3), psd: "short", pn: 1, stp: sv.stop, tgt: t2,
                    mv: +(Math.abs(t2 / r.px - 1) * 100).toFixed(2), lvn: sv.n, lva: sv.ageD }, 0);
            }
          }
        }
      }
      const pb = premBaseline(r);
      if (pb && r.oracle > 0) {
        const prem = (r.px / r.oracle - 1) * 1e4, z = (prem - pb.m) / pb.sd;
        if (Math.abs(z) >= 2 && Math.abs(prem) >= 5) {
          const evd = evidence(null, "prem", null, undefined, r.uni);
          const sig = mkSignal(r, "prem", `${prem >= 0 ? "+" : ""}${prem.toFixed(1)}bp vs oracle (${z >= 0 ? "+" : ""}${z.toFixed(1)}\u03c3 of its 7d baseline)`,
            (Math.abs(z) - 2) * 12 + 18, evd,
            { horizon: rOff && rOff.closed ? "cash market closed \u2014 live off-hours price discovery" : EV_META.prem.horizon });
          sig.play = playbook("prem", { prem, oracle: r.oracle, closed: !!(rOff && rOff.closed) });
          out.push(sig); openLedger(r, "prem", sig, prem >= 0 ? -1 : 1, { prem0: +prem.toFixed(1) });
        }
      }
      if (f && f.volBase > 0 && r.vol != null && r.vol / f.volBase >= 2.5) {
        const sig = mkSignal(r, "volume", `24h volume ${(r.vol / f.volBase).toFixed(1)}\u00d7 its 30d norm`,
          (r.vol / f.volBase - 2.5) * 10 + 12, { pts: 6, unproven: true }, { horizon: evMeta("volume", r.uni).horizon });
        sig.play = playbook("volume", {});
        out.push(sig);
      }
      if (st.coil && st.coil.coiled) {
        // Context only: no ledger claim, no direction. Feeds direction-aware confluence — a
        // breakout/breakdown firing OUT of compression is the configuration worth extra score.
        const sig = mkSignal(r, "coil", `10d realized vol at its ${st.coil.pct}th pctile of the trailing 120 \u2014 coiled`,
          (10 - st.coil.pct) * 1.5 + 10, { pts: 6, unproven: true }, { horizon: evMeta("coil", r.uni).horizon });
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
    // Stocks AND crypto (2026.07.26-08): this is the cleanest transfer in the whole roster,
    // because its geometry was never a sigma construction — the void is the retesting rung's own
    // EMA21 and the target is that rung's prior swing, both values the ladder already computed and
    // the board already rendered. Nothing here needed the log-space rewrite; it needed only the
    // enrollment. trendCache carries a .crypto board with identical shape (retest / swing / e21),
    // so the loop widens by one key. Outcomes in raw % (not sigma-R): there is no in-sample study
    // to stay unit-compatible with — this event earns its record purely out of sample, per
    // universe, on that universe's own horizon (3d crypto, 5d stocks).
    {
      if (!trendCache || now - trendBuilt > TREND_MS) { try { buildTrend(); } catch (e) { log("buildTrend error in signals: " + (e && e.message)); } }
      if (trendCache) {
        for (const side of ["long", "short"]) {
          const ev = side === "long" ? "tretest" : "tretestdn";
          const boards = crypto
            ? (trendCache[side].stocks || []).concat(trendCache[side].crypto || [])
            : (trendCache[side].stocks || []);
          for (const e of boards) {
            if (!e.retest) continue;
            const r = rows.get(e.coin);
            if (!r || r.delisted || !(r.px > 0)) continue;
            const cell = e.tf && e.tf[e.retest];
            if (!cell || !(cell.e21 > 0)) continue;
            const dir = side === "long" ? 1 : -1;
            const evd = evidence(null, ev, null, "%", r.uni);
            const reading = `${e.retest} retest \u2014 pullback into the 13/21 zone of a ${e.score}/4 stacked ${side === "long" ? "uptrend" : "downtrend"}, close holding EMA21`
              + (e.rrv != null ? ` \u00b7 zone volume ${e.rrv.toFixed(1)}\u00d7` : "")
              + (e.age != null ? ` \u00b7 trend age ${e.age}${e.ageCap ? "+" : ""}d` : "");
            const sigT = mkSignal(r, ev, reading,
              10 + 8 * e.score + (e.rrv != null && e.rrv <= 1 ? 6 : 0),   // quiet pullbacks (rrv <= 1x) read healthier than fought ones — small nudge, recorded either way
              evd, { horizon: evMeta(ev, r.uni).horizon });
            sigT.play = playbook(ev, { logGeo: r.uni === "main", tf: e.retest, score: e.score, e21: cell.e21, swing: e.swing != null ? e.swing : null, px: r.px });
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
          const evd = evidence(null, "ondrift", null, "%", r.uni);
          const sig = mkSignal(r, "ondrift", `${d30 >= 0 ? "+" : ""}${d30.toFixed(1)}% off-hours drift over ~21 windows (${z.toFixed(1)}\u03c3 vs universe)`,
            (Math.abs(z) - 2) * 16 + 18, evd, { horizon: evMeta("ondrift", r.uni).horizon });
          sig.play = playbook("ondrift", { dir });
          out.push(sig); openLedger(r, "ondrift", sig, dir);
        }
      }
    }
    const kept = [], live = new Set();
    for (const g of out) {
      // Universe enrollment applied to the CARD as well as the claim. openLedger's guard stops a
      // disallowed event from ledgering, but a card with no claim behind it would still render —
      // a crypto squeeze setup showing a play whose levels the gate just refused to freeze is
      // precisely the board/ledger disagreement this codebase forbids. One gate, both paths.
      if (!evAllowed(g.uni, g.ev)) continue;
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
      // Macro guard: FOMC / CPI / NFP (and the rest of the roster) <=1 ET day out is the
      // universe-wide analogue of the earnings guard — a scheduled binary the base rate cannot
      // see, on BOTH universes (CPI moves BTC as hard as it moves SPX). Same session-spanning
      // event set, same cap, same flagged-never-filtered contract. If the earnings guard already
      // trimmed this claim the cap is not applied twice — one binary ahead or two, the borrowed
      // statistical confidence is capped once at the same 8 points.
      if (EARN_GUARD.has(g.ev)) {
        const mp = macroProx(now);
        if (mp) {
          g.mac = mp;
          if (!g.earnguard && g.evp > 8) { g.score = Math.max(0, Math.round(g.score - (g.evp - 8))); g.macguard = true; }
          const mG = ledgerOpen.get(g.coin + "|" + g.ev);
          if (mG && mG.mg == null) { mG.mg = 1; ledgerDirty = true; }   // claim stamped in force <=1d of a macro print — future conditioned splits read this
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
      // Prime v1 kept: a proven-in-sample base rate with hit>=60%, positive expectancy, sound
      // structure, not unproven/decayed/no-edge. But hit>=0.6 as a HARD gate structurally excludes
      // the asymmetric swing profile the whole -20 program exists to observe — a 45%-hit/+0.5R
      // strategy can never be prime under it, even with a live record proving it pays. F6
      // (2026.07.30-04): OR a second path certified by the claim's OWN-universe LIVE record —
      // avg>=0.35R AND n>=12 AND profit factor>=1.5. This path reads the resolved ledger (recFor,
      // scoped post-F1), not the in-sample study, because "pays asymmetrically" is a claim only the
      // record can make; and it applies only to R-united events, where 0.35 is a real R threshold
      // (a % event's 0.35 would be meaningless). Same disqualifiers as v1: no-edge, neg-exp,
      // earnings-in-horizon, poor structure.
      const bs = g.study && g.study.n >= 8 ? g.study : g.pooled;
      const primeV1 = bs && bs.hit >= 0.6 && bs.avg > 0;
      const primeV2 = primeV2Live(g.uni, g.ev);   // asymmetric swing profile, certified by the live scoped record
      if ((primeV1 || primeV2) && !g.noedge && !g.negexp && !g.earn && (g.rr == null || g.rr >= 1.2)) { g.prime = true; g.score += 6; }
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
      } else if (rearm.has(key)) {
        // Post-resolution episode (build -31): the claim behind this signal already resolved into
        // the record and the condition never lapsed, so the re-arm gate refuses a serial re-claim
        // (one episode, one claim). The card used to render a bare "now —" here — technically
        // honest, practically a hole: the ledger HOLDS the answer, sitting in ledgerClosed. Ship
        // the resolution stub so the client can say "already scored +1.3R" instead of "nothing to
        // measure". Newest settled entry for this exact key wins (episodes reuse the key; the
        // backwards scan finds the resolution that parked it). A never-scored expiry ships as
        // voided — an honest "settled without an outcome", never a fabricated number.
        let done = null;
        for (const c0 of ledgerClosed)
          if (c0 && c0.key === key && c0.vi == null
            && (!done || (c0.tR || c0.t0 || 0) > (done.tR || done.t0 || 0))) done = c0;
        if (done) g.scored = { t0: done.t0 || null, tR: done.tR || null,
          realized: Number.isFinite(done.realized) ? +(+done.realized).toFixed(2) : null,
          unit: unitOf(g.ev), stopped: done.stopped === true, voided: done.status === "void" };
        else g.scored = { t0: null, tR: null, realized: null, unit: unitOf(g.ev), stopped: false, voided: true };
        g.postres = true;
        // A ★ prime badge on a corpse invites entry into a setup whose claim is already banked
        // and whose lateness is uncomputable — the emphasis and its score bonus are withdrawn,
        // same philosophy as the decay gate. Condition intensity stands on its own.
        if (g.prime) { g.prime = false; g.score = Math.max(0, g.score - 6); }
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
    // The PAYLOAD is capped by score; the COUNT is the true number of live conditions. Serving
    // top.length as the count pinned the tab badge at "40" forever the moment the universe
    // produced >=40 concurrent conditions — the badge must move with reality, the payload cap is
    // a transport decision. `shown` carries the cap for the client.
    // Per-universe lanes are BACK (they were retired at -101 as dead weight when only one universe
    // was enrolled). With both enrolled a plain top-40 is not a neutral cap: crypto's sigma makes
    // its intensity terms structurally larger, so on any volatile crypto day the lane would fill
    // with perps and the equity board — the one with the long record — would silently vanish from
    // its own tab. Each universe gets its own budget and neither can crowd out the other.
    const top = crypto ? capPerUniverse(kept, 40, 40) : kept.slice(0, 40);
    const shadows = shadowRecord();
    const shSig = (a) => (a || []).map((g) => g.rows.map((r) => r.n + ":" + r.open).join(".")).join(",");
    const sig = kept.length + "|" + top.map((g) => g.coin + g.ev + g.score + (g.claim0 ? "c" + g.claim0.t : g.postres ? "p" : "")).join(",")   // -31: claim↔scored transitions change the payload even at an unchanged score — the ETag must move with them
      + "|" + shSig(shadows.xyz) + "|" + shSig(shadows.main);   // shadow record changes must bust the ETag too, both panels
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
    sigTickers.clear();
    for (const g of kept) if (g.uni === "xyz") sigTickers.add(String(g.ticker).toUpperCase());
    buildNewsPayload();   // sig/ed badge stamps ride the signals cadence; content hash gates the ETag bump
    // Per-universe live totals. `count` stays the whole-engine number (both universes) so nothing
    // reading it changes meaning; countU carries the split the scoped tab actually needs. These
    // count KEPT conditions, not the transport slice — the badge must move with reality while the
    // cap is only a transport decision. Restored with the crypto engine: countU was retired at
    // -101 as dead weight when one universe was served, and a scoped badge is impossible without it
    // (summing the capped payload would silently under-report the moment either lane fills).
    let cntX = 0, cntM = 0;
    for (const g of kept) { if (g.uni === "main") cntM++; else cntX++; }
    signalsCache = { ts: now, dataTs: signalsVer, count: kept.length, countU: { x: cntX, m: crypto ? cntM : null },
      shown: top.length, signals: top,
      record: recordCache || {}, confluence: confCache || null, recordX: recordXCache,
      records: recordSets, variants, shadows, recent: rs0 ? rs0.recent : [], earnSplit };
    persistLedger();
    // Event-driven board rebuild (2026.08.03-07): claims opened THIS pass reach the board on the
    // chained build that follows, not the next ACT_MS/poll tick — the pure-cadence half of the
    // fire->shown cost, deleted. Debounced to one chained rebuild per signals pass, floor-limited
    // so a cascade day cannot stampede the chain, serialized through chainBuild like every build
    // that touches the ledger. Fire-and-forget on purpose: the signals pass must not await the
    // board, and chainBuild's caller-side rejection is logged by its own handler.
    if (actKick) {
      actKick = false;
      if (Date.now() - actBuilt > 5000)
        chainBuild("buildActionable", buildActionable).catch((err) => log("chained buildActionable error: " + (err && err.message)));
    }
  }

  // ---- session / time-of-day analytics (served at /api/analytics) ----
  // The hourly-price and funding spines live only in poller memory (60d x ~100 markets), so the math
  // runs here on a slow interval and the browser is handed one compact, pre-aggregated payload rather
  // than raw candles. Slice 1 establishes the data path + coverage/readiness; the seven studies
  // (session decomposition, hour/funding clocks, day-of-week grid, clustering, seasonality) populate
  // `sections` in later slices.
  // Tape-wide positioning regime: how crowded (OI-weighted funding + percentile-extreme breadth)
  // and how leveraged (aggregate OI, stretch z-score) the book is — split crypto (main) / stocks
  // (xyz) / both. Pure reconstruction from the persisted [ts,oi,funding] spines (populated from
  // day one), so no new persistence and no per-name ledger machinery (crypto stays context, not a
  // ledger signal — consistent with the -101 crypto-engine removal).
  const REGIME_DAYS = 60;
  function buildRegime() {
    const now = Date.now();
    // The two universes live in separate rosters by design (activeMarkets() is xyz-pure; crypto
    // rides mainMarkets()). Combine them here rather than filtering one list by r.uni — that is the
    // canonical split the rest of the poller uses, and it is what makes "crypto" populate at all.
    const stocks = activeMarkets().filter((r) => r && !r.delisted);
    const crypto = mainMarkets().filter((r) => r && !r.delisted);
    const groups = { all: crypto.concat(stocks), crypto, stocks };
    const out = { now, days: REGIME_DAYS };
    for (const key of ["all", "crypto", "stocks"]) {
      const g = groups[key];
      if (!g.length) { out[key] = { names: 0, pending: true }; continue; }
      const spines = g.map((r) => hist.get(r.coin)).filter((a) => Array.isArray(a) && a.length);
      const agg = regimeAggregate(spines, { now, days: REGIME_DAYS });
      // Crowding breadth off the LIVE funding percentile (point-in-time; not plotted, so no
      // chart/tile disagreement). One code path: r.fundPct is the same percentile the board flags.
      let nlong = 0, nshort = 0, npct = 0, volSum = 0;
      for (const r of g) {
        if (r.fundPct != null && isFinite(r.fundPct)) { npct++; if (r.fundPct >= 90) nlong++; else if (r.fundPct <= 10) nshort++; }
        if (r.vol > 0) volSum += r.vol;
      }
      const longExt = npct ? +(100 * nlong / npct).toFixed(1) : null;
      const shortExt = npct ? +(100 * nshort / npct).toFixed(1) : null;
      out[key] = {
        names: g.length,
        series: agg.series,
        crowd: { netFundApr: agg.netFundApr, longExtPct: longExt, shortExtPct: shortExt,
          netCrowd: (longExt != null && shortExt != null) ? +(longExt - shortExt).toFixed(1) : null, pctNames: npct },
        lev: { totalOi: agg.totalOi, oiZ: agg.oiZ, oi7dPct: agg.oi7dPct, oi30dPct: agg.oi30dPct,
          oiVol: (agg.totalOi != null && volSum > 0) ? +(agg.totalOi / volSum).toFixed(2) : null },
      };
    }
    return out;
  }

  // Universe descriptor threaded through every session-study builder (-17). The whole analytics
  // engine was xyz-only: activeMarkets() + assetClass==="Equity" filters baked in. Now each builder
  // takes a `U` — roster (which markets), classOf (how to label/group them), tz (axis labels), and
  // isCrypto (drop the US-cash-session framing: no cash leg in decomposition, no cash band on the
  // clocks/pivots, all perps are one "Crypto" class). One code path, two universes; the crypto side
  // reads mainMarkets() at the 90d spine depth (-17 retention bump) so its studies run at real depth.
  function analyticsUniverse(scope) {
    if (scope === "crypto") return {
      scope: "crypto", isCrypto: true, tz: "UTC",
      // Which session-study GROUPS this universe publishes (-19, structure added -27). Crypto keeps
      // Positioning (the regime aggregate), Holds (session decomposition, anatomy, candle
      // behaviour, pivots) and — since -27 — Structure: the level and EMA200 studies are
      // price-structure claims, and a 200-EMA pullback/breakdown/reclaim is as native to a perp
      // as to any equity; keeping them stocks-only was a wiring accident, not a decision. Still
      // dropped: the asset-class overlay and clustering (both collapse to a single "Crypto" class
      // so they compare nothing — clusters additionally ride the hour clocks, which crypto does
      // not publish), seasonality (a by-sector test with no crypto analogue), and the hour/day
      // grids (a 24/7 book restates the clock without a cash session to contrast it against).
      // One declaration, shipped in the payload — the client renders exactly these groups.
      groups: ["positioning", "holds", "structure"],
      roster: () => mainMarkets().filter((r) => r && !r.delisted),
      classOf: () => "Crypto",
      // On a 24/7 book "equity" gating is meaningless — the study-eligible set is the whole roster
      // with a spine, so studyEligible mirrors roster (minus the spine-length floor each study owns).
      studyEligible: (r) => r && !r.delisted,
    };
    return {
      scope: "stocks", isCrypto: false, tz: "ET",
      groups: ["positioning", "holds", "clocks", "week", "structure"],
      roster: () => activeMarkets().filter((r) => r && !r.delisted),
      classOf: (r) => classifyCached(r.ticker).assetClass,
      studyEligible: (r) => r && !r.delisted && classifyCached(r.ticker).assetClass === "Equity",
    };
  }

  // Error-recording wrapper. Every scheduled and on-demand build goes through this so a persistent
  // failure surfaces in the UI (and the logs) instead of masquerading as "still warming up".
  async function buildAnalyticsSafe(scope) {
    const cr = scope === "crypto";
    try {
      // Serialized with every other yielding build: buildAnalytics is async since -08 (it hands the
      // loop back between study sections), and the chain is what keeps two analytics scopes — or an
      // analytics build and a signals build — from interleaving at those yield points.
      const p = await chainBuild("buildAnalytics:" + (cr ? "crypto" : "stocks"), () => buildAnalytics(scope));
      if (cr) analyticsCryptoErrMsg = ""; else analyticsErrMsg = "";
      return p;
    } catch (e) {
      const m = (e && e.message) || String(e);
      if (cr) analyticsCryptoErrMsg = m; else analyticsErrMsg = m;
      log(`buildAnalytics(${cr ? "crypto" : "stocks"}) failed: ${m}`);
      return null;
    }
  }

  async function buildAnalytics(scope) {
    const U = analyticsUniverse(scope || "stocks");
    const READY_HOURS = 20 * 24;   // "ready" = >= ~20 trading days of hourly candles for the session studies
    const universe = U.roster()
      .map((r) => {
        const cls = U.classOf(r);
        return {
          coin: r.coin, ticker: r.ticker, sector: U.isCrypto ? "Crypto" : classifyCached(r.ticker).sector, assetClass: cls,
          hm: U.isCrypto ? undefined : (homeMkt(r.ticker, r.uni) || undefined),   // home-session shading on the per-ticker activity clock
          hours: Array.isArray(r.hourlyRaw) ? r.hourlyRaw.length : 0,
          funding: r.fundH ? r.fundH.size : 0,
        };
      });
    const hc = hourlyCoverage(U), fc = fundingCoverage(U);
    const equityMarkets = U.isCrypto ? universe.length : universe.filter((u) => u.assetClass === "Equity").length;
    const ready = universe.filter((u) => u.hours >= READY_HOURS).length;
    await buildYield();
    const regime = buildRegime();   // regime is inherently both-universe; the client reads regime[scope]
    const rgSig = ["all", "crypto", "stocks"].map((k) => { const d = regime[k]; return d && !d.pending ? `${Math.round(d.lev.totalOi || 0)}|${d.crowd.netFundApr || 0}|${d.crowd.netCrowd || 0}|${(d.series || []).length}` : "0"; }).join(";");
    // Groups this universe publishes; a study whose group is off is never built (-19).
    const on = (g) => U.groups.indexOf(g) > -1;
    const DISABLED = { disabled: true };
    await buildYield();
    const lvSt = on("structure") ? buildLevelsStudy(U) : DISABLED;   // computed once; reused in sections below so sig and payload can never disagree
    await buildYield();
    const emSt = on("structure") ? buildEma200Study(U) : DISABLED;   // same gate, same cadence, same memo contract as the levels study
    const lvSig = lvSt.disabled ? "off" : (lvSt.pending ? `p${lvSt.count}` : `${lvSt.n}:${lvSt.overall.nTouched}:${lvSt.overall.touchRate}:${lvSt.overall.holdRate}:${lvSt.coverage.tickers}`);
    await buildYield();
    const anSt = buildAnatomy(U);       // same one-computation contract as the levels study
    const anSig = anSt.pending ? `p${anSt.count}` : `${anSt.tickerSessions}:${anSt.days}:${anSt.mfe.medUpSd}:${anSt.monday ? anSt.monday.weeks : 0}:${anSt.naked.revisit.join(",")}:${anSt.candles ? anSt.candles.n : 0}:${anSt.pivots ? anSt.pivots.hi.nDays : 0}`;
    const sig = `${U.scope}:${universe.length}:${hc.coins}:${hc.candles}:${fc.coins}:${fc.points}:${fc.endpoint}:${ready}:${rgSig}:${lvSig}:${anSig}`;
    const cache = U.isCrypto ? { get v() { return analyticsCryptoVer; }, set v(x) { analyticsCryptoVer = x; }, get s() { return analyticsCryptoSig; }, set s(x) { analyticsCryptoSig = x; } }
                             : { get v() { return analyticsVer; }, set v(x) { analyticsVer = x; }, get s() { return analyticsSig; }, set s(x) { analyticsSig = x; } };
    if (sig !== cache.s) { cache.s = sig; cache.v = Date.now(); }   // content changed -> new ETag
    const payload = {
      scope: U.scope, tz: U.tz, isCrypto: U.isCrypto,
      ts: Date.now(),
      dataTs: cache.v,
      window: { hourlyDays: U.isCrypto ? MAIN_SPINE_DAYS : HOURLY_HISTORY_DAYS, fundingDays: U.isCrypto ? MAIN_HIST_DAYS : FUNDING_HISTORY_DAYS },
      coverage: {
        hourly: hc, funding: fc,
        markets: universe.length, equityMarkets, ready, readyHours: READY_HOURS,
      },
      universe,
      groups: U.groups.slice(),
      sections: await (async () => {
        // One yield between every study builder: each one loops the full roster, so this is where
        // the loop-hold used to accumulate into a single multi-second block. Section granularity
        // first; if the tick stats show one section still spiking alone, it yields internally next.
        const hourClock = on("clocks") ? buildActivityClocks(U) : DISABLED;
        await buildYield();
        const sessionDecomp = buildSessionDecomp(U);
        await buildYield();
        const dow = on("week") ? buildDowHeatmap(U) : DISABLED;
        await buildYield();
        const clusters = on("structure") && on("clocks") ? buildClusters(hourClock) : DISABLED;   // clusters consume the hour clocks — a universe without clocks (crypto) gets an honest disabled, never an eternal pending
        await buildYield();
        const seasonality = on("clocks") ? buildSeasonality(U) : DISABLED;
        return {
          regime,
          sessionDecomp,
          hourClock,
          dow,
          clusters,
          seasonality,
          levels: lvSt,
          ema200: emSt,
          anatomy: anSt,
        };
      })(),
    };
    if (U.isCrypto) analyticsCryptoCache = payload; else analyticsCache = payload;
    return payload;
  }

  // Session decomposition (the flagship): for the equity class, run overnight (close->open),
  // weekend (Fri close->Mon open) and cash (open->close) holds on each name's hourly spine, then
  // pool them into one equal-weight bet per calendar boundary and compound gross vs net-of-funding
  // equity curves. Net is only as deep as the funding spine, so each curve carries a per-boundary
  // funding-known fraction and a horizon timestamp — the client renders net as approximate before it.
  const SESSION_MIN_SPINE = 3 * 24;    // a ticker needs >= 3 days of hourly candles to contribute
  const SESSION_MIN_EQUITIES = 5;      // don't publish the study until the class is broad enough
  function buildSessionDecomp(U) {
    U = U || analyticsUniverse("stocks");
    const now = Date.now();
    const end = Math.floor(now / HOUR) * HOUR;
    const start = end - (U.isCrypto ? MAIN_SPINE_DAYS : HOURLY_HISTORY_DAYS) * DAY;
    const tol = 3 * HOUR;
    // Foreign-home names are EXCLUDED from the pooled ET session composite (build 2026.08.14-01):
    // their close->open lives on KRX/TSE/HKEX boundaries, so pooling them under ET anchors would
    // contaminate the composite in both directions. Forward-only, per the frozen-geometry doctrine —
    // per-ticker home-anchored holds still ship on /api/daily; only this cross-name pooling drops them.
    const all = U.roster().filter((r) =>
      U.studyEligible(r) && Array.isArray(r.hourlyRaw) && r.hourlyRaw.length >= SESSION_MIN_SPINE);
    const eq = U.isCrypto ? all : all.filter((r) => !homeMkt(r.ticker, r.uni));
    const foreignExcluded = all.length - eq.length;
    if (eq.length < SESSION_MIN_EQUITIES) return { pending: true, equityCount: eq.length, need: SESSION_MIN_EQUITIES, isCrypto: U.isCrypto };
    // Equity: cash / overnight / weekend around the US session. Crypto (24/7): the two holds that
    // survive a continuous book — the whole UTC day, and the Fri->Mon weekend. No cash leg exists.
    const legs = U.isCrypto
      ? { utcday: utcDayAnchors(start, end), weekend: cryptoWeekendAnchors(start, end) }
      : { overnight: overnightAnchors(start, end), weekend: weekendAnchors(start, end), cash: cashAnchors(start, end) };
    const sessions = {};
    for (const s in legs) {
      const perTicker = [];
      for (const r of eq) perTicker.push(runHolds(getHourly(r.coin), getFunding(r.coin), legs[s], tol));
      sessions[s] = sessionComposite(perTicker);
    }
    // Headline story: overnight (close->open) for equities; the UTC-day hold for crypto.
    const ov = U.isCrypto ? sessions.utcday : sessions.overnight;
    return {
      window: { start, end, days: U.isCrypto ? MAIN_SPINE_DAYS : HOURLY_HISTORY_DAYS },
      isCrypto: U.isCrypto,
      equityCount: eq.length,
      foreignExcluded,   // KRX/TSE/HKEX-home names dropped from the ET pooled composite — declared so absence is auditable
      fundingEndpoint: fundingCoverage(U).endpoint,
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
  function buildActivityClocks(U) {
    U = U || analyticsUniverse("stocks");
    const mkts = U.roster().filter((r) =>
      Array.isArray(r.hourlyRaw) && r.hourlyRaw.length >= CLOCK_MIN_SPINE);
    if (mkts.length < 3) return { pending: true, count: mkts.length };
    const tickers = [];
    for (const r of mkts) {
      const cls = U.classOf(r);
      const raw = activityClock(getHourly(r.coin), getFunding(r.coin), U.tz);
      const vm = _nanmean(raw.vol), qm = _nanmean(raw.volume);
      tickers.push({
        coin: r.coin, ticker: r.ticker, sector: U.isCrypto ? "Crypto" : classifyCached(r.ticker).sector, assetClass: cls,
          hm: U.isCrypto ? undefined : (homeMkt(r.ticker, r.uni) || undefined),   // home-session shading on the per-ticker activity clock
        vr: _round(_normTo(raw.vol, vm), 3),
        qr: _round(_normTo(raw.volume, qm), 3),
        fund: _round(raw.fund, 9),
        n: raw.n.map((x) => x || 0),
        volAbsMean: vm != null ? +vm.toFixed(6) : null,
      });
    }
    const byClass = {};
    for (const c of [...new Set(tickers.map((t) => t.assetClass))]) byClass[c] = _poolClocks(tickers.filter((t) => t.assetClass === c));
    return { hours: 24, tz: U.tz, isCrypto: U.isCrypto, metricDefault: "vol", tickers, pooled: { all: _poolClocks(tickers), byClass } };
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
  function buildDowHeatmap(U) {
    U = U || analyticsUniverse("stocks");
    const mkts = U.roster().filter((r) =>
      Array.isArray(r.hourlyRaw) && r.hourlyRaw.length >= CLOCK_MIN_SPINE);
    if (mkts.length < 3) return { pending: true, count: mkts.length };
    const per = [];
    for (const r of mkts) {
      const cls = U.classOf(r), g = dowClock(getHourly(r.coin), U.tz);
      per.push({ assetClass: cls, volN: _normGrid(g.vol, _nanmean2(g.vol)), volumeN: _normGrid(g.volume, _nanmean2(g.volume)), n: g.n });
    }
    const byClass = {};
    for (const c of [...new Set(per.map((p) => p.assetClass))]) byClass[c] = _poolGrids(per.filter((p) => p.assetClass === c));
    return { hours: 24, tz: U.tz, isCrypto: U.isCrypto, metricDefault: "vol", pooled: { all: _poolGrids(per), byClass } };
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
  function buildSeasonality(U) {
    U = U || analyticsUniverse("stocks");
    // Seasonality is a cross-sectional-by-sector t-test; a one-class crypto book has no sector split
    // to run it over, and it's the most-quarantined study even for equities. Not applicable to crypto.
    if (U.isCrypto) return { pending: true, notApplicable: true, count: 0 };
    const eq = U.roster().filter((r) =>
      U.studyEligible(r) && Array.isArray(r.hourlyRaw) && r.hourlyRaw.length >= CLOCK_MIN_SPINE);
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

  // ---- structural-level outcome study (served in sections.levels) ----------------------------
  // detectLevels (-09) decides which levels the AI report draws and which levels a proposed void
  // is ALLOWED to snap to. This section is its report card: levelOutcomes re-detects on the prefix
  // only (out of sample by construction) and scores every level against a same-distance permutation
  // control, so the served excess is edge over matched noise, not over an analytic formula the
  // bar-sampled tape provably violates. Daily bars come from bucketsFor(r, 24) — the memoized
  // full-OHLC aggregation of the hourly spine — NOT from dailyRaw: a warm-cache hydrate leaves
  // dailyRaw closes-only (no lows), which would silently blind the study's down-side touch test.
  // One source, always OHLC, zero warm-boot seam; the cost is the spine's 180d window vs dailyRaw's
  // 365d tier, which is the right trade for a study whose whole claim is measurement integrity.
  const LVL_MIN_EQ = 5;                 // publish only when the class is broad enough (same posture as sessionDecomp)
  const LVL_STRIDE = 5, LVL_HORIZON = 10, LVL_MINBARS = 60, LVL_CELL_FLOOR = 20;
  function buildLevelsStudy(U) {
    U = U || analyticsUniverse("stocks");
    const eq = U.roster().filter((r) => U.studyEligible(r));
    const pooled = [], pooledVp = []; let contributing = 0, contributingVp = 0, skippedThin = 0;
    for (const r of eq) {
      const db = bucketsFor(r, 24);
      if (!Array.isArray(db) || db.length < LVL_MINBARS + LVL_HORIZON + 2) { skippedThin++; continue; }
      // Drop the last bucket unconditionally: it is the forming UTC day (partial extremes and a
      // non-final close) — the same closed-bar-only posture the 5m capture lane enforces.
      const bars = db.slice(0, -1);
      const closes = bars.map((k) => [k.t, k.c]);
      const sd30 = retStd(dailyRets(closes).slice(-30), 15);
      if (!(sd30 > 0)) { skippedThin++; continue; }
      // Memo on the spine-derived bucket array identity (bucketsFor's own freshness contract):
      // the spine changes on the ~10-min refresh, so the walk-forward runs at most that often per
      // name and every 3-min analytics build in between reads the cached events.
      if (r._lvSrc !== db) {
        r._lvSrc = db;
        r._lvEv = levelOutcomes(bars, sd30, { stride: LVL_STRIDE, horizon: LVL_HORIZON, minBars: LVL_MINBARS }).events;
        // Profile-level audit (-22): the walk-forward HVNs through the IDENTICAL scoring loop
        // and permutation control the structural detector faces — before the level map's
        // hand-set hvn weight is ever replaced by a measured one, this is the measurement.
        // HVN only: an LVN's claim is traversal (thin volume = less friction), which a
        // touch/hold study structurally cannot score — auditing it here would test a claim
        // nobody made. Wider stride bounds the per-prefix profile rebuild cost; the memo
        // contract (spine-ref identity) is shared with the structural pass, one cadence.
        r._vpEv = levelOutcomes(bars, sd30, { stride: LVL_STRIDE + 2, horizon: LVL_HORIZON, minBars: LVL_MINBARS,
          detect: (pb, px2, sd2) => {
            const vp2 = volumeProfile(pb, sd2);
            if (!vp2 || !vp2.hvn.length) return null;
            return { tauPct: Math.max(sd2 > 0 ? 0.4 * sd2 : 0, 0.5),
              items: vp2.hvn.map((h) => ({ v: h.p, side: h.p >= px2 ? "res" : "sup", n: 1, ageD: 0 })) };
          } }).events;
      }
      if (r._lvEv.length) { contributing++; for (const e of r._lvEv) pooled.push(e); }
      if (r._vpEv && r._vpEv.length) { contributingVp++; for (const e of r._vpEv) pooledVp.push(e); }
    }
    if (contributing < LVL_MIN_EQ) return { pending: true, count: contributing, need: LVL_MIN_EQ };
    const st = levelStudy(pooled, { horizon: LVL_HORIZON, cellFloor: LVL_CELL_FLOOR });
    st.coverage = { tickers: contributing, skippedThin, windowDays: U.isCrypto ? MAIN_SPINE_DAYS : HOURLY_HISTORY_DAYS,
      minBars: LVL_MINBARS, stride: LVL_STRIDE };
    // The HVN report card: same aggregator, same floors, same distance buckets — directly
    // comparable to the structural section above it. Until this shows excess over the matched
    // placebo, the level map's hvn weight stays labeled hand-set and nothing downstream may
    // cite an HVN as a measured edge.
    if (pooledVp.length) {
      st.profile = levelStudy(pooledVp, { horizon: LVL_HORIZON, cellFloor: LVL_CELL_FLOOR });
      st.profile.coverage = { tickers: contributingVp, source: "hvn", stride: LVL_STRIDE + 2,
        note: "walk-forward volume-profile HVNs scored by the structural study's own loop and permutation control; LVNs are traversal features and are not auditable by touch/hold" };
    }
    // Per-ticker verdicts through the SAME aggregator with the SAME floors — one code path. The
    // distance buckets ship per name so the chart follows the scope selector; most per-name cells
    // sit under the floor by construction and render as honest dim slots disclosing their n.
    st.byTicker = {};
    for (const r of eq) {
      if (!r._lvEv || !r._lvEv.length) continue;
      const one = levelStudy(r._lvEv, { horizon: LVL_HORIZON, cellFloor: LVL_CELL_FLOOR });
      st.byTicker[r.coin] = { ticker: r.ticker, n: one.n, overall: one.overall, byTouches: one.byTouches,
        buckets: one.buckets, far: one.far, cellFloor: one.cellFloor };
    }
    return st;
  }

  // ---- EMA200 trend events study (served in sections.ema200, build 2026.07.27-26) -------------
  // Does the most-watched trend line earn the reverence: close-confirmed crosses (three
  // confirmation variants dueling per side) and retests, walk-forward, vs matched permutation
  // placebo. D1 rides mergedDailyBars (370d both universes since -20); H4 rides the spine
  // buckets (180d equity, 90d crypto — the crypto H4 walk is thin by construction and the
  // payload says so rather than hiding it). Forming bars trimmed via closedBars — the study's
  // events are closed-candle events, same discipline the -25 alert lane enforces live. Retests
  // ride the -22 injectable level audit with the walk-forward emaLast(200) as the level —
  // identical touch/hold semantics and control as the structural study, directly comparable.
  // Memo contract: per-name events recompute only when the spine-derived bucket array is
  // replaced (~10 min), the 3-min analytics cadence reads cache — same as the levels study.
  const EMA_TF = { "1d": { horizon: 14, stride: 5, minBars: 210 }, "4h": { horizon: 84, stride: 12, minBars: 210 } };
  const EMA_MIN_EQ = 5, EMA_CELL_FLOOR = 30, EMA_REARM = 3, EMA_BUF_SD = 0.25;
  function buildEma200Study(U) {
    U = U || analyticsUniverse("stocks");
    const eq = U.roster().filter((r) => U.studyEligible(r));
    const now = Date.now();
    const pool = { "1d": [], "4h": [] }, rpool = { "1d": [], "4h": [] };
    const contrib = { "1d": 0, "4h": 0 };
    const supp = { "1d": { raw: 0, buf: 0, "2cl": 0 }, "4h": { raw: 0, buf: 0, "2cl": 0 } };
    for (const r of eq) {
      const db = bucketsFor(r, 24);
      if (r._emSrc !== db) {
        r._emSrc = db;
        const out = { ev: {}, rt: {} };
        const src = { "1d": closedBars(mergedDailyBars(r), DAY, now), "4h": closedBars(bucketsFor(r, 4), 4 * HOUR, now) };
        for (const tf of ["1d", "4h"]) {
          const cfg = EMA_TF[tf], bars = src[tf];
          if (!Array.isArray(bars) || bars.length < cfg.minBars + cfg.horizon + 2) continue;
          // sigma in the rung's OWN bar units, so a 14-bar D1 move and an 84-bar H4 move are
          // scored on each series' native volatility — comparable across names, honest per TF.
          const closes = bars.map((k) => [k.t, k.c]);
          const sdTf = retStd(dailyRets(closes).slice(-90), 15);
          if (!(sdTf > 0)) continue;
          out.ev[tf] = emaCrossOutcomes(bars, sdTf, { N: 200, horizon: cfg.horizon, rearm: EMA_REARM, bufSd: EMA_BUF_SD });
          out.rt[tf] = levelOutcomes(bars, sdTf, { stride: cfg.stride, horizon: cfg.horizon, minBars: cfg.minBars,
            detect: (pb, px2, sd2) => {
              const e2 = emaLast(pb.map((k) => k.c), 200);
              return e2 == null ? null : { tauPct: Math.max(sd2 > 0 ? 0.4 * sd2 : 0, 0.5),
                items: [{ v: e2, side: e2 >= px2 ? "res" : "sup", n: 1, ageD: 0 }] };
            } }).events;
        }
        r._emEv = out;
      }
      const o2 = r._emEv;
      if (!o2) continue;
      for (const tf of ["1d", "4h"]) {
        if (o2.ev[tf] && o2.ev[tf].n) {
          contrib[tf]++;
          for (const e of o2.ev[tf].events) pool[tf].push(e);
          for (const v in supp[tf]) supp[tf][v] += o2.ev[tf].suppressed[v] || 0;
        }
        if (o2.rt[tf]) for (const e of o2.rt[tf]) rpool[tf].push(e);
      }
    }
    if (contrib["1d"] < EMA_MIN_EQ) return { pending: true, count: contrib["1d"], need: EMA_MIN_EQ };
    const sec = { horizons: { "1d": EMA_TF["1d"].horizon, "4h": EMA_TF["4h"].horizon },
      rearm: EMA_REARM, bufSd: EMA_BUF_SD, cellFloor: EMA_CELL_FLOOR, tf: {} };
    for (const tf of ["1d", "4h"]) {
      const rt = rpool[tf].length ? levelStudy(rpool[tf], { horizon: EMA_TF[tf].horizon, cellFloor: LVL_CELL_FLOOR }) : null;
      sec.tf[tf] = { n: pool[tf].length, contributing: contrib[tf], suppressed: supp[tf],
        cross: emaCrossStudy(pool[tf], { cellFloor: EMA_CELL_FLOOR }),
        // bySide IS the bullish/bearish retest split: sup = touched from above and held (bullish
        // support retest), res = rejected from below (bearish resistance retest).
        retest: rt ? { n: rt.n, overall: rt.overall, bySide: rt.bySide, cellFloor: rt.cellFloor } : null };
    }
    return sec;
  }

  // ---- session anatomy (served in sections.anatomy) ------------------------------------------
  // Four descriptive base-rate studies off one per-UTC-day record pass: excursion from the open,
  // open-quartile splits, Monday-range containment, naked-open revisits. Same scope wall as every
  // study (xyz equities via activeMarkets), same day-pooled honesty (rates are cross-sectional
  // means per day averaged across days; the published n is days, not ticker-sessions), same
  // memo contract as the levels study: per-ticker records recompute only when the spine object
  // itself is replaced (~10 min), so the 3-min analytics cadence reads cache.
  const ANAT_MIN_EQ = 5, ANAT_MIN_SESS = 20, ANAT_MIN_CROSS = 3;
  function buildAnatomy(U) {
    U = U || analyticsUniverse("stocks");
    const eq = U.roster().filter((r) => U.studyEligible(r));
    const perTicker = []; let skippedThin = 0;
    for (const r of eq) {
      const hs = getHourly(r.coin);
      if (!Array.isArray(hs) || !hs.length) { skippedThin++; continue; }
      if (r._anSrc !== hs) {
        r._anSrc = hs;
        const rec = anatomyEnrich(sessionRecords(hs, {}));
        if (rec.length >= ANAT_MIN_SESS) {
          const monday = mondayStats(rec), naked = nakedStats(rec), candles = candleEvents(rec);
          r._anRec = { records: rec, monday, naked, candles,
            summary: anatomyTickerSummary(rec, monday, naked, candles, { minN: ANAT_MIN_SESS }) };
        } else r._anRec = null;
      }
      if (r._anRec) perTicker.push(Object.assign({ coin: r.coin, ticker: r.ticker }, r._anRec)); else skippedThin++;
    }
    if (perTicker.length < ANAT_MIN_EQ) return { pending: true, count: perTicker.length, need: ANAT_MIN_EQ };
    const pool = anatomyPool(perTicker, { minCross: ANAT_MIN_CROSS });
    pool.coverage = { windowDays: U.isCrypto ? MAIN_SPINE_DAYS : HOURLY_HISTORY_DAYS, minSessions: ANAT_MIN_SESS, minCross: ANAT_MIN_CROSS, skippedThin };
    pool.isCrypto = U.isCrypto;
    // Per-ticker scope: within-name time series, same floors — the client labels the n-basis switch.
    pool.byTicker = {};
    for (const tk of perTicker) pool.byTicker[tk.coin] = Object.assign({ ticker: tk.ticker }, tk.summary);
    // Candle behaviour + time pivots ride the SAME per-ticker records — one pass, three studies.
    pool.candles = candlePool(perTicker, { minCross: ANAT_MIN_CROSS });
    pool.pivots = pivotPool(perTicker, { minCross: ANAT_MIN_CROSS });
    return pool;
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
      if (Array.isArray(m.daily) && m.daily.length) r.dailyRaw = m.daily.map(([t, c, h, v]) => ({ t, c, h: h == null ? undefined : h, v: v == null ? undefined : v }));   // pre--06 warm files are 2-tuples — h/v hydrate undefined and the spine overlay covers them
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
  // Nearest upcoming macro event within 1 ET day — the universe-wide analogue of earnProx.
  // Ticker-independent by construction: FOMC moves BTC as hard as it moves SPX.
  function macroProx(nowMs) {
    const ent = macroCache && Array.isArray(macroCache.entries) ? macroCache.entries : [];
    let best = null;
    for (const e of ent) {
      if (macroEntryState(e, nowMs) !== "upcoming") continue;
      const df = earnDayDiff(e.d, nowMs);
      if (df == null || df < 0 || df > 1) continue;
      if (!best || df < best.prox) best = { k: e.k, label: e.label, d: e.d, tEt: e.tEt, prox: df };
    }
    return best;
  }
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
    // scrub pre-fix persisted placeholder actuals (epsA:0) — merge can never blank them itself
    earnPrints = scrubPlaceholderActuals(Array.isArray(data.prints) ? data.prints : []);
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
  // ---- news feed (Finnhub, xyz universe) ---------------------------------------------------
  // Company headlines rotate through the equity roster (same Equity gate the earnings
  // machinery uses) a few names per minute — well inside the free tier's 60/min — plus the
  // general macro tape every 15 minutes for the non-company tickers. Fully degradable like
  // earnings: no token or a dead endpoint means an error string on the payload, never a
  // broken tab. Retention/dedupe/caps are pure (mergeNews); eviction keys on PUBLISH time.
  let newsItems = [], newsCache = null, newsVer = 0, newsSig = "", newsErr = null, newsFetchedAt = 0;
  let earnLnSig = "", earnLnVer = 0;   // earnings<->filings link overlay: ETag component
  const newsTkAt = new Map();          // ticker -> last company-news fetch ms (rotation order)
  const NEWS_BATCH = 3;                // company tickers per minute tick
  const sigTickers = new Set();        // tickers with a live kept signal, refreshed each signals build
  function newsParse(raw, tk) {
    const out = [];
    if (!Array.isArray(raw)) return out;
    for (const a of raw) {
      if (!a || a.id == null || !a.headline) continue;
      const pub = (typeof a.datetime === "number" ? a.datetime : 0) * 1000;
      out.push({ id: a.id, tk: tk || null, h: String(a.headline).slice(0, 220),
        src: a.source ? String(a.source).slice(0, 40) : null, url: a.url || null, pub,
        sm: a.summary ? String(a.summary).slice(0, 400) : null });   // transient: relevance gating only, stripped before merge
    }
    return out;
  }
  // ---- relevance pipeline -------------------------------------------------------------------
  // Policy: the universe feed shows ONLY items verified to concern a universe name. An item
  // fetched under ticker T is attributed to T iff the deterministic gate passes (symbol as a
  // word, or a company alias — seeded map + AI-learned aliases). Everything else keeps its
  // fetch-ticker internally but ships UNATTRIBUTED (rel=0, pending) into the tape lane until
  // the AI verdict lands: about T after all (rel=1) / actually about another universe name
  // (re-tagged, validated against the roster) / market-general (demoted to tape) / off-topic
  // (tape + "off-topic" sector, hidden-by-default client-side). Verdicts are write-once and
  // mutate the persisted item, so nothing is ever re-judged.
  let nameLearned = {};                       // TICKER -> [aliases] (AI, write-once, persisted)
  const relTries = new Map();                 // articleId -> failed verdict attempts
  function aliasesFor(T) {
    const seed = nameAliases(T), learned = nameLearned[T];
    return seed && learned ? seed.concat(learned) : (seed || learned || null);
  }
  function gateCompanyItems(parsed) {
    // mutates each parsed item: rel=1 verified, rel=0 pending; strips the transient summary
    for (const a of parsed) {
      if (a.tk) a.rel = newsRelevant(a.h, a.sm, a.tk, aliasesFor(String(a.tk).toUpperCase())) ? 1 : 0;
      delete a.sm;
    }
    return parsed;
  }
  function regatePending() {
    // fresh aliases can promote pending items deterministically — no model call needed
    let promoted = 0;
    for (const a of newsItems)
      if (a.tk && a.rel === 0 && newsRelevant(a.h, null, a.tk, aliasesFor(String(a.tk).toUpperCase()))) { a.rel = 1; promoted++; }
    return promoted;
  }
  // Macro-lane roster (build 2026.07.28-03): every LIVE non-equity xyz name that declares a news
  // lane, as [TICKER, lane] pairs. Rebuilt each payload from `rows`, so a name that is not in the
  // universe can never be stamped onto a headline. Broad-lane names (the S&P, the VIX, the dollar
  // index) take the whole tape by definition and are stamped onto every non-off-topic tape item;
  // scoped names are stamped only when the headline actually names one of their topics.
  function macroLaneRoster() {
    const out = [];
    for (const r of rows.values()) {
      if (r.delisted || r.uni !== "xyz" || !r.ticker) continue;
      const L = macroLane(r.ticker, r.uni);
      if (L) out.push([String(r.ticker).toUpperCase(), L]);
    }
    return out;
  }
  // Write-once per article id: headlines are immutable once stored, so the match set is computed
  // exactly once and reused for the life of the item. Keyed by id + roster signature so a roster
  // change (a new listing, a delisting) recomputes rather than serving a stale set.
  const mtkCache = new Map();
  function macroTagsFor(a, roster, rosterSig) {
    const key = String(a.id);
    const hit = mtkCache.get(key);
    if (hit && hit.sig === rosterSig) return hit.tk;
    const tk = [];
    for (const [T, L] of roster) {
      if (L.broad) { tk.push(T); continue; }
      if (topicHit(a.h, L.topics)) tk.push(T);
    }
    const v = tk.length ? tk : null;
    mtkCache.set(key, { sig: rosterSig, tk: v });
    return v;
  }
  function pruneMtkCache() { const live = new Set(newsItems.map((a) => String(a.id))); for (const k of mtkCache.keys()) if (!live.has(k)) mtkCache.delete(k); }

  function buildNewsPayload() {
    // per-item context stamps, all server-side so the tab stays dumb: coin (drawer deep-link),
    // ed (days to earnings when <=7 — the amber badge), sig (a live kept signal is firing —
    // the red badge, refreshed each signals build so it can lag a build; the tooltip says so)
    const mtRoster = macroLaneRoster();
    const mtSig = mtRoster.map((x) => x[0]).join(",");
    pruneMtkCache();
    const byTk = new Map();
    for (const r of rows.values()) if (!r.delisted && r.ticker && r.uni === "xyz") byTk.set(String(r.ticker).toUpperCase(), r);   // xyz only — telegram attribution is equities-only by policy
    const edByTk = new Map();
    if (earnCache && Array.isArray(earnCache.entries))
      for (const e of earnCache.entries) {
        const d = earnDayDiff(e.d, Date.now());
        if (d != null && d >= 0 && d <= 7) { const T = String(e.t).toUpperCase(); if (!edByTk.has(T) || d < edByTk.get(T)) edByTk.set(T, d); }
      }
    const items = newsItems.map((a) => {
      const r = a.tk ? byTk.get(String(a.tk).toUpperCase()) : null;
      const o = { id: a.id, tk: a.tk, h: a.h, src: a.src, url: a.url, pub: a.pub };
      if (a.tg) o.tg = 1;
      // Lane semantics (the no-leak policy): a ticker ships ONLY on verified items (rel=1).
      // Pending items ship unattributed with pend=1 — tape lane, honest tooltip — and demoted
      // items are plain tape. The internal fetch-ticker never reaches the client unverified.
      if (a.fl) {   // filings: deterministically attributed, own lane, own fields — the rel machinery never applies
        o.fl = 1; o.form = a.form;
        if (a.mat) o.mat = 1;
        if (a.own) o.own = 1;
        const rr = byTk.get(String(a.tk).toUpperCase());
        if (rr) o.coin = rr.coin;
        return o;
      }
      const verified = a.tk && a.rel === 1;
      if (!verified) { o.tk = null; if (a.tk) o.pend = 1; }
      if (verified && a.relAi) o.relAi = 1;
      if (verified && r) o.coin = r.coin;
      const ed = verified ? edByTk.get(String(a.tk).toUpperCase()) : undefined;
      if (ed != null) o.ed = ed;
      if (verified && sigTickers.has(String(a.tk).toUpperCase())) o.sig = 1;
      // sector, with provenance: the static GICS map wins outright (deterministic, no marker);
      // the AI-learned map covers Unclassified tickers; tape items ride their content-based
      // classification. Anything AI-derived wears secAi so the client can badge it honestly.
      if (verified) {
        const cs = classifyCached(a.tk).sector;
        if (cs && cs !== "Unclassified") o.sec = cs;
        else { const L = secLearned[String(a.tk).toUpperCase()]; if (L) { o.sec = L; o.secAi = 1; } }
      } else if (secTape[String(a.id)] != null) { o.sec = secTape[String(a.id)]; o.secAi = 1; }
      // Macro lane: which macro instruments this UNATTRIBUTED tape headline is news FOR. Only the
      // plain tape earns tags — a verified company item already has its own name, and a pending
      // item has not cleared relevance yet, so neither may leak into a macro drawer. Off-topic
      // items are excluded here rather than client-side, so every consumer agrees.
      if (!verified && !o.pend && o.sec !== "off-topic") {
        const mt = macroTagsFor(a, mtRoster, mtSig);
        if (mt) o.mtk = mt;
      }
      return o;
    });
    const sig = items.length + "|" + (items[0] ? items[0].id : "") + "|" + items.filter((x) => x.sig).length + "|" + items.filter((x) => x.ed != null).length + "|" + items.filter((x) => x.sec).length
      + "|" + items.filter((x) => x.tk).length + "|" + items.filter((x) => x.pend).length + "|" + items.filter((x) => x.fl).length + "|" + items.filter((x) => x.mtk).length + "|" + (newsErr || "");
    if (sig !== newsSig) { newsSig = sig; newsVer = Date.now(); }
    newsCache = { ts: Date.now(), dataTs: newsVer, items, fetchedAt: newsFetchedAt || null,
      ttlHours: 72, error: newsErr, count: items.length,
      flStat: { lastOk: edgarStat.lastOk, lastErr: edgarStat.lastErr, names: edgarStat.names, roster: earnEligible().size } };
  }
  async function newsCompanyTick() {
    const token = process.env.FINNHUB_TOKEN || "";
    if (!token) { newsErr = "FINNHUB_TOKEN not set"; buildNewsPayload(); return; }
    const roster = [...earnEligible().values()];
    if (!roster.length) return;
    roster.sort((a, b) => (newsTkAt.get(a.ticker) || 0) - (newsTkAt.get(b.ticker) || 0));
    const batch = roster.slice(0, NEWS_BATCH), now = Date.now();
    const iso = (ms) => new Date(ms).toISOString().slice(0, 10);
    let got = [];
    for (const m of batch) {
      newsTkAt.set(m.ticker, now);   // stamped before the call: a failing name must not wedge the rotation
      try {
        const res = await fetch(`https://finnhub.io/api/v1/company-news?symbol=${encodeURIComponent(m.ticker)}&from=${iso(now - 3 * DAY)}&to=${iso(now)}&token=${encodeURIComponent(token)}`,
          { headers: { accept: "application/json" } });
        if (!res.ok) { if (res.status === 401 || res.status === 403) { newsErr = `Finnhub company-news: HTTP ${res.status} (entitlement)`; } continue; }
        got = got.concat(gateCompanyItems(newsParse(await res.json(), m.ticker)));
        newsErr = null;
      } catch (e) { newsErr = "company-news fetch failed: " + (e && e.message); }
    }
    if (got.length || newsErr) {
      newsItems = mergeNews(newsItems, got, now);
      newsFetchedAt = now;
      buildNewsPayload();
      store.saveNews({ ts: now, items: newsItems, secTape, secLearned, nameLearned });
    }
  }
  async function newsTapeTick() {
    const token = process.env.FINNHUB_TOKEN || "";
    if (!token) { newsErr = "FINNHUB_TOKEN not set"; buildNewsPayload(); return; }
    try {
      const res = await fetch(`https://finnhub.io/api/v1/news?category=general&token=${encodeURIComponent(token)}`,
        { headers: { accept: "application/json" } });
      if (!res.ok) { newsErr = `Finnhub news: HTTP ${res.status}`; buildNewsPayload(); return; }
      newsItems = mergeNews(newsItems, newsParse(await res.json(), null), Date.now());
      pruneSecTape();
      newsFetchedAt = Date.now(); newsErr = null;
      buildNewsPayload();
      store.saveNews({ ts: Date.now(), items: newsItems, secTape, secLearned, nameLearned });
    } catch (e) { newsErr = "tape fetch failed: " + (e && e.message); buildNewsPayload(); }
  }
  // ---- fundamentals (Finnhub basic financials + profile2 · xyz equity universe) -----------
  // The equity-side counterpart to the Coinalyze derivs panel: per-ticker company fundamentals
  // in the drawer. Same degradation contract as earnings/news — no token or a dead endpoint is an
  // error string on the payload, never a broken panel; a name the free (US-only) tier can't resolve
  // is honestly "not covered", never a fabricated grid (the earnings tab's "absent, never guessed").
  //
  // ONE-CODE-PATH NOTE. Everything genuinely quarterly (EPS TTM, rev/sh, margins, ROE/ROA, growth,
  // P/B, div yield, 52w range, name, industry) is cached from Finnhub and refreshed daily. The three
  // PRICE-sensitive figures — market cap, P/E, P/S — are NOT cached: getFundamentals derives them live
  // off the board's own mark (r.px) at read time, so they can never disagree with the price the drawer
  // header shows. Negative/zero trailing EPS => P/E is n/m, never a negative multiple.
  let fundErr = null, fundVer = 0, fundLastOk = 0;
  const fundData = new Map();   // US symbol -> cached quarterly record { at, name, ind, shares, epsTTM, revPsTTM, ... }
  const fundAt = new Map();     // US symbol -> last fetch-attempt ms (rotation order + TTL + the "tried but empty = foreign" signal)
  const fundSym = (ticker) => { const T = String(ticker).toUpperCase(); return FUND_ALIAS[T] || T; };
  // Finnhub basic-financials margins/yields are ALREADY percentages (74.9 = 74.9%); passed through
  // unscaled. profile2 shareOutstanding is in MILLIONS. Both documented and pinned, so a future scale
  // surprise is a conscious change rather than a silent one.
  function parseFundamentals(mj, pj, now) {
    const M = (mj && mj.metric) || {};
    const P = pj || {};
    const num = (v) => (typeof v === "number" && isFinite(v)) ? v : null;
    const rec = {
      at: now,
      name: (P.name && String(P.name).slice(0, 80)) || null,
      ind: (P.finnhubIndustry && String(P.finnhubIndustry).slice(0, 60)) || null,
      shares: num(P.shareOutstanding),                                  // MILLIONS
      epsTTM: num(M.epsTTM),                                            // -> live P/E
      revPsTTM: num(M.revenuePerShareTTM),                             // -> live P/S
      pb: num(M.pbAnnual != null ? M.pbAnnual : M.pbQuarterly),
      divY: num(M.currentDividendYieldTTM != null ? M.currentDividendYieldTTM : M.dividendYieldIndicatedAnnual),
      gm: num(M.grossMarginTTM), om: num(M.operatingMarginTTM), nm: num(M.netProfitMarginTTM),
      roe: num(M.roeTTM), roa: num(M.roaTTM),
      revG: num(M.revenueGrowthTTMYoy), epsG: num(M.epsGrowthTTMYoy),
      wkHi: num(M["52WeekHigh"]), wkLo: num(M["52WeekLow"]),
      wkHiD: (M["52WeekHighDate"] && String(M["52WeekHighDate"]).slice(0, 10)) || null,
      wkLoD: (M["52WeekLowDate"] && String(M["52WeekLowDate"]).slice(0, 10)) || null,
    };
    // A genuine hit needs at least a name or one financial; an all-null body is "not resolved"
    // (foreign/uncovered) and is NOT cached, so the rotation retries it on a later pass.
    if (!rec.name && rec.epsTTM == null && rec.gm == null && rec.pb == null && rec.wkHi == null) return null;
    return rec;
  }
  async function fundTick() {
    const token = process.env.FINNHUB_TOKEN || "";
    if (!token) { fundErr = "FINNHUB_TOKEN not set"; return; }
    const roster = [...earnEligible().values()];   // {coin, ticker} — the SAME eligibility gate as earnings
    if (!roster.length) return;                     // universe not reconciled yet
    const now = Date.now();
    const due = roster
      .map((m) => ({ sym: fundSym(m.ticker) }))
      .filter((x) => now - (fundAt.get(x.sym) || 0) >= FUND_TTL)
      .sort((a, b) => (fundAt.get(a.sym) || 0) - (fundAt.get(b.sym) || 0));
    if (!due.length) return;
    const batch = due.slice(0, FUND_BATCH);
    let changed = false;
    for (const { sym } of batch) {
      fundAt.set(sym, now);   // stamped BEFORE the calls: a failing/empty name must not wedge the rotation, and "tried but empty" is exactly the foreign-listing signal getFundamentals reads
      try {
        const mres = await fetch(`https://finnhub.io/api/v1/stock/metric?symbol=${encodeURIComponent(sym)}&metric=all&token=${encodeURIComponent(token)}`,
          { headers: { accept: "application/json" }, signal: AbortSignal.timeout(20000) });
        if (!mres.ok) { if (mres.status === 401 || mres.status === 403) fundErr = `Finnhub metric: HTTP ${mres.status} (entitlement)`; continue; }
        const mj = await mres.json();
        let pj = {};
        const pres = await fetch(`https://finnhub.io/api/v1/stock/profile2?symbol=${encodeURIComponent(sym)}&token=${encodeURIComponent(token)}`,
          { headers: { accept: "application/json" }, signal: AbortSignal.timeout(20000) });
        if (pres.ok) pj = await pres.json();
        const rec = parseFundamentals(mj, pj, now);
        if (rec) { fundData.set(sym, rec); changed = true; fundErr = null; }
      } catch (e) { fundErr = "fundamentals fetch failed: " + (e && e.message); }
    }
    if (changed) {
      fundVer = Date.now(); fundLastOk = Date.now();
      if (store.saveFund) store.saveFund({ ts: fundLastOk, data: [...fundData.entries()] });
    }
  }
  function hydrateFund() {
    const d = store.loadFund && store.loadFund();
    if (d && Array.isArray(d.data)) {
      for (const [sym, rec] of d.data) { if (sym && rec) { fundData.set(sym, rec); fundAt.set(sym, rec.at || 0); } }
      if (fundData.size) fundVer = Date.now();
      fundLastOk = d.ts || 0;
    }
    return fundData.size;
  }
  // Cached read; the price-sensitive trio (mkt cap / P/E / P/S) is derived live HERE off the board
  // mark so it tracks the header price. Non-equity and unresolved names get an honest not-covered
  // payload, never a fabricated grid.
  function getFundamentals(coin) {
    const base = { coin: coin || "", ts: Date.now(), src: "finnhub", ver: fundVer };
    const token = process.env.FINNHUB_TOKEN || "";
    if (!token) return { ...base, enabled: false, error: "disabled (no FINNHUB_TOKEN on the server)" };
    const r = coin ? rows.get(coin) : null;
    if (!r || r.uni !== "xyz" || r.delisted) return { ...base, enabled: true, covered: false, reason: "not in the equity universe" };
    const ac = classifyCached(r.ticker).assetClass || "instrument";
    if (ac !== "Equity") return { ...base, enabled: true, covered: false, reason: "non-equity (" + ac + ") — no company fundamentals" };
    const sym = fundSym(r.ticker);
    const f = fundData.get(sym);
    if (!f) {
      const tried = fundAt.has(sym);
      return { ...base, enabled: true, covered: false, pending: !tried,
        reason: tried ? "foreign listing — not resolved by the US feed" : "collecting — not fetched yet",
        asOf: fundLastOk || null };
    }
    const px = (r.px != null && isFinite(r.px)) ? r.px : null;
    const epsNm = (f.epsTTM != null && f.epsTTM <= 0);   // negative/zero trailing EPS => P/E not meaningful
    const mcap = (px != null && f.shares != null) ? px * f.shares * 1e6 : null;
    const pe = (px != null && f.epsTTM != null && f.epsTTM > 0) ? px / f.epsTTM : null;
    const ps = (px != null && f.revPsTTM != null && f.revPsTTM > 0) ? px / f.revPsTTM : null;
    const rangePos = (px != null && f.wkHi != null && f.wkLo != null && f.wkHi > f.wkLo)
      ? (px - f.wkLo) / (f.wkHi - f.wkLo) : null;
    return { ...base, enabled: true, covered: true, sym, name: f.name, ind: f.ind,
      asOf: f.at, dataAsOf: fundLastOk || null, px,
      mcap, pe, peNm: epsNm, ps, pb: f.pb, divY: f.divY,
      epsTTM: f.epsTTM, revPsTTM: f.revPsTTM, revG: f.revG, epsG: f.epsG,
      roe: f.roe, roa: f.roa, shares: f.shares,
      gm: f.gm, om: f.om, nm: f.nm,
      wkHi: f.wkHi, wkLo: f.wkLo, wkHiD: f.wkHiD, wkLoD: f.wkLoD, rangePos };
  }
  // ---- telegram channels (public t.me previews — no bot, no credentials) -------------------
  // Shared group config, persisted to its own volume file. Every channel fetches on a 10-min
  // cadence; per-channel status (green/red dot in the manager) rides the payload. Degradation
  // contract like Finnhub: a dead or preview-disabled channel is a red dot and a retry, never
  // a broken tab. Markup drift (page fetched, blocks present, nothing parsed) logs a warning
  // and surfaces as the channel's error.
  let tgChannels = [];
  const tgStatus = new Map();          // channel -> { lastOk, error, posts }
  const TG_MAX = 12, TG_RE = /^[A-Za-z0-9_]{4,32}$/;
  function tgRoster() {
    // xyz universe ONLY. Crypto symbols are word-match landmines in telegram text — BTC, SOL,
    // OP, APT appear in half the posts on any crypto channel — and attributing them floods the
    // crypto drawers with channel chatter. A "MicroStrategy adds BTC" post belongs to MSTR;
    // with crypto out of the roster, that's exactly what the single-name rule now yields.
    const m = new Map();
    for (const r of rows.values()) {
      if (r.delisted || !r.ticker || r.uni !== "xyz") continue;
      const T = String(r.ticker).toUpperCase();
      if (!m.has(T)) m.set(T, aliasesFor(T));
    }
    return m;
  }
  async function tgTick() {
    if (!tgChannels.length) return;
    const roster = tgRoster();
    let got = [];
    for (const ch of tgChannels) {
      try {
        const res = await fetch(`https://t.me/s/${encodeURIComponent(ch)}`, { headers: { accept: "text/html" } });
        if (!res.ok) { tgStatus.set(ch, { lastOk: (tgStatus.get(ch) || {}).lastOk || null, error: "HTTP " + res.status, posts: 0 }); continue; }
        const { items, blocks } = parseTgPreview(await res.text(), ch, Date.now());
        if (!items.length && blocks > 0) {
          tgStatus.set(ch, { lastOk: (tgStatus.get(ch) || {}).lastOk || null, error: "markup drift: page fetched, nothing parsed", posts: 0 });
          log(`telegram ${ch}: WARN markup drift — ${blocks} block(s) fetched, zero messages parsed`);
          continue;
        }
        for (const a of items) {
          const T = attributeTg(a.h, roster);   // exactly-one-name rule: same trust as the deterministic gate
          if (T) { a.tk = T; a.rel = 1; }
        }
        got = got.concat(items);
        tgStatus.set(ch, { lastOk: Date.now(), error: null, posts: items.length });
      } catch (e) {
        tgStatus.set(ch, { lastOk: (tgStatus.get(ch) || {}).lastOk || null, error: "fetch failed: " + (e && e.message), posts: 0 });
      }
    }
    for (const ch of [...tgStatus.keys()]) if (!tgChannels.includes(ch)) tgStatus.delete(ch);
    if (got.length) {
      newsItems = mergeNews(newsItems, got, Date.now());
      pruneSecTape();
      newsFetchedAt = Date.now();
      buildNewsPayload();
      store.saveNews({ ts: Date.now(), items: newsItems, secTape, secLearned, nameLearned });
    }
  }
  function purgeTgOrphans() {
    // removing a channel removes its POSTS, not just its config entry — otherwise junk from a
    // mistyped channel lives on for 72h after the ✕ and "remove" doesn't mean remove
    const live = new Set(tgChannels.map((c) => c.toLowerCase()));
    const before = newsItems.length;
    newsItems = newsItems.filter((a) => {
      if (!a.tg) return true;
      const m = /^tg:([A-Za-z0-9_]+):/.exec(String(a.id));
      return m ? live.has(m[1].toLowerCase()) : false;
    });
    const purged = before - newsItems.length;
    if (purged) { pruneSecTape(); buildNewsPayload(); store.saveNews({ ts: Date.now(), items: newsItems, secTape, secLearned, nameLearned }); }
    return purged;
  }
  // ---- SEC EDGAR filings (per-company Atom feeds) -------------------------------------------
  // sec.gov browse-edgar, rotated through the equity roster by staleness — 2 names/minute,
  // far inside SEC fair-access limits, with the User-Agent contact they require. Attribution
  // is deterministic by construction (each feed IS a company's). Filings live in their own
  // lane end to end: 7d retention, per-name cap, never mixed into the news/tape/telegram
  // lanes, never fed to the AI classifier, never part of the report's news context.
  const edgarTkAt = new Map();
  const SEC_UA = "xyz-monitor/" + version + " (" + (process.env.SEC_CONTACT || "ops@xyz-monitor.local") + ")";
  // Observability: silent catches made "no filings" and "SEC is rejecting us" indistinguishable
  // from the UI — the exact question a user asks on a quiet Sunday. Every outcome is counted,
  // the last error is kept verbatim, distinct errors log once, and the payload carries the
  // coverage stamp the footer shows.
  let edgarStat = { lastOk: null, lastErr: null, lastErrAt: null, ok: 0, http4: 0, http403: 0, fail: 0, names: 0, lastItems: 0 };
  let edgarLastLogged = "";
  async function edgarTick() {
    const roster = [...earnEligible().values()];
    if (!roster.length) return;
    roster.sort((a, b) => (edgarTkAt.get(a.ticker) || 0) - (edgarTkAt.get(b.ticker) || 0));
    const batch = roster.slice(0, 2), now = Date.now();
    let got = [];
    for (const m of batch) {
      edgarTkAt.set(m.ticker, now);   // stamped before the call: a failing name must not wedge the rotation
      try {
        const res = await fetch(`https://www.sec.gov/cgi-bin/browse-edgar?action=getcompany&CIK=${encodeURIComponent(m.ticker)}&type=&dateb=&owner=include&count=20&output=atom`,
          { headers: { accept: "application/atom+xml", "user-agent": SEC_UA } });
        if (!res.ok) {
          // 4xx on a foreign listing is expected; 403 across the board means the UA or the
          // egress IP is being rejected — the difference is exactly what the counters show
          if (res.status === 403) edgarStat.http403++; else edgarStat.http4++;
          edgarStat.lastErr = `HTTP ${res.status} (${m.ticker})`; edgarStat.lastErrAt = now;
          if (edgarLastLogged !== "http" + res.status) { edgarLastLogged = "http" + res.status; log(`EDGAR: HTTP ${res.status} on ${m.ticker}${res.status === 403 ? " — UA or egress IP likely rejected; filings will stall until this clears" : ""}`); }
          continue;
        }
        const { items } = parseEdgarAtom(await res.text(), m.ticker, now);
        edgarStat.ok++; edgarStat.lastOk = now; edgarStat.lastItems = items.length;
        got = got.concat(items);
        try { filingScan(items); }
        catch (e2) { log("filingScan failed (isolated, filings still land in the news tab): " + (e2 && e2.message)); }
      } catch (e) {
        edgarStat.fail++; edgarStat.lastErr = "fetch failed: " + (e && e.message); edgarStat.lastErrAt = now;
        if (edgarLastLogged !== "fetch") { edgarLastLogged = "fetch"; log("EDGAR: " + edgarStat.lastErr); }
      }
    }
    edgarStat.names = edgarTkAt.size;
    if (got.length) {
      newsItems = mergeNews(newsItems, got, now);
      newsFetchedAt = now;
      buildNewsPayload();
      store.saveNews({ ts: now, items: newsItems, secTape, secLearned, nameLearned });
    }
  }

  // ---- SEC EDGAR fundamentals + ETF holdings (on-demand, terminal-driven) --------------------
  // Two pull lanes for the ask terminal: `fund <T>` (latest filed balance sheet + income facts
  // via XBRL companyfacts) and `etf <SYM>` (latest N-PORT portfolio). On-demand only — nothing
  // polls; a name nobody asks about costs zero requests. All numbers come straight from filings
  // and are shaped by pure compute functions; the model never touches them. Caches are in-memory
  // with a 24h TTL (fundamentals change quarterly, N-PORT monthly — a redeploy refetching a few
  // asked-about names is cheaper than another persistence surface). Errors cache for 5 minutes so
  // a bad symbol can't hammer sec.gov, and an in-flight map dedupes concurrent asks for one name.
  // extFetch is the injected-transport test hook, same pattern as aiFetch.
  const extFetch = extFetchOpt || ((...a) => fetch(...a));
  const FUND_TTL = 24 * HOUR, EXT_ERR_TTL = 5 * 60 * 1000, EXT_TIMEOUT_MS = 25 * 1000;
  const fundCache = new Map();     // TICKER -> { at, res }
  const etfCache = new Map();      // SYMBOL -> { at, res }
  const extInflight = new Map();   // "fund:T" | "etf:S" -> Promise
  let cikMaps = null, cikMapsAt = 0;   // { co: SYM->{cik,name}, mf: SYM->{cik,seriesId,name} }
  async function extGet(url, kind) {
    const ac = new AbortController(); const t = setTimeout(() => ac.abort(), EXT_TIMEOUT_MS);
    try {
      const res = await extFetch(url, { headers: { "user-agent": SEC_UA, accept: kind === "xml" ? "application/xml" : "application/json" }, signal: ac.signal });
      if (!res.ok) return { ok: false, error: "HTTP " + res.status };
      return { ok: true, body: kind === "xml" ? await res.text() : await res.json() };
    } catch (e) { return { ok: false, error: "fetch failed: " + (e && e.message) }; } finally { clearTimeout(t); }
  }
  async function ensureCikMaps() {
    const now = Date.now();
    if (cikMaps && now - cikMapsAt < FUND_TTL) return cikMaps;
    const co = new Map(), mf = new Map();
    const a = await extGet("https://www.sec.gov/files/company_tickers.json", "json");
    if (a.ok && a.body && typeof a.body === "object")
      for (const k of Object.keys(a.body)) { const e = a.body[k];
        if (e && e.ticker && e.cik_str != null) co.set(String(e.ticker).toUpperCase(), { cik: +e.cik_str, name: e.title || null }); }
    // The mutual-fund/ETF map ships column-oriented: { fields:[...], data:[[...],...] }. Many
    // symbols repeat across share classes of one series — first hit wins, it carries the seriesId
    // the N-PORT match needs. This file failing is non-fatal: most large ETFs also appear in the
    // company map, they just lose series-level disambiguation.
    const b = await extGet("https://www.sec.gov/files/company_tickers_mf.json", "json");
    if (b.ok && b.body && Array.isArray(b.body.data) && Array.isArray(b.body.fields)) {
      const fi = {}; b.body.fields.forEach((f, i) => { fi[String(f).toLowerCase()] = i; });
      for (const row of b.body.data) { const sym = String(row[fi.symbol] || "").toUpperCase();
        if (sym && !mf.has(sym) && row[fi.cik] != null) mf.set(sym, { cik: +row[fi.cik], seriesId: row[fi.seriesid] || null, name: null }); }
    }
    if (!co.size && !mf.size) return null;   // both maps down -> caller reports honestly, cache stays empty
    cikMaps = { co, mf }; cikMapsAt = now; return cikMaps;
  }
  const cikPad = (cik) => String(cik).padStart(10, "0");
  function extCached(cache, key) { const c = cache.get(key);
    if (c && Date.now() - c.at < (c.res && c.res.ok ? FUND_TTL : EXT_ERR_TTL)) return c.res; return null; }
  function extRun(cache, key, flightKey, work) {
    const hit = extCached(cache, key); if (hit) return Promise.resolve(hit);
    if (extInflight.has(flightKey)) return extInflight.get(flightKey);
    const p = work().then((res) => { cache.set(key, { at: Date.now(), res });
      if (cache.size > 200) cache.clear(); return res; })
      .finally(() => extInflight.delete(flightKey));
    extInflight.set(flightKey, p); return p;
  }
  function fundamentals(tickerRaw) {
    const T = String(tickerRaw || "").toUpperCase().trim();
    if (!T || !/^[A-Z0-9.\-]{1,10}$/.test(T)) return Promise.resolve({ ok: false, error: "bad symbol" });
    return extRun(fundCache, T, "fund:" + T, async () => {
      const maps = await ensureCikMaps();
      if (!maps) return { ok: false, error: "SEC ticker map unavailable" };
      const hit = maps.co.get(T);
      if (!hit) return { ok: false, error: "no SEC filer found for " + T + " — fundamentals cover US-filed equities only" };
      const cf = await extGet("https://data.sec.gov/api/xbrl/companyfacts/CIK" + cikPad(hit.cik) + ".json", "json");
      if (!cf.ok) return { ok: false, error: "EDGAR companyfacts: " + cf.error };
      const shaped = pickXbrlFacts(cf.body);
      if (!shaped) return { ok: false, error: "filer has no usable XBRL facts (foreign or exempt filer)" };
      return { ok: true, ticker: T, src: "SEC EDGAR XBRL", data: shaped, at: Date.now() };
    });
  }
  function etfHoldings(symRaw) {
    const S = String(symRaw || "").toUpperCase().trim();
    if (!S || !/^[A-Z0-9.\-]{1,10}$/.test(S)) return Promise.resolve({ ok: false, error: "bad symbol" });
    return extRun(etfCache, S, "etf:" + S, async () => {
      const maps = await ensureCikMaps();
      if (!maps) return { ok: false, error: "SEC ticker map unavailable" };
      const mf = maps.mf.get(S), co = maps.co.get(S);
      const cik = (mf && mf.cik) || (co && co.cik);
      if (!cik) return { ok: false, error: "no SEC filer found for " + S };
      const sub = await extGet("https://data.sec.gov/submissions/CIK" + cikPad(cik) + ".json", "json");
      if (!sub.ok) return { ok: false, error: "EDGAR submissions: " + sub.error };
      const rec = sub.body && sub.body.filings && sub.body.filings.recent;
      if (!rec || !Array.isArray(rec.form)) return { ok: false, error: "no filing index for " + S };
      const cand = [];
      for (let i = 0; i < rec.form.length && cand.length < 5; i++)
        if (/^NPORT-P/.test(String(rec.form[i]))) cand.push({ acc: rec.accessionNumber[i], doc: rec.primaryDocument[i] || "primary_doc.xml" });
      if (!cand.length) return { ok: false, error: S + " has no N-PORT filings — not a registered fund (holdings cover ETFs/mutual funds only)" };
      // Multi-series trusts file one NPORT-P per series under the same CIK. When the mf map gave
      // us a seriesId we walk the recent filings until the XML's own seriesId matches; without
      // one, the newest filing is the honest best guess and the card shows the series name so a
      // mismatch is visible, never silent.
      let first = null;
      for (const c of cand) {
        const url = "https://www.sec.gov/Archives/edgar/data/" + cik + "/" + String(c.acc).replace(/-/g, "") + "/" + c.doc;
        const x = await extGet(url, "xml"); if (!x.ok) continue;
        const parsed = parseNportHoldings(x.body, 15); if (!parsed) continue;
        if (!first) first = parsed;
        if (!(mf && mf.seriesId) || parsed.seriesId === mf.seriesId) { first = parsed; break; }
      }
      if (!first) return { ok: false, error: "could not read an N-PORT document for " + S };
      return { ok: true, symbol: S, src: "SEC EDGAR N-PORT", data: first, at: Date.now(),
        lag: "N-PORT holdings are filed monthly with a 30\u201360 day lag \u2014 this is the latest FILED portfolio, not today's" };
    });
  }


  // ---- 13F whale lane (build 2026.08.16-01) ---------------------------------------------------
  // The FUNDS tab + `whale` terminal family: a persisted watchlist of institutional 13F filers,
  // a per-CIK submissions poll that catches new 13F-HR/-HR/A accessions, cached quarterly books
  // (current + prior, full aggregated positions), unseen-filing badges, filing-lane tape rows,
  // `filing`-class push events and the once-per-quarter season aggregate. All math is pure
  // (compute.parse13FInfotable / whaleBook / whaleDelta / whaleSeason / whaleWindow); this block
  // only fetches, sequences and persists — the fund/etf lane's division of labor, one lane over.
  // Freeze rule: an ingested filing is never refetched or recomputed; only a strictly newer
  // accession for the same quarter (an HR/A amendment) may supersede it, and the supersede is
  // recorded so the card can say "amended", never silently drift. Same transport (extGet + SEC_UA
  // + injected extFetch test hook) and the same error discipline as fund/etf: misses cache
  // briefly, nothing can hammer sec.gov.
  const WHALE_POLL_MS = 10 * 60 * 1000;          // due-check tick; per-fund cadence gates below
  const WHALE_IN_WINDOW_MS = 30 * 60 * 1000;     // per-fund submissions poll inside a filing window
  const WHALE_OFF_WINDOW_MS = 24 * HOUR;         // and outside it — filings can't exist, amendments can
  const WHALE_POS_CAP = 6000;                    // stored positions per filing; past it the book is truncated WITH a disclosure flag
  const WHALE_TOP_N = 15;                        // detail card default; `full` escapes it client-side
  let whaleState = { watch: [], filings: {}, unseen: {}, seasons: {} };
  // filings: { [cik]: { [q]: { acc, form, filedAt, period, book, amended? , truncated? } } }
  let whaleVer = 0;                              // ETag stamp — bumps on any state change the payload can see
  let whalePrimed = false;                       // first poll pass after boot seeds silently (the filingPrimed rule)
  let whalePolling = false;
  const whaleLastPoll = new Map();               // cik -> ts of last submissions check
  let whaleNameMap = null, whaleNameMapAt = 0;   // normalized issuer name -> ticker (from the SEC company map)
  function whaleBump() { whaleVer = Date.now(); }
  function whalePersist() {
    store.saveWhale && store.saveWhale({ ts: Date.now(), watch: whaleState.watch,
      filings: whaleState.filings, unseen: whaleState.unseen, seasons: whaleState.seasons });
  }
  function whaleHydrate() {
    try {
      const d = store.loadWhale && store.loadWhale();
      if (d && typeof d === "object") {
        if (Array.isArray(d.watch)) whaleState.watch = d.watch.filter((w) => w && w.key && w.cik);
        if (d.filings && typeof d.filings === "object") whaleState.filings = d.filings;
        if (d.unseen && typeof d.unseen === "object") whaleState.unseen = d.unseen;
        if (d.seasons && typeof d.seasons === "object") whaleState.seasons = d.seasons;
      }
    } catch (_) {}
    // Scale migration (build -04): filings ingested before the thousands-convention detector
    // existed were stored verbatim — a thousands filer's book sits 1000x small on the volume.
    // Re-run the SAME rule against the stored aggregated positions (SH rows kept their share
    // counts, so the implied-price test still works) and heal in place, flagged, no refetch.
    // scaleChecked marks every filing exactly once; a dollars filing gets the flag and no change.
    let healed = 0;
    for (const cik of Object.keys(whaleState.filings)) {
      const byQ = whaleState.filings[cik];
      for (const q of Object.keys(byQ)) {
        const fl = byQ[q];
        if (!fl || fl.scaleChecked || !fl.book || !Array.isArray(fl.book.positions)) continue;
        const det = whale13FScale(fl.book.positions);
        if (det.mult > 1) {
          for (const pos of fl.book.positions) pos.value *= det.mult;
          fl.book.total *= det.mult;
          fl.scaled = 1; healed++;
        } else fl.scaled = 0;
        fl.scaleChecked = 1;
      }
    }
    if (healed) { whalePersist(); log(`whale: scale migration corrected ${healed} stored filing(s) reported in the pre-2023 thousands convention (x1000, flagged + disclosed)`); }
    // Season drift sync AT hydrate: subsumes the -18-06 shape heal and the -19-01 heal v2 — one
    // detector (whaleSeasonSyncAll) now repairs roster drift, missing/aggV-stale aggregates and
    // metadata mismatches alike, so the first payload after any deploy already tells one story.
    try { whaleSeasonSyncAll(Date.now()); } catch (_) {}
    whaleBump();
    // A hydrated watchlist means past filings were already announced in a prior life — prime
    // immediately so the first poll can't re-announce them. An EMPTY list has nothing to blast.
    whalePrimed = true;
  }
  // Normalized-name -> ticker map from the same company_tickers.json the fund lane already pulls.
  // Conservative by construction: whaleNameKey on BOTH sides, first ticker wins a key, a collision
  // (two tickers normalizing identically) evicts the key entirely — a wrong chart link is worse
  // than a name-only row.
  async function whaleTickerMap() {
    const now = Date.now();
    if (whaleNameMap && now - whaleNameMapAt < FUND_TTL) return whaleNameMap;
    const maps = await ensureCikMaps();
    if (!maps) return whaleNameMap;   // stale beats empty; null on first miss means name-only rows
    const m = new Map(), dead = new Set();
    for (const [sym, e] of maps.co) {
      if (!e || !e.name) continue;
      const k = whaleNameKey(e.name);
      if (!k || dead.has(k)) continue;
      if (m.has(k) && m.get(k) !== sym) { m.delete(k); dead.add(k); continue; }
      m.set(k, sym);
    }
    whaleNameMap = m; whaleNameMapAt = now;
    return m;
  }
  function whaleTickerOf(name, tmap) {
    if (!tmap) return null;
    const t = tmap.get(whaleNameKey(name));
    return t || null;
  }
  // `whale add <name>` resolution: filer-name -> CIK candidates, LAYERED, most-forgiving lane
  // first. The original single-lane version phrase-searched EDGAR full-text — which searches
  // DOCUMENT CONTENTS, exact-phrase, so a prefix like "Duq" (or even a full legal name, depending
  // on how it appears in the doc body) returned nothing. That was the wrong tool holding the only
  // key. The lanes now, deduped on CIK in order:
  //   1) EDGAR's entity autocomplete (?keysTyped=) — the box the EDGAR UI's own company field
  //      uses. Prefix-friendly: "Duq" resolves. Not filtered to 13F filers, so a hit here is a
  //      CANDIDATE; the first poll after add verifies honestly (no 13F history -> the row says so).
  //   2) browse-edgar company search, type=13F-HR — prefix match on the official company DB,
  //      restricted to entities that actually filed 13F-HR. Verified hits, so they rank FIRST.
  //   3) the old full-text phrase search, last resort only when 1+2 both came up empty.
  // Every lane is parsed defensively and any lane may be down; a raw CIK number still bypasses
  // search entirely, so total search outage degrades to "paste the CIK", never to "can't add".
  const whaleEnt = (s) => String(s).replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#0?39;/g, "'");
  async function whaleSearch(qRaw) {
    const q = String(qRaw || "").trim().slice(0, 60);
    if (!q) return { ok: false, error: "usage: whale add <fund name or CIK>" };
    if (/^\d{1,10}$/.test(q)) {   // raw CIK — resolve straight off submissions for the canonical name
      const sub = await extGet("https://data.sec.gov/submissions/CIK" + cikPad(+q) + ".json", "json");
      if (!sub.ok) return { ok: false, error: "EDGAR submissions: " + sub.error };
      return { ok: true, candidates: [{ cik: +q, name: String(sub.body && sub.body.name || "CIK " + q).slice(0, 60) }] };
    }
    const CAP = 8;
    const seen = new Set();
    const verified = [], extra = [];   // 13F-verified hits rank ahead of unverified autocomplete hits
    const put = (arr, cik, name) => {
      if (!Number.isFinite(cik) || cik <= 0 || seen.has(cik)) return;
      seen.add(cik);
      const nm = whaleEnt(String(name || "CIK " + cik)).replace(/\s*\(CIK[^)]*\)\s*/i, "").replace(/\s+/g, " ").trim().slice(0, 60);
      arr.push({ cik, name: nm || "CIK " + cik });
    };
    // Lane 2 first in code (verified hits must claim their CIKs before autocomplete dedupes them
    // into the unverified bucket) — presentation order is verified-then-extra either way.
    const atom = await extGet("https://www.sec.gov/cgi-bin/browse-edgar?action=getcompany&company="
      + encodeURIComponent(q) + "&type=13F-HR&count=10&output=atom", "xml");
    if (atom.ok && typeof atom.body === "string") {
      // Two shapes share one parse: the multi-match COMPANY LIST (one <company-info> per entry)
      // and the single-match filing feed (one <company-info> for the whole document). Both carry
      // <cik> + <conformed-name> inside the block; anything else about the atom is ignored.
      const blocks = atom.body.match(/<company-info>[\s\S]*?<\/company-info>/g) || [];
      for (const b of blocks) {
        const c = b.match(/<cik>0*(\d+)<\/cik>/i);
        const n = b.match(/<conformed-name>([\s\S]*?)<\/conformed-name>/i);
        if (c) put(verified, +c[1], n ? n[1] : null);
        if (verified.length >= CAP) break;
      }
    }
    // Lane 1: entity autocomplete. _id carries the CIK (sometimes zero-padded); the entity string
    // sometimes embeds "(CIK NNN)" — put() strips it either way.
    if (verified.length < CAP) {
      const ac = await extGet("https://efts.sec.gov/LATEST/search-index?keysTyped=" + encodeURIComponent(q), "json");
      const hits = ac.ok && ac.body && ac.body.hits && Array.isArray(ac.body.hits.hits) ? ac.body.hits.hits : [];
      for (const h of hits) {
        if (!h) continue;
        const s = h._source || {};
        const idCik = /^0*\d+$/.test(String(h._id || "")) ? +String(h._id).replace(/^0+/, "") : null;
        const parCik = (String(s.entity || "").match(/\(CIK\s*0*(\d+)\)/i) || [])[1];
        put(extra, idCik != null ? idCik : (parCik != null ? +parCik : +s.cik), s.entity || s.name);
        if (verified.length + extra.length >= CAP) break;
      }
    }
    // Lane 3: the old full-text phrase search — kept ONLY as a net under the first two, because
    // it does catch a fund whose exact legal name appears verbatim in filings when the company DB
    // spelling differs from what the user typed.
    if (!verified.length && !extra.length) {
      const r = await extGet("https://efts.sec.gov/LATEST/search-index?q=" + encodeURIComponent('"' + q + '"') + "&forms=13F-HR", "json");
      const hits = r.ok && r.body && r.body.hits && Array.isArray(r.body.hits.hits) ? r.body.hits.hits : [];
      for (const h of hits) {
        const s = h && h._source; if (!s) continue;
        const ciks = Array.isArray(s.cik) ? s.cik : [s.cik];
        const names = Array.isArray(s.display_names) ? s.display_names : [];
        for (let i = 0; i < ciks.length; i++) { put(extra, +ciks[i], names[i] || names[0]); if (extra.length >= CAP) break; }
        if (extra.length >= CAP) break;
      }
    }
    const out = verified.concat(extra).slice(0, CAP);
    if (!out.length) return { ok: false, error: "no EDGAR entity matched \u201c" + q + "\u201d \u2014 a fund's legal filer name can differ from its brand name (try a shorter prefix); a raw CIK number always works: whale add <cik>" };
    return { ok: true, candidates: out };
  }
  function whaleKeyFor(name) {
    // User-facing handle: first meaningful word of the filer name, uppercased, de-collided with a
    // numeric suffix. Purely a label — identity is always the CIK.
    const base = (whaleNameKey(name).split(" ")[0] || "FUND").slice(0, 12) || "FUND";
    let k = base, n = 2;
    while (whaleState.watch.some((w) => w.key === k)) k = base + (n++);
    return k;
  }
  function whaleByKey(keyRaw) {
    const k = String(keyRaw || "").toUpperCase().trim();
    return whaleState.watch.find((w) => w.key === k) || null;
  }
  // `nowArg` exists for the suite, not for callers: the season build reads the filing calendar off
  // the clock, so a test that freezes time must be able to hand the same instant to the roster edit
  // it hands to the tick. Routes omit it and get Date.now(), which is the only correct value there.
  function whaleAdd(cik, name, nowArg) {
    if (!Number.isFinite(+cik)) return { ok: false, error: "bad CIK" };
    if (whaleState.watch.some((w) => +w.cik === +cik)) return { ok: false, error: "already watching CIK " + cik };
    if (whaleState.watch.length >= 24) return { ok: false, error: "watchlist cap (24) reached" };
    const w = { key: whaleKeyFor(name), name: String(name || "CIK " + cik).slice(0, 60), cik: +cik, notify: 1, addedAt: Date.now() };
    whaleState.watch.push(w);
    whaleLastPoll.delete(+cik);   // poll it on the next tick
    whaleBump(); whalePersist();
    // The roster IS an input to the season aggregate, so editing it reopens the build here rather
    // than at the next tick. Without this the panel's counts describe the OLD watchlist until the
    // cadence comes round — up to 24h in the "upcoming" stretch — while the grid beside them has
    // already moved. The rebuild is cheap (pure math over books already on the volume) and is a
    // no-op whenever the roster change didn't alter what the aggregate consumed.
    whaleSeasonMaybe(nowArg || Date.now());
    whaleSeasonSyncAll(nowArg || Date.now());   // closed quarters follow the roster too — the header can never disagree with the fund list
    log(`whale: watching ${w.key} (${w.name}, CIK ${w.cik})`);
    return { ok: true, fund: w };
  }
  function whaleRm(keyRaw, nowArg) {
    const w = whaleByKey(keyRaw);
    if (!w) return { ok: false, error: "not watching \u201c" + String(keyRaw || "") + "\u201d" };
    whaleState.watch = whaleState.watch.filter((x) => x !== w);
    delete whaleState.unseen[w.cik];
    // Cached filings stay — history kept, row hidden (re-adding the fund restores it whole).
    whaleBump(); whalePersist();
    whaleSeasonMaybe(nowArg || Date.now());   // same reason as whaleAdd: the roster is a build input
    whaleSeasonSyncAll(nowArg || Date.now());
    return { ok: true, fund: w };
  }
  function whaleMute(keyRaw, on) {
    const w = whaleByKey(keyRaw);
    if (!w) return { ok: false, error: "not watching \u201c" + String(keyRaw || "") + "\u201d" };
    w.notify = on ? 0 : 1;   // on === "mute this" (the op's name); notify is the stored inverse
    whaleBump(); whalePersist();
    return { ok: true, fund: w };
  }
  function whaleSeen(keyRaw) {
    const w = whaleByKey(keyRaw);
    if (!w) return { ok: false, error: "unknown fund" };
    if (whaleState.unseen[w.cik]) { delete whaleState.unseen[w.cik]; whaleBump(); whalePersist(); }
    return { ok: true };
  }
  // Ingest one filing: submissions row -> filing index -> infotable XML -> parsed book -> store.
  // Returns { ok, q, ... } or { ok:false, error }. Never throws to the caller.
  async function whaleIngest(w, acc, form, filedAt, period) {
    const cik = +w.cik, accNo = String(acc).replace(/-/g, "");
    const idx = await extGet("https://www.sec.gov/Archives/edgar/data/" + cik + "/" + accNo + "/index.json", "json");
    if (!idx.ok) return { ok: false, error: "filing index: " + idx.error };
    const items = idx.body && idx.body.directory && Array.isArray(idx.body.directory.item) ? idx.body.directory.item : [];
    // The infotable document's NAME varies wildly per filer; the primary_doc.xml is the cover page.
    // Pick the largest non-primary .xml — the infotable dwarfs everything else in a 13F folder.
    const xmls = items.filter((it) => /\.xml$/i.test(String(it.name || "")) && !/^primary_doc\.xml$/i.test(String(it.name || "")))
      .sort((a, b) => (+b.size || 0) - (+a.size || 0));
    if (!xmls.length) return { ok: false, error: "no infotable XML in the filing folder" };
    const x = await extGet("https://www.sec.gov/Archives/edgar/data/" + cik + "/" + accNo + "/" + xmls[0].name, "xml");
    if (!x.ok) return { ok: false, error: "infotable fetch: " + x.error };
    const parsed = parse13FInfotable(x.body);
    if (!parsed) return { ok: false, error: "infotable parsed to zero holdings" };
    // Thousands-convention correction (build -04): rule + floor live in compute.whale13FScale;
    // applied to the RAW rows so aggregation, deltas and the season all see one currency. The
    // flag rides the stored filing and every card discloses it.
    const scale = whale13FScale(parsed.rows);
    if (scale.mult > 1) for (const r0 of parsed.rows) if (r0.value != null) r0.value *= scale.mult;
    const book = whaleBook(parsed);
    if (!book) return { ok: false, error: "book aggregation produced nothing" };
    let truncated = 0;
    if (book.positions.length > WHALE_POS_CAP) { truncated = book.positions.length - WHALE_POS_CAP; book.positions = book.positions.slice(0, WHALE_POS_CAP); }
    const q = whaleQOfPeriod(period) || whaleQOfPeriod(filedAt) || "?";
    const f = whaleState.filings[cik] || (whaleState.filings[cik] = {});
    const had = f[q];
    f[q] = { acc: String(acc), form: String(form), filedAt, period: period || null, book,
      url: "https://www.sec.gov/Archives/edgar/data/" + cik + "/" + accNo + "/",
      amended: had && had.acc !== String(acc) ? 1 : (had && had.amended) || 0,
      truncated: truncated || undefined,
      scaled: scale.mult > 1 ? 1 : 0, scaleChecked: 1 };
    whaleBump(); whalePersist();
    return { ok: true, q, amended: !!(had && had.acc !== String(acc)), book };
  }
  // Find the two most recent DISTINCT-period 13F rows in a submissions JSON. The newest accession
  // per period wins (that is exactly what an HR/A is); returns newest-period-first.
  function whalePickFilings(sub) {
    const rec = sub && sub.filings && sub.filings.recent;
    if (!rec || !Array.isArray(rec.form)) return [];
    const byPeriod = new Map();   // period -> { acc, form, filedAt, period }
    for (let i = 0; i < rec.form.length; i++) {
      const fm = String(rec.form[i] || "");
      if (!/^13F-HR(\/A)?$/.test(fm)) continue;
      const period = String(rec.reportDate && rec.reportDate[i] || "");
      const filedAt = Date.parse(String(rec.filingDate && rec.filingDate[i] || "")) || 0;
      const row = { acc: String(rec.accessionNumber[i]), form: fm, filedAt, period };
      const had = byPeriod.get(period);
      if (!had || row.filedAt >= had.filedAt) byPeriod.set(period, row);
    }
    return [...byPeriod.values()].sort((a, b) => String(b.period).localeCompare(String(a.period))).slice(0, 2);
  }
  // One fund's poll: submissions -> newest filing row -> ingest if the accession is new to us.
  // Also backfills the prior quarter once, so the delta strip has its other leg.
  // Returns a status object (build -03) so the on-demand pull can surface what happened; the
  // scheduled tick ignores it. { ok, ingested?, q?, error? } — every early exit names its reason.
  async function whalePollFund(w, now) {
    const sub = await extGet("https://data.sec.gov/submissions/CIK" + cikPad(+w.cik) + ".json", "json");
    if (!sub.ok) return { ok: false, error: "EDGAR submissions: " + sub.error };
    const rows2 = whalePickFilings(sub.body);
    if (!rows2.length) return { ok: false, error: "no 13F-HR on record for this filer at EDGAR \u2014 it may not be a 13F filer, or it files under a different CIK" };
    const cur = rows2[0];
    const q = whaleQOfPeriod(cur.period);
    const have = whaleState.filings[w.cik] && whaleState.filings[w.cik][q];
    // Snapshot BEFORE ingest: did this fund already have ANY book on file? The announce gate below
    // keys on it (build -03): a fund's FIRST ingest is a backfill — the operator just added it, or
    // just hit "find latest filing" — and is history by definition, silent regardless of how fresh
    // the filing is. Only a NEW accession landing on a fund that already had a book is the thing
    // the alert class exists for: they filed while you were watching. This is clock-free, so the
    // deadline-week failure mode (add a fund the day after the deadline, blast every Telegram
    // subscriber with a "new" filing they conceptually just missed) cannot exist.
    const hadAny = !!(whaleState.filings[w.cik] && Object.keys(whaleState.filings[w.cik]).length);
    if (!have || have.acc !== cur.acc) {
      const r = await whaleIngest(w, cur.acc, cur.form, cur.filedAt, cur.period);
      if (r.ok) {
        // Announce gate, all three legs: primed (boot backlog seeds silently) AND fresh (7d — a
        // filing found late is history, the filingScan rule at quarterly width) AND hadAny (first
        // ingest is backfill, see above).
        if (!whalePrimed || !hadAny || !(cur.filedAt > 0) || now - cur.filedAt > 7 * DAY) { /* seeded */ }
        else {
          whaleState.unseen[w.cik] = cur.acc;
          const total = r.book.total, dd = whaleDelta(r.book, whalePrevBook(w.cik, q));
          const brief = r.q + " book " + whaleMoney(total) + " \u00b7 " + r.book.n + " positions" +
            (dd.hasPrev ? " \u00b7 " + dd.lanes.opened.length + " new \u00b7 " + dd.lanes.exited.length + " exit" : "");
          if (w.notify) emitTrig("filing", { whale: 1, fund: w.key, t: w.key, coin: null,
            form: cur.form, h: w.name + " \u2014 " + brief, url: whaleState.filings[w.cik][r.q].url, pub: cur.filedAt || now }, now);
          // Tape row on the NEWS filings lane — watched funds only; the deadline-day firehose
          // stays out by construction because only the watchlist is ever polled.
          newsItems = mergeNews(newsItems, [{ id: "whale:" + cur.acc, tk: w.key, wh: 1, fl: 1, mat: 1,
            form: cur.form, h: w.name + " \u00b7 " + brief + " \u2192 FUNDS", src: "EDGAR",
            url: whaleState.filings[w.cik][r.q].url, pub: cur.filedAt || now }], now);
          buildNewsPayload();
          persistTriggers();
          log(`whale: ${w.key} filed ${cur.form} for ${r.q}${r.amended ? " (amendment supersedes)" : ""}`);
        }
        // NB: no season build here. The prior-quarter backfill below hasn't run yet, so a build at
        // this instant would see prev=null, class nothing, and (until the sig fix that accompanied
        // this comment) freeze that empty read behind an unchanged signature. The ONE build site is
        // the end of whaleTick, after every ingest of the pass — including backfills.
      }
    }
    // Prior-quarter backfill (once): the delta's other leg. Never re-ingested after it exists.
    if (rows2[1]) {
      const pq = whaleQOfPeriod(rows2[1].period);
      const havePrev = whaleState.filings[w.cik] && whaleState.filings[w.cik][pq];
      if (!havePrev || havePrev.acc !== rows2[1].acc) await whaleIngest(w, rows2[1].acc, rows2[1].form, rows2[1].filedAt, rows2[1].period);
    }
    const got = whaleState.filings[w.cik] && whaleState.filings[w.cik][q];
    return got ? { ok: true, ingested: !have || have.acc !== cur.acc, q, total: got.book.total, n: got.book.n }
               : { ok: false, error: "filing found but ingest failed \u2014 see the server log" };
  }
  // On-demand pull (build -03): "find latest filing" — a fund row showing dashes shouldn't have
  // to wait out the poll cadence. Runs the SAME whalePollFund path (no special ingest logic to
  // drift), bypasses the cadence gate once, then STAMPS it so the scheduled tick doesn't re-fetch
  // right after. 60s per-fund cooldown: EDGAR is polite infrastructure and a button is a
  // double-click machine. Announce rules unchanged — an old filing pulled on demand ingests
  // silently (history, not news); season gets its build attempt like any other ingest pass.
  const WHALE_PULL_CD = 60 * 1000;
  const whalePullAt = new Map();   // cik -> last on-demand pull ts
  async function whalePull(keyRaw) {
    const w = whaleByKey(keyRaw);
    if (!w) return { ok: false, error: "not watching \u201c" + String(keyRaw || "") + "\u201d" };
    const now = Date.now();
    const last = whalePullAt.get(+w.cik) || 0;
    if (now - last < WHALE_PULL_CD) return { ok: false, error: "just pulled \u2014 EDGAR is checked at most once a minute per fund; try again shortly" };
    whalePullAt.set(+w.cik, now);
    whaleLastPoll.set(+w.cik, now);   // the scheduled tick treats this as the fund's poll
    let r;
    try { r = await whalePollFund(w, now); }
    catch (e) { return { ok: false, error: "pull failed: " + (e && e.message) }; }
    whaleSeasonMaybe(now);
    if (!r || !r.ok) return { ok: false, error: (r && r.error) || "pull produced nothing" };
    return { ok: true, key: w.key, q: r.q, total: r.total, n: r.n,
      ingested: !!r.ingested,   // false = EDGAR's latest was already on file — the dash means THEY haven't filed, not that we haven't looked
      note: r.ingested ? null : "already up to date \u2014 EDGAR's newest 13F for this filer was on file; the row is current" };
  }
  function whalePrevBook(cik, q) {
    const f = whaleState.filings[cik]; if (!f) return null;
    // Quarter labels sort wrong across years lexically ("Q4 2025" > "Q1 2026") — sort by the
    // period DATE instead, which every entry carries.
    const rows2 = Object.values(f).filter((x) => x && x.period).sort((a, b) => String(a.period).localeCompare(String(b.period)));
    const i = rows2.findIndex((x) => whaleQOfPeriod(x.period) === q);
    return i > 0 ? rows2[i - 1].book : null;
  }
  function whaleMoney(v) { if (v == null || !isFinite(v)) return "\u2014"; const a = Math.abs(v), s = v < 0 ? "-" : "";
    if (a >= 1e12) return s + "$" + (a / 1e12).toFixed(2) + "T"; if (a >= 1e9) return s + "$" + (a / 1e9).toFixed(1) + "B";
    if (a >= 1e6) return s + "$" + (a / 1e6).toFixed(1) + "M"; if (a >= 1e3) return s + "$" + (a / 1e3).toFixed(1) + "K"; return s + "$" + a.toFixed(0); }
  // Season build: fires when every watched fund has a book for the season quarter, or at
  // deadline+1d with whoever made it (missing filers disclosed in the build). An HR/A landing
  // after a build reruns it with an `amended` note — persisted per quarter, past seasons kept.
  // ---- season core (build 2026.08.19-03) ------------------------------------------------------
  // ONE writer for a quarter's season build, used by the window builder, roster edits, amendment
  // sync and the hydrate heal alike. The bug class this kills: header fields (filedN / watchN /
  // missing) frozen at build time while the watchlist lived on — a closed quarter never rebuilt
  // on roster edits, so the panel said "7/9 filed · missing: GREENLIGHT" over a 9-fund list that
  // contained no Greenlight and lanes that said /7. A season is a VIEW over stored filings for
  // the funds you watch NOW; the filings are the frozen history, the view recomputes. Metadata
  // and aggregate are written together, always — the frozen-geometry rule for derived builds.
  function whaleSeasonPrevAcc(cik, sq) {
    const f = whaleState.filings[cik]; if (!f) return "";
    const seq = Object.values(f).filter((x) => x && x.period).sort((a, b) => String(a.period).localeCompare(String(b.period)));
    const i = seq.findIndex((x) => whaleQOfPeriod(x.period) === sq);
    return i > 0 ? seq[i - 1].acc : "";
  }
  function whaleSeasonInputs(q) {
    const funds = whaleState.watch.map((w) => {
      const f = whaleState.filings[w.cik] && whaleState.filings[w.cik][q];
      return { key: w.key, name: w.name, cik: +w.cik, cur: f ? f.book : null, prev: whalePrevBook(w.cik, q), filedAt: f ? f.filedAt : null };
    });
    const filed = funds.filter((x) => x.cur);
    const accs = {};
    for (const x of filed) accs[+x.cik] = ((whaleState.filings[x.cik] && whaleState.filings[x.cik][q] || {}).acc || "") + ":" + whaleSeasonPrevAcc(x.cik, q);
    return { funds, filed, accs, rosterSig: filed.map((x) => +x.cik).sort((a, b) => a - b).join(",") };
  }
  function whaleSeasonBuildQ(q, now, meta) {
    const inp = whaleSeasonInputs(q);
    if (!inp.filed.length) {
      // Nobody on today's watchlist has a book for this quarter. The -18-02 doctrine holds here:
      // the stored season is KEPT, untouched — history is not destroyed to avoid a label; the
      // STALE chip and the getter's dropped-fund marking already narrate exactly what it is. The
      // desync bug this build kills is the UNLABELED kind (a live view quietly disagreeing with
      // the fund list); an all-dropped season is labeled history, which is a different thing.
      return { kept: true };
    }
    const had = whaleState.seasons[q];
    const agg = whaleSeason(inp.filed.map((x) => ({ key: x.key, cik: x.cik, cur: x.cur, prev: x.prev })));
    agg.roster = inp.filed.map((x) => ({ key: x.key, cik: +x.cik }));
    agg.aggV = 2;   // aggregate-math version: 2 = traded-dollar lanes; bump on any basis change so stored builds rebuild instead of wearing new labels over old numbers
    whaleState.seasons[q] = { q, at: now, accs: inp.accs, rosterSig: inp.rosterSig, agg,
      filedN: inp.filed.length, watchN: whaleState.watch.length,
      missing: inp.funds.filter((x) => !x.cur).map((x) => x.key),
      // Amendment means a FILING moved (meta.accMoved); everything else preserves the flag.
      amended: had ? (meta && meta.accMoved ? 1 : (had.amended || 0)) : 0,
      healed: meta && meta.heal ? 1 : (had && had.healed) || 0, healv: 2,
      closedAt: inp.filed.length === whaleState.watch.length ? Math.max(...inp.filed.map((x) => x.filedAt || 0)) : null };
    whaleBump(); whalePersist();
    return { built: true, filedN: inp.filed.length };
  }
  // Drift sync across EVERY stored quarter: rebuild wherever the stored build no longer matches
  // what the current watchlist + stored filings would produce — roster edits, late HR/As landing
  // on closed quarters, aggregate-math bumps, and the -18/-19 heal generations all reduce to this
  // one detector. Pure math over stored books; zero EDGAR traffic; idempotent (a rebuilt quarter
  // matches its own inputs on the next pass).
  function whaleSeasonSyncAll(now) {
    let n = 0;
    for (const q of Object.keys(whaleState.seasons)) {
      const sn = whaleState.seasons[q]; if (!sn) continue;
      const inp = whaleSeasonInputs(q);
      if (!inp.filed.length) continue;   // all-dropped: kept + chip-disclosed, never rebuilt into nothing (see whaleSeasonBuildQ)
      const shape = !sn.agg || !Array.isArray(sn.agg.roster) || !sn.agg.roster.length || sn.agg.aggV !== 2;
      const roster = sn.rosterSig !== inp.rosterSig || sn.watchN !== whaleState.watch.length;
      const accMoved = !!sn.accs && Object.keys(inp.accs).some((k) => k in sn.accs && sn.accs[k] !== inp.accs[k]);
      const accNew = !sn.accs || Object.keys(inp.accs).some((k) => !(k in sn.accs));
      if (!shape && !roster && !accMoved && !accNew) continue;
      const r = whaleSeasonBuildQ(q, now, { accMoved, heal: shape && !accMoved && !roster });
      if (r && (r.built || r.deleted)) n++;
    }
    if (n) log(`whale: season sync rebuilt ${n} stored quarter(s) — watchlist, filings and aggregates describe one state again`);
    return n;
  }
  function whaleSeasonMaybe(now) {
    if (!whaleState.watch.length) return;
    const win = whaleWindow(now);
    const q = win.cur.q;
    const funds = whaleState.watch.map((w) => {
      const f = whaleState.filings[w.cik] && whaleState.filings[w.cik][q];
      return { key: w.key, name: w.name, cik: w.cik, cur: f ? f.book : null, prev: whalePrevBook(w.cik, q), filedAt: f ? f.filedAt : null, amended: f ? !!f.amended : false };
    });
    const filed = funds.filter((x) => x.cur);
    if (!filed.length) return;
    const allIn = filed.length === whaleState.watch.length;
    const pastDeadline = now > win.cur.deadline + 864e5;
    if (!allIn && !pastDeadline) return;
    const had = whaleState.seasons[q];
    // The sig covers BOTH legs of every fund's delta: the season's own accessions AND the prior
    // quarter's. A late prior-quarter backfill or an HR/A on EITHER leg changes what the aggregate
    // would say, so either must reopen the build — a sig over current accessions alone froze the
    // first (prev-less) read forever, which the end-to-end test now pins.
    const prevAccOf = (cik, sq) => {
      const f = whaleState.filings[cik]; if (!f) return "";
      const rows3 = Object.values(f).filter((x) => x && x.period).sort((a, b) => String(a.period).localeCompare(String(b.period)));
      const i = rows3.findIndex((x) => whaleQOfPeriod(x.period) === sq);
      return i > 0 ? rows3[i - 1].acc : "";
    };
    // Two signatures, because the build has two independent inputs and they mean different things.
    // accSig is the FILING leg (both accessions per fund, keyed by CIK so it is order-free);
    // rosterSig is WHO WAS WATCHED. Either changing must reopen the build — a roster edit changes
    // what the aggregate would say just as surely as an amendment does — but only an accSig move
    // is an amendment, and conflating the two made every add/remove announce a filing that never
    // landed. The legacy single `sig` is absent on hydrated pre-2026.08.18-01 blobs, so the first
    // build after deploy rebuilds once and adopts the roster. That is the intended migration.
    const accs = {};
    for (const x of funds) accs[+x.cik] = ((whaleState.filings[x.cik] && whaleState.filings[x.cik][q] || {}).acc || "") + ":" + prevAccOf(x.cik, q);
    const rosterSig = funds.map((x) => +x.cik).sort((a, b) => a - b).join(",");
    // The accession comparison runs over the INTERSECTION of the two rosters, not over a flat
    // string. A joined signature moves whenever the roster does — it cannot help but — so testing
    // it for "did a filing change?" answers yes on every add and remove, and the amendment flag
    // becomes a lie about EDGAR. Asking only whether a fund present in BOTH builds changed its
    // accessions separates the two questions properly.
    const legacy = had && !had.accs;   // pre-2026.08.18-01 blob: rebuild once to adopt the roster
    const accMoved = !!(had && had.accs) && Object.keys(accs).some((k) => k in had.accs && had.accs[k] !== accs[k]);
    const rosterMoved = !had || had.rosterSig !== rosterSig;
    const shapeStale = !!(had && (!had.agg || !Array.isArray(had.agg.roster) || !had.agg.roster.length || had.agg.aggV !== 2));
    if (had && !legacy && !accMoved && !rosterMoved && !shapeStale) return;   // nothing new since the last build
    // The write lives in whaleSeasonBuildQ — ONE writer for every path (window build, roster
    // edit, amendment sync, hydrate heal), so metadata and aggregate can never desync again.
    whaleSeasonBuildQ(q, now, { accMoved });
    if (whalePrimed) pushOps("13F season " + q, (allIn ? "all " + filed.length : filed.length + "/" + whaleState.watch.length) +
      " watched funds filed \u2014 season summary " + (had ? "rebuilt (amendment)" : "built"), "info", true);
    log(`whale: season ${q} ${had ? "rebuilt" : "built"} (${filed.length}/${whaleState.watch.length} funds)`);
  }
  async function whaleTick(nowArg) {
    if (whalePolling) return;
    whalePolling = true;
    const now = nowArg || Date.now();
    try {
      const win = whaleWindow(now);
      // Fast cadence runs through the WHOLE filing season: the open window AND the 3-day grace
      // after the deadline (state "closed" — whaleWindow only reports "closed" inside grace;
      // past it the season rolls forward and reads "upcoming"). Build -05 fix: the gate used to
      // key on state === "open" alone, which dropped polling to 24h at the exact moment the
      // deadline passed — while the grace window exists precisely BECAUSE filings land late
      // (deadline-evening filers, weekend straddles, quick HR/A amendments). A deadline-day
      // filing could sit undetected for a day, through the weekend everyone reads 13Fs. Slow
      // cadence now belongs only to "upcoming" — the stretch where the season quarter hasn't
      // even ended and nothing but a stray amendment can appear.
      const gap = win.state === "upcoming" ? WHALE_OFF_WINDOW_MS : WHALE_IN_WINDOW_MS;
      for (const w of whaleState.watch) {
        const last = whaleLastPoll.get(+w.cik) || 0;
        if (now - last < gap) continue;
        whaleLastPoll.set(+w.cik, now);
        try { await whalePollFund(w, now); }
        catch (e) { log("whale poll " + w.key + " failed (isolated): " + (e && e.message)); }
      }
      whaleSeasonMaybe(now);
      whaleSeasonSyncAll(now);   // a late HR/A ingested for a CLOSED quarter must rebuild that quarter — the window builder never looks back
    } finally {
      whalePolling = false;
      whalePrimed = true;   // whatever the first pass found is now seeded; everything after announces
    }
  }
  // ---- payload getters (routes read these; client renders them verbatim) ----------------------
  // `nowArg`: same suite-only contract as the roster edits. This getter reports the FILING
  // CALENDAR, which moves on its own whether or not the data does, so a test that freezes time
  // must be able to freeze it here too. Reading Date.now() unconditionally is what let the
  // end-to-end test pass for months and then go red on 2026-08-18 — the morning Q2's grace window
  // closed — with no code change behind it. Routes omit the argument and get the real clock.
  function getWhale(nowArg) {
    const now = nowArg || Date.now();
    const win = whaleWindow(now);
    const watch = whaleState.watch.map((w) => {
      const f = whaleState.filings[w.cik] || {};
      const rows2 = Object.values(f).filter((x) => x && x.period).sort((a, b) => String(b.period).localeCompare(String(a.period)));
      const cur = rows2[0] || null;
      const prev = rows2[1] || null;
      const top = cur && cur.book.positions[0] || null;
      return { key: w.key, name: w.name, cik: w.cik, notify: w.notify ? 1 : 0,
        q: cur ? whaleQOfPeriod(cur.period) : null, form: cur ? cur.form : null,
        filedAt: cur ? cur.filedAt : null, amended: cur ? !!cur.amended : false,
        total: cur ? cur.book.total : null, n: cur ? cur.book.n : null, scaled: cur ? (cur.scaled ? 1 : 0) : 0,
        dPct: cur && prev && prev.book.total > 0 ? (cur.book.total / prev.book.total - 1) * 100 : null,
        top: top ? { name: top.name, pct: top.pct } : null,
        unseen: whaleState.unseen[w.cik] ? 1 : 0 };
    });
    const seasons = Object.keys(whaleState.seasons).sort((a, b) => {
      const pa = whaleState.seasons[a], pb = whaleState.seasons[b];
      return (pb.at || 0) - (pa.at || 0);
    });
    return { ts: now, dataTs: whaleVer, window: win, watch,
      unseenAny: watch.some((x) => x.unseen) ? 1 : 0,
      seasonQ: seasons.length ? seasons[0] : null, seasonList: seasons };
  }
  async function getWhaleFund(keyRaw, full) {
    const w = whaleByKey(keyRaw);
    if (!w) return { ok: false, error: "not watching \u201c" + String(keyRaw || "") + "\u201d \u2014 say whale for the list" };
    const f = whaleState.filings[w.cik] || {};
    const rows2 = Object.values(f).filter((x) => x && x.period).sort((a, b) => String(b.period).localeCompare(String(a.period)));
    const cur = rows2[0];
    if (!cur) return { ok: false, error: w.key + " has no ingested 13F yet \u2014 first poll lands within the half hour" };
    const q = whaleQOfPeriod(cur.period);
    const prev = whalePrevBook(w.cik, q);
    const dd = whaleDelta(cur.book, prev);
    const tmap = await whaleTickerMap().catch(() => null);
    const lim = full ? cur.book.positions.length : WHALE_TOP_N;
    const positions = dd.rows.slice(0, lim).map((p) => ({ name: p.name, cusip: p.cusip, put: p.put, cls: p.cls,
      value: p.value, shares: p.shares, pct: p.pct, d: p.d, tk: whaleTickerOf(p.name, tmap) }));
    const lane = (l) => l.slice(0, 8).map((p) => ({ name: p.name, put: p.put, dVal: p.dVal != null ? p.dVal : (p.prevVal != null ? -p.prevVal : null),
      dSh: p.dSh != null ? p.dSh : null, prevVal: p.prevVal, tk: whaleTickerOf(p.name, tmap) }));
    return { ok: true, key: w.key, name: w.name, cik: w.cik, q, form: cur.form, filedAt: cur.filedAt,
      period: cur.period, ageDays: cur.filedAt ? Math.round((Date.now() - cur.filedAt) / 864e5) : null,
      amended: !!cur.amended, truncated: cur.truncated || 0, url: cur.url, scaled: cur.scaled ? 1 : 0,
      total: cur.book.total, n: cur.book.n, nRaw: cur.book.nRaw,
      prevTotal: prev ? prev.total : null, hasPrev: dd.hasPrev,
      lanes: { opened: lane(dd.lanes.opened), added: lane(dd.lanes.added), trimmed: lane(dd.lanes.trimmed), exited: lane(dd.lanes.exited) },
      flows: dd.flows, positions, shown: positions.length };
  }
  // "Who holds" reverse lookup. Given a ticker, a name fragment or a CUSIP, scan every tracked
  // fund's latest cached book (plus its prior quarter, for exits) and answer who holds it, how
  // big, at what conviction, and what they did with it QoQ. Cached state only — a query costs
  // zero EDGAR traffic. One-code-path integrity: the QoQ chips come from the SAME whaleDelta the
  // fund modal renders, so this panel can never disagree with the book view.
  //
  // Match lanes, in order, basis always disclosed: (1) exact ticker via the SEC company map
  // (SYM -> official name -> whaleNameKey), (2) normalized-name equality on the query itself,
  // (3) filed-name substring (>= 3 chars — shorter fragments only match as tickers), (4) exact
  // 9-char CUSIP. Common and option lines stay separate per fund, never merged.
  //
  // -07: matched rows are GROUPED BY ISSUER (whaleIssuerKey, i.e. the CUSIP's 6-char issuer
  // prefix) before anything is summarized. -06 kept one basis, one display name and one combined
  // total for the whole result set, which produced a specific, reproducible lie: "amd" matches
  // ADVANCED MICRO DEVICES by ticker and AMDOCS LTD by substring, so `basis` (a single variable
  // taking the max lane rank across every matched row) stamped 'matched by ticker "AMD"' onto the
  // Amdocs lines, `dispName` (shortest matched name) titled the whole panel AMDOCS, and
  // `combined` added two unrelated companies together. Each issuer now carries its OWN basis,
  // name, ticker chip, funds, totals and not-held list; issuers rank by lane strength then size,
  // and the client renders the strongest in full with the rest collapsed. A weak match is
  // disclosed, never merged and never silently dropped.
  //
  // Top-level fields mirror issuers[0] so existing callers (the terminal verb, the route) keep
  // reading the primary result without a shape migration.
  const HOLDS_BASIS_RANK = { cusip: 4, ticker: 3, name: 2, substring: 1 };
  const holdsBasisLabel = (b, tk) => b === "ticker" ? 'ticker "' + tk + '" \u2192 filed name'
    : b === "cusip" ? "exact CUSIP" : b === "name" ? "normalized name" : "filed-name substring";
  // A fund's direction on one issuer, over its COMMON lines only. -06 asked two independent
  // `.some()` questions — "any common line added?" and "any common line trimmed?" — and a fund
  // holding two common lots that moved opposite ways answered yes to both, incrementing adding
  // AND cutting. The strip then printed counts that summed past the holder count (the shipped
  // "4/7 hold - 3 adding - 2 cutting"), and the row chip, which read only lines[0], showed one of
  // the two directions as if it were the fund's whole answer. One fund, one direction: legs are
  // netted, and when they genuinely disagree the row says so rather than being counted twice.
  // Option lines never vote — a new puts line is a bearish or hedging expression, and counting it
  // as accumulation would print the opposite of what the filer did.
  function holdsDir(lines) {
    const com = lines.filter((l) => !l.put);
    if (!com.length) return { dir: "na", mixed: 0 };                 // options-only: not a directional holder
    const live = com.filter((l) => l.d && l.d.cls !== "na");
    if (!live.length) return { dir: "na", mixed: 0 };                // no prior filing — no delta claimed
    if (live.every((l) => l.d.cls === "new")) return { dir: "new", mixed: 0 };
    const up = live.filter((l) => l.d.cls === "add" || l.d.cls === "new").length;
    const dn = live.filter((l) => l.d.cls === "trim").length;
    const mixed = up > 0 && dn > 0 ? 1 : 0;
    if (!mixed) return { dir: up > 0 ? "add" : dn > 0 ? "trim" : "flat", mixed: 0 };
    // Legs disagree. dVal is present on every non-na cell (share counts are not — options and
    // PRN rows carry none), so the NET is priced in dollars and the disagreement is disclosed.
    const net = live.reduce((s, l) => s + (l.d.dVal || 0), 0);
    return { dir: net > 0 ? "add" : net < 0 ? "trim" : "flat", mixed: 1 };
  }

  // ---- market-wide 13F holder index — ingest + query (build 2026.08.21-05) --------------------
  // The TOP HOLDERS panel's engine: once a quarter, download the SEC's Form 13F structured data
  // set (one ZIP: INFOTABLE.tsv ~7-8M rows = every position of every filer, SUBMISSION.tsv,
  // COVERPAGE.tsv), stream it into store's whale13f.db, and answer "top N institutional holders
  // of this cusip" from an index hit forever after. Rules carried over from the watchlist lane,
  // stated once: per-filer thousands-convention correction (the SAME compute.whale13FScale rule,
  // sampled per accession), option lines never enter the ranks, HR/A supersedes HR for the same
  // (cik, period), rows filed for a DIFFERENT period than the target quarter are excluded (a
  // data set is a quarter of FILINGS and late prior-period filings ride along in it).
  // Memory honesty: the compressed ZIP is buffered (~250-400MB RAM peak, disclosed); the
  // INFLATED tsv (~1.2GB) is never held — it streams through zlib into a line splitter, rows
  // batch into a staging table, and pass 2 is pure SQL. LOUD standing caveat: sec.gov is
  // unreachable from the build sandbox and this file layout has drifted historically — the
  // parser reads headers by NAME, tries two URL naming patterns, and fails with the exact
  // reason in ops; the first real ingest is the true verification.
  const T13F_TOP_CAP = t13fCapOpt || 500;        // option C: top-N per cusip stored; aggregates stay exact over ALL holders
  const T13F_TOP_SHOW = 20;                     // rows the TOP HOLDERS panel renders (the stored cap above is the deeper index the Δ QoQ leg reads)
  const T13F_URL = "https://www.sec.gov/files/structureddata/data/form-13f-data-sets/";
  let t13fBusy = false, t13fProgress = null;
  // What the SEC actually publishes. A 13F data set is NOT a calendar quarter — it is the window in
  // which filings were RECEIVED. A period ending 31 Mar is due 15 May, so those 13Fs arrive across
  // Mar-May and the file is 01mar2026-31may2026_form13f.zip (verified against sec.gov's listing).
  // The window opens on the first of the quarter-END month and runs three months. The old code sent
  // calendar quarters (01apr-30jun) and 404'd on every request ever made.
  const T13F_MON = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
  function t13fWindow(qi, y) {
    const sM = qi * 3 - 1, eM = (sM + 2) % 12, eY = sM + 2 > 11 ? y + 1 : y;
    const eD = new Date(Date.UTC(eY, eM + 1, 0)).getUTCDate();     // last day of the end month, leap-aware
    return { span: "01" + T13F_MON[sM] + y + "-" + eD + T13F_MON[eM] + eY,
      endMs: Date.UTC(eY, eM, eD, 23, 59, 59) };
  }
  // The newest quarter whose data set could EXIST: its filing window has closed, plus a few days for
  // sec.gov to post. Asking earlier can only 404 — which is what every attempt in the logs did, first
  // because the manual default was the quarter still in progress, then because Q2 2026's window does
  // not close until 31 Aug. On 2026-08-21 this correctly resolves to Q1 2026.
  const T13F_POST_GRACE = 3 * 24 * 3600 * 1000;
  function t13fSeasonQuarter(now) {
    const d = new Date(now);
    let y = d.getUTCFullYear(), qi = Math.floor(d.getUTCMonth() / 3) + 1;
    for (let i = 0; i < 8; i++) {
      if (now >= t13fWindow(qi, y).endMs + T13F_POST_GRACE) return "Q" + qi + " " + y;
      qi--; if (qi === 0) { qi = 4; y--; }
    }
    return "Q" + qi + " " + y;
  }
  function t13fPeriodOf(q) {   // "Q2 2026" -> "30-JUN-2026" comparisons are done on ISO; period end ISO:
    const m = String(q).match(/^Q([1-4]) (\d{4})$/); if (!m) return null;
    const ends = ["03-31", "06-30", "09-30", "12-31"];
    return m[2] + "-" + ends[+m[1] - 1];
  }
  function t13fZipUrls(q) {
    const m = String(q).match(/^Q([1-4]) (\d{4})$/); if (!m) return [];
    return [T13F_URL + t13fWindow(+m[1], +m[2]).span + "_form13f.zip"];
  }
  // Minimal ZIP reader: central directory walk + STORED/DEFLATE entries. No CRC verification (we
  // parse the payload immediately; a torn download fails the TSV parse with a named error), no
  // ZIP64 (the data sets are ~300MB; a ZIP64 file gets an honest "layout changed" error).
  function t13fZipEntries(buf) {
    let i = buf.length - 22;
    while (i >= 0 && buf.readUInt32LE(i) !== 0x06054b50) i--;
    if (i < 0) throw new Error("ZIP: end-of-central-directory not found");
    const n = buf.readUInt16LE(i + 10), cdOff = buf.readUInt32LE(i + 16);
    if (cdOff === 0xffffffff) throw new Error("ZIP64 layout — the data-set format changed, ingest needs a patch");
    const out = []; let p = cdOff;
    for (let k = 0; k < n; k++) {
      if (buf.readUInt32LE(p) !== 0x02014b50) throw new Error("ZIP: central directory corrupt at entry " + k);
      const method = buf.readUInt16LE(p + 10), csize = buf.readUInt32LE(p + 20), usize = buf.readUInt32LE(p + 24);
      const nlen = buf.readUInt16LE(p + 28), elen = buf.readUInt16LE(p + 30), clen = buf.readUInt16LE(p + 32);
      const lho = buf.readUInt32LE(p + 42);
      out.push({ name: buf.toString("utf8", p + 46, p + 46 + nlen), method, csize, usize, lho });
      p += 46 + nlen + elen + clen;
    }
    return out;
  }
  function t13fZipSlice(buf, e) {   // -> Buffer of the COMPRESSED payload (caller inflates or uses raw)
    if (buf.readUInt32LE(e.lho) !== 0x04034b50) throw new Error("ZIP: local header mismatch for " + e.name);
    const nlen = buf.readUInt16LE(e.lho + 26), elen = buf.readUInt16LE(e.lho + 28);
    const start = e.lho + 30 + nlen + elen;
    return buf.subarray(start, start + e.csize);
  }
  // Stream an entry's TSV through a line callback without ever holding the inflated whole.
  function t13fStreamLines(buf, e, onLine) {
    return new Promise((resolve, reject) => {
      const zlib = require("zlib");
      const raw = t13fZipSlice(buf, e);
      let tail = "";
      const feed = (chunk) => {
        const s = tail + chunk.toString("utf8");
        const lines = s.split("\n");
        tail = lines.pop();
        for (const ln of lines) onLine(ln.endsWith("\r") ? ln.slice(0, -1) : ln);
      };
      if (e.method === 0) { try { feed(raw); if (tail) onLine(tail); resolve(); } catch (er) { reject(er); } return; }
      if (e.method !== 8) { reject(new Error("ZIP: unsupported compression method " + e.method + " on " + e.name)); return; }
      const inf = zlib.createInflateRaw();
      inf.on("data", (c) => { try { feed(c); } catch (er) { inf.destroy(); reject(er); } });
      inf.on("end", () => { try { if (tail) onLine(tail); resolve(); } catch (er) { reject(er); } });
      inf.on("error", reject);
      inf.end(raw);
    });
  }
  const t13fCols = (header) => { const m = {}; header.split("\t").forEach((h, i) => { m[h.trim().toUpperCase()] = i; }); return m; };
  async function whale13fIngest(qArg) {
    if (t13fBusy) return { ok: false, error: "an ingest is already running" };
    if (!store.t13fReady || !store.t13fReady()) return { ok: false, error: "sqlite unavailable in this runtime" };
    const q = String(qArg || t13fSeasonQuarter(Date.now()));
    const period = t13fPeriodOf(q);
    if (!period) return { ok: false, error: "bad quarter \u201c" + q + "\u201d \u2014 expected like Q2 2026" };
    t13fBusy = true; t13fProgress = { q, stage: "download", rows: 0 };
    const done = (r) => { t13fBusy = false; t13fProgress = null; return r; };
    // Every exit says why, in the ops log. Only the thrown-error path used to, so a 404 or a layout
    // change looked exactly like a process that died mid-download — the single most misleading thing
    // this ingest could do to whoever is watching Railway.
    const fail = (r) => { pushOps("13F data set " + q, (r.notYet ? "not ingested \u2014 " : "ingest FAILED: ") + r.error,
      r.notYet ? "info" : "warn", true); return done(r); };
    try {
      pushOps("13F data set " + q, "downloading (~300MB \u2014 can take a few minutes on first try)", "info", true);
      let zipBuf = null, urlUsed = null; const tried = [];
      const tmpZip = require("path").join(require("os").tmpdir(), "t13f-" + q.replace(/\s+/g, "") + ".zip");
      for (const url of t13fZipUrls(q)) {
        try {
          const res = await extFetch(url, { headers: { "user-agent": SEC_UA } });
          if (!res || !res.ok) { tried.push(url + " \u2192 HTTP " + (res ? res.status : "no response")); continue; }
          // Stream to disk, then read back ONCE. The previous Buffer.from(await res.arrayBuffer())
          // held the zip TWICE transiently (~700MB peak) — enough to OOM-kill a memory-tight
          // container mid-ingest, which presents as "ran the command, ops went quiet, no panel".
          // One buffer is still required for random access to the zip's central directory; one is
          // the floor, and now it is also the ceiling.
          if (res.body && typeof res.body.getReader === "function") {
            const fsm = require("fs");
            const w = fsm.createWriteStream(tmpZip);
            const reader = res.body.getReader();
            for (;;) { const { done: d2, value } = await reader.read(); if (d2) break; w.write(Buffer.from(value)); }
            await new Promise((res2, rej2) => { w.end(); w.on("finish", res2); w.on("error", rej2); });
            zipBuf = fsm.readFileSync(tmpZip);
            try { fsm.unlinkSync(tmpZip); } catch (_) {}
          } else {
            zipBuf = Buffer.from(await res.arrayBuffer());   // injected test transports have no stream body
          }
          urlUsed = url; break;
        } catch (e) { tried.push(url + " \u2192 " + String(e && e.message).slice(0, 60));
          try { require("fs").unlinkSync(tmpZip); } catch (_) {} }
      }
      if (!zipBuf) return fail({ ok: false, notYet: 1, tried,
        error: q + " not downloaded (" + tried.join("; ") + ") \u2014 404 means sec.gov has not posted this filing window yet (it closes at the end of the third month and the weekly check keeps trying); any other status means the URL or the access rule changed" });
      pushOps("13F data set " + q, "downloaded " + (zipBuf.length / 1e6).toFixed(0) + "MB from " + urlUsed.split("/").pop() + " \u2014 ingesting", "info", true);
      const entries = t13fZipEntries(zipBuf);
      const find = (nm) => entries.find((e) => e.name.toUpperCase().endsWith(nm));
      const eInfo = find("INFOTABLE.TSV"), eSub = find("SUBMISSION.TSV"), eCov = find("COVERPAGE.TSV");
      if (!eInfo || !eSub) return fail({ ok: false, error: "data-set layout changed: " + (!eInfo ? "INFOTABLE.tsv" : "SUBMISSION.tsv") + " missing from the zip \u2014 ingest needs a patch" });
      // SUBMISSION: acc -> {cik, period, type}; choose newest accession per (cik, period), HR/A first.
      t13fProgress.stage = "submissions";
      const subs = new Map(); let subCols = null;
      await t13fStreamLines(zipBuf, eSub, (ln) => {
        if (!subCols) { subCols = t13fCols(ln); return; }
        const c = ln.split("\t");
        const acc = c[subCols.ACCESSION_NUMBER], cik = +c[subCols.CIK];
        const per = String(c[subCols.PERIODOFREPORT] || "");
        const typ = String(c[subCols.SUBMISSIONTYPE] || "");
        if (!acc || !Number.isFinite(cik)) return;
        // Period normalization: sets have shipped both ISO and DD-MON-YYYY; accept both.
        const iso = /^\d{4}-\d{2}-\d{2}$/.test(per) ? per
          : (() => { const m = per.match(/^(\d{2})-([A-Z]{3})-(\d{4})$/i); if (!m) return per;
              const mo = { JAN: "01", FEB: "02", MAR: "03", APR: "04", MAY: "05", JUN: "06", JUL: "07", AUG: "08", SEP: "09", OCT: "10", NOV: "11", DEC: "12" }[m[2].toUpperCase()];
              return mo ? m[3] + "-" + mo + "-" + m[1] : per; })();
        subs.set(acc, { cik, period: iso, typ });
      });
      const chosen = new Map();   // "cik|period" -> acc  (newest wins; /A beats not-/A at equal recency)
      for (const [acc, s] of subs) {
        if (s.period !== period) continue;   // a late prior-period filing riding in this set — not this quarter's book
        const k = s.cik + "|" + s.period, had = chosen.get(k);
        if (!had) { chosen.set(k, acc); continue; }
        const hadA = /\/A$/.test((subs.get(had) || {}).typ || ""), isA = /\/A$/.test(s.typ);
        if ((isA && !hadA) || (isA === hadA && acc > had)) chosen.set(k, acc);
      }
      const chosenAccs = new Map(); for (const [k, acc] of chosen) chosenAccs.set(acc, +k.split("|")[0]);
      // COVERPAGE: cik -> manager name (via chosen accession).
      const names = new Map();
      if (eCov) { let cc = null;
        await t13fStreamLines(zipBuf, eCov, (ln) => {
          if (!cc) { cc = t13fCols(ln); return; }
          const c = ln.split("\t"); const acc = c[cc.ACCESSION_NUMBER];
          const cik = chosenAccs.get(acc);
          if (cik != null && cc.FILINGMANAGER_NAME != null) names.set(cik, c[cc.FILINGMANAGER_NAME]);
        }); }
      // INFOTABLE pass 1: stage rows for chosen accessions; reservoir of implied-price ratios per
      // accession feeds the SAME thousands-rule the watchlist uses (compute.whale13FScale).
      t13fProgress.stage = "infotable";
      if (!store.t13fIngestStart()) return fail({ ok: false, error: "staging init failed" });
      const RES_N = 48;
      const reservoirs = new Map();   // acc -> [{value, shares}] capped
      let batch = [], total = 0, ic = null;
      const flush = () => { if (batch.length) { store.t13fStageRows(batch); batch = []; } };
      await t13fStreamLines(zipBuf, eInfo, (ln) => {
        if (!ic) { ic = t13fCols(ln); return; }
        const c = ln.split("\t");
        const acc = c[ic.ACCESSION_NUMBER];
        if (!chosenAccs.has(acc)) return;
        const cusip = String(c[ic.CUSIP] || "").replace(/\s+/g, "").toUpperCase();
        const value = +c[ic.VALUE], shares = +c[ic.SSHPRNAMT];
        if (cusip.length !== 9 || !Number.isFinite(value)) return;
        const sh = String(c[ic.SSHPRNAMTTYPE] || "").trim().toUpperCase() === "SH" ? 1 : 0;
        const put = String(ic.PUTCALL != null ? c[ic.PUTCALL] || "" : "").trim() ? 1 : 0;
        batch.push({ acc, cusip, value, shares: Number.isFinite(shares) ? shares : null, sh, put });
        if (sh && !put && value > 0 && shares > 0) {
          let rv = reservoirs.get(acc); if (!rv) { rv = []; reservoirs.set(acc, rv); }
          if (rv.length < RES_N) rv.push({ value, shares });
        }
        total++; t13fProgress.rows = total;
        if (batch.length >= 4000) flush();
      });
      flush();
      if (!total) return fail({ ok: false, error: "INFOTABLE parsed to zero rows for " + q + " \u2014 header names may have changed; ingest needs a patch" });
      const mults = new Map();
      for (const acc of chosenAccs.keys()) {
        const det = whale13FScale(reservoirs.get(acc) || []);
        mults.set(acc, det.mult);
      }
      t13fProgress.stage = "finalize";
      store.t13fStageMeta(mults, names, chosenAccs);
      const fin = store.t13fFinalize(q, T13F_TOP_CAP);
      if (!fin.ok) return fail({ ok: false, error: "finalize: " + fin.error });
      store.t13fMetaSet("ingested:" + q, String(Date.now()));
      store.t13fMetaSet("cap", String(T13F_TOP_CAP));
      whaleBump();
      const scaled = [...mults.values()].filter((m) => m > 1).length;
      pushOps("13F data set " + q, "ingested: " + chosenAccs.size + " filers, " + total + " rows, top-" + T13F_TOP_CAP +
        " per cusip stored" + (scaled ? ", " + scaled + " thousands-convention filer(s) corrected \u00d71000" : ""), "info", true);
      log(`whale13f: ${q} ingested \u2014 ${chosenAccs.size} filers / ${total} rows / cap ${T13F_TOP_CAP}${scaled ? ` / ${scaled} scaled` : ""}`);
      return done({ ok: true, q, filers: chosenAccs.size, rows: total, scaled });
    } catch (e) {
      pushOps("13F data set " + q, "ingest FAILED: " + String(e && e.message).slice(0, 140), "warn", true);
      return done({ ok: false, error: String(e && e.message).slice(0, 200) });
    }
  }
  // Weekly check: from deadline+4d until the set lands, then quiet until next season. The season
  // quarter is the last CLOSED one — during "upcoming" that is windowInfo.cur only after roll,
  // so derive from the deadline that most recently passed.
  let t13fLastCheck = 0;
  async function whale13fTick(nowArg) {
    const now = nowArg || Date.now();
    if (now - t13fLastCheck < 12 * HOUR) return;
    t13fLastCheck = now;
    if (!store.t13fReady || !store.t13fReady()) return;
    const win = whaleWindow(now);
    const q = t13fSeasonQuarter(now);
    if (store.t13fMeta("ingested:" + q)) return;
    if (!t13fPeriodOf(q)) return;   // t13fSeasonQuarter only names a quarter whose window has closed
    await whale13fIngest(q).catch(() => {});
  }
  function t13fStatus() {
    const qs = store.t13fQuarters ? store.t13fQuarters() : [];
    return { ready: !!(store.t13fReady && store.t13fReady()), quarters: qs,
      busy: t13fBusy, progress: t13fProgress, cap: +(store.t13fMeta && store.t13fMeta("cap")) || T13F_TOP_CAP };
  }

  // ---- CONGRESS lane, phase 1: House filing INDEX ingest (build 2026.08.24-02) ---------------
  // Deliberately the smallest slice of the congressional-disclosure feature that can be WRONG in
  // production: download the House Clerk's annual financial-disclosure ZIP, parse the filing index
  // inside it, write one row per filing. Nothing is read out of the PTR documents themselves —
  // that is phase 2 — and there is no public surface: an admin verb plus the ops log is the whole
  // interface while this soaks (the LIQUIDITY board shipped the same way).
  //
  // Why ship a lane with no UI: the fetch layer is the ONLY part that cannot be tested here.
  // disclosures-clerk.house.gov is unreachable from the build sandbox — the egress proxy answers
  // 403 to CONNECT, exactly as it does for sec.gov — so the parser gets fixtures and the network
  // gets a production round-trip. The 13F lane learned this the expensive way: it shipped, then
  // spent four consecutive commits on URL and window reality, the last one titled "use the SEC's
  // real filing-window URL". So this lane asks for MORE THAN ONE candidate up front, logs every
  // full URL it tried on failure, and reports what the ZIP actually contained on success.
  //
  // VERIFIED IN PRODUCTION 2026-08-25 — the first real ingest, which is the whole reason phase 1
  // shipped on its own. What the network actually does, replacing the pre-flight guesses:
  //   - the FIRST candidate answers: /public_disc/financial-pdfs/2026FD.zip
  //   - the ZIP carries ONLY the index: 0.1MB, 2 entries (2026FD.xml plus a .txt twin), no PDFs.
  //     That settles the open sizing question — the daily tick is trivially cheap, ~60ms end to
  //     end. The stream-to-disk path below is therefore unnecessary at this size; it stays because
  //     it costs nothing and the file grows across a year.
  //   - the 2026 index holds 1,573 filings, 364 of them PTRs.
  //   - a second run a minute later wrote 0 new rows: the upsert is idempotent against the REAL
  //     feed, not merely against the fixture.
  //   - filing-type codes W, D and H appear in the live index and are NOT in HOUSE_TYPE below.
  //     They ride as "other" with the raw code stored, which is exactly what that design is for.
  //     Do NOT guess at them: the Clerk publishes no code table (searched), and the only honest
  //     way to identify one is to open a filing that carries it — GET /api/congress?type=other —
  //     and read the document. Until then they are unidentified, not mislabelled.
  const HOUSE_DISC = "https://disclosures-clerk.house.gov/public_disc/";
  // Filing-type codes, mapped only where the meaning is certain. An unmapped code is NOT dropped
  // and NOT guessed: the row is kept, `type` reads "other", and the raw code rides in `typeRaw` so
  // a code that appears later can be identified from stored data instead of a re-crawl.
  // Observed live but deliberately absent: W, D, H (see the production note above).
  const HOUSE_TYPE = { P: "ptr", O: "annual", A: "amendment", C: "candidate", T: "termination", X: "extension" };
  let congressBusy = false, congressProgress = null, congressLastError = null;
  function houseIndexUrls(y) {
    const yr = String(y);
    return [
      HOUSE_DISC + "financial-pdfs/" + yr + "FD.zip",
      HOUSE_DISC + "financial-pdfs/" + yr + "/" + yr + "FD.zip",
      HOUSE_DISC + "financial-disclosure/" + yr + "FD.zip",
    ];
  }
  const housePtrUrl = (y, docId) => HOUSE_DISC + "ptr-pdfs/" + y + "/" + docId + ".pdf";
  // Whole-entry read, for the index. The 13F lane streams because its TSV inflates to ~1.2GB; an
  // index is a few MB and XML is not line-oriented, so this one materializes. Same ZIP primitives.
  function zipEntryText(buf, e) {
    const raw = t13fZipSlice(buf, e);
    if (e.method === 0) return raw.toString("utf8");
    if (e.method !== 8) throw new Error("ZIP: unsupported compression method " + e.method + " on " + e.name);
    return require("zlib").inflateRawSync(raw).toString("utf8");
  }
  // Date shapes seen or plausible in the index, normalized to ISO. A shape not listed here returns
  // "" rather than a guessed date — and the ingest COUNTS those and samples the raw text, because
  // production showed the symptom of a blank date (a dash where the earliest filing should be) with
  // no way to tell how many rows were affected or what the offending value even looked like.
  const MON3 = { JAN: "01", FEB: "02", MAR: "03", APR: "04", MAY: "05", JUN: "06",
    JUL: "07", AUG: "08", SEP: "09", OCT: "10", NOV: "11", DEC: "12" };
  const houseDate = (v) => {
    const t = String(v || "").trim();
    if (!t) return "";
    if (/^\d{4}-\d{2}-\d{2}$/.test(t)) return t;                       // already ISO
    let m = t.match(/^(\d{4})[/.](\d{1,2})[/.](\d{1,2})$/);            // 2026/08/13
    if (m) return m[1] + "-" + m[2].padStart(2, "0") + "-" + m[3].padStart(2, "0");
    m = t.match(/^(\d{1,2})[/.-](\d{1,2})[/.-](\d{2}|\d{4})$/);       // 8/13/2026 · 8-13-26
    if (m) { const y = m[3].length === 2 ? (+m[3] > 70 ? "19" : "20") + m[3] : m[3];
      return y + "-" + m[1].padStart(2, "0") + "-" + m[2].padStart(2, "0"); }
    m = t.match(/^(\d{1,2})[-\s]([A-Za-z]{3})[A-Za-z]*[-\s](\d{4})$/); // 13-AUG-2026
    if (m && MON3[m[2].toUpperCase()]) return m[3] + "-" + MON3[m[2].toUpperCase()] + "-" + m[1].padStart(2, "0");
    m = t.match(/^([A-Za-z]{3})[A-Za-z]*\s+(\d{1,2}),?\s+(\d{4})$/);  // August 13, 2026
    if (m && MON3[m[1].toUpperCase()]) return m[3] + "-" + MON3[m[1].toUpperCase()] + "-" + m[2].padStart(2, "0");
    return "";
  };
  // Read fields by NAME, never by position — the rule the 13F parser already runs on, for the same
  // reason: an upstream column reorder must fail loudly or not at all, never shift data silently.
  function parseHouseIndex(text, yearHint) {
    const rows = [], seen = new Set(), badDates = [];
    const push = (f) => {
      const docId = String(f.DocID || "").trim();
      if (!docId) return;
      const id = "H:" + docId;
      if (seen.has(id)) return;                    // a doc id repeated in one index is one filing
      seen.add(id);
      const code = String(f.FilingType || "").trim().toUpperCase();
      const type = HOUSE_TYPE[code] || "other";
      const sd = String(f.StateDst || "").trim().toUpperCase();
      const last = String(f.Last || "").trim(), first = String(f.First || "").trim();
      const suffix = String(f.Suffix || "").trim();
      const yr = +String(f.Year || yearHint || "").trim() || (yearHint | 0);
      rows.push({ id, chamber: "H", docId, yr,
        member: (last + (first ? ", " + first : "") + (suffix ? " " + suffix : "")).trim(),
        lname: last, fname: first, suffix,
        state: sd.slice(0, 2), dist: sd.slice(2),
        type, typeRaw: code, filed: (() => {
          const iso = houseDate(f.FilingDate);
          // A filing whose date cannot be read is KEPT — dropping it would hide a filing — but the
          // raw value is sampled so the shape can be identified instead of theorized about.
          if (!iso && badDates.length < 5) badDates.push(String(f.FilingDate == null ? "(absent)" : f.FilingDate).slice(0, 40));
          return iso;
        })(),
        // Only a PTR gets a document URL. The ptr-pdfs path is corroborated by live documents
        // going back years; the path for every OTHER filing type is NOT verified from here, and a
        // link that 404s on the 1,209 non-PTR rows of a 1,573-row index is worse than no link.
        // Phase 2 resolves it if it ever has a reason to fetch one.
        url: type === "ptr" ? housePtrUrl(yr, docId) : null,
        // The index carries no supersede link — an amendment arrives as its own filing with type A.
        // Resolving which filing an A amends needs the documents themselves, so it waits for phase 2
        // rather than being guessed from name-and-date collisions here.
        amends: null,
        parsed: type === "ptr" ? 0 : null, nTx: null });
    };
    // Scan the INNER content of each member block, never the block text itself — a generic
    // <tag>…</tag> sweep run over the whole block matches the <Member> wrapper first and eats
    // every field inside it, which parses to a confident zero.
    const blocks = [...text.matchAll(/<Member>([\s\S]*?)<\/Member>/gi)];
    if (blocks.length) {
      for (const b of blocks) {
        const f = {};
        for (const m of b[1].matchAll(/<([A-Za-z_][\w.-]*)>([\s\S]*?)<\/\1>/g)) f[m[1]] = m[2];
        push(f);
      }
      return { rows, badDates };
    }
    // Fallback: the ZIP has also carried a tab-delimited index. Same by-name rule on the header.
    const lines = text.split(/\r?\n/).filter((l) => l.trim());
    if (lines.length > 1 && lines[0].includes("\t")) {
      const cols = lines[0].split("\t").map((h) => h.trim());
      for (let i = 1; i < lines.length; i++) {
        const c = lines[i].split("\t"), f = {};
        cols.forEach((h, j) => { f[h] = c[j]; });
        push(f);
      }
    }
    return { rows, badDates };
  }
  async function congressIngest(yearArg) {
    if (congressBusy) return { ok: false, error: "an ingest is already running" };
    if (!store.congressReady || !store.congressReady()) return { ok: false, error: "sqlite unavailable in this runtime" };
    const yr = +yearArg || new Date().getUTCFullYear();
    if (!(yr >= 2008 && yr <= new Date().getUTCFullYear() + 1)) return { ok: false, error: "bad year “" + yearArg + "” — the House index starts at 2008" };
    congressBusy = true; congressProgress = { yr, stage: "download" };
    const done = (r) => { congressBusy = false; congressProgress = null; return r; };
    // Every exit says why, in ops. The 13F lane's worst failure mode was a silent one that looked
    // identical to a process dying mid-download; not repeating it.
    const fail = (r) => { congressLastError = r.error;
      pushOps("congress index " + yr, "ingest FAILED: " + r.error, "warn", true); return done(r); };
    try {
      pushOps("congress index " + yr, "downloading the House Clerk filing index", "info", true);
      let zipBuf = null, urlUsed = null; const tried = [];
      const tmpZip = require("path").join(require("os").tmpdir(), "congress-" + yr + ".zip");
      for (const url of houseIndexUrls(yr)) {
        try {
          const res = await extFetch(url, { headers: { "user-agent": SEC_UA } });
          if (!res || !res.ok) { tried.push(url + " → HTTP " + (res ? res.status : "no response")); continue; }
          if (res.body && typeof res.body.getReader === "function") {
            const fsm = require("fs");
            const w = fsm.createWriteStream(tmpZip);
            const reader = res.body.getReader();
            for (;;) { const { done: d2, value } = await reader.read(); if (d2) break; w.write(Buffer.from(value)); }
            await new Promise((res2, rej2) => { w.end(); w.on("finish", res2); w.on("error", rej2); });
            zipBuf = fsm.readFileSync(tmpZip);
            try { fsm.unlinkSync(tmpZip); } catch (_) {}
          } else {
            zipBuf = Buffer.from(await res.arrayBuffer());   // injected test transports have no stream body
          }
          urlUsed = url; break;
        } catch (e) { tried.push(url + " → " + String(e && e.message).slice(0, 60));
          try { require("fs").unlinkSync(tmpZip); } catch (_) {} }
      }
      if (!zipBuf) return fail({ ok: false, tried,
        error: yr + " index not downloaded (" + tried.join("; ") + ") — every candidate URL is listed above in full; a 404 on all of them means the Clerk's naming changed and the candidate list needs a patch" });
      congressProgress.stage = "parse";
      const entries = t13fZipEntries(zipBuf);
      // What the ZIP actually holds is unverified from here — whether it carries only the index or
      // the PDFs alongside it. The first production run answers that, so it is logged either way.
      const idx = entries.find((e) => /\.xml$/i.test(e.name)) || entries.find((e) => /\.txt$/i.test(e.name));
      if (!idx) return fail({ ok: false,
        error: "no .xml or .txt index inside the zip (" + entries.length + " entr" + (entries.length === 1 ? "y" : "ies") + ": "
          + entries.slice(0, 6).map((e) => e.name).join(", ") + ") — layout changed, ingest needs a patch" });
      const parsedIdx = parseHouseIndex(zipEntryText(zipBuf, idx), yr);
      const rows = parsedIdx.rows, badDates = parsedIdx.badDates;
      const noDate = rows.filter((r) => !r.filed).length;
      if (!rows.length) return fail({ ok: false,
        error: "index " + idx.name + " parsed to zero filings — element or column names may have changed; ingest needs a patch" });
      congressProgress.stage = "store";
      const up = store.congressUpsertFilings(rows);
      const ptr = rows.filter((r) => r.type === "ptr").length;
      const unknown = [...new Set(rows.filter((r) => r.type === "other").map((r) => r.typeRaw))].filter(Boolean);
      store.congressMetaSet("synced:" + yr, String(Date.now()));
      store.congressMetaSet("lastSync", String(Date.now()));
      store.congressMetaSet("indexUrl:" + yr, urlUsed);
      congressLastError = null;
      const note = up.seen + " filings (" + ptr + " PTR), " + up.added + " new · zip "
        + (zipBuf.length / 1e6).toFixed(1) + "MB / " + entries.length + " entries · index " + idx.name
        + (unknown.length ? " · unmapped filing-type code(s) kept verbatim: " + unknown.join(",") : "")
        + (noDate ? " · " + noDate + " filing(s) with an unreadable FilingDate, kept and counted (raw: "
          + badDates.map((b) => JSON.stringify(b)).join(", ") + ")" : "");
      pushOps("congress index " + yr, "ingested from " + urlUsed + " — " + note, "info", true);
      log("congress: " + yr + " index ingested — " + note);
      return done({ ok: true, yr, url: urlUsed, filings: up.seen, added: up.added, ptr, noDate, badDates,
        entries: entries.length, index: idx.name, bytes: zipBuf.length, unknownTypes: unknown });
    } catch (e) {
      return fail({ ok: false, error: String(e && e.message).slice(0, 200) });
    }
  }
  // Daily-ish. The Clerk republishes the annual ZIP as filings land, so this is a refresh, not a
  // one-shot: there is no "already ingested, stop" short-circuit the way the quarterly 13F set has.
  // January and February also refresh the PRIOR year, because a December filing can be indexed
  // after the calendar rolls and would otherwise never be seen.
  let congressLastCheck = 0;
  async function congressTick(nowArg) {
    const now = nowArg || Date.now();
    if (now - congressLastCheck < 20 * HOUR) return;
    congressLastCheck = now;
    if (!store.congressReady || !store.congressReady()) return;
    const d = new Date(now), yr = d.getUTCFullYear();
    await congressIngest(yr).catch(() => {});
    if (d.getUTCMonth() <= 1) await congressIngest(yr - 1).catch(() => {});
    await congressParse().catch(() => {});      // work whatever the refreshed index just queued
  }
  // ---- CONGRESS phase 2: the PTR parse queue --------------------------------------------------
  // Filings the index found but nobody has read yet. Politeness first: one document a second, a cap
  // per run, and resumable — the queue IS the parsed=0 rows, so an interrupted run leaves no
  // half-state to reconcile. A fetch that fails transiently bumps `tries` and comes back; a
  // document with no text operators at all is a scan, which is permanent, so it is marked once and
  // never re-fetched. The difference matters: without it a few hundred scanned filings would
  // consume the whole rate budget every single day, forever.
  const CONGRESS_PARSE_CAP = 40;          // documents per run
  const CONGRESS_PARSE_GAP = congressGapOpt == null ? 1000 : +congressGapOpt;   // ms between fetches (0 in tests)
  let congressParseBusy = false;
  // "CrowdStrike Holdings, Inc. - Class A Common Stock" is the issuer plus a description of the
  // instrument. whaleNameKey strips corporate suffixes but not that tail, so it comes off here —
  // conservatively, from the END only, so the issuer's own words are never touched.
  const CONGRESS_TAIL = /\s*(?:-|\u2013|\u2014)?\s*(?:class\s+[a-z]\b|common\s+stock|common\s+shares?|ordinary\s+shares?|capital\s+stock|depositary\s+(?:shares?|receipts?)|american\s+depositary\s+(?:shares?|receipts?)|adr|ads|units?|stock|shares?|inc\.?|corp\.?|company)\s*$/i;
  function congressAssetName(asset) {
    let t = String(asset || "").replace(/\([^)]*\)/g, " ").replace(/\[[A-Z]{2}\]/g, " ")
      .replace(/\s+/g, " ").trim();
    for (let i = 0; i < 5 && CONGRESS_TAIL.test(t); i++) t = t.replace(CONGRESS_TAIL, "").trim();
    t = t.replace(/[\s,;:\-\u2013\u2014]+$/, "").trim();   // punctuation left behind by the trim
    return t.length >= 3 ? t : null;
  }
  // Words that carry no identity: dropping them cannot turn one company into another, so the lookup
  // may retry without them. "Apple Hospitality" must NEVER become "Apple", so truncation is allowed
  // to remove only these — never an arbitrary trailing word, which is exactly the fuzzy matching
  // this lane refuses.
  const CONGRESS_GENERIC = new Set(["HOLDINGS", "HOLDING", "GROUP", "CORPORATION", "CORP", "COMPANY",
    "CO", "INCORPORATED", "INC", "TECHNOLOGIES", "TECHNOLOGY", "INTERNATIONAL", "INDUSTRIES",
    "PARTNERS", "ENTERPRISES", "SYSTEMS", "SOLUTIONS", "LIMITED", "LTD", "PLC", "NV", "SA", "AG",
    "CLASS", "COMMON", "STOCK", "SHARES", "ORDINARY", "CAPITAL", "AMERICAN", "DEPOSITARY"]);
  // Resolution, most authoritative first, stopping at the first hit: the ticker the filer wrote,
  // then the full issuer name, then the name with generic tail words removed one at a time. Every
  // lookup goes through the SAME collision-safe map, so an ambiguous name resolves to nothing at
  // any depth rather than to a coin flip.
  function congressResolve(asset, tmap) {
    if (!tmap) return null;
    const nm = congressAssetName(asset);
    if (!nm) return null;
    let hit = whaleTickerOf(nm, tmap);
    if (hit) return hit;
    let w = nm.toUpperCase().replace(/[^A-Z0-9 ]+/g, " ").replace(/\s+/g, " ").trim().split(" ");
    while (w.length > 1 && CONGRESS_GENERIC.has(w[w.length - 1])) {
      w.pop();
      if (w.join(" ").length < 4) break;
      hit = whaleTickerOf(w.join(" "), tmap);
      if (hit) return hit;
    }
    return null;
  }
  // A starred member's new activity, pushed on its own class. Two guards, both learned elsewhere in
  // this codebase rather than theorised:
  //   - PRIMED. The very first parse run works through a queue hundreds deep, and a backfill walks
  //     years of history. Alerting on those would fire a wall of notifications about trades from
  //     2024, which is how a channel gets muted and the real alert gets missed. Nothing fires until
  //     one parse run has completed, exactly as the whale lane refuses to alert on its seed pull.
  //   - RECENT. Even primed, a filing older than the statutory window is history being filled in,
  //     not news. The filing DATE is the clock — that is when the information became public.
  const CONGRESS_ALERT_MAX_AGE = 10 * DAY;
  function congressAlert(filing, txs) {
    try {
      if (!txs || !txs.length) return;
      if (!store.congressMeta || !store.congressMeta("alertPrimed")) return;
      const w = store.congressWatched && store.congressWatched(filing.member);
      if (!w || !w.notify) return;
      const filed = filing.filed || (store.congressFilings ? "" : "");
      const at = filed ? Date.parse(filed + "T00:00:00Z") : NaN;
      if (Number.isFinite(at) && Date.now() - at > CONGRESS_ALERT_MAX_AGE) return;
      const buys = txs.filter((t) => /^buy/.test(t.act)).length;
      const sells = txs.filter((t) => /^sell/.test(t.act)).length;
      const names = [...new Set(txs.map((t) => t.ticker || (t.asset || "").slice(0, 18)).filter(Boolean))].slice(0, 6);
      const floor = txs.reduce((a, b) => a + (b.loAmt || 0), 0);
      const brief = txs.length + " transaction" + (txs.length === 1 ? "" : "s")
        + (buys ? " \u00b7 " + buys + " buy" : "") + (sells ? " \u00b7 " + sells + " sell" : "")
        + " \u00b7 \u2265 $" + Math.round(floor).toLocaleString()
        + (names.length ? " \u00b7 " + names.join(", ") : "");
      emitTrig("congress", { t: null, coin: null, congress: 1, member: filing.member,
        h: filing.member + " \u2014 " + brief, url: filing.url || null,
        pub: Number.isFinite(at) ? at : Date.now() });
      persistTriggers();
    } catch (_) {}
  }
  async function congressParse(limitArg) {
    if (congressParseBusy) return { ok: false, error: "a parse run is already going" };
    if (!store.congressReady || !store.congressReady()) return { ok: false, error: "sqlite unavailable in this runtime" };
    const lim = Math.max(1, Math.min(200, +limitArg || CONGRESS_PARSE_CAP));
    const queue = store.congressQueue(lim);
    if (!queue.length) return { ok: true, done: 0, note: "queue empty" };
    congressParseBusy = true;
    const tmap = await whaleTickerMap().catch(() => null);
    let parsed = 0, tx = 0, scanned = 0, failed = 0, notPdf = 0, first = null, firstBody = null;
    try {
      for (const f of queue) {
        try {
          // Timeout per document. extFetch is a bare fetch wrapper, so without an abort a single
          // hung response stalls the entire run — and this run is on the daily tick.
          const ac = new AbortController();
          const to = setTimeout(() => ac.abort(), 25 * 1000);
          let res;
          try { res = await extFetch(f.url, { headers: { "user-agent": SEC_UA }, signal: ac.signal }); }
          finally { clearTimeout(to); }
          if (!res || !res.ok) { store.congressBumpTry(f.id); failed++;
            if (!first) first = f.id + " → HTTP " + (res ? res.status : "no response"); continue; }
          const buf = Buffer.from(await res.arrayBuffer());
          // A 200 whose body is not a PDF is a FETCH problem — a redirect, an error page, a login
          // wall — and must never be recorded as "scanned". The first cut did exactly that, which
          // marked the row permanently unreadable and made a wrong URL look like a paper filing.
          if (buf.length < 5 || buf.subarray(0, 5).toString("latin1") !== "%PDF-") {
            store.congressBumpTry(f.id);
            store.congressNote(f.id, "not-a-pdf:" + JSON.stringify(buf.subarray(0, 24).toString("latin1")).slice(0, 40));
            notPdf++;
            if (!firstBody) firstBody = f.id + " → " + (res.headers && res.headers.get ? res.headers.get("content-type") : "?")
              + " " + JSON.stringify(buf.subarray(0, 48).toString("latin1"));
            continue;
          }
          const runs = pdfTextRuns(buf);
          if (!runs.length) {
            // Distinguish "image-only, needs OCR" from "encrypted in a way this build cannot open".
            // The first is permanent; the second is a gap that a later build closes, so it must not
            // be condemned as unreadable forever.
            let why = "pdf-but-no-text";
            try { const oo = require("./compute").pdfObjects(buf);
              if (oo.encryption && oo.encryption.unsupported) why = "encryption-unsupported:" + oo.encryption.unsupported;
              // An image-only filing is a SCAN and says so: the Clerk's older paper filings are
              // photographed, not typeset. That is a coverage limit of this lane (no OCR), not a
              // parser bug, and the count only means something if it is named correctly.
              else if (/\/BitsPerComponent|\/Subtype\s*\/Image|\/DCTDecode|\/JBIG2Decode|\/CCITTFaxDecode/.test(buf.toString("latin1")))
                why = "scanned-image:no OCR in this lane"; } catch (_) {}
            if (/^encryption-unsupported/.test(why)) { store.congressBumpTry(f.id); store.congressNote(f.id, why); failed++; }
            else { store.congressMarkUnreadable(f.id, why); scanned++; }
            continue;
          }
          const out = parsePtr(ptrRows(runs));
          // A filer is not required to write the ticker, and most do not. The issuer NAME is still
          // there, and the 13F lane already owns a conservative name->ticker map built from the
          // SEC's own company list — collision-safe by construction: a name that could mean two
          // symbols is dropped from the map rather than resolved to a coin flip. Reuse it, and
          // record HOW each ticker was arrived at so the two strengths of claim stay separable.
          for (const t of out.tx) {
            if (t.ticker) { t.tkSrc = "form"; continue; }
            // An asset class that cannot have a ticker is not an unresolved one. Saying so is the
            // difference between a coverage rate that describes the parser and one that describes
            // the composition of the data.
            if (t.atype && !PTR_TICKERABLE.has(t.atype)) { t.tkSrc = "n/a"; continue; }
            const sym = congressResolve(t.asset, tmap);
            if (sym) { t.ticker = sym; t.tkSrc = "name"; }
          }
          if (!out.tx.length) store.congressNote(f.id, "text-but-no-rows:" + runs.length + " runs");
          // A text PDF that yields no transaction row is NOT the same as a scan: it parsed, it just
          // had nothing this parser recognized. It is saved as zero rows so it leaves the queue and
          // shows up in the counts as a parsed filing with no transactions — visible, not silent.
          store.congressSaveTx(f.id, out.tx);
          parsed++; tx += out.tx.length;
          congressAlert(f, out.tx);
        } catch (e) { store.congressBumpTry(f.id); failed++;
          if (!first) first = f.id + " → " + String(e && e.message).slice(0, 60); }
        if (CONGRESS_PARSE_GAP) await new Promise((r) => setTimeout(r, CONGRESS_PARSE_GAP));
      }
    } finally { congressParseBusy = false; }
    // Primed only AFTER a run completes: the first run drains a queue of history, and nothing in
    // it is news to anybody.
    try { if (store.congressMetaSet && !store.congressMeta("alertPrimed")) store.congressMetaSet("alertPrimed", String(Date.now())); } catch (_) {}
    const st = store.congressParseStats();
    const note = parsed + " parsed (" + tx + " transactions)"
      + (scanned ? ", " + scanned + " PDF-but-no-text" : "")
      + (notPdf ? ", " + notPdf + " NOT-A-PDF responses (first: " + firstBody + ")" : "")
      + (failed ? ", " + failed + " fetch failures (first: " + first + ")" : "")
      + " · queue now " + (st ? st.pending : "?");
    pushOps("congress PTR parse", note, failed && !parsed ? "warn" : "info", true);
    log("congress: parse run — " + note);
    return { ok: true, done: queue.length, parsed, tx, scanned, notPdf, failed, stats: st };
  }
  // One document, end to end, reported in full: what came back, whether it is even a PDF, how much
  // text the extractor found, what the rows look like, and what the parser made of them. This is
  // the tool that turns "222 unreadable" into a fixable fact.
  async function congressDiag(docIdArg) {
    let id = String(docIdArg || "").trim().replace(/^H:/i, "");
    if (!id) {
      // No argument: diagnose the head of the queue. When nothing has parsed there is no row on the
      // panel to copy an id from, so requiring one made the tool useless exactly when it is needed.
      const q = store.congressQueue(1, 99);
      if (!q.length) return { ok: false, error: "queue is empty — pass a docId explicitly: congress diag <docId>" };
      id = String(q[0].id).replace(/^H:/, "");
    }
    if (!/^\d{4,}$/.test(id)) return { ok: false, error: "usage: congress diag [docId] — omit it to take the head of the queue" };
    const row = store.congressFilings({ limit: 500 }).find((r) => r.id === "H:" + id);
    const yr = new Date().getUTCFullYear();
    const url = (row && row.url) || housePtrUrl(yr, id);
    try {
      const ac = new AbortController();
      const to = setTimeout(() => ac.abort(), 25 * 1000);
      let res;
      try { res = await extFetch(url, { headers: { "user-agent": SEC_UA }, signal: ac.signal }); }
      finally { clearTimeout(to); }
      if (!res) return { ok: false, url, error: "no response" };
      const ct = res.headers && res.headers.get ? res.headers.get("content-type") : null;
      if (!res.ok) return { ok: false, url, status: res.status, ct, error: "HTTP " + res.status };
      const buf = Buffer.from(await res.arrayBuffer());
      const head = buf.subarray(0, 64).toString("latin1");
      const isPdf = buf.subarray(0, 5).toString("latin1") === "%PDF-";
      const out = { ok: true, url, status: res.status, ct, bytes: buf.length, isPdf,
        head: JSON.stringify(head), producer: null, runs: 0, rows: 0, tx: 0, sampleRuns: [], sampleRows: [], sampleTx: [] };
      if (!isPdf) return out;
      const pm = buf.toString("latin1").match(/\/(Producer|Creator)\s*\(([^)]{0,60})\)/);
      out.producer = pm ? pm[2] : null;
      // Structural facts that explain a zero-run result: object streams and encryption both hide
      // content from a top-level object scan, and neither is guessable from the outside.
      const raw = buf.toString("latin1");
      out.objStm = /\/Type\s*\/ObjStm/.test(raw);
      out.encrypted = /\/Encrypt\b/.test(raw);
      try { const oo = require("./compute").pdfObjects(buf); out.encryption = oo.encryption || null; } catch (_) {}
      out.objects = (raw.match(/\d+\s+\d+\s+obj\b/g) || []).length;
      out.streams = (raw.match(/\bstream\b/g) || []).length;
      const runs = pdfTextRuns(buf);
      out.runs = runs.length;
      out.sampleRuns = runs.slice(0, 12).map((r) => ({ x: Math.round(r.x), y: Math.round(r.y), t: String(r.text).slice(0, 40) }));
      const rows2 = ptrRows(runs);
      out.rows = rows2.length;
      out.sampleRows = rows2.slice(0, 10).map((r) => r.cells.map((c) => c.text).join(" | ").slice(0, 160));
      const pr = parsePtr(rows2);
      out.tx = pr.tx.length;
      out.sampleTx = pr.tx.slice(0, 4);
      out.skipped = pr.skipped.slice(0, 4);
      return out;
    } catch (e) { return { ok: false, url, error: String(e && e.message).slice(0, 200) }; }
  }
  function congressRequeue(which) {
    const n = store.congressRequeue ? store.congressRequeue(which) : 0;
    pushOps("congress PTR parse", n + " filing(s) put back in the queue" + (which === "all" ? " (all non-parsed)" : " (previously marked unreadable)"), "info", true);
    return { ok: true, requeued: n };
  }
  // The Clerk publishes one index per YEAR and the daily tick only ever asks for the current one,
  // so the store held 2026 and nothing else — a member who last filed in 2025 simply did not exist
  // as far as this lane was concerned. Backfill walks previous years, newest first, and stops at
  // the first year that yields nothing rather than grinding back to 2008 on every run.
  async function congressBackfill(yearsArg) {
    const years = Math.max(1, Math.min(12, +yearsArg || 3));
    const now = new Date().getUTCFullYear();
    const out = [];
    for (let i = 1; i <= years; i++) {
      const yr = now - i;
      const r = await congressIngest(yr).catch((e) => ({ ok: false, error: String(e && e.message) }));
      out.push({ yr, ok: !!r.ok, filings: r.filings || 0, added: r.added || 0, ptr: r.ptr || 0, error: r.error || null });
      if (!r.ok) break;                       // a year with no index means there is nothing older to find
    }
    const total = out.reduce((a, b) => a + (b.added || 0), 0);
    pushOps("congress index", "backfill: " + out.map((o) => o.yr + (o.ok ? " +" + o.added : " \u2717")).join(", ")
      + " \u00b7 " + total + " new filing(s)", "info", true);
    return { ok: true, years: out, added: total };
  }
  function congressStatus() {
    const last = +(store.congressMeta && store.congressMeta("lastSync")) || 0;
    return { ready: !!(store.congressReady && store.congressReady()),
      busy: congressBusy, progress: congressProgress, lastSync: last || null,
      lastError: congressLastError,
      counts: (store.congressCounts && store.congressCounts()) || null,
      parse: (store.congressParseStats && store.congressParseStats()) || null,
      parsing: congressParseBusy,
      years: (store.congressYears && store.congressYears()) || [] };
  }

  async function getWhaleHolds(qRaw) {
    const q = String(qRaw || "").trim();
    if (!q) return { ok: false, error: "usage: whale who <ticker, name fragment, or CUSIP>" };
    const QU = q.toUpperCase();
    const qKey = whaleNameKey(q);
    const isCusip = /^[A-Z0-9]{9}$/.test(QU);
    let tkKey = null, tk = null;
    try {
      const maps = await ensureCikMaps();
      if (maps && maps.co.has(QU)) { tk = QU; tkKey = whaleNameKey((maps.co.get(QU) || {}).name || ""); }
    } catch (_) {}
    const subOk = q.length >= 3;
    const match = (p) => {
      if (isCusip && p.cusip === QU) return "cusip";
      const nk = whaleNameKey(p.name);
      if (tkKey && nk === tkKey) return "ticker";
      if (qKey && nk === qKey) return "name";
      if (subOk && String(p.name).toUpperCase().includes(QU)) return "substring";
      return null;
    };
    // Issuer buckets, keyed on identity rather than on the string that happened to match.
    const iss = new Map();
    const bucket = (p, m) => {
      const ik = whaleIssuerKey(p.cusip, p.name) || ("N:" + String(p.name || "").toUpperCase());
      let b = iss.get(ik);
      if (!b) b = { key: ik, names: new Map(), basis: null, tkHit: 0 }, iss.set(ik, b);
      if (!b.basis || HOLDS_BASIS_RANK[m] > HOLDS_BASIS_RANK[b.basis]) b.basis = m;
      if (m === "ticker") b.tkHit = 1;   // the ticker chip belongs to the issuer the map resolved, not to every issuer in the result
      b.names.set(p.name, (b.names.get(p.name) || 0) + 1);
      return b;
    };
    const perFund = [], noBook = [];
    let nPositions = 0, nBooks = 0;
    for (const w of whaleState.watch) {
      const byQ = whaleState.filings[w.cik] || {};
      const rows2 = Object.values(byQ).filter((x) => x && x.period).sort((a, b) => String(b.period).localeCompare(String(a.period)));
      const cur = rows2[0];
      if (!cur) { noBook.push(w.key); continue; }
      nBooks++; nPositions += cur.book.n;
      const dd = whaleDelta(cur.book, whalePrevBook(w.cik, whaleQOfPeriod(cur.period)));
      const byIss = new Map();
      const slot = (bk) => { let e = byIss.get(bk); if (!e) e = { lines: [], exited: [] }, byIss.set(bk, e); return e; };
      for (let i = 0; i < dd.rows.length; i++) {
        const p = dd.rows[i];
        const m = match(p); if (!m) continue;
        slot(bucket(p, m).key).lines.push({ put: p.put, cusip: p.cusip, cls: p.cls || null,
          value: p.value, shares: p.shares, pct: p.pct, rank: i + 1, d: p.d });
      }
      for (const x of dd.lanes.exited) {
        const m = match(x); if (!m) continue;
        slot(bucket(x, m).key).exited.push({ put: x.put, prevVal: x.prevVal });
      }
      perFund.push({ key: w.key, name: w.name, q: whaleQOfPeriod(cur.period), byIss });
    }
    const issuers = [];
    for (const b of iss.values()) {
      const fl = [], notHeld = [];
      for (const pf of perFund) {
        const e = pf.byIss.get(b.key);
        if (!e || (!e.lines.length && !e.exited.length)) { notHeld.push(pf.key); continue; }
        fl.push({ key: pf.key, name: pf.name, q: pf.q, held: e.lines.length ? 1 : 0,
          lines: e.lines, exited: e.exited, dir: null, mixed: 0 });
      }
      // Value is split by INSTRUMENT, never summed across it. 13F reports an options line at the
      // UNDERLYING NOTIONAL, not the premium paid, so adding it to a common-equity line produces
      // a figure that describes no position any filer holds — and at option-heavy filers it is
      // the figure that dominates. Two numbers, because they are two things.
      let common = 0, optNotional = 0, adding = 0, cutting = 0, flat = 0;
      for (const f of fl) {
        for (const l of f.lines) { if (l.put) optNotional += l.value || 0; else common += l.value || 0; }
        if (f.held) { const d = holdsDir(f.lines); f.dir = d.dir; f.mixed = d.mixed; }
        else f.dir = f.exited.some((x) => !x.put) ? "exit" : "na";   // an expired options line is not a directional exit
        if (f.dir === "add" || f.dir === "new") adding++;
        else if (f.dir === "trim" || f.dir === "exit") cutting++;
        else if (f.dir === "flat") flat++;
      }
      const val = (f) => f.lines.reduce((s, l) => s + (l.value || 0), 0);
      fl.sort((a, c) => val(c) - val(a));
      // Display name: the spelling the most filers used, longest on a tie. -06 took the SHORTEST
      // name across the whole result, which is how a 10-character coincidence outranked the
      // 26-character company the query actually resolved to.
      let name = null, best = -1;
      for (const [n, c] of b.names) if (c > best || (c === best && n.length > String(name).length)) { name = n; best = c; }
      issuers.push({ key: b.key, name, tk: b.tkHit ? tk : null, basis: b.basis,
        basisLabel: holdsBasisLabel(b.basis, tk), funds: fl, notHeld,
        held: fl.filter((f) => f.held).length, combined: common + optNotional,
        common, optNotional, adding, cutting, flat });
    }
    if (!issuers.length) {
      // A name NOBODY on the watchlist holds is exactly where the market-wide index matters most —
      // the original -05 cut returned the miss here and the TOP HOLDERS block below never ran (a
      // gap against the feature's whole point). The index is keyed by CUSIP (the SEC data set
      // carries no tickers), so: a 9-char CUSIP query still gets the full market answer on a
      // watchlist miss; a ticker/name query gets an honest one-liner about why it can't.
      const miss = { ok: false, miss: 1, q, nBooks, nPositions, noBook,
        error: "no tracked fund's latest 13F contains \u201c" + q + "\u201d \u2014 searched " + nBooks + " book(s), " + nPositions
          + " positions, by ticker, normalized name" + (subOk ? ", substring" : "") + " and CUSIP. Not held \u2260 not owned: shorts, futures, non-US and anything bought since quarter-end are invisible in a 13F." };
      try {
        const qs = store.t13fQuarters ? store.t13fQuarters() : [];
        if (qs.length && isCusip) {
          const a = store.t13fAgg(qs[0], QU);
          if (a) {
            const rows3 = store.t13fTop(qs[0], QU, T13F_TOP_SHOW);
            const prevQ = qs[1] || null;
            const watchByCik = new Map(whaleState.watch.map((w) => [+w.cik, w.key]));
            let anyPrev = false;
            const list = rows3.map((r) => {
              const prev = prevQ ? store.t13fHolderRow(prevQ, QU, r.cik) : null;
              if (prev) anyPrev = true;
              return { rank: r.rk, cik: r.cik, name: r.name, value: r.value, shares: r.shares,
                dSh: prev && prev.shares != null && r.shares != null ? r.shares - prev.shares : null,
                isNew: prevQ && !prev ? 1 : 0, tracked: watchByCik.get(+r.cik) || null };
            });
            miss.ok = true; miss.missButTop = 1; miss.name = QU; miss.funds = []; miss.notHeld = whaleState.watch.map((w) => w.key);
            miss.held = 0; miss.adding = 0; miss.cutting = 0; miss.flat = 0; miss.combined = 0; miss.common = 0; miss.optNotional = 0;
            miss.watchN = whaleState.watch.length; miss.issuers = []; miss.basis = "exact CUSIP (market-wide index; no tracked fund holds it)";
            miss.top = { q: qs[0], prevQ, cusip: QU, nFilers: a.nFilers, totVal: a.totVal, rows: list,
              otherCusips: 0, allNew: prevQ && rows3.length && !anyPrev ? 1 : 0,
              cap: +(store.t13fMeta && store.t13fMeta("cap")) || T13F_TOP_CAP };
          }
        } else if (qs.length && !isCusip) {
          miss.error += " Market-wide top holders exist for this data set but the index is keyed by CUSIP (the SEC data set carries no tickers) \u2014 search the 9-char CUSIP to get them.";
        }
        const t13fS0 = t13fStatus();
        miss.topMeta = { ready: !!(t13fS0.ready && t13fS0.quarters.length), quarters: t13fS0.quarters, busy: t13fS0.busy };
      } catch (_) {}
      return miss;
    }
    issuers.sort((a, c) => HOLDS_BASIS_RANK[c.basis] - HOLDS_BASIS_RANK[a.basis] || c.combined - a.combined);
    const P = issuers[0];
    // Market-wide TOP HOLDERS (build 2026.08.21-05): when the SEC data-set index has the PRIMARY
    // issuer's cusip, the same response carries the top-N across ALL ~8,500 filers. Primary cusip
    // = the primary issuer's largest by institutional value (share classes stay separate rows in
    // the index; the count of sibling cusips is disclosed). Tracked overlay by CIK. \u0394 shares
    // vs the prior stored set; a holder absent from the prior TOP table is NEW only when the
    // prior set exists — outside-the-cap ambiguity renders as a dash, never a guess.
    let top = null;
    try {
      const qs = store.t13fQuarters ? store.t13fQuarters() : [];
      if (qs.length) {
        const matched = new Set();
        for (const f of P.funds) { for (const l of f.lines) if (l.cusip) matched.add(l.cusip); for (const x of f.exited) if (x.cusip) matched.add(x.cusip); }
        if (isCusip) matched.add(QU);
        let best = null;
        for (const cu of matched) { const a = store.t13fAgg(qs[0], cu); if (a && (!best || a.totVal > best.a.totVal)) best = { cu, a }; }
        if (best) {
          const rows3 = store.t13fTop(qs[0], best.cu, T13F_TOP_SHOW);
          const prevQ = qs[1] || null;
          const watchByCik = new Map(whaleState.watch.map((w) => [+w.cik, w.key]));
          let anyPrev = false;
          const list = rows3.map((r) => {
            const prev = prevQ ? store.t13fHolderRow(prevQ, best.cu, r.cik) : null;
            if (prev) anyPrev = true;
            return { rank: r.rk, cik: r.cik, name: r.name, value: r.value, shares: r.shares,
              dSh: prev && prev.shares != null && r.shares != null ? r.shares - prev.shares : null,
              isNew: prevQ && !prev ? 1 : 0, tracked: watchByCik.get(+r.cik) || null };
          });
          top = { q: qs[0], prevQ, cusip: best.cu, nFilers: best.a.nFilers, totVal: best.a.totVal,
            rows: list, otherCusips: Math.max(0, matched.size - 1),
            allNew: prevQ && rows3.length && !anyPrev ? 1 : 0,   // the IPO signature: nobody in the top existed last set
            cap: +(store.t13fMeta && store.t13fMeta("cap")) || T13F_TOP_CAP };
        }
      }
    } catch (_) {}
    const t13fS = t13fStatus();
    return { ok: true, q, issuers, watchN: whaleState.watch.length, noBook,
      // primary mirror — the shape every -06 caller already reads
      name: P.name, tk: P.tk, basis: P.basisLabel, funds: P.funds, notHeld: P.notHeld,
      combined: P.combined, common: P.common, optNotional: P.optNotional,
      held: P.held, adding: P.adding, cutting: P.cutting, flat: P.flat,
      top, topMeta: { ready: !!(t13fS.ready && t13fS.quarters.length), quarters: t13fS.quarters, busy: t13fS.busy } };
  }
  async function getWhaleSeasonQ(qRaw) {
    const q = String(qRaw || "").trim() || (getWhale().seasonQ || "");
    const s = whaleState.seasons[q];
    if (!s) return { ok: false, error: q ? "no season build for " + q : "no season built yet \u2014 it lands when the watched funds file" };
    const tmap = await whaleTickerMap().catch(() => null);
    const tag = (rows3) => rows3.map((r) => Object.assign({}, r, { tk: whaleTickerOf(r.name, tmap) }));
    // Staleness, stated rather than hidden. A build can outlive its roster: remove the only filer
    // (or every filer) and whaleSeasonMaybe has nothing to build from, so it early-returns and this
    // aggregate keeps describing funds you no longer watch. Deleting the quarter would be
    // destroying history to hide a label, so the season stands and SAYS what it is. Identity is the
    // CIK, never the key — keys are de-collided labels and free up for reuse the moment a fund
    // leaves the list, so comparing on them would call a reused label a survivor.
    const watchedCik = new Set(whaleState.watch.map((w) => +w.cik));
    const roster = (s.agg.roster || []).map((r) => Object.assign({}, r, { dropped: r.cik != null && !watchedCik.has(+r.cik) ? 1 : 0 }));
    const dropped = roster.filter((r) => r.dropped).map((r) => r.key);
    return { ok: true, q: s.q, at: s.at, filedN: s.filedN, watchN: s.watchN, missing: s.missing,
      amended: !!s.amended, healed: s.healed ? 1 : 0, closedAt: s.closedAt,
      stale: dropped.length ? { dropped, watchN: whaleState.watch.length } : null,
      agg: { bought: tag(s.agg.bought), sold: tag(s.agg.sold), opens: tag(s.agg.opens),
        exits: tag(s.agg.exits), crowd: tag(s.agg.crowd), roster, nFunds: s.agg.nFunds } };
  }

  // ---- weekly sector audit (build 2026.08.05-02) ----------------------------------------------
  // The classification watchdog with a WRITE arm: once a week it (a) resolves roster tickers every
  // static table declined (Unclassified) and (b) checks curated PREIPO names for a real listing —
  // and, when the evidence gate passes, APPLIES the change as a persisted overlay entry rather
  // than flagging it for a human. The curated tables in sectors.js stay untouched (they are source
  // code; a job cannot durably edit them) — the overlay is the runtime layer classify() consults,
  // and it wins only where the tables are silent or a graduation supersedes a PREIPO row.
  // Transparency is the license for the write arm: every applied change lands as an ops event with
  // its evidence, every classified name wears an `auto` provenance mark on the ONE classify() path
  // every consumer reads, the full record log is served to the admin panel, and any entry reverts
  // with one click — a reverted ticker is PINNED and never auto re-applied. Decisions are pure
  // (compute.sectorAuditDecide) against real fetched shapes; this block only fetches + assembles.
  // Frozen geometry note: an applied change alters classification GOING FORWARD only — fired
  // ledger signals keep their stamped geometry, and no historical series restarts.
  const SECTOR_AUDIT_TICK_MS = 60 * 60 * 1000;   // hourly due-check; the run itself fires Sundays >= 12:00 UTC
  const SECTOR_AUDIT_MAX_CANDIDATES = 20;        // per run — bounds external API weight; leftovers wait a week
  let auditRecs = [];                            // the append-only record log, persisted whole (atomic)
  let auditRunning = false;
  function auditState() { return mergeSectorAudit(auditRecs); }
  function applyAuditOverlay() {
    const m = auditState();
    setSectorOverlay(m.active);
    _clsCache.clear();   // classification changed -> every cached verdict is stale; rebuilt lazily
    return m;
  }
  function auditHydrate() {
    try { const d = store.loadSectorAudit && store.loadSectorAudit();
      if (d && Array.isArray(d.records)) auditRecs = d.records; } catch (_) {}
    applyAuditOverlay();
  }
  function auditAppend(rec) {
    // Validate-then-mutate: the record must survive the fold before it enters the log, so a bad
    // write can never poison the persisted state (atomic state changes, same rule as the ledger).
    const trial = mergeSectorAudit([...auditRecs, rec]);
    if (!trial) return false;
    auditRecs.push(rec);
    if (auditRecs.length > 2000) auditRecs = auditRecs.slice(-2000);   // years of weekly runs; bound anyway
    const ok = store.saveSectorAudit ? store.saveSectorAudit({ records: auditRecs }) : false;
    applyAuditOverlay();
    return ok !== false;
  }
  async function finnProfile(sym, token) {
    const r = await extGet("https://finnhub.io/api/v1/stock/profile2?symbol=" + encodeURIComponent(sym) + "&token=" + encodeURIComponent(token), "json");
    if (!r.ok || !r.body || typeof r.body !== "object" || !r.body.name) return null;
    return { name: r.body.name || null, exchange: r.body.exchange || null, ipo: r.body.ipo || null,
      finnhubIndustry: r.body.finnhubIndustry || null };
  }
  async function edgarSicFor(T, maps) {
    const hit = maps && maps.co ? maps.co.get(T) : null;
    if (!hit) return { sic: null, edgarName: null };
    const sub = await extGet("https://data.sec.gov/submissions/CIK" + cikPad(hit.cik) + ".json", "json");
    const sic = sub.ok && sub.body && sub.body.sic != null ? Number(sub.body.sic) : null;
    return { sic: Number.isFinite(sic) && sic > 0 ? sic : null, edgarName: hit.name || (sub.ok && sub.body && sub.body.name) || null };
  }
  async function sectorAuditRun() {
    if (auditRunning) return { ok: false, error: "already running" };
    auditRunning = true;
    const startedAt = Date.now();
    try {
      const token = process.env.FINNHUB_TOKEN || "";
      if (!token) {
        auditAppend({ k: "run", ts: startedAt, applied: 0, flagged: 0, err: "FINNHUB_TOKEN not set" });
        pushOps("sector audit", "weekly run skipped — FINNHUB_TOKEN not set", "warn");
        return { ok: false, error: "FINNHUB_TOKEN not set" };
      }
      const m = auditState();
      const onRoster = new Set(activeMarkets().map((r) => String(r.ticker || "").toUpperCase()).filter(Boolean));
      const cands = [];
      // (a) unresolved roster names: every static table AND the current overlay already declined.
      for (const r of activeMarkets()) {
        const T = String(r.ticker || "").toUpperCase();
        if (!T || r.delisted || m.pinned.has(T)) continue;
        if (classify(T, r.uni).assetClass !== "Unclassified") continue;
        cands.push({ kind: "classify", ticker: T });
      }
      // (b) curated PREIPO names still classifying as Pre-IPO (an active graduate overlay entry
      // already moved them to Equity, so re-checking those is free of double-apply by construction).
      for (const T of Object.keys(PREIPO)) {
        if (!onRoster.has(T) || m.pinned.has(T)) continue;
        if (classify(T, "xyz").assetClass !== "Pre-IPO") continue;
        cands.push({ kind: "graduate", ticker: T, curSector: PREIPO[T] });
      }
      const work = cands.slice(0, SECTOR_AUDIT_MAX_CANDIDATES);
      const maps = await ensureCikMaps();   // null when sec.gov is down — decide() degrades to flags, honestly
      let applied = 0, flagged = 0;
      for (const c of work) {
        try {
          const profile = await finnProfile(c.ticker, token);
          const sec = await edgarSicFor(c.ticker, maps);
          const cand = c.kind === "graduate"
            ? { kind: "graduate", ticker: c.ticker, curSector: c.curSector,
                expectedNames: [displayName ? displayName(c.ticker) : null, ...(nameAliases(c.ticker) || [])]
                  .map((n) => String(n || "").replace(/\s*\(pre-IPO synthetic\)\s*$/i, "")).filter(Boolean),
                profile, sic: sec.sic, edgarName: sec.edgarName }
            : { kind: "classify", ticker: c.ticker, profile, sic: sec.sic };
          const d = sectorAuditDecide(cand);
          if (d.apply && GICS_SET.has(d.sector)) {
            auditAppend({ k: "apply", ts: Date.now(), ticker: c.ticker, action: d.action,
              sector: d.sector, ind: d.ind || d.sector, ev: Object.assign({ confidence: d.confidence, reason: d.reason }, d.ev), by: "auto" });
            applied++;
            pushOps("sector audit", (d.action === "graduate"
              ? c.ticker + " graduated Pre-IPO \u2192 Equity \u00b7 " + d.sector + " (name match " + d.confidence.toFixed(2) + ", exchange " + (d.ev.exchange || "?") + (d.ev.ipo ? ", IPO " + d.ev.ipo : "") + ") \u2014 earnings-calendar eligible next hydrate"
              : c.ticker + " classified " + d.sector + " / " + (d.ind || d.sector) + " (Finnhub + EDGAR SIC agree, conf " + d.confidence.toFixed(2) + ")") + " \u2014 revert in Admin \u00b7 Classification audit", "info");
          } else {
            auditAppend({ k: "flag", ts: Date.now(), ticker: c.ticker, action: d.action, reason: d.reason,
              ev: Object.assign({ confidence: d.confidence }, d.ev) });
            flagged++;
          }
        } catch (e) {
          auditAppend({ k: "flag", ts: Date.now(), ticker: c.ticker, action: c.kind, reason: "error",
            ev: { error: String(e && e.message || e) } });
          flagged++;
        }
      }
      auditAppend({ k: "run", ts: startedAt, applied, flagged });
      log("sector audit: " + work.length + " candidate(s), " + applied + " applied, " + flagged + " flagged" + (cands.length > work.length ? " (" + (cands.length - work.length) + " deferred to next run)" : ""));
      if (applied || flagged) pushOps("sector audit", "weekly run: " + applied + " applied, " + flagged + " flagged \u2014 details in Admin \u00b7 Classification audit", "info", applied === 0);
      return { ok: true, candidates: work.length, applied, flagged };
    } finally { auditRunning = false; }
  }
  async function sectorAuditTick() {
    if (!sectorAuditDue(Date.now(), auditState().lastRun)) return;
    await sectorAuditRun();
  }
  function getSectorAudit() {
    const m = auditState();
    return { ts: Date.now(), lastRun: m.lastRun || null, running: auditRunning,
      lastRunRec: m.lastRunRec ? { ts: m.lastRunRec.ts, applied: m.lastRunRec.applied, flagged: m.lastRunRec.flagged, err: m.lastRunRec.err || null } : null,
      applied: m.applied, flagged: m.flagged, pinned: [...m.pinned].sort(),
      gics: [...GICS_SET].sort() };
  }
  function sectorAuditRevert(tickerRaw) {
    const T = String(tickerRaw || "").toUpperCase().trim();
    if (!T) return { ok: false, error: "no ticker" };
    const m = auditState();
    if (![...m.applied].some((a) => a.ticker === T)) return { ok: false, error: "no applied entry for " + T };
    if (!auditAppend({ k: "revert", ts: Date.now(), ticker: T })) return { ok: false, error: "persist failed" };
    pushOps("sector audit", T + " overlay entry reverted by admin \u2014 pinned against auto re-apply", "info");
    return { ok: true };
  }
  function sectorAuditAck(tickerRaw) {
    // "Clear" for an applied row: acknowledgement only — the overlay entry STAYS ACTIVE, the panel
    // just stops showing it. Any later apply record for the same ticker un-hides it, so a changed
    // classification always resurfaces for review. Revert remains the only way to undo the entry.
    const T = String(tickerRaw || "").toUpperCase().trim();
    if (!T) return { ok: false, error: "no ticker" };
    const m = auditState();
    const a = m.applied.find((x) => x.ticker === T);
    if (!a) return { ok: false, error: "no applied entry for " + T };
    if (a.ack) return { ok: true };   // idempotent — a second clear is not an error
    if (!auditAppend({ k: "ack", ts: Date.now(), ticker: T })) return { ok: false, error: "persist failed" };
    return { ok: true };
  }
  function sectorAuditApply(tickerRaw, sectorRaw, indRaw) {
    // The one-click resolution for a FLAGGED name: an admin picking between the two sectors the
    // sources offered. Manual applies are stamped by:"admin" and validated like the auto path.
    const T = String(tickerRaw || "").toUpperCase().trim();
    const sector = String(sectorRaw || "");
    if (!T) return { ok: false, error: "no ticker" };
    if (!GICS_SET.has(sector)) return { ok: false, error: "unknown sector" };
    const m = auditState();
    const fl = m.flagged.find((f) => f.ticker === T);
    if (!fl) return { ok: false, error: "no flagged entry for " + T };
    const action = fl.action === "graduate" ? "graduate" : "classify";
    // Optional industry group: free text, sanitized and length-capped; blank means the honest
    // sector fallback (renders italic like every other fallback group). Never a validity concern
    // beyond shape — the industry lens is a display grouping, not a correctness claim.
    const ind = String(indRaw || "").replace(/[<>]/g, "").trim().slice(0, 40) || sector;
    if (!auditAppend({ k: "apply", ts: Date.now(), ticker: T, action, sector, ind,
      ev: Object.assign({ resolvedFrom: fl.reason }, fl.ev || null), by: "admin" })) return { ok: false, error: "persist failed" };
    pushOps("sector audit", T + " " + (action === "graduate" ? "graduated" : "classified") + " " + sector + (ind !== sector ? " / " + ind : "") + " by admin (resolved: " + fl.reason + ")", "info");
    return { ok: true };
  }
  auditHydrate();

  function getTgChannels() {
    return { ts: Date.now(), max: TG_MAX, channels: tgChannels.map((c) => Object.assign({ c }, tgStatus.get(c) || { lastOk: null, error: null, posts: 0 })) };
  }
  function setTgChannels(list) {
    if (!Array.isArray(list)) return { ok: false, error: "channels must be an array" };
    const seen = new Set(), clean = [];
    for (const raw of list) {
      const c = String(raw || "").trim().replace(/^@/, "").replace(/^(https?:\/\/)?t\.me\/(s\/)?/i, "");
      if (!TG_RE.test(c)) return { ok: false, error: `invalid channel username: ${String(raw).slice(0, 40)}` };
      const k = c.toLowerCase();
      if (seen.has(k)) continue;
      seen.add(k); clean.push(c);
    }
    if (clean.length > TG_MAX) return { ok: false, error: `at most ${TG_MAX} channels` };
    tgChannels = clean;
    store.saveTgChannels({ ts: Date.now(), channels: tgChannels });
    const purged = purgeTgOrphans();   // a removed channel's posts leave the feed NOW, not at 72h eviction
    setTimeout(() => { tgTick().catch(() => {}); }, 500);   // apply for the whole group within seconds, not a cadence
    return { ok: true, channels: tgChannels, purged };
  }
  function hydrateNews() {
    const d = store.loadNews && store.loadNews();
    if (d && Array.isArray(d.items)) { newsItems = mergeNews(d.items, [], Date.now()); newsFetchedAt = d.ts || 0; }
    if (d && d.secTape && typeof d.secTape === "object") secTape = d.secTape;
    if (d && d.secLearned && typeof d.secLearned === "object") secLearned = d.secLearned;
    if (d && d.nameLearned && typeof d.nameLearned === "object") nameLearned = d.nameLearned;
    try { const tc = store.loadTgChannels && store.loadTgChannels();
      if (tc && Array.isArray(tc.channels)) tgChannels = tc.channels.filter((c) => TG_RE.test(c)).slice(0, TG_MAX); } catch (_) {}
    { const live = new Set(tgChannels.map((c) => c.toLowerCase()));   // cached posts from since-removed channels die at hydrate
      newsItems = newsItems.filter((a) => { if (!a.tg) return true; const m = /^tg:([A-Za-z0-9_]+):/.exec(String(a.id)); return m ? live.has(m[1].toLowerCase()) : false; }); }
    for (const a of newsItems)   // pre-pipeline items carry no rel: gate on the headline we kept
      if (a.tk && a.rel == null) a.rel = newsRelevant(a.h, null, a.tk, aliasesFor(String(a.tk).toUpperCase())) ? 1 : 0;
    pruneSecTape();
    buildNewsPayload();
    return newsItems.length;
  }
  // ---- AI sector classification (write-once, enum-validated, fallback-model) ---------------
  // Two jobs, one cheap batched call on the FALLBACK model (sector bucketing doesn't merit
  // the expensive one): (a) tape headlines -> a GICS sector or "macro", by content; (b) any
  // ticker the static map calls Unclassified -> a one-time learned sector, persisted forever.
  // Everything is write-once: a classified id/ticker is NEVER re-sent. Answers outside the
  // enum are rejected (three strikes on a tape item -> "macro", so nothing loops forever).
  // Scope guard: learned sectors feed the NEWS badges/grouping ONLY — the signal engine, the
  // Sectors tab and asset-class pooling stay on the deterministic static map; promoting a
  // learned entry into sectors.js is a reviewed static edit, never automatic.
  const GICS_SECTORS = ["Information Technology", "Health Care", "Financials", "Consumer Discretionary",
    "Communication Services", "Industrials", "Consumer Staples", "Energy", "Utilities", "Real Estate", "Materials"];
  const GICS_SET = new Set(GICS_SECTORS);
  let secTape = {}, secLearned = {};           // articleId -> sector|"macro"; TICKER -> sector
  const secTries = new Map();                  // articleId -> failed attempts
  let secErr = null;
  function pruneSecTape() {                    // ids age out of the store; their classifications follow
    const live = new Set(newsItems.filter((a) => !a.tk).map((a) => String(a.id)));
    for (const id of Object.keys(secTape)) if (!live.has(id)) delete secTape[id];
    for (const id of [...secTries.keys()]) if (!live.has(id)) secTries.delete(id);
    const all = new Set(newsItems.map((a) => String(a.id)));
    for (const id of [...relTries.keys()]) if (!all.has(id)) relTries.delete(id);
  }
  const SEC_CLASSIFY_SYSTEM = "You classify financial news for a trading dashboard. Respond ONLY with a JSON object, no prose, no markdown fences: {\"tape\":[{\"i\":<id>,\"sec\":<sector>}],\"tickers\":[{\"t\":<ticker>,\"sec\":<sector>}],\"rel\":[{\"i\":<id>,\"v\":<verdict>,\"t\":<ticker if v is other>}],\"names\":[{\"t\":<ticker>,\"names\":[<company name>,<short name>]}]}. TAPE task: sec is one of the 11 GICS sector names exactly as given, \"macro\" for market-wide/central-bank/economy items, or \"off-topic\" for items with no market relevance (sports, entertainment, pure politics without market impact). TICKERS task: the 11 GICS names only. REL task: each entry is a headline fetched under ticker t but not verifiably about that company — answer v=\"y\" if it IS chiefly about that company, v=\"other\" with t=<TICKER> if it is chiefly about a DIFFERENT company in the provided universe list, v=\"market\" for general market/multi-stock coverage, v=\"off\" for no market relevance. NAMES task: for each ticker, return the company's canonical name and common short names as they appear in headlines (2-4 strings). GICS names: " + GICS_SECTORS.join("; ") + ".";
  function secStrikeSweep() {   // three strikes -> macro (tape) / demoted to tape (relevance); payload must rebuild
    let struck = 0;
    for (const a of newsItems) {
      const id = String(a.id);
      if (!a.tk && secTape[id] == null && (secTries.get(id) || 0) >= 3) { secTape[id] = "macro"; struck++; }
      if (a.tk && a.rel === 0 && (relTries.get(id) || 0) >= 3) { a.tk = null; a.rel = undefined; relTries.delete(id); struck++; }   // unjudgeable -> plain tape, sector classifier picks it up
    }
    return struck;
  }
  function secPending() {
    const tape = [];
    for (const a of newsItems) {
      if (a.tk || a.fl || secTape[String(a.id)] != null) continue;
      if ((secTries.get(String(a.id)) || 0) >= 3) continue;   // struck out — the sweep owns the macro conversion
      tape.push({ i: String(a.id), h: a.h });
      if (tape.length >= 20) break;
    }
    const tickers = [];
    const seen = new Set();
    for (const a of newsItems) {
      if (!a.tk) continue;
      const T = String(a.tk).toUpperCase();
      if (seen.has(T)) continue; seen.add(T);
      if (secLearned[T]) continue;
      if (classifyCached(a.tk).sector !== "Unclassified") continue;
      tickers.push(T);
      if (tickers.length >= 10) break;
    }
    // relevance verdicts for gated-out company items (three strikes -> demoted to tape)
    const rel = [];
    for (const a of newsItems) {
      if (!a.tk || a.rel !== 0) continue;
      if ((relTries.get(String(a.id)) || 0) >= 3) continue;   // struck out — the sweep demotes
      rel.push({ i: String(a.id), t: String(a.tk).toUpperCase(), h: a.h });
      if (rel.length >= 15) break;
    }
    // alias learning for equity tickers with neither seeded nor learned names
    const names = [], nseen = new Set();
    for (const a of newsItems) {
      if (!a.tk) continue;
      const T = String(a.tk).toUpperCase();
      if (nseen.has(T) || nameLearned[T] || nameAliases(T)) continue;
      nseen.add(T); names.push(T);
      if (names.length >= 8) break;
    }
    const uniTickers = [...earnEligible().keys()];   // roster for re-tag validation and the model's universe list
    return { tape, tickers, rel, names, universe: uniTickers };
  }
  async function classifySecTick() {
    if (!AI_KEY() && !aiFetch) return { ok: false, disabled: true };
    const struck = secStrikeSweep();
    if (struck) { buildNewsPayload(); store.saveNews({ ts: Date.now(), items: newsItems, secTape, secLearned, nameLearned }); }
    const pend = secPending();
    if (!pend.tape.length && !pend.tickers.length && !pend.rel.length && !pend.names.length) return { ok: true, idle: true, applied: struck };
    const call = await callModel(AI_CLASSIFY_MODEL, pend, { system: SEC_CLASSIFY_SYSTEM, maxTokens: 600, effort: AI_CLASSIFY_EFFORT });
    if (!call.ok) { secErr = call.error; return { ok: false, error: call.error }; }
    let out = null;
    try { out = JSON.parse(String(call.text).replace(/```json|```/g, "").trim()); } catch (_) {}
    if (!out || typeof out !== "object") {
      for (const t of pend.tape) secTries.set(t.i, (secTries.get(t.i) || 0) + 1);
      secErr = "unparseable classification response";
      return { ok: false, error: secErr };
    }
    let applied = 0;
    const answered = new Set();
    if (Array.isArray(out.tape)) for (const e of out.tape) {
      if (!e || e.i == null) continue;
      const id = String(e.i);
      answered.add(id);
      if (secTape[id] != null || !pend.tape.some((t) => t.i === id)) continue;   // write-once; ignore ids we never asked about
      if (e.sec === "macro" || GICS_SET.has(e.sec)) { secTape[id] = e.sec; applied++; }
      else secTries.set(id, (secTries.get(id) || 0) + 1);                        // off-enum answer = a strike
    }
    for (const t of pend.tape) if (!answered.has(t.i)) secTries.set(t.i, (secTries.get(t.i) || 0) + 1);
    if (Array.isArray(out.tickers)) for (const e of out.tickers) {
      if (!e || !e.t) continue;
      const T = String(e.t).toUpperCase();
      if (secLearned[T] || !pend.tickers.includes(T)) continue;                  // write-once, asked-only
      if (GICS_SET.has(e.sec)) { secLearned[T] = e.sec; applied++; }             // tickers never get "macro"
    }
    // relevance verdicts: write-once, asked-only, re-tags validated against the roster
    const uniSet = new Set(pend.universe || []);
    const byId = new Map(newsItems.map((a) => [String(a.id), a]));
    const relAnswered = new Set();
    if (Array.isArray(out.rel)) for (const e of out.rel) {
      if (!e || e.i == null) continue;
      const id = String(e.i);
      relAnswered.add(id);
      if (!pend.rel.some((x) => x.i === id)) continue;
      const a = byId.get(id);
      if (!a || a.rel !== 0) continue;
      if (e.v === "y") { a.rel = 1; a.relAi = 1; applied++; }
      else if (e.v === "other" && e.t && uniSet.has(String(e.t).toUpperCase())) { a.tk = String(e.t).toUpperCase(); a.rel = 1; a.relAi = 1; applied++; }
      else if (e.v === "market") { a.tk = null; a.rel = undefined; applied++; }                       // plain tape; sector classifier picks it up next pass
      else if (e.v === "off") { a.tk = null; a.rel = undefined; secTape[id] = "off-topic"; applied++; }
      else relTries.set(id, (relTries.get(id) || 0) + 1);                                            // off-enum verdict (incl. invalid re-tag) = a strike
    }
    for (const x of pend.rel) if (!relAnswered.has(x.i)) relTries.set(x.i, (relTries.get(x.i) || 0) + 1);
    // learned aliases: write-once, then re-gate pending items deterministically with them
    if (Array.isArray(out.names)) for (const e of out.names) {
      if (!e || !e.t || !Array.isArray(e.names)) continue;
      const T = String(e.t).toUpperCase();
      if (nameLearned[T] || !pend.names.includes(T)) continue;
      const clean = e.names.filter((n) => typeof n === "string" && n.trim().length >= 3).map((n) => n.trim().slice(0, 60)).slice(0, 4);
      if (clean.length) { nameLearned[T] = clean; applied++; }
    }
    applied += regatePending();
    secErr = null;
    if (applied) {
      buildNewsPayload();
      store.saveNews({ ts: Date.now(), items: newsItems, secTape, secLearned, nameLearned });
    }
    return { ok: true, applied };
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

  // ===================== macro calendar fetch (FOMC table + FRED) =====================
  // One /fred/releases pull resolves release NAMES to ids (never hardcoded integers — a FRED
  // renumbering degrades to "event absent + logged"), one /fred/releases/dates pull carries the
  // forward schedule (include_release_dates_with_no_data=true + far realtime_end is the
  // documented way to receive dates the data hasn't landed for yet), then one small
  // observations pull per stat series computes the prior/actual numbers. ~12 paced GETs per
  // refresh against a 120/min budget; Hyperliquid budget untouched. The FOMC side is the static
  // table in compute.js and serves even with no key.
  let macroCache = null, macroVer = 0, macroSig = "", lastMacroOk = 0, macroErr = null;
  let macroIds = null;                 // Map k -> FRED release id, resolved once per boot
  const macroStats = {};               // k -> { cur, prev }: the reducer at the latest obs and at the obs before it
  function macroStatFor(def, obsByS) {
    const o = (s) => obsByS[s] || [];
    if (def.stat === "yoyPair") { const a = yoyPct(o(def.series[0])), b = yoyPct(o(def.series[1]));
      return a ? { yoy: a.v, core: b ? b.v : null, m: a.m } : null; }
    if (def.stat === "jobs") { const a = momDelta(o(def.series[0])), b = lastObs(o(def.series[1]));
      return a ? { chgK: a.v, unemp: b ? b.v : null, m: a.m } : null; }
    if (def.stat === "yoyOne") { const a = yoyPct(o(def.series[0])); return a ? { yoy: a.v, m: a.m } : null; }
    if (def.stat === "momOne") { const a = momPct(o(def.series[0])); return a ? { mom: a.v, m: a.m } : null; }
    if (def.stat === "qoq") { const a = lastObs(o(def.series[0])); return a ? { qoq: a.v, m: a.m } : null; }
    return null;
  }
  function macroDressEntries(raw, now) {
    // prior = the latest published stat (labeled with its month — never claimed as consensus,
    // FRED carries no street estimates); actual = the SAME stat iff the row is released AND the
    // series' latest obs matches the print's reference period exactly. Anything else on a
    // released row is `pend` — disclosed, never a stale month dressed as the print.
    return raw.map((e) => {
      const out = Object.assign({}, e);
      if (e.k === "FOMC") {
        const s = macroStats.FOMC;
        if (s && s.cur) {
          if (macroEntryState(e, now) === "released") {
            // actual = the range once the daily target series has an obs ON/after decision day;
            // prior = the range in force going in (the current one until the print moves it).
            if (s.cur.d >= e.d) { out.actual = { lo: s.cur.lo, hi: s.cur.hi };
              out.prior = s.prev ? { lo: s.prev.lo, hi: s.prev.hi } : { lo: s.cur.lo, hi: s.cur.hi }; }
            else { out.pend = true; out.prior = { lo: s.cur.lo, hi: s.cur.hi }; }
          } else out.prior = { lo: s.cur.lo, hi: s.cur.hi };
        }
        return out;
      }
      const s = macroStats[e.k];
      if (macroEntryState(out, now) === "released") {
        const want = macroExpectedObsMonth(e.k, e.d);
        if (s && s.cur && want && s.cur.m === want) { out.actual = s.cur; if (s.prev) out.prior = s.prev; }
        else { out.pend = true; if (s && s.cur) out.prior = s.cur; }
      } else if (s && s.cur) out.prior = s.cur;
      return out;
    });
  }
  async function fetchMacro() {
    const now = Date.now();
    const key = process.env.FRED_KEY || "";
    const fget = async (path, params) => {
      const q = new URLSearchParams(Object.assign({ api_key: key, file_type: "json" }, params));
      const res = await fetch("https://api.stlouisfed.org/fred/" + path + "?" + q, {
        headers: { accept: "application/json" }, signal: AbortSignal.timeout(20000) });
      if (!res.ok) throw new Error("FRED HTTP " + res.status);
      return res.json();
    };
    let fredDates = [], err = null;
    try {
      if (key) {
        if (!macroIds || !macroIds.size) {
          macroIds = parseFredReleases(await fget("releases", { limit: 1000 }), MACRO_RELEASES);
          await sleep(150);
          const missing = MACRO_RELEASES.filter((d) => !macroIds.has(d.k)).map((d) => d.k);
          if (missing.length) log("macro: FRED release name(s) unresolved, rows absent: " + missing.join(", "));
        }
        if (macroIds && macroIds.size) {
          const idToK = new Map(); for (const [k, id] of macroIds) idToK.set(id, k);
          const dj = await fget("releases/dates", { include_release_dates_with_no_data: "true",
            realtime_start: new Date(now - 6 * DAY).toISOString().slice(0, 10),
            realtime_end: "9999-12-31", limit: 1000, sort_order: "asc" });
          fredDates = parseFredReleasesDates(dj, idToK);
          await sleep(150);
          for (const def of MACRO_RELEASES) {
            if (!macroIds.has(def.k)) continue;
            const obsByS = {};
            for (const sid of def.series) {
              obsByS[sid] = fredObsSeries(await fget("series/observations", { series_id: sid,
                observation_start: new Date(now - 480 * DAY).toISOString().slice(0, 10) }));
              await sleep(150);
            }
            const cur = macroStatFor(def, obsByS);
            const obsPrev = {}; for (const sid of def.series) obsPrev[sid] = (obsByS[sid] || []).slice(0, -1);
            const prev = macroStatFor(def, obsPrev);
            if (cur) macroStats[def.k] = { cur, prev: prev || null };
          }
          const [tl, tu] = await Promise.all([
            fget("series/observations", { series_id: "DFEDTARL", observation_start: new Date(now - 60 * DAY).toISOString().slice(0, 10) }),
            fget("series/observations", { series_id: "DFEDTARU", observation_start: new Date(now - 60 * DAY).toISOString().slice(0, 10) })]);
          const loS = fredObsSeries(tl), hiS = fredObsSeries(tu);
          const lo = lastObs(loS), hi = lastObs(hiS);
          if (lo && hi) {
            // prev = the last DISTINCT range before the current one (daily series repeats the
            // held range every day) — lets a released decision row read "held" vs "cut/hiked".
            let loP = null, hiP = null;
            for (let i = hiS.length - 2; i >= 0; i--) if (hiS[i][1] !== hi.v || (loS[i] && loS[i][1] !== lo.v)) { hiP = hiS[i][1]; loP = loS[i] ? loS[i][1] : null; break; }
            macroStats.FOMC = { cur: { lo: lo.v, hi: hi.v, d: hi.d }, prev: loP != null && hiP != null ? { lo: loP, hi: hiP } : null };
          }
        }
        // Level series (rates + claims) for the morning brief. Isolated on purpose: these are
        // additive to the brief and must never be able to cost the calendar its entries.
        try { await sleep(150); await fetchMacroLevels(fget); }
        catch (e2) { log("macro: level series unavailable (brief rate lines absent): " + (e2 && e2.message)); }
      } else err = "FRED_KEY not set";
    } catch (e) { err = (e && e.message) || "fetch failed"; }
    // The FOMC table serves regardless — a dead FRED (or no key) still puts rate decisions on
    // the calendar; only the print rows and stats degrade, with the reason on the payload.
    const entries = macroDressEntries(buildMacroEntries(fredDates, now, EARN_WINDOW_DAYS, 2), now);
    const fut = FOMC_DECISIONS.filter((f) => (earnDayDiff(f.d, now) || -1) >= 0).length;
    if (fut < 2) log("macro: FOMC table nearly exhausted (" + fut + " future decision(s)) — extend FOMC_DECISIONS in src/compute.js from federalreserve.gov");
    const sigM = entries.map((e) => e.k + e.d + (e.actual ? "a" + JSON.stringify(e.actual) : "") + (e.pend ? "p" : "")).join(",") + "|" + (err || "");
    if (sigM !== macroSig) { macroSig = sigM; macroVer = now; }
    macroErr = err;
    if (!err) lastMacroOk = now;
    macroCache = { ts: now, dataTs: macroVer, asOf: err ? (macroCache && macroCache.asOf) : now,
      error: err, entries, kinds: 1 + (macroIds ? macroIds.size : 0) };
    if (store.saveMacro) store.saveMacro({ ts: now, entries, stats: macroStats, ids: macroIds ? [...macroIds] : [] });
    log("Macro calendar: " + entries.length + " event(s) in the window (" + (err ? "FRED: " + err + "; FOMC table only" : "FOMC + " + (macroIds ? macroIds.size : 0) + " FRED release(s)") + ")");
  }
  const macroTick = () => { fetchMacro().catch((e) => log("macro tick failed: " + (e && e.message))); };
  function loadMacroCache() {
    const data = store.loadMacro ? store.loadMacro() : null;
    if (!data || !Array.isArray(data.entries)) return false;
    Object.assign(macroStats, data.stats || {});
    if (Array.isArray(data.ids) && data.ids.length) macroIds = new Map(data.ids);
    macroVer = data.ts || Date.now();
    macroCache = { ts: Date.now(), dataTs: macroVer, asOf: data.ts || null, error: null,
      entries: data.entries, kinds: 1 + (macroIds ? macroIds.size : 0) };
    return true;
  }
  // A release instant crossed since the last good fetch means an actual is (about to be) out
  // there — refire off-cadence so the banner flips to its result strip within the half hour.
  function macroCrossed() {
    if (!macroCache || !Array.isArray(macroCache.entries)) return false;
    for (const e of macroCache.entries)
      if (!e.actual && macroEntryState(e, lastMacroOk) === "upcoming" && macroEntryState(e, Date.now()) === "released") return true;
    return false;
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
        daily: r.dailyRaw ? r.dailyRaw.map((k) => [k.t, k.c, Number.isFinite(k.h) ? k.h : null, Number.isFinite(k.v) ? k.v : null]) : null,   // h/v round-trip (-06) so a redeploy no longer strips the level columns; o/l stay unpersisted, so dailyLacksOHLC still queues the real backfill
        ph,   // downsampled 7d premium baseline, so redeploys keep the dislocation z-scores warm
      };
    }
    store.saveFeatures({ ts: Date.now(), markets });
  }

  // Persist the raw 60d hourly spine so the session analytics survive redeploys instead of blanking
  // while the workers re-fetch. Candles are stored as compact [t,o,h,l,c,v] arrays (the six fields
  // getHourly reads); the current in-memory spine is already <= 60d, so no pruning is needed here.
  async function persistHourly() {
    const cut = Date.now() - HOURLY_HISTORY_DAYS * DAY;   // enforce the retention window ON WRITE, so the
    const hourly = {};                                    // persisted file can never carry more than we reload
    for (const r of rows.values()) {
      if (r.delisted || !Array.isArray(r.hourlyRaw) || !r.hourlyRaw.length) continue;
      const packed = [];
      for (const k of r.hourlyRaw) { const t = k[0]; if (Number.isFinite(t) && t >= cut) packed.push(k); }   // spine rows are already [t,o,h,l,c,v]
      if (packed.length) hourly[r.coin] = packed;
    }
    await store.saveHourly({ ts: Date.now(), hourly });   // async NDJSON stream — no longer blocks the event loop
  }
  async function hydrateHourly() {
    const cut = Date.now() - HOURLY_HISTORY_DAYS * DAY;
    let n = 0;
    await store.streamHourly((coin, arr) => {
      if (!Array.isArray(arr) || !arr.length) return;
      const out = packHours(arr).filter((k) => k[0] >= cut);   // disk rows are packed; keep them packed (no object detour)
      if (out.length) { getRow(coin).hourlyRaw = out; n++; }
    });
    return n;
  }

  // ===== Coinalyze derivatives-context lane (crypto universe only) ==============================
  // Assembly only — the math (merge, cascade, rollup, hourly agg) is pure in compute.js, the
  // fetch client + pacing lives in hyperliquid.js, persistence in store.js. One code path: the
  // screener CASC column and the drawer panel both read what this lane computed server-side.
  const cz = crypto ? createCoinalyze({ key: process.env.COINALYZE_API_KEY || "", log }) : null;
  const czHist = new Map();      // coin -> sorted packed rows [ts, longLiqUsd, shortLiqUsd, oiUsd]
  const czCasc = new Map();      // coin -> cascade flags over the retained window (recomputed on change)
  const czRoll = new Map();      // coin -> 24h rollup {ll24, sl24, oi, doi24} — memoized on fold; the board column AND the drawer chips read THIS one object
  const czRefreshAt = new Map(); // coin -> last manual-refresh ts (server-enforced group cooldown)
  let czMap = null;              // base asset -> { sym, venue } (persisted; null until resolved)
  let czMapAt = 0, czUnmapped = [];
  let czVer = 0;                 // content clock for the /api/derivs ETag key — bumps only on real change
  let czLastOk = 0, czErr = null, czLastSweep = 0, czSweeping = false;

  function czVenueLabel(coin) {
    const m = czMap && czMap[coin];
    return m ? m.venue : null;
  }
  // Resolve base asset -> one Coinalyze perp symbol, deterministic venue preference. Persisted so
  // a boot re-spends zero budget on an unchanged universe; re-resolved when >24h old AND a live
  // main-universe name is unmapped (new listings pick up within a day without a deploy).
  async function czResolveMap(force) {
    if (!cz) return;
    if (!force && czMap && Date.now() - czMapAt < 24 * 3600 * 1000) return;
    const [exs, mkts] = await Promise.all([cz.exchanges(), cz.futureMarkets()]);
    if (!Array.isArray(exs) || !Array.isArray(mkts)) throw new Error("coinalyze market list: bad shape");
    const codeToVenue = new Map();
    for (const e of exs) if (e && e.code && e.name) codeToVenue.set(String(e.code), String(e.name));
    const rank = (venue) => {
      const i = CZ_VENUES.findIndex((v) => venue && venue.toLowerCase().includes(v.toLowerCase()));
      return i < 0 ? CZ_VENUES.length : i;
    };
    const best = new Map();   // base -> {sym, venue, r}
    for (const m of mkts) {
      if (!m || !m.is_perpetual || !m.symbol || !m.base_asset) continue;
      if (!CZ_QUOTES.has(String(m.quote_asset || ""))) continue;
      const venue = codeToVenue.get(String(m.exchange || "")) || String(m.exchange || "");
      const r = rank(venue);
      if (r >= CZ_VENUES.length) continue;   // only the named venues — a deterministic map, not "whatever exists"
      const cur = best.get(m.base_asset);
      if (!cur || r < cur.r) best.set(m.base_asset, { sym: m.symbol, venue, r });
    }
    const out = {};
    for (const [base, v] of best) out[base] = { sym: v.sym, venue: v.venue };
    czMap = out; czMapAt = Date.now();
    store.saveDerivMap({ ts: czMapAt, map: out });
    czUnmapped = mainList.filter((c) => !czMap[c]);
    log(`Coinalyze symbol map resolved: ${Object.keys(out).length} base assets, ${czUnmapped.length} of ${mainList.length} live names unmapped${czUnmapped.length ? " (" + czUnmapped.slice(0, 8).join(",") + (czUnmapped.length > 8 ? ",…" : "") + ")" : ""}`);
  }
  // Fold one batch's response pair into memory + the on-disk log. Only rows STRICTLY newer than
  // the coin's last persisted bucket are appended (the merge itself tolerates overlap).
  function czFold(coin, liqSeries, oiSeries) {
    const byTs = new Map();
    for (const p of liqSeries || []) {
      const t = (+p.t) * 1000;
      if (!Number.isFinite(t)) continue;
      byTs.set(t, [t, Number.isFinite(+p.l) ? +p.l : null, Number.isFinite(+p.s) ? +p.s : null, null]);
    }
    for (const p of oiSeries || []) {
      const t = (+p.t) * 1000;
      if (!Number.isFinite(t)) continue;
      let row = byTs.get(t);
      if (!row) { row = [t, null, null, null]; byTs.set(t, row); }
      row[3] = Number.isFinite(+p.c) ? +p.c : null;   // OI history is OHLC-per-bucket; close = end-of-bucket level
    }
    if (!byTs.size) return false;
    const prev = czHist.get(coin) || [];
    const lastPersisted = prev.length ? prev[prev.length - 1][0] : 0;
    const inc = [...byTs.values()].sort((a, b) => a[0] - b[0]);
    const { rows, changed } = czMergeHistory(prev, inc);
    if (!changed) return false;
    czHist.set(coin, rows);
    // Persist strictly-newer rows, PLUS the boundary bucket when a re-fetch grew it — the last
    // bucket of a sweep is usually still forming, and freezing its first observation on disk
    // would restore a stale boundary on reboot. loadDerivs dedupes by ts (last write wins), so
    // the occasional re-append is absorbed instead of duplicated.
    const prevLast = prev.length ? prev[prev.length - 1] : null;
    for (const r of inc) {
      if (r[0] > lastPersisted) store.insertDeriv(coin, r[0], r[1], r[2], r[3]);
      else if (r[0] === lastPersisted && prevLast &&
        (prevLast[1] !== r[1] || prevLast[2] !== r[2] || prevLast[3] !== r[3]))
        store.insertDeriv(coin, r[0], r[1], r[2], r[3]);
    }
    czCasc.set(coin, cascadeFlags(rows));
    czRoll.set(coin, derivRollup(rows, Date.now()));
    return true;
  }
  async function czFetchInto(coins) {
    const now = Date.now();
    const syms = [], symCoin = new Map();
    for (const c of coins) {
      const m = czMap && czMap[c];
      if (!m) continue;
      syms.push(m.sym); symCoin.set(m.sym, c);
    }
    if (!syms.length) return false;
    // from = the oldest last-stored bucket in this batch minus a 2-bucket overlap; seed window on first pull
    let from = now - CZ_SEED_MS;
    let newest = 0;
    for (const s of syms) {
      const h = czHist.get(symCoin.get(s));
      const last = h && h.length ? h[h.length - 1][0] : 0;
      if (last) newest = newest === 0 ? last : Math.min(newest, last);
    }
    if (newest) from = Math.max(from, newest - 2 * CZ_BUCKET);
    const [liq, oi] = await Promise.all([
      cz.liqHistory(syms, CZ_INTERVAL, from, now),
      cz.oiHistory(syms, CZ_INTERVAL, from, now),
    ]);
    const liqBy = new Map(), oiBy = new Map();
    for (const e of Array.isArray(liq) ? liq : []) if (e && e.symbol) liqBy.set(e.symbol, e.history || []);
    for (const e of Array.isArray(oi) ? oi : []) if (e && e.symbol) oiBy.set(e.symbol, e.history || []);
    let changed = false;
    for (const s of syms) {
      const c = symCoin.get(s);
      if (czFold(c, liqBy.get(s), oiBy.get(s))) changed = true;
    }
    return changed;
  }
  async function czSweep() {
    if (!cz || czSweeping) return;
    czSweeping = true;
    try {
      await czResolveMap(false);
      czUnmapped = mainList.filter((c) => !czMap[c]);
      if (czUnmapped.length && Date.now() - czMapAt > 24 * 3600 * 1000) await czResolveMap(true);
      let changed = false;
      const coins = mainList.filter((c) => czMap[c]);
      for (let i = 0; i < coins.length; i += CZ_BATCH) {
        if (await czFetchInto(coins.slice(i, i + CZ_BATCH))) changed = true;
      }
      store.flushDerivs();
      czLastOk = Date.now(); czErr = null;
      if (changed) czVer = Date.now();
    } catch (e) {
      czErr = (e && e.message) || "sweep failed";
      log("Coinalyze sweep failed (isolated): " + czErr);
    } finally {
      czSweeping = false; czLastSweep = Date.now();
    }
  }
  // Manual per-ticker refresh: same fetch path, same pacing queue (a burst can never blow the
  // rate limit — it just waits), cooldown enforced HERE per coin, shared across the group.
  async function refreshDerivs(coin) {
    if (!cz) return { ok: false, error: "coinalyze disabled (no COINALYZE_API_KEY)" };
    const r = rows.get(coin);
    if (!r || r.uni !== "main") return { ok: false, error: "not in the crypto universe" };
    if (!czMap || !czMap[coin]) return { ok: false, error: "no CEX perp mapped for this name" };
    const last = czRefreshAt.get(coin) || 0;
    const since = Date.now() - last;
    if (since < CZ_REFRESH_CD) return { ok: false, error: "cooldown", retryInMs: CZ_REFRESH_CD - since };
    czRefreshAt.set(coin, Date.now());
    try {
      const changed = await czFetchInto([coin]);
      store.flushDerivs();
      czLastOk = Date.now(); czErr = null;
      if (changed) czVer = Date.now();
      return { ok: true, changed, ts: Date.now() };
    } catch (e) {
      return { ok: false, error: (e && e.message) || "refresh failed" };
    }
  }
  // Latest cascade within 24h for the screener column — computed here, read by mapMarket, so the
  // board and the drawer can never disagree on whether/when a cascade fired.
  function czCascLatest(coin) {
    const flags = czCasc.get(coin);
    if (!flags || !flags.length) return null;
    const f = flags[flags.length - 1];
    if (Date.now() - f.t > 24 * 3600 * 1000) return null;
    return f;
  }
  function getDerivs(coin) {
    const base = { coin: coin || "", ts: Date.now(), src: "coinalyze", ver: czVer,
      enabled: !!cz, interval: CZ_INTERVAL, refreshCdMs: CZ_REFRESH_CD };
    if (!cz) return { ...base, error: "disabled (no COINALYZE_API_KEY on the server)" };
    const r = coin ? rows.get(coin) : null;
    if (!r || r.uni !== "main") return { ...base, error: "not in the crypto universe" };
    if (!czMap || !czMap[coin]) return { ...base, error: "no CEX perp mapped for this name", asOf: czLastOk || null };
    const hist = czHist.get(coin) || [];
    const cut = Date.now() - 48 * 3600 * 1000;
    const hours = aggDerivHourly(hist.filter((x) => x[0] >= cut));
    const casc = (czCasc.get(coin) || []).filter((f) => f.t >= cut);
    const cdLeft = Math.max(0, CZ_REFRESH_CD - (Date.now() - (czRefreshAt.get(coin) || 0)));
    return { ...base, venue: czVenueLabel(coin), asOf: czLastOk || null,
      staleMs: czLastOk ? Date.now() - czLastOk : null, error: czErr,
      roll: czRoll.get(coin) || null, hours, casc, cascLast: czCascLatest(coin),
      coverageMs: hist.length ? Date.now() - hist[0][0] : 0, refreshInMs: cdLeft };
  }
  function czBoot() {
    if (!cz) { log("Coinalyze deriv context: disabled (no COINALYZE_API_KEY)"); return; }
    const saved = store.loadDerivMap();
    if (saved && saved.map) { czMap = saved.map; czMapAt = saved.ts || 0; }
    const loaded = store.loadDerivs(Date.now() - CZ_RETENTION);
    for (const [c, arr] of loaded) { czHist.set(c, arr); czCasc.set(c, cascadeFlags(arr)); czRoll.set(c, derivRollup(arr, Date.now())); }
    if (loaded.size) czVer = Date.now();
    log(`Coinalyze deriv context: ENABLED — restored ${loaded.size} market(s) of accumulated 15-min history${czMap ? `, symbol map warm (${Object.keys(czMap).length} bases)` : ""}`);
    setTimeout(() => { czSweep(); }, 90 * 1000);   // first sweep after universe warmup, off the boot path
    setInterval(() => { if (Date.now() - czLastSweep >= CZ_SWEEP_MS) czSweep(); }, 60 * 1000);
  }

  async function maintenance() {
    try {
      const isMain = (coin) => !coin.includes(":");
      const n = await store.prune(Date.now() - OI_RETENTION, Date.now() - OI_FULL_RES, isMain, Date.now() - MAIN_HIST_DAYS * DAY);
      if (n) log(`OI retention pass: ${n} sample(s) dropped/thinned (xyz: full 31d + hourly to 365d; crypto: flat 31d)`);
      if (cz) {
        const dn = await store.pruneDerivs(Date.now() - CZ_RETENTION);
        if (dn) log(`Deriv-context retention pass: ${dn} row(s) dropped (flat ${Math.round(CZ_RETENTION / DAY)}d at 15min)`);
        const dcut = Date.now() - CZ_RETENTION;
        for (const [c, arr] of czHist) {
          if (!arr.length || arr[0][0] >= dcut) continue;
          const i = arr.findIndex((k) => k[0] >= dcut);
          const kept = i > 0 ? arr.slice(i) : (i === 0 ? arr : []);
          czHist.set(c, kept);
          czCasc.set(c, cascadeFlags(kept));
          czRoll.set(c, derivRollup(kept, Date.now()));
        }
      }
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
    // 5m archive retention: single DELETE past the 370d line. One resolution, so there's no rollup
    // and no boundary bucket to protect — just drop what aged out.
    if (store.candlesEnabled && store.candlesEnabled()) {
      try {
        const dropped = store.evictCandles(Date.now() - M5_RETENTION_DAYS * DAY);
        const kept = store.candleCount ? store.candleCount() : 0;
        log(`5m archive: ${kept} bar(s) retained, ${dropped} evicted past ${M5_RETENTION_DAYS}d`);
      } catch (e) { log("5m evict failed: " + (e && e.message)); }
      // 1m opening-hour archive: 30d is plenty — its only consumers are today's forming reads and
      // the chart's opening-hour base for lists still on the board.
      try {
        const d1 = store.evictCandles1m ? store.evictCandles1m(Date.now() - M1_RETENTION_DAYS * DAY) : 0;
        if (d1) log(`1m opening-hour archive: ${d1} bar(s) evicted past ${M1_RETENTION_DAYS}d`);
      } catch (e) { log("1m evict failed: " + (e && e.message)); }
    }
    // Heavy-data GC for markets delisted > 7d. They stay in Hyperliquid's meta forever (so the
    // row itself must survive to keep the universe index-aligned for the WS feed), but there's
    // no reason to keep holding their 60d hourly spine, funding map and OI history in memory.
    const dcut = Date.now() - 7 * DAY;
    let swept = 0;
    for (const [coin, r] of rows) {
      if (!r.delisted || !r.delistedAt || r.delistedAt >= dcut) continue;
      if (r.hourlyRaw || r.dailyRaw || (r.fundH && r.fundH.size) || hist.has(coin)) {
        r.hourlyRaw = null; r.dailyRaw = null; r.ref = null; r.feat = null;
        if (r.fundH) { r.fundH.clear(); r._fVer = (r._fVer || 0) + 1; }
        hist.delete(coin);
        swept++;
      }
    }
    if (swept) log(`Freed cached history for ${swept} market(s) delisted > 7d`);
    const total = activeMarkets().filter((r) => !r.delisted).length;
    const pending = activeMarkets().filter((r) => !r.delisted && !r.dailyRaw).length;
    const hc = hourlyCoverage();
    const fcut = Date.now() - FUNDING_HISTORY_DAYS * DAY;
    for (const r of rows.values()) if (r.fundH && r.fundH.size) { let d = false; for (const t of r.fundH.keys()) if (t < fcut) { r.fundH.delete(t); d = true; } if (d) r._fVer = (r._fVer || 0) + 1; }
    const fc = fundingCoverage();
    log(`Daily audit: ${total} active market(s), ${pending} awaiting history backfill; hourly spine: ${hc.coins} market(s), ${hc.candles} candle(s); funding[${fc.endpoint}]: ${fc.coins} market(s), ${fc.points} hour(s)`);
  }

  async function start() {
    // Isolation helper, hoisted to the top of start() so the critical rebuild loops can be armed
    // before anything that might throw. Since 2026.07.29-08 it is also the instrumentation choke
    // point: every scheduled tick runs through timedTick (durations named on /api/health — the
    // "which build was the 2.5s stall" question answered from the tray), and any ASYNC build is
    // routed onto the serialized build chain instead of being invoked bare, so yielding builds can
    // never interleave with each other. Detection by constructor keeps every pinned call-site
    // string byte-identical while changing what happens underneath.
    const safeTick = (fn, name) => () => {
      try {
        const r = isAsyncFn(fn) ? chainBuild(name, fn) : timedTick(name, fn);
        if (r && typeof r.catch === "function") r.catch((e) => log(name + " failed (isolated, server stays up): " + (e && e.message)));
      } catch (e) { log(name + " failed (isolated, server stays up): " + (e && e.message)); }
    };
    // ---- ARM THE ANALYTICS REBUILD LOOP FIRST -------------------------------------------------
    // This used to be registered ~90 lines down, after the universe poll, the WebSocket, the
    // workers and the sqlite probe. start() is invoked as poller.start().catch(log), so ANY throw
    // in that stretch silently skipped the registration: the analytics cache stayed null forever,
    // /api/analytics served its empty fallback, and BOTH sessions tabs sat on "warming up the
    // spines" with no error to show — no retry would ever come. Arming it here means the loop
    // exists no matter what else on the boot path fails, so the tab always self-heals.
    setInterval(safeTick(() => { buildAnalyticsSafe("stocks"); if (crypto) buildAnalyticsSafe("crypto"); }, "buildAnalytics"), ANALYTICS_MS);
    // FOCUS stamp/fill loop — armed with the analytics loop for the same reason it sits this
    // early: it must exist even if a later boot step throws, or the day's list would silently
    // never stamp. A boot after 09:30 stamps on the first tick with the disclosed `late` flag.
    setInterval(safeTick(() => focusTick(), "focusTick"), 30 * 1000);
    if (hydrateFocus()) log(`Restored FOCUS list${focusState ? `: ${focusState.rows.length} seat(s) for ${focusState.day}${focusState.filledAt ? " (+1h filled)" : ""}` : " (prior day only)"} — the day's stamp survives a redeploy`);
    // 13F whale lane: hydrate the watchlist + cached books, then a due-check tick. The tick is
    // isolated like the sector audit — a sec.gov outage must never take the poller loop with it —
    // and per-fund cadence gates inside whaleTick keep the EDGAR load at watchlist-scale.
    whaleHydrate();
    if (whaleState.watch.length) log(`Restored 13F watchlist: ${whaleState.watch.length} fund(s), ${Object.keys(whaleState.filings).length} with cached books — FUNDS tab warm`);
    setInterval(() => { whaleTick().catch((e) => log("whale tick failed (isolated, server stays up): " + (e && e.message))); }, WHALE_POLL_MS);
    setInterval(() => { whale13fTick().catch((e) => log("whale13f tick failed (isolated): " + (e && e.message))); }, 6 * HOUR);
    setTimeout(() => { whale13fTick().catch(() => {}); }, 90 * 1000);
    setInterval(() => { congressTick().catch((e) => log("congress tick failed (isolated): " + (e && e.message))); }, 6 * HOUR);
    setTimeout(() => { congressTick().catch(() => {}); }, 120 * 1000);
    setTimeout(() => { whaleTick().catch((e) => log("whale first tick failed (isolated): " + (e && e.message))); }, 20 * 1000);
    const restored = hydrateFeatures();
    if (restored) log(`Restored cached features for ${restored} market(s) — serving warm`);
    hydrateLedger();
    log(`Restored signal ledger: ${ledgerOpen.size} open, ${ledgerClosed.length} resolved — track record carries across this deploy`);
    const restoredHourly = await hydrateHourly();
    if (restoredHourly) log(`Restored hourly spine for ${restoredHourly} market(s) — session analytics warm`);
    if (hydrateEarnings()) log(`Restored earnings calendar: ${earnCache.entries.length} report(s) — badges warm while Finnhub refreshes`);
    { const n = hydrateNews(); if (n) log(`Restored news feed: ${n} headline(s) — tab warm while the rotation catches up`); }
    { const n = hydrateFund(); if (n) log(`Restored fundamentals: ${n} name(s) cached — drawer panel warm while the rotation refreshes`); }
    // Announced-trigger set: without this a redeploy re-announces the whole live board.
    if (hydrateTriggers()) log(`Restored trigger state: ${trigSeen.size} announced setup(s), seq ${trigSeq}`);
    // ---- alert detection + transports -----------------------------------------------------------
    // DETECTION is armed unconditionally; only DELIVERY is gated on a configured bot. Slice A got
    // this wrong: the level scan and the health watchdog sat inside the token check, which meant a
    // deploy without TG_BOT_TOKEN produced no ops events and no death notices for the browser
    // consumer either — a transport's configuration silently deciding what the canonical stream
    // was allowed to contain. The stream is transport-agnostic by design; this restores that.
    pushBootAt = Date.now();
    // QUIET by construction. Railway redeploys on every pushed file, so a build delivered in four
    // or five uploads produced four or five identical notifications. The line still enters the
    // ring — it is what explains a reset cursor or a run of bt:1 claims when reading the log back
    // — but it never reaches a phone. The wire proves itself through the stall watchdog and the
    // test-fire button instead, neither of which fires on a routine deploy.
    pushOps("deploy", `build ${version || "dev"} is live`, "info", true);
    setInterval(safeTick(pushHealthTick, "pushHealthTick"), 60 * 1000);
    setInterval(safeTick(levelScan, "levelScan"), LVL_SCAN_MS);
    { const n = hydrateRules(); if (n) log(`Restored ${n} alert rule(s) — edge state restored too, so a redeploy re-announces nothing already in breach`); }
    // Chained to the snapshot cadence rather than given its own timer: the rules read the snapshot
    // payload, so evaluating on any other clock would mean judging a number the board isn't showing.
    setInterval(safeTick(ruleScan, "ruleScan"), 15 * 1000);
    setInterval(safeTick(earnScan, "earnScan"), 60 * 60 * 1000);
    // Weekly classification audit: hourly due-check, fires Sundays >= 12:00 UTC once per ISO week.
    // Isolated like briefTick — an audit failure must never take the poller loop with it.
    setInterval(() => { sectorAuditTick().catch((e) => log("sector audit failed (isolated, server stays up): " + (e && e.message))); }, SECTOR_AUDIT_TICK_MS);
    // The calendar lanes. Macro runs every 5 min because the imminent leg is a 60-minute window
    // against an 08:30/14:00 ET clock — an hourly scan would miss it as often as it caught it.
    // The first pass is deliberately early (the warm macro cache is already on disk by then) so a
    // cold boot seeds against a populated window rather than an empty one.
    setTimeout(safeTick(macroScan, "macroScan"), 90 * 1000);
    setInterval(safeTick(macroScan, "macroScan"), 5 * 60 * 1000);
    // The preview is a once-per-ET-day decision; 10 min is enough resolution for a 17:00 gate and
    // keeps the scan off the hot path.
    setInterval(safeTick(earnPreviewScan, "earnPreviewScan"), 10 * 60 * 1000);
    setInterval(safeTick(regimeScan, "regimeScan"), 15 * 60 * 1000);
    setInterval(safeTick(trendScan, "trendScan"), 5 * 60 * 1000);
    // One full pass seeds every name's state before anything may fire — otherwise the first scan
    // after a deploy announces every 4/4 stack on the board as if it had just arrived.
    setTimeout(() => { try { trendScan(); } catch (_) {} trendPrimed = true; log("trend alerts primed"); }, 6 * 60 * 1000);
    setInterval(safeTick(ma200Scan, "ma200Scan"), 5 * 60 * 1000);
    // Same silent first look for the 200 lane: any event bar already standing at boot is seeded.
    setTimeout(() => { try { ma200Scan(); } catch (_) {} maPrimed = true; log("ma200 alerts primed"); }, 6 * 60 * 1000);
    setInterval(safeTick(coverageScan, "coverageScan"), 10 * 60 * 1000);
    // Brief delivery runs on a 5-minute cadence: the hour match is exact, so a coarser tick would
    // miss a recipient whose hour opened and closed between polls.
    setInterval(() => { briefTick().catch((e) => log("briefTick failed (isolated, server stays up): " + (e && e.message))); }, 5 * 60 * 1000);
    // Sibling schedule, sibling isolation: a failing commentary generation must never take the
    // brief down with it, so the two ticks are separate timers with separate catches.
    setInterval(() => { landTick().catch((e) => log("landTick failed (isolated, server stays up): " + (e && e.message))); }, 5 * 60 * 1000);
    // The EDGAR rotation covers 2 names a minute, so a full roster pass takes ~40 minutes. Priming
    // only after that means the 7-day backlog every name carries is seeded silently instead of
    // arriving as a wall of notifications on the first deploy of the day.
    setTimeout(() => { filingPrimed = true; log("filing alerts primed — the EDGAR backlog has been seeded silently"); }, 45 * 60 * 1000);
    // Fully dormant without a token: no outbound timers, no writes, no noise. Same one-variable
    // rollback discipline as CRYPTO=0 — unset TG_BOT_TOKEN and the transport is simply not there.
    if (pushOn()) {
      const linked = hydratePush();
      log(`Telegram push: ENABLED — ${linked} linked recipient(s), stream cursor at seq ${trigSeq}` +
        (PUBLIC_URL() ? `, deep links to ${PUBLIC_URL()}` : ", no PUBLIC_URL set (messages carry no deep link)"));
      setInterval(() => { pushUpdatesTick().catch((e) => log("push updates failed (isolated): " + (e && e.message))); }, PUSH_UPDATES_MS);
      setInterval(() => { pushDrain().catch((e) => log("push drain failed (isolated): " + (e && e.message))); }, PUSH_DRAIN_MS);
      setInterval(safeTick(pushStreamTick, "pushStreamTick"), 5 * 1000);
    } else {
      log("Telegram push: disabled (no TG_BOT_TOKEN) — detection still runs; events reach the in-app bell log");
    }
    log(`AI reports: ${AI_KEY() ? "ENABLED" : "disabled (no ANTHROPIC_API_KEY / OPENAI_API_KEY)"} — provider ${AI_PROVIDER}, model ${AI_MODEL} (fallback ${AI_MODEL_FALLBACK}), classifier ${AI_CLASSIFY_MODEL}, TTL ${Math.round(AI_TTL_MS / 60000)} min, ${aiReports.size} cached report(s) restored`);
    if (crypto) czBoot();
    hydrateDuel();
    if (duel.ic.length) log(`Restored score duel: ${duel.ic.length} IC day(s) — the MOM vs MOM+ record carries across this deploy`);
    await pollUniverse();
    seedFundingFromOI();
    buildSnapshot(); buildDaily();
    // Isolate each universe's boot build: a throw here used to abort the rest of start() — including
    // the analytics rebuild interval registered further down — so one bad build left BOTH tabs stuck
    // on "warming up the spines" forever with no retry. Now a failure is logged and the interval still
    // registers, so the next cycle rebuilds. (-17: the crypto build added a second failure surface.)
    buildAnalyticsSafe("stocks"); if (crypto) buildAnalyticsSafe("crypto");   // records the reason on failure; never throws
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
    // 5m archive: one capture lane + a daily off-copy snapshot. Enabled only when node:sqlite
    // loaded (Node >= 22.5 with --experimental-sqlite); otherwise the worker idles and the feature
    // is simply absent, exactly like a missing external token elsewhere.
    if (store.candlesEnabled && store.candlesEnabled()) {
      fiveMinWorker();
      // The FOCUS seats' own lane (2026.08.18-04). Separate worker on purpose: it must not queue
      // behind the shared round-robin, which is the entire reason it exists.
      oneMinWorker();
      // Deep 12h/1d lane (2026.08.21-01): seeds backward to each listing's birth, then trickles
      // forward. Rides the daily VACUUM-INTO snapshot below for free — one db, one off-copy.
      deepWorker();
      const snap = () => { try { if (store.snapshotCandles()) log("5m archive: off-copy snapshot written (candles.db.bak)"); } catch (_) {} };
      setInterval(snap, M5_SNAPSHOT_MS);
      setTimeout(snap, 10 * 60 * 1000);
      log(`5m archive: ENABLED (node:sqlite) — capturing closed 5m bars, ${M5_RETENTION_DAYS}d retention, ${store.candleCount ? store.candleCount() : 0} bar(s) on disk`);
    } else {
      log("5m archive: disabled (node:sqlite unavailable — needs Node >= 22.5 with --experimental-sqlite)");
    }
    // Timed + isolated since -08: these two were the only scheduled ticks outside safeTick, which
    // meant (a) a throw in either would take the process down and (b) they were invisible to the
    // tick stats. Same cadence, same functions — they just report in now like everything else.
    setInterval(safeTick(buildSnapshot, "buildSnapshot"), 15 * 1000);
    setInterval(safeTick(buildDaily, "buildDaily"), 60 * 1000);
    setInterval(safeTick(buildSignals, "buildSignals"), 10 * 60 * 1000);
    // Trigger detection follows the signals build on the same cadence, offset so it reads a
    // settled ledger. Isolated: a board error must never take the signal engine down with it.
    setInterval(safeTick(buildActionable, "buildActionable"), 10 * 60 * 1000);
    setTimeout(safeTick(buildActionable, "buildActionable"), 75 * 1000);
    // Warm-boot cadence: spines aren't persisted raw, so every deploy re-warms ~150 markets
    // through the rate-limited workers (~3-5 min). On the steady 10-min cadence each market
    // then waited up to 10 MORE minutes for the next build to admit it — post-deploy the tab
    // looked empty long after the data was ready. For the first 20 minutes, build every 2
    // minutes (episode gates + the bt boot stamp make extra builds idempotent and honest),
    // with a first partial pass at 45s so the tab is never blank longer than the snapshot.
    {
      const bootT = Date.now();
      setTimeout(safeTick(buildSignals, "buildSignals"), 45 * 1000);
      const earlyIv = setInterval(() => {
        safeTick(buildSignals, "buildSignals")();
        const w = [...rows.values()].filter((r) => !r.delisted && r.hourlyRaw && r.hourlyRaw.length).length;
        log(`signals warm-boot build: ${w} market(s) spine-warm`);
        if (Date.now() - bootT > 20 * 60 * 1000) clearInterval(earlyIv);
      }, 2 * 60 * 1000);
    }
    // News feed: a few company names per minute (rotation ordered by staleness) + the macro
    // tape every 15 min. Same degradation contract as earnings — token missing or endpoint
    // dead surfaces on the payload, never breaks a tab.
    setInterval(() => { newsCompanyTick().catch((e) => log("news tick failed (isolated): " + (e && e.message))); }, 60 * 1000);
    setInterval(() => { newsTapeTick().catch((e) => log("news tape failed (isolated): " + (e && e.message))); }, 15 * 60 * 1000);
    setInterval(() => { fundTick().catch((e) => log("fundamentals tick failed (isolated): " + (e && e.message))); }, 60 * 1000);
    setTimeout(() => { fundTick().catch(() => {}); }, 50 * 1000);
    setTimeout(() => { newsTapeTick().catch(() => {}); }, 20 * 1000);
    setTimeout(() => { newsCompanyTick().catch(() => {}); }, 40 * 1000);
    // Sector classifier: batched, write-once, fallback-model, ~a cent a day at current volume.
    setInterval(() => { classifySecTick().catch((e) => log("sector classify failed (isolated): " + (e && e.message))); }, 10 * 60 * 1000);
    setTimeout(() => { classifySecTick().catch(() => {}); }, 90 * 1000);
    setInterval(() => { tgTick().catch((e) => log("telegram tick failed (isolated): " + (e && e.message))); }, 10 * 60 * 1000);
    setTimeout(() => { tgTick().catch(() => {}); }, 30 * 1000);
    setInterval(() => { edgarTick().catch((e) => log("edgar tick failed (isolated): " + (e && e.message))); }, 60 * 1000);
    setTimeout(() => { edgarTick().catch(() => {}); }, 50 * 1000);
    log("EDGAR filings feed: 2 names/min rotation, 7d retention, own lane");
    log(`Telegram feed: ${tgChannels.length ? tgChannels.length + " channel(s) configured" : "no channels configured (add via the News tab \u2699)"}`);
    log(process.env.FINNHUB_TOKEN ? `News feed: ENABLED — ${NEWS_BATCH} names/min rotation + macro tape/15min, 72h retention` : "News feed: disabled (FINNHUB_TOKEN not set)");
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
    // (the analytics rebuild interval is armed at the top of start() — see the note there)
    // Duel snapshot: cheap one-key guard per attempt; a boot mid-day retries every minute until
    // enough features are warm to snap, then idles until the next UTC midnight.
    setInterval(safeTick(duelTick, "duelTick"), 60 * 1000);
    setTimeout(safeTick(duelTick, "duelTick"), 45 * 1000);
    setInterval(() => store.flush(), 30 * 1000);
    setInterval(persistFeatures, 120 * 1000);
    setInterval(() => { persistHourly().catch((e) => log("hourly persist failed (isolated): " + (e && e.message))); }, HOURLY_PERSIST_MS);
    setTimeout(() => { persistHourly().catch((e) => log("hourly persist failed (isolated): " + (e && e.message))); }, 90 * 1000);   // early snapshot so even a quick redeploy keeps the spine warm
    setInterval(maintenance, 24 * 3600 * 1000);
    setTimeout(maintenance, 60 * 1000);
    // Earnings: first pull shortly after the universe reconciles; then one staleness check every
    // 30 min re-fires only when the last GOOD fetch is > 6h old — so a failed pull retries in
    // 30 min while a healthy one refreshes 4x/day. One HTTP GET each time; zero HL rate budget.
    setTimeout(earnTick, 20 * 1000);
    setInterval(() => { if (Date.now() - lastEarnOk > EARN_STALE) earnTick(); }, EARN_RETRY_MS);
    // Macro: warm-boot from /data, first live pull shortly after boot, then the 6h staleness
    // check — which ALSO refires when a release instant crossed since the last good fetch, so
    // an 8:30 print's actual reaches the tab within ~30 min instead of waiting out the 6h.
    try { loadMacroCache(); } catch (_) {}
    setTimeout(macroTick, 25 * 1000);
    setInterval(() => { if (Date.now() - lastMacroOk > MACRO_STALE || macroCrossed()) macroTick(); }, MACRO_RETRY_MS);
    // Housing board: warm-boot from /data, first pull after the macro burst (FRED rate discipline),
    // then the same 6h-stale / 30min-check cadence — the series move weekly at best.
    try { loadHousingCache(); } catch (_) {}
    setTimeout(housingTick, 35 * 1000);
    setInterval(() => { if (Date.now() - lastHousingOk > HOUSING_STALE) housingTick(); }, HOUSING_RETRY_MS);
    // Liquidity board: warm-boot, first pull after the housing burst, then refire on staleness OR
    // when the Thursday H.4.1 release instant crossed since the last good fetch.
    try { loadLiquidityCache(); } catch (_) {}
    setTimeout(liqTick, 45 * 1000);
    setInterval(() => { if (Date.now() - lastLiqOk > LIQ_STALE || liqReleaseCrossed()) liqTick(); }, LIQ_RETRY_MS);
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

  // Per-market 5-minute OHLCV from the on-disk archive: [[t,o,h,l,c,v], ...] over [from,to],
  // quantized like the hourly candle payload. A wide window is downsampled SERVER-SIDE (never ship
  // or scan a raw 370d @ 5m series to a browser): rows past ~maxPoints are aggregated to the
  // smallest 5-min multiple that fits, via the SAME bucketCandles the trend rungs use — so a
  // coarsened bar is an honest OHLC of its constituents (o=first, h=max, l=min, c=last, v=sum),
  // not a decimated sample. Coverage rides along so the drawer can state real archive depth.
  function getCandles5m(coin, from, to, maxPoints) {
    if (!store.candlesEnabled || !store.candlesEnabled()) return { coin, res: "5m", enabled: false, candles: [], coverage: { enabled: false } };
    const now = Date.now();
    let hi = Number.isFinite(+to) ? +to : now;
    let lo = Number.isFinite(+from) ? +from : hi - 30 * DAY;
    if (lo > hi) { const t = lo; lo = hi; hi = t; }
    // BASE SPLICE (build 2026.08.18-04). Where the 1m opening-hour archive covers a span, it is
    // AUTHORITATIVE and the overlapping 5m rows are dropped rather than merged — the two archives
    // hold the same trades, so folding both in would double every volume in the window and put a
    // VWAP out by however much the overlap weighed. 09:30 is a clean 5-minute boundary, so the
    // seam is exact and no bucket ever straddles it. The 1m bars are then rolled UP to the 5m grid
    // here, in one place: the client keeps aggregating from a single 5m base and never learns
    // there are two archives, which is what stops the chart and the board disagreeing.
    let rows5 = store.readCandles(coin, lo, hi);
    const win = m1Window(coin, lo, hi);
    if (win) {
      const raw1 = store.readCandles1m(coin, win.from, win.to);
      if (raw1.length) {
        const rolled = bucketCandles(raw1, 5, 60000).map((b) => [b.t, b.o, b.h, b.l, b.c, b.v]);
        rows5 = rows5.filter((k) => k[0] < win.from || k[0] > win.to).concat(rolled).sort((a, b) => a[0] - b[0]);
      }
    }
    const cap = Math.max(200, Math.min(6000, Number(maxPoints) || 3000));
    let out = rows5;
    if (rows5.length > cap) {
      // 5-min units per coarsened bar. (len-1)/(cap-1) rather than len/cap so that boundary
      // alignment (buckets are floored on absolute time, so the first/last can be partial) can
      // never push the result to cap+1 — the count stays <= cap.
      const mult = Math.ceil((rows5.length - 1) / (cap - 1));
      out = bucketCandles(rows5, mult, FIVE_MIN).map((b) => [b.t, b.o, b.h, b.l, b.c, b.v]);
    }
    const q = [];
    for (const k of out) q.push([k[0], sig(k[1], 9), sig(k[2], 9), sig(k[3], 9), sig(k[4], 9), rnd(k[5], 2)]);
    const cov = store.candleCoverage(coin);
    return { coin, res: "5m", enabled: true, from: lo, to: hi,
      coverage: { min: cov.min, max: cov.max, count: cov.count, days: cov.min && cov.max ? +((cov.max - cov.min) / DAY).toFixed(1) : 0 },
      candles: q };
  }
  // Which span of a chart request the 1m archive owns for this coin: today's stamped first hour
  // (and yesterday's, while that list is still readable behind the toggle), clipped to the request.
  // Derived from the RECORDS' own open times rather than a recomputed session clock — one producer
  // of "when was the first hour", shared by the lane, the fill and the chart.
  function m1Window(coin, lo, hi) {
    if (!store.readCandles1m) return null;
    const spans = [];
    for (const st of [focusState, focusPrev]) {
      if (!st || !st.open || !Array.isArray(st.rows)) continue;
      if (!st.rows.some((p) => p.coin === coin)) continue;
      spans.push([st.open, st.open + HOUR]);
    }
    if (!spans.length) return null;
    const from = Math.max(lo, Math.min(...spans.map((s) => s[0])));
    const to = Math.min(hi, Math.max(...spans.map((s) => s[1])));
    return to > from ? { from, to } : null;
  }
  function getCandleCoverage(coin) {
    if (!store.candlesEnabled || !store.candlesEnabled()) return { enabled: false };
    const cov = store.candleCoverage(coin);
    return { enabled: true, min: cov.min, max: cov.max, count: cov.count,
      days: cov.min && cov.max ? +((cov.max - cov.min) / DAY).toFixed(1) : 0 };
  }
  // Deep 12h/1d reads for the CHARTS tab (build 2026.08.21-01): [[t,o,h,l,c,v], ...] over
  // [from,to], quantized like every other candle payload, coverage riding along so a young
  // listing's 90 bars are DISCLOSED as 90 bars rather than dressed as a decade. Downsampling
  // mirrors getCandles5m (bucketCandles at the interval's own width unit, honest OHLC roll-up) —
  // at <=5000 native bars it rarely triggers, but a cap the client can trust must still hold.
  // Unknown intervals return null so the route can 404-shape rather than guess a series.
  function getCandlesDeep(coin, iv, from, to, maxPoints) {
    const w = DEEP_IVS[iv];
    if (!w) return null;
    if (!store.candlesEnabled || !store.candlesEnabled() || !store.readCandlesDeep)
      return { coin, res: iv, enabled: false, candles: [], coverage: { enabled: false } };
    const now = Date.now();
    let hi = Number.isFinite(+to) ? +to : now;
    let lo = Number.isFinite(+from) ? +from : hi - DEEP_SEED_BARS * w;
    if (lo > hi) { const t = lo; lo = hi; hi = t; }
    const rowsD = store.readCandlesDeep(iv, coin, lo, hi);
    const cap = Math.max(200, Math.min(6000, Number(maxPoints) || 3000));
    let out = rowsD;
    if (rowsD.length > cap) {
      const mult = Math.ceil((rowsD.length - 1) / (cap - 1));
      out = bucketCandles(rowsD, mult, w).map((b) => [b.t, b.o, b.h, b.l, b.c, b.v]);
    }
    const q = [];
    for (const k of out) q.push([k[0], sig(k[1], 9), sig(k[2], 9), sig(k[3], 9), sig(k[4], 9), rnd(k[5], 2)]);
    const cov = store.candleCoverageDeep(iv, coin);
    return { coin, res: iv, enabled: true, from: lo, to: hi,
      coverage: { min: cov.min, max: cov.max, count: cov.count, days: cov.min && cov.max ? +((cov.max - cov.min) / DAY).toFixed(1) : 0 },
      candles: q };
  }

  // ---- crypto intraday correlation matrix (Correlation tab, crypto scope) ----------------------
  // The equities correlation tab runs client-side on daily closes; crypto keeps only ~31d of daily
  // history but 370d of 5-minute bars, so its matrix is built HERE, over intraday returns, at the
  // window the client asks for. Base bar per window keeps every window in a healthy sample band:
  // 4h -> 5m (~48 bars), 1d -> 15m (~96), 7d -> 1h (~168). One small payload carries the matrix AND
  // the per-name close series (on a shared grid) so the pair view and COMP/G reproduce the exact
  // numbers the matrix was built from — one source of truth, no second fetch. Memoized per window
  // with a 60s floor and an archive-stamp key; degrades honestly to enabled:false with no archive.
  const CRYPTO_CORR_WINS = { "4h": { ms: 4 * HOUR, bar: FIVE_MIN }, "1d": { ms: DAY, bar: 15 * 60000 }, "7d": { ms: 7 * DAY, bar: HOUR } };
  const cryptoCorrMemo = new Map();
  const CRYPTO_CORR_TTL = 60 * 1000;
  function cryptoCorrUniverse() {
    return [...rows.values()].filter((r) => r.uni === "main" && !r.delisted && r.px != null && r.vol != null)
      .sort((a, b) => (b.vol || 0) - (a.vol || 0)).slice(0, 60);
  }
  function cryptoCorrWin(win) { return CRYPTO_CORR_WINS[win] ? win : "1d"; }
  function getCryptoCorrStamp(win) {
    win = cryptoCorrWin(win); const w = CRYPTO_CORR_WINS[win];
    // fresh bar -> fresh key (bar-floored now), plus universe size so a listing change re-mints
    return "cx:" + win + ":" + Math.floor(Date.now() / w.bar) + ":" + cryptoCorrUniverse().length;
  }
  function buildCryptoCorr(win) {
    win = cryptoCorrWin(win); const w = CRYPTO_CORR_WINS[win], stamp = getCryptoCorrStamp(win);
    if (!store.candlesEnabled || !store.candlesEnabled())
      return { win, enabled: false, bar: w.bar, times: [], coins: [], C: [], N: [], minOv: 0, stamp,
        reason: "5m archive disabled (needs node:sqlite / Node >= 22.5)" };
    const now = Date.now(), from = now - w.ms - w.bar, mult = Math.max(1, Math.round(w.bar / FIVE_MIN));
    const uni = cryptoCorrUniverse();
    const gridStart = Math.floor((now - w.ms) / w.bar) * w.bar, times = [];
    for (let t = gridStart; t <= now; t += w.bar) times.push(t);
    const gi = new Map(times.map((t, i) => [t, i]));
    const coins = [], retList = [];
    for (const r of uni) {
      const raw = store.readCandles(r.coin, from, now);   // packed 5m [t,o,h,l,c,v]
      const bars = mult > 1 ? bucketCandles(raw, mult, FIVE_MIN)
        : raw.map((k) => ({ t: k[0], c: k[4] }));
      const closes = new Array(times.length).fill(null);
      for (const b of bars) { const idx = gi.get(Math.floor(b.t / w.bar) * w.bar); if (idx != null && b.c != null) closes[idx] = b.c; }
      const ret = new Array(times.length).fill(null);
      let prev = null, prevI = -2;
      for (let i = 0; i < times.length; i++) { const c = closes[i];
        if (c != null && c > 0) { if (prev != null && i === prevI + 1) ret[i] = Math.log(c / prev); prev = c; prevI = i; } }
      coins.push({ tk: r.ticker, coin: r.coin, closes: closes.map((c) => (c == null ? null : sig(c, 9))),
        cov: closes.reduce((a, c) => a + (c != null ? 1 : 0), 0) });
      retList.push(ret);
    }
    const minOv = Math.max(20, Math.floor(times.length * 0.5));
    const { C, N } = corrMatrix(retList, minOv);
    const Cr = C.map((row) => row.map((v) => (v == null ? null : +v.toFixed(4))));
    return { win, enabled: true, bar: w.bar, gridLen: times.length, minOv, times, coins, C: Cr, N, stamp };
  }
  function getCryptoCorr(win) {
    win = cryptoCorrWin(win); const stamp = getCryptoCorrStamp(win), m = cryptoCorrMemo.get(win), now = Date.now();
    if (m && m.stamp === stamp && now - m.at < CRYPTO_CORR_TTL) return m.payload;
    const payload = buildCryptoCorr(win); cryptoCorrMemo.set(win, { at: now, stamp: payload.stamp, payload });
    return payload;
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
  function getTfCandles(coin, tf, fast, slow) {
    const key = String(tf || "").toLowerCase();
    if (!(key in TF_CANDLES)) return null;
    // A valid non-default MA pair widens the H1 read to match what buildTrendPair fed the ladder,
    // so the modal's plotted ribbon reproduces the pair board's EMAs bit-for-bit (the same
    // one-code-path contract the canonical 13/21 chart holds). D1/H4/H12 are already deep enough.
    const pair = (fast != null || slow != null) ? validTrendPair(fast, slow) : null;
    const h1Bars = (pair && !(pair.fast === 13 && pair.slow === 21)) ? TREND_PAIR_H1_BARS : 96;
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
        for (const b of bucketsFor(r, 24))
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
      src = Array.isArray(r.hourlyRaw) ? hoursToObj(r.hourlyRaw.slice(-h1Bars)) : [];   // chart serializer reads the object shape
    } else {
      src = Array.isArray(r.hourlyRaw) ? bucketsFor(r, TF_CANDLES[key]) : [];
    }
    const out = [];
    for (const k of src) { if (isFinite(+k.t) && isFinite(+k.c)) out.push(q(k)); }
    // Volume profile rides the chart payload (-22): same serveKeyed key (the coin stamp folds the
    // spine, whose growth is exactly what moves the memoized profile), no new route, and the
    // report chart + trend modal read ONE object — the histogram can never disagree with the map.
    const vm = volMapFor(r);
    return { coin, tf: key, px: r.px != null && isFinite(+r.px) ? sig(+r.px, 9) : null, minBars: 26, candles: out,
      vp: vm && vm.vp ? vm.vp : null, dexVol: r.uni === "xyz" || undefined };
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
  // Shared retest enrichment for the shipped rows of ONE board (<= TREND_TOP), used by both the
  // canonical 13/21 builder and the parametric-pair builder so the two never drift. rrv = volume
  // through the retest (one bar of the retesting TF, clock-matched, rvolMulti); swing = the prior
  // swing high/low the continuation targets, from the SAME series the ladder consumed. Both are
  // deliberately OUT of the content signature (they drift with each completed bar; `retest` itself
  // is in the signature, so they're fresh at onset). Honest null when the baseline/lookback can't
  // qualify. Series depth for the swing lookback is the last ~30 bars, so the H1 slice width is
  // immaterial here — the same window falls out of a 96- or a 280-bar slice.
  function enrichRetest(list, side, now) {
    for (const e of list) {
      if (!e.retest) continue;
      try {
        const W = TREND_TF_MS[e.retest];
        const rv = W ? rvolMulti(getHourly(e.coin), { w: W }, now) : null;
        e.rrv = rv && rv.w != null ? rv.w : null;
      } catch (_) { e.rrv = null; }
      e.swing = null;
      try {
        const rr = rows.get(e.coin);
        if (rr) {
          let ser = null;
          if (e.retest === "D1") ser = withFormingDaily(Array.isArray(rr.dailyRaw) ? rr.dailyRaw : [], rr.px, now, DAY);
          else if (e.retest === "H1") ser = Array.isArray(rr.hourlyRaw) ? hoursToObj(rr.hourlyRaw.slice(-96)) : null;
          else ser = Array.isArray(rr.hourlyRaw) ? bucketsFor(rr, e.retest === "H12" ? 12 : 4) : null;
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
              if (lvl != null && (side === "long" ? lvl > rr.px * 1.001 : lvl < rr.px * 0.999)) e.swing = sig(lvl, 9);
            }
          }
        }
      } catch (_) { e.swing = null; }
    }
  }
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
        H12: bucketsFor(r, 12),
        H4: bucketsFor(r, 4),
        H1: hoursToObj(r.hourlyRaw.slice(-96)),   // ladder rungs are object-shape ({t,h,l,c})
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
      enrichRetest(sides[side][uni], side, now);
    }
    const sigTrend = JSON.stringify([["long", "short"].map((s) => ["crypto", "stocks"].map((u) =>
      sides[s][u].map((e) => [e.coin, e.score, e.retest, e.read, e.age])))]);
    if (sigTrend !== trendSig) { trendSig = sigTrend; trendVer = Date.now(); }
    trendBuilt = now;
    // Coin -> board state, indexed once here so the snapshot stamp, the rule metrics and the trend
    // scan all read the SAME numbers the Trend tab renders. Re-deriving a ladder anywhere else is
    // exactly how a board and an alert start disagreeing.
    trendByCoin = new Map();
    for (const side of ["long", "short"]) for (const uni of ["crypto", "stocks"]) {
      for (const e of (sides[side][uni] || [])) {
        const d1 = e.tf && e.tf.D1;
        const prev = trendByCoin.get(e.coin);
        // A name can appear on both boards across timeframes; keep the stronger read.
        if (prev && prev.score >= e.score) continue;
        trendByCoin.set(e.coin, { side, uni, score: e.score, retest: e.retest || null,
          e21: d1 && d1.e21 > 0 ? d1.e21 : null, e13: d1 && d1.e13 > 0 ? d1.e13 : null, age: e.age });
      }
    }
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

  // ---- parametric trend board (served at /api/trend?fast=&slow=) ----
  // Same ladder, same one-code-path math (compute.js), for a user-chosen pair of MAs. The DEFAULT
  // pair (13/21) is never routed here — it returns the canonical getTrend() so the shared board,
  // its ETag and the chart modal stay byte-identical. Only the four pickable spans are allowed; a
  // pair is normalised so the smaller span is the fast one. This board is LEAN by design: it ships
  // the dots (with honest `nodata` grey rungs), score-out-of-available, read, retest flag, width
  // and Δslow — the retest zone band, rrv, swing and chart-modal ride-alongs stay on the canonical
  // 13/21 path (the modal drills a name at 13/21). The H1 rung reads a deeper slice of the retained
  // spine so a 200 EMA can seed there; D1 depth is whatever dailyRaw holds, so a 200 greys on
  // crypto D1 (~92 daily bars) until that history deepens — the grey dot IS that honest state.
  const TREND_PICKABLE = [13, 21, 50, 200];
  const TREND_PAIR_H1_BARS = 280;                   // widen H1 so EMA200 seeds AND the last ~64 shown bars clear the seed window (spine retains ~180d)
  const trendPairCache = new Map();                 // "fast-slow" -> { ts, data }
  function validTrendPair(fast, slow) {
    fast = Math.trunc(+fast); slow = Math.trunc(+slow);
    if (!TREND_PICKABLE.includes(fast) || !TREND_PICKABLE.includes(slow) || fast === slow) return null;
    return { fast: Math.min(fast, slow), slow: Math.max(fast, slow) };
  }
  function buildTrendPair(fast, slow) {
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
        H12: bucketsFor(r, 12),
        H4: bucketsFor(r, 4),
        H1: hoursToObj(r.hourlyRaw.slice(-TREND_PAIR_H1_BARS)),
      }, fast, slow);
      if (!lad) { excluded++; continue; }
      scanned++;
      const uni = r.uni === "main" ? "crypto" : "stocks";
      for (const side of ["long", "short"]) {
        const read = trendRead(side, lad);
        if (!read) continue;
        const s = lad[side];
        const tf = {};
        for (const t of TREND_TFS) {
          const g = lad.tf[t];
          tf[t] = { st: g.st, d21: g.d21, e13: g.e13 != null ? sig(g.e13, 9) : null, e21: g.e21 != null ? sig(g.e21, 9) : null };
        }
        // age via the SAME pair (generalised stackedRun) — dashes honestly when the slow MA can't
        // seed the D1 rung (e.g. a 200 over crypto's shallow daily history), never a 13/21 stand-in.
        let age = null, ageCap = false;
        if (lad.tf.D1.st === (side === "long" ? "up" : "down")) {
          const sr = stackedRun(d1g, r.px, side, fast, slow);
          if (sr) { age = sr.run; ageCap = sr.capped; }
        }
        sides[side][uni].push({ coin: r.coin, t: r.ticker, score: s.score, avail: lad.avail, tf,
          read: read.text, retest: read.retest, strength: +s.strength.toFixed(5), width: ribbonWidth(s), age, ageCap, vol: r.vol || 0 });
      }
    }
    for (const side of ["long", "short"]) for (const uni of ["crypto", "stocks"]) {
      // Rank by lit FRACTION (score/available) so a clean 3/3 isn't outranked by a 3/4, then by
      // available-rung count (a true 4-rung read beats a 3-rung one at equal fraction), then
      // fresh-first, then volume — the canonical board's ordering, made denominator-aware.
      sides[side][uni].sort((a, b) => ((b.score / (b.avail || 1)) - (a.score / (a.avail || 1)))
        || (b.avail - a.avail)
        || ((a.age == null ? Infinity : a.age) - (b.age == null ? Infinity : b.age))
        || (b.vol - a.vol));
      sides[side][uni] = sides[side][uni].slice(0, TREND_TOP).map(({ vol, ...e }) => e);
      enrichRetest(sides[side][uni], side, now);
    }
    return { ts: now, dataTs: now,
      params: { ema: [fast, slow], tfs: TREND_TFS, retestBars: 3, top: TREND_TOP, pickable: TREND_PICKABLE },
      coverage: { included: scanned, excluded },
      long: sides.long, short: sides.short };
  }
  function getTrendPair(fast, slow) {
    const v = validTrendPair(fast, slow);
    if (!v) return null;
    if (v.fast === 13 && v.slow === 21) return getTrend();     // canonical shared board
    const key = v.fast + "-" + v.slow;
    const hit = trendPairCache.get(key);
    if (hit && Date.now() - hit.ts < TREND_MS) return hit.data;
    let data;
    try { data = buildTrendPair(v.fast, v.slow); }
    catch (e) { log("buildTrendPair error: " + (e && e.message)); return hit ? hit.data : null; }
    trendPairCache.set(key, { ts: Date.now(), data });
    return data;
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
    anthropic: { model: "claude-fable-5", fb: "claude-opus-4-8", classify: "claude-haiku-4-5", maxTokens: 3000 },
    openai: { model: "gpt-5.6-terra", fb: "gpt-5.6-sol", classify: "gpt-5.4-nano", maxTokens: 8000 },
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
  // The news/sector classifier is a high-frequency UNATTENDED task (every 10 min, whether or not
  // anyone is watching) doing enum classification, y/n relevance and alias extraction — nano-tier
  // work, not report/ask work. It runs on its OWN model, decoupled from the report/ask fallback
  // chain, so cheapening it can never degrade a report (the old code reused AI_MODEL_FALLBACK,
  // which on OpenAI is the flagship Sol tier — the classifier was silently running frontier).
  // Default is the cheapest classification-grade tier per provider; AI_CLASSIFY_MODEL overrides
  // without a deploy, and AI_CLASSIFY_EFFORT trims OpenAI's reasoning tokens (this task wants none).
  const AI_CLASSIFY_MODEL = process.env.AI_CLASSIFY_MODEL || AI_DEF.classify || AI_MODEL_FALLBACK;
  const AI_CLASSIFY_EFFORT = process.env.AI_CLASSIFY_EFFORT || "low";
  const AI_KEY = () => AI_PROVIDER === "openai" ? (process.env.OPENAI_API_KEY || "") : (process.env.ANTHROPIC_API_KEY || "");
  const AI_TTL_MS = Math.max(5, Number(process.env.AI_REPORT_TTL_MIN) || 30) * 60 * 1000;
  // Bumped whenever the prompt/validator/schema changes shape: cached reports from an older
  // schema flip to "invalidated — report format updated" on the next read, so a deploy that
  // fixes the report is visible on the first regenerate, never hidden behind a running TTL.
  // Level-detector tuning. k=3 -> a 7-bar fractal window (the last 3 bars can confirm nothing).
  // tau = 0.4 x sd30 clusters touches at roughly half a typical daily move. minN=2 is the setting
  // that decides the detector's character: at 1 every pivot is a "level" and the snap rule below
  // becomes decorative, at 3 more names fall to the honest-null path.
  const AI_LEVEL_K = 3, AI_LEVEL_TAU = 0.4, AI_LEVEL_MINN = 2, AI_LEVEL_MAX = 8;
  const AI_SNAP_TOL = 0.5;   // x tauPct — how close a proposed void must sit to a detected level
  const AI_SCHEMA_V = 10;   // v10: group reports — a second report kind (grp:sec:/grp:bkt: keys, prose-tier breadth/rotation read, no geometry, no ledger claim); v9: target-price reconciliation — the target level is the single source of truth and a null scenario target is filled from it (the prompt offered "target": null while the validator rejected it, killing crypto reads where the detector confirms no cluster on the thesis side); v8: structural level detector — ctx.levels ships confirmed pivot clusters and a non-anchored directional void must snap to one (previously the void was bounded only by a +-40/60% sanity band); v7: earnings reported-vs-upcoming split — a printed event is a post-event object (context.earnings.reported), never served as a pending `next` binary; validator bans a stale `event` scenario; v6: crypto signal-engine removal — crypto reports no longer carry engine-fed live signals, marks, or setups; v5: news grounding contract (news_read), crypto context, sector-relative
  const AI_MAX_TOKENS = AI_DEF.maxTokens;
  const AI_TIMEOUT_MS = 120 * 1000;
  // Per-surface reasoning effort (OpenAI GPT-5.x only — the Anthropic body stays minimal and
  // Fable's adaptive thinking is left alone). Reports get the deep pass, the terminal gets the
  // fast one; both are Railway variables, not code changes.
  const AI_REPORT_EFFORT = process.env.AI_REPORT_EFFORT || "high";
  const AI_ASK_EFFORT = process.env.AI_ASK_EFFORT || "medium";
  // Daily generation budget, shared across the group exactly like the TTL cooldown. Only
  // SUCCESSFUL generations burn budget (a failed model call costs the group nothing), the day
  // rolls at midnight UTC, and the counter persists with the report cache so a redeploy can't
  // refill it. Early reset: terminal `admin reset-reports <password>` -> POST /api/ai-reset.
  const AI_REPORTS_PER_DAY = Math.max(1, Number(process.env.AI_REPORTS_PER_DAY) || 5);
  // The ask terminal's AI fallback also spends model budget (now at medium effort). Same shape as
  // the report cap: a shared daily pool, rolling at midnight UTC, over the top of the 12/min window
  // — so a single busy day can't run up an unbounded bill. Only SUCCESSFUL, non-cached model calls
  // burn it (a cache hit or a failure costs nothing). Persisted with the report budget so a redeploy
  // can't refill it; resettable via the same admin path.
  const ASK_REPORTS_PER_DAY = Math.max(1, Number(process.env.ASK_MAX_PER_DAY) || 50);
  // Per-user caps, layered UNDER the shared pools above. AI is open to every authenticated
  // group member now (the xyzai unlock stopped being a gate and became an exemption): a normal
  // user gets 3 report generations a day and 20 a month, and 5 AI terminal questions a day;
  // an admin (valid xyzai/xyzadm) is unlimited and burns NEITHER the per-user nor the shared
  // pools. Identity is the xyzown owner cookie — the same signed handle the alert system uses.
  // HONESTY NOTE: xyzown is a cookie, so a cleared browser mints a fresh identity and the
  // per-user cap is soft by construction; the shared pools remain the hard cost wall. When
  // multi-user accounts land, the quota key becomes the account id and this hardens for free.
  const AI_USER_PER_DAY = Math.max(1, Number(process.env.AI_USER_PER_DAY) || 3);
  const AI_USER_PER_MONTH = Math.max(1, Number(process.env.AI_USER_PER_MONTH) || 20);
  const ASK_USER_PER_DAY = Math.max(1, Number(process.env.ASK_USER_PER_DAY) || 5);
  const utcDay = () => new Date().toISOString().slice(0, 10);
  const utcMonth = () => new Date().toISOString().slice(0, 7);
  let aiDay = { day: utcDay(), count: 0 };
  let askDay = { day: utcDay(), count: 0 };
  function aiDayRoll() { const d = utcDay(); if (aiDay.day !== d) aiDay = { day: d, count: 0 }; }
  function aiDayLeft() { aiDayRoll(); return Math.max(0, AI_REPORTS_PER_DAY - aiDay.count); }
  function askDayRoll() { const d = utcDay(); if (askDay.day !== d) askDay = { day: d, count: 0 }; }
  function askDayLeft() { askDayRoll(); return Math.max(0, ASK_REPORTS_PER_DAY - askDay.count); }
  // ownerId -> { d, dc, m, mc, ad, ac, ts }: report day+count, report month+count, ask day+count,
  // last touch. Rolled lazily on read; persisted with the report cache so a redeploy can't refill
  // anyone's day; pruned at persist time (45d untouched, 500-entry cap) so cookie churn can't
  // grow the file unbounded.
  let aiUsers = new Map();
  function aiUserRow(owner) {
    const id = String(owner || "anon");
    let u = aiUsers.get(id);
    if (!u) { u = { d: utcDay(), dc: 0, m: utcMonth(), mc: 0, ad: utcDay(), ac: 0, ts: Date.now() }; aiUsers.set(id, u); }
    const d = utcDay(), m = utcMonth();
    if (u.d !== d) { u.d = d; u.dc = 0; }
    if (u.m !== m) { u.m = m; u.mc = 0; }
    if (u.ad !== d) { u.ad = d; u.ac = 0; }
    u.ts = Date.now();
    return u;
  }
  function aiUserQuota(owner) {
    const u = aiUserRow(owner);
    return { userPerDay: AI_USER_PER_DAY, userDayLeft: Math.max(0, AI_USER_PER_DAY - u.dc),
      userPerMonth: AI_USER_PER_MONTH, userMonthLeft: Math.max(0, AI_USER_PER_MONTH - u.mc),
      askUserPerDay: ASK_USER_PER_DAY, askUserDayLeft: Math.max(0, ASK_USER_PER_DAY - u.ac) };
  }
  function aiUserBurnReport(owner) { const u = aiUserRow(owner); u.dc++; u.mc++; }
  function aiUserBurnAsk(owner) { const u = aiUserRow(owner); u.ac++; }
  const AI_KINDS = new Set(["target", "flat", "void", "event"]);
  const AI_LEVEL_KINDS = new Set(["void", "target", "zone_low", "zone_high", "note"]);
  let aiReports = new Map();    // coin -> stored report (successes only; errors are returned, not cached)
  let aiGenerating = new Set();
  const aiFetch = aiFetchOpt || null;   // test hook: injected transport (the suite never touches the network)
  try {
    const saved = store.loadAiReports ? store.loadAiReports() : null;
    if (saved && Array.isArray(saved.reports))
      for (const rep of saved.reports) if (rep && rep.coin) aiReports.set(rep.coin, rep);
    // Same-day restart keeps the spent budget; a stale day is simply dropped (fresh counter).
    if (saved && saved.day && saved.day.day === utcDay())
      aiDay = { day: saved.day.day, count: Math.max(0, Number(saved.day.count) || 0) };
    if (saved && saved.askDay && saved.askDay.day === utcDay())
      askDay = { day: saved.askDay.day, count: Math.max(0, Number(saved.askDay.count) || 0) };
    // Per-user counters ride the same file; stale day/month fields roll lazily in aiUserRow.
    if (saved && Array.isArray(saved.users))
      for (const u of saved.users) if (u && u.id) aiUsers.set(String(u.id),
        { d: u.d || utcDay(), dc: Math.max(0, Number(u.dc) || 0), m: u.m || utcMonth(), mc: Math.max(0, Number(u.mc) || 0),
          ad: u.ad || utcDay(), ac: Math.max(0, Number(u.ac) || 0), ts: Number(u.ts) || Date.now() });
  } catch (_) {}
  function persistAiReports() {
    try {
      // Prune before write: 45d untouched or beyond the 500 freshest — cookie churn is bounded.
      const cut = Date.now() - 45 * DAY;
      const users = [...aiUsers.entries()].filter(([, u]) => u.ts >= cut)
        .sort((a, b) => b[1].ts - a[1].ts).slice(0, 500).map(([id, u]) => Object.assign({ id }, u));
      if (store.saveAiReports) store.saveAiReports({ ts: Date.now(), day: aiDay, askDay, users, reports: [...aiReports.values()] });
    } catch (_) {}
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
    // The actual can land on the calendar row minutes after the print, before it graduates into
    // earnPrints — so a report generated pre-print would otherwise sit stale through the whole
    // cooldown. reportedD tracks the freshest already-out row directly from the calendar, closing
    // that window: the moment the print flips a name to "reported", the cached report unlocks.
    let reportedD = null;
    if (ticker && earnCache && Array.isArray(earnCache.entries))
      for (const x of earnCache.entries)
        if (x.t === ticker && earnEntryState(x, Date.now()) === "reported" && (!reportedD || x.d > reportedD)) reportedD = x.d;
    return { openN, closedN, lastPrintD, reportedD };
  }
  function aiInvalidReason(rep) {
    if ((rep.schemaV || 1) !== AI_SCHEMA_V) return "report format updated";
    // Group reports have no per-name claim/earnings stamp — TTL + schema only.
    if (rep.kind === "group") return null;
    const cur = aiStampFor(rep.coin, rep.ticker);
    const s = rep.ctxStamp || {};
    if (cur.openN > (s.openN || 0)) return "new signal claim opened";
    if (cur.closedN > (s.closedN || 0)) return "claim resolved";
    if ((cur.lastPrintD || null) !== (s.lastPrintD || null)) return "earnings print landed";
    if ((cur.reportedD || null) !== (s.reportedD || null)) return "earnings print landed";
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
    try {
      // Scheduled macro binaries inside the report horizon — stated as facts next to the
      // divergence detectors. Deterministic server-side: the flag renders whether or not the
      // analyst weaves it in (the prompt separately requires that it does).
      const now2 = Date.now();
      for (const m of macroWithin(macroCache && macroCache.entries || [], now2, 10 * DAY).slice(0, 3)) {
        const when = m.days === 0 ? "today" : m.days === 1 ? "tomorrow" : "in " + m.days + "d";
        flags.push({ kind: "macro_event",
          txt: `${m.label} ${when} (${m.d}, ${m.tEt} ET)${m.sep ? " — SEP/dot-plot meeting" : ""} — a scheduled universe-wide binary inside the report horizon` });
      }
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
        const lad = trendLadder(px, { D1: d1g, H12: bucketsFor(r, 12),
          H4: bucketsFor(r, 4), H1: hoursToObj(r.hourlyRaw.slice(-96)) });
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
          // -31: no open claim because the episode already scored — say so, with the outcome.
          // Without this the model reads a live condition with no geometry and can't tell "not
          // yet claimed" from "already resolved"; the two demand opposite prose.
          if (g.postres && g.scored) it.episodeScored = { realized: g.scored.realized,
            unit: g.scored.unit, stopped: g.scored.stopped, voided: g.scored.voided, tR: g.scored.tR };
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
          const mine = earnCache.entries.filter((x) => x.t === tk);
          // Split this name's rows into what is genuinely AHEAD vs already OUT. The window reaches
          // days back, so a same-day AMC row that already carries its actual (or whose session
          // clock has passed) still sits here — served as `next` it read to the analyst as a
          // pending binary ("earnings after close today"), which is the whole bug. earnEntryState
          // is the single arbiter; `next` only ever receives an upcoming row.
          const up = mine.filter((x) => earnEntryState(x, now) === "upcoming").sort((a, b) => (a.d < b.d ? -1 : 1))[0];
          if (up) e.next = { d: up.d, session: up.s || "TBD",
            inDays: Math.max(0, Math.round((Date.UTC(+up.d.slice(0, 4), +up.d.slice(5, 7) - 1, +up.d.slice(8, 10)) - now) / DAY)) };
          // Freshest already-reported row — today's print in the graduation gap before it lands in
          // earnPrints, or a prior-day row still in the back-window. Gives the analyst a POST-event
          // object (beat/miss + surprise) so it reads the print instead of bracing for one that
          // already happened. Distinct from lastPrint (which reads persisted history and lags the
          // feed by the graduation delay — the exact window the bug lived in).
          const rp = mine.filter((x) => earnEntryState(x, now) === "reported").sort((a, b) => (a.d > b.d ? -1 : 1))[0];
          if (rp) e.reported = { d: rp.d, session: rp.s || "TBD",
            eps: rp.eps != null ? rp.eps : null, epsA: rp.epsA != null ? rp.epsA : null,
            beat: rp.eps != null && rp.epsA != null ? rp.epsA > rp.eps : null,
            surprisePct: rp.eps != null && rp.epsA != null && rp.eps !== 0
              ? +(((rp.epsA - rp.eps) / Math.abs(rp.eps)) * 100).toFixed(1) : null,
            agoDays: Math.max(0, -(earnDayDiff(rp.d, now) || 0)) };
        }
        if (earnStudy && earnStudy[tk]) e.reaction = earnStudy[tk];
        let last = null;
        for (const p of earnPrints) if (p.t === tk && p.epsA != null && (!last || p.d > last.d)) last = p;
        if (last) e.lastPrint = { d: last.d, session: last.s || null, eps: last.eps, epsA: last.epsA,
          beat: last.eps != null && last.epsA != null ? last.epsA > last.eps : null };
        if (e.next || e.reported || e.reaction || e.lastPrint) ctx.earnings = e;
      } catch (_) {}
      try {
        // Universe-wide scheduled macro binaries — FOMC/CPI/NFP/PPI/retail/GDP/PCE. `next` are
        // events still AHEAD inside ~10d (with the latest published stat as the prior — labeled
        // by month, never claimed as consensus; FRED carries no street estimates). `recent` is
        // the freshest print already OUT within 2d, with its actual when landed. Both universes:
        // these move BTC as hard as they move SPX.
        const ment = macroCache && Array.isArray(macroCache.entries) ? macroCache.entries : [];
        const mn = macroWithin(ment, now, 10 * DAY).slice(0, 3).map((m) => {
          const full = ment.find((x) => x.k === m.k && x.d === m.d) || {};
          return { k: m.k, label: m.label, d: m.d, timeEt: m.tEt, inDays: m.days,
            sep: m.sep, prior: full.prior || null };
        });
        let mr = null;
        for (const e of ment) {
          if (macroEntryState(e, now) !== "released") continue;
          const ago = -(earnDayDiff(e.d, now) || 0);
          if (ago > 2) continue;
          if (!mr || e.d > mr.d) mr = { k: e.k, label: e.label, d: e.d, timeEt: e.tEt,
            agoDays: Math.max(0, ago), actual: e.actual || null, pending: e.pend === true || undefined, prior: e.prior || null };
        }
        if (mn.length || mr) ctx.macro = { next: mn, recent: mr };
      } catch (_) {}
      try { const cl = classifyCached(r.ticker, r.uni);
        if (cl && cl.sector) {
          const peers = activeMarkets().filter((x) => !x.delisted && classifyCached(x.ticker, x.uni).sector === cl.sector);
          const with7 = peers.map((x) => ({ t: x.ticker, d7: pctOf(x.px, x.ref && x.ref.p7d) })).filter((x) => x.d7 != null)
            .sort((a, b) => b.d7 - a.d7);
          const rank = with7.findIndex((x) => x.t === r.ticker);
          const own7 = pctOf(px, r.ref && r.ref.p7d);
          const with30 = peers.map((x) => ({ t: x.ticker, d30: pctOf(x.px, x.ref && x.ref.p30d) })).filter((x) => x.d30 != null);
          const own30 = pctOf(px, r.ref && r.ref.p30d);
          const med7 = with7.length ? +median(with7.map((x) => x.d7)).toFixed(2) : null;
          const med30 = with30.length ? +median(with30.map((x) => x.d30)).toFixed(2) : null;
          ctx.sector = { name: cl.sector, assetClass: cl.assetClass || null,
            rank7d: rank >= 0 ? rank + 1 : null, of: with7.length,
            median7dPct: med7, median30dPct: med30,
            // the distinction the analyst can't otherwise make: the name's own move vs its
            // sector's — "+4% while the sector did +1%" is a different fact from "+4% with it"
            rel7dPct: own7 != null && med7 != null ? +(own7 - med7).toFixed(2) : null,
            rel30dPct: own30 != null && med30 != null ? +(own30 - med30).toFixed(2) : null };
        }
      } catch (_) {}
    }
    // -- verified news (the relevance pipeline's output ONLY) ---------------------------------
    // An unverified attribution never reaches the analyst: rel=1 items for this name, plus a
    // few macro tape items (off-topic excluded). ctx.news ALWAYS ships — an explicit empty
    // with a note, never an absent field — so the no-invention contract has something to bind
    // to: the model may reference only these headlines and must say when there are none.
    try {
      const tkU = String(r.ticker || "").toUpperCase();
      const mine = newsItems.filter((a) => !a.fl && a.tk && a.rel === 1 && String(a.tk).toUpperCase() === tkU)
        .sort((x, y) => y.pub - x.pub).slice(0, 6)
        .map((a) => ({ h: a.h, src: a.src || null, ageH: +((now - a.pub) / 3600e3).toFixed(1) }));
      const tape = newsItems.filter((a) => !a.tk && !a.rel && secTape[String(a.id)] && secTape[String(a.id)] !== "off-topic")
        .sort((x, y) => y.pub - x.pub).slice(0, 4)
        .map((a) => ({ h: a.h, sec: secTape[String(a.id)], ageH: +((now - a.pub) / 3600e3).toFixed(1) }));
      ctx.news = { windowH: 72, verified: mine, tape };
      if (!mine.length) ctx.news.note = "no verified headlines for this name in the window";
    } catch (_) {}
    // -- crypto-native state (main universe only) ---------------------------------------------
    if (uni === "crypto") {
      try {
        const cr = {};
        const fp = fundPctileNow(coin, r.funding, now);
        if (fp != null) cr.fundingPctile31d = fp;
        const oh = hist.get(coin);
        if (oh && oh.length > 4) {
          const t24 = now - DAY; let base = null;
          for (const k of oh) if (Math.abs(k[0] - t24) <= 3 * HOUR && (base == null || Math.abs(k[0] - t24) < Math.abs(base[0] - t24))) base = k;
          const last = oh[oh.length - 1];
          if (base && base[1] > 0 && last && last[1] > 0) cr.oiChg24Pct = +((last[1] / base[1] - 1) * 100).toFixed(1);
        }
        if (Object.keys(cr).length) ctx.crypto = cr;
      } catch (_) {}
    }
    try { const ar = analystRecordFor(coin); if (ar) ctx.analystRecord = ar; } catch (_) {}
    // -- structural levels: confirmed pivot clusters the void must sit on ----------------------
    // Detection is pure (compute.detectLevels); this is assembly. ctx.levels ALWAYS ships — an
    // explicit empty with a note, never an absent field — because the validator's snap rule binds
    // to it: present-and-populated means a directional void must match one of these, present-and-
    // empty means the rule stands down. An absent field would make "no history" and "detector
    // threw" indistinguishable, and the honest answer differs between them.
    try {
      const rets30 = [];
      for (let i = Math.max(1, closes.length - 30); i < closes.length; i++)
        if (closes[i - 1] > 0) rets30.push((closes[i] / closes[i - 1] - 1) * 100);
      const sd30 = rets30.length >= 10 ? stdev(rets30) : 0;
      const lv = detectLevels(daily, px, sd30,
        { k: AI_LEVEL_K, tauMult: AI_LEVEL_TAU, minN: AI_LEVEL_MINN, max: AI_LEVEL_MAX });
      ctx.levels = lv || { n: 0, items: [], note: "insufficient daily history for confirmed pivots" };
    } catch (_) { ctx.levels = { n: 0, items: [], note: "level detection unavailable" }; }
    ctx.flags = aiFlags(r);
    ctx.coverage = aiCoverage(coin, windowMs);
    return ctx;
  }
  const AI_SYSTEM = `You are the analyst layer of a private trading dashboard. You receive one JSON context object holding everything the server knows about a single perp market: price/momentum state, an EMA 13/21 trend ladder (daily, 12-hour and 4-hour rungs only), live signals with frozen claim geometry, this name's own out-of-sample signal track record, positioning (open interest, funding), benchmark beta decomposition, volatility regime, structural levels, divergence flags, coverage gaps, and (for equities) earnings event risk and sector context including the name's return RELATIVE to its own sector's median (sector.rel7dPct / rel30dPct — cite these when distinguishing name-specific moves from sector-wide ones). Crypto contexts may carry context.crypto: the funding percentile against the name's own 31d history and the 24h open-interest change — read positioning through these when present. context.levels carries the structural levels this name has actually respected: each item is a cluster of confirmed daily pivots, with v (the price), side ("res" overhead, "sup" below, "flip" for a level that has served as both), n (how many pivots touched it), ageD (days since the most recent touch) and distPct (distance from the mark). These are the ONLY prices you may treat as structure — a level with n=2 touched 40 days ago is weak evidence and should be described as such, while a flip with n=5 touched last week is the strongest structure the tape offers. When context.levels.items is empty the note says why: say plainly that no confirmed structure exists and lean on trend and positioning instead. context.news carries the ONLY headlines you may reference (verified per-name + macro tape). context.analystRecord, when present, is YOUR OWN out-of-sample record: every prior directional read was frozen as a claim (your void as the stop) and resolved at 5d. Weigh it — a thin or losing record on this name is a reason to hedge the read or demand more confirmation, and say so plainly. context.earnings may carry "next" (a scheduled print still AHEAD — this, and only this, is earnings event risk) and/or "reported" (a print already OUT, with its beat/miss and surprise%): a "reported" print is SETTLED HISTORY, not a pending catalyst — read its result and the tape's reaction, and never describe it as upcoming or tell the reader to wait for it. context.macro, when present, carries scheduled UNIVERSE-WIDE macro binaries (FOMC decisions, CPI, nonfarm payrolls, PPI, retail sales, GDP, PCE): "next" lists events still ahead with their ET dates/times and the latest published PRIOR value (labeled by reference month — this is the prior print, NOT a consensus estimate; no street consensus exists in this system, so never invent one or claim a beat/miss vs expectations), and "recent" is the freshest print already out with its actual when landed. These are the ONLY macro events you may reference and they apply to crypto exactly as to equities. An event in context.macro.next inside your scenario horizon MUST be acknowledged in the read and reflected in the plan (entry timing around the print, or a stated reason to hold through it); a macro release does NOT use the "event" scenario kind — that kind is reserved for this name's own earnings print — fold macro risk into the probabilities and notes instead.
Respond with ONLY a JSON object — no markdown fences, no preamble — with exactly these keys:
{"headline": string (<=60 chars, plain-language stance, e.g. "Constructive, leans long" or "Constructive, but earnings in 6 days"),
 "bias": "long"|"short"|"neutral",
 "synthesis": string (one paragraph, 3-6 sentences, plain human language a non-quant friend reads in 30 seconds; name the single dominant risk honestly),
 "evidence": array of 3-8 {"k": short label (<=16 chars, lowercase), "v": one plain-language sentence grounded in a specific number from the context},
 "eventRisk": string or null — ONLY when context.earnings.next places a print still AHEAD inside ~10 days: what the reaction study says and what holding through it means. If the print is already out (context.earnings.reported present and no context.earnings.next) or none is scheduled, this is null — a passed print is history, not event risk,
 "scenarios": array of 2-4 {"name": short plain description, "kind": "target"|"flat"|"void"|"event", "p": probability 0..1, "target": price level or null, "note": one sentence}. A "target" scenario MUST carry a price: repeat the exact value of your "target" level in it — the same number, not a rounded or nearby one. "target": null is for the "flat", "void" and "event" kinds only. Probabilities must sum to ~1 and be anchored on the track record and base rates in the context, not vibes. "target" scenarios are THESIS-DIRECTION only — an adverse recovery against the bias is the "void" scenario (through the void level) or "flat", never a target. If — and ONLY if — context.earnings.next places a print still AHEAD inside the scenario horizon, the middle scenario must be kind "event": the print decides, treat it as a coin flip scaled by the reaction study, and say so. When the print is already OUT (context.earnings.reported present, no context.earnings.next), the event is in the PAST — fold the reported beat/miss and the tape's reaction into the read, do NOT emit an "event" scenario, and never frame earnings as pending.
 "news_read": {"used": true|false, "note": one sentence, <=200 chars} — REQUIRED. "used" is true only when the read materially leans on a headline from context.news.verified; the note names which (or states that no verified headlines exist / none were material). NEWS CONTRACT: catalyst or news statements anywhere in the report may reference ONLY headlines provided in context.news. If context.news.verified is empty you MUST NOT infer, recall, or invent any company news — state that no verified headlines exist in the window and read the tape on its own. context.news.tape items are market backdrop, never company catalysts.
 "invalidations": array of 1-5 plain sentences — observable conditions that would change the read,
 "action": {"stance": "enter_now"|"enter_on_pullback"|"take_profit"|"wait"|"no_trade", "entry": price or null, "note": one sentence on why this stance and what to watch}. The actionable read: offer an entry stance whenever the geometry supports one (a void and a target exist and the expected value at some entry is positive) — "enter_on_pullback" requires "entry" set to the pullback level (typically the zone), "enter_now" may leave entry null (the current price). When the honest answer is to stand aside — event about to decide, negative expected value, neutral read, thin data — say "wait" or "no_trade" and name the condition that would change it. Never invent a stance the scenario odds don't support.
 "levels": array of at most 4 {"value": price, "kind": "void"|"target"|"zone_low"|"zone_high", "label": <=60 chars} for chart annotation. Level discipline is strict: when bias is "long" or "short" you MUST include exactly one "void" level — the observable price where the read is dead. This number is NOT free: when claimAnchor exists the void IS its stop, and otherwise the void MUST be one of the prices in context.levels.items — copy the value verbatim. A void that matches no detected level is rejected server-side and the report is discarded, so pick the level, then build the read around it — and exactly one "void" scenario resolving against it. At most one "target" level, optionally one zone_low+zone_high pair. The TARGET is held to a softer rule than the void, because a thesis-direction target often has no confirmed cluster in front of it: prefer a context.levels.items price on the thesis side, and when none exists, name the nearest structural extreme the data does support (range high/low, the prior swing) and say in the label that it is unconfirmed. What you must never do is omit the target price — a target scenario with no price is rejected server-side and the whole report is discarded. NEVER annotate moving averages as levels (EMAs drift — the chart draws the live ribbon itself) and never annotate range bounds unless the bound IS the void or target. Levels must sit within roughly ±25% of the current price or they won't render.
Hard rules: if claimAnchor exists, its stop IS the void level — use exactly that number. Otherwise the VOID must come from context.levels.items or from claim geometry — do not invent round numbers for it, and do not derive it from range bounds the detector did not confirm. Every other level prefers a detected price and must be labelled as unconfirmed when it is not one. Never mention timeframes below 4h. Cite the name's own numbers, not generic market lore. Where the data is thin (low n, coverage gaps, unknown trend split), say so plainly instead of smoothing over it. No investment-advice framing beyond describing the mechanical scenarios.`;
  // Structural fingerprint of a REJECTED payload, for the log line only. Shapes, not content:
  // bias, the scenario kinds, the level kinds, and which price fields came back empty. Total
  // failure to parse is itself the answer. Must never throw — a diagnostic that can crash the
  // generate path is worse than no diagnostic.
  function aiRejectShape(rawText) {
    if (rawText == null) return "shape: n/a (no model text)";
    let o;
    try {
      const clean = String(rawText).replace(/```json|```/g, "").trim();
      o = JSON.parse(clean.slice(clean.indexOf("{"), clean.lastIndexOf("}") + 1));
    } catch (_) { return `shape: unparseable (${String(rawText).length} chars)`; }
    try {
      const sc = Array.isArray(o.scenarios) ? o.scenarios : [];
      const lv = Array.isArray(o.levels) ? o.levels : [];
      const kinds = sc.map((s) => (s && s.kind) || "?").join(",") || "none";
      const lks = lv.map((l) => (l && l.kind) || "?").join(",") || "none";
      const gaps = [];
      if (sc.some((s) => s && s.kind === "target" && !(Number.isFinite(s.target) && s.target > 0))) gaps.push("scen.target");
      if (!lv.some((l) => l && l.kind === "target")) gaps.push("level.target");
      if (!lv.some((l) => l && l.kind === "void")) gaps.push("level.void");
      if (!o.action || o.action.entry == null) gaps.push("action.entry");
      return `shape: bias=${o.bias || "?"} scen=[${kinds}] levels=[${lks}] empty=[${gaps.join(",") || "none"}]`;
    } catch (_) { return "shape: introspection failed"; }
  }
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
    if (!out.news_read || typeof out.news_read.used !== "boolean" || !str(out.news_read.note, 200))
      return { ok: false, error: "missing/bad news_read (required: {used, note})" };
    if (out.news_read.used && !(ctx.news && Array.isArray(ctx.news.verified) && ctx.news.verified.length))
      return { ok: false, error: "news_read claims a headline was used but no verified headlines were provided — invented news" };
    if (!str(out.synthesis, 2600) || out.synthesis.length < 120) return { ok: false, error: "bad synthesis" };
    if (!Array.isArray(out.evidence) || out.evidence.length < 3 || out.evidence.length > 8
      || !out.evidence.every((e) => e && str(e.k, 20) && str(e.v, 320))) return { ok: false, error: "bad evidence" };
    if (out.eventRisk != null && !str(out.eventRisk, 500)) return { ok: false, error: "bad eventRisk" };
    if (!Array.isArray(out.invalidations) || out.invalidations.length < 1 || out.invalidations.length > 5
      || !out.invalidations.every((s) => str(s, 240))) return { ok: false, error: "bad invalidations" };
    // Levels are parsed BEFORE the scenarios because the target price is one number the payload
    // states twice — as the "target" level (what the chart draws) and as the target scenario's own
    // field (what the R/R column reads) — and nothing reconciled them. The prompt's schema line
    // offers "target": price level or null while the loop below hard-rejected the null, so an
    // honest payload that placed the price in levels and left the scenario field empty was
    // discarded. Crypto is where that bit: the v8 rule sends every level to context.levels.items,
    // and the detector confirms far fewer clusters on ~90 daily bars at a volatility-scaled tau
    // than on an equity's 370, so on a name with no cluster on the thesis side there was no
    // permitted number to write. One source of truth: the target LEVEL wins, the scenario field
    // is reconciled to it, and the hard failure survives only when neither carries a price.
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
    let targetLv = levels.find((l) => l.kind === "target") || null;
    let targetReconciled = false, targetSeed = null;
    if (!Array.isArray(out.scenarios) || out.scenarios.length < 2 || out.scenarios.length > 4) return { ok: false, error: "bad scenarios" };
    let psum = 0;
    for (const s of out.scenarios) {
      if (!s || !str(s.name, 90) || !AI_KINDS.has(s.kind) || typeof s.p !== "number" || !(s.p >= 0 && s.p <= 1)) return { ok: false, error: "bad scenario entry" };
      if (s.kind === "target") {
        const st = Number.isFinite(s.target) && s.target > 0 ? +s.target : null;
        // Neither field carries a price: the scenario claims a move to nowhere and every R it
        // would feed is uncomputable. Still a hard failure, same error string as before.
        if (st == null && targetLv == null) return { ok: false, error: "target scenario without a target level" };
        if (st == null) { s.target = targetLv.value; targetReconciled = true; }
        else if (targetLv && Math.abs(st / targetLv.value - 1) > 0.005) { s.target = targetLv.value; targetReconciled = true; }
        // A scenario price with no level to answer to gets the level sanity band applied to it
        // directly — an out-of-band target produces a real-looking R off a price the chart would
        // refuse to draw, which is the false-precision failure this layer exists to prevent.
        else if (!targetLv) {
          if (!(st > px * 0.6 && st < px * 1.6)) return { ok: false, error: "target scenario price outside sanity bounds" };
          targetSeed = sig(st, 9);
        }
      }
      if (s.note != null && !str(s.note, 300)) return { ok: false, error: "bad scenario note" };
      psum += s.p;
    }
    // The chart may not disagree with the card: when the price arrived only in the scenario row,
    // mint the matching level so both surfaces draw the same number. Skipped when the model
    // already spent all four annotation slots — it chose those, and the R/R column still reads
    // the scenario's own price.
    if (targetLv == null && targetSeed != null && levels.length < 4) {
      targetLv = { value: targetSeed, kind: "target", label: "target — from the scenario table" };
      levels.push(targetLv);
      targetReconciled = true;
    }
    if (!(psum >= 0.85 && psum <= 1.15)) return { ok: false, error: "scenario probabilities do not sum to 1" };
    for (const s of out.scenarios) s.p = +(s.p / psum).toFixed(3);
    if (out.scenarios.filter((s) => s.kind === "void").length > 1) return { ok: false, error: "multiple void scenarios" };
    // An "event" scenario asserts a scheduled print will decide the move — legitimate ONLY when
    // one is still AHEAD (context.earnings.next). A reported or absent print yields a stale
    // coin-flip that reads as pending event risk (the "earnings after close today" bug). Structural
    // guard; the tightened context + prompt carry the prose. Never trips a genuine upcoming print.
    const earnAhead = !!(ctx.earnings && ctx.earnings.next);
    if (!earnAhead && out.scenarios.some((s) => s.kind === "event"))
      return { ok: false, error: "event scenario without a pending earnings print (context.earnings.next)" };
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
    // No frozen claim to anchor to: the void must still sit on a price the tape respected. The
    // detector ships confirmed pivot clusters in ctx.levels; a void matching none of them is a
    // plausible-looking number with nothing behind it, and the risk unit, every per-scenario R
    // and the EV all inherit that softness while LOOKING computed. Hard reject rather than a
    // silent snap to the nearest level: moving a void the model never reasoned against leaves its
    // scenario probabilities describing a different trade, which is a worse failure than no
    // report. Within tolerance the value IS snapped, so the chart line and the ledger stop land
    // on the detected price rather than a near-miss. Stands down entirely when the detector had
    // too little history to speak — a young listing still gets a read.
    const lvItems = ctx.levels && Array.isArray(ctx.levels.items) ? ctx.levels.items : [];
    if (anchorStop == null && out.bias !== "neutral" && voidL && lvItems.length) {
      const tol = Math.max((+ctx.levels.tauPct || 0.5) * AI_SNAP_TOL, 0.1) / 100;
      let near = null, best = Infinity;
      for (const l of lvItems) {
        if (!(l && +l.v > 0)) continue;
        const d = Math.abs(+l.v / voidL.value - 1);
        if (d <= tol && d < best) { best = d; near = l; }
      }
      if (!near) return { ok: false, error: "void level does not sit on any detected structural level" };
      if (sig(+near.v, 9) !== voidL.value) {
        voidL.value = sig(+near.v, 9);
        voidL.label = (voidL.label + " (snapped to structure)").slice(0, 80);
        corrected = true;
      }
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
    const targetL = targetLv;   // hoisted above the scenario loop; may have been minted from it
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
        riskPct: risk != null ? +((risk / px) * 100).toFixed(2) : null, correctedVoid: corrected,
        correctedTarget: targetReconciled, scenarios: scen, evR: ev, action } };
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
  async function callModel(model, ctx, opts) {
    // opts.system / opts.maxTokens let lightweight tasks (sector classification) reuse this
    // exact transport — provider switch, refusal handling, timeout — without inheriting the
    // report prompt or its token budget. Absent opts = the report path, byte-identical.
    const sys = (opts && opts.system) || AI_SYSTEM, maxTok = (opts && opts.maxTokens) || AI_MAX_TOKENS;
    // opts.effort maps to OpenAI's reasoning_effort (low|medium|high) and is silently ignored
    // on the Anthropic path — Fable's adaptive thinking must not be steered.
    const effort = (opts && opts.effort) || null;
    const doFetch = aiFetch || fetch;
    const ctrl = new AbortController();
    const to = setTimeout(() => ctrl.abort(), AI_TIMEOUT_MS);
    try {
      let res;
      if (AI_PROVIDER === "openai") {
        // OpenAI Chat Completions. max_completion_tokens (not max_tokens — GPT-5.x rejects the
        // old name) covers reasoning + output together, hence the larger budget. Body stays
        // minimal on purpose, same principle as the Anthropic path.
        const oaBody = { model, max_completion_tokens: maxTok,
          messages: [{ role: "system", content: sys },
            { role: "user", content: "Context:\n" + JSON.stringify(ctx) }] };
        if (effort) oaBody.reasoning_effort = effort;
        res = await doFetch("https://api.openai.com/v1/chat/completions", {
          method: "POST",
          headers: { "content-type": "application/json", authorization: "Bearer " + AI_KEY() },
          body: JSON.stringify(oaBody),
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
        body: JSON.stringify({ model, max_tokens: maxTok, system: sys,
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
            claimAnchor: ctx.claimAnchor || null,
            // The evidence the void was checked against, frozen with the report: re-deriving these
            // client-side would let the chart disagree with the validator that accepted the read.
            structLevels: (ctx.levels && Array.isArray(ctx.levels.items)) ? ctx.levels.items : [] }); })() };
    const prevRep = aiReports.get(coin);
    aiReports.set(coin, rep);
    persistAiReports();
    try { aiFlipCheck(coin, prevRep, rep); }
    catch (e) { log("aiFlipCheck failed (isolated, the report still stands): " + (e && e.message)); }
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
    if (String(coin || "").startsWith("grp:")) { const s = groupParse(coin); return !!(s && !groupResolve(s).error); }
    const r = rows.get(coin);
    return !!(r && !r.delisted && (r.uni !== "main" || crypto));
  }
  function analystRecordFor(coin) {
    const rs = ledgerClosed.filter((e) => e.ev === "airead" && e.status === "resolved" && Number.isFinite(e.realized));
    const openAll = [...ledgerOpen.values()].filter((e) => e.ev === "airead");
    if (!rs.length && !openAll.length) return null;
    const agg = (a) => a.length ? { n: a.length,
      hit: +(a.filter((x) => x.realized > 0).length / a.length).toFixed(2),
      avgR: +(a.reduce((s, x) => s + x.realized, 0) / a.length).toFixed(2),
      avgRS: (() => { const s = a.filter((x) => x.realizedS != null && isFinite(x.realizedS)); return s.length ? +(s.reduce((q, x) => q + x.realizedS, 0) / s.length).toFixed(2) : null; })() }
      : { n: 0 };
    const mine = coin ? rs.filter((e) => e.coin === coin) : [];
    return { overall: agg(rs), thisName: coin ? agg(mine) : undefined,
      open: openAll.length, openOnName: coin ? openAll.some((e) => e.coin === coin) : undefined };
  }
  function getAiReport(coin, who) {
    if (String(coin || "").startsWith("grp:")) { const s = groupParse(coin); if (s) coin = s.key; }   // canonical basket key
    const quota = who && !who.admin ? aiUserQuota(who.owner) : (who && who.admin ? { admin: true } : null);
    if (!coin || !aiUniverseOk(coin)) {
      const rep = coin ? aiReports.get(coin) : null;
      if (!rep) return { coin: coin || "", status: "none", error: coin ? "not in the live universe" : "coin required", ts: Date.now() };
    }
    const rep = aiReports.get(coin);
    if (!rep) return Object.assign({ coin, status: "none", canRegen: true, ts: Date.now(),
      enabled: !!(AI_KEY() || aiFetch), provider: AI_PROVIDER, model: AI_MODEL,
      perDay: AI_REPORTS_PER_DAY, dayLeft: aiDayLeft() }, quota || {});
    const pub = aiPublic(rep);
    pub.perDay = AI_REPORTS_PER_DAY; pub.dayLeft = aiDayLeft();   // live, never cached with the report
    if (quota) Object.assign(pub, quota);
    const ar = analystRecordFor(coin);
    if (ar) pub.analystRecord = ar;   // live, not cached with the report: the record moves as claims resolve, and the ETag moves with it
    return pub;
  }
  function listAiReports() {
    const out = [...aiReports.values()].map((rep) => {
      const p = aiPublic(rep);
      return { coin: p.coin, ticker: p.ticker, uni: p.uni, ts: p.ts, model: p.model, kind: p.kind || "name",
        headline: p.ai && p.ai.headline, bias: p.ai && p.ai.bias, status: p.status,
        invalidReason: p.invalidReason, regenInMs: p.regenInMs, evR: p.computed && p.computed.evR };
    });
    out.sort((a, b) => b.ts - a.ts);
    return { ts: Date.now(), ttlMs: AI_TTL_MS, model: AI_MODEL, provider: AI_PROVIDER,
      enabled: !!(AI_KEY() || aiFetch), perDay: AI_REPORTS_PER_DAY, dayLeft: aiDayLeft(),
      reports: out.slice(0, 30) };
  }
  // who = { owner, admin }: threaded from the server (xyzown handle + xyzai/xyzadm state).
  // Admin skips BOTH the per-user caps and the shared pools and burns neither — unlimited by
  // request; the shared pools remain the hard wall for everyone else. The cooldown applies to
  // all callers equally: the cache is shared, so regenerating early wastes everyone's report.
  async function generateAiReport(coin, who) {
    if (String(coin || "").startsWith("grp:")) return generateGroupReport(coin, who);
    const admin = !!(who && who.admin), owner = (who && who.owner) || null;
    if (!coin || !aiUniverseOk(coin)) return { ok: false, error: "not in the live universe" };
    if (!AI_KEY() && !aiFetch) return { ok: false, error: "no AI API key set on the server (ANTHROPIC_API_KEY or OPENAI_API_KEY)" };
    const existing = aiReports.get(coin);
    if (existing) {
      const p = aiPublic(existing);
      // The cooldown is the group's rate limit, enforced HERE — the client's disabled button is
      // convenience, this check is the gate.
      if (!p.canRegen) return { ok: false, error: "cooldown", regenInMs: p.regenInMs, report: p };
    }
    if (!admin) {
      // Per-user caps first (the specific complaint beats the general one), then the shared pool.
      const uq = aiUserQuota(owner);
      if (uq.userDayLeft <= 0) return Object.assign({ ok: false, error: "user-day-cap" }, uq);
      if (uq.userMonthLeft <= 0) return Object.assign({ ok: false, error: "user-month-cap" }, uq);
      // The daily budget is the group's second gate after the TTL: 5 generations a day (env-
      // tunable), enforced HERE — the client's disabled button is convenience, this check is real.
      if (!aiDayLeft()) return { ok: false, error: "daily-cap", perDay: AI_REPORTS_PER_DAY, dayLeft: 0 };
    }
    if (aiGenerating.has(coin)) return { ok: false, error: "generation already running for this ticker" };
    aiGenerating.add(coin);
    try {
      const ctx = compileAiContext(coin);
      if (!ctx) return { ok: false, error: "not enough data compiled for this ticker yet" };
      let used = AI_MODEL, call = await callModel(AI_MODEL, ctx, { effort: AI_REPORT_EFFORT });
      let val = call.ok ? validateAiReport(call.text, ctx) : { ok: false, error: call.error };
      if (!val.ok) {
        log(`AI report ${coin}: ${AI_MODEL} failed (${val.error}) — falling back to ${AI_MODEL_FALLBACK}`);
        used = AI_MODEL_FALLBACK; call = await callModel(AI_MODEL_FALLBACK, ctx, { effort: AI_REPORT_EFFORT });
        val = call.ok ? validateAiReport(call.text, ctx) : { ok: false, error: call.error };
      }
      // Both models rejected and nothing is cached, so the offending payload is gone the moment
      // this returns — and a bare error string can't distinguish "the model wrote nonsense" from
      // "the prompt and the validator disagree" (the crypto null-target bug hid here for a build).
      // Log the SHAPE, never the body: bias, scenario kinds, level kinds, and which numeric fields
      // were absent. Enough to place the fault, no prose in the logs, no PII-shaped content.
      if (!val.ok) {
        log(`AI report ${coin}: fallback failed too (${val.error}) — ${aiRejectShape(call.ok ? call.text : null)}`);
        return { ok: false, error: val.error };
      }
      if (!admin) { aiDay.count++; aiUserBurnReport(owner); }   // only a SUCCESSFUL generation burns budget (admin burns nothing); aiAssemble persists the counters with the cache
      const rep = aiAssemble(coin, ctx, val, used);
      // Analyst-read accountability: every validated DIRECTIONAL read becomes a frozen claim
      // in its own ledger bucket — side, the report's own void, its target, mark at generation
      // — resolved out of sample like everything else. vi=0 keeps it out of the visible record
      // sets; absence from STRAT_DEFS keeps it off the shadows panel; the stop-aware resolver
      // handles it like any stp claim. Episode: one open read per name — a same-bias regen
      // never pseudo-replicates, and a bias flip leaves the frozen claim to resolve untouched
      // (moving a claim because the analyst changed its mind is what frozen geometry forbids).
      // Neutral reads don't ledger: "stand aside" contains nothing falsifiable.
      try {
        const bias = rep.ai && rep.ai.bias;
        if ((bias === "long" || bias === "short") && !ledgerOpen.has(coin + "|airead#0")) {
          const rr = rows.get(coin);
          const lvs = (rep.computed && rep.computed.levels) || [];
          const vdv = rep.computed && rep.computed.voidLevel;   // validator-corrected: frozen-claim stop when an anchor exists
          const tg = lvs.find((l) => l && l.kind === "target" && l.value > 0);
          const mk = ctx.px;
          if (rr && vdv > 0 && mk > 0 && stopGeometryOk(bias, mk, vdv)) {
            let sd0 = null;
            try {
              const cls = (rr.dailyRaw || []).map((k) => +k.c).filter(Number.isFinite);
              const rets = []; for (let i = 1; i < cls.length; i++) rets.push((cls[i] / cls[i - 1] - 1) * 100);
              sd0 = retStd(rets.slice(-30), 15);
            } catch (_) {}
            openLedger(rr, "airead", { score: 0, reading: "" }, bias === "long" ? 1 : -1,
              { sd0: sd0 != null ? +sd0.toFixed(3) : undefined, psd: bias, pn: 1,
                stp: +(+vdv).toPrecision(6),
                mv: tg ? +(Math.abs(tg.value / mk - 1) * 100).toFixed(2) : undefined,
                rm: used }, 0);
          }
        }
      } catch (e) { log("airead claim open failed (isolated, report unaffected): " + (e && e.message)); }
      log(`AI report generated: ${coin} via ${used} (bias ${rep.ai.bias}, ev ${rep.computed.evR != null ? rep.computed.evR + "R" : "n/a"})`);
      return Object.assign({ ok: true, report: aiPublic(rep), perDay: AI_REPORTS_PER_DAY, dayLeft: aiDayLeft() },
        admin ? { admin: true } : aiUserQuota(owner));
    } finally { aiGenerating.delete(coin); }
  }

  // ===== Group reports — sectors and custom baskets ======================================
  // A second report KIND alongside the single-name one. Deliberately prose-tier: no frozen
  // side/void/target geometry, no ledger claim, no track record — a breadth-and-rotation read
  // over an equal-weight basket, honestly framed as such. Equities only for now (crypto sectors
  // deferred). Keys: `grp:sec:<GICS sector>` or `grp:bkt:<T1+T2+...>` (sorted, canonical — the
  // key IS the cache identity, so the same basket in any order shares one cache and cooldown).
  const GRP_MAX_MEMBERS = 12;      // ad-hoc basket ceiling: keeps the context bundle sane
  const GRP_DETAIL_MAX = 20;       // sector reports list at most this many members in detail (by volume), totals stay honest
  const GRP_SYS = "You are the analyst layer of a private trading dashboard, writing a GROUP report over a basket of equities (a GICS sector or a user-picked basket). You receive one JSON context object: context.members holds each member's live fields (t=ticker, name, px=price, d1/d7/d30=% change, dd=% below 30d high, vsma200=% vs 200-day SMA or null, rvol=relative volume, earnDate=next scheduled earnings date or null), context.group holds the aggregates (ewIndex = the equal-weight index of daily closes rebased to 100 with ISO dates, breadth = {pctUpD1, pctAboveMa200, n}, avgPairCorr = average pairwise 30d correlation of daily returns or null, dispersionD7 = cross-sectional stdev of 7d returns), context.ledger holds recent signal events that fired on members (read-only history), and context.macro any scheduled universe-wide binaries ahead. NUMBERS RULE: every figure you cite must come from these fields or simple arithmetic on them — never invent or estimate a number that is not in the data. This is a breadth-and-rotation read, NOT a trade call: there is no entry, stop or target, and you must not fabricate levels on the synthetic index. Respond with ONLY a JSON object, no backticks, no prose outside it: {\"bias\": \"long\"|\"short\"|\"neutral\", \"headline\": string (<=90 chars, the one-line read), \"read\": [2-4 paragraph strings — the group read: breadth, leadership, dispersion (high avgPairCorr means one trade wearing many names — say so), positioning of the move], \"leaders\": string (one paragraph on what leadership says), \"laggards\": string (one paragraph on the laggards and whether they are opportunity or warning), \"risks\": [1-4 short strings], \"watch\": [1-4 short strings — what would change the read]}.";
  function groupParse(key) {
    const s = String(key || "");
    if (s.startsWith("grp:sec:")) { const name = s.slice(8); return name ? { kind: "sector", name, key: s } : null; }
    if (s.startsWith("grp:bkt:")) {
      const ts = s.slice(8).split("+").map((t) => t.trim().toUpperCase()).filter(Boolean);
      if (ts.length < 2 || ts.length > GRP_MAX_MEMBERS) return null;
      const uniq = [...new Set(ts)].sort();
      return { kind: "basket", tickers: uniq, key: "grp:bkt:" + uniq.join("+") };
    }
    return null;
  }
  function groupKeyFor(spec) {
    if (!spec) return null;
    if (spec.kind === "sector") return "grp:sec:" + spec.name;
    if (spec.kind === "basket") return groupParse("grp:bkt:" + (spec.tickers || []).join("+"))?.key || null;
    return null;
  }
  // Resolve a group key to live equity members. Sector: every non-delisted xyz equity whose
  // curated classification matches. Basket: the named tickers, validated against the live
  // universe — unknown names are reported, never silently dropped into a wrong basket.
  function groupResolve(spec) {
    if (!spec) return { error: "bad group key" };
    const eqRows = [...rows.values()].filter((r) => r && !r.delisted && r.uni !== "main");
    if (spec.kind === "sector") {
      const members = eqRows.filter((r) => classifyCached(r.ticker, r.uni).assetClass === "Equity"
        && classifyCached(r.ticker, r.uni).sector === spec.name);
      if (members.length < 3) return { error: "sector '" + spec.name + "' has fewer than 3 live equity members" };
      return { label: spec.name + " (sector)", members };
    }
    const byT = new Map(eqRows.map((r) => [String(r.ticker).toUpperCase(), r]));
    const members = [], missing = [];
    for (const t of spec.tickers) { const r = byT.get(t); if (r) members.push(r); else missing.push(t); }
    if (missing.length) return { error: "not in the live equity universe: " + missing.join(", ") };
    if (members.length < 2) return { error: "a basket needs at least 2 live members" };
    return { label: members.map((r) => r.ticker).join(" · "), members };
  }
  function compileGroupContext(spec) {
    const res = groupResolve(spec);
    if (res.error) return { error: res.error };
    const now = Date.now();
    // Detail rows: for sectors, cap by volume; the aggregates below still cover the whole set.
    const byVol = res.members.slice().sort((a, b) => (b.vol || 0) - (a.vol || 0));
    const detail = (spec.kind === "sector" ? byVol.slice(0, GRP_DETAIL_MAX) : byVol);
    const smaOf = (r, n) => { const cl = (r.dailyRaw || []).map((k) => +k.c).filter(Number.isFinite);
      if (cl.length < n) return null; let s = 0; for (let i = cl.length - n; i < cl.length; i++) s += cl[i]; return s / n; };
    const members = detail.map((r) => {
      const sma = smaOf(r, 200), px = r.px != null && isFinite(r.px) ? +r.px : null;
      let earnDate = null;
      try { if (earnCache && Array.isArray(earnCache.entries))
        for (const x of earnCache.entries) if (x.t === r.ticker && earnEntryState(x, now) !== "reported" && (!earnDate || x.d < earnDate)) earnDate = x.d; } catch (_) {}
      // Internal rows carry ref anchors + raw candles, not the wire row's derived fields —
      // derive here from the same sources the snapshot builder uses (one code path in spirit:
      // pctOf against the same ref anchors).
      const dl = (r.dailyRaw || []).filter((k) => Number.isFinite(+k.c));
      let dd = null; if (px && dl.length >= 5) { const hi = Math.max(...dl.slice(-30).map((k) => +(k.h != null ? k.h : k.c)));
        if (isFinite(hi) && hi > 0) dd = +((px / hi - 1) * 100).toFixed(2); }
      let rvol = null; if (dl.length >= 21) { const vs = dl.slice(-21).map((k) => +k.v).filter((v) => isFinite(v) && v > 0);
        if (vs.length >= 10) { const last = vs[vs.length - 1], avg = vs.slice(0, -1).reduce((s, v) => s + v, 0) / (vs.length - 1);
          if (avg > 0) rvol = +(last / avg).toFixed(2); } }
      return { t: r.ticker, name: companyName(r.ticker) || undefined, px,
        d1: r.d1 != null && isFinite(r.d1) ? +(+r.d1).toFixed(2) : null,
        d7: pctOf(px, r.ref && r.ref.p7d), d30: pctOf(px, r.ref && r.ref.p30d),
        dd, vsma200: sma && px ? +((px / sma - 1) * 100).toFixed(2) : null, rvol, earnDate };
    });
    // Aggregates over ALL members (not just the detail slice), from daily closes already in memory.
    const all = res.members;
    const retsOf = (r, n) => { const cl = (r.dailyRaw || []).map((k) => +k.c).filter(Number.isFinite).slice(-(n + 1));
      const out = []; for (let i = 1; i < cl.length; i++) out.push(Math.log(cl[i] / cl[i - 1])); return out; };
    // Equal-weight index: average log return per day over members that have that day, rebased to 100.
    const dayMap = new Map();   // isoDay -> [logRets]
    for (const r of all) { const dl = (r.dailyRaw || []).filter((k) => Number.isFinite(+k.t) && Number.isFinite(+k.c)).slice(-91);
      for (let i = 1; i < dl.length; i++) { const d = new Date(+dl[i].t).toISOString().slice(0, 10);
        if (!dayMap.has(d)) dayMap.set(d, []); dayMap.get(d).push(Math.log(+dl[i].c / +dl[i - 1].c)); } }
    const days = [...dayMap.keys()].sort();
    let lvl = 100; const ewIndex = [];
    for (const d of days) { const a = dayMap.get(d); lvl *= Math.exp(a.reduce((s, x) => s + x, 0) / a.length);
      ewIndex.push({ d, v: +lvl.toFixed(2) }); }
    const upD1 = all.filter((r) => r.d1 != null && isFinite(r.d1) && r.d1 > 0).length;
    const above = all.filter((r) => { const s = smaOf(r, 200); const px = r.px != null && isFinite(r.px) ? +r.px : null; return s && px && px > s; }).length;
    const withMa = all.filter((r) => smaOf(r, 200) != null).length;
    // Average pairwise 30d correlation over the detail slice (bounded pairs), honest null if thin.
    let avgPairCorr = null;
    try {
      const series = detail.map((r) => retsOf(r, 30)).filter((s) => s.length >= 20);
      if (series.length >= 3) {
        const L = Math.min(...series.map((s) => s.length));
        const cut = series.map((s) => s.slice(-L));
        const corr = (a, b) => { const n = a.length; let ma = 0, mb = 0; for (let i = 0; i < n; i++) { ma += a[i]; mb += b[i]; } ma /= n; mb /= n;
          let sa = 0, sb = 0, sab = 0; for (let i = 0; i < n; i++) { const x = a[i] - ma, y = b[i] - mb; sa += x * x; sb += y * y; sab += x * y; }
          return sa > 0 && sb > 0 ? sab / Math.sqrt(sa * sb) : null; };
        let s = 0, n = 0;
        for (let i = 0; i < cut.length; i++) for (let j = i + 1; j < cut.length; j++) { const c = corr(cut[i], cut[j]); if (c != null) { s += c; n++; } }
        if (n) avgPairCorr = +(s / n).toFixed(2);
      }
    } catch (_) {}
    const d7s = all.map((r) => pctOf(r.px != null && isFinite(r.px) ? +r.px : null, r.ref && r.ref.p7d))
      .filter((x) => x != null && isFinite(x));
    const dispersionD7 = d7s.length >= 3 ? +retStd(d7s, d7s.length).toFixed(2) : null;
    // Recent ledger history on members — read-only facts, exactly as they resolved.
    const tset = new Set(all.map((r) => r.coin));
    const ledger = [];
    for (const e of ledgerClosed.slice(-400)) if (tset.has(e.coin) && e.vi == null && e.status === "resolved" && now - (e.tEnd || 0) < 14 * DAY)
      ledger.push({ t: e.ticker, ev: e.ev, side: e.dir === 1 ? "long" : "short", realized: e.realized != null ? +(+e.realized).toFixed(2) : null });
    const ctx = { kind: "group", label: res.label, memberCount: all.length,
      members, group: { ewIndex: ewIndex.slice(-90), breadth: { pctUpD1: all.length ? +((upD1 / all.length) * 100).toFixed(0) : null,
        pctAboveMa200: withMa ? +((above / withMa) * 100).toFixed(0) : null, n: all.length }, avgPairCorr, dispersionD7 },
      ledger: ledger.slice(-20) };
    try { const mac = macroWithin(macroCache && macroCache.entries || [], now, 10 * DAY).slice(0, 3);
      if (mac.length) ctx.macro = mac.map((m) => ({ label: m.label, d: m.d, days: m.days })); } catch (_) {}
    return ctx;
  }
  function validateAiGroupReport(rawText) {
    let obj;
    try { obj = JSON.parse(String(rawText || "").replace(/^```(?:json)?/m, "").replace(/```\s*$/m, "").trim()); }
    catch (_) { return { ok: false, error: "model output is not valid JSON" }; }
    if (!obj || typeof obj !== "object") return { ok: false, error: "model output is not an object" };
    const bias = obj.bias;
    if (bias !== "long" && bias !== "short" && bias !== "neutral") return { ok: false, error: "bias must be long/short/neutral" };
    const headline = String(obj.headline || "").trim().slice(0, 90);
    if (!headline) return { ok: false, error: "headline missing" };
    const strArr = (a, min, max, cap) => Array.isArray(a) ? a.filter((x) => typeof x === "string" && x.trim())
      .slice(0, max).map((x) => x.trim().slice(0, cap)) : [];
    const read = strArr(obj.read, 2, 4, 900);
    if (read.length < 2) return { ok: false, error: "read needs 2-4 paragraphs" };
    const leaders = String(obj.leaders || "").trim().slice(0, 900);
    const laggards = String(obj.laggards || "").trim().slice(0, 900);
    if (!leaders || !laggards) return { ok: false, error: "leaders/laggards paragraphs missing" };
    return { ok: true, ai: { bias, headline, read, leaders, laggards,
      risks: strArr(obj.risks, 0, 4, 200), watch: strArr(obj.watch, 0, 4, 200) } };
  }
  async function generateGroupReport(key, who) {
    const admin = !!(who && who.admin), owner = (who && who.owner) || null;
    const spec = groupParse(key);
    if (!spec) return { ok: false, error: "bad group key — grp:sec:<sector> or grp:bkt:<T1+T2+...> (2-" + GRP_MAX_MEMBERS + " tickers)" };
    key = spec.key;   // canonicalized (basket tickers sorted/deduped)
    if (!AI_KEY() && !aiFetch) return { ok: false, error: "no AI API key set on the server (ANTHROPIC_API_KEY or OPENAI_API_KEY)" };
    const existing = aiReports.get(key);
    if (existing) {
      const p = aiPublic(existing);
      if (!p.canRegen) return { ok: false, error: "cooldown", regenInMs: p.regenInMs, report: p };
    }
    if (!admin) {
      const uq = aiUserQuota(owner);
      if (uq.userDayLeft <= 0) return Object.assign({ ok: false, error: "user-day-cap" }, uq);
      if (uq.userMonthLeft <= 0) return Object.assign({ ok: false, error: "user-month-cap" }, uq);
      if (!aiDayLeft()) return { ok: false, error: "daily-cap", perDay: AI_REPORTS_PER_DAY, dayLeft: 0 };
    }
    if (aiGenerating.has(key)) return { ok: false, error: "generation already running for this group" };
    aiGenerating.add(key);
    try {
      const ctx = compileGroupContext(spec);
      if (!ctx || ctx.error) return { ok: false, error: (ctx && ctx.error) || "could not compile group context" };
      let used = AI_MODEL, call = await callModel(AI_MODEL, ctx, { system: GRP_SYS, effort: AI_REPORT_EFFORT });
      let val = call.ok ? validateAiGroupReport(call.text) : { ok: false, error: call.error };
      if (!val.ok) {
        log(`AI group report ${key}: ${AI_MODEL} failed (${val.error}) — falling back to ${AI_MODEL_FALLBACK}`);
        used = AI_MODEL_FALLBACK; call = await callModel(AI_MODEL_FALLBACK, ctx, { system: GRP_SYS, effort: AI_REPORT_EFFORT });
        val = call.ok ? validateAiGroupReport(call.text) : { ok: false, error: call.error };
      }
      if (!val.ok) return { ok: false, error: val.error };
      if (!admin) { aiDay.count++; aiUserBurnReport(owner); }   // group generations spend the same pools
      const rep = { coin: key, kind: "group", ticker: ctx.label, uni: "stocks", label: ctx.label,
        memberCount: ctx.memberCount, members: ctx.members.map((m) => m.t), ts: Date.now(),
        model: used, ttlMs: AI_TTL_MS, schemaV: AI_SCHEMA_V, ai: val.ai,
        computed: { ewIndex: ctx.group.ewIndex, breadth: ctx.group.breadth,
          avgPairCorr: ctx.group.avgPairCorr, dispersionD7: ctx.group.dispersionD7 } };
      aiReports.set(key, rep);
      persistAiReports();
      log(`AI group report generated: ${key} via ${used} (bias ${rep.ai.bias}, ${ctx.memberCount} members)`);
      return Object.assign({ ok: true, report: aiPublic(rep), perDay: AI_REPORTS_PER_DAY, dayLeft: aiDayLeft() },
        admin ? { admin: true } : aiUserQuota(owner));
    } finally { aiGenerating.delete(key); }
  }

  // ===== Ask-the-board terminal — Tier 3 AI fallback ====================================
  // Planner: translate a natural-language question into ONE grammar query; the CLIENT then runs
  // it against the same live rows the board renders, so every number is the board's, never the
  // model's. Analyst: reason over the compact market bundle the client already computed and
  // answer in prose, citing only those numbers. Cost-gated by a sliding-window rate limit shared
  // across the group plus a short cache of identical questions. Reuses callModel (provider switch,
  // fallback, refusal handling, injected-transport test hook) verbatim.
  const ASK_WINDOW_MS = 60 * 1000, ASK_MAX_PER_WINDOW = Math.max(1, Number(process.env.ASK_MAX_PER_MIN) || 12);
  const ASK_CACHE_TTL = 90 * 1000;
  const askHits = [];              // model-call timestamps (sliding window)
  const askCache = new Map();      // normQ -> { at, res }
  const ASK_GRAMMAR = "top <field> [n] ; bottom <field> [n] (any field below, plus: gainers losers); "
    + "screen <field><op><value> [& <field><op><value> ...] (fields: funding fundpct squeeze momentum oi vol vstape doi beta dd ddy carry turn d1 d7 d30 h1 h4 gap prem rvol adr vol30 rs dcap hitr vsvwap vsma20 vsma50 vsma100 vsma200 vsyopen vsmopen; ops: > < >= <= =); "
    + "<TICKER> ; <TICKER> <field> ; signals [TICKER] ; corr <A> <B> ; diverge <TICKER> ; vs <A> <B> ; "
    + "earnings [TICKER|today|tomorrow|week|recent] ; news [TICKER] ; breadth [d1|d7|d30] ; sectors [d1|d7|d30] ; reports ; "
    + "fund <TICKER> (latest SEC-filed balance sheet + income facts) ; etf <SYMBOL> (latest SEC N-PORT holdings of an ETF/fund) ; whale (the tracked 13F fund watchlist) ; whale <FUND> (one tracked fund's latest 13F book + quarter-over-quarter delta) ; whale season (this quarter's cross-fund 13F summary: most bought, most sold, consensus opens, exits)";
  const ASK_PLANNER_SYS = "You translate a trader's natural-language question about a markets dashboard into EXACTLY ONE query in this grammar, and output ONLY that query — no prose, no backticks, no explanation.\nGrammar: " + ASK_GRAMMAR
    + "\nRules: use only the exact field/metric names above; use only tickers listed in context.tickers; 'crowded short' -> screen funding<0 & squeeze>50; 'overheated'/'crowded long' -> screen fundpct>85; 'near highs' -> screen dd>-3; 'oversold' -> screen dd<-25; 'paid to be short' -> screen carry>0.3; 'above their 200dma' -> screen vsma200>0; 'unusual volume' -> screen rvol>2; a question naming one ticker plus one measurable maps to <TICKER> <field>; two tickers side by side maps to vs <A> <B>; a question about a company's balance sheet, fundamentals, financials, debt, cash position, filed revenue or net income maps to fund <TICKER>; a question about an ETF's or fund's holdings, composition, constituents or what it contains maps to etf <SYMBOL> (for fund and etf the symbol MAY be outside context.tickers when the user names it explicitly); a question about what a TRACKED HEDGE FUND or institutional investor (a 13F filer named in context.whales, when present) bought, sold, holds or filed maps to whale <FUND> using that fund's key from context.whales; a question about what funds bought or sold this quarter overall, hedge-fund consensus, or 13F season maps to whale season. context.history, when present, holds this session's prior exchanges oldest-first (q = the user's earlier message, a = the answer they got): the current question may be a follow-up — resolve it against that context, and a complaint about a prior answer means the ORIGINAL question was answered wrongly, so re-map the original intent. If the question cannot be expressed in this grammar, output exactly: NONE";
  const ASK_ANALYST_SYS = "You are a markets analyst embedded in a trading dashboard. Every entry in context.markets is one market's live fields (absent keys mean that value is genuinely unavailable for that name): name = the company's common name, px = price, d1/d7/d30/h1/h4 = % change over that window, gap = today's open gap %, pr = perp premium %, f = funding APR %, fp = funding percentile, sqz = squeeze 0-100, mom = momentum, vs = vs-tape %, rs = vs-S&P %, oi, vol, doi = OI change %, rv = relative volume, adr = avg daily range %, v30 = 30d realized vol, beta, hitr = follow-through hit rate %, dd = % below 30d high, ddy = % below 52w high, yo = yearly open price, mo = monthly open price, m20/m50/m100/m200 = moving averages, vw = % vs 30d vwap, sector. NUMBERS RULE: every price, %, level or figure you cite must come from these fields or simple arithmetic on them (e.g. px vs yo is the YTD move; px vs m200 is distance to the 200dma) — never invent or estimate a figure that is not in or derivable from the data. IDENTITY RULE: for what a company IS or what it makes — its products, business lines, sub-industry, competitors — you MAY use well-known general knowledge, but ONLY about tickers present in context.markets, and NEVER name a company that is not in that list. When an answer leans on general knowledge rather than the live fields, note that briefly. context.history, when present, holds this session's prior exchanges oldest-first (q = the user's earlier message, a = the answer they got): the current message may be a follow-up — resolve pronouns and complaints against it, and a message like 'not what I asked' means a prior answer missed the ORIGINAL question, so answer that original question properly now. context.fundamentals, when present, holds SEC-filed facts for named tickers ({t}, {asOf}, facts keyed assets/liabilities/equity/cash/debt/netCash/revenue/netIncome/eps/shares, each {v} in USD or shares with its filing {period}): these are filed figures, cite them with their period and treat an absent key as genuinely unfiled. context.news, when present, holds the ONLY headlines you may reference ({h} = headline, {tk} = verified ticker or null for macro tape, {ageH} = hours old): for 'why is X moving' questions, cite a matching headline when one plausibly explains the move, and say plainly when none does — then read the tape (sector.rel via sector peers in context.markets, beta, funding, volume) instead of inventing a catalyst. Be concise: 2-4 sentences. Name the specific tickers and cite the values you used. If the data does not support an answer, say so plainly. No preamble, no disclaimers.";
  // Causal/explanatory intent routes to the analyst wherever it sits in the sentence — the
  // anchored-only version classified "what could be causing DRAM dump today" as planner, which
  // mapped it to a bare ticker card: a "why" answered with a number. The anchored set stays for
  // the openers that only signal analyst intent at the head of a question.
  const ASK_CAUSAL_RE = /\b(why|how come|caus(?:e|es|ed|ing)|reasons?|explain|driving|what happened|going on|behind (?:the|this|its))\b/i;
  function classifyAsk(q) { const s = String(q || "");
    if (ASK_CAUSAL_RE.test(s)) return "analyst";
    return /^\s*(what if|what would|what happens|should i|do you think|is it|are they|which is better|compare|walk me)\b/i.test(s) ? "analyst" : "planner"; }
  function askQueryValid(str, tickerSet) {
    const s = String(str || "").trim(); if (!s || /^none$/i.test(s)) return false;
    const p = s.split(/\s+/), h = p[0].toLowerCase(), H = p[0].toUpperCase();
    if (h === "top" || h === "bottom") return p[1] != null;
    if (h === "screen") return /[<>=]/.test(s);
    if (h === "signals" || h === "corr" || h === "diverge" || h === "vs" || h === "earnings"
      || h === "news" || h === "breadth" || h === "sectors" || h === "reports") return true;
    // fund/etf take symbols that may live OUTSIDE the trading universe (an ETF is not a perp
    // listing) — validate shape, not membership; the fetch path reports honestly on unknowns.
    if (h === "fund" || h === "etf") return p[1] != null && /^[A-Za-z0-9.\-]{1,10}$/.test(p[1]);
    // whale: bare (watchlist), season, or a fund key. Keys validate at execution against the
    // live watchlist — same shape-not-membership rule; an unknown key gets an honest miss card.
    if (h === "whale") return p[1] == null || p[1].toLowerCase() === "season" || /^[A-Za-z0-9]{1,12}$/.test(p[1]);
    return !!(tickerSet && tickerSet.has(H));   // <TICKER> or <TICKER> <field>
  }
  async function askBoard(q, ctx, who) {
    const admin = !!(who && who.admin), owner = (who && who.owner) || null;
    const withBudget = (r) => Object.assign(r, { askPerDay: ASK_REPORTS_PER_DAY, askDayLeft: askDayLeft() },
      admin ? { admin: true } : aiUserQuota(owner));
    q = String(q || "").trim();
    if (!q) return withBudget({ ok: false, error: "empty question" });
    if (!AI_KEY() && !aiFetch) return withBudget({ ok: false, disabled: true, error: "AI fallback needs an API key on the server (OPENAI_API_KEY / ANTHROPIC_API_KEY)" });
    ctx = ctx || {};
    // Session history, sanitized hard: caps on count and length, strings only. Statelessness was
    // the terminal's original sin — "not what I asked" arrived alone and the analyst truthfully
    // said it could only see those four words. The transcript rides every call now.
    const hist = Array.isArray(ctx.hist) ? ctx.hist.slice(-6)
      .map((h) => h && typeof h === "object" ? { q: String(h.q || "").slice(0, 300), a: String(h.a || "").slice(0, 500) } : null)
      .filter((h) => h && h.q) : [];
    const normQ = q.toLowerCase().replace(/\s+/g, " ").trim();
    // The cache key carries the last prior exchange: the same literal words are a DIFFERENT
    // question after a different conversation ("not what I asked" must never serve another
    // session's cached complaint).
    const cacheKey = normQ + "|h:" + (hist.length ? hist[hist.length - 1].q.toLowerCase().replace(/\s+/g, " ").slice(0, 80) : "");
    const cached = askCache.get(cacheKey);
    if (cached && Date.now() - cached.at < ASK_CACHE_TTL) return withBudget(Object.assign({ cached: true }, cached.res));   // a cache hit never burns budget
    const now = Date.now();
    while (askHits.length && askHits[0] < now - ASK_WINDOW_MS) askHits.shift();
    if (askHits.length >= ASK_MAX_PER_WINDOW) return withBudget({ ok: false, error: "rate", retryMs: ASK_WINDOW_MS - (now - askHits[0]) });
    // Daily budgets, over the top of the per-minute window (which applies to EVERYONE — it
    // protects the API, not the wallet). Checked BEFORE any model call so an exhausted day
    // costs nothing; the client's chip is convenience, this is the real gate. Per-user first
    // (5/day), then the shared non-admin pool (50/day); admin skips and burns neither.
    if (!admin) {
      const uq = aiUserQuota(owner);
      if (uq.askUserDayLeft <= 0) return withBudget({ ok: false, error: "ask-user-cap" });
      if (!askDayLeft()) return withBudget({ ok: false, error: "ask-daily-cap" });
    }
    askHits.push(now);
    // Enrich each row with the canonical company name from sectors.js (server-owned, so the
    // analyst maps ticker->company reliably instead of guessing). Unseeded names stay ticker-only.
    const markets = Array.isArray(ctx.universe) ? ctx.universe.slice(0, 160).map((m) => {
      const nm = companyName(m && m.t); return nm ? Object.assign({ name: nm }, m) : m;
    }) : [];
    const tickerSet = new Set(markets.map((m) => String(m && m.t || "").toUpperCase()).filter(Boolean));
    // Terminal calls run at medium effort — fast enough for a console, deep enough to plan or
    // reason correctly. The token budgets look oversized for one-line outputs because OpenAI
    // bills reasoning tokens against max_completion_tokens: a tight budget at medium effort
    // returns finish_reason=length with an EMPTY message. On Anthropic these are pure output
    // caps, so the headroom is harmless there.
    const callBoth = async (sys, payload, maxTok) => {
      let c = await callModel(AI_MODEL, payload, { system: sys, maxTokens: maxTok, effort: AI_ASK_EFFORT });
      if (!c.ok) c = await callModel(AI_MODEL_FALLBACK, payload, { system: sys, maxTokens: maxTok, effort: AI_ASK_EFFORT });
      return c;
    };
    // Headlines for the analyst: per-name verified items for any ticker the question mentions
    // (or the whole history mentions — a follow-up rarely repeats the name), plus a few macro
    // tape items. The prompt's news rule makes these the only citable headlines, so a causal
    // question gets the actual catalyst when one exists and an honest "no headline explains it"
    // when one doesn't.
    const askNews = (() => {
      if (!newsItems.length) return null;
      const txt = (q + " " + hist.map((h) => h.q).join(" ")).toUpperCase();
      const words = new Set(txt.split(/[^A-Z0-9]+/).filter(Boolean));
      const want = new Set([...tickerSet].filter((t) => words.has(t)));
      const now2 = Date.now(), out = [];
      const push = (a) => out.push({ h: String(a.h || "").slice(0, 200), tk: a.tk || null, ageH: Math.max(0, Math.round((now2 - (a.pub || now2)) / HOUR)) });
      const sorted = newsItems.slice().sort((a, b) => (b.pub || 0) - (a.pub || 0));
      for (const a of sorted) { if (out.length >= 6) break; if (a.rel === 1 && a.tk && want.has(String(a.tk).toUpperCase())) push(a); }
      let macro = 0;
      for (const a of sorted) { if (macro >= 4) break; if (!a.tk && !a.fl) { push(a); macro++; } }
      return out.length ? out : null;
    })();
    // Filed fundamentals for the analyst: cache-only, never a fetch — an ask must not block on
    // sec.gov. A name gets its fundamentals attached once someone has pulled its `fund` card
    // this day; until then the analyst honestly has no filing data for it. Max 2 names keeps
    // the payload lean; the prompt's numbers rule already covers provenance.
    const askFunds = (() => {
      const txt = (q + " " + hist.map((h) => h.q).join(" ")).toUpperCase();
      const words = new Set(txt.split(/[^A-Z0-9.\-]+/).filter(Boolean));
      const out = [];
      for (const [T, c] of fundCache) { if (out.length >= 2) break;
        if (words.has(T) && c.res && c.res.ok && Date.now() - c.at < FUND_TTL) {
          const f = c.res.data.fields, pick = {};
          for (const k of Object.keys(f)) if (f[k]) pick[k] = { v: f[k].v, period: f[k].period };
          out.push({ t: T, asOf: c.res.data.asOf, src: "SEC filings", facts: pick });
        } }
      return out.length ? out : null;
    })();
    const analyst = async () => {
      const payload = { question: q, scope: ctx.scope || null, markets };
      if (hist.length) payload.history = hist;
      if (askNews) payload.news = askNews;
      if (askFunds) payload.fundamentals = askFunds;
      const c = await callBoth(ASK_ANALYST_SYS, payload, 2600);
      return c.ok ? { ok: true, mode: "analyst", answer: c.text.trim(), marketsN: markets.length }
                  : { ok: false, error: c.error || "model call failed" };
    };
    const mode0 = ctx.mode === "analyst" || ctx.mode === "planner" ? ctx.mode : classifyAsk(q);
    let res;
    if (mode0 === "planner") {
      const pp = { question: q, scope: ctx.scope || null, tickers: [...tickerSet] };
      // Watched 13F funds, key + name, so "what did <fund> buy" can resolve to whale <KEY>.
      // Names ride along because the user says "Berkshire", never "BRK-the-watchlist-key".
      if (whaleState.watch.length) pp.whales = whaleState.watch.map((w) => ({ key: w.key, name: w.name }));
      if (hist.length) pp.history = hist;
      const c = await callBoth(ASK_PLANNER_SYS, pp, 1500);
      if (!c.ok) res = { ok: false, error: c.error || "model call failed" };
      else {
        const query = c.text.trim().split("\n")[0].replace(/^`+|`+$/g, "").trim();
        res = askQueryValid(query, tickerSet) ? { ok: true, mode: "planner", query } : await analyst();  // unmappable -> reason instead
      }
    } else res = await analyst();
    res.model = AI_MODEL; res.provider = AI_PROVIDER;
    if (res.ok) { if (!admin) { askDay.count++; aiUserBurnAsk(owner); } persistAiReports();   // a real model call landed — burn one (admin burns nothing), persist the counters
      askCache.set(cacheKey, { at: Date.now(), res }); if (askCache.size > 200) askCache.clear(); }
    return withBudget(res);
  }

  // ===== Admin reset of the daily report budget ==========================================
  // Triggered from the ask terminal (`admin reset-reports <password>`). The password lives
  // ONLY in ADMIN_PASSWORD (a Railway env var) — never in the repo, never logged, never
  // returned. Constant-time compare so a right-length guess can't be timed; only FAILURES
  // count toward a sliding-window lockout, so online brute force over the group's shared
  // endpoint is infeasible while legitimate resets stay free. Fails closed when unconfigured.
  const ADMIN_WINDOW_MS = 5 * 60 * 1000, ADMIN_MAX_FAILS = 8;
  const adminFails = [];
  // Constant-time ADMIN_PASSWORD check with a shared sliding-window lockout. Used by BOTH the
  // report-budget reset and the AI unlock, so brute-force attempts against either count together.
  function checkAdminPassword(password) {
    const admin = process.env.ADMIN_PASSWORD || "";
    if (!admin) return { ok: false, error: "not-configured" };
    const now = Date.now();
    while (adminFails.length && adminFails[0] < now - ADMIN_WINDOW_MS) adminFails.shift();
    if (adminFails.length >= ADMIN_MAX_FAILS)
      return { ok: false, error: "rate", retryMs: ADMIN_WINDOW_MS - (now - adminFails[0]) };
    const a = Buffer.from(String(password || ""), "utf8"), b = Buffer.from(admin, "utf8");
    const okPw = a.length === b.length && require("crypto").timingSafeEqual(a, b);
    if (!okPw) { adminFails.push(now); return { ok: false, error: "bad-password" }; }
    return { ok: true };
  }
  // ===== feature visibility state (admin panel) =================================================
  // Stored overrides live on the volume; the MANIFEST in compute.js owns defaults and the pinned/
  // never-gate invariants. Sanitized on load, so a hand-edited or half-written flags.json degrades
  // to defaults per key instead of throwing the boot. Held here (not in server.js) for the same
  // reason every other cache is: the poller is the one thing that owns persisted state.
  // Optional-chained on purpose: the store interface GREW here, and hard-calling a method that older
  // callers (and every existing test stub) do not provide would take the whole poller down at
  // construction. Absent methods degrade to "no overrides, cannot persist" — manifest defaults only.
  let featureFlags = featureFlagsSanitize(store.loadFlags ? store.loadFlags() : null);
  // Monotonic stamp for anything memoized against the CURRENT flag set (the scoped public bodies
  // below): a flag flip must mint fresh filtered bodies AND fresh ETags immediately, not on the
  // next signals/actionable build — an operator opening a universe expects it live on next poll.
  let flagsVer = 1;
  // ---- per-universe scoped bodies (build 2026.08.03-02) ---------------------------------------
  // A non-admin caller whose signals/actionable scopes are not all public gets a FILTERED body:
  // built once per (source cache object, flag set) pair by the pure compute filters, memoized so
  // the per-request cost is one identity check, and stamped with its own dataTs so etagFor can
  // never collide with the full body's tag (an admin unlock mid-session must not 304 a browser
  // into keeping the filtered copy, and a flag flip must bust the public copy at once).
  let sigScopedSrc = null, sigScopedStamp = "", sigScopedBody = null;
  let actScopedSrc = null, actScopedStamp = "", actScopedBody = null;
  function scopedBody(kind, src, vis) {
    const stamp = String(src.dataTs || 0) + "|" + flagsVer + "|" + (vis.cx ? 1 : 0) + (vis.eq ? 1 : 0);
    if (kind === "sig" && sigScopedSrc === src && sigScopedStamp === stamp) return sigScopedBody;
    if (kind === "act" && actScopedSrc === src && actScopedStamp === stamp) return actScopedBody;
    const body = kind === "sig" ? scopeFilterSignals(src, vis, { xyzOnly: XYZ_ONLY_EVS, mainOnly: MAIN_ONLY_EVS }) : scopeFilterActionable(src, vis);
    // dataTs becomes a STRING here on purpose: etagFor interpolates it, so "…s3cx" can never equal
    // any full body's numeric stamp, and folding flagsVer + the visible set means a flag flip or a
    // scope change mints a fresh tag while an unchanged pair keeps revalidating to 304.
    body.dataTs = String(src.dataTs || 0) + "s" + flagsVer + (vis.cx ? "c" : "") + (vis.eq ? "e" : "");
    if (kind === "sig") { sigScopedSrc = src; sigScopedStamp = stamp; sigScopedBody = body; }
    else { actScopedSrc = src; actScopedStamp = stamp; actScopedBody = body; }
    return body;
  }
  function getFlags() { return featureFlags; }
  // Everything the panel needs in one read: the manifest, the raw overrides, the resolved set for
  // THIS caller, and the public-facing counts. Resolved server-side on purpose — the client must
  // never re-derive a visibility from a raw flag (same one-code-path rule as the chart annotations).
  function getFeatures(isAdmin) {
    return {
      ts: Date.now(),
      admin: !!isAdmin,
      states: FEATURE_STATES,
      flags: featureFlags,
      counts: featureCounts(featureFlags),
      resolved: resolveFeatures(featureFlags, isAdmin),
      // Both audiences resolved SERVER-side. The panel's "view as public" swaps this in wholesale
      // rather than recomputing a public view from raw states in the browser — the client must never
      // re-derive a visibility, which is the same rule the chart annotations follow.
      resolvedPublic: resolveFeatures(featureFlags, false),
      manifest: FEATURES.map((f) => ({ key: f.key, kind: f.kind, label: f.label, parent: f.parent || null,
        state: featureState(featureFlags, f.key), pin: !!f.pin, lock: !!f.lock,
        settable: featureSettable(f.key), routes: f.routes || [] })),
    };
  }
  // One key per call — the panel writes optimistically and rolls back on failure, so a batch write
  // would make a partial failure ambiguous. Returns the fresh resolved set so the caller never has
  // to guess what the write produced (a pinned key, for instance, ignores the requested state).
  function setFlag(key, state, isAdmin) {
    if (!isAdmin) return { ok: false, error: "forbidden" };
    const entry = FEATURES.find((f) => f.key === key);
    if (!entry) return { ok: false, error: "unknown-feature" };
    // Refuse pinned keys outright rather than accepting the write and quietly resolving past it.
    // A 200 whose resolved state differs from the requested one reads as a successful write in the
    // panel and in any log; the honest answer is that this key is not settable.
    if (entry.pin) return { ok: false, error: "pinned" };
    if (entry.lock) return { ok: false, error: "locked" };   // the panel's own key — see the lock note in compute.js
    if (FEATURE_STATES.indexOf(state) < 0) return { ok: false, error: "bad-state" };
    const next = Object.assign({}, featureFlags);
    next[key] = state;
    const clean = featureFlagsSanitize(next);
    if (!store.saveFlags || !store.saveFlags(clean)) return { ok: false, error: "write-failed" };
    featureFlags = clean;
    flagsVer++;   // bust the memoized scoped public bodies (and their ETags) immediately
    log(`feature "${key}" set to ${state} (resolved ${featureState(clean, key)})`);
    return { ok: true, key, state: featureState(clean, key), features: getFeatures(true) };
  }
  // ---- Nav groups: rename a menu, move a tab between menus (build 2026.08.21-10) --------------
  // Both are display decisions the admin owns, on the same footing as feature visibility: written
  // once, stored server-side, seen by everyone. One key or one view per call, mirroring setFlag —
  // the panel writes optimistically and rolls back on failure, so a batch write would make a
  // partial failure ambiguous.
  let navConfig = navConfigSanitize(store.loadNavGroups ? store.loadNavGroups() : null);
  function getNavGroups() { return resolveNavGroups(navConfig); }
  function navWrite(next, what) {
    const san = navConfigSanitize(next);
    if (!store.saveNavGroups || !store.saveNavGroups(san)) return { ok: false, error: "write-failed" };
    navConfig = san;
    log("nav groups: " + what);
    return { ok: true, groups: getNavGroups() };
  }
  function setNavGroupLabel(key, label, isAdmin) {
    if (!isAdmin) return { ok: false, error: "forbidden" };
    if (!navGroupKeys().includes(key)) return { ok: false, error: "unknown-group" };
    // An empty label is the documented way to restore the default, not a validation failure — the
    // panel's "clear the box" gesture has to mean something honest.
    const clean = navLabelClean(label);
    const labels = Object.assign({}, navConfig.labels);
    if (clean) labels[key] = clean; else delete labels[key];
    const r = navWrite({ labels, views: navConfig.views },
      '"' + key + '" labelled "' + (clean || "(default)") + '"');
    if (r.ok) r.key = key, r.label = r.groups.find((g) => g.key === key).label;
    return r;
  }
  function setNavViewGroup(view, group, isAdmin) {
    if (!isAdmin) return { ok: false, error: "forbidden" };
    if (!navGroupKeys().includes(group)) return { ok: false, error: "unknown-group" };
    // Refuse a pinned or unknown view outright rather than accepting the write and quietly
    // resolving past it — a 200 that changed nothing reads as success in the panel and in the log.
    if (!NAV_VIEW_ORDER.includes(view)) return { ok: false, error: "unmovable-view" };
    const views = Object.assign({}, navConfig.views);
    views[view] = group;
    const r = navWrite({ labels: navConfig.labels, views }, '"' + view + '" moved to "' + group + '"');
    if (r.ok) r.view = view, r.group = group;
    return r;
  }
  function resetAiDay(password) {
    const chk = checkAdminPassword(password);
    if (!chk.ok) return chk;
    aiDayRoll(); aiDay.count = 0; persistAiReports();
    log("AI daily report budget reset by admin");
    return { ok: true, perDay: AI_REPORTS_PER_DAY, dayLeft: aiDayLeft() };
  }

  // ===== Custom baskets + ratio pairs (build 2026.07.28-06) =====================================
  // Synthetic EW instruments for the VISUAL layer: COMP/G virtual tickers, the manager panel, and
  // the ratio candle chart. All math lives in compute.js (basketCloses / ratioCloses / emaSeries);
  // this section is assembly only — resolve members against the live roster, align close series,
  // and ship. Tier boundary, load-bearing: NOTHING here reaches the alert emitters, the signal
  // fire sites, or the ledger. A basket is editable; an editable benchmark is not a benchmark.
  // The registry is deployment-global CONFIG (own file, tmp+rename). When multi-user lands it
  // becomes per-user — load/save stay behind persistBaskets/basketsSanitize so that migration is
  // a one-liner, not a hunt.
  const BASKET_SECTOR_SHORT = { "Information Technology": "TECH", "Communication Services": "COMMS",
    "Consumer Discretionary": "DISC", "Consumer Staples": "STAPLES", "Health Care": "HEALTH",
    "Financials": "FINS", "Industrials": "INDUS", "Energy": "ENERGY", "Materials": "MATS",
    "Real Estate": "REALEST", "Utilities": "UTES" };
  // Curated built-ins (build 2026.07.28-10): fixed membership lists that ship as defaults on every
  // deployment — MAG7 the founding member. Derived at read time like the sector baskets: the list
  // is INTERSECTED with the live roster (an unlisted member simply doesn't contribute; ≥2 present
  // or the basket doesn't exist), so a delisting can never leave a phantom member. A custom basket
  // wearing the same name WINS — the operator's own definition beats the shipped one, and the
  // curated entry steps aside rather than duplicating the name in the registry.
  const BASKET_CURATED = [
    { name: "MAG7", scope: "stocks", members: ["AAPL", "MSFT", "GOOGL", "AMZN", "NVDA", "META", "TSLA"] },
  ];
  const RATIO_TFS = { "1h": 1, "4h": 4, "12h": 12, "1d": 24 };
  const RATIO_EMA_SPAN = 200, RATIO_EMA_MIN = RATIO_EMA_SPAN + 5;   // emaSeries' own floor — the line exists honestly or not at all
  const RATIO_SHOW_MAX = 400;   // candles ON THE WIRE; the EMA is computed over the FULL series first, then both are trimmed together

  function basketsSanitize(raw) {
    const out = [];
    if (!raw || !Array.isArray(raw.list)) return out;
    for (const b of raw.list) {
      if (!b || typeof b.name !== "string" || !Array.isArray(b.members)) continue;
      const name = b.name.toUpperCase();
      if (!/^[A-Z][A-Z0-9]{1,11}$/.test(name)) continue;
      const scope = b.scope === "crypto" ? "crypto" : "stocks";
      const members = [...new Set(b.members.map((m) => String(m || "").toUpperCase()).filter(Boolean))].slice(0, BASKET_MAX_MEMBERS);
      if (members.length < BASKET_MIN_MEMBERS) continue;
      if (out.some((x) => x.name === name)) continue;
      // Owner scoping (build 2026.07.28-11): the server registry is the ADMIN's alone — guests keep
      // their customs in their own browser and never write here. So every persisted basket is
      // owner:"admin" by construction; the field is carried (not hard-coded at read) so the later
      // real-users migration is "owner = admin" -> "owner = <userId>" and nothing else moves.
      out.push({ name, scope, members, at: +b.at || Date.now(), owner: "admin" });
      if (out.length >= BASKET_MAX_CUSTOM) break;
    }
    return out;
  }
  // Optional-chained like the flags store: an older store stub degrades to "no registry, cannot
  // persist" instead of taking the poller down at construction.
  let baskets = basketsSanitize(store.loadBaskets ? store.loadBaskets() : null);
  let basketsRev = 0;
  function persistBaskets() { if (store.saveBaskets) store.saveBaskets({ list: baskets }); basketsRev++; }

  // ===== per-ticker notes (build 2026.08.24-01) =========================================
  // A note is prose about a name plus the mark it was written at. That px stamp is the whole
  // design: it is what lets every later read say "+18.4% since" instead of a bare date, and it
  // is why a note can never be reconstructed after the fact — the price it was written at is
  // gone the moment the tape moves. Hence CONFIG-grade storage and a hard cap, not a cache.
  const NOTE_MAX_LEN = 2000;          // one note's body
  const NOTE_MAX_PER_COIN = 200;
  const NOTE_MAX_TOTAL = 5000;        // whole-file ceiling; the volume is small and shared
  const NOTE_TAG_RE = /#[a-z0-9][a-z0-9_-]{0,23}/gi;
  // Tags are DERIVED from the body at read time, never stored alongside it. One source of truth:
  // editing the body to drop a #tag drops the tag, with no second field to fall out of sync.
  function noteTags(body) {
    const out = [];
    for (const m of String(body || "").match(NOTE_TAG_RE) || []) {
      const t = m.slice(1).toLowerCase();
      if (!out.includes(t)) out.push(t);
    }
    return out;
  }
  // Bodies are stored verbatim (the client escapes at render, as it does for every other
  // server string) but control characters are stripped at the WRITE — they cannot survive a
  // round trip through JSON + HTML usefully, and a stored \u0000 is a landmine for every later
  // reader. Tabs and newlines are kept: people format notes with them.
  function noteClean(body) {
    return String(body == null ? "" : body)
      .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, "")
      .slice(0, NOTE_MAX_LEN)
      .trim();
  }
  function notesSanitize(raw) {
    const list = raw && Array.isArray(raw.list) ? raw.list : [];
    const out = [];
    for (const n of list) {
      if (!n || typeof n !== "object") continue;
      const coin = String(n.coin || "").trim();
      const body = noteClean(n.body);
      const id = +n.id;
      if (!coin || !body || !Number.isFinite(id)) continue;
      out.push({
        id, coin, body,
        at: Number.isFinite(+n.at) ? +n.at : Date.now(),
        // px may legitimately be absent: a note written while the mark was unavailable is still
        // a note. Everything downstream treats a null stamp as "no move to measure", never zero.
        px: Number.isFinite(+n.px) && +n.px > 0 ? +n.px : null,
        edited: n.edited ? +n.edited || 1 : 0,
        owner: "admin",
      });
      if (out.length >= NOTE_MAX_TOTAL) break;
    }
    // Newest first is the order every consumer wants; sort once here rather than at each read.
    out.sort((a, b) => b.at - a.at);
    return out;
  }
  let notes = notesSanitize(store.loadNotes ? store.loadNotes() : null);
  let notesRev = 0;
  // Highest id ever seen +1. Derived from the file rather than persisted separately, so a
  // hand-edited notes.json can never hand out an id that is already taken.
  let noteSeq = notes.reduce((m, n) => Math.max(m, n.id), 0) + 1;
  function persistNotes() { if (store.saveNotes) store.saveNotes({ list: notes }); notesRev++; rebuildNotesIdx(); }
  // coin -> {n, ts, px} digest, rebuilt on every write. The markets table needs exactly these
  // three fields per row to paint a marker (does it exist, how old is the newest, what was it
  // written at) and nothing else — so the snapshot carries the digest and the bodies stay behind
  // /api/notes, where they load once with the drawer instead of on every 15s poll.
  let notesIdx = new Map();
  function rebuildNotesIdx() {
    const m = new Map();
    for (const n of notes) {
      const cur = m.get(n.coin);
      if (!cur) m.set(n.coin, { n: 1, ts: n.at, px: n.px });
      else { cur.n++; if (n.at > cur.ts) { cur.ts = n.at; cur.px = n.px; } }
    }
    notesIdx = m;
  }
  rebuildNotesIdx();
  function noteDigest(coin) { return notesIdx.get(coin); }
  function getNotesPayload() {
    return { ts: Date.now(), rev: notesRev, maxLen: NOTE_MAX_LEN, total: notes.length,
             notes: notes.map((n) => ({ id: n.id, coin: n.coin, body: n.body, at: n.at, px: n.px, edited: !!n.edited, tags: noteTags(n.body) })) };
  }
  function getNotesStamp() { return notesRev + "|" + notes.length; }
  // Live mark for the stamp. Reads the SAME row object the snapshot ships, so the price frozen
  // into a note is by construction the price the operator was looking at when they typed it.
  function noteMarkFor(coin) {
    const r = rows.get(coin);
    return r && !r.delisted && Number.isFinite(r.px) && r.px > 0 ? r.px : null;
  }
  function createNote(coin, body, isAdmin) {
    if (!isAdmin) return { ok: false, error: "not-admin" };
    const c = String(coin || "").trim();
    if (!c) return { ok: false, error: "no coin given" };
    // A note may be written on a name that has since left the universe (that is the point of
    // keeping them), but a NEW note has to be about something the board actually knows.
    if (!rows.has(c)) return { ok: false, error: `unknown market “${c}”` };
    const b = noteClean(body);
    if (!b) return { ok: false, error: "note is empty" };
    if (notes.length >= NOTE_MAX_TOTAL) return { ok: false, error: `note cap reached (${NOTE_MAX_TOTAL})` };
    const mine = notes.filter((n) => n.coin === c).length;
    if (mine >= NOTE_MAX_PER_COIN) return { ok: false, error: `note cap reached on this name (${NOTE_MAX_PER_COIN})` };
    const def = { id: noteSeq++, coin: c, body: b, at: Date.now(), px: noteMarkFor(c), edited: 0, owner: "admin" };
    notes.unshift(def);
    persistNotes();
    // The id and the name, never the body: a note is the operator's own prose and logs travel.
    log(`note ${def.id} written on ${c}`);
    return { ok: true, note: { id: def.id, coin: def.coin, body: def.body, at: def.at, px: def.px, edited: false, tags: noteTags(def.body) } };
  }
  // Editing rewrites the body and NOTHING else. The `at` and `px` stamps stay at their original
  // values on purpose: the claim was made then, at that price, and a record whose author can
  // quietly move its own goalposts is not a record. `edited` says the text changed.
  function editNote(id, body, isAdmin) {
    if (!isAdmin) return { ok: false, error: "not-admin" };
    const n = notes.find((x) => x.id === +id);
    if (!n) return { ok: false, error: "no such note" };
    const b = noteClean(body);
    if (!b) return { ok: false, error: "note is empty" };
    if (b === n.body) return { ok: true, note: { id: n.id, coin: n.coin, body: n.body, at: n.at, px: n.px, edited: !!n.edited, tags: noteTags(n.body) } };
    n.body = b; n.edited = Date.now();
    persistNotes();
    return { ok: true, note: { id: n.id, coin: n.coin, body: n.body, at: n.at, px: n.px, edited: true, tags: noteTags(n.body) } };
  }
  function dropNote(id, isAdmin) {
    if (!isAdmin) return { ok: false, error: "not-admin" };
    const i = notes.findIndex((x) => x.id === +id);
    if (i < 0) return { ok: false, error: "no such note" };
    const [n] = notes.splice(i, 1);
    persistNotes();
    log(`note ${n.id} on ${n.coin} deleted`);
    return { ok: true, id: n.id, coin: n.coin };
  }

  function basketScopeTickers(scope) {
    const s = new Set();
    for (const r of rows.values()) {
      if (r.delisted) continue;
      if ((scope === "crypto") !== (r.uni === "main")) continue;
      s.add((r.ticker || "").toUpperCase());
    }
    return s;
  }
  function basketRowFor(scope, tk) {
    tk = String(tk || "").toUpperCase();
    for (const r of rows.values()) {
      if (r.delisted) continue;
      if ((scope === "crypto") !== (r.uni === "main")) continue;
      if ((r.ticker || "").toUpperCase() === tk) return r;
    }
    return null;
  }
  // Built-in sector baskets, DERIVED from the live roster's classification on every read — they
  // follow listings and delistings on their own and are never persisted. Uncapped membership by
  // design: the member cap protects hand-typed registries, not the sector table.
  // Turn a free-text industry name ("Memory/Storage", "Mega Platforms") into a safe basket token:
  // uppercased, non-alnum stripped, capped to 12 chars, guaranteed to start with a letter. Two
  // industries that collide after tokenizing get a numeric suffix so the picker never shows dups.
  function industryToken(name, taken) {
    let t = String(name || "").toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 12);
    if (!/^[A-Z]/.test(t)) t = "I" + t.slice(0, 11);
    if (t.length < 2) t = (t + "IND").slice(0, 12);
    let base = t, n = 2;
    while (taken.has(t)) { t = (base.slice(0, 10) + n).slice(0, 12); n++; }
    taken.add(t);
    return t;
  }
  function builtinBaskets() {
    const groups = new Map();       // sector short -> members
    const inds = new Map();         // industry NAME -> members
    for (const r of rows.values()) {
      if (r.delisted || r.uni === "main") continue;
      const c = classifyCached(r.ticker);
      if (c.assetClass !== "Equity") continue;
      const tk = (r.ticker || "").toUpperCase();
      const short = BASKET_SECTOR_SHORT[c.sector];
      if (short) { let g = groups.get(short); if (!g) { g = []; groups.set(short, g); } g.push(tk); }
      // Industry groups: only where the curated industry DIFFERS from the sector (an unsplit
      // equity's ind === sector would just duplicate the sector basket). Keyed by the human name
      // for the tooltip; tokenized to a basket name below.
      if (c.ind && c.ind !== c.sector) { let g = inds.get(c.ind); if (!g) { g = []; inds.set(c.ind, g); } g.push(tk); }
    }
    const out = [];
    // Sector + industry baskets are SHADOW: derived, roster-following, usable as instruments in the
    // picker / COMP/G / ratio / matrix, but hidden from the Baskets manager (they're not editable and
    // would drown the operator's own list). MAG7 (curated) is NOT shadow — it shows in the manager.
    for (const [name, members] of groups) if (members.length >= 3) out.push({ name, scope: "stocks", members: members.sort(), builtin: true, shadow: true, kind: "sector" });
    const taken = new Set(out.map((b) => b.name));
    for (const [indName, members] of inds) if (members.length >= 3) {
      const nm = industryToken(indName, taken);
      out.push({ name: nm, scope: "stocks", members: members.sort(), builtin: true, shadow: true, kind: "industry", label: indName });
    }
    // Curated defaults join AFTER the sector groups: fixed lists intersected with the live roster.
    // A same-named custom wins (the operator's definition beats the shipped one); under 2 listed
    // members the curated basket honestly does not exist rather than shipping a one-name "basket".
    for (const cdef of BASKET_CURATED) {
      if (baskets.some((b) => b.name === cdef.name)) continue;
      const tks = basketScopeTickers(cdef.scope);
      const present = cdef.members.filter((m) => tks.has(m));
      if (present.length < BASKET_MIN_MEMBERS) continue;
      out.push({ name: cdef.name, scope: cdef.scope, members: present, builtin: true, cur: true });
    }
    out.sort((a, b) => (a.name < b.name ? -1 : 1));
    return out;
  }
  function basketDefByName(nameU) {
    const q = String(nameU || "").toUpperCase();
    // Exact token match first (MAG7, TECH, SEMICONDUCTO, a custom).
    const exact = baskets.find((b) => b.name === q) || builtinBaskets().find((b) => b.name === q);
    if (exact) return exact;
    // Then match on the human industry LABEL, normalized to letters/digits so a typed natural name
    // resolves even though the token was truncated to 12 chars: "semiconductor(s)" -> Semiconductors,
    // "memory storage" / "memorystorage" -> Memory/Storage. The token is unguessable; the label is
    // what a person actually types.
    const norm = (s) => String(s || "").toUpperCase().replace(/[^A-Z0-9]/g, "");
    const nq = norm(q);
    if (!nq) return null;
    const bl = builtinBaskets();
    // exact normalized label, then a singular/plural-tolerant prefix (drop a trailing S on either side)
    const strip = (s) => s.replace(/S$/, "");
    return bl.find((b) => b.label && norm(b.label) === nq)
      || bl.find((b) => b.label && strip(norm(b.label)) === strip(nq))
      || bl.find((b) => b.label && (norm(b.label).startsWith(nq) || nq.startsWith(norm(b.label))) && Math.min(norm(b.label).length, nq.length) >= 5)
      || null;
  }

  // Align member close series on a shared axis and synthesize the EW index (compute.basketCloses).
  // `pick` extracts [t, close] pairs from a row; used at daily AND hourly resolution.
  function basketAligned(def, pick, quant) {
    const maps = def.members.map((m) => {
      const r = basketRowFor(def.scope, m), mm = new Map();
      if (r) for (const [t, c] of pick(r)) { if (isFinite(t) && isFinite(c) && c > 0) mm.set(quant(t), c); }
      return mm;
    });
    const axset = new Set();
    maps.forEach((m) => m.forEach((_, t) => axset.add(t)));
    const axis = [...axset].sort((a, b) => a - b);
    const series = maps.map((m) => axis.map((t) => { const v = m.get(t); return v === undefined ? null : v; }));
    const bc = basketCloses(series, BASKET_FLOOR);
    let covN = 0;
    for (let i = axis.length - 1; i >= 0; i--) if (bc.closes[i] != null) { covN = bc.cov[i]; break; }
    return { axis, closes: bc.closes, cov: { n: covN, N: def.members.length } };
  }
  const pickDaily = (r) => (Array.isArray(r.dailyRaw) ? r.dailyRaw.map((k) => [+k.t, +k.c]) : []);
  const pickHourly = (r) => (Array.isArray(r.hourlyRaw) ? r.hourlyRaw.map((k) => [+k[0], +k[4]]) : []);

  // Daily series for the wire: valid slots only, as compact [dayMs, close] tuples. Invalid (sub-
  // floor) days are simply ABSENT — the client's union-day alignment renders them as gaps, which
  // is the disclosure: a basket day never exists as a renormalized guess.
  function basketDailySeries(def) {
    const a = basketAligned(def, pickDaily, (t) => Math.floor(t / DAY));
    const daily = [];
    for (let i = 0; i < a.axis.length; i++) if (a.closes[i] != null) daily.push([a.axis[i] * DAY, +a.closes[i].toFixed(4)]);
    return { daily, cov: a.cov };
  }
  function basketHourlySeries(def) {
    const a = basketAligned(def, pickHourly, (t) => t);
    const times = [], closes = [];
    for (let i = 0; i < a.axis.length; i++) if (a.closes[i] != null) { times.push(a.axis[i]); closes.push(a.closes[i]); }
    return { times, closes, cov: a.cov };
  }

  function getBasketsPayload() {
    const list = [];
    for (const b of builtinBaskets()) { const s = basketDailySeries(b); list.push({ name: b.name, scope: b.scope, members: b.members, builtin: true, shadow: !!b.shadow, kind: b.kind || null, label: b.label || null, daily: s.daily, cov: s.cov }); }
    for (const b of baskets) { const s = basketDailySeries(b); list.push({ name: b.name, scope: b.scope, members: b.members, builtin: false, daily: s.daily, cov: s.cov }); }
    return { ts: Date.now(), floor: BASKET_FLOOR, maxMembers: BASKET_MAX_MEMBERS, maxCustom: BASKET_MAX_CUSTOM, rev: basketsRev, baskets: list };
  }
  // ETag key: registry revision + the daily-content version — a create/drop or a new daily close
  // mints a fresh key, everything else 304s the (largest-in-this-family) payload away.
  function getBasketsStamp() { return basketsRev + "|" + dailyVer; }

  function createBasket(name, members, isAdmin) {
    // The server registry belongs to the admin alone (guests store customs in their own browser and
    // never reach this path). Refuse a non-admin write outright — defense in depth: even if the
    // client guard is bypassed, a guest can never write into the admin's file.
    if (!isAdmin) return { ok: false, error: "not-admin" };
    if (baskets.length >= BASKET_MAX_CUSTOM)
      return { ok: false, error: `basket cap reached (${BASKET_MAX_CUSTOM}) \u2014 drop one first` };
    const ms = [...new Set((members || []).map((m) => String(m || "").toUpperCase().trim()).filter(Boolean))];
    if (!ms.length) return { ok: false, error: "no members given" };
    // Scope inference: every member must resolve in exactly ONE universe. Baskets never cross the
    // stocks/crypto separation, and a name listed in both (the SPX-memecoin shape) is refused as
    // ambiguous rather than guessed at.
    const sT = basketScopeTickers("stocks"), cT = basketScopeTickers("crypto");
    const allS = ms.every((m) => sT.has(m)), allC = ms.every((m) => cT.has(m));
    if (allS && allC) return { ok: false, error: "ambiguous membership \u2014 these names exist in BOTH universes; baskets never cross the stocks/crypto separation" };
    if (!allS && !allC) {
      const missS = ms.filter((m) => !sT.has(m)), missC = ms.filter((m) => !cT.has(m));
      const closer = missS.length <= missC.length ? { scope: "stocks", miss: missS } : { scope: "crypto", miss: missC };
      return { ok: false, error: `members must live in ONE universe \u2014 not in the ${closer.scope} universe: ${closer.miss.join(" ")}` };
    }
    const scope = allS ? "stocks" : "crypto";
    // Sector built-ins are reserved (purely derived, no membership to override); curated built-ins
    // are NOT — the whole point of "custom wins" is that an operator can redefine MAG7. So reserve
    // the derived sector names but let a curated name through to be overridden.
    const curatedNames = new Set(BASKET_CURATED.map((c) => c.name));
    const reserved = new Set([...SP_ALIASES.map((a) => a.toUpperCase()), "BTC",
      ...baskets.map((b) => b.name), ...builtinBaskets().map((b) => b.name).filter((n) => !curatedNames.has(n))]);
    const v = validateBasket(name, ms, scope, { tickers: scope === "stocks" ? sT : cT, reserved });
    if (!v.ok) return v;
    const def = { name: v.name, scope, members: v.members, at: Date.now(), owner: "admin" };
    baskets.push(def);
    persistBaskets();
    log(`basket ${def.name} created (${scope}, ${def.members.length} members)`);
    const s = basketDailySeries(def);
    return { ok: true, basket: { name: def.name, scope, members: def.members, builtin: false, cov: s.cov } };
  }
  function dropBasket(name, isAdmin) {
    if (!isAdmin) return { ok: false, error: "not-admin" };
    const nm = String(name || "").toUpperCase().trim();
    const i = baskets.findIndex((b) => b.name === nm);
    if (i < 0) return { ok: false, error: builtinBaskets().some((b) => b.name === nm) ? "built-in baskets are derived from the sector table \u2014 they cannot be dropped" : `no custom basket \u201c${nm}\u201d` };
    baskets.splice(i, 1);
    persistBaskets();
    log(`basket ${nm} dropped`);
    return { ok: true, name: nm };
  }

  // One ratio leg: a basket (custom or built-in) or a listed name, as hourly [times, closes].
  function ratioLeg(nameU) {
    const b = basketDefByName(nameU);
    if (b) { const s = basketHourlySeries(b); return { scope: b.scope, times: s.times, closes: s.closes, cov: s.cov, basket: true, name: b.name }; }
    for (const scope of ["stocks", "crypto"]) {
      const r = basketRowFor(scope, nameU);
      if (r) {
        const times = [], closes = [];
        for (const [t, c] of pickHourly(r)) if (isFinite(t) && isFinite(c) && c > 0) { times.push(t); closes.push(c); }
        return { scope, times, closes, cov: null, basket: false, name: (r.ticker || nameU).toUpperCase() };
      }
    }
    return null;
  }
  // Ratio candles, built HONESTLY: the ratio is computed at hourly resolution (the same spine the
  // trend-ladder charts consume, basket legs synthesized hourly), then those hourly ratio closes
  // are bucketed into 1H/4H/12H/1D candles via the SAME bucketCandles the ladder uses. Every
  // O/H/L/C is therefore a real value of the 1H-sampled ratio — never numerator-high ÷
  // denominator-low, which fabricates extremes that never traded — and extremes finer than 1H are
  // honestly not captured (the client legend says so). EMA200 runs over the FULL bucketed series
  // before the wire trim, and is null (with the reason) under emaSeries' own floor: no shorter
  // EMA ever wears the 200 name. Display-only decoration on a synthetic series — it feeds no
  // ladder, no emaAlertState, no alert class.
  function getRatio(num, den, tf) {
    const tfk = String(tf || "4h").toLowerCase();
    const hours = RATIO_TFS[tfk];
    if (!hours) return { ok: false, error: "tf must be one of 1h \u00b7 4h \u00b7 12h \u00b7 1d" };
    const A = ratioLeg(String(num || "").toUpperCase().trim());
    if (!A) return { ok: false, error: `unknown \u201c${String(num || "").toUpperCase()}\u201d \u2014 not a listed name or a basket` };
    const B = ratioLeg(String(den || "").toUpperCase().trim());
    if (!B) return { ok: false, error: `unknown \u201c${String(den || "").toUpperCase()}\u201d \u2014 not a listed name or a basket` };
    if (A.name === B.name) return { ok: false, error: "numerator and denominator are the same series" };
    if (A.scope !== B.scope) return { ok: false, error: "legs live in different universes \u2014 ratios never cross the stocks/crypto separation" };
    // Intersection alignment (division needs both legs), then compute.ratioCloses — one code path.
    const bm = new Map();
    for (let i = 0; i < B.times.length; i++) bm.set(B.times[i], B.closes[i]);
    const times = [], aArr = [], bArr = [];
    for (let i = 0; i < A.times.length; i++) { const bv = bm.get(A.times[i]); if (bv === undefined) continue; times.push(A.times[i]); aArr.push(A.closes[i]); bArr.push(bv); }
    const rc = ratioCloses(aArr, bArr);
    const packed = [];
    for (let i = 0; i < times.length; i++) if (rc[i] != null) packed.push([times[i], null, null, null, rc[i], 0]);
    if (packed.length < 8) return { ok: false, error: "not enough overlapping hourly history for these two legs yet" };
    const all = bucketCandles(packed, hours, HOUR);
    const closes = all.map((k) => k.c);
    const ema = emaSeries(closes, RATIO_EMA_SPAN);
    const cut = Math.max(0, all.length - RATIO_SHOW_MAX);
    const sig8 = (v) => +(+v).toPrecision(8);
    const candles = all.slice(cut).map((k) => ({ t: k.t, o: sig8(k.o), h: sig8(k.h), l: sig8(k.l), c: sig8(k.c) }));
    return { ok: true, num: A.name, den: B.name, scope: A.scope, tf: tfk, tfHours: hours,
      candles, bars: all.length, shown: candles.length,
      ema200: ema ? ema.slice(cut).map((v) => (v == null ? null : sig8(v))) : null,
      emaSpan: RATIO_EMA_SPAN, emaMin: RATIO_EMA_MIN, emaReason: ema ? null : "insufficient_bars",
      numBasket: A.basket, denBasket: B.basket, numCov: A.cov, denCov: B.cov,
      spineDays: Math.round((times[times.length - 1] - times[0]) / DAY), floor: BASKET_FLOOR, ts: Date.now() };
  }

  // ===== Actionable board — swing scope (build 2026.07.26-01) =================================
  // One cross-universe list of every name currently AT a swing trigger, with the entry, void and
  // target you would actually use, ranked by expectancy. The candidate set is the OPEN LEDGER
  // itself: every open claim already froze side/void/target at fire time, so this board is a
  // read, a carry-netting and a merge — it re-derives NO geometry. That is deliberate and load-
  // bearing. The moment this file recomputes a level the ledger already owns, the board and the
  // record start answering different questions about the same trade.
  //
  // Swing gate is horizon, not a hand-kept list: an event qualifies when EV_META gives it a
  // horizon of at least ACT_MIN_HZ. That way a future 5d event joins automatically and a 1d
  // scalp never leaks in, without anyone remembering to edit a set.
  //
  // Entry is the LIVE mark, not the fire-time mark. Reward:risk therefore decays as price walks
  // away from the trigger, and a setup whose void has already been passed drops off the board on
  // its own (netRR returns null on inverted geometry) rather than lingering as a stale row.
  const ACT_MIN_HZ = 3 * DAY;          // days-to-weeks only — 1d events belong to the Signals tab
  const ACT_MIN_HZ_MAIN = 2 * DAY;     // crypto floor: the roster runs compressed horizons, so the equity floor would exclude nearly all of it
  const ACT_MAX_BARS = 10;             // bars in trigger before a setup is considered gone stale
  // Hard floor on net reward:risk. Doubles as the board's kill switch: because R:R is repriced
  // from the LIVE mark every build, a setup that gets chased dies here on its own — no separate
  // "too late" rule is needed, and the two can never disagree about the same row.
  const ACT_MIN_RR = 2.0;
  const ACT_MAX_RR = 20;             // above this the void is a rounding error, not a level
  const ACT_MIN_VOID_PCT = 0.05;     // absolute floor: a void inside 5bps of the mark is not a stop
  const ACT_REC_MIN_N = 8;             // resolved fires before an event's hit rate may price EV
  // CONFIRMED gate. This board makes SUGGESTIONS, and most events in the ledger do not deserve
  // one: the record is full of families whose realized expectancy is flat or negative, which is
  // the honest outcome of testing things out of sample. An earlier cut of this board gated only
  // on "does a hit rate exist" (n >= 8) and let negative-expectancy families through to sort at
  // the bottom — a list of things not worth doing, presented as things to do.
  //
  // A row is now shown ONLY if all of these hold. Anything failing is DROPPED, not demoted:
  //   n >= ACT_REC_MIN_N      a record exists at all
  //   avg > 0                 those fires actually paid, on average, out of sample
  //   evR > 0                 and THIS entry still models positive after carry and lateness
  //   net R:R >= ACT_MIN_RR   the geometry is worth a swing slot
  //   !noedge                 not on the engine's hard no-live-edge guard
  //
  // avg and evR are deliberately both required and are not the same test. avg is retrospective —
  // did this family pay. evR is prospective on this instance — does it still pay from here, at
  // this price, with this funding. A family with a strong average that has been chased to a thin
  // R:R fails evR while passing avg, and should not be suggested.
  //
  // Setups still accruing a record are NOT shown here and do not get a second section: the
  // strategy panel (STRAT_DEFS / shadowRecord) already exists to watch them earn one.
  //
  // Note on hit rate: the engine's `prime` heuristic also requires hit >= 0.6. That is
  // deliberately NOT enforced here — a 45%-hit setup at 3:1 is excellent, and low-hit /
  // high-payoff is precisely the swing profile. The fire-time prime verdict already stamped on
  // the claim (e.pr) ships as a badge instead, so the information is visible without over-
  // filtering. Enforcing it would be one added condition in actConfirm.
  function actConfirm(rec, evR, rr, ev) {
    if (!rec || !(rec.n >= ACT_REC_MIN_N)) return "norecord";
    if (!(rec.avgR > 0)) return "negexp";   // field is avgR, per actRecord — not avg
    if (evR == null || !(evR > 0)) return "negev";
    if (liveNoEdge(ev)) return "noedge";
    return null;
  }
  // Row class, not a gate (2026.07.26-13). Freezing R:R at fire exposed that the roster is two
  // structurally different families: level-triggered setups (breakout, tretest, reclaim) whose
  // stop sits at a real chart level close to entry and whose frozen ratios run 2-8x, and
  // sigma-built setups (bigmove, fpdiv, mapull) whose target is the study MEDIAN against a 1-sigma
  // void — 0.5-1.0x at fire, by construction, forever. The old 2:1 floor silently deleted the
  // second family the moment the ratio stopped being drift-inflated. Neither family is wrong:
  // one wins big rarely, the other wins small often, and EV>0 (which both must still clear) is
  // the number that actually prices that difference. So the floor became a TAG and the reader
  // chooses which families the board shows — server ships both, classified, and the client's
  // checkboxes filter. "rr" = frozen ratio clears ACT_MIN_RR; "ev" = it does not, but the
  // expectancy is positive anyway: a grinder, not a windfall.
  function actClass(rr) { return rr && rr.gross >= ACT_MIN_RR ? "rr" : "ev"; }
  const ACT_MS = 60 * 1000;            // memo window; inputs move on signal builds, not per request
  let actCache = null, actBuilt = 0, actSig = "", actVer = 0;

  // ===== settled board record (build 2026.07.27-15) ============================================
  // The board's OWN out-of-sample record: every suggestion it ever surfaced becomes an "episode"
  // the moment it first appears, stamped with everything the board was claiming at that instant —
  // the frozen geometry, the displayed R:R/EV/record, the setup class, and crucially the live mark.
  // The stamp never changes. When the underlying ledger claim resolves, the episode resolves with
  // it — ON or OFF the board: dropping a row is a display decision, and the record does not get to
  // forget what it recommended. Once shown, always scored.
  //
  // One episode per claim key. A row that blinks off (the mark wobbles through a gate) and returns
  // while its claim is still open is the SAME episode — flick counts the fold, the original stamp
  // stands. Without this, a choppy tape logs one setup five times and manufactures sample size.
  //
  // Two scores per resolved episode, split by the row's frozen CLASS (rr = the ">=2:1 at fire"
  // family, ev = the sub-2:1 positive-expectancy grinders — actClass's split, not a new one):
  //   rE — realized R at the fire mark, the basis the family record was scored on ("were the plans
  //        good"); rM — realized R from the mark at FIRST APPEARANCE ("what acting on the board
  //        got"). avg(rE) - avg(rM) is the board's measured lateness cost.
  // Outcome kind comes from epResolve's walk of the hourly spine (void touch / target touch /
  // expired between them; a both-touch candle is pessimistically the void). The record starts at
  // zero on deploy — past appearances were never logged, and no backfill is claimed.
  const BOARD_EP_KEEP = 400;    // resolved episodes retained (memory + persistence)
  const BOARD_EP_SHIP = 120;    // shipped on the payload, newest last
  let boardEp = new Map();      // claim key -> open episode
  let boardEpClosed = [];       // resolved episodes, oldest first
  // fire->shown decomposition (2026.08.03-07): claim key -> { t, b } — the first buildActionable
  // pass that EVALUATED the claim (candidate loop entry, before any gate). b=1 marks a claim that
  // FIRED before this process existed and carried no hydrated stamp: it may have been evaluable
  // long before boot, so its stamp is a lower bound and its episode is excluded from the split
  // aggregates (mirroring bt). Claims fired BY this process are properly timed from their first
  // build regardless — the epoch test, not a first-build flag, draws the honest line. Persisted
  // with the episodes: a deploy is not an evaluation.
  let actEval = new Map();
  const actEvalEpoch = Date.now();
  let boardEpSince = 0;         // first scan ever — the record's own out-of-sample epoch
  let boardEpDropped = 0;       // shown but unscoreable (claim voided/purged, or no exit price) — disclosed, never silent
  // First scan after process start. An episode opened on it, for a claim that fired well before
  // this process existed, carries a first-shown stamp that is only a LOWER BOUND on visibility —
  // the row may have been on the board while no process was watching (feature-first deploy, lost
  // blob, or a mid-flight restart). Such episodes are stamped `bt`, disclosed in the UI, and
  // EXCLUDED from the headline lateness: blaming the board's surfacing with a boot artifact would
  // manufacture the very number the settled record exists to measure. A claim that fired within
  // ~the current build window could not have been shown earlier, so it never earns the stamp.
  let boardEpBoot = true;
  const BOARD_EP_BT_MS = 30 * 60 * 1000;

  function boardEpScan(board, now) {
    if (!boardEpSince) { boardEpSince = now; ledgerDirty = true; }
    const present = new Set();
    for (const rw of board) {
      if (!rw.k) continue;
      present.add(rw.k);
      const ep = boardEp.get(rw.k);
      if (ep) { if (ep.off) { ep.flick = (ep.flick || 0) + 1; ep.off = 0; ledgerDirty = true; } continue; }
      const ev0 = actEval.get(rw.k);
      const nu = { k: rw.k, coin: rw.coin, t: rw.t, uni: rw.uni, ev: rw.ev, label: rw.label,
        cls: rw.cls, side: rw.side, tShow: now, markShow: rw.entry, fired: rw.fired,
        void: rw.void, target: rw.target, rr: rw.rr ? rw.rr.gross : null, evR: rw.evR,
        rec: rw.rec ? { n: rw.rec.n, hit: rw.rec.hit } : null, tFire: rw.t0, flick: 0, off: 0,
        // first-evaluated stamp, frozen at episode open. A row can only be ON the board because a
        // build evaluated it, so a missing stamp here means hydration loss — left absent, and the
        // split math refuses the episode rather than inventing a build time.
        tBld: ev0 ? ev0.t : undefined, be: ev0 && ev0.b ? 1 : undefined };
      if (boardEpBoot && Number.isFinite(rw.t0) && now - rw.t0 > BOARD_EP_BT_MS) nu.bt = 1;
      boardEp.set(rw.k, nu);
      ledgerDirty = true;
    }
    boardEpBoot = false;
    // merge losers were never SHOWN — only the merged winner opened an episode; a row missing this
    // build marks off (the flicker gate), it does not resolve anything.
    for (const ep of boardEp.values()) if (!present.has(ep.k) && !ep.off) { ep.off = now; ledgerDirty = true; }
  }

  function boardEpSweep(now) {
    for (const [k, ep] of [...boardEp]) {
      if (ledgerOpen.has(k)) continue;   // claim still live — the episode waits, shown or not
      boardEp.delete(k); ledgerDirty = true;
      let cl = null;   // recent closes live at the tail; scan backwards
      for (let i = ledgerClosed.length - 1; i >= 0; i--) if (ledgerClosed[i].key === k) { cl = ledgerClosed[i]; break; }
      if (!cl || cl.status !== "resolved") { boardEpDropped++; continue; }
      const tEnd = cl.tR || now;
      const hs = getHourly(ep.coin);
      const res = epResolve(hs, ep.tShow, tEnd, ep.side, ep.void, ep.target);
      const exitPx = res.kind === "expired" ? priceAsOf(hs, tEnd, 3 * HOUR) : null;
      const rE = epScore(ep.side, ep.fired, ep.void, ep.target, res.kind, exitPx);
      const rM = epScore(ep.side, ep.markShow, ep.void, ep.target, res.kind, exitPx);
      if (rE == null || rM == null) { boardEpDropped++; continue; }   // no exit price at expiry — unscoreable, counted
      const done = { k: ep.k, coin: ep.coin, t: ep.t, uni: ep.uni, ev: ep.ev, label: ep.label,
        cls: ep.cls, side: ep.side, tShow: ep.tShow, markShow: ep.markShow, fired: ep.fired,
        void: ep.void, target: ep.target, rr: ep.rr, evR: ep.evR, rec: ep.rec, tFire: ep.tFire,
        tBld: ep.tBld, be: ep.be, flick: ep.flick || 0, tRes: tEnd, kind: res.kind, rE, rM,
        held: Math.max(0, (res.tHit || tEnd) - ep.tShow) };
      // The price the score came from is part of the score. Target/void exits are their frozen
      // levels (already on the episode); an expiry's exit mark existed only in this sweep — an
      // "expired +0.05R" row with no visible price asks for trust the record never needs to ask.
      if (res.kind === "expired" && Number.isFinite(exitPx) && exitPx > 0) done.exitPx = sig(exitPx, 9);
      if (ep.bt) done.bt = 1;
      if (res.approx) done.approx = 1;   // spine gap: touch state unknowable, scored at endpoints — labeled
      boardEpClosed.push(done);
      if (boardEpClosed.length > BOARD_EP_KEEP) boardEpClosed = boardEpClosed.slice(-BOARD_EP_KEEP);
    }
  }

  function boardSettled() {
    // Correlated same-build clusters. Resolved episodes of ONE family and side first shown on the
    // SAME scan are one market condition observed several times, not independent samples —
    // funding extremes are the canonical case: one funding episode fires half the alt roster at
    // once and the gate surfaces them all on one build. An untagged n silently overstates the
    // record, which is exactly the sin the fundext persistence floor exists to prevent upstream.
    const corKey = (e) => e.ev + "|" + e.side + "|" + e.tShow;
    const corMap = new Map();
    for (const e of boardEpClosed) corMap.set(corKey(e), (corMap.get(corKey(e)) || 0) + 1);
    const mk = () => ({ n: 0, t: 0, v: 0, x: 0, xp: 0, xn: 0, approx: 0, hit: null, avgE: null, avgM: null, pf: null, _sE: 0, _sM: 0, _gw: 0, _gl: 0 });
    const uniObj = () => ({ cls: { rr: mk(), ev: mk() }, all: mk(), lat: null, latN: 0, btN: 0, clus: 0, open: 0, flick: 0, _lE: 0, _lM: 0 });
    const per = { stocks: uniObj(), crypto: crypto ? uniObj() : null };
    const add = (b, e) => { b.n++; b[e.kind === "target" ? "t" : e.kind === "void" ? "v" : "x"]++;
      // Expiries are partial outcomes by construction — neither level was reached. They are
      // split by the sign of R@SHOWN (the basis a reader could actually have had) and NEVER
      // counted as hits, so a favorable drift can't pad the rate the geometry promised.
      if (e.kind === "expired") { if (e.rM > 0) b.xp++; else b.xn++; }
      if (e.approx) b.approx++;
      // Profit factor prices the SHOWN basis. The fire mark is a counterfactual nobody watching
      // the board could trade; a pf built on it flatters the record with untradeable R.
      if (e.rM > 0) b._gw += e.rM; else b._gl += -e.rM;
      b._sE += e.rE; b._sM += e.rM; };
    const fin = (b) => { if (b.n) {
      // hit = targets over level-touched resolutions ONLY. Null when nothing touched a level —
      // "100% hit" over pure expiries was a real bug this replaces, not a hypothetical.
      b.hit = (b.t + b.v) ? +(b.t / (b.t + b.v)).toFixed(3) : null;
      b.avgE = +(b._sE / b.n).toFixed(2); b.avgM = +(b._sM / b.n).toFixed(2);
      b.pf = b._gl > 0 ? +(b._gw / b._gl).toFixed(2) : null; }
      delete b._sE; delete b._sM; delete b._gw; delete b._gl; return b; };
    const clusSeen = { stocks: new Set(), crypto: new Set() };
    for (const e of boardEpClosed) { const u = per[e.uni]; if (!u) continue;
      add(u.cls[e.cls === "ev" ? "ev" : "rr"], e); add(u.all, e); u.flick += e.flick || 0;
      // Lateness only over episodes with a trustworthy first-shown stamp — bt stamps are lower
      // bounds on visibility and would inflate the very cost this number measures.
      if (e.bt) u.btN++; else { u._lE += e.rE; u._lM += e.rM; u.latN++; }
      if ((corMap.get(corKey(e)) || 0) > 1 && clusSeen[e.uni]) clusSeen[e.uni].add(corKey(e)); }
    for (const ep of boardEp.values()) { const u = per[ep.uni]; if (u) { u.open++; u.flick += ep.flick || 0; } }
    for (const key of ["stocks", "crypto"]) { const u = per[key]; if (!u) continue;
      fin(u.cls.rr); fin(u.cls.ev); fin(u.all);
      u.lat = u.latN ? +((u._lE - u._lM) / u.latN).toFixed(2) : null;
      u.clus = clusSeen[key].size;
      // fire->shown split over this universe's resolved episodes: cadence (fire -> first
      // evaluating build) vs gating (that build -> first shown). Pre-stamp / lower-bound
      // episodes are excluded and the exclusion count ships — dashes over invented numbers.
      u.split = epLatSplit(boardEpClosed.filter((e) => e.uni === key));
      delete u._lE; delete u._lM; }
    return { since: boardEpSince || null, dropped: boardEpDropped, perUni: per,
      episodes: boardEpClosed.slice(-BOARD_EP_SHIP).map((e) => {
        const c = corMap.get(corKey(e)) || 0;
        return c > 1 ? Object.assign({}, e, { cor: c }) : e; }) };
  }
  // Labels come from the two places that already own them — the signals engine's EV_LABEL and the
  // strategy panel's STRAT_DEFS — so a renamed setup can't read one way here and another there.
  const ACT_LABEL = (() => {
    const m = Object.assign({}, EV_LABEL);
    for (const d of STRAT_DEFS) if (!m[d.ev]) m[d.ev] = d.label;
    return m;
  })();

  // Out-of-sample record for one event family, split by ledger visibility so a shadow setup can
  // never borrow the visible engine's record. Same exclusions the honesty badges use: resolved
  // only, finite outcome, and legacy pre-sigma outcomes stay out of the R aggregates.
  function actRecord(ev, shadow) {
    let n = 0, w = 0, sum = 0;
    for (const e of ledgerClosed) {
      if (e.ev !== ev || e.status !== "resolved" || !Number.isFinite(e.realized)) continue;
      if (shadow ? e.vi == null : e.vi != null) continue;
      if (R_LEDGER_EVS.has(e.ev) && !(e.sd0 > 0)) continue;
      n++; sum += e.realized; if (e.realized > 0) w++;
    }
    if (!n) return { n: 0, hit: null, avgR: null };
    return { n, hit: +(w / n).toFixed(3), avgR: +(sum / n).toFixed(2) };
  }

  async function buildActionable() {
    let yN = 0;   // yield counter — the actRecord scans per claim are the weight here
    const now = Date.now();
    const recMemo = new Map();
    const recOf = (ev, shadow) => {
      const k = ev + "|" + (shadow ? 1 : 0);
      if (!recMemo.has(k)) recMemo.set(k, actRecord(ev, shadow));
      return recMemo.get(k);
    };
    const cands = [];
    const rej = { expired: 0, noGeometry: 0, degenerate: 0, untakeable: 0, norecord: 0, negexp: 0, negev: 0, noedge: 0 };
    for (const e of ledgerOpen.values()) {
      if (e.ev === "airead") continue;                          // the analyst's own claim, not a setup
      // Evaluation stamp, BEFORE any gate: "a build looked at this claim" is true from here on,
      // whether or not the row survives the gates below — that is exactly the boundary between
      // the cadence component and the gate component of the fire->shown split.
      if (e.vi == null && !actEval.has(e.key)) { actEval.set(e.key, { t: now, b: Number.isFinite(e.t0) && e.t0 < actEvalEpoch ? 1 : 0 }); ledgerDirty = true; }
      if (++yN % BUILD_YIELD_EVERY === 0) await buildYield();
      const r = rows.get(e.coin);
      if (!r || r.delisted || !(r.px > 0)) continue;
      if (r.uni === "main" && !crypto) continue;
      // Horizon meta follows the UNIVERSE (2026.07.26-08). Reading the shared EV_META here would
      // price every crypto setup against an equity horizon: a crypto breakout resolves in 2d, and
      // carryR/horizonD/EV would all have been computed against 5d.
      const meta = evMeta(e.ev, r.uni);
      // Swing horizons only — sub-threshold events belong to the Signals tab. The floor is
      // per-universe because "swing" is a different length on a 24/7 tape running compressed
      // horizons: at the equity floor of 3d almost the entire crypto roster would be excluded and
      // the crypto board would ship permanently empty for a reason no one could see. At 2d the
      // crypto swing setups qualify while the genuinely fast events (casc 12h, bigmove 12h,
      // wickfill 1d) correctly stay out.
      const minHz = r.uni === "main" ? ACT_MIN_HZ_MAIN : ACT_MIN_HZ;
      if (!meta || !(meta.horizonMs >= minHz)) continue;
      const side = e.psd || (e.dir >= 0 ? "long" : "short");
      if (side !== "long" && side !== "short") continue;
      // Frozen geometry, read verbatim: the void is the claim's stamped stop, the target is
      // reconstructed from the stamped target distance against the fire-time mark. No level here
      // is computed from live data. (Pre-existing crash fixed here: this counter was an undeclared
      // `noGeom`, so under "use strict" every claim without a stamped stop or target distance threw
      // a ReferenceError out of the build. getActionable swallows it and logs, so the symptom was an
      // Actionable board that went silently stale for a memo window at a time — fundflip stamps a
      // null target by design, which is enough to trip it.)
      if (!(e.stp > 0) || e.mv == null || !Number.isFinite(+e.mv) || !(e.mark0 > 0)) { rej.noGeometry++; continue; }
      const target = side === "long" ? e.mark0 * (1 + +e.mv / 100) : e.mark0 * (1 - +e.mv / 100);
      const tf = e.tf && ACT_TF_MS[e.tf] ? e.tf : "D1";
      const bars = barsInTrigger(e.t0, now, tf);
      if (bars != null && bars > ACT_MAX_BARS) { rej.expired++; continue; }
      // Carry is computed against the FROZEN entry so it describes the claim, not a drifting mark.
      // It is disclosed as its own line and deliberately never folded into R:R or EV: funding
      // accrues on time held while R:R resolves on price, it is an extrapolation of the current
      // rate rather than a locked one, and folding it in let a sub-threshold setup clear the
      // ACT_MIN_RR gate on funding alone.
      const carry = carryR({ side, entry: e.mark0, stop: e.stp, horizonMs: meta.horizonMs, fundingHourly: r.funding });
      // R:R is FROZEN at the fire mark. Computing it against the live price made the ratio climb
      // as price approached the void — risk is the denominator, so an entry one tick from
      // invalidation scored an unbounded R:R and sorted straight to the top of the board, which
      // meant the board ranked on proximity to being stopped out. It also silently broke the EV:
      // rec.hit was measured on claims entered AT FIRE, and applying that hit rate to a
      // much-closer-to-void entry overstates expectancy by exactly however far the mark has
      // drifted. A frozen ratio and a fire-measured hit rate describe the same trade again.
      const rr = netRR({ side, entry: e.mark0, stop: e.stp, target });
      if (!rr) { rej.noGeometry++; continue; }                   // the claim's own geometry never made sense
      // Degenerate-void guard. Risk is the denominator, so a void a few basis points from the fire
      // mark does not produce a tight setup — it produces an artifact: a 0.035% void against a 13.8%
      // target is 395:1, and setupEV turns that into an expectancy of +236R. No swing trade has ever
      // had those numbers; what it has is a stop level that landed on top of the entry. The unwind
      // and squeeze playbooks are the usual source, because their voids are a fixed fraction of the
      // 30d range regardless of where price actually sits in it, so whenever price happens to sit at
      // that same fraction the void collapses onto the mark.
      // Two checks, deliberately NOT a sigma floor. Level-triggered events (breakout, tretest,
      // reclaim) put the void AT the level, and at fire the level is close to the mark by
      // construction — that closeness IS the trade, and on a high-sigma crypto name it can sit
      // well under any reasonable fraction of daily sigma while being a perfectly real stop. A
      // sigma floor here rejected exactly the setups whose geometry is most trustworthy (the
      // first version of this guard did, and blanked the crypto board's tretest rows). What
      // separates PALLADIUM's artifact from ETH's breakout is not sigma — it is that the ratio
      // itself is absurd and the void is inside the bid-ask. Hence: an absolute 5bp floor, and a
      // ceiling on the ratio that no genuine swing claim reaches.
      const voidPct = (Math.abs(e.mark0 - e.stp) / e.mark0) * 100;
      if (rr.gross > ACT_MAX_RR || voidPct < ACT_MIN_VOID_PCT) { rej.degenerate++; continue; }
      // Separately: is it still takeable HERE? A claim can be perfectly framed at fire and already
      // dead now. Different question, own reject reason.
      if (!tradeableNow(side, r.px, e.stp, target)) { rej.untakeable++; continue; }
      const shadow = e.vi != null;
      const rec = recOf(e.ev, shadow);
      const evR = setupEV(rec.hit, rr.gross, rec.n, ACT_REC_MIN_N);
      // Gate BEFORE the merge, deliberately: merging first could let an unconfirmed candidate with
      // a flattering EV win a name+side and then be rejected, losing a confirmed row that was
      // sitting right behind it. Gate first, and the merge only ever arbitrates between setups
      // that were each independently worth suggesting.
      const why = actConfirm(rec, evR, rr, e.ev);
      if (why) { rej[why] = (rej[why] || 0) + 1; continue; }
      // Earnings inside the horizon is a binary the base rate cannot see. Flagged, never filtered
      // — standing aside is the reader's call, and pead deliberately trades the aftermath.
      let earn = null;
      if (r.uni === "xyz") {
        const ep = earnProx(r.ticker);
        if (ep && ep.diff != null && ep.diff * DAY <= meta.horizonMs) earn = { d: ep.e.d, s: ep.e.s, days: ep.diff };
      }
      // Universe-wide macro binaries inside this setup's horizon — both universes, capped at two
      // (the nearest carry the risk; a third is noise). Flagged, never filtered, like earnings.
      let mac = null;
      { const mw = macroWithin(macroCache && macroCache.entries || [], now, meta.horizonMs).slice(0, 2);
        if (mw.length) mac = mw.map((m) => ({ k: m.k, label: m.label, d: m.d, tEt: m.tEt, days: m.days })); }
      cands.push({
        // k = the underlying claim's ledger key. The settled record is keyed on it — one episode
        // per claim, however often the row blinks. Ships on the payload (harmless) but the client
        // never renders it.
        k: e.key, coin: e.coin, t: r.ticker, uni: r.uni === "main" ? "crypto" : "stocks", side,
        ev: e.ev, label: ACT_LABEL[e.ev] || e.ev, shadow, cls: actClass(rr),
        // Fire-time prime verdict, already frozen on the claim by the signals engine. Shown as a
        // badge, NOT enforced — see actConfirm on why its hit>=0.6 floor is not a gate here.
        prime: e.pr === true ? true : (e.pr === false ? false : null),
        tf, t0: e.t0, bars, stale: bars != null && bars >= Math.ceil(ACT_MAX_BARS * 0.7),
        // Both marks, always. `fired` is the entry the track record was scored on; `entry` is
        // what buying now costs. `late` is the distance between them in the setup's own risk
        // unit — the honest measure of how much edge is already spent before you are in.
        fired: sig(e.mark0, 9), entry: sig(r.px, 9), void: sig(e.stp, 9), target: sig(target, 9),
        late: lateR(side, e.mark0, r.px, e.stp),
        rr, carry, evR, rec: { n: rec.n, hit: rec.hit, avgR: rec.avgR },
        horizonD: +(meta.horizonMs / DAY).toFixed(0), earn, mac,
      });
    }
    // Newest first: the default the board opens on. The client may re-sort any column, but the
    // server ships a deterministic order so a cold render is never arbitrary.
    // NB: not named `rows` — that identifier is the poller's markets Map at module scope.
    const board = mergeActionable(cands).sort((a, b) => (b.t0 || 0) - (a.t0 || 0)
      || (b.evR == null ? -Infinity : b.evR) - (a.evR == null ? -Infinity : a.evR)
      || (a.coin < b.coin ? -1 : a.coin > b.coin ? 1 : 0));
    // Episode lifecycle runs INSIDE the build, on the poller's clock — an episode opens whether or
    // not anyone has the tab open, exactly like the trigger stream below. Scan (open/fold) before
    // sweep (resolve): a row present this build whose claim resolved this same build still gets
    // its flicker fold recorded before the sweep closes it.
    boardEpScan(board, now);
    boardEpSweep(now);
    // Stamp hygiene: a stamp whose claim closed AND whose episode is gone has no consumer left.
    // Open episodes already copied their tBld at open, so this prune can never orphan one.
    for (const k of [...actEval.keys()]) if (!ledgerOpen.has(k) && !boardEp.has(k)) actEval.delete(k);
    const settled = boardSettled();
    const sigA = JSON.stringify(board.map((x) => [x.coin, x.side, x.ev, x.bars, x.rr.gross, x.evR]))
      // the settled record must bust the ETag: a resolution or a new episode changes the tab's
      // content with an unchanged live board
      + "|" + boardEpClosed.length + "|" + (boardEpClosed.length ? boardEpClosed[boardEpClosed.length - 1].k : "") + "|" + boardEp.size + "|" + boardEpDropped;
    if (sigA !== actSig) { actSig = sigA; actVer = Math.max(Date.now(), actVer + 1); }   // monotonic: two content changes in one ms must not share an ETag
    actBuilt = now;
    actCache = { ts: now, dataTs: actVer, settled,
      params: { minHorizonDays: ACT_MIN_HZ / DAY, minHorizonDaysCrypto: crypto ? ACT_MIN_HZ_MAIN / DAY : null, maxBars: ACT_MAX_BARS, minRR: ACT_MIN_RR,
        recMinN: ACT_REC_MIN_N, netOfCarry: true, tfs: ["D1", "H12", "H4"],
        gate: "confirmed", requires: ["n>=" + ACT_REC_MIN_N, "avgR>0", "EV>0", "R:R<=" + ACT_MAX_RR, "!noedge"], rrFloor: ACT_MIN_RR },
      coverage: Object.assign({ confirmed: board.length, openClaims: ledgerOpen.size }, rej),
      rows: board, count: board.length };
    // Detection runs on the poller's clock as part of the build, so a trigger is recorded whether
    // or not anyone has the tab open — the precondition for any push transport.
    try { trigScan(board, now); }
    catch (err) { log("trigScan error (isolated, board still served): " + (err && err.message)); }
  }
  // ---- trigger stream (Telegram-ready foundation) --------------------------------------------
  // Detection lives HERE, not in the browser, and that is the whole point of this layer. A toast
  // built in app.js would mean a future Telegram push needs its own duplicate notion of "new",
  // its own dedup and its own idea of which setups are worth interrupting someone for — three
  // chances to disagree with the screen. Instead the poller owns one canonical, sequenced event
  // stream, persisted across restarts, and each TRANSPORT (browser toast today, Telegram bot
  // later, anything else after) is a thin consumer that applies its own eligibility filter.
  //
  // Eligibility deliberately does NOT gate the stream — every genuinely new trigger is emitted.
  // A channel's thresholds are a property of the channel, so the browser can read them from the
  // user's own settings while Telegram reads them from server config, without either censoring
  // the record of what actually fired.
  const TRIG_RING = 200;              // events retained for late-joining consumers
  const TRIG_RECENT = 40;             // events shipped for DISPLAY on every pull, cursor-independent
  const TRIG_SEEN_TTL = 21 * DAY;     // prune announced keys past any plausible swing horizon
  const TRIG_GRACE_MS = 2 * HOUR;     // see below — the anti-blast rule on the first build
  let trigSeen = new Map();           // trigKey -> ts announced
  let trigEvents = [];                // sequenced, oldest first
  let trigSeq = 0, trigDirty = false, trigFirstBuild = true;

  function hydrateTriggers() {
    const d = store.loadTriggers ? store.loadTriggers() : null;
    if (!d) return false;
    if (Array.isArray(d.seen)) for (const kv of d.seen) if (Array.isArray(kv) && typeof kv[0] === "string") trigSeen.set(kv[0], +kv[1] || 0);
    if (Array.isArray(d.events)) trigEvents = d.events
      .filter((e) => e && (typeof e.coin === "string" || e.kind === "ops"))
      .map((e) => (e.kind ? e : Object.assign({ kind: "setup" }, e)))   // pre-`kind` events are setups — that is all the ring held
      .slice(-TRIG_RING);
    trigSeq = Number.isFinite(d.seq) ? d.seq : (trigEvents.length ? trigEvents[trigEvents.length - 1].seq || 0 : 0);
    // Rate history survives the restart: a meter that zeroes on every deploy would under-report
    // exactly the classes worth measuring, since a noisy class and a frequent deploy look alike.
    if (Array.isArray(d.rates)) for (const kv of d.rates)
      if (Array.isArray(kv) && typeof kv[0] === "string" && Array.isArray(kv[1]))
        classFires.set(kv[0], kv[1].filter((t) => Number.isFinite(t)));
    const ep = d.episodes || {};
    const loadMap = (arr, map) => { if (Array.isArray(arr)) for (const kv of arr) if (Array.isArray(kv)) map.set(kv[0], kv[1]); };
    loadMap(ep.trend, trendState); loadMap(ep.ma200, maState); loadMap(ep.regime, regimeArmed); loadMap(ep.coverage, coverageArmed); loadMap(ep.earn, earnAlerted);
    loadMap(ep.macro, macroAlerted);
    if (typeof ep.earnPrevDay === "string") earnPrevDay = ep.earnPrevDay;
    if (Array.isArray(ep.filings)) for (const id of ep.filings) if (typeof id === "string") filingSeen.add(id);
    // Restored state IS the seed, so the priming delay would only eat real transitions. A genuinely
    // fresh boot (nothing restored) still gets the full silent seeding pass.
    if (trendState.size) trendPrimed = true;
    if (maState.size) maPrimed = true;
    if (filingSeen.size) filingPrimed = true;
    if (macroAlerted.size) macroPrimed = true;
    return true;
  }
  function persistTriggers() {
    if (!store.saveTriggers) return;
    const cut = Date.now() - TRIG_SEEN_TTL;
    for (const [k, t] of trigSeen) if (t < cut) trigSeen.delete(k);
    store.saveTriggers({ seq: trigSeq, seen: [...trigSeen.entries()], events: trigEvents.slice(-TRIG_RING),
      rates: [...classFires.entries()].map(([k, a]) => [k, a.slice(-CLASS_RATE_MAX)]),
      // Episode state rides along. Without this, every deploy re-seeded every scan silently — and
      // this app deploys once per pushed FILE, so a trend cross had to complete entirely between
      // two deploys to ever fire. "The trend alerts don't exist" was the accurate description of
      // the result. Persisting the seeds is what turns these classes from theoretical into real.
      episodes: {
        trend: [...trendState.entries()].slice(-500),
        ma200: [...maState.entries()].slice(-500),
        regime: [...regimeArmed.entries()],
        coverage: [...coverageArmed.entries()].slice(-200),
        filings: [...filingSeen].slice(-FILING_SEEN_MAX),
        earn: [...earnAlerted.entries()].slice(-400),
        // Without these two a redeploy re-announces the afternoon's CPI print and re-sends the
        // daily calendar — and this app deploys once per pushed FILE. Same lesson as the trend
        // seeds, one class later.
        macro: [...macroAlerted.entries()].slice(-MACRO_ALERTED_MAX),
        earnPrevDay: earnPrevDay || null,
      } });
    trigDirty = false;
  }
  // ONE emitter for the ONE stream. Every class — setups today, ops here, the rest in later
  // slices — enters the ring through this function and is stamped with its `kind`, so a consumer
  // (browser toast, Telegram, anything after) filters on a field that always exists rather than
  // inferring class from which fields happen to be present. Legacy events persisted before this
  // stamp existed read as "setup" at hydrate, which is what they are.
  // NB: `kind`, not `cls` — actionable rows already carry a `cls` (the R:R class).
  // Rolling per-class fire counts. This exists because I shipped a deploy notice that fired four
  // or five times per build and only found out when it became annoying. Guessing a class's
  // frequency from the roster size is not good enough; measuring it is cheap. The panel shows
  // fires-per-day next to each class so a subscription is an informed choice rather than a bet.
  const CLASS_RATE_MAX = 400;   // per class; ~17/hour sustained before the window truncates
  const classFires = new Map();   // kind -> [ts, ...] within 24h
  function noteClassFire(kind, t) {
    let a = classFires.get(kind);
    if (!a) { a = []; classFires.set(kind, a); }
    a.push(t);
    const cut = t - 24 * 3600e3;
    while (a.length && a[0] < cut) a.shift();
    if (a.length > CLASS_RATE_MAX) a.splice(0, a.length - CLASS_RATE_MAX);
  }
  function getClassRates() {
    const now = Date.now(), out = {};
    for (const k of PUSH_CLASSES) {
      const a = classFires.get(k) || [];
      const cut = now - 24 * 3600e3, h = now - 3600e3;
      const d1 = a.filter((t) => t >= cut).length;
      out[k] = { d1, h1: a.filter((t) => t >= h).length,
        // The count is truncated at the cap, so a very noisy class reports "400+" rather than a
        // number that quietly understates it.
        capped: d1 >= CLASS_RATE_MAX,
        dflt: PUSH_DEFAULT_CLASSES.includes(k) };
    }
    return out;
  }
  function emitTrig(kind, obj, now) {
    const ev = Object.assign({ seq: ++trigSeq, at: now || Date.now(), kind }, obj);
    noteClassFire(kind, ev.at);
    trigEvents.push(ev);
    if (trigEvents.length > TRIG_RING) trigEvents = trigEvents.slice(-TRIG_RING);
    trigDirty = true;
    return ev;
  }
  // The ops lane: the server telling on itself. Edge-triggered by construction — every caller
  // holds its own "already reported" flag and clears it on recovery, because an ops alert that
  // repeats every tick is worse than no ops alert at all (you learn to ignore the channel, and
  // then you miss the real one). Cheap enough to be unconditional: if nobody is linked, the event
  // still enters the ring and the panel shows it.
  function pushOps(title, text, level, quiet) {
    const ev = emitTrig("ops", Object.assign({ title: String(title || "ops"), text: String(text || ""), level: level || "info" },
      quiet ? { quiet: 1 } : null));
    persistTriggers();
    log(`ops event: ${title} — ${text}`);
    return ev;
  }

  // Called with the freshly ranked board. Emits one event per newly-seen claim.
  //
  // The anti-blast rule: on the FIRST build after a boot, a new key only announces if the claim
  // itself fired within TRIG_GRACE_MS. Everything older is seeded silently. This covers both the
  // first-ever boot (a full board, none of it news) and a restart after downtime (where the board
  // is full of claims that opened while nobody was listening) with one rule instead of a special
  // case for each — and it is why a redeploy does not detonate twenty notifications.
  function trigScan(rows, now) {
    const fresh = [];
    for (const row of rows) {
      const k = trigKey(row);
      if (!k) continue;
      if (trigSeen.has(k)) continue;
      trigSeen.set(k, now); trigDirty = true;
      if (trigFirstBuild && !(row.t0 > 0 && now - row.t0 <= TRIG_GRACE_MS)) continue;   // seeded, not announced
      const ev = emitTrig("setup", row, now);
      delete ev.also;   // the event is one claim; corroboration is a board concern
      // Mark the underlying claim as ANNOUNCED. This is what entitles it to a death notice later:
      // the ledger class only ever speaks about claims whose birth was announced, so nobody is told
      // a void was taken on a setup they were never told about — and, just as importantly, nobody
      // is told about a birth and then left to find out about the death from the board.
      const le = ledgerOpen.get(row.coin + "|" + row.ev);
      if (le && le.vi == null) { le.alo = 1; ledgerDirty = true; }
      fresh.push(ev);
    }
    trigFirstBuild = false;
    if (trigDirty) persistTriggers();
    if (fresh.length) log(`triggers: ${fresh.length} new setup(s) — ${fresh.map((e) => e.t + " " + e.side).join(", ")}`);
    return fresh;
  }
  // The stream, for any transport. `seq` is the high-water mark: a consumer stores the last seq it
  // handled and takes everything above it, which is restart-safe and refresh-safe in a way that a
  // timestamp comparison is not.
  // An event with an `owner` belongs to one person: it exists because of a rule they wrote, so it
  // is theirs to see. Everything else — setups, ledger outcomes, filings, ops — is about the market
  // or the server and is shared by construction.
  // OWNERSHIP only. Deliberately separate from the admin-class gate below: the delivery path also
  // calls this, and folding the two together blocked ops for operators (a recipient is not "admin"
  // in the see-everyone's-events sense just because they may receive server health).
  const evVisible = (e, owner, isAdmin) => !e.owner || isAdmin || (!!owner && e.owner === owner);
  // Admin-only CLASSES, for the in-app feed. Hiding the chip while still shipping the events would
  // leave the public bell log narrating server faults nobody outside the operator can act on.
  const evClassOk = (e, isAdmin) => !PUSH_ADMIN_CLASSES.includes(e.kind) || !!isAdmin;
  function getTriggers(sinceSeq, owner, isAdmin) {
    const since = Number.isFinite(+sinceSeq) ? +sinceSeq : null;
    // Universe slice (2026.08.03-02): signal-borne kinds (ledger -> signals scopes, setup ->
    // actionable scopes) are filtered by their coin's universe for scoped callers — the bell log
    // and the toast transport read this stream, so hiding a universe from the tabs but announcing
    // its fires here would be the exact one-code-path violation the manifest exists to prevent.
    const sigVis = featureScopeVis(featureFlags, "signals", !!isAdmin);
    const actVis = featureScopeVis(featureFlags, "actionable", !!isAdmin);
    const vis = trigEvents.filter((e) => evClassOk(e, isAdmin) && evVisible(e, owner, isAdmin)
      && scopeEventVisible(e, sigVis, actVis));
    const evs = since == null ? vis.slice(-40) : vis.filter((e) => e.seq > since);
    // `events` and `recent` answer two different questions and a consumer needs both in one round
    // trip: events = what has happened since MY cursor (what to interrupt for, exactly once), and
    // recent = the last N regardless of cursor (what to DISPLAY). Deriving the display list from
    // the cursor is what made the old in-tab log evaporate on refresh — the events had been
    // consumed, so there was nothing left to render.
    return { ts: Date.now(), dataTs: trigSeq, seq: trigSeq,
      params: { ring: TRIG_RING, graceMs: TRIG_GRACE_MS, seenTtlMs: TRIG_SEEN_TTL, recent: TRIG_RECENT },
      known: trigSeen.size, events: evs, count: evs.length,
      recent: vis.slice(-TRIG_RECENT) };
  }


  // ---- telegram push: the wire (slice A) -----------------------------------------------------
  // A SECOND consumer of the stream above, on exactly the same footing as the browser toast. It
  // owns no notion of what is worth announcing — pushEligible/pushFmt in compute.js decide that,
  // shared with the browser — so this block is only three mechanical concerns: who is linked, how
  // a message reaches Telegram without tripping their rate limits, and what happens when it fails.
  //
  // Dormant without TG_BOT_TOKEN: no timers armed, no state written, no log noise. The feature
  // does not exist on a deploy that hasn't been given a bot.
  const PUSH_LINK_TTL = 10 * 60 * 1000;     // a link code is read off a screen and typed into a phone
  const PUSH_SEND_GAP = 3000;               // 1 msg / 3s — Telegram's per-chat ceiling is ~20/min
  const PUSH_CAP_HOUR = 20;                 // per-recipient hourly cap; overflow is DISCLOSED, not dropped silently
  const PUSH_QUEUE_MAX = 50;                // bounded outbox — an unreachable chat cannot grow memory without limit
  const PUSH_GRACE_MS = 5 * 60 * 1000;      // startup grace: the ring may hold events nobody was listening for
  const PUSH_UPDATES_MS = 20 * 1000;        // getUpdates poll — no webhook, no public URL, no extra Railway config
  const PUSH_DRAIN_MS = 1000;               // outbox tick; the gap above does the actual pacing
  const PUSH_MAX_TRIES = 5;
  const PUSH_LOG_RING = 40;
  const pushFetch = pushFetchOpt || ((...a) => fetch(...a));
  const PUSH_TOKEN = () => process.env.TG_BOT_TOKEN || "";
  const pushOn = () => !!PUSH_TOKEN();
  const PUBLIC_URL = () => process.env.PUBLIC_URL || "";

  let pushRecipients = new Map();   // chat -> { chat, name, since, cur, classes, trig, muted, lastOk, lastErr }
  let pushCodes = new Map();        // CODE -> { t }
  let pushOffset = 0;               // getUpdates high-water mark
  let pushQueue = [];               // [{ chat, text, tries, at }]
  let pushHoldUntil = 0;            // global send pacing / 429 backoff
  let pushSending = false, pushDirty = false, pushBootAt = Date.now();
  let pushDropped = 0, pushLog = [], pushLastErr = null, pushLastTest = 0, pushVer = 0;
  let pushStall = false;            // edge state for the poller-stall ops alert

  function hydratePush() {
    const d = store.loadPush ? store.loadPush() : null;
    if (!d) return 0;
    if (Array.isArray(d.recipients)) for (const r of d.recipients) {
      if (!r || !r.chat) continue;
      pushRecipients.set(String(r.chat), {
        owner: typeof r.owner === "string" ? r.owner : "",
        // Recipients linked before ownership existed were linked by the operator, so they keep
        // operator privileges rather than silently losing their ops alerts.
        admin: r.admin === undefined ? !r.owner : !!r.admin,
        chat: String(r.chat), name: r.name || String(r.chat), since: +r.since || Date.now(),
        cur: +r.cur || 0, classes: Array.isArray(r.classes) ? r.classes.filter((c) => PUSH_CLASSES.includes(c)) : null,
        trig: r.trig && typeof r.trig === "object" ? r.trig : {},
        muted: !!r.muted, lastOk: +r.lastOk || null, lastErr: r.lastErr || null,
        quiet: (r.quiet && Number.isFinite(r.quiet.from) && Number.isFinite(r.quiet.to))
          ? { from: +r.quiet.from, to: +r.quiet.to, tz: +r.quiet.tz || 0 } : null,
        digestHour: Number.isFinite(r.digestHour) ? +r.digestHour : null,
        dgSet: r.dgSet ? 1 : 0, tz: Number.isFinite(r.tz) ? +r.tz : null,
        // Migration, not a rewrite: the legacy pair stays on the record (older code paths and the
        // panel's own back-compat read it) and `sched` is derived from it exactly once, when the
        // recipient has no sched yet. Deriving it on EVERY hydrate would silently undo an edit
        // made through the new surface the moment the process restarted.
        sched: (r.sched && typeof r.sched === "object") ? r.sched
          : { brief: { h: Number.isFinite(r.digestHour) ? +r.digestHour : null, set: r.dgSet ? 1 : 0, days: null } } });
    }
    if (Number.isFinite(d.offset)) pushOffset = d.offset;
    return pushRecipients.size;
  }
  function persistPush() {
    pushVer++;
    if (!store.savePush) return;
    store.savePush({ ts: Date.now(), offset: pushOffset, recipients: [...pushRecipients.values()] });
    pushDirty = false;
  }

  // Chat ids are shown to the whole group in the delivery panel, so they are masked there — a chat
  // id is enough to attempt contact, and the panel is not the place to hand one over.
  const pushMask = (chat) => { const s = String(chat); return s.length <= 4 ? s : "\u2026" + s.slice(-4); };

  async function tgApi(method, body) {
    const token = PUSH_TOKEN();
    if (!token) return { ok: false, error: "disabled" };
    let res, j = null;
    try {
      res = await pushFetch(`https://api.telegram.org/bot${token}/${method}`,
        // The only fetch in the repo that had no abort signal: a stalled connection here would
        // hang for undici's ~5-minute defaults, and the outbox drains SEQUENTIALLY — one hung
        // request stalls the whole alert lane. Fail in 15s as the existing "network:" error so
        // the retry/backoff semantics downstream are untouched.
        { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body || {}),
          signal: AbortSignal.timeout(15000) });
    } catch (e) { return { ok: false, error: "network: " + (e && e.message) }; }
    try { j = await res.json(); } catch (_) {}
    if (!res.ok || !j || j.ok !== true) {
      return { ok: false, status: res.status,
        // Telegram puts the actual reason in `description` — surfacing it verbatim is the whole
        // difference between "alerts don't work" and "the token is wrong", and I cannot reach
        // api.telegram.org from a dev sandbox to find out for you.
        error: (j && j.description) || ("http " + (res && res.status)),
        retryAfter: j && j.parameters && +j.parameters.retry_after };
    }
    return { ok: true, result: j.result };
  }

  // ---- linking: /start CODE ------------------------------------------------------------------
  // The code exists so a mistyped chat id cannot silently route someone's alerts to a stranger.
  // Binding is proved in one direction: the server mints, the human carries it into a DM the bot
  // can see, and only then is a chat id trusted. Codes are single-use and short-lived.
  // Who may see and manage a recipient. Admin always; otherwise only the browser that linked it.
  // Recipients carrying no owner predate per-browser linking — they are treated as admin-managed
  // rather than adopted by whoever looks next, because "the first visitor to open the panel inherits
  // someone else's Telegram" is exactly the failure this is fixing.
  function pushOwns(rec, owner, isAdmin) {
    if (isAdmin) return true;
    return !!(rec && rec.owner && owner && rec.owner === owner);
  }
  function pushMintCode(owner, isAdmin) {
    const now = Date.now();
    for (const [c, v] of pushCodes) if (now - v.t > PUSH_LINK_TTL) pushCodes.delete(c);
    let code = "";
    for (let i = 0; i < 6; i++) code += PUSH_CODE_ALPHABET[Math.floor(Math.random() * PUSH_CODE_ALPHABET.length)];
    pushCodes.set(code, { t: now, owner: owner || "", admin: !!isAdmin });
    return { ok: true, code, expiresAt: now + PUSH_LINK_TTL };
  }
  function pushBind(code, chat, name) {
    const c = pushCodeNorm(code);
    if (!pushCodeOk(c)) return { ok: false, error: "bad-code" };
    const rec = pushCodes.get(c);
    if (!rec) return { ok: false, error: "bad-code" };
    if (Date.now() - rec.t > PUSH_LINK_TTL) { pushCodes.delete(c); return { ok: false, error: "expired" }; }
    pushCodes.delete(c);
    const key = String(chat);
    const prev = pushRecipients.get(key);
    pushRecipients.set(key, {
      // The owner rides in on the CODE, so redeeming it in Telegram binds the chat to the browser
      // that generated it. A re-link from a different browser transfers ownership, which is the
      // right behaviour: proving you control the Telegram account is the stronger claim.
      owner: rec.owner || (prev ? prev.owner : "") || "",
      // Admin-ness is stamped at LINK time from the browser that minted the code. Re-linking is how
      // it changes, which is deliberate: an alert channel whose contents silently change when a
      // cookie expires elsewhere is worse than one you re-authorise on purpose.
      admin: !!rec.admin || (prev ? !!prev.admin : false),
      chat: key, name: name || key, since: prev ? prev.since : Date.now(),
      // A new recipient starts CAUGHT UP, never with the backlog: the ring holds up to 200 events
      // and nobody wants their first message from this bot to be two hundred stale setups.
      cur: trigSeq, classes: prev ? prev.classes : null, trig: prev ? prev.trig : {},
      quiet: prev ? prev.quiet : null, digestHour: prev ? prev.digestHour : null,
      // A fresh link inherits the default brief hour by leaving dgSet clear.
      dgSet: prev ? (prev.dgSet ? 1 : 0) : 0, tz: prev && Number.isFinite(prev.tz) ? prev.tz : null,
      muted: false, lastOk: null, lastErr: null });
    persistPush();
    log(`push: linked recipient ${name || key} (${pushMask(key)})`);
    return { ok: true, chat: key };
  }
  function pushUnlink(chat, owner, isAdmin) {
    const key = String(chat);
    if (!pushRecipients.has(key)) return { ok: false, error: "unknown" };
    if (!pushOwns(pushRecipients.get(key), owner, isAdmin)) return { ok: false, error: "forbidden" };
    pushRecipients.delete(key);
    pushQueue = pushQueue.filter((q) => q.chat !== key);
    persistPush();
    log(`push: unlinked recipient ${pushMask(key)}`);
    return { ok: true };
  }
  // Adopt a recipient that predates per-browser ownership. Restricted to UNOWNED rows on purpose:
  // claiming a row someone else owns would be an admin quietly taking over another person's alert
  // channel, which is a different thing entirely from tidying up legacy state.
  function pushClaim(chat, owner, isAdmin) {
    if (!isAdmin) return { ok: false, error: "forbidden" };
    if (!owner) return { ok: false, error: "no-owner" };
    const r = pushRecipients.get(String(chat));
    if (!r) return { ok: false, error: "unknown" };
    if (r.owner) return { ok: false, error: "already-owned" };
    r.owner = owner;
    persistPush();
    log(`push: ${pushMask(r.chat)} claimed by an admin browser`);
    return { ok: true, chat: r.chat };
  }
  function pushSetClasses(chat, classes, owner, isAdmin) {
    const r = pushRecipients.get(String(chat));
    if (!r) return { ok: false, error: "unknown" };
    if (!pushOwns(r, owner, isAdmin)) return { ok: false, error: "forbidden" };
    r.classes = Array.isArray(classes) ? classes.filter((c) => PUSH_CLASSES.includes(c)) : null;
    // An empty selection resets to the DEFAULT set, not to everything and not to silence. Muting is
    // its own control, and "everything" now includes opt-in classes nobody should land in by
    // accidentally clearing a selection.
    if (r.classes && !r.classes.length) r.classes = null;
    persistPush();
    return { ok: true, classes: r.classes };
  }

  async function pushUpdatesTick() {
    if (!pushOn()) return;
    const r = await tgApi("getUpdates", { offset: pushOffset || undefined, timeout: 0, allowed_updates: ["message"] });
    if (!r.ok) { pushLastErr = r.error; return; }
    pushLastErr = null;
    for (const u of r.result || []) {
      if (Number.isFinite(u.update_id)) pushOffset = Math.max(pushOffset, u.update_id + 1);
      const m = u.message;
      if (!m || !m.chat || typeof m.text !== "string") continue;
      const chat = m.chat.id, name = (m.from && (m.from.first_name || m.from.username)) || String(chat);
      const txt = m.text.trim();
      const start = txt.match(/^\/start(?:@\S+)?\s+(\S+)/i);
      if (start) {
        const res = pushBind(start[1], chat, name);
        pushEnqueue(String(chat), res.ok
          ? "<b>Linked.</b>\nYou'll get alerts here. Send /stop to unlink."
          : (res.error === "expired" ? "That code has expired \u2014 generate a new one in the alerts panel."
            : "That code isn't valid \u2014 check the alerts panel for a current one."), true);
        continue;
      }
      if (/^\/stop(?:@\S+)?$/i.test(txt)) {
        const had = pushRecipients.has(String(chat));
        // Authorised by construction: this command arrived FROM that chat, and control of the
        // Telegram account is a stronger claim than any browser handle. /stop must always work —
        // it is the one escape hatch that needs no panel, no cookie and no admin.
        if (had) pushUnlink(chat, null, true);
        pushEnqueue(String(chat), had ? "<b>Unlinked.</b>\nNo further alerts will be sent here." : "You weren't linked.", true);
        continue;
      }
      if (/^\/(status|help)(?:@\S+)?$/i.test(txt)) {
        const r2 = pushRecipients.get(String(chat));
        pushEnqueue(String(chat), r2
          ? "<b>Linked</b> \u00b7 classes: " + (r2.classes && r2.classes.length ? r2.classes.join(", ") : "all")
            + "\n/stop to unlink."
          : "Not linked. Open the alerts panel for a link code, then send /start CODE.", true);
      }
    }
    if (pushOffset) persistPush();
  }

  // ---- outbox ---------------------------------------------------------------------------------
  // Bounded, paced, and never silently lossy: an overflow increments a counter the panel shows and
  // the next delivered message discloses. `force` bypasses the per-recipient hourly cap for replies
  // to a human who just typed a command at the bot — a /stop confirmation is not an alert.
  function pushEnqueue(chat, text, force, after) {
    if (!text) return;
    if (pushQueue.length >= PUSH_QUEUE_MAX) { pushQueue.shift(); pushDropped++; }
    pushQueue.push({ chat: String(chat), text, tries: 0, at: Date.now(), force: !!force, after: after || 0 });
  }
  function pushRecent(chat, now) {
    const r = pushRecipients.get(String(chat));
    if (!r) return 0;
    r.sent = (r.sent || []).filter((t) => now - t < 3600e3);
    return r.sent.length;
  }
  async function pushDrain() {
    if (pushSending || !pushQueue.length || !pushOn()) return;
    const now = Date.now();
    if (now < pushHoldUntil) return;
    // First ELIGIBLE item, not the first item. A message scheduled for the end of a quiet window
    // sitting at the head would otherwise block every urgent one behind it for hours — the same
    // head-of-line failure the undeliverable-message drop had to fix.
    const idx = pushQueue.findIndex((q) => !q.after || q.after <= now);
    if (idx < 0) return;
    const item = pushQueue[idx];
    if (!item.force && pushRecent(item.chat, now) >= PUSH_CAP_HOUR) {
      // Held, not dropped. The cap protects the channel from becoming unreadable; the disclosure
      // protects you from believing silence means nothing fired.
      pushHoldUntil = now + 60 * 1000;
      return;
    }
    pushSending = true;
    try {
      const held = pushDropped;
      const body = held > 0 ? item.text + "\n\n<i>+" + held + " alert(s) dropped \u2014 outbox overflow</i>" : item.text;
      const r = await tgApi("sendMessage",
        { chat_id: item.chat, text: body, parse_mode: "HTML", disable_web_page_preview: true });
      const rec = pushRecipients.get(item.chat);
      if (r.ok) {
        if (held > 0) pushDropped -= held;
        pushQueue.splice(idx, 1);
        if (rec) { rec.lastOk = now; rec.lastErr = null; rec.sent = (rec.sent || []).concat(now); }
        pushHoldUntil = now + PUSH_SEND_GAP;
        pushLogAdd({ t: now, chat: pushMask(item.chat), ok: true });
        pushDirty = true;
      } else if (r.status === 429) {
        pushHoldUntil = now + Math.max(1000, (r.retryAfter || 5) * 1000);   // their number, not ours
        item.tries++;
        pushLogAdd({ t: now, chat: pushMask(item.chat), ok: false, err: "429 rate limit" });
      } else if (r.status === 403) {
        // Blocked or deactivated. Mute rather than unlink: the panel should say WHY someone stopped
        // getting alerts, and an auto-removed row looks like a bug.
        pushQueue = pushQueue.filter((q) => q.chat !== item.chat);
        if (rec) { rec.muted = true; rec.lastErr = r.error || "blocked"; }
        persistPush();
        pushLogAdd({ t: now, chat: pushMask(item.chat), ok: false, err: "blocked \u2014 muted" });
        log(`push: ${pushMask(item.chat)} blocked the bot — muted`);
      } else if (r.status >= 400 && r.status < 500) {
        // A malformed message must never wedge the queue behind itself.
        pushQueue.splice(idx, 1);
        if (rec) rec.lastErr = r.error;
        pushLastErr = r.error;
        pushLogAdd({ t: now, chat: pushMask(item.chat), ok: false, err: r.error });
        log(`push: dropped an undeliverable message to ${pushMask(item.chat)} — ${r.error}`);
      } else {
        item.tries++;
        pushHoldUntil = now + Math.min(60000, 2000 * Math.pow(2, item.tries));
        if (item.tries >= PUSH_MAX_TRIES) {
          pushQueue.splice(idx, 1);
          pushLogAdd({ t: now, chat: pushMask(item.chat), ok: false, err: "gave up after " + item.tries + " tries" });
        }
        pushLastErr = r.error;
      }
    } finally { pushSending = false; }
  }
  function pushLogAdd(e) { pushLog.unshift(e); if (pushLog.length > PUSH_LOG_RING) pushLog.pop(); pushVer++; }

  // ---- stream consumption ---------------------------------------------------------------------
  // Per-recipient cursor, advanced whether or not an event cleared that person's filter: a filtered
  // event is HANDLED, not pending. A shared cursor would mean the strictest subscriber's filter
  // silently decided what everyone else could still receive.
  function pushStreamTick() {
    if (!pushOn() || !pushRecipients.size) return;
    const now = Date.now();
    const base = PUBLIC_URL();
    // The startup rule is a LOOKBACK, not a mute: an event older than the boot minus the grace
    // window advances the cursor but is never sent. A blanket "stay quiet for 5 minutes after boot"
    // would swallow the deploy notice itself — the one message that proves the wire survived the
    // deploy — and would still let a two-hour-old backlog through once the timer expired. Same
    // shape as trigScan's anti-blast rule: seeded, not announced.
    const floor = pushBootAt - PUSH_GRACE_MS;
    // Universe slice (2026.08.03-02): a non-admin recipient's DM wire honours the same scope set
    // as their /api/triggers pull — announcing a hidden universe's fires by Telegram while the
    // tabs refuse to render them would put the two transports in disagreement about what exists.
    // Resolved once per drain (the flag set is drain-invariant), applied per recipient by rank.
    const pubSigVis = featureScopeVis(featureFlags, "signals", false);
    const pubActVis = featureScopeVis(featureFlags, "actionable", false);
    for (const rec of pushRecipients.values()) {
      if (rec.muted) continue;
      const evs = trigEvents.filter((e) => e.seq > (rec.cur || 0));
      if (!evs.length) continue;
      rec.cur = trigSeq;
      const keep = evs.filter((e) => (e.at || 0) >= floor && evVisible(e, rec.owner, false) && pushEligible(e, rec)
        && (rec.admin || scopeEventVisible(e, pubSigVis, pubActVis)));
      // Split by whether the event pierces this recipient's quiet window. Held messages are
      // scheduled for the window's end rather than dropped, so nothing the log records is ever
      // missing from the phone — it just arrives at a civilised hour.
      const quiet = rec.quiet && inQuietWindow(now, rec.quiet);
      const live = quiet ? keep.filter(piercesQuiet) : keep;
      const held = quiet ? keep.filter((e) => !piercesQuiet(e)) : [];
      for (const text of pushBatch(live.map((e) => pushFmt(e, { baseUrl: base })).filter(Boolean)))
        pushEnqueue(rec.chat, text);
      if (held.length) {
        const after = quietEndsAt(now, rec.quiet);
        for (const text of pushBatch(held.map((e) => pushFmt(e, { baseUrl: base })).filter(Boolean), { max: 20 }))
          pushEnqueue(rec.chat, "<i>held overnight</i>\n" + text, false, after);
      }
      pushDirty = true;
    }
    if (pushDirty) persistPush();
  }

  // Poller-stall watchdog. Edge-triggered both ways: one alert when the data goes cold, one when it
  // comes back. This is the class that tells you the alert pipe itself is alive — if deploys stop
  // arriving, nothing else here can be trusted either.
  const PUSH_STALL_MS = 10 * 60 * 1000;
  function pushHealthTick() {
    const now = Date.now();
    if (!lastPoll) return;
    const cold = now - lastPoll > PUSH_STALL_MS;
    if (cold && !pushStall) {
      pushStall = true;
      pushOps("poller stalled", `no successful universe poll for ${Math.round((now - lastPoll) / 60000)} min \u2014 the board is serving stale marks`, "warn");
    } else if (!cold && pushStall) {
      pushStall = false;
      pushOps("poller recovered", "universe polling resumed \u2014 marks are live again");
    }
  }


  // ---- ledger class: the death notice (slice B) ------------------------------------------------
  // The setup class tells you a claim opened. Without this, that is the ONLY thing the channel ever
  // says — you get told about entries and are left to discover exits from the board, which makes an
  // alert stream actively misleading rather than merely incomplete. Three moments close the loop:
  // the void level being taken, the target being reached, and the horizon resolving.
  //
  // Scope is deliberately tight: only claims stamped `alo` (announced) and only non-shadow claims.
  // A claim nobody heard about does not get a death notice.
  const LVL_SCAN_MS = 30 * 1000;
  let lvlLast = 0;
  const pushDur = (ms) => {
    if (!(ms > 0)) return null;
    const h = ms / 3600e3;
    return h < 1 ? Math.max(1, Math.round(ms / 60000)) + "m" : h < 48 ? h.toFixed(1) + "h" : Math.round(h / 24) + "d";
  };
  function emitLedgerEvent(e, sub, level, now) {
    const t = now || Date.now();
    const side = e.psd || (e.dir >= 0 ? "long" : "short");
    return emitTrig("ledger", {
      coin: e.coin, t: e.ticker || e.coin, side, ev: e.ev, label: EV_LABEL[e.ev] || e.ev, sub,
      level: level != null ? level : null,
      entry: e.mark0 != null && isFinite(e.mark0) ? e.mark0 : null,
      held: pushDur(t - (e.t0 || t)),
      realized: sub === "resolved" && Number.isFinite(e.realized) ? e.realized : null,
      unit: sub === "resolved" ? unitOf(e.ev) : null,
      stopped: sub === "resolved" ? e.stopped === true : null,
      t0: e.t0 || null,
    }, t);
  }
  // Live level scan. Two detectors, because neither alone is honest: the live mark catches the
  // common case, and the 5m bars since the last scan catch the wick that took the level and came
  // back while nobody was looking. Even together they are a LIVE approximation — the ledger's
  // stop-aware record is still decided by the resolver against the hourly spine, and the two can
  // legitimately differ. The alert is a heads-up, not the bookkeeping.
  function levelScan() {
    const now = Date.now();
    const since = lvlLast || (now - LVL_SCAN_MS);
    lvlLast = now;
    // Group by coin so the 5m range query runs once per NAME, not once per claim.
    const byCoin = new Map();
    for (const e of ledgerOpen.values()) {
      if (!isOpenAnnounced(e)) continue;
      const wantStop = e.stp != null && e.als !== 1, wantTgt = e.tgt != null && e.alt !== 1;
      if (!wantStop && !wantTgt) continue;
      if (!byCoin.has(e.coin)) byCoin.set(e.coin, []);
      byCoin.get(e.coin).push(e);
    }
    if (!byCoin.size) return 0;
    let fired = 0;
    for (const [coin, ents] of byCoin) {
      const r = rows.get(coin);
      const px = r && r.px > 0 ? r.px : 0;
      // Collapse every closed 5m bar since the last scan into one high/low envelope. Missing or
      // disabled candle storage degrades to the live mark alone — a narrower detector, never a
      // wrong one.
      let bar = null;
      try {
        if (store.readCandles && store.candlesEnabled && store.candlesEnabled()) {
          const bars = store.readCandles(coin, since - 5 * 60 * 1000, now);
          if (bars && bars.length) {
            let hi = -Infinity, lo = Infinity;
            for (const b of bars) { if (b[2] > hi) hi = b[2]; if (b[3] > 0 && b[3] < lo) lo = b[3]; }
            if (isFinite(hi) && isFinite(lo)) bar = [now, 0, hi, lo, 0, 0];
          }
        }
      } catch (_) { bar = null; }
      if (!px && !bar) continue;
      for (const e of ents) {
        const side = e.psd || (e.dir >= 0 ? "long" : "short");
        if (e.stp != null && e.als !== 1 && levelHit(side, "stop", e.stp, px, bar)) {
          // A claim whose void is taken is DEAD for alerting purposes, so its target is retired in
          // the same breath. Relying on `continue` alone only held within a single scan: on the
          // next one the target was still unstamped, and a later run up to it announced a target
          // reached on a claim that had already stopped out — the most misleading message this
          // class could possibly send.
          e.als = 1; e.alt = 1; ledgerDirty = true; fired++;
          emitLedgerEvent(e, "stop", e.stp, now);
          continue;
        }
        if (e.tgt != null && e.alt !== 1 && levelHit(side, "target", e.tgt, px, bar)) {
          e.alt = 1; ledgerDirty = true; fired++;
          emitLedgerEvent(e, "target", e.tgt, now);
        }
      }
    }
    if (fired) { persistTriggers(); persistLedger(); log(`ledger alerts: ${fired} level event(s)`); }
    return fired;
  }


  // ---- user-authored metric rules: the scan (slice D) -------------------------------------------
  // Evaluated against the SNAPSHOT PAYLOAD, not the live row objects. That is deliberate: the
  // payload is byte-for-byte what the client renders, so an alert saying "1h % above 5" can never
  // disagree with the number on the board. The cost is that rule latency is the snapshot cadence
  // (15s) rather than the WebSocket's ~2s — the right trade for a threshold, and the level alerts
  // that genuinely need speed run off the live mark instead (see levelScan).
  const RULE_MAX = 60;                       // a bounded, shared list; past this it is a screener, not an alert
  const RULE_DEFAULT_COOLDOWN = 30 * 60e3;
  const RULE_STATE_MAX = 4000;               // bounded edge state — 60 rules x the roster, with headroom
  let alertRules = [], ruleSeq = 0;
  const ruleArmed = new Map();               // ruleId|coin -> true once the value has cleared the band
  const ruleLastFire = new Map();            // ruleId|coin -> ts
  const rulePrev = new Map();                // ruleId|coin -> previous value (cross detection)
  let rulesDirty = false;

  function hydrateRules() {
    const d = store.loadRules ? store.loadRules() : null;
    if (!d) return 0;
    if (Array.isArray(d.rules)) {
      for (const r of d.rules) {
        const v = validateRule(r);
        // Rules written before per-person ownership existed carry no owner. Same treatment as
        // ownerless recipients: admin-managed, never silently adopted by the next visitor.
        if (v.ok) { v.rule.id = r.id || ++ruleSeq; v.rule.owner = typeof r.owner === "string" ? r.owner : ""; alertRules.push(v.rule); }
      }
    }
    if (Number.isFinite(d.seq)) ruleSeq = Math.max(ruleSeq, d.seq);
    for (const r of alertRules) if (r.id > ruleSeq) ruleSeq = r.id;
    // Edge state is restored so a redeploy does not re-announce every rule already in breach —
    // the same failure the trigger stream's anti-blast rule exists to prevent.
    if (Array.isArray(d.armed)) for (const k of d.armed) if (typeof k === "string") ruleArmed.set(k, true);
    if (Array.isArray(d.fired)) for (const kv of d.fired) if (Array.isArray(kv) && typeof kv[0] === "string") ruleLastFire.set(kv[0], +kv[1] || 0);
    return alertRules.length;
  }
  function persistRules() {
    if (!store.saveRules) return;
    store.saveRules({ ts: Date.now(), seq: ruleSeq, rules: alertRules,
      armed: [...ruleArmed.keys()].slice(-RULE_STATE_MAX),
      fired: [...ruleLastFire.entries()].slice(-RULE_STATE_MAX) });
    rulesDirty = false;
  }
  function ruleScopeRows(rule, snap) {
    const all = (snap.markets || []).concat(snap.mainMarkets || []);
    if (rule.coin) { const r = all.find((x) => x.coin === rule.coin); return r ? [r] : []; }
    if (rule.uni) return all.filter((x) => x.uni === rule.uni);
    return all;
  }
  function ruleScan() {
    if (!alertRules.length) return 0;
    const snap = snapshotCache;
    if (!snap || !Array.isArray(snap.markets)) return 0;
    const now = Date.now();
    let fired = 0;
    for (const rule of alertRules) {
      const m = RULE_BY_K[rule.metric];
      if (!m) continue;
      const cool = rule.cooldownMs != null ? rule.cooldownMs : RULE_DEFAULT_COOLDOWN;
      for (const row of ruleScopeRows(rule, snap)) {
        if (row.delisted) continue;
        const key = rule.id + "|" + row.coin;
        const prev = rulePrev.get(key);
        // An unseen (rule, market) pair starts DISARMED: a rule added while a market is already in
        // breach describes a state, not an event, and announcing it would mean every new rule
        // detonates across the roster the moment it is saved. It arms the first time the value sits
        // cleanly outside the band.
        const verdict = ruleEval(rule, row, ruleArmed.get(key) === true, prev);
        const val = m.get(row);
        if (val != null && isFinite(val)) rulePrev.set(key, val);
        if (verdict === "arm") { ruleArmed.set(key, true); rulesDirty = true; continue; }
        if (verdict !== "fire") continue;
        if (now - (ruleLastFire.get(key) || 0) < cool) continue;
        ruleArmed.set(key, false);
        ruleLastFire.set(key, now);
        rulesDirty = true; fired++;
        emitTrig("rule", {
          // A personal rule produces a personal event. Without this the ring would carry one
          // person's thresholds to everyone else's phone and bell log — the same leak the shared
          // recipient list had, one layer down.
          owner: rule.owner || "",
          coin: row.coin, t: row.ticker || row.coin, uni: row.uni,
          ruleId: rule.id, metric: rule.metric, label: m.label, op: rule.op, value: rule.value,
          note: rule.note || "", now: ruleFmtValue(m, val), rule: ruleLabel(rule),
        }, now);
      }
    }
    // Bound the edge maps: 60 rules across two rosters is small, but a long-lived process with
    // churning listings would otherwise grow these forever.
    for (const map of [ruleArmed, ruleLastFire, rulePrev])
      if (map.size > RULE_STATE_MAX) { const drop = map.size - RULE_STATE_MAX; let i = 0; for (const k of map.keys()) { if (i++ >= drop) break; map.delete(k); } }
    if (fired) { persistTriggers(); log(`rule alerts: ${fired} fired`); }
    if (rulesDirty) persistRules();
    return fired;
  }

  const ruleOwns = (r, owner, isAdmin) => isAdmin || !!(r && r.owner && owner && r.owner === owner);
  function getRules(owner, isAdmin) {
    const mine = alertRules.filter((r) => ruleOwns(r, owner, isAdmin));
    return { ts: Date.now(), dataTs: ruleSeq, max: RULE_MAX, admin: !!isAdmin,
      // Counted, not listed. Someone should be able to tell the engine is doing work for other
      // people without being shown what they are watching.
      othersRules: alertRules.length - mine.length,
      metrics: RULE_METRICS.map((m) => ({ k: m.k, label: m.label, unit: m.unit, scale: m.scale || null })),
      ops: RULE_OPS, opLabels: RULE_OP_LABEL,
      defaultCooldownMs: RULE_DEFAULT_COOLDOWN,
      rules: mine.map((r) => Object.assign({}, r, { text: ruleLabel(r), mine: ruleOwns(r, owner, false) })) };
  }
  function addRule(rule, owner) {
    // The cap is PER PERSON now that rules are personal — one prolific author must not be able to
    // exhaust the list for everyone else.
    if (alertRules.filter((r) => r.owner === (owner || "")).length >= RULE_MAX) return { ok: false, error: "cap" };
    const v = validateRule(rule);
    if (!v.ok) return v;
    v.rule.id = ++ruleSeq;
    v.rule.owner = owner || "";
    alertRules.push(v.rule);
    persistRules();
    return { ok: true, rule: Object.assign({}, v.rule, { text: ruleLabel(v.rule) }) };
  }
  function deleteRule(id, owner, isAdmin) {
    const n = +id;
    const target = alertRules.find((r) => r.id === n);
    if (!target) return { ok: false, error: "unknown" };
    if (!ruleOwns(target, owner, isAdmin)) return { ok: false, error: "forbidden" };
    const before = alertRules.length;
    alertRules = alertRules.filter((r) => r.id !== n);
    for (const map of [ruleArmed, ruleLastFire, rulePrev])
      for (const k of [...map.keys()]) if (k.startsWith(n + "|")) map.delete(k);
    persistRules();
    return { ok: true, removed: before - alertRules.length };
  }


  // ---- context classes: filings, earnings proximity, analyst flips (slice E) --------------------
  // All three ship OPT-IN (see PUSH_DEFAULT_CLASSES): they enter the ring and the in-app log
  // immediately, and reach a phone only once someone has seen the measured rate and chosen them.
  //
  // Two candidate classes were deliberately NOT built. News headlines: the wire runs a per-name
  // rotation across the whole roster, so attributed headlines land at tens per day — that is a tab
  // to read, not an interruption. Ownership filings (Forms 3/4/5/144/13G): routine insider flow,
  // several per day per active name. Both would have been noise wearing an alert's clothes.

  const FILING_SEEN_MAX = 600;
  const filingSeen = new Set();           // accession ids already announced
  let filingPrimed = false;               // first pass after boot seeds silently
  // Material forms only, and only the ones that actually move a mark. SEC_MATERIAL also carries
  // DEF 14A and S-3 shelf registrations, which are real but rarely urgent; they stay in the news
  // tab. This set is the "stop what you are doing" subset.
  const FILING_PUSH_FORMS = new Set(["8-K", "8-K/A", "10-K", "10-Q", "SC 13D", "SC 13D/A", "6-K", "425"]);
  function filingScan(items) {
    if (!Array.isArray(items) || !items.length) return 0;
    const now = Date.now();
    let fired = 0;
    for (const a of items) {
      if (!a || !a.id || !a.tk) continue;
      if (filingSeen.has(a.id)) continue;
      filingSeen.add(a.id);
      if (!FILING_PUSH_FORMS.has(a.form)) continue;
      // The first rotation after a boot sees a 7-day backlog it was never listening for. Same
      // anti-blast rule as the trigger stream: seeded, not announced.
      if (!filingPrimed) continue;
      if (!(a.pub > 0) || now - a.pub > 6 * HOUR) continue;   // a filing found late is history, not news
      const r = [...rows.values()].find((x) => x.ticker === a.tk && !x.delisted);
      emitTrig("filing", { coin: r ? r.coin : a.tk, t: a.tk, form: a.form, h: a.h || "", url: a.url || null, pub: a.pub }, now);
      fired++;
    }
    if (filingSeen.size > FILING_SEEN_MAX) {
      const drop = filingSeen.size - FILING_SEEN_MAX; let i = 0;
      for (const k of filingSeen) { if (i++ >= drop) break; filingSeen.delete(k); }
    }
    persistTriggers();   // the seen-set must survive the deploy, or the backlog re-arrives as news
    if (fired) log(`filing alerts: ${fired} material filing(s)`);
    return fired;
  }

  // Earnings proximity, scoped HARD. An 84-name roster in reporting season prints a dozen names a
  // day, which is a calendar, not an alert. The gate that makes this rare and useful at once: only
  // names carrying an OPEN, ANNOUNCED claim — you were told to look at it, and now the thing that
  // decides it is a day away.
  const earnAlerted = new Map();   // ticker|date -> ts
  function earnScan() {
    const now = Date.now();
    let fired = 0;
    const seen = new Set();
    for (const e of ledgerOpen.values()) {
      if (!isOpenAnnounced(e)) continue;
      const tk = e.ticker;
      if (!tk || seen.has(tk)) continue;
      seen.add(tk);
      const prox = earnProx(tk);
      if (!prox || prox.diff > 1) continue;          // today or tomorrow only
      const key = tk + "|" + prox.e.d;
      if (earnAlerted.has(key)) continue;
      earnAlerted.set(key, now);
      // The open claim is the GATE, never the content: this alert exists because the print decides
      // an open trade, but the message itself is an earnings notice — positioning stays off the
      // wire (Telegram and the bell feed both read this payload).
      emitTrig("earnings", { coin: e.coin, t: tk, when: prox.diff === 0 ? "today" : "tomorrow",
        session: prox.e.s || null, date: prox.e.d }, now);
      fired++;
    }
    // Bounded: one entry per ticker per report date, and report dates stop mattering once past.
    if (earnAlerted.size > 400) { const drop = earnAlerted.size - 400; let i = 0; for (const k of earnAlerted.keys()) { if (i++ >= drop) break; earnAlerted.delete(k); } }
    if (fired) { persistTriggers(); log(`earnings alerts: ${fired} name(s) reporting within a day with an open claim`); }
    return fired;
  }

  // The OTHER half of the earnings class: the roster-wide calendar, once a day, as ONE message.
  // The claim-scoped leg above answers "the thing that decides your open trade is a day away" and
  // is correctly silent when you hold nothing — which is exactly why it looked broken. This leg
  // answers the different question ("what is coming, and what just landed") without becoming the
  // dozen-interruptions-a-day feed that the scoping was built to prevent. Same class, because
  // nobody wants one of these without the other; different sub, so the log can tell them apart.
  const EARN_PREVIEW_ET_HOUR = 17;   // after the 16:00 cash close: today's prints are out, tomorrow's are still ahead
  const EARN_PREVIEW_MAX = 20;       // per list; a single Telegram body caps at 4096 chars
  let earnPrevDay = null;            // ET day already previewed (persisted — a redeploy must not re-send)
  function earnPreviewScan() {
    const now = Date.now();
    const day = etDayStr(now);
    if (earnPrevDay === day) return 0;
    if (etParts(now).h < EARN_PREVIEW_ET_HOUR) return 0;
    // Positioning stays OUT of the calendar: this is a roster-wide reference message, and open
    // claims are the urgent leg's gate, not calendar content (2026.08.04-04 — the inline claim
    // flags were removed on request; the payload never carries them now).
    const dayMove = new Map();
    for (const r of rows.values()) if (r.ticker && !r.delisted && Number.isFinite(r.d1)) dayMove.set(r.ticker, r.d1);
    const tomorrow = [], reported = [];
    for (const [tk, arr] of earnMap) {
      for (const e of arr) {
        const df = earnDayDiff(e.d, now);
        if (df === 1) { tomorrow.push({ t: tk, s: e.s || "TBD", eps: e.eps }); break; }
        if (df === 0) { reported.push({ t: tk, s: e.s || "TBD", eps: e.eps, epsA: e.epsA, d1: dayMove.has(tk) ? dayMove.get(tk) : undefined }); break; }
      }
    }
    // Marked sent even when there is nothing to say: the daily decision has been made, and a
    // later tick must not re-open it just because a calendar refresh landed at 18:00.
    earnPrevDay = day;
    if (!tomorrow.length && !reported.length) { persistTriggers(); return 0; }
    const sortT = (a, b) => (a.t < b.t ? -1 : a.t > b.t ? 1 : 0);
    tomorrow.sort(sortT); reported.sort(sortT);
    emitTrig("earnings", { sub: "preview", d: day,
      tomorrow: tomorrow.slice(0, EARN_PREVIEW_MAX), reported: reported.slice(0, EARN_PREVIEW_MAX),
      moreUp: Math.max(0, tomorrow.length - EARN_PREVIEW_MAX) || undefined,
      moreRep: Math.max(0, reported.length - EARN_PREVIEW_MAX) || undefined }, now);
    persistTriggers();
    log(`earnings preview: ${tomorrow.length} reporting tomorrow, ${reported.length} reported today`);
    return 1;
  }

  // ---- macro class: the universe-wide calendar (FOMC + FRED) ------------------------------------
  // The one class with no ticker. A CPI print moves the whole board, so scoping it to a name would
  // misdescribe the event; `coin` is absent by construction and pushFmt lets it through explicitly.
  // Three legs per release, and only three:
  //
  //   ahead     — the ET day before. Enough warning to size down or stand aside.
  //   imminent  — inside the last hour before the release clock. The "don't get caught" leg.
  //   result    — the actual, the moment FRED publishes the series (or the Fed's new target range).
  //
  // Same episode discipline as every other persistent-condition class: state true at first sight on
  // a cold boot is SEEDED, never announced, and the seed set is persisted — otherwise a Railway
  // deploy (one per pushed file) would re-announce the same CPI print all afternoon.
  const MACRO_IMMINENT_MIN = 60;    // minutes before the release clock that the imminent leg opens
  const MACRO_ALERTED_MAX = 300;    // ~7 releases/month x 3 legs — a year of headroom
  const macroAlerted = new Map();   // k|d|sub -> ts
  let macroPrimed = false;
  function macroScan() {
    const ent = macroCache && Array.isArray(macroCache.entries) ? macroCache.entries : [];
    if (!ent.length) return 0;
    const now = Date.now();
    const et = etParts(now);
    let fired = 0, seeded = 0;
    for (const e of ent) {
      if (!e || !e.k || !e.d) continue;
      const df = earnDayDiff(e.d, now);
      if (df == null) continue;
      const state = macroEntryState(e, now);
      const legs = [];
      if (state === "upcoming" && df === 1) legs.push({ sub: "ahead" });
      if (state === "upcoming" && df === 0) {
        const hh = +(e.tEt || "08:30").slice(0, 2), mm = +(e.tEt || "08:30").slice(3, 5);
        const mins = (hh * 60 + mm) - (et.h * 60 + et.mi);
        if (mins >= 0 && mins <= MACRO_IMMINENT_MIN) legs.push({ sub: "imminent", mins });
      }
      // The result leg waits for the NUMBER, not the clock. A passed 08:30 with no series update
      // is `pend` on the board and stays silent here — announcing "released" with nothing in it
      // would be the false-precision failure this codebase refuses everywhere else.
      if (e.actual != null) legs.push({ sub: "result" });
      for (const leg of legs) {
        const key = e.k + "|" + e.d + "|" + leg.sub;
        if (macroAlerted.has(key)) continue;
        macroAlerted.set(key, now);
        if (!macroPrimed) { seeded++; continue; }
        emitTrig("macro", Object.assign({ k: e.k, label: e.label || e.k, d: e.d, tEt: e.tEt || null,
          sep: e.sep === true ? true : undefined,
          prior: e.prior || null, actual: e.actual || null }, leg), now);
        fired++;
      }
    }
    if (macroAlerted.size > MACRO_ALERTED_MAX) {
      const drop = macroAlerted.size - MACRO_ALERTED_MAX; let i = 0;
      for (const k of macroAlerted.keys()) { if (i++ >= drop) break; macroAlerted.delete(k); }
    }
    if (!macroPrimed) { macroPrimed = true; if (seeded) log(`macro alerts primed: ${seeded} calendar leg(s) seeded silently`); }
    if (fired || seeded) persistTriggers();
    if (fired) log(`macro alerts: ${fired} calendar event(s)`);
    return fired;
  }

  // Analyst action flip. The AI report is regenerated on a cooldown, usually by hand, so this is
  // structurally rare — and a read moving from "wait" to a side (or back) is the report changing
  // its mind, which is the only part of a regeneration worth interrupting anyone for. Emitted from
  // the generation path, comparing against the stance the previous cached report published.
  function aiFlipCheck(coin, prevRep, nextRep) {
    try {
      const a = prevRep && prevRep.report && prevRep.report.action;
      const b = nextRep && nextRep.report && nextRep.report.action;
      if (!a || !b || !a.stance || !b.stance) return null;
      if (a.stance === b.stance) return null;
      const r = rows.get(coin);
      return emitTrig("ai", { coin, t: (r && r.ticker) || coin, from: a.stance, to: b.stance,
        note: typeof b.note === "string" ? b.note.slice(0, 160) : "" });
    } catch (_) { return null; }
  }


  // ---- regime + coverage classes, and the daily digest (slice F) --------------------------------
  // Both classes are PERSISTENT CONDITIONS rather than events, which is the trap: crowding stays
  // extreme for days and a stale market stays stale until someone fixes it. Announced naively they
  // would repeat on every scan. Each therefore carries the ledger's re-arm discipline — one episode,
  // one alert, and it only re-arms once the condition has genuinely lapsed.
  const REGIME_CROWD_EXT = 35;      // net crowding (long-extreme % minus short-extreme %) either way
  const REGIME_OIZ_EXT = 2;         // aggregate OI stretch, in sigma of its own 60d history
  const regimeArmed = new Map();    // scope|kind -> false while the condition is in force
  function regimeScan() {
    const now = Date.now();
    let fired = 0;
    let reg = null;
    try { reg = buildRegime(); } catch (_) { return 0; }
    if (!reg) return 0;
    for (const scope of ["xyz", "main"]) {
      const g = reg[scope];
      if (!g || g.pending) continue;
      const checks = [
        { kind: "crowd", v: g.crowd && g.crowd.netCrowd, ext: REGIME_CROWD_EXT,
          title: (v) => (v > 0 ? "longs crowded" : "shorts crowded"),
          text: (v) => `net crowding ${v > 0 ? "+" : ""}${v} across ${g.crowd.pctNames} names with a funding percentile` },
        { kind: "oiz", v: g.lev && g.lev.oiZ, ext: REGIME_OIZ_EXT,
          title: (v) => (v > 0 ? "leverage stretched" : "leverage flushed"),
          text: (v) => `aggregate open interest ${v > 0 ? "+" : ""}${(+v).toFixed(1)}\u03c3 vs its own 60d history` },
      ];
      for (const c of checks) {
        if (c.v == null || !isFinite(c.v)) continue;
        const key = scope + "|" + c.kind;
        const hot = Math.abs(c.v) >= c.ext;
        if (!hot) { if (regimeArmed.get(key) === false) regimeArmed.set(key, true); continue; }
        if (regimeArmed.get(key) === false) continue;   // still the same episode
        if (!regimeArmed.has(key)) { regimeArmed.set(key, false); continue; }   // in force at boot: seeded, not announced
        regimeArmed.set(key, false);
        emitTrig("regime", { scope, sub: c.kind, title: c.title(c.v), text: c.text(c.v), value: c.v }, now);
        fired++;
      }
    }
    persistTriggers();   // seeds and re-arms matter to the NEXT process as much as fires do
    return fired;
  }

  // Coverage, scoped the same way the earnings class is: a data gap on a name nobody is watching is
  // a maintenance item for the coverage panel, not an interruption. A data gap on a name carrying an
  // OPEN, ANNOUNCED claim is different — every number you were given about that claim is now being
  // computed from a stale spine, and you should know before you act on it.
  const COVERAGE_STALE_MS = 90 * 60 * 1000;
  // Re-arm hysteresis: a spine flapping around the stale line (refresh, drift stale, refresh)
  // used to fire once per crossing — the many-messages failure mode. Re-arming now requires the
  // spine to have been continuously fresh for a full window, so a flap is one episode, one alert.
  // coverageFreshAt is deliberately NOT persisted: a restart merely delays the next re-arm by
  // one window, which is the safe direction.
  const COVERAGE_REARM_FRESH_MS = 30 * 60 * 1000;
  const coverageArmed = new Map();
  const coverageFreshAt = new Map();   // first observation of the current fresh stretch
  function coverageScan(atNow) {
    const now = atNow || Date.now();
    let fired = 0;
    const live = new Set();
    for (const e of ledgerOpen.values()) {
      if (!isOpenAnnounced(e)) continue;
      const r = rows.get(e.coin);
      if (!r || r.delisted) continue;
      live.add(e.coin);
      const age = now - (r.hourlyTs || 0);
      const stale = r.hourlyTs > 0 && age > COVERAGE_STALE_MS;
      const key = e.coin;
      if (!stale) {
        if (!coverageFreshAt.has(key)) coverageFreshAt.set(key, now);
        if (coverageArmed.get(key) === false && now - coverageFreshAt.get(key) >= COVERAGE_REARM_FRESH_MS) coverageArmed.set(key, true);
        continue; }
      coverageFreshAt.delete(key);   // the fresh stretch is over; the next one starts its own clock
      if (coverageArmed.get(key) === false) continue;
      if (!coverageArmed.has(key)) { coverageArmed.set(key, false); continue; }
      coverageArmed.set(key, false);
      // Say WHY when we can: a failing fetch (with its retry clock) reads very differently from a
      // healthy fetch that never got queue time — one is an API problem, the other is budget.
      const why = (r.hFail || 0) > 0
        ? ` \u00b7 fetch failing (${r.hFail} consecutive${(r.hFailUntil || 0) > now ? `, retry in ${Math.max(1, Math.ceil((r.hFailUntil - now) / 60000))}m` : ""})`
        : " \u00b7 no fetch failures recorded \u2014 queue/budget contention";
      emitTrig("coverage", { coin: e.coin, t: e.ticker || e.coin,
        text: `hourly spine last refreshed ${Math.round(age / 60000)} min ago \u2014 the open ${EV_LABEL[e.ev] || e.ev} claim's live numbers are running on stale data${why}` }, now);
      fired++;
    }
    for (const k of [...coverageArmed.keys()]) if (!live.has(k)) { coverageArmed.delete(k); coverageFreshAt.delete(k); }
    persistTriggers();   // seeds and re-arms matter to the NEXT process as much as fires do
    return fired;
  }


  // ===== morning brief (build 2026.07.28-13) ======================================================
  // Replaces the ops digest. See the contract notes above renderBrief in compute.js: synthesis only,
  // every number mechanical, honest absence, and it must fit inside Telegram's hard 4096 ceiling.
  //
  // Cost shape: ONE model call per hour-bucket, shared by every recipient who wakes at that hour,
  // on its own daily budget so a brief can never eat the report allowance. A failure at any point —
  // no key, budget spent, refusal, validator reject, timeout — drops the two prose sections and
  // ships the mechanical brief. A recipient never gets silence because the model had a bad morning.
  const BRIEF_ON = String(process.env.BRIEF_ENABLED || "1") !== "0";
  // 10:00 UTC. Parsed explicitly rather than with `|| 10`, so that BRIEF_DEFAULT_HOUR=0 means
  // midnight UTC instead of silently falling through to the default — an env var that ignores one
  // of its own legal values is a trap.
  const _briefHourEnv = Number(process.env.BRIEF_DEFAULT_HOUR);
  const BRIEF_DEFAULT_HOUR = Number.isFinite(_briefHourEnv) ? Math.min(23, Math.max(0, Math.trunc(_briefHourEnv))) : 10;
  const BRIEF_PER_DAY = Math.max(1, Number(process.env.BRIEF_PER_DAY) || 6);
  const BRIEF_EFFORT = process.env.BRIEF_EFFORT || "medium";
  const BRIEF_MODEL = process.env.BRIEF_MODEL || AI_MODEL;
  const BRIEF_MODEL_FALLBACK = process.env.BRIEF_MODEL_FALLBACK || AI_MODEL_FALLBACK;
  // NEVER below the provider's own budget. GPT-5.x bills reasoning tokens against
  // max_completion_tokens, so an output-sized budget returns finish_reason=length with an EMPTY
  // message: the first build set this to 4000 and every live brief lost its prose to a silent
  // empty response. AI_DEF.maxTokens is the floor the report path and the suite already agree on.
  const BRIEF_MAX_TOKENS = Math.max(AI_MAX_TOKENS, Number(process.env.BRIEF_MAX_TOKENS) || 12000);
  const BRIEF_CACHE_MS = 55 * 60 * 1000;
  const BRIEF_MOVERS_N = 3, BRIEF_NEWS_CLUSTERS = 3, BRIEF_NEWS_PER = 3, BRIEF_IDX_MAX = 5;
  const BRIEF_EARN_N = 4;   // per group; four rows x three groups is already most of a screen
  let briefCache = null;              // { key, at, messages, dropped, model, degraded }
  let briefDay = { d: "", n: 0 };
  let briefLastErr = null;
  const briefSent = new Map();        // chat -> YYYY-MM-DD already sent

  // ---- THE LANDSCAPE -----------------------------------------------------------------------------
  // The second registered scheduled send. All schedule mechanics (who, which hour, which days) live
  // in the sched registry — this block is only the generation engine and the tick that walks it.
  // Mon/Wed/Fri 11:00 UTC by default, from the registry's defaultDays, an hour after the brief.
  const LAND_ON = String(process.env.LANDSCAPE_ENABLED || "1") !== "0";
  const LAND_PER_DAY = Math.max(1, Number(process.env.LANDSCAPE_PER_DAY) || 4);
  // Commentary is where reasoning depth actually shows: the difference between "three headlines
  // about chips" and "the second time the tape repriced terminal value" is inference over a
  // corpus, not summarisation of it.
  const LAND_EFFORT = process.env.LANDSCAPE_EFFORT || "high";
  const LAND_MODEL = process.env.LANDSCAPE_MODEL || BRIEF_MODEL;
  const LAND_MODEL_FALLBACK = process.env.LANDSCAPE_MODEL_FALLBACK || BRIEF_MODEL_FALLBACK;
  const LAND_MAX_TOKENS = Math.max(AI_MAX_TOKENS, Number(process.env.LANDSCAPE_MAX_TOKENS) || 12000);
  const LAND_CACHE_MS = 55 * 60 * 1000;
  // A WIDER corpus than WHAT MATTERED's 24h x 3 x 2: commentary needs enough material to find a
  // pattern ACROSS clusters, so it reads 72h, more groups, full headlines, source and age attached.
  const LAND_WINDOW_H = 72, LAND_CLUSTERS = 8, LAND_PER_CLUSTER = 5, LAND_HEADLINES_MAX = 30;
  let landCache = null;               // { key, at, message, sources, dropped, model, degraded }
  let landDay = { d: "", n: 0 };
  let landLastErr = null;
  const landSent = new Map();         // chat -> YYYY-MM-DD already sent
  function landDayLeft() {
    const d = briefDayKey(Date.now());
    if (landDay.d !== d) return LAND_PER_DAY;
    return Math.max(0, LAND_PER_DAY - landDay.n);
  }

  // A headline-centric context, not a numeric one. The brief's ctx is the dashboard; this one is
  // the news corpus, because the question is different — not "what did the book do" but "what is
  // going on, and which parts of it are the same story".
  function buildLandCtx(now) {
    const t = now || Date.now();
    const ctx = { at: t, tz: 0, build: version || "dev", windowH: LAND_WINDOW_H };
    const cut = t - LAND_WINDOW_H * 3600e3;
    const bySec = new Map();
    let n = 0;
    try {
      const sorted = (newsItems || []).filter((a) => a && !a.fl && !a.tg && (a.pub >= cut))
        .sort((a, b) => (b.pub || 0) - (a.pub || 0));
      for (const a of sorted) {
        if (n >= LAND_HEADLINES_MAX) break;
        // Unattributed macro tape is INCLUDED here, unlike the brief's per-industry clusters — the
        // economic landscape is mostly not a company story.
        let key;
        if (a.tk && a.rel === 1) {
          const c = classifyCached(String(a.tk).toUpperCase(), "xyz");
          key = (c && c.ind && c.ind !== "Unclassified") ? c.ind : (a.sec || "Market");
        } else if (!a.tk) key = "Macro tape";
        else continue;
        let g = bySec.get(key); if (!g) { g = []; bySec.set(key, g); }
        if (g.length >= LAND_PER_CLUSTER) continue;
        g.push({ id: "h" + (++n), t: a.tk ? String(a.tk).toUpperCase() : null,
          h: String(a.h || "").slice(0, 180), src: a.src || null, u: a.url || null,
          ageH: Math.max(0, Math.round((t - (a.pub || t)) / 3600e3)) });
      }
    } catch (_) {}
    ctx.news = [...bySec.entries()].sort((a, b) => b[1].length - a[1].length)
      .slice(0, LAND_CLUSTERS).map(([sector, items]) => ({ sector, items }));

    // Did the tape care? Handed over as WORDS, never percentages — a column of decimals is how
    // commentary becomes a number recital. Direction only, from the same d1 the board renders.
    const byTicker = new Map();
    for (const r of rows.values()) if (r.ticker && !r.delisted) byTicker.set(String(r.ticker).toUpperCase(), r);
    const toneOf = (tickers) => {
      let up = 0, dn = 0;
      for (const tk of tickers) {
        const r = byTicker.get(tk);
        const d = r && r.d1 != null && isFinite(r.d1) ? r.d1 : null;
        if (d == null) continue;
        if (d > 0) up++; else if (d < 0) dn++;
      }
      if (!up && !dn) return null;
      if (up && !dn) return "higher";
      if (dn && !up) return "lower";
      return up > dn * 2 ? "mostly higher" : dn > up * 2 ? "mostly lower" : "mixed";
    };
    for (const cl of ctx.news) {
      const tks = [...new Set(cl.items.map((x) => x.t).filter(Boolean))];
      if (tks.length) { const tone = toneOf(tks); if (tone) cl.tape = tone; }
    }

    // Macro trajectory: what just landed (with the actual) and what is inside three days, priors
    // labeled as priors — this feed carries no street consensus and the prompt repeats that.
    try {
      const ent = macroCache && Array.isArray(macroCache.entries) ? macroCache.entries : [];
      const released = [], upcoming = [];
      for (const e of ent) {
        const df = earnDayDiff(e.d, t);
        if (df == null) continue;
        if (e.actual != null && df <= 0) {
          released.push({ k: e.k, label: e.label, d: e.d,
            actual: macroStatText(e.k, e.actual), prior: macroStatText(e.k, e.prior) });
        } else if (macroEntryState(e, t) === "upcoming" && df >= 0 && df <= 3) {
          upcoming.push({ k: e.k, label: e.label, d: e.d, inDays: df, prior: macroStatText(e.k, e.prior) });
        }
      }
      ctx.macro = (released.length || upcoming.length) ? { released, upcoming } : null;
    } catch (_) { ctx.macro = null; }
    return ctx;
  }

  const LAND_SYSTEM = `You write ONE commentary section, titled THE LANDSCAPE, for a markets message read by a single experienced trader who already received a full quantitative brief an hour earlier. That brief gave them every number: index moves, movers, sector medians, breadth, positioning, earnings, the macro calendar. Your section exists BECAUSE the numbers were already covered. Do not recite them again.

You receive a JSON context holding the last ${LAND_WINDOW_H} hours of headlines grouped by industry (each with an id, ticker where one applies, source and age in hours), an optional one-word read of how each group's names traded, and the macro prints that just landed or are about to.

WHAT TO WRITE
Write about what is actually happening in the world and why it matters to someone with money at risk. Aim for 2,800–3,300 characters across 3 to 6 paragraphs — a proper read, not a caption. If the corpus genuinely cannot support that length, write less rather than padding; a stretched thin day is worse than a short honest one. The value you add is connective, not descriptive:
- Say when several headlines are the same story wearing different clothes, and name the story.
- Say when something is the second or third instance of a pattern rather than a new event.
- Say when a development has NOT yet been repriced, or when the reaction looks like positioning rather than conviction.
- Say when a cluster connects to nothing else on the board — an isolated loud story is worth flagging as isolated.
- Prefer the second-order point over the first-order one.

VOICE
Write like the sharpest analyst at the desk after the second coffee: dry, vivid, occasionally funny, never sloppy. Wit is welcome when it carries the point — a good metaphor that makes the mechanism obvious, a deadpan aside about a narrative the market is telling itself. Wit is not welcome as decoration: no puns for their own sake, no exclamation marks, no finance clichés ("cautiously optimistic", "wait and see", "time will tell"), and never a joke at the expense of precision. When something is genuinely dull, saying so plainly IS the entertainment. The reader should finish knowing more and having enjoyed the trip; they should never catch you performing.

HARD RULES
- 3 to 6 paragraphs. No headings, no bullets, no markup of any kind. Plain sentences.
- Every claim must rest on a headline or macro print in the context. You may reason across them, draw analogies, and note what is absent — you may not introduce events, companies, people or dates that are not in the context.
- Do NOT restate numbers from the brief. Figures should be rare; when you use one it must appear in the context verbatim. That includes YEARS — "like it is 2019 again" fails the gate unless 2019 is in the context. Reach for "the last cycle" or "two squeezes ago" instead.
- Only use ticker symbols and proper names that appear in the context.
- Never give instructions or advice. Describe where risk sits; do not say what to do about it. No "should", no buy/sell language, no price targets.
- If the context is thin, say so plainly in one short paragraph rather than inflating it. A thin day honestly described is worth more than a manufactured narrative.

OUTPUT
Respond with ONLY a JSON object, no prose outside it and no markdown fences:
{"story": "<paragraphs separated by blank lines>", "refs": ["<headline id>", ...]}
"refs" lists the ids of every headline your paragraphs actually rest on, between 2 and 12 of them. They are rendered to the reader as the sources footer, so a ref you did not use is a broken citation.`;

  async function landProse(ctx) {
    if (!AI_KEY() && !aiFetch) return { ok: false, error: "no key" };
    if (!landDayLeft()) return { ok: false, error: "landscape-daily-cap" };
    if (!ctx || !Array.isArray(ctx.news) || !ctx.news.length) return { ok: false, error: "no headlines in the window" };
    const opts = { system: LAND_SYSTEM, maxTokens: LAND_MAX_TOKENS, effort: LAND_EFFORT };
    let used = LAND_MODEL;
    let call = await callModel(LAND_MODEL, ctx, opts);
    if (!call.ok && LAND_MODEL_FALLBACK && LAND_MODEL_FALLBACK !== LAND_MODEL) {
      log("landscape: primary failed (" + call.error + "), retrying on " + LAND_MODEL_FALLBACK);
      used = LAND_MODEL_FALLBACK;
      call = await callModel(LAND_MODEL_FALLBACK, ctx, opts);
    }
    if (!call.ok) return { ok: false, error: call.error };
    let obj = null;
    try { obj = JSON.parse(String(call.text).replace(/^```(?:json)?|```$/gm, "").trim()); }
    catch (_) { return { ok: false, error: "unparseable model output" }; }
    let v = validateLandProse(obj, ctx);
    let cut = 0, cutWhy = null;
    if (!v.ok && /(?:number|name) not in context/.test(v.error)) {
      // Proportionate rung: a fabrication hit costs the SENTENCE, not the commentary. The salvaged
      // text re-runs the FULL validator (paragraph count, advice, markup, refs), so nothing ships
      // that whole-object validation would not have passed on its own.
      const sv = briefSalvageProse(obj.story, ctx);
      if (sv.cut && sv.text) {
        const v2 = validateLandProse({ story: sv.text, refs: obj.refs }, ctx);
        if (v2.ok) { v = v2; cut = sv.cut; cutWhy = sv.why; log("landscape: salvaged — " + sv.cut + " sentence(s) withheld (" + sv.why + ")"); }
      }
    }
    if (!v.ok) return { ok: false, error: v.error };
    const d = briefDayKey(Date.now());
    if (landDay.d !== d) landDay = { d, n: 0 };
    landDay.n++;
    return { ok: true, story: v.story, refs: v.refs, model: used, cut, cutWhy, refsNote: v.refsNote || null };
  }

  // One generation per hour-bucket, shared by everyone waking in it — same economics as the brief.
  // No mechanical fallback exists here (the prose IS the message), so a failed generation ships the
  // explicit "commentary unavailable" line: silence would read as a quiet news day and hide a dead
  // layer from the one person who could fix it.
  async function generateLandscape(now) {
    const t = now || Date.now();
    const key = briefDayKey(t) + "|" + new Date(t).getUTCHours();
    if (landCache && landCache.key === key && t - landCache.at < LAND_CACHE_MS) return landCache;
    const ctx = buildLandCtx(t);
    let prose = null, degraded = null, model = null;
    if (LAND_ON) {
      try {
        const p = await landProse(ctx);
        if (p.ok) {
          prose = { story: p.story, refs: p.refs }; model = p.model;
          // Salvage ships the prose AND the note: ctx.proseErr renders alongside it now. A refs
          // trim is the same kind of honest disclosure — combined when both happen on one send.
          const notes = [];
          if (p.cut) notes.push(p.cut + " sentence(s) withheld \u2014 " + p.cutWhy);
          if (p.refsNote) { notes.push(p.refsNote); log("landscape: " + p.refsNote); }
          if (notes.length) { degraded = notes.join(" \u00b7 "); landLastErr = degraded; }
        } else { degraded = p.error; landLastErr = p.error; }
      } catch (e) { degraded = (e && e.message) || String(e); landLastErr = degraded; }
    } else degraded = "disabled";
    if (degraded) ctx.proseErr = degraded;
    const r = renderLandscape(ctx, prose);
    landCache = { key, at: t, message: r.message, sources: r.sources, dropped: r.dropped, model, degraded };
    if (degraded) log("landscape: degraded (" + degraded + ")");
    if (r.dropped && r.dropped.length) log("landscape: budget shed [" + r.dropped.join(", ") + "]");
    return landCache;
  }

  async function landTick() {
    if (!pushOn() || !pushRecipients.size) return 0;
    const now = Date.now();
    let sent = 0;
    for (const rec of pushRecipients.values()) {
      if (rec.muted) continue;
      const res = schedFor(rec, "landscape");
      if (!Number.isFinite(res.hour)) continue;
      const tz = res.isDefault ? 0 : briefTzFor(rec);
      const day = schedDueAt(res, now, tz);
      if (!day) continue;
      if (landSent.get(rec.chat) === day) continue;
      landSent.set(rec.chat, day);
      let b = null;
      try { b = await generateLandscape(now); }
      catch (e) { log("landscape generate failed (isolated): " + (e && e.message)); continue; }
      // force, like the brief: a scheduled send is not one of the day's alerts and must not be the
      // message the hourly cap happens to eat.
      pushEnqueue(rec.chat, b.message, true);
      sent++;
    }
    return sent;
  }
  async function landTestNow(chat, owner, isAdmin, fresh, operatorOnly) {
    if (!pushOn()) return { ok: false, error: "disabled" };
    const targets = testTargets(chat, owner, isAdmin, operatorOnly);
    if (!targets.length) return { ok: false, error: chat ? "forbidden" : (operatorOnly ? "no-operator-designated" : "no-recipients") };
    if (fresh) landCache = null;
    let b;
    try { b = await generateLandscape(Date.now()); }
    catch (e) { return { ok: false, error: (e && e.message) || "generate failed" }; }
    for (const c of targets) pushEnqueue(c, b.message, true);
    return { ok: true, sent: targets.length, parts: 1, chars: [briefVisibleLen(b.message)],
      degraded: b.degraded || null, dropped: b.dropped || [], sources: b.sources,
      model: b.model || null, dayLeft: landDayLeft() };
  }


  function briefDayKey(now) { return new Date(now).toISOString().slice(0, 10); }
  function briefDayLeft() {
    const d = briefDayKey(Date.now());
    if (briefDay.d !== d) return BRIEF_PER_DAY;
    return Math.max(0, BRIEF_PER_DAY - briefDay.n);
  }

  // ---- FRED level series: rates + claims ---------------------------------------------------------
  // The release calendar (MACRO_RELEASES) answers "what prints and when". It carries no LEVELS, so
  // the brief had nothing true to say about the curve. These four series are daily/weekly, cheap,
  // and are the ones actually asked for. Same degradation contract as everything else on this tick:
  // no key or a dead endpoint means the rates lines are ABSENT from the brief, never stale or faked.
  const MACRO_LEVELS = [
    { k: "10y", sid: "DGS10", dp: 2, unit: "" },
    { k: "2y", sid: "DGS2", dp: 2, unit: "" },
    { k: "30y", sid: "DGS30", dp: 2, unit: "" },
    { k: "claims", sid: "ICSA", dp: 0, unit: "k", scale: 0.001 },
  ];
  let macroLevels = null;   // { at, series: { k: { v, prev, wowBp, obsD } } }
  async function fetchMacroLevels(fget) {
    const out = {};
    for (const def of MACRO_LEVELS) {
      try {
        const j = await fget("series/observations", { series_id: def.sid, sort_order: "desc", limit: 30 });
        const obs = fredObsSeries(j);
        if (!obs.length) continue;
        const asc = obs.slice();
        const last = asc[asc.length - 1];
        // Week-over-week off the observation dates, not "five rows back": treasury series skip
        // holidays, and counting rows would silently compare across a long weekend as if it were a week.
        const wk = Date.parse(last[0]) - 7 * 24 * 3600e3;
        let prev = null;
        for (let i = asc.length - 2; i >= 0; i--) { if (Date.parse(asc[i][0]) <= wk) { prev = asc[i]; break; } }
        out[def.k] = { v: last[1], obsD: last[0], prev: prev ? prev[1] : null,
          chg: prev ? +(last[1] - prev[1]).toFixed(3) : null };
      } catch (_) { /* one dead series must not cost the others */ }
    }
    if (Object.keys(out).length) macroLevels = { at: Date.now(), series: out };
    return macroLevels;
  }
  // ---- Housing / MBS board (build 2026.08.21-04) --------------------------------------------
  // Every panel on the Housing tab is a FRED series pulled in full (history for the chart, not
  // just the latest print). Same degradation contract as the macro tick: no key or a dead series
  // means that PANEL is absent with its reason on the payload — never stale, never faked. The two
  // panels whose originals are file-fed (SIFMA issuance, FINRA TRACE volume) are declared here as
  // `pending` so the tab can say so honestly instead of showing a blank card.
  const HOUSING_SERIES = [
    { k: "rate30",  sid: "MORTGAGE30US", title: "30y fixed mortgage rate", unit: "%",   freq: "w", dp: 2, start: "2005-01-01",
      src: "Freddie Mac PMMS via FRED", proxy: "Original panel is the 30y JUMBO average (Bankrate/Bloomberg, no public API). Conforming tracks it within ~20bp." },
    { k: "sf",      sid: "HOUST1F",      title: "Single-family starts", unit: "M saar", freq: "m", dp: 3, start: "2000-01-01", scale: 0.001,
      src: "Census via FRED" },
    { k: "mf",      sid: "HOUST5F",      title: "Multifamily starts (5+)", unit: "M saar", freq: "m", dp: 3, start: "2000-01-01", scale: 0.001,
      src: "Census via FRED" },
    { k: "supply",  sid: "MSACSR",       title: "Months' supply — new homes", unit: "months", freq: "m", dp: 1, start: "2000-01-01",
      src: "Census via FRED", proxy: "Original panel is months' supply of EXISTING homes (NAR, not on FRED since 2022). New-home supply moves in the same direction at a different level." },
    { k: "sales",   sid: "HSN1F",        title: "New single-family home sales", unit: "M saar", freq: "m", dp: 3, start: "2000-01-01", scale: 0.001,
      src: "Census via FRED", proxy: "Original panel is EXISTING home sales (NAR, off FRED since 2022). New-home sales are the public stand-in until a Zillow/Redfin feed is wired." },
    { k: "price",   sid: "MSPUS",        title: "Median sales price of houses sold", unit: "$k", freq: "q", dp: 1, start: "2000-01-01", scale: 0.001,
      src: "Census/HUD via FRED", proxy: "Original panel is NAR median EXISTING-home price. Census median (new + existing, quarterly) runs higher but tracks the same cycle." },
    { k: "spread",  sid: "BAMLC0A4CBBB", title: "Credit spread proxy — BBB corporate OAS", unit: "bp", freq: "d", dp: 0, start: "2019-01-01", scale: 100,
      src: "ICE BofA via FRED", proxy: "Original panel is Deutsche Bank's fixed 2y non-QM spread (proprietary, no public series). ICE BofA BBB OAS is the proxy — same risk-premium cycle, different level." },
  ];
  const HOUSING_STALE = 6 * 3600 * 1000, HOUSING_RETRY_MS = 30 * 60 * 1000;
  // A FRED series can be RETIRED without any error: the request still returns 200, the observations
  // just stop. DRTSPM did exactly that (SLOOS dropped its prime-mortgage question after 2014Q4) and
  // the panel sat on the board for a decade showing a 2014 print as if it were current. That is the
  // "never stale, never faked" contract failing quietly, so enforce it: a series whose newest
  // observation is older than any publication lag its own cadence could explain is DROPPED with its
  // reason, exactly like a series that failed to fetch. Thresholds are deliberately loose — the job
  // is to catch a retirement, not to quibble with a slow month.
  const HOUSING_MAX_AGE = { d: 30, w: 60, m: 180, q: 400 };
  function housingStaleAge(def, lastD) {
    const days = Math.floor((Date.now() - Date.parse(lastD)) / 864e5);
    const cap = HOUSING_MAX_AGE[def.freq] || 400;
    return days > cap ? days : 0;
  }
  let housingCache = null, housingVer = 0, housingSig = "", lastHousingOk = 0;
  function housingDress(def, obs) {
    const sc = def.scale || 1;
    const pts = obs.map((o) => [o[0], +(o[1] * sc).toFixed(def.dp)]);
    const last = pts[pts.length - 1];
    const ms = Date.parse(last[0]);
    const back = (days) => { const t = ms - days * 24 * 3600e3; for (let i = pts.length - 2; i >= 0; i--) if (Date.parse(pts[i][0]) <= t) return pts[i]; return null; };
    const yAgo = back(365), wAgo = def.freq === "d" || def.freq === "w" ? back(7) : null, mAgo = def.freq === "m" ? back(28) : null;
    const pct = (a, b) => (a && b && b[1]) ? +((a[1] / b[1] - 1) * 100).toFixed(1) : null;
    let lo = pts[0], hi = pts[0];
    for (const p of pts) { if (p[1] < lo[1]) lo = p; if (p[1] > hi[1]) hi = p; }
    return { k: def.k, sid: def.sid, title: def.title, unit: def.unit, freq: def.freq, dp: def.dp, src: def.src, proxy: def.proxy || null,
      n: pts.length, obs: pts, last: { d: last[0], v: last[1] },
      yoy: yAgo ? { v: yAgo[1], d: yAgo[0], pct: pct(last, yAgo), diff: +(last[1] - yAgo[1]).toFixed(def.dp) } : null,
      wow: wAgo ? { v: wAgo[1], diff: +(last[1] - wAgo[1]).toFixed(def.dp) } : null,
      mom: mAgo ? { v: mAgo[1], pct: pct(last, mAgo) } : null,
      lo: { d: lo[0], v: lo[1] }, hi: { d: hi[0], v: hi[1] } };
  }
  async function fetchHousing() {
    const now = Date.now();
    const key = process.env.FRED_KEY || "";
    let err = null;
    const series = {}, missing = [];
    if (!key) err = "FRED_KEY not set";
    else {
      const fget = async (path, params) => {
        const q = new URLSearchParams(Object.assign({ api_key: key, file_type: "json" }, params));
        const res = await fetch("https://api.stlouisfed.org/fred/" + path + "?" + q, {
          headers: { accept: "application/json" }, signal: AbortSignal.timeout(20000) });
        if (!res.ok) throw new Error("FRED HTTP " + res.status);
        return res.json();
      };
      for (const def of HOUSING_SERIES) {
        try {
          await sleep(150);
          const obs = fredObsSeries(await fget("series/observations", { series_id: def.sid, observation_start: def.start, sort_order: "asc", limit: 100000 }));
          if (!obs.length) { missing.push(def.sid); continue; }
          const stale = housingStaleAge(def, obs[obs.length - 1][0]);
          if (stale) { missing.push(def.sid + " (no print in " + stale + "d — discontinued or dropped by FRED)"); continue; }
          series[def.k] = housingDress(def, obs);
        } catch (e) { missing.push(def.sid + " (" + ((e && e.message) || "fetch failed") + ")"); }
      }
      if (!Object.keys(series).length) err = "FRED unreachable: " + missing.join(", ");
      else if (missing.length) log("housing: series absent this pass: " + missing.join(", "));
    }
    if (err && housingCache && housingCache.series && Object.keys(housingCache.series).length) {
      // keep the warm board, surface the failure
      housingCache = Object.assign({}, housingCache, { ts: now, error: err });
      log("housing: refresh failed, serving warm board (" + err + ")");
      return;
    }
    const sig = Object.keys(series).sort().map((k) => k + ":" + series[k].last.d + ":" + series[k].last.v + ":" + series[k].n).join(",") + "|" + (err || "");
    if (sig !== housingSig) { housingSig = sig; housingVer = now; }
    if (!err) lastHousingOk = now;
    housingCache = { ts: now, dataTs: housingVer, asOf: err ? (housingCache && housingCache.asOf) || null : now, error: err,
      series, missing };
    if (!err && store.saveHousing) store.saveHousing({ ts: now, series, missing });
    log("Housing board: " + Object.keys(series).length + "/" + HOUSING_SERIES.length + " FRED series" + (err ? " (" + err + ")" : ""));
  }
  const housingTick = () => { fetchHousing().catch((e) => log("housing tick failed: " + (e && e.message))); };
  function loadHousingCache() {
    const data = store.loadHousing ? store.loadHousing() : null;
    if (!data || !data.series || !Object.keys(data.series).length) return false;
    housingVer = data.ts || Date.now();
    // Same guard on the warm path: a cache written before a series retired would otherwise put the
    // stale panel back on the board for the first six hours after every redeploy.
    const series = {}, missing = (data.missing || []).slice();
    for (const def of HOUSING_SERIES) {
      const ser = data.series[def.k]; if (!ser || !ser.last) continue;
      const stale = housingStaleAge(def, ser.last.d);
      if (stale) missing.push(def.sid + " (warm cache: no print in " + stale + "d)"); else series[def.k] = ser;
    }
    if (!Object.keys(series).length) return false;
    housingCache = { ts: Date.now(), dataTs: housingVer, asOf: data.ts || null, error: null, series, missing };
    return true;
  }
  // ---- Liquidity board (build 2026.08.21-04) --------------------------------------------------
  // Fed net liquidity = total assets − TGA − ON RRP, on the H.4.1 Wednesday dates, plus % of nominal
  // GDP (quarterly, forward-filled). Everything is normalised to BILLIONS before any arithmetic:
  // the H.4.1 lines and reserves publish in millions, ON RRP and GDP in billions — mixing them raw
  // understates ON RRP 1000× (a live bug on at least one public monitor). Refires on the Thursday
  // ~4:30 ET release instead of blind polling.
  const LIQ_SERIES = [
    { k: "assets",   sid: "WALCL",      title: "Total assets",          unit: "$B", scale: 0.001, start: "2002-12-18", freq: "w" },
    { k: "ust",      sid: "TREAST",     title: "Treasuries held",       unit: "$B", scale: 0.001, start: "2002-12-18", freq: "w" },
    { k: "agency",   sid: "FEDDT",      title: "Agency debt",           unit: "$B", scale: 0.001, start: "2002-12-18", freq: "w" },
    { k: "mbs",      sid: "WSHOMCB",    title: "MBS held",              unit: "$B", scale: 0.001, start: "2002-12-18", freq: "w" },
    { k: "tga",      sid: "WTREGEN",    title: "Treasury General Account", unit: "$B", scale: 0.001, start: "2002-12-18", freq: "w" },
    { k: "rrp",      sid: "RRPONTSYD",  title: "ON RRP",                unit: "$B", scale: 1,     start: "2002-12-18", freq: "d" },
    { k: "gdp",      sid: "GDP",        title: "Nominal GDP",           unit: "$B", scale: 1,     start: "2002-01-01", freq: "q" },
    { k: "reserves", sid: "WRESBAL",    title: "Bank reserves",         unit: "$B", scale: 0.001, start: "2002-12-18", freq: "w" },
    { k: "sofr",     sid: "SOFR",       title: "SOFR",                  unit: "%",  scale: 1,     start: "2018-04-01", freq: "d" },
    { k: "iorb",     sid: "IORB",       title: "Interest on reserve balances", unit: "%", scale: 1, start: "2021-07-29", freq: "d" },
  ];
  const LIQ_STALE = 6 * 3600 * 1000, LIQ_RETRY_MS = 30 * 60 * 1000;
  let liqCache = null, liqVer = 0, liqSig = "", lastLiqOk = 0;
  // value at or before a date (series ascending [[d,v]]) — the alignment rule for daily → Wednesday
  function liqAt(obs, d) { let lo = 0, hi = obs.length - 1, r = null; while (lo <= hi) { const m = (lo + hi) >> 1; if (obs[m][0] <= d) { r = obs[m]; lo = m + 1; } else hi = m - 1; } return r; }
  function liqBuild(raw) {
    const A = raw.assets, T = raw.tga, R = raw.rrp, G = raw.gdp;
    if (!A || !T) return null;
    const net = [];
    for (const [d, a] of A) {
      const t = liqAt(T, d); if (!t || Date.parse(d) - Date.parse(t[0]) > 7 * 864e5) continue;   // TGA is a weekly avg dated the same Wednesday
      const rr = R ? liqAt(R, d) : null; const r = rr && (Date.parse(d) - Date.parse(rr[0])) <= 7 * 864e5 ? rr[1] : 0;   // ON RRP: last daily print ≤ Wed; none before 2013 → 0
      const g = G ? liqAt(G, d) : null;
      const n = a - t[1] - r;
      net.push([d, +n.toFixed(1), g ? +(n / g[1] * 100).toFixed(2) : null, +a.toFixed(1), +t[1].toFixed(1), +r.toFixed(1)]);
    }
    if (!net.length) return null;
    const last = net[net.length - 1];
    let peak = net[0]; for (const p of net) if (p[2] != null && (peak[2] == null || p[2] > peak[2])) peak = p;
    const wk = liqAt(net, new Date(Date.parse(last[0]) - 7 * 864e5).toISOString().slice(0, 10));
    const prev = wk && wk[0] !== last[0] ? wk : net[net.length - 2];
    // YTD: last print of the prior year → latest, signed by liquidity effect (assets add when up, drains add when DOWN)
    const y0 = last[0].slice(0, 4) + "-01-01";
    const base = (obs) => obs ? liqAt(obs, y0) : null, cur = (obs) => obs ? obs[obs.length - 1] : null;
    const items = [];
    const push = (k, label, obs, drain) => { const b = base(obs), c = cur(obs); if (!b || !c) return; const dv = c[1] - b[1]; items.push({ k, label, delta: +dv.toFixed(1), effect: +((drain ? -dv : dv)).toFixed(1), from: b[0], to: c[0] }); };
    push("ust", "Treasuries", raw.ust, false); push("agency", "Agency debt", raw.agency, false); push("mbs", "MBS", raw.mbs, false);
    push("tga", "TGA", raw.tga, true); push("rrp", "ON RRP", raw.rrp, true);
    const nb = liqAt(net, y0);
    const ytd = { from: nb ? nb[0] : null, to: last[0], items, net: nb ? +(last[1] - nb[1]).toFixed(1) : null };
    // QT end: most recent date the 13-week change in Treasury holdings turned non-negative after a run of declines
    let qtEnd = null;
    if (raw.ust && raw.ust.length > 30) { const u = raw.ust; for (let i = u.length - 1; i >= 13; i--) { const ch = u[i][1] - u[i - 13][1]; if (ch < -5) { qtEnd = i + 1 < u.length ? u[i + 1][0] : null; break; } } if (qtEnd && qtEnd === u[u.length - 1][0]) qtEnd = null; }
    // SOFR − IORB (bp) where both print
    let sofrIorb = null;
    if (raw.sofr && raw.iorb) { const I = raw.iorb; sofrIorb = raw.sofr.filter((p) => p[0] >= I[0][0]).map((p) => { const i = liqAt(I, p[0]); return i ? [p[0], +((p[1] - i[1]) * 100).toFixed(0)] : null; }).filter(Boolean); }
    return { net, last: { d: last[0], v: last[1], pctGdp: last[2] }, prev: prev ? { d: prev[0], v: prev[1] } : null, peak: { d: peak[0], pctGdp: peak[2], v: peak[1] }, ytd, qtEnd, sofrIorb };
  }
  async function fetchLiquidity() {
    const now = Date.now();
    const key = process.env.FRED_KEY || "";
    let err = null; const raw = {}, levels = {}, missing = [];
    if (!key) err = "FRED_KEY not set";
    else {
      const fget = async (path, params) => {
        const q = new URLSearchParams(Object.assign({ api_key: key, file_type: "json" }, params));
        const res = await fetch("https://api.stlouisfed.org/fred/" + path + "?" + q, { headers: { accept: "application/json" }, signal: AbortSignal.timeout(20000) });
        if (!res.ok) throw new Error("FRED HTTP " + res.status);
        return res.json();
      };
      for (const def of LIQ_SERIES) {
        try {
          await sleep(150);
          const obs = fredObsSeries(await fget("series/observations", { series_id: def.sid, observation_start: def.start, sort_order: "asc", limit: 100000 }));
          if (!obs.length) { missing.push(def.sid); continue; }
          raw[def.k] = obs.map((o) => [o[0], o[1] * def.scale]);
          const L = raw[def.k][raw[def.k].length - 1], P = raw[def.k].length > 1 ? raw[def.k][raw[def.k].length - 2] : null;
          levels[def.k] = { sid: def.sid, title: def.title, unit: def.unit, freq: def.freq, d: L[0], v: +L[1].toFixed(def.unit === "%" ? 2 : 1), chg: P ? +(L[1] - P[1]).toFixed(def.unit === "%" ? 2 : 1) : null,
            obs: def.k === "gdp" ? undefined : raw[def.k].map((p) => [p[0], +p[1].toFixed(def.unit === "%" ? 2 : 1)]) };
        } catch (e) { missing.push(def.sid + " (" + ((e && e.message) || "fetch failed") + ")"); }
      }
      if (!raw.assets || !raw.tga) err = "FRED unreachable or core series absent: " + missing.join(", ");
      else if (missing.length) log("liquidity: series absent this pass: " + missing.join(", "));
    }
    if (err && liqCache && liqCache.derived) { liqCache = Object.assign({}, liqCache, { ts: now, error: err }); log("liquidity: refresh failed, serving warm board (" + err + ")"); return; }
    const derived = err ? null : liqBuild(raw);
    const sig = (derived ? derived.last.d + ":" + derived.last.v + ":" + derived.net.length : "") + "|" + Object.keys(levels).sort().map((k) => k + levels[k].d + levels[k].v).join(",") + "|" + (err || "");
    if (sig !== liqSig) { liqSig = sig; liqVer = now; }
    if (!err) lastLiqOk = now;
    liqCache = { ts: now, dataTs: liqVer, asOf: err ? (liqCache && liqCache.asOf) || null : now, error: err, levels, derived, missing };
    if (!err && store.saveLiquidity) store.saveLiquidity({ ts: now, levels, derived, missing });
    log("Liquidity board: " + Object.keys(levels).length + "/" + LIQ_SERIES.length + " FRED series" + (derived ? ", net " + derived.last.v + "B (" + derived.last.pctGdp + "% GDP)" : "") + (err ? " (" + err + ")" : ""));
  }
  const liqTick = () => { fetchLiquidity().catch((e) => log("liquidity tick failed: " + (e && e.message))); };
  function loadLiquidityCache() {
    const data = store.loadLiquidity ? store.loadLiquidity() : null;
    if (!data || !data.levels || !Object.keys(data.levels).length) return false;
    liqVer = data.ts || Date.now();
    liqCache = { ts: Date.now(), dataTs: liqVer, asOf: data.ts || null, error: null, levels: data.levels, derived: data.derived || null, missing: data.missing || [] };
    return true;
  }
  // H.4.1 lands Thursdays ~16:30 ET. 21:00 UTC covers EDT with margin (EST: 21:30, still before the next check).
  function liqReleaseCrossed() {
    const d = new Date(); const dow = d.getUTCDay();
    const back = (dow - 4 + 7) % 7; const thu = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() - back, 21, 0, 0);
    const lastRel = thu <= Date.now() ? thu : thu - 7 * 864e5;
    return lastLiqOk < lastRel;
  }
  // Rate lines for the brief, built ONLY from series that actually came back. 2s10s is derived and
  // therefore requires both legs — a spread computed from one leg would be a fabrication.
  function briefRates() {
    const s = macroLevels && macroLevels.series;
    if (!s) return { rates: [], data: [] };
    const rates = [], data = [];
    const bp = (c) => (c == null ? null : (c > 0 ? "+" : "\u2212") + Math.abs(Math.round(c * 100)) + "bp w/w");
    for (const k of ["10y", "2y", "30y"]) if (s[k]) rates.push({ k, v: s[k].v.toFixed(2), chg: bp(s[k].chg) });
    if (s["10y"] && s["2y"]) {
      const sp = Math.round((s["10y"].v - s["2y"].v) * 100);
      rates.push({ k: "2s10s", v: (sp >= 0 ? "+" : "\u2212") + Math.abs(sp) + "bp", chg: null });
    }
    if (s.claims) data.push({ k: "Claims", v: Math.round(s.claims.v / 1000) + "k" });
    return { rates, data };
  }

  // ---- context assembly --------------------------------------------------------------------------
  // Thin: every number here is read off state the poller already maintains. Nothing is computed for
  // the brief that the board does not already compute for itself — that is what keeps the brief and
  // the board from ever disagreeing.
  function briefRowsFor(uni) {
    const list = uni === "crypto" ? (crypto ? mainMarkets() : []) : activeMarkets().filter((r) => r.uni === "xyz");
    return list.filter((r) => r && !r.delisted);
  }
  function briefD1(r) { return (r && r.d1 != null && isFinite(r.d1)) ? +(+r.d1).toFixed(2) : null; }
  function buildBriefCtx(now, tzMin) {
    const t = now || Date.now();
    const ctx = { at: t, tz: tzMin || 0, build: version || "dev" };
    const xyz = briefRowsFor("stocks"), main = briefRowsFor("crypto");

    // -- benchmarks: the SPX proxy the whole app already resolves, and BTC for the perp book
    const bStock = benchCoin ? rows.get(benchCoin) : null;
    const bCrypto = crypto ? rows.get(MAIN_BENCH) : null;
    ctx.bench = {
      stocks: bStock ? { t: String(bStock.ticker || "").toUpperCase(), d1: briefD1(bStock) } : null,
      crypto: bCrypto ? { t: MAIN_BENCH, d1: briefD1(bCrypto) } : null,
    };

    // -- indices / commodities / FX, straight off the roster's own classification
    const byClass = { Index: [], Commodity: [], FX: [] };
    for (const r of xyz) {
      const c = classifyCached(r.ticker, r.uni);
      if (!byClass[c.assetClass]) continue;
      const T = String(r.ticker || "").toUpperCase();
      if (bStock && r.coin === bStock.coin) { /* benchmark still belongs in the index line */ }
      const d1 = briefD1(r);
      if (d1 == null && !(r.px > 0)) continue;
      byClass[c.assetClass].push({ t: T, d1, px: r.px > 0 ? r.px : null,
        level: /^(VIX|VOL)$/.test(T) ? 1 : 0 });
    }
    const rank = (a) => a.sort((x, y) => (y.d1 == null ? -1e9 : y.d1) - (x.d1 == null ? -1e9 : x.d1));
    ctx.indices = rank(byClass.Index).slice(0, BRIEF_IDX_MAX);
    ctx.commodities = rank(byClass.Commodity).slice(0, 4);
    ctx.fx = rank(byClass.FX).slice(0, 3);

    // -- sector + industry groups, and the curated baskets, from the basket layer. It derives both
    //    from the LIVE roster on every read, so listings and delistings move them with no deploy.
    try {
      const d1By = new Map();
      for (const r of xyz.concat(main)) { const d = briefD1(r); if (d != null) d1By.set(String(r.ticker || "").toUpperCase(), d); }
      const groups = [], picks = [];
      for (const b of builtinBaskets()) {
        const vals = (b.members || []).map((m) => d1By.get(m)).filter((v) => v != null);
        const entry = { name: b.name, label: b.label || b.name, kind: b.kind || null, vals };
        if (b.kind === "sector" || b.kind === "industry") groups.push(entry);
        else if (b.cur) picks.push(entry);   // curated (MAG7 today) — an instrument, not a sector
      }
      ctx.sectors = briefRankGroups(groups, BRIEF_GROUP_MIN);
      ctx.baskets = briefRankGroups(picks, 2);
    } catch (_) { ctx.sectors = []; ctx.baskets = []; }

    // -- movers, each book against its own benchmark. Index/commodity/FX instruments are excluded:
    //    they have their own block, and a currency pair in a "top movers" list is noise.
    const noteFor = (r) => {
      const bits = [];
      if (r.uni === "main") {
        const f = r.funding != null && isFinite(r.funding) ? r.funding * 24 * 365 * 100 : null;
        if (f != null && Math.abs(f) >= 15) bits.push("funding " + (f > 0 ? "+" : "\u2212") + Math.abs(f).toFixed(0) + "%");
      }
      return bits.length ? bits.join(", ") : null;
    };
    // EXCLUSION, not inclusion. Requiring assetClass === "Equity" silently dropped any name the
    // static map has not been taught yet — a fresh listing would go missing from its own movers
    // list while every other panel showed it. What actually needs excluding is the handful of
    // classes that already have their own block above.
    const MOVER_SKIP = new Set(["Index", "Commodity", "FX"]);
    const benchTk = { xyz: ctx.bench.stocks && ctx.bench.stocks.t, main: ctx.bench.crypto && ctx.bench.crypto.t };
    const moverList = (list) => list.filter((r) => {
      const T = String(r.ticker || "").toUpperCase();
      // The benchmark is the reference line under the list; ranking it against itself prints a
      // relative move of zero and costs a real mover its slot.
      if (T === String(benchTk[r.uni === "main" ? "main" : "xyz"] || "").toUpperCase()) return false;
      return !MOVER_SKIP.has(classifyCached(r.ticker, r.uni).assetClass);
    }).map((r) => ({ t: String(r.ticker || "").toUpperCase(), d1: briefD1(r), note: noteFor(r) }));
    ctx.movers = {
      stocks: briefMovers(moverList(xyz), ctx.bench.stocks && ctx.bench.stocks.d1, BRIEF_MOVERS_N),
      crypto: briefMovers(moverList(main), ctx.bench.crypto && ctx.bench.crypto.d1, BRIEF_MOVERS_N),
    };

    // -- regime, per book. Breadth on three horizons off the same reference prices the board uses.
    const regimeFor = (list) => {
      const d1 = [], d7 = [], d30 = [], ma = [];
      for (const r of list) {
        const a = briefD1(r); if (a != null) d1.push(a);
        const b = pctOf(r.px, r.ref && r.ref.p7d); if (b != null) d7.push(b);
        const c2 = pctOf(r.px, r.ref && r.ref.p30d); if (c2 != null) d30.push(c2);
        // EMA200 from the row's OWN daily closes. The previous version read `tb.e200` off the
        // trend index, which has never carried an e200 field in any build — `undefined > 0` is
        // false for every name, so this row was null for both books from the day it shipped.
        // trendByCoin holds e13/e21 only; the 200 lives in the daily series, so take it there.
        if (Array.isArray(r.dailyRaw) && r.px > 0) {
          const cl = [];
          for (const b of r.dailyRaw) if (b && Number.isFinite(b.c)) cl.push(b.c);
          if (cl.length >= 200) {
            const kk = 2 / 201;
            let e = cl.slice(0, 200).reduce((a, b) => a + b, 0) / 200;
            for (let i = 200; i < cl.length; i++) e = cl[i] * kk + e * (1 - kk);
            if (e > 0) ma.push(r.px > e ? 1 : 0);
          }
        }
      }
      if (!d1.length) return null;
      const bd1 = briefBreadth(d1), bd7 = briefBreadth(d7), bd30 = briefBreadth(d30);
      return { breadth: bd1, d7: bd7, d30: bd30,
        decaying: bd1 != null && bd7 != null && bd30 != null && bd1 < bd7 && bd7 < bd30,
        // Coverage rides with the number. A 200-day EMA needs 200 candles, which a recently
        // listed name does not have, so this is a share of the COVERED names — and the renderer
        // discloses n when coverage is partial rather than implying the whole book.
        ma200: ma.length ? Math.round((100 * ma.filter(Boolean).length) / ma.length) : null,
        ma200N: ma.length || null, ma200Of: list.length || null,
        // Rounded HERE, at the source. retStd is the only raw-float source that reaches this
        // context, and an unrounded 4.587792771657628 handed to the model — which quoted it back
        // faithfully and had the whole prose layer rejected for it — is the entire reason this
        // .toFixed exists. Every other numeric field in this context is already quantized by
        // pctOf, briefD1, briefBreadth or a toFixed at its own assignment.
        disp: d1.length > 2 ? +retStd(d1, 3).toFixed(2) : null };
    };
    ctx.regime = { stocks: regimeFor(xyz), crypto: regimeFor(main) };
    try {
      const cr = computeCorrNow();
      if (cr && cr.corr != null && ctx.regime.crypto) ctx.regime.crypto.corr = +cr.corr.toFixed(2);
    } catch (_) {}

    // -- positioning, book-level. Per-sector crypto positioning would need a hand-kept L1/L2/meme
    //    taxonomy that rots as the top-60 rotates; the aggregate is already computed and honest.
    const posFor = (list) => {
      let fSum = 0, fN = 0, neg = 0, oiSum = 0, oiN = 0;
      for (const r of list) {
        if (r.funding != null && isFinite(r.funding)) { const apr = r.funding * 24 * 365 * 100; fSum += apr; fN++; if (apr < 0) neg++; }
        const dw = r.doi != null && isFinite(r.doi) ? r.doi : null;
        if (dw != null) { oiSum += dw; oiN++; }
      }
      if (!fN && !oiN) return null;
      return { netFundApr: fN ? +(fSum / fN).toFixed(1) : null, negN: fN ? neg : null,
        oiChg: oiN ? +(oiSum / oiN).toFixed(1) : null };
    };
    ctx.positioning = { crypto: posFor(main), stocks: posFor(xyz) };

    // -- earnings: what printed (with the numbers that make a print worth reading), plus what is
    //    still ahead today and tomorrow. Routing is by earnEntryState, not by date alone: a BMO
    //    name reporting THIS MORNING is a printed row by lunchtime, and filing it under "Today"
    //    as though it were still pending was the reason same-day beats never showed a verdict.
    try {
      const byT = new Map();
      for (const r of rows.values()) if (r.ticker && !r.delisted) byT.set(String(r.ticker).toUpperCase(), r);
      const dailyFor = (tk) => { const r = byT.get(String(tk).toUpperCase()); return r && Array.isArray(r.dailyRaw) ? r.dailyRaw : null; };
      // The live mark, so a print whose reaction candle has not closed still yields a number
      // instead of a dash. This is the whole fix for "every AMC print dashes every morning".
      const pxFor = (tk) => { const r = byT.get(String(tk).toUpperCase()); return r && Number.isFinite(r.px) ? r.px : null; };
      const e = { printed: [], today: [], tomorrow: [] };
      const seen = new Set();
      // Today's already-reported rows first — they are the freshest thing on the page.
      for (const en of (earnCache && earnCache.entries) || []) {
        const d = earnDayDiff(en.d, t);
        if (d !== 0 || earnEntryState(en, t) !== "reported") continue;
        if (e.printed.length >= BRIEF_EARN_N) break;
        seen.add(en.t + "|" + en.d);
        e.printed.push(earnPrintRow(en, dailyFor(en.t), pxFor(en.t)));
      }
      for (const p of (earnCache && earnCache.recent) || []) {
        if (e.printed.length >= BRIEF_EARN_N) break;
        if (seen.has(p.t + "|" + p.d)) continue;
        e.printed.push(earnPrintRow(p, dailyFor(p.t), pxFor(p.t)));
      }
      for (const en of (earnCache && earnCache.entries) || []) {
        const d = earnDayDiff(en.d, t);
        const row = { t: String(en.t).toUpperCase(), s: en.s || "TBD", eps: en.eps != null ? en.eps : null };
        if (d === 0 && earnEntryState(en, t) === "upcoming" && e.today.length < BRIEF_EARN_N) e.today.push(row);
        else if (d === 1 && e.tomorrow.length < BRIEF_EARN_N) e.tomorrow.push(row);
      }
      ctx.earnings = e;
    } catch (_) { ctx.earnings = { printed: [], today: [], tomorrow: [] }; }

    // -- macro: the scheduled calendar (upcoming only), then whatever levels came back
    try {
      const next = [];
      for (const en of (macroCache && macroCache.entries) || []) {
        if (next.length >= 4) break;
        if (macroEntryState(en, t) !== "upcoming") continue;
        const dt = new Date(en.d + "T00:00:00Z");
        const when = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"][dt.getUTCDay()] + " " + (en.tEt || "");
        let prior = null;
        try { prior = macroStatText(en.k, macroStats && macroStats[en.k]) || null; } catch (_) {}
        next.push({ when: when.trim(), label: en.label || en.k, prior });
      }
      const lv = briefRates();
      ctx.macro = { next, rates: lv.rates, data: lv.data };
    } catch (_) { ctx.macro = { next: [], rates: [], data: [] }; }

    // -- news, clustered by sector. Verified attributions only, and filings are excluded outright:
    //    the operator reads the filings lane in the app and does not want it repeated here.
    try {
      const cut = t - 24 * 3600e3, bySec = new Map();
      for (const a of newsItems || []) {
        if (!a || a.fl || a.tg || !(a.pub >= cut)) continue;
        if (!a.tk || a.rel !== 1) continue;
        const c = classifyCached(String(a.tk).toUpperCase(), "xyz");
        const key = (c && c.ind && c.ind !== "Unclassified") ? c.ind : (a.sec || "Market");
        let g = bySec.get(key); if (!g) { g = []; bySec.set(key, g); }
        if (g.length < BRIEF_NEWS_PER) g.push({ t: String(a.tk).toUpperCase(), h: String(a.h || "").slice(0, 90), u: a.url || null });
      }
      ctx.news = [...bySec.entries()].sort((a, b) => b[1].length - a[1].length)
        .slice(0, BRIEF_NEWS_CLUSTERS).map(([sector, items]) => ({ sector, items }));
    } catch (_) { ctx.news = []; }

    return ctx;
  }

  // ---- the prose layer ---------------------------------------------------------------------------
  const BRIEF_SYSTEM = `You write the two prose sections of a daily markets brief for ONE experienced trader who runs the dashboard this data comes from. You receive a JSON context holding everything the brief will show: indices, commodities and FX listed on the venue; GICS sector and finer industry groups (median 24h move per group, member counts, share green); movers for both books with their move against that book's own benchmark (an equity index proxy for stocks, BTC for crypto); regime (breadth on 1/7/30-day horizons, share above the 200-day, mean pairwise correlation, dispersion); book-level positioning (net funding APR, how many names are negative, aggregate open-interest change); earnings printed and scheduled; the macro calendar with prior values, plus rate levels and initial claims where the server holds them; and the day's verified headlines clustered by industry.

Both books trade 24/7 on perpetual futures. The equity perps keep trading when the cash market is shut, so an overnight move is a real, tradeable fact the cash tape will not show — say so when the data supports it.

Return ONLY a JSON object, no markdown fences and no preamble:
{"story": string, "closing": string}

"story" — 2 to 4 paragraphs, separated by blank lines, under 1400 characters total. What happened in the last 24 hours and what it means. Lead with the thing that actually matters rather than walking the sections in order. Write like a person talking to a colleague: "half the board fell on a green day" beats "breadth registered 48%". Prefer the number that reframes ("ten of the fourteen names up more than a percent were semis") over the number that merely reports.

"closing" — 2 to 3 paragraphs, under 1000 characters. The synthesis: where conviction is concentrated, where the risk actually sits, what would change the picture. This is the section the reader opens the brief for. It is commentary, not a recommendation — never tell the reader what to do, and say plainly when the honest answer is that nothing is resolved.

HARD RULES, all enforced server-side; a violation discards BOTH sections and the brief ships with no prose at all:
- Every number you write must appear in the context. Do not compute new ones, do not round to a "cleaner" figure, do not recall figures from outside the context. Spelled-out small counts ("four sessions", "eight of eleven") are fine.
- Every ticker, sector, industry or basket name you write must appear in the context. Never mention an instrument the venue does not list.
- No trading instructions. No "you should", no "buy", no "take profit". Describe where risk sits and let the reader decide.
- No markup, no HTML, no markdown. Plain text only; separate paragraphs with a blank line.
- Where the data is thin or a block is absent, say so plainly rather than smoothing over it. An honest "there is nothing to read in crypto today" is a better brief than an invented narrative.`;

  async function briefProse(ctx) {
    if (!AI_KEY() && !aiFetch) return { ok: false, error: "no key" };
    if (!briefDayLeft()) return { ok: false, error: "brief-daily-cap" };
    // Same fallback discipline as the report path: a refusal or a budget blow-out on the primary
    // retries once on the fallback model before the brief gives up its prose.
    const opts = { system: BRIEF_SYSTEM, maxTokens: BRIEF_MAX_TOKENS, effort: BRIEF_EFFORT };
    let used = BRIEF_MODEL;
    let call = await callModel(BRIEF_MODEL, ctx, opts);
    if (!call.ok && BRIEF_MODEL_FALLBACK && BRIEF_MODEL_FALLBACK !== BRIEF_MODEL) {
      log("brief: primary failed (" + call.error + "), retrying on " + BRIEF_MODEL_FALLBACK);
      used = BRIEF_MODEL_FALLBACK;
      call = await callModel(BRIEF_MODEL_FALLBACK, ctx, opts);
    }
    if (!call.ok) return { ok: false, error: call.error };
    let obj = null;
    try { obj = JSON.parse(String(call.text).replace(/^```(?:json)?|```$/gm, "").trim()); } catch (_) {
      return { ok: false, error: "unparseable model output" };
    }
    const v = validateBriefProse(obj, ctx);
    const d = briefDayKey(Date.now());
    if (briefDay.d !== d) briefDay = { d, n: 0 };
    briefDay.n++;
    if (v.ok) return { ok: true, story: v.story, closing: v.closing, model: used };
    // Whole-object validation failed. First the finest honest rung: a number/name hit costs the
    // SENTENCE that carries it — salvage both sections and re-run the whole-object validator, so
    // nothing ships that the gate would not pass verbatim. Only then fall to section-level rescue.
    if (/(?:number|name) not in context/.test(v.error)) {
      const so = { story: briefSalvageProse(obj.story, ctx), closing: briefSalvageProse(obj.closing, ctx) };
      const cut = so.story.cut + so.closing.cut;
      if (cut && (so.story.text || so.closing.text)) {
        const v2 = validateBriefProse({ story: so.story.text || " ", closing: so.closing.text || " " }, ctx);
        if (v2.ok) {
          const why = [so.story.why, so.closing.why].filter(Boolean).join("; ");
          log("brief prose: salvaged — " + cut + " sentence(s) withheld (" + why + ")");
          return { ok: true, story: v2.story, closing: v2.closing, model: used, partial: cut + " sentence(s)", partialWhy: why };
        }
      }
    }
    // Whole-object validation failed. Before giving up the entire prose layer, ask which SECTION
    // failed: one bad figure in the closing used to cost the story as well, and the reader paid
    // twice for one mistake. A section that passes on its own is clean by the same gate that
    // rejected its sibling, so shipping it fabricates nothing.
    const per = validateBriefSections(obj, ctx);
    const keep = {};
    if (per.story && per.story.ok) keep.story = per.story.story;
    if (per.closing && per.closing.ok) keep.closing = per.closing.closing;
    if (keep.story || keep.closing) {
      const dropped = ["story", "closing"].filter((k) => !keep[k]);
      // Logged with the value AND the failing section, so the next occurrence is diagnosable from
      // the server log instead of a bare float on a phone.
      log("brief prose: kept " + Object.keys(keep).join("+") + ", dropped " + dropped.join("+") + " (" + v.error + ")");
      return { ok: true, story: keep.story || null, closing: keep.closing || null,
        model: used, partial: dropped.join("+"), partialWhy: v.error };
    }
    return { ok: false, error: v.error };
  }

  // One generation per hour-bucket, shared by everyone waking in it. A recipient at 07:00 and one at
  // 22:00 legitimately get different briefs; two at 07:00 get the same one and cost one call.
  async function generateBrief(now, tzMin) {
    const t = now || Date.now();
    const key = briefDayKey(t) + "|" + new Date(t).getUTCHours() + "|" + (tzMin || 0);
    if (briefCache && briefCache.key === key && t - briefCache.at < BRIEF_CACHE_MS) return briefCache;
    const ctx = buildBriefCtx(t, tzMin);
    let prose = null, degraded = null, model = null;
    if (BRIEF_ON) {
      try {
        const p = await briefProse(ctx);
        if (p.ok) {
          prose = { story: p.story, closing: p.closing }; model = p.model;
          // A partial pass ships the clean section AND says which half was withheld and why. The
          // reader must never be left guessing whether a missing FINAL THOUGHTS means the model
          // had nothing to add or the gate ate it.
          if (p.partial) { degraded = p.partial + " withheld \u2014 " + p.partialWhy; briefLastErr = degraded; }
        } else { degraded = p.error; briefLastErr = p.error; }
      } catch (e) { degraded = (e && e.message) || String(e); briefLastErr = degraded; }
    } else degraded = "disabled";
    if (degraded) ctx.proseErr = degraded;
    const r = renderBrief(ctx, prose);
    briefCache = { key, at: t, messages: r.messages, dropped: r.dropped, model, degraded, ctx };
    if (degraded) log("brief: prose degraded (" + degraded + ") — shipping mechanical brief");
    if (r.dropped.length) log("brief: budget ladder fired [" + r.dropped.join(", ") + "]");
    return briefCache;
  }

  // ---- delivery ----------------------------------------------------------------------------------
  // Default ON. `dgSet` is the tri-state that makes that migration honest: a recipient who has never
  // touched the setting has no dgSet and gets the default hour; one who explicitly turned it off
  // carries dgSet with a null hour and stays off. Without the flag there is no way to tell "never
  // configured" from "deliberately silenced", and turning someone's alerts back on by deploy is not
  // a thing this system should do.
  // Offset resolution, in one place so the panel and the scheduler can never disagree about when a
  // brief will land: an explicitly stored tz wins, quiet hours are the legacy fallback, UTC is the
  // honest last resort (and the panel says so rather than implying local time).
  function briefTzFor(rec) {
    if (!rec) return 0;
    if (Number.isFinite(rec.tz)) return rec.tz;
    if (rec.quiet && Number.isFinite(rec.quiet.tz)) return rec.quiet.tz;
    return 0;
  }
  function briefTzKnown(rec) {
    return !!(rec && (Number.isFinite(rec.tz) || (rec.quiet && Number.isFinite(rec.quiet.tz))));
  }
  // Is this recipient still on the default? An explicitly chosen hour — including one set before
  // this build — is LOCAL to them. The default is deliberately not: with no offset on file "10:00
  // local" is unknowable, so the default is a fixed wall-clock moment in UTC instead of a guess.
  // One resolution point for "when does this recipient get this send", so the panel and the
  // scheduler can never disagree about it. `sched` is authoritative; the legacy digestHour is only
  // consulted for a record that predates the migration.
  function schedEntry(rec, kind) {
    const sc = rec && rec.sched && typeof rec.sched === "object" ? rec.sched[kind] : null;
    if (sc) return sc;
    if (kind === "brief") return { h: Number.isFinite(rec && rec.digestHour) ? +rec.digestHour : null, set: rec && rec.dgSet ? 1 : 0, days: null };
    return null;
  }
  // The registry carries a static default; the env var wins where one exists, so BRIEF_DEFAULT_HOUR
  // keeps working exactly as it did before the schedule layer existed.
  const _landHourEnv = Number(process.env.LANDSCAPE_DEFAULT_HOUR);
  const SCHED_ENV_HOUR = { brief: BRIEF_DEFAULT_HOUR,
    landscape: Number.isFinite(_landHourEnv) ? Math.min(23, Math.max(0, Math.trunc(_landHourEnv))) : undefined };
  function schedDefFor(kind) {
    const d = SCHED_KINDS.find((x) => x.k === kind) || {};
    return Number.isFinite(SCHED_ENV_HOUR[kind]) ? Object.assign({}, d, { defaultHour: SCHED_ENV_HOUR[kind] }) : d;
  }
  function schedFor(rec, kind) { return schedResolve(schedEntry(rec, kind), schedDefFor(kind)); }
  function briefIsDefault(rec) { return schedFor(rec, "brief").isDefault; }
  function briefHourFor(rec) { return schedFor(rec, "brief").hour; }
  async function briefTick() {
    if (!pushOn() || !pushRecipients.size) return 0;
    const now = Date.now();
    let sent = 0;
    for (const rec of pushRecipients.values()) {
      if (rec.muted) continue;
      const res = schedFor(rec, "brief");
      if (!Number.isFinite(res.hour)) continue;
      // Default riders are scheduled in UTC; anyone who picked an hour gets it in their own time.
      const tz = res.isDefault ? 0 : briefTzFor(rec);
      const day = schedDueAt(res, now, tz);
      if (!day) continue;
      if (briefSent.get(rec.chat) === day) continue;
      briefSent.set(rec.chat, day);
      let b = null;
      try { b = await generateBrief(now, tz); } catch (e) { log("brief generate failed (isolated): " + (e && e.message)); continue; }
      // force: a scheduled brief is not one of the day's alerts and must not be the message the
      // hourly cap happens to eat. Both parts ride force for the same reason — half a brief is worse
      // than none, and the cap must not be able to swallow the conclusions while delivering the data.
      for (const m of b.messages) { pushEnqueue(rec.chat, m, true); sent++; }
    }
    return sent;
  }
  // Admin-only formatting check. Bypasses the schedule and the once-a-day guard, hits ONLY the
  // caller's own recipients, and takes the same path a real brief takes so what lands on the phone
  // is byte-identical to the 07:00 send. `fresh` forces a regeneration (and burns budget) rather
  // than re-serving the hour's cache.
  // operatorOnly: target the recipients DESIGNATED operator (rec.admin), not the owner cookie.
  // The cookie version missed the operator whenever their telegram was linked from a different
  // browser — which is the normal case for someone who administers from more than one machine. The
  // designation is explicit, visible on the roster, and toggleable there; it is the same flag that
  // already gates ops-class delivery, so "operator" means one thing: server-health alerts and test
  // fires go to this person.
  function testTargets(chat, owner, isAdmin, operatorOnly) {
    if (chat) return [String(chat)].filter((c) => pushOwns(pushRecipients.get(c), owner, isAdmin));
    if (operatorOnly) return [...pushRecipients.entries()].filter(([, r]) => r.admin === true && !r.muted).map(([c]) => c);
    return [...pushRecipients.keys()].filter((c) => pushOwns(pushRecipients.get(c), owner, isAdmin));
  }
  async function briefTestNow(chat, owner, isAdmin, fresh, operatorOnly) {
    if (!pushOn()) return { ok: false, error: "disabled" };
    const targets = testTargets(chat, owner, isAdmin, operatorOnly);
    if (!targets.length) return { ok: false, error: chat ? "forbidden" : (operatorOnly ? "no-operator-designated" : "no-recipients") };
    if (fresh) briefCache = null;
    let b;
    try { b = await generateBrief(Date.now(), 0); }
    catch (e) { return { ok: false, error: (e && e.message) || "generate failed" }; }
    for (const c of targets) for (const m of b.messages) pushEnqueue(c, m, true);
    return { ok: true, sent: targets.length, parts: b.messages.length,
      chars: b.messages.map((m) => briefVisibleLen(m)), degraded: b.degraded || null,
      dropped: b.dropped, model: b.model || null, dayLeft: briefDayLeft() };
  }

  function pushSetPrefs(chat, prefs, owner, isAdmin) {
    const r = pushRecipients.get(String(chat));
    if (!r) return { ok: false, error: "unknown" };
    if (!pushOwns(r, owner, isAdmin)) return { ok: false, error: "forbidden" };
    const p = prefs || {};
    if ("quiet" in p) {
      const v = validateQuiet(p.quiet);
      if (!v.ok) return v;
      r.quiet = v.quiet;
    }
    if ("trig" in p) {
      const t = p.trig || {};
      const nOrNull = (v) => (v == null || v === "" ? null : (Number.isFinite(+v) ? +v : undefined));
      const minEV = nOrNull(t.minEV), minRR = nOrNull(t.minRR), maxLate = nOrNull(t.maxLate);
      if (minEV === undefined || minRR === undefined || maxLate === undefined) return { ok: false, error: "bad-trig" };
      // Written as a whole object, not merged: a partial write would leave a threshold set from a
      // previous edit that the panel is no longer showing.
      // Setup family, validated against the board's own two-value vocabulary rather than accepted
      // as free text — an unrecognised value here would silently filter every setup out.
      let cls = null;
      if (t.cls != null) {
        if (!Array.isArray(t.cls)) return { ok: false, error: "bad-trig" };
        cls = t.cls.filter((c) => c === "rr" || c === "ev");
        if (cls.length !== t.cls.length) return { ok: false, error: "bad-class" };
        if (!cls.length) cls = null;   // an empty list means both, never "silence"
      }
      r.trig = {};
      if (minEV != null) r.trig.minEV = minEV;
      if (minRR != null) r.trig.minRR = minRR;
      if (maxLate != null) r.trig.maxLate = maxLate;
      if (cls && cls.length === 1) r.trig.cls = cls;   // both selected == no filter; storing it would just be noise
    }
    // Timezone rides with any prefs write. Without it a default-on brief fires at 07:00 UTC for
    // anyone who never set quiet hours, which is the middle of the night across the Americas.
    if ("tz" in p) {
      const z = p.tz;
      if (z == null || z === "") r.tz = null;
      else if (!Number.isFinite(+z) || Math.abs(+z) > 900) return { ok: false, error: "bad-tz" };
      else r.tz = +z;
    }
    if ("digestHour" in p) {
      const h = p.digestHour;
      if (h == null || h === "") r.digestHour = null;
      else if (!Number.isFinite(+h) || +h < 0 || +h > 23) return { ok: false, error: "bad-hour" };
      else r.digestHour = +h;
      // The brief is default-ON, so "off" has to be storable as a DECISION rather than as an absent
      // value — otherwise the next deploy reads null as "never configured" and switches it back on.
      r.dgSet = 1;
      if (!r.sched || typeof r.sched !== "object") r.sched = {};
      r.sched.brief = { h: r.digestHour, set: 1, days: (r.sched.brief && schedNormDays(r.sched.brief.days)) || null };
    }
    // The general surface. Per kind: an hour (null = off, a stored DECISION) and an optional
    // day-of-week set (null/absent = every day). Validated against the registry so an unknown kind
    // cannot be written and then silently never delivered.
    // The operator designation. Admin-gated: this flag routes server-health alerts and test fires,
    // and a public user must not be able to promote themselves into either. Setting it does not
    // touch classes or schedules — it is one bit with two disclosed consequences.
    if ("operator" in p) {
      if (!isAdmin) return { ok: false, error: "admin-only" };
      r.admin = p.operator === true;
    }
    if ("sched" in p) {
      const sc = p.sched;
      if (!sc || typeof sc !== "object" || Array.isArray(sc)) return { ok: false, error: "bad-sched" };
      const next = (r.sched && typeof r.sched === "object") ? Object.assign({}, r.sched) : {};
      for (const k of Object.keys(sc)) {
        if (!SCHED_KINDS.some((x) => x.k === k)) return { ok: false, error: "bad-kind" };
        const v = sc[k] || {};
        const h = v.h;
        let hour;
        if (h == null || h === "") hour = null;
        else if (!Number.isFinite(+h) || +h < 0 || +h > 23) return { ok: false, error: "bad-hour" };
        else hour = +h;
        // An hour-only write must not silently reset a chosen day set to daily: absence of the
        // `days` key means "unchanged", null means "every day", and only an explicit value edits
        // it. The wipe was unreachable from the current panel (both prompts always send days) but
        // API-reachable, and a schedule that quietly forgets its days is the worst kind of wrong.
        let days;
        if (!("days" in v)) days = (next[k] && schedNormDays(next[k].days)) || null;
        else if (v.days == null) days = null;
        else {
          days = schedNormDays(v.days);
          if (days === undefined) return { ok: false, error: "bad-days" };
        }
        next[k] = { h: hour, set: 1, days };
      }
      // Nothing is mutated until every kind in the write validated — the legacy sync used to run
      // inside the loop, so {brief: ok, junk: bad} refused the write yet left digestHour already
      // moved, to be swept out by the NEXT persist. Refusals must leave no fingerprints.
      r.sched = next;
      if (next.brief && next.brief.set) { r.digestHour = next.brief.h; r.dgSet = 1; }
    }
    persistPush();
    return { ok: true, quiet: r.quiet || null, digestHour: Number.isFinite(r.digestHour) ? r.digestHour : null,
      sched: r.sched || null, trig: r.trig || {} };
  }


  // ---- trend class: full stacks and D1 ribbon crosses -------------------------------------------
  // The Trend board's RETEST badge already reaches you as a `setup` (it is a ledgered claim with
  // frozen geometry). Nothing else about the board did. Two events are added, and only two:
  //
  //   entry  — a name arriving at a FULL 4/4 stack it did not hold before. Rare by construction.
  //   cross  — the D1 13/21 ribbon flipping sign. D1 only: H12 and H4 crosses are where the volume
  //            of crossings lives, and at ~144 names they would be a feed, not an alert.
  //
  // Both are persistent-state transitions, so both carry the same re-arm discipline as regime and
  // coverage: state in force at first sight is seeded, never announced.
  //
  // CLOSE-CONFIRMED (build -25). The board rides the live mark on purpose; the alert lane must
  // not. A ribbon that flips bullish at 14:35 and flips back by 19:00 was, under the old scan-
  // count debounce, still capable of reaching a phone — a 15-minute hold is not a daily close.
  // Every transition below is now judged on the CLOSED ladder (compute.closedLadder: last closed
  // bar of each rung, no live-mark substitution, no forming bar), so an event can only come into
  // existence when a candle closes — the close IS the confirmation, and the old scan-count
  // cross-confirm counter is gone because closed state cannot revert between closes. Each event carries
  // `confTf`/`confAt` (which close made it true, when) and, when the live board ran ahead of the
  // close, `seenAt` — the first intrabar sighting, the honest disclosure of what confirmation cost.
  // The live board read (tb) still supplies the sighting stamps and message dressing; it never
  // decides a transition.
  //
  // Boundary flap ACROSS closes is still possible (H1 closes hourly), so the episode gates stay:
  //
  //   stack — the drop must HOLD: closed score < 4 for TREND_REARM_SCANS consecutive scans before
  //           the event re-arms, and TREND_STACK_CD floors the gap between fires per name.
  const TREND_REARM_SCANS = 3;          // scans closed score must hold below 4 before the stack re-arms (~15 min)
  const TREND_STACK_CD = 12 * 3600e3;   // per-name floor between stack fires
  // The closed ladder for one board name: candles trimmed to completed periods only, fed through
  // the SAME rung sourcing buildTrend uses (daily series, UTC-aligned buckets, hourly spine). A
  // harness-seeded board read may carry `closed` directly — data, not a second code path.
  function trendClosed(coin, tb, now) {
    if (tb && tb.closed) return tb.closed;
    const r = rows.get(coin);
    if (!r || !Array.isArray(r.dailyRaw) || !Array.isArray(r.hourlyRaw)) return null;
    try {
      return closedLadder({
        D1: closedBars(r.dailyRaw, DAY, now),
        H12: closedBars(bucketsFor(r, 12), 12 * HOUR, now),
        H4: closedBars(bucketsFor(r, 4), 4 * HOUR, now),
        H1: closedBars(hoursToObj(r.hourlyRaw.slice(-96)), HOUR, now),
      });
    } catch (_) { return null; }
  }
  const trendState = new Map();   // coin -> { score, sign, retest, below, stackAt, tfSt, seenStack, seenCross, seenCrossSign, seenRetest }
  let trendPrimed = false;
  function trendScan(tNow) {
    const now = Number.isFinite(tNow) ? tNow : Date.now();
    if (!trendCache || now - trendBuilt > TREND_MS) { try { buildTrend(); } catch (_) { return 0; } }
    if (!trendByCoin.size) return 0;
    let fired = 0;
    for (const [coin, tb] of trendByCoin) {
      const r = rows.get(coin);
      if (!r || r.delisted) continue;
      const cl = trendClosed(coin, tb, now);
      if (!cl) continue;   // no closed read, no judgement — silence over guessing at a confirmation
      const sSide = tb.side === "short" ? "short" : "long";
      const want = sSide === "long" ? "up" : "down";
      const score = cl[sSide].score, sign = cl.sign, retest = cl[sSide].retest || null;
      const tfSt = {}; for (const t of TREND_TFS) tfSt[t] = cl.tf[t] ? cl.tf[t].st : "nodata";
      const prev = trendState.get(coin);
      // First pass seeds the whole board silently. A prev restored from a pre-close-confirm build
      // (no tfSt — its score/sign were LIVE values) is reseeded the same way: one silent scan,
      // never a fire judged against a truth measured with a different ruler.
      if (!trendPrimed || !prev || !prev.tfSt) {
        // A name seeded below 4 counts as fully armed: the hold exists to kill re-fires of a KNOWN
        // stack, not to make a genuinely new name's first arrival late.
        trendState.set(coin, { score, sign, retest, tfSt,
          below: score < 4 ? TREND_REARM_SCANS : 0, stackAt: (prev && prev.stackAt) || 0 });
        continue;
      }
      // Live sightings: when the live board runs ahead of the closes, stamp WHEN it first did —
      // cleared the moment the live condition lapses, so a flickering sighting reports the onset
      // of the run that actually got confirmed, not a stale first flicker.
      const liveSign = (tb.e13 > 0 && tb.e21 > 0) ? (tb.e13 > tb.e21 ? 1 : -1) : 0;
      const next = { score, sign: prev.sign, retest, tfSt,
        below: score < 4 ? Math.min((prev.below || 0) + 1, 999) : 0,
        stackAt: prev.stackAt || 0 };
      next.seenStack = (tb.score >= 4 && score < 4) ? (prev.seenStack || now) : 0;
      next.seenCross = (liveSign !== 0 && prev.sign !== 0 && liveSign !== prev.sign)
        ? ((prev.seenCrossSign || 0) === liveSign ? (prev.seenCross || now) : now) : 0;
      next.seenCrossSign = next.seenCross ? liveSign : 0;
      next.seenRetest = (tb.retest && !retest) ? (prev.seenRetest || now) : 0;
      const seen = (at, confAt) => (at && isFinite(+confAt) && at < +confAt ? at : undefined);
      // 1. Full stack reached — on CLOSED rungs. Only the ARRIVAL fires; sitting at 4/4 for a week
      //    says nothing new — and a one-scan wobble through 3/4 is sitting, not arriving (the
      //    hold), and a re-arrival inside the cooldown is a boundary being hugged, not news. A
      //    rise that either gate suppresses is consumed: `below` resets at 4/4, so the drop-and-
      //    hold must happen again. The confirming close is the rung whose CLOSED state newly
      //    aligned — the candle that completed the stack.
      if (score >= 4 && prev.score < 4 && (prev.below || 0) >= TREND_REARM_SCANS
          && now - (prev.stackAt || 0) >= TREND_STACK_CD) {
        next.stackAt = now;
        next.sign = sign; next.seenStack = 0;   // the cross is the stack — adopt, don't re-announce
        let confTf = null, confAt = 0;
        for (const t of TREND_TFS) {
          if (tfSt[t] === want && prev.tfSt[t] !== want) {
            const at = cl.closeAt && isFinite(+cl.closeAt[t]) ? +cl.closeAt[t] : 0;
            if (at >= confAt) { confAt = at; confTf = t; }
          }
        }
        if (!confTf) { confTf = "H1"; confAt = (cl.closeAt && isFinite(+cl.closeAt.H1)) ? +cl.closeAt.H1 : now; }
        trendState.set(coin, next);
        emitTrig("trend", { coin, t: r.ticker || coin, side: sSide, sub: "stack", score,
          tf: "D1", px: r.px, e21: tb.e21, confTf, confAt, seenAt: seen(prev.seenStack, confAt),
          title: "full 4/4 stack",
          text: `every rung aligned ${sSide === "long" ? "up" : "down"}${tb.age != null ? ` \u00b7 trend age ${tb.age}d` : ""}` }, now);
        fired++;
        continue;   // one event per name per scan: a cross that arrives with the stack is the stack
      }
      // 2. RETEST arrival — the pullback into the 13/21 zone with the CLOSE holding EMA21, judged
      //    on closed bars of whichever rung shows it. This is the SAME condition the ledger
      //    enrolls as a claim; the difference is the alert fires on the closed badge APPEARING,
      //    while the ledger's setup alert waits for the event family to prove a record (n >= 8
      //    resolved). Until that record exists this is the only way a retest reaches you at all —
      //    which, with a young tretest ledger, is precisely why trend retests looked nonexistent.
      //    Confirming close: the retesting rung's own last close (\u22644h/\u226412h/\u226424h behind the tape).
      if (retest && !prev.retest) {
        next.seenRetest = 0;
        const confAt = (cl.closeAt && isFinite(+cl.closeAt[retest])) ? +cl.closeAt[retest] : now;
        trendState.set(coin, next);
        emitTrig("trend", { coin, t: r.ticker || coin, side: sSide, sub: "retest", score,
          tf: retest, px: r.px, e21: tb.e21, confTf: retest, confAt, seenAt: seen(prev.seenRetest, confAt),
          title: retest + " retest of the 13/21 zone",
          text: `pullback into the ribbon of a ${score}/4 stacked ${sSide === "long" ? "uptrend" : "downtrend"}, close holding EMA21` }, now);
        fired++;
        continue;   // a live-pending cross survives the retest scan and confirms at its own close
      }
      // 3. D1 ribbon cross — the CLOSED daily sign changed, which can only happen at a D1 close:
      //    the close IS the confirmation, so it announces immediately and cannot revert before the
      //    next close. Sign 0 (a rung without both EMAs) is unknown, not a flip — treating it as
      //    one would fire on every gap in the ladder. A flip out of 0 is adoption, not a flip: it
      //    confirms silently, exactly as the pre-debounce comparison behaved.
      if (sign !== 0 && prev.sign !== 0 && sign !== prev.sign) {
        next.sign = sign; next.seenCross = 0; next.seenCrossSign = 0;
        const confAt = (cl.closeAt && isFinite(+cl.closeAt.D1)) ? +cl.closeAt.D1 : now;
        emitTrig("trend", { coin, t: r.ticker || coin, side: sign > 0 ? "long" : "short", sub: "cross",
          score, tf: "D1", px: r.px, e21: tb.e21, confTf: "D1", confAt,
          seenAt: (prev.seenCrossSign || 0) === sign ? seen(prev.seenCross, confAt) : undefined,
          title: "D1 13/21 cross " + (sign > 0 ? "up" : "down"),
          text: "the daily ribbon flipped " + (sign > 0 ? "bullish" : "bearish") }, now);
        fired++;
      } else if (sign !== 0) next.sign = sign;
      trendState.set(coin, next);
    }
    // Names that left the board entirely lose their state, so a return is a genuinely new episode.
    for (const c of [...trendState.keys()]) if (!trendByCoin.has(c)) trendState.delete(c);
    // Persist even without a fire: the transitions BETWEEN fires (seeding, re-arms, state drift)
    // are exactly what the next process needs to judge the next transition correctly.
    persistTriggers();
    if (fired) log(`trend alerts: ${fired} event(s)`);
    return fired;
  }

  // ---- ma200 class: reclaim / breakdown / bullish + bearish retest, H4 + D1 (build -32) --------
  // The notification lane for the 200-EMA — the -26 study measures these events, the -28 shadows
  // earn a record on two of them, and this scan is how ANY of the four reach a phone TODAY (the
  // same role the trend retest-badge arrival plays for the 13/21 family). Full roster, BOTH
  // universes, deliberately not scoped to the trend board's top-10s: a 200 breakdown matters most
  // on a name that is NOT currently trending. Every judgement is compute.emaAlertState over
  // CLOSED bars — the study's own buffered-cross / clear-air-retest vocabulary, so the alert and
  // the study can never disagree about what an EMA200 event is — and can therefore only come
  // into existence at that rung's close: the close IS the confirmation (-25). D1 rides
  // mergedDailyBars (370d — names younger than ~7 months are honest-nodata and silent); H4 rides
  // the spine buckets. Dedup is the firing bar's OWN timestamp, persisted: the same closed bar
  // can never announce twice, across as many scans and redeploys as it spans. The live-mark
  // sighting (the -25 seenAt disclosure) runs the SAME detector over closed bars plus the
  // forming bar carrying the mark — one definition, two clocks.
  const MA200_TFS = { D1: DAY, H4: 4 * HOUR };
  const maState = new Map();   // coin -> { D1: { fired: {sub|side: barT}, seen: {sub|side: ts} }, H4: {...} }
  let maPrimed = false;
  function maSeries(r, tf, now) {
    const src = tf === "D1" ? mergedDailyBars(r) : bucketsFor(r, 4);
    return closedBars(src, MA200_TFS[tf], now);
  }
  // The forming bar for the live sighting: the untrimmed tail bucket when it exists (true
  // intrabar h/l from the hours so far), the mark alone when it doesn't — with the close always
  // replaced by the live mark, exactly the substitution trendLadder makes.
  function maLiveBars(r, tf, closed, now) {
    const w = MA200_TFS[tf], t0 = Math.floor(now / w) * w, px = +r.px;
    if (!(px > 0)) return null;
    const src = tf === "D1" ? mergedDailyBars(r) : bucketsFor(r, 4);
    const tail = src.length ? src[src.length - 1] : null;
    const f = tail && +tail.t === t0
      ? { t: t0, c: px, h: Math.max(+tail.h, px), l: Math.min(+tail.l, px) }
      : { t: t0, c: px, h: px, l: px };
    return closed.concat([f]);
  }
  function ma200Scan(tNow) {
    const now = Number.isFinite(tNow) ? tNow : Date.now();
    let fired = 0;
    for (const r of rows.values()) {
      if (r.delisted || !(r.px > 0) || !Array.isArray(r.hourlyRaw)) continue;
      let st = maState.get(r.coin);
      for (const tf of ["D1", "H4"]) {
        const bars = maSeries(r, tf, now);
        if (!Array.isArray(bars) || bars.length < 216) continue;   // EMA200 cannot seed — honest silence, fills in as history deepens
        // Sigma in the rung's OWN bar units — the study's exact construction, so the buffer means
        // the same thing an /api/analytics reader sees adjudicated.
        const sdTf = retStd(dailyRets(bars.map((k) => [k.t, k.c])).slice(-90), 15);
        if (!(sdTf > 0)) continue;
        let ev = null;
        try { ev = emaAlertState(bars, sdTf); } catch (_) { continue; }
        if (!st) { st = {}; maState.set(r.coin, st); }
        const S = st[tf] || (st[tf] = { fired: {}, seen: {}, s: 0 });
        const key = ev ? ev.sub + "|" + ev.side : null;
        // Seeding: state in force at first sight — an event bar already standing when the scan
        // first looks (boot, new name, history just deepened past the seed) — is recorded, never
        // announced. Same discipline as every episode class. `s` marks a rung-state that has had
        // its silent first look, so a name ARRIVING after priming still seeds instead of firing.
        if (!maPrimed || !S.s) { S.s = 1; if (key) S.fired[key] = ev.barT; continue; }
        // The fire is handled BEFORE the live-sighting upkeep: once the event bar has closed, the
        // mark-extended series no longer matches the shape, so upkeep run first would wipe the
        // very stamp the fire is about to disclose.
        if (ev && S.fired[key] !== ev.barT) {
          S.fired[key] = ev.barT;
          const confAt = ev.barT + MA200_TFS[tf];
          const seenAt = S.seen[key] != null && S.seen[key] < confAt ? S.seen[key] : undefined;
          delete S.seen[key];
          const rts = ev.sub === "retest";
        emitTrig("ma200", { coin: r.coin, t: r.ticker || r.coin, side: ev.side, sub: ev.sub, tf,
          px: r.px, ema: ev.ema, dist: ev.dist, held: ev.held, probe: rts ? ev.probe : undefined,
          confTf: tf, confAt, seenAt,
          title: tf + " " + (rts ? (ev.side === "long" ? "bullish" : "bearish") + " retest of EMA200"
            : "EMA200 " + ev.sub),
          text: rts
            ? (ev.side === "long"
              ? `pullback probed the 200 from above, close held it \u2014 continuation zone`
              : `rally probed the 200 from below, close rejected it`)
            : (ev.sub === "reclaim"
              ? `closed back above the 200 after ${ev.held} ${tf} bar${ev.held === 1 ? "" : "s"} below it`
              : `closed below the 200 for the first time in ${ev.held} ${tf} bar${ev.held === 1 ? "" : "s"}`) }, now);
          fired++;
        }
        // Live sighting on the mark-extended series: stamped at the first scan the live shape
        // appears, cleared the moment it lapses — the onset of the run that got confirmed.
        let lv = null;
        try { const lb = maLiveBars(r, tf, bars, now); lv = lb ? emaAlertState(lb, sdTf) : null; } catch (_) { lv = null; }
        const lkey = lv ? lv.sub + "|" + lv.side : null;
        for (const k of Object.keys(S.seen)) if (k !== lkey) delete S.seen[k];
        if (lkey && S.seen[lkey] == null) S.seen[lkey] = now;
      }
    }
    for (const c of [...maState.keys()]) if (!rows.has(c) || rows.get(c).delisted) maState.delete(c);
    persistTriggers();
    if (fired) log(`ma200 alerts: ${fired} event(s)`);
    return fired;
  }

  function pushTest(chat, owner, isAdmin) {
    if (!pushOn()) return { ok: false, error: "disabled" };
    const now = Date.now();
    if (now - pushLastTest < 30 * 1000) return { ok: false, error: "cooldown" };
    // Scoped: a test fire must never let one visitor ping another visitor's phone. With no chat
    // named it hits only the caller's OWN recipients (admin: all of them).
    const targets = (chat ? [String(chat)] : [...pushRecipients.keys()])
      .filter((c) => pushOwns(pushRecipients.get(c), owner, isAdmin));
    if (!targets.length) return { ok: false, error: chat ? "forbidden" : "no-recipients" };
    pushLastTest = now;
    for (const c of targets) {
      pushEnqueue(c, `<b>Test alert</b>\nbuild ${version || "dev"} \u00b7 the wire works.`, true);
    }
    return { ok: true, sent: targets.length };
  }

  function getPush(owner, isAdmin) {
    const now = Date.now();
    // A pending code is shown only to the browser that asked for it. Previously the newest code was
    // handed to every visitor, so two people linking at once could redeem each other's.
    const codes = [...pushCodes.entries()]
      .filter(([, v]) => now - v.t <= PUSH_LINK_TTL && (isAdmin || (v.owner || "") === (owner || "")))
      .map(([code, v]) => ({ code, expiresAt: v.t + PUSH_LINK_TTL }));
    const visible = [...pushRecipients.values()].filter((r) => pushOwns(r, owner, isAdmin));
    return {
      ts: now, dataTs: pushVer,
      enabled: pushOn(),
      classes: PUSH_CLASSES, defaultClasses: PUSH_DEFAULT_CLASSES, adminClasses: PUSH_ADMIN_CLASSES, rates: getClassRates(),
      lookbackMs: PUSH_GRACE_MS, bootAt: pushBootAt,   // the boot rule is a lookback window, not a countdown — nothing is "waiting" to unmute
      admin: !!isAdmin,
      // Counted, never listed: a visitor should know the bot serves other people without being shown
      // who they are.
      othersLinked: pushRecipients.size - visible.length,
      recipients: visible.map((r) => ({
        mine: pushOwns(r, owner, false),
        chat: r.chat, mask: pushMask(r.chat), name: r.name, since: r.since,
        classes: r.classes, muted: !!r.muted, admin: !!r.admin, owned: !!r.owner, lastOk: r.lastOk || null, lastErr: r.lastErr || null,
        quiet: r.quiet || null, digestHour: Number.isFinite(r.digestHour) ? r.digestHour : null, trig: r.trig || {},
        // The hour the brief will ACTUALLY fire at, defaults folded in — a panel showing "off"
        // for a recipient who is about to receive one is a lie the operator would act on.
        briefHour: briefHourFor(r), briefSet: r.dgSet ? 1 : 0,
        // One entry per registered send, already resolved: hour, days and whether this recipient
        // is still riding the default. The panel renders these directly rather than re-deriving —
        // a second copy of the resolution rule is a second thing that can disagree with delivery.
        sched: SCHED_KINDS.reduce((acc, kind) => {
          const res = schedFor(r, kind.k);
          acc[kind.k] = { hour: res.hour, days: res.days, dflt: res.isDefault ? 1 : 0,
            daysLabel: schedDaysLabel(res.days), utc: res.isDefault ? 1 : 0 };
          return acc;
        }, {}),
        briefTz: briefIsDefault(r) ? 0 : briefTzFor(r), briefTzKnown: briefTzKnown(r) ? 1 : 0,
        briefUtc: briefIsDefault(r) ? 1 : 0,   // on the default = a fixed UTC moment, and the panel must say UTC rather than imply local
        quietNow: !!(r.quiet && inQuietWindow(now, r.quiet)),
        sentHour: (r.sent || []).filter((t) => now - t < 3600e3).length })),
      code: codes.length ? codes[codes.length - 1] : null,
      // Brief state for the admin block. Operator-facing only — it names the model and the
      // remaining budget, so it rides behind the same isAdmin gate the rest of that panel uses.
      brief: isAdmin ? { enabled: BRIEF_ON, defaultHour: BRIEF_DEFAULT_HOUR, perDay: BRIEF_PER_DAY,
        dayLeft: briefDayLeft(), model: BRIEF_MODEL, lastErr: briefLastErr } : null,
      landscape: isAdmin ? { enabled: LAND_ON, defaultHour: schedDefFor("landscape").defaultHour,
        defaultDays: schedDaysLabel(schedResolve(null, schedDefFor("landscape")).days),
        perDay: LAND_PER_DAY, dayLeft: landDayLeft(), model: LAND_MODEL, lastErr: landLastErr,
        windowH: LAND_WINDOW_H } : null,
      schedKinds: SCHED_KINDS.map((k) => ({ k: k.k, label: k.label, defaultHour: schedDefFor(k.k).defaultHour, tip: k.tip || null })),
      queue: pushQueue.length, dropped: pushDropped, capHour: PUSH_CAP_HOUR,
      holdMs: Math.max(0, pushHoldUntil - now), lastErr: pushLastErr,
      log: pushLog.slice(0, 12),
    };
  }

  function getActionable(isAdmin) {
    const now = Date.now();
    if (!actCache || now - actBuilt > ACT_MS) {
      // The build is async (it yields) and MUST run on the serialized chain — a bare call here
      // could interleave with a signals build mid-ledger-mutation. Fire it and serve what exists
      // now; the cold-cache case serves the fallback exactly once, and the next poll reads warm.
      chainBuild("buildActionable", buildActionable).catch((err) => log("buildActionable error: " + (err && err.message)));
    }
    const full = actCache || { ts: Date.now(), dataTs: 0, params: {}, coverage: {}, rows: [], count: 0 };
    // Audience slice (2026.08.03-02): same contract as getSignals — identity for admin / all-public.
    if (!actCache) return full;   // the cold fallback is a fresh empty literal; nothing to slice
    const vis = featureScopeVis(featureFlags, "actionable", !!isAdmin);
    return vis.all ? full : scopedBody("act", full, vis);
  }

  // ===== FOCUS: the frozen-at-open tradeable watchlist (build 2026.08.15-01) ==================
  // Six seats, stamped once when the US cash session opens, one late fill at +1h from the 5m
  // archive, then immutable for the day. Selection math lives in compute (focusSelect / focusScore
  // — the loudness formula is disclosed there); this is thin assembly: every field is a
  // restatement of something the poller already computed (the rvol memo, the OI history, the
  // earnings map, the news tape, the off-hours hold record). One code path, no re-derivation.
  // Scope: xyz EQUITIES on the ET clock only. Foreign-home names (KRX/TSE/HKEX) are excluded by
  // doctrine, not oversight — their reference book discovers price in the ASIAN session, so a
  // 09:30 ET "open snapshot" would anchor their gap to the wrong exchange (2026.08.14-01 rule).
  // LIQUIDITY FLOORS (build 2026.08.18-03). The $200k volume floor this feature shipped with is
  // now the BACKSTOP under an operator-set wall (compute.focusLimits clamps to it), because "under
  // X is untradeable at my size" is a fact about the operator's clip, not about the tape. Two
  // properties the rest of this block depends on:
  //   1. The gate runs inside candidate assembly, so preview and stamp meet the same wall.
  //   2. The floors in force are WRITTEN ONTO the stamp. Raising them tomorrow does not rewrite
  //      yesterday's record — a track record whose selection wall is unknowable is unreadable.
  const FOCUS_MIN_CANDS = 8;           // below this the universe is still booting — defer, retry next tick
  const FOCUS_PREVIEW_LEAD = 30 * 60 * 1000;   // preview window opens 09:00 ET — earlier and the σ/RVOL reads are mostly noise
  let focusLim = focusLimits(null);    // { vol, oi } — hydrated from focus.json, written by the admin panel
  let focusState = null, focusPrev = null, focusVer = 0;
  // The focus ETag stamp is a VERSION, not a clock (2026.08.18-03). It was Date.now() at every
  // setter, which meant two changes inside the same millisecond produced the same stamp — and the
  // second one would 304 against the first, serving a body the client had already been told it
  // had. Rare on the 30s tick, ordinary the moment a human write (a floor change) lands next to a
  // poll. Monotonic: wall-clock when time has moved, +1 when it has not.
  const focusBump = () => { focusVer = Math.max(Date.now(), focusVer + 1); return focusVer; };
  let focusPv = null;                  // { at, day, rows, sig } — the live preview pool. IN-MEMORY ONLY, never persisted: only the stamp is a record.
  let focusForming = null;             // { at, map } — forming +1h reads between the stamp and the freeze. Same rule: transient, never persisted.
  function hydrateFocus(nowArg) {
    const raw = store.loadFocus ? store.loadFocus() : null;
    if (!raw) return false;
    // Boot repair runs BEFORE the roll: a phantom must never reach the utcDay comparison, or it
    // would be retired into `prev` on top of the genuine record it was written over.
    const data = focusSanitize(raw);
    // Hydrate rolls on the SAME boundary the live tick does. A blob written before 2026.08.18-02
    // carries no utcDay; focusUtcDayOf derives one from frozenAt, so a restart across the boundary
    // retires it correctly instead of resurrecting a list the running process would have dropped.
    const utcToday = focusUtcDayStr(nowArg || Date.now());   // nowArg: suite-only, as with getFocus
    focusLim = focusLimits(data.limits);                       // absent (or corrupt) -> the hard backstop, never an open wall
    if (data.state && focusUtcDayOf(data.state) === utcToday) { focusState = data.state; focusPrev = data.prev || null; }
    else if (data.state) focusPrev = data.state;               // a saved prior day rolls to "yesterday"
    else focusPrev = data.prev || null;
    focusBump();
    return !!(focusState || focusPrev);
  }
  // The floors ride the SAME blob as the stamp (no new file, no second write path): one atomic
  // tmp+rename carries the record and the wall that produced it.
  function focusPersist() { if (store.saveFocus) store.saveFocus({ state: focusState, prev: focusPrev, limits: focusLim }); focusBump(); }
  // Admin write. Deliberately does NOT touch focusState: today's list was frozen against the
  // floors that were standing at 09:30 and stays that way. What it DOES do is drop the live
  // preview pool, so the 09:00 prep list re-gates on the next 30s tick instead of showing names
  // the new wall would refuse.
  function setFocusLimits(vol, oi, isAdmin) {
    if (!isAdmin) return { ok: false, error: "forbidden" };
    const next = focusLimits({ vol, oi });
    focusLim = next;
    focusPv = null;
    try { focusPersist(); } catch (_) { return { ok: false, error: "write-failed", limits: next }; }
    log(`FOCUS floors set: $${next.vol.toLocaleString("en-US")} 24h volume / $${next.oi.toLocaleString("en-US")} OI — live from the next preview tick; today's stamp unchanged`);
    return { ok: true, limits: next, hard: { vol: FOCUS_HARD_VOL, oi: FOCUS_HARD_OI } };
  }
  // STRUCTURAL eligibility — one producer (2026.08.18-03). Who is even in scope for this tab,
  // before any judgement about size or loudness: a live xyz equity on the ET clock. Extracted so
  // the expensive candidate assembly and the cheap panel scan cannot drift apart about which
  // names the universe contains — a floor panel counting a different 84 than the engine gates
  // would make every survivor count it prints a lie.
  function focusEligible(r) {
    if (!r || r.uni !== "xyz" || r.delisted || !r.ticker || !(r.px > 0)) return null;
    const cl = classifyCached(r.ticker, r.uni);
    if (!cl || cl.assetClass !== "Equity") return null;
    if (homeMkt(r.ticker, r.uni)) return null;                 // home session is not this session
    return cl;
  }
  // The floor panel's raw material: every structurally eligible name with the two numbers the
  // walls judge. Cheap by construction (no news walk, no level math) so the admin panel can ask
  // for it on demand, and sourced from the SAME predicate the engine gates, so the histogram and
  // the seat count can never disagree about the field.
  function focusScan() {
    const out = [];
    for (const r of rows.values()) {
      const cl = focusEligible(r);
      if (!cl) continue;
      out.push([r.ticker, Math.round(r.vol || 0), r.oi != null && isFinite(r.oi) ? Math.round(r.oi) : null, cl.ind || cl.sector || null]);
    }
    return out.sort((a, b) => b[1] - a[1]);
  }
  function focusCandidates(now, prevCloseT) {
    const out = [], yest = etDayStr(prevCloseT), today = etDayStr(now);
    for (const r of rows.values()) {
      const cl = focusEligible(r);
      if (!cl) continue;
      // NOTE: no size filter here anymore. The floors are applied by focusGate at the call sites
      // below, so both callers see the same refused set and can disclose it.
      const hs = getHourly(r.coin);
      const pc = priceAsOf(hs, prevCloseT, 3 * HOUR);
      const gapPct = pc > 0 ? +((r.px / pc - 1) * 100).toFixed(3) : null;
      // gap σ from the name's OWN off-hours hold record — the same holds the Markets gap hover
      // summarizes, so the two tabs can never claim different distributions.
      const gaps = Array.isArray(r._ovClose) ? r._ovClose.map((x) => (x[1] - 1) * 100) : [];
      const gsd = focusGapSigma(gaps);
      const gapSigma = gapPct != null && gsd != null && gsd > 0 ? +(gapPct / gsd).toFixed(2) : null;
      const rvol = r._rv && Number.isFinite(r._rv.h1) ? +r._rv.h1.toFixed(2) : null;   // clock-matched, the board's own memo
      let oiDelta = null;
      try {
        const od = oiDeltaPct(hist.get(r.coin), r.oiBase, Math.max(now - prevCloseT, HOUR));
        if (Number.isFinite(od)) oiDelta = +od.toFixed(1);
      } catch (_) {}
      let ern = 0;
      const ea = earnMap.get(r.ticker);
      if (Array.isArray(ea)) for (const e of ea) {
        if (e.d === today && e.s === "bmo") { ern = "bmo"; break; }
        if (e.d === yest && e.s === "amc") { ern = "amc"; break; }
      }
      // One pass over the matched tape: 24h count, the TG-lane 4h count (the user's own curated
      // channels naming this ticker — extra loudness weight, disclosed in focusScore), and the
      // top 3 headlines VERBATIM for the chip hover. Restated feed data only — a headline that
      // was never fetched can never appear here (fabrication-prevention by construction).
      let news24 = 0, tg4h = 0;
      const matched = [];
      for (const a of newsItems) {
        if (!a || a.rel !== 1 || !(a.pub >= now - DAY) || String(a.tk || "").toUpperCase() !== r.ticker) continue;
        news24++;
        if (a.tg && a.pub >= now - 4 * HOUR) tg4h++;
        matched.push(a);
      }
      matched.sort((x, y) => y.pub - x.pub);
      const newsTop = matched.slice(0, 3).map((a) => [a.tg ? 1 : 0, String(a.h || "").slice(0, 110), a.pub]);
      const lvl = focusLevelDist(hs, r.px, now);
      out.push({ ticker: r.ticker, coin: r.coin, px: +(+r.px).toPrecision(8), prevClose: pc > 0 ? +pc.toPrecision(8) : null,
        gapPct, gapSigma, gapSd: gsd != null ? +gsd.toFixed(3) : null, rvol, oiDelta, ern, news24, tg4h, newsTop,
        lvlDistSd: lvl ? lvl.distSd : null, lvlSide: lvl ? lvl.side : null,
        cluster: cl.ind || cl.sector || null, vol: r.vol || 0,
        // OI NOTIONAL (2026.08.18-03), the board's own r.oi (oiBase × mark) — the number the OI
        // floor judges and the roster displays, restated once. null stays null: a sparse OI
        // series is an honest absence and clears the OI wall by construction (focusFloorFail).
        oi: r.oi != null && isFinite(r.oi) ? Math.round(r.oi) : null });
    }
    return out;
  }
  function focusPrevClose(sess) {
    // The gap anchor is the PREVIOUS session's true close, read off the calendar engine — never a
    // fixed offset (half days close 13:00 ET; marketSessions carries that, same fix as studyGapFade).
    let prevCloseT = null;
    for (const s of marketSessions(sess.open - 9 * DAY, sess.open)) if (s.close < sess.open) prevCloseT = s.close;
    return prevCloseT;
  }
  // PREVIEW (build 2026.08.15-02): the 09:00–09:30 prep pool. Same candidate assembly as the
  // stamp — the gap here is simply the LIVE in-progress read against the same prev-close anchor —
  // ranked by the same loudness, top 10, cluster cap deliberately NOT applied (a prep pool shows
  // the whole field; the chip discloses which names the cap will block). Rebuilt every tick while
  // the window is open; the ETag only bumps when the pool actually changed, so a still pre-market
  // does not churn 304s. Never persisted, never scored, retired the moment the stamp exists.
  function buildFocusPreview(sess, now) {
    const prevCloseT = focusPrevClose(sess);
    if (prevCloseT == null) return;
    const cands = focusCandidates(now, prevCloseT);
    // Boot check reads the PRE-floor count (see stampFocus for why this split exists).
    if (cands.length < FOCUS_MIN_CANDS) return;                // booting universe: no phantom preview either
    const g = focusGate(cands, focusLim, FOCUS_BELOW_N);
    const rows = focusPreview(g.pass, FOCUS_PREVIEW_N);
    const sig = rows.map((x) => x.ticker + "|" + (x.gapPct == null ? "" : x.gapPct.toFixed(1)) + "|" + (x.rvol == null ? "" : x.rvol.toFixed(1))).join(",")
      + "|F" + g.limits.vol + "/" + g.limits.oi + "|b" + g.belowN;   // a floor change is a pool change: it must bust the ETag even if the top ten survive it
    if (focusPv && focusPv.sig === sig && focusPv.day === etDayStr(now)) { focusPv.at = now; return; }   // unchanged pool: refresh the clock, keep the ETag
    focusPv = { at: now, day: etDayStr(now), rows, sig, below: g.below, belowN: g.belowN, scanned: g.scanned, cleared: g.pass.length, limits: g.limits };
    focusBump();
  }
  function stampFocus(sess, now) {
    // The old ET-day roll lived here. focusRetire owns retirement now — one producer — and it has
    // always already fired by the time a stamp is possible: the UTC boundary (20:00 ET) precedes
    // the next ET day, which precedes the next 09:30 open.
    const prevCloseT = focusPrevClose(sess);
    if (prevCloseT == null) return;
    const cands = focusCandidates(now, prevCloseT);
    // THE SPLIT (2026.08.18-03), load-bearing: the boot check reads the count BEFORE the floors,
    // the seating reads the count AFTER. One number served both roles until the floors became
    // operator-set, at which point a strict wall was indistinguishable from a cold universe — the
    // tick would defer, the stamp would never land, and the tab would show "pending" all day with
    // no statement of why. Now a booting universe defers (something IS coming) and a strict wall
    // stamps whatever cleared, however few, with the count and the refused roster attached.
    if (cands.length < FOCUS_MIN_CANDS) return;                // spines still booting — the 30s tick retries
    const g = focusGate(cands, focusLim, FOCUS_BELOW_N);
    const sel = focusSelect(g.pass);
    // Stamp-vs-preview disclosure: the diff is against the LAST preview's likely six (its top-6
    // zone, the dashed rule the user prepped against) — persisted on the record, so "my prep
    // silently drifted from the stamp" can never happen. No preview today -> no diff claimed.
    const pvRef = focusPv && focusPv.day === etDayStr(now) ? focusPv : null;
    const pvDiff = pvRef ? { pvAt: pvRef.at, ...focusDiff(pvRef.rows.slice(0, FOCUS_CAP).map((x) => x.ticker), sel.picks.map((x) => x.ticker)) } : null;
    focusState = { day: etDayStr(now), utcDay: focusUtcDayStr(now), open: sess.open, close: sess.close, prevCloseT,
      frozenAt: now, late: now - sess.open > 90 * 1000 ? 1 : 0,   // boot-stamped after the open: DISCLOSED, same honesty as episode boot stamps
      rows: sel.picks, cuts: sel.cuts, filledAt: 0, fillNote: null, closedAt: 0, closeNote: null, closeLate: 0, pvDiff,
      // The wall that produced this list, frozen with it. Never read from focusLim at render time:
      // that would let today's panel edit silently restate what yesterday's selection was made of.
      limits: g.limits, scanned: g.scanned, cleared: g.pass.length, below: g.below, belowN: g.belowN };
    focusPv = null;                                            // the preview retires the moment the record exists
    focusPersist();
    log(`FOCUS stamped ${focusState.rows.length} seat(s) for ${focusState.day}${focusState.late ? ` (LATE \u2014 ${Math.round((now - sess.open) / 60000)}m after the open)` : ""}, ${focusState.cuts.length} cut(s) disclosed`
      + ` \u2014 ${g.pass.length}/${g.scanned} cleared the floors ($${g.limits.vol.toLocaleString("en-US")} vol / $${g.limits.oi.toLocaleString("en-US")} OI)`
      + (sel.picks.length < FOCUS_CAP ? `; SHORT of ${FOCUS_CAP} seats` : ""));
  }
  // Forming +1h reads (build 2026.08.17-03): between the stamp and the 10:30 freeze, the sVWAP /
  // 1H HI / 1H LO columns show the hour FORMING — closed 5m bars so far (minBars=1: a partial
  // hour is exactly what forming means) with the board's live mark folded into hi/lo/last via the
  // pure fold in compute. Republished at most once a minute; the ETag bump rides focusVer so the
  // client's 60s poll picks each edition up. At the freeze the frozen record replaces all of it
  // and the map dies — the record and only the record persists.
  // Republish cadence dropped 55s -> 25s at 2026.08.18-04, to sit inside the client's 30s poll.
  // Safe only because focusBump is monotonic: at this cadence a republish and a human write can
  // land in the same millisecond, and a wall-clock stamp would have 304'd the second one away.
  const FOCUS_FORMING_MS = 25 * 1000;
  function buildFocusForming(now) {
    const st = focusState;
    if (!st || st.filledAt) return;
    if (focusForming && now - focusForming.at < FOCUS_FORMING_MS) return;
    const canRead = store.candlesEnabled && store.candlesEnabled();
    const endW = Math.min(now, st.open + HOUR);
    const map = {}, cov = {};
    for (const p of st.rows) {
      // 1m base (2026.08.18-04). The opening hour is the one window this tab actually measures,
      // and measuring it in five-minute steps was too coarse to read.
      const bars = canRead && store.readCandles1m ? store.readCandles1m(p.coin, st.open - 1, endW + 1) : [];
      const f = firstHourStats(bars, st.open, endW, 1);
      const r = rows.get(p.coin);
      // COVERAGE IS PART OF THE READ, not a diagnostic beside it. `bars: 0` used to be indistinct
      // from a real one-bar hour once foldLiveMark turned the mark into hi = lo = last, which
      // rendered as a flat line at the current price and looked exactly like a measurement.
      cov[p.ticker] = { bars: bars.length, mins: Math.max(0, Math.round((endW - st.open) / 60000)) };
      // The mark may only WIDEN an existing read. With no bars there is nothing to widen, and
      // synthesising a record from the mark alone is the fabrication this build removes.
      if (!f) continue;
      map[p.ticker] = foldLiveMark(f, r && r.px > 0 ? +r.px : null);
    }
    focusForming = { at: now, map, cov, src: "1m", next: now + FOCUS_FORMING_MS };
    focusBump();
  }
  // THE FREEZE GRACE (2026.08.18-07). This fired the instant the clock reached open+1h, which races
  // the 1m archive writer: the 10:29 bar lands a beat after 10:30, so the frozen record captured 59
  // of 60 minutes and recorded `bars: 59` while claiming to be the first hour. Every frozen record
  // since the 1m switch is short its final minute — small in price, wrong in kind, and permanent,
  // because the geometry is immutable once written. So a PARTIAL hour holds the freeze and the 30s
  // tick retries until the lane completes or the grace expires. A seat with NO bars at all does not
  // hold it: that is an absent lane, not a late one, and waiting cannot fix it. On expiry the record
  // freezes regardless and states how short it came — a bounded wait, never an open-ended one.
  const FOCUS_FILL_GRACE = 5 * 60 * 1000;
  function fillFocus(now) {
    const st = focusState;
    if (!st || st.filledAt) return;
    const canRead = store.candlesEnabled && store.candlesEnabled();
    const mins = Math.round(HOUR / 60000);
    const reads = [];
    for (const p of st.rows) {
      const bars = canRead && store.readCandles1m ? store.readCandles1m(p.coin, st.open - 1, st.open + HOUR + 1) : [];
      reads.push({ p, n: bars.length, h1: firstHourStats(bars, st.open, st.open + HOUR) });
    }
    const partial = reads.filter((r) => r.h1 && r.h1.bars < mins);
    if (partial.length && now < st.open + HOUR + FOCUS_FILL_GRACE) return;   // hold; the tick retries
    for (const r of reads) {
      r.p.h1 = r.h1;                   // null = archive gap for THIS name: an honest dash, never a guess
      // Per-seat coverage, frozen with the row. A dash now carries its reason forever: "the lane
      // captured nothing for this name" is a different statement from "this name did not trade",
      // and a record that cannot tell them apart cannot be audited later. `inWin` is the count the
      // geometry was actually computed from; `bars` is the raw read and carries the window slop.
      r.p.h1cov = { bars: r.n, mins, inWin: r.h1 ? r.h1.bars : 0 };
    }
    st.filledAt = now;
    st.h1src = "1m";                   // the resolution this geometry was measured at, on the record
    st.fillNote = !canRead ? "candle archive disabled \u2014 first-hour columns cannot fill"
      : (partial.length ? `froze at the +${Math.round(FOCUS_FILL_GRACE / 60000)}m grace with ${partial.length} seat(s) short of ${mins} 1m bars \u2014 the lane did not complete the hour` : null);
    focusForming = null;               // the frozen record replaces every forming read
    focusPersist();
    const dry = st.rows.filter((p) => !p.h1).map((p) => p.ticker);
    log(`FOCUS +1h fill (1m base): ${st.rows.filter((p) => p.h1).length}/${st.rows.length} seat(s) carry a first-hour record`
      + (dry.length ? ` \u2014 NO BARS for ${dry.join(", ")}` : "") + (st.fillNote ? " \u2014 " + st.fillNote : ""));
  }
  // THE CLOSE FILL (2026.08.19-05). Same shape as the +1h fill above, and for the same reason: the
  // 1m archive writer lands a beat behind the clock, so firing at exactly 16:00 would freeze a
  // record whose last bar is 15:57 and call it the close. A seat whose lane is short of the final
  // minutes HOLDS the fill and the 30s tick retries; a seat with no bars at all does not hold it,
  // because an absent lane is not a late one and waiting cannot fix it. On expiry the record closes
  // regardless and states how short it came.
  // The window is bounded at both ends by the record's OWN session, never by "the last bar before
  // now" — a read taken at 18:00 must return the 16:00 print, not the after-hours tape.
  // -19-06 TAKES A RECORD rather than reading focusState, and the reason is a correction. -05 said
  // "a session nobody measured has no close" and refused to fill a retired record. That collapsed
  // two different things: the STAMP measures the live tape and genuinely cannot be taken late, but
  // this read is bounded by the record's own open and close, so taking it at 21:00 returns exactly
  // what taking it at 16:01 would have. Nothing about it drifts with the reading time. Under the old
  // rule the fill had a four-hour window (three in EST) between the close and the 00:00 UTC retire,
  // and any deploy or restart spanning it lost that session's close permanently — which is what
  // happened on 2026-08-19. The archive holding the window is the only thing that ever mattered.
  const FOCUS_CLOSE_GRACE = 5 * 60 * 1000;
  const FOCUS_CLOSE_SLOP = 2 * 60 * 1000;   // a complete 1m lane leaves exactly one bar-width of slop
  function closeFocus(st, now) {
    if (!st || st.closedAt || !Number.isFinite(st.close)) return;
    const canRead = store.candlesEnabled && store.candlesEnabled();
    const reads = [];
    for (const p of st.rows) {
      const bars = canRead && store.readCandles1m ? store.readCandles1m(p.coin, st.open - 1, st.close + 1) : [];
      reads.push({ p, n: bars.length, c: sessionCloseStats(bars, st.open, st.close) });
    }
    const short = reads.filter((r) => r.c && r.c.slopMs > FOCUS_CLOSE_SLOP);
    if (short.length && now < st.close + FOCUS_CLOSE_GRACE) return;   // hold; the tick retries
    for (const r of reads) {
      r.p.closePx = r.c ? r.c.closePx : null;    // null = no session bars for THIS name: an honest dash
      // Coverage frozen with the row, exactly as h1cov is. `slopMin` is the gap between the last
      // bar the archive actually holds and the session close — the number that separates "this is
      // the 16:00 print" from "this is the last thing the lane managed to write".
      r.p.closeCov = { bars: r.n, inWin: r.c ? r.c.bars : 0, slopMin: r.c ? Math.round(r.c.slopMs / 60000) : null };
    }
    st.closedAt = now;
    // `late` is disclosure, not decoration: a fill taken hours after the close is the same read, but
    // the record should say when it was taken so a thin `bars` count can be reasoned about later.
    st.closeLate = now > st.close + FOCUS_CLOSE_GRACE ? Math.round((now - st.close) / 60000) : 0;
    st.closeNote = !canRead ? "candle archive disabled \u2014 the close column cannot fill"
      : (short.length ? `closed at the +${Math.round(FOCUS_CLOSE_GRACE / 60000)}m grace with ${short.length} seat(s) whose last 1m bar sits more than ${Math.round(FOCUS_CLOSE_SLOP / 60000)}m before 16:00 \u2014 the lane did not reach the close` : null);
    focusPersist();
    const dry = st.rows.filter((p) => p.closePx == null).map((p) => p.ticker);
    log(`FOCUS close fill${st.closeLate ? ` (LATE \u2014 ${st.closeLate}m after the close)` : ""}: ${st.rows.filter((p) => p.closePx != null).length}/${st.rows.length} seat(s) carry a session close`
      + (dry.length ? ` \u2014 NO BARS for ${dry.join(", ")}` : "") + (st.closeNote ? " \u2014 " + st.closeNote : ""));
  }
  // The day's list dies at 00:00 UTC (2026.08.18-02). Deliberately NOT the ET boundary the rest of
  // this feature runs on: the stamp, the preview and the freeze are all cash-session events, but
  // the LIST'S SHELF LIFE is a reading rhythm, and the operator reads this board on UTC days. That
  // makes 20:00 ET the retirement hour in summer and 19:00 in winter — four-ish hours after the
  // close, and the one place in FOCUS where a DST shift moves something. Stated here so nobody
  // later "fixes" it back to ET thinking it was an oversight.
  // Retirement runs BEFORE the session gate, or a Friday list would survive the whole weekend:
  // Saturday has no session, the old tick returned early, and nothing ever retired it.
  const focusUtcDayStr = (ts) => new Date(ts).toISOString().slice(0, 10);
  const focusUtcDayOf = (st) => (st && st.utcDay) || (st ? focusUtcDayStr(st.frozenAt || st.open) : null);
  // A record stamped after its own session's close (2026.08.18-07). Structurally impossible for an
  // honest stamp now that the window is bounded, so any blob carrying one is a -02-era phantom.
  // Kept as a predicate rather than a version check: it tests the record's own internal consistency,
  // which is the thing that actually makes it invalid, and it stays true whatever produced it.
  function focusPhantom(st) { return !!(st && st.close > 0 && st.frozenAt > st.close); }
  // Boot repair. The phantom is dropped, never retired: retiring it would push it into `prev` and
  // evict the genuine record sitting there — which is exactly how 2026-08-17's list was lost. When
  // `prev` holds the real stamp for the SAME session, it is promoted back into the record slot and
  // the normal UTC roll below decides its shelf life from there. No fabrication: if the real record
  // is gone it is gone, and `prev` is left exactly as found rather than back-filled with a guess.
  function focusSanitize(data) {
    if (!data || !focusPhantom(data.state)) return data;
    const real = data.prev && data.prev.open === data.state.open && !focusPhantom(data.prev) ? data.prev : null;
    log(`FOCUS boot repair: dropped a phantom ${data.state.day} record stamped ${Math.round((data.state.frozenAt - data.state.close) / 60000)}m after its own close`
      + (real ? " \u2014 the genuine open stamp was recovered from the prior slot" : " \u2014 no genuine stamp for that session survives; the day stays a hole"));
    return { ...data, state: real, prev: real ? null : (data.prev || null) };
  }
  function focusRetire(now) {
    if (!focusState) return false;
    if (focusUtcDayOf(focusState) === focusUtcDayStr(now)) return false;
    // No phantom guard here on purpose: the stamp window can no longer mint one, and hydrate is the
    // single repair point for legacy blobs. A defensive branch at this line would be unreachable by
    // any test, and unreachable code is not a safeguard — it is a claim nobody can check.
    focusPrev = focusState;            // survives behind the "yesterday" toggle — retired, not deleted
    focusState = null;
    focusForming = null;               // forming reads belong to a stamp that no longer exists
    focusPersist();                    // bumps focusVer, so the client's poll sees the empty list
    log(`FOCUS retired ${focusPrev.day} at the 00:00 UTC boundary — list empty until the next stamp`);
    return true;
  }
  function focusTick(nowInj) {
    const now = Number.isFinite(nowInj) ? nowInj : Date.now();
    const today = etDayStr(now);
    focusRetire(now);
    // THE LATE CLOSE (2026.08.19-06). The retired slot gets its close filled too, and this runs
    // BEFORE the session lookup below on purpose: that lookup returns early on weekends and
    // holidays, which is exactly when a Friday close missed at 16:00 would otherwise sit unfilled
    // until Monday and then be retired past reach. Only the `prev` slot is reachable — there is no
    // walk back through older records, and none is wanted: the read is the same read, but a record
    // silently changing days after anyone last looked at it is a different kind of claim.
    if (focusPrev && Number.isFinite(focusPrev.close) && now >= focusPrev.close) closeFocus(focusPrev, now);
    const sess = marketSessions(now - 2 * DAY, now + 2 * DAY).find((s) => etDayStr(s.open) === today) || null;
    if (!sess) { focusPv = null; focusForming = null; return; }   // weekend / holiday: no preview, no forming
    if (now >= sess.open - FOCUS_PREVIEW_LEAD && now < sess.open && (!focusState || focusState.day !== today))
      buildFocusPreview(sess, now);
    // THE STAMP WINDOW (2026.08.18-07), bounded at BOTH ends. The open bound was always here; the
    // close bound is the fix for a re-stamp that shipped at -02 and fired every trading night at
    // 20:00 ET. focusRetire nulls the state at the 00:00 UTC boundary — 20:00 ET in summer — and
    // this gate then read a null state on an ET day whose session had opened ten hours earlier, so
    // it minted a second "FROZEN @ OPEN" record out of the 20:00 tape: full-day gap and RVOL reads
    // wearing open-gap labels, stamped and frozen in the same tick, over the top of the real 09:30
    // record. A frozen-at-OPEN list stamped after its own session closed is not a late stamp, it is
    // a different measurement wearing the stamp's name, and no clock choice upstream can make it
    // valid. The latch is the session's own `open` rather than an ET day string for the same
    // reason: a record must be pinned to the session it claims, not to a string that matches one.
    if (now >= sess.open && now < sess.close && (!focusState || focusState.open !== sess.open)) stampFocus(sess, now);
    const held = !!(focusState && focusState.open === sess.open);
    if (held && focusPv) focusPv = null;   // belt + braces: a stamp always retires the pool
    if (held && !focusState.filledAt && now >= sess.open) buildFocusForming(now);
    if (held && !focusState.filledAt && now >= sess.open + HOUR) fillFocus(now);
    if (held && now >= sess.close) closeFocus(focusState, now);   // closeFocus owns the already-filled guard
  }
  // `nowArg`: the same suite-only contract as getWhale. This payload's whole state machine is a
  // function of the clock — which ET session day it is, whether the open has passed, whether the
  // 00:00 UTC boundary has crossed — so a test that freezes time and cannot freeze it HERE is
  // reduced to asserting against whatever day the suite happens to run on. Routes omit it.
  function getFocus(nowArg) {
    const now = nowArg || Date.now(), today = etDayStr(now);
    const sess = marketSessions(now - 2 * DAY, now + 2 * DAY).find((s) => etDayStr(s.open) === today) || null;
    let state = "offday";
    const pv = (!focusState || focusState.day !== today) && focusPv && focusPv.day === today ? focusPv : null;
    if (focusState && focusState.day === today) state = focusState.filledAt ? "filled" : "frozen";
    else if (pv) state = "preview";
    // "cleared" separates two situations the old machine collapsed into "pending": today HAS been
    // stamped and then retired at 00:00 UTC (nothing more is coming), versus the open has passed
    // and the stamp hasn't landed yet (something IS coming). Derived from the retired record's own
    // session day rather than a flag, so it survives a restart without extra persistence.
    else if (focusPrev && focusPrev.day === today) state = "cleared";
    else if (sess) state = now < sess.open ? "pre" : "pending";
    return { ts: now, dataTs: focusVer, state, day: today,
      open: sess ? sess.open : null, close: sess ? sess.close : null,
      preview: pv ? { at: pv.at, rows: pv.rows, below: pv.below || [], belowN: pv.belowN || 0,
        scanned: pv.scanned || 0, cleared: pv.cleared || 0, limits: pv.limits || focusLimits(focusLim) } : null,
      previewN: FOCUS_PREVIEW_N, previewLeadMs: FOCUS_PREVIEW_LEAD,
      // Republish cadence, shipped rather than hardcoded in the client: the two must not drift, or
      // the board polls on a rhythm the server is not publishing on and "live" quietly means 60s.
      formingMs: FOCUS_FORMING_MS, h1src: "1m",
      forming: focusState && focusState.day === today && !focusState.filledAt && focusForming ? focusForming : null,
      // Chart shading (build 2026.08.17-01): cash-session windows across the chart's 72h
      // lookback (+ the next session), from the same calendar engine as the stamp — the client
      // dims off-session time instead of guessing at a fixed 16:00-to-09:30 rhythm that half
      // days and holidays would falsify.
      sessions: marketSessions(now - 78 * HOUR, now + 36 * HOUR).map((s) => ({ open: s.open, close: s.close })),
      cap: FOCUS_CAP, perCluster: FOCUS_PER_CLUSTER, belowShown: FOCUS_BELOW_N,
      // LIVE floors (what the next stamp will use) and the backstop under them. Distinct from
      // today.limits, which is what THIS record was cut with — the client renders the record's
      // own wall on the table and the live wall in the panel, and never confuses the two.
      limits: focusLimits(focusLim), hard: { vol: FOCUS_HARD_VOL, oi: FOCUS_HARD_OI },
      minVol: focusLimits(focusLim).vol,   // retained key: the older client's footer read it
      today: focusState && focusState.day === today ? focusState : null,
      prev: focusPrev,
      archive: { enabled: !!(store.candlesEnabled && store.candlesEnabled()) } };
  }
  // getCandles1m RETIRED (build 2026.08.17-01): with the 3m timeframe gone, every FOCUS chart
  // timeframe (5m/15m/1h/4h) aggregates from the local 5m archive via getCandles5m — the same
  // series the +1h fill reads. No live pull, no memo, no second source to disagree with.


  return {
    start,
    getSnapshot: () => snapshotCache,
    getDaily: () => dailyCache,
    getAnalytics: (scope) => {
      const cr = scope === "crypto";
      let c = cr ? analyticsCryptoCache : analyticsCache;
      // Self-heal: an empty cache means the scheduled build has not landed yet (or the boot path
      // died before arming it). Build once on demand, rate-limited, so the first request that finds
      // the cache cold repairs it rather than serving an empty fallback forever.
      if (!c && !(cr && !crypto)) {
        const now = Date.now(), last = cr ? analyticsCryptoLazyTs : analyticsLazyTs;
        if (now - last >= ANALYTICS_LAZY_CD) {
          if (cr) analyticsCryptoLazyTs = now; else analyticsLazyTs = now;
          // Async since -08: fire the chained build and serve the fallback THIS request — the cold
          // cache is repaired by the time the client's next poll lands, same self-heal, new tense.
          buildAnalyticsSafe(scope).catch(() => {});
        }
      }
      return c;
    },
    getAnalyticsErr: (scope) => (scope === "crypto" ? analyticsCryptoErrMsg : analyticsErrMsg),
    getDuel,
    duelTickNow: duelTick,           // harness: run one duel snapshot attempt at an injected clock, with an optional injected universe
    hydrateDuelNow: hydrateDuel,     // harness: hydrate duel state from the (stubbed) store without start()
    getSeries,
    // Per-coin cache-key inputs for the candle/series ETag: the spine's data-version stamp (max of
    // hourly + daily update times — bumps exactly when getSeries/getCandles output can change) and
    // the live mark (which drives the tf series' forming bar and streams independently of the
    // stamp). Returned together so the routes build a collision-proof, forming-bar-honest key.
    getCoinStamp: (coin) => { const r = rows.get(coin); return r ? { st: Math.max(r.hourlyTs || 0, r.dailyTs || 0), px: r.px || 0 } : { st: 0, px: 0 }; },
    getHourly,
    getFunding,
    getCandles,
    getCandles5m,
    // FOCUS tab (build 2026.08.15-01, chart re-sourced 2026.08.17-01): the frozen list, its
    // ETag stamp, and a harness hook to run one stamp/fill tick at an injected clock. The chart
    // reads the 5m archive via getCandles5m — no dedicated candle export anymore.
    getFocus,
    getFocusStamp: () => focusVer,
    focusTickNow: focusTick,
    // Liquidity floors (build 2026.08.18-03): the admin panel's read, its write, and the cheap
    // structural scan that feeds the panel's distribution — all off the one eligibility predicate.
    getFocusLimits: () => ({ limits: focusLimits(focusLim), hard: { vol: FOCUS_HARD_VOL, oi: FOCUS_HARD_OI }, scan: focusScan(), belowShown: FOCUS_BELOW_N }),
    setFocusLimits,
    // 13F whale lane (build 2026.08.16-01): FUNDS tab payloads, watchlist writes, and harness
    // hooks that run the real ingest/poll/season paths against injected fixtures.
    getWhale,
    getWhaleStamp: () => whaleVer,
    getWhaleFund,
    getWhaleHolds,
    getWhaleSeasonQ,
    whaleSearch,
    whaleAdd, whaleRm, whaleMute, whaleSeen, whalePull,
    whale13fIngestNow: whale13fIngest, whale13fTickNow: whale13fTick, t13fStatus,
    // CONGRESS lane phase 1 (2026.08.24-02): admin-only index ingest — no public payload yet.
    congressIngestNow: congressIngest, congressTickNow: congressTick, congressStatus,
    congressParseNow: congressParse, congressDiagNow: congressDiag, congressRequeueNow: congressRequeue,
    congressBackfillNow: congressBackfill,
    congressFilerSearch: (q) => (store.congressFilerSearch ? store.congressFilerSearch(q) : []),
    congressWatchList: () => (store.congressWatchList ? store.congressWatchList() : []),
    congressWatchSet: (m, on, notify) => {
      const ok = store.congressWatchSet ? store.congressWatchSet(m, on, notify) : false;
      return ok ? { ok: true, member: String(m), watched: !!on, notify: notify !== false }
        : { ok: false, error: "could not update the watchlist" };
    },
    congressFilings: (o) => (store.congressFilings ? store.congressFilings(o) : []),
    congressFeed: (o) => (store.congressFeed ? store.congressFeed(o) : []),
    congressFeedCount: (o) => (store.congressFeedCount ? store.congressFeedCount(o) : 0),
    congressTickerRoll: (t) => (store.congressTickerRoll ? store.congressTickerRoll(t) : null),
    houseIndexUrls,                              // harness: the candidate list is pinned by test
    congressAssetName,                           // harness: issuer-name cleaning, pinned by test
    whaleTickNow: whaleTick,                     // harness: one poll pass at an injected clock
    hydrateWhaleNow: whaleHydrate,               // harness: hydrate whale state from the (stubbed) store without start()
    whaleIngestNow: whaleIngest,                 // harness: push one filing through the REAL ingest path
    whaleSeasonNow: whaleSeasonMaybe,            // harness: force a season-build attempt
    whalePrimeNow: () => { whalePrimed = true; },
    hydrateFocusNow: hydrateFocus,
    getCryptoCorr, getCryptoCorrStamp,
    getCandleCoverage,
    // 5m archive freshness stamp for the route ETag: the coin's last-captured bar ts (in-memory,
    // no db hit). Advances as capture lands new bars, so a stale body is never served; a purely
    // historical window over-invalidates only at the live edge, which is harmless.
    getM5Stamp: (coin) => { const r = rows.get(coin); return r ? (r.m5LastTs || 0) : 0; },
    _m5FilterClosed: m5FilterClosed,   // harness: closed-bar guard, testable without network
    // Deep 12h/1d archive (2026.08.21-01): the CHARTS tab's long-history read, its ETag stamp
    // (in-memory last-captured-bar ts per interval), and the closed-bar guard for the harness.
    getCandlesDeep,
    getDeepStamp: (coin, iv) => { const r = rows.get(coin); return r && r.deep && r.deep[iv] ? (r.deep[iv].last || 0) : 0; },
    _deepFilterClosed: deepFilterClosed,   // harness: forming 12h/1d bar must never land
    getTfCandles,
    // Audience-aware since 2026.08.03-02: admin (or an all-public scope set) gets the shared cache
    // object untouched — identity path, memoized serialize/gzip and the numeric ETag all intact.
    getSignals: (isAdmin) => {
      if (!signalsCache) return signalsCache;
      const vis = featureScopeVis(featureFlags, "signals", !!isAdmin);
      return vis.all ? signalsCache : scopedBody("sig", signalsCache, vis);
    },
    askBoard,   // terminal Tier-3: NL question -> planner query or grounded analyst answer
    resetAiDay,   // terminal admin command: zero the daily report budget (ADMIN_PASSWORD-gated)
    checkAdminPassword,   // shared ADMIN_PASSWORD verify (+ lockout) — backs the AI unlock route
    getFlags, getFeatures, setFlag,   // feature-visibility state (admin panel)
    getNavGroups, setNavGroupLabel, setNavViewGroup,   // ribbon menus: rename, and move a tab between them
    getHousing: () => housingCache,   // Housing tab board (FRED-fed, 6h refresh)
    getLiquidity: () => liqCache,   // Liquidity tab board (FRED H.4.1, Thursday-aware refresh)
    getEarnings: () => {
      if (!earnCache) return earnCache;
      // filings links overlay at serve time (filings arrive continuously between the 6h
      // calendar refreshes); their signature folds into dataTs so a new link busts the ETag
      const flItems = newsItems.filter((a) => a.fl);
      const entries = linkEarningsFilings(earnCache.entries, flItems, Date.now());
      const recent = linkEarningsFilings(earnCache.recent, flItems, Date.now());
      const sig = entries.concat(recent || []).map((e) => e.filing ? e.t + ":" + e.filing.form : "").join(",");
      if (sig !== earnLnSig) { earnLnSig = sig; earnLnVer = Date.now(); }
      return Object.assign({}, earnCache, { entries, recent,
        macro: macroCache && Array.isArray(macroCache.entries) ? macroCache.entries : [],
        macroErr: macroCache ? macroCache.error : "not fetched yet",
        macroAsOf: macroCache ? macroCache.asOf : null,
        dataTs: Math.max(earnCache.dataTs || 0, earnLnVer, macroCache ? (macroCache.dataTs || 0) : 0) });
    },
    voidEarnPrint,
    getTrend,
    getTrendPair,
    getActionable,
    getTriggers,
    getPush,
    pushMintCode,
    pushUnlink,
    pushSetClasses,
    pushTest,
    pushOpsNow: pushOps,                       // harness + later slices: emit an ops event without a real fault
    pushBindNow: pushBind,                     // harness: bind a chat without a live /start round trip
    hydratePushNow: hydratePush,               // harness: restore recipients without a boot
    pushTickNow: pushStreamTick,               // harness: consume the stream on demand
    pushDrainNow: pushDrain,                   // harness: drain the outbox against an injected transport
    pushUpdatesNow: pushUpdatesTick,           // harness: process a getUpdates payload without waiting out the poll
    pushHealthNow: pushHealthTick,             // harness: run the stall watchdog against a forced lastPoll
    pushStateNow: () => ({ queue: pushQueue.length, hold: pushHoldUntil, dropped: pushDropped,
      recipients: pushRecipients.size, codes: pushCodes.size, offset: pushOffset, bootAt: pushBootAt }),
    pushSetBootNow: (t) => { pushBootAt = t; },   // harness: exercise the boot lookback deterministically
    pushSetPollNow: (t) => { lastPoll = t; },     // harness: age the poll clock so the stall watchdog is testable without waiting 10 minutes
    levelScanNow: levelScan,                     // harness: run the live level scan on demand
    getRules,
    addRule,
    deleteRule,
    ruleScanNow: ruleScan,                       // harness: evaluate the rule list against the current snapshot
    getClassRates,
    pushSetPrefs,
    pushClaim,
    regimeScanNow: regimeScan,
    trendScanNow: trendScan,
    trendPrimeNow: () => { trendPrimed = true; },
    ma200ScanNow: ma200Scan,
    ma200PrimeNow: () => { maPrimed = true; },
    ma200StateNow: () => maState,
    trendIndexNow: () => trendByCoin,
    coverageScanNow: coverageScan,
    briefTickNow: briefTick,                     // harness: run delivery without waiting out the clock
    briefCtxNow: buildBriefCtx,                  // harness: execute the real context assembly — string pins can't prove routing (the -84 lesson)
    buildBriefCtxNow: buildBriefCtx,             // harness: assemble the context off live state
    generateBriefNow: generateBrief,
    briefTest: briefTestNow,
    landTest: landTestNow,
    landTickNow: landTick,                       // harness: run delivery without waiting out the clock
    landCtxNow: buildLandCtx,                    // harness: inspect the corpus the model is handed
    landCacheReset: () => { landCache = null; landSent.clear(); },
    landStateNow: () => ({ defaultHour: schedDefFor("landscape").defaultHour, perDay: LAND_PER_DAY,
      dayLeft: landDayLeft(), enabled: LAND_ON, windowH: LAND_WINDOW_H, system: LAND_SYSTEM }),
    briefRatesNow: briefRates,
    briefCacheReset: () => { briefCache = null; briefSent.clear(); },
    briefStateNow: () => ({ defaultHour: BRIEF_DEFAULT_HOUR, perDay: BRIEF_PER_DAY, dayLeft: briefDayLeft(),
      lastErr: briefLastErr, enabled: BRIEF_ON, model: BRIEF_MODEL }),
    briefTzForNow: briefTzFor,   // harness: the offset resolution both delivery and the panel read
    briefIsDefaultNow: briefIsDefault,
    fundamentals,                                // on-demand SEC XBRL pull for the terminal's `fund` card
    etfHoldings,                                 // on-demand SEC N-PORT pull for the terminal's `etf` card
    fundSeedNow: (t, res) => { fundCache.set(String(t).toUpperCase(), { at: Date.now(), res }); },   // harness: stage filed facts without an EDGAR round trip
    filingScanNow: filingScan,                   // harness: feed parsed EDGAR items without a fetch
    getSectorAudit,                              // admin panel payload: applied overlay + flags + pins
    sectorAuditRevert,                           // admin: revert one applied entry (pins it)
    sectorAuditApply,                            // admin: resolve a flagged name to a chosen sector
    sectorAuditAck,                              // admin: clear an applied row from the panel (overlay stays active)
    sectorAuditRunNow: sectorAuditRun,           // admin "run now" + harness entry
    auditSeedNow: (records) => { auditRecs = Array.isArray(records) ? records : []; return applyAuditOverlay(); },   // harness: stage a record log without disk or fetches
    auditStateNow: auditState,                   // harness: inspect the folded state
    earnScanNow: earnScan,                       // harness: run the proximity check on demand
    earnRebuildNow: rebuildEarnMap,              // harness: stage a calendar without a Finnhub round trip
    earnPreviewNow: earnPreviewScan,             // harness: run the daily calendar without waiting for 17:00 ET
    earnPrevResetNow: () => { earnPrevDay = null; },   // harness: re-open the once-a-day gate
    macroScanNow: macroScan,                     // harness: run the calendar scan on demand
    macroPrimeNow: () => { macroPrimed = true; },      // harness: skip the silent seeding pass
    macroSeedNow: (entries) => { macroCache = { ts: Date.now(), dataTs: Date.now(), asOf: Date.now(), error: null, entries: entries || [], kinds: 1 }; },   // harness: stage a calendar without a FRED round trip
    aiFlipCheckNow: aiFlipCheck,                 // harness: compare two report objects directly
    filingPrimeNow: () => { filingPrimed = true; },   // harness: skip the 45-minute seeding window
    hydrateRulesNow: hydrateRules,               // harness: restore rules + edge state without a boot
    ledgerOpenNow: () => ledgerOpen,             // harness: reach the open claims to stage geometry
    ledgerClosedNow: () => ledgerClosed,         // harness: stage resolved entries so the scoped record builds off real claims
    recomputeRecordNow: recomputeRecord,         // harness: rebuild recordCache/recordCacheU from the staged ledger without a full build
    checkPromotionsNow: (force) => checkPromotions(force),   // harness: run the promotion sweep; force=true bypasses the daily clock (F4)
    variantStateNow: () => variantState,         // harness: read/stage incumbent index + promotion history (dwell)
    variantStatsNow: () => variantStats,         // harness: read the per-variant {n,hit,avg,sd} the gate consumes
    setVariantStatsNow: (v) => { variantStats = v; },   // harness: inject variant aggregates without seeding a full ledger
    confCacheNow: () => confCache,                       // harness: read the earned confluence bonus (F8)
    primeV2LiveNow: (uni, ev) => primeV2Live(uni, ev),   // harness: the asymmetric-profile prime predicate against the live record (F6)
    evidenceNow: (st, ev, pooled, unit, uni) => evidence(st, ev, pooled, unit, uni),   // harness: run the REAL scoped blend (F1/F2), not a reimplementation
    recForNow: (uni) => recFor(uni),             // harness: which universe record the score reads
    resolveLedgerNow: resolveLedger,             // harness: force resolution without waiting out a horizon
    buildActionableNow: buildActionable,   // harness: force an actionable rebuild without waiting out the memo
    boardEpStateNow: () => ({ open: [...boardEp.values()], closed: boardEpClosed.slice(), since: boardEpSince, dropped: boardEpDropped }),   // harness: the settled record's raw state
    ledgerCloseNow: (key, patch) => {   // harness: resolve one open claim in place so episode settlement is testable without waiting out a horizon
      const e = ledgerOpen.get(key); if (!e) return false;
      ledgerOpen.delete(key);
      ledgerClosed.push(Object.assign(e, { status: "resolved", tR: Date.now() }, patch || {}));
      ledgerDirty = true; return true;
    },
    hydrateTriggersNow: hydrateTriggers,   // harness: restore announced-set/event log without a boot
    trigStateNow: () => ({ seq: trigSeq, seen: trigSeen.size, events: trigEvents.length, firstBuild: trigFirstBuild }),
    buildTrendNow: buildTrend,   // harness: force a trend-board rebuild without waiting out the memo
    seedTrendNow: (coin, tb) => {   // harness: place a synthetic board read so trendScan's episode gates are testable without candle history; freezes the memo so a fake clock can't trigger a rebuild mid-test
      trendByCoin.set(coin, tb);
      if (!trendCache) trendCache = { ts: Date.now() };
      trendBuilt = Number.MAX_SAFE_INTEGER / 2;
    },
    seedRowNow: (coin, fields) => {   // harness: seed a synthetic market so builds are testable without network; main-universe seeds join the main roster exactly as the refresh would place them
      const r = Object.assign(getRow(coin), fields);
      if (Array.isArray(r.hourlyRaw)) r.hourlyRaw = packHours(r.hourlyRaw);   // seed the packed spine exactly as refreshHourly/hydrate would (accepts object or packed input)
      if (r.uni === "main") { if (!mainList.includes(coin)) mainList.push(coin); if (!mainOrder.includes(coin)) mainOrder.push(coin); }
      else if (!order.includes(coin)) order.push(coin);   // xyz seeds join the xyz roster exactly as the universe refresh would place them
      return r;
    },
    detectBenchNow: () => { benchCoin = detectBenchmark(); return benchCoin; },   // harness: resolve the SPX proxy without a universe refresh (the brief must never resolve its own)
    seedHistNow: (coin, arr) => { hist.set(coin, arr); },   // harness: seed the sampled OI/funding history ([t, oi, funding] rows) so oiDailySeries is testable without network
    hydrateFeaturesNow: hydrateFeatures,   // harness: run the warm-cache hydrate against an injected store.loadFeatures — persisted-shape compat is testable without a boot
    seedEarnNow: (entries, study, prints) => {   // harness: inject calendar rows / study / print history so the earnings-context split is testable without network
      // `recent` is derived from the injected prints exactly as fetchEarnings derives it — a seeded
      // cache with an always-empty recent list made the brief's Printed path untestable and
      // therefore untested, which is how the padR slicing survived to an audit.
      earnCache = { ts: Date.now(), dataTs: 1, asOf: Date.now(), windowDays: EARN_WINDOW_DAYS, source: "finnhub", error: null, entries: entries || [], recent: recentEarnPrints(prints || [], Date.now()), eligible: 1 };
      if (study) earnStudy = study;
      if (prints) earnPrints = prints;
      return earnCache;
    },
    needDailyNow: (coin) => { const r = rows.get(coin); return !!(r && needDaily(r)); },   // harness: does the daily worker consider this market fetch-worthy right now
    getLedgerFor,
    getLedgerExport,
    getNews: () => newsCache,
    newsIngestNow: (items) => { newsItems = mergeNews(newsItems, gateCompanyItems(items || []), Date.now()); newsFetchedAt = Date.now(); buildNewsPayload(); return newsCache; },   // harness: feed + payload without network — company items pass the relevance gate exactly as in production
    classifySecNow: () => classifySecTick(),   // harness: one classifier pass through the injected aiFetch transport
    getTgChannels,
    // Custom baskets + ratio pairs (visual layer only — see the tier-boundary note at the section)
    getBasketsPayload,
    getBasketsStamp,
    createBasket,
    dropBasket,
    getNotesPayload,
    getNotesStamp,
    createNote,
    editNote,
    dropNote,
    getRatio,
    setTgChannels,
    tgIngestNow: (html, ch) => {   // harness: the full per-item pipeline (parse -> attribute -> merge -> payload) without network
      const { items } = parseTgPreview(html, ch, Date.now());
      const roster = tgRoster();
      for (const a of items) { const T = attributeTg(a.h, roster); if (T) { a.tk = T; a.rel = 1; } }
      newsItems = mergeNews(newsItems, items, Date.now());
      buildNewsPayload();
      return newsCache;
    },
    aireadClaimsNow: () => ({ open: [...ledgerOpen.values()].filter((e) => e.ev === "airead"),
      closed: ledgerClosed.filter((e) => e.ev === "airead") }),   // harness: the analyst bucket directly — vi-stamped claims are correctly invisible to the drawer payload
    openLedgerNow: (coin, ev, sigEntry, dir, extra, vi) =>   // harness: fire a claim directly so the context stamp is testable without a full signals build
      openLedger(getRow(coin), ev, sigEntry || { score: 0, reading: "" }, dir, extra, vi),
    // AI analyst report: cached read, on-demand generation (TTL cooldown enforced inside), and
    // the recent-reports list for the Report tab.
    getAiReport,
    getAiQuota: (owner, admin) => admin ? { admin: true } : aiUserQuota(owner),
    listSectors: () => { const out = new Map();
      for (const r of rows.values()) { if (!r || r.delisted || r.uni === "main") continue;
        const c = classifyCached(r.ticker, r.uni); if (c.assetClass !== "Equity") continue;
        out.set(c.sector, (out.get(c.sector) || 0) + 1); }
      return [...out.entries()].filter(([, n]) => n >= 3).sort((a, b) => b[1] - a[1]).map(([name, n]) => ({ name, n })); },
    // Coinalyze deriv context: cached read (per-coin), manual refresh (cooldown enforced inside),
    // and the collision-proof ETag key for serveKeyed — coin + content clock + this coin's manual
    // refresh stamp + the as-of minute, so a cooldown tick or staleness advance is never frozen
    // behind a cached body.
    getDerivs,
    refreshDerivs,
    derivsKey: (coin) => coin + "|" + czVer + "|" + (czRefreshAt.get(coin) || 0) + "|" + (czErr ? 1 : 0) + "|" + Math.floor((czLastOk || 0) / 60000),
    // Fundamentals: cached read + collision-proof ETag key. mkt cap / P/E / P/S are derived live off
    // the mark, so the key folds a COARSE px bucket (~0.25% via log) — the panel refreshes as price
    // moves meaningfully without busting cache every snapshot tick.
    getFundamentals,
    fundamentalsKey: (coin) => {
      const r = rows.get(coin);
      const sym = r ? fundSym(r.ticker) : coin;
      const f = fundData.get(sym);
      const pxb = (r && r.px > 0) ? Math.round(Math.log(r.px) * 400) : 0;
      return coin + "|" + fundVer + "|" + (f ? f.at : 0) + "|" + pxb + "|" + (fundErr ? 1 : 0);
    },
    generateAiReport,
    listAiReports,
    aiCompileNow: compileAiContext,   // harness: build the context object without any network
    aiValidateNow: validateAiReport,  // harness: run model text through the validator + server math
    aiRejectShapeNow: aiRejectShape,  // harness: the log-only structural fingerprint of a rejected payload
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
    settleBuildsNow: () => buildChain,   // harness: await every build currently queued on the serialized chain — how a test observes an async self-heal without patching around the production path
    resolveLedgerNow: resolveLedger,   // harness: resolve due claims against the seeded spines without waiting out a build cycle
    buildDailyNow: buildDaily,       // harness: populate daily closes so the signals loop has inputs
    buildSnapshotNow: buildSnapshot, // harness: run one snapshot build synchronously (content-sig identity test)
    buildAnalyticsNow: buildAnalytics, // harness: run one analytics build synchronously (regime aggregate path)
    persistFeatures,
    persistLedger: () => { ledgerDirty = true; persistLedger(); },
    // Final-flush surface for the shutdown and crash paths: everything that otherwise persists
    // on a timer gets one more write on the way out. Each is idempotent, cheap, and safe to
    // call at any moment; persistHourly is the only async one (NDJSON stream) and shutdown
    // awaits it, while the crash path skips it — the spine self-heals from REST on boot.
    persistHourly: () => persistHourly(),
    persistTriggers,
    persistPush,
    // Rich health: fail/backoff counts, backfill queue depth, rate-limiter utilization and
    // WS status make "it looks stale" diagnosable from /api/health instead of Railway logs.
    stats: () => {
      const now = Date.now();
      let active = 0, hFailing = 0, dFailing = 0, fFailing = 0, pendH = 0, pendD = 0;
      const staleSp = [];   // spines past the coverage-alert threshold, with the per-coin fail state that explains WHY
      for (const r of rows.values()) {
        if (r.delisted) continue;
        active++;
        if ((r.hFailUntil || 0) > now) hFailing++;
        if ((r.dFailUntil || 0) > now) dFailing++;
        if ((r.fFailUntil || 0) > now) fFailing++;
        if (!r.feat) pendH++;
        if (!r.dailyRaw) pendD++;
        if (r.hourlyTs > 0 && now - r.hourlyTs > COVERAGE_STALE_MS)
          staleSp.push({ coin: r.coin, ageMin: Math.round((now - r.hourlyTs) / 60000), hFail: r.hFail || 0,
            backoffS: (r.hFailUntil || 0) > now ? Math.round((r.hFailUntil - now) / 1000) : 0 });
      }
      staleSp.sort((a, b) => b.ageMin - a.ageMin);
      return {
        version: version || null,
        markets: rows.size, active, bench: benchCoin, oiCoins: hist.size,
        crypto: crypto ? { selected: mainList.length, active: mainMarkets().length, bench: MAIN_BENCH } : null,
        hourly: hourlyCoverage(), funding: fundingCoverage(), lastPoll,
        backfill: { hourlyPending: pendH, dailyPending: pendD },
        failing: { hourly: hFailing, daily: dFailing, funding: fFailing },
        // Stale spines with fail state: the next coverage episode is diagnosable from one curl of
        // /api/health instead of correlating Railway logs after the fact. hFail=0 on a stale spine
        // means the fetch never failed — the coin simply never got queue time (budget contention).
        spines: { staleMs: COVERAGE_STALE_MS, stale: staleSp.length,
          worstAgeMin: staleSp.length ? staleSp[0].ageMin : 0, coins: staleSp.slice(0, 20) },
        // Named tick durations (worst-first): the "which build was the stall" answer, served where
        // the Loop dot already looks. worstAt makes a boot spike attributable instead of eternal.
        ticks: [...tickStats].map(([name, v]) => ({ name, n: v.n, last: v.last, worst: v.worst, worstAt: v.worstAt, slow: v.slow, async: v.async }))
          .sort((a, b) => b.worst - a.worst).slice(0, TICK_TOP),
        signals: signalsCache ? signalsCache.count : 0,
        ledger: { open: ledgerOpen.size, resolved: ledgerClosed.length },
        earnings: { entries: earnCache ? earnCache.entries.length : 0, asOf: earnCache ? earnCache.asOf : null,
          prints: earnPrints.length, histDone: earnHistDone, studyTickers: Object.keys(earnStudy).length,
          error: earnCache ? earnCache.error : (earnErr || "not fetched yet") },
        backup: { enabled: !!(BK_REPO && BK_TOKEN), repo: BK_REPO || null, lastOk: backupLast, error: backupErr },
        news: { items: newsItems.length, fetchedAt: newsFetchedAt || null, error: newsErr,
          sectors: { tapeClassified: Object.keys(secTape).length, learnedTickers: Object.keys(secLearned).length, error: secErr },
          filings: { items: newsItems.filter((a) => a.fl).length, material: newsItems.filter((a) => a.fl && a.mat).length,
            fetch: { lastOk: edgarStat.lastOk, lastErr: edgarStat.lastErr, lastErrAt: edgarStat.lastErrAt,
              ok: edgarStat.ok, clientErr: edgarStat.http4, forbidden: edgarStat.http403, netFail: edgarStat.fail,
              namesCovered: edgarStat.names } },
          telegram: { channels: tgChannels.length, items: newsItems.filter((a) => a.tg).length,
            errors: [...tgStatus.entries()].filter(([, s]) => s.error).map(([c, s]) => c + ": " + s.error) },
          relevance: { verified: newsItems.filter((a) => a.tk && a.rel === 1).length,
            pending: newsItems.filter((a) => a.tk && a.rel === 0).length,
            offTopic: Object.values(secTape).filter((s) => s === "off-topic").length,
            learnedAliases: Object.keys(nameLearned).length } },
        ai: { enabled: !!(AI_KEY() || aiFetch), provider: AI_PROVIDER, model: AI_MODEL,
          fallback: AI_MODEL_FALLBACK, classify: AI_CLASSIFY_MODEL, ttlMin: Math.round(AI_TTL_MS / 60000), reports: aiReports.size,
          perDay: AI_REPORTS_PER_DAY, dayLeft: aiDayLeft(),
          askPerDay: ASK_REPORTS_PER_DAY, askDayLeft: askDayLeft() },
        derivs: { enabled: !!cz, mapped: czMap ? mainList.filter((c) => czMap[c]).length : 0,
          unmapped: czUnmapped.length, coins: czHist.size, lastOk: czLastOk || null,
          lastSweep: czLastSweep || null, error: czErr, usage: cz ? cz.usage() : null },
        rate: limiterUsage(),
        ws: sock ? Object.assign(sock.status(), { applied: wsApplied }) : { enabled: false },
      };
    },
  };
}

module.exports = { createPoller };
