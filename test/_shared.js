"use strict";
// Helpers shared by the split test files (build 2026.09.16-80): every top-level fixture, harness and
// require that test.js used to declare once, in its original order. Exported by name; each test file
// destructures what it uses.

// Run with: npm test  (uses Node's built-in test runner, no dependencies)
const test = require("node:test");
const assert = require("node:assert");
const { classify, companyName } = require("../src/sectors");

// ===== build 2026.08.26-33: funding heatmap (1h / 8h / 24h) =====================================
// The board is memoized behind a 60s TTL and Date.now() is real here, so a test that changes the
// book has to clear that memo explicitly. The hook clears only the TTL stamp — the rebuild itself
// runs the production path, error handling and all.
function forceRebuild(p) { p.fundBoardRebuildNow("stocks"); }

const { stdev, median, linregR2, priceAt, featuresFromHourly, oiDeltaPct, pearson, meanPairwiseCorr, corrMatrix, studyBreakdown, playbook, confSplit, studyOIFlush, studyFPDiv, offDriftStats } = require("../src/compute");

const HOUR = 3600 * 1000, DAY = 86400 * 1000;

const C = require("../src/compute");

// ---- Slice A (2026.07.30-02): the study<->live blend honours the universe wall, migrates trust
// at tape-day speed, and its fallback branch stays expectancy-centered ---------------------------
// Helper: N resolved entries for one (coin, ev). Crypto ids (no ":") MUST sit after CRYPTO_EPOCH
// (2026-07-26) or the hydrate-time pre-epoch purge drops them; equity ids ("xyz:...") have no such
// floor. `dayBase` picks the first UTC day; spreadDays walks forward one day per entry (cl=n) vs
// stacking on dayBase (cl=1). Distinct ms keeps entries unique within a shared UTC day.
function blendClosed(coin, ev, n, realized, opts) {
  opts = opts || {};
  const EPOCH_DAY = Math.floor(Date.UTC(2026, 6, 26) / 86400000);
  const today = Math.floor(Date.now() / 86400000);
  // Anchor so the LAST entry lands on/just after the epoch for crypto, and comfortably in-window
  // for equities. For spread runs we still need n distinct days; equities can reach back freely,
  // crypto is clamped to >= epoch (callers keep crypto spreads small or use equities for wide cl).
  const isCrypto = !String(coin).includes(":");
  const floorDay = isCrypto ? EPOCH_DAY + 1 : today - (n + 5);
  const out = [];
  for (let i = 0; i < n; i++) {
    const dayIdx = opts.spreadDays ? floorDay + i : floorDay;   // spread -> cl=n ; stacked -> cl=1
    const t0 = dayIdx * 86400000 + i * 1000;                    // distinct ms, same UTC day when stacked
    out.push({ key: coin + "|" + ev + "#h" + i, coin, ticker: coin.split(":").pop() || coin, ev,
      t0, mark0: 100, dir: 1, sd0: 2, status: "resolved", tR: t0 + 5 * 86400000,
      realized, realizedS: realized, win: realized > 0, winS: realized > 0, psd: "long", pn: 1 });
  }
  return out;
}

// ===== INSIDERS: SEC Form 4 (build 2026.08.27-38) ===============================================
// The lane's claim is that nothing on the tab is derived: shares, price and date are the filer's
// own figures. These tests exist to keep that claim true — every assertion below is either "the
// number survived unchanged" or "an absence stayed an absence rather than becoming a zero".
function f4Doc(txs, opts) {
  const o = opts || {};
  return `<?xml version="1.0"?><ownershipDocument><schemaVersion>X0508</schemaVersion>
<documentType>${o.form || "4"}</documentType><periodOfReport>2026-08-25</periodOfReport>
<issuer><issuerCik>0000050863</issuerCik><issuerName>INTEL CORP</issuerName><issuerTradingSymbol>INTC</issuerTradingSymbol></issuer>
${o.owners || `<reportingOwner><reportingOwnerId><rptOwnerCik>0001234567</rptOwnerCik><rptOwnerName>Tan Lip-Bu</rptOwnerName></reportingOwnerId>
<reportingOwnerRelationship><isDirector>1</isDirector><isOfficer>1</isOfficer><isTenPercentOwner>0</isTenPercentOwner><officerTitle>Chief Executive Officer</officerTitle></reportingOwnerRelationship></reportingOwner>`}
<nonDerivativeTable>${txs}</nonDerivativeTable>${o.deriv || ""}</ownershipDocument>`;
}
const F4_BUY = `<nonDerivativeTransaction><securityTitle><value>Common Stock</value></securityTitle>
<transactionDate><value>2026-08-25</value></transactionDate>
<transactionCoding><transactionFormType>4</transactionFormType><transactionCode>P</transactionCode></transactionCoding>
<transactionAmounts><transactionShares><value>500000</value></transactionShares><transactionPricePerShare><value>20.0000</value></transactionPricePerShare>
<transactionAcquiredDisposedCode><value>A</value></transactionAcquiredDisposedCode></transactionAmounts>
<postTransactionAmounts><sharesOwnedFollowingTransaction><value>1500000</value></sharesOwnedFollowingTransaction></postTransactionAmounts>
<ownershipNature><directOrIndirectOwnership><value>D</value></directOrIndirectOwnership></ownershipNature></nonDerivativeTransaction>`;
// A sale under a 10b5-1 plan, with the price left to a footnote — both of the cases that a naive
// reader of this form gets wrong.
// Table II: an option exercise, the leg that turns "the CEO sold $1.3M of stock" into "the CEO
// converted compensation to cash". Carries a strike where a share row carries a price, which is
// the entire reason the two tables are separate on the form.
const F4_DERIV = `<derivativeTable><derivativeTransaction>
<securityTitle><value>Employee Stock Option (right to buy)</value></securityTitle>
<conversionOrExercisePrice><value>12.04</value></conversionOrExercisePrice>
<transactionDate><value>2026-08-26</value></transactionDate>
<transactionCoding><transactionFormType>4</transactionFormType><transactionCode>M</transactionCode></transactionCoding>
<transactionAmounts><transactionShares><value>5191</value></transactionShares><transactionPricePerShare><value>0</value></transactionPricePerShare>
<transactionAcquiredDisposedCode><value>D</value></transactionAcquiredDisposedCode></transactionAmounts>
<expirationDate><value>2032-09-14</value></expirationDate>
<underlyingSecurity><underlyingSecurityTitle><value>Common Stock</value></underlyingSecurityTitle><underlyingSecurityShares><value>5191</value></underlyingSecurityShares></underlyingSecurity>
</derivativeTransaction></derivativeTable>`;
const F4_PLANSELL = `<nonDerivativeTransaction><securityTitle><value>Common Stock</value></securityTitle>
<transactionDate><value>2026-08-26</value></transactionDate>
<transactionCoding><transactionCode>S</transactionCode><aff10b5One><value>1</value></aff10b5One></transactionCoding>
<transactionAmounts><transactionShares><value>12,500</value></transactionShares><transactionPricePerShare><footnoteId id="F1"/></transactionPricePerShare>
<transactionAcquiredDisposedCode><value>D</value></transactionAcquiredDisposedCode></transactionAmounts></nonDerivativeTransaction>`;

// ---- red-tape resilience (fourHourReturns / tapeRedStats) + RVOL ---------------------------
const { fourHourReturns, tapeRedStats, rvolMulti } = require("../src/compute");

// Build an hourly spine [[t,o,h,l,c,v],...] from a per-4h-bucket return schedule, so the 4h
// close-to-close returns reconstructed by fourHourReturns are exactly the schedule.
function spineFrom4h(rets4h, endMs, hourlyVol) {
  const B = 4 * HOUR, n = rets4h.length;
  const startB = Math.floor(endMs / B) - n - 1;   // last block = curB-1: fully completed
  let px = 100; const closes = [px];
  for (const r of rets4h) { px = px * (1 + r); closes.push(px); }
  const out = [];
  for (let i = 0; i <= n; i++) {
    const b = startB + i, c = closes[i];
    for (let h = 0; h < 4; h++) out.push([b * B + h * HOUR, c, c, c, c, hourlyVol == null ? 1 : hourlyVol]);
  }
  return out;
}

// ===== AI analyst report =================================================================
// The engine has three separable responsibilities, each tested without any network: (1) the
// context compiler builds an honest, universe-tagged payload from data in memory; (2) the
// validator accepts only schema-conforming model output, pins the void to frozen claim geometry,
// and computes every displayed number server-side; (3) the cache enforces the TTL cooldown for
// everyone and unlocks on material change. The transport is injected (aiFetch), so the suite
// exercises the full generate path — including the Fable→Opus fallback — offline.

