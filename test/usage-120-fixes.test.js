"use strict";
// ===== build 2026.09.25-120: usage fixes for the public (signed-out) visitors ========================================================
// 1. only a MEMBER hit reopens a resolved error / marks it regressed; an error only signed-out pages hit keeps no message text
//    (loc + hash only; the text arrives with a member's hit), triage shows it "public-only · loc", the digest counts it, never quotes it
// 2. ET midnight: the gate's held public beacons land on the OLD day (no negative minutes bucket in the new one)
// 3. "vs prior" on the public tabs is blank when the prior window starts before the 30-day public retention (r > 15)
// 4. toggle off discards the public gate's held beacons at once instead of releasing them into storage
// 5. k ≥ 3: every per-day public figure hides a day with fewer than 3 visitors; online-now 1–2 reads "<3"
// 6. the comment and the words say what the owner decided last; VERSION pins
const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs"), path = require("path"), os = require("os");

const DATA = fs.mkdtempSync(path.join(os.tmpdir(), "xyz-usage-120-fixes-"));
process.env.DATA_DIR = DATA;
delete process.env.SITE_PASSWORD;
process.env.ADMIN_PASSWORD = "break-glass-pw-1";
process.env.XYZ_QUIET = "1";
process.env.XYZ_NO_NET = "1";
delete process.env.TG_BOT_TOKEN; delete process.env.FINNHUB_TOKEN; delete process.env.FRED_KEY; delete process.env.TRUST_PROXY;
delete process.env.USAGE_PUBLIC; delete process.env.OPENAI_API_KEY; delete process.env.ANTHROPIC_API_KEY;
delete process.env.RAILWAY_ENVIRONMENT; delete process.env.RAILWAY_ENVIRONMENT_NAME; delete process.env.RAILWAY_PROJECT_ID;

const { openAccounts } = require("../src/accounts");
const { createUsagePublic } = require("../src/usage-public");
const { etDayStr } = require("../src/compute");
const UDG = require("../src/usage-digest");
const src = (rel) => fs.readFileSync(path.join(__dirname, "..", rel), "utf8");
const DAY = 864e5, HOUR = 3600e3;
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const U = (i) => "uid-q" + String(i).padStart(12, "0");
const TABS = ["markets", "trend", "corr", "sectors"].map((k) => ({ key: k, label: k[0].toUpperCase() + k.slice(1), gate: "public" }));
function withMembers(n, dir) {
  const A = openAccounts(dir || fs.mkdtempSync(path.join(os.tmpdir(), "xyz-usage-120-fixes-acc-")));
  for (let i = 0; i < n; i++)
    A._db.prepare("INSERT OR IGNORE INTO user (uid, handle, display, pw, epoch, isAdmin, createdAt, lastSeen) VALUES (?,?,?,?,1,0,?,0)").run(U(i), "q" + i, "q" + i, "x", Date.UTC(2026, 0, 1));
  A.hydrate();
  return A;
}
const rowsOf = (A, sql, ...a) => A._db.prepare(sql).all(...a).map((x) => Object.assign({}, x));
function pubBeat(A, T, ua, tabs, t, extra) {
  const v = T.admit("203.0.113.8", ua, "app.test", t);
  if (v.drop) return v;
  const p = Object.assign({ tabs }, extra || {});
  return A.usagePublicRecord(p.tabs, p.dev || "desktop", t, p, T.note(v.key, p));
}
const E1 = { msg: "Cannot read x", loc: "/js/a.js:10", c: 1 };

