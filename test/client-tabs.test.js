"use strict";
// public/js — focus, funds, insiders, report, calendar, messages tabs. Split out of test.js (build 2026.09.16-80); order within the file is the original order.
const test = require("node:test");
const assert = require("node:assert");
const { classify, HOUR, DAY, C, aiTestPoller, AI_GOOD, ctxHarness, ADM_DOM, ADM_PUSH, runAdmFn, focusPreview, focusDiff, FOCUS_PREVIEW_N, foldLiveMark, FOCCH_SRC, FOCCH_FIX, focchApi, focColsApi, focCols } = require("./_shared");


test("AI sector classification: enum-validated, write-once, static map wins, three strikes to macro", async () => {
  const { createPoller } = require("../src/poller");
  const now = Date.now();
  const calls = [];
  // injected transport: default provider is anthropic when no env keys are set
  const respond = (obj) => ({ ok: true, json: async () => ({ content: [{ type: "text", text: JSON.stringify(obj) }], stop_reason: "end_turn" }) });
  let nextResponse = null;
  const aiFetch = async (url, opts) => { calls.push(JSON.parse(opts.body)); return nextResponse; };
  const store = { loadAll: () => new Map(), loadRegime: () => [], loadLedger: () => null,
    saveLedger: () => {}, insert: () => {}, saveRegime: () => {}, saveNews: () => {}, loadNews: () => null };
  const p = createPoller({ dex: "xyz", store, log: () => {}, version: "test", crypto: false, aiFetch });
  p.seedRowNow("xyz:AAPL", { px: 200, ticker: "AAPL", uni: "xyz" });   // static map knows AAPL
  p.seedRowNow("xyz:ZZZQ", { px: 10, ticker: "ZZZQ", uni: "xyz" });    // static map does NOT
  p.newsIngestNow([
    { id: 1, tk: "AAPL", h: "Apple ships thing", src: "s", url: "u", pub: now - 3600e3 },
    { id: 2, tk: "ZZZQ", h: "ZZZQ wins contract", src: "s", url: "u", pub: now - 3600e3 },
    { id: 3, tk: null, h: "Nat gas slides on weather", src: "s", url: "u", pub: now - 3600e3 },
    { id: 4, tk: null, h: "Fed holds rates", src: "s", url: "u", pub: now - 3600e3 },
  ]);
  // pass 1: valid energy, off-enum garbage for the Fed item, a ticker answer, and one HALLUCINATED id
  nextResponse = respond({ tape: [{ i: "3", sec: "Energy" }, { i: "4", sec: "Memes" }, { i: "999", sec: "Energy" }],
    tickers: [{ t: "ZZZQ", sec: "Industrials" }, { t: "AAPL", sec: "Utilities" }] });
  let r = await p.classifySecNow();
  assert.ok(r.ok && r.applied === 2, `energy tape + ZZZQ learned applied, got ${JSON.stringify(r)}`);
  let d = p.getNews();
  const by = Object.fromEntries(d.items.map((a) => [a.id, a]));
  assert.equal(by[3].sec, "Energy"); assert.equal(by[3].secAi, 1, "tape classification wears the AI marker");
  assert.equal(by[2].sec, "Industrials"); assert.equal(by[2].secAi, 1, "learned ticker sector wears the marker");
  assert.equal(by[1].sec, "Information Technology"); assert.ok(!by[1].secAi, "static map wins, no marker — AAPL's hallucinated Utilities answer was never asked for and never applied");
  assert.ok(!by[4].sec, "off-enum answer rejected — a strike, not a classification");
  assert.ok(!d.items.some((a) => a.id === 999), "hallucinated ids change nothing");
  // pass 2 + 3: the Fed item keeps striking out, then lands on macro; write-once means only pending items ship
  nextResponse = respond({ tape: [{ i: "4", sec: "Garbage" }], tickers: [] });
  await p.classifySecNow();
  const userMsg = calls[1].messages[0].content;
  assert.ok(userMsg.includes('"4"') && !userMsg.includes('"3"'), "write-once: the classified item is never re-sent");
  nextResponse = respond({ tape: [{ i: "4", sec: "Nope" }], tickers: [] });
  await p.classifySecNow();
  r = await p.classifySecNow();   // pass 4: three strikes recorded -> macro without any model call for it
  d = p.getNews();
  assert.equal(Object.fromEntries(d.items.map((a) => [a.id, a]))[4].sec, "macro", "three strikes -> macro, nothing loops forever");
  // wiring pins: schedule, fallback model, scope guard, client A+B surfaces
  const fs = require("fs"), path = require("path");
  const pol = fs.readFileSync(path.join(__dirname, "..", "src", "poller.js"), "utf8");
  for (const pin of ["callModel(AI_CLASSIFY_MODEL, pend, { system: SEC_CLASSIFY_SYSTEM, maxTokens: 600, effort: AI_CLASSIFY_EFFORT })", "const GICS_SECTORS = [",
    "learned sectors feed the NEWS badges/grouping ONLY", "classifySecTick().catch", "sectors: { tapeClassified:"])
    assert.ok(pol.includes(pin), `classifier pin missing: ${pin}`);
  // the classifier runs on its OWN cheap model, never the report/ask fallback (which on OpenAI is
  // the flagship Sol tier) — decoupling proven by source, so a report-quality change can't touch it
  assert.ok(/AI_CLASSIFY_MODEL = process\.env\.AI_CLASSIFY_MODEL \|\| AI_DEF\.classify \|\| AI_MODEL_FALLBACK/.test(pol), "classifier model must be its own knob, falling back to provider default then the report fallback");
  assert.ok(/AI_CLASSIFY_EFFORT = process\.env\.AI_CLASSIFY_EFFORT \|\| "low"/.test(pol), "classifier effort must default to low (nano classification wants no reasoning tokens)");
  assert.ok(pol.includes('classify: "gpt-5.4-nano"') && pol.includes('classify: "claude-haiku-4-5"'), "each provider must default the classifier to a cheap classification-grade tier");
  assert.ok(!pol.includes("callModel(AI_MODEL_FALLBACK, pend"), "the classifier must no longer reuse the report/ask fallback model");
  const app = require("./_client").clientSource();
  for (const pin of ["id=\"nsec\"", "data-nv=", "newsView==='sector'", "nsec-badge${a.secAi?' ai':''}",
    "const SEC_SHORT=", "newsSec&&a.sec!==newsSec", "'unclassified'"])
    assert.ok(app.includes(pin), `sector UI pin missing: ${pin}`);
  const css = fs.readFileSync(path.join(__dirname, "..", "public", "styles.css"), "utf8");
  assert.ok(css.includes(".nsec-badge{") && css.includes(".nsec-badge.ai{border-style:dashed}"), "provenance styling present");
});

test("news relevance pipeline: no off-universe leaks — gate, AI verdicts, re-tag validation, alias learning", async () => {
  const C = require("../src/compute");
  // the pure gate: symbol-as-word, alias substring, 1-char symbols never match
  assert.ok(C.newsRelevant("Strategy Pads Cash With MSTR Sale", null, "MSTR", ["MicroStrategy"]), "symbol word match");
  assert.ok(C.newsRelevant("Western Digital raises guidance", "", "WDC", ["Western Digital"]), "alias match");
  assert.ok(!C.newsRelevant("Meta Platforms Likely to Beat Q2", null, "AMZN", ["Amazon"]), "the screenshot bug: Meta under AMZN fails the gate");
  assert.ok(!C.newsRelevant("Stock Market Today: Nasdaq Leads", null, "SNDK", ["Sandisk"]), "listicles fail the gate");
  assert.ok(!C.newsRelevant("Fed holds rates", null, "F", null), "1-char symbols never word-match");
  assert.ok(C.newsRelevant("Details inside", "NVDA beat expectations", "NVDA", null), "summary participates in the gate");

  const { createPoller } = require("../src/poller");
  const now = Date.now();
  const calls = [];
  let nextResponse = null;
  const respond = (obj) => ({ ok: true, json: async () => ({ content: [{ type: "text", text: JSON.stringify(obj) }], stop_reason: "end_turn" }) });
  const aiFetch = async (url, opts) => { calls.push(JSON.parse(opts.body)); return nextResponse; };
  const store = { loadAll: () => new Map(), loadRegime: () => [], loadLedger: () => null,
    saveLedger: () => {}, insert: () => {}, saveRegime: () => {}, saveNews: () => {}, loadNews: () => null };
  const p = createPoller({ dex: "xyz", store, log: () => {}, version: "test", crypto: false, aiFetch });
  p.seedRowNow("xyz:AMZN", { px: 200, ticker: "AMZN", uni: "xyz" });
  p.seedRowNow("xyz:META", { px: 500, ticker: "META", uni: "xyz" });
  p.seedRowNow("xyz:QQZX", { px: 5, ticker: "QQZX", uni: "xyz" });   // unseeded name -> alias learning path
  p.newsIngestNow([
    { id: 11, tk: "AMZN", h: "Amazon expands same-day delivery", src: "s", url: "u", pub: now - 3600e3 },
    { id: 12, tk: "AMZN", h: "Meta Platforms Likely to Beat Q2 Estimates", src: "s", url: "u", pub: now - 3600e3 },
    { id: 13, tk: "AMZN", h: "Stock Market Today: Nasdaq Leads On Peace Hopes", src: "s", url: "u", pub: now - 3600e3 },
    { id: 14, tk: "AMZN", h: "Spain beat Argentina to win World Cup", src: "s", url: "u", pub: now - 3600e3 },
    { id: 15, tk: "QQZX", h: "Quizzex Robotics lands defense contract", src: "s", url: "u", pub: now - 3600e3 },
  ]);
  // BEFORE any verdicts: only the gate-passing item is attributed; nothing else leaks
  let d = p.getNews();
  let by = Object.fromEntries(d.items.map((a) => [a.id, a]));
  assert.equal(by[11].tk, "AMZN", "gate-passing item attributed deterministically");
  for (const id of [12, 13, 14, 15]) {
    assert.equal(by[id].tk, null, `item ${id} ships UNATTRIBUTED while pending — no leak into the universe feed`);
    assert.equal(by[id].pend, 1, `item ${id} wears the pending marker`);
  }
  // verdicts: re-tag to META (in roster), market demotion, off-topic, plus an INVALID re-tag to a
  // ticker outside the roster (must be a strike, not an attribution); QQZX aliases learned
  nextResponse = respond({ tape: [], tickers: [],
    rel: [{ i: "12", v: "other", t: "META" }, { i: "13", v: "market" }, { i: "14", v: "off" }, { i: "15", v: "other", t: "TSLA" }],
    names: [{ t: "QQZX", names: ["Quizzex Robotics", "Quizzex"] }] });
  const r = await p.classifySecNow();
  assert.ok(r.ok && r.applied >= 4, `verdicts + aliases + re-gate applied, got ${JSON.stringify(r)}`);
  d = p.getNews();
  by = Object.fromEntries(d.items.map((a) => [a.id, a]));
  assert.equal(by[12].tk, "META", "Meta story re-tagged to META");
  assert.equal(by[12].relAi, 1, "re-tagged attribution wears the AI-verified marker");
  assert.equal(by[12].sec, "Communication Services", "and picks up META's static sector");
  assert.equal(by[13].tk, null); assert.ok(!by[13].pend, "market-general item demoted to plain tape");
  assert.equal(by[14].sec, "off-topic"); assert.equal(by[14].secAi, 1, "World Cup -> off-topic, AI-marked");
  assert.equal(by[15].tk, "QQZX", "learned alias re-gated the pending item DETERMINISTICALLY — the invalid TSLA re-tag was never applied");
  assert.ok(!d.items.some((a) => a.tk === "TSLA"), "a re-tag outside the roster can never mint an attribution");
  // the cascade continues correctly: the demoted item now needs a TAPE sector, and QQZX needs
  // a learned ticker sector — but no relevance verdict is ever re-asked (write-once)
  nextResponse = respond({ tape: [{ i: "13", sec: "macro" }], tickers: [{ t: "QQZX", sec: "Industrials" }], rel: [], names: [] });
  const r2 = await p.classifySecNow();
  assert.ok(r2.ok && r2.applied === 2, `demoted item sectored + QQZX learned, got ${JSON.stringify(r2)}`);
  const relAsked2 = calls[1].messages[0].content;
  assert.ok(!relAsked2.includes('"rel":[{'), "no relevance entries re-sent — verdicts are write-once");
  // and only NOW is the pipeline fully drained
  nextResponse = respond({ tape: [], tickers: [], rel: [], names: [] });
  const r3 = await p.classifySecNow();
  assert.ok(r3.idle, "fully classified store goes idle — nothing loops");
  // wiring pins: lane semantics client-side, drawer guard, health counters
  const fs = require("fs"), path = require("path");
  const app = require("./_client").clientSource();
  for (const pin of ["newsMode='universe'", "filings are exclusive BOTH ways",
    "relevance verdict pending", "a.sec==='off-topic'?' off'", "const lane=r.mlane||null;",
    "attribution AI-verified", "no verified headlines for this name in the last 72h"])
    assert.ok(app.includes(pin), `lane pin missing: ${pin}`);
  const css = fs.readFileSync(path.join(__dirname, "..", "public", "styles.css"), "utf8");
  assert.ok(css.includes(".nrow.off{opacity:.45}"), "off-topic dimming present");
  const pol = fs.readFileSync(path.join(__dirname, "..", "src", "poller.js"), "utf8");
  for (const pin of ["function gateCompanyItems(", "function regatePending(", "uniSet.has(String(e.t).toUpperCase())",
    "relevance: { verified:", "secTape, secLearned, nameLearned }"])
    assert.ok(pol.includes(pin) || pol.includes(pin.trim()), `pipeline pin missing: ${pin}`);
  const sec = fs.readFileSync(path.join(__dirname, "..", "src", "sectors.js"), "utf8");
  assert.ok(sec.includes("const COMPANY_NAMES = {") && sec.includes("nameAliases"), "alias seed present and exported");
});

test("analyst-read ledger: directional reports freeze claims, episodes hold, buckets stay isolated", async () => {
  const { p, px, now } = aiTestPoller({ aiFetch: async () => ({ ok: true, json: async () => ({ stop_reason: "end_turn",
    content: [{ type: "text", text: AI_GOOD(px, +(px * 0.95).toPrecision(6), +(px * 1.10).toPrecision(6)) }] }) }) });
  const g1 = await p.generateAiReport("xyz:NVDA");
  assert.ok(g1.ok, "generation succeeds: " + (g1.error || ""));
  // the claim: frozen at the report's OWN geometry. Observed through the harness accessor —
  // the drawer payload (getLedgerFor) correctly excludes vi-stamped claims, airead included:
  // the analyst bucket is invisible to the signal surfaces BY DESIGN, and this test proves
  // both the claim and the invisibility.
  assert.ok(!(p.getLedgerFor("xyz:NVDA", null, true).open || []).some((e) => e.ev === "airead"),
    "the drawer ledger slice never shows analyst claims — bucket isolation at the payload too");
  const cl = p.aireadClaimsNow().open.find((e) => e.coin === "xyz:NVDA");
  assert.ok(cl, "a validated long read opened an airead claim");
  assert.equal(cl.psd, "long");
  assert.equal(cl.stp, +(px * 0.95).toPrecision(6), "the report's void IS the frozen stop — exactly that number");
  assert.ok(Math.abs(cl.mv - 10) < 0.2, "target distance frozen from the report's target level");
  assert.equal(cl.vi, 0, "vi=0: outside the visible record sets by construction");
  assert.ok(cl.rm, "the authoring model is stamped for later slicing");
  // episode: a same-bias regeneration cannot pseudo-replicate (TTL blocks it here anyway, but
  // the episode gate must hold independently of the cooldown)
  p.aiTouchStamp("xyz:NVDA", { closedN: -1 });   // unlock regeneration via material change
  const g2 = await p.generateAiReport("xyz:NVDA");
  assert.ok(g2.ok, "regen after unlock succeeds");
  assert.equal(p.aireadClaimsNow().open.filter((e) => e.coin === "xyz:NVDA").length, 1,
    "still exactly ONE open analyst claim on the name");
  // bucket isolation: the analyst record never leaks into the engine's record sets or shadows
  await p.buildSignalsNow();
  const d = p.getSignals(true);
  for (const key of ["0", "0x", "0m"])
    assert.ok(!d.records[key] || !d.records[key].record.airead, `airead absent from record set ${key}`);
  assert.ok(![...d.shadows.xyz].some((g) => g.ev === "airead"), "and absent from the shadows panel");
  // the record surfaces: ctx + served report both carry analystRecord (open-only state here)
  const ctx = p.aiCompileNow("xyz:NVDA");
  assert.ok(ctx.analystRecord && ctx.analystRecord.openOnName, "the analyst sees its own open read in context");
  const served = p.getAiReport("xyz:NVDA");
  assert.ok(served.analystRecord && served.analystRecord.open === 1, "the served report carries the live record");
  // client + wiring pins
  const fs = require("fs"), path = require("path");
  const app = require("./_client").clientSource();
  for (const pin of ["analyst reads:", "first reads still open", "d.analystRecord"])
    assert.ok(app.includes(pin), `client analyst-record pin missing: ${pin}`);
  const pol = fs.readFileSync(path.join(__dirname, "..", "src", "poller.js"), "utf8");
  for (const pin of ["Neutral reads don't ledger", "!ledgerOpen.has(coin + \"|airead#0\")", "function analystRecordFor(",
    "context.analystRecord, when present, is YOUR OWN out-of-sample record"])
    assert.ok(pol.includes(pin), `airead pin missing: ${pin}`);
  const C = require("../src/compute");
  assert.equal(C.EV_META.airead.horizonMs, 5 * DAY, "5d horizon");
});

test("EDGAR filings lane: parser, 7d retention, hard isolation from every other lane and from the report", () => {
  const C = require("../src/compute");
  const now = Date.now(), H = 3600e3;
  const atomEntry = (form, desc, accn, iso, summary) => `<entry><title>${form} - ${desc}</title><updated>${iso}</updated>`
    + `<link rel="alternate" href="https://www.sec.gov/idx-${accn}.htm"/><summary type="html">AccNo: ${accn} ${summary || ""}</summary></entry>`;
  const iso = (agoH) => new Date(now - agoH * H).toISOString();
  const xml = "<feed>"
    + atomEntry("8-K", "Current report", "0001000000-26-000123", iso(2), "Item 2.02 Results of Operations Item 9.01 Exhibits")
    + atomEntry("4", "Statement of changes in beneficial ownership", "0001000000-26-000124", iso(5))
    + atomEntry("10-Q", "Quarterly report", "0001000000-26-000125", iso(100))   // 4+ days old: INSIDE the 7d filings window
    + "</feed>";
  const pr = C.parseEdgarAtom(xml, "wdc", now);
  assert.equal(pr.items.length, 3);
  assert.equal(pr.items[0].form, "8-K"); assert.equal(pr.items[0].mat, 1);
  assert.ok(pr.items[0].h.includes("Item 2.02"), "8-K item list is the headline — the tradeable fact, no editorializing");
  assert.equal(pr.items[1].own, 1); assert.ok(!pr.items[1].mat, "Form 4 is ownership, not material");
  assert.equal(pr.items[0].id, "sec:0001000000-26-000123", "dedupe keys on the accession number");
  // dual TTL: a 100h-old filing survives where a 100h-old headline dies
  const m = C.mergeNews([], pr.items.concat([{ id: "w1", tk: null, h: "old wire", src: "s", url: "u", pub: now - 100 * H }]), now);
  assert.ok(m.some((a) => a.id === "sec:0001000000-26-000125"), "filings live 7 days");
  assert.ok(!m.some((a) => a.id === "w1"), "headlines still die at 72h");
  // end-to-end: payload fields + hard lane isolation + report exclusion
  const { createPoller } = require("../src/poller");
  const store = { loadAll: () => new Map(), loadRegime: () => [], loadLedger: () => null,
    saveLedger: () => {}, insert: () => {}, saveRegime: () => {}, saveNews: () => {}, loadNews: () => null,
    saveTgChannels: () => {}, loadTgChannels: () => null, loadAiReports: () => null, saveAiReports: () => {} };
  const pl = createPoller({ dex: "xyz", store, log: () => {}, version: "test", crypto: false });
  pl.seedRowNow("xyz:WDC", { px: 500, ticker: "WDC", uni: "xyz" });
  const pay = pl.newsIngestNow(pr.items);
  const fl = pay.items.find((a) => a.id === "sec:0001000000-26-000123");
  assert.ok(fl.fl === 1 && fl.form === "8-K" && fl.mat === 1 && fl.tk === "WDC" && fl.coin === "xyz:WDC",
    "filing ships attributed with form/materiality — no rel machinery, no pend");
  assert.ok(!fl.pend && !fl.secAi, "…and never enters the relevance or AI-classification paths");
  const ctx = pl.aiCompileNow("xyz:WDC");
  assert.equal((ctx.news && ctx.news.verified || []).length, 0,
    "filings are NOT headlines: the report's news context stays empty — the news contract never sees them");
  // client pins: exclusive lane, sub-chips, form rows, grouped-view guard
  const fs = require("fs"), path = require("path");
  const app = require("./_client").clientSource();
  for (const pin of ["newsMode==='filings'?!!a.fl:(a.fl?false:", "'universe','tape','telegram','filings'",
    "data-nfl=", "newsFl==='mat'&&!a.mat", "class=\"nform", "newsView==='sector'&&newsMode!=='filings'",
    "a.sec&&!a.fl&&inLane(a)"])
    assert.ok(app.includes(pin), `filings client pin missing: ${pin}`);
  const css = fs.readFileSync(path.join(__dirname, "..", "public", "styles.css"), "utf8");
  assert.ok(css.includes(".nform.mat{"), "material form styling present");
  const pol = fs.readFileSync(path.join(__dirname, "..", "src", "poller.js"), "utf8");
  for (const pin of ["www.sec.gov/cgi-bin/browse-edgar", "\"user-agent\": SEC_UA", "!a.fl && a.tk && a.rel === 1",
    "filings: { items:", "let edgarStat = {", "UA or egress IP likely rejected", "flStat: { lastOk:"])
    assert.ok(pol.includes(pin), `filings poller pin missing: ${pin}`);
  // the empty state and footer answer "is this working" from the UI itself
  for (const pin of ["EDGAR fetches are failing:", "the EDGAR rotation is warming up", "last EDGAR fetch"])
    assert.ok(app.includes(pin), `filings observability pin missing: ${pin}`);
});

