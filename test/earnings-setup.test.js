"use strict";
// ===== build 2026.09.24-100: pre-earnings setup card =============================================
// A card per name reporting within ~5 sessions: the reaction study, positioning into the print,
// the run-up vs its usual, the typical move vs the CURRENT daily range, and one verdict line
// composed by fixed rules (no model call). These pin the compute (verdict clauses, thresholds,
// every missing-data reason), the poller assembly + ETag stability, and the client render.
const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs"), path = require("path"), os = require("os");
const C = require("../src/compute");
const { earnSetup, earnSetupVerdict, earnRunup, earnSessionsAhead, EARN_SETUP_SESSIONS, EARN_RUNUP_D } = C;
const DAY = 86400000;

const STUDY = { n: 10, avgAbs: 6.5, medAbs: 6.1, up: 5, xMed: 2.1, xN: 10, gapN: 10, gapUp: 5, gapHeld: 3, hN: 0 };

test("setup: session counting skips weekends and refuses a passed date", () => {
  // Thu 2026-09-24 15:00Z = 11:00 ET
  const thu = Date.parse("2026-09-24T15:00:00Z");
  assert.equal(earnSessionsAhead("2026-09-24", thu), 0, "reports today");
  assert.equal(earnSessionsAhead("2026-09-25", thu), 1, "Friday is the next session");
  assert.equal(earnSessionsAhead("2026-09-28", thu), 2, "Monday: the weekend is not two sessions");
  assert.equal(earnSessionsAhead("2026-10-01", thu), 5);
  assert.equal(earnSessionsAhead("2026-09-23", thu), null, "a passed print has no sessions ahead");
  assert.equal(earnSessionsAhead("garbage", thu), null);
  assert.equal(EARN_SETUP_SESSIONS, 5); assert.equal(EARN_RUNUP_D, 7);
});

test("setup verdict: the documented example composes exactly, clause by clause", () => {
  const c = earnSetup({ t: "NVDA", coin: "xyz:NVDA", d: "2026-09-28", s: "AMC", sessions: 2, study: STUDY,
    fund: 5e-5, fundPct: 92, oiChg: 18.2, premBp: 4.2, premZ: 1.3, runup: { now: 5.2, usual: { n: 5, med: 1.1, up: 3 }, day: 1.5 } });
  assert.equal(c.verdict, "crowded long into print (funding p92, OI +18% in 5 sessions); typical move ±6.1%, gaps and fades 7/10; ran +5.2% into print vs usual +1.1%; vol compressed: typical move = 4.1x the current daily move (past prints 2.1x)");
  assert.equal(c.pos.fundApr, 43.8, "hourly rate annualized");
  assert.equal(c.react.gapRead, "fades");
  assert.equal(c.implied.ratio, 4.1); assert.equal(c.implied.read, "compressed");
  assert.equal(c.pos.fundWhy, null); assert.equal(c.pos.oiWhy, null); assert.equal(c.pos.premWhy, null);
});

test("setup verdict: each positioning branch, direction skew, gap holds, thin sample, elevated vol", () => {
  const v = (pos, extra) => earnSetupVerdict(Object.assign({ pos, react: null, drift: {}, implied: {} }, extra || {}));
  assert.match(v({ fundPct: 5, oiChg: 8 }), /^crowded short into print \(funding p5, OI \+8% in 5 sessions\)/);
  assert.match(v({ fundPct: 95, oiChg: 1 }), /^longs paying up/);
  assert.match(v({ fundPct: 8, oiChg: null }), /^shorts paying \(funding p8, OI n\/a\)/);
  assert.match(v({ fundPct: 50, oiChg: 12 }), /^OI building into print/);
  assert.match(v({ fundPct: null, oiChg: -14 }), /^positions coming off into print \(funding pctile n\/a, OI −14% in 5 sessions\)/);
  assert.match(v({ fundPct: 50, oiChg: 2 }), /^positioning neutral/);
  assert.match(v({}), /^positioning n\/a; no reaction history$/, "nothing known reads as nothing known");
  const c = earnSetup({ t: "X", sessions: 1, study: { n: 3, avgAbs: 4, medAbs: 3.5, up: 3, xMed: 3, gapN: 3, gapUp: 3, gapHeld: 3 },
    fundPct: 50, oiChg: 0, runup: { now: -4, usual: null, day: 3.5 } });
  assert.match(c.verdict, /typical move ±3\.5%, up 3\/3, gaps and holds 3\/3 \(thin: n=3\)/);
  assert.match(c.verdict, /sold off −4\.0% into print;/, "no usual drift: the clause stands alone");
  assert.match(c.verdict, /vol already elevated: typical move only 1\.0x/);
  const quiet = earnSetup({ t: "Y", sessions: 1, study: { n: 8, avgAbs: 2, medAbs: 2, up: 2, xMed: 2, gapN: 0 }, runup: { now: 1, day: 1 } });
  assert.match(quiet.verdict, /down 6\/8/); assert.doesNotMatch(quiet.verdict, /into print;|ran|sold off/, "a small run-up says nothing");
  assert.match(quiet.verdict, /typical move = 2\.0x the current daily move \(past prints 2\.0x\)$/);
});

