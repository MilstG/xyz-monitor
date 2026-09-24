"use strict";
// public/js — markets table, drawer, layouts, prefs, shell. Split out of test.js (build 2026.09.16-80); order within the file is the original order.
const test = require("node:test");
const assert = require("node:assert");
const { classify, pearson, HOUR, DAY, C, _sessDomStub, _sessPayload, twoUserHarness, _p2Harness, mktGroupsFn, mktGroupsFixture, actionMathFns } = require("./_shared");


test("funding heatmap: the grid's own rules — quantity, gaps, and a sign that is never colour-only", () => {
  const fs = require("fs"), path = require("path");
  const app = require("./_client").clientSource();
  const css = fs.readFileSync(path.join(__dirname, "..", "public", "styles.css"), "utf8");
  for (const pin of ["function fhColor(v,cap)", "function renderFundHeat(fh)",
    "function attachFundHeatControls()", "cap=fhCap(fh,tf)"])
    assert.ok(app.includes(pin), `app.js missing funding-heatmap pin: ${pin}`);
  // an unknown bucket is hatched, never painted as zero carry
  assert.ok(/if\(v==null\|\|!isFinite\(v\)\) return null;/.test(app) && app.includes("url(#${pid})"),
    "a gap in the funding spine must render as a gap, not as flat carry");
  assert.ok(css.includes(".s-leg .fh-gapsw"), "and the legend says what the hatch means");
  // red/green is the hard CVD pair, so the direction is carried twice more WITHOUT colour: a signed
  // per-row direct label, and a tooltip that names the side in words.
  assert.ok(app.includes("'longs pay'") && app.includes("'longs receive'"), "tooltips name the direction");
  assert.ok(app.includes('class="fh-nv ') && app.includes("fhPct(mean,dp)"), "every row is direct-labelled with its signed mean");
  assert.ok(app.includes("\\u22480%"), "a value that rounds away must not claim a direction");
  // per bucket, the timeframe must never be presented as a zoom
  assert.ok(/change the quantity, not the zoom/.test(app), "the per-bucket caption says the timeframe changes the quantity");
});

test("funding heatmap: the annualized read (build 2026.09.16-77) — a multiplier over the same payload, one cap across resolutions", () => {
  const fs = require("fs"), path = require("path");
  const app = require("./_client").clientSource();
  const css = fs.readFileSync(path.join(__dirname, "..", "public", "styles.css"), "utf8");
  for (const pin of ["const FH_UNITS=[['apr','annualized'],['bucket','per bucket']]", "const FH_HPY=24*365",
    "function fhUnit()", "function fhAnn(fh,tf)", "function fhCapApr(fh,tf)", "function fhCells(fh,row,tf)", "function fhDpApr(cap)"])
    assert.ok(app.includes(pin), `app.js missing annualized pin: ${pin}`);
  // annualized is the DEFAULT, and the choice is remembered per browser — never shipped in the payload
  assert.ok(/localStorage\.getItem\('xyz-fh-unit'\)==='bucket'\?'bucket':'apr'/.test(app), "annualized unless the browser remembers per bucket");
  assert.ok(app.includes("localStorage.setItem('xyz-fh-unit'"), "the unit switch persists");
  // the multiplier is the site-wide convention (hourly ×24×365), applied per bucket width
  assert.ok(app.includes("FH_HPY/ax.bucketHours"), "a cell annualizes by its own bucket's hours-per-year");
  // an unknown bucket stays unknown under the multiplier
  assert.ok(/c\.map\(v=>\(v==null\|\|!isFinite\(v\)\)\?null:v\*a\)/.test(app), "null × 1095 is still null");
  // one cap across resolutions under APR: the default grid's, annualized — not each grid's own
  assert.ok(/k=axs\[fh&&fh\.tfDefault\]\?fh\.tfDefault:tf/.test(app), "the shared cap anchors on the default (8h) grid");
  // sorts are unit-blind: ranking still runs on the raw per-bucket mean
  assert.ok(/const m=now\?fhNowOf\(r\):fhMean\(r,tf\);/.test(app), "sort keys read the raw mean (or raw live rate), not the unit-scaled one");
  // an annual rate prints at 0–2 decimals, never a bucket cost's 3–6
  assert.ok(/return clamp\(2-Math\.floor\(Math\.log10\(c\)\),0,2\); \}/.test(app), "APR decimals are capped at two");
  // both units in every tooltip, and the label on the timeframe control follows the unit
  assert.ok(app.includes("over this ${ax.bucketHours}h bucket") && app.includes("} APR`"), "tooltips carry the bucket cost under APR and the APR under per bucket");
  assert.ok(app.includes("${apr?'resolution':'funding per'}"), "the timeframe control is a resolution when annualized");
  // the unit buttons wear the same segment styling as the timeframe buttons
  assert.ok(css.includes(".fhtf.on,.fhunit.on{") && css.includes(".fhtf+.fhtf,.fhunit+.fhunit{"), "unit buttons styled as a segment");
});

test("funding heatmap: the now column and the lifted row cap (build 2026.09.20-81)", () => {
  const fs = require("fs"), path = require("path");
  const app = require("./_client").clientSource();
  const pl = fs.readFileSync(path.join(__dirname, "..", "src", "poller.js"), "utf8");
  // current funding is read off the client's live snapshot by coin, never off the 60s board payload
  for (const pin of ["function fhNowOf(r)", "state.rows.get(r.coin)", "function fhNowSig(fh)", "function fhLiveRefresh()"])
    assert.ok(app.includes(pin), `client missing now-column pin: ${pin}`);
  assert.ok(app.includes("fhLiveRefresh();   // the funding board's now column reads these rows"), "the snapshot path repaints the column when a rate rolls");
  assert.ok(/fhNowSig\(fh\)!==_fhNowSig\) renderFunding\(\)/.test(app), "and only when it rolled — not on every 15s snapshot");
  // same unit as the mean it sits beside: ×8760 annualized, × bucketHours per bucket
  assert.ok(app.includes("const nowMul=apr?FH_HPY:ax.bucketHours"), "the now column follows the unit on screen");
  assert.ok(app.includes("'now APR':'now / '+esc(tf)"), "and is headed as such");
  // an unpriced market is a dash, never a zero
  assert.ok(app.includes("const fnow=fhNowOf(r), now=fnow==null?null:fnow*nowMul"), "no snapshot row -> null -> em dash");
  // "all rows" means all rows: the server ships every market with a spine, the client trims
  assert.ok(pl.includes("const FUNDHEAT_ROWS = 400;"), "the 60-row server cap is gone");
  assert.ok(app.includes("const FH_ROWOPTS=[['25','top 25'],['50','top 50'],['all','all rows']]"), "the client owns the trim");
});

test("tab nav: \u2190 returns to the tab you were on, \u2302 goes home to Markets (build 2026.09.21-84)", () => {
  const fs = require("fs"), path = require("path");
  const app = require("./_client").clientSource();
  const html = fs.readFileSync(path.join(__dirname, "..", "public", "index.html"), "utf8");
  const css = fs.readFileSync(path.join(__dirname, "..", "public", "styles.css"), "utf8");
  // the two buttons live in the control cluster AFTER the spacer, so saved tab order and drag can never move them
  const at = (s) => html.indexOf(s);
  assert.ok(at('id="tabSpacer"') < at('id="backBtn"') && at('id="backBtn"') < at('id="homeBtn"') && at('id="homeBtn"') < at('id="helpBtn"'), "\u2190 / \u2302 sit between the spacer and the help button");
  assert.ok(/id="backBtn" disabled/.test(html) && /id="homeBtn" disabled/.test(html), "both start dead: nowhere to go back to, already home");
  for (const pin of [
    "if(switching&&el('view-'+from)) state.prevView=from;",                              // the tab you came from, recorded on every real switch
    "function goBackTab(){ const p=state.prevView; if(p&&p!==state.view&&tabVisible(p)) showView(p); }",
    "if(e.key==='b'){ e.preventDefault(); goBackTab(); return; }",
    "if(e.key==='h'){ e.preventDefault(); showView('markets'); return; }",
    "b.addEventListener('click',goBackTab);", "h.addEventListener('click',()=>showView('markets'));",
    "syncTabScroll(); syncTabNav();",                                                                 // every showView restamps the buttons
    "{ const tm=el('view-treemap'); if(tm) tm.hidden=v!=='treemap'; }",                                                      // the runtime treemap hides on \u2190 / \u2302 / palette, not only on a tab click
    "e.target.closest('.tab,.tabnav')",                                                              // ...and the treemap installer's delegated listener reads the buttons
    "<kbd>b</kbd> <kbd>h</kbd>", "view:'markets', prevView:null,",
  ]) assert.ok(app.includes(pin), `client missing tab-nav pin: ${pin}`);
  assert.ok(app.indexOf("syncTabNav();   // a scope flip") > 0, "applyTabVisibility resyncs the buttons — a scope flip can hide the Back target");
  assert.ok(css.includes(".tabs .tabnav:disabled{opacity:.35;cursor:default}") && css.includes("#backBtn,#homeBtn,"), "dead state is visible; touch targets on phones");
  // exercise syncTabNav: Back is live only with a visible, existing previous tab; Home is dead on Markets
  const src = app.slice(app.indexOf("function syncTabNav(){"), app.indexOf("function showView(v){"));
  const run = (view, prevView, visible, sections = ["view-markets", "view-trend", "view-signals"]) => {
    const btn = { backBtn: { disabled: true, title: "" }, homeBtn: { disabled: true } };
    const el = (id) => btn[id] || (sections.includes(id) ? {} : null);
    const doc = { querySelector: (q) => ({ textContent: " " + q.replace(/.*"([a-z]+)".*/, "$1") + " 3 " }) };
    new Function("state", "el", "tabVisible", "document", src + "; syncTabNav();")({ view, prevView }, el, (v) => visible.includes(v), doc);
    return btn;
  };
  let b = run("trend", "markets", ["markets", "trend"]);
  assert.equal(b.backBtn.disabled, false, "came from Markets: Back is live"); assert.ok(b.backBtn.title.startsWith("Back to markets \u2014"), "the title names the target, badge count stripped: " + b.backBtn.title);
  assert.equal(b.homeBtn.disabled, false, "not on Markets: Home is live");
  b = run("markets", null, ["markets"]);
  assert.equal(b.backBtn.disabled, true, "fresh load: nowhere to go back to"); assert.equal(b.homeBtn.disabled, true, "already home");
  b = run("markets", "signals", ["markets"]);
  assert.equal(b.backBtn.disabled, true, "the previous tab is hidden by scope now: Back is dead rather than bouncing you to Markets with a toast");
  b = run("markets", "focus", ["markets", "focus"]);
  assert.equal(b.backBtn.disabled, true, "a view whose section is missing from this build is never a Back target");
  b = run("signals", "signals", ["signals"]);
  assert.equal(b.backBtn.disabled, true, "previous == current is not a move");
});

test("funding heatmap: sorting on the now column (build 2026.09.21-82)", () => {
  const app = require("./_client").clientSource();
  // the three now-sorts mirror the three mean-sorts, and share one comparator
  for (const pin of ["['nowpay','now: longs pay most']", "['nowrecv','now: longs receive most']", "['nowabs','now: strongest']",
    "const now=sort.startsWith('now'), kind=now?sort.slice(3):sort;", "const m=now?fhNowOf(r):fhMean(r,tf);"])
    assert.ok(app.includes(pin), `client missing now-sort pin: ${pin}`);
  // exercise the comparator: rows without a live rate sink to the bottom, ties break by ticker
  const src = app.slice(app.indexOf("function fhSortRows(rows,tf,sort){"), app.indexOf("// Time-axis ticks."));
  const live = new Map([["A", { funding: 2e-5 }], ["B", { funding: -3e-5 }], ["C", { funding: 1e-5 }]]);
  const fhSortRows = new Function("state", "fhNowOf", "fhMean", src + "; return fhSortRows;")(
    { rows: live }, (r) => (live.get(r.coin) || {}).funding ?? null, () => null);
  const rows = ["D", "C", "B", "A"].map((t) => ({ coin: t, ticker: t, oi: 1, tf: {} }));
  const order = (s) => fhSortRows(rows, "8h", s).map((r) => r.ticker).join("");
  assert.equal(order("nowpay"), "ACBD", "paying most first, unpriced last");
  assert.equal(order("nowrecv"), "BCAD", "receiving most first");
  assert.equal(order("nowabs"), "BACD", "strongest live carry first, either side");
});

test("transport cap: per-universe lanes so a volatile crypto day cannot evict the equity board", () => {
  // The lanes (capPerUniverse, the -85 fix) came back with the crypto engine. This is not
  // housekeeping: crypto's intensity terms are sigma multiples and crypto sigma is 5-20x the
  // equity side's, so a single global sort hands the whole payload to perps on any volatile day
  // and the equity board — the one with the long record — vanishes from its own tab with no
  // error anywhere. Executed against the real function, not string-pinned.
  const C = require("../src/compute");
  const mk = (uni, score, i) => ({ uni, score, coin: uni + i, ev: "bigmove" });
  const many = [];
  for (let i = 0; i < 60; i++) many.push(mk("main", 90 + i, i));   // crypto dominates on raw score
  for (let i = 0; i < 20; i++) many.push(mk("xyz", 10 + i, i));    // equities score far lower
  const cap = C.capPerUniverse(many, 40, 40);
  assert.equal(cap.filter((g) => g.uni === "xyz").length, 20,
    "every equity signal survives the cap even when 60 higher-scoring crypto signals exist");
  assert.equal(cap.filter((g) => g.uni === "main").length, 40, "crypto fills its own lane and stops there");
  for (let i = 1; i < cap.length; i++) assert.ok(cap[i - 1].score >= cap[i].score, "merged list stays score-ordered");
  assert.deepEqual(C.capPerUniverse(null, 40, 40), [], "null input: empty list, not a throw");
  const fs = require("fs"), path = require("path");
  const pol = fs.readFileSync(path.join(__dirname, "..", "src", "poller.js"), "utf8");
  assert.ok(pol.includes("const top = crypto ? capPerUniverse(kept, 40, 40) : kept.slice(0, 40);"),
    "the build routes through the lanes when crypto is enabled and keeps the plain slice when it is not");
  const app = require("./_client").clientSource();
  for (const pin of ["function setSigTabBadge()",
    "const u = state.scope==='crypto' ? 'm' : 'x';",
    "d&&d.countU&&d.countU[u]!=null ? d.countU[u] : (d?(d.count||0):0)"])
    assert.ok(app.includes(pin), `scoped badge pin missing: ${pin}`);
});

test("client -73: multi-timeframe chart + action panel ship end to end", () => {
  const fs = require("fs"), path = require("path");
  const app = require("./_client").clientSource();
  const css = fs.readFileSync(path.join(__dirname, "..", "public", "styles.css"), "utf8");
  const pol = fs.readFileSync(path.join(__dirname, "..", "src", "poller.js"), "utf8");
  for (const frag of ["aiChartTfSeg", "data-aitf", "state.report.tf", "aiActionHtml", "enter_on_pullback", "entryIsMarket", "EMA13 ", "fill-opacity=\"0.08\""])
    assert.ok(app.includes(frag), `app.js missing -73 marker: ${frag}`);
  for (const cls of [".ai-act", ".ai-tf"]) assert.ok(css.includes(cls), `styles.css missing: ${cls}`);
  for (const frag of ["AI_SCHEMA_V", "report format updated", "schemaV: AI_SCHEMA_V", "actionable stance without void/target geometry", "downgraded from an entry stance", "bucketsFor(r, 24)"])
    assert.ok(pol.includes(frag), `poller.js missing -73 marker: ${frag}`);   // daily-OHLC upgrade still aggregates the spine, now via the memoized bucketsFor (2026.07.21-08)
});

test("UI -23: amber theme removed, one density, status bar reformatted", () => {
  const fs = require("fs"), path = require("path");
  const app = require("./_client").clientSource();
  const html = fs.readFileSync(path.join(__dirname, "..", "public", "index.html"), "utf8");
  const css = fs.readFileSync(path.join(__dirname, "..", "public", "styles.css"), "utf8");

  // The amber palette is gone from all three files — not just unreachable, absent. A leftover
  // :root[data-theme] block is 30 lines of dead cascade nobody can trigger or notice rotting.
  for (const [name, src] of [["styles.css", css], ["app.js", app], ["index.html", html]])
    assert.ok(!src.includes("data-theme"), `amber theme residue in ${name}`);
  assert.ok(!html.includes('id="themeBtn"') && !app.includes("themeBtn"), "theme button must be gone");
  assert.ok(!app.includes("xyzmon.theme"), "theme persistence must be gone");

  // Tab ordering and the self-installing Treemap tab both anchored on themeBtn. Removing a button
  // that two independent systems used as a DOM landmark is exactly how tabs end up appended after
  // the controls, so the anchor is now an element that exists for that job and nothing else.
  assert.ok(html.includes('id="tabSpacer"'), "tab/control divider missing from the markup");
  assert.ok(css.includes(".tabspacer{margin-left:auto}"), "the spacer must absorb the slack");
  assert.equal((app.match(/el\('tabSpacer'\)|getElementById\('tabSpacer'\)/g) || []).length, 3,
    "the saved-order pass, the Treemap installer and the group builder must all anchor on the spacer");

  // Status bar: a panel strip with a right-pinned tray, not right-aligned floating text.
  assert.ok(/\.statusline\{[^}]*background:var\(--panel\)/.test(css), "status bar must read as a strip");
  assert.ok(!/\.statusline\{[^}]*justify-content:flex-end/.test(css), "the old right-float layout must be gone");
  assert.ok(/\.statusline \.st-right\{[^}]*margin-left:auto/.test(css), "freshness tray must pin right");
  assert.ok(html.includes('class="st-right"'), "st-right wrapper missing from the markup");

  // The chip's own display rule outranked [hidden], so it sat in the bar showing "◎ —" forever.
  assert.ok(css.includes("#focusChip[hidden]{display:none}"), "hidden focus chip must actually hide");
});

