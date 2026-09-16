// insiders.js — split out of the single-file client (build 2026.09.16-80). Module scope holds the
// declarations; side-effecting top-level statements run from __boot_* in the original source
// order once every module has evaluated (see app.js). Shared cross-module mutable state lives
// on G (core.js).
import { IS_ADMIN, featureOn } from "./admin.js";
import { etDayStrC } from "./calendar.js";
import { el, esc, safeHref, state } from "./core.js";
import { fetchJSON } from "./data.js";
import { openDetail } from "./drawer.js";
import { WHL, termWhaleFund, termWhaleList, termWhaleSeason, whlMoney, whlPost, whlPull, whlSgnSh, whlSh } from "./funds.js";
import { termErr, termOut, termThinking, tesc, tpad } from "./terminal.js";

let INS;   // assigned in __boot (impure initializers keep their original order)

// CONGRESS lane phase 1 (2026.08.24-02): the ENTIRE user interface for the House filing index —
// two admin verbs and the ops log. No tab, no panel, nothing public: the index is worth nothing to
// a reader until phase 2 parses transactions out of the PTR documents, and shipping a tab that only
// says "someone filed something" would be a surface to maintain in exchange for nothing.
// ===== INSIDERS tab (build 2026.08.27-38) ======================================================
// Section 16 transactions off SEC Form 4. The contrast with the CONGRESS tab next to it is the
// whole point and is stated on the footer: a PTR discloses an amount band and no price, so that
// lane can never show one; a Form 4 discloses the share count and the price per share, so every
// number here is the filer's own and nothing is derived, banded or estimated.
//
// Four capabilities, and each one is answered where it has to be answered:
//   SEARCH and SORT run in SQL over every stored transaction. Sorting the loaded page would show
//     a different "top" on every page, and searching it would scope every query to the most recent
//     few hundred rows — a name outside that window would read as "not in the tool".
//   FILTER splits: the code / plan / role / size filters are SQL (they change what the pager is
//     counting), and nothing narrows the page in the browser, so "N of M" is always true.
//   REARRANGE is local and persistent: drag a header to move a column, uncheck one to hide it.
//     The order lives on this browser, so two readers can hold different views of one dataset.
const INS_COLS = [
  { k: 'filed',  label: 'FILED',   cls: 'l', tip: 'when the filing hit EDGAR. Section 16 gives insiders two business days from the trade, so this is close to the trade date and far closer than a PTR’s 45.' },
  { k: 'traded', label: 'TRADED',  cls: 'l', tip: 'the transaction date on the form — the day the trade actually happened.' },
  { k: 'ticker', label: 'TICKER',  cls: 'l', tip: 'the issuer’s trading symbol as written on the form itself, not resolved from a name.' },
  { k: 'owner',  label: 'INSIDER', cls: 'l', tip: 'the reporting person. A joint filing is attributed to the first owner named and says so on hover — counting one trade once per filer would multiply the flow.' },
  { k: 'role',   label: 'ROLE',    cls: 'l', tip: 'the officer TITLE as filed — CEO, CFO, EVP of whatever — because the relationship boxes alone read “director/officer” for almost everyone and separate nothing. Falls back to the boxes only where the form gave no title. A 10% owner rides alongside a title: a fund over the threshold is a different actor from an executive. Sorts by title, so one person’s job groups together.' },
  { k: 'kind',   label: 'KIND',    cls: 'l', tip: 'which of the form\u2019s two tables the row came from. Table I is a SHARE transaction; Table II is a DERIVATIVE one \u2014 an option, an RSU, a convertible. They are separate tables because their columns mean different things, which is why STRIKE exists rather than a strike being written into PRICE.' },
  { k: 'act',    label: 'ACT',     cls: 'l', tip: 'the transaction CODE, which is what decides whether a row means anything. P is an open-market purchase and S an open-market sale — decisions. A (grant), M (option exercise) and F (shares withheld for tax) are compensation mechanics, not views on the price.' },
  { k: 'shares', label: 'SHARES',  cls: 'r', tip: 'share count exactly as filed.' },
  { k: 'price',  label: 'PRICE',   cls: 'r', tip: 'price per share exactly as filed. Blank where the form carried none — a footnoted weighted average or a range — which is a real and common case, never a zero.' },
  { k: 'value',  label: 'VALUE',   cls: 'r', tip: 'shares x price, computed only where a price exists. A grant prices at zero and a footnoted price is absent; both would otherwise read as a $0 trade.' },
  { k: 'strike', label: 'STRIKE',  cls: 'r', tip: 'the exercise or conversion price on a derivative row \u2014 what the insider pays per share to turn the option into stock. It is NOT a transaction price and never enters the PRICE column: the two are identically shaped fields holding different quantities, and one column holding both is a number that cannot be sorted or averaged without lying. Blank on a share row, and blank on a derivative whose strike the form footnoted.' },
  { k: 'expiry', label: 'EXPIRY',  cls: 'l', tip: 'when the derivative lapses. Turns amber inside 90 days \u2014 an option exercised weeks before it would have expired is mechanical, not a view on the price.' },
  { k: 'under',  label: 'UNDER',   cls: 'l', tip: 'what the derivative converts into, and at what ratio. One-for-one into common stock is usual and is not guaranteed; a ratio that is not 1:1 is the difference between a small position and a large one.' },
  { k: 'pct',    label: 'Δ POS', cls: 'r', tip: 'the trade as a share of the holding it left behind — how much of their own position this was. Blank unless the form carries the post-transaction figure.' },
  { k: 'own',    label: 'HOLDING', cls: 'r', tip: 'shares owned after the transaction, as reported. Direct holdings and indirect (a trust, a family LLC) are different claims and are marked D or I.' },
  { k: 'plan',   label: 'PLAN',    cls: 'l', tip: 'the Rule 10b5-1 checkbox. A sale under a pre-arranged plan was scheduled months ago and says little about today; a discretionary one is a decision taken now. THREE states: marked, not marked, and blank — the box did not exist before 2023, so blank means the form does not say, never "not a plan".' },
  { k: 'sec',    label: 'SECURITY',cls: 'l', tip: 'the class of stock as the form names it.' },
  { k: 'issuer', label: 'ISSUER',  cls: 'l', tip: 'the company name on the filing.' },
  { k: 'form',   label: 'FORM',    cls: 'l', tip: '4 is the timely report; 4/A amends one already filed. An amendment REPLACES its rows here rather than adding a second copy of the trade.' },
  { k: 'src',    label: 'SRC',     cls: 'l', tip: 'the filing itself on EDGAR — the document every number in the row was read from.' },
];
// Everything the parser knows is a column and the reader decides what to look at. Issuer name,
// security class and form type start hidden: they repeat the ticker, repeat "Common Stock" and
// read "4" on almost every row respectively.
// KIND, STRIKE, EXPIRY and UNDER start hidden because the tab opens on SHARES, where KIND is
// constant and the other three are empty. Switching the kind filter to derivatives or both reveals
// them automatically — a filter that returns rows whose defining columns are hidden is a filter
// that looks broken.
const INS_HIDE_DEFAULT = ['issuer', 'sec', 'form', 'kind', 'strike', 'expiry', 'under'];
const INS_DERIV_COLS = ['kind', 'strike', 'expiry'];
const INS_LS = 'insview';
const INS_PAGE = 50;
// The transaction codes, grouped as a reader thinks about them rather than as the form lists them.
const INS_CHIPS = [
  { k: 'P', label: 'buys', tip: 'code P — an open-market purchase. The insider chose to buy with their own money; the rarest row here and the only one that is unambiguously a view.' },
  { k: 'S', label: 'sells', tip: 'code S — an open-market sale. A decision too, but check the PLAN column: a scheduled 10b5-1 sale was set up in advance.' },
  { k: 'A', label: 'grants', tip: 'code A — shares awarded as compensation. Not a purchase and not a signal about price.' },
  { k: 'M', label: 'exercises', tip: 'code M — an option or RSU converted into shares. Mechanical, and usually paired with an S or an F the same day.' },
  { k: 'F', label: 'tax', tip: 'code F — shares handed back to the issuer to cover withholding at vest. The insider did not choose to sell these.' },
  { k: 'G', label: 'gifts', tip: 'code G — a gift. No price, no proceeds.' },
];
// The saved view: which columns, in what order, sorted how. Filters are deliberately NOT saved —
// a filter is a question being asked right now, and reopening the tab to yesterday's narrowed set
// with no memory of narrowing it is how a reader concludes the lane is empty.
function insSave() {
  try { localStorage.setItem(INS_LS, JSON.stringify({ hidden: [...INS.hidden], order: INS.order, sort: INS.sort })); } catch (_) {}
}
function insLoad() {
  try {
    const v = JSON.parse(localStorage.getItem(INS_LS) || 'null');
    if (!v) return;
    if (Array.isArray(v.hidden)) INS.hidden = new Set(v.hidden.filter(k => INS_COLS.some(c => c.k === k)));
    // A stored order is RECONCILED against the current column list, never trusted: a column added
    // in a later build must appear (at the end) rather than vanishing for everyone who ever
    // dragged a header, and one since removed must not leave a hole.
    if (Array.isArray(v.order)) {
      const known = INS_COLS.map(c => c.k);
      const kept = v.order.filter(k => known.includes(k));
      INS.order = kept.concat(known.filter(k => !kept.includes(k)));
    }
    if (v.sort && INS_COLS.some(c => c.k === v.sort.k)) INS.sort = { k: v.sort.k, dir: v.sort.dir < 0 ? -1 : 1 };
  } catch (_) {}
}
function insCols() { return INS.order.map(k => INS_COLS.find(c => c.k === k)).filter(c => c && !INS.hidden.has(c.k)); }
async function insGet(qs) { try { return await fetchJSON('/api/insiders' + (qs || '')); } catch (e) { return { ok: false, error: e.message || 'fetch failed' }; } }
async function insPost(body) {
  try { const r = await fetch('/api/insiders', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    return await r.json(); } catch (e) { return { ok: false, error: e.message || 'post failed' }; }
}
async function openInsiders() {
  const out = el('insiders-body'); if (!out) return;
  if (!INS.rows.length) out.innerHTML = '<div class="msg">reading Form 4 transactions…</div>';
  const p = ['feed=1', 'limit=' + INS_PAGE, 'offset=' + (INS.page * INS_PAGE),
    'sort=' + encodeURIComponent(INS.sort.k), 'dir=' + INS.sort.dir];
  if (INS.q.trim()) p.push('q=' + encodeURIComponent(INS.q.trim()));
  if (INS.codes.size) p.push('codes=' + [...INS.codes].join(','));
  if (INS.plan) p.push('plan=' + INS.plan);
  if (INS.role) p.push('role=' + encodeURIComponent(INS.role));
  if (INS.minValue > 0) p.push('minValue=' + INS.minValue);
  if (INS.kind) p.push('kind=' + INS.kind);
  if (INS.from) p.push('from=' + INS.from);
  if (INS.to) p.push('to=' + INS.to);
  if (INS.from || INS.to) p.push('dateOn=' + INS.dateOn);
  const r = await insGet('?' + p.join('&'));
  if (!r || !r.ok) { out.innerHTML = `<div class="msg err">${esc((r && r.error) || 'fetch failed')}</div>`; return; }
  INS.rows = r.feed || []; INS.stat = r.status || null; INS.total = r.total || 0;
  // A filter or a sort can land the reader past the end of the new result set.
  if (INS.page && !INS.rows.length && INS.total) { INS.page = Math.max(0, Math.ceil(INS.total / INS_PAGE) - 1); return openInsiders(); }
  insRender();
}
let insT = null;
function insSearch() { clearTimeout(insT); insT = setTimeout(() => { INS.page = 0; openInsiders(); }, 260); }
function insNum(v, dp) { return v == null || !isFinite(v) ? '—' : (+v).toLocaleString(undefined, { minimumFractionDigits: dp || 0, maximumFractionDigits: dp || 0 }); }
function insUsd(v) {
  if (v == null || !isFinite(v)) return '—';
  const a = Math.abs(v);
  return (v < 0 ? '-$' : '$') + (a >= 1e9 ? (a / 1e9).toFixed(2) + 'B' : a >= 1e6 ? (a / 1e6).toFixed(2) + 'M'
    : a >= 1e3 ? (a / 1e3).toFixed(1) + 'K' : a.toFixed(0));
}
// ROLE, at the specificity the form actually offers. The relationship boxes are nearly always
// "director · officer" — true of most of the roster, and therefore worth nothing to a reader. The
// officer TITLE is the field that separates a CEO buying from a VP of Sales selling, and it was
// parsed all along, sitting in a tooltip.
//
// Abbreviation is CONSERVATIVE and phrase-level: only forms whose short version is unambiguous are
// shortened, everything else rides verbatim. "Chief Security Officer" and "Chief Strategy Officer"
// both want to be CSO, so neither is touched — an invented abbreviation is worse than a long
// column. The filer's exact words are always one hover away.
const INS_TITLE_ABBR = [
  [/\bchief executive officer\b/gi, 'CEO'], [/\bchief financial officer\b/gi, 'CFO'],
  [/\bchief operating officer\b/gi, 'COO'], [/\bchief technology officer\b/gi, 'CTO'],
  [/\bchief accounting officer\b/gi, 'CAO'], [/\bchief legal officer\b/gi, 'CLO'],
  [/\bchief information officer\b/gi, 'CIO'], [/\bchief marketing officer\b/gi, 'CMO'],
  [/\bchief revenue officer\b/gi, 'CRO'], [/\bchief product officer\b/gi, 'CPO'],
  [/\bchief human resources officer\b/gi, 'CHRO'], [/\bchief compliance officer\b/gi, 'CCO'],
  [/\bexecutive vice president\b/gi, 'EVP'], [/\bsenior vice president\b/gi, 'SVP'],
  [/\bvice president\b/gi, 'VP'], [/\bprincipal (?:executive|financial|accounting) officer\b/gi, (m) => m.replace(/principal/i, 'Prin.')],
  [/\band\b/gi, '&'],
];
function insTitleShort(t) {
  let s2 = String(t || '').replace(/\s+/g, ' ').trim();
  if (!s2) return '';
  for (const [re, to] of INS_TITLE_ABBR) s2 = s2.replace(re, to);
  return s2.replace(/\s*,\s*/g, ', ').replace(/\s+/g, ' ').trim();
}
// What the cell says, and what the hover says. A 10% owner is kept alongside a title because it is
// a materially different actor — a fund crossing 5% is not an executive — while "also a director",
// which is true of most CEOs, is left to the hover rather than spent on column width.
function insRoleCell(x) {
  const boxes = String(x.role || '').split(' · ').filter(Boolean);
  const ten = boxes.includes('10% owner');
  const title = insTitleShort(x.title);
  const short = title ? (ten ? title + ' · 10%' : title)
    : (boxes.length ? boxes.map((b) => b === '10% owner' ? '10%' : b).join(' · ') : '');
  if (!short) return '<td class="l"><span class="sec" data-tip="the form ticked no relationship box and gave no title — rare, and left as unknown rather than guessed">—</span></td>';
  const tip = (x.title ? 'the title exactly as filed: “' + x.title + '”' : 'the form gave no officer title')
    + (boxes.length ? ' · boxes ticked: ' + boxes.join(', ') : '');
  const cls = 'ins-role' + (ten ? ' ten' : '') + (/\b(CEO|CFO|COO|President|Chair)\b/i.test(short) ? ' top' : '');
  return `<td class="l"><span class="${cls}" data-tip="${esc(tip)}">${esc(short.length > 26 ? short.slice(0, 25) + '…' : short)}</span></td>`;
}
// Date-range presets, resolved against the ET day — the same clock the earnings tab counts market
// days on, and the one a reader means by "today". Each returns [from, to]; an open end stays empty
// rather than being pinned to today, so "last 30 days" keeps working tomorrow without a refetch
// having to re-resolve it.
const INS_RANGES = [
  { k: '7d', label: '7d', days: 7, tip: 'the last 7 days' },
  { k: '30d', label: '30d', days: 30, tip: 'the last 30 days' },
  { k: '90d', label: '90d', days: 90, tip: 'the last 90 days — about one reporting quarter' },
  { k: 'ytd', label: 'YTD', tip: 'January 1 of the current year to today' },
  { k: '12m', label: '12m', days: 365, tip: 'the last twelve months — the depth the history walk fills by default' },
];
function insRangeFor(k) {
  const today = etDayStrC();
  if (k === 'ytd') return [today.slice(0, 4) + '-01-01', today];
  const r = INS_RANGES.find(x => x.k === k);
  if (!r || !r.days) return ['', ''];
  const d = new Date(Date.parse(today + 'T12:00:00Z') - (r.days - 1) * 86400000);
  return [d.toISOString().slice(0, 10), today];
}
// What the active range says on the tab. A range is the one filter a reader can forget they set —
// unlike a chip, two date inputs read as furniture — so it is also stated in the row count line.
function insRangeLabel() {
  if (!INS.from && !INS.to) return '';
  const on = INS.dateOn === 'filed' ? 'filed' : 'traded';
  if (INS.from && INS.to) return `${on} ${INS.from} → ${INS.to}`;
  return INS.from ? `${on} from ${INS.from}` : `${on} up to ${INS.to}`;
}
// The cashless exercise, read off two rows that each stay individually true.
//
// An M on Table II and an S on Table I, same filing, same date, same share count, is an insider
// creating shares at the strike and selling them the same day. Nothing on the form says the two
// legs are related — the SEC does not link them — so this pairing is INFERRED and is marked as
// such wherever it is shown. It matters because it changes the reading of the single largest kind
// of row on the tab: a big CEO sale is conviction, or it is compensation being converted to cash,
// and the bare Table I row cannot tell you which.
//
// The matcher declines to guess. Exact accession, exact date, exact share count, exactly one M and
// one S in that filing on that date — anything else draws nothing rather than a fuzzy brace. It
// runs over the LOADED PAGE only and is never stored: a reading aid that can be wrong without
// corrupting anything, recomputed on every render.
function insPairs(rows) {
  const by = new Map();
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i];
    if (!r || !r.acc || !r.txDate || r.shares == null) continue;
    const isM = r.kind === 'D' && r.code === 'M', isS = r.kind !== 'D' && r.code === 'S';
    if (!isM && !isS) continue;
    const k = r.acc + '|' + r.txDate + '|' + r.shares;
    let g = by.get(k); if (!g) { g = { m: [], s: [] }; by.set(k, g); }
    (isM ? g.m : g.s).push(i);
  }
  const pair = new Map();   // row index -> pair id
  let n = 0;
  for (const g of by.values()) {
    if (g.m.length !== 1 || g.s.length !== 1) continue;   // ambiguous: two exercises, or a partial — no brace
    const id = ++n;
    pair.set(g.m[0], id); pair.set(g.s[0], id);
  }
  return pair;
}
// The story line under a completed pair. Cost and proceeds are both filed figures multiplied by a
// filed share count; nothing here models tax, which the form does not carry, and it says so.
function insPairStory(mRow, sRow) {
  const sh = sRow.shares;
  const cost = mRow.strike != null ? mRow.strike * sh : null;
  const proceeds = sRow.value != null ? sRow.value : (sRow.price != null ? sRow.price * sh : null);
  const net = cost != null && proceeds != null ? proceeds - cost : null;
  const bits = [`exercised <b>${insNum(sh)}</b> @ ${mRow.strike == null ? '<span class="sec">a footnoted strike</span>' : '$' + insNum(mRow.strike, 2)}`,
    `sold <b>${insNum(sh)}</b> @ ${sRow.price == null ? '<span class="sec">a footnoted price</span>' : '$' + insNum(sRow.price, 2)}`];
  const nums = [cost != null ? `cost <b>${insUsd(cost)}</b>` : null,
    proceeds != null ? `proceeds <b>${insUsd(proceeds)}</b>` : null,
    net != null ? `net <b class="pos">${insUsd(net)}</b>` : null].filter(Boolean);
  return `<tr class="ins-story"><td class="l" colspan="99"><span class="k-story">`
    + `<b>cashless exercise</b>`
    + `<span class="k-derived" data-tip="${esc('INFERRED, not filed. The form states both legs and says nothing about their relationship — this pairing is read from a matching accession, date and share count, and is drawn over the two rows rather than replacing them. Where the counts do not match exactly, or the filing carries more than one exercise that day, no pairing is claimed. Net is proceeds minus strike cost, both filed figures; nothing here models tax, which the form does not carry.')}">inferred</span>`
    + ` · ${bits.join(' → ')}${nums.length ? ' · ' + nums.join(' · ') : ''}`
    + `<span class="sec"> · the shares did not exist that morning</span></span></td></tr>`;
}
function insRender() {
  const out = el('insiders-body'); if (!out) return;
  const st = INS.stat || {}, f = st.filings || {}, t = st.tx || {}, bf = st.backfill || {}, sc = st.scope || {};
  const shown = insCols();
  const head = `<div class="whl-head">`
    + `<span class="whl-hd">INSIDERS · SEC FORM 4</span>`
    + `<span class="cng-tag" data-tip="Section 16 officers, directors and 10% holders must report their own trades within two business days. This lane reads the ownership XML of every Form 4 the EDGAR rotation sees on the equity roster.">${(f.done || 0).toLocaleString()} filing(s) read · ${(t.n || 0).toLocaleString()} transactions · ${(t.names || 0).toLocaleString()} names</span>`
    + `<span class="whl-sp"></span>`
    + `<input id="ins-q" class="cng-in" placeholder="search — insider, ticker, issuer, title" value="${esc(INS.q)}" maxlength="60" autocomplete="off" spellcheck="false" data-tip="runs in SQL over every stored transaction, not over the loaded page. Every word must appear somewhere in the row, in any order — so “ceo intc” and “intc ceo” find the same thing.">`
    + `<button type="button" class="cng-chip" id="ins-colbtn" data-tip="show or hide columns — and drag any header to reorder. Remembered on this browser.">columns ▾</button>`
    + `</div>`
    + `<div class="cng-rates ins-filters">`
      + INS_CHIPS.map(c => `<button type="button" class="cng-chip${INS.codes.has(c.k) ? ' on' : ''}" data-inscode="${c.k}" data-tip="${esc(c.tip)}">${esc(c.label)}</button>`).join('')
      + `<span class="ins-sep"></span>`
      + [['S', 'shares'], ['D', 'derivatives'], ['', 'both']]
        .map(([v, l]) => `<button type="button" class="cng-chip${(INS.kind || '') === v ? ' on' : ''}" data-inskind="${esc(v)}" data-tip="${esc(
          v === 'S' ? 'Table I only — actual share transactions. The tab opens here.'
          : v === 'D' ? 'Table II only — options, RSUs and convertibles, with their strike and expiry. A derivative row has no share price and no dollar value: shares x strike is a number nobody paid and nobody received.'
          : 'both tables interleaved. This is where an exercise and the same-day sale it funded appear together — the pairing is only visible when both legs are in the result set.')}">${esc(l)}</button>`).join('')
      + `<span class="ins-sep"></span>`
      + [['', 'any role'], ['c-suite', 'C-suite'], ['officer', 'officers'], ['director', 'directors'], ['10%', '10% owners']]
        .map(([v, l]) => `<button type="button" class="cng-chip${INS.role === v ? ' on' : ''}" data-insrole="${esc(v)}" data-tip="${esc(
          v === 'c-suite' ? 'rows whose filed TITLE names a chief officer, a president or a chair — matched on the filer’s own words, so a title written in some other way is not in this bucket. Officers with any other title are under “officers”.'
          : v ? 'only rows where the form ticked ' + l : 'no role filter')}">${esc(l)}</button>`).join('')
      + `<span class="ins-sep"></span>`
      + [['', 'plan: any'], ['excl', 'discretionary'], ['only', '10b5-1 only']]
        .map(([v, l]) => `<button type="button" class="cng-chip${(INS.plan || '') === v ? ' on' : ''}" data-insplan="${esc(v)}" data-tip="${esc(v === 'only' ? 'only rows whose 10b5-1 box is ticked — scheduled in advance' : v === 'excl' ? 'rows NOT marked as plan sales. Includes rows where the box is absent entirely (filings before 2023 had no box), so this is “not marked” rather than a proven discretionary trade.' : 'no plan filter')}">${esc(l)}</button>`).join('')
      + `<span class="ins-sep"></span>`
      + [[0, 'any size'], [100000, '≥$100K'], [1000000, '≥$1M'], [10000000, '≥$10M']]
        .map(([v, l]) => `<button type="button" class="cng-chip${INS.minValue === v ? ' on' : ''}" data-insmin="${v}" data-tip="${esc(v ? 'rows worth at least ' + l.slice(1) + '. A row with no price on the form has no value and is excluded by any size filter — it is not counted as zero.' : 'no size filter')}">${esc(l)}</button>`).join('')
    + `</div>`
    + `<div class="cng-rates ins-filters ins-dates">`
      + `<span class="ins-dlbl" data-tip="a Form 4 carries TWO dates and they are not the same: when the trade happened, and when EDGAR published it. Section 16 allows two business days, so they usually sit close — but a 4/A amending an old trade, or a Form 5 annual catch-up, can put months between them. The range says which one it applies to rather than picking for you.">date range on</span>`
      + [['traded', 'traded'], ['filed', 'filed']].map(([v, l]) =>
          `<button type="button" class="cng-chip${INS.dateOn === v ? ' on' : ''}" data-insdon="${v}" data-tip="${esc(v === 'traded'
            ? 'the transaction date on the form — when the insider actually traded. The default: “insider buying in August” is a statement about when people traded.'
            : 'when the filing reached EDGAR — when the market could first have known. Closer to the congress tab’s convention, and the one to use if you are studying reaction to disclosure.')}">${esc(l)}</button>`).join('')
      + `<span class="ins-sep"></span>`
      + INS_RANGES.map(r => `<button type="button" class="cng-chip${INS.preset === r.k ? ' on' : ''}" data-insrange="${r.k}" data-tip="${esc(r.tip)}">${esc(r.label)}</button>`).join('')
      + `<span class="ins-sep"></span>`
      + `<input type="date" id="ins-from" class="cng-in ins-date" value="${esc(INS.from)}" max="9999-12-31" data-tip="start of the range, inclusive. Leave empty for no lower bound.">`
      + `<span class="sec" style="font-size:11px">→</span>`
      + `<input type="date" id="ins-to" class="cng-in ins-date" value="${esc(INS.to)}" max="9999-12-31" data-tip="end of the range, inclusive — a row filed at 21:00 on the end date is in it.">`
      + ((INS.from || INS.to) ? `<button type="button" class="cng-chip on" id="ins-dclear" data-tip="clear the range">${esc(insRangeLabel())} ✕</button>` : '')
    + `</div>`
    // Depth, stated. Until the history walk has run, this tab holds only what the EDGAR rotation
    // happened to see since the lane deployed — which looks identical to "this insider has not
    // traded" unless the tab says otherwise.
    + (bf.busy ? `<div class="cng-rates"><span class="cng-warn" data-tip="one SEC submissions read per roster name, then the queued filings drain through the same parse tick. The table fills as it goes.">walking filing history — ${(bf.progress && bf.progress.names) || 0}/${(bf.progress && bf.progress.of) || 0} name(s), ${(bf.progress && bf.progress.added) || 0} new filing(s) queued</span></div>`
      : !bf.done ? `<div class="cng-rates"><span class="cng-warn" data-tip="EDGAR's per-company feed serves a name's 20 most recent filings of any type, so on a fresh deploy this lane holds only what has been filed since — not a name's history. The one-off walk that fixes it reads the SEC submissions index per roster name. Admin terminal: insiders backfill">history not walked yet — this is filings seen since deploy, not a full year</span></div>` : '')
    + (f.queued || f.failed || t.noPrice || f.noSym || sc.offUni ? `<div class="cng-rates">`
      + (f.queued ? `<span data-tip="Form 4s the EDGAR rotation has found but this lane has not read yet. Worked one per tick; forceable from the admin panel.">queued <b>${(f.queued || 0).toLocaleString()}</b></span>` : '')
      + (f.failed ? `<span data-tip="filings whose ownership document could not be read. The reason is kept per filing rather than collapsed into a count you would have to trust.">unreadable <b>${(f.failed || 0).toLocaleString()}</b></span>` : '')
      + (sc.offUni ? `<span data-tip="transactions this lane holds for issuers the board does not cover, and does not show. A Form 4 is associated with every CIK on it, so a 10% holder&#39;s own submissions feed carries filings about the companies it HOLDS — Volkswagen&#39;s stake in a listed name, a fund&#39;s in a dozen others. They are real and correctly read; they are simply not about anything on this board, and they cannot open a drawer or a chart here. Scoped at read time, so a name added to the universe shows the history already stored for it without re-fetching a document.">off-board <b>${(sc.offUni || 0).toLocaleString()}</b></span>` : '')
      + (f.noSym ? `<span data-tip="Form 4s whose ISSUER has no trading symbol — a non-traded fund, a private issuer, stock registered but not listed. They reach this lane because a filing is associated with every CIK on it, so a 10% holder&#39;s own submissions feed carries filings about companies it owns rather than about itself. Real filings, about companies this tab cannot show, so they are read and kept with the reason rather than stamped with the ticker of whichever roster name found them.">issuer not listed <b>${(f.noSym || 0).toLocaleString()}</b></span>` : '')
      + (t.noPrice ? `<span data-tip="transactions the form carried no price for — a footnoted weighted average, a range, or a grant. They are shown with a blank price rather than a zero, and are excluded from any size filter.">no price on the form <b>${(t.noPrice || 0).toLocaleString()}</b></span>` : '')
      + `</div>` : '')
    + (INS.menu ? `<div class="cng-colmenu">${INS.order.map(k => { const c = INS_COLS.find(x => x.k === k); return c
        ? `<label><input type="checkbox" data-inscol="${c.k}"${INS.hidden.has(c.k) ? '' : ' checked'}> ${esc(c.label)}</label>` : ''; }).join('')}`
      + `<button type="button" class="cng-chip" id="ins-colreset" data-tip="back to the default columns and order">reset</button></div>` : '');
  if (!INS.rows.length) {
    const why = INS.q.trim() ? 'no transaction matches that search'
      : INS.codes.size && INS.codes.size < INS_CHIPS.length ? 'no transaction matches those codes — widen the chips'
      : INS.minValue ? 'nothing this large in the stored set — drop the size filter'
      : (INS.from || INS.to) ? `no transaction in that range (${insRangeLabel()}) — widen it, or switch the range between traded and filed`
      : f.queued ? `nothing parsed yet — ${f.queued.toLocaleString()} Form 4(s) queued, read one per tick`
      : 'no Form 4 transactions stored yet — the EDGAR rotation queues them as it walks the roster';
    out.innerHTML = head + `<div class="sec" style="padding:10px 2px">${why}</div>`;
    insBind(); return;
  }
  const cell = (k, x) => {
    if (k === 'filed') return `<td class="l sec">${esc(x.filed ? new Date(x.filed).toISOString().slice(0, 10) : '—')}</td>`;
    if (k === 'traded') return `<td class="l">${esc(x.txDate || '—')}</td>`;
    if (k === 'ticker') return `<td class="l">${x.tk ? `<span class="cng-tk" data-tip="the issuer’s symbol as written on the form">${esc(x.tk)}</span>` : '<span class="sec">—</span>'}</td>`;
    if (k === 'owner') return `<td class="l"><span class="cng-nm" data-tip="${esc((x.owner || '') + (x.title ? ' — ' + x.title : ''))}">${esc((x.owner || '—').slice(0, 24))}</span></td>`;
    if (k === 'role') return insRoleCell(x);
    if (k === 'act') {
      const d = x.code === 'P' ? 'p' : x.code === 'S' ? 's' : 'e';
      // The derivative marker is a statement about what this view is NOT showing, so it appears
      // only when that is true: with the KIND filter on shares, on a share row, for a filing that
      // has derivative rows sitting outside the result set. Once the reader switches to
      // derivatives or both, the rows are right there and a marker counting them would be
      // pointing at itself.
      const hidden = INS.kind === 'S' && x.kind !== 'D' && x.nDeriv;
      return `<td class="l"><span class="cng-act ${d}" data-tip="${esc('transaction code ' + (x.code || '?') + (x.ad ? ' · ' + (x.ad === 'A' ? 'acquired' : 'disposed') : ''))}">${esc(x.act || x.code || '—')}</span>`
        + (hidden ? `<span class="ins-dv" data-tip="${esc('the same filing carried ' + x.nDeriv + ' derivative transaction(s) — options, with their own strikes and expiries — and the KIND filter is on shares, so they are not in this result set. Switch KIND to “derivatives” or “both” to read them; on “both”, an exercise and the same-day sale it funded are drawn as a pair.')}">+${x.nDeriv}D</span>` : '')
        + `</td>`;
    }
    if (k === 'kind') return `<td class="l"><span class="k-kind ${x.kind === 'D' ? 'dv' : 'sh'}" data-tip="${esc(x.kind === 'D'
      ? 'Table II of the form — a derivative: ' + (x.sec || 'an option or similar') + '. Its exercise price is in STRIKE; it has no share price.'
      : 'Table I of the form — an actual share transaction')}">${x.kind === 'D' ? 'option' : 'share'}</span></td>`;
    if (k === 'strike') return `<td class="r">${x.strike == null
      ? `<span class="sec">—</span>`
      : `<span class="k-strike" data-tip="${esc('exercise price — what they pay per share to convert. Not a transaction price, which is why it is not in the PRICE column.')}">$${insNum(x.strike, 2)}</span>`}</td>`;
    if (k === 'expiry') {
      if (!x.expiry) return `<td class="l sec">—</td>`;
      // Inside 90 days the exercise is likely mechanical: an option is worth nothing after it
      // lapses, so exercising a near-dated one says far less than exercising a long-dated one.
      const d90 = (Date.parse(x.expiry + 'T00:00:00Z') - Date.now()) / 86400000;
      return `<td class="l"><span class="k-exp${isFinite(d90) && d90 < 90 ? ' near' : ''}" data-tip="${esc(isFinite(d90) && d90 < 90
        ? 'expires in ' + Math.max(0, Math.round(d90)) + ' days — an exercise this close to expiry is mechanical, not a view on the price'
        : 'the date the derivative lapses')}">${esc(x.expiry)}</span></td>`;
    }
    if (k === 'under') return `<td class="l sec">${esc((x.under || '—').slice(0, 24))}</td>`;
    if (k === 'shares') return `<td class="r">${insNum(x.shares)}</td>`;
    if (k === 'price') return `<td class="r">${x.price == null
      ? `<span class="sec" data-tip="${esc(x.kind === 'D'
          ? 'a derivative row has no share price by construction, not by omission: what it carries is a STRIKE, and putting a strike here would mix two quantities in one column'
          : 'the form carried no price for this row — a footnoted weighted average, a range, or a grant. Not a zero.')}">—</span>`
      : '$' + insNum(x.price, 2)}</td>`;
    if (k === 'value') return `<td class="r">${x.value == null ? '<span class="sec">—</span>' : `<b class="${x.code === 'P' ? 'pos' : x.code === 'S' ? 'neg' : ''}">${insUsd(x.value)}</b>`}</td>`;
    if (k === 'pct') {
      // Share of the resulting holding. Only computable where the form carries the post-transaction
      // figure, which not every row does.
      const p = x.own != null && x.shares != null && x.own > 0 ? (x.shares / x.own) * 100 : null;
      return `<td class="r">${p == null ? '<span class="sec">—</span>'
        : `<span data-tip="${esc('this trade was ' + p.toFixed(1) + '% of the ' + insNum(x.own) + ' shares they held afterwards')}">${p >= 100 ? '≥100' : p.toFixed(p < 10 ? 1 : 0)}%</span>`}</td>`;
    }
    if (k === 'own') return `<td class="r">${x.own == null ? '<span class="sec">—</span>'
      : `${insNum(x.own)}${x.dir ? `<span class="ins-dir" data-tip="${esc(x.dir === 'D' ? 'held directly' : 'held indirectly — through a trust, a partnership or a family entity')}">${esc(x.dir)}</span>` : ''}`}</td>`;
    if (k === 'plan') return `<td class="l">${x.plan == null ? '<span class="sec" data-tip="the form does not say — the 10b5-1 box did not exist before 2023, and where a filing carries several transactions the flag is only read when it can be attributed to one of them without guessing">—</span>'
      : x.plan ? '<span class="ins-plan" data-tip="ticked: made under a Rule 10b5-1 plan, arranged in advance">10b5-1</span>'
      : '<span class="ins-plan off" data-tip="the box is present and NOT ticked — a discretionary trade">discr</span>'}</td>`;
    if (k === 'sec') return `<td class="l sec">${esc((x.sec || '—').slice(0, 24))}</td>`;
    if (k === 'issuer') return `<td class="l sec">${esc((x.issuer || '—').slice(0, 26))}</td>`;
    if (k === 'form') return `<td class="l sec">${esc(x.form || '—')}</td>`;
    return `<td class="l">${x.url ? `<a class="cng-src" href="${esc(safeHref(x.url))}" target="_blank" rel="noopener">form 4</a>` : ''}</td>`;
  };
  const arrow = (k) => INS.sort.k === k ? `<span class="cng-arr">${INS.sort.dir > 0 ? '▲' : '▼'}</span>` : '';
  out.innerHTML = head
    + `<div class="tblwrap"><table class="whl-tbl cng-tbl ins-tbl"><thead><tr>`
    + shown.map(col => `<th class="${col.cls} cng-th ins-th" draggable="true" data-inssort="${col.k}" data-tip="${esc(col.tip + ' · click to sort, drag to move the column')}">${esc(col.label)}${arrow(col.k)}</th>`).join('')
    + `</tr></thead><tbody>`
    + (() => {
      // Pair legs are marked wherever they land in the current ordering, and the story line is
      // emitted once, after the SECOND leg to be rendered. The brace glyph is only drawn when the
      // two are adjacent — under a sort that separates them, claiming a bracket across unrelated
      // intervening rows would be worse than saying nothing.
      const pair = insPairs(INS.rows);
      const seen = new Map();
      const out = [];
      INS.rows.forEach((x, i) => {
        const id = pair.get(i);
        const other = id ? seen.get(id) : null;
        const adjacent = other != null && other === i - 1;
        const cls = 'whl-worow' + (x.kind === 'D' ? ' dv' : '') + (id ? ' paired' : '') + (adjacent ? ' pair-b' : '');
        out.push(`<tr class="${cls}"${x.tk ? ` data-instk="${esc(x.tk)}"` : ''}>${shown.map(col => cell(col.k, x)).join('')}</tr>`);
        if (!id) return;
        if (other == null) { seen.set(id, i); return; }
        const m = INS.rows[other].kind === 'D' ? INS.rows[other] : x;
        const sr = INS.rows[other].kind === 'D' ? x : INS.rows[other];
        out.push(insPairStory(m, sr));
      });
      return out.join('');
    })()
    + `</tbody></table></div>`
    + insPager()
    + `<div class="whl-foot">${INS.rows.length.toLocaleString()} shown of ${INS.total.toLocaleString()} matching transaction(s)${(INS.from || INS.to) ? ` · <b>${esc(insRangeLabel())}</b>` : ''} · source: SEC Form 4, filed under Section 16 · shares, price, strike and date are the filer’s own figures — no number in this table is derived, banded or estimated, which is the difference from the CONGRESS tab, where the form discloses a range and no price at all · both of the form’s tables are here: Table I share transactions and Table II derivatives, kept apart by the KIND column because an exercise price and a transaction price are different quantities — a strike never enters PRICE, and a derivative row has no dollar value because shares × strike is a number nobody paid · a blank price is a price the form did not carry, never a zero · scoped to the ${(sc.covered || 0).toLocaleString()} equities this board covers — a 10% holder&#39;s filings about companies it holds arrive here through the same feed and are counted, not shown · the one INFERRED thing on this tab is the cashless-exercise pairing, drawn over two rows that each remain individually true and marked wherever it appears</div>`;
  insBind();
}
function insPager() {
  const pages = Math.max(1, Math.ceil(INS.total / INS_PAGE));
  if (pages <= 1) return '';
  const from = INS.page * INS_PAGE + 1, to = Math.min(INS.total, (INS.page + 1) * INS_PAGE);
  return `<div class="cng-pager">`
    + `<button type="button" class="cng-chip" data-inspage="first"${INS.page ? '' : ' disabled'}>« first</button>`
    + `<button type="button" class="cng-chip" data-inspage="prev"${INS.page ? '' : ' disabled'}>‹ prev</button>`
    + `<span class="cng-pnum">${from.toLocaleString()}–${to.toLocaleString()} of ${INS.total.toLocaleString()}</span>`
    + `<button type="button" class="cng-chip" data-inspage="next"${INS.page + 1 < pages ? '' : ' disabled'}>next ›</button>`
    + `<button type="button" class="cng-chip" data-inspage="last"${INS.page + 1 < pages ? '' : ' disabled'}>last »</button>`
    + `<span class="sec">page ${INS.page + 1} / ${pages.toLocaleString()}</span></div>`;
}
function insBind() {
  const out = el('insiders-body'); if (!out) return;
  const q = el('ins-q');
  if (q) { q.oninput = () => { INS.q = q.value; insSearch(); }; }
  // Sorting is a CLICK; reordering is a DRAG. Both live on the same <th>, so the click handler
  // has to know a drag happened — otherwise every column move also re-sorts the table under the
  // reader, which reads as the drag having done something else entirely.
  out.querySelectorAll('[data-inssort]').forEach(th => {
    th.onclick = () => {
      if (th.__moved) { th.__moved = 0; return; }
      const k = th.dataset.inssort;
      if (INS.sort.k === k) INS.sort.dir = -INS.sort.dir;
      else INS.sort = { k, dir: k === 'owner' || k === 'ticker' || k === 'role' || k === 'issuer' || k === 'sec' ? 1 : -1 };
      INS.page = 0;                     // a new ordering makes the old page number meaningless
      insSave(); openInsiders();
    };
    th.addEventListener('dragstart', e => { INS.drag = th.dataset.inssort; th.classList.add('dragging');
      try { e.dataTransfer.setData('text/plain', INS.drag); e.dataTransfer.effectAllowed = 'move'; } catch (_) {} });
    th.addEventListener('dragend', () => { th.classList.remove('dragging'); INS.drag = null; });
    th.addEventListener('dragover', e => {
      if (!INS.drag || INS.drag === th.dataset.inssort) return;
      e.preventDefault();
      const over = th.dataset.inssort;
      const ord = INS.order.filter(k => k !== INS.drag);
      const at = ord.indexOf(over);
      if (at < 0) return;
      const r = th.getBoundingClientRect();
      ord.splice(e.clientX < r.left + r.width / 2 ? at : at + 1, 0, INS.drag);
      if (ord.join() === INS.order.join()) return;
      INS.order = ord;
      th.__moved = 1;                   // suppress the click that ends this drag
      insSave(); insRender();
    });
  });
  out.querySelectorAll('[data-inspage]').forEach(b => b.onclick = () => {
    const pages = Math.max(1, Math.ceil(INS.total / INS_PAGE)), w = b.dataset.inspage;
    INS.page = w === 'first' ? 0 : w === 'prev' ? Math.max(0, INS.page - 1) : w === 'next' ? Math.min(pages - 1, INS.page + 1) : pages - 1;
    openInsiders();
  });
  out.querySelectorAll('[data-inscode]').forEach(b => b.onclick = () => {
    const c = b.dataset.inscode;
    if (INS.codes.has(c)) INS.codes.delete(c); else INS.codes.add(c);
    INS.page = 0; openInsiders();
  });
  out.querySelectorAll('[data-inskind]').forEach(b => b.onclick = () => {
    INS.kind = b.dataset.inskind || '';
    // Asking for derivatives and getting rows whose defining columns are hidden reads as a broken
    // filter. Revealing them is a one-way courtesy: it never re-hides a column the reader chose to
    // keep, and switching back to shares leaves the view as they now have it.
    if (INS.kind !== 'S') { for (const k of INS_DERIV_COLS) INS.hidden.delete(k); insSave(); }
    INS.page = 0; openInsiders();
  });
  out.querySelectorAll('[data-insrole]').forEach(b => b.onclick = () => { INS.role = b.dataset.insrole; INS.page = 0; openInsiders(); });
  out.querySelectorAll('[data-insplan]').forEach(b => b.onclick = () => { INS.plan = b.dataset.insplan || null; INS.page = 0; openInsiders(); });
  out.querySelectorAll('[data-insmin]').forEach(b => b.onclick = () => { INS.minValue = +b.dataset.insmin || 0; INS.page = 0; openInsiders(); });
  out.querySelectorAll('[data-insrange]').forEach(b => b.onclick = () => {
    const k = b.dataset.insrange;
    if (INS.preset === k) { INS.preset = ''; INS.from = ''; INS.to = ''; }   // clicking the active preset clears it
    else { INS.preset = k; const [f, t] = insRangeFor(k); INS.from = f; INS.to = t; }
    INS.page = 0; openInsiders();
  });
  out.querySelectorAll('[data-insdon]').forEach(b => b.onclick = () => {
    INS.dateOn = b.dataset.insdon;
    // Only refetch when a range is actually set — switching the basis with no range changes
    // nothing about the result, and a pointless round trip that repaints the table reads as a bug.
    if (INS.from || INS.to) { INS.page = 0; openInsiders(); } else insRender();
  });
  const dc = el('ins-dclear'); if (dc) dc.onclick = () => { INS.from = ''; INS.to = ''; INS.preset = ''; INS.page = 0; openInsiders(); };
  for (const [id, key] of [['ins-from', 'from'], ['ins-to', 'to']]) {
    const inp = el(id);
    if (inp) inp.onchange = () => {
      INS[key] = /^\d{4}-\d{2}-\d{2}$/.test(inp.value) ? inp.value : '';
      // A hand-typed range is nobody's preset any more, and a reversed one is normalised so the
      // inputs show what was actually queried rather than what was typed.
      INS.preset = '';
      if (INS.from && INS.to && INS.from > INS.to) { const t = INS.from; INS.from = INS.to; INS.to = t; }
      INS.page = 0; openInsiders();
    };
  }
  const cb = el('ins-colbtn'); if (cb) cb.onclick = () => { INS.menu = !INS.menu; insRender(); };
  const rs = el('ins-colreset'); if (rs) rs.onclick = () => {
    INS.order = INS_COLS.map(c => c.k); INS.hidden = new Set(INS_HIDE_DEFAULT);
    insSave(); insRender();
  };
  out.querySelectorAll('[data-inscol]').forEach(inp => inp.onchange = () => {
    const k = inp.dataset.inscol;
    if (inp.checked) INS.hidden.delete(k); else INS.hidden.add(k);
    // Never hide every column: an empty table is not a view, it is a broken one.
    if (INS.hidden.size >= INS_COLS.length) INS.hidden.delete(k);
    insSave(); insRender();
  });
  out.querySelectorAll('tr[data-instk]').forEach(tr => tr.onclick = (ev) => {
    if (ev.target.closest('a,button,th')) return;
    const c = 'xyz:' + tr.dataset.instk;
    if (state.rows.has(c)) openDetail(c);          // in-place drawer — no tab switch
  });
}
// The insiders lane's operator surface. The tab reads; this is how you make it read FASTER — the
// steady-state tick takes one queued Form 4 every 45s, which is right for a lane fed hourly by the
// EDGAR rotation and wrong for a cold start with a few hundred filings behind it.
// Forces the reaction study's history walk. The automatic one runs once per volume and flags
// itself done, which left no way back for a volume that completed it while the feed was thin —
// this is that way back. Blocking rather than fire-and-forget: the walk is ~50 chunked reads and
// the operator wants the count it ended with, not a "started" line.
async function termEarnBackfill(args){
  if(!IS_ADMIN) return termErr('earnings backfill is admin-only \u2014 it spends the vendor rate budget on a long chunk walk');
  const days=+(args[0]||0)||undefined;
  const think=termThinking();
  let r; try{ const res=await fetch('/api/earnings/backfill',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({days})}); r=await res.json(); }
  catch(e){ r={ok:false,error:e.message||'failed'}; }
  think.remove();
  if(!r||!r.ok) return termErr(tesc((r&&r.error)||'failed'));
  return termOut(`<span class="tp-hd">earnings history backfill</span> <span class="tp-trans">\u00b7 ${r.days}d window</span>\n`
    +`  ${tpad('retrieved',12)} <b>${(r.retrieved||0).toLocaleString()}</b> past print(s) from the feed\n`
    +`  ${tpad('history',12)} ${(r.printsBefore||0).toLocaleString()} \u2192 <b>${(r.printsAfter||0).toLocaleString()}</b> print(s) held`
    +(r.printsAfter===r.printsBefore?` <span class="tp-trans">(nothing new \u2014 the merge dedupes on ticker+date, so a repeat walk is a no-op)</span>`:'')+`\n`
    +`  ${tpad('study',12)} ${(r.study||0).toLocaleString()} name(s) now carry a reaction base rate`);
}
async function termInsiders(args){
  const sub=(args[0]||'status').toLowerCase();
  if(sub==='status'||!sub){
    const r=await insGet('?limit=1');
    if(!r||!r.ok) return termErr(tesc((r&&r.error)||'failed'));
    const s2=r.status||{}, f=s2.filings||{}, t=s2.tx||{};
    const L=[`<span class="tp-hd">insiders</span> <span class="tp-trans">\u00b7 SEC Form 4, Section 16 \u00b7 ${s2.roster||0} name(s) on the EDGAR rotation</span>`];
    L.push(`  ${tpad('filings',12)} <b>${(f.n||0).toLocaleString()}</b> known \u00b7 ${(f.done||0).toLocaleString()} read \u00b7 ${(f.queued||0).toLocaleString()} queued \u00b7 ${(f.failed||0).toLocaleString()} unreadable`);
    L.push(`  ${tpad('transactions',12)} <b>${(t.n||0).toLocaleString()}</b> across ${(t.names||0).toLocaleString()} name(s)\u00b7 ${(t.noPrice||0).toLocaleString()} with no price on the form`);
    if(s2.codes&&s2.codes.length) L.push(`  ${tpad('codes',12)} ${s2.codes.map(c=>`${tesc(c.code||'?')} <b>${c.n}</b>`).join('  ')}`);
    const bf=s2.backfill||{};
    if(bf.busy&&bf.progress) L.push(`  ${tpad('backfill',12)} <span class="amber">walking</span> ${bf.progress.names}/${bf.progress.of} name(s) \u00b7 ${bf.progress.added} new filing(s) queued from the last ${bf.progress.days}d`);
    else L.push(`  ${tpad('backfill',12)} ${bf.done?`<span class="pos">done</span> <span class="tp-trans">${tesc(new Date(+bf.done).toISOString().slice(0,10))}</span>`:'<span class="tp-trans">not run \u2014 the tab holds only what the EDGAR rotation has seen since deploy. Run: insiders backfill</span>'}`);
    if(s2.lastErr) L.push(`  ${tpad('last error',12)} <span class="neg">${tesc(s2.lastErr)}</span>`);
    if(s2.notes&&s2.notes.length) L.push(`  ${tpad('why',12)} ${s2.notes.map(n=>`${tesc(String(n.note||'').slice(0,40))} <b>\u00d7${n.n}</b>`).join('  ')}`);
    return termOut(L.join('\n')+`\n<span role="button" tabindex="0" class="tp-deep" data-tview="insiders">open insiders tab \u25b8</span>`);
  }
  if(!IS_ADMIN) return termErr('insiders parse/requeue is admin-only');
  if(sub==='parse'){
    const r=await insPost({op:'parse',n:+(args[1]||0)||undefined});
    return r&&r.ok?termOut(`<span class="pos">parse run started</span> <span class="tp-trans">\u00b7 ${tesc(r.note||'')}</span>`):termErr(tesc((r&&r.error)||'failed'));
  }
  if(sub==='requeue'){
    const r=await insPost({op:'requeue',all:(args[1]||'').toLowerCase()==='all'});
    return r&&r.ok?termOut(`<span class="pos">${r.requeued||0} filing(s) requeued</span>`):termErr(tesc((r&&r.error)||'failed'));
  }
  if(sub==='backfill'){
    const r=await insPost({op:'backfill',days:+(args[1]||0)||undefined});
    return r&&r.ok?termOut(`<span class="pos">history walk started</span> <span class="tp-trans">\u00b7 ${tesc(r.note||'')}</span>`):termErr(tesc((r&&r.error)||'failed'));
  }
  return termErr('usage: insiders [status | parse [n] | backfill [days] | requeue [all]]');
}
async function termCongress(args){
  const sub=(args[0]||'status').toLowerCase();
  if(!IS_ADMIN) return termErr('congress is admin-only while the lane soaks');
  if(sub==='ingest'){
    const yr=(args[1]||'').trim();
    const r=await cngPost({op:'ingest',year:yr?+yr:undefined});
    return r&&r.ok?termOut(`<span class="pos">index ingest started</span> <span class="tp-trans">\u00b7 ${tesc(r.note||'')}</span>`):termErr(tesc((r&&r.error)||'failed'));
  }
  if(sub==='parse'){
    const r=await cngPost({op:'parse',n:+(args[1]||0)||undefined});
    return r&&r.ok?termOut(`<span class="pos">parse run started</span> <span class="tp-trans">\u00b7 ${tesc(r.note||'')}</span>`):termErr(tesc((r&&r.error)||'failed'));
  }
  if(sub==='ocr'){
    const r=await cngPost({op:'ocr',n:+(args[1]||0)||undefined});
    return r&&r.ok?termOut(`<span class="pos">OCR run started</span> <span class="tp-trans">\u00b7 ${tesc(r.note||'')}</span>`):termErr(tesc((r&&r.error)||'failed'));
  }
  if(sub==='diag'){
    const doc=(args[1]||'').trim();
    const think=termThinking(); const r=await cngPost({op:'diag',doc:doc||undefined}); think.remove();
    if(!r) return termErr('failed');
    const L=[];
    L.push(`<span class="tp-hd">congress diag ${tesc(doc||'')}</span>${r.build?` <span class="tp-trans">\u00b7 server build ${tesc(r.build)}</span>`:''}`);
    L.push(`  ${tpad('url',12)} ${tesc(r.url||'')}`);
    L.push(`  ${tpad('http',12)} ${tesc(String(r.status||r.error||'?'))}${r.ct?' \u00b7 '+tesc(r.ct):''}`);
    if(r.bytes!=null) L.push(`  ${tpad('bytes',12)} ${r.bytes.toLocaleString()}`);
    if(r.isPdf!=null) L.push(`  ${tpad('is a PDF',12)} <span class="${r.isPdf?'pos':'neg'}">${r.isPdf?'yes':'NO'}</span>`);
    if(r.head) L.push(`  ${tpad('first bytes',12)} ${tesc(String(r.head).slice(0,90))}`);
    if(r.producer) L.push(`  ${tpad('producer',12)} ${tesc(r.producer)}`);
    if(r.objects!=null) L.push(`  ${tpad('structure',12)} ${r.objects} object(s) \u00b7 ${r.streams} stream(s)${r.objStm?' \u00b7 <span class="neg">object streams</span>':''}${r.encrypted?' \u00b7 <span class="amber">encrypted</span>':''}`);
    if(r.encryption) L.push(`  ${tpad('encryption',12)} ${r.encryption.unsupported?`<span class="neg">${tesc(r.encryption.unsupported)}</span>`:`<span class="pos">V${r.encryption.V}/R${r.encryption.R} ${r.encryption.aes?'AES-128':'RC4'} \u2014 decrypted with the empty user password</span>`}`);
    if(r.nImages) L.push(`  ${tpad('images',12)} ${r.nImages}${(r.images||[]).map(i=>` \u00b7 ${tesc(i.filter||'?')} ${i.w}\u00d7${i.h} ${i.kb}KB ${i.ready?'<span class="pos">OCR-ready</span>':'<span class="neg">needs decoding</span>'}`).join('')}`);
    if(r.runs!=null) L.push(`  ${tpad('text runs',12)} ${r.runs} \u00b7 rows ${r.rows} \u00b7 tx ${r.tx}`);
    (r.sampleRuns||[]).forEach(x=>L.push(`    run  x${tpad(String(x.x),5,true)} y${tpad(String(x.y),5,true)}  ${tesc(x.t)}`));
    (r.sampleRows||[]).forEach(x=>L.push(`    row  ${tesc(x)}`));
    (r.sampleTx||[]).forEach(x=>L.push(`    tx   ${tesc(JSON.stringify(x))}`));
    (r.skipped||[]).forEach(x=>L.push(`    skip ${tesc(JSON.stringify(x))}`));
    if(r.ocrChars!=null){
      L.push(`  ${tpad('ocr',12)} ${r.ocrChars} char(s) recognized \u00b7 ${r.ocrRows||0} row(s) passed the gate`);
      (r.ocrText||[]).forEach(x=>L.push(`    text ${tesc(String(x).slice(0,96))}`));
      (r.ocrDropped||[]).forEach(x=>L.push(`    drop ${tesc(x.why)} \u2014 ${tesc(String(x.line||'').slice(0,60))}`));
    }
    if(r.ocrError) L.push(`  ${tpad('ocr',12)} <span class="neg">${tesc(r.ocrError)}</span>`);
    return termOut(L.join('\n'));
  }
  if(sub==='watch'||sub==='unwatch'){
    const m=args.slice(1).join(' ').trim();
    if(!m) return termErr('usage: congress '+sub+' <member name as it appears on the panel>');
    const r=await cngPost({op:'watch',member:m,on:sub==='watch'});
    return r&&r.ok?termOut(`<span class="pos">${sub==='watch'?'starred':'unstarred'}</span> ${tesc(m)} <span class="tp-trans">${sub==='watch'?'\u00b7 new filings by this member raise a congress alert (enable the congress class in push settings to get it on Telegram)':''}</span>`):termErr(tesc((r&&r.error)||'failed'));
  }
  if(sub==='watchlist'){
    const r=await cngGet('?watch=1'); if(!r||!r.ok) return termErr('failed');
    const w=r.watch||[];
    if(!w.length) return termOut('<span class="sec">no members starred</span> <span class="tp-trans">\u00b7 star one on the Congress tab, or: congress watch &lt;name&gt;</span>');
    return termOut(`<span class="tp-hd">starred members</span>\n`+w.map(x=>`  ${tpad(tesc(x.member),28)} ${x.notify?'<span class="pos">alerts on</span>':'<span class="sec">muted</span>'}`).join('\n'));
  }
  if(sub==='backfill'){
    const r=await cngPost({op:'backfill',years:+(args[1]||0)||undefined});
    return r&&r.ok?termOut(`<span class="pos">backfill started</span> <span class="tp-trans">\u00b7 ${tesc(r.note||'')}</span>`):termErr(tesc((r&&r.error)||'failed'));
  }
  if(sub==='reticker'){
    const r=await cngPost({op:'reticker',n:+args[1]||undefined});
    if(!r||!r.ok)return termErr(tesc((r&&r.error)||'failed'));
    const ex=(r.sample||[]).length?`<div class="tp-trans" style="margin-top:4px">${tesc(r.sample.join(' \u00b7 '))}</div>`:'';
    return termOut(`<span class="pos">${r.fixed}</span> of ${r.scanned} unresolved row(s) now carry a ticker \u00b7 <span class="tp-trans">${r.still} still name-only</span>${ex}<div class="tp-trans" style="margin-top:4px">server build ${tesc(r.build||'?')}</div>`);
  }
  if(sub==='requeue'){
    const r=await cngPost({op:'requeue',all:(args[1]||'')==='all'});
    return r&&r.ok?termOut(`<span class="pos">${r.requeued} filing(s) requeued</span> <span class="tp-trans">\u00b7 run <b>congress parse</b> to work them again</span>`):termErr(tesc((r&&r.error)||'failed'));
  }
  if(sub==='feed'){
    const r=await cngGet('?feed=1&limit=20'); if(!r||!r.ok) return termErr(tesc((r&&r.error)||'failed'));
    const rows=r.feed||[];
    if(!rows.length) return termOut('<span class="sec">no parsed transactions yet</span> <span class="tp-trans">\u00b7 admin: congress parse</span>');
    const money=(v)=>v==null?'\u2014':'$'+Math.round(v).toLocaleString();
    const body=rows.map(x=>{
      const lag=x.filed&&x.txDate?Math.round((Date.parse(x.filed)-Date.parse(x.txDate))/86400000):null;
      const dir=/^buy/.test(x.act)?'pos':/^sell/.test(x.act)?'neg':'amber';
      return `  ${tpad(tesc(x.filed||''),11)} ${tpad(lag==null?'\u2014':lag+'d',5,true)} ${tpad(tesc((x.member||'').slice(0,22)),23)} ${tpad(tesc(x.ticker||'\u2014'),7)} <span class="${dir}">${tpad(tesc(x.act),13)}</span> ${tesc('\u2265 '+money(x.loAmt))}`;
    }).join('\n');
    return termOut(`<span class="tp-hd">congress \u00b7 PTR feed</span> <span class="tp-trans">\u00b7 newest FILED first \u2014 the filing date is when the market learned, not the trade date</span>\n${body}\n<span class="tp-trans">amounts are the disclosed band FLOOR (\u2265) \u2014 a PTR discloses a range, never a figure</span>`);
  }
  if(sub==='status'){
    const r=await cngGet(); if(!r||!r.ok) return termErr(tesc((r&&r.error)||'failed'));
    const st=r.status||{}, c=st.counts||{};
    if(!st.ready) return termErr('congress index unavailable \u2014 sqlite is off in this runtime');
    const when=st.lastSync?new Date(st.lastSync).toISOString().slice(0,16).replace('T',' ')+'Z':'never';
    const yrs=(st.years||[]).map(y=>`${y.yr}:${y.n}`).join(' ')||'\u2014';
    const head=`<span class="tp-hd">congress index</span> <span class="tp-trans">${st.build?'\u00b7 build '+tesc(st.build)+' ':''}\u00b7 last sync ${tesc(when)}${st.busy?' \u00b7 <span class="amber">ingesting now</span>':''}</span>`;
    const body=c.n?`\n  ${tpad('filings',12)} ${tpad(String(c.n),8,true)}\n  ${tpad('of those PTR',12)} ${tpad(String(c.ptr),8,true)}\n  ${tpad('members',12)} ${tpad(String(c.members),8,true)}\n  ${tpad('range',12)} ${tesc((c.first||'\u2014')+' \u2192 '+(c.last||'\u2014'))}${c.noDate?` <span class="tp-err">${c.noDate} filing(s) with an unreadable date</span> <span class="tp-trans">\u2014 kept and counted; raw values are sampled in the ingest ops line</span>`:''}\n  ${tpad('by year',12)} ${tesc(yrs)}\n  ${tpad('unparsed',12)} ${tpad(String(c.pending),8,true)} <span class="tp-trans">PTRs queued for phase 2 \u2014 no document is parsed yet</span>`
      :'\n  <span class="sec">no index ingested yet</span> <span class="tp-trans">\u00b7 admin: congress ingest</span>';
    const notes=(st.parse&&st.parse.notes)||[];
    const why=notes.length?`\n  ${tpad('why',12)} ${notes.map(n2=>tesc(n2.note.slice(0,42))+' \u00d7'+n2.n
      +(n2.sample&&n2.sample!==n2.note?'  <span class="tp-trans">'+tesc(String(n2.sample).slice(0,72))+'</span>':'')).join('\n'+' '.repeat(15))}`:'';
    const err=(st.lastError?`\n  <span class="tp-err">last error</span> ${tesc(String(st.lastError).slice(0,160))}`:'')+why;
    return termOut(head+body+err);
  }
  // Anything that looks like a verb is a verb, even one this build does not implement — otherwise
  // 'congress ocr 20' answers as a rollup for a ticker called OCR, which is a different question
  // wearing the same words. Only a lone token that is NOT a verb is treated as a symbol.
  const CNG_VERBS=['status','ingest','backfill','parse','ocr','diag','requeue','reticker','watch','unwatch','watchlist','feed','help'];
  if(CNG_VERBS.includes(sub)) return termErr(`congress ${tesc(sub)} is not available in this build (${tesc(state.build||'?')}) \u2014 it may need a deploy`);
  if(args.length>1) return termErr(`unknown congress command \u201c${tesc(sub)}\u201d \u2014 try: congress status | parse | ocr | diag | feed | watch <member>`);
  if(/^[A-Za-z.]{1,6}$/.test(sub)){
    const r=await cngGet('?ticker='+encodeURIComponent(sub.toUpperCase()));
    if(!r||!r.ok) return termErr(tesc((r&&r.error)||'failed'));
    if(!r.roll) return termOut(`<span class="sec">no congressional transactions on ${tesc(sub.toUpperCase())}</span> <span class="tp-trans">\u00b7 in what has been parsed so far</span>`);
    const R=r.roll, money=(v)=>'$'+Math.round(v).toLocaleString();
    const body=R.members.map(m=>`  ${tpad(tesc(m.member.slice(0,24)),25)} ${tpad(String(m.n),3,true)} <span class="${m.buys>m.sells?'pos':m.sells>m.buys?'neg':'sec'}">${tpad(m.buys+'b/'+m.sells+'s',8)}</span> ${tpad(m.medLag==null?'\u2014':m.medLag+'d',6,true)} ${tpad('\u2265 '+money(m.floor),14,true)} ${tesc(m.last||'')}`).join('\n');
    return termOut(`<span class="tp-hd">${tesc(R.ticker)} \u00b7 congressional flow</span> <span class="tp-trans">\u00b7 ${R.filings} transaction(s) \u00b7 ${R.buys} buy / ${R.sells} sell \u00b7 \u2265 ${money(R.floor)} disclosed floor</span>\n${body}\n<span class="tp-trans">\u2265 sums the LOW end of every disclosed band \u2014 a hard floor, never an estimate of the real total</span>`);
  }
  return termErr('usage: congress status | ingest [year] | backfill [years] | parse [n] | ocr [n] | diag [docId|member] | requeue [all] | reticker [n] | watch/unwatch <member> | watchlist | feed | <TICKER>');
}
// ---- CONGRESS panel (build 2026.08.24-06) -----------------------------------------------------
// The PTR feed, sorted by FILING date because that is the moment the information became public —
// a seven-week-old trade filed this morning is this morning's news. Two numbers ride in the header
// permanently, not as an error state: how many filings could not be parsed, and how many assets
// never resolved to a ticker. A lane that hides its own coverage rate is asking to be trusted more
// than it has earned.
// Column model. Sorting, filtering and hiding are the three things a table this long needs, and
// the panel owns them client-side over the fetched page: the sort keys are derived values (lag is
// filed minus traded, band sorts on its FLOOR) which the server has no reason to compute twice.
const CNG_COLS=[
  {k:'star',    label:'\u2605',   cls:'l', tip:'star a member to keep them on your list \u2014 and, with the congress push class enabled, to be told on Telegram when they file new activity.'},
  {k:'filed',   label:'FILED',    cls:'l', tip:'when the filing became public. The default sort \u2014 a trade from seven weeks ago that files today is today\u2019s information.'},
  {k:'lag',     label:'LAG',      cls:'r', tip:'filing date minus trade date. The STOCK Act caps it at 45 days; how close a member runs to that cap is itself a behavioural read.'},
  {k:'member',  label:'MEMBER',   cls:'l', tip:'the filer, with chamber and district.'},
  {k:'owner',   label:'OWNER',    cls:'l', tip:'whose account traded: the member, a spouse (SP), a dependent child (DC) or a joint account (JT). A spouse\u2019s trade is disclosed but is not the member\u2019s own.'},
  {k:'ticker',  label:'TICKER',   cls:'l', tip:'the ticker where one exists. Written by the filer, or resolved from the issuer name \u2014 a dotted underline marks the second, weaker claim.'},
  {k:'asset',   label:'ASSET',    cls:'l', tip:'the issuer or instrument exactly as the filing named it, kept verbatim even where a ticker was resolved from it.'},
  {k:'atype',   label:'TYPE',     cls:'l', tip:'the form\u2019s own asset-type code. [ST] stock, [EF] ETF, [MF] mutual fund, [GS] government security, [RP] real property, [FA] farm \u2014 it decides whether a ticker can exist at all.'},
  {k:'act',     label:'ACT',      cls:'l', tip:'purchase, sale, partial sale or exchange, as disclosed.'},
  {k:'band',    label:'BAND',     cls:'r', tip:'the band the filer disclosed. A PTR never carries an exact figure, so none is shown and no midpoint is computed anywhere in this lane. Sorts on the band FLOOR.'},
  {k:'traded',  label:'TRADED',   cls:'l', tip:'the transaction date itself.'},
  {k:'notified',label:'NOTIFIED', cls:'l', tip:'when the filer says they were told of the trade. On a managed account the 45-day clock starts here, not at the trade \u2014 which is how a filing can be late-looking and perfectly compliant.'},
  {k:'ln',      label:'#',        cls:'r', tip:'the line number within its filing. Two identical-looking rows with different line numbers are two separate lots in the document, not a double-count.'},
  {k:'src',     label:'SRC',      cls:'l', tip:'the filed PDF at the House Clerk, the source each row was parsed from.'},
];
// Everything the parser knows is a column; the reader decides what to look at. Only the line
// number starts hidden, since it exists to answer a question most readers will not be asking.
const CNG_HIDE_DEFAULT=['ln'];
const CNG_LS='cngview';
const CNG_PAGE=50;
const CNG={rows:[],stat:null,filers:null,watch:new Set(),starred:false,total:0,page:0,tk:'',busy:false,q:'',acts:new Set(),sort:{k:'traded',dir:-1},hidden:new Set(),menu:false};