test("setup: every missing input arrives as n/a with its reason, never as a zero", () => {
  const c = earnSetup({ t: "Z", coin: "xyz:Z", d: "2026-09-25", sessions: 1, study: null, fund: null, fundPct: null, oiChg: null, premBp: null,
    runup: { now: null, nowWhy: "the daily spine does not reach 7 days back", usual: null, usualWhy: "no past print", day: null, dayWhy: "fewer than 8 completed daily candles on the spine" } });
  assert.equal(c.react, null); assert.match(c.reactWhy, /no reaction history/);
  assert.equal(c.pos.fundApr, null); assert.match(c.pos.fundWhy, /no live funding/);
  assert.equal(c.pos.oiChg, null); assert.match(c.pos.oiWhy, /OI history/);
  assert.equal(c.pos.premBp, null); assert.match(c.pos.premWhy, /oracle/);
  assert.equal(c.drift.now, null); assert.match(c.drift.nowWhy, /7 days/);
  assert.equal(c.implied.ratio, null); assert.match(c.implied.why, /no reaction history/);
  assert.equal(c.verdict, "positioning n/a; no reaction history");
  assert.equal(c.s, "TBD", "an unknown session is labeled TBD");
  const noPct = earnSetup({ t: "Z", sessions: 1, fund: 1e-5, fundPct: null, premBp: 3, study: STUDY, runup: { day: null, dayWhy: "fewer than 8" } });
  assert.match(noPct.pos.fundWhy, /4 days/); assert.match(noPct.pos.premWhy, /z-score/);
  assert.equal(noPct.implied.why, "fewer than 8", "a missing daily baseline names itself");
});

test("setup run-up: drift so far, usual pre-print drift across past prints, and the usual daily move", () => {
  const now = Date.parse("2026-09-24T15:00:00Z"), t0 = Date.UTC(2026, 5, 1);
  const daily = [];
  // alternating +/-1% days, with a +7% ramp over the 7 days before each past print and into today
  let c = 100;
  const prints = [{ t: "X", d: "2026-07-01" }, { t: "X", d: "2026-07-29" }, { t: "X", d: "2026-08-26" }];
  const ramp = new Set();
  for (const p of prints) { const pt = Date.parse(p.d + "T00:00:00Z"); for (let k = 1; k <= 7; k++) ramp.add(pt - (k + 1) * DAY + DAY); }
  for (let t = t0; t + DAY <= now + DAY; t += DAY) {
    const i = daily.length;
    c = ramp.has(t) ? c * 1.01 : c * (i % 2 ? 1.01 : 0.99);
    daily.push({ t, c });
  }
  const ru = earnRunup(prints, daily, daily[daily.length - 1].c, now);
  assert.ok(ru.day > 0.9 && ru.day < 1.1, "mean |close-to-close| over 20 bars ~1%");
  assert.equal(ru.dayN, 20);
  assert.ok(ru.now != null && Math.abs(ru.now) < 3, "drift so far measured live mark vs the 7d-back close");
  assert.ok(ru.usual && ru.usual.n === 3, "three prints with a full 7-day run-up");
  assert.ok(ru.usual.med > 5, `the ramp shows as the usual pre-print drift, got ${ru.usual.med}`);
  assert.equal(ru.usual.up, 3);
  const short = earnRunup(prints.slice(0, 1), daily.slice(-5), 100, now);
  assert.match(short.dayWhy, /fewer than 8/); assert.match(short.nowWhy, /7 days back/); assert.match(short.usualWhy, /no past print/);
  const none = earnRunup([], null, 100, now);
  assert.match(none.nowWhy, /not loaded/);
});

