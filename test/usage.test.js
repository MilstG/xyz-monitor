"use strict";
// ===== build 2026.09.24-109: Usage stage A ==========================================================
// The first-party beacon, the daily aggregates behind it, the admin Usage fold and its audited
// drill-in, and the member's own "Your usage" card. Three layers, tested where each lives:
// accounts.js (rollup, retention fold, pause, flush on close), the HTTP boundary (members only,
// validation, clamping, rate limit, admin-only routes, the audit row), and the client (the
// accumulator's visible/idle rules on a fake clock, the flush gap, the fold's render).
const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs"), path = require("path"), os = require("os");

// No SITE_PASSWORD: the open posture, so a signed-out beacon reaches the route (and is ignored there).
const DATA = fs.mkdtempSync(path.join(os.tmpdir(), "xyz-usage-"));
process.env.DATA_DIR = DATA;
delete process.env.SITE_PASSWORD;
process.env.ADMIN_PASSWORD = "break-glass-pw-1";
process.env.XYZ_QUIET = "1";
process.env.XYZ_NO_NET = "1";
delete process.env.TG_BOT_TOKEN; delete process.env.FINNHUB_TOKEN; delete process.env.FRED_KEY;
delete process.env.USAGE_PUBLIC;

const { openAccounts } = require("../src/accounts");
const src = (rel) => fs.readFileSync(path.join(__dirname, "..", rel), "utf8");
const between = (s, a, b) => { const i = s.indexOf(a); assert.ok(i >= 0, "slice start missing: " + a); const j = s.indexOf(b, i + a.length); assert.ok(j > i, "slice end missing: " + b); return s.slice(i, j); };
const DAY = 864e5;
const TABS = [{ key: "markets", label: "Markets", gate: "public" }, { key: "trend", label: "Trend", gate: "public" }, { key: "backtest", label: "Backtest", gate: "admin" }];

function freshAccounts() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "xyz-usage-acc-"));
  const A = openAccounts(dir);
  const add = (uid, handle, createdAt) => {
    A._db.prepare("INSERT INTO user (uid, handle, display, pw, epoch, isAdmin, createdAt, lastSeen) VALUES (?,?,?,?,1,0,?,0)").run(uid, handle, handle, "x", createdAt || Date.now() - 60 * DAY);
  };
  add("uid-ann-000000001", "ann"); add("uid-bob-000000002", "bob"); add("uid-cy-0000000003", "cy<b>", Date.now());
  A.hydrate();
  return { A, dir };
}
const ANN = "uid-ann-000000001", BOB = "uid-bob-000000002";   // cy<b> (joined today) is the third

// ---- accounts.js: storage ------------------------------------------------------------------------
test("-109 usage store: beacons roll up per (ET day, member, kind, key) in one flush; the generation moves", () => {
  const { A } = freshAccounts();
  const now = Date.now(), g0 = A.usageGen();
  A.usageRecord(ANN, { markets: 50000, trend: 20000 }, "desktop", now);
  A.usageRecord(ANN, { markets: 40000 }, "desktop", now);
  A.usageRecord(BOB, { trend: 30000 }, "mobile-pwa", now);
  assert.equal(A._db.prepare("SELECT COUNT(*) AS n FROM usage_day").get().n, 0, "nothing touches SQLite on the request path");
  assert.equal(A.usagePending(), 5, "ann: markets, trend, device; bob: trend, device");
  assert.equal(A.usageFlush(), 5, "one row per (day, uid, kind, key)");
  assert.equal(A.usageGen(), g0 + 1);
  const row = A._db.prepare("SELECT * FROM usage_day WHERE uid = ? AND kind = 'tab' AND key = 'markets'").get(ANN);
  assert.equal(row.ms, 90000); assert.equal(row.n, 2); assert.equal(row.day, require("../src/compute").etDayStr(now), "day = the ET calendar day");
  // a second flush upserts ONTO the stored row
  A.usageRecord(ANN, { markets: 10000 }, "desktop", now); A.usageFlush();
  const again = A._db.prepare("SELECT * FROM usage_day WHERE uid = ? AND kind = 'tab' AND key = 'markets'").get(ANN);
  assert.equal(again.ms, 100000); assert.equal(again.n, 3);
  assert.equal(A._db.prepare("SELECT ms FROM usage_day WHERE uid = ? AND kind = 'dev'").get(BOB).ms, 30000, "the device row carries the beacon's total");
  assert.equal(A.usageFlush(), 0, "an empty flush is free and does not bump the generation");
});