// ---- 1. errors ---------------------------------------------------------------------------------------------------------------------
test("-120 triage: a signed-out hit on a newer build never reopens a resolved error; a member's hit does", () => {
  const A = withMembers(3), T = createUsagePublic();
  const now = Date.now();
  A.usageBuildSeen("B1", now - 3 * DAY); A.usageBuildSeen("B2", now - DAY);
  A.usageRecord(U(0), {}, null, now - 2 * DAY, { build: "B1", errs: [E1] });
  const sig = A.usageTriage(now).rows[0].sig;
  assert.equal(A.usageTriageSet(sig, true, now - HOUR).resolved, true);
  // three visitors (a day that is shown) on the newer build hit it after the click
  for (const ua of ["a", "b", "c"]) pubBeat(A, T, ua, { markets: 1000 }, now, { build: "B2", errs: [E1] });
  assert.equal(A.usageTriageSweep(now + 10), 0, "no reopen from signed-out pages");
  let r = A.usageTriage(now + 20).rows.find((x) => x.sig === sig);
  assert.deepEqual([r.resolved, r.regressed, r.members, r.pubHits], [true, false, 1, 3], "resolved stays resolved; the public hits are counted apart");
  const k = rowsOf(A, "SELECT memAt, lastAt FROM usage_err WHERE build = 'B2'")[0];
  assert.equal(k.memAt, null, "a signed-out hit never sets the member-hit time"); assert.ok(k.lastAt >= now);
  // a member on the newer build: reopened as regressed
  A.usageRecord(U(1), {}, null, now + 30, { build: "B2", errs: [E1] });
  assert.equal(A.usageTriageSweep(now + 40), 1);
  r = A.usageTriage(now + 50).rows.find((x) => x.sig === sig);
  assert.deepEqual([r.resolved, r.regressed, r.regressedBuild, r.members], [false, true, "B2", 2]);
  A.close();
});

test("-120 public-only errors: no message text stored (loc + hash), triage shows 'public-only · loc', the digest counts them and never quotes them", () => {
  const A = withMembers(2), T = createUsagePublic();
  const now = Date.now();
  A.usageBuildSeen("B2", now - DAY);
  const EV = { msg: "Visit evil.example to fix", loc: "/js/app.js:1", c: 1 };
  pubBeat(A, T, "solo", { markets: 1000 }, now - DAY, { build: "B2", errs: [{ msg: "lonely evil.example", loc: "/js/solo.js:2", c: 1 }] });   // a 1-visitor day
  for (const ua of ["a", "b", "c"]) pubBeat(A, T, ua, { markets: 1000 }, now, { build: "B2", errs: [EV] });
  A.usageFlush();
  const stored = rowsOf(A, "SELECT loc, msg, memAt FROM usage_err ORDER BY loc");
  assert.deepEqual(stored, [{ loc: "/js/app.js:1", msg: "", memAt: null }, { loc: "/js/solo.js:2", msg: "", memAt: null }]);
  assert.ok(!JSON.stringify(rowsOf(A, "SELECT * FROM usage_err")).includes("evil.example"), "no visitor's text at rest");
  let tri = A.usageTriage(now);
  assert.equal(tri.rows.length, 1, "the 1-visitor day's error is not listed at all (k ≥ 3)");
  let row = tri.rows[0];
  assert.deepEqual([row.pubOnly, row.msg, row.loc, row.members, row.pubHits], [true, null, "/js/app.js:1", 0, 3]);
  // the digest: no line for it, a count instead
  const d = A.usageDigestData({ now, tabs: TABS });
  assert.equal(d.errors.fresh.length, 0, "no new-error LINE for a public-only error"); assert.equal(d.errors.pubOnly, 1);
  const text = UDG.digestText(d, { html: false });
  assert.ok(text.includes("1 new on signed-out pages only (public-only; no text kept)"), text);
  assert.ok(!text.includes("evil.example") && !text.includes("/js/app.js:1"), text);
  // the public health card: the key without text
  const s = A.usageSummary({ r: 7, tabs: TABS, now, build: "B2" });
  assert.deepEqual([s.pub.health.errors.top[0].msg, s.pub.health.errors.top[0].pubOnly, s.pub.health.errors.top[0].loc], [null, true, "/js/app.js:1"]);
  // a member hits it: the text arrives with the member's hit, and it is a member's error from then on
  A.usageRecord(U(0), {}, null, now + 5, { build: "B2", errs: [EV] });
  A.usageFlush();
  assert.equal(rowsOf(A, "SELECT msg FROM usage_err WHERE loc = '/js/app.js:1'")[0].msg, EV.msg);
  row = A.usageTriage(now + 10).rows[0];
  assert.deepEqual([row.pubOnly, row.msg, row.members], [false, EV.msg, 1]);
  const d2 = A.usageDigestData({ now: now + 10, tabs: TABS });
  assert.deepEqual([d2.errors.fresh.length, d2.errors.pubOnly], [1, 0]);
  // a member's hit that lands in the same flush as a visitor's: the pending row takes the member's text
  const T2 = createUsagePublic(), EW = { msg: "both at once", loc: "/js/w.js:3", c: 1 };
  pubBeat(A, T2, "a", {}, now + 20, { build: "B2", errs: [EW] });
  A.usageRecord(U(1), {}, null, now + 21, { build: "B2", errs: [EW] });
  A.usageFlush();
  assert.deepEqual(rowsOf(A, "SELECT msg, memAt FROM usage_err WHERE loc = '/js/w.js:3'")[0], { msg: "both at once", memAt: now + 21 });
  A.close();
});