function aiTestPoller(extra) {
  const { createPoller } = require("../src/poller");
  const store = { loadAll: () => new Map(), loadRegime: () => [], loadLedger: () => null,
    saveLedger: () => {}, insert: () => {}, saveRegime: () => {},
    loadAiReports: () => null, saveAiReports: () => {} };
  const p = createPoller(Object.assign({ dex: "xyz", store, log: () => {}, version: "test", crypto: false }, extra || {}));
  // A synthetic equity with enough daily + hourly history for the ladder, features and compiler.
  const now = Date.now(), DAY_ = 86400000, HOUR_ = 3600000;
  const daily = Array.from({ length: 80 }, (_, i) => {
    const c = 100 * Math.pow(1.008, i);
    return { t: now - (79 - i) * DAY_, o: c * 0.995, h: c * 1.01, l: c * 0.99, c };
  });
  const hourly = Array.from({ length: 40 * 24 }, (_, i) => {
    const c = 100 * Math.pow(1.0003, i);
    return { t: now - (40 * 24 - 1 - i) * HOUR_, o: c * 0.999, h: c * 1.002, l: c * 0.998, c, v: 1000 };
  });
  const px = daily[daily.length - 1].c * 1.002;
  p.seedRowNow("xyz:NVDA", { px, d1: 1.2, funding: 0.00001, vol: 5e7, oi: 2e7,
    ref: { p1h: px * 0.999, p4h: px * 0.996, p7d: px * 0.94, p30d: px * 0.85 },
    dailyRaw: daily, hourlyRaw: hourly, dailyTs: now, hourlyTs: now, isNew: false });
  return { p, px, now };
}
const AI_GOOD = (px, voidLv, tgt) => JSON.stringify({
  headline: "Constructive, leans long", bias: "long",
  news_read: { used: false, note: "no verified headlines in the window" },
  synthesis: "This name has been trending higher for weeks on the daily chart, with the 12-hour and 4-hour structure agreeing. Money is entering rather than leaving, and the move is its own strength rather than benchmark beta. The main risk is a pullback toward the ribbon; the thesis holds above the void level.",
  evidence: [
    { k: "structure", v: "Uptrend on all three timeframes that matter, roughly three weeks old." },
    { k: "positioning", v: "Open interest grew alongside price this week — buyers initiating." },
    { k: "vs benchmark", v: "Most of the 7-day move is name-specific strength, not index beta." },
  ],
  eventRisk: null,
  scenarios: [
    { name: "continuation to the target", kind: "target", p: 0.5, target: tgt, note: "trend persists" },
    { name: "chop, then resolve", kind: "flat", p: 0.3, target: null, note: "sideways digestion" },
    { name: "breaks the void", kind: "void", p: 0.2, target: null, note: "thesis dead below" },
  ],
  invalidations: ["A daily close below the EMA21 ribbon.", "Open interest falling while price stalls."],
  action: { stance: "enter_now", entry: null, note: "Trend and positioning agree; the void is close enough for a fair risk unit." },
  levels: [
    { value: voidLv, kind: "void", label: "void — thesis dead below" },
    { value: tgt, kind: "target", label: "continuation target" },
  ],
});

// ===== -09: structural level detector + void snap rule ========================================
// A zigzag whose turning points land on exact prices, so the pivot detector has unambiguous
// structure to find: resistance at 130 (4 touches), support at 100 (3), and a FLIP at 115 —
// one leg peaks there, a later leg troughs there. Linear legs mean no interior bar is ever a
// pivot (each sits strictly between its neighbours), so every level below is deliberate.
function zigDaily(pts, per, t0, dayMs) {
  const out = [];
  for (let s = 0; s < pts.length - 1; s++) {
    const a = pts[s], b = pts[s + 1];
    for (let j = 1; j <= per; j++) out.push(a + (b - a) * (j / per));
  }
  return out.map((c, i) => ({ t: t0 + i * dayMs, o: c, h: c * 1.001, l: c * 0.999, c }));
}
const ZIG_PTS = [100, 130, 100, 130, 100, 115, 100, 130, 115, 130, 100];

// A poller seeded with the same zigzag, but ending on a partial recovery so the mark sits
// MID-range: structure exists both above (130 resistance) and below (115 flip, 100 support),
// which is the only configuration where a long void has anywhere legitimate to land.
function aiLevelPoller() {
  const { createPoller } = require("../src/poller");
  const store = { loadAll: () => new Map(), loadRegime: () => [], loadLedger: () => null,
    saveLedger: () => {}, insert: () => {}, saveRegime: () => {},
    loadAiReports: () => null, saveAiReports: () => {} };
  const p = createPoller({ dex: "xyz", store, log: () => {}, version: "test", crypto: false });
  const now = Date.now(), DAY_ = 86400000, HOUR_ = 3600000;
  const daily = zigDaily(ZIG_PTS.concat([118]), 8, now - 88 * DAY_, DAY_);
  const px = daily[daily.length - 1].c;
  const hourly = Array.from({ length: 40 * 24 }, (_, i) =>
    ({ t: now - (40 * 24 - 1 - i) * HOUR_, o: px, h: px * 1.002, l: px * 0.998, c: px, v: 1000 }));
  p.seedRowNow("xyz:NVDA", { px, d1: 1.2, funding: 0.00001, vol: 5e7, oi: 2e7,
    ref: { p1h: px * 0.999, p4h: px * 0.996, p7d: px * 0.94, p30d: px * 0.85 },
    dailyRaw: daily, hourlyRaw: hourly, dailyTs: now, hourlyTs: now, isNew: false });
  return { p, px, now };
}

// ============================================================================================
// Structural-level outcome study (build 2026.07.24-10). detectLevels already decides which levels
// this app draws and which levels an AI void may snap to (AI_SNAP_TOL); nothing measured whether
// they hold. These pin the measurement AND, critically, pin the null: an earlier revision compared
// touch rates to the continuous first-passage formula 2(1-phi(d/sqrt(h))) and reported that levels
// REPEL price on pure random walks, because a bar-bracketing touch test under-detects a gappy tape
// relative to continuous monitoring. The permutation control replaced it. The unbiasedness test
// below is the guard that stops that class of bug from ever shipping as a finding again.
// ============================================================================================
const { normCdf, touchBaseline, studyBars, levelOutcomes, levelStudy, LVL_EDGES, PLACEBO_K } = require("../src/compute");

// deterministic tape generator shared by the study tests (no PRNG dependency, seeded LCG)
function _walk(seed, n, vol) {
  let s = seed;
  const rnd = () => { s = (s * 1103515245 + 12345) & 0x7fffffff; return s / 0x7fffffff; };
  const nrm = () => { let u = 0, v = 0; while (!u) u = rnd(); while (!v) v = rnd(); return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v); };
  const d = []; let px = 100;
  for (let i = 0; i < (n || 500); i++) {
    px *= 1 + nrm() * (vol || 0.018);
    const h = px * (1 + Math.abs(nrm()) * 0.007), l = px * (1 - Math.abs(nrm()) * 0.007);
    d.push({ t: 1.7e12 + i * 864e5, h: Math.max(h, px), l: Math.min(l, px), c: px });
  }
  return d;
}

// ============================================================================================
// Session anatomy (build 2026.07.24-11): per-UTC-day records off the hourly spine feeding four
// descriptive studies — excursion from open, open-quartile splits, Monday-range containment,
// naked-open revisits. Descriptive base rates with day-pooled honesty; nothing here is a signal.
// ============================================================================================
const { sessionRecords, anatomyEnrich, mondayStats, nakedStats, anatomyPool, MFE_EDGES, NAKED_HORIZONS } = require("../src/compute");

// ============================================================================================
// Ledger shadow pair (build 2026.07.24-12): outsized-wick fill + round-figure front-run. Both
// ship as vi=0 shadows — no UI surface, no in-sample study, records earned purely out of sample
// through the existing rearm/resolver machinery. These pin the frozen geometry and the refusals.
// ============================================================================================
const { detectWickFill, detectRoundFront, roundStep } = require("../src/compute");

// ============================================================================================
// Candle behaviour + time-based pivots + per-ticker scopes (build 2026.07.24-13).
// ============================================================================================
const { candleType, candleEvents, candlePool, pivotPool, anatomyTickerSummary, CANDLE_TYPES, PIVOT_EARLY_H } = require("../src/compute");

