"use strict";
// server.js — source pins and behaviour outside the HTTP suite. Split out of test.js (build 2026.09.16-80); order within the file is the original order.
const test = require("node:test");
const assert = require("node:assert");
const { classify, playbook, HOUR, DAY, C, twoUserHarness, focusLimits, focusFloorFail, focusGate, FOCUS_HARD_VOL, FOCUS_BELOW_N } = require("./_shared");


test("funding heatmap: it is a tab of its own — nav, route, gate, hash, scope, help", () => {
  const fs = require("fs"), path = require("path");
  const C = require("../src/compute");
  const app = require("./_client").clientSource();
  const html = fs.readFileSync(path.join(__dirname, "..", "public", "index.html"), "utf8");
  const pol = fs.readFileSync(path.join(__dirname, "..", "src", "poller.js"), "utf8");
  const sv = fs.readFileSync(path.join(__dirname, "..", "server.js"), "utf8");
  // It ships in the `tape` group — the market-data menu — and the nav config can still move it.
  // The group KEY is structural; the LABEL is the admin's (this deployment renamed it to "Market
  // Data"), so the assertion keys off `tape` and never off what the ribbon happens to read.
  const tape = C.resolveNavGroups(null).find((g) => g.key === "tape");
  assert.ok(tape.views.includes("funding"), "the tab ships in the market-data menu by default");
  assert.equal(C.resolveNavGroups({ labels: { tape: "Market Data" } }).find((g) => g.key === "tape").views.length,
    tape.views.length, "a renamed menu holds the same tabs — the label is not the identity");
  assert.ok(C.NAV_VIEW_ORDER.includes("funding"), "and in the canonical order, so a move lands it deterministically");
  assert.ok(C.resolveNavGroups({ views: { funding: "macro" } }).find((g) => g.key === "macro").views.includes("funding"),
    "an admin can move it between menus like any other tab");
  // Public by default, and the manifest names the route it owns so gating the tab gates the data.
  assert.equal(C.featureState({}, "funding"), "public");
  assert.deepEqual(C.FEATURES.find((f) => f.key === "funding").routes, ["/api/funding"],
    "the tab's route rides its manifest entry");
  // Its own route, with a SCOPE-PREFIXED validator: both universes stamp dataTs from Date.now()
  // and can collide, which would 304 a crypto request with a cached stocks body.
  assert.ok(sv.includes('fastify.get("/api/funding"'), "the route exists");
  assert.ok(sv.includes('\'W/"\' + scope + "-" + (body.dataTs'), "the funding ETag must be scope-distinct");
  assert.ok(pol.includes("function getFundingHeat(scope)") && pol.includes("getFundingHeat,"),
    "the board is built and exported per universe");
  assert.ok(pol.includes("fundBoardSig[k]") && pol.includes("function fundBoardSigOf(heat)"),
    "the ETag rides a checksum of the whole grid — a reshuffled roster or a bucket filled in by the backfill is a content change even when the row count and the cap are identical");
  assert.ok(/mix\(ax\.t0 \/ 1000\)/.test(pol), "the column axis is part of the checksum — the grid re-cuts as buckets close");
  assert.ok(pol.includes("mix(v == null ? 0x7fffffff"), "a null bucket must hash differently from a real zero, or a hatch filling in would not register");
  // Markup, routing, deep link, palette and help — a tab missing any one of these is stranded.
  assert.ok(html.includes('data-view="funding"') && html.includes('id="view-funding"'), "nav button + view section");
  assert.ok(app.includes("setHidden('view-funding', v!=='funding');"), "showView toggles the section");
  assert.ok(app.includes("if(v==='funding'){ if(el('view-funding')) openFunding();"), "and opens it");
  assert.ok(/HASH_VIEWS=new Set\(\[[^\]]*'funding'/.test(app), "#funding must resolve");
  assert.ok(app.includes("{v:'funding',label:'Funding'}"), "findable in the command palette");
  assert.ok(/\nfunding:`/.test(app), "the tab carries its own help entry");
  // Two slots, one per universe — a scope flip mid-flight must never paint crypto into a stocks view.
  assert.ok(app.includes("funding:{ stocks:{data:null,err:null,ts:0}, crypto:{data:null,err:null,ts:0}, view:null }"),
    "per-universe slots, each carrying its OWN err and ts — held globally, one universe's failure shows under the other");
  assert.ok(app.includes("const _fundingInflight={stocks:false,crypto:false}, _fundingLast={stocks:0,crypto:0};"),
    "inflight and freshness are per-scope, or a stocks fetch swallows the crypto refetch a scope flip asks for");
  assert.ok(app.includes("if(fundingSlot()!==k && state.view==='funding') loadFunding();"),
    "a flip that lands mid-flight must still fetch the universe now on screen");
  assert.ok(app.includes("return !state.funding[k].data || Date.now()-_fundingLast[k]>60*1000;"),
    "an empty slot always fetches — a recent load of the OTHER universe must not gate it");
  assert.ok(app.includes("if(fh.buildError){"), "a failing server-side build is named, never dressed as a warm-up");
  assert.ok(app.includes("if(state.view==='funding'){ syncFundingSlot(); renderFunding(); loadFunding(); }"),
    "a scope flip repaints from the new universe's slot before refetching");
  // And it is GONE from the Sessions tab — one study, one home.
  assert.ok(!app.includes("sections.fundHeat") && !app.includes("fhBlock"),
    "the sessions tab must not still render the board");
});

test("ledger export: raw completeness, shadow/legacy accounting, self-describing meta, route wiring", () => {
  const { createPoller } = require("../src/poller");
  const now = Date.now();
  const fixture = { ts: now, rearm: [], variants: null,
    open: [
      { key: "xyz:AAPL|breakout", coin: "xyz:AAPL", ticker: "AAPL", ev: "breakout", t0: now - 3600000,
        mark0: 200, dir: 1, score0: 61, sd0: 1.8, resolveAt: now + 86400000, psd: "long" },
    ],
    closed: [
      // real resolved claim — raw shape must survive intact (key included; pub() would drop it)
      { key: "xyz:AAPL|breakdown", coin: "xyz:AAPL", ticker: "AAPL", ev: "breakdown", t0: now - 5 * 86400000,
        mark0: 210, dir: -1, score0: 55, sd0: 2.2, status: "resolved", tR: now - 86400000,
        realized: -2, realizedS: -2, rn: 1, win: false, winS: false, psd: "short" },
      // shadow variant — getLedgerFor hides it; the export MUST include and count it
      { key: "xyz:AAPL|bigmove#1", coin: "xyz:AAPL", ticker: "AAPL", ev: "bigmove", t0: now - 4 * 86400000,
        mark0: 205, dir: 1, score0: 0, sd0: 1.8, status: "resolved", tR: now - 3 * 86400000,
        realized: 0.4, vi: 1 },
      // legacy pre-sigma entry (R-united event, no sd0) — included and counted as legacy
      { key: "xyz:AAPL|breakdown#old", coin: "xyz:AAPL", ticker: "AAPL", ev: "breakdown", t0: now - 40 * 86400000,
        mark0: 250, dir: -1, score0: 40, status: "resolved", tR: now - 35 * 86400000,
        realized: 3.1, realizedS: 3.1, win: true, winS: true },
    ] };
  const store = { loadAll: () => new Map(), loadRegime: () => [], loadLedger: () => fixture,
    saveLedger: () => {}, insert: () => {}, saveRegime: () => {} };
  const p = createPoller({ dex: "xyz", store, log: () => {}, version: "test", crypto: false });
  p.hydrateLedgerNow();
  const x = p.getLedgerExport(true);
  assert.equal(x.meta.counts.closed, 3, "every retained closed entry ships — no 150 cap, no shadow pruning");
  assert.equal(x.meta.counts.open, 1);
  assert.equal(x.meta.counts.shadowsClosed, 1, "shadow variants counted");
  assert.equal(x.meta.counts.legacyClosed, 1, "pre-sigma legacy entries counted");
  assert.equal(x.meta.ctxStampSince, null, "no context-stamped entries yet -> honest null, not a fake epoch");
  assert.ok(x.closed.some(e => e.vi === 1), "shadow entry present in the dump");
  assert.ok(x.closed.every(e => typeof e.key === "string"), "raw internal shape — key survives (curated pub drops it)");
  assert.ok(x.variants && x.variants.state && typeof x.variants.stats === "object", "variant state + stats ship for the variant slices");
  for (const k of ["ev", "vi", "sd0", "stp", "realizedS", "fndP", "rngP", "mktR", "ses", "tal", "vr", "ib", "amb"])
    assert.ok(typeof x.meta.glossary[k] === "string" && x.meta.glossary[k].length, `glossary documents ${k}`);
  // route wiring: download header + no-store are pinned in server source (the manifest test
  // already pins the registration itself and the getLedgerExport getter's existence)
  const fs = require("fs"), path = require("path");
  const srv = fs.readFileSync(path.join(__dirname, "..", "server.js"), "utf8");
  assert.ok(srv.includes('attachment; filename="xyz-ledger-'), "export route serves as a dated download");
});

test("news feed: merge purity, payload badge stamps, full wiring chain", () => {
  const C = require("../src/compute");
  const now = Date.now(), H = 3600 * 1000;
  const mk = (id, tk, agoH, h) => ({ id, tk, h: h || ("headline " + id), src: "src", url: "https://x/" + id, pub: now - agoH * H });
  // dedupe: incoming wins (sources correct headlines)
  let m = C.mergeNews([mk(1, "AAPL", 5, "old wording")], [mk(1, "AAPL", 5, "corrected wording")], now);
  assert.equal(m.length, 1); assert.equal(m[0].h, "corrected wording");
  // eviction on PUBLISH time — a stale article in the store dies even with no incoming
  m = C.mergeNews([mk(2, "AAPL", 80), mk(3, "AAPL", 5)], [], now);
  assert.deepEqual(m.map((a) => a.id), [3], "72h publish-time eviction, late fetch earns no bonus lifetime");
  // future-dated garbage rejected, order newest-first
  m = C.mergeNews([], [mk(4, null, -9, "from the future"), mk(5, "WDC", 2), mk(6, "WDC", 1)], now);
  assert.deepEqual(m.map((a) => a.id), [6, 5], "future pub rejected; newest first");
  // per-ticker cap 10, tape lane wider
  const many = []; for (let i = 0; i < 15; i++) many.push(mk(100 + i, "NVDA", i * 0.1));
  for (let i = 0; i < 15; i++) many.push(mk(200 + i, null, i * 0.1));
  m = C.mergeNews([], many, now);
  assert.equal(m.filter((a) => a.tk === "NVDA").length, 10, "per-name cap");
  assert.equal(m.filter((a) => !a.tk).length, 15, "tape lane is wider than any single name");
  // payload: coin + badge stamps ride server-side (harness, zero network)
  const { createPoller } = require("../src/poller");
  const store = { loadAll: () => new Map(), loadRegime: () => [], loadLedger: () => null,
    saveLedger: () => {}, insert: () => {}, saveRegime: () => {}, saveNews: () => {}, loadNews: () => null };
  const p = createPoller({ dex: "xyz", store, log: () => {}, version: "test", crypto: false });
  p.seedRowNow("xyz:WDC", { px: 500, ticker: "WDC", uni: "xyz" });
  const pay = p.newsIngestNow([mk(9, "WDC", 1, "WDC raises Q1 guidance"), mk(10, null, 2)]);
  assert.equal(pay.count, 2);
  const wdc = pay.items.find((a) => a.id === 9);
  assert.equal(wdc.coin, "xyz:WDC", "equity headlines carry the drawer deep-link coin");
  assert.ok(!pay.items.find((a) => a.id === 10).coin, "tape items carry no coin");
  assert.equal(pay.ttlHours, 72);
  // wiring pins: worker, route fallback, client tab + drawer slice + badge semantics
  const fs = require("fs"), path = require("path");
  const pol = fs.readFileSync(path.join(__dirname, "..", "src", "poller.js"), "utf8");
  for (const pin of ["finnhub.io/api/v1/company-news", "finnhub.io/api/v1/news?category=general",
    "const NEWS_BATCH = 3", "buildNewsPayload();   // sig/ed badge stamps ride the signals cadence",
    "FINNHUB_TOKEN not set", "store.saveNews({ ts: now, items: newsItems, secTape, secLearned, nameLearned })"])
    assert.ok(pol.includes(pin), `news worker pin missing: ${pin}`);
  const srv = fs.readFileSync(path.join(__dirname, "..", "server.js"), "utf8");
  assert.ok(srv.includes('error: "not fetched yet"') && srv.split('fastify.get("/api/news"').length - 1 === 1, "route registered once with an honest fallback");
  const app = require("./_client").clientSource();
  for (const pin of ["function renderNews()", "function fillDrawerNews()", "function newsRow(",
    "id=\"dnews\"", "all ${esc(r.ticker)} news", "headlines in the last 72h",
    "if(v==='news'){ if(el('view-news')) openNews();", "nbadge${a.sig?' sig':(a.ed!=null?' earn':'')}"])
    assert.ok(app.includes(pin), `news client pin missing: ${pin}`);
  const html = fs.readFileSync(path.join(__dirname, "..", "public", "index.html"), "utf8");
  assert.ok(html.includes('data-view="news"') && html.includes('id="view-news"') && html.includes('id="news-body"'), "tab + view section in the markup");
  const css = fs.readFileSync(path.join(__dirname, "..", "public", "styles.css"), "utf8");
  for (const cls of [".nrow{", ".nbadge.earn{", ".nbadge.sig{", ".nbadge.tape{"])
    assert.ok(css.includes(cls), `news css missing: ${cls}`);
  const st = fs.readFileSync(path.join(__dirname, "..", "src", "store.js"), "utf8");
  assert.ok(st.includes("saveNews(data)") && st.includes("loadNews()"), "warm-cache persistence wired");
});

test("version-stamped shell: index served explicitly with ?v=BUILD asset tags, static index off", () => {
  const fs = require("fs"), path = require("path");
  const srv = fs.readFileSync(path.join(__dirname, "..", "server.js"), "utf8");
  for (const pin of ['index: false,', 'src="/app.js?v=${VERSION}"', 'href="/styles.css?v=${VERSION}"',
    'fastify.get("/", serveIndex);', 'fastify.get("/index.html", serveIndex);',
    'reply.header("cache-control", "no-store").type("text/html', "WARN: index.html asset tags drifted"])
    assert.ok(srv.includes(pin), `stamped-shell pin missing: ${pin}`);
  // and the tags in the source markup stay in the exact form the stamper rewrites — if this
  // fails, the boot-time drift warning would fire and cache-busting silently degrades
  const html = fs.readFileSync(path.join(__dirname, "..", "public", "index.html"), "utf8");
  assert.ok(html.includes('src="/app.js"') && html.includes('href="/styles.css"'),
    "index.html asset tags must match the stamper's expected form exactly");
});

test("telegram feed: parser + drift, lane caps, single-name attribution through the real pipeline, channel management", () => {
  const C = require("../src/compute");
  // parser: entities decoded, media-only blocks skipped, permalinks built
  const mkMsg = (ch, id, txt, iso) => `<div class="tgme_widget_message_wrap"><div data-post="${ch}/${id}">`
    + (txt ? `<div class="tgme_widget_message_text js-message_text">${txt}</div>` : "")
    + `<time datetime="${iso}"></time></div></div>`;
  const iso = new Date(Date.now() - 3600e3).toISOString();
  const html = mkMsg("chanA", 1, "MicroStrategy announces expanded buyback &amp; guidance at &#36;118", iso)
    + mkMsg("chanA", 2, null, iso)   // sticker/media-only
    + mkMsg("chanA", 3, "NVDA and AMD both ripping after the Azure news", iso)
    + mkMsg("chanA", 4, "Spain wins the World Cup", iso)
    + mkMsg("chanA", 5, "MicroStrategy adds 2,100 BTC to the stack", iso);   // names TWO universe assets
  const pr = C.parseTgPreview(html, "chanA", Date.now());
  assert.equal(pr.blocks, 5); assert.equal(pr.items.length, 4, "media-only block skipped");
  assert.equal(pr.items[0].id, "tg:chanA:1");
  assert.ok(pr.items[0].h.includes("& guidance at $118"), "entities decoded");
  assert.equal(pr.items[0].url, "https://t.me/chanA/1");
  assert.ok(pr.items.every((a) => a.tg === 1));
  // drift: blocks present, nothing parseable
  const drift = C.parseTgPreview('<div class="tgme_widget_message_wrap"><div>changed markup</div></div>', "x", Date.now());
  assert.equal(drift.items.length, 0); assert.equal(drift.blocks, 1, "drift is distinguishable from an empty channel");
  // merge: telegram rides its own lane — can't evict the wire, wire can't evict it
  const now = Date.now();
  const many = [];
  for (let i = 0; i < 90; i++) many.push({ id: "tg:c:" + i, tk: null, tg: 1, h: "tg " + i, src: "t.me/c", url: "u", pub: now - i * 60e3 });
  for (let i = 0; i < 10; i++) many.push({ id: "w" + i, tk: null, h: "wire " + i, src: "s", url: "u", pub: now - i * 60e3 });
  const m = C.mergeNews([], many, now);
  assert.equal(m.filter((a) => a.tg).length, 80, "telegram lane capped at its own width");
  assert.equal(m.filter((a) => !a.tg).length, 10, "the wire survives a chatty channel intact");
  // end-to-end through the REAL pipeline: parse -> attribute -> merge -> payload lanes
  const { createPoller } = require("../src/poller");
  const store = { loadAll: () => new Map(), loadRegime: () => [], loadLedger: () => null,
    saveLedger: () => {}, insert: () => {}, saveRegime: () => {}, saveNews: () => {}, loadNews: () => null,
    saveTgChannels: () => {}, loadTgChannels: () => null };
  const pl = createPoller({ dex: "xyz", store, log: () => {}, version: "test", crypto: false });
  pl.seedRowNow("xyz:MSTR", { px: 300, ticker: "MSTR", uni: "xyz" });
  pl.seedRowNow("xyz:NVDA", { px: 180, ticker: "NVDA", uni: "xyz" });
  pl.seedRowNow("xyz:AMD", { px: 160, ticker: "AMD", uni: "xyz" });
  pl.seedRowNow("BTC", { px: 100000, ticker: "BTC", uni: "main" });
  const pay = pl.tgIngestNow(html, "chanA");
  const by = Object.fromEntries(pay.items.map((a) => [a.id, a]));
  assert.equal(by["tg:chanA:1"].tk, "MSTR", "single-name match attributes — alias hit");
  assert.equal(by["tg:chanA:1"].coin, "xyz:MSTR", "and deep-links to the drawer");
  assert.equal(by["tg:chanA:1"].sec, "Information Technology", "sector rides the attribution");
  assert.equal(by["tg:chanA:3"].tk, null, "two-name post attributes to NEITHER — no leak");
  assert.equal(by["tg:chanA:4"].tk, null, "no-name post stays tape");
  assert.equal(by["tg:chanA:5"].tk, "MSTR",
    "crypto symbols are OUT of the telegram roster by policy — 'MicroStrategy adds BTC' now has exactly one universe match and attributes to MSTR, the name it's actually about");
  assert.ok(!pay.items.some((a) => a.tg && a.tk === "BTC"), "no telegram post ever wears a crypto ticker");
  assert.ok(pay.items.filter((a) => a.tg).length === 4, "tg marker survives to the payload");
  // channel management: normalization, validation, cap, dedupe
  assert.deepEqual(pl.setTgChannels(["@WatcherGuru", "https://t.me/s/markettwits", "watcherguru"]).channels,
    ["WatcherGuru", "markettwits"], "@ and t.me prefixes stripped, case-insensitive dedupe");
  assert.equal(pl.setTgChannels(["bad name!"]).ok, false, "invalid usernames rejected");
  assert.equal(pl.setTgChannels(Array.from({ length: 13 }, (_, i) => "chan" + (1000 + i))).ok, false, "cap enforced");
  assert.ok(pl.getTgChannels().channels.length === 2, "list state reflects the last valid save");
  // parser identity gate: a typo'd username landing on ANOTHER channel's page injects nothing
  const foreign = mkMsg("SomeOtherChannel", 77, "junk that should never enter the feed", iso);
  const fr = C.parseTgPreview(foreign, "mistyped_chan", Date.now());
  assert.equal(fr.items.length, 0, "posts from a channel we didn't ask for are rejected at parse — redirects and typos can't inject");
  assert.equal(fr.blocks, 1, "…and it still counts as blocks, so drift detection keeps working");
  // removal purges posts, not just config: junk from a bad channel dies at ✕, not at 72h
  pl.setTgChannels(["chanA", "chanB"]);
  pl.tgIngestNow(html, "chanA");   // re-ingest: the WatcherGuru config assert above already (correctly) purged chanA
  pl.tgIngestNow(mkMsg("chanB", 501, "post from the channel about to be removed", iso), "chanB");
  assert.ok(pl.getNews().items.some((a) => a.id === "tg:chanB:501"), "chanB post in the feed while configured");
  pl.newsIngestNow([{ id: 900, tk: null, h: "a wire headline", src: "s", url: "u", pub: Date.now() - 3600e3 }]);
  const res = pl.setTgChannels(["chanA"]);
  assert.ok(res.purged >= 1, "removal reports the purge");
  const after = pl.getNews().items;
  assert.ok(!after.some((a) => a.id === "tg:chanB:501"), "the removed channel's posts leave the feed IMMEDIATELY");
  assert.ok(after.some((a) => a.id === "tg:chanA:1"), "the surviving channel's posts stay");
  assert.ok(after.some((a) => !a.tg), "non-telegram items untouched");
  // wiring pins
  const fs = require("fs"), path = require("path");
  const srv = fs.readFileSync(path.join(__dirname, "..", "server.js"), "utf8");
  assert.equal(srv.split('fastify.post("/api/news/channels"').length - 1, 1, "POST channels registered exactly once");
  const pol = fs.readFileSync(path.join(__dirname, "..", "src", "poller.js"), "utf8");
  for (const pin of ["markup drift: page fetched, nothing parsed", "store.saveTgChannels({ ts: Date.now(), channels: tgChannels })",
    "telegram: { channels: tgChannels.length", "function purgeTgOrphans()",
    "cached posts from since-removed channels die at hydrate", 'r.uni !== "xyz") continue;'])
    assert.ok(pol.includes(pin), `tg pin missing: ${pin}`);
  const app = require("./_client").clientSource();
  for (const pin of ["'telegram'?!!a.tg", "id=\"ntg-gear\"", "function loadTgChannels()", "function saveTgChannels(", "data-rmch"])
    assert.ok(app.includes(pin), `tg client pin missing: ${pin}`);
  const st = fs.readFileSync(path.join(__dirname, "..", "src", "store.js"), "utf8");
  assert.ok(st.includes("saveTgChannels(data)") && st.includes("loadTgChannels()"), "config persistence separate from the news cache");
});

test("earnings: back-window reconciliation mirrors the feed's current claim, never touches deep history", () => {
  const { reconcileEarnPrints, parseEarningsCalendar } = require("../src/compute");
  const now = Date.UTC(2026, 6, 16, 16, 0);   // Thu Jul 16 noon ET
  const prints = [
    { coin: "xyz:IBM", t: "IBM", d: "2026-07-14", s: "BMO", eps: 3.05, epsA: 2.93 },   // phantom: feed no longer lists it ANYWHERE
    { coin: "xyz:NFLX", t: "NFLX", d: "2026-07-15", s: "AMC", eps: 0.8042, epsA: 0.8 }, // real: feed still serves the back-window row
    { coin: "xyz:GOOGL", t: "GOOGL", d: "2026-04-24", s: "AMC", eps: 2.1, epsA: 2.3 },  // deep history: outside the back window, untouchable
    { coin: "xyz:TSLA", t: "TSLA", d: "2026-07-22", s: "AMC", eps: 0.51 },              // future-dated record: not reconciliation's business
  ];
  const parsed = [
    { coin: "xyz:NFLX", t: "NFLX", d: "2026-07-15", s: "AMC", eps: 0.8042, epsA: 0.8 },
    { coin: "xyz:TSLA", t: "TSLA", d: "2026-07-22", s: "AMC", eps: 0.51 },
  ];
  const out = reconcileEarnPrints(prints, parsed, now);
  assert.deepEqual(out.map((p) => p.t).sort(), ["GOOGL", "NFLX", "TSLA"],
    "back-window phantom dropped; back-window real, deep history and future records kept");
  assert.equal(reconcileEarnPrints(prints, [], now).length, prints.length,
    "an empty parse is a broken fetch, not evidence — purges nothing");
  assert.equal(reconcileEarnPrints(prints, parsed, now, 1).length, 4,
    "IBM at diff -2 is outside a 1-day back window — untouched when not refetched");
  // the NFLX display regression, at the parser: 2dp quantization collapsed a real -0.5% miss
  // into "0.8 vs 0.8" — 4dp must preserve the margin the verdict is computed from
  const symMap = new Map([["NFLX", { coin: "xyz:NFLX", ticker: "NFLX" }]]);
  const p = parseEarningsCalendar({ earningsCalendar: [
    { symbol: "NFLX", date: "2026-07-16", hour: "amc", epsEstimate: 0.8042, epsActual: 0.8, quarter: 2, year: 2026 },
  ] }, symMap);
  assert.equal(p[0].eps, 0.8042, "estimate margin preserved at 4dp");
  assert.equal(p[0].epsA, 0.8);
  assert.ok(p[0].epsA < p[0].eps, "the verdict-bearing inequality survives quantization");
  // wiring pins: tombstones filter at the pipe mouth AND the post-merge choke point, the void
  // function exists and is exported, the route is registered, and the client carries the control.
  const fs = require("fs"), path = require("path");
  const pol = fs.readFileSync(path.join(__dirname, "..", "src", "poller.js"), "utf8");
  assert.ok(pol.includes("parsed = parsed.filter((e) => !earnVoids.has(e.t"), "tombstones filter the fresh parse");
  assert.ok(pol.includes("earnPrints = earnPrints.filter((p) => !earnVoids.has(p.t"), "tombstones filter the merged prints (choke point)");
  assert.ok(pol.includes("function voidEarnPrint(") && pol.includes("voidEarnPrint,"), "void function defined and exported");
  assert.ok(pol.indexOf("reconcileEarnPrints(earnPrints, parsed") < pol.indexOf("purgeStalePrints(earnPrints, parsed"), "reconcile runs before the reschedule purge");
  assert.ok(pol.includes("voids: [...earnVoids]"), "tombstones persist to the volume");
  const srv = fs.readFileSync(path.join(__dirname, "..", "server.js"), "utf8");
  assert.equal(srv.split('fastify.post("/api/earnings/void"').length - 1, 1, "void route registered exactly once");
  const app = require("./_client").clientSource();
  for (const frag of ["earn-void", "/api/earnings/void", "in line"])
    assert.ok(app.includes(frag), `missing client void/verdict marker: ${frag}`);
});

test("earnings: recently-reported window keeps the two prior ET days, drops today and older, sorts most-recent first", () => {
  const { recentEarnPrints } = require("../src/compute");
  const noon = Date.UTC(2026, 6, 16, 16, 0);   // 12:00 ET, Thu Jul 16
  const prints = [
    { coin: "xyz:AAA", t: "AAA", d: "2026-07-16", s: "BMO", eps: 1, epsA: 1.1 },   // TODAY -> lives in entries, not here
    { coin: "xyz:BBB", t: "BBB", d: "2026-07-15", s: "AMC", eps: 2, epsA: 2.2 },   // yesterday -> kept
    { coin: "xyz:CCC", t: "CCC", d: "2026-07-15", s: "BMO", eps: 3, epsA: 2.9 },   // yesterday -> kept
    { coin: "xyz:DDD", t: "DDD", d: "2026-07-14", s: "AMC", eps: 4, epsA: null },  // 2 days ago, actual pending -> kept, never fabricated
    { coin: "xyz:EEE", t: "EEE", d: "2026-07-13", s: "BMO", eps: 5, epsA: 5.5 },   // 3 days ago -> outside the window
    { coin: "xyz:FFF", t: "FFF", d: "2026-07-20", s: "BMO", eps: 6 },              // upcoming -> never here
    null, { t: "GGG" },                                                             // garbage tolerated
  ];
  const out = recentEarnPrints(prints, noon);
  assert.deepEqual(out.map((p) => p.t), ["CCC", "BBB", "DDD"],
    "diff -1 and -2 only; most recent day first; BMO before AMC within a day");
  assert.equal(out[2].epsA, null, "pending actual ships as null, never zeroed");
  assert.equal(out[0].epsA, 2.9, "actuals ride through untouched");
  // The ET-day trap this window inherits: at 22:00 ET Wed it is already Thursday in UTC — a
  // Wednesday print must read diff 0 (still today, still in entries), NOT roll into recent early.
  const lateWed = Date.UTC(2026, 6, 16, 2, 0);   // 22:00 ET Wed Jul 15
  assert.deepEqual(recentEarnPrints([{ coin: "xyz:BBB", t: "BBB", d: "2026-07-15", s: "AMC" }], lateWed), [],
    "a print reported tonight stays out of the reported window until the ET day actually rolls");
  assert.deepEqual(recentEarnPrints(null, noon), [], "no prints -> empty, not a throw");
  // wiring pins — the reported window is derived in BOTH poller paths (fetch + hydrate), the
  // route fallback declares the field, and the client renders/merges it. A silent deletion of
  // any link in that chain must be a suite failure, not a blank section discovered by eye.
  const fs = require("fs"), path = require("path");
  const pol = fs.readFileSync(path.join(__dirname, "..", "src", "poller.js"), "utf8");
  assert.ok((pol.match(/recentEarnPrints\(earnPrints/g) || []).length >= 2, "poller derives recent in fetch AND hydrate paths");
  assert.ok(pol.includes("p.epsA != null ? \"a\" : \"\""), "ETag signature covers recent actuals");
  const srv = fs.readFileSync(path.join(__dirname, "..", "server.js"), "utf8");
  assert.ok(srv.includes("recent: []"), "/api/earnings fallback declares the recent field");
});

test("client integrity manifest: app.js contains every load-bearing symbol, exactly once", () => {
  // Regression guard for the build that shipped a gutted app.js: a bad splice replaced ~1,600
  // lines and still passed node --check (valid JS) and this suite (which never read the client).
  // This test makes structural damage to the client a suite failure.
  const fs = require("fs"), path = require("path");
  const s = require("./_client").clientSource();
  assert.ok(s.length > 250000, `app.js suspiciously small: ${s.length} bytes`);
  const defs = {};
  for (const m of s.matchAll(/^(?:async )?function ([A-Za-z0-9_]+)\(/gm)) defs[m[1]] = (defs[m[1]] || 0) + 1;
  const need = ["closeDetail", "showView", "openDetail", "renderSignals", "sigCardHtml", "sigRowHtml",
    "trigChip", "playRow", "rrChip", "recCurveSvg", "openHelp", "closeHelp",
    "openSigHistory", "runSigHist", "loadSigHistory", "sigHistRow", "loadDrawerLedger",
    "ddCell", "ddyCell", "openCell", "dopenCell", "computeMomentum", "computeSqueeze", "fmtTrig", "fmtAge",
    "vsTapeCell", "dcapCell", "hitCell", "rvolCell",
    "loadEarnings", "renderEarnings", "openEarnings", "earnBadge", "earnNext", "earnRecentList", "earnReactHtml", "epsSurStr", "epsPairFmt", "epsFmt", "wireEarnVoid",
    "openInsiders", "insRender", "insBind", "insCols", "insSave", "insLoad", "insPager", "insUsd", "termInsiders", "termEarnBackfill", "insTitleShort", "insRoleCell", "insPairs", "insPairStory", "insRangeFor", "insRangeLabel",
    "macroStateC", "macroList", "macroNextC", "macroRecentC", "macroTimeLbl", "macroRangeFmt",
    "macroStatFmt", "macroMonthLbl", "macroValHtml", "macroRowHtml", "renderMacroStrip", "macroDayLbl", "wireMacroStrip",
    "applyTabOrder", "saveTabOrder", "wireTabDrag",
    "openTrendChart", "closeTrendChart", "loadTrendChart", "renderTrendChart", "tcCandleSvg", "tcEmaSeries",
    "updateFocusChip", "applyKsel", "kmoveSel", "applyMobileCols",
    "openCmdk", "closeCmdk", "cmdkRender", "cmdkActivate", "aiFmtCountdown", "aiFmtAgo", "aiTickCountdown",
    "updateFreshTray", "renderFreshTray",
    "termRun", "termExec", "nlResolve", "termScreen", "termTop", "termSignals", "termCorr", "termDiverge", "termCard", "termOpen", "termClose",
    "termBreadth", "termSectors", "termCompare", "termEarnCal", "termNewsCmd", "termReports", "termTickerish", "nlTickers", "termWin", "termAgo", "termAutoGrow", "termAdminUnlock", "termAdminLock", "termSetLock", "termRefreshLock",
    "renderRegime", "regimeCurveSvg", "wireRegimeControls",
    "drawSessions", "sgOpenSet", "sgToggle", "sgPendRow", "sgSection", "wireSessGroups",
    "sigSecOpen", "sigSecToggle", "sigSec",
    "liveMark", "claimDelta", "brkBar", "nowChip",
    "syncAnalyticsSlot", "_szTz", "_szCash",
    "alignedDailyN", "openCompg", "renderCompg", "compgSeries", "compgSvg", "compgLegend", "compgWireChart", "termComp",
    "renderCorrCrypto", "paintCorr", "alignedIntraday", "corrRet", "corrOvUnit", "syncCorrLookback",
    "compgAligned", "compgTickLabel", "compgHoverLabel",
    "cascCell", "liq24Cell", "loadDrawerDerivs", "renderDerivs", "dzWire",
    "loadDrawerFund", "renderFund",
    "compgUniverse", "compgDefaultSel", "compgAddName", "compgPickerHtml", "compgWirePicker", "compgAuto",
    "dailyLevels", "dailyOI", "btMomVariant",
    "mompCell", "renderDuelSection", "duelSvg", "duelDivergence", "loadDuelData", "duelRoll", "colAdjacent",
    "loadActionable", "openActionable", "renderActionable", "actHead", "actDetail", "actCmp", "actCell", "actRR", "actEV",
    "actLate", "actLateCls", "actAgo", "actSortLoad", "actSortSave",
    "actSettled", "actEpDetail", "actSettledWire", "actSetPct", "actSetR", "actSetDays",
    "termHistPush", "termCausal",
    "loadTriggers", "fireTrigger", "pushTrigToast", "trigEligibleClient", "trigSeqGet", "trigSeqSet",
    "fireOps", "fireLedger", "loadPush", "buildPushSection", "pushAct", "pushCodeLeft",
    "alertText", "alertUnread", "alertMarkRead", "loadRules", "ruleAct", "trendWhenTxt"];
  for (const n of need) {
    assert.ok(defs[n] >= 1, `missing client function: ${n}`);
    assert.equal(defs[n], 1, `duplicate client function: ${n}`);
  }
  for (const frag of ["const HELP={", "const SHOW_CLAIM_CURVE", "conflWith", "claim0", "presentSince|sighist-ev", "/api/earnings", "eb0", "earnSplit", "d.recent||", "REPORTED \\u00b7",
    "macrostrip", "MACRO \\u00b7 REPORTED", "act-mwarn", "mrow", "d.macroErr", "tabdot",
    "nxt.diff<=2", "mn.diff<=2", "FOMC meeting begins",
    "krow", "state.focus", "/api/derivs", "MAIN_ONLY_COLS", "dderivs",
    "/api/fundamentals", "id=\"dfund\"", "fnrange", "fnread", "fnbar",
    "key:'momp'", "/api/duel", "momentum2:", "r.momWhy",
    "c.structLevels", "detected structural level(s) drawn faint"]) {
    const ok = frag.includes("|") ? frag.split("|").some((f) => s.includes(f)) : s.includes(frag);
    assert.ok(ok, `missing client feature marker: ${frag}`);
  }
  // Labels are labels: a tooltip sentence welded onto EV_LABELS broke every chip and table
  // row once. Each label must stay a short display string.
  const lm = s.match(/const EV_LABELS=\{[^\n]*\}/);
  assert.ok(lm, "EV_LABELS missing");
  for (const em of lm[0].matchAll(/:'([^']*)'/g))
    assert.ok(em[1].length <= 32, `EV_LABELS entry too long to be a label: "${em[1].slice(0, 48)}..."`);
  const html = fs.readFileSync(path.join(__dirname, "..", "public", "index.html"), "utf8");
  // Help must cover every tab, including the two newest (report, news) — a fallback to HELP.markets
  // silently showed the wrong help on those tabs before this was pinned.
  for (const k of ["markets:`", "trend:`", "sectors:`", "corr:`", "sessions:`", "signals:`", "earnings:`", "backtest:`", "report:`", "news:`", "actionable:`"])
    assert.ok(s.includes(k), `HELP is missing an entry for a tab: ${k}`);
  // Command palette + freshness tray load-bearing markers.
  assert.ok(s.includes("CMDK_TABS") && s.includes("metaKey||e.ctrlKey") && s.includes("cmdk-q"), "command palette wiring missing");
  assert.ok(s.includes("FRESH_SOURCES") && s.includes("/api/health"), "freshness tray wiring missing");
  assert.ok(s.includes("setInterval(aiTickCountdown,1000)"), "report cooldown live ticker missing");
  // Ask-the-board terminal: tiered resolution (grammar → local NL → AI stub), live-data field map, launcher.
  assert.ok(s.includes("TFIELD") && s.includes("termAprOf"), "terminal live-field accessors missing");
  assert.ok(s.includes("function nlResolve") && s.includes("Tier 2"), "terminal NL intent layer missing");
  assert.ok(s.includes("function termAsk") && s.includes("/api/ask"), "terminal AI-fallback client call missing");
  assert.ok(s.includes("termCompactUniverse") && s.includes("termThinking"), "terminal AI-fallback plumbing missing");
  assert.ok(/if\(termGrammarComplete\(p\)\)/.test(s) && s.includes("nlResolve(line)"), "terminal routing (grammar→NL→AI) missing");
  assert.ok(s.includes("function termGrammarComplete") && s.includes("function metricOf") && s.includes("function termEarnings"), "terminal NL-overhaul helpers missing");
  assert.ok(s.includes("function nlResolve") && /return null;\s*\/\/ a ticker plus intent we don't understand/.test(s), "nlResolve must escalate (return null) on unresolved ticker intent, not degrade to a card");
  // NL library v2: stopword-guarded ticker detection wired into nlResolve — the fix for
  // confident-but-wrong cards ("what's on the tape" must never resolve to the ON card).
  assert.ok(s.includes("const TSTOP=new Set(") && s.includes("nlTickers(rawWords)"), "guarded ticker detection not wired into nlResolve");
  // every board column callable: computed lenses + windows + any-field top/bottom
  for (const pin of ["vsma200:", "vsyopen:", "vsvwap:{", "rvol:{", "d7:{", "metricOf(metric)||tfield(metric)", "function termWin"])
    assert.ok(s.includes(pin), `full-field terminal coverage missing: ${pin}`);
  // new whole-board verbs routed in termExec
  for (const pin of ["h==='breadth'", "h==='sectors'", "h==='reports'", "h==='vs'||h==='compare'", "h==='comp'", "h==='top'||h==='bottom'", "termEarnCal(a1||'today')"])
    assert.ok(s.includes(pin), `terminal verb routing missing: ${pin}`);
  // COMP/G N-name comparison: launcher wiring, the union-day aligner, and the two render modes.
  assert.ok(s.includes("openCompg()") && /const COMPG=\{/.test(s), "COMP/G launcher + state missing");
  // -03: auto-launch replaced the button. The Corr tab must call compgAuto on open AND on a
  // scope flip, the picker must exist, and the launcher button must stay dead (a revert that
  // resurrects el('compgBtn') wiring would throw on the missing element and kill the client).
  assert.ok(/if\(v==='corr'\)\{ openCorr\(\); setTimeout\(compgAuto,60\)/.test(s), "COMP/G must auto-open with the Corr tab");
  assert.ok(s.includes("renderCorr(); setTimeout(compgAuto,60)"), "scope flip on the Corr tab must re-auto-open COMP/G for the new universe");
  assert.ok(!s.includes("compgBtn"), "the COMP/G launcher button must stay removed from app.js");
  assert.ok(s.includes("COMPG.closed=true") && s.includes("if(COMPG.closed) return;"), "panel close must latch for the session so auto-launch respects it");
  assert.ok(s.includes("function alignedDailyN") && s.includes("COMPG.mode==='spread'") && s.includes("COMPG.mode==='index'"), "COMP/G index/spread modes missing");
  assert.ok(s.includes("head==='comp'") && s.includes("TERM_VERBS=['top'") && s.includes("'corr','comp'"), "comp verb not wired into grammar/verb list");
  // Crypto intraday correlation tab: the tab is un-gated on crypto scope, the matrix comes from
  // the server payload (not client buildCorr on daily), the lookback is scope-aware (4h/1d/7d),
  // and the pair view aligns on the shipped intraday series. Each of these silently reverting to
  // the equities-only path would look fine but show an empty/wrong crypto matrix.
  assert.ok(s.includes("/api/corr-crypto") && s.includes("function renderCorrCrypto"), "crypto corr fetch path missing");
  assert.ok(s.includes("CORR._intraday") && s.includes("function paintCorr"), "crypto corr shared painter / intraday flag missing");
  assert.ok(s.includes("function syncCorrLookback") && /\[\['4h','4h'\],\['1d','1d'\],\['7d','7d'\]\]/.test(s), "scope-aware 4h/1d/7d lookback missing");
  assert.ok(s.includes("function alignedIntraday") && s.includes("CORR._bars"), "crypto pair-view intraday alignment missing");
  assert.ok(s.includes("'report','corr'") && s.includes("const CRYPTO_VIEWS"), "report and corr must remain in-scope for crypto (CRYPTO_VIEWS, which replaced showView's inline gate in -05)");
  // COMP/G runs on both universes via one axis-generic seam: equities align daily closes (axis =
  // day-ms), crypto reads the matrix's intraday closes (CORR._bars on CORR._times). The anchor is a
  // timestamp, not a day-int, and the button is no longer hidden on crypto. Reverting any of these
  // silently drops COMP/G back to equities-only.
  assert.ok(s.includes("function compgAligned") && s.includes("state.scope==='crypto' && CORR._intraday && CORR._bars && CORR._times"), "COMP/G crypto data seam missing");
  assert.ok(s.includes("COMPG.anchorTs") && !s.includes("COMPG.anchorDay"), "COMP/G anchor must be timestamp-based (anchorTs), not day-int");
  // (-03) the launcher button and its cg.hidden=false unhide are gone — crypto availability is
  // now guaranteed by compgAuto firing on the Corr tab in both scopes; this pin keeps the old
  // crypto-block from ever returning inside openCompg.
  assert.ok(s.includes("function compgAuto") && !/openCompg\(tickers\)\{\s*if\(state\.scope==='crypto'\)\{ const p=el\('compg'\)/.test(s), "COMP/G must no longer be hidden/blocked on crypto");
  // TERM_VERBS regression: it was referenced by termComps but never DEFINED — a silent
  // ReferenceError on every keystroke that killed ghost text + tab completion.
  assert.ok(/const TERM_VERBS=\[/.test(s), "TERM_VERBS must be defined, not just referenced (completion engine ReferenceError)");
  // server planner grammar stays in sync with the client executor (one grammar, two ends)
  {
    const polSrc = fs.readFileSync(path.join(__dirname, "..", "src", "poller.js"), "utf8");
    for (const pin of ["vsma200", '"top" || h === "bottom"', 'h === "breadth"'])
      assert.ok(polSrc.includes(pin), `ask planner grammar out of sync with client: ${pin}`);
    // analyst context starvation regression: the AI once answered "yearly open is not in the
    // data" because termCompactUniverse shipped 14 fields. Every board metric must ship, and
    // the analyst legend must describe it — a field missing here IS "not in the data".
    for (const pin of ["yo:rnd(r.yopen)", "mo:rnd(r.mopen)", "m200:rnd(r.ma200)", "d7:rnd(r.d7)", "rv:rnd(r.rvol)", "ddy:rnd(r.ddy)"])
      assert.ok(s.includes(pin), `analyst context missing board field: ${pin}`);
    for (const pin of ["yo = yearly open", "mo = monthly open", "m20/m50/m100/m200", "ddy = % below 52w high", "derivable from the data",
      "name = the company's common name", "NUMBERS RULE", "IDENTITY RULE"])
      assert.ok(polSrc.includes(pin), `analyst legend out of sync with shipped context: ${pin}`);
  }
  for (const id of ["helpBtn", "backBtn", "homeBtn", "helpmodal", "sighist-q", "sighist-ev", "sighist-panel", "dledger", "earnings-body", "view-earnings", "logoutBtn", "tabSpacer", "focusChip", "cmdk", "cmdk-q", "freshtray", "termFab", "termPanel", "termCmd", "termExpand", "compg"]) {
    if (id === "dledger") continue;   // dledger is injected by JS, not static markup
    assert.ok(html.includes(`id="${id}"`), `missing markup id: ${id}`);
  }
  // 1B: the ask input is a wrapping textarea, not a single-line <input> that runs off-screen.
  assert.ok(/<textarea id="termCmd"/.test(html), "ask input must be a <textarea> (wrapping), not an <input>");
  assert.ok(!/<input id="termCmd"/.test(html), "old single-line ask <input> must be gone");
  const tcss = fs.readFileSync(path.join(__dirname, "..", "public", "styles.css"), "utf8");
  assert.ok(/#termCmd\{[^}]*resize:none/.test(tcss) && /#termCmd\{[^}]*white-space:pre-wrap/.test(tcss), "termCmd textarea must not resize and must wrap");
  assert.ok(/#termGhost\{[^}]*white-space:pre-wrap/.test(tcss), "ghost overlay must wrap in sync with the textarea");
  assert.ok(/\.tp-wrap\{[^}]*min-width:0/.test(tcss), "tp-wrap needs min-width:0 or a long value overflows the panel (flexbox min-width:auto)");
  assert.ok(s.includes("function termAutoGrow") && s.includes("termAutoGrow(q)"), "textarea auto-grow helper missing/unwired");
  assert.ok(s.includes("!e.shiftKey&&!e.isComposing"), "Enter-to-run must yield to Shift+Enter (newline) and IME composition");
  // AI admin gate (client): unlock/lock commands (redacted echo), the three endpoints, the
  // ai-locked prompts on both AI surfaces, the lock indicator, and the help lines.
  assert.ok(s.includes("admin\\s+unlock") && s.includes("admin\\s+lock"), "admin unlock/lock command parsing missing");
  assert.ok(s.includes("/api/ai-unlock") && s.includes("/api/ai-lock") && s.includes("/api/ai-status"), "AI unlock/lock/status client calls missing");
  assert.ok(s.includes("d.error==='ai-locked'") || s.includes('d.error==="ai-locked"'), "client must handle the ai-locked response");
  assert.ok(s.includes("function termSetLock") && s.includes("function termRefreshLock") && s.includes("termRefreshLock()"), "lock indicator state helpers missing/unwired");
  assert.ok(s.includes("admin unlock") && s.includes("admin lock"), "terminal help must list admin unlock/lock");
  assert.ok(html.includes('id="termLock"'), "terminal AI lock indicator markup missing");
  // The backtest tab was silently dropped from the nav once while every renderer behind it
  // survived — pin both the button and the view section so the tab can't vanish again.
  // Still pinned, and deliberately so: the tab is HIDDEN from the strip, not removed. The markup,
  // the view section and every renderer behind it stay live — so this guard still catches a real
  // deletion, while the hide itself is asserted separately below.
  assert.ok(html.includes('data-view="backtest"'), "backtest tab button missing from nav");
  assert.ok(html.includes('id="view-backtest"'), "backtest view section missing");
  assert.ok(s.includes("xyzmon.tabs.v1"), "tab-order persistence key missing from client");
  // Auth surface: the login flow lives inline in server.js — pin its load-bearing pieces.
  // "return reply.code(401)" is load-bearing, not style: an async hook that send()s WITHOUT
  // returning the reply does not stop the lifecycle — @fastify/static double-sends and the
  // response hangs (the production outage of 2026.07.13: /api/health fine, "/" a body-less 401).
  const srv = fs.readFileSync(path.join(__dirname, "..", "server.js"), "utf8");
  for (const frag of ["xyzsess", "xyzauth", "/logout", "timingSafeEqual", "createHmac", "LOGIN_HTML", "/api/health", "return reply.code(401)"])
    assert.ok(srv.includes(frag), `missing server auth marker: ${frag}`);
});

test("server route manifest: every load-bearing API route is registered exactly once and backed by a real poller getter", () => {
  // Regression guard for build 2026.07.13-42: one careless block deletion in server.js removed
  // /api/series, /api/ledger and /api/candles — the three endpoints behind the drawer's candle
  // chart, OI/funding sparklines and signal record. node --check passed, the client was intact,
  // and every drawer loader swallows fetch errors, so the damage shipped silently for six
  // builds. This pins the full route surface: dropping a registration (or registering it
  // twice) is now a suite failure, and each poller.getX() a route calls must exist in poller.js.
  const fs = require("fs"), path = require("path");
  const srv = fs.readFileSync(path.join(__dirname, "..", "server.js"), "utf8");
  const routes = ["/api/snapshot", "/api/daily", "/api/analytics", "/api/duel", "/api/trend", "/api/signals",
    "/api/earnings", "/api/series", "/api/ledger", "/api/candles", "/api/corr-crypto", "/api/derivs", "/api/fundamentals", "/api/ai-report", "/api/ai-reports", "/api/health",
    "/api/actionable", "/api/triggers",
    "/api/export/ledger", "/api/news", "/api/news/channels", "/api/alerts", "/api/alerts/rules",
    "/manifest.webmanifest", "/icon.svg", "/sw.js"];
  for (const r of routes) {
    const n = srv.split(`fastify.get("${r}"`).length - 1;
    assert.ok(n >= 1, `server route missing: ${r}`);
    assert.equal(n, 1, `server route registered ${n} times: ${r}`);
  }
  // Generation is a POST with its own registration — pinned separately from the GET reads.
  assert.equal(srv.split('fastify.post("/api/ai-report"').length - 1, 1, "POST /api/ai-report must be registered exactly once");
  assert.equal(srv.split('fastify.post("/api/derivs/refresh"').length - 1, 1, "POST /api/derivs/refresh must be registered exactly once");
  // Terminal Tier-3 fallback is a POST backed by poller.askBoard — pin both.
  assert.equal(srv.split('fastify.post("/api/ask"').length - 1, 1, "POST /api/ask must be registered exactly once");
  // Admin budget reset is a POST backed by poller.resetAiDay — pin route, mapping, and export.
  assert.equal(srv.split('fastify.post("/api/ai-reset"').length - 1, 1, "POST /api/ai-reset must be registered exactly once");
  assert.ok(srv.includes('r.error === "user-day-cap" || r.error === "user-month-cap"') && srv.includes('capped ? 429'), "/api/ai-report must map every cap (shared + per-user) to 429 like cooldown");
  // -11 perf: candles + series must go through serveKeyed (ETag 304 + gzip memo), NOT no-store.
  // A raw serveCached here would be a correctness BUG — etagFor keys only on dataTs, which these
  // payloads lack, so every coin would share W/"0" and a client could get a 304 for the wrong
  // coin's chart. serveKeyed supplies a collision-proof per-coin/tf/version ETag instead.
  assert.ok(srv.includes("function serveKeyed") && srv.includes("function sendCachedBody"), "serveKeyed + sendCachedBody must exist");
  assert.ok(/get\("\/api\/candles"[\s\S]{0,1600}serveKeyed\(/.test(srv), "/api/candles must serve via serveKeyed");
  assert.ok(/get\("\/api\/series"[\s\S]{0,1200}serveKeyed\(/.test(srv), "/api/series must serve via serveKeyed");
  assert.ok(!/get\("\/api\/candles"[\s\S]{0,200}no-store/.test(srv), "/api/candles must no longer be no-store");
  assert.ok(srv.includes('"candles|"') && srv.includes("cs.px > 0 ? Math.round(Math.log(cs.px)"), "tf-candles key must fold in the live-mark bucket so the forming bar can't freeze");
  // -11 security: the paid AI endpoints must be closed to unauthenticated callers regardless of
  // SITE_PASSWORD (never serve model budget to the open web), and both POSTs carry a body cap.
  assert.ok(srv.includes("const reqAuthed") && srv.includes('AI_COST_PATHS = new Set(["/api/ask", "/api/ai-report"])'), "always-on AI-cost auth guard missing");
  assert.ok(srv.includes("!reqAuthed(req)") && /AI_COST_PATHS\.has\(u\)[\s\S]{0,120}!reqAuthed\(req\)/.test(srv), "AI-cost guard must 401 unauthenticated callers");
  assert.ok(/fastify\.post\("\/api\/ask", \{ bodyLimit: 256 \* 1024 \}/.test(srv), "/api/ask must carry a 256 KB body limit");
  assert.ok(/fastify\.post\("\/api\/ai-reset", \{ bodyLimit: 8 \* 1024 \}/.test(srv), "/api/ai-reset must carry an 8 KB body limit");
  // Every poller getter the route layer references must be defined AND exported by the poller
  // factory — a route bound to a phantom getter is a 500 the drawer's silent catch would eat.
  const pol = fs.readFileSync(path.join(__dirname, "..", "src", "poller.js"), "utf8");
  assert.ok(/async function askBoard/.test(pol) && /askBoard,/.test(pol), "poller.askBoard (terminal AI fallback) missing or not exported");
  assert.ok(/function resetAiDay/.test(pol) && /resetAiDay,/.test(pol), "poller.resetAiDay (admin budget reset) missing or not exported");
  const getters = new Set([...srv.matchAll(/poller\.(get[A-Za-z0-9_]+)\(/g)].map((m) => m[1]));
  assert.ok(getters.size >= 8, `suspiciously few poller getters referenced by routes: ${getters.size}`);
  // Getters take two shapes in poller.js — `function getX(` hoisted then exported shorthand,
  // or `getX: () =>` inline in the export object. Either counts; zero occurrences is a phantom
  // (exactly what the removed /api/unlocks route was — bound to a getUnlocks that never existed).
  for (const g of getters)
    assert.ok(new RegExp(`(function ${g}\\(|${g}\\s*:)`).test(pol), `route references undefined poller getter: ${g}`);
});

test("AI access model: open to authenticated users with per-user caps; xyzai is an admin EXEMPTION, not a gate", () => {
  // DELIBERATE REVERSAL (2026.08.03-09): the locked-by-default posture was replaced with
  // open-with-caps by explicit product decision. This test pins the NEW contract; restoring
  // an ai-locked hard gate would be a regression against that decision.
  const fs = require("fs"), path = require("path");
  const srv = fs.readFileSync(path.join(__dirname, "..", "server.js"), "utf8");
  const pol = fs.readFileSync(path.join(__dirname, "..", "src", "poller.js"), "utf8");
  // The unlock machinery still exists — as the admin exemption — and stays password-derived,
  // fail-closed, HttpOnly, and browser-only.
  // Pin updated 2026.09.20: the key is an HMAC of the random accounts secret under the password
  // label (rotate-to-revoke kept, offline dictionary attack on a captured cookie closed), so it is
  // assigned after ACCOUNTS opens rather than declared const at the top.
  assert.ok(srv.includes("xyzmon-ai-unlock|") && /let AI_UNLOCK_SECRET = null/.test(srv)
    && /AI_UNLOCK_SECRET = ACCOUNTS\.deriveKey\(`xyzmon-ai-unlock\|\$\{ADMIN_PASSWORD\}`\)/.test(srv), "AI unlock secret must derive from ADMIN_PASSWORD through the random accounts secret");
  assert.ok(!/createHash\("sha256"\)\.update\(`xyzmon-(ai-unlock|admin-view)\|/.test(srv), "never sha256(password) alone — no random material means a captured cookie is a dictionary attack");
  assert.ok(srv.includes("function signAiUnlock") && srv.includes("function aiUnlockOk"), "AI unlock signer/verifier missing");
  assert.ok(/aiUnlockOk[\s\S]{0,120}!ADMIN_PASSWORD/.test(srv), "aiUnlockOk must reject when ADMIN_PASSWORD is unset (fail closed)");
  assert.ok(srv.includes("function setAiUnlockCookie") && srv.includes("function clearAiUnlockCookie"), "xyzai cookie set/clear helpers missing");
  assert.ok(/aiCookieAttrs[\s\S]{0,400}HttpOnly/.test(srv), "xyzai must be HttpOnly");
  assert.ok(!/x-admin-password/i.test(srv), "there must be no header path to the admin exemption");
  // The hook must NOT hard-401 authenticated non-admins any more: no ai-locked emission.
  assert.ok(!srv.includes('error: "ai-locked"'), "the ai-locked hard gate must be gone — AI is open with caps");
  // Authentication is still mandatory on the AI-cost paths.
  assert.ok(/AI_COST_PATHS[\s\S]{0,400}reqAuthed\(req\)/.test(srv), "AI-cost hook must still require authentication");
  // Identity threading: one aiWho helper (xyzown owner + xyzai/xyzadm admin) feeds all three surfaces.
  assert.ok(/const aiWho = \(req, reply\) => \(\{ owner: ownerFor\(req, reply\)/.test(srv), "aiWho helper missing");
  // With accounts, "who" is the signed-in uid and only falls back to the anonymous browser handle.
  // Every per-user surface must resolve it the SAME way or the quota shown differs from the quota
  // spent — so ensureOwner survives only as ownerFor's fallback, never as a call site of its own.
  assert.ok(/const ownerFor = \(req, reply\) => \{[\s\S]{0,400}return ensureOwner\(req, reply\);/.test(srv),
    "ownerFor must prefer the session uid and fall back to the signed cookie");
  assert.equal(srv.split("ensureOwner(req, reply)").length - 1, 2,
    "ensureOwner may appear only in its own definition and inside ownerFor's fallback");
  assert.ok(srv.includes("poller.generateAiReport(String(b.coin || \"\"), aiWho(req, reply))"), "generation must carry who");
  assert.ok(srv.includes('poller.askBoard(b.q || "", b.ctx || {}, aiWho(req, reply))'), "ask must carry who");
  assert.ok(srv.includes("poller.getAiQuota(ownerFor(req, reply), admin)"), "ai-status must surface the caller's quota");
  // Poller: per-user constants pinned (3/day, 20/month reports; 5/day asks), soft-cap honesty noted.
  assert.ok(/AI_USER_PER_DAY = Math\.max\(1, Number\(process\.env\.AI_USER_PER_DAY\) \|\| 3\)/.test(pol), "per-user report day cap must default to 3");
  assert.ok(/AI_USER_PER_MONTH = Math\.max\(1, Number\(process\.env\.AI_USER_PER_MONTH\) \|\| 20\)/.test(pol), "per-user report month cap must default to 20");
  assert.ok(/ASK_USER_PER_DAY = Math\.max\(1, Number\(process\.env\.ASK_USER_PER_DAY\) \|\| 5\)/.test(pol), "per-user ask day cap must default to 5");
  assert.ok(pol.includes("HONESTY NOTE: xyzown is a cookie"), "the soft-cap caveat must be documented at the constants");
  assert.ok(pol.includes('error: "user-day-cap"') && pol.includes('error: "user-month-cap"') && pol.includes('error: "ask-user-cap"'), "per-user cap error codes missing");
  // Admin burns NOTHING: every burn site is guarded on !admin.
  assert.equal((pol.match(/if \(!admin\) \{ aiDay\.count\+\+; aiUserBurnReport\(owner\); \}/g) || []).length, 2, "both report burn sites (name + group) must be admin-guarded");
  assert.ok(pol.includes("if (!admin) { askDay.count++; aiUserBurnAsk(owner); }"), "ask burn must be admin-guarded");
  // Per-user counters persist with the report cache and are pruned (cookie churn bounded).
  assert.ok(pol.includes("users, reports: [...aiReports.values()]"), "per-user quotas must persist with the report cache");
  assert.ok(/45 \* DAY/.test(pol) && /slice\(0, 500\)/.test(pol), "quota map must prune (45d / 500 entries)");
  // Admin plumbing unchanged: routes once, shared password check, shared lockout.
  assert.equal(srv.split('fastify.post("/api/ai-unlock"').length - 1, 1, "POST /api/ai-unlock registered exactly once");
  assert.equal(srv.split('fastify.post("/api/ai-lock"').length - 1, 1, "POST /api/ai-lock registered exactly once");
  assert.equal(srv.split('fastify.get("/api/ai-status"').length - 1, 1, "GET /api/ai-status registered exactly once");
  assert.ok(srv.includes("poller.checkAdminPassword"), "unlock route must verify via poller.checkAdminPassword");
  assert.ok(/function checkAdminPassword/.test(pol) && /checkAdminPassword,/.test(pol), "poller.checkAdminPassword missing or not exported");
  assert.ok(/function resetAiDay[\s\S]{0,160}checkAdminPassword\(password, who\)/.test(pol), "resetAiDay must route through checkAdminPassword with the caller key (per-caller lockout, 2026.09.20)");
});

test("trend leaderboard integrity: client, markup and server carry the tab end to end", () => {
  const fs = require("fs"), path = require("path");
  const s = require("./_client").clientSource();
  const defs = {};
  for (const m of s.matchAll(/^(?:async )?function ([A-Za-z0-9_]+)\(/gm)) defs[m[1]] = (defs[m[1]] || 0) + 1;
  for (const n of ["loadTrend", "openTrend", "renderTrend", "trendDotHtml", "trendSectionHtml", "trendMAChips"]) {
    assert.ok(defs[n] >= 1, `missing client function: ${n}`);
    assert.equal(defs[n], 1, `duplicate client function: ${n}`);
  }
  assert.ok(!/\\\\u[0-9a-f]{4}/.test(s), "no double-escaped unicode (\\\\uXXXX) may leak into client strings — it renders as literal text");
  for (const frag of ["/api/trend", "trow-hl", "tretest", "trend:`", "tage", "td21", "fresh-first", "twidth", "rrv",
    "tma-chip", "?fast=", "&slow=", "nodata", "tpend", "_trendMA", "_tc.ema", "SEED=S-1",
    "EMA${F}", "EMA${S}", "\\u0394${S}"])   // board text follows the active pair, not a hardcoded 13/21
    assert.ok(s.includes(frag), `missing client feature marker: ${frag}`);
  const eng = fs.readFileSync(path.join(__dirname, "..", "src", "compute.js"), "utf8");
  for (const fn of ["function stackedRun(", "function ribbonWidth(", "TREND_TF_MS"])
    assert.ok(eng.includes(fn), `missing engine symbol: ${fn}`);
  assert.ok(fs.readFileSync(path.join(__dirname, "..", "src", "poller.js"), "utf8").includes("seedRowNow"),
    "missing poller harness: seedRowNow");
  const html = fs.readFileSync(path.join(__dirname, "..", "public", "index.html"), "utf8");
  assert.ok(html.includes('data-view="trend"'), "trend tab button missing from nav");
  for (const id of ["view-trend", "trendside", "trend-body", "trend-asof", "tchartbg", "tchartmodal", "sig-introtxt", "sig-segslot"])
    assert.ok(html.includes(`id="${id}"`), `missing markup id: ${id}`);
  const srv = fs.readFileSync(path.join(__dirname, "..", "server.js"), "utf8");
  assert.ok(srv.includes("/api/trend"), "server route missing: /api/trend");
  const css = fs.readFileSync(path.join(__dirname, "..", "public", "styles.css"), "utf8");
  for (const cls of [".tdot", ".tretest", ".trend-t", ".trow-hl", ".twidth", ".tchart-btn", ".tchart-modal", ".tcbtn-td",
    ".tdot.nd", ".tma-chip", ".tma-chip.on"])
    assert.ok(css.includes(cls), `missing style: ${cls}`);
  // chart modal contract markers: the button ships on rows, the fetch carries tf=, and the
  // candles route branches to the ladder-series getter — drop any one and the modal quietly
  // degrades (silent-fetch-swallowing is exactly how the -42 route deletion hid for six builds)
  const app = require("./_client").clientSource();
  for (const frag of ["tchart-btn", "&tf=", "tcbtn-td"])
    assert.ok(app.includes(frag), `missing chart-modal client marker: ${frag}`);
  // signals card grammar (build -67): meta column, scope tag, watch line, unified pill classes
  for (const frag of ["sig-meta", "sig-scope", "sp-watchline", "sig-unp bad", "sig-unp warn"])
    assert.ok(app.includes(frag), `missing signals-card grammar marker: ${frag}`);
  for (const cls of [".sig-meta", ".sig-scope", ".sp-watchline", ".sig-unp.bad", ".sig-chip.bad"])
    assert.ok(css.includes(cls), `missing signals-card style: ${cls}`);
  // audit block collapse (build -68): toggle + sub-section markers
  for (const frag of ["sigRecFullPref", "data-recx", "sigrec-sub"])
    assert.ok(app.includes(frag), `missing audit-collapse marker: ${frag}`);
  assert.ok(css.includes(".sigrec-sub"), "missing style: .sigrec-sub");
  assert.ok(srv.includes("getTfCandles"), "candles route does not branch to the ladder-series getter");
  // trend-retest ledger signal: both event ids must exist end to end — server labels/meta,
  // playbook, and the client label/tip maps (a missing client label renders raw event ids)
  const pol = fs.readFileSync(path.join(__dirname, "..", "src", "poller.js"), "utf8");
  const cmp = fs.readFileSync(path.join(__dirname, "..", "src", "compute.js"), "utf8");
  for (const ev of ["tretest", "tretestdn"]) {
    assert.ok(pol.includes(`${ev}:`) || pol.includes(`"${ev}"`), `poller missing event wiring: ${ev}`);
    assert.ok(cmp.includes(ev), `compute missing event meta/playbook: ${ev}`);
    assert.ok(app.includes(`${ev}:`), `client label/tip maps missing event: ${ev}`);
  }
});

test("client + server integrity: the Report tab ships end to end (markers, styles, retention bump)", () => {
  const fs = require("fs"), path = require("path");
  const app = require("./_client").clientSource();
  const css = fs.readFileSync(path.join(__dirname, "..", "public", "styles.css"), "utf8");
  const html = fs.readFileSync(path.join(__dirname, "..", "public", "index.html"), "utf8");
  const srv = fs.readFileSync(path.join(__dirname, "..", "server.js"), "utf8");
  const pol = fs.readFileSync(path.join(__dirname, "..", "src", "poller.js"), "utf8");
  const sto = fs.readFileSync(path.join(__dirname, "..", "src", "store.js"), "utf8");
  for (const frag of ['data-view="report"', 'id="view-report"', 'id="ai-q"', 'id="ai-sug"', 'id="ai-report"', 'id="ai-recent"'])
    assert.ok(html.includes(frag), `index.html missing report marker: ${frag}`);
  for (const frag of ["openAiReport", "openReportView", "aiReportChart", "loadAiRecent", "aiRegenerate", "aiMatches", "HELP.report", "setHidden('view-report'"])
    assert.ok(app.includes(frag), `app.js missing report marker: ${frag}`);
  assert.ok(app.includes("v!=='report'"), "crypto-scope whitelist must include the report view");
  assert.ok(app.includes("openAiReport(coin)"), "drawer deep link must route into the report view");
  for (const cls of [".ai-sug", ".ai-head", ".ai-badge", ".ai-scen", ".ai-foot", ".ai-rec", ".ai-flag"])
    assert.ok(css.includes(cls), `styles.css missing report style: ${cls}`);
  for (const frag of ["/api/ai-report", "/api/ai-reports", "generateAiReport", "429"])
    assert.ok(srv.includes(frag), `server.js missing report marker: ${frag}`);
  for (const frag of ["claude-fable-5", "claude-opus-4-8", "gpt-5.6-sol", "gpt-5.6-terra", "ANTHROPIC_API_KEY", "OPENAI_API_KEY", "api.openai.com/v1/chat/completions", "max_completion_tokens", "anthropic-version", "stop_reason", "AI_PROVIDER", "validateAiReport", "compileAiContext", "trendAlignAtFire"])
    assert.ok(pol.includes(frag), `poller.js missing AI engine marker: ${frag}`);
  for (const frag of ["saveAiReports", "loadAiReports", "ai-reports.json"])
    assert.ok(sto.includes(frag), `store.js missing AI persistence marker: ${frag}`);
  // Crypto daily RETENTION deepened to 370d (-20: MA200 / structural levels / swing shadows) while
  // the WIRE stays at the 92 bars the clients render — both are constants, and the fetch must ride
  // retention while the payload cap rides the wire constant. A bare number left behind in either
  // spot silently shrinks a window back.
  assert.ok(/const MAIN_DAILY_DAYS = 370;/.test(pol), "crypto daily retention must be 370d via MAIN_DAILY_DAYS");
  assert.ok(/const MAIN_DAILY_PAYLOAD = 92;/.test(pol), "crypto daily wire payload must stay 92 bars via MAIN_DAILY_PAYLOAD");
  assert.ok(pol.includes("now - MAIN_DAILY_DAYS * DAY"), "crypto daily fetch must use MAIN_DAILY_DAYS");
  assert.ok(pol.includes("dr.slice(-(MAIN_DAILY_PAYLOAD + 2))"), "crypto daily payload cap must ride MAIN_DAILY_PAYLOAD");
  // -28: the cap is for the WIRE only. dc.daily doubles as the signal loop's input, and capping
  // both starved every deep crypto detector (swpull at 120 closes, regime200 at 210, the EMA200
  // shadows at 216) for eight builds while the 370d retention sat unread. The loop must read the
  // deep map, and the deep map must be written before the wire slice.
  assert.ok(pol.includes("deepDaily.set(r.coin, dr);"), "full crypto tuples stashed for the signal loop");
  assert.ok(pol.includes("const closes = closedDailyCloses(deepDaily.get(r.coin) || dc.daily[r.coin] || null)"), "the signal loop prefers full depth (closed bars only, -67)");
});

test("mobile suite -100: touch parity, mobile preset and PWA shell are fully wired", () => {
  // Four surfaces in one build, each pinned across every file it touches. The service worker is
  // additionally pinned to be CACHE-FREE: a fetch handler that intercepts nothing. Any future
  // edit that adds caches.open / caches.match to /sw.js is reintroducing the stale-client bug
  // class the version-stamped shell exists to kill, and must fail here first.
  const fs = require("fs"), path = require("path");
  const app = require("./_client").clientSource();
  const html = fs.readFileSync(path.join(__dirname, "..", "public", "index.html"), "utf8");
  const css = fs.readFileSync(path.join(__dirname, "..", "public", "styles.css"), "utf8");
  const srv = fs.readFileSync(path.join(__dirname, "..", "server.js"), "utf8");
  // Touch parity: long-press hover in the tooltip engine, horizontal-intent scrub on line charts.
  for (const pin of ["touchstart", "touchmove", "touchend", "lp.scrub", "scrubAt(t.clientX)", "dx>dy+4"])
    assert.ok(app.includes(pin), `touch parity pin missing: ${pin}`);
  // Mobile preset: curated columns, built-in Layouts row, one-shot first-visit auto-apply.
  assert.ok(app.includes("const MOBILE_COLS="), "MOBILE_COLS missing");
  assert.ok(app.includes("data-mob="), "built-in Mobile layout row missing");
  assert.ok(app.includes("xyzmon.mobilePreset.v1"), "one-shot auto-apply flag missing");
  for (const k of ["'ticker'", "'px'", "'d1'", "'funding'"])
    assert.ok(app.match(/const MOBILE_COLS=\[[^\]]*\]/)[0].includes(k), `mobile preset must keep ${k}`);
  // PWA shell: head tags in the markup, registration in the client, inline routes in the server.
  for (const pin of ['rel="manifest"', 'name="theme-color"', 'href="/icon.svg"'])
    assert.ok(html.includes(pin), `PWA head tag missing: ${pin}`);
  assert.ok(app.includes("serviceWorker.register('/sw.js')"), "SW registration missing");
  assert.ok(srv.includes("PWA_MANIFEST") && srv.includes("PWA_SW"), "inline PWA payloads missing from server");
  // The worker lives in public/sw.js since -66 (it grew push handlers); the server reads it at
  // boot with the old inline no-op as fallback. The contract stands either way: a fetch handler
  // for installability, ZERO caching or interception — a stale client is worse than no client.
  assert.ok(/const PWA_SW = \(\(\) => \{/.test(srv) && srv.includes('"public", "sw.js"'), "PWA_SW must read the worker file at boot");
  assert.ok(/return "self\.addEventListener\('install'/.test(srv), "the inline no-op fallback must survive — installability must not break on a missing file");
  const swf = fs.readFileSync(path.join(__dirname, "..", "public", "sw.js"), "utf8");
  assert.ok(swf.includes('addEventListener("fetch"'), "SW needs a fetch handler for installability");
  assert.ok(!swf.includes("caches") && !swf.includes("respondWith"), "SW must not cache or intercept — stale-client hazard");
  assert.ok(swf.includes('addEventListener("push"') && swf.includes("showNotification"), "the push leg renders notifications");
  assert.ok(swf.includes('addEventListener("notificationclick"'), "and a click lands the reader in the app");
  // Mobile CSS: sticky ticker column, full-width drawer, scrollable tab strip, touch targets.
  for (const pin of [".wrap tbody td:first-child{position:sticky", ".drawer{width:100vw", "(hover:none) and (pointer:coarse)"])
    assert.ok(css.includes(pin), `mobile css pin missing: ${pin}`);
});

test("perf: serveCached caches serialization per payload object; series downsamples; compress has a threshold", () => {
  const fs = require("fs"), path = require("path");
  const srv = fs.readFileSync(path.join(__dirname, "..", "server.js"), "utf8");
  // serialization cache keyed on the object (WeakMap) — NOT on the etag string, which two routes
  // could share and cross-serve.
  assert.ok(srv.includes("new WeakMap()") && srv.includes("serialCache.get(body)"), "per-object serialization cache missing");
  assert.ok(srv.includes("serialCache.set(body, s)"), "serialization cache store missing");
  assert.ok(srv.includes("return reply.send(s)"), "serveCached must send the pre-serialized string");
  assert.ok(srv.includes("threshold: 1024"), "compress threshold missing");
  assert.ok(srv.includes("downsampleSeries") && srv.includes("SERIES_CAP"), "series downsampler missing");
  // 304 revalidation path must remain intact (untouched by the serialization change)
  assert.ok(srv.includes('if (req.headers["if-none-match"] === tag)') && srv.includes("reply.code(304).send()"), "304 revalidation path must survive");

  // behavioral check of the downsampler: caps length, preserves first and (exact) last sample
  const mod = { downsampleSeries: null, SERIES_CAP: null };
  const m = srv.match(/function downsampleSeries\(arr, cap\) \{[\s\S]*?\n\}/);
  assert.ok(m, "downsampleSeries body not found");
  const ds = new Function(m[0] + "; return downsampleSeries;")();
  const big = []; for (let i = 0; i < 9000; i++) big.push([i, i * 2]);
  const out = ds(big, 1500);
  assert.ok(out.length <= 1501, `downsampled length ${out.length} must be ~cap`);
  assert.deepEqual(out[0], [0, 0], "first sample preserved");
  assert.deepEqual(out[out.length - 1], big[big.length - 1], "live-edge (last) sample preserved exactly");
  assert.deepEqual(ds([[1, 1], [2, 2]], 1500), [[1, 1], [2, 2]], "arrays under the cap pass through untouched");
  assert.deepEqual(ds(null, 1500), [], "null track degrades to empty");
});

test("perf batch 2026.07.21-08: snapshot/daily keep their cache OBJECT while content is unchanged", () => {
  // #1 — the serialize + gzip WeakMap caches (server.js) and every polling client's 304 all hinge on
  // the poller handing back the SAME object reference when nothing a client renders has changed. An
  // empty universe is stable by construction: two back-to-back builds must produce one object, and
  // dataTs must be a content clock (frozen across the no-op), not the wall clock.
  const { createPoller } = require("../src/poller");
  const store = { loadAll: () => new Map(), loadRegime: () => [], loadLedger: () => ({ ts: 0, open: [], closed: [], rearm: [], variants: null }),
    saveLedger: () => {}, insert: () => {}, saveRegime: () => {} };
  const p = createPoller({ dex: "xyz", store, log: () => {}, version: "test", crypto: false });
  p.buildSnapshotNow();
  const a = p.getSnapshot();
  p.buildSnapshotNow();
  const b = p.getSnapshot();
  assert.ok(a && b, "snapshot built");
  assert.strictEqual(a, b, "unchanged content must keep the SAME snapshot object (warm serialize/gzip + real 304)");
  assert.strictEqual(a.dataTs, b.dataTs, "dataTs is a content clock — frozen while nothing a client renders changed");
  assert.ok(!("_sig" in a), "the content signature must NOT be shipped on the payload (kept module-side)");

  p.buildDailyNow();
  const d1 = p.getDaily();
  p.buildDailyNow();
  const d2 = p.getDaily();
  assert.ok(d1 && d2, "daily built");
  assert.strictEqual(d1, d2, "unchanged daily content must keep the SAME object");
});

test("perf batch 2026.07.21-08: getFunding memo, bucketsFor memo, gzip+dataTs wiring are all present", () => {
  // Source manifest, same regression-guard philosophy as the route + client-integrity manifests:
  // a silent deletion of any of these five mechanisms passes `node --check` but quietly restores the
  // per-request waste (or re-download) they were built to kill, so each is pinned where it lives.
  const fs = require("fs"), path = require("path");
  const pol = fs.readFileSync(path.join(__dirname, "..", "src", "poller.js"), "utf8");
  const srv = fs.readFileSync(path.join(__dirname, "..", "server.js"), "utf8");
  const app = require("./_client").clientSource();

  // #4 getFunding memo + its per-row invalidation at every fundH mutation site (5 writes + clear + sweep)
  assert.ok(pol.includes("r._fgVer === r._fVer && r._fgH === hourKey"), "getFunding memo key missing");
  assert.equal((pol.match(/r\._fVer = \(r\._fVer \|\| 0\) \+ 1/g) || []).length, 6, "every fundH mutation site must bump _fVer (seed, 2x foldCtx, backfill, clear, sweep)");

  // #3 bucketsFor memo, and NO raw spine bucketing left at the hot call sites
  assert.ok(pol.includes("function bucketsFor(r, width)"), "bucketsFor memo helper missing");
  assert.ok(pol.includes("if (r._bkRaw !== c) { r._bkRaw = c; r._bk = {}; }"), "bucketsFor freshness key missing");
  assert.ok(!/bucketCandles\((?:r|rr)\.hourlyRaw/.test(pol), "hot paths must bucket through bucketsFor, never rebuild from r.hourlyRaw");
  assert.ok(pol.includes("H12: bucketsFor(r, 12)") && pol.includes("H4: bucketsFor(r, 4)"), "trend/AI ladders must feed bucketsFor");

  // #1 snapshot content signature keeps the object + content-clock dataTs (sig stays off the payload)
  assert.ok(pol.includes("if (snapshotCache && lastSnapSig === csig) return;"), "snapshot content-sig short-circuit missing");
  assert.ok(pol.includes("function markSig(m)"), "per-market fingerprint missing");
  assert.ok(pol.includes("ts: snapVer, dataTs: snapVer"), "snapshot dataTs must be the content clock, not lastPoll");
  assert.ok(pol.includes('if (dailyCache && sig === dailySig) return;'), "daily must keep its object on unchanged content");

  // #5 gzip cache in serveCached
  assert.ok(srv.includes("const gzipCache = new WeakMap();"), "gzip WeakMap missing");
  assert.ok(srv.includes("gz = gzipAsync(s)") && srv.includes('reply.header("content-encoding", "gzip")'), "pre-gzip serve path missing — -08 moved the compress onto the libuv threadpool (gzipAsync), memoized as a promise then a Buffer");
  assert.ok(srv.includes('const zlib = require("zlib");'), "zlib import missing");

  // #2 client dataTs short-circuit + factored sidecar pulls
  assert.ok(app.includes("if(s.dataTs && s.dataTs===state.dataTs){ maybePullSidecars(); return; }"), "client snapshot short-circuit missing");
  assert.ok(app.includes("function maybePullSidecars()"), "sidecar pulls must be factored so they still fire on a 304");
});

test("5m archive: source + wiring manifest (store engine, capture path, route, run flags)", () => {
  const fs = require("fs"), path = require("path");
  const rd = (f) => fs.readFileSync(path.join(__dirname, "..", f), "utf8");
  const sto = rd("src/store.js"), pol = rd("src/poller.js"), srv = rd("server.js");
  const pkg = rd("package.json"), rail = rd("railway.json");
  // store engine: node:sqlite, clustered STRICT table, idempotent upsert, and the off-copy hedge
  assert.ok(sto.includes('require("node:sqlite")'), "store must use the built-in node:sqlite (no native dep)");
  assert.ok(sto.includes("candles.db"), "candle archive targets candles.db");
  assert.ok(sto.includes("WITHOUT ROWID") && sto.includes("STRICT"), "candles_5m must be a STRICT, WITHOUT ROWID clustered table");
  assert.ok(sto.includes("ON CONFLICT(coin, ts) DO UPDATE"), "inserts must upsert (idempotent capture/gap-fill)");
  assert.ok(sto.includes("VACUUM INTO"), "snapshotCandles must VACUUM INTO an off-copy (sole-copy recovery hedge)");
  assert.ok(/candlesEnabled\(\)/.test(sto), "store must expose candlesEnabled() so callers degrade cleanly without the module");
  // poller capture path: forming-bar guard, one worker, 370d retention, exported getters
  assert.ok(pol.includes("function capture5m") && pol.includes("function fiveMinWorker"), "capture + worker present");
  assert.ok(pol.includes("k[0] + FIVE_MIN <= now"), "closed-bar guard (forming bar dropped) present");
  assert.ok(pol.includes("M5_RETENTION_DAYS = 370"), "retention pinned at 370d");
  assert.ok(pol.includes("store.evictCandles(") && /maintenance[\s\S]*evictCandles/.test(pol), "eviction runs inside maintenance");
  assert.ok(/getCandles5m,/.test(pol) && /getCandleCoverage,/.test(pol) && /getM5Stamp:/.test(pol), "5m getters exported");
  assert.ok(pol.includes("fiveMinWorker();"), "capture worker launched in start()");
  // route: res=5m branch on /api/candles (no new route string — manifest still counts one)
  assert.ok(/res === "5m"/.test(srv), "/api/candles must branch on res=5m");
  assert.ok(srv.includes('"candles5m|"') && srv.includes("poller.getCandles5m(") && srv.includes("poller.getM5Stamp("), "res=5m must key + serve via the 5m getters");
  assert.equal(srv.split('fastify.get("/api/candles"').length - 1, 1, "still exactly one /api/candles registration");
  // run flags: the experimental-sqlite flag must be present everywhere the app is launched/tested,
  // and Node pinned so a runtime bump can't silently change the module API under us.
  assert.ok(/--experimental-sqlite server\.js/.test(pkg), "npm start must pass --experimental-sqlite");
  assert.ok(/--experimental-sqlite --test/.test(pkg), "npm test must pass --experimental-sqlite");
  assert.ok(/">=22\.5/.test(pkg), "engines.node must require >= 22.5 (node:sqlite availability), pinned");
  assert.ok(/--experimental-sqlite server\.js/.test(rail), "railway startCommand must pass --experimental-sqlite");
});

test("deep archive + CHARTS tab: source + wiring manifest (store, capture lane, route, client)", () => {
  const fs = require("fs"), path = require("path");
  const rd = (f) => fs.readFileSync(path.join(__dirname, "..", f), "utf8");
  const sto = rd("src/store.js"), pol = rd("src/poller.js"), srv = rd("server.js");
  const app = require("./_client").clientSource(), html = rd("public/index.html"), css = rd("public/styles.css");
  const C = require("../src/compute");
  // store: both tables STRICT/WITHOUT ROWID with the upsert, keyed off one statement map
  assert.ok(sto.includes('for (const iv of ["4h", "12h", "1d"]') && sto.includes('const tbl = "candles_" + iv'),
    "store must build candles_12h/candles_1d off the one interval list (a typo'd third table cannot appear)");
  assert.ok(sto.includes("deepStmt[iv]") && sto.includes("insertCandlesDeep(iv, coin, rows)"), "deep API is interval-keyed, one surface for both tables");
  // capture lane: backward seed + closed-bar guard + worker launched inside the sqlite gate
  assert.ok(pol.includes('DEEP_IVS = { "4h": 4 * HOUR, "12h": 12 * HOUR, "1d": 24 * HOUR }'), "interval map pinned (4h joined -03)");
  assert.ok(pol.includes("DEEP_SEED_BARS = 4900"), "seed reaches for the full native window (just under the 5000-bar cap)");
  assert.ok(pol.includes("function captureDeep") && pol.includes("function deepWorker"), "capture + worker present");
  assert.ok(pol.includes("k[0] + w <= now"), "deep closed-bar guard present (forming 12h/1d bar never lands)");
  assert.ok(pol.includes("deepWorker();"), "deep worker launched in start()");
  assert.ok(/getCandlesDeep,/.test(pol) && /getDeepStamp:/.test(pol) && /_deepFilterClosed:/.test(pol), "deep getters + harness hook exported");
  // route: res=12h/res=1d branch on /api/candles — no new route string, manifest still counts one
  assert.ok(/res === "4h" \|\| req\.query\.res === "12h" \|\| req\.query\.res === "1d"/.test(srv), "/api/candles must branch on res=4h|12h|1d");
  assert.ok(srv.includes('"candlesdeep|"') && srv.includes("poller.getCandlesDeep(") && srv.includes("poller.getDeepStamp("), "deep branch must key + serve via the deep getters");
  assert.equal(srv.split('fastify.get("/api/candles"').length - 1, 1, "still exactly one /api/candles registration");
  // manifest: CHARTS tab exists, public, routeless (the candle routes stay pinned under markets —
  // gating charts can never strand a candle request)
  const f = C.FEATURES.find((x) => x.key === "charts");
  assert.ok(f && f.kind === "tab", "FEATURES must carry the charts tab");
  assert.equal(f.def, "public", "charts ships public — it is a viewer over already-public routes");
  assert.equal((f.routes || []).length, 0, "charts owns no route; /api/candles stays under the pinned markets key");
  // markup: tab button + view section (the markup<->manifest join test enforces the pairing;
  // these pins make a deletion name THIS feature instead of failing generically)
  assert.ok(html.includes('data-view="charts"') && html.includes('id="view-charts"') && html.includes('id="chartswrap"'), "charts tab markup present");
  // client: entry point, both source fetches, aggregation, LINK-as-transform, viewport, hover,
  // coverage disclosure, per-browser persistence — and the tab is reachable from every entry path
  for (const pin of ["function openCharts()", "res=5m&from=", "&res='+CH_SRC_RES[src]", "function chAgg(", "function chZoomAll(", "function chPanAll(", "function chHoverAll(", "function chResetView(", "localStorage.setItem('xyz-charts'", "CH_MTF_SETS",
    "{k:240,l:'4H',src:'d4h'}", "d4h:'4h'", "240:60*86400000", "p.covEl.textContent=covTxt"])
    assert.ok(app.includes(pin), "charts client marker missing: " + pin);
  assert.ok(app.includes("'markets','focus','funds','trend','charts'"), "HASH_VIEWS must route #charts");
  assert.ok(app.includes("'markets','trend','charts','report'"), "CRYPTO_VIEWS must keep charts visible in crypto scope");
  assert.ok(app.includes("{v:'charts',label:'Charts'}"), "command palette must reach charts");
  assert.ok(app.includes("setHidden('view-charts'") && app.includes("if(v==='charts'){ if(el('view-charts')) openCharts();"), "showView must wire the charts section");
  // the crosshair/readout hover contract holds on every pane (standing requirement: all charts hover)
  assert.ok(app.includes("chHoverAll(p,tAt(e))") && app.includes("hover for OHLC"), "per-pane crosshair + OHLC readout wired");
  // intraday base stays under the route cap so the server never coarsens it off the 5m grid —
  // the client-side 15m/1h/4h aggregation depends on receiving RAW 5m rows
  assert.ok(app.includes("CH_IBASE_DAYS=20") && app.includes("&max=6000"), "20d raw-5m base window pinned (5760 bars < 6000 cap)");
  // styles
  for (const cls of [".chtb", ".chgrid.g8", ".chpane", ".chtfs", ".chcov", ".chdd", ".chfoot"])
    assert.ok(css.includes(cls), "missing charts style: " + cls);
  // ---- -02 additions: EMA overlay, right-edge inset + clip, live-edge follow -----------------
  // EMA: toolbar controls with the 50/200 default, walk memoized per pane, overlay + readout +
  // insufficient-bars disclosure — and the warm-up head stays null (no unconverged line).
  assert.ok(app.includes("CH_EMA_DEF=[50,200]"), "EMA default pair pinned at 50/200");
  for (const pin of ["function chEmaWalk(", "function chEmas(", "id=\"chemabtn\"", "id=\"chema1\"", "id=\"chema2\"",
    "chEmaPeriod(", "out[n-1]=e", "if(!n||n<2||series.length<n) return out;", "line(em.e1,chVar('--blue')); line(em.e2,chVar('--accent'));",
    "' needs '+CH.ema.p2+' bars ('"])
    assert.ok(app.includes(pin), "charts -02 EMA marker missing: " + pin);
  for (const cls of [".chemain", ".chke1", ".chke2"])
    assert.ok(css.includes(cls), "missing charts -02 style: " + cls);
  // right-edge fix: inset mapping used by bars, axis ticks, crosshair AND the pointer inverse,
  // plus the hard clip that makes a straddling bar cut cleanly at the plot edge
  assert.ok(app.includes("const inset=Math.ceil(bw/2)+1;") && app.includes("p._inset=inset;"), "right-edge inset present and stored on the pane");
  assert.ok(app.includes("ctx.rect(0,PT,pw,ph); ctx.clip();"), "bar/EMA layer hard-clipped to the plot rect");
  assert.ok((app.match(/Xi\(/g) || []).length >= 4, "inset mapping (Xi) drives bars, ticks and the crosshair");
  assert.ok(app.includes("-(p._inset||0)"), "pointer\u2192time inverse shares the inset — the crosshair hovers the bar it points at");
  // live-edge follow: a pinned pane rides new bars, a historical view is never yanked forward
  assert.ok(app.includes("pinned:!!(b&&p.view&&p.view.to>=b.to-p.tf*60000*0.51)"), "pinned-at-edge detection present");
  assert.ok(app.includes("if(q.pinned&&nb&&q.to!=null&&nb.to>q.to&&p.view)"), "only pinned panes follow the advancing close");
});

test("server: /api/derivs routes registered once, keyed ETag, cooldown maps to 429", () => {
  const fs = require("fs"), path = require("path");
  const srv = fs.readFileSync(path.join(__dirname, "..", "server.js"), "utf8");
  assert.equal(srv.split('fastify.get("/api/derivs"').length - 1, 1, "GET /api/derivs exactly once");
  assert.equal(srv.split('fastify.post("/api/derivs/refresh"').length - 1, 1, "POST /api/derivs/refresh exactly once");
  assert.ok(/get\("\/api\/derivs"[\s\S]{0,600}serveKeyed\(/.test(srv), "/api/derivs must serve via serveKeyed (per-coin fresh payloads — raw serveCached would collide ETags across coins)");
  assert.ok(srv.includes('"derivs|" + poller.derivsKey(coin)'), "ETag key must come from poller.derivsKey");
  assert.ok(/fastify\.post\("\/api\/derivs\/refresh", \{ bodyLimit: 8 \* 1024 \}/.test(srv), "refresh POST must carry a body cap");
  assert.ok(/r\.error === "cooldown" \? reply\.code\(429\)|error === "cooldown"\) return reply\.code\(429\)/.test(srv), "cooldown must map to 429");
});

test("fundamentals: poller module wired, gated on the earnings roster, price-trio derived live", () => {
  const fs = require("fs"), path = require("path");
  const pol = fs.readFileSync(path.join(__dirname, "..", "src", "poller.js"), "utf8");
  const srv = fs.readFileSync(path.join(__dirname, "..", "server.js"), "utf8");
  const sto = fs.readFileSync(path.join(__dirname, "..", "src", "store.js"), "utf8");
  // exports + ETag key
  assert.ok(pol.includes("getFundamentals,") && pol.includes("fundamentalsKey:"), "getFundamentals + fundamentalsKey exported for serveKeyed");
  // SAME eligibility gate as earnings — no separate roster to drift out of sync
  assert.ok(/const roster = \[\.\.\.earnEligible\(\)\.values\(\)\];\s+\/\/ \{coin, ticker\} — the SAME eligibility gate as earnings/.test(pol),
    "fundTick must gate on earnEligible() — the earnings roster, not a parallel one");
  assert.ok(pol.includes("const FUND_ALIAS = EARN_ALIAS"), "fundamentals must reuse the earnings US-symbol aliasing");
  // the price-sensitive trio is derived live off the mark, NOT cached — this is the one-code-path guarantee
  assert.ok(pol.includes("const mcap = (px != null && f.shares != null) ? px * f.shares * 1e6 : null"), "market cap derived live off the board mark");
  assert.ok(pol.includes("const pe = (px != null && f.epsTTM != null && f.epsTTM > 0) ? px / f.epsTTM : null"), "P/E derived live; guarded so EPS<=0 does not produce a number");
  assert.ok(pol.includes("const ps = (px != null && f.revPsTTM != null && f.revPsTTM > 0) ? px / f.revPsTTM : null"), "P/S derived live off the mark");
  assert.ok(/peNm: epsNm/.test(pol) && pol.includes("const epsNm = (f.epsTTM != null && f.epsTTM <= 0)"), "negative/zero trailing EPS must flag P/E as n/m, not a negative multiple");
  // honest coverage: non-equity and unresolved names get a reason, never a fabricated grid
  assert.ok(pol.includes('covered: false') && pol.includes('non-equity ('), "non-equity names get an honest not-covered reason");
  assert.ok(pol.includes('foreign listing — not resolved by the US feed'), "a tried-but-empty name reads as foreign/uncovered, distinct from pending");
  assert.ok(/pending: !tried/.test(pol), "un-fetched names are pending, not miscategorised as uncovered");
  // the ETag key folds a coarse px bucket so the live trio isn't frozen behind a cached body
  assert.ok(/Math\.round\(Math\.log\(r\.px\) \* 400\)/.test(pol), "fundamentalsKey must fold a coarse px bucket so the derived trio refreshes as the mark moves");
  // slow rotation + warm cache persistence
  assert.ok(pol.includes("const FUND_DUE_TTL = 22 * HOUR"), "each name re-fetches at most ~daily (fundamentals are quarterly)");
  assert.ok(pol.includes("hydrateFund()") && pol.includes("store.saveFund(") , "cache is persisted and restored across redeploys");
  assert.ok(sto.includes("saveFund(data)") && sto.includes("loadFund()"), "store must expose saveFund/loadFund");
  // server route via serveKeyed, exactly once, keyed off the poller
  assert.equal(srv.split('fastify.get("/api/fundamentals"').length - 1, 1, "GET /api/fundamentals registered exactly once");
  assert.ok(/get\("\/api\/fundamentals"[\s\S]{0,500}serveKeyed\(/.test(srv), "/api/fundamentals must serve via serveKeyed (per-coin fresh payload)");
  assert.ok(srv.includes('"fund|" + poller.fundamentalsKey(coin)'), "ETag key must come from poller.fundamentalsKey");
});

test("build -07 manifest: pair math welded across compute.js and app.js; duel plumbing pinned end to end", () => {
  const fs = require("fs"), path = require("path");
  const app = require("./_client").clientSource();
  const cmp = fs.readFileSync(path.join(__dirname, "..", "src", "compute.js"), "utf8");
  const pol = fs.readFileSync(path.join(__dirname, "..", "src", "poller.js"), "utf8");
  const srv = fs.readFileSync(path.join(__dirname, "..", "server.js"), "utf8");
  const css = fs.readFileSync(path.join(__dirname, "..", "public", "styles.css"), "utf8");
  const html = fs.readFileSync(path.join(__dirname, "..", "public", "index.html"), "utf8");
  const stf = fs.readFileSync(path.join(__dirname, "..", "src", "store.js"), "utf8");
  // Constant-fragment weld: every coefficient of the shared core + V2 + V3 must appear in BOTH
  // implementations. Retuning one file without the other is a suite failure, which is the point.
  for (const frag of ["0.4*Math.tanh", "/8)", "(0.5+0.5*kappa)", "0.6,1.4", "1.5)",
    "Math.tanh(fAPR/25))>=0.15", "(0.5+0.5*c)", "0.2*Math.tanh", "*=0.8", "fp>=90", "fp<=10"])
    assert.ok(app.replace(/\s+/g, "").includes(frag.replace(/\s+/g, "")), `app.js missing pair-math fragment: ${frag}`);
  for (const frag of ["0.4 * Math.tanh", "(0.5 + 0.5 * kappa)", "0.6, 1.4", "Math.tanh(fAPR / 25)) >= 0.15",
    "(0.5 + 0.5 * c)", "1 - 0.2 * Math.tanh", "*= 0.8", "fp >= 90", "fp <= 10"])
    assert.ok(cmp.includes(frag), `compute.js missing pair-math fragment: ${frag}`);
  // poller: snapshot cadence guards, floors, retention, persistence, exports
  for (const frag of ["DUEL_RETENTION_D = 180", "DUEL_MIN_N = 60", "DUEL_MIN_NAMES = 8",
    "if (duel.snaps[day]) return", "store.saveDuel(duel)", "hydrateDuel", "getDuel,", "duelTickNow: duelTick",
    "momPair, spearmanIC, duelStats"])
    assert.ok(pol.includes(frag), `poller.js missing duel pin: ${frag}`);
  assert.ok(/setInterval\(safeTick\(duelTick, "duelTick"\), 60 \* 1000\)/.test(pol), "duel timer wired at 60s");
  // server: exactly one registration already covered by the route manifest; pin the getter binding
  assert.ok(srv.includes("poller.getDuel()"), "/api/duel must serve poller.getDuel through serveCached");
  // store: atomic blob pair
  assert.ok(stf.includes("saveDuel(data)") && stf.includes("loadDuel()") && stf.includes('duel.json'), "store duel blob missing");
  // client: column adjacent to the incumbent in the default order, migration helper applied twice
  // -10: MOM+ is the default-visible momentum column; plain MOM moved to the hidden tail. They are
  // no longer adjacent in DEFAULT_ORDER — pin the product decision instead of the old layout.
  { const ord = app.match(/const DEFAULT_ORDER=\[([^\]]*)\]/)[1].split(",").map(x => x.replace(/'/g, "").trim());
    const hid = new Set(app.match(/const DEFAULT_HIDDEN=\[([^\]]*)\]/)[1].split(",").map(x => x.replace(/'/g, "").trim()));
    assert.ok(ord.includes("mom") && ord.includes("momp"), "both momentum columns exist in DEFAULT_ORDER");
    assert.ok(!hid.has("momp"), "MOM+ visible by default");
    assert.ok(hid.has("mom"), "plain MOM hidden by default (the -10 default set)"); }
  // -04: the 5m/15m pair added two adjacency calls per merge site (m5 beside px, m15 beside m5);
  // 2026.08.10-01: the anchored-open trio (hopen/h4open/h12open beside dopen) added three more per site
  // 2026.09.16-79: the Position column (pos beside oi) added one more per site
  assert.equal(app.split("colAdjacent(").length - 1, 15, "adjacency migration: one definition + (momp, m5, m15, hopen, h4open, h12open, pos) on the prefs path + the same seven on the layout path");
  assert.ok(app.includes("renderDuelSection()") && app.includes("loadDuelData()"), "duel panel wired into the backtest render");
  // -08: the hot dot rides BOTH momentum cells — it flags the name, not the incumbent score,
  // and must survive when only one of the two columns is visible.
  const mompFn = app.slice(app.indexOf("function mompCell"), app.indexOf("function rsCell"));
  assert.ok(mompFn.includes("hotdot"), "mompCell must render the hot dot like momCell does");
  // css + footer + help
  for (const cls of [".duel-verdict", ".duel-tbl", ".duel-row", ".mompw"]) assert.ok(css.includes(cls), `styles.css missing ${cls}`);
  assert.ok(html.includes("MOM+"), "index.html footer must introduce the candidate column");
  assert.ok(app.includes("Score duel</div>"), "backtest help must document the duel");
});

test("-17 client + server wiring manifest: dual-universe route, tz-aware renderers, sessions tab in crypto", () => {
  const fs = require("fs"), path = require("path");
  const app = require("./_client").clientSource();
  const pol = fs.readFileSync(path.join(__dirname, "..", "src", "poller.js"), "utf8");
  const srv = fs.readFileSync(path.join(__dirname, "..", "server.js"), "utf8");
  const cmp = fs.readFileSync(path.join(__dirname, "..", "src", "compute.js"), "utf8");
  // server: the universe descriptor + retention split + parallel cache + route param
  for (const pin of [
    "function analyticsUniverse(scope)",
    "const MAIN_SPINE_DAYS = 90;",
    'scope: "crypto", isCrypto: true, tz: "UTC",',
    "roster: () => mainMarkets().filter",
    "analyticsCryptoCache = payload",
    'getAnalytics: (scope) => {',                     // -17 hotfix: self-healing getter (lazy build on a cold cache)
    'getAnalyticsErr: (scope) =>',                    // and the recorded failure reason the route ships
    'buildAnalyticsSafe("crypto")',   // -17 hotfix: all builds route through the error-recording wrapper
  ]) assert.ok(pol.includes(pin), `poller.js missing -17 pin: ${pin}`);
  assert.ok(srv.includes('req.query && req.query.u === "crypto"'), "server routes ?u=crypto to the crypto analytics cache");
  // compute: crypto anchors exported, clocks accept a tz
  for (const pin of ["function utcDayAnchors(", "function cryptoWeekendAnchors(", "utcDayAnchors, cryptoWeekendAnchors,",
    "function activityClock(prices, funding, tz)", 'const utc = tz === "UTC";'])
    assert.ok(cmp.includes(pin), `compute.js missing -17 pin: ${pin}`);
  // client: per-universe slots, tz helpers, cash-band gating, sessions in the crypto allowlist
  for (const pin of [
    "function _szTz()", "function _szCash()",
    "state.analyticsCrypto=", "function syncAnalyticsSlot()",
    "'/api/analytics?u=crypto'",
    "'backtest','sessions'",                                  // sessions survives the crypto tab filter (now via CRYPTO_VIEWS)
    "if(cash!==false){",                                      // clock scaffold suppresses the cash arc for crypto
    "sd.isCrypto",                                            // session decomposition renderer is universe-aware
    "chart('utcday','UTC day",                               // and draws the UTC-day leg
    "const nStudies = 1/*regime*/+4",   // -19: study count derived from the published group set                                    // footer count is universe-aware
  ]) assert.ok(app.includes(pin), `app.js missing -17 client pin: ${pin}`);
});

test("-17 hotfix: analytics ETag is scope-namespaced so the two universes can't collide", () => {
  const fs = require("fs"), path = require("path");
  const srv = fs.readFileSync(path.join(__dirname, "..", "server.js"), "utf8");
  // the route builds a scope-prefixed validator and 304s only on an exact scope-tag match
  assert.ok(srv.includes('const tag = \'W/"\' + scope + "-" +'), "ETag prefixes the scope");
  assert.ok(srv.includes('if (req.headers["if-none-match"] === tag) { return reply.code(304).send(); }'),
    "304 only when the scope-namespaced tag matches");
  // prove the two tags differ even at an identical dataTs
  const tagOf = (scope, dataTs) => 'W/"' + scope + "-" + dataTs + '"';
  assert.notEqual(tagOf("stocks", 1721000000000), tagOf("crypto", 1721000000000), "same-ms builds still get distinct tags");
});

test("features: scope enforcement wiring — routes, memo, wire, panel (manifest pins)", () => {
  const fs = require("fs"), path = require("path");
  const srv = fs.readFileSync(path.join(__dirname, "..", "server.js"), "utf8");
  const pol = fs.readFileSync(path.join(__dirname, "..", "src", "poller.js"), "utf8");
  const app = require("./_client").clientSource();
  const css = fs.readFileSync(path.join(__dirname, "..", "public", "styles.css"), "utf8");
  // Every scoped payload route must pass the caller's rank down — a getter called without it
  // resolves as public-by-default in featureScopeVis only because !!undefined is false, which
  // would silently scope ADMINS. These four call sites are the whole enforcement surface.
  assert.ok(srv.includes("poller.getSignals(isAdmin(req))"), "/api/signals must be audience-aware");
  assert.ok(srv.includes("poller.getActionable(isAdmin(req))"), "/api/actionable must be audience-aware");
  assert.ok(srv.includes("poller.getLedgerFor(coin, ev, isAdmin(req))"), "/api/ledger must be audience-aware");
  assert.ok(srv.includes("poller.getLedgerExport(isAdmin(req))"), "/api/export/ledger must be audience-aware");
  // The scoped body carries a STRING dataTs folding the flags stamp — the collision guard between
  // the filtered ETag and the full body's numeric one, and the immediacy guarantee on a flag flip.
  assert.ok(pol.includes('body.dataTs = String(src.dataTs || 0) + "s" + flagsVer'), "scoped bodies must mint their own ETag stamp");
  assert.ok(pol.includes("flagsVer++;"), "an accepted flag write must bust the scoped-body memo immediately");
  // Identity path pin: vis.all must return the SHARED cache object (serialize/gzip memo + ETag).
  assert.ok(pol.includes('vis.all ? signalsCache : scopedBody("sig", signalsCache, vis)'), "admin signals must take the identity path");
  assert.ok(pol.includes("scopeFilterSignals(src, vis, { xyzOnly: XYZ_ONLY_EVS, mainOnly: MAIN_ONLY_EVS })"),
    "the signals filter must be fed the poller's OWN universe rosters — a drifted copy would misclassify variant rows");
  assert.ok(pol.includes('vis.all ? full : scopedBody("act", full, vis)'), "admin actionable must take the identity path");
  // The two secondary transports honour the same predicate as the tabs — bell log and Telegram.
  assert.ok(pol.includes("&& scopeEventVisible(e, sigVis, actVis)"), "the trigger stream must apply the scope predicate");
  assert.ok(pol.includes("(rec.admin || scopeEventVisible(e, pubSigVis, pubActVis))"), "the Telegram wire must apply it for non-admin recipients");
  // Client: the guard flips a scoped-out viewer to the visible universe instead of mounting an
  // empty (or self-advertising) state, and the panel nests scope rows off the shipped parent link.
  assert.ok(app.includes("function scopeGuard(parent)"), "the client scope guard is missing");
  assert.ok(app.includes("scopeGuard('signals')") && app.includes("scopeGuard('actionable')"), "both scoped renderers must run the guard");
  // -06 (reversing -04): both universe pills stay MOUNTED at all times — hiding one made the app
  // lie about what exists. A mid-tab flip into a universe the active scoped tab cannot show is a
  // navigation: applyScope routes to Markets in the chosen universe instead of letting the render
  // guard flip the pill straight back (the -02/-04 fight). Entry auto-flip is untouched.
  assert.ok(!/applyScopePills/.test(app), "the -04 pill-hiding must stay deleted — pills always mount");
  assert.ok(app.includes("else if((state.view==='signals'||state.view==='actionable') && !featureOn(state.view+'.'+(state.scope==='crypto'?'cx':'eq'))) showView('markets');"),
    "a scope flip into a hidden slice must land on Markets in that universe, not fight the guard");
  assert.ok(css.includes(".scope[hidden]{display:none}"), "the [hidden] guard stays — cheap insurance for any future hider");
  // -05: settled-table cells never wrap — a split "11+ / 14−" reads as two numbers. The label
  // column is the ONE cell allowed to wrap; it soaks the width so the numeric columns stay whole.
  assert.ok(css.includes(".act-set-t td{padding:4px 8px;font-family:var(--mono);white-space:nowrap}"), "settled numeric cells must be nowrap");
  assert.ok(css.includes(".act-set-t td:first-child{white-space:normal;width:100%}"), "the settled label column must absorb the slack width");
  assert.ok(/x\.kind==='scope'&&x\.parent===m\.key/.test(app), "the admin panel must nest scope rows via the manifest's parent link, not a hardcoded list");
  assert.ok(app.includes("' \u00b7 <b>'+c.scoped+'</b> scoped'") || app.includes("scoped':''"), "the counts line must disclose the scoped split");
  assert.ok(css.includes(".adm-row.adm-scope"), "nested scope rows need their indent style");
});

test("features: every manifest route is registered in server.js exactly once", () => {
  const fs = require("fs"), path = require("path");
  const C = require("../src/compute");
  const srv = fs.readFileSync(path.join(__dirname, "..", "server.js"), "utf8");
  // Same class of guard as the route-manifest test: a feature pointing at a route that does not
  // exist means the gate silently protects nothing (the phantom /api/unlocks failure, again).
  for (const f of C.FEATURES) {
    for (const r of f.routes || []) {
      const sp = r.indexOf(" ");
      const verb = sp > 0 ? r.slice(0, sp).toLowerCase() : null;
      const p = sp > 0 ? r.slice(sp + 1) : r;
      const hits = [...srv.matchAll(new RegExp(`fastify\\.(get|post)\\("${p.replace(/[/]/g, "\\/")}"`, "g"))];
      assert.ok(hits.length >= 1, `feature "${f.key}" claims route ${r} which server.js never registers`);
      if (verb) assert.ok(hits.some((h) => h[1] === verb), `feature "${f.key}" claims ${r} but no fastify.${verb} for that path`);
    }
  }
  // Nothing in the never-gate set may also be claimed by a feature — gating the unlock path is a
  // one-way door (no cookie, no way to mint one, no way back in without a redeploy).
  for (const f of C.FEATURES)
    for (const r of f.routes || [])
      assert.ok(!C.FEATURE_NEVER_GATE.has(r.replace(/^[A-Z]+ /, "")), `feature "${f.key}" claims never-gateable route ${r}`);
  for (const p of ["/api/health", "/login", "/logout", "/api/ai-unlock", "/api/ai-lock"])
    assert.ok(C.FEATURE_NEVER_GATE.has(p), `${p} must be permanently ungateable`);
});

test("server: admin-view lease is a distinct secret from the AI unlock, fails closed, browser-only", () => {
  const fs = require("fs"), path = require("path");
  const srv = fs.readFileSync(path.join(__dirname, "..", "server.js"), "utf8");
  // Distinct label. With a shared secret an xyzai token would validate as xyzadm and the deliberately
  // short AI-spend lease would silently become a 30-day one.
  assert.ok(srv.includes("xyzmon-admin-view|"), "admin-view secret must derive from ADMIN_PASSWORD under its own label");
  assert.ok(srv.includes("xyzmon-ai-unlock|"), "the AI unlock secret must still exist separately");
  assert.notEqual(srv.indexOf("xyzmon-admin-view|"), srv.indexOf("xyzmon-ai-unlock|"), "the two secrets must not be the same expression");
  assert.ok(srv.includes("function signAdminView") && srv.includes("function adminViewOk"), "admin-view signer/verifier missing");
  assert.ok(/adminViewOk[\s\S]{0,140}!ADMIN_PASSWORD/.test(srv), "adminViewOk must fail closed when ADMIN_PASSWORD is unset");
  assert.ok(/"xyzadm=" \+ \(token \|\| "x"\)[\s\S]{0,120}HttpOnly/.test(srv), "the xyzadm token cookie must be HttpOnly");
  assert.ok(srv.includes('"xyzadmin=1"'), "a JS-visible marker must exist so the client can render the Admin affordance");
  // No header/Basic path to admin: isAdmin reads the cookie and nothing else.
  // Two ways to be admin now: the isAdmin flag on your own account, or the ADMIN_PASSWORD-derived
  // cookie kept as break-glass. Neither is a header, which is the invariant this guards.
  assert.ok(/const isAdmin = \(req\) => \{[\s\S]{0,300}adminViewOk\(getCookie\(req, "xyzadm"\)\)/.test(srv),
    "isAdmin must still resolve from the session or the xyzadm cookie");
  assert.ok(/const isAdmin = \(req\) => \{[\s\S]{0,300}me\.isAdmin/.test(srv),
    "an account flagged admin must be admin without needing the break-glass cookie");
  assert.ok(!/authorization[\s\S]{0,80}isAdmin/i.test(srv), "isAdmin must never read an auth header");
  assert.ok(!/x-admin/i.test(srv), "there must be no header bypass for admin");
  // The login damper is spent, not the terminal-unlock lockout — otherwise a group member with a fat
  // finger could lock the operator out of the panel.
  assert.ok(srv.includes("function adminPwOk"), "login needs its own constant-time admin compare");
  assert.ok(/adminPwOk[\s\S]{0,220}timingSafeEqual/.test(srv), "adminPwOk must be constant-time");
  assert.ok(/if \(adminPwOk\(pw\)\)[\s\S]{0,400}setAdminCookies/.test(srv), "login must mint the admin lease when the admin password is used");
  // Pin updated 2026.09.20: /logout is one handler on two verbs (POST for the state change, GET
  // for the nav button's same-origin navigation), so the cookie drops live in `logout`.
  assert.ok(/const logout = async \(req, reply\) => \{[\s\S]{0,700}setAdminCookies\(reply, req, 0, null\)[\s\S]{0,200}clearAiUnlockCookie/.test(srv),
    "logout must drop the admin lease AND the AI unlock — never leave a stale elevation behind");
  assert.ok(srv.includes('fastify.get("/logout", logout)') && srv.includes('fastify.post("/logout", logout)'), "both verbs share the one handler");
  // Terminal escalation grants the view too, so `admin unlock` and admin-password login agree.
  assert.ok(/setAiUnlockCookie\(reply, req, signAiUnlock[\s\S]{0,400}setAdminCookies/.test(srv), "the terminal unlock must also grant the admin view");
});

test("server: feature gate runs after the site gate, returns 403, and both /api/features routes exist once", () => {
  const fs = require("fs"), path = require("path");
  const srv = fs.readFileSync(path.join(__dirname, "..", "server.js"), "utf8");
  // Ordering is load-bearing: an unauthenticated caller must get 401 (log in), not 403 (you are not
  // admin). Fastify runs onRequest hooks in registration order, so source order IS the contract.
  const iSite = srv.indexOf('if (u.startsWith("/api/")) return reply.code(401)');
  const iGate = srv.indexOf("featureGateFor(req.method, req.url");
  assert.ok(iSite > 0 && iGate > 0, "both gates must exist");
  assert.ok(iGate > iSite, "the feature gate must be registered AFTER the site gate or 403 masks 401");
  // The same Fastify lifecycle trap the site gate documents: reply.send() alone does not stop the
  // chain in an async hook. This must RETURN the reply.
  assert.ok(/return reply\.code\(403\)[\s\S]{0,140}feature-gated/.test(srv), "the gate must RETURN a 403 reply (async hook lifecycle)");
  assert.ok(srv.includes('feature: blocked'), "the 403 must name the blocking feature so a log is debuggable");
  // Both verbs admin-only: an open GET let a public visitor enumerate every feature key and see which
  // were admin-only, which contradicts gated features leaving no trace. The client never needs this
  // route — it reads its resolved set from the injected shell.
  assert.ok(/fastify\.get\("\/api\/features"[\s\S]{0,220}if \(!isAdmin\(req\)\) return reply\.code\(403\)/.test(srv),
    "GET /api/features must require admin");
  for (const r of ['fastify.get("/api/features"', 'fastify.post("/api/features"']) {
    const n = srv.split(r).length - 1;
    assert.equal(n, 1, `${r} must be registered exactly once (got ${n})`);
  }
  assert.ok(/fastify\.post\("\/api\/features", \{ bodyLimit/.test(srv), "the write route needs a body cap");
  // Honest-null: an unset ADMIN_PASSWORD closes every admin-state feature to everyone. Say it at boot
  // rather than letting it present as "the Actionable tab stopped working".
  assert.ok(srv.includes("WARN: ADMIN_PASSWORD is unset"), "boot must warn when no admin cookie can ever be minted");
  // Shape, not a literal: pinning the exact stamp would fail on every subsequent build, which trains
  // people to edit the test instead of reading it.
  assert.ok(/const VERSION = "2026\.\d{2}\.\d{2}-\d+";/.test(srv), "build stamp must keep the 2026.MM.DD-NN form");
});

// ===== admin panel, phase 2: client enforcement =================================================
test("client flags: the injection slot exists, is pre-paint, and the server's copy matches it byte-for-byte", () => {
  const fs = require("fs"), path = require("path");
  const html = fs.readFileSync(path.join(__dirname, "..", "public", "index.html"), "utf8");
  const srv = fs.readFileSync(path.join(__dirname, "..", "server.js"), "utf8");
  const SLOT = "window.__FLAGS=null;window.__ADMIN=false;";
  assert.ok(html.includes(SLOT), "index.html must carry the flag slot the server substitutes into");
  // Byte-identical, or the boot-time split silently misses and every caller gets the unsubstituted
  // shell — tabs show, routes 403, and nothing in the UI explains why. Same failure class as the
  // asset-tag drift the stamper already warns about, so it gets the same kind of guard.
  assert.ok(srv.includes('const FLAG_SLOT = "' + SLOT + '"'), "server FLAG_SLOT must match index.html exactly");
  // Pre-paint: the slot must precede the app.js tag, or the client reads window.__FLAGS before it is set.
  assert.ok(html.indexOf(SLOT) < html.indexOf('src="/app.js"'), "the flag slot must load BEFORE app.js");
  assert.ok(html.indexOf(SLOT) < html.indexOf("<body"), "the flag slot must be in <head> so a gated tab never paints");
  // Split once at boot, concat per request — not a 23 KB string scan on every hit.
  assert.ok(srv.includes("const [INDEX_HEAD, INDEX_TAIL]"), "the shell must be split once at boot");
  assert.ok(/INDEX_HEAD \+ boot \+ INDEX_TAIL/.test(srv), "serveIndex must concat the injected boot script");
  assert.ok(/const bootScript = \(admin, me\) =>[\s\S]{0,300}resolveFeatures\(poller\.getFlags\(\), admin\)/.test(srv), "the injected set must be server-resolved for THIS caller");
  assert.ok(/const bootScript = \(admin, me\) =>[\s\S]{0,400}window\.__ME=/.test(srv), "identity must be injected pre-paint alongside the flags");
  assert.ok(/const boot = bootScript\(admin, meOf\(req\)\)/.test(srv), "serveIndex must build the boot script for the calling session");
  // Per-audience body is only safe because the shell is uncacheable. If this header ever goes, a
  // shared cache could hand a public visitor the admin shell.
  assert.ok(/serveIndex = \(req, reply\) => \{[\s\S]{0,700}cache-control", "no-store"/.test(srv), "the audience-specific shell MUST stay no-store");
  assert.ok(srv.includes("WARN: index.html flag slot missing"), "a missing slot must be announced at boot, not silently ignored");
});


test("client integrity: no top-level function name is declared twice in any shipped file", () => {
  // The -05 crypto blackout was a hoisted redefinition: a new inScope(view) silently replaced the
  // existing inScope(row), so activeRows() asked "is this row object one of the crypto view names",
  // got false for every row, and the crypto board rendered empty — while the stocks board quietly
  // showed BOTH universes because the same predicate short-circuited to true there.
  //
  // The old guard checked duplicates only for names on a hand-kept `need` list, so a collision with
  // any unlisted function passed. This one is exhaustive by construction: every top-level
  // declaration in every shipped file, no list to forget to update. Anchored to column 0 on purpose
  // — nested/IIFE-local helpers may legitimately reuse a name (public/app.js has its own esc() inside
  // the Treemap installer) and cannot shadow anything outside their closure.
  const fs = require("fs"), path = require("path");
  for (const rel of ["public/app.js", "src/poller.js", "src/compute.js", "src/store.js", "server.js"]) {
    const src = fs.readFileSync(path.join(__dirname, "..", rel), "utf8");
    const seen = new Map();
    for (const m of src.matchAll(/^function ([A-Za-z_$][A-Za-z0-9_$]*)\s*\(/gm))
      seen.set(m[1], (seen.get(m[1]) || 0) + 1);
    const dupes = [...seen].filter(([, n]) => n > 1).map(([k, n]) => `${k} (x${n})`);
    assert.deepEqual(dupes, [], `${rel} declares the same top-level function more than once: ${dupes.join(", ")} — the later declaration hoists over the earlier one and silently wins`);
  }
});

test("server: alert delivery routes registered once, body-capped, cooldown mapped to 429", () => {
  const fs = require("fs"), path = require("path");
  const srv = fs.readFileSync(path.join(__dirname, "..", "server.js"), "utf8");
  for (const r of ["/api/alerts/link", "/api/alerts/unlink", "/api/alerts/classes", "/api/alerts/test"])
    assert.equal(srv.split(`fastify.post("${r}"`).length - 1, 1, `POST ${r} must be registered exactly once`);
  assert.equal(srv.split('fastify.get("/api/alerts"').length - 1, 1, "GET /api/alerts exactly once");
  assert.ok(/get\("\/api\/alerts"[\s\S]{0,200}no-store/.test(srv), "delivery state must be no-store — a cached link code is an expired link code");
  for (const r of ["/api/alerts/link", "/api/alerts/unlink", "/api/alerts/classes", "/api/alerts/test"])
    assert.ok(new RegExp(`post\\("${r.replace(/\//g, "\\/")}", \\{ bodyLimit`).test(srv), `${r} must carry a body cap`);
  assert.ok(/alerts\/test[\s\S]{0,400}error === "cooldown"[\s\S]{0,60}429/.test(srv), "test-fire cooldown must map to 429");
});

test("brief: the admin test-fire is admin-only, takes the real path, and reports what actually shipped", () => {
  const fs = require("fs"), path = require("path");
  const sv = fs.readFileSync(path.join(__dirname, "..", "server.js"), "utf8");
  assert.ok(sv.includes('fastify.post("/api/alerts/brief-test"'), "route missing");
  const route = sv.slice(sv.indexOf('/api/alerts/brief-test'), sv.indexOf('/api/alerts/brief-test') + 700);
  assert.ok(/if \(!isAdmin\(req\)\) return reply\.code\(403\)/.test(route),
    "a brief costs a model call and lands as two messages \u2014 not a visitor's button");
  assert.ok(/bodyLimit/.test(route), "every POST carries a body cap");
  const pol = fs.readFileSync(path.join(__dirname, "..", "src", "poller.js"), "utf8");
  assert.ok(/briefTest: briefTestNow,/.test(pol), "poller.briefTest must be exported or the route is bound to a phantom");
  // It must go through generateBrief, not a bespoke preview path — a test fire that renders
  // differently from the 07:00 send is worse than no test fire at all.
  const fn = pol.slice(pol.indexOf("async function briefTestNow("), pol.indexOf("async function briefTestNow(") + 1200);
  assert.ok(/generateBrief\(/.test(fn) && /pushEnqueue\(c, m, true\)/.test(fn));
  assert.ok(/if \(fresh\) briefCache = null;/.test(fn), "cached vs fresh must be a real distinction, not a label");
  const app = require("./_client").clientSource();
  assert.ok(app.includes("/api/alerts/brief-test"), "client never calls the route");
});

test("ownership is a signed handle, not a guessable id, and legacy rows stay admin-managed", () => {
  const fs = require("fs"), path = require("path");
  const srv = fs.readFileSync(path.join(__dirname, "..", "server.js"), "utf8");
  // Signed so it cannot be forged, random so it cannot be guessed, HttpOnly so page script cannot
  // read it. It grants nothing except management of the recipients linked from that browser.
  // Keyed by the accounts' random secret, never by the password alone (see the build -67 test below).
  assert.ok(/OWNER_SECRET = ACCOUNTS\.deriveKey\("alert-owner"\)/.test(srv) && /function signOwner/.test(srv));
  assert.ok(/crypto\.timingSafeEqual/.test(srv.slice(srv.indexOf("function ownerOf"), srv.indexOf("function ensureOwner"))),
    "handle verification must be constant-time like every other token check here");
  assert.ok(/crypto\.randomBytes\(12\)/.test(srv), "the id must be random, not derived from anything a visitor controls");
  assert.ok(/xyzown=" \+ signOwner\(id\) \+ cookieAttrs\(req, 400 \* 24 \* 3600\) \+ "; HttpOnly"/.test(srv));

  const pol = fs.readFileSync(path.join(__dirname, "..", "src", "poller.js"), "utf8");
  // Ownerless rows predate this build. Adopting them by "first visitor to look" would hand one
  // person's linked Telegram to whoever opened the panel next.
  assert.ok(/return !!\(rec && rec\.owner && owner && rec\.owner === owner\);/.test(pol),
    "an absent owner must never match an absent caller — that is the adoption hole");
  assert.ok(/admin-managed rather than adopted/.test(pol) || /admin-managed, never silently adopted/.test(pol),
    "the legacy-row decision is documented where it is made");
  // /stop is the escape hatch that needs no cookie: the command arrives FROM the chat.
  assert.ok(/if \(had\) pushUnlink\(chat, null, true\);/.test(pol));
  assert.ok(/control of the\n        \/\/ Telegram account is a stronger claim than any browser handle/.test(pol));
});

test("crash containment + fuller shutdown: every timer-cadence persist gets a final flush", async () => {
  const fs = require("fs"), path = require("path");
  const srv = fs.readFileSync(path.join(__dirname, "..", "server.js"), "utf8");
  const pol = fs.readFileSync(path.join(__dirname, "..", "src", "poller.js"), "utf8");
  // Node crashes the process on an unhandled rejection; without handlers a crash drops up to
  // 10 min of spine plus buffered deriv appends. Both handlers must exist and route to the flush.
  assert.ok(srv.includes('process.on("unhandledRejection", (e) => crashFlush("unhandledRejection", e))'), "unhandledRejection flushes before exit");
  assert.ok(srv.includes('process.on("uncaughtException", (e) => crashFlush("uncaughtException", e))'), "uncaughtException flushes before exit");
  assert.ok(srv.includes("process.exit(1)") && /crashFlush[\s\S]{0,600}store\.close\(\)/.test(srv),
    "the crash path still exits nonzero (Railway restarts) and drains the store's append buffers on the way out");
  // Graceful shutdown flushes MORE than the crash path: triggers, push state, and the awaited spine.
  for (const call of ["poller.persistTriggers()", "poller.persistPush()", "await poller.persistHourly()"])
    assert.ok(srv.includes(call), `shutdown must call ${call} — it was previously left to the last interval tick`);
  assert.ok(srv.includes("let shuttingDown = false"), "re-entry guard: a second signal (or a crash mid-shutdown) must not double-flush");
  // The final-flush surface must actually be exported by the poller, not assumed.
  assert.ok(/persistHourly: \(\) => persistHourly\(\),\s*\n\s*persistTriggers,\s*\n\s*persistPush,/.test(pol),
    "poller exports persistHourly/persistTriggers/persistPush for the shutdown and crash paths");
});

test("baseline security headers ride every response", () => {
  const fs = require("fs"), path = require("path");
  const srv = fs.readFileSync(path.join(__dirname, "..", "server.js"), "utf8");
  assert.ok(/addHook\("onSend"[\s\S]{0,400}x-content-type-options[\s\S]{0,100}nosniff/.test(srv), "nosniff on everything — no MIME confusion across the JSON/HTML mix");
  assert.ok(/x-frame-options", "DENY"/.test(srv), "framing forbidden outright — a framed login page is a phishing kit");
  assert.ok(/referrer-policy", "same-origin"/.test(srv), "versioned asset URLs and API paths stay inside the origin");
});

test("stamped assets cache immutable; everything else still force-revalidates", () => {
  const fs = require("fs"), path = require("path");
  const srv = fs.readFileSync(path.join(__dirname, "..", "server.js"), "utf8");
  assert.ok(srv.includes('req.url.slice(q + 1) === "v=" + VERSION && reply.statusCode === 200 && !req.url.startsWith("/api/")'),
    "exact whole-query match against the CURRENT build, 200s only, never on /api/ — a stale stamp falls back to revalidation and no future v-param route can be frozen for a year");
  assert.ok(srv.includes('"public, max-age=31536000, immutable"'),
    "current-stamp requests cache immutable — the -84 lesson made free instead of merely cheap");
  assert.ok(srv.includes('setHeaders(res) { res.setHeader("cache-control", "no-cache"); }'),
    "everything unstamped still force-revalidates at the static route");
  // The shell must still be the thing that mints stamped URLs, or immutable serves nothing.
  assert.ok(srv.includes('src="/app.js?v=${VERSION}"') && srv.includes('href="/styles.css?v=${VERSION}"'),
    "the boot-time shell rewrite is the sole source of stamped URLs — the cache-buster IS the URL");
});

test("macro -17 manifest: fetch engine, guards, payload fold, report contract — pinned end to end", () => {
  // Source-manifest guard, same philosophy as the client-integrity test: each of these silently
  // deleted would pass node --check while gutting the feature.
  const fs = require("fs"), path = require("path");
  const pl = fs.readFileSync(path.join(__dirname, "..", "src", "poller.js"), "utf8");
  for (const pin of [
    "async function fetchMacro()", "api.stlouisfed.org/fred/", "process.env.FRED_KEY",
    "include_release_dates_with_no_data", 'realtime_end: "9999-12-31"',
    "function macroProx(nowMs)", "function loadMacroCache()", "function macroCrossed()",
    "g.mac = mp", "g.macguard = true", "mG.mg = 1",                    // signals guard + ledger stamp
    "macroWithin(macroCache && macroCache.entries || [], now, meta.horizonMs)",   // actionable
    "ctx.macro = { next: mn, recent: mr }",                            // report context
    'kind: "macro_event"',                                             // deterministic report flag
    "context.macro, when present",                                     // prompt contract
    "macro: macroCache && Array.isArray(macroCache.entries)",          // payload fold
    "store.saveMacro", "loadMacroCache(); } catch",
  ]) assert.ok(pl.includes(pin), "poller pin missing: " + pin);
  assert.equal(pl.match(/async function fetchMacro\(\)/g).length, 1, "one fetch engine, exactly");
  // one guard block: the macro trim must not apply when the earnings guard already trimmed
  assert.ok(pl.includes("if (!g.earnguard && g.evp > 8)"), "single-trim rule: capped once, not twice");
  const st = fs.readFileSync(path.join(__dirname, "..", "src", "store.js"), "utf8");
  for (const pin of ["saveMacro(data)", "loadMacro()", 'macroFile = path.join(dataDir, "macro.json")'])
    assert.ok(st.includes(pin), "store pin missing: " + pin);
  const sv = fs.readFileSync(path.join(__dirname, "..", "server.js"), "utf8");
  assert.ok(sv.includes('const VERSION = "2026.09.24-95"'), "build stamp");
  const ht = fs.readFileSync(path.join(__dirname, "..", "public", "index.html"), "utf8");
  for (const pin of ['id="macrostrip"', 'id="tab-calendar"', ">Calendar</button>"])
    assert.ok(ht.includes(pin), "index pin missing: " + pin);
  const cs = fs.readFileSync(path.join(__dirname, "..", "public", "styles.css"), "utf8");
  for (const pin of [".macrostrip", ".macrostrip.result", ".macrostrip[hidden]{display:none}", ".earn-row.mrow", ".earn-mk", ".act-mwarn"])
    assert.ok(cs.includes(pin), "css pin missing: " + pin);
});

// ================================================================================================
// live "now" batch (build 2026.07.27-29): the three numbers every claim view owes the reader —
// the price it fired at, the price now, and which way that is FOR THIS CLAIM. Client-side join
// against the streaming snapshot: the cached ledger payload is untouched by design.
// ================================================================================================

test("now -29: the chip family is wired into both claim views, and the payload stayed untouched", () => {
  const fs = require("fs"), path = require("path");
  const app = require("./_client").clientSource();
  // the shared helpers, each defined exactly once (the integrity manifest counts them too)
  for (const f of ["liveMark", "claimDelta", "brkBar", "nowChip"])
    assert.equal((app.match(new RegExp("^function " + f + "\\(", "gm")) || []).length, 1, `exactly one ${f}`);
  // live mark comes from the client's OWN snapshot — never from the ledger payload
  assert.ok(app.includes("function liveMark(coin){ const r=coin?state.rows.get(coin):null;"),
    "liveMark must read state.rows (the streaming snapshot), not a ledger field");
  // consumer 1: the history table — a now cell on every row shape, and the column header
  assert.ok(app.includes("const nowc = `<td>${nowChip(e.coin||e.tk, { side:e.side, mark0:e.mark0, stp:e.stp, tgt:e.tgt, status:e.status }, { wrap:false })}</td>`;"),
    "sigHistRow must build the now cell from the claim's own frozen fields");
  assert.equal((app.match(/\$\{nowc\}/g) || []).length, 3, "now cell on all three row shapes (open, void, resolved)");
  assert.ok(/<th data-tip="live price against this claim[\s\S]{0,900}>now<\/th>/.test(app), "the now column header ships with its disclosure");
  // consumer 2: the signal card — both trigChip branches
  assert.equal((app.match(/\+nowChip\(g\.coin,c,\{scored:g\.scored\}\)/g) || []).length, 2, "the card's now chip rides BOTH trigChip branches (merged and diverged stamps), carrying the -31 resolution stub");
  // -29 bug fix: the fire mark is unconditional on the diverged branch
  assert.ok(app.includes("const atPx=c&&c.px!=null?` <span class=\"sec\">@ ${fmtPrice(c.px)}</span>`:(c?' <span class=\"na\">@ \\u2014</span>':'');"),
    "the claim's fire mark must ride the presence chip unconditionally — it used to vanish once the stamps diverged");
  // and the server payload did NOT grow a live price: that would bust the content ETag every tick
  const srv = fs.readFileSync(path.join(__dirname, "..", "server.js"), "utf8");
  assert.ok(!/livePx|nowPx/.test(srv), "no live price in the served payload — the ETag economy stays intact");
  const css = fs.readFileSync(path.join(__dirname, "..", "public", "styles.css"), "utf8");
  for (const cls of [".nowchip", ".nowbrk", ".nowbrk i.tgt", ".nowbrk i.stp", ".nowbrk .z"])
    assert.ok(css.includes(cls), `styles.css missing -29 class: ${cls}`);
});

test("-06 wiring pins: panels + guards + chip anatomy + verbs + honest copy exist end to end", () => {
  const fs = require("fs"), path = require("path");
  const ht = fs.readFileSync(path.join(__dirname, "..", "public", "index.html"), "utf8");
  assert.ok(ht.includes('<div id="ratiopanel" class="corrpanel" hidden></div>'), "ratio panel div, born hidden");
  assert.ok(ht.includes('<div id="basketpanel" class="corrpanel" hidden></div>'), "basket manager div, born hidden");
  const app = require("./_client").clientSource();
  for (const pin of ["function renderBasketPanel(", "function openRatio(", "function renderRatio(", "function ratioSvg(",
    "function termBasket(", "function termRatio(", "function loadBaskets(", "function basketTip(", "function compgBasketBars(",
    "if(h==='basket') return termBasket", "if(h==='ratio') return termRatio",
    "renders as a GAP, never a renormalized guess",
    "No shorter EMA ever wears the 200 name",
    "intrabar extremes finer than 1H not captured",
    "never enter signal math"]) assert.ok(app.includes(pin), "app.js pin missing: " + pin);
  assert.ok(app.includes("\\u2b12"), "the \u2b12 basket glyph is part of the chip anatomy");
  const css = fs.readFileSync(path.join(__dirname, "..", "public", "styles.css"), "utf8");
  assert.ok(css.includes(".cg-chip.bk{border-style:dashed}"), "basket chips are dashed — the anatomy IS the disclosure");
  assert.ok(css.includes(".bk-new[hidden]{display:none}") && css.includes(".rt-ctrls[hidden]{display:none}"), "flex rules carry their [hidden] guards (the display-beats-hidden bug class)");
  const srv = fs.readFileSync(path.join(__dirname, "..", "server.js"), "utf8");
  assert.ok(srv.includes('"/api/baskets"') && srv.includes('"/api/ratio"'), "both routes registered");
  assert.ok(srv.includes('poller.getBasketsStamp()'), "ETag keys fold the registry stamp");
  const st = fs.readFileSync(path.join(__dirname, "..", "src", "store.js"), "utf8");
  assert.ok(st.includes('baskets.json') && st.includes("saveBaskets") && st.includes("loadBaskets"), "registry persists on the volume, tmp+rename family");
});

test("admin panel: landscape state block, test pair, and the route that serves them", () => {
  const fs = require("fs"), path = require("path");
  const app = require("./_client").clientSource();
  assert.ok(/THE LANDSCAPE<\/div>/.test(app), "the admin box states the layer's own health");
  assert.ok(/id="adm-land"/.test(app) && /id="adm-land-f"/.test(app), "cached and fresh test fires, like the brief");
  assert.ok(/kind:'landscape'/.test(app), "routed through the one endpoint rather than a near-clone");
  assert.ok(/Interpretation, not measurement/.test(app),
    "the honesty line sits where the operator reads it");
  const srv = fs.readFileSync(path.join(__dirname, "..", "server.js"), "utf8");
  assert.ok(/b\.kind === "landscape" \? poller\.landTest : b\.kind === "desk" \? poller\.deskTest : poller\.briefTest/.test(srv));
  // The recipient chips need no new machinery — they render from schedKinds, which now carries two
  // kinds. The behavioral admin-row test above (fixture schedKinds) already proves the chip path;
  // here we pin only that the registry actually ships both.
  const C = require("../src/compute");
  assert.deepEqual(C.SCHED_KINDS.map((x) => x.k), ["brief", "landscape", "desk"]);
});

// ===== operator-only test fires + in-box schedules (build 2026.07.28-21) =======================
// Found live: the admin test buttons fired with no chat, and for an admin pushOwns says yes to
// everybody — so "send test" was a six-person broadcast standing next to a label claiming it only
// went to this browser. And the -18-era app.js that reached origin was missing the landscape admin
// box entirely (the partial-deploy lesson, now inside one upload batch).

test("test fires target the DESIGNATED operator, from any browser, and the designation is toggleable", async () => {
  process.env.TG_BOT_TOKEN = "test-token";
  const p = twoUserHarness();
  // The operator's telegram was linked from browser A; today they administer from browser B. The
  // owner-cookie version of this feature returned no-own-recipient in exactly that case — which is
  // the normal case for anyone with two machines — so targeting keys on the roster's operator flag.
  const ca = p.pushMintCode("browser-A", true); p.pushBindNow(ca.code, 7000000001, "milst");
  const cb = p.pushMintCode("own-b", false); p.pushBindNow(cb.code, 7000000002, "friend");

  const fromB = await p.briefTest(null, "browser-B", true, false, true);
  assert.equal(fromB.sent, 1, "the operator gets the test even though this browser never linked them");
  assert.equal((await p.landTest(null, "browser-B", true, false, true)).sent, 1, "landscape identical");

  // The toggle: admin-gated, both directions, and refusal is explicit when nobody holds the flag.
  assert.equal(p.pushSetPrefs("7000000002", { operator: true }, "own-b", false).error, "admin-only",
    "a public user cannot promote themselves into ops alerts and test fires");
  assert.ok(p.pushSetPrefs("7000000002", { operator: true }, "browser-B", true).ok);
  assert.equal((await p.briefTest(null, "browser-B", true, false, true)).sent, 2, "two operators, two copies");
  p.pushSetPrefs("7000000002", { operator: false }, "browser-B", true);
  p.pushSetPrefs("7000000001", { operator: false }, "browser-B", true);
  assert.equal((await p.briefTest(null, "browser-B", true, false, true)).error, "no-operator-designated",
    "zero operators refuses rather than guessing a recipient");

  // The designation survives a restart — it rides the same persist the rest of the record does.
  p.pushSetPrefs("7000000002", { operator: true }, "browser-B", true);
  p.hydratePushNow();
  assert.equal((await p.briefTest(null, "browser-B", true, false, true)).sent, 1);

  const fs = require("fs"), path = require("path");
  const srv = fs.readFileSync(path.join(__dirname, "..", "server.js"), "utf8");
  assert.ok(/!!b\.operator \|\| !!b\.mine/.test(srv), "the route passes the flag (old clients' mine still lands operator-only, never broadcast)");
});

test("terminal fund/etf: card builders render fixture payloads (behavioral), routing + grammar + NL + help + completions wired, server routes exist", () => {
  const fs = require("fs"), path = require("path");
  const app = require("./_client").clientSource();
  const srv = fs.readFileSync(path.join(__dirname, "..", "server.js"), "utf8");
  const pol = fs.readFileSync(path.join(__dirname, "..", "src", "poller.js"), "utf8");
  // Behavioral render: extract the pure builders (tmoney/tcount/termFundCard/termEtfCard) and
  // execute them against fixtures — markup must actually emerge (the -84 lesson: existence pins
  // don't prove wiring). tesc/tpad are stubbed with faithful minimal implementations.
  const seg = app.slice(app.indexOf("function tmoney("), app.indexOf("async function termFund("));
  assert.ok(seg.includes("function termEtfCard"), "builder block extractable");
  const mk = new Function("tesc", "tpad",
    seg + "; return { tmoney, tcount, termFundCard, termEtfCard };")(
    (x) => String(x).replace(/&/g, "&amp;").replace(/</g, "&lt;"), (x, n) => String(x));
  assert.equal(mk.tmoney(2.35e12), "$2.35T"); assert.equal(mk.tmoney(-4.2e9), "-$4.20B");
  assert.equal(mk.tmoney(null), "\u2014", "null money is an em-dash, never $0");
  const fc = mk.termFundCard({ ok: true, ticker: "NVDA", src: "SEC EDGAR XBRL", data: { name: "NVIDIA CORP", asOf: "2026-04-27",
    fields: { assets: { v: 1.1e11, period: "2026-04-27" }, liabilities: null, equity: null, cash: { v: 3e10, period: "2026-04-27" },
      debt: { v: 8e9, period: "2026-04-27" }, netCash: { v: 2.2e10, period: "2026-04-27" },
      revenue: { v: 1.3e11, period: "FY2026" }, netIncome: null, eps: { v: 2.94, period: "FY2026" }, shares: { v: 2.44e10, period: "2026-05-20" } } } });
  assert.ok(fc.includes("$110.00B") && fc.includes("FY2026") && fc.includes("$2.94") && fc.includes("24.40B"), "filed values render formatted");
  assert.ok(fc.includes("\u2014"), "untagged concepts render as explicit dashes");
  assert.ok(/filed figures only/.test(fc), "provenance + honest-null legend on the card itself");
  const err = mk.termFundCard({ ok: false, error: "no SEC filer found for XXX" });
  assert.ok(err.includes("no SEC filer"), "error payload renders the server's honest message verbatim");
  const ec = mk.termEtfCard({ ok: true, symbol: "QQQ", lag: "N-PORT holdings are filed monthly with a 30\u201360 day lag \u2014 latest FILED portfolio",
    data: { seriesName: "Invesco QQQ Trust", asOf: "2026-05-31", totAssets: 2.9e11, n: 101,
      holdings: [{ name: "NVIDIA CORP", pct: 9.1, val: 1 }, { name: "MICROSOFT CORP", pct: 8.2, val: 1 }] } });
  assert.ok(ec.includes("9.10%") && ec.includes("MICROSOFT") && ec.includes("of 101 positions") && /lag/.test(ec),
    "holdings table renders with truncation honesty and the staleness disclosure");
  // Wiring pins.
  assert.ok(/h==='fund'\|\|h==='bs'\|\|h==='balance'\) return termFund\(p\[1\]\)/.test(app), "termExec routes fund");
  assert.ok(/h==='etf'\|\|h==='holdings'\) return termEtf\(p\[1\]\)/.test(app), "termExec routes etf");
  assert.ok(/head==='fund'\|\|head==='bs'\|\|head==='balance'\|\|head==='etf'\|\|head==='holdings'/.test(app), "grammar-complete accepts the new heads");
  assert.ok(app.includes("'fund','etf'"), "TERM_VERBS carries the new verbs (completion engine)");
  assert.ok(/balance sheet\|fundamentals\?\|financials/.test(app), "nlResolve maps balance-sheet English to fund");
  assert.ok(/return 'etf '\+sym/.test(app), "nlResolve maps holdings English to etf, symbol may sit outside the universe");
  assert.ok(app.includes("fund <ticker>") && app.includes("etf <symbol>"), "help documents both commands");
  assert.ok(app.includes("'/api/fund/'") && app.includes("'/api/etf/'"), "client hits the new endpoints");
  assert.ok(srv.includes('"/api/fund/:t"') && srv.includes('"/api/etf/:t"'), "server routes registered");
  assert.ok(pol.includes("fund <TICKER>") && pol.includes("etf <SYMBOL>"), "planner grammar advertises the commands");
  assert.ok(pol.includes("company_tickers_mf.json") && pol.includes("NPORT-P"), "ETF lane resolves via the mf map and N-PORT filings");
  assert.ok(/EXT_ERR_TTL = 5 \* 60 \* 1000/.test(pol), "errors cache briefly — a bad symbol cannot hammer sec.gov");
  assert.ok(/user-agent": SEC_UA/.test(pol), "every EDGAR request carries the SEC_CONTACT user-agent");
});

// ===== event-loop instrumentation (build 2026.07.29-05, Phase 0 of the perf batch) ==============
// The measurement that gates every future worker-thread decision. Manifest pins because server.js
// is not importable (it starts the server), plus a real-histogram behavioral check so the ms
// conversion and window-roll math are executed, not merely grepped for.
test("loop instrumentation 2026.07.29-05: histogram armed before the store/poller, 6h roll persists atomically, health ships it", () => {
  const fs = require("fs"), path = require("path");
  const srv = fs.readFileSync(path.join(__dirname, "..", "server.js"), "utf8");
  // Armed BEFORE openStore and createPoller — arming later blinds it to boot-build stalls, which
  // are exactly the stalls the worker-thread gate needs to see.
  const arm = srv.indexOf("loopHist.enable()");
  assert.ok(arm > -1, "monitorEventLoopDelay histogram must be enabled");
  assert.ok(srv.includes("monitorEloopDelay") === false, "sanity");
  assert.ok(arm < srv.indexOf("const store = openStore("), "histogram armed before the store opens");
  assert.ok(arm < srv.indexOf("createPoller({"), "histogram armed before the poller is created");
  // Window mechanics: 6h reset cadence, 28-point (7d) ring, reset AFTER sampling, unref'd timer.
  assert.ok(srv.includes("const LOOP_WINDOW = 6 * 3600e3"), "6h window constant");
  assert.ok(srv.includes("const LOOP_RING_MAX = 28"), "7d ring cap");
  assert.ok(srv.includes("setInterval(rollLoopWindow, LOOP_WINDOW).unref()"), "roll timer armed and unref'd — instrumentation must never keep a dying process alive");
  const roll = srv.slice(srv.indexOf("function rollLoopWindow()"), srv.indexOf("setInterval(rollLoopWindow"));
  assert.ok(roll.indexOf("loopRing.push") < roll.indexOf("loopHist.reset()"), "sample is pushed to the ring BEFORE the histogram resets — reversed order records an empty window");
  assert.ok(roll.includes("s.max > loopMaxEver.v"), "maxEver tracks the worst stall with its own timestamp");
  // Persistence: atomic tmp+rename to the volume, same discipline as every other /data write, and
  // wired into BOTH exit paths — shutdown folds the open window in (redeploys < 6h apart must
  // still accumulate ring points), the crash path does the cheap sync persist only.
  assert.ok(srv.includes('const LOOP_FILE = path.join(DATA_DIR, "loop-history.json")'), "ring persists to the data volume");
  assert.ok(/const tmp = LOOP_FILE \+ "\.tmp";\s*\n\s*fs\.writeFileSync\(tmp,[\s\S]{0,120}fs\.renameSync\(tmp, LOOP_FILE\)/.test(srv), "atomic tmp+rename write");
  const shut = srv.slice(srv.indexOf("async function shutdown()"), srv.indexOf('process.on("SIGTERM"'));
  assert.ok(shut.includes("rollLoopWindow()"), "shutdown folds the still-open window into the ring");
  const crash = srv.slice(srv.indexOf("function crashFlush("), srv.indexOf('process.on("unhandledRejection"'));
  assert.ok(crash.includes("persistLoopSync()"), "crash path persists the ring synchronously");
  // Boot restore trims to the cap so a hand-edited or legacy-format file can't grow unbounded.
  assert.ok(srv.includes("loopRing = j.ring.slice(-LOOP_RING_MAX)"), "boot restore trims to the ring cap");
  // Health surface: live sample + ring + maxEver, on the existing route (no new endpoint).
  assert.ok(/\/api\/health"[\s\S]{0,600}loop: \{ \.\.\.loopSample\(\), sinceMs: Date\.now\(\) - loopResetAt, windowMs: LOOP_WINDOW, maxEver: loopMaxEver, hist: loopRing \}/.test(srv),
    "/api/health must ship the live sample, window age, maxEver and the ring");
});

test("loop instrumentation 2026.07.29-05: ms conversion against a real histogram (behavioral, not a grep)", () => {
  // Execute the same conversion server.js uses against a genuinely-enabled histogram: nanosecond
  // readings, /1e5 then /10 = milliseconds at one decimal. A histogram that has observed any event
  // loop time reports percentiles >= the 20ms resolution floor's granularity and max >= p99 >= p50.
  const { monitorEventLoopDelay } = require("perf_hooks");
  const h = monitorEventLoopDelay({ resolution: 20 });
  h.enable();
  // The histogram samples the delay of its OWN repeating timer, so it must be running before the
  // stall: a sync block placed immediately after enable() lands before the first sample and is
  // invisible (empirically verified — max reads 0). Warm up 50ms, THEN stall inside a timer.
  return new Promise((res) => setTimeout(() => {
    const t0 = Date.now(); while (Date.now() - t0 < 60) { /* spin */ }   // one deliberate ~60ms stall to observe
    setTimeout(() => {
    h.disable();
    const ms = (ns) => Math.round(ns / 1e5) / 10;
    const p50 = ms(h.percentile(50)), p99 = ms(h.percentile(99)), max = ms(h.max);
    assert.ok(Number.isFinite(p50) && Number.isFinite(p99) && Number.isFinite(max), "all three read as finite ms");
    assert.ok(p50 <= p99 && p99 <= max, `ordering must hold: p50 ${p50} <= p99 ${p99} <= max ${max}`);
    assert.ok(max >= 40, `the deliberate ~60ms stall must be visible in max (got ${max}ms)`);
    assert.ok(max < 60000, "readings are in ms, not ns — a raw-nanosecond leak reads as tens of millions");
    res();
    }, 80);
  }, 50));
});


// ===== precompressed immutable assets (build 2026.07.29-06, Phase 1 of the perf batch) ==========
test("brotli precompression 2026.07.29-06: boot compress, explicit routes, negotiation order, caching contract untouched", () => {
  const fs = require("fs"), path = require("path");
  const srv = fs.readFileSync(path.join(__dirname, "..", "server.js"), "utf8");
  // Boot-time q11 brotli + level-9 gzip fallback, size-hinted, over BOTH stamped assets.
  assert.ok(srv.includes("[zlib.constants.BROTLI_PARAM_QUALITY]: 11"), "brotli must run at maximum quality — the whole point is once-at-boot, best-possible bytes");
  assert.ok(srv.includes("[zlib.constants.BROTLI_PARAM_SIZE_HINT]: raw.length"), "size hint set");
  assert.ok(srv.includes('gz = zlib.gzipSync(raw, { level: 9 })'), "gzip fallback at max level");
  assert.ok(srv.includes('["/app.js", "app.js", "text/javascript; charset=utf-8"]') && srv.includes('["/styles.css", "styles.css", "text/css; charset=utf-8"]'),
    "both stamped assets precompress");
  // Explicit routes over the static wildcard; failure degrades to static, never to a missing asset.
  assert.ok(srv.includes("for (const route of Object.keys(PRECOMP))"), "routes registered only for assets that actually compressed — boot failure falls back to @fastify/static");
  // Negotiation: br before gzip before raw, encoding set on the reply (which makes @fastify/compress skip it).
  const h = srv.slice(srv.indexOf("for (const route of Object.keys(PRECOMP))"), srv.indexOf("// Version-stamped shell"));
  assert.ok(h.indexOf('content-encoding", "br"') > -1 && h.indexOf('content-encoding", "gzip"') > -1, "both encodings served");
  assert.ok(h.indexOf('content-encoding", "br"') < h.indexOf('content-encoding", "gzip"'), "br preferred over gzip");
  assert.ok(h.includes('reply.header("vary", "accept-encoding")'), "vary header — an intermediate cache must never hand a br body to a gzip-only client");
  // ETag is a strong content identity (sha1 of the raw bytes), honored with a real 304.
  assert.ok(srv.includes('crypto.createHash("sha1").update(raw).digest("base64url")'), "ETag keys on content, not on VERSION");
  assert.ok(h.includes('req.headers["if-none-match"] === a.tag') && h.includes("code(304)"), "if-none-match answers 304");
  // The caching CONTRACT is unchanged: route starts at no-cache, the onSend stamped-upgrade pins survive.
  assert.ok(h.includes('header("cache-control", "no-cache")'), "route default stays no-cache — only the onSend hook may upgrade");
  assert.ok(srv.includes('req.url.slice(q + 1) === "v=" + VERSION && reply.statusCode === 200 && !req.url.startsWith("/api/")'),
    "stamped-immutable upgrade untouched");
  assert.ok(srv.includes('"public, max-age=31536000, immutable"'), "immutable tier untouched");
  assert.ok(srv.includes('setHeaders(res) { res.setHeader("cache-control", "no-cache"); }'), "static fallback default untouched");
});

test("brotli precompression 2026.07.29-06: round trip with the SOURCE'S OWN params is byte-identical and actually smaller (behavioral)", () => {
  // Executes the real compression against the real shipped asset using the quality parsed FROM
  // server.js — if someone silently lowers the quality or swaps the algorithm, this test compresses
  // with whatever they shipped and the equivalence/size assertions judge the real thing.
  const fs = require("fs"), path = require("path"), zlib = require("zlib");
  const srv = fs.readFileSync(path.join(__dirname, "..", "server.js"), "utf8");
  const qm = srv.match(/BROTLI_PARAM_QUALITY\]: (\d+)/);
  assert.ok(qm, "quality param must be parseable from source");
  const raw = fs.readFileSync(path.join(__dirname, "..", "public", "app.js"));
  const br = zlib.brotliCompressSync(raw, { params: { [zlib.constants.BROTLI_PARAM_QUALITY]: Number(qm[1]), [zlib.constants.BROTLI_PARAM_SIZE_HINT]: raw.length } });
  const gz = zlib.gzipSync(raw, { level: 9 });
  assert.ok(Buffer.compare(zlib.brotliDecompressSync(br), raw) === 0, "brotli round trip must be byte-identical");
  assert.ok(Buffer.compare(zlib.gunzipSync(gz), raw) === 0, "gzip round trip must be byte-identical");
  assert.ok(br.length < gz.length && gz.length < raw.length, `size ordering must hold: br ${br.length} < gz ${gz.length} < raw ${raw.length}`);
  assert.ok(br.length < gz.length * 0.9, "q11 brotli must beat max gzip by a real margin (>10%) on app.js — if it doesn't, the boot cost buys nothing and this phase should be reverted");
});

// ===== SSE version push (build 2026.07.29-07, Phase 2 of the perf batch) =======================
test("sse push 2026.07.29-07: server — route once, versions-only frames, 1s watcher, heartbeat, cap, shutdown close", () => {
  const fs = require("fs"), path = require("path");
  const srv = fs.readFileSync(path.join(__dirname, "..", "server.js"), "utf8");
  assert.equal(srv.split('fastify.get("/api/events"').length - 1, 1, "/api/events registered exactly once");
  // Versions only, read from the SAME snapshotCache clients fetch — one code path, never a payload.
  assert.ok(srv.includes('JSON.stringify({ dataTs: s ? s.dataTs : 0, alertVer: s ? s.alertVer : 0, v: VERSION })'),
    "frames carry {dataTs, alertVer, v} and nothing else");
  assert.ok(/function sseFrame\(\) \{\s*\n\s*const s = poller\.getSnapshot\(\);/.test(srv), "frame reads poller.getSnapshot() — the same object /api/snapshot serves");
  // Watcher + heartbeat both unref'd — push infrastructure must never keep a dying process alive.
  assert.ok(srv.includes("}, 1000).unref()"), "1s change watcher, unref'd");
  assert.ok(srv.includes("}, 25000).unref()"), "25s heartbeat, unref'd");
  assert.ok(srv.includes('sseWrite(e, ": hb\\n\\n")'), "heartbeat is a comment frame — proxies stay open, clients parse nothing");
  assert.ok(srv.includes("if (ts === sseLastTs && av === sseLastAlert) return;"), "broadcast only on a real change of either clock");
  // Hijacked stream = Fastify pipeline (compress, onSend) never touches it, so headers are manual.
  assert.ok(srv.includes("reply.hijack()"), "stream must be hijacked out of the send pipeline");
  for (const hdr of ['"content-type": "text/event-stream"', '"x-accel-buffering": "no"', '"x-content-type-options": "nosniff"', '"x-frame-options": "DENY"'])
    assert.ok(srv.includes(hdr), `manual SSE header missing: ${hdr}`);
  assert.ok(srv.includes("const SSE_MAX = 200") && srv.includes('reply.code(503).send({ error: "sse-full" })'),
    "connection cap with an explicit 503 — the poll fallback fully serves an overflowing client");
  assert.ok(srv.includes("try { res.write(sseHelloFrame(me)); } catch (_) {}"), "initial sync frame on connect");
  assert.ok(/req\.raw\.on\("close", drop\);\s*\n\s*req\.raw\.on\("error", drop\)/.test(srv), "client set cleaned on close AND error");
  const shut = srv.slice(srv.indexOf("async function shutdown()"), srv.indexOf('process.on("SIGTERM"'));
  assert.ok(shut.includes("sseClients.clear()"), "shutdown ends every stream — the reconnect's first frame is the deploy notice");
});

// ===== perf phase 3 (build 2026.07.29-08): named ticks, yielding builds, the serialized chain ===
// Phase 0 measured the event loop; phase 3 makes the measurement ACTIONABLE and the offenders
// cooperative. Three commitments pinned here: every scheduled tick reports a named duration
// (/api/health carries the worst offenders), the heavy builds yield the loop instead of holding it
// for seconds, and every yielding build runs on ONE serialized chain — because yields introduce
// interleaving that synchronous execution used to forbid for free, and buildActionable reading a
// ledger mid-mutation by buildSignals is exactly the corruption the chain exists to prevent.
test("perf -08: tick instrumentation, cooperative yields and the serialized build chain are wired", () => {
  const fs = require("fs"), path = require("path");
  const pol = fs.readFileSync(path.join(__dirname, "..", "src", "poller.js"), "utf8");
  // The instrumentation choke point and its honesty split: sync duration IS loop hold (250ms
  // floor), async duration is wall time across yields (higher floor, labeled async).
  for (const pin of ["function timedTick", "function tickRecord", "SLOW_TICK_SYNC_MS = 250", "SLOW_TICK_ASYNC_MS",
    "const isAsyncFn", "function chainBuild", "const buildYield", "BUILD_YIELD_EVERY"])
    assert.ok(pol.includes(pin), `-08 instrumentation pin missing: ${pin}`);
  // safeTick routes async builds onto the chain WITHOUT changing any pinned call-site string.
  assert.ok(/const safeTick = \(fn, name\) => \(\) => \{\s*\n\s*try \{\s*\n\s*const r = isAsyncFn\(fn\) \? chainBuild\(name, fn\) : timedTick\(name, fn\);/.test(pol),
    "safeTick must be the instrumentation choke point: async -> chain, sync -> timedTick");
  // The three heavy builds are async and actually yield.
  for (const pin of ["async function buildSignals()", "async function buildActionable()", "async function buildAnalytics(scope)"])
    assert.ok(pol.includes(pin), `heavy build must be async: ${pin}`);
  assert.ok((pol.match(/await buildYield\(\);/g) || []).length >= 8, "the builds must yield between markets/sections, not just declare async");
  assert.ok(/if \(\+\+yN % BUILD_YIELD_EVERY === 0\) await buildYield\(\);/.test(pol), "per-market yield cadence in the passes");
  // Lazy self-heals fire the CHAIN, never a bare async call that could interleave.
  assert.ok(pol.includes('chainBuild("buildActionable", buildActionable)'), "getActionable's self-heal must go through the chain");
  assert.ok(pol.includes('chainBuild("buildAnalytics:" + (cr ? "crypto" : "stocks")'), "buildAnalyticsSafe must go through the chain");
  assert.ok(pol.includes("buildAnalyticsSafe(scope).catch(() => {});"), "getAnalytics fires the async self-heal and serves the fallback this once");
  // The previously bare intervals are timed + isolated now.
  assert.ok(pol.includes('setInterval(safeTick(buildSnapshot, "buildSnapshot"), 15 * 1000);'), "buildSnapshot runs through safeTick");
  assert.ok(pol.includes('setInterval(safeTick(buildDaily, "buildDaily"), 60 * 1000);'), "buildDaily runs through safeTick");
  // The names reach the wire, and the harness can settle the chain.
  assert.ok(pol.includes("ticks: [...tickStats]"), "stats() must ship the named tick durations");
  assert.ok(pol.includes("settleBuildsNow: () => buildChain"), "harness chain-settle export missing");
  // Server: the cached-serve gzip runs on the libuv threadpool, memoized promise-then-Buffer.
  const srv = fs.readFileSync(path.join(__dirname, "..", "server.js"), "utf8");
  assert.ok(srv.includes('const gzipAsync = require("util").promisify(zlib.gzip);'), "threadpool gzip helper missing");
  assert.ok(srv.includes("gz = gzipAsync(s).then((buf) => { gzipCache.set(body, buf); return buf; });"),
    "the promise must be memoized immediately so concurrent first requests share one compression");
  assert.ok(srv.includes("return Buffer.isBuffer(gz) ? reply.send(gz) : gz.then((buf) => reply.send(buf));"),
    "resolved Buffer takes the synchronous fast path; the in-flight promise is awaited, never re-compressed");
  // Client: the Loop dot names the culprit, and says when a duration is wall time, not loop hold.
  const app = require("./_client").clientSource();
  assert.ok(app.includes("worst tick: ${w.name}") && app.includes("(yielding build, wall time)"),
    "the Loop tooltip must attribute the worst tick by name and label async durations honestly");
});

// ===== build 2026.08.05-02: weekly sector audit — auto-classify + auto-graduate, transparently ==
// The classification watchdog with a write arm. The curated tables stay source code; audit
// decisions land as a persisted, revertable OVERLAY that classify() consults — graduation
// supersedes only the PREIPO row, classify entries fill only the Unclassified branch, and a
// curated SECTOR_TICKERS name can never be overridden. Everything that decides is pure and
// executed here against real shapes (the -84 lesson); the poller only fetches and assembles.
test("audit manifest: constants, routes, files, functions, css classes all pinned exactly once", () => {
  const fs = require("fs"), path = require("path");
  const pol = fs.readFileSync(path.join(__dirname, "..", "src", "poller.js"), "utf8");
  const srv = fs.readFileSync(path.join(__dirname, "..", "server.js"), "utf8");
  const sec = fs.readFileSync(path.join(__dirname, "..", "src", "sectors.js"), "utf8");
  const stf = fs.readFileSync(path.join(__dirname, "..", "src", "store.js"), "utf8");
  const app = require("./_client").clientSource();
  const css = fs.readFileSync(path.join(__dirname, "..", "public", "styles.css"), "utf8");
  const html = fs.readFileSync(path.join(__dirname, "..", "public", "index.html"), "utf8");
  const once = (s, needle, what) => assert.strictEqual(s.split(needle).length - 1, 1, what + " pinned exactly once");
  once(pol, "const SECTOR_AUDIT_TICK_MS", "audit tick cadence");
  once(pol, "const SECTOR_AUDIT_MAX_CANDIDATES", "per-run candidate cap");
  once(pol, "async function sectorAuditRun()", "run entry");
  once(pol, "function sectorAuditRevert(", "revert verb");
  once(pol, "function sectorAuditApply(", "manual apply verb");
  once(srv, '"/api/sector-audit"', "GET route");
  once(srv, '"/api/sector-audit/revert"', "revert route");
  once(srv, '"/api/sector-audit/apply"', "apply route");
  once(srv, '"/api/sector-audit/run"', "run route");
  assert.ok(srv.split("isAdmin(req)) return reply.code(403)").length - 1 >= 4, "all four audit routes 403 non-admin");
  once(sec, "function setSectorOverlay(", "overlay setter");
  once(sec, "function overlayFor(", "overlay provenance reader");
  once(stf, 'path.join(dataDir, "sector-audit.json")', "persistence file");
  once(pol, "secAuto: cl.auto || undefined", "wire provenance ships off the ONE classify() result");
  once(app, "r.secAuto=(m.secAuto!==undefined)?m.secAuto:undefined", "client clears-not-keeps provenance in lockstep with sector");
  once(css, ".auto-chip{", "provenance chip class");
  once(html, 'id="admAuditBox"', "admin panel mount");
  once(app, "async function loadAudit()", "panel loader");
});


// ===== build 2026.08.05-03: audit panel verbs — manual classify for no-data flags, "clear" ack ==
// Two admin affordances on the existing machinery, zero new decision paths: a sector picker for
// flags where NO source offered a verdict (routes through the same by:"admin" apply), and an
// acknowledgement that hides an applied row while the overlay STAYS ACTIVE — revert remains the
// only way to undo an entry, and a newer apply un-hides the row so fresh evidence gets fresh eyes.
test("audit ack: clears the row, keeps the overlay, resurfaces on re-apply, route + verb pinned", () => {
  const fs = require("fs"), path = require("path");
  const srv = fs.readFileSync(path.join(__dirname, "..", "server.js"), "utf8");
  const app = require("./_client").clientSource();
  const stf = fs.readFileSync(path.join(__dirname, "..", "src", "store.js"), "utf8");
  const once = (str, needle, what) => assert.strictEqual(str.split(needle).length - 1, 1, what + " pinned exactly once");
  once(srv, '"/api/sector-audit/ack"', "ack route");
  once(app, "'.aud-sel[data-t=", "manual sector picker wiring");
  once(app, 'class="aud-ind"', "optional industry input rendered once per flagged row template");
  assert.ok(app.includes("_audShowAck"), "show-cleared toggle present");
  // the -02 store persistence must be present — the web-UI deploy dropped it once already
  once(stf, "saveSectorAudit(data)", "audit persistence survived the deploy round-trip");

  const C = require("../src/compute");
  const base = [
    { k: "apply", ts: 1, ticker: "KLARNA", action: "classify", sector: "Financials", ind: "Fintech", ev: {}, by: "auto" },
  ];
  // ack hides but does not deactivate
  const m1 = C.mergeSectorAudit([...base, { k: "ack", ts: 2, ticker: "KLARNA" }]);
  assert.ok(m1.applied[0].ack === true, "ack folds onto the applied row");
  assert.ok(m1.active.some((a) => a.ticker === "KLARNA"), "overlay entry STAYS ACTIVE after ack");
  // a newer apply resurfaces the row
  const m2 = C.mergeSectorAudit([...base, { k: "ack", ts: 2, ticker: "KLARNA" },
    { k: "apply", ts: 3, ticker: "KLARNA", action: "classify", sector: "Financials", ind: "Payments", ev: {}, by: "auto" }]);
  assert.ok(!m2.applied[0].ack, "re-apply clears the ack — changed evidence resurfaces");
  // ack on a reverted/absent ticker is inert in the fold
  const m3 = C.mergeSectorAudit([{ k: "ack", ts: 1, ticker: "GHOST" }]);
  assert.strictEqual(m3.applied.length, 0, "stray ack folds to nothing");

  // poller verb, behaviorally
  const { createPoller } = require("../src/poller");
  const S = require("../src/sectors");
  const store = { loadAll: () => new Map(), loadRegime: () => [], loadLedger: () => null,
    saveLedger: () => {}, insert: () => {}, saveRegime: () => {},
    saveSectorAudit: () => true, loadSectorAudit: () => null };
  const p = createPoller({ dex: "xyz", store, log: () => {}, version: "test", crypto: false });
  try {
    p.auditSeedNow([{ k: "apply", ts: 1, ticker: "KLARNA", action: "classify", sector: "Financials", ind: "Fintech", ev: {}, by: "auto" },
      { k: "flag", ts: 2, ticker: "NEWBOTCO", action: "classify", reason: "no-data", ev: {} }]);
    assert.ok(!p.sectorAuditAck("NOPE").ok, "ack requires an applied entry");
    assert.ok(p.sectorAuditAck("KLARNA").ok, "ack applies");
    assert.ok(p.sectorAuditAck("KLARNA").ok, "ack is idempotent");
    assert.ok(p.getSectorAudit().applied.find((a) => a.ticker === "KLARNA").ack, "served payload carries ack");
    assert.strictEqual(S.classify("KLARNA", "xyz").sector, "Financials", "board classification untouched by ack");
    // the no-data manual path: same apply verb, admin-stamped, full machinery — now WITH an
    // optional industry group (sanitized, capped, sector fallback when blank)
    assert.ok(p.sectorAuditApply("NEWBOTCO", "Industrials", " Robotics<b> ").ok, "no-data flag resolves via manual apply");
    const u = S.classify("NEWBOTCO", "xyz");
    assert.deepStrictEqual([u.sector, u.ind, u.auto], ["Industrials", "Roboticsb", "cls"], "manually classified with sanitized industry + provenance");
    assert.ok(p.sectorAuditRevert("NEWBOTCO").ok && S.classify("NEWBOTCO", "xyz").assetClass === "Unclassified",
      "and revertable like every overlay entry");
  } finally { S.setSectorOverlay([]); p.stop && p.stop(); }
});

test("focus -01: manifest pins — the tab, the route, the engine and the client wiring hold", () => {
  const fs = require("fs"), path = require("path");
  const rd = (f) => fs.readFileSync(path.join(__dirname, "..", f), "utf8");
  const cmp = rd("src/compute.js"), pol = rd("src/poller.js"), srv = rd("server.js"),
    app = require("./_client").clientSource(), idx = rd("public/index.html"), css = rd("public/styles.css"), sto = rd("src/store.js");
  // manifest: the focus tab exists, soaks admin, and owns exactly its route
  assert.ok(cmp.includes('{ key: "focus",      kind: "tab", label: "Focus",       def: "admin",  routes: ["/api/focus"] }'), "focus manifest entry (admin soak)");
  // server: the route serves keyed on the focus stamp; the chart's 1m branch exists and is no-store
  assert.ok(srv.includes('fastify.get("/api/focus"'), "focus route");
  assert.ok(srv.includes('"focus|" + poller.getFocusStamp()'), "focus ETag keys on the stamp");
  // chart source contract (re-pinned 2026.08.17-01): the 1m live branch is RETIRED — its absence
  // is the pin now, and the chart must read the archive's 5m route instead.
  assert.ok(!srv.includes('req.query.res === "1m"') && !srv.includes("poller.getCandles1m("), "the live 1m branch stays retired");
  // poller: engine doctrine strings — home-session exclusion, the late stamp disclosure, the +1h
  // fill, the boot hydrate, and the exports. The old "const FOCUS_MIN_VOL = 200000" pin RETIRED at
  // 2026.08.18-03: the wall is no longer a poller constant, it is compute's clamped backstop under
  // an operator-set floor. Its absence from the poller is the pin now, alongside the gate call.
  assert.ok(!pol.includes("FOCUS_MIN_VOL"), "the hard-coded poller volume floor stays retired");
  // The home-session exclusion moved INTO focusEligible at 2026.08.18-03 (one structural
  // predicate for the engine and the panel scan). The doctrine is unchanged; the pin follows it.
  for (const pin of ["if (homeMkt(r.ticker, r.uni)) return null;", "function focusEligible(", "function focusScan(",
    "const g = focusGate(cands, focusLim, FOCUS_BELOW_N);",
    "function focusTick(", "function stampFocus(", "function fillFocus(", "function hydrateFocus(",
    "late: now - sess.open > 90 * 1000 ? 1 : 0", "getFocusStamp: () => focusVer", "focusTickNow: focusTick",
    "setFocusLimits,"])
    assert.ok(pol.includes(pin), "poller pin: " + pin);
  // store: persistence is atomic tmp+rename like every config-grade write
  assert.ok(sto.includes("saveFocus(data)") && sto.includes("loadFocus()") && sto.includes('focusFile + ".tmp"'), "focus persistence, atomic");
  // client: tab wired into every navigation surface, prefs persisted, chart one-source
  assert.ok(idx.includes('data-view="focus"') && idx.includes('id="view-focus"'), "tab + section in markup");
  for (const pin of ["setHidden('view-focus', v!=='focus');", "if(v==='focus'){ if(el('view-focus')) openFocus();",
    "'markets','focus','funds','trend'", "{v:'focus',label:'Focus'}", "const FOC_LS='xyz-focus-cols'",
    "function focChartOpen(", "res=5m&from=", "&max=2000", "function focAgg(", "focus:`"])
    assert.ok(app.includes(pin), "app pin: " + pin);
  assert.ok(css.includes(".foctbl") && css.includes(".focchip") && css.includes("#focmodal"), "focus styles present");
  // crypto scope: focus deliberately NOT in CRYPTO_VIEWS — the tab hides on the crypto board
  const cv = app.match(/const CRYPTO_VIEWS=new Set\(\[(.*?)\]\)/);
  assert.ok(cv && !cv[1].includes("'focus'"), "focus stays out of the crypto scope by design");
});

test("whale wiring manifest: feature keys, routes, tab markup, terminal + planner grammar, store pair, exports", () => {
  const fs = require("fs"), path = require("path");
  const C = require("../src/compute");
  const funds = C.FEATURES.find((f) => f.key === "funds");
  assert.ok(funds && funds.kind === "tab" && funds.def === "admin", "FUNDS ships admin, flippable public");
  assert.deepEqual(funds.routes, ["/api/whale"], "one exact read path carries the whole tab");
  const ww = C.FEATURES.find((f) => f.key === "whale.write");
  assert.ok(ww && ww.def === "admin" && ww.routes[0] === "POST /api/whale/watch", "writes gate separately from the tab");
  const sv = fs.readFileSync(path.join(__dirname, "..", "server.js"), "utf8");
  assert.ok(sv.includes('fastify.get("/api/whale"') && sv.includes('fastify.post("/api/whale/watch"'), "routes registered");
  assert.ok(/op === "seen"[\s\S]{0,120}?if \(!isAdmin\(req\)\) return/.test(sv), "seen is any-viewer; every other write rechecks the admin cookie in-handler");
  const ih = fs.readFileSync(path.join(__dirname, "..", "public", "index.html"), "utf8");
  assert.ok(ih.includes('data-view="funds"') && ih.includes('id="view-funds"'), "tab button + section in the shell");
  const app = require("./_client").clientSource();
  assert.ok(app.includes("'funds'") && /setHidden\('view-funds', v!=='funds'\)/.test(app), "showView wired");
  assert.ok(/if\(v==='funds'\)\{ if\(el\('view-funds'\)\) openFunds\(\)/.test(app), "open hook");
  assert.ok(/h==='whale'\|\|h==='13f'\) return termWhale/.test(app), "termExec routes whale");
  assert.ok(app.includes("'fund','etf','whale'"), "TERM_VERBS carries whale (completion engine)");
  assert.ok(app.includes("data-whale=") && app.includes("whlOpenFund(k)"), "news filings lane deep-links a whale row to the FUNDS tab, never a ticker drawer");
  assert.ok(app.includes("no prior filing ingested") && app.includes("share count not claimed"), "honest-null framing rendered, not implied");
  const pol = fs.readFileSync(path.join(__dirname, "..", "src", "poller.js"), "utf8");
  assert.ok(pol.includes("whale <FUND>") && pol.includes("whale season") && pol.includes("context.whales"), "planner grammar advertises the family and the watchlist rides the context");
  assert.ok(/WHALE_IN_WINDOW_MS = 30 \* 60 \* 1000/.test(pol) && /WHALE_OFF_WINDOW_MS = 24 \* HOUR/.test(pol), "window-aware poll cadence pinned");
  const st = fs.readFileSync(path.join(__dirname, "..", "src", "store.js"), "utf8");
  assert.ok(st.includes("saveWhale(data)") && st.includes("loadWhale()"), "store pair present");
  const css = fs.readFileSync(path.join(__dirname, "..", "public", "styles.css"), "utf8");
  assert.ok(css.includes(".whl-cell.new") && css.includes("#tab-funds.whl-dot::after"), "crowding cells + tab dot styled");
});

test("whale pull -03: 'find latest filing' populates a dash row on demand, first ingest is silent, a NEW accession on a watched book announces, cooldown holds", async () => {
  const { createPoller } = require("../src/poller");
  const store = { loadAll: () => new Map(), loadRegime: () => [], loadLedger: () => null,
    saveLedger: () => {}, insert: () => {}, saveRegime: () => {}, saveNews: () => {}, loadNews: () => null,
    saveWhale: () => {}, loadWhale: () => null };
  const J = (o) => ({ ok: true, json: async () => o, text: async () => JSON.stringify(o) });
  const X = (t2) => ({ ok: true, json: async () => { throw new Error("xml"); }, text: async () => t2 });
  const info = (v) => `<x><infoTable><nameOfIssuer>APPLE INC</nameOfIssuer><cusip>037833100</cusip><value>${v}</value><shrsOrPrnAmt><sshPrnamt>10</sshPrnamt><sshPrnamtType>SH</sshPrnamtType></shrsOrPrnAmt></infoTable></x>`;
  // Staged submissions: the Q2 filing "lands at EDGAR" only after stage flips — this is how the
  // test tells backfill (first ingest, silent) from news (new accession on a watched book).
  let stage = 1;
  const NOWD = Date.now();
  const freshDate = new Date(NOWD - 2 * 86400e3).toISOString().slice(0, 10);   // filed 2d ago — inside the 7d freshness leg
  const hits = [];
  const extFetch = async (url) => { hits.push(url);
    if (url.includes("company_tickers")) return J({});
    if (url.includes("submissions/CIK0001067983")) {
      const one = { form: ["13F-HR"], accessionNumber: ["0001-26-000001"], filingDate: ["2026-05-15"], reportDate: ["2026-03-31"] };
      const two = { form: ["13F-HR", "13F-HR"], accessionNumber: ["0001-26-000002", "0001-26-000001"], filingDate: [freshDate, "2026-05-15"], reportDate: ["2026-06-30", "2026-03-31"] };
      return J({ name: "BERKSHIRE HATHAWAY INC", filings: { recent: stage === 1 ? one : two } });
    }
    if (url.includes("submissions/CIK0000000555")) return J({ name: "STEADY FUND LP", filings: { recent: {
      form: ["13F-HR"], accessionNumber: ["0005-26-000001"], filingDate: ["2026-05-15"], reportDate: ["2026-03-31"] } } });
    if (url.includes("submissions/CIK0000424242")) return J({ name: "NOT A 13F SHOP LLC", filings: { recent: {
      form: ["8-K", "10-K"], accessionNumber: ["a", "b"], filingDate: ["2026-08-01", "2026-02-01"], reportDate: ["", ""] } } });
    if (url.includes("/000126000001/index.json") || url.includes("/000526000001/index.json"))
      return J({ directory: { item: [{ name: "primary_doc.xml", size: 900 }, { name: "infotable.xml", size: 5000 }] } });
    if (url.includes("/000126000002/index.json")) return J({ directory: { item: [{ name: "primary_doc.xml", size: 900 }, { name: "infotable.xml", size: 6000 }] } });
    if (url.includes("/000126000001/infotable.xml")) return X(info(1000));
    if (url.includes("/000126000002/infotable.xml")) return X(info(1500));
    if (url.includes("/000526000001/infotable.xml")) return X(info(700));
    return { ok: false, status: 404, error: "404" };
  };
  const p = createPoller({ dex: "xyz", store, log: () => {}, version: "test", crypto: false, extFetch });
  p.hydrateWhaleNow();
  p.whaleAdd(1067983, "Berkshire Hathaway Inc");
  p.whaleAdd(555, "Steady Fund LP");
  // Stage 1 — a scheduled tick backfills Q1 for both. First ingest: SILENT, whatever the date.
  await p.whaleTickNow(NOWD - 25 * 3600e3);
  assert.equal(p.getWhale().watch[0].q, "Q1 2026");
  assert.equal(p.getWhale().unseenAny, 0, "first-ever ingest is backfill — no badge, no alert");
  // Stage 2 — the Q2 filing lands at EDGAR; the operator hits the button instead of waiting.
  stage = 2;
  let r = await p.whalePull("BERKSHIRE");
  assert.ok(r.ok, "pull ingests: " + (r.error || ""));
  assert.equal(r.ingested, true); assert.equal(r.q, "Q2 2026"); assert.equal(r.total, 1500);
  assert.equal(p.getWhale().watch[0].q, "Q2 2026", "dash-to-data without waiting out the cadence");
  assert.equal(p.getWhale().watch[0].unseen, 1, "a NEW accession on a fund that already had a book IS news — badged and announced");
  p.whaleSeen("BERKSHIRE");
  // Already current: pull on a fund whose newest is on file reports 'up to date', not a fake
  // refresh. Runs BEFORE the zero-fetch check below — this pull also stamps STEADY's cadence, so
  // the tick that follows has NO fund legitimately due (the first draft asserted zero fetches
  // while STEADY's 25h-old stamp made one re-poll correct, and the suite rightly said so).
  r = await p.whalePull("STEADY");
  assert.ok(r.ok && r.ingested === false && /already up to date/.test(r.note), "honest no-op when EDGAR has nothing newer");
  // Cooldown: a double-click is one fetch; and the scheduled tick right after fetches nothing either.
  const n0 = hits.length;
  r = await p.whalePull("BERKSHIRE");
  assert.ok(!r.ok && /once a minute/.test(r.error), "60s per-fund cooldown, said out loud");
  await p.whaleTickNow(NOWD);
  assert.equal(hits.length, n0, "both cadences stamped by their pulls — zero back-to-back EDGAR hits from click or tick");
  // A watched filer with no 13F history: the button tells the truth instead of spinning forever.
  p.whaleAdd(424242, "Not A 13F Shop LLC");
  r = await p.whalePull("NOT");
  assert.ok(!r.ok && /no 13F-HR on record/.test(r.error), "non-filer -> honest reason, not an empty row and silence");
  r = await p.whalePull("NOPE");
  assert.ok(!r.ok && /not watching/.test(r.error));
  const fs = require("fs"), path = require("path");
  const sv = fs.readFileSync(path.join(__dirname, "..", "server.js"), "utf8");
  assert.ok(/op === "pull"[\s\S]{0,80}whalePull/.test(sv), "route op wired");
  assert.ok(sv.indexOf('op === "pull"') > sv.indexOf("if (!isAdmin(req)) return"), "pull sits BEHIND the in-handler admin recheck");
  const app = require("./_client").clientSource();
  assert.ok(app.includes("data-whlpull=") && app.includes("find latest filing") && app.includes("sub==='pull'"), "row button + terminal verb present");
  assert.ok(/data-whlbell\],\[data-whlrm\],\[data-whlpull\]/.test(app), "row-open click guard knows the new button — a pull click must not also open the modal");
});

// ============================================================================================
// FOCUS -03 (build 2026.08.17-01): chart re-sourced — 72h from the 5m archive, TFs 5m/15m/1h/4h.
// ============================================================================================
test("focus chart -17.01: manifest pins — archive-sourced 72h chart, retired 1m path stays dead", () => {
  const fs = require("fs"), path = require("path");
  const rd = (f) => fs.readFileSync(path.join(__dirname, "..", f), "utf8");
  const app = require("./_client").clientSource(), pol = rd("src/poller.js"), srv = rd("server.js");
  // timeframe set: exactly 5/15/60/240, 3m gone, default 15m
  for (const pin of ['data-foctf="5"', 'data-foctf="15" class="on"', 'data-foctf="60"', 'data-foctf="240"'])
    assert.ok(app.includes(pin), "tf pin: " + pin);
  assert.ok(!app.includes('data-foctf="3"'), "the 3m button stays retired");
  assert.ok(app.includes("const FOCCH_HOURS=72"), "72h lookback constant");
  assert.ok(app.includes("FOCCH.tf=15"), "default timeframe is 15m over a 72h span");
  // one-source rule: the chart reads the archive route, never a live candle pull
  assert.ok(app.includes("res=5m&from=") && app.includes("&max=2000"), "archive fetch with the anti-coarsen cap");
  assert.ok(!app.includes("res=1m"), "no 1m fetch remains anywhere in the client");
  assert.ok(app.includes("res.enabled===false"), "a disabled archive is said out loud, not rendered as an empty tape");
  // calendar-driven shading: the payload ships session windows and the client consumes them
  assert.ok(pol.includes("sessions: marketSessions(now - 78 * HOUR, now + 36 * HOUR)"), "session windows ride the focus payload");
  // -19-04: the read moved into focChartSessions, the ONE window list the shading, the VWAP and the
  // frozen lines all consume — the pin follows the invariant, not the old inline expression.
  assert.ok(app.includes("function focChartSessions(") && app.includes("FOC.data.sessions") && app.includes("OFF-SESSION"), "client shades off-session from the calendar, labels the crosshair");
  assert.ok(!pol.includes("getCandles1m,"), "poller no longer exports a 1m getter");
  assert.ok(srv.includes("res=1m RETIRED"), "the retirement is documented at the route, not silently deleted");
});

test("focus -04: manifest pins — the gate, the routes, the two-lock write, the panel and the roster", () => {
  const fs = require("fs"), path = require("path");
  const rd = (f) => fs.readFileSync(path.join(__dirname, "..", f), "utf8");
  const cmp = rd("src/compute.js"), pol = rd("src/poller.js"), srv = rd("server.js"),
    app = require("./_client").clientSource(), idx = rd("public/index.html"), css = rd("public/styles.css");
  // manifest: the write verb owns its own act key, path-wide (the GET returns the scan and is
  // exactly as admin-only as the write), so opening the focus TAB can never open the wall.
  assert.ok(cmp.includes('{ key: "focus.limits",  kind: "act", label: "Set FOCUS liquidity floors", def: "admin", routes: ["/api/focus/limits"] }'),
    "focus.limits manifest entry (admin, path-wide)");
  const { featureGateFor } = require("../src/compute");
  assert.equal(featureGateFor("POST", "/api/focus/limits", {}, false), "focus.limits", "a public caller is gated on the write");
  assert.equal(featureGateFor("GET", "/api/focus/limits", {}, false), "focus.limits", "…and on the read, which carries the scan");
  assert.equal(featureGateFor("GET", "/api/focus/limits", {}, true), null, "admin proceeds");
  // compute: the three pure pieces and the backstop live here, not in the poller
  for (const pin of ["const FOCUS_HARD_VOL = 200000", "function focusLimits(", "function focusFloorFail(",
    "function focusGate(", "module.exports.focusGate = focusGate;"])
    assert.ok(cmp.includes(pin), "compute pin: " + pin);
  // poller: one eligibility predicate, the gate at BOTH call sites, the frozen wall on the record
  assert.ok(!pol.includes("FOCUS_MIN_VOL"), "no second volume floor survives in the poller");
  assert.equal(pol.split("focusGate(cands, focusLim").length - 1, 2, "the gate runs at exactly two call sites — preview and stamp, one wall");
  assert.equal(pol.split("function focusEligible(").length - 1, 1, "exactly one structural predicate");
  for (const pin of ["limits: g.limits, scanned: g.scanned, cleared: g.pass.length, below: g.below, belowN: g.belowN",
    "function setFocusLimits(", "focusLim = focusLimits(data.limits);", "store.saveFocus({ state: focusState, prev: focusPrev, limits: focusLim })",
    "getFocusLimits:", "setFocusLimits,"])
    assert.ok(pol.includes(pin), "poller pin: " + pin);
  // the write must not touch the frozen record — the absence of a focusState mutation is the pin
  const setBody = pol.slice(pol.indexOf("function setFocusLimits("), pol.indexOf("function focusEligible("));
  assert.ok(!/focusState\s*=/.test(setBody), "setting floors never rewrites today's stamp");
  assert.ok(setBody.includes("focusPv = null;"), "…it drops the live preview pool so the prep list re-gates");
  // server: both verbs, admin re-checked in-handler on top of the manifest gate (two locks)
  assert.ok(srv.includes('fastify.get("/api/focus/limits"') && srv.includes('fastify.post("/api/focus/limits"'), "both limit routes");
  assert.equal(srv.split("poller.setFocusLimits(").length - 1, 1, "exactly one writer");
  const limBlock = srv.slice(srv.indexOf('fastify.get("/api/focus/limits"'), srv.indexOf('fastify.get("/api/whale"'));
  assert.equal(limBlock.split("isAdmin(req)").length - 1, 2, "both verbs re-check the admin cookie — manifest visibility and authz are separate axes");
  assert.ok(limBlock.includes('cache-control", "no-store"'), "the scan is never cached — calibrating against yesterday's volumes is the failure this prevents");
  // client: the panel, its hover contract, and the roster
  for (const pin of ["function renderAdmFloors(", "function admFlHist(", "function admFlProject(",
    "async function saveAdmFloors(", "loadAdmFloors();", "function focBelowHtml(", "FOC.showBelow"])
    assert.ok(app.includes(pin), "app pin: " + pin);
  assert.ok(idx.includes('id="admFloorsBox"'), "the panel has a mount point in the admin view");
  // EVERY bar carries a readout (the standing hover contract for charts) and the floor line is draggable
  assert.ok(/admfl-bar[^"]*"[^>]*data-tip=/.test(app), "every histogram bar carries a hover readout");
  assert.ok(app.includes("sv.addEventListener('mousedown'") && app.includes("sv.addEventListener('mousemove'"), "the floor line is draggable on the chart");
  // the panel reconciles with the SERVER's resolved floors, never with what was asked
  assert.ok(app.includes("_admFlV=d.limits.vol; _admFlO=d.limits.oi;"), "the save path adopts the server's clamped answer");
  // the roster reads the RECORD's own wall, never the live one
  assert.ok(app.includes("focBelowHtml(day,day.limits||d.limits)"), "the stamped table's roster reads the record's own floors");
  assert.ok(css.includes(".focbf") && css.includes(".admfl-hist") && css.includes(".admfl-bar"), "roster + panel styles present");
});

test("whale who-holds (2026.08.18-05): reverse lookup matches by ticker/name/substring/cusip with disclosed basis, keeps option lines separate, surfaces exits, misses honestly", async () => {
  const { createPoller } = require("../src/poller");
  const store = { loadAll: () => new Map(), loadRegime: () => [], loadLedger: () => null,
    saveLedger: () => {}, insert: () => {}, saveRegime: () => {}, saveNews: () => {}, loadNews: () => null,
    saveWhale: () => {}, loadWhale: () => null };
  const J = (o) => ({ ok: true, json: async () => o, text: async () => JSON.stringify(o) });
  const X = (t) => ({ ok: true, json: async () => { throw new Error("xml"); }, text: async () => t });
  const row = (nm, cu, v, sh, pc) => `<infoTable><nameOfIssuer>${nm}</nameOfIssuer><cusip>${cu}</cusip><value>${v}</value><shrsOrPrnAmt><sshPrnamt>${sh}</sshPrnamt><sshPrnamtType>SH</sshPrnamtType></shrsOrPrnAmt>${pc ? "<putCall>" + pc + "</putCall>" : ""}</infoTable>`;
  // Fund A: AAPL common (trimmed) + AAPL puts (new) + UNH; prior quarter had AAPL bigger + ULTA (exit).
  const A_Q2 = `<x>${row("APPLE INC", "037833100", 1000e6, 10e6)}${row("APPLE INC", "037833100", 200e6, 2e6, "Put")}${row("UNITEDHEALTH GROUP INC", "91324P102", 300e6, 1e6)}</x>`;
  const A_Q1 = `<x>${row("APPLE INC", "037833100", 1500e6, 15e6)}${row("ULTA BEAUTY INC", "90384S303", 90e6, 2e5)}</x>`;
  // Fund B: AAPL common (added).
  const B_Q2 = `<x>${row("APPLE INC", "037833100", 400e6, 4e6)}${row("NVIDIA CORPORATION", "67066G104", 250e6, 5e5)}</x>`;
  const B_Q1 = `<x>${row("APPLE INC", "037833100", 300e6, 3e6)}${row("NVIDIA CORPORATION", "67066G104", 200e6, 4e5)}</x>`;
  const sub = (accQ2, accQ1) => J({ name: "X", filings: { recent: {
    form: ["13F-HR", "13F-HR"], accessionNumber: [accQ2, accQ1],
    filingDate: ["2026-08-14", "2026-05-15"], reportDate: ["2026-06-30", "2026-03-31"] } } });
  const idx = J({ directory: { item: [{ name: "primary_doc.xml", size: 9 }, { name: "infotable.xml", size: 999 }] } });
  const extFetch = async (url) => {
    if (url.includes("company_tickers.json")) return J({ 0: { cik_str: 1, ticker: "AAPL", title: "Apple Inc." }, 1: { cik_str: 2, ticker: "NVDA", title: "NVIDIA Corporation" } });
    if (url.includes("company_tickers_mf")) return J({ fields: ["cik"], data: [] });
    if (url.includes("submissions/CIK0000000101")) return sub("0101-26-000002", "0101-26-000001");
    if (url.includes("submissions/CIK0000000102")) return sub("0102-26-000002", "0102-26-000001");
    if (url.includes("/010126000002/infotable.xml")) return X(A_Q2);
    if (url.includes("/010126000001/infotable.xml")) return X(A_Q1);
    if (url.includes("/010226000002/infotable.xml")) return X(B_Q2);
    if (url.includes("/010226000001/infotable.xml")) return X(B_Q1);
    if (url.includes("/index.json")) return idx;
    return { ok: false, status: 404, error: "404" };
  };
  const p = createPoller({ dex: "xyz", store, log: () => {}, version: "test", crypto: false, extFetch });
  p.hydrateWhaleNow();
  p.whaleAdd(101, "Alpha Capital LP"); p.whaleAdd(102, "Beta Partners LLC");
  await p.whalePull("ALPHA"); await p.whalePull("BETA");
  // Ticker lane: AAPL resolves via the company map; basis disclosed; both funds found, sorted by size.
  let r = await p.getWhaleHolds("AAPL");
  assert.ok(r.ok, r.error || "");
  assert.ok(/ticker "AAPL"/.test(r.basis), "basis names the lane that matched");
  assert.equal(r.held, 2); assert.equal(r.watchN, 2);
  assert.equal(r.funds[0].key, "ALPHA", "sorted by combined position size");
  const alpha = r.funds[0];
  assert.equal(alpha.lines.length, 2, "common and puts are SEPARATE lines, never merged");
  const common = alpha.lines.find((l) => !l.put), puts = alpha.lines.find((l) => l.put === "put");
  assert.equal(common.d.cls, "trim"); assert.equal(common.d.dSh, -5e6, "share delta off the real delta engine");
  assert.equal(puts.d.cls, "new", "the puts line opened this quarter");
  assert.equal(common.rank, 1, "rank inside the fund's book");
  assert.equal(r.combined, 1000e6 + 200e6 + 400e6, "combined sums every matched line");
  assert.equal(r.adding, 1, "BETA's common grew — and ALPHA's NEW PUTS line must NOT count as adding (options never drive the directional strip)");
  assert.equal(r.cutting, 1, "ALPHA's common trim");
  // Exit lane: ULTA held in Q1, absent in Q2 — surfaced as an exited fund row, counted as cutting.
  r = await p.getWhaleHolds("ULTA");
  assert.ok(r.ok);
  assert.equal(r.held, 0); assert.equal(r.funds.length, 1);
  assert.equal(r.funds[0].key, "ALPHA"); assert.equal(r.funds[0].exited[0].prevVal, 90e6);
  assert.ok(r.notHeld.includes("BETA"), "the fund that never touched it is listed not-held");
  // Substring lane (>=3 chars) + name lane.
  r = await p.getWhaleHolds("unitedhealth");
  assert.ok(r.ok && r.held === 1 && r.funds[0].key === "ALPHA");
  // CUSIP lane, exact 9 chars.
  r = await p.getWhaleHolds("67066G104");
  assert.ok(r.ok && /CUSIP/.test(r.basis) && r.funds[0].key === "BETA");
  // Two-char query only matches as a ticker — no substring fishing.
  r = await p.getWhaleHolds("UN");
  assert.ok(!r.ok && r.miss === 1, "short fragments don't substring-match");
  assert.ok(/searched 2 book/.test(r.error) && /Not held \u2260 not owned/.test(r.error), "the miss states scan scope and the 13F blindness caveat");
  // Wiring pins.
  const fs = require("fs"), path = require("path");
  const sv = fs.readFileSync(path.join(__dirname, "..", "server.js"), "utf8");
  assert.ok(sv.includes("qq.holds != null") && sv.includes("getWhaleHolds"), "route branch wired");
  const app = require("./_client").clientSource();
  assert.ok(app.includes("whl-whoq") && app.includes("whlWho(") && app.includes("sub==='who'||sub==='holds'"), "panel + terminal verbs present");
  assert.ok(app.includes("data-whlopen2"), "a holds row deep-links to the fund's full book");
});

// ===== HOUSING tab (build 2026.08.21-04): source + wiring manifest =============================
test("housing tab: source + wiring manifest (FRED board, feature-gated route, view wiring)", () => {
  const fs = require("fs"), path = require("path");
  const R = (p) => fs.readFileSync(path.join(__dirname, "..", p), "utf8");
  const srv = R("server.js"), pol = R("src/poller.js"), cmp = R("src/compute.js"), sto = R("src/store.js");
  const idx = R("public/index.html"), app = require("./_client").clientSource(), css = R("public/styles.css");
  // manifest entry + gated route, declared once each
  assert.ok(/\{ key: "housing",\s+kind: "tab",\s+label: "Housing",\s+def: "admin",\s+routes: \["\/api\/housing"\] \}/.test(cmp), "FEATURES entry");
  assert.strictEqual((srv.match(/fastify\.get\("\/api\/housing"/g) || []).length, 1, "route declared once");
  assert.ok(srv.includes("poller.getHousing()"), "route reads the poller board");
  assert.ok(/getHousing\s*:/.test(pol), "poller exports getHousing");
  // fetcher contract: every series is fetched in full history, per-series isolation, FRED pacing
  for (const sid of ["MORTGAGE30US", "HOUST1F", "HOUST5F", "MSACSR", "HSN1F", "MSPUS", "BAMLC0A4CBBB"])
    assert.ok(pol.includes(`sid: "${sid}"`), "series " + sid);
  assert.ok(pol.includes('observation_start: def.start'), "full history, not latest-30");
  assert.ok(/for \(const def of HOUSING_SERIES\) \{\s*try \{\s*await sleep\(150\);/.test(pol), "per-series try + 150ms pacing");
  assert.ok(pol.includes("serving warm board"), "failed refresh keeps the warm board");
  assert.ok(pol.includes("if (!err && store.saveHousing) store.saveHousing("), "persists only good boards, store feature-detected");
  assert.ok(pol.includes("setTimeout(housingTick, 35 * 1000)"), "armed after the macro burst");
  // store pair, atomic write
  assert.ok(/saveHousing\(data\) \{\s*try \{\s*const tmp = housingFile \+ "\.tmp";/.test(sto), "atomic tmp+rename");
  assert.ok(sto.includes("loadHousing()"), "loadHousing");
  // view wiring
  assert.ok(idx.includes('data-view="housing"') && idx.includes('id="view-housing"'), "tab + section");
  assert.ok(app.includes("setHidden('view-housing', v!=='housing')"), "visibility toggle");
  assert.ok(app.includes("if(v==='housing'){ if(el('view-housing')) openHousing();"), "dispatch");
  assert.ok(/HASH_VIEWS=new Set\(\[[^\]]*'housing'/.test(app), "deep link");
  assert.ok(/CMDK_TABS=\[[\s\S]*?\{v:'housing',label:'Housing'\}/.test(app), "command palette");
  assert.ok(/\n  housing:`/.test(app) && app.includes("housing:'Housing'"), "help text + title");
  for (const fn of ["loadHousing", "openHousing", "renderHousing", "hsgLineSvg", "hsgStackSvg"])
    assert.strictEqual((app.match(new RegExp("^(?:async )?function " + fn + "\\(", "gm")) || []).length, 1, fn + " defined once");
  assert.ok(app.includes("return hoverChart(s,{w:W,h:H,pt,pb,xs,rows});"), "charts ride the shared crosshair");
  assert.ok(app.includes("attachLineHover();\n}\n") && /root\.innerHTML=tiles[\s\S]*?attachLineHover\(\);/.test(app), "hover bound after paint");
  // crypto scope untouched: housing is stocks-only macro, hidden in crypto by viewInScope
  assert.ok(!/CRYPTO_VIEWS=[^;]*housing/.test(app), "not a crypto view");
  assert.ok(css.includes(".src-chip.proxy i{background:var(--blue)}"), "proxy chip colour");
});

// The ribbon was one flex row holding the scope switcher, 18 tabs and two controls, and it had run
// out of width with four tabs already hidden to make it fit. Tabs now live in menus the admin can
// rename and re-assign. The risks guarded here: DRIFT (a tab in the manifest but in no menu), a
// hostile label reaching the page shell as markup, and the [hidden] trap that let a closed menu
// swallow every click aimed at its own trigger.
test("nav groups: every tab is placed once, and renames/moves are validated at the write", () => {
  const fs = require("fs"), path = require("path");
  const R = (p) => fs.readFileSync(path.join(__dirname, "..", p), "utf8");
  const app = require("./_client").clientSource(), css = R("public/styles.css"), cmp = R("src/compute.js"), srv = R("server.js");
  const C = require("../src/compute.js");

  // every tab the manifest ships is placed by the taxonomy — the drift guard
  const shipped = [...cmp.matchAll(/\{ key: "([a-z0-9]+)",\s+kind: "tab"/g)].map((m) => m[1]);
  assert.ok(shipped.length >= 18, "found the tab manifest (" + shipped.length + " tabs)");
  const placed = new Map();
  for (const g of C.NAV_GROUPS) for (const v of g.views) {
    assert.ok(!placed.has(v), v + " is in one group only, not " + placed.get(v) + " and " + g.key);
    placed.set(v, g.key);
  }
  for (const v of shipped) {
    assert.ok(C.NAV_PINNED.includes(v) || placed.has(v), v + " is pinned or grouped, never orphaned");
    assert.ok(!(C.NAV_PINNED.includes(v) && placed.has(v)), v + " is not both pinned and grouped");
  }
  for (const [v] of placed) assert.ok(shipped.includes(v), v + " is a real tab in FEATURES");
  for (const v of C.NAV_PINNED) assert.ok(shipped.includes(v), "pinned " + v + " is a real tab");
  assert.ok(/\{ key: "markets",[^}]*pin: true/.test(cmp), "markets is pinned in the manifest too");
  assert.ok(C.NAV_GROUPS.length >= 3 && C.NAV_GROUPS.length <= 6, "few enough menus to fit the row");

  // ---- renames -------------------------------------------------------------------------------
  const lbl = (cfg) => C.resolveNavGroups(cfg).map((g) => g.key + "=" + g.label).join(",");
  assert.ok(lbl({ labels: { tape: "Flow" } }).includes("tape=Flow"), "a rename applies");
  assert.deepStrictEqual(C.navConfigSanitize({ labels: { tape: "Tape" } }).labels, {},
    "renaming back to the default stores nothing rather than residue");
  assert.deepStrictEqual(C.navConfigSanitize({ labels: { nope: "x" } }).labels, {}, "unknown menu rejected");
  // a label is injected into the page shell, so it is cleaned at the WRITE
  for (const hostile of ['<img src=x onerror="alert(1)">', "</span><b>x</b>", "a&b'c\"d", "<<>>"])
    assert.ok(!/[<>&"']/.test(C.navLabelClean(hostile)),
      "no markup character survives a label: " + JSON.stringify(C.navLabelClean(hostile)));
  assert.strictEqual(C.navLabelClean('<img src=x onerror="alert(1)">'), "img src=x onerror=",
    "hostile input is defanged AND capped, not merely escaped at render time");
  assert.ok(C.navLabelClean("A".repeat(80)).length <= C.NAV_LABEL_MAX, "length capped");
  assert.strictEqual(C.navLabelClean("  Two   words  "), "Two words", "whitespace collapsed and trimmed");
  assert.strictEqual(C.navLabelClean("   "), "", "blank means restore the default");

  // ---- moves ---------------------------------------------------------------------------------
  const moved = C.resolveNavGroups({ views: { backtest: "research" } });
  assert.ok(!moved.find((g) => g.key === "signals").views.includes("backtest"), "leaves the old menu");
  assert.ok(moved.find((g) => g.key === "research").views.includes("backtest"), "lands in the new one");
  // order is canonical, not write-order: two admins making the same moves in a different sequence
  // must end up with the same ribbon
  const a = C.resolveNavGroups({ views: { backtest: "research", sectors: "research" } });
  const b = C.resolveNavGroups({ views: { sectors: "research", backtest: "research" } });
  assert.deepStrictEqual(a.map((g) => g.views), b.map((g) => g.views), "move order does not matter");
  assert.deepStrictEqual(C.navConfigSanitize({ views: { markets: "tape" } }).views, {}, "a pinned view cannot be moved");
  assert.deepStrictEqual(C.navConfigSanitize({ views: { admin: "tape" } }).views, {}, "nor the panel itself");
  assert.deepStrictEqual(C.navConfigSanitize({ views: { trend: "nope" } }).views, {}, "unknown target menu rejected");
  assert.deepStrictEqual(C.navConfigSanitize({ views: { trend: "tape" } }).views, {}, "a move to where it already is stores nothing");
  // a menu emptied by moves still resolves — the client hides it
  const empty = C.resolveNavGroups({ views: { report: "tape", funds: "tape", notes: "tape", congress: "tape", insiders: "tape" } });
  assert.strictEqual(empty.find((g) => g.key === "research").views.length, 0, "a menu can be emptied");

  // ---- wiring --------------------------------------------------------------------------------
  assert.ok(srv.includes('fastify.post("/api/nav-groups"'), "one route for both operations");
  assert.ok(srv.includes("window.__NAVGROUPS="), "labels are injected pre-paint, never flashed");
  assert.ok(app.includes("window.__NAVGROUPS"), "the client reads the injected set");
  assert.ok(/TAB_GROUPS = \(Array\.isArray\(window\.__NAVGROUPS\)/.test(app), "with a fallback for a failed injection");
  assert.ok(app.includes("function applyNavGroups"), "the ribbon rebuilds from the server's answer");

  // the [hidden] trap: .tabmenu/.tabgrp set display, which beats the UA rule on ORIGIN. Without
  // these a CLOSED menu still intercepted pointer events over its own trigger — caught by driving
  // a real browser, invisible to any source-level assertion.
  assert.ok(css.includes(".tabmenu[hidden]{display:none}"), "closed menu is display:none");
  assert.ok(css.includes(".tabgrp[hidden]{display:none}"), "emptied menu is display:none");
  assert.ok(app.includes("members.forEach(t=>menu.appendChild(t))"), "tabs are moved, not cloned");
  assert.ok(app.includes("if(over.parentNode!==drag.parentNode) return;"), "drag stays inside its own menu");
});

test("liquidity tab: source + wiring manifest (net liquidity math, units, Thursday refire, view wiring)", () => {
  const fs = require("fs"), path = require("path");
  const R = (p) => fs.readFileSync(path.join(__dirname, "..", p), "utf8");
  const srv = R("server.js"), pol = R("src/poller.js"), cmp = R("src/compute.js"), sto = R("src/store.js");
  const idx = R("public/index.html"), app = require("./_client").clientSource();
  assert.ok(/\{ key: "liquidity",\s+kind: "tab",\s+label: "Liquidity",\s+def: "admin",\s+routes: \["\/api\/liquidity"\] \}/.test(cmp), "FEATURES entry");
  assert.strictEqual((srv.match(/fastify\.get\("\/api\/liquidity"/g) || []).length, 1, "route declared once");
  assert.ok(/getLiquidity\s*:/.test(pol), "poller exports getLiquidity");
  // the seven series on the source page + the three we add
  for (const sid of ["WALCL", "TREAST", "FEDDT", "WSHOMCB", "WTREGEN", "RRPONTSYD", "GDP", "WRESBAL", "SOFR", "IORB"])
    assert.ok(pol.includes(`sid: "${sid}"`), "series " + sid);
  // units: H.4.1 lines + reserves publish in MILLIONS (scale 0.001 → billions); ON RRP and GDP already in billions
  for (const sid of ["WALCL", "TREAST", "FEDDT", "WSHOMCB", "WTREGEN", "WRESBAL"])
    assert.ok(new RegExp(`sid: "${sid}",[^\\n]*scale: 0\\.001`).test(pol), sid + " scaled from millions");
  for (const sid of ["RRPONTSYD", "GDP"])
    assert.ok(new RegExp(`sid: "${sid}",[^\\n]*scale: 1,`).test(pol), sid + " already billions");
  assert.ok(pol.includes("const n = a - t[1] - r;"), "net = assets − TGA − ON RRP");
  assert.ok(pol.includes("Date.parse(d) - Date.parse(rr[0])) <= 7 * 864e5 ? rr[1] : 0"), "ON RRP sampled ≤ Wednesday, zero before the facility existed");
  assert.ok(pol.includes("effect: +((drain ? -dv : dv)).toFixed(1)"), "YTD bars signed by liquidity effect");
  assert.ok(pol.includes("function liqReleaseCrossed()") && pol.includes("lastLiqOk > LIQ_STALE || liqReleaseCrossed()"), "Thursday H.4.1 refire");
  assert.ok(pol.includes("if (!err && store.saveLiquidity) store.saveLiquidity("), "persists good boards only, store feature-detected");
  assert.ok(/saveLiquidity\(data\) \{\s*try \{\s*const tmp = liqFile \+ "\.tmp";/.test(sto) && sto.includes("loadLiquidity()"), "store pair");
  assert.ok(idx.includes('data-view="liquidity"') && idx.includes('id="view-liquidity"'), "tab + section");
  assert.ok(app.includes("setHidden('view-liquidity', v!=='liquidity')"), "visibility toggle");
  assert.ok(app.includes("if(v==='liquidity'){ if(el('view-liquidity')) openLiquidity();"), "dispatch");
  assert.ok(/HASH_VIEWS=new Set\(\[[^\]]*'liquidity'/.test(app), "deep link");
  assert.ok(/CMDK_TABS=\[[\s\S]*?\{v:'liquidity',label:'Liquidity'\}/.test(app), "command palette");
  assert.ok(/const HELP=\{\s*liquidity:`/.test(app) && app.includes("liquidity:'Liquidity'"), "help text + title");
  for (const fn of ["loadLiquidity", "openLiquidity", "renderLiquidity", "liqBarsSvg", "liqStackSvg"])
    assert.strictEqual((app.match(new RegExp("^(?:async )?function " + fn + "\\(", "gm")) || []).length, 1, fn + " defined once");
  assert.ok(/root\.innerHTML=tiles\+`<div class="s-grid">\$\{cards\.join\(''\)\}<\/div>`\+stack\+drains[\s\S]*?attachLineHover\(\);/.test(app), "hover bound after paint");
  assert.ok(!/CRYPTO_VIEWS=[^;]*liquidity/.test(app), "not a crypto view");
});

test("whale 13f data-set index (2026.08.21-05): fixture ZIP through the REAL ingest — scale-corrected ranks, HR/A dedupe, period filter, options out, cap honesty, QoQ, tracked overlay", async () => {
  const { createPoller } = require("../src/poller");
  const zlib = require("zlib");
  // Byte-wise STORED-format ZIP builder — no CRC games, the reader doesn't verify them.
  const mkzip = (files) => {
    const parts = [], cd = []; let off = 0;
    for (const [name, text] of files) {
      const data = Buffer.from(text, "utf8"), nm = Buffer.from(name, "utf8");
      const lh = Buffer.alloc(30); lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt16LE(0, 8);
      lh.writeUInt32LE(data.length, 18); lh.writeUInt32LE(data.length, 22); lh.writeUInt16LE(nm.length, 26);
      parts.push(lh, nm, data);
      const ce = Buffer.alloc(46); ce.writeUInt32LE(0x02014b50, 0); ce.writeUInt16LE(0, 10);
      ce.writeUInt32LE(data.length, 20); ce.writeUInt32LE(data.length, 24); ce.writeUInt16LE(nm.length, 28);
      ce.writeUInt32LE(off, 42);
      cd.push(Buffer.concat([ce, nm]));
      off += 30 + nm.length + data.length;
    }
    const cdBuf = Buffer.concat(cd);
    const eo = Buffer.alloc(22); eo.writeUInt32LE(0x06054b50, 0); eo.writeUInt16LE(cd.length, 8); eo.writeUInt16LE(cd.length, 10);
    eo.writeUInt32LE(cdBuf.length, 12); eo.writeUInt32LE(off, 16);
    return Buffer.concat([...parts, cdBuf, eo]);
  };
  const T = (rows) => rows.map((r) => r.join("\t")).join("\n") + "\n";
  const mkSet = (period, filers) => {
    // filers: [{acc, cik, name, typ, rows:[[cusip, value, shares, shType, putCall]]}]
    const sub = [["ACCESSION_NUMBER", "CIK", "SUBMISSIONTYPE", "PERIODOFREPORT"]];
    const cov = [["ACCESSION_NUMBER", "FILINGMANAGER_NAME"]];
    const inf = [["ACCESSION_NUMBER", "NAMEOFISSUER", "TITLEOFCLASS", "CUSIP", "VALUE", "SSHPRNAMT", "SSHPRNAMTTYPE", "PUTCALL"]];
    for (const f of filers) {
      sub.push([f.acc, String(f.cik), f.typ || "13F-HR", f.period || period]);
      cov.push([f.acc, f.name]);
      for (const r of f.rows) inf.push([f.acc, "ISSUER", "COM", r[0], String(r[1]), String(r[2]), r[3] || "SH", r[4] || ""]);
    }
    return mkzip([["2026q2_form13f/SUBMISSION.tsv", T(sub)], ["2026q2_form13f/COVERPAGE.tsv", T(cov)], ["2026q2_form13f/INFOTABLE.tsv", T(inf)]]);
  };
  const CU = "595112103";
  const q2zip = mkSet("2026-06-30", [
    // Ranks by CORRECTED value must be: MEGA ($9B, filed in THOUSANDS) > BIGCO ($5B) > TRACKED1 ($3B) > SMALL ($1B).
    { acc: "A-1", cik: 11, name: "BIGCO ADVISORS", rows: [[CU, 5e9, 25e6]] },
    // Thousands convention: $200/sh real, $0.0002 implied raw. THREE rows because the scale rule's
    // own sample floor (>=3 usable rows, by design) refuses to claim anything on fewer — a real
    // filing has hundreds; a fixture must respect the precondition it is testing.
    { acc: "A-2", cik: 22, name: "MEGA CAPITAL LP", rows: [[CU, 9e6, 45e6], ["AAA000AA1", 2e6, 10e6], ["BBB000BB2", 1e6, 8e6]] },
    { acc: "A-3", cik: 33, name: "TRACKED ONE LP", rows: [[CU, 3e9, 15e6]] },
    { acc: "A-4", cik: 44, name: "SMALL FUND LLC", rows: [[CU, 1e9, 5e6]] },
    // Options desk with a HUGE call line — must NOT enter the ranks; also not the aggregate.
    { acc: "A-5", cik: 55, name: "OPTIONS DESK LLC", rows: [[CU, 20e9, 100e6, "SH", "Call"]] },
    // HR/A supersede: cik 66 filed HR then HR/A with a different size — only the /A counts.
    { acc: "A-6", cik: 66, name: "AMENDER LP", typ: "13F-HR", rows: [[CU, 8e9, 40e6]] },
    { acc: "A-7", cik: 66, name: "AMENDER LP", typ: "13F-HR/A", rows: [[CU, 0.5e9, 2.5e6]] },
    // A LATE PRIOR-PERIOD filing riding in this set — excluded by the period filter.
    { acc: "A-8", cik: 77, name: "LATE FILER LP", period: "2026-03-31", rows: [[CU, 50e9, 250e6]] },
  ]);
  const q1zip = mkSet("2026-03-31", [
    { acc: "B-1", cik: 11, name: "BIGCO ADVISORS", rows: [[CU, 4e9, 20e6]] },       // BIGCO +5M sh QoQ
    { acc: "B-2", cik: 22, name: "MEGA CAPITAL LP", rows: [[CU, 8e6, 40e6], ["AAA000AA1", 2e6, 11e6], ["BBB000BB2", 1e6, 9e6]] },   // thousands again; MEGA +5M sh on CU
    { acc: "B-3", cik: 33, name: "TRACKED ONE LP", rows: [[CU, 3.2e9, 16e6]] },     // TRACKED1 -1M sh
  ]);
  const J = (o) => ({ ok: true, json: async () => o, text: async () => JSON.stringify(o) });
  const bin = (buf) => ({ ok: true, arrayBuffer: async () => buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) });
  const extFetch = async (url) => {
    if (url.includes("company_tickers")) return J({ 0: { cik_str: 1, ticker: "MU", title: "Micron Technology Inc" } });
    if (url.includes("01jun2026-31aug2026_form13f.zip")) return bin(q2zip);   // the SEC's real filing-window name
    if (url.includes("01mar2026-31may2026_form13f.zip")) return bin(q1zip);
    if (url.includes("submissions/CIK0000000033")) return J({ name: "TRACKED ONE LP", filings: { recent: {
      form: ["13F-HR"], accessionNumber: ["0033-26-000002"], filingDate: ["2026-08-14"], reportDate: ["2026-06-30"] } } });
    if (url.includes("/003326000002/index.json")) return J({ directory: { item: [{ name: "primary_doc.xml", size: 9 }, { name: "infotable.xml", size: 99 }] } });
    if (url.includes("/003326000002/infotable.xml")) return { ok: true, json: async () => { throw new Error("x"); },
      text: async () => `<x><infoTable><nameOfIssuer>MICRON TECHNOLOGY INC</nameOfIssuer><cusip>${CU}</cusip><value>3000000000</value><shrsOrPrnAmt><sshPrnamt>15000000</sshPrnamt><sshPrnamtType>SH</sshPrnamtType></shrsOrPrnAmt></infoTable></x>` };
    return { ok: false, status: 404, error: "404" };
  };
  const os2 = require("os"), fs = require("fs"), path = require("path");
  const dir = fs.mkdtempSync(path.join(os2.tmpdir(), "t13f-"));
  const { openStore } = require("../src/store");
  const store = openStore(dir);
  const p = createPoller({ dex: "xyz", store, log: () => {}, version: "test", crypto: false, extFetch, t13fCap: 3 });
  p.hydrateWhaleNow();
  p.whaleAdd(33, "Tracked One LP");
  await p.whalePull("TRACKED");
  // Ingest both sets through the real path (prior first so QoQ has its leg).
  let r = await p.whale13fIngestNow("Q1 2026");
  assert.ok(r.ok, "Q1 ingest: " + (r.error || ""));
  r = await p.whale13fIngestNow("Q2 2026");
  assert.ok(r.ok, "Q2 ingest: " + (r.error || ""));
  assert.equal(r.scaled, 1, "MEGA's thousands-convention filing detected and corrected — the same rule the watchlist uses");
  // Query through the holds engine.
  const h = await p.getWhaleHolds(CU);
  assert.ok(h.ok && h.top, "top block rides the holds response");
  const t = h.top;
  assert.equal(t.q, "Q2 2026");
  assert.equal(t.nFilers, 5, "aggregate counts EVERY common-line holder exactly, incl. beyond the cap — the options desk's call-only book is excluded from the AGGREGATE too (common-only lane, both numbers one rule), the late prior-period filer is excluded, the HR/A pair counts once");
  assert.deepEqual(t.rows.map((x) => x.name), ["MEGA CAPITAL LP", "BIGCO ADVISORS", "TRACKED ONE LP"],
    "top-3 (cap) by CORRECTED value — a thousands filer ranks by its real $9B, an options desk's $20B call notional never outranks a real owner");
  assert.ok(t.rows.every((x) => x.name !== "AMENDER LP"), "the HR/A superseded AMENDER down to $0.5B — outside the cap, the HR's $8B never counted");
  assert.equal(t.rows[0].dSh, 5e6, "QoQ share delta vs the prior set, on corrected books");
  assert.equal(t.rows[2].dSh, -1e6);
  assert.equal(t.rows[2].tracked, "TRACKED", "your watchlist overlays by CIK");
  assert.equal(t.cap, 3, "cap disclosed on the payload");
  assert.equal(t.allNew, 0);
  // Weekly tick wiring + status shape.
  const st = p.t13fStatus();
  assert.deepEqual(st.quarters, ["Q2 2026", "Q1 2026"], "two quarters kept, newest first");
  // -06: a watchlist MISS with a CUSIP query still gets the market-wide answer — the original
  // -05 cut returned early and the panel never ran for exactly the names market-wide is FOR.
  // "AAA000AA1" lives only in MEGA's fixture filing — no tracked fund holds it.
  const miss = await p.getWhaleHolds("AAA000AA1");
  assert.ok(miss.ok && miss.missButTop === 1, "cusip miss serves the market answer");
  assert.equal(miss.top.rows[0].name, "MEGA CAPITAL LP");
  assert.ok(Math.abs(miss.top.rows[0].value - 2e9) < 1e3, "thousands-corrected even on the miss path");
  assert.equal(miss.held, 0);
  // A ticker/name miss cannot map to a CUSIP (the data set carries none) — said, not hidden.
  const miss2 = await p.getWhaleHolds("ZZZUNKNOWN");
  assert.ok(!miss2.ok && /keyed by CUSIP/.test(miss2.error), "the why-not is stated on ticker misses when an index exists");
  const app = require("./_client").clientSource();
  assert.ok(app.includes("TOP HOLDERS \\u00b7 MARKET-WIDE") && app.includes("whl-trk") && app.includes("sub==='ingest13f'"), "panel + tracked badge + admin verb wired");
  assert.ok(app.includes("INSTITUTIONAL MANAGERS only"), "the IPO invisibility banner exists");
  const sv = fs.readFileSync(path.join(__dirname, "..", "server.js"), "utf8");
  assert.ok(sv.includes('op === "ingest13f"') && sv.indexOf('op === "ingest13f"') > sv.indexOf("if (!isAdmin(req)) return"), "ingest op behind the admin recheck");
  // 2026.08.21-13: the panel renders the top 20, both query paths at the same depth, from one
  // named constant — never a bare literal that can drift between the hit and the miss path.
  const pol13 = fs.readFileSync(path.join(__dirname, "..", "src", "poller.js"), "utf8");
  assert.ok(/const T13F_TOP_SHOW = 20;/.test(pol13), "the rendered depth is 20, declared once");
  assert.equal((pol13.match(/t13fTop\([^)]*T13F_TOP_SHOW\)/g) || []).length, 2,
    "both the watchlist-hit and the CUSIP-miss path ask for the same depth");
  fs.rmSync(dir, { recursive: true, force: true });
});

// ---- CONGRESS lane phase 1 (build 2026.08.24-02) ------------------------------------------------
// The House filing INDEX ingest, end to end through the real code path against a fixture ZIP.
// Phase 1 deliberately parses no PTR documents, so what is worth pinning here is: the candidate
// URL list (the 13F lane's four fetch-layer commits are the argument for more than one), by-name
// field reading, unmapped filing-type codes surviving, upsert idempotency, and the one rule a daily
// re-sync could silently break — that re-ingesting must never reset phase 2's parse state.
test("congress -02: House index ingest — candidates, by-name parse, idempotent upsert, parse state preserved", async () => {
  const { createPoller } = require("../src/poller");
  const os2 = require("os"), fs = require("fs"), path = require("path");
  const mkzip = (files) => {
    const parts = [], cd = []; let off = 0;
    for (const [name, text] of files) {
      const data = Buffer.from(text, "utf8"), nm = Buffer.from(name, "utf8");
      const lh = Buffer.alloc(30); lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt16LE(0, 8);
      lh.writeUInt32LE(data.length, 18); lh.writeUInt32LE(data.length, 22); lh.writeUInt16LE(nm.length, 26);
      parts.push(lh, nm, data);
      const ce = Buffer.alloc(46); ce.writeUInt32LE(0x02014b50, 0); ce.writeUInt16LE(0, 10);
      ce.writeUInt32LE(data.length, 20); ce.writeUInt32LE(data.length, 24); ce.writeUInt16LE(nm.length, 28);
      ce.writeUInt32LE(off, 42);
      cd.push(Buffer.concat([ce, nm]));
      off += 30 + nm.length + data.length;
    }
    const cdBuf = Buffer.concat(cd);
    const eo = Buffer.alloc(22); eo.writeUInt32LE(0x06054b50, 0); eo.writeUInt16LE(cd.length, 8); eo.writeUInt16LE(cd.length, 10);
    eo.writeUInt32LE(cdBuf.length, 12); eo.writeUInt32LE(off, 16);
    return Buffer.concat([...parts, cdBuf, eo]);
  };
  // Element ORDER is deliberately shuffled between members: the parser reads by name, so a reorder
  // must not shift a single field. "ZZ" is an unmapped filing-type code and must survive verbatim.
  const memberXml = `<?xml version="1.0"?><FinancialDisclosure>
<Member><Prefix>Hon.</Prefix><Last>Pelosi</Last><First>Nancy</First><Suffix></Suffix><FilingType>P</FilingType><StateDst>CA11</StateDst><Year>2026</Year><FilingDate>8/13/2026</FilingDate><DocID>20033725</DocID></Member>
<Member><DocID>20033726</DocID><FilingDate>12/30/2025</FilingDate><StateDst>TN07</StateDst><FilingType>P</FilingType><Year>2026</Year><Last>Green</Last><First>Mark</First></Member>
<Member><Last>Khanna</Last><First>Ro</First><Suffix>Jr.</Suffix><FilingType>O</FilingType><StateDst>CA17</StateDst><Year>2026</Year><FilingDate>5/15/2026</FilingDate><DocID>10041234</DocID></Member>
<Member><Last>Unknown</Last><First>Code</First><FilingType>ZZ</FilingType><StateDst>NY01</StateDst><Year>2026</Year><FilingDate>6/01/2026</FilingDate><DocID>10041235</DocID></Member>
<Member><Last>Seen</Last><First>InTheWild</First><FilingType>W</FilingType><StateDst>NY02</StateDst><Year>2026</Year><FilingDate>6/02/2026</FilingDate><DocID>10041236</DocID></Member>
<Member><Last>Alt</Last><First>Shape</First><FilingType>P</FilingType><StateDst>TX01</StateDst><Year>2026</Year><FilingDate>13-AUG-2026</FilingDate><DocID>20033727</DocID></Member>
<Member><Last>NoDate</Last><First>Blank</First><FilingType>P</FilingType><StateDst>FL01</StateDst><Year>2026</Year><FilingDate>whenever</FilingDate><DocID>20033728</DocID></Member>
</FinancialDisclosure>`;
  const zip2026 = mkzip([["2026FD.xml", memberXml]]);
  // A year whose ZIP carries the tab-delimited index instead — same fields, read by header name.
  const zip2025 = mkzip([["2025FD.txt",
    "Prefix\tLast\tFirst\tSuffix\tFilingType\tStateDst\tYear\tFilingDate\tDocID\n" +
    "Hon.\tGottheimer\tJosh\t\tP\tNJ05\t2025\t7/02/2025\t20029001\n"]]);
  const bin = (buf) => ({ ok: true, arrayBuffer: async () => buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) });
  let hits = [];
  const extFetch = async (url) => {
    hits.push(url);
    if (url.endsWith("2026FD.zip") && url.includes("financial-pdfs/2026FD")) return bin(zip2026);
    if (url.endsWith("2025FD.zip") && url.includes("financial-pdfs/2025FD")) return bin(zip2025);
    if (url.includes("2019FD")) return { ok: false, status: 404 };
    return { ok: false, status: 404 };
  };
  const dir = fs.mkdtempSync(path.join(os2.tmpdir(), "congress-"));
  const { openStore } = require("../src/store");
  const store = openStore(dir);
  const p = createPoller({ dex: "xyz", store, log: () => {}, version: "test", crypto: false, extFetch });

  // Candidate URLs: MORE than one, first is the long-standing pattern, all absolute.
  const urls = p.houseIndexUrls(2026);
  assert.ok(urls.length >= 2, "the fetch layer tries more than one candidate — the 13F lane's lesson");
  assert.equal(urls[0], "https://disclosures-clerk.house.gov/public_disc/financial-pdfs/2026FD.zip");
  assert.ok(urls.every((u) => /^https:\/\/disclosures-clerk\.house\.gov\//.test(u)), "every candidate is an absolute Clerk URL");

  const r = await p.congressIngestNow(2026);
  assert.ok(r.ok, "2026 ingest: " + (r.error || ""));
  assert.equal(r.filings, 7, "every member row is stored, not just the PTRs");
  assert.equal(r.ptr, 4, "four filings carry type P");
  assert.equal(r.added, 7);
  assert.deepEqual(r.unknownTypes, ["ZZ", "W"], "unmapped filing-type codes are reported, not silently swallowed");

  const rows = p.congressFilings({ limit: 50 });
  const byId = new Map(rows.map((x) => [x.id, x]));
  const pel = byId.get("H:20033725");
  assert.ok(pel, "doc id is chamber-prefixed so the Senate can share the table later");
  assert.equal(pel.member, "Pelosi, Nancy");
  assert.equal(pel.filed, "2026-08-13", "US M/D/YYYY normalized to ISO");
  assert.equal(pel.state, "CA"); assert.equal(pel.dist, "11");
  assert.equal(pel.type, "ptr");
  assert.equal(pel.parsed, 0, "a PTR enters phase 2's queue; nothing is parsed in phase 1");
  assert.equal(pel.url, "https://disclosures-clerk.house.gov/public_disc/ptr-pdfs/2026/20033725.pdf");
  // Shuffled element order must not shift a field.
  const grn = byId.get("H:20033726");
  assert.equal(grn.member, "Green, Mark"); assert.equal(grn.filed, "2025-12-30"); assert.equal(grn.state, "TN");
  // Non-PTR filings are kept for context but never queued for parsing.
  assert.equal(byId.get("H:10041234").type, "annual");
  assert.equal(byId.get("H:10041234").parsed, null, "only PTRs are queued");
  assert.equal(byId.get("H:10041235").type, "other", "an unmapped code lands as other, with the raw code stored");
  // W, D and H all appear in the real 2026 index and the Clerk publishes no code table. This pins
  // that they stay honestly unidentified: a future "helpful" guess at a meaning fails here.
  const w = byId.get("H:10041236");
  assert.equal(w.type, "other", "a code seen live but undocumented is never assigned a meaning");
  // A document URL is only ever built for a PTR — the ptr-pdfs path is corroborated, the path for
  // other filing types is not, and a link that 404s is worse than no link.
  assert.equal(byId.get("H:10041234").url, null, "a non-PTR filing carries no guessed document URL");
  assert.equal(w.url, null);
  assert.ok(pel.url.includes("/ptr-pdfs/"), "a PTR still carries its corroborated document URL");
  // Production showed a blank earliest-filing date with no way to tell how many rows caused it or
  // what the raw value looked like. A shape the normalizer knows is read; one it does not is kept,
  // counted, and SAMPLED — never dropped, and never guessed into a plausible date.
  assert.equal(byId.get("H:20033727").filed, "2026-08-13", "an alternate date shape normalizes to ISO");
  assert.equal(byId.get("H:20033728").filed, "", "an unreadable date is blank, not invented");
  assert.equal(r.noDate, 1, "and is counted");
  assert.deepEqual(r.badDates, ["whenever"], "with the raw value sampled so the shape can be identified");
  assert.equal(p.congressStatus().counts.noDate, 1, "the count reaches the status line");
  assert.equal(p.congressStatus().counts.first, "2025-12-30",
    "the earliest-filing date ignores blank rows instead of collapsing to a dash");

  // Idempotency: the Clerk republishes the SAME zip daily, so a re-ingest must add nothing.
  const r2 = await p.congressIngestNow(2026);
  assert.ok(r2.ok && r2.added === 0 && r2.filings === 7, "re-ingesting the same index adds nothing");
  assert.equal(p.congressFilings({ limit: 50 }).length, 7, "and creates no duplicate rows");

  // The rule a daily re-sync could silently break: phase 2 marks a filing parsed, then tomorrow's
  // sync runs. If the upsert reset parsed to 0, every day would re-queue everything already done.
  store.openCongress().prepare("UPDATE filing SET parsed=1, nTx=7 WHERE id=?").run("H:20033725");
  await p.congressIngestNow(2026);
  const after = store.openCongress().prepare("SELECT parsed, nTx FROM filing WHERE id=?").get("H:20033725");
  assert.equal(after.parsed, 1, "a daily re-sync never resets phase 2's parse state");
  assert.equal(after.nTx, 7, "nor the transaction count it recorded");

  // The tab-delimited fallback index parses through the same by-name rule.
  const r3 = await p.congressIngestNow(2025);
  assert.ok(r3.ok && r3.filings === 1, "tsv fallback index: " + (r3.error || ""));
  assert.equal(p.congressFilings({ type: "ptr", limit: 50 }).length, 5, "type filter reaches both years");

  // Every candidate 404s: the error names all of them in FULL — the failure the 13F lane shipped
  // blind, where only the basename was logged and a wrong path looked like a dead process.
  const r4 = await p.congressIngestNow(2019);
  assert.ok(!r4.ok, "an unavailable year fails rather than pretending");
  assert.equal(r4.tried.length, p.houseIndexUrls(2019).length, "every candidate is reported");
  assert.ok(r4.tried.every((t) => t.startsWith("https://")), "full URLs, not basenames");

  // Status shape — what the admin verb renders.
  const st = p.congressStatus();
  assert.ok(st.ready && st.counts, "status carries readiness and counts");
  assert.equal(st.counts.n, 8); assert.equal(st.counts.ptr, 5);
  assert.equal(st.counts.pending, 4, "one PTR was marked parsed above");
  assert.ok(st.lastSync > 0, "a successful sync stamps the clock");
  assert.deepEqual(st.years.map((y) => y.yr), [2026, 2025], "newest year first");
  assert.equal(store.congressMeta("indexUrl:2026"), urls[0], "the URL that actually answered is recorded for the header comment");

  // Wiring: admin-gated in BOTH directions, and no public surface anywhere in phase 1.
  const sv = fs.readFileSync(path.join(__dirname, "..", "server.js"), "utf8");
  const getIdx = sv.indexOf('fastify.get("/api/congress"'), postIdx = sv.indexOf('fastify.post("/api/congress"');
  assert.ok(getIdx > 0 && postIdx > 0, "both congress routes exist");
  // The READ is gated by the feature manifest (def:"admin") rather than a hardcoded check, so the
  // lane can be taken public with a flag rather than an edit. The manifest entry and the route
  // registration are asserted below; what matters here is that the gate is not simply absent.
  assert.ok(!sv.slice(getIdx, getIdx + 400).includes("isAdmin(req)"),
    "the read path leaves gating to the manifest instead of duplicating it");
  assert.ok(sv.slice(postIdx, postIdx + 500).indexOf('op === "ingest"') > sv.slice(postIdx, postIdx + 500).indexOf("if (!isAdmin(req))"),
    "the ingest op sits behind the admin recheck, same ordering the 13F op is pinned to");
  const app2 = require("./_client").clientSource();
  assert.ok(app2.includes("async function termCongress(") && app2.includes("h==='congress'"), "admin verb wired into the terminal");
  assert.ok(app2.includes("congress is admin-only"), "the verb refuses non-admins client-side too");
  // Phase 2 adds the tab, but ADMIN-ONLY: the manifest entry is what gates it, so taking the lane
  // public later is a flag flip rather than an edit. The POST stays admin regardless of that flag —
  // gate and authz are different axes, the posture the whale watchlist route already documents.
  assert.ok(app2.includes('id="tab-congress"') || fs.readFileSync(path.join(__dirname, "..", "public", "index.html"), "utf8").includes('id="tab-congress"'),
    "the tab exists");
  const cmp = fs.readFileSync(path.join(__dirname, "..", "src", "compute.js"), "utf8");
  assert.ok(/key: "congress",\s+kind: "tab",[^}]*def: "admin"/.test(cmp), "the tab ships admin-gated by the manifest");
  assert.ok(/routes: \["\/api\/congress"\]/.test(cmp), "and its route is registered so the gate actually covers it");
  const gi = sv.indexOf('fastify.post("/api/congress"');
  assert.ok(sv.slice(gi, gi + 500).includes("if (!isAdmin(req))"), "the write path rechecks admin on its own");
  fs.rmSync(dir, { recursive: true, force: true });
});

test("congress -17: the pager's contract, and searching a name the way a person types it", async () => {
  const { createPoller } = require("../src/poller");
  const os2 = require("os"), fs = require("fs"), path = require("path");
  const dir = fs.mkdtempSync(path.join(os2.tmpdir(), "congress7-"));
  const { openStore } = require("../src/store");
  const store = openStore(dir);
  const p = createPoller({ dex: "xyz", store, log: () => {}, version: "test", crypto: false, congressGap: 0 });
  const F = (id, member, filed) => ({ id, chamber: "H", docId: id.slice(2), yr: 2026, member,
    lname: member.split(",")[0], fname: "", suffix: "", state: "GA", dist: "14", type: "ptr",
    typeRaw: "P", filed, url: "https://x/" + id + ".pdf", amends: null, parsed: 0, nTx: null });
  const rows = [];
  for (let i = 0; i < 12; i++) rows.push(F("H:3" + (1000 + i), i % 2 ? "Greene, Marjorie Taylor" : "Khanna, Ro", "2026-08-0" + (1 + (i % 9))));
  store.congressUpsertFilings(rows);
  rows.forEach((f, i) => store.congressSaveTx(f.id, [{ owner: "self", asset: "Apple Inc. (AAPL)",
    ticker: "AAPL", act: "buy", txDate: "2026-07-" + String(10 + i).padStart(2, "0"),
    notified: null, loAmt: 1001, hiAmt: 15000, tkSrc: "form", atype: "ST" }]));

  // The pager's contract: total counts the SELECTION, offset moves through it, and the two must be
  // computed from the same filter or the pager lies about how many pages exist.
  assert.equal(p.congressFeedCount({}), 12, "total counts every matching row");
  assert.equal(p.congressFeed({ limit: 5, offset: 0 }).length, 5);
  assert.equal(p.congressFeed({ limit: 5, offset: 10 }).length, 2, "the last page is short, not empty");
  const pg0 = p.congressFeed({ limit: 5, offset: 0, sort: "traded", dir: -1 });
  const pg1 = p.congressFeed({ limit: 5, offset: 5, sort: "traded", dir: -1 });
  assert.ok(pg0[0].txDate > pg1[0].txDate, "paging walks DOWN one ordering, it does not restart it");
  assert.equal(new Set([...pg0, ...pg1].map((r) => r.fid + ":" + r.ln)).size, 10, "and never repeats a row");

  // A name typed the way a person says it. The index spells it "Greene, Marjorie Taylor", so a
  // single phrase LIKE matches nothing — which is exactly how a real member reads as absent.
  assert.equal(p.congressFeedCount({ q: "marjorie taylor greene" }), 6, "natural word order finds her");
  assert.equal(p.congressFeedCount({ q: "greene marjorie" }), 6, "any order, in fact");
  assert.equal(p.congressFeedCount({ q: "ro khanna" }), 6);
  assert.equal(p.congressFeedCount({ q: "khanna aapl" }), 6, "tokens may match different columns");
  assert.equal(p.congressFeedCount({ q: "khanna tesla" }), 0, "every token must match something");
  const f = p.congressFilerSearch("marjorie taylor greene");
  assert.equal(f.length, 1, "and the index lookup answers in the same word order");
  assert.equal(f[0].member, "Greene, Marjorie Taylor");

  // The route has to actually PASS offset, sort and total through — this regressed once by being
  // silently dropped in a rebase, and the symptom was a pager whose buttons did nothing.
  const sv = fs.readFileSync(path.join(__dirname, "..", "server.js"), "utf8");
  const seg = sv.slice(sv.indexOf("if (q.feed)"), sv.indexOf("if (q.feed)") + 900);
  assert.ok(/offset:\s*\+q\.offset/.test(seg), "the route forwards offset");
  assert.ok(/sort:\s*q\.sort/.test(seg), "and the sort key");
  assert.ok(/total:\s*poller\.congressFeedCount/.test(seg), "and returns the selection's total");
  fs.rmSync(dir, { recursive: true, force: true });
});

test("server: the invite door strips the code from the URL before anything renders", () => {
  const fs = require("fs"), path = require("path");
  const srv = fs.readFileSync(path.join(__dirname, "..", "server.js"), "utf8");
  const join = srv.slice(srv.indexOf('fastify.get("/join/:code"'), srv.indexOf("const deadInvitePage"));
  // The redirect is the security step: after it the code is not in the address bar, the history,
  // or any Referer a later request carries.
  assert.ok(/inviteCookie\(reply, req, r\.invite\.code\)/.test(join), "the code moves into a cookie");
  assert.ok(/reply\.redirect\("\/join", 302\)/.test(join), "and the URL is redirected to a bare /join");
  assert.ok(!/authPage\(\{ mode: "join"/.test(join), "GET /join/:code must never render the claim page itself");
  assert.ok(/xyzinv=[\s\S]{0,120}HttpOnly/.test(srv), "the invite cookie is HttpOnly");
  assert.ok(/log\("invite: opened \(code redacted\)"\)/.test(srv), "the one log line that sees a code redacts it");

  // Per-user payloads must never touch the shared keyed cache: its Map is keyed by a plain string,
  // so a uid-less key would serve one member's threads to the next caller.
  const dmStart = srv.indexOf("// ===== direct messages");
  const dmEnd = srv.indexOf('fastify.get("/logout"', dmStart);
  assert.ok(dmStart > 0 && dmEnd > dmStart, "the DM route block is where the test thinks it is");
  const dm = srv.slice(dmStart, dmEnd);
  // The call, not the word: the block deliberately NAMES serveKeyed in a comment explaining why it
  // must not be used here, and a bare substring check would match that comment forever.
  const dmCode = dm.replace(/^\s*\/\/.*$/gm, "");
  assert.ok(!/serveKeyed\s*\(/.test(dmCode), "no DM route may go through serveKeyed");
  assert.ok(/serveKeyed/.test(dm), "and the reason it must not be used stays written down next to the routes");
  assert.ok((dm.match(/cache-control", "no-store"/g) || []).length >= 4, "every DM route is no-store");

  // Fan-out is targeted. A DM is not an event the group is entitled to know happened.
  assert.ok(/function dmPoke\(threadId, extra\)[\s\S]{0,600}ACCOUNTS\.threadPeers\(threadId\)/.test(srv),
    "pokes resolve the conversation's members and nobody else");
  assert.ok(/const frame = "data: " \+ JSON\.stringify\(\{ dm: Object\.assign\(\{ seq:/.test(srv),
    "the frame carries a sequence (plus at most an ephemeral hint), never a body");
  assert.ok(!/JSON\.stringify\(\{ dm:[^)]*body/.test(srv), "no message body may ride the stream");
  // Attachments: the only inline types are the ones sniffed from magic bytes, and the download
  // headers are belt to that braces. An SVG served inline is a stored XSS with extra steps.
  const acct = fs.readFileSync(path.join(__dirname, "..", "src", "accounts.js"), "utf8");
  assert.ok(/function safeMime\(/.test(acct), "uploads are typed by OUR sniff, never the client's claim");
  assert.ok(!/image\/svg/.test(acct), "svg must never be an inline type");
  assert.ok(/x-content-type-options", "nosniff"/.test(srv), "downloads are nosniff");
  assert.ok(/content-security-policy", "default-src 'none'; sandbox"/.test(srv), "downloads are sandboxed");
  assert.ok(/dispo \+ "; filename\*=UTF-8''"/.test(srv), "the filename is encoded into the header, never interpolated raw");
  assert.ok(/const SSE_PER_USER = 4/.test(srv), "a per-member connection cap, so one person's tabs cannot eat the pool");
});

test("server: the reset flow binds its two steps and does not enumerate handles", () => {
  const fs = require("fs"), path = require("path");
  const srv = fs.readFileSync(path.join(__dirname, "..", "server.js"), "utf8");
  const block = srv.slice(srv.indexOf("// ---- self-serve password reset"), srv.indexOf("// ---- legacy migration"));
  assert.ok(block.length > 800, "found the reset routes");

  // The handle travels between the two steps in an HttpOnly cookie, for the same reason the invite
  // code does: it keeps step two bound to step one, so nobody can request a code for their own
  // account and then verify against somebody else's.
  assert.ok(/xyzotp=[\s\S]{0,120}HttpOnly/.test(srv), "the handle is carried in an HttpOnly cookie");
  // Pin updated 2026.09.20: the cookie is signed (handle + expiry under an accounts-derived key),
  // so the verify step reads it through otpHandleOf — a hand-set xyzotp=<victim> reads as none.
  assert.ok(/const handle = otpHandleOf\(getCookie\(req, "xyzotp"\)\)/.test(block),
    "the verify step reads the handle from that cookie, never from the form");
  assert.ok(/const OTP_SECRET = ACCOUNTS\.deriveKey\("otp-step"\)/.test(block) && /crypto\.timingSafeEqual/.test(block.slice(block.indexOf("const otpHandleOf"), block.indexOf('fastify.get("/reset"'))),
    "and the cookie's MAC is keyed off the random secret and compared in constant time");
  assert.ok(!/b\.handle/.test(block.slice(block.indexOf('fastify.post("/reset/code"'))),
    "the verify step must not trust a handle in its own body");

  // One answer for every outcome — exists, no Telegram, throttled, unknown.
  const req = block.slice(block.indexOf('fastify.post("/reset"'), block.indexOf('fastify.get("/reset/code"'));
  assert.equal((req.match(/return \{ ok: true, next: "\/reset\/code" \}/g) || []).length, 1,
    "the request step has exactly one success return, so the outcomes are indistinguishable");
  assert.ok(!/no such (account|handle)/i.test(req), "and never says whether the handle exists");

  // A reset code is not an alert: it must not wait out a quiet window or a cap.
  assert.ok(/pushEnqueueNow\(chat, text, true\)/.test(block), "the code is sent with the cap and quiet hours bypassed");
  const pol = fs.readFileSync(path.join(__dirname, "..", "src", "poller.js"), "utf8");
  assert.ok(/pushEnqueueNow: \(chat, text, force\) => pushEnqueue\(chat, text, !!force, 0\)/.test(pol),
    "and the outbox forwards that flag");
  // A wrong password on a right code is a typo, not an attack — spending the IP damper on it would
  // lock somebody out of their own reset.
  assert.ok(/if \(!r\.codeOk\) loginFail\(ip\)/.test(block), "only a bad CODE spends the brute-force damper");
  assert.ok(/u === "\/reset" \|\| u === "\/reset\/code"/.test(srv), "both reset doors pass the site gate");
});

// ===== admin panel: every segment folds, and starts folded (build 2026.09.03-50) ===============
test("admin panel: every segment is foldable and collapsed in the markup", () => {
  const fs = require("fs"), path = require("path");
  const R = (p) => fs.readFileSync(path.join(__dirname, "..", p), "utf8");
  const html = R("public/index.html"), app = require("./_client").clientSource(), css = R("public/styles.css");
  const sec = html.slice(html.indexOf('<section id="view-admin"'), html.indexOf("</section>", html.indexOf('<section id="view-admin"')));
  assert.ok(sec.length > 1000, "found the admin section");

  // Drift guard: the panel grew to eight stacked boxes before this existed, and the next one added
  // will be just as easy to leave loose. Every top-level box must be inside a fold — or be the
  // recipients accordion, which already had its own toggle and keeps it.
  const folds = [...sec.matchAll(/data-fold="([a-z]+)"/g)].map((m) => m[1]);
  assert.ok(folds.length >= 7, "found the folds (" + folds.length + ")");
  assert.equal(new Set(folds).size, folds.length, "fold keys are unique — the state map is keyed by them");
  for (const id of ["admAccessBox", "admDmBox", "admLoop", "admBriefBox", "admFloorsBox", "admAuditBox", "adm-rows"]) {
    const at = sec.indexOf('id="' + id + '"');
    assert.ok(at > 0, id + " is still in the panel");
    const before = sec.slice(0, at);
    assert.ok(before.lastIndexOf('class="adm-foldbody"') > before.lastIndexOf("</div>\n  </div>") - 400 ||
      before.lastIndexOf('class="adm-foldbody"') > before.lastIndexOf('data-fold='),
      id + " must sit inside a fold body");
  }
  // Collapsed is the state the markup ships in, not something JS has to apply on first paint.
  assert.equal((sec.match(/class="adm-foldbody" hidden/g) || []).length, folds.length,
    "every fold body starts hidden in the HTML");

  // The wrapper must be OUTSIDE the rendered box: every renderer replaces its box's innerHTML, so a
  // toggle placed inside would be destroyed on the next render.
  for (const [box, fn] of [["admAccessBox", "renderAccess"], ["admDmBox", "renderAdmDm"]]) {
    const body = app.slice(app.indexOf("function " + fn + "("));
    assert.ok(/box\.innerHTML=/.test(body.slice(0, 4000)), fn + " replaces its box wholesale");
    assert.ok(!/adm-foldbody|adm-foldhd/.test(body.slice(0, 4000)), fn + " must not render the fold itself (" + box + ")");
  }

  assert.ok(/function admFoldApply\(\)/.test(app) && /function admFoldWire\(\)/.test(app), "the fold logic exists");
  assert.ok(/admFoldWire\(\);[\s\S]{0,400}admFoldApply\(\)/.test(app), "openAdmin wires then applies");
  assert.ok(/localStorage\.setItem\(ADM_FOLD_KEY/.test(app), "open folds are remembered per browser");
  // A header that cannot be reached from the keyboard is a header half the point of which is gone.
  assert.ok(/<button type="button" class="adm-foldhd"/.test(sec), "fold headers are real buttons");
  assert.ok(/aria-expanded/.test(app), "and report their state");
  assert.ok(/\.adm-foldhd:focus-visible/.test(css), "with a visible focus ring");

  // The loop row hides itself until it has data; its fold has to follow or the panel shows a
  // header over nothing.
  assert.ok(/fold\.hidden\s*=\s*!!box\.hidden/.test(app), "the loop fold follows the row it wraps");

  // The auth pages point at the icon the app already serves, so a signed-out browser stops falling
  // back to /favicon.ico and logging the miss — and the gate lets a logo through.
  const srv = R("server.js");
  assert.ok(srv.includes('<link rel="icon" href="/icon.svg"'), "the auth pages declare the app icon");
  assert.ok(/u === "\/icon\.svg" \|\| u === "\/manifest\.webmanifest"/.test(srv), "and the gate does not 401 it");
});

// The admin-view cookie was signed over its expiry alone, so a demoted or disabled admin kept the
// operator surface for up to ADMIN_DAYS and their audit rows read "legacy-admin". Account-issued
// cookies are now bound to uid|epoch and re-checked against the live user row; the uid-less form
// survives only for the ADMIN_PASSWORD break-glass paths.
test("audit -67: an account-issued admin cookie is bound to the account and dies with its flag", () => {
  const fs = require("fs"), path = require("path");
  const srv = fs.readFileSync(path.join(__dirname, "..", "server.js"), "utf8");
  assert.ok(/function signAdminView\(expMs, uid, epoch\)/.test(srv), "the signer takes the account binding");
  const body = srv.slice(srv.indexOf("function adminViewOk"), srv.indexOf("function adminViewUid"));
  assert.ok(/if \(p\.length !== 2 && p\.length !== 4\) return false;/.test(body), "exactly two shapes verify");
  assert.ok(/const u = ACCOUNTS\.getUser\(p\[0\]\);\s*\n\s*if \(!u \|\| !u\.isAdmin \|\| u\.disabledAt \|\| String\(u\.epoch\) !== p\[1\]\) return false;/.test(body),
    "the bound form re-reads the live row: enabled, still admin, same epoch");
  assert.ok(/crypto\.timingSafeEqual/.test(body), "still constant-time");
  // signIn mints the bound form; the break-glass login and `admin unlock` keep the uid-less one.
  assert.ok(/signAdminView\(Date\.now\(\) \+ ADMIN_DAYS \* 864e5, user\.uid, row\.epoch\)/.test(srv), "sign-in binds the cookie to the account");
  const bg = srv.slice(srv.indexOf("if (adminPwOk(pw)) {"), srv.indexOf("if (adminPwOk(pw)) {") + 400);
  assert.ok(/signAdminView\(Date\.now\(\) \+ ADMIN_DAYS \* 864e5\)\)/.test(bg), "break-glass stays uid-less");
  // Audit attribution follows the binding rather than collapsing to "legacy-admin".
  assert.ok((srv.match(/adminViewUid\(getCookie\(req, "xyzadm"\)\) \|\| "legacy-admin"/g) || []).length >= 2,
    "access and read-through audit rows name the bound uid");
});

// fastify 4.29 / @fastify/static 7 carried five high advisories (a static route-guard bypass via
// path traversal, a Content-Type body-validation bypass among them). Pinned to the majors that
// close them; reply.redirect takes (url, code) in v5.
test("audit -67: fastify majors are past the advisories, redirects use the v5 argument order, dotfiles are denied", () => {
  const fs = require("fs"), path = require("path");
  const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "package.json"), "utf8"));
  const major = (r) => parseInt(String(r).replace(/^[^\d]*/, ""), 10);
  assert.ok(major(pkg.dependencies.fastify) >= 5, "fastify >= 5");
  assert.ok(major(pkg.dependencies["@fastify/static"]) >= 10, "@fastify/static >= 10");
  assert.ok(major(pkg.dependencies["@fastify/compress"]) >= 8, "@fastify/compress for fastify 5");
  const srv = fs.readFileSync(path.join(__dirname, "..", "server.js"), "utf8");
  assert.equal((srv.match(/reply\.redirect\(30\d,/g) || []).length, 0, "no redirect uses the removed (code, url) order");
  assert.ok(/dotfiles: "deny"/.test(srv), "static never serves a dotfile");
});

test("audit -67 lows: shutdown ends the right object, admin writes recheck authz, rejected invites count, the tweet cache evicts one, config timestamps never throw", () => {
  const fs = require("fs"), path = require("path");
  const srv = fs.readFileSync(path.join(__dirname, "..", "server.js"), "utf8");
  assert.ok(/for \(const e of sseClients\) \{ try \{ e\.res\.end\(\); \}/.test(srv), "sseClients holds {res, uid}; shutdown ends the socket, not the entry");
  for (const r of ['"/api/earnings/void"', '"/api/news/channels"']) {
    const at = srv.indexOf("fastify.post(" + r);
    assert.ok(/bodyLimit: \d+ \* 1024/.test(srv.slice(at, at + 120)) && /if \(!isAdmin\(req\)\) return reply\.code\(403\)/.test(srv.slice(at, at + 260)), r + " rechecks isAdmin inline and carries a body limit");
  }
  assert.ok(/loginFail\(clientIp\(req\)\);   \/\/ a rejected code counts/.test(srv), "GET /join/:code feeds the damper");
  assert.ok(/tweetCache\.delete\(tweetCache\.keys\(\)\.next\(\)\.value\)/.test(srv) && !/tweetCache\.clear\(\)/.test(srv), "LRU-ish eviction, never a wipe");
  assert.ok(/strict-transport-security/.test(srv), "HSTS behind TLS");
  const acc = fs.readFileSync(path.join(__dirname, "..", "src", "accounts.js"), "utf8");
  assert.equal((acc.match(/Math\.trunc\(Math\.min\(Math\.max\(\+(o\.)?limit \|\| \d+, 1\), \d+\)\)/g) || []).length, 9, "every limit clamp is an integer (LIMIT ? rejects a REAL)");
  assert.ok(/catch \(_\) \{ try \{ fs\.unlinkSync\(path\.join\(fileDir, id\)\); \} catch \(_\) \{\} return \{ ok: false, error: "could not store that file" \}; \}/.test(acc), "a failed row insert removes the bytes it would have orphaned");
  const pol = fs.readFileSync(path.join(__dirname, "..", "src", "poller.js"), "utf8");
  assert.ok(/const FUND_DUE_TTL = 22 \* HOUR;/.test(pol) && /const FUND_TTL = 24 \* HOUR, EXT_ERR_TTL/.test(pol) && !/>= FUND_TTL\)/.test(pol), "the two TTLs have two names and the outer one is used");
  assert.ok(/store\.archiveClosed\(d\.closed\.slice\(0, d\.closed\.length - 4000\)\); ledgerDirty = true; \}/.test(pol), "archiving overflow at boot marks the ledger dirty");
  assert.ok(/continue; \}\n\s*briefSent\.set\(rec\.chat, day\);/.test(pol) && /continue; \}\n\s*landSent\.set\(rec\.chat, day\);/.test(pol), "scheduled sends are marked after generation succeeds");
  assert.ok(/if \(pushOffset && pushOffset !== offsetBefore\) persistPush\(\);/.test(pol), "push.json is rewritten only when the cursor moved");
  assert.ok(/\} catch \(e\) \{ log\("maintenance tail failed: "/.test(pol), "the maintenance tail is caught");
  const app = require("./_client").clientSource();
  assert.ok(!/\$\{'\$\{\(sc\.covered/.test(app) && /scoped to the \$\{\(sc\.covered \|\| 0\)\.toLocaleString\(\)\}/.test(app), "the insiders footer renders the number, not the placeholder text");
  assert.ok(/function hsgNum\(v,d\)/.test(app) && !/sf\.last\.v\.toFixed\(2\)/.test(app), "housing KPIs are null-safe");
  assert.ok(/function isoUtc\(ts,a,b\)/.test(app) && !/new Date\(L\.maxEver\.t\)\.toISOString/.test(app) && !/new Date\(e\.tShow\)\.toISOString/.test(app), "server stamps format through a guard");
  assert.ok(/function safeHref\(u\)/.test(app) && (app.match(/href="\$\{esc\(safeHref\(/g) || []).length >= 6, "href sinks refuse non-http(s) schemes");
  assert.ok(/data-tcmd="\$\{tesc\(x\.r\.ticker\)\}"/.test(app) && /data-tcmd="report \$\{tesc\(r\.ticker\)\}"/.test(app) && /data-tcmd="\$\{tesc\(g\.ticker\)\}"/.test(app), "terminal tickers are escaped into the command attribute");
  assert.ok(/esc\(String\(r\.body\|\|''\)\.slice\(0,140\)\)/.test(app), "truncate before escaping, never after");
  assert.ok(/tr\[data-coin="\$\{CSS\.escape\(coin\)\}"\]/.test(app), "selector built with CSS.escape");
  assert.ok(/if\(\(_hoverSeq&15\)===0\) for\(const k in _hoverReg\) if\(!document\.getElementById\(k\)\) delete _hoverReg\[k\];/.test(app), "hover registry sweeps itself");
  assert.ok(!fs.existsSync(path.join(__dirname, "..", "xyz-monitor-features.html")) && fs.existsSync(path.join(__dirname, "..", "docs", "xyz-monitor-features.html")), "design docs live in docs/");
  const gi = fs.readFileSync(path.join(__dirname, "..", ".gitignore"), "utf8");
  assert.ok(/\*\.db-wal/.test(gi) && /\*\.bak/.test(gi));
});

test("ux -68: typed prose is protected, sessions expire into a banner, the drawer leads with actions and metrics", () => {
  const fs = require("fs"), path = require("path");
  const app = require("./_client").clientSource();
  const srv = fs.readFileSync(path.join(__dirname, "..", "server.js"), "utf8");
  assert.ok(/function ntCloseCompose\(force\)\{[\s\S]{0,200}confirm\('Discard this note\?/.test(app) && /sessionStorage\.setItem\(ntDraftKey\(coin\), box\.value\)/.test(app), "Escape asks, and a draft survives");
  assert.ok(/if\(confirm\('Remove this rule\?'\)\) deleteAlertRule/.test(app) && /confirm\('Remove this rule\? It fires from the server/.test(app), "rules are not deleted by a mis-tap");
  assert.ok(/function sessionExpired\(\)\{/.test(app) && !/window\.__reauth=1; location\.reload\(\)/.test(app), "a 401 is a banner, not a reload over your typing");
  assert.ok(/const safeNext = \(v\) =>/.test(srv) && /next: safeNext\(b\.next\) \|\| "\/"/.test(srv) && /if\(A\.next\)body\.next=A\.next;/.test(srv), "/login honours a same-origin ?next=");
  const od = app.slice(app.indexOf("el('drawer').innerHTML=`"), app.indexOf("el('drawer').innerHTML=`") + 4000);
  assert.ok(od.indexOf('<div class="dact">') < od.indexOf("${sessDrawerHtml(r)}") && od.indexOf('<div class="dsec">Metrics</div>') < od.indexOf("${sessDrawerHtml(r)}"), "actions and metrics paint above the async panels");
  assert.ok(/function openRuleFor\(r\)\{/.test(app) && /#dcandles\{min-height:176px\}/.test(fs.readFileSync(path.join(__dirname, "..", "public", "styles.css"), "utf8")), "⚑ alert pre-fills the rule form; async panels reserve their height");
  assert.ok(/'dm','notes'\]\)/.test(app) && /is not available in /.test(app), "Messages and Notes survive Crypto scope; a hidden view says so");
  assert.ok(/Object\.assign\(HELP,\{\s*\n\s*dm:`/.test(app) && /const HELP_KEYS=/.test(app) && /if\(e\.key==='\?'\)\{ e\.preventDefault\(\); openHelp\(\); return; \}/.test(app), "every tab has help, with a keyboard section, on ?");
  assert.ok(/function cmdkTabs\(\)\{/.test(app) && /window\.addEventListener\('hashchange'/.test(app) && /function dmStampPreview\(text\)\{/.test(app) && /did you mean/.test(app), "palette from the ribbon, live hash routing, stamp preview, terminal suggestions");
});
