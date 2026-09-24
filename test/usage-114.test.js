"use strict";
// ===== build 2026.09.24-114: Usage fixes from review of builds -111 → -113 ================================================
// 1. a chronic error is not a "new error" after a quiet hotfix; a baseline needs ≥ 20 page loads
// 2. triage resolves against the NEWEST build in deploy order, so a stale older tab cannot fake a reopen
// 3. Telegram reminders hold inside the member's quiet hours (not sent, not marked) and go on a later pass
// 4. the sitewide sections need a ≥ 7-day range, cover complete days only and show only when ≥ 3 members
//    contributed ('sc' = a per-day COUNT, never who); the card / guide / README say so
// 5. entry tabs draw on the member's daily sitewide budget and are capped at 200 per member per day
// 6. the 2s bounce rule counts visible time only; a background-opened page has no entry tab until seen
// 7. a nav-groups write that changes nothing is not a marker
// 8. the usage POST routes answer 400 (not 500) to a body that is not a JSON object
// 9. usage_day(kind, day) index; the regression tick stops for a finished build; triage sweep every 10 min
// 10. a web-push reminder has its own tag and click target in the service worker; DMs unchanged
// 11. sitewide rows (tr/en/ctl/tdev/sc) kept 30 days; usage_mark (operator config history) kept 90
const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs"), path = require("path"), os = require("os"), vm = require("vm");

const DATA = fs.mkdtempSync(path.join(os.tmpdir(), "xyz-usage-114-"));
process.env.DATA_DIR = DATA;
delete process.env.SITE_PASSWORD;
process.env.ADMIN_PASSWORD = "break-glass-pw-1";
process.env.XYZ_QUIET = "1";
process.env.XYZ_NO_NET = "1";
process.env.TG_BOT_TOKEN = "test-token";
delete process.env.FINNHUB_TOKEN; delete process.env.FRED_KEY; delete process.env.BRIEF_DEFAULT_HOUR;
delete process.env.USAGE_PUBLIC; delete process.env.OPENAI_API_KEY; delete process.env.ANTHROPIC_API_KEY;

const { openAccounts } = require("../src/accounts");
const { etDayStr } = require("../src/compute");
const src = (rel) => fs.readFileSync(path.join(__dirname, "..", rel), "utf8");
const between = (s, a, b) => { const i = s.indexOf(a); assert.ok(i >= 0, a); return s.slice(i, s.indexOf(b, i + a.length) + b.length); };
const DAY = 864e5, HOUR = 3600e3;
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const U = (i) => "uid-k" + String(i).padStart(12, "0");
const TABS = ["markets", "trend", "corr", "sectors"].map((k) => ({ key: k, label: k[0].toUpperCase() + k.slice(1), gate: "public" }));

function withMembers(n, dir) {
  const A = openAccounts(dir || fs.mkdtempSync(path.join(os.tmpdir(), "xyz-usage-114-acc-")));
  for (let i = 0; i < n; i++)
    A._db.prepare("INSERT OR IGNORE INTO user (uid, handle, display, pw, epoch, isAdmin, createdAt, lastSeen) VALUES (?,?,?,?,1,0,?,0)").run(U(i), "m" + i, "m" + i, "x", Date.UTC(2026, 0, 1));
  A.hydrate();
  return A;
}
const rowsOf = (A, sql, ...a) => A._db.prepare(sql).all(...a).map((x) => Object.assign({}, x));