test("-109 usage store: rows past 30 days fold into uid '0' and the per-member rows go; close() flushes the pending minute", () => {
  const { A, dir } = freshAccounts();
  const now = Date.now();
  A.usageRecord(ANN, { markets: 60000 }, "desktop", now - 40 * DAY);
  A.usageRecord(BOB, { markets: 30000, trend: 5000 }, "mobile", now - 40 * DAY);
  A.usageRecord(ANN, { markets: 70000 }, "desktop", now - 29 * DAY);   // inside the window: kept per member
  A.usageRecord(ANN, { markets: 80000 }, "desktop", now);
  const r = A.usageRetain(now);
  assert.equal(r.ok, true);
  const old = require("../src/compute").etDayStr(now - 40 * DAY);
  const site = A._db.prepare("SELECT * FROM usage_day WHERE day = ? AND uid = '0' AND kind = 'tab' AND key = 'markets'").get(old);
  assert.equal(site.ms, 90000, "summed across members"); assert.equal(site.n, 2);
  assert.equal(A._db.prepare("SELECT COUNT(*) AS n FROM usage_day WHERE day = ? AND uid <> '0'").get(old).n, 0, "per-member history past the window is gone");
  assert.equal(A._db.prepare("SELECT COUNT(*) AS n FROM usage_day WHERE uid = ?").get(ANN).n, 4, "29 days ago and today stay per member (tab + dev each)");
  // idempotent: a second run folds nothing twice
  A.usageRetain(now);
  assert.equal(A._db.prepare("SELECT ms FROM usage_day WHERE day = ? AND uid = '0' AND kind = 'tab' AND key = 'markets'").get(old).ms, 90000);
  // the pending minute survives a graceful stop
  A.usageRecord(BOB, { trend: 12345 }, "desktop", now);
  A.close();
  const B = openAccounts(dir);
  assert.equal(B._db.prepare("SELECT ms FROM usage_day WHERE uid = ? AND key = 'trend' AND day = ?").get(BOB, require("../src/compute").etDayStr(now)).ms, 12345);
  B.close();
});

test("-109 usage store: pausing stops recording from the click on, and blanks the member in the summary", () => {
  const { A } = freshAccounts();
  const now = Date.now();
  A.usageRecord(ANN, { markets: 90000 }, "desktop", now);
  assert.equal(A.setUsagePaused(ANN, true).paused, true);
  assert.equal(A.usagePending(), 2, "what was recorded before the click stays");
  assert.deepEqual(A.usageRecord(ANN, { markets: 90000 }, "desktop", now), { ok: true, stored: false });
  assert.equal(A.usagePaused(ANN), true);
  const s = A.usageSummary({ r: 7, tabs: TABS, now });
  const ann = s.members.find((m) => m.handle === "ann");
  assert.equal(ann.paused, true); assert.equal(ann.days, null); assert.deepEqual(ann.top, []);
  A.setUsagePaused(ANN, false);
  assert.equal(A.usageRecord(ANN, { markets: 1000 }, "desktop", now).stored, true);
});

