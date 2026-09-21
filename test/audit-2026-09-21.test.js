"use strict";
// Code audit 2026-09-21: behavioural pins for the fixes. Each test names the failure it guards.
const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs"), path = require("path"), os = require("os");
const C = require("../src/compute");
const HOUR = 3600e3, DAY = 86400e3;
const src = (p) => fs.readFileSync(path.join(__dirname, "..", p), "utf8");

test("validateRule: an empty threshold is refused, not coerced into 'above 0'", () => {
  for (const v of ["", "   ", null, [], true]) assert.equal(C.validateRule({ metric: "px", op: ">", value: v }).error, "bad-value", JSON.stringify(v));
  assert.ok(C.validateRule({ metric: "px", op: ">", value: "200" }).ok, "a numeric string is a number");
  assert.ok(C.validateRule({ metric: "px", op: ">", value: 200 }).ok);
  assert.equal(C.validateRule({ metric: "px", op: ">", value: 200, band: "" }).error, "bad-band");
  assert.equal(C.validateRule({ metric: "px", op: ">", value: 200, cooldownMs: "" }).error, "bad-cooldown");
});

test("ruleBand: 'price above the 200-day' carries half a percent of hysteresis whichever surface wrote it", () => {
  assert.equal(C.ruleBand({ metric: "vsma200", op: ">", value: 0 }), 0.5, "the panel's rule, same as /alert's");
  assert.equal(C.ruleBand({ metric: "px", op: ">", value: 100 }), 2, "2% of the threshold elsewhere");
  assert.equal(C.ruleBand({ metric: "vsma200", op: ">", value: 0, band: 1 }), 1, "an explicit band still wins");
});

test("brief fabrication gate: an integer's trailing zeros are digits — '300' is not '3'", () => {
  const nums = C.briefContextNumbers({ regime: { n: 3 }, movers: { up: [{ t: "NVDA", d1: 2.4 }] }, px: 2.5 });
  const names = new Set(["NVDA"]);
  assert.ok(/300/.test(C.briefTextViolation("NVDA up 300% this year", nums, names) || ""), "a round number the context never carried is a fabrication");
  assert.equal(C.briefTextViolation("NVDA is +2.4 today", nums, names), null);
  assert.equal(C.briefTextViolation("NVDA at 2.50", nums, names), null, "a decimal's trailing zero is formatting");
  assert.ok(!nums.has("12") || nums.has("1200"), "no over-adding of integer prefixes");
});

test("sicToSector: the computer-hardware carve-out is reachable", () => {
  assert.equal(C.sicToSector(3571), "Information Technology");
  assert.equal(C.sicToSector(3572), "Information Technology");
  assert.equal(C.sicToSector(3560), "Industrials");
  assert.equal(C.sicToSector(3579), "Industrials");
});

test("detectPead / earnPrintReaction read the live spine's STRING closes", () => {
  const base = Date.UTC(2026, 7, 1);
  const num = [], str = [];
  for (let i = 0; i < 30; i++) { const c = i < 27 ? 100 : i === 27 ? 106 : 106.5; num.push({ t: base + i * DAY, c, o: 100 }); str.push({ t: base + i * DAY, c: String(c), o: "100" }); }
  const pr = [{ t: "X", d: "2026-08-28", s: "BMO" }];   // dly[27] is 2026-08-28
  const a = C.detectPead(pr, num, 107, 2), b = C.detectPead(pr, str, 107, 2);
  assert.ok(a && a.side === "long" && a.mv === 6, JSON.stringify(a));
  assert.deepEqual(b, a, "the REST shape (string closes) must read the same as numbers");
  const now = base + 29 * DAY + 12 * HOUR;
  const ra = C.earnPrintReaction({ d: "2026-08-28", s: "DMH" }, num, 107, null, now), rb = C.earnPrintReaction({ d: "2026-08-28", s: "DMH" }, str, 107, null, now);
  assert.ok(ra && Number.isFinite(ra.pct), JSON.stringify(ra));
  assert.deepEqual(rb, ra);
});

