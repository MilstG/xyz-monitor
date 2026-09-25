"use strict";
// ===== build 2026.09.25-117: cookieless public (signed-out) visitor counting ================================================
// 1. the visitor key: HMAC(dailySalt, ip|ua|host) — deterministic within an ET day, unrelated after rotation
// 2. the salt, the key, the IP and the User-Agent are never stored (DB rows, and every file under DATA_DIR)
// 3. accepted when on; ignored when the toggle is off or USAGE_PUBLIC=0; the shell tells the page (__USPUB)
// 4. server-wide caps (beacons / minute, visitors / day) → 204 + a 'pdrop' counter the operator sees
// 5. the rate gate clamps per visitor (a separate gate instance, keyed by the in-memory key)
// 6. members and public never mix ('-1' is never a member, never folded into '0', no wk/mo/sc rows)
// 7. pv / ptr / pmin math: distinct visitors per day, mean daily reach, the minutes histogram median
// 8. anonymous online-now = open signed-out streams (a count; break-glass and members excluded)
// 9. the who-toggle payloads (pub, pub.both) and their render; 10. k ≥ 3 visitors for paths/controls/devices
// 11. the client beacons signed out only when the server says on; 12. the notice renders and dismisses
// 13. public errors never count as members affected, never trigger regression alerts, 10 new a day
const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs"), path = require("path"), os = require("os"), crypto = require("crypto");

const DATA = fs.mkdtempSync(path.join(os.tmpdir(), "xyz-usage-117-"));
process.env.DATA_DIR = DATA;
delete process.env.SITE_PASSWORD;
process.env.ADMIN_PASSWORD = "break-glass-pw-1";
process.env.XYZ_QUIET = "1";
process.env.XYZ_NO_NET = "1";
delete process.env.TG_BOT_TOKEN; delete process.env.FINNHUB_TOKEN; delete process.env.FRED_KEY; delete process.env.TRUST_PROXY;
delete process.env.USAGE_PUBLIC; delete process.env.OPENAI_API_KEY; delete process.env.ANTHROPIC_API_KEY;
delete process.env.RAILWAY_ENVIRONMENT; delete process.env.RAILWAY_ENVIRONMENT_NAME; delete process.env.RAILWAY_PROJECT_ID;

// Every salt usage-public.js mints is recorded here (only calls from that module), so the test can
// look for it — raw, hex, base64 — in everything the server wrote.
const SALTS = [];
const realRandomBytes = crypto.randomBytes;
crypto.randomBytes = function (n, ...rest) {
  const b = realRandomBytes.call(crypto, n, ...rest);
  if (n === 32 && !rest.length && /usage-public\.js/.test(new Error().stack || "")) SALTS.push(Buffer.from(b));
  return b;
};

const { openAccounts } = require("../src/accounts");
const { createUsagePublic, pubMinBucket, PUB_MIN_BUCKETS } = require("../src/usage-public");
const { etDayStr } = require("../src/compute");
const src = (rel) => fs.readFileSync(path.join(__dirname, "..", rel), "utf8");
const DAY = 864e5, HOUR = 3600e3;
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const U = (i) => "uid-p" + String(i).padStart(12, "0");
const TABS = ["markets", "trend", "corr", "sectors"].map((k) => ({ key: k, label: k[0].toUpperCase() + k.slice(1), gate: "public" }));
function withMembers(n) {
  const A = openAccounts(fs.mkdtempSync(path.join(os.tmpdir(), "xyz-usage-117-acc-")));
  for (let i = 0; i < n; i++)
    A._db.prepare("INSERT OR IGNORE INTO user (uid, handle, display, pw, epoch, isAdmin, createdAt, lastSeen) VALUES (?,?,?,?,1,0,?,0)").run(U(i), "m" + i, "m" + i, "x", Date.UTC(2026, 0, 1));
  A.hydrate();
  return A;
}
const rowsOf = (A, sql, ...a) => A._db.prepare(sql).all(...a).map((x) => Object.assign({}, x));
// One public visitor's payload through the tracker into accounts.js — the server's store path.
function pubBeat(A, T, ua, tabs, t, extra) {
  const v = T.admit("203.0.113.7", ua, "app.test", t);
  if (v.drop) return v;
  const p = Object.assign({ tabs }, extra || {});
  return A.usagePublicRecord(p.tabs, p.dev || "desktop", t, p, T.note(v.key, p));
}

// ---- 1. the key ----------------------------------------------------------------------------------------------------------------
test("-117 key: deterministic within an ET day, input-sensitive, unrelated after the midnight rotation (fresh salt, fresh maps)", () => {
  const T = createUsagePublic();
  const noon = Date.UTC(2026, 8, 25, 16), later = noon + 5 * HOUR, tomorrow = noon + DAY;
  const k1 = T.keyOf("198.51.100.1", "UA-one", "app.test", noon);
  assert.equal(T.keyOf("198.51.100.1", "UA-one", "app.test", later), k1, "same inputs, same ET day: same key");
  assert.match(k1, /^[A-Za-z0-9_-]{22}$/, "truncated base64url of the HMAC");
  for (const [ip, ua, host] of [["198.51.100.2", "UA-one", "app.test"], ["198.51.100.1", "UA-two", "app.test"], ["198.51.100.1", "UA-one", "other.test"]])
    assert.notEqual(T.keyOf(ip, ua, host, noon), k1, "each input moves the key: " + [ip, ua, host].join("|"));
  assert.equal(T.admit("198.51.100.1", "UA-one", "app.test", later).key, k1);
  assert.equal(T.visitors(), 1);
  assert.equal(T.stale(tomorrow), true);
  const k2 = T.keyOf("198.51.100.1", "UA-one", "app.test", tomorrow);
  assert.notEqual(k2, k1, "a new ET day: a new salt, an unrelated key");
  assert.equal(T.visitors(), 0, "yesterday's per-visitor maps went with yesterday's salt");
  assert.equal(T.day(), etDayStr(tomorrow));
  // the salt is not reachable from the object at all
  assert.ok(!Object.values(T).some((v) => Buffer.isBuffer(v)) && !JSON.stringify(T).includes("salt"));
  // a restart = a new tracker = a new salt: the same visitor, the same day, is a new key (documented re-count)
  assert.notEqual(createUsagePublic().keyOf("198.51.100.1", "UA-one", "app.test", noon), k1);
});