// ---- 1. chronic errors are not new; a thin baseline is no baseline -------------------------------------------------------
test("-114 regression: a chronic error skipped by a one-load hotfix is not 'new'; the baseline needs ≥ 20 loads; a genuinely new one still fires", () => {
  const A = withMembers(30);
  const T = Date.UTC(2026, 8, 20, 16);
  const chronic = [{ loc: "/js/app.js:10", msg: "chronic thing", c: 1 }];
  // A: long-lived, 25 loads, the chronic error hit by 5 members
  A.usageBuildSeen("b-100", T - 10 * DAY);
  for (let i = 0; i < 25; i++) A.usageRecord(U(i), { markets: 60000 }, "desktop", T - 5 * DAY + i * 1000, { build: "b-100", load: true, errs: i < 5 ? chronic : [] });
  // B: a hotfix that lived 20 minutes on one page load, no errors
  A.usageBuildSeen("b-101", T - 3 * HOUR);
  A.usageRecord(U(0), { markets: 60000 }, "desktop", T - 3 * HOUR + 60000, { build: "b-101", load: true });
  // C: 3 loads, the chronic error hit by 2 members (same as always) and a NEW one hit by 2
  A.usageBuildSeen("b-102", T - 2.5 * HOUR);
  for (let i = 0; i < 3; i++) A.usageRecord(U(i + 1), { markets: 60000 }, "desktop", T - 2 * HOUR + i * 1000, { build: "b-102", load: true, errs: i < 2 ? chronic : [] });
  let v = A.usageRegress("b-102", T);
  assert.equal(v.prev, "b-100", "the one-load hotfix is not a baseline: the last build with ≥ 20 loads is");
  assert.equal(v.checks.loadsPrev, 25);
  assert.equal(v.state, "ok", "the chronic error is not new: " + JSON.stringify(v.conds));
  for (const i of [7, 8]) A.usageRecord(U(i), {}, null, T - HOUR, { build: "b-102", errs: [{ loc: "/js/new.js:3", msg: "fresh bug", c: 1 }] });
  v = A.usageRegress("b-102", T);
  assert.equal(v.state, "regression"); assert.deepEqual(v.conds.map((c) => [c.kind, c.n, c.top.loc]), [["new-errors", 1, "/js/new.js:3"]]);
  A.close();
  // only thin builds before: no baseline, nothing compared, never an alarm
  const B = withMembers(4);
  B.usageBuildSeen("t-1", T - 2 * DAY); B.usageBuildSeen("t-2", T - 3 * HOUR);
  for (let i = 0; i < 19; i++) B.usageRecord(U(i % 4), {}, null, T - DAY, { build: "t-1", load: true });
  for (const i of [0, 1]) B.usageRecord(U(i), {}, null, T - HOUR, { build: "t-2", load: true, errs: [{ loc: "/js/x.js:1", msg: "boom", c: 1 }] });
  v = B.usageRegress("t-2", T);
  assert.equal(v.state, "no-baseline"); assert.equal(v.prev, null); assert.deepEqual(v.conds, []);
  B.close();
});

test("-114 regression: an error first seen on a build that already left the known list is still chronic (usage_err firstAt)", () => {
  const A = withMembers(6);
  const T = Date.UTC(2026, 8, 20, 16);
  const E = [{ loc: "/js/old.js:5", msg: "ancient", c: 1 }];
  A.usageBuildSeen("o-0", T - 20 * DAY);
  for (const i of [0, 1]) A.usageRecord(U(i), {}, null, T - 19 * DAY, { build: "o-0", errs: E });
  A.usageFlush();
  for (const [b, d] of [["o-1", 15], ["o-2", 10], ["o-3", 5]]) A.usageBuildSeen(b, T - d * DAY);
  for (let i = 0; i < 25; i++) A.usageRecord(U(i % 6), {}, null, T - 4 * DAY, { build: "o-3", load: true });
  A.usageBuildSeen("o-4", T - 3 * HOUR);
  assert.equal(A.usageBuildKnown("o-0"), false, "o-0 aged out of the four known builds");
  for (const i of [2, 3]) A.usageRecord(U(i), {}, null, T - HOUR, { build: "o-4", load: true, errs: E });
  const v = A.usageRegress("o-4", T);
  assert.equal(v.prev, "o-3"); assert.equal(v.state, "ok", "first seen 19 days before this build went live: chronic");
  A.close();
});

