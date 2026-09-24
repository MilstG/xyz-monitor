"use strict";
// Accuracy corrections (build 2026.09.24-104): each test pins one measurement against the definition
// it must agree with — client vs server, one series vs its calendar, one baseline vs its session.
const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs"), path = require("path");
const C = require("../src/compute");
const DAY = 86400e3, HOUR = 3600e3;
const clientSrc = () => require("./_client").clientSource();
const grab = (src, name) => {
  const i = src.indexOf("function " + name + "("); assert.ok(i >= 0, name + " missing");
  let d = 0; for (let k = src.indexOf("{", i); k < src.length; k++) { if (src[k] === "{") d++; if (src[k] === "}") { d--; if (!d) return src.slice(i, k + 1); } }
};

// The client's session machinery (build -105) in a sandbox: core.js's session view + yzVol, corr.js's
// session returns, data.js's computeBeta; `sessOff` = the /api/daily calendar shape ({US: [days]}).
function clientSessApi(sessOff) {
  const src = clientSrc();
  const END = "return s2>0?Math.sqrt(s2*252)*100:null; }", a = src.indexOf("function sessionFold("), b = src.indexOf(END, a);
  assert.ok(a > 0 && b > a, "core.js session block");
  const core = src.slice(a, b + END.length);
  const state = { sessOff: null, sessOffV: 1 };
  if (sessOff) { state.sessOff = {}; for (const k in sessOff) state.sessOff[k] = new Set(sessOff[k]); }
  return new Function("DAY", "state", core + "\n" + grab(src, "sessReturns") + "\n" + grab(src, "sessBarsFor") + "\n" + grab(src, "computeBeta")
    + "; return { sessionFold, sessDaily, sessOffFor, closedDaily, yzVol, sessReturns, computeBeta };")(DAY, state);
}

// ---- 1. AMC reaction: the client scores the print day's own bar, exactly as the server does ----
test("-104 earnings reaction: client earnReactPct == server earnPrintReaction (daily) on BMO, AMC, Friday AMC, forming, missing bar", () => {
  const src = clientSrc();
  const clientRx = new Function("DAY", grab(src, "earnReactPct") + "; return earnReactPct;")(DAY);
  // A spine of UTC-day bars, weekends included (the perp trades 24/7): 2026-07-20 (Mon) .. 2026-08-02.
  const d0 = Date.UTC(2026, 6, 20);
  const closes = [100, 101, 102, 103, 104, 124.8, 125, 126, 127, 128, 129, 130, 131, 132];   // the +20% sits on the 07-25 (Sat) bar
  const daily = closes.map((c, i) => ({ t: d0 + i * DAY, c }));
  const dstr = (t) => new Date(t).toISOString().slice(0, 10);
  const now = d0 + 14 * DAY + 5 * HOUR;
  const cases = [
    { t: "BMO", s: "BMO", d: dstr(d0 + 2 * DAY) },
    { t: "AMC", s: "AMC", d: dstr(d0 + 5 * DAY) },       // Sat 07-25 carries the +20%: the print day's own bar
    { t: "FRI", s: "AMC", d: dstr(d0 + 4 * DAY) },       // Friday 07-24 AMC: its own UTC bar (closes 00:00Z Sat) holds the reaction
    { t: "TBD", s: "TBD", d: dstr(d0 + 9 * DAY) },
  ];
  for (const e of cases) {
    const srv = C.earnPrintReaction(e, daily, 131.5, null, now), cli = clientRx(e, daily, 131.5, now);
    assert.deepEqual(cli, srv, "parity " + e.t + " " + JSON.stringify({ srv, cli }));
    assert.equal(srv.state, "final");
  }
  assert.equal(C.earnPrintReaction(cases[1], daily, 131.5, null, now).pct, 20, "the +20% AMC pop reads +20%, not the next day's drift");
  // Forming: the print day's bar is still open -> live mark vs the last close before the print.
  const nowF = d0 + 13 * DAY + 3 * HOUR, fe = { t: "F", s: "AMC", d: dstr(d0 + 13 * DAY) };
  assert.deepEqual(clientRx(fe, daily, 135, nowF), C.earnPrintReaction(fe, daily, 135, null, nowF));
  assert.equal(clientRx(fe, daily, 135, nowF).state, "forming");
  // The print day's bar not on the spine yet (series ends yesterday): still measured, against the mark.
  const short = daily.slice(0, 13), ne = { t: "N", s: "AMC", d: dstr(d0 + 13 * DAY) };
  assert.deepEqual(clientRx(ne, short, 140, nowF), C.earnPrintReaction(ne, short, 140, null, nowF));
  // Client daily rows carry string closes on the wire; the port parses them.
  const strRows = daily.map((k) => ({ t: k.t, c: String(k.c) }));
  assert.deepEqual(clientRx(cases[1], strRows, 131.5, now), C.earnPrintReaction(cases[1], daily, 131.5, null, now));
  assert.ok(!/e\.s==='AMC'\?pi\+1:pi/.test(src), "the next-bar AMC rule is gone from the client");
});

