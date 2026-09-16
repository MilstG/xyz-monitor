"use strict";
// compute.js — event studies, levels, ledger geometry, trend, backtest. Split out of test.js (build 2026.09.16-80); order within the file is the original order.
const test = require("node:test");
const assert = require("node:assert");
const { median, studyBreakdown, playbook, studyOIFlush, studyFPDiv, HOUR, DAY, C, zigDaily, ZIG_PTS, normCdf, touchBaseline, studyBars, levelOutcomes, levelStudy, LVL_EDGES, PLACEBO_K, _walk, sessionRecords, anatomyEnrich, mondayStats, nakedStats, anatomyPool, MFE_EDGES, detectWickFill, detectRoundFront, roundStep, pivotPool, anatomyTickerSummary, maDaily, maSd, svBars } = require("./_shared");


test("event studies: continuation series shows continuation; sample sizes honest", () => {
  const DAYMS = 86400 * 1000, t0 = Date.UTC(2025, 0, 1);
  // trending series with occasional 3-sigma up-thrusts that keep running
  const closes = []; let px = 100;
  for (let i = 0; i < 200; i++) {
    px *= 1 + (i % 25 === 0 && i > 30 ? 0.06 : 0.004) + (i % 2 ? 0.002 : -0.002);
    closes.push([t0 + i * DAYMS, px]);
  }
  const bm = C.studyBigMove(closes);
  assert.ok(bm.d1.n >= 5, "found events");
  assert.ok(bm.d1.med > 0, "uptrend thrusts continued (direction-signed median positive)");
  const bo = C.studyBreakout(closes);
  assert.ok(bo.d5.n > 0 && bo.d5.med > 0, "breakouts in a trend resolve up");
  assert.deepEqual(C.summarizeEvents([]), { n: 0 }, "empty in, honest zero out");
});

test("playbook: explicit sides and mechanical levels", () => {
  const bo = C.playbook("breakout", { px: 105, level: 100, med: 2.1 });
  assert.equal(bo.side, "long");
  assert.equal(bo.stop, 100);                       // failed breakout = back below the level
  assert.ok(Math.abs(bo.target - 105 * 1.021) < 0.01);
  const pr = C.playbook("prem", { prem: 18, oracle: 250, closed: true });
  assert.equal(pr.side, "short");                   // perp rich -> reversion means short the perp
  assert.equal(pr.target, 250);                     // reversion target IS the oracle
  assert.ok(/rich/.test(pr.bias));
  const gp = C.playbook("gap", { px: 101, closePx: 100, gapDir: 1, gapSd: 0.8, med: -0.4, n: 12 });
  assert.equal(gp.side, "short");                   // proven fader + up-gap = short into the session
  assert.ok(/FADES/.test(gp.bias) && gp.target === 100);
  assert.equal(C.playbook("gap", { px: 101, closePx: 100, gapDir: 1, gapSd: 0.8, med: -0.4, n: 3 }).side, "watch"); // unproven never picks a side
  assert.equal(C.playbook("fundflip", { dir: -1 }).side, "short");
  assert.equal(C.playbook("volume", {}).side, "watch");
});

test("study overlap F10: the d5 window guard spaces accepted events ~5 apart on a daily-breakout run", () => {
  // A monotonic staircase makes a NEW 30d high every single day for a stretch — a breakout fires
  // daily. Without the guard, d5 counts nearly every day (heavily overlapping 5d windows); WITH the
  // guard, accepted d5 events sit >=5 days apart, so d5.n collapses to roughly d1.n / 5. This is the
  // pseudo-replication the guard exists to kill, made explicit.
  const closes = [];
  for (let i = 0; i < 80; i++) closes.push([Date.now() - (120 - i) * DAY, 100]);        // flat base -> 30d high = 100
  for (let i = 0; i < 40; i++) closes.push([Date.now() - (40 - i) * DAY, 100 + i * 2]); // rising daily -> a new high every day
  const bo = C.studyBreakout(closes);
  assert.ok(bo.d1.n >= 25, "the staircase fires a breakout nearly every day (d1 counts them)");
  assert.ok(bo.d5.n * 4 <= bo.d1.n, "d5 accepted events are spaced ~5 apart -> far fewer than d1 (the guard fired)");
  assert.ok(bo.d5.n >= 5, "the guard thins, it does not empty");
  assert.equal(bo.d5.n, bo.raw.d5.length, "raw d5 array and summarized n agree — no double counting");
});

test("gap study F-gap: the forward session uses the TRUE close, honoring early-close half-days", () => {
  // 2025-07-03 is a US early close (13:00 ET / 17:00 UTC) because Jul 4 2025 is a Friday. Its
  // session opens 09:30 ET (13:30 UTC); a fixed open+6.5h lands at 20:00 UTC (16:00 ET) — 3h past
  // the real close. We prove the study reads the TRUE 13:00 close by making the price at 13:00
  // differ sharply from the 16:00 print, and by making 2025-07-03 the ONLY qualifying (>=0.75σ)
  // gap so its outcome is the only session return in the record.
  const HH = HOUR;
  // A long, flat hourly spine covering late June -> July 3, close at index 4 (OHLCV). Small daily
  // wiggles on the prior days give the gap-sigma sample nonzero variance without any of them
  // reaching the 0.75σ threshold; the July-3 +10% gap is the lone qualifier.
  const spine = [];
  const start = Date.UTC(2025, 5, 20, 12, 0), end = Date.UTC(2025, 6, 3, 22, 0);
  const open = Date.UTC(2025, 6, 3, 13, 30), trueClose = Date.UTC(2025, 6, 3, 17, 0), phantom = Date.UTC(2025, 6, 3, 20, 0);
  // A row's t is the bar's OPEN; its close is the print at t+1h (the -67 priceAsOf semantics), so
  // the regimes are keyed on the bar's close time.
  for (let t = start; t <= end; t += HH) {
    const ct = t + HH;
    let c = 100 + 0.3 * Math.sin(t / (7 * HH));   // gentle sub-threshold wiggle
    if (ct > open && ct < trueClose) c = 110;
    else if (ct >= trueClose && ct < phantom) c = 130;
    else if (ct >= phantom) c = 101;
    spine.push([t, c, c, c, c]);
  }
  // Gap windows: 11 tiny filler gaps (sub-threshold, to build the sd sample) on prior days, plus
  // the July-3 gap (prior close 100 -> open 110 = +10%, the outlier that clears 0.75σ).
  const windows = [];
  for (let i = 0; i < 11; i++) {
    const day = Date.UTC(2025, 5, 21 + i, 20, 0);   // ~16:00 ET prior close
    windows.push({ enter: day, exit: day + 17.5 * HH });   // tiny drift across the hold -> ~0 gap
  }
  windows.push({ enter: Date.UTC(2025, 6, 2, 20, 0), exit: open });   // the qualifying July-3 gap
  const res = C.studyGapFade(spine, windows, 4 * HH);
  assert.ok(res.sd > 0, "enough gaps to establish the gap-sigma baseline");
  assert.ok(res.raw && res.raw.session.length >= 1, "the July-3 gap qualifies and is measured");
  // Open 110 -> TRUE 13:00 close 130 = +18.2%, signed with the up gap = positive and large. The old
  // fixed +6.5h would have read the 101 revert (~ -8%). A clearly-positive outcome proves the fix.
  assert.ok(res.raw.session.some((x) => x > 10),
    "measured to the 13:00 half-day close (+18%), not the phantom 16:00 revert (which would be negative)");
});

test("EV_META horizons align with the studies' sign conventions", () => {
  assert.equal(C.EV_META.bigmove.horizonMs, DAY);
  assert.equal(C.EV_META.breakout.horizonMs, 5 * DAY);
  assert.equal(C.EV_META.gap.horizonMs, null);      // gap resolves at the next session close, calendar-aware
});


test("shadow-variant promotion: strict out-of-sample gates + SE-scaled margin (F4)", () => {
  // With dispersion supplied, the margin is max(0.08, 1 pooled SE). A tight-dispersion challenger
  // that clears its own SE promotes; the SAME avg edge under wide dispersion does not.
  const incT = { n: 40, hit: 0.55, avg: 0.20, sd: 0.4 };   // tight
  assert.ok(C.shouldPromote(incT, { n: 40, hit: 0.58, avg: 0.45, sd: 0.4 }),
    "a genuine beat that clears the pooled SE promotes");   // SE~0.089, margin~0.089, edge 0.25 >> margin
  assert.ok(!C.shouldPromote(incT, { n: 40, hit: 0.58, avg: 0.31, sd: 1.3 }),
    "the same nominal edge under WIDE dispersion is inside the noise and does not promote");   // SE~0.29 > 0.11 edge
  // Structural gates unchanged.
  assert.ok(!C.shouldPromote(incT, { n: 22, hit: 0.60, avg: 0.90, sd: 0.4 }), "n<30 never promotes");
  assert.ok(!C.shouldPromote({ n: 12, hit: 0.5, avg: 0.1, sd: 0.4 }, { n: 40, hit: 0.6, avg: 0.9, sd: 0.4 }), "incumbent must also have 30");
  assert.ok(!C.shouldPromote(incT, { n: 40, hit: 0.40, avg: 0.90, sd: 0.4 }), "hit collapse blocks tail-riders");
  assert.ok(!C.shouldPromote({ n: 40, hit: 0.45, avg: -0.10, sd: 0.4 }, { n: 40, hit: 0.46, avg: -0.01, sd: 0.4 }), "challenger expectancy must be positive");
  // Missing sd -> conservative 1.0R proxy, so the bar is WIDER than the old fixed 0.08 (never
  // looser). The old "clear beat" fixture (0.11R edge, n~37) no longer clears under that proxy —
  // which is the whole point of F4: that edge was inside the sampling error.
  const incNoSd = { n: 40, hit: 0.55, avg: 0.20 };
  assert.ok(!C.shouldPromote(incNoSd, { n: 34, hit: 0.58, avg: 0.31 }),
    "without dispersion the 1.0R proxy makes a 0.11R edge fail — the fixed-0.08 promotion is gone");
  assert.ok(C.shouldPromote(incNoSd, { n: 40, hit: 0.58, avg: 0.90 }),
    "a large edge still clears even the conservative proxy");
});

test("stop-touch: conservative hourly walk with direction semantics", () => {
  const H = 3600e3, t0 = 0;
  const mk = (i, h, l) => [t0 + (i + 1) * H, 100, h, l, 100, 1];
  const cs = [mk(0, 101, 99.5), mk(1, 102, 98.4), mk(2, 103, 99)];
  assert.equal(C.stopTouched(cs, t0, t0 + 4 * H, 1, 98.5), true, "long stopped: candle low pierced");
  assert.equal(C.stopTouched(cs, t0, t0 + 4 * H, 1, 98.0), false, "long survives: never traded that low");
  assert.equal(C.stopTouched(cs, t0, t0 + 4 * H, -1, 102.5), true, "short stopped: candle high pierced");
  assert.equal(C.stopTouched(cs, t0, t0 + 4 * H, -1, 103.5), false, "short survives");
  assert.equal(C.stopTouched(cs, t0, t0 + 1 * H, 1, 98.5), false, "touch after window end does not count");
  assert.equal(C.stopTouched([], t0, t0 + 4 * H, 1, 98.5), null, "no candles = unknowable, not a verdict");
});


test("breakdown study: outcomes signed with the breakdown (falls = positive)", () => {
  // 40 flat closes at 100, then a first cross below the 30d low followed by continued decline
  const closes = [];
  for (let i = 0; i < 40; i++) closes.push([i * 86400000, 100 + (i % 3) * 0.4]);
  closes.push([40 * 86400000, 97]);    // first close below the prior-30 low
  for (let i = 1; i <= 6; i++) closes.push([(40 + i) * 86400000, 97 - i * 1.5]);  // continues down
  const st = studyBreakdown(closes);
  assert.ok(st.raw.d5.length >= 1, "breakdown event detected");
  assert.ok(st.raw.d5[0] > 0, "continued decline scores POSITIVE under the breakdown sign convention");
});

test("playbook: breakdown is short with stop at the level; unwind mirrors squeeze below the range", () => {
  const bd = playbook("breakdown", { px: 95, level: 100, med: 2 });
  assert.equal(bd.side, "short");
  assert.equal(bd.stop, 100);
  assert.ok(bd.target < 95, "target below entry");
  const uw = playbook("unwind", { hi30: 120, lo30: 100 });
  assert.equal(uw.side, "short");
  assert.ok(Math.abs(uw.target - (100 - 0.382 * 20)) < 1e-9, "measured-move extension BELOW the range");
  assert.ok(Math.abs(uw.stop - (120 - 0.25 * 20)) < 1e-9, "stop in the upper quarter");
});


test("oiflush study: flush into decline scores long-signed; needs trailing stats", () => {
  const DAY=86400000, closes=[], oi=[];
  for(let i=0;i<80;i++){ closes.push([i*DAY, 100+(i%5)*0.3]); oi.push([i*DAY, 1000+(i%7)*5]); }
  // engineered flush at day 70: OI -30% over 7d, price -4% over 7d, then a bounce
  for(let i=64;i<=70;i++){ oi[i]=[i*DAY, 1000-(i-63)*45]; closes[i]=[i*DAY, 100-(i-63)*0.6]; }
  for(let i=71;i<80;i++) closes[i]=[i*DAY, 96.4+(i-70)*0.5];
  const st=studyOIFlush(closes, oi);
  assert.ok(st && st.raw.d5.length>=1, "flush detected");
  assert.ok(st.raw.d5[st.raw.d5.length-1]>0, "bounce after the final flush day scores positive (long-signed)");
  assert.ok(st.cur && st.cur.sd>0, "current trailing stats exposed for live z-scoring");
});

test("fpdiv study: weakness + rising funding scores short-signed on continued decline", () => {
  const DAY=86400000, closes=[], df=[];
  for(let i=0;i<40;i++){ closes.push([i*DAY, 100+(i%4)*0.25]); df.push([i*DAY, 0.0002]); }
  // days 23-30: price slides 5%, funding RISES (longs paying up into weakness), then keeps falling
  for(let i=23;i<=30;i++){ closes[i]=[i*DAY, 100-(i-22)*0.7]; df[i]=[i*DAY, 0.0002+(i-22)*0.0002]; }
  for(let i=31;i<40;i++){ closes[i]=[i*DAY, 94.4-(i-30)*0.5]; df[i]=[i*DAY, 0.0018]; }
  const st=studyFPDiv(closes, df);
  assert.ok(st && st.raw.d3.length>=1, "divergence detected");
  assert.ok(st.raw.d3[st.raw.d3.length-1]>0, "continued decline scores positive under the SHORT claim sign");
});

test("ondrift playbook: windowed-hold claim, no levels", () => {
  const pLong=playbook("ondrift",{dir:1}), pShort=playbook("ondrift",{dir:-1});
  assert.equal(pLong.side,"long"); assert.equal(pShort.side,"short");
  assert.equal(pLong.target,null); assert.equal(pLong.stop,null);
});

// ===== trend leaderboard (build -47) =====
test("emaLast: SMA-seeded EMA — constants, convergence direction, honest nulls", () => {
  const { emaLast } = require("../src/compute");
  // a constant series has EMA == the constant, exactly
  assert.equal(emaLast(new Array(40).fill(7), 13), 7);
  assert.equal(emaLast(new Array(40).fill(7), 21), 7);
  // rising series: EMA lags below the last close; the faster EMA sits closer to price
  const up = Array.from({ length: 60 }, (_, i) => 100 * Math.pow(1.01, i));
  const e13 = emaLast(up, 13), e21 = emaLast(up, 21), last = up[up.length - 1];
  assert.ok(e13 < last && e21 < last, "both EMAs lag a rising series");
  assert.ok(e13 > e21, "the 13 tracks a rising price more closely than the 21");
  // hand-check against an independent reference construction (seed SMA, recurse)
  const ref = (cl, n) => { let e = cl.slice(0, n).reduce((a, b) => a + b) / n, a = 2 / (n + 1);
    for (let i = n; i < cl.length; i++) e = a * cl[i] + (1 - a) * e; return e; };
  assert.ok(Math.abs(e13 - ref(up, 13)) < 1e-9);
  assert.ok(Math.abs(e21 - ref(up, 21)) < 1e-9);
  // insufficient history is a null, never a half-converged number
  assert.equal(emaLast(up.slice(0, 20), 21), null);
  assert.equal(emaLast(up.slice(0, 25), 13), null, "TREND_MIN_BARS floor applies even to the 13");
  assert.equal(emaLast([1, 2, "x", 4].concat(new Array(30).fill(5)), 13), null, "a NaN anywhere poisons honestly to null");
});

test("trendState: the four-state matrix from two comparisons", () => {
  const { trendState } = require("../src/compute");
  assert.equal(trendState(110, 105, 100), "up");
  assert.equal(trendState(90, 95, 100), "down");
  assert.equal(trendState(103, 105, 100), "reclaim", "above EMA21, ribbon not stacked");
  assert.equal(trendState(98, 95, 100), "roll", "below EMA21, ribbon not stacked");
  assert.equal(trendState(null, 105, 100), null);
  assert.equal(trendState(100, null, 100), null);
});