test("-109 usage summary: active = a minute on screen per ET day; reach, stickiness, medians, trend and lapsed", () => {
  const { A } = freshAccounts();
  const now = Date.now();
  for (let d = 0; d < 4; d++) A.usageRecord(ANN, { markets: 20 * 60000, trend: 10 * 60000 }, "desktop", now - d * DAY);   // 4 active days, 30 min each
  A.usageRecord(BOB, { markets: 30000 }, "mobile", now);                   // 30s: seen, not active
  for (let d = 7; d < 9; d++) A.usageRecord(ANN, { markets: 15 * 60000 }, "desktop", now - d * DAY);   // prior 7 days
  const s = A.usageSummary({ r: 7, tabs: TABS, now, online: new Set([BOB]) });
  assert.equal(s.r, 7); assert.equal(s.days.length, 7); assert.equal(s.series.length, 7);
  assert.equal(s.kpi.activeToday, 1, "bob's 30s does not make him active");
  assert.equal(s.kpi.activeRange, 1); assert.equal(s.kpi.online, 1); assert.equal(s.kpi.members, 3);
  assert.equal(s.kpi.stickiness, (4 / 7) / 1);
  assert.equal(s.kpi.medMinPerDay, 30);
  assert.equal(s.kpi.newMembers, 1, "cy joined today"); assert.equal(s.kpi.newActive, 0);
  const mk = s.tabs.find((t) => t.key === "markets");
  assert.equal(mk.users, 1); assert.equal(mk.reach, 1); assert.equal(mk.ms, 4 * 20 * 60000 + 30000, "hours count everyone's time");
  assert.equal(mk.prevMs, 2 * 15 * 60000); assert.ok(mk.delta > 0);
  const ann = s.members.find((m) => m.handle === "ann");
  assert.equal(ann.days, 4); assert.equal(ann.minPerDay, 30); assert.deepEqual(ann.top, ["Markets", "Trend"]); assert.equal(ann.dev, "desktop");
  assert.equal(ann.trend, (4 * 30 - 30) / 30, "vs the prior 7 days, per member (both inside the window)");
  assert.equal(ann.lapsed, true, "never seen for 60 days of membership");
  assert.equal(s.members.find((m) => m.handle === "bob").lapsed, false, "online is never lapsed");
  const s30 = A.usageSummary({ r: 30, tabs: TABS, now });
  assert.equal(s30.priorKept, false); assert.equal(s30.members.find((m) => m.handle === "ann").trend, null, "the prior 30 days are folded: no per-member trend");
  assert.equal(A.usageSummary({ r: 90, tabs: TABS, now }).r, 30, "range max = retention");
});

// ---- the HTTP boundary -----------------------------------------------------------------------------
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
const post = (url, body, j, extra) => app.inject({ method: "POST", url, headers: Object.assign({}, JSONH, j ? { cookie: j.header() } : {}, extra || {}), payload: typeof body === "string" ? body : JSON.stringify(body) });
const get = (url, j, extra) => app.inject({ method: "GET", url, headers: Object.assign({}, j ? { cookie: j.header() } : {}, extra || {}) });
const realNow = Date.now, T0 = realNow();
let skew = 0;
// A frozen clock the tests move by hand: the 30s gap and the wall-time clamp are exact.
test.before(async () => { Date.now = () => T0 + skew; app = await buildServer(); });
test.after(async () => { Date.now = realNow; await app.close(); });

async function people() {
  const gus = jar();
  gus.absorb(await post("/login", { password: "break-glass-pw-1" }));
  gus.absorb(await post("/bootstrap", { handle: "gus", password: "a-long-password-12" }, gus));
  gus.absorb(await post("/login", { handle: "gus", password: "a-long-password-12" }));
  const mint = JSON.parse((await post("/api/access", { op: "mint", days: 1 }, gus)).body);
  const code = mint.code || (mint.invite && mint.invite.code);
  const bob = jar();
  bob.absorb(await get("/join/" + code, bob));
  const j = bob.absorb(await post("/join", { handle: "bob", password: "another-long-pw-12" }, bob));
  assert.equal(j.statusCode, 200, j.body);
  return { gus, bob };
}
let P = null;
const who = async () => (P = P || await people());

