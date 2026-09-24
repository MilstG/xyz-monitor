"use strict";
// ===== build 2026.09.24-111: Usage — deploy/gate markers, post-deploy regression alerts, error triage,
// client-side hour buckets, persisted stale builds, monthly trend rows ==================================
// A. markers: a build's first boot, a feature-flag write that moved a gate, a tab moved between menus;
//    the marker list's before/after reach for the affected tab (7 ET days each side, or since; the
//    change day in neither; clipped to the 30-day per-member window).
// B. the regression check: ready at 20 page loads or 2h; new errors (≥2 members), errors per load
//    (≥3×, with minimum counts), p75 paint (≥30% AND ≥300ms); one alert per build per condition,
//    deduped by a usage_mark row that survives a restart.
// C. triage: per signature (file + message hash, across builds and line moves); resolve / reopen;
//    a newer build's hit reopens as "regressed", a stale tab on the old build does not.
// Plus: the beacon's per-hour buckets (validated to the gate's wall-time window), the per-member
// last build persisted with the flush, and the monthly 'mo' rows (kept 2 months) behind the 30d trend.
const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs"), path = require("path"), os = require("os");

const DATA = fs.mkdtempSync(path.join(os.tmpdir(), "xyz-usage-111-"));
process.env.DATA_DIR = DATA;
delete process.env.SITE_PASSWORD;
process.env.ADMIN_PASSWORD = "break-glass-pw-1";
process.env.XYZ_QUIET = "1";
process.env.XYZ_NO_NET = "1";
delete process.env.TG_BOT_TOKEN; delete process.env.FINNHUB_TOKEN; delete process.env.FRED_KEY;
delete process.env.USAGE_PUBLIC; delete process.env.OPENAI_API_KEY; delete process.env.ANTHROPIC_API_KEY;

const { openAccounts } = require("../src/accounts");
const { createUsageGate } = require("../src/usage-gate");
const { etDayStr, etParts } = require("../src/compute");
const src = (rel) => fs.readFileSync(path.join(__dirname, "..", rel), "utf8");
const between = (s, a, b) => { const i = s.indexOf(a); assert.ok(i >= 0, a); return s.slice(i, s.indexOf(b, i + a.length) + b.length); };
const DAY = 864e5, HOUR = 3600e3, MIN = 60000;
const TABS = [{ key: "markets", label: "Markets", gate: "public" }, { key: "trend", label: "Trend", gate: "public" }];
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const dayShift = (d, n) => new Date(Date.UTC(+d.slice(0, 4), +d.slice(5, 7) - 1, +d.slice(8, 10)) + n * DAY).toISOString().slice(0, 10);
const U = (i) => "uid-m" + String(i).padStart(12, "0");

function withMembers(n, dir) {
  const A = openAccounts(dir || fs.mkdtempSync(path.join(os.tmpdir(), "xyz-usage-111-acc-")));
  for (let i = 0; i < n; i++)
    A._db.prepare("INSERT OR IGNORE INTO user (uid, handle, display, pw, epoch, isAdmin, createdAt, lastSeen) VALUES (?,?,?,?,1,0,?,0)").run(U(i), "m" + i, "m" + i, "x", Date.now() - 200 * DAY);
  A.hydrate();
  return A;
}
const count = (A, sql, ...a) => A._db.prepare(sql).get(...a).n;

// ---- A. markers ---------------------------------------------------------------------------------------
test("-111 markers: a build's first boot is one deploy marker (a re-deploy is not); usage_build.at is its first-seen time; gate/nav rows are capped, all prune at 90 days", () => {
  const now = Date.now();
  const A = withMembers(1);
  A.usageBuildSeen("B1", now - 3 * DAY); A.usageBuildSeen("B1", now - DAY); A.usageBuildSeen("B2", now);
  assert.deepEqual(A._db.prepare("SELECT detail FROM usage_mark WHERE kind = 'deploy' ORDER BY at").all().map((r) => r.detail), ["B1", "B2"]);
  assert.deepEqual(A.usageBuildInfo(), [{ build: "B2", firstSeen: now }, { build: "B1", firstSeen: now - 3 * DAY }], "first seen kept through the re-deploy");
  assert.equal(A.usageMark("nope", "x"), false, "unknown kinds are refused");
  for (let i = 0; i < 405; i++) A.usageMark("gate", "k" + i + "=admin", now - 10 * DAY + i);
  assert.equal(count(A, "SELECT COUNT(*) AS n FROM usage_mark WHERE kind IN ('gate','nav')"), 400, "an admin toggling in a loop cannot grow the table");
  assert.equal(count(A, "SELECT COUNT(*) AS n FROM usage_mark WHERE kind = 'gate' AND detail = 'k0=admin'"), 0, "the oldest went");
  assert.equal(count(A, "SELECT COUNT(*) AS n FROM usage_mark WHERE kind = 'deploy'"), 2, "the cap never touches deploy rows");
  A.usageMark("deploy", "B0\u0000<b>", now - 91 * DAY); A.usageMark("alert", "B0|perf", now - 89 * DAY);
  assert.equal(A._db.prepare("SELECT detail FROM usage_mark WHERE at = ?").get(now - 91 * DAY).detail, "B0 <b>", "control characters stripped (esc() is the reader's job)");
  const r = A.usageRetain(now);
  assert.equal(r.marks, 1, "the 91-day-old marker pruned");
  assert.equal(count(A, "SELECT COUNT(*) AS n FROM usage_mark WHERE detail = 'B0|perf'"), 1, "89 days: kept");
  assert.ok(!A._db.prepare("PRAGMA table_info(usage_mark)").all().some((c) => /uid/i.test(c.name)), "config history: no uid column");
  A.close();
});

