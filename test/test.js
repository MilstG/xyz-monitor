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
      { key: "AAPL|breakout", coin: "AAPL", ticker: "AAPL", ev: "breakout", t0: now - 3600000,
        mark0: 200, dir: 1, score0: 61, sd0: 1.8, resolveAt: now + 86400000, psd: "long", bt: 1 },
      { key: "AAPL|bigmove#1", coin: "AAPL", ticker: "AAPL", ev: "bigmove", t0: now - 3600000,
        mark0: 200, dir: 1, score0: 0, sd0: 1.8, resolveAt: now + 86400000, vi: 1 },   // shadow — must never surface
    ],
    closed: [
      // breakdown resolved pre-fix: raw % despite sd0 stamped -> must repair to R (-4.4/2.2 = -2)
      { key: "AAPL|breakdown", coin: "AAPL", ticker: "AAPL", ev: "breakdown", t0: now - 5 * 86400000,
        mark0: 210, dir: -1, score0: 55, sd0: 2.2, status: "resolved", tR: now - 86400000,
        realized: -4.4, realizedS: -4.4, win: false, winS: false, psd: "short" },
      // stopped oiflush pre-fix: realized and the stop-capped leg both repair independently
      { key: "AAPL|oiflush", coin: "AAPL", ticker: "AAPL", ev: "oiflush", t0: now - 9 * 86400000,
        mark0: 190, dir: 1, score0: 48, sd0: 3, status: "resolved", tR: now - 4 * 86400000,
        realized: 6.6, realizedS: -3, stopped: true, win: true, winS: false },
      // breakout resolved under the OLD code: already R, no rn stamp -> must NOT be touched
      { key: "AAPL|breakout", coin: "AAPL", ticker: "AAPL", ev: "breakout", t0: now - 12 * 86400000,
        mark0: 180, dir: 1, score0: 70, sd0: 2, status: "resolved", tR: now - 7 * 86400000,
        realized: 1.5, realizedS: 1.5, win: true, winS: true, psd: "long" },
      // pre-sigma-epoch breakdown (no sd0): untouched, surfaces as legacy %
      { key: "AAPL|breakdown#old", coin: "AAPL", ticker: "AAPL", ev: "breakdown", t0: now - 40 * 86400000,
        mark0: 250, dir: -1, score0: 40, status: "resolved", tR: now - 35 * 86400000,
        realized: 3.1, realizedS: 3.1, win: true, winS: true },
      // different coin — must not leak into AAPL's history
      { key: "NVDA|breakdown", coin: "NVDA", ticker: "NVDA", ev: "breakdown", t0: now - 5 * 86400000,
        mark0: 100, dir: -1, score0: 50, sd0: 2, status: "resolved", tR: now - 86400000,
        realized: -2, realizedS: -2, win: false, winS: false },
    ] };
  const store = { loadAll: () => new Map(), loadRegime: () => [], loadLedger: () => fixture,
    saveLedger: () => {}, insert: () => {}, saveRegime: () => {} };
  const p = createPoller({ dex: "xyz", store, log: () => {}, version: "test", crypto: false });
  p.hydrateLedgerNow();
  p.hydrateLedgerNow();   // idempotency: the rn stamp must make a second pass a no-op
  const h = p.getLedgerFor("AAPL");
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
  assert.equal(p.getLedgerFor("NVDA").closed.length, 1, "history is per-coin");
  assert.equal(p.getLedgerFor("").open.length, 0, "no filter -> empty history");
  const byEv = p.getLedgerFor("", "breakdown");
  assert.equal(byEv.closed.length, 3, "event filter crosses tickers (2 AAPL + 1 NVDA)");
  assert.ok(byEv.closed.every(e => e.ev === "breakdown"), "event filter is exact");
  assert.ok(byEv.closed.some(e => e.tk === "NVDA"), "cross-ticker rows carry their ticker");
  assert.equal(p.getLedgerFor("AAPL", "breakdown").closed.length, 2, "coin+event filters combine");
  assert.equal(p.getLedgerFor("AAPL", "breakdown").open.length, 0, "combined filter excludes other events\' open claims");
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
  assert.equal(out[1].eps, 4.11, "EPS estimate quantized to 2dp");
  assert.equal(out[3].eps, null, "missing estimate stays null");
  assert.deepEqual(parseEarningsCalendar({}, symMap), [], "missing calendar array is empty, not a throw");
});

