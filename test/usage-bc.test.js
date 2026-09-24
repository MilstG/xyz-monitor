"use strict";
// ===== build 2026.09.24-110: Usage stages B + C =====================================================
// B: action counters (server-side at each call site, csv/drawer-open on the beacon), the adoption
// funnel, join-week retention (the 'wk' bit that survives the 30-day fold), the ET weekday × hour
// heatmap, the drill-in's features row. C: first-paint perf and deduped JS errors on the same
// beacon, the stale-build count, the health cards, the "quiet" flag in Feature visibility.
// Tested where each lives: accounts.js (storage + math), the HTTP boundary (validation, call sites,
// pause), and the client (the beacon's new fields, the fold's render — hostile text escaped).
const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs"), path = require("path"), os = require("os");

const DATA = fs.mkdtempSync(path.join(os.tmpdir(), "xyz-usage-bc-"));
process.env.DATA_DIR = DATA;
delete process.env.SITE_PASSWORD;
process.env.ADMIN_PASSWORD = "break-glass-pw-1";
process.env.XYZ_QUIET = "1";
process.env.XYZ_NO_NET = "1";
delete process.env.TG_BOT_TOKEN; delete process.env.FINNHUB_TOKEN; delete process.env.FRED_KEY;
delete process.env.USAGE_PUBLIC; delete process.env.OPENAI_API_KEY; delete process.env.ANTHROPIC_API_KEY;

const { openAccounts } = require("../src/accounts");
const { freshAccounts } = require("./_shared");
const { etDayStr } = require("../src/compute");
const src = (rel) => fs.readFileSync(path.join(__dirname, "..", rel), "utf8");
const between = (s, a, b) => { const i = s.indexOf(a); assert.ok(i >= 0, a); return s.slice(i, s.indexOf(b, i + a.length) + b.length); };
const DAY = 864e5, MIN = 60000;
const TABS = [{ key: "markets", label: "Markets", gate: "public" }, { key: "trend", label: "Trend", gate: "public" }, { key: "backtest", label: "Backtest", gate: "admin" }];
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const dayShift = (d, n) => new Date(Date.UTC(+d.slice(0, 4), +d.slice(5, 7) - 1, +d.slice(8, 10)) + n * DAY).toISOString().slice(0, 10);
const weekOf = (d) => dayShift(d, -((new Date(d + "T00:00:00Z").getUTCDay() + 6) % 7));

// Members with a chosen join time, straight into the table (the store's own hydrate picks them up).
function withMembers(list) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "xyz-usage-bc-acc-"));
  const A = openAccounts(dir);
  for (const [uid, handle, createdAt] of list)
    A._db.prepare("INSERT INTO user (uid, handle, display, pw, epoch, isAdmin, createdAt, lastSeen) VALUES (?,?,?,?,1,0,?,0)").run(uid, handle, handle, "x", createdAt);
  A.hydrate();
  return A;
}
const U1 = "uid-aaa-000000001", U2 = "uid-bbb-000000002", U3 = "uid-ccc-000000003", U4 = "uid-ddd-000000004", U5 = "uid-eee-000000005";

// ---- B: counters at the store -----------------------------------------------------------------------
test("-110 counters: a stamped call counts 'call', a target also 'target'; paused, disabled and off-list words count nothing", async () => {
  const marks = { "xyz:HOOD": 100 };
  const A = freshAccounts(marks);
  const g = (await A.bootstrap("gustavo", "correct-horse-battery")).user;
  const l = (await A.redeem(A.mintInvite(g.uid, "x", 7, "join").invite.code, "lena", "another-long-password")).user;
  const T = A.threadFor(g.uid, l.uid, true).id;
  const resolve = (x) => (marks["xyz:" + x] ? "xyz:" + x : null);
  const acts = (uid) => Object.fromEntries(A.usageMine(uid, TABS).acts.map((a) => [a.key, a.n]));
  assert.ok(A.send(g.uid, null, "$HOOD looks strong", resolve, { thread: T }).ok);
  const day = new Date(Date.now() + 20 * DAY).toISOString().slice(0, 10);
  assert.ok(A.send(g.uid, null, "$HOOD to 125 by " + day, resolve, { thread: T }).message.call.tg, "a target");
  assert.ok(A.send(g.uid, null, "just words, no ticker", resolve, { thread: T }).ok);
  assert.ok(A.send(g.uid, null, "$HOOD via the bridge", null, { thread: T }).ok, "no resolver (the Telegram bridge): no stamp, no count");
  let a = acts(g.uid);
  assert.equal(a.call, 2, "two stamped calls"); assert.equal(a.target, 1, "one of them a target");
  assert.deepEqual(A.USAGE_ACTS, ["call", "target", "alert", "share", "csv", "ask", "ai-report", "drawer-open", "telegram-link", "push-enable"]);
  assert.equal(A.usageAct(g.uid, "nvda"), false, "a word off the allowlist (a ticker, say) is never stored");
  assert.equal(A.usageAct("nobody", "call"), false);
  A.setUsagePaused(g.uid, true);
  A.send(g.uid, null, "$HOOD again", resolve, { thread: T });
  assert.equal(A.usageAct(g.uid, "alert"), false, "paused: nothing");
  A.setUsagePaused(g.uid, false);
  a = acts(g.uid);
  assert.equal(a.call, 2); assert.equal(a.alert, 0);
  A.usageFlush();
  assert.equal(A._db.prepare("SELECT COUNT(*) AS n FROM usage_day WHERE kind = 'act' AND key LIKE '%HOOD%'").get().n, 0, "no ticker ever lands in usage_day");
  A.close();
});