export function __boot_insiders_13850() {
INS = { rows: [], stat: null, total: 0, page: 0, q: '', codes: new Set(['P', 'S']), plan: null,
  role: '', minValue: 0, kind: 'S', from: '', to: '', dateOn: 'traded', preset: '',
  sort: { k: 'filed', dir: -1 }, hidden: new Set(INS_HIDE_DEFAULT),
  order: INS_COLS.map(c => c.k), menu: false, drag: null };
insLoad();
CNG.hidden=new Set(CNG_HIDE_DEFAULT);
try{ const v=JSON.parse(localStorage.getItem(CNG_LS)||'{}');
  if(v.hidden) CNG.hidden=new Set(v.hidden);
  if(v.sort&&v.sort.k) CNG.sort=v.sort;
}catch(_){}
}

function cngSave(){ try{ localStorage.setItem(CNG_LS,JSON.stringify({hidden:[...CNG.hidden],sort:CNG.sort})); }catch(_){} }
function cngMoney(v){ if(v==null) return '\u2014';
  const a=Math.abs(v);
  if(a>=1e9) return '$'+(v/1e9).toFixed(1)+'B';
  if(a>=1e6) return '$'+(v/1e6).toFixed(1)+'M';
  if(a>=1e3) return '$'+Math.round(v/1e3)+'K';
  return '$'+Math.round(v); }