// ---- 2. triage in deploy order --------------------------------------------------------------------------------------------
test("-114 triage: resolving stamps the NEWEST build in deploy order; a stale tab on that build never reopens it; a newer build does", () => {
  const A = withMembers(5);
  const T = Date.UTC(2026, 8, 20, 16);
  A.usageBuildSeen("b-B", T - 48 * HOUR); A.usageBuildSeen("b-C", T - 24 * HOUR); A.usageBuildSeen("b-D", T - 2 * HOUR);
  const E = [{ loc: "/js/app.js:10", msg: "bug", c: 1 }];
  A.usageRecord(U(0), {}, null, T - 90 * 60000, { build: "b-C", errs: E });   // the buggy build
  A.usageRecord(U(1), {}, null, T - 60 * 60000, { build: "b-B", errs: E });   // a stale tab on the OLDER build, hit later
  A.usageFlush();
  const sig = A.usageTriage(T).rows[0].sig;
  assert.equal(A.usageTriageSet(sig, true, T - 30 * 60000).ok, true);
  assert.equal(A._db.prepare("SELECT resolvedBuild FROM usage_triage WHERE sig = ?").get(sig).resolvedBuild, "b-C", "the newest build that hit it, not the row hit last");
  // a stale tab still on C (already known-affected) hits it after the fix D is live: stays resolved
  A.usageRecord(U(2), {}, null, T, { build: "b-C", errs: E });
  assert.equal(A.usageTriageSweep(T + 1000), 0);
  assert.equal(A.usageTriage(T + 2000).rows[0].resolved, true);
  // D — deployed after C — hits it: reopened as regressed
  A.usageRecord(U(3), {}, null, T + 3000, { build: "b-D", errs: E });
  assert.equal(A.usageTriageSweep(T + 4000), 1);
  const r = A.usageTriage(T + 5000).rows[0];
  assert.deepEqual([r.resolved, r.regressed, r.regressedBuild], [false, true, "b-D"]);
  A.close();
});

// ---- 4 / 5 / 11. the sitewide rows: k-threshold, entry caps, retention ------------------------------------------------------
test("-114 sitewide k-threshold: ≥ 7-day range, complete days only, ≥ 3 members — else withheld with the reason", () => {
  const A = withMembers(4);
  const now = Date.now(), y = now - DAY, today = etDayStr(now), yday = etDayStr(y);
  const beat = (i, t) => A.usageRecord(U(i), { markets: 30000 }, "desktop", t, { tr: { "markets>trend": 2 }, en: "markets", ctl: { "markets.window=1d": 1 } });
  beat(0, y); beat(1, y);
  let s = A.usageSummary({ r: 7, tabs: TABS, now });
  assert.equal(s.site.withheld, "k", "two members yesterday: below k");
  assert.equal(s.site.threshold.members, 2); assert.equal(s.site.threshold.k, 3); assert.equal(s.site.threshold.minDays, 7);
  assert.equal(s.site.paths, null); assert.equal(s.site.controls, null); assert.equal(s.site.devices, null);
  assert.ok(s.site.nav && s.site.nav.current, "the nav suggestion reads the tab table and stays");
  // three members TODAY do not count: today is never in the sitewide sections
  beat(0, now); beat(1, now); beat(2, now);
  s = A.usageSummary({ r: 7, tabs: TABS, now });
  assert.equal(s.site.withheld, "k", "today's contributors are not in the range's complete days");
  assert.equal(s.site.threshold.to, etDayStr(now - DAY));
  // a third member yesterday: shown — and today's rows are not in the numbers
  beat(2, y);
  s = A.usageSummary({ r: 7, tabs: TABS, now });
  assert.equal(s.site.withheld, null); assert.equal(s.site.threshold.members, 3);
  assert.equal(s.site.paths.total, 6, "3 members × 2 moves yesterday; today's 6 are left out");
  assert.equal(s.site.paths.entry.total, 3); assert.equal(s.site.controls.total, 3);
  assert.equal(s.site.devices.rows[0].ms, 90000, "yesterday's 3 × 30s only");
  // one member on many days is not many members: the bound is per day
  const B = withMembers(3);
  for (let d = 1; d <= 6; d++) B.usageRecord(U(d % 2), { markets: 30000 }, "desktop", now - d * DAY, { tr: { "markets>trend": 1 } });
  assert.equal(B.usageSummary({ r: 7, tabs: TABS, now }).site.withheld, "k", "two members over six days: the per-day counts are never added up");
  B.close();
  // below 7 days: withheld whatever the count
  for (const r of [1, 6]) {
    const x = A.usageSummary({ r, tabs: TABS, now }).site;
    assert.equal(x.withheld, "range", "r=" + r); assert.equal(x.paths, null);
  }
  assert.equal(A.usageSummary({ r: 30, tabs: TABS, now }).site.withheld, null);
  // the 'sc' rows: uid '0', key = the day, n = a count — no member id anywhere in the sitewide kinds
  A.usageFlush();
  const sc = rowsOf(A, "SELECT day, uid, key, n FROM usage_day WHERE kind = 'sc' ORDER BY day");
  assert.deepEqual(sc, [{ day: yday, uid: "0", key: yday, n: 3 }, { day: today, uid: "0", key: today, n: 3 }]);
  assert.equal(rowsOf(A, "SELECT COUNT(*) AS n FROM usage_day WHERE kind IN ('tr','en','ctl','tdev','sc') AND uid <> '0'")[0].n, 0);
  // a member contributing again the same day is not counted twice
  beat(0, now); A.usageFlush();
  assert.equal(A._db.prepare("SELECT n FROM usage_day WHERE kind = 'sc' AND day = ?").get(today).n, 3);
  A.close();
});

