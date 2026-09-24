"use strict";
// ===== build 2026.09.24-110 follow-up: Usage review fixes ==============================================
// 1. a client-chosen build stamp no longer mints error / perf buckets: only builds this deployment
//    served count; usage_err is capped overall (LRU) and per member per day; the summary reads only
//    this build's and the previous one's errors; /api/features' reach is memoized.
// 2. the previous build for the paint comparison is the latest KNOWN one with enough samples.
// 3. early beacons are held and merged, never dropped; per page session, bounded per member.
// 4. the member's card lists what the guide lists; quoted text is stripped from error messages.
// 5. the weekly-active bits are kept 8 weeks (asserted in usage-bc.test.js beside the cohort test).
const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs"), path = require("path"), os = require("os");

const DATA = fs.mkdtempSync(path.join(os.tmpdir(), "xyz-usage-fu-"));
process.env.DATA_DIR = DATA;
delete process.env.SITE_PASSWORD;
process.env.ADMIN_PASSWORD = "break-glass-pw-1";
process.env.XYZ_QUIET = "1";
process.env.XYZ_NO_NET = "1";
delete process.env.TG_BOT_TOKEN; delete process.env.FINNHUB_TOKEN; delete process.env.FRED_KEY;
delete process.env.USAGE_PUBLIC; delete process.env.OPENAI_API_KEY; delete process.env.ANTHROPIC_API_KEY;

const { openAccounts } = require("../src/accounts");
const { createUsageGate } = require("../src/usage-gate");
const src = (rel) => fs.readFileSync(path.join(__dirname, "..", rel), "utf8");
const between = (s, a, b) => { const i = s.indexOf(a); assert.ok(i >= 0, a); return s.slice(i, s.indexOf(b, i + a.length) + b.length); };
const DAY = 864e5;
const TABS = [{ key: "markets", label: "Markets", gate: "public" }, { key: "trend", label: "Trend", gate: "public" }];
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const U1 = "uid-aaa-000000001";

function withMembers(list, dir) {
  const A = openAccounts(dir || fs.mkdtempSync(path.join(os.tmpdir(), "xyz-usage-fu-acc-")));
  for (const [uid, handle, createdAt] of list)
    A._db.prepare("INSERT OR IGNORE INTO user (uid, handle, display, pw, epoch, isAdmin, createdAt, lastSeen) VALUES (?,?,?,?,1,0,?,0)").run(uid, handle, handle, "x", createdAt);
  A.hydrate();
  return A;
}
const count = (A, sql) => A._db.prepare(sql).get().n;

// ---- 1. the known-build gate and the error caps, at the store ---------------------------------------
test("-110 fu: a beacon's build counts only if the deployment served it — a fresh stamp per beacon mints nothing (the reviewer's flood)", () => {
  const now = Date.now();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "xyz-usage-fu-acc-"));
  let A = withMembers([[U1, "ann", now - 90 * DAY]], dir);
  assert.deepEqual(A.usageBuilds(), [], "nothing served yet: nothing believed");
  for (const b of ["B0", "B1", "B2", "B3", "B4"]) A.usageBuildSeen(b, now - 10 * DAY);
  A.usageBuildSeen("B4", now);   // a re-deploy of the same build keeps its place
  assert.deepEqual(A.usageBuilds(), ["B4", "B3", "B2", "B1"], "the current build and the 3 before it");
  A.close();
  A = withMembers([], dir);
  assert.deepEqual(A.usageBuilds(), ["B4", "B3", "B2", "B1"], "persisted across a restart");
  assert.equal(A.usageBuildKnown("B0"), false, "aged out");
  // the review's repro: 2880 beacons (a day at a 30s gap), each a fresh stamp with 5 errors
  for (let i = 0; i < 2880; i++)
    A.usageRecord(U1, { markets: 1000 }, "desktop", now, { build: "b" + i, perf: 1500, errs: [1, 2, 3, 4, 5].map((j) => ({ msg: "x".repeat(190) + j, loc: "/a.js:" + j, c: 1 })) });
  A.usageFlush();
  assert.equal(count(A, "SELECT COUNT(*) AS n FROM usage_err"), 0, "no error rows");
  assert.equal(count(A, "SELECT COUNT(*) AS n FROM usage_day WHERE kind IN ('perf','err')"), 0, "no perf or err rows");
  assert.equal(A.usageMine(U1, TABS).ms, 2880 * 1000, "the screen time still counts");
  // a known build keeps them
  const r = A.usageRecord(U1, {}, null, now, { build: "B4", perf: 900, errs: [{ msg: "e", loc: "/a.js:1", c: 1 }] });
  assert.equal(r.perf, 1); assert.equal(r.errs, 1);
  A.close();
});