test("-111 markers: before/after reach for the affected tab — 7 ET days each side (the change day in neither), 'since' when fewer, clipped to the per-member window", () => {
  const now = Date.now(), today = etDayStr(now);
  const A = withMembers(8);
  const rec = (i, daysAgo, trend) => A.usageRecord(U(i), trend ? { markets: 70000, trend: 5000 } : { markets: 70000 }, "desktop", now - daysAgo * DAY);
  // the change 10 days ago: before = days 17..11 ago, after = days 9..3 ago
  A.usageMark("gate", "trend=admin", now - 10 * DAY);
  rec(0, 12, true); rec(1, 13, true); rec(2, 15, true); rec(3, 16, false);      // before: 4 active, 3 on Trend
  rec(0, 10, true); rec(4, 10, true);                                             // the change day: neither side
  rec(0, 5, false); rec(1, 4, false); rec(2, 8, false); rec(4, 9, false); rec(5, 3, true);   // after: 5 active, 1 on Trend
  A.usageRecord(U(6), { trend: 20000 }, "desktop", now - 4 * DAY);                // on Trend but never active that window: not counted
  A.usageMark("nav", "trend>macro", now - 2 * DAY);                               // 'since': 1 day so far (yesterday)
  A.usageMark("gate", "trend=public", now);                                       // today: no after yet
  A.usageMark("gate", "ai-report=off", now - DAY);                                // not a tab: no reach
  A.usageMark("nav", "#tape", now - DAY);                                         // a menu rename: no tab
  A.usageMark("gate", "trend=off", now - 25 * DAY);                               // before clipped to the 30-day window
  A.usageMark("gate", "trend=members", now - 40 * DAY);                           // past the window: nothing to compare
  A.usageFlush();
  const M = A.usageSummary({ r: 7, tabs: TABS, now }).marks;
  const at = (daysAgo, kind) => M.find((m) => m.at === now - daysAgo * DAY && m.kind === kind);
  const m10 = at(10, "gate");
  assert.equal(m10.tab, "trend"); assert.equal(m10.tabLabel, "Trend"); assert.equal(m10.day, etDayStr(now - 10 * DAY));
  assert.deepEqual(m10.before, { from: dayShift(m10.day, -7), to: dayShift(m10.day, -1), days: 7, active: 4, users: 3, reach: 0.75 });
  assert.deepEqual(m10.after, { from: dayShift(m10.day, 1), to: dayShift(m10.day, 7), days: 7, active: 5, users: 1, reach: 0.2 });
  const m2 = at(2, "nav");
  assert.equal(m2.tab, "trend"); assert.equal(m2.after.days, 2, "since the day after: yesterday and today"); assert.equal(m2.after.to, today);
  assert.equal(at(0, "gate").after, null, "a change today has no 'after' until tomorrow");
  const ai = at(1, "gate"), ren = M.find((m) => m.detail === "#tape");
  assert.equal(ai.tab, null); assert.equal(ai.before, undefined); assert.equal(ren.tab, null);
  const m25 = at(25, "gate");
  assert.equal(m25.before.days, 4, "clipped: only the days still kept per member"); assert.equal(m25.before.from, dayShift(today, -29));
  const m40 = at(40, "gate");
  assert.equal(m40.before, null); assert.equal(m40.after, null);
  assert.ok(M.every((m, i) => i === 0 || M[i - 1].at >= m.at), "newest first");
  assert.equal(A.usageSummary({ r: 30, tabs: TABS, now, lite: true }).marks, null, "the lite summary skips them");
  A.close();
});

// ---- B. the regression check ----------------------------------------------------------------------------
// A fresh store with the previous build P live since 5 days ago and the current C since `age` ago.
function scen(age) {
  const now = Date.now();
  const A = withMembers(6);
  A.usageBuildSeen("P", now - 5 * DAY); A.usageBuildSeen("C", now - age);
  const loads = (b, n, t) => { for (let i = 0; i < n; i++) A.usageRecord(U(i % 6), {}, null, t || now, { build: b, load: true }); };
  const err = (b, i, e, c) => A.usageRecord(U(i), {}, null, now, { build: b, errs: [Object.assign({ c: c || 1 }, e)] });
  const perf = (b, ms, n) => { for (let i = 0; i < n; i++) A.usageRecord(U(i % 6), {}, null, now, { build: b, perf: ms }); };
  return { A, now, loads, err, perf, reg: () => A.usageRegress("C", now) };
}
test("-111 regression: ready at 20 page loads OR 2h live; compared with the previous known build that had traffic", () => {
  let s = scen(HOUR);
  s.loads("P", 30, s.now - 2 * DAY); s.loads("C", 19);
  let v = s.reg();
  assert.equal(v.state, "collecting"); assert.equal(v.loads, 19); assert.equal(v.ready, false); assert.deepEqual(v.need, { loads: 20, ageMs: 2 * HOUR });
  s.loads("C", 1);
  v = s.reg();
  assert.equal(v.state, "ok", "20 loads: decided"); assert.equal(v.prev, "P"); assert.equal(v.checks.loadsPrev, 30);
  s.A.close();
  s = scen(2 * HOUR);
  s.loads("P", 20, s.now - DAY); s.loads("C", 2);
  assert.equal(s.reg().state, "ok", "2h live: decided on whatever loads there are (the BASELINE still needs 20 — build 2026.09.24-114)");
  s.A.close();
  // no earlier build with traffic: nothing to compare against — never an alarm
  s = scen(3 * HOUR);
  s.loads("C", 25); s.err("C", 0, { msg: "boom", loc: "/js/a.js:1" }); s.err("C", 1, { msg: "boom", loc: "/js/a.js:1" });
  v = s.reg();
  assert.equal(v.state, "no-baseline"); assert.deepEqual(v.conds, []);
  assert.equal(s.A.usageRegress("nope", s.now).state, "unknown");
  s.A.close();
  // a build that never served traffic is skipped for the comparison; builds before -111 count paint samples as loads
  const now = Date.now(), A = withMembers(2);
  A.usageBuildSeen("P", now - 5 * DAY); A.usageBuildSeen("Q", now - 4 * DAY); A.usageBuildSeen("C", now - 3 * HOUR);
  for (let i = 0; i < 22; i++) A.usageRecord(U(0), {}, null, now - 4.5 * DAY, { build: "P", perf: 900 });
  v = A.usageRegress("C", now);
  assert.equal(v.prev, "P", "Q, deployed between them, had no traffic: P is the comparison");
  assert.equal(v.checks.loadsPrev, 22, "P never counted loads: its 22 paint samples stand in");
  A.close();
});

