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
import { pushToast } from "./alerts.js";
import { showView } from "./backtest.js";
import { COL_BY_KEY, el, esc, fmtPrice, overlayPop, overlayPush, state } from "./core.js";
import { fetchJSON } from "./data.js";
import { openDetail } from "./drawer.js";

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
    total: src.rows.length, at: Date.now() };
}

// ---- rendering ---------------------------------------------------------------------------------
const cardWhen = (ts) => { try { return new Date(ts).toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit", hour12: false }); } catch (_) { return ""; } };
const cardTitle = (card) => card.kind === "cell" ? esc(card.t) + " <span class=\"sec\">" + esc(card.cols[0].l) + "</span>"
  : card.kind === "row" ? esc(card.t) + " <span class=\"sec\">row</span>" : "screen <span class=\"sec\">" + card.rows.length + " row" + (card.rows.length === 1 ? "" : "s") + "</span>";
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
  } else {
    body = (card.filters || card.sort ? "<div class=\"filt\">" + esc(card.filters || "every row") + (card.sort ? " · sorted by <code>" + esc(card.sort) + "</code>" : "") + "</div>" : "")
      + "<div class=\"tbl\"><table><thead><tr><th>Ticker</th>" + card.cols.map((c) => "<th>" + esc(c.l) + "</th>").join("") + "</tr></thead><tbody>"
      + card.rows.map((r) => "<tr><td class=\"tk\" data-cardcoin=\"" + esc(r.coin) + "\">" + esc(r.t) + "</td>" + r.c.map((x) => "<td>" + cellHtml(x) + "</td>").join("") + "</tr>").join("") + "</tbody></table></div>";
  }
  const now = cardNow(card);
  const more = card.kind === "screen" && card.total > card.rows.length ? " · " + card.rows.length + " of " + card.total : "";
  return "<div class=\"dm-card" + (own ? " out" : "") + "\">"
    + "<div class=\"chd\"><span class=\"ck\">⤴</span><span class=\"tk\">" + cardTitle(card) + "</span><span class=\"mk-chip\">" + esc(card.kind) + "</span>"
    + "<span class=\"at\">captured " + esc(cardWhen(card.at)) + (card.px > 0 ? " · mark " + esc(fmtPrice(card.px)) : "") + more + "</span></div>"
    + body
    + "<div class=\"cft\"><button type=\"button\" class=\"dm-tool\" data-cardopen=\"" + (m && m.id != null ? m.id : "") + "\">open in screener ↗</button>"
    + (now ? "<span class=\"now\">" + now + "</span>" : "") + "</div></div>";
}
function cardOpen(card) {
  showView("markets");
  if (card && card.coin && state.rows.get(card.coin)) openDetail(card.coin);
}
// A fresh card of the same address: same coin(s), same columns, live values, new capture time.
function cardRecapture(card) {
  if (!card) return null;
  if (card.kind === "cell") return captureCell(card.coin, card.cols[0].k);
  const cols = card.cols.map((c) => COL_BY_KEY[c.k]).filter(Boolean);
  if (card.kind === "row") return captureRow(card.coin, cols);
  const rows = card.rows.map((r) => state.rows.get(r.coin)).filter(Boolean);
  const out = captureScreen(rows, cols);
  if (out) { out.filters = card.filters || ""; out.sort = card.sort || ""; out.total = rows.length; }
  return out;
}

// ---- posting -----------------------------------------------------------------------------------
async function cardPost(card, target, note, call) {
  const body = Object.assign({ card, body: note || "", call: !!call }, target && target.thread ? { thread: target.thread } : { to: target && target.to || "" });
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
  return sheet;
}
function shareClose() { if (!sheet) return; sheet.hidden = true; el("sharebg").hidden = true; overlayPop("share"); cur = null; }
async function shareOpen(card) {
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
  if (targets == null) { box.innerHTML = "<div class=\"sec\" style=\"font-size:12px;padding:6px 4px\">loading conversations…</div>"; return; }
  const list = targets.filter((t) => !q || t.name.toLowerCase().includes(q));
  box.innerHTML = list.length ? list.slice(0, 40).map((t) => "<div class=\"torow" + (t.id === picked ? " on" : "") + "\" data-shto=\"" + esc(t.id) + "\">"
    + "<span class=\"nm" + (t.kind === "group" || t.kind === "board" ? " grp" : "") + "\">" + (t.kind === "group" || t.kind === "board" ? "# " : "") + esc(t.name) + "</span>"
    + "<span class=\"last\">" + (t.kind === "new" ? "new conversation" : t.kind) + "</span></div>").join("")
    : "<div class=\"sec\" style=\"font-size:12px;padding:6px 4px\">" + (targets.length ? "no match" : "sign in to Messages first") + "</div>";
}
function renderSheet() {
  const s = sheetEl(); if (!cur) return;
  if (!s.querySelector("#sh-prev")) {
    s.innerHTML = "<div class=\"shd\"><span class=\"ck\">⤴</span> Share <b id=\"sh-what\"></b><button type=\"button\" class=\"btn xtiny\" id=\"sh-close\" title=\"close\">✕</button></div>"
      + "<p class=\"prevlbl\">what the room will see</p><div id=\"sh-prev\"></div>"
      + "<p class=\"prevlbl\" style=\"margin-top:12px\">to</p><input type=\"text\" id=\"sh-q\" placeholder=\"search people and rooms\" autocomplete=\"off\"><div class=\"tolist\" id=\"sh-list\"></div>"
      + "<p class=\"prevlbl\" style=\"margin-top:10px\">say something (optional)</p><textarea id=\"sh-note\" placeholder=\"why this is worth a look — $TICKER stamps the price like any message\"></textarea>"
      + "<div class=\"opts\"><label id=\"sh-call-l\"><input type=\"checkbox\" id=\"sh-call\" checked> quote as a call (enters the calls record)</label></div>"
      + "<div class=\"sendrow\"><span class=\"sec\" id=\"sh-size\"></span><button type=\"button\" class=\"btn primary\" id=\"sh-send\">send ⤴</button></div>";
  }
  el("sh-what").textContent = cur.kind === "cell" ? cur.t + " · " + cur.cols[0].l : cur.kind === "row" ? cur.t + " · the row" : "a screen · " + cur.rows.length + " row" + (cur.rows.length === 1 ? "" : "s");
  el("sh-prev").innerHTML = cardHtml(cur, { mine: true });
  el("sh-call-l").hidden = cur.kind === "screen";
  el("sh-size").textContent = "card · " + (Math.round(JSON.stringify(cur).length / 100) / 10) + " KB";
  renderTargets();
}
async function shareSend() {
  if (!cur) return;
  const t = (targets || []).find((x) => x.id === picked);
  if (!t) { pushToast("pick a conversation first"); return; }
  const btn = el("sh-send"); if (btn) btn.disabled = true;
  const r = await cardPost(cur, t, el("sh-note").value, cur.kind !== "screen" && el("sh-call").checked);
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

export { cardHtml, cardOpen, cardPost, cardRecapture, captureCell, captureRow, captureScreen, shareCommand, shareOpen, shareSetSource, shareWireTable };