test("-110 fu: at most 20 new distinct errors per member per ET day; 500 rows overall, least-recently-seen evicted (and deleted at the flush)", () => {
  const now = Date.now();
  const members = Array.from({ length: 40 }, (_, i) => ["uid-m" + String(i).padStart(12, "0"), "m" + i, now - 90 * DAY]);
  const A = withMembers(members);
  A.usageBuildSeen("B1", now - 2 * DAY); A.usageBuildSeen("B2", now - DAY);
  assert.equal(A.USAGE_ERR_NEW_PER_DAY, 20); assert.equal(A.USAGE_ERR_TOTAL, 500);
  const e = (k) => ({ msg: "err " + k, loc: "/js/a.js:" + k, c: 1 });
  const one = members[0][0];
  let kept = 0;
  for (let i = 0; i < 30; i++) kept += A.usageRecord(one, {}, null, now, { build: "B2", errs: [e("d" + i)] }).errs;
  assert.equal(kept, 20, "the 21st new error today is dropped");
  assert.equal(A.usageRecord(one, {}, null, now, { build: "B2", errs: [e("d0")] }).errs, 1, "a known error still counts");
  assert.equal(A.usageRecord(one, {}, null, now + DAY, { build: "B2", errs: [e("next-day")] }).errs, 1, "a new ET day, a new allowance");
  A.usageFlush();
  // fill past 500 overall across members (each under its daily cap, each build under 200)
  let t = now - 20 * DAY, n = 0;
  for (let d = 0; d < 20 && n < 700; d++) for (const [uid] of members) {
    for (let j = 0; j < 2; j++) { A.usageRecord(uid, {}, null, t + d * DAY + n, { build: n % 2 ? "B1" : "B2", errs: [e("f" + n)] }); n++; }
    if (n >= 700) break;
  }
  // a per-build cap of 200 means B1 and B2 top out at 400 together — the overall cap needs a third build
  A.usageBuildSeen("B3", now);
  for (let i = 0; i < 150; i++) A.usageRecord(members[1 + (i % 30)][0], {}, null, now + 2 * DAY + i, { build: "B3", errs: [e("g" + i)] });
  const before = count(A, "SELECT COUNT(*) AS n FROM usage_err");
  A.usageFlush();
  const total = count(A, "SELECT COUNT(*) AS n FROM usage_err");
  assert.ok(before <= 500 && total === 500, "capped at 500 overall: " + before + " → " + total);
  const newest = A._db.prepare("SELECT MIN(lastAt) AS m FROM usage_err WHERE build = 'B3'").get().m;
  assert.ok(newest >= now + 2 * DAY, "the most recent ones stay");
  const has = (k) => count(A, "SELECT COUNT(*) AS n FROM usage_err WHERE loc = '/js/a.js:" + k + "'");
  assert.equal(has("f0") + has("f1") + has("f2"), 0, "the least recently seen went first");
  assert.equal(has("d0"), 1, "a recently seen one stays");
  assert.equal(A.usageSummary({ r: 30, tabs: TABS, now: now + 2 * DAY, build: "B3" }).health.errors.top.length, 5, "the summary still reads its five");
  // a restart rebuilds the same index from ≤500 rows
  A.close();
});