test("-111 regression thresholds: new errors need ≥2 members and a signature the previous build never hit; errors/load ≥3× with minimum counts; p75 ≥30% AND ≥300ms", () => {
  // new errors
  let s = scen(3 * HOUR);
  s.loads("P", 25, s.now - DAY); s.loads("C", 25);
  s.err("P", 0, { msg: "old bug", loc: "/js/b.js:10" }, 10);   // (enough before that the rate stays under 3×)
  s.err("C", 0, { msg: "old bug", loc: "/js/b.js:14" }); s.err("C", 1, { msg: "old bug", loc: "/js/b.js:14" });   // same signature, its line moved
  s.err("C", 2, { msg: "solo", loc: "/js/c.js:1" }, 9);                                                        // one member only
  assert.equal(s.reg().state, "ok", "an old error on a moved line, and a new one only one member hit: no alarm");
  s.err("C", 3, { msg: "solo", loc: "/js/c.js:1" });
  let v = s.reg();
  assert.equal(v.state, "regression"); assert.equal(v.conds.length, 1);
  assert.equal(v.conds[0].kind, "new-errors"); assert.equal(v.conds[0].n, 1);
  const top = v.conds[0].top;
  assert.match(top.sig, /^\/js\/c\.js\|[0-9a-f]{12}$/);
  assert.deepEqual([top.loc, top.msg, top.members, top.hits], ["/js/c.js:1", "solo", 2, 10]);
  s.A.close();
  // error hits per page load (on a signature both builds have, so only the rate can fire)
  const rateCase = (prevHits, curHits, curLoads) => {
    const t = scen(3 * HOUR);
    t.loads("P", 30, t.now - DAY); t.loads("C", curLoads);
    if (prevHits) t.err("P", 0, { msg: "flaky", loc: "/js/f.js:1" }, prevHits);
    t.err("C", 0, { msg: "flaky", loc: "/js/f.js:2" }, curHits);
    const r = t.reg(); t.A.close(); return r;
  };
  assert.equal(rateCase(10, 19, 20).state, "ok", "0.95 vs 0.33 per load = 2.85×: under 3×");
  v = rateCase(10, 20, 20);
  assert.equal(v.state, "regression"); assert.equal(v.conds[0].kind, "err-rate"); assert.equal(v.conds[0].x.toFixed(2), "3.00");
  assert.equal(rateCase(0, 9, 20).state, "ok", "zero before counts as one hit — and 9 hits is under the 10-hit minimum");
  assert.equal(rateCase(0, 10, 20).conds[0].kind, "err-rate", "10 hits against one-in-30: 15×");
  assert.equal(rateCase(1, 40, 19).loads, 19);
  assert.equal(rateCase(1, 40, 19).state, "ok", "19 loads on this build: under the 20-load minimum for the rate (and 3h live makes it ready)");
  // p75 first paint: bucket midpoints — 1000ms → 1050, 1400ms → 1450 (+38%, +400ms)
  const perfCase = (prev, cur, nCur) => { const t = scen(3 * HOUR); t.loads("P", 25, t.now - DAY); t.loads("C", 25); t.perf("P", prev, 10); t.perf("C", cur, nCur || 10); const r = t.reg(); t.A.close(); return r; };
  v = perfCase(1000, 1400);
  assert.equal(v.state, "regression"); assert.deepEqual(v.conds, [{ kind: "perf", p75: 1450, p75Prev: 1050 }]);
  assert.equal(perfCase(1000, 1300).state, "ok", "1350 vs 1050: +29%");
  assert.equal(perfCase(200, 450).state, "ok", "250 → 500: +100% but only 250ms");
  assert.equal(perfCase(300, 600).state, "regression", "350 → 650: exactly +300ms and +86%");
  assert.equal(perfCase(1000, 1400, 9).state, "ok", "9 samples on this build: not enough");
  assert.equal(perfCase(1000, 1400, 9).checks.p75, null);
});

test("-111 regression dedupe: one alert per build per condition, persisted — a restart never re-sends", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "xyz-usage-111-dd-"));
  let A = withMembers(1, dir);
  assert.equal(A.usageAlertOnce("B7", "perf"), true);
  assert.equal(A.usageAlertOnce("B7", "perf"), false, "again: no");
  assert.equal(A.usageAlertOnce("B7", "new-errors"), true, "another condition: its own alert");
  assert.equal(A.usageAlertOnce("B8", "perf"), true, "another build: its own alert");
  A.close();
  A = withMembers(0, dir);
  assert.equal(A.usageAlertOnce("B7", "perf"), false, "after a restart: still sent");
  assert.equal(A.usageAlertOnce("B7", "err-rate"), true);
  assert.deepEqual(A._db.prepare("SELECT detail FROM usage_mark WHERE kind = 'alert' ORDER BY rowid").all().map((r) => r.detail),
    ["B7|perf", "B7|new-errors", "B8|perf", "B7|err-rate"], "the claim is the marker row");
  A.close();
});

