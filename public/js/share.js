"use strict";
// Share to chat (build 2026.09.21-84): any cell, any row, any screen of the markets table into a
// conversation as a DATA CARD — a message kind that keeps the app's own formatting, says when it
// was captured, drifts against the live mark, and opens the same view when clicked.
//
// The serializer is the column table. A capture runs the column's own td renderer over the row
// and keeps the TEXT it drew and the class it drew it in (pos/neg/sec/na), so every column is
// shareable the day it lands — no second list of getters to forget. "now" on a card is the same
// renderer run over the live row. The server validates the card's shape and renders the text body
// that search, export and the Telegram mirror read (compute.validateCard / cardText).
//
// Everywhere (build 2026.09.24-98): the same glyph, sheet and card leave the screener. A PANEL is
// any other surface — a drawer section, a board row, a whole board — captured from what it DREW
// (the column-table rule again: the text on screen and the class it wore, never a second list of
// getters), with a sparkline's numbers riding along as data so the card redraws the line itself.
// A CHART is the /ratio road: the pane rasterised to a PNG, uploaded into the thread, the card as
// its caption. A SCREEN can be LIVE: its filters travel as data and every viewer's copy re-runs
// them over the current snapshot, with the frozen table kept underneath "as shared".
import { HASH_VIEWS, pushToast } from "./alerts.js";
import { showView } from "./backtest.js";
import { COL_BY_KEY, el, esc, fmtPrice, overlayPop, overlayPush, state } from "./core.js";
import { sparkline } from "./corr.js";
import { fetchJSON } from "./data.js";
import { drawerCandleCard, openDetail } from "./drawer.js";
import { earnShareRows } from "./notes.js";

// Columns that are not data: the ticker cell (rail, star, marker) and the personal position overlay.
const SKIP_COLS = new Set(["ticker", "pos"]);
const CTX_KEYS = ["d1", "rvol", "funding", "oi"];   // the context a single cell travels with
const SCREEN_MAX_ROWS = 25, SCREEN_MAX_COLS = 8;
// Set by the screener at boot: the rows and columns currently on screen, in their order.
let source = () => ({ rows: [], cols: [] });
function shareSetSource(fn) { if (typeof fn === "function") source = fn; }

// ---- capture -----------------------------------------------------------------------------------
const CLS = ["pos", "neg", "sec", "na"];
function cellOf(col, r) {
  const tmp = document.createElement("table");
  try { tmp.innerHTML = "<tbody><tr>" + col.td(r) + "</tr></tbody>"; } catch (_) { return { s: "—", c: "na" }; }
  const td = tmp.querySelector("td");
  if (!td) return { s: "—", c: "na" };
  const s = String(td.textContent || "").replace(/\s+/g, " ").trim().slice(0, 32) || "—";
  let c = "";
  for (const node of [td, td.firstElementChild]) { if (!node) continue; const hit = CLS.find((k) => node.classList.contains(k)); if (hit) { c = hit; break; } }
  return { s, c };
}
const dataCols = (cols) => cols.filter((c) => c && !SKIP_COLS.has(c.key));
const scopeOf = () => (state.scope === "crypto" ? "crypto" : "stocks");
function rowEntry(r, cols) { return { coin: r.coin, t: r.ticker || r.coin, px: r.px, c: cols.map((c) => cellOf(c, r)) }; }
function captureCell(coin, key) {
  const r = state.rows.get(coin), col = COL_BY_KEY[key];
  if (!r || !col || SKIP_COLS.has(key)) return null;
  const ctx = CTX_KEYS.filter((k) => k !== key && COL_BY_KEY[k]).map((k) => { const x = cellOf(COL_BY_KEY[k], r); return { l: COL_BY_KEY[k].label, s: x.s, c: x.c }; });
  return { v: 1, kind: "cell", view: "markets", scope: scopeOf(), tf: state.tf, cols: [{ k: col.key, l: col.label }], rows: [rowEntry(r, [col])], ctx, at: Date.now() };
}
function captureRow(coin, cols) {
  const r = state.rows.get(coin); if (!r) return null;
  const cs = dataCols(cols && cols.length ? cols : source().cols).slice(0, 12);
  if (!cs.length) return null;
  return { v: 1, kind: "row", view: "markets", scope: scopeOf(), tf: state.tf, cols: cs.map((c) => ({ k: c.key, l: c.label })), rows: [rowEntry(r, cs)], at: Date.now() };
}
function filtersText() {
  const f = [];
  if (state.filter && state.filter.trim()) f.push("filter “" + state.filter.trim() + "”");
  const t = state.filters || {};
  if (t.volMin != null) f.push("vol ≥ " + t.volMin + "M"); if (t.volMax != null) f.push("vol ≤ " + t.volMax + "M");
  if (t.oiMin != null) f.push("oi ≥ " + t.oiMin + "M"); if (t.oiMax != null) f.push("oi ≤ " + t.oiMax + "M");
  if (state.watchOnly) f.push("★ only"); if (state.noteOnly) f.push("noted"); if (state.posOnly) f.push("held");
  if (state.grpDrill) f.push("group " + state.grpDrill);
  return f.join(" & ");
}
function captureScreen(rows, cols) {
  const src = source();
  const list = (rows && rows.length ? rows : src.rows).slice(0, SCREEN_MAX_ROWS);
  const cs = dataCols(cols && cols.length ? cols : src.cols).slice(0, SCREEN_MAX_COLS);
  if (!list.length || !cs.length) return null;
  const sortCol = COL_BY_KEY[state.sortKey];
  return { v: 1, kind: "screen", view: "markets", scope: scopeOf(), tf: state.tf, cols: cs.map((c) => ({ k: c.key, l: c.label })),
    rows: list.map((r) => rowEntry(r, cs)), filters: filtersText(), sort: sortCol ? sortCol.label + " " + (state.sortDir || "desc") : "",
    total: src.rows.length, q: screenQuery(), live: false, at: Date.now() };
}
// The screen's filters as DATA (build 2026.09.24-98), so a viewer can re-run them. null when the
// screen leans on a personal list — ★ only, noted, held are the SHARER's, and re-run against a
// viewer's own they would be a different screen under the same card — or on a group drill too big
// to carry; the sheet then says why "live" is off instead of offering a screen it cannot keep.
const SCREEN_Q_GRP = 150;
function screenQuery() {
  if (state.watchOnly || state.noteOnly || state.posOnly) return null;
  const g = state.grpDrill && state.grpDrill.set ? [...state.grpDrill.set] : [];
  if (g.length > SCREEN_Q_GRP) return null;
  const t = state.filters || {}, n = (v) => (typeof v === "number" && isFinite(v) ? v : null);
  return { f: String(state.filter || "").trim().slice(0, 40), vmin: n(t.volMin), vmax: n(t.volMax), omin: n(t.oiMin), omax: n(t.oiMax),
    grp: g, gl: state.grpDrill ? String(state.grpDrill.label || "").slice(0, 40) : "", sk: state.sortKey || "", sd: state.sortDir === "asc" ? "asc" : "desc", sc: scopeOf() };
}
// The live re-run: the screener's own rules (sortedRows / thresholdRows) over the snapshot as it is
// now, in the card's scope — minus the ★ pinning, which is the viewer's order, not the screen's.
function screenRun(q) {
  let rows = [];
  for (const r of state.rows.values()) if (!r.delisted && (r.uni === "main") === (q.sc === "crypto")) rows.push(r);
  if (q.grp && q.grp.length) { const g = new Set(q.grp); rows = rows.filter((r) => g.has(r.coin)); }
  const f = String(q.f || "").toUpperCase();
  if (f) rows = rows.filter((r) => String(r.ticker || "").toUpperCase().includes(f) || String(r.coin || "").toUpperCase().includes(f));
  const inside = (v, lo, hi) => (lo == null || (v != null && v >= lo)) && (hi == null || (v != null && v <= hi));
  rows = rows.filter((r) => inside(r.vol, q.vmin, q.vmax) && inside(r.oi, q.omin, q.omax));
  const col = COL_BY_KEY[q.sk], k = q.sk, dir = q.sd === "asc" ? 1 : -1;
  if (col) rows.sort((a, b) => { const av = a[k], bv = b[k]; if (col.type === "str") return dir * String(av).localeCompare(String(bv));
    const an = (av == null || !isFinite(av)), bn = (bv == null || !isFinite(bv)); if (an && bn) return 0; if (an) return 1; if (bn) return -1; return dir * (av - bv); });
  return rows;
}