test("trend ladder + reads: full trend, retest, lagging rung, mixed, and exclusion", () => {
  const { trendLadder, trendRead } = require("../src/compute");
  const mk = (closes, lowMul, highMul) => closes.map((c, i) => ({ t: i * HOUR, h: c * (highMul || 1.002), l: c * (lowMul || 0.998), c }));
  const rise = Array.from({ length: 60 }, (_, i) => 100 * Math.pow(1.01, i - 59));   // ascends to 100
  const fall = Array.from({ length: 60 }, (_, i) => 100 * Math.pow(1.01, 59 - i));   // descends to 100
  // 4/4 uptrend, shallow recent lows -> no retest -> "Full uptrend" with the H1 distance
  const upC = mk(rise);
  let lad = trendLadder(100, { D1: upC, H12: upC, H4: upC, H1: upC });
  assert.ok(lad, "ladder computes");
  assert.equal(lad.long.score, 4);
  assert.equal(lad.short.score, 0);
  assert.equal(lad.long.retest, null, "a 0.2% wick never reaches an EMA13 lagging ~6% back");
  let read = trendRead("long", lad);
  assert.ok(/^Full uptrend — long pullbacks · \+\d/.test(read.text), read.text);
  assert.equal(trendRead("short", lad), null, "0/4 shorts is not board material");
  // deep recent wick into the ribbon while price holds -> RETEST on the highest TF (D1 first)
  const wick = mk(rise, 0.90);
  lad = trendLadder(100, { D1: wick, H12: wick, H4: wick, H1: wick });
  assert.equal(lad.long.score, 4);
  assert.equal(lad.long.retest, "D1", "highest trending TF that probed the zone is the one reported");
  read = trendRead("long", lad);
  assert.equal(read.text, "Pullback to D1 EMA21 — continuation entry");
  assert.equal(read.retest, "D1");
  // shorts mirror: rally wick into a stacked-down ribbon
  const fallWick = mk(fall, undefined, 1.10);
  lad = trendLadder(100, { D1: fallWick, H12: fallWick, H4: fallWick, H1: fallWick });
  assert.equal(lad.short.score, 4);
  assert.equal(lad.short.retest, "D1");
  read = trendRead("short", lad);
  assert.equal(read.text, "Rally to D1 EMA21 — continuation short");
  // 3/4 with one repairing rung -> "Strong — {TF} lagging"
  const flatDip = mk(new Array(50).fill(100).concat(new Array(10).fill(98)));   // e13 dragged under e21, px back at 100
  lad = trendLadder(100, { D1: upC, H12: upC, H4: upC, H1: flatDip });
  assert.equal(lad.long.score, 3);
  assert.equal(lad.tf.H1.st, "reclaim");
  read = trendRead("long", lad);
  assert.equal(read.text, "Strong — H1 lagging");
  // 2/4 split -> "Mixed — {aligned} up/down, wait for alignment" on BOTH lenses
  lad = trendLadder(100, { D1: upC, H12: upC, H4: mk(fall), H1: mk(fall) });
  assert.equal(lad.long.score, 2);
  assert.equal(lad.short.score, 2);
  assert.equal(trendRead("long", lad).text, "Mixed — D1/H12 up, wait for alignment");
  assert.equal(trendRead("short", lad).text, "Mixed — H4/H1 down, wait for alignment");
  // any rung short on history -> the whole market is excluded, never guessed
  assert.equal(trendLadder(100, { D1: upC.slice(-20), H12: upC, H4: upC, H1: upC }), null);
  assert.equal(trendLadder(null, { D1: upC, H12: upC, H4: upC, H1: upC }), null);
});

test("trendLadder: a chosen 200 MA greys rungs without the history and scores out of available", () => {
  const { trendLadder, trendRead } = require("../src/compute");
  const mk = (n, f) => Array.from({ length: n }, (_, i) => { const c = f(i); return { t: i * 3600e3, o: c, h: c * 1.001, l: c * 0.999, c }; });
  const up = (i) => 100 * Math.pow(1.003, i);
  const deep = mk(260, up), shallow = mk(60, up), px = up(259) * 1.003;
  // default 13/21: every rung seeds, avail = 4, e13/e21 keys preserved (canonical wire shape)
  let lad = trendLadder(px, { D1: deep, H12: deep, H4: deep, H1: deep });
  assert.equal(lad.avail, 4, "default pair seeds all four rungs");
  assert.ok(lad.tf.D1.e13 > 0 && lad.tf.D1.e21 > 0, "default ladder still ships e13/e21");
  assert.equal(lad.fast, 13); assert.equal(lad.slow, 21);
  // 13/200 with a shallow D1: D1 can't seed EMA200 -> grey rung, not an excluded name
  lad = trendLadder(px, { D1: shallow, H12: deep, H4: deep, H1: deep }, 13, 200);
  assert.equal(lad.tf.D1.st, "nodata", "shallow D1 greys under a 200");
  assert.equal(lad.tf.D1.e21, null, "a nodata rung carries no EMA");
  assert.equal(lad.avail, 3, "avail counts only rungs that seeded the slow MA");
  assert.equal(lad.long.score, 3, "the uptrend scores 3 up over the 3 available rungs");
  const read = trendRead("long", lad);
  assert.ok(/pending history/.test(read.text), "the read discloses the pending rung");
  assert.ok(!/D1 lagging/.test(read.text), "a pending rung is never reported as 'lagging'");
  // the 26-bar floor still excludes the whole name (unchanged contract), grey is only ABOVE it
  assert.equal(trendLadder(px, { D1: deep.slice(-20), H12: deep, H4: deep, H1: deep }, 13, 200), null,
    "a rung below the 26-bar floor still excludes the name");
});

test("retest flip point: the wick boundary sits exactly at EMA13", () => {
  const { trendLadder } = require("../src/compute");
  const rise = Array.from({ length: 60 }, (_, i) => 100 * Math.pow(1.01, i - 59));
  // shallow lows everywhere; only the LAST bar's low is controlled, so it is the binding probe
  const mk = (lastLow) => rise.map((c, i) => ({ t: i * HOUR, h: c * 1.001, l: i === 59 ? lastLow : c * 0.9999, c }));
  const base = trendLadder(100, { D1: mk(99.99), H12: mk(99.99), H4: mk(99.99), H1: mk(99.99) });
  const e13 = base.tf.D1.e13;
  assert.equal(base.long.retest, null, "low above EMA13: no retest");
  const on = trendLadder(100, { D1: mk(e13), H12: mk(e13), H4: mk(e13), H1: mk(e13) });
  assert.equal(on.long.retest, "D1", "low exactly at EMA13 fires (<= boundary)");
  const just = trendLadder(100, { D1: mk(e13 + 1e-9), H12: mk(e13 + 1e-9), H4: mk(e13 + 1e-9), H1: mk(e13 + 1e-9) });
  assert.equal(just.long.retest, null, "a hair above EMA13 does not fire");
});

test("stackedRun: exact per-bar trend age — fresh stacks, breaks, caps, live-mark flips", () => {
  const { stackedRun, trendLadder } = require("../src/compute");
  const mk = (cl) => cl.map((c, i) => ({ t: i * DAY, c }));
  // long steady from the first checkable bar -> run == checked -> capped
  const rise = Array.from({ length: 60 }, (_, i) => 100 * Math.pow(1.01, i));
  let sr = stackedRun(mk(rise), null, "long");
  assert.equal(sr.run, 40, "60 bars, EMAs exist from index 20 -> 40 checkable, all stacked");
  assert.equal(sr.capped, true, "stack extends past measurable history");
  assert.equal(stackedRun(mk(rise), null, "short").run, 0, "never stacked short");
  // long base then a fresh breakout: age counts only the young stack
  const flat = new Array(50).fill(100);
  const brk = flat.concat([103, 106, 109, 112]);   // 4 rising closes
  sr = stackedRun(mk(brk), null, "long");
  assert.ok(sr.run >= 1 && sr.run <= 4, `fresh stack is young, got ${sr.run}`);
  assert.equal(sr.capped, false);
  // a single bar breaking the stack resets the count
  const broken = rise.slice(0, 55).concat([rise[54] * 0.80], rise.slice(55, 59));
  sr = stackedRun(mk(broken), null, "long");
  assert.ok(sr.run <= 4, `run restarts after the break, got ${sr.run}`);
  // the live mark is the forming bar: a crash mark kills today's stack
  sr = stackedRun(mk(rise), rise[59] * 0.5, "long");
  assert.equal(sr.run, 0, "live mark below the ribbon -> not stacked today");
  // consistency with the ladder: if the ladder says D1 is up, stackedRun must report run >= 1
  const cands = mk(rise);
  const lad = trendLadder(rise[59], { D1: cands, H12: cands, H4: cands, H1: cands });
  assert.equal(lad.tf.D1.st, "up");
  assert.ok(stackedRun(cands, rise[59], "long").run >= 1, "ladder-up implies age >= 1 (same EMA construction)");
  // short mirror
  const fall = Array.from({ length: 60 }, (_, i) => 100 * Math.pow(1.01, -i));
  sr = stackedRun(mk(fall), null, "short");
  assert.ok(sr.run > 30 && sr.capped, "steady downtrend: long capped short run");
  assert.equal(stackedRun(mk(rise).slice(0, 20), null, "long"), null, "insufficient history is null");
});

test("regimeAggregate: tape-wide OI + OI-weighted funding APR, forward-filled, chart/tile share the series end", () => {
  const { regimeAggregate } = require("../src/compute");
  const now = Date.now();
  const t = (back) => now - back * DAY;
  const A = [], B = [];
  for (let k = 10; k >= 0; k--) { A.push([t(k), 1000 + (10 - k) * 10, 0.00001]); B.push([t(k), 200, -0.00002]); }
  const r = regimeAggregate([A, B], { now, days: 15 });
  assert.ok(r.series.length >= 10, "one point per day once names start");
  const last = r.series[r.series.length - 1];
  assert.ok(Math.abs(last[1] - 1300) < 1e-6, "total OI is the sum of both names' last OI");
  const expect = +(((1100 * 0.00001 + 200 * -0.00002) / 1300) * 24 * 365 * 100).toFixed(2);
  assert.ok(Math.abs(last[2] - expect) < 0.05, "netFundApr is OI-weighted funding, annualized");
  assert.equal(r.totalOi, last[1]);
  assert.equal(r.netFundApr, last[2]);
  assert.ok(r.oiZ != null, "z-score present with enough points");
  const C = [[t(9), 500, 0.00001]];
  const r2 = regimeAggregate([C], { now, days: 15 });
  assert.equal(r2.series[r2.series.length - 1][1], 500, "stale name is forward-filled to last known OI, not dropped");
  const e = regimeAggregate([], { now, days: 15 });
  assert.equal(e.series.length, 0);
  assert.equal(e.totalOi, null);
});

test("duelStats: paired t on the IC difference; verdict locks at minN days OR |t| >= 2, never before", () => {
  const { duelStats } = require("../src/compute");
  const flat = duelStats([], 60);
  assert.equal(flat.n, 0); assert.equal(flat.verdict, false);
  // B consistently 0.02 better with tiny noise: t explodes long before 60 days
  const rows = []; for (let i = 0; i < 20; i++) rows.push({ a: 0.01 + (i % 3) * 1e-4, b: 0.03 + (i % 3) * 1e-4 });
  const st = duelStats(rows, 60);
  assert.equal(st.n, 20);
  assert.ok(Math.abs(st.meanB - st.meanA - 0.02) < 1e-9, "mean gap exact");
  assert.equal(st.winB, 1, "B led every day");
  assert.ok(st.t > 2, "consistent gap -> significant t");
  assert.equal(st.verdict, true, "|t| >= 2 unlocks before minN");
  // pure noise around zero gap: no verdict at n < minN...
  const noisy = []; for (let i = 0; i < 30; i++) noisy.push({ a: (i % 2 ? 1 : -1) * 0.05, b: (i % 2 ? -1 : 1) * 0.05 });
  const sn = duelStats(noisy, 60);
  assert.ok(Math.abs(sn.t) < 2 && sn.verdict === false, "noise stays locked below minN");
  // ...but the day-count gate alone unlocks at minN even without significance
  const long = []; for (let i = 0; i < 60; i++) long.push({ a: (i % 2 ? 1 : -1) * 0.05, b: (i % 2 ? -1 : 1) * 0.05 });
  assert.equal(duelStats(long, 60).verdict, true, "minN days unlocks the verdict regardless of t");
});

test("levels -09: detectLevels finds confirmed pivot clusters, classifies flips, and refuses to guess", () => {
  const C = require("../src/compute");
  const DAY_ = 86400000, now = Date.now();
  const daily = zigDaily(ZIG_PTS, 8, now - 80 * DAY_, DAY_);
  const px = daily[daily.length - 1].c;
  const r = C.detectLevels(daily, px, 3, { minBars: 60 });
  assert.ok(r, "a zigzag with clean turns must produce levels");
  const at = (v) => r.items.find((l) => Math.abs(l.v / v - 1) < 0.02) || null;
  const res = at(130), sup = at(100), flip = at(115);
  assert.ok(res && res.side === "res", "130 is touched only by highs — resistance");
  assert.ok(sup && sup.side === "sup", "100 is touched only by lows — support");
  assert.ok(flip && flip.side === "flip", "115 capped one leg and floored another — flip, and the flip is the point of the classifier");
  assert.ok(res.n >= 3, `130 should carry several touches, got n=${res.n}`);
  assert.equal(flip.n, 2, "the flip is exactly one high + one low by construction");
  assert.ok(r.items.every((l) => l.n >= 2), "minN defaults to 2 — a single untested pivot is not a level");
  assert.ok(r.tauPct > 0 && r.k === 3 && r.minN === 2, "tuning is echoed back so the snap rule can read tau");
  // ageD counts back from the LAST bar, and distPct is signed against the mark
  assert.ok(r.items.every((l) => l.ageD >= 0 && Number.isFinite(l.distPct)), "each level carries age + distance");
  assert.ok(res.distPct > 0 && sup.distPct < 0, "with the mark mid-range, resistance is above and support below");
});

test("levels -09: honest null — a monotone trend confirms no structure, and short history returns nothing", () => {
  const C = require("../src/compute");
  const DAY_ = 86400000, now = Date.now();
  // The exact shape the AI harness seeds: every bar's high exceeds the last, every low too.
  // There is no confirmed pivot anywhere in it, and inventing one would be the whole bug.
  const rise = Array.from({ length: 80 }, (_, i) => {
    const c = 100 * Math.pow(1.008, i);
    return { t: now - (79 - i) * DAY_, o: c * 0.995, h: c * 1.01, l: c * 0.99, c };
  });
  assert.equal(C.detectLevels(rise, rise[79].c, 2), null, "a clean uptrend has no confirmed pivots — null, never a fabricated level");
  const short = zigDaily(ZIG_PTS, 2, now - 20 * DAY_, DAY_);
  assert.equal(C.detectLevels(short, short[short.length - 1].c, 3, { minBars: 60 }), null, "under the bar floor returns null");
  assert.equal(C.detectLevels(null, 100, 3), null, "garbage in, null out");
  assert.equal(C.detectLevels([], 100, 3), null);
  assert.equal(C.detectLevels(zigDaily(ZIG_PTS, 8, now, DAY_), 0, 3), null, "no mark, no distances, no levels");
});

test("levels -09: the last k bars can never confirm a pivot, and closes-only bars degrade instead of throwing", () => {
  const C = require("../src/compute");
  const DAY_ = 86400000, now = Date.now();
  const daily = zigDaily(ZIG_PTS, 8, now - 80 * DAY_, DAY_);
  // A fresh spike in the final 2 bars is UNCONFIRMED — k=3 needs 3 bars on the right.
  const spiked = daily.slice(0, -2).concat([
    { t: now - DAY_, o: 200, h: 200, l: 199, c: 199.5 },
    { t: now, o: 199, h: 199, l: 198, c: 198.5 }]);
  const r = C.detectLevels(spiked, 198.5, 3, { minBars: 60 });
  assert.ok(!r || !r.items.some((l) => l.v > 150), "the unconfirmed spike must NOT become a level — that is a guess wearing a price");
  // warm-cache shape: closes only, no h/l. Falls back to the close rather than going offline.
  const closesOnly = daily.map((k) => ({ t: k.t, c: k.c }));
  const rc = C.detectLevels(closesOnly, px0(closesOnly), 3, { minBars: 60 });
  assert.ok(rc && rc.items.length, "closes-only history still yields close-based pivots");
  assert.ok(rc.items.some((l) => l.side === "flip"), "and still classifies the flip");
  function px0(a) { return a[a.length - 1].c; }
});

test("levels -09: tolerance scales with the name's own volatility, and minN sets the detector's character", () => {
  const C = require("../src/compute");
  const DAY_ = 86400000, now = Date.now();
  const daily = zigDaily(ZIG_PTS, 8, now - 80 * DAY_, DAY_);
  const px = daily[daily.length - 1].c;
  const quiet = C.detectLevels(daily, px, 0.5, { minBars: 60 });
  const wild = C.detectLevels(daily, px, 12, { minBars: 60 });
  assert.ok(quiet.tauPct < wild.tauPct, "a volatile name clusters wider — a fixed percent would over-merge one and shatter the other");
  assert.ok(wild.items.length <= quiet.items.length, "wider tolerance merges levels, never splits them");
  assert.equal(C.detectLevels(daily, px, 3, { minBars: 60, tauMult: 0.4, minN: 9 }), null,
    "an unreachable touch floor yields null, not a level nobody can justify");
  const n1 = C.detectLevels(daily, px, 3, { minBars: 60, minN: 1 });
  assert.ok(n1.items.length >= C.detectLevels(daily, px, 3, { minBars: 60 }).items.length,
    "minN=1 admits every pivot — the setting that would make the snap rule decorative");
  const cap = C.detectLevels(daily, px, 3, { minBars: 60, minN: 1, max: 2 });
  assert.equal(cap.items.length, 2, "max caps the shipped list");
  assert.ok(cap.items[0].v > cap.items[1].v, "shipped high -> low");
});

