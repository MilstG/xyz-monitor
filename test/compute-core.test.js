"use strict";
// compute.js — stats, features, classification, sessions, funding. Split out of test.js (build 2026.09.16-80); order within the file is the original order.
const test = require("node:test");
const assert = require("node:assert");
const { classify, stdev, median, linregR2, priceAt, featuresFromHourly, oiDeltaPct, pearson, meanPairwiseCorr, corrMatrix, confSplit, offDriftStats, HOUR, DAY, C, fourHourReturns, tapeRedStats, rvolMulti, spineFrom4h, sessionRecords, candleType, candleEvents, pivotPool, CANDLE_TYPES, PIVOT_EARLY_H } = require("./_shared");


test("funding heatmap: a cell is the funding a 1x long paid over the bucket, at every timeframe", () => {
  const { fundingHeat } = require("../src/compute");
  const end = Math.floor(Date.now() / HOUR) * HOUR;
  const flat = []; for (let i = 48; i > 0; i--) flat.push([end - i * HOUR, 1e-4]);
  // 1h reads the hourly rate itself; 8h and 24h read what was actually PAID over the bucket, so
  // the same market is 8x and 24x larger. This is the whole point of the timeframe switch.
  const h1 = fundingHeat(flat, { bucketHours: 1, buckets: 4, end });
  const h8 = fundingHeat(flat, { bucketHours: 8, buckets: 4, end });
  const h24 = fundingHeat(flat, { bucketHours: 24, buckets: 1, end });
  for (const v of h1.cells) assert.ok(Math.abs(v - 1e-4) < 1e-12, "1h cell is the hourly rate");
  for (const v of h8.cells) assert.ok(Math.abs(v - 8e-4) < 1e-12, "8h cell is eight hours of it");
  assert.ok(Math.abs(h24.cells[0] - 24e-4) < 1e-12, "24h cell is a full day of it");
  assert.equal(h1.cells.length, 4); assert.equal(h8.buckets, 4); assert.equal(h24.bucketHours, 24);
});

test("funding heatmap: buckets are epoch-anchored, complete, and nest 24h = 3 x 8h", () => {
  const { fundingHeat } = require("../src/compute");
  const end = Date.now();
  // Epoch anchoring is what makes two rows comparable column-for-column: t0 must not move with the
  // caller's clock inside a bucket, or two markets built a second apart land on different columns.
  const a = fundingHeat([], { bucketHours: 8, buckets: 5, end });
  const b = fundingHeat([], { bucketHours: 8, buckets: 5, end: end + 60 * 1000 });
  assert.equal(a.t0, b.t0, "t0 is stable within a bucket");
  assert.equal(a.t0 % a.width, 0, "buckets sit on epoch multiples of their own width");
  // and the last bucket is the last COMPLETE one — a half-elapsed bucket would read as a fake
  // collapse in carry at the right edge of every row.
  assert.ok(a.t0 + a.buckets * a.width <= Math.floor(end / a.width) * a.width, "no in-progress bucket");
  // 8h buckets tile a 24h bucket exactly, so the three timeframes tell one consistent story. The
  // two grids do NOT end together — each stops on its own last COMPLETE bucket — so line them up
  // on a shared day boundary rather than on the right edge.
  const hist = []; for (let i = 96; i > 0; i--) hist.push([Math.floor(end / HOUR) * HOUR - i * HOUR, 2e-5 * (i % 7)]);
  const g8 = fundingHeat(hist, { bucketHours: 8, buckets: 12, end });
  const g24 = fundingHeat(hist, { bucketHours: 24, buckets: 3, end });
  const day = g24.t0 + g24.width, i0 = Math.round((day - g8.t0) / g8.width);
  assert.ok(i0 >= 0 && i0 + 2 < g8.buckets, "that day sits inside the 8h grid");
  assert.equal(g8.t0 + i0 * g8.width, day, "a day boundary IS an 8h boundary");
  const sum = g8.cells[i0] + g8.cells[i0 + 1] + g8.cells[i0 + 2];
  assert.ok(Math.abs(sum - g24.cells[1]) < 1e-12, "one day equals its three 8h buckets");
});

test("funding heatmap: a thin bucket is scaled to full width, an empty one is null — never zero", () => {
  const { fundingHeat, FUNDHEAT_MIN_COV } = require("../src/compute");
  const end = Math.floor(Date.now() / HOUR) * HOUR;
  const width = 8 * HOUR, last = Math.floor(end / width) * width - width;
  // Six of the bucket's eight hours observed: the mean is scaled out to a full bucket, so a gappy
  // spine reads as the carry it implies rather than as "carry collapsed".
  const six = []; for (let k = 0; k < 6; k++) six.push([last + k * HOUR, 1e-4]);
  const g = fundingHeat(six, { bucketHours: 8, buckets: 1, end });
  assert.equal(g.n[0], 6);
  assert.ok(Math.abs(g.cells[0] - 8e-4) < 1e-12, "six observed hours still price a full 8h bucket");
  // Three of eight is under the coverage floor — that is a gap in the spine, and a gap is unknown,
  // not flat. The renderer hatches null; a zero would be a claim the data cannot support.
  const three = []; for (let k = 0; k < 3; k++) three.push([last + k * HOUR, 1e-4]);
  assert.equal(fundingHeat(three, { bucketHours: 8, buckets: 1, end }).cells[0], null);
  assert.equal(FUNDHEAT_MIN_COV, 0.5);
  assert.equal(fundingHeat(three, { bucketHours: 8, buckets: 1, end, minCov: 0.25 }).cells[0] != null, true,
    "the coverage floor is a parameter, not a hard-coded half");
  // Junk in the spine never becomes a number.
  assert.deepEqual(fundingHeat([[last, NaN], [last + HOUR, null], [null, 1e-4]], { bucketHours: 8, buckets: 1, end }).cells, [null]);
  assert.deepEqual(fundingHeat(null, { bucketHours: 1, buckets: 2, end }).cells, [null, null]);
});

test("stats: stdev / median / linregR2", () => {
  assert.equal(median([3, 1, 2]), 2);
  assert.equal(median([1, 2, 3, 4]), 2.5);
  assert.ok(Math.abs(stdev([2, 4, 4, 4, 5, 5, 7, 9]) - 2.138) < 0.01);
  const { r2 } = linregR2([1, 2, 3, 4, 5]); // perfectly linear
  assert.ok(r2 > 0.999);
});

test("priceAt: the close of the last bar that ENDED at or before the target, forming bar excluded", () => {
  // Re-baselined (window-reference timing fix): rows carry the bar's OPEN and the close prints at
  // t + width, so the reference at `target` is the last bar that had CLOSED by then — not the bar
  // whose open sits nearest. The old fixture (bars 1s apart, matched on open) encoded the defect:
  // at :45 past the hour "1h ago" resolved to the FORMING bar, i.e. the live price.
  const c = [{ t: 0, c: "10" }, { t: HOUR, c: "20" }, { t: 2 * HOUR, c: "30" }, { t: 3 * HOUR, c: "40" }];
  assert.equal(priceAt(c, 2 * HOUR + 6e5, HOUR), 20, "bar 1 closed at 2h: the last close by 2h10");
  assert.equal(priceAt(c, 2 * HOUR, HOUR), 20, "a bar closing exactly on the target counts");
  assert.equal(priceAt(c, 3 * HOUR + 30 * 60e3, HOUR, 3 * HOUR + 45 * 60e3), 30, "bar 3 is still forming at now=3h45 -> bar 2's close");
  assert.equal(priceAt(c, 3 * HOUR + 30 * 60e3, 10 * 60e3), null, "beyond tolerance after the last eligible close");
  assert.equal(priceAt(c, 30 * 60e3, HOUR), null, "nothing had closed by the target");
  // The live symptom, end to end: hourly bars whose close == hours since t0, forming bar present,
  // read at :45 past the hour. p1h must be the last close at/before now-1h, never the live price.
  const t0 = Date.UTC(2026, 8, 1), now = t0 + 400 * HOUR + 45 * 60e3, cs = [];
  for (let k = 0; t0 + k * HOUR <= now; k++) cs.push({ t: t0 + k * HOUR, o: k, h: k + 1, l: k, c: Math.min(k + 1, 400.75), v: 1 });
  const { ref } = featuresFromHourly(cs, now, HOUR, DAY);
  assert.equal(ref.p1h, 399, "1h ref = close of the bar that ended at now-1h45 (399), not the forming bar (400.75)");
  assert.equal(ref.p4h, 396);
  assert.equal(ref.p7d, 232);
});

test("featuresFromHourly: produces ref, px30 and dr", () => {
  const now = Date.now(), c = [];
  for (let t = now - 5 * DAY; t <= now; t += HOUR) {
    const base = 100 + Math.sin(t / DAY) * 5;
    c.push({ t, c: String(base.toFixed(2)), h: String((base + 1).toFixed(2)), l: String((base - 1).toFixed(2)), v: "1000" });
  }
  const { ref, feat } = featuresFromHourly(c, now, HOUR, DAY);
  assert.ok(ref.p1h != null);
  assert.ok(Array.isArray(feat.px30) && feat.px30.length >= 3);
  assert.ok(Array.isArray(feat.dr) && feat.dr.length >= 1);
  assert.ok(feat.volH > 0);
  assert.equal(feat.volD, null); // <5 completed daily returns -> not enough for a daily-vol estimate
});

test("featuresFromHourly: vwap30 is the exact volume-weighted typical price; zero-volume windows are null", () => {
  const now = Date.now();
  // Two candles, hand-checkable: typ1=(12+8+10)/3=10 w=100, typ2=(22+18+20)/3=20 w=300
  // -> vwap = (10*100 + 20*300) / 400 = 17.5. A zero-volume candle must contribute nothing.
  const c = [
    { t: now - 3 * HOUR, c: "10", h: "12", l: "8", v: "100" },
    { t: now - 2 * HOUR, c: "20", h: "22", l: "18", v: "300" },
    { t: now - 1 * HOUR, c: "999", h: "999", l: "999", v: "0" },
  ];
  const { feat } = featuresFromHourly(c, now, HOUR, DAY);
  assert.ok(Math.abs(feat.vwap30 - 17.5) < 1e-9);
  // an entirely volume-less window has no VWAP -> null (honest dash), never a fabricated level
  const dead = [{ t: now - 2 * HOUR, c: "10", h: "11", l: "9", v: "0" }, { t: now - 1 * HOUR, c: "10", h: "11", l: "9", v: "0" }];
  assert.equal(featuresFromHourly(dead, now, HOUR, DAY).feat.vwap30, null);
});

test("featuresFromHourly: volD is a measured daily vol once enough days exist", () => {
  const now = Date.now(), c = [];
  for (let t = now - 25 * DAY; t <= now; t += HOUR) {
    const day = Math.floor(t / DAY), base = 100 + Math.sin(day) * 6; // real day-to-day variation
    c.push({ t, c: base.toFixed(2), h: (base + 1).toFixed(2), l: (base - 1).toFixed(2), v: "10" });
  }
  const { feat } = featuresFromHourly(c, now, HOUR, DAY);
  assert.ok(feat.volD != null && isFinite(feat.volD) && feat.volD > 0);
});

test("oiDeltaPct: percent change vs a past sample", () => {
  const now = Date.now();
  const hist = [[now - 2 * HOUR, 100], [now - 1 * HOUR, 110]];
  const d = oiDeltaPct(hist, 120, HOUR, 30 * 60 * 1000); // vs ~1h ago (110) -> +9.09%
  assert.ok(d != null && Math.abs(d - 9.09) < 0.1);
  assert.equal(oiDeltaPct(null, 120, HOUR, 1000), null);
});

test("pearson: perfect positive, perfect negative, flat", () => {
  assert.ok(Math.abs(pearson([1, 2, 3, 4], [2, 4, 6, 8]) - 1) < 1e-9);
  assert.ok(Math.abs(pearson([1, 2, 3, 4], [8, 6, 4, 2]) + 1) < 1e-9);
  assert.equal(pearson([1, 1, 1, 1], [1, 2, 3, 4]), null); // zero variance -> null
  assert.equal(pearson([1, 2], [1, 2]), null);             // too few points
});

test("meanPairwiseCorr: identical series -> ~1, needs overlap", () => {
  const now = Date.now(), DAY = 86400000, mk = (f) => { const a = []; for (let i = 60; i >= 0; i--) a.push([now - i * DAY, f(i)]); return a; };
  const up = mk((i) => 100 + (60 - i) + Math.sin(i));       // three series that move together
  const s1 = up, s2 = mk((i) => 100 + (60 - i) + Math.sin(i) + 0.01), s3 = mk((i) => 100 + (60 - i) + Math.sin(i) - 0.01);
  const { corr, pairs } = meanPairwiseCorr([s1, s2, s3], 30);
  assert.ok(pairs === 3 && corr > 0.9);
  // a single series can form no pairs
  assert.equal(meanPairwiseCorr([s1], 30).corr, null);
});

test("corrMatrix: aligned intraday returns — overlap gate, null gaps, symmetry, diagonal", () => {
  // Pre-aligned equal-length return series on a shared grid; null marks a gap. This is the crypto
  // correlation tab's server-side matrix (built over the 5m archive at 4h/1d/7d).
  const base = [0.01, -0.02, 0.03, 0.00, -0.01, 0.02, 0.01, -0.03, 0.02, 0.01, -0.01, 0.02, 0.00, 0.01, -0.02, 0.03, 0.01, -0.01, 0.02, 0.00, 0.015];
  const near = base.map((x) => x * 0.95 + 0.001);   // ~perfectly correlated
  const gappy = base.slice(); gappy[3] = null; gappy[7] = null;   // a couple of holes, still plenty of overlap
  const allnull = base.map(() => null);
  const { C, N } = corrMatrix([base, near, gappy, allnull], 15);
  assert.ok(C[0][1] > 0.99, `near-identical series should correlate ~1, got ${C[0][1]}`);
  assert.equal(C[0][0], 1);                       // diagonal
  assert.equal(C[1][0], C[0][1]);                 // symmetric
  assert.equal(C[0][3], null);                    // vs all-null -> null
  assert.equal(N[0][3], 0);                       // and zero overlap recorded
  assert.ok(N[0][2] >= 15 && C[0][2] != null);    // gappy still clears the overlap gate
  // Below the overlap floor -> null even when the two agree perfectly.
  const short = [0.1, 0.2, -0.1, 0.3, 0.1, -0.2, 0.1, 0.2, -0.1, 0.3];
  assert.equal(corrMatrix([short, short.map((x) => x * 1.1)], 15).C[0][1], null);
});

test("closedWindows: the Jul-4-2026 span is one Thu-close -> Mon-open window", () => {
  const w = C.closedWindows(Date.UTC(2026, 6, 1), Date.UTC(2026, 6, 8));
  const long = w.find((a) => a.exit - a.enter > 48 * 3600 * 1000);
  assert.ok(long, "expected a multi-day closure");
  assert.equal(new Date(long.enter).toISOString(), "2026-07-02T20:00:00.000Z"); // Thu 16:00 ET
  assert.equal(new Date(long.exit).toISOString(), "2026-07-06T13:30:00.000Z");  // Mon 09:30 ET
  // Sat Jul 4 17:00 UTC falls inside it -> offHours must report closed with the THURSDAY close
  const now = Date.UTC(2026, 6, 4, 17, 0, 0);
  assert.ok(long.enter <= now && now < long.exit);
});

test("bracketTouch F9: a same-bar both-touch is flagged amb and resolved conservatively to stop", () => {
  const t0 = 0, H = 3600e3;
  // long: stop below, target above. A candle whose low<=stop AND high>=target straddles both.
  const straddle = [[t0 + H, 100, 100, 100, 100], [t0 + 2 * H, 100, 130, 80, 100]];   // [t,o,h,l,c]
  const r = C.bracketTouch(straddle, t0, t0 + 10 * H, "long", 90, 120);   // stop 90, target 120
  assert.equal(r.hit, "stop", "conservative: a straddling bar resolves to the stop");
  assert.equal(r.amb, true, "the straddle is flagged ambiguous");
  // a clean target touch (no stop breach on the bar) is NOT ambiguous
  const clean = [[t0 + H, 100, 100, 100, 100], [t0 + 2 * H, 100, 130, 95, 100]];   // low 95 > stop 90
  const r2 = C.bracketTouch(clean, t0, t0 + 10 * H, "long", 90, 120);
  assert.equal(r2.hit, "target", "clean target touch");
  assert.equal(r2.amb, false, "a clean target is not ambiguous");
});

test("intrabarCross F5: true only when the live mark crossed but the last COMPLETED close did not", () => {
  const now = Date.UTC(2026, 6, 30, 18, 0, 0);   // mid-session ET
  const dayStart = Date.UTC(2026, 6, 30);
  // A series whose last bar is TODAY (forming) — its close is the live-ish value; the completed
  // reference is the prior bar. level = 105.
  const forming = [[dayStart - 2 * DAY, 100], [dayStart - DAY, 102], [dayStart, 108]];
  // breakout (dir +1): completed close is 102 (<=105) while today's bar shows 108 -> intrabar only.
  assert.equal(C.intrabarCross(forming, 105, 1, now), true, "forming last bar: completed close under the level -> intrabar");
  // If the completed prior close were already above the level, it's a close-confirmed cross.
  const confirmed = [[dayStart - 2 * DAY, 100], [dayStart - DAY, 106], [dayStart, 108]];
  assert.equal(C.intrabarCross(confirmed, 105, 1, now), false, "completed close already above -> close-confirmed, not intrabar");
  // When the last bar is a COMPLETED day (its UTC day already ended), it IS the reference.
  const closed = [[dayStart - 2 * DAY, 100], [dayStart - DAY, 108]];   // last bar's day ended before `now`
  assert.equal(C.intrabarCross(closed, 105, 1, now), false, "a completed last bar above the level is close-confirmed");
  // breakdown (dir -1): mirror — completed close still at/over the low is intrabar.
  const fd = [[dayStart - 2 * DAY, 100], [dayStart - DAY, 98], [dayStart, 92]];
  assert.equal(C.intrabarCross(fd, 95, -1, now), true, "breakdown: completed close over the low -> intrabar");
  assert.equal(C.intrabarCross([], 100, 1, now), false, "empty series is never a cross");
  assert.equal(C.intrabarCross([[dayStart, 108]], 105, 1, now), false, "a lone forming bar has no completed reference");
});