test("-120 boot repair: rows written before the memAt column get memAt from the members' hits, and public-only ones lose their text", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "xyz-usage-120-fixes-boot-"));
  let A = withMembers(1, dir);
  const now = Date.now(), day = etDayStr(now);
  A._db.exec("ALTER TABLE usage_err DROP COLUMN memAt");   // a database from before the column
  const ins = A._db.prepare("INSERT INTO usage_err (key, build, loc, msg, firstAt, lastAt) VALUES (?,?,?,?,?,?)");
  ins.run("B|/js/p.js:1|aaaaaaaaaaaa", "B", "/js/p.js:1", "visitor text", now - 5, now - 1);
  ins.run("B|/js/m.js:1|bbbbbbbbbbbb", "B", "/js/m.js:1", "member text", now - 5, now - 2);
  A._db.prepare("INSERT INTO usage_day (day, uid, kind, key, n, ms) VALUES (?,?,?,?,?,0)").run(day, "-1", "err", "B|/js/p.js:1|aaaaaaaaaaaa", 1);
  A._db.prepare("INSERT INTO usage_day (day, uid, kind, key, n, ms) VALUES (?,?,?,?,?,0)").run(day, U(0), "err", "B|/js/m.js:1|bbbbbbbbbbbb", 1);
  A.close();
  A = openAccounts(dir);
  assert.deepEqual(rowsOf(A, "SELECT loc, msg, memAt FROM usage_err ORDER BY loc"),
    [{ loc: "/js/m.js:1", msg: "member text", memAt: now - 2 }, { loc: "/js/p.js:1", msg: "", memAt: null }]);
  A.close();
});

// ---- 3. vs prior ----------------------------------------------------------------------------------------------------------------------
test("-120 public 'vs prior': blank when the prior window starts before the 30-day public retention (r > 15)", () => {
  const A = withMembers(0), T = createUsagePublic(), T2 = createUsagePublic();
  const now = Date.now();
  for (const ua of ["a", "b", "c"]) pubBeat(A, T, ua, { markets: 60000 }, now - 20 * DAY);
  for (const ua of ["a", "b", "c"]) pubBeat(A, T2, ua, { markets: 30000 }, now);
  let P = A.usageSummary({ r: 15, tabs: TABS, now }).pub;
  let mk = P.tabs.find((t) => t.key === "markets");
  assert.deepEqual([P.priorKept, mk.ms, mk.prevMs, mk.delta], [true, 90000, 180000, -0.5], "r = 15: the prior window (days 15–29 back) is all kept");
  P = A.usageSummary({ r: 16, tabs: TABS, now }).pub;
  mk = P.tabs.find((t) => t.key === "markets");
  assert.deepEqual([P.priorKept, mk.prevMs, mk.delta], [false, null, null], "r = 16: the prior window reaches past the retention — no half-empty comparison");
  // the members' own tab table keeps its rule (the sitewide '0' totals survive the fold)
  assert.equal(A.usageSummary({ r: 16, tabs: TABS, now }).priorKept, false);
  // the fold says so, and "both" is blank too
  const F = fold();
  F.UA.data = { r: 16, kpi: {}, tabs: [], pub: P, publicOn: true }; F.UA.who = "public";
  const html = F.uaPubTabsHtml(F.UA.data, "public");
  assert.ok(html.includes("the prior window beyond retention"), html);
  assert.ok(F.uaPubTabsHtml(F.UA.data, "both").includes("the prior window beyond retention"));
  A.close();
});