// ---- panels: every other surface (build 2026.09.24-98) -------------------------------------------
// A panel is captured from the DOM the surface drew: each cell's text and the colour class it wore
// (pos/neg/sec/na), exactly the column-table rule, so a board column added tomorrow is shareable
// tomorrow. One row reads as label/value lines; a board reads as a table (first 25 rows).
const PANEL_MAX_ROWS = 25, PANEL_MAX_COLS = 8;
const shClip = (s, n) => String(s == null ? "" : s).replace(/\s+/g, " ").trim().slice(0, n);
const shTxt = (root, sel) => { const n = root && root.querySelector ? root.querySelector(sel) : null; return n ? n.textContent : ""; };
function shNodeCell(node) {
  if (!node) return { s: "—", c: "na" };
  const s = shClip(node.textContent, 64) || "—";
  let c = CLS.find((k) => node.classList && node.classList.contains(k)) || "";
  if (!c && node.querySelector) { const hit = node.querySelector(".pos,.neg,.sec,.na"); if (hit) c = CLS.find((k) => hit.classList.contains(k)) || ""; }
  return { s, c };
}
function shMarket(coin) {
  const r = coin ? state.rows.get(coin) : null;
  return r ? { coin: r.coin, t: r.ticker || r.coin, px: r.px > 0 ? r.px : null } : { coin: "", t: "", px: null };
}
// A compact number for a sparkline's endpoints, whatever its unit (OI dollars, an APR, a price).
function shNum(v) {
  const a = Math.abs(v);
  return a >= 1e9 ? (v / 1e9).toFixed(2) + "B" : a >= 1e6 ? (v / 1e6).toFixed(2) + "M" : a >= 1e4 ? (v / 1e3).toFixed(1) + "k" : a >= 100 ? v.toFixed(1) : v.toFixed(2);
}
// A spark with no lines of its own still says three things: where it started, where it is, how far.
function shSparkRows(v) {
  const f = v.filter((x) => x != null && isFinite(x)); if (f.length < 2) return [];
  const a = f[0], z = f[f.length - 1], ch = a > 0 && z > 0 ? (z / a - 1) * 100 : null;
  const d = ch != null ? { s: (ch >= 0 ? "+" : "") + ch.toFixed(1) + "%", c: ch > 0 ? "pos" : ch < 0 ? "neg" : "sec" }
    : { s: (z - a >= 0 ? "+" : "") + shNum(z - a), c: z > a ? "pos" : z < a ? "neg" : "sec" };
  return [{ t: "from", c: [{ s: shNum(a), c: "" }] }, { t: "to", c: [{ s: shNum(z), c: "" }] }, { t: "change", c: [d] }];
}
// The one constructor every panel goes through. `rows` are {t, c:[cells]}; one column = lines.
function shPanel(o) {
  const m = shMarket(o.coin);
  let spark = null;
  if (o.spark && Array.isArray(o.spark.v)) {
    const v = o.spark.v.map((x) => (x == null || x === "" || !isFinite(+x) ? null : +x));
    const step = Math.max(1, Math.ceil(v.length / 120));   // the server keeps 120 points: thin evenly, never cut the history's start
    const thin = []; for (let i = 0; i < v.length; i += step) thin.push(v[i]);
    if (step > 1) thin[thin.length - 1] = v[v.length - 1];   // the last point is "now", whatever the stride
    if (thin.filter((x) => x != null).length >= 2) spark = { v: thin, l: shClip(o.spark.l || "", 48), z: !!o.spark.z };
  }
  let rows = (o.rows || []).filter((r) => r && (r.t || (r.c && r.c.length))).slice(0, PANEL_MAX_ROWS);
  if (!rows.length && spark) rows = shSparkRows(spark.v);
  if (!rows.length) return null;
  const cols = (o.cols && o.cols.length ? o.cols : [{ k: "v", l: "value" }]).slice(0, PANEL_MAX_COLS);
  return { v: 1, kind: "panel", view: o.view || "markets", title: shClip(o.title, 48) || "panel", scope: scopeOf(), tf: state.tf,
    coin: m.coin, t: m.t, px: m.px, cols, rows: rows.map((r) => ({ coin: r.coin || "", t: shClip(r.t, 24), c: r.c.slice(0, cols.length) })),
    spark, total: Math.max(rows.length, o.total || 0), at: Date.now() };
}
// Boards: the header row names the columns; a row's own name column is its title, not a field.
function shHeads(table) {
  const h = table && table.tHead && table.tHead.rows.length ? table.tHead.rows[table.tHead.rows.length - 1] : null;
  return h ? [...h.cells].map((th) => shClip(String(th.textContent).replace(/[▾▴]/g, ""), 24)) : [];
}
function shRowLabel(tr) {
  const coin = tr.dataset && tr.dataset.coin;
  if (coin) { const r = state.rows.get(coin); return r ? r.ticker || coin : coin.replace(/^xyz:/, ""); }
  // No market (a sector row): the name column says what the row is, in the words it drew.
  return shClip(tr.cells && tr.cells[0] ? tr.cells[0].textContent : tr.dataset && tr.dataset.sect ? tr.dataset.sect : "", 24);
}
// The kept columns: named, not the rank "#", not the name column (its text opens with the label).
function shKeepCols(tr, heads, label) {
  const keep = [];
  heads.forEach((l, i) => {
    if (!l || l === "#" || !tr.cells[i]) return;
    const s = shClip(tr.cells[i].textContent, 64);
    if (label && (s === label || s.startsWith(label + " "))) return;
    keep.push(i);
  });
  return keep;
}
function captureBoardRow(tr, o) {
  if (!tr || !tr.cells) return null;
  const heads = shHeads(tr.closest("table")), label = shRowLabel(tr), keep = shKeepCols(tr, heads, label).slice(0, 12);
  const coin = tr.dataset.coin || "";
  return shPanel({ view: o.view, title: o.title + (coin ? "" : " · " + label), coin,
    rows: keep.map((i) => ({ t: heads[i], c: [shNodeCell(tr.cells[i])] })) });
}
function captureBoard(tr, o) {
  const table = tr && tr.closest ? tr.closest("table") : null; if (!table) return null;
  const trs = [...table.querySelectorAll(o.rowSel)].filter((x) => x.tagName === "TR");
  if (!trs.length) return null;
  const heads = shHeads(table), keep = shKeepCols(trs[0], heads, shRowLabel(trs[0])).slice(0, PANEL_MAX_COLS);
  if (!keep.length) return null;
  return shPanel({ view: o.view, title: o.title, cols: keep.map((i) => ({ k: "c" + i, l: heads[i] })), total: trs.length,
    rows: trs.slice(0, PANEL_MAX_ROWS).map((x) => ({ coin: x.dataset.coin || "", t: shRowLabel(x), c: keep.map((i) => shNodeCell(x.cells[i])) })) });
}
// Drawer sections: a header (.dsec, or an element marked data-shsec) and everything after it up to
// the next header. What the section drew decides the lines: metric tiles, correlation rows, notes,
// a split's figures, a sparkline's numbers; anything else is its words, one clause per line.
const SH_SEC = ".dsec,[data-shsec]";
function shSecTitle(hdr) {
  if (hdr.dataset && hdr.dataset.shsec) return hdr.dataset.shlabel || hdr.dataset.shsec;
  const c = hdr.cloneNode(true);
  c.querySelectorAll("button,.cdtf-seg,.dzsrc").forEach((n) => n.remove());
  return shClip(c.textContent, 48);
}
function shSecNodes(hdr) {
  if (hdr.dataset && hdr.dataset.shsec) return [hdr];
  const start = hdr.parentElement && hdr.parentElement.classList.contains("nt-head") ? hdr.parentElement : hdr;
  const out = [];
  for (let n = start.nextElementSibling; n; n = n.nextElementSibling) {
    if (n.matches(SH_SEC) || n.classList.contains("nt-head") || n.querySelector(SH_SEC)) break;
    out.push(n);
  }
  return out;
}
function shSecRows(nodes) {
  const rows = []; let spark = null;
  const line = (t, cell) => { if (rows.length < PANEL_MAX_ROWS) rows.push({ t: shClip(t, 24), c: [cell] }); };
  for (const n of nodes) {
    if (n.hidden) continue;
    const sp = n.matches("svg[data-series]") ? n : n.querySelector("svg[data-series]");
    if (sp && !spark) spark = String(sp.getAttribute("data-series") || "").split(",");
    const all = (sel) => (n.matches(sel) ? [n] : [...n.querySelectorAll(sel)]);
    const tiles = all(".dstat");
    if (tiles.length) { for (const x of tiles) line(shTxt(x, ".dk"), shNodeCell(x.querySelector(".dv"))); continue; }
    const crow = all(".crow");
    if (crow.length) { for (const x of crow) line(shTxt(x, ".ct"), shNodeCell(x.querySelector(".cv"))); continue; }
    const notes = all(".nt-item");
    if (notes.length) { for (const x of notes) line(shTxt(x, ".age"), { s: shClip(shTxt(x, ".nt-body"), 64) || "—", c: "" }); continue; }
    if (sp && !shClip(n.textContent, 8)) continue;
    const figs = [...n.children].filter((x) => x.tagName === "SPAN" && x.querySelector("b"));
    if (figs.length) { for (const x of figs) { const b = x.querySelector("b"); line(String(x.textContent).replace(b.textContent, ""), shNodeCell(b)); } continue; }
    if (n.matches("svg") || n.querySelector("textarea")) continue;
    for (const part of shClip(n.textContent, 600).split(" · ")) if (part.trim() && rows.length < PANEL_MAX_ROWS) rows.push({ t: "", c: [{ s: shClip(part, 64), c: "" }] });
  }
  return { rows, spark };
}
function captureDrawerSection(hdr) {
  const coin = state.detail; if (!hdr || !coin) return null;
  if (hdr.closest("#dcandles")) return drawerCandleCard(coin);   // a chart: the picture road
  const title = shSecTitle(hdr);
  if (hdr.dataset && hdr.dataset.shsec === "earn") return shPanel({ view: "drawer", title, coin, rows: earnShareRows(state.rows.get(coin)) });
  const { rows, spark } = shSecRows(shSecNodes(hdr));
  // A funding series crosses zero and is read against it; everything else is read against itself.
  return shPanel({ view: "drawer", title, coin, rows, spark: spark ? { v: spark, l: title, z: /funding/i.test(title) } : null });
}