test("setup poller: cards for names inside the window only, n/a for a name off the board, stable object while content holds", () => {
  const { openStore } = require("../src/store");
  const { createPoller } = require("../src/poller");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "xyzsetup-"));
  try {
    const p = createPoller({ dex: "xyz", store: openStore(dir), log: () => {}, version: "test", crypto: false });
    const now = Date.now();
    // two weekdays ahead (ET): inside the window; ~20 calendar days ahead: outside it
    let d = null; for (let k = 1; k < 10 && d == null; k++) { const s = C.etDayStr(now + k * DAY); if (earnSessionsAhead(s, now) === 2) d = s; }
    const far = C.etDayStr(now + 20 * DAY);
    const H = 3600000, hr0 = Math.floor(now / H) * H;
    const fundH = new Map(); for (let h = 30 * 24; h >= 1; h--) fundH.set(hr0 - h * H, 1e-6 * (h % 10));
    const daily = []; for (let k = 40; k >= 1; k--) daily.push({ t: Math.floor(now / DAY) * DAY - k * DAY, c: 100 * (k % 2 ? 1.02 : 1) });
    p.seedRowNow("xyz:NVDA", { px: 101, oracle: 100.9, ticker: "NVDA", uni: "xyz", funding: 2e-5, fundH, oiBase: 1180, dailyRaw: daily });
    p.seedHistNow("xyz:NVDA", [[now - 8 * DAY, 1000, 1e-6], [now - 7 * DAY, 1000, 1e-6], [now - 6 * DAY, 1050, 1e-6], [now - H, 1180, 2e-5]]);
    p.seedEarnNow([{ t: "NVDA", coin: "xyz:NVDA", d, s: "AMC" }, { t: "GONE", coin: "xyz:GONE", d, s: "BMO" }, { t: "LATE", coin: "xyz:LATE", d: far, s: "AMC" }],
      { NVDA: STUDY }, []);
    const a = p.getEarnSetups();
    assert.equal(a.error, null); assert.equal(a.sessions, 5); assert.equal(a.count, 2, "the far print is outside the window");
    const nv = a.cards.find((c) => c.t === "NVDA"), gone = a.cards.find((c) => c.t === "GONE");
    assert.equal(nv.sessions, 2);
    assert.equal(nv.pos.fundPct, 100, "the live rate tops its own 31d history");
    assert.ok(Math.abs(nv.pos.oiChg - 18) < 0.01, `OI over the 7d run-up, got ${nv.pos.oiChg}`);
    assert.ok(Math.abs(nv.pos.premBp - 9.9) < 0.1, "premium in bp off mark vs oracle");
    assert.equal(nv.pos.premZ, null); assert.match(nv.pos.premWhy, /z-score/);
    assert.ok(nv.implied.ratio > 0, "typical move vs the current daily move");
    assert.match(nv.verdict, /^crowded long into print \(funding p100, OI \+18% in 5 sessions\); typical move ±6\.1%, gaps and fades 7\/10/);
    assert.match(gone.missing, /not on the live board/, "a calendar name without a market says why");
    assert.ok(!a.cards.some((c) => c.t === "LATE"));
    assert.equal(p.getEarnSetups(), a, "same content inside the minute: the same object (same ETag)");
    p.seedEarnNow([{ t: "NVDA", coin: "xyz:NVDA", d, s: "AMC" }], { NVDA: STUDY }, []);
    const b = p.getEarnSetups();
    assert.notEqual(b, a, "a replaced calendar rebuilds at once");
    assert.ok(b.dataTs > a.dataTs, "new content, new ETag stamp");
    assert.equal(b.count, 1);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test("setup client: strip, card body and drawer section render the server's numbers and every n/a reason", () => {
  const app = require("./_client").clientSource();
  const grab = (name) => {
    const i = app.indexOf("function " + name + "(");
    assert.ok(i > -1, name + " present in the client");
    let dd = 0;
    for (let k = app.indexOf("{", i); k < app.length; k++) {
      if (app[k] === "{") dd++; else if (app[k] === "}") { dd--; if (!dd) return app.slice(i, k + 1); }
    }
    throw new Error("unbalanced " + name);
  };
  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
  const state = {};
  const api = new Function("esc", "state", "const _setupOpen=new Set();\n"
    + ["earnCiTxt", "earnSessLbl", "setupNa", "setupPct", "setupWhen", "earnSetupBodyHtml", "earnSetupCardHtml", "earnSetupStripHtml", "earnSetupDrawerHtml"].map(grab).join("\n")
    + "\nreturn { earnSetupStripHtml, earnSetupDrawerHtml, earnSetupBodyHtml, _setupOpen };")(esc, state);
  const full = earnSetup({ t: "NVDA", coin: "xyz:NVDA", d: "2026-09-28", s: "AMC", sessions: 2, study: STUDY,
    fund: 5e-5, fundPct: 92, oiChg: 18.2, premBp: 4.2, premZ: 1.3, runup: { now: 5.2, usual: { n: 5, med: 1.1, up: 3 }, day: 1.5 } });
  const bare = earnSetup({ t: "AMD", coin: "xyz:AMD", d: "2026-09-25", s: "BMO", sessions: 1, study: null,
    runup: { nowWhy: "the daily spine does not reach 7 days back", usualWhy: "no past print with a full 7-day run-up on the retained spine", dayWhy: "x" } });
  const gone = { t: "GONE", coin: null, d: "2026-09-25", s: "TBD", sessions: 1, missing: "the market is not on the live board — no positioning or price data" };
  assert.equal(api.earnSetupStripHtml(), "", "no payload yet: no strip");
  state.earnSetups = { sessions: 5, cards: [full, bare, gone], error: null };
  const h = api.earnSetupStripHtml();
  assert.match(h, /PRE-EARNINGS SETUPS/); assert.match(h, /3 names/);
  assert.equal((h.match(/<details class="earn-setup"/g) || []).length, 3);
  assert.ok(!/ open>/.test(h), "cards start collapsed");
  assert.ok(h.includes(esc(full.verdict)), "the verdict line is the summary");
  assert.match(h, /in 2 sessions · after close \(AMC\)/); assert.match(h, /next session · pre-market \(BMO\)/);
  assert.match(h, /±6\.1%/); assert.match(h, /p92/); assert.match(h, /\+18\.2%/); assert.match(h, /\+4\.2bp/); assert.match(h, /4\.1x/); assert.match(h, /vol compressed now/);
  assert.match(h, /n\/a — no reaction history yet/, "missing study named");
  assert.match(h, /n\/a — no live funding rate/); assert.match(h, /n\/a — OI history does not reach 7 days back yet/);
  assert.match(h, /n\/a — the daily spine does not reach 7 days back/);
  assert.match(h, /n\/a — the market is not on the live board/);
  api._setupOpen.add("AMD");
  assert.match(api.earnSetupStripHtml(), /data-t="AMD" open>/, "an expanded card stays expanded across re-renders");
  state.earnSetups = { sessions: 5, cards: [], error: null };
  assert.match(api.earnSetupStripHtml(), /No name on the calendar reports within the next 5 sessions/);
  state.earnSetups = { sessions: 5, cards: [], error: "earnings calendar not fetched yet" };
  assert.match(api.earnSetupStripHtml(), /n\/a — earnings calendar not fetched yet/);
  // drawer
  state.earnSetupMap = new Map([["NVDA", full]]);
  const dr = api.earnSetupDrawerHtml({ uni: "xyz", ticker: "NVDA" });
  assert.match(dr, /^<div id="dsetup"><div class="dsec">Pre-earnings setup/); assert.ok(dr.includes(esc(full.verdict)));
  assert.equal(api.earnSetupDrawerHtml({ uni: "xyz", ticker: "MSFT" }), '<div id="dsetup"></div>', "no print in the window: an empty slot to fill later");
  assert.equal(api.earnSetupDrawerHtml({ uni: "main", ticker: "NVDA" }), '<div id="dsetup"></div>', "crypto never carries a setup");
  // wiring pins: the tab and the drawer both mount it, the loader fills an open drawer in place
  for (const pin of ["earnSetupStripHtml()+repHtml", "${earnSetupDrawerHtml(r)}", "fetchJSON('/api/earnings/setups')", "ds.replaceWith(nx)", "loadEarnSetups(); }"])
    assert.ok(app.includes(pin), "client pin missing: " + pin);
  const css = fs.readFileSync(path.join(__dirname, "..", "public", "styles.css"), "utf8");
  assert.ok(css.includes(".earn-setup{") && css.includes(".setup-grid{"), "setup card styling present");
  assert.ok(fs.readFileSync(path.join(__dirname, "..", "public", "docs.html"), "utf8").includes("Pre-earnings setups"), "the manual covers it");
  assert.ok(fs.readFileSync(path.join(__dirname, "..", "README.md"), "utf8").includes("**Pre-earnings setup card** (build 2026.09.24-100)"), "README entry");
});
