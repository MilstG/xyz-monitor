"use strict";
// ===== build 2026.09.24-113: Usage — weekly operator digest and opt-in lapsed-member nudges (roadmap item 3) ==========
// A. the digest: ISO week keys and the schedule in ET across both DST changes; composition (lapsed / returning / paused /
//    disabled rules, the week windows, top tabs with week-over-week change, the biggest mover, quiet tabs, new and
//    regressed errors from triage, the build verdict); Telegram escaping and the length ladder; the per-ISO-week dedupe
//    persisted across a restart; "send test now" admin-only and not counted as the week's send.
// B. the nudge: the 14 / 7 / 30-day rules, paused / disabled / operator accounts excluded, no channel → skipped (and not
//    marked), the audit rows, the 30-day row pruned by the fold; delivery over the member's own Telegram.
// C. settings persistence, the admin fold via the harness (every string escaped), and the disclosure.
const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs"), path = require("path"), os = require("os");

const DATA = fs.mkdtempSync(path.join(os.tmpdir(), "xyz-usage-113-"));
process.env.DATA_DIR = DATA;
delete process.env.SITE_PASSWORD;
process.env.ADMIN_PASSWORD = "break-glass-pw-1";
process.env.XYZ_QUIET = "1";
process.env.XYZ_NO_NET = "1";
process.env.TG_BOT_TOKEN = "test-token";
delete process.env.FINNHUB_TOKEN; delete process.env.FRED_KEY; delete process.env.BRIEF_DEFAULT_HOUR;
delete process.env.USAGE_PUBLIC; delete process.env.OPENAI_API_KEY; delete process.env.ANTHROPIC_API_KEY;

const { openAccounts } = require("../src/accounts");
const UDG = require("../src/usage-digest");
const { briefVisibleLen, etDayStr } = require("../src/compute");
const src = (rel) => fs.readFileSync(path.join(__dirname, "..", rel), "utf8");
const between = (s, a, b) => { const i = s.indexOf(a); assert.ok(i >= 0, a); return s.slice(i, s.indexOf(b, i + a.length) + b.length); };
const DAY = 864e5;
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const U = (i) => "uid-d" + String(i).padStart(12, "0");
const TABS = [{ key: "markets", label: "Markets", gate: "public" }, { key: "trend", label: "Trend", gate: "public" },
  { key: "corr", label: "Correlation", gate: "public" }, { key: "sectors", label: "Sectors", gate: "admin" }, { key: "housing", label: "Housing", gate: "off" },
  { key: "funding", label: "Funding", gate: "public" }];
// ET noon of an ET day, as a UTC instant (safe on either side of a DST change)
const noon = (d) => Date.UTC(+d.slice(0, 4), +d.slice(5, 7) - 1, +d.slice(8, 10), 16);
// the balance of <b>/<i>/<pre> in a Telegram HTML message (a cut must never leave half an element)
const balanced = (s) => ["b", "i", "pre"].every((t) => (s.match(new RegExp("<" + t + ">", "g")) || []).length === (s.match(new RegExp("</" + t + ">", "g")) || []).length);

function accounts(members) {
  const A = openAccounts(fs.mkdtempSync(path.join(os.tmpdir(), "xyz-usage-113-acc-")));
  for (const m of members)
    A._db.prepare("INSERT INTO user (uid, handle, display, pw, epoch, isAdmin, createdAt, lastSeen, disabledAt, usagePaused) VALUES (?,?,?,?,1,?,?,?,?,?)")
      .run(m.uid, m.handle, m.display || m.handle, "x", m.admin ? 1 : 0, m.createdAt || Date.UTC(2026, 0, 1), m.lastSeen || 0, m.disabled ? Date.UTC(2026, 9, 1) : null, m.paused ? 1 : 0);
  A.hydrate();
  return A;
}
const tabRow = (A, uid, day, key, ms) => A._db.prepare("INSERT INTO usage_day (day, uid, kind, key, n, ms) VALUES (?,?,?,?,1,?) ON CONFLICT(day, uid, kind, key) DO UPDATE SET ms = ms + excluded.ms").run(day, uid, "tab", key, ms);

// ---- A. week arithmetic and the schedule --------------------------------------------------------------------------------
test("-113 weeks: ISO week keys (53-week years, year edges) and the digest windows", () => {
  assert.equal(UDG.digestWeekKey("2026-09-21"), "2026-W39");
  assert.equal(UDG.digestWeekKey("2026-09-27"), "2026-W39", "Sunday closes the ISO week");
  assert.equal(UDG.digestWeekKey("2026-12-31"), "2026-W53", "2026 starts on a Thursday: 53 weeks");
  assert.equal(UDG.digestWeekKey("2027-01-01"), "2026-W53", "the week belongs to the year its Thursday is in");
  assert.equal(UDG.digestWeekKey("2027-01-04"), "2027-W01");
  assert.equal(UDG.digestWeekKey("2021-01-03"), "2020-W53");
  assert.deepEqual(UDG.digestWindows("2026-11-02"), { a: { from: "2026-10-26", to: "2026-11-01" }, b: { from: "2026-10-19", to: "2026-10-25" } },
    "the 7 complete ET days before the scheduled day, then the 7 before those — the DST-change day (25h) is one day");
});