test("levels study -10: normCdf and the analytic touch formula are numerically correct", () => {
  assert.ok(Math.abs(normCdf(0) - 0.5) < 1e-9, "phi(0) = 0.5 exactly");
  assert.ok(Math.abs(normCdf(1.96) - 0.975) < 5e-5, `phi(1.96) ~ 0.975, got ${normCdf(1.96)}`);
  assert.ok(Math.abs(normCdf(-1) - 0.158655) < 5e-5, `phi(-1) ~ 0.15866, got ${normCdf(-1)}`);
  assert.ok(Math.abs(normCdf(2.5) + normCdf(-2.5) - 1) < 1e-9, "symmetric about zero");
  assert.equal(normCdf(NaN), null, "non-finite input fails closed, never NaN-propagates");
  // 2(1-phi(d/sqrt(h))) — retained as a reference/reporting quantity, NOT as the study's null
  assert.ok(Math.abs(touchBaseline(1, 10) - 0.7518) < 1e-3, `d=1,h=10 ~ 0.752, got ${touchBaseline(1, 10)}`);
  assert.ok(touchBaseline(0, 10) === 1, "a level at zero distance is touched with certainty");
  assert.ok(touchBaseline(8, 10) < 0.02, "a very distant level is near-impossible in the horizon");
  assert.equal(touchBaseline(-1, 10), null, "negative distance is rejected");
  assert.equal(touchBaseline(1, 0), null, "zero horizon is rejected");
});

test("levels study -10: studyBars mirrors detectLevels' coercion and degrades closes-only bars", () => {
  const b = studyBars([{ t: 1, h: 11, l: 9, c: 10 }, { t: 2, c: 20 }, { t: 3, h: 5, l: 8, c: 6 },
    { t: 4, c: 0 }, { t: 5, c: "12", h: "13", l: "11" }, null, { t: 6, c: NaN }]);
  assert.equal(b.length, 4, "only bars with a usable positive close survive");
  assert.deepEqual(b[1], { t: 2, h: 20, l: 20, c: 20, v: 0 }, "closes-only bar becomes a zero-range bar, not a dropped one (v carried as 0 since -22)");
  assert.ok(b[2].h >= b[2].c && b[2].l <= b[2].c, "a close outside its own range is repaired, matching detectLevels");
  assert.equal(b[3].c, 12, "string OHLC is coerced (sqlite/feed paths hand back strings)");
  assert.deepEqual(studyBars(null), [], "non-array input returns empty, never throws");
});

test("levels study -10: events freeze detection-time attributes and resolve only from later bars", () => {
  const d = _walk(4242, 400);
  const out = levelOutcomes(d, 1.8, { k: 3, tauMult: 0.4, minN: 2, max: 8, stride: 5, horizon: 10 });
  assert.ok(out.n > 50, `enough events to test on, got ${out.n}`);
  assert.equal(out.horizon, 10); assert.equal(out.stride, 5);
  for (const e of out.events) {
    assert.ok(["res", "sup", "flip"].includes(e.side), "side is a detector class");
    assert.ok(e.nTouch >= 2, "minN is respected — no 1-touch level is scored");
    assert.ok(e.distSd > 0, "a level at zero distance is skipped, never scored");
    assert.equal(typeof e.above, "boolean");
    if (e.touched) {
      assert.ok(e.bars >= 1 && e.bars <= 10, `touch lands inside the horizon, got ${e.bars}`);
      assert.equal(typeof e.held, "boolean", "a touched level always resolves hold/break");
      assert.ok(Number.isFinite(e.beyondSd) && e.beyondSd >= 0, "excursion past the level is measured");
    } else {
      assert.equal(e.held, null, "an untouched level makes no hold claim");
      assert.equal(e.beyondSd, null, "and no excursion claim");
    }
  }
  // No lookahead: truncating the tape to the last detection point must not change any event that
  // was already fully resolved inside the retained window.
  const half = levelOutcomes(d.slice(0, 300), 1.8, { k: 3, tauMult: 0.4, minN: 2, max: 8, stride: 5, horizon: 10 });
  const key = (e) => `${e.t}|${e.v}`;
  const map = new Map(out.events.map((e) => [key(e), e]));
  let checked = 0;
  for (const e of half.events) {
    const f = map.get(key(e));
    if (!f) continue;
    assert.equal(f.touched, e.touched, "prefix-only detection: a resolved event is identical on a longer tape");
    assert.equal(f.held, e.held, "and its hold verdict is identical");
    checked++;
  }
  assert.ok(checked > 20, `enough overlapping events compared (${checked})`);
});

test("levels study -10: the permutation control is present, deterministic, and same-distance", () => {
  const d = _walk(777, 400);
  const a = levelOutcomes(d, 1.8, { stride: 5, horizon: 10 });
  const b = levelOutcomes(d, 1.8, { stride: 5, horizon: 10 });
  assert.deepEqual(a.events, b.events, "no PRNG anywhere — identical input yields byte-identical events");
  const withCtl = a.events.filter((e) => Number.isFinite(e.plTouch));
  assert.ok(withCtl.length > a.n * 0.9, "virtually every event carries a control estimate");
  for (const e of withCtl) {
    assert.ok(e.plTouch >= 0 && e.plTouch <= 1, "control touch rate is a probability");
    if (e.plHeld != null) assert.ok(e.plHeld >= 0 && e.plHeld <= 1, "control hold rate is a probability");
  }
  assert.ok(PLACEBO_K >= 8, "the control needs enough anchors to be stable");
});

test("levels study -10: levelStudy buckets by distance, floors thin cells to null, and excess = rate - control", () => {
  const d = _walk(31337, 500);
  const ev = levelOutcomes(d, 1.8, { stride: 5, horizon: 10 }).events;
  const st = levelStudy(ev, { horizon: 10, cellFloor: 20 });
  assert.equal(st.buckets.length, LVL_EDGES.length, "one bucket per edge");
  assert.equal(st.buckets[0].lo, 0, "first bucket starts at zero distance");
  assert.equal(st.buckets[st.buckets.length - 1].hi, LVL_EDGES[LVL_EDGES.length - 1]);
  for (let i = 1; i < st.buckets.length; i++)
    assert.equal(st.buckets[i].lo, st.buckets[i - 1].hi, "buckets tile the axis with no gap or overlap");
  let assigned = 0;
  for (const b of st.buckets) {
    assigned += b.n;
    if (b.n < 20) assert.equal(b.touchRate, null, `a cell under the floor reports null, not a rate on n=${b.n}`);
    if (b.touchRate != null && b.baseline != null)
      assert.ok(Math.abs(b.excess - (b.touchRate - b.baseline)) < 1e-4, "excess is exactly rate minus control");
    assert.ok(b.nTouched <= b.n, "touched count cannot exceed the cell");
  }
  assert.equal(assigned + (st.far ? st.far.n : 0), st.n, "every event lands in exactly one bucket or in far");
  // honest nulls on empty / degenerate input
  const z = levelStudy([], { horizon: 10 });
  assert.equal(z.n, 0); assert.equal(z.overall.touchRate, null, "no events -> null rate, never 0%");
  assert.equal(levelOutcomes(_walk(9, 40), 1.8, {}).n, 0, "history shorter than minBars+horizon yields no events");
  assert.equal(levelOutcomes(_walk(9, 400), 0, {}).n, 0, "no volatility scale -> no study, rather than a divide-by-zero");
  assert.equal(levelOutcomes(null, 1.8, {}).n, 0, "null input degrades, never throws");
});

test("levels study -10: THE NULL — pooled random walks must show no touch edge (guards the analytic-baseline bug)", () => {
  // An earlier revision used 2(1-phi(d/sqrt(h))) as the null and produced excess of -0.06 to -0.34
  // on pure noise: a bar-bracketing touch test under-detects a gappy tape, so the continuous
  // formula is biased high. Any future change that reintroduces an analytic null will fail here.
  let all = [];
  for (let k = 0; k < 12; k++)
    all = all.concat(levelOutcomes(_walk(1000 + k * 77, 500), 1.8, { stride: 5, horizon: 10 }).events);
  const st = levelStudy(all, { horizon: 10, cellFloor: 40 });
  assert.ok(st.n > 5000, `pooled sample large enough to bound the null (${st.n})`);
  const exs = st.buckets.filter((b) => b.excess != null).map((b) => b.excess).concat(st.far && st.far.excess != null ? [st.far.excess] : []);
  assert.ok(exs.length >= 5, "enough populated buckets to judge");
  const mean = exs.reduce((a, x) => a + x, 0) / exs.length;
  assert.ok(Math.abs(mean) < 0.02, `mean excess under the null must be ~0, got ${mean.toFixed(5)}`);
  assert.ok(Math.max(...exs.map(Math.abs)) < 0.06, `no single bucket may fake an edge, worst = ${Math.max(...exs.map(Math.abs)).toFixed(4)}`);
  // the high-n far bucket is where the null is tightest and any bias would be unmistakable
  if (st.far && st.far.n > 1000 && st.far.excess != null)
    assert.ok(Math.abs(st.far.excess) < 0.01, `far bucket excess must be near-exact, got ${st.far.excess}`);
});

test("levels study -10: manifest — engine, control and exports are pinned", () => {
  const fs = require("fs"), path = require("path");
  const cmp = fs.readFileSync(path.join(__dirname, "..", "src", "compute.js"), "utf8");
  for (const pin of ["function normCdf(", "function touchBaseline(", "function studyBars(",
    "function levelOutcomes(", "function levelStudy(",
    "const LVL_EDGES = [0.5, 1.0, 1.5, 2.0, 3.0, 4.0, 6.0];",
    "const PLACEBO_K = 24, PLACEBO_STEP = 3;",
    "normCdf, touchBaseline, studyBars, levelOutcomes, levelStudy, LVL_EDGES, PLACEBO_K,"])
    assert.ok(cmp.includes(pin), `compute.js missing -10 pin: ${pin}`);
  for (const f of ["normCdf", "touchBaseline", "studyBars", "levelOutcomes", "levelStudy"])
    assert.equal((cmp.match(new RegExp("function " + f + "\\(", "g")) || []).length, 1, `exactly one ${f} definition`);
  // the study must consume the SHIPPING detector, not a private copy or a tuned variant. Since
  // -22 the detector is injectable (the HVN audit rides the same loop), so the pin moves to the
  // DEFAULT closure: detectLevels with pass-through opts, and the walk feeding it the prefix only.
  assert.ok(/const detect = typeof o\.detect === "function" \? o\.detect\s*\n\s*: \(pb, px2, sd2\) => detectLevels\(pb, px2, sd2, dOpts\);/.test(cmp),
    "levelOutcomes' default detector must be the shipping detectLevels with pass-through opts (one code path)");
  assert.ok(/const lv = detect\(b\.slice\(0, i \+ 1\), px, sdHere\);/.test(cmp),
    "the walk hands the detector the PREFIX only — injected or default alike");
  assert.ok(cmp.includes("// The null for a SET of levels is the mean of each level's own touch probability"),
    "the Jensen note must survive — it explains why grouped cells average per-event controls");
  assert.ok(!/const bs = rows\.map\(\(e\) => touchBaseline\(e\.distSd, horizon\)\)/.test(cmp),
    "the analytic null must not return as the study's baseline — it is provably biased here");
});

test("levels study -10: the hold arm is also unbiased under the null (across-tape SE, not naive)", () => {
  // The naive pooled reading once showed hold-vs-control at +2.9pp / "3.6 SE" — clustered-sample
  // noise: up to 8 levels share one detection window, so events are correlated and the naive SE is
  // ~4x too tight. Across independent tapes the difference is ~0 (measured -0.19pp, t=-0.21 on 40
  // tapes). This pins that: the per-tape mean difference must stay inside an honest band.
  const diffs = [];
  for (let k = 0; k < 14; k++) {
    const ev = levelOutcomes(_walk(500 + k * 131, 500), 1.8, { stride: 5, horizon: 10 }).events;
    const t = ev.filter((e) => e.touched);
    if (t.length < 25) continue;
    const pc = t.map((e) => e.plHeld).filter(Number.isFinite);
    if (pc.length < 25) continue;
    diffs.push(t.filter((e) => e.held).length / t.length - pc.reduce((a, x) => a + x, 0) / pc.length);
  }
  assert.ok(diffs.length >= 10, `enough qualifying tapes (${diffs.length})`);
  const m = diffs.reduce((a, x) => a + x, 0) / diffs.length;
  assert.ok(Math.abs(m) < 0.035, `mean hold difference under the null must be ~0, got ${(m * 100).toFixed(2)}pp`);
});

test("levels study -10: overall block carries its own controls, built like any cell", () => {
  const ev = levelOutcomes(_walk(31337, 500), 1.8, { stride: 5, horizon: 10 }).events;
  const st = levelStudy(ev, { horizon: 10, cellFloor: 20 });
  const o = st.overall;
  assert.ok(Number.isFinite(o.baseline), "overall touch control present");
  assert.ok(Math.abs(o.excess - (o.touchRate - o.baseline)) < 1e-4, "overall excess = rate - control exactly");
  if (o.nTouched >= 20) assert.ok(o.holdBaseline == null || (o.holdBaseline >= 0 && o.holdBaseline <= 1), "hold control is a probability when published");
});

test("anatomy -11: sessionRecords measures exact geometry, drops forming and partial days", () => {
  const DAY = 864e5, HOUR = 36e5, mon = Date.UTC(2026, 6, 6);   // a Monday
  const bar = (t, o, h, l, c) => [t, o, h, l, c, 100];
  const hours = [];
  for (let i = 0; i < 24; i++) {   // day 1: open 100, high 110 IN BAR 0, low 95 in bar 12, close 104
    const t = mon + i * HOUR;
    if (i === 0) hours.push(bar(t, 100, 110, 99, 101));
    else if (i === 12) hours.push(bar(t, 100, 101, 95, 100));
    else if (i === 23) hours.push(bar(t, 103, 104, 102, 104));
    else hours.push(bar(t, 100, 102, 99, 101));
  }
  for (let i = 0; i < 24; i++) {   // day 2: extremes mid-day, closes above
    const t = mon + DAY + i * HOUR;
    if (i === 3) hours.push(bar(t, 104, 104.2, 103, 104));
    else if (i === 20) hours.push(bar(t, 105, 106, 104.5, 105.5));
    else hours.push(bar(t, 104, 105, 103.5, 104.8));
  }
  const recs = sessionRecords(hours, { minBars: 20, now: mon + 10 * DAY });
  assert.equal(recs.length, 2, "two complete sessions");
  const r1 = recs[0];
  assert.equal(r1.o, 100); assert.equal(r1.h, 110); assert.equal(r1.l, 95); assert.equal(r1.c, 104);
  assert.equal(r1.mfeUpPct, 10, "max up excursion from open exact");
  assert.equal(r1.mfeDnPct, 5, "max down excursion exact");
  assert.equal(r1.rangePct, 15, "range exact");
  assert.equal(r1.openQ, 2, "open 100 in range 95..110 -> second quarter");
  assert.equal(r1.firstHrExt, true, "the high printed in the session's first bar");
  assert.equal(r1.closedAbove, true);
  assert.equal(recs[1].firstHrExt, false, "day 2 extremes were mid-session");
  // forming-day exclusion: a `now` inside day 2 drops it
  assert.equal(sessionRecords(hours, { minBars: 20, now: mon + DAY + 5 * HOUR }).length, 1, "the forming UTC day is never a record");
  // partial-day filter: 6 bars of day 2 do not make a session
  assert.equal(sessionRecords(hours.slice(0, 30), { minBars: 20, now: mon + 10 * DAY }).length, 1, "a spine-gap day is dropped, not scored on partial extremes");
  assert.deepEqual(sessionRecords(null, {}), [], "null input degrades");
});

test("anatomy -11: the sd freeze is strictly pre-session — today's move can never scale its own excursion", () => {
  const DAY = 864e5, HOUR = 36e5, mon = Date.UTC(2026, 3, 6);
  // 30 quiet days then one violent day: the violent day's OWN return must not enter its sdPrev.
  const hours = [];
  for (let d = 0; d < 31; d++) for (let i = 0; i < 24; i++) {
    const base = d < 30 ? 100 + d * 0.1 : 130;               // day 31 gaps +30%
    hours.push([mon + d * DAY + i * HOUR, base, base + 0.05, base - 0.05, base + (i === 23 ? 0.02 : 0), 1]);
  }
  const rec = anatomyEnrich(sessionRecords(hours, { minBars: 20, now: mon + 60 * DAY }));
  const last = rec[rec.length - 1];
  assert.ok(last.sdPrev != null && last.sdPrev < 1, `the violent day's sdPrev reflects only the quiet history, got ${last.sdPrev}`);
  for (let i = 0; i < Math.min(15, rec.length); i++)
    assert.equal(rec[i].sdPrev, null, "records before the sd warms up carry null, never a rescaled guess");
  for (const r of rec) if (r.sdPrev == null) {
    assert.equal(r.mfeUpSd, null, "no sd -> no sd-denominated excursion");
    assert.equal(r.rangeSd, null);
  }
});

test("anatomy -11: mondayStats containment, first-break direction, the unorderable 'both', thin weeks", () => {
  const DAY = 864e5, HOUR = 36e5, mon = Date.UTC(2026, 6, 6);
  const bar = (t, o, h, l, c) => [t, o, Math.max(h, o, c), Math.min(l, o, c), c, 1];
  const hours = [];
  for (let d = 0; d < 21; d++) for (let i = 0; i < 24; i++) {
    const t = mon + d * DAY + i * HOUR;
    let o = 105, h = 108, l = 101, c = 105;
    if (d % 7 === 0) { o = 100; h = 110; l = 100; c = 105; }          // Mondays: range 100..110
    if (d === 3 && i === 6) { o = 101; h = 101; l = 94; c = 100; }    // wk1 Thu breaks LOW
    if (d === 10 && i === 6) { o = 105; h = 112; l = 93; c = 105; }   // wk2 Thu pierces BOTH sides
    hours.push(bar(t, o, h, l, c));
  }
  const recs = sessionRecords(hours, { minBars: 20, now: mon + 40 * DAY });
  const ev = mondayStats(recs);
  assert.equal(ev.length, 3, "three complete weeks");
  assert.deepEqual({ c: ev[0].contained, d: ev[0].dir, n: ev[0].daysTo }, { c: false, d: "down", n: 3 }, "wk1: first break down on the 3rd rest session");
  assert.deepEqual({ c: ev[1].contained, d: ev[1].dir }, { c: false, d: "both" }, "a session piercing both sides is 'both' — unorderable at daily granularity, never guessed");
  assert.deepEqual({ c: ev[2].contained, d: ev[2].dir, n: ev[2].daysTo }, { c: true, d: null, n: null }, "wk3 held all week");
  // a week whose spine coverage is thin proves nothing
  assert.equal(mondayStats(recs.slice(0, 3)).length, 0, "fewer than 3 rest sessions -> no event");
});