test("-109 /api/usage: signed-out is a no-op; a member's beacon is validated, clamped to wall time, rate-limited and device-classed", async () => {
  const { bob } = await who();
  const anon = await post("/api/usage", { tabs: { markets: 60000 } });
  assert.equal(anon.statusCode, 204, "public tracking is off: acknowledged, nothing stored");
  assert.equal((await post("/api/usage", { tabs: { markets: 1 } }, bob, { "sec-fetch-site": "cross-site" })).statusCode, 403, "the cross-site write lock covers it");
  assert.equal((await post("/api/usage", JSON.stringify({ tabs: { markets: 1 }, pad: "x".repeat(5000) }), bob)).statusCode, 413, "4 KB body cap");
  assert.equal((await post("/api/usage", { tabs: [1, 2] }, bob)).statusCode, 400);
  // First beacon after boot: capped at 2 minutes total; unknown tab names never stored. Sent as
  // sendBeacon sends a string (text/plain), with an iPhone UA and the installed flag.
  const iphone = "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148";
  const b1 = await post("/api/usage", JSON.stringify({ tabs: { markets: 200000, "<script>": 5000, bogus: 5000 }, pwa: true }), bob, { "content-type": "text/plain;charset=UTF-8", "user-agent": iphone });
  assert.equal(b1.statusCode, 204);
  assert.equal((await post("/api/usage", { tabs: { markets: 5000 } }, bob)).statusCode, 429, "one accepted beacon per 30s");
  skew += 40000;
  // 40s of wall time since the last accepted one: 120s claimed is scaled down to 40s, proportionally
  assert.equal((await post("/api/usage", { tabs: { markets: 60000, trend: 60000 }, pwa: true }, bob, { "user-agent": iphone })).statusCode, 204);
  const me = JSON.parse((await get("/api/usage/me", bob)).body);
  assert.equal(me.ok, true);
  assert.equal(me.ms, 120000 + 40000);
  assert.deepEqual(me.tabs.map((t) => [t.key, t.ms]), [["markets", 140000], ["trend", 20000]]);
  assert.ok(!me.tabs.some((t) => t.key === "bogus" || t.key === "<script>"));
  assert.deepEqual(me.devices.map((d) => d.key), ["mobile-pwa"], "coarse class + PWA flag, never the UA");
  assert.equal(me.activeDays, 1); assert.equal(me.keepDays, 30); assert.equal(me.paused, false);
  assert.equal((await get("/api/usage/me")).statusCode, 401, "the card is for members");
});

test("-109 pause: the member pauses from the card; beacons are then acknowledged and dropped; __ME carries the state", async () => {
  const { bob } = await who();
  const p = JSON.parse((await post("/api/usage/pause", { paused: true }, bob)).body);
  assert.deepEqual(p, { ok: true, paused: true });
  skew += 40000;
  const before = JSON.parse((await get("/api/usage/me", bob)).body).ms;
  assert.equal((await post("/api/usage", { tabs: { markets: 30000 } }, bob)).statusCode, 204);
  assert.equal(JSON.parse((await get("/api/usage/me", bob)).body).ms, before, "nothing stored while paused");
  assert.ok((await get("/", bob)).body.includes('"usagePaused":true'), "the shell starts the beacon paused");
  assert.equal(JSON.parse((await post("/api/usage/pause", { paused: false }, bob)).body).paused, false);
  assert.equal((await post("/api/usage/pause", { paused: true })).statusCode, 401);
});