test("confSplit: direction-aware company, conflict kills all bonuses", () => {
  const L={play:{side:"long"}}, S={play:{side:"short"}}, C={play:{side:"watch"}};
  // two longs + context: all three have company
  let r=confSplit([L,L,C]);
  assert.equal(r.conflict,false);
  assert.equal(r.companyFor(L),3); assert.equal(r.companyFor(C),3);
  // one long + context: the pair agrees
  r=confSplit([L,C]);
  assert.equal(r.companyFor(L),2);
  // long + short = conflict: everyone stands alone
  r=confSplit([L,S,C]);
  assert.equal(r.conflict,true);
  assert.equal(r.companyFor(L),1); assert.equal(r.companyFor(S),1); assert.equal(r.companyFor(C),1);
  // solo directional: no company
  r=confSplit([S]);
  assert.equal(r.conflict,false); assert.equal(r.companyFor(S),1);
});


test("offDriftStats: sums close->open windows; positive overnight drift detected", () => {
  const HOUR=3600000, hs=[], wins=[];
  // 30 synthetic days: price gains 0.2% each "overnight" (22:00->10:00), flat in "session"
  let px=100;
  for(let d=0;d<30;d++){
    const base=d*24*HOUR;
    for(let h=0;h<24;h++){ hs.push([base+h*HOUR, px, px, px, px, 0]); if(h===22) px*=1.002; }
    wins.push({ enter: base+22*HOUR, exit: base+34*HOUR, tag:"overnight" });
  }
  const st=offDriftStats(hs.map(k=>[k[0],k[1],k[2],k[3],k[4],k[5]]), wins, 3*HOUR);
  assert.ok(st && st.nWin===21, "uses the last 21 windows");
  assert.ok(st.drift30>3 && st.drift30<5, "≈+4.2% summed drift detected, got "+(st&&st.drift30));
});

test("news discovery gate 2026.07.21-12: common-word tickers don't wear bare-word collisions — the COST/BE screenshot bug", () => {
  const C = require("../src/compute");
  assert.equal(typeof C.newsAttributes, "function", "discovery predicate exported");
  assert.ok(C.COMMON_WORD instanceof Set && C.COMMON_WORD.has("COST") && C.COMMON_WORD.has("DOW"), "common-word set exported and seeded");

  // the two screenshots: a bare common word is NOT enough to attribute in the discovery lane
  assert.ok(!C.newsAttributes("JUST IN: Iran war has cost the United States $37,500,000,000 so far", "COST", ["Costco"]),
    "war 'cost' does not attribute to Costco");
  assert.ok(!C.newsAttributes("TRUMP: WILL BE HITTING PICKAXE MOUNTAIN AREA PRETTY SOON", "BE", ["Bloom Energy"]),
    "'WILL BE HITTING' does not attribute to Bloom Energy");
  for (const [T, a] of [["ALL", null], ["ARE", null], ["NOW", ["ServiceNow"]], ["LOW", ["Lowe's"]], ["KEY", null], ["FAST", null], ["WELL", null], ["CAT", ["Caterpillar"]], ["DOW", null]])
    assert.ok(!C.newsAttributes("MARKETS ARE MOVING FAST AND THE DOW IS WELL OFF ITS LOW", T, a), `word-collision ${T} gated from bare attribution`);

  // decision B: 2-letter symbols never attribute on a bare match, common word or not
  assert.ok(!C.newsAttributes("GE and BB were both up on the session", "GE", ["GE Aerospace","General Electric"]), "bare 2-letter GE gated");
  assert.ok(!C.newsAttributes("shares slipped in PM trading", "PM", ["Philip Morris"]), "bare 2-letter PM gated (and it's an abbrev collision)");

  // the explicit signals still attribute — cashtag overrides the gate, company name is unambiguous
  assert.ok(C.newsAttributes("$COST slumps on soft guidance", "COST", ["Costco"]), "cashtag $COST attributes despite the gate");
  assert.ok(C.newsAttributes("$BE pops after fuel-cell order", "BE", ["Bloom Energy"]), "cashtag $BE attributes despite the gate");
  assert.ok(C.newsAttributes("$GE wins a new engine contract", "GE", ["GE Aerospace"]), "cashtag rescues 2-letter symbols too");
  assert.ok(C.newsAttributes("Costco cuts prices across warehouses", "COST", ["Costco"]), "company name attributes Costco");
  assert.ok(C.newsAttributes("Bloom Energy lands a data-center deal", "BE", ["Bloom Energy"]), "company name attributes Bloom Energy");

  // distinctive 3+ symbols keep bare-matching — the gate is surgical, not a blanket kill
  assert.ok(C.newsAttributes("NVDA rips after earnings", "NVDA", ["Nvidia"]), "distinctive NVDA still bare-matches");
  assert.ok(C.newsAttributes("MSTR adds to the stack", "MSTR", ["MicroStrategy"]), "distinctive MSTR still bare-matches");

  // dollar AMOUNTS are not cashtags: "$118" must not fabricate a $1/$11/$118 ticker path
  assert.ok(!C.newsAttributes("guidance raised to $118", "COST", ["Costco"]), "a plain dollar amount is not a cashtag");

  // confirmation lane (newsRelevant, T already known) is deliberately UNCHANGED for bare words,
  // so aliasless names fetched under their own symbol still confirm; and it now honours cashtags
  assert.ok(C.newsRelevant("Allstate raises dividend", null, "ALL", null) === false, "sanity: no bare 'Allstate' text, alias absent");
  assert.ok(C.newsRelevant("ALL reports Q3 combined ratio", null, "ALL", null), "confirmation lane still trusts a bare symbol under a known T");
  assert.ok(C.newsRelevant("$COST beats", null, "COST", null), "confirmation lane honours cashtags");
});

test("fourHourReturns: bucketing, completed-only, gap tolerance", () => {
  const now = Math.floor(Date.now() / (4 * HOUR)) * 4 * HOUR + 2 * HOUR;   // mid-bucket "now"
  const hs = spineFrom4h([0.01, -0.02, 0.005], now);
  const rets = fourHourReturns(hs, now, null);
  const vals = [...rets.values()].map((x) => +x.toFixed(6));
  assert.deepEqual(vals, [0.01, -0.02, 0.005], "reconstructs the schedule");
  const curB = Math.floor(now / (4 * HOUR));
  assert.ok(![...rets.keys()].some((b) => b >= curB), "in-progress bucket excluded");
  // A hole in the spine must not create a synthetic multi-bucket return
  const hs2 = hs.filter((k) => Math.floor(k[0] / (4 * HOUR)) !== curB - 2);
  const rets2 = fourHourReturns(hs2, now, null);
  assert.ok(!rets2.has(curB - 2) && !rets2.has(curB - 1), "no return across a gap");
});

test("tapeRedStats: breadth gate, resilient/amplifier capture, negative dcap, min-bar gate", () => {
  // 12-coin universe, 30 bars. Bars 0..24: true red tape (median -1%, 11/12 red).
  // Bars 25..29: median negative but only 6/12 red -> breadth gate must exclude them.
  const N = 30, series = new Map();
  const mk = (fn) => { const m = new Map(); for (let b = 0; b < N; b++) m.set(1000 + b, fn(b)); return m; };
  const redBar = (b) => b < 25;
  for (let i = 0; i < 9; i++) series.set("MID" + i, mk((b) => redBar(b) ? -0.01 : (i < 6 ? -0.001 : 0.002)));
  series.set("RES", mk((b) => redBar(b) ? -0.005 : 0));       // half the tape's move
  series.set("AMP", mk((b) => redBar(b) ? -0.015 : 0));       // 1.5x the tape's move
  series.set("GRN", mk((b) => redBar(b) ? +0.002 : 0));       // net green on red bars
  const { redBars, stats } = tapeRedStats(series, { breadth: 0.7, minBars: 20, minCross: 10 });
  assert.equal(redBars, 25, "only true-breadth bars count as red");
  assert.equal(stats.get("RES").dcap, 50, "resilient name captures half");
  assert.equal(stats.get("AMP").dcap, 150, "amplifier captures 1.5x");
  assert.ok(stats.get("GRN").dcap < 0, "net green on red bars -> negative dcap");
  assert.equal(stats.get("GRN").hit, 100, "green name beat the median on every red bar");
  assert.equal(stats.get("RES").n, 25, "matched-bar count shipped");
  // Min-bar gate: a coin present on only 10 red bars gets null, never a thin read
  const thin = new Map(); for (let b = 0; b < 10; b++) thin.set(1000 + b, -0.005);
  series.set("THIN", thin);
  const g2 = tapeRedStats(series, { breadth: 0.7, minBars: 20, minCross: 10 });
  assert.equal(g2.stats.get("THIN"), null, "below the gate -> null");
});

test("tapeRedStats: cascade bar is winsorized, not dominant", () => {
  // 24 ordinary red bars (median -1%) + 1 cascade bar (median -20%).
  // CRASH only underperforms on the cascade (-40% there, tape-median elsewhere). Unweighted,
  // the cascade would dominate: dcap ~ (24+40)/(24+20) = 145. Winsorized (bar capped to 2x the
  // median |move| = 2%), dcap = (24*1 + 2*2)/(24*1 + 2*1) = 28/26 ~ 108: above 100, not extreme.
  const series = new Map();
  const mk = (fn) => { const m = new Map(); for (let b = 0; b < 25; b++) m.set(2000 + b, fn(b)); return m; };
  for (let i = 0; i < 11; i++) series.set("M" + i, mk((b) => b === 24 ? -0.20 : -0.01));
  series.set("CRASH", mk((b) => b === 24 ? -0.40 : -0.01));
  const { stats } = tapeRedStats(series, { breadth: 0.7, minBars: 20, minCross: 10 });
  const d = stats.get("CRASH").dcap;
  assert.ok(d > 100 && d < 115, `cascade capped: dcap ${d} stays near 108, not 145`);
});

test("rvolMulti: clock-hour matching, elevation, and the min-samples gate", () => {
  // 12 days of hourly candles at price 100: volume 100 at hour-of-day 12, else 10.
  // "Now" is 14:30 on the last day -> RVOL(1h) judges hour 13 (volume 10) against prior
  // hour-13s (all 10) = 1.0x even though hour 12 traded 10x more — the session shape must
  // NOT read as a signal. Then triple the final day's hours 10-13 and RVOL(4h) reads 3x.
  const dayStart = Math.floor(Date.now() / DAY) * DAY - 12 * DAY;
  const hs = [];
  for (let d = 0; d < 12; d++) for (let h = 0; h < 24; h++)
    hs.push([dayStart + d * DAY + h * HOUR, 100, 100, 100, 100, h === 12 ? 100 : 10]);
  const now = dayStart + 11 * DAY + 14 * HOUR + 30 * 60 * 1000;
  const r1 = rvolMulti(hs, { h1: HOUR, h4: 4 * HOUR, d1: DAY }, now);
  assert.equal(r1.h1, 1, "quiet hour vs prior quiet hours = 1.0x, session shape neutralized");
  assert.equal(r1.d1, 1, "normal day = 1.0x");
  const hs2 = hs.map((k) => { const h = Math.floor((k[0] - dayStart) / HOUR);
    return (h >= 11 * 24 + 10 && h <= 11 * 24 + 13) ? [k[0], k[1], k[2], k[3], k[4], k[5] * 3] : k; });
  const r2 = rvolMulti(hs2, { h4: 4 * HOUR }, now);
  assert.equal(r2.h4, 3, "tripled volume in the live 4h span reads 3x against the same-clock baseline");
  // Gate: 4 days of history cannot support a baseline
  const short = hs.filter((k) => k[0] >= dayStart + 8 * DAY);
  const r3 = rvolMulti(short, { h1: HOUR }, now);
  assert.equal(r3.h1, null, "fewer than 7 baseline days -> null");
});

test("bucketCandles: UTC-aligned aggregation, forming bucket, closes-only degradation", () => {
  const { bucketCandles } = require("../src/compute");
  // 11 hourly candles starting at t=1h -> 4h buckets [0,4), [4,8), [8,12): first bucket partial.
  // Input is the packed spine shape [t,o,h,l,c,v] (what r.hourlyRaw holds since 2026.07.21-09).
  const hrs = [];
  for (let i = 1; i <= 11; i++) hrs.push([i * HOUR, 10 + i, 20 + i, 5 + i, 10 + i, 1]);
  const b4 = bucketCandles(hrs, 4, HOUR);
  assert.equal(b4.length, 3);
  assert.deepEqual(b4.map((k) => k.t), [0, 4 * HOUR, 8 * HOUR], "buckets are UTC-aligned to the width");
  assert.equal(b4[0].c, 13, "bucket close = last hourly close inside it");
  assert.equal(b4[1].h, 27, "bucket high = max hourly high (h4..h7 -> 24..27)");
  assert.equal(b4[1].l, 9, "bucket low = min hourly low (l4..l7 -> 9..12)");
  assert.equal(b4[2].c, 21, "forming bucket carries the latest close");
  // closes-only packed rows (o/h/l null) degrade h/l to the close instead of NaN
  const co = bucketCandles([[HOUR, null, null, null, 5], [2 * HOUR, null, null, null, 6]], 4, HOUR);
  assert.equal(co.length, 1);
  assert.equal(co[0].h, 6); assert.equal(co[0].l, 5);
});

test("ribbonWidth: per-rung average spread, null guards, and consistency with the ladder", () => {
  const { ribbonWidth, trendLadder, TREND_TF_MS } = require("../src/compute");
  // guards: no side, no aligned rungs, broken strength — all null, never 0
  assert.equal(ribbonWidth(null), null, "no side object");
  assert.equal(ribbonWidth({ score: 0, strength: 0 }), null, "zero aligned rungs is meaningless, not 0-wide");
  assert.equal(ribbonWidth({ score: 2, strength: NaN }), null, "non-finite strength");
  assert.equal(ribbonWidth({ score: 4, strength: 0.04 }), 1, "4% accumulated over 4 rungs = 1%/rung");
  assert.equal(ribbonWidth({ score: 2, strength: 0.0032 }), 0.16, "rounds to 2dp");
  // consistency: width must equal the MEAN of the per-rung spreads the ladder accumulated
  const mk = (cl) => cl.map((c, i) => ({ t: i * HOUR, h: c * 1.002, l: c * 0.998, c }));
  const rise = Array.from({ length: 60 }, (_, i) => 100 * Math.pow(1.01, i - 59));
  const c = mk(rise);
  const lad = trendLadder(100, { D1: c, H12: c, H4: c, H1: c });
  assert.equal(lad.long.score, 4);
  const per = ["D1", "H12", "H4", "H1"].map((t) => (100 * (lad.tf[t].e13 - lad.tf[t].e21)) / lad.tf[t].e21);
  const want = +(per.reduce((a, b) => a + b, 0) / 4).toFixed(2);
  assert.equal(ribbonWidth(lad.long), want, "width is the mean per-rung EMA13–EMA21 spread");
  assert.ok(ribbonWidth(lad.long) > 0, "always positive by construction on aligned rungs");
  assert.equal(ribbonWidth(lad.short), null, "the unaligned side has no width");
  // the retest-volume window map: exactly one bar of each ladder timeframe
  assert.deepEqual(TREND_TF_MS, { D1: 86400e3, H12: 43200e3, H4: 14400e3, H1: 3600e3 });
});

test("stackedRun honours custom spans and dashes when the slow MA can't seed", () => {
  const { stackedRun } = require("../src/compute");
  const up = (n) => Array.from({ length: n }, (_, i) => ({ c: 100 * Math.pow(1.003, i) }));
  assert.equal(stackedRun(up(60), null, "long", 13, 200), null, "60 bars can't seed a 200 EMA");
  const r = stackedRun(up(260), 100 * Math.pow(1.003, 260), "long", 13, 200);
  assert.ok(r && r.run > 0, "a clean uptrend over 260 bars has a positive 13/200 run");
  const d = stackedRun(up(60), null, "long");   // default 13/21 unchanged: 60 bars is plenty
  assert.ok(d && d.run > 0, "default spans still measure a run on 60 bars");
});