test("anatomy -11: anatomyPool day-pools every rate (n = days), floors thin day-cells, shares sum to 1", () => {
  const DAY = 864e5, HOUR = 36e5, mon = Date.UTC(2026, 3, 6);
  const mk = (seed) => {
    let s = seed; const rnd = () => { s = (s * 1103515245 + 12345) & 0x7fffffff; return s / 0x7fffffff; };
    const nrm = () => { let u = 0, v = 0; while (!u) u = rnd(); while (!v) v = rnd(); return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v); };
    const hh = []; let px = 100;
    for (let d = 0; d < 60; d++) for (let i = 0; i < 24; i++) {
      px *= 1 + nrm() * 0.004;
      const h = px * (1 + Math.abs(nrm()) * 0.002), l = px * (1 - Math.abs(nrm()) * 0.002);
      hh.push([mon + d * DAY + i * HOUR, px, Math.max(h, px), Math.min(l, px), px, 1]);
    }
    const rec = anatomyEnrich(sessionRecords(hh, { minBars: 20, now: mon + 90 * DAY }));
    return { records: rec, monday: mondayStats(rec), naked: nakedStats(rec) };
  };
  const tks = [1, 2, 3, 4, 5, 6].map((k) => mk(k * 911));
  const an = anatomyPool(tks, { minCross: 3 });
  assert.equal(an.tickers, 6);
  assert.equal(an.days, 60, "the honest n is distinct days, and it is served");
  assert.equal(an.tickerSessions, 360);
  assert.equal(an.sdSessions, 264, "exactly the post-warmup sessions are sd-scored (6 x 44)");
  const sum = an.mfe.upShare.reduce((a, b) => a + b, 0);
  assert.ok(Math.abs(sum - 1) < 0.01, `histogram shares sum to 1, got ${sum}`);
  assert.equal(an.mfe.upShare.length, MFE_EDGES.length + 1, "one share per bin plus the overflow tail");
  for (const q of an.quartiles) {
    assert.ok(q.nDays <= an.days, "a cell's day count cannot exceed the window");
    if (q.nDays === 0) assert.equal(q.closedAbove, null, "no qualifying days -> null, never a rate");
  }
  // day-cell floor: with minCross above the book size, every rate must go null
  const anStrict = anatomyPool(tks, { minCross: 99 });
  for (const q of anStrict.quartiles) assert.equal(q.closedAbove, null, "day-cells under the cross-sectional floor publish nothing");
  assert.equal(anStrict.naked.revisit[0], null, "naked rates respect the same floor");
  // empty pool: nulls throughout, never zeros pretending to be measurements
  const z = anatomyPool([], {});
  assert.equal(z.mfe.medUpSd, null); assert.equal(z.monday.contained, null); assert.equal(z.days, 0);
});

test("shadow pair -12: detectWickFill freezes exact geometry and refuses everything ambiguous", () => {
  const mk = (o, h, l, c, t) => ({ t: t || 0, o, h, l, c });
  const base = []; for (let i = 0; i < 30; i++) base.push(mk(99, 100, 98, 99.5, i));
  // dominant UPPER wick: o=99 c=100 h=110 l=98.5 -> range 11.5, upper wick 10 (87% of range)
  const up = base.concat([mk(99, 110, 98.5, 100, 30)]);
  const wf = detectWickFill(up, 101, {});
  assert.deepEqual({ s: wf.side, t: wf.target, v: wf.stop }, { s: "long", t: 105, v: 98.5 },
    "long fill: target = wick midpoint (bodyHi+high)/2, void = the bar's opposite extreme");
  assert.ok(Math.abs(wf.wickPct - 0.87) < 0.001, "wick share measured");
  // mirror
  const dn = base.concat([mk(100, 100.5, 89, 99, 30)]);
  const wf2 = detectWickFill(dn, 97, {});
  assert.deepEqual({ s: wf2.side, t: wf2.target, v: wf2.stop }, { s: "short", t: 94, v: 100.5 },
    "short fill mirrors exactly");
  // refusals — each one is a claim that must never open
  assert.equal(detectWickFill(up, 106, {}), null, "fill already done: mark past the target");
  assert.equal(detectWickFill(up, 98, {}), null, "thesis already dead: mark through the void");
  assert.equal(detectWickFill(base.concat([mk(99, 100.4, 98.3, 99.6, 30)]), 99, {}), null,
    "a bar under the size floor is noise, not a wick event");
  assert.equal(detectWickFill(base.concat([mk(99.5, 106, 93, 99.5, 30)]), 99, {}), null,
    "two-sided bar: no dominant wick, no unambiguous direction, no claim");
  assert.equal(detectWickFill(base.slice(0, 20).concat([up[30]]), 101, {}), null, "short history refuses");
  assert.equal(detectWickFill(null, 100, {}), null, "null input degrades");
  const strs = up.map((b) => ({ t: b.t, o: String(b.o), h: String(b.h), l: String(b.l), c: String(b.c) }));
  const wfs = detectWickFill(strs, 101, {});
  assert.ok(wfs && wfs.target === 105, "string OHLC coerced, never NaN-thrown");
});

test("shadow pair -12: roundStep picks the dominant grid deterministically across magnitudes", () => {
  const cases = [[87, 10], [95, 10], [432, 50], [6.4, 0.5], [1.3, 0.1], [9.1, 1], [0.043, 0.005]];
  for (const [px, g] of cases) assert.equal(roundStep(px), g, `roundStep(${px}) = ${g}`);
  assert.equal(roundStep(0), null); assert.equal(roundStep(-5), null);
  for (const px of [0.7, 3, 18, 250, 7100]) {
    const g = roundStep(px);
    assert.ok(g / px <= 0.12 + 1e-12, `step never exceeds 12% of price (${px} -> ${g})`);
  }
});

test("shadow pair -12: detectRoundFront fades the approach with the void through the figure, both sides, fresh only", () => {
  const DAY = 864e5;
  const seq = (f) => Array.from({ length: 26 }, (_, i) => [i * DAY, f(i)]);
  // advance into 90 from below -> short front-run
  const r1 = detectRoundFront(seq((i) => 84 + i * 0.19), 89.2, 2, {});
  assert.deepEqual({ s: r1.side, l: r1.lvl }, { s: "short", l: 90 });
  assert.ok(Math.abs(r1.stop - 90.45) < 1e-9, "void = figure x (1 + 0.25 sd), just THROUGH the round");
  assert.ok(Math.abs(r1.target - 87.862) < 1e-9, "target = 0.75 sd retrace of the approach");
  // decline into 80 from above -> long mirror
  const r2 = detectRoundFront(seq((i) => 86 - i * 0.2), 80.9, 2, {});
  assert.deepEqual({ s: r2.side, l: r2.lvl }, { s: "long", l: 80 });
  assert.ok(r2.stop < 80 && r2.target > 80.9, "long geometry sided correctly");
  // refusals
  assert.equal(detectRoundFront(seq((i) => i === 20 ? 90.5 : 84 + i * 0.19), 89.2, 2, {}), null,
    "a close beyond the figure inside 20 bars consumes freshness — no claim on a tested level");
  assert.equal(detectRoundFront(seq((i) => 84 + i * 0.19), 85, 1, {}), null, "mid-grid: outside the approach band");
  assert.equal(detectRoundFront(seq((i) => 84 - i * 0.19), 89.2, 2, {}), null,
    "near the round above but DECLINING: no advance into it, no front-run");
  assert.equal(detectRoundFront(seq((i) => 84 + i * 0.19), 89.2, 0, {}), null, "no vol scale, no study");
  assert.equal(detectRoundFront(null, 89, 2, {}), null, "null input degrades");
});

test("scopes -13: anatomyTickerSummary is a within-name time series with the same floors", () => {
  const DAY = 864e5, mon = Date.UTC(2026, 3, 6);
  const rec = Array.from({ length: 60 }, (_, i) => ({ t: mon + i * DAY, o: 100, h: 102, l: 99, c: i % 2 ? 101 : 99.5,
    mfeUpSd: 0.8, mfeDnSd: 0.4, mfeUpPct: 2, mfeDnPct: 1, rangeSd: 1.2, sdPrev: 2.5,
    openQ: (i % 4) + 1, closedAbove: i % 2 === 1, firstHrExt: i % 3 === 0, hiHr: 5, loHr: 15 }));
  const sm = anatomyTickerSummary(rec, [], [], [], { minN: 20 });
  assert.equal(sm.sessions, 60);
  assert.equal(sm.mfe.medUpSd, 0.8);
  for (const q of sm.quartiles) {
    assert.equal(q.n, 15, "60 sessions split evenly across quartiles");
    assert.equal(q.closedAbove, null, "15 < minN 20 -> the per-name cell floors to null, exactly like the pooled cells");
  }
  const sm2 = anatomyTickerSummary(rec, [], [], [], { minN: 10 });
  assert.ok(sm2.quartiles.every((q) => q.closedAbove != null), "above the floor the same cells publish");
  assert.equal(sm.monday.contained, null, "no weeks -> null");
});

// ===== build 2026.07.24-14: per-ticker scope reaches the CHARTS, pivots gains its selector =====
// The -13 scopes switched only the tables; the flagship visuals (excursion histogram, level
// touch chart, pivot clock histogram) stayed silently pooled, and time-based pivots had no
// selector at all. -14 ships per-name payloads through the SAME pure builders with the SAME
// floors, and the client renders them with the n-basis switch labeled.

test("-14 anatomyTickerSummary: per-name mfe histogram, candle share/rngX, within-name pivots", () => {
  const C = require("../src/compute");
  const HOUR = 3600 * 1000;
  const synth = (seed, days) => {
    let s = seed * 7919 + 17, p = 100 + seed;
    const rnd = () => { s = (s * 1103515245 + 12345) % 2147483648; return s / 2147483648 - 0.5; };
    const t0 = Math.floor((Date.now() - days * 24 * HOUR) / HOUR) * HOUR, out = [];
    for (let i = 0; i < days * 24; i++) {
      const o = p, c = o * (1 + rnd() * 0.01);
      out.push([t0 + i * HOUR, o, Math.max(o, c) * (1 + Math.abs(rnd()) * 0.004),
        Math.min(o, c) * (1 - Math.abs(rnd()) * 0.004), c, 1000]);
      p = c;
    }
    return out;
  };
  const rec = C.anatomyEnrich(C.sessionRecords(synth(3, 90), {}));
  const monday = C.mondayStats(rec), naked = C.nakedStats(rec), candles = C.candleEvents(rec);
  const sm = C.anatomyTickerSummary(rec, monday, naked, candles, { minN: 20 });
  // mfe histogram: same edges as the pool, shares sum to 1 per side, n disclosed
  assert.ok(sm.mfeHist && sm.mfeHist.n >= 20 && sm.mfeHist.edges.length === 10);
  for (const side of ["upShare", "dnShare"])
    assert.ok(Math.abs(sm.mfeHist[side].reduce((a, b) => a + b, 0) - 1) < 0.01, side + " sums to 1");
  // candle table cells: shares sum to 1 over the name's own typed bars; rngX floors at minN
  const shares = Object.values(sm.candles).map((t) => t.share).filter((x) => x != null);
  assert.ok(Math.abs(shares.reduce((a, b) => a + b, 0) - 1) < 0.01, "candle shares sum to 1");
  for (const t of Object.values(sm.candles)) if (t.n < 20) assert.equal(t.rngX, null, "rngX under the floor stays null");
  // within-name pivots: mirrors pivotPool field names, shares sum to 1, session-count basis
  assert.ok(sm.pivots && sm.pivots.hi.nDays === sm.pivots.lo.nDays && sm.pivots.hi.nDays >= 20);
  assert.ok(Math.abs(sm.pivots.hi.share.reduce((a, b) => a + b, 0) - 1) < 0.01, "per-name hi histogram sums to 1");
  assert.ok(Math.abs(sm.pivots.lo.share.reduce((a, b) => a + b, 0) - 1) < 0.01, "per-name lo histogram sums to 1");
  // floor behavior: a thin record set publishes no histogram and no pivots — never a thin chart
  const thin = C.anatomyTickerSummary(rec.slice(0, 10), C.mondayStats(rec.slice(0, 10)),
    C.nakedStats(rec.slice(0, 10)), C.candleEvents(rec.slice(0, 10)), { minN: 20 });
  assert.equal(thin.mfeHist, null, "under-floor mfe histogram stays null");
  assert.equal(thin.pivots, null, "under-floor pivots stays null");
});

// ===== actionable board (build 2026.07.26-01) =================================================
// The board's whole claim is that it re-derives nothing: it reads the geometry the ledger froze,
// nets carry against it, and ranks. These tests pin that contract at every seam — the carry sign
// convention (the thing that flips a short's economics), the honest-null floors, the merge that
// keeps one name from becoming two trades, and the section split that keeps unproven setups out
// of the expectancy rank.

test("actionable -01: carry is signed by side, scaled by horizon, and expressed in the trade's own R", () => {
  const { carryR } = require("../src/compute");
  const HOUR = 3600e3, DAY = 86400e3;
  // 43.8% APR (the venue's hourly rate x 24 x 365), 5d horizon, 1.78% stop.
  const fh = 0.05 / 1000;   // 0.00005/hr -> 43.8% APR
  const L = carryR({ side: "long", entry: 100, stop: 98.22, horizonMs: 5 * DAY, fundingHourly: fh });
  assert.ok(L, "long carry computed");
  assert.equal(L.aprPct, 43.8, "APR is the hourly rate annualized");
  assert.ok(Math.abs(L.costPct - 43.8 * 5 / 365) < 1e-3, "cost is APR prorated across the horizon, not the full year");
  // positive funding = longs pay: the long's carry must be a DRAG (negative R).
  assert.ok(L.r < 0, "a long pays when funding is positive");
  assert.ok(Math.abs(L.r - (-L.costPct / 1.78)) < 0.01, "carry in R = cost% / risk%");
  // The mirror: same market, same hold, opposite side — a short is PAID to wait. This sign flip
  // is the entire reason carry is worth surfacing at swing horizon rather than ignoring.
  const S = carryR({ side: "short", entry: 100, stop: 101.78, horizonMs: 5 * DAY, fundingHourly: fh });
  assert.ok(S.r > 0, "a short receives when funding is positive");
  assert.ok(Math.abs(S.r + L.r) < 0.02, "the two sides are equal and opposite on mirrored geometry");
  // Same funding, longer hold = strictly more carry. At 1d it is noise; at 21d it is a line item.
  const d1 = carryR({ side: "long", entry: 100, stop: 98.22, horizonMs: DAY, fundingHourly: fh });
  const d21 = carryR({ side: "long", entry: 100, stop: 98.22, horizonMs: 21 * DAY, fundingHourly: fh });
  assert.ok(Math.abs(d1.r) < Math.abs(L.r) && Math.abs(L.r) < Math.abs(d21.r), "carry scales with the hold");
  assert.ok(Math.abs(d21.r) > 0.5, "a three-week hold at this rate costs more than half a risk unit");
  // Wider stop absorbs the same cash carry into less R — carry is relative to the trade's risk.
  const wide = carryR({ side: "long", entry: 100, stop: 90, horizonMs: 5 * DAY, fundingHourly: fh });
  assert.ok(Math.abs(wide.r) < Math.abs(L.r), "the same carry is a smaller share of a wider stop");
  // Honest nulls: a missing leg must not silently become zero carry, which is a different claim.
  assert.equal(carryR({ side: "long", entry: 100, stop: 98, horizonMs: 5 * DAY, fundingHourly: null }), null, "unknown funding is null, never 0");
  assert.equal(carryR({ side: "flat", entry: 100, stop: 98, horizonMs: DAY, fundingHourly: fh }), null, "unsided input rejected");
  assert.equal(carryR({ side: "long", entry: 100, stop: 100, horizonMs: DAY, fundingHourly: fh }), null, "zero risk distance rejected");
  assert.equal(carryR(null), null, "null input rejected");
});