test("-113 schedule: the configured ET weekday, after the brief's default hour (UTC), across the fall-back and spring-forward changes", () => {
  // fall back: Sunday 2026-11-01 02:00 EDT → 01:00 EST
  let s = UDG.digestSchedule(Date.UTC(2026, 10, 2, 4, 30), 1, 10);   // 23:30 EST Sunday
  assert.equal(s.today, "2026-11-01"); assert.equal(s.day, "2026-10-26"); assert.equal(s.week, "2026-W44"); assert.equal(s.due, true, "last week's Monday: long due");
  s = UDG.digestSchedule(Date.UTC(2026, 10, 2, 9, 59), 1, 10);         // 04:59 EST Monday
  assert.equal(s.today, "2026-11-02"); assert.equal(s.day, "2026-11-02"); assert.equal(s.week, "2026-W45"); assert.equal(s.due, false, "before the brief's hour");
  s = UDG.digestSchedule(Date.UTC(2026, 10, 2, 10, 0), 1, 10);
  assert.equal(s.due, true); assert.equal(s.at, Date.UTC(2026, 10, 2, 10));
  // spring forward: Sunday 2026-03-08 02:00 EST → 03:00 EDT
  s = UDG.digestSchedule(Date.UTC(2026, 2, 9, 3, 59), 1, 10);          // 23:59 EDT Sunday
  assert.equal(s.today, "2026-03-08"); assert.equal(s.day, "2026-03-02");
  s = UDG.digestSchedule(Date.UTC(2026, 2, 9, 4, 0), 1, 10);           // 00:00 EDT Monday
  assert.equal(s.today, "2026-03-09"); assert.equal(s.day, "2026-03-09"); assert.equal(s.due, false);
  assert.equal(UDG.digestSchedule(Date.UTC(2026, 2, 9, 10, 0), 1, 10).due, true);
  // a later configured day: Friday of the same ISO week; not due on Thursday, catches up on Saturday (same week)
  s = UDG.digestSchedule(Date.UTC(2026, 8, 24, 15), 5, 10);
  assert.equal(s.day, "2026-09-25"); assert.equal(s.due, false); assert.equal(s.week, "2026-W39");
  s = UDG.digestSchedule(Date.UTC(2026, 8, 26, 15), 5, 10);
  assert.equal(s.day, "2026-09-25"); assert.equal(s.due, true); assert.equal(s.week, "2026-W39");
  // Sunday is the last day of the ISO week; a bad weekday falls back to Monday
  assert.equal(UDG.digestSchedule(Date.UTC(2026, 8, 24, 15), 0, 10).day, "2026-09-27");
  assert.equal(UDG.digestSchedule(Date.UTC(2026, 8, 24, 15), 9, 10).day, "2026-09-21");
});

// ---- A. composition ------------------------------------------------------------------------------------------------------
const OLD = Date.UTC(2026, 0, 5);
function world() {
  const A = accounts([
    { uid: U(0), handle: "alice", display: "Alice" },
    { uid: U(1), handle: "bob", display: "Bob <b>bold</b>" },
    { uid: U(2), handle: "cara", display: "Cara" },
    { uid: U(3), handle: "dan", display: "Dan", paused: true },
    { uid: U(4), handle: "eve", display: "Eve", disabled: true },
    { uid: U(5), handle: "finn", display: "Finn", createdAt: noon("2026-10-28") },
    { uid: U(6), handle: "gil", display: "Gil" },
    { uid: U(7), handle: "hal", display: "Hal" },
    { uid: U(8), handle: "ivy", display: "Ivy", createdAt: noon("2026-10-20") },
  ].map((m) => Object.assign({ createdAt: OLD }, m)));
  tabRow(A, U(0), "2026-10-20", "markets", 3600e3); tabRow(A, U(0), "2026-10-27", "markets", 7200e3); tabRow(A, U(0), "2026-10-28", "trend", 1200e3);
  tabRow(A, U(1), "2026-10-21", "trend", 1800e3);                     // last week only → newly lapsed
  tabRow(A, U(2), "2026-10-30", "markets", 1800e3);                   // this week only, an old member → returning
  tabRow(A, U(3), "2026-10-22", "markets", 1800e3);                   // paused: counted, never named
  tabRow(A, U(4), "2026-10-22", "markets", 1800e3);                   // disabled: not a member here at all
  tabRow(A, U(5), "2026-10-29", "markets", 600e3);                    // joined this week, active
  tabRow(A, U(6), "2026-10-23", "markets", 600e3); tabRow(A, U(6), "2026-11-02", "markets", 600e3);   // back on the digest day: not lapsed
  tabRow(A, U(7), "2026-10-22", "markets", 30e3);                     // under a minute: never active
  tabRow(A, U(8), "2026-10-30", "corr", 90e3);                        // joined last week, first active this week: not "returning"
  tabRow(A, "0", "2026-10-27", "markets", 999e3);                     // sitewide rows count toward tab time, never toward members
  return A;
}