test("-117 caps: per-minute beacons and per-day distinct visitors, each a drop with its reason", () => {
  const T = createUsagePublic({ maxPerMin: 5, maxVisitors: 3 });
  const t = Date.UTC(2026, 8, 25, 16);
  const r = [];
  for (let i = 0; i < 6; i++) r.push(T.admit("1.2.3.4", "UA-" + (i % 4), "h", t + i));
  assert.deepEqual(r.map((x) => x.drop || "ok"), ["ok", "ok", "ok", "visitors", "ok", "rate"], "a 4th distinct visitor over the day's cap; the 6th request over the minute's");
  assert.equal(T.admit("1.2.3.4", "UA-0", "h", t + 60000).key != null, true, "the next minute has a fresh per-minute budget");
  assert.equal(T.admit("1.2.3.4", "UA-9", "h", t + 60001).drop, "visitors", "the visitor cap holds all day");
});

// ---- 7. pv / ptr / pmin math, 6. never mixed, retention ------------------------------------------------------------------------
test("-117 pv / ptr / pmin: distinct visitors per day, per-tab reach per day (mean daily reach), minutes histogram — all under '-1'", () => {
  const A = withMembers(2);
  const T = createUsagePublic();
  const now = Date.now(), y = now - DAY, today = etDayStr(now), yday = etDayStr(y);
  // yesterday: 4 visitors — markets reached by 2, trend by 3; one visitor comes back three times
  pubBeat(A, T, "V1", { markets: 90000, trend: 30000 }, y);
  pubBeat(A, T, "V1", { markets: 90000 }, y + 1000);
  pubBeat(A, T, "V1", { trend: 400000 }, y + 2000);
  pubBeat(A, T, "V2", { markets: 20000 }, y + 3000);
  pubBeat(A, T, "V3", { trend: 70000 }, y + 4000);
  pubBeat(A, T, "V4", { trend: 5000 }, y + 5000);
  // today: 2 visitors, both on markets (V1 again: a NEW key today, counted again — never linked)
  pubBeat(A, T, "V1", { markets: 65000 }, now);
  pubBeat(A, T, "V5", { markets: 10000 }, now + 1);
  pubBeat(A, T, "V6", { markets: 5000 }, now + 2);   // (build 2026.09.25-118) a third visitor: a day under 3 is hidden (usage-118)
  A.usageFlush();
  const R = (kind) => rowsOf(A, "SELECT day, key, n FROM usage_day WHERE uid = '-1' AND kind = ? AND n <> 0 ORDER BY day, key", kind);
  assert.deepEqual(R("pv"), [{ day: yday, key: yday, n: 4 }, { day: today, key: today, n: 3 }]);
  assert.deepEqual(R("ptr"), [{ day: yday, key: yday + "|markets", n: 2 }, { day: yday, key: yday + "|trend", n: 3 }, { day: today, key: today + "|markets", n: 3 }]);
  // yesterday's visitor-day totals: V1 610s (≥ 600s bucket), V2 20s (0), V3 70s (60s), V4 5s (0); today V1 65s (60s), V5 10s (0)
  assert.deepEqual(R("pmin").filter((r) => r.day === yday).map((r) => [+r.key, r.n]).sort((a, b) => a[0] - b[0]), [[0, 2], [60000, 1], [600000, 1]]);
  assert.equal(pubMinBucket(610000), 600000); assert.deepEqual(PUB_MIN_BUCKETS.slice(0, 3), [0, 60000, 120000]);
  const s = A.usageSummary({ r: 7, tabs: TABS, now, pubOnline: 3 });
  const P = s.pub;
  assert.deepEqual([P.kpi.visitorsToday, P.kpi.activeToday, P.kpi.visitorDays, P.kpi.activeVisitorDays, P.kpi.online], [3, 1, 7, 3, 3]);
  assert.equal(P.kpi.medMinPerDay, 1.5, "active visitor-days 70s, 610s, 65s → buckets 60s, 600s, 60s → median bucket 1–2 min, midpoint 1.5");
  const mk = P.tabs.find((t) => t.key === "markets"), tr = P.tabs.find((t) => t.key === "trend");
  assert.equal(mk.reach, (2 / 4 + 3 / 3) / 2, "mean daily reach: 50% yesterday, 100% today");
  assert.equal(tr.reach, (3 / 4 + 0 / 3) / 2);
  assert.equal(mk.ms, 90000 + 90000 + 20000 + 65000 + 10000 + 5000);
  assert.deepEqual(P.series.slice(-2), [{ day: yday, n: 2, v: 4 }, { day: today, n: 1, v: 3 }]);
  // never mixed: members see none of it
  assert.equal(s.kpi.activeRange, 0); assert.equal(s.kpi.activeToday, 0);
  assert.ok(s.tabs.every((t) => t.ms === 0), "the members' tab table carries no public time");
  assert.equal(s.heat.total, 0, "nor the members' heatmap");
  assert.equal(rowsOf(A, "SELECT COUNT(*) AS n FROM usage_day WHERE kind IN ('wk','mo','sc','dev','act','load')")[0].n, 0, "no member-only kinds for visitors");
  A.close();
});