test("actionable -02: netRR is pure price geometry — carry can never move it, and never did belong in it", () => {
  // Carry used to fold into the reward leg, so R:R and EV both carried a funding term. That let a
  // sub-threshold setup clear the ACT_MIN_RR gate on funding alone, and it mixed a flow that
  // accrues on TIME HELD into a ratio that resolves on PRICE. Funding is also an extrapolation of
  // the current rate across the horizon, not a rate anyone locked. It is disclosed on its own line
  // and kept out of the ratio and the expectancy entirely.
  const { netRR, carryR } = require("../src/compute");
  const DAY = 86400e3;
  const base = { side: "long", entry: 100, stop: 95, target: 115 };
  const gross = netRR(base);
  assert.equal(gross.gross, 3, "15% reward over 5% risk = 3.0");
  assert.equal(gross.net, undefined, "there is no net ratio any more — a single ratio, and it is the price geometry");
  assert.equal(gross.carryR, undefined, "and no carry term rides along inside it");
  const carry = carryR({ side: "long", entry: 100, stop: 95, horizonMs: 10 * DAY, fundingHourly: 0.0001 });
  assert.ok(carry && Number.isFinite(carry.r), "carry is still computed — it is real money and stays disclosed");
  const withCarry = netRR(Object.assign({}, base, { carry }));
  assert.deepEqual(withCarry, gross, "passing carry to netRR changes NOTHING — the ratio cannot be moved by funding");
  // A short paid to wait USED to net above gross, which is precisely the ranking consequence that
  // made this wrong: it moved setups up the board on funding rather than on geometry.
  const sc = carryR({ side: "short", entry: 100, stop: 105, horizonMs: 10 * DAY, fundingHourly: 0.0001 });
  assert.ok(sc.r > 0, "a short in a crowded-long name is still paid to hold — the fact is real, it just is not a ratio term");
  const sn = netRR({ side: "short", entry: 100, stop: 105, target: 85, carry: sc });
  assert.equal(sn.gross, 3, "and its ratio is the price geometry alone, carry or no carry");

  // The bug this whole change came from: R:R computed against a LIVE mark climbs as price
  // approaches the void, because risk is the denominator. Same frozen claim, two entries.
  const atFire = netRR({ side: "short", entry: 13.668, stop: 13.780, target: 13.667 });
  const atNow = netRR({ side: "short", entry: 13.751, stop: 13.780, target: 13.667 });
  assert.ok(atFire.gross < 0.05, `the claim as frozen framed essentially no reward, got ${atFire.gross}`);
  assert.ok(atNow.gross > 2.8, `...yet against the drifted mark the same claim scores like a strong setup, got ${atNow.gross}`);
  assert.ok(atNow.gross / atFire.gross > 100,
    "the live-mark ratio is two orders of magnitude better than the trade actually claimed — the board must use the frozen one");
  // Geometry that can't be entered from here returns null — this is what silently expires a row
  // once price has walked through the void, rather than leaving a stale line on the board.
  assert.equal(netRR({ side: "long", entry: 100, stop: 105, target: 115 }), null, "long with the void above entry rejected");
  assert.equal(netRR({ side: "short", entry: 100, stop: 95, target: 85 }), null, "short with the void below entry rejected");
  assert.equal(netRR({ side: "long", entry: 100, stop: 95, target: 99 }), null, "target already through rejected");
  assert.equal(netRR({ side: "short", entry: 100, stop: 105, target: 101 }), null, "short target above entry rejected");
});

test("actionable -03: expectancy prices THIS instance's geometry and stays null below the record floor", () => {
  const { setupEV } = require("../src/compute");
  // 60% hit on a 2.5 R:R = .6*2.5 - .4 = +1.10R
  assert.equal(setupEV(0.6, 2.5, 13, 8), 1.1, "hit x net - (1-hit) x 1");
  assert.equal(setupEV(0.5, 1, 20, 8), 0, "a coin flip at 1:1 is exactly break-even");
  assert.ok(setupEV(0.4, 2, 20, 8) > 0, "a sub-50% setup is still positive at 2:1");
  assert.ok(setupEV(0.7, 0.3, 20, 8) < 0, "a high-hit setup with poor geometry is still negative");
  // The floor: below the resolved-fire minimum the hit rate cannot honestly price anything.
  assert.equal(setupEV(0.6, 2.5, 7, 8), null, "n below the floor yields no expectancy");
  assert.equal(setupEV(0.6, 2.5, 0, 8), null, "zero resolved fires yields no expectancy");
  assert.equal(setupEV(0.6, 2.5, null, 8), null, "unknown n yields no expectancy");
  assert.equal(setupEV(null, 2.5, 20, 8), null, "unknown hit rate yields no expectancy");
  assert.equal(setupEV(0.6, null, 20, 8), null, "unknown geometry yields no expectancy");
  // Expectancy uses the INSTANCE's geometry, not the event's historical average R — same hit
  // rate on better geometry must produce a better number, or the board's rank means nothing.
  assert.ok(setupEV(0.6, 3.5, 13, 8) > setupEV(0.6, 2.0, 13, 8), "better geometry ranks higher at equal hit rate");
});

test("actionable -04: bars in trigger are counted in the setup's own timeframe", () => {
  const { barsInTrigger } = require("../src/compute");
  const now = 1700000000000, DAY = 86400e3;
  assert.equal(barsInTrigger(now - 3 * DAY, now, "D1"), 3, "three daily bars");
  assert.equal(barsInTrigger(now - 3 * DAY, now, "H12"), 6, "the same span is six H12 bars");
  assert.equal(barsInTrigger(now - 3 * DAY, now, "H4"), 18, "and eighteen H4 bars");
  assert.equal(barsInTrigger(now - 1000, now, "D1"), 0, "a fresh fire is bar zero");
  assert.equal(barsInTrigger(now, now - 1000, "D1"), null, "a future fire time is null, not negative");
  assert.equal(barsInTrigger(null, now, "D1"), null, "missing fire time is null");
  assert.equal(barsInTrigger(now - 3 * DAY, now, "NOPE"), 3, "an unknown timeframe falls back to daily rather than throwing");
});

test("actionable -05: one name+side is one row — proven geometry wins, the rest ride along as corroboration", () => {
  const { mergeActionable, actionableBetter } = require("../src/compute");
  const mk = (o) => Object.assign({ coin: "AAA", side: "long", ev: "x", label: "X", tf: "D1", t0: 100, unproven: false, evR: 0.5, rr: { net: 2 } }, o);
  // Every candidate reaching the merge has already cleared the confirmed gate, so precedence is
  // expectancy first — there is no proven/unproven tier left to break.
  assert.equal(actionableBetter(mk({ evR: 1.2 }), mk({ evR: 0.4 })), true, "expectancy decides");
  assert.equal(actionableBetter(mk({ evR: 0.5, tf: "D1" }), mk({ evR: 0.5, tf: "H4" })), true, "then the higher timeframe");
  assert.equal(actionableBetter(mk({ evR: 0.5, tf: "D1", t0: 50 }), mk({ evR: 0.5, tf: "D1", t0: 900 })), true, "then the earlier fire");
  // Two detectors on one name+side collapse to a single row: you take one position, not two.
  const merged = mergeActionable([
    mk({ ev: "tretest", label: "Trend retest (long)", evR: 0.9 }),
    mk({ ev: "mapull", label: "MA50 pullback", evR: 0.4 }),
  ]);
  assert.equal(merged.length, 1, "one name + one side = one row");
  assert.equal(merged[0].ev, "tretest", "the higher-expectancy claim owns the row");
  assert.deepEqual(merged[0].also.map((a) => a.ev), ["mapull"], "the loser rides along as corroboration");
  assert.ok(merged[0].also[0].target === undefined && merged[0].also[0].void === undefined,
    "corroboration carries labels ONLY — never its own levels, so the row's geometry has exactly one author");
  // Opposite sides on one name are two genuinely different trades and must NOT collapse.
  const bothSides = mergeActionable([mk({ side: "long" }), mk({ side: "short", ev: "y" })]);
  assert.equal(bothSides.length, 2, "long and short on one name stay separate rows");
  // Different names never merge.
  assert.equal(mergeActionable([mk({ coin: "AAA" }), mk({ coin: "BBB" })]).length, 2, "distinct names stay distinct");
  // Junk in, nothing out.
  assert.deepEqual(mergeActionable([null, { coin: "", side: "long" }, mk({ side: "flat" })]), [], "malformed candidates are dropped, not rendered");
  assert.equal(typeof require("../src/compute").rankActionable, "undefined", "the proven/unproven split function is gone, not left dead — the gate replaced it");
  assert.deepEqual(mergeActionable(null), [], "null input is an empty board, not a throw");
});

test("features: route gate is method-aware, honours never-gate, and lets unclaimed routes through", () => {
  const C = require("../src/compute");
  const flags = { report: "public", "ai.generate": "admin", signals: "admin" };

  // A public GET and an admin POST share /api/ai-report. The method-specific mapping must win, or
  // reading a cached report would require admin (too strict) or generating one would not (too loose).
  assert.equal(C.featureGateFor("GET", "/api/ai-report?coin=X", flags, false), null, "public may read a cached report");
  assert.equal(C.featureGateFor("POST", "/api/ai-report", flags, false), "ai.generate", "public may not spend budget generating one");
  assert.equal(C.featureGateFor("POST", "/api/ai-report", flags, true), null, "admin may generate");

  // Path-wide mapping applies to every method.
  assert.equal(C.featureGateFor("GET", "/api/signals", flags, false), "signals");
  assert.equal(C.featureGateFor("GET", "/api/signals", flags, true), null);

  // Never-gate wins even if a flag would otherwise close it.
  assert.equal(C.featureGateFor("GET", "/api/health", { markets: "off" }, false), null, "healthcheck can never be gated");
  assert.equal(C.featureGateFor("POST", "/api/ai-unlock", flags, false), null, "the escalation path can never be gated");

  // Unclaimed route passes — the deliberate asymmetry. If this ever flips, every unlisted route
  // 403s and the app goes dark on deploy; read the ASYMMETRY note in compute.js before changing it.
  assert.equal(C.featureGateFor("GET", "/api/nothing-claims-this", flags, false), null);
  // Query strings must not defeat the gate.
  assert.equal(C.featureGateFor("GET", "/api/signals?u=crypto&x=1", flags, false), "signals");

  const c = C.featureCounts({});
  assert.equal(c.total, C.FEATURES.length);
  assert.equal(c.public + c.admin + c.off, c.total, "every feature lands in exactly one bucket");
});

// ===== Ledger alert class, slice B: the death notice (build 2026.07.27-02) ======================
// The setup class announces a claim's birth. This class closes the loop — void taken, target
// reached, horizon resolved — because a channel that only ever reports entries is worse than one
// that reports nothing: it reads like a complete picture while being half of one.

test("levelHit: geometry, not side, decides the comparison — and a wick counts", () => {
  const { levelHit } = require("../src/compute");
  // A long's stop sits BELOW entry, its target ABOVE; a short mirrors. Keying off side alone is
  // what produced the stop-aware win fabricator this codebase already had to repair once.
  assert.equal(levelHit("long", "stop", 40, 39.9), true);
  assert.equal(levelHit("long", "stop", 40, 40.1), false);
  assert.equal(levelHit("long", "target", 47, 47.2), true);
  assert.equal(levelHit("long", "target", 47, 46.9), false);
  assert.equal(levelHit("short", "stop", 50, 50.4), true, "a short's void is ABOVE entry");
  assert.equal(levelHit("short", "stop", 50, 49.6), false);
  assert.equal(levelHit("short", "target", 42, 41.5), true, "a short's target is BELOW entry");
  assert.equal(levelHit("short", "target", 42, 42.5), false);

  // The wick case: the mark is back above the level, but a 5m bar took it while nobody looked.
  // This is precisely the touch that matters, and the live mark alone cannot see it.
  const bar = [0, 41, 41.5, 39.5, 41, 0];   // packed [t,o,h,l,c,v]
  assert.equal(levelHit("long", "stop", 40, 41, bar), true, "an intrabar low takes the void even when the mark recovered");
  assert.equal(levelHit("long", "stop", 39, 41, bar), false, "…but only if the low actually reached it");
  assert.equal(levelHit("short", "stop", 41.2, 41, bar), true, "the intrabar HIGH is what takes a short's void");

  // Unknowable inputs must not announce. A false alarm on a stop is worse than a missed one.
  assert.equal(levelHit("long", "stop", 0, 39), false);
  assert.equal(levelHit(null, "stop", 40, 39), false);
  assert.equal(levelHit("long", "nonsense", 40, 39), false);
  assert.equal(levelHit("long", "stop", 40, 0), false, "no mark and no bar is not a touch");
});

test("ledger class: eligible without thresholds, and formatted in its own grammar", () => {
  const C = require("../src/compute");
  assert.ok(C.PUSH_CLASSES.includes("ledger"));
  const stop = { kind: "ledger", sub: "stop", coin: "HOOD", t: "HOOD", side: "long",
    ev: "breakout", label: "breakout", level: 40.5, entry: 42.1, held: "3.2h" };

  // Setup thresholds must NOT reach this class. Being told a trade opened and never told it died
  // is the worst asymmetry an alert channel can have.
  assert.equal(C.pushEligible(stop, { trig: { minEV: 99, minRR: 99 } }), true);
  assert.equal(C.pushEligible(stop, { classes: ["setup"] }), false, "…but an explicit class opt-out is still honoured");
  assert.equal(C.pushEligible(stop, { muted: true }), false);

  const m = C.pushFmt(stop, { baseUrl: "https://x.example" });
  assert.ok(m.includes("void taken") && m.includes("40.5") && m.includes("HOOD"));
  assert.ok(m.includes("https://x.example/#t=HOOD"));
  const tgt = C.pushFmt(Object.assign({}, stop, { sub: "target", level: 47 }), {});
  assert.ok(/target/.test(tgt) && tgt.includes("47"));
  const res = C.pushFmt({ kind: "ledger", sub: "resolved", coin: "X", t: "X", side: "short",
    ev: "breakdown", label: "breakdown", realized: -0.82, unit: "R", stopped: true, held: "6d" }, {});
  assert.ok(res.includes("-0.82R") && /stopped/.test(res), "a stopped-out resolution says so — the number alone hides how it got there");
  assert.ok(res.includes("\u{1F7E5}"), "and a losing outcome is marked, not just signed — a minus sign is easy to miss on a phone");
  const flat = C.pushFmt({ kind: "ledger", sub: "resolved", coin: "X", t: "X", side: "long", ev: "e", realized: null }, {});
  assert.ok(flat.includes("\u2014"), "an unresolvable outcome renders as an honest dash, not a zero");
});

test("trendWhen: the confirming close in UTC, the sighting only when it truly preceded it", () => {
  const C = require("../src/compute");
  const conf = Date.UTC(2026, 6, 27, 0, 0, 0);
  assert.equal(C.trendWhen({ confTf: "D1", confAt: conf }), "confirmed D1 close 00:00 UTC");
  // A sighting on the prior UTC day carries its date; same-day carries none.
  assert.equal(C.trendWhen({ confTf: "D1", confAt: conf, seenAt: Date.UTC(2026, 6, 26, 15, 40) }),
    "confirmed D1 close 00:00 UTC \u00b7 first seen Jul 26 15:40");
  assert.equal(C.trendWhen({ confTf: "H4", confAt: Date.UTC(2026, 6, 27, 8, 0), seenAt: Date.UTC(2026, 6, 27, 6, 15) }),
    "confirmed H4 close 08:00 UTC \u00b7 first seen 06:15");
  // A sighting at or after the close is not a sighting — omitted, never fabricated.
  assert.equal(C.trendWhen({ confTf: "D1", confAt: conf, seenAt: conf }), "confirmed D1 close 00:00 UTC");
  // No confirmation, no line: pre--25 events in the ring keep rendering without one.
  assert.equal(C.trendWhen({ tf: "D1" }), null);
  assert.equal(C.trendWhen(null), null);
});

test("emaAlertState: the four shapes, in the study's own vocabulary", () => {
  const C = require("../src/compute");
  const t0 = Date.UTC(2025, 6, 1, 0, 0, 0), DAYMS = 86400e3;

  // RECLAIM: five closes below the line, then a buffered close back above it.
  const rec = maDaily(220, 100, { 5: { c: 97, h: 97, l: 97 }, 4: { c: 97, h: 97, l: 97 },
    3: { c: 97, h: 97, l: 97 }, 2: { c: 97, h: 97, l: 97 }, 1: { c: 97, h: 97, l: 97 },
    0: { c: 104, h: 104, l: 104 } }, t0);
  const evR = C.emaAlertState(rec, maSd(rec));
  assert.ok(evR && evR.sub === "reclaim" && evR.side === "long");
  assert.equal(evR.held, 5, "held = the consecutive closes the below side had before the cross");
  assert.equal(evR.barT, t0 + 219 * DAYMS, "the event is stamped with ITS OWN closed bar");

  // BREAKDOWN: the exact mirror.
  const brk = maDaily(220, 100, { 5: { c: 103, h: 103, l: 103 }, 4: { c: 103, h: 103, l: 103 },
    3: { c: 103, h: 103, l: 103 }, 2: { c: 103, h: 103, l: 103 }, 1: { c: 103, h: 103, l: 103 },
    0: { c: 96, h: 96, l: 96 } }, t0);
  const evB = C.emaAlertState(brk, maSd(brk));
  assert.ok(evB && evB.sub === "breakdown" && evB.side === "short");
  // 6, not 5: the alternating base's +0.4% bar just before the override run also sits above the
  // line, so it joins the above-run — held counts the TRUE run, not the fixture's override width.
  assert.equal(evB.held, 6);

  // An UNBUFFERED cross — closes above but hugging the line — is silence: the -26 duel picked
  // the buffered variant precisely for its whipsaw tax, and the alert honours the same pick.
  const hug = maDaily(220, 100, { 4: { c: 99, h: 99, l: 99 }, 3: { c: 99, h: 99, l: 99 },
    2: { c: 99, h: 99, l: 99 }, 1: { c: 99, h: 99, l: 99 } }, t0);
  const lineHug = C.emaLast(hug.slice(0, 219).map((b) => b.c).concat([100]), 200);
  hug[219] = { t: hug[219].t, c: lineHug + 0.01, h: lineHug + 0.01, l: lineHug + 0.01 };
  assert.equal(C.emaAlertState(hug, maSd(hug)), null, "a close on the line is not a buffered cross");

  // CHOP — alternating sides — arms nothing in either direction.
  const chop = maDaily(220, 100, { 4: { c: 103 }, 3: { c: 97 }, 2: { c: 103 }, 1: { c: 97 }, 0: { c: 103, h: 103, l: 103 } }, t0);
  assert.equal(C.emaAlertState(chop, maSd(chop)), null, "straddling closes never satisfy the far-side arm");

  // BULLISH RETEST: rising series, prior bar in clear air, last bar's LOW probes the line while
  // the close holds above.
  const up = [];
  for (let i = 0; i < 220; i++) { const c = 100 * Math.pow(1.002, i) * (1 + (i % 2 ? 0.002 : -0.002));
    up.push({ t: t0 + i * DAYMS, c, h: c, l: c }); }
  const eUp = C.emaLast(up.map((b) => b.c), 200);
  up[219] = { t: up[219].t, c: up[219].c, h: up[219].c, l: eUp - 0.01 };
  const evT = C.emaAlertState(up, maSd(up));
  assert.ok(evT && evT.sub === "retest" && evT.side === "long", "touch + hold + clear-air prior = bullish retest");
  assert.equal(evT.probe, +(eUp - 0.01).toPrecision(9), "the probe extreme ships with the event");
  assert.ok(evT.held > 0);

  // BEARISH RETEST: the falling mirror — the HIGH probes, the close rejects.
  const dn = [];
  for (let i = 0; i < 220; i++) { const c = 130 * Math.pow(0.998, i) * (1 + (i % 2 ? 0.002 : -0.002));
    dn.push({ t: t0 + i * DAYMS, c, h: c, l: c }); }
  const eDn = C.emaLast(dn.map((b) => b.c), 200);
  dn[219] = { t: dn[219].t, c: dn[219].c, h: eDn + 0.01, l: dn[219].c };
  const evS = C.emaAlertState(dn, maSd(dn));
  assert.ok(evS && evS.sub === "retest" && evS.side === "short", "rejection from below = bearish retest");

  // SECOND touch of the same episode is silence: the prior bar itself touched, so the clear-air
  // arm fails — a level being hugged is one fight, not a feed.
  const hug2 = up.map((b) => Object.assign({}, b));
  const eUpP = C.emaLast(up.slice(0, 219).map((b) => b.c), 200);   // the PRIOR bar's own line
  hug2[218] = { t: hug2[218].t, c: hug2[218].c, h: hug2[218].c, l: eUpP - 0.01 };
  assert.equal(C.emaAlertState(hug2, maSd(hug2)), null);

  // Closes-only bars (warm-cache dailies) cannot fabricate a touch: h/l degrade to the close.
  const co = up.map((b) => ({ t: b.t, c: b.c }));
  assert.equal(C.emaAlertState(co, maSd(up)), null, "no recorded extremes, no retest — honest degradation");

  // Depth floor: EMA200 cannot seed under 216 bars — null, never a shorter-MA substitute.
  assert.equal(C.emaAlertState(rec.slice(-200), maSd(rec)), null);
});