// ---- 2. Backtest annualization: the series' own periods per year ----
test("-104 backtest: annualization is the observed periods/yr of a UTC-day spine (≈365), crypto 365; Sharpe scales with it", () => {
  const src = clientSrc();
  const state = { scope: "stocks" };
  const api = new Function("state", "const BT_ANN_UTC=365;\n" + grab(src, "btPeriodsPerYear") + "\n" + grab(src, "btAnn") + "\n" + grab(src, "btStats") + "; return {btPeriodsPerYear,btAnn,btStats};")(state);
  const days = Array.from({ length: 366 }, (_, i) => 20000 + i);             // a year of UTC days, weekends included
  assert.ok(Math.abs(api.btAnn(days) - 365.25) < 1e-9, "one bar a calendar day annualizes at ~365, not 252: " + api.btAnn(days));
  const wk = days.filter((d) => ((d + 4) % 7) !== 0 && ((d + 4) % 7) !== 6); // a weekday-only spine would read ~261
  assert.ok(Math.abs(api.btAnn(wk) - 261) < 2, "a weekday spine reads its own ~261: " + api.btAnn(wk));
  assert.equal(api.btAnn([1]), 365, "too short to observe: the UTC-day fallback");
  state.scope = "crypto"; assert.equal(api.btAnn(wk), 365, "crypto stays 365"); state.scope = "stocks";
  const r = [0.01, -0.005, 0.007, 0.002, -0.001], eq = [1]; for (const x of r) eq.push(eq[eq.length - 1] * (1 + x));
  const s365 = api.btStats(r, eq, api.btAnn(days)).sharpe, s252 = api.btStats(r, eq, 252).sharpe;
  assert.ok(Math.abs(s365 / s252 - Math.sqrt(365.25 / 252)) < 1e-9, "the old √252 understated Sharpe by √(365/252) ≈ 1.2×");
  assert.ok(src.includes("clamp(BT_VOLTGT/(v*Math.sqrt(btAnn(days))),0.25,2)"), "the vol target sizes with the same annualization");
  assert.ok(src.includes("const ann=btAnn(res.days);"), "the stat boxes annualize by the curve's own spine");
  assert.ok(!/BT_ANN=252/.test(src), "no 252 left");
});

// ---- 3. AI beta: date-aligned, one definition with the board ----
test("-104 beta: compute.dailyBeta == the board's computeBeta on closed bars; keyed by day (a missing bar shifts nothing); forming bar dropped", () => {
  const src = clientSrc();
  const nowD = Date.UTC(2026, 8, 24), now = nowD + 10 * HOUR;
  // Deterministic pseudo-random benchmark returns; the asset is 1.5x the bench + small noise.
  let seed = 7; const rnd = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647 - 0.5; };
  const N = 120, bRows = [], aRows = []; let pb = 100, pa = 50;
  for (let i = 0; i < N; i++) {
    const t = nowD - (N - i) * DAY, rb = rnd() * 0.02, ra = 1.5 * rb + rnd() * 0.002;
    pb *= Math.exp(rb); pa *= Math.exp(ra); bRows.push({ t, c: pb }); aRows.push({ t, c: pa });
  }
  const clientBeta = (A, B) => clientSessApi().computeBeta(
    { daily: A.map((k) => ({ t: k.t, c: String(k.c) })) }, { daily: B.map((k) => ({ t: k.t, c: String(k.c) })) }, 90);
  const RealNow = Date.now; Date.now = () => now;
  let cli; try { cli = clientBeta(aRows, bRows); } finally { Date.now = RealNow; }
  const srv = C.dailyBeta(aRows, bRows, { days: 90, now });
  assert.ok(Math.abs(cli.beta - srv.beta) < 1e-12 && Math.abs(cli.r2 - srv.r2) < 1e-12, "parity: " + JSON.stringify({ cli, srv }));
  assert.ok(Math.abs(srv.beta - 1.5) < 0.05, "recovers the true beta: " + srv.beta);
  // Drop one mid-series bar from the ASSET only: by index every later pair would shift a day.
  const holed = aRows.filter((_, i) => i !== 80);
  const hb = C.dailyBeta(holed, bRows, { days: 90, now });
  assert.ok(Math.abs(hb.beta - 1.5) < 0.1, "a hole costs a pair, not the alignment: " + hb.beta);
  let idx;   // the retired index-paired simple-return beta, for contrast
  { const ca = holed.map((k) => k.c), cb = bRows.map((k) => k.c), n = Math.min(ca.length, cb.length, 61), ra = [], rb = [];
    for (let i = 1; i < n; i++) { ra.push(ca[ca.length - n + i] / ca[ca.length - n + i - 1] - 1); rb.push(cb[cb.length - n + i] / cb[cb.length - n + i - 1] - 1); }
    const ma = ra.reduce((a, x) => a + x, 0) / ra.length, mb = rb.reduce((a, x) => a + x, 0) / rb.length; let cv = 0, vb = 0;
    for (let i = 0; i < ra.length; i++) { cv += (ra[i] - ma) * (rb[i] - mb); vb += (rb[i] - mb) ** 2; } idx = cv / vb; }
  assert.ok(Math.abs(idx - 1.5) > 0.3, "the index pairing was genuinely wrong on a holed series: " + idx);
  // A forming bar (t + DAY > now) never enters.
  const form = aRows.concat([{ t: nowD, c: pa * 1.5 }]), formB = bRows.concat([{ t: nowD, c: pb * 0.9 }]);
  assert.deepEqual(C.dailyBeta(form, formB, { days: 90, now }), srv, "the open day's partial return is dropped");
  assert.equal(C.dailyBeta(aRows.slice(-10), bRows.slice(-10), { now }), null, "< 20 pairs: null");
  const pol = fs.readFileSync(path.join(__dirname, "..", "src", "poller.js"), "utf8");
  assert.ok(pol.includes("dailyBeta(sessFoldOf(r, daily), sessFoldOf(b, b.dailyRaw), { days: 90, now })") && !pol.includes("closes[closes.length - n + i - 1]"), "the AI context uses the shared beta");
});

