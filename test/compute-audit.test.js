"use strict";
// compute.js — 2026-09-20 quantitative audit: window-reference timing, AMC print timing, first-cross
// guard, 5m anchor resolution, ET-keyed rvol, NYSE Rule 7.2, trailing gap sigma, fire-bar touches,
// one median, honest logLevel/spearman, closed-day regime correlation; plus the three new studies
// (earnReactionCurve, overnightSplit, net-of-funding R). Behavioural, synthetic bars throughout.
const test = require("node:test");
const assert = require("node:assert");
const C = require("../src/compute");
const HOUR = 3600e3, DAY = 86400e3, FIVE = 5 * 60e3;

test("audit 2/A: earnReactionCurve anchors at the ET print time; earnReactionsFor and detectPead use it when hourly is supplied", () => {
  // AMC print 2026-09-02 (16:05 ET). Hourly spine: 100 through the 16:00 ET close, 120 for the next
  // 4h, 125 after. The daily UTC bar for 09-02 closes 00:00Z (20:00 ET) — already post-print.
  const t16 = C.etWallToUtc(2026, 9, 2, 16, 0);
  const lvl = (closeT) => (closeT <= t16 ? 100 : closeT <= t16 + 4 * HOUR ? 120 : 125);
  const hs = []; for (let t = t16 - 48 * HOUR; t < t16 + 48 * HOUR; t += HOUR) hs.push([t, 0, 0, 0, lvl(t + HOUR), 1]);
  const prints = [{ t: "X", d: "2026-09-02", s: "AMC" }, { t: "Y", d: "2026-09-02", s: "DMH" }];
  const now = t16 + 30 * HOUR;
  const cv = C.earnReactionCurve(prints, hs, { now });
  assert.equal(cv.n, 1, "DMH has no known print time and is not on the curve");
  const r = cv.rows[0];
  assert.equal(r.p0, 100, "reference = the 16:00 ET close, not the 20:00 ET UTC-day close");
  assert.deepEqual(r.mv, { h1: 20, h4: 20, h24: 25 });
  assert.equal(cv.agg.h1.medAbs, 20); assert.equal(cv.agg.h24.up, 1); assert.equal(cv.agg.h24.upShare, 1);
  assert.equal(cv.approx, false, "every anchor sat on an hourly close");
  const early = C.earnReactionCurve(prints, hs, { now: t16 + 2 * HOUR });
  assert.equal(early.rows[0].mv.h1, 20); assert.equal(early.rows[0].mv.h24, null, "a horizon that has not elapsed is null, not zero");
  assert.equal(early.agg.h24.n, 0);
  assert.equal(C.earnReactionCurve(prints, hs.map(([t, o, h, l, c, v]) => ({ t, o, h, l, c, v })), { now }).rows[0].mv.h24, 25, "object rows accepted");
  assert.equal(C.earnReactionCurve(prints, hs, { now: t16 - HOUR }), null, "a print that has not happened yet is no row");
  // earnReactionsFor (re-pinned -106): ONE window — the last cash close before the print (09-02
  // 16:00 ET) -> the first cash close after it (09-03 16:00 ET), read off the hourly spine (hN =
  // cashN says how many); without intraday data, the session-bar fallback of the SAME window: the
  // last session bar before the print day (09-01) -> the reaction session's bar (09-03).
  const T0 = Date.UTC(2026, 8, 1);
  const daily = [{ t: T0 - DAY, c: 100 }, { t: T0, c: 100 }, { t: T0 + DAY, c: 120 }, { t: T0 + 2 * DAY, c: 125 }, { t: T0 + 3 * DAY, c: 125 }];
  const st = C.earnReactionsFor(prints.slice(0, 1), daily, now, hs);
  assert.equal(st.n, 1); assert.equal(st.avgAbs, 25); assert.equal(st.hN, 1);
  // (re-pinned -107) daily-only, an AMC print's session-bar window is 09-01's bar -> 09-03's: TWO
  // sessions (09-02's bar closes after the print), so the study excludes it rather than pool it
  // with one-session reactions; the single-print path still reads it, labelled `wide`.
  assert.equal(C.earnReactionsFor(prints.slice(0, 1), daily, now), null, "daily-only AMC: excluded from the pooled study");
  const one = C.earnPrintReaction(prints[0], daily, 125, null, now);
  assert.deepEqual(one, { pct: 25, state: "final", src: "daily", wide: true }, "09-01's session bar -> 09-03's, labelled as the two-session window it is");
  // anchors: AMC 16:00 ET, BMO 06:00 ET (before essentially every pre-market print), others none
  assert.equal(C.earnPrintUtc({ d: "2026-09-02", s: "AMC" }), t16);
  assert.equal(C.earnPrintUtc({ d: "2026-09-02", s: "BMO" }), C.etWallToUtc(2026, 9, 2, 6, 0));
  assert.equal(C.earnPrintUtc({ d: "2026-09-02", s: "TBD" }), null);
  // detectPead (re-pinned -121): a flat daily tape hides a reaction the hourly spine sees. The print
  // is a FRIDAY AMC (2026-08-28), so its window is Friday's 16:00 ET close -> Monday 08-31's close
  // (earnReactWindow) — the old +24h anchor landed on Saturday.
  const base = Date.UTC(2026, 7, 1), dly = []; for (let i = 0; i < 30; i++) dly.push({ t: base + i * DAY, c: 100, o: 100 });
  const pd = dly[27], pt = C.etWallToUtc(2026, 8, 28, 16, 0), pm = C.etWallToUtc(2026, 8, 31, 16, 0);   // dly[27] is 2026-08-28
  assert.equal(new Date(pd.t).toISOString().slice(0, 10), "2026-08-28");
  const hs2 = []; for (let t = pt - 48 * HOUR; t < pm + 12 * HOUR; t += HOUR) hs2.push([t, 0, 0, 0, t + HOUR <= pt ? 100 : 106, 1]);
  const pr = [{ t: "X", d: "2026-08-28", s: "AMC" }];
  assert.equal(C.detectPead(pr, dly, 107, 2, null, pm + 2 * HOUR), null, "daily bars only: an AMC session-bar window spans two sessions — no fire");
  const pead = C.detectPead(pr, dly, 107, 2, hs2, pm + 2 * HOUR);
  assert.ok(pead && pead.side === "long" && pead.mv === 6 && pead.src === "cash", "hourly anchors: +6% from Friday's 16:00 ET close to Monday's");
  assert.equal(C.detectPead(pr, dly, 107, 2, hs2, pt + 30 * HOUR), null, "Saturday: the reaction session (Monday) has not closed");
});