const cngLag=(x)=>x.filed&&x.txDate?Math.round((Date.parse(x.filed)-Date.parse(x.txDate))/86400000):null;
// One accessor per column, used by BOTH the sort and the filter so the two can never disagree
// about what a column contains.
const CNG_VAL={
  filed:(x)=>x.filed||'', lag:(x)=>{const l=cngLag(x); return l==null?-1e9:l;},
  member:(x)=>(x.member||'').toLowerCase(), asset:(x)=>(x.ticker||x.asset||'').toLowerCase(),
  act:(x)=>x.act||'', band:(x)=>x.loAmt==null?-1:x.loAmt, traded:(x)=>x.txDate||'', src:(x)=>x.url||'',
};
async function openCongress(){
  const out=el('congress-body'); if(!out) return;
  if(!CNG.rows.length) out.innerHTML='<div class="msg">reading the congressional index\u2026</div>';
  const q=CNG.q.trim();
  const r=await cngGet('?feed=1&limit='+CNG_PAGE+'&offset='+(CNG.page*CNG_PAGE)
    +'&sort='+encodeURIComponent(CNG.sort.k)+'&dir='+CNG.sort.dir
    +(CNG.starred?'&starred=1':'')
    +(q?'&q='+encodeURIComponent(q):'')+(CNG.tk?'&ticker='+encodeURIComponent(CNG.tk):''));
  if(!r||!r.ok){ out.innerHTML=`<div class="msg err">${esc((r&&r.error)||'fetch failed')}</div>`; return; }
  CNG.rows=r.feed||[]; CNG.stat=r.status||null; CNG.filers=r.filers||null; CNG.total=r.total||0;
  if(r.watch) CNG.watch=new Set(r.watch.map(w=>w.member));
  // A filter or a sort can land the reader past the end of the new result set.
  if(CNG.page&&!CNG.rows.length&&CNG.total){ CNG.page=Math.max(0,Math.ceil(CNG.total/CNG_PAGE)-1); return openCongress(); }
  cngRender();
}
let cngT=null;
function cngSearch(){ clearTimeout(cngT); cngT=setTimeout(openCongress,260); }
function cngVisible(){
  // Search, sort and paging all happen in SQL now — a header click has to order every matching
  // transaction, not the page that happens to be loaded. The browser only narrows by direction,
  // which is a view of the page rather than a claim about the whole set.
  // starred and the text search are SQL-side; only the act chips narrow the loaded page, and they
  // say so by only ever removing rows the reader can already see.
  if(!CNG.acts.size) return CNG.rows;
  return CNG.rows.filter(x=>CNG.acts.has(String(x.act||'').split('-')[0]));
}
function cngRender(){
  const out=el('congress-body'); if(!out) return;
  const st=CNG.stat||{}, c=st.counts||{}, ps=st.parse||{};
  const when=st.lastSync?new Date(st.lastSync).toISOString().slice(0,16).replace('T',' ')+'Z':'never';
  const pct=(a,b)=>b?Math.round(a/b*100)+'%':'\u2014';
  const rows=cngVisible();
  const shown=CNG_COLS.filter(col=>!CNG.hidden.has(col.k));
  const head=`<div class="whl-head">`
    +`<span class="whl-hd">CONGRESS \u00b7 PTR FEED</span>`
    +`<span class="cng-tag" data-tip="the House Clerk republishes its filing index daily; this is the last time we read it">house index \u00b7 synced ${esc(when)}</span>`
    +`<span class="sec">${(c.n||0).toLocaleString()} filings \u00b7 ${(c.ptr||0).toLocaleString()} PTR \u00b7 ${(c.members||0).toLocaleString()} filers</span>`
    +`<span class="whl-sp"></span>`
    +`<input id="cng-q" class="cng-in" placeholder="filter \u2014 member, ticker, asset" value="${esc(CNG.q)}" maxlength="40" autocomplete="off" spellcheck="false">`
    +['buy','sell','exchange'].map(a=>`<button type="button" class="cng-chip${CNG.acts.has(a)?' on':''}" data-cngact="${a}">${a}</button>`).join('')
    +`<button type="button" class="cng-chip${CNG.starred?' on':''}" id="cng-starred" data-tip="show only the members you have starred">\u2605 starred${CNG.watch.size?' ('+CNG.watch.size+')':''}</button>`
    +`<button type="button" class="cng-chip" id="cng-colbtn" data-tip="show or hide columns \u2014 remembered on this browser">columns \u25be</button>`
    +`</div>`
    +`<div class="cng-rates">`
      +`<span data-tip="filings whose PDF yielded transactions, over all PTRs the index knows about. The rest are queued or unreadable \u2014 both are counted here rather than quietly excluded.">parsed <b>${(ps.parsed||0).toLocaleString()}</b> / ${(c.ptr||0).toLocaleString()} <span class="sec">(${pct(ps.parsed||0,c.ptr||0)})</span></span>`
      +`<span data-tip="a real PDF that yielded no text at all \u2014 an image-only filing. There is no OCR in this lane: these are marked once, never re-fetched, and counted here so the coverage number stays honest.">unreadable <b>${(ps.unreadable||0).toLocaleString()}</b></span>`
      +`<span data-tip="PTRs the index has found but nobody has read yet. Worked daily; forceable with: congress parse">queued <b>${(ps.pending||0).toLocaleString()}</b></span>`
      +`<span data-tip="transactions carrying a ticker \u2014 the parenthetical the filer wrote, or the issuer name resolved against the universe. Measured over instruments that CAN have one: municipal bonds, real property, farms and private equity are excluded from the denominator, because no ticker exists for them and counting them as failures would make this number describe the data rather than the parser.">ticker resolved <b>${pct(ps.resolved||0,Math.max(0,(ps.tx||0)-(ps.noTicker||0)))}</b> <span class="sec">(${(ps.resolved||0).toLocaleString()}/${Math.max(0,(ps.tx||0)-(ps.noTicker||0)).toLocaleString()} tickerable)</span></span>`
      +((ps.noTicker||0)?`<span data-tip="municipal bonds, real property, farms, private equity, bank accounts \u2014 the form's own asset-type code says these are not exchange-listed instruments, so no ticker exists to pair. They are shown by name and excluded from the rate above rather than counted as failures.">not listed <b>${(ps.noTicker||0).toLocaleString()}</b></span>`:'')
      +((ps.parsed&&!ps.tx)?`<span class="cng-warn" data-tip="these filings DID yield text \u2014 extraction worked \u2014 but the parser recognized no transaction rows in it. Run: congress diag">\u26a0 ${ps.parsed} parsed, 0 transactions</span>`:'')
      +((ps.ocr||0)?`<span data-tip="transactions recovered from photographed paper filings by OCR, each one through a strict validation gate. Shown with an OCR marker because the reading is weaker than a text filing.">from OCR <b>${(ps.ocr||0).toLocaleString()}</b></span>`:'')
      +((ps.badDate||0)?`<span class="cng-warn" data-tip="rows whose trade date parsed as LATER than the filing that reports it \u2014 impossible, so the dates were misread from those documents. They are counted here rather than shown as a negative lag.">\u2717 ${ps.badDate} impossible date(s)</span>`:'')
      +(c.noDate?`<span class="cng-warn" data-tip="filings whose FilingDate the parser could not read. They are kept, never dropped; the raw values are sampled into the ingest ops line.">unreadable dates <b>${c.noDate}</b></span>`:'')
    +`</div>`
    +((ps.notes&&ps.notes.length)?`<div class="cng-why"><span class="k">why</span>${ps.notes.map(n2=>`<span data-tip="${esc(n2.sample||n2.note)}">${esc(n2.note.split(':')[0])} <b>\u00d7${n2.n}</b></span>`).join('')}</div>`:'')
    +(CNG.menu?`<div class="cng-colmenu">${CNG_COLS.map(col=>`<label><input type="checkbox" data-cngcol="${col.k}"${CNG.hidden.has(col.k)?'':' checked'}> ${esc(col.label)}</label>`).join('')}</div>`:'');
  const filerNote=()=>{
    const f=CNG.filers;
    if(!f||!f.length) return CNG.q.trim()?`<div class="cng-note">no filer matching \u201c${esc(CNG.q.trim())}\u201d in the ${(c.n||0).toLocaleString()} filings this lane has indexed. The index currently covers ${esc((st.years||[]).map(y=>y.yr).join(', ')||'no years')} \u2014 earlier years are not loaded until an admin runs <b>congress backfill</b>.</div>`:'';
    return `<div class="cng-note"><span class="k">in the index</span>${f.map(x=>{
      // A member whose every filing is a photograph will never appear in the table, however long
      // you wait or how often you re-parse. Saying so once beats leaving it to be inferred from a
      // breakdown each time.
      const allScan=x.n&&!x.done&&!x.queued&&(x.unreadable+x.empty)>=x.n;
      return allScan
        ? `<span data-tip="${esc(x.n+' PTR filing(s), every one of them a photographed paper filing. This lane reads text PDFs and has no OCR, so this member has no transactions to show and re-parsing will not change that.')}"><b>${esc(x.member)}</b> ${x.n} PTR \u00b7 <span class="neg">files on paper \u2014 unreadable without OCR</span></span>`
        :
      `<span data-tip="${esc(x.n+' PTR filing(s) '+(x.yr0===x.yr1?'in '+x.yr0:'between '+x.yr0+' and '+x.yr1)+', last filed '+(x.last||'?'))}">`
      +`<b>${esc(x.member)}</b> ${x.n} PTR`
      +(x.done?` \u00b7 <span class="pos">${x.done} with transactions</span>`:'')
      +(x.empty?` \u00b7 <span class="neg" data-tip="these filings were read \u2014 text came out of the PDF \u2014 but the parser recognized no transaction rows in them, so there is nothing to show in the table. That is a parser gap, not an empty filing. Diagnose one with: congress diag ${esc(x.emptyDoc||'')}">${x.empty} read but no rows recognized</span>${x.emptyDoc?` <span class="cng-diaghint">congress diag ${esc(x.emptyDoc)}</span>`:''}`:'')
      +(x.queued?` \u00b7 <span class="amber" data-tip="found in the index, not read yet. Terminal: congress parse">${x.queued} queued</span>`:'')
      +(x.unreadable?` \u00b7 <span class="neg" data-tip="photographed paper filings. There is no OCR in this lane, so these can never yield transactions.">${x.unreadable} scanned</span>`:'')
      +`</span>`;}).join('')}</div>`;
  };
  if(!rows.length){
    out.innerHTML=head+filerNote()
      +`<div class="sec" style="padding:10px 2px">${
        CNG.q.trim()?'no parsed transactions match \u2014 see what the index knows above'
        :CNG.starred?'none of your starred members have parsed transactions yet \u2014 unstar the filter to see everyone else'
        :CNG.acts.size?'no rows on this page match that direction \u2014 try clearing the buy/sell chips'
        :ps.parsed?'no transactions to show':`nothing parsed yet \u2014 ${ps.pending} PTR(s) queued. Terminal: <b>congress parse</b>`}</div>`;
    cngBind(); return;
  }
  const cell=(k,x)=>{
    const lag=cngLag(x);
    if(k==='star'){ const on=CNG.watch.has(x.member);
      return `<td class="l"><button type="button" class="cng-star${on?' on':''}" data-cngstar="${esc(x.member)}" data-tip="${esc(on?'starred \u2014 click to remove. New filings by this member raise a congress alert.':'star '+(x.member||'')+' \u2014 keeps them on your list and raises an alert on new filings')}">${on?'\u2605':'\u2606'}</button></td>`; }
    if(k==='filed') return `<td class="l sec">${esc(x.filed||'\u2014')}</td>`;
    if(k==='lag'){
      // A negative lag means the filing predates the trade it reports, which cannot happen. That is
      // a parse error in the dates, and printing "-320d" states it as fact.
      if(lag!=null&&lag<0) return `<td class="r"><span class="cng-lag bad" data-tip="the trade date parsed as ${esc(x.txDate||'?')} but the filing is dated ${esc(x.filed||'?')} \u2014 a report cannot predate its own trade, so one of these dates was misread from the document. The row is shown because the filing is real; the lag is not computed from bad input.">\u2717</span></td>`;
      return `<td class="r"><span class="cng-lag ${lag==null?'na':lag<14?'fast':lag<35?'mid':'slow'}">${lag==null?'\u2014':lag+'d'}</span></td>`;
    }
    if(k==='member') return `<td class="l"><span class="cng-nm">${esc((x.member||'').slice(0,26))}</span><span class="cng-dist">${esc((x.state||'')+(x.dist?'-'+x.dist:''))}</span></td>`;
    if(k==='owner') return `<td class="l">${x.owner&&x.owner!=='self'
      ?`<span class="cng-own" data-tip="filed for the member\u2019s ${esc(x.owner)}, not the member personally">${esc(x.owner==='dependent'?'DC':x.owner==='spouse'?'SP':'JT')}</span>`
      :'<span class="sec">self</span>'}</td>`;
    if(k==='ticker') return `<td class="l">${x.ticker
      ?`<span class="cng-tk${x.tkSrc==='name'?' derived':''}" data-tip="${esc(x.tkSrc==='name'?('resolved from the issuer name \u2014 \u201c'+(x.asset||'')+'\u201d \u2014 against the universe, using the same collision-safe map the 13F lane uses: a name that could mean two symbols resolves to neither. The filer did not write a ticker on the form.'):'the ticker exactly as the filer wrote it on the form')}">${esc(x.ticker)}</span>`
      :`<span class="cng-un${x.tkSrc==='n/a'?' na':''}" data-tip="${esc(x.tkSrc==='n/a'?('not an exchange-listed instrument'+(x.atype?' \u2014 the filing types it ['+x.atype+']':'')+', so no ticker exists to pair'):'no ticker on the form, and the issuer name did not resolve against the universe')}">${x.tkSrc==='n/a'?'not listed':'\u2014'}</span>`}</td>`;
    if(k==='asset') return `<td class="l">${x.src==='ocr'?'<span class="cng-ocr" data-tip="read by OCR from a photographed paper filing, not from a text layer. Every field on this row passed a strict check \u2014 the amount matches a real disclosed tier exactly, the date is valid and precedes the filing, the type is a literal P/S/E \u2014 and anything ambiguous was dropped rather than guessed. It is still a weaker reading than a text filing.">OCR</span> ':''}<span class="cng-asset" data-tip="${esc(x.asset||'')}">${esc((x.asset||'').length>38?(x.asset||'').slice(0,38)+'\u2026':(x.asset||''))}</span></td>`;
    if(k==='atype') return `<td class="l">${x.atype?`<span class="cng-atype" data-tip="the form\u2019s own asset-type code">${esc(x.atype)}</span>`:'<span class="sec">\u2014</span>'}</td>`;
    if(k==='notified') return `<td class="l sec">${esc(x.notified||'\u2014')}</td>`;
    if(k==='ln') return `<td class="r sec" data-tip="line ${x.ln} of filing ${esc(x.fid||'')}">${x.ln==null?'\u2014':x.ln+1}</td>`;
    if(k==='act'){ const dir=/^buy/.test(x.act)?'p':/^sell/.test(x.act)?'s':'e'; return `<td class="l"><span class="cng-act ${dir}">${esc(x.act)}</span></td>`; }
    if(k==='band') return `<td class="r">${esc(x.hiAmt!=null?cngMoney(x.loAmt)+' \u2013 '+cngMoney(x.hiAmt):cngMoney(x.loAmt)+'+')}</td>`;
    if(k==='traded') return `<td class="l sec">${esc(x.txDate||'\u2014')}</td>`;
    return `<td class="l">${x.url?`<a class="cng-src" href="${esc(safeHref(x.url))}" target="_blank" rel="noopener">source</a>`:''}</td>`;
  };
  const arrow=(k)=>CNG.sort.k===k?`<span class="cng-arr">${CNG.sort.dir>0?'\u25b2':'\u25bc'}</span>`:'';
  out.innerHTML=head+(CNG.q.trim()?filerNote():'')
    +`<div class="tblwrap"><table class="whl-tbl cng-tbl"><thead><tr>`
    +shown.map(col=>`<th class="${col.cls} cng-th" data-cngsort="${col.k}" data-tip="${esc(col.tip+' \u00b7 click to sort')}">${esc(col.label)}${arrow(col.k)}</th>`).join('')
    +`</tr></thead><tbody>`
    +rows.map(x=>`<tr class="whl-worow">${shown.map(col=>cell(col.k,x)).join('')}</tr>`).join('')
    +`</tbody></table></div>`
    +cngPager()
    +`<div class="whl-foot">${rows.length.toLocaleString()} shown of ${CNG.total.toLocaleString()} matching transaction(s) \u00b7 source: House Clerk Periodic Transaction Reports, filed under the STOCK Act \u00b7 sorted by FILING date by default \u2014 the moment the information became public \u00b7 amounts are disclosed bands, never point figures \u00b7 a <span class="cng-tk derived">dotted</span> ticker was resolved from the issuer name, not written on the form \u00b7 Senate and executive-branch (OGE 278-T) filings are NOT in this lane</div>`;
  cngBind();
}
function cngPager(){
  const pages=Math.max(1,Math.ceil(CNG.total/CNG_PAGE));
  if(pages<=1) return '';
  const from=CNG.page*CNG_PAGE+1, to=Math.min(CNG.total,(CNG.page+1)*CNG_PAGE);
  return `<div class="cng-pager">`
    +`<button type="button" class="cng-chip" data-cngpage="first"${CNG.page?'':' disabled'}>\u00ab first</button>`
    +`<button type="button" class="cng-chip" data-cngpage="prev"${CNG.page?'':' disabled'}>\u2039 prev</button>`
    +`<span class="cng-pnum">${from.toLocaleString()}\u2013${to.toLocaleString()} of ${CNG.total.toLocaleString()}</span>`
    +`<button type="button" class="cng-chip" data-cngpage="next"${CNG.page+1<pages?'':' disabled'}>next \u203a</button>`
    +`<button type="button" class="cng-chip" data-cngpage="last"${CNG.page+1<pages?'':' disabled'}>last \u00bb</button>`
    +`<span class="sec">page ${CNG.page+1} / ${pages.toLocaleString()}</span></div>`;
}
function cngBind(){
  const q=el('cng-q');
  if(q){ q.oninput=()=>{ CNG.q=q.value; CNG.page=0; cngSearch(); }; }
  const out=el('congress-body'); if(!out) return;
  out.querySelectorAll('[data-cngsort]').forEach(th=>th.onclick=()=>{
    const k=th.dataset.cngsort;
    if(CNG.sort.k===k) CNG.sort.dir=-CNG.sort.dir; else CNG.sort={k,dir:k==='member'||k==='asset'||k==='act'?1:-1};
    CNG.page=0;                       // a new ordering makes the old page number meaningless
    cngSave(); openCongress(); });
  out.querySelectorAll('[data-cngpage]').forEach(b=>b.onclick=()=>{
    const pages=Math.max(1,Math.ceil(CNG.total/CNG_PAGE)), w=b.dataset.cngpage;
    CNG.page=w==='first'?0:w==='prev'?Math.max(0,CNG.page-1):w==='next'?Math.min(pages-1,CNG.page+1):pages-1;
    openCongress(); });
  out.querySelectorAll('[data-cngact]').forEach(b=>b.onclick=()=>{
    const a=b.dataset.cngact;
    if(CNG.acts.has(a)) CNG.acts.delete(a); else CNG.acts.add(a);
    cngRender(); });
  const cb=el('cng-colbtn'); if(cb) cb.onclick=()=>{ CNG.menu=!CNG.menu; cngRender(); };
  const sb=el('cng-starred'); if(sb) sb.onclick=()=>{ CNG.starred=!CNG.starred; CNG.page=0; openCongress(); };
  out.querySelectorAll('[data-cngstar]').forEach(b=>b.onclick=async()=>{
    const m=b.dataset.cngstar, on=!CNG.watch.has(m);
    if(on) CNG.watch.add(m); else CNG.watch.delete(m);
    cngRender();                                   // optimistic: the star answers the click at once
    const r=await cngPost({op:'watch',member:m,on});
    if(!r||!r.ok){ if(on) CNG.watch.delete(m); else CNG.watch.add(m); cngRender(); }
  });
  out.querySelectorAll('[data-cngcol]').forEach(inp=>inp.onchange=()=>{
    const k=inp.dataset.cngcol;
    if(inp.checked) CNG.hidden.delete(k); else CNG.hidden.add(k);
    // Never hide every column: an empty table is not a view, it is a broken one.
    if(CNG.hidden.size>=CNG_COLS.length) CNG.hidden.delete(k);
    cngSave(); cngRender(); });
}
async function cngGet(qs){ try{ return await fetchJSON('/api/congress'+(qs||'')); }catch(e){ return {ok:false,error:e.message||'fetch failed'}; } }
async function cngPost(body){ try{ const r=await fetch('/api/congress',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)});
  return await r.json(); }catch(e){ return {ok:false,error:e.message||'post failed'}; } }
