"use strict";
// poller.js — earnings, macro, 13F/congress/insiders lanes. Split out of test.js (build 2026.09.16-80); order within the file is the original order.
const test = require("node:test");
const assert = require("node:assert");
const { median, C, f4Doc, F4_BUY, F4_PLANSELL, ctxHarness, _mkPtrPdf } = require("./_shared");


test("prime F6: a thin or low-pf live record does NOT earn v2 prime", () => {
  const { createPoller } = require("../src/poller");
  const EPOCH_DAY = Math.floor(Date.UTC(2026, 6, 26) / 86400000);
  function ent(coin, ev, i, realized) {
    const t0 = (EPOCH_DAY + 1) * 86400000 + i * 1000;
    return { key: coin + "|" + ev + "#h" + i, coin, ticker: coin, ev, t0, mark0: 100, dir: 1, sd0: 2,
      status: "resolved", tR: t0 + 5 * 86400000, realized, realizedS: realized, win: realized > 0, winS: realized > 0, psd: "long", pn: 1 };
  }
  // 8 resolutions only (< 12): even with a great profile, too thin to certify.
  const thin = []; for (let i = 0; i < 8; i++) thin.push(ent("SOLP", "reclaim", i, 1));
  let store = { loadAll: () => new Map(), loadRegime: () => [], loadLedger: () => ({ ts: Date.now(), rearm: [], variants: null, open: [], closed: thin }),
    saveLedger: () => {}, insert: () => {}, saveRegime: () => {}, archiveClosed: () => {} };
  let p = createPoller({ dex: "xyz", store, log: () => {}, version: "test", crypto: true });
  p.hydrateLedgerNow(); p.recomputeRecordNow();
  assert.equal(p.primeV2LiveNow("main", "reclaim"), false, "n<12 is too thin for v2 prime");
  // 14 resolutions but symmetric (pf ~1.0): expectancy ~0, fails both avg and pf.
  const flat = [];
  for (let i = 0; i < 7; i++) flat.push(ent("SOLP", "reclaim", i, 1));
  for (let i = 7; i < 14; i++) flat.push(ent("SOLP", "reclaim", i, -1));
  store = { loadAll: () => new Map(), loadRegime: () => [], loadLedger: () => ({ ts: Date.now(), rearm: [], variants: null, open: [], closed: flat }),
    saveLedger: () => {}, insert: () => {}, saveRegime: () => {}, archiveClosed: () => {} };
  p = createPoller({ dex: "xyz", store, log: () => {}, version: "test", crypto: true });
  p.hydrateLedgerNow(); p.recomputeRecordNow();
  assert.equal(p.primeV2LiveNow("main", "reclaim"), false, "a break-even record (pf~1) is not v2-prime");
});

test("earnings: stale-schedule purge drops placeholder-date phantoms, never deletes on absence", async () => {
  const { purgeStalePrints } = require("../src/compute");
  const now = Date.UTC(2026, 6, 16, 16, 0);   // Thu Jul 16 noon ET
  const prints = [
    // the live phantom: IBM persisted at Jul 14 "with actuals" while IBM's real date is Jul 22.
    // Legacy record — no quarter captured — so the 10-day proximity fallback must catch it.
    { coin: "xyz:IBM", t: "IBM", d: "2026-07-14", s: "BMO", eps: 3.05, epsA: 2.93 },
    // real print, reported today-ish, no future row -> untouchable
    { coin: "xyz:NFLX", t: "NFLX", d: "2026-07-15", s: "AMC", eps: 0.8, epsA: 0.8, q: 2, y: 2026 },
    // same-quarter phantom WITH quarter captured -> exact-match drop
    { coin: "xyz:AAA", t: "AAA", d: "2026-07-13", s: "AMC", eps: 1, epsA: 1.2, q: 2, y: 2026 },
    // past print whose ticker has a future row for the NEXT fiscal quarter -> kept (legit history)
    { coin: "xyz:BBB", t: "BBB", d: "2026-07-12", s: "BMO", eps: 2, epsA: 2.1, q: 2, y: 2026 },
    // old print far outside any proximity window -> kept even without quarter info
    { coin: "xyz:IBM", t: "IBM", d: "2026-04-22", s: "AMC", eps: 2.9, epsA: 3.0 },
  ];
  const parsed = [
    { coin: "xyz:IBM", t: "IBM", d: "2026-07-22", s: "AMC", eps: 2.96, epsA: null, q: 2, y: 2026 },
    { coin: "xyz:AAA", t: "AAA", d: "2026-07-24", s: "AMC", eps: 1, epsA: null, q: 2, y: 2026 },
    { coin: "xyz:BBB", t: "BBB", d: "2026-07-20", s: "BMO", eps: 2, epsA: null, q: 3, y: 2026 },
  ];
  const out = purgeStalePrints(prints, parsed, now);
  assert.deepEqual(out.map((p) => p.t + "|" + p.d).sort(),
    ["BBB|2026-07-12", "IBM|2026-04-22", "NFLX|2026-07-15"].sort(),
    "phantoms dropped (legacy proximity + same-quarter), real and historical prints kept");
  // absence is never deletion evidence: a window that simply lacks a ticker changes nothing
  assert.equal(purgeStalePrints(prints, [{ coin: "xyz:ZZZ", t: "ZZZ", d: "2026-07-25", s: "AMC" }], now).length, prints.length,
    "no future row for a ticker -> its past prints are untouched");
  assert.equal(purgeStalePrints(prints, [], now).length, prints.length, "empty window purges nothing");
  // wiring pins: BOTH calendar pulls go through the chunked fetch, the purge runs before merge,
  // and the backfill flag is versioned so truncated-v1 volumes re-pull chunked once.
  const fs = require("fs"), path = require("path");
  const pol = fs.readFileSync(path.join(__dirname, "..", "src", "poller.js"), "utf8");
  assert.ok((pol.match(/await getCalChunked\(/g) || []).length >= 2, "chunked fetch used for live window AND backfill");
  assert.ok(pol.indexOf("purgeStalePrints(earnPrints, parsed") < pol.indexOf("mergeEarnPrints(earnPrints, past.concat"), "purge runs before the merge");
  assert.ok(pol.includes("data.histDone2 === true") && pol.includes("histDone2: earnHistDone"), "backfill flag versioned in hydrate and persist");
});

test("earnings: the history backfill can be FORCED, past the flag that says it already ran", async () => {
  // The automatic walk runs once per volume and flags itself done — which is right, and left no
  // way back. A volume that completed it while the feed was thin, or one that wants a deeper
  // window, could only be rescued by editing earnings.json on disk or shipping a build that
  // versions the flag up. That is the same trap the "2" in histDone2 records.
  const { createPoller } = require("../src/poller");
  const saved = { fetch: global.fetch, tok: process.env.FINNHUB_TOKEN };
  process.env.FINNHUB_TOKEN = "test-token";
  let savedEarn = null;
  const store = { loadAll: () => new Map(), loadRegime: () => [], loadLedger: () => null, saveLedger: () => {},
    insert: () => {}, saveRegime: () => {}, saveEarnings: (d) => { savedEarn = d; }, loadEarnings: () => null };
  const windows = [];
  const day = (n) => new Date(Date.now() - n * 86400000).toISOString().slice(0, 10);
  // One print per chunk request, dated inside the window that chunk covers — enough to prove the
  // walk happened and that the merge deduped it, without pretending to model the feed.
  global.fetch = async (url) => {
    const m = String(url).match(/from=(\d{4}-\d{2}-\d{2})&to=(\d{4}-\d{2}-\d{2})/);
    windows.push(m ? [m[1], m[2]] : null);
    return { ok: true, json: async () => ({ earningsCalendar: [
      { symbol: "INTC", date: m ? m[1] : day(30), hour: "amc", epsEstimate: 1.1, epsActual: 1.2, quarter: 2, year: 2026 }] }) };
  };
  try {
    const p = createPoller({ dex: "xyz", store, log: () => {}, version: "test", crypto: false });
    p.seedRowNow("xyz:INTC", { px: 100, ticker: "INTC", uni: "xyz" });

    const r = await p.earnHistBackfillNow({ days: 90 });
    assert.ok(r.ok, "forced backfill: " + (r.error || "ok"));
    assert.equal(r.days, 90, "the window is the operator's, not the automatic 370");
    assert.ok(r.retrieved > 0, "prints came back from the walk");
    assert.ok(r.printsAfter > r.printsBefore, "and reached the persisted history");
    assert.ok(savedEarn && savedEarn.histDone2 === true, "the walk republishes through the ordinary path, flag and all");

    // The chunk walk, not one long window: the free tier truncates a long pull and serves the FAR
    // end first, which is how a thin history looked like a complete one.
    const histWins = windows.filter(Boolean).filter((w) => w[0] < day(20));
    assert.ok(histWins.length >= 5, "the history window is walked in chunks, not asked for whole: " + histWins.length);
    for (const w of histWins) assert.ok(w[0] <= w[1], "every chunk is a forward range");
    assert.ok(histWins.every((w) => w[0] >= day(91)), "no chunk reaches outside the requested window");

    // FORCED means forced: the flag is now set, and a second call still runs.
    const n = windows.length;
    const r2 = await p.earnHistBackfillNow({ days: 90 });
    assert.ok(r2.ok, "a second run is not refused by the done-flag — that is the entire point");
    assert.ok(windows.length > n, "it really re-walked");
    // ...and re-walking is a no-op on the data, because the merge dedupes on ticker+date.
    assert.equal(r2.printsAfter, r2.printsBefore, "a repeat walk over the same window adds nothing");

    // Honest refusals rather than a silent no-op.
    process.env.FINNHUB_TOKEN = "";
    assert.equal((await p.earnHistBackfillNow({})).error, "FINNHUB_TOKEN not set", "no key is said out loud");
    process.env.FINNHUB_TOKEN = "test-token";
    const p2 = createPoller({ dex: "xyz", store, log: () => {}, version: "test", crypto: false });
    assert.match((await p2.earnHistBackfillNow({})).error, /universe has not reconciled/,
      "an empty roster is a refusal with a reason, not an empty walk reported as success");
  } finally {
    global.fetch = saved.fetch;
    if (saved.tok == null) delete process.env.FINNHUB_TOKEN; else process.env.FINNHUB_TOKEN = saved.tok;
  }
});

test("insiders lane: discovery rides the EDGAR rotation, and the parse reads the real document", async (t) => {
  const fs = require("fs"), os = require("os"), path = require("path");
  const { createPoller } = require("../src/poller");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "insp-"));
  const store = require("../src/store").openStore(dir);
  if (!store.insidersReady()) { fs.rmSync(dir, { recursive: true, force: true }); return t.skip("node:sqlite unavailable"); }
  const hits = [];
  const J = (o) => ({ ok: true, json: async () => o, text: async () => JSON.stringify(o) });
  const X = (s) => ({ ok: true, json: async () => { throw new Error("xml"); }, text: async () => s });
  const extFetch = async (url) => { hits.push(url);
    if (/\/index\.json$/.test(url)) return J({ directory: { item: [{ name: "xslF345X05/wf-form4.xml" }, { name: "wf-form4.xml" }] } });
    if (/wf-form4\.xml$/.test(url)) return X(f4Doc(F4_BUY + F4_PLANSELL));
    return { ok: false, status: 404 };
  };
  const p = createPoller({ dex: "xyz", store, log: () => {}, version: "test", crypto: false, extFetch });

  // Discovery takes the ownership forms out of the SAME atom items the filings lane already
  // parses — no second fetch, no second rate-limit budget. Everything else in that batch is
  // ignored here rather than queued as an insider filing.
  const q = p.insidersQueueNow([
    { id: "sec:0000050863-26-000101", tk: "INTC", form: "4", own: 1, pub: Date.parse("2026-08-26T21:05:00Z"),
      url: "https://www.sec.gov/Archives/edgar/data/50863/000005086326000101/0000050863-26-000101-index.htm" },
    { id: "sec:0000050863-26-000102", tk: "INTC", form: "8-K", mat: 1, pub: 2, url: "u" },
    { id: "sec:0000050863-26-000103", tk: "INTC", form: "SC 13G", own: 1, pub: 3, url: "u" },
  ]);
  assert.deepEqual(q, { seen: 3, queued: 1, added: 1 },
    "of three filings in the batch only the Form 4 is queued — an 8-K is not an insider trade and a 13G is not a transaction — and the step reports what it LOOKED AT as well as what it took");

  const r = await p.insidersParseNow(5);
  assert.ok(r.ok, "parse run: " + (r.error || "ok"));
  assert.equal(r.filings, 1); assert.equal(r.tx, 2, "both Table I rows stored");
  // Two reads per filing, and the SECOND is the raw document the directory listing named.
  assert.equal(hits.length, 2, "one directory listing, one document");
  assert.ok(/\/Archives\/edgar\/data\/50863\/000005086326000101\/index\.json$/.test(hits[0]),
    "the archive path is read from the filing's own url, not guessed from a ticker: " + hits[0]);
  assert.ok(hits[1].endsWith("/wf-form4.xml"), "the raw xml, not EDGAR's stylesheet copy: " + hits[1]);

  const rows = store.insidersFeed({ sort: "value", dir: -1 });
  assert.equal(rows.length, 2);
  assert.equal(rows[0].price, 20, "the price reached the feed unchanged, end to end");
  assert.equal(rows[0].owner, "Tan Lip-Bu");
  assert.equal(rows[0].title, "Chief Executive Officer");
  assert.equal(rows[1].price, null, "and the absent one stayed absent");
  const stat = p.insidersStatus();
  assert.equal(stat.filings.done, 1); assert.equal(stat.filings.queued, 0, "a read filing leaves the queue");

  // A filing whose ISSUER has no trading symbol stores no rows and is never stamped with the
  // ticker of whichever roster name's feed found it. That fallback existed and was a fabrication
  // waiting to happen: a Form 4 reaches this lane through the submissions feed of every CIK
  // associated with it, so a 10% holder's own feed carries filings about OTHER companies.
  store.insidersQueue([{ acc: "0000050863-26-000109", tk: "INTC", form: "4", filed: Date.now(),
    url: "https://www.sec.gov/Archives/edgar/data/50863/000005086326000109/x-index.htm" }]);
  const nonXml = f4Doc(F4_BUY)
    .replace("<issuerTradingSymbol>INTC</issuerTradingSymbol>", "<issuerTradingSymbol>NONE</issuerTradingSymbol>")
    .replace("<issuerName>INTEL CORP</issuerName>", "<issuerName>Blackstone Private Multi-Asset Credit Fund</issuerName>");
  const prev = extFetch;
  const p2 = createPoller({ dex: "xyz", store, log: () => {}, version: "test", crypto: false,
    extFetch: async (u) => (/\/index\.json$/.test(u)
      ? J({ directory: { item: [{ name: "wf-form4.xml" }] } })
      : X(nonXml)) });
  const r2 = await p2.insidersParseNow(5);
  assert.ok(r2.ok && r2.tx === 0, "the filing is read and stores no transactions: " + JSON.stringify(r2));
  assert.equal(store.insidersFeedCount({ ticker: "INTC" }), 2, "INTC still has only its own two rows — nothing was attributed to it");
  assert.equal(store.insidersFeedCount({ q: "Blackstone" }), 0, "and the untickered filing contributes no rows at all");
  const st2 = p2.insidersStatus();
  assert.equal(st2.filings.noSym, 1, "...but it is COUNTED and the reason is kept, so a thin tab can say why");
  assert.equal(st2.filings.queued, 0, "it leaves the queue rather than being retried forever");
  void prev;

  // The scope is injected by the LANE, not asked for by the route: every read is scoped to the
  // covered universe, because a caller that has to remember to pass the roster is one that will
  // eventually forget. Off-board rows stay in the store and are counted, never served.
  store.insidersSave("0000320193-26-000777", { tk: "AAPL", issuer: "APPLE INC", owner: "A Holder", role: "10% owner", nDeriv: 0 },
    [{ ln: 0, kind: "S", code: "P", act: "buy", shares: 1000, price: 200, value: 200000, txDate: "2026-08-20" }]);
  assert.equal(store.insidersFeedCount({}), 3, "the store holds the off-board row");
  p.seedRowNow("xyz:INTC", { px: 20, ticker: "INTC", uni: "xyz" });   // the board now covers exactly one name
  assert.deepEqual(p.insidersFeed({}).map((r) => r.tk).sort(), ["INTC", "INTC"], "reads are scoped without the caller asking");
  assert.equal(p.insidersFeedCount({}), 2, "and the count behind the pager sees the same set");
  assert.equal(p.insidersStatus().scope.offUni, 1, "what the scope hides is stated, not left to be inferred from a short table");
  assert.equal(p.insidersStatus().scope.covered, 1, "...alongside how many names the board covers");

  // A second run has nothing to do — the queue is the work list, not a re-crawl.
  const n = hits.length;
  await p.insidersParseNow(5);
  assert.equal(hits.length, n, "nothing re-fetched");
  fs.rmSync(dir, { recursive: true, force: true });
});