test("-117 retention: public rows keep 30 days and are then deleted — never folded into the members' sitewide '0'", () => {
  const A = withMembers(1);
  const T = createUsagePublic();
  const now = Date.now();
  pubBeat(A, T, "old", { markets: 60000 }, now - 31 * DAY, { tr: { "markets>trend": 1 } });
  pubBeat(A, T, "kept", { markets: 60000 }, now - 29 * DAY, { tr: { "markets>trend": 1 } });
  A.usageRecord(U(0), { trend: 60000 }, "desktop", now - 31 * DAY);
  A.usageFlush();
  const r = A.usageRetain(now);
  assert.ok(r.pub > 0, "the old public rows were deleted");
  assert.equal(rowsOf(A, "SELECT COUNT(*) AS n FROM usage_day WHERE uid = '-1' AND day = ?", etDayStr(now - 31 * DAY))[0].n, 0);
  assert.ok(rowsOf(A, "SELECT COUNT(*) AS n FROM usage_day WHERE uid = '-1' AND day = ?", etDayStr(now - 29 * DAY))[0].n > 0);
  assert.deepEqual(rowsOf(A, "SELECT key, ms FROM usage_day WHERE uid = '0' AND kind = 'tab'"), [{ key: "trend", ms: 60000 }], "the fold took the member's row only");
  assert.equal(A.USAGE_PUB_KEEP_DAYS, 30); assert.equal(A.USAGE_PUB, "-1");
  A.close();
});

// ---- 10. k-threshold -----------------------------------------------------------------------------------------------------------
test("-117 k-threshold for public paths / controls / devices: ≥ 7-day range, complete days, ≥ 3 distinct visitors on one day", () => {
  const A = withMembers(0);
  const T = createUsagePublic();
  const now = Date.now(), y = now - DAY;
  const beat = (ua, t) => pubBeat(A, T, ua, { markets: 30000 }, t, { tr: { "markets>trend": 2 }, en: "markets", ctl: { "markets.window=1d": 1 } });
  beat("a", y); beat("b", y);
  let s = A.usageSummary({ r: 7, tabs: TABS, now }).pub;
  assert.equal(s.site.withheld, "k"); assert.equal(s.site.threshold.members, 0, "(build 2026.09.25-118) a 2-visitor day is hidden entirely: it contributes nothing");
  beat("a", now); beat("b", now); beat("c", now);
  assert.equal(A.usageSummary({ r: 7, tabs: TABS, now }).pub.site.withheld, "k", "today is never a complete day");
  beat("c", y);
  s = A.usageSummary({ r: 7, tabs: TABS, now }).pub;
  assert.equal(s.site.withheld, null);
  assert.equal(s.site.paths.total, 6, "yesterday's 3 × 2 moves only"); assert.equal(s.site.controls.total, 3); assert.equal(s.site.devices.rows[0].ms, 90000);
  assert.equal(A.usageSummary({ r: 6, tabs: TABS, now }).pub.site.withheld, "range");
  // members + public: the per-day bound adds both populations
  const B = withMembers(2), TB = createUsagePublic();
  B.usageRecord(U(0), { markets: 30000 }, "desktop", y, { tr: { "markets>trend": 1 } });
  B.usageRecord(U(1), { markets: 30000 }, "desktop", y, { tr: { "markets>trend": 1 } });
  pubBeat(B, TB, "z", { markets: 30000 }, y, { tr: { "markets>trend": 1 } });
  const sb = B.usageSummary({ r: 7, tabs: TABS, now });
  assert.equal(sb.site.withheld, "k", "two members alone: withheld"); assert.equal(sb.pub.site.withheld, "k", "one visitor alone: withheld");
  // (build 2026.09.25-118) a 1-visitor day adds nothing to "both" either: every per-day public figure needs k ≥ 3 visitors
  assert.equal(sb.pub.both.site.withheld, "k", "2 members + a hidden 1-visitor day = still 2");
  for (const ua of ["z2", "z3"]) pubBeat(B, TB, ua, { markets: 30000 }, y, { tr: { "markets>trend": 1 } });
  const sb3 = B.usageSummary({ r: 7, tabs: TABS, now });
  assert.equal(sb3.pub.both.site.withheld, null); assert.equal(sb3.pub.both.site.paths.total, 5, "2 members' + 3 visitors' moves");
  A.close(); B.close();
});

// ---- 13. errors ----------------------------------------------------------------------------------------------------------------
test("-117 public errors: counted as public hits, never as members affected, never a regression alert, 10 new distinct a day", () => {
  const A = withMembers(30);
  const T = createUsagePublic();
  const now = Date.now();
  A.usageBuildSeen("b-100", now - 10 * DAY);
  for (let i = 0; i < 25; i++) A.usageRecord(U(i), { markets: 60000 }, "desktop", now - 5 * DAY + i * 1000, { build: "b-100", load: true });
  A.usageBuildSeen("b-101", now - 3 * HOUR);
  for (let i = 0; i < 3; i++) A.usageRecord(U(i), { markets: 60000 }, "desktop", now - 2 * HOUR + i, { build: "b-101", load: true });
  const E = [{ loc: "/js/app.js:7", msg: "public-only bug", c: 5 }];
  for (const ua of ["x1", "x2", "x3", "x4"]) pubBeat(A, T, ua, { markets: 10000 }, now, { build: "b-101", errs: E });
  const v = A.usageRegress("b-101", now);
  assert.equal(v.state, "ok", "hit by four visitors, by no member: not a regression — " + JSON.stringify(v.conds));
  A.usageRecord(U(5), {}, null, now - 30 * 60000, { build: "b-101", errs: [{ loc: "/js/app.js:7", msg: "public-only bug", c: 1 }] });
  A.usageFlush();
  const row = A.usageTriage(now).rows.find((r) => r.msg === "public-only bug");
  assert.deepEqual([row.members, row.pubHits, row.hits], [1, 20, 21], "one member affected; the visitors' 20 hits are public hits");
  const s = A.usageSummary({ r: 7, tabs: TABS, now, build: "b-101" });
  assert.equal(s.health.errors.top[0].members, 1); assert.equal(s.health.errors.hits, 1, "the members' card counts members' hits");
  assert.equal(s.pub.health.errors.hits, 20); assert.equal(s.pub.both.health.errors.hits, 21); assert.equal(s.pub.both.health.errors.top[0].members, 1);
  // the shared public budget for NEW distinct errors: 10 per ET day
  const many = Array.from({ length: 15 }, (_, i) => ({ loc: "/js/n" + i + ".js:1", msg: "new " + i, c: 1 }));
  let kept = 0;
  for (const e of many) kept += pubBeat(A, T, "flood-" + e.msg, {}, now, { build: "b-101", errs: [e] }).errs;
  assert.equal(kept, A.USAGE_PUB_ERR_NEW_PER_DAY - 1, "the day's first new public error (above) took one of the ten"); assert.equal(A.USAGE_PUB_ERR_NEW_PER_DAY, 10);
  A.close();
});

