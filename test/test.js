"use strict";
// Run with: npm test  (uses Node's built-in test runner, no dependencies)
const test = require("node:test");
const assert = require("node:assert");
const { classify } = require("../src/sectors");
const { stdev, median, linregR2, priceAt, featuresFromHourly, oiDeltaPct, pearson, meanPairwiseCorr, studyBreakdown, playbook, confSplit, studyOIFlush, studyFPDiv, offDriftStats } = require("../src/compute");

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

test("ondrift playbook: windowed-hold claim, no levels", () => {
  const pLong=playbook("ondrift",{dir:1}), pShort=playbook("ondrift",{dir:-1});
  assert.equal(pLong.side,"long"); assert.equal(pShort.side,"short");
  assert.equal(pLong.target,null); assert.equal(pLong.stop,null);
});

test("ledger unit repair + getLedgerFor: R-normalization, idempotency, shadow exclusion", () => {
  const { createPoller } = require("../src/poller");
  const now = Date.now();
  const fixture = { ts: now, rearm: [], variants: null,
    open: [
      { key: "xyz:AAPL|breakout", coin: "xyz:AAPL", ticker: "AAPL", ev: "breakout", t0: now - 3600000,
        mark0: 200, dir: 1, score0: 61, sd0: 1.8, resolveAt: now + 86400000, psd: "long", bt: 1 },
      { key: "xyz:AAPL|bigmove#1", coin: "xyz:AAPL", ticker: "AAPL", ev: "bigmove", t0: now - 3600000,
        mark0: 200, dir: 1, score0: 0, sd0: 1.8, resolveAt: now + 86400000, vi: 1 },   // shadow — must never surface
    ],
    closed: [
      // breakdown resolved pre-fix: raw % despite sd0 stamped -> must repair to R (-4.4/2.2 = -2)
      { key: "xyz:AAPL|breakdown", coin: "xyz:AAPL", ticker: "AAPL", ev: "breakdown", t0: now - 5 * 86400000,
        mark0: 210, dir: -1, score0: 55, sd0: 2.2, status: "resolved", tR: now - 86400000,
        realized: -4.4, realizedS: -4.4, win: false, winS: false, psd: "short" },
      // stopped oiflush pre-fix: realized and the stop-capped leg both repair independently
      { key: "xyz:AAPL|oiflush", coin: "xyz:AAPL", ticker: "AAPL", ev: "oiflush", t0: now - 9 * 86400000,
        mark0: 190, dir: 1, score0: 48, sd0: 3, status: "resolved", tR: now - 4 * 86400000,
        realized: 6.6, realizedS: -3, stopped: true, win: true, winS: false },
      // breakout resolved under the OLD code: already R, no rn stamp -> must NOT be touched
      { key: "xyz:AAPL|breakout", coin: "xyz:AAPL", ticker: "AAPL", ev: "breakout", t0: now - 12 * 86400000,
        mark0: 180, dir: 1, score0: 70, sd0: 2, status: "resolved", tR: now - 7 * 86400000,
        realized: 1.5, realizedS: 1.5, win: true, winS: true, psd: "long" },
      // pre-sigma-epoch breakdown (no sd0): untouched, surfaces as legacy %
      { key: "xyz:AAPL|breakdown#old", coin: "xyz:AAPL", ticker: "AAPL", ev: "breakdown", t0: now - 40 * 86400000,
        mark0: 250, dir: -1, score0: 40, status: "resolved", tR: now - 35 * 86400000,
        realized: 3.1, realizedS: 3.1, win: true, winS: true },
      // different coin — must not leak into AAPL's history
      { key: "xyz:NVDA|breakdown", coin: "xyz:NVDA", ticker: "NVDA", ev: "breakdown", t0: now - 5 * 86400000,
        mark0: 100, dir: -1, score0: 50, sd0: 2, status: "resolved", tR: now - 86400000,
        realized: -2, realizedS: -2, win: false, winS: false },
    ] };
  const store = { loadAll: () => new Map(), loadRegime: () => [], loadLedger: () => fixture,
    saveLedger: () => {}, insert: () => {}, saveRegime: () => {} };
  const p = createPoller({ dex: "xyz", store, log: () => {}, version: "test", crypto: false });
  p.hydrateLedgerNow();
  p.hydrateLedgerNow();   // idempotency: the rn stamp must make a second pass a no-op
  const h = p.getLedgerFor("xyz:AAPL");
  assert.equal(h.open.length, 1, "shadow-variant claims never surface");
  assert.equal(h.open[0].status, "open");
  assert.ok(h.open[0].resolveAt > now, "open claim carries its horizon");
  assert.equal(h.open[0].boot, true, "first-build-after-restart flag surfaces");
  assert.equal(h.open[0].mark0, 200, "per-instance trigger mark surfaces");
  assert.equal(h.closed.length, 4, "only this coin's visible closed claims");
  const by = {}; for (const e of h.closed) by[e.ev + (e.legacy ? ":legacy" : "")] = e;
  assert.equal(by.breakdown.realized, -2, "raw-% breakdown repaired to R (-4.4/2.2)");
  assert.equal(by.breakdown.realizedS, -2, "non-stopped stop-aware leg tracks the repaired outcome");
  assert.equal(by.breakdown.unit, "R");
  assert.equal(by.oiflush.realized, 2.2, "stopped oiflush repaired (6.6/3)");
  assert.equal(by.oiflush.realizedS, -1, "stop-capped leg repaired independently (-3/3)");
  assert.equal(by.oiflush.stopped, true);
  assert.equal(by.breakout.realized, 1.5, "already-normalized original-three entry untouched");
  assert.equal(by["breakdown:legacy"].realized, 3.1, "pre-sigma-epoch entry untouched");
  assert.equal(by["breakdown:legacy"].unit, "%", "legacy entry labeled in its true unit");
  assert.equal(by["breakdown:legacy"].legacy, true);
  assert.equal(p.getLedgerFor("xyz:NVDA").closed.length, 1, "history is per-coin");
  assert.equal(p.getLedgerFor("").open.length, 0, "no filter -> empty history");
  const byEv = p.getLedgerFor("", "breakdown");
  assert.equal(byEv.closed.length, 3, "event filter crosses tickers (2 AAPL + 1 NVDA)");
  assert.ok(byEv.closed.every(e => e.ev === "breakdown"), "event filter is exact");
  assert.ok(byEv.closed.some(e => e.tk === "NVDA"), "cross-ticker rows carry their ticker");
  assert.equal(p.getLedgerFor("xyz:AAPL", "breakdown").closed.length, 2, "coin+event filters combine");
  assert.equal(p.getLedgerFor("xyz:AAPL", "breakdown").open.length, 0, "combined filter excludes other events\' open claims");
});

test("ledger export: raw completeness, shadow/legacy accounting, self-describing meta, route wiring", () => {
  const { createPoller } = require("../src/poller");
  const now = Date.now();
  const fixture = { ts: now, rearm: [], variants: null,
    open: [
      { key: "xyz:AAPL|breakout", coin: "xyz:AAPL", ticker: "AAPL", ev: "breakout", t0: now - 3600000,
        mark0: 200, dir: 1, score0: 61, sd0: 1.8, resolveAt: now + 86400000, psd: "long" },
    ],
    closed: [
      // real resolved claim — raw shape must survive intact (key included; pub() would drop it)
      { key: "xyz:AAPL|breakdown", coin: "xyz:AAPL", ticker: "AAPL", ev: "breakdown", t0: now - 5 * 86400000,
        mark0: 210, dir: -1, score0: 55, sd0: 2.2, status: "resolved", tR: now - 86400000,
        realized: -2, realizedS: -2, rn: 1, win: false, winS: false, psd: "short" },
      // shadow variant — getLedgerFor hides it; the export MUST include and count it
      { key: "xyz:AAPL|bigmove#1", coin: "xyz:AAPL", ticker: "AAPL", ev: "bigmove", t0: now - 4 * 86400000,
        mark0: 205, dir: 1, score0: 0, sd0: 1.8, status: "resolved", tR: now - 3 * 86400000,
        realized: 0.4, vi: 1 },
      // legacy pre-sigma entry (R-united event, no sd0) — included and counted as legacy
      { key: "xyz:AAPL|breakdown#old", coin: "xyz:AAPL", ticker: "AAPL", ev: "breakdown", t0: now - 40 * 86400000,
        mark0: 250, dir: -1, score0: 40, status: "resolved", tR: now - 35 * 86400000,
        realized: 3.1, realizedS: 3.1, win: true, winS: true },
    ] };
  const store = { loadAll: () => new Map(), loadRegime: () => [], loadLedger: () => fixture,
    saveLedger: () => {}, insert: () => {}, saveRegime: () => {} };
  const p = createPoller({ dex: "xyz", store, log: () => {}, version: "test", crypto: false });
  p.hydrateLedgerNow();
  const x = p.getLedgerExport();
  assert.equal(x.meta.counts.closed, 3, "every retained closed entry ships — no 150 cap, no shadow pruning");
  assert.equal(x.meta.counts.open, 1);
  assert.equal(x.meta.counts.shadowsClosed, 1, "shadow variants counted");
  assert.equal(x.meta.counts.legacyClosed, 1, "pre-sigma legacy entries counted");
  assert.equal(x.meta.ctxStampSince, null, "no context-stamped entries yet -> honest null, not a fake epoch");
  assert.ok(x.closed.some(e => e.vi === 1), "shadow entry present in the dump");
  assert.ok(x.closed.every(e => typeof e.key === "string"), "raw internal shape — key survives (curated pub drops it)");
  assert.ok(x.variants && x.variants.state && typeof x.variants.stats === "object", "variant state + stats ship for the variant slices");
  for (const k of ["ev", "vi", "sd0", "stp", "realizedS", "fndP", "rngP", "mktR", "ses", "tal"])
    assert.ok(typeof x.meta.glossary[k] === "string" && x.meta.glossary[k].length, `glossary documents ${k}`);
  // route wiring: download header + no-store are pinned in server source (the manifest test
  // already pins the registration itself and the getLedgerExport getter's existence)
  const fs = require("fs"), path = require("path");
  const srv = fs.readFileSync(path.join(__dirname, "..", "server.js"), "utf8");
  assert.ok(srv.includes('attachment; filename="xyz-ledger-'), "export route serves as a dated download");
});

test("fire-time context stamp: computable fields frozen at openLedger, absent fields stay honestly absent", () => {
  const { createPoller } = require("../src/poller");
  const store = { loadAll: () => new Map(), loadRegime: () => [], loadLedger: () => null,
    saveLedger: () => {}, insert: () => {}, saveRegime: () => {} };
  const p = createPoller({ dex: "xyz", store, log: () => {}, version: "test", crypto: false });
  const now = Date.now(), HOURMS = 3600 * 1000;
  // benchmark row for the crypto universe: mktR must read BTC's 24h move
  p.seedRowNow("BTC", { px: 100000, d1: 2.5 });
  // target: main-universe coin opening an AIREAD claim (the sole crypto-legal event since
  // -101) with a funding history rich enough to clear the >=96-sample
  // percentile floor, a 30d range, and a live rate sitting at a known rank in its own history
  const fundH = new Map();
  for (let i = 0; i < 100; i++) fundH.set(now - (100 - i) * HOURMS, (i + 1) / 1e6);   // ranks 1..100
  p.seedRowNow("ETH", { px: 3000, funding: 75 / 1e6, fundH, feat: { hi30: 3200, lo30: 2800 } });
  const eRef = p.openLedgerNow("ETH", "bigmove", { score: 10, reading: "" }, 1, { sd0: 2 });
  assert.equal(eRef, null, "crypto signal claims refused at openLedger — the engine is xyz-only (-101)");
  const e = p.openLedgerNow("ETH", "airead", { score: 10, reading: "" }, 1, { sd0: 2 });
  assert.ok(e, "airead claim opened — the analyst record is exempt from the crypto removal");
  assert.equal(e.fnd, 75 / 1e6, "funding rate frozen at fire");
  assert.ok(e.fndP >= 73 && e.fndP <= 77, `funding percentile ~75 from the seeded ranks, got ${e.fndP}`);
  assert.equal(e.rngP, 0.5, "px 3000 sits exactly mid-range 2800..3200");
  assert.equal(e.mktR, 2.5, "benchmark 24h move stamped from BTC for a main-universe coin");
  assert.ok(Number.isInteger(e.dow) && e.dow >= 0 && e.dow <= 6, "UTC day-of-week always stamped");
  assert.equal(e.ses, undefined, "session bucket is xyz-only — absent on crypto, not null-padded");
  assert.equal(e.oi5, undefined, "no OI history -> oi5 honestly absent");
  assert.equal(e.sd0, 2, "extra fields untouched by the stamp");
  // xyz claim: session bucket present and valid; thin row -> everything else absent except dow
  p.seedRowNow("xyz:ACME", { px: 50, ticker: "ACME" });
  const e2 = p.openLedgerNow("xyz:ACME", "breakout", { score: 5, reading: "" }, 1, { sd0: 1.5 });
  assert.ok(["rth", "on", "wknd"].includes(e2.ses), `xyz claim carries a session bucket, got ${e2.ses}`);
  assert.equal(e2.fnd, undefined, "no funding -> absent");
  assert.equal(e2.rngP, undefined, "no features -> absent");
  assert.ok(Number.isInteger(e2.dow), "dow stamped");
  // shadow claims get the same stamp — variant slices need identical features
  const e3 = p.openLedgerNow("ETH", "airead", { score: 0, reading: "" }, 1, { sd0: 2 }, 1);
  assert.ok(e3 && e3.vi === 1 && e3.fnd === 75 / 1e6 && Number.isInteger(e3.dow), "shadow claim carries the stamp too");
  // stamped claims surface in the export with a coverage epoch once closed
  const x = p.getLedgerExport();
  assert.equal(x.meta.counts.open, 3);
  assert.ok(x.open.every(o => Number.isInteger(o.dow)), "export ships the raw stamped fields");
});

test("swing shadow setups: detectors, geometry, fundflip stop, gapfade wiring, EV_META horizons", () => {
  const C = require("../src/compute");
  // ---- 50d-MA pullback: build an uptrend, then place the mark exactly at the MA
  const now = Date.now(), closes = [];
  for (let i = 0; i < 70; i++) closes.push([now - (70 - i) * DAY, 100 * Math.pow(1.004, i)]);
  const c = closes.map((k) => k[1]);
  const m0 = c.slice(-50).reduce((a, b) => a + b, 0) / 50;
  const mp = C.detectMAPull(closes, m0 * 1.005, 2);
  assert.ok(mp, "rising-MA pullback fires when the mark sits at the MA");
  assert.ok(Math.abs(mp.ma - m0) / m0 < 1e-5, "MA frozen as computed (6-sig-fig quantized)");
  assert.ok(mp.stop < m0 * 1.005 && mp.target > m0 * 1.005, "tradeable geometry: stop below, target above");
  assert.ok(Math.abs(mp.stop - m0 * 0.98) / m0 < 1e-5, "stop is 1σ(30d) below the MA");
  assert.equal(C.detectMAPull(closes, m0 * 1.05, 2), null, "mark far above the MA: no pullback, no fire");
  assert.equal(C.detectMAPull(closes, m0 * 0.97, 2), null, "mark through the MA: broken, not touching");
  const down = closes.map((k, i) => [k[0], 100 * Math.pow(0.996, i)]);
  assert.equal(C.detectMAPull(down, down[down.length - 1][1], 2), null, "falling MA50 never fires");
  assert.equal(C.detectMAPull(closes.slice(-40), m0, 2), null, "under 60 closes: honest null");
  // ---- failed-breakdown reclaim: flat range, fresh 3-session flush below the 30d low, mark back above
  const flat = []; for (let i = 0; i < 45; i++) flat.push([now - (45 - i) * DAY, 100 + ((i * 7) % 5) * 0.3]);
  const lo = Math.min(...flat.slice(-33, -3).map((k) => k[1]));
  flat[flat.length - 3][1] = lo - 2; flat[flat.length - 2][1] = lo - 3; flat[flat.length - 1][1] = lo - 1;
  const rc = C.detectReclaim(flat, lo + 0.4);
  assert.ok(rc, "fresh break + mark back above the level fires");
  assert.equal(rc.level, +lo.toPrecision(6), "level is the pre-flush 30d closing low");
  assert.equal(rc.stop, +(lo - 3).toPrecision(6), "stop is the flush low");
  assert.ok(Math.abs(rc.target - (lo + 3)) < 1e-9, "target is the measured move: level + (level - flush)");
  assert.equal(C.detectReclaim(flat, lo - 0.5), null, "mark still below the level: no reclaim");
  const stale = flat.map((k) => [k[0], k[1]]);
  stale[stale.length - 2][1] = lo + 1; stale[stale.length - 1][1] = lo + 1;   // break aged out: last two closes back above
  assert.equal(C.detectReclaim(stale, lo + 0.4), null, "an old wound is not a fresh trap");
  // ---- fundflip playbook stop (ops item 3): 1σ against the flip; legacy no-ctx shape unchanged
  const ffL = C.playbook("fundflip", { dir: 1, px: 100, sd30: 2 });
  assert.equal(ffL.side, "long"); assert.equal(ffL.stop, 98);
  const ffS = C.playbook("fundflip", { dir: -1, px: 100, sd30: 2 });
  assert.equal(ffS.side, "short"); assert.equal(ffS.stop, 102);
  assert.equal(C.playbook("fundflip", { dir: -1 }).stop, null, "no px/σ context: legacy null stop");
  // ---- EV_META: swing horizons + gapfade on the gap calendar
  assert.equal(C.EV_META.reclaim.horizonMs, 5 * DAY);
  assert.equal(C.EV_META.mapull.horizonMs, 10 * DAY);
  assert.equal(C.EV_META.gapfade.horizonMs, null, "gapfade resolves at the next session close, like gap");
  // ---- wiring pins: the fire sites and calendar branch exist in the poller
  const fs = require("fs"), path = require("path");
  const pol = fs.readFileSync(path.join(__dirname, "..", "src", "poller.js"), "utf8");
  assert.ok(pol.includes('openLedger(r, "gapfade"'), "gapfade shadow fire site present");
  assert.ok(pol.includes("[1, 1.5].forEach"), "both void widths ledger");
  assert.ok(pol.includes('ev === "gap" || ev === "gapfade"'), "gapfade rides the gap resolution calendar");
  assert.ok(pol.includes('openLedger(r, "reclaim"') && pol.includes('openLedger(r, "mapull"'), "swing shadow fire sites present");
  assert.ok(pol.includes('playbook("fundflip", { dir: s0, px: r.px, sd30 })'), "fundflip call site feeds the stop context");
});

test("strategy shadows: stop-aware resolution in R for vi-stamped claims, invisible to getLedgerFor", () => {
  const { createPoller } = require("../src/poller");
  const now = Date.now();
  const mk = (coin, stp) => ({ key: coin + "|reclaim#0", coin, ticker: coin, ev: "reclaim", t0: now - 6 * DAY,
    mark0: 100, dir: 1, score0: 0, sd0: 2, psd: "long", pn: 1, stp, vi: 0, resolveAt: now - DAY });
  const fixture = { ts: now, rearm: [], variants: null, closed: [],
    open: [mk("xyz:CLEAN", 95), mk("xyz:STOPPED", 99)] };
  const store = { loadAll: () => new Map(), loadRegime: () => [], loadLedger: () => fixture,
    saveLedger: () => {}, insert: () => {}, saveRegime: () => {} };
  const p = createPoller({ dex: "xyz", store, log: () => {}, version: "test", crypto: false });
  p.hydrateLedgerNow();
  // hourly spines covering fire -> horizon: CLEAN never nears its stop and drifts to 104;
  // STOPPED dips through 99 mid-window before closing at 104 — the touch must cap its leg
  const spine = (dip) => { const hs = []; for (let i = 160; i >= 0; i--) {
    const t = now - i * 3600e3; let px = 100 + (160 - i) * 0.025;
    if (dip && i > 60 && i < 70) px = 98.5;
    hs.push({ t, o: px, h: px + 0.2, l: px - 0.2, c: px, v: 1 }); } return hs; };
  p.seedRowNow("xyz:CLEAN", { px: 104, hourlyRaw: spine(false), hourlyTs: now });
  p.seedRowNow("xyz:STOPPED", { px: 104, hourlyRaw: spine(true), hourlyTs: now });
  p.buildSignalsNow();   // runs resolveLedger
  const x = p.getLedgerExport();
  const done = Object.fromEntries(x.closed.filter((e) => e.ev === "reclaim").map((e) => [e.coin, e]));
  assert.ok(done["xyz:CLEAN"] && done["xyz:CLEAN"].status === "resolved", "clean claim resolved");
  assert.ok(done["xyz:CLEAN"].rn === 1 && Math.abs(done["xyz:CLEAN"].realized - 1.5) < 0.3, `resolved in R (spine drifts ~3% over the hold / σ2 ≈ 1.5R), got ${done["xyz:CLEAN"].realized}`);
  assert.equal(done["xyz:CLEAN"].stopped, false, "stop never touched");
  assert.ok(Math.abs(done["xyz:CLEAN"].realizedS - done["xyz:CLEAN"].realized) < 1e-9, "untouched stop: legs coincide");
  assert.ok(done["xyz:STOPPED"] && done["xyz:STOPPED"].stopped === true, "dip through the void marks the claim stopped");
  assert.ok(done["xyz:STOPPED"].realizedS < 0 && done["xyz:STOPPED"].realized > 0,
    "stop-aware leg caps at the void while at-horizon rides to the target — the exact honesty split");
  assert.equal(p.getLedgerFor("xyz:CLEAN").closed.length, 0, "strategy shadows never surface in the claim browser");
});

test("ledger archive: overflow is appended to the volume before the retention trim", () => {
  const fs = require("fs"), path = require("path"), os = require("os");
  const { openStore } = require("../src/store");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "xyzarc-"));
  const s = openStore(dir);
  s.archiveClosed([{ key: "A|gap", realized: 1 }, { key: "B|gap", realized: -1 }]);
  s.archiveClosed([{ key: "C|prem", realized: 2 }]);
  s.archiveClosed([]);   // empty append is a no-op, not a blank line
  const lines = fs.readFileSync(path.join(dir, "ledger-archive.jsonl"), "utf8").trim().split("\n");
  assert.equal(lines.length, 3, "one JSON line per archived entry, append-only across calls");
  assert.equal(JSON.parse(lines[2]).key, "C|prem", "order preserved");
  // wiring pins: both trim sites archive first, guarded for mocks without the method
  const pol = fs.readFileSync(path.join(__dirname, "..", "src", "poller.js"), "utf8");
  assert.equal((pol.match(/store\.archiveClosed\(/g) || []).length >= 2 && pol.includes("if (store.archiveClosed)"), true,
    "resolver + hydrate trims archive before slicing, guarded");
});

