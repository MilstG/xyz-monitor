"use strict";
// store.js — persistence. Split out of test.js (build 2026.09.16-80); order within the file is the original order.
const test = require("node:test");
const assert = require("node:assert");
const { HOUR, DAY, C } = require("./_shared");


test("insiders feed: sort, filter and search all run in SQL over the whole set", (t) => {
  const fs = require("fs"), os = require("os"), path = require("path");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ins-"));
  const st = require("../src/store").openStore(dir);
  if (!st.insidersReady()) return t.skip("node:sqlite unavailable in this runtime");
  const url = (cik, acc) => `https://www.sec.gov/Archives/edgar/data/${cik}/${acc.replace(/-/g, "")}/${acc}-index.htm`;
  st.insidersQueue([
    { acc: "0000050863-26-000101", tk: "INTC", form: "4", filed: Date.parse("2026-08-26T21:05:00Z"), url: url(50863, "0000050863-26-000101") },
    { acc: "0001045810-26-000222", tk: "NVDA", form: "4", filed: Date.parse("2026-08-25T20:30:00Z"), url: url(1045810, "0001045810-26-000222") },
  ]);
  assert.deepEqual(st.insidersQueue([{ acc: "0000050863-26-000101", tk: "INTC", form: "4", filed: 1, url: "u" }]),
    { seen: 1, added: 0 }, "re-seeing an accession queues nothing new — the EDGAR rotation revisits every name hourly");
  // ...and re-seeing it must not DOWNGRADE what is known about it. Both discovery paths derive the
  // filing date independently; EDGAR published the filing once, so the first good value stands.
  assert.equal(st.openInsiders().prepare("SELECT filed FROM filing WHERE acc=?").get("0000050863-26-000101").filed,
    Date.parse("2026-08-26T21:05:00Z"), "a second sighting carrying a worse timestamp leaves the good one alone");
  st.insidersSave("0000050863-26-000101",
    { tk: "INTC", issuer: "INTEL CORP", period: "2026-08-25", owner: "Tan Lip-Bu", role: "director · officer", title: "Chief Executive Officer", nDeriv: 1 },
    [{ ln: 0, code: "P", act: "buy", ad: "A", shares: 500000, price: 20, value: 1e7, txDate: "2026-08-25", own: 1500000, dir: "D", plan: null, sec: "Common Stock" },
      { ln: 1, code: "S", act: "sell", ad: "D", shares: 12500, price: null, value: null, txDate: "2026-08-26", own: null, dir: null, plan: 1, sec: "Common Stock" }]);
  st.insidersSave("0001045810-26-000222",
    { tk: "NVDA", issuer: "NVIDIA CORP", period: "2026-08-24", owner: "Huang Jen-Hsun", role: "director · officer", title: "CEO", nDeriv: 0 },
    [{ ln: 0, code: "S", act: "sell", ad: "D", shares: 100000, price: 180.5, value: 18050000, txDate: "2026-08-24", own: 900000, dir: "I", plan: 1, sec: "Common Stock" },
      { ln: 1, code: "A", act: "grant", ad: "A", shares: 40000, price: 0, value: null, txDate: "2026-08-24", own: 940000, dir: "D", plan: null, sec: "Common Stock" }]);
  const ids = (o) => st.insidersFeed(o).map((r) => r.tk + ":" + r.code);

  // SORT: from a closed whitelist, over the whole set. A key that is not in the map can never
  // reach the query as text — it falls back to the default rather than erroring or interpolating.
  assert.deepEqual(ids({ sort: "value", dir: -1 }), ["NVDA:S", "INTC:P", "INTC:S", "NVDA:A"],
    "by value, biggest first — the two rows with no value tie there and fall back to the filing date");
  assert.equal(st.insidersFeed({ sort: "value; DROP TABLE tx--" }).length, 4, "an unknown sort key falls back to the default, never interpolates");
  assert.ok(st.insidersFeedCount({}) === 4, "the table survived that");
  // NULLS LAST in BOTH directions — SQL puts them first on ascending, which buries every row that
  // HAS an answer beneath the rows that do not.
  assert.equal(st.insidersFeed({ sort: "price", dir: 1 }).slice(-1)[0].price, null, "ascending: no-price rows sort last");
  assert.equal(st.insidersFeed({ sort: "price", dir: -1 }).slice(-1)[0].price, null, "descending: still last");

  // FILTER: every filter is SQL, so the pager's "of N" counts the same set the rows come from.
  assert.deepEqual(ids({ codes: "P" }), ["INTC:P"], "code chips filter server-side");
  assert.equal(st.insidersFeedCount({ codes: "P" }), 1, "...and the count agrees with the page");
  assert.deepEqual(ids({ codes: "P,S", minValue: 15e6 }), ["NVDA:S"], "size filter");
  assert.deepEqual(ids({ codes: "P,S", minValue: 1 }).indexOf("INTC:S"), -1,
    "a row with no price has no value and is EXCLUDED by a size filter rather than counted as zero");
  // The plan filter is tri-state and neither bucket may swallow the third answer.
  assert.deepEqual(ids({ plan: "only" }).sort(), ["INTC:S", "NVDA:S"], "only rows whose box is ticked");
  assert.deepEqual(ids({ plan: "excl", codes: "P" }), ["INTC:P"], "not-marked includes rows with no box at all");
  assert.equal(st.insidersFeedCount({ plan: "only" }) + st.insidersFeedCount({ plan: "excl" }), 4, "the two buckets partition the set exactly once");
  assert.equal(st.insidersFeedCount({ role: "officer" }), 4, "role filter reads the form's own boxes");
  assert.equal(st.insidersFeedCount({ ticker: "nvda" }), 2, "ticker filter is case-insensitive");

  // SEARCH: in SQL, over every stored transaction, order-independent.
  assert.deepEqual(ids({ q: "jen" }), ["NVDA:S", "NVDA:A"], "a partial name matches");
  assert.deepEqual(ids({ q: "huang nvda" }), ids({ q: "nvda huang" }), "word order does not matter");
  assert.deepEqual(ids({ q: "intel" }), ["INTC:P", "INTC:S"], "the issuer name is searchable too");
  assert.equal(st.insidersFeedCount({ q: "nobody here" }), 0, "a search that matches nothing says nothing, honestly");
  // Paging is a view of one ordered set, not a re-sort per page.
  assert.deepEqual(st.insidersFeed({ sort: "value", dir: -1, limit: 2, offset: 2 }).map((r) => r.tk + ":" + r.code),
    ["INTC:S", "NVDA:A"], "page 2 continues page 1's ordering");


  // "c-suite" matches the filer's OWN WORDS in the title, not a taxonomy this lane invented — so
  // it is incomplete by construction, which is what the chip's hover says.
  assert.equal(st.insidersFeedCount({ role: "c-suite" }), 4, "both filings carry chief-officer titles");
  st.insidersQueue([{ acc: "0007777777-26-000001", tk: "WWWW", form: "4", filed: Date.parse("2026-08-21T13:00:00Z"), url: url(777, "0007777777-26-000001") },
    { acc: "0007777777-26-000002", tk: "VVVV", form: "4", filed: Date.parse("2026-08-21T13:00:00Z"), url: url(777, "0007777777-26-000002") },
    { acc: "0000010101-26-000001", tk: "ARM", form: "4", filed: Date.parse("2026-08-26T21:00:00Z"), url: url(10101, "0000010101-26-000001") }]);
  st.insidersSave("0007777777-26-000001", { tk: "WWWW", owner: "A Manager", role: "officer", title: "Vice President, Sales", nDeriv: 0 },
    [{ ln: 0, code: "P", act: "buy", shares: 10, price: 1, value: 10, txDate: "2026-08-20" }]);
  assert.equal(st.insidersFeedCount({ role: "c-suite" }), 4,
    "a VICE president is an officer and NOT c-suite — matching '%President%' alone swept in every VP, EVP and SVP on the roster");
  assert.equal(st.insidersFeedCount({ role: "officer" }), 5, "...but is still under officers");
  st.insidersSave("0007777777-26-000002", { tk: "VVVV", owner: "The Boss", role: "officer", title: "President", nDeriv: 0 },
    [{ ln: 0, code: "P", act: "buy", shares: 10, price: 1, value: 10, txDate: "2026-08-20" }]);
  assert.equal(st.insidersFeedCount({ role: "c-suite" }), 5, "...while an actual President is");
  // ROLE sorts on what the column SHOWS. Sorting on the relationship boxes collated every row
  // under "director · officer" and grouped nothing.
  const roles = st.insidersFeed({ sort: "role", dir: 1 }).map((r) => r.title || r.role);
  assert.deepEqual(roles.slice(-1), ["Vice President, Sales"], "titles sort as titles, so one person's job groups together");

  // Table II joins the same table, kept apart by KIND rather than by living somewhere else — one
  // query behind one pager, one definition of "the set the rows come from".
  st.insidersSave("0000010101-26-000001",
    { tk: "ARM", issuer: "ARM HOLDINGS", owner: "Haas Rene", role: "officer", title: "Chief Executive Officer", nDeriv: 1 },
    [{ ln: 0, kind: "S", code: "S", act: "sell", shares: 5191, price: 258.66, value: 1342704.06, txDate: "2026-08-26" },
      { ln: 1, kind: "D", code: "M", act: "exercise", shares: 5191, price: null, value: null, txDate: "2026-08-26",
        strike: 12.04, expiry: "2032-09-14", under: "Common Stock \u00d7 5191" }]);
  assert.equal(st.insidersFeedCount({ kind: "D" }), 1, "the derivative row is reachable on its own");
  assert.equal(st.insidersFeedCount({ kind: "S", ticker: "ARM" }), 1, "...and the share row separately");
  assert.equal(st.insidersFeedCount({ ticker: "ARM" }), 2, "no kind filter interleaves both");
  const d0 = st.insidersFeed({ kind: "D" })[0];
  assert.equal(d0.strike, 12.04); assert.equal(d0.price, null, "a strike never arrives as a price");
  assert.equal(d0.expiry, "2032-09-14"); assert.equal(d0.kind, "D");
  // Rows written before Table II was read carry no kind. They are share rows and must answer to
  // "shares" rather than falling out of both buckets and quietly vanishing from the tab.
  assert.equal(st.insidersFeedCount({ kind: "S" }) + st.insidersFeedCount({ kind: "D" }),
    st.insidersFeedCount({}), "the two kinds partition the set exactly once — nothing falls between them");

  // DATE RANGE. Two dates exist on a Form 4 and they are not the same: when the trade happened,
  // and when EDGAR published it. A range that picked one silently would answer a question the
  // reader did not ask, so which date it applies to is explicit.
  const R = (o) => st.insidersFeed(o).map((r) => r.tk + ":" + r.code + ":" + r.txDate);
  assert.equal(st.insidersFeedCount({ from: "2026-08-26" }), 3, "traded on or after — inclusive lower bound");
  assert.equal(st.insidersFeedCount({ to: "2026-08-24" }), 4, "traded on or before — inclusive upper bound");
  assert.equal(st.insidersFeedCount({ from: "2026-08-25", to: "2026-08-25" }), 1, "a single-day range is a real range");
  assert.equal(st.insidersFeedCount({ from: "2026-08-24", to: "2026-08-26" }), 6, "the whole span");
  assert.equal(st.insidersFeedCount({ from: "2027-01-01" }), 0, "a range with nothing in it returns nothing, not everything");
  // Reversed ranges are normalised rather than returning an empty table: a from/to typo is the
  // common case and silence is a bad answer to it.
  assert.equal(st.insidersFeedCount({ from: "2026-08-26", to: "2026-08-24" }),
    st.insidersFeedCount({ from: "2026-08-24", to: "2026-08-26" }), "a reversed range is normalised, not answered with nothing");
  // The FILED basis reads a different column with a different type — epoch ms, so the upper bound
  // has to reach the END of its day or everything filed on the last day of the range disappears.
  assert.equal(st.insidersFeedCount({ dateOn: "filed", from: "2026-08-26", to: "2026-08-26" }), 4,
    "a filing timestamped 21:05 is inside a range whose end is that same day — comparing against midnight would drop it");
  assert.equal(st.insidersFeedCount({ dateOn: "filed", from: "2026-08-25", to: "2026-08-25" }), 2, "the other day's filing");
  assert.equal(st.insidersFeedCount({ dateOn: "filed", to: "2026-08-22" }), 2, "the two filed on the 21st, and nothing earlier");
  // The two bases genuinely differ: NVDA traded on the 24th and filed on the 25th.
  assert.equal(R({ from: "2026-08-25", to: "2026-08-25" }).length, 1, "INTC traded on the 25th");
  assert.equal(st.insidersFeedCount({ dateOn: "filed", from: "2026-08-25", to: "2026-08-25" }), 2,
    "same range, other basis, different answer — which is the reason the basis is stated");
  // Garbage never reaches the query as a bound.
  assert.equal(st.insidersFeedCount({ from: "not-a-date" }), st.insidersFeedCount({}), "a malformed bound is dropped, not interpolated");
  assert.equal(st.insidersFeedCount({ from: "2026-08-26' OR 1=1--" }), st.insidersFeedCount({}), "...including one shaped like an injection");

  // UNIVERSE SCOPE. A Form 4 is associated with every CIK on it, so a 10% holder's own submissions
  // feed carries filings about the companies it HOLDS. Those are real and correctly read, and they
  // are not about anything on the board — so they are filtered at READ time, which keeps them for
  // the day a name joins the universe instead of needing every document re-fetched.
  const uni = ["INTC", "NVDA"];
  assert.equal(st.insidersFeedCount({ uni }), 4, "only the covered names");
  assert.ok(st.insidersFeedCount({}) > 4, "...while the lane still HOLDS the rest");
  assert.deepEqual(st.insidersFeed({ uni }).map((r) => r.tk).filter((v, i, a) => a.indexOf(v) === i).sort(),
    ["INTC", "NVDA"], "nothing off-board survives the scope");
  assert.equal(st.insidersFeedCount({ uni: ["intc"] }), 2, "the roster is matched case-insensitively");
  assert.equal(st.insidersFeedCount({ uni: [] }), st.insidersFeedCount({}),
    "an EMPTY roster scopes nothing — a board that has not reconciled yet must not report zero insider activity");
  // The scope is a filter like any other: the count behind the pager sees the same set.
  assert.equal(st.insidersFeed({ uni, limit: 500 }).length, st.insidersFeedCount({ uni }), "page and count agree under scope");
  assert.equal(st.insidersFeedCount({ uni, codes: "P" }), st.insidersFeed({ uni, codes: "P" }).length, "...and it composes with the others");

  // A re-parse REPLACES a filing's rows. An amended Form 4 must not leave the original trade
  // behind next to the corrected one.
  st.insidersSave("0000050863-26-000101", { tk: "INTC", owner: "Tan Lip-Bu", nDeriv: 0 },
    [{ ln: 0, code: "P", act: "buy", shares: 400000, price: 20, value: 8e6, txDate: "2026-08-25" }]);
  assert.equal(st.insidersFeedCount({ ticker: "INTC" }), 1, "the superseded rows are gone, not duplicated");

  // The roll-up the drawer reads: a sale with no disclosed price must not report as $0 of selling.
  const roll = st.insidersTickerRoll("NVDA", 90);
  assert.equal(roll.nSell, 1); assert.equal(roll.sellVal, 18050000);
  st.insidersSave("0009999999-26-000001", { tk: "ZZZZ", owner: "Someone", nDeriv: 0 },
    [{ ln: 0, code: "S", act: "sell", shares: 100, price: null, value: null, txDate: new Date().toISOString().slice(0, 10) }]);
  const z = st.insidersTickerRoll("ZZZZ", 90);
  assert.equal(z.nSell, 1, "the sale is counted");
  assert.equal(z.sellVal, null, "...but its dollar value is UNKNOWN, never zero");
  assert.equal(z.nNoPx, 1, "and the row that had no price is disclosed as such");
  fs.rmSync(dir, { recursive: true, force: true });
});