test("sessionRecords: an open printed outside the day's own range clamps into quarter 1, never below", () => {
  const day = Math.floor(Date.UTC(2026, 8, 10) / DAY) * DAY, hs = [];
  for (let d = 0; d < 3; d++) for (let h = 0; h < 24; h++) {
    const t = day + d * DAY + h * HOUR;
    hs.push(h === 0 ? [t, 100, 104, 104, 104, 1] : [t, 110, 112, 108, 110, 1]);   // closes-only first bar: o below the day's low
  }
  const recs = C.sessionRecords(hs, { now: day + 3 * DAY, minBars: 20 });
  assert.ok(recs.length >= 3);
  for (const r of recs) assert.ok(r.openQ === 1, "openQ " + r.openQ);   // the anatomy pool indexes its cells with openQ - 1
});

test("closedWindows / homeClosedWindows carry the close of the session they open into", () => {
  const start = Date.UTC(2026, 8, 7), end = Date.UTC(2026, 8, 12);
  for (const w of C.closedWindows(start, end)) assert.ok(w.nextClose > w.exit && w.nextClose - w.exit <= 8 * HOUR, JSON.stringify(w));
  for (const w of C.homeClosedWindows("KR", start, end)) assert.ok(w.nextClose > w.exit && w.nextClose - w.exit <= 8 * HOUR, "a KRX window closes at the KRX close, not the NYSE one: " + JSON.stringify(w));
  assert.ok(/let closeT = gp\.nextClose > gp\.exit \? gp\.nextClose : null;/.test(src("src/compute.js")), "studyGapFade measures the session to the window's own close");
});

test("feature gate: the lookup sees the path the router matches (decoded, fragment gone)", () => {
  const flags = {};
  const gated = C.featureGateFor("GET", "/api/whale", flags, false);
  assert.ok(gated, "the whale route is gated for a non-admin by default");
  assert.equal(C.featureGateFor("GET", "/api/%77hale", flags, false), gated, "percent-encoding is not a key");
  assert.equal(C.featureGateFor("GET", "/api/whale#x", flags, false), gated, "a fragment is not part of the path");
  assert.equal(C.featureGateFor("GET", "/api/whale?x=1", flags, false), gated);
  assert.equal(C.featureGateFor("GET", "/api/health", flags, false), null);
});

test("poller pins: d7 is derived for the OI-flush/divergence gates, a thrown backfill is not a probe result, memo keys see a sliding window", () => {
  const pol = src("src/poller.js");
  assert.ok(/const d7 = \(r\.ref && r\.ref\.p7d > 0 && r\.px > 0\) \? \(r\.px \/ r\.ref\.p7d - 1\) \* 100 : null;/.test(pol), "no row ever carried a d7 field");
  assert.ok(!/r\.d7\b/.test(pol), "…and nothing reads one");
  const fw = pol.slice(pol.indexOf("async function fundingWorker()"), pol.indexOf("async function fundingWorker()") + 1400);
  assert.equal((fw.match(/fundProbeTries\+\+/g) || []).length, 1, "the probe counts replies, not throws");
  assert.ok(/const memoK = dr\.length \+ "\|" \+ \(r\.dailyTs \|\| 0\) \+ "\|" \+ \(r\.hourlyTs \|\| 0\)/.test(pol), "volMapFor keys on the spines' stamps");
  assert.ok(/const lastC = \(d\[0\] && d\[0\]\.t\) \+ ":"/.test(pol), "sma200Of keys on the first bar too");
  assert.ok(/sched: prev && prev\.sched && typeof prev\.sched === "object" \? prev\.sched : undefined,/.test(pol), "a re-link keeps the schedule");
});

