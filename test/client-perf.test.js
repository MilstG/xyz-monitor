"use strict";
// ===== build 2026.09.24-103: performance (client) ==============================================
// Behaviour pins for the client pass: hidden tabs stop pulling and catch up once on foregrounding,
// the markets DOM paints only while Markets is on screen, the correlation engine is memoized and
// typed-array dense with numbers IDENTICAL to the Map-based builder it replaced, unchanged daily
// bodies are not re-applied, tab-only modules load lazily through one loader, the matrix hover
// rebuilds its tooltip only when the hovered cell changes, and the service worker caches exactly
// this build's stamped static assets and nothing else. Each test executes the SHIPPED function
// (sliced out of its module) against stubs, never a reimplementation.
const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs"), path = require("path"), vm = require("vm");
const ROOT = path.join(__dirname, "..");
const src = (f) => fs.readFileSync(path.join(ROOT, f), "utf8");
const between = (s, a, b) => { const i = s.indexOf(a); assert.ok(i >= 0, "slice start missing: " + a); const j = s.indexOf(b, i + a.length); assert.ok(j > i, "slice end missing: " + b); return s.slice(i, j); };
const DAY = 86400e3;

// ---- 1. hidden tabs idle ----------------------------------------------------------------------
function navRig(opts) {
  const o = opts || {};
  const body = between(src("public/js/nav.js"), "const BG_PULL_MS=60000;", "function startCycle(");
  const calls = { snap: 0, daily: 0, paint: 0 };
  const document = { hidden: !!o.hidden };
  const state = { view: o.view || "markets", alerts: { rules: o.rules || [] } };
  const G = {};
  const api = new Function("document", "state", "G", "loadSnapshot", "loadDaily", "paintMarkets", "_cycleMs", "nextCycle",
    body + "; return { pullSnapshot, visibleCatchUp, markDaily: ()=>{ _dailyDirty=true; } };")(
    document, state, G, () => { calls.snap++; }, () => { calls.daily++; }, () => { calls.paint++; }, () => 15000, 0);
  return { api, calls, document, state, G };
}

test("perf -103 hidden tab: pokes and polls do not fetch while hidden; ONE pull catches up on visible", () => {
  const r = navRig({ hidden: true });
  for (let i = 0; i < 5; i++) assert.equal(r.api.pullSnapshot(), false, "hidden: no fetch");
  assert.equal(r.calls.snap, 0, "nothing pulled in the background");
  r.document.hidden = false;
  r.api.visibleCatchUp();
  assert.equal(r.calls.snap, 1, "exactly one catch-up pull, however many pokes were skipped");
  r.api.visibleCatchUp();
  assert.equal(r.calls.snap, 1, "the dirty flag is consumed");
  assert.equal(r.api.pullSnapshot(), true); assert.equal(r.calls.snap, 2, "visible: pull exactly as before");
  // a catch-up with nothing skipped pulls nothing
  const q = navRig({ hidden: false }); q.api.visibleCatchUp(); assert.equal(q.calls.snap, 0);
});

test("perf -103 hidden tab: in-browser alert rules keep a slow (60s) background pull; the daily timer defers too", () => {
  const r = navRig({ hidden: true, rules: [{ id: 1 }] });
  const realNow = Date.now; let now = 1e12; Date.now = () => now;
  try {
    assert.equal(r.api.pullSnapshot(), true, "a rule present: the first hidden poke pulls (alerts still evaluate)");
    now += 20e3; assert.equal(r.api.pullSnapshot(), false, "but at most once per BG_PULL_MS");
    now += 41e3; assert.equal(r.api.pullSnapshot(), true, "and again once the minute has passed");
    assert.equal(r.calls.snap, 2);
  } finally { Date.now = realNow; }
  r.api.markDaily(); r.document.hidden = false; r.api.visibleCatchUp();
  assert.equal(r.calls.daily, 1, "a daily pull skipped while hidden runs once on foregrounding");
  const nav = src("public/js/nav.js");
  assert.ok(nav.includes("dailyTimer=setTimeout(async()=>{ if(document.hidden) _dailyDirty=true; else await loadDaily(); scheduleDaily(); }"), "the daily timer marks instead of pulling while hidden");
  assert.ok(nav.includes("cycleTimer=setInterval(()=>{ pullSnapshot(); nextCycle=Date.now()+_cycleMs(); }, ms)"), "the poll goes through pullSnapshot");
  assert.ok(/\n  visibleCatchUp\(\); \}\);   \/\/ \(build 2026\.09\.24-103\)/.test(nav), "foregrounding runs the catch-up");
});

