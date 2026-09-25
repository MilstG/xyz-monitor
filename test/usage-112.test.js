"use strict";
// ===== build 2026.09.24-112: Usage — sitewide tab paths, control usage and quiet controls, device split per tab ==========
// A. tab paths: tab→tab transitions from showView (repeats ignored, a tab left inside 2s is a bounce and skipped), the
//    page load's entry tab, the top-15 / "where people go from X" / entry aggregation, and the read-only nav suggestion.
// B. control usage: ONE allowlist (US_CONTROLS in public/js/usage.js) that the server parses from the same text; every key
//    validated (prototype keys included), counts clamped per beacon, per gate window and per member per ET day; "never used
//    in range" and the quiet-controls list.
// C. screen time per tab by device class (desktop / mobile / tablet / PWA).
// Everything SITEWIDE ONLY: stored under uid '0' (asserted on the rows), nothing from a paused member, kept 90 days.
const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs"), path = require("path"), os = require("os");

const DATA = fs.mkdtempSync(path.join(os.tmpdir(), "xyz-usage-112-"));
process.env.DATA_DIR = DATA;
delete process.env.SITE_PASSWORD;
process.env.ADMIN_PASSWORD = "break-glass-pw-1";
process.env.XYZ_QUIET = "1";
process.env.XYZ_NO_NET = "1";
delete process.env.TG_BOT_TOKEN; delete process.env.FINNHUB_TOKEN; delete process.env.FRED_KEY;
delete process.env.USAGE_PUBLIC; delete process.env.OPENAI_API_KEY; delete process.env.ANTHROPIC_API_KEY;

const { openAccounts } = require("../src/accounts");
const { createUsageGate } = require("../src/usage-gate");
const { usageControls, usageCtlParse } = require("../src/usage-controls");
const { FEATURES } = require("../src/compute");
const src = (rel) => fs.readFileSync(path.join(__dirname, "..", rel), "utf8");
const between = (s, a, b) => { const i = s.indexOf(a); assert.ok(i >= 0, a); return s.slice(i, s.indexOf(b, i + a.length) + b.length); };
const DAY = 864e5;
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const U = (i) => "uid-m" + String(i).padStart(12, "0");
const SITE_KINDS = "('tr','en','ctl','tdev')";
const TABS = ["markets", "trend", "corr", "sectors"].map((k) => ({ key: k, label: k[0].toUpperCase() + k.slice(1), gate: "public" }));