test("-113 digest data: active this week vs last, stickiness, lapsed / returning / joined, paused only counted, disabled absent", () => {
  const A = world();
  const d = A.usageDigestData({ now: Date.UTC(2026, 10, 2, 12), day: "2026-11-02", tabs: TABS });
  assert.equal(d.week, "2026-W45"); assert.deepEqual(d.a, { from: "2026-10-26", to: "2026-11-01" });
  assert.equal(d.members.total, 8, "the disabled account is not a member");
  assert.equal(d.members.paused, 1);
  assert.equal(d.members.active, 4, "alice, cara, finn, ivy");
  assert.equal(d.members.activePrev, 3, "alice, bob, gil — never the paused one, never the disabled one, not hal's 30 seconds");
  // daily actives this week: 10-27 alice, 10-28 alice, 10-29 finn, 10-30 cara + ivy → 5 member-days / 7 / 4
  assert.equal(+d.members.stickiness.toFixed(4), +(5 / 7 / 4).toFixed(4));
  assert.deepEqual(d.lapsed.map((x) => x.handle), ["bob"], "gil came back on the digest day; dan is paused");
  assert.deepEqual(d.returning.map((x) => x.handle), ["cara"], "finn and ivy are new, not returning");
  assert.equal(d.members.newJoined, 1); assert.equal(d.members.newActive, 1);
  const all = JSON.stringify(d);
  assert.ok(!all.includes("dan") && !all.includes("Dan") && !all.includes("eve"), "the paused and the disabled member are never named");
  // tabs: this week markets = 7200 + 1800 + 600 + 999 (site) s, last week 3600 + 600 + (paused 1800 + disabled 1800 + hal 30: tab time is aggregate)
  const top = d.tabs.top;
  assert.deepEqual(top.map((t) => t.key), ["markets", "trend", "corr"]);
  assert.equal(top[0].ms, (7200 + 1800 + 600 + 999) * 1e3); assert.equal(top[0].prevMs, (3600 + 600 + 1800 + 1800 + 30) * 1e3);
  assert.equal(top[1].prevMs, 1800e3);
  assert.equal(d.tabs.mover.key, "markets", "the largest change among tabs with ≥ 10 min in either week");
  assert.deepEqual(d.tabs.quiet.map((t) => t.key), ["funding"], "nobody active opened it (trend and corr: 1 of 4 = 25%)");
  assert.ok(!d.tabs.quiet.some((t) => t.key === "sectors" || t.key === "housing"), "admin-only and switched-off tabs are never 'quiet'");
  A.close();
});

test("-113 digest data: new and regressed errors from triage, the build verdict", () => {
  const A = world();
  const t = (d, h) => Date.UTC(+d.slice(0, 4), +d.slice(5, 7) - 1, +d.slice(8, 10), h || 15);
  A.usageBuildSeen("2026.10.19-1", t("2026-10-19"));
  const e1 = { msg: "old bug", loc: "app.js:10", c: 1 }, e2 = { msg: "<script>x</script> broke", loc: "nav.js:5", c: 2 }, e3 = { msg: "ancient", loc: "base.js:1", c: 1 };
  A.usageRecord(U(0), {}, null, t("2026-10-15"), { build: "2026.10.19-1", errs: [e3] });
  A.usageRecord(U(0), {}, null, t("2026-10-20"), { build: "2026.10.19-1", errs: [e1] });
  A.usageFlush();
  const sig1 = A.usageTriage(t("2026-10-21")).rows.find((r) => r.loc === "app.js:10").sig;
  assert.equal(A.usageTriageSet(sig1, true, t("2026-10-21")).ok, true);
  A.usageBuildSeen("2026.10.27-2", t("2026-10-27"));
  A.usageRecord(U(0), {}, null, t("2026-10-28"), { build: "2026.10.27-2", errs: [e1] });   // resolved, hit again on a newer build → regressed
  A.usageRecord(U(2), {}, null, t("2026-10-29"), { build: "2026.10.27-2", errs: [e2] });   // first seen this week → new
  const d = A.usageDigestData({ now: t("2026-11-02", 12), day: "2026-11-02", tabs: TABS, build: "2026.10.27-2" });
  assert.deepEqual(d.errors.regressed.map((e) => e.loc), ["app.js:10"]);
  assert.deepEqual(d.errors.fresh.map((e) => e.loc), ["nav.js:5"], "the old open error is neither new nor regressed");
  assert.equal(d.errors.open, 3);
  assert.equal(d.verdict.build, "2026.10.27-2"); assert.ok(["collecting", "ok", "no-baseline", "regression"].includes(d.verdict.state));
  const txt = UDG.digestText(d);
  assert.ok(txt.includes("1 new · 1 regressed · 3 open in triage"), txt);
  assert.ok(txt.includes("new: nav.js:5 · &lt;script&gt;x&lt;/script&gt; broke (1 member)") && !txt.includes("<script>"), "browser-supplied text is escaped");
  assert.ok(txt.includes("regressed: app.js:10 · old bug"));
  assert.ok(/🚦 <b>LAST BUILD<\/b> build -2: /.test(txt), txt);
  A.close();
});

test("-113 digest text: the brief-style layout, every dynamic string escaped, plain mode for the preview", () => {
  const A = world();
  const d = A.usageDigestData({ now: Date.UTC(2026, 10, 2, 12), day: "2026-11-02", tabs: TABS });
  const html = UDG.digestText(d);
  for (const pin of ["📊 <b>WEEKLY USAGE</b>", "<i>Oct 26–Nov 1 vs Oct 19–25 (ET)</i>", "👥 <b>MEMBERS</b>", "active 4 (last week 3, +1) · stickiness 18%",
    "newly lapsed 1: Bob &lt;b&gt;bold&lt;/b&gt;", "returning 1: Cara", "1 joined (1 active) · 1 paused", "🗂 <b>TABS</b>", "1. Markets 2.9h (+35%)",
    "2. Trend 20m (−33%)", "3. Correlation 2m (new)", "biggest mover: Markets +46m (+35%)", "quiet (&lt;10% reach): Funding", "🐞 <b>ERRORS</b>", "0 new · 0 regressed"])
    assert.ok(html.includes(pin), "digest carries: " + pin + "\n" + html);
  assert.ok(!html.includes("<b>bold</b>"), "a display name cannot inject markup");
  assert.ok(balanced(html));
  const plain = UDG.digestText(d, { html: false });
  assert.ok(plain.includes("newly lapsed 1: Bob <b>bold</b>") && !plain.includes("&lt;") && !plain.includes("<i>"), "plain: raw text for the fold to escape");
  A.close();
});

