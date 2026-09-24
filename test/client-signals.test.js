"use strict";
// public/js — signals, levels, trend, backtest, charts. Split out of test.js (build 2026.09.16-80); order within the file is the original order.
const test = require("node:test");
const assert = require("node:assert");
const { median, HOUR, DAY, C, levelStudy, detectWickFill, detectRoundFront, roundStep, candlePool, pivotPool, anatomyTickerSummary, ACT_TIP_COLS, _p2Harness, actionMathFns, _btHarness } = require("./_shared");


test("pre-epoch crypto purge: claims stamped under the OLD geometry leave the ledger, post-epoch claims survive", async () => {
  // The -101 purge, bounded to the era it was actually about. Every crypto claim opened before
  // the geometry fix was stamped by additive range arithmetic that produced negative targets and
  // voids multiples of price away — seeding a supposedly out-of-sample record with those would be
  // exactly the stale-record dishonesty the ledger exists to prevent. So the pre-epoch era is
  // dropped while the rebuilt engine's own claims are kept: that boundary IS the property under
  // test, and it is a stronger one than "delete everything crypto". airead is exempt either way.
  const { createPoller } = require("../src/poller");
  const now = Date.now();
  const OLD = Date.UTC(2026, 6, 20);   // comfortably before CRYPTO_EPOCH (2026-07-26)
  const fixture = { ts: now, rearm: ["ETH|gapfade#1", "xyz:NVDA|reclaim#0"], variants: null,
    present: [["ETH|bigmove", now - 3600e3], ["xyz:AAPL|breakdown", now - 3600e3]],
    open: [
      { key: "ETH|gapfade#1", coin: "ETH", ticker: "ETH", ev: "gapfade", t0: OLD, mark0: 100, dir: 1,
        score0: 0, psd: "short", pn: 1, stp: 101, vi: 1, resolveAt: now + 86400e3 },
      { key: "BTC|fundext#0", coin: "BTC", ticker: "BTC", ev: "fundext", t0: OLD, mark0: 50, dir: 1,
        score0: 0, sd0: 2, psd: "short", pn: 1, stp: 51.5, vi: 0, resolveAt: now + 86400e3 },
      // post-epoch crypto claim: opened by the REBUILT engine, so it must survive the purge
      { key: "SOL|breakout", coin: "SOL", ticker: "SOL", ev: "breakout", t0: now - 3600e3, mark0: 200, dir: 1,
        score0: 12, sd0: 6, psd: "long", pn: 1, stp: 188, mv: 16, resolveAt: now + 2 * 86400e3 },
      { key: "ETH|airead#0", coin: "ETH", ticker: "ETH", ev: "airead", t0: now - 3600e3, mark0: 100, dir: 1,
        score0: 0, sd0: 2, psd: "long", pn: 1, stp: 95, vi: 0, resolveAt: now + 4 * 86400e3 },
      { key: "xyz:NVDA|reclaim#0", coin: "xyz:NVDA", ticker: "NVDA", ev: "reclaim", t0: now - 3600e3, mark0: 10, dir: 1,
        score0: 0, sd0: 2, psd: "long", pn: 1, stp: 9.5, vi: 0, resolveAt: now + 86400e3 },
    ],
    closed: [
      { key: "ETH|gapfade#0", coin: "ETH", ticker: "ETH", ev: "gapfade", t0: OLD, tR: OLD + 86400e3,
        mark0: 100, dir: 1, psd: "short", pn: 1, vi: 0, status: "resolved", realized: 0.8, realizedS: 0.8 },
      { key: "SOL|gapfade#0", coin: "SOL", ticker: "SOL", ev: "gapfade", t0: OLD, tR: OLD + 86400e3,
        mark0: 20, dir: -1, psd: "long", pn: 1, vi: 0, status: "resolved", realized: -0.4, realizedS: -0.6, stopped: true },
      { key: "xyz:AAPL|reclaim#0", coin: "xyz:AAPL", ticker: "AAPL", ev: "reclaim", t0: now - 6 * 86400e3, tR: now - 86400e3,
        mark0: 10, dir: 1, sd0: 2, psd: "long", pn: 1, vi: 0, status: "resolved", realized: 1.2, realizedS: 1.2, rn: 1 },
      { key: "xyz:AAPL|breakdown", coin: "xyz:AAPL", ticker: "AAPL", ev: "breakdown", t0: now - 6 * 86400e3, tR: now - 86400e3,
        mark0: 200, dir: -1, sd0: 2, psd: "short", pn: 1, status: "resolved", realized: 1.1, realizedS: 1.1, rn: 1 },
      { key: "ETH|bigmove", coin: "ETH", ticker: "ETH", ev: "bigmove", t0: OLD, tR: OLD + 86400e3,
        mark0: 3000, dir: 1, sd0: 3, psd: "long", pn: 1, status: "resolved", realized: -0.5, realizedS: -0.5, rn: 1 },
      { key: "ETH|airead#0", coin: "ETH", ticker: "ETH", ev: "airead", t0: now - 9 * 86400e3, tR: now - 4 * 86400e3,
        mark0: 90, dir: 1, sd0: 2, psd: "long", pn: 1, vi: 0, status: "resolved", realized: 1.4, realizedS: 1.4, rn: 1 },
    ] };
  let saved = null;
  const store = { loadAll: () => new Map(), loadRegime: () => [], loadLedger: () => fixture,
    saveLedger: (d) => { saved = d; }, insert: () => {}, saveRegime: () => {} };
  const p = createPoller({ dex: "xyz", store, log: () => {}, version: "test", crypto: false });
  p.hydrateLedgerNow();
  await p.buildSignalsNow();
  const d = p.getSignals(true);
  // the purge itself: every non-airead crypto entry is gone, open and closed alike
  const x = p.getLedgerExport(true);
  const EPOCH = Date.UTC(2026, 6, 26);
  const preCrypto = (e) => !e.coin.includes(":") && e.ev !== "airead" && !(+e.t0 >= EPOCH);
  assert.ok(!x.open.some(preCrypto), "no PRE-EPOCH crypto claim survives among open entries");
  assert.ok(!x.closed.some(preCrypto), "no PRE-EPOCH crypto claim survives among closed entries");
  assert.ok(x.open.some((e) => e.coin === "SOL" && e.ev === "breakout"),
    "the post-epoch crypto claim SURVIVES — the purge is bounded to the broken-geometry era, not permanent");
  assert.equal(p.getLedgerFor("ETH", null, true).closed.length, 0, "the claim browser has nothing on the purged crypto name");
  const ai = p.aireadClaimsNow();
  assert.ok(ai.open.some((e) => e.coin === "ETH") && ai.closed.some((e) => e.coin === "ETH"), "airead claims on crypto names survive the purge — open AND closed");
  assert.ok(saved && saved.open.length === 3 && saved.closed.length === 3,
    `the purged ledger persists back: 3 open kept of 5 (2 xyz/airead + the post-epoch crypto claim), 3 closed kept of 6 — got ${saved && saved.open.length}/${saved && saved.closed.length}`);
  assert.ok(!saved.rearm.includes("ETH|gapfade#1") && !saved.present.some((p0) => p0[0] === "ETH|bigmove"),
    "no crypto episode/presence key survives to persistence (load filter; the build's own lapse GC clears the rest)");
  // shadow panel: the crypto key exists again, and is null when the poller runs without crypto
  assert.ok(d.shadows && Array.isArray(d.shadows.xyz), "the xyz panel ships");
  assert.equal(d.shadows.main, null, "crypto:false poller ships main:null — an explicit 'not served', not a silent omission");
  const xp = Object.fromEntries(d.shadows.xyz.map((g) => [g.ev, g]));
  assert.ok(xp.pead && xp.sweep, "xyz-only strategies stay on the xyz panel");
  assert.ok(xp.gapfade, "gapfade is an xyz strategy (a 24/7 tape has no gap to fade)");
  assert.deepEqual({ n: xp.gapfade.rows[0].n, open: xp.gapfade.rows[0].open }, { n: 0, open: 0 },
    "the purged crypto gapfade record cannot leak into the xyz panel");
  assert.equal(xp.reclaim.rows[0].n, 1); assert.equal(xp.reclaim.rows[0].avg, 1.2);
  assert.equal(xp.reclaim.rows[0].open, 1, "xyz shadow aggregation intact");
  // record sets: xyz claims intact, crypto claims absent from EVERY set including the global
  assert.ok(d.records["0x"].record.breakdown && d.records["0x"].record.breakdown.resolved === 1, "xyz set carries the xyz visible claim");
  assert.equal(d.records["0"].record.breakdown.resolved, 1, "global set keeps its keys and totals");
  assert.ok(!d.records["0"].record.bigmove, "the PURGED crypto claim is absent from the global set — broken-geometry history feeds no aggregate");
  assert.ok(!d.records["0m"] || !d.records["0m"].record.bigmove, "and the m-suffixed set is empty of it");
  // independence disclosure rides every record entry
  assert.ok(Number.isInteger(d.records["0x"].record.breakdown.cl) && d.records["0x"].record.breakdown.cl >= 1,
    "every record entry carries cl: the distinct tape-day count behind n");
  // client wiring pins: xyz-only selection, tab whitelist without signals, drawer skip
  const fs = require("fs"), path = require("path");
  const app = require("./_client").clientSource();
  for (const pin of ["function sigRecKey(thr,pr){",
    "const shPanel=d&&d.shadows&&(state.scope==='crypto'?d.shadows.main:d.shadows.xyz);",
    // Signals and Actionable are in scope for crypto again; markets stays PINNED public so the
    // tabVisible fallback can never itself be gated.
    "const CRYPTO_VIEWS=new Set(['markets','trend','charts','report','drawdown','corr','backtest','sessions','funding','signals','actionable','dm','notes'])",   // charts joined 2026.08.21-01, funding 2026.08.26-34, drawdown 2026.09.23-92 — all work in either universe
    "if(!tabVisible(v)){",
    "strategy shadows (earning their record)"])
    assert.ok(app.includes(pin), `client scope pin missing: ${pin}`);
  // BOTH record-set selection sites must go through the scoped key — a hardcoded 'x' would show
  // the equity record under a crypto board, which is the one failure mode that looks plausible.
  assert.equal((app.match(/d\.records\[sigRecKey\(/g) || []).length, 2,
    "both record-set selection sites read the SCOPED key, not a hardcoded universe");
  assert.ok(!/\+'x'\]\|\|d\.records\[/.test(app), "no hardcoded xyz record-set selection survives");
  assert.ok(!app.includes("rw.uni==='main'){ box.innerHTML=''; return; } }"),
    "the drawer's crypto record skip is gone — crypto names have a ledger again");
  const pol = fs.readFileSync(path.join(__dirname, "..", "src", "poller.js"), "utf8");
  assert.ok(pol.includes('return { xyz: panel("xyz"), main: crypto ? panel("main") : null };'), "shadowRecord ships both panels");
  assert.ok(pol.includes("uni: r.uni, ev, label: EV_LABEL[ev]"), "signals stay universe-stamped (structural honesty, even with one universe)");
  assert.ok(pol.includes("shadow record changes must bust the ETag"), "shadow counts still fold into the signals ETag signature");
  assert.ok(pol.includes("Pre-epoch crypto purge") && pol.includes('e.ev !== "airead"'), "the epoch-bounded purge and its airead exemption live in hydrate");
});

test("view wiring invariant: every tab has a section, a visibility toggle, AND a dispatch — no orphans in any direction", () => {
  // Regression guard for -84's News tab: the section existed, the dispatch existed, the
  // renderer existed — and the tab still showed nothing, because showView unhides sections
  // through a hardcoded setHidden list the new view was never added to. String pins verified
  // the parts EXISTED; nothing verified they were WIRED. This test closes the class: the tab
  // buttons in the markup, the view sections, the setHidden visibility list, and the showView
  // dispatch lines must all describe the same set of views, or the suite fails.
  const fs = require("fs"), path = require("path");
  const html = fs.readFileSync(path.join(__dirname, "..", "public", "index.html"), "utf8");
  const app = require("./_client").clientSource();
  const tabs = new Set([...html.matchAll(/data-view="([a-z]+)"/g)].map((m) => m[1]));
  const sections = new Set([...html.matchAll(/id="view-([a-z]+)"/g)].map((m) => m[1]));
  const toggles = new Set([...app.matchAll(/setHidden\('view-([a-z]+)'/g)].map((m) => m[1]));
  assert.ok(tabs.size >= 10, `suspiciously few tabs parsed: ${tabs.size}`);
  for (const v of tabs) {
    assert.ok(sections.has(v), `tab "${v}" has no view section in index.html`);
    assert.ok(toggles.has(v), `tab "${v}" is missing from showView's setHidden visibility list — it would render invisible (the -84 News bug)`);
    assert.ok(app.includes(`v==='${v}'`) || v === "markets",
      `tab "${v}" has no dispatch in showView — nothing would ever render it`);
  }
  for (const v of sections)
    assert.ok(tabs.has(v), `section "view-${v}" has no tab button — dead markup`);
  for (const v of toggles)
    assert.ok(sections.has(v), `setHidden references "view-${v}" which does not exist in the markup`);
});

test("empty record still RENDERS: awaits, shadows, variants — executed, not string-pinned", () => {
  // The -87-deploy lesson kept alive after the -101 removal: an honestly-empty record must
  // still render the awaiting roster, the shadows panel and the variants. This executes the
  // REAL sigRecordHtml from the shipped client against an empty record — rendering behavior,
  // not source pins (the -85 lesson: existence is not wiring). The scope branch is BACK with the
  // crypto engine, so the roster is asserted per scope and the sandbox supplies the same scoped
  // record-set helper the shipped renderer calls.
  const fs = require("fs"), path = require("path");
  const src = require("./_client").clientSource();
  const grab = (name) => { const i = src.indexOf("function " + name); assert.ok(i >= 0, name + " missing");
    let dep = 0, j = src.indexOf("{", i);
    for (let k = j; k < src.length; k++) { if (src[k] === "{") dep++; if (src[k] === "}") { dep--; if (!dep) return src.slice(i, k + 1); } } };
  const esc = (s) => String(s == null ? "" : s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
  const state = { scope: "stocks" };
  const sigMovePref = () => 0, sigPrimePref = () => false, sigRecFullPref = () => true, fmtAge = () => "1m";
  const EV_LABELS = {}, EV_TIP = {};
  const ledgerRosterScoped = eval("(" + grab("ledgerRosterScoped") + ")");
  const MAIN_ONLY_EV = new Set(["casc", "fundext"]);
  const sigRecKey = eval("(" + grab("sigRecKey") + ")");
  // -16: subsections render behind collapsed headers; open them all so the body paths execute.
  // The REAL sigSec is grabbed (signature-anchored — plain grab("sigSec") would hit sigSecOpen).
  const grabSig = () => { const i = src.indexOf("function sigSec(id,cls,label,tip,body)"); assert.ok(i >= 0, "sigSec missing");
    let dep = 0, j = src.indexOf("{", i);
    for (let k = j; k < src.length; k++) { if (src[k] === "{") dep++; if (src[k] === "}") { dep--; if (!dep) return src.slice(i, k + 1); } } };
  const sigSecOpen = () => new Set(["evtable", "slices", "curve", "tuning", "shadows", "resolutions"]);
  const sigSec = eval("(" + grabSig() + ")");
  const sigRecordHtml = eval("(" + grab("sigRecordHtml") + ")");
  // empty 'x' record, shadows shipping normally (server always ships all strategies)
  const d = { records: { "0x": { record: {}, recent: [] }, "0": { record: {} } },
    shadows: { xyz: [{ ev: "reclaim", label: "breakdown reclaim", unit: "R", tip: "t", rows: [{ tag: null, n: 0, open: 0 }] }] },
    variants: [], count: 0 };
  const html = sigRecordHtml(d);
  assert.ok(html.includes("No claims resolved yet"), "the honest notice renders");
  assert.ok(html.includes("awaiting first claim"), "the awaiting roster renders BELOW the notice — no early return");
  for (const ev of ["bigmove", "breakout", "breakdown", "fundflip", "oiflush", "fpdiv", "squeeze", "unwind", "prem", "gap", "ondrift", "tretest"])
    assert.ok(html.includes(ev), `roster event ${ev} awaits — the full xyz roster, session events included`);
  assert.ok(html.includes("strategy shadows (earning their record)"), "shadows panel renders on an empty record");
  assert.ok(html.includes("breakdown reclaim"), "with its strategies");
  assert.ok(!html.includes("sigrec-top"), "headline stats stay hidden until something has actually fired");
  assert.equal(ledgerRosterScoped().length, 13, "stocks roster: thirteen events");
  assert.equal(sigRecKey(0, false), "0x", "stocks scope reads the x-suffixed record set");

  // ---- and the same render in CRYPTO scope --------------------------------------------------
  // The failure this guards against is not a blank tab, it is a PLAUSIBLE one: a crypto board
  // silently rendering the equity record, or offering "awaiting first claim" for events crypto
  // never runs. Both would look completely normal on screen.
  state.scope = "crypto";
  assert.equal(sigRecKey(0, false), "0m", "crypto scope reads the m-suffixed record set, never the equity one");
  const roster = ledgerRosterScoped();
  for (const ev of ["casc", "fundext", "bigmove", "breakout", "tretest"])
    assert.ok(roster.includes(ev), `crypto roster must carry ${ev}`);
  for (const ev of ["gap", "prem", "ondrift", "squeeze", "unwind"])
    assert.ok(!roster.includes(ev), `crypto roster must NOT carry ${ev} — "awaiting" would be a lie for an event this universe never runs`);
  const dC = { records: { "0m": { record: {}, recent: [] }, "0": { record: {} } },
    shadows: { xyz: [], main: [{ ev: "reclaim", label: "breakdown reclaim", unit: "R", tip: "t", rows: [{ tag: null, n: 0, open: 0 }] }] },
    variants: [], count: 0 };
  const htmlC = sigRecordHtml(dC);
  assert.ok(htmlC.includes("awaiting first claim"), "the crypto roster renders its awaits too");
  assert.ok(htmlC.includes("casc") && htmlC.includes("fundext"), "crypto-native events appear in the crypto roster");
  assert.ok(!htmlC.includes("Premium dislocation") && !htmlC.includes("Overnight drift"),
    "xyz-only events never appear under a crypto board");
  assert.ok(htmlC.includes("breakdown reclaim"), "the crypto shadow panel renders, not the xyz one");
  state.scope = "stocks";

  // ---- the client roster and the server whitelist must agree -------------------------------
  // Two hand-kept lists that mean the same thing WILL drift; this joins them. A client roster
  // offering an event the server refuses to ledger renders a permanent "awaiting first claim"
  // that can never resolve — the exact shape of bug that survives review because it looks fine.
  const pol = fs.readFileSync(path.join(__dirname, "..", "src", "poller.js"), "utf8");
  const mainSet = pol.slice(pol.indexOf("const MAIN_EVS = new Set(["), pol.indexOf("]);", pol.indexOf("const MAIN_EVS = new Set([")));
  for (const ev of roster)
    assert.ok(mainSet.includes('"' + ev + '"'), `client crypto roster lists ${ev} but the server's MAIN_EVS does not admit it`);
});

test("regime strip: pure aggregate rides /api/analytics sections, split crypto/stocks, rendered with the shared hoverChart", () => {
  const fs = require("fs"), path = require("path");
  const pol = fs.readFileSync(path.join(__dirname, "..", "src", "poller.js"), "utf8");
  const app = require("./_client").clientSource();
  assert.ok(pol.includes("function buildRegime") && pol.includes("regimeAggregate("), "buildRegime + pure aggregate call missing from poller");
  assert.ok(pol.includes("regime,"), "regime must be a key on the analytics sections payload");
  assert.ok(/function buildRegime[\s\S]*mainMarkets\(\)/.test(pol) && /function buildRegime[\s\S]*activeMarkets\(\)/.test(pol), "regime must combine crypto (mainMarkets) + stocks (activeMarkets), not filter one roster");
  assert.ok(require("../src/compute").regimeAggregate, "regimeAggregate must be exported from compute");
  assert.ok(app.includes("function renderRegime") && app.includes("function regimeCurveSvg") && app.includes("function wireRegimeControls"), "regime client renderers missing");
  assert.ok(app.includes("a.sections && a.sections.regime"), "analytics render must read sections.regime");
  assert.ok(app.includes("regimeCurveSvg(d.series") && app.includes("hoverChart("), "regime charts must use the shared hoverChart infrastructure");
  // crowding breadth reuses the board's own funding percentile — one code path, not a second threshold
  assert.ok(pol.includes("r.fundPct >= 90") && pol.includes("r.fundPct <= 10"), "crowding breadth must reuse r.fundPct thresholds");
});

test("charts -02: chEmaWalk arithmetic — SMA seed, honest warm-up nulls, textbook EMA recursion", () => {
  // The walk lives client-side; extract the REAL function and execute it (string pins prove
  // presence, only execution proves the arithmetic — the -84 lesson).
  const fs = require("fs"), path = require("path");
  const app = require("./_client").clientSource();
  const m = app.match(/function chEmaWalk\(series,n\)\{[\s\S]*?\n\}/);
  assert.ok(m, "chEmaWalk not found in app.js");
  const chEmaWalk = new Function("return " + m[0])();
  const mk = (closes) => closes.map((c, i) => [i, c, c, c, c, 1]);
  // shorter than the period: NO line at all — never a partial guess
  assert.deepEqual(chEmaWalk(mk([1, 2, 3]), 5), [null, null, null], "series shorter than n yields all nulls");
  assert.deepEqual(chEmaWalk(mk([1, 2, 3]), 1), [null, null, null], "n<2 refused");
  // warm-up head is null, seed at index n-1 is the SMA of the first n closes
  const closes = [10, 11, 12, 13, 14, 20, 8, 15];
  const out = chEmaWalk(mk(closes), 5);
  assert.deepEqual(out.slice(0, 4), [null, null, null, null], "warm-up bars stay empty");
  assert.equal(out[4], (10 + 11 + 12 + 13 + 14) / 5, "seed = SMA(n) at index n-1");
  // recursion: e_i = c_i*k + e_{i-1}*(1-k), k = 2/(n+1) — walked by hand
  const k = 2 / 6;
  let e = out[4];
  for (let i = 5; i < closes.length; i++) {
    e = closes[i] * k + e * (1 - k);
    assert.ok(Math.abs(out[i] - e) < 1e-12, "EMA recursion at index " + i);
  }
  // n === length is legal: exactly one value, the SMA itself
  const exact = chEmaWalk(mk([2, 4, 6]), 3);
  assert.deepEqual(exact, [null, null, 4], "n === series length: the seed alone");
});

test("backtest v2 manifest: seventeen-signal roster, scope seam, data gates, sector demean — pinned in the shipped client", () => {
  // Source-manifest guard, same philosophy as the client-integrity test: each of these silently
  // reverting would leave a plausible-looking tab quietly running the old four-signal, xyz-only test.
  const fs = require("fs"), path = require("path");
  const s = require("./_client").clientSource();
  // the roster: every key present with a short label
  for (const k of ["mom:'", "smom:'", "rev:'", "res:'", "lowvol:'", "ivol:'", "beta:'", "max:'", "carry:'", "hprox:'", "volt:'", "oid:'",
    "m0:'", "mres:'", "moi:'", "mfund:'", "mpart:'"])
    assert.ok(s.includes(k), `BT_SIGNALS missing key: ${k}`);
  // data-gated rules declare their column and btRun refuses honestly instead of ranking nothing
  assert.ok(s.includes("const BT_NEEDS={ carry:'fundCov', hprox:'hiCov', volt:'voCov', oid:'oiCov', moi:'oiCov', mfund:'fundCov', mpart:'voCov' }"), "BT_NEEDS gate map missing");
  // the live-score variant family (-05): fixed-horizon dispatch BEFORE the lookback guard, extended warmup
  assert.ok(s.includes("const BT_MVAR={ m0:1, mres:1, moi:1, mfund:1, mpart:1 }"), "BT_MVAR family map missing");
  assert.ok(s.includes("if(BT_MVAR[sig]) return btMomVariant(sig, a, bench, di, ex);"), "variant dispatch missing from btScore");
  assert.ok(s.includes("const warmN=BT_MVAR[p.signal]?Math.max(p.lookback,31):p.lookback;"), "variant warmup missing from btRun");
  assert.ok(s.includes("start=warmN"), "btRun walk must start at the warmup, not the raw lookback");
  assert.ok(s.includes("nodata:BT_SIGNALS[p.signal]"), "no-data refusal missing from btRun");
  assert.ok(s.includes("res.nodata"), "no-data message missing from renderBacktest");
  // score plumbing: extras object into btScore, one regression serving res/beta/ivol, sector demean for smom
  assert.ok(s.includes("btScore(base, series.get(c), benchSeries, di, L, exOf(c))"), "extras not passed into btScore");
  assert.ok(s.includes("sig==='res'||sig==='beta'||sig==='ivol'"), "shared-regression branch missing");
  assert.ok(s.includes("if(p.signal==='smom')"), "sector demean missing");
  // scope seam: universe follows the switcher, bench is scoped, crypto kills the overnight hold and annualizes at 365
  assert.ok(s.includes("if((r.uni==='main')!==cr) return false;"), "scope-aware universe filter missing");
  assert.ok(s.includes("const bC=scopeBench(), bench=bC?state.rows.get(bC):null;"), "scoped benchmark missing from btMatrix");
  assert.ok(s.includes("p.holdWindow==='on' && state.scope!=='crypto'"), "crypto must not run the overnight hold");
  assert.ok(s.includes("function btAnn()") && s.includes("state.scope==='crypto'?365:BT_ANN"), "scope-aware annualization missing");
  assert.ok(s.includes("if(state.view==='backtest') drawBacktest();"), "scope flip must re-run the open tab");
  // the tab is un-gated for crypto in BOTH gates (visibility + navigation)
  assert.equal((s.match(/const CRYPTO_VIEWS=new Set\(/g) || []).length, 1, "exactly one crypto scope list may exist (it replaced showView's inline gate in -05)");
  assert.ok(new RegExp("const CRYPTO_VIEWS=new Set\\(\\[[^\\]]*'backtest'").test(s), "backtest must be in-scope for crypto");
  assert.ok(/applyTabVisibility\(\);   \/\/ scope AND flags/.test(s), "applyScope must delegate tab visibility to the single applier (its own per-tab list was removed in -05)");
  // level columns: aligned arrays + coverage counts, longer lookbacks, named benchmark in the legend
  assert.ok(s.includes("pxm, him, vom, oim, hiCov, voCov, oiCov"), "level-column matrix outputs missing");
  assert.ok(s.includes("[60,'60d'],[120,'120d']"), "60/120d lookbacks missing");
  assert.ok(s.includes("benchmark (BTC)") && s.includes("benchmark (SP500)"), "legend must name the scope's benchmark");
  // the new payload readers exist and applyDaily maps the extra tuple columns + oi
  assert.ok(s.includes("h:p[2], v:p[3]"), "applyDaily must read the h/v tuple columns");
  assert.ok(s.includes("r.dailyOI=d.oi[coin]"), "applyDaily must read the oi map");
});

test("live-score variant family (2026.07.24-05): btMomVariant executed — M0 mirrors the blend, each variant moves exactly one term", () => {
  // The REAL btMomVariant from the shipped client (the -85 lesson: existence is not wiring),
  // run on deterministic synthetic series where every candidate term's direction is known by
  // construction. Each variant is asserted AGAINST M0 on the same inputs, so a regression in
  // any single modulation fails its own assertion by name.
  const fs = require("fs"), path = require("path");
  const src = require("./_client").clientSource();
  const grab = (name) => { const i = src.indexOf("function " + name); assert.ok(i >= 0, name + " missing");
    let dep = 0, j = src.indexOf("{", i);
    for (let k = j; k < src.length; k++) { if (src[k] === "{") dep++; if (src[k] === "}") { dep--; if (!dep) return src.slice(i, k + 1); } } };
  const clamp = (x, a, b) => Math.min(Math.max(x, a), b);   // the client helper the function closes over
  const mv = eval("(" + grab("btMomVariant") + ")");
  const N = 140, di = 121;                                   // odd di: the last daily bar is the up-leg of the sawtooth
  // steady uptrend with a sawtooth (mean +0.2%/day, ±0.4% wiggle) — volD is real, tanh unsaturated
  const up = [], down = [], chop = [];
  for (let i = 0; i < N; i++) { const w = i % 2 ? 0.004 : -0.004;
    up.push(0.002 + w); down.push(-0.002 + w); chop.push(i % 2 ? 0.006 : -0.006); }
  const pxOf = (a) => { const p = []; let c = 100; for (const x of a) { c *= Math.exp(x); p.push(c); } return p; };
  const exBase = (a) => ({ f: null, px: pxOf(a), hi: null, vo: null, oi: null });
  // warmup: before 31 days of runway the score is an honest NaN, not a guess
  assert.ok(Number.isNaN(mv("m0", up, null, 20, exBase(up))), "pre-warmup must be NaN");
  const m0up = mv("m0", up, null, di, exBase(up)), m0dn = mv("m0", down, null, di, exBase(down)), m0ch = mv("m0", chop, null, di, exBase(chop));
  assert.ok(Number.isFinite(m0up) && m0up > 0 && m0up < 100, "M0 on a clean uptrend is positive and unsaturated");
  assert.ok(m0dn < 0, "M0 on the mirrored downtrend is negative");
  assert.ok(m0up > m0ch + 5, "coherent trend must outrank a violent chop of the same amplitude");
  // range tilt: same returns without the close series lose the (positive, at-the-highs) tilt
  assert.ok(m0up > mv("m0", up, null, di, { f: null, px: null, hi: null, vo: null, oi: null }), "range tilt must lift a name at its 30d highs");
  // V1 — β-residual: a perfect benchmark clone keeps only its raw 1d term; with no benchmark, V1 IS M0
  assert.ok(mv("mres", up, up, di, exBase(up)) < m0up - 1, "a β-clone's slow horizons must residualize away");
  assert.equal(mv("mres", up, null, di, exBase(up)), m0up, "no benchmark -> raw fallback -> exactly M0");
  // V2 — regime-qualified OI: building WITH the side (funding corroborating) amplifies; falling OI dampens; no OI column -> exactly M0
  const oiUp = [], oiDn = []; for (let i = 0; i < N; i++) { oiUp.push(1e6 * Math.pow(1.02, i)); oiDn.push(1e6 * Math.pow(0.98, i)); }
  const fPos = new Array(N).fill(2e-4), fNeg = new Array(N).fill(-2e-4);
  assert.ok(mv("moi", up, null, di, Object.assign(exBase(up), { oi: oiUp, f: fPos })) > m0up + 1, "longs+ with corroborating funding must amplify");
  assert.ok(mv("moi", up, null, di, Object.assign(exBase(up), { oi: oiDn, f: fPos })) < m0up - 1, "a squeeze (OI falling into strength) must dampen, not amplify");
  assert.ok(mv("moi", down, null, di, Object.assign(exBase(down), { oi: oiUp, f: fNeg })) < m0dn - 1, "shorts+ with shorts paying must amplify the negative side");
  assert.equal(mv("moi", up, null, di, exBase(up)), m0up, "no OI column -> unmodulated core -> exactly M0 (universe parity with the control)");
  // V3 — crowding haircut: today's funding at its own 31d max, crowd long into a long score -> ×0.8; flat funding has no extremes
  const fSpike = new Array(N).fill(1e-4); for (let i = di - 4; i <= di; i++) fSpike[i] = (4 + (i - (di - 4))) * 2e-4;   // ramps into a window max AT di
  assert.ok(mv("mfund", up, null, di, Object.assign(exBase(up), { f: fSpike })) < m0up - 1, "same-side funding extreme must take the 0.8 haircut");
  assert.equal(mv("mfund", up, null, di, Object.assign(exBase(up), { f: new Array(N).fill(1e-4) })), m0up, "flat funding is not an extreme — no haircut");
  assert.equal(mv("mfund", up, null, di, exBase(up)), m0up, "no funding column -> exactly M0");
  // V4 — volume participation: recent volume above the window norm nudges up, below nudges down, capped either way
  const voHi = new Array(N).fill(1e6), voLo = new Array(N).fill(1e6);
  for (let i = di - 4; i <= di; i++) { voHi[i] = 3e6; voLo[i] = 3e5; }
  const partHi = mv("mpart", up, null, di, Object.assign(exBase(up), { vo: voHi })), partLo = mv("mpart", up, null, di, Object.assign(exBase(up), { vo: voLo }));
  assert.ok(partHi > m0up && partLo < m0up, "participation must nudge in the volume's direction");
  assert.ok(Math.abs(partHi - m0up) < Math.abs(m0up) * 0.35, "the participation nudge stays a nudge — capped, never a regime of its own");
  assert.equal(mv("mpart", up, null, di, exBase(up)), m0up, "no volume column -> exactly M0");
});

test("levels -09: manifest — detector, context block, snap rule and prompt contract are all pinned", () => {
  const fs = require("fs"), path = require("path");
  const pol = fs.readFileSync(path.join(__dirname, "..", "src", "poller.js"), "utf8");
  const cmp = fs.readFileSync(path.join(__dirname, "..", "src", "compute.js"), "utf8");
  for (const pin of ["function detectLevels(", "detectLevels,"])
    assert.ok(cmp.includes(pin), `compute.js missing -09 pin: ${pin}`);
  for (const pin of [
    "const AI_LEVEL_K = 3, AI_LEVEL_TAU = 0.4, AI_LEVEL_MINN = 2, AI_LEVEL_MAX = 8;",
    "const AI_SNAP_TOL = 0.5;", "const AI_SCHEMA_V = 10;",
    "ctx.levels = lv || { n: 0, items: [], note:",
    "does not sit on any detected structural level", "(snapped to structure)",
    // the prompt must POINT at the field — the old wording asked for swing data the context never shipped
    "context.levels.items — copy the value verbatim", "context.levels carries the structural levels",
    // the report payload must carry the evidence, or the chart would have to re-derive it and
    // could then disagree with the validator that accepted the read
    "structLevels: (ctx.levels && Array.isArray(ctx.levels.items))"])
    assert.ok(pol.includes(pin), `poller.js missing -09 pin: ${pin}`);
  const app = require("./_client").clientSource();
  for (const pin of ["c.structLevels", "detected structural level(s) drawn faint",
    "flip \\u2014 has served as both resistance and support"])
    assert.ok(app.includes(pin), `app.js missing -09 pin: ${pin}`);
  assert.ok(!app.includes("if(offView.length)    if(offView.length)"), "the duplicated offView guard must stay fixed");
  assert.ok(!pol.includes("prior swings implied by the data"),
    "the unfulfillable prompt clause must be gone — it asked for swing data no context ever carried");
  assert.equal((cmp.match(/function detectLevels\(/g) || []).length, 1, "exactly one detectLevels definition");
});

test("levels study -10: client manifest — panel renderers, deck entry, hover contract", () => {
  const fs = require("fs"), path = require("path");
  const app = require("./_client").clientSource();
  for (const fn of ["renderLevels", "lvlTouchSvg", "lvlHoldRow", "lvlPct"])
    assert.equal((app.match(new RegExp("^function " + fn + "\\(", "gm")) || []).length, 1, `exactly one ${fn} definition`);
  for (const pin of [
    "a.sections && a.sections.levels",
    "'Structural level validation'",
    "lvBlock = renderLevels(lv);",
    "{html:lvBlock},{pend:lvPend}",                           // the panel is actually in the assembled DOM (-15 grouped layout)
    "All ${nStudies} studies live",                     // -17: count is universe-aware (crypto = ten, seasonality n/a)
    'table class="ptbl"',                                     // reuses the styled panel-table class, no orphan CSS
    "under the ${st.cellFloor}-event floor, no rate published",   // floored cells are hoverable and explained
  ]) assert.ok(app.includes(pin), `app.js missing -10 client pin: ${pin}`);
  // hover contract: every data rect in the touch chart and every table row carries a readout
  const seg = app.slice(app.indexOf("function lvlTouchSvg"), app.indexOf("function renderLevels"));
  assert.ok((seg.match(/<title>/g) || []).length >= 3, "chart bars must carry <title> readouts");
  assert.ok(app.includes('<tr title="${tip}"'), "table rows must carry the full hover readout");
});

test("anatomy -11: client manifest — renderers, deck entry, hover contract, honest-n language", () => {
  const fs = require("fs"), path = require("path");
  const app = require("./_client").clientSource();
  for (const fn of ["renderAnatomy", "anMfeSvg", "anPct"])
    assert.equal((app.match(new RegExp("^function " + fn + "\\(", "gm")) || []).length, 1, `exactly one ${fn} definition`);
  for (const pin of [
    "a.sections && a.sections.anatomy",
    "'Session anatomy'",
    "anBlock = renderAnatomy(an);",
    "{html:anBlock},{pend:anPend}",                           // the panel is actually in the assembled DOM (-15 grouped layout)
    "All ${nStudies} studies live",                                // -13 bumped the count (candles + pivots)
    "readable only after the fact",                           // the openQ conditioning caveat ships in the UI
    "frozen before the session — no lookahead",               // and so does the sd-freeze claim
  ]) assert.ok(app.includes(pin), `app.js missing -11 client pin: ${pin}`);
  const seg = app.slice(app.indexOf("function anMfeSvg"), app.indexOf("function renderAnatomy"));
  assert.ok((seg.match(/<title>/g) || []).length >= 3, "histogram bars and median markers carry <title> readouts");
});

test("shadow pair -12: manifest — EV_META, poller wiring, geometry gate, shadow-only, xyz-only", () => {
  const fs = require("fs"), path = require("path");
  const cmp = fs.readFileSync(path.join(__dirname, "..", "src", "compute.js"), "utf8");
  const pol = fs.readFileSync(path.join(__dirname, "..", "src", "poller.js"), "utf8");
  for (const f of ["detectWickFill", "detectRoundFront", "roundStep"])
    assert.equal((cmp.match(new RegExp("function " + f + "\\(", "g")) || []).length, 1, `exactly one ${f}`);
  assert.ok(/wickfill: \{ horizonMs: 3 \* DAY/.test(cmp) && /roundfr: {2}\{ horizonMs: 2 \* DAY/.test(cmp),
    "EV_META entries pinned with their horizons");
  for (const pin of [
    "const WICK_FRAC = 0.55;", "const WICK_SIZE_MULT = 1.1;",
    "const RNDF_LO_BAND = 0.05, RNDF_HI_BAND = 0.6;",
    'openLedger(r, "wickfill"', 'openLedger(r, "roundfr"',
    "detectWickFill(db24.slice(0, -1), r.px,",                 // closed spine buckets only — never dailyRaw, never the forming day
    "detectRoundFront(closes, r.px, sd30,",
  ]) assert.ok(pol.includes(pin), `poller.js missing -12 pin: ${pin}`);
  // both claims gated by stopGeometryOk and opened as vi=0 shadows inside the isolated try
  assert.ok(/wf && stopGeometryOk\(wf\.side, r\.px, wf\.stop\)/.test(pol), "wickfill geometry-gated");
  assert.ok(/rf && stopGeometryOk\(rf\.side, r\.px, rf\.stop\)/.test(pol), "roundfr geometry-gated");
  for (const ev of ["wickfill", "roundfr"]) {
    const m = pol.match(new RegExp('openLedger\\(r, "' + ev + '"[\\s\\S]{0,260}?\\}, 0\\);'));
    assert.ok(m, `${ev} must open as a vi=0 shadow`);
  }
  const seg = pol.slice(pol.indexOf("outsized-wick fill + round-figure front-run"), pol.indexOf('openLedger(r, "roundfr"'));
  assert.ok(seg.includes('if (r.uni === "xyz")'), "the pair is xyz-gated at the call site (belt to openLedger's crypto suspenders)");
  // shadows stay invisible: no client labels, ever, until a promotion build adds them deliberately
  const app = require("./_client").clientSource();
  assert.ok(!app.includes("wickfill") && !app.includes("roundfr"), "no client surface for unpromoted shadows");
});

test("-13 wiring manifest: byTicker on both studies, candles + pivots served, sig extended, client scoped", () => {
  const fs = require("fs"), path = require("path");
  const pol = fs.readFileSync(path.join(__dirname, "..", "src", "poller.js"), "utf8");
  for (const pin of [
    "pool.byTicker = {};", "st.byTicker = {};",
    "pool.candles = candlePool(perTicker, { minCross: ANAT_MIN_CROSS });",
    "pool.pivots = pivotPool(perTicker, { minCross: ANAT_MIN_CROSS });",
    "summary: anatomyTickerSummary(rec, monday, naked, candles, { minN: ANAT_MIN_SESS })",
    "const one = levelStudy(r._lvEv, { horizon: LVL_HORIZON, cellFloor: LVL_CELL_FLOOR });",   // per-name verdicts through the SAME aggregator
    "anSt.candles ? anSt.candles.n : 0",                                                        // candles/pivots content busts the ETag
  ]) assert.ok(pol.includes(pin), `poller.js missing -13 pin: ${pin}`);
  const app = require("./_client").clientSource();
  for (const fn of ["renderCandles", "renderPivots", "pivotHistSvg", "studyScopeSel", "studyScopeState", "attachStudyScope"])
    assert.equal((app.match(new RegExp("^function " + fn + "\\(", "gm")) || []).length, 1, `exactly one ${fn}`);
  for (const pin of [
    "'Candle behaviour'", "'Time-based pivots'",
    "{html:pvBlock},{pend:pvPend}",
    "attachStudyScope('lvlsel','levels')", "attachStudyScope('anatsel','anatomy')",
    "within-name time series",                                 // the n-basis switch is labeled, both panels
    "All ${nStudies} studies live",
  ]) assert.ok(app.includes(pin), `app.js missing -13 client pin: ${pin}`);
});

test("client -01: the target reconciliation is disclosed on the card, with hover, next to the void precedent", () => {
  const fs = require("fs"), path = require("path");
  const app = require("./_client").clientSource();
  assert.ok(app.includes("c.correctedTarget?"), "the card must read the reconciliation flag from the server payload");
  assert.ok(app.includes("target reconciled to the chart level"), "the disclosure text is missing");
  // standing requirement: every annotation of this class carries hover context, same as the void's
  assert.ok(/c\.correctedTarget\?' · <span data-tip="/.test(app), "the disclosure must carry a data-tip hover explanation");
  // one-code-path: the flag is SERVER-derived, never recomputed client-side from the levels
  assert.ok(!/correctedTarget\s*=/.test(app), "the client must never assign correctedTarget itself");
});
test("actionable -09: client renders the server's numbers and states the carry contract on the tab", () => {
  const fs = require("fs"), path = require("path");
  const s = require("./_client").clientSource();
  const html = fs.readFileSync(path.join(__dirname, "..", "public", "index.html"), "utf8");
  const css = fs.readFileSync(path.join(__dirname, "..", "public", "styles.css"), "utf8");
  // Tab + view + controls exist and are wired into navigation.
  assert.ok(html.includes('data-view="actionable"') && html.includes('id="view-actionable"'), "actionable tab/view markup missing");
  assert.ok(html.includes('id="act-body"') && html.includes('id="actside"'), "actionable board container/controls missing");
  assert.ok(html.includes('id="act-noearn"') && html.includes('id="act-sortreset"'), "actionable filters/sort-reset missing");
  assert.ok(!html.includes('id="act-provenonly"'), "the proven-only filter must be gone — the board is confirmed-only");
  assert.ok(s.includes("setHidden('view-actionable', v!=='actionable')"), "actionable view not wired into showView");
  assert.ok(s.includes("if(v==='actionable')") && s.includes("openActionable()"), "actionable tab does not open its board");
  assert.ok(s.includes("/api/actionable"), "client never calls the actionable endpoint");
  // The one-code-path contract: the client must NOT recompute reward:risk, carry or expectancy.
  // It formats what the server ranked. A local arithmetic path here is exactly how the board and
  // the record start disagreeing about the same trade.
  assert.ok(!/act[A-Za-z]*\s*=\s*[^;]*rewardPct\s*\/\s*riskPct/.test(s), "client must not recompute R:R locally");
  assert.ok(!/r\.rr\.gross\s*\+\s*r\.(carry|rr)\.\w*[Rr]\b/.test(s), "client must not add carry back into R:R locally");
  assert.ok(s.includes("actRR(r.rr.gross)") && s.includes("actEV(r.evR)"), "client must render the server's frozen R:R and expectancy verbatim");
  assert.ok(!s.includes("r.rr.net") && !s.includes("rr.carryKnown"), "no client path reads the retired net/carry-in-ratio fields");
  assert.ok(s.includes("not counted in R:R or EV"), "the carry line states plainly that it is excluded from both");
  assert.ok(!s.includes('">No record yet'), "there is no second section any more — unconfirmed setups are not shown at all");
  // Hover contract: every column header explains itself, and the full audit trail lives in the
  // click-to-expand trade card rather than a cramped row tooltip.
  for (const c of ACT_TIP_COLS) assert.ok(new RegExp("k:'" + c + "'[^}]*tip:").test(s), `column ${c} must carry a header tooltip`);
  assert.ok(s.includes("function actDetail"), "expanded trade card missing");
  for (const frag of ["the trade", "the record", "risk / reward", "carry", "expectancy", "lateness", "bar(s) in trigger"])
    assert.ok(s.includes(frag), `trade card must disclose: ${frag}`);
  assert.ok(s.includes("(paid to hold)") && s.includes("(you pay)"), "the card must state which way carry runs for this side");
  assert.ok(s.includes("funding unavailable"), "an unknown funding rate must be disclosed, not shown as zero carry");
  // Rows expand on click; the two escape hatches out of the card are wired.
  assert.ok(/box\.querySelectorAll\('tr\.act-row'\)/.test(s) && s.includes("_actOpen[k]=!_actOpen[k]"), "rows must expand on click");
  assert.ok(s.includes("data-rep=") && s.includes("data-dr="), "the card must offer the AI report and the ticker drawer");
  // Sorting is the one thing the client owns — persisted, with nulls pinned last both ways.
  assert.ok(s.includes("function actCmp") && s.includes("if(xn) return 1; if(yn) return -1;"), "nulls must sort last in both directions");
  assert.ok(s.includes("actSortSave()") && s.includes("ASKEY"), "sort choice must persist");
  assert.ok(/_actSort=\{k:'ago',d:1\}/.test(s), "default sort must be newest-first");
  // The board must state the gate it applied, in the UI, not just in the payload.
  assert.ok(s.includes("Confirmed only."), "footer must state the board is confirmed-only");
  assert.ok(s.includes("Most events in the ledger do not clear that"), "footer must be honest that most events fail the gate");
  assert.ok(s.includes("an empty board is a real answer"), "an empty board must be explained, not look broken");
  // The board must say, in the UI, that R:R is net and where EV is blank — the honesty contract.
  assert.ok(s.includes("R:R is net of expected funding"), "footer must state that R:R is carry-netted");
  assert.ok(/at least \$\{p\.recMinN\|\|8\} resolved out-of-sample fires/.test(s), "footer must state the record floor the gate requires");
  assert.ok(s.includes("frozen at fire time") && s.includes("never re-derived"), "footer must state that levels are frozen, not re-derived");
  // -15: the crypto engine is back (2026.07.26-08) and the board is cross-universe — the old
  // "equities only" disclosure would now be the lie. The footer must say the scoped truth instead.
  assert.ok(!s.includes("no crypto claims"), "the stale equities-only footer line must be gone — the board serves both universes");
  assert.ok(s.includes("Both universes, scoped by the toggle above"), "footer must state the cross-universe scoped contract");
  // Styling exists for every class the renderer emits (a missing rule renders an unreadable board).
  for (const cls of ["act-h", "act-tbl", "act-ev", "act-stale", "act-also", "act-warn", "act-note", "act-foot"])
    assert.ok(css.includes("." + cls), `missing CSS for client class: ${cls}`);
  // Reuses the trend board's table shell rather than forking a second look for a sibling board.
  assert.ok(s.includes('<table class="trend-t act-tbl">'), "actionable board should reuse the trend table shell");
});

test("triggers -05: browser transport is a consumer only, and the toast surface avoids the terminal", () => {
  const fs = require("fs"), path = require("path");
  const s = require("./_client").clientSource();
  const css = fs.readFileSync(path.join(__dirname, "..", "public", "styles.css"), "utf8");
  // Consumer, not detector: the client must read the server's stream and advance a cursor. If it
  // ever decides for itself what counts as "new", a future Telegram push has a second opinion.
  assert.ok(s.includes("/api/triggers"), "client must consume the server trigger stream");
  assert.ok(s.includes("function trigSeqGet") && s.includes("function trigSeqSet"), "cursor persistence missing");
  // Same invariant, new shape (-03): the first run still adopts the high-water mark without
  // firing, but it now also takes the display list and initialises the read watermark, so a new
  // device opens onto real history with a clean badge instead of a blank panel.
  assert.ok(/if\(cur==null\)\{ trigSeqSet\(d\.seq\|\|0\);/.test(s), "first run on a device must adopt the high-water mark without firing the retained ring");
  const lt0 = s.slice(s.indexOf("async function loadTriggers()"), s.indexOf("function fireTrigger("));
  assert.ok(lt0.indexOf("if(cur==null)") < lt0.indexOf("for(const ev of d.events)"), "…and it must return BEFORE the firing loop");
  // Dedup belongs to the poller: the client must hold a single integer cursor, not a set of keys.
  // (Checked as identifiers, not prose — the comments in app.js legitimately discuss the concept.)
  for (const ident of ["trigSeen", "trigKeys", "seenTriggers", "firedKeys"])
    assert.ok(!new RegExp("(let|const|var)\\s+" + ident + "\\b").test(s), `client must not keep its own announced-set (${ident}) — dedup belongs to the poller`);
  assert.ok(/store\.get\(TSEQ\)/.test(s) && /store\.set\(TSEQ/.test(s), "the client's entire memory of what it has shown must be one persisted sequence number");
  // Fires land in the SHARED alert surface so the bell badge and Recent list cover both kinds.
  // The shared surface moved (-03): it used to be a local array each fire* pushed into, which
  // reset on refresh. It is now the server's own recent list, adopted on every pull — so the
  // invariant is that trigger events reach the SAME feed and badge as every other class, not that
  // a particular local array is written to.
  assert.ok(/A\.feed=d\.recent/.test(s), "trigger fires must land in the shared, server-held feed");
  assert.ok(/function alertUnread\(\)/.test(s) && /A\.feed\.filter/.test(s), "the bell badge must count that shared feed");
  assert.ok(s.includes("function fireTrigger") && s.includes("updateBell()"), "trigger fires must update the bell");
  // Settings live in the bell panel, not in the board's filter row (which would be a second,
  // competing alert-configuration surface).
  // Same invariant, new shape (-09): the three thresholds are now free numeric inputs built by a
  // shared helper rather than three hardcoded <select>s, and R:R joined them — but they still live
  // in the bell panel and nowhere else, which is what this pin is actually protecting.
  assert.ok(s.includes('id="at-on"'), "the trigger toggle stays in the alerts panel");
  assert.ok(/for\(const \[id,key\] of \[\['at-ev','minEV'\],\['at-rr','minRR'\],\['at-late','maxLate'\]\]\)/.test(s),
    "EV, R:R and lateness must all be wired, in the panel");
  assert.ok(/const numIn=\(id,val,ph,tip\)=>/.test(s) && /type="number" step="0\.05"/.test(s),
    "thresholds are free numeric inputs — the old three-option selects could not express an arbitrary floor");
  assert.ok(!s.includes('id="at-proven"'), "the proven-only toggle must be gone — the stream is confirmed-only upstream");
  assert.ok(s.includes("trig:{ on:false"), "trigger alerts must default OFF");
  assert.ok(s.includes("A.trig") && s.includes("trig:state.alerts.trig"), "trigger config must persist alongside the alert rules");
  assert.ok(/state\.alerts\.trig=Object\.assign/.test(s), "trigger config must be restored on load");
  // Toast placement: bottom-LEFT, because bottom-right is the terminal's and the right edge is
  // the drawer's. Since the chat dock claimed the bottom-left corner (build -53), toasts clear
  // its FAB at 64px and sit ABOVE the dock pair (z-118/119) — a toast may briefly cover an open
  // dock panel, never hide behind it.
  assert.ok(/\.toast-wrap\{position:fixed;bottom:64px;left:16px;z-index:130/.test(css), "toast surface must sit bottom-left, above the chat dock");
  assert.ok(!/\.toast-wrap\{[^}]*right:16px/.test(css), "toast must not sit in the terminal FAB's corner");
  for (const cls of ["toast-trig", "tt-h", "tt-g", "tt-a", "act-late-bad"])
    assert.ok(css.includes("." + cls), `missing CSS for trigger toast class: ${cls}`);
  // The toast has to carry geometry and an escape hatch, or it is just noise with a ticker on it.
  assert.ok(s.includes("data-mute") && s.includes("data-rep"), "toast must offer mute and report actions");
  assert.ok(s.includes("fired ${fmtPrice(ev.fired)}"), "toast must show the fire mark");
  // Board: both marks and lateness are rendered from the payload.
  assert.ok(s.includes("fmtPrice(r.fired)") && s.includes("actLate(r.late)"), "board must render the fire mark and lateness");
  for (const lb of ["'Fired'", "'Now'", "'Late'", "'Ago'", "'Rec'"])
    assert.ok(s.includes("lb:" + lb), `board must carry the ${lb} column`);
  assert.ok(!/r\.entry\s*[-/]\s*r\.fired/.test(s), "client must not recompute lateness locally");

  // Direction must survive a reader who cannot separate green from red. The collapsed row carried
  // the side ONLY as a pos/neg tint on the ticker cell until 2026.07.27-20 — which also read like a
  // day-change tint, so a short was indistinguishable from a name that happened to be down.
  assert.ok(/<span class="act-side \$\{sd\}"/.test(s), "the collapsed row must render an explicit side chip");
  assert.ok(/\$\{esc\(r\.side\)\}<\/span>/.test(s), "the chip must print the side as a word, not a glyph or colour alone");
  assert.ok(/const sd=r\.side==='long'\?'l':'s'/.test(s), "chip modifier must be derived from the payload's side");
  assert.ok(!/const sc=r\.side==='long'\?'pos':'neg'/.test(s),
    "the ticker cell must no longer be tinted by side — colour alone is not an encoding");
  for (const cls of ["act-side", "act-side.l", "act-side.s"])
    assert.ok(css.includes("." + cls), `missing CSS for side chip class: ${cls}`);
  // Both directions must be spelled out somewhere a hover can reach them.
  assert.ok(s.includes("the claim pays if price rises") && s.includes("the claim pays if price falls"),
    "each side must explain which way the trade and its void run");
});

test("tabs: backtest is hidden from the strip by default without withdrawing the feature", () => {
  const fs = require("fs"), path = require("path");
  const s = require("./_client").clientSource();
  const css = fs.readFileSync(path.join(__dirname, "..", "public", "styles.css"), "utf8");
  const html = fs.readFileSync(path.join(__dirname, "..", "public", "index.html"), "utf8");
  // HIDDEN_TABS was retired in 2026.07.26-05: the same two tabs are now admin-state entries in the
  // server manifest, so the hide is expressed ONCE and an admin can actually see them. The list must
  // not come back — a second visibility list beside the manifest is the drift this work removed.
  const C = require("../src/compute");
  assert.ok(!/HIDDEN_TABS/.test(s), "HIDDEN_TABS must stay deleted — the manifest owns tab visibility now");
  for (const v of ["backtest", "actionable"])
    assert.equal(C.featureState({}, v), "admin", `${v} must default to admin in the manifest (it used to be in HIDDEN_TABS)`);
  assert.ok(s.includes("function applyTabVisibility"), "tab visibility applier missing");
  assert.ok(/applyTabOrder\(\);(?: buildTabGroups\(\);)? applyTabVisibility\(\);/.test(s),
    "visibility must be applied on the initial nav pass, after any grouping step");
  // The applier must evaluate EVERY tab, not just members of a hide-list, or a flag flipped to public
  // in the panel would leave the tab stuck hidden until someone edited app.js.
  assert.ok(/t\.hidden = !tabVisible\(t\.dataset\.view\)/.test(s), "applyTabVisibility must both hide and un-hide via tabVisible");
  assert.ok(/applyTabVisibility==='function'\) applyTabVisibility\(\)/.test(s), "visibility must be re-applied when the strip is rebuilt at runtime");
  // The guard moved into the consolidated [hidden] block at the top of styles.css in -23; it is the
  // same guarantee, stated once for every hideable component instead of per-component.
  assert.ok(/\.tab\[hidden\]\{display:none\}/.test(css), "a display rule on .tab must not be able to silently un-hide a hidden tab");
  // The feature is NOT withdrawn: markup, view section, renderers, help and the deep link all live.
  assert.ok(html.includes('data-view="backtest"') && html.includes('id="view-backtest"'), "backtest markup must survive the hide");
  assert.ok(s.includes("backtest:`"), "backtest help entry must survive the hide");
  assert.ok(s.includes("function renderBacktest_load"), "backtest renderer must survive the hide");
  assert.ok(s.includes("setHidden('view-backtest'"), "showView must still route to backtest");
  // Command palette stays the deliberate way back in — and must list every LIVE tab, including
  // the one added this build (which it did not, until now).
  assert.ok(/\{v:'backtest',label:'Backtest'\}/.test(s), "backtest must remain findable in the command palette");
  assert.ok(/\{v:'actionable',label:'Actionable'\}/.test(s), "the actionable tab must be listed in the command palette");
  // ...but the palette must FILTER on visibility, because it is a third route into a view that is
  // independent of the nav strip: without this, a gated tab stays reachable by name.
  assert.ok(/cmdkTabs\(\)\.filter\(t=>tabVisible\(t\.v\)/.test(s), "the command palette must filter on tabVisible");
  // HASH_VIEWS stays COMPLETE — the routing table lists every view, and the gate is applied at
  // dispatch. That is the difference from the old posture: an admin's #backtest still works, a public
  // caller's does not. A short routing table would instead make a tab unreachable for everyone.
  assert.ok(/const HASH_VIEWS=new Set\(/.test(s), "hash routing must be a declared view set, not an inline whitelist");
  for (const v of ["actionable", "backtest", "signals", "news", "markets", "trend", "report"])
    assert.ok(new RegExp("'" + v + "'").test(s.match(/const HASH_VIEWS=new Set\(\[[^\]]*\]\)/)[0]), `#${v} must be routable`);
  assert.ok(s.includes("if(HASH_VIEWS.has(h) && tabVisible(h)) showView(h);"), "applyHash must route via the view set AND the gate");
  const hv = s.indexOf("const HASH_VIEWS"), ah = s.indexOf("function applyHash");
  assert.ok(hv > 0 && hv < ah, "HASH_VIEWS must be declared before applyHash");
});

test("settled -02: the client renders the honest surfaces — cost-colored lateness, exp \u00b1 split, shown-first ordering, exit price, bt and corr tags", () => {
  const fs = require("fs"), path = require("path");
  const s = require("./_client").clientSource();
  assert.ok(s.includes("function actSetCost"), "lateness needs its own formatter — it is a cost, not a return");
  assert.ok(s.includes("lateness ${actSetCost(u.lat)}"), "the strip must render lateness through the cost formatter (positive = red), not the generic R formatter that painted it green");
  assert.ok(s.includes("exp \\u00b1"), "the stats table must carry the signed expiry split column");
  assert.ok(s.includes("targets over level-touched resolutions ONLY"), "the hit tooltip must state expiries are excluded");
  assert.ok(s.includes("b.hit!=null?"), "a null hit renders a dash — no rate is claimed over pure expiries");
  // @shown leads @fire everywhere: the economically meaningful basis first, the counterfactual demoted.
  const th = s.indexOf("R@shown"), tf = s.indexOf("R@fire");
  assert.ok(th >= 0 && tf >= 0 && th < tf, "the episode table must lead with R@shown");
  const ah = s.indexOf("avg @shown"), af = s.indexOf("avg @fire");
  assert.ok(ah >= 0 && af >= 0 && ah < af, "the stats table must lead with avg @shown");
  assert.ok(s.includes("actSetR(b.avgM)") && s.indexOf("actSetR(b.avgM)") < s.indexOf("actSetR(b.avgE)"), "cells must follow the header order");
  // Outcome carries the price it was scored at — frozen level for touches, recorded mark for expiries.
  assert.ok(s.includes("e.kind==='target'?e.target:e.kind==='void'?e.void:e.exitPx"), "outcome price resolves from the episode's own frozen data");
  assert.ok(s.includes("fmtPrice(opx)"), "…and renders it");
  assert.ok(!/epScore|epResolve/.test(s), "still no client-side scoring");
  assert.ok(s.includes("excluded from the headline lateness"), "bt episodes must be disclosed as excluded, glyph and words");
  assert.ok(s.includes("corr \\u00d7"), "correlated same-build episodes must wear the tag");
  assert.ok(s.includes("correlated cluster"), "the strip must disclose cluster count");
});

test("settled -02: the cost formatter executes with cost semantics and the episode table's colspan matches its columns", () => {
  const fs = require("fs"), path = require("path");
  const s = require("./_client").clientSource();
  // Execute the formatter, don't just pin it: positive lateness is a COST and must class red.
  const m = s.match(/function actSetCost\(x\)\{[^\n]*\}/);
  assert.ok(m, "actSetCost must be a one-line pure function");
  const actSetCost = new Function("return " + m[0].replace("function actSetCost", "function"))();
  assert.ok(actSetCost(0.73).includes('class="neg"'), "+0.73R of lateness renders RED — the screenshot bug");
  assert.ok(actSetCost(-0.2).includes('class="pos"'), "negative lateness (the board surfaced EARLY) renders green");
  assert.ok(actSetCost(null) === "\u2014", "null renders a dash");
  // The detail row spans whatever the header declares — a column added on one side only renders a broken table.
  const hdr = s.match(/<table class="trend-t act-set-eps"><thead><tr>(.*?)<\/tr><\/thead>/s);
  assert.ok(hdr, "episode table header missing");
  const thN = (hdr[1].match(/<th/g) || []).length;
  const cs = s.match(/act-detrow"><td colspan="(\d+)">\$\{actEpDetail/);
  assert.ok(cs, "episode detail colspan missing");
  assert.equal(+cs[1], thN, `detail colspan (${cs && cs[1]}) must equal the header's column count (${thN})`);
});

test("settled -15: the client renders the server's record and never re-scores an episode", () => {
  const fs = require("fs"), path = require("path");
  const s = require("./_client").clientSource();
  const css = fs.readFileSync(path.join(__dirname, "..", "public", "styles.css"), "utf8");
  assert.ok(s.includes("function actSettled") && s.includes("function actEpDetail") && s.includes("function actSettledWire"),
    "settled renderer missing");
  assert.ok(s.includes("h+=actSettled(d,wantU);") && s.includes("actSettledWire(box);"), "settled section not mounted in renderActionable");
  assert.ok(s.includes("d.settled") && s.includes("st.perUni[wantU]"), "the section must read the payload's settled block, scoped like every other record surface");
  // One-code-path: no client-side episode scoring — rE/rM/hit/avg/pf are formatted, never derived.
  assert.ok(!/epScore|epResolve/.test(s), "episode scoring must never exist client-side");
  assert.ok(s.includes("2+1 \\u2014 \\u22652:1 at fire") && s.includes("grinders \\u2014 sub-2:1, +EV"),
    "the stats table must carry the class split — the same rr/ev families the board's checkboxes filter");
  assert.ok(s.includes("t/v/x"), "each class row must disclose its outcome split — level touches live INSIDE the class buckets");
  assert.ok(s.includes("flicker") && s.includes("unscoreable") && s.includes("approx"), "the strip must disclose folds, drops and spine-gap scores");
  assert.ok(s.includes("out of sample since"), "the record must state its own epoch");
  for (const cls of ["act-set", "act-set-strip", "act-set-t", "act-set-eps", "act-set-det", "act-set-mut"])
    assert.ok(css.includes("." + cls), `missing CSS for settled class: ${cls}`);
});

test("settled -03: the episode record is paged — bounded DOM, per-universe batch, sticky anchor-preserving size", () => {
  const fs = require("fs"), path = require("path");
  const s = require("./_client").clientSource();
  const css = fs.readFileSync(path.join(__dirname, "..", "public", "styles.css"), "utf8");
  // Only the current batch is ever mounted — the loop must iterate the slice, not the full list.
  // (The -84 lesson: an existence pin on the pager proves nothing if the render still walks every row.)
  assert.ok(s.includes("epsPageRows=eps.slice(epsStart,epsStart+epsSize)"), "the batch must be a slice of the reversed episode list");
  assert.ok(s.includes("for(const e of epsPageRows)"), "the render loop must walk the current batch");
  assert.ok(!/for\(const e of eps\)\{ const op=/.test(s), "the render loop must NOT walk the full episode list — that defeats the bounded-DOM point");
  // Batch index is kept PER universe and clamped at render (a size bump can orphan the stored page).
  assert.ok(s.includes("_actEpPage[wantU]=epsPg") && /if\(epsPg>epsPages-1\) epsPg=epsPages-1/.test(s), "per-universe batch index, clamped to the page count");
  assert.ok(s.includes("Math.max(1,Math.ceil(epsTotal/epsSize))"), "page count derives from total and size");
  // The pager only appears once there's more than the smallest batch to page through.
  assert.ok(s.includes("if(epsTotal>10)"), "pager is gated on there being more than one batch at the smallest size");
  // Size is one of exactly three values, persisted, shared across universes.
  assert.ok(s.includes("data-epsz=\"10\"") === false, "sizes are rendered via szBtn, not hard-inlined");
  for (const n of [10, 20, 50]) assert.ok(s.includes("szBtn(" + n + ")"), "size option missing: " + n);
  assert.ok(s.includes("store.get('actEpSize')") && s.includes("store.set('actEpSize'"), "size must persist under actEpSize");
  // Anchor-preserving size change: first row of the current batch stays put across a resize.
  assert.ok(s.includes("const anchor=(_actEpPage[u]||0)*_actEpSize;") && s.includes("_actEpPage[u]=Math.floor(anchor/n);"),
    "size change must hold position by row anchor, not snap to top");
  // Nav mutates the per-universe index and re-renders; disabled ends are inert.
  assert.ok(s.includes("_actEpPage[u]=(_actEpPage[u]||0)+(+b.dataset.eppg)"), "prev/next steps the per-universe batch index");
  assert.ok(/\.act-ep-pg.*if\(b\.disabled\) return/s.test(s.slice(s.indexOf("act-ep-pg"))), "a disabled nav button is inert");
  for (const cls of ["act-ep-pager", "act-ep-sz", "act-ep-pg", "act-ep-show", "act-ep-nav"])
    assert.ok(css.includes("." + cls), "missing pager CSS class: " + cls);
});

test("settled -03: actEpSizeSet executes with real validation — only 10/20/50, and it persists", () => {
  const fs = require("fs"), path = require("path");
  const s = require("./_client").clientSource();
  const m = s.match(/function actEpSizeSet\(n\)\{[\s\S]*?\}\n/);
  assert.ok(m, "actEpSizeSet must be a single named function");
  const rec = [];
  const api = new Function("store",
    `let _actEpSize=20; ${m[0]} return { set:(n)=>{ actEpSizeSet(n); return _actEpSize; } };`
  )({ set: (k, v) => rec.push([k, v]) });
  assert.equal(api.set(50), 50, "50 is accepted");
  assert.equal(api.set(10), 10, "10 is accepted");
  assert.equal(api.set(7), 10, "an off-menu size is rejected — the last valid size stands");
  assert.equal(api.set(0), 10, "zero is rejected");
  assert.deepEqual(rec[rec.length - 1], ["actEpSize", "10"], "only accepted sizes are persisted");
  assert.equal(rec.filter((r) => r[1] === "7" || r[1] === "0").length, 0, "rejected sizes never reach the store");
});

test("swing -20: poller wiring manifest — fire sites, resolver, rosters, glossary, panel, client", () => {
  const fs = require("fs"), path = require("path");
  const pol = fs.readFileSync(path.join(__dirname, "..", "src", "poller.js"), "utf8");
  for (const pin of [
    'openLedger(r, "swpull"', 'openLedger(r, "basebrk"', 'openLedger(r, "basepj"',
    "stp: sp.stop, tgt: sp.target, tm: 1",                       // touch mode + ABSOLUTE frozen target ride extra
    "stp: bb.stop, tgt: bb.targetL, tm: 1",
    "stp: bb.stop, tgt: bb.targetP, tm: 1",
    "const br = bracketTouch(hs, e.t0, Math.min(e.resolveAt, now), sideE, e.stp, e.tgt);",   // early-touch scan
    'if (br) { pTouch = br.level; tEnd = br.t; e.rb = br.hit === "target" ? "t" : "s"; if (br.amb) e.amb = 1; }',
    "else if (now < e.resolveAt) continue;",                     // untouched + not expired -> still live
    "if (e.tm === 1 && e.rb) e.realizedB = realized;",           // touch claims: tracks coincide
    "e.realizedB = br ? +(sgn * (br.level / p0 - 1) * 100).toFixed(2) : realized;",          // symmetric track
    'if (now < e.resolveAt && !(e.tm === 1 && e.stp != null && e.tgt != null)) continue;',   // per-pass gate
    "const b0 = priceAsOf(bh, e.t0, 3 * HOUR), b1 = priceAsOf(bh, tEnd, 3 * HOUR);",         // BTC leg on the live window
    '"swpull", "basebrk", "basepj",',                            // MAIN_EVS enrollment
    'tm: "touch-mode claim', 'rb: "bracket outcome', 'realizedB: "bracket-track outcome', 'r2: "MA200 regime at fire',
    "if (r._r2 != null) e.r2 = r._r2;",                          // regime stamp at claim creation
    'ev: "swpull", uni: "both"', 'ev: "basebrk", uni: "both"', 'ev: "basepj", uni: "both"',  // shadow panel rows
    "delete e.tgt; delete e.tm; }",                              // crypto scrub degrades touch mode honestly
    "nB: b.retsB.length, hitB:",                                 // bracket aggregation in the record
  ]) assert.ok(pol.includes(pin), `poller.js missing -20 pin: ${pin}`);
  // exactly one bracketTouch call per resolver concern: the touch-mode scan and the parallel track
  assert.equal((pol.match(/bracketTouch\(/g) || []).length, 2, "two resolver call sites, no strays");
  assert.ok(pol.includes("stopTouched, bracketTouch,"), "primitive imported alongside stopTouched");
  const app = require("./_client").clientSource();
  for (const pin of ["tch hit", "tch med", "tch pf", "r.hitB", "r.medB", "r.pfB", 'colspan="10"'])
    assert.ok(app.includes(pin), `app.js missing -20 pin: ${pin}`);
});

test("levels -22: wiring manifest — poller assembly, snapshot column, study audit, client surfaces", () => {
  const fs = require("fs"), path = require("path");
  const pol = fs.readFileSync(path.join(__dirname, "..", "src", "poller.js"), "utf8");
  for (const pin of [
    "function volMapFor(r)",
    "const vp = volumeProfile(bars, sd30);",
    "const map = levelMap({ str, vp, e50: ema(50), e200: ema(200) }, r.px, sd30);",
    "r._vpK = memoK; r._vpM = out;",                                    // daily-cadence memo, never the 15s tick
    "fundPct, red, rvol, swr, swrT, swrV, swrS,",                       // Swing R rides the snapshot row
    'swrS = tgt.srcs.join("+");',
    'it.srcs.length === 1 && it.srcs[0] === "lvn"',                     // LVNs excluded as targets
    "vp: vm && vm.vp ? vm.vp : null, dexVol:",                          // chart payload carries profile + caveat
    "st.profile = levelStudy(pooledVp, { horizon: LVL_HORIZON, cellFloor: LVL_CELL_FLOOR });",
    "stride: LVL_STRIDE + 2",                                           // audit stride bounds the prefix-profile cost
    "detect: (pb, px2, sd2) => {",                                      // HVN audit rides the injectable detector
  ]) assert.ok(pol.includes(pin), `poller.js missing -22 pin: ${pin}`);
  const app = require("./_client").clientSource();
  for (const pin of [
    "{key:'swr', label:'Swing R'",
    "hand-set weights (str 1.0 \\u00b7 hvn 0.8 \\u00b7 e200 0.7 \\u00b7 e50 0.6 \\u00b7 lvn 0.5)",  // disclosure lives where the number is
    "data-aivp",                                                        // VP toggle
    "dex volume profile histogram (build -22)",
    "DEX volume",                                                       // the honesty caveat, verbatim class
    "Volume-profile HVNs (audit)",                                      // the report card row
    "state.report.vp=state.report.vp===false?true:false;",
  ]) assert.ok(app.includes(pin), `app.js missing -22 pin: ${pin}`);
  const cmp = fs.readFileSync(path.join(__dirname, "..", "src", "compute.js"), "utf8");
  assert.ok(cmp.includes("const LVL_MAP_W = { str: 1.0, hvn: 0.8, e200: 0.7, e50: 0.6, lvn: 0.5 };"), "weights pinned at the definition");
  for (const f of ["volumeProfile", "levelMap"])
    assert.equal((cmp.match(new RegExp("^function " + f + "\\(", "mg")) || []).length, 1, `exactly one ${f} definition`);
});

test("ema200 -26: poller + client wiring manifest — section, memo, retest ride, panel surfaces", () => {
  const fs = require("fs"), path = require("path");
  const pol = fs.readFileSync(path.join(__dirname, "..", "src", "poller.js"), "utf8");
  for (const pin of [
    "function buildEma200Study(U)",
    'const EMA_TF = { "1d": { horizon: 14, stride: 5, minBars: 210 }, "4h": { horizon: 84, stride: 12, minBars: 210 } };',
    "const EMA_MIN_EQ = 5, EMA_CELL_FLOOR = 30, EMA_REARM = 3, EMA_BUF_SD = 0.25;",
    'closedBars(mergedDailyBars(r), DAY, now)',                    // D1 = the one merged source, forming day trimmed
    'closedBars(bucketsFor(r, 4), 4 * HOUR, now)',                 // H4 = spine buckets, forming bucket trimmed
    "const e2 = emaLast(pb.map((k) => k.c), 200);",                // retest rides the injectable audit on emaLast
    "if (r._emSrc !== db) {",                                      // levels-study memo contract
    "ema200: emSt,",                                               // section wired
    "const emSt = on(\"structure\") ? buildEma200Study(U) : DISABLED;",
    "function mergedDailyBars(r)",                                 // extracted, three consumers
  ]) assert.ok(pol.includes(pin), `poller.js missing -26 pin: ${pin}`);
  // one code path: volMapFor must now consume the extracted helper, not a private copy
  assert.ok(/const bars = mergedDailyBars\(r\);/.test(pol), "volMapFor reads mergedDailyBars");
  const app = require("./_client").clientSource();
  for (const pin of [
    "function renderEma200(em)", "function emaXCell(", "function emaRtRow(",
    "a.sections && a.sections.ema200",
    "Support retest (bullish)", "Resistance retest (bearish)",
    "whip 5b",
    "closed candles only",
    "{html:emBlock},{pend:emPend}",
  ]) assert.ok(app.includes(pin), `app.js missing -26 pin: ${pin}`);
  const css = fs.readFileSync(path.join(__dirname, "..", "public", "styles.css"), "utf8");
  for (const cls of [".ptbl tr.tfh td", ".pill2", ".ft"])
    assert.ok(css.includes(cls), `styles.css missing -26 class: ${cls}`);
  const cmp = fs.readFileSync(path.join(__dirname, "..", "src", "compute.js"), "utf8");
  for (const f of ["emaCrossOutcomes", "emaCrossStudy"])
    assert.equal((cmp.match(new RegExp("^function " + f + "\\(", "mg")) || []).length, 1, `exactly one ${f} definition`);
});

test("now -29: delta is signed WITH the claim, and the bracket bar only exists where geometry does", () => {
  // The two pure functions behind the chip, extracted from app.js and evaluated directly — the
  // sign convention is the whole point of the column and must not be reasoned about by eye.
  const fs = require("fs"), path = require("path");
  const app = require("./_client").clientSource();
  const grab = (name) => {
    const i = app.indexOf("function " + name + "(");
    assert.ok(i > -1, name + " present");
    let d = 0, j = app.indexOf("{", i);
    for (let k = j; k < app.length; k++) { if (app[k] === "{") d++; else if (app[k] === "}") { d--; if (!d) return app.slice(i, k + 1); } }
    throw new Error("unbalanced " + name);
  };
  const clamp = (x, a, b) => Math.min(b, Math.max(a, x));
  const fn = new Function("clamp", grab("claimDelta") + "\n" + grab("brkBar") + "\nreturn {claimDelta, brkBar};")(clamp);
  // LONG: price up is ahead (positive); price down is behind
  assert.ok(Math.abs(fn.claimDelta("long", 100, 110) - 10) < 1e-9, "long, price up: +10%");
  assert.ok(Math.abs(fn.claimDelta("long", 100, 95) - -5) < 1e-9, "long, price down: -5%");
  // SHORT: the mirror — price DOWN is the claim winning, and must read positive
  assert.ok(fn.claimDelta("short", 100, 90) > 0, "short, price down: POSITIVE — the chip asks whether the CLAIM is winning");
  assert.ok(Math.abs(fn.claimDelta("short", 100, 90) - 10) < 1e-9, "short, -10% price = +10% for the claim");
  assert.ok(fn.claimDelta("short", 100, 110) < 0, "short, price up: negative");
  assert.equal(fn.claimDelta("long", null, 110), null, "no fire mark: no delta, never a zero");
  assert.equal(fn.claimDelta("long", 0, 110), null, "a zero mark can't anchor a percentage");
  // bracket bar: long claim, mark 100, void 95, target 115
  const up = fn.brkBar("long", 100, 107.5, 95, 115);
  assert.ok(up && up.towardT === true && Math.abs(up.frac - 0.5) < 1e-9, "halfway to the target reads 50% toward target");
  const dn = fn.brkBar("long", 100, 97.5, 95, 115);
  assert.ok(dn && dn.towardT === false && Math.abs(dn.frac - 0.5) < 1e-9, "halfway to the void reads 50% toward void");
  assert.ok(fn.brkBar("long", 100, 130, 95, 115).frac === 1, "past the level clamps at the level — never >100%");
  // short mirror: target BELOW the mark, void above
  const sh = fn.brkBar("short", 100, 95, 105, 90);
  assert.ok(sh && sh.towardT === true && Math.abs(sh.frac - 0.5) < 1e-9, "short: halfway down to the target");
  // no geometry -> no bar, ever
  assert.equal(fn.brkBar("long", 100, 105, null, 115), null, "no frozen void: no bar");
  assert.equal(fn.brkBar("long", 100, 105, 95, null), null, "no frozen target: no bar");
  assert.equal(fn.brkBar("long", 100, 105, 100, 115), null, "a void AT the mark has no scale to measure against");
});

test("-06 client/server duel: basketClosesClient reproduces compute.basketCloses bit-identically on a ragged fixture", () => {
  const fs = require("fs"), path = require("path");
  const app = require("./_client").clientSource();
  const grab = (name) => {
    const i = app.indexOf("function " + name + "(");
    assert.ok(i > -1, name + " present in app.js");
    let d = 0, j = app.indexOf("{", i);
    for (let k = j; k < app.length; k++) { if (app[k] === "{") d++; else if (app[k] === "}") { d--; if (!d) return app.slice(i, k + 1); } }
    throw new Error("unbalanced " + name);
  };
  const fn = new Function(grab("basketClosesClient") + "\nreturn basketClosesClient;")();
  const C = require("../src/compute");
  const fix = [
    [100, 101, null, 103, 104, null, 107],
    [200, 198, 197, null, 205, null, 210],
    [50, 51, 52, 53, null, null, 55],
    [10, null, 10, 11, 12, null, 13],
  ];
  for (const floor of [0.6, 0.5, 0.9]) {
    assert.deepEqual(fn(fix, floor), C.basketCloses(fix, floor), "one math, two runtimes — floor " + floor);
  }
});

test("-06 ratio SVG behavioral: real candles render, the EMA path appears only when the series exists, rebase is a scalar transform", () => {
  const fs = require("fs"), path = require("path");
  const app = require("./_client").clientSource();
  const grab = (name) => {
    const i = app.indexOf("function " + name + "(");
    assert.ok(i > -1, name + " present");
    let d = 0, j = app.indexOf("{", i);
    for (let k = j; k < app.length; k++) { if (app[k] === "{") d++; else if (app[k] === "}") { d--; if (!d) return app.slice(i, k + 1); } }
    throw new Error("unbalanced " + name);
  };
  const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  const ratioSvg = new Function("esc", grab("ratioSvg") + "\nreturn ratioSvg;")(esc);
  const HOUR = 3600e3, t0 = 1700000000000;
  const candles = Array.from({ length: 12 }, (_, i) => { const o = 2 + i * 0.01, c = o + (i % 2 ? 0.02 : -0.015); return { t: t0 + i * 4 * HOUR, o, h: Math.max(o, c) + 0.01, l: Math.min(o, c) - 0.01, c }; });
  const ema = candles.map((k, i) => (i < 3 ? null : k.c - 0.005));
  const d = { candles, ema200: ema };
  const on = ratioSvg(d, { scale: "reb", ema: true });
  assert.equal((on.svg.match(/class="rt-k"/g) || []).length, candles.length, "one candle body per bar — real markup, not an existence pin");
  assert.ok(on.svg.includes('class="rt-ema"'), "EMA path present when the series exists and the toggle is on");
  assert.ok(on.svg.includes('id="rt-cx"') && on.svg.includes('id="rt-hl"'), "crosshair + candle-highlight nodes exist for the hover wiring (standing rule: every chart hovers)");
  assert.equal(on.pts.length, candles.length, "one hover point per candle");
  const off = ratioSvg({ candles, ema200: null }, { scale: "reb", ema: true });
  assert.ok(!off.svg.includes('class="rt-ema"'), "no EMA series -> no path, never a fabricated line");
  // Rebase = scalar multiply: the first candle's open maps to 100 exactly.
  const firstY = on.pts[0];
  const raw = ratioSvg(d, { scale: "raw", ema: false });
  assert.ok(raw.pts.length === candles.length && firstY, "raw mode renders the same bars");
});

test("-09 pair view executes on basket × ticker: stats render, the ⬒ anatomy shows, nothing throws", () => {
  const { api, els, restore } = _p2Harness();
  try {
    const DAY = 86400e3, today = Math.floor(Date.now() / DAY) * DAY;
    api.state.scope = "stocks"; api.state.view = "corr"; api.state.corr.tf = "90";
    const mkDaily = (f) => Array.from({ length: 120 }, (_, i) => ({ t: today - (119 - i) * DAY, c: f(i) }));
    const row = { coin: "xyz:AAA", ticker: "AAA", uni: "xyz", px: 100, daily: mkDaily(i => 100 * (1 + Math.sin(i / 6) * 0.02 + i * 0.001)), delisted: false };
    api.state.rows.set("xyz:AAA", row);
    api.BASKETS.list = [{ name: "MAG2", scope: "stocks", members: ["AAA"], builtin: false,
      daily: mkDaily(i => 50 * (1 + Math.cos(i / 7) * 0.015 + i * 0.0008)).map(k => [k.t, k.c]) }];
    api.BASKETS.rev = 2;
    const vrow = api.basketVirtualRow(api.BASKETS.list[0]);
    api.CORR._rows = [vrow, row]; api.CORR._intraday = false; api.CORR._bars = null; api.CORR._times = null;
    api.CORR._C = [[1, 0.5], [0.5, 1]]; api.CORR._N = [[0, 90], [90, 0]];
    api.state.corr.pair = [0, 1];
    api.renderPairPanel();
    const h = els["pairpanel"].innerHTML;
    assert.ok(/pairstats/.test(h), "β / z-score / rolling-ρ stats rendered on a virtual leg");
    assert.ok(/bkg/.test(h) && /\u2b12/.test(h), "the basket leg wears its glyph in the pair head");
    assert.ok(/pairratio/.test(h), "the candles button rides along — /api/ratio already speaks basket");
  } finally { restore(); }
});

test("-09 backtest yardstick: dashed ⬒ line draws only when picked, hover carries it, stats stay untouched", () => {
  const { api, restore } = _p2Harness();
  try {
    const days = Array.from({ length: 30 }, (_, i) => 20000 + i);
    const ramp = (a) => Array.from({ length: 30 }, (_, i) => a + i * 0.002);
    const res = { days, eq: ramp(1), eqg: ramp(1.001), eqb: ramp(0.999), eqew: ramp(0.998) };
    const off = api.btCurveSvg(res, 15);
    assert.ok(!/bt-vb/.test(off), "no pick -> no line, never a phantom overlay");
    res.eqvb = ramp(0.997); res.vbName = "MAG7";
    const on = api.btCurveSvg(res, 15);
    assert.ok(/class="bt-vb"/.test(on) && /stroke-dasharray/.test(on), "picked -> dashed yardstick path renders");
    // hover rows register via closure (_hoverReg), not the returned markup — read the registry
    const ids = Object.keys(api.hoverReg); const last = api.hoverReg[ids[ids.length - 1]];
    assert.ok(last && /\u2b12MAG7/.test(last.rows[10]), "hover rows carry the basket read at every bar");
  } finally { restore(); }
});

test("-11 client: shadows are pickable everywhere but excluded from the manager list", () => {
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
    const api = new Function(app + "\n;return {state, BASKETS, basketScopeList, basketManagerList, compgBasketNames, dvbBasketDef};")();
    api.state.scope = "stocks";
    // Mutate BASKETS.list in place — the client closure reads the module-scoped BASKETS, so a
    // reassignment of the whole object would be invisible to basketScopeList/compgBasketNames.
    api.BASKETS.list.length = 0;
    api.BASKETS.list.push(
      { name: "MINE", scope: "stocks", members: ["AAPL", "MSFT"], builtin: false },
      { name: "MAG7", scope: "stocks", members: ["AAPL", "MSFT", "NVDA"], builtin: true, cur: true },
      { name: "TECH", scope: "stocks", members: ["AAPL", "MSFT"], builtin: true, shadow: true, kind: "sector", daily: [{ t: Date.now(), c: 100 }] },
      { name: "MEMORYSTORAG", scope: "stocks", members: ["MU", "SNDK"], builtin: true, shadow: true, kind: "industry", label: "Memory/Storage", daily: [{ t: Date.now(), c: 100 }] });
    api.BASKETS.rev = 1;
    const mgr = api.basketManagerList().map((b) => b.name);
    assert.deepEqual(mgr.sort(), ["MAG7", "MINE"], "manager shows the operator's own + curated MAG7, NEVER the shadows");
    const picks = api.compgBasketNames();
    assert.ok(picks.includes("TECH") && picks.includes("MEMORYSTORAG"), "shadows ARE pickable in COMP/G");
    assert.ok(picks.includes("MINE") && picks.includes("MAG7"), "…alongside the shown baskets");
    // Δ column picker can select a shadow too
    api.state.dvbBasket = "MEMORYSTORAG";
    assert.equal(api.dvbBasketDef().name, "MEMORYSTORAG", "the Δ column can measure against a shadow industry");
  } finally {
    global.setInterval = saved.si; global.setTimeout = saved.st; global.requestAnimationFrame = saved.raf;
    global.clearTimeout = saved.ct; global.clearInterval = saved.ci;
    global.document = saved.doc; global.window = saved.win; global.localStorage = saved.ls; global.fetch = saved.f;
  }
});

test("D open cell: executed against real row shapes — % only, shaded, level in hover, honest dash", () => {
  const fs = require("fs"), path = require("path");
  const app = require("./_client").clientSource();
  const grab = (name) => { const i = app.indexOf("function " + name); assert.ok(i >= 0, name + " missing");
    let d = 0, j = i; for (; j < app.length; j++) { if (app[j] === "{") d++; else if (app[j] === "}") { d--; if (d === 0) break; } }
    return app.slice(i, j + 1); };
  const nf = app.match(/const nf=\(x,d\)=>[^;]*;/)[0];
  const R = new Function(nf + "\n" + grab("fmtPrice") + "\n" + grab("fmtPct") + "\n" + grab("shade") + "\n" +
    grab("pctInner") + "\n" + grab("dopenCell") + "\nreturn dopenCell;")();
  // up day: green %, magnitude shading present, exact open level in the title, NO price in the cell body
  const up = R({ dopen: 1.23, dopenPx: 182.05, px: 184.29 });
  assert.ok(up.includes('class="pos"') && up.includes("+1.23%"), "positive % rendered green");
  assert.ok(up.includes("rgba(70,185,126"), "green magnitude shade applied");
  assert.ok(up.includes("182.05") && /title="[^"]*182\.05/.test(up), "open level rides the hover");
  assert.ok(!/>[^<]*182\.05/.test(up.replace(/title="[^"]*"/, "")), "cell body carries the % only, never the price");
  // down day shades red; flat day renders sec with no shade at all
  const dn = R({ dopen: -0.9, dopenPx: 243.3, px: 241.1 });
  assert.ok(dn.includes('class="neg"') && dn.includes("rgba(229,96,77"), "negative % shades red");
  assert.ok(R({ dopen: 0, dopenPx: 100, px: 100 }).includes("0.000"), "zero move: shade alpha collapses to 0.000 — same convention as every sibling change column");
  // missing anchor: honest dash with the backfill explanation, not a zero
  const na = R({ dopen: undefined });
  assert.ok(na.includes("\u2014") && na.includes("daily backfill"), "no anchor: dash + disclosure, never a fabricated 0");
});

// ================================================================================================
// Action lists in the group lens (build 2026.08.07-05): share-of-tape confirm, name-level bid.
// ================================================================================================

test("group action math: share-of-tape delta, group heat, honest reclaim phrasing (behavioral)", () => {
  const fns = actionMathFns();   // the extraction block now also carries the -05 group functions
  const { shareDeltaPp, groupHeatOf, bidPhrase, groupHeatOfMissing } = { ...fns };
  // share: 30 of 100 today vs 20 of 100 baseline = +10pp of the tape; zero-sum arithmetic exactly
  assert.ok(Math.abs(fns.shareDeltaPp(30, 100, 20, 100) - 10) < 1e-12, "+10pp when the mix shifts toward the group");
  assert.ok(Math.abs(fns.shareDeltaPp(30, 100, 20, 100) + fns.shareDeltaPp(70, 100, 80, 100)) < 1e-12,
    "shares are zero-sum: one group's gain is exactly the rest's loss");
  assert.equal(fns.shareDeltaPp(30, 100, 20, 0), null, "no baseline volume -> null, never a fabricated share");
  assert.equal(fns.shareDeltaPp(30, 0, 20, 100), null, "no live tape -> null");
  // group heat: accel + OI term + share term; share saturates via tanh(Δ/3)
  assert.ok(Math.abs(fns.groupHeatOf(1, 8, 3) - (1 + 0.6 * Math.tanh(1) + 0.4 * Math.tanh(1))) < 1e-12, "all three terms live");
  assert.ok(Math.abs(fns.groupHeatOf(1, null, null) - 1) < 1e-12, "missing flow -> bare accel");
  assert.equal(fns.groupHeatOf(null, 8, 3), null, "no accel, no heat");
  // reclaim phrasing: past 1.0 the percentage form is banned — "through the old high" with the exact overshoot
  assert.equal(fns.bidPhrase({ d: 5.41, r: 1.5, m: 216 }),
    "−5.41% dip fully reclaimed, +2.71% past the old high · ~3.6h since the low",
    "a clamped 1.5 reclaim reads as through-the-high, never as 150%");
  assert.equal(fns.bidPhrase({ d: 7.29, r: 0.72, m: 198 }),
    "72% of −7.29% reclaimed · ~3.3h since the low", "sub-1.0 keeps the percentage form");
  assert.equal(fns.bidPhrase(null), "", "no claim, no phrase");
});

test("action lens manifest: group rendering, name-level bid, share hover, drill routing", () => {
  const fs = require("fs"), path = require("path");
  const app = require("./_client").clientSource();
  for (const pin of [
    "function groupActionScores()", "function groupShareInputs(rows, mode, wt)", "function groupChip(s, kind)",
    "function shareDeltaPp(volNow, volAllNow, volBase, volAllBase)", "function groupHeatOf(accel, doi, dSharePp)",
    "function bidPhrase(b)", "why=bidPhrase(s.bid);",
    "const NB=grouped?pickAction(actionScores().scored):null;",                 // bid never aggregates: name-level even under a lens
    "const grouped=mktGrp()!=='names';",
    "if(state.view!=='markets'){ aw.hidden=true; return; }",                    // the old lens-mode hide is gone — the strip regroups instead
    "0.4*Math.tanh(dSharePp/3)",                                                // the share confirm, pinned
    "share ${s.shNow.toFixed(1)}% vs ${s.shBase.toFixed(1)}% base",             // the numbers spelled out on the chip
    "if(c.dataset.grp) c.addEventListener('click',()=>drillInto(c.dataset.grp));",
    "renderActionLists();   // -05: group heating/cooling + name-level bid render under the lens too",
  ]) assert.ok(app.includes(pin), "app.js pin missing: " + pin);
  assert.ok(!app.includes("if(state.view!=='markets'||mktGrp()!=='names'){ aw.hidden=true; return; }"),
    "the -02 lens-mode hide must stay dead");
  const ht = fs.readFileSync(path.join(__dirname, "..", "public", "index.html"), "utf8");
  assert.ok(ht.includes("share-of-tape replaces RVOL as the volume confirm"), "header title documents the group behavior");
});

test("chip stories: the level-vs-derivative tension said out loud, per quadrant of it (behavioral)", () => {
  const { chipStory } = actionMathFns();
  // heating, red name: the KIOXIA case — buying the hole is a TURN ATTEMPT, not a bug
  const turn = chipStory('heat', -5.3, 2.4, null, false);
  assert.equal(turn.tag, 'turn attempt');
  assert.ok(/still DOWN over the window/.test(turn.text) && /buying this hole/.test(turn.text) && /unproven/i.test(turn.text),
    "a red heater explains itself: down, being bought, early, unproven");
  // heating, green name
  assert.equal(chipStory('heat', 2.1, 1.0, null, false).tag, 'extending');
  // cooling with OI leaving: the ZHIPU case — green AND on the cooling list IS the take-profit print
  const dist = chipStory('cool', 17.7, -7.3, null, false);
  assert.equal(dist.tag, 'distribution');
  assert.ok(/GREEN over the window/.test(dist.text) && /money walking out/.test(dist.text) && /take-profit/.test(dist.text),
    "a green cooler explains the trap: level fine, pace dead, money leaving");
  // cooling with OI holding: digestion, not exit
  assert.equal(chipStory('cool', 3.0, 1.8, null, false).tag, 'pause');
  assert.equal(chipStory('cool', 3.0, null, null, false).tag, 'pause', "no OI data cannot claim distribution");
  // bid variants
  assert.equal(chipStory('bid', null, null, 1.5, false).tag, 'through the high');
  assert.equal(chipStory('bid', null, null, 0.7, false).tag, 'absorbing');
  // group flavor addresses the group, not the name
  assert.ok(/The group is still DOWN/.test(chipStory('heat', -2, 0, null, true).text), "grouped wording");
});

test("backtest single-asset: one pick collapses the cross-section into a timing rule the fixtures can verify", () => {
  const { api, state, restore } = _btHarness();
  try {
    // no picks: the tab is exactly what it was
    assert.equal(api.btMode(), "universe");
    const uni = api.btRun();
    assert.ok(uni.ok && !uni.single && uni.universeN > 8, "universe mode must still run cross-sectionally");
    assert.ok(uni.book && Array.isArray(uni.book.longs), "universe mode still produces a book");

    // one pick: the universe select is superseded, not merged with
    state.backtest.picks = ["NVDA"];
    state.backtest.universe = "sec:Energy";                       // deliberately contradicts the pick
    assert.equal(api.btMode(), "single");
    assert.deepEqual(api.btUniverse().map(r => r.coin), ["NVDA"], "an explicit pick must supersede the universe select");
    const r = api.btRun();
    assert.ok(r.ok && r.single, "one pick must run the single-asset path");
    assert.equal(r.universeN, 1);
    assert.equal(r.pos.length, r.days.length - 1, "one position per forward day");
    assert.ok(r.trades.length > 0, "a trend rule on a trending fixture must take at least one position");

    // buy & hold is the name's own compounding — recomputed here from the raw fixture, not read back
    const m = api.dailyReturns(state.rows.get("NVDA"));
    let hold = 1; for (let i = 1; i < r.days.length; i++) { const v = m.get(r.days[i]); if (v != null && isFinite(v)) hold *= Math.exp(v); }
    assert.ok(Math.abs(hold - r.eqbh[r.eqbh.length - 1]) < 1e-9, "the buy & hold line must equal the name's own compounded returns");

    // the trade log reconciles with the position series: every non-flat run is one round trip
    let runs = 0; for (let i = 0; i < r.pos.length; i++) if (r.pos[i] !== 0 && (i === 0 || r.pos[i] !== r.pos[i - 1])) runs++;
    assert.equal(runs, r.trades.length, "trade log must account for exactly the non-flat runs in the position series");
    assert.ok(r.trades[r.trades.length - 1].live === true || r.curW === 0, "an open position must be marked live in the log");

    // exposure is the share of days holding anything
    const held = r.pos.filter(w => w !== 0).length;
    assert.ok(Math.abs(r.exposure - held / r.pos.length) < 1e-12, "exposure must be the share of days in the market");
    restore();
  } catch (e) { restore(); throw e; }
});

test("backtest single-asset: entry threshold, structure and costs each do what the label says", () => {
  const { api, state, restore } = _btHarness();
  try {
    state.backtest.picks = ["NVDA"];
    // entry: a higher threshold can only keep the rule out of the market more often
    const exposure = {};
    for (const e of [0, 0.5, 1]) { state.backtest.entry = e; const x = api.btRun(); assert.ok(x.ok); exposure[e] = x.exposure; }
    assert.equal(exposure[0], 1, "sign-only entry with a long/short structure is always in the market");
    assert.ok(exposure[0.5] <= exposure[0] && exposure[1] <= exposure[0.5], "a wider entry band must not increase exposure");
    assert.ok(exposure[1] < 1, "±1σ must actually keep the rule flat some of the time");
    state.backtest.entry = 0;

    // structure: long-only never shorts, short-only never longs — on one name as on a book
    state.backtest.structure = "long";
    let x = api.btRun();
    assert.ok(Math.min(...x.pos) >= 0 && Math.max(...x.pos) > 0, "long-only must hold long or flat, never short");
    assert.ok(x.trades.every(t => t.side === "LONG"), "long-only trade log must contain no shorts");
    state.backtest.structure = "short";
    x = api.btRun();
    assert.ok(Math.max(...x.pos) <= 0 && Math.min(...x.pos) < 0, "short-only must hold short or flat, never long");
    state.backtest.structure = "ls";

    // sizing: flat is flat, the other two vary the size (and stay inside the documented cap)
    state.backtest.weighting = "eq";
    const flat = api.btRun();
    assert.deepEqual([...new Set(flat.pos.filter(w => w !== 0).map(Math.abs))], [1], "flat 1× sizing must not vary the size");
    for (const w of ["sig", "vol"]) { state.backtest.weighting = w; const v = api.btRun();
      const sizes = v.pos.filter(z => z !== 0).map(Math.abs);
      assert.ok(new Set(sizes.map(z => z.toFixed(3))).size > 1, `${w} sizing must actually vary the position size`);
      assert.ok(Math.max(...sizes) <= 2 + 1e-9 && Math.min(...sizes) >= 0.25 - 1e-9, `${w} sizing must stay inside the 0.25–2× cap`); }
    state.backtest.weighting = "eq";

    // costs: the fee is charged on every flip, and a costlier run can only end lower
    state.backtest.cost = 0; const free = api.btRun();
    state.backtest.cost = 20; const dear = api.btRun();
    assert.equal(free.feeCum, 0, "a zero-bp run must charge nothing");
    assert.ok(dear.feeCum > 0, "a 20bp run must charge the taker fee");
    assert.ok(dear.eq[dear.eq.length - 1] < free.eq[free.eq.length - 1], "fees must reduce the net curve");
    assert.equal(free.trades.length, dear.trades.length, "cost changes the P&L, never the decisions");
    // funding: a position pays or earns it, and the gross line is deliberately free of it
    assert.ok(free.fundCum !== 0 && free.eqg[free.eqg.length - 1] !== free.eq[free.eq.length - 1],
      "gross must exclude the funding that net includes");
    restore();
  } catch (e) { restore(); throw e; }
});

test("backtest picks: a custom universe stays cross-sectional, and a sector rule refuses a sector it doesn't have", () => {
  const { api, state, restore } = _btHarness();
  try {
    // 2–3 names is not a cross-section: refused with the floor stated, not silently ranked
    state.backtest.picks = ["NVDA", "AMD"];
    assert.equal(api.btMode(), "set");
    const thin = api.btRun();
    assert.ok(!thin.ok && thin.need === 4, "a picked set under the floor must refuse and name the floor");

    // 4+ names runs the ordinary cross-sectional path over exactly those names
    state.backtest.picks = ["NVDA", "AMD", "MU", "XOM"];
    const set = api.btRun();
    assert.ok(set.ok && !set.single, "a picked set of four must run cross-sectionally");
    assert.equal(set.universeN, 4, "the run must see only the picked names");
    assert.ok(set.book && (set.book.longs.length + set.book.shorts.length) > 0, "a picked set still produces a book");

    // a pick that no longer resolves (delisted, history aged out) must not hand the run an empty
    // universe: btUniverse and btMode have to agree about what is under test, always.
    state.backtest.picks = ["GHOST"];        // never existed in state.rows
    assert.equal(api.btMode(), "universe", "an unresolvable pick leaves the tab in universe mode");
    assert.ok(api.btUniverse().length > 8, "an unresolvable pick must fall back to the universe, never to nothing");
    state.rows.get("AMD").delisted = true;   // resolved yesterday, gone today
    state.backtest.picks = ["AMD"];
    assert.equal(api.btMode(), "universe");
    assert.ok(api.btRun().ok, "a pick that stopped resolving must not break the run");
    state.rows.get("AMD").delisted = false;

    // sector-relative momentum on one name needs its peers — and says so when they aren't there
    state.backtest.picks = ["VST"];          // the only utility in the fixture
    state.backtest.signal = "smom";
    const noPeers = api.btRun();
    assert.ok(!noPeers.ok && noPeers.nopeers === "Utilities",
      "sector-relative momentum must refuse rather than quietly degrade to plain momentum");
    state.backtest.picks = ["NVDA"];         // six IT names in the fixture, so the demean is real
    const peers = api.btRun();
    assert.ok(peers.ok && peers.peers >= 3, "with a real sector the demean runs against live peers");
    // the demean changes the answer — otherwise the label would be decorative
    state.backtest.signal = "mom";
    const plain = api.btRun();
    assert.notEqual(peers.eq[peers.eq.length - 1], plain.eq[plain.eq.length - 1],
      "sector-relative momentum must not produce the same curve as plain momentum");
    restore();
  } catch (e) { restore(); throw e; }
});

test("backtest render: the picker is always offered, and one pick disables exactly the controls it invalidates", () => {
  const { api, state, restore } = _btHarness();
  try {
    const universe = api.renderBacktest();
    assert.ok(universe.includes('id="btFind"'), "the target picker must be offered in every mode");
    assert.ok(universe.includes('id="btQ"'), "universe mode keeps the book quantile");
    assert.ok(!universe.includes('id="btEntry"'), "universe mode has no entry threshold — there is a quantile instead");
    assert.ok(universe.includes("bt-book-grid"), "universe mode keeps the long/short book panel");
    assert.ok(!universe.includes("bt-na"), "nothing is disabled when nothing is picked");

    state.backtest.picks = ["NVDA"];
    const single = api.renderBacktest();
    assert.ok(single.includes('id="btEntry"'), "single-asset mode offers the entry threshold");
    assert.ok(!single.includes('id="btQ"'), "single-asset mode drops the book quantile");
    assert.ok(single.includes("bt-na") && /title="[^"]*no rank left to disagree with/.test(single),
      "the rank gate must be dimmed WITH its reason, not silently ignored");
    assert.ok(/superseded by the picked name/.test(single), "the universe select must say the pick won");
    assert.ok(single.includes("bt-ttbl") && !single.includes("bt-book-grid"), "the book panel becomes the trade log");
    assert.ok(single.includes(">pos</text>"), "the curve must carry the position ribbon");
    assert.ok(/buy &amp; hold NVDA/.test(single), "buy & hold of the name must be named in the legend");
    assert.ok(/round trip/.test(single), "the round-trip count must be stated next to the stats");
    assert.ok(/sizing/.test(single) && /flat 1/.test(single), "weighting must re-read as position sizing");

    // several picks: cross-sectional again, with the thin book said out loud
    state.backtest.picks = ["NVDA", "AMD", "MU", "XOM"];
    const set = api.renderBacktest();
    assert.ok(set.includes('id="btQ"') && set.includes("bt-book-grid"), "a picked set is still a cross-section");
    assert.ok(/Thin book/.test(set), "a picked set must state the thin-book arithmetic");
    restore();
  } catch (e) { restore(); throw e; }
});

// ===== build 2026.09.24-97: Backtest target mode — the mock's last pieces ============================
// The 2026.08.22 build shipped the picker, single-asset mode and the custom universe; the mock's ★
// watchlist pill, its "avg trade" row and its universe-mode banner never landed, and the dimmed
// controls' "reason on hover" was dead under pointer-events:none. These run the engine on the same
// fixtures, so the pill's resolve and the row's arithmetic are recomputed here, not read back.
test("backtest target mode (-97): ★ watchlist resolves to this scope's testable stars, avg trade is the mean round trip, the mode is always named", () => {
  const { api, state, restore } = _btHarness();
  try {
    // a star in the other universe, a star with a stub history, a star that never existed, and a
    // delisted star must all sit out; the survivors keep their starring order
    const nv = state.rows.get("NVDA");
    state.rows.set("BTC", Object.assign({}, nv, { coin: "BTC", ticker: "BTC", uni: "main" }));
    state.rows.set("STUB", Object.assign({}, nv, { coin: "STUB", ticker: "STUB", daily: nv.daily.slice(0, 10), dailyFund: nv.dailyFund.slice(0, 10) }));
    state.rows.get("OXY").delisted = true;
    state.watch = new Set(["AMD", "BTC", "STUB", "GHOST", "OXY", "NVDA"]);
    assert.deepEqual(api.btWatchPicks(), ["AMD", "NVDA"], "only in-scope, listed stars with ≥25d of history resolve, in starring order");
    let html = api.renderBacktest();
    assert.ok(/id="btWatchPick"(?! disabled)/.test(html) && /the 2 starred names in this scope/.test(html),
      "the pill is live and says how many stars it will load");
    // the pill's load is exactly the resolved list; two stars is a set under the floor, one is single-asset
    state.backtest.picks = api.btWatchPicks();
    assert.equal(api.btMode(), "set");
    state.watch = new Set(["NVDA"]);
    state.backtest.picks = api.btWatchPicks();
    assert.equal(api.btMode(), "single", "one testable star lands in single-asset mode");
    // crypto scope sees only the crypto star — the Set is shared, the resolve is not
    state.watch = new Set(["AMD", "BTC"]);
    state.scope = "crypto";
    assert.deepEqual(api.btWatchPicks(), ["BTC"], "the watchlist load is scope-local");
    state.scope = "stocks";
    // no qualifying star: the pill is dead with the reason on hover, not hidden
    state.watch = new Set(["BTC", "STUB"]);
    state.backtest.picks = [];
    html = api.renderBacktest();
    assert.ok(/id="btWatchPick" disabled title="no ★ starred name in this scope has the 25d/.test(html),
      "an empty resolve disables the pill and says why");

    // universe mode names itself and points at the picker; the other two modes keep their own banners
    assert.ok(/<b>Universe mode<\/b>/.test(html) && /Pick a name in <b>target<\/b>/.test(html), "universe mode is named");
    assert.ok(!html.includes("bt-na"), "the banner must not dim anything in universe mode");

    // avg trade: the mean of the trade log's own returns (open leg at its mark), rendered signed
    state.backtest.picks = ["NVDA"];
    const r = api.btRun();
    assert.ok(r.ok && r.trades.length > 0);
    const mean = r.trades.reduce((a, t) => a + t.ret, 0) / r.trades.length;
    assert.ok(Math.abs(r.avgTrade - mean) < 1e-15, "avg trade must be the mean round-trip return");
    const single = api.renderBacktest();
    const want = (mean > 0 ? "+" : "") + (mean * 100).toFixed(2) + "%";
    assert.ok(single.includes(">avg trade</span><b class=\"" + (mean >= 0 ? "pos" : "neg") + "\">" + want + "</b>"),
      "the trades box prints avg trade signed, to 2dp, coloured by sign");
    assert.ok(!/<b>Universe mode<\/b>/.test(single) && /Single-asset mode/.test(single), "single mode keeps its own banner");
    // costs move the average trade down, never the decisions
    state.backtest.cost = 0; const free = api.btRun();
    state.backtest.cost = 20; const dear = api.btRun();
    assert.equal(free.trades.length, dear.trades.length);
    assert.ok(dear.avgTrade < free.avgTrade, "a costlier run must have a worse average trade");
    // a universe run carries no avgTrade — the field is single-asset only
    state.backtest.picks = [];
    assert.equal(api.btRun().avgTrade, undefined);
    restore();
  } catch (e) { restore(); throw e; }
});

test("backtest target mode (-97) manifest: the dimmed controls' reason is hoverable, the pill is wired, help and docs say built", () => {
  const fs = require("fs"), path = require("path");
  const root = path.join(__dirname, "..");
  const s = require("./_client").clientSource();
  const css = fs.readFileSync(path.join(root, "public", "styles.css"), "utf8");
  const naRule = css.slice(css.indexOf(".bt-na{"), css.indexOf("}", css.indexOf(".bt-na{")));
  assert.ok(!/pointer-events:none/.test(naRule), "the dimmed wrapper must keep pointer events, or its title never shows");
  assert.ok(css.includes(".bt-na *{pointer-events:none}"), "the controls inside a dimmed group must still be dead");
  assert.ok(s.includes("const wp=el('btWatchPick');") && s.includes("state.backtest.picks=w; drawBacktest();"),
    "the ★ watchlist pill must replace the picks with the resolved stars");
  const help = s.slice(s.indexOf("backtest:`")); const helpBlock = help.slice(0, help.indexOf("report:`"));
  assert.ok(/★ watchlist/.test(helpBlock) && /avg trade/.test(helpBlock), "the tab help documents the pill and the row");
  const mock = fs.readFileSync(path.join(root, "docs", "xyz-monitor-backtest-target-mock.html"), "utf8");
  assert.ok(mock.includes("backtest tab · built") && !mock.includes("backtest tab · proposal"), "the mock is marked built");
  const readme = fs.readFileSync(path.join(root, "README.md"), "utf8");
  assert.ok(readme.includes("**Backtest target mode** (built 2026.08.22, completed in build 2026.09.24-97)"), "README entry");
});

test("backtest single-asset manifest: precedence, no lookahead in the entry scale, scope hygiene, help", () => {
  const fs = require("fs"), path = require("path");
  const s = require("./_client").clientSource();
  const css = fs.readFileSync(path.join(__dirname, "..", "public", "styles.css"), "utf8");
  // picks supersede the universe select — the one precedence rule a fixture can't prove is absent
  assert.ok(s.includes("const pr=btPickRows(); if(pr.length) return pr;"), "picks must short-circuit btUniverse");
  assert.ok(!/if\(state\.backtest\.picks\.length\) return btPickRows\(\)/.test(s),
    "precedence must key on the RESOLVED picks, so btUniverse and btMode can never disagree about what is under test");
  // the entry threshold's σ is measured on PAST scores only: the scale is written before the day's
  // own score joins the accumulator. Reversing those two lines would quietly add lookahead.
  const scale = s.slice(s.indexOf("const scale=new Array(N).fill(NaN);"));
  const body = scale.slice(0, scale.indexOf("\n  const on="));
  assert.ok(body.indexOf("scale[di]=Math.sqrt(q/n)") < body.indexOf("q+=x*x"),
    "the entry scale must be recorded before the current day's score enters it — otherwise it sees its own day");
  assert.ok(s.includes("BT_TRADE_MIN=10"), "the thin-sample flag threshold must exist");
  assert.ok(s.includes("BT_SET_MIN=4"), "the picked-set floor must exist");
  assert.ok(s.includes("const BT_VOLTGT=0.20"), "single-name vol targeting must state its target");
  // a pick belongs to one universe: the scope flip clears it rather than running an empty test
  assert.ok(s.includes("state.backtest.picks=[];   // a backtest target belongs to one universe"),
    "scope flip must clear the picked target");
  // the picker validates against the live universe — free text can never resolve
  assert.ok(s.includes("const r=coin?state.rows.get(coin):null;") && s.includes("if(!r||!inScope(r)) return;"),
    "btAddPick must resolve against live rows only");
  assert.ok(s.includes("dm.size<BT_MIN_DAYS") && s.includes("pushToast("), "a too-short history must be refused out loud");
  // single mode reuses the shared curve, it does not fork one
  assert.ok(s.includes("res.single") && s.includes("btCurveSvg(res,splitIdx)"), "single mode must render through the shared curve");
  assert.ok(css.includes(".bt-na{opacity:") && css.includes(".bt-pick"), "picker + disabled-control styling must ship");
  // the tab's own help documents the mode (this app documents in-app, not in a changelog)
  const help = s.slice(s.indexOf("backtest:`"));
  const helpBlock = help.slice(0, help.indexOf("report:`"));
  assert.ok(/Testing one name/.test(helpBlock) && /position ribbon/.test(helpBlock) && /anecdote/.test(helpBlock),
    "backtest help must document single-asset mode, its curve, and its small-sample honesty");
});