test("-110 heatmap: beacons bucket by ET weekday × hour, DST-correct both ways, and the grid sums per cell", () => {
  const A = withMembers([[U1, "ann", Date.now() - 90 * DAY]]);
  // Spring forward (Sun 2026-03-08): Friday before is EST (UTC-5), Monday after is EDT (UTC-4) — both 09:xx ET.
  assert.equal(A.usageHourKey(Date.UTC(2026, 2, 6, 14, 30)), "5-09", "Fri 14:30Z = 09:30 EST");
  assert.equal(A.usageHourKey(Date.UTC(2026, 2, 9, 13, 30)), "1-09", "Mon 13:30Z = 09:30 EDT");
  // Fall back (Sun 2026-11-01): 01:30 happens twice — 05:30Z (EDT) and 06:30Z (EST) — both Sunday 01h.
  const a = Date.UTC(2026, 10, 1, 5, 30), b = Date.UTC(2026, 10, 1, 6, 30);
  assert.equal(A.usageHourKey(a), "0-01"); assert.equal(A.usageHourKey(b), "0-01");
  assert.equal(A.usageHourKey(Date.UTC(2026, 10, 2, 4, 30)), "0-23", "Mon 04:30Z is still Sunday 23:30 EST");
  A.usageRecord(U1, { markets: 60000 }, "desktop", a);
  A.usageRecord(U1, { markets: 30000, trend: 30000 }, "desktop", b);
  A.usageRecord(U1, { markets: 45000 }, "desktop", Date.UTC(2026, 10, 2, 14, 5));   // Mon 09:05 EST
  const s = A.usageSummary({ r: 7, tabs: TABS, now: Date.UTC(2026, 10, 2, 18) });
  assert.equal(s.heat.ms[0][1], 120000, "both 01:30s in one Sunday cell");
  assert.equal(s.heat.ms[1][9], 45000);
  assert.equal(s.heat.total, 165000);
  assert.deepEqual([s.heat.peak.dow, s.heat.peak.h], [0, 1]);
  assert.equal(s.heat.coreShare, 45000 / 165000, "share of screen time 08:00–16:00 ET");
  A.close();
});

test("-110 funnel: of the members active in range, who did each thing at least once; hits count everyone", () => {
  const now = Date.now();
  const A = withMembers([[U1, "ann", now - 90 * DAY], [U2, "bob", now - 90 * DAY], [U3, "cy", now - 90 * DAY]]);
  A.usageRecord(U1, { markets: 5 * MIN }, "desktop", now, { acts: { csv: 3 } });
  A.usageRecord(U2, { markets: 5 * MIN }, "desktop", now);
  A.usageAct(U1, "call", now); A.usageAct(U1, "call", now); A.usageAct(U2, "call", now);
  A.usageAct(U3, "call", now);   // cy acted but was never on screen a minute: a hit, not an adopter
  // The store takes any allowlisted word (the server's clamp is what limits a BEACON to csv/drawer-open).
  A.usageRecord(U3, { markets: 20000 }, "desktop", now, { acts: { "drawer-open": 2, call: 9, bogus: 4 } });
  const s = A.usageSummary({ r: 7, tabs: TABS, now });
  const f = Object.fromEntries(s.funnel.map((x) => [x.key, x]));
  assert.equal(s.kpi.activeRange, 2);
  assert.deepEqual([f.call.users, f.call.hits], [2, 4 + 9], "ann and bob adopted; cy's hits still count");
  assert.deepEqual([f.csv.users, f.csv.hits], [1, 3]);
  assert.deepEqual([f["drawer-open"].users, f["drawer-open"].hits], [0, 2]);
  assert.equal(f.share.users, 0);
  assert.equal(s.funnel.length, 10, "every allowlisted action has a row, zero or not");
  A.close();
});