test("audit 4: the 5m archive resolves a 09:30 ET anchor; hourly alone reads the 09:00 close and says approx", () => {
  const open = C.etWallToUtc(2026, 9, 2, 9, 30), close = C.etWallToUtc(2026, 9, 2, 16, 0);
  const H0 = Math.floor(open / HOUR) * HOUR;
  const rows = []; for (let k = -30; k <= 30; k++) { const t = H0 + k * HOUR; rows.push([t, 0, 0, 0, new Date(t + HOUR).getUTCHours(), 1]); }   // close = its close-time UTC hour
  const fine = []; for (let t = open - 2 * HOUR; t <= open + 2 * HOUR; t += FIVE) fine.push([t, 0, 0, 0, t + FIVE === open ? 555 : 1, 1]);
  assert.equal(C.priceAsOf(rows, open, 3 * HOUR), 13, "hourly-only: the bar ending 13:00Z = 09:00 ET");
  assert.equal(C.priceAsOf(rows, open, 3 * HOUR, HOUR, fine), 555, "with the 5m archive: the bar ending exactly 09:30 ET");
  assert.equal(C.priceAsOf(rows, close, 3 * HOUR, HOUR, fine), 20, "the archive does not reach 16:00 -> hourly, which is exact there");
  assert.deepEqual(C.anchorPrice(rows, fine, open, 3 * HOUR), { px: 555, approx: false });
  assert.deepEqual(C.anchorPrice(rows, null, open, 3 * HOUR), { px: 13, approx: true }, "an hourly close 30 min before the anchor is an approximation");
  assert.deepEqual(C.anchorPrice(rows, null, close, 3 * HOUR), { px: 20, approx: false }, "an hourly bar closes ON 16:00 ET: exact");
  assert.deepEqual(C.anchorPrice([], null, close, 3 * HOUR), { px: null, approx: true });
  const h = C.holdReturn(rows, [], open, close, 3 * HOUR);
  assert.equal(h.ok, true); assert.equal(h.approx, true); assert.equal(h.pxEnter, 13);
  const hf = C.holdReturn(rows, [], open, close, 3 * HOUR, fine);
  assert.equal(hf.approx, false); assert.equal(hf.pxEnter, 555); assert.equal(hf.pxExit, 20);
  assert.equal(C.runHolds(rows, [], [{ enter: open, exit: close, tag: "cash" }], 3 * HOUR, fine)[0].pxEnter, 555, "runHolds passes the archive through");
});