test("-117 digest: a public line — visitor-days this week vs last, the top public tabs", () => {
  const A = withMembers(1);
  const T = createUsagePublic();
  const UDG = require("../src/usage-digest");
  const D = etDayStr(Date.now());
  const w = UDG.digestWindows(D);
  const at = (d) => Date.UTC(+d.slice(0, 4), +d.slice(5, 7) - 1, +d.slice(8, 10), 17);
  for (const ua of ["a", "b", "c"]) pubBeat(A, T, ua, { markets: 3600000 }, at(w.a.from));
  pubBeat(A, T, "d", { trend: 600000 }, at(w.a.to));
  pubBeat(A, T, "e", { markets: 60000 }, at(w.b.from));
  const d = A.usageDigestData({ day: D, tabs: TABS });
  // (build 2026.09.25-118) k ≥ 3: the 1-visitor days (w.a.to, w.b.from) are left out
  assert.deepEqual([d.public.visitorDays, d.public.visitorDaysPrev], [3, 0]);
  assert.deepEqual(d.public.top.map((t) => t.key), ["markets"]);
  const text = UDG.digestText(d, { html: false });
  assert.ok(text.includes("🌐 PUBLIC 3 visitor-days (last week 0)") && text.includes("top public tabs: Markets 3.0h"), text);
  assert.equal(d.members.active, 0, "the members' numbers never include a visitor");
  A.close();
});

// ---- 11 / 12. the client ------------------------------------------------------------------------------------------------------------
function usageModule(env) {
  const body = src("public/js/usage.js").split("\n").filter((l) => !/^import /.test(l) && !/^export \{/.test(l)).join("\n").replace(/^export function /gm, "function ");
  const e = env || {};
  return new Function("el", "esc", "state", "window", "document", "navigator", "fetch", "setInterval", "sessionStorage",
    body + "; return { US, __boot_usage_1, usageFlush, usageCtl, usageAct, usageErr, usPublic, usOn, usPubNotice, usageCardHtml, US_PUB_NOTE_KEY };")(
    () => null, esc, e.state || { view: "markets", build: "2026.09.25-117" }, e.window || {}, e.document || {}, e.navigator || {}, () => Promise.resolve({ ok: false }), () => 0, e.sessionStorage || null);
}
function fakeDoc() {
  const kids = [], H = {};
  const doc = { visibilityState: "visible", addEventListener: (t, f) => { H[t] = f; },
    body: { appendChild: (n) => { kids.push(n); n.remove = () => { const i = kids.indexOf(n); if (i >= 0) kids.splice(i, 1); }; } },
    createElement: () => { const n = { attrs: {}, h: {}, setAttribute(k, v) { this.attrs[k] = v; }, addEventListener(t, f) { this.h[t] = f; } }; return n; },
    getElementById: (id) => kids.find((n) => n.id === id) || null };
  return { doc, kids };
}
function fakeStore() { const m = new Map(); return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), m }; }
test("-117 client: a signed-out page beacons (no id, same payload shape) only when the server's shell says public counting is on", () => {
  const sent = [];
  const nav = { sendBeacon: (u, b) => { sent.push([u, b]); return true; } };
  // on
  let F = fakeDoc(), M = usageModule({ window: { __USPUB: true, __ME: null }, document: F.doc, navigator: nav, sessionStorage: fakeStore() });
  M.__boot_usage_1();
  assert.equal(M.usPublic(), true); assert.equal(M.usOn(), true);
  assert.equal(M.usageCtl("markets.csv"), true, "control counts ride the public beacon");
  M.usageAct("csv"); assert.deepEqual(M.US.acts, {}, "the funnel's action counters stay members-only");
  M.usageErr("boom 'secret text'", "http://x/js/app.js", 3);
  assert.equal(M.usageFlush(true), true);
  assert.equal(sent.length, 1); assert.equal(sent[0][0], "/api/usage");
  const b = JSON.parse(sent[0][1]);
  assert.ok(Object.keys(b).every((k) => ["tabs", "pwa", "s", "ctl", "tr", "en", "h", "b", "ld", "perf", "errs", "acts"].includes(k)), "the members' payload fields only: " + Object.keys(b));
  assert.match(b.s, /^[0-9a-z]{8,24}$/, "s: the per-page-load session id (never stored)");
  assert.deepEqual(b.ctl, { "markets.csv": 1 });
  assert.equal(b.errs[0].m, "boom '…'", "quoted text removed before it leaves the page");
  // off (or unset): nothing is counted, nothing is sent, no notice
  for (const w of [{ __USPUB: false }, {}]) {
    F = fakeDoc(); M = usageModule({ window: w, document: F.doc, navigator: nav, sessionStorage: fakeStore() });
    M.__boot_usage_1();
    assert.equal(M.usOn(), false); assert.equal(M.usageCtl("markets.csv"), false); assert.equal(M.usageFlush(true), false);
    assert.equal(F.kids.length, 0);
  }
  assert.equal(sent.length, 1, "no beacon from a page the server did not switch on");
  // a signed-in member ignores __USPUB entirely (the member path; and the card's disclosure says what signed-out means)
  M = usageModule({ window: { __USPUB: true, __ME: { uid: "u1" } }, document: fakeDoc().doc, navigator: nav });
  assert.equal(M.usPublic(), false); assert.equal(M.usOn(), true);
  M.US.mine = { ok: true, keepDays: 30, activeDays: 1, ms: 60000, tabs: [], acts: [] };
  assert.ok(M.usageCardHtml().includes("Signed out, this site counts only anonymous sitewide totals") && M.usageCardHtml().includes("not linked across days, and days with fewer than 3 visitors aren’t shown"));
});