test("perf: hourly spine persists as NDJSON, restores by streaming, and bridges the legacy json once", async () => {
  const { openStore } = require("../src/store");
  const fs = require("fs"), os = require("os"), path = require("path");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "perf-hstore-"));
  try {
    const s = openStore(dir);
    const hourly = {};
    for (let k = 0; k < 40; k++) { const arr = []; for (let i = 0; i < 300; i++) arr.push([1721000000000 + i * HOUR, 1 + i * 0.01, 1.5, 0.9, 1.2, 1000 + i]); hourly["C" + k] = arr; }
    await s.saveHourly({ ts: 1721563200000, hourly });
    assert.ok(fs.existsSync(path.join(dir, "hourly.ndjson")), "NDJSON spine written");
    // exact round-trip via the streaming reader
    const got = {}; const meta = await s.streamHourly((coin, c) => { got[coin] = c; });
    assert.equal(meta.coins, 40, "all coins streamed back");
    assert.equal(meta.ts, 1721563200000, "header ts restored");
    assert.deepEqual(got["C7"], hourly["C7"], "candle arrays survive the round-trip byte-for-byte");
    // legacy bridge: only the old whole-object json present -> still restores
    fs.unlinkSync(path.join(dir, "hourly.ndjson"));
    fs.writeFileSync(path.join(dir, "hourly.json"), JSON.stringify({ ts: 42, hourly: { LEG: [[1, 2, 3, 4, 5, 6]]} }));
    const s2 = openStore(dir); const leg = {}; const lm = await s2.streamHourly((coin, c) => { leg[coin] = c; });
    assert.deepEqual(leg.LEG, [[1, 2, 3, 4, 5, 6]], "legacy json is read as a one-time bridge");
    assert.equal(lm.ts, 42);
    // after the next NDJSON write, the legacy file is retired so it can't shadow future writes
    await s2.saveHourly({ ts: 7, hourly: { X: [[9, 9, 9, 9, 9, 9]] } });
    assert.ok(!fs.existsSync(path.join(dir, "hourly.json")), "legacy json retired after the first ndjson write");
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

// ============================================================================================
// 5-minute OHLCV archive (build 2026.07.22-01): on-disk node:sqlite store, build-forward capture,
// server-side downsampled reads, 370d retention. The archive is the SOLE copy of history past the
// native ~17d candleSnapshot window, so these pin the integrity that keeps it honest.
// ============================================================================================
test("5m archive: upsert is idempotent, range reads clustered, evict + coverage exact", () => {
  const fs = require("fs"), path = require("path"), os = require("os");
  const { openStore } = require("../src/store");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "xyzm5-"));
  try {
    const s = openStore(dir);
    assert.ok(s.candlesEnabled(), "node:sqlite must be available under --experimental-sqlite (test runner passes the flag)");
    assert.ok(fs.existsSync(path.join(dir, "candles.db")), "candle db file created on the volume");
    const M5 = 5 * 60 * 1000, base = 1_700_000_000_000;
    const bars = [];
    for (let i = 0; i < 10; i++) bars.push([base + i * M5, 100 + i, 101 + i, 99 + i, 100.5 + i, 1000 + i]);
    assert.equal(s.insertCandles("xyz:AAPL", bars), 10, "all ten bars upserted");
    // idempotency: re-inserting the same window (with a changed close on one bar) must NOT duplicate
    const again = bars.map((k) => k.slice());
    again[3] = [again[3][0], 200, 210, 190, 205, 9999];   // same (coin,ts), new body
    s.insertCandles("xyz:AAPL", again);
    const cov = s.candleCoverage("xyz:AAPL");
    assert.equal(cov.count, 10, "upsert on the same keys does not duplicate rows");
    assert.equal(cov.min, base, "coverage min = first bar");
    assert.equal(cov.max, base + 9 * M5, "coverage max = last bar");
    const r = s.readCandles("xyz:AAPL", base, base + 9 * M5);
    assert.equal(r.length, 10, "range read returns the whole window, oldest->newest");
    for (let i = 1; i < r.length; i++) assert.ok(r[i][0] > r[i - 1][0], "rows come back time-ordered");
    assert.equal(r[3][4], 205, "the conflicting bar took the UPDATE close, not a second row");
    // a second coin is isolated (clustering by (coin,ts))
    s.insertCandles("BTC", [[base, 1, 2, 3, 4, 5]]);
    assert.equal(s.readCandles("xyz:AAPL", base, base).length, 1, "cross-coin isolation on read");
    // evict drops strictly older-than the cut, whole archive
    const dropped = s.evictCandles(base + 5 * M5);
    assert.equal(dropped, 6, "evict removes exactly the bars older than the cut, whole archive (5 of AAPL + BTC's 1)");
    assert.equal(s.candleCoverage("xyz:AAPL").min, base + 5 * M5, "post-evict min advances to the cut");
    assert.equal(s.readCandles("BTC", base, base).length, 0, "BTC's lone old bar also evicted (whole-archive cut)");
    s.close();
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});