test("HTF shadow batch 2: failbrk mirror, pead reaction gate (fundext retired with the crypto engine, -101)", () => {
  const C = require("../src/compute");
  const now = Date.now();
  // ---- failed-breakout fade: exact mirror of the reclaim trap
  const flat = []; for (let i = 0; i < 45; i++) flat.push([now - (45 - i) * DAY, 100 + ((i * 7) % 5) * 0.3]);
  const hi = Math.max(...flat.slice(-33, -3).map((k) => k[1]));
  flat[flat.length - 3][1] = hi + 2; flat[flat.length - 2][1] = hi + 3; flat[flat.length - 1][1] = hi + 1;
  const fb = C.detectFailBrk(flat, hi - 0.4);
  assert.ok(fb, "fresh break above + mark back below the level fires");
  assert.equal(fb.level, +hi.toPrecision(6), "level is the pre-flush 30d closing high");
  assert.equal(fb.stop, +(hi + 3).toPrecision(6), "stop is the flush high");
  assert.ok(Math.abs(fb.target - (hi - 3)) < 1e-9, "target is the inverted measured move");
  assert.equal(C.detectFailBrk(flat, hi + 0.5), null, "mark still above the level: no fade");
  const stale = flat.map((k) => [k[0], k[1]]);
  stale[stale.length - 2][1] = hi - 1; stale[stale.length - 1][1] = hi - 1;
  assert.equal(C.detectFailBrk(stale, hi - 0.4), null, "an aged-out break never fires");
  // ---- pead: completed outsized reaction drifts; AMC convention matches earnReactionsFor
  const dayOf = (t) => { const x = new Date(t); return x.getUTCFullYear() + "-" + String(x.getUTCMonth() + 1).padStart(2, "0") + "-" + String(x.getUTCDate()).padStart(2, "0"); };
  const daily = []; for (let i = 0; i < 30; i++) daily.push({ t: now - (30 - i) * DAY, c: 100, o: 100 });
  daily[27].c = 106;   // +6% reaction bar
  daily[28].c = 106.5; daily[29].c = 107;   // reaction session complete, drift underway
  const printsB = [{ t: "X", d: dayOf(daily[27].t), s: "BMO" }];
  const pd = C.detectPead(printsB, daily, 107, 2);
  assert.ok(pd && pd.side === "long", "BMO reaction bar is the print day itself");
  assert.equal(pd.mv, 6, "reaction magnitude frozen");
  assert.ok(pd.stop < 107 && pd.target > 107, "long geometry: stop below, target above");
  assert.ok(Math.abs(pd.stop - 106 * 0.98) < 1e-6, "stop 1σ back through the reaction close");
  assert.ok(Math.abs(pd.target - 107 * 1.03) < 1e-6, "target = half the reaction further from the mark");
  const printsA = [{ t: "X", d: dayOf(daily[26].t), s: "AMC" }];
  assert.ok(C.detectPead(printsA, daily, 107, 2), "AMC books the NEXT bar as the reaction — same convention as earnReactionsFor");
  assert.equal(C.detectPead(printsB, daily, 107, 5), null, "a reaction under 1.5σ is noise, not a REACTION");
  const incomplete = daily.slice(0, 28);   // reaction bar is the LAST bar — session not complete
  assert.equal(C.detectPead(printsB, incomplete, 106, 2), null, "no entry until the reaction session is complete");
  const old = [{ t: "X", d: dayOf(daily[20].t), s: "BMO" }];
  assert.equal(C.detectPead(old, daily, 107, 2), null, "a print older than 3 sessions has drifted without us — no chase");
  // ---- EV_META + wiring pins
  assert.equal(C.EV_META.failbrk.horizonMs, 5 * DAY);
  assert.equal(C.EV_META.pead.horizonMs, 10 * DAY);
  assert.ok(!C.EV_META.fundext && !C.EV_META.liqflush, "crypto-only shadow metas retired (-101)");
  const fs = require("fs"), path = require("path");
  const pol = fs.readFileSync(path.join(__dirname, "..", "src", "poller.js"), "utf8");
  for (const pin of ['openLedger(r, "failbrk"', 'openLedger(r, "pead"',
    'r.uni === "xyz" && r.dailyRaw', "function fundPctileNow"])
    assert.ok(pol.includes(pin), `poller wiring pin missing: ${pin}`);
  for (const gone of ['openLedger(r, "fundext"', 'openLedger(r, "liqflush"'])
    assert.ok(!pol.includes(gone), `crypto shadow fire site must stay removed: ${gone}`);
  // the fire-time context stamp and the AI crypto read still share ONE percentile code path
  assert.ok((pol.match(/fundPctileNow\(/g) || []).length >= 3, "fireCtx and the AI crypto block both route through the shared percentile helper");
});

test("off-site ledger backup: disabled by default, pushes via contents API, blob-sha skip, raw store reads", async () => {
  const fs = require("fs"), path = require("path"), os = require("os"), crypto = require("crypto");
  const { createPoller } = require("../src/poller");
  const { openStore } = require("../src/store");
  // store reads the raw persisted bytes — existing files only, verbatim
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "xyzbk-"));
  const st = openStore(dir);
  st.saveLedger({ ts: 1, open: [], closed: [], rearm: [] });
  let files = st.readBackupFiles();
  assert.equal(files.length, 1, "no archive yet -> ledger.json only, no phantom entries");
  assert.equal(files[0].name, "ledger.json");
  st.archiveClosed([{ key: "A|gap" }]);
  files = st.readBackupFiles();
  assert.equal(files.length, 2, "archive present -> both files ship");
  assert.equal(files[1].name, "ledger-archive.jsonl");
  assert.equal(files[0].content, fs.readFileSync(path.join(dir, "ledger.json"), "utf8"), "bytes verbatim, no re-serialization");
  // disabled unless BOTH env vars are set — a token alone or a repo alone does nothing
  const mkP = (storeArg) => createPoller({ dex: "xyz", store: storeArg, log: () => {}, version: "test", crypto: false });
  delete process.env.LEDGER_BACKUP_REPO; delete process.env.LEDGER_BACKUP_TOKEN; delete process.env.GITHUB_TOKEN;
  const calls = [];
  const mockFetch = (notFound) => async (url, opts) => {
    calls.push({ url, method: (opts && opts.method) || "GET", body: opts && opts.body ? JSON.parse(opts.body) : null, auth: opts && opts.headers && opts.headers.authorization });
    if (!opts || !opts.method) return notFound ? { ok: false, status: 404, json: async () => ({}) }
      : { ok: true, status: 200, json: async () => ({ sha: notFound === false ? mockFetch.sha : null }) };
    return { ok: true, status: 200, json: async () => ({}) };
  };
  let r = await mkP(st).backupLedgerNow(mockFetch(true));
  assert.deepEqual(r, { ok: false, disabled: true }, "no env -> disabled, zero network");
  assert.equal(calls.length, 0);
  // enabled: fresh repo (GETs 404) -> both files PUT with base64 content and auth header
  process.env.LEDGER_BACKUP_REPO = "MilstG/xyz-ledger-backup"; process.env.LEDGER_BACKUP_TOKEN = "tok123";
  try {
    const p = mkP(st);
    r = await p.backupLedgerNow(mockFetch(true));
    assert.deepEqual({ ok: r.ok, pushed: r.pushed, skipped: r.skipped }, { ok: true, pushed: 2, skipped: 0 }, JSON.stringify(r));
    const puts = calls.filter((c) => c.method === "PUT");
    assert.equal(puts.length, 2);
    assert.ok(puts.every((c) => c.url.startsWith("https://api.github.com/repos/MilstG/xyz-ledger-backup/contents/")), "contents API, right repo");
    assert.ok(puts.every((c) => c.auth === "Bearer tok123"), "token rides the auth header");
    assert.equal(Buffer.from(puts[0].body.content, "base64").toString("utf8"), files[0].content, "payload is the exact file bytes, base64d");
    assert.ok(puts.every((c) => c.body.branch === "main" && !("sha" in c.body)), "create path: no prior sha, default branch");
    // unchanged content: remote sha == git blob sha -> skipped, zero PUTs
    calls.length = 0;
    const blobSha = (s) => crypto.createHash("sha1").update("blob " + Buffer.byteLength(s, "utf8") + "\0").update(s, "utf8").digest("hex");
    const already = async (url, opts) => {
      calls.push({ method: (opts && opts.method) || "GET" });
      if (!opts || !opts.method) {
        const name = decodeURIComponent(url.split("/contents/")[1].split("?")[0]);
        const f = st.readBackupFiles().find((x) => x.name === name);
        return { ok: true, status: 200, json: async () => ({ sha: blobSha(f.content) }) };
      }
      throw new Error("PUT must not happen for unchanged content");
    };
    r = await p.backupLedgerNow(already);
    assert.deepEqual({ ok: r.ok, pushed: r.pushed, skipped: r.skipped }, { ok: true, pushed: 0, skipped: 2 }, "byte-identical backup is a no-op commit-wise");
    assert.equal(calls.filter((c) => c.method === "PUT").length, 0);
    // a failed PUT reports, never throws out of the job
    const broken = async (url, opts) => (!opts || !opts.method) ? { ok: false, status: 404, json: async () => ({}) } : { ok: false, status: 403 };
    r = await p.backupLedgerNow(broken);
    assert.equal(r.ok, false); assert.ok(/HTTP 403/.test(r.error), r.error);
  } finally {
    delete process.env.LEDGER_BACKUP_REPO; delete process.env.LEDGER_BACKUP_TOKEN;
  }
  // wiring pins: weekly schedule + post-boot kick + stats surface, all inside start()
  const pol = fs.readFileSync(path.join(__dirname, "..", "src", "poller.js"), "utf8");
  for (const pin of ["const BK_MS = 7 * DAY", "setInterval(bkTick, BK_MS)", "setTimeout(bkTick, 10 * 60 * 1000)",
    "backup: { enabled: !!(BK_REPO && BK_TOKEN)", "Ledger backup: disabled"])
    assert.ok(pol.includes(pin), `backup wiring pin missing: ${pin}`);
});

test("-80 regression: string-typed closes can't kill the board — detectors coerce, shadows are isolated", () => {
  const C = require("../src/compute");
  const now = Date.now();
  // the exact -79 outage shape: every close a string (Hyperliquid serves prices as strings
  // on some paths). Before the fix, detectFailBrk reached `hi.toPrecision` on a string and
  // the throw took down the entire signals build, every 10 minutes, board blank.
  const strs = []; for (let i = 0; i < 45; i++) strs.push([now - (45 - i) * DAY, String(100 + ((i * 7) % 5) * 0.3)]);
  const hi = Math.max(...strs.slice(-33, -3).map((k) => +k[1]));
  strs[strs.length - 3][1] = String(hi + 2); strs[strs.length - 2][1] = String(hi + 3); strs[strs.length - 1][1] = String(hi + 1);
  let fb;
  assert.doesNotThrow(() => { fb = C.detectFailBrk(strs, hi - 0.4); }, "string closes must never throw");
  assert.ok(fb && typeof fb.level === "number" && typeof fb.stop === "number",
    "coercion makes string closes WORK, not just fail closed — the setup still fires with numeric geometry");
  assert.equal(fb.stop, +(hi + 3).toPrecision(6));
  assert.doesNotThrow(() => C.detectReclaim(strs, hi - 0.4), "reclaim: same coercion");
  const strTrend = []; for (let i = 0; i < 70; i++) strTrend.push([now - (70 - i) * DAY, String(100 * Math.pow(1.004, i))]);
  assert.doesNotThrow(() => C.detectMAPull(strTrend, 130, 2), "mapull: same coercion");
  // pure garbage fails CLOSED (null), never open
  const junk = strs.map((k) => [k[0], "not-a-price"]);
  assert.equal(C.detectFailBrk(junk, 100), null);
  assert.equal(C.detectReclaim(junk, 100), null);
  // blast-radius pins: both strategy-shadow blocks are try/catch-isolated with once-per-build
  // logging — shadow bookkeeping can never take down the visible signal engine again
  const fs = require("fs"), path = require("path");
  const pol = fs.readFileSync(path.join(__dirname, "..", "src", "poller.js"), "utf8");
  assert.equal((pol.match(/swingFails\+\+; swingErr = \(e && e\.message\) \|\| String\(e\); \}/g) || []).length, 2,
    "swing block AND gapfade block each catch into the per-build counter");
  assert.ok(pol.includes("let swingFails = 0, swingErr = null;"), "counters reset per build");
  assert.ok(pol.includes("strategy shadows failed on ${swingFails} market(s)"), "failures log once per build, visibly");
  const cmp = fs.readFileSync(path.join(__dirname, "..", "src", "compute.js"), "utf8");
  assert.equal((cmp.match(/closes\.map\(\(k\) => \+k\[1\]\)/g) || []).length, 3, "all three daily-close detectors coerce");
});

test("crypto engine purge: stored crypto claims leave the ledger at hydrate (airead exempt), panels and records ship xyz-only", () => {
  // The -101 removal, enforced against the STORED record: a fixture carrying real crypto
  // claims — open, closed, shadow and visible — hydrates into a ledger with none of them.
  // A dead engine's history in the aggregates would be exactly the stale-record dishonesty
  // the ledger exists to prevent. airead survives: the Report tab's analyst record serves
  // both universes and its engine is alive.
  const { createPoller } = require("../src/poller");
  const now = Date.now();
  const fixture = { ts: now, rearm: ["ETH|gapfade#1", "xyz:NVDA|reclaim#0"], variants: null,
    present: [["ETH|bigmove", now - 3600e3], ["xyz:AAPL|breakdown", now - 3600e3]],
    open: [
      { key: "ETH|gapfade#1", coin: "ETH", ticker: "ETH", ev: "gapfade", t0: now - 3600e3, mark0: 100, dir: 1,
        score0: 0, psd: "short", pn: 1, stp: 101, vi: 1, resolveAt: now + 86400e3 },
      { key: "BTC|fundext#0", coin: "BTC", ticker: "BTC", ev: "fundext", t0: now - 3600e3, mark0: 50, dir: 1,
        score0: 0, sd0: 2, psd: "short", pn: 1, stp: 51.5, vi: 0, resolveAt: now + 86400e3 },
      { key: "ETH|airead#0", coin: "ETH", ticker: "ETH", ev: "airead", t0: now - 3600e3, mark0: 100, dir: 1,
        score0: 0, sd0: 2, psd: "long", pn: 1, stp: 95, vi: 0, resolveAt: now + 4 * 86400e3 },
      { key: "xyz:NVDA|reclaim#0", coin: "xyz:NVDA", ticker: "NVDA", ev: "reclaim", t0: now - 3600e3, mark0: 10, dir: 1,
        score0: 0, sd0: 2, psd: "long", pn: 1, stp: 9.5, vi: 0, resolveAt: now + 86400e3 },
    ],
    closed: [
      { key: "ETH|gapfade#0", coin: "ETH", ticker: "ETH", ev: "gapfade", t0: now - 5 * 86400e3, tR: now - 4 * 86400e3,
        mark0: 100, dir: 1, psd: "short", pn: 1, vi: 0, status: "resolved", realized: 0.8, realizedS: 0.8 },
      { key: "SOL|gapfade#0", coin: "SOL", ticker: "SOL", ev: "gapfade", t0: now - 4 * 86400e3, tR: now - 3 * 86400e3,
        mark0: 20, dir: -1, psd: "long", pn: 1, vi: 0, status: "resolved", realized: -0.4, realizedS: -0.6, stopped: true },
      { key: "xyz:AAPL|reclaim#0", coin: "xyz:AAPL", ticker: "AAPL", ev: "reclaim", t0: now - 6 * 86400e3, tR: now - 86400e3,
        mark0: 10, dir: 1, sd0: 2, psd: "long", pn: 1, vi: 0, status: "resolved", realized: 1.2, realizedS: 1.2, rn: 1 },
      { key: "xyz:AAPL|breakdown", coin: "xyz:AAPL", ticker: "AAPL", ev: "breakdown", t0: now - 6 * 86400e3, tR: now - 86400e3,
        mark0: 200, dir: -1, sd0: 2, psd: "short", pn: 1, status: "resolved", realized: 1.1, realizedS: 1.1, rn: 1 },
      { key: "ETH|bigmove", coin: "ETH", ticker: "ETH", ev: "bigmove", t0: now - 5 * 86400e3, tR: now - 4 * 86400e3,
        mark0: 3000, dir: 1, sd0: 3, psd: "long", pn: 1, status: "resolved", realized: -0.5, realizedS: -0.5, rn: 1 },
      { key: "ETH|airead#0", coin: "ETH", ticker: "ETH", ev: "airead", t0: now - 9 * 86400e3, tR: now - 4 * 86400e3,
        mark0: 90, dir: 1, sd0: 2, psd: "long", pn: 1, vi: 0, status: "resolved", realized: 1.4, realizedS: 1.4, rn: 1 },
    ] };
  let saved = null;
  const store = { loadAll: () => new Map(), loadRegime: () => [], loadLedger: () => fixture,
    saveLedger: (d) => { saved = d; }, insert: () => {}, saveRegime: () => {} };
  const p = createPoller({ dex: "xyz", store, log: () => {}, version: "test", crypto: false });
  p.hydrateLedgerNow();
  p.buildSignalsNow();
  const d = p.getSignals();
  // the purge itself: every non-airead crypto entry is gone, open and closed alike
  const x = p.getLedgerExport();
  assert.ok(x.open.every((e) => e.coin.includes(":") || e.ev === "airead"), "no crypto engine claim survives among open entries");
  assert.ok(x.closed.every((e) => e.coin.includes(":") || e.ev === "airead"), "no crypto engine claim survives among closed entries");
  assert.equal(p.getLedgerFor("ETH").closed.length, 0, "the claim browser has nothing on a crypto name (airead is vi-stamped and invisible there by design)");
  const ai = p.aireadClaimsNow();
  assert.ok(ai.open.some((e) => e.coin === "ETH") && ai.closed.some((e) => e.coin === "ETH"), "airead claims on crypto names survive the purge — open AND closed");
  assert.ok(saved && saved.open.length === 2 && saved.closed.length === 3,
    "the purged ledger persists back (ledgerDirty set by the purge): 2 open kept of 4, 3 closed kept of 6");
  assert.ok(!saved.rearm.includes("ETH|gapfade#1") && !saved.present.some((p0) => p0[0] === "ETH|bigmove"),
    "no crypto episode/presence key survives to persistence (load filter; the build's own lapse GC clears the rest)");
  // shadow panel: one universe, one panel — no main key at all
  assert.ok(d.shadows && Array.isArray(d.shadows.xyz) && !("main" in d.shadows), "single xyz panel ships; the crypto panel is gone, not empty");
  const xp = Object.fromEntries(d.shadows.xyz.map((g) => [g.ev, g]));
  assert.equal(d.shadows.xyz.length, 5, "stocks panel: 4 universal + pead");
  assert.ok(xp.pead && !xp.liqflush && !xp.fundext, "crypto-only strategies are gone from the defs, not just the data");
  assert.deepEqual({ n: xp.gapfade.rows[0].n, open: xp.gapfade.rows[0].open }, { n: 0, open: 0 },
    "the purged crypto gapfade record cannot leak into the xyz panel");
  assert.equal(xp.reclaim.rows[0].n, 1); assert.equal(xp.reclaim.rows[0].avg, 1.2);
  assert.equal(xp.reclaim.rows[0].open, 1, "xyz shadow aggregation intact");
  // record sets: xyz claims intact, crypto claims absent from EVERY set including the global
  assert.ok(d.records["0x"].record.breakdown && d.records["0x"].record.breakdown.resolved === 1, "xyz set carries the xyz visible claim");
  assert.equal(d.records["0"].record.breakdown.resolved, 1, "global set keeps its keys and totals");
  assert.ok(!d.records["0"].record.bigmove, "the purged crypto visible claim is absent from the GLOBAL set too — a dead engine feeds no aggregate");
  assert.ok(!d.records["0m"] || !d.records["0m"].record.bigmove, "and the m-suffixed set is empty of it");
  assert.ok(!("countU" in d), "per-universe live counts retired with the second universe");
  // client wiring pins: xyz-only selection, tab whitelist without signals, drawer skip
  const fs = require("fs"), path = require("path");
  const app = fs.readFileSync(path.join(__dirname, "..", "public", "app.js"), "utf8");
  for (const pin of ["+'x']||d.records[", "const shPanel=d&&d.shadows&&d.shadows.xyz;",
    "b.dataset.view!=='markets' && b.dataset.view!=='trend' && b.dataset.view!=='report';",
    "v!=='markets' && v!=='trend' && v!=='report') v='markets'",
    "rw.uni==='main'){ box.innerHTML=''; return; } }   // crypto: no signal engine (-101)",
    "strategy shadows (earning their record)"])
    assert.ok(app.includes(pin), `client xyz-only pin missing: ${pin}`);
  assert.equal((app.match(/\+'x'\]\|\|d\.records\[/g) || []).length, 2, "BOTH record-set selection sites read the xyz set");
  assert.ok(!app.includes("d.shadows.main") && !app.includes("countU"), "no client path reads the retired crypto fields");
  const pol = fs.readFileSync(path.join(__dirname, "..", "src", "poller.js"), "utf8");
  assert.ok(pol.includes('return { xyz: panel("xyz") };'), "shadowRecord ships the single panel");
  assert.ok(pol.includes("uni: r.uni, ev, label: EV_LABEL[ev]"), "signals stay universe-stamped (structural honesty, even with one universe)");
  assert.ok(pol.includes("shadow record changes must bust the ETag"), "shadow counts still fold into the signals ETag signature");
  assert.ok(pol.includes("Crypto engine purge") && pol.includes('e.ev !== "airead"'), "the purge and its airead exemption live in hydrate");
});

test("crypto engine removal (-101): fire sites, detectors, metas and per-universe lanes are gone — and stay gone", () => {
  const C = require("../src/compute");
  assert.ok(!("detectLiqFlush" in C), "detectLiqFlush retired from compute exports");
  assert.ok(!("capPerUniverse" in C), "capPerUniverse retired — one universe needs no lanes");
  assert.ok(!C.EV_META.liqflush && !C.EV_META.fundext, "crypto-only event metas retired");
  const fs = require("fs"), path = require("path");
  const pol = fs.readFileSync(path.join(__dirname, "..", "src", "poller.js"), "utf8");
  // the enrollment: pass 1 iterates the xyz-pure roster ALONE — the exact shape whose
  // accidental version was the -87 bug is now the deliberate removal
  assert.ok(pol.includes("for (const r of activeMarkets()) {"), "pass-1 iterates activeMarkets() alone");
  assert.ok(!pol.includes("activeMarkets().concat(mainMarkets())"), "the both-universe concat stays removed");
  // the guard: even a caller that forgets the rule cannot ledger a crypto claim
  assert.ok(pol.includes('if (r && r.uni === "main" && ev !== "airead") return null;'), "openLedger refuses crypto engine claims, airead exempt");
  // the fire sites and their strings are gone entirely
  for (const gone of ['openLedger(r, "liqflush"', 'openLedger(r, "fundext"', "oc24: oiChg24", "cryptoSetupsLive",
    "fundext = persistent funding extreme", "capPerUniverse", "countU"])
    assert.ok(!pol.includes(gone), `crypto engine remnant found in poller: ${gone}`);
  assert.ok(pol.includes('const R_LEDGER_EVS = new Set(["bigmove", "breakout", "breakdown", "fundflip", "oiflush", "fpdiv", "reclaim", "mapull", "failbrk", "pead", "airead"])'),
    "R-united ledger set carries no retired events");
  assert.ok(pol.includes("const top = kept.slice(0, 40);"), "transport cap is a plain top-40 — no lanes");
});