// ---- C. triage ----------------------------------------------------------------------------------------------
test("-111 triage: one row per signature across builds and line moves; resolve / reopen; a newer build's hit reopens as regressed, a stale tab's does not", () => {
  const now = Date.now();
  const A = withMembers(4);
  A.usageBuildSeen("B1", now - 5 * DAY); A.usageBuildSeen("B2", now - 2 * DAY);
  const hit = (i, b, loc, t, c) => A.usageRecord(U(i), {}, null, t, { build: b, errs: [{ msg: "Cannot read x", loc, c: c || 1 }] });
  hit(0, "B1", "/js/a.js:10", now - 4 * DAY, 3); hit(1, "B1", "/js/a.js:10", now - 3 * DAY);
  hit(2, "B2", "/js/a.js:12", now - DAY);                        // the same bug, its line moved in B2
  A.usageRecord(U(0), {}, null, now - HOUR, { build: "B2", errs: [{ msg: "other", loc: "/js/z.js:1", c: 1 }] });
  let T = A.usageTriage(now);
  assert.equal(T.total, 2); assert.equal(T.open, 2);
  const row = T.rows.find((r) => r.msg === "Cannot read x");
  assert.match(row.sig, /^\/js\/a\.js\|[0-9a-f]{12}$/);
  assert.deepEqual([row.firstBuild, row.lastBuild, row.builds, row.hits, row.members, row.loc], ["B1", "B2", 2, 5, 3, "/js/a.js:12"]);
  assert.equal(row.firstAt, now - 4 * DAY); assert.equal(row.lastAt, now - DAY);
  assert.equal(T.rows[0].msg, "other", "newest first among the open ones");
  // resolve: stamped with its latest build (B2)
  assert.deepEqual(A.usageTriageSet(row.sig, true, now), { ok: true, sig: row.sig, resolved: true });
  T = A.usageTriage(now + 1);
  assert.equal(T.open, 1); assert.equal(T.rows[T.rows.length - 1].sig, row.sig, "resolved ones sink");
  // a stale tab still on B2 (and one on B1) hits it again: stays resolved
  hit(3, "B2", "/js/a.js:12", now + 10); hit(0, "B1", "/js/a.js:10", now + 11);
  assert.equal(A.usageTriage(now + 20).rows.find((r) => r.sig === row.sig).resolved, true, "old builds never reopen it");
  // a newer build hits it: reopened, flagged regressed (and persisted — the sweep wrote it)
  A.usageBuildSeen("B3", now + 30);
  hit(1, "B3", "/js/a.js:40", now + 40);
  assert.equal(A.usageTriageSweep(now + 50), 1);
  const r3 = A.usageTriage(now + 60).rows[0];
  assert.deepEqual([r3.sig, r3.resolved, r3.regressed, r3.regressedBuild, r3.lastBuild], [row.sig, false, true, "B3", "B3"], "regressed rows lead the list");
  assert.equal(A._db.prepare("SELECT regressedBuild FROM usage_triage WHERE sig = ?").get(row.sig).regressedBuild, "B3");
  // resolving again clears the flag; un-resolving deletes the row
  A.usageTriageSet(row.sig, true, now + 70);
  assert.deepEqual(A._db.prepare("SELECT resolvedBuild, regressedAt FROM usage_triage WHERE sig = ?").get(row.sig), { resolvedBuild: "B3", regressedAt: null });
  A.usageTriageSet(row.sig, false, now + 80);
  assert.equal(count(A, "SELECT COUNT(*) AS n FROM usage_triage"), 0);
  // validation: a signature shape, and one usage_err holds
  assert.deepEqual(A.usageTriageSet("<script>|x", true), { ok: false, error: "bad error id" });
  assert.deepEqual(A.usageTriageSet("/js/none.js|0123456789ab", true), { ok: false, error: "no such error" });
  // retention: a triage row whose error left usage_err goes with the fold
  A.usageTriageSet(row.sig, true, now + 90);
  A._db.prepare("DELETE FROM usage_err WHERE loc LIKE '/js/a.js:%'").run();
  assert.equal(A.usageRetain(now + 100).triage, 1);
  A.close();
});

// ---- the beacon's hour buckets -------------------------------------------------------------------------------
test("-111 hours: the store files each bucket under its own ET day and weekday-hour, scaled to the accepted time; the rest lands in the arrival hour", () => {
  const A = withMembers(1);
  const t = Math.floor(Date.now() / HOUR) * HOUR + 30 * 1000;   // 30s into an hour
  const h = t / HOUR | 0;
  const key = (ms) => { const p = etParts(ms); return p.wd + "-" + String(p.h).padStart(2, "0"); };
  A.usageRecord(U(0), { markets: 60000 }, "desktop", t, { hrs: { [h - 1]: 50000, [h]: 30000 } });   // claims 80s: scaled to 60s
  A.usageRecord(U(0), { markets: 10000 }, "desktop", t, { hrs: { [h - 500]: 10000, x: 5 } });       // far past / junk: the arrival hour
  A.usageRecord(U(0), { markets: 20000 }, "desktop", t, { hrs: { [h]: 5000 } });                    // partial: the rest to the arrival hour
  A.usageFlush();
  const rows = A._db.prepare("SELECT day, key, ms FROM usage_day WHERE kind = 'hr' ORDER BY key").all().map((r) => [r.day, r.key, r.ms]);
  const prev = [etDayStr((h - 1) * HOUR), key((h - 1) * HOUR)], cur = [etDayStr(t), key(t)];
  const want = new Map([[prev.join("|"), 37500], [cur.join("|"), 22500 + 10000 + 20000]]);
  assert.equal(rows.length, 2, JSON.stringify(rows));
  for (const [d, k, ms] of rows) assert.equal(ms, want.get(d + "|" + k), d + " " + k);
  assert.equal(rows.reduce((s, r) => s + r[2], 0), 90000, "never more heat than tab time");
  A.close();
});

test("-111 hours at the gate: only the hours of this accept's wall-time window survive (±1 min for a skewed clock), scaled to the accepted time; merged when held", () => {
  const g = createUsageGate();
  const t0 = 1000 * HOUR + 70 * 1000;   // 70s into hour 1000
  const P = (ms, hrs, extra) => Object.assign({ tabs: { markets: ms }, acts: {}, perf: null, errs: [], build: "B", hrs }, extra || {});
  const a = g.offer("u", "s1", P(60000, { 999: 40000, 1000: 20000, 990: 5000, 1002: 1000 }, { load: true }), t0).accept;
  assert.deepEqual(a.hrs, { 999: 40000, 1000: 20000 }, "hours outside [now - 2 min - 1 min, now + 1 min] are dropped");
  assert.equal(a.load, true);
  // 60s later: the window is the 60s since this session's last accepted beacon (+1 min slack)
  const b = g.offer("u", "s1", P(60000, { 999: 30000, 1000: 60000 }, { load: true }), t0 + 60000).accept;
  assert.deepEqual(b.hrs, { 1000: 60000 }, "hour 999 ended 2m10s ago: outside a 60s + 60s window");
  assert.equal(b.load, false, "one page load per page session");
  // held and merged: buckets add up, then scale to the clamped time
  const t1 = t0 + 10 * 60000;
  g.offer("u", "s2", P(1000, { 1000: 1000 }), t1);
  assert.ok(g.offer("u", "s2", P(4000, { 1000: 4000 }), t1 + 5000).held);
  const c = g.offer("u", "s2", P(30000, { 1000: 30000 }), t1 + 35000).accept;
  assert.equal(c.tabs.markets, 34000); assert.deepEqual(c.hrs, { 1000: 34000 });
  const d = g.offer("u", "s2", P(50000, { 1000: 50000 }), t1 + 35000 + 31000).accept;
  assert.equal(d.tabs.markets, 31000); assert.deepEqual(d.hrs, { 1000: 31000 }, "scaled with the wall-time clamp");
});