test("audit 5: rvolMulti keys the baseline by ET wall hour across the 2026-11-01 fall-back", () => {
  // Identical ET-clock volume every day: 100 in the 09:00 ET hour, 10 elsewhere. Read at 10:00 ET on
  // Nov 3 (EST): the 09:00 hour must judge against prior 09:00 hours = 1.0x. UTC stepping compares
  // 14:00Z against 14:00Z, which before the switch was 10:00 EDT — a guaranteed false elevation.
  const start = Date.UTC(2026, 9, 1), now = C.etWallToUtc(2026, 11, 3, 10, 0);
  const hs = []; for (let t = start; t < now; t += HOUR) hs.push([t, 1, 1, 1, 1, C.etParts(t).h === 9 ? 100 : 10]);
  assert.equal(C.rvolMulti(hs, { h1: HOUR }, now, 7, "ET").h1, 1, "ET keyed: the open hour after the switch reads 1.0x");
  assert.equal(C.rvolMulti(hs, { h4: 4 * HOUR, d1: DAY }, now, 7, "ET").h4, 1);
  const utc = C.rvolMulti(hs, { h1: HOUR }, now, 7).h1;
  assert.ok(utc > 5, "UTC stepping (the old default) reads the 10:00 EDT baseline: " + utc + "x");
  assert.equal(C.rvolMulti(hs, { h1: HOUR }, now, 7, "UTC").h1, utc, "tz 'UTC' is the old stepping, unchanged");
  // Before the switch both agree — the keying only matters when the offset moves.
  const nowB = C.etWallToUtc(2026, 10, 28, 10, 0), hsB = hs.filter((k) => k[0] < nowB);
  assert.equal(C.rvolMulti(hsB, { h1: HOUR }, nowB, 7, "ET").h1, C.rvolMulti(hsB, { h1: HOUR }, nowB, 7).h1);
});

test("audit 6: NYSE Rule 7.2 — no Friday Dec 31 closure when Jan 1 falls on a Saturday", () => {
  assert.equal(C.usDayStatus(2021, 12, 31), 0, "the NYSE traded Fri 2021-12-31");
  assert.equal(C.usDayStatus(2027, 12, 31), 0, "and will trade Fri 2027-12-31");
  assert.equal(C.usDayStatus(2026, 7, 3), 2, "Sat->Fri observance elsewhere stays (Jul 4 2026)");
  assert.equal(C.usDayStatus(2021, 12, 24), 2, "Christmas on a Saturday is still observed Friday");
  assert.equal(C.usDayStatus(2027, 1, 1), 2, "a weekday New Year's Day is closed");
  assert.equal(C.usDayStatus(2023, 1, 2), 2, "Sun->Mon observance for New Year's stays");
});