test("-113 digest text: Telegram's limit — hundreds of long names and errors still fit, the ladder trims names first, tags stay balanced", () => {
  const long = (i) => ({ handle: "h" + i, display: "Member-with-a-really-long-display-name-" + i + " <&>" });
  const errs = Array.from({ length: 40 }, (_, i) => ({ loc: "some/deep/path/file" + i + ".js:" + i, msg: "x".repeat(300) + "<b>", members: i, hits: i }));
  const data = { day: "2026-11-02", a: { from: "2026-10-26", to: "2026-11-01" }, b: { from: "2026-10-19", to: "2026-10-25" },
    members: { total: 900, paused: 12, active: 400, activePrev: 450, stickiness: 0.3, newJoined: 3, newActive: 2 },
    lapsed: Array.from({ length: 300 }, (_, i) => long(i)), returning: Array.from({ length: 200 }, (_, i) => long(1000 + i)),
    tabs: { top: [{ label: "Markets <x>", ms: 3.6e7, prevMs: 3e7 }], mover: { label: "Trend", ms: 1e6, prevMs: 3e6 }, quiet: Array.from({ length: 30 }, (_, i) => ({ label: "Tab" + i })) },
    errors: { fresh: errs, regressed: errs, open: 80 }, verdict: { build: "2026.09.24-113", state: "regression", prev: "2026.09.24-112", conds: [{ kind: "new-errors", n: 3 }, { kind: "perf", p75: 1300, p75Prev: 1000 }] } };
  const txt = UDG.digestText(data);
  assert.ok(briefVisibleLen(txt) <= UDG.DIGEST_TG_LIMIT && UDG.DIGEST_TG_LIMIT < 4096, "fits: " + briefVisibleLen(txt));
  assert.ok(balanced(txt));
  assert.ok(!/<(?!\/?(b|i)>)/.test(txt), "no markup but the digest's own <b>/<i>");
  assert.ok(txt.includes("newly lapsed 300: ") && txt.includes("+290 more"), "names are clipped to a few, with the rest counted");
  assert.ok(txt.includes("REGRESSION — 3 new errors, p75 paint +30%"));
  // a tiny limit: the ladder ends at counts only, then whole lines go, and it says so
  const tiny = UDG.digestText(data, { limit: 300 });
  assert.ok(briefVisibleLen(tiny) <= 300 && tiny.endsWith("<i>… (cut to fit)</i>") && balanced(tiny), tiny);
  assert.ok(!tiny.includes("Member-with"), "counts only");
  // exactly the level that fits is used: a small world keeps every name
  const small = Object.assign({}, data, { lapsed: [long(1)], returning: [], errors: { fresh: [], regressed: [], open: 0 }, tabs: { top: [], mover: null, quiet: [] } });
  assert.ok(UDG.digestText(small).includes("newly lapsed 1: Member-with-a-really-lo…"), "a long display name is clipped at 24");
});

// ---- A. dedupe across a restart, settings persistence ---------------------------------------------------------------------
test("-113 settings and dedupe persist in accounts.db: a reopened database keeps the week sent and every setting", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "xyz-usage-113-re-"));
  let A = openAccounts(dir);
  assert.deepEqual([A.usageCfg().digestOn, A.usageCfg().digestDay, A.usageCfg().nudgeOn, A.usageCfg().digestWeek], [true, 1, false, null], "defaults: digest on (Monday), nudges off");
  assert.equal(A.usageCfgSet({ digestDay: 7 }).ok, false); assert.equal(A.usageCfgSet({ digestOn: "yes" }).ok, false);
  assert.equal(A.usageCfgSet({ nudgeText: "x".repeat(301) }).ok, false);
  assert.equal(A.usageCfgSet({ nudgeOn: 1 }).ok, false);
  assert.equal(A.usageCfgSet({ digestDay: 3, nudgeOn: "no" }).ok, false, "all-or-nothing");
  assert.equal(A.usageCfg().digestDay, 1);
  const r = A.usageCfgSet({ digestDay: 3, nudgeOn: true, nudgeText: "  Hey\n\tthere  <b>!</b> " }, "uid-admin-1", 1234);
  assert.equal(r.ok, true); assert.equal(r.nudgeText, "Hey there <b>!</b>", "one line, stored as text (escaped at every sink)");
  assert.equal(r.nudgeBy, "uid-admin-1"); assert.equal(r.nudgeSetAt, 1234);
  A.usageCfgSet({ nudgeOn: true }, "uid-admin-2", 9999);
  assert.equal(A.usageCfg().nudgeBy, "uid-admin-1", "re-saving 'on' does not re-attribute it");
  A.usageDigestSent("2026-W45", 5555);
  A.close();
  A = openAccounts(dir);
  const c = A.usageCfg();
  assert.deepEqual([c.digestDay, c.nudgeOn, c.nudgeText, c.digestWeek, c.digestAt], [3, true, "Hey there <b>!</b>", "2026-W45", 5555]);
  assert.equal(A.usageCfgSet({ nudgeText: "" }).nudgeText, null, "blank = back to the default");
  A.close();
});