// ---- charts: the /ratio road (build 2026.09.24-98) -----------------------------------------------
// A chart shares as a picture: rasterised offscreen to a PNG, uploaded into the conversation like a
// pasted screenshot, with a card as its caption. An <img> resolves no CSS variables, so an SVG has
// its theme colours substituted first; a canvas is already paint and only needs a floor under it.
function shThemeVar(n) { try { return String(getComputedStyle(document.documentElement).getPropertyValue(n) || "").trim(); } catch (_) { return ""; } }
function shSvgResolve(svg) { return String(svg).replace(/var\(--([a-z0-9-]+)\)/gi, (m, k) => shThemeVar("--" + k) || "#888"); }
function shSvgPng(svg, W, H) {
  return new Promise((res) => {
    try {
      const img = new Image(), url = URL.createObjectURL(new Blob([svg], { type: "image/svg+xml;charset=utf-8" }));
      img.onload = () => { try { const c = document.createElement("canvas"); c.width = W * 2; c.height = H * 2; const g = c.getContext("2d"); g.scale(2, 2); g.drawImage(img, 0, 0); c.toBlob((bl) => { URL.revokeObjectURL(url); res(bl); }, "image/png"); } catch (_) { URL.revokeObjectURL(url); res(null); } };
      img.onerror = () => { URL.revokeObjectURL(url); res(null); };
      img.src = url;
    } catch (_) { res(null); }
  });
}
function shCanvasPng(canvas) {
  return new Promise((res) => {
    try {
      const c = document.createElement("canvas"); c.width = canvas.width; c.height = canvas.height;
      const g = c.getContext("2d"); g.fillStyle = shThemeVar("--panel") || "#151A21"; g.fillRect(0, 0, c.width, c.height); g.drawImage(canvas, 0, 0);
      c.toBlob((bl) => res(bl), "image/png");
    } catch (_) { res(null); }
  });
}
// The chart card: caption facts as label/value lines, the PNG held beside it — never serialised;
// cardPost uploads it into the thread and sends its id.
function shChartCard(o) {
  if (!o || !o.png) return null;
  const m = shMarket(o.coin);
  let url = ""; try { url = URL.createObjectURL(o.png); } catch (_) {}
  return { v: 1, kind: "chart", view: o.view || "charts", title: shClip(o.title, 48), scope: scopeOf(), tf: shClip(o.tf || "", 8),
    coin: m.coin, t: m.t, px: m.px, cols: [{ k: "v", l: "value" }], rows: (o.rows || []).slice(0, 8), at: Date.now(), _png: o.png, _url: url, _name: o.name || "chart.png" };
}

