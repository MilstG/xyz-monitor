"use strict";
// public/js/drawdown.js — the Return / Drawdown tab (build 2026.09.23-92): the pure study the
// chart and table are drawn from, the anchor resolution, and the wiring that makes the tab a tab.
const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs"), path = require("path");
const DAY = 86400000;
const D = (n) => Date.UTC(2026, 5, 1) + n * DAY;   // 2026-06-01 + n days, UTC midnight

// The module's study section, run with a stub store: everything from the late-gap constant through
// the study function, so a change to the maths lands here and not only in a browser.
function studyApi() {
  const app = require("./_client").clientSource();
  const a = app.indexOf("const RVD_LATE_GAP="), b = app.indexOf("function rvdRows(");
  assert.ok(a > 0 && b > a, "drawdown study block not found in the client source");
  return new Function("store", "DAY", "isoUtc", app.slice(a, b) + "; return { rvdStudy, rvdAnchorTs, RVD, rvdToday };")({ get: () => null, set() {} }, DAY, () => "");
}

test("drawdown study: best return, max drawdown with its dates, now, and the live mark as the last point", () => {
  const { rvdStudy } = studyApi();
  const bars = [90, 100, 110, 120, 90, 105].map((c, i) => ({ t: D(i - 1), c }));   // the 90 sits a day BEFORE the anchor
  const s = rvdStudy(bars, D(0), 108);
  assert.ok(s, "a path with points on/after the anchor is a study");
  assert.equal(s.base, 100, "the anchor close is the first bar on/after the anchor — the bar before it is ignored");
  assert.equal(s.baseT, D(0)); assert.equal(s.late, false, "a bar on the anchor day is not late");
  assert.ok(Math.abs(s.best.ret - 0.20) < 1e-12, "best = highest close over base"); assert.equal(s.best.t, D(2)); assert.equal(s.best.c, 120);
  assert.ok(Math.abs(s.dd.ret - (90 / 120 - 1)) < 1e-12, "max drawdown is measured from the running peak, not from the anchor");
  assert.equal(s.dd.peakT, D(2)); assert.equal(s.dd.troughT, D(3)); assert.equal(s.dd.peakC, 120); assert.equal(s.dd.troughC, 90);
  assert.ok(Math.abs(s.now.ret - 0.08) < 1e-12, "now = the live mark over base"); assert.equal(s.now.live, true, "the live mark is the last point");
  assert.equal(s.n, 6, "five bars in the window plus the live point");
  // the same path without a live mark ends on the last close
  const s2 = rvdStudy(bars, D(0), null);
  assert.ok(Math.abs(s2.now.ret - 0.05) < 1e-12 && s2.now.live === false && s2.n === 5, "no mark: the last close is now");
  // a live mark on a day whose bar already exists REPLACES that bar's close rather than adding a point
  const today = Math.floor(Date.now() / DAY) * DAY;
  const s3 = rvdStudy([{ t: today - DAY, c: 100 }, { t: today, c: 101 }], today - DAY, 130);
  assert.equal(s3.n, 2, "today's forming bar is overwritten by the mark, not duplicated");
  assert.ok(Math.abs(s3.best.ret - 0.30) < 1e-12 && s3.now.live === true, "the mark drives today's point");
});

test("drawdown study: floors and edges — best is never negative, drawdown never positive, thin windows are null, late listings are flagged", () => {
  const { rvdStudy } = studyApi();
  // monotone decline: the anchor bar itself is the best (0), the drawdown is the whole fall
  const down = [100, 95, 80, 70].map((c, i) => ({ t: D(i), c }));
  const s = rvdStudy(down, D(0), null);
  assert.equal(s.best.ret, 0); assert.equal(s.best.t, D(0));
  assert.ok(Math.abs(s.dd.ret - (-0.30)) < 1e-12); assert.equal(s.dd.peakT, D(0)); assert.equal(s.dd.troughT, D(3));
  // monotone rise: no drawdown at all, and the dates say so
  const up = [100, 110, 120].map((c, i) => ({ t: D(i), c }));
  const u = rvdStudy(up, D(0), null);
  assert.equal(u.dd.ret, 0); assert.equal(u.dd.peakT, D(0)); assert.equal(u.dd.troughT, D(0));
  assert.ok(Math.abs(u.best.ret - 0.20) < 1e-12);
  // fewer than two points on/after the anchor is not a study
  assert.equal(rvdStudy([{ t: D(0), c: 100 }], D(0), null), null, "one close is a dot with no path");
  assert.equal(rvdStudy([{ t: D(-5), c: 100 }, { t: D(-4), c: 110 }], D(0), null), null, "every bar before the anchor: nothing to study");
  assert.equal(rvdStudy([{ t: D(-5), c: 100 }], D(0), 120), null, "a live mark alone is one point");
  assert.equal(rvdStudy(null, D(0), 1), null); assert.equal(rvdStudy("x", D(0), 1), null);
  // garbage bars are skipped, not counted
  const g = rvdStudy([{ t: D(0), c: 100 }, { t: D(1), c: NaN }, { t: D(2), c: 0 }, null, { t: D(3), c: 150 }], D(0), null);
  assert.equal(g.n, 2); assert.ok(Math.abs(g.best.ret - 0.5) < 1e-12);
  // a first bar well past the anchor is a listing that came after it
  const late = rvdStudy([{ t: D(10), c: 50 }, { t: D(11), c: 60 }], D(0), null);
  assert.equal(late.late, true, "10 days past the anchor is late"); assert.equal(late.base, 50, "…and starts at its own first close");
  const wknd = rvdStudy([{ t: D(2), c: 50 }, { t: D(3), c: 60 }], D(0), null);
  assert.equal(wknd.late, false, "a weekend gap (2 days) is not a late listing");
  // the study never mutates the caller's bars
  const bars = [{ t: D(0), c: 100 }, { t: Math.floor(Date.now() / DAY) * DAY, c: 101 }];
  rvdStudy(bars, D(0), 200);
  assert.equal(bars[1].c, 101, "the live-mark fold works on a copy");
});