test("-114 sitewide contributor count: a restart can only under-count (the day's set restarts from members with rows that day)", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "xyz-usage-114-sc-"));
  const now = Date.now(), today = etDayStr(now);
  let A = withMembers(3, dir);
  A.usageRecord(U(0), { markets: 30000 }, "desktop", now, { tr: { "markets>trend": 1 } });
  A.close();
  A = withMembers(3, dir);
  A.usageRecord(U(0), { markets: 30000 }, "desktop", now, { tr: { "markets>trend": 1 } });
  A.usageRecord(U(1), { markets: 30000 }, "desktop", now, { tr: { "markets>trend": 1 } });
  A.usageFlush();
  assert.equal(A._db.prepare("SELECT n FROM usage_day WHERE kind = 'sc' AND day = ?").get(today).n, 2, "m0 before and after the restart is one member");
  A.close();
});

test("-114 entry tabs: capped at 200 per member per ET day and drawn from the 2,000 daily budget", () => {
  const A = withMembers(2);
  const now = Date.now();
  let n = 0;
  for (let i = 0; i < 250; i++) n += A.usageRecord(U(0), {}, null, now, { en: "trend" }).site.en;
  assert.equal(n, A.USAGE_EN_PER_DAY); assert.equal(A.USAGE_EN_PER_DAY, 200);
  // the budget: a member who spent the day's 2,000 on moves adds no entry tab
  for (let i = 0; i < 80; i++) A.usageRecord(U(1), {}, null, now, { tr: { "markets>trend": 30 } });
  assert.equal(A.usageRecord(U(1), {}, null, now, { en: "markets" }).site.en, 0);
  A.usageFlush();
  assert.deepEqual(rowsOf(A, "SELECT key, n FROM usage_day WHERE kind = 'en'"), [{ key: "trend", n: 200 }]);
  assert.equal(A._db.prepare("SELECT n FROM usage_day WHERE kind = 'tr'").get().n, A.USAGE_SITE_PER_DAY);
  A.close();
});

test("-114 retention: sitewide rows (tr, en, ctl, tdev, sc) keep 30 days; usage_mark keeps 90 — and the index exists", () => {
  const A = withMembers(1);
  const now = Date.now();
  assert.equal(A.USAGE_SITE_KEEP_DAYS, 30);
  const beat = (t) => A.usageRecord(U(0), { markets: 30000 }, "desktop", t, { tr: { "markets>trend": 1 }, en: "markets", ctl: { "markets.csv": 1 } });
  beat(now - 31 * DAY); beat(now - 29 * DAY);
  A.usageMark("gate", "markets=admin", now - 60 * DAY);
  A.usageFlush();
  A.usageRetain(now);
  const old = etDayStr(now - 31 * DAY), kept = etDayStr(now - 29 * DAY);
  assert.equal(rowsOf(A, "SELECT COUNT(*) AS n FROM usage_day WHERE uid = '0' AND day = ? AND kind IN ('tr','en','ctl','tdev','sc')", old)[0].n, 0, "31 days: gone");
  assert.deepEqual(rowsOf(A, "SELECT kind FROM usage_day WHERE uid = '0' AND day = ? AND kind IN ('tr','en','ctl','tdev','sc') ORDER BY kind", kept).map((r) => r.kind),
    ["ctl", "en", "sc", "tdev", "tr"], "29 days: kept");
  assert.equal(rowsOf(A, "SELECT COUNT(*) AS n FROM usage_mark WHERE kind = 'gate'")[0].n, 1, "a 60-day-old marker stays (90 days)");
  // 9. the index, and the regression / triage reads use it
  assert.ok(rowsOf(A, "SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'usage_day'").some((r) => r.name === "usage_day_kind"));
  for (const q of ["SELECT uid, kind, key, n FROM usage_day WHERE kind IN ('load','perf','err') AND day >= '2026-01-01'", "SELECT uid, key, SUM(n) AS n FROM usage_day WHERE kind = 'err' GROUP BY uid, key"])
    assert.ok(rowsOf(A, "EXPLAIN QUERY PLAN " + q).some((r) => /USING INDEX usage_day_kind/.test(r.detail)), q);
  A.close();
});