test("audit 7: studyGapFade thresholds each gap against the sigma of the gaps BEFORE it", () => {
  // 40 overnight windows, gaps alternating ±0.3% — then a +30% gap on the LAST one. The old
  // full-sample sigma (~4.7%) de-selected every earlier event retroactively; the trailing sigma
  // (~0.3%) qualifies every event from the 11th onward, and the outlier itself.
  const start = Date.UTC(2026, 5, 1), end = Date.UTC(2026, 8, 1);
  const wins = C.overnightAnchors(start, end).slice(0, 40);
  assert.equal(wins.length, 40);
  const gaps = wins.map((w, i) => (i === 39 ? 30 : (i % 2 ? 0.3 : -0.3)));
  const levels = []; let p = 100; for (const g of gaps) { p *= 1 + g / 100; levels.push(p); }
  // level switches at exit − 30min so the hourly 09:00 read already carries the gap; the session is flat
  const level = (time) => { let l = 100; for (let i = 0; i < wins.length; i++) if (time >= wins[i].exit - 30 * 60e3) l = levels[i]; else break; return l; };
  const hs = []; for (let t = start - 2 * DAY; t < end + 2 * DAY; t += HOUR) hs.push([t, 0, 0, 0, level(t + HOUR), 1]);
  const res = C.studyGapFade(hs, wins, 3 * HOUR);
  assert.equal(res.nGaps, 40);
  assert.ok(res.sd > 4, "the descriptive whole-sample sigma is still reported: " + res.sd);
  assert.equal(res.session.n, 30, "events 11..40 qualify on their own trailing sigma; the first 10 lack a sample");
  assert.equal(res.approx, true, "09:30 anchors resolved on hourly closes are flagged");
  // The outlier at the end must not change what the earlier events were judged against.
  const quiet = gaps.slice(); quiet[39] = -0.3;
  const lv2 = []; p = 100; for (const g of quiet) { p *= 1 + g / 100; lv2.push(p); }
  const level2 = (time) => { let l = 100; for (let i = 0; i < wins.length; i++) if (time >= wins[i].exit - 30 * 60e3) l = lv2[i]; else break; return l; };
  const hs2 = []; for (let t = start - 2 * DAY; t < end + 2 * DAY; t += HOUR) hs2.push([t, 0, 0, 0, level2(t + HOUR), 1]);
  assert.equal(C.studyGapFade(hs2, wins, 3 * HOUR).session.n, 30, "same count without the outlier: the past is not re-judged by the future");
});

test("audit 8: the fire bar is walked — a stop inside it counts (amb), a target inside it does not", () => {
  const T = Date.UTC(2026, 8, 1), t0 = T + 10 * HOUR + 5 * 60e3, tEnd = T + 20 * HOUR;
  const stopBar = [[T + 10 * HOUR, 100, 101, 90, 100, 1], [T + 11 * HOUR, 100, 101, 99, 100, 1]];   // 10:00 bar wicks to 90
  assert.equal(C.stopTouched(stopBar, t0, tEnd, 1, 95), true, "long stop 95 taken inside the fire bar");
  assert.deepEqual(C.bracketTouch(stopBar, t0, tEnd, "long", 95, 110), { hit: "stop", level: 95, t: T + 10 * HOUR, amb: true });
  const tgtBar = [[T + 10 * HOUR, 100, 112, 99, 100, 1], [T + 11 * HOUR, 100, 101, 99, 100, 1]];    // 10:00 bar wicks to 112
  assert.equal(C.bracketTouch(tgtBar, t0, tEnd, "long", 95, 110), null, "a target touched only in the fire bar is not a win");
  assert.equal(C.stopTouched(tgtBar, t0, tEnd, 1, 95), false, "seen, not stopped");
  const later = tgtBar.concat([[T + 12 * HOUR, 100, 111, 100, 110, 1]]);
  assert.equal(C.bracketTouch(later, t0, tEnd, "long", 95, 110).t, T + 12 * HOUR, "a later clean touch is the win");
  assert.equal(C.bracketTouch(later, t0, tEnd, "long", 95, 110).amb, false);
  assert.equal(C.stopTouched([[T + 9 * HOUR, 100, 101, 90, 100, 1]], t0, tEnd, 1, 95), null, "a bar that closed before the fire is outside the window");
  assert.equal(C.stopTouched([[T + 10 * HOUR, 100, 112, 99, 100, 1]], t0, tEnd, -1, 105), true, "short mirror: fire-bar high through the stop");
  assert.equal(C.bracketTouch([[T + 10 * HOUR, 100, 101, 88, 100, 1]], t0, tEnd, "short", 105, 90), null, "short mirror: fire-bar low through the target is not a win");
  // epResolve carries the same asymmetry
  const ep = C.epResolve(stopBar, t0, tEnd, "long", 95, 110);
  assert.equal(ep.kind, "void"); assert.equal(ep.amb, true); assert.equal(ep.approx, false);
  const ep2 = C.epResolve(tgtBar, t0, tEnd, "long", 95, 110);
  assert.equal(ep2.kind, "expired"); assert.equal(ep2.approx, false, "the fire bar was seen");
  assert.equal(C.epResolve(later, t0, tEnd, "long", 95, 110).kind, "target");
});