// ============================================================================================
// Deep 12h/1d archive + CHARTS tab (build 2026.08.21-01): backward-seeded long-history tables,
// the res=12h / res=1d route axis, and the multi-pane chart grid. Behavioral tests run the real
// store and the real getter against fixtures; the wiring manifest pins every new symbol.
// ============================================================================================
test("deep archive: per-interval tables are isolated, upserts idempotent, unknown interval refused", () => {
  const fs = require("fs"), path = require("path"), os = require("os");
  const { openStore } = require("../src/store");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "xyzdeep-"));
  try {
    const s = openStore(dir);
    assert.ok(s.candlesEnabled(), "node:sqlite must be available under --experimental-sqlite");
    const base = 1_700_000_000_000;
    const mk = (w, n, px) => Array.from({ length: n }, (_, i) => [base + i * w, px + i, px + i + 1, px + i - 1, px + i + 0.5, 100 + i]);
    // both intervals accept rows; re-inserting a changed close upserts in place, never duplicates
    assert.equal(s.insertCandlesDeep("12h", "xyz:AAPL", mk(12 * HOUR, 10, 100)), 10, "12h rows land");
    assert.equal(s.insertCandlesDeep("1d", "xyz:AAPL", mk(DAY, 10, 200)), 10, "1d rows land");
    const again = mk(12 * HOUR, 10, 100); again[3][4] = 999;
    assert.equal(s.insertCandlesDeep("12h", "xyz:AAPL", again), 10, "re-insert accepted");
    const r12 = s.readCandlesDeep("12h", "xyz:AAPL", base, base + 20 * DAY);
    assert.equal(r12.length, 10, "no duplicate rows after the overlapping re-insert");
    assert.equal(r12[3][4], 999, "upsert replaced the close in place");
    // ISOLATION: an interval's read never sees the other table's rows (the mixed-resolution
    // failure the separate-tables design exists to prevent)
    const r1d = s.readCandlesDeep("1d", "xyz:AAPL", base, base + 20 * DAY);
    assert.equal(r1d.length, 10);
    assert.equal(r1d[0][1], 200, "1d table holds the 1d fixture, untouched by 12h writes");
    // coverage is per (interval, coin), exact
    const cov = s.candleCoverageDeep("12h", "xyz:AAPL");
    assert.equal(cov.count, 10); assert.equal(cov.min, base); assert.equal(cov.max, base + 9 * 12 * HOUR);
    assert.equal(s.candleCoverageDeep("1d", "xyz:NVDA").count, 0, "unseeded coin reports zero, never a fabricated span");
    // 4h joined the lane at -03: same isolation contract as the other two tables
    assert.equal(s.insertCandlesDeep("4h", "xyz:AAPL", mk(4 * HOUR, 6, 300)), 6, "4h rows land");
    assert.equal(s.readCandlesDeep("4h", "xyz:AAPL", base, base + 20 * DAY).length, 6);
    assert.equal(s.readCandlesDeep("12h", "xyz:AAPL", base, base + 20 * DAY).length, 10, "12h table untouched by 4h writes");
    // unknown interval: hard no on every verb — a typo must not create or read a series
    assert.equal(s.insertCandlesDeep("2h", "xyz:AAPL", mk(2 * HOUR, 3, 1)), 0, "unknown interval writes nothing");
    assert.deepEqual(s.readCandlesDeep("2h", "xyz:AAPL", 0, Date.now()), [], "unknown interval reads empty");
    assert.equal(s.candleCoverageDeep("2h", "xyz:AAPL").count, 0);
    // a bar with no timestamp/close is not a bar (same gate as the 5m/1m inserts)
    assert.equal(s.insertCandlesDeep("1d", "xyz:BAD", [[NaN, 1, 2, 0, 1, 5], [base, 1, 2, 0, NaN, 5]]), 0, "garbage rows are skipped, not coerced");
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test("store: deriv log roundtrip, flat-cutoff prune, and the symbol map survives atomically", async () => {
  const fs = require("fs"), os = require("os"), path = require("path");
  const { openStore } = require("../src/store");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "xyzdz-"));
  const s = openStore(dir);
  const Q = 15 * 60 * 1000;
  s.insertDeriv("BTC", 10 * Q, 1000, 500, 900000);
  s.insertDeriv("BTC", 11 * Q, 1100, 501, 900001);
  s.insertDeriv("ETH", 11 * Q, 50, 25, 80000);
  s.insertDeriv("BTC", 12 * Q, null, 502, null);   // partial buckets persist as blanks, not zeros
  s.flushDerivs();
  const m = s.loadDerivs(0);
  assert.equal(m.size, 2);
  assert.equal(m.get("BTC").length, 3);
  assert.deepEqual(m.get("BTC")[2], [12 * Q, null, 502, null], "nulls roundtrip as nulls — never invented zeros");
  assert.deepEqual(m.get("ETH")[0], [11 * Q, 50, 25, 80000]);
  // grown forming bucket re-persisted at the same ts: load must dedupe LAST-WINS, never duplicate
  s.insertDeriv("BTC", 12 * Q, 999, 502, 777777);
  s.flushDerivs();
  const md = s.loadDerivs(0);
  assert.equal(md.get("BTC").length, 3, "re-persisted boundary bucket must dedupe on load, not duplicate the ts");
  assert.deepEqual(md.get("BTC")[2], [12 * Q, 999, 502, 777777], "last write wins for a grown bucket");
  const removed = await s.pruneDerivs(11 * Q);
  assert.equal(removed, 1, "flat cutoff drops exactly the rows older than `before`");
  const m2 = s.loadDerivs(0);
  assert.equal(m2.get("BTC").length, 2);
  s.saveDerivMap({ ts: 123, map: { BTC: { sym: "BTCUSDT_PERP.A", venue: "Binance" } } });
  const dm = s.loadDerivMap();
  assert.equal(dm.ts, 123);
  assert.equal(dm.map.BTC.sym, "BTCUSDT_PERP.A");
  s.close();
});