test("-109 admin usage: operator-only, cached on the flush generation, the drill-in writes view-usage to the read log", async () => {
  const { gus, bob } = await who();
  assert.equal((await get("/api/admin/usage?r=7", bob)).statusCode, 403, "a member is not the operator");
  assert.equal((await get("/api/admin/usage?r=7")).statusCode, 403, "nor is a stranger");
  assert.equal((await get("/api/admin/usage/member?h=gus", bob)).statusCode, 403);
  const r = await get("/api/admin/usage?r=90", gus);
  assert.equal(r.statusCode, 200);
  const d = JSON.parse(r.body);
  assert.equal(d.r, 30, "range max = the 30-day retention"); assert.equal(d.publicOn, false); assert.equal(d.keepDays, 30);
  assert.ok(d.kpi && Array.isArray(d.series) && Array.isArray(d.tabs) && Array.isArray(d.members));
  const b = d.members.find((m) => m.handle === "bob");
  assert.ok(b && b.days === 1 && b.dev === "mobile-pwa" && b.top[0] === "Markets", JSON.stringify(b));
  assert.equal(d.tabs.find((t) => t.key === "dm").gate, "members", "Messages reads as members-only");
  assert.equal(d.tabs.find((t) => t.key === "backtest").gate, "admin", "gates come from the feature flags");
  const again = await get("/api/admin/usage?r=30", gus, { "if-none-match": r.headers.etag });
  assert.equal(again.statusCode, 304, "unchanged generation → 304");
  const m = await get("/api/admin/usage/member?h=bob", gus);
  assert.equal(m.statusCode, 200);
  const md = JSON.parse(m.body);
  assert.equal(md.handle, "bob"); assert.equal(md.minutes.length, 30); assert.ok(md.tabs.length >= 1);
  const log = JSON.parse((await get("/api/access/dm/audit?limit=5", gus)).body).entries;
  assert.ok(log.some((e) => e.action === "view-usage" && e.detail === "bob" && e.who === "gus"), JSON.stringify(log));
  assert.equal((await get("/api/admin/usage/member?h=nobody", gus)).statusCode, 404);
  // the sitewide panel itself is NOT logged
  const n = log.filter((e) => e.action === "view-usage").length;
  await get("/api/admin/usage?r=7", gus);
  assert.equal(JSON.parse((await get("/api/access/dm/audit?limit=50", gus)).body).entries.filter((e) => e.action === "view-usage").length, n);
});

// ---- the client ------------------------------------------------------------------------------------
function usageModule(env) {
  const body = src("public/js/usage.js").split("\n").filter((l) => !/^import /.test(l) && !/^export \{/.test(l)).join("\n").replace(/^export function /gm, "function ");
  const e = env || {};
  return new Function("el", "esc", "state", "window", "document", "navigator", "fetch", "setInterval",
    body + "; return { US, usAcc, usSetTab, usSetVis, usInput, usTake, usageFlush, usageCardHtml, usageView, __boot_usage_1 };")(
    e.el || (() => null), (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c])),
    e.state || { view: "markets" }, e.window || {}, e.document || {}, e.navigator || {}, e.fetch || (() => Promise.resolve({ ok: false })), e.setInterval || (() => 0));
}

test("-109 accumulator: time counts only while visible AND with input in the last 5 minutes; switches split it per tab", () => {
  const U = usageModule();
  const M = 60000;
  const a = U.usAcc(0, "markets", true);
  assert.deepEqual(U.usTake(a, 2 * M), { markets: 2 * M }, "visible + recent input: counts");
  U.usSetTab(a, "trend", 3 * M);
  U.usSetTab(a, "markets", 3.5 * M);
  assert.deepEqual(U.usTake(a, 4 * M), { markets: 1.5 * M, trend: 0.5 * M }, "each tab gets its own slice");
  // idle: last input at 0 → nothing counts past 5 min, however long the page stays on screen
  assert.deepEqual(U.usTake(a, 60 * M), { markets: 1 * M }, "only up to input + 5 min (4→5 min)");
  assert.deepEqual(U.usTake(a, 90 * M), {}, "an idle wall monitor is not hours on Markets");
  // input after idle restarts the clock from the input, not from the last segment
  U.usInput(a, 100 * M);
  assert.deepEqual(U.usTake(a, 101 * M), { markets: M });
  // hidden: stops at once, and resumes on visible
  U.usSetVis(a, false, 101.5 * M);
  assert.deepEqual(U.usTake(a, 104 * M), { markets: 0.5 * M }, "hidden time never counts");
  U.usInput(a, 104 * M);   // input while hidden (another window focused) does not start a count
  assert.deepEqual(U.usTake(a, 105 * M), {});
  U.usSetVis(a, true, 105 * M);
  assert.deepEqual(U.usTake(a, 106 * M), { markets: M });
  // a view hook on a fresh accumulator
  const b = U.usAcc(0, null, true);
  assert.deepEqual(U.usTake(b, M), {}, "no tab yet: nothing to attribute");
});