test("audit 9: summarizeEvents uses the one median everything else uses", () => {
  assert.equal(C.summarizeEvents([-1, 3]).med, 1);
  assert.equal(C.summarizeEvents([1, 2, 3, 10]).med, 2.5);
  assert.equal(C.summarizeEvents([1, 2, 3]).med, 2);
  assert.equal(C.summarizeEvents([5]).med, 5);
});

test("audit 10: logLevel refuses to invent a 1% sigma; the log-geometry playbook path tolerates it", () => {
  assert.equal(C.logLevel(100, -1, null), null);
  assert.equal(C.logLevel(100, -1, 0), null);
  assert.equal(C.logLevel(100, -1, NaN), null);
  assert.ok(Math.abs(C.logLevel(100, -1, 8) - 100 * Math.exp(-0.08)) < 1e-3, "a measured 8% sigma places the level at 8%");
  const pb = C.playbook("bigmove", { px: 100, dir: 1, med: 2, logGeo: true });
  assert.equal(pb.stop, null, "crypto geometry without a sigma ledgers with no stop rather than a fabricated one");
  assert.ok(pb.target > 100, "the sigma-free leg still computes");
  const pbSd = C.playbook("bigmove", { px: 100, dir: 1, med: 2, logGeo: true, sd30: 8 });
  assert.ok(Math.abs(pbSd.stop - 100 * Math.exp(-0.08)) < 1e-3);
  const eq = C.playbook("bigmove", { px: 100, dir: 1, med: 2 });
  assert.equal(eq.stop, 99, "the additive equity path keeps its historical 1% stand-in (record comparability)");
});

test("audit 11: spearmanIC drops pairs with a non-finite side and needs 3 survivors", () => {
  assert.ok(Math.abs(C.spearmanIC([1, 2, NaN, 4, 5], [1, 2, 3, 4, 5]) - 1) < 1e-12, "the NaN pair is dropped, the rest ranks cleanly");
  assert.ok(Math.abs(C.spearmanIC([1, 2, 3, 4], [4, 3, null, 1]) + 1) < 1e-12, "null on the return side drops the pair too");
  assert.equal(C.spearmanIC([1, NaN, 3], [1, 2, 3]), null, "two survivors -> null");
  assert.equal(C.spearmanIC([NaN, NaN, NaN, NaN], [1, 2, 3, 4]), null);
  assert.equal(C.spearmanIC([1, 2, 3], [1, 2]), null, "length mismatch stays null");
});

test("audit 12: meanPairwiseCorr with `now` drops today's partial-day return; without it the old read stands", () => {
  const now = Date.now(), today = Math.floor(now / DAY) * DAY;
  // Two series with IDENTICAL closed-day returns (corr 1) and OPPOSITE moves on today's forming bar.
  const mk = (todayMul) => { const a = []; let p = 100; for (let i = 60; i >= 1; i--) { p *= 1 + 0.01 * Math.sin(i); a.push([today - i * DAY, p]); } a.push([today, p * todayMul]); return a; };
  const s1 = mk(1.08), s2 = mk(0.92);
  const closed = C.meanPairwiseCorr([s1, s2], 30, now);
  assert.equal(closed.pairs, 1);
  assert.ok(closed.corr > 0.9999, "closed days only: the pair is perfectly correlated, got " + closed.corr);
  const raw = C.meanPairwiseCorr([s1, s2], 30);
  assert.ok(raw.corr < 0.99, "the old read lets today's opposite partial move dent the regime number: " + raw.corr);
});