test("trend is opt-in and reachable: present in the class list, absent from the defaults", () => {
  const C = require("../src/compute");
  assert.ok(C.PUSH_CLASSES.includes("trend"));
  assert.ok(!C.PUSH_DEFAULT_CLASSES.includes("trend"), "opt-in until its measured rate is known");
  assert.ok(!C.PUSH_ADMIN_CLASSES.includes("trend"), "…but public, unlike ops");
  const ev = { kind: "trend", coin: "X", t: "X", side: "long", title: "full 4/4 stack" };
  assert.equal(C.pushEligible(ev, {}), false, "an unchosen subscription does not receive it");
  assert.equal(C.pushEligible(ev, { classes: ["trend"] }), true, "choosing it works");
});

// ================================================================================================
// swing-horizon batch (build 2026.07.27-20): touch-mode resolution, structural targets, the
// symmetric bracket track, the MA200 regime tag, and the 370d crypto daily deepening.
// ================================================================================================

test("swing -20: bracketTouch — first touch wins, same-candle ties to the stop, windows respected", () => {
  const C = require("../src/compute");
  const H = 3600e3, t0 = 1000 * H;
  const bar = (h, t, hi, lo) => [t0 + h * H, t, hi, lo, t, 1];
  // long claim, stop 97 / target 106: target's candle comes first
  const tapeT = [bar(1, 100, 100.5, 99.5), bar(2, 103, 106.2, 102.5), bar(3, 96, 97.5, 95.9)];
  const rT = C.bracketTouch(tapeT, t0, t0 + 10 * H, "long", 97, 106);
  assert.ok(rT && rT.hit === "target" && rT.level === 106, "target touched first");
  // same tape, stop's candle first
  const tapeS = [bar(1, 100, 100.5, 99.5), bar(2, 96.5, 100.2, 96.4), bar(3, 107, 107.5, 106.5)];
  const rS = C.bracketTouch(tapeS, t0, t0 + 10 * H, "long", 97, 106);
  assert.ok(rS && rS.hit === "stop" && rS.level === 97, "stop touched first even though the target follows");
  // ONE candle spanning both levels: hourly ordering is unknowable -> conservative stop
  const rBoth = C.bracketTouch([bar(1, 100, 106.5, 96.5)], t0, t0 + 10 * H, "long", 97, 106);
  assert.ok(rBoth && rBoth.hit === "stop", "a candle touching BOTH counts as the stop");
  // short mirror: stop ABOVE entry, target BELOW
  const rShort = C.bracketTouch([bar(1, 100, 100.4, 99.6), bar(2, 95, 96, 93.8)], t0, t0 + 10 * H, "short", 104, 94);
  assert.ok(rShort && rShort.hit === "target" && rShort.level === 94, "short mirror: low through the target");
  // window bounds: a touch AT t0 is excluded (t <= t0), one past tEnd is excluded (t > tEnd)
  assert.equal(C.bracketTouch([bar(0, 100, 107, 99)], t0, t0 + 10 * H, "long", 97, 106), null, "touch at t0 excluded");
  assert.equal(C.bracketTouch([bar(20, 100, 107, 99)], t0, t0 + 10 * H, "long", 97, 106), null, "touch past tEnd excluded");
  // both levels are REQUIRED — this primitive resolves brackets, not single levels
  assert.equal(C.bracketTouch(tapeT, t0, t0 + 10 * H, "long", null, 106), null, "no stop -> null");
  assert.equal(C.bracketTouch(tapeT, t0, t0 + 10 * H, "sideways", 97, 106), null, "unknown side -> null");
});

test("swing -20: nextLevelAbove reads the shipping detector and refuses trivially-close levels", () => {
  const C = require("../src/compute");
  // flat closes make no pivots; two 115-highs (k=3 clearance) cluster into one resistance level
  const lvlBars = [];
  for (let i = 0; i < 120; i++) {
    const spike = i === 30 || i === 50;
    lvlBars.push({ c: 100, h: spike ? 115 : 100, l: 100 });
  }
  const t = C.nextLevelAbove(lvlBars, 105, 2, 2);
  assert.ok(t != null && Math.abs(t - 115) < 0.01, `the 115 cluster is the next level above, got ${t}`);
  // a floor above every detected level -> null, never a substitute
  assert.equal(C.nextLevelAbove(lvlBars, 114.5, 2, 2), null, "no level clears the min-distance floor");
  const flat = lvlBars.map((b) => ({ c: b.c, h: 100, l: 100 }));
  assert.equal(C.nextLevelAbove(flat, 105, 2, 2), null, "no pivots at all -> null");
});

test("swing -20: detectSwingPull — rising MA50, a real leg, the band, and a structural target", () => {
  const C = require("../src/compute");
  const closes = [];
  for (let i = 0; i < 95; i++) closes.push([i, 80 + i * 0.25]);            // slow ramp to 103.5
  for (let i = 95; i < 105; i++) closes.push([i, 112]);                    // the leg (inside last 20)
  for (let i = 105; i < 120; i++) closes.push([i, 112 - (i - 104) * 0.5]); // pullback toward the MA
  const lvlBars = [];
  for (let i = 0; i < 120; i++) lvlBars.push({ c: 100, h: (i === 30 || i === 50) ? 115 : 100, l: 100 });
  // px pinned AT the computed MA50 so the band condition is exact, not a lucky constant
  const c = closes.map((k) => k[1]);
  const m0 = c.slice(70, 120).reduce((a, x) => a + x, 0) / 50;
  const sp = C.detectSwingPull(closes, m0, 2, lvlBars);
  assert.ok(sp, "fires with every leg holding");
  assert.ok(Math.abs(sp.ma - m0) < 0.01, "ma is the MA50");
  assert.ok(sp.stop < m0 && Math.abs(sp.stop - m0 * 0.97) < 0.01, "void 1.5 sigma below the MA");
  assert.ok(Math.abs(sp.target - 115) < 0.01, "target is the next structural level");
  assert.ok(sp.stop < m0 && m0 < sp.target, "tradeable geometry");
  // falling MA -> null (same tape reversed)
  const rev = closes.map((k, i) => [i, closes[closes.length - 1 - i][1]]);
  assert.equal(C.detectSwingPull(rev, m0, 2, lvlBars), null, "falling MA50: no swing pullback");
  // no qualifying level -> null, never an invented target
  const flat = lvlBars.map((b) => ({ c: 100, h: 100, l: 100 }));
  assert.equal(C.detectSwingPull(closes, m0, 2, flat), null, "no structural target -> no claim");
});

test("swing -20: detectBaseBreak — a real base, a fresh break, and BOTH target schools", () => {
  const C = require("../src/compute");
  const closes = [];
  for (let i = 0; i < 77; i++) closes.push([i, 96 + ((i * 7) % 13) / 2]);  // base: 96..102, ~6.3% range
  closes.push([77, 100.1]); closes.push([78, 100.4]); closes.push([79, 102.8]);  // fresh breakout close
  const lvlBars = [];
  for (let i = 0; i < 80; i++) lvlBars.push({ c: 99, h: (i === 20 || i === 40) ? 110 : 99, l: 99 });
  const bb = C.detectBaseBreak(closes, 103, 2, lvlBars);
  assert.ok(bb, "fires on the fresh break");
  assert.ok(Math.abs(bb.hi - 102) < 0.01 && Math.abs(bb.lo - 96) < 0.01, `base bounds detected (${bb.hi}/${bb.lo})`);
  assert.ok(Math.abs(bb.stop - 102 * 0.98) < 0.01, "void 1 sigma back inside the base");
  assert.ok(Math.abs(bb.targetP - 108) < 0.01, "projected target = base height above the break");
  assert.ok(Math.abs(bb.targetL - 110) < 0.01, "structural target = next level above");
  // stale break (two closes already above) -> null
  const stale = closes.slice(0, 77).concat([[77, 102.5], [78, 102.6], [79, 102.8]]);
  assert.equal(C.detectBaseBreak(stale, 103, 2, lvlBars), null, "stale breakout: no claim");
  // a trend is not a base
  const trend = []; for (let i = 0; i < 80; i++) trend.push([i, 80 + i * 0.5]);
  assert.equal(C.detectBaseBreak(trend, 121, 2, lvlBars), null, "range past the cap: not a base");
});

test("swing -20: regime200 — 2-bit stamp, honest null under 210 closes", () => {
  const C = require("../src/compute");
  const up = []; for (let i = 0; i < 220; i++) up.push([i, 100 + i * 0.3]);
  assert.equal(C.regime200(up, 200), 3, "above a rising MA200");
  assert.equal(C.regime200(up, 50), 1, "below a rising MA200");
  const dn = up.map((k, i) => [i, up[up.length - 1 - i][1]]);
  assert.equal(C.regime200(dn, 50), 0, "below a falling MA200");
  assert.equal(C.regime200(dn, 500), 2, "above a falling MA200");
  assert.equal(C.regime200(up.slice(0, 200), 100), null, "under 210 closes: honest unknown");
});

test("swing -20: EV_META — touch-mode convention, timeouts, crypto overrides inherit resolve", () => {
  const C = require("../src/compute");
  const DAY_ = 86400e3;
  for (const ev of ["swpull", "basebrk", "basepj"]) {
    assert.equal(C.EV_META[ev].resolve, "touch", `${ev} resolves by first touch`);
    assert.equal(C.EV_META[ev].horizonMs, 30 * DAY_, `${ev} times out at 30d on the equity clock`);
  }
  // crypto compressed clock: only the timeout differs; resolve:"touch" must survive the merge
  const fs = require("fs"), path = require("path");
  const cmp = fs.readFileSync(path.join(__dirname, "..", "src", "compute.js"), "utf8");
  for (const pin of [
    'swpull:   { horizonMs: 10 * DAY,  horizon: "first touch of target/void within 10d',
    'basebrk:  { horizonMs: 15 * DAY,  horizon: "first touch of target/void within 15d',
    'basepj:   { horizonMs: 15 * DAY,  horizon: "first touch of target/void within 15d',
  ]) assert.ok(cmp.includes(pin), `EV_META_MAIN override pin missing: ${pin}`);
  // the merge that carries resolve through is the same evMeta Object.assign as every override
  assert.ok(cmp.includes("return o ? Object.assign({}, base, o) : base;"), "evMeta merge intact");
});

// ================================================================================================
// level intelligence batch (build 2026.07.27-22): volume profile, unified level map, the HVN
// audit through the structural study's own loop, the Swing R screener column, and the chart
// histogram. Every weight hand-set here is disclosed in the UI and awaits the audit's verdict.
// ================================================================================================

test("levels -22: volumeProfile — range distribution, POC, value area, HVN/LVN, recency weight", () => {
  const C = require("../src/compute");
  const DAY_ = 86400e3, t0 = Date.now() - 320 * DAY_;
  const mk = (i, c, v) => ({ t: t0 + i * DAY_, c, h: c + 1, l: c - 1, v });
  const bars = [];
  for (let i = 0; i < 300; i++) {
    if (i >= 100 && i < 140) bars.push(mk(i, 110, 5000));       // heavy transaction cluster
    else if (i >= 140 && i < 150) bars.push(mk(i, 105, 100));   // thin traverse
    else bars.push(mk(i, 100, 1000));
  }
  const vp = C.volumeProfile(bars, 2);
  assert.ok(vp && vp.bins.length >= 8, "profile built");
  assert.ok(Math.abs(vp.bins.reduce((a, b) => a + b[1], 0) - 1) < 1e-6, "bin shares sum to 1");
  // POC in the 100-region: 260 bars x 1000 outweighs 40 x 5000 after range spreading? No — the
  // profile answers where volume TRANSACTED: 40x5000=200k at 110 vs 250x1000=250k at 100 -> 100
  assert.ok(vp.poc > 98 && vp.poc < 102, `POC sits in the dominant-volume region, got ${vp.poc}`);
  assert.ok(vp.vaLo <= vp.poc && vp.vaHi >= vp.poc, "value area contains the POC");
  const vaShare = vp.bins.filter((b) => b[0] >= vp.vaLo && b[0] <= vp.vaHi).reduce((a, b) => a + b[1], 0);
  assert.ok(vaShare >= 0.7 - 1e-9, `value area covers >=70% of volume, got ${(vaShare * 100).toFixed(1)}%`);
  assert.ok(vp.hvn.some((h) => Math.abs(h.p - 110) < 2), "the 110 cluster is an HVN");
  assert.ok(vp.hvn.length <= 5 && vp.lvn.length <= 5, "node lists prominence-capped");
  // recency: the same two volume masses, but the 110 cluster in the FINAL 90d — weight 1.5x
  // must tilt the POC to it (5000x40x1.5=300k vs 250k)
  const recent = bars.map((b, i) => (i >= 100 && i < 140 ? Object.assign({}, b, { t: t0 + (270 + (i - 100) / 2) * DAY_ }) : b));
  const vpR = C.volumeProfile(recent, 2);
  assert.ok(vpR.poc > 108, `recency weighting tilts the POC to the recent cluster, got ${vpR.poc}`);
  assert.equal(C.volumeProfile(bars.slice(0, 10), 2), null, "under 20 bars: no profile, not a noisy one");
  assert.equal(C.volumeProfile(bars.map((b) => ({ t: b.t, c: b.c, h: b.h, l: b.l, v: 0 })), 2), null, "zero volume everywhere: null, never fabricated");
});

test("levels -22: levelMap — tau clustering, confluence weight sums, provenance survives", () => {
  const C = require("../src/compute");
  assert.deepEqual(C.LVL_MAP_W, { str: 1.0, hvn: 0.8, e200: 0.7, e50: 0.6, lvn: 0.5 }, "hand-set weights exported for the UI disclosure");
  const vp = { hvn: [{ p: 110.1, v: 0.1 }, { p: 95, v: 0.05 }], lvn: [{ p: 104, v: 0.01 }] };
  const str = { items: [{ v: 110.4, side: "res", n: 4 }, { v: 90, side: "sup", n: 2 }] };
  const lm = C.levelMap({ str, vp, e50: 100.2, e200: 99.9 }, 103, 2);
  assert.ok(lm && lm.n >= 4, "map built");
  const conf = lm.items.find((it) => it.srcs.includes("str") && it.srcs.includes("hvn"));
  assert.ok(conf && Math.abs(conf.v - 110.25) < 0.15, "110.4 structure + 110.1 HVN cluster within tau (0.8% at sd30=2)");
  assert.ok(Math.abs(conf.w - 1.8) < 0.01, `confluence weight = sum of source weights (1.0+0.8), got ${conf.w}`);
  assert.equal(conf.side, "res", "structural provenance (side, touches) survives the merge");
  const emas = lm.items.find((it) => it.srcs.includes("e50") && it.srcs.includes("e200"));
  assert.ok(emas && Math.abs(emas.w - 1.3) < 0.01, "EMA pair clusters at 0.7+0.6");
  const lvn = lm.items.find((it) => it.srcs.length === 1 && it.srcs[0] === "lvn");
  assert.ok(lvn && lvn.w === 0.5, "a lone LVN carries the lowest weight and its provenance");
  assert.equal(C.levelMap({ str: { items: [] } }, 100, 2), null, "no sources: null map");
});

test("levels -22: levelOutcomes detector injection — prefix-only contract, default untouched", () => {
  const C = require("../src/compute");
  const bars = [];
  for (let i = 0; i < 120; i++) bars.push({ t: i, c: 100 + Math.sin(i / 7) * 3, h: 101 + Math.sin(i / 7) * 3, l: 99 + Math.sin(i / 7) * 3, v: 1000 });
  const seen = [];
  const r = C.levelOutcomes(bars, 2, { stride: 10, horizon: 5, minBars: 60,
    detect: (pb, px, sd) => { seen.push(pb.length); return { tauPct: 0.8, items: [{ v: px * 1.05, side: "res", n: 1, ageD: 0 }] }; } });
  assert.ok(seen.length >= 4, "injected detector invoked along the walk");
  for (let i = 1; i < seen.length; i++) assert.ok(seen[i] > seen[i - 1], "each call sees a strictly longer prefix");
  assert.ok(seen[seen.length - 1] < bars.length, "the detector never sees the full series — the horizon tail stays out of sample");
  assert.ok(r.events.length >= 4 && r.events.every((e) => Number.isFinite(e.plTouch) || e.plTouch === null), "events scored through the identical loop, permutation control included");
});