test("-111 client: the accumulator splits its spans at clock-hour boundaries; the flush carries them as h and a first-beacon ld", () => {
  const body = src("public/js/usage.js").split("\n").filter((l) => !/^import /.test(l) && !/^export \{/.test(l)).join("\n").replace(/^export function /gm, "function ");
  const sent = [];
  const win = { __ME: { uid: "u1", handle: "bob", usagePaused: false }, addEventListener() {}, matchMedia: () => ({ matches: false }) };
  const M = new Function("el", "esc", "state", "window", "document", "navigator", "fetch", "setInterval", "location", "performance",
    body + "; return { US, usAcc, usTake, usTakeHr, usGive, usSetTab, usageFlush, usageCardHtml, __boot_usage_1 };")(
    () => null, esc, { view: "markets", bootBuild: "B" }, win, { visibilityState: "visible", addEventListener() {} },
    { sendBeacon: (u, b) => { sent.push(JSON.parse(b)); return true; } }, () => Promise.resolve({ ok: false }), () => 0,
    { href: "https://site.test/", origin: "https://site.test" }, { now: () => 900 });
  const a = M.usAcc(HOUR - 30000, "markets", true);
  M.usSetTab(a, "trend", HOUR + 10000);
  assert.deepEqual(M.usTake(a, HOUR + 20000), { markets: 40000, trend: 10000 });
  assert.deepEqual(M.usTakeHr(a), { 0: 30000, 1: 20000 }, "30s before the hour, 20s after");
  assert.deepEqual(M.usTakeHr(a), {}, "taken once");
  M.usGive(a, { markets: 5 }, { 1: 5 }); assert.deepEqual(a.hr, { 1: 5 }, "a failed flush puts the hours back too");
  const real = Date.now; let t = 7 * HOUR - 20000; Date.now = () => t;
  try {
    M.__boot_usage_1();
    t += 45000; assert.equal(M.usageFlush(false), true);
    t += 45000; assert.equal(M.usageFlush(false), true);
  } finally { Date.now = real; }
  assert.deepEqual(sent[0].h, { 6: 20000, 7: 25000 }); assert.equal(sent[0].ld, 1);
  assert.deepEqual(sent[1].h, { 7: 45000 }); assert.equal(sent[1].ld, undefined, "the page load is counted once");
});

// ---- stale builds, persisted -----------------------------------------------------------------------------------
test("-111 stale builds: the last build per member is written with the flush and survives a restart; unknown uids and paused members are not counted", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "xyz-usage-111-st-"));
  let A = withMembers(4, dir);
  const now = Date.now();
  assert.equal(A.usageLastBuild(U(0), "OLD", now), true);
  A.usageLastBuild(U(1), "OLD", now - 2 * HOUR);     // outside the hour
  A.usageLastBuild(U(2), "NEW", now);
  A.usageLastBuild(U(3), "OLD", now);
  assert.equal(A.usageLastBuild("uid-nobody-000000", "OLD", now), false, "only members: bounded by the member count");
  assert.equal(A.usageLastBuild(U(0), "<bad build>", now), false);
  A.setUsagePaused(U(3), true);
  assert.equal(A.usageStale("NEW", now, HOUR), 1);
  A.usageFlush();
  assert.equal(count(A, "SELECT COUNT(*) AS n FROM usage_last"), 4);
  A.close();
  A = withMembers(0, dir);
  assert.equal(A.usageStale("NEW", now + 1000, HOUR), 1, "the restart kept it");
  A.usageLastBuild(U(0), "NEW", now + 2000); A.usageFlush(); A.close();
  A = withMembers(0, dir);
  assert.equal(A.usageStale("NEW", now + 3000, HOUR), 0);
  assert.equal(A.usageRetain(now + 2 * DAY).ok, true);
  assert.equal(count(A, "SELECT COUNT(*) AS n FROM usage_last"), 0, "a day-old row says nothing: pruned");
  A.close();
  const sv = src("server.js");
  assert.ok(!sv.includes("const usageBuild = new Map()"), "the in-memory map in server.js is gone");
  assert.ok(sv.includes("ACCOUNTS.usageLastBuild(me.uid, c.rawBuild, now)") && sv.includes("ACCOUNTS.usageStale(VERSION"));
});

// ---- monthly rows ----------------------------------------------------------------------------------------------------
test("-111 monthly rows: incremental ms and active days (a day counts once, however its minutes are split), exempt from the fold, kept this month and last", () => {
  const A = withMembers(2);
  const now = Date.now(), m = etDayStr(now).slice(0, 7);
  A.usageRecord(U(0), { markets: 40000 }, "desktop", now); A.usageFlush();
  A.usageRecord(U(0), { markets: 30000 }, "desktop", now); A.usageFlush();   // crosses the minute now
  A.usageRecord(U(0), { markets: 30000 }, "desktop", now); A.usageFlush();   // already active
  const mo = () => A._db.prepare("SELECT key, n, ms FROM usage_day WHERE kind = 'mo' AND uid = ? ORDER BY key").all(U(0)).map((r) => [r.key, r.n, r.ms]);
  assert.deepEqual(mo().filter((r) => r[0] === m), [[m, 1, 100000]]);
  // 70 days back is always two months or more back; 35 days back may be last month or the one before
  A.usageRecord(U(0), { markets: 90000 }, "desktop", now - 70 * DAY); A.usageFlush();
  const old = etDayStr(now - 70 * DAY).slice(0, 7);
  assert.ok(mo().some((r) => r[0] === old));
  const r = A.usageRetain(now);
  assert.ok(r.dropped >= 1, "the daily row folded");
  assert.ok(!mo().some((x) => x[0] === old), "the month before last: dropped");
  assert.deepEqual(mo().filter((x) => x[0] === m), [[m, 1, 100000]], "this month survives the fold");
  assert.equal(count(A, "SELECT COUNT(*) AS n FROM usage_day WHERE kind = 'mo' AND uid = '0'"), 0, "never folded into the sitewide bucket");
  assert.equal(A.USAGE_MO_KEEP, 2);
  // the member's own card and the drill-in see the months kept
  const mine = A.usageMine(U(0), TABS);
  assert.deepEqual(mine.months[0], { key: m, ms: 100000, days: 1 });
  A.close();
});

