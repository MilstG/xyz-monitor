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
    "loadLiqs", "renderLiqs", "openLiqs", "flowAddr", "liqDistLive", "ladderCell",
    "applyTabOrder", "saveTabOrder", "wireTabDrag"];
  for (const n of need) {
    assert.ok(defs[n] >= 1, `missing client function: ${n}`);
    assert.equal(defs[n], 1, `duplicate client function: ${n}`);
  }
  for (const frag of ["const HELP={", "const SHOW_CLAIM_CURVE", "conflWith", "claim0", "presentSince|sighist-ev", "/api/earnings", "eb0", "earnSplit", "d.recent||", "REPORTED \\u00b7", "/api/liqs", "CASCADE LADDER"]) {
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
  for (const id of ["helpBtn", "helpmodal", "sighist-q", "sighist-ev", "sighist-panel", "dledger", "earnings-body", "view-earnings", "view-liqs", "liqs-body", "logoutBtn"]) {
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
    "/api/earnings", "/api/liqs", "/api/series", "/api/ledger", "/api/candles", "/api/health"];
  for (const r of routes) {
    const n = srv.split(`fastify.get("${r}"`).length - 1;
    assert.ok(n >= 1, `server route missing: ${r}`);
    assert.equal(n, 1, `server route registered ${n} times: ${r}`);
  }
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
  for (const frag of ["/api/trend", "trow-hl", "tretest", "trend:`", "tage", "td21", "fresh-first"])
    assert.ok(s.includes(frag), `missing client feature marker: ${frag}`);
  assert.ok(fs.readFileSync(path.join(__dirname, "..", "src", "compute.js"), "utf8").includes("function stackedRun("),
    "missing engine function: stackedRun");
  const html = fs.readFileSync(path.join(__dirname, "..", "public", "index.html"), "utf8");
  assert.ok(html.includes('data-view="trend"'), "trend tab button missing from nav");
  for (const id of ["view-trend", "trendside", "trend-body", "trend-asof"])
    assert.ok(html.includes(`id="${id}"`), `missing markup id: ${id}`);
  const srv = fs.readFileSync(path.join(__dirname, "..", "server.js"), "utf8");
  assert.ok(srv.includes("/api/trend"), "server route missing: /api/trend");
  const css = fs.readFileSync(path.join(__dirname, "..", "public", "styles.css"), "utf8");
  for (const cls of [".tdot", ".tretest", ".trend-t", ".trow-hl"])
    assert.ok(css.includes(cls), `missing style: ${cls}`);
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

test("flows: TWAP-taker detection for watchlist credit — zero-hash gate, taker attribution", () => {
  const { isTwapFill, twapTaker } = require("../src/compute");
  const Z = "0x" + "0".repeat(64);
  const REAL = "0x9a1c" + "b".repeat(60);
  assert.equal(isTwapFill(Z), true, "all-zero hash is a TWAP slice");
  assert.equal(isTwapFill(REAL), false, "a real L1 hash is NOT a TWAP slice");
  assert.equal(isTwapFill("0x0"), false, "too-short zero string must not pass (malformed input)");
  assert.equal(isTwapFill(null), false);
  // taker attribution: users = [buyer, seller]; side B => taker bought => users[0]
  assert.equal(twapTaker({ side: "B", users: ["0xAAA1", "0xBBB2"] }), "0xaaa1", "buy slice attributes to the buyer");
  assert.equal(twapTaker({ side: "A", users: ["0xAAA1", "0xBBB2"] }), "0xbbb2", "sell slice attributes to the seller");
  assert.equal(twapTaker({ side: "B", users: ["nothex", "0xBBB2"] }), null, "malformed address -> null, never a fabricated key");
});

test("flows: cascade ladder — cumulative bands, side split, through-the-level, deterministic order", () => {
  const { ladderBands } = require("../src/compute");
  const bands = [1, 2, 5, 10];
  const rows = ladderBands([
    { coin: "BTC", side: "long", dist: 0.8, ntl: 100 },   // in every band
    { coin: "BTC", side: "long", dist: 4.0, ntl: 300 },   // <=5, <=10
    { coin: "BTC", side: "short", dist: 1.5, ntl: 50 },   // <=2, <=5, <=10
    { coin: "BTC", side: "long", dist: -0.2, ntl: 40 },   // THROUGH the level -> every band (liquidating now)
    { coin: "BTC", side: "long", dist: 11, ntl: 9999 },   // beyond the last band -> excluded
    { coin: "xyz:AAPL", side: "short", dist: 9.9, ntl: 700 },
    { coin: "xyz:AAPL", side: "long", dist: null, ntl: 700 },   // no distance -> excluded, never guessed
    { coin: "xyz:AAPL", side: "watch", dist: 1, ntl: 700 },     // malformed side -> excluded
  ], bands);
  assert.equal(rows.length, 2);
  const btc = rows.find((r) => r.coin === "BTC"), aapl = rows.find((r) => r.coin === "xyz:AAPL");
  assert.deepEqual(btc.long, [140, 140, 440, 440], "long bands are CUMULATIVE; through-the-level counts everywhere");
  assert.deepEqual(btc.short, [0, 50, 50, 50]);
  assert.equal(btc.nLong, 3); assert.equal(btc.nShort, 1);
  assert.deepEqual(aapl.short, [0, 0, 0, 700]);
  assert.equal(rows[0].coin, "xyz:AAPL", "sorted by total notional in the widest band (700 > 490)");
  assert.deepEqual(ladderBands([], bands), [], "empty in, empty out");
  assert.deepEqual(ladderBands(null, bands), [], "malformed in, empty out");
});

test("flows: liquidation distance — sign conventions, through-the-level, malformed inputs", () => {
  const { liqDistancePct } = require("../src/compute");
  // long: liq below mark -> positive distance; mark AT/THROUGH liq -> <= 0
  assert.ok(Math.abs(liqDistancePct(10, 90, 100) - 10) < 1e-9, "long 10% above its liq price");
  assert.ok(liqDistancePct(10, 100, 100) === 0, "long at the level");
  assert.ok(liqDistancePct(10, 105, 100) < 0, "long through the level");
  // short: liq above mark -> positive distance; mark AT/THROUGH -> <= 0
  assert.ok(Math.abs(liqDistancePct(-5, 110, 100) - 10) < 1e-9, "short 10% below its liq price");
  assert.ok(liqDistancePct(-5, 95, 100) < 0, "short through the level");
  // malformed -> null, never fabricated
  assert.equal(liqDistancePct(0, 90, 100), null, "no position, no distance");
  assert.equal(liqDistancePct(10, null, 100), null, "no liq price (venue omits it sometimes)");
  assert.equal(liqDistancePct(10, 90, null), null, "no mark");
  assert.equal(liqDistancePct(10, -1, 100), null, "nonsense liq price");
});

test("flows: whale watchlist — exponential decay, credit accrual, deterministic prune", () => {
  const { foldWhale, decayScore, pruneWhales } = require("../src/compute");
  const HL = 3 * 86400000, t0 = 1000000;
  const m = new Map();
  foldWhale(m, "0xaaa", 100000, t0, HL);
  // one half-life later the score has halved
  assert.ok(Math.abs(decayScore(m.get("0xaaa"), t0 + HL, HL) - 50000) < 1, "score halves after one half-life");
  // a credit at +HL decays the old score first, then adds
  foldWhale(m, "0xaaa", 10000, t0 + HL, HL);
  assert.ok(Math.abs(m.get("0xaaa").ntl - 60000) < 1, "decay-then-add accounting");
  // malformed inputs never enter the map
  assert.equal(foldWhale(m, "nothex", 5000, t0, HL), null);
  assert.equal(foldWhale(m, "0xbbb", -5, t0, HL), null);
  assert.equal(m.size, 1);
  // prune keeps the top N by decayed score, deterministically
  for (let i = 0; i < 10; i++) foldWhale(m, "0xw" + i, (i + 1) * 1000, t0, HL);
  const dropped = pruneWhales(m, 4, t0, HL);
  assert.equal(dropped, 7);
  assert.equal(m.size, 4);
  assert.ok(m.has("0xaaa") && m.has("0xw9") && m.has("0xw8") && m.has("0xw7"), "top scores survive");
});

test("flows: getLiqs payload contract on a cold poller — the route can never 500 on boot", () => {
  // The route layer binds serveCached to this getter at listen time, before start() has run and
  // before the tape has produced anything. A throw or a malformed shape here is the exact
  // silent-drawer failure class the route manifest exists to prevent — pin the empty contract.
  const { createPoller } = require("../src/poller");
  const store = { loadAll: () => new Map(), loadRegime: () => [], loadLedger: () => null,
    saveLedger: () => {}, insert: () => {}, saveRegime: () => {}, loadFlows: () => null, saveFlows: () => {} };
  const p = createPoller({ dex: "xyz", store, log: () => {}, version: "test", crypto: false });
  const lq = p.getLiqs();
  assert.ok(lq && Number.isFinite(lq.ts), "liqs payload exists cold");
  assert.deepEqual(lq.bands, [1, 2, 5, 10], "ladder bands shipped so the client never hardcodes them");
  assert.ok(Array.isArray(lq.danger) && lq.danger.length === 0, "no fabricated danger rows");
  assert.ok(Array.isArray(lq.events) && lq.events.length === 0);
  for (const un of ["crypto", "stocks"]) {
    assert.ok(lq.ladder && lq.ladder[un] && Array.isArray(lq.ladder[un].coins) && lq.ladder[un].coins.length === 0, un + " ladder present and empty");
    assert.equal(lq.ladder[un].total.long.length, 4, un + " totals aligned to bands even when empty");
    assert.equal(lq.ladder[un].total.long.reduce((a, b) => a + b, 0), 0);
  }
  assert.ok(lq.coverage && lq.coverage.tracked === 0 && typeof lq.coverage.note === "string", "coverage is stated, even when empty");
  // ETag discipline: identical content on a rebuild must NOT bump dataTs (would defeat every 304)
  const v1 = lq.dataTs;
  assert.equal(p.getLiqs().dataTs, v1, "unchanged content keeps its data version (memo window)");
});