test("levels -22: bucketCandles sums volume through — the profile's spine-overlay fuel", () => {
  const C = require("../src/compute");
  const H = 3600e3;
  const hourly = [[0, 100, 101, 99, 100, 10], [H, 100, 102, 99, 101, 15], [24 * H, 101, 103, 100, 102, 7]];
  const b = C.bucketCandles(hourly, 24, H);
  assert.equal(b.length, 2);
  assert.equal(b[0].v, 25, "same-day hourly volumes sum");
  assert.equal(b[1].v, 7);
  const noV = C.bucketCandles([[0, 100, 101, 99, 100]], 24, H);
  assert.equal(noV[0].v, 0, "missing volume reads as 0, never NaN");
});

// ================================================================================================
// EMA200 trend-events batch (build 2026.07.27-26): close-confirmed crosses (three confirmation
// variants dueling), the re-arm gate, sign conventions, the retest ride on the injectable level
// audit, and the section wiring. The line every trend trader watches gets the same treatment as
// every other claim in this app: walk-forward, placebo-matched, floors, nothing trades.
// ================================================================================================

test("ema200 -26: a wick through the line is NOT an event — closes decide, wicks never do", () => {
  const C = require("../src/compute");
  const DAY_ = 86400e3, t0 = Date.now() - 500 * DAY_;
  // price below a falling-ish line throughout; one candle SPIKES far above intrabar but closes back below
  const bars = [];
  for (let i = 0; i < 300; i++) {
    const c = 100 - i * 0.02;
    bars.push({ t: t0 + i * DAY_, c, h: i === 250 ? c + 30 : c + 0.3, l: c - 0.3, v: 1 });
  }
  const r = C.emaCrossOutcomes(bars, 1.5, { horizon: 14 });
  assert.equal(r.n, 0, "the spike candle closed back below — no cross fired, ever");
});

test("ema200 -26: chop around the line fires ONCE per episode — the re-arm gate eats the rest, and counts it", () => {
  const C = require("../src/compute");
  const DAY_ = 86400e3, t0 = Date.now() - 500 * DAY_;
  const bars = [];
  // long flat base so the SMA-seeded EMA sits at ~100, then a tight up/down chop straight
  // across it: closes alternate 101.5 / 98.5 for 8 bars, then run up cleanly.
  for (let i = 0; i < 230; i++) bars.push({ t: t0 + i * DAY_, c: 100, h: 100.3, l: 99.7, v: 1 });
  for (let i = 230; i < 238; i++) { const c = i % 2 === 0 ? 101.5 : 98.5; bars.push({ t: t0 + i * DAY_, c, h: c + 0.3, l: c - 0.3, v: 1 }); }
  for (let i = 238; i < 280; i++) bars.push({ t: t0 + i * DAY_, c: 102 + (i - 238) * 0.3, h: 102.5 + (i - 238) * 0.3, l: 101.5 + (i - 238) * 0.3, v: 1 });
  const r = C.emaCrossOutcomes(bars, 1.5, { horizon: 14, rearm: 3 });
  const rawUp = r.events.filter((e) => e.dir === "up" && e.vr === "raw");
  assert.equal(rawUp.length, 1, `alternating closes are ONE up-episode, got ${rawUp.length}`);
  assert.ok(r.suppressed.raw >= 3, `the gate counted the chop it ate (raw suppressed=${r.suppressed.raw})`);
  // and the single event that DID fire is the first cross of the fight, whipsaw-flagged
  assert.equal(rawUp[0].whip, true, "the surviving event honestly carries its 5-bar whipsaw flag");
});

test("ema200 -26: breakdown sign convention — a fall after a down-cross scores POSITIVE", () => {
  const C = require("../src/compute");
  const DAY_ = 86400e3, t0 = Date.now() - 600 * DAY_;
  const bars = [];
  for (let i = 0; i < 260; i++) bars.push({ t: t0 + i * DAY_, c: 100 + i * 0.02, h: 100.3 + i * 0.02, l: 99.7 + i * 0.02, v: 1 });
  for (let i = 260; i < 340; i++) { const c = 105.2 - (i - 260) * 0.45; bars.push({ t: t0 + i * DAY_, c, h: c + 0.3, l: c - 0.3, v: 1 }); }
  const r = C.emaCrossOutcomes(bars, 1.5, { horizon: 14 });
  const dn = r.events.filter((e) => e.dir === "dn" && e.vr === "raw");
  assert.ok(dn.length >= 1, "the down-cross fired");
  assert.ok(dn[0].fwd > 0 && dn[0].hit === true, `price kept falling: the breakdown SCORES positive (fwd=${dn[0].fwd}σ)`);
});

test("ema200 -26: the three variants gate correctly — buffer needs distance, 2-close needs the next close", () => {
  const C = require("../src/compute");
  const DAY_ = 86400e3, t0 = Date.now() - 600 * DAY_;
  // marginal cross: the crossing close sits a hair above the line (inside a 0.25σ buffer at
  // σ=2 → 0.5% needed), next bar closes back below → raw fires, buf and 2cl both refuse
  const bars = [];
  for (let i = 0; i < 240; i++) bars.push({ t: t0 + i * DAY_, c: 100, h: 100.3, l: 99.7, v: 1 });
  bars.push({ t: t0 + 240 * DAY_, c: 100.2, h: 100.5, l: 99.9, v: 1 });   // +0.2% over a ~100.0 EMA: under the 0.5% buffer
  for (let i = 241; i < 300; i++) bars.push({ t: t0 + i * DAY_, c: 99.5, h: 99.8, l: 99.2, v: 1 });
  const r = C.emaCrossOutcomes(bars, 2, { horizon: 14, bufSd: 0.25 });
  const up = r.events.filter((e) => e.dir === "up");
  assert.equal(up.filter((e) => e.vr === "raw").length, 1, "raw fires on the marginal close");
  assert.equal(up.filter((e) => e.vr === "buf").length, 0, "buffer refuses a close inside 0.25σ of the line");
  assert.equal(up.filter((e) => e.vr === "2cl").length, 0, "2-close refuses when the next close falls back");
});

test("ema200 -26: SMA-seeded walk agrees with emaLast — one EMA construction, bit for bit", () => {
  const C = require("../src/compute");
  const DAY_ = 86400e3, t0 = Date.now() - 600 * DAY_;
  const bars = [];
  for (let i = 0; i < 320; i++) { const c = 100 + Math.sin(i / 11) * 6 + i * 0.01; bars.push({ t: t0 + i * DAY_, c, h: c + 0.4, l: c - 0.4, v: 1 }); }
  // reproduce the study's internal walk and pin its final value to emaLast on the same closes
  const closes = bars.map((k) => k.c);
  const ref = C.emaLast(closes, 200);
  let e = 0; const k2 = 2 / 201;
  for (let i = 0; i < closes.length; i++) { if (i < 200) { e += closes[i]; if (i === 199) e /= 200; } else e = closes[i] * k2 + e * (1 - k2); }
  assert.ok(Math.abs(e - ref) < 1e-9, "the study's SMA-seeded walk IS emaLast's construction");
  // and the source pins it so a drive-by 'simplification' back to closes[0]-seeding fails loudly
  const fs = require("fs"), path = require("path");
  const cmp = fs.readFileSync(path.join(__dirname, "..", "src", "compute.js"), "utf8");
  assert.ok(cmp.includes("if (i < N) { e += c; if (i === N - 1) { e /= N; ema[i] = e; } }"), "SMA seed pinned in emaCrossOutcomes");
});

test("ema200 -26: tail exclusion and study aggregation floors", () => {
  const C = require("../src/compute");
  const DAY_ = 86400e3, t0 = Date.now() - 600 * DAY_;
  const bars = [];
  for (let i = 0; i < 220; i++) bars.push({ t: t0 + i * DAY_, c: 100, h: 100.3, l: 99.7, v: 1 });
  for (let i = 220; i < 226; i++) bars.push({ t: t0 + i * DAY_, c: 103, h: 103.3, l: 102.7, v: 1 });   // cross fires at 220, but only 5 bars remain
  const r = C.emaCrossOutcomes(bars, 1.5, { horizon: 14 });
  assert.equal(r.n, 0, "an event whose horizon runs past the tape is excluded whole — never a partial read");
  const st = C.emaCrossStudy([{ dir: "up", vr: "raw", fwd: 1, hit: true, whip: false, pl: 0.5 }], { cellFloor: 30 });
  assert.equal(st.up.raw.n, 1, "under-floor cell publishes its n");
  assert.equal(st.up.raw.hit, null, "…and nothing else");
  assert.equal(st.dn.raw, null, "empty stream: null cell, not a fabricated zero");
});

// ================================================================================================
// EMA200 shadow batch (build 2026.07.27-28): stage two of the -26 study — the two strongest
// priors (D1 buffered breakout, D1 support-retest hold) go live as touch-mode ledger shadows.
// Long side only, closed bars only, frozen geometry, structural targets, out-of-sample record.
// ================================================================================================

test("emabrk -28: fires on the armed, buffered, close-confirmed cross — and only on it", () => {
  const C = require("../src/compute");
  const DAY_ = 86400e3, t0 = Date.now() - 500 * DAY_;
  const lvlBars = [];
  for (let i = 0; i < 300; i++) lvlBars.push({ c: 100, h: (i === 60 || i === 90) ? 118 : 100, l: 100 });
  const mk = (cs) => cs.map((c, i) => [t0 + i * DAY_, c]);
  // 296 closes pinned at 100 (EMA converges to ~100), four below (armed window), then the cross
  const base = new Array(296).fill(100);
  const fires = mk(base.concat([98, 98, 98, 98, 104]));            // 4 below, close 4% above (>=0.25σ at σ=2 -> 0.5% needed)
  const eb = C.detectEmaBreak(fires, 105, 2, lvlBars);
  assert.ok(eb, "armed + buffered + confirmed: fires");
  assert.ok(Math.abs(eb.target - 118) < 0.01, "target = next structural level above");
  assert.ok(eb.stop < eb.ema && eb.ema < 105, "void half a sigma back through the line");
  // NOT armed: only two closes below before the cross — the same fight re-firing
  assert.equal(C.detectEmaBreak(mk(base.concat([102, 101, 98, 98, 104])), 105, 2, lvlBars), null,
    "two far-side closes are not a reset — the re-arm shape refuses");
  // NOT buffered: the confirming close sits a hair over the line
  assert.equal(C.detectEmaBreak(mk(base.concat([98, 98, 98, 98, 100.2])), 100.3, 2, lvlBars), null,
    "a marginal close inside 0.25 sigma of the line is the raw variant's trade, not this stream's");
  // NOT confirmed: last close back below — there is no cross to speak of
  assert.equal(C.detectEmaBreak(mk(base.concat([98, 98, 98, 104, 98])), 99, 2, lvlBars), null,
    "the close decides; yesterday's excursion is nothing");
  // no structural target -> no claim, never an invented one
  const flat = lvlBars.map(() => ({ c: 100, h: 100, l: 100 }));
  assert.equal(C.detectEmaBreak(fires, 105, 2, flat), null, "nowhere to go is not a trade");
  assert.equal(C.detectEmaBreak(fires.slice(0, 210), 105, 2, lvlBars), null, "under 216 closes: honest null");
});

test("emarts -28: the held retest from clear air — touch, hold, first-of-episode, all required", () => {
  const C = require("../src/compute");
  const DAY_ = 86400e3, t0 = Date.now() - 500 * DAY_;
  const lvlBars = [];
  for (let i = 0; i < 300; i++) lvlBars.push({ c: 100, h: (i === 60 || i === 90) ? 118 : 100, l: 100 });
  const bars = [];
  for (let i = 0; i < 298; i++) bars.push({ t: t0 + i * DAY_, c: 100, h: 100.4, l: 99.6, v: 1 });
  // prior bar: clear air above the ~100 line, untouched; last bar: dips through it, closes back above
  bars.push({ t: t0 + 298 * DAY_, c: 102, h: 102.4, l: 101.2, v: 1 });
  bars.push({ t: t0 + 299 * DAY_, c: 101, h: 102, l: 99.3, v: 1 });
  const er = C.detectEmaRetest(bars, 101, 2, lvlBars);
  assert.ok(er, "touched from above and HELD: fires");
  assert.ok(Math.abs(er.target - 118) < 0.01 && er.stop < er.ema, "structural target above, void a sigma below the line");
  // did NOT hold: the touch bar closed through — that is a breakdown's business, not a retest's
  const broke = bars.slice(0, -1).concat([{ t: t0 + 299 * DAY_, c: 99.4, h: 102, l: 99.3, v: 1 }]);
  assert.equal(C.detectEmaRetest(broke, 99.4, 2, lvlBars), null, "a close through the line is not a hold");
  // no touch at all: the low never reached the line
  const noTouch = bars.slice(0, -1).concat([{ t: t0 + 299 * DAY_, c: 101.5, h: 102, l: 100.9, v: 1 }]);
  assert.equal(C.detectEmaRetest(noTouch, 101.5, 2, lvlBars), null, "no touch, no retest");
  // chop straddling the line: the prior bar ALSO touched — not the first touch of the episode
  const chop = bars.slice(0, -2).concat([
    { t: t0 + 298 * DAY_, c: 100.6, h: 101, l: 99.5, v: 1 },
    { t: t0 + 299 * DAY_, c: 101, h: 102, l: 99.3, v: 1 }]);
  assert.equal(C.detectEmaRetest(chop, 101, 2, lvlBars), null, "the second touch of a straddle is the same fight, not a fresh retest");
});

test("structural void -01: detectLvlTouch long — held probe of a confirmed support fires, everything sloppier refuses", () => {
  const C = require("../src/compute");
  // support cluster at 100 (two pivot-low closes), resistance/target cluster at 118
  const bars = svBars(300, { supAt: [50, 80], sup: 100, resAt: [60, 90], res: 118 });
  // last closed bar probes the level inside tau and CLOSES back above it
  bars[299] = { t: bars[299].t, c: 103, h: 103.4, l: 100.2 };
  const sd30 = 0.8;
  const r = C.detectLvlTouch(bars, 103.5, sd30, "long");
  assert.ok(r, "held probe of confirmed support must fire");
  assert.ok(Math.abs(r.lvl - 100) < 0.5, `anchored on the 100 cluster, got ${r.lvl}`);
  assert.ok(r.stop < r.lvl && r.stop > r.lvl * 0.99, `the stop is TIGHT — half a σ behind the level, not a range fraction away (got ${r.stop})`);
  assert.ok(Math.abs(r.target - 118) < 0.5, `target = next confirmed cluster above, got ${r.target}`);
  assert.equal(r.n, 2, "cluster touch count rides out as a recorded feature");
  assert.ok(r.ageD >= 0, "and so does the cluster's age");
  // risk from entry is a fraction of what a sigma-construct void would demand
  assert.ok((103.5 - r.stop) / 103.5 * 100 < 4.2, "the guessing-game premium is gone: risk to void is a few percent, not a range fraction");
  // no probe: the last bars never came near the level
  const far = svBars(300, { supAt: [50, 80], sup: 100, resAt: [60, 90], res: 118 });
  assert.equal(C.detectLvlTouch(far, 103.5, sd30, "long"), null, "no probe, no claim");
  // probe that CLOSED through the level is a breakdown's business
  const broke = svBars(300, { supAt: [50, 80], sup: 100, resAt: [60, 90], res: 118 });
  broke[299] = { t: broke[299].t, c: 99.5, h: 103, l: 99.3 };
  assert.equal(C.detectLvlTouch(broke, 99.6, sd30, "long"), null, "a close through the level is not a hold");
  // a flush DEEPER than tau is the reclaim/sweep families' trade, not this one's
  const deep = svBars(300, { supAt: [50, 80], sup: 100, resAt: [60, 90], res: 118 });
  deep[299] = { t: deep[299].t, c: 103, h: 103.4, l: 97 };
  assert.equal(C.detectLvlTouch(deep, 103.5, sd30, "long"), null, "a deep flush through the band belongs to the reclaim family");
  // no structural target above -> no claim, never an invented one
  const noTgt = svBars(300, { supAt: [50, 80], sup: 100 });
  noTgt[299] = { t: noTgt[299].t, c: 103, h: 103.4, l: 100.2 };
  assert.equal(C.detectLvlTouch(noTgt, 103.5, sd30, "long"), null, "nowhere to go is not a trade");
  // monotone tape confirms no structure at all — honest null
  const mono = [];
  for (let i = 0; i < 300; i++) { const c = 100 * Math.pow(1.002, i); mono.push({ t: Date.now() - (300 - i) * 86400e3, c, h: c * 1.001, l: c * 0.999 }); }
  assert.equal(C.detectLvlTouch(mono, mono[299].c * 1.001, 2, "long"), null, "a trend has no confirmed pivots to defend");
});

test("structural void -01: detectLvlTouch short mirror + nearestLevelBelow", () => {
  const C = require("../src/compute");
  // resistance cluster at 108 overhead, support/target cluster at 96 below
  const bars = svBars(300, { supAt: [60, 90], sup: 96, resAt: [50, 80], res: 108 });
  bars[299] = { t: bars[299].t, c: 104, h: 107.9, l: 103.6 };   // high probes 108 inside tau, closes back below
  const sd30 = 0.8;
  const r = C.detectLvlTouch(bars, 104.2, sd30, "short");
  assert.ok(r, "rejected probe of confirmed resistance must fire");
  assert.ok(Math.abs(r.lvl - 108) < 0.5, `anchored on the 108 cluster, got ${r.lvl}`);
  assert.ok(r.stop > r.lvl && r.stop < r.lvl * 1.01, "void half a σ ABOVE the level — tight, on the invalidation");
  assert.ok(Math.abs(r.target - 96) < 0.5, `target = next confirmed cluster below, got ${r.target}`);
  // nearestLevelBelow directly: same null discipline as its long mirror
  assert.ok(Math.abs(C.nearestLevelBelow(bars, 104.2, sd30, 1.5) - 96) < 0.5, "nearestLevelBelow finds the 96 cluster");
  const none = svBars(300, { resAt: [50, 80], res: 108 });
  assert.equal(C.nearestLevelBelow(none, 104.2, sd30, 1.5), null, "no qualifying level below is null, never an invented price");
});