test("-111 monthly rows: the 30d member trend is month over month per covered day; the backfill at open covers what the daily rows hold", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "xyz-usage-111-mo-"));
  let A = withMembers(3, dir);
  const FIX = Date.UTC(2026, 8, 24, 16);   // 2026-09-24 noon ET: 24 days into September
  const put = A._db.prepare("INSERT OR REPLACE INTO usage_day (day, uid, kind, key, n, ms) VALUES (?, ?, 'mo', ?, ?, ?)");
  put.run("2026-09-01", U(0), "2026-09", 20, 24 * 10 * MIN);   // 10 min / day this month
  put.run("2026-08-01", U(0), "2026-08", 25, 31 * 5 * MIN);    // 5 min / day last month
  put.run("2026-09-01", U(1), "2026-09", 3, 24 * 2 * MIN);
  A._db.prepare("UPDATE usage_mark SET detail = '2026-07-15' WHERE kind = 'mo-start'").run();
  let S = A.usageSummary({ r: 30, tabs: TABS, now: FIX });
  const tr = (h) => S.members.find((x) => x.handle === h).trend;
  assert.equal(S.trendBasis, "month"); assert.deepEqual(S.moDays, { cur: 24, prev: 31 });
  assert.equal(tr("m0"), 1, "10 vs 5 min per day: +100%");
  assert.equal(tr("m1"), null, "no last month: blank"); assert.equal(tr("m2"), null);
  // the rows only began mid-August: last month is read per COVERED day
  A._db.prepare("UPDATE usage_mark SET detail = '2026-08-17' WHERE kind = 'mo-start'").run();
  S = A.usageSummary({ r: 30, tabs: TABS, now: FIX });
  assert.deepEqual(S.moDays, { cur: 24, prev: 15 });
  assert.equal(tr("m0").toFixed(4), ((10 * 24 * MIN / 24) / (31 * 5 * MIN / 15) - 1).toFixed(4));
  assert.equal(A.usageSummary({ r: 30, tabs: TABS, now: Date.UTC(2026, 8, 3, 16) }).members.find((x) => x.handle === "m0").trend, null, "3 days into a month: blank until a week");
  assert.equal(A.usageSummary({ r: 7, tabs: TABS, now: FIX }).trendBasis, "range", "7d keeps the per-member prior range");
  // backfill: no monthly rows at open → summed from the kept daily rows, and the first day covered is written down
  const now = Date.now();
  A.usageRecord(U(2), { markets: 90000 }, "desktop", now - 3 * DAY); A.usageRecord(U(2), { markets: 30000 }, "desktop", now - 2 * DAY);
  A.usageFlush();
  A._db.prepare("DELETE FROM usage_day WHERE kind = 'mo'").run();
  A._db.prepare("DELETE FROM usage_mark WHERE kind = 'mo-start'").run();
  A.close();
  A = withMembers(0, dir);
  const got = A._db.prepare("SELECT key, n, ms FROM usage_day WHERE kind = 'mo' AND uid = ?").all(U(2));
  assert.equal(got.reduce((s, r) => s + r.ms, 0), 120000); assert.equal(got.reduce((s, r) => s + r.n, 0), 1, "one day over a minute");
  assert.equal(A._db.prepare("SELECT detail FROM usage_mark WHERE kind = 'mo-start'").get().detail, etDayStr(now - 3 * DAY));
  A.close();
});

// ---- the HTTP boundary --------------------------------------------------------------------------------------------------
const PREV = "2026.09.24-110";
{ const A0 = openAccounts(DATA); A0.usageBuildSeen(PREV, Date.now() - 7 * DAY); A0.close(); }
const { buildServer } = require("../server.js");
const VERSION = /const VERSION = "([^"]+)"/.exec(src("server.js"))[1];
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
const post = (url, body, j, h) => app.inject({ method: "POST", url, headers: Object.assign({}, JSONH, j ? { cookie: j.header() } : {}, h || {}), payload: typeof body === "string" ? body : JSON.stringify(body) });
const get = (url, j) => app.inject({ method: "GET", url, headers: Object.assign({}, j ? { cookie: j.header() } : {}) });
const realNow = Date.now, T0 = realNow();
let skew = 0;
test.before(async () => { Date.now = () => T0 + skew; app = await buildServer(); });
test.after(async () => { Date.now = realNow; await app.close(); });
let PP = null;
async function people() {
  const gus = jar();
  gus.absorb(await post("/login", { password: "break-glass-pw-1" }));
  gus.absorb(await post("/bootstrap", { handle: "gus", password: "a-long-password-12" }, gus));
  gus.absorb(await post("/login", { handle: "gus", password: "a-long-password-12" }));
  const mint = JSON.parse((await post("/api/access", { op: "mint", days: 1 }, gus)).body);
  const code = mint.code || (mint.invite && mint.invite.code);
  const bob = jar();
  bob.absorb(await get("/join/" + code, bob));
  assert.equal(bob.absorb(await post("/join", { handle: "bob", password: "another-long-pw-12" }, bob)).statusCode, 200);
  return { gus, bob };
}
const who = async () => (PP = PP || await people());
let sid = 0;
const nextSid = () => "sess111" + String(++sid).padStart(6, "0");
const usage = async (j) => JSON.parse((await get("/api/admin/usage?r=7", j)).body);

test("-111 HTTP: a gate write that moves the resolved state is a marker (a same-state write is not); a menu move is one; the chart data carries them", async () => {
  const { gus } = await who();
  const before = (await usage(gus)).marks;
  assert.ok(before.some((m) => m.kind === "deploy" && m.detail === VERSION), "this build's first boot");
  assert.equal((await post("/api/features", { key: "sectors", state: "admin" }, gus)).statusCode, 200);
  assert.equal((await post("/api/features", { key: "sectors", state: "admin" }, gus)).statusCode, 200);
  assert.equal((await post("/api/nav-groups", { view: "sectors", group: "macro" }, gus)).statusCode, 200);
  assert.equal((await post("/api/nav-groups", { view: "sectors", group: "nope" }, gus)).statusCode, 400, "a refused write");
  const M = (await usage(gus)).marks;
  assert.equal(M.filter((m) => m.kind === "gate" && m.detail === "sectors=admin").length, 1, "one marker for the change, none for the repeat");
  assert.ok(M.some((m) => m.kind === "nav" && m.detail === "sectors>macro" && m.tab === "sectors"));
  assert.ok(!M.some((m) => m.detail === "sectors>nope"));
  assert.ok(M.find((m) => m.detail === "sectors=admin").before, "a tab change carries its before/after reach");
  await post("/api/features", { key: "sectors", state: "public" }, gus);   // put it back
});