test("perf -103 hidden tab: a background alert pull leaves markets dirty; foregrounding paints it once", () => {
  const r = navRig({ hidden: false });
  r.G.mktDirty = true; r.api.visibleCatchUp();
  assert.equal(r.calls.paint, 1, "deferred paint runs on visible");
  const s = navRig({ hidden: false, view: "corr" });
  s.G.mktDirty = true; s.api.visibleCatchUp();
  assert.equal(s.calls.paint, 0, "not while another tab is on top — showView('markets') owns that paint");
});

// ---- 2. markets paint deferred when not in view ------------------------------------------------
function renderRig(view, hidden) {
  const body = between(src("public/js/markets.js"), "function mktPaintable(){", "function updateMovers(");
  const calls = { derive: 0, alerts: 0, group: 0, movers: 0, strip: 0, el: 0 };
  const state = { view, rows: new Map([["A", {}]]), dataTs: 1 };
  const G = { _notesSeenSnap: 1 };
  const api = new Function("document", "state", "G", "computeDerived", "evaluateAlerts", "posDecorate", "notesStale", "_notesLoading", "loadNotes",
    "el", "mktGrp", "renderGroupBoard", "updateMovers", "renderRegimeStrip",
    body + "; return { render, paintMarkets, mktPaintable };")(
    { hidden: !!hidden }, state, G, () => calls.derive++, () => calls.alerts++, () => {}, () => false, false, null,
    () => { calls.el++; return null; }, () => "sectors", () => calls.group++, () => calls.movers++, () => calls.strip++);
  return { api, calls, state, G };
}

test("perf -103 markets: render() derives and evaluates alerts on every call but paints only while Markets is on screen", () => {
  const r = renderRig("corr", false);
  r.api.render();
  assert.equal(r.calls.derive, 1); assert.equal(r.calls.alerts, 1, "alerts evaluate on every applied snapshot");
  assert.equal(r.calls.group + r.calls.el, 0, "no markets DOM touched while another tab is on top");
  assert.equal(r.G.mktDirty, true, "the paint is owed");
  const h = renderRig("markets", true); h.api.render();
  assert.equal(h.calls.alerts, 1); assert.equal(h.calls.group, 0, "a hidden page does not paint either"); assert.equal(h.G.mktDirty, true);
  // showView('markets') path: paintMarkets paints table + movers + strip and clears the debt
  r.state.view = "markets"; r.api.paintMarkets();
  assert.equal(r.calls.group, 1); assert.equal(r.calls.movers, 1); assert.equal(r.calls.strip, 1);
  assert.equal(r.G.mktDirty, false);
  const data = src("public/js/data.js"), bt = src("public/js/backtest.js"), mk = src("public/js/markets.js");
  assert.ok(data.includes("updateAggregates(); render(); if(mktPaintable()){ updateMovers(); renderRegimeStrip(); } updateSyncProgress();"), "applySnapshot gates movers + strip");
  assert.ok(bt.includes("if(v==='markets'&&G.mktDirty) paintMarkets();"), "showView('markets') pays the deferred paint");
  assert.ok(mk.includes("requestAnimationFrame(()=>{renderQueued=false; render(); if(mktPaintable()) updateMovers();});"), "the frame-coalesced render gates movers too");
});

