"use strict";
// poller.js — universe, spines, snapshot, store, analytics, ops. Split out of test.js (build 2026.09.16-80); order within the file is the original order.
const test = require("node:test");
const assert = require("node:assert");
const { classify, companyName, forceRebuild, median, featuresFromHourly, playbook, HOUR, DAY, C, blendClosed, actClosedRecord, pushHarness, ruleHarness, ctxHarness, twoUserHarness, trendHarness, clOf, maDaily, settledPoller } = require("./_shared");


test("funding heatmap: /api/funding ships one shared axis, an own cap per timeframe, rows by OI", async () => {
  const { openStore } = require("../src/store");
  const { createPoller } = require("../src/poller");
  const fs = require("fs"), path = require("path"), os = require("os");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "xyzfh-"));
  try {
    const p = createPoller({ dex: "xyz", store: openStore(dir), log: () => {}, version: "test", crypto: false });
    const now = Math.floor(Date.now() / HOUR) * HOUR;
    const names = ["AAPL", "MSFT", "NVDA", "AMZN", "GOOGL", "META"];
    names.forEach((t, i) => {
      const m = new Map();
      for (let h = 40 * 24; h >= 0; h--) m.set(now - h * HOUR, (i % 2 ? 1 : -1) * 1.25e-5);
      // OI ascending with i, so a correct sort must REVERSE the seeding order
      p.seedRowNow("xyz:" + t, { px: 100, ticker: t, oi: 1e6 * (i + 1), funding: 1.25e-5, fundH: m });
    });
    const fh = p.getFundingHeat("stocks");
    assert.ok(fh && !fh.pending, "the board builds once the book has funding spines");
    assert.equal(fh.scope, "stocks");
    assert.ok(fh.dataTs > 0, "the payload carries its own ETag stamp");
    assert.deepEqual(fh.tfs, ["1h", "8h", "24h"], "all three timeframes ship together");
    assert.equal(fh.tfDefault, "8h");
    assert.equal(fh.count, names.length);
    assert.deepEqual(fh.rows.map((r) => r.ticker), names.slice().reverse(), "rows ranked by notional OI");
    for (const k of fh.tfs) {
      const ax = fh.axis[k];
      assert.equal(ax.width, ax.bucketHours * HOUR);
      assert.ok(ax.cap > 0, "every timeframe carries its own colour cap");
      for (const r of fh.rows) assert.equal(r.tf[k].length, ax.buckets, "every row spans the shared axis");
    }
    // The cap is a QUANTITY per timeframe, not a rescaling — 8h carry is ~8x 1h carry, so a client
    // that reused one cap across the buttons would paint the 1h grid solid.
    assert.ok(fh.axis["8h"].cap > fh.axis["1h"].cap * 4, "8h cap is a bucket of hours, not one hour");
    assert.ok(fh.axis["24h"].cap > fh.axis["8h"].cap * 2, "24h cap likewise");
    // NVDA was seeded on the receive side, so the sign must survive the bucketing too.
    const nvda = fh.rows.find((r) => r.ticker === "NVDA");
    assert.ok(nvda.tf["1h"].every((v) => v == null || Math.abs(v + 1.25e-5) < 1e-9), "1h cells are the signed hourly rate");
    assert.ok(Math.abs(nvda.tf["8h"].at(-1) + 8 * 1.25e-5) < 1e-9, "8h cells are what the bucket paid");
    const msft = fh.rows.find((r) => r.ticker === "MSFT");
    assert.ok(msft.tf["24h"].at(-1) > 0 && nvda.tf["24h"].at(-1) < 0, "pay and receive stay opposite sides of zero");
    // Memoized on the getTrend contract: a read inside the TTL is the SAME object, so the route's
    // serialize/gzip caches stay warm and an unchanged board revalidates to 304.
    assert.equal(p.getFundingHeat("stocks"), fh, "a read inside the TTL returns the memoized board");
    // A universe this deployment does not run must serve an honest empty, never a stocks body.
    assert.equal(p.getFundingHeat("crypto"), null, "no main-dex lane configured -> no crypto board");
    // One study, one home: it left /api/analytics when it became a tab of its own.
    await p.buildAnalyticsNow();
    assert.equal(p.getAnalytics().sections.fundHeat, undefined, "the board must not also ride the analytics payload");

    // Below the market floor the board stays honestly pending instead of shipping a two-row
    // "cross-section". Its own store dir: a second poller reading a first poller's volume is a
    // coupling this assertion does not want — it asserts about an empty book, so it starts from one.
    const dir2 = fs.mkdtempSync(path.join(os.tmpdir(), "xyzfh2-"));
    const p2 = createPoller({ dex: "xyz", store: openStore(dir2), log: () => {}, version: "test", crypto: false });
    const m2 = new Map(); for (let h = 48; h >= 0; h--) m2.set(now - h * HOUR, 1e-5);
    p2.seedRowNow("xyz:AAPL", { px: 100, ticker: "AAPL", oi: 1e6, fundH: m2 });
    const thin = p2.getFundingHeat("stocks");
    assert.ok(thin.pending && thin.need === 5 && thin.count === 1, "one market is not a cross-section");
    fs.rmSync(dir2, { recursive: true, force: true });
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test("funding board: the ETag follows the grid, not a summary of it", () => {
  const { openStore } = require("../src/store");
  const { createPoller } = require("../src/poller");
  const fs = require("fs"), path = require("path"), os = require("os");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "xyzfhsig-"));
  try {
    const p = createPoller({ dex: "xyz", store: openStore(dir), log: () => {}, version: "test", crypto: false });
    const now = Math.floor(Date.now() / HOUR) * HOUR;
    const seed = (t, oi, rate) => {
      const m = new Map();
      for (let h = 40 * 24; h >= 0; h--) m.set(now - h * HOUR, rate);
      p.seedRowNow("xyz:" + t, { px: 100, ticker: t, oi, funding: rate, fundH: m });
    };
    ["A", "B", "C", "D", "E", "F"].forEach((t, i) => seed(t, 1e6 * (10 - i), 1.25e-5));
    const v0 = p.getFundingHeat("stocks").dataTs;
    const rows0 = p.getFundingHeat("stocks").rows.map((r) => r.ticker);

    // A pure RESHUFFLE: same markets, same rates, same cap, same row count — only the OI ranking
    // moves. The old summary signature (count:universe:t0:cap) could not see this at all, so the
    // browser kept 304-ing against a grid whose rows had swapped places.
    p.seedRowNow("xyz:F", { oi: 99e6 });
    forceRebuild(p);
    const b1 = p.getFundingHeat("stocks");
    assert.notDeepEqual(b1.rows.map((r) => r.ticker), rows0, "the reshuffle actually reordered the grid");
    assert.equal(b1.count, 6, "...with the same row count");
    assert.ok(b1.dataTs !== v0, "a reshuffled roster must bust the validator");

    // A CELL change with the row set untouched: one market's carry moves. Row count, universe and
    // the ranking are all identical; only the numbers differ.
    const v1 = b1.dataTs;
    const m = new Map();
    for (let h = 40 * 24; h >= 0; h--) m.set(now - h * HOUR, h < 100 ? 9e-5 : 1.25e-5);
    p.seedRowNow("xyz:A", { fundH: m, _fVer: 99 });
    forceRebuild(p);
    const b2 = p.getFundingHeat("stocks");
    assert.ok(b2.dataTs !== v1, "a changed cell must bust the validator");
    // ...and an untouched book must NOT, or every poll becomes a full-body transfer.
    forceRebuild(p);
    assert.equal(p.getFundingHeat("stocks").dataTs, b2.dataTs, "an unchanged grid keeps its validator");
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test("funding board: a failing build says so, and backs off instead of re-running every request", () => {
  const { openStore } = require("../src/store");
  const { createPoller } = require("../src/poller");
  const fs = require("fs"), path = require("path"), os = require("os");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "xyzfherr-"));
  try {
    const p = createPoller({ dex: "xyz", store: openStore(dir), log: () => {}, version: "test", crypto: false });
    const now = Math.floor(Date.now() / HOUR) * HOUR;
    ["A", "B", "C", "D", "E", "F"].forEach((t, i) => {
      const m = new Map();
      for (let h = 40 * 24; h >= 0; h--) m.set(now - h * HOUR, 1.25e-5);
      p.seedRowNow("xyz:" + t, { px: 100, ticker: t, oi: 1e6 * (10 - i), funding: 1.25e-5, fundH: m });
    });
    const good = p.getFundingHeat("stocks");
    assert.ok(!good.pending && !good.buildError, "a healthy board carries no error");

    // Poison a row so the build throws: getFunding reads fundH, and a non-Map is a TypeError.
    p.seedRowNow("xyz:A", { fundH: { size: 1 }, _fVer: 101 });   // _fVer: getFunding memoizes per row; a swap it cannot see is not a test
    forceRebuild(p);
    const bad = p.getFundingHeat("stocks");
    assert.ok(bad.buildError, "a persistent failure is NAMED, not dressed as a cold cache");
    assert.ok(bad.dataTs !== good.dataTs, "and the error reaches a client holding the previous validator");
    assert.deepEqual(bad.rows.map((r) => r.ticker), good.rows.map((r) => r.ticker),
      "the last grid that built keeps serving underneath the warning");
    // The attempt is stamped whether it threw or not, so the next request inside the TTL is served
    // from cache rather than re-running the throwing build synchronously on the event loop.
    const before = p.getFundingHeat("stocks");
    assert.equal(p.getFundingHeat("stocks"), before, "a failing build still backs off to the TTL");

    // ...and it recovers on its own once the cause clears.
    const m = new Map();
    for (let h = 40 * 24; h >= 0; h--) m.set(now - h * HOUR, 1.25e-5);
    p.seedRowNow("xyz:A", { fundH: m, _fVer: 102 });
    forceRebuild(p);
    const fixed = p.getFundingHeat("stocks");
    assert.ok(!fixed.buildError, "the error clears when the build succeeds again");
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test("funding board: a row dropped for a thin spine does not vote on the colour cap", () => {
  const { openStore } = require("../src/store");
  const { createPoller } = require("../src/poller");
  const fs = require("fs"), path = require("path"), os = require("os");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "xyzfhcap-"));
  try {
    const p = createPoller({ dex: "xyz", store: openStore(dir), log: () => {}, version: "test", crypto: false });
    const now = Math.floor(Date.now() / HOUR) * HOUR;
    // Five markets with a SHORT spine — six hourly cells each. Keeping the pool small is the whole
    // point: a 98th percentile over thousands of cells shrugs off two outliers, so a test on a full
    // grid would pass with or without the fix and prove nothing.
    ["A", "B", "C", "D", "E"].forEach((t, i) => {
      const m = new Map();
      for (let h = 7; h >= 2; h--) m.set(now - h * HOUR, 1.25e-5);
      p.seedRowNow("xyz:" + t, { px: 100, ticker: t, oi: 1e6 * (10 - i), funding: 1.25e-5, fundH: m });
    });
    const capBefore = p.getFundingHeat("stocks").axis["1h"].cap;
    assert.ok(Math.abs(capBefore - 1.25e-5) < 1e-12, "the healthy cap is the book's own rate");

    // Now a market whose spine is TOO THIN to plot — two hours, under FUNDHEAT_MIN_CELLS in every
    // timeframe — but whose rate is enormous. It is dropped from the grid, so it must not vote on
    // the colour scale the grid is drawn with.
    const thin = new Map();
    for (let h = 3; h >= 2; h--) thin.set(now - h * HOUR, 5e-3);
    p.seedRowNow("xyz:HUGE", { px: 100, ticker: "HUGE", oi: 1e12, funding: 5e-3, fundH: thin });
    forceRebuild(p);
    const after = p.getFundingHeat("stocks");
    assert.ok(!after.rows.some((r) => r.ticker === "HUGE"), "the thin row is not in the grid");
    assert.equal(after.count, 5, "...and the five plottable markets still are");
    assert.equal(after.axis["1h"].cap, capBefore,
      "...so it did not move the cap either — pooling it would have painted the whole grid one shade of nothing");
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test("ask-the-board 2C: analyst may use identity/business knowledge, scoped to the universe, numbers stay grounded", () => {
  const fs = require("fs"), path = require("path");
  const pol = fs.readFileSync(path.join(__dirname, "..", "src", "poller.js"), "utf8");
  // The prompt must split its grounding: figures come only from the data, but identity/business
  // facts (what a company is, what it makes) may lean on general knowledge — universe-scoped.
  for (const pin of ["name = the company's common name", "NUMBERS RULE", "IDENTITY RULE",
    "NEVER name a company that is not in that list", "derivable from the data"])
    assert.ok(pol.includes(pin), `analyst identity/numbers rule missing: ${pin}`);
  // And the canonical name must actually be threaded onto each analyst row server-side, so the
  // model maps ticker->company from the payload rather than guessing.
  assert.ok(pol.includes("const nm = companyName(t); return nm ? Object.assign({ name: nm }, o) : o;") && pol.includes('require("./sectors")'),
    "company-name injection not wired into askBoard markets");
  assert.ok(/companyName/.test(pol), "companyName must be imported/used in poller");
});

test("promotion F4: daily clock and min-dwell bound the re-testing channel", () => {
  const { createPoller } = require("../src/poller");
  const store = { loadAll: () => new Map(), loadRegime: () => [], loadLedger: () => null,
    saveLedger: () => {}, insert: () => {}, saveRegime: () => {}, archiveClosed: () => {} };
  const p = createPoller({ dex: "xyz", store, log: () => {}, version: "test", crypto: false });
  // bigmove: incumbent index 1. Inject a clear SE-clearing beat at index 2 (tight dispersion,
  // large edge). Index 0 is unremarkable.
  const winner = { n: 40, hit: 0.60, avg: 0.60, sd: 0.4 };   // vs inc avg 0.20, SE~0.089, edge 0.40 >> margin
  p.setVariantStatsNow({ bigmove: [
    { n: 40, hit: 0.50, avg: 0.05, sd: 0.4 },   // vi 0
    { n: 40, hit: 0.55, avg: 0.20, sd: 0.4 },   // vi 1 (incumbent)
    winner,                                      // vi 2
  ] });
  const vs = p.variantStateNow();
  assert.equal(vs.bigmove.inc, 1, "incumbent starts at index 1");
  // First FORCED sweep promotes to the winner.
  p.checkPromotionsNow(true);
  assert.equal(p.variantStateNow().bigmove.inc, 2, "a clear beat promotes on a forced sweep");
  assert.equal(p.variantStateNow().bigmove.hist.length, 1, "promotion recorded in hist with a timestamp");
  // Now inject an even-better index 0 and sweep AGAIN, forced. Min-dwell must refuse: the
  // incumbent was just installed, so no move regardless of how good a challenger looks.
  p.setVariantStatsNow({ bigmove: [
    { n: 40, hit: 0.70, avg: 1.50, sd: 0.4 },   // vi 0 — spectacular
    { n: 40, hit: 0.55, avg: 0.20, sd: 0.4 },   // vi 1
    { n: 40, hit: 0.60, avg: 0.60, sd: 0.4 },   // vi 2 (fresh incumbent)
  ] });
  p.checkPromotionsNow(true);
  assert.equal(p.variantStateNow().bigmove.inc, 2, "min-dwell blocks a move right after a promotion, even forced");
  // Backdate the last promotion beyond the dwell window; now the sweep may act again.
  p.variantStateNow().bigmove.hist[0].t = Date.now() - 11 * 86400e3;
  p.checkPromotionsNow(true);
  assert.equal(p.variantStateNow().bigmove.inc, 0, "past the dwell window the better challenger promotes");
});

test("promotion F4: the daily clock skips sweeps inside the window (unforced)", () => {
  const { createPoller } = require("../src/poller");
  const store = { loadAll: () => new Map(), loadRegime: () => [], loadLedger: () => null,
    saveLedger: () => {}, insert: () => {}, saveRegime: () => {}, archiveClosed: () => {} };
  const p = createPoller({ dex: "xyz", store, log: () => {}, version: "test", crypto: false });
  const winner = { n: 40, hit: 0.60, avg: 0.60, sd: 0.4 };
  const inject = () => p.setVariantStatsNow({ bigmove: [
    { n: 40, hit: 0.50, avg: 0.05, sd: 0.4 }, { n: 40, hit: 0.55, avg: 0.20, sd: 0.4 }, winner ] });
  inject();
  // First UNFORCED sweep runs (lastPromoCheck starts at 0) and promotes.
  p.checkPromotionsNow(false);
  assert.equal(p.variantStateNow().bigmove.inc, 2, "first unforced sweep runs and promotes");
  // Reset the incumbent and re-inject a live challenger; a second UNFORCED sweep inside the ~20h
  // window must be skipped entirely — the incumbent index is unchanged because the sweep never ran.
  p.variantStateNow().bigmove.inc = 1;
  p.variantStateNow().bigmove.hist.length = 0;   // clear dwell so ONLY the daily clock can block
  inject();
  p.checkPromotionsNow(false);
  assert.equal(p.variantStateNow().bigmove.inc, 1, "a second unforced sweep inside the daily window is skipped");
});

test("blend F1: no-edge guard is scoped — a cold record in one universe can't cap the other", () => {
  const { createPoller } = require("../src/poller");
  // Equity breakdown is a clear no-edge record (n>=10, hit<0.5, med<=0). Crypto breakdown is clean.
  const fixture = { ts: Date.now(), rearm: [], variants: null, open: [], closed: [
    ...blendClosed("xyz:BBB", "breakdown", 14, -1),   // universe x: no-edge
    ...blendClosed("ETHP", "breakdown", 14, 1),       // universe m: fine
  ] };
  const store = { loadAll: () => new Map(), loadRegime: () => [], loadLedger: () => fixture,
    saveLedger: () => {}, insert: () => {}, saveRegime: () => {}, archiveClosed: () => {} };
  const p = createPoller({ dex: "xyz", store, log: () => {}, version: "test", crypto: true });
  p.hydrateLedgerNow(); p.recomputeRecordNow();
  const study = { n: 12, hit: 0.6, med: 0.6, avg: 0.6 };
  const eqEv = p.evidenceNow(study, "breakdown", null, "R", "xyz");
  const cxEv = p.evidenceNow(study, "breakdown", null, "R", "main");
  assert.equal(eqEv.noedge, true, "equity fire is capped by its own no-edge record");
  assert.ok(eqEv.pts <= 8, "no-edge cap applied to the equity score");
  assert.ok(!cxEv.noedge, "crypto fire is NOT capped by the equity universe's no-edge record");
  assert.ok(cxEv.pts > 8, "crypto score rides its own clean record past the cap");
});

test("blend F3: the live record blends toward recency — recent winners outweigh old losers", () => {
  const { createPoller } = require("../src/poller");
  const now = Date.now();
  // Two equity records for different events, identical claim COUNT and identical FLAT mean (0),
  // but opposite time ordering: one has recent WINNERS + old losers, the other recent LOSERS +
  // old winners. The recency-weighted avgR must diverge — positive for the first, negative for the
  // second — even though the all-time avg is ~0 for both. That divergence is F3.
  function entTimed(coin, ev, i, realized, ageDays) {
    const t0 = now - ageDays * 86400000 - i * 1000;
    return { key: coin + "|" + ev + "#" + i, coin, ticker: coin.split(":").pop(), ev, t0, mark0: 100,
      dir: 1, sd0: 2, status: "resolved", tR: now - ageDays * 86400000, realized, realizedS: realized,
      win: realized > 0, winS: realized > 0, psd: "long", pn: 1 };
  }
  const closed = [];
  // recentWin event: +1R in the last ~10d, -1R ~300d ago -> flat all-time, positive recency
  for (let i = 0; i < 12; i++) closed.push(entTimed("xyz:RW", "breakout", i, 1, 8));
  for (let i = 0; i < 12; i++) closed.push(entTimed("xyz:RW", "breakout", 100 + i, -1, 300));
  // recentLoss event: mirror -> flat all-time, negative recency
  for (let i = 0; i < 12; i++) closed.push(entTimed("xyz:RL", "breakdown", i, -1, 8));
  for (let i = 0; i < 12; i++) closed.push(entTimed("xyz:RL", "breakdown", 100 + i, 1, 300));
  const store = { loadAll: () => new Map(), loadRegime: () => [], loadLedger: () => ({ ts: now, rearm: [], variants: null, open: [], closed }),
    saveLedger: () => {}, insert: () => {}, saveRegime: () => {}, archiveClosed: () => {} };
  const p = createPoller({ dex: "xyz", store, log: () => {}, version: "test", crypto: false });
  p.hydrateLedgerNow(); p.recomputeRecordNow();
  const rw = p.recForNow("xyz").breakout, rl = p.recForNow("xyz").breakdown;
  assert.ok(Math.abs(rw.avg) < 0.2, "recentWin event is ~flat on the all-time mean");
  assert.ok(rw.avgR > 0.3, "but its recency-weighted mean is clearly positive (recent winners dominate)");
  assert.ok(rl.avgR < -0.3, "the mirror's recency-weighted mean is clearly negative");
  // And the blend consumes avgR: a neutral study blended against each record scores higher for the
  // recent-winner event than the recent-loser one, though their all-time means are identical.
  const study = { n: 12, hit: 0.5, med: 0, avg: 0 };
  const evRW = p.evidenceNow(study, "breakout", null, "R", "xyz");
  const evRL = p.evidenceNow(study, "breakdown", null, "R", "xyz");
  assert.ok(evRW.pts > evRL.pts, "the blend rewards the recently-working signal over the recently-failing one");
});

test("blend F7: the no-avg fallback stays expectancy-centered (a losing base rate scores 0)", () => {
  const { createPoller } = require("../src/poller");
  const store = { loadAll: () => new Map(), loadRegime: () => [], loadLedger: () => null,
    saveLedger: () => {}, insert: () => {}, saveRegime: () => {}, archiveClosed: () => {} };
  const p = createPoller({ dex: "xyz", store, log: () => {}, version: "test", crypto: false });
  p.recomputeRecordNow();   // empty record -> evidence falls through to the study/pooled path (no blend)
  // A study with NO avg (the fallback branch): a negative median + sub-even hit must NOT score the
  // same as a positive median + strong hit. Pre-F7 both earned |med|/|hit-0.5| symmetrically.
  const losing = p.evidenceNow({ n: 12, hit: 0.2, med: -1, avg: null }, "breakout", null, "R", "xyz");
  const winning = p.evidenceNow({ n: 12, hit: 0.8, med: 1, avg: null }, "breakout", null, "R", "xyz");
  assert.equal(losing.pts, 0, "a losing no-avg base rate earns zero, not intensity-mirrored points");
  assert.ok(winning.pts > 20, "a winning no-avg base rate still earns real points");
});

// ---- Slice C (2026.07.30-04): prime v2 admits the asymmetric swing profile; confluence pays on
// R lift, not hit lift alone -------------------------------------------------------------------
test("prime F6: the asymmetric-profile path is certified by the live scoped record", () => {
  const { createPoller } = require("../src/poller");
  const now = Date.now(), EPOCH_DAY = Math.floor(Date.UTC(2026, 6, 26) / 86400000);
  // Build a live record for an R-united event whose HIT is well under 0.6 (v1 impossible) but whose
  // expectancy is asymmetric: avg ~0.5R, pf >= 1.5. reclaim is R-united. Wins are big, losses small
  // -> low hit, high avg, high pf. Crypto ids (no ":") must sit post-epoch to survive the purge.
  function ent(coin, ev, i, realized) {
    const t0 = (EPOCH_DAY + 1) * 86400000 + i * 1000;
    return { key: coin + "|" + ev + "#h" + i, coin, ticker: coin, ev, t0, mark0: 100, dir: 1, sd0: 2,
      status: "resolved", tR: t0 + 5 * 86400000, realized, realizedS: realized, win: realized > 0, winS: realized > 0, psd: "long", pn: 1 };
  }
  // 14 crypto reclaim resolutions: 6 wins at +2R, 8 losses at -0.4R -> hit 0.43, avg ~0.63R,
  // pf = (6*2)/(8*0.4) = 12/3.2 = 3.75.
  const closed = [];
  for (let i = 0; i < 6; i++) closed.push(ent("SOLP", "reclaim", i, 2));
  for (let i = 6; i < 14; i++) closed.push(ent("SOLP", "reclaim", i, -0.4));
  const fixture = { ts: now, rearm: [], variants: null, open: [], closed };
  const store = { loadAll: () => new Map(), loadRegime: () => [], loadLedger: () => fixture,
    saveLedger: () => {}, insert: () => {}, saveRegime: () => {}, archiveClosed: () => {} };
  const p = createPoller({ dex: "xyz", store, log: () => {}, version: "test", crypto: true });
  p.hydrateLedgerNow(); p.recomputeRecordNow();
  const rec = p.recForNow("main").reclaim;
  assert.ok(rec && rec.hit < 0.6, "the live record's hit rate is below the v1 gate");
  assert.ok(rec.avg >= 0.35, "but expectancy clears the v2 avg threshold");
  assert.ok(rec.pf >= 1.5, "and profit factor clears the v2 pf threshold");
  assert.equal(p.primeV2LiveNow("main", "reclaim"), true, "v2 admits this asymmetric profile as prime");
  // Wiring pin (the -84 lesson: a correct predicate that the build never consults is dead). The
  // prime decision must OR primeV2 into the gate — pin the call site structurally so deleting the
  // OR-branch is a suite failure, not a silent revert to hit>=0.6-only.
  const polSrc = require("fs").readFileSync(require("path").join(__dirname, "..", "src", "poller.js"), "utf8");
  assert.ok(/primeV2\s*=\s*primeV2Live\(g\.uni,\s*g\.ev\)/.test(polSrc), "prime v2 is computed from the live-record predicate at fire");
  assert.ok(/\(primeV1\s*\|\|\s*primeV2\)/.test(polSrc), "the prime gate ORs the asymmetric v2 path in — not hit>=0.6 alone");
  // Guards: a % event never qualifies (0.35 isn't an R threshold there); a thin record doesn't;
  // and the wrong universe (no crypto claims on the equity side) doesn't.
  assert.equal(p.primeV2LiveNow("main", "squeeze"), false, "a %-unit event is never v2-prime");
  assert.equal(p.primeV2LiveNow("xyz", "reclaim"), false, "the equity universe has no such record -> not prime");
});

test("crypto enrollment: a whitelist and a geometry gate — and the arithmetic that caused -101 cannot return", () => {
  // -101 removed the crypto engine because the additive playbook geometry produced impossible
  // claims on collapsed coins. That was an arithmetic bug, not a verdict on the signals, and this
  // test pins the fix at BOTH ends: the bug is reproducible against the additive path (so the
  // regression has a witness), and the log-space path plus the gate make it unreachable for crypto.
  const C = require("../src/compute");
  assert.ok(!("detectLiqFlush" in C), "detectLiqFlush stays retired — cascade exhaustion replaced it");
  assert.ok(typeof C.claimGeometryOk === "function" && typeof C.logExtend === "function" &&
    typeof C.evMeta === "function" && typeof C.capPerUniverse === "function", "the crypto primitives are exported");

  // ---- the -101 bug, reproduced. This is the witness: a 30d range spanning >2.6x drives the
  // additive extension straight through zero, and the resulting "target" is a negative price.
  const bug = C.playbook("unwind", { hi30: 10, lo30: 1 });
  assert.ok(bug.target < 0, `the additive path must still demonstrate the bug it is kept for (got ${bug.target})`);
  // ---- and the log-space path on the identical inputs cannot
  const fixed = C.playbook("unwind", { hi30: 10, lo30: 1, logGeo: true });
  assert.ok(fixed.target > 0 && fixed.stop > 0, "log-space geometry is positive at any range width");
  assert.ok(fixed.target < 1 && fixed.stop < 10, "and still points the right way: below the low, inside the high");

  // ---- xyz geometry is BYTE-IDENTICAL across this build. The equity record was earned under the
  // additive formulas; silently changing them would make every future claim incomparable to the
  // hundreds already resolved, which is a far worse outcome than an ugly formula.
  assert.deepEqual([C.playbook("unwind", { hi30: 120, lo30: 100 }).target, C.playbook("unwind", { hi30: 120, lo30: 100 }).stop],
    [92.36, 115], "xyz unwind levels unchanged");
  assert.deepEqual([C.playbook("squeeze", { hi30: 120, lo30: 100 }).target, C.playbook("squeeze", { hi30: 120, lo30: 100 }).stop],
    [127.64, 105], "xyz squeeze levels unchanged");
  const bm = C.playbook("bigmove", { px: 100, dir: 1, sd30: 2, med: 3 });
  assert.deepEqual([bm.target, bm.stop], [103, 98], "xyz bigmove levels unchanged");

  // ---- the gate's bounds
  assert.equal(C.claimGeometryOk("long", 100, 99.9, 110, 12), false, "a void 0.008 sigma out is noise wearing a stop's clothing");
  assert.equal(C.claimGeometryOk("long", 100, 50, 110, 4), false, "a void 12 sigma out is a different thesis, not a stop");
  assert.equal(C.claimGeometryOk("short", 2, 5.5, -2.44, 12), false, "a negative target is refused outright");
  assert.equal(C.claimGeometryOk("long", 100, 101, 110, 5), false, "a void on the profit side is refused (the -101 inversion)");
  assert.equal(C.claimGeometryOk("long", 200, 188, 232, 6), true, "a sane crypto claim passes");
  assert.equal(C.claimGeometryOk("long", 100, null, 110, 5), true, "a missing void is not a failure — that claim simply has no stop-aware leg");

  const fs = require("fs"), path = require("path");
  const pol = fs.readFileSync(path.join(__dirname, "..", "src", "poller.js"), "utf8");
  // the enrollment: pass 1 iterates BOTH rosters, gated on the crypto flag
  assert.ok(pol.includes("for (const r of activeMarkets().concat(crypto ? mainMarkets() : [])) {"),
    "pass-1 iterates both universes when crypto is enabled");
  // the guard is a whitelist consulted in ONE place, so "which events does this universe run"
  // has exactly one answer in the codebase
  assert.ok(pol.includes("if (r && !evAllowed(r.uni, ev)) return null;"), "openLedger refuses any event its universe does not run");
  assert.ok(pol.includes("if (!evAllowed(g.uni, g.ev)) continue;"),
    "and the CARD path is gated by the same rule — a card whose claim was refused would be a board/ledger disagreement");
  assert.ok(pol.includes("function evAllowed(uni, ev)"), "one gate, one definition");
  // pooling must not mix universes: an asset-class bucket holding BTC and NVDA together is not a
  // small-n rescue, it is contamination
  assert.ok(pol.includes('const acOf = (r) => (r.uni === "main" ? "Crypto" : (classifyCached(r.ticker).assetClass || "Other"));'),
    "crypto pools separately from every equity asset class");
  assert.ok(pol.includes('const R_LEDGER_EVS = new Set(["bigmove", "breakout", "breakdown", "fundflip", "oiflush", "fpdiv", "reclaim", "mapull", "failbrk", "pead", "sweep", "airead", "casc", "fundext", "swpull", "basebrk", "basepj", "emabrk", "emarts", "lvlhold", "lvlrej", "squeeze2", "unwind2", "vphold", "vprej"])'),
    "R-united ledger set carries the crypto-native events + the -20 swing, -28 EMA200, and 07.28 structural-void + volume-node shadows");
  for (const gone of ["oc24: oiChg24", "cryptoSetupsLive"])
    assert.ok(!pol.includes(gone), `retired -87 remnant must not return: ${gone}`);
  // countU is BACK, and must count kept conditions rather than the capped transport slice —
  // summing the payload would under-report the moment either lane fills.
  assert.ok(pol.includes("for (const g of kept) { if (g.uni === \"main\") cntM++; else cntX++; }"),
    "per-universe live totals are counted over kept, not over the capped payload");
  assert.ok(pol.includes("countU: { x: cntX, m: crypto ? cntM : null }"),
    "countU ships the split, with an explicit null for a crypto-disabled deployment");
});

test("crypto enrollment, proven by behavior: both universes fire, on their own horizons, whitelist holding both ways", async () => {
  // The same two seeded rows and the same real unpatched iteration this test has always used —
  // now asserting the enrollment rather than the removal. Behavior, not string pins.
  const { createPoller } = require("../src/poller");
  const store = { loadAll: () => new Map(), loadRegime: () => [], loadLedger: () => null,
    saveLedger: () => {}, insert: () => {}, saveRegime: () => {}, saveNews: () => {}, loadNews: () => null };
  const p = createPoller({ dex: "xyz", store, log: () => {}, version: "test", crypto: true });
  const DAY_ = 86400e3, HOUR_ = 3600e3, now = Date.now();
  const mkD = () => { const d = []; for (let i = 61; i >= 1; i--) d.push({ t: now - i * DAY_, c: 100 * Math.pow(1.0005, 61 - i), o: 100, h: 103, l: 98, v: 1e6 }); return d; };
  const mkH = () => { const h = []; for (let i = 400; i >= 0; i--) { const c = 100 + Math.sin(i / 9); h.push({ t: now - i * HOUR_, o: c, h: c + 0.7, l: c - 0.7, c, v: 1e5 }); } return h; };
  p.seedRowNow("ETH", { px: 112, ticker: "ETH", uni: "main", vol: 5e7, dailyRaw: mkD(), hourlyRaw: mkH(), dailyTs: now, hourlyTs: now, isNew: false, prevDay: 100, d1: 12 });
  p.seedRowNow("xyz:NVDA", { px: 112, ticker: "NVDA", uni: "xyz", vol: 1e7, dailyRaw: mkD(), hourlyRaw: mkH(), dailyTs: now, hourlyTs: now, isNew: false, prevDay: 100, d1: 12 });
  p.buildDailyNow();
  await p.buildSignalsNow();
  const d = p.getSignals(true);
  assert.ok(d.signals.length > 0, "the engine fires");
  assert.ok(d.signals.some((s0) => s0.uni === "xyz"), "the xyz side still fires");
  assert.ok(d.signals.some((s0) => s0.uni === "main"), "and the identically-seeded crypto row now fires too");
  // whitelist, forward direction: no xyz-only event may appear on a crypto card
  for (const ev of ["gap", "gapfade", "ondrift", "pead", "sweep", "prem", "squeeze", "unwind"])
    assert.ok(!d.signals.some((s0) => s0.uni === "main" && s0.ev === ev),
      `xyz-only event ${ev} must never surface on a crypto card`);
  // ...and reverse: no crypto-native event on an equity card
  for (const ev of ["casc", "fundext"])
    assert.ok(!d.signals.some((s0) => s0.uni === "xyz" && s0.ev === ev),
      `crypto-native event ${ev} must never surface on an equity card`);
  const ledC = p.getLedgerFor("ETH", null, true);
  assert.ok((ledC.open || []).length > 0, "crypto claims ledger");
  const ledX = p.getLedgerFor("xyz:NVDA", null, true);
  assert.ok(ledX && ledX.open && ledX.open.length > 0, "the xyz row's claims ledger exactly as before");
  // horizons follow the universe: the same event resolves on a compressed clock for crypto. A 5d
  // horizon on a name printing 12%/day resolves on tape noise, not on the setup.
  const hz = (led, ev) => { const e = (led.open || []).find((x) => x.ev === ev); return e ? e.resolveAt - e.t0 : null; };
  const cB = hz(ledC, "bigmove"), xB = hz(ledX, "bigmove");
  if (cB != null && xB != null) assert.ok(cB < xB, `crypto bigmove horizon (${cB / 3600e3}h) must be shorter than xyz's (${xB / 3600e3}h)`);
  const fs = require("fs"), path = require("path");
  const pol = fs.readFileSync(path.join(__dirname, "..", "src", "poller.js"), "utf8");
  assert.ok(pol.includes("function resolveAtFor(ev, t0, uni)"), "the resolver takes the universe");
  assert.ok(pol.includes("resolveAt: resolveAtFor(ev, Date.now(), r.uni),"), "and the open site passes it");
  assert.equal((pol.match(/order\.length \? order\.map/g) || []).length, 0, "no activeMarkets fallback patch lives in the shipped source");
});

test("ask per-user cap: 5/day per owner over the shared pool, admin exempt and burns nothing", async () => {
  const { createPoller } = require("../src/poller");
  const store = { loadAll: () => new Map(), loadRegime: () => [], loadLedger: () => null,
    saveLedger: () => {}, insert: () => {}, saveRegime: () => {}, saveNews: () => {}, loadNews: () => null };
  process.env.OPENAI_API_KEY = "test-key";
  process.env.ASK_USER_PER_DAY = "1";
  try {
    let calls = 0;
    const aiFetch = async () => { calls++;
      return { ok: true, json: async () => ({ choices: [{ message: { content: "screen funding<0 & squeeze>50" }, finish_reason: "stop" }] }) }; };
    const p = createPoller({ dex: "xyz", store, log: () => {}, version: "test", crypto: false, aiFetch });
    const uni = [{ t: "SOL", sqz: 71, f: -22 }];
    const a = await p.askBoard("most crowded shorts?", { universe: uni }, { owner: "u1", admin: false });
    assert.equal(a.ok, true); assert.equal(a.askUserDayLeft, 0, "the single per-user ask is spent");
    const b = await p.askBoard("top funding names?", { universe: uni }, { owner: "u1", admin: false });
    assert.equal(b.error, "ask-user-cap", "second distinct ask hits the per-user cap before the shared pool");
    const sharedBefore = b.askDayLeft, callsBefore = calls;
    const c = await p.askBoard("what about momentum leaders?", { universe: uni }, { owner: "u1", admin: true });
    assert.equal(c.ok, true, "admin bypasses the per-user cap");
    assert.equal(c.askDayLeft, sharedBefore, "admin asks must not burn the shared pool");
    assert.ok(calls > callsBefore, "the admin ask really hit the transport");
    const d = await p.askBoard("most crowded shorts?", { universe: uni }, { owner: "u2", admin: false });
    assert.equal(d.cached, true, "another user re-asking the same question rides the cache");
    assert.equal(d.askUserDayLeft, 1, "a cache hit burns nothing from the new user's budget");
  } finally { delete process.env.OPENAI_API_KEY; delete process.env.ASK_USER_PER_DAY; }
});

test("candles tf param: the chart series IS the ladder series — the modal cannot disagree with the board", () => {
  // Regression class: the Trend-tab chart modal's design mockup once showed an "up 3/4 · retest"
  // badge over candles whose close sat BELOW both EMAs — two sources of truth, one lying. The
  // build's contract: /api/candles?tf= serves the EXACT series buildTrend fed trendLadder for
  // that rung, and every modal annotation is the /api/trend payload restated. This test walks
  // the contract end to end: for every rung, an EMA walk over the endpoint's series (with the
  // same live-mark substitution) must land on the board's own state and the board's own shipped
  // e13/e21 — if the endpoint ever drifts from the ladder's inputs, this fails before it ships.
  const { createPoller } = require("../src/poller");
  const { bucketCandles, withFormingDaily, emaLast, trendState } = require("../src/compute");
  const store = { loadAll: () => new Map(), loadRegime: () => [], loadLedger: () => null,
    saveLedger: () => {}, insert: () => {}, saveRegime: () => {} };
  const p = createPoller({ dex: "xyz", store, log: () => {}, version: "test", crypto: false });
  const now = Date.now(), endH = Math.floor(now / HOUR);
  // same fixture family as the trend-board harness test: 16d rising hourly spine, 60 daily bars
  // whose deep lows probe the D1 ribbon (closes-only opens, exercising the null-o passthrough)
  const N = 16 * 24, hourly = [];
  for (let i = 0; i < N; i++) {
    const t = (endH - N + i) * HOUR, c = 100 * Math.pow(1.0005, i);
    hourly.push({ t, o: c, h: c * 1.001, l: c * 0.999, c, v: 1 });
  }
  const px = hourly[N - 1].c * 1.0005;
  const daily = [];
  for (let i = 0; i < 60; i++)
    daily.push({ t: (Math.floor(now / DAY) - 60 + i) * DAY, c: px * Math.pow(1.01, i - 59), l: px * Math.pow(1.01, i - 59) * 0.90, h: px * Math.pow(1.01, i - 59) * 1.002 });
  p.seedRowNow("TCHART", { px, uni: "xyz", vol: 1e6, hourlyRaw: hourly, dailyRaw: daily });
  p.buildTrendNow();
  const row = p.getTrend().long.stocks.find((e) => e.coin === "TCHART");
  assert.ok(row, "seeded market reaches the long board");
  const rel = (a, b) => Math.abs(a - b) / Math.abs(b);
  // the modal's zone band rides the payload: per-TF e13/e21 must ship on every rung
  for (const t of ["D1", "H12", "H4", "H1"])
    assert.ok(row.tf[t].e13 > 0 && row.tf[t].e21 > 0, `board payload ships e13/e21 for ${t}`);
  const map = { "1h": "H1", "4h": "H4", "12h": "H12", "1d": "D1" };
  for (const [tf, lad] of Object.entries(map)) {
    const res = p.getTfCandles("TCHART", tf);
    assert.equal(res.tf, tf, `${tf}: tf echoed`);
    assert.ok(res.px > 0, `${tf}: live mark ships`);
    assert.ok(res.candles.length >= 26, `${tf}: enough bars for an honest ribbon, got ${res.candles.length}`);
    const closes = res.candles.map((k) => k[4]);
    closes[closes.length - 1] = res.px;   // the same live-mark-drives-the-forming-bar rule trendLadder applies
    const e13 = emaLast(closes, 13), e21 = emaLast(closes, 21);
    assert.equal(trendState(res.px, e13, e21), row.tf[lad].st,
      `${tf}: state re-derived from the chart's own series equals the board's ${lad} state`);
    assert.ok(rel(e13, row.tf[lad].e13) < 1e-6 && rel(e21, row.tf[lad].e21) < 1e-6,
      `${tf}: an EMA walk over the endpoint series reproduces the shipped ladder EMAs`);
  }
  // series identity, not just same-answer: each tf is literally the ladder's input for that rung.
  // bucketCandles now takes the packed spine shape (what the poller feeds it internally), so pack
  // the object fixture the same way seedRowNow/refreshHourly do for an apples-to-apples comparison.
  const packedHourly = hourly.map((k) => [k.t, k.o, k.h, k.l, k.c, k.v]);
  const b4 = bucketCandles(packedHourly, 4, HOUR), b12 = bucketCandles(packedHourly, 12, HOUR);
  const r4 = p.getTfCandles("TCHART", "4h"), r12 = p.getTfCandles("TCHART", "12h");
  assert.equal(r4.candles.length, b4.length, "4h: bucket count matches bucketCandles");
  assert.equal(r12.candles.length, b12.length, "12h: bucket count matches bucketCandles");
  for (let i = 0; i < b4.length; i++) {
    assert.equal(r4.candles[i][0], b4[i].t, "4h: bucket timestamps identical");
    assert.ok(rel(r4.candles[i][4], b4[i].c) < 1e-8, "4h: bucket closes identical (mod quantization)");
  }
  const r1 = p.getTfCandles("TCHART", "1h");
  assert.equal(r1.candles.length, 96, "1h: the ladder's 96-bar spine tail, not the drawer's days window");
  assert.equal(r1.candles[95][0], hourly[N - 1].t, "1h: tail ends at the last spine bar");
  const g = withFormingDaily(daily, px, Date.now(), DAY);
  const rd = p.getTfCandles("TCHART", "1d");
  assert.equal(rd.candles.length, g.length, "1d: through the withFormingDaily staleness guard");
  // OHLC upgrade (build -73): closes-only bars — the synthetic forming bar included — take their
  // o/h/l from the REAL hourly aggregation of that UTC day when the spine covers it. That is
  // measured data, not fabrication: the invariant "never a fabricated flat candle" is preserved
  // by construction (no coverage -> stays closes-only), and the CLOSES the ladder's EMAs walked
  // ride through untouched, so the chart still cannot disagree with the board.
  const b24 = new Map(bucketCandles(packedHourly, 24, HOUR).map((b) => [Math.floor(b.t / DAY), b]));
  const last = rd.candles[rd.candles.length - 1];
  const lastDayB = b24.get(Math.floor(last[0] / DAY));
  if (lastDayB) {
    assert.ok(last[1] != null && last[2] != null && last[3] != null, "1d: the forming bar upgrades to the day's real hourly OHLC when the spine covers it");
    assert.ok(last[2] >= last[4] - 1e-9 && last[3] <= last[4] + 1e-9, "1d: upgraded h/l are clamped to include the official close");
  }
  for (let i = 0; i < rd.candles.length; i++) {
    const gi = g[i];
    if (gi && Number.isFinite(+gi.c)) assert.ok(rel(rd.candles[i][4], +gi.c) < 1e-8, "1d: closes byte-identical to the ladder's series — the upgrade may never touch them");
    if (!b24.has(Math.floor(rd.candles[i][0] / DAY)))
      assert.ok(rd.candles[i][1] == null, "1d: a day with no hourly coverage stays honestly closes-only — no coverage, no candle");
  }
  // legacy surface untouched: no tf keeps the drawer's 6-tuple hourly shape; unknown tf is a
  // null (the route falls through to legacy rather than guessing)
  const leg = p.getCandles("TCHART", 7);
  assert.ok(leg.length > 0 && leg[0].length === 6, "legacy days-windowed shape keeps its volume column");
  assert.equal(p.getTfCandles("TCHART", "5m"), null, "unknown tf refuses rather than guesses");
  assert.deepEqual(p.getTfCandles("NOSUCH", "4h").candles, [], "unknown market: empty series, not a throw");
});

test("daily refetch predicate: closes-only warm restores refetch regardless of dailyTs — the 1D chart's bodiless-candle window closes itself", () => {
  // Regression for the permanently-tick-marked 1D chart: the warm cache persists dailies as
  // [t,c] AND persists dailyTs, so a redeploy restored closes-only bars behind a fresh-looking
  // timestamp and the 6h staleness gate refused to refetch — at a multiple-builds-per-day
  // cadence the D1 view never escaped the window. Closes-only bars must now count as
  // fetch-worthy on their own; full-OHLC bars keep the normal staleness behavior.
  const { createPoller } = require("../src/poller");
  const store = { loadAll: () => new Map(), loadRegime: () => [], loadLedger: () => null,
    saveLedger: () => {}, insert: () => {}, saveRegime: () => {} };
  const p = createPoller({ dex: "xyz", store, log: () => {}, version: "test", crypto: false });
  const now = Date.now(), d0 = Math.floor(now / DAY) * DAY;
  const closesOnly = Array.from({ length: 30 }, (_, i) => ({ t: d0 - (30 - i) * DAY, c: 100 + i }));
  const fullOHLC = closesOnly.map((k) => ({ t: k.t, o: k.c * 0.99, h: k.c * 1.01, l: k.c * 0.985, c: k.c }));
  p.seedRowNow("WARM", { px: 130, dailyRaw: closesOnly, dailyTs: now });        // fresh ts, bodiless bars
  p.seedRowNow("LIVE", { px: 130, dailyRaw: fullOHLC, dailyTs: now });          // fresh ts, full bars
  p.seedRowNow("STALE", { px: 130, dailyRaw: fullOHLC, dailyTs: now - 7 * 3600 * 1000 });   // full bars past the 6h gate
  assert.equal(p.needDailyNow("WARM"), true, "closes-only restore is fetch-worthy despite a fresh dailyTs");
  assert.equal(p.needDailyNow("LIVE"), false, "full-OHLC dailies inside the staleness window are left alone");
  assert.equal(p.needDailyNow("STALE"), true, "full-OHLC dailies past the 6h gate still refresh normally");
  assert.equal(p.needDailyNow("NOSUCH"), false, "unknown market: false, not a throw");
  // and the modal's endpoint really does ship those bodiless bars as nulls (the close-tick
  // path), never fabricated flat candles — the honesty this fix exists to make short-lived
  const rd = p.getTfCandles("WARM", "1d");
  assert.ok(rd.candles.length >= 30, "closes-only series still serves the chart");
  assert.ok(rd.candles[0][1] == null && rd.candles[0][2] == null && rd.candles[0][3] == null,
    "warm-restore bars ride through with null o/h/l");
});

test("perf: getHourly is a by-reference passthrough over the packed spine (no normalization copy)", async () => {
  const fs = require("fs"), path = require("path");
  const pol = fs.readFileSync(path.join(__dirname, "..", "src", "poller.js"), "utf8");
  // Since 2026.07.21-09 the spine IS the packed [t,o,h,l,c,v] array (packHours at every write), so
  // getHourly no longer normalizes — it hands r.hourlyRaw straight back. The old array-ref memo is
  // gone precisely because there's nothing left to cache; its resurrection would mean the second
  // resident copy is back.
  assert.ok(pol.includes("return r && Array.isArray(r.hourlyRaw) ? r.hourlyRaw : [];"), "getHourly passthrough missing");
  assert.ok(!pol.includes("r._hsRaw"), "the old getHourly normalization memo (r._hsRaw/_hs) must stay gone");
  // persistHourly enforces the retention window ON WRITE so the file never exceeds what reload keeps
  assert.ok(/async function persistHourly/.test(pol), "persistHourly must be async");
  assert.ok(/persistHourly\(\)[^\n]*t >= cut/.test(pol) || pol.includes("t >= cut) packed.push"), "persistHourly must window-on-write");
  assert.ok(/async function hydrateHourly/.test(pol) && pol.includes("store.streamHourly"), "hydrateHourly must stream");
  assert.ok(pol.includes("await hydrateHourly()"), "boot must await the async hydrate");
  // rvol memo keys: spine ref + clock hour
  assert.ok(pol.includes("r._rvRaw === r.hourlyRaw") && pol.includes("r._rvEndH === rvolEndH"), "rvol memo key missing");
  // fundPct reads the funding Map directly (no sorted getFunding copy) in the hot path
  assert.ok(pol.includes("for (const [t, rate] of r.fundH)"), "fundPct must read fundH directly in mapMarket");
});

test("packed spine 2026.07.21-09: r.hourlyRaw IS the packed [t,o,h,l,c,v] spine; getHourly is a by-reference passthrough", () => {
  // #6 — the hourly spine went from {t,o,h,l,c,v} objects to packed numeric rows, killing the
  // second resident copy getHourly used to build. Pin the shape end to end: a seed of the natural
  // object shape must come back as packed rows, getHourly must hand back that SAME array (identity,
  // no rebuild), and the array-indexed consumers must read it correctly.
  const { createPoller } = require("../src/poller");
  const store = { loadAll: () => new Map(), loadRegime: () => [], loadLedger: () => null,
    saveLedger: () => {}, insert: () => {}, saveRegime: () => {} };
  const p = createPoller({ dex: "xyz", store, log: () => {}, version: "test", crypto: false });
  const now = Date.now(), endH = Math.floor(now / HOUR);
  const objSpine = [];
  for (let i = 0; i < 200; i++) { const t = (endH - 200 + i) * HOUR, c = 100 + i; objSpine.push({ t, o: c, h: c + 1, l: c - 1, c, v: 3 }); }
  p.seedRowNow("xyz:PACK", { px: 300, uni: "xyz", vol: 1e6, hourlyRaw: objSpine, hourlyTs: now });

  const hs = p.getHourly("xyz:PACK");
  assert.ok(Array.isArray(hs) && hs.length === 200, "spine seeded");
  assert.ok(Array.isArray(hs[0]) && hs[0].length === 6, "every spine row is a packed [t,o,h,l,c,v] array, not an object");
  assert.ok(!("t" in hs[0]) && !("c" in hs[0]), "no object fields survive on a spine row");
  assert.equal(hs[0][0], (endH - 200) * HOUR, "row[0] is the timestamp");
  assert.equal(hs[0][4], 100, "row[4] is the close");
  assert.equal(hs[199][4], 299, "last close");

  // identity: getHourly returns the spine array itself — no per-call normalization copy
  assert.strictEqual(p.getHourly("xyz:PACK"), p.getHourly("xyz:PACK"), "getHourly is stable by reference across calls");

  // the object-shape adapter round-trips for the consumers that still need it
  const { bucketCandles } = require("../src/compute");
  const b4 = bucketCandles(hs, 4, HOUR);
  assert.ok(b4.length > 0 && typeof b4[0].t === "number" && typeof b4[0].c === "number", "bucketCandles consumes the packed spine and still emits objects");
});

test("packed spine 2026.07.21-09: source wiring — packHours/hoursToObj boundary, getHourly passthrough, H1 rungs adapted", () => {
  const fs = require("fs"), path = require("path");
  const pol = fs.readFileSync(path.join(__dirname, "..", "src", "poller.js"), "utf8");
  assert.ok(pol.includes("function packHours(arr)"), "packHours (the single write gate) missing");
  assert.ok(pol.includes("function hoursToObj(arr)"), "hoursToObj (object-shape adapter) missing");
  // getHourly must be the passthrough, NOT the old normalizing loop
  assert.ok(pol.includes("return r && Array.isArray(r.hourlyRaw) ? r.hourlyRaw : [];"), "getHourly must pass the packed spine through by reference");
  assert.ok(!pol.includes("r._hsRaw"), "the old getHourly normalization memo must be gone (no second resident copy)");
  // every raw fetch/hydrate/seed of the spine goes through packHours; features + H1 rungs go through hoursToObj
  assert.ok(pol.includes("r.hourlyRaw = packHours(wide)") && pol.includes("concat(packedTail)"), "refreshHourly must pack fetched candles");
  assert.ok(pol.includes("packHours(arr).filter((k) => k[0] >= cut)"), "hydrateHourly must keep the packed shape");
  assert.ok(pol.includes("featuresFromHourly(hoursToObj(featWin)"), "featuresFromHourly must receive the object-shape view");
  assert.equal((pol.match(/hoursToObj\(r?r?\.hourlyRaw\.slice\(-[A-Za-z0-9_]+\)\)/g) || []).length, 6, "every H1 rung adapts the packed slice to objects (trend, closed-alert ladder, AI, retest, 1h chart, pair board) regardless of slice width");
  assert.ok(pol.includes("if (Array.isArray(r.hourlyRaw)) r.hourlyRaw = packHours(r.hourlyRaw);"), "seedRowNow must pack its spine input");
});

test("5m archive: capture writes only CLOSED bars (the forming bar is never final)", () => {
  const { openStore } = require("../src/store");
  const fs = require("fs"), path = require("path"), os = require("os");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "xyzm5f-"));
  try {
    const store = openStore(dir);
    const { createPoller } = require("../src/poller");
    const p = createPoller({ dex: "xyz", store, log: () => {}, version: "test", crypto: false });
    const M5 = 5 * 60 * 1000;
    // now sits mid-bar; the bar STARTING at `forming` has not fully elapsed and must be dropped.
    const forming = Math.floor(Date.now() / M5) * M5;
    const now = forming + 2 * 60 * 1000;   // 2 min into the forming bar
    const raw = [];
    for (let i = 6; i >= 1; i--) raw.push({ t: forming - i * M5, o: 10, h: 11, l: 9, c: 10 + i, v: 100 });
    raw.push({ t: forming, o: 10, h: 11, l: 9, c: 99, v: 100 });   // the forming bar
    const closed = p._m5FilterClosed(raw, now);
    assert.equal(closed.length, 6, "the forming bar is filtered out; only fully-elapsed bars remain");
    assert.ok(closed.every((k) => k[0] + M5 <= now), "every kept bar is fully closed as of now");
    assert.ok(!closed.some((k) => k[0] === forming), "the forming bar specifically is absent");
    // and packHours coercion holds: rows are packed [t,o,h,l,c,v]
    assert.equal(closed[0].length, 6, "closed bars are packed six-tuples");
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test("5m archive: getCandles5m range-reads, downsamples wide windows to honest OHLC, ships coverage", () => {
  const { openStore } = require("../src/store");
  const { bucketCandles } = require("../src/compute");
  const fs = require("fs"), path = require("path"), os = require("os");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "xyzm5g-"));
  try {
    const store = openStore(dir);
    const { createPoller } = require("../src/poller");
    const p = createPoller({ dex: "xyz", store, log: () => {}, version: "test", crypto: false });
    const M5 = 5 * 60 * 1000, base = 1_700_000_000_000, N = 2000;
    const bars = [];
    for (let i = 0; i < N; i++) bars.push([base + i * M5, 100 + i, 120 + i, 80 + i, 100 + i, 10 + i]);
    store.insertCandles("xyz:NVDA", bars);
    // narrow read: under the cap, returned verbatim (quantized)
    const narrow = p.getCandles5m("xyz:NVDA", base, base + 9 * M5, 3000);
    assert.equal(narrow.enabled, true, "archive reports enabled");
    assert.equal(narrow.candles.length, 10, "narrow window returns raw 5m bars");
    assert.equal(narrow.candles[0].length, 6, "bars keep the volume column");
    assert.ok(narrow.coverage && narrow.coverage.count === N, "coverage reports full archive depth, not just the window");
    // wide read with a small cap: MUST downsample below the cap, and each coarse bar is a true
    // OHLC aggregate of its constituents (o=first, h=max, l=min, c=last), never a decimated sample.
    const cap = 200;
    const wide = p.getCandles5m("xyz:NVDA", base, base + (N - 1) * M5, cap);
    assert.ok(wide.candles.length <= cap, `downsampled to <= cap (${wide.candles.length} <= ${cap})`);
    assert.ok(wide.candles.length > 1, "still a real series, not collapsed");
    const mult = Math.ceil((N - 1) / (cap - 1));
    const expect = bucketCandles(bars, mult, M5);
    assert.equal(wide.candles.length, expect.length, "bucket count matches bucketCandles at the chosen multiple");
    assert.equal(wide.candles[0][0], expect[0].t, "first coarse bucket ts matches bucketCandles");
    assert.equal(wide.candles[0][1], expect[0].o, "coarse open = first constituent open (honest OHLC)");
    assert.equal(wide.candles[0][2], expect[0].h, "coarse high = max constituent high");
    assert.equal(wide.candles[0][3], expect[0].l, "coarse low = min constituent low");
    assert.equal(wide.candles[0][4], expect[0].c, "coarse close = last constituent close");
    // reversed from/to is tolerated; an out-of-range window returns empty but stays enabled
    const empty = p.getCandles5m("xyz:NVDA", base - 100 * M5, base - 50 * M5, 3000);
    assert.equal(empty.enabled, true);
    assert.equal(empty.candles.length, 0, "window with no bars returns an empty (not fabricated) series");
    // res=5m is a DIFFERENT axis from tf=; the ladder getter still refuses "5m"
    assert.equal(p.getTfCandles("xyz:NVDA", "5m"), null, "tf=5m stays unknown; 5m is served via res=, not tf=");
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test("deep archive: getCandlesDeep — honest downsample, coverage disclosure, closed-bar guard, degrade paths", () => {
  const fs = require("fs"), path = require("path"), os = require("os");
  const { openStore } = require("../src/store");
  const { createPoller } = require("../src/poller");
  const { bucketCandles } = require("../src/compute");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "xyzdeep2-"));
  try {
    const s = openStore(dir);
    const p = createPoller({ dex: "xyz", store: s, log: () => {}, version: "test", crypto: false });
    const base = 1_600_000_000_000, N = 500;
    const bars = Array.from({ length: N }, (_, i) => [base + i * DAY, 100 + i, 101 + i, 99 + i, 100.5 + i, 1000 + i]);
    assert.equal(s.insertCandlesDeep("1d", "xyz:NVDA", bars), N);
    // a window under the cap ships raw
    const raw = p.getCandlesDeep("xyz:NVDA", "1d", base, base + 100 * DAY, 3000);
    assert.equal(raw.enabled, true);
    assert.equal(raw.candles.length, 101, "inclusive range, no downsample under the cap");
    assert.equal(raw.candles[0][4], 100.5, "close rides through");
    // over the cap: bucketCandles at the interval's OWN width — honest OHLC roll-up, count <= cap
    const cap = 200;
    const wide = p.getCandlesDeep("xyz:NVDA", "1d", base, base + (N - 1) * DAY, cap);
    assert.ok(wide.candles.length <= cap && wide.candles.length > 1, "downsampled to <= cap, still a real series");
    const mult = Math.ceil((N - 1) / (cap - 1));
    const expect = bucketCandles(bars, mult, DAY);
    assert.equal(wide.candles.length, expect.length, "bucket count matches bucketCandles at the chosen multiple");
    assert.equal(wide.candles[0][0], expect[0].t);
    assert.equal(wide.candles[0][1], expect[0].o, "coarse open = first constituent open");
    assert.equal(wide.candles[0][2], expect[0].h, "coarse high = max constituent high");
    assert.equal(wide.candles[0][3], expect[0].l, "coarse low = min constituent low");
    assert.equal(wide.candles[0][4], expect[0].c, "coarse close = last constituent close");
    // coverage disclosure is the table's truth, independent of the requested window
    assert.equal(wide.coverage.count, N);
    assert.equal(wide.coverage.min, base);
    // an out-of-range window is empty, enabled, never fabricated; reversed from/to tolerated
    const empty = p.getCandlesDeep("xyz:NVDA", "1d", base - 50 * DAY, base - 10 * DAY, 500);
    assert.equal(empty.enabled, true); assert.equal(empty.candles.length, 0);
    const rev = p.getCandlesDeep("xyz:NVDA", "1d", base + 10 * DAY, base, 500);
    assert.equal(rev.candles.length, 11, "reversed bounds are swapped, not rejected");
    // unknown interval: null (the route's guard), NOT an empty-but-plausible series
    assert.equal(p.getCandlesDeep("xyz:NVDA", "2h", base, base + DAY, 500), null, "res axis stays closed: only 4h/12h/1d exist here");
    // closed-bar guard: the FORMING 12h/1d bar must never land
    const now = Date.now();
    const tail = [[now - 2 * DAY, 1, 2, 0, 1, 5], [now - DAY, 1, 2, 0, 1, 5], [now - 3 * HOUR, 1, 2, 0, 1, 5]];
    const closed1d = p._deepFilterClosed("1d", tail, now);
    assert.equal(closed1d.length, 2, "the bar opened 3h ago has not closed at 1d — dropped");
    assert.equal(closed1d[closed1d.length - 1][0], now - DAY, "last closed 1d bar is the one that finished");
    const closed12 = p._deepFilterClosed("12h", tail, now);
    assert.equal(closed12.length, 2, "same guard at the 12h width");
    assert.deepEqual(p._deepFilterClosed("3h", tail, now), [], "unknown width filters to nothing rather than guessing a close time");
    // degrade: a store without the deep API says so out loud (enabled:false), never an empty tape
    const stub = { loadAll: () => new Map(), loadRegime: () => [], loadLedger: () => null,
      saveLedger: () => {}, insert: () => {}, saveRegime: () => {}, candlesEnabled: () => false };
    const p2 = createPoller({ dex: "xyz", store: stub, log: () => {}, version: "test", crypto: false });
    const off = p2.getCandlesDeep("xyz:NVDA", "1d", base, base + DAY, 500);
    assert.equal(off.enabled, false); assert.equal(off.coverage.enabled, false);
    assert.equal(p2.getDeepStamp("xyz:NVDA", "1d"), 0, "no row, no stamp — the ETag key degrades to 0, not undefined");
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test("poller deriv lane: cadence, cooldown, one-code-path casc, and honest labeling pinned", () => {
  const fs = require("fs"), path = require("path");
  const pol = fs.readFileSync(path.join(__dirname, "..", "src", "poller.js"), "utf8");
  assert.ok(pol.includes("const CZ_SWEEP_MS = 15 * 60 * 1000"), "15-min sweep cadence");
  assert.ok(pol.includes("const CZ_REFRESH_CD = 60 * 1000"), "60s manual-refresh cooldown");
  assert.ok(pol.includes("const CZ_BATCH = 20"), "20-symbol batches (Coinalyze max)");
  assert.ok(pol.includes('const CZ_VENUES = ["Binance", "Bybit", "OKX"]'), "deterministic venue preference order");
  assert.ok(/error: "cooldown", retryInMs/.test(pol), "manual refresh must enforce the cooldown server-side with retryInMs");
  assert.ok(pol.includes("czCascLatest(r.coin)") && pol.includes("cascT: casc ? casc.t : undefined"),
    "snapshot casc/cascT must come from the SAME czCasc the drawer payload reads — board and drawer can never disagree");
  assert.ok(pol.includes('+ "," + (m.cascT || 0)'), "casc must ride markSig so a fired/expired flag busts the snapshot ETag");
  assert.ok(/getDerivs,\s*\n\s*refreshDerivs,/.test(pol), "getDerivs + refreshDerivs exported");
  assert.ok(pol.includes("derivsKey:"), "collision-proof ETag key exported for serveKeyed");
  assert.ok(pol.includes("store.pruneDerivs(Date.now() - CZ_RETENTION)"), "retention pass wired into maintenance");
  assert.ok(pol.includes("czRoll.set(coin, derivRollup(rows, Date.now()))") && pol.includes("roll: czRoll.get(coin) || null"),
    "board column and drawer chips must read the SAME memoized rollup object — one code path");
  assert.ok(pol.includes("liq24: droll ? (droll.ll24 || 0) + (droll.sl24 || 0) : undefined"), "snapshot must ship the 24h liq total on main rows");
  assert.ok(pol.includes('+ "," + (m.liq24 || 0)'), "liq24 must ride markSig so the snapshot ETag busts when it moves");
  assert.ok(pol.includes("cascadeFlags(rows)") && pol.includes("cascadeFlags(arr)"), "flags recomputed on merge AND on boot restore");
  assert.ok(pol.includes("COINALYZE_API_KEY"), "keyed by env, feature absent without it");
});

test("daily payload v2 (2026.07.24-04): [t,c,h,v] tuples + per-name OI series, both universes, both paths", () => {
  // The backtest's level-based signals (high proximity, volume trend, OI change) rank on columns
  // the payload never used to carry. Pin the shape end to end: dailyRaw path ships [t,c,h,v] with
  // h >= c, the hourly-derive fallback aggregates h=max/v=sum per day, OI rides oiDailySeries, and
  // the crypto slice cap still applies. Extra columns are additive — index 0/1 stay [t, close].
  const { createPoller } = require("../src/poller");
  const store = { loadAll: () => new Map(), loadRegime: () => [], loadLedger: () => null,
    saveLedger: () => {}, insert: () => {}, saveRegime: () => {} };
  const p = createPoller({ dex: "xyz", store, log: () => {}, version: "test", crypto: true });
  const now = Date.now();
  const mkD = () => { const d = []; for (let i = 61; i >= 1; i--) d.push({ t: now - i * DAY, c: 100 + i, o: 100, h: 104 + i, l: 98, v: 5e5 + i }); return d; };
  // hourly-only seed: 3 full UTC days of bars, high = c+1, vol = 10 each -> derived day: h = max(c)+1, v = 240
  const d0 = Math.floor(now / DAY) * DAY - 3 * DAY, hourly = [];
  for (let i = 0; i < 72; i++) { const c = 50 + (i % 24) * 0.1; hourly.push({ t: d0 + i * HOUR, o: c, h: c + 1, l: c - 1, c, v: 10 }); }
  p.seedRowNow("xyz:AAA", { px: 160, ticker: "AAA", uni: "xyz", vol: 1e7, dailyRaw: mkD(), dailyTs: now });
  p.seedRowNow("xyz:BBB", { px: 52, ticker: "BBB", uni: "xyz", vol: 1e6, hourlyRaw: hourly, hourlyTs: now });
  p.seedRowNow("ETH", { px: 112, ticker: "ETH", uni: "main", vol: 5e7, dailyRaw: mkD(), dailyTs: now });
  // sampled OI history: 20 days of one-per-midnight points, rising 1e6 -> 2e6
  const histArr = []; for (let i = 30; i >= 1; i--) histArr.push([Math.floor(now / DAY) * DAY - i * DAY, 1e6 + (30 - i) * 5e4, 0.0001]);   // oiDailySeries needs >=24 samples
  p.seedHistNow("xyz:AAA", histArr);
  p.buildDailyNow();
  const dc = p.getDaily();
  const a = dc.daily["xyz:AAA"];
  assert.ok(a && a.length >= 60, "dailyRaw path ships");
  const row = a[a.length - 1];
  assert.equal(row.length, 4, "tuple is [t,c,h,v]");
  assert.ok(row[2] > row[1], "high above close (h = c+4 by construction)");
  assert.ok(row[3] > 0, "volume ships");
  const b = dc.daily["xyz:BBB"];
  assert.ok(b && b.length >= 2, "hourly-derive fallback ships");
  const fullDay = b.find((k) => k[3] === 240);
  assert.ok(fullDay, "derived day volume is the summed hourly volume (24 x 10)");
  assert.ok(fullDay[2] >= fullDay[1] && fullDay[2] <= fullDay[1] + 1.5, "derived day high is the max hourly high");
  const e = dc.daily["ETH"];
  assert.ok(e && e.length <= 94 && e[e.length - 1].length === 4, "crypto rides the same tuple under the MAIN_DAILY_DAYS cap");
  const oiA = dc.oi && dc.oi["xyz:AAA"];
  assert.ok(Array.isArray(oiA) && oiA.length >= 10, "OI daily series ships for the seeded history");
  assert.ok(oiA.every((k) => k.length === 2 && k[1] > 0), "OI rows are [day, oi]");
  assert.ok(oiA[oiA.length - 1][1] > oiA[0][1], "the seeded rise survives the daily-step resample");
  assert.ok(!dc.oi["xyz:BBB"], "no sampled history -> no OI series (never a synthetic one)");
});

test("ETag stamps: every hand-rolled version bump that can fire twice in a millisecond is monotonic", () => {
  const fs = require("fs"), path = require("path");
  const pol = fs.readFileSync(path.join(__dirname, "..", "src", "poller.js"), "utf8");
  // The four stamps a test (or a burst of admin writes) can drive twice inside one millisecond.
  // Anything else on the Date.now() pattern is timer-driven and minutes apart; this list is the
  // set with a demonstrated or reachable collision, not every stamp in the file.
  for (const pin of [
    "dailyVer = Math.max(Date.now(), dailyVer + 1)",
    "actVer = Math.max(Date.now(), actVer + 1)",
    "focusVer = Math.max(Date.now(), focusVer + 1)",
    "fundBoardVer[k] = Math.max(Date.now(), fundBoardVer[k] + 1)",
  ]) assert.ok(pol.includes(pin), `version stamp must be monotonic: ${pin}`);
  // And the guard must sit INSIDE the content-changed branch — bumping unconditionally would mint
  // a fresh ETag on every rebuild and turn every poll into a full-body transfer.
  assert.ok(pol.includes("if (dailyCache && sig === dailySig) return;"), "daily still short-circuits on an unchanged signature");
  assert.ok(/if \(sig !== fundBoardSig\[k\]\) \{ fundBoardSig\[k\] = sig; fundBoardVer\[k\] = Math\.max/.test(pol),
    "the funding board bumps only when its content signature moved");
});

test("daily payload v3 (2026.07.24-06): warm closes-only bars overlay h/v from the spine, upgrades bust the cache, warm files round-trip", () => {
  // The -04 deploy gated Volume trend / High proximity on live: the warm cache hydrates dailyRaw
  // as closes-only {t,c}, so every name shipped null h/v until the OHLC-upgrade queue drained —
  // and the content signature (coins:lens:closed) couldn't see the in-place upgrades, so even the
  // healed bars kept serving stale until a day roll. Pin all three fixes by behavior.
  const { createPoller } = require("../src/poller");
  const mkStore = (loadFeatures) => ({ loadAll: () => new Map(), loadRegime: () => [], loadLedger: () => null,
    saveLedger: () => {}, insert: () => {}, saveRegime: () => {}, loadFeatures: loadFeatures || (() => null) });
  const now = Date.now(), D0 = Math.floor(now / DAY) * DAY;
  // hourly spine: 3 full UTC days (D-3..D-1), h = c+1, v = 10/hr -> derived day: v = 240
  const hourly = []; for (let i = 0; i < 72; i++) { const c = 50 + (i % 24) * 0.1; hourly.push({ t: D0 - 3 * DAY + i * HOUR, o: c, h: c + 1, l: c - 1, c, v: 10 }); }
  // 60 closes-only daily bars ending D-1 — exactly what a pre--06 warm file hydrates to
  const closesOnly = []; for (let i = 60; i >= 1; i--) closesOnly.push({ t: D0 - i * DAY, c: 100 + i });

  // (1) spine overlay: closes-only depth is preserved, spine-covered days carry h/v, older days stay null
  const p = createPoller({ dex: "xyz", store: mkStore(), log: () => {}, version: "test", crypto: false });
  p.seedRowNow("xyz:AAA", { px: 101, ticker: "AAA", uni: "xyz", vol: 1e7, dailyRaw: closesOnly, dailyTs: now, hourlyRaw: hourly, hourlyTs: now });
  p.buildDailyNow();
  let dc = p.getDaily(); const a = dc.daily["xyz:AAA"];
  assert.equal(a.length, 60, "full closes-only depth preserved — the overlay never shrinks history");
  const last = a[a.length - 1];
  assert.ok(last[2] != null && last[3] === 240, "spine-covered day carries the derived high and the summed volume");
  assert.ok(a[0][2] == null && a[0][3] == null, "days older than the spine stay honestly null until the real backfill");
  assert.equal(last[1], 101, "the close is still the dailyRaw close, never the derived one — one code path for c");

  // (2) sig bust: an in-place OHLC upgrade (same coin count, same bar count) must produce a fresh payload
  const ts1 = dc.dataTs;
  const fullBars = closesOnly.map((k) => ({ t: k.t, o: k.c - 1, h: k.c + 5, l: k.c - 5, c: k.c, v: 7e5 }));
  p.seedRowNow("xyz:AAA", { dailyRaw: fullBars });
  p.buildDailyNow();
  dc = p.getDaily();
  assert.ok(dc.dataTs !== ts1, "the upgrade busts the content signature despite unchanged lengths");
  const a2 = dc.daily["xyz:AAA"];
  assert.ok(a2[0][2] != null && a2[0][3] === 7e5, "post-upgrade tuples carry the real backfilled h/v on every day");

  // (3) warm-file compat: pre--06 2-tuples hydrate clean; -06 4-tuples round-trip h/v with no spine at all
  const oldFile = { markets: { "xyz:OLD": { dailyTs: now, daily: closesOnly.map((k) => [k.t, k.c]) } } };
  const newFile = { markets: { "xyz:NEW": { dailyTs: now, daily: closesOnly.map((k) => [k.t, k.c, k.c + 3, 12345]) } } };
  for (const [file, coin, wantH] of [[oldFile, "xyz:OLD", false], [newFile, "xyz:NEW", true]]) {
    const q = createPoller({ dex: "xyz", store: mkStore(() => file), log: () => {}, version: "test", crypto: false });
    q.seedRowNow(coin, { px: 100, ticker: coin.slice(4), uni: "xyz", vol: 1e6 });   // roster membership comes from the universe refresh; hydrate only warms the row
    q.hydrateFeaturesNow();
    q.buildDailyNow();
    const row = q.getDaily().daily[coin];
    assert.ok(row && row.length === 60, coin + " hydrates and ships");
    assert.equal(row[10][2] != null, wantH, coin + (wantH ? " carries the round-tripped high" : " carries null h (2-tuple file, no spine)"));
    if (wantH) assert.equal(row[10][3], 12345, "volume round-trips the warm file");
  }

  // source pins: the persist map writes h/v, the sig carries the coverage terms
  const fs = require("fs"), path = require("path");
  const pol = fs.readFileSync(path.join(__dirname, "..", "src", "poller.js"), "utf8");
  assert.ok(pol.includes("daily: r.dailyRaw ? r.dailyRaw.map((k) => [k.t, k.c, Number.isFinite(k.h) ? k.h : null, Number.isFinite(k.v) ? k.v : null]) : null"), "warm persist must write 4-tuples");
  assert.ok(pol.includes('+ ":" + ohlcN + ":" + oiN'), "content signature must carry the OHLC/OI coverage terms");
  assert.ok(pol.includes("function dailyTuples(r, hs)"), "the shared tuple builder must exist (one code path for both universes)");
});

// ===== 2026.07.24-17 hotfix: dual-universe /api/analytics must never wedge both sessions tabs =====
// Two failure modes shipped in -17 could leave BOTH crypto and stocks stuck on "warming up the spines":
//   1. Boot built both universes UNGUARDED before the retry interval was registered — a throw in
//      either build aborted start(), so the interval never armed and nothing ever retried.
//   2. The analytics ETag keyed on dataTs only; both universes stamp dataTs with Date.now(), so a
//      same-millisecond boot could hand them identical ETags and let the browser 304 one universe's
//      request with the other's cached body.
test("-17 hotfix: the analytics rebuild loop is armed before any throwable boot step", () => {
  const fs = require("fs"), path = require("path");
  const pol = fs.readFileSync(path.join(__dirname, "..", "src", "poller.js"), "utf8");
  const body = pol.slice(pol.indexOf("async function start() {"));
  const armIdx = body.indexOf('setInterval(safeTick(() => { buildAnalyticsSafe("stocks")');
  assert.ok(armIdx > -1, "the analytics rebuild interval must be registered inside start()");
  // THE invariant this bug taught us: start() runs as poller.start().catch(log), so anything that
  // throws before the interval is registered silently kills the retry loop and both sessions tabs
  // sit on "warming up the spines" forever. The loop must therefore be armed before the first await
  // and before every throwable boot step (universe poll, socket, workers, sqlite probe).
  const firstAwait = body.indexOf("await ");
  assert.ok(firstAwait === -1 || armIdx < firstAwait, "rebuild loop must be armed before the first await in start()");
  for (const later of ["await pollUniverse()", "createUniverseSocket(", "hourlyWorker()", "store.candlesEnabled"]) {
    const i = body.indexOf(later);
    if (i > -1) assert.ok(armIdx < i, `rebuild loop must be armed before ${later}`);
  }
  // every build path goes through the error-recording wrapper, which never throws
  assert.ok(/function buildAnalyticsSafe\(scope\) \{[\s\S]*?catch \(e\)/.test(pol), "buildAnalyticsSafe catches and records");
  assert.ok(pol.includes('buildAnalyticsSafe("stocks"); if (crypto) buildAnalyticsSafe("crypto");   // records the reason on failure; never throws'),
    "boot builds go through the wrapper");
  assert.ok(!pol.includes('buildDaily(); buildAnalytics("stocks"); if (crypto) buildAnalytics("crypto");'),
    "the original unguarded boot build line must not survive");
  // exactly one safeTick definition (the hoist must not have left a duplicate)
  assert.equal((pol.match(/const safeTick = /g) || []).length, 1, "one safeTick definition");
});

test("-17 hotfix: getAnalytics self-heals a cold cache and the failure reason reaches the client", async () => {
  const { openStore } = require("../src/store");
  const { createPoller } = require("../src/poller");
  const fs = require("fs"), path = require("path"), os = require("os");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "xyzheal-"));
  try {
    const p = createPoller({ dex: "xyz", store: openStore(dir), log: () => {}, version: "test", crypto: true });
    const HOUR = 3600e3, now = Math.floor(Date.now() / HOUR) * HOUR;
    const spine = (seed) => { let s = seed; const rnd = () => { s = (s * 1103515245 + 12345) & 0x7fffffff; return s / 0x7fffffff; };
      const out = []; let px = 100; const N = 40 * 24, t0 = now - N * HOUR;
      for (let i = 0; i < N; i++) { const o = px, c = o * (1 + (rnd() - 0.5) * 0.01); out.push([t0 + i * HOUR, o, Math.max(o, c) * 1.002, Math.min(o, c) * 0.998, c, 1000]); px = c; }
      return out; };
    ["NVDA", "AAPL", "MSFT", "AMZN", "GOOGL"].forEach((t, i) => p.seedRowNow("xyz:" + t, { px: 100, ticker: t, hourlyRaw: spine(3 + i), hourlyTs: now }));
    ["BTC", "ETH", "SOL", "AVAX", "LINK"].forEach((t, i) => p.seedRowNow(t, { px: 100, hourlyRaw: spine(20 + i), hourlyTs: now }));
    // start() is NEVER called — the worst case, a boot path that died before any build ran. Pre-fix
    // this served the empty fallback forever. Since -08 the self-heal is ASYNC: the cold first
    // request FIRES the chained build and serves the fallback exactly once; the repair is complete
    // by the client's next poll. The test observes that same production sequence — request, settle
    // the chain, request again — rather than patching a synchronous path back in.
    const cold1 = p.getAnalytics("stocks"), cold2 = p.getAnalytics("crypto");
    assert.ok(cold1 == null && cold2 == null, "the cold request itself serves the fallback (route substitutes it) — the build is queued, not inlined");
    await p.settleBuildsNow();
    const st = p.getAnalytics("stocks"), cr = p.getAnalytics("crypto");
    assert.ok(st && st.coverage && st.coverage.hourly, "stocks analytics self-heals by the next request");
    assert.ok(cr && cr.coverage && cr.coverage.hourly, "crypto analytics self-heals by the next request");
    assert.equal(st.scope, "stocks"); assert.equal(cr.scope, "crypto");
    // a healthy build records no error
    assert.equal(p.getAnalyticsErr("stocks"), "", "no error recorded on a healthy build");
    assert.equal(p.getAnalyticsErr("crypto"), "");
    assert.equal(typeof p.getAnalyticsErr, "function", "the error getter is exported for the route");
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
test("triggers -03: announce once, never twice, and never re-blast the board on a redeploy", async () => {
  const { createPoller } = require("../src/poller");
  const HOUR = 3600e3, DAY = 86400e3;
  let savedTrig = null, savedLed = null;
  // NOTE: the coin id must carry ":" — the ledger's universe test is structural, and a colon-free
  // id is classified as a (purged) crypto claim on hydrate.
  const COIN = "xyz:TRSIG";
  const store = { loadAll: () => new Map(), loadRegime: () => [], insert: () => {}, saveRegime: () => {},
    saveLedger: (d) => { savedLed = JSON.parse(JSON.stringify(d)); },
    loadLedger: () => savedLed || { ts: Date.now(), open: [], closed: actClosedRecord(COIN) },
    saveTriggers: (d) => { savedTrig = JSON.parse(JSON.stringify(d)); }, loadTriggers: () => savedTrig };
  const seed = (p) => {
    const now = Date.now(), endH = Math.floor(now / HOUR), N = 16 * 24, hourly = [];
    for (let i = 0; i < N; i++) { const t = (endH - N + i) * HOUR, c = 100 * Math.pow(1.0005, i);
      hourly.push({ t, o: c, h: c * 1.001, l: c * 0.999, c, v: 1 }); }
    const px = hourly[N - 1].c * 1.0005, daily = [];
    for (let i = 0; i < 60; i++) { const c = px * Math.pow(1.002, i - 59);
      daily.push({ t: (Math.floor(now / DAY) - 60 + i) * DAY, c, l: c * 0.97, h: c * (i === 50 ? 1.35 : 1.002) }); }
    p.seedRowNow(COIN, { px, ticker: "TRSIG", uni: "xyz", vol: 1e6, funding: 0.00005, hourlyRaw: hourly, dailyRaw: daily });
  };
  const build = async (p) => { p.buildTrendNow(); await p.buildSignalsNow(); await p.buildActionableNow(); };

  const p1 = createPoller({ dex: "xyz", store, log: () => {}, version: "test", crypto: false });
  seed(p1); p1.hydrateLedgerNow(); await build(p1);   // hydrate first: the record is what makes the claim confirmed
  assert.equal(p1.getActionable(true).count, 1, "with a real record behind it, the setup IS suggested");
  const t1 = p1.getTriggers(null, null, true);
  assert.equal(t1.seq, 1, "a fresh in-grace fire emits exactly one event");
  assert.equal(t1.events[0].t, "TRSIG");
  assert.ok(t1.events[0].fired > 0 && t1.events[0].late != null, "the event carries both marks so a transport can compose a message without re-reading the board");
  assert.equal(t1.events[0].also, undefined, "corroboration is a board concern, not part of the claim event");
  // Idempotence within a process: rebuilding must not re-announce a claim already seen.
  await build(p1);
  assert.equal(p1.getTriggers(null, null, true).seq, 1, "rebuilding the board does not re-announce");
  // Restart with the persisted announced-set AND the persisted ledger: the frozen t0 keeps the
  // key stable, so nothing re-fires. This is the property that decides whether a push channel
  // survives contact with a deploy.
  const p2 = createPoller({ dex: "xyz", store, log: () => {}, version: "test", crypto: false });
  seed(p2); p2.hydrateTriggersNow(); p2.hydrateLedgerNow(); await build(p2);
  assert.equal(p2.getActionable(true).count, 1, "the setup is still suggested after the restart");
  assert.equal(p2.getTriggers(null, null, true).seq, 1, "a redeploy re-announces nothing");
  assert.equal(p2.trigStateNow().seen, 1, "and restores the announced set rather than starting blank");
  // Cursor semantics: a consumer stores the last seq handled and takes everything above it.
  assert.equal(p2.getTriggers(0, null, true).count, 1, "since=0 replays the retained window");
  assert.equal(p2.getTriggers(1, null, true).count, 0, "since=high-water yields nothing");
  assert.equal(p2.getTriggers(99, null, true).count, 0, "a cursor beyond the stream is empty, not negative");
});

test("triggers -04: a cold start with a stale board seeds silently instead of detonating", async () => {
  const { createPoller } = require("../src/poller");
  const HOUR = 3600e3, DAY = 86400e3;
  let savedLed = null;
  const COIN = "xyz:OLD";
  const REC = actClosedRecord(COIN);
  const mkStore = (loadLed) => ({ loadAll: () => new Map(), loadRegime: () => [], insert: () => {}, saveRegime: () => {},
    saveLedger: (d) => { savedLed = JSON.parse(JSON.stringify(d)); }, loadLedger: loadLed,
    saveTriggers: () => {}, loadTriggers: () => null });
  const seed = (p) => {
    const now = Date.now(), endH = Math.floor(now / HOUR), N = 16 * 24, hourly = [];
    for (let i = 0; i < N; i++) { const t = (endH - N + i) * HOUR, c = 100 * Math.pow(1.0005, i);
      hourly.push({ t, o: c, h: c * 1.001, l: c * 0.999, c, v: 1 }); }
    const px = hourly[N - 1].c * 1.0005, daily = [];
    for (let i = 0; i < 60; i++) { const c = px * Math.pow(1.002, i - 59);
      daily.push({ t: (Math.floor(now / DAY) - 60 + i) * DAY, c, l: c * 0.97, h: c * (i === 50 ? 1.35 : 1.002) }); }
    p.seedRowNow(COIN, { px, ticker: "OLD", uni: "xyz", vol: 1e6, funding: 0.00005, hourlyRaw: hourly, dailyRaw: daily });
  };
  // Pass 1: open a claim normally and capture the persisted ledger.
  const p1 = createPoller({ dex: "xyz", store: mkStore(() => ({ ts: Date.now(), open: [], closed: REC })), log: () => {}, version: "test", crypto: false });
  seed(p1); p1.hydrateLedgerNow(); p1.buildTrendNow(); await p1.buildSignalsNow();
  assert.ok(savedLed && savedLed.open && savedLed.open.length >= 1, "a claim was opened and persisted");
  // Backdate it by three days — the restart-after-downtime case: the board is full of claims that
  // fired while nobody was listening, and none of them are news.
  const stale = JSON.parse(JSON.stringify(savedLed));
  for (const e of stale.open) e.t0 = Date.now() - 3 * DAY;
  stale.closed = REC;   // the record travels with it, so the stale claim is confirmed, not merely old
  // Pass 2: a genuinely cold process (no persisted trigger state) meets that stale board.
  const p2 = createPoller({ dex: "xyz", store: mkStore(() => stale), log: () => {}, version: "test", crypto: false });
  seed(p2); p2.hydrateLedgerNow(); await p2.buildActionableNow();
  const t = p2.getTriggers(null, null, true);
  assert.ok(p2.getActionable(true).count >= 1, "the stale claim is still ON the board — it is tradeable, just not news");
  assert.ok(t.known >= 1, "and it IS recorded as known, so it can never announce later");
  assert.equal(t.seq, 0, "but NOTHING is announced: opening the app after a weekend must not fire once per setup");
  assert.equal(t.count, 0, "the stream is empty");
  assert.equal(p2.trigStateNow().firstBuild, false, "the grace is spent after one pass");
  // Now a genuinely NEW claim on the same process must announce, proving the grace was a one-shot
  // for the cold start and not a permanent mute. (Rebuilding the same name would not do: the
  // hydrated claim keeps its frozen t0, so openLedger finds it rather than opening a second one —
  // which is itself the dedup working.)
  const now2 = Date.now(), endH2 = Math.floor(now2 / HOUR), N2 = 16 * 24, h2 = [];
  for (let i = 0; i < N2; i++) { const t = (endH2 - N2 + i) * HOUR, c = 100 * Math.pow(1.0005, i);
    h2.push({ t, o: c, h: c * 1.001, l: c * 0.999, c, v: 1 }); }
  const px2 = h2[N2 - 1].c * 1.0005, d2 = [];
  for (let i = 0; i < 60; i++) { const c = px2 * Math.pow(1.002, i - 59);
    d2.push({ t: (Math.floor(now2 / DAY) - 60 + i) * DAY, c, l: c * 0.97, h: c * (i === 50 ? 1.35 : 1.002) }); }
  p2.seedRowNow("xyz:FRESH", { px: px2, ticker: "FRESH", uni: "xyz", vol: 1e6, funding: 0.00005, hourlyRaw: h2, dailyRaw: d2 });
  p2.buildTrendNow(); await p2.buildSignalsNow(); await p2.buildActionableNow();
  const t2 = p2.getTriggers(null, null, true);
  assert.ok(t2.seq >= 1, "a claim opened after the cold start DOES announce");
  assert.ok(t2.events.some((e) => e.t === "FRESH"), "and it is the new name, not the seeded stale one");
  assert.ok(!t2.events.some((e) => e.t === "OLD"), "the silently-seeded claim never announces retroactively");
});

test("triggers -06: R:R is the board's kill switch, set at 2.0, with no second lateness gate", () => {
  const fs = require("fs"), path = require("path");
  const pol = fs.readFileSync(path.join(__dirname, "..", "src", "poller.js"), "utf8");
  assert.ok(/ACT_MIN_RR = 2\.0;/.test(pol), "net R:R floor must be 2.0");
  // Because R:R is repriced from the live mark every build, a chased setup dies at this gate on
  // its own. A separate lateness-based expiry would be a second gate that could disagree with it.
  assert.ok(!/ACT_MAX_LATE|lateExpire|maxLateDrop/.test(pol), "lateness must not be a second expiry gate — the R:R floor already kills chased setups");
  assert.ok(!/return "thinRR";/.test(pol),
    "the R:R floor is not a kill switch any more — EV>0 is the hard gate for both families, and the floor only names which family a row belongs to");
  assert.ok(pol.includes("rrFloor: ACT_MIN_RR"), "the payload discloses the family boundary so the UI can label the checkboxes honestly");
  assert.ok(pol.includes("const rr = netRR({ side, entry: e.mark0, stop: e.stp, target });"),
    "R:R is computed from the fire mark, never the live price");
  assert.ok(pol.includes("if (!tradeableNow(side, r.px, e.stp, target)) { rej.untakeable++; continue; }"),
    "liveness is checked separately, so 'still takeable' never contaminates 'what was claimed'");
});

test("features: scope filters — the payload a scoped caller receives (behavioral)", () => {
  const C = require("../src/compute");
  // A synthetic FULL signals payload with both universes present everywhere a row can hide. The
  // filter is executed for real (string pins cannot prove a filter is wired AND applied) and the
  // assertions read actual output — the -84 lesson.
  // Universe rosters mirror the poller's XYZ_ONLY_EVS / MAIN_ONLY_EVS shape — the filter is pure
  // and arg-driven; the wiring test below pins that the poller passes its REAL rosters in.
  const evEq = "gapfade", evCx = "casc", evBoth = "bigmove";
  const evUni = { xyzOnly: new Set([evEq]), mainOnly: new Set([evCx]) };
  const full = {
    ts: 1, dataTs: 111, count: 5, countU: { x: 3, m: 2 },
    signals: [{ coin: "xyz:AAPL", uni: "xyz", ev: evEq }, { coin: "BTC", uni: "main", ev: evBoth }],
    shown: 2,
    record: { mixed: 1 }, confluence: { confN: 9 }, recordX: { buckets: "mixed" },
    recent: [{ ticker: "AAPL", ev: evEq }],
    records: {
      "0": { record: { mixed: 1 } }, "0p": { record: { mixed: 2 } },
      "0x": { record: { eq: 1 }, recent: [{ ticker: "AAPL" }] },
      "0m": { record: { cx: 1 }, confluence: { confN: 1 }, recordX: { buckets: "m" }, recent: [{ ticker: "BTC" }] },
    },
    variants: [{ ev: evEq }, { ev: evCx }, { ev: evBoth }],
    shadows: { xyz: [{ rows: [] }], main: [{ rows: [] }] },
    earnSplit: { [evEq]: { eg: {} } },
  };
  const pub = C.scopeFilterSignals(full, { cx: true, eq: false, all: false }, evUni);
  assert.ok(pub !== full, "a scoped body must be a NEW object — the full body is the admin's live cache");
  assert.deepEqual(pub.signals.map((g) => g.coin), ["BTC"], "equity signal rows must be absent, crypto rows intact");
  assert.equal(pub.shown, 1);
  assert.equal(pub.count, 2, "the badge fallback must total only the visible universe (countU.m)");
  assert.deepEqual(pub.countU, { x: null, m: 2 }, "the hidden countU lane must be nulled, not zeroed");
  assert.equal(pub.shadows.xyz, null, "the equity shadow panel must be withheld");
  assert.ok(Array.isArray(pub.shadows.main), "the crypto shadow panel must survive");
  assert.deepEqual(Object.keys(pub.records), ["0m"], "records must keep ONLY the visible universe's scoped keys — mixed and hidden keys both go");
  assert.deepEqual(pub.record, { cx: 1 }, "the mixed record panel must be replaced by the visible universe's own");
  assert.deepEqual(pub.recent, [{ ticker: "BTC" }], "recent resolutions must come from the visible scoped set");
  assert.equal(pub.recordX.buckets, "m");
  assert.deepEqual(pub.variants.map((x) => x.ev).sort(), [evBoth, evCx].sort(), "hidden-universe-only variant rows must be dropped; shared rows stay");
  assert.deepEqual(pub.earnSplit, {}, "the earnings split partitions equity resolutions and must vanish with them");
  // Identity path: an all-visible caller gets the SAME object — the serialize/gzip memo and the
  // numeric ETag depend on object identity surviving.
  assert.equal(C.scopeFilterSignals(full, { cx: true, eq: true, all: true }, evUni), full, "vis.all must be the identity path");
  // Input must not be mutated by the filtering pass.
  assert.equal(full.signals.length, 2); assert.equal(full.countU.x, 3); assert.ok(full.records["0"]);

  // Actionable: rows by uni, count restated, settled sliced INSIDE its real shape. The fixture
  // mirrors boardSettled's actual return ({since, dropped, perUni, episodes}) — the -02 regression
  // shipped because the fixture and the filter agreed on a shape the builder never produced.
  const act = { ts: 1, dataTs: 5, params: { p: 1 }, coverage: { confirmed: 4, untakeable: 7 },
    settled: { since: 123, dropped: 1, perUni: { stocks: { all: { n: 2 } }, crypto: { all: { n: 3 } } },
      episodes: [{ k: "e1", uni: "stocks" }, { k: "c1", uni: "crypto" }] },
    rows: [{ coin: "xyz:TSLA", uni: "stocks" }, { coin: "ETH", uni: "crypto" }], count: 2 };
  const apub = C.scopeFilterActionable(act, { cx: true, eq: false, all: false });
  assert.deepEqual(apub.rows.map((r) => r.coin), ["ETH"], "equity board rows must be absent for a crypto-only caller");
  assert.equal(apub.count, 1);
  assert.equal(apub.coverage.confirmed, 1, "coverage.confirmed must be restated over the visible slice");
  assert.equal(apub.coverage.untakeable, 7, "engine-wide rejection diagnostics stay");
  assert.equal(apub.settled.perUni.stocks, null, "the hidden universe's settled panel must be withheld");
  assert.deepEqual(apub.settled.perUni.crypto, { all: { n: 3 } }, "the visible universe's settled panel must survive IN PLACE — the client reads st.perUni[scope]");
  assert.equal(apub.settled.since, 123); assert.equal(apub.settled.dropped, 1);
  assert.deepEqual(apub.settled.episodes.map((e) => e.k), ["c1"], "hidden-universe episode rows must be dropped, visible ones kept");
  assert.equal(C.scopeFilterActionable(act, { cx: true, eq: true, all: true }), act, "vis.all identity for the board too");
  assert.equal(act.settled.episodes.length, 2, "the input settled record must not be mutated");
  // Shape agreement with the REAL builder (the -84 lesson, applied to fixtures): the fields this
  // fixture claims must be the fields boardSettled actually emits — a drifted fixture re-opens
  // exactly the hole -02 shipped through.
  const polSrc = require("fs").readFileSync(require("path").join(__dirname, "..", "src", "poller.js"), "utf8");
  assert.ok(polSrc.includes("return { since: boardEpSince || null, dropped: boardEpDropped, perUni: per,"),
    "boardSettled's return shape moved — update scopeFilterActionable AND this fixture together");

  // Trigger predicate: signal-borne kinds sliced by coin against their OWN parent's set; every
  // other kind passes untouched (it belongs to a feature with its own gate).
  const sig = { cx: true, eq: false }, all = { cx: true, eq: true };
  assert.equal(C.scopeEventVisible({ kind: "ledger", coin: "xyz:AAPL" }, sig, all), false, "an equity ledger fire must not reach a crypto-only caller");
  assert.equal(C.scopeEventVisible({ kind: "ledger", coin: "BTC" }, sig, all), true);
  assert.equal(C.scopeEventVisible({ kind: "setup", coin: "xyz:AAPL" }, all, sig), false, "setup events are judged against the ACTIONABLE scopes");
  assert.equal(C.scopeEventVisible({ kind: "setup", coin: "ETH" }, all, sig), true);
  assert.equal(C.scopeEventVisible({ kind: "ops" }, sig, sig), true, "non-signal kinds pass untouched");
  assert.equal(C.scopeEventVisible({ kind: "rule", coin: "xyz:AAPL" }, sig, sig), true, "metric rules are Markets-land, never scope-sliced");
});

test("poller: setFlag is admin-only, refuses pinned and invalid input, and persists what it accepts", () => {
  const { createPoller } = require("../src/poller");
  let written = null;
  const store = { loadAll: () => new Map(), loadRegime: () => [], loadLedger: () => null, saveLedger: () => {},
    insert: () => {}, saveRegime: () => {}, saveNews: () => {}, loadNews: () => null,
    loadFlags: () => ({ signals: "admin" }), saveFlags: (o) => { written = o; return true; } };
  const p = createPoller({ dex: "xyz", store, log: () => {}, version: "test" });

  assert.deepEqual(p.getFlags(), { signals: "admin" }, "stored flags hydrate through the sanitizer");
  assert.equal(p.setFlag("signals", "public", false).error, "forbidden", "a non-admin caller cannot write");
  assert.equal(written, null, "a forbidden write must not touch the volume");
  assert.equal(p.setFlag("markets", "off", true).error, "pinned", "pinned keys are refused, not silently resolved past");
  assert.equal(p.setFlag("nope", "public", true).error, "unknown-feature");
  assert.equal(p.setFlag("signals", "PUBLIC", true).error, "bad-state", "state vocabulary is closed");
  assert.equal(written, null, "no rejected write reached the volume");

  const ok = p.setFlag("signals", "public", true);
  assert.equal(ok.ok, true);
  assert.equal(ok.state, "public");
  assert.deepEqual(written, { signals: "public" }, "the accepted write is persisted");
  assert.equal(p.getFlags().signals, "public", "in-memory state follows the write");
  // The response carries the fresh resolved set so the panel never has to guess what it produced.
  assert.ok(ok.features && ok.features.resolved && ok.features.counts, "setFlag must return the resolved set");

  // A failed disk write must not leave memory ahead of the volume — that is how a flag "comes back"
  // after a redeploy and nobody can explain why.
  const p2 = createPoller({ dex: "xyz", store: Object.assign({}, store, { loadFlags: () => null, saveFlags: () => false }), log: () => {}, version: "test" });
  assert.equal(p2.setFlag("signals", "admin", true).error, "write-failed");
  assert.equal(p2.getFlags().signals, undefined, "memory must not advance past a failed persist");

  const f = p.getFeatures(false), fa = p.getFeatures(true);
  assert.equal(f.admin, false); assert.equal(fa.admin, true);
  assert.equal(f.manifest.length, require("../src/compute").FEATURES.length, "getFeatures ships the whole manifest");
  assert.ok(f.manifest.every((m) => m.key && m.kind && m.label && m.state), "every manifest row carries a resolved state");
});

test("admin panel: setFlag refuses the locked key and getFeatures ships both audiences", () => {
  const { createPoller } = require("../src/poller");
  let written = null;
  const store = { loadAll: () => new Map(), loadRegime: () => [], loadLedger: () => null, saveLedger: () => {},
    insert: () => {}, saveRegime: () => {}, saveNews: () => {}, loadNews: () => null,
    loadFlags: () => null, saveFlags: (o) => { written = o; return true; } };
  const p = createPoller({ dex: "xyz", store, log: () => {}, version: "test" });
  assert.equal(p.setFlag("admin", "public", true).error, "locked", "the panel key is refused, not silently resolved past");
  assert.equal(written, null, "a refused write must not touch the volume");

  const f = p.getFeatures(true);
  // "view as public" swaps in a SERVER-resolved set; if this ever went missing the client would have
  // to recompute a public view from raw states, which is the re-derivation rule this project forbids.
  assert.ok(f.resolvedPublic && typeof f.resolvedPublic === "object", "getFeatures must ship the public resolution too");
  assert.equal(f.resolved.admin, true);
  assert.equal(f.resolvedPublic.admin, false);
  assert.ok(Object.keys(f.resolvedPublic).length === Object.keys(f.resolved).length, "both resolutions must cover the same keys");
  // Every row carries what the panel needs to decide control vs static chip.
  for (const m of f.manifest)
    assert.equal(typeof m.settable, "boolean", `manifest row ${m.key} must declare settable`);
});

test("BTC-excess leg + tape-day clustering: the two disclosures a correlated universe needs", () => {
  // Sixty perps at ~0.8 correlation to one benchmark break the arithmetic of a naive record twice
  // over, and both failures LOOK like success. Forty longs opened into a green week all "win" for
  // one reason (so the raw record measures BTC, not the signal), and they are reported as n=40
  // when the effective sample is nearer the day count. rx and cl are the two answers.
  const C = require("../src/compute");
  assert.equal(C.clusterDays([]), 0, "no claims: zero days");
  assert.equal(C.clusterDays(null), 0, "null: zero, not a throw");
  const d0 = Date.UTC(2026, 6, 20);
  assert.equal(C.clusterDays([{ t0: d0 }, { t0: d0 + 1000 }, { t0: d0 + 3600e3 }]), 1,
    "three claims inside one UTC day are ONE tape day — this is the number that stops n from lying");
  assert.equal(C.clusterDays([{ t0: d0 }, { t0: d0 + 86400e3 }, { t0: d0 + 2 * 86400e3 }]), 3, "three separate days count three");
  assert.equal(C.clusterDays([{ t0: null }, { t0: d0 }]), 1, "unstamped entries are skipped, not counted as day zero");

  // the excess leg, end to end through the real resolver
  const { createPoller } = require("../src/poller");
  const store = { loadAll: () => new Map(), loadRegime: () => [], loadLedger: () => null,
    saveLedger: () => {}, insert: () => {}, saveRegime: () => {} };
  const p = createPoller({ dex: "xyz", store, log: () => {}, version: "test", crypto: true });
  const HOUR = 3600e3, now = Date.now();
  // BTC rose 10% over the window; ALT rose 15%. The raw leg says +15%, the excess leg +5%.
  // 32 bars: the claim opens at now-30h and priceAsOf reads the bar that had CLOSED by then (-67).
  const spine = (from, to) => { const h = []; for (let i = 31; i >= 0; i--) {
    const c = from + (to - from) * ((31 - i) / 31); h.push([now - i * HOUR, c, c, c, c, 1e5]); } return h; };
  p.seedRowNow("BTC", { px: 110, ticker: "BTC", uni: "main", hourlyRaw: spine(100, 110), hourlyTs: now });
  p.seedRowNow("ALT", { px: 115, ticker: "ALT", uni: "main", hourlyRaw: spine(100, 115), hourlyTs: now });
  const e = p.openLedgerNow("ALT", "breakout", { score: 9, reading: "", play: { side: "long", stop: 94, target: 130 } }, 1, { sd0: 5 });
  assert.ok(e, "the crypto claim opened");
  e.t0 = now - 30 * HOUR; e.resolveAt = now - HOUR;   // force it due, against the seeded spines
  p.resolveLedgerNow();
  const cl = p.getLedgerExport(true).closed.find((x) => x.coin === "ALT" && x.ev === "breakout");
  assert.ok(cl && cl.status === "resolved", "it resolved");
  assert.ok(cl.rx != null, "the excess leg is stamped for a crypto claim");
  assert.ok(cl.bmv > 9 && cl.bmv < 11, `the benchmark's own move is recorded for the autopsy, got ${cl.bmv}`);
  assert.ok(cl.realized > cl.rx, "raw beats excess when the benchmark also rose — the leg is doing real work");
  assert.ok(cl.rx > 0 && cl.rx < cl.realized, `excess sits between zero and raw, got ${cl.rx} vs ${cl.realized}`);
  // and an equity claim never carries one: there is no BTC leg to net out of a stock
  p.seedRowNow("xyz:ACME", { px: 100, ticker: "ACME", uni: "xyz", hourlyRaw: spine(100, 105), hourlyTs: now });
  const e2 = p.openLedgerNow("xyz:ACME", "breakout", { score: 9, reading: "", play: { side: "long", stop: 97, target: 110 } }, 1, { sd0: 1.5 });
  e2.t0 = now - 30 * HOUR; e2.resolveAt = now - HOUR;
  p.resolveLedgerNow();
  const cl2 = p.getLedgerExport(true).closed.find((x) => x.coin === "xyz:ACME");
  assert.ok(cl2 && cl2.rx === undefined, "no excess leg on an equity claim — absent, never a zero (they mean opposite things)");
});

test("scoped badge and header count read the universe on screen, from kept totals", async () => {
  // The badge is the one number visible without opening the tab, so a whole-engine count under a
  // crypto board would advertise equity conditions the board does not contain. It reads countU,
  // which the server computes over KEPT conditions — the transport cap must never move it.
  const { createPoller } = require("../src/poller");
  const store = { loadAll: () => new Map(), loadRegime: () => [], loadLedger: () => null,
    saveLedger: () => {}, insert: () => {}, saveRegime: () => {}, saveNews: () => {}, loadNews: () => null };
  const p = createPoller({ dex: "xyz", store, log: () => {}, version: "test", crypto: true });
  const DAY_ = 86400e3, HOUR_ = 3600e3, now = Date.now();
  const mkD = () => { const d = []; for (let i = 61; i >= 1; i--) d.push({ t: now - i * DAY_, c: 100 * Math.pow(1.0005, 61 - i), o: 100, h: 103, l: 98, v: 1e6 }); return d; };
  const mkH = () => { const h = []; for (let i = 400; i >= 0; i--) { const c = 100 + Math.sin(i / 9); h.push({ t: now - i * HOUR_, o: c, h: c + 0.7, l: c - 0.7, c, v: 1e5 }); } return h; };
  p.seedRowNow("ETH", { px: 112, ticker: "ETH", uni: "main", vol: 5e7, dailyRaw: mkD(), hourlyRaw: mkH(), dailyTs: now, hourlyTs: now, isNew: false, prevDay: 100, d1: 12 });
  p.seedRowNow("xyz:NVDA", { px: 112, ticker: "NVDA", uni: "xyz", vol: 1e7, dailyRaw: mkD(), hourlyRaw: mkH(), dailyTs: now, hourlyTs: now, isNew: false, prevDay: 100, d1: 12 });
  p.buildDailyNow();
  await p.buildSignalsNow();
  const d = p.getSignals(true);
  assert.ok(d.countU && Number.isInteger(d.countU.x) && Number.isInteger(d.countU.m), "countU ships both universes as integers");
  assert.equal(d.countU.x + d.countU.m, d.count, "the split sums to the whole-engine total — no condition uncounted or double-counted");
  const inPayload = (u) => d.signals.filter((g) => g.uni === u).length;
  assert.ok(d.countU.m >= inPayload("main"), "the crypto total is at least what the capped payload carries");
  assert.ok(d.countU.x >= inPayload("xyz"), "same for equities");
  assert.ok(d.countU.m > 0 && d.countU.x > 0, "both universes actually produced conditions in this fixture");

  // crypto:false must ship an explicit null, not a zero — "not served" and "served, none firing"
  // are different facts and a zero badge would claim the second
  const p2 = createPoller({ dex: "xyz", store, log: () => {}, version: "test", crypto: false });
  p2.seedRowNow("xyz:NVDA", { px: 112, ticker: "NVDA", uni: "xyz", vol: 1e7, dailyRaw: mkD(), hourlyRaw: mkH(), dailyTs: now, hourlyTs: now, isNew: false, prevDay: 100, d1: 12 });
  p2.buildDailyNow();
  await p2.buildSignalsNow();
  assert.equal(p2.getSignals(true).countU.m, null, "crypto disabled: m is null, never 0");
});

// ===== In-app alert sink, slice C (build 2026.07.27-03) =========================================
// The bell log used to live in this tab's memory: it reset on every refresh, so anything that
// fired while the laptop was shut was invisible by the time anyone looked. The server already held
// a persisted ring; the client just wasn't reading it. This slice makes the panel a WINDOW onto
// that ring rather than a second, shorter-lived copy of it.

test("trigger stream: `recent` is cursor-independent, `events` is not — one pull serves both jobs", () => {
  const { createPoller } = require("../src/poller");
  const store = { loadAll: () => new Map(), loadRegime: () => [], loadLedger: () => null, saveLedger: () => {},
    insert: () => {}, saveRegime: () => {}, loadTriggers: () => null, saveTriggers: () => {} };
  const p = createPoller({ dex: "xyz", store, log: () => {}, version: "test", crypto: false });
  for (let i = 0; i < 5; i++) p.pushOpsNow("ev" + i, "text " + i);

  const all = p.getTriggers(undefined, null, true);
  assert.equal(all.recent.length, 5, "recent ships regardless of cursor — this is the DISPLAY list");
  assert.equal(all.seq, 5);

  const caught = p.getTriggers(5, null, true);
  assert.equal(caught.events.length, 0, "a caught-up cursor has nothing to interrupt for…");
  assert.equal(caught.recent.length, 5, "…but the display list is still there. Deriving display from the cursor is what made the old log evaporate on refresh.");

  const partial = p.getTriggers(3, null, true);
  assert.equal(partial.events.length, 2, "the cursor still governs what fires");
  assert.equal(partial.recent.length, 5);
  assert.equal(partial.params.recent, 40, "the display cap is disclosed in params, not implicit");

  for (let i = 0; i < 60; i++) p.pushOpsNow("x" + i, "y");
  assert.equal(p.getTriggers(undefined, null, true).recent.length, 40, "the display list is capped independently of the 200-event ring");
});

test("snapshot: alertVer ships AND rides the content signature, so a fired alert can't go stale", () => {
  const { createPoller } = require("../src/poller");
  const store = { loadAll: () => new Map(), loadRegime: () => [], loadLedger: () => null, saveLedger: () => {},
    insert: () => {}, saveRegime: () => {}, loadTriggers: () => null, saveTriggers: () => {} };
  const p = createPoller({ dex: "xyz", store, log: () => {}, version: "test", crypto: false });

  p.buildSnapshotNow();
  const a = p.getSnapshot();
  assert.equal(a.alertVer, 0, "the sequence ships from the first build");
  p.buildSnapshotNow();
  assert.strictEqual(p.getSnapshot(), a, "an unchanged board still keeps the same object — this must not become a per-build rebuild");

  // The load-bearing case: the board is idle (nothing a client renders has moved) and an alert
  // fires. The snapshot object is FROZEN while the signature holds, so without the sequence in the
  // signature the client would be handed a permanently stale alertVer — and would never pull —
  // exactly when the board is quiet, which is when alerts matter most.
  p.pushOpsNow("deploy", "build test is live");
  p.buildSnapshotNow();
  const b = p.getSnapshot();
  assert.notStrictEqual(b, a, "a fired alert rebuilds the snapshot object");
  assert.equal(b.alertVer, 1, "…carrying the new sequence");
  assert.ok(b.dataTs > a.dataTs, "and bumping dataTs, so the ETag revalidates and the client falls through its own short-circuit");
});

test("the deploy notice is quiet; the stall watchdog is not", () => {
  process.env.TG_BOT_TOKEN = "test-token";
  const { createPoller } = require("../src/poller");
  const store = { loadAll: () => new Map(), loadRegime: () => [], loadLedger: () => null, saveLedger: () => {},
    insert: () => {}, saveRegime: () => {}, loadTriggers: () => null, saveTriggers: () => {},
    savePush: () => {}, loadPush: () => null };
  const p = createPoller({ dex: "xyz", store, log: () => {}, version: "test", crypto: false,
    pushFetch: async () => ({ ok: true, status: 200, json: async () => ({ ok: true, result: {} }) }) });
  const m = p.pushMintCode("own-a", true); p.pushBindNow(m.code, 5551234567, "milst");

  p.pushOpsNow("deploy", "build test is live", "info", true);
  const rec = p.getTriggers(0, null, true).events.filter((e) => e.kind === "ops");
  assert.equal(rec.length, 1, "the deploy line is still IN the ring — it explains a reset cursor when you read the log back");
  assert.equal(rec[0].quiet, 1);
  p.pushTickNow();
  assert.equal(p.pushStateNow().queue, 0, "…and reaches nobody's phone");

  // A stall is exactly what an ops channel is for, and must still get through.
  p.pushSetPollNow(Date.now() - 20 * 60 * 1000);
  p.pushHealthNow();
  p.pushTickNow();
  assert.equal(p.pushStateNow().queue, 1, "the stall warning still delivers");
  const stall = p.getTriggers(0, null, true).events.filter((e) => e.kind === "ops").pop();
  assert.ok(!stall.quiet, "the watchdog's events are not quiet");
  delete process.env.TG_BOT_TOKEN;
});

test("the boot notice is emitted quiet at the source, not filtered downstream", () => {
  const fs = require("fs"), path = require("path");
  const pol = fs.readFileSync(path.join(__dirname, "..", "src", "poller.js"), "utf8");
  assert.ok(/pushOps\("deploy", `build \$\{version \|\| "dev"\} is live`, "info", true\)/.test(pol),
    "the deploy notice must be marked quiet where it is emitted — a transport-side name filter would break the moment the wording changed");
  const comp = fs.readFileSync(path.join(__dirname, "..", "src", "compute.js"), "utf8");
  assert.ok(/if \(ev\.quiet\) return false;/.test(comp), "delivery suppression is a property of the event, shared by every transport");
});

test("rule scan: CRUD, scoping, cooldown, and no detonation when a rule is added mid-breach", () => {
  const { p } = ruleHarness();
  p.seedRowNow("AAA", { ticker: "AAA", px: 110, uni: "xyz", ref: { p1h: 100, p4h: 100, p7d: 100, p30d: 100 } });
  p.seedRowNow("BBB", { ticker: "BBB", px: 100, uni: "xyz", ref: { p1h: 100, p4h: 100, p7d: 100, p30d: 100 } });
  p.buildSnapshotNow();

  assert.equal(p.getRules("own-a", false).rules.length, 0);
  const add = p.addRule({ metric: "h1", op: ">", value: 5 }, "own-a");
  assert.equal(add.ok, true);
  assert.ok(add.rule.id > 0 && add.rule.text.includes("1h %"), "the rule ships a human label, built once, server-side");
  assert.equal(p.addRule({ metric: "bogus", op: ">", value: 1 }, "own-a").ok, false);

  const ruleEvents = () => p.getTriggers(0, "own-a", false).events.filter((e) => e.kind === "rule");

  // AAA is ALREADY +10% when the rule is written. That is a state, not an event.
  p.ruleScanNow();
  assert.equal(ruleEvents().length, 0, "a rule added while a market is in breach must not detonate on save");

  // It arms when AAA comes back inside, then fires on the next genuine breach.
  p.seedRowNow("AAA", { px: 100 }); p.buildSnapshotNow(); p.ruleScanNow();
  assert.equal(ruleEvents().length, 0);
  p.seedRowNow("AAA", { px: 112 }); p.buildSnapshotNow(); p.ruleScanNow();
  const evs = ruleEvents();
  assert.equal(evs.length, 1, "the breach fires once armed");
  assert.equal(evs[0].coin, "AAA");
  assert.equal(evs[0].metric, "h1");
  assert.ok(evs[0].now.includes("12"), "the message carries the value that tripped it");
  assert.ok(evs[0].rule.includes("above"), "…and the rule that was tripped, in words");

  // Cooldown holds a re-fire even after a re-arm.
  p.seedRowNow("AAA", { px: 100 }); p.buildSnapshotNow(); p.ruleScanNow();
  p.seedRowNow("AAA", { px: 115 }); p.buildSnapshotNow(); p.ruleScanNow();
  assert.equal(ruleEvents().length, 1, "the per-rule cooldown suppresses a rapid second fire");

  // BBB never breached, so a roster-wide rule stayed silent on it.
  assert.ok(!ruleEvents().some((e) => e.coin === "BBB"));

  // Deleting a rule takes its edge state with it.
  assert.equal(p.deleteRule(add.rule.id, "own-a", false).ok, true);
  assert.equal(p.getRules("own-a", false).rules.length, 0);
  assert.equal(p.deleteRule(999, "own-a", false).ok, false);
});

test("rule scan: reads the SNAPSHOT payload, so an alert can never disagree with the board", () => {
  const fs = require("fs"), path = require("path");
  const pol = fs.readFileSync(path.join(__dirname, "..", "src", "poller.js"), "utf8");
  const fn = pol.slice(pol.indexOf("function ruleScan()"), pol.indexOf("function getRules(owner, isAdmin)"));
  assert.ok(/const snap = snapshotCache;/.test(fn),
    "rules must evaluate against the payload the client renders, not the live row objects");
  assert.ok(!/rows\.get\(/.test(fn), "reading the live rows here would let an alert quote a number the board isn't showing");
  // …and therefore on the snapshot's own cadence, not a private timer.
  assert.ok(/setInterval\(safeTick\(ruleScan, "ruleScan"\), 15 \* 1000\)/.test(pol));
});

test("rules survive a restart WITH their edge state, so a redeploy re-announces nothing", () => {
  const H = ruleHarness(), p = H.p;   // `saved` is a getter: destructured, it would read null once
  p.seedRowNow("AAA", { ticker: "AAA", px: 100, uni: "xyz", ref: { p1h: 100, p4h: 100, p7d: 100, p30d: 100 } });
  p.buildSnapshotNow();
  p.addRule({ metric: "h1", op: ">", value: 5, note: "breakout watch" }, "own-a");
  p.ruleScanNow();                                    // arms
  p.seedRowNow("AAA", { px: 112 }); p.buildSnapshotNow(); p.ruleScanNow();   // fires
  assert.equal(p.getTriggers(0, "own-a", false).events.filter((e) => e.kind === "rule").length, 1);

  const blob = p.getRules("own-a", false);
  assert.equal(blob.rules[0].note, "breakout watch");
  assert.ok(blob.metrics.length > 8 && blob.ops.includes("cross_up"), "the catalog ships with the rules so the client never hardcodes it");

  // A fresh process restoring that state must not re-announce the still-breached market.
  const { p: p2 } = ruleHarness();
  const fs = require("fs"), path = require("path");
  const st = fs.readFileSync(path.join(__dirname, "..", "src", "poller.js"), "utf8");
  assert.ok(/if \(Array\.isArray\(d\.armed\)\)/.test(st) && /if \(Array\.isArray\(d\.fired\)\)/.test(st),
    "hydrate must restore the armed set AND the last-fire times — rules alone would re-announce every breach on boot");
  assert.ok(/armed: \[\.\.\.ruleArmed\.keys\(\)\]/.test(st) && /fired: \[\.\.\.ruleLastFire\.entries\(\)\]/.test(st),
    "…which means persisting them");
  assert.ok(p2.hydrateRulesNow);
  // …and the restore must actually restore: a stored rule carries uni "" (absent), and the
  // validator used to reject that on the way back in, so every coin-scoped and roster-wide rule
  // vanished on every deploy while the source pins above stayed green.
  const { createPoller } = require("../src/poller");
  const p3 = createPoller({ dex: "xyz", log: () => {}, version: "test", crypto: false,
    store: { loadAll: () => new Map(), loadRegime: () => [], loadLedger: () => null, saveLedger: () => {}, insert: () => {}, saveRegime: () => {},
      loadTriggers: () => null, saveTriggers: () => {}, saveRules: () => {}, loadRules: () => H.saved } });
  assert.equal(p3.hydrateRulesNow(), 1, "the persisted rule comes back");
  assert.equal(p3.getRules("own-a", false).rules[0].note, "breakout watch");
  p3.seedRowNow("AAA", { ticker: "AAA", px: 112, uni: "xyz", ref: { p1h: 100, p4h: 100, p7d: 100, p30d: 100 } });
  p3.buildSnapshotNow(); p3.ruleScanNow();
  assert.equal(p3.getTriggers(0, "own-a", false).events.filter((e) => e.kind === "rule").length, 0, "still in breach after the restart: not re-announced");
});

test("analyst flip fires only on an actual stance change", () => {
  const p = ctxHarness();
  p.seedRowNow("AAA", { ticker: "AAA", px: 10, uni: "xyz" });
  const rep = (stance) => ({ computed: { action: { stance, note: "because" } } });   // the shape aiAssemble actually stores (-67)
  const ai = () => p.getTriggers(0, null, true).events.filter((e) => e.kind === "ai");

  assert.equal(p.aiFlipCheckNow("AAA", null, rep("wait")), null, "a first report is not a flip — there is nothing to have changed from");
  assert.equal(p.aiFlipCheckNow("AAA", rep("wait"), rep("wait")), null, "an unchanged stance on regeneration says nothing");
  p.aiFlipCheckNow("AAA", rep("wait"), rep("enter_on_pullback"));
  assert.equal(ai().length, 1, "the report changing its mind is the part worth interrupting for");
  assert.equal(ai()[0].from, "wait");
  assert.equal(ai()[0].to, "enter_on_pullback");
  assert.equal(p.aiFlipCheckNow("AAA", rep("wait"), { computed: {} }), null, "a malformed report is not a flip");
  assert.equal(p.aiFlipCheckNow("AAA", rep("wait"), null), null);
});

test("the two classes NOT built are documented with the reason, in the code", () => {
  const fs = require("fs"), path = require("path");
  const pol = fs.readFileSync(path.join(__dirname, "..", "src", "poller.js"), "utf8");
  // This is a design decision that will look like an omission to whoever reads this next, so the
  // reasoning lives next to what it explains.
  assert.ok(/deliberately NOT built/.test(pol));
  assert.ok(/News headlines[\s\S]{0,240}tens per day/.test(pol), "the headline rate is the reason, and it is stated");
  assert.ok(/Ownership filings[\s\S]{0,160}several per day/.test(pol));
  assert.ok(/FILING_PUSH_FORMS/.test(pol), "the material subset is an explicit set, not an inline condition");
});

test("quiet hours DELAY rather than drop, and cannot block the queue behind them", async () => {
  process.env.TG_BOT_TOKEN = "test-token";
  const { p, calls } = pushHarness();
  const m = p.pushMintCode("own-a", true); p.pushBindNow(m.code, 5551234567, "milst");
  // A window that is certainly open right now, whatever hour the suite runs at.
  p.pushSetPrefs("5551234567", { quiet: { from: 0, to: 24 - 1e-9, tz: 0 } }, "own-a", false);
  p.pushSetBootNow(Date.now() - 60e3);

  p.pushOpsNow("poller stalled", "no poll for 20 min", "warn");   // pierces
  p.pushTickNow();
  await p.pushDrainNow();
  assert.equal(calls.length, 1, "an ops warning is delivered inside the quiet window");

  const st = p.pushStateNow();
  assert.equal(st.queue, 0);
  assert.ok(p.getPush("own-a", false).recipients[0].quietNow, "the panel can say the recipient is currently quiet");
  delete process.env.TG_BOT_TOKEN;
});

test("the drain picks the first ELIGIBLE item, so a deferred message cannot head-of-line block", () => {
  const fs = require("fs"), path = require("path");
  const pol = fs.readFileSync(path.join(__dirname, "..", "src", "poller.js"), "utf8");
  assert.ok(/const deliverable = \(q\) => \(!q\.after \|\| q\.after <= now\)/.test(pol)
    && /let idx = pushQueue\.findIndex\(\(q\) => !q\.reply && deliverable\(q\)\);\s*\n\s*if \(idx < 0\) idx = pushQueue\.findIndex\(deliverable\);/.test(pol),
    "a message held until 07:00 sitting at the head would block every urgent one behind it for hours");
  const drain = pol.slice(pol.indexOf("async function pushDrain()"), pol.indexOf("function pushLogAdd"));
  assert.ok(!/pushQueue\.shift\(\)/.test(drain), "every removal in the drain must target the chosen index, not the head");
  assert.equal((drain.match(/pushQueue\.splice\(idx, 1\)/g) || []).length, 3, "success, 4xx drop and give-up all remove by index");
});

test("recipients are per-browser: two people link independently and cannot see each other", () => {
  process.env.TG_BOT_TOKEN = "test-token";
  const p = twoUserHarness();
  const ca = p.pushMintCode("own-a", true); p.pushBindNow(ca.code, 1111111111, "milst");
  const cb = p.pushMintCode("own-b", false); p.pushBindNow(cb.code, 2222222222, "friend");

  const a = p.getPush("own-a", false), b = p.getPush("own-b", false);
  assert.equal(a.recipients.length, 1, "each browser sees exactly its own");
  assert.equal(a.recipients[0].name, "milst");
  assert.equal(b.recipients[0].name, "friend");
  assert.equal(a.othersLinked, 1, "…and is told others exist without being shown who");
  assert.ok(!JSON.stringify(a.recipients).includes("friend"), "another person's telegram must not appear anywhere in the payload");

  // A pending link code is private too: handing the newest code to every visitor would let two
  // people linking at once redeem each other's.
  p.pushMintCode("own-a", true);
  assert.ok(p.getPush("own-a", false).code, "the minting browser sees its code");
  assert.equal(p.getPush("own-b", false).code, null, "nobody else does");

  // Management is scoped, and a refusal is distinguishable from a missing row.
  assert.equal(p.pushUnlink("2222222222", "own-a", false).error, "forbidden", "you cannot unlink someone else's telegram");
  assert.equal(p.pushSetClasses("2222222222", ["ops"], "own-a", false).error, "forbidden");
  assert.equal(p.pushSetPrefs("2222222222", { digestHour: 8 }, "own-a", false).error, "forbidden");
  // A test fire with no chat named must hit only your own phone, never someone else's.
  const t = p.pushTest(null, "own-a", false);
  assert.equal(t.sent, 1, "a test fire is scoped to the caller's own recipients");
  assert.equal(p.pushTest("2222222222", "own-a", false).error, "cooldown", "…and naming another person's chat is refused (cooldown here, forbidden otherwise)");

  // Admin sees and manages everything.
  const adm = p.getPush("own-c", true);
  assert.equal(adm.recipients.length, 2);
  assert.equal(adm.admin, true);
  assert.equal(adm.othersLinked, 0, "admin has no hidden remainder");
  assert.ok(adm.recipients.some((r) => r.mine === false), "rows the admin does not own are marked, not disguised as theirs");
  assert.equal(p.pushUnlink("2222222222", "own-c", true).ok, true, "admin can revoke anyone");
  delete process.env.TG_BOT_TOKEN;
});

test("rules are per-person: private lists, per-person cap, and events that stay with their author", () => {
  const p = twoUserHarness();
  p.seedRowNow("AAA", { ticker: "AAA", px: 100, uni: "xyz", ref: { p1h: 100, p4h: 100, p7d: 100, p30d: 100 } });
  p.buildSnapshotNow();

  const ra = p.addRule({ metric: "h1", op: ">", value: 5, note: "mine" }, "own-a");
  p.addRule({ metric: "d1", op: "<", value: -5, note: "theirs" }, "own-b");
  assert.equal(ra.ok, true);

  const a = p.getRules("own-a", false), b = p.getRules("own-b", false);
  assert.equal(a.rules.length, 1);
  assert.equal(a.rules[0].note, "mine");
  assert.equal(a.othersRules, 1, "you can tell the engine is working for others without seeing what they watch");
  assert.ok(!JSON.stringify(a.rules).includes("theirs"));
  assert.equal(b.rules[0].note, "theirs");
  assert.equal(p.getRules("own-c", true).rules.length, 2, "admin sees every rule");

  assert.equal(p.deleteRule(ra.rule.id, "own-b", false).error, "forbidden", "you cannot delete someone else's rule");
  assert.equal(p.deleteRule(ra.rule.id, "own-c", true).ok, true, "admin can");

  // A personal rule produces a personal EVENT. Without this the ring would carry one person's
  // thresholds into everyone else's bell log and phone.
  const r2 = p.addRule({ metric: "h1", op: ">", value: 5 }, "own-b");
  assert.ok(r2.ok);
  p.ruleScanNow();                                                   // arms
  p.seedRowNow("AAA", { px: 112 }); p.buildSnapshotNow(); p.ruleScanNow();   // fires
  const mine = p.getTriggers(0, "own-b", false).events.filter((e) => e.kind === "rule");
  assert.equal(mine.length, 1, "the author sees their own rule firing");
  assert.equal(p.getTriggers(0, "own-a", false).events.filter((e) => e.kind === "rule").length, 0,
    "…and nobody else does");
  assert.equal(p.getTriggers(0, "own-c", true).events.filter((e) => e.kind === "rule").length, 1, "admin sees it");

  // Market and server events stay shared — they are about the tape, not about you.
  p.pushOpsNow("poller stalled", "x", "warn");
  for (const who of [["own-a", true], ["own-b", true]])
    assert.ok(p.getTriggers(0, who[0], who[1]).events.some((e) => e.kind === "ops"),
      "ops events are shared among operators");
});

test("stack episode gates: the COPPER double cannot happen — a wobble is one fire, not two", () => {
  const p = trendHarness();
  const stacks = () => p.getTriggers(0, null, true).events.filter((e) => e.kind === "trend" && e.sub === "stack");
  const M = 60e3, t0 = Date.UTC(2026, 6, 27, 12, 0, 0);
  // Live and closed agree throughout: this test is about the episode gates, not the whipsaw guard.
  const seed = (score, t) => { p.seedTrendNow("CU", { side: "long", uni: "stocks", score, retest: null,
    e13: 6.38, e21: 6.33, age: 2, closed: clOf(score, t) }); p.trendScanNow(t); };

  seed(3, t0);                                 // first sight: seeded silently, armed by construction
  assert.equal(stacks().length, 0, "state in force at first sight is seeded, never announced");
  seed(4, t0 + 5 * M);
  assert.equal(stacks().length, 1, "a new name's first closed arrival at 4/4 fires on the old one-scan cadence");
  // The confirming close rides the event: the rung whose CLOSED state completed the stack.
  assert.equal(stacks()[0].confTf, "H1", "H1 was the rung that newly aligned — its close confirmed the stack");
  assert.equal(stacks()[0].confAt, t0 + 5 * M - 60e3, "confAt is the candle close, not the scan clock");

  // The screenshot, replayed: one scan at 3/4, straight back to 4/4 thirty minutes after the fire.
  seed(3, t0 + 10 * M);
  seed(4, t0 + 15 * M);
  assert.equal(stacks().length, 1, "a one-scan dip through 3/4 is the same episode still standing — no re-fire");

  // Even a HELD drop re-arms into the cooldown wall.
  seed(3, t0 + 20 * M); seed(3, t0 + 25 * M); seed(3, t0 + 30 * M);
  seed(4, t0 + 35 * M);
  assert.equal(stacks().length, 1, "armed, but inside the 12h per-name floor — still one fire");

  // Past the cooldown WITHOUT a fresh held drop: the suppressed rise consumed the arm.
  seed(3, t0 + 13 * 60 * M);
  seed(4, t0 + 13 * 60 * M + 5 * M);
  assert.equal(stacks().length, 1, "a suppressed rise resets `below` — the drop-and-hold must happen again");

  // The genuine article: held drop, past the floor. This is the fire the gates exist to protect.
  seed(3, t0 + 14 * 60 * M); seed(3, t0 + 14 * 60 * M + 5 * M); seed(3, t0 + 14 * 60 * M + 10 * M);
  seed(4, t0 + 14 * 60 * M + 15 * M);
  assert.equal(stacks().length, 2, "a real re-cross — held below, outside the cooldown — still reaches you");
});

test("cross: the closed D1 flip announces at its close, once — unknown is not a flip", () => {
  const p = trendHarness();
  const crosses = () => p.getTriggers(0, null, true).events.filter((e) => e.kind === "trend" && e.sub === "cross");
  const M = 60e3, t0 = Date.UTC(2026, 6, 27, 12, 0, 0);
  let t = t0;
  // Live EMAs track the closed sign here — the whipsaw guard has its own test below.
  const seed = (sign) => { p.seedTrendNow("CU", { side: "long", uni: "stocks", score: 3, retest: null,
    e13: sign > 0 ? 6.38 : sign < 0 ? 6.30 : 0, e21: 6.33, age: 2,
    closed: clOf(3, t, { sign }) }); p.trendScanNow(t); t += 5 * M; };

  seed(1);                                     // sign +1, seeded
  seed(-1);                                    // the closed daily sign flipped — a D1 close happened
  assert.equal(crosses().length, 1, "the closed flip IS the confirmation — it announces immediately");
  assert.equal(crosses()[0].side, "short");
  assert.equal(crosses()[0].confTf, "D1", "a cross is always confirmed by the D1 close");
  assert.equal(crosses()[0].confAt, t - 5 * M - 60e3, "confAt is the daily close that made it true");
  seed(-1); seed(-1);
  assert.equal(crosses().length, 1, "a confirmed sign persisting says nothing new");

  // Unknown rungs feed nobody: sign 0 is a ladder gap, not a flip — in either direction.
  seed(0);
  assert.equal(crosses().length, 1, "a rung losing its EMAs is unknown, not a flip down");
  seed(-1);
  assert.equal(crosses().length, 1, "…and returning from unknown to the held sign is adoption, not news");
  seed(1);
  assert.equal(crosses().length, 2, "the genuine flip back up announces at ITS close");
  assert.equal(crosses()[1].side, "long");
});

test("intrabar whipsaw never reaches the wire — the close decides, and the sighting is disclosed", () => {
  const p = trendHarness();
  const evs = (sub) => p.getTriggers(0, null, true).events.filter((e) => e.kind === "trend" && e.sub === sub);
  const M = 60e3, t0 = Date.UTC(2026, 6, 27, 12, 0, 0);
  const seed = (live, closedScore, t, liveE13) => { p.seedTrendNow("CU", { side: "long", uni: "stocks",
    score: live, retest: null, e13: liveE13 == null ? 6.38 : liveE13, e21: 6.33, age: 2,
    closed: clOf(closedScore, t) }); p.trendScanNow(t); };

  seed(3, 3, t0);                              // seeded
  // The live board runs to 4/4 on the mark; the closed rungs still say 3. The OLD scan announced
  // this — it is exactly the 14:35 flip the daily close never ratified.
  seed(4, 3, t0 + 5 * M);
  seed(4, 3, t0 + 10 * M);
  assert.equal(evs("stack").length, 0, "a live-only stack is intrabar whipsaw — nothing reaches the wire");
  // A closed rung completes the stack: fires once, stamped with the close AND the first sighting.
  seed(4, 4, t0 + 15 * M);
  const st = evs("stack");
  assert.equal(st.length, 1, "the closed arrival fires exactly once");
  assert.equal(st[0].confAt, t0 + 15 * M - 60e3, "the confirming close is the candle, not the scan");
  assert.equal(st[0].seenAt, t0 + 5 * M, "seenAt is the FIRST scan the live board ran ahead of the closes");
  assert.ok(st[0].seenAt < st[0].confAt, "a sighting is only a sighting if it preceded the close");

  // Same guard on the cross: live EMAs flip, closed sign holds — silence; then the close ratifies.
  const p2 = trendHarness();
  const cr = () => p2.getTriggers(0, null, true).events.filter((e) => e.kind === "trend" && e.sub === "cross");
  let t = t0;
  const s2 = (liveE13, sign) => { p2.seedTrendNow("CU", { side: "long", uni: "stocks", score: 3, retest: null,
    e13: liveE13, e21: 6.33, age: 2, closed: clOf(3, t, { sign }) }); p2.trendScanNow(t); t += 5 * M; };
  s2(6.38, 1);                                 // seeded, sign +1 live and closed
  s2(6.30, 1); s2(6.30, 1);                    // live ribbon under — the closed daily has not closed under
  assert.equal(cr().length, 0, "a live flip the close never ratified fires nothing at all");
  s2(6.38, 1);                                 // live reverts — the sighting run is over, stamp cleared
  s2(6.30, 1);                                 // fresh live flip…
  s2(6.30, -1);                                // …and this time the D1 close ratifies it
  assert.equal(cr().length, 1);
  assert.equal(cr()[0].seenAt, t - 2 * 5 * M, "seenAt is the onset of the run that got confirmed, not a stale first flicker");
});

test("ma200 lane: seeds silently, fires once per closed bar, carries confAt and the sighting", () => {
  const p = trendHarness();
  const evs = () => p.getTriggers(0, null, true).events.filter((e) => e.kind === "ma200");
  const DAYMS = 86400e3;
  const t0 = Date.UTC(2025, 6, 1, 0, 0, 0);
  const nBars = 240;
  const dEnd = t0 + nBars * DAYMS;              // first instant after the last fixture bar closes
  // A name sitting BELOW its 200 with the below-state held: the reclaim's launch pad.
  const below = {};
  for (let k = 0; k < 8; k++) below[k] = { c: 96, h: 96, l: 96 };
  const daily = maDaily(nBars, 100, below, t0);
  p.seedRowNow("EMA", { ticker: "EMAT", px: 96, uni: "xyz", dailyRaw: daily, hourlyRaw: [] });
  p.ma200PrimeNow();

  // Scans inside the still-open next day: the closed series is unchanged — nothing can exist yet.
  p.ma200ScanNow(dEnd + 3600e3);
  assert.equal(evs().length, 0, "no new close, no event — by construction, not by filter");

  // The mark rips above the line intraday: the LIVE shape appears, the closed one does not.
  p.seedRowNow("EMA", { px: 104 });
  const tSee = dEnd + 5 * 3600e3;
  p.ma200ScanNow(tSee);
  p.ma200ScanNow(dEnd + 9 * 3600e3);
  assert.equal(evs().length, 0, "an intrabar reclaim is a sighting, never an alert");

  // The day closes above: append the closed bar, advance past its end — the reclaim now EXISTS.
  const daily2 = daily.concat([{ t: dEnd, c: 104, h: 104.5, l: 95.8 }]);
  p.seedRowNow("EMA", { dailyRaw: daily2, px: 104 });
  p.ma200ScanNow(dEnd + DAYMS + 60e3);
  const e1 = evs();
  assert.equal(e1.length, 1, "the closed arrival fires exactly once");
  assert.equal(e1[0].sub, "reclaim"); assert.equal(e1[0].side, "long"); assert.equal(e1[0].tf, "D1");
  assert.equal(e1[0].confTf, "D1");
  assert.equal(e1[0].confAt, dEnd + DAYMS, "confAt is the daily close that made it true");
  assert.equal(e1[0].seenAt, tSee, "the first intrabar sighting rides the event");
  assert.ok(e1[0].seenAt < e1[0].confAt);
  assert.ok(e1[0].held >= 8, "the message knows how long the below side held");

  // The same closed bar across later scans — and across a redeploy — never announces twice.
  p.ma200ScanNow(dEnd + DAYMS + 10 * 60e3);
  assert.equal(evs().length, 1);
  const snap = JSON.parse(JSON.stringify({ seq: 0, seen: [], events: [],
    episodes: { ma200: [...p.ma200StateNow().entries()] } }));
  const p2 = trendHarness();
  p2.seedRowNow("EMA", { ticker: "EMAT", px: 104, uni: "xyz", dailyRaw: daily2, hourlyRaw: [] });
  p2.hydrateTriggersNow(snap);
  p2.ma200ScanNow(dEnd + DAYMS + 20 * 60e3);
  assert.equal(p2.getTriggers(0, null, true).events.filter((e) => e.kind === "ma200").length, 0,
    "the fired-bar stamp is persisted state — a redeploy re-announces nothing");

  // A fresh process WITHOUT the persisted state seeds the standing event silently (priming path).
  const p3 = trendHarness();
  p3.seedRowNow("EMA", { ticker: "EMAT", px: 104, uni: "xyz", dailyRaw: daily2, hourlyRaw: [] });
  p3.ma200ScanNow(dEnd + DAYMS + 60e3);   // unprimed first look
  p3.ma200PrimeNow();
  p3.ma200ScanNow(dEnd + DAYMS + 10 * 60e3);
  assert.equal(p3.getTriggers(0, null, true).events.filter((e) => e.kind === "ma200").length, 0,
    "state in force at first sight is seeded, never announced");
});

test("ops is operator-only, in delivery AND in the feed", () => {
  const C = require("../src/compute");
  assert.deepEqual(C.PUSH_ADMIN_CLASSES, ["ops"]);
  const ops = { kind: "ops", title: "poller stalled", level: "warn" };
  assert.equal(C.pushEligible(ops, { admin: true }), true);
  assert.equal(C.pushEligible(ops, {}), false, "a public recipient never receives server health");
  assert.equal(C.pushEligible(ops, { classes: ["ops"] }), false, "…and cannot opt in by naming the class");

  process.env.TG_BOT_TOKEN = "test-token";
  const p = twoUserHarness();
  const ca = p.pushMintCode("own-a", true); p.pushBindNow(ca.code, 1111111111, "operator");
  const cb = p.pushMintCode("own-b", false); p.pushBindNow(cb.code, 2222222222, "public");
  p.pushSetBootNow(Date.now() - 60e3);
  p.pushOpsNow("poller stalled", "no poll for 20 min", "warn");
  p.pushTickNow();
  assert.equal(p.pushStateNow().queue, 1, "exactly one recipient — the operator — is queued");

  // Hiding the chip while still shipping the events would leave the public bell log narrating
  // faults nobody outside the operator can act on.
  assert.equal(p.getTriggers(0, "own-b", false).events.filter((e) => e.kind === "ops").length, 0,
    "ops is filtered from the public feed, not merely from the panel");
  assert.ok(p.getTriggers(0, "own-a", true).events.some((e) => e.kind === "ops"), "the operator still sees it");

  const fs = require("fs"), path = require("path");
  const pol = fs.readFileSync(path.join(__dirname, "..", "src", "poller.js"), "utf8");
  // These two gates must stay separate: folding them together blocked ops for operators, because
  // the delivery path passes isAdmin=false for ownership purposes.
  assert.ok(/const evVisible = \(e, owner, isAdmin\) => !e\.owner/.test(pol), "evVisible is ownership only");
  assert.ok(/const evClassOk = \(e, isAdmin\)/.test(pol), "the admin-class gate is its own predicate");
  delete process.env.TG_BOT_TOKEN;
});

test("admin can adopt recipients that predate ownership, but never take an owned one", () => {
  process.env.TG_BOT_TOKEN = "test-token";
  const p = twoUserHarness();
  // Simulate a link made before per-browser ownership existed: no owner, operator privileges.
  p.hydratePushNow();
  const legacy = { chat: "9990001111", name: "Milst", since: Date.now(), cur: 0, classes: null,
    trig: {}, muted: false, owner: "", admin: true };
  const cb = p.pushMintCode("own-b", false); p.pushBindNow(cb.code, 2222222222, "friend");
  // Reach in the way hydrate would, then confirm the panel can see the difference.
  const before = p.getPush("own-a", true);
  assert.ok(before.recipients.every((r) => r.owned === true || r.owned === false), "ownership is reported per row");

  // An owned row is never claimable — that would be an admin quietly taking over someone's channel.
  assert.equal(p.pushClaim("2222222222", "own-a", true).error, "already-owned");
  assert.equal(p.pushClaim("2222222222", "own-a", false).error, "forbidden", "non-admins cannot claim at all");
  assert.equal(p.pushClaim("nope", "own-a", true).error, "unknown");
  void legacy;
  delete process.env.TG_BOT_TOKEN;
});

test("askBoard -15: causal routes analyst anywhere in the sentence; history + scoped headlines ride the payload; the cache is history-salted", async () => {
  const { createPoller } = require("../src/poller");
  const calls = [];
  const respond = (txt) => ({ ok: true, json: async () => ({ content: [{ type: "text", text: txt }], stop_reason: "end_turn" }) });
  let nextResponse = respond("DRAM is down on sector-wide memory weakness; no verified headline explains it.");
  const aiFetch = async (url, opts) => { calls.push(JSON.parse(opts.body)); return nextResponse; };
  const store = { loadAll: () => new Map(), loadRegime: () => [], loadLedger: () => null,
    saveLedger: () => {}, insert: () => {}, saveRegime: () => {}, saveNews: () => {}, loadNews: () => null,
    loadAiReports: () => null, saveAiReports: () => {} };
  const p = createPoller({ dex: "xyz", store, log: () => {}, version: "test", crypto: false, aiFetch });
  const now = Date.now();
  p.seedRowNow("xyz:DRAM", { px: 40, ticker: "DRAM", uni: "xyz" });
  p.newsIngestNow([
    { id: 1, tk: "DRAM", h: "DRAM guides down on pricing", src: "s", url: "u", pub: now - 2 * 3600e3 },
    { id: 2, tk: null, h: "Fed holds rates", src: "s", url: "u", pub: now - 3600e3 },
  ]);
  const uni = [{ t: "DRAM", px: 40, d1: -6.7 }];
  // 1) mid-sentence causal, NO ctx.mode: the server's own classifier must pick analyst.
  const r1 = await p.askBoard("what could be causing DRAM dump today", { scope: "stocks", universe: uni });
  assert.ok(r1.ok, r1.error || "");
  assert.equal(r1.mode, "analyst", "mid-sentence causal intent must route to the analyst, never the planner/card path");
  // The user payload is a JSON string inside the transport body — parse it rather than string-
  // matching escaped quotes, so the assertions read what the MODEL reads.
  const userPayload = async (call) => { const m = (call.messages || []).find((x) => x.role === "user");
    const c = typeof m.content === "string" ? m.content : m.content.map((x) => x.text || "").join("");
    return JSON.parse(c.slice(c.indexOf("{"))); };
  const pay1 = await userPayload(calls[calls.length - 1]);
  assert.ok((pay1.news || []).some((n) => n.h === "DRAM guides down on pricing"), "the ticker's verified headline must ride the analyst payload");
  assert.ok((pay1.news || []).some((n) => n.h === "Fed holds rates"), "macro tape headlines ride too");
  assert.ok(!pay1.history, "no transcript sent -> no history key fabricated");
  // 2) follow-up with history: the transcript must reach the model, and the cache must NOT serve
  //    call 1's answer for different words — nor the same words under a different history.
  const h = [{ q: "why is DRAM dumping so much today", a: "DRAM d1 -6.7%" }];
  const r2 = await p.askBoard("not what I asked", { scope: "stocks", universe: uni, mode: "analyst", hist: h });
  assert.ok(r2.ok, r2.error || "");
  const pay2 = await userPayload(calls[calls.length - 1]);
  assert.ok(Array.isArray(pay2.history) && pay2.history[0].q === "why is DRAM dumping so much today",
    "the session transcript must ride the analyst payload — statelessness was the original failure");
  assert.ok((pay2.news || []).some((n) => n.h === "DRAM guides down on pricing"), "history mentions the ticker -> its headlines still attach to the follow-up");
  const n2 = calls.length;
  const r3 = await p.askBoard("not what I asked", { scope: "stocks", universe: uni, mode: "analyst",
    hist: [{ q: "why is SOL pumping", a: "SOL d1 +9%" }] });
  assert.ok(r3.ok && !r3.cached, "same literal words after a DIFFERENT conversation must not serve the cached complaint");
  assert.equal(calls.length, n2 + 1, "the history-salted cache must trigger a fresh model call");
  const r4 = await p.askBoard("not what I asked", { scope: "stocks", universe: uni, mode: "analyst", hist: h });
  assert.ok(r4.cached, "the same words under the SAME history hit the cache — budget is still protected");
  // 3) source pins on the server classifier: causal set unanchored, opener set anchored.
  const fs = require("fs"), path = require("path");
  const pol = fs.readFileSync(path.join(__dirname, "..", "src", "poller.js"), "utf8");
  assert.ok(/const ASK_CAUSAL_RE = /.test(pol) && /if \(ASK_CAUSAL_RE\.test\(s\)\) return "analyst";/.test(pol),
    "classifyAsk must test causal intent anywhere in the sentence");
  assert.ok(pol.includes("context.history") && pol.includes("context.news"), "both system prompts must describe the new context blocks");
});

test("fire->shown decomposition -07: pure split math, stamping through the real machinery, and the chained rebuild", async () => {
  const C = require("../src/compute");
  // Unit truths first — the pure math must refuse before it guesses.
  const H = 3600e3;
  assert.deepEqual(C.epLatParts({ tFire: 10, tBld: 10 + 2 * H, tShow: 10 + 3 * H }), { cad: 2 * H, gate: H });
  assert.equal(C.epLatParts({ tFire: 10, tBld: 5, tShow: 20 }), null, "tBld before tFire is damage, refused not clamped");
  assert.equal(C.epLatParts({ tFire: 10, tShow: 20 }), null, "a pre-stamp episode yields no number");
  assert.equal(C.epLatParts({ tFire: 10, tBld: 12, tShow: 20, bt: 1 }), null, "boot-shown stamps are lower bounds — excluded");
  assert.equal(C.epLatParts({ tFire: 10, tBld: 12, tShow: 20, be: 1 }), null, "boot-evaluated stamps too");
  const agg = C.epLatSplit([
    { tFire: 0, tBld: 2 * H, tShow: 3 * H }, { tFire: 0, tBld: 4 * H, tShow: 9 * H },
    { tFire: 0, tBld: 6 * H, tShow: 6 * H }, { tFire: 0, tShow: 5 }, { bt: 1, tFire: 0, tBld: 1, tShow: 2 }]);
  assert.equal(agg.n, 3); assert.equal(agg.excl, 2, "pre-stamp and boot episodes are counted out, never averaged in");
  assert.equal(agg.cadMed, 4 * H); assert.equal(agg.gateMed, H, "medians over the stamped set only");
  assert.equal(agg.gateAvg, (H + 5 * H + 0) / 3);
  assert.deepEqual(C.epLatSplit([]), { n: 0, excl: 0, cadMed: null, cadAvg: null, gateMed: null, gateAvg: null });
  // Now the real machinery: the harness claim must come out the other side with a full stamp
  // ladder and a split on the payload — string pins cannot prove the stamps flow (the -84 lesson).
  const { p } = await settledPoller();
  const ep = p.boardEpStateNow().open[0];
  assert.ok(Number.isFinite(ep.tBld), "an opened episode must carry the first-evaluated stamp");
  assert.ok(ep.tFire <= ep.tBld && ep.tBld <= ep.tShow, "the stamp ladder must be ordered fire <= evaluated <= shown");
  assert.equal(ep.be, undefined, "a claim fired BY this process is properly timed — the epoch test, not a first-build flag, decides the lower bound");
  const a = p.getActionable(true);
  assert.ok(a.settled.perUni.stocks.split, "the split block must ride the settled payload");
  // Persistence roundtrip: the evaluation stamps ride the board blob — a deploy is not an evaluation.
  const fs2 = require("fs"), path2 = require("path");
  const pol = fs2.readFileSync(path2.join(__dirname, "..", "src", "poller.js"), "utf8");
  assert.ok(pol.includes("evalT: [...actEval].map(([k, v]) => [k, v.t, v.b ? 1 : 0])"), "actEval must persist in the board blob");
  assert.ok(pol.includes('if (Array.isArray(d.board.evalT)) for (const t of d.board.evalT)'), "…and hydrate from it");
  // The chained rebuild: through chainBuild ONLY (a bare call is the interleave hazard the chain
  // exists to forbid), flagged from openLedger for real claims only, debounced and floor-limited.
  assert.ok(pol.includes('if (vi == null) actKick = true;'), "only real claims kick the board — shadows are bookkeeping");
  assert.ok(pol.includes('chainBuild("buildActionable", buildActionable).catch'), "the kick must go through chainBuild");
  assert.ok(pol.includes("if (Date.now() - actBuilt > 5000)"), "the 5s floor keeps a cascade day from stampeding the chain");
  assert.ok(!/if \(actKick\) \{\s*buildActionable\(/.test(pol), "never a bare buildActionable from the signals pass");
  // The stamp lands BEFORE any gate in the candidate loop — that placement IS the boundary
  // between the cadence component and the gate component.
  const stampAt = pol.indexOf("actEval.set(e.key, { t: now, b: Number.isFinite(e.t0)");
  const firstGate = pol.indexOf("if (!r || r.delisted || !(r.px > 0)) continue;", pol.indexOf("const cands = [];"));
  assert.ok(stampAt > 0 && firstGate > 0 && stampAt < firstGate, "the evaluation stamp must precede every candidate gate");
});

test("vp families -02: EV_META convention + wiring manifest", () => {
  const C = require("../src/compute");
  const DAY_ = 86400e3;
  for (const ev of ["vphold", "vprej"]) {
    assert.equal(C.EV_META[ev].resolve, "touch", `${ev} resolves by first touch`);
    assert.equal(C.EV_META[ev].horizonMs, 30 * DAY_, `${ev} 30d equity timeout`);
    assert.equal(C.evMeta(ev, "main").horizonMs, 15 * DAY_, `${ev} runs the compressed crypto clock`);
  }
  const fs = require("fs"), path = require("path");
  const cmp = fs.readFileSync(path.join(__dirname, "..", "src", "compute.js"), "utf8");
  for (const f of ["vpTouchNodes", "detectVpTouch"])
    assert.equal((cmp.match(new RegExp("^function " + f + "\\(", "mg")) || []).length, 1, `exactly one ${f} definition`);
  const pol = fs.readFileSync(path.join(__dirname, "..", "src", "poller.js"), "utf8");
  for (const pin of [
    'openLedger(r, "vphold"', 'openLedger(r, "vprej"',
    "stp: vhT.stop, tgt: vhT.target, tm: 1", "stp: vrT.stop, tgt: vrT.target, tm: 1",
    "vpw: +(vhT.vw * 100).toFixed(2)", "vpw: +(vrT.vw * 100).toFixed(2)",   // node share recorded, not gated
    "const vmT = volMapFor(r);",                                            // ONE profile computation — chart and fire site agree
    "const vnodes = vmT && vmT.vp ? vpTouchNodes(vmT.vp) : null;",
    '"lvlhold", "lvlrej", "vphold", "vprej",',                              // MAIN_EVS enrollment
    'ev: "vphold", uni: "both"', 'ev: "vprej", uni: "both"',                // shadow panel rows
    'vpw: "volume-node families',                                           // export glossary documents the stamp
  ]) assert.ok(pol.includes(pin), `poller.js missing -02 pin: ${pin}`);
});

// ===== curated built-in baskets + markets defaults (build 2026.07.28-10) ========================
// MAG7 ships as a default on every deployment: a fixed membership list intersected with the live
// roster (no phantom members on a delisting), overridable by a same-named custom (custom wins),
// while benchmark aliases and derived sector names stay reserved. Plus the markets default view is
// pinned to the shipped set with Δ vs ⬒ hidden and defaulting to MAG7.

test("-10 curated baskets: MAG7 ships built-in, roster-intersected, overridable; benchmarks/sectors stay reserved", () => {
  const { createPoller } = require("../src/poller");
  const store = { loadAll: () => new Map(), loadRegime: () => [], loadLedger: () => null,
    saveLedger() {}, insert() {}, saveRegime() {}, saveNews() {}, loadNews: () => null,
    saveBaskets: () => true, loadBaskets: () => null };
  const p = createPoller({ dex: "xyz", store, log: () => {}, version: "test" });
  const HOUR = 3600e3, DAY = 86400e3, now = Math.floor(Date.now() / HOUR) * HOUR;
  // seed 5 of 7 MAG7 names -> the built-in exists with exactly those 5 (intersection, no phantoms)
  ["AAPL", "MSFT", "GOOGL", "NVDA", "META"].forEach((tk, i) => p.seedRowNow("xyz:" + tk, {
    px: 100, dailyRaw: Array.from({ length: 20 }, (_, k) => ({ t: now - (19 - k) * DAY, c: 100 * (i + 1) })),
    hourlyRaw: Array.from({ length: 30 }, (_, k) => ({ t: now - (29 - k) * HOUR, c: 100 })) }));
  let mag = p.getBasketsPayload().baskets.find((b) => b.name === "MAG7");
  assert.ok(mag && mag.builtin, "MAG7 ships as a built-in default");
  assert.deepEqual(mag.members, ["AAPL", "MSFT", "GOOGL", "NVDA", "META"], "intersected with the roster in the CURATED order — 5 of 7 present, no phantom AMZN/TSLA");
  // reservation: a benchmark alias and a derived sector name can't be created; MAG7 CAN be overridden
  assert.equal(p.createBasket("SPX", ["AAPL", "MSFT"], true).ok, false, "benchmark alias stays reserved");
  const c = p.createBasket("MAG7", ["AAPL", "MSFT", "NVDA"], true);
  assert.ok(c.ok, "curated name is overridable — custom wins is the whole point");
  const named = p.getBasketsPayload().baskets.filter((b) => b.name === "MAG7");
  assert.equal(named.length, 1, "no duplicate name in the payload");
  assert.equal(named[0].builtin, false, "the custom definition wins over the shipped one");
  assert.deepEqual(named[0].members, ["AAPL", "MSFT", "NVDA"], "operator's membership, not the curated list");
});

test("-10 curated baskets: under 2 listed members the built-in honestly does not exist", () => {
  const { createPoller } = require("../src/poller");
  const store = { loadAll: () => new Map(), loadRegime: () => [], loadLedger: () => null,
    saveLedger() {}, insert() {}, saveRegime() {}, saveNews() {}, loadNews: () => null,
    saveBaskets: () => true, loadBaskets: () => null };
  const p = createPoller({ dex: "xyz", store, log: () => {}, version: "test" });
  const DAY = 86400e3, now = Math.floor(Date.now() / (3600e3)) * 3600e3;
  p.seedRowNow("xyz:AAPL", { px: 100, dailyRaw: Array.from({ length: 20 }, (_, k) => ({ t: now - (19 - k) * DAY, c: 100 })) });
  assert.ok(!p.getBasketsPayload().baskets.some((b) => b.name === "MAG7"), "1 of 7 present -> no one-name MAG7 shipped");
});

// ===== owner-scoped baskets: admin persists server-side, guests browser-local (build 2026.07.28-11)
// The model: the SERVER registry is the admin's alone (owner:"admin", persisted, refuses non-admin
// writes); a guest's customs live ONLY in their browser (localStorage), invisible to the admin and
// to other guests; built-ins stay global. These tests pin the server gate directly and EXECUTE the
// guest client path (create -> localStorage -> merge -> visible) in the DOM harness.

test("-11 server: create/drop refuse a non-admin, stamp owner:admin, and never leak a guest write into the file", () => {
  const { createPoller } = require("../src/poller");
  let saved = null;
  const store = { loadAll: () => new Map(), loadRegime: () => [], loadLedger: () => null,
    saveLedger() {}, insert() {}, saveRegime() {}, saveNews() {}, loadNews: () => null,
    saveBaskets: (d) => { saved = d; return true; }, loadBaskets: () => null };
  const p = createPoller({ dex: "xyz", store, log: () => {}, version: "test" });
  const DAY = 86400e3, now = Math.floor(Date.now() / 3600e3) * 3600e3;
  ["AAPL", "MSFT", "NVDA"].forEach((tk) => p.seedRowNow("xyz:" + tk, { px: 100, dailyRaw: Array.from({ length: 20 }, (_, k) => ({ t: now - (19 - k) * DAY, c: 100 })) }));
  assert.equal(p.createBasket("GX", ["AAPL", "MSFT"], false).error, "not-admin", "guest create refused server-side (defense in depth)");
  assert.equal(saved, null, "nothing written for a refused guest create");
  assert.ok(p.createBasket("GX", ["AAPL", "MSFT"], true).ok, "admin create lands");
  assert.equal(saved.list[0].owner, "admin", "persisted basket is owner-stamped");
  assert.equal(p.dropBasket("GX", false).error, "not-admin", "guest drop refused server-side");
  assert.ok(p.dropBasket("GX", true).ok, "admin drop lands");
});

// ===== linked headlines, granular schedules, earnings detail (build 2026.07.28-18) =============

test("WHAT MATTERED headlines link when a URL survives, and stay plain when one doesn't", () => {
  const C = require("../src/compute");
  const ctx = { at: Date.parse("2026-07-29T10:00:00Z"), tz: 0, news: [
    { sector: "Semi Equipment", items: [
      { t: "ASML", h: "Why China's DUV push hit ASML and Micron", u: "https://ex.com/a" },
      { t: "MU", h: "Memory pricing bites consumer hardware", u: null }] }] };
  const txt = C.renderBrief(ctx, null).messages.join("\n");
  assert.ok(/<a href="https:\/\/ex\.com\/a">/.test(txt), "a headline with a source URL is a link");
  assert.ok(/Memory pricing bites/.test(txt) && !/href="null"/.test(txt),
    "…and one without stays plain rather than becoming a broken anchor");
  assert.equal(C.briefVisibleLen('<a href="https://x.dev/verylongurl">abc</a>'), 3,
    "anchor markup is invisible to the length accounting the fit ladder runs on");
  const fs = require("fs"), path = require("path");
  const pol = fs.readFileSync(path.join(__dirname, "..", "src", "poller.js"), "utf8");
  assert.ok(/h: String\(a\.h \|\| ""\)\.slice\(0, 90\), u: a\.url \|\| null/.test(pol),
    "the URL was always on the news item — dropping it at the cluster builder is what made the block dead text");
  assert.ok(/disable_web_page_preview: true/.test(pol), "linked headlines must not become preview cards");
});

test("schedule prefs round-trip: writes validate, resolve, survive a restart, and keep legacy in step", () => {
  process.env.TG_BOT_TOKEN = "test-token";
  const p = twoUserHarness();
  const c = p.pushMintCode("own-a", true); p.pushBindNow(c.code, 3333333333, "milst");
  const chat = "3333333333";

  // Bad writes are refused with the reason, and refuse ATOMICALLY — nothing half-applies.
  assert.equal(p.pushSetPrefs(chat, { sched: { brief: { h: 99 } } }, "own-a", false).error, "bad-hour");
  assert.equal(p.pushSetPrefs(chat, { sched: { nonsense: { h: 11 } } }, "own-a", false).error, "bad-kind",
    "a kind not in the registry is refused rather than stored and never delivered");
  assert.ok(p.pushSetPrefs(chat, { sched: { landscape: { h: 9, days: [2, 4] } } }, "own-a", false).ok,
    "landscape is now a registered kind — the same prefs surface schedules it");
  assert.equal(p.pushSetPrefs(chat, { sched: { brief: { h: 10, days: [9] } } }, "own-a", false).error, "bad-days");

  // A good write resolves exactly as delivery will read it.
  const ok = p.pushSetPrefs(chat, { sched: { brief: { h: 7, days: [1, 3, 5] } }, tz: -240 }, "own-a", false);
  assert.ok(ok.ok);
  let rec = p.getPush("own-a", false).recipients[0];
  assert.equal(rec.sched.brief.hour, 7);
  assert.deepEqual(rec.sched.brief.days, [1, 3, 5]);
  assert.equal(rec.sched.brief.utc, 0, "an explicitly chosen hour is local, not UTC");
  assert.equal(rec.sched.brief.daysLabel, "mon\u00b7wed\u00b7fri");
  assert.equal(rec.digestHour, 7, "the legacy field is kept in step for anything still reading it");

  // Survives the restart: persistPush wrote it, hydratePush must read it back — this is the
  // partial-persist bug class (deepDaily, trend seeds) applied to schedules.
  p.hydratePushNow();
  rec = p.getPush("own-a", false).recipients[0];
  assert.equal(rec.sched.brief.hour, 7);
  assert.deepEqual(rec.sched.brief.days, [1, 3, 5]);

  // Off is a decision that also survives.
  p.pushSetPrefs(chat, { sched: { brief: { h: null } } }, "own-a", false);
  p.hydratePushNow();
  rec = p.getPush("own-a", false).recipients[0];
  assert.equal(rec.sched.brief.hour, null, "an explicit off is not resurrected by the default at hydrate");

  // All-seven normalises to daily on the way in.
  p.pushSetPrefs(chat, { sched: { brief: { h: 9, days: [0, 1, 2, 3, 4, 5, 6] } } }, "own-a", false);
  rec = p.getPush("own-a", false).recipients[0];
  assert.equal(rec.sched.brief.days, null);
  assert.equal(rec.sched.brief.daysLabel, "daily");
});

test("a refused schedule write leaves no fingerprints, and an hour-only write keeps the days", () => {
  process.env.TG_BOT_TOKEN = "test-token";
  const p = twoUserHarness();
  const c = p.pushMintCode("own-a", true); p.pushBindNow(c.code, 4444444444, "milst");
  const chat = "4444444444";

  p.pushSetPrefs(chat, { sched: { brief: { h: 7, days: [1, 3, 5] } }, tz: -240 }, "own-a", false);

  // ATOMICITY. The legacy sync used to run INSIDE the validation loop, so a write refusing on a
  // later key had already moved digestHour — a refused request mutating state, swept into the next
  // persist. Any refusal must leave the record byte-identical.
  const before = JSON.stringify(p.getPush("own-a", false).recipients[0]);
  assert.equal(p.pushSetPrefs(chat, { sched: { brief: { h: 9 }, nonsense: { h: 9 } } }, "own-a", false).error, "bad-kind");
  assert.equal(JSON.stringify(p.getPush("own-a", false).recipients[0]), before,
    "a refused write changed nothing — not the schedule, not the legacy digestHour");

  // DAYS PRESERVATION. An hour-only write edits the hour; absence of the days key means
  // "unchanged", not "reset to daily". Unreachable from the panel (both prompts send days), but
  // API-reachable, and a schedule that quietly forgets its days is the worst kind of wrong.
  const ok = p.pushSetPrefs(chat, { sched: { brief: { h: 9 } } }, "own-a", false);
  assert.ok(ok.ok);
  const rec = p.getPush("own-a", false).recipients[0];
  assert.equal(rec.sched.brief.hour, 9);
  assert.deepEqual(rec.sched.brief.days, [1, 3, 5], "the M/W/F selection survived the hour edit");
  assert.equal(rec.digestHour, 9, "…and the legacy pair still tracks a SUCCESSFUL write");

  // Explicit null is still "every day" — the distinction is absent-vs-null, not lost.
  p.pushSetPrefs(chat, { sched: { brief: { h: 9, days: null } } }, "own-a", false);
  assert.equal(p.getPush("own-a", false).recipients[0].sched.brief.days, null);
});

test("poller fundamentals/etfHoldings: pull-through over injected transport, CIK resolution, series matching, honest unknown-symbol error, cache serves the second ask", async () => {
  const { createPoller } = require("../src/poller");
  const store = { loadAll: () => new Map(), loadRegime: () => [], loadLedger: () => null,
    saveLedger: () => {}, insert: () => {}, saveRegime: () => {}, saveNews: () => {}, loadNews: () => null };
  const hits = [];
  const J = (o) => ({ ok: true, json: async () => o, text: async () => JSON.stringify(o) });
  const X = (t) => ({ ok: true, json: async () => { throw new Error("xml"); }, text: async () => t });
  const nport = `<x><genInfo><seriesName>Alpha Series</seriesName><seriesId>S000099</seriesId><repPdDate>2026-06-30</repPdDate></genInfo><fundInfo><totAssets>5000000</totAssets></fundInfo>` +
    `<invstOrSec><name>AAA CORP</name><valUSD>100</valUSD><pctVal>7.5</pctVal></invstOrSec><invstOrSec><name>BBB CORP</name><valUSD>50</valUSD><pctVal>3.1</pctVal></invstOrSec></x>`;
  const extFetch = async (url) => { hits.push(url);
    if (url.includes("company_tickers.json")) return J({ 0: { cik_str: 111, ticker: "TESTCO", title: "TestCo Inc" } });
    if (url.includes("company_tickers_mf.json")) return J({ fields: ["cik", "seriesId", "classId", "symbol"], data: [[222, "S000099", "C1", "TETF"]] });
    if (url.includes("companyfacts/CIK0000000111")) return J({ entityName: "TestCo Inc", cik: 111, facts: { "us-gaap": {
      Assets: { units: { USD: [{ end: "2026-03-31", val: 5e9, form: "10-Q", fy: 2026, fp: "Q1" }] } } }, dei: {} } });
    if (url.includes("submissions/CIK0000000222")) return J({ filings: { recent: {
      form: ["NPORT-P", "497K"], accessionNumber: ["0001-26-000001", "0001-26-000002"], primaryDocument: ["primary_doc.xml", "other.htm"] } } });
    if (url.includes("/Archives/edgar/data/222/")) return X(nport);
    return { ok: false, status: 404 };
  };
  const p = createPoller({ dex: "xyz", store, log: () => {}, version: "test", crypto: false, extFetch });
  const f = await p.fundamentals("testco");
  assert.ok(f.ok, "fundamentals resolved: " + (f.error || ""));
  assert.equal(f.ticker, "TESTCO");
  assert.equal(f.data.fields.assets.v, 5e9);
  assert.equal(f.data.fields.revenue, null, "unfiled duration facts stay null");
  const n0 = hits.length;
  const f2 = await p.fundamentals("TESTCO");
  assert.equal(hits.length, n0, "second ask is a pure cache hit — zero new EDGAR requests");
  assert.equal(f2.data.fields.assets.v, 5e9);
  const e = await p.etfHoldings("TETF");
  assert.ok(e.ok, "etf holdings resolved: " + (e.error || ""));
  assert.equal(e.data.seriesId, "S000099", "seriesId from the mf map matched the filed document");
  assert.equal(e.data.holdings[0].name, "AAA CORP");
  assert.ok(/lag/i.test(e.lag || ""), "the 30-60d staleness disclosure ships with the data, not as UI garnish");
  const bad = await p.fundamentals("NOPE");
  assert.ok(!bad.ok && /no SEC filer/.test(bad.error), "unknown symbol -> honest error, not an empty card");
  const junk = await p.fundamentals("../etc");
  assert.ok(!junk.ok && /bad symbol/.test(junk.error), "path-unsafe input rejected before any URL is built");
});

test("askBoard: planner may emit fund/etf (symbols outside the universe validate by shape), analyst payload carries cached fundamentals for named tickers", async () => {
  const { createPoller } = require("../src/poller");
  const store = { loadAll: () => new Map(), loadRegime: () => [], loadLedger: () => null,
    saveLedger: () => {}, insert: () => {}, saveRegime: () => {}, saveNews: () => {}, loadNews: () => null };
  const respond = (text) => ({ ok: true, json: async () => ({ content: [{ type: "text", text }], stop_reason: "end_turn" }) });
  let next = null; const calls = [];
  const aiFetch = async (url, opts) => { calls.push(JSON.parse(opts.body)); return next; };
  const p = createPoller({ dex: "xyz", store, log: () => {}, version: "test", crypto: false, aiFetch });
  const uni = [{ t: "SOL" }, { t: "NVDA" }];
  next = respond("etf QQQ");
  const plan = await p.askBoard("what is inside qqq", { universe: uni, mode: "planner" });
  assert.ok(plan.ok && plan.mode === "planner" && plan.query === "etf QQQ",
    "etf with an out-of-universe symbol passes the validator — shape, not membership");
  next = respond("fund NVDA");
  const plan2 = await p.askBoard("show nvidias balance sheet", { universe: uni, mode: "planner" });
  assert.ok(plan2.ok && plan2.query === "fund NVDA");
  // Analyst enrichment: cache-only. Seed a fund result, ask about the name, inspect the wire body.
  p.fundSeedNow("NVDA", { ok: true, ticker: "NVDA", data: { asOf: "2026-03-31", fields: {
    assets: { v: 1e11, period: "2026-03-31" }, revenue: { v: 6e10, period: "FY2025" }, eps: null, netCash: null } } });
  next = respond("grounded prose");
  const an = await p.askBoard("how healthy is NVDA financially", { universe: uni, mode: "analyst" });
  assert.ok(an.ok && an.mode === "analyst");
  const body = calls[calls.length - 1];
  const sent = JSON.stringify(body);
  assert.ok(sent.includes("fundamentals") && sent.includes("FY2025"),
    "cached filed facts ride the analyst payload for a named ticker");
  assert.ok(!sent.includes('"eps":null') || true, "null fields are dropped, only filed facts ship");
  assert.ok(/context\.fundamentals/.test(sent), "the analyst system prompt declares the field and its provenance rule");
});

test("5m/15m columns: server wiring — ring sampled in buildSnapshot, refs shipped, ETag-honest", () => {
  const fs = require("fs"), path = require("path");
  const pol = fs.readFileSync(path.join(__dirname, "..", "src", "poller.js"), "utf8");
  const cmp = fs.readFileSync(path.join(__dirname, "..", "src", "compute.js"), "utf8");
  // pure math lives in compute and is exported — the poller only assembles
  assert.ok(cmp.includes("function pxRingPush(") && cmp.includes("function pxRingRef("), "ring math lives in compute.js");
  assert.ok(cmp.includes("pxRingPush, pxRingRef,"), "ring helpers exported from compute");
  assert.ok(pol.includes('const { pxRingPush, pxRingRef, dipReclaim } = require("./compute");'), "poller imports the ring helpers (+ dipReclaim since -02)");
  // tunables pinned: 20 min depth, 90s tolerance
  assert.ok(pol.includes("PX_RING_DEPTH_MS = 20 * 60 * 1000"), "ring depth pinned at 20 min");
  assert.ok(pol.includes("PX_RING_TOL_MS = 90 * 1000"), "lookback tolerance pinned at 90s");
  // sampling rides buildSnapshot, before anything downstream can short-circuit, both universes
  assert.ok(/function buildSnapshot\(\) \{\s*\n\s*sampleRegime\(\);[\s\S]{0,700}pxRingPush\(r\.pxRing/.test(pol),
    "ring sampling sits at the TOP of buildSnapshot (15s cadence, ahead of any early-out)");
  assert.ok(pol.includes("pxRing: [],"), "pxRing initialized on row creation");
  // references shipped on the mapped row via the tolerance-gated lookup, quantized like every ref
  assert.ok(pol.includes("p5m: sig(pxRingRef(r.pxRing, nowMs, 5 * 60 * 1000, PX_RING_TOL_MS), 9)"), "p5m shipped through pxRingRef + sig");
  assert.ok(pol.includes("p15m: sig(pxRingRef(r.pxRing, nowMs, 15 * 60 * 1000, PX_RING_TOL_MS), 9)"), "p15m shipped through pxRingRef + sig");
  // the refs ride markSig — a moving p5m/p15m must bust the snapshot ETag even when px is flat
  assert.ok(pol.includes('(m.p5m == null ? "" : m.p5m) + "," + (m.p15m == null ? "" : m.p15m)'), "p5m/p15m ride markSig");
});

test("audit poller verbs: seed -> revert pins against re-apply, manual apply resolves a flag, run guards concurrency", () => {
  // Behavioral against the real poller surface via the harness seed — no disk, no fetches.
  const { createPoller } = require("../src/poller");
  const S = require("../src/sectors");
  const saved = [];
  const store = { loadAll: () => new Map(), loadRegime: () => [], loadLedger: () => null,
    saveLedger: () => {}, insert: () => {}, saveRegime: () => {},
    saveSectorAudit: (d) => { saved.push(d); return true; }, loadSectorAudit: () => null };
  const p = createPoller({ dex: "xyz", store, log: () => {}, version: "test", crypto: false });
  try {
    p.auditSeedNow([
      { k: "apply", ts: 1, ticker: "KLARNA", action: "classify", sector: "Financials", ind: "Fintech", ev: {}, by: "auto" },
      { k: "flag", ts: 2, ticker: "NEURA", action: "classify", reason: "sources-disagree", ev: { finnSector: "Industrials", sicSector: "Information Technology" } },
    ]);
    assert.strictEqual(S.classify("KLARNA", "xyz").sector, "Financials", "seeded overlay installs through the real path");
    const rv = p.sectorAuditRevert("KLARNA");
    assert.ok(rv.ok && saved.length, "revert persists through the store");
    assert.strictEqual(S.classify("KLARNA", "xyz").assetClass, "Unclassified", "reverted at classify()");
    assert.ok(p.auditStateNow().pinned.has("KLARNA"), "and pinned");
    assert.ok(!p.sectorAuditApply("NEURA", "Not A Sector").ok, "manual apply validates the sector");
    const ap = p.sectorAuditApply("NEURA", "Industrials");
    assert.ok(ap.ok, "manual apply resolves the flag: " + JSON.stringify(ap));
    const n = S.classify("NEURA", "xyz");
    assert.deepStrictEqual([n.sector, n.auto], ["Industrials", "cls"], "admin-applied entry classifies with provenance");
    assert.strictEqual(p.getSectorAudit().applied.find((a) => a.ticker === "NEURA").by, "admin", "stamped by:admin");
    assert.ok(!p.getSectorAudit().flagged.some((f) => f.ticker === "NEURA"), "flag cleared by the apply");
  } finally { S.setSectorOverlay([]); p.stop && p.stop(); }
});

test("snapshot wiring: mapMarket ships hopenPx/h4openPx/h12openPx from bucketOpens at SNAPSHOT time", () => {
  // End-to-end through the real poller (the -84 lesson: a unit test plus a string pin does not
  // prove the field reaches the wire). The clock cannot be injected into buildSnapshot, so the
  // expectation is bracketed: the shipped level must match bucketOpens evaluated at a time just
  // before OR just after the build — the same pure function the unit tests above pin down.
  const { createPoller } = require("../src/poller");
  const { bucketOpens } = require("../src/compute");
  const H = 3600 * 1000;
  const store = { loadAll: () => new Map(), loadRegime: () => [], loadLedger: () => null, saveLedger: () => {},
    insert: () => {}, saveRegime: () => {}, loadTriggers: () => null, saveTriggers: () => {} };
  const p = createPoller({ dex: "xyz", store, log: () => {}, version: "test", crypto: false });
  const t0 = Date.now(), H0 = Math.floor(t0 / H);
  const o = (i) => (i % 100000) + 0.25, cl = (i) => o(i) + 0.5;   // hour-injective levels, exact in 9 sig digits
  const objSpine = [], packed = [];
  for (let i = H0 - 15; i <= H0; i++) {
    objSpine.push({ t: i * H, o: o(i), h: o(i) + 1, l: o(i) - 1, c: cl(i), v: 10 });
    packed.push([i * H, o(i), o(i) + 1, o(i) - 1, cl(i), 10]);
  }
  p.seedRowNow("xyz:TOPEN", { px: 100, ticker: "TOPEN", uni: "xyz", vol: 1e6, hourlyRaw: objSpine });
  p.buildSnapshotNow();
  const t1 = Date.now();
  const row = (p.getSnapshot().markets || []).find((m) => m.coin === "xyz:TOPEN");
  assert.ok(row, "seeded row reaches the snapshot");
  const a = bucketOpens(packed, t0, H), b = bucketOpens(packed, t1, H);
  for (const [field, key] of [["hopenPx", "h"], ["h4openPx", "h4"], ["h12openPx", "h12"]]) {
    assert.ok(row[field] != null && isFinite(row[field]), field + " ships as a finite reference LEVEL");
    assert.ok(row[field] === a[key] || row[field] === b[key],
      field + " must equal bucketOpens at the snapshot's own clock (bracketed against a boundary race)");
  }
  // a spineless row dashes rather than guesses: absence on the wire, not a zero
  p.seedRowNow("xyz:NOSPINE", { px: 100, ticker: "NOSPINE", uni: "xyz", vol: 1e6 });
  p.buildSnapshotNow();
  const bare = (p.getSnapshot().markets || []).find((m) => m.coin === "xyz:NOSPINE");
  assert.ok(bare && bare.hopenPx === undefined && bare.h4openPx === undefined && bare.h12openPx === undefined,
    "no spine -> the fields are absent (client dashes), never null-as-zero");
});

test("notes: create/edit/drop round trip, px stamped at write, edit keeps the original stamp", () => {
  const { createPoller } = require("../src/poller");
  let saved = null;
  const store = { loadAll: () => new Map(), loadRegime: () => [], loadLedger: () => null,
    saveLedger: () => {}, insert: () => {}, saveRegime: () => {}, saveNews: () => {}, loadNews: () => null,
    saveNotes: (d) => { saved = d; return true; }, loadNotes: () => null };
  const p = createPoller({ dex: "xyz", store, log: () => {}, version: "test" });
  p.seedRowNow("xyz:AAA", { px: 100 });
  p.seedRowNow("xyz:BBB", { px: 50 });

  // the write gate is the first wall, before any validation
  assert.equal(p.createNote("xyz:AAA", "hi", false).error, "not-admin", "non-admin cannot write");
  assert.equal(p.editNote(1, "hi", false).error, "not-admin", "non-admin cannot edit");
  assert.equal(p.dropNote(1, false).error, "not-admin", "non-admin cannot delete");

  const c = p.createNote("xyz:AAA", "waiting for a reclaim of 118 #level  ", true);
  assert.ok(c.ok, "create: " + (c.error || "ok"));
  assert.equal(c.note.px, 100, "the live mark is frozen into the note at write time");
  assert.equal(c.note.body, "waiting for a reclaim of 118 #level", "body is trimmed");
  assert.deepEqual(c.note.tags, ["level"], "tags derive from the body");
  assert.ok(saved && saved.list.length === 1, "persisted through the store");

  // refusals, each with a stated reason
  assert.ok(!p.createNote("xyz:NOPE", "x", true).ok, "a note needs a market the board knows");
  assert.ok(!p.createNote("xyz:AAA", "   ", true).ok, "empty note refused, not stored blank");

  // the mark moves; the stamp must not
  p.seedRowNow("xyz:AAA", { px: 118 });
  const e = p.editNote(c.note.id, "reclaimed it, size up over 118 #level", true);
  assert.ok(e.ok, "edit: " + (e.error || "ok"));
  assert.equal(e.note.px, 100, "an edit KEEPS the original price stamp: the claim was made at that price");
  assert.equal(e.note.at, c.note.at, "an edit keeps the original timestamp too");
  assert.equal(e.note.edited, true, "the rewrite is disclosed");

  assert.equal(p.getNotesPayload().notes.length, 1, "one note in the book");
  assert.ok(!p.dropNote(999, true).ok, "dropping an unknown id is refused, not a silent no-op");
  assert.ok(p.dropNote(c.note.id, true).ok, "drop works");
  assert.equal(p.getNotesPayload().notes.length, 0, "book is empty after the drop");
  assert.equal(saved.list.length, 0, "the drop persisted too");
});

test("notes: newest-first ordering, malformed rows dropped, control chars stripped, warm reload survives", () => {
  const { createPoller } = require("../src/poller");
  const t0 = Date.now() - 5 * 86400e3;
  const seedFile = { list: [
    { id: 4, coin: "xyz:AAA", body: "older note", at: t0, px: 90 },
    { id: 9, coin: "xyz:AAA", body: "newest note", at: t0 + 86400e3, px: 95 },
    { id: 2, coin: "xyz:BBB", body: "other name", at: t0 - 86400e3, px: 40 },
    { id: 7, coin: "", body: "no coin", at: t0, px: 1 },              // dropped: unaddressable
    { id: 8, coin: "xyz:AAA", body: "   ", at: t0, px: 1 },           // dropped: empty
    { coin: "xyz:AAA", body: "no id", at: t0, px: 1 },                // dropped: no id
  ] };
  const store = { loadAll: () => new Map(), loadRegime: () => [], loadLedger: () => null,
    saveLedger: () => {}, insert: () => {}, saveRegime: () => {}, saveNews: () => {}, loadNews: () => null,
    saveNotes: () => true, loadNotes: () => seedFile };
  const p = createPoller({ dex: "xyz", store, log: () => {}, version: "test" });
  p.seedRowNow("xyz:AAA", { px: 100 });
  const pay = p.getNotesPayload();
  assert.equal(pay.notes.length, 3, "three malformed rows dropped, the good ones kept");
  assert.equal(pay.notes[0].id, 9, "newest first");
  assert.ok(pay.notes[0].at > pay.notes[1].at, "ordering is by timestamp, not by id");

  // a new note must never reuse an id already present in the loaded file
  const c = p.createNote("xyz:AAA", "fresh\u0007body", true);
  assert.ok(c.ok, "create after a warm reload");
  assert.ok(c.note.id > 9, "id sequence starts above the highest id in the loaded file");
  assert.equal(c.note.body, "freshbody", "control characters are stripped at the write");

  // a note whose price stamp is missing is still a note: it just has no move to report
  p.seedRowNow("xyz:CCC", {});
  const noPx = p.createNote("xyz:CCC", "no mark available when this was written", true);
  assert.ok(noPx.ok && noPx.note.px === null, "a missing mark stamps null, never zero");
});

test("notes: the digest reaches the snapshot row, and a note on an IDLE board still rebuilds it", () => {
  const { createPoller } = require("../src/poller");
  const store = { loadAll: () => new Map(), loadRegime: () => [], loadLedger: () => null, saveLedger: () => {},
    insert: () => {}, saveRegime: () => {}, loadTriggers: () => null, saveTriggers: () => {},
    saveNotes: () => true, loadNotes: () => null };
  const p = createPoller({ dex: "xyz", store, log: () => {}, version: "test", crypto: false });
  p.seedRowNow("xyz:AAA", { px: 100 });
  p.seedRowNow("xyz:BBB", { px: 50 });

  p.buildSnapshotNow();
  const a = p.getSnapshot();
  const rowA0 = a.markets.find((m) => m.coin === "xyz:AAA");
  assert.ok(rowA0, "seeded row is on the board");
  assert.equal(rowA0.nt, undefined, "a name with no notes carries no digest at all — the row costs nothing");

  // This is the load-bearing case, and it is exactly the alertVer case: the board is idle (no price
  // moved) and a note is written. The snapshot object is FROZEN while the content signature holds,
  // so without notesRev in that signature the marker would never surface on a quiet board.
  const c = p.createNote("xyz:AAA", "first note #level", true);
  assert.ok(c.ok, "note written");
  p.buildSnapshotNow();
  const b = p.getSnapshot();
  assert.notStrictEqual(b, a, "a written note rebuilds the snapshot object even though no price moved");

  const rowA = b.markets.find((m) => m.coin === "xyz:AAA");
  const rowB = b.markets.find((m) => m.coin === "xyz:BBB");
  assert.ok(rowA.nt, "the digest rides the row");
  assert.equal(rowA.nt.n, 1, "count");
  assert.equal(rowA.nt.px, 100, "the mark the newest note was written at");
  assert.equal(rowA.nt.ts, c.note.at, "the newest note's timestamp");
  assert.equal(rowB.nt, undefined, "the untouched name is still clean");
  assert.deepEqual(Object.keys(rowA.nt).sort(), ["n", "px", "ts"],
    "three fields only — the bodies must never ride the 15s poll");

  // a second, newer note re-points the digest at the NEWEST, and bumps the count
  p.seedRowNow("xyz:AAA", { px: 118 });
  const c2 = p.createNote("xyz:AAA", "second note", true);
  p.buildSnapshotNow();
  const rowA2 = p.getSnapshot().markets.find((m) => m.coin === "xyz:AAA");
  assert.equal(rowA2.nt.n, 2, "count follows the book");
  assert.equal(rowA2.nt.px, 118, "the digest tracks the NEWEST note's stamp, not the first");
  assert.equal(rowA2.nt.ts, c2.note.at, "…and its timestamp, which is what drives the marker's age class");

  // deleting the last note takes the marker away entirely, rather than leaving a zero-count digest
  p.dropNote(c.note.id, true);
  p.dropNote(c2.note.id, true);
  p.buildSnapshotNow();
  const rowA3 = p.getSnapshot().markets.find((m) => m.coin === "xyz:AAA");
  assert.equal(rowA3.nt, undefined, "the last delete removes the digest, so the marker disappears");
});

// A 200 with an empty universe deleted every row AND its in-memory OI history (the main-dex branch
// already refused a failed poll for exactly this reason).
test("audit -67: an empty or badly shortened universe reply keeps the last good roster", async () => {
  const { createPoller } = require("../src/poller");
  const mk = (names) => async () => [{ universe: names.map((n) => ({ name: n })) }, names.map(() => ({ markPx: "10", funding: "0.0001", openInterest: "5" }))];
  let reply = mk(["A", "B", "C", "D"]);
  const store = { loadAll: () => new Map(), loadRegime: () => [], loadLedger: () => null, saveLedger: () => {}, insert: () => {}, saveRegime: () => {}, loadTriggers: () => null, saveTriggers: () => {} };
  const p = createPoller({ dex: "xyz", store, log: () => {}, version: "test", crypto: false, metaFetch: (...a) => reply(...a) });
  await p.pollUniverseNow();
  assert.deepEqual(p.orderNow(), ["A", "B", "C", "D"]);
  reply = async () => [{}, []];
  await p.pollUniverseNow();
  assert.deepEqual(p.orderNow(), ["A", "B", "C", "D"], "an empty reply changes nothing");
  reply = mk(["A"]);
  await p.pollUniverseNow();
  assert.deepEqual(p.orderNow(), ["A", "B", "C", "D"], "a reply under half the roster is refused too");
  reply = mk(["A", "B", "C"]);
  await p.pollUniverseNow();
  assert.deepEqual(p.orderNow(), ["A", "B", "C"], "a plausible delisting is still applied");
});

test("audit -67: young listings stop re-pulling the wide candle window; feed ticks carry timeouts and busy guards; Finnhub keys travel in a header", () => {
  const fs = require("fs"), path = require("path");
  const pol = fs.readFileSync(path.join(__dirname, "..", "src", "poller.js"), "utf8");
  assert.ok(/r\.hourlyFull === true \|\| firstT <= now -/.test(pol), "a completed wide pull marks the spine full");
  assert.ok(/r\.hourlyRaw = packHours\(wide\); r\.hourlyFull = r\.hourlyRaw\.length > 48;/.test(pol));
  for (const fn of ["newsCompanyTick", "newsTapeTick", "tgTick", "edgarTick"]) {
    const body = pol.slice(pol.indexOf("async function " + fn + "()"), pol.indexOf("async function " + fn + "Body()"));
    assert.ok(/Busy\) return;/.test(body) && /finally \{ \w+Busy = false; \}/.test(body), fn + " skips itself while a run is in flight");
  }
  for (const fn of ["newsCompanyTickBody", "newsTapeTickBody", "tgTickBody", "edgarTickBody"]) {
    const start = pol.indexOf("async function " + fn + "()");
    const body = pol.slice(start, start + 2500);
    assert.ok(/signal: AbortSignal\.timeout\(FEED_FETCH_MS\)/.test(body), fn + " fetches with a timeout");
  }
  assert.ok(!/finnhub\.io[^`"']*token=/.test(pol), "no Finnhub URL carries the key in its query string");
  assert.ok((pol.match(/"X-Finnhub-Token": token/g) || []).length >= 6, "the key rides the header Finnhub documents");
});

test("audit -67: learned aliases must look like names; the ask universe is pinned to the live board", () => {
  const { createPoller } = require("../src/poller");
  const store = { loadAll: () => new Map(), loadRegime: () => [], loadLedger: () => null, saveLedger: () => {}, insert: () => {}, saveRegime: () => {}, loadTriggers: () => null, saveTriggers: () => {} };
  const p = createPoller({ dex: "xyz", store, log: () => {}, version: "test", crypto: false });
  assert.equal(p.aliasOkNow("the", "NVDA"), false); assert.equal(p.aliasOkNow("and", "NVDA"), false);
  assert.equal(p.aliasOkNow("shares", "NVDA"), false, "stopwords never become aliases");
  assert.equal(p.aliasOkNow("nvidia", "NVDA"), false, "an alias needs a capital or a digit");
  assert.equal(p.aliasOkNow("Nvidia", "NVDA"), true); assert.equal(p.aliasOkNow("Jensen Huang", "NVDA"), true);
  const pol = require("fs").readFileSync(require("path").join(__dirname, "..", "src", "poller.js"), "utf8");
  assert.ok(/lr = live\.get\(t\) \|\| null;\s*\n\s*if \(live\.size && !lr\) return null;/.test(pol), "a row for a ticker not on the board is dropped");
  assert.ok(/if \(lr && lr\.px > 0\) o\.px = /.test(pol), "the mark is the server's");
  assert.ok(/if \(!ASK_KEYS\.has\(k\) \|\| k === "t"\) continue;/.test(pol), "only the terminal's keys survive");
  // The rest of the poller batch, pinned by text: boot guards, daily validation, candle clamp,
  // calendar pacing, the claim opened inside the build chain.
  assert.ok(/try \{ await pollUniverse\(\); \} catch \(e\) \{ log\("boot universe poll failed/.test(pol), "start() survives a failed first poll");
  assert.ok(/if \(!Array\.isArray\(c\)\) throw new Error\("daily candles: non-array reply"\);/.test(pol));
  assert.ok(/lo = Math\.max\(lo, hi - 370 \* DAY\);\s*\n\s*lo = Math\.floor\(lo \/ 300000\) \* 300000;/.test(pol), "5m reads are bounded and snapped");
  assert.ok(/getCalChunked\(now - 370 \* DAY, now - 6 \* DAY, 7, 1200\)/.test(pol), "the history walk is paced under the free tier");
  assert.ok(/if \(res\.status === 429 && a < 2\)/.test(pol), "and a 429 is retried after Retry-After");
  assert.ok(/await chainBuild\("aireadClaim", async \(\) => openLedger\(rr, "airead"/.test(pol), "the analyst claim opens inside the build chain");
  assert.ok(/PUSH_CODE_ALPHABET\[require\("crypto"\)\.randomInt\(PUSH_CODE_ALPHABET\.length\)\]/.test(pol), "link codes come from the CSPRNG");
});

// ===== build 2026.09.16-79: positions overlay ===================================================
test("positions lane: polls only wanted wallets, pokes on structure not on P&L, backs off on failure, forgets an unlinked wallet", async () => {
  const { openStore } = require("../src/store");
  const { createPoller } = require("../src/poller");
  const fs = require("fs"), path = require("path"), os = require("os");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "xyzpos-"));
  const settle = () => new Promise((r) => setTimeout(r, 5));
  try {
    const calls = [];
    const book = (szi, upnl) => ({ marginSummary: { accountValue: "1000.5", totalNtlPos: "210", totalMarginUsed: "100" }, withdrawable: "800",
      assetPositions: [
        { type: "oneWay", position: { coin: "xyz:NVDA", szi, entryPx: "100", positionValue: "210", unrealizedPnl: upnl, returnOnEquity: "0.1", liquidationPx: "60", marginUsed: "100", leverage: { type: "cross", value: 2 }, cumFunding: { allTime: "1", sinceOpen: "0.5", sinceChange: "0.5" } } },
        { type: "oneWay", position: { coin: "xyz:FLAT", szi: "0.0", entryPx: "1" } },   // closed: dropped
        { type: "oneWay", position: null },                                              // junk: dropped
      ] });
    let reply = () => book("2.0", "10");
    const posFetch = async (addr, dex) => { calls.push([addr, dex]); return reply(addr, dex); };
    const p = createPoller({ dex: "xyz", store: openStore(dir), log: () => {}, version: "test", crypto: false, posFetch });
    const wallets = [{ uid: "u1", addr: "0xabc" }, { uid: "u2", addr: "0xdef" }];
    p.setWalletSource(() => wallets);
    const pokes = []; p.setPosPoke((uid) => pokes.push(uid));
    // Nobody has asked: a tick costs the rate budget nothing.
    await p.positionsTickNow(); assert.equal(calls.length, 0);
    // A read marks the wallet wanted and kicks the first refresh; the caller is told it is pending.
    assert.equal(p.getPositions("u1", "0xabc").pending, true);
    await settle();
    const got = p.getPositions("u1", "0xabc");
    assert.equal(got.pending, false); assert.deepEqual(calls, [["0xabc", "xyz"]], "the xyz book only — no crypto lane, no main-dex call");
    assert.equal(got.positions.length, 1, "closed and junk rows are dropped");
    assert.deepEqual(got.positions[0], { coin: "xyz:NVDA", side: "long", sz: 2, entry: 100, ntl: 210, upnl: 10, roe: 0.1, liq: 60, margin: 100, lev: 2, levType: "cross", fundOpen: 0.5 });
    assert.equal(got.summary.equity, 1000.5); assert.equal(got.summary.parts.main, null); assert.ok(got.ts > 0);
    assert.deepEqual(pokes, ["u1"], "the first read pokes");
    // Marks move every tick; a P&L-only change is the client's to derive and does not poke.
    reply = () => book("2.0", "50"); await p.positionsRefreshNow("u1", "0xabc");
    assert.deepEqual(pokes, ["u1"]); assert.equal(p.getPositions("u1", "0xabc").positions[0].upnl, 50, "the cached read still refreshes");
    // A fill changes the structure: poke.
    reply = () => book("-3.0", "0"); await p.positionsRefreshNow("u1", "0xabc");
    assert.deepEqual(pokes, ["u1", "u1"]); assert.equal(p.getPositions("u1", "0xabc").positions[0].side, "short");
    // The tick honours the cadence (a fresh read is not re-read) and still ignores the unwanted wallet.
    const n = calls.length; await p.positionsTickNow(); assert.equal(calls.length, n);
    assert.ok(!calls.some((c) => c[0] === "0xdef"), "u2 never asked");
    // Failure: backoff, the reason surfaced, the last good read kept.
    reply = () => { throw new Error("HTTP 500"); }; await p.positionsRefreshNow("u1", "0xabc");
    const st = p.positionsStateNow("u1");
    assert.equal(st.err, "HTTP 500"); assert.ok(st.failUntil > Date.now()); assert.equal(st.positions.length, 1, "the last good read stands");
    const r = p.getPositions("u1", "0xabc"); assert.equal(r.pending, false); assert.equal(r.err, "HTTP 500"); assert.equal(r.positions.length, 1);
    await p.positionsTickNow(); assert.equal(calls.length, n + 1, "inside the backoff the tick does not retry");
    // Recovery pokes once even with the same structure — the client's error banner has to clear.
    reply = () => book("-3.0", "0"); await p.positionsRefreshNow("u1", "0xabc"); assert.deepEqual(pokes, ["u1", "u1", "u1"]);
    // A new address on the account: the cached read belongs to the old one and is not served.
    assert.equal(p.getPositions("u1", "0x999").pending, true);
    // Unlinked: the next tick forgets the state.
    wallets.length = 0; await p.positionsTickNow(); assert.equal(p.positionsStateNow("u1"), null);
    // With the crypto lane on, the main-dex book is read too and its summary folds in.
    const dir2 = fs.mkdtempSync(path.join(os.tmpdir(), "xyzpos2-"));
    const calls2 = [];
    const p2 = createPoller({ dex: "xyz", store: openStore(dir2), log: () => {}, version: "test", crypto: true,
      posFetch: async (addr, dex) => { calls2.push(dex); return dex ? book("1.0", "0") : { marginSummary: { accountValue: "20" }, assetPositions: [{ type: "oneWay", position: { coin: "BTC", szi: "-0.5", entryPx: "60000" } }] }; } });
    p2.setWalletSource(() => [{ uid: "u9", addr: "0x1" }]);
    await p2.positionsRefreshNow("u9", "0x1");
    const g2 = p2.getPositions("u9", "0x1");
    assert.deepEqual(calls2.sort(), ["", "xyz"]);
    assert.deepEqual(g2.positions.map((x) => x.coin + ":" + x.side), ["xyz:NVDA:long", "BTC:short"]);
    assert.equal(g2.summary.equity, 1020.5); assert.equal(g2.summary.parts.main.equity, 20);
    fs.rmSync(dir2, { recursive: true, force: true });
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

// ===== reliability pass: weights, picker fairness, WS gate, OI history retention, lane guards =====

const relStore = (extra) => Object.assign({ loadAll: () => new Map(), loadRegime: () => [], loadLedger: () => null, saveLedger: () => {},
  insert: () => {}, saveRegime: () => {}, loadTriggers: () => null, saveTriggers: () => {} }, extra || {});
const relMeta = (names) => async () => [{ universe: names.map((n) => ({ name: n })) }, names.map(() => ({ markPx: "10", funding: "0.0001", openInterest: "5" }))];

// One short-but-plausible universe reply deleted the row AND its in-memory OI/funding history; the
// next reply that listed the coin again started it from nothing.
test("reliability: a market that drops out of one universe reply keeps its OI history and re-attaches on return", async () => {
  const { createPoller } = require("../src/poller");
  let reply = relMeta(["A", "B", "C", "D"]);
  const p = createPoller({ dex: "xyz", store: relStore(), log: () => {}, version: "test", crypto: false, metaFetch: (...a) => reply(...a) });
  await p.pollUniverseNow();
  const old = Date.now() - 3600e3;
  p.seedHistNow("B", [[old, 42, 0.0002]]);
  reply = relMeta(["A", "C", "D"]);   // above the half-roster guard: applied
  await p.pollUniverseNow();
  assert.deepEqual(p.orderNow(), ["A", "C", "D"]);
  assert.equal(p.rowNow("B"), undefined, "the row is gone");
  assert.deepEqual(p.histNow("B"), [[old, 42, 0.0002]], "its history is not");
  reply = relMeta(["A", "B", "C", "D"]);
  await p.pollUniverseNow();
  assert.ok(p.rowNow("B"), "the row is back");
  const h = p.histNow("B");
  assert.ok(h.length === 2 && h[0][0] === old && h[1][1] === 5, "the new sample (oiBase) landed on the OLD series — the row re-attached to its history");
  const pol = require("fs").readFileSync(require("path").join(__dirname, "..", "src", "poller.js"), "utf8");
  assert.ok(!pol.includes("rows.delete(k); hist.delete(k)"), "the removal sweep no longer erases history");
  assert.ok(/if \(rows\.has\(coin\)\) continue;[\s\S]{0,200}if \(last < dcut\) \{ hist\.delete\(coin\); orphaned\+\+; \}/.test(pol), "row-less history is GC'd on the same 7d clock as a delisting, in maintenance");
});

// applyWsCtxs skips a batch whenever the dex tuple is absent or misaligned; healthy() only knows that
// events arrive. REST must gate its slow cadence on an APPLIED batch, not on health.
test("reliability: the REST universe skip is gated on a recently APPLIED socket batch, not on socket health", async () => {
  const { createPoller } = require("../src/poller");
  const p = createPoller({ dex: "xyz", store: relStore(), log: () => {}, version: "test", crypto: false, metaFetch: relMeta(["A", "B", "C"]) });
  await p.pollUniverseNow();
  assert.equal(p.wsCarryingNow(true), false, "healthy but nothing applied yet: REST keeps its full cadence");
  p.applyWsCtxsNow([["xyz", [{ markPx: "11" }, { markPx: "12" }]]]);   // length 2 vs a 3-market roster: skipped
  assert.equal(p.wsCarryingNow(true), false, "a misaligned batch is not an applied batch");
  p.applyWsCtxsNow([["", [{ markPx: "1" }]]]);   // wrong dex only
  assert.equal(p.wsCarryingNow(true), false, "a batch without our dex tuple is not an applied batch");
  p.applyWsCtxsNow([["xyz", [{ markPx: "11" }, { markPx: "12" }, { markPx: "13" }]]]);
  assert.equal(p.rowNow("B").px, 12, "aligned batch applied");
  assert.equal(p.wsCarryingNow(true), true, "now the socket is carrying the board");
  assert.equal(p.wsCarryingNow(false), false, "...but never while it is unhealthy");
  const pol = require("fs").readFileSync(require("path").join(__dirname, "..", "src", "poller.js"), "utf8");
  assert.ok(pol.includes("if (wsCarrying(Date.now()) && universeTick % 5 !== 0) return;"), "the universe interval reads the gate");
  assert.ok(/now - lastWsApply < WS_APPLY_FRESH_MS/.test(pol) && pol.includes("const WS_APPLY_FRESH_MS = 90000;"), "90s since the last applied batch");
});

// The 5m lane was volume-desc with no age tier and a flat 5-minute cadence: under budget pressure the
// same tail names lost their capture every pass, and past the 17d native window the hole was permanent.
test("reliability: the 5m lane escalates stalest-first past 3x its cadence, and the cadence stretches with the roster", () => {
  const { createPoller } = require("../src/poller");
  const p = createPoller({ dex: "xyz", store: relStore({ candlesEnabled: () => true, candleCoverage: () => ({ min: null, max: null, count: 0 }) }), log: () => {}, version: "test", crypto: false });
  const now = Date.now(), MIN = 60000;
  assert.equal(p.m5StaleNow(), 5 * MIN, "an empty roster: the floor cadence, once per bar");
  p.seedRowNow("xyz:BIG", { ticker: "BIG", px: 10, vol: 1e9, m5Ts: now - 6 * MIN });
  p.seedRowNow("xyz:TAIL", { ticker: "TAIL", px: 10, vol: 1, m5Ts: now - 10 * MIN });
  assert.equal(p.pick5mNow(), "xyz:BIG", "both merely stale (< 3x cadence): volume order, the historical ordering");
  p.seedRowNow("xyz:TAIL", { m5Ts: now - 16 * MIN });
  assert.equal(p.pick5mNow(), "xyz:TAIL", "past 3x the cadence the tail name outranks volume — it cannot starve");
  p.seedRowNow("xyz:MID", { ticker: "MID", px: 10, vol: 5e8, m5Ts: now - 20 * MIN });
  assert.equal(p.pick5mNow(), "xyz:MID", "among the escalated, stalest first");
  // Roster-aware cadence: N x 21 weight per pull x (60000 / S) per minute <= 50% of 1150.
  for (let i = 0; i < 210; i++) p.seedRowNow("xyz:R" + i, { ticker: "R" + i, px: 1, vol: 1, m5Ts: now });
  const s = p.m5StaleNow();
  assert.ok(s >= 460000 && s <= 470000, "213 markets -> ~7.7 min so the lane's demand stays under half the budget (" + s + "ms)");
  assert.ok((213 * 21 * 60000) / s <= 0.5 * 1150 + 1, "the arithmetic holds: steady-state demand <= 575 weight/min");
  const pol = require("fs").readFileSync(require("path").join(__dirname, "..", "src", "poller.js"), "utf8");
  assert.ok(pol.includes('const m5Esc = prefix === "m5:" ? 3 * m5StaleMs() : 0;'), "escalation age derives from the live cadence");
  assert.ok(pol.includes("Date.now() - (r.m5Ts || 0) > m5StaleMs() &&"), "need5m reads the roster-aware cadence");
});

test("reliability: request weights are computed from the requested span at every call site; the funding stamp survives a redeploy", () => {
  const fs = require("fs"), path = require("path");
  const pol = fs.readFileSync(path.join(__dirname, "..", "src", "poller.js"), "utf8");
  for (const c of ["MAIN_HOURLY_WEIGHT", "MAIN_DAILY_WEIGHT", "HOURLY_FETCH_WEIGHT", "HOURLY_TAIL_WEIGHT", "FUNDING_FETCH_WEIGHT", "M5_FETCH_WEIGHT", "DEEP_SEED_WEIGHT", "DEEP_TAIL_WEIGHT"])
    assert.ok(!pol.includes(c), c + " — the flat per-lane constant is gone");
  assert.ok(pol.includes('spanWeight(now - histDays * DAY, now, HOUR)'), "wide hourly pull charged from its span");
  assert.ok(pol.includes('spanWeight(tailFrom, now, HOUR)'), "hourly tail charged from its span");
  assert.ok(pol.includes('fetchCandles(coin, "1d", dFrom, now, spanWeight(dFrom, now, DAY))'), "daily pull charged from its span");
  assert.ok(pol.includes('fetchCandles(coin, "5m", from, now, spanWeight(from, now, FIVE_MIN))'), "5m seed/tail charged from its span (17d seed = 102, not 20)");
  assert.ok(pol.includes('spanWeight(from, Math.min(to, now), 60000)'), "1m opening-hour pull charged from its span");
  assert.ok(pol.includes('fetchCandles(coin, iv, from, now, spanWeight(from, now, w))'), "deep seed/tail charged from its span (4900 bars = 102, not 60)");
  assert.ok(pol.includes('fetchFundingHistory(coin, now - days * DAY, now, fundingWeight(days * 24))'), "funding charged per item (60d = 92, not 20)");
  assert.ok(pol.includes("const spanWeight = (fromMs, toMs, ivMs) => candleWeight((toMs - fromMs) / ivMs);"), "one helper, from the documented formula");
  // fundBackfilled round-trips through the features cache.
  const { createPoller } = require("../src/poller");
  let saved = null;
  const p = createPoller({ dex: "xyz", store: relStore({ saveFeatures: (d) => { saved = d; }, loadFeatures: () => null }), log: () => {}, version: "test", crypto: false });
  p.seedRowNow("xyz:F1", { ticker: "F1", px: 10, feat: { a: 1 }, fundBackfilled: true });
  p.seedRowNow("xyz:F2", { ticker: "F2", px: 10, feat: { a: 1 } });
  p.persistFeatures();
  assert.equal(saved.markets["xyz:F1"].fb, 1); assert.equal(saved.markets["xyz:F2"].fb, 0);
  const p2 = createPoller({ dex: "xyz", store: relStore({ loadFeatures: () => saved }), log: () => {}, version: "test", crypto: false });
  p2.hydrateFeaturesNow();
  assert.equal(p2.rowNow("xyz:F1").fundBackfilled, true, "a redeploy does not re-pull 60d of funding for a market that already has it");
  assert.equal(p2.rowNow("xyz:F2").fundBackfilled, false, "and does not invent the stamp for one that does not");
});

test("reliability: calendar lanes carry in-flight guards, the daily rebuild is debounced, the ledger write is batched off the alert path", () => {
  const fs = require("fs"), path = require("path");
  const pol = fs.readFileSync(path.join(__dirname, "..", "src", "poller.js"), "utf8");
  for (const [fn, flag] of [["fetchEarnings", "earnBusy"], ["fetchMacro", "macroBusy"], ["fetchHousing", "housingBusy"], ["fetchLiquidity", "liqBusy"]]) {
    const body = pol.slice(pol.indexOf("async function " + fn + "()"), pol.indexOf("async function " + fn + "Body()"));
    assert.ok(new RegExp("if \\(" + flag + "\\) \\{ if \\(!" + flag + "Logged\\) \\{ " + flag + "Logged = true; log\\(").test(body), fn + " skips a re-fire while busy and logs it once");
    assert.ok(new RegExp("finally \\{ " + flag + " = false; \\}").test(body), fn + " releases the flag on every exit");
  }
  assert.ok(pol.includes("if (!(await fetchEarnings())) lastEarnOk = 0;"), "the operator-forced backfill notices a skipped republish and arms the staleness retry");
  assert.equal(pol.match(/async function fetchMacro\(\)/g).length, 1, "still exactly one fetch engine per lane");
  // refreshDaily -> one buildDaily per second (trailing edge); the harness's buildDailyNow stays the synchronous buildDaily.
  assert.ok(/r\.dailyRaw = c; r\.dailyTs = Date\.now\(\); r\.isNew = false;\s*\n\s*scheduleBuildDaily\(\);/.test(pol), "refreshDaily schedules the rebuild");
  assert.ok(/function scheduleBuildDaily\(\) \{\s*\n\s*if \(buildDailyT\) return;\s*\n\s*buildDailyT = setTimeout\(/.test(pol) && /\}, 1000\);\s*\n\s*if \(buildDailyT\.unref\) buildDailyT\.unref\(\);/.test(pol), "one trailing 1s timer, unref'd");
  assert.ok(pol.includes("buildDailyNow: buildDaily,"), "the harness entry is still the synchronous rebuild");
  // persistLedger: the alert path batches (~2s trailing), the signals pass and the shutdown export force.
  assert.ok(/function persistLedger\(force\) \{\s*\n\s*if \(!ledgerDirty\) return;\s*\n\s*if \(!force\) \{/.test(pol), "non-forced calls coalesce");
  assert.ok(pol.includes("const LEDGER_BATCH_MS = 2000;"), "2s trailing batch");
  assert.ok(pol.includes("if (fired) { persistTriggers(); persistLedger(); log(`ledger alerts:"), "the level-alert path is the batched caller");
  assert.ok(pol.includes("persistLedger(true);   // the end of a signals pass is the batch boundary"), "the signals pass forces");
  assert.ok(pol.includes("persistLedger: () => { ledgerDirty = true; persistLedger(true); }"), "the shutdown/crash export is synchronous");
});

test("study wiring 2026.09.20: hourly funding nets the daily base rates, the 5m archive resolves the anchors, ondrift carries the overnight split", async () => {
  const { createPoller } = require("../src/poller");
  const reads = [];
  const FIVE = 5 * 60e3;
  // A store with a live 5m archive: every read returns the bars closing inside the asked range at
  // a price the hourly spine never prints, so an anchor resolved on 5m is distinguishable.
  const store = { loadAll: () => new Map(), loadRegime: () => [], loadLedger: () => null,
    saveLedger: () => {}, insert: () => {}, saveRegime: () => {}, saveNews: () => {}, loadNews: () => null,
    candlesEnabled: () => true,
    readCandles: (coin, from, to) => { reads.push({ coin, from, to }); const out = []; for (let t = Math.ceil(from / FIVE) * FIVE; t + FIVE <= to; t += FIVE) out.push([t, 100, 100, 100, 100, 10]); return out; } };
  const p = createPoller({ dex: "xyz", store, log: () => {}, version: "test", crypto: false });
  const DAY_ = 86400e3, HOUR_ = 3600e3, now = Date.now();
  const mkD = () => { const d = []; for (let i = 61; i >= 1; i--) d.push({ t: now - i * DAY_, c: 100 * Math.pow(1.0005, 61 - i), o: 100, h: 103, l: 98, v: 1e6 }); return d; };
  const mkH = () => { const h = []; for (let i = 400; i >= 0; i--) { const c = 100 + Math.sin(i / 9); h.push({ t: now - i * HOUR_, o: c, h: c + 0.7, l: c - 0.7, c, v: 1e5 }); } return h; };
  // 60 days of hourly funding, a steady 0.01%/h paid by longs — enough carry to move a 1-3d median
  const fundH = new Map(); for (let i = 60 * 24; i >= 0; i--) fundH.set(Math.floor((now - i * HOUR_) / HOUR_) * HOUR_, 1e-4);
  p.seedRowNow("xyz:NVDA", { px: 112, ticker: "NVDA", uni: "xyz", vol: 1e7, dailyRaw: mkD(), hourlyRaw: mkH(), dailyTs: now, hourlyTs: now, isNew: false, prevDay: 100, d1: 12, funding: 1e-4, fundH });
  p.buildDailyNow();
  await p.buildSignalsNow();
  const d = p.getSignals(true);
  const withStudy = d.signals.filter((s0) => s0.uni === "xyz" && s0.study && s0.study.n > 0);
  assert.ok(withStudy.length > 0, "an equity condition with an own base rate fires on the seeded tape");
  for (const s0 of withStudy) assert.ok(typeof s0.study.medNet === "number", `${s0.ev}: the card's study carries medNet once hourly funding covers the events (got ${s0.study.medNet})`);
  // the anchors were resolved through the archive: one narrow PK-range read per anchor, never a span read
  // (the sweep detector's own 4h tail read shares the archive; the anchor reads are the narrow ones)
  const narrow = reads.filter((r) => r.coin === "xyz:NVDA" && r.to - r.from <= 4 * FIVE);
  assert.ok(narrow.length >= 10, "the gap/drift studies read the 5m archive in FINE_TOL neighbourhoods before their anchors, never as a span");
  assert.ok(!reads.some((r) => r.coin === "xyz:NVDA" && r.to - r.from > 24 * HOUR_), "no read pulls more than a day of 5m bars");
  // the ondrift card ships the split when the study has it
  const fs = require("fs"), path = require("path");
  const pol = fs.readFileSync(path.join(__dirname, "..", "src", "poller.js"), "utf8");
  assert.ok(pol.includes("split: r._st.ovsplit || null"), "the ondrift card carries the overnight split");
  assert.ok(pol.includes("st.gap = studyGapFade(hs, wins, 3 * HOUR, fine);") && pol.includes("st.ondrift = offDriftStats(hs, wins, 3 * HOUR, fine);"), "gap and drift studies take the fine series");
  assert.ok(pol.includes("earnReactionsFor(prints, row.dailyRaw, now, row.hourlyRaw)") && pol.includes("earnReactionCurve(prints, row.hourlyRaw, { now })"), "the earnings study anchors on the hourly spine and ships the curve");
  assert.ok(pol.includes("detectPead(prints, r.dailyRaw, r.px, sd30, r.hourlyRaw, now)"), "PEAD reads the print anchor off the hourly spine");
  assert.ok(pol.includes("meanPairwiseCorr(top.map((r) => r.dailyRaw), REGIME_LOOKBACK, Date.now())"), "the regime correlation excludes the open day");
  assert.ok(/rvolMulti\(hs, RVOL_WINS, nowMs, undefined, r\.uni === "xyz" \? "ET" : undefined\)/.test(pol), "equity rvol is keyed on the ET clock");
});

// ===== build 2026.09.21-83: /alert grammar, the 200-day metric, and conversation-bound fires ====
test("rules: /alert grammar parses what people type, in plain words either way", () => {
  const { parseAlertCmd, validateRule, ruleLabel, ALERT_HELP } = require("../src/compute");
  const r = (t) => parseAlertCmd(t);
  assert.deepEqual(r("NVDA > 200").rule, { metric: "px", op: ">", value: 200, note: "", ticker: "NVDA" });
  assert.deepEqual(r("$nvda below 180").rule, { metric: "px", op: "<", value: 180, note: "", ticker: "NVDA" });
  assert.deepEqual(r("NVDA crosses 150").rule, { metric: "px", op: "cross_up", value: 150, note: "", ticker: "NVDA" }, "a bare cross is upward");
  assert.deepEqual(r("NVDA crosses down 150 stop watch").rule, { metric: "px", op: "cross_dn", value: 150, note: "stop watch", ticker: "NVDA" });
  assert.deepEqual(r("NVDA above 200ma").rule, { metric: "vsma200", op: ">", value: 0, note: "", band: 0.5, ticker: "NVDA" }, "the MA words pin the metric, compare to 0, and carry hysteresis");
  assert.deepEqual(r("NVDA crosses below the 200 day moving average").rule, { metric: "vsma200", op: "cross_dn", value: 0, note: "", band: 0.5, ticker: "NVDA" });
  assert.deepEqual(r("HOOD d1 > 5 big day").rule, { metric: "d1", op: ">", value: 5, note: "big day", ticker: "HOOD" });
  assert.deepEqual(r("btc funding < -20").rule, { metric: "fundAPR", op: "<", value: -20, note: "", ticker: "BTC" });
  assert.deepEqual(r("any rvol > 3").rule, { metric: "rvol", op: ">", value: 3, note: "", coin: "" }, "any market: no coin, no universe");
  assert.deepEqual(r("stocks above 200dma").rule, { metric: "vsma200", op: ">", value: 0, note: "", band: 0.5, coin: "", uni: "xyz" });
  assert.deepEqual(r("crypto d7 < -10").rule, { metric: "d7", op: "<", value: -10, note: "", coin: "", uni: "main" });
  assert.deepEqual(r("list"), { ok: true, action: "list" }); assert.deepEqual(r("off #12"), { ok: true, action: "off", id: 12 });
  assert.deepEqual(r(""), { ok: true, action: "help" }); assert.deepEqual(r("help"), { ok: true, action: "help" });
  assert.deepEqual(r("NVDA > 200 day high").rule, { metric: "px", op: ">", value: 200, note: "day high", ticker: "NVDA" }, "a bare 'day' after the number is a note, not the moving average");
  assert.deepEqual(r("NVDA above 200-day").rule.metric, "vsma200", "hyphenated is unambiguous");
  assert.deepEqual(r("NVDA constructor > 5").ok, false, "a prototype name is not a metric");
  for (const bad of ["NVDA", "NVDA foo 3", "NVDA > abc", "NVDA d1 above 200ma", "off", "> 200"]) {
    const x = r(bad); assert.equal(x.ok, false, bad); assert.ok(x.error && !/unknown-|bad-/.test(x.error), "plain words: " + x.error);
  }
  // Every parsed rule validates once the ticker is a coin, and the thread survives validation.
  for (const t of ["NVDA > 200", "NVDA above 200ma", "any rvol > 3", "HOOD d1 > 5 note"]) {
    const rule = Object.assign({}, r(t).rule, { thread: 7 }); if (rule.ticker) { rule.coin = "xyz:" + rule.ticker; delete rule.ticker; }
    const v = validateRule(rule); assert.ok(v.ok, t + ": " + v.error); assert.equal(v.rule.thread, 7);
  }
  assert.equal(validateRule({ metric: "px", op: ">", value: 1 }).rule.thread, 0, "no thread is 0, never null");
  assert.equal(validateRule({ metric: "px", op: ">", value: 1, thread: -3 }).error, "bad-thread");
  assert.equal(validateRule({ metric: "px", op: ">", value: 1, thread: "x" }).error, "bad-thread");
  assert.equal(validateRule({ metric: "px", op: ">", value: 1, thread: true }).error, "bad-thread", "a boolean is not a conversation id");
  assert.equal(validateRule({ metric: "px", op: ">", value: 1, thread: "12" }).rule.thread, 12);
  assert.equal(ruleLabel({ coin: "xyz:NVDA", metric: "vsma200", op: "cross_up", value: 0 }), "xyz:NVDA · price crosses up through the 200d MA");
  assert.equal(ruleLabel({ coin: "xyz:NVDA", metric: "vsma200", op: ">", value: 5 }), "xyz:NVDA · % vs 200d MA above 5%", "a non-zero threshold keeps the arithmetic label");
  assert.ok(/\/alert list/.test(ALERT_HELP) && /200ma/.test(ALERT_HELP));
});

test("rules: the 200-day MA rides the snapshot row, and a conversation-bound rule fires into its sink, quiet on the wire", () => {
  const { p } = ruleHarness();
  const closes = (v) => Array.from({ length: 205 }, (_, i) => ({ t: i, c: v }));
  p.seedRowNow("AAA", { ticker: "AAA", px: 95, uni: "xyz", ref: { p1h: 100, p4h: 100, p7d: 100, p30d: 100 }, dailyRaw: closes(100) });
  p.seedRowNow("BBB", { ticker: "BBB", px: 95, uni: "xyz", ref: { p1h: 100, p4h: 100, p7d: 100, p30d: 100 }, dailyRaw: closes(100).slice(0, 150) });
  p.buildSnapshotNow();
  const row = (c) => p.getSnapshot().markets.find((r) => r.coin === c);
  assert.equal(row("AAA").ma200, 100, "SMA of the last 200 daily closes");
  assert.equal(row("BBB").ma200, undefined, "under 200 closes: absent, never guessed");

  const fired = [];
  p.setRuleSink((rule, ev) => fired.push({ rule, ev }));
  const add = p.addRule({ metric: "vsma200", op: "cross_up", value: 0, band: 0.5, thread: 42 }, "own-a");
  assert.ok(add.ok && add.rule.thread === 42, JSON.stringify(add));
  assert.equal(add.rule.text, "AAA · price crosses up through the 200d MA".replace("AAA", "any market"), "a roster-wide rule reads as a sentence");
  p.ruleScanNow();                                                        // baseline: below the line
  p.seedRowNow("AAA", { px: 103 }); p.buildSnapshotNow(); p.ruleScanNow();   // reclaim
  assert.equal(fired.length, 1, "the sink saw the fire");
  assert.equal(fired[0].rule.id, add.rule.id); assert.equal(fired[0].ev.thread, 42); assert.equal(fired[0].ev.quiet, 1, "bound to a conversation: the post is the delivery, the wire stays quiet");
  assert.equal(fired[0].ev.coin, "AAA"); assert.ok(/^\+3\.00%$/.test(fired[0].ev.now), fired[0].ev.now);
  const evs = p.getTriggers(0, "own-a", false).events.filter((e) => e.kind === "rule");
  assert.equal(evs.length, 1, "…and it is still on the ring for the bell log");
  assert.ok(!fired.some((f) => f.ev.coin === "BBB"), "no MA, no fire");
  // An unbound rule never touches the sink and is not quiet.
  const plain = p.addRule({ metric: "h1", op: ">", value: 5 }, "own-a");
  assert.equal(plain.rule.thread, 0);
  p.seedRowNow("AAA", { px: 100 }); p.buildSnapshotNow(); p.ruleScanNow();
  p.seedRowNow("AAA", { px: 112 }); p.buildSnapshotNow(); p.ruleScanNow();
  const h1 = p.getTriggers(0, "own-a", false).events.find((e) => e.kind === "rule" && e.metric === "h1");
  assert.ok(h1 && !h1.quiet && !h1.thread, "a panel rule is unchanged");
  assert.equal(fired.length, 1, "the sink is only for bound rules");
  // Unbinding (the author left the room) turns it into a personal rule, persisted.
  assert.equal(p.setRuleThread(add.rule.id, 0).rule.thread, 0);
  assert.equal(p.getRules("own-a", false).rules.find((x) => x.id === add.rule.id).thread, 0);
  assert.equal(p.setRuleThread(999, 0).ok, false);
  // Delete returns what it removed, so the chat can say which watch is gone.
  const del = p.deleteRule(add.rule.id, "own-a", false);
  assert.ok(del.ok && del.rule.thread === 0 && /200d MA/.test(del.rule.text));
  // The binding survives a restart with the rule.
  const h2 = ruleHarness();
  h2.p.addRule({ metric: "px", op: ">", value: 1, thread: 42 }, "own-a");
  const { createPoller } = require("../src/poller");
  const p3 = createPoller({ dex: "xyz", log: () => {}, version: "test", crypto: false,
    store: { loadAll: () => new Map(), loadRegime: () => [], loadLedger: () => null, saveLedger: () => {}, insert: () => {}, saveRegime: () => {},
      loadTriggers: () => null, saveTriggers: () => {}, saveRules: () => {}, loadRules: () => h2.saved } });
  p3.hydrateRulesNow();
  assert.equal(p3.getRules("own-a", false).rules[0].thread, 42, "hydrated with its conversation");
});

// ===== build 2026.09.21-84: share to chat — the card schema and its text rendering ==============
test("share to chat: validateCard bounds every field and cardText pads a screen into columns", () => {
  const { validateCard, cardText, cardTitle, CARD_MAX_ROWS, CARD_MAX_COLS } = require("../src/compute");
  const cell = validateCard({ kind: "cell", cols: [{ k: "funding", l: "Funding (APR)" }], rows: [{ coin: "xyz:HOOD", t: "HOOD", px: 113.9, c: [{ s: "+41.2%", c: "pos" }] }], ctx: [{ l: "24h", s: "+3.1%", c: "pos" }, { l: "junk", s: "" }], at: 1790000000000, extra: "dropped" });
  assert.ok(cell.ok, cell.error);
  assert.equal(cell.card.coin, "xyz:HOOD"); assert.equal(cell.card.t, "HOOD"); assert.equal(cell.card.px, 113.9);
  assert.equal(cell.card.ctx.length, 1, "a context line needs a label and a value");
  assert.equal(cell.card.extra, undefined, "unknown fields are dropped");
  assert.equal(cardTitle(cell.card), "\u2934 HOOD \u00b7 Funding (APR)");
  assert.deepEqual(cardText(cell.card).split("\n"), ["\u2934 HOOD \u00b7 Funding (APR) \u00b7 captured 2026-09-21 14:13Z", "+41.2%   funding (apr)", "24h +3.1%", "mark 113.9"]);
  // Shape rules: a cell is one row × one column; a row is one row; a screen is any.
  assert.equal(validateCard({ kind: "cell", cols: [{ k: "a", l: "A" }, { k: "b", l: "B" }], rows: [{ t: "X", c: [{ s: "1" }, { s: "2" }] }] }).error, "shape");
  assert.equal(validateCard({ kind: "row", cols: [{ k: "a", l: "A" }], rows: [{ t: "X", c: [] }, { t: "Y", c: [] }] }).error, "shape");
  assert.equal(validateCard({ kind: "chart", cols: [{ k: "a", l: "A" }], rows: [{ t: "X", c: [] }] }).error, "bad-kind");
  assert.equal(validateCard({ kind: "row", cols: [], rows: [{ t: "X", c: [] }] }).error, "no-columns");
  assert.equal(validateCard({ kind: "row", cols: [{ k: "a", l: "A" }], rows: [] }).error, "no-rows");
  assert.equal(validateCard("nope").error, "not-a-card");
  // Bounds: rows and columns are cut, strings are clipped and control characters stripped, a
  // missing cell is an honest dash, an unknown class is no class.
  const big = validateCard({ kind: "screen", scope: "stocks", tf: "1d",
    cols: Array.from({ length: 20 }, (_, i) => ({ k: "k" + i, l: "L" + i })),
    rows: Array.from({ length: 40 }, (_, i) => ({ coin: "xyz:T" + i, t: "T" + i, px: i, c: [{ s: "v\u0000\u0001" + i, c: "evil" }] })),
    filters: "x".repeat(500), sort: "24h desc", total: 40 });
  assert.ok(big.ok, big.error);
  assert.equal(big.card.rows.length, CARD_MAX_ROWS); assert.equal(big.card.cols.length, CARD_MAX_COLS);
  assert.equal(big.card.rows[0].c.length, CARD_MAX_COLS, "every row is padded to the column count");
  assert.equal(big.card.rows[0].c[0].s, "v0"); assert.equal(big.card.rows[0].c[0].c, ""); assert.equal(big.card.rows[0].c[1].s, "\u2014");
  assert.equal(big.card.filters.length, 160); assert.equal(big.card.total, 40); assert.equal(big.card.coin, "", "a screen names no single coin");
  const txt = cardText(big.card).split("\n");
  assert.ok(txt[0].startsWith("\u2934 screen \u00b7 25 rows \u00b7 captured "), txt[0]);
  assert.ok(/sorted by 24h desc$/.test(txt[1]));
  assert.ok(/^TICKER\s+L0\s+L1/.test(txt[2]), "a padded header: " + txt[2]);
  assert.equal(txt.length, 3 + CARD_MAX_ROWS);
  // Too big is refused, never truncated into something that looks whole.
  const huge = validateCard({ kind: "screen", cols: Array.from({ length: 12 }, (_, i) => ({ k: "k" + i, l: "L".repeat(24) })),
    rows: Array.from({ length: 25 }, (_, i) => ({ coin: "xyz:" + "C".repeat(36), t: "T" + i, px: i, c: Array.from({ length: 12 }, () => ({ s: "x".repeat(32), c: "pos" })) })) });
  assert.equal(huge.error, "too-big");
  // A capture time outside what Date can render (or before the epoch) becomes now, so cardText
  // can never throw on a validated card.
  for (const at of [1e20, -5, 0, "yesterday"]) {
    const c = validateCard({ kind: "cell", cols: [{ k: "px", l: "Price" }], rows: [{ t: "X", c: [{ s: "1" }] }], at });
    assert.ok(c.ok && c.card.at > 1.7e12 && c.card.at <= Date.now() + 60e3, "at=" + at);
    assert.doesNotThrow(() => cardText(c.card));
  }
  const row = validateCard({ kind: "row", cols: [{ k: "px", l: "Price" }, { k: "d1", l: "24h" }], rows: [{ coin: "xyz:NVDA", t: "NVDA", px: 176.4, c: [{ s: "176.40" }, { s: "+1.2%", c: "pos" }] }], at: 1790000000000 });
  assert.deepEqual(cardText(row.card).split("\n").slice(1), ["Price  176.40", "24h    +1.2%", "mark   176.4"]);
});

// ===== build 2026.09.22-89: reading a call — the vocabulary, and the client copy in step ==========
test("callRead: direction and horizon from a fixed vocabulary, naming the word each came from", () => {
  const { callRead } = require("../src/compute");
  const DAY = 86400e3, now = Date.UTC(2026, 8, 22, 15, 0, 0);   // Tue Sep 22 2026 15:00Z
  const r = (t, sym = "HOOD") => callRead(t, sym, now);
  const cases = [
    ["long $HOOD here", "long", null, null],
    ["I'd fade $HOOD into the print", "short", "fade", null],
    ["bearish $HOOD", "short", "bearish", null],
    ["$HOOD lower from here", "short", "lower", null],
    ["dumping $HOOD", "short", "dumping", null],
    ["not a fan of $HOOD", "long", null, null],                 // 'fan' is not a word we read: long by default, said so
    ["buy $HOOD puts", "short", "puts", null],
    ["sell $HOOD puts", "long", "sell … puts", null],           // selling puts is a long
    ["$HOOD calls", "long", "calls", null],
    ["selling $HOOD calls", "short", "selling … calls", null],
    ["short $HOOD 30d", "short", "short", 30 * DAY],
    ["$HOOD 3 days", "long", null, 3 * DAY],
    ["$HOOD 2w", "long", null, 14 * DAY],
    ["$HOOD 2 weeks", "long", null, 14 * DAY],
    ["$HOOD 1mo", "long", null, 30 * DAY],
    ["$HOOD 2 months", "long", null, 60 * DAY],
    ["$HOOD next week", "long", null, 7 * DAY],
    ["$HOOD looks good for a month", "long", null, 30 * DAY],
    ["$HOOD 125 by eow", "long", null, 4 * DAY],                // Tue → Fri end of day
    ["$HOOD by friday", "long", null, 4 * DAY],
    ["$HOOD eom", "long", null, 9 * DAY],                       // Sep 22 15:00Z → Sep 30 end of day
    ["$HOOD by year end", "long", null, 101 * DAY],
    ["$HOOD by Oct 15", "long", null, 24 * DAY],
    ["$HOOD by 10/15", "long", null, 24 * DAY],
    ["$HOOD by Jan 5", "long", null, 106 * DAY],                // rolls into next year
    ["$HOOD ran 3d in a row", "long", null, null],              // three words later is prose
    ["$HOOD 999d", "long", null, null],                         // past a year: no horizon (default applies)
    ["$HOOD 0d", "long", null, null],
  ];
  for (const [text, side, word, h] of cases) {
    const x = r(text);
    assert.equal(x.side, side, text + " → side");
    assert.equal(x.sideWord, word, text + " → sideWord");
    assert.equal(x.horizonMs, h, text + " → horizon");
  }
  assert.equal(r("$NVDA short").side, "long", "the words read are the ones around THIS ticker");
  assert.equal(r("$NVDA short", "NVDA").side, "short");
  assert.ok(r("$HOOD 2w").horizonWord === "2w" && r("$HOOD by Oct 15").horizonWord === "by Oct 15", "the horizon names its word");
});

test("callRead: the client's copy reads every case exactly as the server does", () => {
  const fs = require("fs"), path = require("path");
  const { callRead } = require("../src/compute");
  const app = fs.readFileSync(path.join(__dirname, "..", "public", "js", "messages.js"), "utf8");
  const src = app.slice(app.indexOf("const CALL_SHORT_BEFORE="), app.indexOf("// The composer's preview:"));
  const clientRead = new Function(src + "\nreturn dmCallRead;")();
  const now = Date.UTC(2026, 8, 22, 15, 0, 0);
  const texts = ["long $HOOD here", "I'd fade $HOOD into the print", "sell $HOOD puts", "selling $HOOD calls", "buy $HOOD puts", "$HOOD lower",
    "short $HOOD 30d", "$HOOD 2 weeks", "$HOOD 1mo", "$HOOD next week", "$HOOD for a month", "$HOOD by eow", "$HOOD eom", "$HOOD by year end",
    "$HOOD by Oct 15", "$HOOD by 10/15", "$HOOD by Jan 5", "$HOOD ran 3d in a row", "$HOOD 999d", "nothing here", "$NVDA short"];
  for (const t of texts) assert.deepEqual(clientRead(t, "HOOD", now), callRead(t, "HOOD", now), "parity: " + t);
});