test("-110 cohorts: join-week retention off the weekly bit; not-yet weeks and pre-beacon weeks are null; the bit survives the 30-day fold", () => {
  const now = Date.now(), today = etDayStr(now), thisMon = weekOf(today);
  const at = (mon, dayOff) => new Date(mon + "T17:00:00Z").getTime() + dayOff * DAY;   // noon-ish ET on that date
  const W = (k) => dayShift(thisMon, -7 * k);
  const A = withMembers([
    [U1, "ann", at(W(2), 0)], [U2, "bob", at(W(2), 1)],   // joined two weeks ago
    [U3, "cy", at(W(1), 2)],                               // last week
    [U4, "dee", at(W(7), 0)],                              // seven weeks ago: before the first bit on record
    [U5, "eve", now - 41 * DAY],                           // six-ish weeks ago, active then and now
  ]);
  const act = (uid, t) => A.usageRecord(uid, { markets: 2 * MIN }, "desktop", t);
  act(U1, at(W(2), 1)); act(U1, at(W(1), 1)); act(U1, Math.min(now, at(W(0), 0)));
  act(U2, at(W(2), 2));
  act(U3, at(W(1), 3));
  act(U5, now - 40 * DAY); act(U5, now);
  A.usageRecord(U4, { markets: 30000 }, "desktop", at(W(2), 0));   // 30s: seen, not active — no bit
  A.usageFlush();
  const r = A.usageRetain(now);
  assert.ok(r.dropped > 0, "eve's 40-day-old daily rows folded away");
  assert.equal(A._db.prepare("SELECT COUNT(*) AS n FROM usage_day WHERE uid = ? AND kind = 'tab'").get(U5).n, 1, "only today's daily row is left per member");
  const eveOld = weekOf(etDayStr(now - 40 * DAY));
  assert.equal(A._db.prepare("SELECT COUNT(*) AS n FROM usage_day WHERE uid = ? AND kind = 'wk' AND day = ?").get(U5, eveOld).n, 1, "but the weekly bit for that week survives the fold");
  // SQLite's Monday and the JS Monday agree
  for (const row of A._db.prepare("SELECT day FROM usage_day WHERE kind = 'wk'").all()) assert.equal(weekOf(row.day), row.day);
  const C = A.usageSummary({ r: 7, tabs: TABS, now }).cohorts;
  assert.equal(C.weeks, 8); assert.equal(C.rows.length, 8);
  const row = (mon) => C.rows.find((x) => x.mon === mon);
  const w2 = row(W(2));
  assert.equal(w2.n, 2); assert.equal(w2.cur, 2);
  assert.deepEqual(w2.cells.slice(0, 3), [1, 0.5, 0.5], "both in the join week; only ann after");
  assert.ok(w2.cells.slice(3).every((v) => v === null), "weeks that have not happened are null, never 0");
  assert.deepEqual(row(W(1)).cells.slice(0, 2), [1, 0]);
  assert.equal(row(W(0)).n, 0); assert.ok(row(W(0)).cells.every((v) => v === null), "no joiners: no cells");
  // eve: her join week is older than the per-member window, yet her cohort reads from the bits
  const eveJoin = weekOf(etDayStr(now - 41 * DAY));
  const er = row(eveJoin);
  assert.ok(er && er.n === 1, "eve's cohort is inside the 8-week table");
  const k = Math.round((new Date(eveOld) - new Date(eveJoin)) / (7 * DAY));
  assert.equal(er.cells[k], 1, "active in the week of the folded day");
  assert.equal(er.cells[er.cur], 1, "and active this week");
  // dee joined before any bit existed: the weeks before the first bit are "not measured"
  const dr = row(W(7));
  assert.ok(dr.n === 1);
  const first = C.since;
  dr.cells.forEach((v, i) => { const wk = dayShift(W(7), 7 * i); if (i > dr.cur) assert.equal(v, null); else if (dayShift(wk, 6) < first) assert.equal(v, null, "pre-beacon week " + wk); else assert.equal(v, 0, "measured and absent: " + wk); });
  // paused members are left out of their cohort
  A.setUsagePaused(U2, true);
  assert.equal(A.usageSummary({ r: 7, tabs: TABS, now }).cohorts.rows.find((x) => x.mon === W(2)).n, 1);
  // the bits age out at ~six months
  A._db.prepare("INSERT INTO usage_day (day, uid, kind, key, n, ms) VALUES (?,?,?,?,1,0)").run("2020-01-06", U1, "wk", "2020-01-06");
  A.usageRetain(now);
  assert.equal(A._db.prepare("SELECT COUNT(*) AS n FROM usage_day WHERE kind = 'wk' AND day = '2020-01-06'").get().n, 0);
  A.close();
});

// ---- C: perf and errors at the store ---------------------------------------------------------------
test("-110 perf: first-paint samples bucket into a histogram; p50/p75 per build; the previous build is the latest other one", () => {
  const now = Date.now();
  const A = withMembers([[U1, "ann", now - 90 * DAY], [U2, "bob", now - 90 * DAY]]);
  assert.deepEqual([850, 1999, 2100, 4990, 7400, 90000].map(A.usagePerfBucket), [800, 1900, 2000, 4750, 7000, 30000]);
  for (const v of [800, 850, 1200, 3000]) A.usageRecord(U1, {}, null, now, { build: "B2", perf: v });
  A.usageRecord(U2, {}, null, now - 2 * DAY, { build: "B1", perf: 2500 });
  A.usageRecord(U2, {}, null, now - 3 * DAY, { build: "B0", perf: 9000 });
  const H = A.usageSummary({ r: 7, tabs: TABS, now, build: "B2", stale: 3 }).health;
  assert.deepEqual(H.perf.cur, { build: "B2", n: 4, p50: 850, p75: 1250 }, "bucket midpoints");
  assert.equal(H.perf.prev.build, "B1", "the most recently seen other build");
  assert.equal(H.perf.prev.p50, 2625);
  assert.equal(H.stale, 3);
  assert.equal(A.usageSummary({ r: 7, tabs: TABS, now, build: "B9" }).health.perf.cur, null, "no samples on the running build yet");
  A.close();
});