test("-110 fu: the previous build is the latest KNOWN other build with ≥5 samples; a spoofed stamp can never be it; errors shown are this build's and the one before", () => {
  const now = Date.now();
  const A = withMembers([[U1, "ann", now - 90 * DAY]]);
  A.usageBuildSeen("B1", now - 9 * DAY); A.usageBuildSeen("B2", now - 5 * DAY); A.usageBuildSeen("B3", now - DAY);
  for (let i = 0; i < 5; i++) A.usageRecord(U1, {}, null, now - 4 * DAY, { build: "B1", perf: 900 });
  for (let i = 0; i < 4; i++) A.usageRecord(U1, {}, null, now - 2 * DAY, { build: "B2", perf: 1200 });   // too few
  A.usageRecord(U1, {}, null, now, { build: "zzzz", perf: 30000 });                                     // not served: dropped
  for (let i = 0; i < 3; i++) A.usageRecord(U1, {}, null, now, { build: "B3", perf: 700 });
  let H = A.usageSummary({ r: 7, tabs: TABS, now, build: "B3" }).health;
  assert.equal(H.perf.prev.build, "B1", "B2 has 4 samples: the comparison falls back to B1");
  A.usageRecord(U1, {}, null, now - 2 * DAY, { build: "B2", perf: 1200 });
  H = A.usageSummary({ r: 7, tabs: TABS, now, build: "B3" }).health;
  assert.equal(H.perf.prev.build, "B2", "five now");
  assert.equal(H.perf.prev.n, 5);
  // errors: B3 and B2 only; B1's are not read
  A.usageRecord(U1, {}, null, now, { build: "B1", errs: [{ msg: "old", loc: "/o.js:1", c: 9 }] });
  A.usageRecord(U1, {}, null, now, { build: "B2", errs: [{ msg: "prev", loc: "/p.js:1", c: 2 }] });
  A.usageRecord(U1, {}, null, now, { build: "B3", errs: [{ msg: "cur", loc: "/c.js:1", c: 1 }] });
  H = A.usageSummary({ r: 7, tabs: TABS, now, build: "B3" }).health;
  assert.deepEqual(H.errors.builds, ["B3", "B2"]);
  assert.deepEqual(H.errors.top.map((x) => x.msg), ["prev", "cur"]);
  assert.equal(H.errors.distinct, 2); assert.equal(H.errors.hits, 3);
  // the lite summary (Feature visibility's reach) skips cohorts and error texts
  const L = A.usageSummary({ r: 30, tabs: TABS, now, lite: true });
  assert.equal(L.cohorts, null); assert.equal(L.health.errors.distinct, 0);
  A.close();
});

// ---- 3. the rate gate -------------------------------------------------------------------------------
const P = (ms, extra) => Object.assign({ tabs: { markets: ms }, acts: {}, perf: null, errs: [], build: "B", pwa: false, dev: "desktop" }, extra || {});
test("-110 fu gate: an early beacon is held and merged into the next accepted one, clamped to the session's wall time", () => {
  const g = createUsageGate();
  let t = 1e9;
  assert.equal(g.offer("u", "s1", P(60000), t).accept.tabs.markets, 60000);
  t += 5000;
  const h = g.offer("u", "s1", P(4000, { acts: { csv: 2 }, errs: [{ msg: "m", loc: "/a:1", c: 1 }] }), t);
  assert.deepEqual(h, { held: true }, "the pagehide flush: held, not refused");
  assert.equal(g.held(), 1);
  t += 30000;
  const a = g.offer("u", "s1", P(30000, { acts: { csv: 1 }, errs: [{ msg: "m", loc: "/a:1", c: 2 }] }), t).accept;
  assert.equal(a.tabs.markets, 34000, "merged: 4s held + 30s now (≤ 35s of wall time)");
  assert.deepEqual(a.acts, { csv: 3 }); assert.deepEqual(a.errs, [{ msg: "m", loc: "/a:1", c: 3 }]);
  assert.equal(g.held(), 0);
  // a claim above the wall time is scaled down, held part included
  t += 5000; g.offer("u", "s1", P(50000), t);
  t += 26000;
  assert.equal(g.offer("u", "s1", P(50000), t).accept.tabs.markets, 31000, "31s of wall time, whatever was claimed");
});