test("-117 client: the signed-out notice renders once per tab and its dismissal is remembered in sessionStorage", () => {
  const store = fakeStore();
  let F = fakeDoc();
  let M = usageModule({ window: { __USPUB: true }, document: F.doc, navigator: {}, sessionStorage: store });
  M.__boot_usage_1();
  assert.equal(F.kids.length, 1);
  const n = F.kids[0];
  assert.equal(n.id, "usPubNote"); assert.equal(n.className, "us-pubnote"); assert.equal(n.attrs.role, "note");
  for (const w of ["Anonymous usage totals are counted", "no cookies, no IPs stored", "not linked across days", "days with fewer than 3 visitors aren’t shown", 'href="/docs#public-usage"', 'data-uspubx="1"'])
    assert.ok(n.innerHTML.includes(w), w);
  assert.equal(M.usPubNotice(), null, "never twice on one page");
  n.h.click({ target: { closest: () => null } });
  assert.equal(F.kids.length, 1, "a click elsewhere on the bar keeps it");
  n.h.click({ target: { closest: (sel) => (sel === "[data-uspubx]" ? {} : null) } });
  assert.equal(F.kids.length, 0, "dismissed");
  assert.equal(store.getItem(M.US_PUB_NOTE_KEY), "1");
  F = fakeDoc(); M = usageModule({ window: { __USPUB: true }, document: F.doc, navigator: {}, sessionStorage: store });
  M.__boot_usage_1();
  assert.equal(F.kids.length, 0, "the same tab's next page load: not shown again");
  // storage blocked (private mode): still renders, and dismissing still removes it
  F = fakeDoc(); M = usageModule({ window: { __USPUB: true }, document: F.doc, navigator: {}, sessionStorage: { getItem() { throw new Error("denied"); }, setItem() { throw new Error("denied"); } } });
  M.__boot_usage_1();
  assert.equal(F.kids.length, 1); F.kids[0].h.click({ target: { closest: () => ({}) } }); assert.equal(F.kids.length, 0);
  // the docs anchor exists and is outside every feature-gated section (a signed-out reader always gets it)
  const docs = src("public/docs.html"), i = docs.indexOf('id="public-usage"');
  assert.ok(i > 0); const sec = docs.lastIndexOf("<section", i);
  assert.ok(!/data-feature/.test(docs.slice(sec, docs.indexOf(">", sec))), "in an ungated section");
  const css = src("public/styles.css"); assert.ok(css.includes(".us-pubnote{") && css.includes(".us-pubnote .us-pubx{"));
});

// ---- the HTTP boundary ------------------------------------------------------------------------------------------------------------
const { buildServer } = require("../server.js");
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
const get = (url, j, h) => app.inject({ method: "GET", url, headers: Object.assign({}, j ? { cookie: j.header() } : {}, h || {}) });
const anon = (ua, body) => post("/api/usage", body, null, { "user-agent": ua });
test.before(async () => { Date.now = () => T0 + skew; app = await buildServer(); });
test.after(async () => { Date.now = realNow; crypto.randomBytes = realRandomBytes; await app.close(); });
const dbRows = (sql, ...a) => {
  const { DatabaseSync } = require("node:sqlite");
  const db = new DatabaseSync(path.join(DATA, "accounts.db"), { readOnly: true });
  try { return db.prepare(sql).all(...a).map((x) => Object.assign({}, x)); } finally { db.close(); }
};
const adminUsage = async (j, r) => JSON.parse((await get("/api/admin/usage?r=" + (r || 7), j)).body);   // also flushes
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
  const bg = jar(); bg.absorb(await post("/login", { password: "break-glass-pw-1" }));
  PP = { gus, bob, bg };
  return PP;
}
const UA_A = "Mozilla/5.0 (X11; Linux x86_64) PublicVisitorAlpha/117.0", UA_B = "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) Mobile PublicVisitorBeta/1";
const pubRows = (kind) => dbRows("SELECT day, key, n, ms FROM usage_day WHERE uid = '-1' AND kind = ? ORDER BY day, key", kind);

