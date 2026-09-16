"use strict";
// sectors.js — classification tables. Split out of test.js (build 2026.09.16-80); order within the file is the original order.
const test = require("node:test");
const assert = require("node:assert");
const { classify, companyName } = require("./_shared");


test("classify: core equities map to GICS sectors", () => {
  assert.equal(classify("AAPL").sector, "Information Technology");
  assert.equal(classify("NVDA").sector, "Information Technology");
  assert.equal(classify("JPM").sector, "Financials");
  assert.equal(classify("LLY").sector, "Health Care");
  assert.equal(classify("TSLA").sector, "Consumer Discretionary");
});

test("companyName: canonical display name for the analyst context, null for unseeded", () => {
  assert.equal(companyName("NVDA"), "Nvidia");
  assert.equal(companyName("nvda"), "Nvidia");   // case-insensitive
  assert.equal(companyName("AMD"), "AMD");
  assert.equal(companyName("TSM"), "TSMC");
  assert.equal(companyName("ZZZZ"), null);        // unseeded -> ticker stays the label
  assert.equal(companyName(""), null);
  assert.equal(companyName(null), null);
});

test("classify: CL is WTI crude, not Colgate (collision regression)", () => {
  assert.equal(classify("CL").sector, "Commodity");
  assert.equal(classify("GOLD").sector, "Commodity");
  assert.equal(classify("NATGAS").sector, "Commodity");
});

test("classify: indices, ETFs, FX, crypto, commodities", () => {
  assert.equal(classify("SP500").sector, "Index");
  assert.equal(classify("XYZ100").sector, "Index");
  assert.equal(classify("EWY").assetClass, "ETF");
  assert.equal(classify("XLE").sector, "Energy");
  assert.equal(classify("SMH").sector, "Information Technology");
  assert.equal(classify("EURUSD").sector, "FX");
  assert.equal(classify("EUR").sector, "FX");   // bare currency
  assert.equal(classify("NOK").sector, "FX");   // krone (flagged: could be Nokia)
  assert.equal(classify("BTC").sector, "Crypto");
});

test("classify: dex-specific pre-IPO / thematic tickers", () => {
  // SPCX graduated 2026-06-12 (Nasdaq listing) — Equity now, and the label must NOT claim synthetic.
  assert.equal(classify("SPCX").assetClass, "Equity");
  assert.equal(classify("SPCX").sector, "Industrials");
  assert.equal(classify("ANDURIL").assetClass, "Pre-IPO");
  assert.equal(classify("ZHIPU").sector, "Information Technology");
  assert.equal(classify("STRC").sector, "Financials");
  assert.equal(classify("DRAM").sector, "Thematic");
});

test("classify: unknown ticker stays Unclassified (never guessed)", () => {
  assert.equal(classify("TOTALLYMADEUPXYZ").sector, "Unclassified");
  assert.equal(classify("").sector, "Unclassified");
});

test("classify: dex-prefixed coin resolves by ticker part", () => {
  const t = "SP500"; // caller strips the dex prefix; classify is given the ticker
  assert.equal(classify(t).sector, "Index");
});

// ===== display names + gated macro news lane (build 2026.07.28-03) =============================
// Two shipped changes, one test block. (1) A ticker now carries the instrument behind it, from a
// static label table. (2) The drawer's macro-tape fallback — previously "anything not an Equity
// gets the raw general tape", which put the identical five headlines in the EWZ drawer and the
// JPY drawer — is gated on per-instrument topics, server-side.