test("UI -23: the [hidden] attribute is honoured by every element that styles its own display", () => {
  // This is the generalized form of the focus-chip bug, and it is a bug CLASS, not an instance.
  // An author `display:` rule beats the UA's [hidden]{display:none} on origin regardless of
  // specificity, so any component that sets its own display quietly stops responding to the
  // attribute — and the markup that declared it hidden paints anyway. styles.css had already
  // spot-patched this three times without anyone noticing four more live cases.
  //
  // So this doesn't pin a list. It derives one: every class/id in index.html that carries a bare
  // `hidden` attribute, cross-referenced against every rule in styles.css that gives that same
  // selector a display other than none. Anything in the intersection must also have an
  // X[hidden]{display:none} rule. Add a hideable component that styles its display and forget the
  // companion rule, and this fails before it ships.
  const fs = require("fs"), path = require("path");
  const css = fs.readFileSync(path.join(__dirname, "..", "public", "styles.css"), "utf8");
  const html = fs.readFileSync(path.join(__dirname, "..", "public", "index.html"), "utf8");

  const hideable = new Set();
  for (const [, attrs] of html.matchAll(/<\w+((?:"[^"]*"|'[^']*'|[^>"'])*)>/g)) {
    if (!/(^|\s)hidden(\s|$|=)/.test(attrs.replace(/aria-hidden/g, ""))) continue;
    const cls = /class="([^"]*)"/.exec(attrs), id = /id="([^"]*)"/.exec(attrs);
    if (cls) for (const c of cls[1].trim().split(/\s+/)) if (c) hideable.add("." + c);
    if (id) hideable.add("#" + id[1]);
  }
  assert.ok(hideable.size >= 20, `expected a real set of hideable elements, got ${hideable.size}`);

  const guarded = new Set();
  for (const m of css.matchAll(/(^|[\s,{}])([.#][\w-]+)\[hidden\]\s*\{[^}]*display\s*:\s*none/g)) guarded.add(m[2]);

  const unguarded = [];
  for (const m of css.matchAll(/(^|\})\s*([^{}@]+?)\s*\{([^}]*)\}/g)) {
    const body = m[3], d = /(?:^|;)\s*display\s*:\s*([\w-]+)/.exec(body);
    if (!d || d[1] === "none") continue;
    for (const part of m[2].split(",").map((x) => x.trim())) {
      if (!hideable.has(part) || guarded.has(part)) continue;
      unguarded.push(`${part} sets display:${d[1]} but has no ${part}[hidden]{display:none}`);
    }
  }
  assert.deepEqual([...new Set(unguarded)], [],
    "hideable elements that will paint despite the hidden attribute:\n  " + [...new Set(unguarded)].join("\n  "));

  // And the four that were live when this was written stay fixed by name, so a refactor that
  // guts the derivation above still can't quietly reintroduce them.
  for (const sel of [".btn", ".movers", ".filt-dot", ".regimestrip"])
    assert.ok(css.includes(`${sel}[hidden]{display:none}`), `regression: ${sel} lost its hidden guard`);
});

test("UI -24: session-wide controls live outside every per-view section", () => {
  // The alerts bell shipped inside #view-markets. showView() hides that whole section on any other
  // tab, so the bell AND its unread badge vanished the moment you left Markets — while alerts kept
  // firing from the poller, which is exactly when the badge is the only thing telling you.
  //
  // Same derivation shape as the [hidden] audit: rather than pinning "bellwrap is at line N", find
  // the byte span of every view section in index.html and assert no globally-scoped control id
  // falls inside one. Anything that must be reachable from every tab belongs to the shell.
  const fs = require("fs"), path = require("path");
  const html = fs.readFileSync(path.join(__dirname, "..", "public", "index.html"), "utf8");
  const app = require("./_client").clientSource();

  // Every id showView() toggles is a per-view section; derive the list from app.js so a new view
  // is covered the day it ships rather than the day someone remembers to add it here.
  const views = [...app.matchAll(/setHidden\('(view-[\w-]+)'/g)].map((m) => m[1]);
  assert.ok(views.length >= 8, `expected showView to toggle a real set of views, found ${views.length}`);

  const spans = [];
  for (const v of views) {
    const open = html.indexOf(`id="${v}"`);
    if (open < 0) continue;             // injected at runtime (treemap); nothing static to contain
    const start = html.lastIndexOf("<", open);
    let depth = 0, i = start;
    for (const m of html.slice(start).matchAll(/<(\/?)(?:div|section)\b[^>]*?(\/?)>/g)) {
      if (m[2] === "/") continue;
      depth += m[1] ? -1 : 1;
      if (depth === 0) { i = start + m.index + m[0].length; break; }
    }
    spans.push([v, start, i]);
  }
  assert.ok(spans.length >= 8, "could not resolve the view sections in index.html");

  // Controls the user must be able to reach or read from any tab.
  for (const id of ["bellBtn", "bellBadge", "alertpop", "helpBtn", "backBtn", "homeBtn", "logoutBtn", "tabSpacer", "focusChip", "freshtray"]) {
    const at = html.indexOf(`id="${id}"`);
    assert.ok(at > 0, `missing global control: ${id}`);
    const trapped = spans.find(([, s0, s1]) => at > s0 && at < s1);
    assert.ok(!trapped, `${id} is nested inside ${trapped && trapped[0]} — it will disappear on every other tab`);
  }

  // The bell sits in the status bar tray specifically: .tabs gets overflow-x:auto below 680px,
  // which would clip the 340px popup, so the tab strip is not an option for this one.
  const tray = html.slice(html.indexOf('class="st-right"'), html.indexOf("</div>", html.indexOf('class="st-right"')));
  assert.ok(tray.includes('id="bellBtn"'), "the bell belongs in the status bar tray");
  const css = fs.readFileSync(path.join(__dirname, "..", "public", "styles.css"), "utf8");
  assert.ok(/\.stbell\{/.test(css), "the bell needs its strip-scale variant or it towers over the status bar");
  assert.ok(/\.stbell \.bell-badge\{[^}]*position:static/.test(css), "the corner pip must re-flow inline at strip scale");
});

test("terminal ticker guard: English words never resolve to tickers mid-sentence — the confident-but-wrong fix", () => {
  // Extract TSTOP + termTickerish from the client and RUN them: "what's on the tape" must never
  // become the ON Semiconductor card; caps, $-prefix, and single-word queries stay intentional.
  const fs = require("fs"), path = require("path");
  const s = require("./_client").clientSource();
  const m = s.match(/const TSTOP=new Set\([\s\S]*?function termTickerish\(w,only\)\{[\s\S]*?\n\}/);
  assert.ok(m, "TSTOP + termTickerish not extractable from app.js");
  const tickerish = new Function(m[0] + "; return termTickerish;")();
  // blocked: lowercase English words inside a sentence (each collides with a plausible listing)
  for (const w of ["on", "all", "it", "now", "key", "up", "the", "a", "so", "are", "big", "open"])
    assert.equal(tickerish(w, false), false, `"${w}" lowercase mid-sentence must NOT be ticker-ish`);
  // allowed: explicit forms
  assert.equal(tickerish("ON", false), true, "CAPS is intentional");
  assert.equal(tickerish("$all", false), true, "$-prefix is intentional");
  assert.equal(tickerish("NVDA", false), true, "caps symbol passes");
  assert.equal(tickerish("nvda", false), true, "lowercase non-English token passes");
  assert.equal(tickerish("sol", false), true, "lowercase crypto habit passes");
  assert.equal(tickerish("now", true), true, "a single-word query is always intentional");
  // mixed case is a word, not a symbol; punctuation is stripped before judging
  assert.equal(tickerish("Its", false), false, "mixed case is prose");
  assert.equal(tickerish("hype?", false), true, "trailing punctuation stripped, token judged clean");
});

test("ask daily budget: cap enforced, only successful non-cached calls burn it, surfaced everywhere, chip wired", async () => {
  const fs = require("fs"), path = require("path");
  const pol = fs.readFileSync(path.join(__dirname, "..", "src", "poller.js"), "utf8");
  assert.ok(/ASK_REPORTS_PER_DAY = Math\.max\(1, Number\(process\.env\.ASK_MAX_PER_DAY\) \|\| 50\)/.test(pol), "ask daily cap must default to 50, env ASK_MAX_PER_DAY");
  assert.ok(pol.includes('error: "ask-daily-cap"'), "askBoard must fail closed with ask-daily-cap");
  assert.ok(pol.includes("askDay.count++;"), "a successful ask must burn budget");
  assert.ok(pol.includes("day: aiDay, askDay,"), "ask budget must persist with the report budget (redeploy can't refill)");

  const { createPoller } = require("../src/poller");
  const store = { loadAll: () => new Map(), loadRegime: () => [], loadLedger: () => null,
    saveLedger: () => {}, insert: () => {}, saveRegime: () => {}, saveNews: () => {}, loadNews: () => null };
  // injected transport (anthropic shape — no env key => provider anthropic)
  const answers = ["screen funding<0 & squeeze>50"];
  let calls = 0;
  const aiFetch = async () => { calls++; return { ok: true, json: async () => ({ content: [{ type: "text", text: answers[0] }], stop_reason: "end_turn" }) }; };
  // cap of 2 for a fast exhaustion test
  process.env.ASK_MAX_PER_DAY = "2";
  try {
    const p = createPoller({ dex: "xyz", store, log: () => {}, version: "test", crypto: false, aiFetch });
    const uni = [{ t: "SOL", sqz: 71, f: -22 }];
    const q = (s) => p.askBoard(s, { universe: uni });

    const a = await q("most crowded shorts?");
    assert.equal(a.ok, true); assert.equal(a.askPerDay, 2); assert.equal(a.askDayLeft, 1, "one spent -> 1 left");
    // a REPEAT of the same question is a cache hit — must NOT burn budget
    const callsBefore = calls;
    const aCached = await q("most crowded shorts?");
    assert.equal(aCached.cached, true, "identical question served from cache");
    assert.equal(calls, callsBefore, "cache hit made no model call");
    assert.equal(aCached.askDayLeft, 1, "cache hit did not burn budget");
    // a DIFFERENT question spends the last unit
    const b = await q("top funding names?");
    assert.equal(b.ok, true); assert.equal(b.askDayLeft, 0, "budget now exhausted");
    // next distinct question is capped BEFORE any model call
    const callsAtCap = calls;
    const capped = await q("what about momentum leaders?");
    assert.equal(capped.ok, false); assert.equal(capped.error, "ask-daily-cap", "exhausted -> ask-daily-cap");
    assert.equal(calls, callsAtCap, "a capped ask must not reach the model");
    assert.equal(capped.askDayLeft, 0);
    // health surfaces the budget
    const st = p.stats();
    assert.equal(st.ai.askPerDay, 2); assert.equal(st.ai.askDayLeft, 0, "health carries the live ask budget");
  } finally { delete process.env.ASK_MAX_PER_DAY; }

  // ---- client (Option B ambient chip) wiring ----
  const app = require("./_client").clientSource();
  assert.ok(app.includes("function renderAskBudget"), "ambient chip renderer missing");
  assert.ok(/renderAskBudget\(h\.ai\.askDayLeft, h\.ai\.askPerDay\)/.test(app), "chip must be fed by the health poll");
  assert.ok(app.includes("renderAskBudget(d.askDayLeft, d.askPerDay)"), "chip must update from each ask response");
  assert.ok(app.includes("'ask-user-cap'") && app.includes("your daily AI limit is reached"), "client must handle the per-user ask cap distinctly");
  assert.ok(app.includes("'ask-daily-cap'") && app.includes("the shared daily AI pool is exhausted"), "client must handle the shared-pool cap message");
  assert.ok(app.includes("ask calls left today") || app.includes("call':'calls'"), "analyst tail must show remaining ask budget");
  const html = fs.readFileSync(path.join(__dirname, "..", "public", "index.html"), "utf8");
  assert.ok(html.includes('id="termBudget"'), "terminal bar must contain the budget chip");
  const css = fs.readFileSync(path.join(__dirname, "..", "public", "styles.css"), "utf8");
  assert.ok(css.includes(".tp-budget") && css.includes(".tp-budget.out"), "chip CSS (incl. exhausted state) missing");
});

test("client: CASC column + drawer deriv panel wired, crypto-scoped, honestly labeled", () => {
  const fs = require("fs"), path = require("path");
  const s = require("./_client").clientSource();
  for (const fn of ["cascCell", "liq24Cell", "loadDrawerDerivs", "renderDerivs", "dzWire"]) {
    const n = [...s.matchAll(new RegExp("^(?:async )?function " + fn + "\\(", "gm"))].length;
    assert.equal(n, 1, `client function ${fn} must exist exactly once`);
  }
  assert.ok(s.includes("MAIN_ONLY_COLS") && s.includes("MAIN_ONLY_COLS.has(c.key)"), "cascT must be filtered out of the xyz scope like gap is out of crypto");
  assert.ok(s.includes("'cascT','liq24'"), "liq24 must be crypto-scoped alongside cascT");
  assert.ok(s.includes("'doi','sqz','cascT','liq24','carry'"), "cascT + liq24 in DEFAULT_ORDER");
  assert.ok(s.includes("key:'cascT'"), "column keys on the flat numeric sort field, not the object");
  assert.ok(s.includes("/api/derivs?coin=") && s.includes("/api/derivs/refresh"), "drawer fetch + manual refresh endpoints wired");
  assert.ok(s.includes("dderivs"), "drawer slot present for crypto rows");
  assert.ok(s.includes("not HL-native") || s.includes("not Hyperliquid-native"), "aggregated-CEX labeling must be permanent in the UI");
  assert.ok(s.includes("mousemove") && s.includes("dztip"), "shared-crosshair hover + tooltip wired on the panel charts");
  const css = fs.readFileSync(path.join(__dirname, "..", "public", "styles.css"), "utf8");
  for (const cls of [".dzchips", ".dzchip", ".dzsrc", ".dzdot", ".dzrefresh", ".dztip", ".dzfoot"])
    assert.ok(css.includes(cls), `deriv panel CSS class missing: ${cls}`);
});

test("-14 client: charts follow the scope selector; pivots selector exists and is wired", () => {
  const fs = require("fs"), path = require("path");
  const app = require("./_client").clientSource();
  for (const pin of [
    "attachStudyScope('pvsel','pivots')",                       // the missing selector, wired
    "studyScopeSel('pvsel'",                                    // and rendered
    "const chartSrc=(one&&one.buckets)?one:lv;",                // levels chart follows the scope
    "one&&one.mfeHist?Object.assign(",                          // anatomy histogram follows the scope
    "one&&one.pivots?Object.assign({basis:esc(one.ticker)},one.pivots):an.pivots", // pivots too
    "has too few sd-scored sessions for its own histogram",     // honest under-floor fallback, anatomy
    "has too few sessions for its own histogram",               // honest under-floor fallback, pivots
    "m.basis||'sd-scored ticker-sessions'",                     // n-basis label switches in the SVG tips
  ]) assert.ok(app.includes(pin), `app.js missing -14 pin: ${pin}`);
  const pol = fs.readFileSync(path.join(__dirname, "..", "src", "poller.js"), "utf8");
  assert.ok(pol.includes("buckets: one.buckets, far: one.far, cellFloor: one.cellFloor"),
    "poller ships per-name distance buckets for the levels chart");
});

// ===== build 2026.07.24-15: sessions tab grouped into collapsible sections =====
// One status line replaces the coverage cards + readiness bar at 100% ready, a sticky jump bar
// replaces blind scroll, five groups replace the flat stack, group verdicts come from the same
// section payloads the panels render, and pending studies fold into their group as dimmed rows.

test("-15 sessions groups: collapse behavior, persistence, dimmed all-pending groups", () => {
  const fs = require("fs"), path = require("path");
  const app = require("./_client").clientSource();
  const grab = (name) => {
    const i = app.indexOf("function " + name + "(");
    assert.ok(i >= 0, "missing " + name);
    let d = 0, j = app.indexOf("{", i);
    for (let k = j; k < app.length; k++) { if (app[k] === "{") d++; if (app[k] === "}") { d--; if (!d) return app.slice(i, k + 1); } }
  };
  const sgGroups = app.match(/const SESS_GROUPS=\[[\s\S]*?\];/);
  const sgKey = app.match(/const SG_KEY='[^']*';/);
  assert.ok(sgGroups && sgKey, "SESS_GROUPS + SG_KEY both defined");
  const sgConsts = [sgGroups[0] + "\n" + sgKey[0]];
  const R = new Function(
    "const saved={};\nconst store={get:k=>saved[k]??null,set:(k,v)=>{saved[k]=v;}};\n" +
    "const state={analytics:{}};\nlet redraws=0;\nfunction drawSessions(){redraws++;}\n" +
    sgConsts[0] + "\n" + grab("sgOpenSet") + "\n" + grab("sgToggle") + "\n" +
    grab("sgPendRow") + "\n" + grab("sgSection") + "\n" +
    "return {sgOpenSet,sgToggle,sgSection,sgPendRow,saved,state,redrawCount:()=>redraws};")();
  // default open set (no saved state): EXACTLY positioning + holds, everything else collapsed
  const open0 = R.sgOpenSet();
  assert.deepEqual([...open0].sort(), ["holds", "positioning"], "default opens exactly positioning + holds");
  assert.ok(!open0.has("clocks") && !open0.has("week") && !open0.has("structure"), "the rest collapsed by default");
  // open section renders its body; collapsed section hides it (content still in the DOM)
  const openHtml = R.sgSection("holds", "Holds", "overnight +4% net", [{ html: "<i>LIVE</i>" }]);
  assert.ok(openHtml.includes('aria-expanded="true"') && !openHtml.includes(" hidden>"), "open group shows body");
  const closedHtml = R.sgSection("clocks", "Clocks", "busiest 15:00 ET", [{ html: "<i>LIVE</i>" }]);
  assert.ok(closedHtml.includes('aria-expanded="false"') && closedHtml.includes(" hidden>") && closedHtml.includes("LIVE"),
    "collapsed group hides but still carries its body");
  // a group with zero live studies dims and stays visible — nothing pending is hidden
  const pendHtml = R.sgSection("week", "Week", "computing", [{ pend: R.sgPendRow("Day-of-week", "computing — needs 3 (have 1)", "") }]);
  assert.ok(pendHtml.includes("sg-dim") && pendHtml.includes("pending"), "all-pending group dims, discloses state");
  // toggling persists to storage and triggers a redraw
  R.sgToggle("clocks");
  assert.ok(JSON.parse(R.saved["xyz-sessgroups2"]).includes("clocks"), "open state persisted per browser");
  assert.equal(R.redrawCount(), 1, "toggle redraws");
  R.sgToggle("clocks");
  assert.ok(!JSON.parse(R.saved["xyz-sessgroups2"]).includes("clocks"), "collapse persisted too");
});

test("-15 client + styles manifest: status line, sticky jump bar, verdicts from section payloads", () => {
  const fs = require("fs"), path = require("path");
  const app = require("./_client").clientSource();
  for (const pin of [
    'class="sg-status"',                                     // coverage cards + readiness bar collapse to one line
    "full numbers stay on hover",                            // and the detail is not lost, it moves to the tooltip
    'class="jumpbar"', 'data-j="${g.id}"', 'data-g="${id}"', // jump chips + group headers
    "['positioning','holds']",                               // default open set
    "store.set(SG_KEY",                                      // persistence, same store the tab order uses
    "const vPositioning=", "const vHolds=", "const vClocks=", "const vWeek=", "const vStructure=",  // verdicts exist
    "sd.sessions||{}",                                       // ...and read the SAME section objects the panels render
    "hc.pooled&&hc.pooled.all",
    "dow.pooled&&dow.pooled.all",
    "lv.overall.excess",
    "WD_NAMES[bd]",                                          // week verdict uses the heatmap's own day labels
    "computing \\u2014 needs",                               // pending rows keep the honest unlock wording
    "All ${nStudies} studies live",                               // the all-live footer survives the redesign
  ]) assert.ok(app.includes(pin), `app.js missing -15 pin: ${pin}`);
  assert.ok(!app.includes("On deck"), "the separate deck block is gone");
  const css = fs.readFileSync(path.join(__dirname, "..", "public", "styles.css"), "utf8");
  for (const pin of [".jumpbar{position:sticky", ".jchip.on{", ".sg-h{", ".sg-v{", ".sg-b{", ".sg-pend{", ".sg.sg-dim{"])
    assert.ok(css.includes(pin), `styles.css missing -15 rule: ${pin}`);
});

// ===== build 2026.07.24-16: signals stats sections collapse by default =====
// The audit's subsections (by-event table, slices, equity curve, self-tuning, strategy shadows,
// recent resolutions) and the Record-by-event strip each render as a collapsed header until
// clicked; the choice persists per browser. Collapsed content is absent from the DOM but every
// header names its section — nothing is curated away, one click opens any of it.

test("-16 sigSec: collapsed by default, opens from the persisted set, toggle round-trips", () => {
  const fs = require("fs"), path = require("path");
  const src = require("./_client").clientSource();
  const grabAt = (sig) => { const i = src.indexOf(sig); assert.ok(i >= 0, sig + " missing");
    let d = 0, j = src.indexOf("{", i);
    for (let k = j; k < src.length; k++) { if (src[k] === "{") d++; if (src[k] === "}") { d--; if (!d) return src.slice(i, k + 1); } } };
  const saved = {};
  const localStorage = { getItem: (k) => saved[k] ?? null, setItem: (k, v) => { saved[k] = v; } };
  let redraws = 0; const renderSignals = () => { redraws++; };
  const SIGSEC_KEY = "xyz-sigsecs";
  const sigSecOpen = eval("(" + grabAt("function sigSecOpen()") + ")");
  const sigSecToggle = eval("(" + grabAt("function sigSecToggle(id)") + ")");
  const sigSec = eval("(" + grabAt("function sigSec(id,cls,label,tip,body)") + ")");
  // default: nothing open — the body string is NOT in the output, the named header is
  const closed = sigSec("tuning", "sigrec-sub", "self-tuning (shadow variants)", "tip", "<i>BODY</i>");
  assert.ok(closed.includes('aria-expanded="false"') && closed.includes("self-tuning") && !closed.includes("BODY"),
    "collapsed by default: header only, body absent");
  // open via toggle: persisted, redrawn, body present
  sigSecToggle("tuning");
  assert.ok(JSON.parse(saved["xyz-sigsecs"]).includes("tuning") && redraws === 1, "toggle persists and redraws");
  const open = sigSec("tuning", "sigrec-sub", "self-tuning (shadow variants)", "tip", "<i>BODY</i>");
  assert.ok(open.includes('aria-expanded="true"') && open.includes("BODY"), "open section renders its body");
  sigSecToggle("tuning");
  assert.ok(!JSON.parse(saved["xyz-sigsecs"]).includes("tuning"), "collapse round-trips");
});

test("-16 client manifest: every stats section behind sigSec, strip included, toggles bound", () => {
  const fs = require("fs"), path = require("path");
  const app = require("./_client").clientSource();
  for (const id of ["evtable", "slices", "curve", "tuning", "shadows", "resolutions", "recstrip"])
    assert.ok(app.includes(`sigSec('${id}'`), `section '${id}' renders through sigSec`);
  for (const pin of [
    "const SIGSEC_KEY='xyz-sigsecs'",
    "box.querySelectorAll('[data-sigsec]')",                  // click + keyboard binding lives in bindSigControls
    "'recstrip','dsec','Record by event'",                    // the strip keeps its dsec header styling
    "shadow claims only \\u2014 never shown as live signals", // the shadows footnote survives inside its section
  ]) assert.ok(app.includes(pin), `app.js missing -16 pin: ${pin}`);
  const css = fs.readFileSync(path.join(__dirname, "..", "public", "styles.css"), "utf8");
  assert.ok(css.includes(".sigsec-h{cursor:pointer"), "styles.css missing .sigsec-h");
});
test("-17 regression: drawSessions EXECUTES and renders for both universes (no ReferenceError)", () => {
  const fs = require("fs"), path = require("path");
  const app = require("./_client").clientSource();
  const { els, mk } = _sessDomStub();
  const saved = { si: global.setInterval, st: global.setTimeout, raf: global.requestAnimationFrame,
    doc: global.document, win: global.window, ls: global.localStorage, f: global.fetch };
  // neutralize timers so evaluating the client can't keep the test runner alive
  global.setInterval = () => 0; global.setTimeout = () => 0; global.requestAnimationFrame = () => 0;
  global.document = { getElementById: (id) => (els[id] = els[id] || mk(id)), querySelectorAll: () => [], querySelector: () => null,
    createElement: mk, addEventListener() {}, body: mk("body"), documentElement: mk("html"), hidden: false };
  global.window = { addEventListener() {}, location: { reload() {}, href: "/" }, matchMedia: () => ({ matches: false, addEventListener() {} }) };
  global.localStorage = { _d: {}, getItem(k) { return this._d[k] ?? null; }, setItem(k, v) { this._d[k] = String(v); }, removeItem(k) { delete this._d[k]; } };
  // Never-settling fetch: evaluating the client kicks off its boot polls. If those promises resolve
  // after this test restores the globals, they touch a torn-down document and surface as an
  // unhandledRejection. Stalling them forever keeps the boot chain inert — we drive drawSessions directly.
  global.fetch = () => new Promise(() => {});
  try {
    const api = new Function(app + "\n;return { drawSessions: typeof drawSessions!=='undefined'?drawSessions:null, state: typeof state!=='undefined'?state:null };")();
    assert.ok(api.drawSessions && api.state, "client exposes drawSessions + state");
    for (const isCrypto of [false, true]) {
      api.state.scope = isCrypto ? "crypto" : "stocks";
      api.state.view = "sessions";
      api.state.analytics.data = _sessPayload(isCrypto);
      api.state.analytics.err = null;
      const host = global.document.getElementById("sessions-body");
      host.innerHTML = "";
      api.drawSessions();   // must not throw — this is the assertion that -17 needed
      const html = host.innerHTML;
      const label = isCrypto ? "crypto" : "stocks";
      assert.ok(html.length > 1000, `${label}: drawSessions must emit real markup (got ${html.length} chars)`);
      assert.ok(!/warming up the spines/.test(html), `${label}: must not fall back to the warming message with a full payload`);
      assert.ok(/sg-h|sg-b|jumpbar/.test(html), `${label}: collapsible group scaffold must render`);
      assert.ok(/Session decomposition/.test(html), `${label}: the flagship study must render`);
      // universe-correct framing, proving the payload actually drove the render
      if (isCrypto) { assert.ok(/UTC day/.test(html), "crypto: UTC-day leg rendered"); assert.ok(!/\bET hour\b/.test(html), "crypto: no ET axis leakage"); }
      else assert.ok(/Overnight/.test(html), "stocks: overnight framing rendered");
    }
  } finally {
    global.setInterval = saved.si; global.setTimeout = saved.st; global.requestAnimationFrame = saved.raf;
    global.document = saved.doc; global.window = saved.win; global.localStorage = saved.ls;
    global.fetch = saved.f;
  }
});

// ===== build 2026.07.24-20: crypto publishes fewer groups; thin per-name tables fall back ========
test("-20: crypto renders only Positioning + Holds; stocks keeps all five groups", () => {
  const fs = require("fs"), path = require("path");
  const app = require("./_client").clientSource();
  const pol = fs.readFileSync(path.join(__dirname, "..", "src", "poller.js"), "utf8");
  // server declares the set once, per universe, and skips building the disabled studies
  assert.ok(pol.includes('groups: ["positioning", "holds", "structure"],'), "crypto descriptor publishes three groups since -27");
  assert.ok(pol.includes('on("structure") && on("clocks") ? buildClusters(hourClock)'), "clusters gate on clocks too — no eternal pending on a clock-less universe");
  assert.ok(pol.includes('groups: ["positioning", "holds", "clocks", "week", "structure"],'), "stocks keeps five");
  assert.ok(pol.includes("groups: U.groups.slice(),"), "the group set ships in the payload");
  for (const gated of ['on("clocks") ? buildActivityClocks(U) : DISABLED',
    'on("week") ? buildDowHeatmap(U) : DISABLED', 'on("structure") && on("clocks") ? buildClusters(hourClock)',
    'on("clocks") ? buildSeasonality(U) : DISABLED', 'on("structure") ? buildLevelsStudy(U) : DISABLED'])
    assert.ok(pol.includes(gated), `study must be group-gated, not built and hidden: ${gated}`);
  // client renders exactly the published set — no hard-coded five-group chain
  assert.ok(app.includes("function sessGroups()"), "client resolves the group set from the payload");
  assert.ok(app.includes("const groups = sessGroups().map(g=>GROUP_BODY[g.id]()).join('');"), "group assembly is payload-driven");
  assert.ok(app.includes("sessGroups().map(g=>`<button type=\"button\" class=\"jchip\"") , "jump bar follows the published set");
  // a disabled study must render NOTHING — not a "computing" row promising it later
  for (const g of ["!hc.disabled", "!dow.disabled", "!cl.disabled", "!lv.disabled", "se.disabled"])
    assert.ok(app.includes(g), `client must treat disabled as absent: ${g}`);
  // the study count is derived, never hard-coded (crypto would otherwise claim eleven)
  assert.ok(app.includes("const nStudies = 1/*regime*/+4"), "study count derived from the group set");
  assert.ok(!/All \$\{isCr\?'ten':'eleven'\}/.test(app), "no hard-coded ten/eleven claim survives");
});

test("-20: a per-name scope under the sample floor falls back to pooled instead of a dash wall", () => {
  const fs = require("fs"), path = require("path");
  const app = require("./_client").clientSource();
  // the fallback helpers exist and every thin-cell table consults them
  assert.ok(app.includes("function _anyCell(") && app.includes("function _fbNote("), "fallback helpers defined");
  for (const fb of ["const qFallback=", "const moFallback=", "const nkFallback=", "const cbFallback=", "const cvFallback="])
    assert.ok(app.includes(fb), `missing fallback gate: ${fb}`);
  // and each one labels itself rather than silently swapping scope under a per-name header
  // four notes for five gates: the weekly-container and naked-open fallbacks share one line
  assert.equal((app.match(/_fbNote\(/g) || []).length - 1, 4, "four labeled fallback notes (helper definition excluded)");
  // the floor itself must NEVER be lowered — that would be the false precision this app refuses
  const cmp = fs.readFileSync(path.join(__dirname, "..", "src", "compute.js"), "utf8");
  assert.ok(/const minN = Number\.isFinite\(o\.minN\) \? o\.minN : 20;/.test(cmp), "the per-bucket sample floor is unchanged");
  assert.ok(/rate = \(arr\) => arr\.length >= minN \?/.test(cmp), "rates below the floor still return null");
  // med day range is pooled-only: the column is omitted per-name, never rendered as dashes
  assert.ok(app.includes("const qMed=!qScope;"), "med-range column omitted in per-name scope");
});

test("tabs: every HIDDEN_TABS entry matches a real nav button, and every hidden tab stays URL-reachable", () => {
  // The source-grep guard above proves the strings exist in each file; it does NOT prove they
  // refer to each other. A typo on either side — data-view="actionables", or HIDDEN_TABS holding
  // 'action' — passes that guard and ships a visible tab. This test joins the two files.
  const fs = require("fs"), path = require("path");
  const html = fs.readFileSync(path.join(__dirname, "..", "public", "index.html"), "utf8");
  const app = require("./_client").clientSource();
  const nav = html.match(/<nav class="tabs"[\s\S]*?<\/nav>/);
  assert.ok(nav, "nav.tabs block not found — applyTabVisibility's selector would find nothing");
  const views = [...nav[0].matchAll(/data-view="([a-z]+)"/g)].map((m) => m[1]);
  assert.ok(views.length >= 10, `suspiciously few nav tabs: ${views.length}`);
  // The hide list moved server-side in -05: the manifest's admin-state tabs are the hidden set now.
  const C = require("../src/compute");
  const hidden = C.FEATURES.filter((f) => f.kind === "tab" && !f.runtime && C.featureState({}, f.key) === "admin").map((f) => f.key);
  assert.ok(hidden.length >= 1, "at least one tab is expected to be admin-only by default");
  // Join: no orphan hide entries, and each intended tab really is covered.
  for (const h of hidden)
    assert.ok(views.includes(h), `the manifest gates tab '${h}' but no nav button has data-view="${h}" — the gate is a no-op`);
  for (const want of ["backtest", "actionable"])
    assert.ok(hidden.includes(want) && views.includes(want), `${want} must be present in the nav AND gated by the manifest`);
  // The applier must key off the same attribute the markup uses.
  assert.ok(/tabVisible\(t\.dataset\.view\)/.test(app), "applyTabVisibility must match on dataset.view, the attribute the nav actually carries");
  assert.ok(/document\.querySelector\('nav\.tabs'\)/.test(app), "applyTabVisibility must query the nav that exists in the markup");
  // Hiding a tab must never strand it: each hidden view has to remain routable by hash.
  const hv = app.match(/const HASH_VIEWS=new Set\(\[([^\]]*)\]\)/);
  assert.ok(hv, "HASH_VIEWS not found");
  const routable = hv[1].split(",").map((x) => x.trim().replace(/'/g, "")).filter(Boolean);
  // Still required, with a changed meaning: HASH_VIEWS stays complete so an ADMIN's #backtest resolves.
  // The gate is applied at dispatch (applyHash checks tabVisible), not by shortening the routing table.
  for (const h of hidden)
    assert.ok(routable.includes(h), `gated tab '${h}' is not in HASH_VIEWS — an admin's deep link would dead-end`);
  // And every nav tab should be routable, hidden or not, so a shared link never dead-ends.
  for (const v of views)
    assert.ok(routable.includes(v), `nav tab '${v}' has no hash route — #${v} would silently do nothing`);
  // Each hidden view must still have its section, or showView bounces to markets.
  for (const h of hidden)
    assert.ok(html.includes(`id="view-${h}"`), `hidden tab '${h}' has no view section — showView would redirect to markets`);
});

// ===== admin panel, phase 0: the manifest is the single source of truth =========================
test("features: manifest covers every tab in the markup, and every entry is real", () => {
  const fs = require("fs"), path = require("path");
  const C = require("../src/compute");
  const html = fs.readFileSync(path.join(__dirname, "..", "public", "index.html"), "utf8");
  const app = require("./_client").clientSource();

  const keys = new Set(C.FEATURES.map((f) => f.key));
  assert.equal(keys.size, C.FEATURES.length, "duplicate key in FEATURES — two entries would fight over one state");

  // Markup -> manifest. THIS is the assertion that makes fail-closed safe: ship a tab without an
  // entry and the suite fails here, instead of the tab being silently invisible to the group.
  const tabs = [...html.matchAll(/data-view="([a-z]+)"/g)].map((m) => m[1]);
  for (const v of new Set(tabs))
    assert.ok(keys.has(v), `tab "${v}" exists in index.html but has no FEATURES entry — add one (fail-closed would hide it silently)`);

  // Manifest -> markup, for the static tabs only. runtime:true entries are injected by JS
  // (Treemap self-installs on DOMContentLoaded) so they legitimately have no data-view in the file.
  for (const f of C.FEATURES) {
    if (f.kind !== "tab" || f.runtime) continue;
    assert.ok(tabs.indexOf(f.key) >= 0, `FEATURES lists tab "${f.key}" but index.html has no data-view for it — dead entry`);
    assert.ok(html.includes(`id="view-${f.key}"`), `FEATURES tab "${f.key}" has no view section`);
  }
  for (const f of C.FEATURES) {
    if (f.kind !== "tab" || !f.runtime) continue;
    assert.ok(app.includes(`'view-${f.key}'`) || app.includes(`view-${f.key}`), `runtime tab "${f.key}" is claimed to self-install but app.js never builds view-${f.key}`);
  }

  // Every tab reachable from the command palette must be in the manifest too. Cmd+K is a SECOND
  // way into a view: hiding the tab button while leaving the palette entry ungated would let a
  // public user walk straight into an admin tab.
  const cm = app.match(/const CMDK_TABS=\[[\s\S]*?\];/);
  assert.ok(cm, "CMDK_TABS list not found — the palette is a second entry point and must stay auditable");
  for (const m of cm[0].matchAll(/\{v:'([a-z]+)'/g))
    assert.ok(keys.has(m[1]), `command palette offers "${m[1]}" which has no FEATURES entry`);

  // HIDDEN_TABS is gone as of 2026.07.26-05 — the manifest is the only tab-visibility list. The
  // agreement assertion that used to live here became "there is nothing left to agree with", which
  // is pinned in the manifest-owns-visibility test instead.
  assert.ok(!/HIDDEN_TABS/.test(app), "a second tab-visibility list must not reappear beside the manifest");

  // kind and state vocabulary are closed sets; a typo'd def would resolve through to FEATURE_DEFAULT
  // and quietly hide a feature that was meant to be public. "scope" joined at 2026.08.03-02: a
  // per-universe slice of a parent tab — no tab of its own, no route of its own.
  for (const f of C.FEATURES) {
    assert.ok(f.kind === "tab" || f.kind === "act" || f.kind === "scope", `entry "${f.key}" has unknown kind "${f.kind}"`);
    assert.ok(C.FEATURE_STATES.indexOf(f.def) >= 0, `entry "${f.key}" has invalid default "${f.def}"`);
    assert.ok(f.label && f.label.length <= 32, `entry "${f.key}" needs a short human label`);
    if (f.kind === "scope") {
      const p = C.FEATURES.find((x) => x.key === f.parent);
      assert.ok(p && p.kind === "tab", `scope "${f.key}" must name an existing TAB parent (got "${f.parent}")`);
      assert.equal((f.routes || []).length, 0, `scope "${f.key}" must own no route — the parent's gate is the outer wall, the scope filters payload rows`);
      assert.ok(/\.(cx|eq)$/.test(f.key), `scope "${f.key}" must end in .cx or .eq — the filters key off that suffix`);
      assert.ok(f.key.startsWith(f.parent + "."), `scope "${f.key}" must be namespaced under its parent`);
    }
  }
  // The scope roster itself is pinned: these four keys with these defaults ARE the standing intent
  // (crypto slice public, equity slice admin). Adding a scope is fine; silently changing a default
  // flips what the public sees on deploy and must show up here as a deliberate edit.
  for (const [k, d] of [["signals.cx", "public"], ["signals.eq", "admin"], ["actionable.cx", "public"], ["actionable.eq", "admin"]]) {
    const f = C.FEATURES.find((x) => x.key === k);
    assert.ok(f && f.kind === "scope", `scope entry "${k}" missing from the manifest`);
    assert.equal(f.def, d, `scope "${k}" default drifted from the standing intent`);
  }
});

test("client flags: tabVisible is the single composition point and every entry path uses it", () => {
  const fs = require("fs"), path = require("path");
  const s = require("./_client").clientSource();
  // Reads the injected set; never re-derives a visibility from a raw flag.
  assert.ok(/const FLAGS = \(window\.__FLAGS && typeof window\.__FLAGS==='object'\) \? window\.__FLAGS : null;/.test(s), "FLAGS must read the injected set defensively");
  assert.ok(/const IS_ADMIN = !!window\.__ADMIN;/.test(s), "IS_ADMIN marker must be read");
  // Fail OPEN on a missing injection, deliberately: the shell is no-store so it should be impossible,
  // and the server gate is authoritative — a cosmetic leak beats an app with no tabs at all.
  // Reads FLAGS_VIEW (not FLAGS) since -06, so "view as public" can swap the whole resolved set in
  // one assignment. Still degrades to visible when nothing was injected.
  assert.ok(/function featureOn\(key\)\{ return FLAGS_VIEW \? !!FLAGS_VIEW\[key\] : true; \}/.test(s), "featureOn must read FLAGS_VIEW and degrade to visible when injection is absent");
  assert.ok(/let FLAGS_VIEW = FLAGS;/.test(s), "FLAGS_VIEW must start as the injected set");
  assert.ok(/function tabVisible\(v\)\{ if\(v==='admin'\) return IS_ADMIN; return viewInScope\(v\) && featureOn\(v\); \}/.test(s),
    "tabVisible must compose scope AND flags, with the panel itself keyed off IS_ADMIN");
  // The view predicate must NOT be called inScope: that name belongs to the ROW predicate, and a
  // hoisted redefinition made activeRows() return zero rows in crypto scope (the -05 blackout).
  assert.ok(/function viewInScope\(v\)/.test(s), "the view-scope predicate must be named viewInScope");
  assert.ok(/function inScope\(r\)\{ return \(r\.uni==='main'\)===\(state\.scope==='crypto'\); \}/.test(s),
    "the row-scope predicate must survive untouched — activeRows() feeds the board through it");
  for (const [what, re] of [
    ["nav strip", /t\.hidden = !tabVisible\(t\.dataset\.view\)/],
    ["showView", /if\(!tabVisible\(v\)\)\{[\s\S]{0,600}?v='markets'; \}/],
    ["applyScope", /if\(!tabVisible\(state\.view\)\) \{ showView\('markets'\); \}/],
    ["hash deep link", /HASH_VIEWS\.has\(h\) && tabVisible\(h\)/],
    ["command palette", /cmdkTabs\(\)\.filter\(t=>tabVisible\(t\.v\)/],
    ["treemap installer", /btn\.hidden = !tabVisible\('treemap'\)/],
    ["treemap deep link", /==='treemap' && typeof showView==='function' && tabVisible\('treemap'\)/],
  ]) assert.ok(re.test(s), `${what} must route its visibility decision through tabVisible`);
  // Exactly one crypto scope list, and none of the old longhand per-tab comparisons may survive
  // anywhere — those duplicates are what drifted apart before.
  assert.equal((s.match(/const CRYPTO_VIEWS=new Set\(/g) || []).length, 1, "exactly one crypto scope list");
  assert.ok(!/dataset\.view!=='(markets|trend|report|corr|backtest|sessions)'/.test(s), "no longhand per-tab scope comparison may survive");
  assert.ok(!/v!=='report' && v!=='corr'/.test(s), "showView's inline crypto gate must be gone");
  // markets is the fallback target, so it must be un-gateable — asserted at the manifest, because a
  // gateable fallback would let a public user bounce into a view they cannot see and render nothing.
  const C = require("../src/compute");
  assert.equal(C.featureState({ markets: "off" }, "markets"), "public", "the showView fallback target must be pinned public");
});

test("admin panel: markup, wiring and the no-draft-state write path are all present", () => {
  const fs = require("fs"), path = require("path");
  const app = require("./_client").clientSource();
  const html = fs.readFileSync(path.join(__dirname, "..", "public", "index.html"), "utf8");
  const css = fs.readFileSync(path.join(__dirname, "..", "public", "styles.css"), "utf8");
  // Markup: tab, section, and every id the renderer writes into.
  assert.ok(html.includes('data-view="admin"') && html.includes('id="view-admin"'), "admin tab + section must exist");
  for (const id of ["adm-count", "adm-prev", "adm-rows", "adm-foot", "admVap"])
    assert.ok(html.includes('id="' + id + '"'), `admin panel markup missing #${id}`);
  // Wiring: dispatch, visibility, and the double-check that a non-admin can never open it even if the
  // markup is present (a forged xyzadmin=1 marker gets an empty tab, never data).
  assert.ok(/setHidden\('view-admin', v!=='admin'\)/.test(app), "showView must toggle the admin section");
  assert.ok(/if\(v==='admin'\)\{ if\(el\('view-admin'\)&&IS_ADMIN\) openAdmin\(\); else \{ showView\('markets'\); return; \} \}/.test(app),
    "showView must refuse the admin view when the caller is not admin");
  assert.ok(/async function openAdmin\(\)\{ if\(!IS_ADMIN\) return;/.test(app), "openAdmin must guard on IS_ADMIN");
  assert.ok(app.includes("fetchJSON('/api/features')"), "the panel must read its state from the server");
  // No save button: each toggle writes one key, optimistically, and rolls back on refusal. A draft
  // state is another way for the panel and the server to disagree.
  assert.ok(/row\.state=state; _admBusy=key; renderAdmin\(\);/.test(app), "the write must paint optimistically");
  assert.ok((app.match(/row\.state=prev;/g) || []).length >= 2, "both the HTTP-failure and network-failure paths must roll back");
  assert.ok(/_adm=d\.features\|\|_adm;/.test(app), "the panel must reconcile with the server's resolved state, not the requested one");
  assert.ok(!/adm-save|admSave/.test(app), "there must be no save button — writes are immediate");
  // view-as-public swaps a server-resolved set, and never strands the operator on a gated view.
  assert.ok(/FLAGS_VIEW = _admVap \? \(_adm\.resolvedPublic\|\|FLAGS\) : FLAGS;/.test(app), "the toggle must swap in the server-resolved public set");
  assert.ok(/if\(!tabVisible\(state\.view\)\) showView\('markets'\);/.test(app), "toggling must rescue the active view if it becomes gated");
  assert.ok(app.includes("el('admVap'); if(vb) vb.addEventListener('click',toggleViewAsPublic)"), "the toggle must be wired null-safely");
  // The panel uses the app's real toast helper. `toast(...)` does not exist and would throw at the
  // exact moment a write failed — i.e. only in the path nobody exercises by hand.
  assert.ok(app.includes("pushToast('Could not change "), "failure path must use pushToast, the function that actually exists");
  assert.ok(!/[^h]\btoast\('/.test(app), "no call to a non-existent toast() helper may survive");
  // Hover on every row: the key + route list is the load-bearing detail, per the standing requirement
  // that every element carrying data responds to hover.
  assert.ok(css.includes(".adm-row:hover"), "rows must respond to hover");
  assert.ok(css.includes(".adm-row:hover .adm-key"), "the key/route line must surface on hover");
  // States must be readable as words, not colour alone — the amber theme recolours everything.
  assert.ok(/\.adm-b\.on\.public|\.adm-b\.on\.admin|\.adm-b\.on\.off/.test(css), "each state needs its own style");
  assert.ok(/>'\+v\+'</.test(app) || app.includes("+v+'</button>"), "each control must print its state as a word");
});

test("scope isolation: neither board ever shows the other universe's rows, executed not pinned", () => {
  // The payload carries both universes on purpose — one build, one ETag, per-universe transport
  // lanes. Every surface that consumes it must then re-scope, and the failure mode is not a blank
  // screen: it is crypto cards sitting directly above an equity track record, or an equity setup
  // competing on R:R inside a crypto ranking. Both look entirely normal and are silently wrong,
  // which is why this executes the real filter expressions instead of pinning their source.
  const fs = require("fs"), path = require("path");
  const src = require("./_client").clientSource();

  // The two filters, lifted verbatim from the shipped client and run against a mixed payload.
  const sigFilter = (signals, scope) => {
    const wantUni = scope === 'crypto' ? 'main' : 'xyz';
    return signals.filter(g => g.uni === wantUni);
  };
  const actFilter = (rows, scope) => {
    const wantU = scope === 'crypto' ? 'crypto' : 'stocks';
    return rows.filter(r => r.uni === wantU);
  };
  // ...and the source must contain exactly these expressions, so the copies above cannot drift
  // into testing something the client does not do.
  assert.ok(src.includes("const wantUni = state.scope === 'crypto' ? 'main' : 'xyz';") &&
    src.includes("const scoped = d.signals.filter(g => g.uni === wantUni);"),
    "the signals card filter ships in the form under test");
  assert.ok(src.includes("const wantU=state.scope==='crypto'?'crypto':'stocks';") &&
    src.includes("(d.rows||[]).filter(r=>r.uni===wantU&&"),
    "the actionable row filter ships in the form under test");

  // Signals: the payload's universe tag is 'main' / 'xyz' (the poller's own row key).
  const signals = [
    { coin: "ETH", uni: "main", ev: "casc" }, { coin: "SOL", uni: "main", ev: "bigmove" },
    { coin: "xyz:NVDA", uni: "xyz", ev: "gap" }, { coin: "xyz:AAPL", uni: "xyz", ev: "prem" },
  ];
  assert.deepEqual(sigFilter(signals, "stocks").map((g) => g.coin), ["xyz:NVDA", "xyz:AAPL"],
    "stocks scope shows only equity cards");
  assert.deepEqual(sigFilter(signals, "crypto").map((g) => g.coin), ["ETH", "SOL"],
    "crypto scope shows only crypto cards");
  // the crypto-native and xyz-only events specifically must not cross over
  assert.ok(!sigFilter(signals, "stocks").some((g) => g.ev === "casc"), "cascade never appears under a stocks board");
  assert.ok(!sigFilter(signals, "crypto").some((g) => g.ev === "gap" || g.ev === "prem"),
    "gap and premium never appear under a crypto board");

  // Actionable: the board's tag is 'crypto' / 'stocks' (the row is already display-shaped). Two
  // different vocabularies for the same split, which is exactly how a copy-pasted filter goes
  // wrong — the wrong key silently matches nothing and the board renders empty.
  const rows = [
    { coin: "ETH", uni: "crypto", side: "long" }, { coin: "xyz:NVDA", uni: "stocks", side: "long" },
  ];
  assert.deepEqual(actFilter(rows, "crypto").map((r) => r.coin), ["ETH"], "crypto board: crypto rows only");
  assert.deepEqual(actFilter(rows, "stocks").map((r) => r.coin), ["xyz:NVDA"], "stocks board: equity rows only");
  assert.equal(actFilter(rows, "crypto").length + actFilter(rows, "stocks").length, rows.length,
    "the two scopes partition the board exactly — no row is dropped by both filters, none counted twice");

  // A scope flip must REPAINT, or the filter is correct and invisible for up to a poll interval.
  assert.ok(src.includes("if(state.view==='signals') renderSignals();") &&
    src.includes("if(state.view==='actionable') renderActionable();"),
    "applyScope repaints both scoped boards on a flip");

  // Both tabs are reachable in crypto scope in the first place.
  assert.ok(/CRYPTO_VIEWS=new Set\(\[[^\]]*'signals'[^\]]*\]\)/.test(src) &&
    /CRYPTO_VIEWS=new Set\(\[[^\]]*'actionable'[^\]]*\]\)/.test(src),
    "Signals and Actionable are in scope for crypto");
});

test("client: the alert pull rides the snapshot poll and is not gated on the setup toggle", () => {
  const fs = require("fs"), path = require("path");
  const app = require("./_client").clientSource();

  // The alertVer check must sit BEFORE applySnapshot's unchanged-dataTs early return, or an idle
  // board skips the alert pull precisely when it matters.
  const fn = app.slice(app.indexOf("function applySnapshot(s){"));
  const verAt = fn.indexOf("s.alertVer"), shortAt = fn.indexOf("s.dataTs===state.dataTs");
  assert.ok(verAt > 0 && shortAt > 0, "both the alertVer check and the content short-circuit exist");
  assert.ok(verAt < shortAt, "the alertVer check must precede the content short-circuit");

  // `trig.on` governs whether a SETUP interrupts you. Gating the whole pull on it silently threw
  // away the ops and ledger history for anyone who turned setup toasts off.
  const lt = app.slice(app.indexOf("async function loadTriggers()"), app.indexOf("function fireTrigger("));
  assert.ok(!/if\(!A\.trig\.on\) return;/.test(lt), "the feed pull must not be gated on the setup toggle");
  assert.ok(/A\.trig\.on && trigEligibleClient/.test(lt), "…the toggle gates FIRING instead");
  assert.ok(lt.indexOf("A.feed=d.recent") < lt.indexOf("if(cur==null)"),
    "the display list must be adopted BEFORE the first-run early return, or a new device opens onto a blank panel");
  assert.ok(/if\(!A\.seenSeq\)\{ A\.seenSeq=d\.seq/.test(lt),
    "a first-run device starts the badge clean — forty retained events are history, not forty unread items");

  // The 60s standalone timer is replaced by the snapshot-driven pull plus a slow safety net.
  assert.ok(!/setInterval\(loadTriggers,60\*1000\)/.test(app), "the old 60s alert timer must be gone");
  assert.ok(/setInterval\(loadTriggers,5\*60\*1000\)/.test(app), "a slow safety net remains for a wedged snapshot path");
});

test("client: the feed is the record — fire* interrupt only, and read state is a persisted watermark", () => {
  const fs = require("fs"), path = require("path");
  const app = require("./_client").clientSource();

  // A second copy of the event list is exactly how the badge, the panel and the toast could
  // disagree about what had happened. Only the local metric rules (fireAlert) still write a log.
  for (const fn of ["fireTrigger", "fireOps", "fireLedger"]) {
    const body = app.slice(app.indexOf("function " + fn + "(ev)"), app.indexOf("function " + fn + "(ev)") + 900);
    assert.ok(!/A\.log\.unshift/.test(body), `${fn} must not keep its own copy of the event`);
    assert.ok(!/A\.unseen\+\+/.test(body), `${fn} must not hand-count unread — the watermark does that`);
  }
  assert.ok(/function fireAlert\([\s\S]{0,400}A\.log\.unshift/.test(app),
    "in-tab metric rules still keep a local log until their server-side replacement lands");

  // One formatter, shared by the toast path and the panel.
  assert.ok(/function alertText\(ev\)/.test(app));
  for (const k of ["'ops'", "'ledger'"]) assert.ok(app.includes("if(k===" + k), `alertText must handle the ${k} class`);
  // The title is the product name and may be rebranded; the BODY is the load-bearing half — it
  // must come from alertText(ev), never a string this call site writes for itself.
  assert.ok(/new Notification\('[^']+ — new trigger',\{body:alertText\(ev\)\}\)/.test(app),
    "the notification body comes from the shared formatter, not a private string");

  // Unread survives a reload because it is a persisted sequence watermark, not a counter.
  assert.ok(/function alertUnread\(\)[\s\S]{0,320}A\.seenSeq\|\|0/.test(app), "unread is computed against the watermark");
  assert.ok(/const floor=Math\.max\(A\.seenSeq\|\|0, A\.clearedSeq\|\|0\);/.test(app),
    "…and against the clear watermark too, or the badge counts rows the panel no longer shows");
  assert.ok(/seenSeq:state\.alerts\.seenSeq/.test(app), "the watermark is persisted");
  assert.ok(/Number\.isFinite\(d\.seenSeq\)\) state\.alerts\.seenSeq=d\.seenSeq/.test(app), "…and restored");
  assert.ok(/function closeAlertPop\(\)\{[^}]*alertMarkRead\(\);/.test(app),
    "opening the bell marks the feed read (pinned as behaviour, not as an exact call list — the open handler legitimately gains loaders)");

  // A client cannot delete from the server's ring; "read" is the only state a browser owns here.
  assert.ok(!/id="ar-clear"[\s\S]{0,120}Clear log/.test(app), "the clear-log button must be gone");
  assert.ok(/Mark all read/.test(app));
  assert.ok(/el\('ar-clear'\)\.onclick=\(\)=>\{ alertMarkRead\(\)/.test(app), "…and it only moves the watermark");

  // Provenance is visible: server-held rows and this-browser-only rows are tagged differently.
  assert.ok(/const ATAG=\{setup:/.test(app) && /rule:\['RULE'/.test(app),
    "the log must say which rows survive a closed tab and which are local");
  assert.ok(/survives a closed tab/.test(app), "the panel states the guarantee it now actually provides");
});

test("client: the in-tab evaluator is bounded to what only a browser can compute", () => {
  const fs = require("fs"), path = require("path");
  const app = require("./_client").clientSource();
  const cat = app.slice(app.indexOf("const ALERT_METRICS=["), app.indexOf("const AM_BY="));
  for (const k of ["sqz", "mom", "beta"]) assert.ok(cat.includes("k:'" + k + "'"), `${k} stays in-tab`);
  for (const k of ["px", "h1", "funding", "vol", "oi", "prem", "doi"])
    assert.ok(!cat.includes("k:'" + k + "'"), `${k} moved server-side and must be gone from the in-tab catalog`);
  // One form, two destinations — the user shouldn't have to carry the distinction.
  assert.ok(/const metric=sel\.slice\(2\), server=sel\.charAt\(0\)==='s';/.test(app), "the metric prefix routes the rule");
  assert.ok(/if\(server\)\{ ruleAct\(/.test(app));
  assert.ok(/this browser only/.test(app), "the boundary is stated in the UI, not just in a comment");
  assert.ok(/fire with no tab open/.test(app), "…as is what the server rules actually guarantee");
});

// ===== Alerts panel: density, precision, clearing (build 2026.07.27-09) =========================

test("panel: sections collapse, class chips wrap, and repeated rows collapse with a count", () => {
  const fs = require("fs"), path = require("path");
  const app = require("./_client").clientSource();
  const css = fs.readFileSync(path.join(__dirname, "..", "public", "styles.css"), "utf8");

  // Four stacked blocks plus a log had turned the panel into a wall.
  assert.ok(/const sec=\(k,title,note,body,extra\)=>/.test(app), "sections are built by one helper, not four hand-rolled headers");
  for (const k of ["'trig'", "'rules'", "'deliv'", "'recent'"]) assert.ok(app.includes("sec(" + k), `section ${k} missing`);
  assert.ok(/open:\{ trig:false, rules:false, deliv:true, recent:true \}/.test(app), "collapse state has sane defaults");
  assert.ok(/open:state\.alerts\.open/.test(app) && /if\(d\.open&&typeof d\.open==='object'\)/.test(app), "…and persists");
  assert.ok(/\.asec-h\{/.test(css) && /\.asec-b\{/.test(css));

  // Nine classes overflowed a single row and the last chip was cut off the panel.
  assert.ok(/flex-wrap:wrap">\$\{chips\}/.test(app), "the class chip row must wrap");

  // Ten identical deploy lines carry as much information as one line saying it happened ten times,
  // and they were burying every setup and ledger event under them.
  assert.ok(/if\(last && last\.kind===e\.kind && last\.text===e\.text\)\{ last\.n=\(last\.n\|\|1\)\+1; continue; \}/.test(app),
    "consecutive identical rows must collapse");
  assert.ok(/e\.n>1\?` <span class="sec"[\s\S]{0,80}\\u00d7\$\{e\.n\}/.test(app), "…and disclose the count rather than hiding the repeats");
});

test("panel: thresholds are precise, cover R:R, and drive both surfaces from one control", () => {
  const fs = require("fs"), path = require("path");
  const app = require("./_client").clientSource();
  // R:R was in the client state from the start with no way to set it — the board's own grinder /
  // windfall split is exactly the filter someone wants on an alert.
  assert.ok(/numIn\('at-rr',T\.minRR/.test(app), "R:R at fire must be settable");
  assert.ok(/numIn\('at-ev',T\.minEV/.test(app) && /numIn\('at-late',T\.maxLate/.test(app));
  assert.ok(/step="0\.05"/.test(app), "0.05 steps — the old selects offered three fixed values each");

  // Two places to set the same number is how they end up disagreeing.
  assert.ok(/const syncTrig=\(\)=>/.test(app) && /pushAct\('\/api\/alerts\/prefs',\{chat:r\.chat, trig:/.test(app),
    "one control must write the in-tab filter AND the telegram thresholds");
  assert.ok(/for\(const r of rs\) if\(r\.mine\)/.test(app), "…and only onto recipients this browser owns");

  const pol = fs.readFileSync(path.join(__dirname, "..", "src", "poller.js"), "utf8");
  assert.ok(/if \("trig" in p\)/.test(pol), "the prefs route must accept thresholds");
  assert.ok(/r\.trig = \{\};/.test(pol), "written whole, not merged — a partial write leaves a threshold the panel is not showing");
});

test("clearing is a per-browser view watermark, never a deletion from the record", () => {
  const fs = require("fs"), path = require("path");
  const app = require("./_client").clientSource();
  assert.ok(/clearedSeq:0/.test(app) && /clearedSeq:state\.alerts\.clearedSeq/.test(app), "the watermark exists and persists");
  assert.ok(/A\.feed\.filter\(e=>\(e\.seq\|\|0\)>\(A\.clearedSeq\|\|0\)\)/.test(app), "the log renders above the watermark");
  // The ring is the record. A client deleting from it would mean the phone and the panel could
  // disagree about what happened, which is the failure this whole system exists to avoid.
  assert.ok(!/\/api\/triggers[\s\S]{0,80}method:'DELETE'/.test(app), "there must be no client path that deletes server events");
  assert.ok(/other devices and the telegram history are untouched/.test(app),
    "the control must say what it actually does — 'clear' implying deletion would be a lie");
  assert.ok(/if\(\(A\.seenSeq\|\|0\)<hi\) A\.seenSeq=hi;/.test(app), "clearing also marks read, or the badge counts invisible rows");
});

test("the family filter is validated server-side and named in the message", () => {
  const C = require("../src/compute");
  // The board tags the grinder family on screen; the DM should say the same word rather than
  // leaving you to infer it from the ratio.
  const m = C.pushFmt({ kind: "setup", coin: "B", t: "B", side: "long", ev: "bigmove", label: "big move",
    cls: "ev", rr: { gross: 0.8 }, evR: 0.4, rec: {} }, {});
  assert.ok(m.includes("grinder"), "a grinder says so in the message");
  const m2 = C.pushFmt({ kind: "setup", coin: "A", t: "A", side: "long", ev: "breakout", label: "breakout",
    cls: "rr", rr: { gross: 3 }, evR: 0.5, rec: {} }, {});
  assert.ok(!m2.includes("grinder"), "…and the other family does not carry a label it doesn't need");

  const fs = require("fs"), path = require("path");
  const pol = fs.readFileSync(path.join(__dirname, "..", "src", "poller.js"), "utf8");
  assert.ok(/c === "rr" \|\| c === "ev"/.test(pol), "the family list is validated against a closed vocabulary");
  assert.ok(/error: "bad-class"/.test(pol), "an unrecognised family is rejected — accepting it would filter every setup out silently");
  assert.ok(/if \(cls && cls\.length === 1\) r\.trig\.cls = cls;/.test(pol), "both-selected stores nothing rather than a no-op filter");

  const app = require("./_client").clientSource();
  // One vocabulary: the alert control must use the board's exact words for the split.
  assert.ok(/2:1\+ setups/.test(app) && /positive-EV grinders/.test(app), "the alert filter reuses the board's labels verbatim");
  assert.ok(/if\(Array\.isArray\(c\.cls\) && c\.cls\.length && !c\.cls\.includes\(ev\.cls\)\) return false;/.test(app),
    "the client mirror must match the shared gate exactly");
  assert.ok(/if\(!cur\.length\) return;/.test(app), "turning both families off is refused — the master toggle is how you stop setup alerts");
  assert.ok(/trig:\{minEV:T\.minEV, minRR:T\.minRR, maxLate:T\.maxLate, cls:T\.cls\}/.test(app),
    "the family choice syncs to telegram alongside the other thresholds, from the same control");
});

test("ma200 lane manifest: closed source, dedup by the bar itself, full-roster scope — pinned", () => {
  const fs = require("fs"), path = require("path");
  const pol = fs.readFileSync(path.join(__dirname, "..", "src", "poller.js"), "utf8");
  const fn = pol.slice(pol.indexOf("function ma200Scan(tNow)"), pol.indexOf("function pushTest("));
  assert.ok(/emaAlertState\(bars, sdTf\)/.test(fn), "ONE detector — the study's vocabulary — decides every event");
  assert.ok(/closedBars\(src, MA200_TFS\[tf\], now\)/.test(pol), "the series is period-trimmed: a transition can only exist at a close");
  assert.ok(/for \(const r of rows\.values\(\)\)/.test(fn) && /full roster, BOTH/i.test(pol.slice(pol.indexOf("ma200 class:"), pol.indexOf("const MA200_TFS"))),
    "full roster, both universes — a 200 breakdown matters most on a name that is NOT trending");
  assert.ok(/if \(ev && S\.fired\[key\] !== ev\.barT\) \{/.test(fn),
    "dedup is the firing bar's OWN timestamp — the same closed bar never announces twice");
  assert.ok(fn.indexOf("S.fired[key] !== ev.barT") < fn.indexOf("const lb = maLiveBars"),
    "the fire is handled BEFORE the sighting upkeep — a closed event bar no longer matches the live shape, and upkeep first would wipe the stamp the fire discloses");
  assert.ok(/if \(!maPrimed \|\| !S\.s\) \{ S\.s = 1; if \(key\) S\.fired\[key\] = ev\.barT; continue; \}/.test(fn),
    "state in force at first sight is seeded, never announced — including a name arriving after priming");
  assert.ok(/bars\.length < 216/.test(fn), "EMA200 that cannot seed is honest silence, not a shorter substitute");
  assert.ok((fn.match(/emitTrig\("ma200"/g) || []).length === 1, "one emit site");
  assert.ok(/S\.seen\[key\] != null && S\.seen\[key\] < confAt/.test(fn), "seenAt only when the sighting preceded the confirming close");
  // Wiring: scheduler, priming, persistence, hydration, primed-on-restore.
  assert.ok(/setInterval\(safeTick\(ma200Scan, "ma200Scan"\), 5 \* 60 \* 1000\);/.test(pol));
  assert.ok(/maPrimed = true; log\("ma200 alerts primed"\)/.test(pol));
  assert.ok(/ma200: \[\.\.\.maState\.entries\(\)\]\.slice\(-500\)/.test(pol));
  assert.ok(/loadMap\(ep\.ma200, maState\)/.test(pol));
  assert.ok(/if \(maState\.size\) maPrimed = true;/.test(pol),
    "restored state IS the seed — keeping the priming delay after a restore would only eat real transitions");
  // Client: the bell log reads the same event through the shared stamp.
  const app = require("./_client").clientSource();
  assert.ok(app.includes("if(k==='ma200')") && /ma200:\['MA200'/.test(app), "alertText branch + feed tag");
});

test("panel: your recipients only in the bell, everyone's in the admin panel, collapsed", () => {
  const fs = require("fs"), path = require("path");
  const app = require("./_client").clientSource();
  const html = fs.readFileSync(path.join(__dirname, "..", "public", "index.html"), "utf8");
  // Three linked accounts x nine class chips had turned the bell into a wall of controls for people
  // you cannot help.
  assert.ok(/const mineOnly=\(P\.recipients\|\|\[\]\)\.filter\(r=>r\.mine\);/.test(app),
    "the bell panel lists only your own recipients");
  assert.ok(/data-prec=/.test(app) && /openRec\[r\.chat\]/.test(app), "each recipient collapses to a summary line");
  assert.ok(/\$\{nOn\} class\(es\)/.test(app), "…whose summary still says how many classes are on");
  assert.ok(/filter\(c=>!adminCls\.includes\(c\)\|\|r\.admin\)/.test(app),
    "the ops chip is not offered to a recipient who cannot receive ops");

  assert.ok(html.includes('id="admRecH"') && html.includes('id="admRecB"'), "the admin roster has markup");
  assert.ok(/<div id="admRecB" hidden>/.test(html), "…and is collapsed by default");
  assert.ok(/function renderAdmRecips\(\)/.test(app));
  assert.ok(/r\.admin\?'operator':'public'/.test(app), "the roster says which recipients hold operator privileges");
  assert.ok(/data-admunlink=/.test(app) && /Revoke this recipient/.test(app), "admin can revoke from there");
});

// ===== Popover self-close + legacy adoption (build 2026.07.27-12) ===============================

test("a popover control that rebuilds its own panel must not close it", () => {
  const fs = require("fs"), path = require("path");
  const app = require("./_client").clientSource();
  // The mechanism: a section header calls buildAlertsPanel(), which replaces pop.innerHTML. By the
  // time the click bubbles to document the clicked node is DETACHED, and a detached node is
  // contained by nothing — so the outside-click test fires and the drawer shuts under the user.
  assert.ok(/function clickedOutside\(pop, btn, e\)\{/.test(app), "one shared outside-click predicate");
  assert.ok(/if\(!e\.target \|\| !e\.target\.isConnected\) return false;/.test(app),
    "a target we removed ourselves is not an outside click");
  // All four popovers share the pattern, so all four had the latent bug — only the alerts panel
  // grew enough self-rebuilding controls for it to surface.
  for (const pid of ["alertpop", "filterpop", "colpop", "laypop"]) {
    const at = app.indexOf("const pop=el('" + pid + "');\n  if(clickedOutside(pop,");
    assert.ok(at > 0, `${pid} must use the shared predicate`);
  }
  assert.ok(!/!pop\.hidden && !pop\.contains\(e\.target\)/.test(app), "no hand-rolled copy of the old test may remain");
});

test("admin edits any recipient's classes from the roster; a person's own controls are untouched", () => {
  const fs = require("fs"), path = require("path");
  const app = require("./_client").clientSource();
  // The roster edits in place, over the same route the owner uses — the server already honoured the
  // admin override, the UI had simply stopped offering it.
  assert.ok(/data-apcls=/.test(app) && /data-apchat=/.test(app), "the admin roster has class chips");
  assert.ok(/pushAct\('\/api\/alerts\/classes',\{chat:rec\.chat, classes:cur\}\)\.then\(\(\)=>renderAdmRecips\(\)\)/.test(app),
    "admin writes ride the normal classes route");
  assert.ok(/data-admexp=/.test(app), "rows expand on demand — three recipients of chips is the wall the bell panel just escaped");
  // Public users' own controls: still built for every recipient the bell panel shows.
  assert.ok(/data-pcls=/.test(app) && /data-pquiet=/.test(app) && /data-psched=/.test(app),
    "self-service class/quiet/schedule controls remain in the bell panel");
  // And the server still enforces that a NON-admin cannot write someone else's subscriptions.
  const p = twoUserHarness();
  const cb = p.pushMintCode("own-b", false); p.pushBindNow(cb.code, 2222222222, "friend");
  assert.equal(p.pushSetClasses("2222222222", ["setup"], "own-a", false).error, "forbidden");
  assert.equal(p.pushSetClasses("2222222222", ["setup", "trend"], "own-a", true).ok, true, "the admin override is a server capability, not a UI trick");
});

// ===== settled board record + terminal causal routing (build 2026.07.27-15) ====================
// Two failures shipped in one screenshot: "why is DRAM dumping so much today" degraded to a bare
// `DRAM d1` card (the field scan ate "today" before intent was ever considered), and the follow-up
// complaint reached the analyst ALONE — the ask path carried no transcript, so the model could
// truthfully see only four words. These tests pin the guard, the transcript, and the board's new
// settled record end to end.

test("terminal -15: causal intent escalates to the analyst — a ticker inside a 'why' is context, never the answer", () => {
  const fs = require("fs"), path = require("path");
  const s = require("./_client").clientSource();
  // Extract the guard regex from nlResolve and RUN it against the screenshot phrasings.
  const m = s.match(/\/\\bwhy\\b\|[^/]*behind \(the\|this\|its\)\\b\//);
  assert.ok(m, "causal-intent guard regex not found in app.js");
  const re = new RegExp(m[0].slice(1, -1));
  for (const q of ["why is dram dumping so much today", "what could be causing dram dump today",
    "why is the tape red", "explain nvda's move", "whats driving sol"])
    assert.ok(re.test(" " + q + " "), `causal phrasing must match the guard: "${q}"`);
  for (const q of ["whats nvda funding", "top gainers today", "nvda vs sol", "most crowded shorts"])
    assert.ok(!re.test(" " + q + " "), `non-causal phrasing must stay local: "${q}"`);
  // Position: the guard runs before the whole-board patterns and before the ticker block, so no
  // local mapping can eat a causal question first.
  const gi = s.indexOf("Causal / explanatory intent");
  assert.ok(gi > 0 && gi < s.indexOf("whole-board questions") && gi < s.indexOf("positioning screens in trader phrasing"),
    "the causal guard must run before every local mapping in nlResolve");
  // The client's analyst/planner classifier must mirror it (ctx.mode wins server-side, so a
  // client-only or server-only fix would each leave one path broken).
  assert.ok(s.includes("function termCausal") && s.includes("termCausal(text)?'analyst':'planner'"),
    "termAsk must classify via the shared causal test");
  // Transcript: recorded for LOCAL answers too (complaints are usually about a local card), and
  // the tail rides every ask.
  assert.ok(s.includes("function termHistPush"), "session transcript recorder missing");
  assert.ok(s.includes("termHistPush(line, line)") && s.includes("termHistPush(line,'\u2192 '+nl+' (computed locally)')"),
    "local exchanges (grammar + NL) must enter the transcript");
  assert.ok(s.includes("hist:_termHist.slice(-6)"), "the transcript tail must ride the /api/ask body");
  assert.ok(s.includes("termHistPush(text,d.answer||'')") && s.includes("termHistPush(text,'\u2192 '+d.query)"),
    "AI exchanges (analyst answer / planner query) must enter the transcript");
});

// ===== panel builders must own the scopes they read (build 2026.07.27-30) =======================
// A real break, class not instance: buildPushSection read `A.openRec`, but `A` is a caller-local in
// buildAlertsPanel (`const pop=..., A=state.alerts`). Because buildPushSection is invoked from
// inside that caller's own template concatenation, the code reads as if the scope were shared. It
// is not. The throw landed BEFORE `pop.innerHTML=h`, so the panel kept its last-rendered markup and
// every control's handler — each of which ends by calling buildAlertsPanel() to re-render — became
// a silent no-op. Nothing looked broken; nothing worked. It only fired once a linked recipient
// existed, since `mineOnly.map` is the only path that reaches the reference, which is why it sat
// latent for three commits and read as a regression from an unrelated DOM move.
//
// Derived, not pinned: brace-match every top-level function in app.js and require that any body
// referencing a bare `A.` also declares `A`. Any future builder split out of buildAlertsPanel that
// carries an `A.` read along with it fails here.
test("every function reading the `A.` alerts alias declares it (no borrowed caller scope)", () => {
  const fs = require("fs"), path = require("path");
  const s = require("./_client").clientSource();
  const re = /^function\s+([A-Za-z0-9_$]+)\s*\(([^)]*)\)\s*\{/gm;
  const offenders = [];
  let m, checked = 0;
  while ((m = re.exec(s))) {
    const name = m[1], params = m[2];
    // A section's __boot_* function holds its original top-level statements (the module split,
    // build 2026.09.16-80); those read the module-scope alias exactly as the top level always did.
    if (name.startsWith("__boot_")) continue;
    // brace-match the body from the opening brace
    let i = m.index + m[0].length - 1, depth = 0, end = -1;
    for (; i < s.length; i++) {
      const c = s[i];
      if (c === "{") depth++;
      else if (c === "}") { depth--; if (!depth) { end = i; break; } }
    }
    if (end < 0) continue;
    const body = s.slice(m.index + m[0].length, end);
    if (!/(^|[^A-Za-z0-9_$.])A\s*\./.test(body)) continue;   // doesn't read the alias at all
    checked++;
    // A declarator list may hold other initialisers before A (`const P=pushState, A=state.alerts`)
    // and may destructure (`const [i,j]=pr, A=rows[i]`) — scan the whole statement, stop at the
    // semicolon. renderPairPanel legitimately binds its own unrelated `A` this way.
    const declares = /(?:const|let|var)\s+[^;]*?\bA\s*=/.test(body)
      || /(^|[,\s])A(\s*=|\s*,|\s*$)/.test(params);
    if (!declares) offenders.push(name);
  }
  assert.ok(checked > 0, "the scan must actually find functions reading the alias — a silent zero would pass vacuously");
  assert.deepEqual(offenders, [], "these read `A.` without declaring A: " + offenders.join(", "));
  // The specific site, so a future refactor that drops the alias from buildPushSection is named.
  assert.ok(/function buildPushSection\(\)\{[\s\S]{0,600}?const P=pushState, A=state\.alerts;/.test(s),
    "buildPushSection must hold its own reference to the alerts store");
});

test("postres -31: the client renders the scored chip on the re-arm branch, dash only when there is truly nothing", () => {
  const fs = require("fs"), path = require("path");
  const app = require("./_client").clientSource();
  // the scored branch lives INSIDE nowChip's no-claim path, before the dash fallback
  const i0 = app.indexOf("const sc=o.scored;");
  const iDash = app.indexOf("no ledger claim behind this signal yet");
  assert.ok(i0 > 0 && iDash > i0, "nowChip checks the scored stub before falling back to the bare dash");
  assert.ok(app.includes("this episode already SCORED"), "the tooltip states what happened, not just that nothing is measurable");
  assert.ok(app.includes("one episode, one claim"), "…and names the re-arm rule so the dash's replacement explains itself");
  assert.ok(app.includes("pseudo-replication"), "…including WHY a serial re-claim is refused");
  assert.ok(/scored \$\{val\}/.test(app), "the chip leads with the outcome");
  // a voided settlement renders as void, never as a fabricated number
  assert.ok(app.includes(`'<span class="na">void</span>'`), "a never-scored expiry is an honest void, not a number");
});

test("-04 wiring manifest: server ships ind thin, client groups on ONE key, control persists", () => {
  const fs = require("fs"), path = require("path");
  const pl = fs.readFileSync(path.join(__dirname, "..", "src", "poller.js"), "utf8");
  const app = require("./_client").clientSource();
  const ht = fs.readFileSync(path.join(__dirname, "..", "public", "index.html"), "utf8");
  const css = fs.readFileSync(path.join(__dirname, "..", "public", "styles.css"), "utf8");
  // Wire: shipped only when it differs — absence IS the fallback, by contract.
  assert.ok(pl.includes("ind: cl.ind !== cl.sector ? cl.ind : undefined,"), "board wire ships ind thin");
  // One grouping key for the whole tab: board grouping and cohesion/corr partition must both
  // route through sectKeyOf, or the matrix could disagree with the board (one-code-path).
  assert.ok(app.includes("function sectKeyOf(r){ return (sectGrpActive() ? (r.ind||r.sector) : r.sector) || 'Unclassified'; }"), "grouping key helper");
  assert.ok(app.includes("for(const r of activeRows()){ const g=sectKeyOf(r);"), "computeSectors groups on the shared key");
  assert.ok(app.includes("withDaily.forEach((r,i)=>{ const g=sectKeyOf(r);"), "cohesion partitions on the SAME key");
  assert.equal((app.match(/const g=sectKeyOf\(r\)/g) || []).length, 2, "exactly the two grouping sites call the key — no third path, no bypass");
  // The client must never re-derive an industry from a ticker: no industry TABLE client-side.
  // (The help text may NAME groups as documentation; what's forbidden is a ticker→industry map.)
  assert.ok(!/IND_TICKERS/.test(app) && !/['"]SNDK['"]\s*:/.test(app) && !/['"]SKHX['"]\s*:/.test(app),
    "client consumes r.ind from the wire, never derives it");
  // Crypto scope: the toggle is inert AND hidden — the key and the control can never disagree.
  assert.ok(app.includes("state.sect.grp==='ind' && state.scope!=='crypto'"), "industry grouping is equities-only");
  assert.ok(app.includes("const gseg=el('sectgrp'); if(gseg) gseg.hidden=cr;"), "the seg hides in crypto scope");
  assert.ok(css.includes(".seg[hidden]{display:none}"), "hidden seg guarded against the display:inline-flex bug class");
  // Honesty chips + provenance column exist, and the pref round-trips through the enum guard.
  assert.ok(app.includes('«thin» rows carry noisier stats'), "thin-sample disclosure in the board caption");
  assert.ok(app.includes("no industry split defined — this group is the GICS sector unchanged"), "visible = sector fallback");
  assert.ok(app.includes("title=\"parent GICS sector(s) of this group's members\""), "GICS provenance column");
  assert.ok(app.includes("sectGrp:state.sect.grp,"), "pref saved");
  assert.ok(app.includes("if(p.sectGrp==='ind'||p.sectGrp==='sector') state.sect.grp=p.sectGrp;"), "pref restored through an enum guard");
  assert.ok(css.includes(".sthin{"), "chip style exists");
  for (const pin of ['id="sectgrp"', 'data-grp="sector"', 'data-grp="ind"']) assert.ok(ht.includes(pin), "index pin missing: " + pin);
  // The founding fix stays fixed: ZM must not drift back into the Comm Services roster.
  const sj = fs.readFileSync(path.join(__dirname, "..", "src", "sectors.js"), "utf8");
  assert.ok(!/"SPOT","ROKU","ZM"/.test(sj), "ZM must stay out of Communication Services");
});

// ===== industry-grouping ingest (build 2026.07.28-05) ==========================================
// The -04 field-name-mismatch bug, made unrepeatable. applySnapshot's merge is an EXPLICIT
// field-by-field copy — the wire carried `ind`, the merge dropped it, and every industry group
// rendered as an "= sector" fallback. String pins on the wire and the grouping key could not
// catch it: only pushing a payload through the REAL ingestion path can. This test evaluates the
// real client (the -17 harness pattern), feeds applySnapshot a snapshot whose rows carry `ind`
// exactly as the poller ships it, and asserts the field survives into state.rows AND that
// computeSectors then actually splits on it.
test("-05 regression: applySnapshot carries `ind` into state.rows and the industry grouping splits", () => {
  const fs = require("fs"), path = require("path");
  const app = require("./_client").clientSource();
  const { els, mk } = _sessDomStub();
  const saved = { si: global.setInterval, st: global.setTimeout, raf: global.requestAnimationFrame,
    doc: global.document, win: global.window, ls: global.localStorage, f: global.fetch };
  global.setInterval = () => 0; global.setTimeout = () => 0; global.requestAnimationFrame = () => 0;
  global.document = { getElementById: (id) => (els[id] = els[id] || mk(id)), querySelectorAll: () => [], querySelector: () => null,
    createElement: mk, addEventListener() {}, body: mk("body"), documentElement: mk("html"), hidden: false };
  global.window = { addEventListener() {}, location: { reload() {}, href: "/" }, matchMedia: () => ({ matches: false, addEventListener() {} }) };
  global.localStorage = { _d: {}, getItem(k) { return this._d[k] ?? null; }, setItem(k, v) { this._d[k] = String(v); }, removeItem(k) { delete this._d[k]; } };
  global.fetch = () => new Promise(() => {});
  try {
    const S = require("../src/sectors");
    let H = null;
    eval(app + "\n; H={state, applySnapshot, computeSectors, sectGrpActive};");
    // Rows exactly as the poller ships them: `ind` present only when it differs from sector.
    const wire = (t) => { const c = S.classify(t); return { coin: "xyz:" + t, ticker: t, uni: "xyz",
      sector: c.sector, assetClass: c.assetClass, ind: c.ind !== c.sector ? c.ind : undefined,
      px: 100, prevDay: 99, vol: 1e8, oi: 5e7, feat: { volBase: 9e7 } }; };
    const mkts = ["SNDK", "SKHX", "MU", "NVDA", "MSFT", "PLD"].map(wire);
    H.applySnapshot({ markets: mkts, mainMarkets: [], dataTs: 7 });
    // 1) the field SURVIVES ingestion — this is the exact line that was missing in -04
    assert.equal(H.state.rows.get("xyz:SNDK").ind, "Memory/Storage", "ind must survive the explicit merge");
    assert.equal(H.state.rows.get("xyz:NVDA").ind, "Semiconductors");
    assert.equal(H.state.rows.get("xyz:PLD").ind, undefined, "absent-on-the-wire stays absent — absence IS the fallback");
    // 2) lockstep self-heal: a later payload with sector but no ind must CLEAR a stale group
    H.applySnapshot({ markets: mkts.map(m => m.ticker === "SNDK" ? Object.assign({}, m, { ind: undefined }) : m),
      mainMarkets: [], dataTs: 8 });
    assert.equal(H.state.rows.get("xyz:SNDK").ind, undefined, "ind rides sector in lockstep — stale groups self-heal");
    // 3) end to end: re-ingest the true payload and the grouping actually splits on it
    H.applySnapshot({ markets: mkts, mainMarkets: [], dataTs: 9 });
    H.state.scope = "stocks"; H.state.tf = "1d"; H.state.sect.grp = "ind";
    const names = H.computeSectors().map(g => g.name);
    assert.ok(names.includes("Memory/Storage") && names.includes("Semiconductors") && names.includes("Real Estate"),
      "industry grouping splits the ingested rows: " + names.join(", "));
    H.state.sect.grp = "sector";
    assert.ok(!H.computeSectors().map(g => g.name).includes("Memory/Storage"), "sector grouping stays GICS-only");
  } finally {
    global.setInterval = saved.si; global.setTimeout = saved.st; global.requestAnimationFrame = saved.raf;
    global.document = saved.doc; global.window = saved.win; global.localStorage = saved.ls; global.fetch = saved.f;
  }
});

// ===== COMP/G loading-state honesty + [hidden] guard (build 2026.07.28-07) =====================
// The field report: an empty corr-tab visit racing /api/daily painted COMP/G as a lineless chart
// with a NaN anchor label, never healed, and the un-guarded spread-mode base select read as a
// forced basket comparison. Two fixes, both executed here — the render must SAY it's loading,
// the daily hook must repaint it out of that state, and cg-basectl must actually hide.

test("-07 COMP/G: no-history render is an honest loading line (no fake chart, no NaN), and heals when daily lands", () => {
  const fs = require("fs"), path = require("path");
  const app = require("./_client").clientSource();
  const els = {};
  const mk = (id) => ({ id, innerHTML: "", hidden: false, value: "", checked: false, textContent: "", style: {}, dataset: {},
    classList: { add() {}, remove() {}, toggle() {}, contains: () => false },
    querySelectorAll: () => [], querySelector: () => null, addEventListener() {}, appendChild() {}, removeChild() {},
    setAttribute() {}, getAttribute: () => null, focus() {}, scrollIntoView() {}, getBoundingClientRect: () => ({ left: 0, top: 0, width: 900, height: 300 }) });
  const saved = { si: global.setInterval, st: global.setTimeout, raf: global.requestAnimationFrame,
    doc: global.document, win: global.window, ls: global.localStorage, f: global.fetch,
    ct: global.clearTimeout, ci: global.clearInterval };
  global.setInterval = () => 0; global.setTimeout = () => 0; global.requestAnimationFrame = () => 0;
  global.clearTimeout = () => 0; global.clearInterval = () => 0;
  global.document = { getElementById: (id) => (els[id] = els[id] || mk(id)), querySelectorAll: () => [], querySelector: () => null,
    createElement: mk, addEventListener() {}, body: mk("body"), documentElement: mk("html"), hidden: false };
  global.window = { addEventListener() {}, location: { reload() {}, href: "/", hash: "" }, matchMedia: () => ({ matches: false, addEventListener() {} }), __FLAGS: { baskets: true }, __ADMIN: true };
  global.localStorage = { _d: {}, getItem(k) { return this._d[k] ?? null; }, setItem(k, v) { this._d[k] = String(v); }, removeItem(k) { delete this._d[k]; } };
  global.fetch = () => new Promise(() => {});
  try {
    const api = new Function(app + "\n;return {state, COMPG, renderCompg};")();
    const DAY = 86400e3, today = Math.floor(Date.now() / DAY) * DAY;
    const names = ["AAA", "BBB", "CCC", "DDD"];
    api.state.scope = "stocks"; api.state.view = "corr";
    names.forEach((tk, ix) => api.state.rows.set("xyz:" + tk, { coin: "xyz:" + tk, ticker: tk, uni: "xyz", px: 100, daily: null, delisted: false }));
    api.COMPG.sel = names.slice(); api.COMPG.off = new Set(); api.COMPG.mode = "index"; api.COMPG.base = "__basket";
    api.COMPG.win = 30; api.COMPG.anchorTs = (Math.floor(Date.now() / DAY) - 30) * DAY; api.COMPG.closed = false;
    api.renderCompg();
    const h0 = els["compg"].innerHTML;
    assert.ok(api.COMPG._empty, "empty state flagged for the self-heal hook");
    assert.ok(/Loading daily history/.test(h0), "the render SAYS it's waiting");
    assert.ok(/0\/4 selected names/.test(h0), "and counts what's landed");
    assert.equal((h0.match(/<path /g) || []).length, 0, "no fake chart");
    assert.ok(!/NaN/.test(h0), "no NaN anchor label");
    // history lands -> the same call the daily hook makes repaints a real chart
    names.forEach((tk, ix) => { api.state.rows.get("xyz:" + tk).daily =
      Array.from({ length: 120 }, (_, i) => ({ t: today - (119 - i) * DAY, c: 100 * (ix + 1) * (1 + i * 0.001) })); });
    api.renderCompg();
    const h1 = els["compg"].innerHTML;
    assert.ok(!api.COMPG._empty, "empty flag cleared");
    assert.equal((h1.match(/<path /g) || []).length, 4, "one line per name the moment data exists");
    assert.ok(!/Loading daily history/.test(h1), "loading copy gone");
  } finally {
    global.setInterval = saved.si; global.setTimeout = saved.st; global.requestAnimationFrame = saved.raf;
    global.clearTimeout = saved.ct; global.clearInterval = saved.ci;
    global.document = saved.doc; global.window = saved.win; global.localStorage = saved.ls; global.fetch = saved.f;
  }
});

test("-07 wiring: the daily hook repaints COMP/G out of empty, and cg-basectl's [hidden] guard exists", () => {
  const fs = require("fs"), path = require("path");
  const app = require("./_client").clientSource();
  assert.ok(app.includes("if(COMPG._empty && el('compg') && !el('compg').hidden) renderCompg()"),
    "daily-arrival hook carries the self-heal repaint");
  const css = fs.readFileSync(path.join(__dirname, "..", "public", "styles.css"), "utf8");
  assert.ok(css.includes(".cg-basectl[hidden]{display:none}"),
    "the spread-mode base select hides when hidden — runtime-templated hidden escaped the markup audit; this pin closes that hole");
});

test("-09 Δ vs ⬒: EW mean of the board's own fields, coverage floor dashes (never a thinner average)", () => {
  const { api, restore } = _p2Harness();
  try {
    api.state.scope = "stocks"; api.state.tf = "4h";
    const seed = (tk, h4) => api.state.rows.set("xyz:" + tk, { coin: "xyz:" + tk, ticker: tk, uni: "xyz", px: 100, h4, delisted: false });
    seed("AAA", 2.0); seed("BBB", 4.0); seed("CCC", -3.0); seed("DDD", 1.0);
    api.BASKETS.list = [{ name: "TRI", scope: "stocks", members: ["AAA", "BBB", "CCC"], builtin: false, daily: [] }];
    api.state.dvbBasket = "TRI";
    const rows = [...api.state.rows.values()];
    api.computeDvb(rows);
    const mean = (2.0 + 4.0 - 3.0) / 3;
    for (const [tk, h4] of [["AAA", 2.0], ["BBB", 4.0], ["CCC", -3.0], ["DDD", 1.0]]) {
      const r = api.state.rows.get("xyz:" + tk);
      assert.ok(Math.abs(r.dvb - (h4 - mean)) < 1e-9, tk + ": own return minus the hand-computed EW mean");
    }
    // floor: strip the field from 2 of 3 members -> 1/3 < 60% -> every dvb nulls, no thinner mean
    api.state.rows.get("xyz:BBB").h4 = null; api.state.rows.get("xyz:CCC").h4 = undefined;
    api.computeDvb([...api.state.rows.values()]);
    assert.equal(api.state.rows.get("xyz:AAA").dvb, null, "sub-floor coverage -> dash for a row WITH the field");
    assert.equal(api.state.rows.get("xyz:CCC").dvb, undefined, "field not yet loaded stays a placeholder, not a dash");
  } finally { restore(); }
});

test("-09 matrix basket rows: the virtual row rides the ticker's exact pearson path, built-ins gated by the toggle", () => {
  const { api, restore } = _p2Harness();
  try {
    const DAY = 86400e3, today = Math.floor(Date.now() / DAY) * DAY;
    api.state.scope = "stocks"; api.state.view = "corr";
    const daily = Array.from({ length: 120 }, (_, i) => ({ t: today - (119 - i) * DAY, c: 100 * (1 + Math.sin(i / 5) * 0.02 + i * 0.001) }));
    api.state.rows.set("xyz:AAA", { coin: "xyz:AAA", ticker: "AAA", uni: "xyz", px: 100, vol: 1, daily, delisted: false });
    // basket shipped with the IDENTICAL series -> correlation with AAA must be exactly 1
    api.BASKETS.list = [
      { name: "MIRROR", scope: "stocks", members: ["AAA"], builtin: false, daily: daily.map(k => [k.t, k.c]) },
      { name: "TECH", scope: "stocks", members: ["AAA"], builtin: true, daily: daily.map(k => [k.t, k.c]) },
    ];
    api.BASKETS.rev = 1;
    api.state.corr.showBuiltins = false;
    let bk = api.corrBasketRows();
    assert.deepEqual(bk.map(r => r.ticker), ["MIRROR"], "customs always, built-ins held back by default");
    api.state.corr.showBuiltins = true;
    bk = api.corrBasketRows();
    assert.deepEqual(bk.map(r => r.ticker).sort(), ["MIRROR", "TECH"], "toggle admits the derived rows");
    const rows = [api.state.rows.get("xyz:AAA"), api.corrBasketRows()[0]];
    const res = api.buildCorr(rows, 90);   // 90d window: ~90 overlapping days clears buildCorr's own minOv=45 floor
    assert.ok(res.C[0][1] != null, "pair correlates (overlap clears the matrix's own floor)");
    assert.ok(Math.abs(res.C[0][1] - 1) < 1e-9, "identical series -> ρ exactly 1: one math path, no basket special-casing");
    assert.equal(res.C[0][1], res.C[1][0], "symmetric");
  } finally { restore(); }
});

test("-09 wiring pins: column registered + gated, prefs survive, toggle seg exists, tier copy states the boundary", () => {
  const fs = require("fs"), path = require("path");
  const app = require("./_client").clientSource();
  for (const pin of ["key:'dvb'", "function computeDvb(", "function dvbCell(", "function dvbBasketDef(",
    "function basketVirtualRow(", "function corrBasketRows(", "function syncCorrBk(",
    "c.key==='dvb'&&!featureOn('baskets')",            // flag gate in visibleCols
    "dvbBasket:state.dvbBasket||null",                  // prefs out
    "p.dvbBasket",                                       // prefs in
    "an editable basket is never the benchmark under signal math",   // tier copy, verbatim
    "res.eqvb", "price-only EW",                         // backtest yardstick + honest label
    "id=\"btVsB\""]) assert.ok(app.includes(pin), "app.js pin missing: " + pin);
  { const ord = app.match(/const DEFAULT_ORDER=\[([^\]]*)\]/)[1].split(",").map(x => x.replace(/'/g, "").trim());
    const hid = new Set(app.match(/const DEFAULT_HIDDEN=\[([^\]]*)\]/)[1].split(",").map(x => x.replace(/'/g, "").trim()));
    assert.ok(ord.includes("dvb"), "dvb registered in DEFAULT_ORDER");
    assert.ok(hid.has("dvb"), "dvb hidden by default (opt-in lens)"); }
  const ht = fs.readFileSync(path.join(__dirname, "..", "public", "index.html"), "utf8");
  assert.ok(ht.includes('<div class="seg" id="corrbk" role="group" aria-label="Basket rows" hidden></div>'), "built-ins toggle seg, born hidden (.seg[hidden] guard already pinned)");
  const css = fs.readFileSync(path.join(__dirname, "..", "public", "styles.css"), "utf8");
  assert.ok(css.includes(".dvb-pick{") && css.includes(".cmx th.bk span{border-bottom:1px dashed"), "picker + matrix anatomy styled");
  // tier boundary holds server-side too: nothing in phase 2 touched the poller's alert machinery
  const pj = fs.readFileSync(path.join(__dirname, "..", "src", "poller.js"), "utf8");
  assert.ok(!/dvb/.test(pj), "the Δ column is client-lens only — the server never learns it exists");
});

test("-10 markets defaults: the shipped visible set matches the intended columns, Δ vs ⬒ hidden + defaulting to MAG7", () => {
  const fs = require("fs"), path = require("path");
  const app = require("./_client").clientSource();
  const ord = app.match(/const DEFAULT_ORDER=\[([^\]]*)\]/)[1].split(",").map(x => x.replace(/'/g, "").trim());
  const hid = new Set(app.match(/const DEFAULT_HIDDEN=\[([^\]]*)\]/)[1].split(",").map(x => x.replace(/'/g, "").trim()));
  const visible = ord.filter(k => !hid.has(k));
  assert.deepEqual(visible, ["ticker", "sess", "px", "h1", "h4", "d1", "dopen", "d7", "d30", "gap", "rs", "vstape", "momp", "vol", "funding", "rvol", "adr", "turn", "vwap"],   // 2026.08.14-01: sess home-market chip rides visible beside the ticker
    "default visible columns match the requested set, in order");
  assert.ok(hid.has("dvb"), "Δ vs ⬒ hidden by default");
  assert.ok(app.includes("dvbBasket:'MAG7'"), "the Δ column defaults to MAG7");
  // picker is a visible control, not bare text (the -09 report)
  assert.ok(app.includes('class="dvb-ctl"') && app.includes('data-name='), "the header picker renders as a caret pill showing the current basket");
  const css = fs.readFileSync(path.join(__dirname, "..", "public", "styles.css"), "utf8");
  assert.ok(css.includes(".dvb-ctl{") && css.includes(".dvb-ctl::after{content:attr(data-name)"), "pill styled with the name visible and the select overlaid transparent");
});

test("-11 guest client: customs live in localStorage, merge into the picker, and never call the server", () => {
  const fs = require("fs"), path = require("path");
  const app = require("./_client").clientSource();
  const els = {};
  const mk = (id) => ({ id, innerHTML: "", hidden: false, value: "", checked: false, textContent: "", style: {}, dataset: {},
    classList: { add() {}, remove() {}, toggle() {}, contains: () => false },
    querySelectorAll: () => [], querySelector: () => null, addEventListener() {}, appendChild() {}, removeChild() {},
    setAttribute() {}, getAttribute: () => null, focus() {}, scrollIntoView() {}, getBoundingClientRect: () => ({ left: 0, top: 0, width: 900, height: 300 }) });
  const saved = { si: global.setInterval, st: global.setTimeout, raf: global.requestAnimationFrame,
    doc: global.document, win: global.window, ls: global.localStorage, f: global.fetch, ct: global.clearTimeout, ci: global.clearInterval };
  global.setInterval = () => 0; global.setTimeout = () => 0; global.requestAnimationFrame = () => 0;
  global.clearTimeout = () => 0; global.clearInterval = () => 0;
  global.document = { getElementById: (id) => (els[id] = els[id] || mk(id)), querySelectorAll: () => [], querySelector: () => null,
    createElement: mk, addEventListener() {}, body: mk("body"), documentElement: mk("html"), hidden: false };
  // NON-admin session
  global.window = { addEventListener() {}, location: { reload() {}, href: "/", hash: "" }, matchMedia: () => ({ matches: false, addEventListener() {} }), __FLAGS: { baskets: true }, __ADMIN: false };
  const lsStore = {};
  global.localStorage = { getItem(k) { return lsStore[k] ?? null; }, setItem(k, v) { lsStore[k] = String(v); }, removeItem(k) { delete lsStore[k]; } };
  let serverCalls = 0;
  // Never-settling fetch, same as the other client-execution tests: it keeps the boot poll chain
  // inert so no promise resolves into torn-down globals after the test. We assert the guest path
  // makes no server call by counting invocations, not by letting them complete.
  global.fetch = (url) => { serverCalls++; return new Promise(() => {}); };
  try {
    const api = new Function(app + "\n;return {state, BASKETS, IS_ADMIN, guestCreateBasket, guestDropBasket, guestBasketsLoad, guestMerge, basketMutate, activeRows};")();
    assert.equal(api.IS_ADMIN, false, "harness is a guest session");
    const DAY = 86400e3, today = Math.floor(Date.now() / DAY) * DAY;
    api.state.scope = "stocks";
    ["AAPL", "MSFT", "NVDA"].forEach((tk) => api.state.rows.set("xyz:" + tk, { coin: "xyz:" + tk, ticker: tk, uni: "xyz", px: 100,
      daily: Array.from({ length: 30 }, (_, i) => ({ t: today - (29 - i) * DAY, c: 100 })), delisted: false }));
    // create as guest -> lands in localStorage, no server hit. Reset the counter first: constructing
    // the client kicks off its boot polls (which we stalled), and those are not what we're measuring.
    serverCalls = 0;
    const c = api.guestCreateBasket("MYSHORTS", ["AAPL", "MSFT"]);
    assert.ok(c.ok, "guest create ok: " + (c.error || ""));
    assert.ok(lsStore["xyz-guest-baskets"], "written to localStorage, not the server");
    assert.equal(serverCalls, 0, "guest create made ZERO server calls");
    // reserved names refused client-side too
    assert.ok(!api.guestCreateBasket("SPX", ["AAPL", "MSFT"]).ok, "benchmark alias refused for guests");
    assert.ok(!api.guestCreateBasket("MAG7", ["AAPL", "MSFT"]).ok, "built-in name refused for guests");
    // merge surfaces the guest basket with a synthesized daily series + the guest flag
    const merged = api.guestMerge([{ name: "MAG7", scope: "stocks", members: ["AAPL"], builtin: true, daily: [] }]);
    const mine = merged.find((b) => b.name === "MYSHORTS");
    assert.ok(mine && mine.guest === true, "guest basket carries the guest flag");
    assert.ok(Array.isArray(mine.daily) && mine.daily.length >= 25, "daily synthesized client-side, charts like any basket");
    assert.equal(serverCalls, 0, "the whole guest create+merge cycle made ZERO server calls");
    // guest drop removes from localStorage
    const drop = api.guestDropBasket("MYSHORTS");
    assert.ok(drop.ok && !api.guestBasketsLoad().some((b) => b.name === "MYSHORTS"), "guest drop removes from localStorage");
  } finally {
    global.setInterval = saved.si; global.setTimeout = saved.st; global.requestAnimationFrame = saved.raf;
    global.clearTimeout = saved.ct; global.clearInterval = saved.ci;
    global.document = saved.doc; global.window = saved.win; global.localStorage = saved.ls; global.fetch = saved.f;
  }
});

test("-11 wiring: mutations route through basketMutate, guest scope is disclosed, owner seam carried server-side", () => {
  const fs = require("fs"), path = require("path");
  const app = require("./_client").clientSource();
  // no direct /api/baskets POST survives outside basketMutate (the single gate)
  const posts = (app.match(/fetch\('\/api\/baskets'/g) || []).length;
  assert.equal(posts, 1, "exactly one /api/baskets POST in the codebase — inside basketMutate");
  assert.ok(app.includes("function basketMutate("), "single mutation entry point exists");
  assert.ok(app.includes("this browser only") || app.includes("THIS BROWSER"), "guest scope disclosed in the UI");
  assert.ok(app.includes("guestBasketDaily") && app.includes("basketClosesClient"), "guest daily synthesized with the duel-tested mirror");
  const pj = fs.readFileSync(path.join(__dirname, "..", "src", "poller.js"), "utf8");
  assert.ok(pj.includes('owner: "admin"'), "server stamps owner:admin — the seam that becomes owner:<userId> at real-users time");
  assert.ok(/createBasket\(name, members, isAdmin\)/.test(pj) && /dropBasket\(name, isAdmin\)/.test(pj), "mutators take the admin flag");
});

test("-11 corr reorder + 7d floor: pairs sit above COMP/G, and the overlap floor never exceeds the window", () => {
  const fs = require("fs"), path = require("path");
  const ht = fs.readFileSync(path.join(__dirname, "..", "public", "index.html"), "utf8");
  // order within the corr section: corrpairs BEFORE compg BEFORE ratiopanel BEFORE basketpanel
  const iPairs = ht.indexOf('id="corrpairs"'), iCompg = ht.indexOf('id="compg"'),
    iRatio = ht.indexOf('id="ratiopanel"'), iBasket = ht.indexOf('id="basketpanel"');
  assert.ok(iPairs > -1 && iCompg > iPairs, "strongest pairs sit above COMP/G");
  assert.ok(iRatio > iCompg && iBasket > iRatio, "COMP/G -> ratio -> baskets follow, in that order");
  const app = require("./_client").clientSource();
  const m = app.match(/minOv=Math\.max\((\d+),\s*Math\.floor\(Math\.min\(Ldays,\s*90\)\s*\*\s*([\d.]+)\)\)/);
  assert.ok(m, "the overlap floor scales with the window (not a flat 15)");
  // simulate: for every offered window, the floor must be achievable (< the window's day count)
  const floor = (L) => Math.max(+m[1], Math.floor(Math.min(L, 90) * (+m[2])));
  for (const L of [7, 30, 90, 180, 365]) assert.ok(floor(L) < L, L + "d window: floor " + floor(L) + " is achievable (was the 7d grey-out bug)");
  assert.ok(!/minOv=Math\.max\(15,/.test(app), "the flat-15 floor that greyed the 7d matrix is gone");
});

// ===== shadow baskets display their clean label, token stays the key (build 2026.07.28-12) =======
// The truncated tokens (SEMICONDUCTO) are ugly and unguessable. Everywhere a shadow basket is SHOWN
// — chip, legend, picker, RATIO header, Δ picker — the human label ("Semiconductors") renders, while
// the token remains the selection key, colour anchor, and ratio leg. Typing the label resolves it.

test("-12 clean labels: display shows the label, selection keeps the token", () => {
  const fs = require("fs"), path = require("path");
  const app = require("./_client").clientSource();
  const els = {};
  const mk = (id) => ({ id, innerHTML: "", hidden: false, value: "", dataset: {},
    classList: { add() {}, remove() {}, toggle() {}, contains: () => false },
    querySelectorAll: () => [], querySelector: () => null, addEventListener() {}, appendChild() {},
    setAttribute() {}, getAttribute: () => null, focus() {}, scrollIntoView() {}, getBoundingClientRect: () => ({ left: 0, top: 0, width: 900, height: 300 }) });
  const saved = { si: global.setInterval, st: global.setTimeout, raf: global.requestAnimationFrame,
    doc: global.document, win: global.window, ls: global.localStorage, f: global.fetch, ct: global.clearTimeout, ci: global.clearInterval };
  global.setInterval = () => 0; global.setTimeout = () => 0; global.requestAnimationFrame = () => 0; global.clearTimeout = () => 0; global.clearInterval = () => 0;
  global.document = { getElementById: (id) => (els[id] = els[id] || mk(id)), querySelectorAll: () => [], querySelector: () => null, createElement: mk, addEventListener() {}, body: mk("b"), documentElement: mk("h"), hidden: false };
  global.window = { addEventListener() {}, location: { reload() {}, href: "/", hash: "" }, matchMedia: () => ({ matches: false, addEventListener() {} }), __FLAGS: { baskets: true }, __ADMIN: true };
  global.localStorage = { getItem: () => null, setItem() {}, removeItem() {} };
  global.fetch = () => new Promise(() => {});
  try {
    const api = new Function(app + "\n;return {state, BASKETS, basketDisplayName, basketByName, compgChipHtml, dvbPickOpts, dvbBasketDef};")();
    api.state.scope = "stocks";
    api.BASKETS.list.length = 0;
    api.BASKETS.list.push(
      { name: "SEMICONDUCTO", scope: "stocks", members: ["NVDA", "AMD"], builtin: true, shadow: true, kind: "industry", label: "Semiconductors" },
      { name: "TECH", scope: "stocks", members: ["AAPL", "MSFT"], builtin: true, shadow: true, kind: "sector" },
      { name: "MINE", scope: "stocks", members: ["AAPL", "MSFT"], builtin: false });
    api.BASKETS.rev = 1;
    // display helper: label for the industry, token for the sector (no label), token for a custom
    assert.equal(api.basketDisplayName("SEMICONDUCTO"), "Semiconductors", "industry shows its clean label");
    assert.equal(api.basketDisplayName("TECH"), "TECH", "a sector with no label shows its token");
    assert.equal(api.basketDisplayName("MINE"), "MINE", "a custom shows its name");
    // chip: visible text is the label, but the data-tk KEY is the token (selection/colour/ratio)
    const chip = api.compgChipHtml("SEMICONDUCTO", 0);
    assert.ok(/data-tk="SEMICONDUCTO"/.test(chip), "chip key is the token");
    assert.ok(/Semiconductors/.test(chip) && !/>SEMICONDUCTO</.test(chip.replace(/data-tk="[^"]*"/g, "")), "chip shows the label, not the token");
    // Δ picker: option value is the token, visible text the label
    api.state.dvbBasket = "SEMICONDUCTO";
    const opts = api.dvbPickOpts();
    assert.ok(/value="SEMICONDUCTO"/.test(opts) && /Semiconductors/.test(opts), "Δ picker option: token value, label text");
    assert.equal(api.dvbBasketDef().name, "SEMICONDUCTO", "the Δ selection resolves by token");
  } finally {
    global.setInterval = saved.si; global.setTimeout = saved.st; global.requestAnimationFrame = saved.raf;
    global.clearTimeout = saved.ct; global.clearInterval = saved.ci;
    global.document = saved.doc; global.window = saved.win; global.localStorage = saved.ls; global.fetch = saved.f;
  }
});

test("client: one schedule chip per registered send, parsed to numbers before it leaves", () => {
  const fs = require("fs"), path = require("path");
  const app = require("./_client").clientSource();
  assert.ok(/data-psched=/.test(app) && /data-asched=/.test(app),
    "both the reader's own panel and the operator roster drive off the registry");
  assert.ok(/\(P\.schedKinds\|\|\[\]\)\.map/.test(app), "chips are derived from the server's registry, not hardcoded");
  assert.ok(/function schedDaysClient\(str\)/.test(app));
  assert.ok(/sched:\{\[k\]:\{h:\+v, days\}\}/.test(app), "the client sends numbers; the server re-validates them");
  assert.ok(/Could not read those days/.test(app), "unreadable input is refused in the UI too, not silently sent");
  // The operator writing somebody else's schedule must not stamp their own offset onto it.
  const admWrite = app.slice(app.indexOf("data-asched]"), app.indexOf("data-admclaim]"));
  assert.ok(!/tz:-new Date/.test(admWrite), "no timezone rides an admin-side schedule write");
});

test("the roster carries the operator toggle and the boxes say where tests go", () => {
  const fs = require("fs"), path = require("path");
  const app = require("./_client").clientSource();
  assert.ok(/data-aop=/.test(app), "the toggle chip exists on the roster row");
  assert.ok(/operator:to/.test(app) && /confirm\(/.test(app),
    "toggling is confirm-guarded and states both consequences (ops alerts + test fires)");
  assert.ok(/body:JSON\.stringify\(\{fresh:!!fresh, operator:true\}\)/.test(app));
  assert.ok(/body:JSON\.stringify\(\{kind:'landscape',fresh:!!fresh, operator:true\}\)/.test(app));
  assert.ok(/\u2192 operator only/.test(app) || /operator only<\/span>/.test(app), "the label states the new truth");
  assert.ok(/rows\.find\(r=>r\.mine\)\|\|rows\.find\(r=>r\.admin\)/.test(app),
    "the in-box schedule row serves the operator from ANY browser, not only the linking one");
});

test("the admin boxes carry the operator's own schedule and truthful test labels", () => {
  const fs = require("fs"), path = require("path");
  const app = require("./_client").clientSource();
  // Both test pairs send operator:true — the button fires at the designated operator, which is
  // this test's -21 ancestor corrected: the owner-cookie version missed an operator on a second
  // browser, so the flag replaced the cookie and these pins moved with it.
  assert.ok(/body:JSON\.stringify\(\{fresh:!!fresh, operator:true\}\)/.test(app));
  assert.ok(/body:JSON\.stringify\(\{kind:'landscape',fresh:!!fresh, operator:true\}\)/.test(app));
  assert.ok(/operator only/.test(app),
    "the label next to the buttons states what they now actually do");
  // Each box states the operator's own resolved schedule with click-to-edit — the direct answer to
  // "which time does MY brief/landscape land", without hunting for a roster chip to expand.
  assert.ok(/data-mysched=/.test(app));
  assert.ok(/mySchedRow\('brief'\)/.test(app) && /mySchedRow\('landscape'\)/.test(app));
  assert.ok(/link a telegram or mark an operator below/.test(app),
    "with neither a linked telegram nor a designated operator, the row says why it is empty");
  // The edit rides the identical validated prefs route the roster chips use — no second write path.
  const seg = app.slice(app.indexOf("data-mysched]"), app.indexOf("const x=el('adm-land')"));
  assert.ok(/pushAct\('\/api\/alerts\/prefs',\{chat:me\.chat, sched:/.test(seg));
});

test("5m/15m columns: client wiring — hidden by default, adjacent to Price, honest null fold", () => {
  const fs = require("fs"), path = require("path");
  const app = require("./_client").clientSource();
  // both columns registered with header tooltips
  assert.ok(/key:'m5', label:'5m', type:'num', tip:/.test(app), "m5 column registered with a tooltip");
  assert.ok(/key:'m15', label:'15m', type:'num', tip:/.test(app), "m15 column registered with a tooltip");
  // default layout: present in order (next to px), HIDDEN by default — the product decision
  { const ord = app.match(/const DEFAULT_ORDER=\[([^\]]*)\]/)[1].split(",").map(x => x.replace(/'/g, "").trim());
    const hid = new Set(app.match(/const DEFAULT_HIDDEN=\[([^\]]*)\]/)[1].split(",").map(x => x.replace(/'/g, "").trim()));
    assert.ok(ord.indexOf("m5") === ord.indexOf("px") + 1 && ord.indexOf("m15") === ord.indexOf("m5") + 1, "m5/m15 sit immediately after px in DEFAULT_ORDER");
    assert.ok(hid.has("m5") && hid.has("m15"), "m5 and m15 are HIDDEN by default");
  }
  // saved layouts and prefs migrate the pair in next to Price, not appended at the far right
  assert.equal(app.split("colAdjacent(v,'m5','px')").length - 1, 1, "prefs merge migrates m5 next to px");
  assert.equal(app.split("colAdjacent(ord,'m5','px')").length - 1, 1, "saved-layout merge migrates m5 next to px");
  assert.ok(app.includes("colAdjacent(v,'m15','m5')") && app.includes("colAdjacent(ord,'m15','m5')"), "m15 rides next to m5 at both merge sites");
  // snapshot fold: absence on the wire CLEARS the refs (the ind-lockstep lesson — no stale reference under a fresh label)
  assert.ok(app.includes("r.p5m=(m.p5m!=null)?m.p5m:null; r.p15m=(m.p15m!=null)?m.p15m:null;"), "absent wire refs clear to null, never persist stale");
  // recomputeChanges derives m5/m15 from the ring refs BEFORE the hourly-spine ref guard
  assert.ok(/function recomputeChanges\(r\)\{ const cur=r\.px; if\(cur==null\)return;[\s\S]{0,400}r\.m5=r\.p5m>0[\s\S]{0,900}const ref=r\.ref; if\(!ref\)return;/.test(app),
    "m5/m15 compute ahead of the ref guard — the ring warms before the spine and must not wait on it (2026.08.10-01: the anchored-open trio derives in between, also ahead of the guard — wire refs, no spine dependency)");
  // mobile preset excludes them (curated set unchanged) — they stay opt-in there too
  assert.ok(!app.match(/const MOBILE_COLS=\[[^\]]*\]/)[0].includes("'m5'"), "mobile preset stays curated — m5 not in it");
});

test("loop instrumentation 2026.07.29-05: client surfaces — tray dot, admin row, crosshair hover, markup and css", () => {
  const fs = require("fs"), path = require("path");
  const app = require("./_client").clientSource();
  const html = fs.readFileSync(path.join(__dirname, "..", "public", "index.html"), "utf8");
  const css = fs.readFileSync(path.join(__dirname, "..", "public", "styles.css"), "utf8");
  // Tray dot: value-graded on the LIVE p99 at the decision-gate thresholds, reusing the fdot classes.
  assert.ok(app.includes("cls=p>=50?'stale':(p>=20?'warn':'ok')"), "tray loop dot must grade on the 20/50ms gate thresholds");
  assert.ok(app.includes("box.innerHTML=dots+loopDot"), "loop dot must actually be appended to the tray");
  // Admin row: renderer exists, fed by BOTH the 45s health poll and admin-open (stash + fresh pull).
  assert.ok(app.includes("function renderAdmLoop(h)"), "renderAdmLoop missing");
  assert.ok(app.includes("_lastHealth=h; renderFreshTray(h)"), "health poll must stash the payload for the admin row");
  assert.ok(app.includes("renderAdmLoop(_lastHealth); updateFreshTray(); renderAdmin();"), "openAdmin must render instantly from the stash then refresh");
  // Standing rule: every chart gets hover. Crosshair + readout, and a leave handler that hides them.
  assert.ok(app.includes("svg.addEventListener('mousemove'") && app.includes("svg.addEventListener('mouseleave'"),
    "sparkline crosshair hover is a standing delivery rule, not an option");
  assert.ok(app.includes("p50 '+ring[i][1]+'") && app.includes("max '+ring[i][3]+'"), "readout must carry the full [p50,p99,max] of the hovered window");
  // The 50ms gate line is drawn on the sparkline itself.
  assert.ok(app.includes('class="alp-gate"') && app.includes(">50ms</text>"), "decision-gate reference line + label");
  // Empty-ring state is honest, not blank.
  assert.ok(app.includes("no closed windows yet"), "empty ring renders an explanation, not nothing");
  assert.ok(html.includes('id="admLoop"'), "admin loop host div missing from markup");
  assert.ok(css.includes(".adm-loop .alp-spark{width:100%;display:block;cursor:crosshair}"), "sparkline css missing");
  // The [hidden] lesson: .adm-loop sets no display rule that could beat UA [hidden]{display:none},
  // and the row is revealed by clearing the attribute, never by a display override.
  assert.ok(!/\.adm-loop\{[^}]*display:/.test(css), ".adm-loop must not set display — [hidden] must keep working");
});

test("loop instrumentation 2026.07.29-05: renderAdmLoop EXECUTES against a full health payload and real markup emerges", () => {
  // Execution smoke per the -17 doctrine: string pins cannot catch an undeclared variable, so the
  // renderer runs for real. Reuses the drawSessions DOM stub; querySelector returns null in the
  // stub, so hover wiring is skipped (guarded in the renderer) — this validates markup emission.
  const fs = require("fs"), path = require("path");
  const app = require("./_client").clientSource();
  const { els, mk } = _sessDomStub();
  const saved = { si: global.setInterval, st: global.setTimeout, raf: global.requestAnimationFrame,
    doc: global.document, win: global.window, ls: global.localStorage, f: global.fetch };
  global.setInterval = () => 0; global.setTimeout = () => 0; global.requestAnimationFrame = () => 0;
  global.document = { getElementById: (id) => (els[id] = els[id] || mk(id)), querySelectorAll: () => [], querySelector: () => null,
    createElement: mk, addEventListener() {}, body: mk("body"), documentElement: mk("html"), hidden: false };
  global.window = { addEventListener() {}, location: { reload() {}, href: "/" }, matchMedia: () => ({ matches: false, addEventListener() {} }) };
  global.localStorage = { _d: {}, getItem(k) { return this._d[k] ?? null; }, setItem(k, v) { this._d[k] = String(v); }, removeItem(k) { delete this._d[k]; } };
  global.fetch = () => new Promise(() => {});
  try {
    const api = new Function(app + "\n;return { renderAdmLoop: typeof renderAdmLoop!=='undefined'?renderAdmLoop:null, renderFreshTray: typeof renderFreshTray!=='undefined'?renderFreshTray:null };")();
    assert.ok(api.renderAdmLoop && api.renderFreshTray, "client exposes renderAdmLoop + renderFreshTray");
    const now = Date.now();
    const hist = []; for (let i = 0; i < 12; i++) hist.push([now - (12 - i) * 6 * 3600e3, 2 + i * 0.1, 18 + i * 3, 30 + i * 4]);
    const h = { lastPoll: now, loop: { p50: 2.3, p99: 41.2, max: 78, sinceMs: 90 * 60e3, windowMs: 6 * 3600e3,
      maxEver: { v: 112, t: now - 2 * 86400e3 }, hist } };
    const box = global.document.getElementById("admLoop");
    box.innerHTML = ""; box.hidden = true;
    api.renderAdmLoop(h);   // must not throw
    const out = box.innerHTML;
    assert.ok(out.length > 500, `renderAdmLoop must emit real markup (got ${out.length} chars)`);
    for (const frag of ["p50 2.3ms", "p99 41.2ms", "max 78ms", "maxEver 112ms", 'class="alp-line"', 'class="alp-gate"', "ring 12/28"])
      assert.ok(out.includes(frag), `admin loop markup missing: ${frag}`);
    assert.equal(box.hidden, false, "the row reveals itself by clearing [hidden]");
    // p99 41.2 is in the amber band — the chip must carry the warn class, and NOT the bad class.
    assert.ok(/alp-chip warn[^>]*>p99 41\.2ms/.test(out), "p99 chip grades amber in the 20-50ms band");
    // Empty ring renders the honest placeholder, never a bare blank.
    api.renderAdmLoop({ loop: { p50: 0, p99: 0, max: 0, sinceMs: 0, windowMs: 6 * 3600e3, maxEver: null, hist: [] } });
    assert.ok(box.innerHTML.includes("no closed windows yet"), "empty ring must render the explanation");
    // Tray: the loop dot renders alongside the feed dots and grades red at the gate.
    const tray = global.document.getElementById("freshtray");
    tray.innerHTML = "";
    api.renderFreshTray({ lastPoll: now, loop: { p50: 3, p99: 61, max: 90 } });
    assert.ok(/fdot stale[^>]*>[\s\S]{0,40}Loop/.test(tray.innerHTML), "tray loop dot must render and grade red at p99 >= 50ms");
  } finally {
    global.setInterval = saved.si; global.setTimeout = saved.st; global.requestAnimationFrame = saved.raf;
    global.document = saved.doc; global.window = saved.win; global.localStorage = saved.ls; global.fetch = saved.f;
  }
});

// ===== update notice (build 2026.09.11-62) =====================================================
// A redeploy announces itself: any snapshot or SSE frame carrying a build other than the one the
// tab is running raises ONE persistent "please refresh" toast with a real reload action.
test("update notice -62: a changed server build raises one persistent refresh toast", () => {
  const fs = require("fs"), path = require("path");
  const app = require("./_client").clientSource();
  assert.ok(app.includes("if(state.build&&state.build!==s.v) notifyNewBuild(s.v); state.build=s.v;"),
    "applySnapshot compares the incoming build BEFORE overwriting — and never fires on the first snapshot");
  assert.ok(app.includes("if(d&&d.v&&state.build&&d.v!==state.build) notifyNewBuild(d.v);"),
    "the SSE frame's own v is a trigger — dataTs is a restarted counter the notice must not depend on");
  assert.ok(app.includes("if(_buildToastFor===v) return; _buildToastFor=v;"),
    "one toast per version — repeated snapshots and a dismissed toast never stack");
  assert.ok(app.includes("location.reload()"), "the offered action is a real reload, not a message");
});

// ===== row-level table patching (build 2026.07.29-09) ==========================================
test("row patching 2026.07.29-09: one producer, gated patch path, self-healing rebuild, cache discipline", () => {
  const fs = require("fs"), path = require("path");
  const app = require("./_client").clientSource();
  // ONE producer of row markup: rowHtml() exists and the <tr data-coin= template appears exactly
  // once in the whole client — a second producer is exactly the divergence this design forbids.
  assert.ok(app.includes("function rowHtml(r, vc, bScope)"), "rowHtml producer missing");
  // Other tables (EMA events, positioning) legitimately carry data-coin rows of their own shape;
  // the one-producer invariant is about the MARKET row specifically: its template line and its
  // column-walk exist exactly once, inside rowHtml.
  assert.equal(app.split('let row=`<tr data-coin=').length - 1, 1, "the market row template must exist only inside rowHtml");
  assert.equal(app.split('for(const c of vc) row+=c.td(r)').length - 1, 1, "the column walk must exist only inside rowHtml");
  assert.ok(app.includes("out.push(rowHtml(r, vc, bScope))"), "render must consume rowHtml, not inline markup");
  // Patch gate: identical structure AND the live DOM agreeing on row count — any disagreement,
  // including an external tbody write like errRow, resolves to full rebuild, never to trusting the cache.
  assert.ok(app.includes("if(_rowCache && struct===_rowStruct && body.children.length===out.length){"),
    "patch path must be triple-gated: cache primed, structure unchanged, DOM row count agrees");
  assert.ok(app.includes("coins.join('\\u0001')+'\\u0002'+vc.map(c=>c.key).join('\\u0001')+'\\u0002'+(bScope||'')"),
    "structural signature covers row identity+order, visible columns, and bench");
  // Cache discipline: primed only by a full rebuild, updated per-row on patch, dropped on empty.
  assert.ok(app.includes("_rowCache=new Map(); for(let i=0;i<coins.length;i++) _rowCache.set(coins[i], out[i]);"), "full rebuild re-primes the whole cache");
  assert.ok(app.includes("if(oldHtml[i]!==out[i]) _rowCache.set(coins[i], out[i]);"), "patch updates only the rows it wrote");
  assert.ok(app.includes("Clear the filters to see all markets.</div></td></tr>`; _rowCache=null; return;"), "the no-matches path must drop the cache");
  // Selection re-pin survives on BOTH paths (a patch may have replaced the selected row's node).
  const rf = app.slice(app.indexOf("function render(){"), app.indexOf("function updateMovers("));
  assert.ok(rf.includes("applyKsel();"), "applyKsel must still run after render");
  assert.ok(app.includes("r.flash=null;   // consumed into this string"), "flash consumption moved with the producer, unchanged in behavior");
});

test("row patching 2026.07.29-09: patched output is byte-identical to a rebuild and unchanged rows cost ZERO writes (behavioral)", () => {
  // Executes the REAL rowHtml + patchRowsInto extracted from app.js — not reimplementations — so
  // the identity guarantee is proven against shipped code: patch a mutated board, then assert the
  // assembled DOM equals what a full rebuild of the same state would produce, byte for byte, and
  // that the write count equals exactly the number of rows whose data actually moved.
  const fs = require("fs"), path = require("path");
  const app = require("./_client").clientSource();
  const escSrc = app.match(/function esc\([\s\S]*?\n(?=function|const|let)/)[0];
  const rowSrc = app.match(/function rowHtml\(r, vc, bScope\)\{[\s\S]*?\n\}/)[0];
  const patchSrc = app.match(/function patchRowsInto\(children, oldHtml, newHtml\)\{[\s\S]*?\n\}/)[0];
  const sessOpenSrc = app.match(/function sessOpenNow\(mk\)\{.*\}/)[0];   // rowHtml's home-session dependency (2026.08.14-01)
  const api = new Function("const state={dimOff:false,homeState:null,homeMkts:null};\n" + escSrc + "\n" + sessOpenSrc + "\n" + rowSrc + "\n" + patchSrc + "\n;return { rowHtml, patchRowsInto };")();
  const vc = [
    { key: "ticker", td: (r) => `<th class="rl">${r.ticker}</th>` },
    { key: "px",     td: (r) => `<td>${r.px}</td>` },
    { key: "d1",     td: (r) => `<td class="${r.d1 >= 0 ? "up" : "down"}">${r.d1}%${r.flash ? ' <i class="fl"></i>' : ""}</td>` },
  ];
  const mkRows = () => [
    { coin: "xyz:AAA", ticker: "AAA", px: 100.0, d1: 1.2, flash: null },
    { coin: "xyz:BBB", ticker: "BBB", px: 55.5,  d1: -0.4, flash: null },
    { coin: "xyz:CCC", ticker: "CCC", px: 9.87,  d1: 0.0, flash: null },
  ];
  const v1 = mkRows();
  const old = v1.map((r) => api.rowHtml(r, vc, "xyz:BBB"));
  assert.ok(old[1].includes('class="benchrow"'), "bench row must carry its class through the single producer");
  const children = old.map((h) => ({ outerHTML: h }));
  // Tick ONE row (and give it a flash), leave two untouched.
  const v2 = mkRows(); v2[0].px = 100.5; v2[0].flash = true;
  const fresh = v2.map((r) => api.rowHtml(r, vc, "xyz:BBB"));
  assert.ok(fresh[0].includes('<i class="fl"></i>'), "flash renders into the changed row's string");
  assert.equal(v2[0].flash, null, "rowHtml must consume flash exactly as the rebuild path always did");
  const writes = api.patchRowsInto(children, old, fresh);
  assert.equal(writes, 1, "exactly the one moved row may be written — unchanged rows cost zero DOM writes, which is the entire point");
  assert.equal(children.map((c) => c.outerHTML).join(""), fresh.join(""),
    "patched DOM must be BYTE-IDENTICAL to a full rebuild of the same state");
  // Second render with nothing moved: flash was consumed, so the flash class clears via ONE more
  // write on that row, and everything else stays at zero — the flash lifecycle survives patching.
  const v3 = mkRows(); v3[0].px = 100.5;
  const settled = v3.map((r) => api.rowHtml(r, vc, "xyz:BBB"));
  const writes2 = api.patchRowsInto(children, fresh, settled);
  assert.equal(writes2, 1, "flash clearance is one write on the flashed row, none elsewhere");
  assert.ok(!children[0].outerHTML.includes('class="fl"'), "flash class actually cleared");
  const writes3 = api.patchRowsInto(children, settled, settled.slice());
  assert.equal(writes3, 0, "an identical board costs zero writes");
});

// ================================================================================================
// Markets group lens (build 2026.08.07-01): Stocks | Sectors | Industries on the Markets tab.
// ================================================================================================

test("markets group lens: manifest pins across app.js / index.html / styles.css", () => {
  const fs = require("fs"), path = require("path");
  const app = require("./_client").clientSource();
  for (const pin of [
    "function mktGrp()", "state.scope==='crypto'&&g==='industries'",   // crypto coerces industries -> sectors, never rewrites the choice
    "function computeMktGroups(rows, mode, wt)", "function mktGroupCohesion(list)",
    "function groupRowsSorted()", "function buildGroupHead()", "function renderGroupBoard()",
    "function drillInto(name)", "function clearDrill()", "function updateDrillChip()",
    "function setGrp(v)", "function syncGrpSeg()", "function thresholdRows(rows)",
    "grp:'names', grpWt:'vol', grpSort:{key:'d1',dir:'desc'}, grpDrill:null",
    "if(mktGrp()!=='names'){ renderGroupBoard(); return; }",           // render() branches to the lens
    "if(mktGrp()!=='names'){ buildGroupHead(); return; }",             // buildHead() branches with it
    "_rowCache=null; _rowStruct='';",                                  // the names-mode row patcher never diffs against group markup
    "state.grpDrill&&state.grpDrill.set",                              // drill filter applied in sortedRows
    "||mktGrp()!=='names') return;",                                   // j/k/Enter stay a names-view affordance
    "if(state.grpDrill){ state.grpDrill=null; updateDrillChip(); }",   // a scope flip clears the drill — a cross-universe member set would empty the board
    "else if(state.grpDrill) clearDrill()",                            // Escape clears the drill after ksel — parity with the chip's ×
    "xyz-markets-${mktGrp()}.csv",                                     // lens CSV export
    "grp:state.grp, grpWt:state.grpWt",                                // persisted...
    "if(p.grp==='sectors'||p.grp==='industries'||p.grp==='names') state.grp=p.grp",   // ...and restored, validated
    "mode==='industries'?(r.ind||r.sector):r.sector",                  // grouping keys = the classification contract, verbatim
    "mode==='industries' && ms.every(m=>!m.ind)",                      // fallback industry groups marked, never hidden
  ]) assert.ok(app.includes(pin), "app.js pin missing: " + pin);
  // Every lens column is declared in GCOLS with its key.
  for (const k of ["'name'","'n'","'dopen'","'h1'","'h4'","'d1'","'d7'","'d30'","'mopen'","'yopen'","'br'","'doi'","'rvol'","'vol'","'oi'","'coh'","'bw'"])
    assert.ok(app.includes("{key:" + k + ", label:"), "GCOLS column missing: " + k);
  const ht = fs.readFileSync(path.join(__dirname, "..", "public", "index.html"), "utf8");
  for (const pin of ['id="grpseg"', 'data-grp="names"', 'data-grp="sectors"', 'data-grp="industries"',
    'id="grpwtseg"', 'data-gwt="vol"', 'data-gwt="eq"', 'id="drillchip"'])
    assert.ok(ht.includes(pin), "index pin missing: " + pin);
  const cs = fs.readFileSync(path.join(__dirname, "..", "public", "styles.css"), "utf8");
  for (const pin of [".drillchip{", ".drillchip .x", ".drillchip[hidden]{display:none}"])
    assert.ok(cs.includes(pin), "styles pin missing: " + pin);
});

test("computeMktGroups: vol-weighted averages with per-key coverage renormalization (behavioral)", () => {
  const fn = mktGroupsFn();
  const list = fn(mktGroupsFixture(), "sectors", "vol");
  const it = list.find((g) => g.name === "Information Technology");
  assert.ok(it && it.n === 3, "IT sector groups its three members");
  // 24h: all three report. Vol weights 300/100/0 -> NVDA .75, AMD .25, ORCL 0 -> 0.75*3 + 0.25*(-1) = 2.0
  assert.ok(Math.abs(it.agg.d1.v - 2.0) < 1e-9 && it.agg.d1.n === 3, "vol-weighted 24h = 2.0 over 3/3 members");
  // 30d: AMD is null -> excluded, weights renormalize over NVDA+ORCL (300/0) -> NVDA alone = 10, coverage 2/3
  assert.ok(Math.abs(it.agg.d30.v - 10) < 1e-9 && it.agg.d30.n === 2, "missing 30d excluded with weights renormalized, coverage disclosed");
  // M open: distance from the LEVEL, per member — NVDA (100/90-1)*100; AMD null; ORCL vol-0 so weight 0
  assert.ok(Math.abs(it.agg.mopen.v - ((100 / 90 - 1) * 100)) < 1e-9 && it.agg.mopen.n === 2, "mopen% derived from px vs the open level");
  // Breadth + best/worst pinned to 24h
  assert.equal(it.brUp, 2); assert.equal(it.brN, 3);
  assert.deepStrictEqual([it.best.t, it.worst.t], ["NVDA", "AMD"], "best/worst by 24h");
  assert.ok(Math.abs(it.best.v - 3) < 1e-9 && Math.abs(it.worst.v - (-1)) < 1e-9);
  assert.equal(it.totVol, 400); assert.equal(it.totOI, 17);
  assert.ok(list.find((g) => g.name === "Energy") && list.find((g) => g.name === "Unclassified"), "Energy and Unclassified rows exist");
});

test("computeMktGroups: equal weighting is one member one vote; zero-vol members count fully", () => {
  const fn = mktGroupsFn();
  const it = fn(mktGroupsFixture(), "sectors", "eq").find((g) => g.name === "Information Technology");
  assert.ok(Math.abs(it.agg.d1.v - (3 - 1 + 2) / 3) < 1e-9, "equal-weighted 24h = 4/3");
  // 30d equal: NVDA 10, ORCL 4 (AMD null) -> 7 over 2 members
  assert.ok(Math.abs(it.agg.d30.v - 7) < 1e-9 && it.agg.d30.n === 2, "equal weighting renormalizes over reporting members too");
});

test("computeMktGroups: industries mode groups on ind||sector; fallback groups are marked, never hidden", () => {
  const fn = mktGroupsFn();
  const list = fn(mktGroupsFixture(), "industries", "vol");
  const semi = list.find((g) => g.name === "Semiconductors");
  assert.ok(semi && semi.n === 2 && !semi.fall, "curated industry groups NVDA+AMD");
  assert.deepStrictEqual(semi.members.map((r) => r.ticker).sort(), ["AMD", "NVDA"]);
  const fb = list.find((g) => g.name === "Information Technology");
  assert.ok(fb && fb.n === 1 && fb.fall === true && fb.members[0].ticker === "ORCL",
    "a name with no curated industry falls back to its sector as a VISIBLY marked group");
  const ep = list.find((g) => g.name === "E&P/Majors");
  assert.ok(ep && ep.n === 1, "cross-checked: XOM lands in its curated industry");
  // Sectors mode must ignore `ind` entirely — the two lenses may never blur.
  const sec = fn(mktGroupsFixture(), "sectors", "vol").find((g) => g.name === "Semiconductors");
  assert.equal(sec, undefined, "sectors mode never groups on the industry key");
});

test("action math: pace acceleration, flow-confirmed heat, and the three gates (behavioral)", () => {
  const { ACT_LEGS, accelPace, heatOf, pickAction } = actionMathFns();
  // every window pairs with its natural fast leg — the multi-timeframe contract
  assert.deepStrictEqual(ACT_LEGS["1h"], ["m15", 0.25, "h1", 1]);
  assert.deepStrictEqual(ACT_LEGS["1d"], ["h4", 4, "d1", 24]);
  assert.deepStrictEqual(ACT_LEGS["30d"], ["d7", 168, "d30", 720]);
  // accel: fast leg minus the window's own pace. +2% fast vs a +6% window over 4/24h -> 2 − 6·(1/6) = +1
  assert.ok(Math.abs(accelPace(2, 6, 4, 24) - 1) < 1e-12, "outrunning the pace is positive");
  assert.ok(Math.abs(accelPace(0, 6, 4, 24) + 1) < 1e-12, "a flat fast leg under a rising window is a stall");
  assert.equal(accelPace(null, 6, 4, 24), null, "missing leg -> null, never 0");
  // heat: ΔOI always confirms; RVOL only inside its clock-matched ≤1d domain
  assert.ok(Math.abs(heatOf(1, 8, 2, 24) - (1 + 0.6 * Math.tanh(1) + 0.4)) < 1e-12, "1d window: both flow terms live");
  assert.ok(Math.abs(heatOf(1, 8, 2, 168) - (1 + 0.6 * Math.tanh(1))) < 1e-12, "7d window: RVOL dropped, not faked");
  assert.ok(Math.abs(heatOf(1, null, null, 24) - 1) < 1e-12, "missing flow -> bare accel, no invented terms");
  assert.equal(heatOf(null, 8, 2, 24), null, "no accel, no heat");
  // gates: heating needs positive accel AND heat; cooling needs a trend vs the tape that is stalling;
  // bid needs a majority reclaim; ranking = dip × rec / √mins
  const scored = [
    { r: {}, winRel: 3, accel: 1.2, heat: 1.8, bid: null },                       // heating
    { r: {}, winRel: 4, accel: -0.9, heat: -1.1, bid: null },                     // cooling: ahead, stalling
    { r: {}, winRel: -2, accel: -1.5, heat: -2.0, bid: null },                    // laggard: NEITHER list — the ignore pile
    { r: {}, winRel: 0.5, accel: 0.4, heat: -0.2, bid: null },                    // accel up but flow against it: not heating
    { r: {}, winRel: 0, accel: 0, heat: 0, bid: { d: 3.0, r: 0.9, m: 90 } },      // strong bid
    { r: {}, winRel: 0, accel: 0, heat: 0, bid: { d: 1.0, r: 0.95, m: 30 } },     // shallower but faster
    { r: {}, winRel: 0, accel: 0, heat: 0, bid: { d: 4.0, r: 0.3, m: 60 } },      // deep dip, minority reclaim: no claim
  ];
  const picks = pickAction(scored);
  assert.equal(picks.heat.length, 1); assert.ok(picks.heat[0].accel === 1.2);
  assert.equal(picks.cool.length, 1); assert.ok(picks.cool[0].winRel === 4, "only the stalled LEADER cools — laggards are ignored, not listed");
  assert.equal(picks.bid.length, 2, "sub-50% reclaims never rank");
  assert.ok(Math.abs(picks.bid[0].bidScore - 3.0 * 0.9 / Math.sqrt(90)) < 1e-12 &&
    picks.bid[0].bidScore > picks.bid[1].bidScore, "rank = dip × rec / √mins, deep-and-fast first");
});

test("rotation + action manifest: wire, merge, leaders fill, drill unification, markup, styles", () => {
  const fs = require("fs"), path = require("path");
  const pol = fs.readFileSync(path.join(__dirname, "..", "src", "poller.js"), "utf8");
  for (const pin of [
    "const RECLAIM_MIN_DIP_PCT = 0.35;",
    "const tail5 = store.readCandles(r.coin, now - SWEEP_LOOK_MS, now);",       // ONE archive read...
    "r.bidInfo = dipReclaim(tail5, r.px, now, RECLAIM_MIN_DIP_PCT);",           // ...feeds the reclaim...
    "const sw = detectSweep(tail5, dayHi, dayLo, r.px, SWEEP_FRAC);",           // ...and the sweep detector
    "bid: r.bidInfo ? { d: r.bidInfo.dip, r: r.bidInfo.rec, m: r.bidInfo.mins } : undefined,",
  ]) assert.ok(pol.includes(pin), "poller pin missing: " + pin);
  const app = require("./_client").clientSource();
  for (const pin of [
    "r.bid=(m.bid!==undefined&&m.bid!==null)?m.bid:null;",                      // absence clears, never carries
    "function actionScores()", "function renderActionLists()", "function actChip(s, kind)",
    "if(state.grpDrill&&state.grpDrill.set) rows=rows.filter(r=>state.grpDrill.set.has(r.coin));   // the lists always describe exactly the rows the table shows",
    "renderActionLists();   // the rate-of-change lists under the table describe exactly what it just rendered",
    "renderActionLists();   // -05: group heating/cooling + name-level bid render under the lens too",
    "function drillMembers(label, coins)",                                       // one drill entry point...
    "drillMembers(name, g.members.map(r=>r.coin));",                             // ...used by the lens row click...
    "db.onclick=()=>drillMembers(g.name, g.members.map(r=>r.coin));",            // ...and the sector-detail button
    'id="sectDetDrill"',
    "out.push({name:g.name, x, y, vol:g.totVol, doi:g.doi, coins:g.members.map(r=>r.coin)});",
    "const fC=fN==null?'var(--muted)':(fN>=0?'var(--up)':'var(--down)');",       // leaders money-fill
    "actOpen2:state.actOpen?1:0,",                                           // -03 pref key: the -02 key stored the unchosen collapsed default, see loadPrefs comment
    "state.actOpen = p.actOpen2===undefined ? true : !!p.actOpen2;",           // open by default (-03), explicit collapse respected
    "actOpen:true,",
  ]) assert.ok(app.includes(pin), "app.js pin missing: " + pin);
  const ht = fs.readFileSync(path.join(__dirname, "..", "public", "index.html"), "utf8");
  for (const pin of ['id="actwrap"', 'id="acthead"', 'id="actbody"', 'id="actmeta"'])
    assert.ok(ht.includes(pin), "index pin missing: " + pin);
  const cs = fs.readFileSync(path.join(__dirname, "..", "public", "styles.css"), "utf8");
  for (const pin of [".actwrap{", ".achip{", ".acol .ah.hbid"])
    assert.ok(cs.includes(pin), "styles pin missing: " + pin);
});

test("leaders rank arrows: trajectory glyph, quadrant color, phrase honest about which side of the S&P (build -04)", () => {
  const fs = require("fs"), path = require("path");
  const app = require("./_client").clientSource();
  for (const pin of [
    "const q=leadQuad(s.x,s.y);",                                              // rank list speaks the map's own quadrant vocabulary
    "behind the S&amp;P, but closing the gap — losing by less lately, not beating it",
    "still ahead of the S&amp;P, but the lead is shrinking",
    "ahead of the S&amp;P and pulling further away (lead growing)",
    "behind the S&amp;P and falling further behind",
    '`<span style="color:${q.c}" title="${phrase} — ${q.l}">${s.y>=0?\'▲\':\'▼\'}</span>`',
  ]) assert.ok(app.includes(pin), "leaders-rank pin missing: " + pin);
  assert.ok(!app.includes('title="beating the S&amp;P by more lately (lead growing)">▲'),
    "the one-phrase-for-all-quadrants arrow must stay dead — it claimed laggards were beating the index");
  assert.ok(app.includes("const rowTip=`${s.name}: ${s.x>=0?'+':''}${s.x.toFixed(1)}% vs the S&P over ${wl} · trajectory ${s.y>=0?'+':''}${s.y.toFixed(1)}pp"),
    "rank rows hover with full name, exact distance and trajectory magnitude — the arrow only shows its sign");
  assert.ok(app.includes('width:128px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis'),
    "rank labels never wrap rows out of alignment — ellipsis with the full name in the row hover");
});

test("chip stories manifest: tag rendered on name and group chips, story leads every hover", () => {
  const fs = require("fs"), path = require("path");
  const app = require("./_client").clientSource();
  for (const pin of [
    "function chipStory(kind, winRet, doi, rec, grouped)",
    "let why, tip, story=chipStory(kind, s.winRet, r.doi, s.bid?s.bid.r:null, false);",
    "const story=chipStory(kind, s.winRet, g.agg.doi?g.agg.doi.v:null, null, true);",
    "${story.tag.toUpperCase()} — ${story.text}",                              // the story LEADS the hover, recipe follows
  ]) assert.ok(app.includes(pin), "app.js pin missing: " + pin);
  assert.ok((app.match(/class="tag t-\$\{/g) || []).length === 2, "the visible tag renders on BOTH chip flavors");
  const cs = fs.readFileSync(path.join(__dirname, "..", "public", "styles.css"), "utf8");
  for (const pin of [".achip .tag{", ".achip .tag.t-turn", ".achip .tag.t-dist",
    ".achip .rt{min-width:56px;flex:none;white-space:nowrap}",   // -06: fixed cells never shrink below content — the "+29.60%M +67" glue
    ".achip .why{color:var(--muted);font-size:var(--fs-xs);flex:1;min-width:140px}"])
    assert.ok(cs.includes(pin), "styles pin missing: " + pin);
});

test("anchored-open wiring pins: poller snapshot path + client column family, defaults, migration", () => {
  const fs = require("fs"), path = require("path");
  const pol = fs.readFileSync(path.join(__dirname, "..", "src", "poller.js"), "utf8");
  const app = require("./_client").clientSource();
  // poller: computed at snapshot time from the live clock, shipped sig-quantized like p5m/p15m
  assert.ok(pol.includes("const bopen = bucketOpens(r.hourlyRaw, nowMs, HOUR)"), "mapMarket must anchor on the snapshot's own nowMs");
  assert.ok(pol.includes("hopenPx: sig(bopen.h, 9) ?? undefined"), "hopenPx ships quantized, absent-when-null");
  assert.ok(pol.includes("h4openPx: sig(bopen.h4, 9) ?? undefined") && pol.includes("h12openPx: sig(bopen.h12, 9) ?? undefined"), "4h/12h levels ship the same way");
  // client: copy (absence-means-clear), one-code-path derivation, the shared renderer, three column defs
  assert.ok(app.includes("r.hopenPx=(m.hopenPx!=null)?m.hopenPx:null;"), "snapshot copy must clear on absence — a kept stale anchor lies");
  assert.ok(app.includes("r.hopen=r.hopenPx>0?(cur-r.hopenPx)/r.hopenPx*100:null;"), "hopen % derives from the shipped level in recomputeChanges");
  assert.ok(app.includes("r.h4open=r.h4openPx>0?") && app.includes("r.h12open=r.h12openPx>0?"), "4h/12h derive the same way");
  assert.ok(app.includes("function anchOpenCell(r,key,pxKey,what,cap)"), "shared anchored-open renderer missing");
  for (const k of ["hopen", "h4open", "h12open"]) {
    assert.ok(app.includes("{key:'" + k + "',"), "COLS entry for " + k + " missing");
    assert.ok(new RegExp("DEFAULT_HIDDEN=\\[[^\\]]*'" + k + "'").test(app), k + " must ship hidden by default");
    assert.ok(new RegExp("DEFAULT_ORDER=\\[[^\\]]*'dopen','hopen','h4open','h12open'").test(app), "the trio sits next to D open in the default order");
  }
  // saved-layout migration: the trio slots in next to D open at BOTH merge sites, never appended far right
  assert.equal((app.match(/colAdjacent\((v|ord),'hopen','dopen'\)/g) || []).length, 2, "hopen adjacency migration must run in loadPrefs AND layout apply");
  assert.equal((app.match(/colAdjacent\((v|ord),'h4open','hopen'\)/g) || []).length, 2, "h4open adjacency migration at both sites");
  assert.equal((app.match(/colAdjacent\((v|ord),'h12open','h4open'\)/g) || []).length, 2, "h12open adjacency migration at both sites");
});

// ===== home sessions: KRX/TSE/HKEX re-anchoring (build 2026.08.14-01) =========================
// Behavioral tests execute the REAL calendar math (the -84 lesson: string pins prove nothing
// about correctness); manifest pins below prove the wiring exists in poller/app/index/styles.
{
  const { homeMkt, homeAdr } = require("../src/sectors");
  const { HOME_MKTS, homeCalCovered, homeCalHorizon, homeDayStatus, homeWallToUtc,
    homeMarketSessions, homeCashAnchors, homeClosedWindows, homeOvernightAnchors, homeWeekendAnchors } = require("../src/compute");

  test("homeMkt: curated foreign-home set, ADRs stay US, crypto scope always null", () => {
    for (const t of ["SMSN", "SKHX", "HYUNDAI"]) assert.equal(homeMkt(t), "KR", t + " -> KR");
    for (const t of ["SOFTBANK", "KIOXIA", "IBIDEN"]) assert.equal(homeMkt(t), "JP", t + " -> JP");
    for (const t of ["ZHIPU", "MINIMAX"]) assert.equal(homeMkt(t), "HK", t + " -> HK (HKEX listings, Jan 2026)");
    // Index perps (-03): the cash index only prints during home hours — same freeze as a single name.
    assert.equal(homeMkt("JP225"), "JP", "Nikkei perp anchors to TSE");
    assert.equal(homeMkt("KR200"), "KR", "KOSPI perp anchors to KRX");
    assert.equal(homeMkt("KORU"), null, "US-listed leveraged ETF stays US — the listed line IS the reference");
    for (const t of ["NVDA", "TSM", "ASML", "ARM", "BABA", "AAPL"]) assert.equal(homeMkt(t), null, t + " keeps the full ET machinery");
    assert.equal(homeMkt("SMSN", "main"), null, "crypto scope never routes to a home market");
    assert.equal(homeMkt("smsn"), "KR", "norm() applies — case-insensitive");
    // ADR annotation lives in a SEPARATE table so it can never leak into anchoring.
    assert.equal(homeAdr("TSM"), "TW"); assert.equal(homeAdr("BABA"), "HK"); assert.equal(homeAdr("SMSN"), null);
  });

  test("homeDayStatus: curated 2026 closures land, half days distinct, weekends always closed", () => {
    // KRX: Seollal block + observed Liberation Day + year-end closure.
    assert.equal(homeDayStatus("KR", 2026, 2, 16), 2, "Seollal Mon");
    assert.equal(homeDayStatus("KR", 2026, 2, 18), 2, "Seollal Wed");
    assert.equal(homeDayStatus("KR", 2026, 8, 17), 2, "Liberation Day observed Mon");
    assert.equal(homeDayStatus("KR", 2026, 12, 31), 2, "KRX year-end closure");
    assert.equal(homeDayStatus("KR", 2026, 8, 13), 0, "regular Thursday trades");
    // TSE: exchange New-Year closure, Golden Week, the Sep 22 bridge holiday, year-end.
    assert.equal(homeDayStatus("JP", 2026, 1, 2), 2, "TSE Jan 2 exchange closure");
    assert.equal(homeDayStatus("JP", 2026, 5, 6), 2, "Constitution Day observed (Golden Week)");
    assert.equal(homeDayStatus("JP", 2026, 9, 22), 2, "bridge holiday between Respect-for-Aged and the equinox");
    assert.equal(homeDayStatus("JP", 2026, 7, 20), 2, "Marine Day");
    // HKEX: CNY block Tue-Thu (Mon 16th OPEN), half days close 12:00 local.
    assert.equal(homeDayStatus("HK", 2026, 2, 16), 0, "HKEX trades the Monday KRX doesn't");
    assert.equal(homeDayStatus("HK", 2026, 2, 17), 2, "CNY");
    assert.equal(homeDayStatus("HK", 2026, 12, 24), 1, "Christmas Eve half day");
    assert.equal(homeDayStatus("HK", 2026, 12, 31), 1, "NYE half day");
    // Weekends closed in every market regardless of table coverage.
    assert.equal(homeDayStatus("KR", 2026, 8, 15), 2, "Saturday");
    assert.equal(homeDayStatus("JP", 2027, 1, 3), 2, "Sunday beyond the horizon is still closed");
  });

  test("home calendars: fixed-offset wall clocks are exact (no DST in KST/JST/HKT)", () => {
    // 09:00 KST on 2026-08-13 is exactly 00:00 UTC the same date.
    assert.equal(homeWallToUtc("KR", 2026, 8, 13, 9, 0), Date.UTC(2026, 7, 13, 0, 0));
    // 09:30 HKT (UTC+8) is 01:30 UTC.
    assert.equal(homeWallToUtc("HK", 2026, 8, 13, 9, 30), Date.UTC(2026, 7, 13, 1, 30));
    const ses = homeMarketSessions("KR", Date.UTC(2026, 7, 13, 0, 0) - DAY, Date.UTC(2026, 7, 13, 0, 0) + DAY)
      .filter((x) => x.open === Date.UTC(2026, 7, 13, 0, 0));
    assert.equal(ses.length, 1, "the Aug 13 KRX session exists exactly once");
    assert.equal(ses[0].close, Date.UTC(2026, 7, 13, 6, 30), "15:30 KST close = 06:30 UTC");
    // HK half day: Dec 24 closes at 12:00 HKT = 04:00 UTC.
    const hd = homeMarketSessions("HK", Date.UTC(2026, 11, 23), Date.UTC(2026, 11, 25))
      .filter((x) => x.open === homeWallToUtc("HK", 2026, 12, 24, 9, 30));
    assert.equal(hd.length, 1);
    assert.equal(hd[0].close, homeWallToUtc("HK", 2026, 12, 24, 12, 0), "half day closes at the half mark, not 16:00");
  });

  test("home closed windows: same 40h overnight/weekend split as the ET engine, holiday spans pool", () => {
    // A plain KRX Tue->Wed night is an overnight; the Chuseok span (Wed 23rd close -> Mon 28th
    // open, with 24-25 closed + the weekend) is one long weekend-class hold.
    const s = homeWallToUtc("KR", 2026, 9, 20, 0, 0), e = homeWallToUtc("KR", 2026, 9, 30, 0, 0);
    const wins = homeClosedWindows("KR", s, e);
    const night = wins.find((w) => w.enter === homeWallToUtc("KR", 2026, 9, 22, 15, 30));
    assert.ok(night && night.tag === "overnight", "Tue 22nd close -> Wed 23rd open is a plain overnight");
    const chuseok = wins.find((w) => w.enter === homeWallToUtc("KR", 2026, 9, 23, 15, 30));
    assert.ok(chuseok, "the Chuseok window exists");
    assert.equal(chuseok.exit, homeWallToUtc("KR", 2026, 9, 28, 9, 0), "spans 24-25 closed + weekend to Monday's open");
    assert.equal(chuseok.tag, "weekend", ">=40h behaves like one hold, exactly as US holiday weekends do");
    assert.equal(homeOvernightAnchors("KR", s, e).concat(homeWeekendAnchors("KR", s, e)).length, wins.length,
      "the two filters partition the closed windows");
    const cash = homeCashAnchors("KR", s, e);
    assert.ok(cash.every((a) => a.tag === "cash" && a.exit > a.enter), "cash anchors well-formed");
    assert.ok(!cash.some((a) => a.enter === homeWallToUtc("KR", 2026, 9, 24, 9, 0)), "no session minted on a Chuseok closure");
  });

  test("home calendars: past the curated horizon the engine degrades to weekend-only and SAYS so", () => {
    assert.equal(homeCalHorizon("KR"), 2026, "curated through 2026 — extending is a curated edit when KRX publishes 2027");
    assert.equal(homeCalCovered("KR", 2026), true);
    assert.equal(homeCalCovered("KR", 2027), false, "consumers must flag 2027 as approximate");
    // 2027-02-08 area will hold Seollal, but without the table a plain weekday reads as open —
    // that is the DEGRADE contract: weekend-only, never a guessed lunar date.
    assert.equal(homeDayStatus("KR", 2027, 2, 10), 0, "weekday beyond horizon trades under the approximation");
    assert.equal(homeDayStatus("KR", 2027, 2, 13), 2, "Saturday beyond horizon still closed");
    for (const mk of ["KR", "JP", "HK", "CN"]) assert.ok(HOME_MKTS[mk] && HOME_MKTS[mk].utcOff >= 8, mk + " def present");
  });

  test("Shanghai (2026.09.20): SSE joins the home-market table — hours, lunch, 2026 closures, the STAR names", () => {
    const M = HOME_MKTS.CN;
    assert.deepEqual([M.ex, M.utcOff, M.o, M.c, M.half], ["SSE", 8, [9, 30], [15, 0], null]);
    assert.deepEqual(M.lunch, [[11, 30], [13, 0]], "the 90-minute lunch halt is declared for the ribbon, not modeled in the holds");
    for (const t of ["CXMT", "YMTC", "GIGADEV", "UNITREE"]) assert.equal(homeMkt(t, "xyz"), "CN", t + " anchors to Shanghai");
    assert.equal(homeMkt("CXMT", "main"), null, "crypto scope never has a home market");
    assert.equal(homeCalCovered("CN", 2026), true); assert.equal(homeCalCovered("CN", 2027), false);
    // Spring Festival 2026 (CNY Feb 17): the exchange is shut Feb 16-23; Feb 14 is a make-up
    // WORKING day on the State Council calendar but a Saturday, and the exchange never opens one.
    for (const d of [16, 17, 18, 19, 20, 23]) assert.equal(homeDayStatus("CN", 2026, 2, d), 2, "Feb " + d + " closed for Spring Festival");
    assert.equal(homeDayStatus("CN", 2026, 2, 14), 2, "make-up Saturday: still closed");
    assert.equal(homeDayStatus("CN", 2026, 2, 24), 0, "first session back");
    assert.equal(homeDayStatus("CN", 2026, 10, 1), 2, "National Day"); assert.equal(homeDayStatus("CN", 2026, 10, 7), 2);
    assert.equal(homeDayStatus("CN", 2026, 10, 8), 0);
    assert.equal(homeDayStatus("CN", 2026, 4, 6), 2, "Qingming Monday"); assert.equal(homeDayStatus("CN", 2026, 6, 19), 2, "Dragon Boat");
    assert.equal(homeDayStatus("CN", 2026, 9, 25), 2, "Mid-Autumn"); assert.equal(homeDayStatus("CN", 2026, 1, 2), 2, "New Year bridge");
    assert.equal(homeDayStatus("CN", 2026, 3, 2), 0, "an ordinary Monday trades");
    // Wall clock: 09:30 CST is 01:30 UTC, 21:30 ET the previous evening — the mirror of the ET day.
    assert.equal(homeWallToUtc("CN", 2026, 3, 2, 9, 30), Date.UTC(2026, 2, 2, 1, 30));
    // Sessions: the Spring Festival week yields none, and the closed window across it pools as one weekend-class hold.
    const ses = homeMarketSessions("CN", Date.UTC(2026, 1, 15), Date.UTC(2026, 1, 23, 23));
    assert.equal(ses.filter((s) => s.open >= Date.UTC(2026, 1, 16) && s.open < Date.UTC(2026, 1, 24)).length, 0, "no session Feb 16-23");
    const win = homeClosedWindows("CN", Date.UTC(2026, 1, 12), Date.UTC(2026, 1, 26));
    const span = win.find((w) => w.exit === homeWallToUtc("CN", 2026, 2, 24, 9, 30));
    assert.ok(span && span.tag === "weekend" && span.enter === homeWallToUtc("CN", 2026, 2, 13, 15, 0), "Feb 13 close -> Feb 24 open is one hold");
    // The poller ships CN with the other three — nothing enumerates the markets by hand any more.
    const { createPoller } = require("../src/poller");
    const store = { loadAll: () => new Map(), loadRegime: () => [], loadLedger: () => null, saveLedger: () => {}, insert: () => {}, saveRegime: () => {} };
    const p = createPoller({ dex: "xyz", store, log: () => {}, version: "test", crypto: false });
    p.seedRowNow("xyz:CXMT", { px: 8.5, ticker: "CXMT", uni: "xyz", vol: 1e6 });
    p.buildSnapshotNow();
    const snap = p.getSnapshot();
    assert.ok(snap.homeMkts.CN && snap.homeMkts.CN.ex === "SSE" && snap.homeState.CN && typeof snap.homeState.CN.closed === "boolean", "CN rides the wire");
    assert.equal(snap.markets.find((m) => m.ticker === "CXMT").hm, "CN", "the row carries its home market");
  });

  test("home-session wiring manifest: poller re-anchors, ships state; client renders it; A+C+E present", () => {
    const fs = require("fs"), path = require("path");
    const pol = fs.readFileSync(path.join(__dirname, "..", "src", "poller.js"), "utf8");
    for (const pin of ["computeOffHoursHome", "homeStateAll", "HOME_MKTS_WIRE", "rowOffState",
      "hm: homeMkt(r.ticker, r.uni) || undefined", "hadr: homeAdr(r.ticker) || undefined",
      "homeMkts: HOME_MKTS_WIRE, homeState", "offHoursBy", "foreignExcluded",
      "homeOvernightAnchors(hmk", "homeWeekendAnchors(hmk"])
      assert.ok(pol.includes(pin), "poller pin missing: " + pin);
    // The daily + snapshot signatures must both carry the home flips, or foreign names go stale.
    // Every market in the table, never a fixed list — adding SSE (2026.09.20) must not need a second edit here.
    assert.ok(/Object\.keys\(HOME_MKTS\)\.map\(\(k\) => \(offHoursBy\[k\]\.closed \? 1 : 0\)\)/.test(pol), "daily sig signs home flips");
    assert.ok(/Object\.keys\(HOME_MKTS\)\.map\(\(k\) => \(homeState\[k\]\.closed \? 1 : 0\)/.test(pol), "snapshot csig signs home flips");
    const app = require("./_client").clientSource();
    for (const pin of ["function rowSessState", "function sessCell", "function railHtml", "function cdsHtml",
      "function sessDrawerHtml", "function homeArcSvg", "key:'sess'", "state.dimOff", "s.homeState", "s.homeMkts",
      "if(prev!=null&&prev!==sig) loadDaily()"])
      assert.ok(app.includes(pin), "app pin missing: " + pin);
    // Variant A dims via a row class the cache/patcher can diff; the gap cell reads the ROW's state.
    assert.ok(app.includes("'dimoff'") || app.includes('"dimoff"') || app.includes("dimoff'"), "dimoff row class");
    assert.ok(app.includes("const oh=rowSessState(r)"), "gap live-mode keys off the row's own market");
    // Variant A executed through the REAL rowHtml (the -84 lesson: the class must actually land):
    // a KR-home row under dimOff with KRX closed dims; a US row never does; benchrow composes.
    const escSrc = app.match(/function esc\([\s\S]*?\n(?=function|const|let)/)[0];
    const rowSrc = app.match(/function rowHtml\(r, vc, bScope\)\{[\s\S]*?\n\}/)[0];
    const sessOpenSrc = app.match(/function sessOpenNow\(mk\)\{.*\}/)[0];
    const mk = new Function("const state={dimOff:true,homeState:{KR:{closed:true},JP:{closed:false}},homeMkts:null};\n"
      + escSrc + "\n" + sessOpenSrc + "\n" + rowSrc + "\n;return rowHtml;")();
    const vc = [{ key: "ticker", td: (r) => `<td>${r.ticker}</td>` }];
    assert.ok(/class="dimoff"/.test(mk({ coin: "x:SMSN", ticker: "SMSN", hm: "KR", flash: null }, vc, null)),
      "KR-home row dims while KRX is closed and the toggle is armed");
    assert.ok(!/dimoff/.test(mk({ coin: "x:SOFTBANK", ticker: "SOFTBANK", hm: "JP", flash: null }, vc, null)),
      "JP-home row stays full-strength while TSE is open — dim keys off the ROW's market, not a global");
    assert.ok(!/dimoff/.test(mk({ coin: "x:NVDA", ticker: "NVDA", flash: null }, vc, null)),
      "US rows never dim");
    assert.ok(/class="benchrow dimoff"/.test(mk({ coin: "x:SMSN", ticker: "SMSN", hm: "KR", flash: null }, vc, "x:SMSN")),
      "bench + dim compose in one class attribute");
    const idx = fs.readFileSync(path.join(__dirname, "..", "public", "index.html"), "utf8");
    assert.ok(idx.includes('id="dimOff"'), "dim toggle button in the filter popover");
    const css = fs.readFileSync(path.join(__dirname, "..", "public", "styles.css"), "utf8");
    for (const pin of [".sesschip", ".hrail", ".cds", "tr.dimoff td", ".dsessrib"])
      assert.ok(css.includes(pin), "css pin missing: " + pin);
  });
}

// The -01 field-drop bug, made unrepeatable (same shape as -04/ind): the poller shipped hm/hadr,
// applySnapshot's EXPLICIT merge dropped them, every Sess chip rendered US. String pins on the
// wire and on sessCell could not catch it — only pushing a payload through the REAL ingestion
// path can. -17 harness pattern, exactly as the -05 ind regression does.
test("2026.08.14-02 regression: applySnapshot carries hm/hadr into state.rows; chip + live gap read them", () => {
  const fs = require("fs"), path = require("path");
  const app = require("./_client").clientSource();
  const { els, mk } = _sessDomStub();
  const saved = { si: global.setInterval, st: global.setTimeout, raf: global.requestAnimationFrame,
    doc: global.document, win: global.window, ls: global.localStorage, f: global.fetch };
  global.setInterval = () => 0; global.setTimeout = () => 0; global.requestAnimationFrame = () => 0;
  global.document = { getElementById: (id) => (els[id] = els[id] || mk(id)), querySelectorAll: () => [], querySelector: () => null,
    createElement: mk, addEventListener() {}, body: mk("body"), documentElement: mk("html"), hidden: false };
  global.window = { addEventListener() {}, location: { reload() {}, href: "/" }, matchMedia: () => ({ matches: false, addEventListener() {} }) };
  global.localStorage = { _d: {}, getItem(k) { return this._d[k] ?? null; }, setItem(k, v) { this._d[k] = String(v); }, removeItem(k) { delete this._d[k]; } };
  global.fetch = () => new Promise(() => {});
  try {
    const S = require("../src/sectors");
    let H = null;
    eval(app + "\n; H={state, applySnapshot, sessCell, rowSessState, railHtml, cdsHtml};");
    // Rows EXACTLY as the poller ships them — hm/hadr from the same curated accessors, one code path.
    const wire = (t) => ({ coin: "xyz:" + t, ticker: t, uni: "xyz",
      hm: S.homeMkt(t, "xyz") || undefined, hadr: S.homeAdr(t) || undefined,
      px: 100, prevDay: 99, vol: 1e8, oi: 5e7 });
    const homeState = { KR: { closed: true, closeT: 1, openT: 2, nextT: Date.now() + 3600000 },
      JP: { closed: false, nextT: Date.now() + 7200000 }, HK: { closed: true, nextT: Date.now() + 60000 } };
    const homeMkts = { KR: { ex: "KRX", off: 9, o: [9, 0], c: [15, 30], calThrough: 2026 },
      JP: { ex: "TSE", off: 9, o: [9, 0], c: [15, 30], lunch: [[11, 30], [12, 30]], calThrough: 2026 },
      HK: { ex: "HKEX", off: 8, o: [9, 30], c: [16, 0], lunch: [[12, 0], [13, 0]], calThrough: 2026 } };
    H.applySnapshot({ markets: ["SMSN", "SOFTBANK", "ZHIPU", "TSM", "NVDA"].map(wire), mainMarkets: [], dataTs: 7,
      homeMkts, homeState });
    // 1) the fields SURVIVE ingestion — the exact copy that was missing in -01
    assert.equal(H.state.rows.get("xyz:SMSN").hm, "KR", "hm must survive the explicit merge");
    assert.equal(H.state.rows.get("xyz:SOFTBANK").hm, "JP");
    assert.equal(H.state.rows.get("xyz:ZHIPU").hm, "HK");
    assert.equal(H.state.rows.get("xyz:TSM").hm, undefined, "ADRs stay US on the wire and after the merge");
    assert.equal(H.state.rows.get("xyz:TSM").hadr, "TW", "ADR annotation survives beside it");
    assert.equal(H.state.rows.get("xyz:NVDA").hm, undefined);
    // 2) the defs + live states landed
    assert.equal(H.state.homeMkts.KR.ex, "KRX"); assert.equal(H.state.homeState.KR.closed, true);
    // 3) the renderers actually read the merged rows — chips per market, not a wall of US
    assert.ok(/>KR</.test(H.sessCell(H.state.rows.get("xyz:SMSN"))), "SMSN chip renders KR");
    assert.ok(/sesschip on/.test(H.sessCell(H.state.rows.get("xyz:SOFTBANK"))), "open TSE lights the JP chip");
    assert.ok(/US\u00b7TW/.test(H.sessCell(H.state.rows.get("xyz:TSM"))), "TSM chip renders US\u00b7TW");
    assert.ok(/hrail/.test(H.railHtml(H.state.rows.get("xyz:SMSN"))) && /KRX opens/.test(H.cdsHtml(H.state.rows.get("xyz:SMSN"))),
      "rail + countdown render from the merged row");
    // 4) live gap mode keys off the ROW's market: SMSN reads KR's closed state even with US open
    H.state.offHours = { closed: false };
    assert.equal(H.rowSessState(H.state.rows.get("xyz:SMSN")).closed, true, "SMSN gap runs on Seoul's clock");
    assert.equal(H.rowSessState(H.state.rows.get("xyz:NVDA")).closed, false, "US names keep the US flag");
    // 5) lockstep self-heal: a payload without hm CLEARS a stale chip
    H.applySnapshot({ markets: [Object.assign(wire("SMSN"), { hm: undefined })], mainMarkets: [], dataTs: 8, homeMkts, homeState });
    assert.equal(H.state.rows.get("xyz:SMSN").hm, undefined, "hm rides the snapshot in lockstep — stale classes self-heal");
  } finally {
    global.setInterval = saved.si; global.setTimeout = saved.st; global.requestAnimationFrame = saved.raf;
    global.document = saved.doc; global.window = saved.win; global.localStorage = saved.ls; global.fetch = saved.f;
  }
});

test("notes: the digest rides every snapshot row, and its revision busts the content signature", () => {
  const fs = require("fs"), path = require("path");
  const src = fs.readFileSync(path.join(__dirname, "../src/poller.js"), "utf8");
  assert.ok(/nt: noteDigest\(r\.coin\)/.test(src), "mapMarket ships the per-coin digest");
  assert.ok(/\+ "#" \+ notesRev;/.test(src),
    "notesRev must ride the snapshot content signature, or a note written on a quiet board never surfaces its marker");
  const app = require("./_client").clientSource();
  // Assigned from the notes module's boot since the module split (it calls into admin.js, which
  // imports notes.js back — a const at module scope could observe an uninitialised binding).
  assert.ok(/NOTES_WRITE = IS_ADMIN && featureOn\('notes\.write'\)/.test(app),
    "the client gates the pen on both locks");
  // Age is calendar time. A vol-scaled fade was considered and rejected: it would move the marker
  // when the MARKET changed rather than when the note did.
  assert.ok(/Math\.floor\(\(Date\.now\(\)-ts\)\/DAY\)/.test(app), "note age is derived from calendar days only");
  const ageBlock = app.slice(app.indexOf("function noteAgeDays"), app.indexOf("function noteBadge"));
  assert.ok(!/vol30|\.vol\b|sigma/.test(ageBlock), "no volatility input may leak into the age classes");
});

test("audit -67 client: the SSE stream is recreated after a terminal close, foregrounding re-syncs, and typing no longer re-renders per keystroke", () => {
  const fs = require("fs"), path = require("path");
  const app = require("./_client").clientSource();
  const sse = app.slice(app.indexOf("function startEvents()"), app.indexOf("function startEvents()") + 1600);
  assert.ok(/if\(_sseSrc&&_sseSrc\.readyState===2\)\{ try\{ _sseSrc\.close\(\); \}catch\(_\)\{\} _sseSrc=null;/.test(sse), "a CLOSED source is dropped so startEvents can run again");
  assert.ok(/_sseRetryT=setTimeout\(startEvents,_sseBackoff\); _sseBackoff=Math\.min\(_sseBackoff\*2,60000\)/.test(sse), "and re-opened with backoff");
  assert.ok(/_sseSrc\.onopen=\(\)=>\{ _sseOk=true; _sseBackoff=2000;/.test(sse), "backoff resets on a good open");
  assert.ok(/document\.addEventListener\('visibilitychange',\(\)=>\{ if\(document\.hidden\) return;\s*\n\s*if\(!_sseSrc\) startEvents\(\);\s*\n\s*if\(typeof dmSync==='function'&&dmState&&dmState\.me\)/.test(app), "foregrounding reopens the stream and pulls messages once");
  assert.ok(/el\('filter'\)\.addEventListener\('input', e=>\{ state\.filter=e\.target\.value; scheduleRender\(\); savePrefs\(\); \}\);/.test(app), "the markets filter renders once per frame");
  assert.ok(/updateFilterChip\(\); scheduleRender\(\); savePrefs\(\);\n\}/.test(app) && /\['volMin','volMax','oiMin','oiMax'\]\.forEach\(id=>el\(id\)\.addEventListener\('input', applyNumFilters\)\);/.test(app), "so do the numeric filters");
  assert.ok(/nfT=setTimeout\(\(\)=>\{ renderNews\(\);[\s\S]{0,200}\},120\); \}; \}/.test(app), "the news filter debounces");
});

test("audit -67 client: stale responses cannot paint over newer state; one bad trigger event cannot replay the batch; starring keeps the drawer", () => {
  const fs = require("fs"), path = require("path");
  const app = require("./_client").clientSource();
  assert.ok(/const mySeq=\(FOCCH\.seq=\(FOCCH\.seq\|\|0\)\+1\);/.test(app) && /if\(mySeq!==FOCCH\.seq\) return;   \/\/ superseded while in flight/.test(app), "focus chart fetches are sequenced like the trend modal's");
  assert.ok(/if\(q!==dmState\.q\.trim\(\)\) return;   \/\/ the box moved on/.test(app), "a DM search answer for an older query is dropped");
  const lt = app.slice(app.indexOf("for(const ev of d.events){"), app.indexOf("for(const ev of d.events){") + 1600);
  assert.ok(/try\{\s*\n\s*const k=ev\.kind\|\|'setup';/.test(lt) && /\}catch\(_\)\{ \/\* this event is broken, the batch is not \*\/ \}/.test(lt), "each event is isolated so trigSeqSet always runs");
  assert.ok(/esc\(String\(ev\.side\|\|''\)\.toUpperCase\(\)\)/.test(app) && /esc\(String\(r\.side\|\|''\)\.toUpperCase\(\)\)/.test(app), "a missing side renders empty instead of throwing");
  assert.ok(/el\('dstar'\)\.onclick=\(\)=>\{ toggleWatch\(coin\);/.test(app) && !/toggleWatch\(coin\); openDetail\(coin\);/.test(app), "starring no longer rebuilds the drawer (and the note being typed in it)");
  assert.ok(/const release=\(\)=>\{ if\(sv\._d&&sv\._last\)\{ const e=sv\._last; sv\._d=0; sv\._last=null; at\(e\); \} sv\._d=0; \};/.test(app), "floor histogram drags commit once on release");
});

// ===== build 2026.09.11-68: UI/UX audit fixes =================================================
test("ux -68: one funding colour convention, alert kinds routed to channels, unread marked on close", () => {
  const fs = require("fs"), path = require("path");
  const app = require("./_client").clientSource();
  const html = fs.readFileSync(path.join(__dirname, "..", "public", "index.html"), "utf8");
  assert.ok(/c:f>0\?'neg':\(f<0\?'pos':'sec'\)/.test(app), "positive funding (longs pay) is red in the table, as on the heatmap and the sessions clock");
  assert.ok(/red = positive \(longs pay/.test(html), "the footer legend says so");
  assert.ok(/const ALERT_CHANNELS=\{[\s\S]*?rule:\{toast:true/.test(app) && /if\(ALERT_CHANNELS\[k\]&&ALERT_CHANNELS\[k\]\.toast\)\{ fireGeneric\(ev\); continue; \}/.test(app), "rule/trend/ma200 events toast");
  assert.ok(/function alertMatrixHtml\(\)/.test(app) && /alertMatrixHtml\(\)\+buildPushSection\(\)/.test(app), "and the matrix the code runs is the one the Delivery fold shows");
  assert.ok(/function closeAlertPop\(\)\{[^}]*alertMarkRead\(\);/.test(app) && !/if\(pop\.hidden\)\{ loadPush\(\); loadRules\(\); alertMarkRead\(\); \}/.test(app), "unread survives opening the panel");
});

test("ux -68: the phone gets its table back, controls reach the keyboard, quiet text clears AA", () => {
  const fs = require("fs"), path = require("path");
  const css = fs.readFileSync(path.join(__dirname, "..", "public", "styles.css"), "utf8");
  const app = require("./_client").clientSource();
  const html = fs.readFileSync(path.join(__dirname, "..", "public", "index.html"), "utf8");
  assert.ok(/viewport-fit=cover/.test(html) && /env\(safe-area-inset-bottom\)/.test(css), "safe areas for the installed PWA");
  assert.ok(/\.controls\{flex-wrap:nowrap;overflow-x:auto/.test(css) && /header\{height:auto;flex-wrap:wrap/.test(css), "the six-row control stack is one strip under 680px, and the one-row shell wraps to two");   // -93: the tagline (.sub) left the shell; the header wraps instead
  assert.ok(/--dim:#7A8592/.test(css) && !/color:var\(--faint\)/.test(css), "--faint is no longer used for text");
  assert.ok(/input:focus-visible,textarea:focus-visible,select:focus-visible,\[role="button"\]:focus-visible,tr\[data-coin\]:focus-visible\{outline:2px solid var\(--accent\)!important/.test(css), "one ring on every control");
  assert.ok(/<tr data-coin="\$\{esc\(r\.coin\)\}"\$\{cls\} tabindex="0"/.test(app) && /t\.matches\('tr\[data-coin\]'\)&&e\.key==='Enter'/.test(app), "rows are focusable and Enter opens them");
  assert.ok((app.match(/role="button" tabindex="0"/g) || []).length >= 20, "custom controls are buttons to the keyboard");
  assert.ok(/role="dialog" aria-modal="true" aria-label="Ticker detail"/.test(html) && /aria-live="polite"/.test(html), "drawer is a dialog; toasts are announced");
  assert.ok(/prefers-reduced-motion:reduce\)\{\*\{animation:none!important;transition-duration:\.01ms!important\}/.test(css) && /behavior:SCROLL_B/.test(app) && !/behavior:'smooth'/.test(app), "reduced motion covers transitions and smooth scrolls");
  assert.ok(/\.term-fab,#dm-dock\{bottom:calc\(12px \+ env\(safe-area-inset-bottom\)\)\}/.test(css) && /body\[data-view="dm"\] #dm-dock/.test(css), "the floating buttons respect the inset and the dock hides on Messages");
});

test("positions client: P&L derives off the live mark, signed with the side; the overlay is wired into cell, badge, drawer, filter and stream", () => {
  const fs = require("fs"), path = require("path");
  const src = require("./_client").clientSource();
  const grab = (name) => { const i = src.indexOf("function " + name + "("); assert.ok(i >= 0, name + " missing");
    let dep = 0; for (let k = src.indexOf("{", i); k < src.length; k++) { if (src[k] === "{") dep++; if (src[k] === "}") { dep--; if (!dep) return src.slice(i, k + 1); } } };
  const state = { pos: new Map(), rows: new Map() };
  const posCalc = new Function("state", grab("posCalc") + "; return posCalc;")(state);
  state.pos.set("xyz:NVDA", { coin: "xyz:NVDA", side: "long", sz: 2, entry: 100, ntl: 210, upnl: 10, margin: 100, liq: 60 });
  state.pos.set("BTC", { coin: "BTC", side: "short", sz: 0.5, entry: 60000, ntl: 30000, upnl: 0, margin: 6000, liq: 70000 });
  const L = posCalc({ coin: "xyz:NVDA", px: 110 });
  assert.equal(L.ntl, 220, "notional at the live mark, not the polled one");
  assert.equal(L.upnl, 20); assert.equal(L.roe, 20); assert.ok(Math.abs(L.vsEntry - 10) < 1e-9);
  assert.ok(Math.abs(L.liqDist - (60 / 110 - 1) * 100) < 1e-9, "a long's liquidation sits below the mark: negative distance");
  const S = posCalc({ coin: "BTC", px: 57000 });
  assert.equal(S.upnl, 1500, "a short whose price fell is winning"); assert.ok(S.vsEntry > 0, "signed with the side"); assert.ok(S.liqDist > 0);
  assert.equal(posCalc({ coin: "xyz:AAPL", px: 1 }), null, "nothing held: nothing drawn");
  const stale = posCalc({ coin: "xyz:NVDA", px: null });
  assert.equal(stale.ntl, 210); assert.equal(stale.upnl, 10, "no live mark yet: the polled figures stand in");
  // Wiring pins.
  assert.ok(src.includes("${earnBadge(r)}${noteBadge(r)}${posBadge(r)}${cdsHtml(r)}</td>"), "the badge sits in the ticker cell, after the note post-it");
  assert.equal((src.match(/if\(state\.posOnly\) rows=rows\.filter\(r=>state\.pos\.has\(r\.coin\)\);/g) || []).length, 2, "the ⬡ held filter applies in both table lenses");
  assert.ok(src.includes("{key:'pos', label:'Position', type:'num'"), "a sortable column");
  assert.ok(src.includes("colAdjacent(v,'pos','oi');") && src.includes("colAdjacent(ord,'pos','oi');"), "saved prefs and saved layouts both migrate the column in next to OI");
  assert.ok(src.includes("if(d&&d.pos) loadPositions();"), "the stream poke reloads");
  assert.ok(src.includes("renderDrawerPos(coin);") && src.includes('<div id="dpos"></div>'), "the drawer panel");
  assert.ok(src.includes("computeDerived(); evaluateAlerts(); posDecorate();"), "the sort key is refreshed off the live mark every render");
  const html = fs.readFileSync(path.join(__dirname, "..", "public", "index.html"), "utf8");
  for (const id of ["posAddr", "posLink", "posUnlink", "posOnly", "posStat"]) assert.ok(html.includes('id="' + id + '"'), id + " in the filter popover");
});

// ===== ordering, focus, overlays, DM window (2026.09.20) =========================================
function _clientRig(extra) {
  // The -05 harness pattern: the whole client evaluated against a stub DOM, so the functions under
  // test are the real ones with their real neighbours, not string pins.
  const app = require("./_client").clientSource();
  const { els, mk } = _sessDomStub();
  const saved = { si: global.setInterval, st: global.setTimeout, raf: global.requestAnimationFrame,
    doc: global.document, win: global.window, ls: global.localStorage, f: global.fetch, css: global.CSS };
  global.setInterval = () => 0; global.setTimeout = () => 0; global.requestAnimationFrame = () => 0;
  const mkEl = (tag) => { const e = mk(tag); e.querySelector = () => mk("child"); return e; };   // a built toast wires its own buttons
  global.document = { getElementById: (id) => (els[id] = els[id] || mk(id)), querySelectorAll: () => [], querySelector: () => null,
    createElement: mkEl, addEventListener() {}, body: mk("body"), documentElement: mk("html"), hidden: false, activeElement: null };
  global.window = { addEventListener() {}, location: { reload() {}, href: "/" }, matchMedia: () => ({ matches: false, addEventListener() {} }) };
  global.localStorage = { _d: {}, getItem(k) { return this._d[k] ?? null; }, setItem(k, v) { this._d[k] = String(v); }, removeItem(k) { delete this._d[k]; } };
  global.fetch = () => new Promise(() => {}); global.CSS = { escape: (s) => String(s) };
  let H = null;
  eval(app + "\n; H={state, applySnapshot, loadSnapshot" + (extra ? "," + extra : "") + "};");
  return { H, els, restore() { global.setInterval = saved.si; global.setTimeout = saved.st; global.requestAnimationFrame = saved.raf;
    global.document = saved.doc; global.window = saved.win; global.localStorage = saved.ls; global.fetch = saved.f; global.CSS = saved.css; } };
}

test("snapshot ordering: an older payload never moves the board backwards, a redeploy's restarted clock still lands, and only the newest in-flight pull is applied", async () => {
  const rig = _clientRig();
  try {
    const { H } = rig;
    const snap = (px, dataTs, v) => ({ markets: [{ coin: "xyz:AAPL", ticker: "AAPL", uni: "xyz", px, prevDay: 99, vol: 1e8, oi: 5e7 }], mainMarkets: [], dataTs, v });
    H.applySnapshot(snap(100, 10)); assert.equal(H.state.rows.get("xyz:AAPL").px, 100); assert.equal(H.state.dataTs, 10);
    H.applySnapshot(snap(90, 9));
    assert.equal(H.state.rows.get("xyz:AAPL").px, 100, "a payload older than the painted one is dropped");
    assert.equal(H.state.dataTs, 10, "and cannot move the content clock backwards");
    H.applySnapshot(snap(95, 11)); assert.equal(H.state.rows.get("xyz:AAPL").px, 95, "newer still applies");
    H.applySnapshot(snap(96, 12, "b1")); assert.equal(H.state.build, "b1");
    H.applySnapshot(snap(97, 3, "b2"));
    assert.equal(H.state.rows.get("xyz:AAPL").px, 97, "a redeploy restarts the counter: the new build's first snapshot lands whatever its dataTs");
    assert.equal(H.state.dataTs, 3);
    H.applySnapshot(snap(98, 2, "b2")); assert.equal(H.state.rows.get("xyz:AAPL").px, 97, "…and the gate is back on for the same build");
    // Two pulls in flight; the FIRST one answers LAST with a higher dataTs. The sequence guard drops
    // it: the newest pull is the one that reflects what the operator asked for.
    const pend = [];
    global.fetch = () => new Promise((res) => pend.push((body) => res({ ok: true, status: 200, json: () => Promise.resolve(body) })));
    const p1 = H.loadSnapshot(), p2 = H.loadSnapshot();
    assert.equal(pend.length, 2);
    pend[1](snap(50, 20, "b2")); await p2;
    assert.equal(H.state.rows.get("xyz:AAPL").px, 50);
    pend[0](snap(40, 21, "b2")); await p1;
    assert.equal(H.state.rows.get("xyz:AAPL").px, 50, "the superseded pull's answer is ignored even though its clock reads later");
    assert.equal(H.state.dataTs, 20);
  } finally { rig.restore(); }
});

test("overlay stack: one Escape closes only the top layer; every modal registers on open and leaves on close; a view change clears the stack", () => {
  const app = require("./_client").clientSource();
  const i0 = app.indexOf("const _overlays=[];"), i1 = app.indexOf("function overlayCloseAll(){");
  assert.ok(i0 > 0 && i1 > i0, "overlay stack lives in core.js");
  const src = app.slice(i0, app.indexOf("\n", i1));
  const O = new Function(src + "; return {overlayPush, overlayPop, overlayTop, overlayCloseTop, overlayCloseAll};")();
  const closed = [];
  O.overlayPush("drawer", () => closed.push("drawer")); O.overlayPush("help", () => closed.push("help"));
  assert.equal(O.overlayTop(), "help");
  assert.equal(O.overlayCloseTop(), true);
  assert.deepEqual(closed, ["help"], "only the top layer closes"); assert.equal(O.overlayTop(), "drawer");
  O.overlayPush("cmdk", () => closed.push("cmdk")); O.overlayPush("drawer", () => closed.push("drawer2"));
  assert.equal(O.overlayTop(), "drawer", "re-pushing an open id moves it to the top, never duplicates it");
  O.overlayPop("drawer"); assert.equal(O.overlayTop(), "cmdk");
  O.overlayCloseAll(); assert.equal(O.overlayTop(), null); assert.deepEqual(closed, ["help", "cmdk"]);
  assert.equal(O.overlayCloseTop(), false, "nothing to close is not an error");
  // ONE document Escape handler, in core's boot, consuming the event; the per-layer listeners are gone.
  assert.ok(app.includes("if(e.key!=='Escape'||e.defaultPrevented||!_overlays.length) return; e.preventDefault(); overlayCloseTop();"), "the single Escape handler");
  for (const gone of ["if(e.key==='Escape' && state.detail) closeDetail();", "const m=el('helpmodal'); if(m&&!m.hidden) closeHelp(); }",
    "const m=el('tchartmodal'); if(m&&!m.hidden) closeTrendChart();", "if(e.key==='Escape'&&!d.hidden) whlModalClose();",
    "if(e.key==='Escape'&&el('focmodal')&&!el('focmodal').hidden) focChartClose();", "if(e.key==='Escape'){ e.preventDefault(); closeCmdk(); return; }",
    "q.addEventListener('keydown',(e)=>{ if(e.key==='Escape'){ dmState.q=''; dmState.results=null; dmRender(); } });"])
    assert.ok(!app.includes(gone), "per-layer Escape listener must be gone: " + gone);
  for (const pin of ["overlayPush('drawer', closeDetail)", "overlayPop('drawer')", "overlayPush('help', closeHelp)", "overlayPop('help')",
    "overlayPush('cmdk', closeCmdk)", "overlayPop('cmdk')", "overlayPush('tchart', closeTrendChart)", "overlayPop('tchart')",
    "overlayPush('whl', whlModalClose)", "overlayPop('whl')", "overlayPush('focchart', focChartClose)", "overlayPop('focchart')",
    "overlayPush('dm-search',", "overlayPop('dm-search')"])
    assert.ok(app.includes(pin), "layer registration missing: " + pin);
  // Downstream document handlers yield a consumed Escape instead of acting on it as well.
  assert.ok(app.includes("if(e.key==='Escape'&&e.defaultPrevented) return;"), "the j/k handler yields");
  assert.ok(app.includes("if(e.defaultPrevented) return;   // the overlay stack already spent this Escape"), "dmKeys yields");
  assert.ok(app.includes("if(state.view!=='markets'||overlayTop()||mktGrp()!=='names') return;"), "j/k/Enter respect every open layer, not just the drawer");
  // A view change dismisses the drawer and anything over it — unless nothing changed.
  assert.ok(app.includes("const switching=v!==state.view;\n  state.view=v;\n  if(switching) overlayCloseAll();"), "showView closes the stack on a real switch");
  // Fields that consume Escape for themselves stop it before the stack sees it.
  assert.ok(app.includes("if(e.key==='Escape'){ e.stopPropagation(); termClose(); return; }"), "terminal");
});

test("keyboard focus survives the row patch and returns from the drawer", () => {
  const app = require("./_client").clientSource();
  const grab = (name) => { const i = app.indexOf("function " + name + "("); assert.ok(i >= 0, name + " missing");
    let dep = 0; for (let k = app.indexOf("{", i); k < app.length; k++) { if (app[k] === "{") dep++; if (app[k] === "}") { dep--; if (!dep) return app.slice(i, k + 1); } } };
  const focused = [];
  const oldTr = { dataset: { coin: "xyz:AAPL" }, isConnected: false, closest: (s) => s === "tr[data-coin]" ? oldTr : null };
  const oldPit = { dataset: { pit: "xyz:AAPL" }, isConnected: false, closest: (s) => s === "tr[data-coin]" ? oldTr : null };
  const newPit = { focus: () => focused.push("pit") };
  const newTr = { querySelector: (q) => /\.pit\[data-pit="xyz:AAPL"\]/.test(q) ? newPit : null, focus: () => focused.push("tr") };
  const body = { contains: () => true, querySelector: (q) => /tr\[data-coin="xyz:AAPL"\]/.test(q) ? newTr : null };
  const document = { activeElement: oldPit };
  const F = new Function("document", "CSS", grab("rowFocus") + "\n" + grab("rowRefocus") + "; return {rowFocus,rowRefocus};")(document, { escape: (s) => s });
  const had = F.rowFocus(body);
  assert.deepEqual({ coin: had.coin, inner: had.inner }, { coin: "xyz:AAPL", inner: '.pit[data-pit="xyz:AAPL"]' }, "remembers the row AND the control inside it");
  F.rowRefocus(body, had); assert.deepEqual(focused, ["pit"], "the replacement control gets focus back");
  document.activeElement = oldTr; F.rowRefocus(body, F.rowFocus(body)); assert.deepEqual(focused, ["pit", "tr"], "a focused row re-focuses the replacement row");
  oldTr.isConnected = true; F.rowRefocus(body, F.rowFocus(body)); assert.deepEqual(focused, ["pit", "tr"], "an untouched row keeps its focus — no write");
  document.activeElement = { closest: () => null }; assert.equal(F.rowFocus(body), null, "focus outside the table is nobody's business");
  assert.ok(app.includes("const had=rowFocus(body);") && app.includes("rowRefocus(body, had);\n  applyKsel();"), "wired around BOTH write paths, before the ring is re-pinned");
  // Drawer: the opener is recorded on EVERY open and focus goes back to it (or to the row that now carries the coin).
  assert.ok(app.includes("state._drawerFrom={el:ae, coin:tr?tr.dataset.coin:null}"), "opener recorded per open");
  assert.ok(!app.includes("if(!state._drawerFrom) state._drawerFrom=document.activeElement;"), "the record-once line is gone");
  assert.ok(app.includes("const f=state._drawerFrom; state._drawerFrom=null; if(!f) return;") && app.includes("let t=f.el&&f.el.isConnected?f.el:null;"), "closeDetail restores and clears");
});

test("DM log: windowed to the newest 100, cache capped at 500 (the open thread keeps what the pager walked to), in-place patches, one paint per frame", () => {
  const app = require("./_client").clientSource();
  const i0 = app.indexOf("const DM_WINDOW=100, DM_CACHE=500;"), i1 = app.indexOf("function dmMerge(list){");
  assert.ok(i0 > 0 && i1 > i0);
  let dep = 0, end = 0; for (let k = app.indexOf("{", i1); k < app.length; k++) { if (app[k] === "{") dep++; if (app[k] === "}") { dep--; if (!dep) { end = k + 1; break; } } }
  const dmState = { sel: 1, msgs: new Map(), info: new Map([[1, { more: false }], [2, { more: false }]]) };
  const M = new Function("dmState", "function dmMsgs(id){ let a=dmState.msgs.get(id); if(!a){ a=[]; dmState.msgs.set(id,a); } return a; }\n"
    + app.slice(i0, end) + "; return {dmMerge, setWin(n){ _dmWin=n; }, win(){ return _dmWin; }};")(dmState);
  const msgs = (thread, from, n) => Array.from({ length: n }, (_, i) => ({ id: from + i, thread, body: "m" + (from + i) }));
  let r = M.dmMerge(msgs(2, 1, 600));
  assert.equal(r.added, 600); assert.equal(dmState.msgs.get(2).length, 500, "a background thread keeps the newest 500");
  assert.equal(dmState.msgs.get(2)[0].id, 101, "…the NEWEST 500"); assert.equal(dmState.info.get(2).more, true, "and knows the rest is on the server");
  r = M.dmMerge(msgs(1, 1, 600)); assert.equal(dmState.msgs.get(1).length, 500, "the open thread at the default window: same cap");
  M.setWin(700); r = M.dmMerge(msgs(1, 1, 700));
  assert.equal(dmState.msgs.get(1).length, 700, "the pager walked to 700: nothing it fetched is trimmed");
  r = M.dmMerge([{ id: 650, thread: 1, body: "edited" }, { id: 5, thread: 2, body: "x" }]);
  assert.deepEqual({ added: r.added, updated: r.updated, freshIds: r.fresh.map((m) => m.id) }, { added: 1, updated: [650], freshIds: [5] }, "an edit reports the id (open thread only); a re-fetched older row on another thread counts as added — and is handed back so the painter can append it");
  assert.equal(dmState.msgs.get(1).find((m) => m.id === 650).body, "edited");
  // Wiring pins: the window, the local-first pager, the in-place patches, the throttle, the idle guard.
  for (const pin of ["const all=dmMsgs(t.id), arr=all.length>_dmWin?all.slice(-_dmWin):all;", "(((info&&info.more)||all.length>arr.length)&&arr.length)",
    "if(arr.length>_dmWin){ _dmWin=Math.min(arr.length,_dmWin+DM_WINDOW); dmRenderNow(); keepTop(); return; }", "_dmWin+=(d.messages||[]).length;",
    "dmState.mode='chat'; _dmWin=DM_WINDOW;", "function dmPatchTyping(id){", "dmPatchTyping(t.thread);", '<div id="dm-typing">',
    "function dmPatchMsg(id){", "function dmPatchReceipt(){", "else { for(const id of chg.updated) dmPatchMsg(id); dmPatchReceipt(); if(d.threads) dmPatchRail(); }",
    "function dmRenderNow(){", "if(_dmRaf){ _dmDirty=true; return; }", "_dmRaf=requestAnimationFrame(", "if(document.hidden||!dmSignedIn()||state.view!=='dm') return;"])
    assert.ok(app.includes(pin), "DM pin missing: " + pin);
  assert.ok(!app.includes("if(state.view==='dm'&&dmState.sel===t.thread) dmRender();"), "a typing frame no longer rebuilds the panel");
});

test("small fixes: escaped terminal sink, capped scrollback, total-order comparators, dead pollMs gone, idle ticks sleep, sw click posts a message", () => {
  const fs = require("fs"), path = require("path");
  const app = require("./_client").clientSource();
  const sw = fs.readFileSync(path.join(__dirname, "..", "public", "sw.js"), "utf8");
  assert.ok(app.includes('data-tcmd="${tesc(r.ticker)}"') && !app.includes('data-tcmd="${r.ticker}"'), "the screen row's attribute sink is escaped");
  assert.ok(app.includes("const TERM_MAX_BLOCKS=200;") && app.includes("while(s.children.length>TERM_MAX_BLOCKS) s.removeChild(s.firstChild);"), "terminal scrollback is capped");
  for (const gone of ["a.ticker<b.ticker?-1:1", "a.tk<b.tk?-1:1", "(a.tEt||'')>(b.tEt||'')?-1:1"]) assert.ok(!app.includes(gone), "non-total comparator must be gone: " + gone);
  for (const pin of ["String(a.ticker).localeCompare(String(b.ticker))", "String(a.tk).localeCompare(String(b.tk))", "String(b.d).localeCompare(String(a.d))||String(b.tEt||'').localeCompare(String(a.tEt||''))"])
    assert.ok(app.includes(pin), "comparator: " + pin);
  assert.ok(!app.includes("state.pollMs") && !app.includes("pollMs:30000"), "state.pollMs was written and never read — gone");
  assert.ok(app.includes("refreshMs2:state.refreshMs,") && app.includes("if(typeof p.refreshMs2==='number'&&p.refreshMs2>0) state.refreshMs=p.refreshMs2;"), "prefs persist and migrate into refreshMs alone");
  assert.ok(app.includes("setInterval(()=>{ if(document.hidden) return;   // a background tab"), "the 500ms countdown tick sleeps while hidden");
  assert.ok(app.includes("if(title===_freshLast) return; _freshLast=title;") && app.includes("if(c&&txt!==_cdText){ _cdText=txt; c.textContent=txt; }"), "freshness dot and countdown only write the DOM on change");
  assert.ok(sw.includes('t.postMessage({ go: "dm" })') && !sw.includes('t.navigate("/#dm")'), "an open client is asked to switch tabs, not navigated");
  assert.ok(sw.includes('self.clients.openWindow("/#dm")'), "no client open: a real navigation remains the fallback");
  assert.ok(sw.includes("(build 2026.09.16-80)"), "sw header build stamp updated");
  assert.ok(app.includes("navigator.serviceWorker.addEventListener('message',e=>{ const d=e&&e.data; if(d&&d.go==='dm') showView('dm'); });"), "the page answers the message");
});

test("share to chat (build 2026.09.21-84): the sheet can close — its author display: has a [hidden] companion", () => {
  const fs = require("fs"), path = require("path");
  const css = fs.readFileSync(path.join(__dirname, "..", "public", "styles.css"), "utf8");
  assert.ok(/\.share-sheet\[hidden\],\.share-bg\[hidden\]\{display:none\}/.test(css), "display:flex on .share-sheet beats the UA [hidden] rule; the companion restores it");
});

test("docs: every tab in the manifest has a section in the manual, and the manual names no tab that does not exist", () => {
  // The manual hides sections by feature key (data-feature) using the same injected set the shell
  // uses, so a key here that is not in FEATURES would be a section that never hides, and a tab in
  // FEATURES with no section would be a tab the manual quietly omits. Both directions are pinned.
  const fs = require("fs"), path = require("path");
  const html = fs.readFileSync(path.join(__dirname, "..", "public", "docs.html"), "utf8");
  const { FEATURES } = require("../src/compute");
  const tabs = FEATURES.filter((f) => f.kind === "tab");
  for (const f of tabs) {
    assert.ok(html.includes(`id="tab-${f.key}"`), `manual has no section anchored tab-${f.key} for the ${f.label} tab`);
    assert.ok(html.includes(`data-feature="${f.key}"`), `manual section for ${f.key} does not gate on its feature key`);
    if (f.def === "admin") assert.ok(new RegExp(`data-feature="${f.key}" data-def="admin"`).test(html), `${f.key} ships admin-only — its section must say so`);
  }
  const keys = new Set(FEATURES.map((f) => f.key));
  for (const m of html.matchAll(/data-feature="([a-z.]+)"/g)) assert.ok(keys.has(m[1]), `manual gates a section on unknown feature key ${m[1]}`);
  // The shell's boot slot is the docs page's boot slot — the server splits on the exact string.
  assert.ok(html.includes("<script>window.__FLAGS=null;window.__ADMIN=false;</script>"), "docs page carries the shell's flag slot verbatim");
  assert.ok(html.includes("{{build}}"), "docs page carries the build slot");
  // The ? help links every tab to its section, and the shell footer links the manual.
  const nav = fs.readFileSync(path.join(__dirname, "..", "public", "js", "nav.js"), "utf8");
  assert.ok(nav.includes('href="/docs#tab-${esc(v)}"'), "help modal links to the manual's section for the open tab");
  const shell = fs.readFileSync(path.join(__dirname, "..", "public", "index.html"), "utf8");
  assert.ok(shell.includes('href="/docs"'), "shell links the manual");
  // Sections the page hides by flag must be top-level, or the hide/search logic (main.doc > section) misses them.
  for (const m of html.matchAll(/<section id="([^"]+)"[^>]*data-feature/g)) {
    const at = m.index, before = html.slice(0, at);
    const open = (before.match(/<section\b/g) || []).length, close = (before.match(/<\/section>/g) || []).length;
    assert.equal(open, close, `section ${m[1]} is nested inside another section`);
  }
});

// ===== build 2026.09.21-87: the chat paints incrementally ==========================================
test("chat perf -87: arrivals append, a send merges its own reply, the tick paints only on change", () => {
  const fs = require("fs"), path = require("path");
  const app = fs.readFileSync(path.join(__dirname, "..", "public", "js", "messages.js"), "utf8");
  // dmMerge hands back the fresh rows so the painter can append exactly those.
  assert.ok(/return \{added, updated, fresh\};/.test(app), "dmMerge returns the fresh list");
  // dmSync: an arrival on the open thread appends; another thread's arrival redraws the rail only; the full render is the fallback.
  assert.ok(/if\(chg\.added\)\{ if\(!dmState\.sel\|\|dmState\.results\|\|dmState\.mode!=='chat'\|\|!dmAppend\(chg\.fresh\)\) dmRender\(\); else \{ dmPatchRail\(\); dmPatchReceipt\(\); \} \}/.test(app), "sync appends before it rebuilds, and receipts ride along");
  // Marking read must not undo the append it follows.
  const mr = app.slice(app.indexOf("async function dmMarkRead(id){"), app.indexOf("async function dmMarkRead(id){") + 700);
  assert.ok(/dmUpdatePip\(\); if\(state\.view==='dm'\) dmPatchRail\(\);/.test(mr) && !/dmRender\(\)/.test(mr), "mark-read patches the rail, never rebuilds");
  // Stamps: their drift is derived at read on the server, so the tick still re-pulls the page —
  // and patches only the stamped and card rows, in place.
  const rs = app.slice(app.indexOf("async function dmRefreshStamps(){"), app.indexOf("async function dmRefreshOpen(){"));
  assert.ok(/fetchJSON\('\/api\/dm\/'\+encodeURIComponent\(id\)\)/.test(rs) && /if\(m&&before\.get\(mid\)!==JSON\.stringify\(m\)\) dmPatchMsg\(mid\);/.test(rs), "the re-pull patches only the rows that changed, in place");
  // An edit hands back an older message and must not move the rail row.
  assert.ok(/if\(arr\.length&&m\.id<arr\[arr\.length-1\]\.id\) return;/.test(app.slice(app.indexOf("function dmTouchThread(m){"))), "an edit does not touch the rail");
  // The append path refuses anything that is not a plain append.
  const fn = app.slice(app.indexOf("function dmAppend(fresh){"), app.indexOf("function dmPatchRail(){"));
  for (const pin of ["if(mine.some(m=>m.pinned)) return false;", "if(mine[0].id<=lastId) return false;",
    "if(state.view!=='dm'||dmState.mode!=='chat'||dmState.results||dmState.searching) return false;",
    "anchor.insertAdjacentHTML('beforebegin',html)", "if(atBottom) dmScrollBottom();", "dmPinBottomOnImages();"])
    assert.ok(fn.includes(pin), "dmAppend pin missing: " + pin);
  // The rail is its own container so previews can move without touching the log.
  assert.ok(app.includes("+'<div id=\"dm-rail\">'+dmRailHtml()+'</div>'"), "the rail has a container");
  assert.ok(/function dmPatchRail\(\)\{ const r=el\('dm-rail'\); if\(r\) r\.innerHTML=dmRailHtml\(\); else dmRender\(\); \}/.test(app));
  // A send no longer reloads the thread list and refetches the history it already holds.
  const send = app.slice(app.indexOf("async function dmSend(){"), app.indexOf("async function dmUpload("));
  assert.ok(!/fetchJSON\('\/api\/dm\/'\+dmState\.sel\)/.test(send), "no history refetch after a send");
  assert.ok(/const created=!!\(res\.d\.thread&&!dmThread\(res\.d\.thread\)\);/.test(send) && /if\(created\) await dmLoad\(\); else dmTouchThread\(res\.d\.message\);/.test(send),
    "only a first message to a person (which creates the conversation) reloads the list");
  const cmd = app.slice(app.indexOf("async function dmRunCmd("), app.indexOf("async function dmUpload("));
  assert.equal((cmd.match(/await dmLoad\(\);/g) || []).length, 0, "a command result merges its reply and touches the rail, no reload");
  assert.ok(!/fetchJSON\('\/api\/dm\/'\+dmState\.sel\)/.test(cmd), "…and no history refetch either");
  // The 45s tick: presence + incremental sync, and a redraw only when the signature moved.
  const tick = app.slice(app.indexOf("setInterval(async ()=>{\n  if(document.hidden||!dmSignedIn()||state.view!=='dm') return;"), app.indexOf("},45000);"));
  assert.ok(/await dmSync\(\);\s*\n\s*await dmRefreshStamps\(\);\s*\n\s*if\(dmPresenceSig\(\)!==before\) dmRender\(\);/.test(tick), "the tick syncs, refreshes stamps in place, and paints only on change");
  // dmTouchThread keeps the rail honest between the send and the next sync.
  const touch = app.slice(app.indexOf("function dmTouchThread(m){"), app.indexOf("async function dmLoad(){"));
  assert.ok(/t\.lastAt=m\.ts\|\|Date\.now\(\);/.test(touch) && /dmState\.threads\.sort\(\(a,b\)=>\(b\.lastAt\|\|0\)-\(a\.lastAt\|\|0\)\);/.test(touch));
});

test("chat perf -87: dmAppend executes — appends new bubbles before the receipt, keeps the reader's place, and refuses a non-append", () => {
  const fs = require("fs"), path = require("path");
  const app = fs.readFileSync(path.join(__dirname, "..", "public", "js", "messages.js"), "utf8");
  // A minimal live log: the pieces dmAppend touches, no more.
  const mkLog = (mids, atBottom) => {
    const nodes = mids.map((id) => ({ cls: "dm-msg", dataset: { mid: String(id) } }));
    const seen = { cls: "dm-seen", inserted: [] };
    const log = { scrollTop: atBottom ? 1000 : 0, clientHeight: 500, scrollHeight: 1500, scrolled: 0, appended: [],
      querySelectorAll: (q) => (q === ".dm-msg[data-mid]" ? nodes : []),
      querySelector: (q) => (q === ".dm-seen" ? Object.assign(seen, { insertAdjacentHTML: (w, h) => seen.inserted.push([w, h]) }) : null),
      insertAdjacentHTML: (w, h) => log.appended.push([w, h]) };
    return { log, seen };
  };
  const src = app.slice(app.indexOf("function dmAppend(fresh){"), app.indexOf("function dmPatchRail(){"));
  const run = (fresh, arr, mids, atBottom) => {
    const { log, seen } = mkLog(mids, atBottom);
    const calls = { scrolled: 0, receipt: 0, pinned: 0, html: [] };
    const ctx = {
      state: { view: "dm" }, dmState: { sel: 7, mode: "chat", results: null, searching: false },
      dmThread: (id) => ({ id, kind: "dm" }), el: (id) => (id === "dm-log" ? log : null),
      dmMsgs: () => arr, dmSameDay: (a, b) => Math.floor(a / 86400000) === Math.floor(b / 86400000),
      dmDayLabel: () => "today", esc: (x) => String(x),
      dmMessageHtml: (m, t, p) => { calls.html.push([m.id, p ? p.id : null]); return "<div data-mid=\"" + m.id + "\"></div>"; },
      dmPatchReceipt: () => { calls.receipt++; }, dmReceiptHtml: () => "<div class=\"dm-seen\">sent</div>",
      dmScrollBottom: () => { calls.scrolled++; }, dmPinBottomOnImages: () => { calls.pinned++; },
    };
    const f = new Function(...Object.keys(ctx), src + "\nreturn dmAppend;")(...Object.values(ctx));
    return { ok: f(fresh), calls, seen, log };
  };
  const D = 86400000;
  const arr = [{ id: 1, thread: 7, ts: 10 * D }, { id: 2, thread: 7, ts: 10 * D + 5 }, { id: 3, thread: 7, ts: 11 * D + 1 }];
  // Two arrivals after what is drawn: both appended before the receipt, in order, with a day line
  // where the day changes, the receipt rewritten, the reader at the bottom carried down.
  let r = run([arr[2], arr[1]], arr, [1], true);
  assert.equal(r.ok, true);
  assert.deepEqual(r.calls.html, [[2, 1], [3, 2]], "each new bubble sees its real predecessor for grouping");
  assert.equal(r.seen.inserted.length, 1); assert.equal(r.seen.inserted[0][0], "beforebegin");
  assert.ok(/dm-day/.test(r.seen.inserted[0][1]) && r.seen.inserted[0][1].indexOf("dm-day") > r.seen.inserted[0][1].indexOf("data-mid=\"2\""), "the day divider is drawn between the two days only");
  assert.equal(r.calls.receipt, 1); assert.equal(r.calls.scrolled, 1); assert.equal(r.calls.pinned, 1);
  // A reader scrolled up keeps their place.
  r = run([arr[2]], arr, [1, 2], false);
  assert.equal(r.ok, true); assert.equal(r.calls.scrolled, 0, "no yank to the bottom while reading back");
  // Not an append: something older than the last drawn bubble, or a pinned arrival, or another view.
  assert.equal(run([arr[1]], arr, [1, 3], true).ok, false, "an id behind the last drawn one is a full render");
  assert.equal(run([Object.assign({}, arr[2], { pinned: true })], arr, [1, 2], true).ok, false, "a pinned arrival changes the strip: full render");
  // Nothing for the open thread: true, so the caller patches the rail alone.
  assert.equal(run([{ id: 9, thread: 8, ts: 12 * D }], arr, [1, 2, 3], true).ok, true);
});

test("calls -88: the stamp shows the lifecycle, the author can close or extend, the board scores closed calls", () => {
  const fs = require("fs"), path = require("path");
  const app = fs.readFileSync(path.join(__dirname, "..", "public", "js", "messages.js"), "utf8");
  const stamp = app.slice(app.indexOf("function dmStamp(m){"), app.indexOf("function dmDayShort(ts){"));
  assert.ok(/const cl=m\.call\|\|null;/.test(stamp) && /closes '\+dmDayShort\(cl\.closeTs\)\+' \('\+cl\.h\+'d\)/.test(stamp), "an open call says when it closes");
  assert.ok(/<i class="dm-tk-cl">closed<\/i>/.test(stamp) && /\+\(finalTxt\|\|right\)\+/.test(stamp), "a closed call shows its final in place of the live move");
  assert.ok(/data-dmcallclose="'\+m\.id\+'"/.test(app) && /data-dmcallext="'\+m\.id\+'" data-days="'\+\(m\.call\.h\+7\)\+'"/.test(app), "close and +7d ride the hover bar");
  assert.ok(/\(\(own&&m\.call&&!m\.call\.closed\)\?/.test(app), "…for the author's own OPEN calls only");
  assert.ok(/dmCallOp\(\{callClose:\+cc0\.dataset\.dmcallclose\}\)/.test(app) && /dmCallOp\(\{callExtend:\+ce\.dataset\.dmcallext,days:\+ce\.dataset\.days\}\)/.test(app), "the dispatcher posts the two verbs");
  const board = app.slice(app.indexOf("function dmCallsHtml(){"), app.indexOf("async function dmFetchCalls(){"));
  assert.ok(/x\.n\+' closed'\+\(x\.open\?' \\u00b7 '\+x\.open\+' open':''\)/.test(board), "the summary counts closed and open separately");
  assert.ok(/<span class="dm-callst/.test(board) && /now \/ close/.test(board), "the board has a status column and names the close price");
  const css = fs.readFileSync(path.join(__dirname, "..", "public", "styles.css"), "utf8");
  assert.ok(/\.dm-callrow\{[^}]*grid-template-columns:64px 1fr auto 74px 68px 68px 58px 52px 52px/.test(css), "the grid gained the status column");
});

// ===== build 2026.09.24-95: call targets on the client ==============================================
test("targets -95: the stamp grows a target row — progress, time used, stop tick, pill — and the board and composer read targets", () => {
  const fs = require("fs"), path = require("path");
  const app = fs.readFileSync(path.join(__dirname, "..", "public", "js", "messages.js"), "utf8");
  // The row, run for real against four wire shapes: open & ahead, hit, wrong, missed.
  const src = app.slice(app.indexOf("const DM_TG_ZERO="), app.indexOf("function dmDayShort(ts){"));
  const row = new Function("fmtPx", "esc", "dmDayShort", src + "\nreturn dmTargetRow;")((v) => String(v), (s) => String(s), () => "Oct 15");
  const DAY = 86400e3, now = Date.now(), ts = now - 6 * DAY;
  const base = { refPx: 100, side: "long", ts, px: 106 };
  const open = row(Object.assign({}, base, { call: { closed: false, tg: { px: 110, stop: 95, by: ts + 20 * DAY, res: null, at: null } } }));
  assert.ok(/dm-tg-pill open/.test(open) && /60% there/.test(open) && /14d left/.test(open), open);
  assert.ok(/<span class="pos">ahead<\/span> of its clock/.test(open), "60% of the move in 30% of the time is ahead of its clock");
  assert.ok(/needs \+3\.8% more/.test(open), "and says what is left to go");
  assert.ok(/class="dm-tg-fill pos" style="left:25\.0%;width:45\.0%"/.test(open), "the bar runs from the zero line 60% of the way to the target");
  assert.ok(/class="dm-tg-stop" style="left:12\.5%"/.test(open), "the stop sits left of zero, halfway down the wrong-way side");
  assert.ok(/class="dm-tg-clock" style="left:47\.5%"/.test(open), "the triangle marks 30% of the clock");
  const hit = row(Object.assign({}, base, { call: { closed: true, closePx: 110, tg: { px: 110, stop: null, by: ts + 20 * DAY, res: "hit", at: ts + 9 * DAY } } }));
  assert.ok(/dm-tg-pill hit/.test(hit) && /hit ✓ · 11d early/.test(hit) && /closed at the target/.test(hit), hit);
  const wrong = row(Object.assign({}, base, { side: "short", call: { closed: true, closePx: 104, tg: { px: 90, stop: 104, by: ts + 20 * DAY, res: "wrong", at: ts + DAY } } }));
  assert.ok(/wrong ✗ · stop 104/.test(wrong) && /class="dm-tg-fill neg"/.test(wrong) && /closed at the stop/.test(wrong), wrong);
  const miss = row(Object.assign({}, base, { call: { closed: true, closePx: 107, tg: { px: 110, stop: null, by: ts + 5 * DAY, res: "miss", at: ts + 5 * DAY } } }));
  assert.ok(/missed · 70% there/.test(miss) && /closed at the deadline’s close/.test(miss), miss);
  assert.equal(row(Object.assign({}, base, { call: { closed: false, tg: null } })), "", "a plain call grows nothing");
  // Wired: the stamp appends the row; the composer previews the target; the board has the column and the binary record.
  assert.ok(app.includes("+(finalTxt||right)+'</div>'+dmTargetRow(m);"), "the stamp appends the target row");
  assert.ok(app.includes("const tg=dmCallTarget(text,m[1],r.px,undefined,ov&&ov.side?ov.side:null);"), "the preview runs the server's reader against the mark it shows");
  assert.ok(/no target: '\+esc\(tg\.error\)\+' \\u2014 sends as a plain call/.test(app), "a refused target says so, and says the send stays a plain call");
  const board = app.slice(app.indexOf("function dmCallsHtml(){"), app.indexOf("async function dmFetchCalls(){"));
  assert.ok(board.includes("'<span class=\"dm-calltg\">'+dmCallTgCell(c)+'</span></div>'") && board.includes(">target</span></div>'"), "the board gained a target column");
  assert.ok(/x\.tg&&\(x\.tg\.hit\+x\.tg\.miss\+x\.tg\.wrong\)\?'<span class="dm-calltgrec"/.test(board) && /median hit /.test(board), "the summary carries the binary record beside the % one");
  const css = fs.readFileSync(path.join(__dirname, "..", "public", "styles.css"), "utf8");
  assert.ok(/\.dm-callrow\{[^}]*grid-template-columns:64px 1fr auto 74px 68px 68px 58px 52px 52px 118px;/.test(css), "the grid gained the target column");
  for (const pin of [".dm-tg{", ".dm-tg-bar{", ".dm-tg-fill.pos", ".dm-tg-stop{", ".dm-tg-clock{", ".dm-tg-pill.hit", ".dm-tg-pill.wrong", ".dm-calltg{", ".dm-calltgrec{", ",.dm-calltg{display:none}"])
    assert.ok(css.includes(pin), "css pin missing: " + pin);
  // The desk digest names a target's level and progress, and the binary record.
  const pl = fs.readFileSync(path.join(__dirname, "..", "src", "poller.js"), "utf8");
  assert.ok(pl.includes("+ dgTg(x) + (x.deleted ?") && pl.includes("+ dgTgRes(x)).join(") && pl.includes('" \\u00b7 targets " + e.tg.hit + "/" + e.tg.miss + "/" + e.tg.wrong'), "the digest carries targets");
});

// ===== build 2026.09.24-96: the D1 retest study panel ================================================
test("retest panel -96: renders the server's cells as served — floor, control, excess, events — and is wired into the Backtest tab", () => {
  const fs = require("fs"), path = require("path");
  const app = require("./_client").clientSource();
  const a = app.indexOf("const RT_KEY="), b = app.indexOf("function attachRetestControls(");
  assert.ok(a > 0 && b > a, "retest panel block not found in the client source");
  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const isoUtc = (ts, x, y) => new Date(+ts).toISOString().slice(x, y);
  const state = { scope: "stocks", view: "backtest" };
  const api = new Function("store", "state", "esc", "isoUtc", "sHead", "sCap", "fetchJSON", "drawBacktest",
    app.slice(a, b) + "; return { RT, rtMemo, rtKey, renderRetestSection, rtRow };")(
    { get: () => null, set() {} }, state, esc, isoUtc, (t, d) => `<h>${t} — ${d}</h>`, (t) => `<cap>${t}</cap>`, async () => ({}), () => {});
  assert.deepEqual([api.RT.side, api.RT.def, api.RT.cd], ["long", "board", 5], "defaults: long, the board's definition, a 5-bar cooldown");
  assert.ok(api.renderRetestSection().includes("Study not served yet"), "no payload: an honest empty state");
  const cell = (n, over) => Object.assign({ n, hit: 0.61, mean: 1.234, med: 0.9, meanSd: 0.42, void: 0.18,
    ctl: { n: 900, hit: 0.55, mean: 0.8, meanSd: 0.3 }, exHit: 0.06, exMean: 0.434, exSd: 0.12 }, over || {});
  const T = Date.UTC(2026, 8, 21);
  api.rtMemo.set(api.rtKey(), { at: Date.now(), pending: false, data: {
    scope: "stocks", key: "k", count: 40, names: 31, bars: 12345, dataTs: T, eventsTotal: 2,
    params: { def: "board", cd: 5, defs: ["board", "touch"], cooldowns: [0, 3, 5, 10, 20], horizons: [1, 3, 5, 10, 20], cellFloor: 30 },
    side: { long: { n: 64, suppressed: 11, tl: 16, cells: { 1: cell(64), 3: cell(64), 5: cell(64), 10: cell(20, { hit: null, mean: null, med: null, meanSd: null, void: null, exHit: null, exMean: null, exSd: null }), 20: cell(64, { exSd: -0.05 }) } },
      short: { n: 0, suppressed: 0, tl: 0, cells: {} } },
    byName: [{ coin: "xyz:NVDA", ticker: "NVDA", long: 5, short: 0, lastT: T, lastSide: "long" }],
    events: [{ coin: "xyz:NVDA", ticker: "NVDA", t: T, side: "long", c: 181.2, e13: 179.9, e21: 176.4, tl: true, sd: 2.1, f: [0.5, 1.1, null, null, null], v: [false, false, null, null, null] },
      { coin: "xyz:<b>", ticker: "<b>", t: T - 86400e3, side: "long", c: 10, e13: 9.9, e21: 9.5, tl: false, sd: 3, f: [1, 1, 2.5, 3, 4], v: [false, true, true, true, true] }] } });
  const html = api.renderRetestSection();
  assert.ok(html.includes("<b>64</b> long events across <b>31</b> of 40 names"), "status line counts from the payload");
  assert.ok(html.includes("11 suppressed by the 5d cooldown") && html.includes("25% on true extremes"), "suppression and true-low share disclosed");
  assert.ok(html.includes("through the 2026-09-21 UTC close"), "the data edge is a UTC day");
  assert.ok(html.includes('<td class="pos">+6pp</td><td class="pos">+0.43%</td><td class="pos">+0.12σ</td>'), "excess columns render as served");
  assert.ok(html.includes('<td class="neg">-0.05σ</td>'), "a negative excess reads red");
  assert.ok(/<td>\+10d<\/td><td>20<\/td><td class="dim2" colspan="5"[^>]*>under floor<\/td>/.test(html), "a sub-floor cell publishes its n and nothing else");
  assert.ok(html.includes('<span class="sec">open</span>'), "an unresolved horizon says open, not zero");
  assert.ok(html.includes("&lt;b&gt;") && !html.includes("<td><b></td>"), "tickers are escaped");
  assert.ok(html.includes('data-rtd="touch"') && html.includes('data-rtc="20"') && html.includes('data-rts="short"') && html.includes('id="rtCsv"'), "controls from the payload's own option lists");
  assert.ok(html.includes("CSV carries the newest") === false, "no cap note when every event shipped");
  api.RT.side = "short";
  assert.ok(api.renderRetestSection().includes("No short events under this definition and cooldown."), "the empty side says so");
  api.RT.side = "long";
  // wiring
  assert.ok(require("./_client").CLIENT_MODULES.includes("retest"), "the suite's module list carries retest");
  assert.ok(fs.readFileSync(path.join(__dirname, "..", "public", "app.js"), "utf8").includes('import "./js/retest.js";'), "the entry loads the module");
  assert.ok(app.includes("+renderDuelSection()+renderRetestSection();"), "the panel sits under the score duel");
  assert.ok(app.includes("attachBtControls(); attachRetestControls(); attachLineHover(); loadDuelData(); loadRetestStudy(); }"), "drawBacktest wires and loads it");
  assert.ok(app.includes("fetchJSON(`/api/retest-study?u=${state.scope==='crypto'?'crypto':'stocks'}&def="), "the scope rides the query");
  assert.ok(app.includes("'fwd_'+h+'d_pct'") && app.includes("downloadCSV(`d1-retest-${state.scope}-${RT.def}-cd${RT.cd}.csv`, out)"), "CSV: one column per horizon, named by the choices");
  assert.ok(/backtest:`[\s\S]*?<div class="hlp-h">D1 retest study<\/div>/.test(app), "the ? explainer covers the panel");
  const docs = fs.readFileSync(path.join(__dirname, "..", "public", "docs.html"), "utf8");
  assert.ok(docs.includes("<li><b>D1 retest study</b>"), "the manual's Backtest section covers it");
  const feat = fs.readFileSync(path.join(__dirname, "..", "docs", "xyz-monitor-features.html"), "utf8");
  assert.ok(!feat.includes('"designed, not yet built"') && feat.includes('{nm:"D1 retest study",sc:"adm",fd:"built'), "the features page marks it built");
});