// ---- 4. Holidays and early closes in the earnings session machinery ----
test("-104 earnings sessions: holidays skip like weekends; AMC anchors at the actual (early) close", () => {
  const etNoon = (y, mo, d) => C.etWallToUtc(y, mo, d, 12, 0);
  // Thanksgiving week 2026: Mon 11-23 -> Mon 11-30. Tue, Wed, [Thu 11-26 closed], Fri 11-27 (half day), [Sat, Sun], Mon = 4.
  assert.equal(C.earnSessionsAhead("2026-11-30", etNoon(2026, 11, 23)), 4, "Thanksgiving is not a session; the half day is");
  assert.equal(C.earnSessionsAhead("2026-11-27", etNoon(2026, 11, 25)), 1, "Wed -> Fri over Thanksgiving is one session");
  // July 2026: Jul 4 is a Saturday, observed Fri Jul 3 (closed). Wed 07-01 -> Mon 07-06: Thu = 1, Mon = 2.
  assert.equal(C.earnSessionsAhead("2026-07-06", etNoon(2026, 7, 1)), 2, "observed Independence Day skipped");
  assert.equal(C.earnSessionsAhead("2026-09-28", etNoon(2026, 9, 24)), 2, "an ordinary week is unchanged (Fri, Mon)");
  // AMC anchor: 13:00 ET on a half day, 16:00 otherwise.
  const at = (d) => C.etParts(C.earnPrintUtc({ d, s: "AMC" }));
  assert.equal(at("2026-11-27").h, 13, "Friday after Thanksgiving closes 13:00 ET");
  assert.equal(at("2025-07-03").h, 13, "Jul 3 2025 (Jul 4 a Friday) is a half day");
  assert.equal(at("2026-12-24").h, 13, "Christmas Eve on a weekday");
  assert.equal(at("2026-11-25").h, 16, "the day before Thanksgiving is a full day");
  assert.equal(C.etParts(C.earnPrintUtc({ d: "2026-11-27", s: "AMC" }, { amcHour: 16 })).h, 16, "an explicit amcHour still wins");
  const readme = fs.readFileSync(path.join(__dirname, "..", "README.md"), "utf8");
  assert.ok(!/exchange holidays are not\s+modeled/.test(readme), "the README caveat is gone");
});

// ---- 5. Call targets: session-true deadline and touch rule (pure halves; the sweep is in accounts.test.js) ----
test("-104 call targets: callTargetDeadline ends a date at its cash close; callBarReaches judges off-hours by the close", () => {
  const now = Date.UTC(2026, 8, 24, 12);
  const et = (t) => C.etParts(t);
  const oct15 = C.callTargetDeadline("2026-10-15", true, now);
  assert.deepEqual([et(oct15).mo, et(oct15).d, et(oct15).h, et(oct15).mi], [10, 15, 16, 0], "Thu Oct 15: 16:00 ET");
  const half = C.callTargetDeadline("2026-11-27", true, now);
  assert.deepEqual([et(half).d, et(half).h], [27, 13], "the Friday after Thanksgiving: 13:00 ET");
  const tg = C.callTargetDeadline("2026-11-26", true, now);
  assert.deepEqual([et(tg).d, et(tg).h], [25, 16], "Thanksgiving itself: the last close before it (Wed 16:00)");
  const sat = C.callTargetDeadline("2026-10-17", true, now);
  assert.deepEqual([et(sat).d, et(sat).h], [16, 16], "a Saturday: Friday's close");
  assert.equal(C.callTargetDeadline("2026-10-15", false, now), Date.UTC(2026, 9, 16), "crypto: 24:00 UTC");
  assert.equal(C.callTargetDeadline("2026-09-24", true, Date.UTC(2026, 8, 24, 21)), null, "a close already passed: the caller keeps its horizon");
  assert.equal(C.callTargetDeadline(null, true, now), null);
  // callTarget names the date for dated words only.
  const T = (t) => C.callTarget(t, "HOOD", 100, now);
  assert.equal(T("$HOOD to 120 by Oct 15").byDay, "2026-10-15");
  assert.equal(T("$HOOD to 120 by 2026-10-15").byDay, "2026-10-15");
  assert.equal(T("$HOOD to 120 by friday").byDay, "2026-09-25");
  assert.equal(T("$HOOD to 120 eom").byDay, "2026-09-30");
  assert.equal(T("$HOOD to 120 in 3w").byDay, null, "a relative horizon names no date");
  // The touch rule.
  const ses = C.marketSessions(Date.UTC(2026, 8, 24), Date.UTC(2026, 8, 25));
  const inS = C.etWallToUtc(2026, 9, 24, 10, 0), off = C.etWallToUtc(2026, 9, 24, 20, 0);
  assert.equal(C.callBarReaches([inS, 100, 121, 99, 105], 120, true, true, ses), true, "in session: a touch counts");
  assert.equal(C.callBarReaches([off, 100, 121, 99, 105], 120, true, true, ses), false, "off-hours: a wick does not");
  assert.equal(C.callBarReaches([off, 100, 121, 99, 120.5], 120, true, true, ses), true, "off-hours: a close through does");
  assert.equal(C.callBarReaches([off, 100, 101, 79, 85], 80, false, true, ses), false, "a stop below: off-hours wick is not wrong");
  assert.equal(C.callBarReaches([off, 100, 101, 79, 79.5], 80, false, true, ses), true, "…a close through it is");
  assert.equal(C.callBarReaches([off, 100, 121, 99, 105], 120, true, false, ses), true, "crypto: any touch");
  const readme = fs.readFileSync(path.join(__dirname, "..", "README.md"), "utf8");
  assert.ok(/16:00 ET cash\s+close/.test(readme) && /close through/.test(readme) && !/a one-bar wick through the level is a hit/.test(readme), "the README states the rule");
});