// ---- 3. correlation: memoized dense engine == the old Map engine ------------------------------
// The builder this pass replaced, verbatim from build 2026.09.24-102 (public/js/corr.js).
const OLD_CORR = `
function buildCorrOld(rows, Ldays){
  const cutoff=Math.floor(Date.now()/DAY)-Ldays, minOv=Math.max(10, Math.floor(Math.min(Ldays,90)*0.4));   // (-105) session returns + the 10-return floor, same inputs as the dense engine
  const series=rows.map(r=>{ const m=sessReturns(r); if(!m) return null; const f=new Map(); for(const [d,v] of m) if(d>=cutoff) f.set(d,v); return f; });
  const N=rows.length, C=Array.from({length:N},()=>new Array(N).fill(null)), OV=Array.from({length:N},()=>new Array(N).fill(0));
  for(let i=0;i<N;i++){ C[i][i]=1; const si=series[i]; if(!si) continue;
    for(let j=i+1;j<N;j++){ const sj=series[j]; if(!sj) continue;
      const small=si.size<sj.size?si:sj, other=small===si?sj:si, a=[],b=[];
      for(const [d,v] of small){ const w=other.get(d); if(w!==undefined){ a.push(v); b.push(w); } }
      const c=a.length>=minOv?pearson(a,b):null; C[i][j]=c; C[j][i]=c; OV[i][j]=a.length; OV[j][i]=a.length; } }
  return {C, N:OV};
}
function clusterOrderOld(D){ const n=D.length; if(n<=2) return D.map((_,i)=>i);
  const key=(a,b)=>a<b?a+','+b:b+','+a, dmap=new Map();
  for(let i=0;i<n;i++) for(let j=i+1;j<n;j++) dmap.set(key(i,j), D[i][j]);
  let clusters=[]; for(let i=0;i<n;i++) clusters.push({id:i,size:1,order:[i]}); let nid=n;
  while(clusters.length>1){ let bi=0,bj=1,bd=Infinity;
    for(let i=0;i<clusters.length;i++) for(let j=i+1;j<clusters.length;j++){ const d=dmap.get(key(clusters[i].id,clusters[j].id)); if(d<bd){bd=d;bi=i;bj=j;} }
    const A=clusters[bi], B=clusters[bj], id=nid++;
    for(const C of clusters){ if(C===A||C===B) continue; const dA=dmap.get(key(A.id,C.id)), dB=dmap.get(key(B.id,C.id));
      dmap.set(key(id,C.id), (A.size*dA+B.size*dB)/(A.size+B.size)); }
    clusters=clusters.filter(c=>c!==A&&c!==B); clusters.push({id, size:A.size+B.size, order:A.order.concat(B.order)}); }
  return clusters[0].order; }`;
function corrApi() {
  // (-105) the engine reads session returns: core.js's session view + a stub state (no calendar
  // shipped -> calendar days, the fixture's rows carry no uni)
  const core = "const state={sessOff:null,sessOffV:0};\n" + between(src("public/js/core.js"), "function sessionFold(", "// Yang-Zhang");
  const body = between(src("public/js/corr.js"), "function dailyReturns(", "function corrColor(");
  return new Function("DAY", core + body + OLD_CORR + "; return { buildCorr, buildCorrOld, clusterOrder, clusterOrderOld, corrOrder, dailyReturns };")(DAY);
}
function corrRows(N, days, seed0) {
  let seed = seed0 || 7; const rnd = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648; };
  const now = Date.now(), out = [];
  for (let i = 0; i < N; i++) {
    const d = []; let p = 50 + rnd() * 100; const start = Math.floor(rnd() * days * 0.6), gap = rnd() < 0.3 ? 0.25 : 0.04;
    for (let k = days; k >= 0; k--) {
      if (k > days - start || rnd() < gap) continue;
      p *= Math.exp((rnd() - 0.5) * 0.05 + (i % 3 === 0 ? 0.002 : 0));
      d.push({ t: now - k * DAY, c: p });
    }
    out.push({ coin: "C" + i, ticker: "T" + i, daily: i === 5 ? null : (i === 6 ? d.slice(0, 1) : d) });   // a row with no history, one with a single bar
  }
  return out;
}