test("earnings<->filings join: the release links once it's live, tiered preference, upcoming untouched", () => {
  const C = require("../src/compute");
  const now = Date.now(), DAY_ = 86400e3;
  const d0 = new Date(now - 1 * DAY_).toISOString().slice(0, 10);   // reported yesterday
  const dF = new Date(now + 3 * DAY_).toISOString().slice(0, 10);   // reports in 3 days
  const D0 = Date.parse(d0 + "T12:00:00Z");
  const mkFl = (tk, form, h, agoFromD0) => ({ id: "sec:" + tk + form + agoFromD0, tk, fl: 1, form, h,
    src: "EDGAR", url: "https://sec/" + tk + "/" + form, pub: D0 + agoFromD0 * 3600e3 });
  const entries = [
    { coin: "xyz:WDC", t: "WDC", d: d0, s: "AMC" },
    { coin: "xyz:NVDA", t: "NVDA", d: d0, s: "BMO" },
    { coin: "xyz:MSTR", t: "MSTR", d: dF, s: "AMC" },
  ];
  const filings = [
    mkFl("WDC", "4", "officer sale", 1),
    mkFl("WDC", "10-Q", "Quarterly report", 5),
    mkFl("WDC", "8-K", "Item 2.02 Results of Operations Item 9.01 Exhibits", 2),
    mkFl("NVDA", "8-K", "Item 7.01 Regulation FD", 3),                    // 8-K without 2.02: last-resort tier
    mkFl("MSTR", "8-K", "Item 2.02 Results", -30 * 24),                   // way outside any window for dF
  ];
  const out = C.linkEarningsFilings(entries, filings, now);
  assert.equal(out[0].filing.form, "8-K", "the 2.02 8-K beats the 10-Q beats the Form 4 — the release itself wins");
  assert.ok(out[0].filing.url.includes("/WDC/8-K"));
  assert.equal(out[1].filing.form, "8-K", "an 8-K without parsed 2.02 items still links as last resort");
  assert.ok(!out[2].filing, "upcoming entries carry NO link until the filing actually lands");
  assert.equal(C.linkEarningsFilings(entries, [], now)[0].filing, undefined, "no filings, no decoration, no throw");
  // serve-time overlay + ETag folding + client pins
  const fs = require("fs"), path = require("path");
  const pol = fs.readFileSync(path.join(__dirname, "..", "src", "poller.js"), "utf8");
  for (const pin of ["const entries = linkEarningsFilings(earnCache.entries, flItems", "if (sig !== earnLnSig) { earnLnSig = sig; earnLnVer = Date.now(); }",
    "dataTs: Math.max(earnCache.dataTs || 0, earnLnVer, macroCache ? (macroCache.dataTs || 0) : 0)"])
    assert.ok(pol.includes(pin), `earnings-link pin missing: ${pin}`);
  const app = require("./_client").clientSource();
  for (const pin of ["function earnFilingHtml(e)", "earnFilingHtml(e)", "the earnings release itself",
    "if(ev.target.closest('a,button')) return;"])
    assert.ok(app.includes(pin), `earnings-link client pin missing: ${pin}`);
  const css = fs.readFileSync(path.join(__dirname, "..", "public", "styles.css"), "utf8");
  assert.ok(css.includes(".earn-fl{") && css.includes(".earn-fl.mat{"), "filing chip styling present");
});

test("earnings row: the printed EPS pair reconciles with the surprise % printed beside it", () => {
  // The live CRWD row (2026-08-26) read "EPS 0.31 vs 0.3 beat +3.9%" — a pair that, taken at its
  // printed word, is +3.3%. Two separate defects behind one line: the pair rounded to 2dp while
  // the surprise kept the feed's 4dp values, and the trailing-zero trim ran per value, so the
  // actual printed two decimals and the estimate one. Both are display lies about a number the
  // operator trades on, so both are pinned here against the real functions in app.js.
  const fs = require("fs"), path = require("path");
  const app = require("./_client").clientSource();
  const grab = (name) => {
    const i = app.indexOf("function " + name + "(");
    assert.ok(i > -1, name + " present in app.js");
    let d = 0;
    for (let k = app.indexOf("{", i); k < app.length; k++) {
      if (app[k] === "{") d++; else if (app[k] === "}") { d--; if (!d) return app.slice(i, k + 1); }
    }
    throw new Error("unbalanced " + name);
  };
  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
  const fmtUsd = (x) => "$" + x;
  const api = new Function("esc", "fmtUsd",
    grab("epsSurStr") + "\n" + grab("epsPairFmt") + "\n" + grab("epsFmt") + "\n" + grab("earnEpsHtml")
    + "\nreturn { epsSurStr, epsPairFmt, epsFmt, earnEpsHtml };")(esc, fmtUsd);

  // The pair as printed must imply the surprise as printed — the invariant, checked directly.
  const reconciles = (a, b) => {
    const [fa, fe] = api.epsPairFmt(a, b);
    assert.equal(fa.split(".")[1] ? fa.split(".")[1].length : 0,
      fe.split(".")[1] ? fe.split(".")[1].length : 0, `${a}/${b}: both sides print at the same precision`);
    assert.equal(api.epsSurStr(+fa, +fe), api.epsSurStr(a, b),
      `${a}/${b}: printed "${fa} vs ${fe}" must imply the printed surprise`);
    return [fa, fe];
  };
  assert.deepEqual(reconciles(0.3116, 0.3), ["0.3116", "0.3000"], "CRWD: 2dp hid a full half-point of surprise");
  assert.deepEqual(reconciles(0.31, 0.2984), ["0.3100", "0.2984"], "same lie with the imprecision on the estimate side");
  assert.deepEqual(reconciles(5.71, 5.62), ["5.71", "5.62"], "clean 2dp values stay at 2dp — no gratuitous decimals");
  assert.deepEqual(reconciles(1.5, 1.2), ["1.5", "1.2"], "shared trailing zeros come off BOTH sides");
  assert.deepEqual(reconciles(2, 1), ["2.0", "1.0"], "trim stops at one decimal — EPS is not an integer field");
  assert.deepEqual(reconciles(-0.1, -0.2), ["-0.1", "-0.2"], "negative EPS: sign never disturbs the pairing");
  reconciles(0.0007, 0.0004); reconciles(4.1123, 4.11); reconciles(0.8, 0.7999);
  // The original NFLX lesson still holds: values that DIFFER must READ as different.
  assert.deepEqual(api.epsPairFmt(0.8, 0.8042), ["0.8000", "0.8042"], "NFLX: 2dp collapsed a real -0.52% miss into 0.8 vs 0.8");
  assert.deepEqual(api.epsPairFmt(3, 3), ["3.0", "3.0"], "equal values are equal at any precision");
  assert.deepEqual(api.epsPairFmt(0.05, 0), ["0.05", "0.00"], "a zero estimate suppresses surprise, never the pairing");

  // Rendered rows: the numbers in the row and the percentage next to them tell one story.
  const row = api.earnEpsHtml({ epsA: 0.3116, eps: 0.3 });
  assert.ok(row.includes("EPS 0.3116 vs 0.3000"), "row prints the reconciling pair: " + row);
  assert.ok(row.includes("beat +3.9%"), "row keeps the true surprise, computed on stored values: " + row);
  assert.ok(!/EPS 0\.31 vs 0\.3 </.test(row), "the shipped contradiction is gone");
  assert.ok(api.earnEpsHtml({ epsA: 0.8, eps: 0.8042 }).includes("EPS 0.8000 vs 0.8042"), "verdict-contradicting collapse stays fixed");

  // A lone estimate is house-style 2dp, not the feed's raw 4dp ("EPS est 2.1283" shipped live).
  assert.ok(api.earnEpsHtml({ eps: 2.1283, rev: null }).includes("EPS est 2.13"), "NVDA: raw feed precision no longer leaks into the row");
  assert.ok(api.earnEpsHtml({ eps: 2.1283, rev: null }).includes("2.1283"), "the exact feed estimate survives in the tooltip");
  assert.ok(api.earnEpsHtml({ eps: 0.0042, rev: null }).includes("EPS est 0.0042"), "a sub-cent estimate is never rounded away to 0.00");
  assert.ok(api.earnEpsHtml({ epsA: 1.2, eps: null }).includes("EPS 1.20 · no est"), "actual with no estimate: same house style");
  assert.ok(api.earnEpsHtml({ eps: null, rev: null }).includes(">—<"), "nothing known stays a dash, never a zero");
  assert.equal(api.epsSurStr(1, 0), null, "a zero estimate has no surprise to state");
  assert.equal(api.epsSurStr(1, 1), null, "in line prints no surprise");
});

test("insiders tab: columns sort, hide and REORDER, and the view survives a column list that changed", () => {
  const fs = require("fs"), path = require("path");
  const app = require("./_client").clientSource();
  const els = {};
  const mk = (id) => ({ id, innerHTML: "", hidden: false, value: "", checked: false, textContent: "", style: {}, dataset: {},
    classList: { add() {}, remove() {}, toggle() {}, contains: () => false },
    querySelectorAll: () => [], querySelector: () => null, addEventListener() {}, appendChild() {}, removeChild() {},
    setAttribute() {}, getAttribute: () => null, focus() {}, getBoundingClientRect: () => ({ left: 0, top: 0, width: 90, height: 20 }) });
  const saved = { si: global.setInterval, st: global.setTimeout, raf: global.requestAnimationFrame, ct: global.clearTimeout,
    ci: global.clearInterval, doc: global.document, win: global.window, ls: global.localStorage, f: global.fetch };
  global.setInterval = () => 0; global.setTimeout = () => 0; global.requestAnimationFrame = () => 0;
  global.clearTimeout = () => 0; global.clearInterval = () => 0;
  global.document = { getElementById: (id) => (els[id] = els[id] || mk(id)), querySelectorAll: () => [], querySelector: () => null,
    createElement: mk, addEventListener() {}, body: mk("body"), documentElement: mk("html"), hidden: false };
  global.window = { addEventListener() {}, location: { reload() {}, href: "/", hash: "" }, matchMedia: () => ({ matches: false, addEventListener() {} }), __ADMIN: true };
  global.localStorage = { _d: {}, getItem(k) { return this._d[k] ?? null; }, setItem(k, v) { this._d[k] = String(v); }, removeItem(k) { delete this._d[k]; } };
  global.fetch = () => new Promise(() => {});
  try {
    const api = new Function(app + "\n;return { INS, INS_COLS, INS_HIDE_DEFAULT, insRender, insCols, insSave, insLoad, insTitleShort, insRoleCell, insPairs, insPairStory };")();
    const { INS } = api;
    INS.stat = { filings: { n: 2, done: 2, queued: 0, failed: 0 }, tx: { n: 2, names: 2, noPrice: 1 } };
    INS.total = 2;
    INS.rows = [
      { acc: "a", tk: "INTC", form: "4", filed: Date.parse("2026-08-26T21:00:00Z"), url: "https://sec.gov/x", issuer: "INTEL CORP",
        owner: "Tan Lip-Bu", role: "director · officer", title: "Chief Executive Officer", nDeriv: 1, ln: 0, txDate: "2026-08-25",
        code: "P", act: "buy", ad: "A", shares: 500000, price: 20, value: 1e7, own: 1500000, dir: "D", plan: null, sec: "Common Stock" },
      { acc: "b", tk: "NVDA", form: "4", filed: Date.parse("2026-08-25T20:00:00Z"), url: "https://sec.gov/y", issuer: "NVIDIA CORP",
        owner: "Huang Jen-Hsun", role: "director · officer", title: "CEO", nDeriv: 0, ln: 1, txDate: "2026-08-24",
        code: "S", act: "sell", ad: "D", shares: 12500, price: null, value: null, own: null, dir: null, plan: 1, sec: "Common Stock" },
    ];
    api.insRender();
    const h = () => els["insiders-body"].innerHTML;
    assert.ok(h().includes("500,000") && h().includes("$20.00"), "the filer's own figures are what the row shows");
    assert.ok(h().includes("$10.00M"), "value renders from shares x price");
    // The two absences, rendered as absences.
    assert.ok(!/\$0\.00/.test(h()), "a row with no price must never render a $0 price or value: " + (h().match(/\$0[^<]*/) || [""])[0]);
    assert.ok(h().includes("10b5-1"), "a plan-marked sale says so");
    assert.ok(h().includes("+1D"), "the derivative rows the table does not price are disclosed on the filing");
    assert.ok(/33%|33\.3%/.test(h()), "Δ POS: 500,000 of the 1,500,000 held afterwards");

    // REARRANGE: the header order is INS.order, and hiding removes a column outright.
    const ths = (s) => [...s.matchAll(/data-inssort="([a-z]+)"/g)].map((m) => m[1]);
    const before = ths(h());
    assert.ok(before.indexOf("filed") < before.indexOf("ticker"), "default order");
    assert.ok(!before.includes("issuer"), "issuer starts hidden — it repeats the ticker");
    INS.order = ["ticker", "owner", "act", "value"].concat(INS.order.filter((k) => !["ticker", "owner", "act", "value"].includes(k)));
    api.insRender();
    assert.deepEqual(ths(h()).slice(0, 4), ["ticker", "owner", "act", "value"], "a reordered view renders in that order");
    INS.hidden = new Set(api.INS_COLS.map((c) => c.k));
    assert.equal(api.insCols().length, 0, "hiding everything is possible in state...");
    api.insRender();
    // ...and the render must not produce a table with no columns; the bind guard restores one.
    INS.hidden = new Set(api.INS_HIDE_DEFAULT);

    // A saved view is RECONCILED against the current column list, never trusted wholesale: a
    // column added in a later build must appear rather than vanishing for everyone who ever
    // dragged a header, and one since removed must not leave a hole.
    global.localStorage.setItem("insview", JSON.stringify({ order: ["value", "ticker", "GONE_COLUMN"], hidden: ["sec"], sort: { k: "value", dir: 1 } }));
    api.insLoad();
    assert.equal(INS.order.indexOf("GONE_COLUMN"), -1, "a column that no longer exists is dropped from a stored order");
    assert.deepEqual(INS.order.slice(0, 2), ["value", "ticker"], "the stored order is honoured as far as it is still valid");
    assert.equal(INS.order.length, api.INS_COLS.length, "every current column is present exactly once");
    assert.deepEqual(INS.sort, { k: "value", dir: 1 }, "the stored sort is restored");
    global.localStorage.setItem("insview", JSON.stringify({ sort: { k: "haxx", dir: -1 } }));
    api.insLoad();
    assert.notEqual(INS.sort.k, "haxx", "a stored sort key that is not a column is refused");

    // ROLE has to say something. The relationship boxes read "director · officer" for almost every
    // filer on the roster, which separates nothing — the TITLE is the field that distinguishes a
    // CEO buying from a VP of Sales selling.
    const short = api.insTitleShort;
    assert.equal(short("President and Chief Executive Officer"), "President & CEO");
    assert.equal(short("Chief Financial Officer"), "CFO");
    assert.equal(short("Executive Vice President, Global Operations"), "EVP, Global Operations");
    assert.equal(short("Senior Vice President and General Counsel"), "SVP & General Counsel");
    // Ambiguous abbreviations are NOT invented: both of these want to be "CSO", so neither is
    // shortened. A long column beats a wrong three letters.
    assert.equal(short("Chief Security Officer"), "Chief Security Officer");
    assert.equal(short("Chief Strategy Officer"), "Chief Strategy Officer");
    assert.equal(short(""), "", "no title is no string, not a placeholder");
    const cell = (r, t) => api.insRoleCell({ role: r, title: t }).replace(/<[^>]*>/g, "").trim();
    assert.equal(cell("director · officer", "Chief Executive Officer"), "CEO", "the title wins over the boxes");
    assert.equal(cell("director", null), "director", "...and the boxes are the fallback when no title was filed");
    assert.equal(cell("officer", null), "officer");
    assert.equal(cell("10% owner", null), "10%");
    // A 10% owner rides ALONGSIDE a title: a fund over the threshold is a different actor from an
    // executive, and a row can be both.
    assert.equal(cell("officer · 10% owner", "Chief Executive Officer"), "CEO · 10%");
    assert.equal(cell("", null), "\u2014", "no box and no title is unknown, not a guess");
    assert.ok(api.insRoleCell({ role: "director · officer", title: "Chief Executive Officer" }).includes("Chief Executive Officer"),
      "the exact filed words stay one hover away");

    // The cashless exercise: an M on Table II and an S on Table I, same filing, same day, same
    // count. Nothing on the form links them, so this is INFERRED — and what makes it safe is what
    // it REFUSES to match, not what it matches.
    const leg = (o) => Object.assign({ acc: "a1", txDate: "2026-08-26", shares: 5191, kind: "S", code: "S", price: 258.66, value: 1342704.06 }, o);
    const mLeg = (o) => leg(Object.assign({ kind: "D", code: "M", price: null, value: null, strike: 12.04 }, o));
    const pairs = (rows) => api.insPairs(rows).size;
    assert.equal(pairs([mLeg({}), leg({})]), 2, "both legs are marked when the filing, date and count all match");
    assert.equal(pairs([mLeg({}), leg({ acc: "a2" })]), 0, "a different FILING is not a pair");
    assert.equal(pairs([mLeg({}), leg({ txDate: "2026-08-27" })]), 0, "a different DAY is not a pair");
    assert.equal(pairs([mLeg({}), leg({ shares: 5000 })]), 0, "a partial sale is not a pair — no fuzzy bracket");
    assert.equal(pairs([mLeg({}), mLeg({}), leg({})]), 0, "two exercises for one sale is ambiguous: nothing is claimed");
    assert.equal(pairs([mLeg({}), leg({}), leg({})]), 0, "and so is two sales for one exercise");
    assert.equal(pairs([mLeg({ code: "A" }), leg({})]), 0, "an option GRANT is not an exercise — only M pairs");
    assert.equal(pairs([mLeg({}), leg({ code: "P" })]), 0, "and only against a SALE");
    assert.equal(pairs([leg({ kind: "D", code: "M" }), leg({ kind: "D", code: "S" })]), 0,
      "two derivative rows are not a cashless exercise — the sale leg has to be a share sale");
    // The arithmetic, and what it declines to state.
    const story = api.insPairStory(mLeg({}), leg({}));
    assert.ok(story.includes("inferred"), "the pairing is marked wherever it appears");
    assert.ok(story.includes("$62.5K"), "cost is strike x shares: " + story.replace(/<[^>]*>/g, " "));
    assert.ok(story.includes("$1.34M") && story.includes("$1.28M"), "proceeds and net, both from filed figures");
    const noStrike = api.insPairStory(mLeg({ strike: null }), leg({}));
    assert.ok(/footnoted strike/.test(noStrike) && !/\$NaN|\$0\b/.test(noStrike),
      "a footnoted strike means no cost and no net, never a zero: " + noStrike.replace(/<[^>]*>/g, " "));
  } finally {
    global.setInterval = saved.si; global.setTimeout = saved.st; global.requestAnimationFrame = saved.raf;
    global.clearTimeout = saved.ct; global.clearInterval = saved.ci;
    global.document = saved.doc; global.window = saved.win; global.localStorage = saved.ls; global.fetch = saved.f;
  }
});