test("store: flags.json round-trips, is written atomically, and an absent file is not an error", () => {
  const { openStore } = require("../src/store");
  const fs = require("fs"), path = require("path"), os = require("os");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "flags-"));
  try {
    const s = openStore(dir);
    assert.equal(s.loadFlags(), null, "no file yet is null, not a throw — first boot is the normal case");
    assert.equal(s.saveFlags({ signals: "admin" }), true);
    assert.deepEqual(s.loadFlags(), { signals: "admin" }, "round-trip");
    assert.ok(fs.existsSync(path.join(dir, "flags.json")));
    assert.ok(!fs.existsSync(path.join(dir, "flags.json.tmp")), "the temp file must be renamed away, never left behind");
    // Corrupt file degrades to defaults instead of taking the boot down with it.
    fs.writeFileSync(path.join(dir, "flags.json"), "{not json");
    assert.equal(s.loadFlags(), null, "unparseable flags file degrades to null");
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  // tmp+rename pinned in source: a plain writeFileSync here would let a crash mid-write reopen
  // whatever had been closed, silently, on the next boot.
  const st = fs.readFileSync(path.join(__dirname, "..", "src", "store.js"), "utf8");
  assert.ok(/saveFlags\(obj\)[\s\S]{0,320}flagsFile \+ "\.tmp"[\s\S]{0,220}renameSync/.test(st), "saveFlags must be tmp+rename atomic");
});