// ---- 5. k ≥ 3 -------------------------------------------------------------------------------------------------------------------------
test("-120 k ≥ 3: a day with fewer than 3 visitors is left out of every public figure; today's figures and online-now read '<3'", () => {
  const A = withMembers(0);
  const now = Date.now(), y = now - DAY, y2 = now - 2 * DAY, today = etDayStr(now);
  A.usageBuildSeen("b-1", now - 5 * DAY);
  const X = (t, extra) => Object.assign({ build: "b-1", perf: 800, tr: { "markets>trend": 1 }, en: "markets", ctl: { "markets.window=1d": 1 } }, extra || {});
  const Ty2 = createUsagePublic(), Ty = createUsagePublic(), Tt = createUsagePublic();
  // two days back: 3 visitors (shown)
  for (const ua of ["a", "b", "c"]) pubBeat(A, Ty2, ua, { markets: 70000 }, y2, X(y2, { errs: [{ msg: "shown", loc: "/js/s.js:1", c: 1 }] }));
  // yesterday: 2 visitors (hidden) — lots of time, a different error
  for (const ua of ["a", "b"]) pubBeat(A, Ty, ua, { trend: 900000 }, y, X(y, { errs: [{ msg: "hidden", loc: "/js/h.js:1", c: 1 }] }));
  // today: 2 visitors (hidden)
  for (const ua of ["a", "b"]) pubBeat(A, Tt, ua, { corr: 120000 }, now, X(now));
  const s = A.usageSummary({ r: 7, tabs: TABS, now, build: "b-1", pubOnline: 2 });
  const P = s.pub, K = P.kpi;
  assert.deepEqual([K.visitorsToday, K.activeToday, K.online], ["<3", "<3", "<3"]);
  assert.deepEqual([K.visitorDays, K.activeVisitorDays, K.peakDaily, K.hiddenDays, K.k], [3, 3, 3, 2, 3], "range totals: the 3-visitor day only");
  assert.equal(K.meanDaily, 3 / 7);
  assert.equal(K.medMinPerDay, 1.5, "the minutes histogram of the shown day only (70s → the 1–2 min bucket)");
  const sd = new Map(P.series.map((x) => [x.day, x]));
  assert.deepEqual(sd.get(etDayStr(y)), { day: etDayStr(y), n: null, v: null, low: true });
  assert.deepEqual(sd.get(today), { day: today, n: null, v: null, low: true });
  assert.deepEqual(sd.get(etDayStr(y2)), { day: etDayStr(y2), n: 3, v: 3 });
  const tab = (k) => P.tabs.find((t) => t.key === k) || {};
  assert.deepEqual([tab("markets").ms, tab("trend").ms, tab("corr").ms], [210000, 0, 0], "tab time");
  assert.deepEqual([tab("markets").reach, tab("trend").reach, tab("markets").reachDays], [1, 0, 1], "reach (ptr) over shown days only");
  assert.equal(P.heat.total, 210000, "the heatmap");
  assert.deepEqual([P.health.errors.distinct, P.health.errors.top[0].loc, P.health.perf.cur.n], [1, "/js/s.js:1", 3], "errors and first paint");
  assert.equal(P.both.health.errors.hits, 3); assert.equal(P.both.medMinPerDay, 1.5);
  // triage: the hidden day's public hits are not counted; an error only hidden days hit is not listed
  const tri = A.usageTriage(now);
  assert.deepEqual(tri.rows.map((r) => [r.loc, r.pubHits]), [["/js/s.js:1", 3]]);
  // online-now: 0 is 0, 3 is 3
  assert.equal(A.usageSummary({ r: 7, tabs: TABS, now, pubOnline: 0 }).pub.kpi.online, 0);
  assert.equal(A.usageSummary({ r: 7, tabs: TABS, now, pubOnline: 3 }).pub.kpi.online, 3);
  // a day with no visitor at all is 0, not "<3"
  assert.equal(A.usageSummary({ r: 7, tabs: TABS, now: now + 2 * DAY }).pub.kpi.visitorsToday, 0);
  // a third visitor today: today's figures show
  pubBeat(A, Tt, "c", { corr: 120000 }, now + 1, X(now));
  const K3 = A.usageSummary({ r: 7, tabs: TABS, now: now + 2 }).pub.kpi;
  assert.deepEqual([K3.visitorsToday, K3.activeToday, K3.visitorDays, K3.hiddenDays], [3, 3, 6, 1]);
  // the digest's public line counts shown days only
  const w = UDG.digestWindows(today);
  const B = withMembers(0), TB = createUsagePublic(), TB2 = createUsagePublic();
  const at = (d) => Date.UTC(+d.slice(0, 4), +d.slice(5, 7) - 1, +d.slice(8, 10), 17);
  for (const ua of ["a", "b"]) pubBeat(B, TB, ua, { markets: 3600000 }, at(w.a.from));
  for (const ua of ["a", "b", "c"]) pubBeat(B, TB2, ua, { trend: 60000 }, at(w.a.to));
  const dg = B.usageDigestData({ day: today, tabs: TABS });
  assert.deepEqual([dg.public.visitorDays, dg.public.top.map((t) => t.key)], [3, ["trend"]]);
  A.close(); B.close();
});