// ===== drawSessions execution smoke test (the -17 "warming up the spines" regression) ==========
// WHY THIS EXISTS: -17 shipped with the `const groups =` declaration accidentally deleted from
// drawSessions. The orphaned `sgSection(...)+...;` chain below it is still a VALID expression
// statement, so `node --check` passed, and every sessions test we had pinned only names/strings —
// so the whole suite went green while drawSessions threw ReferenceError at runtime for BOTH
// universes, leaving the tab frozen on its pre-fetch "warming up the spines" text with no error.
// String pins cannot catch an undeclared variable. This test EXECUTES the real renderer against a
// full payload and asserts actual markup comes out.
function _sessDomStub() {
  const els = {};
  const mk = (id) => ({ id, innerHTML: "", textContent: "", value: "", hidden: false, checked: false, dataset: {},
    style: { setProperty() {}, removeProperty() {} },
    classList: { toggle() {}, add() {}, remove() {}, contains() { return false; } },
    addEventListener() {}, removeEventListener() {}, querySelectorAll() { return []; }, querySelector() { return null; },
    appendChild() {}, removeChild() {}, insertBefore() {}, remove() {}, setAttribute() {}, getAttribute() { return null; },
    removeAttribute() {}, closest() { return null; }, focus() {}, blur() {}, click() {}, scrollIntoView() {},
    contains() { return false; }, getBoundingClientRect() { return { left: 0, top: 0, right: 600, bottom: 300, width: 600, height: 300 }; },
    children: [], parentNode: null, firstChild: null, offsetWidth: 600, offsetHeight: 300 });
  return { els, mk };
}
function _sessPayload(isCrypto) {
  const live = { n: 40, totNet: 0.031, totGross: 0.042, winNet: 0.56, curve: [[Date.now() - 86400e3, 1, 1], [Date.now(), 1.03, 1.02]], fundingHorizonTs: Date.now() - 86400e3 };
  return { scope: isCrypto ? "crypto" : "stocks", tz: isCrypto ? "UTC" : "ET", isCrypto: !!isCrypto,
    ts: Date.now(), dataTs: 7,
    window: { hourlyDays: isCrypto ? 90 : 180, fundingDays: isCrypto ? 31 : 60 },
    coverage: { hourly: { coins: 148, candles: 900000 }, funding: { coins: 140, points: 50000, endpoint: "on" },
      markets: isCrypto ? 60 : 84, equityMarkets: isCrypto ? 60 : 84, ready: isCrypto ? 60 : 84, readyHours: 480 },
    universe: [{ coin: isCrypto ? "BTC" : "xyz:NVDA", ticker: isCrypto ? "BTC" : "NVDA", sector: isCrypto ? "Crypto" : "Tech", assetClass: isCrypto ? "Crypto" : "Equity", hours: 2160, funding: 700 }],
    sections: {
      regime: { now: Date.now(), days: 60,
        all: { names: 148, series: [[Date.now(), 4.4e10, 8.8]], crowd: { netFundApr: 8.8, longExtPct: 12, shortExtPct: 8, netCrowd: 4, pctNames: 100 }, lev: { totalOi: 4.4e10, oiZ: 0.58, oi7dPct: 1.6, oi30dPct: 40, oiVol: 6.06 } },
        crypto: { names: 60, pending: true }, stocks: { names: 84, pending: true } },
      sessionDecomp: isCrypto
        ? { isCrypto: true, window: { start: 0, end: 1, days: 90 }, equityCount: 60, fundingEndpoint: "on",
            sessions: { utcday: live, weekend: live },
            headline: { medianNet: 0.001, medianGross: 0.0012, meanNet: 0.001, meanGross: 0.0013, totNet: 0.03, totGross: 0.04, winNet: 0.55, nights: 90, fundingHorizonTs: Date.now() - 86400e3 } }
        : { isCrypto: false, window: { start: 0, end: 1, days: 180 }, equityCount: 84, fundingEndpoint: "on",
            sessions: { overnight: live, weekend: live, cash: live },
            headline: { medianNet: 0.001, medianGross: 0.0012, meanNet: 0.001, meanGross: 0.0013, totNet: 0.03, totGross: 0.04, winNet: 0.55, nights: 120, fundingHorizonTs: Date.now() - 86400e3 } },
      hourClock: { pending: true, count: 1 }, dow: { pending: true, count: 1 }, clusters: { pending: true, count: 1 },
      seasonality: isCrypto ? { pending: true, notApplicable: true, count: 0 } : { pending: true, count: 1 },
      levels: { pending: true, count: 1 }, anatomy: { pending: true, count: 1 } } };
}

const ACT_TIP_COLS = ["ago", "fired", "entry", "late", "void", "target", "rr", "evR", "rec"];

// Shared fixture: a resolved out-of-sample record for `tretest`, sufficient to clear the
// CONFIRMED gate (n >= 8, avg > 0). Without this, NOTHING reaches the board or the trigger stream
// — which is the gate working, but makes announce/dedup untestable, so the record is seeded.
function actClosedRecord(coin, n, realized) {
  const out = [];
  for (let i = 0; i < (n || 10); i++) out.push({ key: coin + "|tretest#h" + i, coin, ticker: "TRSIG",
    ev: "tretest", status: "resolved", realized: realized == null ? 1.4 : realized,
    t0: Date.now() - (60 + i) * 86400e3, tR: Date.now() - (55 + i) * 86400e3, psd: "long", pn: 1 });
  return out;
}

// Shared harness: a poller with an injected transport that records every call and replays queued
// responses. No network, no timers — every tick is driven explicitly.
function pushHarness(responses) {
  const { createPoller } = require("../src/poller");
  const calls = [];
  let saved = null;
  const queue = (responses || []).slice();   // mutable: tests push replies after minting a real code
  const store = { loadAll: () => new Map(), loadRegime: () => [], loadLedger: () => null, saveLedger: () => {},
    insert: () => {}, saveRegime: () => {}, loadTriggers: () => null, saveTriggers: () => {},
    savePush: (d) => { saved = d; }, loadPush: () => saved };
  const pushFetch = async (url, opts) => {
    calls.push({ url, body: JSON.parse((opts && opts.body) || "{}") });
    const r = queue.length ? queue.shift() : { ok: true, result: {} };
    return { ok: r.status == null || (r.status >= 200 && r.status < 300), status: r.status || 200,
      json: async () => (r.body != null ? r.body : { ok: true, result: r.result != null ? r.result : {} }) };
  };
  const p = createPoller({ dex: "xyz", store, log: () => {}, version: "test", crypto: false, pushFetch });
  return { p, calls, queue, store: { get saved() { return saved; } } };
}

function ruleHarness() {
  const { createPoller } = require("../src/poller");
  let saved = null;
  const store = { loadAll: () => new Map(), loadRegime: () => [], loadLedger: () => null, saveLedger: () => {},
    insert: () => {}, saveRegime: () => {}, loadTriggers: () => null, saveTriggers: () => {},
    saveRules: (d) => { saved = d; }, loadRules: () => saved };
  const p = createPoller({ dex: "xyz", store, log: () => {}, version: "test", crypto: false });
  return { p, get saved() { return saved; } };
}

function ctxHarness() {
  const { createPoller } = require("../src/poller");
  const store = { loadAll: () => new Map(), loadRegime: () => [], loadLedger: () => null, saveLedger: () => {},
    insert: () => {}, saveRegime: () => {}, loadTriggers: () => null, saveTriggers: () => {} };
  return createPoller({ dex: "xyz", store, log: () => {}, version: "test", crypto: false });
}

// A full, realistic brief context. Every test below starts from this and removes what it wants to
// prove is optional — the shape here IS the contract between poller assembly and the renderer.
function BRIEF_CTX() {
  return {
    at: Date.UTC(2026, 6, 28, 10, 0), tz: -180, build: "test",
    bench: { stocks: { t: "SPX", d1: 0.4 }, crypto: { t: "BTC", d1: -0.4 } },
    indices: [{ t: "NDX", d1: 0.9 }, { t: "SPX", d1: 0.4 }, { t: "RUT", d1: -0.6 }, { t: "VIX", px: 14.2, d1: -0.8, level: 1 }],
    commodities: [{ t: "GOLD", d1: 0.3 }, { t: "WTI", d1: -2.4 }],
    fx: [{ t: "DXY", d1: 0.12 }],
    baskets: [{ name: "MAG7", med: 1.4, up: 43, n: 7 }],
    sectors: [{ name: "TECH", label: "TECH", med: 1.8, n: 12, up: 66 },
      { name: "ENERGY", label: "ENERGY", med: -1.6, n: 5, up: 20 },
      { name: "SEMICONDUCTO", label: "Semiconductors", kind: "industry", med: 2.1, n: 9, up: 77 }],
    movers: { stocks: { up: [{ t: "MU", d1: 4.8, rel: 4.4, note: "HBM sold out" }], down: [{ t: "ENPH", d1: -5.2, rel: -5.6, note: null }] },
      crypto: { up: [{ t: "HYPE", d1: 6.1, rel: 6.5, note: null }], down: [{ t: "ARB", d1: -8.4, rel: -8, note: null }] } },
    regime: { stocks: { breadth: 48, d7: 56, d30: 63, decaying: true, ma200: 74, corr: 0.34, disp: 1.8 },
      crypto: { breadth: 29, d7: 34, d30: 41, decaying: true, ma200: 38, corr: 0.74, corrUp: true, disp: 4.1 } },
    positioning: { crypto: { netFundApr: -9, negN: 9, oiChg: 6 }, stocks: { oiChg: 7 } },
    earnings: { printed: [{ t: "ENPH", res: "miss" }], today: [{ t: "MSFT" }], tomorrow: [{ t: "AMD" }] },
    macro: { next: [{ when: "Wed 14:00", label: "FOMC minutes", prior: null }],
      rates: [{ k: "10y", v: "4.18", chg: "+6bp w/w" }], data: [{ k: "Claims", v: "231k" }] },
    news: [{ sector: "Semis", items: [{ t: "MU", h: "HBM sold out through 2027" }] }],
  };
}