test("audit B: overnightSplit — after-hours and pre-open legs, 5m-resolved, approx when hourly only", () => {
  const enter = C.etWallToUtc(2026, 9, 1, 16, 0), split = C.etWallToUtc(2026, 9, 2, 8, 30), exit = C.etWallToUtc(2026, 9, 2, 9, 30);
  const level = (closeT) => (closeT <= enter ? 100 : closeT <= split ? 102 : 103);   // +2% after hours, +~1% pre-open
  const hs = []; for (let t = enter - 5 * HOUR; t < exit + 5 * HOUR; t += HOUR) hs.push([t, 0, 0, 0, level(t + HOUR), 1]);
  const fine = []; for (let t = enter - 5 * HOUR; t < exit + 5 * HOUR; t += FIVE) fine.push([t, 0, 0, 0, level(t + FIVE), 1]);
  const anchors = [{ enter, exit, tag: "overnight" }];
  const pre = (103 / 102 - 1) * 100;
  const r = C.overnightSplit(hs, fine, anchors);
  assert.equal(r.n, 1);
  assert.equal(r.rows[0].ah, 2); assert.ok(Math.abs(r.rows[0].pre - pre) < 1e-3); assert.equal(r.rows[0].total, 3);
  assert.equal(r.medAh, 2); assert.equal(r.medTotal, 3);
  assert.ok(Math.abs(r.shareAh - 2 / (2 + pre)) < 1e-3, "share of the |move| priced before 08:30");
  assert.ok(Math.abs(r.shareAh + r.sharePre - 1) < 1e-9);
  assert.equal(r.approx, false); assert.equal(r.nApprox, 0);
  const rh = C.overnightSplit(hs, null, anchors);
  assert.equal(rh.rows[0].ah, 2, "hourly only: the 08:00 ET close stands in for 08:30");
  assert.equal(rh.approx, true); assert.equal(rh.nApprox, 1);
  assert.equal(C.overnightSplit(hs, fine, []), null);
  assert.equal(C.overnightSplit(hs, fine, [{ enter, exit: enter + HOUR }]), null, "a window that does not contain 08:30 ET is skipped");
  assert.equal(C.overnightSplit(hs.map(([t, o, h, l, c, v]) => ({ t, o, h, l, c, v })), null, anchors).rows[0].total, 3, "object rows accepted");
});

test("audit C: medNet — event R net of the funding a 1x position paid over the horizon, signed with the event", () => {
  const T = Date.UTC(2026, 0, 1), closes = [];
  for (let i = 0; i < 40; i++) closes.push([T + i * DAY, 100 + (i % 2) * 0.5]);
  for (let i = 40; i < 50; i++) closes.push([T + i * DAY, 100 + (i - 39) * 2]);   // one first cross at i=40, then a run
  const gross = C.studyBreakout(closes);
  assert.equal(gross.d1.n, 1);
  assert.equal(gross.d1.medNet, undefined, "no funding -> no medNet"); assert.equal(gross.rawNet, undefined, "and no rawNet");
  // +0.01%/h funding (longs pay) over the whole tape: a 1d hold pays 0.24%
  const funding = []; for (let t = T; t < T + 50 * DAY; t += HOUR) funding.push([t, 0.0001]);
  const net = C.studyBreakout(closes, funding);
  assert.equal(net.d1.n, 1); assert.equal(typeof net.d1.medNet, "number");
  assert.deepEqual(net.raw, gross.raw, "gross R untouched by the funding input");
  const f1 = (closes[41][1] / closes[40][1] - 1) * 100, sd = f1 / net.raw.d1[0];   // R = f1 / sd
  assert.ok(Math.abs((net.raw.d1[0] - net.rawNet.d1[0]) * sd - 0.24) < 1e-2, "a long paid 24 hourly ticks of 0.01%");
  assert.ok(net.d1.medNet < net.d1.med);
  // the mirror study is SHORT: it receives positive funding, so net sits above gross
  const bd = C.studyBreakdown(closes.map(([t, c]) => [t, 200 - c]), funding);
  assert.ok(bd.rawNet.d1[0] > bd.raw.d1[0]);
  // funding rows that end before the horizon -> that event carries no net entry (never a zero cost)
  assert.equal(C.studyBreakout(closes, funding.filter(([t]) => t < T + 30 * DAY)).rawNet.d1.length, 0);
  assert.equal(C.studyBreakout(closes, funding.filter(([t]) => t < T + 30 * DAY)).d1.medNet, undefined);
  // the other daily studies take the same optional input without changing their gross output
  assert.deepEqual(C.studyBigMove(closes, funding).raw, C.studyBigMove(closes).raw);
  assert.deepEqual(C.studyVolShift(closes, funding).raw, C.studyVolShift(closes).raw);
  assert.equal(C.netEventR(funding, 1, 2, 1, T + 41 * DAY, T + 42 * DAY), +(2 - 0.24).toFixed(3));
  assert.equal(C.netEventR(funding, -1, -2, 1, T + 41 * DAY, T + 42 * DAY), +(2 + 0.24).toFixed(3), "a short receives what a long pays");
  assert.equal(C.netEventR([], 1, 2, 1, T, T + DAY), null);
});