test("news feed: merge purity, payload badge stamps, full wiring chain", () => {
  const C = require("../src/compute");
  const now = Date.now(), H = 3600 * 1000;
  const mk = (id, tk, agoH, h) => ({ id, tk, h: h || ("headline " + id), src: "src", url: "https://x/" + id, pub: now - agoH * H });
  // dedupe: incoming wins (sources correct headlines)
  let m = C.mergeNews([mk(1, "AAPL", 5, "old wording")], [mk(1, "AAPL", 5, "corrected wording")], now);
  assert.equal(m.length, 1); assert.equal(m[0].h, "corrected wording");
  // eviction on PUBLISH time — a stale article in the store dies even with no incoming
  m = C.mergeNews([mk(2, "AAPL", 80), mk(3, "AAPL", 5)], [], now);
  assert.deepEqual(m.map((a) => a.id), [3], "72h publish-time eviction, late fetch earns no bonus lifetime");
  // future-dated garbage rejected, order newest-first
  m = C.mergeNews([], [mk(4, null, -9, "from the future"), mk(5, "WDC", 2), mk(6, "WDC", 1)], now);
  assert.deepEqual(m.map((a) => a.id), [6, 5], "future pub rejected; newest first");
  // per-ticker cap 10, tape lane wider
  const many = []; for (let i = 0; i < 15; i++) many.push(mk(100 + i, "NVDA", i * 0.1));
  for (let i = 0; i < 15; i++) many.push(mk(200 + i, null, i * 0.1));
  m = C.mergeNews([], many, now);
  assert.equal(m.filter((a) => a.tk === "NVDA").length, 10, "per-name cap");
  assert.equal(m.filter((a) => !a.tk).length, 15, "tape lane is wider than any single name");
  // payload: coin + badge stamps ride server-side (harness, zero network)
  const { createPoller } = require("../src/poller");
  const store = { loadAll: () => new Map(), loadRegime: () => [], loadLedger: () => null,
    saveLedger: () => {}, insert: () => {}, saveRegime: () => {}, saveNews: () => {}, loadNews: () => null };
  const p = createPoller({ dex: "xyz", store, log: () => {}, version: "test", crypto: false });
  p.seedRowNow("xyz:WDC", { px: 500, ticker: "WDC", uni: "xyz" });
  const pay = p.newsIngestNow([mk(9, "WDC", 1, "WDC raises Q1 guidance"), mk(10, null, 2)]);
  assert.equal(pay.count, 2);
  const wdc = pay.items.find((a) => a.id === 9);
  assert.equal(wdc.coin, "xyz:WDC", "equity headlines carry the drawer deep-link coin");
  assert.ok(!pay.items.find((a) => a.id === 10).coin, "tape items carry no coin");
  assert.equal(pay.ttlHours, 72);
  // wiring pins: worker, route fallback, client tab + drawer slice + badge semantics
  const fs = require("fs"), path = require("path");
  const pol = fs.readFileSync(path.join(__dirname, "..", "src", "poller.js"), "utf8");
  for (const pin of ["finnhub.io/api/v1/company-news", "finnhub.io/api/v1/news?category=general",
    "const NEWS_BATCH = 3", "buildNewsPayload();   // sig/ed badge stamps ride the signals cadence",
    "FINNHUB_TOKEN not set", "store.saveNews({ ts: now, items: newsItems, secTape, secLearned, nameLearned })"])
    assert.ok(pol.includes(pin), `news worker pin missing: ${pin}`);
  const srv = fs.readFileSync(path.join(__dirname, "..", "server.js"), "utf8");
  assert.ok(srv.includes('error: "not fetched yet"') && srv.split('fastify.get("/api/news"').length - 1 === 1, "route registered once with an honest fallback");
  const app = fs.readFileSync(path.join(__dirname, "..", "public", "app.js"), "utf8");
  for (const pin of ["function renderNews()", "function fillDrawerNews()", "function newsRow(",
    "id=\"dnews\"", "all ${esc(r.ticker)} news", "no headlines in the last 72h",
    "if(v==='news'){ if(el('view-news')) openNews();", "nbadge${a.sig?' sig':(a.ed!=null?' earn':'')}"])
    assert.ok(app.includes(pin), `news client pin missing: ${pin}`);
  const html = fs.readFileSync(path.join(__dirname, "..", "public", "index.html"), "utf8");
  assert.ok(html.includes('data-view="news"') && html.includes('id="view-news"') && html.includes('id="news-body"'), "tab + view section in the markup");
  const css = fs.readFileSync(path.join(__dirname, "..", "public", "styles.css"), "utf8");
  for (const cls of [".nrow{", ".nbadge.earn{", ".nbadge.sig{", ".nbadge.tape{"])
    assert.ok(css.includes(cls), `news css missing: ${cls}`);
  const st = fs.readFileSync(path.join(__dirname, "..", "src", "store.js"), "utf8");
  assert.ok(st.includes("saveNews(data)") && st.includes("loadNews()"), "warm-cache persistence wired");
});