// Behavioral render, not existence pins. The first version of these controls lived inside the
// recipients accordion, which ships collapsed — the markup was correct and the operator could not
// see any of it. String pins like app.includes('id="adm-brief"') passed the whole time, because a
// pin proves a string is in the file, not that it ever reaches the screen. These execute the real
// functions against a real payload and assert the markup emerges.
function ADM_DOM() {
  const mk = (id) => ({ id, hidden: false, innerHTML: "", textContent: "", disabled: false,
    querySelector: () => ({ textContent: "" }), querySelectorAll: () => [], addEventListener() {} });
  const nodes = { admBriefBox: mk("admBriefBox"), admRecB: mk("admRecB"), admRecH: mk("admRecH"),
    admRecN: mk("admRecN"), "adm-brief": mk("adm-brief"), "adm-brief-f": mk("adm-brief-f"), "adm-brief-r": mk("adm-brief-r") };
  return nodes;
}
function ADM_PUSH(over) {
  return Object.assign({ admin: true, capHour: 6, classes: ["setup", "ops"], defaultClasses: ["setup"], adminClasses: ["ops"],
    brief: { enabled: true, defaultHour: 10, perDay: 6, dayLeft: 5, model: "gpt-5.6-terra", lastErr: null },
    // The registry the panel renders from. Shipped by getPush; the chips are derived from it, so a
    // fixture without it renders no chips at all — which is exactly what this fixture caught.
    schedKinds: [{ k: "brief", label: "Morning brief", defaultHour: 10, tip: "the daily brief" }],
    recipients: [{ chat: "111", mask: "1**1", name: "Milst", admin: true, mine: true, owned: true, muted: false,
      lastErr: null, classes: null, sentHour: 0, briefHour: 10, briefUtc: 1, briefTz: 0, briefTzKnown: 0, quiet: null, trig: {},
      sched: { brief: { hour: 10, days: null, dflt: 1, daysLabel: "daily", utc: 1 } } }] }, over || {});
}
function runAdmFn(name, nodes, pushState, openRec) {
  const fs = require("fs"), path = require("path");
  const src = require("./_client").clientSource();
  const grab = (fn, until) => src.slice(src.indexOf(fn), src.indexOf(until));
  const body = name === "renderAdmBrief"
    ? grab("function renderAdmBrief()", "function renderAdmin()")
    : grab("function renderAdmRecips()", "function renderAdmBrief()");
  const f = new Function("el", "esc", "pushState", "pushAct", "admRecOpen", "IS_ADMIN", "fetch", "nodes",
    body + `; ${name}(); return nodes;`);
  return f((id) => nodes[id] || null, (x) => String(x == null ? "" : x), pushState,
    async () => ({}), openRec || {}, true, () => ({ then: () => ({ then: () => ({ catch: () => ({ finally: () => {} }) }) }) }), nodes);
}

// ===== Per-person alerts (build 2026.07.27-08) ==================================================
// The hole this closes: alert delivery was designed per-person, but the app has one shared site
// password and no user accounts, so there was no "person" for the management surface to scope to.
// The first Telegram linked became a global row every visitor could see, and rules were a single
// shared list. Ownership is now a signed, unguessable per-browser handle; admin overrides.

function twoUserHarness() {
  const { createPoller } = require("../src/poller");
  let saved = null, savedRules = null;
  const store = { loadAll: () => new Map(), loadRegime: () => [], loadLedger: () => null, saveLedger: () => {},
    insert: () => {}, saveRegime: () => {}, loadTriggers: () => null, saveTriggers: () => {},
    savePush: (d) => { saved = d; }, loadPush: () => saved,
    saveRules: (d) => { savedRules = d; }, loadRules: () => savedRules };
  const p = createPoller({ dex: "xyz", store, log: () => {}, version: "test", crypto: false,
    pushFetch: async () => ({ ok: true, status: 200, json: async () => ({ ok: true, result: {} }) }) });
  return p;
}

function trendHarness() {
  const { createPoller } = require("../src/poller");
  const store = { loadAll: () => new Map(), loadRegime: () => [], loadLedger: () => null, saveLedger: () => {},
    insert: () => {}, saveRegime: () => {}, loadTriggers: () => null, saveTriggers: () => {},
    saveRules: () => {}, loadRules: () => null };
  const p = createPoller({ dex: "xyz", store, log: () => {}, version: "test", crypto: false });
  p.seedRowNow("CU", { ticker: "COPPER", px: 6.39, uni: "xyz", ref: { p1h: 6.3, p4h: 6.3, p7d: 6.3, p30d: 6.3 } });
  p.trendPrimeNow();
  return p;
}

// Closed-ladder override for the harness: seedTrendNow carries it as DATA on the board read (the
// scan prefers tb.closed over rebuilding from candles), so episode gates are testable without
// manufacturing 26-bar histories. `score` rungs align top-down; closeAt sits just behind the scan
// clock the caller passes, like a real close would.
function clOf(score, t, opts) {
  const o = opts || {};
  const tfs = ["D1", "H12", "H4", "H1"], tfSt = {}, closeAt = {};
  tfs.forEach((tf, i) => { tfSt[tf] = i < score ? "up" : "roll"; closeAt[tf] = t - 60e3; });
  return { sign: o.sign != null ? o.sign : 1, closeAt,
    tf: { D1: { st: tfSt.D1 }, H12: { st: tfSt.H12 }, H4: { st: tfSt.H4 }, H1: { st: tfSt.H1 } },
    long: { score, retest: o.retest || null }, short: { score: 0, retest: null } };
}

// ===== ma200 alert lane (build 2026.07.27-32) ==================================================
// The 200-EMA notification class: reclaim / breakdown / bullish + bearish retest on H4 and D1,
// close-confirmed on the rung's own candle, full roster. The detector IS the -26/-28 vocabulary
// (buffered cross, far-side arm, clear-air retest) so the alert and the study cannot disagree.

// Daily fixture builder: `spec` maps bar index offsets FROM THE END to overrides; base is a
// gently alternating series (nonzero ret sigma) around `lvl` so the 200-EMA seeds near it.
function maDaily(n, lvl, spec, t0) {
  const DAYMS = 86400e3;
  const bars = [];
  for (let i = 0; i < n; i++) {
    const c = lvl * (1 + (i % 2 ? 0.004 : -0.004));
    bars.push({ t: t0 + i * DAYMS, c, h: c, l: c });
  }
  for (const k in (spec || {})) {
    const idx = n - 1 - (+k);
    bars[idx] = Object.assign({}, bars[idx], spec[k], { t: bars[idx].t });
  }
  return bars;
}
function maSd(bars) {
  const C = require("../src/compute");
  return C.retStd(C.dailyRets(bars.map((b) => [b.t, b.c])).slice(-90), 15);
}

// One poller, one confirmed board row, full episode lifecycle. Mirrors the actionable -10 seed
// (10 resolved winners -> the tretest claim confirms) so the settled record is exercised against
// the same machinery the live board runs, not a synthetic shortcut.
async function settledPoller() {
  const { createPoller } = require("../src/poller");
  const COIN = "xyz:SETL";
  const saved = [];
  const closed = [];
  for (let i = 0; i < 10; i++)
    closed.push({ key: COIN + "|tretest#h" + i, coin: COIN, ticker: "SETL", ev: "tretest", status: "resolved",
      realized: 1.4, t0: Date.now() - (60 + i) * 86400e3, tR: Date.now() - (55 + i) * 86400e3, psd: "long", pn: 1 });
  const store = { loadAll: () => new Map(), loadRegime: () => [], insert: () => {}, saveRegime: () => {},
    saveLedger: (b) => saved.push(b), loadLedger: () => ({ ts: Date.now(), open: [], closed }),
    saveTriggers: () => {}, loadTriggers: () => null };
  const p = createPoller({ dex: "xyz", store, log: () => {}, version: "test", crypto: false });
  const now = Date.now(), HOUR_ = 3600e3, DAY_ = 86400e3, endH = Math.floor(now / HOUR_), N = 16 * 24;
  const hourly = [];
  for (let i = 0; i < N; i++) { const t = (endH - N + i) * HOUR_, c = 100 * Math.pow(1.0005, i);
    hourly.push({ t, o: c, h: c * 1.001, l: c * 0.999, c, v: 1 }); }
  const px = hourly[N - 1].c * 1.0005, daily = [];
  for (let i = 0; i < 60; i++) { const c = px * Math.pow(1.002, i - 59);
    daily.push({ t: (Math.floor(now / DAY_) - 60 + i) * DAY_, c, l: c * 0.97, h: c * (i === 50 ? 1.35 : 1.002) }); }
  p.seedRowNow(COIN, { px, ticker: "SETL", uni: "xyz", vol: 1e6, funding: 0.00005, hourlyRaw: hourly, dailyRaw: daily });
  p.hydrateLedgerNow(); p.buildTrendNow(); await p.buildSignalsNow(); await p.buildActionableNow();
  return { p, COIN, px, hourly, saved, HOUR_, DAY_, endH };
}

// ===== structural-void families (build 2026.07.28-01) ==========================================
// Four shadows testing one thesis: a claim fired next to a confirmed level does not need a
// sigma-wide constructed void — the level is the invalidation and the stop sits half a σ behind
// it. lvlhold/lvlrej are level-anchored entries (touch-resolved); squeeze2/unwind2 are twins of
// the sigma-construct incumbents, identical in trigger/target/clock, differing ONLY in the void —
// the stop-aware duel is the experiment. Nothing gates on the thesis; the ledger measures it.