test("client: report chart renderer ships the fixes — price-only domain, line mode, staggered labels, clustered marks, span-aware axis, norisk grid", () => {
  const fs = require("fs"), path = require("path");
  const app = require("./_client").clientSource();
  const css = fs.readFileSync(path.join(__dirname, "..", "public", "styles.css"), "utf8");
  for (const frag of ["lineMode", "close-line mode", "off-chart:", "labs[i].y-labs[i-1].y<15", "groups.find", "axDec", "hasRisk", "ai-scen${hasRisk?'':' norisk'}"])
    assert.ok(app.includes(frag), `app.js missing chart-fix marker: ${frag}`);
  assert.ok(!app.includes("for(const l of levels){ if(l.value<lo)lo=l.value; if(l.value>hi)hi=l.value; }"),
    "the level-driven y-domain (the squashed-chart bug) must be gone");
  assert.ok(css.includes(".ai-scen.norisk"), "styles.css missing the 3-column no-risk scenario grid");
});

test("client -74: side-typed glyphs + legend ship end to end; schema bumped so -73 reports invalidate", () => {
  const fs = require("fs"), path = require("path");
  const app = require("./_client").clientSource();
  const css = fs.readFileSync(path.join(__dirname, "..", "public", "styles.css"), "utf8");
  const pol = fs.readFileSync(path.join(__dirname, "..", "src", "poller.js"), "utf8");
  for (const frag of ["AI_MK", "ai-mkleg", "proven-edge signals only", "g.kind==='short'", "distinct signal types at onset", "outTxt", "marksSuppressed"])
    assert.ok(app.includes(frag), `app.js missing -74 marker: ${frag}`);
  assert.ok(css.includes(".ai-mkleg"), "styles.css missing the marker legend");
  for (const frag of ["const AI_SCHEMA_V = 10;", "aiMarksNow", "aiEvEdge", "AI_MARK_MIN_N", "runsOn", "lastEnd", "marksSuppressed"])
    assert.ok(pol.includes(frag), `poller.js missing -74 marker: ${frag}`);
});

test("UI batch -99: density toggle, keyboard nav and focused-ticker chip are fully wired", () => {
  // Three independent features shipped in one build — each pinned across every file it touches,
  // so a partial delivery (markup without wiring, wiring without CSS) is a suite failure.
  const fs = require("fs"), path = require("path");
  const app = require("./_client").clientSource();
  const html = fs.readFileSync(path.join(__dirname, "..", "public", "index.html"), "utf8");
  const css = fs.readFileSync(path.join(__dirname, "..", "public", "styles.css"), "utf8");
  // Density (rewritten 2026.07.27-23): the toggle is gone and compact is the only density. The
  // rules must survive as unconditional CSS — deleting the attribute without keeping the selector
  // weight would silently drop compact back to the base padding, which is the exact failure this
  // pins. Both halves are asserted: the rule still exists, and nothing can turn it off again.
  assert.ok(css.includes(":root .wrap tbody td{font-size:var(--fs-sm)"), "compact table CSS missing");
  assert.ok(!css.includes("[data-density"), "the density attribute selector must be gone — compact is the only density");
  assert.ok(!app.includes("xyzmon.density") && !app.includes("densBtn"), "density toggle wiring must be gone");
  assert.ok(!html.includes('id="densBtn"'), "density button must be gone from the markup");
  // Keyboard nav: slash-search map, j/k movement, re-applied highlight after each render.
  for (const pin of ["kmoveSel(1)", "kmoveSel(-1)", "CSS.escape(state.ksel)", "applyKsel();   // rebuild wipes the j/k highlight"])
    assert.ok(app.includes(pin), `keyboard nav pin missing: ${pin}`);
  assert.ok(css.includes(".wrap tbody tr.krow td"), "krow highlight CSS missing");
  // Focused ticker: set on drawer open, chip in the statusline, report-tab fallback.
  assert.ok(app.includes("state.focus=coin; updateFocusChip()"), "openDetail must set the focus");
  // In-place drawer opens (build -08): trend rows, earnings rows and the actionable [data-dr]
  // button open the drawer over the CURRENT tab — a click must never bounce the user to markets.
  assert.ok(app.includes("if(state.rows.has(c)) openDetail(c); }));   // drawer opens in place"), "trend row click must open the drawer in place (no showView('markets') bounce)");
  assert.ok(app.includes("if(state.rows.has(cn)) openDetail(cn); }));   // in-place drawer"), "actionable data-dr click must open the drawer in place");
  assert.strictEqual((app.match(/if\(state\.rows\.has\(c\)\) openDetail\(c\); \}\)\);   \/\/ in-place drawer/g)||[]).length, 2, "both earnings row wirings must open the drawer in place");
  assert.ok(app.includes("state.focus && state.rows.has(state.focus)"), "report-tab focus fallback missing");
  for (const id of ["focusChipT", "focusChipX"]) assert.ok(html.includes(`id="${id}"`), `focus chip markup missing: ${id}`);
  assert.ok(css.includes(".fchip-t{"), "focus chip CSS missing");
});

test("daily report budget + admin reset + terra effort routing", async () => {
  const fs = require("fs"), path = require("path");
  const pol = fs.readFileSync(path.join(__dirname, "..", "src", "poller.js"), "utf8");
  // ---- source pins: config the two surfaces run on --------------------------------------
  assert.ok(pol.includes('openai: { model: "gpt-5.6-terra", fb: "gpt-5.6-sol"'), "OpenAI default must be terra primary / sol fallback");
  assert.ok(/AI_REPORT_EFFORT = process\.env\.AI_REPORT_EFFORT \|\| "high"/.test(pol), "report effort must default to high");
  assert.ok(/AI_ASK_EFFORT = process\.env\.AI_ASK_EFFORT \|\| "medium"/.test(pol), "ask-terminal effort must default to medium");
  assert.ok(/AI_REPORTS_PER_DAY = Math\.max\(1, Number\(process\.env\.AI_REPORTS_PER_DAY\) \|\| 5\)/.test(pol), "daily cap must default to 5");
  assert.ok(pol.includes("if (effort) oaBody.reasoning_effort = effort;"), "callModel must send reasoning_effort on the OpenAI path only when set");
  assert.ok(/callModel\(AI_MODEL, ctx, \{ effort: AI_REPORT_EFFORT \}\)/.test(pol) && /callModel\(AI_MODEL_FALLBACK, ctx, \{ effort: AI_REPORT_EFFORT \}\)/.test(pol),
    "both report-path model calls must carry the report effort");
  assert.ok(/effort: AI_ASK_EFFORT/.test(pol), "askBoard callBoth must carry the terminal effort");
  assert.ok(pol.includes('error: "daily-cap"'), "generateAiReport must fail closed with daily-cap when the budget is spent");
  assert.ok(pol.includes("aiDay.count++;"), "only successful generations may burn budget");
  assert.ok(pol.includes("timingSafeEqual"), "admin password compare must be constant-time");
  assert.ok(pol.includes("day: aiDay,"), "spent budget must persist with the report cache (redeploy can't refill the day)");
  // ---- terminal ask under an OpenAI key: terra + medium effort actually hit the wire ----
  const { createPoller } = require("../src/poller");
  const store = { loadAll: () => new Map(), loadRegime: () => [], loadLedger: () => null,
    saveLedger: () => {}, insert: () => {}, saveRegime: () => {}, saveNews: () => {}, loadNews: () => null };
  process.env.OPENAI_API_KEY = "test-key";
  try {
    const calls = [];
    const aiFetch = async (url, opts) => { calls.push({ url, body: JSON.parse(opts.body) });
      return { ok: true, json: async () => ({ choices: [{ message: { content: "screen funding<0 & squeeze>50" }, finish_reason: "stop" }] }) }; };
    const p = createPoller({ dex: "xyz", store, log: () => {}, version: "test", crypto: false, aiFetch });
    const d = await p.askBoard("which names are the most crowded shorts?", { universe: [{ t: "SOL", sqz: 71, f: -22 }] });
    assert.equal(d.ok, true, "ask should succeed under the injected OpenAI transport");
    assert.equal(calls[0].url.includes("api.openai.com"), true, "OpenAI key must route to the OpenAI endpoint");
    assert.equal(calls[0].body.model, "gpt-5.6-terra", "terminal ask must run on terra");
    assert.equal(calls[0].body.reasoning_effort, "medium", "terminal ask must run at medium effort");
    assert.ok(calls[0].body.max_completion_tokens >= 1000, "ask budget must leave headroom for reasoning tokens (a 300-token cap returns empty output at medium effort)");
    // stats surface the budget so the health payload and client can show it
    const st = p.stats();
    assert.equal(st.ai.perDay, 5, "stats must expose the 5/day budget");
    assert.equal(st.ai.dayLeft, 5, "no generations yet -> full budget");
  } finally { delete process.env.OPENAI_API_KEY; }
  // ---- admin reset: fails closed, constant-time gate, lockout on failures ----------------
  const p2 = createPoller({ dex: "xyz", store, log: () => {}, version: "test", crypto: false });
  assert.equal(p2.resetAiDay("anything").error, "not-configured", "no ADMIN_PASSWORD -> fails closed");
  process.env.ADMIN_PASSWORD = "correct-horse";
  try {
    assert.equal(p2.resetAiDay("wrong").error, "bad-password", "wrong password rejected");
    const okRes = p2.resetAiDay("correct-horse");
    assert.equal(okRes.ok, true, "right password resets");
    assert.equal(okRes.dayLeft, okRes.perDay, "reset restores the full budget");
    for (let i = 0; i < 8; i++) p2.resetAiDay("wrong-" + i);   // failures only — the one success above must not count
    const locked = p2.resetAiDay("correct-horse");
    assert.equal(locked.error, "rate", "8 failures inside the window lock the endpoint even for the right password");
    assert.ok(locked.retryMs > 0, "lockout must report a retry window");
  } finally { delete process.env.ADMIN_PASSWORD; }
  // ---- client wiring ---------------------------------------------------------------------
  const app = require("./_client").clientSource();
  assert.ok(/admin\\s\+reset-reports/.test(app), "terminal must intercept the admin command");
  assert.ok(app.includes("••••"), "the echoed admin line must be redacted — the password never sits in scrollback");
  assert.ok(app.includes("function termRun") && app.indexOf("admin\\s+reset-reports") < app.indexOf("termEcho(line);"),
    "interception must run BEFORE the raw echo and before any tier can escalate the line");
  assert.ok(app.includes("termAdminReset") && app.includes("/api/ai-reset"), "admin reset client call missing");
  assert.ok(app.includes("data-cap") && app.includes("!b.dataset.cap"), "cooldown ticker must not re-enable a cap-blocked regenerate button");
  assert.ok(app.includes("daily-cap"), "client must handle the daily-cap error distinctly from cooldown");
  assert.ok(app.includes("generations left today") && app.includes("today</span>"), "report card must show the remaining daily budget");
});

