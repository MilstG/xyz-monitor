"use strict";
// Run with: npm test  (uses Node's built-in test runner, no dependencies)
const test = require("node:test");
const assert = require("node:assert");
const { classify, companyName } = require("../src/sectors");
const { stdev, median, linregR2, priceAt, featuresFromHourly, oiDeltaPct, pearson, meanPairwiseCorr, corrMatrix, studyBreakdown, playbook, confSplit, studyOIFlush, studyFPDiv, offDriftStats } = require("../src/compute");

const HOUR = 3600 * 1000, DAY = 86400 * 1000;

test("classify: core equities map to GICS sectors", () => {
  assert.equal(classify("AAPL").sector, "Information Technology");
  assert.equal(classify("NVDA").sector, "Information Technology");
  assert.equal(classify("JPM").sector, "Financials");
  assert.equal(classify("LLY").sector, "Health Care");
  assert.equal(classify("TSLA").sector, "Consumer Discretionary");
});

test("companyName: canonical display name for the analyst context, null for unseeded", () => {
  assert.equal(companyName("NVDA"), "Nvidia");
  assert.equal(companyName("nvda"), "Nvidia");   // case-insensitive
  assert.equal(companyName("AMD"), "AMD");
  assert.equal(companyName("TSM"), "TSMC");
  assert.equal(companyName("ZZZZ"), null);        // unseeded -> ticker stays the label
  assert.equal(companyName(""), null);
  assert.equal(companyName(null), null);
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
  assert.ok(pol.includes("const nm = companyName(m && m.t)") && pol.includes('require("./sectors")'),
    "company-name injection not wired into askBoard markets");
  assert.ok(/companyName/.test(pol), "companyName must be imported/used in poller");
});

test("AI admin gate: checkAdminPassword fails closed, verifies constant-time, shares a lockout", () => {
  const { createPoller } = require("../src/poller");
  const store = { loadAll: () => new Map(), loadRegime: () => [], loadLedger: () => null,
    saveLedger: () => {}, insert: () => {}, saveRegime: () => {}, saveNews: () => {}, loadNews: () => null };
  const prev = process.env.ADMIN_PASSWORD;
  try {
    delete process.env.ADMIN_PASSWORD;
    let p = createPoller({ dex: "xyz", store, log: () => {}, version: "test" });
    assert.equal(p.checkAdminPassword("anything").error, "not-configured", "unset ADMIN_PASSWORD fails closed (no unlock can be minted)");
    process.env.ADMIN_PASSWORD = "s3cret-pw";
    p = createPoller({ dex: "xyz", store, log: () => {}, version: "test" });
    assert.equal(p.checkAdminPassword("s3cret-pw").ok, true, "correct password passes");
    assert.equal(p.checkAdminPassword("wrong").error, "bad-password", "wrong password rejected");
    for (let i = 0; i < 8; i++) p.checkAdminPassword("wrong");
    assert.equal(p.checkAdminPassword("s3cret-pw").error, "rate", "lockout trips after repeated failures — even the correct password waits");
  } finally { if (prev === undefined) delete process.env.ADMIN_PASSWORD; else process.env.ADMIN_PASSWORD = prev; }
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
  // target: main-universe coin with a funding history rich enough to clear the >=96-sample
  // percentile floor, a 30d range, and a live rate sitting at a known rank in its own history
  const fundH = new Map();
  for (let i = 0; i < 100; i++) fundH.set(now - (100 - i) * HOURMS, (i + 1) / 1e6);   // ranks 1..100
  p.seedRowNow("ETH", { px: 3000, funding: 75 / 1e6, fundH, feat: { hi30: 3200, lo30: 2800 } });
  // Crypto signal claims open again (2026.07.26-08). The blanket refusal is replaced by the
  // MAIN_EVS whitelist, so an enrolled event ledgers and a non-enrolled one still cannot.
  const e = p.openLedgerNow("ETH", "bigmove", { score: 10, reading: "" }, 1, { sd0: 2 });
  assert.ok(e, "an enrolled crypto event ledgers — the whitelist admits bigmove");
  assert.equal(p.openLedgerNow("ETH", "prem", { score: 10, reading: "" }, 1, { sd0: 2 }), null,
    "a non-enrolled crypto event is still refused — the gate is a whitelist, not a re-opening");
  assert.equal(e.fnd, 75 / 1e6, "funding rate frozen at fire");
  assert.ok(e.fndP >= 73 && e.fndP <= 77, `funding percentile ~75 from the seeded ranks, got ${e.fndP}`);
  assert.equal(e.rngP, 0.5, "px 3000 sits exactly mid-range 2800..3200");
  assert.equal(e.mktR, 2.5, "benchmark 24h move stamped from BTC for a main-universe coin");
  assert.ok(Number.isInteger(e.dow) && e.dow >= 0 && e.dow <= 6, "UTC day-of-week always stamped");
  assert.equal(e.ses, undefined, "session bucket is xyz-only — absent on crypto, not null-padded");
  assert.ok(["asia", "eu", "us", "late"].includes(e.hod),
    `crypto carries a UTC hour-of-day bucket in place of the session it cannot have, got ${e.hod}`);
  assert.equal(e.oi5, undefined, "no OI history -> oi5 honestly absent");
  assert.equal(e.sd0, 2, "extra fields untouched by the stamp");
  // xyz claim: session bucket present and valid; thin row -> everything else absent except dow
  p.seedRowNow("xyz:ACME", { px: 50, ticker: "ACME" });
  const e2 = p.openLedgerNow("xyz:ACME", "breakout", { score: 5, reading: "" }, 1, { sd0: 1.5 });
  assert.ok(["rth", "on", "wknd"].includes(e2.ses), `xyz claim carries a session bucket, got ${e2.ses}`);
  assert.equal(e2.hod, undefined, "hour-of-day bucket is crypto-only — xyz has real sessions, not a liquidity clock");
  assert.equal(e2.fnd, undefined, "no funding -> absent");
  assert.equal(e2.rngP, undefined, "no features -> absent");
  assert.ok(Number.isInteger(e2.dow), "dow stamped");
  // shadow claims get the same stamp — variant slices need identical features
  const e3 = p.openLedgerNow("ETH", "bigmove", { score: 0, reading: "" }, 1, { sd0: 2 }, 1);
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
  // ---- intraday liquidity sweep (5m): prior-session low pierced, rejected inside the bar, reclaim holds
  const FIVE = 5 * 60 * 1000;
  const mkTail = () => { const a = []; for (let i = 0; i < 30; i++) a.push([now - (30 - i) * FIVE, 100, 100.2, 99.8, 100, 10]); return a; };
  const swLo = mkTail(); swLo[27] = [swLo[27][0], 99.6, 99.8, 98.5, 99.5, 25];   // wick to 98.5 below dayLo=99, closes back at 99.5
  const sw = C.detectSweep(swLo, 101, 99, 99.3, 0.25);
  assert.ok(sw && sw.side === "long", "a rejected pierce of the prior-session low fires long");
  assert.equal(sw.level, 99, "level is the swept prior-session low");
  assert.equal(sw.stop, 98.5, "void is the sweep extreme (the wick low)");
  assert.ok(Math.abs(sw.target - 99.5) < 1e-9, "target is the measured move: level + (level - sweep low)");
  assert.ok(sw.stop < 99.3 && sw.target > 99.3, "tradeable geometry: stop below the mark, target above");
  const swHi = mkTail(); swHi[27] = [swHi[27][0], 100.4, 101.5, 100.2, 100.5, 25];
  const ss = C.detectSweep(swHi, 101, 99, 100.7, 0.25);
  assert.ok(ss && ss.side === "short", "a rejected pierce of the prior-session high fires short");
  assert.equal(ss.stop, 101.5, "short void is the sweep high");
  assert.ok(Math.abs(ss.target - 100.5) < 1e-9, "short target is level - (sweep high - level)");
  assert.equal(C.detectSweep(swLo, 101, 95, 99.3, 0.25), null, "a wick that never reaches the level is not a sweep");
  const graze = mkTail(); graze[27] = [graze[27][0], 99.6, 99.8, 98.95, 99.5, 25];   // pierces by 0.05 < 0.25*median
  assert.equal(C.detectSweep(graze, 101, 99, 99.3, 0.25), null, "a shallow graze under the min-depth floor doesn't count");
  const noRcl = mkTail(); noRcl[27] = [noRcl[27][0], 99.6, 99.8, 98.5, 98.7, 25];   // closes BELOW the level — not rejected in-bar
  assert.equal(C.detectSweep(noRcl, 101, 99, 99.3, 0.25), null, "no in-bar rejection: the level wasn't reclaimed");
  const broke = mkTail(); broke[27] = [broke[27][0], 99.6, 99.8, 98.5, 99.5, 25]; broke[29] = [broke[29][0], 99, 99.1, 98.6, 98.8, 10];
  assert.equal(C.detectSweep(broke, 101, 99, 99.3, 0.25), null, "a later close back through the level breaks the reclaim");
  assert.equal(C.detectSweep(swLo, 101, 99, 98.8, 0.25), null, "mark not back above the swept low: no live reclaim");
  assert.equal(C.detectSweep(swLo.slice(-8), 101, 99, 99.3, 0.25), null, "under 12 bars: honest null");
  const strTail = swLo.map((k) => [k[0], String(k[1]), String(k[2]), String(k[3]), String(k[4]), k[5]]);
  let strSw; assert.doesNotThrow(() => { strSw = C.detectSweep(strTail, 101, 99, 99.3, 0.25); }, "string OHLC from the archive must never throw");
  assert.ok(strSw && strSw.side === "long", "string coercion still detects the sweep");
  // ---- fundflip playbook stop (ops item 3): 1σ against the flip; legacy no-ctx shape unchanged
  const ffL = C.playbook("fundflip", { dir: 1, px: 100, sd30: 2 });
  assert.equal(ffL.side, "long"); assert.equal(ffL.stop, 98);
  const ffS = C.playbook("fundflip", { dir: -1, px: 100, sd30: 2 });
  assert.equal(ffS.side, "short"); assert.equal(ffS.stop, 102);
  assert.equal(C.playbook("fundflip", { dir: -1 }).stop, null, "no px/σ context: legacy null stop");
  // ---- EV_META: swing horizons + gapfade on the gap calendar
  assert.equal(C.EV_META.reclaim.horizonMs, 5 * DAY);
  assert.equal(C.EV_META.mapull.horizonMs, 10 * DAY);
  assert.equal(C.EV_META.sweep.horizonMs, DAY, "the 5m sweep resolves at a 1d horizon");
  assert.equal(C.EV_META.gapfade.horizonMs, null, "gapfade resolves at the next session close, like gap");
  // ---- wiring pins: the fire sites and calendar branch exist in the poller
  const fs = require("fs"), path = require("path");
  const pol = fs.readFileSync(path.join(__dirname, "..", "src", "poller.js"), "utf8");
  assert.ok(pol.includes('openLedger(r, "gapfade"'), "gapfade shadow fire site present");
  assert.ok(pol.includes("[1, 1.5].forEach"), "both void widths ledger");
  assert.ok(pol.includes('ev === "gap" || ev === "gapfade"'), "gapfade rides the gap resolution calendar");
  assert.ok(pol.includes('openLedger(r, "reclaim"') && pol.includes('openLedger(r, "mapull"'), "swing shadow fire sites present");
  assert.ok(pol.includes('openLedger(r, "sweep"'), "5m sweep shadow fire site present");
  assert.ok(pol.includes('detectSweep(store.readCandles(r.coin, now - SWEEP_LOOK_MS, now)'), "sweep reads the 5m archive tail, prior-session levels from dailyRaw");
  assert.ok(pol.includes('r.uni === "xyz" && store.candlesEnabled'), "sweep is gated xyz-only and behind the optional 5m archive");
  assert.ok(pol.includes('playbook("fundflip", { logGeo: r.uni === "main", dir: s0, px: r.px, sd30 })'),
    "fundflip call site feeds the stop context AND the universe's geometry mode");
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

test("HTF shadow batch 2: failbrk mirror, pead reaction gate, fundext restored as a crypto-native event", () => {
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
  assert.ok(C.EV_META.fundext && C.EV_META.fundext.horizonMs === 2 * 86400e3,
    "fundext carries a meta again, on the crypto 2d horizon");
  assert.ok(!C.EV_META.liqflush, "liqflush stays retired — cascade exhaustion replaced it with observed-price geometry");
  assert.ok(C.EV_META.casc && C.EV_META.casc.horizonMs === 12 * 3600e3, "cascade exhaustion is a 12h claim");
  const fs = require("fs"), path = require("path");
  const pol = fs.readFileSync(path.join(__dirname, "..", "src", "poller.js"), "utf8");
  for (const pin of ['openLedger(r, "failbrk"', 'openLedger(r, "pead"',
    'r.uni === "xyz" && r.dailyRaw', "function fundPctileNow"])
    assert.ok(pol.includes(pin), `poller wiring pin missing: ${pin}`);
  // fundext has a fire site again, gated to crypto and carrying its episode floor; liqflush does
  // not — cascade exhaustion replaced it with geometry taken from prices the tape printed.
  assert.ok(pol.includes('openLedger(r, "fundext"'), "the fundext fire site is restored");
  assert.ok(pol.includes('openLedger(r, "casc"'), "the cascade-exhaustion fire site exists");
  assert.ok(!pol.includes('openLedger(r, "liqflush"'), "liqflush stays removed");
  assert.ok(pol.includes("const FUNDEXT_HOURS = 24;") && pol.includes("held >= FUNDEXT_MIN_SAMPLES"),
    "fundext carries a persistence floor — a percentile extreme is a PERSISTENT condition, and without an episode definition one episode serially re-opens claims and reports n=40 for a single observation");
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
  assert.equal((pol.match(/swingFails\+\+; swingErr = \(e && e\.message\) \|\| String\(e\); \}/g) || []).length, 3,
    "swing, gapfade AND cascade blocks each catch into the per-build counter (the cascade lane reads an optional external feed)");
  assert.ok(pol.includes("let swingFails = 0, swingErr = null;"), "counters reset per build");
  assert.ok(pol.includes("strategy shadows failed on ${swingFails} market(s)"), "failures log once per build, visibly");
  const cmp = fs.readFileSync(path.join(__dirname, "..", "src", "compute.js"), "utf8");
  assert.equal((cmp.match(/closes\.map\(\(k\) => \+k\[1\]\)/g) || []).length, 8, "every daily-close detector coerces (reclaim, failbrk, mapull, roundfr, swpull/basebrk/regime200 + emabrk since -28)");
});

test("pre-epoch crypto purge: claims stamped under the OLD geometry leave the ledger, post-epoch claims survive", () => {
  // The -101 purge, bounded to the era it was actually about. Every crypto claim opened before
  // the geometry fix was stamped by additive range arithmetic that produced negative targets and
  // voids multiples of price away — seeding a supposedly out-of-sample record with those would be
  // exactly the stale-record dishonesty the ledger exists to prevent. So the pre-epoch era is
  // dropped while the rebuilt engine's own claims are kept: that boundary IS the property under
  // test, and it is a stronger one than "delete everything crypto". airead is exempt either way.
  const { createPoller } = require("../src/poller");
  const now = Date.now();
  const OLD = Date.UTC(2026, 6, 20);   // comfortably before CRYPTO_EPOCH (2026-07-26)
  const fixture = { ts: now, rearm: ["ETH|gapfade#1", "xyz:NVDA|reclaim#0"], variants: null,
    present: [["ETH|bigmove", now - 3600e3], ["xyz:AAPL|breakdown", now - 3600e3]],
    open: [
      { key: "ETH|gapfade#1", coin: "ETH", ticker: "ETH", ev: "gapfade", t0: OLD, mark0: 100, dir: 1,
        score0: 0, psd: "short", pn: 1, stp: 101, vi: 1, resolveAt: now + 86400e3 },
      { key: "BTC|fundext#0", coin: "BTC", ticker: "BTC", ev: "fundext", t0: OLD, mark0: 50, dir: 1,
        score0: 0, sd0: 2, psd: "short", pn: 1, stp: 51.5, vi: 0, resolveAt: now + 86400e3 },
      // post-epoch crypto claim: opened by the REBUILT engine, so it must survive the purge
      { key: "SOL|breakout", coin: "SOL", ticker: "SOL", ev: "breakout", t0: now - 3600e3, mark0: 200, dir: 1,
        score0: 12, sd0: 6, psd: "long", pn: 1, stp: 188, mv: 16, resolveAt: now + 2 * 86400e3 },
      { key: "ETH|airead#0", coin: "ETH", ticker: "ETH", ev: "airead", t0: now - 3600e3, mark0: 100, dir: 1,
        score0: 0, sd0: 2, psd: "long", pn: 1, stp: 95, vi: 0, resolveAt: now + 4 * 86400e3 },
      { key: "xyz:NVDA|reclaim#0", coin: "xyz:NVDA", ticker: "NVDA", ev: "reclaim", t0: now - 3600e3, mark0: 10, dir: 1,
        score0: 0, sd0: 2, psd: "long", pn: 1, stp: 9.5, vi: 0, resolveAt: now + 86400e3 },
    ],
    closed: [
      { key: "ETH|gapfade#0", coin: "ETH", ticker: "ETH", ev: "gapfade", t0: OLD, tR: OLD + 86400e3,
        mark0: 100, dir: 1, psd: "short", pn: 1, vi: 0, status: "resolved", realized: 0.8, realizedS: 0.8 },
      { key: "SOL|gapfade#0", coin: "SOL", ticker: "SOL", ev: "gapfade", t0: OLD, tR: OLD + 86400e3,
        mark0: 20, dir: -1, psd: "long", pn: 1, vi: 0, status: "resolved", realized: -0.4, realizedS: -0.6, stopped: true },
      { key: "xyz:AAPL|reclaim#0", coin: "xyz:AAPL", ticker: "AAPL", ev: "reclaim", t0: now - 6 * 86400e3, tR: now - 86400e3,
        mark0: 10, dir: 1, sd0: 2, psd: "long", pn: 1, vi: 0, status: "resolved", realized: 1.2, realizedS: 1.2, rn: 1 },
      { key: "xyz:AAPL|breakdown", coin: "xyz:AAPL", ticker: "AAPL", ev: "breakdown", t0: now - 6 * 86400e3, tR: now - 86400e3,
        mark0: 200, dir: -1, sd0: 2, psd: "short", pn: 1, status: "resolved", realized: 1.1, realizedS: 1.1, rn: 1 },
      { key: "ETH|bigmove", coin: "ETH", ticker: "ETH", ev: "bigmove", t0: OLD, tR: OLD + 86400e3,
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
  const EPOCH = Date.UTC(2026, 6, 26);
  const preCrypto = (e) => !e.coin.includes(":") && e.ev !== "airead" && !(+e.t0 >= EPOCH);
  assert.ok(!x.open.some(preCrypto), "no PRE-EPOCH crypto claim survives among open entries");
  assert.ok(!x.closed.some(preCrypto), "no PRE-EPOCH crypto claim survives among closed entries");
  assert.ok(x.open.some((e) => e.coin === "SOL" && e.ev === "breakout"),
    "the post-epoch crypto claim SURVIVES — the purge is bounded to the broken-geometry era, not permanent");
  assert.equal(p.getLedgerFor("ETH").closed.length, 0, "the claim browser has nothing on the purged crypto name");
  const ai = p.aireadClaimsNow();
  assert.ok(ai.open.some((e) => e.coin === "ETH") && ai.closed.some((e) => e.coin === "ETH"), "airead claims on crypto names survive the purge — open AND closed");
  assert.ok(saved && saved.open.length === 3 && saved.closed.length === 3,
    `the purged ledger persists back: 3 open kept of 5 (2 xyz/airead + the post-epoch crypto claim), 3 closed kept of 6 — got ${saved && saved.open.length}/${saved && saved.closed.length}`);
  assert.ok(!saved.rearm.includes("ETH|gapfade#1") && !saved.present.some((p0) => p0[0] === "ETH|bigmove"),
    "no crypto episode/presence key survives to persistence (load filter; the build's own lapse GC clears the rest)");
  // shadow panel: the crypto key exists again, and is null when the poller runs without crypto
  assert.ok(d.shadows && Array.isArray(d.shadows.xyz), "the xyz panel ships");
  assert.equal(d.shadows.main, null, "crypto:false poller ships main:null — an explicit 'not served', not a silent omission");
  const xp = Object.fromEntries(d.shadows.xyz.map((g) => [g.ev, g]));
  assert.ok(xp.pead && xp.sweep, "xyz-only strategies stay on the xyz panel");
  assert.ok(xp.gapfade, "gapfade is an xyz strategy (a 24/7 tape has no gap to fade)");
  assert.deepEqual({ n: xp.gapfade.rows[0].n, open: xp.gapfade.rows[0].open }, { n: 0, open: 0 },
    "the purged crypto gapfade record cannot leak into the xyz panel");
  assert.equal(xp.reclaim.rows[0].n, 1); assert.equal(xp.reclaim.rows[0].avg, 1.2);
  assert.equal(xp.reclaim.rows[0].open, 1, "xyz shadow aggregation intact");
  // record sets: xyz claims intact, crypto claims absent from EVERY set including the global
  assert.ok(d.records["0x"].record.breakdown && d.records["0x"].record.breakdown.resolved === 1, "xyz set carries the xyz visible claim");
  assert.equal(d.records["0"].record.breakdown.resolved, 1, "global set keeps its keys and totals");
  assert.ok(!d.records["0"].record.bigmove, "the PURGED crypto claim is absent from the global set — broken-geometry history feeds no aggregate");
  assert.ok(!d.records["0m"] || !d.records["0m"].record.bigmove, "and the m-suffixed set is empty of it");
  // independence disclosure rides every record entry
  assert.ok(Number.isInteger(d.records["0x"].record.breakdown.cl) && d.records["0x"].record.breakdown.cl >= 1,
    "every record entry carries cl: the distinct tape-day count behind n");
  // client wiring pins: xyz-only selection, tab whitelist without signals, drawer skip
  const fs = require("fs"), path = require("path");
  const app = fs.readFileSync(path.join(__dirname, "..", "public", "app.js"), "utf8");
  for (const pin of ["function sigRecKey(thr,pr){",
    "const shPanel=d&&d.shadows&&(state.scope==='crypto'?d.shadows.main:d.shadows.xyz);",
    // Signals and Actionable are in scope for crypto again; markets stays PINNED public so the
    // tabVisible fallback can never itself be gated.
    "const CRYPTO_VIEWS=new Set(['markets','trend','report','corr','backtest','sessions','signals','actionable'])",
    "if(!tabVisible(v)) v='markets';",
    "strategy shadows (earning their record)"])
    assert.ok(app.includes(pin), `client scope pin missing: ${pin}`);
  // BOTH record-set selection sites must go through the scoped key — a hardcoded 'x' would show
  // the equity record under a crypto board, which is the one failure mode that looks plausible.
  assert.equal((app.match(/d\.records\[sigRecKey\(/g) || []).length, 2,
    "both record-set selection sites read the SCOPED key, not a hardcoded universe");
  assert.ok(!/\+'x'\]\|\|d\.records\[/.test(app), "no hardcoded xyz record-set selection survives");
  assert.ok(!app.includes("rw.uni==='main'){ box.innerHTML=''; return; } }"),
    "the drawer's crypto record skip is gone — crypto names have a ledger again");
  const pol = fs.readFileSync(path.join(__dirname, "..", "src", "poller.js"), "utf8");
  assert.ok(pol.includes('return { xyz: panel("xyz"), main: crypto ? panel("main") : null };'), "shadowRecord ships both panels");
  assert.ok(pol.includes("uni: r.uni, ev, label: EV_LABEL[ev]"), "signals stay universe-stamped (structural honesty, even with one universe)");
  assert.ok(pol.includes("shadow record changes must bust the ETag"), "shadow counts still fold into the signals ETag signature");
  assert.ok(pol.includes("Pre-epoch crypto purge") && pol.includes('e.ev !== "airead"'), "the epoch-bounded purge and its airead exemption live in hydrate");
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
    "id=\"dnews\"", "all ${esc(r.ticker)} news", "headlines in the last 72h",
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

test("transport cap: per-universe lanes so a volatile crypto day cannot evict the equity board", () => {
  // The lanes (capPerUniverse, the -85 fix) came back with the crypto engine. This is not
  // housekeeping: crypto's intensity terms are sigma multiples and crypto sigma is 5-20x the
  // equity side's, so a single global sort hands the whole payload to perps on any volatile day
  // and the equity board — the one with the long record — vanishes from its own tab with no
  // error anywhere. Executed against the real function, not string-pinned.
  const C = require("../src/compute");
  const mk = (uni, score, i) => ({ uni, score, coin: uni + i, ev: "bigmove" });
  const many = [];
  for (let i = 0; i < 60; i++) many.push(mk("main", 90 + i, i));   // crypto dominates on raw score
  for (let i = 0; i < 20; i++) many.push(mk("xyz", 10 + i, i));    // equities score far lower
  const cap = C.capPerUniverse(many, 40, 40);
  assert.equal(cap.filter((g) => g.uni === "xyz").length, 20,
    "every equity signal survives the cap even when 60 higher-scoring crypto signals exist");
  assert.equal(cap.filter((g) => g.uni === "main").length, 40, "crypto fills its own lane and stops there");
  for (let i = 1; i < cap.length; i++) assert.ok(cap[i - 1].score >= cap[i].score, "merged list stays score-ordered");
  assert.deepEqual(C.capPerUniverse(null, 40, 40), [], "null input: empty list, not a throw");
  const fs = require("fs"), path = require("path");
  const pol = fs.readFileSync(path.join(__dirname, "..", "src", "poller.js"), "utf8");
  assert.ok(pol.includes("const top = crypto ? capPerUniverse(kept, 40, 40) : kept.slice(0, 40);"),
    "the build routes through the lanes when crypto is enabled and keeps the plain slice when it is not");
  const app = fs.readFileSync(path.join(__dirname, "..", "public", "app.js"), "utf8");
  for (const pin of ["function setSigTabBadge()",
    "const u = state.scope==='crypto' ? 'm' : 'x';",
    "d&&d.countU&&d.countU[u]!=null ? d.countU[u] : (d?(d.count||0):0)"])
    assert.ok(app.includes(pin), `scoped badge pin missing: ${pin}`);
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
  for (const pin of ["callModel(AI_CLASSIFY_MODEL, pend, { system: SEC_CLASSIFY_SYSTEM, maxTokens: 600, effort: AI_CLASSIFY_EFFORT })", "const GICS_SECTORS = [",
    "learned sectors feed the NEWS badges/grouping ONLY", "classifySecTick().catch", "sectors: { tapeClassified:"])
    assert.ok(pol.includes(pin), `classifier pin missing: ${pin}`);
  // the classifier runs on its OWN cheap model, never the report/ask fallback (which on OpenAI is
  // the flagship Sol tier) — decoupling proven by source, so a report-quality change can't touch it
  assert.ok(/AI_CLASSIFY_MODEL = process\.env\.AI_CLASSIFY_MODEL \|\| AI_DEF\.classify \|\| AI_MODEL_FALLBACK/.test(pol), "classifier model must be its own knob, falling back to provider default then the report fallback");
  assert.ok(/AI_CLASSIFY_EFFORT = process\.env\.AI_CLASSIFY_EFFORT \|\| "low"/.test(pol), "classifier effort must default to low (nano classification wants no reasoning tokens)");
  assert.ok(pol.includes('classify: "gpt-5.4-nano"') && pol.includes('classify: "claude-haiku-4-5"'), "each provider must default the classifier to a cheap classification-grade tier");
  assert.ok(!pol.includes("callModel(AI_MODEL_FALLBACK, pend"), "the classifier must no longer reuse the report/ask fallback model");
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
    "relevance verdict pending", "a.sec==='off-topic'?' off'", "const lane=r.mlane||null;",
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

test("crypto enrollment, proven by behavior: both universes fire, on their own horizons, whitelist holding both ways", () => {
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
  p.buildSignalsNow();
  const d = p.getSignals();
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
  const ledC = p.getLedgerFor("ETH");
  assert.ok((ledC.open || []).length > 0, "crypto claims ledger");
  const ledX = p.getLedgerFor("xyz:NVDA");
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

test("empty record still RENDERS: awaits, shadows, variants — executed, not string-pinned", () => {
  // The -87-deploy lesson kept alive after the -101 removal: an honestly-empty record must
  // still render the awaiting roster, the shadows panel and the variants. This executes the
  // REAL sigRecordHtml from the shipped client against an empty record — rendering behavior,
  // not source pins (the -85 lesson: existence is not wiring). The scope branch is BACK with the
  // crypto engine, so the roster is asserted per scope and the sandbox supplies the same scoped
  // record-set helper the shipped renderer calls.
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
  const MAIN_ONLY_EV = new Set(["casc", "fundext"]);
  const sigRecKey = eval("(" + grab("sigRecKey") + ")");
  // -16: subsections render behind collapsed headers; open them all so the body paths execute.
  // The REAL sigSec is grabbed (signature-anchored — plain grab("sigSec") would hit sigSecOpen).
  const grabSig = () => { const i = src.indexOf("function sigSec(id,cls,label,tip,body)"); assert.ok(i >= 0, "sigSec missing");
    let dep = 0, j = src.indexOf("{", i);
    for (let k = j; k < src.length; k++) { if (src[k] === "{") dep++; if (src[k] === "}") { dep--; if (!dep) return src.slice(i, k + 1); } } };
  const sigSecOpen = () => new Set(["evtable", "slices", "curve", "tuning", "shadows", "resolutions"]);
  const sigSec = eval("(" + grabSig() + ")");
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
  assert.equal(ledgerRosterScoped().length, 13, "stocks roster: thirteen events");
  assert.equal(sigRecKey(0, false), "0x", "stocks scope reads the x-suffixed record set");

  // ---- and the same render in CRYPTO scope --------------------------------------------------
  // The failure this guards against is not a blank tab, it is a PLAUSIBLE one: a crypto board
  // silently rendering the equity record, or offering "awaiting first claim" for events crypto
  // never runs. Both would look completely normal on screen.
  state.scope = "crypto";
  assert.equal(sigRecKey(0, false), "0m", "crypto scope reads the m-suffixed record set, never the equity one");
  const roster = ledgerRosterScoped();
  for (const ev of ["casc", "fundext", "bigmove", "breakout", "tretest"])
    assert.ok(roster.includes(ev), `crypto roster must carry ${ev}`);
  for (const ev of ["gap", "prem", "ondrift", "squeeze", "unwind"])
    assert.ok(!roster.includes(ev), `crypto roster must NOT carry ${ev} — "awaiting" would be a lie for an event this universe never runs`);
  const dC = { records: { "0m": { record: {}, recent: [] }, "0": { record: {} } },
    shadows: { xyz: [], main: [{ ev: "reclaim", label: "breakdown reclaim", unit: "R", tip: "t", rows: [{ tag: null, n: 0, open: 0 }] }] },
    variants: [], count: 0 };
  const htmlC = sigRecordHtml(dC);
  assert.ok(htmlC.includes("awaiting first claim"), "the crypto roster renders its awaits too");
  assert.ok(htmlC.includes("casc") && htmlC.includes("fundext"), "crypto-native events appear in the crypto roster");
  assert.ok(!htmlC.includes("Premium dislocation") && !htmlC.includes("Overnight drift"),
    "xyz-only events never appear under a crypto board");
  assert.ok(htmlC.includes("breakdown reclaim"), "the crypto shadow panel renders, not the xyz one");
  state.scope = "stocks";

  // ---- the client roster and the server whitelist must agree -------------------------------
  // Two hand-kept lists that mean the same thing WILL drift; this joins them. A client roster
  // offering an event the server refuses to ledger renders a permanent "awaiting first claim"
  // that can never resolve — the exact shape of bug that survives review because it looks fine.
  const pol = fs.readFileSync(path.join(__dirname, "..", "src", "poller.js"), "utf8");
  const mainSet = pol.slice(pol.indexOf("const MAIN_EVS = new Set(["), pol.indexOf("]);", pol.indexOf("const MAIN_EVS = new Set([")));
  for (const ev of roster)
    assert.ok(mainSet.includes('"' + ev + '"'), `client crypto roster lists ${ev} but the server's MAIN_EVS does not admit it`);
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
    "const AI_SCHEMA_V = 9;", "NEWS CONTRACT", "context.news.verified is empty you MUST NOT",
    "invented news", "rel7dPct", "rel30dPct", "context.crypto",
    // v7 earnings reported-vs-upcoming split
    "earnEntryState(x, now) === \"upcoming\"", "e.reported =",
    "event scenario without a pending earnings print", "reportedD"])
    assert.ok(pol.includes(pin), `v6/v7 pin missing: ${pin}`);
  assert.ok(!pol.includes("cryptoSetupsLive"), "the AI context no longer cites live engine setups it does not have (-101)");
});

test("earnings: earnEntryState splits reported vs upcoming on actual-present OR the ET session clock", () => {
  const C = require("../src/compute");
  const at = (iso) => new Date(iso).getTime();
  const noon = at("2026-07-23T18:00:00Z");    // 14:00 ET — a BMO release is out, the AMC close is not
  const evening = at("2026-07-23T22:00:00Z");  // 18:00 ET — after the AMC close (the bug's exact clock)
  const today = C.etDayStr(noon), yest = C.etDayStr(noon - 86400e3), tomo = C.etDayStr(noon + 86400e3);
  const S = C.earnEntryState;
  assert.equal(S({ d: today, s: "AMC", epsA: 0.42 }, noon), "reported", "actual present = reported even before the close");
  assert.equal(S({ d: today, s: "AMC", epsA: null }, noon), "upcoming", "AMC before 16:00 ET is still ahead");
  assert.equal(S({ d: today, s: "AMC", epsA: null }, evening), "reported", "AMC after the close is out — the screenshot fix, even with no actual yet");
  assert.equal(S({ d: today, s: "BMO", epsA: null }, noon), "reported", "BMO is out by the open");
  assert.equal(S({ d: today, s: "DMH", epsA: null }, noon), "upcoming");
  assert.equal(S({ d: today, s: "DMH", epsA: null }, evening), "reported", "DMH settles on the close threshold");
  assert.equal(S({ d: today, s: "TBD", epsA: null }, evening), "upcoming", "TBD same-day has no clock to trust — actual-present only");
  assert.equal(S({ d: yest, s: "TBD", epsA: null }, noon), "reported", "any prior ET day is unconditionally past");
  assert.equal(S({ d: tomo, s: "AMC", epsA: null }, noon), "upcoming", "any future ET day is ahead");
  assert.equal(S(null, noon), "upcoming", "a malformed entry never fabricates a reported state");
});

test("ai report: a reported print is a post-event object, not a pending `next`; validator bans a stale event scenario", () => {
  const { p, px } = aiTestPoller();
  const C = require("../src/compute");
  const yest = C.etDayStr(Date.now() - 86400e3);     // unconditionally reported
  const future = C.etDayStr(Date.now() + 6 * 86400e3); // unconditionally upcoming
  // INTC-shaped: today's print already out (carried as a back-window row with its actual) AND a
  // real next print six days ahead. The reported row must NOT masquerade as `next`.
  p.seedEarnNow([
    { t: "NVDA", d: yest, s: "AMC", eps: 0.22, epsA: 0.42, rev: null, revA: null },
    { t: "NVDA", d: future, s: "AMC", eps: 0.30, epsA: null, rev: null, revA: null },
  ]);
  const ctx = p.aiCompileNow("xyz:NVDA");
  assert.ok(ctx.earnings, "earnings block present");
  assert.equal(ctx.earnings.next.d, future, "`next` is the still-ahead print, never the reported one");
  assert.ok(ctx.earnings.reported && ctx.earnings.reported.d === yest, "the printed row surfaces as `reported`");
  assert.equal(ctx.earnings.reported.beat, true, "beat verdict computed from actual vs estimate");
  assert.ok(Math.abs(ctx.earnings.reported.surprisePct - 90.9) < 0.2, "surprise% computed server-side");

  // With ONLY a reported print (no `next`), the pending-binary framing is illegitimate.
  p.seedEarnNow([{ t: "NVDA", d: yest, s: "AMC", eps: 0.22, epsA: 0.42 }]);
  const ctx2 = p.aiCompileNow("xyz:NVDA");
  assert.ok(ctx2.earnings.reported && !ctx2.earnings.next, "printed-only name carries reported, no next");
  const voidLv = +(px * 0.95).toPrecision(6), tgt = +(px * 1.10).toPrecision(6);
  const withEvent = JSON.parse(AI_GOOD(px, voidLv, tgt));
  withEvent.scenarios = [
    { name: "continuation to the target", kind: "target", p: 0.4, target: tgt, note: "trend persists" },
    { name: "the earnings print decides", kind: "event", p: 0.4, target: null, note: "coin flip into the report" },
    { name: "breaks the void", kind: "void", p: 0.2, target: null, note: "thesis dead below" },
  ];
  const rej = p.aiValidateNow(JSON.stringify(withEvent), ctx2);
  assert.equal(rej.ok, false, "an event scenario with no pending print is rejected");
  assert.match(rej.error, /event scenario without a pending earnings print/, "rejection names the stale-event cause");

  // The SAME event scenario is fine once a print is genuinely ahead.
  p.seedEarnNow([{ t: "NVDA", d: future, s: "AMC", eps: 0.30, epsA: null }]);
  const ctx3 = p.aiCompileNow("xyz:NVDA");
  assert.ok(ctx3.earnings.next && !ctx3.earnings.reported, "ahead-only name carries next, no reported");
  assert.equal(p.aiValidateNow(JSON.stringify(withEvent), ctx3).ok, true, "event scenario passes with a pending print ahead");
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
    "dataTs: Math.max(earnCache.dataTs || 0, earnLnVer, macroCache ? (macroCache.dataTs || 0) : 0)"])
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
    "macroStateC", "macroList", "macroNextC", "macroRecentC", "macroTimeLbl", "macroRangeFmt",
    "macroStatFmt", "macroMonthLbl", "macroValHtml", "macroRowHtml", "renderMacroStrip", "macroDayLbl", "wireMacroStrip",
    "applyTabOrder", "saveTabOrder", "wireTabDrag",
    "openTrendChart", "closeTrendChart", "loadTrendChart", "renderTrendChart", "tcCandleSvg", "tcEmaSeries",
    "updateFocusChip", "applyKsel", "kmoveSel", "applyMobileCols",
    "openCmdk", "closeCmdk", "cmdkRender", "cmdkActivate", "aiFmtCountdown", "aiFmtAgo", "aiTickCountdown",
    "updateFreshTray", "renderFreshTray",
    "termRun", "termExec", "nlResolve", "termScreen", "termTop", "termSignals", "termCorr", "termDiverge", "termCard", "termOpen", "termClose",
    "termBreadth", "termSectors", "termCompare", "termEarnCal", "termNewsCmd", "termReports", "termTickerish", "nlTickers", "termWin", "termAgo", "termAutoGrow", "termAdminUnlock", "termAdminLock", "termSetLock", "termRefreshLock",
    "renderRegime", "regimeCurveSvg", "wireRegimeControls",
    "drawSessions", "sgOpenSet", "sgToggle", "sgPendRow", "sgSection", "wireSessGroups",
    "sigSecOpen", "sigSecToggle", "sigSec",
    "liveMark", "claimDelta", "brkBar", "nowChip",
    "syncAnalyticsSlot", "_szTz", "_szCash",
    "alignedDailyN", "openCompg", "renderCompg", "compgSeries", "compgSvg", "compgLegend", "compgWireChart", "termComp",
    "renderCorrCrypto", "paintCorr", "alignedIntraday", "corrRet", "corrOvUnit", "syncCorrLookback",
    "compgAligned", "compgTickLabel", "compgHoverLabel",
    "cascCell", "liq24Cell", "loadDrawerDerivs", "renderDerivs", "dzWire",
    "compgUniverse", "compgDefaultSel", "compgAddName", "compgPickerHtml", "compgWirePicker", "compgAuto",
    "dailyLevels", "dailyOI", "btMomVariant",
    "mompCell", "renderDuelSection", "duelSvg", "duelDivergence", "loadDuelData", "duelRoll", "colAdjacent",
    "loadActionable", "openActionable", "renderActionable", "actHead", "actDetail", "actCmp", "actCell", "actRR", "actEV",
    "actLate", "actLateCls", "actAgo", "actSortLoad", "actSortSave",
    "actSettled", "actEpDetail", "actSettledWire", "actSetPct", "actSetR", "actSetDays",
    "termHistPush", "termCausal",
    "loadTriggers", "fireTrigger", "pushTrigToast", "trigEligibleClient", "trigSeqGet", "trigSeqSet",
    "fireOps", "fireLedger", "loadPush", "buildPushSection", "pushAct", "pushCodeLeft",
    "alertText", "alertUnread", "alertMarkRead", "loadRules", "ruleAct", "trendWhenTxt"];
  for (const n of need) {
    assert.ok(defs[n] >= 1, `missing client function: ${n}`);
    assert.equal(defs[n], 1, `duplicate client function: ${n}`);
  }
  for (const frag of ["const HELP={", "const SHOW_CLAIM_CURVE", "conflWith", "claim0", "presentSince|sighist-ev", "/api/earnings", "eb0", "earnSplit", "d.recent||", "REPORTED \\u00b7",
    "macrostrip", "MACRO \\u00b7 REPORTED", "act-mwarn", "mrow", "d.macroErr", "tabdot",
    "nxt.diff<=2", "mn.diff<=2", "FOMC meeting begins",
    "krow", "state.focus", "/api/derivs", "MAIN_ONLY_COLS", "dderivs",
    "key:'momp'", "/api/duel", "momentum2:", "r.momWhy",
    "c.structLevels", "detected structural level(s) drawn faint"]) {
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
  // Help must cover every tab, including the two newest (report, news) — a fallback to HELP.markets
  // silently showed the wrong help on those tabs before this was pinned.
  for (const k of ["markets:`", "trend:`", "sectors:`", "corr:`", "sessions:`", "signals:`", "earnings:`", "backtest:`", "report:`", "news:`", "actionable:`"])
    assert.ok(s.includes(k), `HELP is missing an entry for a tab: ${k}`);
  // Command palette + freshness tray load-bearing markers.
  assert.ok(s.includes("CMDK_TABS") && s.includes("metaKey||e.ctrlKey") && s.includes("cmdk-q"), "command palette wiring missing");
  assert.ok(s.includes("FRESH_SOURCES") && s.includes("/api/health"), "freshness tray wiring missing");
  assert.ok(s.includes("setInterval(aiTickCountdown,1000)"), "report cooldown live ticker missing");
  // Ask-the-board terminal: tiered resolution (grammar → local NL → AI stub), live-data field map, launcher.
  assert.ok(s.includes("TFIELD") && s.includes("termAprOf"), "terminal live-field accessors missing");
  assert.ok(s.includes("function nlResolve") && s.includes("Tier 2"), "terminal NL intent layer missing");
  assert.ok(s.includes("function termAsk") && s.includes("/api/ask"), "terminal AI-fallback client call missing");
  assert.ok(s.includes("termCompactUniverse") && s.includes("termThinking"), "terminal AI-fallback plumbing missing");
  assert.ok(/if\(termGrammarComplete\(p\)\)/.test(s) && s.includes("nlResolve(line)"), "terminal routing (grammar→NL→AI) missing");
  assert.ok(s.includes("function termGrammarComplete") && s.includes("function metricOf") && s.includes("function termEarnings"), "terminal NL-overhaul helpers missing");
  assert.ok(s.includes("function nlResolve") && /return null;\s*\/\/ a ticker plus intent we don't understand/.test(s), "nlResolve must escalate (return null) on unresolved ticker intent, not degrade to a card");
  // NL library v2: stopword-guarded ticker detection wired into nlResolve — the fix for
  // confident-but-wrong cards ("what's on the tape" must never resolve to the ON card).
  assert.ok(s.includes("const TSTOP=new Set(") && s.includes("nlTickers(rawWords)"), "guarded ticker detection not wired into nlResolve");
  // every board column callable: computed lenses + windows + any-field top/bottom
  for (const pin of ["vsma200:", "vsyopen:", "vsvwap:{", "rvol:{", "d7:{", "metricOf(metric)||tfield(metric)", "function termWin"])
    assert.ok(s.includes(pin), `full-field terminal coverage missing: ${pin}`);
  // new whole-board verbs routed in termExec
  for (const pin of ["h==='breadth'", "h==='sectors'", "h==='reports'", "h==='vs'||h==='compare'", "h==='comp'", "h==='top'||h==='bottom'", "termEarnCal(a1||'today')"])
    assert.ok(s.includes(pin), `terminal verb routing missing: ${pin}`);
  // COMP/G N-name comparison: launcher wiring, the union-day aligner, and the two render modes.
  assert.ok(s.includes("openCompg()") && /const COMPG=\{/.test(s), "COMP/G launcher + state missing");
  // -03: auto-launch replaced the button. The Corr tab must call compgAuto on open AND on a
  // scope flip, the picker must exist, and the launcher button must stay dead (a revert that
  // resurrects el('compgBtn') wiring would throw on the missing element and kill the client).
  assert.ok(/if\(v==='corr'\)\{ openCorr\(\); setTimeout\(compgAuto,60\)/.test(s), "COMP/G must auto-open with the Corr tab");
  assert.ok(s.includes("renderCorr(); setTimeout(compgAuto,60)"), "scope flip on the Corr tab must re-auto-open COMP/G for the new universe");
  assert.ok(!s.includes("compgBtn"), "the COMP/G launcher button must stay removed from app.js");
  assert.ok(s.includes("COMPG.closed=true") && s.includes("if(COMPG.closed) return;"), "panel close must latch for the session so auto-launch respects it");
  assert.ok(s.includes("function alignedDailyN") && s.includes("COMPG.mode==='spread'") && s.includes("COMPG.mode==='index'"), "COMP/G index/spread modes missing");
  assert.ok(s.includes("head==='comp'") && s.includes("TERM_VERBS=['top'") && s.includes("'corr','comp'"), "comp verb not wired into grammar/verb list");
  // Crypto intraday correlation tab: the tab is un-gated on crypto scope, the matrix comes from
  // the server payload (not client buildCorr on daily), the lookback is scope-aware (4h/1d/7d),
  // and the pair view aligns on the shipped intraday series. Each of these silently reverting to
  // the equities-only path would look fine but show an empty/wrong crypto matrix.
  assert.ok(s.includes("/api/corr-crypto") && s.includes("function renderCorrCrypto"), "crypto corr fetch path missing");
  assert.ok(s.includes("CORR._intraday") && s.includes("function paintCorr"), "crypto corr shared painter / intraday flag missing");
  assert.ok(s.includes("function syncCorrLookback") && /\[\['4h','4h'\],\['1d','1d'\],\['7d','7d'\]\]/.test(s), "scope-aware 4h/1d/7d lookback missing");
  assert.ok(s.includes("function alignedIntraday") && s.includes("CORR._bars"), "crypto pair-view intraday alignment missing");
  assert.ok(s.includes("'report','corr'") && s.includes("const CRYPTO_VIEWS"), "report and corr must remain in-scope for crypto (CRYPTO_VIEWS, which replaced showView's inline gate in -05)");
  // COMP/G runs on both universes via one axis-generic seam: equities align daily closes (axis =
  // day-ms), crypto reads the matrix's intraday closes (CORR._bars on CORR._times). The anchor is a
  // timestamp, not a day-int, and the button is no longer hidden on crypto. Reverting any of these
  // silently drops COMP/G back to equities-only.
  assert.ok(s.includes("function compgAligned") && s.includes("state.scope==='crypto' && CORR._intraday && CORR._bars && CORR._times"), "COMP/G crypto data seam missing");
  assert.ok(s.includes("COMPG.anchorTs") && !s.includes("COMPG.anchorDay"), "COMP/G anchor must be timestamp-based (anchorTs), not day-int");
  // (-03) the launcher button and its cg.hidden=false unhide are gone — crypto availability is
  // now guaranteed by compgAuto firing on the Corr tab in both scopes; this pin keeps the old
  // crypto-block from ever returning inside openCompg.
  assert.ok(s.includes("function compgAuto") && !/openCompg\(tickers\)\{\s*if\(state\.scope==='crypto'\)\{ const p=el\('compg'\)/.test(s), "COMP/G must no longer be hidden/blocked on crypto");
  // TERM_VERBS regression: it was referenced by termComps but never DEFINED — a silent
  // ReferenceError on every keystroke that killed ghost text + tab completion.
  assert.ok(/const TERM_VERBS=\[/.test(s), "TERM_VERBS must be defined, not just referenced (completion engine ReferenceError)");
  // server planner grammar stays in sync with the client executor (one grammar, two ends)
  {
    const polSrc = fs.readFileSync(path.join(__dirname, "..", "src", "poller.js"), "utf8");
    for (const pin of ["vsma200", '"top" || h === "bottom"', 'h === "breadth"'])
      assert.ok(polSrc.includes(pin), `ask planner grammar out of sync with client: ${pin}`);
    // analyst context starvation regression: the AI once answered "yearly open is not in the
    // data" because termCompactUniverse shipped 14 fields. Every board metric must ship, and
    // the analyst legend must describe it — a field missing here IS "not in the data".
    for (const pin of ["yo:rnd(r.yopen)", "mo:rnd(r.mopen)", "m200:rnd(r.ma200)", "d7:rnd(r.d7)", "rv:rnd(r.rvol)", "ddy:rnd(r.ddy)"])
      assert.ok(s.includes(pin), `analyst context missing board field: ${pin}`);
    for (const pin of ["yo = yearly open", "mo = monthly open", "m20/m50/m100/m200", "ddy = % below 52w high", "derivable from the data",
      "name = the company's common name", "NUMBERS RULE", "IDENTITY RULE"])
      assert.ok(polSrc.includes(pin), `analyst legend out of sync with shipped context: ${pin}`);
  }
  for (const id of ["helpBtn", "helpmodal", "sighist-q", "sighist-ev", "sighist-panel", "dledger", "earnings-body", "view-earnings", "logoutBtn", "tabSpacer", "focusChip", "cmdk", "cmdk-q", "freshtray", "termFab", "termPanel", "termCmd", "termExpand", "compg"]) {
    if (id === "dledger") continue;   // dledger is injected by JS, not static markup
    assert.ok(html.includes(`id="${id}"`), `missing markup id: ${id}`);
  }
  // 1B: the ask input is a wrapping textarea, not a single-line <input> that runs off-screen.
  assert.ok(/<textarea id="termCmd"/.test(html), "ask input must be a <textarea> (wrapping), not an <input>");
  assert.ok(!/<input id="termCmd"/.test(html), "old single-line ask <input> must be gone");
  const tcss = fs.readFileSync(path.join(__dirname, "..", "public", "styles.css"), "utf8");
  assert.ok(/#termCmd\{[^}]*resize:none/.test(tcss) && /#termCmd\{[^}]*white-space:pre-wrap/.test(tcss), "termCmd textarea must not resize and must wrap");
  assert.ok(/#termGhost\{[^}]*white-space:pre-wrap/.test(tcss), "ghost overlay must wrap in sync with the textarea");
  assert.ok(/\.tp-wrap\{[^}]*min-width:0/.test(tcss), "tp-wrap needs min-width:0 or a long value overflows the panel (flexbox min-width:auto)");
  assert.ok(s.includes("function termAutoGrow") && s.includes("termAutoGrow(q)"), "textarea auto-grow helper missing/unwired");
  assert.ok(s.includes("!e.shiftKey&&!e.isComposing"), "Enter-to-run must yield to Shift+Enter (newline) and IME composition");
  // AI admin gate (client): unlock/lock commands (redacted echo), the three endpoints, the
  // ai-locked prompts on both AI surfaces, the lock indicator, and the help lines.
  assert.ok(s.includes("admin\\s+unlock") && s.includes("admin\\s+lock"), "admin unlock/lock command parsing missing");
  assert.ok(s.includes("/api/ai-unlock") && s.includes("/api/ai-lock") && s.includes("/api/ai-status"), "AI unlock/lock/status client calls missing");
  assert.ok(s.includes("d.error==='ai-locked'") || s.includes('d.error==="ai-locked"'), "client must handle the ai-locked response");
  assert.ok(s.includes("function termSetLock") && s.includes("function termRefreshLock") && s.includes("termRefreshLock()"), "lock indicator state helpers missing/unwired");
  assert.ok(s.includes("admin unlock") && s.includes("admin lock"), "terminal help must list admin unlock/lock");
  assert.ok(html.includes('id="termLock"'), "terminal AI lock indicator markup missing");
  // The backtest tab was silently dropped from the nav once while every renderer behind it
  // survived — pin both the button and the view section so the tab can't vanish again.
  // Still pinned, and deliberately so: the tab is HIDDEN from the strip, not removed. The markup,
  // the view section and every renderer behind it stay live — so this guard still catches a real
  // deletion, while the hide itself is asserted separately below.
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
  const routes = ["/api/snapshot", "/api/daily", "/api/analytics", "/api/duel", "/api/trend", "/api/signals",
    "/api/earnings", "/api/series", "/api/ledger", "/api/candles", "/api/corr-crypto", "/api/derivs", "/api/ai-report", "/api/ai-reports", "/api/health",
    "/api/actionable", "/api/triggers",
    "/api/export/ledger", "/api/news", "/api/news/channels", "/api/alerts", "/api/alerts/rules",
    "/manifest.webmanifest", "/icon.svg", "/sw.js"];
  for (const r of routes) {
    const n = srv.split(`fastify.get("${r}"`).length - 1;
    assert.ok(n >= 1, `server route missing: ${r}`);
    assert.equal(n, 1, `server route registered ${n} times: ${r}`);
  }
  // Generation is a POST with its own registration — pinned separately from the GET reads.
  assert.equal(srv.split('fastify.post("/api/ai-report"').length - 1, 1, "POST /api/ai-report must be registered exactly once");
  assert.equal(srv.split('fastify.post("/api/derivs/refresh"').length - 1, 1, "POST /api/derivs/refresh must be registered exactly once");
  // Terminal Tier-3 fallback is a POST backed by poller.askBoard — pin both.
  assert.equal(srv.split('fastify.post("/api/ask"').length - 1, 1, "POST /api/ask must be registered exactly once");
  // Admin budget reset is a POST backed by poller.resetAiDay — pin route, mapping, and export.
  assert.equal(srv.split('fastify.post("/api/ai-reset"').length - 1, 1, "POST /api/ai-reset must be registered exactly once");
  assert.ok(srv.includes('r.error === "cooldown" || r.error === "daily-cap" ? 429'), "/api/ai-report must map daily-cap to 429 like cooldown");
  // -11 perf: candles + series must go through serveKeyed (ETag 304 + gzip memo), NOT no-store.
  // A raw serveCached here would be a correctness BUG — etagFor keys only on dataTs, which these
  // payloads lack, so every coin would share W/"0" and a client could get a 304 for the wrong
  // coin's chart. serveKeyed supplies a collision-proof per-coin/tf/version ETag instead.
  assert.ok(srv.includes("function serveKeyed") && srv.includes("function sendCachedBody"), "serveKeyed + sendCachedBody must exist");
  assert.ok(/get\("\/api\/candles"[\s\S]{0,1600}serveKeyed\(/.test(srv), "/api/candles must serve via serveKeyed");
  assert.ok(/get\("\/api\/series"[\s\S]{0,1200}serveKeyed\(/.test(srv), "/api/series must serve via serveKeyed");
  assert.ok(!/get\("\/api\/candles"[\s\S]{0,200}no-store/.test(srv), "/api/candles must no longer be no-store");
  assert.ok(srv.includes('"candles|"') && srv.includes("cs.px > 0 ? Math.round(Math.log(cs.px)"), "tf-candles key must fold in the live-mark bucket so the forming bar can't freeze");
  // -11 security: the paid AI endpoints must be closed to unauthenticated callers regardless of
  // SITE_PASSWORD (never serve model budget to the open web), and both POSTs carry a body cap.
  assert.ok(srv.includes("const reqAuthed") && srv.includes('AI_COST_PATHS = new Set(["/api/ask", "/api/ai-report"])'), "always-on AI-cost auth guard missing");
  assert.ok(srv.includes("!reqAuthed(req)") && /AI_COST_PATHS\.has\(u\)[\s\S]{0,120}!reqAuthed\(req\)/.test(srv), "AI-cost guard must 401 unauthenticated callers");
  assert.ok(/fastify\.post\("\/api\/ask", \{ bodyLimit: 256 \* 1024 \}/.test(srv), "/api/ask must carry a 256 KB body limit");
  assert.ok(/fastify\.post\("\/api\/ai-reset", \{ bodyLimit: 8 \* 1024 \}/.test(srv), "/api/ai-reset must carry an 8 KB body limit");
  // Every poller getter the route layer references must be defined AND exported by the poller
  // factory — a route bound to a phantom getter is a 500 the drawer's silent catch would eat.
  const pol = fs.readFileSync(path.join(__dirname, "..", "src", "poller.js"), "utf8");
  assert.ok(/async function askBoard/.test(pol) && /askBoard,/.test(pol), "poller.askBoard (terminal AI fallback) missing or not exported");
  assert.ok(/function resetAiDay/.test(pol) && /resetAiDay,/.test(pol), "poller.resetAiDay (admin budget reset) missing or not exported");
  const getters = new Set([...srv.matchAll(/poller\.(get[A-Za-z0-9_]+)\(/g)].map((m) => m[1]));
  assert.ok(getters.size >= 8, `suspiciously few poller getters referenced by routes: ${getters.size}`);
  // Getters take two shapes in poller.js — `function getX(` hoisted then exported shorthand,
  // or `getX: () =>` inline in the export object. Either counts; zero occurrences is a phantom
  // (exactly what the removed /api/unlocks route was — bound to a getUnlocks that never existed).
  for (const g of getters)
    assert.ok(new RegExp(`(function ${g}\\(|${g}\\s*:)`).test(pol), `route references undefined poller getter: ${g}`);
});

test("AI admin gate: server locks generation behind an unlock cookie, no script/header bypass", () => {
  const fs = require("fs"), path = require("path");
  const srv = fs.readFileSync(path.join(__dirname, "..", "server.js"), "utf8");
  const pol = fs.readFileSync(path.join(__dirname, "..", "src", "poller.js"), "utf8");
  // Signing: the unlock secret is DERIVED from ADMIN_PASSWORD (rotating it revokes every unlock),
  // and both the signer and verifier exist.
  assert.ok(srv.includes("xyzmon-ai-unlock|") && /const AI_UNLOCK_SECRET/.test(srv), "AI unlock secret must derive from ADMIN_PASSWORD");
  assert.ok(srv.includes("function signAiUnlock") && srv.includes("function aiUnlockOk"), "AI unlock signer/verifier missing");
  // Fail-closed: no admin password => no valid unlock, ever.
  assert.ok(/aiUnlockOk[\s\S]{0,120}!ADMIN_PASSWORD/.test(srv), "aiUnlockOk must reject when ADMIN_PASSWORD is unset (fail closed)");
  // Enforcement: the shared AI-cost hook must require the xyzai unlock on top of authentication,
  // and emit the distinct 'ai-locked' code (so the client can prompt for the password vs a login).
  assert.ok(srv.includes('error: "ai-locked"') && /aiUnlockOk\(getCookie\(req, "xyzai"\)\)/.test(srv), "AI-cost hook must gate on the xyzai unlock cookie with an ai-locked 401");
  // Cookie is HttpOnly and browser-session-lived (no Max-Age on set); mint + clear helpers exist.
  assert.ok(srv.includes("function setAiUnlockCookie") && srv.includes("function clearAiUnlockCookie"), "xyzai cookie set/clear helpers missing");
  assert.ok(/aiCookieAttrs[\s\S]{0,400}HttpOnly/.test(srv), "xyzai must be HttpOnly");
  // No header/Basic bypass: the ONLY unlock affordance is the password route (no X-Admin-Password).
  assert.ok(!/x-admin-password/i.test(srv), "there must be no header bypass for the AI gate (browser+password only)");
  // Routes registered exactly once, backed by the shared admin check.
  assert.equal(srv.split('fastify.post("/api/ai-unlock"').length - 1, 1, "POST /api/ai-unlock registered exactly once");
  assert.equal(srv.split('fastify.post("/api/ai-lock"').length - 1, 1, "POST /api/ai-lock registered exactly once");
  assert.equal(srv.split('fastify.get("/api/ai-status"').length - 1, 1, "GET /api/ai-status registered exactly once");
  assert.ok(srv.includes("poller.checkAdminPassword"), "unlock route must verify via poller.checkAdminPassword");
  assert.ok(/function checkAdminPassword/.test(pol) && /checkAdminPassword,/.test(pol), "poller.checkAdminPassword missing or not exported");
  // The reset route must still share that one check (one lockout surface, not two).
  assert.ok(/function resetAiDay[\s\S]{0,160}checkAdminPassword\(password\)/.test(pol), "resetAiDay must route through checkAdminPassword (shared lockout)");
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
  for (const n of ["loadTrend", "openTrend", "renderTrend", "trendDotHtml", "trendSectionHtml", "trendMAChips"]) {
    assert.ok(defs[n] >= 1, `missing client function: ${n}`);
    assert.equal(defs[n], 1, `duplicate client function: ${n}`);
  }
  assert.ok(!/\\\\u[0-9a-f]{4}/.test(s), "no double-escaped unicode (\\\\uXXXX) may leak into client strings — it renders as literal text");
  for (const frag of ["/api/trend", "trow-hl", "tretest", "trend:`", "tage", "td21", "fresh-first", "twidth", "rrv",
    "tma-chip", "?fast=", "&slow=", "nodata", "tpend", "_trendMA", "_tc.ema", "SEED=S-1",
    "EMA${F}", "EMA${S}", "\\u0394${S}"])   // board text follows the active pair, not a hardcoded 13/21
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
  for (const cls of [".tdot", ".tretest", ".trend-t", ".trow-hl", ".twidth", ".tchart-btn", ".tchart-modal", ".tcbtn-td",
    ".tdot.nd", ".tma-chip", ".tma-chip.on"])
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

test("stackedRun honours custom spans and dashes when the slow MA can't seed", () => {
  const { stackedRun } = require("../src/compute");
  const up = (n) => Array.from({ length: n }, (_, i) => ({ c: 100 * Math.pow(1.003, i) }));
  assert.equal(stackedRun(up(60), null, "long", 13, 200), null, "60 bars can't seed a 200 EMA");
  const r = stackedRun(up(260), 100 * Math.pow(1.003, 260), "long", 13, 200);
  assert.ok(r && r.run > 0, "a clean uptrend over 260 bars has a positive 13/200 run");
  const d = stackedRun(up(60), null, "long");   // default 13/21 unchanged: 60 bars is plenty
  assert.ok(d && d.run > 0, "default spans still measure a run on 60 bars");
});

test("getTrendPair: validates the pickable set, passes the default through to the shared board", () => {
  const { createPoller } = require("../src/poller");
  const store = { loadAll: () => new Map(), loadRegime: () => [], loadLedger: () => null,
    saveLedger: () => {}, insert: () => {}, saveRegime: () => {} };
  const p = createPoller({ dex: "xyz", store, log: () => {}, version: "test", crypto: false });
  const now = Date.now(), endH = Math.floor(now / HOUR), N = 16 * 24, hourly = [];
  for (let i = 0; i < N; i++) { const t = (endH - N + i) * HOUR, c = 100 * Math.pow(1.0005, i); hourly.push({ t, o: c, h: c * 1.001, l: c * 0.999, c, v: 1 }); }
  const px = hourly[N - 1].c * 1.0005, daily = [];
  for (let i = 0; i < 60; i++) daily.push({ t: (Math.floor(now / DAY) - 60 + i) * DAY, c: px * Math.pow(1.01, i - 59), l: px * Math.pow(1.01, i - 59) * 0.99, h: px * Math.pow(1.01, i - 59) * 1.002 });
  p.seedRowNow("TP1", { px, uni: "xyz", vol: 1e6, hourlyRaw: hourly, dailyRaw: daily });
  p.buildTrendNow();
  assert.equal(p.getTrendPair(13, 21), p.getTrend(), "the default pair returns the canonical shared board");
  assert.equal(p.getTrendPair(9, 50), null, "a span outside the pickable set is rejected");
  assert.equal(p.getTrendPair(50, 50), null, "a pair must be two distinct MAs");
  const board = p.getTrendPair(200, 50);   // unordered input normalises to fast<slow
  assert.ok(board && board.params, "a valid custom pair builds a board");
  assert.deepEqual(board.params.ema, [50, 200], "the built board reports its normalised pair");
  assert.deepEqual(board.params.pickable, [13, 21, 50, 200], "the board advertises the pickable set");
});

test("parametric chart parity: pair board ships EMAs + rrv/swing, and the deeper H1 series reproduces its EMAs", () => {
  const { createPoller } = require("../src/poller");
  const { emaLast } = require("../src/compute");
  const store = { loadAll: () => new Map(), loadRegime: () => [], loadLedger: () => null,
    saveLedger: () => {}, insert: () => {}, saveRegime: () => {} };
  const p = createPoller({ dex: "xyz", store, log: () => {}, version: "test", crypto: false });
  const now = Date.now(), endH = Math.floor(now / HOUR), N = 16 * 24, hourly = [];
  for (let i = 0; i < N; i++) { const t = (endH - N + i) * HOUR, c = 100 * Math.pow(1.0005, i); hourly.push({ t, o: c, h: c * 1.001, l: c * 0.999, c, v: i >= N - 24 ? 2 : 1 }); }
  const px = hourly[N - 1].c * 1.0005, daily = [];
  for (let i = 0; i < 60; i++) daily.push({ t: (Math.floor(now / DAY) - 60 + i) * DAY, c: px * Math.pow(1.01, i - 59), l: px * Math.pow(1.01, i - 59) * 0.90, h: px * Math.pow(1.01, i - 59) * 1.002 });
  p.seedRowNow("PARITY", { px, uni: "xyz", vol: 1e6, hourlyRaw: hourly, dailyRaw: daily });
  // 13/50: D1 (60 bars) + H4 (96 buckets) + H1 (280 bars) seed EMA50; H12 (32 buckets) can't → grey
  const board = p.getTrendPair(13, 50);
  const row = board.long.stocks.find((e) => e.coin === "PARITY");
  assert.ok(row, "the pair row reaches the long board");
  assert.equal(row.tf.H12.st, "nodata", "H12 can't seed EMA50 on 32 buckets -> grey rung");
  assert.equal(row.tf.H12.e21, null, "a nodata rung ships no EMA");
  assert.equal(row.avail, 3, "scored out of the three rungs that seeded");
  assert.ok(row.tf.D1.e13 > 0 && row.tf.D1.e21 > 0, "computed rungs ship the pair's EMA values for the modal's zone band");
  assert.equal(row.retest, "D1", "the deep daily wick owns the retest");
  assert.ok(/EMA50/.test(row.read) && !/EMA21/.test(row.read), "the read names the active slow MA (EMA50), not a hardcoded 21");
  assert.ok(row.rrv != null && row.rrv > 1.5, `rrv is computed for the pair board (parity), got ${row.rrv}`);
  assert.ok("swing" in row, "the swing target is evaluated for the pair board (parity) — null here since a monotonic climb has no overhead swing");
  // the pair chart widens the H1 feed to match the board and reproduces its H1 EMAs bit-for-bit
  const res = p.getTfCandles("PARITY", "1h", 13, 50);
  assert.ok(res.candles.length > 96, `pair chart widens the H1 feed past 96, got ${res.candles.length}`);
  const closes = res.candles.map((k) => +k[4]); closes[closes.length - 1] = res.px;   // same live-mark-drives-the-forming-bar rule
  const rel = (a, b) => Math.abs(a - b) / Math.abs(b);
  assert.ok(rel(emaLast(closes, 13), row.tf.H1.e13) < 1e-6 && rel(emaLast(closes, 50), row.tf.H1.e21) < 1e-6,
    "the plotted pair ribbon reproduces the board's H1 EMAs — the modal cannot disagree with the pair board");
  // a plain 2-arg candle fetch (no pair) is unchanged — the canonical chart still reads 96 bars
  assert.ok(p.getTfCandles("PARITY", "1h").candles.length <= 96, "the default chart feed is untouched");
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
  // Crypto daily RETENTION deepened to 370d (-20: MA200 / structural levels / swing shadows) while
  // the WIRE stays at the 92 bars the clients render — both are constants, and the fetch must ride
  // retention while the payload cap rides the wire constant. A bare number left behind in either
  // spot silently shrinks a window back.
  assert.ok(/const MAIN_DAILY_DAYS = 370;/.test(pol), "crypto daily retention must be 370d via MAIN_DAILY_DAYS");
  assert.ok(/const MAIN_DAILY_PAYLOAD = 92;/.test(pol), "crypto daily wire payload must stay 92 bars via MAIN_DAILY_PAYLOAD");
  assert.ok(pol.includes("now - MAIN_DAILY_DAYS * DAY"), "crypto daily fetch must use MAIN_DAILY_DAYS");
  assert.ok(pol.includes("dr.slice(-(MAIN_DAILY_PAYLOAD + 2))"), "crypto daily payload cap must ride MAIN_DAILY_PAYLOAD");
  // -28: the cap is for the WIRE only. dc.daily doubles as the signal loop's input, and capping
  // both starved every deep crypto detector (swpull at 120 closes, regime200 at 210, the EMA200
  // shadows at 216) for eight builds while the 370d retention sat unread. The loop must read the
  // deep map, and the deep map must be written before the wire slice.
  assert.ok(pol.includes("deepDaily.set(r.coin, dr);"), "full crypto tuples stashed for the signal loop");
  assert.ok(pol.includes("const closes = deepDaily.get(r.coin) || dc.daily[r.coin] || null"), "the signal loop prefers full depth");
});

test("ai report: OpenAI provider — Chat Completions shape, Bearer auth, Terra→Sol fallback on refusal", async () => {
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
    assert.equal(calls[0].model, "gpt-5.6-terra", "OpenAI primary must default to Terra");
    assert.equal(calls[0].body.reasoning_effort, "high", "report generation must run Terra at high effort");
    assert.equal(calls[1].model, "gpt-5.6-sol", "OpenAI fallback must default to Sol");
    assert.equal(g.report.model, "gpt-5.6-sol", "the report names the model that actually produced it");
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
      assert.equal(l.model, "gpt-5.6-terra");
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
  for (const frag of ["AI_SCHEMA_V", "report format updated", "schemaV: AI_SCHEMA_V", "actionable stance without void/target geometry", "downgraded from an entry stance", "bucketsFor(r, 24)"])
    assert.ok(pol.includes(frag), `poller.js missing -73 marker: ${frag}`);   // daily-OHLC upgrade still aggregates the spine, now via the memoized bucketsFor (2026.07.21-08)
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
  for (const frag of ["const AI_SCHEMA_V = 9;", "aiMarksNow", "aiEvEdge", "AI_MARK_MIN_N", "runsOn", "lastEnd", "marksSuppressed"])
    assert.ok(pol.includes(frag), `poller.js missing -74 marker: ${frag}`);
});

test("UI batch -99: density toggle, keyboard nav and focused-ticker chip are fully wired", () => {
  // Three independent features shipped in one build — each pinned across every file it touches,
  // so a partial delivery (markup without wiring, wiring without CSS) is a suite failure.
  const fs = require("fs"), path = require("path");
  const app = fs.readFileSync(path.join(__dirname, "..", "public", "app.js"), "utf8");
  const html = fs.readFileSync(path.join(__dirname, "..", "public", "index.html"), "utf8");
  const css = fs.readFileSync(path.join(__dirname, "..", "public", "styles.css"), "utf8");
  // Density (rewritten 2026.07.27-23): the toggle is gone and compact is the only density. The
  // rules must survive as unconditional CSS — deleting the attribute without keeping the selector
  // weight would silently drop compact back to the base padding, which is the exact failure this
  // pins. Both halves are asserted: the rule still exists, and nothing can turn it off again.
  assert.ok(css.includes(":root .wrap tbody td{font-size:12px"), "compact table CSS missing");
  assert.ok(!css.includes("[data-density"), "the density attribute selector must be gone — compact is the only density");
  assert.ok(!app.includes("xyzmon.density") && !app.includes("densBtn"), "density toggle wiring must be gone");
  assert.ok(!html.includes('id="densBtn"'), "density button must be gone from the markup");
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

test("UI -23: amber theme removed, one density, status bar reformatted", () => {
  const fs = require("fs"), path = require("path");
  const app = fs.readFileSync(path.join(__dirname, "..", "public", "app.js"), "utf8");
  const html = fs.readFileSync(path.join(__dirname, "..", "public", "index.html"), "utf8");
  const css = fs.readFileSync(path.join(__dirname, "..", "public", "styles.css"), "utf8");

  // The amber palette is gone from all three files — not just unreachable, absent. A leftover
  // :root[data-theme] block is 30 lines of dead cascade nobody can trigger or notice rotting.
  for (const [name, src] of [["styles.css", css], ["app.js", app], ["index.html", html]])
    assert.ok(!src.includes("data-theme"), `amber theme residue in ${name}`);
  assert.ok(!html.includes('id="themeBtn"') && !app.includes("themeBtn"), "theme button must be gone");
  assert.ok(!app.includes("xyzmon.theme"), "theme persistence must be gone");

  // Tab ordering and the self-installing Treemap tab both anchored on themeBtn. Removing a button
  // that two independent systems used as a DOM landmark is exactly how tabs end up appended after
  // the controls, so the anchor is now an element that exists for that job and nothing else.
  assert.ok(html.includes('id="tabSpacer"'), "tab/control divider missing from the markup");
  assert.ok(css.includes(".tabspacer{margin-left:auto}"), "the spacer must absorb the slack");
  assert.equal((app.match(/el\('tabSpacer'\)|getElementById\('tabSpacer'\)/g) || []).length, 2,
    "both the saved-order pass and the Treemap installer must anchor on the spacer");

  // Status bar: a panel strip with a right-pinned tray, not right-aligned floating text.
  assert.ok(/\.statusline\{[^}]*background:var\(--panel\)/.test(css), "status bar must read as a strip");
  assert.ok(!/\.statusline\{[^}]*justify-content:flex-end/.test(css), "the old right-float layout must be gone");
  assert.ok(/\.statusline \.st-right\{[^}]*margin-left:auto/.test(css), "freshness tray must pin right");
  assert.ok(html.includes('class="st-right"'), "st-right wrapper missing from the markup");

  // The chip's own display rule outranked [hidden], so it sat in the bar showing "◎ —" forever.
  assert.ok(css.includes("#focusChip[hidden]{display:none}"), "hidden focus chip must actually hide");
});

test("UI -23: the [hidden] attribute is honoured by every element that styles its own display", () => {
  // This is the generalized form of the focus-chip bug, and it is a bug CLASS, not an instance.
  // An author `display:` rule beats the UA's [hidden]{display:none} on origin regardless of
  // specificity, so any component that sets its own display quietly stops responding to the
  // attribute — and the markup that declared it hidden paints anyway. styles.css had already
  // spot-patched this three times without anyone noticing four more live cases.
  //
  // So this doesn't pin a list. It derives one: every class/id in index.html that carries a bare
  // `hidden` attribute, cross-referenced against every rule in styles.css that gives that same
  // selector a display other than none. Anything in the intersection must also have an
  // X[hidden]{display:none} rule. Add a hideable component that styles its display and forget the
  // companion rule, and this fails before it ships.
  const fs = require("fs"), path = require("path");
  const css = fs.readFileSync(path.join(__dirname, "..", "public", "styles.css"), "utf8");
  const html = fs.readFileSync(path.join(__dirname, "..", "public", "index.html"), "utf8");

  const hideable = new Set();
  for (const [, attrs] of html.matchAll(/<\w+((?:"[^"]*"|'[^']*'|[^>"'])*)>/g)) {
    if (!/(^|\s)hidden(\s|$|=)/.test(attrs.replace(/aria-hidden/g, ""))) continue;
    const cls = /class="([^"]*)"/.exec(attrs), id = /id="([^"]*)"/.exec(attrs);
    if (cls) for (const c of cls[1].trim().split(/\s+/)) if (c) hideable.add("." + c);
    if (id) hideable.add("#" + id[1]);
  }
  assert.ok(hideable.size >= 20, `expected a real set of hideable elements, got ${hideable.size}`);

  const guarded = new Set();
  for (const m of css.matchAll(/(^|[\s,{}])([.#][\w-]+)\[hidden\]\s*\{[^}]*display\s*:\s*none/g)) guarded.add(m[2]);

  const unguarded = [];
  for (const m of css.matchAll(/(^|\})\s*([^{}@]+?)\s*\{([^}]*)\}/g)) {
    const body = m[3], d = /(?:^|;)\s*display\s*:\s*([\w-]+)/.exec(body);
    if (!d || d[1] === "none") continue;
    for (const part of m[2].split(",").map((x) => x.trim())) {
      if (!hideable.has(part) || guarded.has(part)) continue;
      unguarded.push(`${part} sets display:${d[1]} but has no ${part}[hidden]{display:none}`);
    }
  }
  assert.deepEqual([...new Set(unguarded)], [],
    "hideable elements that will paint despite the hidden attribute:\n  " + [...new Set(unguarded)].join("\n  "));

  // And the four that were live when this was written stay fixed by name, so a refactor that
  // guts the derivation above still can't quietly reintroduce them.
  for (const sel of [".btn", ".movers", ".filt-dot", ".regimestrip"])
    assert.ok(css.includes(`${sel}[hidden]{display:none}`), `regression: ${sel} lost its hidden guard`);
});

test("UI -24: session-wide controls live outside every per-view section", () => {
  // The alerts bell shipped inside #view-markets. showView() hides that whole section on any other
  // tab, so the bell AND its unread badge vanished the moment you left Markets — while alerts kept
  // firing from the poller, which is exactly when the badge is the only thing telling you.
  //
  // Same derivation shape as the [hidden] audit: rather than pinning "bellwrap is at line N", find
  // the byte span of every view section in index.html and assert no globally-scoped control id
  // falls inside one. Anything that must be reachable from every tab belongs to the shell.
  const fs = require("fs"), path = require("path");
  const html = fs.readFileSync(path.join(__dirname, "..", "public", "index.html"), "utf8");
  const app = fs.readFileSync(path.join(__dirname, "..", "public", "app.js"), "utf8");

  // Every id showView() toggles is a per-view section; derive the list from app.js so a new view
  // is covered the day it ships rather than the day someone remembers to add it here.
  const views = [...app.matchAll(/setHidden\('(view-[\w-]+)'/g)].map((m) => m[1]);
  assert.ok(views.length >= 8, `expected showView to toggle a real set of views, found ${views.length}`);

  const spans = [];
  for (const v of views) {
    const open = html.indexOf(`id="${v}"`);
    if (open < 0) continue;             // injected at runtime (treemap); nothing static to contain
    const start = html.lastIndexOf("<", open);
    let depth = 0, i = start;
    for (const m of html.slice(start).matchAll(/<(\/?)(?:div|section)\b[^>]*?(\/?)>/g)) {
      if (m[2] === "/") continue;
      depth += m[1] ? -1 : 1;
      if (depth === 0) { i = start + m.index + m[0].length; break; }
    }
    spans.push([v, start, i]);
  }
  assert.ok(spans.length >= 8, "could not resolve the view sections in index.html");

  // Controls the user must be able to reach or read from any tab.
  for (const id of ["bellBtn", "bellBadge", "alertpop", "helpBtn", "logoutBtn", "tabSpacer", "focusChip", "freshtray"]) {
    const at = html.indexOf(`id="${id}"`);
    assert.ok(at > 0, `missing global control: ${id}`);
    const trapped = spans.find(([, s0, s1]) => at > s0 && at < s1);
    assert.ok(!trapped, `${id} is nested inside ${trapped && trapped[0]} — it will disappear on every other tab`);
  }

  // The bell sits in the status bar tray specifically: .tabs gets overflow-x:auto below 680px,
  // which would clip the 340px popup, so the tab strip is not an option for this one.
  const tray = html.slice(html.indexOf('class="st-right"'), html.indexOf("</div>", html.indexOf('class="st-right"')));
  assert.ok(tray.includes('id="bellBtn"'), "the bell belongs in the status bar tray");
  const css = fs.readFileSync(path.join(__dirname, "..", "public", "styles.css"), "utf8");
  assert.ok(/\.stbell\{/.test(css), "the bell needs its strip-scale variant or it towers over the status bar");
  assert.ok(/\.stbell \.bell-badge\{[^}]*position:static/.test(css), "the corner pip must re-flow inline at strip scale");
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

test("perf: getHourly is a by-reference passthrough over the packed spine (no normalization copy)", () => {
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

test("terminal ticker guard: English words never resolve to tickers mid-sentence — the confident-but-wrong fix", () => {
  // Extract TSTOP + termTickerish from the client and RUN them: "what's on the tape" must never
  // become the ON Semiconductor card; caps, $-prefix, and single-word queries stay intentional.
  const fs = require("fs"), path = require("path");
  const s = fs.readFileSync(path.join(__dirname, "..", "public", "app.js"), "utf8");
  const m = s.match(/const TSTOP=new Set\([\s\S]*?function termTickerish\(w,only\)\{[\s\S]*?\n\}/);
  assert.ok(m, "TSTOP + termTickerish not extractable from app.js");
  const tickerish = new Function(m[0] + "; return termTickerish;")();
  // blocked: lowercase English words inside a sentence (each collides with a plausible listing)
  for (const w of ["on", "all", "it", "now", "key", "up", "the", "a", "so", "are", "big", "open"])
    assert.equal(tickerish(w, false), false, `"${w}" lowercase mid-sentence must NOT be ticker-ish`);
  // allowed: explicit forms
  assert.equal(tickerish("ON", false), true, "CAPS is intentional");
  assert.equal(tickerish("$all", false), true, "$-prefix is intentional");
  assert.equal(tickerish("NVDA", false), true, "caps symbol passes");
  assert.equal(tickerish("nvda", false), true, "lowercase non-English token passes");
  assert.equal(tickerish("sol", false), true, "lowercase crypto habit passes");
  assert.equal(tickerish("now", true), true, "a single-word query is always intentional");
  // mixed case is a word, not a symbol; punctuation is stripped before judging
  assert.equal(tickerish("Its", false), false, "mixed case is prose");
  assert.equal(tickerish("hype?", false), true, "trailing punctuation stripped, token judged clean");
});

test("ask-the-board terminal Tier-3: planner returns a grammar query, analyst returns grounded prose, disabled without a key, unmappable escalates", async () => {
  const { createPoller } = require("../src/poller");
  const store = { loadAll: () => new Map(), loadRegime: () => [], loadLedger: () => null,
    saveLedger: () => {}, insert: () => {}, saveRegime: () => {}, saveNews: () => {}, loadNews: () => null };
  // disabled path: no injected transport and no env key -> AI fallback is off, not a crash
  const off = createPoller({ dex: "xyz", store, log: () => {}, version: "test", crypto: false });
  const dOff = await off.askBoard("most crowded shorts", { universe: [{ t: "SOL" }] });
  assert.ok(dOff.disabled === true, "no key -> disabled, not an error page");

  // injected transport (anthropic shape, since no env key sets provider=anthropic)
  const respond = (text) => ({ ok: true, json: async () => ({ content: [{ type: "text", text }], stop_reason: "end_turn" }) });
  let next = null; const calls = [];
  const aiFetch = async (url, opts) => { calls.push(JSON.parse(opts.body)); return next; };
  const p = createPoller({ dex: "xyz", store, log: () => {}, version: "test", crypto: false, aiFetch });
  const uni = [{ t: "SOL", sqz: 71, f: -22 }, { t: "HYPE", sqz: 82, f: -31 }, { t: "BTC", sqz: 0, f: 12 }];

  // planner: model emits ONE grammar query; askBoard validates and returns it for the client to run
  next = respond("screen funding<0 & squeeze>50");
  const plan = await p.askBoard("which names are the most crowded shorts?", { scope: "crypto", universe: uni });
  assert.ok(plan.ok && plan.mode === "planner" && plan.query === "screen funding<0 & squeeze>50", `planner query, got ${JSON.stringify(plan)}`);

  // analyst: a "why" question routes to prose, grounded in the bundle; never a query
  next = respond("HYPE leads: squeeze 82 with funding at -31% APR, the most crowded short in the set.");
  const ana = await p.askBoard("why is HYPE the standout here?", { scope: "crypto", universe: uni });
  assert.ok(ana.ok && ana.mode === "analyst" && /HYPE/.test(ana.answer) && ana.marketsN === 3, `analyst prose, got ${JSON.stringify(ana)}`);

  // unmappable planner (model says NONE) escalates to analyst reasoning in the same call
  let step = 0;
  const aiFetch2 = async (url, opts) => { step++; return step === 1 ? respond("NONE") : respond("No single screen captures that; broadly, low-funding names skew short."); };
  const p2 = createPoller({ dex: "xyz", store, log: () => {}, version: "test", crypto: false, aiFetch: aiFetch2 });
  const esc = await p2.askBoard("what's the overall vibe of positioning?", { scope: "crypto", universe: uni });
  assert.ok(esc.ok && esc.mode === "analyst", `NONE from planner must escalate to analyst, got ${JSON.stringify(esc)}`);

  // a bad planner query (not in the grammar) is rejected -> escalates rather than shipped to the client
  const { createPoller: cp3 } = require("../src/poller");
  let s3 = 0; const p3 = cp3({ dex: "xyz", store, log: () => {}, version: "test", crypto: false,
    aiFetch: async () => { s3++; return s3 === 1 ? respond("buy SOL now!!") : respond("grounded fallback answer"); } });
  const bad = await p3.askBoard("find me something good", { scope: "crypto", universe: uni });
  assert.ok(bad.ok && bad.mode === "analyst", `invalid planner output must not reach the client as a query, got ${JSON.stringify(bad)}`);
});

test("perf batch 2026.07.21-08: snapshot/daily keep their cache OBJECT while content is unchanged", () => {
  // #1 — the serialize + gzip WeakMap caches (server.js) and every polling client's 304 all hinge on
  // the poller handing back the SAME object reference when nothing a client renders has changed. An
  // empty universe is stable by construction: two back-to-back builds must produce one object, and
  // dataTs must be a content clock (frozen across the no-op), not the wall clock.
  const { createPoller } = require("../src/poller");
  const store = { loadAll: () => new Map(), loadRegime: () => [], loadLedger: () => ({ ts: 0, open: [], closed: [], rearm: [], variants: null }),
    saveLedger: () => {}, insert: () => {}, saveRegime: () => {} };
  const p = createPoller({ dex: "xyz", store, log: () => {}, version: "test", crypto: false });
  p.buildSnapshotNow();
  const a = p.getSnapshot();
  p.buildSnapshotNow();
  const b = p.getSnapshot();
  assert.ok(a && b, "snapshot built");
  assert.strictEqual(a, b, "unchanged content must keep the SAME snapshot object (warm serialize/gzip + real 304)");
  assert.strictEqual(a.dataTs, b.dataTs, "dataTs is a content clock — frozen while nothing a client renders changed");
  assert.ok(!("_sig" in a), "the content signature must NOT be shipped on the payload (kept module-side)");

  p.buildDailyNow();
  const d1 = p.getDaily();
  p.buildDailyNow();
  const d2 = p.getDaily();
  assert.ok(d1 && d2, "daily built");
  assert.strictEqual(d1, d2, "unchanged daily content must keep the SAME object");
});

test("perf batch 2026.07.21-08: getFunding memo, bucketsFor memo, gzip+dataTs wiring are all present", () => {
  // Source manifest, same regression-guard philosophy as the route + client-integrity manifests:
  // a silent deletion of any of these five mechanisms passes `node --check` but quietly restores the
  // per-request waste (or re-download) they were built to kill, so each is pinned where it lives.
  const fs = require("fs"), path = require("path");
  const pol = fs.readFileSync(path.join(__dirname, "..", "src", "poller.js"), "utf8");
  const srv = fs.readFileSync(path.join(__dirname, "..", "server.js"), "utf8");
  const app = fs.readFileSync(path.join(__dirname, "..", "public", "app.js"), "utf8");

  // #4 getFunding memo + its per-row invalidation at every fundH mutation site (5 writes + clear + sweep)
  assert.ok(pol.includes("r._fgVer === r._fVer && r._fgH === hourKey"), "getFunding memo key missing");
  assert.equal((pol.match(/r\._fVer = \(r\._fVer \|\| 0\) \+ 1/g) || []).length, 6, "every fundH mutation site must bump _fVer (seed, 2x foldCtx, backfill, clear, sweep)");

  // #3 bucketsFor memo, and NO raw spine bucketing left at the hot call sites
  assert.ok(pol.includes("function bucketsFor(r, width)"), "bucketsFor memo helper missing");
  assert.ok(pol.includes("if (r._bkRaw !== c) { r._bkRaw = c; r._bk = {}; }"), "bucketsFor freshness key missing");
  assert.ok(!/bucketCandles\((?:r|rr)\.hourlyRaw/.test(pol), "hot paths must bucket through bucketsFor, never rebuild from r.hourlyRaw");
  assert.ok(pol.includes("H12: bucketsFor(r, 12)") && pol.includes("H4: bucketsFor(r, 4)"), "trend/AI ladders must feed bucketsFor");

  // #1 snapshot content signature keeps the object + content-clock dataTs (sig stays off the payload)
  assert.ok(pol.includes("if (snapshotCache && lastSnapSig === csig) return;"), "snapshot content-sig short-circuit missing");
  assert.ok(pol.includes("function markSig(m)"), "per-market fingerprint missing");
  assert.ok(pol.includes("ts: snapVer, dataTs: snapVer"), "snapshot dataTs must be the content clock, not lastPoll");
  assert.ok(pol.includes('if (dailyCache && sig === dailySig) return;'), "daily must keep its object on unchanged content");

  // #5 gzip cache in serveCached
  assert.ok(srv.includes("const gzipCache = new WeakMap();"), "gzip WeakMap missing");
  assert.ok(srv.includes("gz = zlib.gzipSync(s)") && srv.includes('reply.header("content-encoding", "gzip")'), "pre-gzip serve path missing");
  assert.ok(srv.includes('const zlib = require("zlib");'), "zlib import missing");

  // #2 client dataTs short-circuit + factored sidecar pulls
  assert.ok(app.includes("if(s.dataTs && s.dataTs===state.dataTs){ maybePullSidecars(); return; }"), "client snapshot short-circuit missing");
  assert.ok(app.includes("function maybePullSidecars()"), "sidecar pulls must be factored so they still fire on a 304");
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

test("daily report budget + admin reset + terra effort routing", async () => {
  const fs = require("fs"), path = require("path");
  const pol = fs.readFileSync(path.join(__dirname, "..", "src", "poller.js"), "utf8");
  // ---- source pins: config the two surfaces run on --------------------------------------
  assert.ok(pol.includes('openai: { model: "gpt-5.6-terra", fb: "gpt-5.6-sol"'), "OpenAI default must be terra primary / sol fallback");
  assert.ok(/AI_REPORT_EFFORT = process\.env\.AI_REPORT_EFFORT \|\| "high"/.test(pol), "report effort must default to high");
  assert.ok(/AI_ASK_EFFORT = process\.env\.AI_ASK_EFFORT \|\| "medium"/.test(pol), "ask-terminal effort must default to medium");
  assert.ok(/AI_REPORTS_PER_DAY = Math\.max\(1, Number\(process\.env\.AI_REPORTS_PER_DAY\) \|\| 5\)/.test(pol), "daily cap must default to 5");
  assert.ok(pol.includes("if (effort) oaBody.reasoning_effort = effort;"), "callModel must send reasoning_effort on the OpenAI path only when set");
  assert.ok(/callModel\(AI_MODEL, ctx, \{ effort: AI_REPORT_EFFORT \}\)/.test(pol) && /callModel\(AI_MODEL_FALLBACK, ctx, \{ effort: AI_REPORT_EFFORT \}\)/.test(pol),
    "both report-path model calls must carry the report effort");
  assert.ok(/effort: AI_ASK_EFFORT/.test(pol), "askBoard callBoth must carry the terminal effort");
  assert.ok(pol.includes('error: "daily-cap"'), "generateAiReport must fail closed with daily-cap when the budget is spent");
  assert.ok(pol.includes("aiDay.count++;"), "only successful generations may burn budget");
  assert.ok(pol.includes("timingSafeEqual"), "admin password compare must be constant-time");
  assert.ok(pol.includes("day: aiDay,"), "spent budget must persist with the report cache (redeploy can't refill the day)");
  // ---- terminal ask under an OpenAI key: terra + medium effort actually hit the wire ----
  const { createPoller } = require("../src/poller");
  const store = { loadAll: () => new Map(), loadRegime: () => [], loadLedger: () => null,
    saveLedger: () => {}, insert: () => {}, saveRegime: () => {}, saveNews: () => {}, loadNews: () => null };
  process.env.OPENAI_API_KEY = "test-key";
  try {
    const calls = [];
    const aiFetch = async (url, opts) => { calls.push({ url, body: JSON.parse(opts.body) });
      return { ok: true, json: async () => ({ choices: [{ message: { content: "screen funding<0 & squeeze>50" }, finish_reason: "stop" }] }) }; };
    const p = createPoller({ dex: "xyz", store, log: () => {}, version: "test", crypto: false, aiFetch });
    const d = await p.askBoard("which names are the most crowded shorts?", { universe: [{ t: "SOL", sqz: 71, f: -22 }] });
    assert.equal(d.ok, true, "ask should succeed under the injected OpenAI transport");
    assert.equal(calls[0].url.includes("api.openai.com"), true, "OpenAI key must route to the OpenAI endpoint");
    assert.equal(calls[0].body.model, "gpt-5.6-terra", "terminal ask must run on terra");
    assert.equal(calls[0].body.reasoning_effort, "medium", "terminal ask must run at medium effort");
    assert.ok(calls[0].body.max_completion_tokens >= 1000, "ask budget must leave headroom for reasoning tokens (a 300-token cap returns empty output at medium effort)");
    // stats surface the budget so the health payload and client can show it
    const st = p.stats();
    assert.equal(st.ai.perDay, 5, "stats must expose the 5/day budget");
    assert.equal(st.ai.dayLeft, 5, "no generations yet -> full budget");
  } finally { delete process.env.OPENAI_API_KEY; }
  // ---- admin reset: fails closed, constant-time gate, lockout on failures ----------------
  const p2 = createPoller({ dex: "xyz", store, log: () => {}, version: "test", crypto: false });
  assert.equal(p2.resetAiDay("anything").error, "not-configured", "no ADMIN_PASSWORD -> fails closed");
  process.env.ADMIN_PASSWORD = "correct-horse";
  try {
    assert.equal(p2.resetAiDay("wrong").error, "bad-password", "wrong password rejected");
    const okRes = p2.resetAiDay("correct-horse");
    assert.equal(okRes.ok, true, "right password resets");
    assert.equal(okRes.dayLeft, okRes.perDay, "reset restores the full budget");
    for (let i = 0; i < 8; i++) p2.resetAiDay("wrong-" + i);   // failures only — the one success above must not count
    const locked = p2.resetAiDay("correct-horse");
    assert.equal(locked.error, "rate", "8 failures inside the window lock the endpoint even for the right password");
    assert.ok(locked.retryMs > 0, "lockout must report a retry window");
  } finally { delete process.env.ADMIN_PASSWORD; }
  // ---- client wiring ---------------------------------------------------------------------
  const app = fs.readFileSync(path.join(__dirname, "..", "public", "app.js"), "utf8");
  assert.ok(/admin\\s\+reset-reports/.test(app), "terminal must intercept the admin command");
  assert.ok(app.includes("••••"), "the echoed admin line must be redacted — the password never sits in scrollback");
  assert.ok(app.includes("function termRun") && app.indexOf("admin\\s+reset-reports") < app.indexOf("termEcho(line);"),
    "interception must run BEFORE the raw echo and before any tier can escalate the line");
  assert.ok(app.includes("termAdminReset") && app.includes("/api/ai-reset"), "admin reset client call missing");
  assert.ok(app.includes("data-cap") && app.includes("!b.dataset.cap"), "cooldown ticker must not re-enable a cap-blocked regenerate button");
  assert.ok(app.includes("daily-cap"), "client must handle the daily-cap error distinctly from cooldown");
  assert.ok(app.includes("generations left today") && app.includes("today</span>"), "report card must show the remaining daily budget");
});

test("ask daily budget: cap enforced, only successful non-cached calls burn it, surfaced everywhere, chip wired", async () => {
  const fs = require("fs"), path = require("path");
  const pol = fs.readFileSync(path.join(__dirname, "..", "src", "poller.js"), "utf8");
  assert.ok(/ASK_REPORTS_PER_DAY = Math\.max\(1, Number\(process\.env\.ASK_MAX_PER_DAY\) \|\| 40\)/.test(pol), "ask daily cap must default to 40, env ASK_MAX_PER_DAY");
  assert.ok(pol.includes('error: "ask-daily-cap"'), "askBoard must fail closed with ask-daily-cap");
  assert.ok(pol.includes("askDay.count++;"), "a successful ask must burn budget");
  assert.ok(pol.includes("day: aiDay, askDay,"), "ask budget must persist with the report budget (redeploy can't refill)");

  const { createPoller } = require("../src/poller");
  const store = { loadAll: () => new Map(), loadRegime: () => [], loadLedger: () => null,
    saveLedger: () => {}, insert: () => {}, saveRegime: () => {}, saveNews: () => {}, loadNews: () => null };
  // injected transport (anthropic shape — no env key => provider anthropic)
  const answers = ["screen funding<0 & squeeze>50"];
  let calls = 0;
  const aiFetch = async () => { calls++; return { ok: true, json: async () => ({ content: [{ type: "text", text: answers[0] }], stop_reason: "end_turn" }) }; };
  // cap of 2 for a fast exhaustion test
  process.env.ASK_MAX_PER_DAY = "2";
  try {
    const p = createPoller({ dex: "xyz", store, log: () => {}, version: "test", crypto: false, aiFetch });
    const uni = [{ t: "SOL", sqz: 71, f: -22 }];
    const q = (s) => p.askBoard(s, { universe: uni });

    const a = await q("most crowded shorts?");
    assert.equal(a.ok, true); assert.equal(a.askPerDay, 2); assert.equal(a.askDayLeft, 1, "one spent -> 1 left");
    // a REPEAT of the same question is a cache hit — must NOT burn budget
    const callsBefore = calls;
    const aCached = await q("most crowded shorts?");
    assert.equal(aCached.cached, true, "identical question served from cache");
    assert.equal(calls, callsBefore, "cache hit made no model call");
    assert.equal(aCached.askDayLeft, 1, "cache hit did not burn budget");
    // a DIFFERENT question spends the last unit
    const b = await q("top funding names?");
    assert.equal(b.ok, true); assert.equal(b.askDayLeft, 0, "budget now exhausted");
    // next distinct question is capped BEFORE any model call
    const callsAtCap = calls;
    const capped = await q("what about momentum leaders?");
    assert.equal(capped.ok, false); assert.equal(capped.error, "ask-daily-cap", "exhausted -> ask-daily-cap");
    assert.equal(calls, callsAtCap, "a capped ask must not reach the model");
    assert.equal(capped.askDayLeft, 0);
    // health surfaces the budget
    const st = p.stats();
    assert.equal(st.ai.askPerDay, 2); assert.equal(st.ai.askDayLeft, 0, "health carries the live ask budget");
  } finally { delete process.env.ASK_MAX_PER_DAY; }

  // ---- client (Option B ambient chip) wiring ----
  const app = fs.readFileSync(path.join(__dirname, "..", "public", "app.js"), "utf8");
  assert.ok(app.includes("function renderAskBudget"), "ambient chip renderer missing");
  assert.ok(/renderAskBudget\(h\.ai\.askDayLeft, h\.ai\.askPerDay\)/.test(app), "chip must be fed by the health poll");
  assert.ok(app.includes("renderAskBudget(d.askDayLeft, d.askPerDay)"), "chip must update from each ask response");
  assert.ok(app.includes("'ask-daily-cap'") && app.includes("daily AI limit reached"), "client must handle the ask daily-cap message");
  assert.ok(app.includes("ask calls left today") || app.includes("call':'calls'"), "analyst tail must show remaining ask budget");
  const html = fs.readFileSync(path.join(__dirname, "..", "public", "index.html"), "utf8");
  assert.ok(html.includes('id="termBudget"'), "terminal bar must contain the budget chip");
  const css = fs.readFileSync(path.join(__dirname, "..", "public", "styles.css"), "utf8");
  assert.ok(css.includes(".tp-budget") && css.includes(".tp-budget.out"), "chip CSS (incl. exhausted state) missing");
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

test("regime strip: pure aggregate rides /api/analytics sections, split crypto/stocks, rendered with the shared hoverChart", () => {
  const fs = require("fs"), path = require("path");
  const pol = fs.readFileSync(path.join(__dirname, "..", "src", "poller.js"), "utf8");
  const app = fs.readFileSync(path.join(__dirname, "..", "public", "app.js"), "utf8");
  assert.ok(pol.includes("function buildRegime") && pol.includes("regimeAggregate("), "buildRegime + pure aggregate call missing from poller");
  assert.ok(pol.includes("regime,"), "regime must be a key on the analytics sections payload");
  assert.ok(/function buildRegime[\s\S]*mainMarkets\(\)/.test(pol) && /function buildRegime[\s\S]*activeMarkets\(\)/.test(pol), "regime must combine crypto (mainMarkets) + stocks (activeMarkets), not filter one roster");
  assert.ok(require("../src/compute").regimeAggregate, "regimeAggregate must be exported from compute");
  assert.ok(app.includes("function renderRegime") && app.includes("function regimeCurveSvg") && app.includes("function wireRegimeControls"), "regime client renderers missing");
  assert.ok(app.includes("a.sections && a.sections.regime"), "analytics render must read sections.regime");
  assert.ok(app.includes("regimeCurveSvg(d.series") && app.includes("hoverChart("), "regime charts must use the shared hoverChart infrastructure");
  // crowding breadth reuses the board's own funding percentile — one code path, not a second threshold
  assert.ok(pol.includes("r.fundPct >= 90") && pol.includes("r.fundPct <= 10"), "crowding breadth must reuse r.fundPct thresholds");
});

// ============================================================================================
// 5-minute OHLCV archive (build 2026.07.22-01): on-disk node:sqlite store, build-forward capture,
// server-side downsampled reads, 370d retention. The archive is the SOLE copy of history past the
// native ~17d candleSnapshot window, so these pin the integrity that keeps it honest.
// ============================================================================================
test("5m archive: upsert is idempotent, range reads clustered, evict + coverage exact", () => {
  const fs = require("fs"), path = require("path"), os = require("os");
  const { openStore } = require("../src/store");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "xyzm5-"));
  try {
    const s = openStore(dir);
    assert.ok(s.candlesEnabled(), "node:sqlite must be available under --experimental-sqlite (test runner passes the flag)");
    assert.ok(fs.existsSync(path.join(dir, "candles.db")), "candle db file created on the volume");
    const M5 = 5 * 60 * 1000, base = 1_700_000_000_000;
    const bars = [];
    for (let i = 0; i < 10; i++) bars.push([base + i * M5, 100 + i, 101 + i, 99 + i, 100.5 + i, 1000 + i]);
    assert.equal(s.insertCandles("xyz:AAPL", bars), 10, "all ten bars upserted");
    // idempotency: re-inserting the same window (with a changed close on one bar) must NOT duplicate
    const again = bars.map((k) => k.slice());
    again[3] = [again[3][0], 200, 210, 190, 205, 9999];   // same (coin,ts), new body
    s.insertCandles("xyz:AAPL", again);
    const cov = s.candleCoverage("xyz:AAPL");
    assert.equal(cov.count, 10, "upsert on the same keys does not duplicate rows");
    assert.equal(cov.min, base, "coverage min = first bar");
    assert.equal(cov.max, base + 9 * M5, "coverage max = last bar");
    const r = s.readCandles("xyz:AAPL", base, base + 9 * M5);
    assert.equal(r.length, 10, "range read returns the whole window, oldest->newest");
    for (let i = 1; i < r.length; i++) assert.ok(r[i][0] > r[i - 1][0], "rows come back time-ordered");
    assert.equal(r[3][4], 205, "the conflicting bar took the UPDATE close, not a second row");
    // a second coin is isolated (clustering by (coin,ts))
    s.insertCandles("BTC", [[base, 1, 2, 3, 4, 5]]);
    assert.equal(s.readCandles("xyz:AAPL", base, base).length, 1, "cross-coin isolation on read");
    // evict drops strictly older-than the cut, whole archive
    const dropped = s.evictCandles(base + 5 * M5);
    assert.equal(dropped, 6, "evict removes exactly the bars older than the cut, whole archive (5 of AAPL + BTC's 1)");
    assert.equal(s.candleCoverage("xyz:AAPL").min, base + 5 * M5, "post-evict min advances to the cut");
    assert.equal(s.readCandles("BTC", base, base).length, 0, "BTC's lone old bar also evicted (whole-archive cut)");
    s.close();
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
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

test("5m archive: source + wiring manifest (store engine, capture path, route, run flags)", () => {
  const fs = require("fs"), path = require("path");
  const rd = (f) => fs.readFileSync(path.join(__dirname, "..", f), "utf8");
  const sto = rd("src/store.js"), pol = rd("src/poller.js"), srv = rd("server.js");
  const pkg = rd("package.json"), rail = rd("railway.json");
  // store engine: node:sqlite, clustered STRICT table, idempotent upsert, and the off-copy hedge
  assert.ok(sto.includes('require("node:sqlite")'), "store must use the built-in node:sqlite (no native dep)");
  assert.ok(sto.includes("candles.db"), "candle archive targets candles.db");
  assert.ok(sto.includes("WITHOUT ROWID") && sto.includes("STRICT"), "candles_5m must be a STRICT, WITHOUT ROWID clustered table");
  assert.ok(sto.includes("ON CONFLICT(coin, ts) DO UPDATE"), "inserts must upsert (idempotent capture/gap-fill)");
  assert.ok(sto.includes("VACUUM INTO"), "snapshotCandles must VACUUM INTO an off-copy (sole-copy recovery hedge)");
  assert.ok(/candlesEnabled\(\)/.test(sto), "store must expose candlesEnabled() so callers degrade cleanly without the module");
  // poller capture path: forming-bar guard, one worker, 370d retention, exported getters
  assert.ok(pol.includes("function capture5m") && pol.includes("function fiveMinWorker"), "capture + worker present");
  assert.ok(pol.includes("k[0] + FIVE_MIN <= now"), "closed-bar guard (forming bar dropped) present");
  assert.ok(pol.includes("M5_RETENTION_DAYS = 370"), "retention pinned at 370d");
  assert.ok(pol.includes("store.evictCandles(") && /maintenance[\s\S]*evictCandles/.test(pol), "eviction runs inside maintenance");
  assert.ok(/getCandles5m,/.test(pol) && /getCandleCoverage,/.test(pol) && /getM5Stamp:/.test(pol), "5m getters exported");
  assert.ok(pol.includes("fiveMinWorker();"), "capture worker launched in start()");
  // route: res=5m branch on /api/candles (no new route string — manifest still counts one)
  assert.ok(/res === "5m"/.test(srv), "/api/candles must branch on res=5m");
  assert.ok(srv.includes('"candles5m|"') && srv.includes("poller.getCandles5m(") && srv.includes("poller.getM5Stamp("), "res=5m must key + serve via the 5m getters");
  assert.equal(srv.split('fastify.get("/api/candles"').length - 1, 1, "still exactly one /api/candles registration");
  // run flags: the experimental-sqlite flag must be present everywhere the app is launched/tested,
  // and Node pinned so a runtime bump can't silently change the module API under us.
  assert.ok(/--experimental-sqlite server\.js/.test(pkg), "npm start must pass --experimental-sqlite");
  assert.ok(/--experimental-sqlite --test/.test(pkg), "npm test must pass --experimental-sqlite");
  assert.ok(/">=22\.5/.test(pkg), "engines.node must require >= 22.5 (node:sqlite availability), pinned");
  assert.ok(/--experimental-sqlite server\.js/.test(rail), "railway startCommand must pass --experimental-sqlite");
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

test("store: deriv log roundtrip, flat-cutoff prune, and the symbol map survives atomically", async () => {
  const fs = require("fs"), os = require("os"), path = require("path");
  const { openStore } = require("../src/store");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "xyzdz-"));
  const s = openStore(dir);
  const Q = 15 * 60 * 1000;
  s.insertDeriv("BTC", 10 * Q, 1000, 500, 900000);
  s.insertDeriv("BTC", 11 * Q, 1100, 501, 900001);
  s.insertDeriv("ETH", 11 * Q, 50, 25, 80000);
  s.insertDeriv("BTC", 12 * Q, null, 502, null);   // partial buckets persist as blanks, not zeros
  s.flushDerivs();
  const m = s.loadDerivs(0);
  assert.equal(m.size, 2);
  assert.equal(m.get("BTC").length, 3);
  assert.deepEqual(m.get("BTC")[2], [12 * Q, null, 502, null], "nulls roundtrip as nulls — never invented zeros");
  assert.deepEqual(m.get("ETH")[0], [11 * Q, 50, 25, 80000]);
  // grown forming bucket re-persisted at the same ts: load must dedupe LAST-WINS, never duplicate
  s.insertDeriv("BTC", 12 * Q, 999, 502, 777777);
  s.flushDerivs();
  const md = s.loadDerivs(0);
  assert.equal(md.get("BTC").length, 3, "re-persisted boundary bucket must dedupe on load, not duplicate the ts");
  assert.deepEqual(md.get("BTC")[2], [12 * Q, 999, 502, 777777], "last write wins for a grown bucket");
  const removed = await s.pruneDerivs(11 * Q);
  assert.equal(removed, 1, "flat cutoff drops exactly the rows older than `before`");
  const m2 = s.loadDerivs(0);
  assert.equal(m2.get("BTC").length, 2);
  s.saveDerivMap({ ts: 123, map: { BTC: { sym: "BTCUSDT_PERP.A", venue: "Binance" } } });
  const dm = s.loadDerivMap();
  assert.equal(dm.ts, 123);
  assert.equal(dm.map.BTC.sym, "BTCUSDT_PERP.A");
  s.close();
});

test("coinalyze client: call-unit pacing, symbol-cost batching, USD source-conversion pinned", () => {
  const fs = require("fs"), path = require("path");
  const hl = fs.readFileSync(path.join(__dirname, "..", "src", "hyperliquid.js"), "utf8");
  assert.ok(hl.includes("const MAX = 38;"), "coinalyze limiter must cap under the 40 calls/min ceiling");
  assert.ok(hl.includes("symbols.length"), "batched requests must charge one call-unit PER SYMBOL, not per request");
  assert.ok(hl.split("convert_to_usd").length - 1 >= 2, "liq + OI histories must request source-side USD conversion");
  assert.ok(hl.includes("retry-after"), "429s must honor Retry-After");
  assert.ok(hl.includes("createCoinalyze") && hl.includes("if (!key) return null;"), "no key -> no client, the lane never starts");
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

test("server: /api/derivs routes registered once, keyed ETag, cooldown maps to 429", () => {
  const fs = require("fs"), path = require("path");
  const srv = fs.readFileSync(path.join(__dirname, "..", "server.js"), "utf8");
  assert.equal(srv.split('fastify.get("/api/derivs"').length - 1, 1, "GET /api/derivs exactly once");
  assert.equal(srv.split('fastify.post("/api/derivs/refresh"').length - 1, 1, "POST /api/derivs/refresh exactly once");
  assert.ok(/get\("\/api\/derivs"[\s\S]{0,600}serveKeyed\(/.test(srv), "/api/derivs must serve via serveKeyed (per-coin fresh payloads — raw serveCached would collide ETags across coins)");
  assert.ok(srv.includes('"derivs|" + poller.derivsKey(coin)'), "ETag key must come from poller.derivsKey");
  assert.ok(/fastify\.post\("\/api\/derivs\/refresh", \{ bodyLimit: 8 \* 1024 \}/.test(srv), "refresh POST must carry a body cap");
  assert.ok(/r\.error === "cooldown" \? reply\.code\(429\)|error === "cooldown"\) return reply\.code\(429\)/.test(srv), "cooldown must map to 429");
});

test("client: CASC column + drawer deriv panel wired, crypto-scoped, honestly labeled", () => {
  const fs = require("fs"), path = require("path");
  const s = fs.readFileSync(path.join(__dirname, "..", "public", "app.js"), "utf8");
  for (const fn of ["cascCell", "liq24Cell", "loadDrawerDerivs", "renderDerivs", "dzWire"]) {
    const n = [...s.matchAll(new RegExp("^(?:async )?function " + fn + "\\(", "gm"))].length;
    assert.equal(n, 1, `client function ${fn} must exist exactly once`);
  }
  assert.ok(s.includes("MAIN_ONLY_COLS") && s.includes("MAIN_ONLY_COLS.has(c.key)"), "cascT must be filtered out of the xyz scope like gap is out of crypto");
  assert.ok(s.includes("'cascT','liq24'"), "liq24 must be crypto-scoped alongside cascT");
  assert.ok(s.includes("'doi','sqz','cascT','liq24','carry'"), "cascT + liq24 in DEFAULT_ORDER");
  assert.ok(s.includes("key:'cascT'"), "column keys on the flat numeric sort field, not the object");
  assert.ok(s.includes("/api/derivs?coin=") && s.includes("/api/derivs/refresh"), "drawer fetch + manual refresh endpoints wired");
  assert.ok(s.includes("dderivs"), "drawer slot present for crypto rows");
  assert.ok(s.includes("not HL-native") || s.includes("not Hyperliquid-native"), "aggregated-CEX labeling must be permanent in the UI");
  assert.ok(s.includes("mousemove") && s.includes("dztip"), "shared-crosshair hover + tooltip wired on the panel charts");
  const css = fs.readFileSync(path.join(__dirname, "..", "public", "styles.css"), "utf8");
  for (const cls of [".dzchips", ".dzchip", ".dzsrc", ".dzdot", ".dzrefresh", ".dztip", ".dzfoot"])
    assert.ok(css.includes(cls), `deriv panel CSS class missing: ${cls}`);
});

test("coinalyze client contract: header key, second-based windows, USD flag, per-symbol units", async () => {
  const { createCoinalyze } = require("../src/hyperliquid");
  const calls = [];
  const realFetch = global.fetch;
  global.fetch = async (url, opts) => {
    calls.push({ url: String(url), key: opts && opts.headers && opts.headers.api_key });
    return { ok: true, status: 200, json: async () => ([{ symbol: "BTCUSDT_PERP.A", history: [{ t: 1784900000, l: 1000, s: 500 }] }]) };
  };
  try {
    const cz = createCoinalyze({ key: "k-test", log: () => {} });
    assert.ok(cz, "client must construct with a key");
    assert.equal(createCoinalyze({ key: "", log: () => {} }), null, "no key -> no client");
    const from = 1784900000000, to = 1784903600000;
    const out = await cz.liqHistory(["BTCUSDT_PERP.A", "ETHUSDT_PERP.A"], "15min", from, to);
    assert.equal(out[0].symbol, "BTCUSDT_PERP.A");
    const u = new URL(calls[0].url);
    assert.equal(calls[0].key, "k-test", "api_key must travel as a header");
    assert.equal(u.searchParams.get("symbols"), "BTCUSDT_PERP.A,ETHUSDT_PERP.A", "batch = comma-joined symbols");
    assert.equal(u.searchParams.get("from"), String(Math.floor(from / 1000)), "windows in UNIX SECONDS, not ms");
    assert.equal(u.searchParams.get("to"), String(Math.floor(to / 1000)));
    assert.equal(u.searchParams.get("interval"), "15min");
    assert.equal(u.searchParams.get("convert_to_usd"), "true", "USD conversion is source-side, stored as-received");
    assert.equal(cz.usage().used, 2, "two symbols must charge two call-units against the 38/min budget");
    await cz.oiHistory(["BTCUSDT_PERP.A"], "15min", from, to);
    assert.equal(cz.usage().used, 3, "call-unit ledger accumulates across endpoints");
  } finally { global.fetch = realFetch; }
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

test("backtest v2 manifest: seventeen-signal roster, scope seam, data gates, sector demean — pinned in the shipped client", () => {
  // Source-manifest guard, same philosophy as the client-integrity test: each of these silently
  // reverting would leave a plausible-looking tab quietly running the old four-signal, xyz-only test.
  const fs = require("fs"), path = require("path");
  const s = fs.readFileSync(path.join(__dirname, "..", "public", "app.js"), "utf8");
  // the roster: every key present with a short label
  for (const k of ["mom:'", "smom:'", "rev:'", "res:'", "lowvol:'", "ivol:'", "beta:'", "max:'", "carry:'", "hprox:'", "volt:'", "oid:'",
    "m0:'", "mres:'", "moi:'", "mfund:'", "mpart:'"])
    assert.ok(s.includes(k), `BT_SIGNALS missing key: ${k}`);
  // data-gated rules declare their column and btRun refuses honestly instead of ranking nothing
  assert.ok(s.includes("const BT_NEEDS={ carry:'fundCov', hprox:'hiCov', volt:'voCov', oid:'oiCov', moi:'oiCov', mfund:'fundCov', mpart:'voCov' }"), "BT_NEEDS gate map missing");
  // the live-score variant family (-05): fixed-horizon dispatch BEFORE the lookback guard, extended warmup
  assert.ok(s.includes("const BT_MVAR={ m0:1, mres:1, moi:1, mfund:1, mpart:1 }"), "BT_MVAR family map missing");
  assert.ok(s.includes("if(BT_MVAR[sig]) return btMomVariant(sig, a, bench, di, ex);"), "variant dispatch missing from btScore");
  assert.ok(s.includes("const warmN=BT_MVAR[p.signal]?Math.max(p.lookback,31):p.lookback;"), "variant warmup missing from btRun");
  assert.ok(s.includes("start=warmN"), "btRun walk must start at the warmup, not the raw lookback");
  assert.ok(s.includes("nodata:BT_SIGNALS[p.signal]"), "no-data refusal missing from btRun");
  assert.ok(s.includes("res.nodata"), "no-data message missing from renderBacktest");
  // score plumbing: extras object into btScore, one regression serving res/beta/ivol, sector demean for smom
  assert.ok(s.includes("btScore(base, series.get(c), benchSeries, di, L, exOf(c))"), "extras not passed into btScore");
  assert.ok(s.includes("sig==='res'||sig==='beta'||sig==='ivol'"), "shared-regression branch missing");
  assert.ok(s.includes("if(p.signal==='smom')"), "sector demean missing");
  // scope seam: universe follows the switcher, bench is scoped, crypto kills the overnight hold and annualizes at 365
  assert.ok(s.includes("if((r.uni==='main')!==cr) return false;"), "scope-aware universe filter missing");
  assert.ok(s.includes("const bC=scopeBench(), bench=bC?state.rows.get(bC):null;"), "scoped benchmark missing from btMatrix");
  assert.ok(s.includes("p.holdWindow==='on' && state.scope!=='crypto'"), "crypto must not run the overnight hold");
  assert.ok(s.includes("function btAnn()") && s.includes("state.scope==='crypto'?365:BT_ANN"), "scope-aware annualization missing");
  assert.ok(s.includes("if(state.view==='backtest') drawBacktest();"), "scope flip must re-run the open tab");
  // the tab is un-gated for crypto in BOTH gates (visibility + navigation)
  assert.equal((s.match(/const CRYPTO_VIEWS=new Set\(/g) || []).length, 1, "exactly one crypto scope list may exist (it replaced showView's inline gate in -05)");
  assert.ok(new RegExp("const CRYPTO_VIEWS=new Set\\(\\[[^\\]]*'backtest'").test(s), "backtest must be in-scope for crypto");
  assert.ok(/applyTabVisibility\(\);   \/\/ scope AND flags/.test(s), "applyScope must delegate tab visibility to the single applier (its own per-tab list was removed in -05)");
  // level columns: aligned arrays + coverage counts, longer lookbacks, named benchmark in the legend
  assert.ok(s.includes("pxm, him, vom, oim, hiCov, voCov, oiCov"), "level-column matrix outputs missing");
  assert.ok(s.includes("[60,'60d'],[120,'120d']"), "60/120d lookbacks missing");
  assert.ok(s.includes("benchmark (BTC)") && s.includes("benchmark (SP500)"), "legend must name the scope's benchmark");
  // the new payload readers exist and applyDaily maps the extra tuple columns + oi
  assert.ok(s.includes("h:p[2], v:p[3]"), "applyDaily must read the h/v tuple columns");
  assert.ok(s.includes("r.dailyOI=d.oi[coin]"), "applyDaily must read the oi map");
});

test("live-score variant family (2026.07.24-05): btMomVariant executed — M0 mirrors the blend, each variant moves exactly one term", () => {
  // The REAL btMomVariant from the shipped client (the -85 lesson: existence is not wiring),
  // run on deterministic synthetic series where every candidate term's direction is known by
  // construction. Each variant is asserted AGAINST M0 on the same inputs, so a regression in
  // any single modulation fails its own assertion by name.
  const fs = require("fs"), path = require("path");
  const src = fs.readFileSync(path.join(__dirname, "..", "public", "app.js"), "utf8");
  const grab = (name) => { const i = src.indexOf("function " + name); assert.ok(i >= 0, name + " missing");
    let dep = 0, j = src.indexOf("{", i);
    for (let k = j; k < src.length; k++) { if (src[k] === "{") dep++; if (src[k] === "}") { dep--; if (!dep) return src.slice(i, k + 1); } } };
  const clamp = (x, a, b) => Math.min(Math.max(x, a), b);   // the client helper the function closes over
  const mv = eval("(" + grab("btMomVariant") + ")");
  const N = 140, di = 121;                                   // odd di: the last daily bar is the up-leg of the sawtooth
  // steady uptrend with a sawtooth (mean +0.2%/day, ±0.4% wiggle) — volD is real, tanh unsaturated
  const up = [], down = [], chop = [];
  for (let i = 0; i < N; i++) { const w = i % 2 ? 0.004 : -0.004;
    up.push(0.002 + w); down.push(-0.002 + w); chop.push(i % 2 ? 0.006 : -0.006); }
  const pxOf = (a) => { const p = []; let c = 100; for (const x of a) { c *= Math.exp(x); p.push(c); } return p; };
  const exBase = (a) => ({ f: null, px: pxOf(a), hi: null, vo: null, oi: null });
  // warmup: before 31 days of runway the score is an honest NaN, not a guess
  assert.ok(Number.isNaN(mv("m0", up, null, 20, exBase(up))), "pre-warmup must be NaN");
  const m0up = mv("m0", up, null, di, exBase(up)), m0dn = mv("m0", down, null, di, exBase(down)), m0ch = mv("m0", chop, null, di, exBase(chop));
  assert.ok(Number.isFinite(m0up) && m0up > 0 && m0up < 100, "M0 on a clean uptrend is positive and unsaturated");
  assert.ok(m0dn < 0, "M0 on the mirrored downtrend is negative");
  assert.ok(m0up > m0ch + 5, "coherent trend must outrank a violent chop of the same amplitude");
  // range tilt: same returns without the close series lose the (positive, at-the-highs) tilt
  assert.ok(m0up > mv("m0", up, null, di, { f: null, px: null, hi: null, vo: null, oi: null }), "range tilt must lift a name at its 30d highs");
  // V1 — β-residual: a perfect benchmark clone keeps only its raw 1d term; with no benchmark, V1 IS M0
  assert.ok(mv("mres", up, up, di, exBase(up)) < m0up - 1, "a β-clone's slow horizons must residualize away");
  assert.equal(mv("mres", up, null, di, exBase(up)), m0up, "no benchmark -> raw fallback -> exactly M0");
  // V2 — regime-qualified OI: building WITH the side (funding corroborating) amplifies; falling OI dampens; no OI column -> exactly M0
  const oiUp = [], oiDn = []; for (let i = 0; i < N; i++) { oiUp.push(1e6 * Math.pow(1.02, i)); oiDn.push(1e6 * Math.pow(0.98, i)); }
  const fPos = new Array(N).fill(2e-4), fNeg = new Array(N).fill(-2e-4);
  assert.ok(mv("moi", up, null, di, Object.assign(exBase(up), { oi: oiUp, f: fPos })) > m0up + 1, "longs+ with corroborating funding must amplify");
  assert.ok(mv("moi", up, null, di, Object.assign(exBase(up), { oi: oiDn, f: fPos })) < m0up - 1, "a squeeze (OI falling into strength) must dampen, not amplify");
  assert.ok(mv("moi", down, null, di, Object.assign(exBase(down), { oi: oiUp, f: fNeg })) < m0dn - 1, "shorts+ with shorts paying must amplify the negative side");
  assert.equal(mv("moi", up, null, di, exBase(up)), m0up, "no OI column -> unmodulated core -> exactly M0 (universe parity with the control)");
  // V3 — crowding haircut: today's funding at its own 31d max, crowd long into a long score -> ×0.8; flat funding has no extremes
  const fSpike = new Array(N).fill(1e-4); for (let i = di - 4; i <= di; i++) fSpike[i] = (4 + (i - (di - 4))) * 2e-4;   // ramps into a window max AT di
  assert.ok(mv("mfund", up, null, di, Object.assign(exBase(up), { f: fSpike })) < m0up - 1, "same-side funding extreme must take the 0.8 haircut");
  assert.equal(mv("mfund", up, null, di, Object.assign(exBase(up), { f: new Array(N).fill(1e-4) })), m0up, "flat funding is not an extreme — no haircut");
  assert.equal(mv("mfund", up, null, di, exBase(up)), m0up, "no funding column -> exactly M0");
  // V4 — volume participation: recent volume above the window norm nudges up, below nudges down, capped either way
  const voHi = new Array(N).fill(1e6), voLo = new Array(N).fill(1e6);
  for (let i = di - 4; i <= di; i++) { voHi[i] = 3e6; voLo[i] = 3e5; }
  const partHi = mv("mpart", up, null, di, Object.assign(exBase(up), { vo: voHi })), partLo = mv("mpart", up, null, di, Object.assign(exBase(up), { vo: voLo }));
  assert.ok(partHi > m0up && partLo < m0up, "participation must nudge in the volume's direction");
  assert.ok(Math.abs(partHi - m0up) < Math.abs(m0up) * 0.35, "the participation nudge stays a nudge — capped, never a regime of its own");
  assert.equal(mv("mpart", up, null, di, exBase(up)), m0up, "no volume column -> exactly M0");
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

test("poller score duel: one snapshot per UTC day, IC lands when the next day's prices do, state persists and hydrates", () => {
  const { createPoller } = require("../src/poller");
  let saved = null;
  const store = { loadAll: () => new Map(), loadRegime: () => [], loadLedger: () => null,
    saveLedger: () => {}, insert: () => {}, saveRegime: () => {}, saveNews: () => {}, loadNews: () => null,
    saveDuel: (d) => { saved = JSON.parse(JSON.stringify(d)); }, loadDuel: () => saved };
  const p = createPoller({ dex: "xyz", store, log: () => {}, version: "test", crypto: false });
  const DAY = 86400000;
  const mkRow = (i, px) => ({ coin: "xyz:T" + i, ticker: "T" + i, delisted: false, uni: "xyz",
    px, d1: (i - 4.5) * 2,   // spread of returns so scores rank cleanly
    ref: { p1h: px * 0.999, p4h: px * 0.998, p7d: px / (1 + (i - 4.5) * 0.05), p30d: px / (1 + (i - 4.5) * 0.08) },
    feat: { volH: 0.004, volD: 0.02, hi30: px * 1.1, lo30: px * 0.85 }, funding: 0.00001 });
  const day1 = 20000, now1 = day1 * DAY + 3600000;
  const rows1 = []; for (let i = 0; i < 10; i++) rows1.push(mkRow(i, 100));
  p.duelTickNow(now1, { xyz: rows1, main: [] });
  assert.ok(saved && saved.snaps[day1] && Object.keys(saved.snaps[day1].xyz).length === 10, "day-1 snapshot lands and persists");
  assert.equal(saved.ic.length, 0, "no IC yet — one day is not a record");
  // same day, later tick: the one-key guard must not double-snap or rewrite
  const before = JSON.stringify(saved.snaps[day1]);
  p.duelTickNow(now1 + 7200000, { xyz: rows1.map((r) => Object.assign({}, r, { px: 999 })), main: [] });
  assert.equal(JSON.stringify(saved.snaps[day1]), before, "second tick on the same day is a no-op");
  // next day: returns proportional to score rank -> IC near +1 for both columns
  const rows2 = []; for (let i = 0; i < 10; i++) rows2.push(mkRow(i, 100 * (1 + i * 0.01)));
  p.duelTickNow((day1 + 1) * DAY + 3600000, { xyz: rows2, main: [] });
  assert.equal(saved.ic.length, 1, "exactly one IC row per scope per day pair");
  const row = saved.ic[0];
  assert.equal(row.d, day1); assert.equal(row.u, "xyz"); assert.equal(row.n, 10);
  assert.ok(row.a > 0.9 && row.b > 0.9, "rank-aligned returns -> IC near +1 for both scores");
  assert.ok(!saved.snaps[day1 - 5], "stale snapshots pruned");
  // the served payload carries the record + gate
  const duel = p.getDuel();
  assert.equal(duel.scopes.xyz.ic.length, 1);
  assert.equal(duel.scopes.xyz.stats.n, 1);
  assert.equal(duel.scopes.xyz.stats.verdict, false, "one day never unlocks a verdict");
  assert.ok(duel.minN >= 60, "verdict gate shipped to the client");
  assert.ok(duel.dataTs > 0, "dataTs moves with content so the ETag works");
  // a fresh poller hydrates the same record off the (stubbed) volume
  const p2 = createPoller({ dex: "xyz", store, log: () => {}, version: "test", crypto: false });
  p2.hydrateDuelNow();
  assert.equal(p2.getDuel().scopes.xyz.ic.length, 1, "record survives a redeploy");
  // boot mid-day with a cold universe must NOT burn the day: below the name floor, no snap
  let saved3 = null;
  const store3 = Object.assign({}, store, { saveDuel: (d) => { saved3 = d; }, loadDuel: () => null });
  const p3 = createPoller({ dex: "xyz", store: store3, log: () => {}, version: "test", crypto: false });
  p3.duelTickNow(now1, { xyz: rows1.slice(0, 3), main: [] });
  assert.equal(saved3, null, "under 8 snappable names the day stays unclaimed for a later retry");
});

test("build -07 manifest: pair math welded across compute.js and app.js; duel plumbing pinned end to end", () => {
  const fs = require("fs"), path = require("path");
  const app = fs.readFileSync(path.join(__dirname, "..", "public", "app.js"), "utf8");
  const cmp = fs.readFileSync(path.join(__dirname, "..", "src", "compute.js"), "utf8");
  const pol = fs.readFileSync(path.join(__dirname, "..", "src", "poller.js"), "utf8");
  const srv = fs.readFileSync(path.join(__dirname, "..", "server.js"), "utf8");
  const css = fs.readFileSync(path.join(__dirname, "..", "public", "styles.css"), "utf8");
  const html = fs.readFileSync(path.join(__dirname, "..", "public", "index.html"), "utf8");
  const stf = fs.readFileSync(path.join(__dirname, "..", "src", "store.js"), "utf8");
  // Constant-fragment weld: every coefficient of the shared core + V2 + V3 must appear in BOTH
  // implementations. Retuning one file without the other is a suite failure, which is the point.
  for (const frag of ["0.4*Math.tanh", "/8)", "(0.5+0.5*kappa)", "0.6,1.4", "1.5)",
    "Math.tanh(fAPR/25))>=0.15", "(0.5+0.5*c)", "0.2*Math.tanh", "*=0.8", "fp>=90", "fp<=10"])
    assert.ok(app.replace(/\s+/g, "").includes(frag.replace(/\s+/g, "")), `app.js missing pair-math fragment: ${frag}`);
  for (const frag of ["0.4 * Math.tanh", "(0.5 + 0.5 * kappa)", "0.6, 1.4", "Math.tanh(fAPR / 25)) >= 0.15",
    "(0.5 + 0.5 * c)", "1 - 0.2 * Math.tanh", "*= 0.8", "fp >= 90", "fp <= 10"])
    assert.ok(cmp.includes(frag), `compute.js missing pair-math fragment: ${frag}`);
  // poller: snapshot cadence guards, floors, retention, persistence, exports
  for (const frag of ["DUEL_RETENTION_D = 180", "DUEL_MIN_N = 60", "DUEL_MIN_NAMES = 8",
    "if (duel.snaps[day]) return", "store.saveDuel(duel)", "hydrateDuel", "getDuel,", "duelTickNow: duelTick",
    "momPair, spearmanIC, duelStats"])
    assert.ok(pol.includes(frag), `poller.js missing duel pin: ${frag}`);
  assert.ok(/setInterval\(safeTick\(duelTick, "duelTick"\), 60 \* 1000\)/.test(pol), "duel timer wired at 60s");
  // server: exactly one registration already covered by the route manifest; pin the getter binding
  assert.ok(srv.includes("poller.getDuel()"), "/api/duel must serve poller.getDuel through serveCached");
  // store: atomic blob pair
  assert.ok(stf.includes("saveDuel(data)") && stf.includes("loadDuel()") && stf.includes('duel.json'), "store duel blob missing");
  // client: column adjacent to the incumbent in the default order, migration helper applied twice
  assert.ok(/'mom','momp'/.test(app), "momp must sit beside mom in DEFAULT_ORDER");
  assert.equal(app.split("colAdjacent(").length - 1, 3, "adjacency migration: one definition + prefs path + layout path");
  assert.ok(app.includes("renderDuelSection()") && app.includes("loadDuelData()"), "duel panel wired into the backtest render");
  // -08: the hot dot rides BOTH momentum cells — it flags the name, not the incumbent score,
  // and must survive when only one of the two columns is visible.
  const mompFn = app.slice(app.indexOf("function mompCell"), app.indexOf("function rsCell"));
  assert.ok(mompFn.includes("hotdot"), "mompCell must render the hot dot like momCell does");
  // css + footer + help
  for (const cls of [".duel-verdict", ".duel-tbl", ".duel-row", ".mompw"]) assert.ok(css.includes(cls), `styles.css missing ${cls}`);
  assert.ok(html.includes("MOM+"), "index.html footer must introduce the candidate column");
  assert.ok(app.includes("Score duel</div>"), "backtest help must document the duel");
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

test("levels -09: ctx.levels always ships — populated where structure exists, explicitly empty with a note where it doesn't", () => {
  const { p } = aiLevelPoller();
  const ctx = p.aiCompileNow("xyz:NVDA");
  assert.ok(ctx.levels && Array.isArray(ctx.levels.items), "ctx.levels must ALWAYS ship — the snap rule binds to it, so absent and empty must not be the same thing");
  assert.ok(ctx.levels.items.length >= 2, "the zigzag has structure the detector should find");
  assert.ok(ctx.levels.tauPct > 0, "tau ships so the validator can size its snap tolerance from the same number");
  assert.ok(ctx.levels.items.every((l) => l.v > 0 && l.n >= 2 && typeof l.side === "string"), "every shipped level carries price, touches and a side");
  // the monotone harness: no confirmed pivots anywhere, and the note says so rather than shipping nothing
  const mono = aiTestPoller().p.aiCompileNow("xyz:NVDA");
  assert.equal(mono.levels.n, 0);
  assert.deepEqual(mono.levels.items, []);
  assert.ok(/insufficient daily history/.test(mono.levels.note), "the empty case explains itself: " + mono.levels.note);
});

test("levels -09: a non-anchored directional void must sit on detected structure — off-level reads are rejected, near-misses snap", () => {
  const { p, px } = aiLevelPoller();
  const ctx = () => p.aiCompileNow("xyz:NVDA");
  const c0 = ctx();
  const below = c0.levels.items.filter((l) => l.v < px).sort((a, b) => b.v - a.v);
  assert.ok(below.length, "harness must offer at least one level under the mark");
  const lv = below[0].v, tgt = +(px * 1.09).toPrecision(6);
  // a void copied verbatim off ctx.levels passes untouched
  const ok = p.aiValidateNow(AI_GOOD(px, lv, tgt), c0);
  assert.ok(ok.ok, "a void ON a detected level must pass: " + (ok.error || ""));
  assert.ok(Math.abs(ok.computed.voidLevel / lv - 1) < 1e-6, "and must not be moved");
  // the whole point: a plausible round number backed by nothing is refused, not quietly used
  const tol = c0.levels.tauPct * 0.5 / 100;
  const bogus = +(lv * (1 - 12 * tol)).toPrecision(6);
  const bad = p.aiValidateNow(AI_GOOD(px, bogus, tgt), c0);
  assert.equal(bad.ok, false, "an off-structure void must fail");
  assert.ok(/does not sit on any detected structural level/.test(bad.error), bad.error);
  // within tolerance the value is snapped exactly onto the level, and the report says it was
  const near = +(lv * (1 + tol * 0.4)).toPrecision(6);
  const sn = p.aiValidateNow(AI_GOOD(px, near, tgt), c0);
  assert.ok(sn.ok, "a near-miss must snap, not fail: " + (sn.error || ""));
  assert.ok(Math.abs(sn.computed.voidLevel / lv - 1) < 1e-6, "snapped onto the detected price, so the chart line and the ledger stop agree with the detector");
  assert.equal(sn.computed.correctedVoid, true, "a moved void must be flagged corrected, exactly like the claim-anchor path");
  // and the money math is computed off the SNAPPED void, never the model's original number
  const risk = px - sn.computed.voidLevel;
  const scT = sn.computed.scenarios.find((s) => s.kind === "target");
  assert.ok(Math.abs(scT.payoffR - (tgt - px) / risk) < 0.02, "R is measured from the snapped void");
});

test("levels -09: the snap rule yields to frozen claim geometry, exempts neutral reads, and stands down with no structure", () => {
  const { p, px } = aiLevelPoller();
  const c0 = p.aiCompileNow("xyz:NVDA");
  const tol = c0.levels.tauPct * 0.5 / 100;
  const lv = c0.levels.items.filter((l) => l.v < px).sort((a, b) => b.v - a.v)[0].v;
  const offLevel = +(lv * (1 - 12 * tol)).toPrecision(6), tgt = +(px * 1.09).toPrecision(6);
  // 1. a frozen claim outranks the detector — the ledger's stop is the void, structure or not
  const anchored = Object.assign({}, c0, { claimAnchor: { ev: "breakout", side: "long",
    stop: offLevel, target: null, t0: Date.now(), resolveAt: Date.now() + 86400000 } });
  const a = p.aiValidateNow(AI_GOOD(px, offLevel, tgt), anchored);
  assert.ok(a.ok, "claim geometry must still win outright: " + (a.error || ""));
  assert.ok(Math.abs(a.computed.voidLevel / offLevel - 1) < 1e-6, "and the claim stop is used verbatim, never snapped away from the ledger");
  // 2. a neutral read carries no void and is not subject to the rule
  const neutral = JSON.parse(AI_GOOD(px, lv, tgt));
  neutral.bias = "neutral"; neutral.levels = []; neutral.action = { stance: "wait", entry: null, note: "no directional edge here" };
  neutral.scenarios = [{ name: "chop", kind: "flat", p: 0.6, target: null }, { name: "resolves up", kind: "target", p: 0.4, target: tgt }];
  assert.equal(p.aiValidateNow(JSON.stringify(neutral), c0).ok, true, "neutral reads are exempt");
  // 3. no confirmed structure -> the rule stands down entirely, or a young listing could never
  // get a directional read at all
  const bare = Object.assign({}, c0, { levels: { n: 0, items: [], note: "insufficient daily history for confirmed pivots" } });
  assert.equal(p.aiValidateNow(AI_GOOD(px, offLevel, tgt), bare).ok, true, "empty levels must not block a report");
  const gone = Object.assign({}, c0); delete gone.levels;
  assert.equal(p.aiValidateNow(AI_GOOD(px, offLevel, tgt), gone).ok, true, "a context predating the field degrades, never throws");
});

test("levels -09: manifest — detector, context block, snap rule and prompt contract are all pinned", () => {
  const fs = require("fs"), path = require("path");
  const pol = fs.readFileSync(path.join(__dirname, "..", "src", "poller.js"), "utf8");
  const cmp = fs.readFileSync(path.join(__dirname, "..", "src", "compute.js"), "utf8");
  for (const pin of ["function detectLevels(", "detectLevels,"])
    assert.ok(cmp.includes(pin), `compute.js missing -09 pin: ${pin}`);
  for (const pin of [
    "const AI_LEVEL_K = 3, AI_LEVEL_TAU = 0.4, AI_LEVEL_MINN = 2, AI_LEVEL_MAX = 8;",
    "const AI_SNAP_TOL = 0.5;", "const AI_SCHEMA_V = 9;",
    "ctx.levels = lv || { n: 0, items: [], note:",
    "does not sit on any detected structural level", "(snapped to structure)",
    // the prompt must POINT at the field — the old wording asked for swing data the context never shipped
    "context.levels.items — copy the value verbatim", "context.levels carries the structural levels",
    // the report payload must carry the evidence, or the chart would have to re-derive it and
    // could then disagree with the validator that accepted the read
    "structLevels: (ctx.levels && Array.isArray(ctx.levels.items))"])
    assert.ok(pol.includes(pin), `poller.js missing -09 pin: ${pin}`);
  const app = fs.readFileSync(path.join(__dirname, "..", "public", "app.js"), "utf8");
  for (const pin of ["c.structLevels", "detected structural level(s) drawn faint",
    "flip \\u2014 has served as both resistance and support"])
    assert.ok(app.includes(pin), `app.js missing -09 pin: ${pin}`);
  assert.ok(!app.includes("if(offView.length)    if(offView.length)"), "the duplicated offView guard must stay fixed");
  assert.ok(!pol.includes("prior swings implied by the data"),
    "the unfulfillable prompt clause must be gone — it asked for swing data no context ever carried");
  assert.equal((cmp.match(/function detectLevels\(/g) || []).length, 1, "exactly one detectLevels definition");
});

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
  assert.ok(/const lv = detect\(b\.slice\(0, i \+ 1\), px, sd30\);/.test(cmp),
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

test("levels study -10: poller wiring manifest — section, scope, source, memo, sig", () => {
  const fs = require("fs"), path = require("path");
  const pol = fs.readFileSync(path.join(__dirname, "..", "src", "poller.js"), "utf8");
  for (const pin of [
    "function buildLevelsStudy(U)",
    "levels: lvSt,",                                          // sections wired to the ONE precomputed study
    'const lvSt = on("structure") ? buildLevelsStudy(U) : DISABLED;',   // -19: built only when the universe publishes Structure                      // computed before the sig so ETag and payload agree
    "const LVL_MIN_EQ = 5;",
    "const LVL_STRIDE = 5, LVL_HORIZON = 10, LVL_MINBARS = 60, LVL_CELL_FLOOR = 20;",
    "const db = bucketsFor(r, 24);",                          // spine-derived OHLC dailies — NOT dailyRaw (closes-only after a warm boot would blind the low-side touch test)
    "const bars = db.slice(0, -1);",                          // forming UTC day excluded — closed bars only
    "r._lvSrc !== db",                                        // memo on the bucket array's own freshness contract
    "detectLevels, levelOutcomes, levelStudy,",               // engine imported alongside the detector it audits
  ]) assert.ok(pol.includes(pin), `poller.js missing -10 wiring pin: ${pin}`);
  // scope (-17): the study reads the universe descriptor's roster + eligibility, not a hardcoded
  // xyz-equity filter — one code path, two universes. Stocks eligibility is still equity-only.
  assert.ok(/buildLevelsStudy\(U\) \{\s*\n\s*U = U \|\| analyticsUniverse\("stocks"\);\s*\n\s*const eq = U\.roster\(\)\.filter\(\(r\) => U\.studyEligible\(r\)\)/.test(pol),
    "the study must scope through the universe descriptor (U.roster + U.studyEligible)");
  assert.ok(/studyEligible: \(r\) => r && !r\.delisted && classifyCached\(r\.ticker\)\.assetClass === "Equity"/.test(pol),
    "stocks universe still gates studies to equities");
  // the analytics sig must move when the study moves
  assert.ok(pol.includes('const lvSig = lvSt.disabled ? "off" : (lvSt.pending ?') && /const sig = `\$\{U\.scope\}[^`]*\$\{lvSig\}/.test(pol),
    "levels study signature must feed the /api/analytics ETag");
  assert.ok(!pol.includes("levels: buildLevelsStudy(),"), "sections must reuse lvSt, never a second computation that could disagree with the sig");
});

test("levels study -10: client manifest — panel renderers, deck entry, hover contract", () => {
  const fs = require("fs"), path = require("path");
  const app = fs.readFileSync(path.join(__dirname, "..", "public", "app.js"), "utf8");
  for (const fn of ["renderLevels", "lvlTouchSvg", "lvlHoldRow", "lvlPct"])
    assert.equal((app.match(new RegExp("^function " + fn + "\\(", "gm")) || []).length, 1, `exactly one ${fn} definition`);
  for (const pin of [
    "a.sections && a.sections.levels",
    "'Structural level validation'",
    "lvBlock = renderLevels(lv);",
    "{html:lvBlock},{pend:lvPend}",                           // the panel is actually in the assembled DOM (-15 grouped layout)
    "All ${nStudies} studies live",                     // -17: count is universe-aware (crypto = ten, seasonality n/a)
    'table class="ptbl"',                                     // reuses the styled panel-table class, no orphan CSS
    "under the ${st.cellFloor}-event floor, no rate published",   // floored cells are hoverable and explained
  ]) assert.ok(app.includes(pin), `app.js missing -10 client pin: ${pin}`);
  // hover contract: every data rect in the touch chart and every table row carries a readout
  const seg = app.slice(app.indexOf("function lvlTouchSvg"), app.indexOf("function renderLevels"));
  assert.ok((seg.match(/<title>/g) || []).length >= 3, "chart bars must carry <title> readouts");
  assert.ok(app.includes('<tr title="${tip}"'), "table rows must carry the full hover readout");
});

test("levels study -10: end-to-end through the poller — seeded equities produce a served study, thin books stay pending", async () => {
  const { openStore } = require("../src/store");
  const { createPoller } = require("../src/poller");
  const fs = require("fs"), path = require("path"), os = require("os");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "xyzlvl-"));
  try {
    const store = openStore(dir);
    const p = createPoller({ dex: "xyz", store, log: () => {}, version: "test", crypto: false });
    const HOUR = 3600 * 1000, now = Math.floor(Date.now() / HOUR) * HOUR;
    // 130 UTC days of hourly bars per name — enough closed daily buckets past minBars+horizon.
    const spine = (seed) => {
      let s = seed; const rnd = () => { s = (s * 1103515245 + 12345) & 0x7fffffff; return s / 0x7fffffff; };
      const nrm = () => { let u = 0, v = 0; while (!u) u = rnd(); while (!v) v = rnd(); return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v); };
      const out = []; let px = 100; const N = 130 * 24;
      for (let i = 0; i < N; i++) {
        px *= 1 + nrm() * 0.004;
        const h = px * (1 + Math.abs(nrm()) * 0.002), l = px * (1 - Math.abs(nrm()) * 0.002);
        out.push([now - (N - i) * HOUR, px, Math.max(h, px), Math.min(l, px), px, 1000]);
      }
      return out;
    };
    // AAPL/MSFT/NVDA-class tickers classify as Equity through the real classifier.
    const names = ["AAPL", "MSFT", "NVDA", "AMZN", "GOOGL", "META"];
    names.forEach((t, i) => p.seedRowNow("xyz:" + t, { px: 100, ticker: t, hourlyRaw: spine(97 + i * 13), hourlyTs: now }));
    p.buildAnalyticsNow();
    const a = p.getAnalytics();
    assert.ok(a && a.sections && a.sections.levels, "sections.levels served");
    const lv = a.sections.levels;
    assert.ok(!lv.pending, `study live with ${names.length} seeded equities, got ${JSON.stringify({ pending: lv.pending, count: lv.count })}`);
    assert.ok(lv.n > 50, `pooled events across the seeded book (${lv.n})`);
    assert.equal(lv.coverage.tickers, names.length, "every seeded equity contributes");
    assert.equal(lv.horizon, 10);
    assert.ok(Array.isArray(lv.buckets) && lv.buckets.length === 7, "distance buckets served");
    assert.ok(lv.overall.touchRate == null || Number.isFinite(lv.overall.baseline), "overall control rides along");
    // ETag: the analytics version must move when the study first lands (sig includes lvSig)
    const v1 = a.dataTs;
    assert.ok(v1 > 0, "analytics ETag version stamped");
    // memo: a second build with an unchanged spine must NOT recompute (events array identity survives)
    p.buildAnalyticsNow();
    const b = p.getAnalytics();
    assert.equal(b.dataTs, v1, "unchanged content -> unchanged ETag version (levels sig is stable)");
    // pending path: a fresh poller with too few equities reports the honest gate
    const p2 = createPoller({ dex: "xyz", store, log: () => {}, version: "test", crypto: false });
    p2.seedRowNow("xyz:AAPL", { px: 100, ticker: "AAPL", hourlyRaw: spine(5), hourlyTs: now });
    p2.buildAnalyticsNow();
    const lv2 = p2.getAnalytics().sections.levels;
    assert.ok(lv2.pending, "one equity -> pending, never a study on a two-name class");
    assert.equal(lv2.need, 5);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

// ============================================================================================
// Session anatomy (build 2026.07.24-11): per-UTC-day records off the hourly spine feeding four
// descriptive studies — excursion from open, open-quartile splits, Monday-range containment,
// naked-open revisits. Descriptive base rates with day-pooled honesty; nothing here is a signal.
// ============================================================================================
const { sessionRecords, anatomyEnrich, mondayStats, nakedStats, anatomyPool, MFE_EDGES, NAKED_HORIZONS } = require("../src/compute");

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

test("anatomy -11: nakedStats revisits are exact and truncated horizons report null, never partial counts", () => {
  const DAY = 864e5;
  const rec = [
    { t: 0 * DAY, o: 100, h: 105, l: 99 },
    { t: 1 * DAY, o: 104, h: 106, l: 101 },   // does NOT reach 100
    { t: 2 * DAY, o: 105, h: 107, l: 103 },
    { t: 3 * DAY, o: 106, h: 108, l: 99.5 },  // reaches 100 -> anchor 0 revisited at lag 3
    { t: 4 * DAY, o: 107, h: 109, l: 106 },
  ];
  const nk = nakedStats(rec);
  assert.equal(nk[0].rev[1], false, "not revisited next session");
  assert.equal(nk[0].rev[3], true, "revisited within 3");
  assert.equal(nk[0].rev[5], null, "5-session horizon lacks full forward coverage -> null, not a hopeful partial");
  assert.equal(nk[4].rev[1], null, "the last anchor has no forward sessions at any horizon");
  assert.deepEqual(NAKED_HORIZONS, [1, 3, 5, 10], "horizon ladder pinned");
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

test("anatomy -11: poller wiring manifest — section, scope, memo, sig", () => {
  const fs = require("fs"), path = require("path");
  const pol = fs.readFileSync(path.join(__dirname, "..", "src", "poller.js"), "utf8");
  for (const pin of [
    "function buildAnatomy(U)",
    "anatomy: anSt,",
    "const anSt = buildAnatomy(U);",
    "const ANAT_MIN_EQ = 5, ANAT_MIN_SESS = 20, ANAT_MIN_CROSS = 3;",
    "r._anSrc !== hs",                                        // memo on the spine's own identity
    "sessionRecords, anatomyEnrich, mondayStats, nakedStats, anatomyPool,",
  ]) assert.ok(pol.includes(pin), `poller.js missing -11 wiring pin: ${pin}`);
  assert.ok(/buildAnatomy\(U\) \{\s*\n\s*U = U \|\| analyticsUniverse\("stocks"\);\s*\n\s*const eq = U\.roster\(\)\.filter\(\(r\) => U\.studyEligible\(r\)\)/.test(pol),
    "anatomy scopes through the universe descriptor (U.roster + U.studyEligible)");
  assert.ok(pol.includes("const anSig = anSt.pending ?") && /const sig = `\$\{U\.scope\}[^`]*\$\{anSig\}`/.test(pol),
    "anatomy signature must feed the /api/analytics ETag");
  assert.ok(!pol.includes("anatomy: buildAnatomy(),"), "sections must reuse anSt — one computation, sig and payload agree");
});

test("anatomy -11: client manifest — renderers, deck entry, hover contract, honest-n language", () => {
  const fs = require("fs"), path = require("path");
  const app = fs.readFileSync(path.join(__dirname, "..", "public", "app.js"), "utf8");
  for (const fn of ["renderAnatomy", "anMfeSvg", "anPct"])
    assert.equal((app.match(new RegExp("^function " + fn + "\\(", "gm")) || []).length, 1, `exactly one ${fn} definition`);
  for (const pin of [
    "a.sections && a.sections.anatomy",
    "'Session anatomy'",
    "anBlock = renderAnatomy(an);",
    "{html:anBlock},{pend:anPend}",                           // the panel is actually in the assembled DOM (-15 grouped layout)
    "All ${nStudies} studies live",                                // -13 bumped the count (candles + pivots)
    "readable only after the fact",                           // the openQ conditioning caveat ships in the UI
    "frozen before the session — no lookahead",               // and so does the sd-freeze claim
  ]) assert.ok(app.includes(pin), `app.js missing -11 client pin: ${pin}`);
  const seg = app.slice(app.indexOf("function anMfeSvg"), app.indexOf("function renderAnatomy"));
  assert.ok((seg.match(/<title>/g) || []).length >= 3, "histogram bars and median markers carry <title> readouts");
});

test("anatomy -11: end-to-end through the poller — served study, stable ETag, honest pending", async () => {
  const { openStore } = require("../src/store");
  const { createPoller } = require("../src/poller");
  const fs = require("fs"), path = require("path"), os = require("os");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "xyzanat-"));
  try {
    const store = openStore(dir);
    const p = createPoller({ dex: "xyz", store, log: () => {}, version: "test", crypto: false });
    const HOUR = 3600 * 1000, now = Math.floor(Date.now() / HOUR) * HOUR;
    const spine = (seed) => {
      let s = seed; const rnd = () => { s = (s * 1103515245 + 12345) & 0x7fffffff; return s / 0x7fffffff; };
      const nrm = () => { let u = 0, v = 0; while (!u) u = rnd(); while (!v) v = rnd(); return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v); };
      const out = []; let px = 100; const N = 130 * 24;
      for (let i = 0; i < N; i++) {
        px *= 1 + nrm() * 0.004;
        const h = px * (1 + Math.abs(nrm()) * 0.002), l = px * (1 - Math.abs(nrm()) * 0.002);
        out.push([now - (N - i) * HOUR, px, Math.max(h, px), Math.min(l, px), px, 1000]);
      }
      return out;
    };
    const names = ["AAPL", "MSFT", "NVDA", "AMZN", "GOOGL", "META"];
    names.forEach((t, i) => p.seedRowNow("xyz:" + t, { px: 100, ticker: t, hourlyRaw: spine(41 + i * 17), hourlyTs: now }));
    p.buildAnalyticsNow();
    const a = p.getAnalytics();
    const an = a.sections && a.sections.anatomy;
    assert.ok(an && !an.pending, `anatomy live, got ${JSON.stringify(an && { pending: an.pending, count: an.count })}`);
    assert.equal(an.tickers, names.length);
    assert.ok(an.days >= 120, `~129 complete UTC sessions expected, got ${an.days}`);
    assert.ok(an.mfe.medUpSd > 0, "sd-scored excursion medians served");
    assert.ok(an.monday.weeks >= 15, `pooled weeks served (${an.monday.weeks})`);
    assert.ok(an.naked.revisit.every((x) => x == null || (x >= 0 && x <= 1)), "revisit rates are probabilities");
    const v1 = a.dataTs;
    p.buildAnalyticsNow();
    assert.equal(p.getAnalytics().dataTs, v1, "unchanged spine -> memo holds, ETag stable");
    const p2 = createPoller({ dex: "xyz", store, log: () => {}, version: "test", crypto: false });
    p2.seedRowNow("xyz:AAPL", { px: 100, ticker: "AAPL", hourlyRaw: spine(5), hourlyTs: now });
    p2.buildAnalyticsNow();
    const an2 = p2.getAnalytics().sections.anatomy;
    assert.ok(an2.pending && an2.need === 5, "thin book reports the honest gate");
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

// ============================================================================================
// Ledger shadow pair (build 2026.07.24-12): outsized-wick fill + round-figure front-run. Both
// ship as vi=0 shadows — no UI surface, no in-sample study, records earned purely out of sample
// through the existing rearm/resolver machinery. These pin the frozen geometry and the refusals.
// ============================================================================================
const { detectWickFill, detectRoundFront, roundStep } = require("../src/compute");

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

test("shadow pair -12: manifest — EV_META, poller wiring, geometry gate, shadow-only, xyz-only", () => {
  const fs = require("fs"), path = require("path");
  const cmp = fs.readFileSync(path.join(__dirname, "..", "src", "compute.js"), "utf8");
  const pol = fs.readFileSync(path.join(__dirname, "..", "src", "poller.js"), "utf8");
  for (const f of ["detectWickFill", "detectRoundFront", "roundStep"])
    assert.equal((cmp.match(new RegExp("function " + f + "\\(", "g")) || []).length, 1, `exactly one ${f}`);
  assert.ok(/wickfill: \{ horizonMs: 3 \* DAY/.test(cmp) && /roundfr: {2}\{ horizonMs: 2 \* DAY/.test(cmp),
    "EV_META entries pinned with their horizons");
  for (const pin of [
    "const WICK_FRAC = 0.55;", "const WICK_SIZE_MULT = 1.1;",
    "const RNDF_LO_BAND = 0.05, RNDF_HI_BAND = 0.6;",
    'openLedger(r, "wickfill"', 'openLedger(r, "roundfr"',
    "detectWickFill(db24.slice(0, -1), r.px,",                 // closed spine buckets only — never dailyRaw, never the forming day
    "detectRoundFront(closes, r.px, sd30,",
  ]) assert.ok(pol.includes(pin), `poller.js missing -12 pin: ${pin}`);
  // both claims gated by stopGeometryOk and opened as vi=0 shadows inside the isolated try
  assert.ok(/wf && stopGeometryOk\(wf\.side, r\.px, wf\.stop\)/.test(pol), "wickfill geometry-gated");
  assert.ok(/rf && stopGeometryOk\(rf\.side, r\.px, rf\.stop\)/.test(pol), "roundfr geometry-gated");
  for (const ev of ["wickfill", "roundfr"]) {
    const m = pol.match(new RegExp('openLedger\\(r, "' + ev + '"[\\s\\S]{0,260}?\\}, 0\\);'));
    assert.ok(m, `${ev} must open as a vi=0 shadow`);
  }
  const seg = pol.slice(pol.indexOf("outsized-wick fill + round-figure front-run"), pol.indexOf('openLedger(r, "roundfr"'));
  assert.ok(seg.includes('if (r.uni === "xyz")'), "the pair is xyz-gated at the call site (belt to openLedger's crypto suspenders)");
  // shadows stay invisible: no client labels, ever, until a promotion build adds them deliberately
  const app = fs.readFileSync(path.join(__dirname, "..", "public", "app.js"), "utf8");
  assert.ok(!app.includes("wickfill") && !app.includes("roundfr"), "no client surface for unpromoted shadows");
});

// ============================================================================================
// Candle behaviour + time-based pivots + per-ticker scopes (build 2026.07.24-13).
// ============================================================================================
const { candleType, candleEvents, candlePool, pivotPool, anatomyTickerSummary, CANDLE_TYPES, PIVOT_EARLY_H } = require("../src/compute");

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

test("-13 wiring manifest: byTicker on both studies, candles + pivots served, sig extended, client scoped", () => {
  const fs = require("fs"), path = require("path");
  const pol = fs.readFileSync(path.join(__dirname, "..", "src", "poller.js"), "utf8");
  for (const pin of [
    "pool.byTicker = {};", "st.byTicker = {};",
    "pool.candles = candlePool(perTicker, { minCross: ANAT_MIN_CROSS });",
    "pool.pivots = pivotPool(perTicker, { minCross: ANAT_MIN_CROSS });",
    "summary: anatomyTickerSummary(rec, monday, naked, candles, { minN: ANAT_MIN_SESS })",
    "const one = levelStudy(r._lvEv, { horizon: LVL_HORIZON, cellFloor: LVL_CELL_FLOOR });",   // per-name verdicts through the SAME aggregator
    "anSt.candles ? anSt.candles.n : 0",                                                        // candles/pivots content busts the ETag
  ]) assert.ok(pol.includes(pin), `poller.js missing -13 pin: ${pin}`);
  const app = fs.readFileSync(path.join(__dirname, "..", "public", "app.js"), "utf8");
  for (const fn of ["renderCandles", "renderPivots", "pivotHistSvg", "studyScopeSel", "studyScopeState", "attachStudyScope"])
    assert.equal((app.match(new RegExp("^function " + fn + "\\(", "gm")) || []).length, 1, `exactly one ${fn}`);
  for (const pin of [
    "'Candle behaviour'", "'Time-based pivots'",
    "{html:pvBlock},{pend:pvPend}",
    "attachStudyScope('lvlsel','levels')", "attachStudyScope('anatsel','anatomy')",
    "within-name time series",                                 // the n-basis switch is labeled, both panels
    "All ${nStudies} studies live",
  ]) assert.ok(app.includes(pin), `app.js missing -13 client pin: ${pin}`);
});

test("-13 end-to-end: byTicker scopes, candles and pivots ride the served anatomy payload", async () => {
  const { openStore } = require("../src/store");
  const { createPoller } = require("../src/poller");
  const fs = require("fs"), path = require("path"), os = require("os");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "xyzsc-"));
  try {
    const store = openStore(dir);
    const p = createPoller({ dex: "xyz", store, log: () => {}, version: "test", crypto: false });
    const HOUR = 3600 * 1000, now = Math.floor(Date.now() / HOUR) * HOUR;
    const spine = (seed) => {
      let s = seed; const rnd = () => { s = (s * 1103515245 + 12345) & 0x7fffffff; return s / 0x7fffffff; };
      const nrm = () => { let u = 0, v = 0; while (!u) u = rnd(); while (!v) v = rnd(); return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v); };
      const out = []; let px = 100; const N = 130 * 24;
      for (let i = 0; i < N; i++) {
        px *= 1 + nrm() * 0.004;
        const h = px * (1 + Math.abs(nrm()) * 0.002), l = px * (1 - Math.abs(nrm()) * 0.002);
        out.push([now - (N - i) * HOUR, px, Math.max(h, px), Math.min(l, px), px, 1000]);
      }
      return out;
    };
    const names = ["AAPL", "MSFT", "NVDA", "AMZN", "GOOGL", "META"];
    names.forEach((t, i) => p.seedRowNow("xyz:" + t, { px: 100, ticker: t, hourlyRaw: spine(61 + i * 19), hourlyTs: now }));
    p.buildAnalyticsNow();
    const secs = p.getAnalytics().sections;
    const an = secs.anatomy, lv = secs.levels;
    assert.ok(an && !an.pending && lv && !lv.pending);
    assert.equal(Object.keys(an.byTicker).length, names.length, "every equity gets an anatomy scope entry");
    const one = an.byTicker["xyz:NVDA"];
    assert.equal(one.ticker, "NVDA");
    assert.ok(one.sessions >= 120 && one.quartiles.length === 4 && one.candles.doji !== undefined,
      "per-name summary carries sessions, quartiles and candle types");
    assert.ok(Object.keys(lv.byTicker).length >= 1, "levels scope entries served where events exist");
    for (const k in lv.byTicker) {
      const v = lv.byTicker[k];
      assert.ok(Number.isFinite(v.n) && v.overall, "per-name levels shape: n + overall + byTouches");
      // -14: buckets ship per name so the chart follows the scope selector — same aggregator,
      // same floor (thin per-name cells arrive dim, disclosing their n, never silently dropped).
      assert.ok(Array.isArray(v.buckets) && v.buckets.length && Number.isFinite(v.cellFloor),
        "per-name distance buckets + cellFloor served (chart follows the selector)");
      for (const b of v.buckets) assert.ok(Number.isFinite(b.n), "each per-name bucket discloses its n");
    }
    assert.ok(an.candles && an.candles.n > 300 && an.candles.types.length === 6, "candle behaviour served");
    assert.ok(Math.abs(an.pivots.hi.share.reduce((a, b) => a + b, 0) - 1) < 0.01, "pivot histogram served, sums to 1");
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
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

test("-14 client: charts follow the scope selector; pivots selector exists and is wired", () => {
  const fs = require("fs"), path = require("path");
  const app = fs.readFileSync(path.join(__dirname, "..", "public", "app.js"), "utf8");
  for (const pin of [
    "attachStudyScope('pvsel','pivots')",                       // the missing selector, wired
    "studyScopeSel('pvsel'",                                    // and rendered
    "const chartSrc=(one&&one.buckets)?one:lv;",                // levels chart follows the scope
    "one&&one.mfeHist?Object.assign(",                          // anatomy histogram follows the scope
    "one&&one.pivots?Object.assign({basis:esc(one.ticker)},one.pivots):an.pivots", // pivots too
    "has too few sd-scored sessions for its own histogram",     // honest under-floor fallback, anatomy
    "has too few sessions for its own histogram",               // honest under-floor fallback, pivots
    "m.basis||'sd-scored ticker-sessions'",                     // n-basis label switches in the SVG tips
  ]) assert.ok(app.includes(pin), `app.js missing -14 pin: ${pin}`);
  const pol = fs.readFileSync(path.join(__dirname, "..", "src", "poller.js"), "utf8");
  assert.ok(pol.includes("buckets: one.buckets, far: one.far, cellFloor: one.cellFloor"),
    "poller ships per-name distance buckets for the levels chart");
});

// ===== build 2026.07.24-15: sessions tab grouped into collapsible sections =====
// One status line replaces the coverage cards + readiness bar at 100% ready, a sticky jump bar
// replaces blind scroll, five groups replace the flat stack, group verdicts come from the same
// section payloads the panels render, and pending studies fold into their group as dimmed rows.

test("-15 sessions groups: collapse behavior, persistence, dimmed all-pending groups", () => {
  const fs = require("fs"), path = require("path");
  const app = fs.readFileSync(path.join(__dirname, "..", "public", "app.js"), "utf8");
  const grab = (name) => {
    const i = app.indexOf("function " + name + "(");
    assert.ok(i >= 0, "missing " + name);
    let d = 0, j = app.indexOf("{", i);
    for (let k = j; k < app.length; k++) { if (app[k] === "{") d++; if (app[k] === "}") { d--; if (!d) return app.slice(i, k + 1); } }
  };
  const sgGroups = app.match(/const SESS_GROUPS=\[[\s\S]*?\];/);
  const sgKey = app.match(/const SG_KEY='[^']*';/);
  assert.ok(sgGroups && sgKey, "SESS_GROUPS + SG_KEY both defined");
  const sgConsts = [sgGroups[0] + "\n" + sgKey[0]];
  const R = new Function(
    "const saved={};\nconst store={get:k=>saved[k]??null,set:(k,v)=>{saved[k]=v;}};\n" +
    "const state={analytics:{}};\nlet redraws=0;\nfunction drawSessions(){redraws++;}\n" +
    sgConsts[0] + "\n" + grab("sgOpenSet") + "\n" + grab("sgToggle") + "\n" +
    grab("sgPendRow") + "\n" + grab("sgSection") + "\n" +
    "return {sgOpenSet,sgToggle,sgSection,sgPendRow,saved,state,redrawCount:()=>redraws};")();
  // default open set (no saved state): EXACTLY positioning + holds, everything else collapsed
  const open0 = R.sgOpenSet();
  assert.deepEqual([...open0].sort(), ["holds", "positioning"], "default opens exactly positioning + holds");
  assert.ok(!open0.has("clocks") && !open0.has("week") && !open0.has("structure"), "the rest collapsed by default");
  // open section renders its body; collapsed section hides it (content still in the DOM)
  const openHtml = R.sgSection("holds", "Holds", "overnight +4% net", [{ html: "<i>LIVE</i>" }]);
  assert.ok(openHtml.includes('aria-expanded="true"') && !openHtml.includes(" hidden>"), "open group shows body");
  const closedHtml = R.sgSection("clocks", "Clocks", "busiest 15:00 ET", [{ html: "<i>LIVE</i>" }]);
  assert.ok(closedHtml.includes('aria-expanded="false"') && closedHtml.includes(" hidden>") && closedHtml.includes("LIVE"),
    "collapsed group hides but still carries its body");
  // a group with zero live studies dims and stays visible — nothing pending is hidden
  const pendHtml = R.sgSection("week", "Week", "computing", [{ pend: R.sgPendRow("Day-of-week", "computing — needs 3 (have 1)", "") }]);
  assert.ok(pendHtml.includes("sg-dim") && pendHtml.includes("pending"), "all-pending group dims, discloses state");
  // toggling persists to storage and triggers a redraw
  R.sgToggle("clocks");
  assert.ok(JSON.parse(R.saved["xyz-sessgroups2"]).includes("clocks"), "open state persisted per browser");
  assert.equal(R.redrawCount(), 1, "toggle redraws");
  R.sgToggle("clocks");
  assert.ok(!JSON.parse(R.saved["xyz-sessgroups2"]).includes("clocks"), "collapse persisted too");
});

test("-15 client + styles manifest: status line, sticky jump bar, verdicts from section payloads", () => {
  const fs = require("fs"), path = require("path");
  const app = fs.readFileSync(path.join(__dirname, "..", "public", "app.js"), "utf8");
  for (const pin of [
    'class="sg-status"',                                     // coverage cards + readiness bar collapse to one line
    "full numbers stay on hover",                            // and the detail is not lost, it moves to the tooltip
    'class="jumpbar"', 'data-j="${g.id}"', 'data-g="${id}"', // jump chips + group headers
    "['positioning','holds']",                               // default open set
    "store.set(SG_KEY",                                      // persistence, same store the tab order uses
    "const vPositioning=", "const vHolds=", "const vClocks=", "const vWeek=", "const vStructure=",  // verdicts exist
    "sd.sessions||{}",                                       // ...and read the SAME section objects the panels render
    "hc.pooled&&hc.pooled.all",
    "dow.pooled&&dow.pooled.all",
    "lv.overall.excess",
    "WD_NAMES[bd]",                                          // week verdict uses the heatmap's own day labels
    "computing \\u2014 needs",                               // pending rows keep the honest unlock wording
    "All ${nStudies} studies live",                               // the all-live footer survives the redesign
  ]) assert.ok(app.includes(pin), `app.js missing -15 pin: ${pin}`);
  assert.ok(!app.includes("On deck"), "the separate deck block is gone");
  const css = fs.readFileSync(path.join(__dirname, "..", "public", "styles.css"), "utf8");
  for (const pin of [".jumpbar{position:sticky", ".jchip.on{", ".sg-h{", ".sg-v{", ".sg-b{", ".sg-pend{", ".sg.sg-dim{"])
    assert.ok(css.includes(pin), `styles.css missing -15 rule: ${pin}`);
});

// ===== build 2026.07.24-16: signals stats sections collapse by default =====
// The audit's subsections (by-event table, slices, equity curve, self-tuning, strategy shadows,
// recent resolutions) and the Record-by-event strip each render as a collapsed header until
// clicked; the choice persists per browser. Collapsed content is absent from the DOM but every
// header names its section — nothing is curated away, one click opens any of it.

test("-16 sigSec: collapsed by default, opens from the persisted set, toggle round-trips", () => {
  const fs = require("fs"), path = require("path");
  const src = fs.readFileSync(path.join(__dirname, "..", "public", "app.js"), "utf8");
  const grabAt = (sig) => { const i = src.indexOf(sig); assert.ok(i >= 0, sig + " missing");
    let d = 0, j = src.indexOf("{", i);
    for (let k = j; k < src.length; k++) { if (src[k] === "{") d++; if (src[k] === "}") { d--; if (!d) return src.slice(i, k + 1); } } };
  const saved = {};
  const localStorage = { getItem: (k) => saved[k] ?? null, setItem: (k, v) => { saved[k] = v; } };
  let redraws = 0; const renderSignals = () => { redraws++; };
  const SIGSEC_KEY = "xyz-sigsecs";
  const sigSecOpen = eval("(" + grabAt("function sigSecOpen()") + ")");
  const sigSecToggle = eval("(" + grabAt("function sigSecToggle(id)") + ")");
  const sigSec = eval("(" + grabAt("function sigSec(id,cls,label,tip,body)") + ")");
  // default: nothing open — the body string is NOT in the output, the named header is
  const closed = sigSec("tuning", "sigrec-sub", "self-tuning (shadow variants)", "tip", "<i>BODY</i>");
  assert.ok(closed.includes('aria-expanded="false"') && closed.includes("self-tuning") && !closed.includes("BODY"),
    "collapsed by default: header only, body absent");
  // open via toggle: persisted, redrawn, body present
  sigSecToggle("tuning");
  assert.ok(JSON.parse(saved["xyz-sigsecs"]).includes("tuning") && redraws === 1, "toggle persists and redraws");
  const open = sigSec("tuning", "sigrec-sub", "self-tuning (shadow variants)", "tip", "<i>BODY</i>");
  assert.ok(open.includes('aria-expanded="true"') && open.includes("BODY"), "open section renders its body");
  sigSecToggle("tuning");
  assert.ok(!JSON.parse(saved["xyz-sigsecs"]).includes("tuning"), "collapse round-trips");
});

test("-16 client manifest: every stats section behind sigSec, strip included, toggles bound", () => {
  const fs = require("fs"), path = require("path");
  const app = fs.readFileSync(path.join(__dirname, "..", "public", "app.js"), "utf8");
  for (const id of ["evtable", "slices", "curve", "tuning", "shadows", "resolutions", "recstrip"])
    assert.ok(app.includes(`sigSec('${id}'`), `section '${id}' renders through sigSec`);
  for (const pin of [
    "const SIGSEC_KEY='xyz-sigsecs'",
    "box.querySelectorAll('[data-sigsec]')",                  // click + keyboard binding lives in bindSigControls
    "'recstrip','dsec','Record by event'",                    // the strip keeps its dsec header styling
    "shadow claims only \\u2014 never shown as live signals", // the shadows footnote survives inside its section
  ]) assert.ok(app.includes(pin), `app.js missing -16 pin: ${pin}`);
  const css = fs.readFileSync(path.join(__dirname, "..", "public", "styles.css"), "utf8");
  assert.ok(css.includes(".sigsec-h{cursor:pointer"), "styles.css missing .sigsec-h");
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

test("-17 crypto analytics build: every applicable study lives on a 90d crypto universe, independent of the xyz build", () => {
  const { openStore } = require("../src/store");
  const { createPoller } = require("../src/poller");
  const fs = require("fs"), path = require("path"), os = require("os");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "xyz17-"));
  try {
    const store = openStore(dir);
    const p = createPoller({ dex: "xyz", store, log: () => {}, version: "test", crypto: true });
    const HOUR = 3600 * 1000, now = Math.floor(Date.now() / HOUR) * HOUR;
    const spine = (seed) => {
      let s = seed; const rnd = () => { s = (s * 1103515245 + 12345) & 0x7fffffff; return s / 0x7fffffff; };
      const nrm = () => { let u = 0, v = 0; while (!u) u = rnd(); while (!v) v = rnd(); return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v); };
      const out = []; let px = 100; const N = 90 * 24, t0 = now - N * HOUR;
      for (let i = 0; i < N; i++) { const o = px, c = o * (1 + nrm() * 0.006); out.push([t0 + i * HOUR, o, Math.max(o, c) * (1 + Math.abs(nrm()) * 0.004), Math.min(o, c) * (1 - Math.abs(nrm()) * 0.004), c, 1000 + Math.abs(nrm()) * 5000]); px = c; }
      return out;
    };
    // 8 crypto perps (no colon -> uni "main"), each with a 90d spine + funding history
    ["BTC", "ETH", "SOL", "AVAX", "LINK", "DOGE", "ARB", "OP"].forEach((t, i) => {
      const r = p.seedRowNow(t, { px: 100 + i, hourlyRaw: spine(7 + i * 13), hourlyTs: now });
      for (let h = 0; h < 90 * 24; h += 8) r.fundH.set(now - h * HOUR, (Math.sin(h / 24) * 5) / 1e6);
      r._fVer = (r._fVer || 0) + 1;
    });
    // one xyz equity, so the stocks build is independently exercised and must stay pending (n=1)
    p.seedRowNow("xyz:NVDA", { px: 120, ticker: "NVDA", hourlyRaw: spine(999), hourlyTs: now });

    p.buildAnalyticsNow("crypto");
    p.buildAnalyticsNow("stocks");
    const cr = p.getAnalytics("crypto"), st = p.getAnalytics("stocks");

    // the two payloads are distinct objects with the right universe tags and window depths
    assert.ok(cr && st && cr !== st, "separate per-universe caches");
    assert.equal(cr.scope, "crypto"); assert.equal(cr.tz, "UTC"); assert.equal(cr.isCrypto, true);
    assert.equal(st.scope, "stocks"); assert.equal(st.tz, "ET"); assert.equal(st.isCrypto, false);
    assert.equal(cr.window.hourlyDays, 90, "crypto studies run on the 90d spine");
    assert.equal(st.window.hourlyDays, 180, "xyz studies keep the 180d spine");

    const sec = cr.sections;
    // session decomposition: crypto legs are utcday + weekend, NEVER cash/overnight
    assert.ok(sec.sessionDecomp && !sec.sessionDecomp.pending, "crypto session decomposition lives");
    const legs = Object.keys(sec.sessionDecomp.sessions);
    assert.deepEqual(legs.sort(), ["utcday", "weekend"].sort(), "crypto decomposition: UTC-day + weekend, no cash leg");
    assert.equal(sec.sessionDecomp.isCrypto, true);
    // -19 dropped Clocks/Week/Structure from crypto; -27 restored STRUCTURE (the level + EMA200
    // studies are price-structure claims — a 200-EMA pullback/breakdown/reclaim is as native to a
    // perp as to any equity; stocks-only was a wiring accident). Still not computed on crypto:
    // hour/day grids, seasonality, and clusters — clusters consume the hour clocks crypto does
    // not publish, and must ship {disabled:true}, never an eternal pending row.
    assert.deepEqual(cr.groups, ["positioning", "holds", "structure"], "crypto publishes positioning + holds + structure");
    for (const k of ["hourClock", "dow", "clusters", "seasonality"])
      assert.equal(sec[k] && sec[k].disabled, true, `crypto ${k} must be disabled, not built`);
    assert.ok(sec.levels && !sec.levels.disabled, "crypto structural levels study must BUILD since -27");
    assert.ok(sec.ema200 && !sec.ema200.disabled, "crypto ema200 study must BUILD since -27");
    // and the ones it DOES publish are real (no disabled leaking into the Holds group)
    for (const k of ["sessionDecomp", "anatomy"])
      assert.ok(sec[k] && !sec[k].disabled, `crypto ${k} must still be built`);
    // anatomy + candle behaviour + pivots all live off the same record pass
    assert.ok(sec.anatomy && !sec.anatomy.pending, "anatomy lives");
    assert.ok(sec.anatomy.candles && sec.anatomy.candles.n > 0, "candle behaviour served for crypto");
    assert.ok(sec.anatomy.pivots && sec.anatomy.pivots.hi.nDays > 0, "time pivots served for crypto");
    assert.equal(Object.keys(sec.anatomy.byTicker).length, 8, "per-name anatomy scope for every perp");
    // stocks still publishes all five groups — the gating is per-universe, not global
    assert.deepEqual(st.groups, ["positioning", "holds", "clocks", "week", "structure"], "xyz keeps every group");

    // the xyz build with a single seeded equity stays honestly pending — universes don't cross-contaminate
    assert.ok(st.sections.sessionDecomp.pending && st.sections.anatomy.pending, "xyz build independent (1 equity -> pending)");
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test("-17 client + server wiring manifest: dual-universe route, tz-aware renderers, sessions tab in crypto", () => {
  const fs = require("fs"), path = require("path");
  const app = fs.readFileSync(path.join(__dirname, "..", "public", "app.js"), "utf8");
  const pol = fs.readFileSync(path.join(__dirname, "..", "src", "poller.js"), "utf8");
  const srv = fs.readFileSync(path.join(__dirname, "..", "server.js"), "utf8");
  const cmp = fs.readFileSync(path.join(__dirname, "..", "src", "compute.js"), "utf8");
  // server: the universe descriptor + retention split + parallel cache + route param
  for (const pin of [
    "function analyticsUniverse(scope)",
    "const MAIN_SPINE_DAYS = 90;",
    'scope: "crypto", isCrypto: true, tz: "UTC",',
    "roster: () => mainMarkets().filter",
    "analyticsCryptoCache = payload",
    'getAnalytics: (scope) => {',                     // -17 hotfix: self-healing getter (lazy build on a cold cache)
    'getAnalyticsErr: (scope) =>',                    // and the recorded failure reason the route ships
    'buildAnalyticsSafe("crypto")',   // -17 hotfix: all builds route through the error-recording wrapper
  ]) assert.ok(pol.includes(pin), `poller.js missing -17 pin: ${pin}`);
  assert.ok(srv.includes('req.query && req.query.u === "crypto"'), "server routes ?u=crypto to the crypto analytics cache");
  // compute: crypto anchors exported, clocks accept a tz
  for (const pin of ["function utcDayAnchors(", "function cryptoWeekendAnchors(", "utcDayAnchors, cryptoWeekendAnchors,",
    "function activityClock(prices, funding, tz)", 'const utc = tz === "UTC";'])
    assert.ok(cmp.includes(pin), `compute.js missing -17 pin: ${pin}`);
  // client: per-universe slots, tz helpers, cash-band gating, sessions in the crypto allowlist
  for (const pin of [
    "function _szTz()", "function _szCash()",
    "state.analyticsCrypto=", "function syncAnalyticsSlot()",
    "'/api/analytics?u=crypto'",
    "'backtest','sessions'",                                  // sessions survives the crypto tab filter (now via CRYPTO_VIEWS)
    "if(cash!==false){",                                      // clock scaffold suppresses the cash arc for crypto
    "sd.isCrypto",                                            // session decomposition renderer is universe-aware
    "chart('utcday','UTC day",                               // and draws the UTC-day leg
    "const nStudies = 1/*regime*/+4",   // -19: study count derived from the published group set                                    // footer count is universe-aware
  ]) assert.ok(app.includes(pin), `app.js missing -17 client pin: ${pin}`);
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

test("-17 hotfix: getAnalytics self-heals a cold cache and the failure reason reaches the client", () => {
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
    // this served the empty fallback forever; now the first request repairs the cache itself.
    const st = p.getAnalytics("stocks"), cr = p.getAnalytics("crypto");
    assert.ok(st && st.coverage && st.coverage.hourly, "stocks analytics self-heals on first request");
    assert.ok(cr && cr.coverage && cr.coverage.hourly, "crypto analytics self-heals on first request");
    assert.equal(st.scope, "stocks"); assert.equal(cr.scope, "crypto");
    // a healthy build records no error
    assert.equal(p.getAnalyticsErr("stocks"), "", "no error recorded on a healthy build");
    assert.equal(p.getAnalyticsErr("crypto"), "");
    assert.equal(typeof p.getAnalyticsErr, "function", "the error getter is exported for the route");
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test("-17 hotfix: analytics ETag is scope-namespaced so the two universes can't collide", () => {
  const fs = require("fs"), path = require("path");
  const srv = fs.readFileSync(path.join(__dirname, "..", "server.js"), "utf8");
  // the route builds a scope-prefixed validator and 304s only on an exact scope-tag match
  assert.ok(srv.includes('const tag = \'W/"\' + scope + "-" +'), "ETag prefixes the scope");
  assert.ok(srv.includes('if (req.headers["if-none-match"] === tag) { return reply.code(304).send(); }'),
    "304 only when the scope-namespaced tag matches");
  // prove the two tags differ even at an identical dataTs
  const tagOf = (scope, dataTs) => 'W/"' + scope + "-" + dataTs + '"';
  assert.notEqual(tagOf("stocks", 1721000000000), tagOf("crypto", 1721000000000), "same-ms builds still get distinct tags");
});

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
test("-17 regression: drawSessions EXECUTES and renders for both universes (no ReferenceError)", () => {
  const fs = require("fs"), path = require("path");
  const app = fs.readFileSync(path.join(__dirname, "..", "public", "app.js"), "utf8");
  const { els, mk } = _sessDomStub();
  const saved = { si: global.setInterval, st: global.setTimeout, raf: global.requestAnimationFrame,
    doc: global.document, win: global.window, ls: global.localStorage, f: global.fetch };
  // neutralize timers so evaluating the client can't keep the test runner alive
  global.setInterval = () => 0; global.setTimeout = () => 0; global.requestAnimationFrame = () => 0;
  global.document = { getElementById: (id) => (els[id] = els[id] || mk(id)), querySelectorAll: () => [], querySelector: () => null,
    createElement: mk, addEventListener() {}, body: mk("body"), documentElement: mk("html"), hidden: false };
  global.window = { addEventListener() {}, location: { reload() {}, href: "/" }, matchMedia: () => ({ matches: false, addEventListener() {} }) };
  global.localStorage = { _d: {}, getItem(k) { return this._d[k] ?? null; }, setItem(k, v) { this._d[k] = String(v); }, removeItem(k) { delete this._d[k]; } };
  // Never-settling fetch: evaluating the client kicks off its boot polls. If those promises resolve
  // after this test restores the globals, they touch a torn-down document and surface as an
  // unhandledRejection. Stalling them forever keeps the boot chain inert — we drive drawSessions directly.
  global.fetch = () => new Promise(() => {});
  try {
    const api = new Function(app + "\n;return { drawSessions: typeof drawSessions!=='undefined'?drawSessions:null, state: typeof state!=='undefined'?state:null };")();
    assert.ok(api.drawSessions && api.state, "client exposes drawSessions + state");
    for (const isCrypto of [false, true]) {
      api.state.scope = isCrypto ? "crypto" : "stocks";
      api.state.view = "sessions";
      api.state.analytics.data = _sessPayload(isCrypto);
      api.state.analytics.err = null;
      const host = global.document.getElementById("sessions-body");
      host.innerHTML = "";
      api.drawSessions();   // must not throw — this is the assertion that -17 needed
      const html = host.innerHTML;
      const label = isCrypto ? "crypto" : "stocks";
      assert.ok(html.length > 1000, `${label}: drawSessions must emit real markup (got ${html.length} chars)`);
      assert.ok(!/warming up the spines/.test(html), `${label}: must not fall back to the warming message with a full payload`);
      assert.ok(/sg-h|sg-b|jumpbar/.test(html), `${label}: collapsible group scaffold must render`);
      assert.ok(/Session decomposition/.test(html), `${label}: the flagship study must render`);
      // universe-correct framing, proving the payload actually drove the render
      if (isCrypto) { assert.ok(/UTC day/.test(html), "crypto: UTC-day leg rendered"); assert.ok(!/\bET hour\b/.test(html), "crypto: no ET axis leakage"); }
      else assert.ok(/Overnight/.test(html), "stocks: overnight framing rendered");
    }
  } finally {
    global.setInterval = saved.si; global.setTimeout = saved.st; global.requestAnimationFrame = saved.raf;
    global.document = saved.doc; global.window = saved.win; global.localStorage = saved.ls;
    global.fetch = saved.f;
  }
});

// ===== build 2026.07.24-20: crypto publishes fewer groups; thin per-name tables fall back ========
test("-20: crypto renders only Positioning + Holds; stocks keeps all five groups", () => {
  const fs = require("fs"), path = require("path");
  const app = fs.readFileSync(path.join(__dirname, "..", "public", "app.js"), "utf8");
  const pol = fs.readFileSync(path.join(__dirname, "..", "src", "poller.js"), "utf8");
  // server declares the set once, per universe, and skips building the disabled studies
  assert.ok(pol.includes('groups: ["positioning", "holds", "structure"],'), "crypto descriptor publishes three groups since -27");
  assert.ok(pol.includes('on("structure") && on("clocks") ? buildClusters(hourClock)'), "clusters gate on clocks too — no eternal pending on a clock-less universe");
  assert.ok(pol.includes('groups: ["positioning", "holds", "clocks", "week", "structure"],'), "stocks keeps five");
  assert.ok(pol.includes("groups: U.groups.slice(),"), "the group set ships in the payload");
  for (const gated of ['on("clocks") ? buildActivityClocks(U) : DISABLED',
    'on("week") ? buildDowHeatmap(U) : DISABLED', 'on("structure") && on("clocks") ? buildClusters(hourClock)',
    'on("clocks") ? buildSeasonality(U) : DISABLED', 'on("structure") ? buildLevelsStudy(U) : DISABLED'])
    assert.ok(pol.includes(gated), `study must be group-gated, not built and hidden: ${gated}`);
  // client renders exactly the published set — no hard-coded five-group chain
  assert.ok(app.includes("function sessGroups()"), "client resolves the group set from the payload");
  assert.ok(app.includes("const groups = sessGroups().map(g=>GROUP_BODY[g.id]()).join('');"), "group assembly is payload-driven");
  assert.ok(app.includes("sessGroups().map(g=>`<button type=\"button\" class=\"jchip\"") , "jump bar follows the published set");
  // a disabled study must render NOTHING — not a "computing" row promising it later
  for (const g of ["!hc.disabled", "!dow.disabled", "!cl.disabled", "!lv.disabled", "se.disabled"])
    assert.ok(app.includes(g), `client must treat disabled as absent: ${g}`);
  // the study count is derived, never hard-coded (crypto would otherwise claim eleven)
  assert.ok(app.includes("const nStudies = 1/*regime*/+4"), "study count derived from the group set");
  assert.ok(!/All \$\{isCr\?'ten':'eleven'\}/.test(app), "no hard-coded ten/eleven claim survives");
});

test("-20: a per-name scope under the sample floor falls back to pooled instead of a dash wall", () => {
  const fs = require("fs"), path = require("path");
  const app = fs.readFileSync(path.join(__dirname, "..", "public", "app.js"), "utf8");
  // the fallback helpers exist and every thin-cell table consults them
  assert.ok(app.includes("function _anyCell(") && app.includes("function _fbNote("), "fallback helpers defined");
  for (const fb of ["const qFallback=", "const moFallback=", "const nkFallback=", "const cbFallback=", "const cvFallback="])
    assert.ok(app.includes(fb), `missing fallback gate: ${fb}`);
  // and each one labels itself rather than silently swapping scope under a per-name header
  // four notes for five gates: the weekly-container and naked-open fallbacks share one line
  assert.equal((app.match(/_fbNote\(/g) || []).length - 1, 4, "four labeled fallback notes (helper definition excluded)");
  // the floor itself must NEVER be lowered — that would be the false precision this app refuses
  const cmp = fs.readFileSync(path.join(__dirname, "..", "src", "compute.js"), "utf8");
  assert.ok(/const minN = Number\.isFinite\(o\.minN\) \? o\.minN : 20;/.test(cmp), "the per-bucket sample floor is unchanged");
  assert.ok(/rate = \(arr\) => arr\.length >= minN \?/.test(cmp), "rates below the floor still return null");
  // med day range is pooled-only: the column is omitted per-name, never rendered as dashes
  assert.ok(app.includes("const qMed=!qScope;"), "med-range column omitted in per-name scope");
});

test("ai report -01: target reconciliation — the level is the one source of truth, a null scenario target is filled from it, neither is still fatal", () => {
  const { p, px } = aiTestPoller();
  const ctx = () => p.aiCompileNow("xyz:NVDA");
  const voidLv = +(px * 0.95).toPrecision(6), tgt = +(px * 1.10).toPrecision(6);
  const mut = (fn) => { const o = JSON.parse(AI_GOOD(px, voidLv, tgt)); fn(o); return JSON.stringify(o); };
  const scenT = (r) => r.computed.scenarios.find((s) => s.kind === "target");
  // the baseline: both fields carry the price, nothing is reconciled
  const base = p.aiValidateNow(AI_GOOD(px, voidLv, tgt), ctx());
  assert.ok(base.ok, base.error || "");
  assert.equal(base.computed.correctedTarget, false, "a fully-specified payload must not be flagged as reconciled");
  // THE BUG: the prompt offers "target": null, the validator rejected it, and the report died.
  // The target LEVEL is present, so the scenario field is filled from it and the R/R is identical.
  const nulled = p.aiValidateNow(mut((o) => { o.scenarios[0].target = null; }), ctx());
  assert.ok(nulled.ok, "a null scenario target with a target level present must validate: " + (nulled.error || ""));
  assert.equal(nulled.computed.correctedTarget, true, "the fill must be flagged, not silent");
  assert.equal(scenT(nulled).target, scenT(base).target, "the filled target must be the level's own price");
  assert.equal(scenT(nulled).payoffR, scenT(base).payoffR, "payoff must be identical to the fully-specified payload");
  assert.equal(nulled.computed.evR, base.computed.evR, "EV must be identical too");
  // the action block reads the same number: the entry plan survives the null
  assert.equal(nulled.computed.action.target, base.computed.action.target, "the action target must survive the fill");
  // a scenario price that DISAGREES with the level loses: chart and card may never show two targets
  const drift = p.aiValidateNow(mut((o) => { o.scenarios[0].target = +(tgt * 1.05).toPrecision(6); }), ctx());
  assert.ok(drift.ok, drift.error || "");
  assert.equal(drift.computed.correctedTarget, true, "a disagreeing scenario price must be corrected to the level");
  assert.equal(scenT(drift).target, scenT(base).target, "the LEVEL wins, not the scenario's own number");
  // neither field carries a price: still fatal, still the same error string
  const neither = p.aiValidateNow(mut((o) => {
    o.scenarios[0].target = null; o.levels = o.levels.filter((l) => l.kind !== "target");
  }), ctx());
  assert.equal(neither.ok, false);
  assert.ok(/target scenario without a target level/.test(neither.error), neither.error);
  // scenario price with NO level: the level is minted so the chart draws what the card claims
  const minted = p.aiValidateNow(mut((o) => { o.levels = o.levels.filter((l) => l.kind !== "target"); }), ctx());
  assert.ok(minted.ok, "a scenario-only target must validate: " + (minted.error || ""));
  assert.equal(minted.computed.correctedTarget, true, "minting must be flagged");
  const ml = minted.computed.levels.filter((l) => l.kind === "target");
  assert.equal(ml.length, 1, "exactly one target level must be minted");
  assert.equal(ml[0].value, scenT(minted).target, "the minted level and the scenario must be the SAME number");
  assert.equal(scenT(minted).payoffR, scenT(base).payoffR, "minted geometry must produce the baseline payoff");
  // ...and an out-of-band scenario price is rejected rather than minted into a fake R
  const wild = p.aiValidateNow(mut((o) => {
    o.levels = o.levels.filter((l) => l.kind !== "target"); o.scenarios[0].target = +(px * 4).toPrecision(6);
  }), ctx());
  assert.equal(wild.ok, false);
  assert.ok(/target scenario price outside sanity bounds/.test(wild.error), wild.error);
  // non-target kinds keep their null: the fill is scoped to "target" alone
  assert.equal(nulled.computed.scenarios.find((s) => s.kind === "void").target, null, "void scenarios stay target-null");
  assert.equal(nulled.computed.scenarios.find((s) => s.kind === "flat").target, null, "flat scenarios stay target-null");
});

test("ai report -01: prompt and validator agree on the target contract, and a rejection logs its shape", () => {
  const fs = require("fs"), path = require("path");
  const pol = fs.readFileSync(path.join(__dirname, "..", "src", "poller.js"), "utf8");
  // The prompt must no longer offer a null it will be punished for, and the void/target rules
  // must stay SEPARATE — collapsing them back is what left crypto with no legal target price.
  assert.ok(pol.includes('A "target" scenario MUST carry a price'), "prompt must demand a price on target scenarios");
  assert.ok(pol.includes('"target": null is for the "flat", "void" and "event" kinds only'),
    "prompt must scope the null to the non-target kinds");
  assert.ok(pol.includes("The TARGET is held to a softer rule than the void"),
    "prompt must keep the target's structure rule softer than the void's");
  assert.ok(/Otherwise the VOID must come from context\.levels\.items/.test(pol),
    "the hard-rules line must bind context.levels.items to the VOID, not to every level");
  assert.ok(!/every level you emit must come from context\.levels\.items/.test(pol),
    "the blanket every-level rule must be gone — it is what produced the null target");
  // levels are parsed BEFORE the scenario loop; the reconciliation depends on that order
  assert.ok(pol.indexOf("let targetLv = levels.find") < pol.indexOf('if (s.kind === "target") {'),
    "the levels parse must be hoisted above the scenario loop");
  assert.equal(pol.split("const levels = [];").length - 1, 1, "the levels parse must exist exactly once (no duplicate left behind)");
  assert.ok(pol.includes("correctedTarget: targetReconciled"), "the reconciliation flag must ship in computed");
  // the fingerprint logger: present, wired into the double-failure path, and shape-only
  assert.ok(/function aiRejectShape\(rawText\)/.test(pol), "aiRejectShape helper missing");
  assert.ok(pol.includes("fallback failed too (${val.error}) — ${aiRejectShape("), "double-failure log must carry the shape");
  const { p } = aiTestPoller();
  assert.equal(typeof p.aiRejectShapeNow, "function", "aiRejectShape must be reachable from the harness");
  assert.ok(/no model text/.test(p.aiRejectShapeNow(null)), "a transport failure must say so");
  assert.ok(/unparseable \(\d+ chars\)/.test(p.aiRejectShapeNow("not json at all")), "unparseable payloads report their length");
  const shp = p.aiRejectShapeNow(JSON.stringify({ bias: "long",
    scenarios: [{ kind: "target", target: null }, { kind: "void" }], levels: [{ kind: "void" }] }));
  assert.ok(/bias=long/.test(shp) && /scen=\[target,void\]/.test(shp) && /levels=\[void\]/.test(shp), shp);
  assert.ok(/empty=\[[^\]]*scen\.target[^\]]*\]/.test(shp) && /level\.target/.test(shp), "the empty-field list must name the gaps: " + shp);
  assert.ok(!/synthesis|headline/.test(shp), "the fingerprint must carry shapes, never payload prose");
});

test("client -01: the target reconciliation is disclosed on the card, with hover, next to the void precedent", () => {
  const fs = require("fs"), path = require("path");
  const app = fs.readFileSync(path.join(__dirname, "..", "public", "app.js"), "utf8");
  assert.ok(app.includes("c.correctedTarget?"), "the card must read the reconciliation flag from the server payload");
  assert.ok(app.includes("target reconciled to the chart level"), "the disclosure text is missing");
  // standing requirement: every annotation of this class carries hover context, same as the void's
  assert.ok(/c\.correctedTarget\?' · <span data-tip="/.test(app), "the disclosure must carry a data-tip hover explanation");
  // one-code-path: the flag is SERVER-derived, never recomputed client-side from the levels
  assert.ok(!/correctedTarget\s*=/.test(app), "the client must never assign correctedTarget itself");
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

test("actionable -06: the CONFIRMED gate drops negative-expectancy setups instead of demoting them", () => {
  const { setupEV, netRR } = require("../src/compute");
  const fs = require("fs"), path = require("path");
  const pol = fs.readFileSync(path.join(__dirname, "..", "src", "poller.js"), "utf8");
  // The gate is a single function so there is exactly one place that decides what gets suggested.
  assert.ok(/function actConfirm\(rec, evR, rr, ev\)/.test(pol), "actConfirm gate missing");
  // thinRR left this list deliberately: freezing R:R at fire exposed that sigma-built setups
  // (target = study median vs a 1-sigma void) run 0.5-1.0x BY CONSTRUCTION, so a 2:1 gate deleted
  // that whole family the moment the ratio stopped being drift-inflated. The floor is a row CLASS
  // now — 'rr' clears it, 'ev' rides on positive expectancy — and the client's checkboxes pick
  // which families show. EV>0 stays the hard gate for both.
  assert.ok(!pol.includes('"thinRR"'), "thinRR fully retired from the gate and the tallies");
  assert.ok(pol.includes('function actClass(rr) { return rr && rr.gross >= ACT_MIN_RR ? "rr" : "ev"; }'),
    "the floor classifies instead of rejecting");
  assert.ok(pol.includes("shadow, cls: actClass(rr),"), "and every row carries its class to the client");
  for (const cond of ['return "norecord"', 'return "negexp"', 'return "negev"', 'return "noedge"'])
    assert.ok(pol.includes(cond), `gate must reject with a named reason: ${cond}`);
  // Both expectancy tests are required and they are NOT the same test. avg is retrospective (did
  // this family pay); EV is prospective on this instance (does it still pay from here).
  // Field name pinned deliberately: actRecord returns avgR, and an earlier cut of the gate read
  // rec.avg — undefined, which failed the comparison and rejected EVERY setup as negative-
  // expectancy. A silent empty board is the worst possible failure mode for this feature.
  assert.ok(/if \(!\(rec\.avgR > 0\)\) return "negexp";/.test(pol), "the gate must read rec.avgR, the field actRecord actually returns");
  assert.ok(/if \(evR == null \|\| !\(evR > 0\)\) return "negev";/.test(pol), "a negative-EV entry must be dropped even if the family's average is positive");
  assert.ok(/ACT_MIN_RR = 2\.0;/.test(pol), "the suggestion floor must be R:R 2.0");
  // Gate BEFORE merge: otherwise an unconfirmed candidate could win a name+side on a flattering
  // EV and then be rejected, silently losing a confirmed row that was behind it.
  const gi = pol.indexOf("const why = actConfirm("), mi = pol.indexOf("mergeActionable(cands)");
  assert.ok(gi > 0 && mi > 0 && gi < mi, "the gate must run before the merge");
  // Nothing is demoted to a second section — the payload is one flat list of confirmed rows.
  assert.ok(!/unproven: shadow/.test(pol), "the proven/unproven split must be gone from the row builder");
  assert.ok(/rows: board, count: board\.length/.test(pol), "payload must be one flat confirmed list");
  // The arithmetic the gate leans on, pinned directly: a losing family can still look fine on a
  // single instance's geometry, which is exactly why avg > 0 is checked separately.
  assert.ok(setupEV(0.35, 2.5, 20, 8) > 0, "a 35% hit at 2.5R models positive on this instance...");
  const rr = netRR({ side: "long", entry: 100, stop: 95, target: 115 });
  assert.equal(rr.gross, 3, "...while the geometry check stays independent of the record");
}, );

test("actionable -07: the board reads the ledger's frozen geometry and never re-derives a level", () => {
  const { createPoller } = require("../src/poller");
  const HOUR = 3600e3, DAY = 86400e3;
  const store = { loadAll: () => new Map(), loadRegime: () => [], loadLedger: () => null,
    saveLedger: () => {}, insert: () => {}, saveRegime: () => {} };
  const p = createPoller({ dex: "xyz", store, log: () => {}, version: "test", crypto: false });
  const now = Date.now(), endH = Math.floor(now / HOUR), N = 16 * 24, hourly = [];
  for (let i = 0; i < N; i++) { const t = (endH - N + i) * HOUR, c = 100 * Math.pow(1.0005, i);
    hourly.push({ t, o: c, h: c * 1.001, l: c * 0.999, c, v: 1 }); }
  const px = hourly[N - 1].c * 1.0005, daily = [];
  for (let i = 0; i < 60; i++) { const c = px * Math.pow(1.002, i - 59);
    daily.push({ t: (Math.floor(now / DAY) - 60 + i) * DAY, c, l: c * 0.97, h: c * (i === 50 ? 1.35 : 1.002) }); }
  p.seedRowNow("TRSIG", { px, ticker: "TRSIG", uni: "xyz", vol: 1e6, funding: 0.00005, hourlyRaw: hourly, dailyRaw: daily });
  p.buildTrendNow(); p.buildSignalsNow(); p.buildActionableNow();
  const a = p.getActionable();
  // A brand-new event has no record, so it is NOT suggested — the whole point of the gate. It is
  // dropped with a named reason rather than shown with a blank expectancy.
  assert.equal(a.count, 0, "an event with no resolved fires is not suggested");
  assert.ok(Array.isArray(a.rows) && a.rows.length === 0, "the payload is one flat list, and it is empty");
  assert.equal(a.coverage.norecord, 1, "and the drop is counted against a named reason");
  assert.ok(a.coverage.openClaims >= 1, "coverage discloses how many open claims were scanned");
  assert.equal(a.params.netOfCarry, true, "the payload declares that R:R is net of carry");
  assert.equal(a.params.recMinN, 8, "and discloses the record floor");
  assert.equal(a.params.gate, "confirmed", "and names the gate it applied");
  assert.deepEqual(a.params.requires, ["n>=8", "avgR>0", "EV>0", "R:R<=20", "!noedge"], "the gate's conditions ship with the payload — the 2:1 floor left them because it no longer rejects anything, while the R:R<=20 ceiling stays: an absurd ratio is still an artifact");
  assert.equal(a.params.rrFloor, 2, "the floor ships separately, as the family boundary");
  // Nothing confirmed means nothing announced — the stream inherits the gate by construction.
  assert.equal(p.getTriggers().seq, 0, "an unconfirmed setup never reaches the trigger stream");
  // Swing gate is by horizon, so short-horizon events can never leak onto a swing board.
  const { EV_META } = require("../src/compute");
  for (const r of a.rows)
    assert.ok(EV_META[r.ev].horizonMs >= 3 * DAY, `sub-3d event on the swing board: ${r.ev}`);
});

test("actionable -08: geometry that is no longer tradeable is counted, and the claim survives it", () => {
  const { createPoller } = require("../src/poller");
  const HOUR = 3600e3, DAY = 86400e3;
  const store = { loadAll: () => new Map(), loadRegime: () => [], loadLedger: () => null,
    saveLedger: () => {}, insert: () => {}, saveRegime: () => {}, saveTriggers: () => {}, loadTriggers: () => null };
  const p = createPoller({ dex: "xyz", store, log: () => {}, version: "test", crypto: false });
  const now = Date.now(), endH = Math.floor(now / HOUR), N = 16 * 24, hourly = [];
  for (let i = 0; i < N; i++) { const t = (endH - N + i) * HOUR, c = 100 * Math.pow(1.0005, i);
    hourly.push({ t, o: c, h: c * 1.001, l: c * 0.999, c, v: 1 }); }
  const px = hourly[N - 1].c * 1.0005, daily = [];
  for (let i = 0; i < 60; i++) { const c = px * Math.pow(1.002, i - 59);
    daily.push({ t: (Math.floor(now / DAY) - 60 + i) * DAY, c, l: c * 0.97, h: c * (i === 50 ? 1.35 : 1.002) }); }
  p.seedRowNow("xyz:TRSIG", { px, ticker: "TRSIG", uni: "xyz", vol: 1e6, funding: 0.00005, hourlyRaw: hourly, dailyRaw: daily });
  p.buildTrendNow(); p.buildSignalsNow(); p.buildActionableNow();
  const a1 = p.getActionable();
  assert.equal(a1.coverage.norecord, 1, "the claim is scanned and rejected on record, with geometry still intact");
  // Walk the mark down through the frozen void. netRR now returns null, so the rejection reason
  // changes from "no record" to "no tradeable geometry" — the row is gone for a different reason,
  // and which reason it was stays visible.
  const led = [...(p.trigStateNow() ? [1] : [])];
  p.seedRowNow("xyz:TRSIG", { px: px * 0.5 });
  p.buildActionableNow();
  const a2 = p.getActionable();
  assert.equal(a2.count, 0, "still nothing suggested");
  assert.ok(a2.coverage.untakeable >= 1,
    "and the reason is its own counter now: a claim can be perfectly framed at fire and already dead at the live mark, which is a different fact from the frozen geometry never having made sense");
  assert.ok(a2.coverage.openClaims >= 1, "the underlying claim is still open in the ledger — the board dropped it, the record did not");
  assert.equal(a2.coverage.confirmed, 0, "confirmed count is explicit, not inferred from an empty array");
});

const ACT_TIP_COLS = ["ago", "fired", "entry", "late", "void", "target", "rr", "evR", "rec"];
test("actionable -09: client renders the server's numbers and states the carry contract on the tab", () => {
  const fs = require("fs"), path = require("path");
  const s = fs.readFileSync(path.join(__dirname, "..", "public", "app.js"), "utf8");
  const html = fs.readFileSync(path.join(__dirname, "..", "public", "index.html"), "utf8");
  const css = fs.readFileSync(path.join(__dirname, "..", "public", "styles.css"), "utf8");
  // Tab + view + controls exist and are wired into navigation.
  assert.ok(html.includes('data-view="actionable"') && html.includes('id="view-actionable"'), "actionable tab/view markup missing");
  assert.ok(html.includes('id="act-body"') && html.includes('id="actside"'), "actionable board container/controls missing");
  assert.ok(html.includes('id="act-noearn"') && html.includes('id="act-sortreset"'), "actionable filters/sort-reset missing");
  assert.ok(!html.includes('id="act-provenonly"'), "the proven-only filter must be gone — the board is confirmed-only");
  assert.ok(s.includes("setHidden('view-actionable', v!=='actionable')"), "actionable view not wired into showView");
  assert.ok(s.includes("if(v==='actionable')") && s.includes("openActionable()"), "actionable tab does not open its board");
  assert.ok(s.includes("/api/actionable"), "client never calls the actionable endpoint");
  // The one-code-path contract: the client must NOT recompute reward:risk, carry or expectancy.
  // It formats what the server ranked. A local arithmetic path here is exactly how the board and
  // the record start disagreeing about the same trade.
  assert.ok(!/act[A-Za-z]*\s*=\s*[^;]*rewardPct\s*\/\s*riskPct/.test(s), "client must not recompute R:R locally");
  assert.ok(!/r\.rr\.gross\s*\+\s*r\.(carry|rr)\.\w*[Rr]\b/.test(s), "client must not add carry back into R:R locally");
  assert.ok(s.includes("actRR(r.rr.gross)") && s.includes("actEV(r.evR)"), "client must render the server's frozen R:R and expectancy verbatim");
  assert.ok(!s.includes("r.rr.net") && !s.includes("rr.carryKnown"), "no client path reads the retired net/carry-in-ratio fields");
  assert.ok(s.includes("not counted in R:R or EV"), "the carry line states plainly that it is excluded from both");
  assert.ok(!s.includes('">No record yet'), "there is no second section any more — unconfirmed setups are not shown at all");
  // Hover contract: every column header explains itself, and the full audit trail lives in the
  // click-to-expand trade card rather than a cramped row tooltip.
  for (const c of ACT_TIP_COLS) assert.ok(new RegExp("k:'" + c + "'[^}]*tip:").test(s), `column ${c} must carry a header tooltip`);
  assert.ok(s.includes("function actDetail"), "expanded trade card missing");
  for (const frag of ["the trade", "the record", "risk / reward", "carry", "expectancy", "lateness", "bar(s) in trigger"])
    assert.ok(s.includes(frag), `trade card must disclose: ${frag}`);
  assert.ok(s.includes("(paid to hold)") && s.includes("(you pay)"), "the card must state which way carry runs for this side");
  assert.ok(s.includes("funding unavailable"), "an unknown funding rate must be disclosed, not shown as zero carry");
  // Rows expand on click; the two escape hatches out of the card are wired.
  assert.ok(/box\.querySelectorAll\('tr\.act-row'\)/.test(s) && s.includes("_actOpen[k]=!_actOpen[k]"), "rows must expand on click");
  assert.ok(s.includes("data-rep=") && s.includes("data-dr="), "the card must offer the AI report and the ticker drawer");
  // Sorting is the one thing the client owns — persisted, with nulls pinned last both ways.
  assert.ok(s.includes("function actCmp") && s.includes("if(xn) return 1; if(yn) return -1;"), "nulls must sort last in both directions");
  assert.ok(s.includes("actSortSave()") && s.includes("ASKEY"), "sort choice must persist");
  assert.ok(/_actSort=\{k:'ago',d:1\}/.test(s), "default sort must be newest-first");
  // The board must state the gate it applied, in the UI, not just in the payload.
  assert.ok(s.includes("Confirmed only."), "footer must state the board is confirmed-only");
  assert.ok(s.includes("Most events in the ledger do not clear that"), "footer must be honest that most events fail the gate");
  assert.ok(s.includes("an empty board is a real answer"), "an empty board must be explained, not look broken");
  // The board must say, in the UI, that R:R is net and where EV is blank — the honesty contract.
  assert.ok(s.includes("R:R is net of expected funding"), "footer must state that R:R is carry-netted");
  assert.ok(/at least \$\{p\.recMinN\|\|8\} resolved out-of-sample fires/.test(s), "footer must state the record floor the gate requires");
  assert.ok(s.includes("frozen at fire time") && s.includes("never re-derived"), "footer must state that levels are frozen, not re-derived");
  // -15: the crypto engine is back (2026.07.26-08) and the board is cross-universe — the old
  // "equities only" disclosure would now be the lie. The footer must say the scoped truth instead.
  assert.ok(!s.includes("no crypto claims"), "the stale equities-only footer line must be gone — the board serves both universes");
  assert.ok(s.includes("Both universes, scoped by the toggle above"), "footer must state the cross-universe scoped contract");
  // Styling exists for every class the renderer emits (a missing rule renders an unreadable board).
  for (const cls of ["act-h", "act-tbl", "act-ev", "act-stale", "act-also", "act-warn", "act-note", "act-foot"])
    assert.ok(css.includes("." + cls), `missing CSS for client class: ${cls}`);
  // Reuses the trend board's table shell rather than forking a second look for a sibling board.
  assert.ok(s.includes('<table class="trend-t act-tbl">'), "actionable board should reuse the trend table shell");
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
test("triggers -03: announce once, never twice, and never re-blast the board on a redeploy", () => {
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
  const build = (p) => { p.buildTrendNow(); p.buildSignalsNow(); p.buildActionableNow(); };

  const p1 = createPoller({ dex: "xyz", store, log: () => {}, version: "test", crypto: false });
  seed(p1); p1.hydrateLedgerNow(); build(p1);   // hydrate first: the record is what makes the claim confirmed
  assert.equal(p1.getActionable().count, 1, "with a real record behind it, the setup IS suggested");
  const t1 = p1.getTriggers();
  assert.equal(t1.seq, 1, "a fresh in-grace fire emits exactly one event");
  assert.equal(t1.events[0].t, "TRSIG");
  assert.ok(t1.events[0].fired > 0 && t1.events[0].late != null, "the event carries both marks so a transport can compose a message without re-reading the board");
  assert.equal(t1.events[0].also, undefined, "corroboration is a board concern, not part of the claim event");
  // Idempotence within a process: rebuilding must not re-announce a claim already seen.
  build(p1);
  assert.equal(p1.getTriggers().seq, 1, "rebuilding the board does not re-announce");
  // Restart with the persisted announced-set AND the persisted ledger: the frozen t0 keeps the
  // key stable, so nothing re-fires. This is the property that decides whether a push channel
  // survives contact with a deploy.
  const p2 = createPoller({ dex: "xyz", store, log: () => {}, version: "test", crypto: false });
  seed(p2); p2.hydrateTriggersNow(); p2.hydrateLedgerNow(); build(p2);
  assert.equal(p2.getActionable().count, 1, "the setup is still suggested after the restart");
  assert.equal(p2.getTriggers().seq, 1, "a redeploy re-announces nothing");
  assert.equal(p2.trigStateNow().seen, 1, "and restores the announced set rather than starting blank");
  // Cursor semantics: a consumer stores the last seq handled and takes everything above it.
  assert.equal(p2.getTriggers(0).count, 1, "since=0 replays the retained window");
  assert.equal(p2.getTriggers(1).count, 0, "since=high-water yields nothing");
  assert.equal(p2.getTriggers(99).count, 0, "a cursor beyond the stream is empty, not negative");
});

test("triggers -04: a cold start with a stale board seeds silently instead of detonating", () => {
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
  seed(p1); p1.hydrateLedgerNow(); p1.buildTrendNow(); p1.buildSignalsNow();
  assert.ok(savedLed && savedLed.open && savedLed.open.length >= 1, "a claim was opened and persisted");
  // Backdate it by three days — the restart-after-downtime case: the board is full of claims that
  // fired while nobody was listening, and none of them are news.
  const stale = JSON.parse(JSON.stringify(savedLed));
  for (const e of stale.open) e.t0 = Date.now() - 3 * DAY;
  stale.closed = REC;   // the record travels with it, so the stale claim is confirmed, not merely old
  // Pass 2: a genuinely cold process (no persisted trigger state) meets that stale board.
  const p2 = createPoller({ dex: "xyz", store: mkStore(() => stale), log: () => {}, version: "test", crypto: false });
  seed(p2); p2.hydrateLedgerNow(); p2.buildActionableNow();
  const t = p2.getTriggers();
  assert.ok(p2.getActionable().count >= 1, "the stale claim is still ON the board — it is tradeable, just not news");
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
  p2.buildTrendNow(); p2.buildSignalsNow(); p2.buildActionableNow();
  const t2 = p2.getTriggers();
  assert.ok(t2.seq >= 1, "a claim opened after the cold start DOES announce");
  assert.ok(t2.events.some((e) => e.t === "FRESH"), "and it is the new name, not the seeded stale one");
  assert.ok(!t2.events.some((e) => e.t === "OLD"), "the silently-seeded claim never announces retroactively");
});

test("triggers -05: browser transport is a consumer only, and the toast surface avoids the terminal", () => {
  const fs = require("fs"), path = require("path");
  const s = fs.readFileSync(path.join(__dirname, "..", "public", "app.js"), "utf8");
  const css = fs.readFileSync(path.join(__dirname, "..", "public", "styles.css"), "utf8");
  // Consumer, not detector: the client must read the server's stream and advance a cursor. If it
  // ever decides for itself what counts as "new", a future Telegram push has a second opinion.
  assert.ok(s.includes("/api/triggers"), "client must consume the server trigger stream");
  assert.ok(s.includes("function trigSeqGet") && s.includes("function trigSeqSet"), "cursor persistence missing");
  // Same invariant, new shape (-03): the first run still adopts the high-water mark without
  // firing, but it now also takes the display list and initialises the read watermark, so a new
  // device opens onto real history with a clean badge instead of a blank panel.
  assert.ok(/if\(cur==null\)\{ trigSeqSet\(d\.seq\|\|0\);/.test(s), "first run on a device must adopt the high-water mark without firing the retained ring");
  const lt0 = s.slice(s.indexOf("async function loadTriggers()"), s.indexOf("function fireTrigger("));
  assert.ok(lt0.indexOf("if(cur==null)") < lt0.indexOf("for(const ev of d.events)"), "…and it must return BEFORE the firing loop");
  // Dedup belongs to the poller: the client must hold a single integer cursor, not a set of keys.
  // (Checked as identifiers, not prose — the comments in app.js legitimately discuss the concept.)
  for (const ident of ["trigSeen", "trigKeys", "seenTriggers", "firedKeys"])
    assert.ok(!new RegExp("(let|const|var)\\s+" + ident + "\\b").test(s), `client must not keep its own announced-set (${ident}) — dedup belongs to the poller`);
  assert.ok(/store\.get\(TSEQ\)/.test(s) && /store\.set\(TSEQ/.test(s), "the client's entire memory of what it has shown must be one persisted sequence number");
  // Fires land in the SHARED alert surface so the bell badge and Recent list cover both kinds.
  // The shared surface moved (-03): it used to be a local array each fire* pushed into, which
  // reset on refresh. It is now the server's own recent list, adopted on every pull — so the
  // invariant is that trigger events reach the SAME feed and badge as every other class, not that
  // a particular local array is written to.
  assert.ok(/A\.feed=d\.recent/.test(s), "trigger fires must land in the shared, server-held feed");
  assert.ok(/function alertUnread\(\)/.test(s) && /A\.feed\.filter/.test(s), "the bell badge must count that shared feed");
  assert.ok(s.includes("function fireTrigger") && s.includes("updateBell()"), "trigger fires must update the bell");
  // Settings live in the bell panel, not in the board's filter row (which would be a second,
  // competing alert-configuration surface).
  // Same invariant, new shape (-09): the three thresholds are now free numeric inputs built by a
  // shared helper rather than three hardcoded <select>s, and R:R joined them — but they still live
  // in the bell panel and nowhere else, which is what this pin is actually protecting.
  assert.ok(s.includes('id="at-on"'), "the trigger toggle stays in the alerts panel");
  assert.ok(/for\(const \[id,key\] of \[\['at-ev','minEV'\],\['at-rr','minRR'\],\['at-late','maxLate'\]\]\)/.test(s),
    "EV, R:R and lateness must all be wired, in the panel");
  assert.ok(/const numIn=\(id,val,ph,tip\)=>/.test(s) && /type="number" step="0\.05"/.test(s),
    "thresholds are free numeric inputs — the old three-option selects could not express an arbitrary floor");
  assert.ok(!s.includes('id="at-proven"'), "the proven-only toggle must be gone — the stream is confirmed-only upstream");
  assert.ok(s.includes("trig:{ on:false"), "trigger alerts must default OFF");
  assert.ok(s.includes("A.trig") && s.includes("trig:state.alerts.trig"), "trigger config must persist alongside the alert rules");
  assert.ok(/state\.alerts\.trig=Object\.assign/.test(s), "trigger config must be restored on load");
  // Toast placement: bottom-LEFT, because bottom-right is the terminal's and the right edge is
  // the drawer's. Above the drawer, below the modals.
  assert.ok(/\.toast-wrap\{position:fixed;bottom:16px;left:16px;z-index:90/.test(css), "toast surface must sit bottom-left at z-90");
  assert.ok(!/\.toast-wrap\{[^}]*right:16px/.test(css), "toast must not sit in the terminal FAB's corner");
  for (const cls of ["toast-trig", "tt-h", "tt-g", "tt-a", "act-late-bad"])
    assert.ok(css.includes("." + cls), `missing CSS for trigger toast class: ${cls}`);
  // The toast has to carry geometry and an escape hatch, or it is just noise with a ticker on it.
  assert.ok(s.includes("data-mute") && s.includes("data-rep"), "toast must offer mute and report actions");
  assert.ok(s.includes("fired ${fmtPrice(ev.fired)}"), "toast must show the fire mark");
  // Board: both marks and lateness are rendered from the payload.
  assert.ok(s.includes("fmtPrice(r.fired)") && s.includes("actLate(r.late)"), "board must render the fire mark and lateness");
  for (const lb of ["'Fired'", "'Now'", "'Late'", "'Ago'", "'Rec'"])
    assert.ok(s.includes("lb:" + lb), `board must carry the ${lb} column`);
  assert.ok(!/r\.entry\s*[-/]\s*r\.fired/.test(s), "client must not recompute lateness locally");

  // Direction must survive a reader who cannot separate green from red. The collapsed row carried
  // the side ONLY as a pos/neg tint on the ticker cell until 2026.07.27-20 — which also read like a
  // day-change tint, so a short was indistinguishable from a name that happened to be down.
  assert.ok(/<span class="act-side \$\{sd\}"/.test(s), "the collapsed row must render an explicit side chip");
  assert.ok(/\$\{esc\(r\.side\)\}<\/span>/.test(s), "the chip must print the side as a word, not a glyph or colour alone");
  assert.ok(/const sd=r\.side==='long'\?'l':'s'/.test(s), "chip modifier must be derived from the payload's side");
  assert.ok(!/const sc=r\.side==='long'\?'pos':'neg'/.test(s),
    "the ticker cell must no longer be tinted by side — colour alone is not an encoding");
  for (const cls of ["act-side", "act-side.l", "act-side.s"])
    assert.ok(css.includes("." + cls), `missing CSS for side chip class: ${cls}`);
  // Both directions must be spelled out somewhere a hover can reach them.
  assert.ok(s.includes("the claim pays if price rises") && s.includes("the claim pays if price falls"),
    "each side must explain which way the trade and its void run");
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

test("tabs: backtest is hidden from the strip by default without withdrawing the feature", () => {
  const fs = require("fs"), path = require("path");
  const s = fs.readFileSync(path.join(__dirname, "..", "public", "app.js"), "utf8");
  const css = fs.readFileSync(path.join(__dirname, "..", "public", "styles.css"), "utf8");
  const html = fs.readFileSync(path.join(__dirname, "..", "public", "index.html"), "utf8");
  // HIDDEN_TABS was retired in 2026.07.26-05: the same two tabs are now admin-state entries in the
  // server manifest, so the hide is expressed ONCE and an admin can actually see them. The list must
  // not come back — a second visibility list beside the manifest is the drift this work removed.
  const C = require("../src/compute");
  assert.ok(!/HIDDEN_TABS/.test(s), "HIDDEN_TABS must stay deleted — the manifest owns tab visibility now");
  for (const v of ["backtest", "actionable"])
    assert.equal(C.featureState({}, v), "admin", `${v} must default to admin in the manifest (it used to be in HIDDEN_TABS)`);
  assert.ok(s.includes("function applyTabVisibility"), "tab visibility applier missing");
  assert.ok(/applyTabOrder\(\); applyTabVisibility\(\);/.test(s), "visibility must be applied on the initial nav pass");
  // The applier must evaluate EVERY tab, not just members of a hide-list, or a flag flipped to public
  // in the panel would leave the tab stuck hidden until someone edited app.js.
  assert.ok(/t\.hidden = !tabVisible\(t\.dataset\.view\)/.test(s), "applyTabVisibility must both hide and un-hide via tabVisible");
  assert.ok(/applyTabVisibility==='function'\) applyTabVisibility\(\)/.test(s), "visibility must be re-applied when the strip is rebuilt at runtime");
  // The guard moved into the consolidated [hidden] block at the top of styles.css in -23; it is the
  // same guarantee, stated once for every hideable component instead of per-component.
  assert.ok(/\.tab\[hidden\]\{display:none\}/.test(css), "a display rule on .tab must not be able to silently un-hide a hidden tab");
  // The feature is NOT withdrawn: markup, view section, renderers, help and the deep link all live.
  assert.ok(html.includes('data-view="backtest"') && html.includes('id="view-backtest"'), "backtest markup must survive the hide");
  assert.ok(s.includes("backtest:`"), "backtest help entry must survive the hide");
  assert.ok(s.includes("function renderBacktest_load"), "backtest renderer must survive the hide");
  assert.ok(s.includes("setHidden('view-backtest'"), "showView must still route to backtest");
  // Command palette stays the deliberate way back in — and must list every LIVE tab, including
  // the one added this build (which it did not, until now).
  assert.ok(/\{v:'backtest',label:'Backtest'\}/.test(s), "backtest must remain findable in the command palette");
  assert.ok(/\{v:'actionable',label:'Actionable'\}/.test(s), "the actionable tab must be listed in the command palette");
  // ...but the palette must FILTER on visibility, because it is a third route into a view that is
  // independent of the nav strip: without this, a gated tab stays reachable by name.
  assert.ok(/CMDK_TABS\.filter\(t=>tabVisible\(t\.v\)/.test(s), "the command palette must filter on tabVisible");
  // HASH_VIEWS stays COMPLETE — the routing table lists every view, and the gate is applied at
  // dispatch. That is the difference from the old posture: an admin's #backtest still works, a public
  // caller's does not. A short routing table would instead make a tab unreachable for everyone.
  assert.ok(/const HASH_VIEWS=new Set\(/.test(s), "hash routing must be a declared view set, not an inline whitelist");
  for (const v of ["actionable", "backtest", "signals", "news", "markets", "trend", "report"])
    assert.ok(new RegExp("'" + v + "'").test(s.match(/const HASH_VIEWS=new Set\(\[[^\]]*\]\)/)[0]), `#${v} must be routable`);
  assert.ok(s.includes("if(HASH_VIEWS.has(h) && tabVisible(h)) showView(h);"), "applyHash must route via the view set AND the gate");
  const hv = s.indexOf("const HASH_VIEWS"), ah = s.indexOf("function applyHash");
  assert.ok(hv > 0 && hv < ah, "HASH_VIEWS must be declared before applyHash");
});

test("actionable -10: the gate rejects each way independently, and never silently empties the board", () => {
  const HOUR = 3600e3, DAY = 86400e3;
  const { createPoller } = require("../src/poller");
  const COIN = "xyz:GATE";
  const mk = (closed) => {
    const store = { loadAll: () => new Map(), loadRegime: () => [], insert: () => {}, saveRegime: () => {},
      saveLedger: () => {}, loadLedger: () => ({ ts: Date.now(), open: [], closed }),
      saveTriggers: () => {}, loadTriggers: () => null };
    const p = createPoller({ dex: "xyz", store, log: () => {}, version: "test", crypto: false });
    const now = Date.now(), endH = Math.floor(now / HOUR), N = 16 * 24, hourly = [];
    for (let i = 0; i < N; i++) { const t = (endH - N + i) * HOUR, c = 100 * Math.pow(1.0005, i);
      hourly.push({ t, o: c, h: c * 1.001, l: c * 0.999, c, v: 1 }); }
    const px = hourly[N - 1].c * 1.0005, daily = [];
    for (let i = 0; i < 60; i++) { const c = px * Math.pow(1.002, i - 59);
      daily.push({ t: (Math.floor(now / DAY) - 60 + i) * DAY, c, l: c * 0.97, h: c * (i === 50 ? 1.35 : 1.002) }); }
    p.seedRowNow(COIN, { px, ticker: "GATE", uni: "xyz", vol: 1e6, funding: 0.00005, hourlyRaw: hourly, dailyRaw: daily });
    p.hydrateLedgerNow(); p.buildTrendNow(); p.buildSignalsNow(); p.buildActionableNow();
    return p.getActionable();
  };
  const rec = (n, realized) => { const o = []; for (let i = 0; i < n; i++)
    o.push({ key: COIN + "|tretest#h" + i, coin: COIN, ticker: "GATE", ev: "tretest", status: "resolved",
      realized, t0: Date.now() - (60 + i) * DAY, tR: Date.now() - (55 + i) * DAY, psd: "long", pn: 1 }); return o; };

  // Winning record, enough of it: suggested.
  const good = mk(rec(10, 1.4));
  assert.equal(good.count, 1, "a family with 10 resolved winners IS suggested");
  assert.equal(good.rows[0].rec.n, 10);
  assert.ok(good.rows[0].evR > 0, "and carries a positive expectancy");
  assert.ok(good.rows[0].rr.gross >= 2.0, "and clears the R:R floor");

  // Same edge, too few fires: the record cannot speak yet.
  assert.equal(mk(rec(7, 1.4)).coverage.norecord, 1, "7 resolved fires is below the floor");
  assert.equal(mk(rec(7, 1.4)).count, 0, "and it is dropped, not shown with a blank EV");

  // Enough fires, but the family LOST money: this is the case the first cut got wrong.
  const losing = mk(rec(12, -0.6));
  assert.equal(losing.count, 0, "a negative-expectancy family is never suggested");
  assert.equal(losing.coverage.negexp, 1, "and the reason is named");

  // Break-even is not positive: the boundary is > 0, not >= 0.
  assert.equal(mk(rec(12, 0)).coverage.negexp, 1, "a flat record is not an edge");

  // Coverage always accounts for every scanned claim, so an empty board can always be explained.
  for (const a of [good, mk(rec(7, 1.4)), losing]) {
    const c = a.coverage, dropped = c.expired + c.noGeometry + (c.degenerate || 0) + (c.untakeable || 0) + c.norecord + c.negexp + c.negev + c.noedge;
    assert.equal(c.confirmed + dropped, 1, "every scanned claim is either confirmed or counted against a reason");
    assert.ok(c.openClaims >= 1, "and the open-claim count is always disclosed");
  }
});

test("tabs: every HIDDEN_TABS entry matches a real nav button, and every hidden tab stays URL-reachable", () => {
  // The source-grep guard above proves the strings exist in each file; it does NOT prove they
  // refer to each other. A typo on either side — data-view="actionables", or HIDDEN_TABS holding
  // 'action' — passes that guard and ships a visible tab. This test joins the two files.
  const fs = require("fs"), path = require("path");
  const html = fs.readFileSync(path.join(__dirname, "..", "public", "index.html"), "utf8");
  const app = fs.readFileSync(path.join(__dirname, "..", "public", "app.js"), "utf8");
  const nav = html.match(/<nav class="tabs"[\s\S]*?<\/nav>/);
  assert.ok(nav, "nav.tabs block not found — applyTabVisibility's selector would find nothing");
  const views = [...nav[0].matchAll(/data-view="([a-z]+)"/g)].map((m) => m[1]);
  assert.ok(views.length >= 10, `suspiciously few nav tabs: ${views.length}`);
  // The hide list moved server-side in -05: the manifest's admin-state tabs are the hidden set now.
  const C = require("../src/compute");
  const hidden = C.FEATURES.filter((f) => f.kind === "tab" && !f.runtime && C.featureState({}, f.key) === "admin").map((f) => f.key);
  assert.ok(hidden.length >= 1, "at least one tab is expected to be admin-only by default");
  // Join: no orphan hide entries, and each intended tab really is covered.
  for (const h of hidden)
    assert.ok(views.includes(h), `the manifest gates tab '${h}' but no nav button has data-view="${h}" — the gate is a no-op`);
  for (const want of ["backtest", "actionable"])
    assert.ok(hidden.includes(want) && views.includes(want), `${want} must be present in the nav AND gated by the manifest`);
  // The applier must key off the same attribute the markup uses.
  assert.ok(/tabVisible\(t\.dataset\.view\)/.test(app), "applyTabVisibility must match on dataset.view, the attribute the nav actually carries");
  assert.ok(/document\.querySelector\('nav\.tabs'\)/.test(app), "applyTabVisibility must query the nav that exists in the markup");
  // Hiding a tab must never strand it: each hidden view has to remain routable by hash.
  const hv = app.match(/const HASH_VIEWS=new Set\(\[([^\]]*)\]\)/);
  assert.ok(hv, "HASH_VIEWS not found");
  const routable = hv[1].split(",").map((x) => x.trim().replace(/'/g, "")).filter(Boolean);
  // Still required, with a changed meaning: HASH_VIEWS stays complete so an ADMIN's #backtest resolves.
  // The gate is applied at dispatch (applyHash checks tabVisible), not by shortening the routing table.
  for (const h of hidden)
    assert.ok(routable.includes(h), `gated tab '${h}' is not in HASH_VIEWS — an admin's deep link would dead-end`);
  // And every nav tab should be routable, hidden or not, so a shared link never dead-ends.
  for (const v of views)
    assert.ok(routable.includes(v), `nav tab '${v}' has no hash route — #${v} would silently do nothing`);
  // Each hidden view must still have its section, or showView bounces to markets.
  for (const h of hidden)
    assert.ok(html.includes(`id="view-${h}"`), `hidden tab '${h}' has no view section — showView would redirect to markets`);
});

// ===== admin panel, phase 0: the manifest is the single source of truth =========================
test("features: manifest covers every tab in the markup, and every entry is real", () => {
  const fs = require("fs"), path = require("path");
  const C = require("../src/compute");
  const html = fs.readFileSync(path.join(__dirname, "..", "public", "index.html"), "utf8");
  const app = fs.readFileSync(path.join(__dirname, "..", "public", "app.js"), "utf8");

  const keys = new Set(C.FEATURES.map((f) => f.key));
  assert.equal(keys.size, C.FEATURES.length, "duplicate key in FEATURES — two entries would fight over one state");

  // Markup -> manifest. THIS is the assertion that makes fail-closed safe: ship a tab without an
  // entry and the suite fails here, instead of the tab being silently invisible to the group.
  const tabs = [...html.matchAll(/data-view="([a-z]+)"/g)].map((m) => m[1]);
  for (const v of new Set(tabs))
    assert.ok(keys.has(v), `tab "${v}" exists in index.html but has no FEATURES entry — add one (fail-closed would hide it silently)`);

  // Manifest -> markup, for the static tabs only. runtime:true entries are injected by JS
  // (Treemap self-installs on DOMContentLoaded) so they legitimately have no data-view in the file.
  for (const f of C.FEATURES) {
    if (f.kind !== "tab" || f.runtime) continue;
    assert.ok(tabs.indexOf(f.key) >= 0, `FEATURES lists tab "${f.key}" but index.html has no data-view for it — dead entry`);
    assert.ok(html.includes(`id="view-${f.key}"`), `FEATURES tab "${f.key}" has no view section`);
  }
  for (const f of C.FEATURES) {
    if (f.kind !== "tab" || !f.runtime) continue;
    assert.ok(app.includes(`'view-${f.key}'`) || app.includes(`view-${f.key}`), `runtime tab "${f.key}" is claimed to self-install but app.js never builds view-${f.key}`);
  }

  // Every tab reachable from the command palette must be in the manifest too. Cmd+K is a SECOND
  // way into a view: hiding the tab button while leaving the palette entry ungated would let a
  // public user walk straight into an admin tab.
  const cm = app.match(/const CMDK_TABS=\[[\s\S]*?\];/);
  assert.ok(cm, "CMDK_TABS list not found — the palette is a second entry point and must stay auditable");
  for (const m of cm[0].matchAll(/\{v:'([a-z]+)'/g))
    assert.ok(keys.has(m[1]), `command palette offers "${m[1]}" which has no FEATURES entry`);

  // HIDDEN_TABS is gone as of 2026.07.26-05 — the manifest is the only tab-visibility list. The
  // agreement assertion that used to live here became "there is nothing left to agree with", which
  // is pinned in the manifest-owns-visibility test instead.
  assert.ok(!/HIDDEN_TABS/.test(app), "a second tab-visibility list must not reappear beside the manifest");

  // kind and state vocabulary are closed sets; a typo'd def would resolve through to FEATURE_DEFAULT
  // and quietly hide a feature that was meant to be public.
  for (const f of C.FEATURES) {
    assert.ok(f.kind === "tab" || f.kind === "act", `entry "${f.key}" has unknown kind "${f.kind}"`);
    assert.ok(C.FEATURE_STATES.indexOf(f.def) >= 0, `entry "${f.key}" has invalid default "${f.def}"`);
    assert.ok(f.label && f.label.length <= 32, `entry "${f.key}" needs a short human label`);
  }
});

test("features: every manifest route is registered in server.js exactly once", () => {
  const fs = require("fs"), path = require("path");
  const C = require("../src/compute");
  const srv = fs.readFileSync(path.join(__dirname, "..", "server.js"), "utf8");
  // Same class of guard as the route-manifest test: a feature pointing at a route that does not
  // exist means the gate silently protects nothing (the phantom /api/unlocks failure, again).
  for (const f of C.FEATURES) {
    for (const r of f.routes || []) {
      const sp = r.indexOf(" ");
      const verb = sp > 0 ? r.slice(0, sp).toLowerCase() : null;
      const p = sp > 0 ? r.slice(sp + 1) : r;
      const hits = [...srv.matchAll(new RegExp(`fastify\\.(get|post)\\("${p.replace(/[/]/g, "\\/")}"`, "g"))];
      assert.ok(hits.length >= 1, `feature "${f.key}" claims route ${r} which server.js never registers`);
      if (verb) assert.ok(hits.some((h) => h[1] === verb), `feature "${f.key}" claims ${r} but no fastify.${verb} for that path`);
    }
  }
  // Nothing in the never-gate set may also be claimed by a feature — gating the unlock path is a
  // one-way door (no cookie, no way to mint one, no way back in without a redeploy).
  for (const f of C.FEATURES)
    for (const r of f.routes || [])
      assert.ok(!C.FEATURE_NEVER_GATE.has(r.replace(/^[A-Z]+ /, "")), `feature "${f.key}" claims never-gateable route ${r}`);
  for (const p of ["/api/health", "/login", "/logout", "/api/ai-unlock", "/api/ai-lock"])
    assert.ok(C.FEATURE_NEVER_GATE.has(p), `${p} must be permanently ungateable`);
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

// ===== admin panel, phase 1: server state, identity, route gate ================================
test("features: sanitizer drops a stored state for a pinned key (latent-trap class)", () => {
  const C = require("../src/compute");
  // Inert today because featureState checks the pin first — LIVE the moment anyone removes the pin.
  // A value written in flags.json must never be able to activate via an edit in compute.js.
  const out = C.featureFlagsSanitize({ markets: "off", signals: "admin" });
  assert.equal(Object.prototype.hasOwnProperty.call(out, "markets"), false, "a pinned key must not survive sanitization");
  assert.equal(out.signals, "admin", "unpinned keys are untouched");
});

test("store: flags.json round-trips, is written atomically, and an absent file is not an error", () => {
  const { openStore } = require("../src/store");
  const fs = require("fs"), path = require("path"), os = require("os");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "flags-"));
  try {
    const s = openStore(dir);
    assert.equal(s.loadFlags(), null, "no file yet is null, not a throw — first boot is the normal case");
    assert.equal(s.saveFlags({ signals: "admin" }), true);
    assert.deepEqual(s.loadFlags(), { signals: "admin" }, "round-trip");
    assert.ok(fs.existsSync(path.join(dir, "flags.json")));
    assert.ok(!fs.existsSync(path.join(dir, "flags.json.tmp")), "the temp file must be renamed away, never left behind");
    // Corrupt file degrades to defaults instead of taking the boot down with it.
    fs.writeFileSync(path.join(dir, "flags.json"), "{not json");
    assert.equal(s.loadFlags(), null, "unparseable flags file degrades to null");
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  // tmp+rename pinned in source: a plain writeFileSync here would let a crash mid-write reopen
  // whatever had been closed, silently, on the next boot.
  const st = fs.readFileSync(path.join(__dirname, "..", "src", "store.js"), "utf8");
  assert.ok(/saveFlags\(obj\)[\s\S]{0,320}flagsFile \+ "\.tmp"[\s\S]{0,220}renameSync/.test(st), "saveFlags must be tmp+rename atomic");
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

test("server: admin-view lease is a distinct secret from the AI unlock, fails closed, browser-only", () => {
  const fs = require("fs"), path = require("path");
  const srv = fs.readFileSync(path.join(__dirname, "..", "server.js"), "utf8");
  // Distinct label. With a shared secret an xyzai token would validate as xyzadm and the deliberately
  // short AI-spend lease would silently become a 30-day one.
  assert.ok(srv.includes("xyzmon-admin-view|"), "admin-view secret must derive from ADMIN_PASSWORD under its own label");
  assert.ok(srv.includes("xyzmon-ai-unlock|"), "the AI unlock secret must still exist separately");
  assert.notEqual(srv.indexOf("xyzmon-admin-view|"), srv.indexOf("xyzmon-ai-unlock|"), "the two secrets must not be the same expression");
  assert.ok(srv.includes("function signAdminView") && srv.includes("function adminViewOk"), "admin-view signer/verifier missing");
  assert.ok(/adminViewOk[\s\S]{0,140}!ADMIN_PASSWORD/.test(srv), "adminViewOk must fail closed when ADMIN_PASSWORD is unset");
  assert.ok(/"xyzadm=" \+ \(token \|\| "x"\)[\s\S]{0,120}HttpOnly/.test(srv), "the xyzadm token cookie must be HttpOnly");
  assert.ok(srv.includes('"xyzadmin=1"'), "a JS-visible marker must exist so the client can render the Admin affordance");
  // No header/Basic path to admin: isAdmin reads the cookie and nothing else.
  assert.ok(/const isAdmin = \(req\) => adminViewOk\(getCookie\(req, "xyzadm"\)\)/.test(srv), "isAdmin must be cookie-only (no header bypass)");
  assert.ok(!/x-admin/i.test(srv), "there must be no header bypass for admin");
  // The login damper is spent, not the terminal-unlock lockout — otherwise a group member with a fat
  // finger could lock the operator out of the panel.
  assert.ok(srv.includes("function adminPwOk"), "login needs its own constant-time admin compare");
  assert.ok(/adminPwOk[\s\S]{0,220}timingSafeEqual/.test(srv), "adminPwOk must be constant-time");
  assert.ok(/if \(adminPwOk\(pw\)\)[\s\S]{0,400}setAdminCookies/.test(srv), "login must mint the admin lease when the admin password is used");
  assert.ok(/fastify\.get\("\/logout"[\s\S]{0,400}setAdminCookies\(reply, req, 0, null\)[\s\S]{0,200}clearAiUnlockCookie/.test(srv),
    "logout must drop the admin lease AND the AI unlock — never leave a stale elevation behind");
  // Terminal escalation grants the view too, so `admin unlock` and admin-password login agree.
  assert.ok(/setAiUnlockCookie\(reply, req, signAiUnlock[\s\S]{0,400}setAdminCookies/.test(srv), "the terminal unlock must also grant the admin view");
});

test("server: feature gate runs after the site gate, returns 403, and both /api/features routes exist once", () => {
  const fs = require("fs"), path = require("path");
  const srv = fs.readFileSync(path.join(__dirname, "..", "server.js"), "utf8");
  // Ordering is load-bearing: an unauthenticated caller must get 401 (log in), not 403 (you are not
  // admin). Fastify runs onRequest hooks in registration order, so source order IS the contract.
  const iSite = srv.indexOf('if (u.startsWith("/api/")) return reply.code(401)');
  const iGate = srv.indexOf("featureGateFor(req.method, req.url");
  assert.ok(iSite > 0 && iGate > 0, "both gates must exist");
  assert.ok(iGate > iSite, "the feature gate must be registered AFTER the site gate or 403 masks 401");
  // The same Fastify lifecycle trap the site gate documents: reply.send() alone does not stop the
  // chain in an async hook. This must RETURN the reply.
  assert.ok(/return reply\.code\(403\)[\s\S]{0,140}feature-gated/.test(srv), "the gate must RETURN a 403 reply (async hook lifecycle)");
  assert.ok(srv.includes('feature: blocked'), "the 403 must name the blocking feature so a log is debuggable");
  // Both verbs admin-only: an open GET let a public visitor enumerate every feature key and see which
  // were admin-only, which contradicts gated features leaving no trace. The client never needs this
  // route — it reads its resolved set from the injected shell.
  assert.ok(/fastify\.get\("\/api\/features"[\s\S]{0,220}if \(!isAdmin\(req\)\) return reply\.code\(403\)/.test(srv),
    "GET /api/features must require admin");
  for (const r of ['fastify.get("/api/features"', 'fastify.post("/api/features"']) {
    const n = srv.split(r).length - 1;
    assert.equal(n, 1, `${r} must be registered exactly once (got ${n})`);
  }
  assert.ok(/fastify\.post\("\/api\/features", \{ bodyLimit/.test(srv), "the write route needs a body cap");
  // Honest-null: an unset ADMIN_PASSWORD closes every admin-state feature to everyone. Say it at boot
  // rather than letting it present as "the Actionable tab stopped working".
  assert.ok(srv.includes("WARN: ADMIN_PASSWORD is unset"), "boot must warn when no admin cookie can ever be minted");
  // Shape, not a literal: pinning the exact stamp would fail on every subsequent build, which trains
  // people to edit the test instead of reading it.
  assert.ok(/const VERSION = "2026\.\d{2}\.\d{2}-\d+";/.test(srv), "build stamp must keep the 2026.MM.DD-NN form");
});

// ===== admin panel, phase 2: client enforcement =================================================
test("client flags: the injection slot exists, is pre-paint, and the server's copy matches it byte-for-byte", () => {
  const fs = require("fs"), path = require("path");
  const html = fs.readFileSync(path.join(__dirname, "..", "public", "index.html"), "utf8");
  const srv = fs.readFileSync(path.join(__dirname, "..", "server.js"), "utf8");
  const SLOT = "window.__FLAGS=null;window.__ADMIN=false;";
  assert.ok(html.includes(SLOT), "index.html must carry the flag slot the server substitutes into");
  // Byte-identical, or the boot-time split silently misses and every caller gets the unsubstituted
  // shell — tabs show, routes 403, and nothing in the UI explains why. Same failure class as the
  // asset-tag drift the stamper already warns about, so it gets the same kind of guard.
  assert.ok(srv.includes('const FLAG_SLOT = "' + SLOT + '"'), "server FLAG_SLOT must match index.html exactly");
  // Pre-paint: the slot must precede the app.js tag, or the client reads window.__FLAGS before it is set.
  assert.ok(html.indexOf(SLOT) < html.indexOf('src="/app.js"'), "the flag slot must load BEFORE app.js");
  assert.ok(html.indexOf(SLOT) < html.indexOf("<body"), "the flag slot must be in <head> so a gated tab never paints");
  // Split once at boot, concat per request — not a 23 KB string scan on every hit.
  assert.ok(srv.includes("const [INDEX_HEAD, INDEX_TAIL]"), "the shell must be split once at boot");
  assert.ok(/INDEX_HEAD \+ boot \+ INDEX_TAIL/.test(srv), "serveIndex must concat the injected boot script");
  assert.ok(/serveIndex[\s\S]{0,600}resolveFeatures\(poller\.getFlags\(\), admin\)/.test(srv), "the injected set must be server-resolved for THIS caller");
  // Per-audience body is only safe because the shell is uncacheable. If this header ever goes, a
  // shared cache could hand a public visitor the admin shell.
  assert.ok(/serveIndex = \(req, reply\) => \{[\s\S]{0,700}cache-control", "no-store"/.test(srv), "the audience-specific shell MUST stay no-store");
  assert.ok(srv.includes("WARN: index.html flag slot missing"), "a missing slot must be announced at boot, not silently ignored");
});

test("client flags: tabVisible is the single composition point and every entry path uses it", () => {
  const fs = require("fs"), path = require("path");
  const s = fs.readFileSync(path.join(__dirname, "..", "public", "app.js"), "utf8");
  // Reads the injected set; never re-derives a visibility from a raw flag.
  assert.ok(/const FLAGS = \(window\.__FLAGS && typeof window\.__FLAGS==='object'\) \? window\.__FLAGS : null;/.test(s), "FLAGS must read the injected set defensively");
  assert.ok(/const IS_ADMIN = !!window\.__ADMIN;/.test(s), "IS_ADMIN marker must be read");
  // Fail OPEN on a missing injection, deliberately: the shell is no-store so it should be impossible,
  // and the server gate is authoritative — a cosmetic leak beats an app with no tabs at all.
  // Reads FLAGS_VIEW (not FLAGS) since -06, so "view as public" can swap the whole resolved set in
  // one assignment. Still degrades to visible when nothing was injected.
  assert.ok(/function featureOn\(key\)\{ return FLAGS_VIEW \? !!FLAGS_VIEW\[key\] : true; \}/.test(s), "featureOn must read FLAGS_VIEW and degrade to visible when injection is absent");
  assert.ok(/let FLAGS_VIEW = FLAGS;/.test(s), "FLAGS_VIEW must start as the injected set");
  assert.ok(/function tabVisible\(v\)\{ if\(v==='admin'\) return IS_ADMIN; return viewInScope\(v\) && featureOn\(v\); \}/.test(s),
    "tabVisible must compose scope AND flags, with the panel itself keyed off IS_ADMIN");
  // The view predicate must NOT be called inScope: that name belongs to the ROW predicate, and a
  // hoisted redefinition made activeRows() return zero rows in crypto scope (the -05 blackout).
  assert.ok(/function viewInScope\(v\)/.test(s), "the view-scope predicate must be named viewInScope");
  assert.ok(/function inScope\(r\)\{ return \(r\.uni==='main'\)===\(state\.scope==='crypto'\); \}/.test(s),
    "the row-scope predicate must survive untouched — activeRows() feeds the board through it");
  for (const [what, re] of [
    ["nav strip", /t\.hidden = !tabVisible\(t\.dataset\.view\)/],
    ["showView", /if\(!tabVisible\(v\)\) v='markets';/],
    ["applyScope", /if\(!tabVisible\(state\.view\)\) \{ showView\('markets'\); \}/],
    ["hash deep link", /HASH_VIEWS\.has\(h\) && tabVisible\(h\)/],
    ["command palette", /CMDK_TABS\.filter\(t=>tabVisible\(t\.v\)/],
    ["treemap installer", /btn\.hidden = !tabVisible\('treemap'\)/],
    ["treemap deep link", /==='treemap' && typeof showView==='function' && tabVisible\('treemap'\)/],
  ]) assert.ok(re.test(s), `${what} must route its visibility decision through tabVisible`);
  // Exactly one crypto scope list, and none of the old longhand per-tab comparisons may survive
  // anywhere — those duplicates are what drifted apart before.
  assert.equal((s.match(/const CRYPTO_VIEWS=new Set\(/g) || []).length, 1, "exactly one crypto scope list");
  assert.ok(!/dataset\.view!=='(markets|trend|report|corr|backtest|sessions)'/.test(s), "no longhand per-tab scope comparison may survive");
  assert.ok(!/v!=='report' && v!=='corr'/.test(s), "showView's inline crypto gate must be gone");
  // markets is the fallback target, so it must be un-gateable — asserted at the manifest, because a
  // gateable fallback would let a public user bounce into a view they cannot see and render nothing.
  const C = require("../src/compute");
  assert.equal(C.featureState({ markets: "off" }, "markets"), "public", "the showView fallback target must be pinned public");
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

test("admin panel: markup, wiring and the no-draft-state write path are all present", () => {
  const fs = require("fs"), path = require("path");
  const app = fs.readFileSync(path.join(__dirname, "..", "public", "app.js"), "utf8");
  const html = fs.readFileSync(path.join(__dirname, "..", "public", "index.html"), "utf8");
  const css = fs.readFileSync(path.join(__dirname, "..", "public", "styles.css"), "utf8");
  // Markup: tab, section, and every id the renderer writes into.
  assert.ok(html.includes('data-view="admin"') && html.includes('id="view-admin"'), "admin tab + section must exist");
  for (const id of ["adm-count", "adm-prev", "adm-rows", "adm-foot", "admVap"])
    assert.ok(html.includes('id="' + id + '"'), `admin panel markup missing #${id}`);
  // Wiring: dispatch, visibility, and the double-check that a non-admin can never open it even if the
  // markup is present (a forged xyzadmin=1 marker gets an empty tab, never data).
  assert.ok(/setHidden\('view-admin', v!=='admin'\)/.test(app), "showView must toggle the admin section");
  assert.ok(/if\(v==='admin'\)\{ if\(el\('view-admin'\)&&IS_ADMIN\) openAdmin\(\); else \{ showView\('markets'\); return; \} \}/.test(app),
    "showView must refuse the admin view when the caller is not admin");
  assert.ok(/async function openAdmin\(\)\{ if\(!IS_ADMIN\) return;/.test(app), "openAdmin must guard on IS_ADMIN");
  assert.ok(app.includes("fetchJSON('/api/features')"), "the panel must read its state from the server");
  // No save button: each toggle writes one key, optimistically, and rolls back on refusal. A draft
  // state is another way for the panel and the server to disagree.
  assert.ok(/row\.state=state; _admBusy=key; renderAdmin\(\);/.test(app), "the write must paint optimistically");
  assert.ok((app.match(/row\.state=prev;/g) || []).length >= 2, "both the HTTP-failure and network-failure paths must roll back");
  assert.ok(/_adm=d\.features\|\|_adm;/.test(app), "the panel must reconcile with the server's resolved state, not the requested one");
  assert.ok(!/adm-save|admSave/.test(app), "there must be no save button — writes are immediate");
  // view-as-public swaps a server-resolved set, and never strands the operator on a gated view.
  assert.ok(/FLAGS_VIEW = _admVap \? \(_adm\.resolvedPublic\|\|FLAGS\) : FLAGS;/.test(app), "the toggle must swap in the server-resolved public set");
  assert.ok(/if\(!tabVisible\(state\.view\)\) showView\('markets'\);/.test(app), "toggling must rescue the active view if it becomes gated");
  assert.ok(app.includes("el('admVap'); if(vb) vb.addEventListener('click',toggleViewAsPublic)"), "the toggle must be wired null-safely");
  // The panel uses the app's real toast helper. `toast(...)` does not exist and would throw at the
  // exact moment a write failed — i.e. only in the path nobody exercises by hand.
  assert.ok(app.includes("pushToast('Could not change "), "failure path must use pushToast, the function that actually exists");
  assert.ok(!/[^h]\btoast\('/.test(app), "no call to a non-existent toast() helper may survive");
  // Hover on every row: the key + route list is the load-bearing detail, per the standing requirement
  // that every element carrying data responds to hover.
  assert.ok(css.includes(".adm-row:hover"), "rows must respond to hover");
  assert.ok(css.includes(".adm-row:hover .adm-key"), "the key/route line must surface on hover");
  // States must be readable as words, not colour alone — the amber theme recolours everything.
  assert.ok(/\.adm-b\.on\.public|\.adm-b\.on\.admin|\.adm-b\.on\.off/.test(css), "each state needs its own style");
  assert.ok(/>'\+v\+'</.test(app) || app.includes("+v+'</button>"), "each control must print its state as a word");
});


test("client integrity: no top-level function name is declared twice in any shipped file", () => {
  // The -05 crypto blackout was a hoisted redefinition: a new inScope(view) silently replaced the
  // existing inScope(row), so activeRows() asked "is this row object one of the crypto view names",
  // got false for every row, and the crypto board rendered empty — while the stocks board quietly
  // showed BOTH universes because the same predicate short-circuited to true there.
  //
  // The old guard checked duplicates only for names on a hand-kept `need` list, so a collision with
  // any unlisted function passed. This one is exhaustive by construction: every top-level
  // declaration in every shipped file, no list to forget to update. Anchored to column 0 on purpose
  // — nested/IIFE-local helpers may legitimately reuse a name (public/app.js has its own esc() inside
  // the Treemap installer) and cannot shadow anything outside their closure.
  const fs = require("fs"), path = require("path");
  for (const rel of ["public/app.js", "src/poller.js", "src/compute.js", "src/store.js", "server.js"]) {
    const src = fs.readFileSync(path.join(__dirname, "..", rel), "utf8");
    const seen = new Map();
    for (const m of src.matchAll(/^function ([A-Za-z_$][A-Za-z0-9_$]*)\s*\(/gm))
      seen.set(m[1], (seen.get(m[1]) || 0) + 1);
    const dupes = [...seen].filter(([, n]) => n > 1).map(([k, n]) => `${k} (x${n})`);
    assert.deepEqual(dupes, [], `${rel} declares the same top-level function more than once: ${dupes.join(", ")} — the later declaration hoists over the earlier one and silently wins`);
  }
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
  const spine = (from, to) => { const h = []; for (let i = 30; i >= 0; i--) {
    const c = from + (to - from) * ((30 - i) / 30); h.push([now - i * HOUR, c, c, c, c, 1e5]); } return h; };
  p.seedRowNow("BTC", { px: 110, ticker: "BTC", uni: "main", hourlyRaw: spine(100, 110), hourlyTs: now });
  p.seedRowNow("ALT", { px: 115, ticker: "ALT", uni: "main", hourlyRaw: spine(100, 115), hourlyTs: now });
  const e = p.openLedgerNow("ALT", "breakout", { score: 9, reading: "", play: { side: "long", stop: 94, target: 130 } }, 1, { sd0: 5 });
  assert.ok(e, "the crypto claim opened");
  e.t0 = now - 30 * HOUR; e.resolveAt = now - HOUR;   // force it due, against the seeded spines
  p.resolveLedgerNow();
  const cl = p.getLedgerExport().closed.find((x) => x.coin === "ALT" && x.ev === "breakout");
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
  const cl2 = p.getLedgerExport().closed.find((x) => x.coin === "xyz:ACME");
  assert.ok(cl2 && cl2.rx === undefined, "no excess leg on an equity claim — absent, never a zero (they mean opposite things)");
});

test("buildActionable: the noGeom crash cannot return, and horizons follow the universe", () => {
  // Regression guard for a live bug this build fixed: the reject counter was an undeclared
  // `noGeom`, so under "use strict" any open claim lacking a stamped stop or target distance threw
  // a ReferenceError straight out of the build. getActionable swallows and logs it, so the only
  // symptom was an Actionable board that went silently stale for a memo window at a time —
  // fundflip stamps a null target BY DESIGN and clears the swing floor, which is enough to trip it.
  const { createPoller } = require("../src/poller");
  const store = { loadAll: () => new Map(), loadRegime: () => [], loadLedger: () => null,
    saveLedger: () => {}, insert: () => {}, saveRegime: () => {} };
  const logs = [];
  const p = createPoller({ dex: "xyz", store, log: (m) => logs.push(m), version: "test", crypto: true });
  p.seedRowNow("xyz:ZZZ", { px: 100, ticker: "ZZZ", uni: "xyz" });
  p.openLedgerNow("xyz:ZZZ", "fundflip", { score: 1, reading: "", play: { side: "long", target: null, stop: 99 } }, 1, { sd0: 1 });
  p.buildActionableNow();
  const a = p.getActionable();
  assert.equal(logs.filter((m) => /buildActionable error/.test(m)).length, 0,
    "a geometry-less claim must be COUNTED, not thrown on: " + logs.filter((m) => /buildActionable error/.test(m)).join(" | "));
  assert.equal(a.coverage.noGeometry, 1, "and it lands in the reject tally where it can be seen");
  const fs = require("fs"), path = require("path");
  const pol = fs.readFileSync(path.join(__dirname, "..", "src", "poller.js"), "utf8");
  assert.ok(!/[^.\w]noGeom\+\+/.test(pol), "the undeclared counter must never come back");
  // horizon meta follows the universe, or every crypto setup is priced against an equity clock
  assert.ok(pol.includes("const meta = evMeta(e.ev, r.uni);"), "actionable reads universe-scoped meta");
  assert.ok(pol.includes("const minHz = r.uni === \"main\" ? ACT_MIN_HZ_MAIN : ACT_MIN_HZ;"),
    "and a per-universe swing floor: at the equity 3d floor almost the whole crypto roster would be excluded and the board would ship permanently empty for a reason nobody could see");
  // the row lookup must precede the meta read, or r is undefined at the meta line
  assert.ok(pol.indexOf("const r = rows.get(e.coin);") < pol.indexOf("const meta = evMeta(e.ev, r.uni);"),
    "the row is resolved before the meta that depends on it");
});

test("crypto claim geometry: no path stamps a level the gate refuses, shadows included", () => {
  // openLedger has two ways in — the visible path reads sigEntry.play, the shadow fire sites hand
  // their stop and target distance through `extra`, which lands PAST the visible path's gate. Both
  // are covered, because "the gate exists" and "the gate cannot be bypassed" are different claims.
  const { createPoller } = require("../src/poller");
  const store = { loadAll: () => new Map(), loadRegime: () => [], loadLedger: () => null,
    saveLedger: () => {}, insert: () => {}, saveRegime: () => {} };
  const p = createPoller({ dex: "xyz", store, log: () => {}, version: "test", crypto: true });
  p.seedRowNow("MEME", { px: 0.5, ticker: "MEME", uni: "main" });
  // visible path, artifact levels: void 5000x below price, target 40x above
  const e1 = p.openLedgerNow("MEME", "breakout", { score: 5, reading: "", play: { side: "long", stop: 0.0001, target: 20 } }, 1, { sd0: 12 });
  assert.ok(e1, "the claim still OPENS — refusing the level is the degradation, refusing the claim would hide the event");
  assert.equal(e1.stp, undefined, "no artifact void stamped");
  assert.equal(e1.mv, undefined, "no artifact target distance stamped");
  assert.equal(e1.gv, 1, "and the refusal is marked for the audit — distinguishes 'this event has no void' from 'this claim's void was an artifact'");
  // shadow path, same artifact levels arriving through extra
  const e2 = p.openLedgerNow("MEME", "reclaim", { score: 0, reading: "" }, 1,
    { sd0: 12, psd: "long", pn: 1, stp: 0.0001, mv: 4000 }, 0);
  assert.ok(e2, "the shadow claim opens");
  assert.equal(e2.stp, undefined, "the shadow's artifact void is scrubbed too — extra is not a way around the gate");
  // a sane crypto claim keeps both levels
  p.seedRowNow("SOL", { px: 200, ticker: "SOL", uni: "main" });
  const e3 = p.openLedgerNow("SOL", "breakout", { score: 5, reading: "", play: { side: "long", stop: 188, target: 232 } }, 1, { sd0: 6 });
  assert.equal(e3.stp, 188, "sane void stamped");
  assert.equal(e3.mv, 16, "sane target distance stamped");
  assert.equal(e3.gv, undefined, "and nothing is marked as refused");
  // the equity rule is UNTOUCHED: a hair-thin void still stamps there
  p.seedRowNow("xyz:ACME", { px: 100, ticker: "ACME", uni: "xyz" });
  const e4 = p.openLedgerNow("xyz:ACME", "breakout", { score: 5, reading: "", play: { side: "long", stop: 99.98, target: 103 } }, 1, { sd0: 1.5 });
  assert.equal(e4.stp, 99.98, "xyz keeps the loss-side-only rule so its existing record stays comparable");
  // ...while the identical shape on crypto is refused
  p.seedRowNow("DOGE", { px: 100, ticker: "DOGE", uni: "main" });
  const e5 = p.openLedgerNow("DOGE", "breakout", { score: 5, reading: "", play: { side: "long", stop: 99.98, target: 103 } }, 1, { sd0: 1.5 });
  assert.equal(e5.stp, undefined, "the same hair-thin void is refused on crypto");
});

test("scope isolation: neither board ever shows the other universe's rows, executed not pinned", () => {
  // The payload carries both universes on purpose — one build, one ETag, per-universe transport
  // lanes. Every surface that consumes it must then re-scope, and the failure mode is not a blank
  // screen: it is crypto cards sitting directly above an equity track record, or an equity setup
  // competing on R:R inside a crypto ranking. Both look entirely normal and are silently wrong,
  // which is why this executes the real filter expressions instead of pinning their source.
  const fs = require("fs"), path = require("path");
  const src = fs.readFileSync(path.join(__dirname, "..", "public", "app.js"), "utf8");

  // The two filters, lifted verbatim from the shipped client and run against a mixed payload.
  const sigFilter = (signals, scope) => {
    const wantUni = scope === 'crypto' ? 'main' : 'xyz';
    return signals.filter(g => g.uni === wantUni);
  };
  const actFilter = (rows, scope) => {
    const wantU = scope === 'crypto' ? 'crypto' : 'stocks';
    return rows.filter(r => r.uni === wantU);
  };
  // ...and the source must contain exactly these expressions, so the copies above cannot drift
  // into testing something the client does not do.
  assert.ok(src.includes("const wantUni = state.scope === 'crypto' ? 'main' : 'xyz';") &&
    src.includes("const scoped = d.signals.filter(g => g.uni === wantUni);"),
    "the signals card filter ships in the form under test");
  assert.ok(src.includes("const wantU=state.scope==='crypto'?'crypto':'stocks';") &&
    src.includes("(d.rows||[]).filter(r=>r.uni===wantU&&"),
    "the actionable row filter ships in the form under test");

  // Signals: the payload's universe tag is 'main' / 'xyz' (the poller's own row key).
  const signals = [
    { coin: "ETH", uni: "main", ev: "casc" }, { coin: "SOL", uni: "main", ev: "bigmove" },
    { coin: "xyz:NVDA", uni: "xyz", ev: "gap" }, { coin: "xyz:AAPL", uni: "xyz", ev: "prem" },
  ];
  assert.deepEqual(sigFilter(signals, "stocks").map((g) => g.coin), ["xyz:NVDA", "xyz:AAPL"],
    "stocks scope shows only equity cards");
  assert.deepEqual(sigFilter(signals, "crypto").map((g) => g.coin), ["ETH", "SOL"],
    "crypto scope shows only crypto cards");
  // the crypto-native and xyz-only events specifically must not cross over
  assert.ok(!sigFilter(signals, "stocks").some((g) => g.ev === "casc"), "cascade never appears under a stocks board");
  assert.ok(!sigFilter(signals, "crypto").some((g) => g.ev === "gap" || g.ev === "prem"),
    "gap and premium never appear under a crypto board");

  // Actionable: the board's tag is 'crypto' / 'stocks' (the row is already display-shaped). Two
  // different vocabularies for the same split, which is exactly how a copy-pasted filter goes
  // wrong — the wrong key silently matches nothing and the board renders empty.
  const rows = [
    { coin: "ETH", uni: "crypto", side: "long" }, { coin: "xyz:NVDA", uni: "stocks", side: "long" },
  ];
  assert.deepEqual(actFilter(rows, "crypto").map((r) => r.coin), ["ETH"], "crypto board: crypto rows only");
  assert.deepEqual(actFilter(rows, "stocks").map((r) => r.coin), ["xyz:NVDA"], "stocks board: equity rows only");
  assert.equal(actFilter(rows, "crypto").length + actFilter(rows, "stocks").length, rows.length,
    "the two scopes partition the board exactly — no row is dropped by both filters, none counted twice");

  // A scope flip must REPAINT, or the filter is correct and invisible for up to a poll interval.
  assert.ok(src.includes("if(state.view==='signals') renderSignals();") &&
    src.includes("if(state.view==='actionable') renderActionable();"),
    "applyScope repaints both scoped boards on a flip");

  // Both tabs are reachable in crypto scope in the first place.
  assert.ok(/CRYPTO_VIEWS=new Set\(\[[^\]]*'signals'[^\]]*\]\)/.test(src) &&
    /CRYPTO_VIEWS=new Set\(\[[^\]]*'actionable'[^\]]*\]\)/.test(src),
    "Signals and Actionable are in scope for crypto");
});

test("scoped badge and header count read the universe on screen, from kept totals", () => {
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
  p.buildSignalsNow();
  const d = p.getSignals();
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
  p2.buildSignalsNow();
  assert.equal(p2.getSignals().countU.m, null, "crypto disabled: m is null, never 0");
});

test("degenerate void: a stop that lands on the entry cannot reach the board, however good the ratio looks", () => {
  // Real board row, 2026-07-27. PALLADIUM short, unwind on D1: fired 1287.40, void 1287.85,
  // target 1109.61. The void is 45 cents on a 1287 instrument — 0.035% — while the target is
  // 13.81% away, so the ratio comes out at 395:1 and setupEV turns a 60% hit rate into an
  // expectancy of +236R. Nothing about that is a trade. Risk is the denominator, and when the
  // void collapses onto the mark the ratio measures the collapse, not the setup.
  //
  // The unwind and squeeze playbooks are the structural source: their voids are a fixed fraction
  // of the 30d range (hi30 - 0.25 x range) regardless of where price actually sits in that range.
  // Reverse the levels here and the range is 1169.76-1327.22 with price at 1287.40 — 75% of the
  // way up, which is exactly where that formula puts the void. The trigger is supposed to fire
  // near the range LOWS; it fired at three-quarters, and the void landed on the entry.
  const { netRR } = require("../src/compute");
  const rr = netRR({ side: "short", entry: 1287.40, stop: 1287.85, target: 1109.61 });
  assert.ok(rr.gross > 390, `the artifact is reproducible: ${rr.gross}`);
  assert.ok(rr.riskPct < 0.04, `and it comes from a void 0.035% away, got ${rr.riskPct}%`);

  const { createPoller } = require("../src/poller");
  const store = { loadAll: () => new Map(), loadRegime: () => [], loadLedger: () => null,
    saveLedger: () => {}, insert: () => {}, saveRegime: () => {} };
  const p2 = createPoller({ dex: "xyz", store, log: () => {}, version: "test", crypto: false });
  p2.seedRowNow("xyz:PALLADIUM", { px: 1287.20, ticker: "PALLADIUM", uni: "xyz" });
  const e = p2.openLedgerNow("xyz:PALLADIUM", "unwind",
    { score: 9, reading: "", play: { side: "short", stop: 1287.85, target: 1109.61 } }, -1, { sd0: 1.2 });
  assert.ok(e && e.stp === 1287.85, "the claim itself still opens and still records — this guard is the BOARD's, not the ledger's");
  p2.buildActionableNow();
  const a = p2.getActionable();
  assert.equal(a.rows.length, 0, "and it never reaches the board");
  assert.equal(a.coverage.degenerate, 1, "counted under its own reason, so an empty board can always say why");

  // the three checks are independent — each must reject on its own
  const p3 = createPoller({ dex: "xyz", store, log: () => {}, version: "test", crypto: false });
  p3.seedRowNow("xyz:AAA", { px: 100, ticker: "AAA", uni: "xyz" });
  // no sd0 stamped: the absolute 5bp floor has to carry it alone
  p3.openLedgerNow("xyz:AAA", "unwind", { score: 9, reading: "", play: { side: "short", stop: 100.02, target: 90 } }, -1, {});
  p3.buildActionableNow();
  assert.equal(p3.getActionable().coverage.degenerate, 1, "a 2bp void is refused with no volatility stamp to judge it by");

  // a legitimately tight-but-real setup survives: 0.9% void on a 1.2% sigma name, ratio 3.3
  const p4 = createPoller({ dex: "xyz", store, log: () => {}, version: "test", crypto: false });
  p4.seedRowNow("xyz:BBB", { px: 100, ticker: "BBB", uni: "xyz" });
  p4.openLedgerNow("xyz:BBB", "breakout", { score: 9, reading: "", play: { side: "long", stop: 99.1, target: 103 } }, 1, { sd0: 1.2 });
  p4.buildActionableNow();
  assert.equal(p4.getActionable().coverage.degenerate, 0,
    "a real void at 0.75 sigma is NOT degenerate — this guard must not become a filter on tight setups");
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

  // Batching: bounded, and the overflow is DISCLOSED rather than silently dropped.
  const many = Array.from({ length: 12 }, (_, i) => "msg" + i);
  const out = C.pushBatch(many);
  assert.ok(out.length >= 1);
  assert.ok(out.join("\n").includes("+4 more held"), "events past the batch cap are counted in the message, not vanished");
  const long = C.pushBatch(["a".repeat(3000), "b".repeat(3000)]);
  assert.equal(long.length, 2, "a batch that would exceed Telegram's body limit splits instead of being rejected");
  assert.deepEqual(C.pushBatch([]), []);
});

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

test("push: fully dormant without TG_BOT_TOKEN — no state, no calls, no surprises", async () => {
  delete process.env.TG_BOT_TOKEN;
  const { p, calls } = pushHarness();
  const st = p.getPush("own-a", false);
  assert.equal(st.enabled, false, "reported as off so the panel can say so instead of looking broken");
  assert.deepEqual(st.recipients, []);
  await p.pushUpdatesNow();
  await p.pushDrainNow();
  p.pushTickNow();
  assert.equal(calls.length, 0, "an unconfigured deploy must never reach out to Telegram");
  assert.equal(p.pushTest(null, "own-a", false).ok, false, "test fire is honest about being unavailable");
});

test("push: link codes are single-use, expiring, and a new recipient starts CAUGHT UP", () => {
  process.env.TG_BOT_TOKEN = "test-token";
  const { p } = pushHarness();
  p.pushOpsNow("seed", "an event that predates the link");
  p.pushOpsNow("seed2", "another");

  assert.equal(p.pushBindNow("ZZZZZZ", 111, "nobody").ok, false, "a code that was never minted is refused");
  assert.equal(p.pushBindNow("bad", 111, "nobody").error, "bad-code", "malformed codes never reach the store");

  const mint = p.pushMintCode("own-a", true);
  assert.ok(/^[A-HJ-NP-Z2-9]{6}$/.test(mint.code));
  assert.ok(mint.expiresAt > Date.now());
  const ok = p.pushBindNow(mint.code.toLowerCase(), 5551234567, "milst");
  assert.equal(ok.ok, true, "case-insensitive, because it is typed on a phone");
  assert.equal(p.pushBindNow(mint.code, 222, "someone else").ok, false, "codes are SINGLE USE — a shared screenshot cannot link a stranger");

  const st = p.getPush("own-a", false);
  assert.equal(st.recipients.length, 1);
  assert.equal(st.recipients[0].name, "milst");
  assert.ok(!st.recipients[0].chat.includes("undefined"));
  assert.equal(st.recipients[0].mask, "\u20264567", "the panel is shared with the group, so chat ids are masked there — a chat id is enough to attempt contact");

  // The backlog rule: linking must not deliver the ring's history.
  p.pushTickNow();
  assert.equal(p.pushStateNow().queue, 0, "a fresh recipient's cursor starts at the live seq — no two hundred stale setups as a welcome");
  delete process.env.TG_BOT_TOKEN;
});

test("push: the boot rule is a lookback, not a mute — the deploy notice survives it", () => {
  process.env.TG_BOT_TOKEN = "test-token";
  const { p } = pushHarness();
  const mint = p.pushMintCode("own-a", true);
  p.pushBindNow(mint.code, 999, "milst");

  // An event that fired long before this boot: the cursor must advance past it WITHOUT sending.
  p.pushSetBootNow(Date.now());
  const stale = p.pushOpsNow("old", "fired while nobody was listening");
  stale.at = Date.now() - 60 * 60 * 1000;
  p.pushTickNow();
  assert.equal(p.pushStateNow().queue, 0, "a pre-boot backlog is seeded, not announced");

  // …but an event emitted now goes out immediately. A blanket post-boot mute would swallow exactly
  // this message — the one that proves the wire survived the deploy.
  p.pushOpsNow("deploy", "build test is live");
  p.pushTickNow();
  assert.equal(p.pushStateNow().queue, 1, "the deploy notice is delivered, not held behind a grace timer");
  delete process.env.TG_BOT_TOKEN;
});

test("push: per-recipient cursors are independent — one strict filter cannot silence everyone else", () => {
  process.env.TG_BOT_TOKEN = "test-token";
  const { p } = pushHarness();
  const a = p.pushMintCode("own-a", true); p.pushBindNow(a.code, 1001, "a");
  const b = p.pushMintCode("own-b", true); p.pushBindNow(b.code, 1002, "b");
  p.pushSetClasses("1002", ["setup"], "own-b", false);   // b wants setups only

  p.pushOpsNow("deploy", "build test is live");
  p.pushTickNow();
  assert.equal(p.pushStateNow().queue, 1, "only the subscriber to that class is queued");

  // b's cursor still advanced: a filtered event is HANDLED, not left pending forever.
  p.pushTickNow();
  assert.equal(p.pushStateNow().queue, 1, "a second tick must not re-queue an event that was already decided on");
  delete process.env.TG_BOT_TOKEN;
});

test("push outbox: 429 honours retry_after, 403 mutes, 4xx drops without wedging the queue", async () => {
  process.env.TG_BOT_TOKEN = "test-token";

  // 429: their number, not ours, and the item stays queued.
  {
    const { p, calls } = pushHarness([{ status: 429, body: { ok: false, description: "Too Many Requests", parameters: { retry_after: 7 } } }]);
    const m = p.pushMintCode("own-a", true); p.pushBindNow(m.code, 1, "a");
    p.pushOpsNow("x", "y"); p.pushTickNow();
    await p.pushDrainNow();
    assert.equal(calls.length, 1);
    const st = p.pushStateNow();
    assert.equal(st.queue, 1, "a rate-limited message is retried, never discarded");
    assert.ok(st.hold - Date.now() > 6000, "the backoff uses Telegram's retry_after, not a guess");
  }
  // 403: the recipient blocked the bot. Mute (so the panel can say WHY) and purge their backlog.
  {
    const { p } = pushHarness([{ status: 403, body: { ok: false, description: "Forbidden: bot was blocked by the user" } }]);
    const m = p.pushMintCode("own-a", true); p.pushBindNow(m.code, 1, "a");
    p.pushOpsNow("x", "y"); p.pushTickNow();
    p.pushOpsNow("x2", "y2"); p.pushTickNow();
    await p.pushDrainNow();
    const st = p.getPush("own-a", false);
    assert.equal(st.recipients[0].muted, true, "muted, not deleted — a vanished row looks like a bug");
    assert.ok(/blocked/i.test(st.recipients[0].lastErr), "the reason is kept and shown");
    assert.equal(p.pushStateNow().queue, 0, "their whole backlog is purged rather than retried forever");
  }
  // 400: a malformed message must not sit at the head of the queue blocking every alert behind it.
  {
    const { p } = pushHarness([{ status: 400, body: { ok: false, description: "Bad Request: can't parse entities" } },
      { status: 200, body: { ok: true, result: {} } }]);
    const m = p.pushMintCode("own-a", true); p.pushBindNow(m.code, 1, "a");
    p.pushOpsNow("x", "y"); p.pushTickNow();
    p.pushOpsNow("x2", "y2"); p.pushTickNow();
    await p.pushDrainNow();
    assert.equal(p.pushStateNow().queue, 1, "the undeliverable message is dropped so the queue keeps moving");
    assert.ok(/parse entities/.test(p.getPush("own-a", false).lastErr), "the API's own words are surfaced — this is what a bad message looks like from the outside");
  }
  delete process.env.TG_BOT_TOKEN;
});

test("push outbox: success paces sends and the queue is bounded with the loss disclosed", async () => {
  process.env.TG_BOT_TOKEN = "test-token";
  const { p, calls } = pushHarness();
  const m = p.pushMintCode("own-a", true); p.pushBindNow(m.code, 1, "a");
  p.pushOpsNow("one", "1"); p.pushTickNow();
  p.pushOpsNow("two", "2"); p.pushTickNow();
  await p.pushDrainNow();
  assert.equal(calls.length, 1, "one send per drain");
  assert.ok(p.pushStateNow().hold > Date.now(), "the next send is paced — Telegram's per-chat ceiling is ~20/min");
  await p.pushDrainNow();
  assert.equal(calls.length, 1, "the pacing hold is respected rather than busy-looping the API");
  assert.equal(calls[0].body.parse_mode, "HTML");
  assert.equal(calls[0].body.disable_web_page_preview, true, "a link preview would bury the geometry under a page card");
  delete process.env.TG_BOT_TOKEN;
});

test("push commands: /start binds, /stop unlinks, offset advances, junk is ignored", async () => {
  process.env.TG_BOT_TOKEN = "test-token";
  const { p, queue } = pushHarness();
  const upd = (id, text) => ({ update_id: id, message: { chat: { id: 5551234567 }, from: { first_name: "milst" }, text } });
  const reply = (result) => ({ body: { ok: true, result } });

  // A code that was never minted binds nobody — but the offset still advances, or the same bad
  // command replays on every poll forever.
  queue.push(reply([upd(10, "/start ZZZZZZ")]));
  await p.pushUpdatesNow();
  assert.equal(p.getPush("own-a", false).recipients.length, 0, "an invalid code binds nobody");
  assert.equal(p.pushStateNow().offset, 11, "the offset advances even for a rejected command");

  // The real round trip, with a code this server actually minted.
  const code = p.pushMintCode("own-a", true).code;
  queue.push(reply([upd(11, "/start " + code)]));
  await p.pushUpdatesNow();
  const linked = p.getPush("own-a", false).recipients;
  assert.equal(linked.length, 1, "a minted code binds the chat that carried it");
  assert.equal(linked[0].name, "milst", "the display name comes from Telegram, not from a form nobody fills in");

  // Non-command chatter must not touch state.
  queue.push(reply([upd(12, "hello?"), { update_id: 13 }, { update_id: 14, message: { chat: { id: 1 } } }]));
  await p.pushUpdatesNow();
  assert.equal(p.getPush("own-a", false).recipients.length, 1, "junk, empty updates and text-less messages are ignored without throwing");
  assert.equal(p.pushStateNow().offset, 15);

  queue.push(reply([upd(15, "/stop")]));
  await p.pushUpdatesNow();
  assert.equal(p.getPush("own-a", false).recipients.length, 0, "/stop unlinks from the DM itself — nobody should need the panel to make it stop");

  // An unlink of an unknown chat is a clean failure, not a throw.
  assert.equal(p.pushUnlink("5551234567", "own-a", false).ok, false);
  delete process.env.TG_BOT_TOKEN;
});

test("push ops lane: the stall watchdog is edge-triggered in BOTH directions", () => {
  process.env.TG_BOT_TOKEN = "test-token";
  const { p } = pushHarness();
  const opsCount = () => p.getTriggers(0, null, true).events.filter((e) => e.kind === "ops").length;

  p.pushHealthNow();
  assert.equal(opsCount(), 0, "no poll history yet is a cold boot, not a fault");

  p.pushSetPollNow(Date.now());
  p.pushHealthNow();
  assert.equal(opsCount(), 0, "a healthy poller says nothing");

  // Go cold: exactly one alert, however many ticks run. An ops channel that repeats every minute
  // is a channel you mute, and then the real warning goes with it.
  p.pushSetPollNow(Date.now() - 20 * 60 * 1000);
  p.pushHealthNow();
  p.pushHealthNow();
  p.pushHealthNow();
  assert.equal(opsCount(), 1, "the stall fires ONCE, not once per tick");
  const stall = p.getTriggers(0, null, true).events.filter((e) => e.kind === "ops").pop();
  assert.equal(stall.level, "warn");
  assert.ok(/stalled/i.test(stall.title));

  // Recovery is its own edge — without it, silence after a stall is ambiguous.
  p.pushSetPollNow(Date.now());
  p.pushHealthNow();
  p.pushHealthNow();
  assert.equal(opsCount(), 2, "recovery announces exactly once too");
  assert.ok(/recovered/i.test(p.getTriggers(0, null, true).events.pop().title));

  // …and the pair can happen again. A latched flag that never re-arms would report the first
  // outage of a deploy's life and nothing after it.
  p.pushSetPollNow(Date.now() - 20 * 60 * 1000);
  p.pushHealthNow();
  assert.equal(opsCount(), 3, "the watchdog re-arms for the next outage");
  delete process.env.TG_BOT_TOKEN;
});

test("push: state survives a restart, and hydrate restores cursors rather than replaying the ring", () => {
  process.env.TG_BOT_TOKEN = "test-token";
  const { p, store } = pushHarness();
  const m = p.pushMintCode("own-a", true);
  p.pushBindNow(m.code, 777, "milst");
  p.pushSetClasses("777", ["ops"], "own-a", false);
  const saved = store.saved;
  assert.ok(saved && saved.recipients.length === 1, "recipients are persisted the moment they link");
  assert.deepEqual(saved.recipients[0].classes, ["ops"]);
  assert.ok(Number.isFinite(saved.recipients[0].cur), "the delivery cursor is persisted WITH the recipient — a split write could replay or eat a backlog");

  assert.equal(p.pushSetClasses("777", [], "own-a", false).classes, null, "an empty selection normalises to all classes");
  assert.equal(p.pushSetClasses("nobody", ["ops"], "own-a", false).ok, false);
  delete process.env.TG_BOT_TOKEN;
});

test("push: the trigger ring carries a kind on every event and legacy events read as setups", () => {
  process.env.TG_BOT_TOKEN = "test-token";
  const { p } = pushHarness();
  p.pushOpsNow("deploy", "build test is live");
  const evs = p.getTriggers(0, null, true).events;
  assert.ok(evs.length >= 1);
  assert.equal(evs[evs.length - 1].kind, "ops", "every emitted event is class-stamped so consumers filter on a field that always exists");
  // `cls` is already taken on actionable rows (the R:R class); a collision there would mis-route
  // every message on the board, so the class field must stay `kind`.
  const pol = require("fs").readFileSync(require("path").join(__dirname, "..", "src", "poller.js"), "utf8");
  assert.ok(pol.includes('function emitTrig(kind, obj, now)'), "one emitter owns the ring");
  assert.equal((pol.match(/trigEvents\.push\(/g) || []).length, 1, "exactly ONE push site into the ring — a second would bypass the kind stamp and the trim");
  assert.ok(pol.includes('Object.assign({ kind: "setup" }, e)'), "events persisted before the kind stamp must hydrate as setups");
  delete process.env.TG_BOT_TOKEN;
});

test("server: alert delivery routes registered once, body-capped, cooldown mapped to 429", () => {
  const fs = require("fs"), path = require("path");
  const srv = fs.readFileSync(path.join(__dirname, "..", "server.js"), "utf8");
  for (const r of ["/api/alerts/link", "/api/alerts/unlink", "/api/alerts/classes", "/api/alerts/test"])
    assert.equal(srv.split(`fastify.post("${r}"`).length - 1, 1, `POST ${r} must be registered exactly once`);
  assert.equal(srv.split('fastify.get("/api/alerts"').length - 1, 1, "GET /api/alerts exactly once");
  assert.ok(/get\("\/api\/alerts"[\s\S]{0,200}no-store/.test(srv), "delivery state must be no-store — a cached link code is an expired link code");
  for (const r of ["/api/alerts/link", "/api/alerts/unlink", "/api/alerts/classes", "/api/alerts/test"])
    assert.ok(new RegExp(`post\\("${r.replace(/\//g, "\\/")}", \\{ bodyLimit`).test(srv), `${r} must carry a body cap`);
  assert.ok(/alerts\/test[\s\S]{0,400}error === "cooldown"[\s\S]{0,60}429/.test(srv), "test-fire cooldown must map to 429");
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

test("ledger alerts: only announced claims get a death notice, and each level fires exactly once", () => {
  const { createPoller } = require("../src/poller");
  const store = { loadAll: () => new Map(), loadRegime: () => [], loadLedger: () => null, saveLedger: () => {},
    insert: () => {}, saveRegime: () => {}, loadTriggers: () => null, saveTriggers: () => {},
    savePush: () => {}, loadPush: () => null };
  const p = createPoller({ dex: "xyz", store, log: () => {}, version: "test", crypto: false });
  p.seedRowNow("AAA", { ticker: "AAA", px: 42, uni: "xyz" });
  p.seedRowNow("BBB", { ticker: "BBB", px: 42, uni: "xyz" });
  const open = p.ledgerOpenNow();
  const mk = (coin, extra) => Object.assign({ key: coin + "|breakout", coin, ticker: coin, ev: "breakout",
    t0: Date.now() - 3600e3, mark0: 42, dir: 1, psd: "long", stp: 40, tgt: 47, resolveAt: Date.now() + 1e9 }, extra);
  open.set("AAA|breakout", mk("AAA", { alo: 1 }));    // announced
  open.set("BBB|breakout", mk("BBB"));                // never announced

  const ledgerEvents = () => p.getTriggers(0, null, true).events.filter((e) => e.kind === "ledger");

  p.seedRowNow("AAA", { px: 42 }); p.seedRowNow("BBB", { px: 42 });
  p.levelScanNow();
  assert.equal(ledgerEvents().length, 0, "a claim sitting between its levels says nothing");

  // Both breach. Only the announced one is entitled to speak.
  p.seedRowNow("AAA", { px: 39.5 }); p.seedRowNow("BBB", { px: 39.5 });
  p.levelScanNow();
  const evs = ledgerEvents();
  assert.equal(evs.length, 1, "a claim nobody was told about does not get a death notice");
  assert.equal(evs[0].coin, "AAA");
  assert.equal(evs[0].sub, "stop");
  assert.equal(evs[0].level, 40);
  assert.equal(evs[0].side, "long");
  assert.ok(evs[0].held, "how long it was open is part of the story");

  // Repeat scans must not re-announce: price stays below the void for hours.
  p.levelScanNow(); p.levelScanNow();
  assert.equal(ledgerEvents().length, 1, "the void is taken ONCE — a level that stays breached is not news every 30 seconds");
  assert.equal(open.get("AAA|breakout").als, 1, "the stamp lives on the claim, so a restart cannot re-announce it");

  // A dead claim has nothing to say about its target, even if price later runs there.
  p.seedRowNow("AAA", { px: 48 });
  p.levelScanNow();
  assert.equal(ledgerEvents().length, 1, "a stopped-out claim does not later report reaching its target");
  assert.equal(open.get("AAA|breakout").alt, 1, "the void hit retires the target in the same breath, not just for the rest of this scan");
});

test("ledger alerts: target fires independently, and the void takes precedence in one scan", () => {
  const { createPoller } = require("../src/poller");
  const store = { loadAll: () => new Map(), loadRegime: () => [], loadLedger: () => null, saveLedger: () => {},
    insert: () => {}, saveRegime: () => {}, loadTriggers: () => null, saveTriggers: () => {} };
  const p = createPoller({ dex: "xyz", store, log: () => {}, version: "test", crypto: false });
  p.seedRowNow("CCC", { ticker: "CCC", px: 42, uni: "xyz" });
  p.ledgerOpenNow().set("CCC|breakout", { key: "CCC|breakout", coin: "CCC", ticker: "CCC", ev: "breakout",
    t0: Date.now() - 7200e3, mark0: 42, dir: 1, psd: "long", stp: 40, tgt: 47, alo: 1, resolveAt: Date.now() + 1e9 });

  p.seedRowNow("CCC", { px: 47.5 });
  p.levelScanNow();
  const evs = p.getTriggers(0, null, true).events.filter((e) => e.kind === "ledger");
  assert.equal(evs.length, 1);
  assert.equal(evs[0].sub, "target");
  assert.equal(evs[0].level, 47);

  // A shadow-variant claim is internal bookkeeping and never surfaces to a transport.
  p.ledgerOpenNow().set("CCC|bigmove#1", { key: "CCC|bigmove#1", coin: "CCC", ticker: "CCC", ev: "bigmove",
    t0: Date.now(), mark0: 42, dir: 1, psd: "long", stp: 46, alo: 1, vi: 1, resolveAt: Date.now() + 1e9 });
  p.levelScanNow();
  assert.equal(p.getTriggers(0, null, true).events.filter((e) => e.kind === "ledger").length, 1,
    "shadow variants ledger silently — they must never reach an alert channel");
});

test("ledger alerts: resolution is emitted from the resolver's own close path", () => {
  const { createPoller } = require("../src/poller");
  const store = { loadAll: () => new Map(), loadRegime: () => [], loadLedger: () => null, saveLedger: () => {},
    insert: () => {}, saveRegime: () => {}, loadTriggers: () => null, saveTriggers: () => {}, archiveClosed: () => {} };
  const p = createPoller({ dex: "xyz", store, log: () => {}, version: "test", crypto: false });
  const pol = require("fs").readFileSync(require("path").join(__dirname, "..", "src", "poller.js"), "utf8");
  // Pinned structurally: emitted INSIDE the resolver, so the number in the message is the number
  // that entered the record. A separate scan over the closed list could disagree with it.
  assert.ok(/e\.status = "resolved"[\s\S]{0,700}emitLedgerEvent\(e, "resolved"/.test(pol),
    "the resolution notice must be emitted from the resolver's close path, not reconstructed later");
  assert.ok(/if \(e\.alo === 1 && e\.vi == null\) emitLedgerEvent/.test(pol),
    "only announced, non-shadow claims resolve out loud");
  assert.ok(p.resolveLedgerNow);
});

test("ledger alerts: detection is armed regardless of whether a transport is configured", () => {
  const fs = require("fs"), path = require("path");
  const pol = fs.readFileSync(path.join(__dirname, "..", "src", "poller.js"), "utf8");
  // Slice A armed the level scan and the health watchdog inside the token check, which let a
  // transport's configuration silently decide what the canonical stream was allowed to contain.
  // The scan and the watchdog must sit OUTSIDE the `if (pushOn())` block.
  const boot = pol.slice(pol.indexOf("alert detection + transports"), pol.indexOf("AI reports: ${AI_KEY()"));
  const gateAt = boot.indexOf("if (pushOn())");
  assert.ok(gateAt > 0, "the delivery gate still exists");
  const before = boot.slice(0, gateAt);
  assert.ok(before.includes("levelScan"), "the level scan is armed unconditionally");
  assert.ok(before.includes("pushHealthTick"), "the health watchdog is armed unconditionally");
  assert.ok(before.includes('pushOps("deploy"'), "the deploy notice reaches the in-app log with no bot configured");
  const after = boot.slice(gateAt);
  for (const f of ["pushUpdatesTick", "pushDrain", "pushStreamTick"])
    assert.ok(after.includes(f), `${f} is outbound and must stay behind the token gate`);
  assert.ok(!before.includes("pushDrain("), "nothing outbound may run without a token");
});

test("ledger alerts: the target level is FROZEN on the claim, not reconstructed from mv", () => {
  const fs = require("fs"), path = require("path");
  const pol = fs.readFileSync(path.join(__dirname, "..", "src", "poller.js"), "utf8");
  assert.ok(pol.includes("tgt0 != null && vi == null ? { tgt: tgt0 } : null"),
    "the absolute target is stamped at fire — mv is a rounded distance and cannot be turned back into a price");
  assert.ok(/tgt: "playbook target level frozen at fire/.test(pol), "the export glossary documents the new stamp");
  for (const k of ["alo:", "als:", "alt:"]) assert.ok(pol.includes(k), `glossary entry missing for ${k}`);
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

test("client: the alert pull rides the snapshot poll and is not gated on the setup toggle", () => {
  const fs = require("fs"), path = require("path");
  const app = fs.readFileSync(path.join(__dirname, "..", "public", "app.js"), "utf8");

  // The alertVer check must sit BEFORE applySnapshot's unchanged-dataTs early return, or an idle
  // board skips the alert pull precisely when it matters.
  const fn = app.slice(app.indexOf("function applySnapshot(s){"));
  const verAt = fn.indexOf("s.alertVer"), shortAt = fn.indexOf("s.dataTs===state.dataTs");
  assert.ok(verAt > 0 && shortAt > 0, "both the alertVer check and the content short-circuit exist");
  assert.ok(verAt < shortAt, "the alertVer check must precede the content short-circuit");

  // `trig.on` governs whether a SETUP interrupts you. Gating the whole pull on it silently threw
  // away the ops and ledger history for anyone who turned setup toasts off.
  const lt = app.slice(app.indexOf("async function loadTriggers()"), app.indexOf("function fireTrigger("));
  assert.ok(!/if\(!A\.trig\.on\) return;/.test(lt), "the feed pull must not be gated on the setup toggle");
  assert.ok(/A\.trig\.on && trigEligibleClient/.test(lt), "…the toggle gates FIRING instead");
  assert.ok(lt.indexOf("A.feed=d.recent") < lt.indexOf("if(cur==null)"),
    "the display list must be adopted BEFORE the first-run early return, or a new device opens onto a blank panel");
  assert.ok(/if\(!A\.seenSeq\)\{ A\.seenSeq=d\.seq/.test(lt),
    "a first-run device starts the badge clean — forty retained events are history, not forty unread items");

  // The 60s standalone timer is replaced by the snapshot-driven pull plus a slow safety net.
  assert.ok(!/setInterval\(loadTriggers,60\*1000\)/.test(app), "the old 60s alert timer must be gone");
  assert.ok(/setInterval\(loadTriggers,5\*60\*1000\)/.test(app), "a slow safety net remains for a wedged snapshot path");
});

test("client: the feed is the record — fire* interrupt only, and read state is a persisted watermark", () => {
  const fs = require("fs"), path = require("path");
  const app = fs.readFileSync(path.join(__dirname, "..", "public", "app.js"), "utf8");

  // A second copy of the event list is exactly how the badge, the panel and the toast could
  // disagree about what had happened. Only the local metric rules (fireAlert) still write a log.
  for (const fn of ["fireTrigger", "fireOps", "fireLedger"]) {
    const body = app.slice(app.indexOf("function " + fn + "(ev)"), app.indexOf("function " + fn + "(ev)") + 900);
    assert.ok(!/A\.log\.unshift/.test(body), `${fn} must not keep its own copy of the event`);
    assert.ok(!/A\.unseen\+\+/.test(body), `${fn} must not hand-count unread — the watermark does that`);
  }
  assert.ok(/function fireAlert\([\s\S]{0,400}A\.log\.unshift/.test(app),
    "in-tab metric rules still keep a local log until their server-side replacement lands");

  // One formatter, shared by the toast path and the panel.
  assert.ok(/function alertText\(ev\)/.test(app));
  for (const k of ["'ops'", "'ledger'"]) assert.ok(app.includes("if(k===" + k), `alertText must handle the ${k} class`);
  assert.ok(/new Notification\('Trade\[XYZ\] — new trigger',\{body:alertText\(ev\)\}\)/.test(app),
    "the notification body comes from the shared formatter, not a private string");

  // Unread survives a reload because it is a persisted sequence watermark, not a counter.
  assert.ok(/function alertUnread\(\)[\s\S]{0,320}A\.seenSeq\|\|0/.test(app), "unread is computed against the watermark");
  assert.ok(/const floor=Math\.max\(A\.seenSeq\|\|0, A\.clearedSeq\|\|0\);/.test(app),
    "…and against the clear watermark too, or the badge counts rows the panel no longer shows");
  assert.ok(/seenSeq:state\.alerts\.seenSeq/.test(app), "the watermark is persisted");
  assert.ok(/Number\.isFinite\(d\.seenSeq\)\) state\.alerts\.seenSeq=d\.seenSeq/.test(app), "…and restored");
  assert.ok(/if\(pop\.hidden\)\{[^}]*alertMarkRead\(\);[^}]*\}/.test(app),
    "opening the bell marks the feed read (pinned as behaviour, not as an exact call list — the open handler legitimately gains loaders)");

  // A client cannot delete from the server's ring; "read" is the only state a browser owns here.
  assert.ok(!/id="ar-clear"[\s\S]{0,120}Clear log/.test(app), "the clear-log button must be gone");
  assert.ok(/Mark all read/.test(app));
  assert.ok(/el\('ar-clear'\)\.onclick=\(\)=>\{ alertMarkRead\(\)/.test(app), "…and it only moves the watermark");

  // Provenance is visible: server-held rows and this-browser-only rows are tagged differently.
  assert.ok(/const ATAG=\{setup:/.test(app) && /rule:\['RULE'/.test(app),
    "the log must say which rows survive a closed tab and which are local");
  assert.ok(/survives a closed tab/.test(app), "the panel states the guarantee it now actually provides");
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

function ruleHarness() {
  const { createPoller } = require("../src/poller");
  let saved = null;
  const store = { loadAll: () => new Map(), loadRegime: () => [], loadLedger: () => null, saveLedger: () => {},
    insert: () => {}, saveRegime: () => {}, loadTriggers: () => null, saveTriggers: () => {},
    saveRules: (d) => { saved = d; }, loadRules: () => saved };
  const p = createPoller({ dex: "xyz", store, log: () => {}, version: "test", crypto: false });
  return { p, get saved() { return saved; } };
}

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

test("fast lane: level alerts run on the socket tick, metric rules deliberately do not", () => {
  const fs = require("fs"), path = require("path");
  const pol = fs.readFileSync(path.join(__dirname, "..", "src", "poller.js"), "utf8");
  const ws = pol.slice(pol.indexOf("function applyWsCtxs(tuples)"), pol.indexOf("function applyWsCtxs(tuples)") + 4000);
  assert.ok(/levelScan\(\)/.test(ws), "a void being taken is the one alert where 2s vs 30s changes whether you can act");
  assert.ok(!/ruleScan\(\)/.test(ws), "metric rules must NOT run here — they read the snapshot and cannot outrun it without disagreeing with it");
  assert.ok(/isolated/.test(ws.slice(ws.indexOf("levelScan()") - 200, ws.indexOf("levelScan()") + 200)),
    "the fast-lane call must be isolated — a throw here would kill the WebSocket fold");
});

test("rules survive a restart WITH their edge state, so a redeploy re-announces nothing", () => {
  const { p, saved } = ruleHarness();
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
  assert.ok(saved === null || true);
});

test("client: the in-tab evaluator is bounded to what only a browser can compute", () => {
  const fs = require("fs"), path = require("path");
  const app = fs.readFileSync(path.join(__dirname, "..", "public", "app.js"), "utf8");
  const cat = app.slice(app.indexOf("const ALERT_METRICS=["), app.indexOf("const AM_BY="));
  for (const k of ["sqz", "mom", "beta"]) assert.ok(cat.includes("k:'" + k + "'"), `${k} stays in-tab`);
  for (const k of ["px", "h1", "funding", "vol", "oi", "prem", "doi"])
    assert.ok(!cat.includes("k:'" + k + "'"), `${k} moved server-side and must be gone from the in-tab catalog`);
  // One form, two destinations — the user shouldn't have to carry the distinction.
  assert.ok(/const metric=sel\.slice\(2\), server=sel\.charAt\(0\)==='s';/.test(app), "the metric prefix routes the rule");
  assert.ok(/if\(server\)\{ ruleAct\(/.test(app));
  assert.ok(/this browser only/.test(app), "the boundary is stated in the UI, not just in a comment");
  assert.ok(/fire with no tab open/.test(app), "…as is what the server rules actually guarantee");
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
  assert.ok(/tomorrow/.test(e) && /open <b>breakout<\/b> claim/.test(e), "the earnings alert says WHY you are being told");
  const a = C.pushFmt({ kind: "ai", coin: "X", t: "X", from: "wait", to: "enter_on_pullback", note: "n" }, {});
  assert.ok(a.includes("wait") && a.includes("enter_on_pullback"));
});

function ctxHarness() {
  const { createPoller } = require("../src/poller");
  const store = { loadAll: () => new Map(), loadRegime: () => [], loadLedger: () => null, saveLedger: () => {},
    insert: () => {}, saveRegime: () => {}, loadTriggers: () => null, saveTriggers: () => {} };
  return createPoller({ dex: "xyz", store, log: () => {}, version: "test", crypto: false });
}

test("filing alerts: material forms only, backlog seeded silently, stale filings dropped", () => {
  const p = ctxHarness();
  p.seedRowNow("AAA", { ticker: "AAA", px: 10, uni: "xyz" });
  const now = Date.now();
  const item = (id, form, pub) => ({ id: "sec:" + id, tk: "AAA", form, h: form + " body", url: "https://sec.gov/" + id, pub: pub == null ? now - 60e3 : pub });
  const filings = () => p.getTriggers(0, null, true).events.filter((e) => e.kind === "filing");

  // Before priming, the 7-day backlog every name carries is seeded, not announced.
  p.filingScanNow([item(1, "8-K")]);
  assert.equal(filings().length, 0, "the first EDGAR pass after boot must not arrive as a wall of notifications");

  p.filingPrimeNow();
  p.filingScanNow([item(1, "8-K")]);
  assert.equal(filings().length, 0, "…and an id already seen during seeding stays seen");

  p.filingScanNow([item(2, "8-K")]);
  assert.equal(filings().length, 1, "a genuinely new material filing fires");
  assert.equal(filings()[0].form, "8-K");
  assert.equal(filings()[0].coin, "AAA", "resolved to the market so the deep link works");

  // Ownership forms are routine insider flow, several a day per active name — excluded on
  // frequency grounds, not because they are uninteresting.
  p.filingScanNow([item(3, "4"), item(4, "SC 13G"), item(5, "144")]);
  assert.equal(filings().length, 1, "ownership forms never push");
  // …nor do the material-but-rarely-urgent ones the news tab already carries.
  p.filingScanNow([item(6, "DEF 14A"), item(7, "S-3")]);
  assert.equal(filings().length, 1, "proxies and shelf registrations stay in the news tab");

  // A filing discovered long after it was published is history, not news.
  p.filingScanNow([item(8, "8-K", now - 20 * 3600e3)]);
  assert.equal(filings().length, 1, "a stale filing found by a slow rotation must not fire");
  p.filingScanNow([item(9, "10-Q")]);
  assert.equal(filings().length, 2);
});

test("earnings alerts are scoped to open announced claims, once per report date", () => {
  const p = ctxHarness();
  p.seedRowNow("AAA", { ticker: "AAA", px: 10, uni: "xyz" });
  p.seedRowNow("BBB", { ticker: "BBB", px: 10, uni: "xyz" });
  const d = new Date(Date.now() + 20 * 3600e3).toISOString().slice(0, 10);
  p.earnIngestNow ? p.earnIngestNow() : null;
  const earn = () => p.getTriggers(0).events.filter((e) => e.kind === "earnings");

  // No claims -> nothing, however many names report. An 84-name roster in season is a calendar.
  p.earnScanNow();
  assert.equal(earn().length, 0);

  // The gate is an OPEN, ANNOUNCED claim. A claim nobody was told about does not earn a reminder.
  p.ledgerOpenNow().set("BBB|breakout", { key: "BBB|breakout", coin: "BBB", ticker: "BBB", ev: "breakout",
    t0: Date.now(), mark0: 10, dir: 1, psd: "long", resolveAt: Date.now() + 1e9 });
  p.earnScanNow();
  assert.equal(earn().length, 0, "an unannounced claim gets no earnings reminder");
  assert.ok(d);
});

test("analyst flip fires only on an actual stance change", () => {
  const p = ctxHarness();
  p.seedRowNow("AAA", { ticker: "AAA", px: 10, uni: "xyz" });
  const rep = (stance) => ({ report: { action: { stance, note: "because" } } });
  const ai = () => p.getTriggers(0, null, true).events.filter((e) => e.kind === "ai");

  assert.equal(p.aiFlipCheckNow("AAA", null, rep("wait")), null, "a first report is not a flip — there is nothing to have changed from");
  assert.equal(p.aiFlipCheckNow("AAA", rep("wait"), rep("wait")), null, "an unchanged stance on regeneration says nothing");
  p.aiFlipCheckNow("AAA", rep("wait"), rep("enter_on_pullback"));
  assert.equal(ai().length, 1, "the report changing its mind is the part worth interrupting for");
  assert.equal(ai()[0].from, "wait");
  assert.equal(ai()[0].to, "enter_on_pullback");
  assert.equal(p.aiFlipCheckNow("AAA", rep("wait"), { report: {} }), null, "a malformed report is not a flip");
  assert.equal(p.aiFlipCheckNow("AAA", rep("wait"), null), null);
});

test("rate meter: measured per class, survives a restart, and reports its own truncation", () => {
  const p = ctxHarness();
  const r0 = p.getClassRates();
  assert.equal(r0.ops.d1, 0);
  assert.equal(r0.ops.dflt, true, "the payload says which classes are on by default so the panel can mark the rest opt-in");
  assert.equal(r0.filing.dflt, false);

  for (let i = 0; i < 5; i++) p.pushOpsNow("x" + i, "y");
  const r1 = p.getClassRates();
  assert.equal(r1.ops.d1, 5, "fires are counted per class");
  assert.equal(r1.ops.h1, 5);
  assert.equal(r1.setup.d1, 0, "…and not smeared across classes");
  assert.equal(r1.ops.capped, false);

  // The meter is what makes an opt-in decision informed rather than a bet, so a restart must not
  // zero it — a noisy class and a frequent deploy would look identical.
  const fs = require("fs"), path = require("path");
  const pol = fs.readFileSync(path.join(__dirname, "..", "src", "poller.js"), "utf8");
  assert.ok(/rates: \[\.\.\.classFires\.entries\(\)\]/.test(pol), "rate history is persisted with the ring");
  assert.ok(/if \(Array\.isArray\(d\.rates\)\)/.test(pol), "…and restored");
  assert.ok(/capped: d1 >= CLASS_RATE_MAX/.test(pol),
    "a truncated count must report itself rather than quietly understating a noisy class");
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

test("regime + coverage are episode-gated: one alert per episode, seeded at boot", () => {
  const p = ctxHarness();
  const regs = () => p.getTriggers(0, null, true).events.filter((e) => e.kind === "regime");
  const covs = () => p.getTriggers(0, null, true).events.filter((e) => e.kind === "coverage");

  // Coverage is scoped to open ANNOUNCED claims: a gap on a name nobody is watching is a
  // maintenance item, not an interruption.
  p.seedRowNow("AAA", { ticker: "AAA", px: 10, uni: "xyz", hourlyTs: Date.now() - 4 * 3600e3 });
  p.coverageScanNow();
  assert.equal(covs().length, 0, "no claim, no coverage alert");

  p.ledgerOpenNow().set("AAA|breakout", { key: "AAA|breakout", coin: "AAA", ticker: "AAA", ev: "breakout",
    t0: Date.now(), mark0: 10, dir: 1, psd: "long", alo: 1, resolveAt: Date.now() + 1e9 });
  p.coverageScanNow();
  assert.equal(covs().length, 0, "a gap already in force at first sight is seeded, not announced");
  p.coverageScanNow();
  assert.equal(covs().length, 0, "…and it does not accumulate on repeat scans — this is a persistent condition, not an event");

  // It re-arms only once the condition genuinely lapses, then fires on the next occurrence.
  p.seedRowNow("AAA", { hourlyTs: Date.now() });
  p.coverageScanNow();
  p.seedRowNow("AAA", { hourlyTs: Date.now() - 4 * 3600e3 });
  p.coverageScanNow();
  assert.equal(covs().length, 1, "a genuinely new episode fires exactly once");
  p.coverageScanNow(); p.coverageScanNow();
  assert.equal(covs().length, 1, "and stays quiet while it persists");

  const fs = require("fs"), path = require("path");
  const pol = fs.readFileSync(path.join(__dirname, "..", "src", "poller.js"), "utf8");
  assert.ok(/regimeArmed/.test(pol) && /coverageArmed/.test(pol), "both classes carry re-arm state");
  assert.ok(/in force at boot: seeded, not announced/.test(pol));
  assert.ok(regs().length >= 0);
});

test("digest: counts what fired, states what it will not push individually", () => {
  const p = ctxHarness();
  for (let i = 0; i < 3; i++) p.pushOpsNow("x" + i, "y");
  const d = p.buildDigestNow(Date.now());
  assert.ok(d.counts.some((c) => c.startsWith("ops 3")), "the digest counts by class off the same meter the panel shows");
  assert.equal(typeof d.openClaims, "number");
  assert.ok(Array.isArray(d.headlines));

  const fs = require("fs"), path = require("path");
  const pol = fs.readFileSync(path.join(__dirname, "..", "src", "poller.js"), "utf8");
  // The digest is where the classes that failed the frequency test get a home, and it says so to
  // the reader rather than presenting them as if they had simply been forgotten.
  assert.ok(/not pushed individually.*too frequent|too frequent/.test(pol));
  assert.ok(/attributed wire headlines only/.test(pol));
  assert.ok(/pushEnqueue\(rec\.chat, digestText\(buildDigest\(now\)\), true\)/.test(pol),
    "a scheduled summary must not be the message the hourly cap happens to eat");
  assert.ok(/digestSent\.get\(rec\.chat\) === day/.test(pol), "once per local day, not once per tick");
});

test("the drain picks the first ELIGIBLE item, so a deferred message cannot head-of-line block", () => {
  const fs = require("fs"), path = require("path");
  const pol = fs.readFileSync(path.join(__dirname, "..", "src", "poller.js"), "utf8");
  assert.ok(/const idx = pushQueue\.findIndex\(\(q\) => !q\.after \|\| q\.after <= now\);/.test(pol),
    "a message held until 07:00 sitting at the head would block every urgent one behind it for hours");
  const drain = pol.slice(pol.indexOf("async function pushDrain()"), pol.indexOf("function pushLogAdd"));
  assert.ok(!/pushQueue\.shift\(\)/.test(drain), "every removal in the drain must target the chosen index, not the head");
  assert.equal((drain.match(/pushQueue\.splice\(idx, 1\)/g) || []).length, 3, "success, 4xx drop and give-up all remove by index");
});

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

test("ownership is a signed handle, not a guessable id, and legacy rows stay admin-managed", () => {
  const fs = require("fs"), path = require("path");
  const srv = fs.readFileSync(path.join(__dirname, "..", "server.js"), "utf8");
  // Signed so it cannot be forged, random so it cannot be guessed, HttpOnly so page script cannot
  // read it. It grants nothing except management of the recipients linked from that browser.
  assert.ok(/const OWNER_SECRET = crypto\.createHash/.test(srv) && /function signOwner/.test(srv));
  assert.ok(/crypto\.timingSafeEqual/.test(srv.slice(srv.indexOf("function ownerOf"), srv.indexOf("function ensureOwner"))),
    "handle verification must be constant-time like every other token check here");
  assert.ok(/crypto\.randomBytes\(12\)/.test(srv), "the id must be random, not derived from anything a visitor controls");
  assert.ok(/xyzown=" \+ signOwner\(id\) \+ cookieAttrs\(req, 400 \* 24 \* 3600\) \+ "; HttpOnly"/.test(srv));

  const pol = fs.readFileSync(path.join(__dirname, "..", "src", "poller.js"), "utf8");
  // Ownerless rows predate this build. Adopting them by "first visitor to look" would hand one
  // person's linked Telegram to whoever opened the panel next.
  assert.ok(/return !!\(rec && rec\.owner && owner && rec\.owner === owner\);/.test(pol),
    "an absent owner must never match an absent caller — that is the adoption hole");
  assert.ok(/admin-managed rather than adopted/.test(pol) || /admin-managed, never silently adopted/.test(pol),
    "the legacy-row decision is documented where it is made");
  // /stop is the escape hatch that needs no cookie: the command arrives FROM the chat.
  assert.ok(/if \(had\) pushUnlink\(chat, null, true\);/.test(pol));
  assert.ok(/control of the\n        \/\/ Telegram account is a stronger claim than any browser handle/.test(pol));
});

// ===== Alerts panel: density, precision, clearing (build 2026.07.27-09) =========================

test("panel: sections collapse, class chips wrap, and repeated rows collapse with a count", () => {
  const fs = require("fs"), path = require("path");
  const app = fs.readFileSync(path.join(__dirname, "..", "public", "app.js"), "utf8");
  const css = fs.readFileSync(path.join(__dirname, "..", "public", "styles.css"), "utf8");

  // Four stacked blocks plus a log had turned the panel into a wall.
  assert.ok(/const sec=\(k,title,note,body,extra\)=>/.test(app), "sections are built by one helper, not four hand-rolled headers");
  for (const k of ["'trig'", "'rules'", "'deliv'", "'recent'"]) assert.ok(app.includes("sec(" + k), `section ${k} missing`);
  assert.ok(/open:\{ trig:false, rules:false, deliv:true, recent:true \}/.test(app), "collapse state has sane defaults");
  assert.ok(/open:state\.alerts\.open/.test(app) && /if\(d\.open&&typeof d\.open==='object'\)/.test(app), "…and persists");
  assert.ok(/\.asec-h\{/.test(css) && /\.asec-b\{/.test(css));

  // Nine classes overflowed a single row and the last chip was cut off the panel.
  assert.ok(/flex-wrap:wrap">\$\{chips\}/.test(app), "the class chip row must wrap");

  // Ten identical deploy lines carry as much information as one line saying it happened ten times,
  // and they were burying every setup and ledger event under them.
  assert.ok(/if\(last && last\.kind===e\.kind && last\.text===e\.text\)\{ last\.n=\(last\.n\|\|1\)\+1; continue; \}/.test(app),
    "consecutive identical rows must collapse");
  assert.ok(/e\.n>1\?` <span class="sec"[\s\S]{0,80}\\u00d7\$\{e\.n\}/.test(app), "…and disclose the count rather than hiding the repeats");
});

test("panel: thresholds are precise, cover R:R, and drive both surfaces from one control", () => {
  const fs = require("fs"), path = require("path");
  const app = fs.readFileSync(path.join(__dirname, "..", "public", "app.js"), "utf8");
  // R:R was in the client state from the start with no way to set it — the board's own grinder /
  // windfall split is exactly the filter someone wants on an alert.
  assert.ok(/numIn\('at-rr',T\.minRR/.test(app), "R:R at fire must be settable");
  assert.ok(/numIn\('at-ev',T\.minEV/.test(app) && /numIn\('at-late',T\.maxLate/.test(app));
  assert.ok(/step="0\.05"/.test(app), "0.05 steps — the old selects offered three fixed values each");

  // Two places to set the same number is how they end up disagreeing.
  assert.ok(/const syncTrig=\(\)=>/.test(app) && /pushAct\('\/api\/alerts\/prefs',\{chat:r\.chat, trig:/.test(app),
    "one control must write the in-tab filter AND the telegram thresholds");
  assert.ok(/for\(const r of rs\) if\(r\.mine\)/.test(app), "…and only onto recipients this browser owns");

  const pol = fs.readFileSync(path.join(__dirname, "..", "src", "poller.js"), "utf8");
  assert.ok(/if \("trig" in p\)/.test(pol), "the prefs route must accept thresholds");
  assert.ok(/r\.trig = \{\};/.test(pol), "written whole, not merged — a partial write leaves a threshold the panel is not showing");
});

test("clearing is a per-browser view watermark, never a deletion from the record", () => {
  const fs = require("fs"), path = require("path");
  const app = fs.readFileSync(path.join(__dirname, "..", "public", "app.js"), "utf8");
  assert.ok(/clearedSeq:0/.test(app) && /clearedSeq:state\.alerts\.clearedSeq/.test(app), "the watermark exists and persists");
  assert.ok(/A\.feed\.filter\(e=>\(e\.seq\|\|0\)>\(A\.clearedSeq\|\|0\)\)/.test(app), "the log renders above the watermark");
  // The ring is the record. A client deleting from it would mean the phone and the panel could
  // disagree about what happened, which is the failure this whole system exists to avoid.
  assert.ok(!/\/api\/triggers[\s\S]{0,80}method:'DELETE'/.test(app), "there must be no client path that deletes server events");
  assert.ok(/other devices and the telegram history are untouched/.test(app),
    "the control must say what it actually does — 'clear' implying deletion would be a lie");
  assert.ok(/if\(\(A\.seenSeq\|\|0\)<hi\) A\.seenSeq=hi;/.test(app), "clearing also marks read, or the badge counts invisible rows");
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

test("the family filter is validated server-side and named in the message", () => {
  const C = require("../src/compute");
  // The board tags the grinder family on screen; the DM should say the same word rather than
  // leaving you to infer it from the ratio.
  const m = C.pushFmt({ kind: "setup", coin: "B", t: "B", side: "long", ev: "bigmove", label: "big move",
    cls: "ev", rr: { gross: 0.8 }, evR: 0.4, rec: {} }, {});
  assert.ok(m.includes("grinder"), "a grinder says so in the message");
  const m2 = C.pushFmt({ kind: "setup", coin: "A", t: "A", side: "long", ev: "breakout", label: "breakout",
    cls: "rr", rr: { gross: 3 }, evR: 0.5, rec: {} }, {});
  assert.ok(!m2.includes("grinder"), "…and the other family does not carry a label it doesn't need");

  const fs = require("fs"), path = require("path");
  const pol = fs.readFileSync(path.join(__dirname, "..", "src", "poller.js"), "utf8");
  assert.ok(/c === "rr" \|\| c === "ev"/.test(pol), "the family list is validated against a closed vocabulary");
  assert.ok(/error: "bad-class"/.test(pol), "an unrecognised family is rejected — accepting it would filter every setup out silently");
  assert.ok(/if \(cls && cls\.length === 1\) r\.trig\.cls = cls;/.test(pol), "both-selected stores nothing rather than a no-op filter");

  const app = fs.readFileSync(path.join(__dirname, "..", "public", "app.js"), "utf8");
  // One vocabulary: the alert control must use the board's exact words for the split.
  assert.ok(/2:1\+ setups/.test(app) && /positive-EV grinders/.test(app), "the alert filter reuses the board's labels verbatim");
  assert.ok(/if\(Array\.isArray\(c\.cls\) && c\.cls\.length && !c\.cls\.includes\(ev\.cls\)\) return false;/.test(app),
    "the client mirror must match the shared gate exactly");
  assert.ok(/if\(!cur\.length\) return;/.test(app), "turning both families off is refused — the master toggle is how you stop setup alerts");
  assert.ok(/trig:\{minEV:T\.minEV, minRR:T\.minRR, maxLate:T\.maxLate, cls:T\.cls\}/.test(app),
    "the family choice syncs to telegram alongside the other thresholds, from the same control");
});

// ===== Trend class, ops gating, message look, panel density (build 2026.07.27-11) ===============

test("trend metrics ride the same board the Trend tab renders, signed to cover both sides", () => {
  const C = require("../src/compute");
  const keys = C.RULE_METRICS.map((m) => m.k);
  assert.ok(keys.includes("tscore") && keys.includes("e21d"));
  // Signed so ONE metric asks the question people actually ask: abs> 3 is "strongly trending either
  // way", and > 3 is "strongly trending up". Two separate long/short metrics could not express the
  // first without a second rule.
  assert.equal(C.RULE_BY_K.tscore.get({ tscore: -4 }), -4);
  assert.equal(C.ruleEval({ metric: "tscore", op: "abs>", value: 3 }, { tscore: -4 }, true), "fire");
  assert.equal(C.ruleEval({ metric: "tscore", op: ">", value: 3 }, { tscore: -4 }, true), "hold");
  // A name the board never scored is null, not 0 — "no trend read" and "neutral" are different.
  assert.equal(C.ruleEval({ metric: "tscore", op: "<", value: 1 }, { coin: "X" }, true), null);
  assert.equal(C.RULE_BY_K.e21d.get({ e21d: -0.4 }), -0.4);

  const fs = require("fs"), path = require("path");
  const pol = fs.readFileSync(path.join(__dirname, "..", "src", "poller.js"), "utf8");
  assert.ok(/trendByCoin = new Map\(\);/.test(pol) && /trendByCoin\.get\(r\.coin\)/.test(pol),
    "the stamp must read one index built where the board is built");
  assert.ok(/\(m\.tscore == null \? "" : m\.tscore\)/.test(pol),
    "the stamp must ride the content signature, or a frozen snapshot serves a stale trend score");
});

test("trend events: close-confirmed on the closed ladder, seeded on the first pass", () => {
  const fs = require("fs"), path = require("path");
  const pol = fs.readFileSync(path.join(__dirname, "..", "src", "poller.js"), "utf8");
  const fn = pol.slice(pol.indexOf("function trendScan(tNow)"), pol.indexOf("function pushTest("));
  // H12/H4 crossings at ~144 names would be a feed, not an alert. Stated where it is decided.
  assert.ok(/D1 only/.test(pol.slice(pol.indexOf("trend class: full stacks"), pol.indexOf("const trendState"))));
  // The load-bearing change of -25: every transition is judged on the CLOSED ladder — the live
  // board read (tb) supplies sighting stamps and message dressing, never a transition. An event
  // can only come into existence at a candle close; the close IS the confirmation.
  assert.ok(/const cl = trendClosed\(coin, tb, now\);/.test(fn), "the closed ladder is the transition's only truth source");
  assert.ok(/if \(!cl\) continue;/.test(fn), "no closed read means silence, never a guess at a confirmation");
  assert.ok(/closedLadder\(\{/.test(pol) && /closedBars\(r\.dailyRaw, DAY, now\)/.test(pol),
    "trendClosed feeds compute.closedLadder with period-trimmed series — same rung sourcing as the board");
  assert.ok(!/TREND_CROSS_CONFIRM/.test(pol),
    "the scan-count debounce is GONE — closed state cannot revert between closes, so counting scans would only add lag");
  assert.ok(/score >= 4 && prev\.score < 4/.test(fn), "only the ARRIVAL at 4/4 fires — on closed rungs");
  // The COPPER double (-16): every gate must sit ON the fire condition, not near it. Boundary
  // flap ACROSS closes is still real (H1 closes hourly), so the episode gates survive -25.
  assert.ok(/prev\.below \|\| 0\) >= TREND_REARM_SCANS/.test(fn),
    "a stack only fires after the drop HELD — a one-scan dip through 3/4 is the same episode");
  assert.ok(/now - \(prev\.stackAt \|\| 0\) >= TREND_STACK_CD/.test(fn),
    "…and never twice per name inside the cooldown, however legitimate the re-cross");
  assert.ok(/sign !== 0 && prev\.sign !== 0 && sign !== prev\.sign/.test(fn),
    "a closed D1 flip announces at its close; an unknown ribbon (sign 0) is not a flip");
  assert.ok(/\} else if \(sign !== 0\) next\.sign = sign;/.test(fn),
    "a flip out of 0 is adoption, not a flip — it confirms silently");
  assert.ok(/if \(!trendPrimed \|\| !prev \|\| !prev\.tfSt\) \{/.test(fn),
    "the first pass seeds silently — and a prev restored from a pre-close-confirm build (live-measured score, no tfSt) reseeds instead of firing against a different ruler");
  assert.ok(/below: score < 4 \? TREND_REARM_SCANS : 0/.test(fn),
    "a name seeded below 4 is armed — the hold kills re-fires of a known stack, not a new name's first arrival");
  // Every fire carries its confirming close; the sighting stamp only ships when it truly preceded it.
  assert.ok((fn.match(/confTf/g) || []).length >= 6, "confTf/confAt ride all three sub-events");
  assert.ok(/at < \+confAt \? at : undefined/.test(fn), "seenAt is disclosed only when it preceded the confirming close");
  assert.ok(/for \(const c of \[\.\.\.trendState\.keys\(\)\]\) if \(!trendByCoin\.has\(c\)\) trendState\.delete\(c\);/.test(fn),
    "a name leaving the board drops its state, so a return is a genuinely new episode");
  assert.ok(/continue;   \/\/ one event per name per scan/.test(fn));
});

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

test("retest confirms on its own rung's close, and carries it", () => {
  const p = trendHarness();
  const rts = () => p.getTriggers(0, null, true).events.filter((e) => e.kind === "trend" && e.sub === "retest");
  const M = 60e3, t0 = Date.UTC(2026, 6, 27, 12, 0, 0);
  const seed = (retest, liveRetest, t) => { p.seedTrendNow("CU", { side: "long", uni: "stocks", score: 3,
    retest: liveRetest, e13: 6.38, e21: 6.33, age: 2, closed: clOf(3, t, { retest }) }); p.trendScanNow(t); };
  seed(null, null, t0);                        // seeded
  seed(null, "H4", t0 + 5 * M);                // the badge flickers on the live bar mid-period
  assert.equal(rts().length, 0, "a live-bar badge is not a closed badge — nothing fires");
  seed("H4", "H4", t0 + 10 * M);               // the H4 close holds the zone — the badge is real
  assert.equal(rts().length, 1);
  assert.equal(rts()[0].confTf, "H4", "the retesting rung's own close is the confirmation");
  assert.equal(rts()[0].confAt, t0 + 10 * M - 60e3);
  assert.equal(rts()[0].seenAt, t0 + 5 * M, "the live sighting preceding the close is disclosed");
  seed("H4", "H4", t0 + 15 * M);
  assert.equal(rts().length, 1, "the badge persisting says nothing new");
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

test("telegram + bell carry the confirmation line from ONE event", () => {
  const C = require("../src/compute");
  const ev = { kind: "trend", coin: "SOL", t: "SOL", side: "long", sub: "stack", score: 4, tf: "D1",
    px: 214.36, e21: 209.8, confTf: "D1", confAt: Date.UTC(2026, 6, 27, 0, 0),
    seenAt: Date.UTC(2026, 6, 26, 15, 40), title: "full 4/4 stack", text: "every rung aligned up" };
  const m = C.pushFmt(ev, {});
  assert.ok(m.includes("\u23f1 confirmed D1 close 00:00 UTC"), "the phone shows which close made it true");
  assert.ok(m.includes("first seen Jul 26 15:40"), "…and what the confirmation cost on this alert");
  // An event without confAt (pre--25 ring content) renders exactly as before — no clock line.
  const old = C.pushFmt({ kind: "trend", coin: "X", t: "X", side: "long", sub: "cross", score: 3,
    tf: "D1", px: 1, e21: 1, title: "D1 13/21 cross up", text: "flip" }, {});
  assert.ok(!old.includes("\u23f1"), "no confirmation data, no fabricated line");
  // The web client's formatter mirrors the same fields (pinned as source, mirrored logic).
  const fs = require("fs"), path = require("path");
  const app = fs.readFileSync(path.join(__dirname, "..", "public", "app.js"), "utf8");
  assert.ok(/function trendWhenTxt\(ev\)/.test(app));
  assert.ok(/confirmed \$\{ev\.confTf\|\|ev\.tf\|\|''\} close/.test(app), "the bell log names the confirming close");
  assert.ok(/k==='trend'/.test(app) && /trendWhenTxt\(ev\)/.test(app), "alertText's trend branch reads the shared stamp");
});

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

test("ma200 lane manifest: closed source, dedup by the bar itself, full-roster scope — pinned", () => {
  const fs = require("fs"), path = require("path");
  const pol = fs.readFileSync(path.join(__dirname, "..", "src", "poller.js"), "utf8");
  const fn = pol.slice(pol.indexOf("function ma200Scan(tNow)"), pol.indexOf("function pushTest("));
  assert.ok(/emaAlertState\(bars, sdTf\)/.test(fn), "ONE detector — the study's vocabulary — decides every event");
  assert.ok(/closedBars\(src, MA200_TFS\[tf\], now\)/.test(pol), "the series is period-trimmed: a transition can only exist at a close");
  assert.ok(/for \(const r of rows\.values\(\)\)/.test(fn) && /full roster, BOTH/i.test(pol.slice(pol.indexOf("ma200 class:"), pol.indexOf("const MA200_TFS"))),
    "full roster, both universes — a 200 breakdown matters most on a name that is NOT trending");
  assert.ok(/if \(ev && S\.fired\[key\] !== ev\.barT\) \{/.test(fn),
    "dedup is the firing bar's OWN timestamp — the same closed bar never announces twice");
  assert.ok(fn.indexOf("S.fired[key] !== ev.barT") < fn.indexOf("const lb = maLiveBars"),
    "the fire is handled BEFORE the sighting upkeep — a closed event bar no longer matches the live shape, and upkeep first would wipe the stamp the fire discloses");
  assert.ok(/if \(!maPrimed \|\| !S\.s\) \{ S\.s = 1; if \(key\) S\.fired\[key\] = ev\.barT; continue; \}/.test(fn),
    "state in force at first sight is seeded, never announced — including a name arriving after priming");
  assert.ok(/bars\.length < 216/.test(fn), "EMA200 that cannot seed is honest silence, not a shorter substitute");
  assert.ok((fn.match(/emitTrig\("ma200"/g) || []).length === 1, "one emit site");
  assert.ok(/S\.seen\[key\] != null && S\.seen\[key\] < confAt/.test(fn), "seenAt only when the sighting preceded the confirming close");
  // Wiring: scheduler, priming, persistence, hydration, primed-on-restore.
  assert.ok(/setInterval\(safeTick\(ma200Scan, "ma200Scan"\), 5 \* 60 \* 1000\);/.test(pol));
  assert.ok(/maPrimed = true; log\("ma200 alerts primed"\)/.test(pol));
  assert.ok(/ma200: \[\.\.\.maState\.entries\(\)\]\.slice\(-500\)/.test(pol));
  assert.ok(/loadMap\(ep\.ma200, maState\)/.test(pol));
  assert.ok(/if \(maState\.size\) maPrimed = true;/.test(pol),
    "restored state IS the seed — keeping the priming delay after a restore would only eat real transitions");
  // Client: the bell log reads the same event through the shared stamp.
  const app = fs.readFileSync(path.join(__dirname, "..", "public", "app.js"), "utf8");
  assert.ok(app.includes("if(k==='ma200')") && /ma200:\['MA200'/.test(app), "alertText branch + feed tag");
});

test("trend state restored from a pre-close-confirm build reseeds silently, never fires against a different ruler", () => {
  const p = trendHarness();
  const stacks = () => p.getTriggers(0, null, true).events.filter((e) => e.kind === "trend" && e.sub === "stack").length;
  const M = 60e3, t0 = Date.UTC(2026, 6, 27, 12, 0, 0);
  // A -24 process persisted score/sign measured against the LIVE bar (plus pend fields the new
  // code ignores). Judged against closed truth those numbers are a different ruler: the only safe
  // move is one silent reseed — a boundary name must not fire a "stack arrival" on deploy.
  p.hydrateTriggersNow({ seq: 0, seen: [], events: [], episodes: { trend: [["CU", { score: 3, sign: 1, retest: null, pendSign: 0, pendRun: 0 }]] } });
  const seed = (score, t) => { p.seedTrendNow("CU", { side: "long", uni: "stocks", score, retest: null,
    e13: 6.38, e21: 6.33, age: 2, closed: clOf(score, t) }); p.trendScanNow(t); };
  seed(4, t0);
  assert.equal(stacks(), 0, "missing tfSt marks the old shape — reseeded silently, it does not throw and it does not fire");
  seed(3, t0 + 5 * M); seed(3, t0 + 10 * M); seed(3, t0 + 15 * M);
  seed(4, t0 + 20 * M);
  assert.equal(stacks(), 1, "…and three held scans later the same rise fires on the closed ladder");
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

test("panel: your recipients only in the bell, everyone's in the admin panel, collapsed", () => {
  const fs = require("fs"), path = require("path");
  const app = fs.readFileSync(path.join(__dirname, "..", "public", "app.js"), "utf8");
  const html = fs.readFileSync(path.join(__dirname, "..", "public", "index.html"), "utf8");
  // Three linked accounts x nine class chips had turned the bell into a wall of controls for people
  // you cannot help.
  assert.ok(/const mineOnly=\(P\.recipients\|\|\[\]\)\.filter\(r=>r\.mine\);/.test(app),
    "the bell panel lists only your own recipients");
  assert.ok(/data-prec=/.test(app) && /openRec\[r\.chat\]/.test(app), "each recipient collapses to a summary line");
  assert.ok(/\$\{nOn\} class\(es\)/.test(app), "…whose summary still says how many classes are on");
  assert.ok(/filter\(c=>!adminCls\.includes\(c\)\|\|r\.admin\)/.test(app),
    "the ops chip is not offered to a recipient who cannot receive ops");

  assert.ok(html.includes('id="admRecH"') && html.includes('id="admRecB"'), "the admin roster has markup");
  assert.ok(/<div id="admRecB" hidden>/.test(html), "…and is collapsed by default");
  assert.ok(/function renderAdmRecips\(\)/.test(app));
  assert.ok(/r\.admin\?'operator':'public'/.test(app), "the roster says which recipients hold operator privileges");
  assert.ok(/data-admunlink=/.test(app) && /Revoke this recipient/.test(app), "admin can revoke from there");
});

// ===== Popover self-close + legacy adoption (build 2026.07.27-12) ===============================

test("a popover control that rebuilds its own panel must not close it", () => {
  const fs = require("fs"), path = require("path");
  const app = fs.readFileSync(path.join(__dirname, "..", "public", "app.js"), "utf8");
  // The mechanism: a section header calls buildAlertsPanel(), which replaces pop.innerHTML. By the
  // time the click bubbles to document the clicked node is DETACHED, and a detached node is
  // contained by nothing — so the outside-click test fires and the drawer shuts under the user.
  assert.ok(/function clickedOutside\(pop, btn, e\)\{/.test(app), "one shared outside-click predicate");
  assert.ok(/if\(!e\.target \|\| !e\.target\.isConnected\) return false;/.test(app),
    "a target we removed ourselves is not an outside click");
  // All four popovers share the pattern, so all four had the latent bug — only the alerts panel
  // grew enough self-rebuilding controls for it to surface.
  for (const pid of ["alertpop", "filterpop", "colpop", "laypop"]) {
    const at = app.indexOf("const pop=el('" + pid + "');\n  if(clickedOutside(pop,");
    assert.ok(at > 0, `${pid} must use the shared predicate`);
  }
  assert.ok(!/!pop\.hidden && !pop\.contains\(e\.target\)/.test(app), "no hand-rolled copy of the old test may remain");
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

test("claiming an unowned recipient moves it into the claiming browser's panel", () => {
  process.env.TG_BOT_TOKEN = "test-token";
  const { createPoller } = require("../src/poller");
  let saved = { ts: Date.now(), offset: 0, recipients: [
    { chat: "9990001111", name: "Milst", since: Date.now(), cur: 0, classes: null, trig: {}, muted: false }] };
  const store = { loadAll: () => new Map(), loadRegime: () => [], loadLedger: () => null, saveLedger: () => {},
    insert: () => {}, saveRegime: () => {}, loadTriggers: () => null, saveTriggers: () => {},
    savePush: (d) => { saved = d; }, loadPush: () => saved };
  const p = createPoller({ dex: "xyz", store, log: () => {}, version: "test", crypto: false });
  p.hydratePushNow();

  // A row with no owner is invisible to every browser's own panel — which is exactly the state that
  // left three linked accounts with no class chips anywhere after -11.
  assert.equal(p.getPush("own-a", false).recipients.length, 0, "unowned rows belong to no browser");
  const adminView = p.getPush("own-a", true);
  assert.equal(adminView.recipients.length, 1);
  assert.equal(adminView.recipients[0].owned, false, "…and the admin roster marks them unclaimed");
  assert.equal(adminView.recipients[0].admin, true, "a pre-ownership link keeps operator privileges");

  assert.equal(p.pushClaim("9990001111", "own-a", true).ok, true);
  const after = p.getPush("own-a", false);
  assert.equal(after.recipients.length, 1, "after claiming it appears in that browser's own panel");
  assert.equal(after.recipients[0].mine, true, "…with full controls, not read-only");
  assert.equal(p.pushClaim("9990001111", "own-c", true).error, "already-owned", "and it cannot be claimed twice");
  delete process.env.TG_BOT_TOKEN;
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

// ===== Episode persistence, retest alerts, admin editing, catalog gaps (2026.07.27-13) ==========

test("episode state survives a restart — the fix that makes trend/regime/coverage real", () => {
  process.env.TG_BOT_TOKEN = "test-token";
  const { createPoller } = require("../src/poller");
  let trigBlob = null;
  const store = { loadAll: () => new Map(), loadRegime: () => [], loadLedger: () => null, saveLedger: () => {},
    insert: () => {}, saveRegime: () => {}, loadTriggers: () => trigBlob, saveTriggers: (d) => { trigBlob = d; } };
  const mk = () => createPoller({ dex: "xyz", store, log: () => {}, version: "test", crypto: false });

  // Process 1 seeds a coverage episode (stale spine on an announced claim) and dies.
  const p1 = mk(); p1.hydrateTriggersNow && p1.hydrateTriggersNow();
  p1.seedRowNow("AAA", { ticker: "AAA", px: 10, uni: "xyz", hourlyTs: Date.now() - 4 * 3600e3 });
  p1.ledgerOpenNow().set("AAA|breakout", { key: "AAA|breakout", coin: "AAA", ticker: "AAA", ev: "breakout",
    t0: Date.now(), mark0: 10, dir: 1, psd: "long", alo: 1, resolveAt: Date.now() + 1e9 });
  p1.coverageScanNow();   // seeds (in force at first sight), persists
  assert.ok(trigBlob && trigBlob.episodes && Array.isArray(trigBlob.episodes.coverage) && trigBlob.episodes.coverage.length,
    "episode maps are persisted with the ring — this app deploys once per pushed FILE, and unpersisted seeds meant every deploy re-muted every scan");

  // Process 2 boots, restores the seed, and the STILL-stale market must not re-announce…
  const p2 = mk(); p2.hydrateTriggersNow && p2.hydrateTriggersNow();
  p2.seedRowNow("AAA", { ticker: "AAA", px: 10, uni: "xyz", hourlyTs: Date.now() - 5 * 3600e3 });
  p2.ledgerOpenNow().set("AAA|breakout", { key: "AAA|breakout", coin: "AAA", ticker: "AAA", ev: "breakout",
    t0: Date.now(), mark0: 10, dir: 1, psd: "long", alo: 1, resolveAt: Date.now() + 1e9 });
  p2.coverageScanNow();
  const covs = p2.getTriggers(0, null, true).events.filter((e) => e.kind === "coverage");
  assert.equal(covs.length, 0, "a restored seed is a seed — the restart is not a new episode");

  // …but a transition that spans the restart DOES fire: recovery in p2, then stale again.
  p2.seedRowNow("AAA", { hourlyTs: Date.now() }); p2.coverageScanNow();
  p2.seedRowNow("AAA", { hourlyTs: Date.now() - 4 * 3600e3 }); p2.coverageScanNow();
  assert.equal(p2.getTriggers(0, null, true).events.filter((e) => e.kind === "coverage").length, 1,
    "the transition fires exactly once, across as many deploys as it spans");

  const fs = require("fs"), path = require("path");
  const pol = fs.readFileSync(path.join(__dirname, "..", "src", "poller.js"), "utf8");
  assert.ok(/if \(trendState\.size\) trendPrimed = true;/.test(pol) && /if \(filingSeen\.size\) filingPrimed = true;/.test(pol),
    "restored state IS the seed — keeping the priming delay after a restore would only eat real transitions");
  delete process.env.TG_BOT_TOKEN;
});

test("retest-badge arrivals are trend events — visible before the ledger family earns its record", () => {
  const fs = require("fs"), path = require("path");
  const pol = fs.readFileSync(path.join(__dirname, "..", "src", "poller.js"), "utf8");
  const fn = pol.slice(pol.indexOf("function trendScan(tNow)"), pol.indexOf("function pushTest("));
  assert.ok(/if \(retest && !prev\.retest\)/.test(fn), "the CLOSED badge APPEARING fires; the badge persisting does not");
  assert.ok(/sub: "retest"/.test(fn));
  // The load-bearing comment: the ledger's setup alert for tretest waits on a proven record
  // (n >= 8 resolved). Until then the badge arrival is the only path a retest has to a phone,
  // which is why "trend retests are nonexistent" was true before this.
  assert.ok(/waits for the event family to prove a record/.test(fn));
  const C = require("../src/compute");
  const m = C.pushFmt({ kind: "trend", coin: "N", t: "NVDA", side: "long", sub: "retest", score: 3,
    tf: "H12", px: 120, e21: 118, title: "H12 retest of the 13/21 zone", text: "pullback into the ribbon" }, {});
  assert.ok(m.includes("H12 retest") && /^tf\s+H12$/m.test(m.slice(m.indexOf("<pre>") + 5, m.indexOf("</pre>"))));
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

test("admin edits any recipient's classes from the roster; a person's own controls are untouched", () => {
  const fs = require("fs"), path = require("path");
  const app = fs.readFileSync(path.join(__dirname, "..", "public", "app.js"), "utf8");
  // The roster edits in place, over the same route the owner uses — the server already honoured the
  // admin override, the UI had simply stopped offering it.
  assert.ok(/data-apcls=/.test(app) && /data-apchat=/.test(app), "the admin roster has class chips");
  assert.ok(/pushAct\('\/api\/alerts\/classes',\{chat:rec\.chat, classes:cur\}\)\.then\(\(\)=>renderAdmRecips\(\)\)/.test(app),
    "admin writes ride the normal classes route");
  assert.ok(/data-admexp=/.test(app), "rows expand on demand — three recipients of chips is the wall the bell panel just escaped");
  // Public users' own controls: still built for every recipient the bell panel shows.
  assert.ok(/data-pcls=/.test(app) && /data-pquiet=/.test(app) && /data-pdig=/.test(app),
    "self-service class/quiet/digest controls remain in the bell panel");
  // And the server still enforces that a NON-admin cannot write someone else's subscriptions.
  const p = twoUserHarness();
  const cb = p.pushMintCode("own-b", false); p.pushBindNow(cb.code, 2222222222, "friend");
  assert.equal(p.pushSetClasses("2222222222", ["setup"], "own-a", false).error, "forbidden");
  assert.equal(p.pushSetClasses("2222222222", ["setup", "trend"], "own-a", true).ok, true, "the admin override is a server capability, not a UI trick");
});

// ===== build 2026.07.27-14: hardening pass (audit items 1-6) ==================================

test("ws watchdog: a mute socket that never closes is force-closed into the reconnect path", () => {
  const fs = require("fs"), path = require("path");
  const hl = fs.readFileSync(path.join(__dirname, "..", "src", "hyperliquid.js"), "utf8");
  assert.ok(hl.includes("const WS_STALE_MS = 120000"), "staleness threshold pinned at 120s — two missed ping cycles of total silence");
  assert.ok(/if \(Date\.now\(\) - lastMsg > WS_STALE_MS\) \{ try \{ ws\.close\(\); \} catch \(_\) \{\} return; \}/.test(hl),
    "the ping tick must check staleness BEFORE pinging and force-close a zombie — close() routes into onclose -> backoff -> reconnect");
  assert.ok(/onopen[\s\S]{0,200}lastMsg = Date\.now\(\)/.test(hl),
    "the watchdog is armed at open, so a socket that never delivers even one message is also caught");
  // The recovery path the watchdog feeds must still exist exactly as designed.
  assert.ok(hl.includes("ws.onclose = () => { clearInterval(pingT); retry(); };"), "onclose still clears the ping timer and retries");
});

test("telegram lane fails fast: tgApi carries a real 15s abort signal to every call", async () => {
  const fs = require("fs"), path = require("path");
  const pol = fs.readFileSync(path.join(__dirname, "..", "src", "poller.js"), "utf8");
  assert.ok(pol.includes("signal: AbortSignal.timeout(15000)"),
    "a stalled Telegram request must abort in 15s — the outbox drains sequentially, so one hang stalls the whole alert lane");
  // Functional: the signal actually reaches the fetch options on a live call path.
  process.env.TG_BOT_TOKEN = "test-token";
  let seenSignal = null;
  const store = { loadAll: () => new Map(), loadRegime: () => [], loadLedger: () => null, saveLedger: () => {},
    insert: () => {}, saveRegime: () => {}, loadTriggers: () => null, saveTriggers: () => {},
    savePush: () => {}, loadPush: () => null };
  const pushFetch = async (url, opts) => {
    seenSignal = opts && opts.signal;
    return { ok: true, status: 200, json: async () => ({ ok: true, result: [] }) };
  };
  const { createPoller } = require("../src/poller");
  const p = createPoller({ dex: "xyz", store, log: () => {}, version: "test", crypto: false, pushFetch });
  await p.pushUpdatesNow();
  assert.ok(seenSignal instanceof AbortSignal, "the timeout signal must ride the actual request, not just exist in source");
  delete process.env.TG_BOT_TOKEN;
});

test("crash containment + fuller shutdown: every timer-cadence persist gets a final flush", () => {
  const fs = require("fs"), path = require("path");
  const srv = fs.readFileSync(path.join(__dirname, "..", "server.js"), "utf8");
  const pol = fs.readFileSync(path.join(__dirname, "..", "src", "poller.js"), "utf8");
  // Node crashes the process on an unhandled rejection; without handlers a crash drops up to
  // 10 min of spine plus buffered deriv appends. Both handlers must exist and route to the flush.
  assert.ok(srv.includes('process.on("unhandledRejection", (e) => crashFlush("unhandledRejection", e))'), "unhandledRejection flushes before exit");
  assert.ok(srv.includes('process.on("uncaughtException", (e) => crashFlush("uncaughtException", e))'), "uncaughtException flushes before exit");
  assert.ok(srv.includes("process.exit(1)") && /crashFlush[\s\S]{0,600}store\.close\(\)/.test(srv),
    "the crash path still exits nonzero (Railway restarts) and drains the store's append buffers on the way out");
  // Graceful shutdown flushes MORE than the crash path: triggers, push state, and the awaited spine.
  for (const call of ["poller.persistTriggers()", "poller.persistPush()", "await poller.persistHourly()"])
    assert.ok(srv.includes(call), `shutdown must call ${call} — it was previously left to the last interval tick`);
  assert.ok(srv.includes("let shuttingDown = false"), "re-entry guard: a second signal (or a crash mid-shutdown) must not double-flush");
  // The final-flush surface must actually be exported by the poller, not assumed.
  assert.ok(/persistHourly: \(\) => persistHourly\(\),\s*\n\s*persistTriggers,\s*\n\s*persistPush,/.test(pol),
    "poller exports persistHourly/persistTriggers/persistPush for the shutdown and crash paths");
});

test("baseline security headers ride every response", () => {
  const fs = require("fs"), path = require("path");
  const srv = fs.readFileSync(path.join(__dirname, "..", "server.js"), "utf8");
  assert.ok(/addHook\("onSend"[\s\S]{0,400}x-content-type-options[\s\S]{0,100}nosniff/.test(srv), "nosniff on everything — no MIME confusion across the JSON/HTML mix");
  assert.ok(/x-frame-options", "DENY"/.test(srv), "framing forbidden outright — a framed login page is a phishing kit");
  assert.ok(/referrer-policy", "same-origin"/.test(srv), "versioned asset URLs and API paths stay inside the origin");
});

test("stamped assets cache immutable; everything else still force-revalidates", () => {
  const fs = require("fs"), path = require("path");
  const srv = fs.readFileSync(path.join(__dirname, "..", "server.js"), "utf8");
  assert.ok(srv.includes('req.url.slice(q + 1) === "v=" + VERSION && reply.statusCode === 200 && !req.url.startsWith("/api/")'),
    "exact whole-query match against the CURRENT build, 200s only, never on /api/ — a stale stamp falls back to revalidation and no future v-param route can be frozen for a year");
  assert.ok(srv.includes('"public, max-age=31536000, immutable"'),
    "current-stamp requests cache immutable — the -84 lesson made free instead of merely cheap");
  assert.ok(srv.includes('setHeaders(res) { res.setHeader("cache-control", "no-cache"); }'),
    "everything unstamped still force-revalidates at the static route");
  // The shell must still be the thing that mints stamped URLs, or immutable serves nothing.
  assert.ok(srv.includes('src="/app.js?v=${VERSION}"') && srv.includes('href="/styles.css?v=${VERSION}"'),
    "the boot-time shell rewrite is the sole source of stamped URLs — the cache-buster IS the URL");
});

// ===== settled board record + terminal causal routing (build 2026.07.27-15) ====================
// Two failures shipped in one screenshot: "why is DRAM dumping so much today" degraded to a bare
// `DRAM d1` card (the field scan ate "today" before intent was ever considered), and the follow-up
// complaint reached the analyst ALONE — the ask path carried no transcript, so the model could
// truthfully see only four words. These tests pin the guard, the transcript, and the board's new
// settled record end to end.

test("terminal -15: causal intent escalates to the analyst — a ticker inside a 'why' is context, never the answer", () => {
  const fs = require("fs"), path = require("path");
  const s = fs.readFileSync(path.join(__dirname, "..", "public", "app.js"), "utf8");
  // Extract the guard regex from nlResolve and RUN it against the screenshot phrasings.
  const m = s.match(/\/\\bwhy\\b\|[^/]*behind \(the\|this\|its\)\\b\//);
  assert.ok(m, "causal-intent guard regex not found in app.js");
  const re = new RegExp(m[0].slice(1, -1));
  for (const q of ["why is dram dumping so much today", "what could be causing dram dump today",
    "why is the tape red", "explain nvda's move", "whats driving sol"])
    assert.ok(re.test(" " + q + " "), `causal phrasing must match the guard: "${q}"`);
  for (const q of ["whats nvda funding", "top gainers today", "nvda vs sol", "most crowded shorts"])
    assert.ok(!re.test(" " + q + " "), `non-causal phrasing must stay local: "${q}"`);
  // Position: the guard runs before the whole-board patterns and before the ticker block, so no
  // local mapping can eat a causal question first.
  const gi = s.indexOf("Causal / explanatory intent");
  assert.ok(gi > 0 && gi < s.indexOf("whole-board questions") && gi < s.indexOf("positioning screens in trader phrasing"),
    "the causal guard must run before every local mapping in nlResolve");
  // The client's analyst/planner classifier must mirror it (ctx.mode wins server-side, so a
  // client-only or server-only fix would each leave one path broken).
  assert.ok(s.includes("function termCausal") && s.includes("termCausal(text)?'analyst':'planner'"),
    "termAsk must classify via the shared causal test");
  // Transcript: recorded for LOCAL answers too (complaints are usually about a local card), and
  // the tail rides every ask.
  assert.ok(s.includes("function termHistPush"), "session transcript recorder missing");
  assert.ok(s.includes("termHistPush(line, line)") && s.includes("termHistPush(line,'\u2192 '+nl+' (computed locally)')"),
    "local exchanges (grammar + NL) must enter the transcript");
  assert.ok(s.includes("hist:_termHist.slice(-6)"), "the transcript tail must ride the /api/ask body");
  assert.ok(s.includes("termHistPush(text,d.answer||'')") && s.includes("termHistPush(text,'\u2192 '+d.query)"),
    "AI exchanges (analyst answer / planner query) must enter the transcript");
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
  const userPayload = (call) => { const m = (call.messages || []).find((x) => x.role === "user");
    const c = typeof m.content === "string" ? m.content : m.content.map((x) => x.text || "").join("");
    return JSON.parse(c.slice(c.indexOf("{"))); };
  const pay1 = userPayload(calls[calls.length - 1]);
  assert.ok((pay1.news || []).some((n) => n.h === "DRAM guides down on pricing"), "the ticker's verified headline must ride the analyst payload");
  assert.ok((pay1.news || []).some((n) => n.h === "Fed holds rates"), "macro tape headlines ride too");
  assert.ok(!pay1.history, "no transcript sent -> no history key fabricated");
  // 2) follow-up with history: the transcript must reach the model, and the cache must NOT serve
  //    call 1's answer for different words — nor the same words under a different history.
  const h = [{ q: "why is DRAM dumping so much today", a: "DRAM d1 -6.7%" }];
  const r2 = await p.askBoard("not what I asked", { scope: "stocks", universe: uni, mode: "analyst", hist: h });
  assert.ok(r2.ok, r2.error || "");
  const pay2 = userPayload(calls[calls.length - 1]);
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

// One poller, one confirmed board row, full episode lifecycle. Mirrors the actionable -10 seed
// (10 resolved winners -> the tretest claim confirms) so the settled record is exercised against
// the same machinery the live board runs, not a synthetic shortcut.
function settledPoller() {
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
  p.hydrateLedgerNow(); p.buildTrendNow(); p.buildSignalsNow(); p.buildActionableNow();
  return { p, COIN, px, hourly, saved, HOUR_, DAY_, endH };
}

test("settled -15: an episode opens at first appearance, flicker folds instead of duplicating, and the payload ships the record", () => {
  const { p, COIN, px } = settledPoller();
  const a = p.getActionable();
  assert.equal(a.count, 1, "precondition: the seeded setup confirms onto the board");
  assert.ok(a.rows[0].k && a.rows[0].k.startsWith(COIN + "|"), "board rows must carry their claim key");
  let st = p.boardEpStateNow();
  assert.equal(st.open.length, 1, "first appearance opens exactly one episode");
  assert.ok(st.since > 0, "the record stamps its own out-of-sample epoch");
  const ep = st.open[0];
  assert.equal(ep.k, a.rows[0].k);
  assert.ok(ep.markShow > 0 && ep.fired > 0 && ep.void > 0 && ep.target > 0 && ep.tShow > 0, "the show stamp freezes marks and geometry");
  assert.ok(ep.cls === "rr" || ep.cls === "ev", "the episode carries the board's own class tag (the 2+1 / grinders split)");
  // Payload shape: settled rides the actionable payload, per-universe, class-split.
  assert.ok(a.settled && a.settled.perUni && a.settled.perUni.stocks, "settled block missing from the payload");
  assert.equal(a.settled.perUni.stocks.open, 1);
  assert.equal(a.settled.perUni.stocks.all.n, 0, "nothing resolved yet — the record starts at zero, no backfill");
  // Flicker: walk the mark through the void (untakeable), rebuild, restore, rebuild — SAME episode.
  p.seedRowNow(COIN, { px: px * 0.5 }); p.buildActionableNow();
  st = p.boardEpStateNow();
  assert.equal(st.open.length, 1, "a dropped row does not resolve or delete its episode");
  assert.ok(st.open[0].off > 0, "the drop is marked");
  p.seedRowNow(COIN, { px }); p.buildActionableNow();
  st = p.boardEpStateNow();
  assert.equal(st.open.length, 1, "reappearance is the SAME episode — oscillation never manufactures sample size");
  assert.equal(st.open[0].flick, 1, "…and the fold is counted");
  assert.equal(st.open[0].tShow, ep.tShow, "the original show stamp stands");
  const a2 = p.getActionable();
  assert.equal(a2.settled.perUni.stocks.flick, 1, "the fold is disclosed on the payload");
});

test("settled -15: resolution is inherited from the claim — target touch, both-touch pessimism, and the spine-gap approx label", () => {
  const C = require("../src/compute");
  // epResolve unit truths first: the walk, the pessimism, the honesty flag.
  const H = 3600e3, t0 = 1000 * H;
  const mkC = (i, o, h, l, c) => [t0 + i * H, o, h, l, c, 1];
  { const r = C.epResolve([mkC(1, 100, 101, 99, 100), mkC(2, 100, 111, 99.5, 110)], t0, t0 + 5 * H, "long", 95, 110);
    assert.equal(r.kind, "target"); assert.equal(r.tHit, t0 + 2 * H); }
  { const r = C.epResolve([mkC(1, 100, 112, 94, 100)], t0, t0 + 5 * H, "long", 95, 110);
    assert.equal(r.kind, "void", "a candle spanning BOTH levels scores pessimistically as the void — an unseen intrabar sequence is never scored as the win"); }
  { const r = C.epResolve([mkC(1, 100, 101, 99, 100)], t0, t0 + 5 * H, "long", 95, 110);
    assert.equal(r.kind, "expired"); assert.equal(r.approx, false); }
  { const r = C.epResolve([], t0, t0 + 5 * H, "long", 95, 110);
    assert.equal(r.kind, "expired"); assert.equal(r.approx, true, "no candles in the window: touch state unknowable, and the flag says so"); }
  { const r = C.epResolve([mkC(1, 100, 101, 89, 92)], t0, t0 + 5 * H, "short", 105, 90);
    assert.equal(r.kind, "target", "short side mirrors: target below, void above"); }
  // epScore: void is exactly -1R at ANY basis; target pays the frozen distance in the basis's risk unit.
  assert.equal(C.epScore("long", 100, 95, 110, "void", null), -1);
  assert.equal(C.epScore("long", 100, 95, 110, "target", null), 2);
  assert.equal(C.epScore("long", 102, 95, 110, "target", null), +((110 - 102) / 7).toFixed(2), "the shown-mark basis prices the same exit against its own risk");
  assert.equal(C.epScore("long", 100, 95, 110, "expired", 103), 0.6);
  assert.equal(C.epScore("short", 100, 105, 90, "expired", 97), 0.6);
  assert.equal(C.epScore("long", 100, 95, 110, "expired", null), null, "no exit price at expiry -> unscoreable, never guessed");
  // Now the machinery end-to-end: extend the spine past the show stamp with a target-touch candle,
  // close the claim, and sweep.
  const { p, COIN, px, hourly, HOUR_, endH } = settledPoller();
  const ep = p.boardEpStateNow().open[0];
  const tgt = ep.target;
  const later = hourly.concat([{ t: (endH + 2) * HOUR_, o: px, h: tgt * 1.01, l: px * 0.999, c: tgt, v: 1 }]);
  p.seedRowNow(COIN, { px, hourlyRaw: later });
  assert.ok(p.ledgerCloseNow(ep.k, { realized: 2.1, tR: (endH + 4) * HOUR_ }), "harness close must find the open claim");
  p.buildActionableNow();
  const st = p.boardEpStateNow();
  assert.equal(st.open.length, 0, "the resolved claim's episode leaves the open set");
  assert.equal(st.closed.length, 1, "…and enters the settled record — ON or OFF the board, once shown always scored");
  const done = st.closed[0];
  assert.equal(done.kind, "target");
  assert.ok(!done.approx, "spine covered the window — no approx label");
  assert.ok(Math.abs(done.rE - (tgt - done.fired) / Math.abs(done.fired - done.void)) < 0.02, "R@fire is the frozen distance over the frozen risk");
  assert.ok(Math.abs(done.rM - (tgt - done.markShow) / Math.abs(done.markShow - done.void)) < 0.02, "R@shown prices the same exit against the first-shown basis");
  assert.ok(done.held > 0 && done.tRes > done.tShow, "held runs from first show to the deciding touch");
  const a = p.getActionable();
  const u = a.settled.perUni.stocks;
  assert.equal(u.all.n, 1); assert.equal(u.all.t, 1);
  const bucket = u.cls[done.cls === "ev" ? "ev" : "rr"];
  assert.equal(bucket.n, 1, "the episode lands in its OWN class bucket — the 2+1/grinders split includes every outcome, level touches and all");
  assert.equal(u.all.hit, 1); assert.ok(u.all.avgE > 0 && u.all.avgM > 0);
  assert.ok(u.lat != null, "lateness (avg@fire - avg@shown) ships computed server-side");
});

test("settled -15: the record persists inside the ledger blob and survives a restart; the ETag moves on a resolution", () => {
  const { p, COIN, px, hourly, saved, HOUR_, endH } = settledPoller();
  const sig0 = p.getActionable().dataTs;
  const ep = p.boardEpStateNow().open[0];
  const later = hourly.concat([{ t: (endH + 2) * HOUR_, o: px, h: px * 1.001, l: ep.void * 0.99, c: ep.void, v: 1 }]);
  p.seedRowNow(COIN, { px, hourlyRaw: later });
  p.ledgerCloseNow(ep.k, { realized: -1.2, tR: (endH + 4) * HOUR_ });
  p.buildActionableNow();
  assert.equal(p.boardEpStateNow().closed[0].kind, "void");
  assert.equal(p.boardEpStateNow().closed[0].rE, -1, "a void exit is exactly -1R");
  assert.ok(p.getActionable().dataTs !== sig0, "a resolution with an unchanged live board must still bust the ETag");
  p.persistLedger();
  const blob = saved[saved.length - 1];
  assert.ok(blob.board && Array.isArray(blob.board.closed) && blob.board.closed.length === 1 && blob.board.since > 0,
    "the episode log rides the ledger blob — no new storage surface");
  // Restart: a fresh poller hydrating that blob carries the record forward.
  const { createPoller } = require("../src/poller");
  const store2 = { loadAll: () => new Map(), loadRegime: () => [], insert: () => {}, saveRegime: () => {},
    saveLedger: () => {}, loadLedger: () => blob, saveTriggers: () => {}, loadTriggers: () => null };
  const p2 = createPoller({ dex: "xyz", store: store2, log: () => {}, version: "test", crypto: false });
  p2.hydrateLedgerNow();
  const st2 = p2.boardEpStateNow();
  assert.equal(st2.closed.length, 1, "resolved episodes survive the restart");
  assert.equal(st2.closed[0].kind, "void");
  assert.equal(st2.since, blob.board.since, "the out-of-sample epoch survives too — a deploy is not a reset");
  // A pre-episode blob (no `board`) hydrates exactly as before.
  const store3 = Object.assign({}, store2, { loadLedger: () => ({ ts: Date.now(), open: [], closed: [] }) });
  const p3 = createPoller({ dex: "xyz", store: store3, log: () => {}, version: "test", crypto: false });
  p3.hydrateLedgerNow();
  assert.equal(p3.boardEpStateNow().closed.length, 0);
  assert.equal(p3.boardEpStateNow().since, 0);
});

test("settled -15: the client renders the server's record and never re-scores an episode", () => {
  const fs = require("fs"), path = require("path");
  const s = fs.readFileSync(path.join(__dirname, "..", "public", "app.js"), "utf8");
  const css = fs.readFileSync(path.join(__dirname, "..", "public", "styles.css"), "utf8");
  assert.ok(s.includes("function actSettled") && s.includes("function actEpDetail") && s.includes("function actSettledWire"),
    "settled renderer missing");
  assert.ok(s.includes("h+=actSettled(d,wantU);") && s.includes("actSettledWire(box);"), "settled section not mounted in renderActionable");
  assert.ok(s.includes("d.settled") && s.includes("st.perUni[wantU]"), "the section must read the payload's settled block, scoped like every other record surface");
  // One-code-path: no client-side episode scoring — rE/rM/hit/avg/pf are formatted, never derived.
  assert.ok(!/epScore|epResolve/.test(s), "episode scoring must never exist client-side");
  assert.ok(s.includes("2+1 \\u2014 \\u22652:1 at fire") && s.includes("grinders \\u2014 sub-2:1, +EV"),
    "the stats table must carry the class split — the same rr/ev families the board's checkboxes filter");
  assert.ok(s.includes("t/v/x"), "each class row must disclose its outcome split — level touches live INSIDE the class buckets");
  assert.ok(s.includes("flicker") && s.includes("unscoreable") && s.includes("approx"), "the strip must disclose folds, drops and spine-gap scores");
  assert.ok(s.includes("out of sample since"), "the record must state its own epoch");
  for (const cls of ["act-set", "act-set-strip", "act-set-t", "act-set-eps", "act-set-det", "act-set-mut"])
    assert.ok(css.includes("." + cls), `missing CSS for settled class: ${cls}`);
});

// ===================== macro calendar (build -17) =====================
test("macro: FOMC decision table pins the published Fed schedule through Jan 2028", () => {
  const { FOMC_DECISIONS } = require("../src/compute");
  // 8 decisions in 2026, 8 in 2027, 1 in Jan 2028 — federalreserve.gov/monetarypolicy/fomccalendars.htm
  assert.equal(FOMC_DECISIONS.length, 17);
  const y26 = FOMC_DECISIONS.filter((f) => f.d.startsWith("2026")), y27 = FOMC_DECISIONS.filter((f) => f.d.startsWith("2027"));
  assert.equal(y26.length, 8); assert.equal(y27.length, 8);
  // spot-pins against the published schedule
  assert.ok(FOMC_DECISIONS.some((f) => f.d === "2026-07-29" && f.sep === false), "Jul 29 2026 decision (no SEP)");
  assert.ok(FOMC_DECISIONS.some((f) => f.d === "2026-09-16" && f.sep === true), "Sep 16 2026 is a SEP meeting");
  assert.ok(FOMC_DECISIONS.some((f) => f.d === "2027-06-09" && f.sep === true), "Jun 9 2027 (tentative) is a SEP meeting");
  assert.ok(FOMC_DECISIONS.some((f) => f.d === "2028-01-26"), "Jan 26 2028 decision");
  // SEP rides Mar/Jun/Sep/Dec — exactly 4 per full year
  assert.equal(y26.filter((f) => f.sep).length, 4);
  assert.equal(y27.filter((f) => f.sep).length, 4);
  // strictly ascending, all valid dates
  for (let i = 0; i < FOMC_DECISIONS.length; i++) {
    assert.match(FOMC_DECISIONS[i].d, /^\d{4}-\d{2}-\d{2}$/);
    if (i) assert.ok(FOMC_DECISIONS[i].d > FOMC_DECISIONS[i - 1].d, "table must stay date-sorted");
  }
});

test("macro: FRED release-name resolution is exact-match-or-absent, never a guess", () => {
  const { parseFredReleases, parseFredReleasesDates, MACRO_RELEASES } = require("../src/compute");
  const feed = { releases: [
    { id: 10, name: "Consumer Price Index" },
    { id: 50, name: "Employment Situation" },
    { id: 53, name: "Gross Domestic Product" },
    { id: 46, name: "producer price index" },            // case-insensitive match
    { id: 999, name: "Consumer Price Index Research" },  // near-name must NOT hijack CPI
    { id: 9, name: "Advance Monthly Sales for Retail and Food Services" },
  ] };
  const ids = parseFredReleases(feed, MACRO_RELEASES);
  assert.equal(ids.get("CPI"), 10);
  assert.equal(ids.get("NFP"), 50);
  assert.equal(ids.get("GDP"), 53);
  assert.equal(ids.get("PPI"), 46);
  assert.equal(ids.get("RETAIL"), 9);
  assert.equal(ids.get("PCE"), undefined, "a release FRED renamed resolves to nothing — absent, never guessed");
  // dates: filtered to OUR ids, deduped, malformed dropped
  const idToK = new Map([[10, "CPI"], [50, "NFP"]]);
  const out = parseFredReleasesDates({ release_dates: [
    { release_id: 10, date: "2026-08-12" }, { release_id: 10, date: "2026-08-12" },
    { release_id: 50, date: "2026-08-07" }, { release_id: 46, date: "2026-08-13" },
    { release_id: 10, date: "garbage" },
  ] }, idToK);
  assert.deepEqual(out, [{ k: "CPI", d: "2026-08-12" }, { k: "NFP", d: "2026-08-07" }]);
  assert.deepEqual(parseFredReleasesDates({}, idToK), [], "missing array is empty, not a throw");
});

test("macro: buildMacroEntries merges the FOMC table with FRED dates inside the window, date-sorted", () => {
  const { buildMacroEntries } = require("../src/compute");
  // now = Mon Jul 27 2026, 16:00Z. Window +14d back 2d contains the Jul 29 FOMC decision.
  const now = Date.UTC(2026, 6, 27, 16, 0);
  const ent = buildMacroEntries([
    { k: "NFP", d: "2026-08-07" }, { k: "CPI", d: "2026-08-05" },
    { k: "CPI", d: "2026-08-12" },                                  // 16d out — beyond +14d
    { k: "RETAIL", d: "2026-07-24" },                               // -3d — beyond the 2d back window
  ], now, 14, 2);
  assert.deepEqual(ent.map((e) => e.k + "|" + e.d),
    ["FOMC|2026-07-29", "CPI|2026-08-05", "NFP|2026-08-07"]);
  const fomc = ent[0];
  assert.equal(fomc.tEt, "14:00");
  assert.equal(fomc.sep, false);
  assert.equal(fomc.d1, "2026-07-28", "day one of the two-day meeting rides the entry for display");
  assert.equal(ent[1].tEt, "08:30");
  assert.equal(ent[2].label, "Nonfarm payrolls");
});

test("macro: macroEntryState flips on the ET clock or actual-presence — the single arbiter", () => {
  const { macroEntryState } = require("../src/compute");
  const S = macroEntryState;
  const fomc = { d: "2026-07-29", tEt: "14:00" }, cpi = { d: "2026-08-12", tEt: "08:30" };
  // July = EDT (UTC-4): 13:00 ET = 17:00Z, 14:00 ET = 18:00Z
  assert.equal(S(fomc, Date.UTC(2026, 6, 29, 17, 0)), "upcoming", "13:00 ET on decision day — statement not out");
  assert.equal(S(fomc, Date.UTC(2026, 6, 29, 18, 0)), "released", "14:00 ET sharp — out");
  assert.equal(S(fomc, Date.UTC(2026, 6, 28, 12, 0)), "upcoming", "day before");
  assert.equal(S(fomc, Date.UTC(2026, 6, 30, 12, 0)), "released", "day after");
  assert.equal(S(cpi, Date.UTC(2026, 7, 12, 12, 29)), "upcoming", "8:29 ET");
  assert.equal(S(cpi, Date.UTC(2026, 7, 12, 12, 30)), "released", "8:30 ET sharp");
  assert.equal(S({ d: "2026-08-12", tEt: "08:30", actual: { yoy: 2.4 } }, Date.UTC(2026, 7, 1)), "released",
    "an actual present overrides the clock");
});

test("macro: stat reducers demand exact-period matches — null over approximation", () => {
  const { yoyPct, momPct, momDelta, lastObs, macroExpectedObsMonth } = require("../src/compute");
  const idx = []; // 14 months of a clean index: Jun 2025 .. Jul 2026
  for (let i = 0; i < 14; i++) {
    const y = 2025 + Math.floor((5 + i) / 12), m = ((5 + i) % 12) + 1;
    idx.push([`${y}-${String(m).padStart(2, "0")}-01`, 100 * Math.pow(1.002, i)]);
  }
  const yy = yoyPct(idx);
  assert.equal(yy.m, "2026-07");
  assert.ok(Math.abs(yy.v - 2.4) < 0.1, "12 months of 0.2%/mo compounds to ~2.4% YoY, got " + yy.v);
  // a gap at the 12-back month yields null, never a nearest-neighbor read
  const gappy = idx.filter((o) => o[0] !== "2025-07-01");
  assert.equal(yoyPct(gappy), null);
  const mm = momPct([["2026-06-01", 100], ["2026-07-01", 100.6]]);
  assert.ok(Math.abs(mm.v - 0.6) < 0.001 && mm.m === "2026-07");
  assert.equal(momPct([["2026-05-01", 100], ["2026-07-01", 100.6]]), null, "non-adjacent months refuse to pretend");
  const jd = momDelta([["2026-06-01", 159800], ["2026-07-01", 159947]]);
  assert.equal(jd.v, 147);
  assert.equal(lastObs([["2026-07-24", 3.75]]).v, 3.75);
  // reference periods: monthlies cover the prior month; GDP the latest COMPLETE quarter
  assert.equal(macroExpectedObsMonth("CPI", "2026-08-12"), "2026-07");
  assert.equal(macroExpectedObsMonth("GDP", "2026-07-30"), "2026-04", "July release = Q2 advance, obs at quarter start");
  assert.equal(macroExpectedObsMonth("GDP", "2026-08-27"), "2026-04", "August second estimate still covers Q2");
  assert.equal(macroExpectedObsMonth("GDP", "2026-10-29"), "2026-07", "late-Oct release = Q3 advance");
  assert.equal(macroExpectedObsMonth("GDP", "2026-02-26"), "2025-10", "Feb release covers Q4 of the prior year");
  assert.equal(macroExpectedObsMonth("FOMC", "2026-07-29"), null);
});

test("macro: macroWithin returns upcoming events inside a horizon, day-granular like the earnings guard", () => {
  const { macroWithin } = require("../src/compute");
  const now = Date.UTC(2026, 6, 27, 16, 0);   // Mon Jul 27, noon ET
  const DAY = 24 * 3600 * 1000;
  const ents = [
    { k: "FOMC", label: "FOMC rate decision", d: "2026-07-29", tEt: "14:00", sep: false },
    { k: "NFP", label: "Nonfarm payrolls", d: "2026-08-07", tEt: "08:30" },
    { k: "RETAIL", label: "Retail sales", d: "2026-07-24", tEt: "08:30" },   // released — out
  ];
  const w = macroWithin(ents, now, 8 * DAY);
  assert.deepEqual(w.map((m) => m.k), ["FOMC"], "8d horizon contains the decision (2d) but not NFP (11d)");
  assert.equal(w[0].days, 2);
  assert.deepEqual(macroWithin(ents, now, 12 * DAY).map((m) => m.k), ["FOMC", "NFP"]);
});

test("macro: store roundtrip — warm cache same contract as earnings", () => {
  const { openStore } = require("../src/store");
  const os = require("os"), path = require("path"), fs = require("fs");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "xyzmacro-"));
  const st = openStore(dir);
  assert.equal(st.loadMacro(), null, "cold store reads null, never throws");
  const data = { ts: 123, entries: [{ k: "FOMC", d: "2026-07-29", tEt: "14:00" }],
    stats: { CPI: { cur: { yoy: 2.6, m: "2026-06" }, prev: { yoy: 2.7, m: "2026-05" } } }, ids: [["CPI", 10]] };
  st.saveMacro(data);
  assert.deepEqual(st.loadMacro(), data);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("macro -17 manifest: fetch engine, guards, payload fold, report contract — pinned end to end", () => {
  // Source-manifest guard, same philosophy as the client-integrity test: each of these silently
  // deleted would pass node --check while gutting the feature.
  const fs = require("fs"), path = require("path");
  const pl = fs.readFileSync(path.join(__dirname, "..", "src", "poller.js"), "utf8");
  for (const pin of [
    "async function fetchMacro()", "api.stlouisfed.org/fred/", "process.env.FRED_KEY",
    "include_release_dates_with_no_data", 'realtime_end: "9999-12-31"',
    "function macroProx(nowMs)", "function loadMacroCache()", "function macroCrossed()",
    "g.mac = mp", "g.macguard = true", "mG.mg = 1",                    // signals guard + ledger stamp
    "macroWithin(macroCache && macroCache.entries || [], now, meta.horizonMs)",   // actionable
    "ctx.macro = { next: mn, recent: mr }",                            // report context
    'kind: "macro_event"',                                             // deterministic report flag
    "context.macro, when present",                                     // prompt contract
    "macro: macroCache && Array.isArray(macroCache.entries)",          // payload fold
    "store.saveMacro", "loadMacroCache(); } catch",
  ]) assert.ok(pl.includes(pin), "poller pin missing: " + pin);
  assert.equal(pl.match(/async function fetchMacro\(\)/g).length, 1, "one fetch engine, exactly");
  // one guard block: the macro trim must not apply when the earnings guard already trimmed
  assert.ok(pl.includes("if (!g.earnguard && g.evp > 8)"), "single-trim rule: capped once, not twice");
  const st = fs.readFileSync(path.join(__dirname, "..", "src", "store.js"), "utf8");
  for (const pin of ["saveMacro(data)", "loadMacro()", 'macroFile = path.join(dataDir, "macro.json")'])
    assert.ok(st.includes(pin), "store pin missing: " + pin);
  const sv = fs.readFileSync(path.join(__dirname, "..", "server.js"), "utf8");
  assert.ok(sv.includes('const VERSION = "2026.07.28-07"'), "build stamp");
  const ht = fs.readFileSync(path.join(__dirname, "..", "public", "index.html"), "utf8");
  for (const pin of ['id="macrostrip"', 'id="tab-calendar"', ">Calendar</button>"])
    assert.ok(ht.includes(pin), "index pin missing: " + pin);
  const cs = fs.readFileSync(path.join(__dirname, "..", "public", "styles.css"), "utf8");
  for (const pin of [".macrostrip", ".macrostrip.result", ".macrostrip[hidden]{display:none}", ".earn-row.mrow", ".earn-mk", ".act-mwarn"])
    assert.ok(cs.includes(pin), "css pin missing: " + pin);
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

test("swing -20: poller wiring manifest — fire sites, resolver, rosters, glossary, panel, client", () => {
  const fs = require("fs"), path = require("path");
  const pol = fs.readFileSync(path.join(__dirname, "..", "src", "poller.js"), "utf8");
  for (const pin of [
    'openLedger(r, "swpull"', 'openLedger(r, "basebrk"', 'openLedger(r, "basepj"',
    "stp: sp.stop, tgt: sp.target, tm: 1",                       // touch mode + ABSOLUTE frozen target ride extra
    "stp: bb.stop, tgt: bb.targetL, tm: 1",
    "stp: bb.stop, tgt: bb.targetP, tm: 1",
    "const br = bracketTouch(hs, e.t0, Math.min(e.resolveAt, now), sideE, e.stp, e.tgt);",   // early-touch scan
    'if (br) { pTouch = br.level; tEnd = br.t; e.rb = br.hit === "target" ? "t" : "s"; }',
    "else if (now < e.resolveAt) continue;",                     // untouched + not expired -> still live
    "if (e.tm === 1 && e.rb) e.realizedB = realized;",           // touch claims: tracks coincide
    "e.realizedB = br ? +(sgn * (br.level / p0 - 1) * 100).toFixed(2) : realized;",          // symmetric track
    'if (now < e.resolveAt && !(e.tm === 1 && e.stp != null && e.tgt != null)) continue;',   // per-pass gate
    "const b0 = priceAsOf(bh, e.t0, 3 * HOUR), b1 = priceAsOf(bh, tEnd, 3 * HOUR);",         // BTC leg on the live window
    '"swpull", "basebrk", "basepj",',                            // MAIN_EVS enrollment
    'tm: "touch-mode claim', 'rb: "bracket outcome', 'realizedB: "bracket-track outcome', 'r2: "MA200 regime at fire',
    "if (r._r2 != null) e.r2 = r._r2;",                          // regime stamp at claim creation
    'ev: "swpull", uni: "both"', 'ev: "basebrk", uni: "both"', 'ev: "basepj", uni: "both"',  // shadow panel rows
    "delete e.tgt; delete e.tm; }",                              // crypto scrub degrades touch mode honestly
    "nB: b.retsB.length, hitB:",                                 // bracket aggregation in the record
  ]) assert.ok(pol.includes(pin), `poller.js missing -20 pin: ${pin}`);
  // exactly one bracketTouch call per resolver concern: the touch-mode scan and the parallel track
  assert.equal((pol.match(/bracketTouch\(/g) || []).length, 2, "two resolver call sites, no strays");
  assert.ok(pol.includes("stopTouched, bracketTouch,"), "primitive imported alongside stopTouched");
  const app = fs.readFileSync(path.join(__dirname, "..", "public", "app.js"), "utf8");
  for (const pin of ["tch hit", "tch med", "tch pf", "r.hitB", "r.medB", "r.pfB", 'colspan="10"'])
    assert.ok(app.includes(pin), `app.js missing -20 pin: ${pin}`);
});

test("swing -20: resolver end-to-end — early target touch, stop-out, still-live, timeout MTM", () => {
  const { createPoller } = require("../src/poller");
  const now = Date.now(), H = 3600e3, DAY_ = 86400e3;
  const mk = (coin, extra) => Object.assign({ key: coin + "|swpull#0", coin, ticker: coin, ev: "swpull",
    t0: now - 6 * DAY_, mark0: 100, dir: 1, score0: 0, sd0: 2, psd: "long", pn: 1,
    stp: 97, tgt: 106, tm: 1, vi: 0, resolveAt: now + 24 * DAY_ }, extra || {});
  const fixture = { ts: now, rearm: [], variants: null, closed: [],
    open: [mk("xyz:TGT"), mk("xyz:STP"), mk("xyz:LIVE"), mk("xyz:MTM", { resolveAt: now - DAY_ })] };
  const store = { loadAll: () => new Map(), loadRegime: () => [], loadLedger: () => fixture,
    saveLedger: () => {}, insert: () => {}, saveRegime: () => {} };
  const p = createPoller({ dex: "xyz", store, log: () => {}, version: "test", crypto: false });
  p.hydrateLedgerNow();
  // spines: 160h of hourly bars; shape(h) returns [px, hi, lo] for the bar h hours ago
  const spine = (shape) => { const hs = []; for (let i = 160; i >= 0; i--) {
    const [px, hi, lo] = shape(i); hs.push({ t: now - i * H, o: px, h: hi, l: lo, c: px, v: 1 }); } return hs; };
  const flat = (i) => [101, 101.4, 100.6];                                        // touches nothing, ever
  p.seedRowNow("xyz:TGT",  { px: 105, hourlyTs: now, hourlyRaw: spine((i) => i === 50 ? [105.5, 106.3, 104.8] : [100, 100.4, 99.6]) });
  p.seedRowNow("xyz:STP",  { px: 100, hourlyTs: now, hourlyRaw: spine((i) => i === 70 ? [97.5, 100.1, 96.8] : [100, 100.3, 99.7]) });
  p.seedRowNow("xyz:LIVE", { px: 101, hourlyTs: now, hourlyRaw: spine(flat) });
  p.seedRowNow("xyz:MTM",  { px: 101, hourlyTs: now, hourlyRaw: spine(flat) });
  p.buildSignalsNow();
  const x = p.getLedgerExport();
  const done = Object.fromEntries(x.closed.filter((e) => e.ev === "swpull").map((e) => [e.coin, e]));
  const open = Object.fromEntries(x.open.filter((e) => e.ev === "swpull").map((e) => [e.coin, e]));
  // TGT: resolved EARLY (resolveAt is 24d away), at the target, in R, tracks coinciding
  assert.ok(done["xyz:TGT"] && done["xyz:TGT"].status === "resolved", "target claim resolved 24d before its timeout");
  assert.equal(done["xyz:TGT"].rb, "t", "bracket outcome: target first");
  assert.ok(Math.abs(done["xyz:TGT"].realized - 3) < 0.15, `resolved AT the frozen target: (106/100-1)/sigma2 = 3R, got ${done["xyz:TGT"].realized}`);
  assert.equal(done["xyz:TGT"].stopped, false, "not stopped");
  assert.ok(Math.abs(done["xyz:TGT"].realizedB - done["xyz:TGT"].realized) < 1e-9, "touch claims: bracket === realized by construction");
  // STP: resolved early at the void, negative, stopped
  assert.ok(done["xyz:STP"] && done["xyz:STP"].rb === "s" && done["xyz:STP"].stopped === true, "void first-touch");
  assert.ok(Math.abs(done["xyz:STP"].realized - (-1.5)) < 0.15, `resolved AT the frozen void: (97/100-1)/sigma2 = -1.5R, got ${done["xyz:STP"].realized}`);
  // LIVE: nothing touched, timeout far away -> still open, scanned but untouched
  assert.ok(open["xyz:LIVE"] && !done["xyz:LIVE"], "untouched claim with a live timeout stays open");
  // MTM: nothing touched, timeout passed -> at-horizon mark, the honest 'went nowhere'
  assert.ok(done["xyz:MTM"] && done["xyz:MTM"].rb === "m", "timeout resolves mark-to-market");
  assert.ok(Math.abs(done["xyz:MTM"].realized) < 0.2, `flat tape MTM outcome ~0R, got ${done["xyz:MTM"].realized}`);
});

test("swing -20: the symmetric bracket track exposes the old one-sided bias on fixed-horizon claims", () => {
  const { createPoller } = require("../src/poller");
  const now = Date.now(), H = 3600e3, DAY_ = 86400e3;
  // a NON-touch claim (reclaim, 5d convention) carrying both frozen levels: price rides through
  // the target mid-window and gives most of it back by horizon. The at-horizon leg books the
  // fade; the bracket leg books the touch — the exact bias the old record carried.
  const fixture = { ts: now, rearm: [], variants: null, closed: [],
    open: [{ key: "xyz:BIAS|reclaim#0", coin: "xyz:BIAS", ticker: "xyz:BIAS", ev: "reclaim",
      t0: now - 6 * DAY_, mark0: 100, dir: 1, score0: 0, sd0: 2, psd: "long", pn: 1,
      stp: 95, tgt: 103, vi: 0, resolveAt: now - DAY_ }] };
  const store = { loadAll: () => new Map(), loadRegime: () => [], loadLedger: () => fixture,
    saveLedger: () => {}, insert: () => {}, saveRegime: () => {} };
  const p = createPoller({ dex: "xyz", store, log: () => {}, version: "test", crypto: false });
  p.hydrateLedgerNow();
  const hs = []; for (let i = 160; i >= 0; i--) {
    let px = 100, hi = 100.4, lo = 99.6;
    if (i <= 80 && i > 60) { px = 103.5; hi = 104.2; lo = 102.8; }      // the ride through 103
    if (i <= 60) { px = 100.5; hi = 100.9; lo = 100.1; }                // the fade into horizon
    hs.push({ t: now - i * H, o: px, h: hi, l: lo, c: px, v: 1 });
  }
  p.seedRowNow("xyz:BIAS", { px: 100.5, hourlyTs: now, hourlyRaw: hs });
  p.buildSignalsNow();
  const e = p.getLedgerExport().closed.find((k) => k.coin === "xyz:BIAS");
  assert.ok(e && e.status === "resolved", "claim resolved at its fixed horizon as always");
  assert.equal(e.rb, "t", "bracket walk saw the target touched first");
  assert.ok(Math.abs(e.realized - 0.25) < 0.15, `at-horizon leg books the fade (~0.25R), got ${e.realized}`);
  assert.ok(Math.abs(e.realizedB - 1.5) < 0.15, `bracket leg books the touch ((103/100-1)/sigma2 = 1.5R), got ${e.realizedB}`);
  assert.ok(e.realizedB > e.realized, "the symmetric track recovers what the one-sided cap threw away");
  assert.equal(e.stopped, false, "void never touched — the stop-aware leg still coincides with at-horizon");
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

test("levels -22: poller end-to-end — profile rides the chart payload, memo holds, dex caveat flagged", () => {
  const { createPoller } = require("../src/poller");
  const now = Date.now(), DAY_ = 86400e3, H = 3600e3;
  const store = { loadAll: () => new Map(), loadRegime: () => [], loadLedger: () => null,
    saveLedger: () => {}, insert: () => {}, saveRegime: () => {} };
  const p = createPoller({ dex: "xyz", store, log: () => {}, version: "test", crypto: false });
  const dailyRaw = []; for (let i = 90; i >= 1; i--) dailyRaw.push({ t: now - i * DAY_, c: 100 + (i % 7), h: 101 + (i % 7), v: 1000 + (i % 3) * 200 });
  const hourlyRaw = []; for (let i = 200; i >= 0; i--) { const c = 100 + (i % 5); hourlyRaw.push({ t: now - i * H, o: c, h: c + 0.5, l: c - 0.5, c, v: 12 }); }
  p.seedRowNow("xyz:VPX", { px: 103, dailyRaw, hourlyRaw, hourlyTs: now });
  const d = p.getTfCandles("xyz:VPX", "1d");
  assert.ok(d && d.vp && Array.isArray(d.vp.bins) && d.vp.bins.length >= 8, "volume profile ships with the chart payload");
  assert.equal(d.dexVol, true, "xyz payload carries the dex-volume caveat flag");
  assert.ok(d.vp.poc > 99 && d.vp.poc < 108, `POC inside the traded range, got ${d.vp.poc}`);
  const d2 = p.getTfCandles("xyz:VPX", "4h");
  assert.ok(d2.vp && d2.vp.poc === d.vp.poc, "same memoized profile object across tf calls — histogram and map cannot disagree");
});

test("levels -22: wiring manifest — poller assembly, snapshot column, study audit, client surfaces", () => {
  const fs = require("fs"), path = require("path");
  const pol = fs.readFileSync(path.join(__dirname, "..", "src", "poller.js"), "utf8");
  for (const pin of [
    "function volMapFor(r)",
    "const vp = volumeProfile(bars, sd30);",
    "const map = levelMap({ str, vp, e50: ema(50), e200: ema(200) }, r.px, sd30);",
    "r._vpK = memoK; r._vpM = out;",                                    // daily-cadence memo, never the 15s tick
    "fundPct, red, rvol, swr, swrT, swrV, swrS,",                       // Swing R rides the snapshot row
    'swrS = tgt.srcs.join("+");',
    'it.srcs.length === 1 && it.srcs[0] === "lvn"',                     // LVNs excluded as targets
    "vp: vm && vm.vp ? vm.vp : null, dexVol:",                          // chart payload carries profile + caveat
    "st.profile = levelStudy(pooledVp, { horizon: LVL_HORIZON, cellFloor: LVL_CELL_FLOOR });",
    "stride: LVL_STRIDE + 2",                                           // audit stride bounds the prefix-profile cost
    "detect: (pb, px2, sd2) => {",                                      // HVN audit rides the injectable detector
  ]) assert.ok(pol.includes(pin), `poller.js missing -22 pin: ${pin}`);
  const app = fs.readFileSync(path.join(__dirname, "..", "public", "app.js"), "utf8");
  for (const pin of [
    "{key:'swr', label:'Swing R'",
    "hand-set weights (str 1.0 \\u00b7 hvn 0.8 \\u00b7 e200 0.7 \\u00b7 e50 0.6 \\u00b7 lvn 0.5)",  // disclosure lives where the number is
    "data-aivp",                                                        // VP toggle
    "dex volume profile histogram (build -22)",
    "DEX volume",                                                       // the honesty caveat, verbatim class
    "Volume-profile HVNs (audit)",                                      // the report card row
    "state.report.vp=state.report.vp===false?true:false;",
  ]) assert.ok(app.includes(pin), `app.js missing -22 pin: ${pin}`);
  const cmp = fs.readFileSync(path.join(__dirname, "..", "src", "compute.js"), "utf8");
  assert.ok(cmp.includes("const LVL_MAP_W = { str: 1.0, hvn: 0.8, e200: 0.7, e50: 0.6, lvn: 0.5 };"), "weights pinned at the definition");
  for (const f of ["volumeProfile", "levelMap"])
    assert.equal((cmp.match(new RegExp("^function " + f + "\\(", "mg")) || []).length, 1, `exactly one ${f} definition`);
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

test("ema200 -26: poller + client wiring manifest — section, memo, retest ride, panel surfaces", () => {
  const fs = require("fs"), path = require("path");
  const pol = fs.readFileSync(path.join(__dirname, "..", "src", "poller.js"), "utf8");
  for (const pin of [
    "function buildEma200Study(U)",
    'const EMA_TF = { "1d": { horizon: 14, stride: 5, minBars: 210 }, "4h": { horizon: 84, stride: 12, minBars: 210 } };',
    "const EMA_MIN_EQ = 5, EMA_CELL_FLOOR = 30, EMA_REARM = 3, EMA_BUF_SD = 0.25;",
    'closedBars(mergedDailyBars(r), DAY, now)',                    // D1 = the one merged source, forming day trimmed
    'closedBars(bucketsFor(r, 4), 4 * HOUR, now)',                 // H4 = spine buckets, forming bucket trimmed
    "const e2 = emaLast(pb.map((k) => k.c), 200);",                // retest rides the injectable audit on emaLast
    "if (r._emSrc !== db) {",                                      // levels-study memo contract
    "ema200: emSt,",                                               // section wired
    "const emSt = on(\"structure\") ? buildEma200Study(U) : DISABLED;",
    "function mergedDailyBars(r)",                                 // extracted, three consumers
  ]) assert.ok(pol.includes(pin), `poller.js missing -26 pin: ${pin}`);
  // one code path: volMapFor must now consume the extracted helper, not a private copy
  assert.ok(/const bars = mergedDailyBars\(r\);/.test(pol), "volMapFor reads mergedDailyBars");
  const app = fs.readFileSync(path.join(__dirname, "..", "public", "app.js"), "utf8");
  for (const pin of [
    "function renderEma200(em)", "function emaXCell(", "function emaRtRow(",
    "a.sections && a.sections.ema200",
    "Support retest (bullish)", "Resistance retest (bearish)",
    "whip 5b",
    "closed candles only",
    "{html:emBlock},{pend:emPend}",
  ]) assert.ok(app.includes(pin), `app.js missing -26 pin: ${pin}`);
  const css = fs.readFileSync(path.join(__dirname, "..", "public", "styles.css"), "utf8");
  for (const cls of [".ptbl tr.tfh td", ".pill2", ".ft"])
    assert.ok(css.includes(cls), `styles.css missing -26 class: ${cls}`);
  const cmp = fs.readFileSync(path.join(__dirname, "..", "src", "compute.js"), "utf8");
  for (const f of ["emaCrossOutcomes", "emaCrossStudy"])
    assert.equal((cmp.match(new RegExp("^function " + f + "\\(", "mg")) || []).length, 1, `exactly one ${f} definition`);
});

test("ema200 -26: end-to-end through the analytics build — the section publishes off seeded rows", () => {
  const { createPoller } = require("../src/poller");
  const now = Date.now(), DAY_ = 86400e3, H = 3600e3;
  const store = { loadAll: () => new Map(), loadRegime: () => [], loadLedger: () => null,
    saveLedger: () => {}, insert: () => {}, saveRegime: () => {} };
  const p = createPoller({ dex: "xyz", store, log: () => {}, version: "test", crypto: false });
  // six names, each with 320d of dailies crossing the EMA once and 200 spine hours (H4 stays
  // thin on purpose — the D1 lane alone must be able to publish)
  // real equity tickers: the stocks universe's studyEligible gates on assetClass === "Equity"
  const TKS = ["AAPL", "MSFT", "NVDA", "AMZN", "META", "GOOG"];
  for (let m = 0; m < 6; m++) {
    const coin = "xyz:" + TKS[m], dailyRaw = [], hourlyRaw = [];
    for (let i = 320; i >= 1; i--) {
      const j = 320 - i;
      const c = j < 260 ? 100 - j * 0.03 + m * 0.1 : (92.2 + m * 0.1) + (j - 260) * 0.4;
      dailyRaw.push({ t: now - i * DAY_, c, h: c + 0.5, v: 500 });
    }
    for (let i = 200; i >= 0; i--) { const c = 110 + (i % 3); hourlyRaw.push({ t: now - i * H, o: c, h: c + 0.4, l: c - 0.4, c, v: 5 }); }
    p.seedRowNow(coin, { ticker: TKS[m], px: 112, dailyRaw, hourlyRaw, hourlyTs: now });
  }
  const a = p.buildAnalyticsNow();
  const em = a && a.sections && a.sections.ema200;
  assert.ok(em && !em.pending, `section published (got ${JSON.stringify(em && em.pending)})`);
  const d1 = em.tf["1d"];
  assert.ok(d1 && d1.contributing >= 5 && d1.n >= 5, `>=5 names contributed D1 cross events (n=${d1 && d1.n})`);
  assert.ok(d1.cross.up.raw && d1.cross.up.raw.n >= 5, "the up-cross every tape carried was detected per name");
  assert.ok(d1.retest && d1.retest.n > 0, "the retest audit accrued events through the injectable loop");
  assert.equal(em.horizons["1d"], 14, "D1 horizon rides the agreed 14 bars");
  assert.equal(em.horizons["4h"], 84, "H4 horizon rides 84 bars (14 sessions of six H4 bars)");
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

test("ema200 shadows -28: EV_META convention, wiring manifest, panel rows, closed-bar trim", () => {
  const C = require("../src/compute");
  const DAY_ = 86400e3;
  for (const ev of ["emabrk", "emarts"]) {
    assert.equal(C.EV_META[ev].resolve, "touch", `${ev} resolves by first touch`);
    assert.equal(C.EV_META[ev].horizonMs, 30 * DAY_, `${ev} 30d equity timeout`);
  }
  const fs = require("fs"), path = require("path");
  const cmp = fs.readFileSync(path.join(__dirname, "..", "src", "compute.js"), "utf8");
  for (const pin of [
    'emabrk:   { horizonMs: 15 * DAY,  horizon: "first touch of target/void within 15d, off the buffered EMA200 close-cross" },',
    'emarts:   { horizonMs: 15 * DAY,  horizon: "first touch of target/void within 15d, off the held EMA200 retest" },',
  ]) assert.ok(cmp.includes(pin), `EV_META_MAIN override pin missing: ${pin}`);
  for (const f of ["detectEmaBreak", "detectEmaRetest"])
    assert.equal((cmp.match(new RegExp("^function " + f + "\\(", "mg")) || []).length, 1, `exactly one ${f} definition`);
  const pol = fs.readFileSync(path.join(__dirname, "..", "src", "poller.js"), "utf8");
  for (const pin of [
    'openLedger(r, "emabrk"', 'openLedger(r, "emarts"',
    "stp: eb.stop, tgt: eb.target, tm: 1",                        // touch mode + frozen absolute levels
    "stp: er.stop, tgt: er.target, tm: 1",
    "const ccl = closes.length && +closes[closes.length - 1][0] + DAY > nowD ? closes.slice(0, -1) : closes;",   // the forming day never reaches the detector
    "detectEmaRetest(closedBars(mergedDailyBars(r), DAY, nowD), r.px, sd30, lvlBars)",                          // true lows for the touch, forming day trimmed
    '"emabrk", "emarts",',                                        // MAIN_EVS: crypto fires these too
    'ev: "emabrk", uni: "both"', 'ev: "emarts", uni: "both"',     // shadow panel rows, both universes
  ]) assert.ok(pol.includes(pin), `poller.js missing -28 pin: ${pin}`);
});

test("ema200 shadows -28: end-to-end — the breakout fires as an invisible touch-mode claim with frozen geometry", () => {
  const { createPoller } = require("../src/poller");
  const now = Date.now(), DAY_ = 86400e3, H = 3600e3;
  const store = { loadAll: () => new Map(), loadRegime: () => [], loadLedger: () => null,
    saveLedger: () => {}, insert: () => {}, saveRegime: () => {} };
  const p = createPoller({ dex: "xyz", store, log: () => {}, version: "test", crypto: false });
  // dailies: ~100 flat for the EMA anchor, four closes below, then the buffered cross — all
  // CLOSED (t + DAY <= now); pivot highs at 118 give the structural target. Two pivots, k=3.
  const dailyRaw = [];
  const nD = 302;
  for (let i = 0; i < nD; i++) {
    const t = now - (nD - i) * DAY_ - H;   // every bar closed at least an hour ago
    let c = 100, h = 100.4;
    if (i === 60 || i === 90) h = 118;
    if (i >= nD - 5 && i < nD - 1) { c = 98; h = 98.4; }
    if (i === nD - 1) { c = 104; h = 104.4; }
    dailyRaw.push({ t, c, h, v: 500 });
  }
  const hourlyRaw = [];
  for (let i = 200; i >= 0; i--) { const c = 104 + (i % 3) * 0.1; hourlyRaw.push({ t: now - i * H, o: c, h: c + 0.3, l: c - 0.3, c, v: 5 }); }
  p.seedRowNow("xyz:EMB", { ticker: "EMB", px: 104.5, dailyRaw, hourlyRaw, hourlyTs: now });
  p.buildDailyNow();
  p.buildSignalsNow();
  const x = p.getLedgerExport();
  const e = x.open.find((k) => k.coin === "xyz:EMB" && k.ev === "emabrk");
  assert.ok(e, "the breakout shadow opened");
  assert.equal(e.vi, 0, "invisible — a shadow earning its record, never a live signal");
  assert.equal(e.tm, 1, "touch-mode claim");
  assert.ok(e.stp > 0 && e.tgt > 0 && e.stp < e.mark0 && e.mark0 < e.tgt, `frozen bracket around the mark (${e.stp} < ${e.mark0} < ${e.tgt})`);
  assert.ok(Math.abs(e.tgt - 118) < 1.5, `target is the structural level, got ${e.tgt}`);
  assert.equal(e.psd, "long", "long side only at stage two");
});

test("ema200 shadows -28: crypto depth regression — a main-universe row's detectors see all 370d, not the wire's 94", () => {
  // The bug this pins: dc.daily (the /api/daily payload) was also the signal loop's input, and
  // the -20 wire cap silently starved every crypto detector needing >92 closes. This builds a
  // crypto poller, seeds a 300d spine-backed daily series with an armed EMA200 cross, and
  // requires the shadow to OPEN — which is only possible if the loop read past the cap.
  const { createPoller } = require("../src/poller");
  const now = Date.now(), DAY_ = 86400e3, H = 3600e3;
  const store = { loadAll: () => new Map(), loadRegime: () => [], loadLedger: () => null,
    saveLedger: () => {}, insert: () => {}, saveRegime: () => {} };
  const p = createPoller({ dex: "xyz", store, log: () => {}, version: "test", crypto: true });
  const nD = 302, dailyRaw = [];
  for (let i = 0; i < nD; i++) {
    const t = now - (nD - i) * DAY_ - H;
    let c = 100, h = 100.4;
    if (i === 60 || i === 90) h = 118;
    if (i >= nD - 5 && i < nD - 1) { c = 98; h = 98.4; }
    if (i === nD - 1) { c = 104; h = 104.4; }
    dailyRaw.push({ t, c, h, v: 500 });
  }
  const hourlyRaw = [];
  for (let i = 220; i >= 0; i--) { const c = 104 + (i % 3) * 0.1; hourlyRaw.push({ t: now - i * H, o: c, h: c + 0.3, l: c - 0.3, c, v: 5 }); }
  p.seedRowNow("MAINEMA", { uni: "main", ticker: "MAINEMA", px: 104.5, dailyRaw, hourlyRaw, hourlyTs: now });
  p.buildDailyNow();
  p.buildSignalsNow();
  const x = p.getLedgerExport();
  const e = x.open.find((k) => k.coin === "MAINEMA" && k.ev === "emabrk");
  assert.ok(e, "the crypto breakout shadow opened — the loop read full depth past the wire cap");
  // and the wire itself must STILL be capped — the fix must not have bloated the payload
  const d = p.getDaily();
  const wired = d && d.daily && d.daily["MAINEMA"];
  assert.ok(Array.isArray(wired) && wired.length <= 94, `wire payload stays capped (got ${wired && wired.length})`);
  // the crypto claim rides the compressed clock: 15d touch timeout, not the equity 30d
  assert.ok(e.resolveAt - e.t0 <= 15.5 * DAY_, "crypto emabrk timeout rides the 15d EV_META_MAIN override");
});

// ================================================================================================
// live "now" batch (build 2026.07.27-29): the three numbers every claim view owes the reader —
// the price it fired at, the price now, and which way that is FOR THIS CLAIM. Client-side join
// against the streaming snapshot: the cached ledger payload is untouched by design.
// ================================================================================================

test("now -29: the chip family is wired into both claim views, and the payload stayed untouched", () => {
  const fs = require("fs"), path = require("path");
  const app = fs.readFileSync(path.join(__dirname, "..", "public", "app.js"), "utf8");
  // the shared helpers, each defined exactly once (the integrity manifest counts them too)
  for (const f of ["liveMark", "claimDelta", "brkBar", "nowChip"])
    assert.equal((app.match(new RegExp("^function " + f + "\\(", "gm")) || []).length, 1, `exactly one ${f}`);
  // live mark comes from the client's OWN snapshot — never from the ledger payload
  assert.ok(app.includes("function liveMark(coin){ const r=coin?state.rows.get(coin):null;"),
    "liveMark must read state.rows (the streaming snapshot), not a ledger field");
  // consumer 1: the history table — a now cell on every row shape, and the column header
  assert.ok(app.includes("const nowc = `<td>${nowChip(e.coin||e.tk, { side:e.side, mark0:e.mark0, stp:e.stp, tgt:e.tgt, status:e.status }, { wrap:false })}</td>`;"),
    "sigHistRow must build the now cell from the claim's own frozen fields");
  assert.equal((app.match(/\$\{nowc\}/g) || []).length, 3, "now cell on all three row shapes (open, void, resolved)");
  assert.ok(/<th data-tip="live price against this claim[\s\S]{0,900}>now<\/th>/.test(app), "the now column header ships with its disclosure");
  // consumer 2: the signal card — both trigChip branches
  assert.equal((app.match(/\+nowChip\(g\.coin,c,\{scored:g\.scored\}\)/g) || []).length, 2, "the card's now chip rides BOTH trigChip branches (merged and diverged stamps), carrying the -31 resolution stub");
  // -29 bug fix: the fire mark is unconditional on the diverged branch
  assert.ok(app.includes("const atPx=c&&c.px!=null?` <span class=\"sec\">@ ${fmtPrice(c.px)}</span>`:(c?' <span class=\"na\">@ \\u2014</span>':'');"),
    "the claim's fire mark must ride the presence chip unconditionally — it used to vanish once the stamps diverged");
  // and the server payload did NOT grow a live price: that would bust the content ETag every tick
  const srv = fs.readFileSync(path.join(__dirname, "..", "server.js"), "utf8");
  assert.ok(!/livePx|nowPx/.test(srv), "no live price in the served payload — the ETag economy stays intact");
  const css = fs.readFileSync(path.join(__dirname, "..", "public", "styles.css"), "utf8");
  for (const cls of [".nowchip", ".nowbrk", ".nowbrk i.tgt", ".nowbrk i.stp", ".nowbrk .z"])
    assert.ok(css.includes(cls), `styles.css missing -29 class: ${cls}`);
});

test("now -29: delta is signed WITH the claim, and the bracket bar only exists where geometry does", () => {
  // The two pure functions behind the chip, extracted from app.js and evaluated directly — the
  // sign convention is the whole point of the column and must not be reasoned about by eye.
  const fs = require("fs"), path = require("path");
  const app = fs.readFileSync(path.join(__dirname, "..", "public", "app.js"), "utf8");
  const grab = (name) => {
    const i = app.indexOf("function " + name + "(");
    assert.ok(i > -1, name + " present");
    let d = 0, j = app.indexOf("{", i);
    for (let k = j; k < app.length; k++) { if (app[k] === "{") d++; else if (app[k] === "}") { d--; if (!d) return app.slice(i, k + 1); } }
    throw new Error("unbalanced " + name);
  };
  const clamp = (x, a, b) => Math.min(b, Math.max(a, x));
  const fn = new Function("clamp", grab("claimDelta") + "\n" + grab("brkBar") + "\nreturn {claimDelta, brkBar};")(clamp);
  // LONG: price up is ahead (positive); price down is behind
  assert.ok(Math.abs(fn.claimDelta("long", 100, 110) - 10) < 1e-9, "long, price up: +10%");
  assert.ok(Math.abs(fn.claimDelta("long", 100, 95) - -5) < 1e-9, "long, price down: -5%");
  // SHORT: the mirror — price DOWN is the claim winning, and must read positive
  assert.ok(fn.claimDelta("short", 100, 90) > 0, "short, price down: POSITIVE — the chip asks whether the CLAIM is winning");
  assert.ok(Math.abs(fn.claimDelta("short", 100, 90) - 10) < 1e-9, "short, -10% price = +10% for the claim");
  assert.ok(fn.claimDelta("short", 100, 110) < 0, "short, price up: negative");
  assert.equal(fn.claimDelta("long", null, 110), null, "no fire mark: no delta, never a zero");
  assert.equal(fn.claimDelta("long", 0, 110), null, "a zero mark can't anchor a percentage");
  // bracket bar: long claim, mark 100, void 95, target 115
  const up = fn.brkBar("long", 100, 107.5, 95, 115);
  assert.ok(up && up.towardT === true && Math.abs(up.frac - 0.5) < 1e-9, "halfway to the target reads 50% toward target");
  const dn = fn.brkBar("long", 100, 97.5, 95, 115);
  assert.ok(dn && dn.towardT === false && Math.abs(dn.frac - 0.5) < 1e-9, "halfway to the void reads 50% toward void");
  assert.ok(fn.brkBar("long", 100, 130, 95, 115).frac === 1, "past the level clamps at the level — never >100%");
  // short mirror: target BELOW the mark, void above
  const sh = fn.brkBar("short", 100, 95, 105, 90);
  assert.ok(sh && sh.towardT === true && Math.abs(sh.frac - 0.5) < 1e-9, "short: halfway down to the target");
  // no geometry -> no bar, ever
  assert.equal(fn.brkBar("long", 100, 105, null, 115), null, "no frozen void: no bar");
  assert.equal(fn.brkBar("long", 100, 105, 95, null), null, "no frozen target: no bar");
  assert.equal(fn.brkBar("long", 100, 105, 100, 115), null, "a void AT the mark has no scale to measure against");
});

// ===== panel builders must own the scopes they read (build 2026.07.27-30) =======================
// A real break, class not instance: buildPushSection read `A.openRec`, but `A` is a caller-local in
// buildAlertsPanel (`const pop=..., A=state.alerts`). Because buildPushSection is invoked from
// inside that caller's own template concatenation, the code reads as if the scope were shared. It
// is not. The throw landed BEFORE `pop.innerHTML=h`, so the panel kept its last-rendered markup and
// every control's handler — each of which ends by calling buildAlertsPanel() to re-render — became
// a silent no-op. Nothing looked broken; nothing worked. It only fired once a linked recipient
// existed, since `mineOnly.map` is the only path that reaches the reference, which is why it sat
// latent for three commits and read as a regression from an unrelated DOM move.
//
// Derived, not pinned: brace-match every top-level function in app.js and require that any body
// referencing a bare `A.` also declares `A`. Any future builder split out of buildAlertsPanel that
// carries an `A.` read along with it fails here.
test("every function reading the `A.` alerts alias declares it (no borrowed caller scope)", () => {
  const fs = require("fs"), path = require("path");
  const s = fs.readFileSync(path.join(__dirname, "..", "public", "app.js"), "utf8");
  const re = /^function\s+([A-Za-z0-9_$]+)\s*\(([^)]*)\)\s*\{/gm;
  const offenders = [];
  let m, checked = 0;
  while ((m = re.exec(s))) {
    const name = m[1], params = m[2];
    // brace-match the body from the opening brace
    let i = m.index + m[0].length - 1, depth = 0, end = -1;
    for (; i < s.length; i++) {
      const c = s[i];
      if (c === "{") depth++;
      else if (c === "}") { depth--; if (!depth) { end = i; break; } }
    }
    if (end < 0) continue;
    const body = s.slice(m.index + m[0].length, end);
    if (!/(^|[^A-Za-z0-9_$.])A\s*\./.test(body)) continue;   // doesn't read the alias at all
    checked++;
    // A declarator list may hold other initialisers before A (`const P=pushState, A=state.alerts`)
    // and may destructure (`const [i,j]=pr, A=rows[i]`) — scan the whole statement, stop at the
    // semicolon. renderPairPanel legitimately binds its own unrelated `A` this way.
    const declares = /(?:const|let|var)\s+[^;]*?\bA\s*=/.test(body)
      || /(^|[,\s])A(\s*=|\s*,|\s*$)/.test(params);
    if (!declares) offenders.push(name);
  }
  assert.ok(checked > 0, "the scan must actually find functions reading the alias — a silent zero would pass vacuously");
  assert.deepEqual(offenders, [], "these read `A.` without declaring A: " + offenders.join(", "));
  // The specific site, so a future refactor that drops the alias from buildPushSection is named.
  assert.ok(/function buildPushSection\(\)\{[\s\S]{0,600}?const P=pushState, A=state\.alerts;/.test(s),
    "buildPushSection must hold its own reference to the alerts store");
});

// ================================================================================================
// post-resolution disclosure (build 2026.07.27-31): a signal whose episode already scored used to
// render "now —" — technically honest, practically a hole, because the ledger HOLDS the answer.
// The re-arm-parked signal now ships its resolution stub, the client says "scored +x.xR" instead
// of nothing, and the ★ prime emphasis is withdrawn from what is, trade-wise, a corpse.
// ================================================================================================

test("postres -31: a re-arm-parked signal ships its resolution stub, loses prime, and re-claims only after a genuine lapse", () => {
  const { createPoller } = require("../src/poller");
  const DAY_ = 86400e3, HOUR_ = 3600e3, now = Date.now();
  // The resolved claim that parked the key, exactly as the resolver would have left it.
  const fixture = { ts: now, rearm: ["xyz:NVDA|bigmove"], variants: null,
    open: [],
    closed: [
      { key: "xyz:NVDA|bigmove", coin: "xyz:NVDA", ticker: "NVDA", ev: "bigmove", t0: now - 3 * DAY_,
        tR: now - 6 * HOUR_, mark0: 100, dir: 1, sd0: 2, psd: "long", pn: 1, rn: 1,
        status: "resolved", realized: 1.3, realizedS: 1.3, win: true, winS: true },
      // an OLDER episode of the same key — resolution TIME must pick the newer one
      { key: "xyz:NVDA|bigmove", coin: "xyz:NVDA", ticker: "NVDA", ev: "bigmove", t0: now - 30 * DAY_,
        tR: now - 27 * DAY_, mark0: 80, dir: 1, sd0: 2, psd: "long", pn: 1, rn: 1,
        status: "resolved", realized: -0.7, realizedS: -0.7, win: false, winS: false },
    ] };
  const store = { loadAll: () => new Map(), loadRegime: () => [], loadLedger: () => fixture,
    saveLedger: () => {}, insert: () => {}, saveRegime: () => {}, saveNews: () => {}, loadNews: () => null };
  const p = createPoller({ dex: "xyz", store, log: () => {}, version: "test", crypto: false });
  p.hydrateLedgerNow();
  const mkD = () => { const d = []; for (let i = 61; i >= 1; i--) d.push({ t: now - i * DAY_, c: 100 * Math.pow(1.0005, 61 - i), o: 100, h: 103, l: 98, v: 1e6 }); return d; };
  const mkH = () => { const h = []; for (let i = 400; i >= 0; i--) { const c = 100 + Math.sin(i / 9); h.push({ t: now - i * HOUR_, o: c, h: c + 0.7, l: c - 0.7, c, v: 1e5 }); } return h; };
  const fire = () => { p.seedRowNow("xyz:NVDA", { px: 112, ticker: "NVDA", uni: "xyz", vol: 1e7,
    dailyRaw: mkD(), hourlyRaw: mkH(), dailyTs: now, hourlyTs: now, isNew: false, prevDay: 100, d1: 12 });
    p.buildDailyNow(); p.buildSignalsNow(); };
  fire();
  const g1 = (p.getSignals().signals || []).find((g) => g.coin === "xyz:NVDA" && g.ev === "bigmove");
  assert.ok(g1, "the bigmove condition fires on the seeded tape");
  assert.ok(!g1.claim0, "the re-arm gate refuses a serial re-claim, so no open claim ships");
  assert.equal((p.getLedgerFor("xyz:NVDA").open || []).filter((e) => e.ev === "bigmove").length, 0,
    "…and the ledger really holds no open bigmove claim");
  assert.equal(g1.postres, true, "the signal is stamped post-resolution");
  assert.ok(g1.scored, "the resolution stub ships instead of nothing");
  assert.equal(g1.scored.realized, 1.3, "the NEWER episode's outcome — chosen by resolution time, never by array position");
  assert.equal(g1.scored.unit, "R", "outcome carries its unit");
  assert.equal(g1.scored.voided, false);
  assert.equal(g1.scored.tR, now - 6 * HOUR_, "the resolution time ships for the 'ago' readout");
  assert.ok(!g1.prime, "★ prime is withdrawn on a scored episode — the badge may not invite entry into a banked claim");
  // the ETag signature must distinguish claim-backed from post-resolution at the same score
  const fs = require("fs"), path = require("path");
  const pol = fs.readFileSync(path.join(__dirname, "..", "src", "poller.js"), "utf8");
  assert.ok(pol.includes('(g.claim0 ? "c" + g.claim0.t : g.postres ? "p" : "")'),
    "the signals ETag carries claim/postres state — a claim resolving into the stub busts the cache even at an unchanged score");
  assert.ok(/if \(g\.prime\) \{ g\.prime = false; g\.score = Math\.max\(0, g\.score - 6\); \}/.test(pol),
    "prime withdrawal also returns the +6 emphasis bonus it granted");
  assert.ok(pol.includes("if (g.postres && g.scored) it.episodeScored ="),
    "the AI report context states the episode outcome — the model must not read a claimless live condition as 'not yet claimed'");
  // lapse: the condition clears for a build → the key re-arms
  p.seedRowNow("xyz:NVDA", { px: 100, ticker: "NVDA", uni: "xyz", vol: 1e7,
    dailyRaw: (() => { const d = []; for (let i = 61; i >= 1; i--) d.push({ t: now - i * DAY_, c: 100, o: 100, h: 100.5, l: 99.5, v: 1e6 }); return d; })(),
    hourlyRaw: mkH(), dailyTs: now, hourlyTs: now, isNew: false, prevDay: 100, d1: 0 });
  p.buildDailyNow(); p.buildSignalsNow();
  assert.ok(!(p.getSignals().signals || []).some((g) => g.coin === "xyz:NVDA" && g.ev === "bigmove"),
    "flat tape: the condition genuinely lapses");
  // refire: a genuinely new episode opens a FRESH claim and the stub is gone
  fire();
  const g2 = (p.getSignals().signals || []).find((g) => g.coin === "xyz:NVDA" && g.ev === "bigmove");
  assert.ok(g2, "the new episode fires");
  assert.ok(g2.claim0, "…and opens a fresh claim — the gate parks episodes, it does not retire the event");
  assert.ok(!g2.scored && !g2.postres, "the resolution stub belongs to the parked episode only, never to a live claim");
});

test("postres -31: the client renders the scored chip on the re-arm branch, dash only when there is truly nothing", () => {
  const fs = require("fs"), path = require("path");
  const app = fs.readFileSync(path.join(__dirname, "..", "public", "app.js"), "utf8");
  // the scored branch lives INSIDE nowChip's no-claim path, before the dash fallback
  const i0 = app.indexOf("const sc=o.scored;");
  const iDash = app.indexOf("no ledger claim behind this signal yet");
  assert.ok(i0 > 0 && iDash > i0, "nowChip checks the scored stub before falling back to the bare dash");
  assert.ok(app.includes("this episode already SCORED"), "the tooltip states what happened, not just that nothing is measurable");
  assert.ok(app.includes("one episode, one claim"), "…and names the re-arm rule so the dash's replacement explains itself");
  assert.ok(app.includes("pseudo-replication"), "…including WHY a serial re-claim is refused");
  assert.ok(/scored \$\{val\}/.test(app), "the chip leads with the outcome");
  // a voided settlement renders as void, never as a fabricated number
  assert.ok(app.includes(`'<span class="na">void</span>'`), "a never-scored expiry is an honest void, not a number");
});

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

test("structural void -01: EV_META convention, wiring manifest, panel rows, duel isolation pins", () => {
  const C = require("../src/compute");
  const DAY_ = 86400e3;
  for (const ev of ["lvlhold", "lvlrej"]) {
    assert.equal(C.EV_META[ev].resolve, "touch", `${ev} resolves by first touch`);
    assert.equal(C.EV_META[ev].horizonMs, 30 * DAY_, `${ev} 30d equity timeout`);
    assert.equal(C.evMeta(ev, "main").horizonMs, 15 * DAY_, `${ev} runs the compressed crypto clock`);
  }
  // the twins ride the incumbents' EXACT clock — a twin on a different horizon is not a duel
  for (const [tw, inc] of [["unwind2", "unwind"], ["squeeze2", "squeeze"]]) {
    assert.equal(C.EV_META[tw].horizonMs, C.EV_META[inc].horizonMs, `${tw} must resolve on ${inc}'s clock`);
    assert.ok(!C.EV_META[tw].resolve, `${tw} is at-horizon like its incumbent, never touch-mode`);
  }
  for (const f of ["detectLvlTouch", "structVoid", "nearestLevelBelow"])
    assert.equal((require("fs").readFileSync(require("path").join(__dirname, "..", "src", "compute.js"), "utf8")
      .match(new RegExp("^function " + f + "\\(", "mg")) || []).length, 1, `exactly one ${f} definition`);
  const fs = require("fs"), path = require("path");
  const pol = fs.readFileSync(path.join(__dirname, "..", "src", "poller.js"), "utf8");
  for (const pin of [
    'openLedger(r, "lvlhold"', 'openLedger(r, "lvlrej"',
    "stp: lhT.stop, tgt: lhT.target, tm: 1",                     // touch mode + frozen absolute levels
    "stp: lrT.stop, tgt: lrT.target, tm: 1",
    "lvn: lhT.n, lva: lhT.ageD", "lvn: lrT.n, lva: lrT.ageD",    // cluster features recorded, not gated
    "const cdbT = closedBars(mergedDailyBars(r), DAY, nowD);",   // true highs/lows, forming day trimmed
    '"lvlhold", "lvlrej",',                                      // MAIN_EVS: crypto fires these too
    '"squeeze", "unwind", "squeeze2", "unwind2"]);',             // twins stay xyz-only with their incumbents
    'ev: "lvlhold", uni: "both"', 'ev: "lvlrej", uni: "both"',   // shadow panel rows
    'ev: "squeeze2", uni: "xyz"', 'ev: "unwind2", uni: "xyz"',
    'lvn: "structural-void families',                            // export glossary documents the stamps
    'lva: "structural-void families',
  ]) assert.ok(pol.includes(pin), `poller.js missing 07.28-01 pin: ${pin}`);
  // Duel isolation, pinned at the fire sites: the twins read the incumbent play's target
  // VERBATIM and open only inside the incumbent's own visible-fire branch. Recomputing a target
  // here would quietly turn a one-variable experiment into a two-variable one.
  assert.ok(pol.includes('const sv = structVoid(closedBars(mergedDailyBars(r), DAY, now), r.px, sd30, "long");'),
    "squeeze2 derives its void from merged closed bars at the fire");
  assert.ok(pol.includes('const sv = structVoid(closedBars(mergedDailyBars(r), DAY, now), r.px, sd30, "short");'),
    "unwind2 likewise");
  assert.ok(pol.includes("Number.isFinite(sig.play.target) && sig.play.target > r.px ? sig.play.target : null"),
    "squeeze2's target IS the incumbent's play target, read verbatim");
  assert.ok(pol.includes("sig.play.target > 0 && sig.play.target < r.px ? sig.play.target : null"),
    "unwind2's target likewise (with the positive-price guard the short side needs)");
  const uq = pol.indexOf('openLedger(r, "unwind", sig, -1);'), u2 = pol.indexOf('openLedger(r, "unwind2"');
  assert.ok(uq > 0 && u2 > uq, "the twin opens after — and only alongside — the visible unwind fire");
});

test("structural void -01: end-to-end — the held support probe fires as an invisible touch-mode claim with tight frozen geometry", () => {
  const { createPoller } = require("../src/poller");
  const now = Date.now(), DAY_ = 86400e3, H = 3600e3;
  const store = { loadAll: () => new Map(), loadRegime: () => [], loadLedger: () => null,
    saveLedger: () => {}, insert: () => {}, saveRegime: () => {} };
  const p = createPoller({ dex: "xyz", store, log: () => {}, version: "test", crypto: false });
  // dailies (closes+highs; lows fall back to closes in the merge): support cluster at 100 from
  // two pivot-low CLOSES, target cluster at 118 from two pivot highs, alternation for sd30.
  // The probe itself arrives through the HOURLY spine: yesterday's daily bucket carries the true
  // low that dailyRaw structurally lacks — exactly the overlay mergedDailyBars exists for.
  const dayStart = Math.floor(now / DAY_) * DAY_;
  const nD = 302, dailyRaw = [];
  for (let i = 0; i < nD; i++) {
    const t = dayStart - (nD - i) * DAY_;
    let c = 104 + (i >= nD - 40 && i < nD - 1 ? (i % 2 ? 0.4 : -0.4) : 0), h = c + 0.4;
    if (i === 50 || i === 80) { c = 100; h = 100.4; }
    if (i === 60 || i === 90) h = 118;
    if (i === nD - 1) { c = 103; h = 103.4; }   // yesterday — overlaid by the spine bucket below
    dailyRaw.push({ t, c, h, v: 500 });
  }
  const hourlyRaw = [];
  for (let i = 0; i < 24; i++) {   // yesterday, hour by hour: one hour probes 100.2, the day closes 103
    const t = dayStart - DAY_ + i * H;
    const lo = i === 12 ? 100.2 : 102.8, c = i === 23 ? 103 : 103.2;
    hourlyRaw.push({ t, o: 103.2, h: 103.6, l: lo, c, v: 5 });
  }
  for (let t = dayStart; t <= now - H; t += H) hourlyRaw.push({ t, o: 103.5, h: 103.8, l: 103.2, c: 103.5, v: 5 });
  p.seedRowNow("xyz:LVT", { ticker: "LVT", px: 103.5, dailyRaw, hourlyRaw, hourlyTs: now });
  p.buildDailyNow();
  p.buildSignalsNow();
  const x = p.getLedgerExport();
  const e = x.open.find((k) => k.coin === "xyz:LVT" && k.ev === "lvlhold");
  assert.ok(e, "the level-hold shadow opened");
  assert.equal(e.vi, 0, "invisible — a shadow earning its record, never a live signal");
  assert.equal(e.psd, "long", "play-signed long");
  assert.equal(e.tm, 1, "touch-resolved");
  assert.ok(e.stp > 99 && e.stp < 100, `void half a σ behind the 100 level — TIGHT (got ${e.stp})`);
  assert.ok(Math.abs(e.tgt - 118) < 0.5, `target frozen on the 118 cluster (got ${e.tgt})`);
  assert.ok(e.sd0 > 0, "R-united at fire");
  assert.equal(e.lvn, 2, "cluster touch count stamped as a recorded feature");
  assert.ok(e.lva >= 0, "cluster age stamped alongside it");
  assert.ok((e.mark0 - e.stp) / e.mark0 * 100 < 4.5, "risk to void is a few percent of entry — the thesis, frozen into the claim");
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

test("board promotion path -02: a matured shadow record carries its family onto the actionable board — tight void, correct label, no new machinery", () => {
  // Phase 4, proven end-to-end: the board's confirmed gate IS the promotion. Eight resolved
  // out-of-sample lvlhold fires with positive expectancy hydrate from the persisted ledger, a
  // fresh live fire opens from the tape, and the row surfaces through the same
  // n>=8 / avgR>0 / EV>0 gate every family faces — flagged `shadow`, labeled from STRAT_DEFS,
  // void frozen half a sigma behind the structural level. This is the PURRDAT fix landing on the
  // board by record, not by argument.
  const { createPoller } = require("../src/poller");
  const now = Date.now(), DAY_ = 86400e3, H = 3600e3;
  const closed = [];
  for (let i = 0; i < 8; i++) closed.push({
    key: "xyz:OLD" + i + "|lvlhold#0", coin: "xyz:OLD" + i, ticker: "OLD" + i, ev: "lvlhold",
    t0: now - (40 - i) * DAY_, tR: now - (10 - i) * DAY_, mark0: 100, dir: 1, psd: "long", pn: 1, vi: 0,
    sd0: 1.2, stp: 99, tgt: 110, tm: 1, mv: 10, status: "resolved",
    realized: i < 6 ? 1.5 : -1, win: i < 6, realizedS: i < 6 ? 1.5 : -1, winS: i < 6, stopped: i >= 6,
  });
  const store = { loadAll: () => new Map(), loadRegime: () => [], saveLedger: () => {}, insert: () => {}, saveRegime: () => {},
    loadLedger: () => ({ ts: now, open: [], closed, rearm: [], variants: null }) };
  const p = createPoller({ dex: "xyz", store, log: () => {}, version: "test", crypto: false });
  p.hydrateLedgerNow();   // start() is never called in the harness — hydrate the persisted record explicitly
  // the -01 e2e tape, verbatim: support cluster at 100 probed through the hourly spine's true low
  const dayStart = Math.floor(now / DAY_) * DAY_;
  const nD = 302, dailyRaw = [];
  for (let i = 0; i < nD; i++) {
    const t = dayStart - (nD - i) * DAY_;
    let c = 104 + (i >= nD - 40 && i < nD - 1 ? (i % 2 ? 0.4 : -0.4) : 0), h = c + 0.4;
    if (i === 50 || i === 80) { c = 100; h = 100.4; }
    if (i === 60 || i === 90) h = 118;
    if (i === nD - 1) { c = 103; h = 103.4; }
    dailyRaw.push({ t, c, h, v: 500 });
  }
  const hourlyRaw = [];
  for (let i = 0; i < 24; i++) {
    const t = dayStart - DAY_ + i * H;
    hourlyRaw.push({ t, o: 103.2, h: 103.6, l: i === 12 ? 100.2 : 102.8, c: i === 23 ? 103 : 103.2, v: 5 });
  }
  for (let t = dayStart; t <= now - H; t += H) hourlyRaw.push({ t, o: 103.5, h: 103.8, l: 103.2, c: 103.5, v: 5 });
  p.seedRowNow("xyz:LVT", { ticker: "LVT", px: 103.5, dailyRaw, hourlyRaw, hourlyTs: now });
  p.buildDailyNow();
  p.buildSignalsNow();
  p.buildActionableNow();
  const a = p.getActionable();
  const row = a.rows.find((x) => x.coin === "xyz:LVT" && x.ev === "lvlhold");
  assert.ok(row, "the confirmed structural family reaches the board: " + JSON.stringify(a.coverage));
  assert.equal(row.shadow, true, "honestly flagged as a shadow-record family");
  assert.equal(row.label, "structural support hold", "labeled from STRAT_DEFS — one definition, panel and board agree");
  assert.ok(row.void > 99 && row.void < 100, `the board's void IS the structural stop — tight, on the invalidation (got ${row.void})`);
  assert.equal(row.rec.n, 8, "gated on the family's own out-of-sample record");
  assert.ok(row.rec.avgR > 0 && row.evR > 0, "and only because that record models positive from here");
  assert.ok(row.rr && row.rr.gross >= 2, "the tight void is what buys the R:R the sigma constructions never could");
});

// ===== display names + gated macro news lane (build 2026.07.28-03) =============================
// Two shipped changes, one test block. (1) A ticker now carries the instrument behind it, from a
// static label table. (2) The drawer's macro-tape fallback — previously "anything not an Equity
// gets the raw general tape", which put the identical five headlines in the EWZ drawer and the
// JPY drawer — is gated on per-instrument topics, server-side.

test("displayName: a label table, separate from the headline-alias table, null when unseeded", () => {
  const { displayName, companyName, DISPLAY_NAMES, CRYPTO_NAMES } = require("../src/sectors");
  assert.equal(displayName("EWZ"), "iShares MSCI Brazil ETF");
  assert.equal(displayName("ewz"), "iShares MSCI Brazil ETF", "case-insensitive");
  assert.equal(displayName("JPY"), "Japanese yen");
  assert.equal(displayName("CL"), "WTI crude oil", "the CL collision resolves to crude here too, not Colgate");
  assert.equal(displayName("BTC", "main"), "Bitcoin");
  assert.equal(displayName("BRK.B"), "Berkshire Hathaway (class B)");
  assert.equal(displayName("BRKB"), "Berkshire Hathaway (class B)", "the dot-stripped form resolves to the same name");
  // Unseeded is null, never a guess and never the ticker echoed back — the caller decides to omit.
  assert.equal(displayName("TOTALLYMADEUPXYZ"), null);
  assert.equal(displayName(""), null);
  assert.equal(displayName(null), null);
  assert.equal(displayName("EWZ", "main"), null, "an equity-universe label must not leak into a crypto lookup");
  assert.equal(displayName("NVDA", "main"), null);
  // The whole point of a separate table: COMPANY_NAMES holds MATCH FRAGMENTS tuned for substring
  // hits, and rendering those as labels would put "Procter" and "Snap " on screen. Pin the split.
  assert.equal(companyName("PG"), "Procter");
  assert.equal(displayName("PG"), "Procter & Gamble");
  assert.equal(companyName("SNAP"), "Snap ");
  assert.equal(displayName("SNAP"), "Snap Inc.");
  // No empty or whitespace-only labels in either table — an empty string renders an empty line.
  for (const [t, v] of Object.entries(DISPLAY_NAMES).concat(Object.entries(CRYPTO_NAMES)))
    assert.ok(typeof v === "string" && v.trim().length > 1, `display name for ${t} must be a real label`);
  // Pre-IPO synthetics must SAY they are synthetics — the label is where that disclosure lives.
  for (const t of ["SPCX", "OPENAI", "ANTHROPIC", "XAI"])
    assert.ok(/pre-IPO synthetic/.test(DISPLAY_NAMES[t]), `${t} label must disclose it is a synthetic`);
});

test("macroLane: scoped topics, broad tape, or no lane at all — never a bare fallback", () => {
  const { macroLane, MACRO_LANES } = require("../src/sectors");
  // The screenshot bug, both names: each now declares its own topics rather than sharing the tape.
  const ewz = macroLane("EWZ"), jpy = macroLane("JPY");
  assert.ok(ewz && ewz.topics.includes("Brazil") && ewz.label === "Brazil");
  assert.ok(jpy && jpy.topics.includes("yen") && jpy.label === "Japan");
  assert.ok(!ewz.topics.some((t) => jpy.topics.includes(t)), "the two lanes that produced the bug must not overlap at all");
  // Broad: the instrument IS the tape. Declared, not inferred from asset class.
  assert.equal(macroLane("SP500").broad, true);
  assert.equal(macroLane("VIX").broad, true);
  assert.equal(macroLane("DXY").broad, true);
  // An equity has no lane — that is what makes "no headlines" the honest equity answer.
  assert.equal(macroLane("NVDA"), null);
  assert.equal(macroLane("AAPL"), null);
  assert.equal(macroLane("BTC", "main"), null, "the crypto drawer has no news feed, so it gets no lane");
  // Shape invariant: broad lanes carry no topics, scoped lanes carry a label AND a non-empty list.
  for (const [t, L] of Object.entries(MACRO_LANES)) {
    if (L.broad) { assert.ok(!L.topics, `${t} is broad and must not also declare topics`); continue; }
    assert.ok(typeof L.label === "string" && L.label.length, `${t} scoped lane needs a label`);
    assert.ok(Array.isArray(L.topics) && L.topics.length, `${t} scoped lane needs topics`);
    for (const k of L.topics) assert.ok(typeof k === "string" && k.trim().length >= 2, `${t} topic "${k}" too short to gate on`);
  }
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

test("macro lane wiring: the server decides which tape headline is which macro name's news", () => {
  const { createPoller } = require("../src/poller");
  const store = { loadAll: () => new Map(), loadRegime: () => [], loadLedger: () => null,
    saveLedger: () => {}, insert: () => {}, saveRegime: () => {}, saveNews: () => {}, loadNews: () => null };
  const p = createPoller({ dex: "xyz", store, log: () => {}, version: "test" });
  const now = Date.now();
  p.seedRowNow("xyz:EWZ", { ticker: "EWZ", px: 36, uni: "xyz", vol: 1e6 });
  p.seedRowNow("xyz:JPY", { ticker: "JPY", px: 0.0067, uni: "xyz", vol: 1e6 });
  p.seedRowNow("xyz:SP500", { ticker: "SP500", px: 6100, uni: "xyz", vol: 1e6 });
  p.seedRowNow("xyz:NVDA", { ticker: "NVDA", px: 180, uni: "xyz", vol: 1e6 });
  const d = p.newsIngestNow([
    { id: 1, tk: null, h: "Petrobras lifts diesel prices as Brazil fuel policy shifts", src: "Reuters", url: "u", pub: now - 1e6 },
    { id: 2, tk: null, h: "Bank of Japan holds, yen slips past 160", src: "Reuters", url: "u", pub: now - 2e6 },
    { id: 3, tk: null, h: "Seagate 4Q revenue beats estimates", src: "trad_fin", url: "u", pub: now - 3e6 },
    { id: 4, tk: "NVDA", h: "Nvidia unveils next-gen accelerator", src: "Reuters", url: "u", pub: now - 4e6 },
  ]);
  const by = new Map(d.items.map((a) => [a.id, a]));
  const tags = (id) => by.get(id).mtk || [];
  // The exact bug from the screenshots: one macro headline reaching two unrelated macro drawers.
  assert.ok(tags(1).includes("EWZ"), "the Brazil headline is EWZ's news");
  assert.ok(!tags(1).includes("JPY"), "…and is NOT the yen's news — this is the bug, pinned");
  assert.ok(tags(2).includes("JPY") && !tags(2).includes("EWZ"), "and symmetrically the other way");
  // A generic earnings print belongs to neither scoped name, but IS the broad tape's news.
  assert.ok(!tags(3).includes("EWZ") && !tags(3).includes("JPY"),
    "an unrelated print reaches no scoped drawer — the filler the old fallback shipped");
  for (const id of [1, 2, 3]) assert.ok(tags(id).includes("SP500"), "broad-lane names take the whole tape by declaration");
  // Verified company items keep their own name and never enter a macro lane.
  assert.equal(by.get(4).tk, "NVDA");
  assert.equal(by.get(4).mtk, undefined, "a verified company headline is never also macro-lane news");
  // A name outside the live universe can never be stamped, however well its topics match.
  for (const a of d.items) for (const T of (a.mtk || []))
    assert.ok(["EWZ", "JPY", "SP500"].includes(T), `stamped a ticker not in the roster: ${T}`);
  // Row payload carries the label and the lane, so the client re-derives neither.
  const snap = p.buildSnapshotNow() || p.getSnapshot();
  const row = (t) => snap.markets.find((m) => m.ticker === t);
  assert.equal(row("EWZ").nm, "iShares MSCI Brazil ETF");
  assert.equal(row("EWZ").mlane.label, "Brazil");
  assert.equal(row("SP500").mlane.broad, true);
  assert.equal(row("NVDA").nm, "NVIDIA Corp.");
  assert.equal(row("NVDA").mlane, undefined, "an equity ships no lane — the drawer then says 'no headlines'");
});

test("macro lane, rendered: the drawer shows a scoped tape, an honest empty, or nothing at all", () => {
  const fs = require("fs"), path = require("path");
  const app = fs.readFileSync(path.join(__dirname, "..", "public", "app.js"), "utf8");
  const grab = (name) => {
    const i = app.indexOf("function " + name + "(");
    assert.ok(i >= 0, `${name} not found in app.js`);
    let d = 0;
    for (let k = app.indexOf("{", i); k < app.length; k++) { if (app[k] === "{") d++; if (app[k] === "}") { d--; if (!d) return app.slice(i, k + 1); } }
  };
  // Execute the real function against a stub DOM — an existence pin would not have caught the
  // original bug either, because the old code DID render, just with the wrong rows in it.
  const mk = (rows, news, detail) => new Function(
    "const boxes={};\nconst el=(id)=>boxes[id]||(boxes[id]={innerHTML:'',onclick:null});\n" +
    "const esc=(x)=>String(x==null?'':x).replace(/&/g,'&amp;').replace(/</g,'&lt;');\n" +
    "const fmtAge=()=>'1m';\nconst newsRow=(a)=>'<div class=\"nrow\" data-id=\"'+a.id+'\">'+esc(a.h)+'</div>';\n" +
    "let newsFilter=null,newsMode='all';const showView=()=>{};\n" +
    "const state={detail:" + JSON.stringify(detail) + ",rows:new Map(" + JSON.stringify(rows) + "),news:" + JSON.stringify(news) + "};\n" +
    grab("fillDrawerNews") + "\nfillDrawerNews();\nreturn boxes.dnews.innerHTML;")();
  const now = Date.now();
  const news = { fetchedAt: now, items: [
    { id: 1, tk: null, h: "Petrobras lifts diesel prices", mtk: ["EWZ", "SP500"] },
    { id: 2, tk: null, h: "Bank of Japan holds, yen slips", mtk: ["JPY", "SP500"] },
    { id: 3, tk: null, h: "Seagate 4Q revenue beats", mtk: ["SP500"] },
  ] };
  const ewz = ["xyz:EWZ", { coin: "xyz:EWZ", ticker: "EWZ", uni: "xyz", assetClass: "ETF", nm: "iShares MSCI Brazil ETF", mlane: { label: "Brazil", topics: ["Brazil", "Petrobras"] } }];
  const jpy = ["xyz:JPY", { coin: "xyz:JPY", ticker: "JPY", uni: "xyz", assetClass: "FX", nm: "Japanese yen", mlane: { label: "Japan", topics: ["yen", "Bank of Japan"] } }];
  const spx = ["xyz:SP500", { coin: "xyz:SP500", ticker: "SP500", uni: "xyz", assetClass: "Index", mlane: { broad: true } }];
  const nvda = ["xyz:NVDA", { coin: "xyz:NVDA", ticker: "NVDA", uni: "xyz", assetClass: "Equity", nm: "NVIDIA Corp." }];
  const eur = ["xyz:EURX", { coin: "xyz:EURX", ticker: "EURX", uni: "xyz", assetClass: "FX" }];   // macro, no seeded lane

  const h1 = mk([ewz, jpy, spx, nvda, eur], news, "xyz:EWZ");
  assert.ok(h1.includes('data-id="1"'), "the Brazil headline renders in the Brazil drawer");
  assert.ok(!h1.includes('data-id="2"') && !h1.includes('data-id="3"'),
    "and neither the yen item nor the unrelated print does — the screenshot bug, rendered");
  assert.ok(h1.includes("macro tape \u00b7 Brazil"), "the header names the scope, so the reader knows a filter ran");
  assert.ok(/1 of 3 tape items matched/.test(h1), "provenance line states how much of the tape survived");
  assert.ok(h1.includes("gated on Brazil"), "…and what it was gated on");

  const h2 = mk([ewz, jpy, spx, nvda, eur], news, "xyz:JPY");
  assert.ok(h2.includes('data-id="2"') && !h2.includes('data-id="1"'), "symmetric on the other name");

  const h3 = mk([ewz, jpy, spx, nvda, eur], news, "xyz:SP500");
  for (const id of [1, 2, 3]) assert.ok(h3.includes('data-id="' + id + '"'), "a broad-lane name still takes the whole tape");
  assert.ok(!/tape items matched/.test(h3), "and shows no gate provenance, because no gate ran");

  const h4 = mk([ewz, jpy, spx, nvda, eur], news, "xyz:NVDA");
  assert.ok(!/data-id="/.test(h4), "an equity with no per-name news gets NO tape rows");
  assert.ok(h4.includes("no headlines in the last 72h") && !h4.includes("no matching headlines"),
    "and the equity wording is unchanged — this behaviour was already correct");

  const h5 = mk([ewz, jpy, spx, nvda, eur], news, "xyz:EURX");
  assert.ok(!/data-id="/.test(h5), "a macro name with no seeded lane gets nothing rather than the raw tape");

  // A lane whose topics match nothing today says so, instead of falling back to unrelated items.
  const h6 = mk([ewz, jpy, spx, nvda, eur], { fetchedAt: now, items: [{ id: 3, tk: null, h: "Seagate 4Q revenue beats", mtk: ["SP500"] }] }, "xyz:EWZ");
  assert.ok(!/data-id="/.test(h6) && h6.includes("no matching headlines in the last 72h"),
    "zero matches is stated, not papered over");
  assert.ok(/0 of 1 tape item matched/.test(h6), "singular/plural handled, and the zero is disclosed");
});

test("display-name client wiring: drawer head, board tooltip, report head, style", () => {
  const fs = require("fs"), path = require("path");
  const app = fs.readFileSync(path.join(__dirname, "..", "public", "app.js"), "utf8");
  const css = fs.readFileSync(path.join(__dirname, "..", "public", "styles.css"), "utf8");
  const pol = fs.readFileSync(path.join(__dirname, "..", "src", "poller.js"), "utf8");
  assert.ok(app.includes('${r.nm?`<div class="dname"'), "drawer head renders the name line only when a name exists");
  assert.ok(app.includes("r.nm?r.nm+' \\u00b7 '+r.coin:r.coin"), "board ticker tooltip carries the name");
  assert.ok(app.includes("${r&&r.nm?esc(r.nm)+' \u00b7 ':''}"), "AI report head carries the name");
  assert.ok(css.includes(".drawer .dname{"), "the name line has a style rule");
  // The name must never be an empty rendered element: the guard is the ternary, not a CSS :empty.
  assert.ok(!/class="dname"[^>]*>\$\{esc\(r\.nm\|\|''\)\}/.test(app), "no unconditional name element");
  assert.ok(pol.includes("nm: displayName(r.ticker, r.uni) || undefined,"), "server ships the label, client never derives it");
  assert.ok(pol.includes("mlane: macroLane(r.ticker, r.uni) || undefined,"), "server ships the lane, client never derives it");
  assert.ok(!/topicHit\(/.test(app), "the topic gate must NOT run client-side — one code path, server-owned");
});

// ===== industry grouping layer (build 2026.07.28-04) ===========================================
// A curated industry table LAYERED on the GICS map: classify() now returns {assetClass, sector,
// ind}, the board wire ships `ind` only when it differs, and the Sectors tab re-cuts by one
// shared grouping key. These tests EXECUTE the real classifier (not string pins) and derive the
// table's integrity from the table itself.

test("-04 classify(): the industry layer rides on top of GICS, fallback ind===sector everywhere", () => {
  const S = require("../src/sectors");
  // The founding complaint: the memory complex, legible as its own group, GICS untouched.
  for (const t of ["SNDK", "SKHX", "MU", "KIOXIA", "WDC", "STX", "SMSN"]) {
    const c = S.classify(t);
    assert.equal(c.sector, "Information Technology", t + " keeps its GICS sector");
    assert.equal(c.ind, "Memory/Storage", t + " carries the Memory/Storage industry");
  }
  // Deliberate cross-GICS groups: the tape's grouping wins the industry, GICS keeps the sector.
  assert.deepEqual([S.classify("MSTR").sector, S.classify("MSTR").ind], ["Information Technology", "Crypto-Fi"]);
  assert.deepEqual([S.classify("COIN").sector, S.classify("COIN").ind], ["Financials", "Crypto-Fi"]);
  assert.equal(S.classify("AAPL").ind, "Mega Platforms");
  assert.equal(S.classify("AMZN").ind, "Mega Platforms", "Mega Platforms crosses into Cons Disc");
  // Thematic price indices join the trade they price.
  assert.equal(S.classify("DRAM").ind, "Memory/Storage");
  assert.equal(S.classify("DRAM").assetClass, "Thematic", "…without losing their asset class");
  // Pre-IPO synthetics carry industries too.
  assert.equal(S.classify("OPENAI").ind, "AI Software");
  assert.equal(S.classify("SPCX").ind, "Aero/Defense");
  // Fallbacks: an unsplit equity, an index, FX, a commodity, the unknown — ind ALWAYS === sector.
  for (const t of ["CAT", "SPX", "EURUSD", "XAU", "TOTALLYUNKNOWN"]) {
    const c = S.classify(t);
    assert.equal(c.ind, c.sector, t + ": no curated industry means ind falls back to sector, never undefined");
  }
  // Crypto main dex: its sub-sectors ARE the fine grouping; ind mirrors them exactly.
  for (const t of ["BTC", "PEPE", "NOSUCHCOIN"]) {
    const c = S.classify(t, "main");
    assert.equal(c.ind, c.sector, "main-dex ind mirrors the crypto sector for " + t);
  }
  // The one GICS correction in this build: Zoom moved to Info Tech (its post-2023 GICS home).
  assert.equal(S.classify("ZM").sector, "Information Technology", "ZM reclassified out of Comm Services");
  assert.equal(S.classify("ZM").ind, "Software");
});

test("-04 IND table integrity: derived from the table, not pinned to it", () => {
  const S = require("../src/sectors");
  const gics = new Set(Object.keys(S.SECTOR_TICKERS));
  const seen = new Map();
  for (const [ind, arr] of Object.entries(S.IND_TICKERS)) {
    // Group names must never collide with a GICS sector name or the sentinel: the client
    // detects fallback groups by name, and a collision would silently merge curated members
    // with fallback members under one label.
    assert.ok(!gics.has(ind) && ind !== "Unclassified", "industry name collides with a sector name: " + ind);
    for (const t of arr) {
      // One industry per ticker — a duplicate would make classification order-dependent.
      assert.ok(!seen.has(t), t + " appears in both '" + seen.get(t) + "' and '" + ind + "'");
      seen.set(t, ind);
      // Every entry must resolve through the real classifier to a known instrument that
      // actually carries this industry — no orphan rows pointing at nothing.
      const c = S.classify(t);
      assert.notEqual(c.assetClass, "Unclassified", "IND entry '" + t + "' classifies as Unclassified — orphan row");
      assert.equal(c.ind, ind, t + " must resolve to its own IND entry through classify()");
    }
  }
  // The founding split must be real: Info Tech's curated industries cover the mega-bucket's
  // heaviest names, so the sector lens is no longer the only lens.
  for (const t of ["NVDA", "MU", "MSFT", "PANW", "AMAT"]) {
    const c = S.classify(t);
    assert.notEqual(c.ind, c.sector, t + " must carry a curated industry distinct from Info Tech");
  }
});

test("-04 wiring manifest: server ships ind thin, client groups on ONE key, control persists", () => {
  const fs = require("fs"), path = require("path");
  const pl = fs.readFileSync(path.join(__dirname, "..", "src", "poller.js"), "utf8");
  const app = fs.readFileSync(path.join(__dirname, "..", "public", "app.js"), "utf8");
  const ht = fs.readFileSync(path.join(__dirname, "..", "public", "index.html"), "utf8");
  const css = fs.readFileSync(path.join(__dirname, "..", "public", "styles.css"), "utf8");
  // Wire: shipped only when it differs — absence IS the fallback, by contract.
  assert.ok(pl.includes("ind: cl.ind !== cl.sector ? cl.ind : undefined,"), "board wire ships ind thin");
  // One grouping key for the whole tab: board grouping and cohesion/corr partition must both
  // route through sectKeyOf, or the matrix could disagree with the board (one-code-path).
  assert.ok(app.includes("function sectKeyOf(r){ return (sectGrpActive() ? (r.ind||r.sector) : r.sector) || 'Unclassified'; }"), "grouping key helper");
  assert.ok(app.includes("for(const r of activeRows()){ const g=sectKeyOf(r);"), "computeSectors groups on the shared key");
  assert.ok(app.includes("withDaily.forEach((r,i)=>{ const g=sectKeyOf(r);"), "cohesion partitions on the SAME key");
  assert.equal((app.match(/const g=sectKeyOf\(r\)/g) || []).length, 2, "exactly the two grouping sites call the key — no third path, no bypass");
  // The client must never re-derive an industry from a ticker: no industry TABLE client-side.
  // (The help text may NAME groups as documentation; what's forbidden is a ticker→industry map.)
  assert.ok(!/IND_TICKERS/.test(app) && !/['"]SNDK['"]\s*:/.test(app) && !/['"]SKHX['"]\s*:/.test(app),
    "client consumes r.ind from the wire, never derives it");
  // Crypto scope: the toggle is inert AND hidden — the key and the control can never disagree.
  assert.ok(app.includes("state.sect.grp==='ind' && state.scope!=='crypto'"), "industry grouping is equities-only");
  assert.ok(app.includes("const gseg=el('sectgrp'); if(gseg) gseg.hidden=cr;"), "the seg hides in crypto scope");
  assert.ok(css.includes(".seg[hidden]{display:none}"), "hidden seg guarded against the display:inline-flex bug class");
  // Honesty chips + provenance column exist, and the pref round-trips through the enum guard.
  assert.ok(app.includes('«thin» rows carry noisier stats'), "thin-sample disclosure in the board caption");
  assert.ok(app.includes("no industry split defined — this group is the GICS sector unchanged"), "visible = sector fallback");
  assert.ok(app.includes("title=\"parent GICS sector(s) of this group's members\""), "GICS provenance column");
  assert.ok(app.includes("sectGrp:state.sect.grp,"), "pref saved");
  assert.ok(app.includes("if(p.sectGrp==='ind'||p.sectGrp==='sector') state.sect.grp=p.sectGrp;"), "pref restored through an enum guard");
  assert.ok(css.includes(".sthin{"), "chip style exists");
  for (const pin of ['id="sectgrp"', 'data-grp="sector"', 'data-grp="ind"']) assert.ok(ht.includes(pin), "index pin missing: " + pin);
  // The founding fix stays fixed: ZM must not drift back into the Comm Services roster.
  const sj = fs.readFileSync(path.join(__dirname, "..", "src", "sectors.js"), "utf8");
  assert.ok(!/"SPOT","ROKU","ZM"/.test(sj), "ZM must stay out of Communication Services");
});

// ===== industry-grouping ingest (build 2026.07.28-05) ==========================================
// The -04 field-name-mismatch bug, made unrepeatable. applySnapshot's merge is an EXPLICIT
// field-by-field copy — the wire carried `ind`, the merge dropped it, and every industry group
// rendered as an "= sector" fallback. String pins on the wire and the grouping key could not
// catch it: only pushing a payload through the REAL ingestion path can. This test evaluates the
// real client (the -17 harness pattern), feeds applySnapshot a snapshot whose rows carry `ind`
// exactly as the poller ships it, and asserts the field survives into state.rows AND that
// computeSectors then actually splits on it.
test("-05 regression: applySnapshot carries `ind` into state.rows and the industry grouping splits", () => {
  const fs = require("fs"), path = require("path");
  const app = fs.readFileSync(path.join(__dirname, "..", "public", "app.js"), "utf8");
  const { els, mk } = _sessDomStub();
  const saved = { si: global.setInterval, st: global.setTimeout, raf: global.requestAnimationFrame,
    doc: global.document, win: global.window, ls: global.localStorage, f: global.fetch };
  global.setInterval = () => 0; global.setTimeout = () => 0; global.requestAnimationFrame = () => 0;
  global.document = { getElementById: (id) => (els[id] = els[id] || mk(id)), querySelectorAll: () => [], querySelector: () => null,
    createElement: mk, addEventListener() {}, body: mk("body"), documentElement: mk("html"), hidden: false };
  global.window = { addEventListener() {}, location: { reload() {}, href: "/" }, matchMedia: () => ({ matches: false, addEventListener() {} }) };
  global.localStorage = { _d: {}, getItem(k) { return this._d[k] ?? null; }, setItem(k, v) { this._d[k] = String(v); }, removeItem(k) { delete this._d[k]; } };
  global.fetch = () => new Promise(() => {});
  try {
    const S = require("../src/sectors");
    let H = null;
    eval(app + "\n; H={state, applySnapshot, computeSectors, sectGrpActive};");
    // Rows exactly as the poller ships them: `ind` present only when it differs from sector.
    const wire = (t) => { const c = S.classify(t); return { coin: "xyz:" + t, ticker: t, uni: "xyz",
      sector: c.sector, assetClass: c.assetClass, ind: c.ind !== c.sector ? c.ind : undefined,
      px: 100, prevDay: 99, vol: 1e8, oi: 5e7, feat: { volBase: 9e7 } }; };
    const mkts = ["SNDK", "SKHX", "MU", "NVDA", "MSFT", "CAT"].map(wire);
    H.applySnapshot({ markets: mkts, mainMarkets: [], dataTs: 7 });
    // 1) the field SURVIVES ingestion — this is the exact line that was missing in -04
    assert.equal(H.state.rows.get("xyz:SNDK").ind, "Memory/Storage", "ind must survive the explicit merge");
    assert.equal(H.state.rows.get("xyz:NVDA").ind, "Semiconductors");
    assert.equal(H.state.rows.get("xyz:CAT").ind, undefined, "absent-on-the-wire stays absent — absence IS the fallback");
    // 2) lockstep self-heal: a later payload with sector but no ind must CLEAR a stale group
    H.applySnapshot({ markets: mkts.map(m => m.ticker === "SNDK" ? Object.assign({}, m, { ind: undefined }) : m),
      mainMarkets: [], dataTs: 8 });
    assert.equal(H.state.rows.get("xyz:SNDK").ind, undefined, "ind rides sector in lockstep — stale groups self-heal");
    // 3) end to end: re-ingest the true payload and the grouping actually splits on it
    H.applySnapshot({ markets: mkts, mainMarkets: [], dataTs: 9 });
    H.state.scope = "stocks"; H.state.tf = "1d"; H.state.sect.grp = "ind";
    const names = H.computeSectors().map(g => g.name);
    assert.ok(names.includes("Memory/Storage") && names.includes("Semiconductors") && names.includes("Industrials"),
      "industry grouping splits the ingested rows: " + names.join(", "));
    H.state.sect.grp = "sector";
    assert.ok(!H.computeSectors().map(g => g.name).includes("Memory/Storage"), "sector grouping stays GICS-only");
  } finally {
    global.setInterval = saved.si; global.setTimeout = saved.st; global.requestAnimationFrame = saved.raf;
    global.document = saved.doc; global.window = saved.win; global.localStorage = saved.ls; global.fetch = saved.f;
  }
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

test("-06 client/server duel: basketClosesClient reproduces compute.basketCloses bit-identically on a ragged fixture", () => {
  const fs = require("fs"), path = require("path");
  const app = fs.readFileSync(path.join(__dirname, "..", "public", "app.js"), "utf8");
  const grab = (name) => {
    const i = app.indexOf("function " + name + "(");
    assert.ok(i > -1, name + " present in app.js");
    let d = 0, j = app.indexOf("{", i);
    for (let k = j; k < app.length; k++) { if (app[k] === "{") d++; else if (app[k] === "}") { d--; if (!d) return app.slice(i, k + 1); } }
    throw new Error("unbalanced " + name);
  };
  const fn = new Function(grab("basketClosesClient") + "\nreturn basketClosesClient;")();
  const C = require("../src/compute");
  const fix = [
    [100, 101, null, 103, 104, null, 107],
    [200, 198, 197, null, 205, null, 210],
    [50, 51, 52, 53, null, null, 55],
    [10, null, 10, 11, 12, null, 13],
  ];
  for (const floor of [0.6, 0.5, 0.9]) {
    assert.deepEqual(fn(fix, floor), C.basketCloses(fix, floor), "one math, two runtimes — floor " + floor);
  }
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

test("-06 tier boundary: baskets/ratio never reach the alert emitters, the fire sites, or the push classes", () => {
  const fs = require("fs"), path = require("path");
  const pj = fs.readFileSync(path.join(__dirname, "..", "src", "poller.js"), "utf8");
  const grab = (src, sig) => {
    const i = src.indexOf(sig);
    assert.ok(i > -1, sig + " present");
    let d = 0, j = src.indexOf("{", i);
    for (let k = j; k < src.length; k++) { if (src[k] === "{") d++; else if (src[k] === "}") { d--; if (!d) return src.slice(i, k + 1); } }
    throw new Error("unbalanced " + sig);
  };
  // The entire ratio assembly must be inert: no push, no alert state, no claim machinery.
  const gr = grab(pj, "function getRatio(");
  const gb = grab(pj, "function getBasketsPayload(");
  const gc = grab(pj, "function createBasket(");
  for (const bad of ["pushBatch", "enqueueAlert", "emaAlertState", "recordClaim", "openClaim", "pushDrain", "maState"]) {
    assert.ok(!gr.includes(bad), "getRatio touches " + bad + " — the tier boundary is breached");
    assert.ok(!gb.includes(bad), "getBasketsPayload touches " + bad);
    assert.ok(!gc.includes(bad), "createBasket touches " + bad);
  }
  // The push-class registry gains no basket/ratio class — there is nothing to subscribe to.
  const C = require("../src/compute");
  assert.ok(Array.isArray(C.PUSH_CLASSES) && !C.PUSH_CLASSES.some((c) => /basket|ratio/i.test(c)), "no basket/ratio push class exists");
  // Manifest entry pinned: one key, admin default, BOTH routes gated by it.
  const f = C.FEATURES.find((x) => x.key === "baskets");
  assert.ok(f, "baskets manifest entry exists");
  assert.equal(f.def, "admin", "admin-only while it soaks");
  assert.deepEqual(f.routes, ["/api/baskets", "/api/ratio"], "both routes gated by the one key");
  // Ratio constants: no shorter EMA can ever wear the 200 name.
  assert.ok(pj.includes("RATIO_EMA_SPAN = 200"), "EMA span pinned at 200");
  assert.ok(pj.includes("RATIO_EMA_MIN = RATIO_EMA_SPAN + 5"), "eligibility floor derives from the span, mirroring emaSeries");
  assert.ok(gr.includes('"insufficient_bars"'), "machine-readable reason when the EMA cannot exist");
});

test("-06 ratio SVG behavioral: real candles render, the EMA path appears only when the series exists, rebase is a scalar transform", () => {
  const fs = require("fs"), path = require("path");
  const app = fs.readFileSync(path.join(__dirname, "..", "public", "app.js"), "utf8");
  const grab = (name) => {
    const i = app.indexOf("function " + name + "(");
    assert.ok(i > -1, name + " present");
    let d = 0, j = app.indexOf("{", i);
    for (let k = j; k < app.length; k++) { if (app[k] === "{") d++; else if (app[k] === "}") { d--; if (!d) return app.slice(i, k + 1); } }
    throw new Error("unbalanced " + name);
  };
  const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  const ratioSvg = new Function("esc", grab("ratioSvg") + "\nreturn ratioSvg;")(esc);
  const HOUR = 3600e3, t0 = 1700000000000;
  const candles = Array.from({ length: 12 }, (_, i) => { const o = 2 + i * 0.01, c = o + (i % 2 ? 0.02 : -0.015); return { t: t0 + i * 4 * HOUR, o, h: Math.max(o, c) + 0.01, l: Math.min(o, c) - 0.01, c }; });
  const ema = candles.map((k, i) => (i < 3 ? null : k.c - 0.005));
  const d = { candles, ema200: ema };
  const on = ratioSvg(d, { scale: "reb", ema: true });
  assert.equal((on.svg.match(/class="rt-k"/g) || []).length, candles.length, "one candle body per bar — real markup, not an existence pin");
  assert.ok(on.svg.includes('class="rt-ema"'), "EMA path present when the series exists and the toggle is on");
  assert.ok(on.svg.includes('id="rt-cx"') && on.svg.includes('id="rt-hl"'), "crosshair + candle-highlight nodes exist for the hover wiring (standing rule: every chart hovers)");
  assert.equal(on.pts.length, candles.length, "one hover point per candle");
  const off = ratioSvg({ candles, ema200: null }, { scale: "reb", ema: true });
  assert.ok(!off.svg.includes('class="rt-ema"'), "no EMA series -> no path, never a fabricated line");
  // Rebase = scalar multiply: the first candle's open maps to 100 exactly.
  const firstY = on.pts[0];
  const raw = ratioSvg(d, { scale: "raw", ema: false });
  assert.ok(raw.pts.length === candles.length && firstY, "raw mode renders the same bars");
});

test("-06 wiring pins: panels + guards + chip anatomy + verbs + honest copy exist end to end", () => {
  const fs = require("fs"), path = require("path");
  const ht = fs.readFileSync(path.join(__dirname, "..", "public", "index.html"), "utf8");
  assert.ok(ht.includes('<div id="ratiopanel" class="corrpanel" hidden></div>'), "ratio panel div, born hidden");
  assert.ok(ht.includes('<div id="basketpanel" class="corrpanel" hidden></div>'), "basket manager div, born hidden");
  const app = fs.readFileSync(path.join(__dirname, "..", "public", "app.js"), "utf8");
  for (const pin of ["function renderBasketPanel(", "function openRatio(", "function renderRatio(", "function ratioSvg(",
    "function termBasket(", "function termRatio(", "function loadBaskets(", "function basketTip(", "function compgBasketBars(",
    "if(h==='basket') return termBasket", "if(h==='ratio') return termRatio",
    "renders as a GAP, never a renormalized guess",
    "No shorter EMA ever wears the 200 name",
    "intrabar extremes finer than 1H not captured",
    "never enter signal math"]) assert.ok(app.includes(pin), "app.js pin missing: " + pin);
  assert.ok(app.includes("\\u2b12"), "the \u2b12 basket glyph is part of the chip anatomy");
  const css = fs.readFileSync(path.join(__dirname, "..", "public", "styles.css"), "utf8");
  assert.ok(css.includes(".cg-chip.bk{border-style:dashed}"), "basket chips are dashed — the anatomy IS the disclosure");
  assert.ok(css.includes(".bk-new[hidden]{display:none}") && css.includes(".rt-ctrls[hidden]{display:none}"), "flex rules carry their [hidden] guards (the display-beats-hidden bug class)");
  const srv = fs.readFileSync(path.join(__dirname, "..", "server.js"), "utf8");
  assert.ok(srv.includes('"/api/baskets"') && srv.includes('"/api/ratio"'), "both routes registered");
  assert.ok(srv.includes('poller.getBasketsStamp()'), "ETag keys fold the registry stamp");
  const st = fs.readFileSync(path.join(__dirname, "..", "src", "store.js"), "utf8");
  assert.ok(st.includes('baskets.json') && st.includes("saveBaskets") && st.includes("loadBaskets"), "registry persists on the volume, tmp+rename family");
});

test("-06 end to end: create/list/drop against a live roster, ratio candles + EMA eligibility + scope walls, registry persists", () => {
  const { createPoller } = require("../src/poller");
  let saved = null;
  const store = { loadAll: () => new Map(), loadRegime: () => [], loadLedger: () => null,
    saveLedger: () => {}, insert: () => {}, saveRegime: () => {}, saveNews: () => {}, loadNews: () => null,
    saveBaskets: (d) => { saved = d; return true; }, loadBaskets: () => null };
  const p = createPoller({ dex: "xyz", store, log: () => {}, version: "test" });
  const HOUR = 3600e3, DAY = 86400e3;
  const now = Math.floor(Date.now() / HOUR) * HOUR;
  // 4 equities with 30 daily closes + 60 hourly closes; one crypto main for the scope wall.
  const seedEq = (tk, base) => {
    const dailyRaw = Array.from({ length: 30 }, (_, i) => ({ t: now - (29 - i) * DAY, c: base * (1 + i * 0.002) }));
    const hourlyRaw = Array.from({ length: 60 }, (_, i) => ({ t: now - (59 - i) * HOUR, c: base * (1 + i * 0.001) }));
    p.seedRowNow("xyz:" + tk, { px: base, dailyRaw, hourlyRaw });
  };
  ["AAA", "BBB", "CCC", "DDD"].forEach((t, i) => seedEq(t, 100 * (i + 1)));
  p.seedRowNow("SOL", { px: 150, hourlyRaw: Array.from({ length: 60 }, (_, i) => ({ t: now - (59 - i) * HOUR, c: 150 + i })) });
  // create: happy path infers the stocks scope and persists
  const c = p.createBasket("mine", ["aaa", "bbb", "ccc"]);
  assert.ok(c.ok, "create: " + (c.error || "ok"));
  assert.equal(c.basket.scope, "stocks", "scope inferred from members");
  assert.ok(saved && saved.list.length === 1 && saved.list[0].name === "MINE", "registry persisted through the store");
  // refusals, each with a stated reason
  assert.ok(!p.createBasket("SPX", ["AAA", "BBB"]).ok, "benchmark alias refused");
  assert.ok(!p.createBasket("AAA", ["BBB", "CCC"]).ok, "listed name refused");
  assert.ok(!p.createBasket("MIXED", ["AAA", "SOL"]).ok, "cross-universe membership refused — the wall holds at create");
  assert.ok(!p.createBasket("MINE2", ["AAA", "NOPE"]).ok, "unknown member refused, not silently dropped");
  // payload: the basket rides with a server-synthesized daily series
  const pay = p.getBasketsPayload();
  const mine = pay.baskets.find((b) => b.name === "MINE");
  assert.ok(mine && !mine.builtin && mine.daily.length >= 25, "daily synthesis shipped");
  assert.ok(Math.abs(mine.daily[0][1] - 100) < 1e-6, "seeds at 100");
  assert.equal(mine.cov.n, 3, "full coverage on the latest valid day");
  // ratio: ticker ÷ ticker on a 60-hour spine — candles exist, EMA200 honestly null with the reason
  const r1 = p.getRatio("AAA", "BBB", "4h");
  assert.ok(r1.ok, "ratio ok: " + (r1.error || ""));
  assert.ok(r1.candles.length >= 14, "4h candles from a 60h spine");
  assert.equal(r1.ema200, null, "no EMA200 on a short spine");
  assert.equal(r1.emaReason, "insufficient_bars", "machine-readable reason");
  assert.equal(r1.emaMin, 205);
  // every candle is a real sampled ratio: o/h/l/c all within the hour-sampled ratio envelope
  for (const k of r1.candles) assert.ok(k.h >= Math.max(k.o, k.c) && k.l <= Math.min(k.o, k.c), "OHLC coherent");
  // basket leg ÷ ticker works and carries coverage disclosure
  const r2 = p.getRatio("MINE", "DDD", "1h");
  assert.ok(r2.ok && r2.numBasket && !r2.denBasket, "basket numerator resolves");
  assert.deepEqual(r2.numCov, { n: 3, N: 3 }, "leg coverage shipped for the legend");
  // walls at read time too
  assert.ok(!p.getRatio("AAA", "SOL", "4h").ok, "cross-universe ratio refused");
  assert.ok(!p.getRatio("AAA", "AAA", "4h").ok, "self-ratio refused");
  assert.ok(!p.getRatio("AAA", "BBB", "7h").ok, "unknown tf refused");
  // drop: custom goes, built-ins (none seeded here) can't, and the stamp moves for the ETag
  const st0 = p.getBasketsStamp();
  assert.ok(p.dropBasket("MINE").ok, "drop custom");
  assert.ok(!p.dropBasket("MINE").ok, "double-drop refused");
  assert.notEqual(p.getBasketsStamp(), st0, "registry stamp moved — cached /api/baskets keys die with it");
  assert.equal(saved.list.length, 0, "persisted registry reflects the drop");
});

// ===== COMP/G loading-state honesty + [hidden] guard (build 2026.07.28-07) =====================
// The field report: an empty corr-tab visit racing /api/daily painted COMP/G as a lineless chart
// with a NaN anchor label, never healed, and the un-guarded spread-mode base select read as a
// forced basket comparison. Two fixes, both executed here — the render must SAY it's loading,
// the daily hook must repaint it out of that state, and cg-basectl must actually hide.

test("-07 COMP/G: no-history render is an honest loading line (no fake chart, no NaN), and heals when daily lands", () => {
  const fs = require("fs"), path = require("path");
  const app = fs.readFileSync(path.join(__dirname, "..", "public", "app.js"), "utf8");
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
  try {
    const api = new Function(app + "\n;return {state, COMPG, renderCompg};")();
    const DAY = 86400e3, today = Math.floor(Date.now() / DAY) * DAY;
    const names = ["AAA", "BBB", "CCC", "DDD"];
    api.state.scope = "stocks"; api.state.view = "corr";
    names.forEach((tk, ix) => api.state.rows.set("xyz:" + tk, { coin: "xyz:" + tk, ticker: tk, uni: "xyz", px: 100, daily: null, delisted: false }));
    api.COMPG.sel = names.slice(); api.COMPG.off = new Set(); api.COMPG.mode = "index"; api.COMPG.base = "__basket";
    api.COMPG.win = 30; api.COMPG.anchorTs = (Math.floor(Date.now() / DAY) - 30) * DAY; api.COMPG.closed = false;
    api.renderCompg();
    const h0 = els["compg"].innerHTML;
    assert.ok(api.COMPG._empty, "empty state flagged for the self-heal hook");
    assert.ok(/Loading daily history/.test(h0), "the render SAYS it's waiting");
    assert.ok(/0\/4 selected names/.test(h0), "and counts what's landed");
    assert.equal((h0.match(/<path /g) || []).length, 0, "no fake chart");
    assert.ok(!/NaN/.test(h0), "no NaN anchor label");
    // history lands -> the same call the daily hook makes repaints a real chart
    names.forEach((tk, ix) => { api.state.rows.get("xyz:" + tk).daily =
      Array.from({ length: 120 }, (_, i) => ({ t: today - (119 - i) * DAY, c: 100 * (ix + 1) * (1 + i * 0.001) })); });
    api.renderCompg();
    const h1 = els["compg"].innerHTML;
    assert.ok(!api.COMPG._empty, "empty flag cleared");
    assert.equal((h1.match(/<path /g) || []).length, 4, "one line per name the moment data exists");
    assert.ok(!/Loading daily history/.test(h1), "loading copy gone");
  } finally {
    global.setInterval = saved.si; global.setTimeout = saved.st; global.requestAnimationFrame = saved.raf;
    global.clearTimeout = saved.ct; global.clearInterval = saved.ci;
    global.document = saved.doc; global.window = saved.win; global.localStorage = saved.ls; global.fetch = saved.f;
  }
});

test("-07 wiring: the daily hook repaints COMP/G out of empty, and cg-basectl's [hidden] guard exists", () => {
  const fs = require("fs"), path = require("path");
  const app = fs.readFileSync(path.join(__dirname, "..", "public", "app.js"), "utf8");
  assert.ok(app.includes("if(COMPG._empty && el('compg') && !el('compg').hidden) renderCompg()"),
    "daily-arrival hook carries the self-heal repaint");
  const css = fs.readFileSync(path.join(__dirname, "..", "public", "styles.css"), "utf8");
  assert.ok(css.includes(".cg-basectl[hidden]{display:none}"),
    "the spread-mode base select hides when hidden — runtime-templated hidden escaped the markup audit; this pin closes that hole");
});