async function termWhale(args){
  if(!featureOn('funds')&&!IS_ADMIN) return termErr('the FUNDS tab is not enabled for this view');
  const sub=(args[0]||'').toLowerCase();
  if(!sub) return termWhaleList();
  if(sub==='season') return termWhaleSeason(args.slice(1).join(' '));
  if(sub==='add'){
    if(!IS_ADMIN) return termErr('whale add is admin-only');
    const q=args.slice(1).join(' ').trim(); if(!q) return termErr('usage: whale add <fund name or CIK>');
    const think=termThinking(); const r=await whlPost({op:'search',q}); think.remove();
    if(!r||!r.ok) return termErr(tesc((r&&r.error)||'search failed'));
    WHL.cand=r.candidates;
    return termOut(`<span class="tp-hd">EDGAR search</span> <span class="tp-trans">\u00b7 ${r.candidates.length} filer(s) match \u2014 pick one</span>\n`+r.candidates.map((c,i)=>`  <span class="ex" data-tcmd="whale pick ${i+1}">${i+1}</span>  ${tesc(c.name)} <span class="tp-trans">CIK ${c.cik}</span>`).join('\n'));
  }
  if(sub==='pick'){
    const i=(+args[1]||0)-1; const c=WHL.cand&&WHL.cand[i];
    if(!c) return termErr('nothing pending \u2014 whale add <name> first');
    const r=await whlPost({op:'add',cik:c.cik,name:c.name}); WHL.cand=null;
    return r&&r.ok?termOut(`<span class="pos">added</span> ${tesc(r.fund.key)} <span class="tp-trans">\u00b7 ${tesc(r.fund.name)} \u00b7 CIK ${r.fund.cik} \u00b7 watching for 13F-HR \u00b7 notify on</span>`):termErr(tesc((r&&r.error)||'add failed'));
  }
  if(sub==='rm'){
    if(!IS_ADMIN) return termErr('whale rm is admin-only');
    const k=(args[1]||'').toUpperCase(); if(!k) return termErr('usage: whale rm <key> [yes]');
    if((args[2]||'').toLowerCase()!=='yes') return termOut(`<span class="err">confirm:</span> remove ${tesc(k)} from the watchlist? <span class="tp-trans">history kept, row hidden \u00b7 <span class="ex" data-tcmd="whale rm ${tesc(k)} yes">whale rm ${tesc(k)} yes</span></span>`);
    const r=await whlPost({op:'rm',key:k});
    return r&&r.ok?termOut(`<span class="pos">removed</span> ${tesc(k)}`):termErr(tesc((r&&r.error)||'remove failed'));
  }
  if(sub==='who'||sub==='holds'){
    const qv=args.slice(1).join(' ').trim(); if(!qv) return termErr('usage: whale who <ticker, name fragment, or CUSIP>');
    const think=termThinking(); let r;
    try{ r=await fetchJSON('/api/whale?holds='+encodeURIComponent(qv)); }catch(_){ think.remove(); return termErr('lookup failed \u2014 try again in a moment'); }
    think.remove();
    if(!r.ok) return termOut(`<span class="sec">${tesc(r.error||'no result')}</span>`);
    // -07: one block per ISSUER. A query that hits two companies prints two blocks, each with its
    // own basis and totals — the terminal never merges them either.
    const block=(iss,head)=>{
      const lines=iss.funds.map(f=>{
        if(!f.held) return `  ${tpad(tesc(f.key),12)} <span class="sec">EXITED \u00b7 ${f.exited.map(x=>(x.put?tesc(x.put)+'s ':'')+'was '+whlMoney(x.prevVal)).join(' \u00b7 ')}</span>`;
        const dl={add:'<span class="pos">added</span>',trim:'<span class="neg">trimmed</span>',new:'<span class="amber">opened</span>',flat:'<span class="sec">flat</span>',na:'<span class="sec">\u2014</span>'}[f.dir]||'<span class="sec">\u2014</span>';
        const fv=f.lines.reduce((s,l)=>s+(l.value||0),0);
        const hd=`  ${tpad(tesc(f.key),12)} ${tpad(whlMoney(fv),9,true)} ${dl}${f.mixed?' <span class="amber" title="legs disagree \u2014 net direction shown, fund counted once">\u00b1</span>':''}`;
        const lots=f.lines.map(l=>`    ${tpad(l.put?tesc(l.put.toUpperCase())+'S':(l.cls?tesc(String(l.cls).toUpperCase().split(/\s+/).slice(-2).join(' ')):'COM'),8)} ${tpad(whlMoney(l.value),9,true)} ${tpad(l.pct!=null?(l.pct>0&&l.pct<0.05?'<0.1%':l.pct.toFixed(1)+'%'):'\u2014',7,true)} ${tpad('#'+l.rank,6,true)} ${!l.d||l.d.cls==='na'?'\u2014':l.d.cls==='new'?'<span class="amber">opened</span>':l.d.cls==='flat'?'<span class="sec">flat</span>':(l.d.dSh!=null?'<span class="'+(l.d.dSh>0?'pos':'neg')+'">'+whlSgnSh(l.d.dSh)+' sh</span>':(l.d.dVal!=null?'<span class="'+(l.d.dVal>0?'pos':'neg')+'">'+(l.d.dVal>0?'+':'\u2212')+whlMoney(Math.abs(l.d.dVal)).slice(1)+'</span>':'\u2014'))}`).join('\n');
        return hd+'\n'+lots;
      }).join('\n');
      return `<span class="${head?'tp-hd':'amber'}">${head?'who holds '+tesc(r.q):'also matched'}</span> <span class="tp-trans">\u00b7 ${tesc(iss.name||'')}${iss.tk?' ['+tesc(iss.tk)+']':''} \u00b7 matched by ${tesc(iss.basisLabel)} \u00b7 ${iss.held}/${r.watchN} hold \u00b7 common ${whlMoney(iss.common)}${iss.optNotional?' + option notional '+whlMoney(iss.optNotional):''}${iss.adding?' \u00b7 '+iss.adding+' adding':''}${iss.cutting?' \u00b7 '+iss.cutting+' cutting':''}</span>\n${lines}`
        +(iss.notHeld&&iss.notHeld.length?`\n<span class="tp-trans">not held: ${iss.notHeld.map(tesc).join(', ')}</span>`:'');
    };
    const blocks=(r.issuers||[]).map((iss,i)=>block(iss,i===0)).join('\n\n');
    const topTail=r.top?`\n\n<span class="tp-th">market-wide \u00b7 ${tesc(r.top.q)} data set \u00b7 ${r.top.nFilers.toLocaleString()} filers \u00b7 ${whlMoney(r.top.totVal)}</span>\n`+r.top.rows.slice(0,5).map(x=>`  ${tpad(String(x.rank),3)} ${tpad(tesc(x.name.slice(0,22))+(x.tracked?'*':''),24)} ${tpad(whlMoney(x.value),9,true)} ${tpad(whlSh(x.shares),10,true)} ${x.isNew?'<span class="amber">NEW</span>':(x.dSh!=null?`<span class="${x.dSh>0?'pos':'neg'}">${whlSgnSh(x.dSh)}</span>`:'\u2014')}`).join('\n')+`\n<span class="tp-trans">  * tracked \u00b7 full table + honesty notes on the FUNDS tab</span>`:'';
    return termOut(`${blocks}\n<span class="tp-trans">quarter-end books filed up to 45d late \u2014 positioning history, not the current book${r.noBook&&r.noBook.length?' \u00b7 no book yet: '+r.noBook.map(tesc).join(', '):''}</span>${topTail}`);
  }
  if(sub==='ingest13f'){
    if(!IS_ADMIN) return termErr('whale ingest13f is admin-only');
    const r=await whlPost({op:'ingest13f',q:args.slice(1).join(' ').trim()||undefined});
    return r&&r.ok?termOut(`<span class="pos">ingest started</span> <span class="tp-trans">\u00b7 ${tesc(r.note||'')}</span>`):termErr(tesc((r&&r.error)||'failed'));
  }
  if(sub==='pull'){
    if(!IS_ADMIN) return termErr('whale pull is admin-only');
    const k=(args[1]||'').toUpperCase(); if(!k) return termErr('usage: whale pull <key> \u2014 check EDGAR for the latest 13F right now');
    const think=termThinking(); const r=await whlPull(k); think.remove();
    if(!r||!r.ok) return termErr(tesc((r&&r.error)||'pull failed'));
    return r.ingested?termOut(`<span class="pos">ingested</span> ${tesc(k)} ${tesc(r.q||'')} <span class="tp-trans">\u00b7 ${whlMoney(r.total)} \u00b7 ${r.n} positions \u00b7 <span class="ex" data-tcmd="whale ${tesc(k)}">whale ${tesc(k)}</span> for the book</span>`)
      :termOut(`<span class="sec">up to date</span> <span class="tp-trans">\u00b7 EDGAR's newest 13F for ${tesc(k)} was already on file (${tesc(r.q||'')})</span>`);
  }
  if(sub==='mute'||sub==='unmute'){
    if(!IS_ADMIN) return termErr('whale '+sub+' is admin-only');
    const k=(args[1]||'').toUpperCase(); if(!k) return termErr('usage: whale '+sub+' <key>');
    const r=await whlPost({op:'mute',key:k,on:sub==='mute'});
    return r&&r.ok?termOut(`<span class="pos">${sub==='mute'?'muted':'unmuted'}</span> ${tesc(k)} <span class="tp-trans">${sub==='mute'?'\u00b7 row still updates and badges \u2014 it just never alerts':''}</span>`):termErr(tesc((r&&r.error)||'failed'));
  }
  const full=(args[1]||'').toLowerCase()==='full';
  return termWhaleFund(sub.toUpperCase(),full);
}
export { openCongress, openInsiders, termCongress, termEarnBackfill, termInsiders, termWhale };