test("brief: the delivery hour resolves against a stored offset, and UTC is disclosed not implied", () => {
  const p = ctxHarness();
  const code = p.pushMintCode("owner-z", true);
  p.pushBindNow(code.code, "chat-z", "Milst");
  const get = () => p.getPush("owner-z", true).recipients.find((r) => r.chat === "chat-z");

  // Nobody has told us an offset yet. The brief still fires — it is default-on — but at UTC, and
  // the panel has to say so: a chip reading 07:00 that lands at 04:00 local is the kind of quiet
  // wrongness the reader only finds out about by being woken up.
  assert.equal(get().briefTz, 0);
  assert.equal(get().briefUtc, 1, "a default rider is scheduled in UTC, and the panel must say so");
  assert.equal(get().briefTzKnown, 0, "an unknown offset must be distinguishable from a deliberate UTC");

  // Recording a timezone for an UNRELATED feature must not silently move the brief. Before the
  // default was UTC-anchored, setting quiet hours re-anchored it by the reader's whole offset.
  assert.ok(p.pushSetPrefs("chat-z", { quiet: { from: 23, to: 7, tz: -180 } }, "owner-z", true).ok);
  assert.equal(get().briefUtc, 1, "still on the default, so still UTC");
  assert.equal(get().briefHour, 10);

  // Picking an hour switches them to their own time.
  assert.ok(p.pushSetPrefs("chat-z", { digestHour: 7, tz: -180 }, "owner-z", true).ok);
  assert.equal(get().briefTz, -180);
  assert.equal(get().briefUtc, 0, "an explicitly chosen hour is local, not UTC");
  assert.equal(get().briefTzKnown, 1);
  assert.equal(get().briefHour, 7);

  // Quiet hours remain the legacy fallback for recipients who set them before tz existed.
  const p2 = ctxHarness();
  const c2 = p2.pushMintCode("owner-y", true);
  p2.pushBindNow(c2.code, "chat-y", "Other");
  assert.ok(p2.pushSetPrefs("chat-y", { quiet: { from: 23, to: 7, tz: -300 } }, "owner-y", true).ok);
  assert.equal(p2.briefTzForNow({ quiet: { from: 23, to: 7, tz: -300 } }), -300, "quiet-hours tz is the legacy fallback");
  assert.equal(p2.briefTzForNow({ tz: -120, quiet: { from: 23, to: 7, tz: -300 } }), -120, "an explicit tz wins over the fallback");
  // …but a quiet-hours offset alone does NOT re-anchor the brief: this recipient never chose an
  // hour, so they stay a default rider on the UTC schedule. Recording a timezone for one feature
  // must not silently move the delivery time of another.
  const y = () => p2.getPush("owner-y", true).recipients.find((r) => r.chat === "chat-y");
  assert.equal(y().briefUtc, 1);
  assert.equal(y().briefTz, 0, "default riders are scheduled in UTC regardless of what quiet hours know");
  assert.equal(y().briefTzKnown, 1, "the offset is on file, it is simply not what schedules the default");
  // Choosing an hour promotes them to their own time, and the legacy quiet-hours tz is the fallback.
  assert.ok(p2.pushSetPrefs("chat-y", { digestHour: 8 }, "owner-y", true).ok);
  assert.equal(y().briefUtc, 0);
  assert.equal(y().briefTz, -300, "quiet-hours tz remains the fallback for recipients who predate the tz field");
  assert.ok(!p2.pushSetPrefs("chat-y", { tz: 99999 }, "owner-y", true).ok, "an absurd offset is refused, not stored");

  // The scheduler and the panel must agree on whether a recipient is a default rider, or the chip
  // shows one delivery time and the tick uses another.
  const p3 = ctxHarness();
  assert.equal(p3.briefIsDefaultNow({ tz: -180 }), true, "no chosen hour = default rider = UTC");
  assert.equal(p3.briefIsDefaultNow({ digestHour: 7, tz: -180 }), false);
  const polD = require("fs").readFileSync(require("path").join(__dirname, "..", "src", "poller.js"), "utf8");
  // Same invariant, now expressed through the schedule resolver: a recipient still riding the
  // default is anchored in UTC, and only an explicitly chosen hour is treated as local.
  assert.ok(/const tz = res\.isDefault \? 0 : briefTzFor\(rec\);/.test(polD),
    "delivery must anchor default riders in UTC rather than in a timezone nobody has supplied");
  assert.ok(/const day = schedDueAt\(res, now, tz\);/.test(polD),
    "…and the due check is the shared predicate, so day-of-week applies to every registered send at once");

  // The scheduler and the panel must read the SAME resolver, or they disagree about when it lands.
  const fs = require("fs"), path = require("path");
  const pol = fs.readFileSync(path.join(__dirname, "..", "src", "poller.js"), "utf8");
  assert.equal((pol.match(/briefTzFor\(rec\)/g) || []).length + (pol.match(/briefTzFor\(r\)/g) || []).length >= 2, true,
    "delivery and the payload must both go through briefTzFor");
  assert.ok(!/rec\.quiet && Number\.isFinite\(rec\.quiet\.tz\) \? rec\.quiet\.tz : 0;\s*\n\s*const local = new Date\(now/.test(pol),
    "the old inline quiet-hours offset must be gone from the brief tick");
  const app = require("./_client").clientSource();
  assert.ok(app.includes("tz:-new Date().getTimezoneOffset()"),
    "the browser is the only party that knows the offset \u2014 it must send it with the hour");
  assert.ok(app.includes("r.briefUtc?' UTC':''"), "the chip must mark a default rider as UTC, never imply local time");
});

test("brief admin block renders OUTSIDE the collapsed accordion, and survives an empty roster", () => {
  const fs = require("fs"), path = require("path");
  const html = fs.readFileSync(path.join(__dirname, "..", "public", "index.html"), "utf8");
  assert.ok(/<div class="adm-brief" id="admBriefBox"><\/div>/.test(html), "the brief block needs its own host element");
  // …and that host must NOT sit inside the accordion body that ships hidden.
  const accordion = html.slice(html.indexOf('<div class="adm-recip">'), html.indexOf('<div class="adm-head">'));
  assert.ok(!accordion.includes("admBriefBox"), "controls inside a collapsed section are indistinguishable from controls that do not exist");
  assert.ok(/<div id="admRecB" hidden>/.test(html), "the recipients body is still collapsed by default \u2014 that is what makes the above matter");

  const nodes = ADM_DOM();
  runAdmFn("renderAdmBrief", nodes, ADM_PUSH());
  const out = nodes.admBriefBox.innerHTML;
  assert.equal(nodes.admBriefBox.hidden, false, "an admin must see the block without expanding anything");
  assert.ok(out.includes("adm-brief") && out.includes("adm-brief-f"), "both test-fire buttons must actually render");
  assert.ok(/default 10:00 UTC/.test(out), "the block states the real schedule");
  assert.ok(/5\/6 generations left/.test(out), "…and the remaining budget");
  assert.ok(/1 of 1 linked recipient/.test(out) && /1 on the UTC default/.test(out));

  // Nobody linked yet: the block must still render rather than vanishing with the roster.
  const empty = ADM_DOM();
  runAdmFn("renderAdmBrief", empty, ADM_PUSH({ recipients: [] }));
  assert.ok(empty.admBriefBox.innerHTML.includes("adm-brief"), "the controls do not depend on a populated roster");
  assert.ok(/0 of 0 linked/.test(empty.admBriefBox.innerHTML));

  // Disabled globally, and a prose failure, both have to be visible rather than silent.
  const off = ADM_DOM();
  runAdmFn("renderAdmBrief", off, ADM_PUSH({ brief: { enabled: false, defaultHour: 10, perDay: 6, dayLeft: 6, model: "m", lastErr: "model refused" } }));
  assert.ok(/disabled/.test(off.admBriefBox.innerHTML) && /BRIEF_ENABLED=0/.test(off.admBriefBox.innerHTML));
  assert.ok(/last prose failure: model refused/.test(off.admBriefBox.innerHTML));
});

test("brief chip renders on an expanded admin roster row, and reports UTC honestly", () => {
  const nodes = ADM_DOM();
  runAdmFn("renderAdmRecips", nodes, ADM_PUSH(), { 111: true });
  const out = nodes.admRecB.innerHTML;
  assert.ok(out.includes('data-asched="brief"') && out.includes('data-aschat="111"'),
    "the brief needs its own chip \u2014 it is not one of the push classes, and it is now one chip per registered scheduled send");
  assert.ok(/brief 10:00 UTC/.test(out), "a default rider is on a UTC schedule and the chip must say so, not imply local");
  // Collapsed row: the chip is inside the expander like the class chips, which is fine because the
  // always-visible block above carries the state. Rows only expand on click.
  const shut = ADM_DOM();
  runAdmFn("renderAdmRecips", shut, ADM_PUSH(), {});
  assert.ok(!shut.admRecB.innerHTML.includes("data-asched"), "chips belong to the expanded row");
  // A recipient who turned it off reads off, not a fabricated hour.
  const offRec = ADM_DOM();
  const st = ADM_PUSH();
  st.recipients[0].briefHour = null; st.recipients[0].briefUtc = 0;
  st.recipients[0].sched = { brief: { hour: null, days: null, dflt: 0, daysLabel: "daily", utc: 0 } };
  runAdmFn("renderAdmRecips", offRec, st, { 111: true });
  assert.ok(/brief off/.test(offRec.admRecB.innerHTML));

  // Day-of-week is part of the label, not a hidden setting: a send that only runs Mon/Wed/Fri must
  // say so on the chip, or the reader believes it is daily and wonders why Tuesday was quiet.
  const mwf = ADM_DOM();
  const st2 = ADM_PUSH();
  st2.recipients[0].sched = { brief: { hour: 11, days: [1, 3, 5], dflt: 0, daysLabel: "mon\u00b7wed\u00b7fri", utc: 0 } };
  runAdmFn("renderAdmRecips", mwf, st2, { 111: true });
  assert.ok(/11:00/.test(mwf.admRecB.innerHTML) && /mon\u00b7wed\u00b7fri/.test(mwf.admRecB.innerHTML));
  assert.ok(!/UTC/.test(mwf.admRecB.innerHTML), "an explicitly chosen hour is local, and must not be labelled UTC");
  // The admin write must carry the hour and NOT a timezone: stamping the operator's offset onto
  // somebody else's account would silently move their delivery time.
  const fs = require("fs"), path = require("path");
  const app = require("./_client").clientSource();
  const h = app.slice(app.indexOf("data-apbrief]"), app.indexOf("data-apbrief]") + 900);
  assert.ok(/digestHour: v===''\?null:\+v/.test(h), "admin chip must write the hour");
  assert.ok(!/tz:/.test(h), "…and must never write a timezone on somebody else's behalf");
});

test("telegram + bell carry the confirmation line from ONE event", () => {
  const C = require("../src/compute");
  const ev = { kind: "trend", coin: "SOL", t: "SOL", side: "long", sub: "stack", score: 4, tf: "D1",
    px: 214.36, e21: 209.8, confTf: "D1", confAt: Date.UTC(2026, 6, 27, 0, 0),
    seenAt: Date.UTC(2026, 6, 26, 15, 40), title: "full 4/4 stack", text: "every rung aligned up" };
  const m = C.pushFmt(ev, {});
  assert.ok(m.includes("\u23f1 confirmed D1 close 00:00 UTC"), "the phone shows which close made it true");
  assert.ok(m.includes("first seen Jul 26 15:40"), "…and what the confirmation cost on this alert");
  // An event without confAt (pre--25 ring content) renders exactly as before — no clock line.
  const old = C.pushFmt({ kind: "trend", coin: "X", t: "X", side: "long", sub: "cross", score: 3,
    tf: "D1", px: 1, e21: 1, title: "D1 13/21 cross up", text: "flip" }, {});
  assert.ok(!old.includes("\u23f1"), "no confirmation data, no fabricated line");
  // The web client's formatter mirrors the same fields (pinned as source, mirrored logic).
  const fs = require("fs"), path = require("path");
  const app = require("./_client").clientSource();
  assert.ok(/function trendWhenTxt\(ev\)/.test(app));
  assert.ok(/confirmed \$\{ev\.confTf\|\|ev\.tf\|\|''\} close/.test(app), "the bell log names the confirming close");
  assert.ok(/k==='trend'/.test(app) && /trendWhenTxt\(ev\)/.test(app), "alertText's trend branch reads the shared stamp");
});

test("macro lane, rendered: the drawer shows a scoped tape, an honest empty, or nothing at all", () => {
  const fs = require("fs"), path = require("path");
  const app = require("./_client").clientSource();
  const grab = (name) => {
    const i = app.indexOf("function " + name + "(");
    assert.ok(i >= 0, `${name} not found in app.js`);
    let d = 0;
    for (let k = app.indexOf("{", i); k < app.length; k++) { if (app[k] === "{") d++; if (app[k] === "}") { d--; if (!d) return app.slice(i, k + 1); } }
  };
  // Execute the real function against a stub DOM — an existence pin would not have caught the
  // original bug either, because the old code DID render, just with the wrong rows in it.
  const mk = (rows, news, detail) => new Function(
    "const boxes={};\nconst el=(id)=>boxes[id]||(boxes[id]={innerHTML:'',onclick:null});\n" +
    "const esc=(x)=>String(x==null?'':x).replace(/&/g,'&amp;').replace(/</g,'&lt;');\n" +
    "const fmtAge=()=>'1m';\nconst newsRow=(a)=>'<div class=\"nrow\" data-id=\"'+a.id+'\">'+esc(a.h)+'</div>';\n" +
    "let newsFilter=null,newsMode='all';const showView=()=>{};\n" +
    "const state={detail:" + JSON.stringify(detail) + ",rows:new Map(" + JSON.stringify(rows) + "),news:" + JSON.stringify(news) + "};\n" +
    grab("fillDrawerNews") + "\nfillDrawerNews();\nreturn boxes.dnews.innerHTML;")();
  const now = Date.now();
  const news = { fetchedAt: now, items: [
    { id: 1, tk: null, h: "Petrobras lifts diesel prices", mtk: ["EWZ", "SP500"] },
    { id: 2, tk: null, h: "Bank of Japan holds, yen slips", mtk: ["JPY", "SP500"] },
    { id: 3, tk: null, h: "Seagate 4Q revenue beats", mtk: ["SP500"] },
  ] };
  const ewz = ["xyz:EWZ", { coin: "xyz:EWZ", ticker: "EWZ", uni: "xyz", assetClass: "ETF", nm: "iShares MSCI Brazil ETF", mlane: { label: "Brazil", topics: ["Brazil", "Petrobras"] } }];
  const jpy = ["xyz:JPY", { coin: "xyz:JPY", ticker: "JPY", uni: "xyz", assetClass: "FX", nm: "Japanese yen", mlane: { label: "Japan", topics: ["yen", "Bank of Japan"] } }];
  const spx = ["xyz:SP500", { coin: "xyz:SP500", ticker: "SP500", uni: "xyz", assetClass: "Index", mlane: { broad: true } }];
  const nvda = ["xyz:NVDA", { coin: "xyz:NVDA", ticker: "NVDA", uni: "xyz", assetClass: "Equity", nm: "NVIDIA Corp." }];
  const eur = ["xyz:EURX", { coin: "xyz:EURX", ticker: "EURX", uni: "xyz", assetClass: "FX" }];   // macro, no seeded lane

  const h1 = mk([ewz, jpy, spx, nvda, eur], news, "xyz:EWZ");
  assert.ok(h1.includes('data-id="1"'), "the Brazil headline renders in the Brazil drawer");
  assert.ok(!h1.includes('data-id="2"') && !h1.includes('data-id="3"'),
    "and neither the yen item nor the unrelated print does — the screenshot bug, rendered");
  assert.ok(h1.includes("macro tape \u00b7 Brazil"), "the header names the scope, so the reader knows a filter ran");
  assert.ok(/1 of 3 tape items matched/.test(h1), "provenance line states how much of the tape survived");
  assert.ok(h1.includes("gated on Brazil"), "…and what it was gated on");

  const h2 = mk([ewz, jpy, spx, nvda, eur], news, "xyz:JPY");
  assert.ok(h2.includes('data-id="2"') && !h2.includes('data-id="1"'), "symmetric on the other name");

  const h3 = mk([ewz, jpy, spx, nvda, eur], news, "xyz:SP500");
  for (const id of [1, 2, 3]) assert.ok(h3.includes('data-id="' + id + '"'), "a broad-lane name still takes the whole tape");
  assert.ok(!/tape items matched/.test(h3), "and shows no gate provenance, because no gate ran");

  const h4 = mk([ewz, jpy, spx, nvda, eur], news, "xyz:NVDA");
  assert.ok(!/data-id="/.test(h4), "an equity with no per-name news gets NO tape rows");
  assert.ok(h4.includes("no headlines in the last 72h") && !h4.includes("no matching headlines"),
    "and the equity wording is unchanged — this behaviour was already correct");

  const h5 = mk([ewz, jpy, spx, nvda, eur], news, "xyz:EURX");
  assert.ok(!/data-id="/.test(h5), "a macro name with no seeded lane gets nothing rather than the raw tape");

  // A lane whose topics match nothing today says so, instead of falling back to unrelated items.
  const h6 = mk([ewz, jpy, spx, nvda, eur], { fetchedAt: now, items: [{ id: 3, tk: null, h: "Seagate 4Q revenue beats", mtk: ["SP500"] }] }, "xyz:EWZ");
  assert.ok(!/data-id="/.test(h6) && h6.includes("no matching headlines in the last 72h"),
    "zero matches is stated, not papered over");
  assert.ok(/0 of 1 tape item matched/.test(h6), "singular/plural handled, and the zero is disclosed");
});

test("display-name client wiring: drawer head, board tooltip, report head, style", () => {
  const fs = require("fs"), path = require("path");
  const app = require("./_client").clientSource();
  const css = fs.readFileSync(path.join(__dirname, "..", "public", "styles.css"), "utf8");
  const pol = fs.readFileSync(path.join(__dirname, "..", "src", "poller.js"), "utf8");
  assert.ok(app.includes('${r.nm?`<div class="dname"'), "drawer head renders the name line only when a name exists");
  assert.ok(app.includes("r.nm?r.nm+' \\u00b7 '+r.coin:r.coin"), "board ticker tooltip carries the name");
  assert.ok(app.includes("${r&&r.nm?esc(r.nm)+' \u00b7 ':''}"), "AI report head carries the name");
  assert.ok(css.includes(".drawer .dname{"), "the name line has a style rule");
  // The name must never be an empty rendered element: the guard is the ternary, not a CSS :empty.
  assert.ok(!/class="dname"[^>]*>\$\{esc\(r\.nm\|\|''\)\}/.test(app), "no unconditional name element");
  assert.ok(pol.includes("nm: displayName(r.ticker, r.uni) || undefined,"), "server ships the label, client never derives it");
  assert.ok(pol.includes("mlane: macroLane(r.ticker, r.uni) || undefined,"), "server ships the lane, client never derives it");
  assert.ok(!/topicHit\(/.test(app), "the topic gate must NOT run client-side — one code path, server-owned");
});

test("client: the macro class and the preview shape are renderable in the bell log", () => {
  const fs = require("fs"), path = require("path");
  const app = require("./_client").clientSource();
  assert.ok(/macro:\['MACRO','sec'\]/.test(app), "the log needs a tag or the class renders untagged");
  assert.ok(/if\(k==='macro'\)/.test(app), "…and a renderer, or it renders as a setup and lies");
  assert.ok(/if\(ev\.sub==='preview'\)/.test(app), "the two earnings shapes are told apart client-side too");
  assert.ok(/macro:'universe-wide scheduled binaries/.test(app), "the chip carries its own tooltip");
  assert.ok(/17:00 ET/.test(app), "the earnings tooltip states when the calendar leg lands");
});

test("sse push 2026.07.29-07: client — poll survives stretched, snaps back on error, push reuses loadSnapshot", () => {
  const fs = require("fs"), path = require("path");
  const app = require("./_client").clientSource();
  assert.ok(app.includes("typeof EventSource==='undefined'||_sseSrc"), "no-EventSource browsers keep the poll untouched; double-start guarded");
  assert.ok(app.includes("function _cycleMs(){ return _sseOk?Math.max(state.refreshMs,120000):state.refreshMs; }"),
    "healthy stream stretches the poll to a 120s fallback — never kills it (half-open streams are real)");
  assert.ok(/_sseSrc\.onerror=\(\)=>\{\s*\n\s*if\(_sseOk\)\{ _sseOk=false; startCycle\(\); \}/.test(app), "stream error snaps cadence back instantly");
  assert.ok(app.includes("if(d&&d.dataTs&&d.dataTs!==state.dataTs){ loadSnapshot();"),
    "a pushed version triggers the EXISTING loadSnapshot — the stream changes when we pull, never what");
  assert.ok(app.includes("startEvents();   // push channel first"), "stream armed at boot");
  // startCycle must derive its interval through _cycleMs so a stretch/snap re-arm actually re-times.
  assert.ok(app.includes("const ms=_cycleMs(); cycleTimer=setInterval("), "cycle interval derives from _cycleMs");
});

// ===== build 2026.08.04-04: 1d relabeled 24h, D open column (since UTC daily open) ===========
// The 24h column always was a rolling window (Hyperliquid prevDayPx); the rename plus tooltip
// makes the semantics honest on the label, and D open answers the question the old label
// implied. Manifest pins for the wiring, real execution for the cell markup.
test("D open column: manifest wiring — placed after 24h, visible by default, layout reset armed", () => {
  const fs = require("fs"), path = require("path");
  const app = require("./_client").clientSource();
  // label rename, with the rolling-window disclosure on the tooltip
  assert.ok(/key:'d1', label:'24h'/.test(app), "1d column relabeled 24h");
  assert.ok(app.includes("Rolling 24-hour change") && app.includes("prevDayPx"), "24h tooltip discloses the rolling window and its source");
  // new column exists, right after d1 in COLS and in the default order, and NOT hidden
  assert.ok(/key:'dopen', label:'D open'/.test(app), "D open column defined");
  const ord = app.match(/const DEFAULT_ORDER=\[[^\]]*\];/)[0];
  assert.ok(ord.includes("'d1','dopen','hopen','h4open','h12open','d7'"), "D open leads the anchored block (2026.08.10-01: + H/4h/12h open) between 24h and 7d in the default order");
  const hid = app.match(/const DEFAULT_HIDDEN=\[[^\]]*\];/)[0];
  assert.ok(!hid.includes("'dopen'"), "D open is visible by default — it is the point of the column");
  assert.ok(/const LAYOUT_V=5;/.test(app), "LAYOUT_V bumped so saved layouts pick the column up (v5: sess column, 2026.08.14-01)");
  // anchor derivation: today's UTC day boundary through the SAME openAt walk the M/Y rungs use,
  // % stored as the sortable row value, level kept separately for the hover only
  for (const pin of ["nowD.getUTCDate())", "dop=openAt(d0)", "r.dopenPx=(dop!=null&&dop>0)?dop:undefined",
    "r.dopen=(r.dopenPx!=null&&r.px>0&&isFinite(r.px))?(r.px/r.dopenPx-1)*100:undefined"])
    assert.ok(app.includes(pin), `D open derivation pin missing: ${pin}`);
});

// ===== build 2026.08.04-04 (leg 2): positioning stays OFF earnings messages ==================
// The open claim remains the urgent leg's GATE (the scoping tests above still pin it) but it
// must never appear as message CONTENT — not in Telegram, not in the bell log, not in the
// payload. Renderers stay defensive so old persisted ring entries carrying ev.claim print clean.
test("earnings payloads and renderers carry no positioning anywhere", () => {
  const fs = require("fs"), path = require("path");
  const C = require("../src/compute");
  // Preview: a tomorrow row that (as an old ring entry might) still carries a claim renders without it.
  const prev = C.pushFmt({ kind: "earnings", sub: "preview", d: "2026-08-04",
    tomorrow: [{ t: "CRCL", s: "BMO", eps: 0.22, claim: "Trend retest (short)" }, { t: "LLY", s: "BMO", eps: 6.07 }],
    reported: [{ t: "AMD", s: "AMC", eps: 1.63, epsA: 0.0, d1: -1.8 }] }, {});
  assert.ok(/Reporting tomorrow/.test(prev) && /CRCL/.test(prev) && /est 0\.22/.test(prev), "calendar content intact");
  assert.ok(!/claim/i.test(prev) && !/retest/i.test(prev), "no claim, no signal name — positioning never renders on the calendar");
  // Source: the poller stamps no claim field onto either earnings payload anymore.
  const pol = fs.readFileSync(path.join(__dirname, "..", "src", "poller.js"), "utf8");
  const scan = pol.slice(pol.indexOf("function earnScan()"), pol.indexOf("// ---- macro class"));
  assert.ok(!/claim:/.test(scan), "neither earnings leg emits a claim field — the gate is server-side only");
  assert.ok(/if \(!isOpenAnnounced\(e\)\) continue;/.test(scan), "…while the urgent leg's claim GATE is untouched");
  // Client bell log: the earnings line renders without the claim suffix even on old entries.
  const app = require("./_client").clientSource();
  assert.ok(!app.includes("' \\u00b7 open '+ev.claim+' claim'"), "bell-log earnings line no longer renders the claim");
});

test("focus -02: manifest pins — preview machinery, TG lane, diff disclosure, client wiring", () => {
  const fs = require("fs"), path = require("path");
  const rd = (f) => fs.readFileSync(path.join(__dirname, "..", f), "utf8");
  const cmp = rd("src/compute.js"), pol = rd("src/poller.js"), app = require("./_client").clientSource(), css = rd("public/styles.css");
  for (const pin of ["function focusPreview(", "function focusDiff(", "const FOCUS_PREVIEW_N = 10",
    "if (Number.isFinite(c.tg4h)) s += Math.min(c.tg4h, 2) * 0.5"])
    assert.ok(cmp.includes(pin), "compute pin: " + pin);
  for (const pin of ["const FOCUS_PREVIEW_LEAD = 30 * 60 * 1000", "function buildFocusPreview(",
    "IN-MEMORY ONLY, never persisted", "if (a.tg && a.pub >= now - 4 * HOUR) tg4h++;",
    "const newsTop = matched.slice(0, 3)", "pvDiff", "focusPv = null;",
    "now >= sess.open - FOCUS_PREVIEW_LEAD && now < sess.open"])
    assert.ok(pol.includes(pin), "poller pin: " + pin);
  for (const pin of ["d.state==='preview'", "foccutrule", "focrank", "focbelow", "\\u0394 vs preview:",
    "stamp = preview", "'TG':'WIRE'", "no sentiment scoring"])
    assert.ok(app.includes(pin), "app pin: " + pin);
  assert.ok(css.includes(".focbar.preview") && css.includes(".foccutrule") && css.includes(".focchip.news.hot"), "preview styles present");
  // the preview is a pool, not a record: nothing in the poller may ever persist it
  assert.ok(!pol.includes("saveFocus({ state: focusState, prev: focusPrev, pv") && !/saveFocus\([^)]*focusPv/.test(pol),
    "focusPv can never reach the store");
});
test("whale scale -04: thousands-convention filings detected by implied share price, corrected x1000, flagged; stored data heals at hydrate", async () => {
  const C = require("../src/compute");
  // Pure rule: thousands vs dollars vs the sample floor vs excluded row types.
  assert.equal(C.whale13FScale([{ value: 150, shares: 1000 }, { value: 80, shares: 500 }, { value: 12, shares: 100 }]).mult, 1000, "sub-$1 implied prices -> thousands");
  assert.equal(C.whale13FScale([{ value: 150000, shares: 1000 }, { value: 80000, shares: 500 }, { value: 12000, shares: 100 }]).mult, 1, "normal implied prices -> verbatim");
  assert.equal(C.whale13FScale([{ value: 150, shares: 1000 }, { value: 80, shares: 500 }]).mult, 1, "under the 3-row floor NOTHING is claimed — verbatim");
  assert.equal(C.whale13FScale([{ value: 1, shares: 100, put: "put" }, { value: 2, shares: 100, put: "call" },
    { value: 150000, shares: 1000 }, { value: 80000, shares: 500 }, { value: 12000, shares: 100 }]).mult, 1, "options rows never enter the sample (premium is not a share price)");
  assert.equal(C.whale13FScale([{ value: 200, shares: 200000, shType: "PRN" }, { value: 150000, shares: 1000 },
    { value: 80000, shares: 500 }, { value: 12000, shares: 100 }]).mult, 1, "principal-amount rows never enter the sample");
  // Ingest path: a thousands-style infotable lands as corrected dollars, flagged.
  const { createPoller } = require("../src/poller");
  const J = (o) => ({ ok: true, json: async () => o, text: async () => JSON.stringify(o) });
  const X = (t) => ({ ok: true, json: async () => { throw new Error("xml"); }, text: async () => t });
  const infoThousands = `<x>` +
    `<infoTable><nameOfIssuer>ALPHA CORP</nameOfIssuer><cusip>AAA000000</cusip><value>900000</value><shrsOrPrnAmt><sshPrnamt>3000000</sshPrnamt><sshPrnamtType>SH</sshPrnamtType></shrsOrPrnAmt></infoTable>` +
    `<infoTable><nameOfIssuer>BETA CORP</nameOfIssuer><cusip>BBB000000</cusip><value>500000</value><shrsOrPrnAmt><sshPrnamt>2500000</sshPrnamt><sshPrnamtType>SH</sshPrnamtType></shrsOrPrnAmt></infoTable>` +
    `<infoTable><nameOfIssuer>GAMMA CORP</nameOfIssuer><cusip>CCC000000</cusip><value>100000</value><shrsOrPrnAmt><sshPrnamt>400000</sshPrnamt><sshPrnamtType>SH</sshPrnamtType></shrsOrPrnAmt></infoTable></x>`;
  const mkStore = (loaded) => ({ loadAll: () => new Map(), loadRegime: () => [], loadLedger: () => null,
    saveLedger: () => {}, insert: () => {}, saveRegime: () => {}, saveNews: () => {}, loadNews: () => null,
    saveWhale: () => {}, loadWhale: () => loaded });
  const extFetch = async (url) => {
    if (url.includes("company_tickers")) return J({});
    if (url.includes("submissions/CIK0000000777")) return J({ name: "OLDSCHOOL CAPITAL LP", filings: { recent: {
      form: ["13F-HR"], accessionNumber: ["0007-26-000001"], filingDate: ["2026-08-14"], reportDate: ["2026-06-30"] } } });
    if (url.includes("/000726000001/index.json")) return J({ directory: { item: [{ name: "primary_doc.xml", size: 900 }, { name: "infotable.xml", size: 5000 }] } });
    if (url.includes("/000726000001/infotable.xml")) return X(infoThousands);
    return { ok: false, status: 404, error: "404" };
  };
  const p = createPoller({ dex: "xyz", store: mkStore(null), log: () => {}, version: "test", crypto: false, extFetch });
  p.hydrateWhaleNow();
  p.whaleAdd(777, "Oldschool Capital LP");
  const r = await p.whalePull("OLDSCHOOL");
  assert.ok(r.ok, "ingest: " + (r.error || ""));
  assert.equal(r.total, 1.5e9, "filed 1,500,000 in thousands -> a $1.5B book, not $1.5M");
  const w = p.getWhale().watch[0];
  assert.equal(w.scaled, 1, "list payload carries the correction flag");
  const f = await p.getWhaleFund("OLDSCHOOL");
  assert.equal(f.scaled, 1, "fund card carries it too");
  assert.equal(f.positions[0].value, 900e6, "every position in one currency — deltas and season read corrected dollars");
  // Hydrate migration: a filing stored by a pre--04 build (verbatim thousands, no scaleChecked)
  // heals in place at boot — flagged, x1000, no refetch. A dollars filing just gets the check mark.
  const stored = { ts: 1, watch: [{ key: "OLD", name: "Oldschool Capital LP", cik: 777, notify: 1, addedAt: 1 },
      { key: "MODERN", name: "Modern Fund LP", cik: 888, notify: 1, addedAt: 1 }],
    filings: {
      "777": { "Q2 2026": { acc: "a", form: "13F-HR", filedAt: 1, period: "2026-06-30", url: null,
        book: { total: 1500000, n: 3, nRaw: 3, positions: [
          { cusip: "AAA000000", put: null, name: "ALPHA CORP", cls: null, value: 900000, shares: 3000000, pct: 60 },
          { cusip: "BBB000000", put: null, name: "BETA CORP", cls: null, value: 500000, shares: 2500000, pct: 33.3 },
          { cusip: "CCC000000", put: null, name: "GAMMA CORP", cls: null, value: 100000, shares: 400000, pct: 6.7 }] } } },
      "888": { "Q2 2026": { acc: "b", form: "13F-HR", filedAt: 1, period: "2026-06-30", url: null,
        book: { total: 3e9, n: 3, nRaw: 3, positions: [
          { cusip: "DDD000000", put: null, name: "DELTA CORP", cls: null, value: 2e9, shares: 10e6, pct: 66.7 },
          { cusip: "EEE000000", put: null, name: "EPS CORP", cls: null, value: 0.8e9, shares: 4e6, pct: 26.7 },
          { cusip: "FFF000000", put: null, name: "ZETA CORP", cls: null, value: 0.2e9, shares: 1e6, pct: 6.7 }] } } } },
    unseen: {}, seasons: {} };
  const p2 = createPoller({ dex: "xyz", store: mkStore(stored), log: () => {}, version: "test", crypto: false,
    extFetch: async () => ({ ok: false, status: 404, error: "404" }) });
  p2.hydrateWhaleNow();
  const rows = p2.getWhale().watch;
  const old2 = rows.find((x) => x.key === "OLD"), modern = rows.find((x) => x.key === "MODERN");
  assert.equal(old2.total, 1.5e9, "stored thousands filing healed x1000 at hydrate — no refetch");
  assert.equal(old2.scaled, 1, "and flagged");
  assert.equal(modern.total, 3e9, "a dollars filing is untouched");
  assert.equal(modern.scaled, 0, "and carries no false flag");
  const app = require("./_client").clientSource();
  assert.ok(app.includes("thousands convention") && app.includes("\\u00d7k"), "correction is DISCLOSED on the row, the card and the terminal — never silent");
  assert.ok(app.includes("never read as returns") && app.includes("ENTERING the 13F universe"), "-06: the \u0394QoQ header carries the five-inputs framing — the column must never present as performance");
});

// ============================================================================================
// FOCUS chart viewport (build 2026.08.17-02): zoom/pan over the one archive fetch.
// ============================================================================================
test("focus chart -17.02: manifest pins — viewport math, one-fetch invariant, touch path", () => {
  const fs = require("fs"), path = require("path");
  const rd = (f) => fs.readFileSync(path.join(__dirname, "..", f), "utf8");
  const app = require("./_client").clientSource(), css = rd("public/styles.css");
  // per-TF default windows + zoom clamp: 5m opens on 12h, 15m on 36h, 1h/4h full 72h, floor 2h
  assert.ok(app.includes("const FOCCH_DEF={5:12*3600000,15:36*3600000,60:72*3600000,240:72*3600000}"), "per-timeframe default windows");
  assert.ok(app.includes("const FOCCH_MIN_SPAN=2*3600000"), "zoom floor");
  for (const pin of ["function focChartResetView(", "function focChartClampView(", "function focAggCached("])
    assert.ok(app.includes(pin), "viewport fn pin: " + pin);
  // interactions: wheel about the cursor, double-click reset, pointer pan, two-pointer pinch,
  // minimap drag — all over the cached base, and the wheel handler must not scroll the page
  for (const pin of ["cc.addEventListener('wheel'", "{passive:false}", "cc.addEventListener('dblclick'",
    "cc.addEventListener('pointerdown'", "ptrs.size===2", "pinchRef", "el('focch-vwin')"])
    assert.ok(app.includes(pin), "interaction pin: " + pin);
  // one-fetch invariant: the viewport slices a full-base aggregate; the session VWAP is computed
  // over the WHOLE series and sliced by offset — zoom can never restart it at the view edge
  assert.ok(app.includes("if(FOCCH.agg&&FOCCH.agg.tf===FOCCH.tf&&FOCCH.agg.sn===sn) return FOCCH.agg;"), "aggregate cached per timeframe AND per session list (-19-04)");
  // -19-04: the stroke reads the series through focRuns(vwapS,off,n) instead of indexing inline —
  // same offset slice, same one-aggregate rule, now split into per-session runs on the way out.
  assert.ok(app.includes("focRuns(vwapS,off,n)") && app.includes("vwapS[off+hv]"), "VWAP sliced by offset, never recomputed per viewport");
  assert.ok(app.includes("const fhInView=") , "frozen 1H refs stretch the y-scale only when the first hour is in view");
  // touch: canvas and minimap both opt out of native gestures so pinch/drag reach the handlers
  assert.ok(css.includes("#focch-cc{touch-action:none}") && css.includes("#focch-vbar"), "touch-action + minimap styles");
  // Restamped 2026.08.21-01: the CHARTS tab now legitimately reads the same archive, so the old
  // whole-client regex count would fail on out-of-scope fetches its own message disclaimed. The
  // FOCUS chart's fetch is pinned by ITS OWN literal (the &max=2000 cap is unique to it): exactly
  // one such pull, and no 1m fetch anywhere in the client.
  assert.equal((app.match(/&res=5m&from='\+from\+'&to='\+to\+'&max=2000/g) || []).length, 1,
    "the focus chart's only fetch is its single archive pull (max=2000)");
  assert.ok(!app.includes("res=1m"), "no 1m fetch remains anywhere in the client");
});

test("focus -17.03: manifest pins — forming engine transient, cadence, client styling, ET clocks", () => {
  const fs = require("fs"), path = require("path");
  const rd = (f) => fs.readFileSync(path.join(__dirname, "..", f), "utf8");
  const pol = rd("src/poller.js"), app = require("./_client").clientSource(), css = rd("public/styles.css"), cmp = rd("src/compute.js");
  // 2026.08.18-04: the cadence moved 55s -> 25s (FOCUS_FORMING_MS, shipped on the payload) and the
  // fold is no longer handed a null — a seat with no bars publishes coverage and no record at all.
  // The transience contract this test guards is unchanged; the two constants it named are not.
  for (const pin of ["let focusForming = null;", "function buildFocusForming(", "now - focusForming.at < FOCUS_FORMING_MS",
    "firstHourStats(bars, st.open, endW, 1)", "foldLiveMark(f, r && r.px > 0 ? +r.px : null)",
    "focusForming = null;               // the frozen record replaces every forming read"])
    assert.ok(pol.includes(pin), "poller pin: " + pin);
  assert.ok(cmp.includes("function foldLiveMark("), "pure fold lives in compute");
  // transience: the persistence call site must remain exactly the two-field record
  // 2026.08.18-03: the blob gained `limits` (the wall rides the record, one atomic write). The
  // load-bearing half of this pin is the NEGATIVE one — forming reads must never reach the store.
  assert.ok(pol.includes("store.saveFocus({ state: focusState, prev: focusPrev, limits: focusLim })") && !/saveFocus\([^)]*[Ff]orming/.test(pol),
    "forming reads can never reach the store");
  assert.ok(pol.includes("forming: focusState && focusState.day === today && !focusState.filledAt && focusForming ? focusForming : null"),
    "the payload carries forming only between stamp and freeze");
  for (const pin of ['data-forming="1"', "forming, freeze at +1h", "forming reads appear once the first 1m bar closes"])
    assert.ok(app.includes(pin), "app pin: " + pin);
  assert.ok(css.includes("td[data-forming]"), "forming cells styled distinct from frozen");
  // ET clocks: every focus-module time string renders in America/New_York, labeled ET
  assert.ok(!app.includes("ET-side"), "the mislabeled local-time stamp is gone");
  for (const pin of ["stamped ${new Date(day.frozenAt).toLocaleTimeString('en-US',{timeZone:'America/New_York'",
    "{timeZone:'America/New_York',hour:'2-digit',minute:'2-digit',second:'2-digit'})} ET</span>"])
    assert.ok(app.includes(pin), "ET clock pin");
});

// ============================================================================================
// FOCUS PX column (folded into build 2026.08.17-03): where you sit vs the frozen geometry.
// ============================================================================================
test("focus -17.03: PX column pins — one accessor, frozen ticks labeled, honest staleness", () => {
  const fs = require("fs"), path = require("path");
  const app = require("./_client").clientSource();
  // the column reads liveMark — the screener's own accessor — so the two tabs can never disagree
  assert.ok(app.includes("{k:'px', label:'PX'"), "PX column exists");
  assert.ok((app.match(/liveMark\(p\.coin\)/g) || []).length >= 2, "PX reads the board's live-mark accessor (cell + sort)");
  // fallback + staleness honesty: no live mark -> the last archive print, said out loud, dimmed
  assert.ok(app.includes("live mark unavailable \\u2014 showing the last archive print (stale)"), "stale fallback is disclosed");
  assert.ok(app.includes("no live mark and no archive print for this name"), "double-miss is a dash, never a fabrication");
  // where-am-I readout: prev close, open/stamp, sVWAP, and the 1H range position
  for (const pin of ["\\u0394 prev close", "\\u0394 sVWAP", "above the 1H HI", "below the 1H LO", "inside the 1H range"])
    assert.ok(app.includes(pin), "readout pin: " + pin);
  // with a live PX beside it, every frozen tick must say it is frozen
  assert.ok(app.includes("the 10:30 print (FROZEN") && app.includes("frozen (live price → PX column)"),
    "the range bar's amber tick can no longer be misread as live");
});


test("whale put/call coloring (2026.08.17-04): option badges carry their side — puts down-red, calls up-green, everywhere they render", () => {
  const fs = require("fs"), path = require("path");
  const app = require("./_client").clientSource();
  assert.ok(app.includes('whl-put ${p.put}'), "modal badge carries the side class");
  assert.ok(/whl-oc '\+r\.put\+'/.test(app), "season/crowding suffixes carry it");
  assert.ok(app.includes("p.put==='put'?'neg':'pos'") && app.includes("r.put==='put'?'neg':'pos'"), "terminal cards reuse the terminal's own side colors");
  const css = fs.readFileSync(path.join(__dirname, "..", "public", "styles.css"), "utf8");
  assert.ok(css.includes(".whl-put.put") && css.includes(".whl-put.call") && css.includes(".whl-oc.put"), "side colors styled off --up/--down");
});

test("whale roster -01: the crowding grid has ONE producer — cells cannot be drawn from the live watchlist", () => {
  const fs = require("fs"), path = require("path");
  const app = require("./_client").clientSource();
  const fn = app.slice(app.indexOf("function renderWhlSeason()"));
  const body = fn.slice(0, fn.indexOf("\nfunction "));
  const cells = body.slice(body.indexOf("const cells="), body.indexOf("const crowd="));
  assert.ok(/\(a\.roster\|\|\[\]\)\.map/.test(cells),
    "cells iterate the season aggregate's roster — the list the counts were computed from");
  assert.ok(!/WHL\.data\.watch/.test(cells),
    "and NEVER the live watchlist: that is the two-producer split that let the squares and the N/M contradict each other");
  assert.ok(/w\.dropped/.test(cells), "a departed fund's square marks itself as history");
  assert.ok(/whl-stale/.test(body) && /s\.stale/.test(body), "the stale chip renders off the server's flag, never re-derived client-side");
  const css = fs.readFileSync(path.join(__dirname, "..", "public", "styles.css"), "utf8");
  assert.ok(css.includes(".whl-cell.gone") && css.includes(".whl-stale"), "both new states are styled");
});

test("focus -03: the prior list renders only when asked, and the toggle survives the clear", () => {
  const fs = require("fs"), path = require("path");
  const app = require("./_client").clientSource();
  const fn = app.slice(app.indexOf("function renderFocus()"));
  const body = fn.slice(0, fn.indexOf("\nfunction "));
  const pick = body.slice(body.indexOf("const day="), body.indexOf("\n  if(!FOC.showPrev"));
  assert.ok(/const day=FOC\.showPrev\?\(d\.prev\|\|null\):\(d\.today\|\|null\);/.test(pick),
    "no implicit fallback to d.prev — an empty list is a true statement about the day, a substituted one is not");
  assert.ok(!/d\.state==='pre'/.test(pick) && !/d\.state==='offday'/.test(pick),
    "the pre/offday auto-substitution is gone from the selection expression entirely");
  assert.ok(!body.includes("usingPrevAuto"), "…and so is the banner that narrated it");
  const bar = body.slice(body.indexOf('id="focprev"') - 200, body.indexOf('id="focprev"') + 120);
  assert.ok(/\+\(d\.prev\?/.test(bar) && !/d\.prev&&d\.today\?/.test(bar),
    "the toggle is gated on d.prev ALONE: gating on d.today removes it exactly when the clear makes it the only route back");
  assert.ok(/d\.state==='cleared'/.test(app) && /00:00 UTC/.test(app), "the cleared state renders its own line");
  const empty = body.slice(body.indexOf("if(!day){"), body.indexOf("if(!day){") + 700);
  assert.ok(/d\.state==='cleared'\?/.test(empty) && /d\.state==='offday'\?/.test(empty),
    "the empty-state copy names the state that produced it rather than one generic message");
});

test("focus -05: manifest pins — 1m base everywhere the hour is measured, 30s cadence, honest dash", () => {
  const fs = require("fs"), path = require("path");
  const rd = (f) => fs.readFileSync(path.join(__dirname, "..", f), "utf8");
  const pol = rd("src/poller.js"), app = require("./_client").clientSource(), css = rd("public/styles.css");
  // engine: both the forming read and the freeze read 1m; neither reads 5m for the hour
  assert.equal(pol.split("store.readCandles1m(p.coin").length - 1, 3, "forming, freeze and the close fill read the 1m archive — exactly three sites (-19-05)");
  assert.ok(!/readCandles\(p\.coin/.test(pol), "no first-hour path reads the 5m archive any more");
  assert.ok(pol.includes("const FOCUS_FORMING_MS = 25 * 1000"), "republish cadence sits inside the client's 30s poll");
  assert.ok(pol.includes("formingMs: FOCUS_FORMING_MS"), "…and ships on the payload so the two cannot drift");
  assert.ok(pol.includes('st.h1src = "1m";'), "the freeze stamps its resolution on the record");
  assert.ok(pol.includes("cov[p.ticker] = { bars: bars.length"), "forming publishes per-seat coverage");
  assert.ok(/r\.p\.h1cov = \{ bars: r\.n, mins, inWin:/.test(pol),
    "the frozen record carries coverage too — raw read AND the in-window count the geometry used");
  assert.ok(pol.includes("if (!f) continue;"), "no bars -> no forming record, so the fold is never handed a null");
  // splice: 1m authoritative, overlapping 5m dropped
  assert.ok(pol.includes("rows5.filter((k) => k[0] < win.from || k[0] > win.to).concat(rolled)"),
    "the overlapping 5m rows are DROPPED before the 1m rollup is concatenated — the double-count guard");
  assert.ok(pol.includes("bucketCandles(raw1, 5, 60000)"), "1m rolls up to the 5m grid server-side, so the client keeps one base");
  assert.ok(pol.includes("function m1Window("), "one resolver owns which span the 1m archive covers");
  // client: cadence follows the server, the dry cell states itself, no 1m timeframe is offered
  assert.ok(app.includes("function focArmPoll(") && app.includes("(FOC.data.formingMs||25000)"), "the poll follows the server's cadence");
  assert.ok(app.includes("function focDry(") && app.includes('focpend dry'), "a seat with no bars has its own state and its own reason");
  assert.ok(!/data-tf="1"/.test(app) && !/>1m</.test(app.slice(app.indexOf("function focChartOpen("), app.indexOf("function focChartOpen(") + 9000)),
    "the 1m timeframe is never offered in the chart selector — it is a base, not a view");
  assert.ok(css.includes(".foctbl td.focpend.dry"), "the dry state is visually distinct from 'still filling'");
});

test("whale who-holds -07: a spelling collision is two issuers, never one merged result — per-issuer basis/name/ticker/totals, exclusive direction counts, common vs option notional split", async () => {
  const { createPoller } = require("../src/poller");
  const C = require("../src/compute");
  const store = { loadAll: () => new Map(), loadRegime: () => [], loadLedger: () => null,
    saveLedger: () => {}, insert: () => {}, saveRegime: () => {}, saveNews: () => {}, loadNews: () => null,
    saveWhale: () => {}, loadWhale: () => null };
  const J = (o) => ({ ok: true, json: async () => o, text: async () => JSON.stringify(o) });
  const X = (t) => ({ ok: true, json: async () => { throw new Error("xml"); }, text: async () => t });
  const row = (nm, cu, v, sh, pc, cls) => `<infoTable><nameOfIssuer>${nm}</nameOfIssuer>${cls ? "<titleOfClass>" + cls + "</titleOfClass>" : ""}<cusip>${cu}</cusip><value>${v}</value><shrsOrPrnAmt><sshPrnamt>${sh}</sshPrnamt><sshPrnamtType>SH</sshPrnamtType></shrsOrPrnAmt>${pc ? "<putCall>" + pc + "</putCall>" : ""}</infoTable>`;
  // The shipped -06 failure, reproduced exactly: the query "AMD" resolves to ADVANCED MICRO
  // DEVICES by ticker AND appears inside "AMDOCS LTD" by substring. Two issuers, two CUSIP
  // prefixes (007903 / G02602). ALPHA holds both.
  // ALPHA also holds AMD across TWO common lots that move in OPPOSITE directions (COM up, SHS
  // down) — the -06 double-count fixture — plus an options line that must never vote.
  const A_Q2 = `<x>${row("ADVANCED MICRO DEVICES INC", "007903107", 900e6, 9e6, null, "COM")}`
    + `${row("AMD INC", "007903206", 20e6, 2e5, null, "SHS")}`
    + `${row("ADVANCED MICRO DEVICES INC", "007903107", 500e6, 5e6, "Put", "COM")}`
    + `${row("AMDOCS LTD", "G02602103", 30e6, 3e5, null, "COM")}</x>`;
  const A_Q1 = `<x>${row("ADVANCED MICRO DEVICES INC", "007903107", 600e6, 6e6, null, "COM")}`
    + `${row("AMD INC", "007903206", 40e6, 4e5, null, "SHS")}`
    + `${row("AMDOCS LTD", "G02602103", 20e6, 2e5, null, "COM")}</x>`;
  // BETA holds ONLY the collision name — it must be not-held on AMD and a holder on AMDOCS.
  const B_Q2 = `<x>${row("AMDOCS LTD", "G02602103", 50e6, 5e5, null, "COM")}</x>`;
  const B_Q1 = `<x>${row("AMDOCS LTD", "G02602103", 80e6, 8e5, null, "COM")}</x>`;
  const sub = (a2, a1) => J({ name: "X", filings: { recent: {
    form: ["13F-HR", "13F-HR"], accessionNumber: [a2, a1],
    filingDate: ["2026-08-14", "2026-05-15"], reportDate: ["2026-06-30", "2026-03-31"] } } });
  const idx = J({ directory: { item: [{ name: "primary_doc.xml", size: 9 }, { name: "infotable.xml", size: 999 }] } });
  const extFetch = async (url) => {
    if (url.includes("company_tickers.json")) return J({ 0: { cik_str: 1, ticker: "AMD", title: "Advanced Micro Devices, Inc." },
      1: { cik_str: 2, ticker: "DOX", title: "Amdocs Limited" } });
    if (url.includes("company_tickers_mf")) return J({ fields: ["cik"], data: [] });
    if (url.includes("submissions/CIK0000000201")) return sub("0201-26-000002", "0201-26-000001");
    if (url.includes("submissions/CIK0000000202")) return sub("0202-26-000002", "0202-26-000001");
    if (url.includes("/020126000002/infotable.xml")) return X(A_Q2);
    if (url.includes("/020126000001/infotable.xml")) return X(A_Q1);
    if (url.includes("/020226000002/infotable.xml")) return X(B_Q2);
    if (url.includes("/020226000001/infotable.xml")) return X(B_Q1);
    if (url.includes("/index.json")) return idx;
    return { ok: false, status: 404, error: "404" };
  };
  const p = createPoller({ dex: "xyz", store, log: () => {}, version: "test", crypto: false, extFetch });
  p.hydrateWhaleNow();
  p.whaleAdd(201, "Alpha Capital LP"); p.whaleAdd(202, "Beta Partners LLC");
  await p.whalePull("ALPHA"); await p.whalePull("BETA");

  // --- the issuer key is identity, not spelling -------------------------------------------------
  assert.equal(C.whaleIssuerKey("007903107", "ADVANCED MICRO DEVICES INC"), "C:007903");
  assert.equal(C.whaleIssuerKey("G02602103", "AMDOCS LTD"), "C:G02602");
  assert.notEqual(C.whaleIssuerKey("007903107", "X"), C.whaleIssuerKey("G02602103", "X"),
    "two issuers whose names collide must never share a key");
  assert.equal(C.whaleIssuerKey("BAD", "AMDOCS LTD"), "N:AMDOCS", "no usable cusip falls back to the normalized name");

  const r = await p.getWhaleHolds("AMD");
  assert.ok(r.ok, r.error || "");
  assert.equal(r.issuers.length, 2, "one query, two issuers — the collision is SPLIT, not unioned");

  // --- primary: strongest lane first, with its own name and ticker chip -------------------------
  const amd = r.issuers[0];
  assert.equal(amd.key, "C:007903", "the ticker lane outranks the substring lane");
  // ALPHA files the same issuer under two spellings ("ADVANCED MICRO DEVICES INC" on the COM and
  // puts lines, "AMD INC" on the second share class). The display name is the spelling the most
  // filers used, longest on a tie — NOT the shortest, which is the -06 rule that let a 10-char
  // coincidence title a panel about a 26-char company.
  assert.equal(amd.name, "ADVANCED MICRO DEVICES INC",
    "display name is the modal filed spelling for THIS issuer, not the shortest one in the bucket");
  assert.ok(amd.funds[0].lines.length === 3, "all three lines are in this issuer despite the spelling split");
  assert.ok(/ticker "AMD"/.test(amd.basisLabel), "basis is disclosed per issuer");
  assert.equal(amd.tk, "AMD");
  assert.equal(r.name, amd.name, "top-level mirrors the primary issuer for existing callers");
  assert.equal(r.basis, amd.basisLabel);

  // --- secondary: its own weaker basis, and NO borrowed ticker chip ------------------------------
  const dox = r.issuers[1];
  assert.equal(dox.key, "C:G02602");
  assert.equal(dox.name, "AMDOCS LTD");
  assert.ok(/substring/.test(dox.basisLabel), "the weak lane is named as the weak lane");
  assert.equal(dox.tk, null,
    "the AMD ticker chip belongs to the issuer the company map resolved — -06 stamped it on every issuer in the result");

  // --- totals are per-issuer and split by instrument ---------------------------------------------
  assert.equal(amd.common, 900e6 + 20e6, "common equity only");
  assert.equal(amd.optNotional, 500e6, "option underlying notional stated separately, never summed in");
  assert.equal(amd.combined, 920e6 + 500e6);
  assert.equal(dox.common, 30e6 + 50e6, "AMDOCS totals contain no AMD value whatsoever");
  assert.ok(dox.combined < amd.combined && dox.combined === 80e6, "-06 reported one combined figure spanning both companies");

  // --- holders and not-held are per-issuer ------------------------------------------------------
  assert.equal(amd.held, 1); assert.deepEqual(amd.notHeld, ["BETA"]);
  assert.equal(dox.held, 2); assert.deepEqual(dox.notHeld, []);

  // --- direction is exclusive: one fund, one vote ------------------------------------------------
  // ALPHA's AMD lots disagree (COM +3M sh, SHS -200k sh). -06 answered both `.some()` questions
  // and incremented adding AND cutting off the same fund.
  const alpha = amd.funds.find((f) => f.key === "ALPHA");
  assert.equal(alpha.lines.length, 3,
    "two share classes (007903107 COM, 007903206 SHS) plus the puts line — DIFFERENT cusips, SAME issuer, so the 6-char prefix is what folds them together");
  assert.equal(alpha.mixed, 1, "the row DISCLOSES that its legs disagree");
  assert.equal(alpha.dir, "add", "net across common lines decides; the puts line does not vote");
  assert.equal(amd.adding + amd.cutting + amd.flat, amd.held,
    "counts can never exceed the holder count — the shipped panel printed 3 adding + 2 cutting against 4 hold");
  assert.equal(amd.adding, 1); assert.equal(amd.cutting, 0);
  assert.equal(alpha.lines.length, 3, "COM, SHS and the puts line stay separate");
  assert.ok(alpha.lines.some((l) => l.put === "put") && alpha.lines.some((l) => l.cls && /SHS/.test(l.cls)),
    "the lot class rides every line so one chip component can render them all");
  // BETA cut AMDOCS; ALPHA grew it. Same denominator rule on the other issuer.
  assert.equal(dox.adding, 1); assert.equal(dox.cutting, 1);
  assert.equal(dox.adding + dox.cutting + dox.flat, dox.held);

  // --- an options-only holder is not a directional holder ----------------------------------------
  const optOnly = require("../src/poller");
  void optOnly;
  const r2 = await p.getWhaleHolds("007903107");
  assert.ok(r2.ok && /CUSIP/.test(r2.basis) && r2.issuers.length === 1,
    "an exact CUSIP resolves to exactly one issuer — no substring fishing alongside it");

  // --- client + wiring pins ----------------------------------------------------------------------
  const fs = require("fs"), path = require("path");
  const app = require("./_client").clientSource();
  assert.ok(app.includes("r.issuers") && app.includes("data-whoalt"), "the panel reads the issuer list and can expand a weaker match");
  assert.ok(app.includes("function whoLot(") && !app.includes("whl-clstag\">"),
    "one lot-class chip component; the -06 two-widget split is gone");
  assert.ok(/&lt;0\.1%/.test(app), "sub-0.05% renders as <0.1%, never a fabricated 0.0%");
  assert.ok(app.includes("whlSgnSh(d.dSh)} sh"), "the share unit is printed on the delta column");
  assert.ok(app.includes("optNotional"), "common and option notional are shown as two figures");
  const css = fs.readFileSync(path.join(__dirname, "..", "public", "styles.css"), "utf8");
  assert.ok(css.includes(".whl-wotbl{table-layout:fixed") && css.includes("col.wo-c1"),
    "columns are pinned — -06 let the FUND column absorb every pixel of slack");
  assert.ok(css.includes(".wo-fund>td{border-top"), "fund groups are visually separated");
});

test("whale season roster (2026.08.18-06): the producer exists — build writes agg.roster, payload serves cells, roster-less stored builds heal at hydrate without claiming amendment", async () => {
  const { createPoller } = require("../src/poller");
  const J = (o) => ({ ok: true, json: async () => o, text: async () => JSON.stringify(o) });
  const X = (t) => ({ ok: true, json: async () => { throw new Error("xml"); }, text: async () => t });
  const row = (nm, cu, v, sh, cls) => `<infoTable><nameOfIssuer>${nm}</nameOfIssuer>${cls ? "<titleOfClass>" + cls + "</titleOfClass>" : ""}<cusip>${cu}</cusip><value>${v}</value><shrsOrPrnAmt><sshPrnamt>${sh}</sshPrnamt><sshPrnamtType>SH</sshPrnamtType></shrsOrPrnAmt></infoTable>`;
  // Both funds hold BOTH Alphabet share classes — the duplicate-name case — plus a mover.
  const bookOf = (v) => `<x>${row("ALPHABET INC", "02079K305", v, 1e6, "CAP STK CL A")}${row("ALPHABET INC", "02079K107", v * 0.8, 8e5, "CAP STK CL C")}${row("MICRON TECHNOLOGY INC", "595112103", v * 0.5, 4e5)}</x>`;
  const sub = (pfx) => J({ name: "X", filings: { recent: {
    form: ["13F-HR", "13F-HR"], accessionNumber: [pfx + "-26-000002", pfx + "-26-000001"],
    filingDate: ["2026-08-14", "2026-05-15"], reportDate: ["2026-06-30", "2026-03-31"] } } });
  const idx = J({ directory: { item: [{ name: "primary_doc.xml", size: 9 }, { name: "infotable.xml", size: 999 }] } });
  const mkFetch = () => async (url) => {
    if (url.includes("company_tickers")) return J({});
    if (url.includes("submissions/CIK0000000201")) return sub("0201");
    if (url.includes("submissions/CIK0000000202")) return sub("0202");
    if (url.includes("infotable.xml")) return X(url.includes("/020126") ? bookOf(url.endsWith("2/infotable.xml") ? 1000e6 : 900e6) : bookOf(url.endsWith("2/infotable.xml") ? 600e6 : 500e6));
    if (url.includes("/index.json")) return idx;
    return { ok: false, status: 404, error: "404" };
  };
  const mkStore = (loaded, sink) => ({ loadAll: () => new Map(), loadRegime: () => [], loadLedger: () => null,
    saveLedger: () => {}, insert: () => {}, saveRegime: () => {}, saveNews: () => {}, loadNews: () => null,
    saveWhale: (d) => { if (sink) sink.d = d; }, loadWhale: () => loaded });
  // Leg 1: a fresh build writes the roster — covered funds, watchlist order, key+cik.
  const sink = {};
  const p = createPoller({ dex: "xyz", store: mkStore(null, sink), log: () => {}, version: "test", crypto: false, extFetch: mkFetch() });
  p.hydrateWhaleNow();
  p.whaleAdd(201, "Gamma Capital LP"); p.whaleAdd(202, "Delta Advisors LLC");
  await p.whalePull("GAMMA"); await p.whalePull("DELTA");
  p.whaleSeasonNow(Date.UTC(2026, 7, 16, 12));   // injected grace clock — the real clock sits past Q2's grace, where the window builder has already rolled to Q3
  const s = await p.getWhaleSeasonQ("Q2 2026");
  assert.ok(s.ok, s.error || "");
  assert.deepEqual(s.agg.roster.map((r) => r.key), ["GAMMA", "DELTA"], "roster: covered funds, watch order");
  assert.ok(s.agg.roster.every((r) => Number.isFinite(+r.cik) && !r.dropped), "cik identity present, nobody falsely dropped");
  const alph = s.agg.crowd.filter((r) => r.name === "ALPHABET INC");
  assert.equal(alph.length, 2, "two share classes stay two crowd rows");
  assert.ok(alph.every((r) => r.cls) && alph[0].cls !== alph[1].cls, "each carries its own titleOfClass for on-screen disambiguation");
  assert.ok(alph.every((r) => r.state.GAMMA && r.state.DELTA), "cells have per-fund states for every roster fund");
  // Leg 2: a stored -18-01..-05 blob (accs present, agg.roster ABSENT) heals at hydrate alone —
  // no tick, no pull — and the heal does not claim an amendment.
  const stored = sink.d;
  assert.ok(stored && stored.seasons["Q2 2026"], "fixture: leg-1 state persisted");
  delete stored.seasons["Q2 2026"].agg.roster;                       // exactly what -18-01..-05 wrote
  stored.seasons["Q2 2026"].amended = 0;
  const p2 = createPoller({ dex: "xyz", store: mkStore(stored, null), log: () => {}, version: "test", crypto: false,
    extFetch: async () => ({ ok: false, status: 404, error: "404" }) });
  p2.hydrateWhaleNow();
  const s2 = await p2.getWhaleSeasonQ("Q2 2026");
  assert.ok(s2.ok && s2.agg.roster.length === 2, "roster-less stored season healed at hydrate, zero fetches");
  assert.equal(s2.amended, false, "a shape heal is not an amendment — nothing at EDGAR moved");
  // Wiring pins for the client half.
  const fs = require("fs"), path = require("path");
  const app = require("./_client").clientSource();
  assert.ok(app.indexOf("whl-who") < app.indexOf("d.watch.length?") && app.indexOf("whl-who") > app.indexOf("whl-head"), "-06: the search panel sits under the tab header, ABOVE the watchlist table — a search nobody finds is a search that doesn't exist");
  assert.ok(app.includes("whl-clstag"), "duplicate display names get their share-class tag");
  assert.ok(app.includes("grid cells pending one season rebuild"), "defensive note if an unhealed payload ever serves");
  const css = fs.readFileSync(path.join(__dirname, "..", "public", "styles.css"), "utf8");
  assert.ok(css.includes(".whl-who{border:1px solid"), "the panel is boxed, not a bare label");
});

test("whale season heal v2 (2026.08.19-01): aggregate and header fields are ONE computation — v1-healed mismatches self-repair, counts agree everywhere", async () => {
  const { createPoller } = require("../src/poller");
  const J = (o) => ({ ok: true, json: async () => o, text: async () => JSON.stringify(o) });
  const X = (t) => ({ ok: true, json: async () => { throw new Error("xml"); }, text: async () => t });
  const row = (nm, cu, v, sh) => `<infoTable><nameOfIssuer>${nm}</nameOfIssuer><cusip>${cu}</cusip><value>${v}</value><shrsOrPrnAmt><sshPrnamt>${sh}</sshPrnamt><sshPrnamtType>SH</sshPrnamtType></shrsOrPrnAmt></infoTable>`;
  const book = `<x>${row("APPLE INC", "037833100", 500e6, 5e6)}${row("MICRON TECHNOLOGY INC", "595112103", 300e6, 2e6)}</x>`;
  const sub = (pfx) => J({ name: "X", filings: { recent: {
    form: ["13F-HR", "13F-HR"], accessionNumber: [pfx + "-26-000002", pfx + "-26-000001"],
    filingDate: ["2026-08-14", "2026-05-15"], reportDate: ["2026-06-30", "2026-03-31"] } } });
  const idx = J({ directory: { item: [{ name: "primary_doc.xml", size: 9 }, { name: "infotable.xml", size: 999 }] } });
  const extFetch = async (url) => {
    if (url.includes("company_tickers")) return J({});
    if (url.includes("submissions/CIK0000000301")) return sub("0301");
    if (url.includes("submissions/CIK0000000302")) return sub("0302");
    if (url.includes("infotable.xml")) return X(book);
    if (url.includes("/index.json")) return idx;
    return { ok: false, status: 404, error: "404" };
  };
  const sink = {};
  const mkStore = (loaded) => ({ loadAll: () => new Map(), loadRegime: () => [], loadLedger: () => null,
    saveLedger: () => {}, insert: () => {}, saveRegime: () => {}, saveNews: () => {}, loadNews: () => null,
    saveWhale: (d) => { sink.d = d; }, loadWhale: () => loaded });
  // Assemble real state: 2 funds with Q2 books, season built in-window.
  const p = createPoller({ dex: "xyz", store: mkStore(null), log: () => {}, version: "test", crypto: false, extFetch });
  p.hydrateWhaleNow();
  p.whaleAdd(301, "Epsilon Capital LP"); p.whaleAdd(302, "Zeta Partners LLC");
  await p.whalePull("EPSILON"); await p.whalePull("ZETA");
  p.whaleSeasonNow(Date.UTC(2026, 7, 16, 12));
  // Forge the exact production wreck the screenshot showed: a v1-healed blob whose agg says 2
  // funds while the header fields still describe a dead 8-fund build, PLUS a watch entry with no
  // book (the "missing" fund), PLUS amended=1 narrating an old amendment over it all.
  const stored = sink.d;
  const sn = stored.seasons["Q2 2026"];
  sn.healed = 1; delete sn.healv;
  sn.filedN = 7; sn.watchN = 8; sn.missing = ["PERSHING"]; sn.amended = 1;
  stored.watch.push({ key: "NOBOOK", name: "No Book Yet LP", cik: 999, notify: 1, addedAt: 1 });
  const p2 = createPoller({ dex: "xyz", store: mkStore(stored), log: () => {}, version: "test", crypto: false,
    extFetch: async () => ({ ok: false, status: 404, error: "404" }) });
  p2.hydrateWhaleNow();   // heal v2 fires here — no fetches, pure math
  const s = await p2.getWhaleSeasonQ("Q2 2026");
  assert.ok(s.ok, s.error || "");
  assert.equal(s.agg.nFunds, 2, "aggregate covers the 2 funds with stored books");
  assert.equal(s.filedN, 2, "header filedN describes the SAME computation as the lanes");
  assert.equal(s.watchN, 3, "watchN is today's watchlist, not a dead build's");
  assert.deepEqual(s.missing, ["NOBOOK"], "missing = today's watched funds without a book for the quarter — not a ghost from the old build");
  assert.equal(s.agg.roster.length, 2, "grid roster matches too — one story on the whole panel");
  assert.equal(s.healed, 1, "payload says it was healed; the client renders that instead of the amendment text");
  // Idempotence: a second boot re-runs nothing (healv=2 sticks) and the state is stable.
  const stored2 = sink.d;
  const p3 = createPoller({ dex: "xyz", store: mkStore(stored2), log: () => {}, version: "test", crypto: false,
    extFetch: async () => ({ ok: false, status: 404, error: "404" }) });
  p3.hydrateWhaleNow();
  const s3 = await p3.getWhaleSeasonQ("Q2 2026");
  assert.equal(s3.filedN, 2); assert.equal(s3.watchN, 3);
  const app = require("./_client").clientSource();
  assert.ok(app.includes("rebuilt from stored books"), "healed builds say what they are in both headers — not 'rebuilt after amendment'");
});

test("whale traded-basis lanes (2026.08.19-02): mark drift is priced out — share sellers cannot top MOST BOUGHT, lanes agree with crowding by construction", () => {
  const C = require("../src/compute");
  const P = (cu, nm, v, sh) => ({ cusip: cu, put: null, name: nm, cls: null, value: v, shares: sh, pct: null });
  // The screenshot scenario: MU's price doubles across the quarter. Two funds TRIM shares — their
  // dVal is POSITIVE (marks swamp the selling) — one small fund adds. Old dollar-net called this
  // +$40M "MOST BOUGHT" while the crowding grid said 2 cutting. One panel, two answers.
  const A = { key: "A", cur: { total: 1, n: 1, positions: [P("595112103", "MICRON TECHNOLOGY INC", 180e6, 1e6)] },
              prev: { total: 1, n: 1, positions: [P("595112103", "MICRON TECHNOLOGY INC", 150e6, 1.5e6)] } };
  const B = { key: "B", cur: { total: 1, n: 1, positions: [P("595112103", "MICRON TECHNOLOGY INC", 90e6, 0.5e6)] },
              prev: { total: 1, n: 1, positions: [P("595112103", "MICRON TECHNOLOGY INC", 80e6, 0.8e6)] } };
  const D = { key: "D", cur: { total: 1, n: 1, positions: [P("595112103", "MICRON TECHNOLOGY INC", 36e6, 0.2e6)] },
              prev: { total: 1, n: 1, positions: [P("595112103", "MICRON TECHNOLOGY INC", 18e6, 0.18e6)] } };
  const s = C.whaleSeason([A, B, D]);
  assert.equal(s.bought.length, 0, "a rallying stock everyone trimmed does NOT appear in MOST BOUGHT");
  assert.equal(s.sold.length, 1, "it lands in MOST SOLD — where the share counts say it belongs");
  const mu = s.sold[0];
  // Traded flow: (-0.5M x $180) + (-0.3M x $180) + (+0.02M x $180) = -140.4M, at each filing's own implied Q-end price.
  assert.ok(Math.abs(mu.net - (-140.4e6)) < 1e3, "net is TRADED dollars at implied quarter-end prices, got " + mu.net);
  assert.ok(mu.legs.every((l) => l.dTr != null), "every SH leg carries its traded estimate");
  assert.equal(mu.estN, 0, "no value-only legs here — nothing rides the polluted layer");
  // Crowding and the lane now read the same layer.
  const cr = s.crowd.find((r) => r.cusip === "595112103");
  assert.ok(cr && cr.cutting === 2 && cr.adding === 1, "crowding: 2 cutting, 1 adding — and the lane AGREES");
  // whaleDelta flows: the modal strip's TRIMMED box must be negative for A despite dVal +30M.
  const dd = C.whaleDelta(A.cur, A.prev);
  assert.equal(dd.rows[0].d.cls, "trim");
  assert.ok(dd.rows[0].d.dVal > 0, "fixture sanity: the polluted layer really does read positive");
  assert.ok(Math.abs(dd.rows[0].d.dTr - (-90e6)) < 1e3, "dTr prices the share change alone");
  assert.ok(Math.abs(dd.flows.trimmed - (-90e6)) < 1e3, "the strip's flow is traded dollars, not mark drift");
  // Fallback: an options leg (no comparable shares) still rides dVal, counted and disclosed.
  const O = (v) => ({ cusip: "595112103", put: "call", name: "MICRON TECHNOLOGY INC", cls: null, value: v, shares: null, pct: null });
  const E = { key: "E", cur: { total: 1, n: 1, positions: [O(50e6)] }, prev: { total: 1, n: 1, positions: [O(20e6)] } };
  const s2 = C.whaleSeason([E]);
  const call = (s2.bought.find((r) => r.put === "call")) || null;
  assert.ok(call && call.estN === 1, "value-only leg counted in estN — the row can say which layer it rides");
  // Migration: a stored season whose agg predates the traded basis (no aggV) rebuilds at hydrate
  // even with a perfect roster — new labels must never sit over old-math numbers.
  {
    const { createPoller } = require("../src/poller");
    const stored = { ts: 1,
      watch: [{ key: "A", name: "A LP", cik: 401, notify: 1, addedAt: 1 }],
      filings: { "401": { "Q2 2026": { acc: "x", form: "13F-HR", filedAt: 1, period: "2026-06-30", url: null, scaleChecked: 1,
        book: { total: 180e6, n: 1, nRaw: 1, positions: [{ cusip: "595112103", put: null, name: "MICRON TECHNOLOGY INC", cls: null, value: 180e6, shares: 1e6, pct: 100 }] } },
        "Q1 2026": { acc: "y", form: "13F-HR", filedAt: 1, period: "2026-03-31", url: null, scaleChecked: 1,
        book: { total: 150e6, n: 1, nRaw: 1, positions: [{ cusip: "595112103", put: null, name: "MICRON TECHNOLOGY INC", cls: null, value: 150e6, shares: 1.5e6, pct: 100 }] } } } },
      unseen: {}, seasons: { "Q2 2026": { q: "Q2 2026", at: 1, accs: { 401: "x:y" }, rosterSig: "401",
        filedN: 1, watchN: 1, missing: [], amended: 0,
        agg: { bought: [{ cusip: "595112103", put: null, name: "MICRON TECHNOLOGY INC", net: 30e6, legs: [{ key: "A", dVal: 30e6, dSh: -0.5e6 }], domPct: 100, held: 1, adding: 0, cutting: 1, opened: [], exited: [], state: { A: "trim" } }],
          sold: [], opens: [], exits: [], crowd: [], nFunds: 1, roster: [{ key: "A", cik: 401 }] } } } };   // old-math agg: trim shows as BOUGHT, no aggV
    const st = { loadAll: () => new Map(), loadRegime: () => [], loadLedger: () => null, saveLedger: () => {}, insert: () => {},
      saveRegime: () => {}, saveNews: () => {}, loadNews: () => null, saveWhale: () => {}, loadWhale: () => stored };
    const p4 = createPoller({ dex: "xyz", store: st, log: () => {}, version: "test", crypto: false,
      extFetch: async () => ({ ok: false, status: 404, error: "404" }) });
    p4.hydrateWhaleNow();
    return (async () => {
      const sh = await p4.getWhaleSeasonQ("Q2 2026");
      assert.ok(sh.ok, sh.error || "");
      assert.equal(sh.agg.bought.length, 0, "the old-math agg (trim shown as bought) was rebuilt at hydrate under the traded basis");
      assert.ok(sh.agg.sold.length === 1 && Math.abs(sh.agg.sold[0].net - (-90e6)) < 1e3, "and the rebuilt lane prices the share change: -0.5M sh x $180");
    })().then(() => {
  // Client pins: labels name the basis; tag collisions fall to cusip.
  const fs = require("fs"), path = require("path");
  const app = require("./_client").clientSource();
  assert.ok(app.includes("MOST BOUGHT \\u00b7 net traded $ (est)") && app.includes("MOST SOLD \\u00b7 net traded $ (est)"), "lane labels state the traded basis");
  assert.ok(app.includes("no comparable share counts"), "value-only legs disclosed per row");
  assert.ok(app.includes("tagCount"), "duplicate-name tags that collide (Equity/Equity) fall back to the cusip head");
    });
  }
});

test("FOCUS chart -04: the VWAP is PER SESSION — it dies at its own close and re-anchors at the next open", () => {
  const F = FOCCH_FIX;
  const api = focchApi(F.sessions, { open: F.tueOpen, close: F.tueClose }, 15);
  const { bars, vwapS } = api.focAggCached();
  assert.ok(bars.length > 100, "fixture aggregated to a real bar array");
  const at = (t) => { const i = bars.findIndex((b) => b[0] === t); assert.ok(i > -1, "bar at " + t); return i; };
  // Before Tuesday's open: no session, no VWAP. (This part was already right; it must stay right.)
  assert.equal(vwapS[at(F.tueOpen - 2 * F.H)], null, "pre-market has no VWAP");
  assert.equal(vwapS[at(F.tueOpen - 15 * F.M)], null, "the bar before the open has no VWAP");
  // Inside Tuesday: live.
  assert.ok(vwapS[at(F.tueOpen)] != null, "the opening bar anchors the run");
  assert.ok(vwapS[at(F.tueOpen + 2 * F.H)] != null, "mid-session VWAP is live");
  // THE BUG. Every one of these was a real number before this build.
  assert.equal(vwapS[at(F.tueClose)], null, "the closing bucket ends the session — no VWAP AT the close");
  assert.equal(vwapS[at(F.tueClose + 30 * F.M)], null, "post-market: the session is over, the line is gone");
  assert.equal(vwapS[at(F.tueOpen + 18 * F.H)], null, "overnight: no VWAP survives the night");
  assert.equal(vwapS[at(F.wedOpen - 30 * F.M)], null, "next pre-market: yesterday's VWAP does not lead into today");
  // Wednesday re-anchors at ITS open, carrying nothing from Tuesday.
  const wI = at(F.wedOpen), wb = bars[wI];
  assert.ok(vwapS[wI] != null, "Wednesday's opening bar anchors a NEW run");
  const ownTypical = (wb[2] + wb[3] + wb[4]) / 3;
  assert.ok(Math.abs(vwapS[wI] - ownTypical) < 1e-9,
    `first bar of a session VWAPs to its own typical price (${vwapS[wI]} vs ${ownTypical}) — a carried-over run could not`);
  // And the whole invariant, stated once: a VWAP point can never land where the shading is dark.
  const sess = api.focChartSessions();
  for (let i = 0; i < bars.length; i++) {
    if (vwapS[i] != null) assert.ok(api.focSessIdx(sess, bars[i][0]) >= 0,
      "VWAP point at " + new Date(bars[i][0]).toISOString() + " sits outside every cash window");
  }
});

test("FOCUS chart -04: nulls BREAK the VWAP path — the overnight is a gap, never a straight line across it", () => {
  const F = FOCCH_FIX;
  const api = focchApi(F.sessions, { open: F.tueOpen, close: F.tueClose }, 15);
  const { bars, vwapS } = api.focAggCached();
  const runs = api.focRuns(vwapS, 0, bars.length);
  assert.equal(runs.length, 2, "two sessions on the tape -> two strokes, not one continuous line");
  const spanOf = (r) => [bars[r[0][0]][0], bars[r[r.length - 1][0]][0]];
  const [a0, a1] = spanOf(runs[0]), [b0, b1] = spanOf(runs[1]);
  assert.ok(a0 === F.tueOpen && a1 < F.tueClose, "run 1 is Tuesday's cash window and nothing else");
  assert.ok(b0 === F.wedOpen && b1 <= F.wedClose, "run 2 starts at Wednesday's open");
  assert.ok(a1 < b0, "the runs do not touch — the gap between them is the night");
  // Mutation guard: a path that merely SKIPS nulls yields one run and would bridge the gap.
  const naive = [];
  for (let i = 0; i < bars.length; i++) if (vwapS[i] != null) naive.push(i);
  assert.ok(naive.length > runs[0].length, "the skip-nulls path would have joined the two sessions into one stroke");
});

test("FOCUS chart -04: frozen 1H geometry is clipped to its OWN session, in both directions", () => {
  const F = FOCCH_FIX;
  const api = focchApi(F.sessions, { open: F.tueOpen, close: F.tueClose }, 15);
  const { bars } = api.focAggCached();
  const [i0, i1] = api.focSessSpan(bars, F.tueOpen, F.tueClose);
  assert.ok(i0 > 0, "the span does not start at index 0 — the lines no longer reach back before the open");
  assert.ok(i1 < bars.length - 1, "the span does not end at the last bar — the lines no longer run to the right edge");
  assert.equal(bars[i0][0], F.tueOpen, "the clip starts exactly at the open");
  assert.ok(bars[i1][0] < F.tueClose && bars[i1][0] + 15 * F.M >= F.tueClose, "and ends on the last bucket inside the close");
  // A viewport that contains no bar of that session draws NOTHING — the old code pinned the dashes
  // to the view edges regardless of where the session was.
  const night = bars.filter((b) => b[0] > F.tueClose && b[0] < F.wedOpen);
  assert.ok(night.length > 10, "fixture really has an overnight stretch");
  assert.deepEqual(api.focSessSpan(night, F.tueOpen, F.tueClose), [-1, -1],
    "session off screen -> no span -> no line");
  // A session still running (close in the future) clips to the last bar it has, not to nothing.
  const [w0, w1] = api.focSessSpan(bars, F.wedOpen, F.wedClose);
  assert.ok(w0 > -1 && bars[w1][0] === bars[bars.length - 1][0], "a live session runs to the last bar on the tape");
});

test("FOCUS chart -04: with no calendar windows the chart degrades to the record's own session, never to a blank", () => {
  const F = FOCCH_FIX;
  const api = focchApi(null, { open: F.tueOpen, close: F.tueClose }, 15);   // payload without sessions
  const sess = api.focChartSessions();
  assert.equal(sess.length, 1, "one window, from the record itself");
  assert.equal(sess[0].open, F.tueOpen);
  assert.equal(sess[0].close, F.tueClose);
  const { bars, vwapS } = api.focAggCached();
  const at = (t) => bars.findIndex((b) => b[0] === t);
  assert.ok(vwapS[at(F.tueOpen + F.H)] != null, "the VWAP still draws inside the charted session");
  assert.equal(vwapS[at(F.tueClose + F.H)], null, "and still dies at the close — the fallback is not a licence to run forever");
  // A record with no close (live session, close not yet known) runs open-ended rather than empty.
  const live = focchApi(null, { open: F.tueOpen, close: null }, 15);
  assert.equal(live.focChartSessions()[0].close, Infinity, "an unknown close is open-ended, not zero");
  const lv = live.focAggCached();
  assert.ok(lv.vwapS[lv.bars.length - 1] != null, "so the live run reaches the last bar");
});

test("FOCUS chart -04: the aggregate cache re-keys on the session list, so a calendar refresh cannot serve a stale VWAP", () => {
  const F = FOCCH_FIX;
  const api = focchApi(F.sessions, { open: F.tueOpen, close: F.tueClose }, 15);
  const first = api.focAggCached();
  assert.ok(api.focAggCached() === first, "same tf + same windows -> the cached object, not a rebuild");
  assert.ok(typeof first.sn === "string" && first.sn.includes(String(F.tueOpen)), "the cache key carries the windows");
});

test("FOCUS chart -04: client manifest — the session helpers exist exactly once and the draw path uses them", () => {
  const { app } = FOCCH_SRC;
  for (const name of ["focChartSessions", "focSessIdx", "focSessSpan", "focRuns"]) {
    const n = (app.match(new RegExp("^function " + name + "\\(", "gm")) || []).length;
    assert.equal(n, 1, `${name} defined exactly once (found ${n})`);
  }
  const draw = app.slice(app.indexOf("function focChartDraw("), app.indexOf("function focChartDraw(") + 9000);
  assert.ok(draw.includes("focSessSpan(bars,"), "the clip span is computed by the shared helper, not re-derived inline");
  assert.ok(draw.includes("focRuns(vwapS,"), "the VWAP is stroked as runs");
  assert.ok(draw.includes("const refLine=(v,col,lab,clip)=>") && !draw.includes("const refLine=(v,col,lab)=>"),
    "refLine takes a clip flag — the unclipped edge-to-edge signature is gone");
  assert.ok(!/const sess=\(FOC\.data&&FOC\.data\.sessions\)/.test(draw),
    "the shading reads the shared window list — one definition, so shading and VWAP can never disagree");
});

test("focus -05: the CLOSE column tells 'not yet' apart from 'closed, and this seat had nothing'", () => {
  const FOC = { _day: { closedAt: 0 } };
  const api = focCols(FOC);
  const col = api.focCol("close");
  assert.ok(col, "the CLOSE column exists");
  const row = { ticker: "NBIS", prevClose: 268.18, h1: { openPx: 268.83 } };

  // Mid-session: a pending cell, and NOT a dash — "the session has not closed" is a different
  // statement from "no data", and collapsing them is the category error this column must avoid.
  const pending = col.td(row);
  assert.match(pending, /at close/, "before 16:00 the cell says the close is still ahead");
  assert.ok(!/\u2014<\/span>/.test(pending), "…and does not render the na dash, which would mean something else");
  assert.ok(!/268|241/.test(pending), "no price of any kind stands in for a close that does not exist");

  // Closed, seat had no bars: now it IS a dash, and the dash carries its own reason.
  FOC._day = { closedAt: 1 };
  const dark = col.td({ ...row, closePx: null, closeCov: { bars: 0, inWin: 0, slopMin: null } });
  assert.match(dark, /—/, "a closed session with no bars is an honest dash");
  assert.match(dark, /landed nothing/, "…and says which of the two silences this was");

  // Closed with a print: the number, plus the move off THIS session's open.
  const done = col.td({ ...row, closePx: 237.60, closeCov: { bars: 390, inWin: 390, slopMin: 1 } });
  assert.match(done, /237\.60/, "the close price renders");
  assert.match(done, /-11\.6%/, "with the move from the 268.83 open, signed");
  assert.match(done, /neg/, "and coloured by that move");
  assert.ok(!/lane did not reach/.test(done), "a complete lane makes no shortfall claim");

  // A short lane still shows its number, but discloses the gap and dims it.
  const short = col.td({ ...row, closePx: 237.60, closeCov: { bars: 386, inWin: 386, slopMin: 4 } });
  assert.match(short, /4m before 16:00/, "a close read off a short lane says so on the cell");
  assert.match(short, /class="dim"/, "…and is visually demoted rather than presented as the 16:00 print");
});

test("focus -05: the OPEN column is the 09:30 archive print, and sorts on it", () => {
  const api = focCols({ _day: { closedAt: 0 } });
  const col = api.focCol("open");
  assert.ok(col && col.h1, "OPEN rides the h1 record, so it forms and freezes with the rest");
  const row = { ticker: "NBIS", prevClose: 268.18, h1: { openPx: 268.83, hi: 274.91, lo: 262.17 } };
  const cell = col.td(row);
  assert.match(cell, /268\.83/, "the opening print renders");
  assert.match(cell, /\+0\.2% from the 268\.18 prev close/, "hover carries the realised gap");
  assert.equal(col.sv(row), 268.83, "sortable on the open itself");
  assert.equal(col.sv({ ticker: "X" }), null, "no h1 -> no sort value, never a zero");
  assert.match(col.td({ ticker: "X" }), /—/, "…and no h1 renders the dash with its coverage reason");
  // Once the close exists the open's tooltip carries the day's whole move, from one measurement.
  assert.match(col.td({ ...row, closePx: 237.60 }), /closed -11\.6% off it/, "the day's move, off the open");
});

test("focus -05: focMoveCol is the ONE reorder, shared by the mouse and touch paths", () => {
  const saved = { n: 0 };
  const FOC = { order: ["ticker", "why", "px", "open", "close", "gap"], _day: null };
  const api = focCols(FOC, saved);
  assert.ok(api.focMoveCol("close", "px", true), "a column moves before its target");
  assert.deepEqual(FOC.order, ["ticker", "why", "close", "px", "open", "gap"]);
  assert.equal(saved.n, 1, "…and the new order is persisted, once");
  assert.ok(api.focMoveCol("close", "gap", false), "and after it, on the other side of the drop");
  assert.deepEqual(FOC.order, ["ticker", "why", "px", "open", "gap", "close"]);
  // The refusals. Each of these was a way to corrupt the order or lose a column entirely.
  assert.equal(api.focMoveCol("px", "px", true), false, "a column cannot be dropped on itself");
  assert.equal(api.focMoveCol("px", "ticker", true), false, "the locked TICKER column is not a drop target");
  assert.equal(api.focMoveCol("px", "nope", true), false, "an unknown target moves nothing");
  assert.equal(api.focMoveCol(null, "px", true), false, "no drag key, no move");
  assert.deepEqual(FOC.order, ["ticker", "why", "px", "open", "gap", "close"], "every refusal left the order intact");
  assert.equal(saved.n, 2, "and no refusal wrote to storage");
});

test("focus -05: manifest — close fill wired into the tick, touch reorder wired into the header", () => {
  const fs = require("fs"), path = require("path");
  const rd = (f) => fs.readFileSync(path.join(__dirname, "..", f), "utf8");
  const app = require("./_client").clientSource(), pol = rd("src/poller.js"), css = rd("public/styles.css");
  for (const pin of ["function closeFocus(", "const FOCUS_CLOSE_GRACE", "const FOCUS_CLOSE_SLOP",
    "if (held && now >= sess.close) closeFocus(focusState, now);",
    "closedAt: 0, closeNote: null, closeLate: 0"])
    assert.ok(pol.includes(pin), "poller pin: " + pin);
  assert.ok(pol.includes("store.readCandles1m(p.coin, st.open - 1, st.close + 1)"),
    "the close read is bounded by the record's own session, not by now");
  for (const pin of ["function focMoveCol(", "function focWireTouchDrag(", "const FOC_HOLD_MS",
    "th.addEventListener('pointerdown'", "th.setPointerCapture(pid)", "{k:'open', label:'OPEN'", "{k:'close', label:'CLOSE'"])
    assert.ok(app.includes(pin), "client pin: " + pin);
  assert.equal((app.match(/focMoveCol\(/g) || []).length, 3,
    "one definition of focMoveCol plus exactly two call sites: the mouse drop and the touch drop");
  assert.ok(!/FOC\.order\.splice\(/.test(app),
    "no caller splices the column order directly — every reorder goes through the one validated mutation");
  assert.ok(app.includes("if(!c||c.nosort||_focDragK) return;"), "a drag in flight is never also a sort");
  assert.ok(css.includes(".foctbl th[data-fock]") && css.includes("touch-action:pan-y"),
    "the header opts out of the long-press callout while the board stays scrollable");
});

test("focus -06: the CLOSE cell stops promising a fill once the session is over", () => {
  const row = { ticker: "NBIS", prevClose: 268.18, h1: { openPx: 268.83 } };
  const CLOSE = Date.UTC(2026, 7, 14, 20, 0);

  // Session still running: the promise is honest, so it stands.
  const live = focColsApi()({ _day: { closedAt: 0, close: Date.now() + 3600e3 } }, () => "", () => null, () => {});
  assert.match(live.focCol("close").td(row), /at close/, "before 16:00 the cell still says the close is ahead");

  // Session over, never filled: a dash that names the silence, not a promise nobody will keep.
  const dead = focColsApi()({ _day: { closedAt: 0, close: CLOSE } }, () => "", () => null, () => {});
  const cell = dead.focCol("close").td(row);
  assert.ok(!/at close/.test(cell), "a finished session never claims a fill is still coming");
  assert.match(cell, /—/, "it is a dash");
  assert.match(cell, /without its close ever being measured/, "…that says exactly which silence this is");
  assert.ok(!/268|241|237/.test(cell), "and still no price stands in for the close that was missed");

  // Filled late: the number, plus the disclosure that the read was taken hours after the fact.
  const late = focColsApi()({ _day: { closedAt: 1, close: CLOSE, closeLate: 312 } }, () => "", () => null, () => {});
  const lc = late.focCol("close").td({ ...row, closePx: 237.60, closeCov: { bars: 390, inWin: 390, slopMin: 1 } });
  assert.match(lc, /237\.60/, "the late-filled close renders normally");
  assert.match(lc, /read 312m after the close/, "…with when it was read stated on the cell");
  assert.match(lc, /-11\.6%/, "and the move off the open is unchanged by the lateness");
});

// A retired FRED series returns 200 with observations that simply STOP — no error to catch. DRTSPM
// did that (SLOOS dropped its prime-mortgage question after 2014Q4) and the panel showed a 2014
// print as current for a decade. The board's contract is "never stale, never faked", so a series
// past any lag its own cadence could explain is dropped with its reason, like a failed fetch.
test("housing tab: a retired series is dropped, not served stale", () => {
  const fs = require("fs"), path = require("path");
  const pol = fs.readFileSync(path.join(__dirname, "..", "src", "poller.js"), "utf8");
  const F = new Function(
    pol.match(/^  const HOUSING_MAX_AGE = \{[^\n]*$/m)[0].trim() + "\n" +
    pol.match(/^  function housingStaleAge\(def, lastD\) \{[\s\S]*?\n  \}/m)[0] + "\n" +
    "return housingStaleAge;")();
  const ago = (d) => new Date(Date.now() - d * 864e5).toISOString().slice(0, 10);

  // the case that shipped: a quarterly series that stopped printing in 2014
  assert.ok(F({ freq: "q" }, "2014-10-01") > 4000, "a decade-dead quarterly series is stale");
  // ...and every cadence catches its own retirement
  for (const [freq, cap] of [["d", 30], ["w", 60], ["m", 180], ["q", 400]]) {
    assert.strictEqual(F({ freq }, ago(Math.floor(cap / 2))), 0, freq + " within its lag is fine");
    assert.ok(F({ freq }, ago(cap + 30)) > 0, freq + " past its lag is stale");
  }
  // normal publication lag must NOT drop a live panel: these are the real cadences on the board
  assert.strictEqual(F({ freq: "q" }, ago(200)), 0, "quarterly published two quarters back is live");
  assert.strictEqual(F({ freq: "m" }, ago(60)), 0, "monthly with a two-month lag is live");
  assert.strictEqual(F({ freq: "w" }, ago(10)), 0, "weekly over a holiday is live");
  assert.strictEqual(F({ freq: undefined }, ago(100)), 0, "unknown cadence falls back to the loosest cap");

  // both paths enforce it — the live fetch and the warm cache a redeploy serves from
  assert.ok(pol.includes("discontinued or dropped by FRED"), "fetch path drops with a reason");
  assert.ok(pol.includes('missing.push(def.sid + " (warm cache: no print in "'), "warm path drops too");
  assert.ok(!pol.includes('sid: "DRTSPM"'), "the retired series is off the board");
  // and the roadmap placeholders are not cards
  assert.ok(!pol.includes("HOUSING_PENDING"), "no pending placeholder payload");
  const app = require("./_client").clientSource();
  assert.ok(!app.includes("hsg-pending") && !app.includes("d.pending||[]"), "no pending cards rendered");
});

test("congress -28: a verb is never read as a ticker", () => {
  // 'congress ocr 20' against a build without the verb answered "no congressional transactions on
  // OCR" — the bare-ticker branch, treating a command as a symbol. A command silently becoming a
  // DIFFERENT command is worse than an error: the answer looked authoritative and was about
  // something else entirely.
  const fs = require("fs"), path = require("path");
  const app = require("./_client").clientSource();
  const i = app.indexOf("const CNG_VERBS=");
  assert.ok(i > 0, "the verb list exists");
  const list = app.slice(i, app.indexOf("]", i));
  for (const v of ["status", "ingest", "backfill", "parse", "ocr", "diag", "requeue", "watch", "watchlist", "feed"])
    assert.ok(list.includes("'" + v + "'"), "verb guarded: " + v);
  // and the guard has to sit BEFORE the ticker branch, or it does nothing at all
  assert.ok(i < app.indexOf("if(/^[A-Za-z.]{1,6}$/.test(sub))"),
    "the verb check precedes the symbol fallback");
  assert.ok(/not available in this build/.test(app),
    "a verb this build lacks says so, rather than answering a different question");
});

test("congress -23: diag takes a member name, and picks the filing that needs explaining", async () => {
  // Production: "Khanna, Rohit · 43 PTR · 38 read but no rows recognized · 5 scanned" — every one of
  // one member's filings failing is a layout the parser does not know, and the useful question is
  // "show me one of HIS". Requiring a doc id put a hunt between the symptom and its cause, and a
  // filing that parsed cleanly teaches nothing about why the others did not.
  const { createPoller } = require("../src/poller");
  const os2 = require("os"), fs = require("fs"), path = require("path");
  const { openStore } = require("../src/store");
  const dir = fs.mkdtempSync(path.join(os2.tmpdir(), "congressC-"));
  const store = openStore(dir);
  const p = createPoller({ dex: "xyz", store, log: () => {}, version: "test", crypto: false, congressGap: 0 });
  const F = (id, member, filed, parsed, nTx) => ({ id, chamber: "H", docId: id.slice(2), yr: 2026,
    member, lname: member.split(",")[0], fname: "", suffix: "", state: "CA", dist: "17", type: "ptr",
    typeRaw: "P", filed, url: "https://x/" + id.slice(2) + ".pdf", amends: null, parsed, nTx });
  store.congressUpsertFilings([
    F("H:41000", "Khanna, Rohit", "2026-08-01", 1, 4),      // parsed fine — nothing to learn here
    F("H:41001", "Khanna, Rohit", "2026-08-20", 1, 0),      // read but empty — THIS is the one
    F("H:41002", "Khanna, Rohit", "2026-08-10", 0, null),   // still queued
    F("H:41003", "Pelosi, Nancy", "2026-08-21", 1, 0),
  ]);
  const pick = store.congressFilerDoc("khanna");
  assert.equal(pick.docId, "41001", "the read-but-empty filing is preferred over one that parsed");
  assert.equal(store.congressFilerDoc("rohit khanna").docId, "41001", "name order does not matter here either");
  assert.equal(store.congressFilerDoc("pelosi").docId, "41003");
  assert.equal(store.congressFilerDoc("nobody"), null, "and an unknown member is null, not a wrong filing");
  // The panel prints the doc id rather than burying it in a tooltip.
  const app = require("./_client").clientSource();
  assert.ok(/congress diag \$\{esc\(x\.emptyDoc\)\}/.test(app), "the command to run is visible, not hovered for");
  fs.rmSync(dir, { recursive: true, force: true });
});

test("congress -21: starred filters in SQL, and an impossible lag is not a fact", async () => {
  // The starred chip filtered the LOADED PAGE in the browser. With 288 parsed filings and 50 rows a
  // page, a starred member's trades sat on page 4 and the chip rendered an empty table — the same
  // shape of bug as the old client-side search, one control along.
  const { createPoller } = require("../src/poller");
  const os2 = require("os"), fs = require("fs"), path = require("path");
  const dir = fs.mkdtempSync(path.join(os2.tmpdir(), "congressA-"));
  const { openStore } = require("../src/store");
  const store = openStore(dir);
  const p = createPoller({ dex: "xyz", store, log: () => {}, version: "test", crypto: false, congressGap: 0 });
  const F = (id, member, filed) => ({ id, chamber: "H", docId: id.slice(2), yr: 2026, member,
    lname: member.split(",")[0], fname: "", suffix: "", state: "CA", dist: "11", type: "ptr",
    typeRaw: "P", filed, url: "https://x/" + id + ".pdf", amends: null, parsed: 0, nTx: null });
  const rows = [];
  for (let i = 0; i < 60; i++) rows.push(F("H:8" + (100 + i), i === 59 ? "Starred, Member" : "Other, Person" + i, "2026-08-20"));
  store.congressUpsertFilings(rows);
  rows.forEach((f) => store.congressSaveTx(f.id, [{ owner: "self", asset: "Apple Inc. (AAPL)",
    ticker: "AAPL", act: "buy", txDate: "2026-08-10", notified: null, loAmt: 1001, hiAmt: 15000,
    tkSrc: "form", atype: "ST" }]));
  p.congressWatchSet("Starred, Member", true);
  // Page one holds none of the starred member's rows, which is exactly when the old filter broke.
  assert.equal(p.congressFeedCount({ starred: 1 }), 1, "starred counts across the whole set");
  assert.equal(p.congressFeed({ starred: 1, limit: 50 }).length, 1, "and returns the row from wherever it sits");
  assert.equal(p.congressFeed({ starred: 1, limit: 50 })[0].member, "Starred, Member");
  assert.equal(p.congressFeedCount({}), 60, "unfiltered still sees everything");

  // A trade dated AFTER the filing that reports it cannot happen; production showed one as "-320d".
  store.congressUpsertFilings([F("H:8999", "Cohen, Steve", "2026-02-09")]);
  store.congressSaveTx("H:8999", [{ owner: "self", asset: "Sony Group Corporation", ticker: "SONY",
    act: "buy", txDate: "2026-12-26", notified: null, loAmt: 1001, hiAmt: 15000, tkSrc: "name", atype: "ST" }]);
  assert.equal(p.congressStatus().parse.badDate, 1, "the impossible row is counted, not rendered as a negative lag");
  const app = require("./_client").clientSource();
  assert.ok(/lag<0/.test(app), "and the panel refuses to print a negative lag as if it were measured");
  fs.rmSync(dir, { recursive: true, force: true });
});

test("congress -12: issuer names resolve to tickers conservatively, and the claim is marked", () => {
  // The filer is not required to write a ticker and most do not — CrowdStrike and Alibaba arrive as
  // names. The 13F lane's map already answers this and is collision-safe BY CONSTRUCTION: a name
  // that could mean two symbols is dropped from the map rather than resolved to a coin flip. What
  // matters here is the descriptive tail: "- Class A Common Stock" is a description of the
  // instrument, not part of the issuer, and it has to come off before the name key sees it.
  const fs = require("fs"), path = require("path"), os2 = require("os");
  const { createPoller } = require("../src/poller");
  const { openStore } = require("../src/store");
  const dir = fs.mkdtempSync(path.join(os2.tmpdir(), "congress4-"));
  const p = createPoller({ dex: "xyz", store: openStore(dir), log: () => {}, version: "test", crypto: false });
  const clean = p.congressAssetName;
  assert.equal(clean("CrowdStrike Holdings, Inc. - Class A Common Stock"), "CrowdStrike Holdings",
    "the instrument description comes off; the corporate suffix is harmless either way since the name key drops it");
  assert.equal(clean("Alibaba Group Holding Limited"), "Alibaba Group Holding Limited");
  assert.equal(clean("Coterra Energy Inc. Common Stock"), "Coterra Energy");
  assert.equal(clean("Apple Inc. (AAPL) [ST]"), "Apple", "the parenthetical and class bracket come off too");
  assert.equal(clean("AB"), null, "too short to be an issuer name is null, not a lookup");
  // The stored row records HOW the ticker was arrived at, so a name-derived match is never
  // presented with the same authority as one the filer wrote.
  const app = require("./_client").clientSource();
  assert.ok(app.includes("cng-tk derived") || app.includes("'cng-tk'"), "the panel marks a derived ticker");
  assert.ok(/tkSrc==='name'/.test(app), "and distinguishes it from the form's own parenthetical");
  const st = fs.readFileSync(path.join(__dirname, "..", "src", "store.js"), "utf8");
  assert.ok(/ALTER TABLE tx ADD COLUMN tkSrc/.test(st), "the distinction is stored, not just rendered");
  fs.rmSync(dir, { recursive: true, force: true });
});

test("congress -32: the issuer name resolves through cleaning, prefix and share class \u2014 never by guessing", () => {
  // "you didn't fully fix naming of stocks" \u2014 Microsoft, Taiwan Semiconductor and Alphabet all
  // rendered a dash. Three DIFFERENT causes, so three different fixes, each pinned here:
  //   1. "- Common" is an instrument description the tail-trimmer did not know (it only knew
  //      "common stock"), so the key stayed "MICROSOFT CORPORATION COMMON" and matched nothing.
  //   2. A filer names an issuer more briefly than the SEC does. "Taiwan Semiconductor" is a
  //      unique PREFIX of the official name, which is a match \u2014 but only while it is unique.
  //   3. A dual-class issuer has one name and two symbols, so the collision-safe map evicts it
  //      entirely. The class letter the filer wrote is the missing bit, and it is supplied from an
  //      exact table that is CONFIRMED against the SEC symbol list before it is believed.
  const fs = require("fs"), path = require("path"), os2 = require("os");
  const { createPoller } = require("../src/poller");
  const { openStore } = require("../src/store");
  const { whaleNameKey } = require("../src/compute");
  const dir = fs.mkdtempSync(path.join(os2.tmpdir(), "congress32-"));
  const p = createPoller({ dex: "xyz", store: openStore(dir), log: () => {}, version: "test", crypto: false });
  // Built exactly as whaleTickerMap builds it: whaleNameKey on both sides, a collision evicts.
  const SEC = [["MSFT", "Microsoft Corporation"], ["AAPL", "Apple Inc."], ["APLE", "Apple Hospitality REIT, Inc."],
    ["TSM", "Taiwan Semiconductor Manufacturing Company Ltd"], ["INTC", "Intel Corporation"],
    ["GOOGL", "Alphabet Inc."], ["GOOG", "Alphabet Inc."], ["CRWD", "CrowdStrike Holdings, Inc."],
    ["V", "Visa Inc."], ["AMD", "Advanced Micro Devices, Inc."]];
  const tmap = new Map(), dead = new Set();
  for (const [sym, name] of SEC) { const k = whaleNameKey(name);
    if (!k || dead.has(k)) continue;
    if (tmap.has(k) && tmap.get(k) !== sym) { tmap.delete(k); dead.add(k); continue; }
    tmap.set(k, sym); }
  const syms = new Set(SEC.map((e) => e[0]));
  const R = (a) => p.congressResolveNow(a, tmap, syms) || null;
  assert.equal(tmap.has("ALPHABET"), false, "the shared name is evicted \u2014 the map itself never guesses");
  assert.equal(R("Microsoft Corporation - Common"), "MSFT", "a bare '- Common' tail comes off");
  assert.equal(R("Intel Corporation - Common Stock"), "INTC");
  assert.equal(R("Taiwan Semiconductor"), "TSM", "a unique prefix of the official name resolves");
  assert.equal(R("CrowdStrike Holdings, Inc. - Class A Common Stock"), "CRWD");
  assert.equal(R("Alphabet Inc. - Class A Common Stock"), "GOOGL", "the class letter separates what the name cannot");
  assert.equal(R("Alphabet Inc. - Class C Capital Stock"), "GOOG");
  assert.equal(R("Alphabet Inc."), null, "no class letter, no claim \u2014 an evicted name stays unresolved");
  assert.equal(R("Berkshire Hathaway Inc. - Class B"), null,
    "a table entry the SEC symbol list does not confirm resolves to nothing, not to a wrong ticker");
  assert.equal(R("Visa Inc. - Class A"), "V", "a single-class issuer is unaffected by the class table");
  // The guard rails the whole lane is built on: no truncation to a single word, ever.
  assert.equal(R("Apple Hospitality REIT, Inc."), "APLE");
  assert.equal(R("Apple Inc."), "AAPL", "and neither swallows the other");
  assert.equal(R("Some Unknown Private LLC"), null);
  // A fix that only reaches documents fetched AFTER the deploy leaves every historical row dashed
  // forever, so the improved resolver can be replayed over stored rows without re-fetching a PDF.
  const st = fs.readFileSync(path.join(__dirname, "..", "src", "store.js"), "utf8");
  assert.ok(/congressUnresolved\(/.test(st) && /congressSetTicker\(/.test(st), "stored rows can be re-resolved");
  assert.ok(/ticker IS NULL OR ticker=''/.test(st), "and only an EMPTY ticker is ever written to");
  const pl = fs.readFileSync(path.join(__dirname, "..", "src", "poller.js"), "utf8");
  assert.ok(/async function congressReticker/.test(pl), "exposed as a run, not a migration");
  const app = require("./_client").clientSource();
  assert.ok(app.includes("'reticker'"), "and reachable from the terminal");
  fs.rmSync(dir, { recursive: true, force: true });
});

test("messages: the client escapes every rendered body, handle and preview", () => {
  // Message bodies are the FIRST attacker-controlled strings this client renders — everything else
  // on the board is a server-computed number. There is no trusted rendering path for a message.
  const fs = require("fs"), path = require("path");
  const app = require("./_client").clientSource();
  const dm = app.slice(app.indexOf("// ===== MESSAGES tab"), app.indexOf("// ===== admin panel: access"));
  assert.ok(dm.length > 4000, "found the messages tab source");
  // Every string a PERSON can author has to go through esc() on the way to innerHTML. The list
  // grew with groups and attachments, and each addition is a fresh way to get this wrong.
  for (const [expr, what] of [
    ["esc\\(m\\.body\\)", "message bodies"],
    ["esc\\(t\\.name\\)", "thread names (a group title is user-authored)"],
    ["esc\\(t\\.preview", "thread previews"],
    ["esc\\(m\\.file\\.name\\)", "attachment filenames"],
    ["esc\\(m\\.threadName\\)", "thread names in search results"],
    ["esc\\(m\\.display\\)", "member display names"],
    ["esc\\(dmState\\.q\\)", "the search query echoed back"],
    ["esc\\(dmSysLine", "system lines, which interpolate a group title"],
  ]) assert.ok(new RegExp(expr).test(dm), what + " must go through esc()");
  assert.ok(!/innerHTML\s*=\s*[^;]*\bm\.body\b(?![^;]*esc)/.test(dm), "no raw body reaches innerHTML");
  // Reaction emoji come back from the server but originate in a request body — escape them too.
  assert.ok(/esc\(e\)/.test(dm), "reaction emoji are escaped");
  const stamp = app.slice(app.indexOf("function dmStamp("), app.indexOf("function fmtPx("));
  assert.ok(/esc\(m\.ref\)/.test(stamp), "the ticker on a stamp is escaped too — it is client-supplied text");
  // A draft must survive a re-render. Renders now arrive unprompted (an incoming message, a
  // reaction, somebody else's typing hint), and a wholesale innerHTML rebuild would eat what the
  // person is mid-way through writing — which is exactly what happened before this existed.
  assert.ok(/function dmCapture\(\)/.test(dm) && /function dmRestore\(/.test(dm), "the composer is captured and restored across renders");
  assert.ok(/const keep=dmCapture\(\)/.test(dm) && /dmRestore\(keep\)/.test(dm), "every render captures before and restores after");
});

test("prefs: the client's decision table — newer stamp wins, a stamp-less non-empty local pushes once", () => {
  const fs = require("fs"), path = require("path");
  const src = require("./_client").clientSource();
  const grab = (name) => { const i = src.indexOf("function " + name + "("); assert.ok(i >= 0, name + " missing");
    let dep = 0; for (let k = src.indexOf("{", i); k < src.length; k++) { if (src[k] === "{") dep++; if (src[k] === "}") { dep--; if (!dep) return src.slice(i, k + 1); } } };
  const prefsDecide = new Function(grab("prefsDecide") + "; return prefsDecide;")();
  assert.equal(prefsDecide({ ts: 10 }, { ts: 20 }, false), "pull", "server newer");
  assert.equal(prefsDecide({ ts: 30 }, { ts: 20 }, false), "push", "local newer (an offline edit)");
  assert.equal(prefsDecide({ ts: 20 }, { ts: 20 }, false), null, "in step");
  assert.equal(prefsDecide(null, { ts: 20 }, true), "pull", "a cold browser adopts the account's copy");
  assert.equal(prefsDecide(null, null, false), "push", "first sign-in: the watchlist built before accounts existed reaches the account");
  assert.equal(prefsDecide(null, null, true), null, "nothing anywhere: nothing to do");
  assert.equal(prefsDecide({ ts: 5 }, null, true), "push", "a stamped local value with no server copy pushes even when empty (an emptied watchlist is a choice)");
  // Wiring: both save paths feed the sync, the stream frame is handled, boot pulls, and the active
  // layout stays out of the payload (the phone runs its own).
  assert.ok(/updateLayoutBtn\(\); prefsMaybePush\('watch'\);/.test(src), "savePrefs pushes the watchlist");
  assert.ok(/store\.set\(LKEY, [^\n]*\); prefsMaybePush\('layouts'\); \}/.test(src), "saveLayouts pushes the list");
  assert.ok(src.includes("if(d&&d.prefs) prefsRemoteFrame(d.prefs);"), "the SSE poke pulls");
  assert.ok(src.includes("prefsPullAll();  // account copy"), "boot pulls");
  assert.ok(src.includes("function prefsLocal(key){ return key==='watch' ? [...state.watch].sort() : { list: state.layouts.list }; }"), "only the list travels — never the active layout");
  assert.ok(src.includes("if(!p||p.from===TAB_ID) return;"), "a tab ignores its own poke");
});