// ---- B. the nudge rules ------------------------------------------------------------------------------------------------
test("-113 nudge rules: last active 8–14 days ago, 7 days unseen, once per 30 days, never paused / disabled / operator, a channel or nothing", () => {
  const now = Date.UTC(2026, 10, 12, 15);   // ET 2026-11-12
  const base = { lastActive: "2026-11-04", lastSeen: now - 9 * DAY, lastNudgeAt: null, hasTg: true, hasPush: true };
  const chk = (o) => UDG.nudgeCheck(Object.assign({}, base, o), now);
  assert.deepEqual(chk({}), { ok: true, via: "telegram" }, "gap 8: seven full days without an active day");
  assert.equal(chk({ lastActive: "2026-11-05" }).why, "active-this-week", "gap 7 is not yet seven full days");
  assert.equal(chk({ lastActive: "2026-10-29" }).ok, true, "gap 14: still inside the prior 14 days");
  assert.equal(chk({ lastActive: "2026-10-28" }).why, "not-active-recently");
  assert.equal(chk({ lastActive: null }).why, "not-active-recently");
  assert.equal(chk({ lastSeen: now - 2 * DAY }).why, "seen-this-week", "a visit under a minute still means they are around");
  assert.equal(chk({ lastNudgeAt: now - 29 * DAY }).why, "nudged-recently");
  assert.equal(chk({ lastNudgeAt: now - 31 * DAY }).ok, true);
  assert.equal(chk({ paused: true }).why, "paused");
  assert.equal(chk({ disabled: true }).why, "disabled");
  assert.equal(chk({ admin: true }).why, "operator");
  assert.deepEqual(chk({ hasTg: false }), { ok: true, via: "push" }, "Telegram first, else browser push");
  assert.equal(chk({ hasTg: false, hasPush: false }).why, "no-channel");
});

test("-113 nudge text: market lines only (benchmarks, top movers), the lead escaped for Telegram, plain for push", () => {
  const ctx = { bench: { stocks: { t: "SPY", d1: 0.42 }, crypto: { t: "BTC", d1: -1.25 } },
    movers: { stocks: { up: [{ t: "NVDA", d1: 5.1 }, { t: "AMD", d1: 3 }], down: [{ t: "TSLA", d1: -3.24 }] } } };
  assert.deepEqual(UDG.nudgeLines(ctx), ["SPY +0.4% · BTC −1.3% (24h)", "top gainer: NVDA +5.1%", "top loser: TSLA −3.2%"]);
  assert.deepEqual(UDG.nudgeLines({}), [], "no data: no lines, never invented ones");
  assert.deepEqual(UDG.nudgeLines({ bench: { stocks: { t: "SPY", d1: null } }, movers: { stocks: { up: [{ t: "X", d1: NaN }], down: [] } } }), []);
  const tg = UDG.nudgeMessage("Hi <you> & co", UDG.nudgeLines(ctx), true);
  assert.ok(tg.startsWith("Hi &lt;you&gt; &amp; co\nSPY +0.4%") && tg.includes("<i>One reminder at most; pause usage") && balanced(tg), tg);
  const push = UDG.nudgeMessage("Hi <you>", ["a", "b"], false);
  assert.deepEqual(push, { title: "Milst Screener", body: "Hi <you> a · b", kind: "nudge" }, "the service worker shows push text as text; (-114) its own kind");
  assert.equal(UDG.NUDGE_DEFAULT_TEXT, "Haven’t seen you in a week — here’s what moved:");
  assert.equal(UDG.nudgeTextClean("   "), UDG.NUDGE_DEFAULT_TEXT);
  assert.equal(UDG.nudgeTextClean("a\u202eb\u0000c"), "a b c", "bidi and control characters go");
  assert.equal(UDG.nudgeTextClean("y".repeat(300)).length, 300); assert.equal(UDG.nudgeTextClean("y".repeat(301)), null);
});

test("-113 nudge inputs, the audit row and the 30-day row: last active from the kept days, the mark, the fold's prune", () => {
  const A = accounts([{ uid: U(1), handle: "bob", display: "Bob" }, { uid: U(9), handle: "gus", display: "Gus", admin: true }]);
  tabRow(A, U(1), "2026-11-03", "markets", 30e3); tabRow(A, U(1), "2026-11-04", "markets", 61e3); tabRow(A, U(1), "2026-11-05", "trend", 59e3);
  const now = Date.UTC(2026, 10, 12, 15);
  const bob = A.usageNudgeInputs(now).find((m) => m.handle === "bob");
  assert.equal(bob.lastActive, "2026-11-04", "the last ET day with a minute on screen");
  assert.equal(UDG.nudgeCheck(Object.assign({}, bob, { hasTg: true }), now).ok, true);
  assert.equal(A.usageNudgeMark(U(1), "telegram", U(9), now).ok, true);
  const again = A.usageNudgeInputs(now + DAY).find((m) => m.handle === "bob");
  assert.equal(again.lastNudgeAt, now);
  assert.equal(UDG.nudgeCheck(Object.assign({}, again, { hasTg: true }), now + DAY).why, "nudged-recently");
  const log = A.usageNudgeLog(10);
  assert.equal(log.length, 1); assert.equal(log[0].detail, "bob · telegram"); assert.equal(log[0].by, "Gus");
  const audit = A.adminAuditLog(10);
  assert.ok(audit.some((r) => r.action === "usage-nudge" && r.detail === "bob · telegram" && r.who === "Gus"), "a dm_audit row like every other per-member operator action");
  A.usageMark("x", "y", now);   // unrelated
  const r = A.usageRetain(now + 31 * DAY);
  assert.equal(r.nudges, 1, "the per-member 30-day row goes with the fold");
  assert.equal(A.usageNudgeInputs(now + 31 * DAY).find((m) => m.handle === "bob").lastNudgeAt, null);
  assert.equal(A.usageNudgeLog(10).length, 1, "the audit row stays");
  assert.equal(A.usageMine(U(1), []).nudgeOn, false, "the member's card is told whether reminders are on");
  A.close();
});