test("perf -103 corr: the dense typed-array builder is numerically identical to the Map builder (1e-12), clustering identical", () => {
  const A = corrApi();
  for (const [N, days, seed] of [[40, 400, 3], [25, 120, 11], [12, 40, 19], [3, 30, 23]]) {
    for (const L of [7, 30, 90, 365]) {
      const rows = corrRows(N, days, seed);
      const o = A.buildCorrOld(rows, L), n = A.buildCorr(rows, L);
      let cells = 0, filled = 0;
      for (let i = 0; i < N; i++) for (let j = 0; j < N; j++) {
        const a = o.C[i][j], b = n.C[i][j]; cells++;
        if (a == null || b == null) assert.equal(a, b, `null-ness differs at ${i},${j} (N=${N} L=${L})`);
        else { filled++; assert.ok(Math.abs(a - b) <= 1e-12, `r differs at ${i},${j}: ${a} vs ${b}`); }
        assert.equal(o.N[i][j], n.N[i][j], `overlap differs at ${i},${j}`);
      }
      if (N >= 12 && L >= 30 && L * 2 <= days) assert.ok(filled > cells / 3, `the fixture exercises real correlations, not just nulls (N=${N} L=${L}: ${filled}/${cells})`);
      const D = o.C.map((row) => row.map((v) => v == null ? 1 : 1 - v));
      assert.deepEqual(A.clusterOrder(D), A.clusterOrderOld(D), `cluster order (N=${N} L=${L})`);
      assert.deepEqual(A.corrOrder(n.C), A.clusterOrderOld(D), "corrOrder is the same transform + order");
    }
  }
});

test("perf -103 corr: memoized on (lookback, day, rows, daily identity); a replaced daily array rebuilds", () => {
  const A = corrApi();
  const rows = corrRows(20, 200, 5);
  const a = A.buildCorr(rows, 30), b = A.buildCorr(rows, 30);
  assert.strictEqual(a, b, "same inputs: the cached result object");
  assert.notStrictEqual(A.buildCorr(rows, 90), a, "another lookback is another entry");
  assert.strictEqual(A.buildCorr(rows.slice(), 30), a, "a new array of the same rows still hits");
  assert.notStrictEqual(A.buildCorr(rows.slice(0, 19), 30), a, "a different row set misses");
  const r = rows[3]; r.daily = r.daily.slice(0, -5); r._dret = null;   // what applyDaily does on a new version
  const c = A.buildCorr(rows, 30);
  assert.notStrictEqual(c, a, "new closes, new matrix");
  assert.deepEqual(c.C, A.buildCorrOld(rows, 30).C.map((row) => row.map((v) => v)), "and it is the right one");
  assert.strictEqual(A.corrOrder(c.C), A.corrOrder(c.C), "the cluster order is memoized per matrix");
  const sect = src("public/js/sectors.js"), mk = src("public/js/markets.js");
  assert.ok(sect.includes("const {C}=buildCorr(withDaily,scL);") && mk.includes("const {C}=buildCorr(withDaily,90);"), "sectors and the markets lens ride the same memo");
});