test("-110 fu gate: a page that closes right after a beacon — its held minutes land on the next sweep (and all of them at shutdown)", () => {
  const g = createUsageGate();
  let t = 1e9;
  g.offer("u", "s1", P(60000), t);
  t += 10000; assert.ok(g.offer("u", "s1", P(9000), t).held);
  const got = [];
  g.sweep(t + 5000, (uid, p) => got.push([uid, p.tabs.markets]));
  assert.deepEqual(got, [], "still inside the gap: waits");
  g.sweep(t + 25000, (uid, p) => got.push([uid, p.tabs.markets]));
  assert.deepEqual(got, [["u", 9000]], "released after the gap, clamped (9s ≤ 35s)");
  t += 60000; assert.ok(g.offer("u", "s1", P(1000), t).accept);
  t += 1000; assert.ok(g.offer("u", "s1", P(5000), t).held);
  g.sweep(t, (uid, p) => got.push([uid, p.tabs.markets]), true);
  assert.deepEqual(got[1], ["u", 1000], "shutdown: released at once, still ≤ the wall time since the last accepted (1s)");
  assert.equal(g.held(), 0);
});

test("-110 fu gate: two tabs or devices of one member never drop each other's minutes; inventing session ids cannot beat 2× wall time", () => {
  const g = createUsageGate();
  let t = 1e9, total = 0;
  // two devices beaconing every 60s, a minute each: all of it lands
  for (let i = 0; i < 30; i++) {
    for (const s of ["phone00000", "laptop0000"]) { const r = g.offer("u", s, P(60000), t); assert.ok(r.accept, "never held or refused"); total += r.accept.tabs.markets; }
    t += 60000;
  }
  assert.equal(total, 30 * 2 * 60000, "both devices' minutes, whole");
  // an abuser minting a fresh id per request, every second, claiming the 2-minute ceiling each time
  const g2 = createUsageGate();
  let t2 = 2e9, got = 0;
  const start = t2;
  for (let i = 0; i < 600; i++) { const r = g2.offer("x", "fake" + String(i).padStart(8, "0"), P(120000), t2); if (r.accept) got += r.accept.tabs.markets; t2 += 1000; }
  const wall = t2 - start;
  assert.ok(got <= 120000 + 2 * wall, "bounded: " + got + " ≤ 2 min + 2 × " + wall);
  assert.ok(g2.sessions() <= 8, "at most 8 sessions per member are remembered");
  // and a different member is untouched by it
  assert.equal(g2.offer("y", "s1", P(60000), t2).accept.tabs.markets, 60000);
});

test("-110 fu gate: bounded — evicting a session releases its held payload; past maxHeld, a 429; pausing discards held ones", () => {
  const rel = [];
  const g = createUsageGate({ maxSids: 2, maxHeld: 2 });
  let t = 1e9;
  g.offer("u", "a0000000", P(1000), t); g.offer("u", "b0000000", P(1000), t);
  t += 2000; assert.ok(g.offer("u", "a0000000", P(1500), t).held);
  t += 40000; g.offer("u", "c0000000", P(1000), t, (uid, p) => rel.push(p.tabs.markets));
  assert.deepEqual(rel, [1500], "a's held minutes were released when it was evicted");
  assert.ok(g.offer("u", "c0000000", P(1), t + 1).held);
  assert.ok(g.offer("v", "v0000000", P(1), t).accept);
  assert.ok(g.offer("v", "v0000000", P(1), t + 1).held);
  assert.equal(g.held(), 2);
  assert.deepEqual(g.offer("v", "v0000000", P(1), t + 2), { held: true }, "an already-held session merges without counting twice");
  assert.equal(g.sessions(), 3, "u keeps 2 sessions, v one");
  const g2 = createUsageGate({ maxHeld: 1 });
  g2.offer("u", "s", P(1000), t); g2.offer("w", "s", P(1000), t);
  assert.ok(g2.offer("u", "s", P(1), t + 1).held);
  assert.deepEqual(g2.offer("w", "s", P(1), t + 1), { busy: true }, "held payloads are capped server-wide");
  g2.forget("u");
  assert.equal(g2.held(), 0, "paused: what was held is gone");
});