// ---- the HTTP boundary (a stubbed Telegram) -------------------------------------------------------------------------------
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
const post = (url, body, j) => app.inject({ method: "POST", url, headers: Object.assign({}, JSONH, j ? { cookie: j.header() } : {}), payload: JSON.stringify(body) });
const get = (url, j) => app.inject({ method: "GET", url, headers: Object.assign({}, j ? { cookie: j.header() } : {}) });
test.before(async () => { app = await buildServer(); });
test.after(async () => { await app.close(); });
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
async function drain() {
  const P = _poller();
  for (let i = 0; i < 100 && P.pushStateNow().queue > 0; i++) { P.pushUnholdNow(); await P.pushDrainNow(); }
  const sent = API.calls.filter((c) => c.method === "sendMessage");
  API.calls.length = 0;
  return sent;
}
const dbRows = (sql) => {
  const { DatabaseSync } = require("node:sqlite");
  const db = new DatabaseSync(path.join(DATA, "accounts.db"), { readOnly: true });
  try { return db.prepare(sql).all().map((x) => Object.assign({}, x)); } finally { db.close(); }
};
const nextMonday = (t) => { let x = t + DAY; while (new Date(x).getUTCDay() !== 1) x += DAY; const d = new Date(x); return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), 12); };

test("-113 HTTP: settings and the preview are admin-only; writes validate and persist; the preview is plain text", async () => {
  const { gus, bob } = await people();
  assert.equal((await get("/api/admin/usage/digest", bob)).statusCode, 403);
  assert.equal((await get("/api/admin/usage/digest")).statusCode, 403);
  assert.equal((await post("/api/admin/usage/digest", { nudgeOn: true }, bob)).statusCode, 403);
  let d = JSON.parse((await get("/api/admin/usage/digest", gus)).body);
  assert.equal(d.digestOn, true); assert.equal(d.digestDay, 1); assert.equal(d.nudgeOn, false); assert.equal(d.nudgeText, UDG.NUDGE_DEFAULT_TEXT);
  assert.ok(d.preview.text.startsWith("📊 WEEKLY USAGE\n") && !d.preview.text.includes("<b>"), "plain text — the fold escapes it");
  assert.equal(d.schedule.briefHourUtc, 10); assert.equal(d.pushOn, true); assert.equal(d.operators, 0);
  assert.equal((await post("/api/admin/usage/digest", { digestDay: "mon" }, gus)).statusCode, 400);
  d = JSON.parse((await post("/api/admin/usage/digest", { digestDay: 2, digestOn: false }, gus)).body);
  assert.equal(d.digestDay, 2); assert.equal(d.digestOn, false);
  d = JSON.parse((await get("/api/admin/usage/digest", gus)).body);
  assert.equal(d.digestDay, 2, "persisted"); assert.deepEqual(dbRows("SELECT k, v FROM usage_cfg WHERE k = 'digestDay'"), [{ k: "digestDay", v: "2" }]);
  await post("/api/admin/usage/digest", { digestDay: 1, digestOn: true }, gus);
});

test("-113 HTTP: 'send test now' is admin-only, reaches the designated operator chats only, and is not the week's send", async () => {
  const { gus, bob, gusUid, bobUid } = await people();
  assert.equal((await post("/api/admin/usage/digest/test", {}, bob)).statusCode, 403);
  assert.equal((await post("/api/admin/usage/digest/test", {})).statusCode, 403);
  let r = JSON.parse((await post("/api/admin/usage/digest/test", {}, gus)).body);
  assert.equal(r.ok, false); assert.match(r.error, /no operator chat/);
  const P = _poller();
  P.pushBindNow(P.pushMintCode(gusUid, true).code, 8001, "gus");    // the operator's chat (admin-minted)
  P.pushBindNow(P.pushMintCode(bobUid, false).code, 8002, "bob");   // a member's own chat
  await drain();
  r = JSON.parse((await post("/api/admin/usage/digest/test", {}, gus)).body);
  assert.equal(r.ok, true); assert.equal(r.sent, 1);
  const sent = await drain();
  assert.deepEqual(sent.map((c) => c.body.chat_id), ["8001"], "the operator's chat, never a member's");
  assert.ok(sent[0].body.text.startsWith("📊 <b>WEEKLY USAGE</b>") && sent[0].body.parse_mode === "HTML");
  assert.equal(JSON.parse((await get("/api/admin/usage/digest", gus)).body).lastWeek, null, "a test does not count as the week's send");
});