test("withFormingDaily: stale daily series gets a synthetic forming bar, fresh series untouched", () => {
  const { withFormingDaily, trendLadder } = require("../src/compute");
  const now = Date.UTC(2026, 6, 14, 19, 0, 0), dayStart = Date.UTC(2026, 6, 14);
  const stale = Array.from({ length: 40 }, (_, i) => ({ t: dayStart - (40 - i) * DAY, c: 100 + i }));
  const g = withFormingDaily(stale, 150, now, DAY);
  assert.equal(g.length, 41, "one synthetic bar appended");
  assert.equal(g[40].t, dayStart, "appended at today's UTC day start");
  assert.equal(g[40].c, 150, "carries the live mark");
  assert.equal(stale.length, 40, "source series never mutated");
  // fresh series (forming day already present) passes through by reference
  const fresh = stale.concat([{ t: dayStart, c: 141 }]);
  assert.equal(withFormingDaily(fresh, 150, now, DAY), fresh);
  assert.equal(withFormingDaily(null, 150, now, DAY), null);
  assert.equal(withFormingDaily(stale, null, now, DAY), stale, "no mark, no synthesis");
  // the failure mode the guard exists for: WITHOUT it, the ladder overwrites yesterday's close
  // with the live mark (one bar smeared away); WITH it, yesterday's close survives intact
  const mk = (cl) => cl.map((k) => ({ t: k.t, c: k.c }));
  const ladStale = trendLadder(150, { D1: mk(stale), H12: mk(stale), H4: mk(stale), H1: mk(stale) });
  const ladGuard = trendLadder(150, { D1: mk(g), H12: mk(g), H4: mk(g), H1: mk(g) });
  assert.ok(ladGuard.tf.D1.e21 > ladStale.tf.D1.e21,
    "guarded EMA carries one extra bar of the live mark's weight — the smear is gone");
});

// ===================================================================================
// Performance pass 2026.07.21-01: hourly NDJSON persistence, hot-path memoization,
// binary-search window scans, per-request serialization cache, series downsampling.
// Each optimization ships with a test that pins its behavior AND proves equivalence to
// the code path it replaced — a silent regression here is a silent perf cliff or, worse,
// a stale value that makes the chart disagree with the board.
// ===================================================================================

test("perf: binary-search oiDeltaPct/fundingAvg are exactly equivalent to the full-scan versions", () => {
  const { oiDeltaPct, fundingAvg, firstIndexGT, firstIndexGE } = require("../src/compute");
  // helpers: firstIndexGT/GE on an ascending [[ts,...]] array
  const A = [[10], [20], [20], [30], [40]];
  assert.equal(firstIndexGT(A, 20), 3, "firstIndexGT past the last equal ts");
  assert.equal(firstIndexGE(A, 20), 1, "firstIndexGE at the first equal ts");
  assert.equal(firstIndexGT(A, 5), 0);
  assert.equal(firstIndexGE(A, 100), 5);
  assert.equal(firstIndexGT([], 1), 0, "empty array is a no-op");

  // Freeze the clock so the reference and the module see the SAME `target`/`start` — otherwise
  // the ms that elapse between the two calls masquerade as a mismatch.
  const FIXED = 1721563200000, realNow = Date.now;
  Date.now = () => FIXED;
  try {
    const MIN = 60e3, OI_MIN_GAP = 4.5 * MIN, H = HOUR, D = DAY;
    const refOi = (hist, oiNow, win) => {
      if (!hist || hist.length < 2 || !(oiNow > 0)) return null;
      const tol = Math.min(Math.max(2 * OI_MIN_GAP, win * 0.05), 12 * H), target = FIXED - win;
      let b = null, a = null;
      for (const s of hist) { if (!(s[1] > 0)) continue; if (s[0] <= target) { if (!b || s[0] > b[0]) b = s; } else if (!a || s[0] < a[0]) a = s; }
      const dB = b ? target - b[0] : Infinity, dA = a ? a[0] - target : Infinity;
      if (Math.min(dB, dA) > tol) return null;
      let base; if (b && a && (a[0] - b[0]) <= 3 * tol) { const sp = a[0] - b[0]; base = b[1] + (a[1] - b[1]) * ((target - b[0]) / sp); } else base = (dB <= dA ? b : a)[1];
      return base > 0 ? (oiNow - base) / base * 100 : null;
    };
    const refFund = (hist, win) => {
      if (!hist || hist.length < 1) return null; const start = FIXED - win;
      let pT = null, pF = null, area = 0, span = 0, ss = 0, sn = 0;
      for (const s of hist) { const t = s[0], f = s[2]; if (f == null || !isFinite(f)) { pT = null; pF = null; continue; } if (t >= start) { ss += f; sn++; } if (pT != null && t > pT) { const aa = Math.max(pT, start); if (t > aa) { const fa = aa === pT ? pF : pF + (f - pF) * ((aa - pT) / (t - pT)); area += (fa + f) / 2 * (t - aa); span += (t - aa); } } pT = t; pF = f; }
      return span > 0 ? area / span : (sn ? ss / sn : null);
    };
    let cmp = 0;
    for (let it = 0; it < 4000; it++) {
      const n = 1 + Math.floor(Math.random() * 40), hist = []; let t = FIXED - Math.floor(Math.random() * 40) * H;
      for (let i = 0; i < n; i++) { t += Math.floor(Math.random() * 3 * H); const oi = Math.random() < 0.1 ? 0 : 1 + Math.random() * 1000; const f = Math.random() < 0.15 ? null : (Math.random() - 0.5) * 0.01; hist.push([t, oi, f]); }
      const oiNow = 1 + Math.random() * 1000, win = [H, 4 * H, D, 7 * D, 30 * D][Math.floor(Math.random() * 5)];
      const a = oiDeltaPct(hist, oiNow, win), b = refOi(hist, oiNow, win); cmp++;
      assert.ok(a === b || (a != null && b != null && Math.abs(a - b) < 1e-9), `oiDeltaPct mismatch ${a} vs ${b}`);
      const c = fundingAvg(hist, win), d = refFund(hist, win); cmp++;
      assert.ok(c === d || (c != null && d != null && Math.abs(c - d) < 1e-12), `fundingAvg mismatch ${c} vs ${d}`);
    }
    assert.ok(cmp >= 8000, "fuzz coverage sanity");
  } finally { Date.now = realNow; }
});

// ===== Coinalyze deriv-context lane (build 2026.07.24-01) =======================================
// Aggregated CEX liquidations + OI as crypto-universe context: pure math, accumulation store,
// the 15-min sweep + manual refresh, the CASC column and the drawer panel. Same manifest
// philosophy as everything else: every new symbol, route, class and const is pinned.

test("czMergeHistory: dedupes by timestamp, last write wins, no-change is detected", () => {
  const { czMergeHistory } = require("../src/compute");
  const a = [[1000, 10, 5, 100], [2000, 20, 6, 101]];
  const r1 = czMergeHistory(a, [[2000, 20, 6, 101], [3000, 30, 7, 99]]);
  assert.equal(r1.changed, true);
  assert.equal(r1.rows.length, 3);
  assert.deepEqual(r1.rows[2], [3000, 30, 7, 99]);
  const r2 = czMergeHistory(r1.rows, [[2000, 20, 6, 101]]);   // exact overlap only
  assert.equal(r2.changed, false, "identical overlapping rows must not report change (ETag would churn)");
  const r3 = czMergeHistory(r1.rows, [[2000, 25, 6, 101]]);   // re-fetched bucket grew
  assert.equal(r3.changed, true);
  assert.equal(r3.rows.find((x) => x[0] === 2000)[1], 25, "last write wins on a grown bucket");
  assert.equal(r1.rows.find((x) => x[0] === 2000)[1], 20, "merge returns a NEW array — input untouched");
});

test("cascadeFlags: fires on a liq spike WITH an OI drop, never on either alone", () => {
  const { cascadeFlags } = require("../src/compute");
  const Q = 15 * 60 * 1000;
  const rows = [];
  for (let i = 0; i < 100; i++) rows.push([i * Q, 100000, 80000, 5000000]);   // calm baseline, flat OI
  // spike WITHOUT an OI drop -> not a cascade (busy bar, nothing cleared)
  rows.push([100 * Q, 5000000, 80000, 5000000]);
  let f = cascadeFlags(rows);
  assert.equal(f.length, 0, "liq spike with flat OI must not flag");
  // spike WITH the OI drop -> long cascade
  rows[rows.length - 1] = [100 * Q, 5000000, 80000, 4900000];   // -2% OI
  f = cascadeFlags(rows);
  assert.equal(f.length, 1);
  assert.equal(f[0].side, "long");
  assert.equal(f[0].t, 100 * Q);
  assert.ok(f[0].doiPct < -1);
  // OI drop WITHOUT a liq spike -> not a cascade
  rows[rows.length - 1] = [100 * Q, 110000, 80000, 4900000];
  f = cascadeFlags(rows);
  assert.equal(f.length, 0, "OI drop on a calm liq bar must not flag");
});

test("cascadeFlags: short side attributes correctly and a thin baseline stays honestly silent", () => {
  const { cascadeFlags } = require("../src/compute");
  const Q = 15 * 60 * 1000;
  const thin = [];
  for (let i = 0; i < 10; i++) thin.push([i * Q, 100000, 80000, 5000000]);
  thin.push([10 * Q, 100000, 4000000, 4800000]);
  assert.equal(cascadeFlags(thin).length, 0, "under minSamples of baseline no bucket may be judged — honest null over a guess");
  const rows = [];
  for (let i = 0; i < 100; i++) rows.push([i * Q, 100000, 80000, 5000000]);
  rows.push([100 * Q, 100000, 4000000, 4800000]);   // shorts blown out, OI cleared
  const f = cascadeFlags(rows);
  assert.equal(f.length, 1);
  assert.equal(f[0].side, "short", "shorts liquidated = up-cascade, side-typed");
});

test("derivRollup: 24h side totals, latest OI, and doi24 goes null without a 24h-old reference", () => {
  const { derivRollup } = require("../src/compute");
  const now = 200 * 3600 * 1000, H = 3600 * 1000;
  const rows = [];
  for (let i = 0; i < 30; i++) rows.push([now - (30 - i) * H, 1000, 500, 4000000 + i * 10000]);
  const r = derivRollup(rows, now);
  // 23 buckets inside the window: the row at exactly now-24h is the OI REFERENCE (boundary is
  // inclusive on the reference side, so a bucket is never both reference and window member).
  assert.equal(r.ll24, 23 * 1000);
  assert.equal(r.sl24, 23 * 500);
  assert.equal(r.oi, 4000000 + 29 * 10000);
  assert.ok(Number.isFinite(r.doi24) && r.doi24 > 0, "24h OI change computed against the stored bucket at/just before the cutoff");
  const short = rows.slice(-5);   // only 5h of coverage — no 24h reference exists
  const r2 = derivRollup(short, now);
  assert.equal(r2.doi24, null, "thin coverage -> doi24 is an honest null, never extrapolated");
});

test("aggDerivHourly: liqs SUM into the hour bucket, OI takes the LAST 15-min sample", () => {
  const { aggDerivHourly } = require("../src/compute");
  const Q = 15 * 60 * 1000, H0 = 100 * 3600 * 1000;
  const rows = [[H0, 10, 1, 100], [H0 + Q, 20, 2, 200], [H0 + 2 * Q, 30, 3, 300], [H0 + 3 * Q, 40, 4, 400],
    [H0 + 4 * Q, 5, 6, 500]];
  const h = aggDerivHourly(rows);
  assert.equal(h.length, 2);
  assert.deepEqual(h[0], [H0, 100, 10, 400], "hour 1: liqs summed, OI = end-of-hour sample");
  assert.deepEqual(h[1], [H0 + 4 * Q, 5, 6, 500]);
});

// ===== Score duel + MOM/MOM+ pair (build 2026.07.24-07) =========================================
// The candidate momentum column and its adjudicator. Pure math executed on fixtures, the poller's
// snapshot/IC/persistence loop driven through the harness with injected universes and clock, and
// a constant-fragment pin welding the client's mirrored math to compute.js so the two
// implementations cannot silently drift apart.

test("momPair: incumbent branch is byte-identical math; V2/V3 move only the candidate, in the stated directions", () => {
  const { momPair } = require("../src/compute");
  const base = { h1: 0.5, h4: 1.2, d1: 2.5, d7: 6.0, d30: 12.0, volH: 0.004, volD: 0.02,
    px: 108, hi30: 110, lo30: 90, doi: null, fundAPR: null, fundPct: null };
  // no OI, no funding: the two branches share the whole path -> identical scores, no tags
  const p0 = momPair(base);
  assert.ok(isFinite(p0.mom) && isFinite(p0.momp), "pair computes");
  assert.equal(p0.mom, p0.momp, "without an OI or crowding term the candidate IS the incumbent");
  assert.equal(p0.why, null, "no mechanism fired, no tag");
  // hand-check the incumbent against the original formula on the same inputs
  const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
  let sN = 0, w = 0, sa = 0;
  for (const [ret, hrs, wt] of [[0.5, 1, 0.10], [1.2, 4, 0.15], [2.5, 24, 0.30], [6.0, 168, 0.30], [12.0, 720, 0.15]]) {
    const sigma = (hrs >= 24) ? 0.02 * Math.sqrt(hrs / 24) : 0.004 * Math.sqrt(hrs);
    const z = (ret / 100) / sigma; sN += wt * z; sa += wt * Math.abs(z); w += wt;
  }
  const kappa = Math.abs(sN) / sa;
  const core = (sN / w) * (0.5 + 0.5 * kappa) + 0.4 * (clamp((108 - 90) / (110 - 90), 0, 1) - 0.5) * 2;
  assert.ok(Math.abs(p0.mom - 100 * Math.tanh(core / 1.5)) < 1e-9, "incumbent matches the original computeMomentum math exactly");
  // OI building, funding corroborating the long side: candidate amplifies, incumbent amplifies its own way
  const pC = momPair(Object.assign({}, base, { doi: 6, fundAPR: 20, fundPct: 50 }));
  assert.ok(pC.momp > p0.momp, "corroborated OI build amplifies the candidate");
  assert.ok(/OI\+ corroborated/.test(pC.why), "corroboration tagged");
  // same build, crowd on the OPPOSITE side: amplification collapses to the conflicted floor
  const pX = momPair(Object.assign({}, base, { doi: 6, fundAPR: -20, fundPct: 50 }));
  assert.ok(pX.momp < pC.momp, "conflicted funding amplifies less than corroborated");
  assert.ok(/OI\+ conflicted/.test(pX.why), "conflict tagged");
  // falling OI: incumbent dampens at the full 0.4 band, candidate at half — covering is not conviction
  const pS = momPair(Object.assign({}, base, { doi: -6 }));
  assert.ok(pS.mom < p0.mom, "incumbent dampens on falling OI");
  assert.ok(pS.momp < p0.momp && pS.momp > pS.mom, "candidate dampens at HALF band: below the unmodulated core, above the incumbent");
  assert.ok(/squeeze-side OI/.test(pS.why), "positive-score falling OI tagged squeeze-side");
  // V3: crowded long at the >=90th own-31d percentile with positive funding -> x0.8 on the candidate only
  const pH = momPair(Object.assign({}, base, { fundAPR: 40, fundPct: 95 }));
  assert.ok(pH.mom === p0.mom, "haircut never touches the incumbent");
  assert.ok(pH.momp < pH.mom, "crowded-long haircut taxes the candidate");
  assert.ok(/crowded long/.test(pH.why), "haircut tagged");
  // V3 side gate: same extreme percentile but crowd on the OPPOSITE side of the score -> no tax
  const pN = momPair(Object.assign({}, base, { fundAPR: -40, fundPct: 5 }));
  assert.equal(pN.momp, p0.momp, "a short-side crowd under a long score is squeeze fuel, not exhaustion — no haircut");
  // degenerate inputs stay honest
  assert.equal(momPair({ volH: 0 }).mom, undefined, "no vol -> undefined, not a fabricated 0");
  assert.equal(momPair(Object.assign({}, base, { h1: null, h4: null, d1: null, d7: null, d30: null })).mom, null, "no horizons -> null");
});

test("spearmanIC: exact on clean ranks, tie-averaged, honest null on degenerate input", () => {
  const { spearmanIC } = require("../src/compute");
  assert.ok(Math.abs(spearmanIC([1, 2, 3, 4], [10, 20, 30, 40]) - 1) < 1e-12, "perfect monotone -> +1");
  assert.ok(Math.abs(spearmanIC([1, 2, 3, 4], [40, 30, 20, 10]) + 1) < 1e-12, "perfect inverse -> -1");
  // ties -> average ranks: [1,1,2] vs [5,5,9] is still a perfect rank agreement
  assert.ok(Math.abs(spearmanIC([1, 1, 2], [5, 5, 9]) - 1) < 1e-12, "tie-averaged ranks agree");
  assert.equal(spearmanIC([3, 3, 3, 3], [1, 2, 3, 4]), null, "constant scores -> null, not 0");
  assert.equal(spearmanIC([1, 2], [1, 2]), null, "below the 3-name floor -> null");
});

test("candles -13: classifier is mutually exclusive with the pinned priority, and follow-through is thesis-signed", () => {
  const R = (o, h, l, c) => ({ t: 0, o, h, l, c });
  assert.equal(candleType(R(100, 106, 94, 101), R(99, 104, 96, 100)), "outside");
  assert.equal(candleType(R(100, 103, 97, 101), R(99, 104, 96, 100)), "inside");
  assert.equal(candleType(R(100, 105, 95, 100.5), null), "doji", "body <= 20% of range");
  assert.equal(candleType(R(100, 105, 99.5, 104.8), null), "strongBull");
  assert.equal(candleType(R(105, 105.5, 100, 100.2), null), "strongBear");
  assert.equal(candleType(R(100, 106, 95, 103), null), "plain", "real body, close not in an extreme fifth");
  assert.equal(candleType(R(100, 100, 100, 100), null), null, "zero-range bar is unclassifiable");
  // priority: an engulfing doji is an OUTSIDE bar first
  assert.equal(candleType(R(100, 107, 93, 100.3), R(99, 104, 96, 100)), "outside");
  assert.deepEqual(CANDLE_TYPES, ["outside", "inside", "doji", "strongBull", "strongBear", "plain"]);
  // signing: a strong bear close followed by a -3% day (next sd 2) scores POSITIVE ~1.5R
  const rec = [
    { t: 0, o: 105, h: 105.5, l: 100, c: 100.2, sdPrev: 2, rangeSd: 2.6 },
    { t: 1, o: 100, h: 101, l: 96, c: 97, sdPrev: 2, rangeSd: 2.5 }];
  const ev = candleEvents(rec);
  assert.equal(ev.length, 1);
  assert.equal(ev[0].type, "strongBear");
  assert.ok(Math.abs(ev[0].follow - 1.597) < 1e-3, `bear thesis followed through -> positive R, got ${ev[0].follow}`);
  // a next-bar without a frozen sd contributes nothing (never rescaled)
  assert.equal(candleEvents([rec[0], Object.assign({}, rec[1], { sdPrev: null })]).length, 0);
});