test("insiders backfill: the SEC submissions index reaches the history the atom window cannot", async (t) => {
  // browse-edgar serves a company's 20 most recent filings of ANY type, so a fresh deploy holds
  // whatever happened to be in that window — which is indistinguishable, on the tab, from "this
  // insider has not traded". The backfill walks the submissions index per roster name instead.
  const fs = require("fs"), os = require("os"), path = require("path");
  const { createPoller } = require("../src/poller");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "insb-"));
  const store = require("../src/store").openStore(dir);
  if (!store.insidersReady()) { fs.rmSync(dir, { recursive: true, force: true }); return t.skip("node:sqlite unavailable"); }
  const day = (n) => new Date(Date.now() - n * 86400000).toISOString().slice(0, 10);
  const hits = [];
  const J = (o) => ({ ok: true, json: async () => o, text: async () => JSON.stringify(o) });
  // Column-oriented, exactly as EDGAR ships it: parallel arrays, not a list of objects.
  const recent = {
    form:            ["4",                     "8-K",                  "4/A",                  "4",                    "10-Q"],
    accessionNumber: ["0000050863-26-000101", "0000050863-26-000102", "0000050863-26-000103", "0000050863-25-000900", "0000050863-26-000104"],
    filingDate:      [day(10),                 day(11),                day(30),                day(400),               day(12)],
  };
  // The older-history shard: same columns, at the TOP level rather than under `.recent`.
  const shard = { form: ["4"], accessionNumber: ["0000050863-25-000500"], filingDate: [day(200)] };
  const extFetch = async (url) => { hits.push(url);
    if (url.includes("company_tickers.json")) return J({ 0: { cik_str: 50863, ticker: "INTC", title: "Intel Corp" } });
    if (url.includes("company_tickers_mf.json")) return J({ fields: ["cik", "seriesId", "classId", "symbol"], data: [] });
    if (/submissions\/CIK0000050863\.json$/.test(url)) return J({ filings: { recent,
      files: [{ name: "CIK0000050863-submissions-001.json", filingFrom: day(500), filingTo: day(150) }] } });
    if (/submissions\/CIK0000050863-submissions-001\.json$/.test(url)) return J(shard);
    return { ok: false, status: 404 };
  };
  const p = createPoller({ dex: "xyz", store, log: () => {}, version: "test", crypto: false, extFetch });
  // Two roster names: one with a US filer, one without — a foreign listing has no Form 4s to find.
  p.seedRowNow("xyz:INTC", { px: 20, ticker: "INTC", uni: "xyz" });
  p.seedRowNow("xyz:ASML", { px: 900, ticker: "ASML", uni: "xyz" });

  const r = await p.insidersBackfillNow({ days: 365 });
  assert.ok(r.ok, "backfill: " + (r.error || "ok"));
  assert.equal(r.walked, 2, "every roster name is walked");
  assert.equal(r.noCik, 1, "a name with no US filer is COUNTED, not treated as a failure — the coverage number describes the lane, not the roster");
  // 4 and 4/A inside the window, plus the one from the older shard. The 8-K and 10-Q are not
  // insider transactions; the 400-day-old Form 4 is outside the requested window.
  assert.equal(r.added, 3, "only ownership forms inside the window are queued: " + JSON.stringify(r));
  const queued = store.insidersPending(50).map((x) => x.acc).sort();
  assert.deepEqual(queued, ["0000050863-25-000500", "0000050863-26-000101", "0000050863-26-000103"],
    "the amendment and the shard's older filing are both in, the 8-K/10-Q and the out-of-window 4 are not");
  assert.ok(hits.some((u) => /submissions-001\.json$/.test(u)),
    "the older shard is followed — `recent` holds the last ~1000 filings of every type, which for a busy issuer is less than a year");

  // The queued rows must be shaped so the ORDINARY parse path can read them: one code path from
  // accession to row, so a backfilled row cannot differ from a live one.
  const one = store.insidersPending(50).find((x) => x.acc === "0000050863-26-000101");
  assert.ok(/\/Archives\/edgar\/data\/50863\/000005086326000101\/.*-index\.htm$/.test(one.url),
    "the archive path is synthesized in the same shape the atom link has: " + one.url);
  assert.equal(one.tk, "INTC");

  // Idempotent, and it says so: re-running queues nothing new rather than duplicating a year.
  const again = await p.insidersBackfillNow({ days: 365 });
  assert.equal(again.added, 0, "a second walk adds nothing — the queue upsert is idempotent against accessions it holds");
  assert.ok(again.queued >= 3, "...though it still SAW them, which is a different number and is reported separately");

  // The flag that stops it running on every boot, and the status the tab reads to disclose depth.
  assert.ok(p.insidersStatus().backfill.done, "the walk is flagged done on this volume");
  assert.equal(p.insidersStatus().backfill.busy, 0);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("filing alerts: material forms only, backlog seeded silently, stale filings dropped", () => {
  const p = ctxHarness();
  p.seedRowNow("AAA", { ticker: "AAA", px: 10, uni: "xyz" });
  const now = Date.now();
  const item = (id, form, pub) => ({ id: "sec:" + id, tk: "AAA", form, h: form + " body", url: "https://sec.gov/" + id, pub: pub == null ? now - 60e3 : pub });
  const filings = () => p.getTriggers(0, null, true).events.filter((e) => e.kind === "filing");

  // Before priming, the 7-day backlog every name carries is seeded, not announced.
  p.filingScanNow([item(1, "8-K")]);
  assert.equal(filings().length, 0, "the first EDGAR pass after boot must not arrive as a wall of notifications");

  p.filingPrimeNow();
  p.filingScanNow([item(1, "8-K")]);
  assert.equal(filings().length, 0, "…and an id already seen during seeding stays seen");

  p.filingScanNow([item(2, "8-K")]);
  assert.equal(filings().length, 1, "a genuinely new material filing fires");
  assert.equal(filings()[0].form, "8-K");
  assert.equal(filings()[0].coin, "AAA", "resolved to the market so the deep link works");

  // Ownership forms are routine insider flow, several a day per active name — excluded on
  // frequency grounds, not because they are uninteresting.
  p.filingScanNow([item(3, "4"), item(4, "SC 13G"), item(5, "144")]);
  assert.equal(filings().length, 1, "ownership forms never push");
  // …nor do the material-but-rarely-urgent ones the news tab already carries.
  p.filingScanNow([item(6, "DEF 14A"), item(7, "S-3")]);
  assert.equal(filings().length, 1, "proxies and shelf registrations stay in the news tab");

  // A filing discovered long after it was published is history, not news.
  p.filingScanNow([item(8, "8-K", now - 20 * 3600e3)]);
  assert.equal(filings().length, 1, "a stale filing found by a slow rotation must not fire");
  p.filingScanNow([item(9, "10-Q")]);
  assert.equal(filings().length, 2);
});