test("-110 errors: keyed by build|file:line|hash, text in usage_err, capped at 200 distinct per build, members counted, pruned with the window", () => {
  const now = Date.now();
  const A = withMembers([[U1, "ann", now - 90 * DAY], [U2, "bob", now - 90 * DAY]]);
  const e1 = { msg: "Cannot read properties of undefined (reading 'c')", loc: "/js/corr.js:188", c: 3 };
  A.usageRecord(U1, {}, null, now, { build: "B2", errs: [e1] });
  A.usageRecord(U2, {}, null, now, { build: "B2", errs: [Object.assign({}, e1, { c: 1 })] });
  A.usageRecord(U2, {}, null, now, { build: "B2", errs: [{ msg: "<img src=x onerror=alert(1)>", loc: "/js/x.js:1", c: 1 }] });
  assert.equal(A._db.prepare("SELECT COUNT(*) AS n FROM usage_err").get().n, 0, "the request path never touches SQLite");
  A.usageFlush();
  const rows = A._db.prepare("SELECT * FROM usage_err ORDER BY loc").all();
  assert.equal(rows.length, 2);
  assert.match(rows[0].key, /^B2\|\/js\/corr\.js:188\|[0-9a-f]{12}$/);
  const H = A.usageSummary({ r: 7, tabs: TABS, now, build: "B2" }).health;
  assert.equal(H.errors.distinct, 2); assert.equal(H.errors.hits, 5);
  assert.deepEqual(H.errors.top[0], { build: "B2", loc: "/js/corr.js:188", msg: e1.msg, hits: 4, members: 2 });
  assert.equal(H.errors.top[1].msg, "<img src=x onerror=alert(1)>", "stored as data — escaping is every reader's job");
  // the cap: 200 distinct per build, the 201st dropped (and nothing stored for it); other builds unaffected
  for (let i = 0; i < 205; i++) A.usageRecord(U1, {}, null, now, { build: "B3", errs: [{ msg: "e" + i, loc: "/js/y.js:" + i, c: 1 }] });
  const r = A.usageRecord(U1, {}, null, now, { build: "B3", errs: [{ msg: "one more", loc: "/js/z.js:9", c: 1 }] });
  assert.equal(r.errDropped, 1); assert.equal(r.stored, false);
  A.usageFlush();
  assert.equal(A._db.prepare("SELECT COUNT(*) AS n FROM usage_err WHERE build = 'B3'").get().n, A.USAGE_ERR_CAP);
  assert.equal(A.usageRecord(U1, {}, null, now, { build: "B3", errs: [{ msg: "e0", loc: "/js/y.js:0", c: 1 }] }).errs, 1, "a known error still counts at the cap");
  // retention: texts nobody hit inside the window go
  A.usageFlush();
  A._db.prepare("UPDATE usage_err SET lastAt = ? WHERE build = 'B3'").run(now - 40 * DAY);
  const ret = A.usageRetain(now);
  assert.equal(ret.errs, A.USAGE_ERR_CAP);
  assert.ok(A.usageRecord(U1, {}, null, now, { build: "B3", errs: [{ msg: "fresh", loc: "/js/q.js:1", c: 1 }] }).errs === 1, "and the cap frees up again");
  A.close();
});

// ---- the HTTP boundary -------------------------------------------------------------------------------
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
  assert.equal(bob.absorb(await post("/join", { handle: "bob", password: "another-long-pw-12" }, bob)).statusCode, 200);
  const members = JSON.parse((await get("/api/access", gus)).body).members;
  return { gus, bob, gusUid: members.find((m) => m.handle === "gus").uid };
}
let P = null;
const who = async () => (P = P || await people());
const VERSION = /const VERSION = "([^"]+)"/.exec(src("server.js"))[1];
const myActs = async (j) => Object.fromEntries(JSON.parse((await get("/api/usage/me", j)).body).acts.map((a) => [a.key, a.n]));