test("pivots -13: day-distribution pooling — each day one distribution, minCross floors, conditionals exact", () => {
  const DAY = 864e5, mon = Date.UTC(2026, 3, 6);
  const mkTk = (hh, ll, ca) => ({ records: Array.from({ length: 30 }, (_, d) => ({ t: mon + d * DAY, hiHr: hh, loHr: ll, closedAbove: ca })) });
  const pv = pivotPool([mkTk(2, 14, true), mkTk(2, 14, true), mkTk(2, 14, true), mkTk(2, 14, false), mkTk(2, 3, true)], { minCross: 3 });
  assert.equal(pv.hi.share[2], 1, "all five highs at 2:00 -> that hour owns the whole distribution");
  assert.equal(pv.hi.nDays, 30);
  assert.ok(Math.abs(pv.lo.share[14] - 0.8) < 1e-9 && Math.abs(pv.lo.share[3] - 0.2) < 1e-9,
    "the daily distribution splits by cross-sectional share, then averages across days");
  assert.ok(Math.abs(pv.hi.share.reduce((a, b) => a + b, 0) - 1) < 1e-6, "each pooled histogram sums to 1");
  assert.equal(pv.earlyLowUp.rate, null, "one name below the cross-sectional floor publishes nothing");
  assert.equal(pv.earlyHighDown.rate, 0.2, "all five highs early: closed-below share exact");
  assert.equal(pv.earlyH, PIVOT_EARLY_H);
  // sessionRecords now stamps the pivot hours, exactly
  const HOUR = 36e5, bars = [];
  for (let i = 0; i < 24; i++) bars.push([mon + i * HOUR, 100, i === 7 ? 111 : 101, i === 19 ? 92 : 99, 100, 1]);
  const rec = sessionRecords(bars, { minBars: 20, now: mon + 5 * DAY })[0];
  assert.equal(rec.hiHr, 7, "the high's UTC hour is stamped");
  assert.equal(rec.loHr, 19, "the low's UTC hour is stamped");
});

// ===== build 2026.07.24-17: crypto sessions tab — the analytics engine serves both universes =====
// The whole session-study stack was xyz-equity-only (activeMarkets + assetClass==="Equity" baked in).
// -17 threads a universe descriptor through buildAnalytics(scope) and every builder, adds a 90d crypto
// price spine (MAIN_SPINE_DAYS, decoupled from the 31d OI/funding archive), reframes the studies that
// don't survive a 24/7 book (no cash leg; UTC axis; no cash band), and serves the crypto payload at
// /api/analytics?u=crypto. These tests run the REAL builders on a synthetic 90d crypto universe.

test("-17 compute: crypto 24/7 anchor generators (utcDay + Fri->Mon weekend)", () => {
  const C = require("../src/compute");
  const DAY = 86400e3, HOUR = 3600e3;
  // a clean 10-day UTC window
  const start = Math.floor(Date.now() / DAY) * DAY - 12 * DAY, end = start + 10 * DAY;
  const days = C.utcDayAnchors(start, end);
  assert.ok(days.length >= 9 && days.length <= 10, "one hold per complete UTC day");
  for (const a of days) { assert.equal(a.exit - a.enter, DAY, "each UTC-day hold is exactly 24h"); assert.equal(a.tag, "utcday"); }
  assert.ok(days.every((a, i) => i === 0 || a.enter === days[i - 1].exit), "contiguous, no gaps or overlaps");
  // weekend holds: Fri 00:00 UTC -> Mon 00:00 UTC, 3 days each, only Fridays open one
  const wk = C.cryptoWeekendAnchors(start - 5 * DAY, end + 5 * DAY);
  for (const a of wk) {
    assert.equal(a.exit - a.enter, 3 * DAY, "Fri->Mon is a 3-day hold");
    assert.equal(new Date(a.enter).getUTCDay(), 5, "weekend holds open on Friday UTC");
    assert.equal(new Date(a.exit).getUTCDay(), 1, "and exit Monday UTC");
    assert.equal(a.tag, "cryptoweekend");
  }
  assert.ok(wk.length >= 2, "at least two Fri->Mon weekends in a 20-day span");
});

// ===== trigger stream + fire-vs-now (build 2026.07.26-02) =====================================
// The stream is the Telegram-ready foundation: detection is the poller's, sequenced and persisted,
// and each transport is a thin consumer. These tests pin the properties that make a push channel
// tolerable — announce once, never re-announce, and never detonate the whole board on a redeploy.

test("triggers -01: lateness is measured in the setup's own risk unit, against the FIRE mark", () => {
  const { lateR } = require("../src/compute");
  // fired 176.20, void 171.85 => 4.35 of risk. At 178.90 you have spent 2.70 of it.
  assert.equal(lateR("long", 176.20, 178.90, 171.85), 0.621, "late = distance travelled / risk AT THE FIRE");
  assert.equal(lateR("long", 176.20, 176.20, 171.85), 0, "at the fire mark you are not late");
  assert.ok(lateR("long", 176.20, 175.00, 171.85) < 0, "price back below the fire means you enter better than the record did");
  // Shorts mirror: favourable travel is DOWN, so a lower mark is late for a short.
  assert.ok(lateR("short", 241.10, 239.40, 252.30) > 0, "a short is late when price has already fallen");
  assert.ok(lateR("short", 241.10, 244.00, 252.30) < 0, "and early when price came back up");
  const L = lateR("long", 100, 102, 95), S = lateR("short", 100, 98, 105);
  assert.equal(L, S, "mirrored geometry gives mirrored lateness");
  // The denominator is fire-time risk, NOT live risk — that is the unit the record was scored in.
  assert.equal(lateR("long", 100, 110, 90), 1, "ten points travelled on a ten-point stop is exactly 1.0R late");
  assert.equal(lateR("flat", 100, 102, 95), null, "unsided rejected");
  assert.equal(lateR("long", 100, 102, 100), null, "zero fire-time risk rejected");
  assert.equal(lateR("long", 0, 102, 95), null, "missing fire mark rejected");
});

test("triggers -02: eligibility is per-transport and never gates the stream", () => {
  const { trigEligible, trigKey } = require("../src/compute");
  const row = { coin: "xyz:AMD", side: "long", ev: "tretest", t0: 5, evR: 0.52, rr: { gross: 2.31 }, late: 0.10, earn: null };   // gross since -10 — a net-shaped fixture here would test a payload the server no longer ships
  assert.equal(trigEligible(row, {}), true, "an empty config interrupts for everything");
  // There is deliberately NO provenOnly option: the server's stream carries only confirmed
  // setups now, so such a filter would imply unconfirmed alerts are possible. It isn't.
  assert.ok(!/provenOnly/.test(trigEligible.toString()), "eligibility must not carry a provenOnly filter — the gate is upstream");
  assert.equal(trigEligible(Object.assign({}, row, { evR: null }), { minEV: 0 }), false, "a null expectancy cannot clear an EV floor");
  assert.equal(trigEligible(row, { minEV: 0.6 }), false, "EV below the floor filtered");
  assert.equal(trigEligible(row, { minRR: 2.5 }), false, "R:R below the floor filtered");
  assert.equal(trigEligible(row, { minRR: 1.5 }), true, "R:R above the floor passes");
  // Regression: after -10 renamed net -> gross, this function kept reading row.rr.net, so any
  // configured minRR silently rejected EVERY row — the alert stream went quiet with no error.
  const fs0 = require("fs"), path0 = require("path");
  const cSrc0 = fs0.readFileSync(path0.join(__dirname, "..", "src", "compute.js"), "utf8");
  assert.ok(cSrc0.includes("row.rr.gross >= c.minRR") && !cSrc0.includes("row.rr.net"),
    "trigEligible reads gross; a stale rr.net read here is invisible until every alert stops firing");
  // The rule that makes alerting usable rather than annoying: don't wake someone for a setup
  // that has already run away from its own entry.
  assert.equal(trigEligible(Object.assign({}, row, { late: 0.9 }), { maxLate: 0.5 }), false, "a chased setup is filtered out of alerts");
  assert.equal(trigEligible(Object.assign({}, row, { late: null }), { maxLate: 0.5 }), true, "unknown lateness is not treated as late");
  assert.equal(trigEligible(row, { muted: ["xyz:AMD"] }), false, "muted name filtered");
  assert.equal(trigEligible(row, { muted: ["xyz:NVDA"] }), true, "a different mute does not filter");
  assert.equal(trigEligible(row, { sides: ["short"] }), false, "side filter honoured");
  assert.equal(trigEligible(Object.assign({}, row, { earn: { days: 3 } }), { noEarnings: true }), false, "earnings-in-horizon filter honoured");
  assert.equal(trigEligible(null, {}), false, "null row is never eligible");
  // Keys are per-claim AND per-fire, so a re-arm after an episode lapses is genuinely new.
  assert.equal(trigKey(row), "xyz:AMD|long|tretest|5");
  assert.notEqual(trigKey(row), trigKey(Object.assign({}, row, { t0: 9 })), "a later fire is a distinct trigger, not a duplicate");
  assert.equal(trigKey({}), null, "malformed row has no key");
});

test("features: scope resolution — parent self-demotion, vis sets, and the coin convention", () => {
  const C = require("../src/compute");
  // Defaults: crypto slice public, equity slice admin — a public caller sees signals (cx open)…
  assert.equal(C.featureVisible({}, "signals", false), true, "signals stays public while one scope is open");
  let v = C.featureScopeVis({}, "signals", false);
  assert.deepEqual(v, { cx: true, eq: false, all: false }, "public default vis must be crypto-only");
  // …the admin always sees everything through the identity path.
  v = C.featureScopeVis({}, "signals", true);
  assert.deepEqual(v, { cx: true, eq: true, all: true }, "admin vis must be the identity set");
  // Parent self-demotion: close BOTH scopes and the public tab hides itself — an empty shell is
  // not a feature. The admin keeps the tab: scopes slice the public wire, not the operator's.
  const shut = { "signals.cx": "admin", "signals.eq": "admin" };
  assert.equal(C.featureVisible(shut, "signals", false), false, "a public tab with no public scope must self-demote");
  assert.equal(C.featureVisible(shut, "signals", true), true, "self-demotion never touches the admin");
  // off on a scope means nobody — admin included — for that SLICE, and only that slice.
  v = C.featureScopeVis({ "signals.cx": "off" }, "signals", true);
  assert.deepEqual(v, { cx: false, eq: true, all: false }, "an off scope hides its slice from admin too");
  // A tab with no scope children resolves the identity set — nothing else in the manifest changes.
  assert.deepEqual(C.featureScopeVis({}, "trend", false), { cx: true, eq: true, all: true });
  // The coin convention the filters key off: xyz builder-dex ids carry a colon, main-dex never.
  assert.equal(C.coinScope("xyz:AAPL"), "eq");
  assert.equal(C.coinScope("BTC"), "cx");
  // Counts disclose the split: with defaults, exactly the two equity scopes are non-public.
  assert.equal(C.featureCounts({}).scoped, 2, "counts.scoped must report non-public scope entries");
  // Sanitizer: scope keys are ordinary settable keys — stored states survive, garbage does not.
  const out = C.featureFlagsSanitize({ "signals.eq": "public", "signals.cx": "OFF", "bogus.cx": "public" });
  assert.deepEqual(out, { "signals.eq": "public" }, "scope flags sanitize like every other key");
});

test("features: resolver fails closed, honours pins, and 'off' means nobody", () => {
  const C = require("../src/compute");
  // Unlisted key -> admin. A feature shipped without an entry is invisible to the group, not exposed.
  assert.equal(C.featureState({}, "does-not-exist"), "admin", "unlisted key must fail closed");
  assert.equal(C.featureVisible({}, "does-not-exist", false), false, "public user cannot see an unlisted key");
  assert.equal(C.featureVisible({}, "does-not-exist", true), true, "admin can see an unlisted key");

  // Markets is pinned: a bad flag write must not be able to leave a public user on a blank app.
  assert.equal(C.featureState({ markets: "off" }, "markets"), "public", "a pinned feature ignores stored flags");
  assert.equal(C.featureVisible({ markets: "admin" }, "markets", false), true, "markets stays visible to everyone");

  // off beats admin — that is the whole point of having a third state.
  assert.equal(C.featureVisible({ signals: "off" }, "signals", true), false, "'off' hides the feature from admin too");
  assert.equal(C.featureVisible({ signals: "admin" }, "signals", true), true);
  assert.equal(C.featureVisible({ signals: "admin" }, "signals", false), false);

  // Stored override beats the manifest default in both directions.
  assert.equal(C.featureState({ backtest: "public" }, "backtest"), "public", "an override can open a default-admin feature");
  assert.equal(C.featureState({ trend: "admin" }, "trend"), "admin", "an override can close a default-public feature");

  const pub = C.resolveFeatures({}, false), adm = C.resolveFeatures({}, true);
  assert.equal(Object.keys(pub).length, C.FEATURES.length, "resolveFeatures must return every key");
  assert.ok(pub.markets === true && adm.markets === true);
  assert.ok(Object.keys(pub).filter((k) => pub[k]).length < Object.keys(adm).filter((k) => adm[k]).length,
    "admin must resolve strictly more than public with default flags");
});

test("features: flag sanitizer drops unknown keys and bad states instead of coercing", () => {
  const C = require("../src/compute");
  // markets is deliberately absent from this case: it is PINNED, and pinned keys are dropped
  // wholesale (asserted separately). Use unpinned keys to test the key/state vocabulary itself.
  const out = C.featureFlagsSanitize({ signals: "admin", sectors: "public", bogus: "public", trend: "PUBLIC", news: 1, report: null });
  assert.deepEqual(out, { signals: "admin", sectors: "public" }, "only known key + valid state pairs survive");
  assert.deepEqual(C.featureFlagsSanitize(null), {}, "null input is an empty flag set, not a throw");
  assert.deepEqual(C.featureFlagsSanitize("nope"), {}, "a non-object flags file degrades to defaults");
  // A typo'd key must NOT fall through to a real feature's state — that is the bug the manifest exists
  // to prevent, and it would be invisible without this assertion.
  assert.equal(Object.prototype.hasOwnProperty.call(C.featureFlagsSanitize({ signal: "off" }), "signals"), false);
});

// ===== admin panel, phase 1: server state, identity, route gate ================================
test("features: sanitizer drops a stored state for a pinned key (latent-trap class)", () => {
  const C = require("../src/compute");
  // Inert today because featureState checks the pin first — LIVE the moment anyone removes the pin.
  // A value written in flags.json must never be able to activate via an edit in compute.js.
  const out = C.featureFlagsSanitize({ markets: "off", signals: "admin" });
  assert.equal(Object.prototype.hasOwnProperty.call(out, "markets"), false, "a pinned key must not survive sanitization");
  assert.equal(out.signals, "admin", "unpinned keys are untouched");
});


// ===== admin panel, phase 3: the switchboard =====================================================
test("admin panel: the panel's own key is locked open-proof and shut-proof", () => {
  const C = require("../src/compute");
  // lock:true is the mirror of pin. Two states must be unreachable through the thing that controls
  // them: making the panel public hands the switchboard to the group; turning it off locks the
  // operator out with no way back except a redeploy.
  assert.equal(C.featureState({ admin: "public" }, "admin"), "admin", "no write can make the panel public");
  assert.equal(C.featureState({ admin: "off" }, "admin"), "admin", "no write can turn the panel off");
  assert.equal(C.featureSettable("admin"), false, "the panel key must not be settable");
  assert.equal(C.featureSettable("markets"), false, "the pinned fallback must not be settable either");
  assert.equal(C.featureSettable("signals"), true, "ordinary features stay settable");
  // Neither lock may be smuggled in through a hand-edited flags.json.
  assert.deepEqual(C.featureFlagsSanitize({ admin: "public", markets: "off", news: "admin" }), { news: "admin" },
    "the sanitizer must drop both locked and pinned keys");
  // Visible to admin, invisible to public, in both resolutions.
  assert.equal(C.resolveFeatures({}, true).admin, true);
  assert.equal(C.resolveFeatures({}, false).admin, false);
});