test("view wiring invariant: every tab has a section, a visibility toggle, AND a dispatch — no orphans in any direction", () => {
  // Regression guard for -84's News tab: the section existed, the dispatch existed, the
  // renderer existed — and the tab still showed nothing, because showView unhides sections
  // through a hardcoded setHidden list the new view was never added to. String pins verified
  // the parts EXISTED; nothing verified they were WIRED. This test closes the class: the tab
  // buttons in the markup, the view sections, the setHidden visibility list, and the showView
  // dispatch lines must all describe the same set of views, or the suite fails.
  const fs = require("fs"), path = require("path");
  const html = fs.readFileSync(path.join(__dirname, "..", "public", "index.html"), "utf8");
  const app = fs.readFileSync(path.join(__dirname, "..", "public", "app.js"), "utf8");
  const tabs = new Set([...html.matchAll(/data-view="([a-z]+)"/g)].map((m) => m[1]));
  const sections = new Set([...html.matchAll(/id="view-([a-z]+)"/g)].map((m) => m[1]));
  const toggles = new Set([...app.matchAll(/setHidden\('view-([a-z]+)'/g)].map((m) => m[1]));
  assert.ok(tabs.size >= 10, `suspiciously few tabs parsed: ${tabs.size}`);
  for (const v of tabs) {
    assert.ok(sections.has(v), `tab "${v}" has no view section in index.html`);
    assert.ok(toggles.has(v), `tab "${v}" is missing from showView's setHidden visibility list — it would render invisible (the -84 News bug)`);
    assert.ok(app.includes(`v==='${v}'`) || v === "markets",
      `tab "${v}" has no dispatch in showView — nothing would ever render it`);
  }
  for (const v of sections)
    assert.ok(tabs.has(v), `section "view-${v}" has no tab button — dead markup`);
  for (const v of toggles)
    assert.ok(sections.has(v), `setHidden references "view-${v}" which does not exist in the markup`);
});

test("version-stamped shell: index served explicitly with ?v=BUILD asset tags, static index off", () => {
  const fs = require("fs"), path = require("path");
  const srv = fs.readFileSync(path.join(__dirname, "..", "server.js"), "utf8");
  for (const pin of ['index: false,', 'src="/app.js?v=${VERSION}"', 'href="/styles.css?v=${VERSION}"',
    'fastify.get("/", serveIndex);', 'fastify.get("/index.html", serveIndex);',
    'reply.header("cache-control", "no-store").type("text/html', "WARN: index.html asset tags drifted"])
    assert.ok(srv.includes(pin), `stamped-shell pin missing: ${pin}`);
  // and the tags in the source markup stay in the exact form the stamper rewrites — if this
  // fails, the boot-time drift warning would fire and cache-busting silently degrades
  const html = fs.readFileSync(path.join(__dirname, "..", "public", "index.html"), "utf8");
  assert.ok(html.includes('src="/app.js"') && html.includes('href="/styles.css"'),
    "index.html asset tags must match the stamper's expected form exactly");
});

test("transport cap + tab badge: plain top-40 by score, badge reads the single-universe count", () => {
  // The per-universe lanes (capPerUniverse, the -85 fix) were retired with the crypto engine
  // at -101: one universe needs no lanes, and the badge speaks for the only universe served.
  const fs = require("fs"), path = require("path");
  const pol = fs.readFileSync(path.join(__dirname, "..", "src", "poller.js"), "utf8");
  assert.ok(pol.includes("const top = kept.slice(0, 40);"), "payload cap is a plain top-40 slice");
  assert.ok(!pol.includes("capPerUniverse"), "no lane machinery survives in the poller");
  const app = fs.readFileSync(path.join(__dirname, "..", "public", "app.js"), "utf8");
  for (const pin of ["function setSigTabBadge()", "const n=d?(d.count||0):0;"])
    assert.ok(app.includes(pin), `badge pin missing: ${pin}`);
  assert.ok(!app.includes("countU"), "the scoped-badge machinery is gone with the second universe");
});

test("AI sector classification: enum-validated, write-once, static map wins, three strikes to macro", async () => {
  const { createPoller } = require("../src/poller");
  const now = Date.now();
  const calls = [];
  // injected transport: default provider is anthropic when no env keys are set
  const respond = (obj) => ({ ok: true, json: async () => ({ content: [{ type: "text", text: JSON.stringify(obj) }], stop_reason: "end_turn" }) });
  let nextResponse = null;
  const aiFetch = async (url, opts) => { calls.push(JSON.parse(opts.body)); return nextResponse; };
  const store = { loadAll: () => new Map(), loadRegime: () => [], loadLedger: () => null,
    saveLedger: () => {}, insert: () => {}, saveRegime: () => {}, saveNews: () => {}, loadNews: () => null };
  const p = createPoller({ dex: "xyz", store, log: () => {}, version: "test", crypto: false, aiFetch });
  p.seedRowNow("xyz:AAPL", { px: 200, ticker: "AAPL", uni: "xyz" });   // static map knows AAPL
  p.seedRowNow("xyz:ZZZQ", { px: 10, ticker: "ZZZQ", uni: "xyz" });    // static map does NOT
  p.newsIngestNow([
    { id: 1, tk: "AAPL", h: "Apple ships thing", src: "s", url: "u", pub: now - 3600e3 },
    { id: 2, tk: "ZZZQ", h: "ZZZQ wins contract", src: "s", url: "u", pub: now - 3600e3 },
    { id: 3, tk: null, h: "Nat gas slides on weather", src: "s", url: "u", pub: now - 3600e3 },
    { id: 4, tk: null, h: "Fed holds rates", src: "s", url: "u", pub: now - 3600e3 },
  ]);
  // pass 1: valid energy, off-enum garbage for the Fed item, a ticker answer, and one HALLUCINATED id
  nextResponse = respond({ tape: [{ i: "3", sec: "Energy" }, { i: "4", sec: "Memes" }, { i: "999", sec: "Energy" }],
    tickers: [{ t: "ZZZQ", sec: "Industrials" }, { t: "AAPL", sec: "Utilities" }] });
  let r = await p.classifySecNow();
  assert.ok(r.ok && r.applied === 2, `energy tape + ZZZQ learned applied, got ${JSON.stringify(r)}`);
  let d = p.getNews();
  const by = Object.fromEntries(d.items.map((a) => [a.id, a]));
  assert.equal(by[3].sec, "Energy"); assert.equal(by[3].secAi, 1, "tape classification wears the AI marker");
  assert.equal(by[2].sec, "Industrials"); assert.equal(by[2].secAi, 1, "learned ticker sector wears the marker");
  assert.equal(by[1].sec, "Information Technology"); assert.ok(!by[1].secAi, "static map wins, no marker — AAPL's hallucinated Utilities answer was never asked for and never applied");
  assert.ok(!by[4].sec, "off-enum answer rejected — a strike, not a classification");
  assert.ok(!d.items.some((a) => a.id === 999), "hallucinated ids change nothing");
  // pass 2 + 3: the Fed item keeps striking out, then lands on macro; write-once means only pending items ship
  nextResponse = respond({ tape: [{ i: "4", sec: "Garbage" }], tickers: [] });
  await p.classifySecNow();
  const userMsg = calls[1].messages[0].content;
  assert.ok(userMsg.includes('"4"') && !userMsg.includes('"3"'), "write-once: the classified item is never re-sent");
  nextResponse = respond({ tape: [{ i: "4", sec: "Nope" }], tickers: [] });
  await p.classifySecNow();
  r = await p.classifySecNow();   // pass 4: three strikes recorded -> macro without any model call for it
  d = p.getNews();
  assert.equal(Object.fromEntries(d.items.map((a) => [a.id, a]))[4].sec, "macro", "three strikes -> macro, nothing loops forever");
  // wiring pins: schedule, fallback model, scope guard, client A+B surfaces
  const fs = require("fs"), path = require("path");
  const pol = fs.readFileSync(path.join(__dirname, "..", "src", "poller.js"), "utf8");
  for (const pin of ["callModel(AI_MODEL_FALLBACK, pend, { system: SEC_CLASSIFY_SYSTEM", "const GICS_SECTORS = [",
    "learned sectors feed the NEWS badges/grouping ONLY", "classifySecTick().catch", "sectors: { tapeClassified:"])
    assert.ok(pol.includes(pin), `classifier pin missing: ${pin}`);
  const app = fs.readFileSync(path.join(__dirname, "..", "public", "app.js"), "utf8");
  for (const pin of ["id=\"nsec\"", "data-nv=", "newsView==='sector'", "nsec-badge${a.secAi?' ai':''}",
    "const SEC_SHORT=", "newsSec&&a.sec!==newsSec", "'unclassified'"])
    assert.ok(app.includes(pin), `sector UI pin missing: ${pin}`);
  const css = fs.readFileSync(path.join(__dirname, "..", "public", "styles.css"), "utf8");
  assert.ok(css.includes(".nsec-badge{") && css.includes(".nsec-badge.ai{border-style:dashed}"), "provenance styling present");
});

test("news relevance pipeline: no off-universe leaks — gate, AI verdicts, re-tag validation, alias learning", async () => {
  const C = require("../src/compute");
  // the pure gate: symbol-as-word, alias substring, 1-char symbols never match
  assert.ok(C.newsRelevant("Strategy Pads Cash With MSTR Sale", null, "MSTR", ["MicroStrategy"]), "symbol word match");
  assert.ok(C.newsRelevant("Western Digital raises guidance", "", "WDC", ["Western Digital"]), "alias match");
  assert.ok(!C.newsRelevant("Meta Platforms Likely to Beat Q2", null, "AMZN", ["Amazon"]), "the screenshot bug: Meta under AMZN fails the gate");
  assert.ok(!C.newsRelevant("Stock Market Today: Nasdaq Leads", null, "SNDK", ["Sandisk"]), "listicles fail the gate");
  assert.ok(!C.newsRelevant("Fed holds rates", null, "F", null), "1-char symbols never word-match");
  assert.ok(C.newsRelevant("Details inside", "NVDA beat expectations", "NVDA", null), "summary participates in the gate");

  const { createPoller } = require("../src/poller");
  const now = Date.now();
  const calls = [];
  let nextResponse = null;
  const respond = (obj) => ({ ok: true, json: async () => ({ content: [{ type: "text", text: JSON.stringify(obj) }], stop_reason: "end_turn" }) });
  const aiFetch = async (url, opts) => { calls.push(JSON.parse(opts.body)); return nextResponse; };
  const store = { loadAll: () => new Map(), loadRegime: () => [], loadLedger: () => null,
    saveLedger: () => {}, insert: () => {}, saveRegime: () => {}, saveNews: () => {}, loadNews: () => null };
  const p = createPoller({ dex: "xyz", store, log: () => {}, version: "test", crypto: false, aiFetch });
  p.seedRowNow("xyz:AMZN", { px: 200, ticker: "AMZN", uni: "xyz" });
  p.seedRowNow("xyz:META", { px: 500, ticker: "META", uni: "xyz" });
  p.seedRowNow("xyz:QQZX", { px: 5, ticker: "QQZX", uni: "xyz" });   // unseeded name -> alias learning path
  p.newsIngestNow([
    { id: 11, tk: "AMZN", h: "Amazon expands same-day delivery", src: "s", url: "u", pub: now - 3600e3 },
    { id: 12, tk: "AMZN", h: "Meta Platforms Likely to Beat Q2 Estimates", src: "s", url: "u", pub: now - 3600e3 },
    { id: 13, tk: "AMZN", h: "Stock Market Today: Nasdaq Leads On Peace Hopes", src: "s", url: "u", pub: now - 3600e3 },
    { id: 14, tk: "AMZN", h: "Spain beat Argentina to win World Cup", src: "s", url: "u", pub: now - 3600e3 },
    { id: 15, tk: "QQZX", h: "Quizzex Robotics lands defense contract", src: "s", url: "u", pub: now - 3600e3 },
  ]);
  // BEFORE any verdicts: only the gate-passing item is attributed; nothing else leaks
  let d = p.getNews();
  let by = Object.fromEntries(d.items.map((a) => [a.id, a]));
  assert.equal(by[11].tk, "AMZN", "gate-passing item attributed deterministically");
  for (const id of [12, 13, 14, 15]) {
    assert.equal(by[id].tk, null, `item ${id} ships UNATTRIBUTED while pending — no leak into the universe feed`);
    assert.equal(by[id].pend, 1, `item ${id} wears the pending marker`);
  }
  // verdicts: re-tag to META (in roster), market demotion, off-topic, plus an INVALID re-tag to a
  // ticker outside the roster (must be a strike, not an attribution); QQZX aliases learned
  nextResponse = respond({ tape: [], tickers: [],
    rel: [{ i: "12", v: "other", t: "META" }, { i: "13", v: "market" }, { i: "14", v: "off" }, { i: "15", v: "other", t: "TSLA" }],
    names: [{ t: "QQZX", names: ["Quizzex Robotics", "Quizzex"] }] });
  const r = await p.classifySecNow();
  assert.ok(r.ok && r.applied >= 4, `verdicts + aliases + re-gate applied, got ${JSON.stringify(r)}`);
  d = p.getNews();
  by = Object.fromEntries(d.items.map((a) => [a.id, a]));
  assert.equal(by[12].tk, "META", "Meta story re-tagged to META");
  assert.equal(by[12].relAi, 1, "re-tagged attribution wears the AI-verified marker");
  assert.equal(by[12].sec, "Communication Services", "and picks up META's static sector");
  assert.equal(by[13].tk, null); assert.ok(!by[13].pend, "market-general item demoted to plain tape");
  assert.equal(by[14].sec, "off-topic"); assert.equal(by[14].secAi, 1, "World Cup -> off-topic, AI-marked");
  assert.equal(by[15].tk, "QQZX", "learned alias re-gated the pending item DETERMINISTICALLY — the invalid TSLA re-tag was never applied");
  assert.ok(!d.items.some((a) => a.tk === "TSLA"), "a re-tag outside the roster can never mint an attribution");
  // the cascade continues correctly: the demoted item now needs a TAPE sector, and QQZX needs
  // a learned ticker sector — but no relevance verdict is ever re-asked (write-once)
  nextResponse = respond({ tape: [{ i: "13", sec: "macro" }], tickers: [{ t: "QQZX", sec: "Industrials" }], rel: [], names: [] });
  const r2 = await p.classifySecNow();
  assert.ok(r2.ok && r2.applied === 2, `demoted item sectored + QQZX learned, got ${JSON.stringify(r2)}`);
  const relAsked2 = calls[1].messages[0].content;
  assert.ok(!relAsked2.includes('"rel":[{'), "no relevance entries re-sent — verdicts are write-once");
  // and only NOW is the pipeline fully drained
  nextResponse = respond({ tape: [], tickers: [], rel: [], names: [] });
  const r3 = await p.classifySecNow();
  assert.ok(r3.idle, "fully classified store goes idle — nothing loops");
  // wiring pins: lane semantics client-side, drawer guard, health counters
  const fs = require("fs"), path = require("path");
  const app = fs.readFileSync(path.join(__dirname, "..", "public", "app.js"), "utf8");
  for (const pin of ["newsMode='universe'", "filings are exclusive BOTH ways",
    "relevance verdict pending", "a.sec==='off-topic'?' off'", "const isMacroName=!!(r.assetClass&&r.assetClass!=='Equity')",
    "attribution AI-verified", "no verified headlines for this name in the last 72h"])
    assert.ok(app.includes(pin), `lane pin missing: ${pin}`);
  const css = fs.readFileSync(path.join(__dirname, "..", "public", "styles.css"), "utf8");
  assert.ok(css.includes(".nrow.off{opacity:.45}"), "off-topic dimming present");
  const pol = fs.readFileSync(path.join(__dirname, "..", "src", "poller.js"), "utf8");
  for (const pin of ["function gateCompanyItems(", "function regatePending(", "uniSet.has(String(e.t).toUpperCase())",
    "relevance: { verified:", "secTape, secLearned, nameLearned }"])
    assert.ok(pol.includes(pin) || pol.includes(pin.trim()), `pipeline pin missing: ${pin}`);
  const sec = fs.readFileSync(path.join(__dirname, "..", "src", "sectors.js"), "utf8");
  assert.ok(sec.includes("const COMPANY_NAMES = {") && sec.includes("nameAliases"), "alias seed present and exported");
});

test("signal engine is xyz-only: crypto rows never fire, never ledger — the real iteration, no harness patches", () => {
  // The mirror of the retired -87 regression guard: the same two seeded rows, the same real
  // unpatched iteration — and now the CRYPTO row must produce nothing while the xyz row still
  // fires and ledgers. This is the -101 removal proven by behavior, not by string pins alone.
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
  p.buildSignalsNow();
  const d = p.getSignals();
  assert.ok(d.signals.length > 0, "the engine still fires — the removal did not blank the xyz side");
  assert.ok(d.signals.every((s0) => s0.uni === "xyz"), "every live signal is xyz — an identically-seeded crypto row produced ZERO");
  const ledC = p.getLedgerFor("ETH");
  assert.equal((ledC.open || []).length, 0, "crypto claims never ledger");
  assert.equal((ledC.closed || []).length, 0, "and none exist from before (nothing stored here)");
  const ledX = p.getLedgerFor("xyz:NVDA");
  assert.ok(ledX && ledX.open && ledX.open.length > 0, "the xyz row's claims ledger exactly as before the removal");
  const fs = require("fs"), path = require("path");
  const pol = fs.readFileSync(path.join(__dirname, "..", "src", "poller.js"), "utf8");
  assert.ok(pol.includes("for (const r of activeMarkets()) {"), "xyz-only iteration pinned");
  assert.equal((pol.match(/order\.length \? order\.map/g) || []).length, 0, "no activeMarkets fallback patch lives in the shipped source");
});

test("empty record still RENDERS: awaits, shadows, variants — executed, not string-pinned", () => {
  // The -87-deploy lesson kept alive after the -101 removal: an honestly-empty record must
  // still render the awaiting roster, the shadows panel and the variants. This executes the
  // REAL sigRecordHtml from the shipped client against an empty record — rendering behavior,
  // not source pins (the -85 lesson: existence is not wiring). Scope machinery is gone: the
  // tab serves one universe and the roster is unconditional.
  const fs = require("fs"), path = require("path");
  const src = fs.readFileSync(path.join(__dirname, "..", "public", "app.js"), "utf8");
  const grab = (name) => { const i = src.indexOf("function " + name); assert.ok(i >= 0, name + " missing");
    let dep = 0, j = src.indexOf("{", i);
    for (let k = j; k < src.length; k++) { if (src[k] === "{") dep++; if (src[k] === "}") { dep--; if (!dep) return src.slice(i, k + 1); } } };
  const esc = (s) => String(s == null ? "" : s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
  const state = { scope: "stocks" };
  const sigMovePref = () => 0, sigPrimePref = () => false, sigRecFullPref = () => true, fmtAge = () => "1m";
  const EV_LABELS = {}, EV_TIP = {};
  const ledgerRosterScoped = eval("(" + grab("ledgerRosterScoped") + ")");
  const sigRecordHtml = eval("(" + grab("sigRecordHtml") + ")");
  // empty 'x' record, shadows shipping normally (server always ships all strategies)
  const d = { records: { "0x": { record: {}, recent: [] }, "0": { record: {} } },
    shadows: { xyz: [{ ev: "reclaim", label: "breakdown reclaim", unit: "R", tip: "t", rows: [{ tag: null, n: 0, open: 0 }] }] },
    variants: [], count: 0 };
  const html = sigRecordHtml(d);
  assert.ok(html.includes("No claims resolved yet"), "the honest notice renders");
  assert.ok(html.includes("awaiting first claim"), "the awaiting roster renders BELOW the notice — no early return");
  for (const ev of ["bigmove", "breakout", "breakdown", "fundflip", "oiflush", "fpdiv", "squeeze", "unwind", "prem", "gap", "ondrift", "tretest"])
    assert.ok(html.includes(ev), `roster event ${ev} awaits — the full xyz roster, session events included`);
  assert.ok(html.includes("strategy shadows (earning their record)"), "shadows panel renders on an empty record");
  assert.ok(html.includes("breakdown reclaim"), "with its strategies");
  assert.ok(!html.includes("sigrec-top"), "headline stats stay hidden until something has actually fired");
  assert.equal(ledgerRosterScoped().length, 13, "one roster, thirteen events — no scope branch left to blank it");
});

test("ai report v6: news-grounded context, no-invention rule, crypto positioning (engine-free), sector-relative", () => {
  const { p, px, now } = aiTestPoller();   // seeded xyz:NVDA with spines (existing report harness)
  // verified-only news reaches the analyst: verified, pending and off-topic seeded together
  p.newsIngestNow([
    { id: 71, tk: "NVDA", h: "Nvidia unveils next-gen accelerator", src: "Reuters", url: "u", pub: now - 2 * 3600e3 },
    { id: 72, tk: "NVDA", h: "Stock Market Today: chips lead the tape", src: "Yahoo", url: "u", pub: now - 3600e3 },
    { id: 73, tk: null, h: "Fed holds rates steady", src: "CNBC", url: "u", pub: now - 3600e3 },
  ]);
  p.buildDailyNow();   // populates the roster order — sector peers resolve through activeMarkets()
  const ctx = p.aiCompileNow("xyz:NVDA");
  assert.ok(ctx.news && Array.isArray(ctx.news.verified), "ctx.news always ships");
  assert.equal(ctx.news.verified.length, 1, "ONLY the gate-verified headline reaches the analyst");
  assert.ok(ctx.news.verified[0].h.includes("accelerator"), "and it is the right one — the listicle stayed out");
  assert.equal(ctx.news.windowH, 72);
  // sector-relative: the name-vs-sector distinction ships as explicit numbers
  assert.ok(ctx.sector && ctx.sector.rel7dPct != null && ctx.sector.median7dPct != null,
    "sector.rel7dPct present — '+4% while the sector did +1%' is now a fact, not a guess");
  // validator: news_read is REQUIRED, and claiming usage with an empty verified set is invented news
  const good = JSON.parse(AI_GOOD(px, px * 0.94, px * 1.1));
  const noNews = Object.assign({}, ctx, { news: { windowH: 72, verified: [], tape: [], note: "none" } });
  delete good.news_read;
  assert.equal(p.aiValidateNow(JSON.stringify(good), noNews).ok, false, "missing news_read rejected");
  good.news_read = { used: true, note: "leaning on the guidance headline" };
  const rej = p.aiValidateNow(JSON.stringify(good), noNews);
  assert.equal(rej.ok, false, "used:true with zero verified headlines = invented news, rejected");
  assert.ok(/invented news/.test(rej.error));
  good.news_read = { used: true, note: "accelerator launch supports the long" };
  assert.equal(p.aiValidateNow(JSON.stringify(good), ctx).ok, true, "used:true WITH a verified headline passes");
  good.news_read = { used: false, note: "no verified headlines in the window" };
  assert.equal(p.aiValidateNow(JSON.stringify(good), noNews).ok, true, "honest empty-news read passes");
  // crypto positioning: main-universe context still carries funding/OI state — data, not the retired engine
  const DAY_ = 86400e3, HOUR_ = 3600e3;
  const mkD = () => { const d = []; for (let i = 61; i >= 1; i--) d.push({ t: now - i * DAY_, c: 100, o: 100, h: 101, l: 99, v: 1e6 }); return d; };
  const mkH = () => { const h = []; for (let i = 400; i >= 0; i--) h.push({ t: now - i * HOUR_, o: 100, h: 100.5, l: 99.5, c: 100, v: 1e5 }); return h; };
  p.seedRowNow("ETH", { px: 100, ticker: "ETH", uni: "main", vol: 5e7, funding: 0.0001,
    ref: { p7d: 95, p30d: 90 }, dailyRaw: mkD(), hourlyRaw: mkH(), dailyTs: now, hourlyTs: now, isNew: false, prevDay: 99, d1: 1 });
  const cctx = p.aiCompileNow("ETH");
  assert.equal(cctx.universe, "crypto");
  assert.ok(!cctx.sector, "sector-relative stays an equities concept");
  // funding percentile / OI need long sampled histories the harness doesn't build — the block is
  // allowed to be absent-when-uncomputable; what must hold is the source wiring:
  const fs = require("fs"), path = require("path");
  const pol = fs.readFileSync(path.join(__dirname, "..", "src", "poller.js"), "utf8");
  for (const pin of ["cr.fundingPctile31d = fp", "cr.oiChg24Pct",
    "const AI_SCHEMA_V = 6;", "NEWS CONTRACT", "context.news.verified is empty you MUST NOT",
    "invented news", "rel7dPct", "rel30dPct", "context.crypto"])
    assert.ok(pol.includes(pin), `v6 pin missing: ${pin}`);
  assert.ok(!pol.includes("cryptoSetupsLive"), "the AI context no longer cites live engine setups it does not have (-101)");
});

test("analyst-read ledger: directional reports freeze claims, episodes hold, buckets stay isolated", async () => {
  const { p, px, now } = aiTestPoller({ aiFetch: async () => ({ ok: true, json: async () => ({ stop_reason: "end_turn",
    content: [{ type: "text", text: AI_GOOD(px, +(px * 0.95).toPrecision(6), +(px * 1.10).toPrecision(6)) }] }) }) });
  const g1 = await p.generateAiReport("xyz:NVDA");
  assert.ok(g1.ok, "generation succeeds: " + (g1.error || ""));
  // the claim: frozen at the report's OWN geometry. Observed through the harness accessor —
  // the drawer payload (getLedgerFor) correctly excludes vi-stamped claims, airead included:
  // the analyst bucket is invisible to the signal surfaces BY DESIGN, and this test proves
  // both the claim and the invisibility.
  assert.ok(!(p.getLedgerFor("xyz:NVDA").open || []).some((e) => e.ev === "airead"),
    "the drawer ledger slice never shows analyst claims — bucket isolation at the payload too");
  const cl = p.aireadClaimsNow().open.find((e) => e.coin === "xyz:NVDA");
  assert.ok(cl, "a validated long read opened an airead claim");
  assert.equal(cl.psd, "long");
  assert.equal(cl.stp, +(px * 0.95).toPrecision(6), "the report's void IS the frozen stop — exactly that number");
  assert.ok(Math.abs(cl.mv - 10) < 0.2, "target distance frozen from the report's target level");
  assert.equal(cl.vi, 0, "vi=0: outside the visible record sets by construction");
  assert.ok(cl.rm, "the authoring model is stamped for later slicing");
  // episode: a same-bias regeneration cannot pseudo-replicate (TTL blocks it here anyway, but
  // the episode gate must hold independently of the cooldown)
  p.aiTouchStamp("xyz:NVDA", { closedN: -1 });   // unlock regeneration via material change
  const g2 = await p.generateAiReport("xyz:NVDA");
  assert.ok(g2.ok, "regen after unlock succeeds");
  assert.equal(p.aireadClaimsNow().open.filter((e) => e.coin === "xyz:NVDA").length, 1,
    "still exactly ONE open analyst claim on the name");
  // bucket isolation: the analyst record never leaks into the engine's record sets or shadows
  p.buildSignalsNow();
  const d = p.getSignals();
  for (const key of ["0", "0x", "0m"])
    assert.ok(!d.records[key] || !d.records[key].record.airead, `airead absent from record set ${key}`);
  assert.ok(![...d.shadows.xyz].some((g) => g.ev === "airead"), "and absent from the shadows panel");
  // the record surfaces: ctx + served report both carry analystRecord (open-only state here)
  const ctx = p.aiCompileNow("xyz:NVDA");
  assert.ok(ctx.analystRecord && ctx.analystRecord.openOnName, "the analyst sees its own open read in context");
  const served = p.getAiReport("xyz:NVDA");
  assert.ok(served.analystRecord && served.analystRecord.open === 1, "the served report carries the live record");
  // client + wiring pins
  const fs = require("fs"), path = require("path");
  const app = fs.readFileSync(path.join(__dirname, "..", "public", "app.js"), "utf8");
  for (const pin of ["analyst reads:", "first reads still open", "d.analystRecord"])
    assert.ok(app.includes(pin), `client analyst-record pin missing: ${pin}`);
  const pol = fs.readFileSync(path.join(__dirname, "..", "src", "poller.js"), "utf8");
  for (const pin of ["Neutral reads don't ledger", "!ledgerOpen.has(coin + \"|airead#0\")", "function analystRecordFor(",
    "context.analystRecord, when present, is YOUR OWN out-of-sample record"])
    assert.ok(pol.includes(pin), `airead pin missing: ${pin}`);
  const C = require("../src/compute");
  assert.equal(C.EV_META.airead.horizonMs, 5 * DAY, "5d horizon");
});

test("telegram feed: parser + drift, lane caps, single-name attribution through the real pipeline, channel management", () => {
  const C = require("../src/compute");
  // parser: entities decoded, media-only blocks skipped, permalinks built
  const mkMsg = (ch, id, txt, iso) => `<div class="tgme_widget_message_wrap"><div data-post="${ch}/${id}">`
    + (txt ? `<div class="tgme_widget_message_text js-message_text">${txt}</div>` : "")
    + `<time datetime="${iso}"></time></div></div>`;
  const iso = new Date(Date.now() - 3600e3).toISOString();
  const html = mkMsg("chanA", 1, "MicroStrategy announces expanded buyback &amp; guidance at &#36;118", iso)
    + mkMsg("chanA", 2, null, iso)   // sticker/media-only
    + mkMsg("chanA", 3, "NVDA and AMD both ripping after the Azure news", iso)
    + mkMsg("chanA", 4, "Spain wins the World Cup", iso)
    + mkMsg("chanA", 5, "MicroStrategy adds 2,100 BTC to the stack", iso);   // names TWO universe assets
  const pr = C.parseTgPreview(html, "chanA", Date.now());
  assert.equal(pr.blocks, 5); assert.equal(pr.items.length, 4, "media-only block skipped");
  assert.equal(pr.items[0].id, "tg:chanA:1");
  assert.ok(pr.items[0].h.includes("& guidance at $118"), "entities decoded");
  assert.equal(pr.items[0].url, "https://t.me/chanA/1");
  assert.ok(pr.items.every((a) => a.tg === 1));
  // drift: blocks present, nothing parseable
  const drift = C.parseTgPreview('<div class="tgme_widget_message_wrap"><div>changed markup</div></div>', "x", Date.now());
  assert.equal(drift.items.length, 0); assert.equal(drift.blocks, 1, "drift is distinguishable from an empty channel");
  // merge: telegram rides its own lane — can't evict the wire, wire can't evict it
  const now = Date.now();
  const many = [];
  for (let i = 0; i < 90; i++) many.push({ id: "tg:c:" + i, tk: null, tg: 1, h: "tg " + i, src: "t.me/c", url: "u", pub: now - i * 60e3 });
  for (let i = 0; i < 10; i++) many.push({ id: "w" + i, tk: null, h: "wire " + i, src: "s", url: "u", pub: now - i * 60e3 });
  const m = C.mergeNews([], many, now);
  assert.equal(m.filter((a) => a.tg).length, 80, "telegram lane capped at its own width");
  assert.equal(m.filter((a) => !a.tg).length, 10, "the wire survives a chatty channel intact");
  // end-to-end through the REAL pipeline: parse -> attribute -> merge -> payload lanes
  const { createPoller } = require("../src/poller");
  const store = { loadAll: () => new Map(), loadRegime: () => [], loadLedger: () => null,
    saveLedger: () => {}, insert: () => {}, saveRegime: () => {}, saveNews: () => {}, loadNews: () => null,
    saveTgChannels: () => {}, loadTgChannels: () => null };
  const pl = createPoller({ dex: "xyz", store, log: () => {}, version: "test", crypto: false });
  pl.seedRowNow("xyz:MSTR", { px: 300, ticker: "MSTR", uni: "xyz" });
  pl.seedRowNow("xyz:NVDA", { px: 180, ticker: "NVDA", uni: "xyz" });
  pl.seedRowNow("xyz:AMD", { px: 160, ticker: "AMD", uni: "xyz" });
  pl.seedRowNow("BTC", { px: 100000, ticker: "BTC", uni: "main" });
  const pay = pl.tgIngestNow(html, "chanA");
  const by = Object.fromEntries(pay.items.map((a) => [a.id, a]));
  assert.equal(by["tg:chanA:1"].tk, "MSTR", "single-name match attributes — alias hit");
  assert.equal(by["tg:chanA:1"].coin, "xyz:MSTR", "and deep-links to the drawer");
  assert.equal(by["tg:chanA:1"].sec, "Information Technology", "sector rides the attribution");
  assert.equal(by["tg:chanA:3"].tk, null, "two-name post attributes to NEITHER — no leak");
  assert.equal(by["tg:chanA:4"].tk, null, "no-name post stays tape");
  assert.equal(by["tg:chanA:5"].tk, "MSTR",
    "crypto symbols are OUT of the telegram roster by policy — 'MicroStrategy adds BTC' now has exactly one universe match and attributes to MSTR, the name it's actually about");
  assert.ok(!pay.items.some((a) => a.tg && a.tk === "BTC"), "no telegram post ever wears a crypto ticker");
  assert.ok(pay.items.filter((a) => a.tg).length === 4, "tg marker survives to the payload");
  // channel management: normalization, validation, cap, dedupe
  assert.deepEqual(pl.setTgChannels(["@WatcherGuru", "https://t.me/s/markettwits", "watcherguru"]).channels,
    ["WatcherGuru", "markettwits"], "@ and t.me prefixes stripped, case-insensitive dedupe");
  assert.equal(pl.setTgChannels(["bad name!"]).ok, false, "invalid usernames rejected");
  assert.equal(pl.setTgChannels(Array.from({ length: 13 }, (_, i) => "chan" + (1000 + i))).ok, false, "cap enforced");
  assert.ok(pl.getTgChannels().channels.length === 2, "list state reflects the last valid save");
  // parser identity gate: a typo'd username landing on ANOTHER channel's page injects nothing
  const foreign = mkMsg("SomeOtherChannel", 77, "junk that should never enter the feed", iso);
  const fr = C.parseTgPreview(foreign, "mistyped_chan", Date.now());
  assert.equal(fr.items.length, 0, "posts from a channel we didn't ask for are rejected at parse — redirects and typos can't inject");
  assert.equal(fr.blocks, 1, "…and it still counts as blocks, so drift detection keeps working");
  // removal purges posts, not just config: junk from a bad channel dies at ✕, not at 72h
  pl.setTgChannels(["chanA", "chanB"]);
  pl.tgIngestNow(html, "chanA");   // re-ingest: the WatcherGuru config assert above already (correctly) purged chanA
  pl.tgIngestNow(mkMsg("chanB", 501, "post from the channel about to be removed", iso), "chanB");
  assert.ok(pl.getNews().items.some((a) => a.id === "tg:chanB:501"), "chanB post in the feed while configured");
  pl.newsIngestNow([{ id: 900, tk: null, h: "a wire headline", src: "s", url: "u", pub: Date.now() - 3600e3 }]);
  const res = pl.setTgChannels(["chanA"]);
  assert.ok(res.purged >= 1, "removal reports the purge");
  const after = pl.getNews().items;
  assert.ok(!after.some((a) => a.id === "tg:chanB:501"), "the removed channel's posts leave the feed IMMEDIATELY");
  assert.ok(after.some((a) => a.id === "tg:chanA:1"), "the surviving channel's posts stay");
  assert.ok(after.some((a) => !a.tg), "non-telegram items untouched");
  // wiring pins
  const fs = require("fs"), path = require("path");
  const srv = fs.readFileSync(path.join(__dirname, "..", "server.js"), "utf8");
  assert.equal(srv.split('fastify.post("/api/news/channels"').length - 1, 1, "POST channels registered exactly once");
  const pol = fs.readFileSync(path.join(__dirname, "..", "src", "poller.js"), "utf8");
  for (const pin of ["markup drift: page fetched, nothing parsed", "store.saveTgChannels({ ts: Date.now(), channels: tgChannels })",
    "telegram: { channels: tgChannels.length", "function purgeTgOrphans()",
    "cached posts from since-removed channels die at hydrate", 'r.uni !== "xyz") continue;'])
    assert.ok(pol.includes(pin), `tg pin missing: ${pin}`);
  const app = fs.readFileSync(path.join(__dirname, "..", "public", "app.js"), "utf8");
  for (const pin of ["'telegram'?!!a.tg", "id=\"ntg-gear\"", "function loadTgChannels()", "function saveTgChannels(", "data-rmch"])
    assert.ok(app.includes(pin), `tg client pin missing: ${pin}`);
  const st = fs.readFileSync(path.join(__dirname, "..", "src", "store.js"), "utf8");
  assert.ok(st.includes("saveTgChannels(data)") && st.includes("loadTgChannels()"), "config persistence separate from the news cache");
});

test("EDGAR filings lane: parser, 7d retention, hard isolation from every other lane and from the report", () => {
  const C = require("../src/compute");
  const now = Date.now(), H = 3600e3;
  const atomEntry = (form, desc, accn, iso, summary) => `<entry><title>${form} - ${desc}</title><updated>${iso}</updated>`
    + `<link rel="alternate" href="https://www.sec.gov/idx-${accn}.htm"/><summary type="html">AccNo: ${accn} ${summary || ""}</summary></entry>`;
  const iso = (agoH) => new Date(now - agoH * H).toISOString();
  const xml = "<feed>"
    + atomEntry("8-K", "Current report", "0001000000-26-000123", iso(2), "Item 2.02 Results of Operations Item 9.01 Exhibits")
    + atomEntry("4", "Statement of changes in beneficial ownership", "0001000000-26-000124", iso(5))
    + atomEntry("10-Q", "Quarterly report", "0001000000-26-000125", iso(100))   // 4+ days old: INSIDE the 7d filings window
    + "</feed>";
  const pr = C.parseEdgarAtom(xml, "wdc", now);
  assert.equal(pr.items.length, 3);
  assert.equal(pr.items[0].form, "8-K"); assert.equal(pr.items[0].mat, 1);
  assert.ok(pr.items[0].h.includes("Item 2.02"), "8-K item list is the headline — the tradeable fact, no editorializing");
  assert.equal(pr.items[1].own, 1); assert.ok(!pr.items[1].mat, "Form 4 is ownership, not material");
  assert.equal(pr.items[0].id, "sec:0001000000-26-000123", "dedupe keys on the accession number");
  // dual TTL: a 100h-old filing survives where a 100h-old headline dies
  const m = C.mergeNews([], pr.items.concat([{ id: "w1", tk: null, h: "old wire", src: "s", url: "u", pub: now - 100 * H }]), now);
  assert.ok(m.some((a) => a.id === "sec:0001000000-26-000125"), "filings live 7 days");
  assert.ok(!m.some((a) => a.id === "w1"), "headlines still die at 72h");
  // end-to-end: payload fields + hard lane isolation + report exclusion
  const { createPoller } = require("../src/poller");
  const store = { loadAll: () => new Map(), loadRegime: () => [], loadLedger: () => null,
    saveLedger: () => {}, insert: () => {}, saveRegime: () => {}, saveNews: () => {}, loadNews: () => null,
    saveTgChannels: () => {}, loadTgChannels: () => null, loadAiReports: () => null, saveAiReports: () => {} };
  const pl = createPoller({ dex: "xyz", store, log: () => {}, version: "test", crypto: false });
  pl.seedRowNow("xyz:WDC", { px: 500, ticker: "WDC", uni: "xyz" });
  const pay = pl.newsIngestNow(pr.items);
  const fl = pay.items.find((a) => a.id === "sec:0001000000-26-000123");
  assert.ok(fl.fl === 1 && fl.form === "8-K" && fl.mat === 1 && fl.tk === "WDC" && fl.coin === "xyz:WDC",
    "filing ships attributed with form/materiality — no rel machinery, no pend");
  assert.ok(!fl.pend && !fl.secAi, "…and never enters the relevance or AI-classification paths");
  const ctx = pl.aiCompileNow("xyz:WDC");
  assert.equal((ctx.news && ctx.news.verified || []).length, 0,
    "filings are NOT headlines: the report's news context stays empty — the news contract never sees them");
  // client pins: exclusive lane, sub-chips, form rows, grouped-view guard
  const fs = require("fs"), path = require("path");
  const app = fs.readFileSync(path.join(__dirname, "..", "public", "app.js"), "utf8");
  for (const pin of ["newsMode==='filings'?!!a.fl:(a.fl?false:", "'universe','tape','telegram','filings'",
    "data-nfl=", "newsFl==='mat'&&!a.mat", "class=\"nform", "newsView==='sector'&&newsMode!=='filings'",
    "a.sec&&!a.fl&&inLane(a)"])
    assert.ok(app.includes(pin), `filings client pin missing: ${pin}`);
  const css = fs.readFileSync(path.join(__dirname, "..", "public", "styles.css"), "utf8");
  assert.ok(css.includes(".nform.mat{"), "material form styling present");
  const pol = fs.readFileSync(path.join(__dirname, "..", "src", "poller.js"), "utf8");
  for (const pin of ["www.sec.gov/cgi-bin/browse-edgar", "\"user-agent\": SEC_UA", "!a.fl && a.tk && a.rel === 1",
    "filings: { items:", "let edgarStat = {", "UA or egress IP likely rejected", "flStat: { lastOk:"])
    assert.ok(pol.includes(pin), `filings poller pin missing: ${pin}`);
  // the empty state and footer answer "is this working" from the UI itself
  for (const pin of ["EDGAR fetches are failing:", "the EDGAR rotation is warming up", "last EDGAR fetch"])
    assert.ok(app.includes(pin), `filings observability pin missing: ${pin}`);
});

test("earnings<->filings join: the release links once it's live, tiered preference, upcoming untouched", () => {
  const C = require("../src/compute");
  const now = Date.now(), DAY_ = 86400e3;
  const d0 = new Date(now - 1 * DAY_).toISOString().slice(0, 10);   // reported yesterday
  const dF = new Date(now + 3 * DAY_).toISOString().slice(0, 10);   // reports in 3 days
  const D0 = Date.parse(d0 + "T12:00:00Z");
  const mkFl = (tk, form, h, agoFromD0) => ({ id: "sec:" + tk + form + agoFromD0, tk, fl: 1, form, h,
    src: "EDGAR", url: "https://sec/" + tk + "/" + form, pub: D0 + agoFromD0 * 3600e3 });
  const entries = [
    { coin: "xyz:WDC", t: "WDC", d: d0, s: "AMC" },
    { coin: "xyz:NVDA", t: "NVDA", d: d0, s: "BMO" },
    { coin: "xyz:MSTR", t: "MSTR", d: dF, s: "AMC" },
  ];
  const filings = [
    mkFl("WDC", "4", "officer sale", 1),
    mkFl("WDC", "10-Q", "Quarterly report", 5),
    mkFl("WDC", "8-K", "Item 2.02 Results of Operations Item 9.01 Exhibits", 2),
    mkFl("NVDA", "8-K", "Item 7.01 Regulation FD", 3),                    // 8-K without 2.02: last-resort tier
    mkFl("MSTR", "8-K", "Item 2.02 Results", -30 * 24),                   // way outside any window for dF
  ];
  const out = C.linkEarningsFilings(entries, filings, now);
  assert.equal(out[0].filing.form, "8-K", "the 2.02 8-K beats the 10-Q beats the Form 4 — the release itself wins");
  assert.ok(out[0].filing.url.includes("/WDC/8-K"));
  assert.equal(out[1].filing.form, "8-K", "an 8-K without parsed 2.02 items still links as last resort");
  assert.ok(!out[2].filing, "upcoming entries carry NO link until the filing actually lands");
  assert.equal(C.linkEarningsFilings(entries, [], now)[0].filing, undefined, "no filings, no decoration, no throw");
  // serve-time overlay + ETag folding + client pins
  const fs = require("fs"), path = require("path");
  const pol = fs.readFileSync(path.join(__dirname, "..", "src", "poller.js"), "utf8");
  for (const pin of ["const entries = linkEarningsFilings(earnCache.entries, flItems", "if (sig !== earnLnSig) { earnLnSig = sig; earnLnVer = Date.now(); }",
    "dataTs: Math.max(earnCache.dataTs || 0, earnLnVer)"])
    assert.ok(pol.includes(pin), `earnings-link pin missing: ${pin}`);
  const app = fs.readFileSync(path.join(__dirname, "..", "public", "app.js"), "utf8");
  for (const pin of ["function earnFilingHtml(e)", "earnFilingHtml(e)", "the earnings release itself",
    "if(ev.target.closest('a,button')) return;"])
    assert.ok(app.includes(pin), `earnings-link client pin missing: ${pin}`);
  const css = fs.readFileSync(path.join(__dirname, "..", "public", "styles.css"), "utf8");
  assert.ok(css.includes(".earn-fl{") && css.includes(".earn-fl.mat{"), "filing chip styling present");
});

test("warm-boot signals cadence: 2-min builds for the first 20 minutes, then the steady 10", () => {
  const fs = require("fs"), path = require("path");
  const pol = fs.readFileSync(path.join(__dirname, "..", "src", "poller.js"), "utf8");
  for (const pin of ['setInterval(safeTick(buildSignals, "buildSignals"), 10 * 60 * 1000);',
    'setTimeout(safeTick(buildSignals, "buildSignals"), 45 * 1000);',
    'if (Date.now() - bootT > 20 * 60 * 1000) clearInterval(earlyIv);',
    'signals warm-boot build:'])
    assert.ok(pol.includes(pin), 'warm-boot cadence pin missing: ' + pin);
});

test("earnings: ET day string is the ET calendar day, not UTC or local (DST both sides)", () => {
  const { etDayStr } = require("../src/compute");
  // July = EDT (UTC-4): 02:00Z is still 22:00 the PREVIOUS day in New York.
  assert.equal(etDayStr(Date.UTC(2026, 6, 13, 2, 0)), "2026-07-12", "late-UTC evening rolls back to the prior ET day");
  assert.equal(etDayStr(Date.UTC(2026, 6, 13, 12, 0)), "2026-07-13", "midday UTC is the same ET day");
  assert.equal(etDayStr(Date.UTC(2026, 6, 13, 3, 59)), "2026-07-12", "23:59 ET is still the old day");
  assert.equal(etDayStr(Date.UTC(2026, 6, 13, 4, 0)), "2026-07-13", "00:00 ET flips the day at exactly UTC-4");
  // January = EST (UTC-5): the flip moves to 05:00Z — the helper must track the offset, not hardcode it.
  assert.equal(etDayStr(Date.UTC(2026, 0, 10, 4, 59)), "2026-01-09", "EST: 04:59Z is 23:59 ET the prior day");
  assert.equal(etDayStr(Date.UTC(2026, 0, 10, 5, 0)), "2026-01-10", "EST: day flips at 05:00Z");
});

test("earnings: day distance is whole ET days — 0 today, 1 tomorrow, negative past, garbage null", () => {
  const { earnDayDiff } = require("../src/compute");
  const noon = Date.UTC(2026, 6, 13, 16, 0);   // 12:00 ET, Mon Jul 13
  assert.equal(earnDayDiff("2026-07-13", noon), 0, "report today");
  assert.equal(earnDayDiff("2026-07-14", noon), 1, "report tomorrow");
  assert.equal(earnDayDiff("2026-07-12", noon), -1, "yesterday's report is past, never re-flagged");
  assert.equal(earnDayDiff("2026-07-27", noon), 14, "window edge");
  // The trap this exists to avoid: at 22:00 ET Sunday it is already Monday in UTC — a report
  // dated Monday must read as TOMORROW (diff 1), not today.
  const lateSun = Date.UTC(2026, 6, 13, 2, 0);   // 22:00 ET Sun Jul 12
  assert.equal(earnDayDiff("2026-07-13", lateSun), 1, "UTC has rolled over but ET has not");
  assert.equal(earnDayDiff("garbage", noon), null);
  assert.equal(earnDayDiff("2026-7-13", noon), null, "malformed date is rejected, not misparsed");
});

test("earnings: feed parse filters to OUR symbols, applies aliases, normalizes sessions, sorts", () => {
  const { parseEarningsCalendar } = require("../src/compute");
  const symMap = new Map([
    ["NVDA", { coin: "xyz:NVDA", ticker: "NVDA" }],
    ["JPM", { coin: "xyz:JPM", ticker: "JPM" }],
    ["BRK.B", { coin: "xyz:BRKB", ticker: "BRKB" }],   // alias applied by the caller: feed symbol -> our row
  ]);
  const feed = { earningsCalendar: [
    { symbol: "JPM", date: "2026-07-14", hour: "bmo", epsEstimate: 4.1123 },
    { symbol: "NVDA", date: "2026-07-14", hour: "amc", epsEstimate: 5.62 },
    { symbol: "brk.b", date: "2026-07-14", hour: "", epsEstimate: null },        // lowercase symbol, unknown session
    { symbol: "ZZZZ", date: "2026-07-14", hour: "bmo", epsEstimate: 1 },          // not in universe -> dropped
    { symbol: "NVDA", date: "2026-07-13", hour: "dmh", epsEstimate: 3 },          // earlier date sorts first
    { symbol: "JPM", date: "14-07-2026", hour: "bmo" },                            // malformed date -> dropped
    { symbol: 42, date: "2026-07-14" }, null,                                      // garbage rows tolerated
  ] };
  const out = parseEarningsCalendar(feed, symMap);
  assert.equal(out.length, 4, "universe filter + malformed rows dropped");
  assert.deepEqual(out.map((e) => e.t), ["NVDA", "JPM", "NVDA", "BRKB"], "sorted by date, then BMO < DMH < AMC < TBD within a day");
  assert.equal(out[0].s, "DMH");
  assert.equal(out[1].s, "BMO");
  assert.equal(out[2].s, "AMC");
  assert.equal(out[3].s, "TBD", "unknown hour is TBD, never guessed");
  assert.equal(out[3].coin, "xyz:BRKB", "BRK.B report lands on the BRKB row");
  assert.equal(out[1].eps, 4.1123, "EPS estimate keeps 4dp — 2dp collapsed real beat/miss margins");
  assert.equal(out[3].eps, null, "missing estimate stays null");
  assert.deepEqual(parseEarningsCalendar({}, symMap), [], "missing calendar array is empty, not a throw");
});

test("earnings: parser carries actuals and revenue for beat/miss", () => {
  const { parseEarningsCalendar } = require("../src/compute");
  const symMap = new Map([["NVDA", { coin: "xyz:NVDA", ticker: "NVDA" }]]);
  const out = parseEarningsCalendar({ earningsCalendar: [
    { symbol: "NVDA", date: "2026-07-13", hour: "amc", epsEstimate: 5.6234, epsActual: 5.712, revenueEstimate: 41234000000, revenueActual: 42891000000, quarter: 2, year: 2026 },
    { symbol: "NVDA", date: "2026-10-14", hour: "amc", epsEstimate: 6.1 },
  ] }, symMap);
  assert.equal(out[0].epsA, 5.712, "actual keeps 4dp");
  assert.equal(out[0].rev, 41200000000, "revenue estimate at 3 significant figures");
  assert.equal(out[0].revA, 42900000000);
  assert.equal(out[0].q, 2, "fiscal quarter captured — the reschedule discriminator");
  assert.equal(out[0].y, 2026);
  assert.equal(out[1].epsA, null, "future print has no actual — null, never 0");
  assert.equal(out[1].rev, null);
  assert.equal(out[1].q, null, "missing quarter is unknown, never guessed");
});

test("earnings: print merge dedupes, upgrades in place with actuals, never blanks them", () => {
  const { mergeEarnPrints } = require("../src/compute");
  const now = Date.UTC(2026, 6, 13);
  const prev = [
    { coin: "xyz:NVDA", t: "NVDA", d: "2026-04-15", s: "AMC", eps: 5.2, epsA: 5.44 },
    { coin: "xyz:JPM", t: "JPM", d: "2026-04-11", s: "TBD", eps: 4.0, epsA: null },
    { coin: "xyz:OLD", t: "OLD", d: "2022-01-01", s: "BMO", eps: 1, epsA: 1 },      // beyond retention -> dropped
  ];
  const incoming = [
    { coin: "xyz:NVDA", t: "NVDA", d: "2026-04-15", s: "AMC", eps: 5.2, epsA: null },   // re-fetch WITHOUT actual — must not blank it
    { coin: "xyz:JPM", t: "JPM", d: "2026-04-11", s: "BMO", eps: 4.0, epsA: 4.3 },      // actual arrives + session firms up from TBD
    { coin: "xyz:JPM", t: "JPM", d: "2026-07-14", s: "BMO", eps: 4.11, epsA: null },     // new print
  ];
  const out = mergeEarnPrints(prev, incoming, now);
  assert.equal(out.length, 3, "deduped by ticker+date, retention applied");
  const nv = out.find((p) => p.t === "NVDA");
  assert.equal(nv.epsA, 5.44, "stored actual survives a later fetch that lacks it");
  const jp = out.find((p) => p.t === "JPM" && p.d === "2026-04-11");
  assert.equal(jp.epsA, 4.3, "actual upgrades in place");
  assert.equal(jp.s, "BMO", "TBD session firms up when a later fetch knows it");
  assert.ok(out[0].d <= out[1].d && out[1].d <= out[2].d, "date-sorted ascending");
  // quarter/year upgrade in place, never blanked by a later fetch that lacks them
  const q1 = mergeEarnPrints([{ coin: "c", t: "T", d: "2026-04-15", s: "AMC", q: 1, y: 2026 }],
    [{ coin: "c", t: "T", d: "2026-04-15", s: "AMC", epsA: 2 }], now);
  assert.equal(q1[0].q, 1, "stored quarter survives a later fetch without it");
  assert.equal(q1[0].epsA, 2, "while the actual still lands");
});

test("earnings: reaction study — BMO same-day, AMC next-day, expansion, gaps, honest gaps in coverage", () => {
  const { earnReactionsFor } = require("../src/compute");
  // 60 daily candles, 1%-magnitude alternating base tape, UTC-day timestamps
  const day0 = Date.UTC(2026, 3, 1);   // Apr 1 2026
  const daily = [];
  let px = 100;
  for (let i = 0; i < 60; i++) {
    const prev = px;
    px = i === 30 ? px * 1.08                      // print-day pop: +8% on Apr 31? -> May 1 candle (i=30)
       : i === 45 ? px * 0.95                      // second print: -5% next day after AMC (see below)
       : px * (i % 2 ? 1.01 : 0.99);               // ordinary tape: |1%| alternating
    daily.push({ t: day0 + i * DAY, o: prev * (i === 30 ? 1.05 : 1.0), c: px });
  }
  const dstr = (i) => { const x = new Date(day0 + i * DAY); return x.toISOString().slice(0, 10); };
  const prints = [
    { t: "NVDA", d: dstr(30), s: "BMO" },   // BMO: reaction = candle 30 itself (+8%), gap +5% held
    { t: "NVDA", d: dstr(44), s: "AMC" },   // AMC: reaction = candle 45 (-5%)
    { t: "NVDA", d: "2019-01-01", s: "BMO" },   // predates the window -> skipped, not fabricated
  ];
  const st = earnReactionsFor(prints, daily);
  assert.equal(st.n, 2, "only prints matched to retained candles count");
  assert.equal(st.up, 1, "one up reaction, one down");
  assert.ok(st.avgAbs > 6 && st.avgAbs < 7, `avg |move| ~6.5, got ${st.avgAbs}`);
  assert.ok(st.xMed > 4, `both reactions are multiples of the ~1% base tape, got ${st.xMed}x`);
  assert.equal(st.gapN, 1, "gap stats only where the reaction candle carries a real gap open");
  assert.equal(st.gapUp, 1);
  assert.equal(st.gapHeld, 1, "gapped up +5%, closed +8% — held");
  // closes-only candles (warm cache shape): move stats compute, gap stats honestly absent
  const co = daily.map((k) => ({ t: k.t, c: k.c }));
  const st2 = earnReactionsFor(prints, co);
  assert.equal(st2.n, 2);
  assert.equal(st2.gapN, 0, "no opens -> no gap claims");
  assert.equal(earnReactionsFor([], daily), null, "no prints -> null, not zeros");
});

test("earnings: chunked calendar windows are disjoint, covering, near-first — the truncation fix", () => {
  const { earnChunks, etDayStr } = require("../src/compute");
  const now = Date.UTC(2026, 6, 16, 16, 0);   // Thu Jul 16 noon ET
  const ch = earnChunks(now - 5 * DAY, now + 14 * DAY, 3);
  assert.equal(ch[0][0], "2026-07-11", "coverage starts 5 days back");
  assert.equal(ch[ch.length - 1][1], "2026-07-30", "coverage ends at the window edge");
  // every ET day in [from, to] falls inside exactly one chunk — no gap can silently drop a
  // report date, no overlap can double-count (dedupe guards DST-edge overlap anyway)
  for (let d = -5; d <= 14; d++) {
    const day = etDayStr(now + d * DAY);
    const hits = ch.filter(([f, t]) => f <= day && day <= t).length;
    assert.equal(hits, 1, `ET day ${day} covered exactly once, got ${hits}`);
  }
  assert.ok(ch[0][1] < ch[1][0], "chunks ordered near-first and disjoint");
  assert.ok(ch.every(([f, t]) => f <= t), "no inverted chunk");
  assert.deepEqual(earnChunks(now, now, 3), [[etDayStr(now), etDayStr(now)]], "single-day window is one single-day chunk");
});

test("earnings: stale-schedule purge drops placeholder-date phantoms, never deletes on absence", () => {
  const { purgeStalePrints } = require("../src/compute");
  const now = Date.UTC(2026, 6, 16, 16, 0);   // Thu Jul 16 noon ET
  const prints = [
    // the live phantom: IBM persisted at Jul 14 "with actuals" while IBM's real date is Jul 22.
    // Legacy record — no quarter captured — so the 10-day proximity fallback must catch it.
    { coin: "xyz:IBM", t: "IBM", d: "2026-07-14", s: "BMO", eps: 3.05, epsA: 2.93 },
    // real print, reported today-ish, no future row -> untouchable
    { coin: "xyz:NFLX", t: "NFLX", d: "2026-07-15", s: "AMC", eps: 0.8, epsA: 0.8, q: 2, y: 2026 },
    // same-quarter phantom WITH quarter captured -> exact-match drop
    { coin: "xyz:AAA", t: "AAA", d: "2026-07-13", s: "AMC", eps: 1, epsA: 1.2, q: 2, y: 2026 },
    // past print whose ticker has a future row for the NEXT fiscal quarter -> kept (legit history)
    { coin: "xyz:BBB", t: "BBB", d: "2026-07-12", s: "BMO", eps: 2, epsA: 2.1, q: 2, y: 2026 },
    // old print far outside any proximity window -> kept even without quarter info
    { coin: "xyz:IBM", t: "IBM", d: "2026-04-22", s: "AMC", eps: 2.9, epsA: 3.0 },
  ];
  const parsed = [
    { coin: "xyz:IBM", t: "IBM", d: "2026-07-22", s: "AMC", eps: 2.96, epsA: null, q: 2, y: 2026 },
    { coin: "xyz:AAA", t: "AAA", d: "2026-07-24", s: "AMC", eps: 1, epsA: null, q: 2, y: 2026 },
    { coin: "xyz:BBB", t: "BBB", d: "2026-07-20", s: "BMO", eps: 2, epsA: null, q: 3, y: 2026 },
  ];
  const out = purgeStalePrints(prints, parsed, now);
  assert.deepEqual(out.map((p) => p.t + "|" + p.d).sort(),
    ["BBB|2026-07-12", "IBM|2026-04-22", "NFLX|2026-07-15"].sort(),
    "phantoms dropped (legacy proximity + same-quarter), real and historical prints kept");
  // absence is never deletion evidence: a window that simply lacks a ticker changes nothing
  assert.equal(purgeStalePrints(prints, [{ coin: "xyz:ZZZ", t: "ZZZ", d: "2026-07-25", s: "AMC" }], now).length, prints.length,
    "no future row for a ticker -> its past prints are untouched");
  assert.equal(purgeStalePrints(prints, [], now).length, prints.length, "empty window purges nothing");
  // wiring pins: BOTH calendar pulls go through the chunked fetch, the purge runs before merge,
  // and the backfill flag is versioned so truncated-v1 volumes re-pull chunked once.
  const fs = require("fs"), path = require("path");
  const pol = fs.readFileSync(path.join(__dirname, "..", "src", "poller.js"), "utf8");
  assert.ok((pol.match(/await getCalChunked\(/g) || []).length >= 2, "chunked fetch used for live window AND backfill");
  assert.ok(pol.indexOf("purgeStalePrints(earnPrints, parsed") < pol.indexOf("mergeEarnPrints(earnPrints, past.concat"), "purge runs before the merge");
  assert.ok(pol.includes("data.histDone2 === true") && pol.includes("histDone2: earnHistDone"), "backfill flag versioned in hydrate and persist");
});

test("earnings: back-window reconciliation mirrors the feed's current claim, never touches deep history", () => {
  const { reconcileEarnPrints, parseEarningsCalendar } = require("../src/compute");
  const now = Date.UTC(2026, 6, 16, 16, 0);   // Thu Jul 16 noon ET
  const prints = [
    { coin: "xyz:IBM", t: "IBM", d: "2026-07-14", s: "BMO", eps: 3.05, epsA: 2.93 },   // phantom: feed no longer lists it ANYWHERE
    { coin: "xyz:NFLX", t: "NFLX", d: "2026-07-15", s: "AMC", eps: 0.8042, epsA: 0.8 }, // real: feed still serves the back-window row
    { coin: "xyz:GOOGL", t: "GOOGL", d: "2026-04-24", s: "AMC", eps: 2.1, epsA: 2.3 },  // deep history: outside the back window, untouchable
    { coin: "xyz:TSLA", t: "TSLA", d: "2026-07-22", s: "AMC", eps: 0.51 },              // future-dated record: not reconciliation's business
  ];
  const parsed = [
    { coin: "xyz:NFLX", t: "NFLX", d: "2026-07-15", s: "AMC", eps: 0.8042, epsA: 0.8 },
    { coin: "xyz:TSLA", t: "TSLA", d: "2026-07-22", s: "AMC", eps: 0.51 },
  ];
  const out = reconcileEarnPrints(prints, parsed, now);
  assert.deepEqual(out.map((p) => p.t).sort(), ["GOOGL", "NFLX", "TSLA"],
    "back-window phantom dropped; back-window real, deep history and future records kept");
  assert.equal(reconcileEarnPrints(prints, [], now).length, prints.length,
    "an empty parse is a broken fetch, not evidence — purges nothing");
  assert.equal(reconcileEarnPrints(prints, parsed, now, 1).length, 4,
    "IBM at diff -2 is outside a 1-day back window — untouched when not refetched");
  // the NFLX display regression, at the parser: 2dp quantization collapsed a real -0.5% miss
  // into "0.8 vs 0.8" — 4dp must preserve the margin the verdict is computed from
  const symMap = new Map([["NFLX", { coin: "xyz:NFLX", ticker: "NFLX" }]]);
  const p = parseEarningsCalendar({ earningsCalendar: [
    { symbol: "NFLX", date: "2026-07-16", hour: "amc", epsEstimate: 0.8042, epsActual: 0.8, quarter: 2, year: 2026 },
  ] }, symMap);
  assert.equal(p[0].eps, 0.8042, "estimate margin preserved at 4dp");
  assert.equal(p[0].epsA, 0.8);
  assert.ok(p[0].epsA < p[0].eps, "the verdict-bearing inequality survives quantization");
  // wiring pins: tombstones filter at the pipe mouth AND the post-merge choke point, the void
  // function exists and is exported, the route is registered, and the client carries the control.
  const fs = require("fs"), path = require("path");
  const pol = fs.readFileSync(path.join(__dirname, "..", "src", "poller.js"), "utf8");
  assert.ok(pol.includes("parsed = parsed.filter((e) => !earnVoids.has(e.t"), "tombstones filter the fresh parse");
  assert.ok(pol.includes("earnPrints = earnPrints.filter((p) => !earnVoids.has(p.t"), "tombstones filter the merged prints (choke point)");
  assert.ok(pol.includes("function voidEarnPrint(") && pol.includes("voidEarnPrint,"), "void function defined and exported");
  assert.ok(pol.indexOf("reconcileEarnPrints(earnPrints, parsed") < pol.indexOf("purgeStalePrints(earnPrints, parsed"), "reconcile runs before the reschedule purge");
  assert.ok(pol.includes("voids: [...earnVoids]"), "tombstones persist to the volume");
  const srv = fs.readFileSync(path.join(__dirname, "..", "server.js"), "utf8");
  assert.equal(srv.split('fastify.post("/api/earnings/void"').length - 1, 1, "void route registered exactly once");
  const app = fs.readFileSync(path.join(__dirname, "..", "public", "app.js"), "utf8");
  for (const frag of ["earn-void", "/api/earnings/void", "in line"])
    assert.ok(app.includes(frag), `missing client void/verdict marker: ${frag}`);
});

test("earnings: recently-reported window keeps the two prior ET days, drops today and older, sorts most-recent first", () => {
  const { recentEarnPrints } = require("../src/compute");
  const noon = Date.UTC(2026, 6, 16, 16, 0);   // 12:00 ET, Thu Jul 16
  const prints = [
    { coin: "xyz:AAA", t: "AAA", d: "2026-07-16", s: "BMO", eps: 1, epsA: 1.1 },   // TODAY -> lives in entries, not here
    { coin: "xyz:BBB", t: "BBB", d: "2026-07-15", s: "AMC", eps: 2, epsA: 2.2 },   // yesterday -> kept
    { coin: "xyz:CCC", t: "CCC", d: "2026-07-15", s: "BMO", eps: 3, epsA: 2.9 },   // yesterday -> kept
    { coin: "xyz:DDD", t: "DDD", d: "2026-07-14", s: "AMC", eps: 4, epsA: null },  // 2 days ago, actual pending -> kept, never fabricated
    { coin: "xyz:EEE", t: "EEE", d: "2026-07-13", s: "BMO", eps: 5, epsA: 5.5 },   // 3 days ago -> outside the window
    { coin: "xyz:FFF", t: "FFF", d: "2026-07-20", s: "BMO", eps: 6 },              // upcoming -> never here
    null, { t: "GGG" },                                                             // garbage tolerated
  ];
  const out = recentEarnPrints(prints, noon);
  assert.deepEqual(out.map((p) => p.t), ["CCC", "BBB", "DDD"],
    "diff -1 and -2 only; most recent day first; BMO before AMC within a day");
  assert.equal(out[2].epsA, null, "pending actual ships as null, never zeroed");
  assert.equal(out[0].epsA, 2.9, "actuals ride through untouched");
  // The ET-day trap this window inherits: at 22:00 ET Wed it is already Thursday in UTC — a
  // Wednesday print must read diff 0 (still today, still in entries), NOT roll into recent early.
  const lateWed = Date.UTC(2026, 6, 16, 2, 0);   // 22:00 ET Wed Jul 15
  assert.deepEqual(recentEarnPrints([{ coin: "xyz:BBB", t: "BBB", d: "2026-07-15", s: "AMC" }], lateWed), [],
    "a print reported tonight stays out of the reported window until the ET day actually rolls");
  assert.deepEqual(recentEarnPrints(null, noon), [], "no prints -> empty, not a throw");
  // wiring pins — the reported window is derived in BOTH poller paths (fetch + hydrate), the
  // route fallback declares the field, and the client renders/merges it. A silent deletion of
  // any link in that chain must be a suite failure, not a blank section discovered by eye.
  const fs = require("fs"), path = require("path");
  const pol = fs.readFileSync(path.join(__dirname, "..", "src", "poller.js"), "utf8");
  assert.ok((pol.match(/recentEarnPrints\(earnPrints/g) || []).length >= 2, "poller derives recent in fetch AND hydrate paths");
  assert.ok(pol.includes("p.epsA != null ? \"a\" : \"\""), "ETag signature covers recent actuals");
  const srv = fs.readFileSync(path.join(__dirname, "..", "server.js"), "utf8");
  assert.ok(srv.includes("recent: []"), "/api/earnings fallback declares the recent field");
});

test("client integrity manifest: app.js contains every load-bearing symbol, exactly once", () => {
  // Regression guard for the build that shipped a gutted app.js: a bad splice replaced ~1,600
  // lines and still passed node --check (valid JS) and this suite (which never read the client).
  // This test makes structural damage to the client a suite failure.
  const fs = require("fs"), path = require("path");
  const s = fs.readFileSync(path.join(__dirname, "..", "public", "app.js"), "utf8");
  assert.ok(s.length > 250000, `app.js suspiciously small: ${s.length} bytes`);
  const defs = {};
  for (const m of s.matchAll(/^(?:async )?function ([A-Za-z0-9_]+)\(/gm)) defs[m[1]] = (defs[m[1]] || 0) + 1;
  const need = ["closeDetail", "showView", "openDetail", "renderSignals", "sigCardHtml", "sigRowHtml",
    "trigChip", "playRow", "rrChip", "recCurveSvg", "openHelp", "closeHelp",
    "openSigHistory", "runSigHist", "loadSigHistory", "sigHistRow", "loadDrawerLedger",
    "ddCell", "ddyCell", "openCell", "computeMomentum", "computeSqueeze", "fmtTrig", "fmtAge",
    "vsTapeCell", "dcapCell", "hitCell", "rvolCell",
    "loadEarnings", "renderEarnings", "openEarnings", "earnBadge", "earnNext", "earnRecentList", "earnReactHtml", "epsPairFmt", "wireEarnVoid",
    "applyTabOrder", "saveTabOrder", "wireTabDrag",
    "openTrendChart", "closeTrendChart", "loadTrendChart", "renderTrendChart", "tcCandleSvg", "tcEmaSeries",
    "applyDensity", "updateFocusChip", "applyKsel", "kmoveSel", "applyMobileCols"];
  for (const n of need) {
    assert.ok(defs[n] >= 1, `missing client function: ${n}`);
    assert.equal(defs[n], 1, `duplicate client function: ${n}`);
  }
  for (const frag of ["const HELP={", "const SHOW_CLAIM_CURVE", "conflWith", "claim0", "presentSince|sighist-ev", "/api/earnings", "eb0", "earnSplit", "d.recent||", "REPORTED \\u00b7",
    "xyzmon.density", "krow", "state.focus"]) {
    const ok = frag.includes("|") ? frag.split("|").some((f) => s.includes(f)) : s.includes(frag);
    assert.ok(ok, `missing client feature marker: ${frag}`);
  }
  // Labels are labels: a tooltip sentence welded onto EV_LABELS broke every chip and table
  // row once. Each label must stay a short display string.
  const lm = s.match(/const EV_LABELS=\{[^\n]*\}/);
  assert.ok(lm, "EV_LABELS missing");
  for (const em of lm[0].matchAll(/:'([^']*)'/g))
    assert.ok(em[1].length <= 32, `EV_LABELS entry too long to be a label: "${em[1].slice(0, 48)}..."`);
  const html = fs.readFileSync(path.join(__dirname, "..", "public", "index.html"), "utf8");
  for (const id of ["helpBtn", "helpmodal", "sighist-q", "sighist-ev", "sighist-panel", "dledger", "earnings-body", "view-earnings", "logoutBtn", "densBtn", "focusChip"]) {
    if (id === "dledger") continue;   // dledger is injected by JS, not static markup
    assert.ok(html.includes(`id="${id}"`), `missing markup id: ${id}`);
  }
  // The backtest tab was silently dropped from the nav once while every renderer behind it
  // survived — pin both the button and the view section so the tab can't vanish again.
  assert.ok(html.includes('data-view="backtest"'), "backtest tab button missing from nav");
  assert.ok(html.includes('id="view-backtest"'), "backtest view section missing");
  assert.ok(s.includes("xyzmon.tabs.v1"), "tab-order persistence key missing from client");
  // Auth surface: the login flow lives inline in server.js — pin its load-bearing pieces.
  // "return reply.code(401)" is load-bearing, not style: an async hook that send()s WITHOUT
  // returning the reply does not stop the lifecycle — @fastify/static double-sends and the
  // response hangs (the production outage of 2026.07.13: /api/health fine, "/" a body-less 401).
  const srv = fs.readFileSync(path.join(__dirname, "..", "server.js"), "utf8");
  for (const frag of ["xyzsess", "xyzauth", "/logout", "timingSafeEqual", "createHmac", "LOGIN_HTML", "/api/health", "return reply.code(401)"])
    assert.ok(srv.includes(frag), `missing server auth marker: ${frag}`);
});

test("server route manifest: every load-bearing API route is registered exactly once and backed by a real poller getter", () => {
  // Regression guard for build 2026.07.13-42: one careless block deletion in server.js removed
  // /api/series, /api/ledger and /api/candles — the three endpoints behind the drawer's candle
  // chart, OI/funding sparklines and signal record. node --check passed, the client was intact,
  // and every drawer loader swallows fetch errors, so the damage shipped silently for six
  // builds. This pins the full route surface: dropping a registration (or registering it
  // twice) is now a suite failure, and each poller.getX() a route calls must exist in poller.js.
  const fs = require("fs"), path = require("path");
  const srv = fs.readFileSync(path.join(__dirname, "..", "server.js"), "utf8");
  const routes = ["/api/snapshot", "/api/daily", "/api/analytics", "/api/trend", "/api/signals",
    "/api/earnings", "/api/series", "/api/ledger", "/api/candles", "/api/ai-report", "/api/ai-reports", "/api/health",
    "/api/export/ledger", "/api/news", "/api/news/channels",
    "/manifest.webmanifest", "/icon.svg", "/sw.js"];
  for (const r of routes) {
    const n = srv.split(`fastify.get("${r}"`).length - 1;
    assert.ok(n >= 1, `server route missing: ${r}`);
    assert.equal(n, 1, `server route registered ${n} times: ${r}`);
  }
  // Generation is a POST with its own registration — pinned separately from the GET reads.
  assert.equal(srv.split('fastify.post("/api/ai-report"').length - 1, 1, "POST /api/ai-report must be registered exactly once");
  // Every poller getter the route layer references must be defined AND exported by the poller
  // factory — a route bound to a phantom getter is a 500 the drawer's silent catch would eat.
  const pol = fs.readFileSync(path.join(__dirname, "..", "src", "poller.js"), "utf8");
  const getters = new Set([...srv.matchAll(/poller\.(get[A-Za-z0-9_]+)\(/g)].map((m) => m[1]));
  assert.ok(getters.size >= 8, `suspiciously few poller getters referenced by routes: ${getters.size}`);
  // Getters take two shapes in poller.js — `function getX(` hoisted then exported shorthand,
  // or `getX: () =>` inline in the export object. Either counts; zero occurrences is a phantom
  // (exactly what the removed /api/unlocks route was — bound to a getUnlocks that never existed).
  for (const g of getters)
    assert.ok(new RegExp(`(function ${g}\\(|${g}\\s*:)`).test(pol), `route references undefined poller getter: ${g}`);
});

test("stop geometry: validator, hydrate repair of fabricated stop-aware wins, open-claim voiding", () => {
  const { stopGeometryOk } = require("../src/compute");
  // the validator itself
  assert.equal(stopGeometryOk("long", 45.694, 50.57), false, "stop above a long's entry is invalid (the MINIMAX case)");
  assert.equal(stopGeometryOk("long", 45.694, 41.2), true, "stop below a long's entry is valid");
  assert.equal(stopGeometryOk("short", 97.9, 102.9), true, "stop above a short's entry is valid");
  assert.equal(stopGeometryOk("short", 97.9, 92.0), false, "stop below a short's entry is invalid");
  assert.equal(stopGeometryOk("long", 0, 10), false, "no mark, no stop");
  assert.equal(stopGeometryOk(null, 100, 90), false, "no side, no stop");

  // hydrate repair
  const { createPoller } = require("../src/poller");
  const now = Date.now();
  const fixture = { ts: now, rearm: [], variants: null,
    open: [
      // open long with inverted stop: keeps resolving, loses its stop-aware leg
      { key: "xyz:NATGAS|squeeze", coin: "xyz:NATGAS", ticker: "NATGAS", ev: "squeeze", t0: now - 3600000,
        mark0: 2.959, dir: 1, score0: 21, resolveAt: now + 86400000, psd: "long", stp: 3.4 },
    ],
    closed: [
      // the MINIMAX shape: long, stop ABOVE entry, "stopped" into a fabricated +10.68% win
      { key: "xyz:MINIMAX|squeeze", coin: "xyz:MINIMAX", ticker: "MINIMAX", ev: "squeeze", t0: now - 5 * 86400000,
        mark0: 45.694, dir: 1, psd: "long", stp: 50.57, status: "resolved", tR: now - 2 * 86400000,
        realized: -20.79, realizedS: 10.68, stopped: true, win: false, winS: true, score0: 42 },
      // a VALID stopped short: stop above entry, genuinely touched — must be untouched by repair
      { key: "xyz:MSTR|breakdown2", coin: "xyz:MSTR", ticker: "MSTR", ev: "breakdown", t0: now - 6 * 86400000,
        mark0: 97.9, dir: -1, psd: "short", stp: 102.9, sd0: 2, rn: 1, status: "resolved", tR: now - 86400000,
        realized: 1.2, realizedS: -2.55, stopped: true, win: true, winS: false },
    ] };
  const store = { loadAll: () => new Map(), loadRegime: () => [], loadLedger: () => fixture,
    saveLedger: () => {}, insert: () => {}, saveRegime: () => {} };
  const p = createPoller({ dex: "xyz", store, log: () => {}, version: "test", crypto: false });
  p.hydrateLedgerNow();
  p.hydrateLedgerNow();   // idempotent
  const mm = p.getLedgerFor("xyz:MINIMAX").closed[0];
  assert.equal(mm.realizedS, -20.79, "fabricated stop-aware outcome reverted to at-horizon truth");
  assert.equal(mm.stopped, false, "false stop cleared");
  const ms = p.getLedgerFor("xyz:MSTR").closed[0];
  assert.equal(ms.realizedS, -2.55, "valid stopped short untouched");
  assert.equal(ms.stopped, true, "valid stop kept");
  const ng = p.getLedgerFor("xyz:NATGAS").open[0];
  assert.equal(ng.status, "open", "open claim still resolving");
  assert.equal(ng.stopped, false);
});

test("play-signed results: fadeStats, resolver sign, and hydrate repair of inverted fader claims", () => {
  const { fadeStats } = require("../src/compute");
  const st = { n: 20, med: -0.9, avg: -0.62, hit: 0.28, unit: "%" };
  const f = fadeStats(st);
  assert.deepEqual([f.med, f.avg, f.hit, f.fade, f.n], [0.9, 0.62, 0.72, true, 20], "fadeStats flips into play units");
  assert.equal(st.med, -0.9, "source study never mutated");

  const { createPoller } = require("../src/poller");
  const now = Date.now();
  const fixture = { ts: now, rearm: [], variants: null,
    open: [
      // legacy open fader: claim med must flip; outcome sign comes from psd at resolution
      { key: "xyz:MSTR|gap", coin: "xyz:MSTR", ticker: "MSTR", ev: "gap", t0: now - 3600000, mark0: 100,
        dir: 1, psd: "short", score0: 30, resolveAt: now + 86400000, claim: { n: 12, med: -0.8 } },
    ],
    closed: [
      // the observed shape: up-gap (dir +1), FADE play (psd short), stopped, event-signed
      // realizedS +0.73 displayed as a green stop-aware "win" — in play units this fade LOST
      { key: "xyz:MSTR|gap#c", coin: "xyz:MSTR", ticker: "MSTR", ev: "gap", t0: now - 5 * 86400000, mark0: 100,
        dir: 1, psd: "short", stp: 101.2, status: "resolved", tR: now - 4 * 86400000,
        realized: 0.73, realizedS: 0.73, stopped: true, win: true, winS: true, claim: { n: 12, med: -0.8 } },
      // aligned continuation gap (psd long, dir +1): must be untouched
      { key: "xyz:COIN|gap", coin: "xyz:COIN", ticker: "COIN", ev: "gap", t0: now - 6 * 86400000, mark0: 50,
        dir: 1, psd: "long", status: "resolved", tR: now - 5 * 86400000,
        realized: 1.4, realizedS: 1.4, win: true, winS: true, claim: { n: 15, med: 0.6 } },
    ] };
  const store = { loadAll: () => new Map(), loadRegime: () => [], loadLedger: () => fixture,
    saveLedger: () => {}, insert: () => {}, saveRegime: () => {} };
  const p = createPoller({ dex: "xyz", store, log: () => {}, version: "test", crypto: false });
  p.hydrateLedgerNow();
  p.hydrateLedgerNow();   // idempotent — pn guards the second pass
  const mm = p.getLedgerFor("xyz:MSTR");
  const cl = mm.closed[0];
  assert.equal(cl.realized, -0.73, "failed fade now a LOSS in play units");
  assert.equal(cl.win, false, "win flag follows the play");
  assert.equal(cl.realizedS, -0.73, "stop-aware leg flipped too");
  assert.equal(cl.claimMed, 0.8, "claim median flipped into play units");
  assert.equal(mm.open[0].claimMed, 0.8, "open fader claim median flipped");
  const co = p.getLedgerFor("xyz:COIN").closed[0];
  assert.equal(co.realized, 1.4, "aligned claim untouched");
  assert.equal(co.win, true);
});

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

test("bucketCandles: UTC-aligned aggregation, forming bucket, closes-only degradation", () => {
  const { bucketCandles } = require("../src/compute");
  // 11 hourly candles starting at t=1h -> 4h buckets [0,4), [4,8), [8,12): first bucket partial
  const hrs = [];
  for (let i = 1; i <= 11; i++) hrs.push({ t: i * HOUR, o: 10 + i, h: 20 + i, l: 5 + i, c: 10 + i });
  const b4 = bucketCandles(hrs, 4, HOUR);
  assert.equal(b4.length, 3);
  assert.deepEqual(b4.map((k) => k.t), [0, 4 * HOUR, 8 * HOUR], "buckets are UTC-aligned to the width");
  assert.equal(b4[0].c, 13, "bucket close = last hourly close inside it");
  assert.equal(b4[1].h, 27, "bucket high = max hourly high (h4..h7 -> 24..27)");
  assert.equal(b4[1].l, 9, "bucket low = min hourly low (l4..l7 -> 9..12)");
  assert.equal(b4[2].c, 21, "forming bucket carries the latest close");
  // closes-only candles (warm-cache daily shape) degrade h/l to the close instead of NaN
  const co = bucketCandles([{ t: HOUR, c: 5 }, { t: 2 * HOUR, c: 6 }], 4, HOUR);
  assert.equal(co.length, 1);
  assert.equal(co[0].h, 6); assert.equal(co[0].l, 5);
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

test("trend leaderboard integrity: client, markup and server carry the tab end to end", () => {
  const fs = require("fs"), path = require("path");
  const s = fs.readFileSync(path.join(__dirname, "..", "public", "app.js"), "utf8");
  const defs = {};
  for (const m of s.matchAll(/^(?:async )?function ([A-Za-z0-9_]+)\(/gm)) defs[m[1]] = (defs[m[1]] || 0) + 1;
  for (const n of ["loadTrend", "openTrend", "renderTrend", "trendDotHtml", "trendSectionHtml"]) {
    assert.ok(defs[n] >= 1, `missing client function: ${n}`);
    assert.equal(defs[n], 1, `duplicate client function: ${n}`);
  }
  for (const frag of ["/api/trend", "trow-hl", "tretest", "trend:`", "tage", "td21", "fresh-first", "twidth", "rrv"])
    assert.ok(s.includes(frag), `missing client feature marker: ${frag}`);
  const eng = fs.readFileSync(path.join(__dirname, "..", "src", "compute.js"), "utf8");
  for (const fn of ["function stackedRun(", "function ribbonWidth(", "TREND_TF_MS"])
    assert.ok(eng.includes(fn), `missing engine symbol: ${fn}`);
  assert.ok(fs.readFileSync(path.join(__dirname, "..", "src", "poller.js"), "utf8").includes("seedRowNow"),
    "missing poller harness: seedRowNow");
  const html = fs.readFileSync(path.join(__dirname, "..", "public", "index.html"), "utf8");
  assert.ok(html.includes('data-view="trend"'), "trend tab button missing from nav");
  for (const id of ["view-trend", "trendside", "trend-body", "trend-asof", "tchartbg", "tchartmodal", "sig-introtxt", "sig-segslot"])
    assert.ok(html.includes(`id="${id}"`), `missing markup id: ${id}`);
  const srv = fs.readFileSync(path.join(__dirname, "..", "server.js"), "utf8");
  assert.ok(srv.includes("/api/trend"), "server route missing: /api/trend");
  const css = fs.readFileSync(path.join(__dirname, "..", "public", "styles.css"), "utf8");
  for (const cls of [".tdot", ".tretest", ".trend-t", ".trow-hl", ".twidth", ".tchart-btn", ".tchart-modal", ".tcbtn-td"])
    assert.ok(css.includes(cls), `missing style: ${cls}`);
  // chart modal contract markers: the button ships on rows, the fetch carries tf=, and the
  // candles route branches to the ladder-series getter — drop any one and the modal quietly
  // degrades (silent-fetch-swallowing is exactly how the -42 route deletion hid for six builds)
  const app = fs.readFileSync(path.join(__dirname, "..", "public", "app.js"), "utf8");
  for (const frag of ["tchart-btn", "&tf=", "tcbtn-td"])
    assert.ok(app.includes(frag), `missing chart-modal client marker: ${frag}`);
  // signals card grammar (build -67): meta column, scope tag, watch line, unified pill classes
  for (const frag of ["sig-meta", "sig-scope", "sp-watchline", "sig-unp bad", "sig-unp warn"])
    assert.ok(app.includes(frag), `missing signals-card grammar marker: ${frag}`);
  for (const cls of [".sig-meta", ".sig-scope", ".sp-watchline", ".sig-unp.bad", ".sig-chip.bad"])
    assert.ok(css.includes(cls), `missing signals-card style: ${cls}`);
  // audit block collapse (build -68): toggle + sub-section markers
  for (const frag of ["sigRecFullPref", "data-recx", "sigrec-sub"])
    assert.ok(app.includes(frag), `missing audit-collapse marker: ${frag}`);
  assert.ok(css.includes(".sigrec-sub"), "missing style: .sigrec-sub");
  assert.ok(srv.includes("getTfCandles"), "candles route does not branch to the ladder-series getter");
  // trend-retest ledger signal: both event ids must exist end to end — server labels/meta,
  // playbook, and the client label/tip maps (a missing client label renders raw event ids)
  const pol = fs.readFileSync(path.join(__dirname, "..", "src", "poller.js"), "utf8");
  const cmp = fs.readFileSync(path.join(__dirname, "..", "src", "compute.js"), "utf8");
  for (const ev of ["tretest", "tretestdn"]) {
    assert.ok(pol.includes(`${ev}:`) || pol.includes(`"${ev}"`), `poller missing event wiring: ${ev}`);
    assert.ok(cmp.includes(ev), `compute missing event meta/playbook: ${ev}`);
    assert.ok(app.includes(`${ev}:`), `client label/tip maps missing event: ${ev}`);
  }
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

test("trend board ships width + retest volume (rrv) end to end via the seed harness", () => {
  const { createPoller } = require("../src/poller");
  const store = { loadAll: () => new Map(), loadRegime: () => [], loadLedger: () => null,
    saveLedger: () => {}, insert: () => {}, saveRegime: () => {} };
  const p = createPoller({ dex: "xyz", store, log: () => {}, version: "test", crypto: false });
  const now = Date.now(), endH = Math.floor(now / HOUR);
  // 16 days of hourly bars: enough for >=26 H12 buckets AND a ~15-day clock-matched RVOL
  // baseline. Gently rising closes, unit volume — except the last 24 COMPLETED hours, which
  // trade 2x. Lows are shallow so no intraday rung fires the retest; the D1 wick below owns it.
  const N = 16 * 24, hourly = [];
  for (let i = 0; i < N; i++) {
    const t = (endH - N + i) * HOUR, c = 100 * Math.pow(1.0005, i);
    hourly.push({ t, o: c, h: c * 1.001, l: c * 0.999, c, v: i >= N - 24 ? 2 : 1 });
  }
  const px = hourly[N - 1].c * 1.0005;
  // 60 daily bars rising 1%/day with deep lows: the recent daily wicks probe the D1 ribbon
  // while price holds above EMA21 — the canonical D1 RETEST.
  const daily = [];
  for (let i = 0; i < 60; i++)
    daily.push({ t: (Math.floor(now / DAY) - 60 + i) * DAY, c: px * Math.pow(1.01, i - 59), l: px * Math.pow(1.01, i - 59) * 0.90, h: px * Math.pow(1.01, i - 59) * 1.002 });
  p.seedRowNow("TREND1", { px, uni: "xyz", vol: 1e6, hourlyRaw: hourly, dailyRaw: daily });
  p.buildTrendNow();
  const row = p.getTrend().long.stocks.find((e) => e.coin === "TREND1");
  assert.ok(row, "seeded market reaches the long board");
  assert.ok(row.score >= 3, `score qualifies for a retest read, got ${row.score}`);
  assert.equal(row.retest, "D1", "the deep daily wick owns the retest (highest TF reported first)");
  assert.ok(row.width != null && row.width > 0, `width ships and is positive, got ${row.width}`);
  assert.ok(Math.abs(row.width - +((100 * row.strength) / row.score).toFixed(2)) < 0.011,
    "shipped width is the shipped strength normalized per aligned rung");
  assert.ok(row.rrv != null && row.rrv > 1.6 && row.rrv < 2.6,
    `retest volume reads ~2x for a doubled final day, got ${row.rrv}`);
  for (const e of p.getTrend().long.stocks) if (!e.retest) assert.ok(e.rrv == null, "rrv only rides a retest");
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
  // series identity, not just same-answer: each tf is literally the ladder's input for that rung
  const b4 = bucketCandles(hourly, 4, HOUR), b12 = bucketCandles(hourly, 12, HOUR);
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
  const b24 = new Map(bucketCandles(hourly, 24, HOUR).map((b) => [Math.floor(b.t / DAY), b]));
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

test("trend retest -> ledger signal: the board's badge fires a claim with frozen ladder geometry", () => {
  // The RETEST badge promoted to the ledger. Contract under test, end to end: the condition IS
  // the board (score >= 3, board-visible, retest set by trendRead's own gate); the claim's void
  // is the retesting rung's OWN EMA21 as shipped on the trend payload; the target is the
  // rung-series prior swing, also shipped (the modal's target line and the ledger freeze are the
  // same number); side/geometry are valid; horizon is 5d; features (rung, board score, rrv,
  // age) are recorded on the entry — recorded, not gated.
  const { createPoller } = require("../src/poller");
  const store = { loadAll: () => new Map(), loadRegime: () => [], loadLedger: () => null,
    saveLedger: () => {}, insert: () => {}, saveRegime: () => {} };
  const p = createPoller({ dex: "xyz", store, log: () => {}, version: "test", crypto: false });
  const now = Date.now(), endH = Math.floor(now / HOUR);
  const N = 16 * 24, hourly = [];
  for (let i = 0; i < N; i++) {
    const t = (endH - N + i) * HOUR, c = 100 * Math.pow(1.0005, i);
    hourly.push({ t, o: c, h: c * 1.001, l: c * 0.999, c, v: 1 });
  }
  const px = hourly[N - 1].c * 1.0005;
  // rising dailies whose recent LOWS probe the D1 EMA13 (the retest) while closes hold the
  // stack, with one prior swing spike ABOVE the mark so a valid target exists
  const daily = [];
  for (let i = 0; i < 60; i++) {
    const c = px * Math.pow(1.01, i - 59);
    daily.push({ t: (Math.floor(now / DAY) - 60 + i) * DAY, c, l: c * 0.90, h: c * (i === 50 ? 1.15 : 1.002) });
  }
  p.seedRowNow("TRSIG", { px, ticker: "TRSIG", uni: "xyz", vol: 1e6, hourlyRaw: hourly, dailyRaw: daily });
  p.buildTrendNow();
  const row = p.getTrend().long.stocks.find((e) => e.coin === "TRSIG");
  assert.ok(row && row.retest, "fixture produces a board-visible retest");
  assert.ok(row.score >= 3, "retest rows carry trendRead's own >=3/4 gate");
  assert.ok(row.swing != null && row.swing > px, "prior swing ships on the payload and sits on the profit side of the mark");
  const zone = row.tf[row.retest];
  assert.ok(zone && zone.e21 > 0 && zone.e21 < px, "retesting rung's EMA21 shipped, below the mark for a long");
  p.buildSignalsNow();
  const sigs = p.getSignals();
  const s = sigs && sigs.signals ? sigs.signals.find((g) => g.coin === "TRSIG" && g.ev === "tretest") : null;
  assert.ok(s, "tretest signal is visible in the signals payload");
  assert.equal(s.play.side, "long", "play side follows the board side");
  const rel = (a, b) => Math.abs(a - b) / Math.abs(b);
  assert.ok(rel(s.play.stop, zone.e21) < 1e-5, "frozen void IS the ladder's own EMA21 for the retesting rung");
  assert.ok(rel(s.play.target, row.swing) < 1e-5, "frozen target IS the shipped prior-swing level");
  assert.ok(s.reading.includes(row.retest), "reading names the retesting rung");
  const led = p.getLedgerFor("TRSIG", "tretest");
  assert.equal(led.open.length, 1, "exactly one open claim — the episode gate holds");
  const e = led.open[0];
  assert.equal(e.side, "long", "claim side is play-signed");
  assert.ok(Math.abs(e.resolveAt - e.t0 - 5 * DAY) < 1000, "5d horizon");
  assert.ok(e.mv != null && e.mv > 0, "mv (target distance) stamped for the move-filtered record");
  // second build inside the same episode: no serial re-open (the pseudo-replication guard)
  p.buildSignalsNow();
  assert.equal(p.getLedgerFor("TRSIG", "tretest").open.length, 1, "same episode never opens a second claim");
  // and the short mirror stays silent on a long-side retest
  assert.equal(p.getLedgerFor("TRSIG", "tretestdn").open.length, 0, "no phantom short claim");
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

// ===== AI analyst report ========================================================================
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

test("ai report: context compiler builds a universe-tagged payload with D1/H12/H4 only, coverage, and flags", () => {
  const { p, px } = aiTestPoller();
  const ctx = p.aiCompileNow("xyz:NVDA");
  assert.ok(ctx, "compiler returned nothing for a seeded market");
  assert.equal(ctx.universe, "stocks");
  assert.equal(ctx.ticker, "NVDA");
  assert.ok(Math.abs(ctx.px - px) / px < 1e-6, "px mismatch");
  assert.equal(ctx.benchmark, "SP500");
  assert.ok(ctx.trend && ctx.trend.tf, "trend ladder missing");
  for (const t of ["D1", "H12", "H4"]) assert.ok(ctx.trend.tf[t], `trend rung missing: ${t}`);
  assert.ok(!("H1" in ctx.trend.tf), "H1 must be excluded from the AI context");
  assert.equal(ctx.trend.tf.D1.st, "up", "a steady riser must read D1 up");
  assert.ok(ctx.coverage && Array.isArray(ctx.coverage.hourlyGaps) && Array.isArray(ctx.coverage.oiGaps), "coverage block missing");
  assert.ok(Array.isArray(ctx.flags), "flags must be an array (possibly empty)");
  assert.ok(ctx.market && typeof ctx.market.chg === "object", "market state missing");
  assert.ok(ctx.volRegime && ctx.volRegime.rangePosPct >= 90, "a fresh-high riser must sit at the top of its range");
  assert.equal(p.aiCompileNow("xyz:NOPE"), null, "unknown coin must compile to null, never a fabricated context");
});

test("ai report: validator accepts a conforming payload, normalizes probabilities, and computes R/R + EV server-side", () => {
  const { p, px } = aiTestPoller();
  const voidLv = +(px * 0.95).toPrecision(6), tgt = +(px * 1.10).toPrecision(6);
  const r = p.aiIngestNow("xyz:NVDA", AI_GOOD(px, voidLv, tgt), "test-model");
  assert.ok(r.ok, "conforming payload rejected: " + (r.error || ""));
  const c = r.report.computed;
  assert.ok(Math.abs(c.voidLevel - voidLv) / voidLv < 1e-4, "void level not carried through");
  const risk = px - voidLv;
  const scT = c.scenarios.find((s) => s.kind === "target");
  assert.ok(Math.abs(scT.payoffR - (tgt - px) / risk) < 0.02, `target payoff wrong: ${scT.payoffR}`);
  assert.equal(scT.rr, Math.abs(scT.payoffR), "rr must be |payoff| for the target scenario");
  assert.equal(c.scenarios.find((s) => s.kind === "void").payoffR, -1, "void scenario is -1R by construction");
  assert.equal(c.scenarios.find((s) => s.kind === "flat").payoffR, 0, "flat scenario contributes 0");
  const ev = +(0.5 * scT.payoffR + 0.3 * 0 + 0.2 * -1).toFixed(2);
  assert.equal(c.evR, ev, `EV must be the exact probability-weighted sum, got ${c.evR} want ${ev}`);
  const psum = c.scenarios.reduce((a, s) => a + s.p, 0);
  assert.ok(Math.abs(psum - 1) < 0.01, "probabilities must normalize to 1");
  assert.equal(r.report.status, "fresh", "a just-generated report is fresh");
});

test("ai report: validator rejects garbage — bad bias, broken probabilities, fences survive, silly levels", () => {
  const { p, px } = aiTestPoller();
  const voidLv = +(px * 0.95).toPrecision(6), tgt = +(px * 1.10).toPrecision(6);
  const mut = (fn) => { const o = JSON.parse(AI_GOOD(px, voidLv, tgt)); fn(o); return JSON.stringify(o); };
  assert.equal(p.aiValidateNow(mut((o) => { o.bias = "moon"; }), p.aiCompileNow("xyz:NVDA")).ok, false, "bad bias must fail");
  assert.equal(p.aiValidateNow(mut((o) => { o.scenarios[0].p = 0.9; }), p.aiCompileNow("xyz:NVDA")).ok, false, "probability sum far from 1 must fail");
  assert.equal(p.aiValidateNow(mut((o) => { o.levels[1].value = px * 5; }), p.aiCompileNow("xyz:NVDA")).ok, false, "level outside sanity bounds must fail");
  assert.equal(p.aiValidateNow(mut((o) => { o.synthesis = "too short"; }), p.aiCompileNow("xyz:NVDA")).ok, false, "one-liner synthesis must fail");
  assert.equal(p.aiValidateNow("the market feels bullish, roughly", p.aiCompileNow("xyz:NVDA")).ok, false, "prose instead of JSON must fail");
  // markdown fences around valid JSON must survive (models do this even when told not to)
  assert.equal(p.aiValidateNow("```json\n" + AI_GOOD(px, voidLv, tgt) + "\n```", p.aiCompileNow("xyz:NVDA")).ok, true, "fenced JSON must parse");
});

test("ai report: TTL cooldown gates regeneration for everyone; material change unlocks it with the reason", async () => {
  const { p, px } = aiTestPoller({ aiFetch: async () => ({ ok: true, json: async () => ({ stop_reason: "end_turn",
    content: [{ type: "text", text: AI_GOOD(px, +(px * 0.95).toPrecision(6), +(px * 1.10).toPrecision(6)) }] }) }) });
  const g1 = await p.generateAiReport("xyz:NVDA");
  assert.ok(g1.ok, "first generation must succeed: " + (g1.error || ""));
  const g2 = await p.generateAiReport("xyz:NVDA");
  assert.equal(g2.ok, false); assert.equal(g2.error, "cooldown", "second generation inside TTL must be refused server-side");
  assert.ok(g2.regenInMs > 0, "cooldown must report time remaining");
  assert.equal(p.getAiReport("xyz:NVDA").status, "fresh");
  // material change: a claim resolving on this name flips the report to invalidated + unlocks
  p.aiTouchStamp("xyz:NVDA", { closedN: -1 });   // stored stamp now BELOW the live count → "claim resolved"
  const st = p.getAiReport("xyz:NVDA");
  assert.equal(st.status, "invalidated");
  assert.equal(st.invalidReason, "claim resolved");
  assert.equal(st.canRegen, true, "invalidation must unlock regeneration before TTL");
  const g3 = await p.generateAiReport("xyz:NVDA");
  assert.ok(g3.ok, "regeneration after material change must be allowed: " + (g3.error || ""));
});

test("ai report: frozen claim geometry wins — a model void that disagrees with the live claim stop is overwritten", async () => {
  const { p, px } = aiTestPoller({ aiFetch: async () => ({ ok: true, json: async () => ({ stop_reason: "end_turn",
    content: [{ type: "text", text: AI_GOOD(px, +(px * 0.90).toPrecision(6), +(px * 1.10).toPrecision(6)) }] }) }) });
  // fabricate a live claim anchor by compiling, then validating against a ctx that carries one
  const ctx = p.aiCompileNow("xyz:NVDA");
  const stop = +(px * 0.95).toPrecision(6);
  ctx.claimAnchor = { ev: "breakout", side: "long", stop, target: null, t0: Date.now(), resolveAt: Date.now() + 86400000 };
  const val = p.aiValidateNow(AI_GOOD(px, +(px * 0.90).toPrecision(6), +(px * 1.10).toPrecision(6)), ctx);
  assert.ok(val.ok, "payload must validate: " + (val.error || ""));
  assert.ok(Math.abs(val.computed.voidLevel - stop) / stop < 1e-6, "void must be pinned to the frozen claim stop");
  assert.equal(val.computed.correctedVoid, true, "the correction must be flagged, not silent");
  // and the risk/EV math must follow the CORRECTED void, not the model's
  const risk = px - stop, scT = val.computed.scenarios.find((s) => s.kind === "target");
  assert.ok(Math.abs(scT.payoffR - (+(px * 1.10).toPrecision(6) - px) / risk) < 0.02, "payoff must use the corrected risk unit");
});

test("ai report: Fable failure falls back to Opus; both failing surfaces an honest error and caches nothing", async () => {
  let calls = [];
  const { p, px } = aiTestPoller({ aiFetch: async (url, opts) => {
    const body = JSON.parse(opts.body); calls.push(body.model);
    if (calls.length === 1) return { ok: true, json: async () => ({ stop_reason: "refusal", content: [] }) };   // Fable refuses (HTTP 200!)
    return { ok: true, json: async () => ({ stop_reason: "end_turn",
      content: [{ type: "text", text: AI_GOOD(px, +(px * 0.95).toPrecision(6), +(px * 1.10).toPrecision(6)) }] }) };
  } });
  const g = await p.generateAiReport("xyz:NVDA");
  assert.ok(g.ok, "fallback must rescue a primary refusal: " + (g.error || ""));
  assert.equal(calls[0], "claude-fable-5", "primary must be Fable");
  assert.equal(calls[1], "claude-opus-4-8", "fallback must be Opus");
  assert.equal(g.report.model, "claude-opus-4-8", "the report must name the model that actually produced it");
  // both failing: error out, cache stays empty
  const { p: p2 } = aiTestPoller({ aiFetch: async () => ({ ok: false, status: 500, json: async () => ({}) }) });
  const g2 = await p2.generateAiReport("xyz:NVDA");
  assert.equal(g2.ok, false, "double failure must not fabricate a report");
  assert.equal(p2.getAiReport("xyz:NVDA").status, "none", "a failed generation must cache nothing");
});

test("ai report: universe gate — unknown coins and disabled-crypto rows are refused at both read and generate", async () => {
  const { p } = aiTestPoller();
  assert.equal(p.getAiReport("xyz:GHOST").status, "none");
  const g = await p.generateAiReport("xyz:GHOST");
  assert.equal(g.ok, false, "generation for a non-universe coin must be refused");
  // crypto:false poller — a main-dex coin (no colon → uni main) is outside the live universe
  const g2 = await p.generateAiReport("SOL");
  assert.equal(g2.ok, false, "crypto-disabled server must refuse main-dex generation");
});

test("client + server integrity: the Report tab ships end to end (markers, styles, retention bump)", () => {
  const fs = require("fs"), path = require("path");
  const app = fs.readFileSync(path.join(__dirname, "..", "public", "app.js"), "utf8");
  const css = fs.readFileSync(path.join(__dirname, "..", "public", "styles.css"), "utf8");
  const html = fs.readFileSync(path.join(__dirname, "..", "public", "index.html"), "utf8");
  const srv = fs.readFileSync(path.join(__dirname, "..", "server.js"), "utf8");
  const pol = fs.readFileSync(path.join(__dirname, "..", "src", "poller.js"), "utf8");
  const sto = fs.readFileSync(path.join(__dirname, "..", "src", "store.js"), "utf8");
  for (const frag of ['data-view="report"', 'id="view-report"', 'id="ai-q"', 'id="ai-sug"', 'id="ai-report"', 'id="ai-recent"'])
    assert.ok(html.includes(frag), `index.html missing report marker: ${frag}`);
  for (const frag of ["openAiReport", "openReportView", "aiReportChart", "loadAiRecent", "aiRegenerate", "aiMatches", "HELP.report", "setHidden('view-report'"])
    assert.ok(app.includes(frag), `app.js missing report marker: ${frag}`);
  assert.ok(app.includes("v!=='report'"), "crypto-scope whitelist must include the report view");
  assert.ok(app.includes("openAiReport(coin)"), "drawer deep link must route into the report view");
  for (const cls of [".ai-sug", ".ai-head", ".ai-badge", ".ai-scen", ".ai-foot", ".ai-rec", ".ai-flag"])
    assert.ok(css.includes(cls), `styles.css missing report style: ${cls}`);
  for (const frag of ["/api/ai-report", "/api/ai-reports", "generateAiReport", "429"])
    assert.ok(srv.includes(frag), `server.js missing report marker: ${frag}`);
  for (const frag of ["claude-fable-5", "claude-opus-4-8", "gpt-5.6-sol", "gpt-5.6-terra", "ANTHROPIC_API_KEY", "OPENAI_API_KEY", "api.openai.com/v1/chat/completions", "max_completion_tokens", "anthropic-version", "stop_reason", "AI_PROVIDER", "validateAiReport", "compileAiContext", "trendAlignAtFire"])
    assert.ok(pol.includes(frag), `poller.js missing AI engine marker: ${frag}`);
  for (const frag of ["saveAiReports", "loadAiReports", "ai-reports.json"])
    assert.ok(sto.includes(frag), `store.js missing AI persistence marker: ${frag}`);
  // The 90d crypto daily retention is a constant, and BOTH the fetch and the payload cap must ride it —
  // a bare "40" or "MAIN_HIST_DAYS" left behind in either spot silently shrinks the window back.
  assert.ok(/const MAIN_DAILY_DAYS = 9\d;/.test(pol), "crypto daily retention must be ~90d via MAIN_DAILY_DAYS");
  assert.ok(pol.includes("now - MAIN_DAILY_DAYS * DAY"), "crypto daily fetch must use MAIN_DAILY_DAYS");
  assert.ok(pol.includes("dr.slice(-(MAIN_DAILY_DAYS + 2))"), "crypto daily payload cap must ride MAIN_DAILY_DAYS");
});

test("ai report: OpenAI provider — Chat Completions shape, Bearer auth, Sol→Terra fallback on refusal", async () => {
  // Provider selection is read from env at construction — pin it for this test, restore after.
  const prevProv = process.env.AI_PROVIDER, prevKey = process.env.OPENAI_API_KEY;
  process.env.AI_PROVIDER = "openai"; process.env.OPENAI_API_KEY = "sk-test-openai";
  try {
    const calls = [];
    let px0;
    const mk = () => aiTestPoller({ aiFetch: async (url, opts) => {
      const body = JSON.parse(opts.body);
      calls.push({ url, model: body.model, auth: opts.headers.authorization, body });
      if (calls.length === 1) return { ok: true, json: async () => ({ choices: [{ message: { refusal: "declined" }, finish_reason: "stop" }] }) };
      return { ok: true, json: async () => ({ choices: [{ message: { content: AI_GOOD(px0, +(px0 * 0.95).toPrecision(6), +(px0 * 1.10).toPrecision(6)) }, finish_reason: "stop" }] }) };
    } });
    const { p, px } = mk(); px0 = px;
    const g = await p.generateAiReport("xyz:NVDA");
    assert.ok(g.ok, "OpenAI path must generate: " + (g.error || ""));
    assert.ok(calls[0].url.includes("api.openai.com/v1/chat/completions"), "must hit Chat Completions");
    assert.equal(calls[0].auth, "Bearer sk-test-openai", "must authenticate with a Bearer token");
    assert.equal(calls[0].model, "gpt-5.6-sol", "OpenAI primary must default to Sol");
    assert.equal(calls[1].model, "gpt-5.6-terra", "OpenAI fallback must default to Terra");
    assert.equal(g.report.model, "gpt-5.6-terra", "the report names the model that actually produced it");
    assert.equal(calls[0].body.messages[0].role, "system", "system prompt rides as a system message");
    assert.ok("max_completion_tokens" in calls[0].body && !("max_tokens" in calls[0].body),
      "GPT-5.x requires max_completion_tokens, not max_tokens");
    assert.ok(calls[0].body.max_completion_tokens >= 8000, "OpenAI budget must cover reasoning tokens on top of output");
    // empty output with finish_reason length = the budget was eaten by reasoning — a NAMED error, not a mystery
    const { p: p2 } = aiTestPoller({ aiFetch: async () => ({ ok: true, json: async () => ({ choices: [{ message: { content: "" }, finish_reason: "length" }] }) }) });
    const g2 = await p2.generateAiReport("xyz:NVDA");
    assert.equal(g2.ok, false);
    assert.ok(/token budget/.test(g2.error), "budget exhaustion must be named in the error: " + g2.error);
  } finally {
    if (prevProv === undefined) delete process.env.AI_PROVIDER; else process.env.AI_PROVIDER = prevProv;
    if (prevKey === undefined) delete process.env.OPENAI_API_KEY; else process.env.OPENAI_API_KEY = prevKey;
  }
});

test("ai report: provider auto-detection — OPENAI_API_KEY alone selects OpenAI; no keys stays disabled with an honest error", async () => {
  const prevProv = process.env.AI_PROVIDER, prevO = process.env.OPENAI_API_KEY, prevA = process.env.ANTHROPIC_API_KEY;
  delete process.env.AI_PROVIDER; delete process.env.ANTHROPIC_API_KEY;
  try {
    process.env.OPENAI_API_KEY = "sk-test";
    { const { p } = aiTestPoller();
      const l = p.listAiReports();
      assert.equal(l.provider, "openai", "OPENAI_API_KEY alone must auto-select the openai provider");
      assert.equal(l.model, "gpt-5.6-sol");
      assert.equal(l.enabled, true); }
    delete process.env.OPENAI_API_KEY;
    { const { p } = aiTestPoller();
      assert.equal(p.listAiReports().enabled, false, "no keys = disabled");
      const g = await p.generateAiReport("xyz:NVDA");
      assert.equal(g.ok, false);
      assert.ok(/ANTHROPIC_API_KEY or OPENAI_API_KEY/.test(g.error), "the error must name BOTH accepted variables: " + g.error); }
  } finally {
    if (prevProv === undefined) delete process.env.AI_PROVIDER; else process.env.AI_PROVIDER = prevProv;
    if (prevO === undefined) delete process.env.OPENAI_API_KEY; else process.env.OPENAI_API_KEY = prevO;
    if (prevA === undefined) delete process.env.ANTHROPIC_API_KEY; else process.env.ANTHROPIC_API_KEY = prevA;
  }
});

test("ai report: level discipline — EMA annotations banned, directional reads require a correctly-sided void, opposing-bias anchors don't override", () => {
  const { p, px } = aiTestPoller();
  const ctx = () => p.aiCompileNow("xyz:NVDA");
  const voidLv = +(px * 0.95).toPrecision(6), tgt = +(px * 1.10).toPrecision(6);
  const mut = (fn) => { const o = JSON.parse(AI_GOOD(px, voidLv, tgt)); fn(o); return JSON.stringify(o); };
  // EMAs drift — banned as static chart levels (this exact failure shipped in the first live report)
  const r1 = p.aiValidateNow(mut((o) => { o.levels[1].label = "Daily EMA13 resistance"; }), ctx());
  assert.equal(r1.ok, false); assert.ok(/moving averages/.test(r1.error), r1.error);
  // a directional read with no void level is unfalsifiable — hard fail, not a card full of dashes
  const r2 = p.aiValidateNow(mut((o) => { o.levels = [o.levels[1]]; o.scenarios = o.scenarios.filter((s) => s.kind !== "void").concat([{ name: "fades", kind: "flat", p: 0.2, target: null }]); }), ctx());
  assert.equal(r2.ok, false); assert.ok(/without a void level/.test(r2.error), r2.error);
  // ...and a void scenario is required too, not just the level
  const r3 = p.aiValidateNow(mut((o) => { o.scenarios = [{ name: "up", kind: "target", p: 0.6, target: tgt }, { name: "chop", kind: "flat", p: 0.4, target: null }]; }), ctx());
  assert.equal(r3.ok, false); assert.ok(/without a void scenario/.test(r3.error), r3.error);
  // inverted geometry: a "void" ABOVE price on a long read is the stop-geometry bug class — rejected
  const r4 = p.aiValidateNow(mut((o) => { o.levels[0].value = +(px * 1.05).toPrecision(6); }), ctx());
  assert.equal(r4.ok, false); assert.ok(/long void must sit below/.test(r4.error), r4.error);
  // max 4 levels, at most one target
  const r5 = p.aiValidateNow(mut((o) => { o.levels.push({ value: +(px * 1.2).toPrecision(6), kind: "target", label: "second target" }); }), ctx());
  assert.equal(r5.ok, false); assert.ok(/multiple target/.test(r5.error), r5.error);
  // opposing-bias anchor: a LONG claim's stop must NOT be forced onto a SHORT read — the short
  // read carries its own void above price and validates on its own geometry
  const cx = ctx();
  cx.claimAnchor = { ev: "breakout", side: "long", stop: +(px * 0.95).toPrecision(6), target: null, t0: Date.now(), resolveAt: Date.now() + 86400000 };
  const shortPayload = JSON.stringify(Object.assign(JSON.parse(AI_GOOD(px, voidLv, tgt)), {
    bias: "short", headline: "Rolling over, leans short",
    news_read: { used: false, note: "no verified headlines in the window" },
    scenarios: [
      { name: "breakdown extends", kind: "target", p: 0.5, target: +(px * 0.90).toPrecision(6), note: "downtrend persists" },
      { name: "chop", kind: "flat", p: 0.3, target: null },
      { name: "reclaims the void", kind: "void", p: 0.2, target: null },
    ],
    levels: [
      { value: +(px * 1.04).toPrecision(6), kind: "void", label: "void — reclaim kills the short" },
      { value: +(px * 0.90).toPrecision(6), kind: "target", label: "breakdown target" },
    ],
  }));
  const r6 = p.aiValidateNow(shortPayload, cx);
  assert.ok(r6.ok, "opposing-bias read with its own void must validate: " + (r6.error || ""));
  assert.ok(Math.abs(r6.computed.voidLevel - px * 1.04) / px < 0.001, "the short's OWN void must survive, not the long claim's stop");
  assert.equal(r6.computed.correctedVoid, false, "no correction when the anchor doesn't apply");
  // and short-side payoff math: target below price pays POSITIVE for a short
  const scT = r6.computed.scenarios.find((s) => s.kind === "target");
  assert.ok(scT.payoffR > 0, "thesis-direction short target must pay positive, got " + scT.payoffR);
});

test("client: report chart renderer ships the fixes — price-only domain, line mode, staggered labels, clustered marks, span-aware axis, norisk grid", () => {
  const fs = require("fs"), path = require("path");
  const app = fs.readFileSync(path.join(__dirname, "..", "public", "app.js"), "utf8");
  const css = fs.readFileSync(path.join(__dirname, "..", "public", "styles.css"), "utf8");
  for (const frag of ["lineMode", "close-line mode", "off-chart:", "labs[i].y-labs[i-1].y<15", "groups.find", "axDec", "hasRisk", "ai-scen${hasRisk?'':' norisk'}"])
    assert.ok(app.includes(frag), `app.js missing chart-fix marker: ${frag}`);
  assert.ok(!app.includes("for(const l of levels){ if(l.value<lo)lo=l.value; if(l.value>hi)hi=l.value; }"),
    "the level-driven y-domain (the squashed-chart bug) must be gone");
  assert.ok(css.includes(".ai-scen.norisk"), "styles.css missing the 3-column no-risk scenario grid");
});

test("ai report -73: schema bump invalidates cached reports immediately — a format fix is never hidden behind the TTL", async () => {
  const { p, px } = aiTestPoller({ aiFetch: async () => ({ ok: true, json: async () => ({ stop_reason: "end_turn",
    content: [{ type: "text", text: AI_GOOD(px2, +(px2 * 0.95).toPrecision(6), +(px2 * 1.10).toPrecision(6)) }] }) }) });
  const px2 = px;
  const g = await p.generateAiReport("xyz:NVDA");
  assert.ok(g.ok, g.error || "");
  assert.equal(p.getAiReport("xyz:NVDA").status, "fresh");
  p.aiPatchReport("xyz:NVDA", { schemaV: 1 });   // simulate a report generated before a format change
  const st = p.getAiReport("xyz:NVDA");
  assert.equal(st.status, "invalidated");
  assert.equal(st.invalidReason, "report format updated");
  assert.equal(st.canRegen, true, "an old-format report must unlock regeneration before TTL expiry");
});

test("ai report -73: the action block — pullback entry improves R/R, EV computed at the entry, negative-EV entries are downgraded to wait", () => {
  const { p, px } = aiTestPoller();
  const ctx = () => p.aiCompileNow("xyz:NVDA");
  const voidLv = +(px * 0.95).toPrecision(6), tgt = +(px * 1.10).toPrecision(6);
  const mut = (fn) => { const o = JSON.parse(AI_GOOD(px, voidLv, tgt)); fn(o); return JSON.stringify(o); };
  // enter_now: entry = market -> action rr equals the scenario-table rr at px
  { const r = p.aiValidateNow(AI_GOOD(px, voidLv, tgt), ctx());
    assert.ok(r.ok, r.error || "");
    const a = r.computed.action;
    assert.equal(a.stance, "enter_now"); assert.equal(a.entryIsMarket, true);
    assert.ok(Math.abs(a.rr - (tgt - px) / (px - voidLv)) < 0.02, "market-entry R/R must match the raw geometry");
    assert.ok(Math.abs(a.evR - r.computed.evR) < 0.02, "market-entry EV must equal the scenario EV"); }
  // enter_on_pullback at a better price -> strictly better R/R and EV than at market
  { const pull = +(px * 0.97).toPrecision(6);
    const r = p.aiValidateNow(mut((o) => { o.action = { stance: "enter_on_pullback", entry: pull, note: "buy the dip into the zone" }; }), ctx());
    assert.ok(r.ok, r.error || "");
    const a = r.computed.action;
    assert.ok(Math.abs(a.rr - (tgt - pull) / (pull - voidLv)) < 0.02, "pullback R/R must be computed at the ENTRY, not the mark");
    assert.ok(a.rr > (tgt - px) / (px - voidLv), "a better entry must show a better R/R");
    assert.ok(a.evR > r.computed.evR, "EV at the pullback must beat EV at market"); }
  // a pullback stance without an entry level is a hard fail, not a guess
  { const r = p.aiValidateNow(mut((o) => { o.action = { stance: "enter_on_pullback", entry: null, note: "x" }; }), ctx());
    assert.equal(r.ok, false); assert.ok(/without an entry level/.test(r.error), r.error); }
  // an entry the odds don't pay for: crank the void probability so EV at market goes negative ->
  // server downgrades the stance to wait and says so, rather than shipping a losing plan
  { const r = p.aiValidateNow(mut((o) => { o.scenarios = [
      { name: "continuation", kind: "target", p: 0.15, target: tgt, note: "thin" },
      { name: "chop", kind: "flat", p: 0.25, target: null },
      { name: "breaks the void", kind: "void", p: 0.6, target: null }]; }), ctx());
    assert.ok(r.ok, r.error || "");
    assert.equal(r.computed.action.stance, "wait");
    assert.equal(r.computed.action.downgraded, true, "the downgrade must be stamped, not silent"); }
  // wait/no_trade stances need no geometry and pass through with the note
  { const r = p.aiValidateNow(mut((o) => { o.action = { stance: "wait", entry: null, note: "the print decides in four days" }; }), ctx());
    assert.ok(r.ok, r.error || "");
    assert.equal(r.computed.action.stance, "wait"); }
  // a missing action block is a schema failure now
  { const r = p.aiValidateNow(mut((o) => { delete o.action; }), ctx());
    assert.equal(r.ok, false); assert.ok(/action stance/.test(r.error), r.error); }
});

test("ai report -73: daily OHLC upgrade — a closes-only warm restore renders real candles from the hourly spine", () => {
  const { createPoller } = require("../src/poller");
  const store = { loadAll: () => new Map(), loadRegime: () => [], loadLedger: () => null,
    saveLedger: () => {}, insert: () => {}, saveRegime: () => {}, loadAiReports: () => null, saveAiReports: () => {} };
  const p = createPoller({ dex: "xyz", store, log: () => {}, version: "test", crypto: false });
  const now = Date.now(), N = 30 * 24;
  const hourly = Array.from({ length: N }, (_, i) => {
    const c = 100 + Math.sin(i / 9) * 4;
    return { t: now - (N - 1 - i) * HOUR, o: c - 0.4, h: c + 0.9, l: c - 0.9, c, v: 500 };
  });
  // warm-cache shape: dailies restored as {t,c} ONLY — the exact state that rendered as confetti
  const daily = Array.from({ length: 60 }, (_, i) => ({ t: now - (59 - i) * DAY, c: 100 + Math.sin(i / 4) * 6 }));
  p.seedRowNow("xyz:WARM", { px: 101, dailyRaw: daily, hourlyRaw: hourly, dailyTs: now, hourlyTs: now, isNew: false });
  const rd = p.getTfCandles("xyz:WARM", "1d");
  const covered = rd.candles.filter((k) => k[0] >= now - 28 * DAY);
  assert.ok(covered.length >= 20, "enough recent bars to judge");
  for (const k of covered.slice(1))   // slice(1): the first covered day may be a partial hourly bucket
    assert.ok(k[1] != null && isFinite(k[1]) && k[2] >= k[4] && k[3] <= k[4],
      `recent closes-only bars must upgrade to real hourly-derived OHLC (bar ${new Date(k[0]).toISOString()})`);
  const old = rd.candles.filter((k) => k[0] < now - 32 * DAY);
  assert.ok(old.length && old.every((k) => k[1] == null), "days beyond the hourly spine stay honestly closes-only");
});

test("client -73: multi-timeframe chart + action panel ship end to end", () => {
  const fs = require("fs"), path = require("path");
  const app = fs.readFileSync(path.join(__dirname, "..", "public", "app.js"), "utf8");
  const css = fs.readFileSync(path.join(__dirname, "..", "public", "styles.css"), "utf8");
  const pol = fs.readFileSync(path.join(__dirname, "..", "src", "poller.js"), "utf8");
  for (const frag of ["aiChartTfSeg", "data-aitf", "state.report.tf", "aiActionHtml", "enter_on_pullback", "entryIsMarket", "EMA13 ", "fill-opacity=\"0.08\""])
    assert.ok(app.includes(frag), `app.js missing -73 marker: ${frag}`);
  for (const cls of [".ai-act", ".ai-tf"]) assert.ok(css.includes(cls), `styles.css missing: ${cls}`);
  for (const frag of ["AI_SCHEMA_V", "report format updated", "schemaV: AI_SCHEMA_V", "actionable stance without void/target geometry", "downgraded from an entry stance", "bucketCandles(r.hourlyRaw, 24, HOUR)"])
    assert.ok(pol.includes(frag), `poller.js missing -73 marker: ${frag}`);
});

test("ai report -74/-75: first-fire marks pass the proven-edge gate — episode runs mark once, unproven types are suppressed and counted, sides come from the frozen psd", () => {
  const { createPoller } = require("../src/poller");
  const now = Date.now();
  // Roster record: breakout gets 8 resolved, positive-avg outcomes on OTHER tickers -> proven.
  // gap (n=1) and unwind (n=1) stay unproven -> their fires on N are suppressed and counted.
  const rosterBo = Array.from({ length: 8 }, (_, i) => ({
    key: "xyz:X" + i + "|breakout", coin: "xyz:X" + i, ticker: "X" + i, ev: "breakout",
    t0: now - (60 + i) * 86400000, mark0: 50, dir: 1, score0: 55, sd0: 2,
    status: "resolved", tR: now - (55 + i) * 86400000,
    realized: i < 6 ? 1.2 : -0.8, realizedS: i < 6 ? 1.2 : -0.8, win: i < 6, winS: i < 6, psd: "long", rn: 1 }));
  const fixture = { ts: now, rearm: [], variants: null,
    open: [
      { key: "xyz:N|breakout", coin: "xyz:N", ticker: "N", ev: "breakout", t0: now - 1 * 86400000,
        mark0: 100, dir: 1, score0: 60, sd0: 2, resolveAt: now + 4 * 86400000, psd: "long" },
      // psd-short claim of a PROVEN type on an up-event: kind must be short (trade side, not event sign).
      // breakdown is in R_LEDGER_EVS, so give it a roster record too via the loop below.
      { key: "xyz:N|breakdown", coin: "xyz:N", ticker: "N", ev: "breakdown", t0: now - 10 * 86400000,
        mark0: 95, dir: -1, score0: 50, sd0: 2, resolveAt: now + 86400000, psd: "short" },
    ],
    closed: rosterBo.concat(
      Array.from({ length: 8 }, (_, i) => ({
        key: "xyz:Y" + i + "|breakdown", coin: "xyz:Y" + i, ticker: "Y" + i, ev: "breakdown",
        t0: now - (70 + i) * 86400000, mark0: 40, dir: -1, score0: 50, sd0: 2,
        status: "resolved", tR: now - (65 + i) * 86400000,
        realized: 0.9, realizedS: 0.9, win: true, winS: true, psd: "short", rn: 1 })),
      [
      // the same breakout run, day before (chained: gap 1d <= 2d) — recorded, must NOT re-mark
      { key: "xyz:N|breakout#r1", coin: "xyz:N", ticker: "N", ev: "breakout", t0: now - 2 * 86400000,
        mark0: 99, dir: 1, score0: 55, sd0: 2, status: "resolved", tR: now - 1 * 86400000,
        realized: 0.4, realizedS: 0.4, win: true, winS: true, psd: "long", rn: 1 },
      // a genuinely separate episode 21 days earlier — must mark, with its outcome on the mark
      { key: "xyz:N|breakout#old", coin: "xyz:N", ticker: "N", ev: "breakout", t0: now - 21 * 86400000,
        mark0: 80, dir: 1, score0: 62, sd0: 2, status: "resolved", tR: now - 16 * 86400000,
        realized: 2.0, realizedS: 2.0, win: true, winS: true, psd: "long", rn: 1 },
      // unproven types firing on N: recorded in the ledger, SUPPRESSED on the chart
      { key: "xyz:N|gap", coin: "xyz:N", ticker: "N", ev: "gap", t0: now - 10 * 86400000,
        mark0: 95, dir: 1, score0: 50, status: "resolved", tR: now - 9 * 86400000,
        realized: 1.1, realizedS: 1.1, win: true, winS: true, psd: "short", rn: 1 },
      { key: "xyz:N|unwind", coin: "xyz:N", ticker: "N", ev: "unwind", t0: now - 6 * 86400000,
        mark0: 92, dir: -1, score0: 45, sd0: 2, status: "void", tR: now - 5 * 86400000, rn: 1 },
    ]) };
  const store = { loadAll: () => new Map(), loadRegime: () => [], loadLedger: () => fixture,
    saveLedger: () => {}, insert: () => {}, saveRegime: () => {}, loadAiReports: () => null, saveAiReports: () => {} };
  const p = createPoller({ dex: "xyz", store, log: () => {}, version: "test", crypto: false });
  p.hydrateLedgerNow();
  const { marks, suppressed } = p.aiMarksNow("xyz:N", "N", 92 * 86400000);
  const bo = marks.filter((m) => m.ev === "breakout");
  assert.equal(bo.length, 2, `chained breakout run must mark once per episode (got ${bo.length})`);
  assert.ok(bo.some((m) => Math.abs(m.t - (now - 21 * 86400000)) < 1000), "the separate old episode keeps its own mark");
  assert.ok(bo.some((m) => Math.abs(m.t - (now - 2 * 86400000)) < 1000), "the current run marks at its ONSET, not the live re-fire");
  const bd = marks.find((m) => m.ev === "breakdown");
  assert.ok(bd, "a proven short-side type must mark");
  assert.equal(bd.kind, "short", "the mark carries the TRADE side from psd");
  assert.ok(!marks.some((m) => m.ev === "gap"), "unproven gap (roster n=1) must be suppressed");
  assert.ok(!marks.some((m) => m.ev === "unwind"), "unproven unwind must be suppressed");
  assert.equal(suppressed, 2, "suppressed fires are counted for disclosure, never silently dropped");
  const oldBo = marks.find((m) => Math.abs(m.t - (now - 21 * 86400000)) < 1000);
  assert.equal(oldBo.status, "resolved");
  assert.equal(oldBo.realized, 2.0, "resolved outcome ships on the mark for the legend");
  assert.equal(oldBo.unit, "R");
  // the name-specific override: 5 resolved with >=60% hit on THIS name proves a type the roster
  // hasn't — seed a second poller where only N's own record carries the edge
  const fx2 = { ts: now, rearm: [], variants: null, open: [], closed: Array.from({ length: 5 }, (_, i) => ({
    key: "xyz:N|squeeze#" + i, coin: "xyz:N", ticker: "N", ev: "squeeze",
    t0: now - (10 + i * 8) * 86400000, mark0: 90, dir: 1, score0: 40,
    status: "resolved", tR: now - (8 + i * 8) * 86400000,
    realized: i < 4 ? 2.0 : -1.0, realizedS: i < 4 ? 2.0 : -1.0, win: i < 4, winS: i < 4, psd: "long", rn: 1 })) };
  const p2 = createPoller({ dex: "xyz", store: Object.assign({}, store, { loadLedger: () => fx2 }), log: () => {}, version: "test", crypto: false });
  p2.hydrateLedgerNow();
  const r2 = p2.aiMarksNow("xyz:N", "N", 92 * 86400000);
  assert.ok(r2.marks.filter((m) => m.ev === "squeeze").length >= 1, "a name-specific 4/5 record proves the type for THIS name");
});

test("client -74: side-typed glyphs + legend ship end to end; schema bumped so -73 reports invalidate", () => {
  const fs = require("fs"), path = require("path");
  const app = fs.readFileSync(path.join(__dirname, "..", "public", "app.js"), "utf8");
  const css = fs.readFileSync(path.join(__dirname, "..", "public", "styles.css"), "utf8");
  const pol = fs.readFileSync(path.join(__dirname, "..", "src", "poller.js"), "utf8");
  for (const frag of ["AI_MK", "ai-mkleg", "proven-edge signals only", "g.kind==='short'", "distinct signal types at onset", "outTxt", "marksSuppressed"])
    assert.ok(app.includes(frag), `app.js missing -74 marker: ${frag}`);
  assert.ok(css.includes(".ai-mkleg"), "styles.css missing the marker legend");
  for (const frag of ["const AI_SCHEMA_V = 6;", "aiMarksNow", "aiEvEdge", "AI_MARK_MIN_N", "runsOn", "lastEnd", "marksSuppressed"])
    assert.ok(pol.includes(frag), `poller.js missing -74 marker: ${frag}`);
});

test("UI batch -99: density toggle, keyboard nav and focused-ticker chip are fully wired", () => {
  // Three independent features shipped in one build — each pinned across every file it touches,
  // so a partial delivery (markup without wiring, wiring without CSS) is a suite failure.
  const fs = require("fs"), path = require("path");
  const app = fs.readFileSync(path.join(__dirname, "..", "public", "app.js"), "utf8");
  const html = fs.readFileSync(path.join(__dirname, "..", "public", "index.html"), "utf8");
  const css = fs.readFileSync(path.join(__dirname, "..", "public", "styles.css"), "utf8");
  // Density: pre-paint restore in the shell (no flash), attribute-driven CSS, persisted preference.
  assert.ok(html.includes("xyzmon.density"), "density pre-paint restore missing from index.html");
  assert.ok(css.includes('[data-density="compact"] .wrap tbody td'), "compact table CSS missing");
  assert.ok(app.includes("store.set('xyzmon.density'"), "density persistence missing");
  // Keyboard nav: slash-search map, j/k movement, re-applied highlight after each render.
  for (const pin of ["kmoveSel(1)", "kmoveSel(-1)", "CSS.escape(state.ksel)", "applyKsel();   // innerHTML rebuild"])
    assert.ok(app.includes(pin), `keyboard nav pin missing: ${pin}`);
  assert.ok(css.includes(".wrap tbody tr.krow td"), "krow highlight CSS missing");
  // Focused ticker: set on drawer open, chip in the statusline, report-tab fallback.
  assert.ok(app.includes("state.focus=coin; updateFocusChip()"), "openDetail must set the focus");
  assert.ok(app.includes("state.focus && state.rows.has(state.focus)"), "report-tab focus fallback missing");
  for (const id of ["focusChipT", "focusChipX"]) assert.ok(html.includes(`id="${id}"`), `focus chip markup missing: ${id}`);
  assert.ok(css.includes(".fchip-t{"), "focus chip CSS missing");
});

test("mobile suite -100: touch parity, mobile preset and PWA shell are fully wired", () => {
  // Four surfaces in one build, each pinned across every file it touches. The service worker is
  // additionally pinned to be CACHE-FREE: a fetch handler that intercepts nothing. Any future
  // edit that adds caches.open / caches.match to /sw.js is reintroducing the stale-client bug
  // class the version-stamped shell exists to kill, and must fail here first.
  const fs = require("fs"), path = require("path");
  const app = fs.readFileSync(path.join(__dirname, "..", "public", "app.js"), "utf8");
  const html = fs.readFileSync(path.join(__dirname, "..", "public", "index.html"), "utf8");
  const css = fs.readFileSync(path.join(__dirname, "..", "public", "styles.css"), "utf8");
  const srv = fs.readFileSync(path.join(__dirname, "..", "server.js"), "utf8");
  // Touch parity: long-press hover in the tooltip engine, horizontal-intent scrub on line charts.
  for (const pin of ["touchstart", "touchmove", "touchend", "lp.scrub", "scrubAt(t.clientX)", "dx>dy+4"])
    assert.ok(app.includes(pin), `touch parity pin missing: ${pin}`);
  // Mobile preset: curated columns, built-in Layouts row, one-shot first-visit auto-apply.
  assert.ok(app.includes("const MOBILE_COLS="), "MOBILE_COLS missing");
  assert.ok(app.includes("data-mob="), "built-in Mobile layout row missing");
  assert.ok(app.includes("xyzmon.mobilePreset.v1"), "one-shot auto-apply flag missing");
  for (const k of ["'ticker'", "'px'", "'d1'", "'funding'"])
    assert.ok(app.match(/const MOBILE_COLS=\[[^\]]*\]/)[0].includes(k), `mobile preset must keep ${k}`);
  // PWA shell: head tags in the markup, registration in the client, inline routes in the server.
  for (const pin of ['rel="manifest"', 'name="theme-color"', 'href="/icon.svg"'])
    assert.ok(html.includes(pin), `PWA head tag missing: ${pin}`);
  assert.ok(app.includes("serviceWorker.register('/sw.js')"), "SW registration missing");
  assert.ok(srv.includes("PWA_MANIFEST") && srv.includes("PWA_SW"), "inline PWA payloads missing from server");
  // The SW must stay a no-op passthrough: install-prompt eligibility, zero caching.
  const sw = srv.match(/const PWA_SW = "([^"]+)"/);
  assert.ok(sw, "PWA_SW literal missing");
  assert.ok(sw[1].includes("addEventListener('fetch'"), "SW needs a fetch handler for installability");
  assert.ok(!sw[1].includes("caches") && !sw[1].includes("respondWith"), "SW must not cache or intercept — stale-client hazard");
  // Mobile CSS: sticky ticker column, full-width drawer, scrollable tab strip, touch targets.
  for (const pin of [".wrap tbody td:first-child{position:sticky", ".drawer{width:100vw", "(hover:none) and (pointer:coarse)"])
    assert.ok(css.includes(pin), `mobile css pin missing: ${pin}`);
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

test("perf: hourly spine persists as NDJSON, restores by streaming, and bridges the legacy json once", async () => {
  const { openStore } = require("../src/store");
  const fs = require("fs"), os = require("os"), path = require("path");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "perf-hstore-"));
  try {
    const s = openStore(dir);
    const hourly = {};
    for (let k = 0; k < 40; k++) { const arr = []; for (let i = 0; i < 300; i++) arr.push([1721000000000 + i * HOUR, 1 + i * 0.01, 1.5, 0.9, 1.2, 1000 + i]); hourly["C" + k] = arr; }
    await s.saveHourly({ ts: 1721563200000, hourly });
    assert.ok(fs.existsSync(path.join(dir, "hourly.ndjson")), "NDJSON spine written");
    // exact round-trip via the streaming reader
    const got = {}; const meta = await s.streamHourly((coin, c) => { got[coin] = c; });
    assert.equal(meta.coins, 40, "all coins streamed back");
    assert.equal(meta.ts, 1721563200000, "header ts restored");
    assert.deepEqual(got["C7"], hourly["C7"], "candle arrays survive the round-trip byte-for-byte");
    // legacy bridge: only the old whole-object json present -> still restores
    fs.unlinkSync(path.join(dir, "hourly.ndjson"));
    fs.writeFileSync(path.join(dir, "hourly.json"), JSON.stringify({ ts: 42, hourly: { LEG: [[1, 2, 3, 4, 5, 6]]} }));
    const s2 = openStore(dir); const leg = {}; const lm = await s2.streamHourly((coin, c) => { leg[coin] = c; });
    assert.deepEqual(leg.LEG, [[1, 2, 3, 4, 5, 6]], "legacy json is read as a one-time bridge");
    assert.equal(lm.ts, 42);
    // after the next NDJSON write, the legacy file is retired so it can't shadow future writes
    await s2.saveHourly({ ts: 7, hourly: { X: [[9, 9, 9, 9, 9, 9]] } });
    assert.ok(!fs.existsSync(path.join(dir, "hourly.json")), "legacy json retired after the first ndjson write");
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test("perf: store source pins the async streamed NDJSON path (no whole-file stringify/parse regression)", () => {
  const fs = require("fs"), path = require("path");
  const st = fs.readFileSync(path.join(__dirname, "..", "src", "store.js"), "utf8");
  assert.ok(st.includes("hourly.ndjson"), "hourly spine must target the NDJSON file");
  assert.ok(/async saveHourly/.test(st), "saveHourly must be async (no synchronous 30MB write on the event loop)");
  assert.ok(st.includes("createWriteStream") && st.includes("streamHourly"), "streamed write + streamed read must both exist");
  assert.ok(st.includes("hourlyWriting"), "overlapping-write guard must exist");
  // the old blocking one-shot must be gone
  assert.ok(!/saveHourly\(data\) \{\s*try \{\s*const tmp = hourlyFile/.test(st), "the old synchronous saveHourly must not survive");
});

test("perf: getHourly memoizes on the hourlyRaw array reference and rebuilds on replacement", () => {
  const fs = require("fs"), path = require("path");
  const pol = fs.readFileSync(path.join(__dirname, "..", "src", "poller.js"), "utf8");
  // the memo must key on the raw array identity, not a timestamp — the only invalidation that
  // provably can't serve a normalized array disagreeing with its source.
  assert.ok(pol.includes("r._hsRaw === c") && pol.includes("r._hs"), "getHourly array-ref memo missing");
  assert.ok(pol.includes("r._hsRaw = c; r._hs = out"), "getHourly memo store missing");
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

test("perf: serveCached caches serialization per payload object; series downsamples; compress has a threshold", () => {
  const fs = require("fs"), path = require("path");
  const srv = fs.readFileSync(path.join(__dirname, "..", "server.js"), "utf8");
  // serialization cache keyed on the object (WeakMap) — NOT on the etag string, which two routes
  // could share and cross-serve.
  assert.ok(srv.includes("new WeakMap()") && srv.includes("serialCache.get(body)"), "per-object serialization cache missing");
  assert.ok(srv.includes("serialCache.set(body, s)"), "serialization cache store missing");
  assert.ok(srv.includes("return reply.send(s)"), "serveCached must send the pre-serialized string");
  assert.ok(srv.includes("threshold: 1024"), "compress threshold missing");
  assert.ok(srv.includes("downsampleSeries") && srv.includes("SERIES_CAP"), "series downsampler missing");
  // 304 revalidation path must remain intact (untouched by the serialization change)
  assert.ok(srv.includes('if (req.headers["if-none-match"] === tag)') && srv.includes("reply.code(304).send()"), "304 revalidation path must survive");

  // behavioral check of the downsampler: caps length, preserves first and (exact) last sample
  const mod = { downsampleSeries: null, SERIES_CAP: null };
  const m = srv.match(/function downsampleSeries\(arr, cap\) \{[\s\S]*?\n\}/);
  assert.ok(m, "downsampleSeries body not found");
  // eslint-disable-next-line no-new-func
  const ds = new Function(m[0] + "; return downsampleSeries;")();
  const big = []; for (let i = 0; i < 9000; i++) big.push([i, i * 2]);
  const out = ds(big, 1500);
  assert.ok(out.length <= 1501, `downsampled length ${out.length} must be ~cap`);
  assert.deepEqual(out[0], [0, 0], "first sample preserved");
  assert.deepEqual(out[out.length - 1], big[big.length - 1], "live-edge (last) sample preserved exactly");
  assert.deepEqual(ds([[1, 1], [2, 2]], 1500), [[1, 1], [2, 2]], "arrays under the cap pass through untouched");
  assert.deepEqual(ds(null, 1500), [], "null track degrades to empty");
});