test("-110 beacon: client-only counters are allowlisted and clamped; perf and errors validated, truncated, deduped; the build drives the stale count", async () => {
  const { gus, bob } = await who();
  const long = "x".repeat(150) + "\u0000\u202e" + "y".repeat(300);
  const body = { tabs: { markets: 30000 }, b: "2026.09.24-109", perf: 1234,
    acts: { csv: 999, "drawer-open": 3, call: 5, alert: 2, "<b>": 1, "ai-report": 4 },
    errs: [
      { m: long, f: "https://evil.example/js/app.js?token=SECRET#frag", l: 42, c: 999 },
      { m: long, f: "https://evil.example/js/app.js?token=OTHER", l: 42, c: 1 },   // the same error once cleaned: deduped
      { m: "b", f: "/js/b.js", l: "7" }, { m: "c", f: "/js/c.js", l: 1e9 }, { m: "", f: "", l: -3 }, { m: "f", f: "/js/f.js", l: 6 }, { m: "g", f: "/js/g.js", l: 7 },
    ] };
  assert.equal((await post("/api/usage", JSON.stringify(body), bob, { "content-type": "text/plain;charset=UTF-8" })).statusCode, 204);
  const a = await myActs(bob);
  assert.equal(a.csv, 50, "clamped to 50 per beacon"); assert.equal(a["drawer-open"], 3);
  assert.equal(a.call, 0, "server-side counters cannot be claimed by a beacon"); assert.equal(a.alert, 0); assert.equal(a["ai-report"], 0);
  const d = JSON.parse((await get("/api/admin/usage?r=7", gus)).body);
  const E = d.health.errors;
  const big = E.top.find((e) => e.msg.startsWith("xxx"));
  assert.ok(big, JSON.stringify(E.top));
  assert.equal(Array.from(big.msg).length, 200, "message cut to 200 characters");
  assert.ok(!/[\u0000-\u001f\u202e]/.test(big.msg), "control and bidi characters gone");
  assert.equal(big.loc, "/js/app.js:42", "no origin, no query string, no fragment");
  assert.ok(!JSON.stringify(d).includes("SECRET"), "the query string never reaches the store");
  assert.equal(big.hits, 50, "hits clamped; the same error twice in one beacon is taken once");
  assert.ok(E.top.some((e) => e.loc === "/js/c.js:0"), "an absurd line number reads as 0");
  assert.equal(E.distinct, 5, "at most five errors per beacon (the first five, after dedupe: app, b, c, empty, f)");
  assert.ok(E.top.some((e) => e.msg === "(no message)" && e.loc === "?:0"));
  assert.equal(d.health.perf.prev && d.health.perf.prev.build, "2026.09.24-109", "the sample landed under the tab's build");
  assert.equal(d.health.stale, 1, "bob's tab runs an older build");
  assert.equal(d.health.build, VERSION);
  // a current-build beacon clears it; a bad build string carries no perf and no errors
  skew += 40000;
  assert.equal((await post("/api/usage", { tabs: { markets: 30000 }, b: VERSION, perf: 700 }, bob)).statusCode, 204);
  skew += 40000;
  assert.equal((await post("/api/usage", { tabs: { markets: 30000 }, b: "<script>", perf: 700, errs: [{ m: "zzz-bad-build", f: "/x.js", l: 1 }] }, bob)).statusCode, 204);
  skew += 40000;
  assert.equal((await post("/api/usage", { b: VERSION, perf: 500000 }, bob)).statusCode, 204, "tabs are optional; an absurd paint is dropped");
  const d2 = JSON.parse((await get("/api/admin/usage?r=7", gus)).body);
  assert.equal(d2.health.stale, 0);
  assert.equal(d2.health.perf.cur.n, 1, "one sample on the running build: the 500s one was refused");
  assert.ok(!d2.health.errors.top.some((e) => e.msg === "zzz-bad-build"));
  assert.equal((await post("/api/usage", { tabs: [1] }, bob)).statusCode, 400, "tabs, when present, must still be an object");
});

test("-110 call sites: share, alert (chat and panel) and push count server-side for the member who did it — and nothing while paused", async () => {
  const { bob, gusUid } = await who();
  const card = { kind: "row", scope: "stocks", tf: "1d", cols: [{ k: "px", l: "Price" }],
    rows: [{ coin: "xyz:NVDA", t: "NVDA", px: 176.4, c: [{ s: "176.40", c: "" }] }], at: 1790000000000 };
  const before = await myActs(bob);
  const sh = JSON.parse((await post("/api/dm", { to: gusUid, card }, bob)).body);
  assert.ok(sh.ok, JSON.stringify(sh));
  assert.ok(JSON.parse((await post("/api/dm", { thread: sh.thread, alert: "any rvol > 3 unusual tape" }, bob)).body).ok);
  assert.ok(JSON.parse((await post("/api/dm", { thread: sh.thread, alert: "list" }, bob)).body).ok, "listing is not creating");
  assert.ok(JSON.parse((await post("/api/alerts/rules", { metric: "px", op: ">", value: 1 }, bob)).body).ok);
  const push = await post("/api/dm/push-sub", { sub: { endpoint: "https://push.example/abc", keys: { p256dh: "k", auth: "a" } } }, bob);
  assert.equal(push.statusCode, 200, push.body);
  assert.equal((await post("/api/dm/push-sub", { sub: { endpoint: "nope" } }, bob)).statusCode, 400);
  const ask = await post("/api/ask", { q: "what is up" }, bob);   // no model key here: answered not-ok, not counted
  assert.ok([200, 401, 403].includes(ask.statusCode), ask.body);
  const after = await myActs(bob);
  assert.equal(after.share - before.share, 1);
  assert.equal(after.alert - before.alert, 2, "one from the chat verb, one from the panel");
  assert.equal(after["push-enable"] - before["push-enable"], 1, "the refused subscription did not count");
  assert.equal(after.ask - before.ask, 0, "an unanswered ask is not an ask");
  assert.equal(after.call, before.call, "no market on this board: no stamp, no call");
  // paused: the same actions count nothing
  assert.ok(JSON.parse((await post("/api/usage/pause", { paused: true }, bob)).body).paused);
  await post("/api/dm", { thread: sh.thread, card }, bob);
  await post("/api/alerts/rules", { metric: "px", op: ">", value: 2 }, bob);
  await post("/api/dm/push-sub", { sub: { endpoint: "https://push.example/def", keys: { p256dh: "k", auth: "a" } } }, bob);
  assert.ok(JSON.parse((await post("/api/usage/pause", { paused: false }, bob)).body).paused === false);
  assert.deepEqual(await myActs(bob), after, "paused means nothing from the click on");
  // the wiring for the routes this suite cannot drive end to end (no model key, no Telegram)
  const sv = src("server.js");
  for (const pin of ['if (r && r.ok) { const me = meOf(req); if (me) usageActFor(me.uid, "ask"); }',
    'if (r && r.ok) { const me = meOf(req); if (me) usageActFor(me.uid, "ai-report"); }',
    'poller.setPushLinkHook((owner) => ACCOUNTS.usageAct(owner, "telegram-link"))',
    'usageActFor(me.uid, "telegram-link"); }'])
    assert.ok(sv.includes(pin), "wired: " + pin);
  assert.ok(src("src/poller.js").includes("if (pushLinkHook && rec.owner) { try { pushLinkHook(rec.owner); } catch (_) {} }"), "a /start link reports its owner");
  assert.ok(src("src/accounts.js").includes('if (ref && refPx > 0) { usageAct(fromUid, "call", now); if (tgOk) usageAct(fromUid, "target", now); }'));
});

