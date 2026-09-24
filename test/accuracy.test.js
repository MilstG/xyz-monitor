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
  const clientBeta = (A, B) => new Function("DAY", grab(src, "dailyReturns") + "\n" + grab(src, "computeBeta") + "; return computeBeta;")(DAY)(
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
  assert.ok(pol.includes("dailyBeta(daily, b.dailyRaw, { days: 90, now })") && !pol.includes("closes[closes.length - n + i - 1]"), "the AI context uses the shared beta");
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
  assert.ok(pol.includes("cashClose[r.coin] = [lastCash.close, +pc.toFixed(8)]") && pol.includes("liveClose, cashClose, oi };"), "the server ships the last US cash close on /api/daily");
});