test("-113 HTTP: the weekly tick sends once per ISO week (persisted), only when due; switched off sends nothing", async () => {
  const { gus } = await people();
  const T = nextMonday(Date.now());
  const P = _poller();
  assert.equal(P.pushOperatorChatsNow().length, 1);
  let r = await app.usageDigestTick(T - 3 * 3600e3);   // Monday 09:00 UTC: before the brief's hour
  assert.equal(r.digest.due, false);
  assert.equal((await drain()).length, 0);
  r = await app.usageDigestTick(T);
  assert.equal(r.digest.sent, 1); assert.equal(r.digest.week, UDG.digestWeekKey(etDayStr(T)));
  const sent = await drain();
  assert.equal(sent.length, 1); assert.equal(sent[0].body.chat_id, "8001");
  assert.ok(briefVisibleLen(sent[0].body.text) <= 4096);
  r = await app.usageDigestTick(T + 3600e3);
  assert.equal(r.digest.already, true, "deduped");
  assert.equal((await drain()).length, 0);
  // the dedupe is on disk: a restarted process reads the same week and stays quiet
  assert.deepEqual(dbRows("SELECT v FROM usage_cfg WHERE k = 'digestWeek'"), [{ v: JSON.stringify(r.digest.week) }]);
  const d = JSON.parse((await get("/api/admin/usage/digest", gus)).body);
  assert.equal(d.lastWeek, r.digest.week); assert.equal(d.lastAt, T);
  // the next week goes again; with the digest off, nothing
  r = await app.usageDigestTick(T + 7 * DAY);
  assert.equal(r.digest.sent, 1); await drain();
  await post("/api/admin/usage/digest", { digestOn: false }, gus);
  r = await app.usageDigestTick(T + 14 * DAY);
  assert.equal(r.digest, null); assert.equal((await drain()).length, 0);
  await post("/api/admin/usage/digest", { digestOn: true }, gus);
  // a quiet ring entry says it went out (ops class, never a second Telegram message)
  assert.ok(P.getTriggers(null, "", true).recent.some((e) => e.kind === "ops" && e.title === "usage digest" && e.quiet === 1));
});

test("-113 HTTP: nudges are off by default; on, a lapsed member gets ONE over their own Telegram, audited; paused or channel-less members get none", async () => {
  const { gus, bob, bobUid } = await people();
  // bob was active today (a real minute), and the clock is moved nine days on
  const today = etDayStr(Date.now());
  const { DatabaseSync } = require("node:sqlite");
  const db = new DatabaseSync(path.join(DATA, "accounts.db"));
  db.prepare("INSERT INTO usage_day (day, uid, kind, key, n, ms) VALUES (?,?,?,?,1,?)").run(today, bobUid, "tab", "markets", 120000);
  db.close();
  const T = Date.now() + 9 * DAY;
  let r = await app.usageNudgeTick(T, true);
  assert.equal(r.off, true, "off by default");
  let d = JSON.parse((await post("/api/admin/usage/digest", { nudgeOn: true, nudgeText: "Miss you <3" }, gus)).body);
  assert.equal(d.nudgeOn, true);
  // paused: never
  await post("/api/usage/pause", { paused: true }, bob);
  r = await app.usageNudgeTick(T, true);
  assert.equal(r.sent, 0);
  await post("/api/usage/pause", { paused: false }, bob);
  r = await app.usageNudgeTick(T, true);
  assert.deepEqual(r.to, [{ handle: "bob", via: "telegram" }], "gus is the operator: never nudged");
  const sent = await drain();
  assert.deepEqual(sent.map((c) => c.body.chat_id), ["8002"], "bob's own chat");
  assert.ok(sent[0].body.text.startsWith("Miss you &lt;3") && sent[0].body.text.includes("pause usage"), sent[0].body.text);
  r = await app.usageNudgeTick(T + DAY, true);
  assert.equal(r.sent, 0, "once");
  const audit = dbRows("SELECT action, detail FROM dm_audit WHERE action = 'usage-nudge'");
  assert.deepEqual(audit, [{ action: "usage-nudge", detail: "bob · telegram" }]);
  d = JSON.parse((await get("/api/admin/usage/digest", gus)).body);
  assert.equal(d.nudgeLog.length, 1); assert.equal(d.nudgeLog[0].by, "gus");
  // outside 10:00–18:00 ET the hourly sweep waits (unforced)
  const nightET = Date.UTC(2026, 10, 20, 7);   // 02:00 EST
  assert.equal((await app.usageNudgeTick(nightET)).waiting, true);
  // no channel: unlink bob's chat — a later lapse is skipped and NOT marked
  const P = _poller();
  P.pushUnlink("8002", "", true);
  const db2 = new DatabaseSync(path.join(DATA, "accounts.db"));
  db2.prepare("DELETE FROM usage_nudge").run();
  db2.close();
  r = await app.usageNudgeTick(T + 2 * DAY, true);
  assert.equal(r.sent, 0);
  assert.equal(dbRows("SELECT COUNT(*) AS n FROM usage_nudge")[0].n, 0, "nothing sent, nothing marked");
  assert.equal(JSON.parse((await get("/api/usage/me", bob)).body).nudgeOn, true, "the member's card says reminders are on");
  await post("/api/admin/usage/digest", { nudgeOn: false }, gus);
});