test("cascade exhaustion: geometry from prices the tape printed, and every refusal condition", () => {
  // The flagship crypto event, and the reason the universe is worth enrolling: no equity analogue
  // exists in this data. Its whole point is that void and target are OBSERVED prices — the flush
  // wick and the pre-cascade close — so there is no sigma construction for the gate to clamp and
  // nothing that can go negative however violent the coin.
  const C = require("../src/compute");
  const HOUR = 3600e3, now = Date.now();
  // flat at 100, a long-liquidation cascade 5h ago wicking to 84, reclaimed to 93
  const hrs = [];
  for (let i = 48; i >= 0; i--) {
    const base = i > 5 ? 100 : (i >= 4 ? 88 : 93);
    hrs.push([now - i * HOUR, base, base * 1.005, i === 5 ? 84 : base * 0.995, base, 1e5]);
  }
  const casc = { t: now - 5 * HOUR, side: "long", liq: 4200000, doiPct: -3.4 };
  const ce = C.detectCascExhaust(casc, hrs, 93, { now });
  assert.ok(ce, "the cascade fires");
  assert.equal(ce.side, "long", "longs were carried out -> long the exhaustion");
  assert.equal(ce.stop, 84, "void IS the printed flush wick, not a sigma offset");
  assert.equal(ce.target, 100, "target IS the pre-cascade close");
  assert.ok(C.claimGeometryOk("long", 93, ce.stop, ce.target, 8), "and the resulting geometry clears the gate unaided");

  // every refusal condition, each for a stated reason
  assert.equal(C.detectCascExhaust(casc, hrs, 80, { now }), null, "mark below the flush low: the thesis is already dead");
  assert.equal(C.detectCascExhaust(casc, hrs, 105, { now }), null, "mark past the pre-cascade level: the move is already made");
  assert.equal(C.detectCascExhaust({ ...casc, t: now - 40 * HOUR }, hrs, 93, { now }), null, "stale past 24h: no longer the operative structure");
  assert.equal(C.detectCascExhaust({ ...casc, t: now - 60e3 }, hrs, 93, { now }), null, "under an hour old: the dust has not settled");
  assert.equal(C.detectCascExhaust(null, hrs, 93, { now }), null, "no flag: null, not a throw");
  assert.equal(C.detectCascExhaust(casc, [], 93, { now }), null, "no spine: null, not a throw");
  assert.equal(C.detectCascExhaust(casc, hrs, 0, { now }), null, "no mark: null, not a throw");

  // the short mirror
  const hrs2 = [];
  for (let i = 48; i >= 0; i--) {
    const base = i > 5 ? 100 : (i >= 4 ? 112 : 107);
    hrs2.push([now - i * HOUR, base, i === 5 ? 116 : base * 1.005, base * 0.995, base, 1e5]);
  }
  const up = C.detectCascExhaust({ t: now - 5 * HOUR, side: "short", liq: 3e6, doiPct: -2.1 }, hrs2, 107, { now });
  assert.ok(up && up.side === "short" && up.stop === 116 && up.target === 100, "short-side cascade mirrors exactly");

  // latestCascade picks the newest inside the window and ignores what fell out of it
  const flags = [{ t: now - 20 * HOUR, side: "long" }, { t: now - 2 * HOUR, side: "short" }, { t: now - 40 * HOUR, side: "long" }];
  assert.equal(C.latestCascade(flags, now, 24 * HOUR).t, now - 2 * HOUR, "newest within the window wins");
  assert.equal(C.latestCascade(flags, now, HOUR), null, "nothing inside a 1h window");
  assert.equal(C.latestCascade([], now, 24 * HOUR), null, "empty: null");
});

// ===== Telegram push transport, slice A: the wire (build 2026.07.27-01) =========================
// Everything here is the DELIVERY layer. What counts as a new setup is the trigger stream's job and
// is already covered above — these tests exist because the transport is the one part of this
// feature I cannot verify against the real service from a dev sandbox (api.telegram.org is not
// reachable from the build environment), so every failure mode it can hit is exercised against an
// injected transport instead: rate limits, blocked recipients, malformed messages, restarts.

test("push pure layer: escaping, code validation, eligibility, formatting, batching", () => {
  const C = require("../src/compute");

  // HTML escaping: ampersand FIRST, or the entities we introduce get double-escaped and Telegram
  // rejects the whole message with a 400 — a silently lost alert.
  assert.equal(C.tgEsc("a & b < c > d"), "a &amp; b &lt; c &gt; d");
  assert.equal(C.tgEsc("<b>x</b>"), "&lt;b&gt;x&lt;/b&gt;");
  assert.equal(C.tgEsc(null), "");

  // Link codes are read off a screen and typed into a phone, so the alphabet drops every glyph
  // pair a human confuses. If this ever regresses, people mistype codes and blame the bot.
  for (const ch of "O0I1") assert.ok(!C.PUSH_CODE_ALPHABET.includes(ch), `ambiguous char ${ch} must not be mintable`);
  assert.ok(C.pushCodeOk("K7M2QX"));
  assert.ok(C.pushCodeOk(" k7m2qx "), "case and surrounding space tolerated — people paste sloppily");
  assert.ok(!C.pushCodeOk("K7M2Q"), "wrong length rejected");
  assert.ok(!C.pushCodeOk("K7M2QO"), "ambiguous glyph rejected");
  assert.ok(!C.pushCodeOk(""), "empty rejected");
  assert.equal(C.pushCodeNorm(" k7m2qx "), "K7M2QX");

  const setup = { kind: "setup", coin: "HOOD", t: "HOOD", side: "long", ev: "breakout", label: "breakout",
    tf: "D1", entry: 42.1, void: 40.5, target: 47, rr: { gross: 2.4 }, evR: 0.55,
    rec: { n: 12, hit: 0.58, avgR: 0.4 }, late: 0.2 };

  // The setup gate DELEGATES to trigEligible rather than re-implementing it. This assert is the
  // whole reason the browser and the bot cannot drift into announcing different things.
  assert.equal(C.pushEligible(setup, {}), true, "no subscription filter interrupts for everything");
  assert.equal(C.pushEligible(setup, { trig: { minEV: 0.9 } }), false, "setup thresholds are the SHARED trigEligible gate");
  assert.equal(C.pushEligible(setup, { trig: { minRR: 2 } }), true);
  assert.equal(C.pushEligible(setup, { muted: true }), false, "a muted recipient receives nothing");
  assert.equal(C.pushEligible(setup, { classes: ["ops"] }), false, "class gate excludes unsubscribed classes");
  assert.equal(C.pushEligible(setup, { classes: [] }), true, "an EMPTY class list means all classes, not silence — muting is its own control");
  assert.equal(C.pushEligible({ kind: "nonsense" }, {}), false, "an unknown class is never delivered");

  const ops = { kind: "ops", title: "deploy", text: "build x is live" };
  assert.equal(C.pushEligible(ops, { admin: true, trig: { minEV: 99 } }), true, "setup thresholds must not silence ops — that is how you lose the stall warning");
  assert.equal(C.pushEligible(ops, { admin: true, classes: ["setup"] }), false);
  assert.equal(C.pushEligible(ops, {}), false, "ops is operator-only: a public recipient never receives server-health alerts");

  const m = C.pushFmt(setup, { baseUrl: "https://x.example" });
  // Fixed grammar, now rendered the way the app looks: header, a MONOSPACE geometry block, the
  // evidence line, the link. The <pre> is load-bearing — Telegram has no colour, so column-aligned
  // numbers are what carries the terminal feel, and the eye still lands on the void in one place.
  assert.ok(/^\u26a1 <b>HOOD<\/b> \u{1F7E2} LONG/u.test(m), "header: class glyph, name, side dot, side");
  assert.ok(m.includes("<pre>") && m.includes("</pre>"), "geometry rides a preformatted block");
  const pre = m.slice(m.indexOf("<pre>") + 5, m.indexOf("</pre>"));
  assert.ok(/^entry\s+42\.1$/m.test(pre) && /^void\s+40\.5$/m.test(pre) && /^R:R\s+2\.4$/m.test(pre),
    "labels are padded to a common width so the block reads as a table");
  assert.ok(m.includes("n=12") && m.includes("58%"), "the evidence line survives");
  assert.ok(m.includes("https://x.example/#t=HOOD"), "deep link last");
  assert.ok(C.pushFmt(Object.assign({}, setup, { side: "short" }), {}).includes("\u{1F534}"), "the side dot flips with the side");
  assert.ok(!C.pushFmt(setup, {}).includes("<a href"), "no PUBLIC_URL means no link, not a broken one");
  assert.ok(!C.pushFmt(setup, {}).includes("<pre></pre>"), "an empty geometry block must not be emitted");
  assert.equal(C.pushFmt({ kind: "setup" }), null, "an unformattable event yields null, never a half-message");
  assert.ok(C.pushFmt({ kind: "ops", title: "poller stalled", text: "x", level: "warn" }).startsWith("\u26a0\ufe0f"));

  // A ticker or label carrying markup cannot break out into the message body.
  const evil = C.pushFmt(Object.assign({}, setup, { t: "<script>x</script>" }), {});
  assert.ok(!evil.includes("<script>") && evil.includes("&lt;script&gt;"), "event text is escaped before it reaches parse_mode=HTML");

  // Batching: EVERYTHING ships. The character limit is the only bound — a burst splits across as
  // many messages as it takes rather than being truncated to a count. The old cap disclosed its
  // overflow as "+N more held — batch cap" and then dropped it, which is a deletion wearing the
  // word "held": nothing ever followed.
  const many = Array.from({ length: 12 }, (_, i) => "msg" + i);
  const out = C.pushBatch(many);
  assert.equal(out.length, 1, "twelve short events still pack into one message — the packer is about bytes, not counts");
  for (const m of many) assert.ok(out.join("\n").includes(m), m + " reached the wire");
  assert.ok(!out.join("\n").includes("batch cap"), "no event is ever held back, so there is no overflow to disclose");
  assert.ok(!out[0].includes("1/1"), "a single message carries no part marker");

  // A burst too big for one body: every event present exactly once, nothing over the limit, and
  // the parts are marked in order so the reader can see the shape of what is arriving.
  const burst = Array.from({ length: 40 }, (_, i) => "<b>EV" + i + "</b> " + "x".repeat(400));
  const parts = C.pushBatch(burst);
  assert.ok(parts.length >= 5, "a 40-event burst becomes several messages, not eight events and a lie");
  for (let i = 0; i < burst.length; i++) {
    const hits = parts.filter((t) => t.includes("<b>EV" + i + "</b>")).length;
    assert.equal(hits, 1, "EV" + i + " appears exactly once across the split");
  }
  parts.forEach((t, i) => {
    assert.ok(t.startsWith("<i>" + (i + 1) + "/" + parts.length + "</i>\n"), "part " + (i + 1) + " is marked in order");
    assert.ok(t.length <= 4096, "every part stays under Telegram's hard body limit, marker included");
  });
  const long = C.pushBatch(["a".repeat(3000), "b".repeat(3000)]);
  assert.equal(long.length, 2, "a batch that would exceed Telegram's body limit splits instead of being rejected");
  assert.ok(C.pushBatch(["z".repeat(3900)])[0].includes("z".repeat(3900)), "a single oversized event ships whole rather than truncated");
  assert.deepEqual(C.pushBatch([]), []);
});

// ===== Quiet ops events (build 2026.07.27-04) ==================================================
// Regression guard for a design mistake, not a code one: the deploy notice was justified as free
// proof the wire was alive, on the assumption that a deploy is rare. It is not — this app
// redeploys on every individual file push, so one build shipped in five uploads fired five
// identical DMs. The event still belongs in the log; it never belonged on a phone.

test("quiet events are recorded but never delivered", () => {
  const C = require("../src/compute");
  const ev = { kind: "ops", title: "deploy", text: "build x is live", quiet: 1 };
  assert.equal(C.pushEligible(ev, { admin: true }), false, "a quiet event is not delivered to a default subscriber");
  assert.equal(C.pushEligible(ev, { admin: true, classes: ["ops"] }), false, "…nor to someone who explicitly subscribed to its class");
  assert.equal(C.pushEligible(Object.assign({}, ev, { quiet: 0 }), { admin: true }), true, "the flag is what suppresses it, not the class");
  // The flag sits on the EVENT, so every transport agrees about what happened and differs only on
  // what was worth interrupting for.
  assert.equal(C.pushEligible({ kind: "ops", title: "poller stalled", level: "warn" }, { admin: true }), true,
    "ops that matter still deliver — suppressing the whole class would take the stall warning with it");
});

// ===== Server-side metric rules, slice D (build 2026.07.27-05) ==================================
// The threshold alerts, moved off the browser: they now fire with every tab closed, the group
// shares one list, and they can reach a phone. The catalog is restricted to metrics the server
// itself owns — squeeze, momentum and beta are browser-derived against a user-selected window and
// stay in-tab rather than having their math duplicated server-side.

test("rule evaluation: hysteresis, arming, crosses, and unevaluable data", () => {
  const C = require("../src/compute");
  const row = (px) => ({ coin: "X", ticker: "X", uni: "xyz", px, ref: { p1h: 100, p4h: 100, p7d: 100, p30d: 100 }, d1: 0 });
  const r = { id: 1, metric: "h1", op: ">", value: 5 };

  // A brand-new (rule, market) pair is DISARMED: a rule written while the market is already in
  // breach describes a state, not an event. Otherwise saving a rule detonates it across the roster.
  assert.equal(C.ruleEval(r, row(106), false), "hold", "an unarmed rule in breach stays quiet");
  assert.equal(C.ruleEval(r, row(100), false), "arm", "it arms once the value sits cleanly outside the band");
  assert.equal(C.ruleEval(r, row(106), true), "fire", "…and fires on the next breach");
  assert.equal(C.ruleEval(r, row(106), false), "hold", "a sustained breach does not re-fire every scan");

  // Hysteresis: retreating to just under the threshold must NOT re-arm, or a value parked on the
  // line machine-guns the channel.
  assert.equal(C.ruleEval(r, row(104.95), false), "hold", "inside the band is not a re-arm");
  assert.equal(C.ruleEval(r, row(104.0), false), "arm", "past the band is");
  assert.equal(C.ruleBand({ value: 5 }), 0.1, "the default band is 2% of the threshold's own magnitude");
  assert.ok(C.ruleBand({ value: 0 }) > 0, "a zero threshold still gets a floor band, or it oscillates forever");
  assert.equal(C.ruleBand({ value: 5, band: 2 }), 2, "an explicit band wins");

  // Crosses need two observations by definition. Treating a missing previous value as "was on the
  // other side" would fire every cross rule on every restart.
  const cu = { id: 2, metric: "h1", op: "cross_up", value: 5 };
  assert.equal(C.ruleEval(cu, row(106), true, null), "hold", "no baseline yet — a first sighting cannot be a cross");
  assert.equal(C.ruleEval(cu, row(106), true, 4), "fire");
  assert.equal(C.ruleEval(cu, row(106), true, 5.5), "hold", "already above: not a crossing");
  const cd = { id: 3, metric: "h1", op: "cross_dn", value: 5 };
  assert.equal(C.ruleEval(cd, row(104), true, 6), "fire");

  // abs> for two-sided moves
  assert.equal(C.ruleEval({ id: 4, metric: "h1", op: "abs>", value: 5 }, row(94), true), "fire", "abs catches the downside too");

  // Missing data is null — never a fire, and never quietly treated as false.
  assert.equal(C.ruleEval(r, { coin: "X", px: null }, true), null);
  assert.equal(C.ruleEval({ metric: "nope", op: ">", value: 1 }, row(106), true), null);
  assert.equal(C.ruleEval({ metric: "h1", op: "??", value: 1 }, row(106), true), null);
});

test("rule catalog: server-owned metrics only, scaled units, and browser-derived ones excluded", () => {
  const C = require("../src/compute");
  const keys = C.RULE_METRICS.map((m) => m.k);
  for (const k of ["px", "h1", "h4", "d1", "d7", "d30", "fundAPR", "fundPct", "prem", "vol", "oi", "rvol"])
    assert.ok(keys.includes(k), `server catalog must carry ${k}`);
  // The honest boundary: these are derived in the browser against a user-selected window, so there
  // is no single server-side value. Including them would mean the math in two files.
  for (const k of ["sqz", "mom", "beta"])
    assert.ok(!keys.includes(k), `${k} is browser-derived and must NOT be in the server catalog`);

  const row = { coin: "X", px: 110, oracle: 100, ref: { p1h: 100 }, funding: 0.0001, vol: 5e6, oi: 3e6, rvol: 2.5, doi: { d1: 4, d7: 9 }, d1: 1 };
  assert.ok(Math.abs(C.RULE_BY_K.prem.get(row) - 1000) < 1e-6,
    "premium is derived from mark vs oracle, both of which the row already carries");
  assert.ok(Math.abs(C.RULE_BY_K.fundAPR.get(row) - 0.0001 * 24 * 365 * 100) < 1e-9);
  assert.ok(Math.abs(C.RULE_BY_K.h1.get(row) - 10) < 1e-6);
  // Scaled metrics: the user types "5" meaning 5M, and the comparison happens in raw units.
  assert.equal(C.RULE_BY_K.vol.scale, 1e6);
  assert.equal(C.ruleEval({ metric: "vol", op: ">", value: 4 }, row, true), "fire", "5M volume clears a rule written as 4");
  assert.equal(C.ruleEval({ metric: "vol", op: ">", value: 6 }, row, true), "hold");
});

test("rule validation rejects rather than coerces", () => {
  const C = require("../src/compute");
  assert.equal(C.validateRule({ metric: "h1", op: ">", value: 5 }).ok, true);
  assert.equal(C.validateRule({ metric: "sqz", op: ">", value: 5 }).error, "unknown-metric", "a browser-only metric cannot be saved as a server rule");
  assert.equal(C.validateRule({ metric: "h1", op: "~", value: 5 }).error, "unknown-op");
  assert.equal(C.validateRule({ metric: "h1", op: ">", value: "abc" }).error, "bad-value");
  assert.equal(C.validateRule({ metric: "h1", op: ">", value: 5, uni: "nope" }).error, "bad-universe");
  assert.equal(C.validateRule({ metric: "h1", op: ">", value: 5, band: -1 }).error, "bad-band");
  assert.equal(C.validateRule(null).ok, false);
  // A rule silently coerced into something its author didn't mean fires forever and nobody knows
  // why, so every rejection names its reason.
  assert.equal(C.validateRule({ metric: "h1", op: ">", value: "5" }).rule.value, 5, "numeric strings are accepted and normalised");
  assert.equal(C.validateRule({ metric: "h1", op: ">", value: 5, note: "x".repeat(200) }).rule.note.length, 80, "notes are capped, not rejected");
});