// Shared tape builder: flat closes with confirmed pivot lows (support) and pivot highs
// (resistance/target), plus mild alternation so sd30 is real. Pivots sit far enough apart that
// their k=3 windows never overlap, and the alternation is period-2 so it can never mint a pivot
// (equal values fail detectLevels' strict comparison by construction).
function svBars(n, opts) {
  const o = opts || {}, DAY_ = 86400e3, t0 = Date.now() - (n + 5) * DAY_, base = o.base || 104;
  const bars = [];
  for (let i = 0; i < n; i++) {
    let c = base + (i >= n - 40 ? (i % 2 ? 0.4 : -0.4) : 0), h = c + 0.4, l = c - 0.4;
    if (o.supAt && o.supAt.includes(i)) { c = o.sup; l = o.sup; h = c + 0.4; }   // the cluster IS the low
    if (o.resAt && o.resAt.includes(i)) h = o.res;
    bars.push({ t: t0 + i * DAY_, c, h, l });
  }
  return bars;
}

// ===== phase 2: Δ vs ⬒ column, matrix basket rows, pair legs, backtest yardstick (build 2026.07.28-09)
// Every surface here EXECUTES on fixtures — the column math against a hand-computed EW mean, the
// matrix row against pearson's own answer, the pair view and the curve against real markup — and
// the tier boundary is re-pinned: r.dvb and the yardstick feed no rule engine, no alert, no stat.

function _p2Harness(){
  const fs = require("fs"), path = require("path");
  const app = require("./_client").clientSource();
  const els = {};
  const mk = (id) => ({ id, innerHTML: "", hidden: false, value: "", checked: false, textContent: "", style: {}, dataset: {},
    classList: { add() {}, remove() {}, toggle() {}, contains: () => false },
    querySelectorAll: () => [], querySelector: () => null, addEventListener() {}, appendChild() {}, removeChild() {},
    setAttribute() {}, getAttribute: () => null, focus() {}, scrollIntoView() {}, getBoundingClientRect: () => ({ left: 0, top: 0, width: 900, height: 300 }) });
  const saved = { si: global.setInterval, st: global.setTimeout, raf: global.requestAnimationFrame,
    doc: global.document, win: global.window, ls: global.localStorage, f: global.fetch,
    ct: global.clearTimeout, ci: global.clearInterval };
  global.setInterval = () => 0; global.setTimeout = () => 0; global.requestAnimationFrame = () => 0;
  global.clearTimeout = () => 0; global.clearInterval = () => 0;
  global.document = { getElementById: (id) => (els[id] = els[id] || mk(id)), querySelectorAll: () => [], querySelector: () => null,
    createElement: mk, addEventListener() {}, body: mk("body"), documentElement: mk("html"), hidden: false };
  global.window = { addEventListener() {}, location: { reload() {}, href: "/", hash: "" }, matchMedia: () => ({ matches: false, addEventListener() {} }), __FLAGS: { baskets: true }, __ADMIN: true };
  global.localStorage = { _d: {}, getItem(k) { return this._d[k] ?? null; }, setItem(k, v) { this._d[k] = String(v); }, removeItem(k) { delete this._d[k]; } };
  global.fetch = () => new Promise(() => {});
  const api = new Function(app + "\n;return {state, BASKETS, COMPG, CORR, computeDvb, dvbBasketDef, basketVirtualRow, corrBasketRows, buildCorr, renderPairPanel, btCurveSvg, dailyReturns, hoverReg:_hoverReg};")();
  const restore = () => { global.setInterval = saved.si; global.setTimeout = saved.st; global.requestAnimationFrame = saved.raf;
    global.clearTimeout = saved.ct; global.clearInterval = saved.ci;
    global.document = saved.doc; global.window = saved.win; global.localStorage = saved.ls; global.fetch = saved.f; };
  return { api, els, restore };
}

// ---- brief robustness audit: the three bugs that reached a phone, each pinned behaviourally ----
// All three were the same failure — a read against a field nobody proved existed, or a value nobody
// proved was in range. Existence pins would not have caught any of them, so these execute.
function briefAuditHarness() {
  const { createPoller } = require("../src/poller");
  const store = { loadAll: () => new Map(), loadRegime: () => [], loadLedger: () => null, saveLedger: () => {},
    insert: () => {}, saveRegime: () => {}, loadTriggers: () => null, saveTriggers: () => {} };
  const p = createPoller({ dex: "xyz", store, log: () => {}, version: "test", crypto: true });
  const DAY = 86400000, now = Date.now();
  // 220 daily candles so the EMA200 is genuinely computable, and deliberately irrational prices so
  // any unrounded derived value shows its full precision rather than hiding behind a round number.
  const mk = (i, uni) => {
    const px = 100 + i * 7.3333333, daily = [];
    for (let k = 220; k >= 0; k--) daily.push({ t: now - k * DAY, c: px * (1 + Math.sin(k + i) / 30), o: px * 0.999 });
    return { ticker: (uni === "xyz" ? "EQ" : "C") + i, uni, px,
      d1: (i % 7) - 3 + 0.3333333, ref: { p7d: px / 1.0333333, p30d: px / 1.0777777, p1d: px / 1.0166666 },
      funding: 0.0000123456, doi: 3.3333333 + i, dailyRaw: daily };
  };
  for (let i = 0; i < 14; i++) p.seedRowNow("EQ" + i, mk(i, "xyz"));
  for (let i = 0; i < 14; i++) p.seedRowNow("C" + i, mk(i + 2, "main"));
  return { p, now, DAY };
}

// The aggregation engine, executed for real (the -84 lesson: string pins prove presence, not
// behavior). computeMktGroups is deliberately dependency-free, so the extracted source runs as-is.
function mktGroupsFn() {
  const fs = require("fs"), path = require("path");
  const app = require("./_client").clientSource();
  const a = app.indexOf("function computeMktGroups"), b = app.indexOf("function mktGroupCohesion");
  assert.ok(a >= 0 && b > a, "computeMktGroups must precede mktGroupCohesion for extraction");
  return new Function(app.slice(a, b) + "; return computeMktGroups;")();
}
function mktGroupsFixture() {
  return [
    { coin: "xyz:NVDA", ticker: "NVDA", sector: "Information Technology", ind: "Semiconductors", assetClass: "Equity",
      px: 100, vol: 300, oi: 10, d1: 3, h1: 1, h4: 2, d7: 5, d30: 10, dopen: 2, doi: 4, rvol: 1.5, mopen: 90, yopen: 80 },
    { coin: "xyz:AMD", ticker: "AMD", sector: "Information Technology", ind: "Semiconductors", assetClass: "Equity",
      px: 200, vol: 100, oi: 5, d1: -1, h1: -0.5, h4: 0.5, d7: 2, d30: null, dopen: -0.5, doi: -2, rvol: 0.8, mopen: null, yopen: 180 },
    { coin: "xyz:ORCL", ticker: "ORCL", sector: "Information Technology", assetClass: "Equity",   // no curated ind -> sector fallback
      px: 50, vol: 0, oi: 2, d1: 2, h1: 0.2, h4: 0.4, d7: 1, d30: 4, dopen: 1, doi: 1, rvol: 1.0, mopen: 100, yopen: 40 },
    { coin: "xyz:XOM", ticker: "XOM", sector: "Energy", ind: "E&P/Majors", assetClass: "Equity",
      px: 120, vol: 50, oi: 20, d1: 2.4, h1: 0.3, h4: 0.8, d7: 4.1, d30: 6.2, dopen: 1.1, doi: 4.8, rvol: 1.7, mopen: 115, yopen: 105 },
    { coin: "xyz:MYSTERY", ticker: "MYSTERY", px: 10, vol: 5, oi: 1, d1: 0.5 },                    // no sector at all -> Unclassified
  ];
}

// The client action math, executed from source (the -84 lesson): ACT_LEGS through the extraction
// marker is dependency-free by design, so the real shipped functions run against fixtures.
function actionMathFns() {
  const fs = require("fs"), path = require("path");
  const app = require("./_client").clientSource();
  const a = app.indexOf("const ACT_LEGS="), b = app.indexOf("// end action math");
  assert.ok(a >= 0 && b > a, "action math block must sit between ACT_LEGS and its extraction marker");
  return new Function(app.slice(a, b) + "; return { ACT_LEGS, accelPace, heatOf, pickAction, shareDeltaPp, groupHeatOf, bidPhrase, chipStory };")();
}

// ============================================================================================
// FOCUS tab (build 2026.08.15-01): frozen-at-open 6-seat tradeable watchlist.
// Behavioral tests execute the real selection and first-hour math (-84 doctrine: string pins
// prove nothing about behavior); manifest pins then hold the wiring in place.
// ============================================================================================
const { focusSelect, focusScore, focusGapSigma, focusLevelDist, firstHourStats: fhStats,
  FOCUS_CAP, FOCUS_PER_CLUSTER } = require("../src/compute");

// ============================================================================================
// FOCUS -02: the 09:00 preview pool, the TG news lane, and the stamp-vs-preview disclosure.
// ============================================================================================
const { focusPreview, focusDiff, FOCUS_PREVIEW_N } = require("../src/compute");

// ============================================================================================
// FOCUS forming reads (build 2026.08.17-03): live +1h columns between the stamp and the freeze.
// ============================================================================================
const { foldLiveMark } = require("../src/compute");