// ---- C. the fold, the disclosure ---------------------------------------------------------------------------------------
test("-113 admin fold: Digest & nudges — settings, last sent, the escaped preview, send test, the reminder toggle, text and log", () => {
  const body = src("public/js/usageadm.js").split("\n").filter((l) => !/^import /.test(l) && !/^export \{/.test(l)).join("\n");
  const nodes = { admUsageBox: { innerHTML: "", addEventListener() {} }, admUsageSub: { textContent: "" } };
  const F = new Function("el", "esc", "window", "fetch", body + "; return { UA, uaRender, uaDigestHtml };")((id) => nodes[id] || null, esc, { __ME: { handle: "gus" } }, () => new Promise(() => {}));
  const XSS = "<img src=x onerror=alert(1)>";
  F.UA.data = { ok: true, r: 7, keepDays: 30, priorKept: true, kpi: { activeRange: 0 }, series: [{ day: "2026-09-24", n: 0 }], tabs: [], members: [], funnel: [], marks: [], health: null };
  F.UA.dg.data = { ok: true, digestOn: true, digestDay: 1, lastWeek: "2026-W39", lastAt: Date.UTC(2026, 8, 21, 10, 1),
    schedule: { day: "2026-09-28", week: "2026-W40", due: false, sentThisWeek: false, briefHourUtc: 10 },
    preview: { day: "2026-09-24", week: "2026-W39", text: "📊 WEEKLY USAGE\nnewly lapsed 1: " + XSS, chars: 321, limit: 4096 },
    operators: 1, pushOn: true, webPush: true, nudgeOn: true, nudgeText: XSS, nudgeDefault: UDG.NUDGE_DEFAULT_TEXT, nudgeMax: 300,
    nudgeSince: Date.UTC(2026, 8, 20), nudgeLog: [{ at: Date.UTC(2026, 8, 22), by: XSS, detail: "bob · " + XSS }], rules: { quietDays: 7, recentDays: 14, everyDays: 30 } };
  F.uaRender();
  const out = nodes.admUsageBox.innerHTML;
  assert.ok(!out.includes("<img src=x"), "preview, reminder text and log all escaped");
  for (const pin of ["Digest &amp; nudges", "Weekly usage digest", 'data-uadg="digestOn" checked', '<option value="1" selected>Monday</option>', "10:00 UTC",
    "last sent: <b>", "2026-W39", "this week (2026-W40): due Sep 28", "1 operator chat", "send test now", "Preview · 2026-W39 · 321 of 4096 chars",
    '<pre class="us-dgpre"', "newly lapsed 1: &lt;img", "Lapsed-member reminder", "optional, off by default", 'data-uadg="nudgeOn" checked', "on since",
    "&lt;img src=x onerror=alert(1)&gt;</textarea>", 'maxlength="300"', "save text", "Reminders sent · 1", "bob · &lt;img", "usage-nudge", "pausing usage opts them out"])
    assert.ok(out.includes(pin), "fold carries: " + pin);
  // no Telegram, no operator: the button is disabled and the fold says why; an unsaved draft survives a re-render
  F.UA.dg.data = Object.assign({}, F.UA.dg.data, { pushOn: false, operators: 0, nudgeLog: [] });
  F.UA.dg.draft = "draft <x>";
  F.uaRender();
  const o2 = nodes.admUsageBox.innerHTML;
  assert.ok(o2.includes("Telegram is not configured") && /data-uadgtest="1" disabled/.test(o2) && o2.includes("draft &lt;x&gt;</textarea>") && o2.includes("none yet"));
  F.UA.dg.data = null; F.UA.dg.err = "HTTP <500>"; F.uaRender();
  assert.ok(nodes.admUsageBox.innerHTML.includes("could not load — HTTP &lt;500&gt;"));
  // the audit log names the action
  assert.ok(src("public/js/access.js").includes("'usage-nudge':'(reminders on) sent a lapsed-member reminder to'"));
});

test("-113 disclosure: the card, the member guide and README say one reminder if the operator turns it on, and that pausing avoids it", () => {
  const ubody = src("public/js/usage.js").split("\n").filter((l) => !/^import /.test(l) && !/^export \{/.test(l)).join("\n").replace(/^export function /gm, "function ");
  const M = new Function("el", "esc", "state", "window", "document", "navigator", "fetch", "setInterval", ubody + "; return { US, usageCardHtml };")(
    () => null, esc, { view: "markets" }, { __ME: { uid: "u1" } }, {}, {}, () => Promise.resolve({ ok: false }), () => 0);
  M.US.mine = { ok: true, keepDays: 30, activeDays: 1, ms: 60000, tabs: [], acts: [], nudgeOn: true };
  const card = M.usageCardHtml(), note = between(src("public/docs.html"), "<b>Your usage.</b>", "</div>");
  for (const w of ["if the operator turns them on", "one friendly reminder (at most once every 30 days)", "Telegram or browser push you already linked, never email or SMS", "To never get one, pause usage"]) {
    assert.ok(card.includes(w), "card: " + w); assert.ok(note.includes(w), "guide: " + w);
  }
  assert.ok(card.includes("Reminders are currently <b>on</b>"));
  M.US.mine.nudgeOn = false; assert.ok(M.usageCardHtml().includes("Reminders are currently <b>off</b>"));
  assert.ok(note.includes("weekly usage digest") && note.includes("never a paused one"));
  const readme = src("README.md");
  assert.ok(readme.includes("(build 2026.09.24-113)") && readme.includes("roadmap item 3") && readme.includes("`usage-nudge`") && readme.includes("OFF by default")
    && readme.includes("never email or SMS; nothing if neither") && readme.includes("dedupe is per ISO week"));
  assert.ok(/Built in build 2026\.09\.24-113<\/em> \(roadmap item 3\)/.test(src("docs/xyz-monitor-usage-stats-mock.html")));
  assert.ok(src("server.js").includes('const VERSION = "2026.09.25-121"'));
});