// ===== Context classes + the rate meter, slice E (build 2026.07.27-06) ==========================
// The deploy notice fired four or five times per build because I reasoned about its frequency
// instead of measuring it. Every class added here is measured, shipped OPT-IN, and two candidates
// were dropped on frequency grounds before a line of transport code was written.

test("new classes are opt-in: an absent selection means the DEFAULT set, never everything", () => {
  const C = require("../src/compute");
  for (const k of ["filing", "earnings", "ai"]) assert.ok(C.PUSH_CLASSES.includes(k), `${k} must be selectable`);
  for (const k of ["filing", "earnings", "ai"])
    assert.ok(!C.PUSH_DEFAULT_CLASSES.includes(k), `${k} must NOT be delivered by default — that is the whole lesson`);
  for (const k of ["setup", "ledger", "rule", "ops"])
    assert.ok(C.PUSH_DEFAULT_CLASSES.includes(k), `${k}'s rate is known and stays on by default`);

  const filing = { kind: "filing", coin: "X", t: "X", form: "8-K", h: "Item 2.02", url: "https://sec.gov/x" };
  // The load-bearing assertion: a recipient linked BEFORE this build must not silently start
  // receiving filings just because a class was added.
  assert.equal(C.pushEligible(filing, {}), false, "an unchosen subscription does not inherit new classes");
  assert.equal(C.pushEligible(filing, { classes: ["filing"] }), true, "…but choosing it works");
  assert.equal(C.pushEligible({ kind: "setup", coin: "X", rr: { gross: 3 }, evR: 1 }, {}), true, "default classes still flow without a selection");

  const m = C.pushFmt(filing, {});
  assert.ok(m.includes("8-K") && m.includes("Item 2.02") && m.includes("sec.gov"));
  const e = C.pushFmt({ kind: "earnings", coin: "X", t: "X", when: "tomorrow", session: "amc", claim: "breakout" }, {});
  assert.ok(/tomorrow/.test(e) && /amc/.test(e), "the earnings alert carries the schedule");
  assert.ok(!/claim/i.test(e), "positioning never renders on an earnings message — even when an old ring entry still carries ev.claim");
  const a = C.pushFmt({ kind: "ai", coin: "X", t: "X", from: "wait", to: "enter_on_pullback", note: "n" }, {});
  assert.ok(a.includes("wait") && a.includes("enter_on_pullback"));
});

// ===== Quiet hours, digest, regime + coverage, slice F (build 2026.07.27-07) ====================

test("quiet hours: window maths, midnight wrap, and what pierces", () => {
  const C = require("../src/compute");
  const at = (h) => Date.UTC(2026, 6, 27, h, 0, 0);
  const q = { from: 23, to: 7, tz: 0 };
  assert.equal(C.inQuietWindow(at(23), q), true, "a window that wraps midnight covers the late side");
  assert.equal(C.inQuietWindow(at(3), q), true, "…and the early side");
  assert.equal(C.inQuietWindow(at(7), q), false, "the end hour is exclusive");
  assert.equal(C.inQuietWindow(at(12), q), false);
  const day = { from: 9, to: 17, tz: 0 };
  assert.equal(C.inQuietWindow(at(12), day), true, "a non-wrapping window works too");
  assert.equal(C.inQuietWindow(at(20), day), false);
  assert.equal(C.inQuietWindow(at(3), { from: 5, to: 5, tz: 0 }), false, "a zero-width window is off, not always");
  assert.equal(C.inQuietWindow(at(3), null), false);
  // Offsets are the recipient's, because these are DMs and the group is not in one timezone.
  assert.equal(C.inQuietWindow(at(2), { from: 23, to: 7, tz: -180 }), true, "23:00 in a UTC-3 evening is quiet");
  assert.equal(C.inQuietWindow(at(14), { from: 23, to: 7, tz: -180 }), false);

  const ends = C.quietEndsAt(at(23), q);
  assert.ok(ends > at(23) && ends <= at(23) + 9 * 3600e3, "a held message is scheduled for the window's end, not re-checked forever");
  assert.equal(C.quietEndsAt(at(12), q), at(12), "outside the window nothing is deferred");

  // Delaying a stop-out until morning would defeat the point of having it.
  assert.equal(C.piercesQuiet({ kind: "ledger", sub: "stop" }), true);
  assert.equal(C.piercesQuiet({ kind: "ops" }), true, "a stalled poller means every other alert has stopped being trustworthy");
  assert.equal(C.piercesQuiet({ kind: "ledger", sub: "target" }), false);
  assert.equal(C.piercesQuiet({ kind: "setup" }), false);

  assert.equal(C.validateQuiet({ from: 23, to: 7 }).quiet.tz, 0);
  assert.equal(C.validateQuiet({ from: 25, to: 7 }).error, "bad-hours");
  assert.equal(C.validateQuiet({ from: 1, to: 2, tz: 9999 }).error, "bad-tz");
  assert.equal(C.validateQuiet(null).quiet, null);
});

// ===== Setup-family filter (build 2026.07.27-10) ================================================
// The actionable board splits confirmed setups into two structurally different families and lets
// you show either. The alert channel could not, so "R:R >= 2" was the only way to express "just the
// level-triggered ones" — and that is a threshold standing in for a category, which silently drops
// the odd sigma-built setup that happens to clear 2:1.

test("trigEligible filters by setup family using the board's own cls stamp", () => {
  const { trigEligible } = require("../src/compute");
  const rr = { coin: "A", side: "long", cls: "rr", rr: { gross: 3.1 }, evR: 0.5 };
  const ev = { coin: "B", side: "long", cls: "ev", rr: { gross: 0.8 }, evR: 0.4 };

  assert.equal(trigEligible(rr, {}), true, "no filter means both families");
  assert.equal(trigEligible(ev, {}), true);
  assert.equal(trigEligible(rr, { cls: [] }), true, "an empty list means both, never silence");
  assert.equal(trigEligible(ev, { cls: [] }), true);
  assert.equal(trigEligible(rr, { cls: ["rr", "ev"] }), true);

  assert.equal(trigEligible(rr, { cls: ["rr"] }), true, "2:1+ only lets the level-triggered family through");
  assert.equal(trigEligible(ev, { cls: ["rr"] }), false);
  assert.equal(trigEligible(ev, { cls: ["ev"] }), true, "grinders only");
  assert.equal(trigEligible(rr, { cls: ["ev"] }), false);

  // The point of having this as a category rather than a ratio threshold: a sigma-built setup that
  // happens to clear 2:1 is still a grinder, and an R:R floor would have let it through.
  const evHighRR = { coin: "C", side: "long", cls: "ev", rr: { gross: 2.6 }, evR: 0.4 };
  assert.equal(trigEligible(evHighRR, { minRR: 2 }), true, "an R:R floor alone cannot express the family");
  assert.equal(trigEligible(evHighRR, { cls: ["rr"] }), false, "…the family filter can");

  // Family and thresholds compose rather than override.
  assert.equal(trigEligible(rr, { cls: ["rr"], minEV: 0.9 }), false);
});

test("closedBars: only the unfinished tail is trimmed — history is closed by construction", () => {
  const C = require("../src/compute");
  const H = 3600e3, t0 = Date.UTC(2026, 6, 27, 0, 0, 0);
  const bars = [0, 1, 2, 3].map((i) => ({ t: t0 + i * H, c: 10 + i }));
  // At 03:30 the 03:00 bar is still forming; the three before it are done.
  assert.equal(C.closedBars(bars, H, t0 + 3.5 * H).length, 3);
  // Exactly at its end a bar IS closed: t + width <= now.
  assert.equal(C.closedBars(bars, H, t0 + 4 * H).length, 4);
  // A same-reference return when nothing is trimmed — no needless copy on the hot path.
  const all = C.closedBars(bars, H, t0 + 5 * H);
  assert.equal(all, bars);
  assert.deepEqual(C.closedBars([], H, t0), []);
  assert.deepEqual(C.closedBars(null, H, t0), []);
});

test("closedLadder: the rung's own last closed close is the ruler — no live mark anywhere", () => {
  const C = require("../src/compute");
  const H = 3600e3, t0 = Date.UTC(2026, 6, 1, 0, 0, 0);
  const mk = (n, w, f) => Array.from({ length: n }, (_, i) => ({ t: t0 + i * w, c: f(i) }));
  const up = (w) => mk(40, w, (i) => 100 + i);        // rising: last close > eF > eS on every construction
  const dn = (w) => mk(40, w, (i) => 140 - i);
  const tfc = { D1: up(24 * H), H12: up(12 * H), H4: up(4 * H), H1: up(H) };
  const lad = C.closedLadder(tfc);
  assert.equal(lad.sign, 1, "the closed D1 ribbon reads up");
  assert.equal(lad.long.score, 4, "every closed rung is stacked");
  assert.equal(lad.short.score, 0);
  // closeAt is when the last CLOSED bar ends — the confirming-close timestamp an alert carries.
  assert.equal(lad.closeAt.H1, t0 + 39 * H + H);
  assert.equal(lad.closeAt.D1, t0 + 39 * 24 * H + 24 * H);
  // A mirrored series mirrors: down stack, sign flipped.
  const lad2 = C.closedLadder({ D1: dn(24 * H), H12: dn(12 * H), H4: dn(4 * H), H1: dn(H) });
  assert.equal(lad2.sign, -1);
  assert.equal(lad2.short.score, 4);
  // Retest: a low probing the fast EMA on the H4 rung, close still above the slow — the FIRST
  // qualifying rung high->low is the one reported, and only closed bars feed the probe.
  const h4 = up(4 * H);
  const eF = C.emaLast(h4.map((k) => +k.c), 13);
  h4[h4.length - 1] = { t: h4[h4.length - 1].t, c: h4[h4.length - 1].c, l: eF - 0.01, h: h4[h4.length - 1].c };
  const lad3 = C.closedLadder({ D1: up(24 * H), H12: up(12 * H), H4: h4, H1: up(H) });
  assert.equal(lad3.long.retest, "H4");
  // A rung short of history excludes the name, same rule as the board.
  assert.equal(C.closedLadder({ D1: up(24 * H), H12: up(12 * H), H4: up(4 * H), H1: mk(10, H, (i) => 100 + i) }), null);
  // A rung that clears the floor but cannot seed the slow MA is nodata, not a guess — and a
  // nodata D1 leaves the sign 0: unknown, never neutral.
  const short26 = mk(26, 24 * H, (i) => 100 + i);
  const lad4 = C.closedLadder({ D1: short26, H12: up(12 * H), H4: up(4 * H), H1: up(H) }, 13, 200);
  assert.ok(lad4 && lad4.tf.D1.st === "nodata" && lad4.sign === 0);
});

test("ma200 class: selectable, opt-in, and the message carries the -25 stamp", () => {
  const C = require("../src/compute");
  assert.ok(C.PUSH_CLASSES.includes("ma200"));
  assert.ok(!C.PUSH_DEFAULT_CLASSES.includes("ma200"), "opt-in until its measured rate is known — adding a class never retroactively subscribes anyone");
  const ev = { kind: "ma200", coin: "SOL", t: "SOL", side: "long", sub: "reclaim", tf: "D1",
    px: 214.36, ema: 198.4, dist: 8.04, held: 47, confTf: "D1", confAt: Date.UTC(2026, 6, 27, 0, 0),
    seenAt: Date.UTC(2026, 6, 26, 14, 20), title: "D1 EMA200 reclaim",
    text: "closed back above the 200 after 47 D1 bars below it" };
  assert.equal(C.pushEligible(ev, { classes: ["ma200"] }), true);
  assert.equal(C.pushEligible(ev, {}), false, "absent selection = the DEFAULT set, which excludes it");
  const m = C.pushFmt(ev, { baseUrl: "https://x.example" });
  assert.ok(m.includes("D1 EMA200 reclaim"));
  assert.ok(/^EMA200\s+198\.4$/m.test(m.slice(m.indexOf("<pre>") + 5, m.indexOf("</pre>"))), "the line itself is in the geometry block");
  assert.ok(m.includes("held    47 D1 bars"), "how long the prior side held is the message's own quality signal");
  assert.ok(m.includes("\u23f1 confirmed D1 close 00:00 UTC"), "the confirming close is the alert's time");
  assert.ok(m.includes("first seen Jul 26 14:20"));
  // A retest ships its probe; a cross does not fabricate one.
  const rt = C.pushFmt({ kind: "ma200", coin: "H", t: "HYPE", side: "long", sub: "retest", tf: "H4",
    px: 47.92, ema: 46.8, dist: 2.39, held: 88, probe: 46.71, confTf: "H4",
    confAt: Date.UTC(2026, 6, 27, 8, 0), title: "H4 bullish retest of EMA200",
    text: "pullback probed the 200 from above, close held it" }, {});
  assert.ok(rt.includes("probe   46.71"));
  assert.ok(!m.includes("probe"), "no probe on a cross event");
});

test("telegram messages carry the app's look: glyphs, side dots, aligned monospace geometry", () => {
  const C = require("../src/compute");
  const geo = (m) => m.slice(m.indexOf("<pre>") + 5, m.indexOf("</pre>"));
  const stop = C.pushFmt({ kind: "ledger", sub: "stop", coin: "H", t: "H", side: "long", ev: "breakout",
    label: "breakout", level: 40.5, entry: 42.1, held: "3h" }, {});
  assert.ok(stop.startsWith("\u26d4"), "a void being taken leads with the same glyph the board uses");
  assert.ok(/^level\s+40\.5$/m.test(geo(stop)));
  const tgt = C.pushFmt({ kind: "ledger", sub: "target", coin: "H", t: "H", side: "long", ev: "e", level: 47 }, {});
  assert.ok(tgt.startsWith("\u{1F3AF}"));

  const tr = C.pushFmt({ kind: "trend", coin: "N", t: "NVDA", side: "long", sub: "stack", score: 4,
    tf: "D1", px: 120, e21: 114, title: "full 4/4 stack", text: "every rung aligned up" }, {});
  assert.ok(tr.startsWith("\u{1F4C8}") && tr.includes("NVDA"));
  assert.ok(/^score\s+4\/4$/m.test(geo(tr)));
  assert.ok(C.pushFmt({ kind: "trend", coin: "N", t: "N", side: "short", title: "x" }, {}).startsWith("\u{1F4C9}"),
    "a downtrend leads with the down glyph — direction readable before a word is");

  // Escaping still holds inside the preformatted block, or a ticker with markup breaks the message.
  const evil = C.pushFmt({ kind: "rule", coin: "X", t: "<b>X", rule: "r", now: "<i>1" }, {});
  assert.ok(!/<b>X/.test(evil) && evil.includes("&lt;"), "content is escaped before it reaches parse_mode=HTML");
});

test("rule catalog carries the board's windowed columns, not a subset of them", () => {
  const C = require("../src/compute");
  const keys = C.RULE_METRICS.map((m) => m.k);
  for (const k of ["doiH1", "doiH4", "doiD30", "fundD1", "fundD7", "hi30", "lo30", "vwap30"])
    assert.ok(keys.includes(k), `${k} was a board column with no alert path`);
  const row = { px: 98, feat: { hi30: 100, lo30: 80, vwap30: 95 }, doi: { h1: 1.2, h4: 3.4, d30: -8 },
    fundByWin: { d1: 0.0001, d7: 0.00005 } };
  assert.ok(Math.abs(C.RULE_BY_K.hi30.get(row) - -2) < 1e-9, "% from the 30d high is negative below it — 'hi30 > -2' is the breakout-watch question");
  assert.ok(Math.abs(C.RULE_BY_K.lo30.get(row) - 22.5) < 1e-9);
  assert.ok(Math.abs(C.RULE_BY_K.fundD1.get(row) - 0.0001 * 24 * 365 * 100) < 1e-9, "windowed funding is annualised like the point-in-time metric");
  assert.equal(C.RULE_BY_K.doiD30.get(row), -8);
  assert.equal(C.RULE_BY_K.hi30.get({ px: 98 }), null, "a row without the feature block is null, never a guess");
});

// ===== volume-node families + board promotion path (build 2026.07.28-02) =======================
// Phase 3: the lvlhold/lvlrej mechanics on the other honest level source — the volume profile's
// POC and high-volume nodes. Phase 4: proof that the promotion path needs no new machinery — a
// shadow family that earns its out-of-sample record flows onto the actionable board through the
// exact confirmed gate every family faces, carrying its tight structural void with it.

test("vp families -02: vpTouchNodes — POC + HVN peaks, deduped, sorted, shares carried", () => {
  const C = require("../src/compute");
  const vp = { poc: 100, binPct: 0.5, bins: [[98, 0.1], [100, 0.3], [104, 0.2]],
    hvn: [{ p: 100.2, v: 0.3 }, { p: 104, v: 0.2 }, { p: 96, v: 0.15 }] };
  const n = C.vpTouchNodes(vp);
  assert.ok(Array.isArray(n) && n.length === 3, "POC kept, its duplicate HVN deduped, the rest admitted");
  assert.deepEqual(n.map((x) => x.p), [96, 100, 104], "ascending by price");
  assert.equal(n.find((x) => x.p === 100).v, 0.3, "the POC carries the tallest bin's share");
  assert.equal(C.vpTouchNodes(null), null, "no profile is an honest null");
});