test("-117 HTTP: the shell says whether a signed-out page beacons; a signed-out beacon is stored under '-1' only", async () => {
  const { gus, bob, bg } = await people();
  assert.ok((await get("/")).body.includes("window.__USPUB=true;"), "signed out, public on (the default)");
  assert.ok((await get("/", bob)).body.includes("window.__USPUB=false;"), "a member beacons as a member");
  assert.ok((await get("/", gus)).body.includes("window.__USPUB=false;"));
  assert.ok((await get("/", bg)).body.includes("window.__USPUB=false;"), "the break-glass operator is not a visitor");
  const b = await anon(UA_A, { tabs: { markets: 60000, "<script>": 5 }, s: "sessAAAA01", tr: { "markets>trend": 1 }, en: "markets", ctl: { "markets.csv": 2 }, pwa: false });
  assert.equal(b.statusCode, 204); assert.equal(b.headers["cache-control"], "no-store");
  assert.equal((await anon(UA_A, { tabs: [1] })).statusCode, 400, "the same validation");
  assert.equal((await post("/api/usage", JSON.stringify({ tabs: { markets: 1 }, pad: "x".repeat(5000) }), null, { "user-agent": UA_A })).statusCode, 413, "the same 4 KB cap");
  assert.equal((await post("/api/usage", { tabs: { markets: 1 } }, null, { "user-agent": UA_A, "sec-fetch-site": "cross-site" })).statusCode, 403, "the same cross-site refusal");
  // the break-glass operator's beacon is not a visitor's
  assert.equal((await post("/api/usage", { tabs: { trend: 60000 }, s: "sessBGBG01" }, bg, { "user-agent": UA_B })).statusCode, 204);
  const d = await adminUsage(gus);
  const today = etDayStr(Date.now());
  assert.deepEqual(pubRows("tab").map((r) => [r.key, r.ms]), [["markets", 60000]], "unknown tabs dropped; the operator's beacon not stored");
  assert.deepEqual(pubRows("pv"), [{ day: today, key: today, n: 1, ms: 0 }]);
  assert.deepEqual(pubRows("ptr").map((r) => r.key), [today + "|markets"]);
  assert.equal(d.publicOn, true); assert.equal(d.pub.kpi.visitorsToday, "<3", "(build 2026.09.25-118) one visitor today: shown as <3");
  assert.deepEqual(d.pub.live.caps, { perMin: 600, visitors: 20000 }); assert.equal(d.pub.live.forcedOff, false); assert.equal(d.pub.live.toggle, true);
  assert.equal(d.pub.tabs.find((t) => t.key === "markets").ms, 0, "(build 2026.09.25-118) a 1-visitor day's time is hidden");
  assert.equal(d.tabs.find((t) => t.key === "markets").ms, 0, "the members' table never carries it");
  assert.ok(dbRows("SELECT COUNT(*) AS n FROM usage_day WHERE uid NOT IN ('-1') AND kind IN ('tr','en','ctl','tdev')")[0].n === 0, "the sitewide '0' rows got nothing from a visitor");
});

test("-117 HTTP: the rate gate clamps per visitor (held early beacon, wall-time clamp); another visitor is unaffected", async () => {
  const { gus } = await people();
  skew += 5 * 60000;
  const before = (pubRows("tab").find((r) => r.key === "corr") || { ms: 0 }).ms;
  assert.equal((await anon(UA_B, { tabs: { corr: 120000 }, s: "sessBBBB01" })).statusCode, 204);
  skew += 10000;
  assert.equal((await anon(UA_B, { tabs: { corr: 120000 }, s: "sessBBBB01" })).statusCode, 204, "held, not refused");
  await adminUsage(gus);
  assert.equal(pubRows("tab").find((r) => r.key === "corr").ms - before, 120000, "held: nothing recorded yet");
  skew += 40000;
  assert.equal((await anon(UA_B, { tabs: { corr: 120000 }, s: "sessBBBB01" })).statusCode, 204);
  await adminUsage(gus);
  assert.equal(pubRows("tab").find((r) => r.key === "corr").ms - before, 120000 + 50000, "clamped to the 50s of wall time since the session's last accepted beacon");
  // a different visitor has its own gate and budget
  assert.equal((await anon(UA_B + " other", { tabs: { sectors: 120000 }, s: "sessCCCC01" })).statusCode, 204);
  await adminUsage(gus);
  assert.equal(pubRows("tab").find((r) => r.key === "sectors").ms, 120000);
});

test("-117 HTTP: nothing identifying is stored — no IP, User-Agent or key in any usage table, and no salt anywhere on disk", async () => {
  const { gus } = await people();
  await adminUsage(gus);
  assert.ok(SALTS.length >= 1, "the salt the server minted was observed");
  const hosts = ["localhost:80", "localhost"];
  const keys = [];
  for (const salt of SALTS) for (const ua of [UA_A, UA_B, UA_B + " other"]) for (const host of hosts)
    keys.push(crypto.createHmac("sha256", salt).update("127.0.0.1|" + ua + "|" + host).digest("base64url").slice(0, 22));
  const tables = dbRows("SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'usage_%'").map((r) => r.name);
  assert.ok(tables.includes("usage_day") && tables.includes("usage_cfg"));
  const dump = tables.map((t) => JSON.stringify(dbRows("SELECT * FROM " + t))).join("\n");
  for (const bad of ["127.0.0.1", "PublicVisitorAlpha", "PublicVisitorBeta", "iPhone", "Mozilla", ...keys]) assert.ok(!dump.includes(bad), "stored: " + bad);
  // every byte the server wrote under DATA_DIR (the database, its WAL, anything else)
  const files = [];
  const walk = (d) => { for (const f of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, f.name); if (f.isDirectory()) walk(p); else files.push(p); } };
  walk(DATA);
  assert.ok(files.some((f) => /accounts\.db$/.test(f)));
  for (const f of files) {
    const buf = fs.readFileSync(f), txt = buf.toString("latin1");
    for (const salt of SALTS) {
      assert.equal(buf.indexOf(salt), -1, "raw salt bytes in " + f);
      for (const enc of ["hex", "base64", "base64url"]) assert.ok(!txt.includes(salt.toString(enc)), enc + " salt in " + f);
    }
    for (const k of keys) assert.ok(!txt.includes(k), "a visitor key in " + f);
  }
  assert.ok(!src("src/usage-public.js").includes("log("), "the tracker logs nothing");
});