// ---- 4. applyDaily skips unchanged bodies ------------------------------------------------------
function dailyRig() {
  const body = between(src("public/js/data.js"), "function applyDaily(d){", "function updateAggregates(");
  const calls = { sched: 0, corr: 0, sect: 0, dd: 0 };
  const state = { rows: new Map(), _ohSnap: true };
  const views = { "view-corr": { hidden: false }, "view-sectors": { hidden: false }, "view-drawdown": { hidden: false }, compg: { hidden: true } };
  let ddMod = null;
  const api = new Function("state", "DAY", "scheduleRender", "el", "openCorr", "COMPG", "renderCompg", "renderSectors", "lazyLoaded",
    body + "; return { applyDaily };")(
    state, DAY, () => calls.sched++, (id) => views[id] || null, () => calls.corr++, {}, () => {}, () => calls.sect++, () => ddMod);
  return { api, calls, state, setDd: (m) => { ddMod = m; } };
}

test("perf -103 daily: an unchanged daily version is not re-applied (no memo invalidation, no corr/sector repaint)", () => {
  const r = dailyRig();
  r.state.rows.set("A", { coin: "A" }); r.state.rows.set("B", { coin: "B" });
  const body = (ts) => ({ dataTs: ts, daily: { A: [[1, 10], [2, 11]], B: [[1, 20], [2, 19]] } });
  r.api.applyDaily(body(100));
  const first = r.state.rows.get("A").daily;
  assert.equal(r.calls.sched, 1); assert.equal(r.calls.corr, 1); assert.equal(r.calls.sect, 1);
  r.state.rows.get("A")._dret = "memo";
  r.api.applyDaily(body(100));   // a 304 comes back from fetch() as the cached 200 body
  assert.strictEqual(r.state.rows.get("A").daily, first, "series untouched");
  assert.equal(r.state.rows.get("A")._dret, "memo", "per-row memos survive");
  assert.equal(r.calls.sched + r.calls.corr + r.calls.sect, 3, "no repaint for identical data");
  r.api.applyDaily(body(101));
  assert.notStrictEqual(r.state.rows.get("A").daily, first, "a new version applies");
  assert.equal(r.calls.corr, 2);
  // boot race: daily before the snapshot created a row — the same version applies again once it exists
  r.state.rows.set("C", { coin: "C" });
  r.api.applyDaily({ dataTs: 101, daily: { A: [[1, 10]], B: [[1, 20]], C: [[1, 5], [2, 6]] } });
  assert.ok(r.state.rows.get("C").daily, "a row that appeared since is filled");
  // unversioned bodies always apply; drawdown only repaints when its module is loaded
  const before = r.calls.sched; r.api.applyDaily({ daily: { A: [[1, 1]] } }); r.api.applyDaily({ daily: { A: [[1, 1]] } });
  assert.equal(r.calls.sched, before + 2);
  let dd = 0; r.setDd({ renderDrawdown: () => dd++ }); r.api.applyDaily({ daily: {} });
  assert.equal(dd, 1, "a loaded drawdown study repaints with the closes");
});

// ---- 5. lazy tab modules -----------------------------------------------------------------------
function lazyRig(importers) {
  const body = between(src("public/js/core.js"), "const LAZY={}, _lazyP={};", "\nexport {");
  const toasts = [];
  const document = { getElementById: () => ({ appendChild: (t) => toasts.push(t) }), createElement: () => ({}) };
  const state = {}, location = { reloads: 0, reload() { this.reloads++; } };
  const api = new Function("LAZY_IMPORTERS", "document", "console", "state", "location", body + "; return { lazyMod, lazyCall, lazyLoaded };")(importers, document, { error() {} }, state, location);
  return { api, toasts, state, location };
}