// ---- 6. the browser: visible-only dwell ---------------------------------------------------------------------------------
function usageModule(env) {
  const body = src("public/js/usage.js").split("\n").filter((l) => !/^import /.test(l) && !/^export \{/.test(l)).join("\n").replace(/^export function /gm, "function ");
  const e = env || {};
  return new Function("el", "esc", "state", "window", "document", "navigator", "fetch", "setInterval",
    body + "; return { US, usTr, usTrView, usTrVis, usTrTake, usageCardHtml };")(
    () => null, esc, e.state || { view: "markets" }, e.window || {}, e.document || {}, {}, () => Promise.resolve({ ok: false }), () => 0);
}
test("-114 paths: hidden time never holds a tab (the dwell clock pauses); a background-opened page has no entry tab until it is seen 2s", () => {
  const M = usageModule();
  // markets held (entry done); move to B, hide after 0.5s for an hour, come back, move to C after 0.5s: B was a bounce
  let t = M.usTr(0, "markets");
  assert.deepEqual(M.usTrTake(t, 5000), { tr: {}, en: "markets" });
  M.usTrView(t, "trend", 10000);
  M.usTrVis(t, false, 10500);
  assert.deepEqual(M.usTrTake(t, 10500), { tr: {}, en: null }, "the flush at hide: nothing settled");
  M.usTrVis(t, true, 10500 + HOUR);
  M.usTrView(t, "corr", 11000 + HOUR);
  assert.deepEqual(M.usTrTake(t, 11000 + HOUR + 2500), { tr: { "markets>corr": 1 }, en: null }, "1s of VISIBLE time on trend: a bounce, so markets→corr");
  // a tab that already held 2s before the page hid still counts
  t = M.usTr(0, "markets"); M.usTrTake(t, 3000);
  M.usTrView(t, "trend", 4000); M.usTrVis(t, false, 6500);
  assert.deepEqual(M.usTrTake(t, 6500 + HOUR), { tr: { "markets>trend": 1 }, en: null });
  // opened in the background: no entry while hidden, however long
  t = M.usTr(0, "markets", false);
  assert.deepEqual(M.usTrTake(t, HOUR), { tr: {}, en: null }, "never seen: no entry tab");
  M.usTrVis(t, true, HOUR);
  assert.deepEqual(M.usTrTake(t, HOUR + 1500), { tr: {}, en: null }, "on screen 1.5s: not yet");
  assert.deepEqual(M.usTrTake(t, HOUR + 2000), { tr: {}, en: "markets" }, "on screen 2s: the entry tab");
  // the boot and pagehide wiring feed it
  const js = src("public/js/usage.js");
  assert.ok(js.includes("US.tr=usTr(usNow(),state.view||'markets',vis);") && js.includes("if(US.tr) usTrVis(US.tr,!hidden,usNow());")
    && js.includes("if(US.tr) usTrVis(US.tr,false,usNow()); usageFlush(true);"));
});

// ---- 4. the disclosure and the fold -----------------------------------------------------------------------------------------
test("-114 disclosure and fold: the card, guide and README state the k-threshold and 30-day sitewide retention; the fold says why it withholds", () => {
  const M = usageModule({ window: { __ME: { uid: "u1" } } });
  M.US.mine = { ok: true, keepDays: 30, activeDays: 1, ms: 60000, tabs: [], acts: [] };
  const card = M.usageCardHtml(), note = between(src("public/docs.html"), "<b>Your usage.</b>", "</div>");
  for (const w of ["kept 30 days", "7 or more complete days (never today)", "at least 3 members contributed on one day", "not enough members to show without identifying someone (n&lt;3)"]) {
    assert.ok(card.includes(w), "card: " + w); assert.ok(note.includes(w), "guide: " + w);
  }
  assert.ok(!card.includes("kept 90 days") && !note.includes("kept 90 days"));
  const readme = src("README.md");
  for (const w of ["(build 2026.09.24-114)", "k ≥ 3 for the sitewide sections", "kind='sc'", "Sitewide rows kept 30 days", "operator config history, with **no\n    uid and no personal data**"])
    assert.ok(readme.includes(w), "README: " + w);
  const body = src("public/js/usageadm.js").split("\n").filter((l) => !/^import /.test(l) && !/^export \{/.test(l)).join("\n");
  const F = new Function("el", "esc", "window", "fetch", body + "; return { uaSiteHtml };")(() => null, esc, { __ME: { handle: "gus" } }, () => new Promise(() => {}));
  const k = F.uaSiteHtml({ site: { withheld: "k", threshold: { k: 3, minDays: 7, members: 2 }, keepDays: 30, nav: null, paths: null, controls: null, devices: null } });
  assert.ok(k.includes("not enough members to show without identifying someone (n&lt;3)") && !k.includes("Top transitions"), k);
  const r = F.uaSiteHtml({ site: { withheld: "range", threshold: { k: 3, minDays: 7 }, keepDays: 30, nav: null } });
  assert.ok(r.includes("Pick a range of 7 days or more"));
});

// ---- 10. the service worker --------------------------------------------------------------------------------------------------
function swRig(tabs) {
  const H = {}, shown = [], posted = [], opened = [];
  const self = { addEventListener: (t, f) => { H[t] = f; }, location: { origin: "https://app.test" }, skipWaiting() {},
    clients: { claim: async () => {}, matchAll: async () => tabs.map((x) => ({ focus() { x.focused = true; }, postMessage(m) { posted.push(m); } })), openWindow: async (u) => { opened.push(u); } },
    registration: { showNotification: async (title, o) => { shown.push(Object.assign({ title }, o)); } } };
  vm.runInNewContext(src("public/sw.js"), { self, caches: {}, fetch: async () => ({}), URL, Promise });
  const wait = async (fire) => { let p = null; fire((x) => { p = x; }); await p; };
  const push = (d) => wait((w) => H.push({ data: { json: () => d }, waitUntil: w }));
  const click = (data) => wait((w) => H.notificationclick({ notification: { data, close() {} }, waitUntil: w }));
  return { shown, posted, opened, push, click };
}
test("-114 service worker: a reminder push has its own tag and opens Markets; a DM push keeps its per-conversation tag and opens Messages", async () => {
  let r = swRig([]);
  await r.push({ title: "Milst Screener", body: "Haven't seen you", kind: "nudge" });
  await r.push({ title: "bob", body: "hi", thread: 5 });
  assert.deepEqual(r.shown.map((n) => [n.tag, n.data.kind || null, n.data.thread || null]), [["usage-nudge", "nudge", null], ["dm-5", null, 5]]);
  await r.click({ kind: "nudge" }); await r.click({ thread: 5 });
  assert.deepEqual(r.opened, ["/", "/#dm"], "no window open: the reminder opens the site root, a message opens Messages");
  r = swRig([{}]);
  await r.click({ kind: "nudge" }); await r.click({ thread: 5 });
  assert.deepEqual(r.posted, [{ go: "markets" }, { go: "dm" }], "an open window is asked to switch tabs");
  assert.ok(src("public/js/nav.js").includes("else if(d&&d.go==='markets') showView('markets');"));
  const UDG = require("../src/usage-digest");
  assert.equal(UDG.nudgeMessage("x", [], false).kind, "nudge", "the server marks the reminder payload");
});

// ---- the HTTP boundary (a stubbed Telegram, a movable clock) -------------------------------------------------------------------
function botApi() {
  const calls = [];
  const answer = (status, body) => ({ ok: status >= 200 && status < 300, status, json: async () => body });
  let next = 100;
  const stub = async (url, opts) => {
    const u = String(url);
    if (!/api\.telegram\.org/.test(u)) throw new Error("outbound network disabled in this suite: " + u);
    const method = u.slice(u.lastIndexOf("/") + 1);
    const body = JSON.parse((opts && opts.body) || "{}");
    calls.push({ method, body });
    if (method === "getUpdates") return answer(200, { ok: true, result: [] });
    return answer(200, { ok: true, result: { message_id: ++next, chat: { id: +body.chat_id } } });
  };
  return { calls, stub };
}
const API = botApi();
globalThis.fetch = API.stub;
const { buildServer, _poller } = require("../server.js");
const JSONH = { "content-type": "application/json" };
function jar() {
  const c = new Map();
  return {
    absorb(res) {
      const sc = res.headers["set-cookie"];
      for (const line of Array.isArray(sc) ? sc : (sc ? [sc] : [])) {
        const [nv, ...attrs] = line.split(";");
        const i = nv.indexOf("="), name = nv.slice(0, i).trim(), val = nv.slice(i + 1).trim();
        if (attrs.some((a) => /max-age=0/i.test(a)) || val === "x") c.delete(name); else c.set(name, val);
      }
      return res;
    },
    header() { return [...c].map(([k, v]) => k + "=" + v).join("; "); },
  };
}
let app;
const realNow = Date.now, T0 = realNow();
let skew = 0;
const post = (url, body, j, h) => app.inject({ method: "POST", url, headers: Object.assign({}, JSONH, j ? { cookie: j.header() } : {}, h || {}), payload: typeof body === "string" ? body : JSON.stringify(body) });
const get = (url, j) => app.inject({ method: "GET", url, headers: Object.assign({}, j ? { cookie: j.header() } : {}) });
test.before(async () => { Date.now = () => T0 + skew; app = await buildServer(); });
test.after(async () => { Date.now = realNow; await app.close(); });
const dbRows = (sql, ...a) => {
  const { DatabaseSync } = require("node:sqlite");
  const db = new DatabaseSync(path.join(DATA, "accounts.db"), { readOnly: true });
  try { return db.prepare(sql).all(...a).map((x) => Object.assign({}, x)); } finally { db.close(); }
};
const dbRun = (sql, ...a) => {
  const { DatabaseSync } = require("node:sqlite");
  const db = new DatabaseSync(path.join(DATA, "accounts.db"));
  try { db.prepare(sql).run(...a); } finally { db.close(); }
};
async function drain() {
  const P = _poller();
  for (let i = 0; i < 100 && P.pushStateNow().queue > 0; i++) { P.pushUnholdNow(); await P.pushDrainNow(); }
  const sent = API.calls.filter((c) => c.method === "sendMessage");
  API.calls.length = 0;
  return sent;
}
let PP = null;
async function people() {
  if (PP) return PP;
  const gus = jar();
  gus.absorb(await post("/login", { password: "break-glass-pw-1" }));
  gus.absorb(await post("/bootstrap", { handle: "gus", password: "a-long-password-12" }, gus));
  gus.absorb(await post("/login", { handle: "gus", password: "a-long-password-12" }));
  const mint = JSON.parse((await post("/api/access", { op: "mint", days: 1 }, gus)).body);
  const code = mint.code || (mint.invite && mint.invite.code);
  const bob = jar();
  bob.absorb(await get("/join/" + code, bob));
  assert.equal(bob.absorb(await post("/join", { handle: "bob", password: "another-long-pw-12" }, bob)).statusCode, 200);
  const members = JSON.parse((await get("/api/access", gus)).body).members;
  PP = { gus, bob, gusUid: members.find((m) => m.handle === "gus").uid, bobUid: members.find((m) => m.handle === "bob").uid };
  return PP;
}

test("-114 HTTP: a non-object body is a 400 on the usage POSTs (was a 500 on the digest settings)", async () => {
  const { gus, bob } = await people();
  const TEXT = { "content-type": "text/plain" };
  for (const [u, j] of [["/api/admin/usage/digest", gus], ["/api/admin/usage/errors", gus], ["/api/usage/pause", bob]]) {
    for (const body of [JSON.stringify({ nudgeOn: false }), "hello"]) {
      const r = await post(u, body, j, TEXT);
      assert.equal(r.statusCode, 400, u + " " + body + " → " + r.body); assert.equal(JSON.parse(r.body).error, "bad body");
    }
    assert.equal((await post(u, [1, 2], j)).statusCode, 400, u + " array");
  }
  assert.equal((await post("/api/admin/usage/digest", { nudgeOn: false }, gus)).statusCode, 200, "a JSON object still works");
  assert.equal(JSON.parse((await post("/api/usage/pause", { paused: false }, bob)).body).ok, true);
});

test("-114 HTTP: a nav-groups write that changes nothing adds no marker", async () => {
  const { gus } = await people();
  const navMarks = () => dbRows("SELECT detail FROM usage_mark WHERE kind = 'nav'").map((r) => r.detail);
  const n0 = navMarks().length;
  assert.equal((await post("/api/nav-groups", { view: "sectors", group: "macro" }, gus)).statusCode, 200);
  assert.equal((await post("/api/nav-groups", { view: "sectors", group: "macro" }, gus)).statusCode, 200);
  assert.equal((await post("/api/nav-groups", { key: "macro", label: "Macro stuff" }, gus)).statusCode, 200);
  assert.equal((await post("/api/nav-groups", { key: "macro", label: "Macro stuff" }, gus)).statusCode, 200);
  assert.deepEqual(navMarks().slice(n0), ["sectors>macro", "#macro"], "one marker per real change, none for the repeats");
  await post("/api/nav-groups", { key: "macro", label: "" }, gus);
});

test("-114 HTTP: a Telegram reminder holds inside the member's quiet hours (not sent, not marked) and goes on a later pass", async () => {
  const { gus, bobUid } = await people();
  const P = _poller();
  P.pushBindNow(P.pushMintCode(bobUid, false).code, 9002, "bob");
  await drain();
  dbRun("INSERT INTO usage_day (day, uid, kind, key, n, ms) VALUES (?,?,?,?,1,?) ON CONFLICT(day, uid, kind, key) DO UPDATE SET ms = excluded.ms", etDayStr(Date.now()), bobUid, "tab", "markets", 120000);
  const T = Date.now() + 9 * DAY;
  assert.equal((await post("/api/admin/usage/digest", { nudgeOn: true }, gus)).statusCode, 200);
  const h = new Date(Date.now()).getUTCHours();
  assert.equal(P.pushSetPrefs("9002", { quiet: { from: h, to: (h + 2) % 24, tz: 0 } }, null, true).ok, true);
  assert.equal(P.pushQuietNow("9002"), true);
  let r = await app.usageNudgeTick(T, true);
  assert.equal(r.sent, 0); assert.deepEqual(r.held, ["bob"]);
  assert.equal((await drain()).length, 0, "nothing queued for a sleeping chat");
  assert.equal(dbRows("SELECT COUNT(*) AS n FROM usage_nudge")[0].n, 0, "not marked: it is still owed");
  // the quiet window over: the next pass sends it, once
  P.pushSetPrefs("9002", { quiet: null }, null, true);
  r = await app.usageNudgeTick(T + HOUR, true);
  assert.deepEqual(r.to, [{ handle: "bob", via: "telegram" }]);
  assert.deepEqual((await drain()).map((c) => c.body.chat_id), ["9002"]);
  assert.equal(dbRows("SELECT COUNT(*) AS n FROM usage_nudge")[0].n, 1);
  const sv = src("server.js");
  assert.ok(between(sv, "async function usageNudgeTick(now, force) {", "\n  }").includes('tg.some((c) => poller.pushQuietNow && poller.pushQuietNow(c))'));
  await post("/api/admin/usage/digest", { nudgeOn: false }, gus);
});

test("-114 HTTP: the regression tick stops for a build that alerted every condition or is > 3 days past first-seen; triage sweeps every 10 min", async () => {
  await people();
  const VERSION = "2026.09.24-114";
  assert.notEqual(app.usageRegressTick().state, "done", "a fresh build is checked");
  for (const k of ["new-errors", "err-rate", "perf"]) dbRun("INSERT INTO usage_mark (at, kind, detail) VALUES (?, 'alert', ?)", Date.now(), VERSION + "|" + k);
  assert.deepEqual(app.usageRegressTick(), { state: "done", sent: 0, why: "alerted" });
  dbRun("DELETE FROM usage_mark WHERE kind = 'alert'");
  assert.notEqual(app.usageRegressTick().state, "done");
  skew += 3 * DAY + HOUR;
  assert.deepEqual(app.usageRegressTick(), { state: "done", sent: 0, why: "age" });
  const tick = between(src("server.js"), "function usageRegressTick(now) {", "\n  }");
  assert.ok(tick.includes("if (t - usageTriageAt >= USAGE_TRIAGE_EVERY_MS) { usageTriageAt = t; ACCOUNTS.usageTriageSweep(t); }") && src("server.js").includes("USAGE_TRIAGE_EVERY_MS = 10 * 60000"));
  assert.ok(src("server.js").includes('const VERSION = "2026.09.24-114"'));
});