test("macro lane wiring: the server decides which tape headline is which macro name's news", () => {
  const { createPoller } = require("../src/poller");
  const store = { loadAll: () => new Map(), loadRegime: () => [], loadLedger: () => null,
    saveLedger: () => {}, insert: () => {}, saveRegime: () => {}, saveNews: () => {}, loadNews: () => null };
  const p = createPoller({ dex: "xyz", store, log: () => {}, version: "test" });
  const now = Date.now();
  p.seedRowNow("xyz:EWZ", { ticker: "EWZ", px: 36, uni: "xyz", vol: 1e6 });
  p.seedRowNow("xyz:JPY", { ticker: "JPY", px: 0.0067, uni: "xyz", vol: 1e6 });
  p.seedRowNow("xyz:SP500", { ticker: "SP500", px: 6100, uni: "xyz", vol: 1e6 });
  p.seedRowNow("xyz:NVDA", { ticker: "NVDA", px: 180, uni: "xyz", vol: 1e6 });
  const d = p.newsIngestNow([
    { id: 1, tk: null, h: "Petrobras lifts diesel prices as Brazil fuel policy shifts", src: "Reuters", url: "u", pub: now - 1e6 },
    { id: 2, tk: null, h: "Bank of Japan holds, yen slips past 160", src: "Reuters", url: "u", pub: now - 2e6 },
    { id: 3, tk: null, h: "Seagate 4Q revenue beats estimates", src: "trad_fin", url: "u", pub: now - 3e6 },
    { id: 4, tk: "NVDA", h: "Nvidia unveils next-gen accelerator", src: "Reuters", url: "u", pub: now - 4e6 },
  ]);
  const by = new Map(d.items.map((a) => [a.id, a]));
  const tags = (id) => by.get(id).mtk || [];
  // The exact bug from the screenshots: one macro headline reaching two unrelated macro drawers.
  assert.ok(tags(1).includes("EWZ"), "the Brazil headline is EWZ's news");
  assert.ok(!tags(1).includes("JPY"), "…and is NOT the yen's news — this is the bug, pinned");
  assert.ok(tags(2).includes("JPY") && !tags(2).includes("EWZ"), "and symmetrically the other way");
  // A generic earnings print belongs to neither scoped name, but IS the broad tape's news.
  assert.ok(!tags(3).includes("EWZ") && !tags(3).includes("JPY"),
    "an unrelated print reaches no scoped drawer — the filler the old fallback shipped");
  for (const id of [1, 2, 3]) assert.ok(tags(id).includes("SP500"), "broad-lane names take the whole tape by declaration");
  // Verified company items keep their own name and never enter a macro lane.
  assert.equal(by.get(4).tk, "NVDA");
  assert.equal(by.get(4).mtk, undefined, "a verified company headline is never also macro-lane news");
  // A name outside the live universe can never be stamped, however well its topics match.
  for (const a of d.items) for (const T of (a.mtk || []))
    assert.ok(["EWZ", "JPY", "SP500"].includes(T), `stamped a ticker not in the roster: ${T}`);
  // Row payload carries the label and the lane, so the client re-derives neither.
  const snap = p.buildSnapshotNow() || p.getSnapshot();
  const row = (t) => snap.markets.find((m) => m.ticker === t);
  assert.equal(row("EWZ").nm, "iShares MSCI Brazil ETF");
  assert.equal(row("EWZ").mlane.label, "Brazil");
  assert.equal(row("SP500").mlane.broad, true);
  assert.equal(row("NVDA").nm, "NVIDIA Corp.");
  assert.equal(row("NVDA").mlane, undefined, "an equity ships no lane — the drawer then says 'no headlines'");
});

test("macroScan: cold boot seeds silently, then each leg fires exactly once", () => {
  const { etDayStr } = require("../src/compute");
  const p = ctxHarness();
  const DAYMS = 24 * 3600e3;
  const now = Date.now();
  const tomorrow = etDayStr(now + DAYMS);
  const macro = () => p.getTriggers(0, null, true).events.filter((e) => e.kind === "macro");

  // A calendar that is already populated at boot is the normal case — the warm cache is on disk.
  // Announcing it would mean every deploy re-detonating tomorrow's CPI.
  p.macroSeedNow([{ k: "CPI", label: "CPI", d: tomorrow, tEt: "08:30", prior: { yoy: 2.9, m: "2026-06" } }]);
  p.macroScanNow();
  assert.equal(macro().length, 0, "the first pass after a cold boot seeds, never announces");

  // A genuinely new event arriving after priming fires its day-ahead leg.
  p.macroSeedNow([
    { k: "CPI", label: "CPI", d: tomorrow, tEt: "08:30", prior: { yoy: 2.9, m: "2026-06" } },
    { k: "NFP", label: "Nonfarm payrolls", d: tomorrow, tEt: "08:30", prior: { chgK: 147, m: "2026-06" } },
  ]);
  p.macroScanNow();
  assert.equal(macro().length, 1, "one new calendar row, one alert");
  assert.equal(macro()[0].sub, "ahead");
  assert.equal(macro()[0].k, "NFP");
  assert.equal(macro()[0].coin, undefined, "macro carries no ticker — scoping it to one would misdescribe the event");

  p.macroScanNow(); p.macroScanNow();
  assert.equal(macro().length, 1, "re-scanning the same calendar is silent — the leg is keyed k|date|sub");

  // The result leg waits for the NUMBER, not the clock: the same row with an actual attached is a
  // new leg, and only then.
  p.macroSeedNow([
    { k: "CPI", label: "CPI", d: tomorrow, tEt: "08:30", prior: { yoy: 2.9, m: "2026-06" } },
    { k: "NFP", label: "Nonfarm payrolls", d: tomorrow, tEt: "08:30", prior: { chgK: 147, m: "2026-06" },
      actual: { chgK: 88, unemp: 4.2, m: "2026-07" } },
  ]);
  p.macroScanNow();
  const legs = macro();
  assert.equal(legs.length, 2);
  assert.equal(legs[1].sub, "result");
  assert.equal(legs[1].actual.chgK, 88, "the structured stat rides the event — the formatter owns the wording, not the poller");
  p.macroScanNow();
  assert.equal(macro().length, 2, "a result announces once");
});

test("macro + earnings-preview episode state survives a redeploy", () => {
  const fs = require("fs"), path = require("path");
  const pol = fs.readFileSync(path.join(__dirname, "..", "src", "poller.js"), "utf8");
  // This app redeploys once per pushed FILE. Un-persisted seed state is what made the trend class
  // theoretical for eight builds; the same trap applies verbatim to a CPI print and to a
  // once-a-day calendar message.
  assert.ok(/macro: \[\.\.\.macroAlerted\.entries\(\)\]/.test(pol), "the macro seed set is persisted");
  assert.ok(/earnPrevDay: earnPrevDay \|\| null/.test(pol), "the preview's day stamp is persisted");
  assert.ok(/loadMap\(ep\.macro, macroAlerted\)/.test(pol), "…and restored");
  assert.ok(/if \(typeof ep\.earnPrevDay === "string"\) earnPrevDay = ep\.earnPrevDay/.test(pol));
  assert.ok(/if \(macroAlerted\.size\) macroPrimed = true/.test(pol),
    "restored state IS the seed — re-running the silent pass would eat the first real transition");
  assert.ok(/setInterval\(safeTick\(macroScan, "macroScan"\), 5 \* 60 \* 1000\)/.test(pol),
    "5-minute cadence: the imminent leg is a 60-minute window against an 08:30/14:00 ET clock");
  assert.ok(/setInterval\(safeTick\(earnPreviewScan, "earnPreviewScan"\), 10 \* 60 \* 1000\)/.test(pol));
});

test("earnings preview: one batched message a day, silent when the calendar is empty", () => {
  const { etDayStr } = require("../src/compute");
  const p = ctxHarness();
  const DAYMS = 24 * 3600e3;
  const now = Date.now();
  const tomorrow = etDayStr(now + DAYMS), today = etDayStr(now);
  const prev = () => p.getTriggers(0, null, true).events.filter((e) => e.kind === "earnings" && e.sub === "preview");

  p.seedRowNow("AAA", { ticker: "AAA", px: 10, uni: "xyz" });
  p.seedRowNow("BBB", { ticker: "BBB", px: 10, uni: "xyz" });

  // Nothing scheduled anywhere: the daily gate still closes, but no message is sent. An empty
  // calendar is silence — a "0 reports tomorrow" DM every evening is how a channel gets muted.
  p.earnPrevResetNow();
  p.earnRebuildNow([]);
  assert.equal(p.earnPreviewNow(), 0);
  assert.equal(prev().length, 0);

  p.earnPrevResetNow();
  p.earnRebuildNow([
    { coin: "xyz:AAA", t: "AAA", d: tomorrow, s: "AMC", eps: 1.42, epsA: null },
    { coin: "xyz:BBB", t: "BBB", d: today, s: "BMO", eps: 0.5, epsA: 0.61 },
  ]);
  const fired = p.earnPreviewNow();
  // The 17:00 ET gate is real, so this only emits in the evening window; both branches are
  // asserted rather than one being assumed.
  if (fired) {
    const e = prev()[0];
    assert.equal(e.tomorrow.length, 1);
    assert.equal(e.tomorrow[0].t, "AAA");
    assert.equal(e.reported.length, 1);
    assert.equal(e.reported[0].epsA, 0.61);
    assert.equal(e.coin, undefined, "the calendar is roster-wide — it belongs to no single name");
    assert.equal(p.earnPreviewNow(), 0, "and it is once per ET day, not once per scan");
    const C = require("../src/compute");
    const msg = C.pushFmt(e, {});
    assert.ok(/Earnings calendar/.test(msg) && /AAA/.test(msg) && /BBB/.test(msg));
    assert.ok(/beat/.test(msg), "a reported print carries its verdict");
    assert.ok(/not a consensus/.test(msg), "same honesty rule as the macro lane");
  } else {
    assert.equal(prev().length, 0, "before 17:00 ET the preview holds — and holds silently");
  }
});

test("the widened earnings class did not weaken the claim-scoped leg", () => {
  const fs = require("fs"), path = require("path");
  const pol = fs.readFileSync(path.join(__dirname, "..", "src", "poller.js"), "utf8");
  // The scoping was never the bug. If a later slice ever loosens THIS gate, an 84-name roster in
  // season becomes a dozen interruptions a day and the class gets muted — which is the failure
  // the batched preview exists to avoid having to risk.
  const scan = pol.slice(pol.indexOf("function earnScan()"), pol.indexOf("function earnPreviewScan()"));
  // 2026.07.29-03 folded every copy of this gate into the shared isOpenAnnounced predicate; the
  // exclusion is unchanged, and now cannot drift per consumer.
  assert.ok(/if \(!isOpenAnnounced\(e\)\) continue;/.test(scan), "shadows and unannounced claims stay excluded");
  assert.ok(/prox\.diff > 1/.test(scan), "today or tomorrow only");
  const C = require("../src/compute");
  const urg = C.pushFmt({ kind: "earnings", coin: "X", t: "X", when: "tomorrow", session: "amc", claim: "breakout" }, {});
  assert.ok(/reports tomorrow/.test(urg) && !/claim/i.test(urg),
    "the urgent leg still fires from the preview branch, and never renders positioning");
});