test("perf -103 lazy modules: one import per module, boots run once before the first call, failures retry", async () => {
  const log = []; let imports = 0, fail = 1;
  const ns = { __boot_x_20: () => log.push("boot20"), __boot_x_100: () => log.push("boot100"), openX: (a) => { log.push("open:" + a); return a * 2; } };
  const r = lazyRig({ x: () => { imports++; return Promise.resolve(ns); },
    y: () => fail-- > 0 ? Promise.reject(new Error("offline")) : Promise.resolve({ openY: () => "y" }) });
  assert.equal(r.api.lazyLoaded("x"), null, "nothing loaded up front");
  const [a, b] = await Promise.all([r.api.lazyCall("x", "openX", 1), r.api.lazyCall("x", "openX", 2)]);
  assert.deepEqual([a, b], [2, 4]);
  assert.equal(imports, 1, "concurrent first uses share one import");
  assert.deepEqual(log, ["boot100", "boot20", "open:1", "open:2"], "boots (name order) before any call, calls in order");
  await r.api.lazyCall("x", "openX", 3);
  assert.equal(imports, 1); assert.equal(log.filter((x) => x.startsWith("boot")).length, 2, "boots run once");
  assert.strictEqual(r.api.lazyLoaded("x"), ns);
  assert.equal(await r.api.lazyCall("y", "openY"), undefined, "a failed load resolves (no unhandled rejection) and says so");
  assert.equal(r.toasts.length, 1);
  assert.equal(await r.api.lazyCall("y", "openY"), "y", "the next use retries the import");
  await assert.rejects(r.api.lazyMod("nope"), /unknown lazy module/);
});

test("perf -103 lazy modules: no eager module statically imports a lazy one; the entry and harness agree", () => {
  const lazy = require("./_client").lazyModules();
  assert.deepEqual(lazy, ["charts", "drawdown", "funds", "insiders", "positioning"]);
  const app = src("public/app.js");
  for (const m of lazy) assert.ok(!app.includes(`"./js/${m}.js"`), `the entry must not import ${m}`);
  for (const f of fs.readdirSync(path.join(ROOT, "public", "js"))) {
    const m = f.replace(/\.js$/, ""); if (lazy.includes(m)) continue;
    const s = src("public/js/" + f);
    for (const l of lazy) assert.ok(!new RegExp(`^import [^\\n]*from "\\./${l}\\.js";$`, "m").test(s), `${f} statically imports lazy ${l} — it would load eagerly again`);
  }
  const core = src("public/js/core.js");
  for (const m of lazy) assert.ok(core.includes(`${m}:()=>import("./${m}.js"),`), "literal specifier for " + m);
  // every module-level boot the entry used to run for a lazy module now runs from lazyMod
  for (const m of lazy) for (const b of (src("public/js/" + m + ".js").match(/^export function (__boot_[a-z0-9_]+)/gm) || []))
    assert.ok(!app.includes(b.replace("export function ", "")), "entry no longer boots " + m);
  const bt = src("public/js/backtest.js");
  for (const pin of ["lazyCall('charts','openCharts')", "lazyCall('funds','openFunds')", "lazyCall('insiders','openCongress')", "lazyCall('insiders','openInsiders')", "lazyCall('drawdown','openDrawdown')", "lazyCall('positioning','drawSessions')"])
    assert.ok(bt.includes(pin), "showView/scope path: " + pin);
});