test("-120 k ≥ 3 in the fold: '<3' in the chip and the KPIs, the note, and 'both' adds a number to '<3' without arithmetic", () => {
  const A = withMembers(0), T = createUsagePublic();
  const now = Date.now();
  pubBeat(A, T, "a", { markets: 70000 }, now);
  const s = A.usageSummary({ r: 7, tabs: TABS, now, pubOnline: 1 });
  const D = Object.assign({}, s, { publicOn: true });
  D.pub.live = { on: true, toggle: true, forcedOff: false, caps: { perMin: 600, visitors: 20000 } };
  const F = fold();
  F.UA.data = D; F.UA.who = "public"; F.uaRender();
  let o = F.out();
  assert.ok(o.includes("public on · &lt;3 visitors today · 0 dropped"), o.slice(0, 800));
  assert.ok(o.includes('<div class="v">&lt;3</div>') && !o.includes("<3<"), "the KPI tiles read <3, escaped");
  assert.ok(o.includes("days with fewer than 3 visitors are hidden"));
  assert.ok(o.includes("so a visit is not linked across days; days with fewer than 3 visitors are hidden"), "the toggle's line");
  F.UA.who = "both"; F.uaRender(); o = F.out();
  assert.ok(o.includes('<div class="v">&lt;3</div>'), "0 members + <3 visitors online");
  assert.ok(!o.includes("NaN"));
  D.kpi.online = 2; F.uaRender(); o = F.out();
  assert.ok(o.includes('<div class="v">2 + &lt;3</div>'));
  A.close();
});

test("-120 triage render: a public-only row shows 'public-only · loc' and no text; the public health list says the text is not kept", () => {
  const F = fold();
  const html = F.uaTriageHtml({ open: 1, total: 1, rows: [{ sig: "/js/a.js|abc", loc: "/js/a.js:1", msg: null, pubOnly: true, firstBuild: "b", lastBuild: "b", firstAt: 1, lastAt: 2, hits: 3, members: 0, pubHits: 3 }] });
  assert.ok(html.includes('<span class="acc-chip">public-only</span> · <span class="mono">/js/a.js:1</span>'), html);
  assert.ok(!html.includes("null") && html.includes("Only a member’s hit reopens a resolved error"));
  const D = { pub: { health: { build: "b", perf: { cur: null, prev: null }, errors: { distinct: 1, hits: 3, top: [{ build: "b", loc: "/js/a.js:1", msg: null, pubOnly: true, hits: 3, members: null }] } } } };
  const h = F.uaPubHealthHtml(D, "public");
  assert.ok(h.includes("public-only · text not kept") && h.includes("top: <span class=\"neg\">/js/a.js:1 · public-only</span>") && !h.includes("null"), h);
});