test("structural void -01: structVoid — loss side only, sigma band enforced, stop through the level", () => {
  const C = require("../src/compute");
  const sd30 = 2;
  // clusters at 98 (below) and 103 (above) around a 100.5 base; px = 100
  const bars = svBars(300, { base: 100.5, supAt: [50, 80], sup: 98, resAt: [60, 90], res: 103 });
  const s = C.structVoid(bars, 100, sd30, "short");
  assert.ok(s && Math.abs(s.lvl - 103) < 0.5, "short void anchors on the overhead cluster");
  assert.ok(s.stop > s.lvl, "stop pushed through the level, not sitting on it");
  const l = C.structVoid(bars, 100, sd30, "long");
  assert.ok(l && Math.abs(l.lvl - 98) < 0.5 && l.stop < l.lvl, "long mirror anchors below, stop beneath the level");
  // out of band: a cluster 3.85σ away is a different thesis, not this trade's invalidation
  const farB = svBars(300, { base: 100.5, resAt: [60, 90], res: 108 });
  assert.equal(C.structVoid(farB, 100, sd30, "short"), null, "beyond 3σ: refused");
  // on top of the entry: the PALLADIUM artifact wearing structure's clothing
  const onTop = svBars(300, { base: 100.5, resAt: [60, 90], res: 104.55 });
  assert.equal(C.structVoid(onTop, 104.5, sd30, "short"), null, "inside 0.3σ of the mark: refused");
  // nothing on the loss side at all
  const only = svBars(300, { base: 100.5, supAt: [50, 80], sup: 98 });
  assert.equal(C.structVoid(only, 100, sd30, "short"), null, "no overhead structure, no short void — honest null");
});

test("-06 ratioCloses + emaSeries: null propagation, SMA seed, one EMA construction (tail === emaLast), no half-converged prefix", () => {
  const C = require("../src/compute");
  assert.deepEqual(C.ratioCloses([10, null, 30], [5, 5, 0]), [2, null, null], "missing leg OR zero denominator -> gap");
  const closes = Array.from({ length: 40 }, (_, i) => 100 + i);
  const es = C.emaSeries(closes, 21);
  assert.equal(es[19], null, "null before the seed index");
  assert.ok(es[20] != null, "SMA seed lands at span-1");
  assert.ok(Math.abs(es[20] - closes.slice(0, 21).reduce((s, x) => s + x, 0) / 21) < 1e-9, "seed IS the SMA");
  assert.ok(Math.abs(es[39] - C.emaLast(closes, 21)) < 1e-9, "series tail === emaLast — one construction, two callers");
  assert.equal(C.emaSeries(closes.slice(0, 20), 21), null, "under span+5 the WHOLE series is null — the line exists honestly or not at all");
  assert.equal(C.emaSeries(Array.from({ length: 204 }, () => 1), 200), null, "204 bars < 205 floor for the 200");
  assert.ok(C.emaSeries(Array.from({ length: 205 }, () => 1), 200) != null, "205 bars clears it");
});

test("-06 ratio candles behavioral: getRatio buckets honest closes-only OHLC, EMA200 over the full series, wire trim after", () => {
  const C = require("../src/compute");
  const HOUR = 3600e3;
  // Reproduce the getRatio pipeline's math on a fixture: hourly ratio closes -> packed
  // closes-only rows -> bucketCandles. Every O/H/L/C must be a real 1H-sampled ratio value.
  const t0 = Math.floor(Date.now() / (4 * HOUR)) * 4 * HOUR;
  const packed = [];
  const vals = [2.0, 2.1, 1.9, 2.2, 2.05, 2.3, 2.25, 2.4];
  for (let i = 0; i < vals.length; i++) packed.push([t0 + i * HOUR, null, null, null, vals[i], 0]);
  const c4 = C.bucketCandles(packed, 4, HOUR);
  assert.equal(c4.length, 2);
  assert.deepEqual([c4[0].o, c4[0].h, c4[0].l, c4[0].c], [2.0, 2.2, 1.9, 2.2], "bucket OHLC = first/max/min/last of the SAMPLED ratio — never numHigh÷denLow");
  assert.deepEqual([c4[1].o, c4[1].h, c4[1].l, c4[1].c], [2.05, 2.4, 2.05, 2.4]);
  // EMA-over-full-then-trim: values at trimmed indices must equal the full-series EMA, i.e. the
  // window can never re-seed the line.
  const closes = Array.from({ length: 500 }, (_, i) => 100 + Math.sin(i / 9) * 5 + i * 0.01);
  const full = C.emaSeries(closes, 200);
  const cut = 500 - 400;
  const shipped = full.slice(cut);
  assert.equal(shipped.length, 400);
  assert.ok(Math.abs(shipped[399] - C.emaLast(closes, 200)) < 1e-9, "trimmed tail still equals the full-history EMA");
  // Seed rides the FULL series (index 199): after the 100-bar trim it lands at shipped index 99.
  // The nulls before it are the honest seed window — the trim moves values, it never re-seeds.
  assert.equal(shipped[98], null, "pre-seed bars stay null through the trim");
  assert.ok(shipped[99] != null, "seed at full-series index 199, exactly where the SMA lands");
});

// ===== spine staleness hardening (build 2026.07.29-03) ==========================================
// The many-messages coverage episode had three root causes and one delivery flaw; every one is
// pinned or exercised here. (1) The vol-ordered fetch queue could starve a low-vol name carrying
// an open claim — the exact set coverageScan alerts on. (2) The silent hourlyWorker catch let a
// coin back itself off to a 90-min-stale spine with no log trace. (3) Nothing surfaced per-coin
// spine age + fail state, so episodes were undiagnosable after the fact. (4) coverageArmed
// re-armed on a single fresh scan, so a flap around the stale line fired per crossing.

test("spine hardening 2026.07.29-03: pure pick comparator — claim priority + age escalation, tier-0 byte-identical", () => {
  const { hourlyPickTier, hourlyPickBetter } = require("../src/compute");
  const ESC = 30 * 60 * 1000;
  // Tier assignment: fresh-ish is tier 0 whatever it holds; past escalation, claim beats no-claim.
  assert.equal(hourlyPickTier(5 * 60000, true, ESC), 0, "a fresh-ish claim coin is NOT escalated — under a healthy budget the ordering is the historical one");
  assert.equal(hourlyPickTier(31 * 60000, false, ESC), 1);
  assert.equal(hourlyPickTier(31 * 60000, true, ESC), 2);
  // The load-bearing case: a tiny stale claim coin beats the biggest fresh name on the board.
  const claimStale = { tier: 2, age: 95 * 60000, isNew: false, vol: 1 };
  const bigFresh = { tier: 0, age: 2 * 60000, isNew: true, vol: 1e9 };
  assert.ok(hourlyPickBetter(claimStale, bigFresh), "an escalated claim coin outranks volume AND isNew entirely");
  assert.ok(!hourlyPickBetter(bigFresh, claimStale), "…and the comparison is antisymmetric");
  // Within an escalated tier: stalest first, volume ignored.
  const older = { tier: 1, age: 200 * 60000, vol: 1 }, newer = { tier: 1, age: 95 * 60000, vol: 1e9 };
  assert.ok(hourlyPickBetter(older, newer) && !hourlyPickBetter(newer, older), "inside a tier, staleness decides — volume is out of the picture");
  // Tier 2 beats tier 1 regardless of age: the claim set is protected first.
  assert.ok(hourlyPickBetter({ tier: 2, age: 31 * 60000 }, { tier: 1, age: 500 * 60000 }), "claim tier outranks age across tiers");
  // Tier 0 preserves the historical ordering byte for byte: isNew beats vol, then vol descending.
  assert.ok(hourlyPickBetter({ tier: 0, isNew: true, vol: 1 }, { tier: 0, isNew: false, vol: 1e9 }), "tier 0: isNew first");
  assert.ok(hourlyPickBetter({ tier: 0, isNew: false, vol: 5 }, { tier: 0, isNew: false, vol: 3 }), "tier 0: then volume");
  assert.ok(!hourlyPickBetter({ tier: 0, isNew: false, vol: 3 }, { tier: 0, isNew: false, vol: 5 }), "tier 0: ties never churn best");
  assert.ok(hourlyPickBetter({ tier: 0, vol: 1 }, null), "null best always loses");
});

// ================================================================================================
// Rotation upgrades + action lists (build 2026.08.07-02): leaders money-fill, sector-detail →
// Markets drill, and the heating / cooling / strongest-bid strip under the markets table.
// ================================================================================================

test("dipReclaim: measures the deepest dip's reclaim, floors noise, fails closed (behavioral)", () => {
  const { dipReclaim } = require("../src/compute");
  const M = 5 * 60 * 1000, t0 = 1_754_000_000_000;
  // 24 bars: ramp to a 100 peak at bar 6, dip to 96 at bar 12, recover into the read.
  const bars = [];
  for (let i = 0; i < 24; i++) {
    const h = i < 6 ? 98 + i / 3 : i === 6 ? 100 : i < 12 ? 100 - (i - 6) * 0.6 : 97.4 + (i - 12) * 0.2;
    const l = h - 0.4;
    bars.push([t0 + i * M, h - 0.2, h, l, h - 0.1, 1000]);
  }
  const now = t0 + 24 * M;
  const out = dipReclaim(bars, 99.0, now, 0.35);
  assert.ok(out, "a 4% dip clears the floor");
  // trough = low of bar 11: h=97.0, l=96.6 -> dip vs the 100 peak = 3.4%; px 99.0 reclaims (99-96.6)/(100-96.6)
  assert.ok(Math.abs(out.dip - 3.4) < 1e-9, "dip depth measured against the running peak's high, in % of the peak");
  assert.ok(Math.abs(out.rec - +( (99.0 - 96.6) / (100 - 96.6) ).toFixed(3)) < 1e-9, "reclaimed fraction = (px − trough) / (peak − trough)");
  assert.equal(out.mins, Math.round((now - (t0 + 11 * M)) / 60000), "minutes since the trough bar printed");
  // a bid that runs past the old peak caps at 1.5 — strength acknowledged, not unbounded
  assert.equal(dipReclaim(bars, 110, now, 0.35).rec, 1.5, "reclaim clamps at 1.5");
  // px back AT the trough: zero reclaimed, never negative
  assert.equal(dipReclaim(bars, 96.6, now, 0.35).rec, 0, "no claw-back = 0, floor of the clamp");
  // floor: the same shape scaled to a 0.2% dip is bar noise, not a claim
  const tiny = bars.map((b) => [b[0], 100 + (b[1] - 100) * 0.05, 100 + (b[2] - 100) * 0.05, 100 + (b[3] - 100) * 0.05, 100 + (b[4] - 100) * 0.05, b[5]]);
  assert.equal(dipReclaim(tiny, 100, now, 0.35), null, "sub-floor dips return null — no fabricated bids");
  // fails closed on every degenerate input
  assert.equal(dipReclaim(bars.slice(0, 8), 99, now, 0.35), null, "<12 bars: not enough structure");
  assert.equal(dipReclaim(null, 99, now, 0.35), null, "null tail");
  assert.equal(dipReclaim(bars, 0, now, 0.35), null, "no live price");
  // sqlite string values coerce, same contract as detectSweep
  const str = bars.map((b) => b.map(String));
  assert.ok(Math.abs(dipReclaim(str, 99.0, now, 0.35).dip - 3.4) < 1e-9, "string bars coerce cleanly");
});

test("notes: manifest gates the tab and the write verb separately, and both routes are claimed", () => {
  const { FEATURES } = require("../src/compute");
  const tab = FEATURES.find((f) => f.key === "notes");
  const act = FEATURES.find((f) => f.key === "notes.write");
  assert.ok(tab && tab.kind === "tab", "notes ships as a tab feature");
  assert.ok(act && act.kind === "act", "the write verb has its own act key");
  assert.ok(tab.routes.includes("/api/notes"), "the tab claims the read route");
  assert.deepEqual(act.routes, ["POST /api/notes"],
    "the act claims only the write verb, so the GET stays gated by the tab key");
  // The whole point of two keys: opening the tab to the group must not hand the group the pen.
  assert.equal(act.def, "admin", "writes default admin even if the tab is opened up");
});

test("audit -67: the forming daily bar is dropped before detectors and studies read a 'close'", () => {
  const C = require("../src/compute");
  const now = Date.now(), day0 = Math.floor(now / DAY) * DAY;
  const closes = []; for (let i = 80; i >= 0; i--) closes.push([day0 - i * DAY, 100]);
  assert.equal(C.closedDailyCloses(closes, now).length, 80, "today's bar is forming");
  assert.equal(C.closedDailyCloses(closes, day0 + DAY).length, 81, "once its day has ended it is a close");
  assert.equal(C.closedDailyCloses([], now).length, 0);
  // A base breakout that only exists on today's forming bar must not fire.
  const b = closes.slice(0, -1).map((k, i) => [k[0], 100 + 0.1 * Math.sin(i)]);
  b.push([day0, 120]);   // today: "broke out" — but the day is not over
  const px = 121, sd30 = 1;
  assert.ok(C.detectBaseBreak(b, px, sd30, null) != null, "raw: the forming bar reads as a breakout close");
  assert.equal(C.detectBaseBreak(C.closedDailyCloses(b, now), px, sd30, null), null, "trimmed: nothing has closed above the base yet");
  // earnReactionsFor: today's reaction candle is not a reaction yet.
  const daily = []; for (let i = 30; i >= 0; i--) daily.push({ t: day0 - i * DAY, c: 100 });
  daily[daily.length - 1].c = 130;
  const d = (t) => new Date(t).toISOString().slice(0, 10);
  const st = C.earnReactionsFor([{ d: d(day0), s: "BMO" }, { d: d(day0 - 10 * DAY), s: "BMO" }], daily, now);
  assert.equal(st && st.n, 1, "only the settled print counts (" + (st && st.n) + ")");
});

// levelOutcomes and emaCrossOutcomes normalised a 370-bar walk with TODAY's σ: a name whose σ
// doubled had its old pivots clustered at today's tolerance and its old outcomes scored at half
// their true R. σ is now trailing per prefix (excluding the event bar's own return), today's value
// only where the prefix is too short.
test("audit -67: level and EMA outcome studies score history in the σ the tape had at the time", () => {
  const C = require("../src/compute");
  const t0 = Date.UTC(2025, 0, 1), bars = [];
  // 200 quiet bars (±1% oscillation) then 200 loud ones (±4%), deterministic, crossing the line often.
  for (let i = 0; i < 400; i++) { const amp = i < 200 ? 1 : 4; const c = 100 * (1 + (amp / 100) * Math.sin(i * 0.9)); bars.push({ t: t0 + i * DAY, c, h: c * 1.003, l: c * 0.997, v: 1 }); }
  const sdToday = 4;
  const trail = C.emaCrossOutcomes(bars, sdToday, { N: 20, horizon: 5, rearm: 3, bufSd: 0.25 });
  const fixed = C.emaCrossOutcomes(bars, sdToday, { N: 20, horizon: 5, rearm: 3, bufSd: 0.25, trailingSd: false });
  const early = (r) => r.events.filter((e) => e.vr === "raw" && e.t < t0 + 190 * DAY);
  const late = (r) => r.events.filter((e) => e.vr === "raw" && e.t > t0 + 260 * DAY);
  assert.ok(early(trail).length > 10 && late(trail).length > 10, "events on both halves");
  const meanAbs = (evs) => evs.reduce((a, e) => a + Math.abs(e.fwd), 0) / evs.length;
  // The property: in R, a regime's own moves read the same size whether it was the quiet or the
  // loud one — under today's σ the quiet era shrinks to a fraction of the loud one.
  const ratioTrail = meanAbs(early(trail)) / meanAbs(late(trail)), ratioFixed = meanAbs(early(fixed)) / meanAbs(late(fixed));
  assert.ok(ratioTrail > 0.7 && ratioTrail < 1.4, "trailing σ: quiet-era and loud-era |R| are comparable (" + ratioTrail.toFixed(2) + ")");
  assert.ok(ratioFixed < 0.5, "today's σ: the quiet era is scored at a fraction of its true R (" + ratioFixed.toFixed(2) + ")");
  const lv = C.levelOutcomes(bars, sdToday, { stride: 5, horizon: 10, minBars: 60 });
  const lvF = C.levelOutcomes(bars, sdToday, { stride: 5, horizon: 10, minBars: 60, trailingSd: false });
  const dEarly = (r) => r.events.filter((e) => e.t < t0 + 190 * DAY).map((e) => e.distSd);
  assert.ok(dEarly(lv).length && dEarly(lvF).length);
  const med = (a) => { const s = [...a].sort((x, y) => x - y); return s[Math.floor(s.length / 2)]; };
  assert.ok(med(dEarly(lv)) > 1.5 * med(dEarly(lvF)), "a quiet-era level sits further away in quiet-era σ");
  // Pinned convention: the σ window ends BEFORE the event bar (no one-bar look-ahead).
  const cmp = require("fs").readFileSync(require("path").join(__dirname, "..", "src", "compute.js"), "utf8");
  assert.equal((cmp.match(/sdAt\(rets, i\); return v != null && v > 0 \? v : sd(30|Tf); \}/g) || []).length, 2);
});