test("macro: store roundtrip — warm cache same contract as earnings", () => {
  const { openStore } = require("../src/store");
  const os = require("os"), path = require("path"), fs = require("fs");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "xyzmacro-"));
  const st = openStore(dir);
  assert.equal(st.loadMacro(), null, "cold store reads null, never throws");
  const data = { ts: 123, entries: [{ k: "FOMC", d: "2026-07-29", tEt: "14:00" }],
    stats: { CPI: { cur: { yoy: 2.6, m: "2026-06" }, prev: { yoy: 2.7, m: "2026-05" } } }, ids: [["CPI", 10]] };
  st.saveMacro(data);
  assert.deepEqual(st.loadMacro(), data);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("congress -27: CCITT is wrapped, not decoded, and the OCR queue is the scanned pile", async () => {
  // diag on the failing member: 18 images, CCITTFaxDecode, 2200x1696. Those bytes are not a file any
  // decoder opens — but CCITT is natively a TIFF compression scheme, and the OCR engine's libtiff
  // already speaks Group 4 (verified separately by feeding it a TIFF and getting exact text back).
  // So the strip is WRAPPED in a TIFF header rather than decoded. Writing a fax decoder to feed a
  // library that contains one would be work done twice.
  const { ccittTiff, pdfImages } = require("../src/compute");
  const img = { filter: "CCITTFaxDecode", data: Buffer.alloc(29000, 0x26), width: 2200, height: 1696,
    dict: "<< /Subtype /Image /Width 2200 /Height 1696 /BitsPerComponent 1 /Filter /CCITTFaxDecode"
      + " /DecodeParms << /K -1 /Columns 2200 /Rows 1696 /BlackIs1 false >> >>" };
  const tif = ccittTiff(img);
  assert.equal(tif.subarray(0, 2).toString("latin1"), "II", "a little-endian TIFF");
  assert.equal(tif.readUInt16LE(2), 42);
  const tags = {};
  const n = tif.readUInt16LE(8);
  for (let i = 0; i < n; i++) { const o = 10 + i * 12; tags[tif.readUInt16LE(o)] = tif.readUInt32LE(o + 8); }
  assert.equal(tags[256], 2200, "width comes from Columns");
  assert.equal(tags[257], 1696, "height from Rows");
  assert.equal(tags[258], 1, "one bit per sample — these are bilevel scans");
  assert.equal(tags[259], 4, "K < 0 is two-dimensional coding, which is Group 4");
  assert.equal(tags[262], 0, "fax is white-is-zero unless BlackIs1 says otherwise");
  assert.equal(tags[279], 29000, "and the strip is the raw CCITT payload, untouched");
  const g3 = ccittTiff(Object.assign({}, img, { dict: img.dict.replace("/K -1", "/K 0") }));
  assert.equal(g3.readUInt16LE(10 + 12 * Object.keys(tags).indexOf("259")) >= 0, true);
  const g3tags = {}; const n3 = g3.readUInt16LE(8);
  for (let i = 0; i < n3; i++) { const o = 10 + i * 12; g3tags[g3.readUInt16LE(o)] = g3.readUInt32LE(o + 8); }
  assert.equal(g3tags[259], 3, "K >= 0 is Group 3");
  const inv = ccittTiff(Object.assign({}, img, { dict: img.dict.replace("/BlackIs1 false", "/BlackIs1 true") }));
  const it = {}; const ni = inv.readUInt16LE(8);
  for (let i = 0; i < ni; i++) { const o = 10 + i * 12; it[inv.readUInt16LE(o)] = inv.readUInt32LE(o + 8); }
  assert.equal(it[262], 1, "BlackIs1 inverts the photometric sense rather than being ignored");
  assert.equal(ccittTiff({ filter: "DCTDecode", data: Buffer.alloc(10) }), null, "a JPEG needs no wrapper");

  // The OCR queue is the pile the text parser correctly gave up on, and a run must RESUME.
  const os2 = require("os"), fs = require("fs"), path = require("path");
  const { openStore } = require("../src/store");
  const dir = fs.mkdtempSync(path.join(os2.tmpdir(), "congressOcr-"));
  const store = openStore(dir);
  const F = (id, parsed, note) => ({ id, chamber: "H", docId: id.slice(2), yr: 2026, member: "M",
    lname: "M", fname: "", suffix: "", state: "CA", dist: "1", type: "ptr", typeRaw: "P",
    filed: "2026-08-20", url: "https://x/" + id.slice(2) + ".pdf", amends: null, parsed, nTx: null });
  store.congressUpsertFilings([F("H:6001", 2), F("H:6002", 1), F("H:6003", 0), F("H:6004", 2)]);
  assert.deepEqual(store.congressOcrQueue(10).map((r) => r.id).sort(), ["H:6001", "H:6004"],
    "only the scanned filings — not the ones that parsed, and not the ones still queued for text");
  store.congressNote("H:6001", "ocr-nothing-passed-validation:no candidate rows");
  assert.deepEqual(store.congressOcrQueue(10).map((r) => r.id), ["H:6004"],
    "and a filing OCR has already been tried on is not ground through again");
  fs.rmSync(dir, { recursive: true, force: true });
});