// ---- 6. Premium z: per-session robust baselines ----
test("-104 premium z: cash-open and cash-closed samples keep separate median/MAD baselines; thin buckets pool", () => {
  // Seven days of 10-min samples ending Thu 2026-09-24 22:00Z: in session the premium hugs 0 (±2bp),
  // off-hours it swings around +15 (±10bp).
  const end = Date.UTC(2026, 8, 24, 22), start = end - 7 * DAY;
  const ses = C.marketSessions(start, end), isOpen = (t) => ses.some((s) => t >= s.open && t < s.close);
  const samples = []; let k = 0;
  for (let t = start; t <= end; t += 10 * 60e3) { k++; const w = Math.sin(k * 1.7); samples.push([t, isOpen(t) ? 2 * w : 15 + 10 * w]); }
  const openNow = C.etWallToUtc(2026, 9, 24, 11, 0), closedNow = end;
  const bo = C.premSessionBaseline(samples, openNow, { sessionRule: true });
  const bc = C.premSessionBaseline(samples, closedNow, { sessionRule: true });
  const bp = C.premSessionBaseline(samples, closedNow, { sessionRule: false });
  assert.equal(bo.bucket, "open"); assert.equal(bc.bucket, "closed"); assert.equal(bp.bucket, "pooled");
  assert.ok(Math.abs(bo.m) < 0.5 && bo.sd < 3.5, "the session baseline is the quiet one: " + JSON.stringify(bo));
  assert.ok(Math.abs(bc.m - 15) < 1.5 && bc.sd > 8, "the off-hours baseline is the wide one: " + JSON.stringify(bc));
  // +20bp: extreme in session, ordinary off-hours — the pooled z sits between and misreads both.
  const z = (b, v) => (v - b.m) / b.sd;
  assert.ok(z(bo, 20) > 6 && z(bc, 20) < 1, JSON.stringify({ zo: z(bo, 20), zc: z(bc, 20), zp: z(bp, 20) }));
  // Median/MAD: a burst of dislocations inside the window barely moves the robust centre.
  const spiked = samples.map((x, i) => (i % 25 === 0 ? [x[0], 400] : x));
  const bs = C.premSessionBaseline(spiked, closedNow, { sessionRule: true });
  assert.ok(Math.abs(bs.m - bc.m) < 2, "robust to the outliers it scores: " + JSON.stringify({ bs, bc }));
  // A thin current bucket falls back to pooled; too few samples overall is null.
  const fewOpen = samples.filter((x) => !isOpen(x[0]) || x[0] > end - DAY / 4);
  assert.equal(C.premSessionBaseline(fewOpen, openNow + DAY * 0, { sessionRule: true, minBucket: 5000 }).bucket, "pooled");
  assert.equal(C.premSessionBaseline(samples.slice(0, 50), closedNow, { sessionRule: true }), null);
  const pol = fs.readFileSync(path.join(__dirname, "..", "src", "poller.js"), "utf8");
  assert.ok(pol.includes("premSessionBaseline(r.premH,"), "the poller's premBaseline delegates");
});