test("-110 admin payload + quiet flag: funnel, heat, cohorts and health ride /api/admin/usage; /api/features carries 30-day reach", async () => {
  const { gus, bob } = await who();
  const d = JSON.parse((await get("/api/admin/usage?r=30", gus)).body);
  assert.ok(Array.isArray(d.funnel) && d.funnel.length === 10);
  assert.ok(d.heat && d.heat.ms.length === 7 && d.heat.ms[0].length === 24 && d.heat.total > 0);
  assert.ok(d.cohorts && d.cohorts.rows.length === 8);
  assert.ok(d.health && d.health.errors && "stale" in d.health);
  const m = JSON.parse((await get("/api/admin/usage/member?h=bob", gus)).body);
  assert.ok(Array.isArray(m.acts) && m.acts.find((a) => a.key === "csv").n === 50, "the drill-in's features row");
  const f = await get("/api/features", gus);
  assert.equal(f.statusCode, 200);
  const F = JSON.parse(f.body);
  assert.ok(F.manifest && F.usage && F.usage.r === 30, "features payload keeps its shape and gains usage");
  assert.equal(F.usage.active, 1, "bob is the one member active");
  assert.equal(F.usage.tabs.markets.quiet, false, "markets reached 100%");
  assert.equal(F.usage.tabs.trend.quiet, true, "trend reached nobody: quiet");
  assert.equal((await get("/api/features", bob)).statusCode, 403);
});