// The OI writer always emits four tab-separated fields and a trailing newline; the reader accepted
// three, so a crash mid-append loaded a truncated number as a real sample, and the prune re-emitted
// it with a newline.
test("audit -67: a torn last line in oi.log is never a sample, on load or through the prune", async () => {
  const fs = require("fs"), path = require("path"), os = require("os");
  const { openStore } = require("../src/store");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "xyz-oi-"));
  const now = Date.now();
  fs.writeFileSync(path.join(dir, "oi.log"),
    `xyz:AAPL\t${now - 3000}\t123456.7\t0.01\nxyz:AAPL\t${now - 2000}\t123500.2\t\nxyz:AAPL\t${now - 1000}\t12`);
  const st = openStore(dir);
  const m = st.loadAll(0);
  assert.deepEqual(m.get("xyz:AAPL").map((r) => r[1]), [123456.7, 123500.2], "the torn tail is dropped; an empty funding field is still a row");
  // A three-field row WITH a newline (already legitimised by an older prune) is dropped on load
  // and removed by the prune rather than carried forward.
  fs.writeFileSync(path.join(dir, "oi.log"), `xyz:AAPL\t${now - 3000}\t123456.7\t0.01\nxyz:AAPL\t${now - 2000}\t12\n`);
  assert.equal(openStore(dir).loadAll(0).get("xyz:AAPL").length, 1);
  await st.prune(0);
  assert.equal(fs.readFileSync(path.join(dir, "oi.log"), "utf8").split("\n").filter(Boolean).length, 1, "the prune drops the torn row");
  fs.writeFileSync(path.join(dir, "derivs.log"), `BTC\t${now - 1000}\t1\t2\t3\nBTC\t${now}\t1\t2`);
  assert.equal(openStore(dir).loadDerivs(0).get("BTC").length, 1, "derivs: same rule");
});