// ---- 7. vs cash close ----
test("-104 vs cash close: the column reads the mark vs the last US cash close; RS twin vs the S&P; 24h untouched; hidden by default", () => {
  const src = clientSrc();
  const vcc = new Function(grab(src, "vsCashClose") + "; return vsCashClose;")();
  assert.equal(vcc({ uni: "xyz", px: 105, cashClose: { t: 1, px: 100 } }), 5.000000000000004);
  assert.equal(vcc({ uni: "main", px: 105, cashClose: { t: 1, px: 100 } }), undefined, "crypto has no cash close");
  assert.equal(vcc({ uni: "xyz", hm: "KR", px: 105, cashClose: { t: 1, px: 100 } }), undefined, "a foreign-home name's close is not the US one");
  assert.equal(vcc({ uni: "xyz", px: 105, cashClose: null }), undefined);
  assert.ok(/\{key:'vcc', label:'vs close'/.test(src) && /\{key:'rscc', label:'vs S&P \(close\)'/.test(src), "columns defined");
  const hid = src.match(/const DEFAULT_HIDDEN=\[[^\]]*\]/)[0];
  assert.ok(hid.includes("'vcc'") && hid.includes("'rscc'"), "hidden by default");
  assert.ok(src.includes("const XYZ_ONLY_COLS=new Set(['gap','vcc','rscc']);"), "stocks scope only");
  assert.ok(src.includes("r.rscc=(r.vcc==null||!state.benchCoin||r.uni==='main')?undefined:(r.coin===state.benchCoin?0:(bXcc!=null?r.vcc-bXcc:undefined));"), "RS twin vs the S&P's own vs-close move");
  assert.ok(/\{key:'d1', label:'24h', type:'num', tip:'Rolling 24-hour change: live mark vs Hyperliquid\\u2019s prevDayPx/.test(src), "24h keeps its meaning");
  const pol = fs.readFileSync(path.join(__dirname, "..", "src", "poller.js"), "utf8");
  assert.ok(pol.includes("cashClose[r.coin] = [lastCash.close, +pc.toFixed(8)]") && pol.includes("liveClose, cashClose, oi, sessOff };"), "the server ships the last US cash close on /api/daily");
});

// ===== build 2026.09.24-105: the US-session daily series ==========================================
// One definition (compute.sessionFold, client twin core.js sessionFold): the UTC bar for trading day
// D is D's session bar; weekend / exchange-holiday bars fold into the next session bar; a fold still
// waiting for its session is a forming bar keyed at that session's date.
const US = () => C.sessOffFn("US");
const dIdx = (y, mo, d) => Math.floor(Date.UTC(y, mo - 1, d) / DAY);
const bar = (y, mo, d, c, extra) => Object.assign({ t: Date.UTC(y, mo - 1, d), c }, extra || {});

test("-105 session fold: a weekend folds into Monday (h max, l min, o first, c Monday's, v summed, tl all-true); crypto is untouched", () => {
  // Thu 2026-09-17 .. Tue 2026-09-22
  const bars = [
    bar(2026, 9, 17, 100, { o: 99, h: 101, l: 98, v: 10, tl: true }),
    bar(2026, 9, 18, 102, { o: 100, h: 103, l: 99, v: 11, tl: true }),   // Fri
    bar(2026, 9, 19, 97, { o: 102, h: 104, l: 95, v: 3, tl: true }),     // Sat: the weekend's high AND low
    bar(2026, 9, 20, 99, { o: 97, h: 100, l: 96, v: 2, tl: true }),      // Sun
    bar(2026, 9, 21, 101, { o: 99, h: 102, l: 98, v: 12, tl: true }),    // Mon
    bar(2026, 9, 22, 103, { o: 101, h: 103.5, l: 100, v: 9, tl: true }), // Tue
  ];
  const s = C.sessionFold(bars, US());
  assert.deepEqual(s.map((b) => new Date(b.t).toISOString().slice(0, 10)), ["2026-09-17", "2026-09-18", "2026-09-21", "2026-09-22"], "sessions only, keyed by their own UTC day");
  const mon = s[2];
  assert.deepEqual({ o: mon.o, h: mon.h, l: mon.l, c: mon.c, v: mon.v, tl: mon.tl, n: mon.n }, { o: 102, h: 104, l: 95, c: 101, v: 17, tl: true, n: 3 }, "Monday's bar carries the weekend's extremes and volume");
  // the Friday -> Monday session return is the whole weekend + Monday move, nothing lost
  assert.ok(Math.abs(Math.log(mon.c / s[1].c) - (Math.log(97 / 102) + Math.log(99 / 97) + Math.log(101 / 99))) < 1e-12);
  // a bar without a true low taints the fold's tl
  const noL = bars.map((b, i) => (i === 3 ? { t: b.t, c: b.c, h: b.h } : b));
  assert.equal(C.sessionFold(noL, US())[2].tl, false);
  assert.equal(C.sessionFold(bars, null), bars, "no calendar (crypto): the input array itself");
  // forming: it is Sunday — the Sat/Sun fold is Monday's forming bar, keyed at Monday, trimmed by the closed-bar rules
  const f = C.sessionFold(bars.slice(0, 4), US()), last = f[f.length - 1];
  assert.equal(last.f, 1); assert.equal(last.t, Date.UTC(2026, 8, 21)); assert.equal(last.c, 99);
  assert.equal(C.closedBars(f, DAY, Date.UTC(2026, 8, 20, 15)).length, 2, "the forming fold never reaches a closed-bar consumer");
  // tuples: the signal loop's shape round-trips
  const tup = C.sessionTuples(bars.map((b) => [b.t, b.c, b.h, b.v, b.l]), US());
  assert.deepEqual(tup[2].slice(0, 5), [Date.UTC(2026, 8, 21), 101, 104, 17, 95]);
});

test("-105 session fold: exchange holidays fold like weekends (Good Friday, Thanksgiving); half days stay sessions; a foreign-home calendar is its own", () => {
  // Good Friday 2026-04-03: Thu 04-02 | Fri(closed) Sat Sun -> Mon 04-06
  const gf = [bar(2026, 4, 2, 100), bar(2026, 4, 3, 90), bar(2026, 4, 4, 91), bar(2026, 4, 5, 92), bar(2026, 4, 6, 95)];
  const s = C.sessionFold(gf, US());
  assert.equal(s.length, 2); assert.equal(s[1].t, Date.UTC(2026, 3, 6)); assert.equal(s[1].n, 4); assert.equal(s[1].l, 90, "the holiday's close is inside Monday's range");
  // Thanksgiving 2026-11-26 folds into the Friday half day (a session)
  const tg = [bar(2026, 11, 25, 100), bar(2026, 11, 26, 101), bar(2026, 11, 27, 102)];
  assert.deepEqual(C.sessionFold(tg, US()).map((b) => [new Date(b.t).getUTCDate(), b.n]), [[25, 1], [27, 2]]);
  // KRX Chuseok 2026-09-24/25 is closed in Seoul but a US session
  const ch = [bar(2026, 9, 23, 1), bar(2026, 9, 24, 2), bar(2026, 9, 25, 3), bar(2026, 9, 28, 4)];
  assert.equal(C.sessionFold(ch, C.sessOffFn("KR")).length, 2, "KR folds Chuseok");
  assert.equal(C.sessionFold(ch, US()).length, 4, "the US trades it");
  // the wire calendar: ~104 weekend days + ~10 holidays a year
  const off = C.sessOffDays("US", dIdx(2026, 1, 1), dIdx(2026, 12, 31));
  assert.ok(off.length >= 110 && off.length <= 116, "2026 US off-days: " + off.length);
  assert.ok(off.includes(dIdx(2026, 4, 3)) && off.includes(dIdx(2026, 7, 3)) && !off.includes(dIdx(2026, 11, 27)));
});

test("-105 session fold parity: the client twin folds identically on the server's shipped calendar (weekends, holidays, forming tail, strings, gaps)", () => {
  const api = clientSessApi();
  const cal = C.sessOffDays("US", dIdx(2026, 3, 20), dIdx(2026, 4, 30));
  const S = new Set(cal), off = (d) => S.has(d);
  let seed = 3; const rnd = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647; };
  const bars = []; let p = 100;
  for (let d = dIdx(2026, 3, 20); d <= dIdx(2026, 4, 11); d++) {
    if (d === dIdx(2026, 3, 31)) continue;   // a hole in the feed
    p *= Math.exp((rnd() - 0.5) * 0.04);
    const b = { t: d * DAY, c: String(p), h: p * (1 + rnd() * 0.02), l: p * (1 - rnd() * 0.02), v: rnd() * 100 };
    if (d % 5 === 0) delete b.l;   // some closes-only bars
    bars.push(b);
  }
  const srv = C.sessionFold(bars, C.sessOffFn("US")), cli = api.sessionFold(bars, off);
  assert.deepEqual(JSON.parse(JSON.stringify(cli)), JSON.parse(JSON.stringify(srv)), "byte-identical fold");
  assert.equal(srv[srv.length - 1].f, 1, "the fixture ends on a Saturday: a forming fold");
});

test("-105 correlation: session returns (forming dropped), the n<10 floor, Fisher-z CI shading, shrinkage for the order only; β parity on sessions", () => {
  const src = clientSrc();
  const api = new Function("DAY", grab(src, "corrSig") + "\n" + grab(src, "corrCI") + "; return { corrSig, corrCI };")(DAY);
  // |atanh r|·√(n−3) vs 1.96: r = .5 is noise at n = 10 and real at n = 20
  const C2 = [[1, 0.5, 0.5], [0.5, 1, 0.2], [0.5, 0.2, 1]], N2 = [[0, 10, 20], [10, 0, 200], [20, 200, 0]];
  const sg = api.corrSig(C2, N2);
  assert.equal(sg.NS[0][1], 1, "r=.5, n=10: CI spans 0 -> faded");
  assert.equal(sg.NS[0][2], 0, "r=.5, n=20: significant");
  assert.equal(sg.NS[1][2], 0, "r=.2, n=200: significant");
  const ci = api.corrCI(0.5, 10); assert.ok(ci[0] < 0 && ci[1] > 0.8, JSON.stringify(ci));
  const ci2 = api.corrCI(0.5, 20); assert.ok(ci2[0] > 0, JSON.stringify(ci2));
  assert.ok(sg.delta > 0 && sg.delta < 1, "a Ledoit-Wolf-style intensity: " + sg.delta);
  const rb = (0.5 + 0.5 + 0.2) / 3;
  assert.ok(Math.abs(sg.Cs[0][1] - ((1 - sg.delta) * 0.5 + sg.delta * rb)) < 1e-12, "shrunk toward the average correlation");
  assert.equal(C2[0][1], 0.5, "the displayed matrix is untouched");
  assert.ok(src.includes("const ord=corrOrder(C, opts.shr)") && src.includes("paintCorr(rows, res.C, res.N, { ns:res.NS, shr:res.Cs, minOv:res.minOv });"), "the order clusters Cs; the cells paint raw C");
  assert.ok(src.includes("const CORR_MIN_OV=10;") && src.includes("table.cmx td.ns{opacity:.38}") === false, "floor constant in corr.js (styles live in styles.css)");
  const css = fs.readFileSync(path.join(__dirname, "..", "public", "styles.css"), "utf8");
  assert.ok(css.includes("table.cmx td.ns{opacity:.38}") && css.includes("table.cmx td.lown"), "faded + n<10 cell styles");
  // β parity on a weekend-bearing tape, calendar shipped: server fold + dailyBeta == client sessReturns + computeBeta
  const nowD = Date.UTC(2026, 8, 24), now = nowD + 10 * HOUR;
  let seed = 11; const rnd = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647 - 0.5; };
  const aR = [], bR = []; let pa = 50, pb = 100;
  for (let i = 160; i >= 0; i--) { const t = nowD - i * DAY, rb2 = rnd() * 0.02; pb *= Math.exp(rb2); pa *= Math.exp(1.3 * rb2 + rnd() * 0.003); aR.push({ t, c: pa }); bR.push({ t, c: pb }); }
  const cal = { US: C.sessOffDays("US", Math.floor(aR[0].t / DAY), Math.floor(nowD / DAY) + 14) };
  const cApi = clientSessApi(cal);
  const RealNow = Date.now; Date.now = () => now;
  let cli; try { cli = cApi.computeBeta({ uni: "xyz", daily: aR }, { uni: "xyz", daily: bR }, 90); } finally { Date.now = RealNow; }
  const srv = C.dailyBeta(C.sessionFold(aR, US()), C.sessionFold(bR, US()), { days: 90, now });
  assert.ok(Math.abs(cli.beta - srv.beta) < 1e-12 && Math.abs(cli.r2 - srv.r2) < 1e-12, JSON.stringify({ cli, srv }));
  assert.ok(srv.n >= 58 && srv.n <= 66, "90 calendar days hold ~63 session returns, not 90: " + srv.n);
});

test("-105 Yang-Zhang: closed form on a constant-range series, the missing-low refusal, and the open = prior close convention", () => {
  const api = clientSessApi();
  // every session: prior close 100, open 100, high 101, low 99, close 100 -> o = c = 0, rs = ln²(1.01) + ln²(0.99)
  const bars = Array.from({ length: 21 }, (_, i) => ({ t: i * DAY, o: 100, h: 101, l: 99, c: 100, tl: true }));
  const n = 20, k = 0.34 / (1.34 + (n + 1) / (n - 1)), rs = Math.log(1.01) ** 2 + Math.log(0.99) ** 2;
  const want = Math.sqrt((1 - k) * rs * 252) * 100;
  assert.ok(Math.abs(api.yzVol(bars, 20) - want) < 1e-9, api.yzVol(bars, 20) + " vs " + want);
  // no opens: the prior close stands in — identical here, since the perp opens where it closed
  assert.ok(Math.abs(api.yzVol(bars.map(({ o, ...b }) => b), 20) - want) < 1e-9);
  // a close-to-close move lands in the k·var(c) term: alternate ±1% closes, zero range beyond them
  const alt = [{ t: 0, c: 100, h: 100, l: 100, tl: true }];
  for (let i = 1; i <= 20; i++) { const pc = alt[i - 1].c, c = i % 2 ? pc * 1.01 : pc / 1.01; alt.push({ t: i * DAY, c, h: Math.max(pc, c), l: Math.min(pc, c), tl: true }); }
  const cs = alt.slice(1).map((b, i) => Math.log(b.c / alt[i].c)), m = cs.reduce((a, x) => a + x, 0) / 20, vc = cs.reduce((a, x) => a + (x - m) ** 2, 0) / 19;
  const rsA = alt.slice(1).reduce((a, b, i) => { const o = alt[i].c, h = b.h, l = b.l, c = b.c; return a + Math.log(h / c) * Math.log(h / o) + Math.log(l / c) * Math.log(l / o); }, 0) / 20;
  assert.ok(Math.abs(api.yzVol(alt, 20) - Math.sqrt((k * vc + (1 - k) * rsA) * 252) * 100) < 1e-9);
  // one bar without a true low: refused (the board falls back to close-to-close, labelled)
  const holed = bars.map((b, i) => (i === 7 ? Object.assign({}, b, { tl: false }) : b));
  assert.equal(api.yzVol(holed, 20), null);
  assert.equal(api.yzVol(bars.slice(0, 20), 20), null, "needs n+1 bars");
  const src = clientSrc();
  assert.ok(src.includes("const cl=closedDaily(ses); if(cl.length>=21){ v=yzVol(cl,20); est='YZ';"), "the Vol column runs YZ over 20 CLOSED session bars");
  assert.ok(src.includes("v=stdev(rt)*Math.sqrt(252)*100; est='c2c';"), "labelled close-to-close fallback");
  assert.ok(src.includes("r.carry=(r._carryF!=null&&r.vol30!=null&&isFinite(r.vol30)&&r.vol30>5)?r._carryF/r.vol30:undefined;"), "carry divides by whichever vol the column shows");
});

test("-105 MA200 = 200 sessions (server sma200Of, client MAs), daily σ/ADR per session, forming hour out of volH", () => {
  const { createPoller } = require("../src/poller");
  const store = { loadAll: () => new Map(), loadRegime: () => [], loadLedger: () => null, saveLedger: () => {}, insert: () => {}, saveRegime: () => {} };
  const p = createPoller({ dex: "xyz", store, log: () => {}, version: "test", crypto: true });
  const d0 = dIdx(2025, 6, 2), raw = [];
  for (let i = 0; i < 330; i++) raw.push({ t: (d0 + i) * DAY, c: 100 + i });   // close = 100 + day offset
  p.seedRowNow("xyz:MA", { ticker: "MA", px: 400, uni: "xyz", ref: { p1h: 1, p4h: 1, p7d: 1, p30d: 1 }, dailyRaw: raw });
  p.seedRowNow("ETH", { ticker: "ETH", px: 400, uni: "main", ref: { p1h: 1, p4h: 1, p7d: 1, p30d: 1 }, dailyRaw: raw });
  p.buildSnapshotNow();
  const row = (c) => p.getSnapshot().markets.concat(p.getSnapshot().mainMarkets || []).find((r) => r.coin === c);
  const off = US(), sess = C.sessionFold(raw, off);
  const want = sess.slice(-200).reduce((a, b) => a + b.c, 0) / 200;
  assert.ok(Math.abs(row("xyz:MA").ma200 - want) < 1e-6, "the last 200 SESSION closes: " + row("xyz:MA").ma200 + " vs " + want);
  const cal200 = raw.slice(-200).reduce((a, b) => a + b.c, 0) / 200;
  assert.ok(row("xyz:MA").ma200 < cal200 - 20, "200 sessions reach ~90 calendar days further back than 200 UTC bars");
  assert.ok(Math.abs(row("ETH").ma200 - cal200) < 1e-6, "crypto keeps 200 calendar days");
  const src = clientSrc();
  assert.ok(src.includes("{ const cl=sessDaily(r); let m=null;"), "the board's MA20/50/100/200 read the session view");
  // featuresFromHourly: a flat weekend no longer dilutes the per-session σ or range
  const now = Date.UTC(2026, 8, 24, 12), H = [];
  let px = 100;
  for (let t = now - 30 * DAY; t < now; t += HOUR) {
    const wd = new Date(t).getUTCDay(), flat = wd === 0 || wd === 6;
    const c = flat ? px : px * (1 + (Math.floor(t / DAY) % 2 ? 0.0012 : -0.001));
    H.push({ t, o: px, h: Math.max(px, c) * (flat ? 1 : 1.001), l: Math.min(px, c) * (flat ? 1 : 0.999), c, v: 1 }); px = c;
  }
  const cal = C.featuresFromHourly(H, now, HOUR, DAY).feat, ses = C.featuresFromHourly(H, now, HOUR, DAY, off).feat;
  assert.ok(ses.dr.length < cal.dr.length && ses.dr.length >= 19, "one range per completed session: " + ses.dr.length);
  const mean = (a) => a.reduce((x, y) => x + y, 0) / a.length;
  assert.ok(mean(ses.dr) > mean(cal.dr), "no near-zero weekend ranges in the average");
  assert.ok(ses.volD > cal.volD, "no near-zero weekend returns deflating the daily σ");
  // the forming hour: an absurd last print moves nothing
  const spiked = H.concat([{ t: now - HOUR / 2, o: px, h: px * 2, l: px, c: px * 2, v: 1 }]);
  assert.equal(C.featuresFromHourly(spiked, now, HOUR, DAY).feat.volH, C.featuresFromHourly(H, now, HOUR, DAY).feat.volH, "volH excludes the still-open hour");
});

test("-105 true lows: the candle's low is kept (numeric), shipped as tuple column 4, persisted, and a pre--105 warm file falls back flagged", () => {
  const { createPoller } = require("../src/poller");
  const mkStore = (loadFeatures) => ({ loadAll: () => new Map(), loadRegime: () => [], loadLedger: () => null, saveLedger: () => {}, insert: () => {}, saveRegime: () => {}, loadFeatures: loadFeatures || (() => null) });
  const now = Date.now(), D0 = Math.floor(now / DAY) * DAY;
  const full = []; for (let i = 60; i >= 1; i--) full.push({ t: D0 - i * DAY, o: 100, h: 106, l: 94 + (i % 3), c: 100 + (i % 5), v: 1e5 });
  const p = createPoller({ dex: "xyz", store: mkStore(), log: () => {}, version: "test", crypto: false });
  p.seedRowNow("xyz:LO", { px: 101, ticker: "LO", uni: "xyz", vol: 1e7, dailyRaw: full, dailyTs: now });
  p.buildDailyNow();
  const dc = p.getDaily(), a = dc.daily["xyz:LO"];
  assert.equal(a[a.length - 1][4], full[full.length - 1].l, "the low ships");
  assert.ok(dc.sessOff && Array.isArray(dc.sessOff.US) && dc.sessOff.US.length > 20 && Array.isArray(dc.sessOff.KR), "the session calendars ship with the payload");
  // warm files: -105 6-tuples restore l and o; a pre--105 4-tuple hydrates without l -> null on the wire
  for (const [tuple, wantL] of [[(k) => [k.t, k.c, k.h, k.v, k.l, k.o], true], [(k) => [k.t, k.c, k.h, k.v], false]]) {
    const q = createPoller({ dex: "xyz", store: mkStore(() => ({ markets: { "xyz:W": { dailyTs: now, daily: full.map(tuple) } } })), log: () => {}, version: "test", crypto: false });
    q.seedRowNow("xyz:W", { px: 100, ticker: "W", uni: "xyz", vol: 1e6 });
    q.hydrateFeaturesNow(); q.buildDailyNow();
    const w = q.getDaily().daily["xyz:W"];
    assert.equal(w[10][4] != null, wantL, wantL ? "a -105 warm file restores the low" : "a 4-tuple file ships a null low (the client falls back to c, tl false)");
  }
  const pol = fs.readFileSync(path.join(__dirname, "..", "src", "poller.js"), "utf8");
  assert.ok(pol.includes("r.dailyRaw = normDailyCandles(c);") && pol.includes("out.push({ t, o: f(k.o), h: f(k.h), l: f(k.l), c: cl, v: f(k.v) });"), "candleSnapshot strings parse once at the source, low and open kept");
  const src = clientSrc();
  assert.ok(src.includes("r.daily=Array.isArray(arr)?arr.map(p=>{ const l=p[4]; return {t:p[0], c:p[1], h:p[2], v:p[3], l:l>0?l:undefined, tl:l>0}; }):r.daily;"), "the client reads column 4 and flags true lows");
  assert.ok(!/the daily feed carries no low/.test(fs.readFileSync(path.join(__dirname, "..", "README.md"), "utf8")), "the README no longer says the feed has no low");
});

test("-105 earnings expansion baseline: 20 SESSION moves before the print, not 20 UTC bars with ~6 flat weekend days", () => {
  // a name that moves 1% every session and not at all on weekends; a +5% print on a Wednesday
  const bars = []; let c = 100; const d0 = dIdx(2026, 6, 1), off = US();
  for (let d = d0; d < d0 + 60; d++) { if (!off(d)) c *= d % 2 ? 1.01 : 1 / 1.01; bars.push({ t: d * DAY, c }); }
  const pd = d0 + 44; while (off(pd)) throw new Error("fixture: print day must be a session");
  bars[44] = { t: pd * DAY, c: bars[43].c * 1.05 };
  for (let i = 45; i < bars.length; i++) bars[i] = { t: bars[i].t, c: bars[44].c };
  const pr = [{ t: "X", d: new Date(pd * DAY).toISOString().slice(0, 10), s: "BMO" }];
  const now = (d0 + 59) * DAY + 12 * HOUR;
  const cal = C.earnReactionsFor(pr, bars, now), ses = C.earnReactionsFor(pr, bars, now, null, { off });
  assert.ok(Math.abs(ses.xMed - 5) < 0.3, "5% over a 1%-per-session baseline reads ~5×: " + ses.xMed);
  assert.ok(cal.xMed > ses.xMed + 1, "the UTC-bar baseline (weekend zeros) inflated it: " + cal.xMed);
  const ru = C.earnRunup([], bars.slice(0, 44), 100, (d0 + 44) * DAY, off);
  assert.ok(Math.abs(ru.day - 1) < 0.02, "the usual daily move is per session: " + ru.day);
});