// ---- the client ---------------------------------------------------------------------------------------
function usageModule(env) {
  const body = src("public/js/usage.js").split("\n").filter((l) => !/^import /.test(l) && !/^export \{/.test(l)).join("\n").replace(/^export function /gm, "function ");
  const e = env || {};
  return new Function("el", "esc", "state", "window", "document", "navigator", "fetch", "setInterval", "location", "performance",
    body + "; return { US, usageAct, usageErr, usageFirstPaint, usageFlush, usageCardHtml, __boot_usage_1 };")(
    e.el || (() => null), esc, e.state || { view: "markets" }, e.window || {}, e.document || {}, e.navigator || {},
    e.fetch || (() => Promise.resolve({ ok: false })), e.setInterval || (() => 0),
    e.location || { href: "https://site.test/", origin: "https://site.test" }, e.performance || { now: () => 950.4 });
}

test("-110 client beacon: counters, one paint sample, deduped errors and the build ride the flush; paused or hidden, they do not", () => {
  const sent = [], listeners = {};
  const win = { __ME: { uid: "u1", handle: "bob", usagePaused: false }, addEventListener(t, f) { listeners[t] = f; }, matchMedia: () => ({ matches: false }) };
  const doc = { visibilityState: "visible", addEventListener() {} };
  const state = { view: "markets", bootBuild: "2026.09.24-110" };
  let t = 5e6;
  const U = usageModule({ window: win, document: doc, state, navigator: { sendBeacon: (u, b) => { sent.push(JSON.parse(b)); return true; } } });
  const realDateNow = Date.now; Date.now = () => t;
  try {
    U.__boot_usage_1();
    assert.ok(listeners.error && listeners.unhandledrejection, "both error hooks installed");
    for (let i = 0; i < 60; i++) U.usageAct("csv");
    U.usageAct("drawer-open"); U.usageAct("call"); U.usageAct("NVDA");
    U.usageFirstPaint(); U.usageFirstPaint();
    listeners.error({ message: "Boom " + "z".repeat(300), filename: "https://site.test/js/corr.js?v=1", lineno: 188, target: win });
    listeners.error({ message: "Boom " + "z".repeat(300), filename: "https://site.test/js/corr.js?v=2", lineno: 188, target: win });
    listeners.error({ message: "ext", filename: "chrome-extension://abc/inject.js", lineno: 3, target: win });
    listeners.unhandledrejection({ reason: { message: "nope", stack: "Error: nope\n    at f (https://site.test/js/data.js:41:7)\n    at g (https://site.test/js/x.js:1:1)" } });
    listeners.unhandledrejection({ reason: 42 });
    t += 45000;
    assert.equal(U.usageFlush(false), true);
    const b = sent[0];
    assert.equal(b.b, "2026.09.24-110");
    assert.deepEqual(b.acts, { csv: 50, "drawer-open": 1 }, "clamped, and only the two client words");
    assert.equal(b.perf, 950, "performance.now() at the first paint, once");
    assert.equal(b.errs.length, 4);
    assert.deepEqual(b.errs[0], { m: "Boom " + "z".repeat(195), f: "/js/corr.js", l: 188, c: 2 }, "deduped by message + file:line, query dropped, 200 chars");
    assert.equal(b.errs[1].f, "external", "another origin is named, never kept");
    assert.deepEqual([b.errs[2].m, b.errs[2].f, b.errs[2].l], ["unhandled rejection: nope", "/js/data.js", 41], "the first frame's file:line only");
    assert.equal(b.errs[3].m, "unhandled rejection: [object Number]", "a non-Error reason is named by its type, not dumped");
    // next flush: counters and the sample are spent; an error sent once rides later only as new hits
    listeners.error({ message: "ext", filename: "chrome-extension://abc/inject.js", lineno: 3, target: win });
    t += 45000; U.usageFlush(false);
    assert.equal(sent[1].acts, undefined); assert.equal(sent[1].perf, undefined);
    assert.deepEqual(sent[1].errs, [{ m: "ext", f: "external", l: 3, c: 1 }]);
    // at most 20 distinct per page load; the body stays under the server's 4 KB cap
    for (let i = 0; i < 40; i++) U.usageErr("\u0001".repeat(200) + i, "https://site.test/js/q.js", i);   // 6 bytes each once JSON-escaped
    t += 45000; U.usageFlush(false);
    assert.ok(JSON.stringify(sent[2]).length <= 3800 && sent[2].errs.length >= 1 && sent[2].errs.length < 5, "errors dropped from the tail to fit the 4 KB cap");
    assert.ok(U.US.errs.size <= 20, "twenty distinct per page load");
    // paused: nothing is counted and nothing pending survives
    U.US.paused = true; U.usageAct("csv"); U.usageErr("x", "", 0);
    assert.deepEqual(U.US.acts, {});
  } finally { Date.now = realDateNow; }
  // a page loaded in the background never yields a paint sample
  const U2 = usageModule({ window: { __ME: { uid: "u1" }, addEventListener() {} }, document: { visibilityState: "hidden", addEventListener() {} } });
  U2.__boot_usage_1(); U2.usageFirstPaint();
  assert.equal(U2.US.perf, null);
  // the member's card says what is collected now, and shows their counters (escaped)
  const U3 = usageModule({ window: { __ME: { uid: "u1" } } });
  U3.US.mine = { ok: true, keepDays: 30, activeDays: 2, ms: 600000, tabs: [], acts: [{ key: "call", n: 4 }, { key: "<x>", n: 1 }, { key: "csv", n: 0 }] };
  const h = U3.usageCardHtml();
  assert.ok(h.includes("JavaScript errors") && h.includes("first show the markets table") && h.includes("never which ticker"), "disclosure names perf, errors and counters");
  assert.ok(h.includes("calls 4") && h.includes("&lt;x&gt; 1") && !h.includes("CSV exports 0"));
  // the hooks at the call sites
  assert.ok(src("public/js/drawer.js").includes("state.detail=coin;\n  usageAct('drawer-open');"), "drawer opens counted, the ticker never passed");
  assert.ok(/usageAct\('csv'\);/.test(between(src("public/js/corr.js"), "function downloadCSV(", "\n}")), "every CSV export goes through downloadCSV");
  assert.ok(src("public/js/markets.js").includes("renderActionLists();   // the rate-of-change lists under the table describe exactly what it just rendered\n  usageFirstPaint();"), "the sample is taken after the table paint");
});

test("-110 admin fold: heatmap, funnel, cohorts, features row and health render — browser error text is escaped everywhere", () => {
  const body = src("public/js/usageadm.js").split("\n").filter((l) => !/^import /.test(l) && !/^export \{/.test(l)).join("\n");
  const nodes = { admUsageBox: { innerHTML: "", addEventListener() {} }, admUsageSub: { textContent: "" } };
  const U = new Function("el", "esc", "window", "fetch", body + "; return { UA, uaRender };")((id) => nodes[id] || null, esc, { __ME: { handle: "gus" } }, () => new Promise(() => {}));
  const heat = Array.from({ length: 7 }, () => new Array(24).fill(0)); heat[2][9] = 3600000; heat[6][22] = 600000;
  const XSS = "<img src=x onerror=alert(1)>", XSS2 = "\"><script>alert(2)</script>";
  U.UA.data = { ok: true, r: 7, keepDays: 30, priorKept: true, publicOn: false,
    kpi: { online: 1, activeToday: 1, activeRange: 4, members: 5, stickiness: 0.5, medMinPerDay: 20, newMembers: 0, newActive: 0 },
    series: [{ day: "2026-09-23", n: 1 }, { day: "2026-09-24", n: 1 }],
    tabs: [{ key: "markets", label: "Markets", gate: "public", users: 4, reach: 1, ms: 7200000, medMin: 40, prevMs: 0, delta: null }],
    members: [{ handle: "gus", display: "gus", online: true, lastSeen: Date.now(), days: 2, minPerDay: 20, top: ["Markets"], dev: "desktop", trend: null, paused: false, lapsed: false }],
    funnel: [{ key: "call", users: 3, hits: 9 }, { key: "csv", users: 1, hits: 2 }, { key: "<svg>", users: 0, hits: 0 }],
    heat: { ms: heat, total: 4200000, peak: { dow: 2, h: 9, ms: 3600000 }, coreShare: 3600000 / 4200000 },
    cohorts: { weeks: 3, since: "2026-09-07", keepDays: 182, rows: [
      { mon: "2026-09-07", n: 2, cells: [1, 0.5, 0.5], cur: 2 }, { mon: "2026-09-14", n: 1, cells: [1, 0, null], cur: 1 }, { mon: "2026-09-21", n: 0, cells: [null, null, null], cur: 0 }] },
    health: { build: "2026.09.24-110", stale: 2, errCap: 200,
      perf: { cur: { build: "2026.09.24-110", n: 12, p50: 900, p75: 1250 }, prev: { build: XSS2, n: 5, p50: 1300, p75: 2000 } },
      errors: { distinct: 2, hits: 11, top: [{ build: "2026.09.24-110", loc: "/js/corr.js:188", msg: XSS, hits: 9, members: 2 },
        { build: XSS2, loc: XSS2, msg: "</td></tr></table>" + XSS2, hits: 2, members: 1 }] } } };
  U.uaRender();
  const out = nodes.admUsageBox.innerHTML;
  assert.ok(!out.includes("<img src=x") && !out.includes("<script>") && !out.includes("</td></tr></table>\""), "browser error text never lands raw");
  assert.ok(out.includes("&lt;img src=x onerror=alert(1)&gt;") && out.includes("&quot;&gt;&lt;script&gt;"), "it lands escaped");
  assert.ok(!out.includes("<svg>"), "an unknown funnel key is escaped too");
  for (const pin of ["When people are here", "peak <b>Tue 09:00–10:00 ET</b>", "<b>86%</b> of screen time is 08:00–16:00 ET",
    "Feature adoption", "(of 4 active)", "opened Markets", "made a call", ">3 · 75%<", "exported CSV",
    "Retention by join week", ">w0<", ">w2<", ">100<", ">50<", "week in progress", "not measured",
    "Client health", "First paint → table", "0.9s", "/ 1.3s", "−0.4s", "JS errors", ">2 <span class=\"acc-mu\">distinct · 11 hits", "2 members",
    "Stale builds", ">2<", "at most 200 distinct errors", "deliberately not built"])
    assert.ok(out.includes(pin), "fold carries: " + pin);
  assert.equal((out.match(/class="us-heatc"/g) || []).length, 7 * 24, "a full weekday × hour grid");
  // the drill-in's features row
  U.UA.sel = "gus"; U.UA.detail = { ok: true, handle: "gus", display: "gus", keepDays: 30, days: ["2026-09-24"], minutes: [12], activeDays: 1, ms: 720000,
    tabs: [{ key: "markets", label: "Markets", ms: 720000, share: 1 }], devices: [{ key: "desktop", ms: 1 }],
    acts: [{ key: "call", n: 12 }, { key: "target", n: 4 }, { key: "share", n: 0 }, { key: "telegram-link", n: 1 }], viewedAt: Date.now() };
  U.uaRender();
  const dr = nodes.admUsageBox.innerHTML;
  assert.ok(dr.includes("features · 30d") && dr.includes('<span class="acc-chip on">calls 12</span>') && dr.includes('<span class="acc-chip">shares 0</span>') && dr.includes("Telegram links 1"));
  assert.ok(dr.includes("logged: “view-usage gus”"), "the audit line stays");
});

test("-110 quiet flag in Feature visibility, and the disclosure, README and mock say what is collected now", () => {
  const adm = src("public/js/admin.js");
  assert.ok(adm.includes("_admReach=_adm&&_adm.usage||null;"), "reach kept apart from the flag payload");
  assert.ok(adm.includes("const quiet=ru&&ru.quiet?' <span class=\"acc-chip warn adm-quiet\""), "the chip on the tab rows");
  const docs = src("public/docs.html"), readme = src("README.md"), mock = src("docs/xyz-monitor-usage-stats-mock.html");
  const note = between(docs, "<b>Your usage.</b>", "</div>");
  for (const w of ["JavaScript errors", "first", "calls", "never which ticker", "30 days", "each week"]) assert.ok(note.includes(w), "member guide: " + w);
  assert.ok(readme.includes("(build 2026.09.24-110)") && readme.includes("kind='wk'") && readme.includes("deliberately not built"), "README: stages B+C, what is retained, public path");
  assert.ok(/Built in build 2026\.09\.24-110/.test(mock) && !/Build B · adoption, cohorts, heatmap<\/h3><p>Action counters at the existing call sites \(<code>callTarget/.test(mock), "the mock marks B and C as built");
});