test("whale lane end-to-end: add by CIK, poll ingests real filings through the real path, delta + tickers + unseen + announce gating + season", async () => {
  const { createPoller } = require("../src/poller");
  let saved = null;
  const store = { loadAll: () => new Map(), loadRegime: () => [], loadLedger: () => null,
    saveLedger: () => {}, insert: () => {}, saveRegime: () => {}, saveNews: () => {}, loadNews: () => null,
    saveWhale: (d) => { saved = d; }, loadWhale: () => null };
  const J = (o) => ({ ok: true, json: async () => o, text: async () => JSON.stringify(o) });
  const X = (t) => ({ ok: true, json: async () => { throw new Error("xml"); }, text: async () => t });
  const NOW = Date.UTC(2026, 7, 16, 12, 0, 0);   // in Q2's grace window: season quarter is Q2 2026
  const infoQ2 = `<x><infoTable><nameOfIssuer>APPLE INC</nameOfIssuer><cusip>037833100</cusip><value>1500</value><shrsOrPrnAmt><sshPrnamt>15</sshPrnamt><sshPrnamtType>SH</sshPrnamtType></shrsOrPrnAmt></infoTable>` +
    `<infoTable><nameOfIssuer>UNITEDHEALTH GROUP INC</nameOfIssuer><cusip>91324P102</cusip><value>500</value><shrsOrPrnAmt><sshPrnamt>5</sshPrnamt><sshPrnamtType>SH</sshPrnamtType></shrsOrPrnAmt></infoTable></x>`;
  const infoQ1 = `<x><infoTable><nameOfIssuer>APPLE INC</nameOfIssuer><cusip>037833100</cusip><value>2000</value><shrsOrPrnAmt><sshPrnamt>20</sshPrnamt><sshPrnamtType>SH</sshPrnamtType></shrsOrPrnAmt></infoTable>` +
    `<infoTable><nameOfIssuer>ULTA BEAUTY INC</nameOfIssuer><cusip>90384S303</cusip><value>300</value><shrsOrPrnAmt><sshPrnamt>3</sshPrnamt><sshPrnamtType>SH</sshPrnamtType></shrsOrPrnAmt></infoTable></x>`;
  const hits = [];
  const extFetch = async (url) => { hits.push(url);
    if (url.includes("company_tickers.json")) return J({ 0: { cik_str: 111, ticker: "AAPL", title: "Apple Inc." }, 1: { cik_str: 112, ticker: "UNH", title: "UnitedHealth Group Incorporated" } });
    if (url.includes("company_tickers_mf.json")) return J({ fields: ["cik"], data: [] });
    if (url.includes("submissions/CIK0001067983")) return J({ name: "BERKSHIRE HATHAWAY INC", filings: { recent: {
      form: ["13F-HR", "13F-HR", "8-K"], accessionNumber: ["0001-26-000002", "0001-26-000001", "0001-26-000003"],
      filingDate: ["2026-08-14", "2026-05-15", "2026-08-01"], reportDate: ["2026-06-30", "2026-03-31", ""] } } });
    if (url.includes("/000126000002/index.json")) return J({ directory: { item: [
      { name: "primary_doc.xml", size: 900 }, { name: "form13fInfoTable.xml", size: 5000 }, { name: "cover.htm", size: 100 }] } });
    if (url.includes("/000126000002/form13fInfoTable.xml")) return X(infoQ2);
    if (url.includes("/000126000001/index.json")) return J({ directory: { item: [
      { name: "primary_doc.xml", size: 900 }, { name: "infotable.xml", size: 4000 }] } });
    if (url.includes("/000126000001/infotable.xml")) return X(infoQ1);
    return { ok: false, status: 404 };
  };
  const p = createPoller({ dex: "xyz", store, log: () => {}, version: "test", crypto: false, extFetch });
  p.hydrateWhaleNow();   // empty store hydrate primes announcements (nothing to blast)
  const add = p.whaleAdd(1067983, "Berkshire Hathaway Inc");
  assert.ok(add.ok, "add by CIK: " + (add.error || ""));
  assert.equal(add.fund.key, "BERKSHIRE", "key derives from the normalized name");
  await p.whaleTickNow(NOW);
  // Ingested both quarters through the real path: filing index -> largest non-primary XML -> parse.
  const w = p.getWhale();
  assert.equal(w.watch.length, 1);
  const row = w.watch[0];
  assert.equal(row.q, "Q2 2026"); assert.equal(row.total, 2000); assert.equal(row.n, 2);
  assert.ok(Math.abs(row.dPct - (2000 / 2300 - 1) * 100) < 1e-9, "book QoQ vs the prior filed quarter");
  assert.equal(row.unseen, 0, "-03 rule: a fund's FIRST ingest is backfill — silent even when the filing is fresh; announce needs a prior book (staged in the pull test)");
  assert.equal(p.getWhale(NOW).window.cur.q, "Q2 2026", "the filing calendar is read at the FROZEN instant — this assertion must not depend on the day the suite runs");
  const f = await p.getWhaleFund("berkshire");
  assert.ok(f.ok, "fund card: " + (f.error || ""));
  assert.equal(f.hasPrev, true);
  assert.equal(f.lanes.opened.length, 1, "UNH opened");
  assert.equal(f.lanes.opened[0].tk, "UNH", "conservative name match tagged the ticker");
  assert.equal(f.lanes.exited.length, 1, "ULTA exited");
  const aapl = f.positions.find((x) => x.cusip === "037833100");
  assert.equal(aapl.tk, "AAPL"); assert.equal(aapl.d.cls, "trim"); assert.equal(aapl.d.dSh, -5);
  // Season: sole watched fund filed -> builds for Q2.
  p.whaleSeasonNow(NOW);
  const s = await p.getWhaleSeasonQ("Q2 2026");
  assert.ok(s.ok, "season built: " + (s.error || ""));
  assert.equal(s.filedN, 1); assert.equal(s.agg.nFunds, 1);
  assert.ok(s.agg.opens.some((r) => r.tk === "UNH"), "season opens lane carries the matched ticker");
  // Unseen clears via seen; persistence saw every write.
  p.whaleSeen("BERKSHIRE");
  assert.equal(p.getWhale().watch[0].unseen, 0, "opening the fund clears the badge");
  assert.ok(saved && saved.watch.length === 1 && saved.filings["1067983"], "state persisted through the store");
  // Re-poll inside the cadence gate: zero new EDGAR requests.
  const n0 = hits.length;
  await p.whaleTickNow(NOW + 60 * 1000);
  assert.equal(hits.length, n0, "per-fund cadence gate holds — a tick a minute later fetches nothing");
  // rm/mute round-trip.
  assert.ok(p.whaleMute("BERKSHIRE", true).ok);
  assert.equal(p.getWhale().watch[0].notify, 0);
  assert.ok(p.whaleRm("BERKSHIRE").ok);
  assert.equal(p.getWhale().watch.length, 0, "removed — history kept in filings, row gone");
});

test("whale search -02: layered lanes — prefix resolves via autocomplete, company-DB hits verify + rank first, FTS is last resort, outage degrades honestly", async () => {
  const { createPoller } = require("../src/poller");
  const store = { loadAll: () => new Map(), loadRegime: () => [], loadLedger: () => null,
    saveLedger: () => {}, insert: () => {}, saveRegime: () => {}, saveNews: () => {}, loadNews: () => null,
    saveWhale: () => {}, loadWhale: () => null };
  const J = (o) => ({ ok: true, json: async () => o, text: async () => JSON.stringify(o) });
  const X = (t) => ({ ok: true, json: async () => { throw new Error("xml"); }, text: async () => t });
  const MISS = { ok: false, status: 404 };
  // Switchable per-lane behavior so one poller instance exercises every degradation path.
  const lanes = { atom: null, keys: null, fts: null };
  const hits = [];
  const extFetch = async (url) => { hits.push(url);
    if (url.includes("browse-edgar")) return lanes.atom || MISS;
    if (url.includes("keysTyped=")) return lanes.keys || MISS;
    if (url.includes("search-index?q=")) return lanes.fts || MISS;
    return MISS;
  };
  const p = createPoller({ dex: "xyz", store, log: () => {}, version: "test", crypto: false, extFetch });
  const atomList = X(`<feed><entry><company-info><cik>0001536411</cik><conformed-name>DUQUESNE FAMILY OFFICE LLC</conformed-name></company-info></entry>` +
    `<entry><company-info><cik>0009999901</cik><conformed-name>DUQUESNE CAPITAL MGMT LLC</conformed-name></company-info></entry></feed>`);
  const keysHits = J({ hits: { hits: [
    { _id: "0001536411", _source: { entity: "DUQUESNE FAMILY OFFICE LLC (CIK 0001536411)" } },   // dup of a verified hit — must dedupe
    { _id: "0007777777", _source: { entity: "DUQUESNE LIGHT HOLDINGS INC" } } ] } });            // unverified extra — ranks after
  // 1) Both prefix lanes up: "Duq" resolves; verified company-DB hits rank ahead of autocomplete;
  //    the shared CIK appears exactly once; FTS is never even called.
  lanes.atom = atomList; lanes.keys = keysHits; lanes.fts = J({ hits: { hits: [] } });
  let r = await p.whaleSearch("Duq");
  assert.ok(r.ok, "prefix search resolves: " + (r.error || ""));
  assert.deepEqual(r.candidates.map((c) => c.cik), [1536411, 9999901, 7777777], "verified-first order, deduped on CIK");
  assert.equal(r.candidates[0].name, "DUQUESNE FAMILY OFFICE LLC", "parenthetical CIK stripped, entities decoded");
  assert.ok(!hits.some((u) => u.includes("search-index?q=")), "FTS untouched while the prefix lanes deliver");
  // 2) Company DB down: autocomplete alone still answers — a prefix miss in one lane is not a miss.
  lanes.atom = MISS; hits.length = 0;
  r = await p.whaleSearch("Duquesne Family Office");
  assert.ok(r.ok && r.candidates.some((c) => c.cik === 1536411), "autocomplete lane carries the load alone");
  // 3) Both prefix lanes down: the old FTS phrase lane is the net, not the door.
  lanes.keys = MISS; lanes.fts = J({ hits: { hits: [{ _source: { cik: [1536411], display_names: ["DUQUESNE FAMILY OFFICE LLC (CIK 0001536411)"] } }] } });
  r = await p.whaleSearch("DUQUESNE FAMILY OFFICE LLC");
  assert.ok(r.ok && r.candidates[0].cik === 1536411, "FTS fallback still lands the fund");
  // 4) Everything down: honest error that names the raw-CIK escape hatch.
  lanes.fts = MISS;
  r = await p.whaleSearch("Duq");
  assert.ok(!r.ok && /raw CIK/.test(r.error), "total outage degrades to 'paste the CIK', never a silent empty list");
  // 5) The single-company atom shape (exact name match returns a filing FEED, not a list) parses too.
  lanes.atom = X(`<feed><title>DUQUESNE FAMILY OFFICE LLC filings</title><company-info><cik>1536411</cik><conformed-name>DUQUESNE FAMILY OFFICE &amp; CO LLC</conformed-name><addresses/></company-info><entry><title>13F-HR</title></entry></feed>`);
  r = await p.whaleSearch("Duquesne Family Office LLC");
  assert.ok(r.ok && r.candidates[0].cik === 1536411, "single-match feed shape parses");
  assert.equal(r.candidates[0].name, "DUQUESNE FAMILY OFFICE & CO LLC", "XML entities decoded in the name");
});