function withMembers(n) {
  const A = openAccounts(fs.mkdtempSync(path.join(os.tmpdir(), "xyz-usage-112-acc-")));
  for (let i = 0; i < n; i++)
    A._db.prepare("INSERT OR IGNORE INTO user (uid, handle, display, pw, epoch, isAdmin, createdAt, lastSeen) VALUES (?,?,?,?,1,0,?,0)").run(U(i), "m" + i, "m" + i, "x", Date.now() - 200 * DAY);
  A.hydrate();
  return A;
}
// The browser module, declassified and run with a fake clock (the -109 harness, plus the -112 exports).
function usageModule(env) {
  const body = src("public/js/usage.js").split("\n").filter((l) => !/^import /.test(l) && !/^export \{/.test(l)).join("\n").replace(/^export function /gm, "function ");
  const e = env || {};
  return new Function("el", "esc", "state", "window", "document", "navigator", "fetch", "setInterval",
    body + "; return { US, US_CONTROLS, US_CTL_SET, usCtlKeys, usTr, usTrView, usTrSettle, usTrTake, usTrGive, usageCtl, usageSearch, usageFlush, usageView, usagePause, usageCardHtml, __boot_usage_1 };")(
    e.el || (() => null), esc, e.state || { view: "markets" }, e.window || {}, e.document || {}, e.navigator || {}, e.fetch || (() => Promise.resolve({ ok: false })), e.setInterval || (() => 0));
}

// ---- A. transition capture (the browser) ------------------------------------------------------------------------------
test("-112 paths: a move counts once the destination held 2s; repeats and <2s bounces are skipped; the entry tab is the first that held", () => {
  const M = usageModule();
  const t = M.usTr(0, "markets");
  M.usTrView(t, "markets", 500);                       // re-selecting the tab you are on: nothing
  assert.deepEqual(M.usTrTake(t, 1500), { tr: {}, en: null }, "markets has not held 2s yet: not even the entry");
  assert.deepEqual(M.usTrTake(t, 2500), { tr: {}, en: "markets" }, "held 2s: the page load's entry tab");
  M.usTrView(t, "trend", 10000);
  assert.deepEqual(M.usTrTake(t, 11000), { tr: {}, en: null }, "trend on screen 1s: not a move yet");
  assert.deepEqual(M.usTrTake(t, 12000), { tr: { "markets>trend": 1 }, en: null }, "held 2s: markets→trend");
  M.usTrView(t, "corr", 20000); M.usTrView(t, "sectors", 21000);    // corr for 1s: a bounce
  M.usTrView(t, "sectors", 21500);                                   // a repeat inside it changes nothing
  M.usTrView(t, "trend", 30000);
  assert.deepEqual(t.tr, { "trend>sectors": 1 }, "A → B (1s) → C counts A→C");
  M.usTrView(t, "corr", 31000);                                      // trend again for 1s: a bounce back
  M.usTrView(t, "sectors", 31500);                                   // corr 0.5s, then back to sectors: nothing at all
  assert.deepEqual(M.usTrTake(t, 40000), { tr: { "trend>sectors": 1 }, en: null }, "A → B (1s) → A counts nothing; entry is once per load");
  // counts cap per key, and a failed send gives them back
  for (let i = 0; i < 40; i++) { M.usTrView(t, i % 2 ? "sectors" : "trend", 50000 + i * 3000); }
  const x = M.usTrTake(t, 200000);
  assert.equal(x.tr["sectors>trend"], 20); assert.equal(x.tr["trend>sectors"], 20);
  M.usTrGive(t, { tr: { "trend>sectors": 25 }, en: null });
  assert.equal(t.tr["trend>sectors"], 25);
  M.usTrGive(t, { tr: { "trend>sectors": 25 } });
  assert.equal(t.tr["trend>sectors"], 30, "per-key cap (30) holds across a give-back");
});

test("-112 beacon: paths, entry and control counts ride the flush; a failed send keeps them; paused counts nothing and sends nothing", () => {
  const sent = [];
  let ok = true;
  const win = { __ME: { uid: "u1", usagePaused: false }, addEventListener() {}, matchMedia: () => ({ matches: false }) };
  const st = { view: "markets" };
  const M = usageModule({ window: win, state: st, document: { visibilityState: "visible", addEventListener() {} },
    navigator: { sendBeacon: (u, b) => { if (ok) sent.push(JSON.parse(b)); return ok; } }, fetch: () => { throw new Error("no fetch"); } });
  let t = 1000000;
  const realNow = Date.now; Date.now = () => t;
  try {
    M.__boot_usage_1();
    t += 5000; M.usageView("trend"); t += 5000;
    assert.equal(M.usageCtl("markets.window=1d"), true);
    assert.equal(M.usageCtl("markets.window=2d"), false, "not in the allowlist: ignored in the browser too");
    assert.equal(M.usageCtl("__proto__"), false); assert.equal(M.usageCtl("toString"), false);
    assert.equal(M.usageSearch("markets.search", t), true, "a search burst: counted once");
    assert.equal(M.usageSearch("markets.search", t + 3000), false, "still typing: the same burst");
    assert.equal(M.usageSearch("markets.search", t + 9000), false);
    assert.equal(M.usageSearch("markets.search", t + 20000), true, "10s quiet, then typing again: a new burst");
    ok = false; t += 40000;
    assert.equal(M.usageFlush(false), false, "sendBeacon refused (and fetch threw): nothing lost");
    ok = true; t += 1000;
    assert.equal(M.usageFlush(true), true);
    const b = sent[0];
    assert.deepEqual(b.tr, { "markets>trend": 1 }); assert.equal(b.en, "markets");
    assert.deepEqual(b.ctl, { "markets.window=1d": 1, "markets.search": 2 });
    assert.ok(!JSON.stringify(b).includes("hello"), "no text anywhere");
    t += 40000; M.usageView("corr"); t += 5000;
    assert.equal(M.usageFlush(false), true);
    assert.deepEqual(sent[1].tr, { "trend>corr": 1 }); assert.equal(sent[1].en, undefined, "entry once per page load");
    assert.equal(sent[1].ctl, undefined, "sent controls were cleared");
    // paused: the controls and paths are not counted, and nothing goes out
    M.US.paused = true; M.US.tr = null;
    assert.equal(M.usageCtl("markets.window=4h"), false, "paused: not counted");
    M.usageView("sectors"); t += 60000;
    assert.equal(M.usageFlush(true), false);
    assert.equal(sent.length, 2);
  } finally { Date.now = realNow; }
});

// ---- B. the allowlist: one table, parsed by the server from the same text ------------------------------------------------
test("-112 allowlist: the server's key set IS the browser's (same text), the column ids match base.js COLS, the options match the markup", () => {
  const M = usageModule();
  const S = usageControls();
  assert.equal(S.error, null, "parsed");
  assert.deepEqual([...S.keys].sort(), [...M.US_CTL_SET].sort(), "browser and server allow exactly the same keys");
  assert.deepEqual(S.table, JSON.parse(JSON.stringify(M.US_CONTROLS)), "the same table");
  // column ids = every hideable column of the Markets table
  const base = src("public/js/base.js"), blk = base.slice(base.indexOf("const COLS=["), base.indexOf("\n];", base.indexOf("const COLS=[")));
  const cols = [...blk.matchAll(/^ {2}\{key:'([A-Za-z0-9]+)'([^\n]*)/gm)].filter((m) => !/hideable:false/.test(m[2])).map((m) => m[1]);
  assert.ok(cols.length >= 50);
  assert.deepEqual(S.table.markets["col-on"], cols, "col-on = the column picker's ids, in order");
  assert.deepEqual(S.table.markets["col-off"], cols);
  // every group is a manifest tab, or one of the two pseudo-groups
  const tabs = new Set(FEATURES.filter((f) => f.kind === "tab").map((f) => f.key));
  for (const g of Object.keys(S.table)) assert.ok(tabs.has(g) || g === "header" || g === "drawer", "group " + g);
  // the segmented controls' option sets are the buttons the markup actually has
  const html = src("public/index.html");
  const seg = (id, attr) => { const b = between(html, 'id="' + id + '"', "</div>"); return [...b.matchAll(new RegExp("data-" + attr + '="([^"]+)"', "g"))].map((m) => m[1]); };
  assert.deepEqual(S.table.markets.window, seg("tfseg", "tf")); assert.deepEqual(S.table.sectors.window, seg("sectf", "tf"));
  assert.deepEqual(S.table.markets.group, seg("grpseg", "grp")); assert.deepEqual(S.table.markets.weight, seg("grpwtseg", "gwt"));
  assert.deepEqual(S.table.sectors.weight, seg("sectwt", "wt")); assert.deepEqual(S.table.sectors.grouping, seg("sectgrp", "grp"));
  assert.deepEqual(S.table.sectors.view, seg("sectmode", "mode")); assert.deepEqual(S.table.trend.side, seg("trendside", "side"));
  assert.deepEqual(S.table.corr.lookback, seg("corrtf", "d")); assert.deepEqual(S.table.corr.top, seg("corrn", "n"));
  assert.deepEqual(S.table.corr.pairs, seg("corrtop", "k")); assert.deepEqual(S.table.actionable.side, seg("actside", "aside"));
  assert.deepEqual(S.table.header.scope, [...html.matchAll(/data-scope="([a-z]+)"/g)].map((m) => m[1]));
  assert.deepEqual(S.table.drawdown.since, [...src("public/js/drawdown.js").match(/const RVD_PRESETS=\[(.*)\];/)[1].matchAll(/\['([a-z0-9]+)'/g)].map((m) => m[1]));
  assert.deepEqual(S.table.drawer.candles, /\[([\d,]+)\]\.map\(d=>`<button type="button" class="cdtf/.exec(src("public/js/drawer.js"))[1].split(","));
  // every literal key a handler counts is allowlisted; every dynamic one has a prefix that is
  const client = ["nav.js", "trend.js", "actionable.js", "drawdown.js", "corr.js", "share.js", "drawer.js"].map((f) => src("public/js/" + f)).join("\n");
  const lits = [...client.matchAll(/usage(?:Ctl|Search)\('([^']+)'\)/g)].map((m) => m[1]);
  const pres = [...client.matchAll(/usageCtl\('([^']+)'\+/g)].map((m) => m[1]);
  assert.ok(lits.length >= 10 && pres.length >= 12, lits.length + " literal, " + pres.length + " prefixed");
  for (const k of lits) assert.ok(S.keys.has(k), "allowlisted: " + k);
  for (const p of pres) assert.ok([...S.keys].some((k) => k.startsWith(p)), "a real prefix: " + p);
  // broken text fails CLOSED
  assert.equal(usageCtlParse("nothing here").keys.size, 0);
  assert.equal(usageCtlParse('x=/*US_CONTROLS{*/{"a":{"b":["c",]}}/*}US_CONTROLS*/').keys.size, 0, "not JSON: empty");
  assert.equal(usageCtlParse('x=/*US_CONTROLS{*/{"a":{"b":["<x>"]}}/*}US_CONTROLS*/').keys.size, 0, "a value outside the id shape: empty");
  assert.deepEqual([...usageCtlParse('x=/*US_CONTROLS{*/{"a":{"b":[],"c":["1","2"]}}/*}US_CONTROLS*/').keys], ["a.b", "a.c=1", "a.c=2"]);
});

// ---- the store: sitewide only, clamped, pause respected ------------------------------------------------------------------
test("-112 store: paths, entry, controls and device-per-tab land under uid '0' only — never a member's uid; bad keys are dropped", () => {
  const A = withMembers(2);
  const now = Date.now();
  const r = A.usageRecord(U(0), { markets: 60000, trend: 30000 }, "desktop", now, {
    tr: { "markets>trend": 3, "trend>markets": 1, "markets>markets": 5, "markets>nope": 2, "constructor>trend": 1, "markets>trend>corr": 1 },
    en: "markets",
    ctl: { "markets.window=1d": 2, "markets.col-on=rvol": 1, "markets.window=2d": 9, "toString": 1, "markets.search=hello": 1, "trend.side=short": 99 } });
  assert.deepEqual(r.site, { tdev: 90000, tr: 4, ctl: 23, en: 1 }, "99 clamped to 20; the rest dropped");
  A.usageRecord(U(1), { trend: 40000 }, "mobile-pwa", now, { en: "__proto__", tr: { "markets>corr": 2 } });
  A.usageFlush();
  const rows = A._db.prepare(`SELECT uid, kind, key, n, ms FROM usage_day WHERE kind IN ${SITE_KINDS} ORDER BY kind, key`).all().map((x) => Object.assign({}, x));
  assert.deepEqual([...new Set(rows.map((x) => x.uid))], ["0"], "every sitewide row is uid '0'");
  assert.equal(A._db.prepare(`SELECT COUNT(*) AS n FROM usage_day WHERE uid <> '0' AND kind IN ${SITE_KINDS}`).get().n, 0, "no member uid on any of them");
  assert.deepEqual(rows.map((x) => x.kind + " " + x.key + " " + x.n + " " + x.ms), [
    "ctl markets.col-on=rvol 1 0", "ctl markets.window=1d 2 0", "ctl trend.side=short 20 0",
    "en markets 1 0",
    "tdev markets|desktop 1 60000", "tdev trend|desktop 1 30000", "tdev trend|pwa 1 40000",
    "tr markets>corr 2 0", "tr markets>trend 3 0", "tr trend>markets 1 0"]);
  assert.equal(A.usageDevClass("tablet-pwa"), "pwa"); assert.equal(A.usageDevClass("tablet"), "tablet"); assert.equal(A.usageDevClass("x"), "desktop");
  A.close();
});

test("-112 store: a paused member adds nothing sitewide; one member's daily share is capped; the rows keep 30 days (build 2026.09.24-114: was 90)", () => {
  const A = withMembers(2);
  const now = Date.now();
  A.setUsagePaused(U(0), true);
  assert.deepEqual(A.usageRecord(U(0), { markets: 60000 }, "desktop", now, { tr: { "markets>trend": 3 }, en: "markets", ctl: { "markets.window=1d": 2 } }), { ok: true, stored: false });
  A.usageFlush();
  assert.equal(A._db.prepare(`SELECT COUNT(*) AS n FROM usage_day WHERE kind IN ${SITE_KINDS}`).get().n, 0, "paused: nothing, not even the device-per-tab time");
  // the per-member daily cap (in memory; the rows still carry no uid)
  for (let i = 0; i < 80; i++) A.usageRecord(U(1), { markets: 1000 }, "desktop", now, { tr: { "markets>trend": 30 } });
  A.usageFlush();
  assert.equal(A._db.prepare("SELECT n FROM usage_day WHERE kind = 'tr'").get().n, A.USAGE_SITE_PER_DAY, "2,000 per member per ET day");
  // retention: 30 days (build 2026.09.24-114: was 90), and the 30-day per-member fold never touches them
  A.usageRecord(U(1), { markets: 1000 }, "desktop", now - 40 * DAY, { tr: { "trend>markets": 1 } });
  A.usageRecord(U(1), { markets: 1000 }, "desktop", now - 20 * DAY, { tr: { "corr>markets": 1 } });
  A.usageFlush();
  const r = A.usageRetain(now);
  assert.ok(r.site >= 3, "the 40-day-old tr, tdev and sc rows went");
  const keys = A._db.prepare("SELECT key FROM usage_day WHERE kind = 'tr' ORDER BY key").all().map((x) => x.key);
  assert.deepEqual(keys, ["corr>markets", "markets>trend"], "20 days: kept");
  assert.equal(A.USAGE_SITE_KEEP_DAYS, 30);
  A.close();
});

test("-112 gate: paths and controls merge with caps while held, the entry tab passes once per session, transitions never exceed the wall time", () => {
  const G = createUsageGate();
  const t0 = 1e12;
  const a = G.offer("u", "s1", { tabs: { markets: 1000 }, tr: { "markets>trend": 10 }, en: "markets", ctl: { "markets.window=1d": 3 } }, t0).accept;
  assert.deepEqual(Object.assign({}, a.tr), { "markets>trend": 10 }); assert.equal(a.en, "markets");
  // 30s later: the window holds at most 30000 / 2000 + 1 = 16 transitions
  const b = G.offer("u", "s1", { tabs: { trend: 1000 }, tr: { "trend>corr": 30, "corr>trend": 30 }, en: "trend" }, t0 + 30000).accept;
  assert.deepEqual(Object.assign({}, b.tr), { "trend>corr": 16 }, "clamped to what 30s of dwell can hold");
  assert.equal(b.en, null, "the entry tab: once per page session");
  // held beacons add up, capped per key
  assert.ok(G.offer("u", "s1", { tabs: { trend: 500 }, ctl: { "markets.window=1d": 15 } }, t0 + 31000).held);
  assert.ok(G.offer("u", "s1", { tabs: { trend: 500 }, ctl: { "markets.window=1d": 15, "trend.side=long": 2 } }, t0 + 32000).held);
  const c = G.offer("u", "s1", { tabs: { trend: 500 } }, t0 + 61000).accept;
  assert.deepEqual(Object.assign({}, c.ctl), { "markets.window=1d": 20, "trend.side=long": 2 });
  // a controls-only payload is not "empty": it is released by the sweep
  assert.ok(G.offer("u", "s1", { tabs: {}, ctl: { "trend.share": 1 } }, t0 + 62000).held);
  const out = []; G.sweep(t0 + 95000, (uid, p) => out.push(p));
  assert.equal(out.length, 1); assert.deepEqual(Object.assign({}, out[0].ctl), { "trend.share": 1 });
});

// ---- aggregation --------------------------------------------------------------------------------------------------------
test("-112 summary: top transitions, the outbound split, entry tabs, the nav suggestion, controls with quiet ones, device split — the math", () => {
  const A = withMembers(3);
  const now = Date.now(), y = now - DAY;   // (build 2026.09.24-114) complete days only, and ≥ 3 members: yesterday, a third member
  A.usageRecord(U(0), { markets: 60000, trend: 30000 }, "desktop", y, { tr: { "markets>trend": 3, "trend>markets": 1 }, en: "markets",
    ctl: { "markets.window=1d": 2, "markets.col-on=rvol": 1 } });
  A.usageRecord(U(1), { trend: 40000 }, "mobile-pwa", y, { tr: { "markets>trend": 1, "markets>corr": 2 }, en: "trend",
    ctl: { "markets.window=1d": 1, "trend.side=short": 4 } });
  A.usageRecord(U(2), { funding: 1000 }, "desktop", y);   // a third contributor on a tab outside TABS, under a minute: changes none of the numbers below
  const s = A.usageSummary({ r: 7, tabs: TABS, now, navOrder: ["corr", "trend", "sectors"] });
  assert.equal(s.site.withheld, null); assert.equal(s.site.threshold.members, 3);
  const P = s.site.paths;
  assert.equal(P.total, 7);
  assert.deepEqual(P.top.map((e) => [e.from, e.to, e.n]), [["markets", "trend", 4], ["markets", "corr", 2], ["trend", "markets", 1]]);
  assert.equal(P.top[0].share, 4 / 7); assert.equal(P.top[0].fromLabel, "Markets");
  assert.deepEqual(P.from.map((x) => [x.key, x.n, x.to.map((y) => [y.key, y.n, y.share])]), [["markets", 6, [["trend", 4, 4 / 6], ["corr", 2, 2 / 6]]], ["trend", 1, [["markets", 1, 1]]]]);
  assert.deepEqual(P.entry, { total: 2, rows: [{ key: "markets", label: "Markets", n: 1, share: 0.5 }, { key: "trend", label: "Trend", n: 1, share: 0.5 }] });
  // nav: only m0 is active (≥ 1 min), so reach is 1 on markets and trend; trend has more hours; ties keep the current order
  assert.deepEqual(s.site.nav.current.map((x) => x.key), ["corr", "trend", "sectors"]);
  assert.deepEqual(s.site.nav.suggested.map((x) => x.key), ["trend", "corr", "sectors"]);
  assert.equal(s.site.nav.suggested[0].score, 1 * 70000 / 3600e3); assert.equal(s.site.nav.same, false);
  // controls
  const C = s.site.controls, g = (k) => C.groups.find((x) => x.tab === k);
  assert.equal(C.total, 8);
  assert.deepEqual(g("markets").items.slice(0, 2).map((x) => [x.key, x.n]), [["markets.window=1d", 3], ["markets.col-on=rvol", 1]]);
  assert.equal(g("markets").items[2].n, 0, "the never-used controls are listed too, after the used ones");
  assert.deepEqual(g("trend").items.map((x) => [x.key, x.n]), [["trend.side=short", 4], ["trend.share", 0], ["trend.side=long", 0]]);
  assert.equal(g("corr").active, false, "no screen time on Correlation: its controls are not called quiet");
  assert.ok(C.quiet.some((q) => q.key === "trend.side=long") && C.quiet.some((q) => q.key === "markets.window=4h"));
  assert.ok(!C.quiet.some((q) => q.tab === "corr"), "an unused tab's controls are not quiet controls");
  assert.ok(!C.quiet.some((q) => /col-(on|off)/.test(q.control)), "column toggles are summarised, not listed one by one");
  assert.ok(!C.colsNever.ids.includes("rvol") && C.colsNever.ids.includes("beta") && C.colsNever.ids.length === 49);
  // device split per tab
  assert.deepEqual(s.site.devices.rows.map((x) => [x.key, x.ms, x.dev]), [
    ["trend", 70000, { desktop: 30000, mobile: 0, tablet: 0, pwa: 40000 }], ["markets", 60000, { desktop: 60000, mobile: 0, tablet: 0, pwa: 0 }]]);
  assert.equal(A.usageSummary({ r: 7, tabs: TABS, now, lite: true }).site, null, "lite mode (Feature visibility) skips it");
  A.close();
});

// ---- the HTTP boundary --------------------------------------------------------------------------------------------------
const { buildServer } = require("../server.js");
const JSONH = { "content-type": "application/json" }, TEXT = { "content-type": "text/plain;charset=UTF-8" };
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
test.before(async () => { app = await buildServer(); });
test.after(async () => { await app.close(); });
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
const siteRows = () => {
  const { DatabaseSync } = require("node:sqlite");
  const db = new DatabaseSync(path.join(DATA, "accounts.db"), { readOnly: true });
  try { return db.prepare(`SELECT uid, kind, key, n FROM usage_day WHERE kind IN ${SITE_KINDS} ORDER BY kind, key`).all().map((x) => Object.assign({}, x)); } finally { db.close(); }
};

test("-112 HTTP: the beacon's paths and controls are validated against the allowlists (prototype keys too), clamped, stored sitewide; admin-only payload; paused adds nothing", async () => {
  const { gus, bob } = await who();
  // a hostile text/plain beacon (what sendBeacon sends): JSON.parse makes __proto__ an own key — dropped all the same
  const raw = '{"s":"sess112a00001","tabs":{"markets":20000},"en":"__proto__",'
    + '"tr":{"__proto__":5,"constructor>trend":1,"markets>markets":3,"markets>trend":999,"markets>nope":1,"markets>trend>corr":2},'
    + '"ctl":{"__proto__":1,"toString":1,"markets.window=2d":1,"markets.window=1d":999,"markets.search=hello":1,"<img src=x>":1}}';
  assert.equal((await post("/api/usage", raw, bob, TEXT)).statusCode, 204);
  assert.equal((await post("/api/usage", { s: "sess112a00002", tabs: { markets: 1000 }, en: "trend", ctl: "nope", tr: [1, 2] }, bob)).statusCode, 204, "a malformed field is ignored, not an error");
  const d = JSON.parse((await get("/api/admin/usage?r=7", gus)).body);   // flushes
  const rows = siteRows();
  assert.ok(rows.length > 0 && rows.every((r) => r.uid === "0"), "stored under uid '0' only: " + JSON.stringify(rows));
  assert.deepEqual(rows.filter((r) => r.kind !== "tdev").map((r) => r.kind + " " + r.key + " " + r.n), ["ctl markets.window=1d 20", "en trend 1", "tr markets>trend 30"]);
  assert.ok(rows.some((r) => r.kind === "tdev" && r.key === "markets|desktop"));
  // (build 2026.09.24-114) today's rows never reach the sections, and one member is below the k-threshold
  assert.equal(d.site.withheld, "k"); assert.equal(d.site.paths, null); assert.equal(d.site.controls, null); assert.equal(d.site.devices, null);
  assert.ok(d.site.nav.current.length > 5, "the ribbon's movable tabs, from the live menus");
  assert.equal((await get("/api/admin/usage?r=7", bob)).statusCode, 403, "admin-only");
  assert.equal((await get("/api/admin/usage?r=7")).statusCode, 403);
  // paused: nothing from this member, sitewide or not
  assert.equal((await post("/api/usage/pause", { paused: true }, bob)).statusCode, 200);
  const before = JSON.stringify(siteRows());
  assert.equal((await post("/api/usage", { s: "sess112a00003", tabs: { trend: 5000 }, tr: { "trend>markets": 1 }, ctl: { "trend.side=long": 1 } }, bob)).statusCode, 204);
  await get("/api/admin/usage?r=30", gus);
  assert.equal(JSON.stringify(siteRows()), before, "a paused member's beacon contributes nothing");
  await post("/api/usage/pause", { paused: false }, bob);
  // the server reads its allowlist from the browser's file
  const sv = src("server.js");
  assert.ok(sv.includes('const USAGE_CTL = require("./src/usage-controls").usageControls();') && between(sv, "function usageSiteClamp(b) {", "\n  }").includes("USAGE_CTL.keys.has(k)"));
});

// ---- the fold ---------------------------------------------------------------------------------------------------------
test("-112 admin fold: paths, the suggested order, controls with never-used rows and quiet controls, the device bars — every string escaped", () => {
  const body = src("public/js/usageadm.js").split("\n").filter((l) => !/^import /.test(l) && !/^export \{/.test(l)).join("\n");
  const nodes = { admUsageBox: { innerHTML: "", addEventListener() {} }, admUsageSub: { textContent: "" } };
  const F = new Function("el", "esc", "window", "fetch", body + "; return { UA, uaRender, uaSiteHtml };")((id) => nodes[id] || null, esc, { __ME: { handle: "gus" } }, () => new Promise(() => {}));
  const XSS = "<img src=x onerror=alert(1)>";
  const site = { keepDays: 90,
    paths: { total: 7, top: [{ from: "markets", fromLabel: "Markets", to: "trend", toLabel: XSS, n: 4, share: 4 / 7 }, { from: "markets", fromLabel: "Markets", to: "corr", toLabel: "Correlation", n: 2, share: 2 / 7 }],
      from: [{ key: "markets", label: "Markets", n: 6, to: [{ key: "trend", label: XSS, n: 4, share: 4 / 6 }, { key: "corr", label: "Correlation", n: 2, share: 2 / 6 }] },
        { key: "trend", label: XSS, n: 1, to: [{ key: "markets", label: "Markets", n: 1, share: 1 }] }],
      entry: { total: 2, rows: [{ key: "markets", label: "Markets", n: 1, share: 0.5 }, { key: "trend", label: XSS, n: 1, share: 0.5 }] } },
    nav: { current: [{ key: "corr", label: "Correlation" }, { key: "trend", label: XSS }], suggested: [{ key: "trend", label: XSS, score: 1 }, { key: "corr", label: "Correlation", score: 0 }], same: false },
    controls: { total: 8, allowlist: 180, error: null,
      groups: [{ tab: "markets", label: "Markets", active: true, n: 4, gate: "public", colsNever: ["beta"],
        items: [{ key: "markets.window=1d", control: "window", value: "1d", n: 3 }, { key: "markets.col-on=rvol", control: "col-on", value: "rvol", n: 1 },
          { key: "markets.window=4h", control: "window", value: "4h", n: 0 }, { key: "markets.col-off=beta", control: "col-off", value: "beta", n: 0 },
          { key: "markets.col-on=beta", control: "col-on", value: "beta", n: 0 }, { key: "markets.col-off=rvol", control: "col-off", value: "rvol", n: 0 }] },
      { tab: "trend", label: XSS, active: true, n: 4, gate: "public", colsNever: null, items: [{ key: "trend.side=short", control: "side", value: XSS, n: 4 }] }],
      quiet: [{ tab: "markets", label: "Markets", key: "markets.window=4h", control: "window", value: "4h" }, { tab: "trend", label: XSS, key: XSS, control: "side", value: XSS }],
      colsNever: { tab: "markets", label: "Markets", ids: ["beta"] } },
    devices: { classes: ["desktop", "mobile", "tablet", "pwa"], rows: [{ key: "trend", label: XSS, ms: 70000, dev: { desktop: 30000, mobile: 0, tablet: 0, pwa: 40000 } }] } };
  const base = { ok: true, r: 7, keepDays: 30, priorKept: true, publicOn: false,
    kpi: { online: 0, activeToday: 0, activeRange: 1, members: 2, stickiness: null, medMinPerDay: null, newMembers: 0, newActive: 0 },
    series: [{ day: "2026-09-24", n: 1 }], tabs: [], members: [], funnel: [], heat: null, cohorts: null, marks: [], health: null, site };
  F.UA.data = base; F.uaRender();
  let out = nodes.admUsageBox.innerHTML;
  assert.ok(!out.includes("<img src=x"), "labels, control values and keys land escaped");
  for (const pin of ["Tab paths · sitewide", "Top transitions", "top 15 of 7", "→ &lt;img", "57%", "Where people go next", "where people go from",
    'data-uasel="path"', '<option value="markets" selected>Markets</option>', "6 moves", "67%", "Entry tabs", "2 loads",
    "Suggested order", "reach × hours", "<b>suggested</b> <span class=\"us-navk\">1</span>&lt;img", "<b>current</b> <span class=\"us-navk\">1</span>Correlation",
    "Controls · sitewide · 8 uses", 'data-uasel="ctl"', "window = <span class=\"mono\">1d</span>", "col-on = <span class=\"mono\">rvol</span>",
    'class="us-never"', "never used in range", "1 of 2 columns never toggled either way in range: <span class=\"mono\">beta</span>",
    "Quiet controls · 2", "allowlist of 180 control keys", "Never text, never a ticker, never a filter value",
    "Device split per tab · sitewide", 'class="us-devr"', 'class="c0" style="width:42.9%"', 'class="c3" style="width:57.1%"', ">PWA<"])
    assert.ok(out.includes(pin), "fold carries: " + pin);
  assert.ok(!out.includes("col-off = <span class=\"mono\">beta"), "unused column toggles are summarised, not listed");
  // picking another tab re-renders that tab's split and controls
  F.UA.pathTab = "trend"; F.UA.ctlTab = "trend"; F.uaRender(); out = nodes.admUsageBox.innerHTML;
  assert.ok(out.includes('<option value="trend" selected>&lt;img') && out.includes("1 moves") && out.includes("side = <span class=\"mono\">&lt;img"));
  // an unknown pick falls back; a payload without the section renders without it (the -111 shape)
  F.UA.pathTab = "nope"; F.uaRender(); assert.ok(nodes.admUsageBox.innerHTML.includes('<option value="markets" selected>'));
  assert.equal(F.uaSiteHtml({}), "");
  delete base.site; F.uaRender(); assert.ok(!nodes.admUsageBox.innerHTML.includes("Tab paths"));
  // the allowlist failing closed says so
  assert.ok(F.uaSiteHtml({ site: { controls: { error: "bad json <x>", groups: [] } } }).includes("control allowlist unavailable — bad json &lt;x&gt;"));
});

// ---- instrumentation, disclosure, README, mock ------------------------------------------------------------------------------
test("-112 instrumentation: showView feeds the path; the controls count at their own handlers; never the text", () => {
  const nav = src("public/js/nav.js"), us = src("public/js/usage.js");
  assert.ok(us.includes("function usageView(v){ const now=usNow(); if(US.acc) usSetTab(US.acc,v,now); if(US.tr&&!US.paused) usTrView(US.tr,v,now); }"));
  for (const pin of ["usageCtl('markets.col-'+(cb.checked?'on':'off')+'='+k);", "usageCtl('markets.window='+b.dataset.tf); setWindow(b.dataset.tf);",
    "usageCtl('sectors.window='+b.dataset.tf)", "usageCtl('header.scope='+b.dataset.scope); setScope(b.dataset.scope);", "usageCtl('markets.preset=watch')",
    "el('filter').addEventListener('input', e=>{ usageSearch('markets.search'); state.filter=e.target.value;", "usageSearch('header.search'); cmdkRender(q.value);"])
    assert.ok(nav.includes(pin), "nav.js: " + pin);
  assert.ok(src("public/js/share.js").includes('usageCtl((state.detail ? "drawer" : state.view) + ".share");'));
  assert.ok(src("public/js/corr.js").includes("usageCtl(state.view+'.csv');"));
  assert.ok(src("public/js/drawer.js").includes("usageCtl('drawer.candles='+b.dataset.d);"));
  // the search helpers are handed a key, never the input's value
  for (const m of (nav + src("public/js/trend.js")).matchAll(/usageSearch\(([^)]*)\)/g)) assert.match(m[1], /^'[a-z]+\.search'$/, "a key only: " + m[1]);
});

test("-112 disclosure: the card, the member guide and README say sitewide (not linked to you) paths and control counts; the mock marks it built", () => {
  const M = usageModule({ window: { __ME: { uid: "u1" } } });
  M.US.mine = { ok: true, keepDays: 30, activeDays: 1, ms: 60000, tabs: [], acts: [] };
  const card = M.usageCardHtml(), note = between(src("public/docs.html"), "<b>Your usage.</b>", "</div>");
  for (const w of ["not linked to you", "navigation paths", "control-usage counts", "never the text", "Never text, never tickers, never filter values beyond those preset names",
    "screen time per tab by device class", "kept 30 days", "filters or columns"]) {
    assert.ok(card.includes(w), "card: " + w); assert.ok(note.includes(w), "guide: " + w);
  }
  const readme = src("README.md");
  assert.ok(readme.includes("(build 2026.09.24-112)") && readme.includes("kind='tr'") && readme.includes("kind='ctl'") && readme.includes("kind='tdev'") && readme.includes("US_CONTROLS"));
  assert.ok(readme.includes("never text, tickers or filter values beyond the\n    allowlisted preset ids"));
  const mock = src("docs/xyz-monitor-usage-stats-mock.html");
  assert.ok(/Built in build 2026\.09\.24-112<\/em> \(roadmap item 2\)/.test(mock));
  assert.ok(src("server.js").includes('const VERSION = "2026.09.25-116"'));
});
