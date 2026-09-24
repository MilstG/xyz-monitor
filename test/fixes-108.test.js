"use strict";
// ===== build 2026.09.24-108: reviewer- and smoke-confirmed client fixes =============================
// Each block is a repro turned into a regression test: it failed on -107 and passes on -108. The
// server half of the stale-build fix (the 409 on another build's ?v=) lives with the other asset
// tests in test/server.test.js ("modules -108"), which own the HTTP harness.
const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs"), path = require("path");
const C = require("../src/compute");

const DAY = 86400e3;
const src = (rel) => fs.readFileSync(path.join(__dirname, "..", rel), "utf8");
const between = (s, a, b) => { const i = s.indexOf(a); assert.ok(i >= 0, "slice start missing: " + a); const j = s.indexOf(b, i + a.length); assert.ok(j > i, "slice end missing: " + b); return s.slice(i, j); };
const tick = () => new Promise((r) => setImmediate(r));

// ---- 1. background tabs: server triggers reach loadTriggers straight off the SSE frame -------------
test("-108 triggers: a hidden tab with no in-browser rule pulls NO snapshot, but a moved alertVer on the frame pulls the trigger log", () => {
  const nav = src("public/js/nav.js");
  const pull = between(nav, "const BG_PULL_MS=60000;", "// Foregrounding catch-up");
  const fav = between(nav, "function frameAlertVer(d){", "function _cycleMs(){");
  const calls = { snap: 0, trig: 0 };
  const document = { hidden: true };
  const state = { alerts: { rules: [], alertVer: 4 } };
  const api = new Function("document", "state", "loadSnapshot", "loadTriggers", fav + pull + "; return { frameAlertVer, pullSnapshot };")(
    document, state, () => { calls.snap++; }, () => { calls.trig++; });
  assert.equal(api.pullSnapshot(), false, "hidden, no rules: the -103 bandwidth saving stands");
  assert.equal(calls.snap, 0);
  assert.equal(api.frameAlertVer({ dataTs: 9, alertVer: 5, v: "x" }), true, "a moved alertVer pulls triggers");
  assert.equal(calls.trig, 1); assert.equal(state.alerts.alertVer, 5, "and is recorded, so applySnapshot's own check is a no-op for it");
  assert.equal(api.frameAlertVer({ dataTs: 10, alertVer: 5 }), false, "the same version again: nothing");
  assert.equal(api.frameAlertVer({ dm: { seq: 3 } }), false, "a frame without alertVer: nothing");
  assert.equal(calls.trig, 1);
  // the stream handler runs it on every frame, and the reader it calls is the one that raises Notifications
  const onmsg = between(nav, "_sseSrc.onmessage=(ev)=>{", "function frameAlertVer(d){");
  assert.ok(/\n    frameAlertVer\(d\);/.test(onmsg), "onmessage hands every frame to frameAlertVer");
  assert.ok(nav.includes('import { loadPush, loadRules, loadTriggers } from "./triggers.js";'));
  assert.ok(/new Notification\(/.test(between(src("public/js/triggers.js"), "function fireGeneric(ev){", "function pushTrigToast(")), "loadTriggers' fire paths raise the desktop Notification");
});

// ---- 2. stale-build lazy imports: the client half ----------------------------------------------------
function lazyRig(importers, st) {
  const body = between(src("public/js/core.js"), "const LAZY={}, _lazyP={};", "\nexport {");
  const toasts = [];
  const document = { getElementById: () => ({ appendChild: (t) => toasts.push(t) }), createElement: () => ({}) };
  const state = st || {}, location = { reloads: 0, reload() { this.reloads++; } };
  const api = new Function("LAZY_IMPORTERS", "document", "console", "state", "location", body + "; return { lazyMod, lazyCall };")(importers, document, { error() {} }, state, location);
  return { api, toasts, state, location };
}
test("-108 lazy modules: an import failing after a new build is known offers the reload, not a retry", async () => {
  const r = lazyRig({ charts: () => Promise.reject(new TypeError("Failed to fetch dynamically imported module")) });
  await r.api.lazyCall("charts", "openCharts");
  assert.equal(r.toasts.length, 1); assert.match(r.toasts[0].textContent, /check the connection/, "no new build known: the offline wording");
  r.state.newBuild = "2026.09.24-109";
  await r.api.lazyCall("charts", "openCharts");
  assert.match(r.toasts[1].textContent, /new version is live/i, "a new build is live: say so");
  r.toasts[1].onclick();
  assert.equal(r.location.reloads, 1, "and the toast reloads the page");
  assert.ok(src("public/js/alerts.js").includes("function notifyNewBuild(v){\n  state.newBuild=v;"), "notifyNewBuild records the build before its once-per-version toast guard");
});

// ---- 3. foregrounding repaints even when the catch-up pull short-circuits ---------------------------
test("-108 catch-up: a catch-up pull that lands an already-held dataTs still paints the dirty markets table", async () => {
  const body = between(src("public/js/nav.js"), "const BG_PULL_MS=60000;", "function startCycle(");
  const calls = { snap: 0, paint: 0 };
  const document = { hidden: true };
  const state = { view: "markets", alerts: { rules: [{ id: 1 }] } };
  const G = {};
  // The -107 repro: the background alert pull applied dataTs=7 while hidden (paint deferred: mktDirty);
  // the catch-up pull returns the SAME dataTs, applySnapshot returns early and never paints.
  const api = new Function("document", "state", "G", "loadSnapshot", "loadDaily", "paintMarkets", "_cycleMs", "nextCycle",
    body + "; return { pullSnapshot, visibleCatchUp };")(document, state, G, () => { calls.snap++; return Promise.resolve(); }, () => {},
    () => { calls.paint++; G.mktDirty = false; }, () => 15000, 0);
  assert.equal(api.pullSnapshot(), true, "the background alert pull");
  G.mktDirty = true;   // render()'s paint gate, hidden page
  document.hidden = false;
  api.visibleCatchUp();
  assert.equal(calls.snap, 2, "one catch-up pull");
  await tick();
  assert.equal(calls.paint, 1, "the owed paint runs once the pull settles");
  api.visibleCatchUp(); await tick();
  assert.equal(calls.paint, 1, "nothing owed, nothing painted");
  // a pull that DID paint (render cleared mktDirty) is not painted twice; another tab on top is not painted
  state.view = "corr"; G.mktDirty = true; api.visibleCatchUp(); await tick();
  assert.equal(calls.paint, 1, "showView('markets') owns that paint");
});

// ---- 4. live screens re-run under the CARD's timeframe and basket -----------------------------------
function shareHarness() {
  const app = require("./_client").clientSource();
  const els = {};
  const mk = (id) => ({ id, innerHTML: "", hidden: false, value: "", checked: false, textContent: "", style: {}, dataset: {},
    classList: { add() {}, remove() {}, toggle() {}, contains: () => false },
    querySelectorAll: () => [], querySelector: () => null, addEventListener() {}, appendChild() {}, removeChild() {},
    setAttribute() {}, getAttribute: () => null, focus() {}, scrollIntoView() {}, getBoundingClientRect: () => ({ left: 0, top: 0, width: 900, height: 300 }) });
  const saved = { si: global.setInterval, st: global.setTimeout, raf: global.requestAnimationFrame, doc: global.document, win: global.window,
    ls: global.localStorage, f: global.fetch, ct: global.clearTimeout, ci: global.clearInterval };
  global.setInterval = () => 0; global.setTimeout = () => 0; global.requestAnimationFrame = () => 0; global.clearTimeout = () => 0; global.clearInterval = () => 0;
  global.document = { getElementById: (id) => (els[id] = els[id] || mk(id)), querySelectorAll: () => [], querySelector: () => null,
    createElement: mk, addEventListener() {}, body: mk("body"), documentElement: mk("html"), hidden: false };
  global.window = { addEventListener() {}, location: { reload() {}, href: "/", hash: "" }, matchMedia: () => ({ matches: false, addEventListener() {} }), __FLAGS: { baskets: true }, __ADMIN: true };
  global.localStorage = { _d: {}, getItem(k) { return this._d[k] ?? null; }, setItem(k, v) { this._d[k] = String(v); }, removeItem(k) { delete this._d[k]; } };
  global.fetch = () => new Promise(() => {});
  const api = new Function(app + "\n;return {state, BASKETS, screenRun, screenQuery, cardHtml, dmStamp, dmTargetRow, dmDaysLeft};")();
  const restore = () => { global.setInterval = saved.si; global.setTimeout = saved.st; global.requestAnimationFrame = saved.raf; global.clearTimeout = saved.ct; global.clearInterval = saved.ci;
    global.document = saved.doc; global.window = saved.win; global.localStorage = saved.ls; global.fetch = saved.f; };
  return { api, restore };
}
test("-108 live screen: rs / vs tape / avg range / Δ vs ⬒ sort under the card's window and basket, not the viewer's", () => {
  const { api, restore } = shareHarness();
  try {
    const { state } = api;
    // d1 and d7 rank the names in OPPOSITE orders; the viewer is on 1d, the card was shared on 7d.
    const row = (t, d1, d7, dr) => ({ coin: "xyz:" + t, ticker: t, uni: "xyz", d1, d7, vol: 1e9, oi: 1e8, px: 100, delisted: false, feat: { dr } });
    state.rows = new Map([["xyz:SP500", row("SP500", 0, 0, [1])], ["xyz:A", row("A", 3, -6, [1, 1, 1, 1, 1, 9, 9, 9, 9, 9])], ["xyz:B", row("B", 2, -2, [1, 1, 1, 1, 1, 9, 9, 9, 9, 9])],
      ["xyz:C", row("C", 1, 4, [9, 9, 9, 9, 9, 1, 1, 1, 1, 1])], ["xyz:D", row("D", -1, 8, [5])]]);
    state.benchCoin = "xyz:SP500"; state.tf = "1d";
    for (const r of state.rows.values()) { r.rs = r.d1; r.vstape = r.d1; r.adr = 99; r.dvb = undefined; }   // the viewer's derive: 1d, and no Δ⬒ (column hidden)
    const base = { f: "", vmin: null, vmax: null, omin: null, omax: null, grp: ["xyz:A", "xyz:B", "xyz:C", "xyz:D"], gl: "", sd: "desc", sc: "stocks", tf: "7d", bk: "" };
    const order = (q) => api.screenRun(q).map((r) => r.ticker).join("");
    assert.equal(order(Object.assign({}, base, { sk: "rs" })), "DCBA", "vs S&P over the card's 7d, not the viewer's 1d (ABCD)");
    assert.equal(order(Object.assign({}, base, { sk: "vstape" })), "DCBA", "vs tape over 7d, the median taken over the card's scope");
    assert.equal(order(Object.assign({}, base, { sk: "adr", tf: "7d" })), "ABDC", "avg range: the last 5 sessions on 7d (not the viewer's stale 99s)…");
    assert.equal(order(Object.assign({}, base, { sk: "adr", tf: "30d" })), "ABCD", "…and 21 on 30d, where all four average 5 (a tie keeps order)");
    api.BASKETS.list = [{ name: "PAIR", scope: "stocks", members: ["A", "B"] }];
    assert.equal(order(Object.assign({}, base, { sk: "dvb", bk: "PAIR" })), "DCBA", "Δ vs ⬒ computed for the card's basket even though the viewer's column is hidden");
    assert.equal(order(Object.assign({}, base, { sk: "dvb", bk: "PAIR", tf: "1d" })), "ABCD", "and under the card's own window");
    // A -107 card (no tf) keeps the old reading of the row's fields.
    const legacy = Object.assign({}, base, { sk: "rs" }); delete legacy.tf;
    assert.equal(order(legacy), "ABCD");
    // screenQuery carries the window and, for a Δ⬒ sort, the basket
    state.filter = ""; state.filters = {}; state.sortKey = "dvb"; state.sortDir = "desc"; state.scope = "stocks"; state.grpDrill = null; state.tf = "7d"; state.dvbBasket = "PAIR";
    state.watchOnly = false; state.noteOnly = false; state.posOnly = false;
    const q = api.screenQuery();
    assert.ok(q.tf === "7d" && q.bk === "PAIR", JSON.stringify(q));
    // A sort the re-run cannot rebuild renders frozen, even if a card arrives marked live.
    const cap = { v: 1, kind: "screen", view: "markets", scope: "stocks", tf: "7d", cols: [{ k: "d1", l: "24h" }], rows: [{ coin: "xyz:A", t: "A", c: [{ s: "+1.0%", c: "pos" }] }],
      filters: "", sort: "Squeeze desc", total: 1, q: Object.assign({}, base, { sk: "sqz" }), live: true, at: Date.now() };
    assert.ok(!api.cardHtml(cap, { id: 1 }).includes("<b>live</b>"), "no live table for a tf-bound sort it can't rebuild");
    assert.ok(api.cardHtml(Object.assign({}, cap, { q: Object.assign({}, base, { sk: "rs" }) }), { id: 2 }).includes("<b>live</b>"), "rs re-runs live");
  } finally { restore(); }
  // The sheet says why, and the server drops `live` for the same keys (lists kept in step).
  const sh = src("public/js/share.js");
  assert.ok(sh.includes("lv.disabled = !!why; lv.checked = !why && !!cur.live;") && sh.includes("lvl.title = why;"));
  const clientList = JSON.parse(between(sh, "const SCREEN_LIVE_REFUSE = ", ";").slice("const SCREEN_LIVE_REFUSE = ".length));
  assert.deepEqual(clientList, C.SCREEN_LIVE_REFUSE, "client and server refuse the same keys");
  const sc = (q) => C.validateCard({ kind: "screen", cols: [{ k: "d1", l: "24h" }], rows: [{ coin: "xyz:A", t: "A", c: [{ s: "1" }] }], live: true, q });
  assert.equal(sc({ sk: "sqz", tf: "7d" }).card.live, false, "the server stores a tf-bound sort frozen");
  const ok = sc({ sk: "rs", tf: "7d", bk: "MAG7" }).card;
  assert.ok(ok.live === true && ok.q.tf === "7d" && ok.q.bk === "MAG7", JSON.stringify(ok.q));
  assert.equal(sc({ sk: "rs", tf: "2y" }).card.q.tf, null, "an unknown window is dropped");
});

// ---- 5. a throwing boot is not cached as the module's answer -----------------------------------------
test("-108 lazy modules: a boot that throws once is retried by the next click (the rejection is not cached)", async () => {
  let boots = 0, imports = 0;
  const ns = { __boot_x_1: () => { if (boots++ === 0) throw new Error("boot blew up"); }, openX: () => "x" };
  const r = lazyRig({ x: () => { imports++; return Promise.resolve(ns); } });
  await assert.rejects(r.api.lazyMod("x"), /boot blew up/);
  assert.equal(await r.api.lazyCall("x", "openX"), "x", "the second click loads and boots again");
  assert.equal(imports, 2); assert.equal(boots, 2);
  assert.equal(await r.api.lazyCall("x", "openX"), "x"); assert.equal(imports, 2, "and once loaded it stays loaded");
});

// ---- 6. no /api/notes for a viewer the notes gate leaves out -----------------------------------------
test("-108 notes: no fetch without the notes feature, and a 403 stops the retries for the page's life", async () => {
  const notes = src("public/js/notes.js");
  const body = between(notes, "let _notesDenied=false;", "function notesFor(coin){");
  const mk = (flags, answer) => {
    const calls = { n: 0 };
    const state = { notes: null, rows: new Map([["xyz:A", { coin: "xyz:A", nt: { n: 1 } }]]) };
    const api = new Function("featureOn", "fetchJSON", "state", "notesFor", "let _notesLoading=null, _notesLast=0;\n" + body + "; return { loadNotes, notesStale };")(
      (k) => !!flags[k], async () => { calls.n++; return answer(); }, state, () => []);
    return { api, calls, state };
  };
  const anon = mk({}, () => { throw new Error("HTTP 403"); });
  assert.equal(anon.api.notesStale(), false, "the gate is off: nothing is stale, render() never asks");
  await anon.api.loadNotes(); await anon.api.loadNotes(true);
  assert.equal(anon.calls.n, 0, "and a drawer open fetches nothing");
  // FLAGS absent (featureOn's all-on fallback) or a gate that changed under the page: one 403, then quiet.
  const m = mk({ notes: true }, () => { throw new Error("HTTP 403"); });
  assert.equal(m.api.notesStale(), true);
  await m.api.loadNotes();
  assert.equal(m.calls.n, 1);
  for (let i = 0; i < 5; i++) { assert.equal(m.api.notesStale(), false, "the 403 is remembered"); await m.api.loadNotes(); }
  assert.equal(m.calls.n, 1, "no 403 per snapshot");
  // an ordinary failure (offline) still retries
  const o = mk({ notes: true }, () => { throw new Error("HTTP 502"); });
  await o.api.loadNotes(); await o.api.loadNotes();
  assert.equal(o.calls.n, 2);
  const ok = mk({ notes: true }, () => ({ notes: [{ coin: "xyz:A" }], rev: 1 }));
  await ok.api.loadNotes(); assert.equal(ok.calls.n, 1); assert.equal(ok.state.notes.length, 1, "an admin's book still loads");
});

// ---- 7. side words between the ticker and the target / horizon ---------------------------------------
test("-108 call parser: a side word before the target or around the horizon decides the side without cancelling them", () => {
  const now = Date.UTC(2026, 8, 24, 15, 0, 0);
  const R = (t) => C.callRead(t, "NVDA", now), T = (t, mk) => C.callTarget(t, "NVDA", mk == null ? 200 : mk, now);
  // the two repros
  const a = T("$NVDA short to 150 in 2w");
  assert.ok(a.ok && a.side === "short" && a.px === 150 && a.horizonMs === 14 * DAY && a.word === "to 150 in 2w", JSON.stringify(a));
  const b = R("$NVDA 2w short");
  assert.ok(b.side === "short" && b.sideWord === "short" && b.horizonMs === 14 * DAY, JSON.stringify(b));
  // the rest of the grammar
  assert.deepEqual(R("$NVDA short in 2w"), { side: "short", sideWord: "short", horizonMs: 14 * DAY, horizonWord: "in 2w" });
  assert.deepEqual(R("$NVDA in 10d"), { side: "long", sideWord: null, horizonMs: 10 * DAY, horizonWord: "in 10d" }, "in 10d is a horizon");
  assert.deepEqual(R("$NVDA long 3 weeks"), { side: "long", sideWord: "long", horizonMs: 21 * DAY, horizonWord: "3 weeks" });
  assert.equal(R("$NVDA sell 2mo").side, "short"); assert.equal(R("$NVDA buy 30d").sideWord, "buy");
  assert.equal(R("$NVDA 30d long").sideWord, "long");
  assert.ok(T("$NVDA buy to 250 by Oct 15").ok && T("$NVDA buy to 250 by Oct 15").side === "long");
  assert.ok(T("$NVDA selling 150 in 3w").ok, "a bare number behind a side word, with a deadline");
  // options are still options: selling puts is long, buying puts is short, a strike is not a target
  assert.equal(R("$NVDA sell 100 puts").side, "long"); assert.equal(R("$NVDA sell 100 puts").sideWord, "sell … puts");
  assert.equal(R("$NVDA buy 100 puts").side, "short");
  assert.equal(T("$NVDA sell 100 puts by Oct 15"), null);
  // a word the target contradicts: refused, and the reason names the word
  const c = T("$NVDA short to 250 in 2w");
  assert.ok(!c.ok && /short to 250 is behind the mark \(200\)/.test(c.error) && /“short” makes it a short, so the target has to sit below the mark/.test(c.error), c.error);
  assert.match(T("$NVDA long to 150 in 2w").error, /“long” makes it a long, so the target has to sit above the mark/);
  assert.match(C.callTarget("$NVDA to 250 in 2w", "NVDA", 200, now, "short").error, /the applied reading says short/);
  // existing grammar unchanged
  assert.deepEqual(R("$NVDA 30d"), { side: "long", sideWord: null, horizonMs: 30 * DAY, horizonWord: "30d" });
  assert.equal(R("$NVDA ran 3d in a row").horizonMs, null);
  assert.equal(R("lower risk $NVDA here").side, "long");
  // the client twins read every one of these the same way
  const app = src("public/js/messages.js");
  const cut = app.slice(app.indexOf("const CALL_SHORT_BEFORE="), app.indexOf("// The composer's preview:"));
  const [cRead, cTarget] = new Function(cut + "\nreturn [dmCallRead, dmCallTarget];")();
  for (const t of ["$NVDA short to 150 in 2w", "$NVDA 2w short", "$NVDA short in 2w", "$NVDA in 10d", "$NVDA long 3 weeks", "$NVDA sell 2mo", "$NVDA buy 30d", "$NVDA 30d long",
    "$NVDA buy to 250 by Oct 15", "$NVDA selling 150 in 3w", "$NVDA sell 100 puts", "$NVDA buy 100 puts", "$NVDA sell 100 puts by Oct 15", "$NVDA short to 250 in 2w",
    "$NVDA long to 150 in 2w", "$NVDA to 250 in 2w", "$NVDA 2 weeks lower", "short $NVDA long 2w", "$NVDA, short: to 150 by 10/31 unless 230"]) {
    assert.deepEqual(cRead(t, "NVDA", now), C.callRead(t, "NVDA", now), "read parity: " + t);
    for (const side of [null, "long", "short"]) for (const sr of [undefined, true, false])
      assert.deepEqual(cTarget(t, "NVDA", 200, now, side, sr), C.callTarget(t, "NVDA", 200, now, side, sr), "target parity: " + t + " / " + side + " / " + sr);
  }
});

// ---- 8. one day count for one deadline ---------------------------------------------------------------
test("-108 call days: the preview, the stamp's close and the target row count the same deadline the same way", () => {
  const { api, restore } = shareHarness();
  try {
    const now = Date.now(), by = now + 21.4 * DAY;   // "$INTC to 32 by Oct 15" sent ~21.4 days out: round said 21, ceil says 22
    assert.equal(api.dmDaysLeft(by), 22);
    assert.equal(api.dmDaysLeft(now - DAY), 0, "a passed deadline is 0, never negative");
    const m = { ref: "xyz:INTC", refPx: 28, px: 29, side: "long", ts: now, call: { h: 21, closed: false, closeTs: by, tg: { px: 32, stop: null, by, res: null, at: null } } };
    const html = api.dmStamp(m);
    assert.ok(/closes [^(]*\(22d\)/.test(html), "the stamp: " + html.slice(0, 400));
    assert.ok(html.includes("22d left"), "the target row");
  } finally { restore(); }
  const app = src("public/js/messages.js");
  assert.ok(app.includes("days=tgOk?Math.max(1,(tgOk.by||0)>0?dmDaysLeft(tgOk.by):Math.ceil(tgOk.horizonMs/86400e3))"), "the composer preview counts with the same helper");
  assert.ok(app.includes("'open \\u00b7 '+dmDaysLeft(c.closeTs)+'d')"), "the calls list too");
});