test("-117 HTTP: a new ET day mints a new salt — the same browser is a new, unlinked visitor; toggle off and USAGE_PUBLIC=0 ignore beacons", async () => {
  const { gus, bob } = await people();
  const n0 = SALTS.length;
  skew += DAY;
  const today = etDayStr(Date.now());
  assert.equal((await anon(UA_A, { tabs: { trend: 30000 }, s: "sessDDDD01" })).statusCode, 204);
  await adminUsage(gus);
  assert.equal(SALTS.length, n0 + 1, "one fresh salt for the new day");
  assert.ok(!SALTS[n0].equals(SALTS[n0 - 1]));
  assert.deepEqual(pubRows("pv").filter((r) => r.day === today).map((r) => r.n), [1], "counted afresh: yesterday's visitor is not recognised");
  // the toggle
  const off = await post("/api/admin/usage/public", { on: false }, gus);
  assert.deepEqual(JSON.parse(off.body), { ok: true, toggle: false, on: false, forcedOff: false });
  assert.equal((await post("/api/admin/usage/public", { on: false }, bob)).statusCode, 403, "operator-only");
  assert.equal((await post("/api/admin/usage/public", "on", gus, { "content-type": "text/plain" })).statusCode, 400);
  assert.equal((await post("/api/admin/usage/public", { on: "yes" }, gus)).statusCode, 400);
  assert.equal((await post("/api/admin/usage/public", { on: true }, gus, { "sec-fetch-site": "cross-site" })).statusCode, 403);
  const snap = JSON.stringify(pubRows("tab"));
  skew += 60000;
  assert.equal((await anon(UA_A, { tabs: { trend: 30000 }, s: "sessEEEE01" })).statusCode, 204);
  let d = await adminUsage(gus);
  assert.equal(JSON.stringify(pubRows("tab")), snap, "toggle off: acknowledged, nothing stored");
  assert.equal(d.publicOn, false); assert.equal(d.pub.live.toggle, false);
  assert.ok((await get("/")).body.includes("window.__USPUB=false;"), "and the shell stops signed-out pages from beaconing");
  assert.equal(dbRows("SELECT v FROM usage_cfg WHERE k = 'publicOn'")[0].v, "false", "persisted");
  // back on, but the environment forces it off
  await post("/api/admin/usage/public", { on: true }, gus);
  process.env.USAGE_PUBLIC = "0";
  try {
    skew += 60000;
    assert.equal((await anon(UA_A, { tabs: { trend: 30000 }, s: "sessFFFF01" })).statusCode, 204);
    d = await adminUsage(gus);
    assert.equal(JSON.stringify(pubRows("tab")), snap, "USAGE_PUBLIC=0: nothing stored whatever the toggle says");
    assert.deepEqual([d.publicOn, d.pub.live.toggle, d.pub.live.forcedOff], [false, true, true]);
    assert.ok((await get("/")).body.includes("window.__USPUB=false;"));
    assert.equal(JSON.parse((await post("/api/admin/usage/public", { on: true }, gus)).body).forcedOff, true);
  } finally { delete process.env.USAGE_PUBLIC; }
  assert.ok((await get("/")).body.includes("window.__USPUB=true;"));
});

test("-117 HTTP: the server-wide per-minute cap drops (204) and counts; the operator sees today's drops", async () => {
  const { gus } = await people();
  skew += 2 * 60000;
  const t = Date.now(), freeze = Date.now;
  Date.now = () => t - (t % 60000) + 1000;   // one wall-clock minute for the whole burst
  let codes;
  try {
    const rs = [];
    for (let i = 0; i < 605; i++) rs.push(await anon("burst-" + (i % 3), { tabs: { markets: 1000 }, s: "sessBurst" + (i % 3) }));
    codes = new Set(rs.map((r) => r.statusCode));
  } finally { Date.now = freeze; }
  assert.deepEqual([...codes], [204], "every one of them is a 204 — sendBeacon never reads the answer");
  const d = await adminUsage(gus);
  assert.equal(d.pub.drops.today.rate, 5, "600 per minute, the 5 past it dropped and counted");
  const today = etDayStr(Date.now());
  assert.deepEqual(pubRows("pdrop"), [{ day: today, key: "rate", n: 5, ms: 0 }]);
  // the fold's chip reports it
  const F = fold();
  F.UA.data = d; F.uaRender();
  assert.ok(F.out().includes("public on · " + d.pub.kpi.visitorsToday + " visitors today · 5 dropped"), F.out().slice(0, 600));
});

// ---- 8. anonymous online-now -----------------------------------------------------------------------------------------------------
test("-117 HTTP: anonymous online-now counts open signed-out streams — not members, not the break-glass operator", async () => {
  const { gus, bob, bg } = await people();
  const http = require("http");
  await app.listen({ port: 0, host: "127.0.0.1" });
  const port = app.server.address().port;
  const open = (j) => new Promise((resolve, reject) => {
    const req = http.get({ host: "127.0.0.1", port, path: "/api/events", headers: j ? { cookie: j.header() } : {} }, (res) => resolve({ req, res }));
    req.on("error", reject);
  });
  const held = [];
  try {
    for (const j of [null, null, null, bob, bg]) { const c = await open(j); assert.equal(c.res.statusCode, 200); held.push(c); }
    await new Promise((r) => setTimeout(r, 50));
    let d = await adminUsage(gus);
    assert.equal(d.pub.kpi.online, 3, "three signed-out tabs"); assert.equal(d.kpi.online, 1, "bob, a member, counts as a member");
    held[0].req.destroy();
    await new Promise((r) => setTimeout(r, 150));
    d = await adminUsage(gus);
    assert.equal(d.pub.kpi.online, "<3", "a closed stream leaves the count (and the cache key); (build 2026.09.25-118) 1–2 read <3");
  } finally { for (const c of held) c.req.destroy(); await new Promise((r) => setTimeout(r, 150)); }
});