test("displayName: a label table, separate from the headline-alias table, null when unseeded", () => {
  const { displayName, companyName, DISPLAY_NAMES, CRYPTO_NAMES } = require("../src/sectors");
  assert.equal(displayName("EWZ"), "iShares MSCI Brazil ETF");
  assert.equal(displayName("ewz"), "iShares MSCI Brazil ETF", "case-insensitive");
  assert.equal(displayName("JPY"), "Japanese yen");
  assert.equal(displayName("CL"), "WTI crude oil", "the CL collision resolves to crude here too, not Colgate");
  assert.equal(displayName("BTC", "main"), "Bitcoin");
  assert.equal(displayName("BRK.B"), "Berkshire Hathaway (class B)");
  assert.equal(displayName("BRKB"), "Berkshire Hathaway (class B)", "the dot-stripped form resolves to the same name");
  // Unseeded is null, never a guess and never the ticker echoed back — the caller decides to omit.
  assert.equal(displayName("TOTALLYMADEUPXYZ"), null);
  assert.equal(displayName(""), null);
  assert.equal(displayName(null), null);
  assert.equal(displayName("EWZ", "main"), null, "an equity-universe label must not leak into a crypto lookup");
  assert.equal(displayName("NVDA", "main"), null);
  // The whole point of a separate table: COMPANY_NAMES holds MATCH FRAGMENTS tuned for substring
  // hits, and rendering those as labels would put "Procter" and "Snap " on screen. Pin the split.
  assert.equal(companyName("PG"), "Procter");
  assert.equal(displayName("PG"), "Procter & Gamble");
  assert.equal(companyName("SNAP"), "Snap ");
  assert.equal(displayName("SNAP"), "Snap Inc.");
  // No empty or whitespace-only labels in either table — an empty string renders an empty line.
  for (const [t, v] of Object.entries(DISPLAY_NAMES).concat(Object.entries(CRYPTO_NAMES)))
    assert.ok(typeof v === "string" && v.trim().length > 1, `display name for ${t} must be a real label`);
  // Pre-IPO synthetics must SAY they are synthetics — the label is where that disclosure lives.
  for (const t of ["OPENAI", "ANTHROPIC", "XAI", "ANDURIL", "RAMP"])
    assert.ok(/pre-IPO synthetic/.test(DISPLAY_NAMES[t]), `${t} label must disclose it is a synthetic`);
  // Graduated names must DROP the disclosure — a listed equity labeled "synthetic" is a lie in the other direction.
  assert.ok(!/pre-IPO synthetic/.test(DISPLAY_NAMES["SPCX"]), "SPCX graduated — label must not claim synthetic");
});

test("macroLane: scoped topics, broad tape, or no lane at all — never a bare fallback", () => {
  const { macroLane, MACRO_LANES } = require("../src/sectors");
  // The screenshot bug, both names: each now declares its own topics rather than sharing the tape.
  const ewz = macroLane("EWZ"), jpy = macroLane("JPY");
  assert.ok(ewz && ewz.topics.includes("Brazil") && ewz.label === "Brazil");
  assert.ok(jpy && jpy.topics.includes("yen") && jpy.label === "Japan");
  assert.ok(!ewz.topics.some((t) => jpy.topics.includes(t)), "the two lanes that produced the bug must not overlap at all");
  // Broad: the instrument IS the tape. Declared, not inferred from asset class.
  assert.equal(macroLane("SP500").broad, true);
  assert.equal(macroLane("VIX").broad, true);
  assert.equal(macroLane("DXY").broad, true);
  // An equity has no lane — that is what makes "no headlines" the honest equity answer.
  assert.equal(macroLane("NVDA"), null);
  assert.equal(macroLane("AAPL"), null);
  assert.equal(macroLane("BTC", "main"), null, "the crypto drawer has no news feed, so it gets no lane");
  // Shape invariant: broad lanes carry no topics, scoped lanes carry a label AND a non-empty list.
  for (const [t, L] of Object.entries(MACRO_LANES)) {
    if (L.broad) { assert.ok(!L.topics, `${t} is broad and must not also declare topics`); continue; }
    assert.ok(typeof L.label === "string" && L.label.length, `${t} scoped lane needs a label`);
    assert.ok(Array.isArray(L.topics) && L.topics.length, `${t} scoped lane needs topics`);
    for (const k of L.topics) assert.ok(typeof k === "string" && k.trim().length >= 2, `${t} topic "${k}" too short to gate on`);
  }
});

// ===== industry grouping layer (build 2026.07.28-04) ===========================================
// A curated industry table LAYERED on the GICS map: classify() now returns {assetClass, sector,
// ind}, the board wire ships `ind` only when it differs, and the Sectors tab re-cuts by one
// shared grouping key. These tests EXECUTE the real classifier (not string pins) and derive the
// table's integrity from the table itself.