test("whale cadence -05: fast polling runs through the post-deadline grace window; only pre-quarter-end 'upcoming' is slow", async () => {
  const { createPoller } = require("../src/poller");
  const store = { loadAll: () => new Map(), loadRegime: () => [], loadLedger: () => null,
    saveLedger: () => {}, insert: () => {}, saveRegime: () => {}, saveNews: () => {}, loadNews: () => null,
    saveWhale: () => {}, loadWhale: () => null };
  const J = (o) => ({ ok: true, json: async () => o, text: async () => JSON.stringify(o) });
  const hits = [];
  // Submissions with no 13F rows: every poll is exactly one fetch and ingests nothing — the test
  // measures the CADENCE, not the ingest path (which has its own coverage).
  const extFetch = async (url) => { hits.push(url);
    if (url.includes("company_tickers")) return J({});
    if (url.includes("submissions/")) return J({ name: "QUIET LP", filings: { recent: { form: [], accessionNumber: [], filingDate: [], reportDate: [] } } });
    return { ok: false, status: 404, error: "404" };
  };
  const p = createPoller({ dex: "xyz", store, log: () => {}, version: "test", crypto: false, extFetch });
  p.hydrateWhaleNow();
  p.whaleAdd(9001, "Quiet LP");
  const subHits = () => hits.filter((u) => u.includes("submissions/")).length;
  const C = require("../src/compute");
  // GRACE: Aug 16 2026 — Q2 deadline (Fri Aug 14) passed, season not yet rolled. The exact
  // Pershing scenario: a deadline-evening filing must be found in minutes, not tomorrow.
  const GRACE = Date.UTC(2026, 7, 16, 12, 0, 0);
  assert.equal(C.whaleWindow(GRACE).state, "closed", "fixture clock sits inside the grace window");
  await p.whaleTickNow(GRACE);
  const n1 = subHits();
  await p.whaleTickNow(GRACE + 31 * 60 * 1000);   // +31min: past the 30min fast gate
  assert.equal(subHits(), n1 + 1, "grace window polls at the FAST cadence — the -05 fix; the old state==='open' gate would have waited 24h here");
  await p.whaleTickNow(GRACE + 45 * 60 * 1000);   // +45min: inside the fast gate since the last poll
  assert.equal(subHits(), n1 + 1, "and the fast gate still gates — no hammering");
  // UPCOMING: Aug 20 2026 — grace over, season rolled to Q3, quarter still in progress. Only a
  // stray amendment can appear; a daily glance is the whole job.
  const UP = Date.UTC(2026, 7, 20, 12, 0, 0);
  assert.equal(C.whaleWindow(UP).state, "upcoming", "fixture clock sits in the between-seasons stretch");
  await p.whaleTickNow(UP);                       // 4d past the last poll — this one legitimately fetches and anchors the cadence
  const n2 = subHits();
  await p.whaleTickNow(UP + 31 * 60 * 1000);      // fast-gate width past the anchor — must NOT fetch out of season
  assert.equal(subHits(), n2, "upcoming stays on the slow cadence");
  await p.whaleTickNow(UP + 26 * 3600e3);         // past the 24h slow gate
  assert.equal(subHits(), n2 + 1, "and the daily glance still happens");
  // The gate line itself, pinned: slow belongs to 'upcoming' alone.
  const pol = require("fs").readFileSync(require("path").join(__dirname, "..", "src", "poller.js"), "utf8");
  assert.ok(pol.includes('win.state === "upcoming" ? WHALE_OFF_WINDOW_MS : WHALE_IN_WINDOW_MS'), "cadence keys on upcoming-only — open AND grace both poll fast");
});

test("whale roster -01 (2026.08.18-01): a watchlist edit reopens the season build; the crowding grid rides the build's own roster", async () => {
  const C = require("../src/compute");
  // --- pure leg: the aggregate accounts for who it consumed, and the count derives from that list.
  const P = (cusip, value, shares) => ({ cusip, put: null, name: cusip + " CORP", cls: null, value, shares, pct: null });
  const sPure = C.whaleSeason([
    { key: "A", cik: 11, cur: { total: 100, n: 1, positions: [P("X1", 100, 10)] }, prev: { total: 80, n: 1, positions: [P("X1", 80, 8)] } },
    { key: "B", cik: 22, cur: { total: 50, n: 1, positions: [P("X1", 50, 5)] }, prev: null },
    { key: "C", cik: 33, cur: null, prev: null },   // watched, hasn't filed — never part of the roster
  ]);
  assert.deepEqual(sPure.roster, [{ key: "A", cik: 11 }, { key: "B", cik: 22 }],
    "the roster is the FILED funds, carrying CIK — identity, not the de-collidable label");
  assert.equal(sPure.nFunds, sPure.roster.length, "nFunds derives from the roster; two producers of one count is the bug this build removes");

  // --- end-to-end leg: two filers, one removed, through the real ingest + build path.
  const { createPoller } = require("../src/poller");
  const store = { loadAll: () => new Map(), loadRegime: () => [], loadLedger: () => null,
    saveLedger: () => {}, insert: () => {}, saveRegime: () => {}, saveNews: () => {}, loadNews: () => null,
    saveWhale: () => {}, loadWhale: () => null };
  const J = (o) => ({ ok: true, json: async () => o, text: async () => JSON.stringify(o) });
  const X = (t) => ({ ok: true, json: async () => { throw new Error("xml"); }, text: async () => t });
  const NOW = Date.UTC(2026, 7, 16, 12, 0, 0);   // frozen inside Q2 2026's grace window
  const tbl = (rows) => "<x>" + rows.map(([nm, cu, v, sh]) =>
    `<infoTable><nameOfIssuer>${nm}</nameOfIssuer><cusip>${cu}</cusip><value>${v}</value>` +
    `<shrsOrPrnAmt><sshPrnamt>${sh}</sshPrnamt><sshPrnamtType>SH</sshPrnamtType></shrsOrPrnAmt></infoTable>`).join("") + "</x>";
  const AAPL = ["APPLE INC", "037833100"], UNH = ["UNITEDHEALTH GROUP INC", "91324P102"];
  const books = {
    "000126000002": tbl([[...AAPL, 1500, 15], [...UNH, 500, 5]]),   // BERKSHIRE Q2 — AAPL trimmed 20->15
    "000126000001": tbl([[...AAPL, 2000, 20]]),                      // BERKSHIRE Q1
    "000226000002": tbl([[...AAPL, 800, 8]]),                        // BRIDGEWATER Q2 — AAPL added 6->8
    "000226000001": tbl([[...AAPL, 600, 6]]),                        // BRIDGEWATER Q1
  };
  const subs = (name, pfx) => J({ name, filings: { recent: {
    form: ["13F-HR", "13F-HR"], accessionNumber: [pfx + "-26-000002", pfx + "-26-000001"],
    filingDate: ["2026-08-14", "2026-05-15"], reportDate: ["2026-06-30", "2026-03-31"] } } });
  const extFetch = async (url) => {
    if (url.includes("company_tickers.json")) return J({ 0: { cik_str: 111, ticker: "AAPL", title: "Apple Inc." } });
    if (url.includes("company_tickers_mf.json")) return J({ fields: ["cik"], data: [] });
    if (url.includes("submissions/CIK0001067983")) return subs("BERKSHIRE HATHAWAY INC", "0001");
    if (url.includes("submissions/CIK0001350694")) return subs("BRIDGEWATER ASSOCIATES LP", "0002");
    for (const acc of Object.keys(books)) {
      if (url.includes("/" + acc + "/index.json")) return J({ directory: { item: [
        { name: "primary_doc.xml", size: 900 }, { name: "form13fInfoTable.xml", size: 5000 }] } });
      if (url.includes("/" + acc + "/form13fInfoTable.xml")) return X(books[acc]);
    }
    return { ok: false, status: 404 };
  };
  const p = createPoller({ dex: "xyz", store, log: () => {}, version: "test", crypto: false, extFetch });
  p.hydrateWhaleNow();
  assert.ok(p.whaleAdd(1067983, "Berkshire Hathaway Inc", NOW).ok);
  assert.ok(p.whaleAdd(1350694, "Bridgewater Associates LP", NOW).ok);
  await p.whaleTickNow(NOW);

  const s0 = await p.getWhaleSeasonQ("Q2 2026");
  assert.ok(s0.ok, "season built from both filers: " + (s0.error || ""));
  assert.equal(s0.agg.nFunds, 2);
  assert.deepEqual(s0.agg.roster.map((r) => r.key).sort(), ["BERKSHIRE", "BRIDGEWATER"]);
  assert.equal(s0.stale, null, "roster matches the watchlist — nothing to disclose");
  const aapl0 = s0.agg.crowd.find((r) => r.tk === "AAPL");
  assert.ok(aapl0 && aapl0.held === 2 && aapl0.adding === 1 && aapl0.cutting === 1,
    "both hold AAPL; one added, one trimmed");

  // THE REGRESSION. Removing a fund used to leave this aggregate untouched until the next poll —
  // up to 24h in the "upcoming" stretch — so the denominator kept saying 2 while the grid drew 1.
  assert.ok(p.whaleRm("BRIDGEWATER", NOW).ok);
  const s1 = await p.getWhaleSeasonQ("Q2 2026");
  assert.equal(s1.agg.nFunds, 1, "the removal reopened the build synchronously — no waiting on the cadence");
  assert.deepEqual(s1.agg.roster.map((r) => r.key), ["BERKSHIRE"], "and the grid's roster shrank with it");
  assert.equal(s1.stale, null, "a rebuild that succeeded is not stale");
  assert.equal(s1.amended, false, "a roster edit is NOT an amendment — no filing moved, so the header must not claim one");
  assert.ok(!s1.agg.crowd.some((r) => r.tk === "AAPL"), "held by one fund is not crowding; the row leaves rather than counting a departed fund");

  // Re-adding restores it whole from cached books, without re-fetching EDGAR.
  assert.ok(p.whaleAdd(1350694, "Bridgewater Associates LP", NOW).ok);
  const s2 = await p.getWhaleSeasonQ("Q2 2026");
  assert.equal(s2.agg.nFunds, 2, "cached filings mean a re-add rebuilds immediately, no poll required");

  // Stale: remove every filer. Nothing remains to build from, so the aggregate outlives its roster
  // and SAYS SO rather than being deleted or silently describing funds you no longer track.
  assert.ok(p.whaleRm("BERKSHIRE", NOW).ok);
  assert.ok(p.whaleRm("BRIDGEWATER", NOW).ok);
  const s3 = await p.getWhaleSeasonQ("Q2 2026");
  assert.ok(s3.ok, "the season is KEPT — history is not destroyed to avoid a label");
  assert.ok(s3.stale, "…and flagged");
  // Removing BERKSHIRE first rebuilt cleanly down to one fund; removing the LAST filer is the
  // only edit with nothing to rebuild from, so the frozen build is that one-fund one — not the
  // original pair. The label reports the build that actually froze, not the roster's whole history.
  assert.deepEqual(s3.stale.dropped, ["BRIDGEWATER"], "the label names the fund the frozen build was built from");
  assert.equal(s3.agg.nFunds, 1, "the counts still describe that build, which is what makes them true");
  assert.ok(s3.agg.roster.every((r) => r.dropped === 1), "every cell in the grid marks itself history");
});