// ---- 9. the who-toggle: payload and render -------------------------------------------------------------------------------------------
function fold() {
  const body = src("public/js/usageadm.js").split("\n").filter((l) => !/^import /.test(l) && !/^export \{/.test(l)).join("\n");
  const nodes = { admUsageBox: { innerHTML: "", addEventListener() {} }, admUsageSub: { textContent: "" } };
  const F = new Function("el", "esc", "window", "fetch", body + "; return { UA, uaRender, uaDauSvg, uaSiteHtml };")((id) => nodes[id] || null, esc, { __ME: { handle: "gus" } }, () => new Promise(() => {}));
  F.out = () => nodes.admUsageBox.innerHTML;
  return F;
}
test("-117 who: one payload carries members, public and both; each view labels its population; members-only sections say so", async () => {
  const { gus } = await people();
  const d = await adminUsage(gus, 7);
  for (const k of ["kpi", "series", "tabs", "heat", "site", "health", "both", "drops", "live"]) assert.ok(k in d.pub, "pub." + k);
  for (const k of ["medMinPerDay", "site", "health"]) assert.ok(k in d.pub.both, "pub.both." + k);
  assert.equal(d.pub.series.length, 7);
  const F = fold();
  F.UA.data = d;
  F.UA.who = "members"; F.uaRender();
  let o = F.out();
  assert.ok(o.includes('data-uawho="public"') && o.includes('data-uawho="both"') && o.includes('data-uapub="1"') && o.includes("count signed-out visitors (anonymous totals)"));
  assert.ok(o.includes("members with an open tab") && !o.includes("members only"), "the members view is the old fold");
  F.UA.who = "public"; F.uaRender(); o = F.out();
  for (const pin of ["public · open signed-out tabs (not people)", "visitors today", "visitor-days · 7d", "public · daily visitors summed (never linked across days)",
    "public · per active visitor-day (bucketed)", "dropped today", "public · mean daily reach", "hours · public", "Active people per day · <span class=\"us-pop\">public visitors</span>",
    "When people are here · <span class=\"us-pop\">public visitors</span>", "Client health · <span class=\"us-pop\">public visitors</span>", "members only", "public visitors have no per-person rows"])
    assert.ok(o.includes(pin), "public view: " + pin);
  assert.ok(!o.includes("Deploys &amp; gate changes"), "the markers' reach is members-only");
  assert.ok(o.includes('class="us-barp"') && !o.includes('class="us-barf"'), "the chart draws the public series alone");
  F.UA.who = "both"; F.uaRender(); o = F.out();
  for (const pin of ["members + public · per active member- or visitor-day (bucketed)", "distinct members + active public visitor-days", "members used", "hours · members + public",
    "Active people per day · <span class=\"us-pop\">members + public</span>", "stacked"])
    assert.ok(o.includes(pin), "both view: " + pin);
  // stacked: a member day and a public day in one bar
  const svg = F.uaDauSvg([{ day: "2026-09-24", n: 2 }, { day: "2026-09-25", n: 1 }], [], [{ day: "2026-09-24", n: 3 }, { day: "2026-09-25", n: 0 }], null);
  assert.ok(svg.includes("2 active members</title>") && svg.includes("3 active public visitors</title>") && svg.includes("active members and public visitors per day"));
  // the public k-threshold's words
  const w = F.uaSiteHtml({ pub: { site: { withheld: "k", threshold: { k: 3, minDays: 7, members: 2 }, keepDays: 30, nav: null } } }, "public");
  assert.ok(w.includes("not enough visitors to show without identifying someone (n&lt;3)"), w);
  assert.ok(F.uaSiteHtml({ pub: { both: { site: { withheld: "k", threshold: { k: 3, minDays: 7 }, keepDays: 30, nav: null } } } }, "both").includes("not enough members and visitors"));
  // hostile text in a public error still lands escaped
  d.pub.health = { build: "b", perf: { cur: null, prev: null }, errors: { distinct: 1, hits: 2, top: [{ build: "b", loc: "<img src=x>", msg: "<script>x</script>", hits: 2, members: null }] } };
  F.UA.who = "public"; F.uaRender(); o = F.out();
  assert.ok(!o.includes("<img src=x>") && !o.includes("<script>x") && o.includes("&lt;img src=x&gt;"));
  // the triage table has a public column
  assert.ok(src("public/js/usageadm.js").includes("<td class=\"n\">'+(+e.pubHits||0)+'</td>"));
});

test("-117 disclosure: README, the manual (API reference, the note, the env var), the card and the mock say it", () => {
  const readme = src("README.md"), docs = src("public/docs.html"), mock = src("docs/xyz-monitor-usage-stats-mock.html");
  for (const w of ["(build 2026.09.25-117)", "HMAC-SHA256(dailySalt, ip | userAgent | host)", "not linked across days", "uid `'-1'`", "**20,000 distinct visitors per ET day**",
    "**600 public beacons per minute**", "`USAGE_PUBLIC=0` forces it off", "a visitor who returns later that day is counted again", "`sessionStorage`", "**Privacy summary**"])
    assert.ok(readme.includes(w), "README: " + w);
  const note = docs.slice(docs.indexOf('id="public-usage"'), docs.indexOf("</div>", docs.indexOf('id="public-usage"')));
  for (const w of ["No cookies", "not linked across days", "never stored", "at least 3 visitors on one day", "A server restart can count a returning visitor twice"])
    assert.ok(note.includes(w), "manual: " + w);
  assert.ok(docs.includes("<code>POST /api/admin/usage/public</code>") && docs.includes("<tr><td><code>USAGE_PUBLIC</code></td>"));
  assert.ok(/Built in build 2026\.09\.25-117/.test(mock) && mock.includes("<h3>Public visitors, cookieless</h3>"), "the mock marks it built");
  const sv = src("server.js");
  assert.ok(sv.includes('const VERSION = "2026.09.25-118"'));
  assert.ok(sv.includes("const v = usagePub.admit(clientIp(req), ua, String(req.headers.host || \"\"), now);"), "the key's IP is clientIp(): TRUST_PROXY decides, never wider");
  assert.ok(sv.includes('if (!me) return usagePublicBeacon(req, reply);'));
});