// The 10:30 freeze fired the instant the clock reached open+1h and captured whatever the 1m writer
// had flushed — 59 of 60 minutes, recorded as `bars: 59`, frozen forever.
function focus07LaneRig() {
  const { createPoller } = require("../src/poller");
  const base = { loadAll: () => new Map(), loadRegime: () => [], loadLedger: () => null,
    saveLedger: () => {}, insert: () => {}, saveRegime: () => {}, saveNews: () => {}, loadNews: () => null };
  const OPEN = Date.UTC(2026, 7, 14, 13, 30), M = 60000;
  const bars = []; for (let i = 0; i < 60; i++) bars.push([OPEN + i * M, 100, 106, 94, 101, 1000]);
  const lane = { posted: 59 };            // how many 1m bars the writer has actually flushed
  const store = { ...base, saveFocus: () => {}, loadFocus: () => null, candlesEnabled: () => true,
    readCandles: () => [], readCandles1m: (c, lo, hi) => bars.slice(0, lane.posted).filter((k) => k[0] >= lo && k[0] <= hi) };
  const p = createPoller({ dex: "xyz", store, log: () => {}, version: "test" });
  const spine = (px) => { const o = []; for (let i = 48; i >= 0; i--) o.push({ t: OPEN - i * 3600e3, o: px, h: px * 1.01, l: px * 0.99, c: px, v: 1e6 }); return o; };
  for (const [t, px] of [["BE", 100], ["NVDA", 900], ["MU", 100], ["AMD", 150], ["LLY", 800],
    ["TSLA", 300], ["XOM", 110], ["JPM", 200], ["COIN", 250], ["PLTR", 60]])
    p.seedRowNow("xyz:" + t, { ticker: t, uni: "xyz", px, vol: 9e6, oi: 9e6, oiBase: 1000, hourlyRaw: spine(px) });
  p.focusTickNow(OPEN + 5 * M);
  return { p, OPEN, M, lane };
}

// ============================================================================================
// FOCUS -04 (build 2026.08.18-03): operator-set liquidity floors.
// "Anything under X is untradeable at my size." Two walls (24h notional, open interest) applied
// at CANDIDATE ASSEMBLY, before loudness is ever compared, so the 09:00 preview and the 09:30
// stamp meet the identical filter. Behavioral tests execute the real gate and the real stamp
// path against seeded universes (-84 doctrine); manifest pins then hold the wiring.
// ============================================================================================
const { focusLimits, focusFloorFail, focusGate, FOCUS_HARD_VOL, FOCUS_HARD_OI, FOCUS_BELOW_N } = require("../src/compute");

// ---- engine harness: the floors against the REAL stamp path ---------------------------------
// Seeded universe -> real focusTick -> real focusCandidates -> real focusGate -> real focusSelect.
// Ticker choice is load-bearing: classification resolves off the real sector map, so a made-up
// symbol is dropped as non-Equity before the wall is ever consulted and would silently prove
// nothing about the gate.
function focus04Rig(cfg, opts) {
  const { createPoller } = require("../src/poller");
  const base = { loadAll: () => new Map(), loadRegime: () => [], loadLedger: () => null,
    saveLedger: () => {}, insert: () => {}, saveRegime: () => {}, saveNews: () => {}, loadNews: () => null };
  let saved = null;
  const p = createPoller({ dex: "xyz", version: "test", log: () => {},
    store: { ...base, saveFocus: (d) => { saved = d; }, loadFocus: () => (opts && opts.load ? opts.load : null) } });
  const OPEN = Date.UTC(2026, 7, 14, 13, 30), H = 3600 * 1000;   // Fri 2026-08-14, 09:30 ET
  const spine = (px) => { const o = []; for (let i = 48; i >= 0; i--) o.push({ t: OPEN - i * H, o: px, h: px * 1.01, l: px * 0.99, c: px, v: 1e6 }); return o; };
  Object.entries(cfg).forEach(([t, [vol, oi]], i) =>
    p.seedRowNow("xyz:" + t, { ticker: t, uni: "xyz", px: 100 + i, vol, oi, oiBase: 1000, hourlyRaw: spine(100 + i) }));
  return { p, OPEN, saved: () => saved };
}
const FOCUS04_FULL = { NVDA: [9e6, 5e6], MU: [9e6, 5e6], AMD: [9e6, 5e6], LLY: [9e6, 5e6], TSLA: [9e6, 5e6],
  XOM: [9e6, 5e6], JPM: [9e6, 5e6], COIN: [9e6, 1e5], PLTR: [9e6, null], SNOW: [3e5, 9e6] };
// GRADED depths, for the tests where the wall has to actually bite: only three names sit above
// $20M, the rest are ordinary names an institutional clip cannot work. A flat fixture would let a
// "strict" wall pass everything and the test would assert nothing.
const FOCUS04_GRADED = { NVDA: [40e6, 9e6], MU: [30e6, 9e6], AMD: [22e6, 9e6], LLY: [9e6, 9e6],
  TSLA: [8e6, 9e6], XOM: [6e6, 9e6], JPM: [5e6, 9e6], COIN: [4e6, 1e5], PLTR: [9e6, null], SNOW: [3e5, 9e6] };

// ================================================================================================
// FOCUS chart: session-scoped VWAP and frozen geometry (build 2026.08.19-04)
// ------------------------------------------------------------------------------------------------
// The reported defect: a session's VWAP and its frozen 1H HI/LO kept drawing after that session had
// closed — the blue line accumulated straight through the overnight into the next pre-market, and
// the dashed lines spanned the full 72h in BOTH directions, including hours before the range they
// describe existed. These tests execute the real client functions against real bar fixtures; a
// string pin would have passed the whole time the bug was on screen (the -84 lesson).
// ================================================================================================
const FOCCH_SRC = (() => {
  const fs = require("fs"), path = require("path");
  const app = require("./_client").clientSource();
  const grab = (name) => {
    const i = app.indexOf("function " + name + "(");
    assert.ok(i > -1, name + " present in app.js");
    let d = 0;
    for (let k = app.indexOf("{", i); k < app.length; k++) {
      if (app[k] === "{") d++; else if (app[k] === "}") { d--; if (!d) return app.slice(i, k + 1); }
    }
    throw new Error("unbalanced " + name);
  };
  return { app, grab };
})();
// One fixture, shared: a 5m tape running Monday night -> Tuesday cash -> Tuesday night -> Wednesday
// pre-market -> Wednesday cash. Frozen clock (wall-clock independence): every boundary is derived
// from these constants, never from Date.now().
const FOCCH_FIX = (() => {
  const M = 60000, H = 3600000;
  const tueOpen = Date.UTC(2026, 7, 18, 13, 30);           // 09:30 ET
  const tueClose = tueOpen + 6.5 * H;                       // 16:00 ET
  const wedOpen = tueOpen + 24 * H, wedClose = tueClose + 24 * H;
  const sessions = [{ open: tueOpen, close: tueClose }, { open: wedOpen, close: wedClose }];
  // 5m bars from 12h before Tuesday's open to 1h after Wednesday's open. Price and volume vary per
  // bar so a VWAP that failed to reset would land on a visibly different number than one that did.
  const base = [];
  for (let t = tueOpen - 12 * H; t <= wedOpen + 1 * H; t += 5 * M) {
    const i = (t - (tueOpen - 12 * H)) / (5 * M);
    const px = 100 + (i % 17), vol = 10 + (i % 7);
    base.push([t, px, px + 1, px - 1, px, vol]);
  }
  return { M, H, tueOpen, tueClose, wedOpen, wedClose, sessions, base };
})();
function focchApi(sessions, day, tf) {
  const { grab } = FOCCH_SRC;
  const src = grab("focChartSessions") + "\n" + grab("focSessIdx") + "\n" + grab("focSessSpan") + "\n"
    + grab("focRuns") + "\n" + grab("focAgg") + "\n" + grab("focAggCached");
  const FOC = { data: sessions ? { sessions } : {} };
  const FOCCH = { tf, day, base: FOCCH_FIX.base, agg: null };
  const api = new Function("FOC", "FOCCH", src
    + "\n;return { focChartSessions, focSessIdx, focSessSpan, focRuns, focAgg, focAggCached, FOCCH };")(FOC, FOCCH);
  return api;
}