// ---- the HTTP boundary -------------------------------------------------------------------------------
{ const A0 = openAccounts(DATA); A0.usageBuildSeen("2026.09.24-109", Date.now() - 7 * DAY); A0.close(); }
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
const post = (url, body, j) => app.inject({ method: "POST", url, headers: Object.assign({}, JSONH, j ? { cookie: j.header() } : {}), payload: typeof body === "string" ? body : JSON.stringify(body) });
const get = (url, j) => app.inject({ method: "GET", url, headers: Object.assign({}, j ? { cookie: j.header() } : {}) });
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
  return { gus, bob };
}
let PP = null;
const who = async () => (PP = PP || await people());
const VERSION = /const VERSION = "([^"]+)"/.exec(src("server.js"))[1];

test("-110 fu HTTP: an unserved stamp keeps its time and loses perf/errors; quoted text never reaches the store; two sessions both land; a held beacon lands on the sweep", async () => {
  const { gus, bob } = await who();
  const ms = async () => JSON.parse((await get("/api/usage/me", bob)).body).ms;
  // an unserved (but well-formed) stamp: time yes, perf/errors no — and it still reads as stale
  assert.equal((await post("/api/usage", { s: "sessA0000001", tabs: { markets: 30000 }, b: "2099.01.01-999", perf: 800, errs: [{ m: "spoof", f: "/x.js", l: 1 }] }, bob)).statusCode, 204);
  let d = JSON.parse((await get("/api/admin/usage?r=7", gus)).body);
  assert.equal(await ms(), 30000);
  assert.equal(d.health.errors.distinct, 0); assert.equal(d.health.perf.cur, null);
  assert.equal(d.health.stale, 1, "the stale count still sees the tab's stamp");
  // a second page session of the same member, 1s later: accepted, not a 429 and not merged away
  skew += 1000;
  assert.equal((await post("/api/usage", { s: "sessB0000001", tabs: { markets: 20000 }, b: VERSION,
    errs: [{ m: `Unexpected token '<', "<!doctype "... is not valid JSON`, f: "/js/app.js", l: 9 }, { m: "can't find `secret-thing` in 'unclosed", f: "/js/b.js", l: 2 }] }, bob)).statusCode, 204);
  assert.equal(await ms(), 50000, "both sessions' minutes");
  d = JSON.parse((await get("/api/admin/usage?r=7", gus)).body);
  const msgs = d.health.errors.top.map((e) => e.msg).sort();
  assert.deepEqual(msgs, ["Unexpected token '…', \"…\"... is not valid JSON", "can't find `…` in '…"], "quoted text replaced; an unclosed quote hides the rest; can't stays");
  assert.ok(!JSON.stringify(d).includes("secret-thing") && !JSON.stringify(d).includes("doctype"));
  // session A again inside its gap (the pagehide flush): held, answered 204, lands on the sweep
  skew += 2000;
  assert.equal((await post("/api/usage", { s: "sessA0000001", tabs: { trend: 3000 }, b: VERSION }, bob)).statusCode, 204);
  assert.equal(await ms(), 50000, "held for now");
  app.usageSweep(Date.now() + 30000);
  const me = JSON.parse((await get("/api/usage/me", bob)).body);
  assert.equal(me.ms, 53000, "released by the regular flush's sweep");
  assert.ok(me.tabs.some((t) => t.key === "trend" && t.ms === 3000));
});

test("-110 fu HTTP: /api/features' reach is memoized on the flush generation", async () => {
  const { gus } = await who();
  const sv = src("server.js");
  const fn = between(sv, "function usageReach() {", "\n  }");
  assert.ok(fn.includes("usageReachMemo.key === key") && fn.includes("ACCOUNTS.usageGen()") && fn.includes("lite: true"));
  const a = JSON.parse((await get("/api/features", gus)).body).usage;
  const b = JSON.parse((await get("/api/features", gus)).body).usage;
  assert.deepEqual(a, b);
  assert.ok(a && a.r === 30);
});