test("client pins: b/h stay out of the Messages tab, dmPost never throws, a failed duel pull is memoised, baskets memoise a failed pull", () => {
  const app = require("./_client").clientSource();
  const dm = app.indexOf("if(state.view==='dm'){ dmKeys(e); return; }"), bk = app.indexOf("if(e.key==='b'){ e.preventDefault(); goBackTab(); return; }");
  assert.ok(dm > 0 && bk > dm, "a bare letter on the Messages tab starts a message; the shortcuts run after the DM dispatch");
  assert.ok(/async function dmPost\(body\)\{\n[^]*?try\{[^]*?\}catch\(_\)\{ return \{ok:false,d:\{error:'network error/.test(app), "a rejected fetch answers ok:false instead of leaving dmState.sending stuck");
  assert.ok(/let got=false;\n\s*try\{ d\.data=await fetchJSON\('\/api\/duel'\); got=true; \}\n\s*catch\(_\)\{ \}\n\s*d\.at=Date\.now\(\); d\.pending=false;\n\s*if\(got&&state\.view==='backtest'\) drawBacktest\(\);/.test(app), "the attempt is stamped whatever happened, and only a hit redraws");
  assert.ok(app.includes("if(!force && Date.now()-BASKETS.ts<60000){ if(BASKETS.list.length) renderBasketPanel(); return; }") && app.includes("}catch(_){}\n  BASKETS.ts=Date.now();"), "an empty or failed basket pull is memoised like a hit");
  assert.ok(app.includes("function termErrHtml(html)") && app.includes("termErrHtml(`unknown \""), "the did-you-mean suggestion renders as a clickable command, not as text");
  assert.ok(/\$\{safeHref\(a\.url\)\?`<a href="\$\{esc\(safeHref\(a\.url\)\)\}"/.test(app), "a feed URL in the terminal goes through safeHref");
});

test("server pins: a disabled account has no /alert path from its phone, the mirror caps prose, the phone's own /alert is not echoed, the admin damper keys on the client", () => {
  const srv = src("server.js");
  assert.ok(/if \(!me \|\| me\.disabledAt\) return \{ ok: false, error: "This chat is not linked to an account\." \};/.test(srv));
  assert.ok(/else if \(r\.body\) out \+= "\\n" \+ tgEsc\(r\.body\.slice\(0, 1500\)\)/.test(srv) && /if \(text\.length <= 3900\) return text;/.test(srv), "a 4000-char paste escaped for HTML overruns Telegram's 4096 and the wire drops it after the cursor moved");
  assert.equal((srv.match(/via: opts\.tg \? "telegram" : null/g) || []).length, 2, "/alert and /alert off from the phone post with via telegram, so the mirror skips them");
  assert.ok(/poller\.resetAiDay\(String\(\(req\.body \|\| \{\}\)\.password \|\| ""\), clientIp\(req\)\)/.test(srv) && /poller\.checkAdminPassword\(String\(\(req\.body \|\| \{\}\)\.password \|\| ""\), clientIp\(req\)\)/.test(srv), "behind the proxy req.ip is the proxy for everyone");
  assert.ok(/const routeUrl = req\.routeOptions && req\.routeOptions\.url;/.test(srv), "the gate also checks the matched route pattern");
});

test("store: a re-sighted accession keeps the parsed ISSUER symbol; the sector audit log is config-grade", (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "audit-ins-"));
  const st = require("../src/store").openStore(dir);
  if (!st.insidersReady()) return t.skip("node:sqlite unavailable in this runtime");
  const acc = "0000050863-26-000101";
  st.insidersQueue([{ acc, tk: "BX", form: "4", filed: Date.parse("2026-08-26T21:05:00Z"), url: "u" }]);
  st.insidersSave(acc, { tk: "RIVN", issuer: "RIVIAN", period: "2026-08-25", owner: "x", role: "10% owner", title: null, nDeriv: 0 },
    [{ ln: 0, code: "S", act: "sell", ad: "D", shares: 1, price: 1, value: 1, txDate: "2026-08-25", own: 1, dir: "D", plan: null, sec: "Common Stock" }]);
  st.insidersQueue([{ acc, tk: "BX", form: "4", filed: 1, url: "u" }]);   // the holder's feed sees it again
  assert.equal(st.openInsiders().prepare("SELECT tk FROM filing WHERE acc=?").get(acc).tk, "RIVN", "the form's issuer symbol stands once parsed");
  const rec = { records: [{ t: "X", at: 1 }] };
  assert.ok(st.saveSectorAudit(rec));
  assert.deepEqual(st.loadSectorAudit(), rec);
  assert.ok(st.saveSectorAudit(rec));   // the second write is what leaves a .bak behind
  fs.writeFileSync(path.join(dir, "sector-audit.json"), "");   // the torn zero-length file the overlay volume produces
  assert.deepEqual(st.loadSectorAudit(), rec, "a torn file falls back to the .bak instead of losing the log");
  st.close(); fs.rmSync(dir, { recursive: true, force: true });
});