// ---- rendering ---------------------------------------------------------------------------------
const cardWhen = (ts) => { try { return new Date(ts).toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit", hour12: false }); } catch (_) { return ""; } };
const cardTitle = (card) => card.kind === "cell" ? esc(card.t) + " <span class=\"sec\">" + esc(card.cols[0].l) + "</span>"
  : card.kind === "row" ? esc(card.t) + " <span class=\"sec\">row</span>"
  : card.kind === "panel" || card.kind === "chart" ? (card.t ? esc(card.t) + " " : "") + "<span class=\"sec\">" + esc(card.title || "") + "</span>"
  : "screen <span class=\"sec\">" + card.rows.length + " row" + (card.rows.length === 1 ? "" : "s") + "</span>";
// Where "open" goes: a board card opens its board, a drawer card the drawer, a chart the Charts tab.
const VIEW_NAME = { markets: "screener", drawer: "drawer", charts: "Charts", trend: "Trend", actionable: "Actionable", sectors: "Sectors", drawdown: "Drawdown", funding: "Funding" };
const cardOpenLbl = (card) => (card.view === "drawer" ? "open the drawer ↗" : "open in " + (VIEW_NAME[card.view] || card.view || "screener") + " ↗");
// The live half: the same column renderer over the live row, and the mark against the stamp.
function cardNow(card) {
  if (card.kind === "screen" || !card.coin) return "";
  const r = state.rows.get(card.coin);
  if (!r || !(r.px > 0)) return "";
  const drift = card.px > 0 ? (r.px / card.px - 1) * 100 : null;
  const dtxt = drift == null ? "" : " <span class=\"" + (drift > 0 ? "pos" : drift < 0 ? "neg" : "sec") + "\">" + (drift >= 0 ? "+" : "") + drift.toFixed(2) + "%</span>";
  if (card.kind === "cell" && COL_BY_KEY[card.cols[0].k]) { const x = cellOf(COL_BY_KEY[card.cols[0].k], r); return "now <b class=\"" + esc(x.c) + "\">" + esc(x.s) + "</b> · mark " + esc(fmtPrice(r.px)) + dtxt; }
  return "now " + esc(fmtPrice(r.px)) + dtxt;
}
const cellHtml = (x) => "<span class=\"" + esc(x.c || "") + "\">" + esc(x.s) + "</span>";
// A panel body: label/value lines for one column, a table for several, and the spark redrawn from
// its numbers by the drawer's own sparkline — never a picture of it.
function panelBody(card) {
  let b;
  if (card.cols.length <= 1) {
    b = "<div class=\"plines\">" + card.rows.map((r) => "<div class=\"pl" + (r.t ? "" : " wide") + "\">" + (r.t ? "<span class=\"k\">" + esc(r.t) + "</span>" : "")
      + "<span class=\"v\">" + cellHtml(r.c[0] || { s: "", c: "" }) + "</span></div>").join("") + "</div>";
  } else {
    b = "<div class=\"tbl\"><table><thead><tr><th></th>" + card.cols.map((c) => "<th>" + esc(c.l) + "</th>").join("") + "</tr></thead><tbody>"
      + card.rows.map((r) => "<tr><td class=\"tk\"" + (r.coin ? " data-cardcoin=\"" + esc(r.coin) + "\"" : "") + ">" + esc(r.t) + "</td>" + r.c.map((x) => "<td>" + cellHtml(x) + "</td>").join("") + "</tr>").join("")
      + "</tbody></table></div>";
  }
  if (card.spark && Array.isArray(card.spark.v)) {
    const f = card.spark.v.filter((x) => x != null), up = f.length > 1 && f[f.length - 1] >= f[0];
    b += "<div class=\"pspark\">" + sparkline(card.spark.v, card.spark.z ? { zero: true, color: "var(--blue)" } : { color: up ? "var(--up)" : "var(--down)" })
      + (card.spark.l ? "<span class=\"k\">" + esc(card.spark.l) + "</span>" : "") + "</div>";
  }
  return b;
}
// A chart body: the picture the server verified as an image (in the sheet, the local raster), then
// its caption lines.
function chartBody(card, m) {
  const f = m && m.file;
  const src = f && f._src ? f._src : f && f.inline && f.id ? "/api/dm/file/" + encodeURIComponent(f.id) : "";
  const img = src ? "<a class=\"dm-img cimg\" href=\"" + esc(src) + "\" target=\"_blank\" rel=\"noopener noreferrer\"><img src=\"" + esc(src) + "\" alt=\"" + esc(card.title || "chart") + "\" loading=\"lazy\"></a>"
    : "<div class=\"sec cimg-na\">picture unavailable</div>";
  return img + (card.rows.length ? panelBody(card) : "");
}
// A screen's table. Frozen: the captured strings, with names that no longer pass struck through when
// the live set is known. Live: the columns' own renderers over the rows as they are now, with names
// new since the capture marked.
function screenTable(card, rows, live, known) {
  const cols = card.cols.map((c) => COL_BY_KEY[c.k] || null), na = "<td><span class=\"na\">—</span></td>";
  const body = live
    ? rows.map((r) => { const nw = !known.has(r.coin);
      return "<tr" + (nw ? " class=\"nw\"" : "") + "><td class=\"tk\" data-cardcoin=\"" + esc(r.coin) + "\">" + esc(r.ticker || r.coin) + (nw ? " <span class=\"nwk\">new</span>" : "") + "</td>"
        + cols.map((c) => { if (!c) return na; try { return c.td(r); } catch (_) { return na; } }).join("") + "</tr>"; }).join("")
    : card.rows.map((r) => "<tr" + (known && !known.has(r.coin) ? " class=\"gone\" title=\"no longer passes these filters\"" : "") + "><td class=\"tk\" data-cardcoin=\"" + esc(r.coin) + "\">" + esc(r.t) + "</td>"
      + r.c.map((x) => "<td>" + cellHtml(x) + "</td>").join("") + "</tr>").join("");
  return "<div class=\"tbl\"><table><thead><tr><th>Ticker</th>" + card.cols.map((c) => "<th>" + esc(c.l) + "</th>").join("") + "</tr></thead><tbody>" + body + "</tbody></table></div>";
}
function cardHtml(card, m) {
  if (!card || !card.kind) return "";
  const own = !!(m && m.mine);
  let body;
  if (card.kind === "cell") {
    const x = card.rows[0].c[0];
    body = "<div class=\"one\"><div class=\"big " + esc(x.c || "") + "\">" + esc(x.s) + "</div><div class=\"k\">" + esc(card.cols[0].l) + " · " + esc([card.scope, card.tf].filter(Boolean).join(" · ")) + "</div>"
      + (card.ctx && card.ctx.length ? "<div class=\"ctx\">" + card.ctx.map((c) => esc(c.l) + " " + cellHtml(c)).join(" · ") + "</div>" : "") + "</div>";
  } else if (card.kind === "row") {
    body = "<div class=\"kv\">" + card.cols.map((c, i) => "<div><span class=\"k\">" + esc(c.l) + "</span><span class=\"v\">" + cellHtml(card.rows[0].c[i]) + "</span></div>").join("") + "</div>";
  } else if (card.kind === "panel") {
    body = panelBody(card);
  } else if (card.kind === "chart") {
    body = chartBody(card, m);
  } else {
    const filt = card.filters || card.sort ? "<div class=\"filt\">" + esc(card.filters || "every row") + (card.sort ? " · sorted by <code>" + esc(card.sort) + "</code>" : "") + "</div>" : "";
    if (card.live && card.q) {
      // Live (build 2026.09.24-98): re-run on every paint of the card, over the snapshot this viewer
      // holds now; the capture stays underneath, labelled as what was shared.
      const live = screenRun(card.q), was = new Set(card.rows.map((r) => r.coin)), pass = new Set(live.map((r) => r.coin));
      const kept = card.rows.filter((r) => pass.has(r.coin)).length;
      body = filt + "<div class=\"lvh\"><b>live</b> · now · " + live.length + " pass · " + kept + " of " + card.rows.length + " from the capture still pass</div>"
        + (live.length ? screenTable(card, live.slice(0, SCREEN_MAX_ROWS), true, was) : "<div class=\"sec lvnone\">nothing passes these filters right now</div>")
        + "<div class=\"lvh asw\">as shared · " + esc(cardWhen(card.at)) + "</div>" + screenTable(card, null, false, pass);
    } else body = filt + screenTable(card, null, false, null);
  }
  let now = cardNow(card);
  // Any screen that carried its filters can say how many of its rows still pass: cheap, and the
  // first question the room asks of an old screen.
  if (card.kind === "screen" && card.q && !card.live) { const pass = new Set(screenRun(card.q).map((r) => r.coin)); now = card.rows.filter((r) => pass.has(r.coin)).length + " of " + card.rows.length + " still pass"; }
  const more = (card.kind === "screen" || card.kind === "panel") && card.total > card.rows.length ? " · " + card.rows.length + " of " + card.total : "";
  const chip = card.kind === "panel" ? String(VIEW_NAME[card.view] || card.view || "panel").toLowerCase() : card.live ? "live screen" : card.kind;
  return "<div class=\"dm-card" + (own ? " out" : "") + "\">"
    + "<div class=\"chd\"><span class=\"ck\">⤴</span><span class=\"tk\">" + cardTitle(card) + "</span><span class=\"mk-chip\">" + esc(chip) + "</span>"
    + "<span class=\"at\">captured " + esc(cardWhen(card.at)) + (card.px > 0 ? " · mark " + esc(fmtPrice(card.px)) : "") + more + "</span></div>"
    + body
    + "<div class=\"cft\"><button type=\"button\" class=\"dm-tool\" data-cardopen=\"" + (m && m.id != null ? m.id : "") + "\">" + esc(cardOpenLbl(card)) + "</button>"
    + (now ? "<span class=\"now\">" + now + "</span>" : "") + "</div></div>";
}
function cardOpen(card) {
  const v = card && card.view;
  // A drawer card opens the drawer where you are; a board card its board (and the name's drawer when
  // it names one); a chart the Charts tab; the screener kinds the screener, as before.
  if (v !== "drawer") showView(v && HASH_VIEWS.has(v) ? v : "markets");
  if (v !== "charts" && card && card.coin && state.rows.get(card.coin)) openDetail(card.coin);
}
// Re-capture is the screener's: its cells re-render from COL_BY_KEY by address. A panel was read off a
// surface's DOM and a chart off its pixels, so those are shared again from where they live.
const cardCanRecapture = (card) => !!card && (card.kind === "cell" || card.kind === "row" || card.kind === "screen");
// A fresh card of the same address: same coin(s), same columns, live values, new capture time.
function cardRecapture(card) {
  if (!cardCanRecapture(card)) return null;
  if (card.kind === "cell") return captureCell(card.coin, card.cols[0].k);
  const cols = card.cols.map((c) => COL_BY_KEY[c.k]).filter(Boolean);
  if (card.kind === "row") return captureRow(card.coin, cols);
  const rows = card.rows.map((r) => state.rows.get(r.coin)).filter(Boolean);
  const out = captureScreen(rows, cols);
  if (out) { out.filters = card.filters || ""; out.sort = card.sort || ""; out.total = rows.length; out.q = card.q || null; out.live = !!card.live; }
  return out;
}

// ---- posting -----------------------------------------------------------------------------------
// The wire copy: every client-only field (the PNG, its preview URL) starts with "_" and stays here.
function cardWire(card) { const o = {}; for (const k of Object.keys(card || {})) if (k[0] !== "_") o[k] = card[k]; return o; }
async function cardUpload(thread, blob, name) {
  const b64 = await new Promise((res) => { try { const fr = new FileReader(); fr.onload = () => { const s = String(fr.result || ""); res(s.slice(s.indexOf(",") + 1)); }; fr.onerror = () => res(null); fr.readAsDataURL(blob); } catch (_) { res(null); } });
  if (b64 == null) return { ok: false, error: "could not read the chart image" };
  try {
    const r = await fetch("/api/dm/upload", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ thread, name, data: b64 }) });
    const d = await r.json().catch(() => ({}));
    return r.ok && d.ok ? { ok: true, id: d.file.id } : { ok: false, error: d.error || "upload failed" };
  } catch (_) { return { ok: false, error: "upload failed" }; }
}
async function cardPost(card, target, note, call) {
  // A chart's picture has to belong to the thread before its caption can name it (the order /ratio
  // uses), so a chart goes to an existing conversation; the sheet lists only those for it.
  let fileId = null;
  if (card && card._png) {
    if (!target || !target.thread) return { ok: false, d: { error: "a chart goes to an existing conversation" } };
    const up = await cardUpload(target.thread, card._png, card._name || "chart.png");
    if (!up.ok) return { ok: false, d: { error: up.error } };
    fileId = up.id;
  }
  const body = Object.assign({ card: cardWire(card), body: note || "", call: !!call }, fileId ? { fileId } : {}, target && target.thread ? { thread: target.thread } : { to: target && target.to || "" });
  try {
    const r = await fetch("/api/dm", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    const d = await r.json().catch(() => ({}));
    return { ok: r.ok && d && d.ok !== false, d };
  } catch (e) { return { ok: false, d: { error: e && e.message || "network" } }; }
}

// ---- the sheet ---------------------------------------------------------------------------------
// Opens at the side, like the drawer; the preview IS the card the room will see. Three questions
// only: which grain (answered by where you clicked), to whom, any words.
let sheet = null, cur = null, targets = null, picked = null;
function sheetEl() {
  if (sheet) return sheet;
  sheet = document.createElement("aside");
  sheet.className = "share-sheet"; sheet.id = "sharesheet"; sheet.setAttribute("role", "dialog"); sheet.setAttribute("aria-label", "Share to chat"); sheet.hidden = true;
  const bg = document.createElement("div"); bg.className = "share-bg"; bg.id = "sharebg"; bg.hidden = true;
  bg.addEventListener("click", shareClose);
  document.body.appendChild(bg); document.body.appendChild(sheet);
  sheet.addEventListener("click", (e) => {
    if (e.target.closest("#sh-close")) { shareClose(); return; }
    const row = e.target.closest("[data-shto]");
    if (row) { picked = row.dataset.shto; renderSheet(); return; }
    if (e.target.closest("#sh-send")) { shareSend(); return; }
  });
  sheet.addEventListener("input", (e) => { if (e.target.id === "sh-q") renderTargets(); });
  sheet.addEventListener("change", (e) => { if (e.target.id === "sh-live" && cur) { cur.live = !!e.target.checked && !!cur.q; renderSheet(); } });
  return sheet;
}
function shareClose() { if (!sheet) return; sheet.hidden = true; el("sharebg").hidden = true; overlayPop("share"); if (cur && cur._url) { try { URL.revokeObjectURL(cur._url); } catch (_) {} } cur = null; }
async function shareOpen(card) {
  // A chart is rasterised before it can be previewed, so its capture hands back a promise.
  if (card && typeof card.then === "function") { try { card = await card; } catch (_) { card = null; } }
  if (!card) { pushToast("nothing to share here"); return; }
  cur = card; picked = picked || null;
  const s = sheetEl(); s.hidden = false; el("sharebg").hidden = false;
  overlayPush("share", shareClose);
  renderSheet();
  try {
    const d = await fetchJSON("/api/dm");
    if (d && d.ok) {
      targets = (d.threads || []).filter((t) => !t.hidden).sort((a, b) => (b.lastAt || 0) - (a.lastAt || 0))
        .map((t) => ({ id: "t:" + t.id, thread: t.id, name: t.name, kind: t.kind, last: t.lastAt || 0 }))
        .concat((d.members || []).filter((m) => !(d.threads || []).some((t) => t.kind === "dm" && t.peer === m.uid)).map((m) => ({ id: "u:" + m.uid, to: m.uid, name: m.display, kind: "new" })));
      // A pick from an earlier open only survives if it is still listed; otherwise the freshest conversation.
      if (!targets.some((t) => t.id === picked)) picked = targets.length ? targets[0].id : null;
    } else targets = [];
  } catch (_) { targets = []; }
  renderSheet();
  const q = el("sh-q"); if (q) q.focus();
}
function renderTargets() {
  const box = el("sh-list"); if (!box) return;
  const q = (el("sh-q") && el("sh-q").value || "").trim().toLowerCase();
  if (targets == null) { box.innerHTML = "<div class=\"sec\" style=\"font-size:var(--fs-sm);padding:6px 4px\">loading conversations…</div>"; return; }
  const list = targets.filter((t) => (!q || t.name.toLowerCase().includes(q)) && !(cur && cur._png && !t.thread));
  box.innerHTML = list.length ? list.slice(0, 40).map((t) => "<div class=\"torow" + (t.id === picked ? " on" : "") + "\" data-shto=\"" + esc(t.id) + "\">"
    + "<span class=\"nm" + (t.kind === "group" || t.kind === "board" ? " grp" : "") + "\">" + (t.kind === "group" || t.kind === "board" ? "# " : "") + esc(t.name) + "</span>"
    + "<span class=\"last\">" + (t.kind === "new" ? "new conversation" : t.kind) + "</span></div>").join("")
    : "<div class=\"sec\" style=\"font-size:var(--fs-sm);padding:6px 4px\">" + (targets.length ? "no match" : "sign in to Messages first") + "</div>";
}
function renderSheet() {
  const s = sheetEl(); if (!cur) return;
  if (!s.querySelector("#sh-prev")) {
    s.innerHTML = "<div class=\"shd\"><span class=\"ck\">⤴</span> Share <b id=\"sh-what\"></b><button type=\"button\" class=\"btn xtiny\" id=\"sh-close\" title=\"close\">✕</button></div>"
      + "<p class=\"prevlbl\">what the room will see</p><div id=\"sh-prev\"></div>"
      + "<p class=\"prevlbl\" style=\"margin-top:12px\">to</p><input type=\"text\" id=\"sh-q\" placeholder=\"search people and rooms\" autocomplete=\"off\"><div class=\"tolist\" id=\"sh-list\"></div>"
      + "<p class=\"prevlbl\" style=\"margin-top:10px\">say something (optional)</p><textarea id=\"sh-note\" placeholder=\"why this is worth a look — $TICKER stamps the price like any message\"></textarea>"
      + "<div class=\"opts\"><label id=\"sh-call-l\"><input type=\"checkbox\" id=\"sh-call\" checked> quote as a call (enters the calls record)</label>"
      + "<label id=\"sh-live-l\"><input type=\"checkbox\" id=\"sh-live\"> live — re-run these filters for whoever opens it (the table stays, as shared)</label></div>"
      + "<div class=\"sendrow\"><span class=\"sec\" id=\"sh-size\"></span><button type=\"button\" class=\"btn primary\" id=\"sh-send\">send ⤴</button></div>";
  }
  el("sh-what").textContent = cur.kind === "cell" ? cur.t + " · " + cur.cols[0].l : cur.kind === "row" ? cur.t + " · the row"
    : cur.kind === "panel" || cur.kind === "chart" ? (cur.t ? cur.t + " · " : "") + cur.title : "a screen · " + cur.rows.length + " row" + (cur.rows.length === 1 ? "" : "s");
  el("sh-prev").innerHTML = cardHtml(cur, { mine: true, file: cur._url ? { _src: cur._url, inline: true } : null });
  el("sh-call-l").hidden = cur.kind === "screen" || !cur.t;
  // Live is a screen's option, and only for a screen that carried its filters as data.
  const lv = el("sh-live"), lvl = el("sh-live-l");
  lvl.hidden = cur.kind !== "screen";
  lv.disabled = !cur.q; lv.checked = !!(cur.q && cur.live);
  lvl.title = cur.q ? "" : "this screen leans on your own \u2605 / noted / held list (or a drill too big to carry) \u2014 it can't re-run for anyone else";
  el("sh-size").textContent = "card · " + (Math.round(JSON.stringify(cardWire(cur)).length / 100) / 10) + " KB"
    + (cur._png ? " + picture " + Math.max(1, Math.round(cur._png.size / 1024)) + " KB · existing conversations only" : "");
  renderTargets();
}
async function shareSend() {
  if (!cur) return;
  const t = (targets || []).find((x) => x.id === picked);
  if (!t) { pushToast("pick a conversation first"); return; }
  const btn = el("sh-send"); if (btn) btn.disabled = true;
  const r = await cardPost(cur, t, el("sh-note").value, cur.kind !== "screen" && !!cur.t && el("sh-call").checked);
  if (btn) btn.disabled = false;
  if (!r.ok) { pushToast("✗ " + ((r.d && r.d.error) || "could not share that")); return; }
  pushToast("⤴ shared to " + (t.kind === "group" || t.kind === "board" ? "#" : "") + t.name);
  el("sh-note").value = "";
  shareClose();
}

// ---- the screener: one floating glyph, a context menu, and the keyboard ---------------------------
// Nothing is drawn at rest. Hovering a data cell floats the glyph at its corner (that field);
// hovering the ticker cell floats it after the star (the row). Right-click names all three grains
// with the exact thing under the cursor. With a row focused, `s` shares it.
function shareWireTable(body, cols) {
  const fly = document.createElement("button"); fly.type = "button"; fly.className = "shr-fly"; fly.hidden = true; fly.textContent = "⤴"; fly.title = "share to chat";
  document.body.appendChild(fly);
  const menu = document.createElement("div"); menu.className = "shr-menu"; menu.hidden = true; document.body.appendChild(menu);
  let at = null;   // { coin, key|null }
  const keyOf = (td) => { const tr = td.parentElement; const i = [...tr.children].indexOf(td); const c = cols()[i]; return c ? c.key : null; };
  const place = (td) => {
    const key = keyOf(td); if (key == null) { fly.hidden = true; return; }
    at = { coin: td.parentElement.dataset.coin, key: key === "ticker" ? null : (SKIP_COLS.has(key) ? undefined : key) };
    if (at.key === undefined) { fly.hidden = true; return; }
    const b = td.getBoundingClientRect();
    fly.style.left = (b.right - 18) + "px"; fly.style.top = (b.top + 2) + "px";
    fly.title = at.key ? "share " + at.coin.replace(/^xyz:/, "") + " · " + (COL_BY_KEY[at.key] || {}).label + " to chat" : "share this row to chat";
    fly.hidden = false;
  };
  body.addEventListener("mouseover", (e) => { const td = e.target.closest("td"); const tr = td && td.closest("tr[data-coin]"); if (!tr || !body.contains(tr)) { return; } place(td); });
  body.addEventListener("mouseleave", () => { fly.hidden = true; });
  document.addEventListener("scroll", () => { fly.hidden = true; }, true);
  fly.addEventListener("mouseenter", () => { fly.hidden = false; });
  fly.addEventListener("click", (e) => { e.stopPropagation(); if (!at) return; shareOpen(at.key ? captureCell(at.coin, at.key) : captureRow(at.coin)); fly.hidden = true; });
  body.addEventListener("keydown", (e) => {
    if (e.key !== "s" && e.key !== "S") return;
    const tr = e.target.closest && e.target.closest("tr[data-coin]");
    if (!tr || e.target.matches("input,textarea")) return;
    e.preventDefault(); shareOpen(captureRow(tr.dataset.coin));
  });
  body.addEventListener("contextmenu", (e) => {
    const td = e.target.closest("td"), tr = td && td.closest("tr[data-coin]"); if (!tr) return;
    e.preventDefault();
    const key = keyOf(td), coin = tr.dataset.coin, cell = key && !SKIP_COLS.has(key) ? key : null;
    const tk = coin.replace(/^xyz:/, "");
    menu.innerHTML = (cell ? "<button type=\"button\" data-g=\"cell\">Share this cell <span class=\"k\">" + esc(tk + " · " + (COL_BY_KEY[cell] || {}).label) + "</span></button>" : "")
      + "<button type=\"button\" data-g=\"row\">Share the row <span class=\"k\">" + esc(tk) + "</span></button><div class=\"sep\"></div>"
      + "<button type=\"button\" data-g=\"screen\">Share this screen <span class=\"k\">" + Math.min(SCREEN_MAX_ROWS, source().rows.length) + (source().rows.length > SCREEN_MAX_ROWS ? " of " + source().rows.length : "") + " rows</span></button>";
    menu.dataset.coin = coin; menu.dataset.key = cell || "";
    const w = 260, x = Math.min(e.clientX, window.innerWidth - w - 8), y = Math.min(e.clientY, window.innerHeight - 140);
    menu.style.left = x + "px"; menu.style.top = y + "px"; menu.hidden = false;
  });
  menu.addEventListener("click", (e) => {
    const b = e.target.closest("button[data-g]"); if (!b) return;
    menu.hidden = true;
    const g = b.dataset.g, coin = menu.dataset.coin, key = menu.dataset.key;
    shareOpen(g === "cell" ? captureCell(coin, key) : g === "row" ? captureRow(coin) : captureScreen());
  });
  document.addEventListener("click", (e) => { if (!e.target.closest(".shr-menu")) menu.hidden = true; });
  document.addEventListener("keydown", (e) => { if (e.key === "Escape") menu.hidden = true; });
}

// ---- every other surface: the same glyph, the same menu (build 2026.09.24-98) --------------------
// One floating glyph and one menu for every board and the drawer, made on first use. A board row
// floats the glyph at the row's right edge (the row); right-click names the row and the board. A
// drawer section floats it on its header (the section). `o.capture(node)` replaces the DOM reader
// for a surface drawn as a picture (the funding heatmap is an SVG, not a table).
let bFly = null, bMenu = null, bAt = null;
function boardUi() {
  if (bFly) return;
  bFly = document.createElement("button"); bFly.type = "button"; bFly.className = "shr-fly"; bFly.hidden = true; bFly.textContent = "⤴";
  bMenu = document.createElement("div"); bMenu.className = "shr-menu"; bMenu.hidden = true;
  document.body.appendChild(bFly); document.body.appendChild(bMenu);
  bFly.addEventListener("mouseenter", () => { bFly.hidden = false; });
  bFly.addEventListener("click", (e) => { e.stopPropagation(); const a = bAt; bFly.hidden = true; if (a) shareOpen(a.o.capture ? a.o.capture(a.node) : captureBoardRow(a.node, a.o)); });
  bMenu.addEventListener("click", (e) => {
    const b = e.target.closest("button[data-g]"); if (!b || !bAt) return;
    bMenu.hidden = true;
    const a = bAt;
    shareOpen(b.dataset.g === "board" ? captureBoard(a.node, a.o) : a.o.capture ? a.o.capture(a.node) : captureBoardRow(a.node, a.o));
  });
  document.addEventListener("click", (e) => { if (!e.target.closest(".shr-menu")) bMenu.hidden = true; });
  document.addEventListener("keydown", (e) => { if (e.key === "Escape") bMenu.hidden = true; });
  document.addEventListener("scroll", () => { bFly.hidden = true; }, true);
}
function shareWireBoard(root, o) {
  if (!root) return;
  const opts = () => Object.assign({}, o, { title: typeof o.title === "function" ? o.title() : o.title });
  root.addEventListener("mouseover", (e) => {
    const n = e.target.closest(o.rowSel); if (!n || !root.contains(n)) return;
    boardUi();
    bAt = { node: n, o: opts() };
    // A header with controls at its right (the candles' timeframe segment) takes the glyph before them.
    const b = n.getBoundingClientRect(), ctl = n.querySelector ? n.querySelector("button,.cdtf-seg") : null;
    const right = ctl ? ctl.getBoundingClientRect().left - 4 : b.right;
    bFly.style.left = (right - 18) + "px"; bFly.style.top = (b.top + Math.max(0, (b.height - 16) / 2)) + "px";
    bFly.title = o.section ? "share this section to chat" : "share this row to chat";
    bFly.hidden = false;
  });
  root.addEventListener("mouseleave", () => { if (bFly) bFly.hidden = true; });
  if (o.section) return;   // a section is shared by its glyph; the drawer keeps the browser's own right-click
  root.addEventListener("contextmenu", (e) => {
    const n = e.target.closest(o.rowSel); if (!n || !root.contains(n)) return;
    e.preventDefault(); boardUi();
    bAt = { node: n, o: opts() };
    const tr = n.tagName === "TR" ? n : null, table = tr && tr.closest("table");
    const nRows = table ? table.querySelectorAll(o.rowSel).length : 0;
    const lbl = tr ? shRowLabel(tr) : shClip(n.textContent, 16);
    bMenu.innerHTML = "<button type=\"button\" data-g=\"row\">Share the row <span class=\"k\">" + esc(lbl) + "</span></button>"
      + (tr ? "<div class=\"sep\"></div><button type=\"button\" data-g=\"board\">Share this board <span class=\"k\">" + Math.min(PANEL_MAX_ROWS, nRows) + (nRows > PANEL_MAX_ROWS ? " of " + nRows : "") + " rows</span></button>" : "");
    const w = 260, x = Math.min(e.clientX, window.innerWidth - w - 8), y = Math.min(e.clientY, window.innerHeight - 110);
    bMenu.style.left = x + "px"; bMenu.style.top = y + "px"; bMenu.hidden = false;
  });
}
// The drawer: every section header, one glyph.
function shareWireDrawer(root) { shareWireBoard(root, { view: "drawer", title: "", rowSel: SH_SEC, section: true, capture: captureDrawerSection }); }

// ---- the composer: /share ----------------------------------------------------------------------
//   /share HOOD            the row      /share HOOD funding    one cell
//   /share screen          what the table shows now (first 25 rows, first 8 columns)
const FIELD_ALIAS = { price: "px", mark: "px", fund: "funding", apr: "funding", volume: "vol", "1d": "d1", "24h": "d1", "7d": "d7", "30d": "d30", "1h": "h1", "4h": "h4", squeeze: "sqz", ma200: "ma200", "200ma": "ma200" };
function shareCommand(line) {
  const p = String(line || "").trim().split(/\s+/).filter(Boolean);
  const a = (p[0] || "").toLowerCase();
  if (!a || a === "help") return { help: true, text: "/share <ticker> — the row · /share <ticker> <column> — one cell (e.g. /share HOOD funding) · /share screen — the table as it is now" };
  if (a === "screen" || a === "table") { const c = captureScreen(); return c ? { card: c } : { error: "the table is empty" }; }
  const tk = a.replace(/^\$/, "").toUpperCase();
  const r = [...state.rows.values()].find((x) => String(x.ticker || "").toUpperCase() === tk) || [...state.rows.values()].find((x) => String(x.coin || "").toUpperCase() === tk || String(x.coin || "").toUpperCase() === "XYZ:" + tk);
  if (!r) return { error: "no market called " + tk + " on the board" };
  if (p.length < 2) { const c = captureRow(r.coin); return c ? { card: c } : { error: "no columns on screen" }; }
  const f = p.slice(1).join(" ").toLowerCase().replace(/[^a-z0-9]/g, "");
  const key = COL_BY_KEY[f] ? f : (FIELD_ALIAS[f] && COL_BY_KEY[FIELD_ALIAS[f]] ? FIELD_ALIAS[f] : Object.keys(COL_BY_KEY).find((k) => String(COL_BY_KEY[k].label || "").toLowerCase().replace(/[^a-z0-9]/g, "") === f));
  if (!key || SKIP_COLS.has(key)) return { error: "no column called “" + p.slice(1).join(" ") + "” — try funding, rvol, d7, oi, vsma200" };
  const c = captureCell(r.coin, key);
  return c ? { card: c } : { error: "could not read that cell" };
}

export { captureBoard, captureBoardRow, captureCell, captureDrawerSection, captureRow, captureScreen, cardCanRecapture, cardHtml, cardOpen, cardPost, cardRecapture, cardWire, screenQuery, screenRun, shCanvasPng, shChartCard, shPanel, shSvgPng, shSvgResolve, shThemeVar, shareCommand, shareOpen, shareSetSource, shareWireBoard, shareWireDrawer, shareWireTable };