// ---- 6. correlation hover ----------------------------------------------------------------------
function corrHoverRig() {
  const body = between(src("public/js/corr.js"), "function corrCellAt(", "function renderCorrPanel(");
  const cnt = { tip: 0, readout: 0, add: 0, remove: 0 };
  const cls = () => { const s = new Set(); return { add: (c) => { cnt.add++; s.add(c); }, remove: (c) => { cnt.remove++; s.delete(c); }, contains: (c) => s.has(c), toggle() { throw new Error("no per-event sweeps"); } }; };
  const N = 4, cols = Array.from({ length: N }, () => ({ classList: cls() })), rls = Array.from({ length: N }, () => ({ classList: cls() }));
  const H = {};
  const tbl = { addEventListener: (t, f) => { H[t] = f; },
    querySelectorAll: (q) => q === "thead th.cl" ? cols : q === "tbody th.rl" ? rls : [] };
  const nodes = { corrwrap: { innerHTML: "", querySelector: () => tbl }, corrtip: { hidden: true, innerHTML: "" }, "corr-readout": { innerHTML: "" } };
  const CORR = { _readout: "idle" };
  const state = { corr: {} };
  const api = new Function("CORR", "corrOrder", "corrColor", "esc", "basketTip", "el", "state", "corrTipHtml", "readoutHtml", "positionTip",
    "renderCorrPanel", "renderPairPanel", "renderCorrPairs", "openPair", body + "; return { paintCorr };")(
    CORR, () => [2, 0, 3, 1], () => "#000", (x) => String(x), () => "", (id) => nodes[id], state,
    (ri, ci) => { cnt.tip++; return "tip" + ri + ci; }, () => { cnt.readout++; return "ro"; }, () => {}, () => {}, () => {}, () => {}, () => {});
  const rows = Array.from({ length: N }, (_, i) => ({ ticker: "T" + i, coin: "C" + i }));
  const C = rows.map((_, i) => rows.map((__, j) => i === j ? 1 : 0.5)), OV = rows.map(() => rows.map(() => 30));
  api.paintCorr(rows, C, OV, {});
  const td = (dr, dc) => { const tr = { dataset: { dr: String(dr) } }; const t = { parentNode: tr, cellIndex: dc + 1 }; t.closest = (s) => s === "td" ? t : null; return t; };
  const ev = (t) => ({ target: t, clientX: 1, clientY: 1 });
  return { H, cnt, nodes, cols, rls, td, ev };
}

test("perf -103 corr hover: no per-cell data attributes; tooltip + header highlight rebuild only when the cell changes", () => {
  const r = corrHoverRig();
  const html = r.nodes.corrwrap.innerHTML;
  assert.ok(html.includes("<td") && !/<td[^>]*data-/.test(html), "cells carry no data-* attributes");
  const a = r.td(1, 2), a2 = r.td(1, 2), b = r.td(3, 0);
  for (let i = 0; i < 6; i++) { r.H.mouseover(r.ev(i % 2 ? a : a2)); r.H.mousemove(r.ev(i % 2 ? a : a2)); }
  assert.equal(r.cnt.tip, 1, "six moves inside one cell: one tooltip build");
  assert.equal(r.cnt.readout, 1, "and one readout");
  assert.equal(r.cnt.add, 2, "one column + one row header highlighted, once");
  assert.ok(r.cols[2].classList.contains("hl") && r.rls[1].classList.contains("hl"));
  r.H.mouseover(r.ev(b)); r.H.mousemove(r.ev(b));
  assert.equal(r.cnt.tip, 2, "a new cell rebuilds");
  assert.ok(r.cols[0].classList.contains("hl") && !r.cols[2].classList.contains("hl"), "highlight moved, the old one cleared");
  assert.equal(r.nodes.corrtip.innerHTML, "tip12", "matrix indices come through ord (display row 3 -> ri 1, display col 0 -> ci 2)");
  r.H.mouseleave(); assert.equal(r.nodes.corrtip.hidden, true); assert.equal(r.nodes["corr-readout"].innerHTML, "idle");
  r.H.mouseover(r.ev(b)); r.H.mousemove(r.ev(b));
  assert.equal(r.cnt.tip, 3, "re-entering after a leave rebuilds");
  r.H.mousemove(r.ev({ closest: () => null })); assert.equal(r.nodes.corrtip.hidden, true, "off-cell hides");
});

test("perf -103 global tooltip: the capture-phase mousemove is rAF-coalesced; idle ticks sleep", () => {
  const t = src("public/js/terminal.js");
  assert.ok(t.includes("mv.e={target:e.target, clientX:e.clientX, clientY:e.clientY};") && t.includes("if(!mv.raf) mv.raf=(typeof requestAnimationFrame==='function')?requestAnimationFrame(moveFrame):(moveFrame(),0);"), "one dispatch per frame, newest event");
  assert.ok(t.includes("function hideNow(){ mv.e=null; hide(); }") && t.includes("document.addEventListener('mouseleave', hideNow, true);"), "a leave drops a pending frame");
  assert.ok(src("public/js/report.js").includes("if(document.hidden||state.view!=='report') return;"), "the report countdown sleeps off-tab");
  assert.ok(src("public/js/messages.js").includes("_dmRecTimer=setInterval(()=>{ if(!_dmRec||document.hidden) return; dmMicPaint(); },1000);"), "the mic tick sleeps when hidden / not recording");
});