test("-111 HTTP: the beacon's hour buckets — the window's hours kept, a far one's time lands in the arrival hour; ld counts one load", async () => {
  const { gus, bob } = await who();
  skew += (Math.ceil(Date.now() / HOUR) * HOUR + 60000) - Date.now();   // one minute into a fresh hour
  const t = Date.now(), h = Math.floor(t / HOUR);
  const heat = async () => (await usage(gus)).heat.ms;
  const h0 = await heat();
  assert.equal((await post("/api/usage", { s: nextSid(), tabs: { markets: 60000 }, b: VERSION, ld: 1, h: { [h - 1]: 30000, [h]: 20000, [h - 100]: 99999, "x": 5 } }, bob)).statusCode, 204);
  const h1 = await heat();
  const cell = (ms) => { const p = etParts(ms); return [p.wd, p.h]; };
  const [pd, ph] = cell((h - 1) * HOUR), [cd, ch] = cell(t);
  assert.equal(h1[pd][ph] - h0[pd][ph], 30000, "the previous hour: inside this beacon's window");
  assert.equal(h1[cd][ch] - h0[cd][ch], 30000, "this hour: its 20s plus the 10s nobody's bucket covered");
  let sum0 = 0, sum1 = 0; for (let d = 0; d < 7; d++) for (let x = 0; x < 24; x++) { sum0 += h0[d][x]; sum1 += h1[d][x]; }
  assert.equal(sum1 - sum0, 60000, "never more heat than the accepted time");
  const bad = await post("/api/usage", { s: nextSid(), tabs: { markets: 1000 }, h: "nope" }, bob);
  assert.equal(bad.statusCode, 204, "a malformed h is ignored, not an error");
});

test("-111 HTTP: the regression tick alerts once per condition through the ops lane; the verdict rides the health card", async () => {
  const { gus, bob } = await who();
  // the previous build had traffic; this one: a new error two members hit
  // (build 2026.09.24-114) a baseline needs ≥ 20 page loads before anything is compared with it
  for (let i = 0; i < 20; i++) assert.equal((await post("/api/usage", { s: nextSid(), tabs: {}, b: PREV, ld: 1 }, bob)).statusCode, 204);
  for (const j of [gus, bob]) assert.equal((await post("/api/usage", { s: nextSid(), tabs: { markets: 1000 }, b: VERSION, ld: 1, errs: [{ m: "Kaboom <b>", f: "/js/x.js", l: 5 }] }, j)).statusCode, 204);
  let v = app.usageRegressTick();
  assert.equal(v.state, "collecting", "3 loads, minutes old: not yet");
  skew += 2 * HOUR + 1000;
  v = app.usageRegressTick();
  assert.deepEqual(v, { state: "regression", sent: 1 });
  assert.deepEqual(app.usageRegressTick(), { state: "regression", sent: 0 }, "deduped");
  const d = await usage(gus);
  assert.equal(d.health.regress.state, "regression"); assert.equal(d.health.regress.prev, PREV);
  assert.equal(d.health.regress.conds[0].kind, "new-errors");
  assert.ok(d.marks.some((m) => m.kind === "alert" && m.detail === VERSION + "|new-errors"), "the dedupe row is also a chart marker");
  const sv = src("server.js");
  const tick = between(sv, "function usageRegressTick(now) {", "\n  }");
  assert.ok(tick.includes("ACCOUNTS.usageAlertOnce(VERSION, c.kind, t)") && tick.includes("poller.pushOpsNow("), "one claim, then the ops lane");
  assert.ok(between(sv, "const usageRegWord = (c) => {", "\n  };").includes('.replace(/[<>&]/g, " ")'), "browser text loses markup before Telegram");
  assert.ok(sv.includes("try { if (USAGE_REGRESS) USAGE_REGRESS(); }"), "main()'s 60s flush runs it");
});

test("-111 HTTP: triage POST is admin-only, same-origin, by signature — and the list rides the usage payload", async () => {
  const { gus, bob } = await who();
  const T = (await usage(gus)).health.triage;
  const row = T.rows.find((r) => r.msg.startsWith("Kaboom"));
  assert.ok(row && row.members === 2 && row.firstBuild === VERSION, JSON.stringify(T));
  assert.equal((await post("/api/admin/usage/errors", { sig: row.sig, resolved: true }, bob)).statusCode, 403, "a member: refused");
  assert.equal((await post("/api/admin/usage/errors", { sig: row.sig, resolved: true })).statusCode, 403, "signed out: refused");
  assert.equal((await post("/api/admin/usage/errors", { sig: row.sig, resolved: true }, gus, { "sec-fetch-site": "cross-site" })).statusCode, 403, "cross-site: refused before the handler");
  assert.equal((await post("/api/admin/usage/errors", { sig: "../etc|zz", resolved: true }, gus)).statusCode, 400);
  assert.equal((await post("/api/admin/usage/errors", { sig: "/js/none.js|0123456789ab", resolved: true }, gus)).statusCode, 404);
  const ok = await post("/api/admin/usage/errors", { sig: row.sig, resolved: true }, gus, { "sec-fetch-site": "same-origin" });
  assert.equal(ok.statusCode, 200); assert.deepEqual(JSON.parse(ok.body), { ok: true, sig: row.sig, resolved: true });
  assert.equal((await usage(gus)).health.triage.rows.find((r) => r.sig === row.sig).resolved, true, "the cached payload moved with it");
  assert.equal((await get("/api/admin/usage?r=7", bob)).statusCode, 403);
});