test("-109 beacon: flushes through sendBeacon, keeps minutes inside the 30s gap, never beacons signed out or paused", () => {
  const sent = [];
  const win = { __ME: { uid: "u1", handle: "bob", usagePaused: false }, addEventListener() {}, matchMedia: () => ({ matches: true }) };
  let t = 1000000;
  const env = { window: win, navigator: { sendBeacon: (u, b) => { sent.push([u, JSON.parse(b)]); return true; } },
    document: { visibilityState: "visible", addEventListener() {} }, state: { view: "markets" } };
  const U = usageModule(env);
  const realDateNow = Date.now; Date.now = () => t;
  try {
    U.__boot_usage_1();
    t += 45000;
    assert.equal(U.usageFlush(false), true);
    assert.deepEqual(sent[0], ["/api/usage", { tabs: { markets: 45000 }, pwa: true }]);
    t += 10000; U.usageView("trend"); t += 5000;
    assert.equal(U.usageFlush(false), false, "inside the server's 30s gap: held, not dropped");
    t += 30000;
    assert.equal(U.usageFlush(false), true);
    assert.deepEqual(sent[1][1].tabs, { markets: 10000, trend: 35000 }, "the held minutes ride the next beacon");
    U.US.paused = true; t += 60000;
    assert.equal(U.usageFlush(true), false, "paused: never");
    U.US.paused = false; win.__ME = null; t += 60000;
    assert.equal(U.usageFlush(true), false, "signed out: never");
    assert.equal(sent.length, 2);
  } finally { Date.now = realDateNow; }
  // the card: disclosure, the numbers the operator sees, the pause toggle — member text escaped
  win.__ME = { uid: "u1" };
  U.US.mine = { ok: true, keepDays: 30, activeDays: 3, ms: 5400000, tabs: [{ key: "x", label: "<img>", ms: 1 }] };
  const h = U.usageCardHtml();
  assert.ok(h.includes("Your usage") && h.includes("never records what you search") && h.includes("logged in the admin audit"));
  assert.ok(h.includes("1.5h") && h.includes("&lt;img&gt;") && !h.includes("<img>"));
  assert.ok(h.includes('data-uspause="1"') && h.includes("Pause for me"));
  U.US.paused = true;
  assert.ok(U.usageCardHtml().includes('data-uspause="0"') && U.usageCardHtml().includes("paused"));
});