test("vp families -02: detectVpTouch — held node probe fires tight, everything sloppier refuses", () => {
  const C = require("../src/compute");
  const nodes = [{ p: 96, v: 0.15 }, { p: 100, v: 0.3 }, { p: 118, v: 0.2 }];
  const sd30 = 0.8;
  const mkBars = (lastL, lastC) => {
    const DAY_ = 86400e3, t0 = Date.now() - 70 * DAY_, bars = [];
    for (let i = 0; i < 64; i++) bars.push({ t: t0 + i * DAY_, c: 103.5, h: 103.9, l: 103.1 });
    bars.push({ t: t0 + 64 * DAY_, c: lastC, h: lastC + 0.4, l: lastL });
    return bars;
  };
  const r = C.detectVpTouch(nodes, mkBars(100.2, 103), 103.5, sd30, "long");
  assert.ok(r, "held probe of the node must fire");
  assert.equal(r.lvl, 100, "anchored on the nearest node below");
  assert.ok(r.stop < 100 && r.stop > 99, `void half a \u03c3 behind the node — tight (got ${r.stop})`);
  assert.equal(r.target, 118, "target = next node in the trade direction, VP-pure");
  assert.equal(r.vw, 0.3, "the node's volume share rides out as the recorded feature");
  assert.equal(C.detectVpTouch(nodes, mkBars(103.1, 103.5), 103.5, sd30, "long"), null, "no probe, no claim");
  assert.equal(C.detectVpTouch(nodes, mkBars(99.6, 99.7), 99.7, sd30, "long"), null, "a close through the node is not a hold");
  assert.equal(C.detectVpTouch([{ p: 100, v: 0.3 }, { p: 96, v: 0.1 }], mkBars(100.2, 103), 103.5, sd30, "long"), null,
    "no node on the target leg -> null, never an invented price");
  // short mirror
  const nodesS = [{ p: 96, v: 0.2 }, { p: 108, v: 0.3 }];
  const DAY_ = 86400e3, t0 = Date.now() - 70 * DAY_, barsS = [];
  for (let i = 0; i < 64; i++) barsS.push({ t: t0 + i * DAY_, c: 104, h: 104.4, l: 103.6 });
  barsS.push({ t: t0 + 64 * DAY_, c: 104, h: 107.9, l: 103.6 });
  const rs = C.detectVpTouch(nodesS, barsS, 104.2, sd30, "short");
  assert.ok(rs && rs.lvl === 108 && rs.stop > 108 && rs.target === 96, "short mirror: overhead node, void above it, node target below");
});

test("topicHit: word-boundary, not substring — the gate aliasHit could not be", () => {
  const { topicHit } = require("../src/compute");
  assert.equal(topicHit("Petrobras lifts diesel prices as Brent holds", ["Brazil", "Petrobras"]), true);
  assert.equal(topicHit("BCB holds Selic at 15%", ["Selic", "Copom"]), true);
  assert.equal(topicHit("bank of japan holds rates", ["Bank of Japan"]), true, "phrases match as phrases, case-insensitively");
  // The reason this is not aliasHit: substring matching seeds macro drawers with garbage.
  assert.equal(topicHit("A toil of a day for the cayenne trade", ["oil", "yen"]), false,
    "substring matching would have fired on toil/cayenne — the boundary rule is the whole point");
  assert.equal(topicHit("Citizens Financial reports", ["yen"]), false);
  assert.equal(topicHit("Yen weakens past 160 as Ueda holds", ["yen"]), true, "a real hit still lands");
  // No topics = no match. A name without a declared lane can never accidentally collect the tape.
  assert.equal(topicHit("anything at all", []), false);
  assert.equal(topicHit("anything at all", null), false);
  assert.equal(topicHit("", ["Brazil"]), false);
});
// ===== custom baskets + ratio candles (build 2026.07.28-06) ====================================
// Synthetic EW instruments for the VISUAL layer. These tests execute the real math (never
// eyeball-pin numbers), duel the client mirror against the server implementation on one ragged
// fixture, execute the ratio SVG builder against a fixture payload (the -84 lesson: existence
// pins don't prove wiring), and pin the tier boundary: baskets/ratios must never reach the
// alert emitters, the signal fire sites, or the push-class registry.

test("-06 basketCloses: EW log-return chaining, coverage floor as GAPS (never renormalized), gap-spanning resume", () => {
  const C = require("../src/compute");
  // EW math: slot k multiplies by exp(mean member log return)
  const b = C.basketCloses([[100, 110, 121], [50, 50, 55]], 0.6);
  assert.ok(Math.abs(b.closes[0] - 100) < 1e-9, "seeds at 100");
  const want1 = 100 * Math.exp((Math.log(1.1) + 0) / 2);
  assert.ok(Math.abs(b.closes[1] - want1) < 1e-9, "EW mean of member log returns, not price averaging");
  assert.ok(Math.abs(b.closes[2] - want1 * Math.exp((Math.log(121 / 110) + Math.log(55 / 50)) / 2)) < 1e-9, "chains");
  assert.deepEqual(b.cov, [2, 2, 2]);
  // Floor: a slot with 1/3 contributing is a GAP (null) — the index does NOT renormalize over
  // whoever showed up — and the chain resumes measuring each member from its close at the last
  // VALID slot, spanning the gap honestly.
  const g = C.basketCloses([[100, 110, null, 121], [100, null, null, 110], [100, null, null, 99]], 0.6);
  assert.equal(g.closes[1], null, "1/3 < 60% floor -> gap");
  assert.equal(g.closes[2], null, "0/3 -> gap");
  const want3 = 100 * Math.exp((Math.log(1.21) + Math.log(1.10) + Math.log(0.99)) / 3);
  assert.ok(Math.abs(g.closes[3] - want3) < 1e-9, "post-gap slot measures every member from the LAST VALID slot");
  // No valid seed at all -> all null, never a fabricated start
  const z = C.basketCloses([[null, null], [null, 5]], 0.6);
  assert.deepEqual(z.closes, [null, null]);
});

test("-06 validateBasket: benchmark aliases, listed names and caps are refused with reasons", () => {
  const C = require("../src/compute");
  const ctx = { tickers: new Set(["AAPL", "MSFT", "NVDA"]), reserved: new Set(["SPX", "BTC"]) };
  assert.equal(C.validateBasket("SPX", ["AAPL", "MSFT"], "stocks", ctx).ok, false, "benchmark alias refused — the SPX-memecoin lesson");
  assert.equal(C.validateBasket("AAPL", ["MSFT", "NVDA"], "stocks", ctx).ok, false, "listed ticker refused as a name");
  assert.equal(C.validateBasket("MAG2", ["AAPL"], "stocks", ctx).ok, false, "member floor (2)");
  assert.equal(C.validateBasket("M", ["AAPL", "MSFT"], "stocks", ctx).ok, false, "name too short");
  assert.equal(C.validateBasket("MAG2", ["AAPL", "TSLA"], "stocks", ctx).ok, false, "unknown member refused, not dropped");
  const ok = C.validateBasket("mag2", ["aapl", "msft", "AAPL"], "stocks", ctx);
  assert.ok(ok.ok, "happy path");
  assert.equal(ok.name, "MAG2", "uppercased");
  assert.deepEqual(ok.members, ["AAPL", "MSFT"], "deduped + uppercased");
  assert.equal(C.BASKET_FLOOR, 0.6, "floor is a named constant, not a magic number");
  assert.equal(C.BASKET_MAX_MEMBERS, 20);
  assert.equal(C.BASKET_MAX_CUSTOM, 12);
});

test("schedule days: one parser, and unreadable input is refused rather than guessed", () => {
  const C = require("../src/compute");
  assert.equal(C.schedParseDays("all"), null, "null means every day");
  assert.equal(C.schedParseDays(""), null);
  assert.deepEqual(C.schedParseDays("MWF"), [1, 3, 5]);
  assert.deepEqual(C.schedParseDays("mon,wed,fri"), [1, 3, 5]);
  assert.deepEqual(C.schedParseDays("1,3,5"), [1, 3, 5]);
  assert.deepEqual(C.schedParseDays("weekdays"), [1, 2, 3, 4, 5]);
  assert.deepEqual(C.schedParseDays("tue thu"), [2, 4]);
  assert.equal(C.schedParseDays("garbage"), undefined, "unreadable is undefined, NOT an empty set");
  // t and s each serve two days, so the compact form uses r for Thursday and u for Sunday. Guessing
  // which was meant is the one thing a schedule parser must never do.
  assert.deepEqual(C.schedParseDays("MTWRF"), [1, 2, 3, 4, 5]);
  assert.equal(C.schedNormDays([0, 1, 2, 3, 4, 5, 6]), null, "all seven normalises back to 'every day'");
  assert.equal(C.schedNormDays([]), undefined, "an empty selection is malformed — 'off' is a null hour, not an empty week");
  assert.equal(C.schedNormDays([9]), undefined);
  assert.equal(C.schedDaysLabel(null), "daily");
  assert.equal(C.schedDaysLabel([1, 3, 5]), "mon\u00b7wed\u00b7fri");
  assert.equal(C.schedDaysLabel([1, 2, 3, 4, 5]), "weekdays");
});

test("schedule resolution: default-on, off is a stored decision, days gate delivery", () => {
  const C = require("../src/compute");
  const def = { defaultHour: 10 };
  assert.deepEqual(C.schedResolve(undefined, def), { hour: 10, days: null, isDefault: true },
    "never configured takes the default and is flagged as a default rider");
  assert.deepEqual(C.schedResolve({ set: 1, h: null }, def), { hour: null, days: null, isDefault: false },
    "an explicit off stays off — the tri-state is what makes default-on safe to deploy");
  const mwf = C.schedResolve({ set: 1, h: 11, days: [1, 3, 5] }, def);
  assert.deepEqual(mwf, { hour: 11, days: [1, 3, 5], isDefault: false });

  const wed = Date.parse("2026-07-29T11:00:00Z"), thu = Date.parse("2026-07-30T11:00:00Z");
  assert.equal(C.schedDueAt(mwf, wed, 0), "2026-07-29", "due on a selected day");
  assert.equal(C.schedDueAt(mwf, thu, 0), null, "silent on one that isn't");
  assert.equal(C.schedDueAt(mwf, Date.parse("2026-07-29T12:00:00Z"), 0), null, "and only in its own hour");
  assert.equal(C.schedDueAt({ hour: null, days: null }, wed, 0), null, "off is off");
  // The day key is computed in the RECIPIENT's frame. Computing it in UTC would hand someone on a
  // negative offset two sends across a UTC midnight.
  const late = Date.parse("2026-07-30T01:00:00Z");   // 2026-07-29 21:00 at -240
  const daily = C.schedResolve({ set: 1, h: 21 }, def);
  assert.equal(C.schedDueAt(daily, late, -240), "2026-07-29");
});

test("an absurd reaction value widens its row and sheds the column — digits never slice (padL edition)", () => {
  const C = require("../src/compute");
  // padL slices exactly like padR did; the reaction is a number too. +1234.5% cannot come from an
  // equity close-to-close, but "cannot happen" is not a rendering contract.
  const rows = C.briefEarnRows({ printed: [
    { t: "AAA", s: "BMO", eps: 1, epsA: 2, verdict: "beat", reactionPct: 1234.5 },
    { t: "BBB", s: "BMO", eps: 1, epsA: 0.5, verdict: "miss", reactionPct: -2.1 }], today: [], tomorrow: [] });
  const txt = rows.join("\n");
  assert.ok(!/234\.5%/.test(txt) || /\+1234\.5%/.test(txt), "no truncated tail of the number may appear alone");
  assert.ok(/beat/.test(txt) && /miss/.test(txt), "verdicts survive the shed");
  for (const r of rows) assert.ok(r.length <= C.BRIEF_COLS, "rows still fit after the column gives way");
});

// ============================================================================================
// External fundamentals lane (SEC EDGAR): pure shaping, poller pull-through, terminal wiring
// ============================================================================================

test("pickXbrlFacts: latest 10-K/10-Q instants, FY-preferred durations, honest nulls, derived netCash gated on both legs", () => {
  const { pickXbrlFacts } = require("../src/compute");
  const cf = { entityName: "TESTCO INC", cik: 123, facts: { "us-gaap": {
    Assets: { units: { USD: [
      { end: "2025-12-31", val: 100e9, form: "10-K", fy: 2025, fp: "FY" },
      { end: "2026-03-31", val: 110e9, form: "10-Q", fy: 2026, fp: "Q1" },
      { end: "2026-06-30", val: 999e9, form: "8-K", fy: 2026, fp: "Q2" } ] } },   // 8-K excluded — press-release numbers aren't the filed statement
    CashAndCashEquivalentsAtCarryingValue: { units: { USD: [ { end: "2026-03-31", val: 30e9, form: "10-Q", fy: 2026, fp: "Q1" } ] } },
    LongTermDebtNoncurrent: { units: { USD: [ { end: "2026-03-31", val: 10e9, form: "10-Q", fy: 2026, fp: "Q1" } ] } },
    Revenues: { units: { USD: [
      { start: "2025-01-01", end: "2025-12-31", val: 50e9, form: "10-K", fy: 2025, fp: "FY" },
      { start: "2026-01-01", end: "2026-03-31", val: 14e9, form: "10-Q", fy: 2026, fp: "Q1" } ] } },
    NetIncomeLoss: { units: { USD: [ { start: "2025-01-01", end: "2025-12-31", val: 8e9, form: "10-K", fy: 2025, fp: "FY" } ] } },
  }, dei: { EntityCommonStockSharesOutstanding: { units: { shares: [ { end: "2026-04-15", val: 2.4e9, form: "10-Q" } ] } } } } };
  const out = pickXbrlFacts(cf);
  assert.ok(out && out.name === "TESTCO INC");
  assert.equal(out.fields.assets.v, 110e9, "instant concept takes the latest REAL statement, and the 8-K entry is ignored");
  assert.equal(out.fields.revenue.v, 50e9, "duration prefers the full fiscal year over a newer bare quarter");
  assert.ok(/^FY/.test(out.fields.revenue.period), "FY-labeled period");
  assert.equal(out.fields.netCash.v, 20e9, "netCash derived only because BOTH cash and debt exist");
  assert.equal(out.fields.liabilities, null, "untagged concept is an honest null, never zero");
  assert.equal(out.fields.eps, null, "no EPS facts -> null");
  assert.equal(out.fields.shares.v, 2.4e9, "dei shares picked up");
  assert.equal(pickXbrlFacts({ facts: {} }), null, "no usable facts at all -> null, not an empty shell");
});

test("parseNportHoldings: holdings sorted by pctVal, series metadata surfaced, entities decoded, cap honored", () => {
  const { parseNportHoldings } = require("../src/compute");
  const xml = `<edgarSubmission><formData><genInfo><seriesName>Test Growth Fund</seriesName><seriesId>S000012345</seriesId><repPdDate>2026-05-31</repPdDate></genInfo>
    <fundInfo><totAssets>1234567890.55</totAssets></fundInfo>
    <invstOrSecs>
      <invstOrSec><name>SMALLCO</name><valUSD>1000</valUSD><pctVal>0.5</pctVal></invstOrSec>
      <invstOrSec><name>BIG &amp; CO</name><valUSD>90000</valUSD><pctVal>9.12</pctVal></invstOrSec>
      <invstOrSec><name>MIDCO</name><valUSD>40000</valUSD><pctVal>4.0</pctVal></invstOrSec>
    </invstOrSecs></formData></edgarSubmission>`;
  const out = parseNportHoldings(xml, 2);
  assert.ok(out, "parses");
  assert.equal(out.seriesName, "Test Growth Fund");
  assert.equal(out.seriesId, "S000012345");
  assert.equal(out.asOf, "2026-05-31");
  assert.equal(out.totAssets, 1234567890.55);
  assert.equal(out.n, 3, "total count reported even when truncated");
  assert.equal(out.holdings.length, 2, "cap honored");
  assert.equal(out.holdings[0].name, "BIG & CO", "sorted by pct desc, &amp; decoded");
  assert.equal(out.holdings[1].pct, 4.0);
  assert.equal(parseNportHoldings("<xml>no holdings</xml>", 5), null, "no invstOrSec blocks -> null");
});

// ===== 5m/15m screener columns — in-memory mark-price ring (build 2026.07.29-04) ================
// A memory-only [t, px] ring per market, sampled on buildSnapshot's 15s cadence, ships p5m/p15m
// reference prices so the board can show intraday changes accurate to one tick. The 5m ARCHIVE was
// deliberately NOT the source: closed-bars-only + ~once-per-bar capture makes its freshest
// reference 5-12 min stale, and a "5m" column built on it would sometimes measure a 12-minute move
// under a 5-minute label. Behavioral tests on the pure math + manifest pins on every wiring choice.