// ---- the fold ---------------------------------------------------------------------------------------------------------------
test("-111 admin fold: markers on the chart and in their list, the post-deploy verdict, the triage list — every string escaped", () => {
  const body = src("public/js/usageadm.js").split("\n").filter((l) => !/^import /.test(l) && !/^export \{/.test(l)).join("\n");
  const nodes = { admUsageBox: { innerHTML: "", addEventListener() {} }, admUsageSub: { textContent: "" } };
  const F = new Function("el", "esc", "window", "fetch", body + "; return { UA, uaRender, uaDauSvg };")((id) => nodes[id] || null, esc, { __ME: { handle: "gus" } }, () => new Promise(() => {}));
  const XSS = "<img src=x onerror=alert(1)>";
  const w = (days, active, users) => ({ from: "2026-09-10", to: "2026-09-16", days, active, users, reach: active ? users / active : null });
  const marks = [
    { at: Date.now(), day: "2026-09-24", kind: "deploy", detail: "2026.09.24-111", tab: null },
    { at: Date.now() - DAY, day: "2026-09-23", kind: "gate", detail: "trend=" + XSS, tab: "trend", tabLabel: XSS, before: w(7, 12, 9), after: w(1, 3, 1) },
    { at: Date.now() - 2 * DAY, day: "2026-09-22", kind: "nav", detail: "#" + XSS, tab: null },
    { at: Date.now() - 3 * DAY, day: "2026-09-21", kind: "alert", detail: "2026.09.24-111|perf", tab: null },
    { at: Date.now(), day: "2026-09-24", kind: "gate", detail: "trend=off", tab: "trend", tabLabel: "Trend", before: w(7, 10, 5), after: null }];
  const svg = F.uaDauSvg([{ day: "2026-09-22", n: 1 }, { day: "2026-09-23", n: 2 }, { day: "2026-09-24", n: 2 }], marks);
  assert.equal((svg.match(/<line class="us-mk /g) || []).length, 4, "the three days' markers (the alert's day is off the chart)");
  assert.ok(svg.includes("us-mk-dep") && svg.includes("us-mk-gate") && !svg.includes("<img"));
  const triage = { total: 2, open: 1, rows: [
    { sig: "/js/a.js|0123456789ab\"><x", loc: XSS, msg: XSS, firstBuild: "2026.09.24-110", lastBuild: "2026.09.24-111", firstAt: 1, lastAt: 2, hits: 9, members: 2, resolved: false, regressed: true, regressedBuild: "2026.09.24-111" },
    { sig: "/js/b.js|0123456789ab", loc: "/js/b.js:1", msg: "ok", firstBuild: "2026.09.24-111", lastBuild: "2026.09.24-111", firstAt: 1, lastAt: 2, hits: 1, members: 1, resolved: true, regressed: false }] };
  const base = { ok: true, r: 7, keepDays: 30, priorKept: false, trendBasis: "month", moDays: { cur: 24, prev: 31 }, publicOn: false,
    kpi: { online: 0, activeToday: 0, activeRange: 0, members: 1, stickiness: null, medMinPerDay: null, newMembers: 0, newActive: 0 },
    series: [{ day: "2026-09-23", n: 1 }, { day: "2026-09-24", n: 1 }], tabs: [], members: [], funnel: [], heat: null, cohorts: null, marks,
    health: { build: "2026.09.24-111", stale: 0, errCap: 200, perf: {}, errors: { distinct: 0, hits: 0, top: [] }, triage,
      regress: { build: "2026.09.24-111", prev: "2026.09.24-110", state: "ok", loads: 42, need: { loads: 20, ageMs: 7200000 }, conds: [] } } };
  F.UA.data = base; F.uaRender();
  let out = nodes.admUsageBox.innerHTML;
  assert.ok(!out.includes("<img src=x") && !out.includes('"><x'), "marker details, error text and signatures land escaped");
  for (const pin of ["Deploys &amp; gate changes", "deploy · build 2026.09.24-111", "gate · &lt;img", "menu renamed · &lt;img", "regression alert · build -111 · perf",
    "75% <span class=\"acc-mu\">9/12</span>", "33% <span class=\"acc-mu\">1/3</span>", "1d · small n", "-42 pts", "from tomorrow",
    "Post-deploy check", "build -111: OK", "42 page loads vs build -110",
    "Error triage · 1 open of 2", "regressed · -111", ">resolved<", 'data-on="1"', 'data-on="0"', ">resolve<", ">reopen<", "-110 → -111",
    "this month’s screen time per day with last month’s", "now 24d and 31d", "kept across restarts"])
    assert.ok(out.includes(pin), "fold carries: " + pin);
  assert.ok(!out.includes('class="us-tbl us-errs"><thead><tr><th>build</th>'), "the triage list replaces the top-five table");
  base.health.regress = { build: "2026.09.24-111", prev: "2026.09.24-110", state: "regression", loads: 42, need: { loads: 20, ageMs: 7200000 },
    conds: [{ kind: "new-errors", n: 2 }, { kind: "err-rate", x: 3.4 }, { kind: "perf", p75: 1450, p75Prev: 1050 }] };
  F.uaRender(); out = nodes.admUsageBox.innerHTML;
  assert.ok(out.includes("regression: 2 new errors hit by ≥2 members · errors per page load 3.4× · p75 first paint +38% (1.4s vs 1.1s)"), out.slice(out.indexOf("Post-deploy"), out.indexOf("Post-deploy") + 600));
  base.health.regress = { build: "2026.09.24-111", prev: null, state: "collecting", loads: 7, need: { loads: 20, ageMs: 7200000 }, conds: [] };
  F.uaRender();
  assert.ok(nodes.admUsageBox.innerHTML.includes("build -111: collecting") && nodes.admUsageBox.innerHTML.includes("7 / 20 page loads"));
});

// ---- disclosure, README, mock -----------------------------------------------------------------------------------------------
test("-111 disclosure: the card, the member guide and README name the monthly totals and page loads; the mock marks this build built", () => {
  const body = src("public/js/usage.js").split("\n").filter((l) => !/^import /.test(l) && !/^export \{/.test(l)).join("\n").replace(/^export function /gm, "function ");
  const M = new Function("el", "esc", "state", "window", "document", "navigator", "fetch", "setInterval", "location", "performance",
    body + "; return { US, usageCardHtml };")(() => null, esc, { view: "markets" }, { __ME: { uid: "u1" } }, {}, {}, () => Promise.resolve({ ok: false }), () => 0, {}, {});
  M.US.mine = { ok: true, keepDays: 30, activeDays: 3, ms: 600000, tabs: [], acts: [], months: [{ key: "2026-09", ms: 5400000, days: 12 }, { key: "2026-08", ms: 60000, days: 1 }] };
  const card = M.usageCardHtml(), note = between(src("public/docs.html"), "<b>Your usage.</b>", "</div>");
  for (const w of ["one total per month", "active days", "kept for this month and last", "how many times you load the page"]) {
    assert.ok(card.includes(w), "card: " + w); assert.ok(note.includes(w), "guide: " + w);
  }
  assert.ok(card.includes("September: 1.5h · 12 active days") && card.includes("August: 1 min · 1 active day"), "the member sees their months");
  const readme = src("README.md");
  assert.ok(readme.includes("(build 2026.09.24-111)") && readme.includes("kind='mo'") && readme.includes("usage_mark") && readme.includes("POST /api/admin/usage/errors"));
  const mock = src("docs/xyz-monitor-usage-stats-mock.html");
  assert.ok(/Built in build 2026\.09\.24-111/.test(mock) && mock.includes("Deploy &amp; gate markers"), "the mock's build plan marks it built");
});