test("earnings: parser carries actuals and revenue for beat/miss", () => {
  const { parseEarningsCalendar } = require("../src/compute");
  const symMap = new Map([["NVDA", { coin: "xyz:NVDA", ticker: "NVDA" }]]);
  const out = parseEarningsCalendar({ earningsCalendar: [
    { symbol: "NVDA", date: "2026-07-13", hour: "amc", epsEstimate: 5.6234, epsActual: 5.712, revenueEstimate: 41234000000, revenueActual: 42891000000 },
    { symbol: "NVDA", date: "2026-10-14", hour: "amc", epsEstimate: 6.1 },
  ] }, symMap);
  assert.equal(out[0].epsA, 5.71, "actual quantized to 2dp");
  assert.equal(out[0].rev, 41200000000, "revenue estimate at 3 significant figures");
  assert.equal(out[0].revA, 42900000000);
  assert.equal(out[1].epsA, null, "future print has no actual — null, never 0");
  assert.equal(out[1].rev, null);
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
    "loadEarnings", "renderEarnings", "openEarnings", "earnBadge", "earnNext",
    "applyTabOrder", "saveTabOrder", "wireTabDrag"];
  for (const n of need) {
    assert.ok(defs[n] >= 1, `missing client function: ${n}`);
    assert.equal(defs[n], 1, `duplicate client function: ${n}`);
  }
  for (const frag of ["const HELP={", "const SHOW_CLAIM_CURVE", "conflWith", "claim0", "presentSince|sighist-ev", "/api/earnings", "eb0", "earnSplit"]) {
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
  for (const id of ["helpBtn", "helpmodal", "sighist-q", "sighist-ev", "sighist-panel", "dledger", "earnings-body", "view-earnings", "logoutBtn"]) {
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
      { key: "NATGAS|squeeze", coin: "NATGAS", ticker: "NATGAS", ev: "squeeze", t0: now - 3600000,
        mark0: 2.959, dir: 1, score0: 21, resolveAt: now + 86400000, psd: "long", stp: 3.4 },
    ],
    closed: [
      // the MINIMAX shape: long, stop ABOVE entry, "stopped" into a fabricated +10.68% win
      { key: "MINIMAX|squeeze", coin: "MINIMAX", ticker: "MINIMAX", ev: "squeeze", t0: now - 5 * 86400000,
        mark0: 45.694, dir: 1, psd: "long", stp: 50.57, status: "resolved", tR: now - 2 * 86400000,
        realized: -20.79, realizedS: 10.68, stopped: true, win: false, winS: true, score0: 42 },
      // a VALID stopped short: stop above entry, genuinely touched — must be untouched by repair
      { key: "MSTR|breakdown2", coin: "MSTR", ticker: "MSTR", ev: "breakdown", t0: now - 6 * 86400000,
        mark0: 97.9, dir: -1, psd: "short", stp: 102.9, sd0: 2, rn: 1, status: "resolved", tR: now - 86400000,
        realized: 1.2, realizedS: -2.55, stopped: true, win: true, winS: false },
    ] };
  const store = { loadAll: () => new Map(), loadRegime: () => [], loadLedger: () => fixture,
    saveLedger: () => {}, insert: () => {}, saveRegime: () => {} };
  const p = createPoller({ dex: "xyz", store, log: () => {}, version: "test", crypto: false });
  p.hydrateLedgerNow();
  p.hydrateLedgerNow();   // idempotent
  const mm = p.getLedgerFor("MINIMAX").closed[0];
  assert.equal(mm.realizedS, -20.79, "fabricated stop-aware outcome reverted to at-horizon truth");
  assert.equal(mm.stopped, false, "false stop cleared");
  const ms = p.getLedgerFor("MSTR").closed[0];
  assert.equal(ms.realizedS, -2.55, "valid stopped short untouched");
  assert.equal(ms.stopped, true, "valid stop kept");
  const ng = p.getLedgerFor("NATGAS").open[0];
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
      { key: "MSTR|gap", coin: "MSTR", ticker: "MSTR", ev: "gap", t0: now - 3600000, mark0: 100,
        dir: 1, psd: "short", score0: 30, resolveAt: now + 86400000, claim: { n: 12, med: -0.8 } },
    ],
    closed: [
      // the observed shape: up-gap (dir +1), FADE play (psd short), stopped, event-signed
      // realizedS +0.73 displayed as a green stop-aware "win" — in play units this fade LOST
      { key: "MSTR|gap#c", coin: "MSTR", ticker: "MSTR", ev: "gap", t0: now - 5 * 86400000, mark0: 100,
        dir: 1, psd: "short", stp: 101.2, status: "resolved", tR: now - 4 * 86400000,
        realized: 0.73, realizedS: 0.73, stopped: true, win: true, winS: true, claim: { n: 12, med: -0.8 } },
      // aligned continuation gap (psd long, dir +1): must be untouched
      { key: "COIN|gap", coin: "COIN", ticker: "COIN", ev: "gap", t0: now - 6 * 86400000, mark0: 50,
        dir: 1, psd: "long", status: "resolved", tR: now - 5 * 86400000,
        realized: 1.4, realizedS: 1.4, win: true, winS: true, claim: { n: 15, med: 0.6 } },
    ] };
  const store = { loadAll: () => new Map(), loadRegime: () => [], loadLedger: () => fixture,
    saveLedger: () => {}, insert: () => {}, saveRegime: () => {} };
  const p = createPoller({ dex: "xyz", store, log: () => {}, version: "test", crypto: false });
  p.hydrateLedgerNow();
  p.hydrateLedgerNow();   // idempotent — pn guards the second pass
  const mm = p.getLedgerFor("MSTR");
  const cl = mm.closed[0];
  assert.equal(cl.realized, -0.73, "failed fade now a LOSS in play units");
  assert.equal(cl.win, false, "win flag follows the play");
  assert.equal(cl.realizedS, -0.73, "stop-aware leg flipped too");
  assert.equal(cl.claimMed, 0.8, "claim median flipped into play units");
  assert.equal(mm.open[0].claimMed, 0.8, "open fader claim median flipped");
  const co = p.getLedgerFor("COIN").closed[0];
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