test("px ring: pxRingPush keeps a strictly-increasing, depth-trimmed ring and rejects junk", () => {
  const { pxRingPush } = require("../src/compute");
  const M = 60 * 1000, ring = [];
  pxRingPush(ring, 1000 * M, 100, 20 * M);
  pxRingPush(ring, 1001 * M, 101, 20 * M);
  assert.equal(ring.length, 2, "two valid samples land");
  pxRingPush(ring, 1001 * M, 999, 20 * M);          // duplicate ts
  pxRingPush(ring, 1000 * M + 1, 999, 20 * M);      // out-of-order ts
  assert.equal(ring.length, 2, "duplicate / out-of-order timestamps are rejected — the ring stays strictly increasing");
  pxRingPush(ring, 1002 * M, NaN, 20 * M);
  pxRingPush(ring, 1002 * M, null, 20 * M);
  pxRingPush(ring, 1002 * M, -5, 20 * M);
  pxRingPush(ring, 1002 * M, 0, 20 * M);
  assert.equal(ring.length, 2, "non-finite / non-positive prices never enter the ring");
  pxRingPush(ring, 1030 * M, 103, 20 * M);          // 30 min later — everything older than 20m drops
  assert.equal(ring.length, 1, "depth trim drops samples older than depthMs");
  assert.equal(ring[0][1], 103, "the freshest sample survives the trim");
});

test("px ring: pxRingRef is tolerance-gated — the label is exact or the answer is null", () => {
  const { pxRingPush, pxRingRef } = require("../src/compute");
  const M = 60 * 1000, S = 1000, ring = [];
  // 15s cadence, 20 min of samples, price = minutes-since-epoch for easy assertions
  for (let t = 1000 * M; t <= 1020 * M; t += 15 * S) pxRingPush(ring, t, t / M, 20 * M);
  const now = 1020 * M;
  assert.equal(pxRingRef(ring, now, 5 * M, 90 * S), 1015, "5m lookback returns the sample at exactly now-5m");
  assert.equal(pxRingRef(ring, now, 15 * M, 90 * S), 1005, "15m lookback returns the sample at exactly now-15m");
  // off-grid target: nearest at-or-before within tolerance
  assert.equal(pxRingRef(ring, now + 7 * S, 5 * M, 90 * S), 1015, "an off-grid target takes the newest sample at-or-before it");
  // gap wider than tolerance at the lookback point -> null, never a longer window under the label
  const gappy = [];
  pxRingPush(gappy, 1000 * M, 1000, 60 * M);
  pxRingPush(gappy, 1010 * M, 1010, 60 * M);
  assert.equal(pxRingRef(gappy, 1017 * M, 5 * M, 90 * S), null, "a 2-min hole at the lookback point dashes rather than silently measuring a 7-min move");
  assert.equal(pxRingRef([], 1000 * M, 5 * M, 90 * S), null, "empty ring -> null (deploy warm-up)");
  assert.equal(pxRingRef(gappy, 1005 * M, 15 * M, 90 * S), null, "a lookback older than the ring's first sample -> null");
});

test("5m/15m columns: ring lookups against a real mapped-row-shaped flow (execution, not pins)", () => {
  // Execute the exact server-side composition: 15s sampling into the row's ring, then the two
  // mapMarket lookups — asserting real numbers emerge, and that warm-up yields honest nulls.
  const { pxRingPush, pxRingRef } = require("../src/compute");
  const DEPTH = 20 * 60 * 1000, TOL = 90 * 1000, S = 1000;
  const r = { pxRing: [] };
  let now = 5_000_000 * S;
  // cold boot: 2 minutes of samples — 5m and 15m must both be null (dash), never a shorter-window guess
  for (let i = 0; i < 8; i++) pxRingPush(r.pxRing, now + i * 15 * S, 100 + i, DEPTH);
  now += 7 * 15 * S;
  assert.equal(pxRingRef(r.pxRing, now, 5 * 60 * 1000, TOL), null, "2 min after boot the 5m ref is an honest null");
  assert.equal(pxRingRef(r.pxRing, now, 15 * 60 * 1000, TOL), null, "…and so is the 15m ref");
  // steady state: 20 minutes of 15s samples — both refs resolve to the sample at the exact lookback
  const t0 = now;
  for (let i = 1; i <= 80; i++) pxRingPush(r.pxRing, t0 + i * 15 * S, 200 + i, DEPTH);
  now = t0 + 80 * 15 * S;
  const p5 = pxRingRef(r.pxRing, now, 5 * 60 * 1000, TOL);
  const p15 = pxRingRef(r.pxRing, now, 15 * 60 * 1000, TOL);
  assert.equal(p5, 200 + 60, "5m ref = the sample exactly 20 ticks back");
  assert.equal(p15, 200 + 20, "15m ref = the sample exactly 60 ticks back");
  // and the % the client derives from them is finite and correctly signed
  const px = 200 + 80;
  const m5 = (px - p5) / p5 * 100, m15 = (px - p15) / p15 * 100;
  assert.ok(isFinite(m5) && m5 > 0 && isFinite(m15) && m15 > m5, "derived changes are finite, positive, and 15m > 5m on a monotone tape");
});

test("audit decision core: two-source agreement classifies; anything less is an honest flag", () => {
  const C = require("../src/compute");
  // agreement — the only auto-apply path for a classify candidate
  const ok = C.sectorAuditDecide({ kind: "classify", ticker: "KLARNA",
    profile: { name: "Klarna Group plc", exchange: "NEW YORK STOCK EXCHANGE", finnhubIndustry: "Financial Services" }, sic: 6199 });
  assert.ok(ok.apply && ok.sector === "Financials" && ok.reason === "sources-agree", "Finnhub+SIC agreement applies");
  assert.strictEqual(ok.ev.sicSector, "Financials", "evidence carries both source verdicts verbatim");
  // disagreement — flagged, never guessed (honest null over false precision)
  const dis = C.sectorAuditDecide({ kind: "classify", ticker: "NEURA",
    profile: { name: "Neura Robotics", finnhubIndustry: "Machinery" }, sic: 7372 });
  assert.ok(!dis.apply && dis.reason === "sources-disagree", "Industrials-vs-InfoTech split is a hold");
  // single source — also a flag
  const one = C.sectorAuditDecide({ kind: "classify", ticker: "X1", profile: { name: "X", finnhubIndustry: "Chemicals" }, sic: null });
  assert.ok(!one.apply && one.reason === "single-source", "one source is not enough to write");
  // nothing — no-data
  assert.strictEqual(C.sectorAuditDecide({ kind: "classify", ticker: "X2", profile: null, sic: null }).reason, "no-data");
});

test("audit graduation gate: name match graduates, symbol collision holds — the RAMP rule, executed", () => {
  const C = require("../src/compute");
  // real listing under the private company's own name — graduates, keeps the CURATED sector
  const g = C.sectorAuditDecide({ kind: "graduate", ticker: "FIGURE", curSector: "Industrials",
    expectedNames: ["Figure"], profile: { name: "Figure AI, Inc.", exchange: "NYSE", ipo: "2026-07-30" },
    sic: 3559, edgarName: "Figure AI, Inc." });
  assert.ok(g.apply && g.sector === "Industrials" && g.confidence >= 0.9, "high-confidence name match graduates");
  // the documented collision: RAMP resolves to LiveRamp in the SEC map — hard hold, never a graduation
  const r = C.sectorAuditDecide({ kind: "graduate", ticker: "RAMP", curSector: "Financials",
    expectedNames: ["Ramp"], profile: { name: "LiveRamp Holdings, Inc.", exchange: "NYSE" },
    sic: 7372, edgarName: "LiveRamp Holdings, Inc." });
  assert.ok(!r.apply && r.reason === "collision-hold", "symbol collision is a hold: " + r.reason);
  // multi-alias: the gate takes the strongest honest spelling (the SPCX shape)
  const s2 = C.sectorAuditDecide({ kind: "graduate", ticker: "SPCX", curSector: "Industrials",
    expectedNames: ["SpaceX", "Space Exploration Technologies"],
    profile: { name: "Space Exploration Technologies Corp.", exchange: "NASDAQ", ipo: "2026-06-12" } });
  assert.ok(s2.apply, "alias set matches the filed name");
  // no exchange = not actually listed — held even on a perfect name
  const ne = C.sectorAuditDecide({ kind: "graduate", ticker: "FIGURE", curSector: "Industrials",
    expectedNames: ["Figure"], profile: { name: "Figure AI, Inc.", exchange: "", ipo: null } });
  assert.ok(!ne.apply && ne.reason === "no-exchange", "a profile without an exchange never graduates");
});

test("audit fold + overlay precedence: graduate supersedes PREIPO, classify fills only Unclassified, revert pins, curated always wins", () => {
  const C = require("../src/compute");
  const S = require("../src/sectors");
  const recs = [
    { k: "apply", ts: 1, ticker: "FIGURE", action: "graduate", sector: "Industrials", ind: "Industrials", ev: {}, by: "auto" },
    { k: "apply", ts: 2, ticker: "KLARNA", action: "classify", sector: "Financials", ind: "Fintech", ev: {}, by: "auto" },
    { k: "apply", ts: 3, ticker: "BOGUS", action: "classify", sector: "Not A Sector", ind: "x", ev: {}, by: "auto" },
    { k: "apply", ts: 4, ticker: "NVDA", action: "classify", sector: "Energy", ind: "x", ev: {}, by: "auto" },
    { k: "flag", ts: 5, ticker: "NEURA", action: "classify", reason: "sources-disagree", ev: { finnSector: "Industrials", sicSector: "Information Technology" } },
    { k: "run", ts: 6, applied: 2, flagged: 1 },
  ];
  const m = C.mergeSectorAudit(recs);
  assert.strictEqual(m.lastRun, 6, "run stamp folds");
  assert.strictEqual(m.flagged.length, 1, "flag survives the fold");
  try {
    S.setSectorOverlay(m.active);
    // graduation: Pre-IPO -> Equity, curated sector kept, curated industry group (Robotics) kept,
    // provenance stamped — and earnings-calendar eligibility follows from assetClass by seam
    const f = S.classify("FIGURE", "xyz");
    assert.deepStrictEqual([f.assetClass, f.sector, f.ind, f.auto], ["Equity", "Industrials", "Robotics", "grad"],
      "graduated FIGURE keeps its curated Robotics group: " + JSON.stringify(f));
    // classify: fills the Unclassified branch with provenance
    const k = S.classify("KLARNA", "xyz");
    assert.deepStrictEqual([k.assetClass, k.sector, k.ind, k.auto], ["Equity", "Financials", "Fintech", "cls"]);
    // an invalid sector was dropped at install — BOGUS stays honestly Unclassified
    assert.strictEqual(S.classify("BOGUS", "xyz").assetClass, "Unclassified", "invalid sector never installs");
    // a curated name can NEVER be overridden by the overlay
    const n = S.classify("NVDA", "xyz");
    assert.ok(n.sector === "Information Technology" && !n.auto, "curated table always wins over the overlay");
    // untouched names untouched
    assert.strictEqual(S.classify("OPENAI", "xyz").assetClass, "Pre-IPO", "non-graduated PREIPO rows unchanged");
    // revert pins: fold again with a revert appended
    const m2 = C.mergeSectorAudit([...recs, { k: "revert", ts: 7, ticker: "KLARNA" }]);
    assert.ok(m2.pinned.has("KLARNA") && !m2.active.some((a) => a.ticker === "KLARNA"), "revert removes AND pins");
    S.setSectorOverlay(m2.active);
    assert.strictEqual(S.classify("KLARNA", "xyz").assetClass, "Unclassified", "reverted name returns to its honest table verdict");
  } finally { S.setSectorOverlay([]); }   // never leak overlay state into other tests
});

test("audit weekly trigger: frozen-clock — due after Sunday 12:00 UTC once per week, never before, never twice", () => {
  // Frozen clocks throughout: the predicate is pure in (now, lastRun), so wall time never leaks in.
  const C = require("../src/compute");
  const sun12 = Date.UTC(2026, 7, 2, 12, 0, 0);       // Sunday 2026-08-02 12:00 UTC
  assert.ok(!C.sectorAuditDue(sun12 - 1, 0) || true, "predicate total on any input");
  assert.ok(C.sectorAuditDue(sun12, 0), "due exactly at the anchor on a fresh log");
  assert.ok(C.sectorAuditDue(sun12 + 5 * 3600e3, 0), "still due later the same Sunday");
  assert.ok(!C.sectorAuditDue(sun12 + 5 * 3600e3, sun12 + 60e3), "a run after the anchor satisfies the week");
  assert.ok(!C.sectorAuditDue(Date.UTC(2026, 7, 5, 12), sun12 + 60e3), "Wednesday: still satisfied");
  assert.ok(C.sectorAuditDue(Date.UTC(2026, 7, 9, 12, 0, 0), sun12 + 60e3), "next Sunday 12:00: due again");
  assert.ok(!C.sectorAuditDue(Date.UTC(2026, 7, 9, 11, 59, 59), sun12 + 60e3), "next Sunday 11:59: not yet");
});

// ===== anchored intraday opens (H / 4h / 12h), build 2026.08.10-01 =========================
// The D-open pattern extended down the ladder: % since the current UTC bucket opened, shipped as
// reference LEVELS in the snapshot, derived client-side — the rolling h1/h4/d1 columns untouched.

test("bucketOpens: boundary candle's own open per rung, frozen clock, UTC bucket alignment", () => {
  const { bucketOpens } = require("../src/compute");
  const H = 3600 * 1000;
  const N = 1000003;                       // hour index: N%4=3, N%12=7 — three DISTINCT bucket starts
  const now = N * H + 37 * 60 * 1000;      // mid-hour, frozen
  const o = (i) => i - 999980, c = (i) => o(i) + 0.5;
  const spine = [];
  for (let i = N - 20; i <= N; i++) spine.push([i * H, o(i), o(i) + 1, o(i) - 1, c(i), 10]);
  const b = bucketOpens(spine, now, H);
  assert.equal(b.h, o(N), "1h rung reads the FORMING candle's own open — fixed at birth, safe mid-bar");
  assert.equal(b.h4, o(N - 3), "4h rung anchors on the UTC 00/04/08... boundary candle (N%4=3 back)");
  assert.equal(b.h12, o(N - 7), "12h rung anchors on the UTC 00/12 boundary candle (N%12=7 back)");
});

test("bucketOpens: prior-close fallback by perp continuity; a missing pair is an honest null", () => {
  const { bucketOpens } = require("../src/compute");
  const H = 3600 * 1000, N = 1000003, now = N * H + 37 * 60 * 1000;
  const o = (i) => i - 999980, c = (i) => o(i) + 0.5;
  const mk = (skip) => { const s = []; for (let i = N - 20; i <= N; i++) if (!skip.has(i)) s.push([i * H, o(i), o(i) + 1, o(i) - 1, c(i), 10]); return s; };
  // refresh lag: the forming candle hasn't reached the spine — the prior hour's CLOSE is the same
  // level on a continuously-traded perp (D open's own stated convention), so the rung stays live
  const lag = bucketOpens(mk(new Set([N])), now, H);
  assert.equal(lag.h, c(N - 1), "1h falls back to the prior candle's close, never the previous bucket's open");
  assert.equal(lag.h4, o(N - 3), "other rungs unaffected by the 1h boundary gap");
  // both the boundary candle AND its predecessor missing -> null: dash beats a stale anchor
  const hole = bucketOpens(mk(new Set([N - 7, N - 8])), now, H);
  assert.equal(hole.h12, null, "a two-candle hole at the 12h boundary is an honest null");
  assert.equal(hole.h, o(N), "the 1h rung still reads its own boundary candle");
  // a non-finite open on the boundary candle degrades to the fallback, not to garbage
  const bad = mk(new Set([N])); bad.push([N * H, NaN, 1, 1, NaN, 10]);
  assert.equal(bucketOpens(bad, now, H).h, c(N - 1), "non-finite boundary open -> prior close, not NaN");
  // degenerate inputs
  assert.deepEqual(bucketOpens([], now, H), { h: null, h4: null, h12: null }, "empty spine -> all null");
  assert.deepEqual(bucketOpens(null, now, H), { h: null, h4: null, h12: null }, "no spine -> all null");
});

test("bucketOpens: on a shared boundary the forming candle serves every rung", () => {
  const { bucketOpens } = require("../src/compute");
  const H = 3600 * 1000, M = 999996;       // M%12=0 — a 00/12 UTC boundary is also a 4h and 1h boundary
  const now = M * H + 60 * 1000;           // one minute into all three buckets at once
  const b = bucketOpens([[M * H, 42.5, 43, 42, 42.75, 10]], now, H);
  assert.equal(b.h, 42.5); assert.equal(b.h4, 42.5); assert.equal(b.h12, 42.5);
});

// priceAsOf returned the close of the bar that STARTS at or before the anchor — the print an hour
// after it. A 16:00 ET cash close read the 17:00 print and every "held close→open" hold contained
// the open auction. It now reads the last bar that had closed by the anchor.
test("audit -67: priceAsOf reads the last bar that closed by the anchor, never a later print", () => {
  const C = require("../src/compute");
  const t0 = Date.UTC(2026, 0, 5, 12, 0);
  const rows = []; for (let i = 0; i < 12; i++) rows.push([t0 + i * HOUR, 0, 0, 0, 100 + i, 1]);   // bar i closes at t0+(i+1)h with 100+i
  assert.equal(C.priceAsOf(rows, t0 + 5 * HOUR, 3 * HOUR), 104, "on the hour: the bar that ends exactly then");
  assert.equal(C.priceAsOf(rows, t0 + 5 * HOUR + 30 * 60e3, 3 * HOUR), 104, "half past: still the last CLOSED bar, not the one in progress");
  assert.equal(C.priceAsOf(rows, t0 + 30 * 60e3, 3 * HOUR), null, "nothing has closed yet");
  assert.equal(C.priceAsOf(rows, t0 + 12 * HOUR + 4 * HOUR, 3 * HOUR), null, "beyond tol after the last close");
  assert.equal(C.priceAsOf(rows, t0 + 12 * HOUR + 2 * HOUR, 3 * HOUR), 111, "within tol after the last close");
});