// loadAll read the whole year-long OI log with readFileSync+split (~3x the file in memory, on the
// event loop) at exactly the moment the healthcheck decides whether the deploy is alive. Boot now
// streams it (preloadOI) and loadAll hands the preloaded map over once.
test("audit -67: the OI log streams in at boot and loadAll serves the preloaded map once", async () => {
  const fs = require("fs"), path = require("path"), os = require("os");
  const { openStore } = require("../src/store");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "xyz-oi2-"));
  const now = Date.now(), rows = [];
  for (let i = 500; i > 0; i--) rows.push(`xyz:A\t${now - i * 60000}\t${1000 + i}\t0.0001`);
  rows.push(`xyz:B\t${now - 30000}\t7\t`);
  fs.writeFileSync(path.join(dir, "oi.log"), rows.join("\n") + "\nxyz:A\t" + now + "\t12");   // torn tail
  const st = openStore(dir);
  assert.equal(await st.preloadOI(), 501, "every whole row, never the torn one");
  const m = st.loadAll(now - 100 * 60000);
  assert.equal(m.get("xyz:A").length, 100, "the since filter still applies");
  assert.deepEqual(m.get("xyz:B"), [[now - 30000, 7, null]]);
  assert.ok(m.get("xyz:A").every((r, i, a) => i === 0 || a[i - 1][0] < r[0]), "ascending");
  // Consumed once: a second loadAll goes back to disk rather than holding two copies.
  assert.equal(st.loadAll(0).get("xyz:A").length, 500);
  // A file that ends cleanly keeps its last row.
  fs.writeFileSync(path.join(dir, "oi.log"), rows.join("\n") + "\n");
  assert.equal(await openStore(dir).preloadOI(), 501);
});

