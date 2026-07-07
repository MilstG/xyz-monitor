"use strict";
// Run with: npm test  (uses Node's built-in test runner, no dependencies)
const test = require("node:test");
const assert = require("node:assert");
const { classify } = require("../src/sectors");
const { stdev, median, linregR2, priceAt, featuresFromHourly, oiDeltaPct, pearson, meanPairwiseCorr, studyBreakdown, playbook } = require("../src/compute");

const HOUR = 3600 * 1000, DAY = 86400 * 1000;

test("classify: core equities map to GICS sectors", () => {
  assert.equal(classify("AAPL").sector, "Information Technology");
  assert.equal(classify("NVDA").sector, "Information Technology");
  assert.equal(classify("JPM").sector, "Financials");
  assert.equal(classify("LLY").sector, "Health Care");
  assert.equal(classify("TSLA").sector, "Consumer Discretionary");
});

test("classify: CL is WTI crude, not Colgate (collision regression)", () => {
  assert.equal(classify("CL").sector, "Commodity");
  assert.equal(classify("GOLD").sector, "Commodity");
  assert.equal(classify("NATGAS").sector, "Commodity");
});

test("classify: indices, ETFs, FX, crypto, commodities", () => {
  assert.equal(classify("SP500").sector, "Index");
  assert.equal(classify("XYZ100").sector, "Index");
  assert.equal(classify("EWY").assetClass, "ETF");
  assert.equal(classify("XLE").sector, "Energy");
  assert.equal(classify("SMH").sector, "Information Technology");
  assert.equal(classify("EURUSD").sector, "FX");
  assert.equal(classify("EUR").sector, "FX");   // bare currency
  assert.equal(classify("NOK").sector, "FX");   // krone (flagged: could be Nokia)
  assert.equal(classify("BTC").sector, "Crypto");
});

test("classify: dex-specific pre-IPO / thematic tickers", () => {
  assert.equal(classify("SPCX").assetClass, "Pre-IPO");
  assert.equal(classify("SPCX").sector, "Industrials");
  assert.equal(classify("ZHIPU").sector, "Information Technology");
  assert.equal(classify("STRC").sector, "Financials");
  assert.equal(classify("DRAM").sector, "Thematic");
});

test("classify: unknown ticker stays Unclassified (never guessed)", () => {
  assert.equal(classify("TOTALLYMADEUPXYZ").sector, "Unclassified");
  assert.equal(classify("").sector, "Unclassified");
});

test("classify: dex-prefixed coin resolves by ticker part", () => {
  const t = "SP500"; // caller strips the dex prefix; classify is given the ticker
  assert.equal(classify(t).sector, "Index");
});

test("stats: stdev / median / linregR2", () => {
  assert.equal(median([3, 1, 2]), 2);
  assert.equal(median([1, 2, 3, 4]), 2.5);
  assert.ok(Math.abs(stdev([2, 4, 4, 4, 5, 5, 7, 9]) - 2.138) < 0.01);
  const { r2 } = linregR2([1, 2, 3, 4, 5]); // perfectly linear
  assert.ok(r2 > 0.999);
});

test("priceAt: nearest candle within tolerance", () => {
  const c = [{ t: 1000, c: "10" }, { t: 2000, c: "20" }, { t: 3000, c: "30" }];
  assert.equal(priceAt(c, 2100, 500), 20);
  assert.equal(priceAt(c, 9000, 500), null); // outside tolerance
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

const C = require("../src/compute");
test("US market calendar: holidays, observance shifts, early closes", () => {
  assert.equal(C.usDayStatus(2026, 7, 3), 2);    // Jul 4 2026 is a Saturday -> observed Friday, fully closed
  assert.equal(C.usDayStatus(2025, 7, 4), 2);    // Independence Day on a Friday
  assert.equal(C.usDayStatus(2025, 7, 3), 1);    // early close when Jul 4 falls Tue-Fri
  assert.equal(C.usDayStatus(2026, 11, 26), 2);  // Thanksgiving
  assert.equal(C.usDayStatus(2026, 11, 27), 1);  // Friday after: 13:00 ET close
  assert.equal(C.usDayStatus(2026, 4, 3), 2);    // Good Friday (computus)
  assert.equal(C.usDayStatus(2026, 7, 8), 0);    // ordinary Wednesday
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

test("EV_META horizons align with the studies' sign conventions", () => {
  assert.equal(C.EV_META.bigmove.horizonMs, DAY);
  assert.equal(C.EV_META.breakout.horizonMs, 5 * DAY);
  assert.equal(C.EV_META.gap.horizonMs, null);      // gap resolves at the next session close, calendar-aware
});

test("shadow-variant promotion: strict out-of-sample gates", () => {
  const inc = { n: 40, hit: 0.55, avg: 0.20 };
  assert.ok(C.shouldPromote(inc, { n: 34, hit: 0.58, avg: 0.31 }), "clear beat promotes");
  assert.ok(!C.shouldPromote(inc, { n: 22, hit: 0.60, avg: 0.40 }), "n<30 never promotes");
  assert.ok(!C.shouldPromote({ n: 12, hit: 0.5, avg: 0.1 }, { n: 40, hit: 0.6, avg: 0.4 }), "incumbent must also have 30");
  assert.ok(!C.shouldPromote(inc, { n: 40, hit: 0.57, avg: 0.25 }), "margin below 0.08 does not promote");
  assert.ok(!C.shouldPromote(inc, { n: 40, hit: 0.40, avg: 0.35 }), "hit collapse blocks tail-riders");
  assert.ok(!C.shouldPromote({ n: 40, hit: 0.45, avg: -0.10 }, { n: 40, hit: 0.46, avg: -0.01 }), "challenger expectancy must be positive");
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