// ================================================================================================
// FOCUS: session OPEN / CLOSE columns + touch reorder (build 2026.08.19-05)
// ------------------------------------------------------------------------------------------------
// The close is the one number on this board that CANNOT be shown early: it is a measurement of a
// finished session, and the live price is not a stand-in for it. These tests execute the real close
// read, the real fill gate and the real column builders — the failure mode being guarded against is
// a close column that quietly renders the after-hours tape, or the live mark, as "the 16:00 print".
// ================================================================================================
function focus05CloseRig(opts) {
  const o = opts || {};
  const { createPoller } = require("../src/poller");
  const base = { loadAll: () => new Map(), loadRegime: () => [], loadLedger: () => null,
    saveLedger: () => {}, insert: () => {}, saveRegime: () => {}, saveNews: () => {}, loadNews: () => null };
  const M = 60000, OPEN = Date.UTC(2026, 7, 14, 13, 30), CLOSE = OPEN + 390 * M;   // Fri 09:30 -> 16:00 ET
  // 390 in-session 1m bars walking 100 -> 139, then an AFTER-HOURS tape at a wildly different price.
  // If the close read is bounded by the session the after-hours bars can never reach the column; if
  // it is bounded by "the last bar before now" they will, and the test says so.
  const bars = [];
  for (let i = 0; i < 390; i++) { const px = 100 + i / 10; bars.push([OPEN + i * M, px, px + 0.5, px - 0.5, px, 1000]); }
  for (let i = 0; i < 60; i++) bars.push([CLOSE + i * M, 400, 401, 399, 400, 500]);
  const lane = { posted: o.posted == null ? 390 : o.posted };   // in-session bars the 1m writer has flushed
  const dark = o.dark || [];                                    // tickers whose lane landed nothing (mutable: the caller may darken a seat after the stamp)
  const store = { ...base, saveFocus: () => {}, loadFocus: () => null, candlesEnabled: () => o.archive !== false,
    readCandles: () => [],
    readCandles1m: (coin, lo, hi) => {
      if (dark.includes(String(coin).split(":")[1])) return [];
      return bars.slice(0, lane.posted).concat(bars.slice(390)).filter((k) => k[0] >= lo && k[0] <= hi);
    } };
  const p = createPoller({ dex: "xyz", store, log: () => {}, version: "test" });
  const spine = (px) => { const a = []; for (let i = 48; i >= 0; i--) a.push({ t: OPEN - i * 3600e3, o: px, h: px * 1.01, l: px * 0.99, c: px, v: 1e6 }); return a; };
  for (const [t, px] of [["BE", 100], ["NVDA", 900], ["MU", 100], ["AMD", 150], ["LLY", 800],
    ["TSLA", 300], ["XOM", 110], ["JPM", 200], ["COIN", 250], ["PLTR", 60]])
    p.seedRowNow("xyz:" + t, { ticker: t, uni: "xyz", px, vol: 9e6, oi: 9e6, oiBase: 1000, hourlyRaw: spine(px) });
  p.focusTickNow(OPEN + 5 * M);
  return { p, OPEN, CLOSE, M, lane, bars };
}

// ---- the two columns, executed ------------------------------------------------------------------
function focColsApi() {
  const fs = require("fs"), path = require("path");
  const app = require("./_client").clientSource();
  const grab = (name) => {
    const i = app.indexOf("function " + name + "(");
    assert.ok(i > -1, name + " present in app.js");
    let d = 0;
    for (let k = app.indexOf("{", i); k < app.length; k++) {
      if (app[k] === "{") d++; else if (app[k] === "}") { d--; if (!d) return app.slice(i, k + 1); }
    }
    throw new Error("unbalanced " + name);
  };
  const i0 = app.indexOf("const FOC_COLS=[");
  assert.ok(i0 > -1, "FOC_COLS present");
  const i1 = app.indexOf("\n];", i0);
  const cols = app.slice(i0, i1 + 3);
  const src = grab("esc") + "\n" + grab("focPx") + "\n" + grab("focSgn") + "\n" + grab("focCls") + "\n"
    + grab("focNa") + "\n" + grab("focDry") + "\n" + grab("focCol") + "\n" + grab("focMoveCol") + "\n" + cols;
  return new Function("FOC", "focChips", "liveMark", "focPrefsSave", src
    + "\n;return { FOC_COLS, focCol, focMoveCol };");
}
function focCols(FOC, saved) {
  return focColsApi()(FOC, () => "", () => null, () => { if (saved) saved.n++; });
}

// ===== Backtest target picker + single-asset mode (build 2026.08.22) ============================
// The tab could only ever test a cross-section. Picking ONE name collapses that cross-section, so
// this suite EXECUTES the new engine on fixtures rather than pattern-matching the source: the
// position must come from the score's own sign, the entry threshold must actually keep it flat,
// long-only must never short, costs must bite, and the buy & hold line must equal an independent
// recomputation of the name's own returns. The manifest assertions at the end pin only the things
// no fixture can catch — that picks supersede the universe select, and that the σ the entry
// threshold is quoted in never sees a future day.

function _btHarness(){
  const fs = require("fs"), path = require("path");
  const app = require("./_client").clientSource();
  const els = {};
  const mk = (id) => ({ id, innerHTML: "", hidden: false, value: "", checked: false, textContent: "", style: {}, dataset: {},
    classList: { add() {}, remove() {}, toggle() {}, contains: () => false },
    querySelectorAll: () => [], querySelector: () => null, addEventListener() {}, appendChild() {}, removeChild() {},
    setAttribute() {}, getAttribute: () => null, focus() {}, scrollIntoView() {}, getBoundingClientRect: () => ({ left: 0, top: 0, width: 900, height: 300 }) });
  const saved = { si: global.setInterval, st: global.setTimeout, raf: global.requestAnimationFrame,
    doc: global.document, win: global.window, ls: global.localStorage, f: global.fetch,
    ct: global.clearTimeout, ci: global.clearInterval };
  global.setInterval = () => 0; global.setTimeout = () => 0; global.requestAnimationFrame = () => 0;
  global.clearTimeout = () => 0; global.clearInterval = () => 0;
  global.document = { getElementById: (id) => (els[id] = els[id] || mk(id)), querySelectorAll: () => [], querySelector: () => null,
    createElement: mk, addEventListener() {}, body: mk("body"), documentElement: mk("html"), hidden: false };
  global.window = { addEventListener() {}, location: { reload() {}, href: "/", hash: "" }, matchMedia: () => ({ matches: false, addEventListener() {} }), __FLAGS: {}, __ADMIN: true };
  global.localStorage = { _d: {}, getItem(k) { return this._d[k] ?? null; }, setItem(k, v) { this._d[k] = String(v); }, removeItem(k) { delete this._d[k]; } };
  global.fetch = () => new Promise(() => {});
  const api = new Function(app + "\n;return {state, btRun, btMode, btPickRows, btUniverse, btPickerHtml, btWatchPicks, renderBacktest, dailyReturns};")();
  const restore = () => { global.setInterval = saved.si; global.setTimeout = saved.st; global.requestAnimationFrame = saved.raf;
    global.clearTimeout = saved.ct; global.clearInterval = saved.ci;
    global.document = saved.doc; global.window = saved.win; global.localStorage = saved.ls; global.fetch = saved.f; };
  // deterministic fixture rows — a slow regime wobble on top of daily noise, so trends exist for a
  // trend rule to catch and flip on. Same seed => same series => same assertions, forever.
  const DAY = 86400000, t0 = Date.UTC(2026, 3, 1);
  const mkRow = (coin, seed, n, sector) => {
    let s = seed >>> 0;
    const rnd = () => { s = (s + 0x6D2B79F5) | 0; let t = Math.imul(s ^ s >>> 15, 1 | s); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; };
    const daily = [], dailyFund = []; let px = 100, reg = 0;
    for (let i = 0; i < n; i++) { reg = reg * 0.94 + (rnd() - 0.5) * 0.006; let g = 0; for (let k = 0; k < 6; k++) g += rnd(); g = (g - 3) / 1.22;
      px *= Math.exp(reg + g * 0.021);
      daily.push({ t: t0 + i * DAY, c: +px.toFixed(4), h: +(px * 1.01).toFixed(4), v: 1e6 });
      dailyFund.push({ t: t0 + i * DAY, f: 0.0002 }); }
    return { coin, ticker: coin, uni: "xyz", delisted: false, sector, assetClass: "Equity", daily, dailyFund };
  };
  const { state } = api;
  state.rows = new Map();
  for (const [c, sd, sec] of [["NVDA", 11, "Information Technology"], ["AMD", 22, "Information Technology"], ["MU", 33, "Information Technology"],
    ["AVGO", 55, "Information Technology"], ["ASML", 66, "Information Technology"], ["PLTR", 77, "Information Technology"],
    ["XOM", 44, "Energy"], ["OXY", 88, "Energy"], ["JPM", 99, "Financials"], ["COIN", 101, "Financials"],
    ["LLY", 111, "Health Care"], ["VST", 121, "Utilities"]]) state.rows.set(c, mkRow(c, sd, 150, sec));
  state.scope = "stocks"; state.view = "backtest";
  const reset = () => { Object.assign(state.backtest, { signal: "mom", lookback: 20, cadence: 5, quantile: 0.2, cost: 5,
    universe: "all", split: 0.6, direction: "high", structure: "ls", weighting: "eq", reqSign: false, holdWindow: "cc", vsBasket: "", picks: [], entry: 0 }); };
  reset();
  return { api, state, reset, restore };
}