// ---- 7. service worker: versioned static assets only ------------------------------------------
function swRig(build) {
  const code = src("public/sw.js").split("{{build}}").join(build);
  const H = {}, stores = new Map(), fetched = [];
  const mkCache = (name) => { if (!stores.has(name)) stores.set(name, new Map()); const m = stores.get(name);
    return { match: async (req) => m.get(req.url), put: async (req, res) => { m.set(req.url, res); } }; };
  const caches = { open: async (n) => mkCache(n), keys: async () => [...stores.keys()], delete: async (n) => stores.delete(n) };
  const fetch = async (req) => { fetched.push(req.url); return { status: 200, type: "basic", url: req.url, clone() { return this; } }; };
  const self = { addEventListener: (t, f) => { H[t] = f; }, location: { origin: "https://app.test" }, skipWaiting() {},
    clients: { claim: async () => {}, matchAll: async () => [] }, registration: { showNotification: async () => {} } };
  vm.runInNewContext(code, { self, caches, fetch, URL, Promise });
  const go = async (url, method) => { let p = null; H.fetch({ request: { url, method: method || "GET" }, respondWith: (x) => { p = x; } }); return p ? await p : null; };
  return { H, stores, fetched, go, caches };
}

test("perf -103 sw: cache-first for this build's stamped app.js / js modules / styles.css — nothing else is intercepted", async () => {
  const r = swRig("B7");
  const O = "https://app.test";
  for (const u of ["/app.js?v=B7", "/js/core.js?v=B7", "/styles.css?v=B7"]) {
    const a = await r.go(O + u); assert.ok(a && a.url === O + u, "served: " + u);
    const n = r.fetched.length; const b = await r.go(O + u);
    assert.strictEqual(b, a, "second hit comes from the cache"); assert.equal(r.fetched.length, n, "without touching the network");
  }
  assert.deepEqual([...r.stores.keys()], ["xyz-static-B7"], "one cache, keyed by build");
  for (const u of ["/api/snapshot?v=B7", "/", "/index.html?v=B7", "/app.js", "/app.js?v=B6", "/js/core.js?v=B7&x=1", "/js/core.js", "/sw.js?v=B7", "/icon.svg?v=B7", "/js/../api/x.js?v=B7"])
    assert.equal(await r.go(O + u), null, "passes through untouched: " + u);
  assert.equal(await r.go("https://evil.test/app.js?v=B7"), null, "cross-origin: never");
  assert.equal(await r.go(O + "/app.js?v=B7", "POST"), null, "non-GET: never");
  assert.ok(r.H.push && r.H.notificationclick, "push handling intact");
});

test("perf -103 sw: activate purges other builds' asset caches only; an unstamped worker caches nothing", async () => {
  const r = swRig("B8");
  await r.caches.open("xyz-static-B7"); await r.caches.open("xyz-static-B8"); await r.caches.open("someone-else");
  let done = null; r.H.activate({ waitUntil: (p) => { done = p; } }); await done;
  assert.deepEqual([...r.stores.keys()].sort(), ["someone-else", "xyz-static-B8"]);
  const raw = swRig("{{build}}");
  assert.equal(await raw.go("https://app.test/app.js?v={{build}}"), null, "the unstamped file (tests, a missing server stamp) intercepts nothing");
  assert.equal(raw.stores.size, 0);
});

test("perf -103: README documents the client pass", () => {
  assert.ok(src("README.md").includes("**Performance, client (build 2026.09.24-103).**"), "README entry");
});