test("whale roster -01: accession and roster signatures are independent — only a filing move is an amendment", () => {
  const fs = require("fs"), path = require("path");
  const pol = fs.readFileSync(path.join(__dirname, "..", "src", "poller.js"), "utf8");
  // 2026.08.19-03: the write moved into whaleSeasonBuildQ (one writer for every build path),
  // which sits ABOVE whaleSeasonMaybe — the slice starts at the season core so the pins read the
  // gate (in Maybe) AND the write (in BuildQ) together, which is the actual invariant.
  const fn = pol.slice(pol.indexOf("function whaleSeasonBuildQ("));
  const body = fn.slice(0, fn.indexOf("\n  async function"));
  assert.ok(/const accs = \{\}/.test(body) && /const rosterSig = /.test(body), "two inputs, tracked separately");
  assert.ok(/!legacy && !accMoved && !rosterMoved/.test(body),
    "EITHER changing reopens the build — a roster edit changes what the aggregate would say just as an amendment does");
  assert.ok(/k in had\.accs && had\.accs\[k\] !== accs\[k\]/.test(body),
    "accessions compare on the INTERSECTION: a flat signature moves whenever the roster does, which is why it can't answer 'did a filing change?'");
  // 2026.08.19-03: the amended write moved into whaleSeasonBuildQ (the ONE writer for every
  // build path) — the doctrine is unchanged, only accMoved may set it; the pin follows the code.
  assert.ok(/amended: had \? \(meta && meta\.accMoved \? 1 :/.test(body),
    "…and only that comparison sets `amended`, or every add/remove announces a filing that never landed");
  assert.ok(/const legacy = had && !had\.accs/.test(body), "hydrated pre-build blobs rebuild once to adopt the roster");
  // The roster edits must reach the build directly rather than waiting on whaleTick's cadence.
  for (const f of ["function whaleAdd(cik, name, nowArg)", "function whaleRm(keyRaw, nowArg)"])
    assert.ok(pol.includes(f), "clock-injectable roster edit missing: " + f);
  assert.equal(pol.split("whaleSeasonMaybe(nowArg || Date.now())").length - 1, 2,
    "both add and remove reopen the build; a route that omits nowArg still gets the real clock");
});

test("whale season sync (2026.08.19-03): closed-quarter builds follow the live watchlist — no ghost 'missing', no denominator drift, late HR/As rebuild, all-dropped stays as labeled history", async () => {
  const { createPoller } = require("../src/poller");
  const J = (o) => ({ ok: true, json: async () => o, text: async () => JSON.stringify(o) });
  const X = (t) => ({ ok: true, json: async () => { throw new Error("xml"); }, text: async () => t });
  const row = (nm, cu, v, sh) => `<infoTable><nameOfIssuer>${nm}</nameOfIssuer><cusip>${cu}</cusip><value>${v}</value><shrsOrPrnAmt><sshPrnamt>${sh}</sshPrnamt><sshPrnamtType>SH</sshPrnamtType></shrsOrPrnAmt></infoTable>`;
  const book = (v) => `<x>${row("APPLE INC", "037833100", v, 1e6)}${row("MICRON TECHNOLOGY INC", "595112103", v / 2, 5e5)}</x>`;
  let amendA = false;   // flips to stage a late HR/A for fund A's Q2
  const sub = (pfx, amended) => J({ name: "X", filings: { recent: amended
    ? { form: ["13F-HR/A", "13F-HR", "13F-HR"], accessionNumber: [pfx + "-26-000009", pfx + "-26-000002", pfx + "-26-000001"],
        filingDate: ["2026-08-18", "2026-08-14", "2026-05-15"], reportDate: ["2026-06-30", "2026-06-30", "2026-03-31"] }
    : { form: ["13F-HR", "13F-HR"], accessionNumber: [pfx + "-26-000002", pfx + "-26-000001"],
        filingDate: ["2026-08-14", "2026-05-15"], reportDate: ["2026-06-30", "2026-03-31"] } } });
  const idx = J({ directory: { item: [{ name: "primary_doc.xml", size: 9 }, { name: "infotable.xml", size: 999 }] } });
  const extFetch = async (url) => {
    if (url.includes("company_tickers")) return J({});
    if (url.includes("submissions/CIK0000000401")) return sub("0401", amendA);
    if (url.includes("submissions/CIK0000000402")) return sub("0402", false);
    if (url.includes("infotable.xml")) return X(book(url.includes("000009") ? 999e6 : 800e6));
    if (url.includes("/index.json")) return idx;
    return { ok: false, status: 404, error: "404" };
  };
  const store = { loadAll: () => new Map(), loadRegime: () => [], loadLedger: () => null,
    saveLedger: () => {}, insert: () => {}, saveRegime: () => {}, saveNews: () => {}, loadNews: () => null,
    saveWhale: () => {}, loadWhale: () => null };
  const p = createPoller({ dex: "xyz", store, log: () => {}, version: "test", crypto: false, extFetch });
  p.hydrateWhaleNow();
  const NOWG = Date.UTC(2026, 7, 16, 12);   // in-grace clock, so the window builder creates the Q2 season
  p.whaleAdd(401, "Alpha One LP", NOWG); p.whaleAdd(402, "Beta Two LLC", NOWG);
  await p.whalePull("ALPHA"); await p.whalePull("BETA");
  p.whaleAdd(999, "NoBook Yet LP", NOWG);   // watched, never filed
  let s = await p.getWhaleSeasonQ("Q2 2026");
  assert.ok(s.ok && s.filedN === 2 && s.watchN === 3 && s.agg.nFunds === 2, "baseline: 2/3, one bookless in missing");
  assert.deepEqual(s.missing, ["NOBOOK"]);
  // THE screenshot bug: remove a covered fund AFTER the quarter closed. The window builder has
  // rolled to Q3 and will never look back — the sync must rebuild Q2 to the live list anyway.
  p.whaleRm("BETA");   // real clock: post-grace
  s = await p.getWhaleSeasonQ("Q2 2026");
  assert.equal(s.filedN, 1, "header filedN follows the live list");
  assert.equal(s.watchN, 2, "watchN is the list you can SEE, not a dead build's");
  assert.equal(s.agg.nFunds, 1, "lane denominators agree with the header");
  assert.deepEqual(s.agg.roster.map((r) => r.key), ["ALPHA"], "grid roster too");
  assert.deepEqual(s.missing, ["NOBOOK"], "missing lists only CURRENT bookless watched funds — a removed fund can never haunt it");
  assert.equal(s.amended, false, "roster edits never claim an amendment");
  assert.equal(s.stale, null, "nothing to disclose — the build matches the list, so the chip is silent");
  // Late HR/A on the CLOSED quarter: the daily amendment poll ingests it; the sync must rebuild
  // and NOW the amendment flag is earned.
  amendA = true;
  await p.whaleTickNow(Date.now() + 26 * 3600e3);   // past the slow gate: submissions re-checked, HR/A ingested through the scheduled path
  s = await p.getWhaleSeasonQ("Q2 2026");
  assert.equal(s.amended, true, "a FILING moved — the flag is earned, via the closed-quarter sync");
  assert.ok(Math.abs((s.agg.bought.concat(s.agg.sold).reduce((a2, r) => a2 + Math.abs(r.net), 0)) - 0) >= 0, "agg recomputed without throwing");
  // All coverage removed: the season is KEPT as labeled history (the -18-02 doctrine), chip live.
  p.whaleRm("ALPHA");
  s = await p.getWhaleSeasonQ("Q2 2026");
  assert.ok(s.ok, "kept — history is not destroyed to avoid a label");
  assert.ok(s.stale && s.stale.dropped.includes("ALPHA"), "and the chip says exactly what it is");
});

// Every 13F ingest attempt ever made 404'd, for two compounding reasons. The URL was built as a
// CALENDAR quarter (01apr2026-30jun2026) but the SEC publishes the window in which filings were
// RECEIVED — a period ending 31 Mar is due 15 May, so the file is 01mar2026-31may2026_form13f.zip.
// And the default quarter was one whose filing window had not closed, which cannot exist yet.
test("13f ingest: the SEC URL convention, and a default quarter that can exist", () => {
  const fs = require("fs"), path = require("path");
  const pol = fs.readFileSync(path.join(__dirname, "..", "src", "poller.js"), "utf8");
  const grab = (k) => { const i = pol.indexOf("  " + k);
    assert.ok(i > 0, k + " present"); return pol.slice(i).match(/^  (?:const [^\n]*|function [\s\S]*?\n  \})/)[0]; };
  const F = new Function(
    ["const T13F_MON", "function t13fWindow", "const T13F_POST_GRACE", "function t13fSeasonQuarter"].map(grab).join("\n") +
    '\nconst T13F_URL = "https://www.sec.gov/files/structureddata/data/form-13f-data-sets/";\n' +
    pol.match(/  function t13fZipUrls\(q\) \{[\s\S]*?\n  \}/)[0] +
    "\nreturn { t13fZipUrls, t13fSeasonQuarter, t13fWindow };")();
  const at = (d) => F.t13fSeasonQuarter(Date.parse(d + "T12:00:00Z"));

  // the one URL confirmed against sec.gov's own listing — byte for byte
  assert.strictEqual(F.t13fZipUrls("Q1 2026")[0],
    "https://www.sec.gov/files/structureddata/data/form-13f-data-sets/01mar2026-31may2026_form13f.zip",
    "Q1 2026 resolves to the real file");
  // the window opens on the quarter-END month and runs three, rolling the year and honouring leaps
  assert.strictEqual(F.t13fWindow(2, 2026).span, "01jun2026-31aug2026", "Q2 window");
  assert.strictEqual(F.t13fWindow(4, 2026).span, "01dec2026-28feb2027", "Q4 rolls the year");
  assert.strictEqual(F.t13fWindow(4, 2027).span, "01dec2027-29feb2028", "leap February");
  assert.ok(!/01jan" \+ y \+ "-31mar/.test(pol), "calendar-quarter spans are gone");

  // the default must never name a quarter whose filing window is still open — the original bug
  assert.strictEqual(at("2026-08-21"), "Q1 2026", "mid-Aug: Q2's window is open until 31 Aug");
  assert.strictEqual(at("2026-09-05"), "Q2 2026", "once it closes, Q2 becomes the target");
  assert.strictEqual(at("2027-01-05"), "Q3 2026", "January does not ask for a quarter still filing");
  assert.strictEqual(at("2026-05-02"), "Q4 2025", "year boundary walks back correctly");
  for (const d of ["2026-08-21", "2026-02-14", "2026-11-20", "2027-01-05", "2026-09-05"]) {
    const q = at(d), m = q.match(/^Q([1-4]) (\d{4})$/);
    assert.ok(m, "well-formed quarter for " + d);
    assert.ok(Date.parse(d + "T12:00:00Z") >= F.t13fWindow(+m[1], +m[2]).endMs,
      "on " + d + " the default " + q + " has a CLOSED filing window");
  }
  // both callers share the derivation — the drift between them was half the bug
  assert.strictEqual((pol.match(/t13fSeasonQuarter\(/g) || []).length, 3, "defined once, used by both paths");
  assert.ok(!/whaleWindow\(Date\.now\(\)\)\.cur\.q/.test(pol), "no caller defaults to the open quarter");

  // no failure exit is silent: a 404 must not look like a dead process
  const body = pol.slice(pol.indexOf("async function whale13fIngest("), pol.indexOf("async function whale13fTick("));
  assert.strictEqual((body.match(/return done\(\{ ok: false/g) || []).length, 1, "only the catch returns without fail()");
  assert.ok(/pushOps\([^;]*ingest FAILED[\s\S]{0,180}?return done\(\{ ok: false/.test(body), "and it logs first");
  assert.ok(body.includes("tried.push(url +"), "each attempt logs its FULL url");
});

test("congress -22: a backfill must not notify — the age guard failed OPEN twice over", async () => {
  // Reported from production: notifications kept arriving for OLD filings as the backfill filled
  // them in, when the newest filing in existence was days old. Two bugs pointing the same way:
  //   1. congressQueue never SELECTed `filed`, so the filing's date was undefined at alert time;
  //   2. the guard read "if the date is known AND old, skip" — so an UNKNOWN date alerted.
  // Together: every one of thousands of backfilled historical filings pushed a notification.
  const { createPoller } = require("../src/poller");
  const os2 = require("os"), fs = require("fs"), path = require("path");
  const { openStore } = require("../src/store");
  const dir = fs.mkdtempSync(path.join(os2.tmpdir(), "congressB-"));
  const store = openStore(dir);
  const iso = (d) => new Date(Date.now() - d * 86400000).toISOString().slice(0, 10);
  const pdf = fs.readFileSync(path.join(__dirname, "..", "package.json"));
  const extFetch = async () => ({ ok: true, headers: { get: () => "application/pdf" },
    arrayBuffer: async () => pdf.buffer.slice(pdf.byteOffset, pdf.byteOffset + pdf.byteLength) });
  const p = createPoller({ dex: "xyz", store, log: () => {}, version: "test", crypto: false, extFetch, congressGap: 0 });
  const F = (id, filed) => ({ id, chamber: "H", docId: id.slice(2), yr: 2026, member: "Starred, Member",
    lname: "Starred", fname: "", suffix: "", state: "CA", dist: "11", type: "ptr", typeRaw: "P",
    filed, url: "https://x/" + id + ".pdf", amends: null, parsed: 0, nTx: null });
  store.congressUpsertFilings([F("H:5001", iso(2)), F("H:5002", iso(400)), F("H:5003", "")]);
  p.congressWatchSet("Starred, Member", true);
  store.congressMetaSet("alertPrimed", String(Date.now()));       // past the seed run

  // The queue must carry the date at all — this is the half that made the guard unreachable.
  const q = store.congressQueue(10);
  assert.ok(q.every((r) => "filed" in r), "the parse queue carries each filing's date");

  const tx = [{ owner: "self", asset: "Apple Inc. (AAPL)", ticker: "AAPL", act: "buy",
    txDate: iso(3), notified: null, loAmt: 1001, hiAmt: 15000, tkSrc: "form", atype: "ST" }];
  const fired = () => p.getTriggers(0, "", true).recent.filter((t) => t.kind === "congress").length;
  const before = fired();
  store.congressSaveTx("H:5002", tx);
  p.congressAlertNow(q.find((r) => r.id === "H:5002"), tx);
  assert.equal(fired(), before, "a filing from over a year ago raises nothing, however it arrives");
  store.congressSaveTx("H:5003", tx);
  p.congressAlertNow(q.find((r) => r.id === "H:5003"), tx);
  assert.equal(fired(), before, "and an unknown date is NOT treated as recent — the guard fails closed");
  store.congressSaveTx("H:5001", tx);
  p.congressAlertNow(q.find((r) => r.id === "H:5001"), tx);
  assert.equal(fired(), before + 1, "while a filing from two days ago does alert");
  fs.rmSync(dir, { recursive: true, force: true });
});

test("congress -20: the parse run is throttle-bound, and concurrency must not corrupt the queue", async () => {
  // Measured on a real encrypted fixture: decrypt + extract + parse is well under a millisecond a
  // document. A 200-document run costs ~90ms of computation and used to take 200 SECONDS, all of it
  // deliberate waiting. Parallelising the WAIT is the only thing that makes this faster — but only
  // if workers sharing a cursor never hand the same filing to two of them, or one document gets
  // fetched twice and another never at all.
  const { createPoller } = require("../src/poller");
  const os2 = require("os"), fs = require("fs"), path = require("path");
  const { pdfTextRuns } = require("../src/compute");
  const dir = fs.mkdtempSync(path.join(os2.tmpdir(), "congress9-"));
  const { openStore } = require("../src/store");
  const store = openStore(dir);
  const rows = [];
  for (let i = 0; i < 24; i++) rows.push({ id: "H:7" + (100 + i), chamber: "H", docId: "7" + (100 + i),
    yr: 2026, member: "Filer " + (i % 4), lname: "Filer", fname: "", suffix: "", state: "CA", dist: "1",
    type: "ptr", typeRaw: "P", filed: "2026-08-20", url: "https://x/7" + (100 + i) + ".pdf",
    amends: null, parsed: 0, nTx: null });
  store.congressUpsertFilings(rows);
  const seen = new Map();
  const pdf = fs.readFileSync(path.join(__dirname, "..", "package.json")); // deliberately NOT a pdf
  const extFetch = async (url) => {
    seen.set(url, (seen.get(url) || 0) + 1);
    return { ok: true, headers: { get: () => "application/pdf" },
      arrayBuffer: async () => pdf.buffer.slice(pdf.byteOffset, pdf.byteOffset + pdf.byteLength) };
  };
  const p = createPoller({ dex: "xyz", store, log: () => {}, version: "test", crypto: false,
    extFetch, congressGap: 0, congressConc: 4 });
  const r = await p.congressParseNow(24);
  assert.equal(r.done, 24, "every queued filing is handed out");
  const docs = [...seen.entries()].filter(([u]) => /\/7\d+\.pdf$/.test(u));
  assert.equal(docs.length, 24, "to exactly one worker each \u2014 every filing fetched, none skipped");
  assert.ok(docs.every(([, n2]) => n2 === 1), "and none fetched twice, which a shared cursor could easily do");
  assert.equal(r.notPdf, 24, "the non-PDF bodies are classified honestly under concurrency too");
  assert.equal(pdfTextRuns(pdf).length, 0, "sanity: the fixture really is not a PDF");
  fs.rmSync(dir, { recursive: true, force: true });
});

test("congress -18: 'parsed' must not promise rows the table cannot show", async () => {
  // Production showed the index reporting "Khanna, Rohit · 7 PTR · 5 parsed" directly above a table
  // saying no transactions match. Both were true and the pair was nonsense: parsed counted filings
  // that yielded TEXT, which is not the same as filings that yielded TRANSACTIONS. A filing can
  // read perfectly and still produce nothing if the parser does not recognise its table.
  const { createPoller } = require("../src/poller");
  const os2 = require("os"), fs = require("fs"), path = require("path");
  const dir = fs.mkdtempSync(path.join(os2.tmpdir(), "congress8-"));
  const { openStore } = require("../src/store");
  const store = openStore(dir);
  const p = createPoller({ dex: "xyz", store, log: () => {}, version: "test", crypto: false, congressGap: 0 });
  const F = (id, filed, parsed) => ({ id, chamber: "H", docId: id.slice(2), yr: 2026, member: "Khanna, Rohit",
    lname: "Khanna", fname: "Rohit", suffix: "", state: "CA", dist: "17", type: "ptr", typeRaw: "P",
    filed, url: "https://x/" + id + ".pdf", amends: null, parsed, nTx: null });
  store.congressUpsertFilings([F("H:9001", "2026-08-20", 0), F("H:9002", "2026-08-19", 0), F("H:9003", "2026-08-18", 0)]);
  store.congressSaveTx("H:9001", [{ owner: "self", asset: "Apple Inc. (AAPL)", ticker: "AAPL", act: "buy",
    txDate: "2026-08-10", notified: null, loAmt: 1001, hiAmt: 15000, tkSrc: "form", atype: "ST" }]);
  store.congressSaveTx("H:9002", []);          // read fine, no rows recognised
  store.congressSaveTx("H:9003", []);
  const f = p.congressFilerSearch("khanna")[0];
  assert.equal(f.n, 3);
  assert.equal(f.done, 1, "only the filing that actually yielded transactions counts as done");
  assert.equal(f.empty, 2, "the ones that read but produced nothing are their own category");
  assert.ok(f.emptyDoc, "and one of them is named, so it can be diagnosed rather than wondered about");
  assert.equal(p.congressFeedCount({ q: "khanna" }), 1,
    "which is exactly what the table can show — the note and the table now agree");
  fs.rmSync(dir, { recursive: true, force: true });
});

test("congress -16: starring a member, and the two guards that keep alerts from becoming a wall", async () => {
  const { createPoller } = require("../src/poller");
  const os2 = require("os"), fs = require("fs"), path = require("path");
  const dir = fs.mkdtempSync(path.join(os2.tmpdir(), "congress6-"));
  const { openStore } = require("../src/store");
  const store = openStore(dir);
  const p = createPoller({ dex: "xyz", store, log: () => {}, version: "test", crypto: false, congressGap: 0 });
  assert.deepEqual(p.congressWatchList(), [], "nobody is starred to begin with");
  assert.ok(p.congressWatchSet("Pelosi, Nancy", true).ok);
  assert.equal(p.congressWatchList().length, 1);
  assert.equal(store.congressWatched("Pelosi, Nancy").notify, 1, "starred implies notify unless told otherwise");
  assert.ok(p.congressWatchSet("Pelosi, Nancy", false).ok);
  assert.equal(p.congressWatchList().length, 0, "and unstarring removes them");
  // The guards live in the source and matter more than any of the plumbing: a backfill walks YEARS
  // of filings, and alerting on that history would fire hundreds of notifications about trades from
  // two years ago — which is how a channel gets muted and the real alert gets missed.
  const pol = fs.readFileSync(path.join(__dirname, "..", "src", "poller.js"), "utf8");
  assert.ok(/alertPrimed/.test(pol), "nothing fires until one parse run has completed");
  assert.ok(/CONGRESS_ALERT_MAX_AGE/.test(pol), "and a filing older than the window is history, not news");
  const cmp = fs.readFileSync(path.join(__dirname, "..", "src", "compute.js"), "utf8");
  const cls = cmp.match(/const PUSH_CLASSES = \[([^\]]+)\]/)[1];
  const def = cmp.match(/const PUSH_DEFAULT_CLASSES = \[([^\]]+)\]/)[1];
  assert.ok(/"congress"/.test(cls), "congress is a push class of its own");
  assert.ok(!/congress/.test(def), "and is OPT-IN, like every class added after the frozen defaults");
  fs.rmSync(dir, { recursive: true, force: true });
});

test("congress -14: search runs in SQL, and a missing member gets an answer from the index", async () => {
  // "I can't find Pelosi" had three possible causes and the tool gave the same silence to all of
  // them: the year was never ingested, the filing is queued, or it is a scan this lane cannot read.
  const { createPoller } = require("../src/poller");
  const os2 = require("os"), fs = require("fs"), path = require("path");
  const dir = fs.mkdtempSync(path.join(os2.tmpdir(), "congress5-"));
  const { openStore } = require("../src/store");
  const store = openStore(dir);
  const p = createPoller({ dex: "xyz", store, log: () => {}, version: "test", crypto: false, congressGap: 0 });
  const F = (id, member, filed, parsed) => ({ id, chamber: "H", docId: id.slice(2), yr: +filed.slice(0, 4),
    member, lname: member.split(",")[0], fname: "", suffix: "", state: "CA", dist: "11",
    type: "ptr", typeRaw: "P", filed, url: "https://x/" + id + ".pdf", amends: null, parsed, nTx: null });
  store.congressUpsertFilings([
    F("H:1", "Pelosi, Nancy", "2026-08-24", 0),          // queued: filed, not read yet
    F("H:2", "Pelosi, Nancy", "2026-05-01", 2),          // a scan: this lane has no OCR
    F("H:3", "Khanna, Ro", "2026-08-23", 1),
  ]);
  store.congressSaveTx("H:3", [{ owner: "self", asset: "Apple Inc. (AAPL)", ticker: "AAPL", act: "buy",
    txDate: "2026-08-17", notified: "2026-08-18", loAmt: 1001, hiAmt: 15000, tkSrc: "form", atype: "ST" }]);
  // Search reaches every parsed transaction, not just a loaded page.
  assert.equal(store.congressFeed({ q: "khanna", limit: 50 }).length, 1, "member search runs in SQL");
  assert.equal(store.congressFeed({ q: "apple", limit: 50 }).length, 1, "so does asset search");
  assert.equal(store.congressFeed({ q: "pelosi", limit: 50 }).length, 0, "nothing parsed for her yet");
  // ...and THAT is the case the index can still answer.
  const f = p.congressFilerSearch("pelosi");
  assert.equal(f.length, 1);
  assert.equal(f[0].member, "Pelosi, Nancy");
  assert.equal(f[0].n, 2, "two PTR filings are known to the index");
  assert.equal(f[0].queued, 1, "one is waiting to be read");
  assert.equal(f[0].unreadable, 1, "one is a scan, which is a different answer from 'not there'");
  assert.equal(f[0].done, 0);
  assert.equal(p.congressFilerSearch("nobodyhere").length, 0, "and a genuine absence still reads as absent");
  fs.rmSync(dir, { recursive: true, force: true });
});

test("congress -04: parse queue — scans marked once, transient failures retried, feed and roll-up", async () => {
  const { createPoller } = require("../src/poller");
  const os2 = require("os"), fs = require("fs"), path = require("path");
  const alpha = " ()$,-./0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";
  const code = new Map(); alpha.split("").forEach((ch, i) => code.set(ch, i + 1));
  const pdfA = _mkPtrPdf([[90, 680, "Nvidia Corp (NVDA) [ST]"], [365, 680, "P"], [425, 680, "08/13/2026"], [500, 680, "08/20/2026"], [560, 680, "$1,000,001 - $5,000,000"]], { flate: true });
  const pdfB = _mkPtrPdf([[90, 680, "Nvidia Corp (NVDA) [ST]"], [365, 680, "S"], [425, 680, "06/02/2026"], [500, 680, "06/03/2026"], [560, 680, "$250,001 - $500,000"]], { subset: true, code });
  const scan = Buffer.from("%PDF-1.4\n1 0 obj\n<< /Type /Catalog >>\nendobj\n%%EOF", "latin1");
  const bin = (b) => ({ ok: true, arrayBuffer: async () => b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) });
  const idx = (rows) => {
    const mk = (files) => {                            // minimal STORED zip, as in the phase 1 test
      const parts = [], cd = []; let off = 0;
      for (const [name, text] of files) {
        const data = Buffer.from(text, "utf8"), nm = Buffer.from(name, "utf8");
        const lh = Buffer.alloc(30); lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt16LE(0, 8);
        lh.writeUInt32LE(data.length, 18); lh.writeUInt32LE(data.length, 22); lh.writeUInt16LE(nm.length, 26);
        parts.push(lh, nm, data);
        const ce = Buffer.alloc(46); ce.writeUInt32LE(0x02014b50, 0); ce.writeUInt16LE(0, 10);
        ce.writeUInt32LE(data.length, 20); ce.writeUInt32LE(data.length, 24); ce.writeUInt16LE(nm.length, 28);
        ce.writeUInt32LE(off, 42); cd.push(Buffer.concat([ce, nm]));
        off += 30 + nm.length + data.length;
      }
      const cdBuf = Buffer.concat(cd);
      const eo = Buffer.alloc(22); eo.writeUInt32LE(0x06054b50, 0); eo.writeUInt16LE(cd.length, 8);
      eo.writeUInt16LE(cd.length, 10); eo.writeUInt32LE(cdBuf.length, 12); eo.writeUInt32LE(off, 16);
      return Buffer.concat([...parts, cdBuf, eo]);
    };
    return mk([["2026FD.xml", "<FinancialDisclosure>" + rows + "</FinancialDisclosure>"]]);
  };
  const member = (last, first, doc, filed) =>
    `<Member><Last>${last}</Last><First>${first}</First><FilingType>P</FilingType><StateDst>CA11</StateDst><Year>2026</Year><FilingDate>${filed}</FilingDate><DocID>${doc}</DocID></Member>`;
  const zip = idx(member("Alpha", "Ann", "20000001", "8/20/2026") + member("Beta", "Bob", "20000002", "6/03/2026") + member("Gamma", "Gil", "20000003", "5/01/2026"));
  let flaky = 0, fetches = [];
  const extFetch = async (url) => {
    fetches.push(url);
    if (url.endsWith("2026FD.zip") && url.includes("financial-pdfs/2026FD")) return bin(zip);
    if (url.endsWith("/20000001.pdf")) return bin(pdfA);
    if (url.endsWith("/20000002.pdf")) { flaky++; return flaky === 1 ? { ok: false, status: 503 } : bin(pdfB); }
    if (url.endsWith("/20000003.pdf")) return bin(scan);
    return { ok: false, status: 404 };
  };
  const dir = fs.mkdtempSync(path.join(os2.tmpdir(), "congress2-"));
  const { openStore } = require("../src/store");
  const store = openStore(dir);
  const p = createPoller({ dex: "xyz", store, log: () => {}, version: "test", crypto: false, extFetch, congressGap: 0 });
  assert.ok((await p.congressIngestNow(2026)).ok, "index first");
  assert.equal(p.congressStatus().parse.pending, 3, "three PTRs queued");

  const r1 = await p.congressParseNow();
  assert.equal(r1.parsed, 1, "the good filing parsed");
  assert.equal(r1.scanned, 1, "the image-only filing is recognized as unreadable, not retried forever");
  assert.equal(r1.notPdf, 0, "and is not confused with a response that was never a PDF at all");
  assert.equal(r1.failed, 1, "the 503 is a transient failure, counted separately from a scan");
  assert.equal(r1.tx, 1);

  // Second run: the scan must NOT be re-fetched (that is the rate budget), the 503 must be.
  fetches = [];
  const r2 = await p.congressParseNow();
  assert.ok(!fetches.some((u) => u.endsWith("/20000003.pdf")), "a permanently unreadable filing is never re-fetched");
  assert.ok(fetches.some((u) => u.endsWith("/20000002.pdf")), "a transient failure comes back around");
  assert.equal(r2.parsed, 1, "and parses on the retry");
  const st = p.congressStatus().parse;
  assert.deepEqual([st.parsed, st.unreadable, st.pending], [2, 1, 0], "queue drains to nothing but the scan");
  assert.equal(st.tx, 2); assert.equal(st.resolved, 2, "both transactions resolved a ticker");

  // Feed order is by FILING date, not trade date — the whole point of the lane.
  const feed = p.congressFeed({ limit: 10 });
  assert.deepEqual(feed.map((f) => f.member), ["Alpha, Ann", "Beta, Bob"], "newest FILED first");
  // An absent sort direction must mean newest-first, which is the feed's whole premise: +undefined
  // is NaN and NaN < 0 is false, so a naive check silently defaults a feed to OLDEST first.
  assert.deepEqual(p.congressFeed({ limit: 10, dir: 1 }).map((f) => f.member), ["Beta, Bob", "Alpha, Ann"],
    "and an explicit ascending direction is honoured");
  assert.equal(p.congressFeedCount({}), 2, "the pager's total counts every matching row, not the page");
  assert.equal(p.congressFeed({ limit: 1, offset: 1 })[0].member, "Beta, Bob", "offset paginates in SQL");
  assert.equal(feed[0].loAmt, 1000001);
  assert.equal(feed[0].hiAmt, 5000000, "the band's upper end survives into the feed");

  // Roll-up: floors only, and the median lag each member files at.
  const roll = p.congressTickerRoll("nvda");
  assert.equal(roll.ticker, "NVDA", "lookup is case-insensitive");
  assert.equal(roll.filings, 2);
  assert.equal(roll.buys, 1); assert.equal(roll.sells, 1);
  assert.equal(roll.floor, 1000001 + 250001, "the roll-up sums band FLOORS — a hard lower bound, never an estimate");
  const ann = roll.members.find((m) => /Alpha/.test(m.member));
  assert.equal(ann.medLag, 7, "filed 8/20 on an 8/13 trade — a seven-day filer");
  assert.equal(roll.members.find((m) => /Beta/.test(m.member)).medLag, 1);
  assert.equal(p.congressTickerRoll("ZZZZ"), null, "a name with no congressional flow says so rather than inventing an empty shell");

  // The failure the first parse run in production actually hit: a 200 whose body is NOT a PDF was
  // being recorded as "scanned", which marks the row permanently unreadable — so a wrong URL or an
  // error page looked exactly like a paper filing and could never be retried. A non-PDF body is a
  // fetch problem: it retries, it carries a reason, and requeue can undo a bad verdict.
  const dir2 = fs.mkdtempSync(path.join(os2.tmpdir(), "congress3-"));
  const store2 = openStore(dir2);
  const html = Buffer.from("<!DOCTYPE html><html><head><title>404 Not Found</title></head><body>nope</body></html>", "latin1");
  const ef2 = async (url) => {
    if (url.endsWith("2026FD.zip") && url.includes("financial-pdfs/2026FD")) return bin(zip);
    return { ok: true, headers: { get: () => "text/html" }, arrayBuffer: async () => html.buffer.slice(html.byteOffset, html.byteOffset + html.byteLength) };
  };
  const p2 = createPoller({ dex: "xyz", store: store2, log: () => {}, version: "test", crypto: false, extFetch: ef2, congressGap: 0 });
  assert.ok((await p2.congressIngestNow(2026)).ok);
  const bad = await p2.congressParseNow();
  assert.equal(bad.notPdf, 3, "an HTML body is counted as not-a-PDF");
  assert.equal(bad.scanned, 0, "and is NEVER recorded as a scanned filing");
  const st2 = p2.congressStatus().parse;
  assert.equal(st2.unreadable, 0, "so nothing is permanently condemned by a fetch problem");
  assert.ok(st2.notes.some((n) => /not-a-pdf/.test(n.note)), "the reason is stored, so the count can be broken down");
  // And a wrong verdict is reversible.
  store2.congressMarkUnreadable("H:20000001", "pdf-but-no-text");
  assert.equal(p2.congressStatus().parse.unreadable, 1);
  assert.equal(p2.congressRequeueNow().requeued, 1, "requeue puts a condemned filing back");
  assert.equal(p2.congressStatus().parse.unreadable, 0);
  // A filing that PARSED but yielded zero transactions is what a parser fix repairs, so requeue all
  // has to reach it. Leaving it at parsed=1 made it permanently invisible to a re-run — the same
  // trap as a wrong unreadable verdict, one state along.
  store2.congressSaveTx("H:20000002", []);
  assert.equal(p2.congressStatus().parse.parsed, 1, "parsed, but with nothing in it");
  assert.ok(p2.congressRequeueNow("all").requeued >= 1, "requeue all reaches a parsed-but-empty filing");
  assert.equal(p2.congressStatus().parse.parsed, 0, "so a mapping fix can replay it");
  fs.rmSync(dir2, { recursive: true, force: true });
  fs.rmSync(dir, { recursive: true, force: true });
});

test("macro scan: an FOMC result announced off a wrong read re-announces once the corrected range lands", () => {
  const p = ctxHarness();
  const macro = () => p.getTriggers(0, null, true).events.filter((e) => e.kind === "macro" && e.k === "FOMC");
  p.macroPrimeNow();
  const d = "2026-09-16";
  // The bad read: decision day, the series still carrying the range going in → "held".
  p.macroSeedNow([{ k: "FOMC", label: "FOMC rate decision", d, tEt: "14:00", sep: true, prior: { lo: 3.5, hi: 3.75 }, actual: { lo: 3.5, hi: 3.75 } }]);
  p.macroScanNow();
  assert.equal(macro().length, 1);
  p.macroScanNow();
  assert.equal(macro().length, 1, "the same result never repeats");
  // The next fetch reads the day-after observation: a different range is a different key.
  p.macroSeedNow([{ k: "FOMC", label: "FOMC rate decision", d, tEt: "14:00", sep: true, prior: { lo: 3.5, hi: 3.75 }, actual: { lo: 3.75, hi: 4.0 } }]);
  p.macroScanNow();
  assert.equal(macro().length, 2, "the corrected decision goes out");
  assert.deepEqual(macro().at(-1).actual, { lo: 3.75, hi: 4.0 }, "newest last: the corrected range is the latest event");
  p.macroScanNow();
  assert.equal(macro().length, 2);
  // Other releases keep the plain key: a revised CPI actual is not re-announced.
  p.macroSeedNow([{ k: "CPI", label: "CPI", d, tEt: "08:30", prior: { yoy: 2.9, m: "2026-07" }, actual: { yoy: 3.0, m: "2026-08" } }]);
  p.macroScanNow();
  const cpi = () => p.getTriggers(0, null, true).events.filter((e) => e.kind === "macro" && e.k === "CPI");
  assert.equal(cpi().length, 1);
  p.macroSeedNow([{ k: "CPI", label: "CPI", d, tEt: "08:30", prior: { yoy: 2.9, m: "2026-07" }, actual: { yoy: 3.1, m: "2026-08" } }]);
  p.macroScanNow();
  assert.equal(cpi().length, 1);
});