test("-109 admin fold: sits between Access and All messages, loads lazily, renders the panel with every handle escaped", () => {
  const html = src("public/index.html");
  const iA = html.indexOf('data-fold="access"'), iU = html.indexOf('data-fold="usage"'), iM = html.indexOf('data-fold="messages"');
  assert.ok(iA > 0 && iA < iU && iU < iM, "Access → Usage → All messages");
  assert.ok(src("public/js/core.js").includes('usageadm:()=>import("./usageadm.js"),'));
  assert.ok(src("public/js/access.js").includes("lazyCall('usageadm','openUsageAdm')"), "opened through lazyCall");
  assert.ok(src("public/js/access.js").includes("const ADM_AUDIT_LABEL={'view-usage':"), "the read log names the new action");
  assert.ok(src("public/js/backtest.js").includes("  if(switching) overlayCloseAll();\n  usageView(v);"), "showView feeds the accumulator");
  // render with a hostile display name
  const body = src("public/js/usageadm.js").split("\n").filter((l) => !/^import /.test(l) && !/^export \{/.test(l)).join("\n");
  const nodes = { admUsageBox: { innerHTML: "", addEventListener() {} }, admUsageSub: { textContent: "" } };
  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
  const U = new Function("el", "esc", "window", "fetch", body + "; return { UA, uaRender, uaWire };")((id) => nodes[id] || null, esc, { __ME: { handle: "gus" } }, () => new Promise(() => {}));
  U.UA.data = { ok: true, r: 7, keepDays: 30, priorKept: true, publicOn: false,
    kpi: { online: 1, activeToday: 2, activeRange: 3, members: 4, stickiness: 0.5, medMinPerDay: 34, newMembers: 1, newActive: 1 },
    series: [{ day: "2026-09-18", n: 1 }, { day: "2026-09-19", n: 2 }],
    tabs: [{ key: "markets", label: "Markets", gate: "public", users: 3, reach: 1, ms: 7200000, medMin: 40, prevMs: 3600000, delta: 1 },
      { key: "backtest", label: "Backtest", gate: "admin", users: 0, reach: 0, ms: 0, medMin: null, prevMs: 0, delta: null }],
    members: [{ handle: "gus", display: "gus", online: true, lastSeen: Date.now(), days: 5, minPerDay: 30, top: ["Markets"], dev: "desktop", trend: 0.2, paused: false, lapsed: false },
      { handle: "evil", display: "<img src=x onerror=alert(1)>", online: false, lastSeen: 0, days: 0, minPerDay: 0, top: [], dev: null, trend: null, paused: false, lapsed: true },
      { handle: "pat", display: "pat", online: false, lastSeen: Date.now() - 3600000, days: null, minPerDay: null, top: [], dev: null, trend: null, paused: true, lapsed: false }] };
  U.uaRender();
  const out = nodes.admUsageBox.innerHTML;
  assert.ok(!out.includes("<img src=x") && out.includes("&lt;img src=x onerror=alert(1)&gt;"), "member text is escaped");
  for (const pin of ["online now", "active today", "stickiness", "50%", "Active people per day", "Tabs · reach and time", "Members",
    ">quiet<", ">lapsed<", ">paused<", ">you<", "retention 30d", "public off", "+100%", 'data-uah="evil"'])
    assert.ok(out.includes(pin), "fold carries: " + pin);
  assert.equal(nodes.admUsageSub.textContent, "2 active today · 3 in 7d · stickiness 50%");
  // the drill-in says it was logged
  U.UA.sel = "gus"; U.UA.detail = { ok: true, handle: "gus", display: "gus", keepDays: 30, days: ["2026-09-18", "2026-09-19"], minutes: [0, 12], activeDays: 1, ms: 720000,
    tabs: [{ key: "markets", label: "Markets", ms: 720000, share: 1 }], devices: [{ key: "mobile-pwa", ms: 1 }], viewedAt: Date.now() };
  U.uaRender();
  assert.ok(nodes.admUsageBox.innerHTML.includes("logged: “view-usage gus”") && nodes.admUsageBox.innerHTML.includes("PWA · mobile"));
});

test("-109 disclosure: the member guide and README say what is collected; the stale watchlist line is gone", () => {
  const readme = src("README.md"), docs = src("public/docs.html");
  assert.ok(/usage/i.test(between(docs, "Your usage", "</")), "member guide line");
  assert.ok(readme.includes("- **Usage** (build 2026.09.24-109)") && readme.includes("**Not collected**"), "README entry");
  assert.ok(!readme.includes("the server has never seen"), "the watchlist syncs through user_pref now");
  const mock = src("docs/xyz-monitor-usage-stats-mock.html");
  assert.ok(!mock.includes("retention 90d") && mock.includes("retention 30d"), "the mock carries the owner's 30-day decision");
});