test("drawdown anchor: presets count back from today's UTC midnight, YTD is Jan 1, a date beats the preset, a bad date falls back", () => {
  const { rvdAnchorTs, RVD, rvdToday } = studyApi();
  const today = rvdToday();
  RVD.date = null; RVD.preset = "90";
  assert.equal(rvdAnchorTs(), today - 90 * DAY);
  RVD.preset = "ytd";
  assert.equal(rvdAnchorTs(), Date.UTC(new Date().getUTCFullYear(), 0, 1));
  RVD.preset = "garbage";
  assert.equal(rvdAnchorTs(), today - 90 * DAY, "an unknown preset is the 90d default");
  RVD.preset = "30"; RVD.date = "2026-03-03";
  assert.equal(rvdAnchorTs(), Date.UTC(2026, 2, 3), "an explicit date wins over the preset, at UTC midnight");
  RVD.date = "not-a-date";
  assert.equal(rvdAnchorTs(), today - 30 * DAY, "an unparseable date falls back to the preset");
  RVD.date = new Date(today + 30 * DAY).toISOString().slice(0, 10);
  assert.equal(rvdAnchorTs(), today - 30 * DAY, "a future date falls back to the preset");
});

test("drawdown chart cut: top N by the return axis, references always kept, the table untouched", () => {
  const app = require("./_client").clientSource();
  const a = app.indexOf("const RVD_LATE_GAP="), b = app.indexOf("function rvdNiceStep(");
  const api = new Function("store", "DAY", "isoUtc", "scopeBench", "activeRows", "state", app.slice(a, b) + "; return { rvdChartRows, RVD };")({ get: () => null, set() {} }, DAY, () => "", () => null, () => [], { scope: "stocks" });
  const rows = [
    { coin: "a", bench: -1, now: 50, best: 60 }, { coin: "b", bench: -1, now: 10, best: 90 }, { coin: "c", bench: -1, now: -20, best: 5 },
    { coin: "spx", bench: 0, now: -40, best: 1 }, { coin: "d", bench: -1, now: 30, best: 35 }];
  api.RVD.y = "now"; api.RVD.top = "2";
  assert.deepEqual(api.rvdChartRows(rows).map((x) => x.coin), ["spx", "a", "d"], "top 2 by now, plus the reference however badly it ranks");
  api.RVD.y = "best";
  assert.deepEqual(api.rvdChartRows(rows).map((x) => x.coin), ["spx", "b", "a"], "the cut follows the return axis in use");
  api.RVD.top = "all";
  assert.equal(api.rvdChartRows(rows).length, 5, "'all' is everyone");
  api.RVD.top = "garbage";
  assert.equal(api.rvdChartRows(rows).length, 5, "an unknown cut is everyone, never an empty chart");
});