// ---- 4. the client: quoted text, the disclosure -------------------------------------------------------
function usageModule(env) {
  const body = src("public/js/usage.js").split("\n").filter((l) => !/^import /.test(l) && !/^export \{/.test(l)).join("\n").replace(/^export function /gm, "function ");
  const e = env || {};
  return new Function("el", "esc", "state", "window", "document", "navigator", "fetch", "setInterval", "location", "performance",
    body + "; return { US, usUnquote, usageErr, usageFlush, usageCardHtml, __boot_usage_1 };")(
    e.el || (() => null), esc, e.state || { view: "markets" }, e.window || {}, e.document || {}, e.navigator || {},
    e.fetch || (() => Promise.resolve({ ok: false })), e.setInterval || (() => 0),
    e.location || { href: "https://site.test/", origin: "https://site.test" }, e.performance || { now: () => 950.4 });
}

test("-110 fu client: quoted text is stripped before the beacon; the page session id rides it", () => {
  const sent = [], listeners = {};
  const win = { __ME: { uid: "u1", handle: "bob", usagePaused: false }, addEventListener(t, f) { listeners[t] = f; }, matchMedia: () => ({ matches: false }) };
  const U = usageModule({ window: win, document: { visibilityState: "visible", addEventListener() {} }, state: { view: "markets", bootBuild: "B" },
    navigator: { sendBeacon: (u, b) => { sent.push(JSON.parse(b)); return true; } } });
  assert.equal(U.usUnquote("Cannot read properties of undefined (reading 'c')"), "Cannot read properties of undefined (reading '…')");
  assert.equal(U.usUnquote(`Unexpected token '<', "<!doctype "... is not valid JSON`), `Unexpected token '…', "…"... is not valid JSON`);
  assert.equal(U.usUnquote("don't `x` 'open"), "don't `…` '…");
  // the same rule on the server
  const sv = between(src("server.js"), "function usageUnquote(m) {", "\n  }");
  const uq = new Function(sv + "; return usageUnquote;")();
  for (const m of ["a 'b' c", 'x "y" z `w`', "can't 'q", "none"]) assert.equal(uq(m), U.usUnquote(m));
  const realDateNow = Date.now; let t = 5e6; Date.now = () => t;
  try {
    U.__boot_usage_1();
    listeners.error({ message: "querySelector: '#my-secret-id' is not valid", filename: "https://site.test/js/a.js", lineno: 3, target: win });
    t += 45000; assert.equal(U.usageFlush(false), true);
  } finally { Date.now = realDateNow; }
  assert.equal(sent[0].errs[0].m, "querySelector: '…' is not valid");
  assert.equal(sent[0].s, U.US.sid); assert.match(sent[0].s, /^[0-9a-z]{12}$/);
});

test("-110 fu disclosure: the card lists what the guide lists — ET hour of week, device, build, errors with quoted text removed, 8 weeks", () => {
  const U = usageModule({ window: { __ME: { uid: "u1" } } });
  U.US.mine = { ok: true, keepDays: 30, activeDays: 1, ms: 60000, tabs: [], acts: [] };
  const card = U.usageCardHtml();
  const note = between(src("public/docs.html"), "<b>Your usage.</b>", "</div>");
  for (const w of ["last five minutes", "hour of the week", "Eastern time", "desktop, mobile or tablet, installed or not", "never which ticker",
    "first show the markets table", "which build your tab is running", "quoted text removed", "file:line", "filters or columns", "8 weeks"]) {
    assert.ok(card.includes(w), "card: " + w);
    assert.ok(note.includes(w), "guide: " + w);
  }
  assert.ok(!card.includes("nothing you typed") && !card.includes("six months") && !note.includes("six months"));
  const readme = src("README.md"), mock = src("docs/xyz-monitor-usage-stats-mock.html"), adm = src("public/js/usageadm.js");
  assert.ok(readme.includes("kept **8\n    weeks**") && !readme.includes("26\n    weeks"), "README: 8 weeks");
  assert.ok(mock.includes("kept 8 weeks") && !mock.includes("kept 26 weeks"));
  assert.ok(adm.includes("(C.keepDays||56)/7") && adm.includes("W=(C&&C.weeks)||9"));
});
