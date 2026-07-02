"use strict";
// Run with: npm test  (uses Node's built-in test runner, no dependencies)
const test = require("node:test");
const assert = require("node:assert");
const { classify } = require("../src/sectors");
const { stdev, median, linregR2, priceAt, featuresFromHourly, oiDeltaPct, pearson, meanPairwiseCorr } = require("../src/compute");

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