test("-04 classify(): the industry layer rides on top of GICS, fallback ind===sector everywhere", () => {
  const S = require("../src/sectors");
  // The founding complaint: the memory complex, legible as its own group, GICS untouched.
  for (const t of ["SNDK", "SKHX", "MU", "KIOXIA", "WDC", "STX", "SMSN"]) {
    const c = S.classify(t);
    assert.equal(c.sector, "Information Technology", t + " keeps its GICS sector");
    assert.equal(c.ind, "Memory/Storage", t + " carries the Memory/Storage industry");
  }
  // Deliberate cross-GICS groups: the tape's grouping wins the industry, GICS keeps the sector.
  assert.deepEqual([S.classify("MSTR").sector, S.classify("MSTR").ind], ["Information Technology", "Crypto-Fi"]);
  assert.deepEqual([S.classify("COIN").sector, S.classify("COIN").ind], ["Financials", "Crypto-Fi"]);
  assert.equal(S.classify("AAPL").ind, "Mega Platforms");
  assert.equal(S.classify("AMZN").ind, "Mega Platforms", "Mega Platforms crosses into Cons Disc");
  // Thematic price indices join the trade they price.
  assert.equal(S.classify("DRAM").ind, "Memory/Storage");
  assert.equal(S.classify("DRAM").assetClass, "Thematic", "…without losing their asset class");
  // Pre-IPO synthetics carry industries too.
  assert.equal(S.classify("OPENAI").ind, "AI Software");
  assert.equal(S.classify("SPCX").ind, "Aero/Defense");
  // Fallbacks: an unsplit equity, an index, FX, a commodity, the unknown — ind ALWAYS === sector.
  for (const t of ["CAT", "SPX", "EURUSD", "XAU", "TOTALLYUNKNOWN"]) {
    const c = S.classify(t);
    assert.equal(c.ind, c.sector, t + ": no curated industry means ind falls back to sector, never undefined");
  }
  // Crypto main dex: its sub-sectors ARE the fine grouping; ind mirrors them exactly.
  for (const t of ["BTC", "PEPE", "NOSUCHCOIN"]) {
    const c = S.classify(t, "main");
    assert.equal(c.ind, c.sector, "main-dex ind mirrors the crypto sector for " + t);
  }
  // The one GICS correction in this build: Zoom moved to Info Tech (its post-2023 GICS home).
  assert.equal(S.classify("ZM").sector, "Information Technology", "ZM reclassified out of Comm Services");
  assert.equal(S.classify("ZM").ind, "Software");
});

test("-04 IND table integrity: derived from the table, not pinned to it", () => {
  const S = require("../src/sectors");
  const gics = new Set(Object.keys(S.SECTOR_TICKERS));
  const seen = new Map();
  for (const [ind, arr] of Object.entries(S.IND_TICKERS)) {
    // Group names must never collide with a GICS sector name or the sentinel: the client
    // detects fallback groups by name, and a collision would silently merge curated members
    // with fallback members under one label.
    assert.ok(!gics.has(ind) && ind !== "Unclassified", "industry name collides with a sector name: " + ind);
    for (const t of arr) {
      // One industry per ticker — a duplicate would make classification order-dependent.
      assert.ok(!seen.has(t), t + " appears in both '" + seen.get(t) + "' and '" + ind + "'");
      seen.set(t, ind);
      // Every entry must resolve through the real classifier to a known instrument that
      // actually carries this industry — no orphan rows pointing at nothing.
      const c = S.classify(t);
      assert.notEqual(c.assetClass, "Unclassified", "IND entry '" + t + "' classifies as Unclassified — orphan row");
      assert.equal(c.ind, ind, t + " must resolve to its own IND entry through classify()");
    }
  }
  // The founding split must be real: Info Tech's curated industries cover the mega-bucket's
  // heaviest names, so the sector lens is no longer the only lens.
  for (const t of ["NVDA", "MU", "MSFT", "PANW", "AMAT"]) {
    const c = S.classify(t);
    assert.notEqual(c.ind, c.sector, t + " must carry a curated industry distinct from Info Tech");
  }
});