test("drawdown tab: wired end to end — manifest, markup, routing, scope, dispatch, data hook, help, manual, styles, build stamp", () => {
  const C = require("../src/compute");
  const f = C.FEATURES.find((x) => x.key === "drawdown");
  assert.ok(f && f.kind === "tab", "FEATURES carries the tab");
  assert.equal(f.def, "admin", "ships admin-only while it soaks");
  assert.deepEqual(f.routes, [], "no route of its own: the study reads /api/daily under the pinned markets key");
  assert.ok(C.NAV_GROUPS.find((g) => g.key === "tape").views.includes("drawdown"), "lives in the tape (market data) menu");
  const html = fs.readFileSync(path.join(__dirname, "..", "public", "index.html"), "utf8");
  assert.ok(html.includes('data-view="drawdown"') && html.includes('id="view-drawdown"'), "nav button + view section");
  assert.ok(html.includes('id="rvd-ctrls"') && html.includes('id="rvd-wrap"'), "the renderer's two mount points");
  const app = require("./_client").clientSource();
  assert.ok(require("./_client").CLIENT_MODULES.includes("drawdown"), "the suite's module list carries drawdown");
  assert.ok(fs.readFileSync(path.join(__dirname, "..", "public", "app.js"), "utf8").includes('import "./js/drawdown.js";'), "the entry loads the module");
  const hv = app.match(/const HASH_VIEWS=new Set\(\[([^\]]*)\]\)/);
  assert.ok(hv && hv[1].includes("'drawdown'"), "#drawdown routes");
  assert.ok(/const CRYPTO_VIEWS=new Set\(\[[^\]]*'drawdown'/.test(app), "the study runs in crypto scope too");
  assert.ok(app.includes("setHidden('view-drawdown', v!=='drawdown');"), "showView hides/shows the section");
  assert.ok(app.includes("if(v==='drawdown'){ if(el('view-drawdown')) openDrawdown(); else { showView('markets'); return; } }"), "showView dispatches the renderer, with the missing-section bounce");
  assert.ok(app.includes("if(state.view==='drawdown') renderDrawdown();"), "a scope flip repaints the study for the other universe");
  assert.ok(/const dv=el\('view-drawdown'\); if\(dv&&!dv\.hidden\) renderDrawdown\(\);/.test(app), "applyDaily repaints an open tab when closes land");
  assert.ok(/const HELP=\{[\s\S]*?\n  drawdown:`/.test(app), "the ? explainer has an entry");
  assert.ok(app.includes("{v:'drawdown',label:'Drawdown'}"), "the command palette literal names it");
  const docs = fs.readFileSync(path.join(__dirname, "..", "public", "docs.html"), "utf8");
  assert.ok(docs.includes('<section id="tab-drawdown" data-feature="drawdown" data-def="admin">'), "the manual has a gated, admin-marked section");
  const css = fs.readFileSync(path.join(__dirname, "..", "public", "styles.css"), "utf8");
  for (const pin of [".rvd-title", ".rvd-sub", ".rvd-head", ".rvd-tbl", ".rvdsvg.hv .rvd-dot:not(.hot)", ".rvd-legend i.late", ".rvd-late"])
    assert.ok(css.includes(pin), "css pin missing: " + pin);
  const sv = fs.readFileSync(path.join(__dirname, "..", "server.js"), "utf8");
  assert.ok(sv.includes('const VERSION = "2026.09.23-94"'), "build stamp");
  // the renderer's contract with the DOM: closes only, the caption says so, and the CSV carries the dates
  const src = fs.readFileSync(path.join(__dirname, "..", "public", "js", "drawdown.js"), "utf8");
  assert.ok(src.includes("intraday lows are not in the daily feed"), "the caption discloses close-to-close");
  assert.ok(src.includes("'best_date','max_dd_pct','dd_peak','dd_trough'"), "CSV columns carry the dates");
  assert.ok(src.includes("const xM=v=>px1-Math.min(-v,maxX)/maxX*(px1-px0);"), "zero drawdown sits at the RIGHT edge — up-and-right is better");
  assert.ok(src.includes("shallower →") && src.includes("Up and to the right is better"), "the axis and the subtitle say which way is good");
  assert.ok(src.includes("seg('rvd-y','return','rvdy',[['now','now'],['best','best']],RVD.y)"), "the return axis switches between now and best");
  assert.ok(/function rvdBenchCoins\(\)\{[\s\S]*?scopeBench\(\)[\s\S]*?'ETH'[\s\S]*?r\.sector==='Index'/.test(src), "references: the scope benchmark, plus ETH in crypto and the index rows in stocks");
  assert.ok(src.includes("stroke-dasharray=\"5 4\"") && src.includes("${esc(b.ticker)} ${pct(yOf(b))}"), "each reference is a dashed line named with its return");
  assert.ok(src.includes("seg('rvd-top','top','rvdt',RVD_TOPS,RVD.top)") && src.includes("rvdSvg(shown,anchorTs)") && src.includes("rvdTableHtml(rows)"), "the top-N cut applies to the chart, never to the table");
  assert.ok(src.includes("const RVD_PAGE=25;") && src.includes("data-rvdpg=") && css.includes(".rvd-pager"), "the table pages, 25 rows at a time");
  assert.ok(!src.includes("= drawdown</text>"), "no diagonal on the chart");
  assert.ok(src.includes("layoutMapLabels(nodes.filter(n=>n.label),{px0,px1,py1,py0:py0-22})"), "labels route around each other with the sector map's layout, kept out of the tick row");
});