test("audit -67: config-grade files fsync, keep a .bak, and quarantine a corrupt copy instead of overwriting it", () => {
  const fs = require("fs"), path = require("path"), os = require("os");
  const { openStore } = require("../src/store");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "xyz-cfg-"));
  const st = openStore(dir);
  assert.equal(st.saveNotes([{ coin: "xyz:A", body: "thesis one" }]), true);
  assert.equal(st.saveNotes([{ coin: "xyz:A", body: "thesis two" }]), true);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dir, "notes.json.bak"), "utf8"))[0].body, "thesis one", "the previous version survives as .bak");
  fs.writeFileSync(path.join(dir, "notes.json"), "{ this is not json");
  const got = openStore(dir).loadNotes();
  assert.equal(got && got[0].body, "thesis one", "a corrupt file falls back to the .bak rather than reading as first boot");
  assert.ok(fs.readdirSync(dir).some((f) => /^notes\.json\.corrupt-\d+$/.test(f)), "and the corrupt copy is kept for forensics");
  assert.equal(fs.existsSync(path.join(dir, "notes.json")), false);
  for (const fn of ["saveRules", "saveBaskets", "saveLedger", "saveNotes"]) assert.ok(new RegExp(fn + "\\(data\\) \\{\\n\\s*try \\{ saveConfig\\(").test(fs.readFileSync(path.join(__dirname, "..", "src", "store.js"), "utf8")), fn + " goes through saveConfig");
  assert.ok(/fs\.fsyncSync\(fd\)/.test(fs.readFileSync(path.join(__dirname, "..", "src", "store.js"), "utf8")), "the data is fsynced before the rename");
});