// ---- CONGRESS lane phase 2 (build 2026.08.24-04) ------------------------------------------------
// The PTR document parser, exercised on real PDF bytes rather than a stubbed text layer: the whole
// risk of this phase lives in getting text out of a PDF, so the fixtures ARE PDFs — built here with
// the same primitives a generator uses, in both the plain and the subset-font flavour. The subset
// case matters most: without ToUnicode decoding it parses to confident garbage rather than failing.
function _mkPtrPdf(lines, opt) {
  const o = opt || {};
  let content = "BT\n/F1 9 Tf\n";
  const hexOf = o.subset
    ? (t) => { let h = ""; for (const ch of t) h += ((o.code.get(ch) || 1)).toString(16).padStart(4, "0"); return "<" + h + ">"; }
    : null;
  for (const [x, y, txt] of lines) {
    content += `1 0 0 1 ${x} ${y} Tm\n`;
    content += o.subset ? `${hexOf(txt)} Tj\n` : `(${txt.replace(/([()\\])/g, "\\$1")}) Tj\n`;
  }
  content += "ET\n";
  let cmap = "";
  if (o.subset) {
    let bf = "";
    for (const [ch, c] of o.code) bf += `<${c.toString(16).padStart(4, "0")}> <${ch.charCodeAt(0).toString(16).padStart(4, "0")}>\n`;
    cmap = `begincmap\n${o.code.size} beginbfchar\n${bf}endbfchar\nendcmap`;
  }
  let out = "%PDF-1.4\n";
  const font = o.subset ? "<< /Type /Font /Subtype /Type0 /BaseFont /ABCDEF+Arial /ToUnicode 6 0 R >>"
    : "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>";
  const objs = ["<< /Type /Catalog /Pages 2 0 R >>", "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>", null, font, null];
  objs.forEach((d, i) => {
    const n = i + 1;
    if (n === 4) {
      let data = Buffer.from(content, "latin1"), dict = `<< /Length ${data.length} >>`;
      if (o.flate) { data = require("zlib").deflateSync(data); dict = `<< /Length ${data.length} /Filter /FlateDecode >>`; }
      out += `${n} 0 obj\n${dict}\nstream\n${data.toString("latin1")}\nendstream\nendobj\n`;
    } else if (n === 6) { if (o.subset) out += `${n} 0 obj\n<< /Length ${cmap.length} >>\nstream\n${cmap}\nendstream\nendobj\n`; }
    else out += `${n} 0 obj\n${d}\nendobj\n`;
  });
  return Buffer.from(out + "trailer\n<< /Size 7 /Root 1 0 R >>\n%%EOF\n", "latin1");
}

// ---- CONGRESS: encrypted PTRs (build 2026.08.24-10) --------------------------------------------
// Production's diag settled what three builds of guessing could not: the Clerk's PTRs carry an
// /Encrypt dictionary. Not password-protected in any meaningful sense — an empty USER password with
// owner restrictions, so every viewer opens them silently and they look like ordinary PDFs. The
// parser inflated the still-encrypted bytes, got noise, and reported "no text", which is how 222
// perfectly readable filings came to be recorded as scans.
//
// This fixture encrypts a PDF the same way and asserts the text comes back out. It validates the
// plumbing — encrypt-dictionary parsing, the empty-password key derivation, per-object keys, and
// stream decryption before inflation — in both the RC4 and AES-128 flavours.
function _encPdf(opt) {
  const crypto2 = require("crypto"), zlib = require("zlib");
  const aes = !!(opt && opt.aes);
  const PAD = Buffer.from([0x28,0xBF,0x4E,0x5E,0x4E,0x75,0x8A,0x41,0x64,0x00,0x4E,0x56,0xFF,0xFA,0x01,0x08,
    0x2E,0x2E,0x00,0xB6,0xD0,0x68,0x3E,0x80,0x2F,0x0C,0xA9,0xFE,0x64,0x53,0x69,0x7A]);
  const md5 = (b) => crypto2.createHash("md5").update(b).digest();
  const rc4x = (key, data) => {
    const S = new Uint8Array(256); for (let i = 0; i < 256; i++) S[i] = i;
    let j = 0; for (let i = 0; i < 256; i++) { j = (j + S[i] + key[i % key.length]) & 255; const t = S[i]; S[i] = S[j]; S[j] = t; }
    const out = Buffer.alloc(data.length); let i = 0; j = 0;
    for (let k = 0; k < data.length; k++) { i = (i + 1) & 255; j = (j + S[i]) & 255; const t = S[i]; S[i] = S[j]; S[j] = t; out[k] = data[k] ^ S[(S[i] + S[j]) & 255]; }
    return out;
  };
  const O = Buffer.alloc(32, 0x5a), U = Buffer.alloc(32, 0x7b);
  const P = -3904, idHex = "0123456789abcdef0123456789abcdef";
  const pBuf = Buffer.alloc(4); pBuf.writeInt32LE(P, 0);
  let key = md5(Buffer.concat([PAD, O, pBuf, Buffer.from(idHex, "hex")]));
  for (let i = 0; i < 50; i++) key = md5(key.subarray(0, 16));
  key = key.subarray(0, 16);
  const objKey = (num, gen) => {
    let x = Buffer.concat([key, Buffer.from([num & 255, (num >> 8) & 255, (num >> 16) & 255, gen & 255, (gen >> 8) & 255])]);
    if (aes) x = Buffer.concat([x, Buffer.from([0x73, 0x41, 0x6C, 0x54])]);
    return md5(x).subarray(0, 16);
  };
  const lines = [[90,680,"Nvidia Corp (NVDA) [ST]"],[365,680,"P"],[425,680,"08/13/2026"],[500,680,"08/14/2026"],[560,680,"$1,000,001 - $5,000,000"]];
  let content = "BT\n/F1 9 Tf\n";
  for (const [x, y, t] of lines) content += `1 0 0 1 ${x} ${y} Tm\n(${t.replace(/([()\\])/g, "\\$1")}) Tj\n`;
  content += "ET\n";
  let data = zlib.deflateSync(Buffer.from(content, "latin1"));
  if (aes) { const iv = crypto2.randomBytes(16); const c = crypto2.createCipheriv("aes-128-cbc", objKey(4, 0), iv);
    data = Buffer.concat([iv, c.update(data), c.final()]); }
  else data = rc4x(objKey(4, 0), data);
  const enc = aes
    ? `<< /Filter /Standard /V 4 /R 4 /Length 128 /P ${P} /O <${O.toString("hex")}> /U <${U.toString("hex")}> /CF << /StdCF << /CFM /AESV2 >> >> /StmF /StdCF >>`
    : `<< /Filter /Standard /V 2 /R 3 /Length 128 /P ${P} /O <${O.toString("hex")}> /U <${U.toString("hex")}> >>`;
  let out = "%PDF-1.4\n";
  const objs = ["<< /Type /Catalog /Pages 2 0 R >>", "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>", null,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>", enc];
  objs.forEach((d, i) => { const num = i + 1;
    if (num === 4) out += `${num} 0 obj\n<< /Length ${data.length} /Filter /FlateDecode >>\nstream\n${data.toString("latin1")}\nendstream\nendobj\n`;
    else out += `${num} 0 obj\n${d}\nendobj\n`; });
  return Buffer.from(out + `trailer\n<< /Size 7 /Root 1 0 R /Encrypt 6 0 R /ID [<${idHex}> <${idHex}>] >>\n%%EOF\n`, "latin1");
}

// ===== accounts, invites and direct messages (build 2026.09.03-50) =============================
// The shared password had one door and one key. These cover the replacement: per-person accounts,
// single-use invites, and the revocation lever that makes removing one member cost nobody else
// anything. Every case here is one that would otherwise be discovered in production.
function freshAccounts(marks) {
  const fs = require("fs"), os = require("os"), path = require("path");
  const { openAccounts } = require("../src/accounts");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "acct-test-"));
  const m = marks || {};
  const A = openAccounts(dir, { markFor: (c) => (m[c] == null ? null : m[c]), sessionDays: 30 });
  A._dir = dir;
  return A;
}
// seedTwo/seedDesk moved into test/accounts.test.js as async fixtures when bootstrap/redeem went
// async (security batch 2026.09.20); nothing else imported them.
module.exports = { classify, companyName, forceRebuild, stdev, median, linregR2, priceAt, featuresFromHourly, oiDeltaPct, pearson, meanPairwiseCorr, corrMatrix, studyBreakdown, playbook, confSplit, studyOIFlush, studyFPDiv, offDriftStats, HOUR, DAY, C, blendClosed, f4Doc, F4_BUY, F4_DERIV, F4_PLANSELL, fourHourReturns, tapeRedStats, rvolMulti, spineFrom4h, aiTestPoller, AI_GOOD, zigDaily, ZIG_PTS, aiLevelPoller, normCdf, touchBaseline, studyBars, levelOutcomes, levelStudy, LVL_EDGES, PLACEBO_K, _walk, sessionRecords, anatomyEnrich, mondayStats, nakedStats, anatomyPool, MFE_EDGES, NAKED_HORIZONS, detectWickFill, detectRoundFront, roundStep, candleType, candleEvents, candlePool, pivotPool, anatomyTickerSummary, CANDLE_TYPES, PIVOT_EARLY_H, _sessDomStub, _sessPayload, ACT_TIP_COLS, actClosedRecord, pushHarness, ruleHarness, ctxHarness, BRIEF_CTX, ADM_DOM, ADM_PUSH, runAdmFn, twoUserHarness, trendHarness, clOf, maDaily, maSd, settledPoller, svBars, _p2Harness, briefAuditHarness, mktGroupsFn, mktGroupsFixture, actionMathFns, focusSelect, focusScore, focusGapSigma, focusLevelDist, fhStats, FOCUS_CAP, FOCUS_PER_CLUSTER, focusPreview, focusDiff, FOCUS_PREVIEW_N, foldLiveMark, focus07LaneRig, focusLimits, focusFloorFail, focusGate, FOCUS_HARD_VOL, FOCUS_HARD_OI, FOCUS_BELOW_N, focus04Rig, FOCUS04_FULL, FOCUS04_GRADED, FOCCH_SRC, FOCCH_FIX, focchApi, focus05CloseRig, focColsApi, focCols, _btHarness, _mkPtrPdf, _encPdf, freshAccounts };