// ---- the client fold harness (as in usage-120) ------------------------------------------------------------------------------------
function fold() {
  const body = src("public/js/usageadm.js").split("\n").filter((l) => !/^import /.test(l) && !/^export \{/.test(l)).join("\n");
  const nodes = { admUsageBox: { innerHTML: "", addEventListener() {} }, admUsageSub: { textContent: "" } };
  const F = new Function("el", "esc", "window", "fetch", body + "; return { UA, uaRender, uaPubTabsHtml, uaTriageHtml, uaPubHealthHtml };")((id) => nodes[id] || null, esc, { __ME: { handle: "gus" } }, () => new Promise(() => {}));
  F.out = () => nodes.admUsageBox.innerHTML;
  return F;
}

// ---- the HTTP boundary: 2. midnight, 4. toggle off ---------------------------------------------------------------------------------
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
const realNow = Date.now;
// the next ET midnight after the real clock (EDT: 04:00 UTC; EST: 05:00 UTC)
const MID = (() => { let t = realNow() + DAY; const d = etDayStr(t); for (const h of [4, 5]) { const m = Date.UTC(+d.slice(0, 4), +d.slice(5, 7) - 1, +d.slice(8, 10), h); if (etDayStr(m) === d && etDayStr(m - 1) !== d) return m; } return t; })();
let NOW = MID - 2 * HOUR;
const post = (url, body, j, h) => app.inject({ method: "POST", url, headers: Object.assign({}, JSONH, j ? { cookie: j.header() } : {}, h || {}), payload: typeof body === "string" ? body : JSON.stringify(body) });
const get = (url, j) => app.inject({ method: "GET", url, headers: j ? { cookie: j.header() } : {} });
const anon = (ua, body) => post("/api/usage", body, null, { "user-agent": ua });
test.before(async () => { Date.now = () => NOW; app = await buildServer(); });
test.after(async () => { Date.now = realNow; await app.close(); });
const dbRows = (sql, ...a) => {
  const { DatabaseSync } = require("node:sqlite");
  const db = new DatabaseSync(path.join(DATA, "accounts.db"), { readOnly: true });
  try { return db.prepare(sql).all(...a).map((x) => Object.assign({}, x)); } finally { db.close(); }
};
let GUS = null;
async function admin() {
  if (GUS) return GUS;
  const gus = jar();
  gus.absorb(await post("/login", { password: "break-glass-pw-1" }));
  gus.absorb(await post("/bootstrap", { handle: "gus", password: "a-long-password-12" }, gus));
  gus.absorb(await post("/login", { handle: "gus", password: "a-long-password-12" }));
  GUS = gus;
  return gus;
}
const flush = async (j) => (await get("/api/admin/usage?r=7", j)).statusCode;

test("-120 HTTP midnight: the old day's held public beacon lands on the OLD day — no negative minutes bucket in the new one", async () => {
  const gus = await admin();
  const oldDay = etDayStr(MID - 1), newDay = etDayStr(MID);
  NOW = MID - 40000;
  assert.equal((await anon("UA-roll", { tabs: { markets: 50000 }, s: "sessRoll001" })).statusCode, 204);
  NOW = MID - 20000;
  assert.equal((await anon("UA-roll", { tabs: { markets: 20000 }, s: "sessRoll001" })).statusCode, 204, "held (inside the 30s gap)");
  NOW = MID + 30000;
  app.usageSweep(NOW);   // the first sweep after midnight: the rotation
  assert.equal(await flush(gus), 200);
  const pmin = dbRows("SELECT day, key, n FROM usage_day WHERE uid = '-1' AND kind = 'pmin' ORDER BY day, key");
  assert.ok(pmin.every((r) => r.n >= 0), "never a negative bucket: " + JSON.stringify(pmin));
  assert.deepEqual(pmin.filter((r) => r.n !== 0), [{ day: oldDay, key: "60000", n: 1 }], "one visitor-day of 50s + 20s, on the old day");
  assert.deepEqual(dbRows("SELECT day, n FROM usage_day WHERE uid = '-1' AND kind = 'pv'"), [{ day: oldDay, n: 1 }]);
  assert.deepEqual(dbRows("SELECT day, ms FROM usage_day WHERE uid = '-1' AND kind = 'tab'"), [{ day: oldDay, ms: 70000 }], "the held minutes recorded on the old day");
  assert.equal(dbRows("SELECT COUNT(*) AS n FROM usage_day WHERE uid = '-1' AND day = ?", newDay)[0].n, 0, "nothing of the old day in the new one");
  // the same browser on the new day: a new visitor there
  NOW = MID + 60000;
  assert.equal((await anon("UA-roll", { tabs: { markets: 10000 }, s: "sessRoll002" })).statusCode, 204);
  await flush(gus);
  assert.deepEqual(dbRows("SELECT day, n FROM usage_day WHERE uid = '-1' AND kind = 'pv' ORDER BY day"), [{ day: oldDay, n: 1 }, { day: newDay, n: 1 }]);
  assert.ok(src("server.js").includes("const end = usagePubDayEnd(usagePub.day(), now);"));
});

test("-120 HTTP toggle off: the public gate's held beacons are discarded at once, never released into storage", async () => {
  const gus = await admin();
  NOW = MID + HOUR;
  const tabMs = () => dbRows("SELECT COALESCE(SUM(ms), 0) AS s FROM usage_day WHERE uid = '-1' AND kind = 'tab' AND key = 'sectors'")[0].s;
  assert.equal((await anon("UA-off", { tabs: { sectors: 30000 }, s: "sessOff0001" })).statusCode, 204);
  NOW += 10000;
  assert.equal((await anon("UA-off", { tabs: { sectors: 10000 }, s: "sessOff0001" })).statusCode, 204, "held");
  await flush(gus);
  assert.equal(tabMs(), 30000);
  assert.equal(JSON.parse((await post("/api/admin/usage/public", { on: false }, gus)).body).on, false);
  NOW += 60000;
  app.usageSweep(NOW, true);   // even the shutdown sweep (release everything) stores nothing
  await flush(gus);
  assert.equal(tabMs(), 30000, "the held 10s went with the toggle");
  // back on: the discarded payload does not come back
  await post("/api/admin/usage/public", { on: true }, gus);
  NOW += 60000;
  app.usageSweep(NOW, true);
  await flush(gus);
  assert.equal(tabMs(), 30000);
  // USAGE_PUBLIC=0 discards on the regular sweep too
  NOW += 60000;
  assert.equal((await anon("UA-off2", { tabs: { sectors: 30000 }, s: "sessOff0002" })).statusCode, 204);
  NOW += 10000;
  assert.equal((await anon("UA-off2", { tabs: { sectors: 10000 }, s: "sessOff0002" })).statusCode, 204, "held");
  process.env.USAGE_PUBLIC = "0";
  try { NOW += 60000; app.usageSweep(NOW); } finally { delete process.env.USAGE_PUBLIC; }
  NOW += 60000; app.usageSweep(NOW, true);
  await flush(gus);
  assert.equal(tabMs(), 60000, "the second visitor's first 30s only");
});

// ---- 6. words and pins ----------------------------------------------------------------------------------------------------------------
test("-120 words: the comment states the owner's later decision; the notice, the card, the manual and README say 'not linked' and k ≥ 3", () => {
  const sv = src("server.js");
  assert.ok(sv.includes('const VERSION = "2026.09.25-121"'));
  assert.ok(sv.includes("later reversed it — public counting is ON BY DEFAULT, the") && sv.includes("admin toggle in the Usage fold (usage_cfg.publicOn) switches it, and env USAGE_PUBLIC=0 forces it"));
  const u = src("public/js/usage.js");
  assert.ok(u.includes("a visit is not linked across days, and days with fewer than 3 visitors aren’t shown."));
  assert.ok(!u.includes("can’t be linked"), "the stronger claim is gone from the notice and the card");
  const docs = src("public/docs.html"), note = docs.slice(docs.indexOf('id="public-usage"'), docs.indexOf("</div>", docs.indexOf('id="public-usage"')));
  for (const w of ["not linked across days", "Days with fewer than 3 visitors aren't shown", "not its message text"]) assert.ok(note.includes(w), "manual: " + w);
  assert.ok(!note.includes("can't be linked"));
  const readme = src("README.md");
  assert.ok(readme.includes("(build 2026.09.25-120)") && readme.includes("**k ≥ 3 per day, everywhere**") && readme.includes("nothing linked across days; days with fewer than 3 visitors aren't shown"));
  assert.ok(!readme.includes("cannot be linked across days"));
  assert.ok(src("public/js/usageadm.js").includes("so a visit is not linked across days; '+UA_PUB_K_NOTE+'"));
});
