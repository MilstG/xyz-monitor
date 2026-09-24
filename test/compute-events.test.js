"use strict";
// compute.js — earnings, macro, focus, filings, brief/AI helpers. Split out of test.js (build 2026.09.16-80); order within the file is the original order.
const test = require("node:test");
const assert = require("node:assert");
const { median, DAY, C, f4Doc, F4_BUY, F4_DERIV, F4_PLANSELL, nakedStats, NAKED_HORIZONS, BRIEF_CTX, focusSelect, focusScore, focusGapSigma, focusLevelDist, fhStats, FOCUS_CAP, focusPreview, focusDiff, FOCUS_PREVIEW_N, foldLiveMark, focusLimits, focusFloorFail, focusGate, FOCUS_HARD_VOL, FOCUS_HARD_OI, FOCUS_BELOW_N, _mkPtrPdf, _encPdf } = require("./_shared");

test("US market calendar: holidays, observance shifts, early closes", () => {
  assert.equal(C.usDayStatus(2026, 7, 3), 2);    // Jul 4 2026 is a Saturday -> observed Friday, fully closed
  assert.equal(C.usDayStatus(2025, 7, 4), 2);    // Independence Day on a Friday
  assert.equal(C.usDayStatus(2025, 7, 3), 1);    // early close when Jul 4 falls Tue-Fri
  assert.equal(C.usDayStatus(2026, 11, 26), 2);  // Thanksgiving
  assert.equal(C.usDayStatus(2026, 11, 27), 1);  // Friday after: 13:00 ET close
  assert.equal(C.usDayStatus(2026, 4, 3), 2);    // Good Friday (computus)
  assert.equal(C.usDayStatus(2026, 7, 8), 0);    // ordinary Wednesday
});

test("earnings: earnEntryState splits reported vs upcoming on actual-present OR the ET session clock", () => {
  const C = require("../src/compute");
  const at = (iso) => new Date(iso).getTime();
  const noon = at("2026-07-23T18:00:00Z");    // 14:00 ET — a BMO release is out, the AMC close is not
  const evening = at("2026-07-23T22:00:00Z");  // 18:00 ET — after the AMC close (the bug's exact clock)
  const today = C.etDayStr(noon), yest = C.etDayStr(noon - 86400e3), tomo = C.etDayStr(noon + 86400e3);
  const S = C.earnEntryState;
  assert.equal(S({ d: today, s: "AMC", epsA: 0.42 }, noon), "reported", "actual present = reported even before the close");
  assert.equal(S({ d: today, s: "AMC", epsA: null }, noon), "upcoming", "AMC before 16:00 ET is still ahead");
  assert.equal(S({ d: today, s: "AMC", epsA: null }, evening), "reported", "AMC after the close is out — the screenshot fix, even with no actual yet");
  assert.equal(S({ d: today, s: "BMO", epsA: null }, noon), "reported", "BMO is out by the open");
  assert.equal(S({ d: today, s: "DMH", epsA: null }, noon), "upcoming");
  assert.equal(S({ d: today, s: "DMH", epsA: null }, evening), "reported", "DMH settles on the close threshold");
  assert.equal(S({ d: today, s: "TBD", epsA: null }, evening), "upcoming", "TBD same-day has no clock to trust — actual-present only");
  assert.equal(S({ d: yest, s: "TBD", epsA: null }, noon), "reported", "any prior ET day is unconditionally past");
  assert.equal(S({ d: tomo, s: "AMC", epsA: null }, noon), "upcoming", "any future ET day is ahead");
  assert.equal(S(null, noon), "upcoming", "a malformed entry never fabricates a reported state");
});

test("earnings: ET day string is the ET calendar day, not UTC or local (DST both sides)", () => {
  const { etDayStr } = require("../src/compute");
  // July = EDT (UTC-4): 02:00Z is still 22:00 the PREVIOUS day in New York.
  assert.equal(etDayStr(Date.UTC(2026, 6, 13, 2, 0)), "2026-07-12", "late-UTC evening rolls back to the prior ET day");
  assert.equal(etDayStr(Date.UTC(2026, 6, 13, 12, 0)), "2026-07-13", "midday UTC is the same ET day");
  assert.equal(etDayStr(Date.UTC(2026, 6, 13, 3, 59)), "2026-07-12", "23:59 ET is still the old day");
  assert.equal(etDayStr(Date.UTC(2026, 6, 13, 4, 0)), "2026-07-13", "00:00 ET flips the day at exactly UTC-4");
  // January = EST (UTC-5): the flip moves to 05:00Z — the helper must track the offset, not hardcode it.
  assert.equal(etDayStr(Date.UTC(2026, 0, 10, 4, 59)), "2026-01-09", "EST: 04:59Z is 23:59 ET the prior day");
  assert.equal(etDayStr(Date.UTC(2026, 0, 10, 5, 0)), "2026-01-10", "EST: day flips at 05:00Z");
});

test("earnings: day distance is whole ET days — 0 today, 1 tomorrow, negative past, garbage null", () => {
  const { earnDayDiff } = require("../src/compute");
  const noon = Date.UTC(2026, 6, 13, 16, 0);   // 12:00 ET, Mon Jul 13
  assert.equal(earnDayDiff("2026-07-13", noon), 0, "report today");
  assert.equal(earnDayDiff("2026-07-14", noon), 1, "report tomorrow");
  assert.equal(earnDayDiff("2026-07-12", noon), -1, "yesterday's report is past, never re-flagged");
  assert.equal(earnDayDiff("2026-07-27", noon), 14, "window edge");
  // The trap this exists to avoid: at 22:00 ET Sunday it is already Monday in UTC — a report
  // dated Monday must read as TOMORROW (diff 1), not today.
  const lateSun = Date.UTC(2026, 6, 13, 2, 0);   // 22:00 ET Sun Jul 12
  assert.equal(earnDayDiff("2026-07-13", lateSun), 1, "UTC has rolled over but ET has not");
  assert.equal(earnDayDiff("garbage", noon), null);
  assert.equal(earnDayDiff("2026-7-13", noon), null, "malformed date is rejected, not misparsed");
});

test("earnings: feed parse filters to OUR symbols, applies aliases, normalizes sessions, sorts", () => {
  const { parseEarningsCalendar } = require("../src/compute");
  const symMap = new Map([
    ["NVDA", { coin: "xyz:NVDA", ticker: "NVDA" }],
    ["JPM", { coin: "xyz:JPM", ticker: "JPM" }],
    ["BRK.B", { coin: "xyz:BRKB", ticker: "BRKB" }],   // alias applied by the caller: feed symbol -> our row
  ]);
  const feed = { earningsCalendar: [
    { symbol: "JPM", date: "2026-07-14", hour: "bmo", epsEstimate: 4.1123 },
    { symbol: "NVDA", date: "2026-07-14", hour: "amc", epsEstimate: 5.62 },
    { symbol: "brk.b", date: "2026-07-14", hour: "", epsEstimate: null },        // lowercase symbol, unknown session
    { symbol: "ZZZZ", date: "2026-07-14", hour: "bmo", epsEstimate: 1 },          // not in universe -> dropped
    { symbol: "NVDA", date: "2026-07-13", hour: "dmh", epsEstimate: 3 },          // earlier date sorts first
    { symbol: "JPM", date: "14-07-2026", hour: "bmo" },                            // malformed date -> dropped
    { symbol: 42, date: "2026-07-14" }, null,                                      // garbage rows tolerated
  ] };
  const out = parseEarningsCalendar(feed, symMap);
  assert.equal(out.length, 4, "universe filter + malformed rows dropped");
  assert.deepEqual(out.map((e) => e.t), ["NVDA", "JPM", "NVDA", "BRKB"], "sorted by date, then BMO < DMH < AMC < TBD within a day");
  assert.equal(out[0].s, "DMH");
  assert.equal(out[1].s, "BMO");
  assert.equal(out[2].s, "AMC");
  assert.equal(out[3].s, "TBD", "unknown hour is TBD, never guessed");
  assert.equal(out[3].coin, "xyz:BRKB", "BRK.B report lands on the BRKB row");
  assert.equal(out[1].eps, 4.1123, "EPS estimate keeps 4dp — 2dp collapsed real beat/miss margins");
  assert.equal(out[3].eps, null, "missing estimate stays null");
  assert.deepEqual(parseEarningsCalendar({}, symMap), [], "missing calendar array is empty, not a throw");
});

test("earnings: parser carries actuals and revenue for beat/miss", () => {
  const { parseEarningsCalendar } = require("../src/compute");
  const symMap = new Map([["NVDA", { coin: "xyz:NVDA", ticker: "NVDA" }]]);
  const out = parseEarningsCalendar({ earningsCalendar: [
    { symbol: "NVDA", date: "2026-07-13", hour: "amc", epsEstimate: 5.6234, epsActual: 5.712, revenueEstimate: 41234000000, revenueActual: 42891000000, quarter: 2, year: 2026 },
    { symbol: "NVDA", date: "2026-10-14", hour: "amc", epsEstimate: 6.1 },
  ] }, symMap);
  assert.equal(out[0].epsA, 5.712, "actual keeps 4dp");
  assert.equal(out[0].rev, 41200000000, "revenue estimate at 3 significant figures");
  assert.equal(out[0].revA, 42900000000);
  assert.equal(out[0].q, 2, "fiscal quarter captured — the reschedule discriminator");
  assert.equal(out[0].y, 2026);
  assert.equal(out[1].epsA, null, "future print has no actual — null, never 0");
  assert.equal(out[1].rev, null);
  assert.equal(out[1].q, null, "missing quarter is unknown, never guessed");
});

test("earnings: epsActual 0 is a feed placeholder — null, never a fabricated verdict", () => {
  const { parseEarningsCalendar, scrubPlaceholderActuals, earnEntryState } = require("../src/compute");
  const symMap = new Map([["AMD", { coin: "xyz:AMD", ticker: "AMD" }], ["SPCX", { coin: "xyz:SPCX", ticker: "SPCX" }]]);
  // The live 2026-08-04 shape: report-day rows with epsActual:0 before the real number lands.
  const out = parseEarningsCalendar({ earningsCalendar: [
    { symbol: "AMD", date: "2026-08-04", hour: "amc", epsEstimate: 1.63, epsActual: 0 },
    { symbol: "SPCX", date: "2026-08-04", hour: "amc", epsEstimate: -0.26, epsActual: 0 },
    { symbol: "AMD", date: "2026-05-05", hour: "amc", epsEstimate: 0, epsActual: 1.37 },
  ] }, symMap);
  const amd = out.find((e) => e.t === "AMD" && e.d === "2026-08-04");
  const spcx = out.find((e) => e.t === "SPCX");
  const est0 = out.find((e) => e.d === "2026-05-05");
  assert.equal(amd.epsA, null, "AMD 0.00 actual is a placeholder, not a 0.00-vs-1.63 miss");
  assert.equal(spcx.epsA, null, "SPCX 0.00 actual is a placeholder, not a 0.00-vs--0.26 beat");
  assert.equal(est0.eps, 0, "a 0.00 ESTIMATE survives — plausible and verdict-safe");
  assert.equal(est0.epsA, 1.37, "nonzero actuals untouched");
  assert.equal(earnEntryState(amd, Date.UTC(2026, 7, 4, 16, 0)), "upcoming",
    "placeholder actual no longer flips report-day AMC to reported before the close");
  // Retroactive scrub for pre-fix persisted prints (merge can never blank an actual itself).
  const scrubbed = scrubPlaceholderActuals([
    { t: "AMD", d: "2026-08-04", s: "AMC", eps: 1.63, epsA: 0 },
    { t: "NVDA", d: "2026-07-13", s: "AMC", eps: 5.6234, epsA: 5.712 },
    null,
  ]);
  assert.equal(scrubbed[0].epsA, null, "persisted placeholder zero scrubbed at hydrate");
  assert.equal(scrubbed[0].eps, 1.63, "other fields untouched");
  assert.equal(scrubbed[1].epsA, 5.712, "real actuals never touched");
  assert.equal(scrubPlaceholderActuals(null).length, 0, "malformed input is empty, not a throw");
});

test("earnings: print merge dedupes, upgrades in place with actuals, never blanks them", () => {
  const { mergeEarnPrints } = require("../src/compute");
  const now = Date.UTC(2026, 6, 13);
  const prev = [
    { coin: "xyz:NVDA", t: "NVDA", d: "2026-04-15", s: "AMC", eps: 5.2, epsA: 5.44 },
    { coin: "xyz:JPM", t: "JPM", d: "2026-04-11", s: "TBD", eps: 4.0, epsA: null },
    { coin: "xyz:OLD", t: "OLD", d: "2022-01-01", s: "BMO", eps: 1, epsA: 1 },      // beyond retention -> dropped
  ];
  const incoming = [
    { coin: "xyz:NVDA", t: "NVDA", d: "2026-04-15", s: "AMC", eps: 5.2, epsA: null },   // re-fetch WITHOUT actual — must not blank it
    { coin: "xyz:JPM", t: "JPM", d: "2026-04-11", s: "BMO", eps: 4.0, epsA: 4.3 },      // actual arrives + session firms up from TBD
    { coin: "xyz:JPM", t: "JPM", d: "2026-07-14", s: "BMO", eps: 4.11, epsA: null },     // new print
  ];
  const out = mergeEarnPrints(prev, incoming, now);
  assert.equal(out.length, 3, "deduped by ticker+date, retention applied");
  const nv = out.find((p) => p.t === "NVDA");
  assert.equal(nv.epsA, 5.44, "stored actual survives a later fetch that lacks it");
  const jp = out.find((p) => p.t === "JPM" && p.d === "2026-04-11");
  assert.equal(jp.epsA, 4.3, "actual upgrades in place");
  assert.equal(jp.s, "BMO", "TBD session firms up when a later fetch knows it");
  assert.ok(out[0].d <= out[1].d && out[1].d <= out[2].d, "date-sorted ascending");
  // quarter/year upgrade in place, never blanked by a later fetch that lacks them
  const q1 = mergeEarnPrints([{ coin: "c", t: "T", d: "2026-04-15", s: "AMC", q: 1, y: 2026 }],
    [{ coin: "c", t: "T", d: "2026-04-15", s: "AMC", epsA: 2 }], now);
  assert.equal(q1[0].q, 1, "stored quarter survives a later fetch without it");
  assert.equal(q1[0].epsA, 2, "while the actual still lands");
});

test("earnings: reaction study — print day's own bar for BMO and AMC, expansion, gaps, honest gaps in coverage", () => {
  const { earnReactionsFor } = require("../src/compute");
  // 60 daily candles, 1%-magnitude alternating base tape, UTC-day timestamps
  const day0 = Date.UTC(2026, 3, 1);   // Apr 1 2026
  const daily = [];
  let px = 100;
  for (let i = 0; i < 60; i++) {
    const prev = px;
    px = i === 30 ? px * 1.08                      // print-day pop: +8% on Apr 31? -> May 1 candle (i=30)
       : i === 45 ? px * 0.95                      // second print: -5% inside the AMC print day's own bar (see below)
       : px * (i % 2 ? 1.01 : 0.99);               // ordinary tape: |1%| alternating
    daily.push({ t: day0 + i * DAY, o: prev * (i === 30 ? 1.05 : 1.0), c: px });
  }
  const dstr = (i) => { const x = new Date(day0 + i * DAY); return x.toISOString().slice(0, 10); };
  // Re-baselined (AMC timing fix): a 16:05 ET AMC print falls INSIDE its own UTC-day bar (which
  // closes 00:00Z, hours later), so the reaction bar is the print day's bar for BOTH sessions and
  // the reference is the bar before. The old convention dated the AMC print one day EARLIER than
  // its reaction bar, i.e. measured from a reference close taken after the print.
  const prints = [
    { t: "NVDA", d: dstr(30), s: "BMO" },   // BMO: reaction = candle 30 itself (+8%), gap +5% held
    { t: "NVDA", d: dstr(45), s: "AMC" },   // AMC: reaction = candle 45 itself (-5%) vs candle 44's close
    { t: "NVDA", d: "2019-01-01", s: "BMO" },   // predates the window -> skipped, not fabricated
  ];
  const st = earnReactionsFor(prints, daily);
  assert.equal(st.n, 2, "only prints matched to retained candles count");
  assert.equal(st.up, 1, "one up reaction, one down");
  assert.ok(st.avgAbs > 6 && st.avgAbs < 7, `avg |move| ~6.5, got ${st.avgAbs}`);
  assert.ok(st.xMed > 4, `both reactions are multiples of the ~1% base tape, got ${st.xMed}x`);
  // (re-pinned -106) the daily open is NOT a gap: a 24/7 perp's 00:00Z open is the prior 00:00Z
  // close. Gaps are cash-session gaps read intraday only; with no intraday data both timed prints
  // are excluded and counted (gap n=0 of 2), never approximated from these opens.
  assert.equal(st.gapN, 0, "no intraday anchors -> no gap claims");
  assert.equal(st.gapOf, 2, "…but the excluded timed prints are counted");
  assert.equal(st.dailyN, 2, "both reactions came off session-bar closes (the labelled fallback)");
  // closes-only candles (warm cache shape): move stats compute, gap stats honestly absent
  const co = daily.map((k) => ({ t: k.t, c: k.c }));
  const st2 = earnReactionsFor(prints, co);
  assert.equal(st2.n, 2);
  assert.equal(st2.gapN, 0, "no opens -> no gap claims");
  assert.equal(earnReactionsFor([], daily), null, "no prints -> null, not zeros");
});

test("earnings: chunked calendar windows are disjoint, covering, near-first — the truncation fix", () => {
  const { earnChunks, etDayStr } = require("../src/compute");
  const now = Date.UTC(2026, 6, 16, 16, 0);   // Thu Jul 16 noon ET
  const ch = earnChunks(now - 5 * DAY, now + 14 * DAY, 3);
  assert.equal(ch[0][0], "2026-07-11", "coverage starts 5 days back");
  assert.equal(ch[ch.length - 1][1], "2026-07-30", "coverage ends at the window edge");
  // every ET day in [from, to] falls inside exactly one chunk — no gap can silently drop a
  // report date, no overlap can double-count (dedupe guards DST-edge overlap anyway)
  for (let d = -5; d <= 14; d++) {
    const day = etDayStr(now + d * DAY);
    const hits = ch.filter(([f, t]) => f <= day && day <= t).length;
    assert.equal(hits, 1, `ET day ${day} covered exactly once, got ${hits}`);
  }
  assert.ok(ch[0][1] < ch[1][0], "chunks ordered near-first and disjoint");
  assert.ok(ch.every(([f, t]) => f <= t), "no inverted chunk");
  assert.deepEqual(earnChunks(now, now, 3), [[etDayStr(now), etDayStr(now)]], "single-day window is one single-day chunk");
});

test("insiders: Form 4 numbers survive the parser exactly, and every absence stays an absence", () => {
  const C = require("../src/compute");
  const p = C.parseForm4(f4Doc(F4_BUY + F4_PLANSELL, { deriv: F4_DERIV }));
  assert.ok(p.ok, "an ownership document parses");
  assert.equal(p.issuer.tk, "INTC", "the symbol is read off the form, never resolved from a name");
  assert.equal(p.owner.name, "Tan Lip-Bu");
  assert.equal(p.owner.role, "director · officer", "every relationship box ticked on the form is kept");
  assert.equal(p.owner.title, "Chief Executive Officer", "a CEO buying is not the same event as a 10% fund trimming — the title decides");

  const [buy, sell] = p.tx;
  // The whole reason this lane beats the congress one: exact figures, not a band.
  assert.equal(buy.code, "P"); assert.equal(buy.act, "buy");
  assert.equal(buy.shares, 500000, "share count exact");
  assert.equal(buy.price, 20, "price per share exact");
  assert.equal(buy.value, 10000000, "value is shares x price, computed only because a price exists");
  assert.equal(buy.txDate, "2026-08-25"); assert.equal(buy.own, 1500000); assert.equal(buy.dir, "D");
  assert.equal(sell.shares, 12500, "a thousands separator on the form is not a parse failure");
  // A footnoted price is the form declining to state one. Zero would be a lie that then feeds a
  // value, a size filter and a sort.
  assert.equal(sell.price, null, "a footnoted price is ABSENT, never zero");
  assert.equal(sell.value, null, "no price means no value — not a $0 trade");
  assert.equal(p.nDeriv, 1, "derivative rows are counted per filing");
  assert.equal(p.tx.length, 3, "...and PARSED: both of the form's tables are read, not just Table I");
  assert.deepEqual(p.tx.map((t) => t.kind), ["S", "S", "D"], "every row says which table it came from");
  const dv = p.tx[2];
  // The reason Table II was excluded at first, now handled by keeping the quantities APART rather
  // than dropping the rows: an exercise price and a transaction price are identically-shaped
  // fields holding different things.
  assert.equal(dv.strike, 12.04, "the exercise price is read...");
  assert.equal(dv.price, null, "...and never lands in the share-price column");
  assert.equal(dv.value, null, "a derivative row has no dollar value: shares x strike is a number nobody paid");
  assert.equal(dv.expiry, "2032-09-14", "expiry rides along — an exercise weeks before it lapses is mechanical");
  assert.equal(dv.under, "Common Stock \u00d7 5191", "what it converts into, and at what ratio");
  assert.equal(dv.code, "M"); assert.equal(dv.act, "exercise");
  assert.equal(dv.shares, 5191);

  // The 10b5-1 box is TRI-state, and the flag belongs to the transaction that carries it. The
  // first cut fell back to the document for every row, which marked this same insider's
  // open-market PURCHASE as plan-scheduled — inverting the one distinction the field exists for.
  assert.equal(sell.plan, 1, "the sale's own box is read");
  assert.equal(buy.plan, null, "the sale's flag must NOT leak onto the purchase");
  assert.equal(C.parseForm4(f4Doc(F4_BUY)).tx[0].plan, null, "no box at all is null — 'the form does not say', never 'not a plan'");
  assert.equal(C.parseForm4(f4Doc(F4_PLANSELL)).tx[0].plan, 1, "a single-transaction filing can carry the flag at document level");
  assert.equal(C.parseForm4(f4Doc(F4_BUY.replace("<transactionCode>P</transactionCode>",
    "<transactionCode>P</transactionCode><aff10b5One><value>0</value></aff10b5One>"))).tx[0].plan, 0,
    "an explicitly UNticked box is 0 — a different answer from absent");

  // A joint filing reports ONE set of transactions for several people.
  const joint = C.parseForm4(f4Doc(F4_BUY, { owners:
    `<reportingOwner><reportingOwnerId><rptOwnerName>A Person</rptOwnerName></reportingOwnerId><reportingOwnerRelationship><isDirector>1</isDirector></reportingOwnerRelationship></reportingOwner>`
    + `<reportingOwner><reportingOwnerId><rptOwnerName>B Person</rptOwnerName></reportingOwnerId><reportingOwnerRelationship><isTenPercentOwner>1</isTenPercentOwner></reportingOwnerRelationship></reportingOwner>` }));
  assert.equal(joint.tx.length, 1, "one trade stays one row — attributing it per filer would multiply the flow");
  assert.equal(joint.owners.length, 2, "...and the other filers are kept, so the joint filing is visible");
  assert.equal(joint.owner.name, "A Person");
  assert.equal(joint.owners[1].role, "10% owner");

  assert.ok(C.parseForm4(f4Doc(F4_BUY, { form: "4/A" })).amended, "an amendment knows it is one");
  assert.equal(C.parseForm4("<html>not a filing</html>").ok, false, "a non-filing is refused, never half-read");
  assert.deepEqual(C.parseForm4("").tx, [], "empty input yields no transactions, not a throw");
  // The RAW document, not EDGAR's stylesheet-wrapped copy: taking the rendered one works by
  // accident until the transform path changes.
  assert.equal(C.form4DocName({ directory: { item: [{ name: "xslF345X05/wf-form4.xml" }, { name: "wf-form4.xml" }, { name: "primary.htm" }] } }),
    "wf-form4.xml", "the raw ownership xml is chosen by name");
  assert.equal(C.form4DocName({ directory: { item: [{ name: "a.htm" }] } }), null, "an accession with no xml says so");

  // "NONE" is not a ticker. It is what a filer writes when the issuer has no trading symbol, and
  // an early build stored it: the live tab carried rows for a company called NONE (Blackstone
  // entities filing as 10% owners of non-traded funds, reaching this lane through a roster name's
  // own submissions feed). Same doctrine as the earnings feed's epsActual:0 placeholder.
  for (const v of ["NONE", "none", "N/A", "n/a", "NA", "-", "--", "NULL", "Not Applicable", "", "   "])
    assert.equal(C.f4Symbol(v), null, JSON.stringify(v) + " is a placeholder, not a symbol");
  assert.equal(C.f4Symbol("Blackstone Private Multi-Asset Credit and Income Fund"), null,
    "prose typed into the symbol box is not a symbol either");
  assert.equal(C.f4Symbol(" intc "), "INTC", "a real symbol survives, trimmed and cased");
  assert.equal(C.f4Symbol("BRK.B"), "BRK.B", "...dots and dashes included");
  assert.equal(C.f4Symbol("RDS-A"), "RDS-A");
  const noSym = C.parseForm4(f4Doc(F4_BUY).replace("<issuerTradingSymbol>INTC</issuerTradingSymbol>", "<issuerTradingSymbol>NONE</issuerTradingSymbol>"));
  assert.equal(noSym.issuer.tk, null, "and the placeholder never leaves the parser as a ticker");
});

test("anatomy -11: nakedStats revisits are exact and truncated horizons report null, never partial counts", () => {
  const DAY = 864e5;
  const rec = [
    { t: 0 * DAY, o: 100, h: 105, l: 99 },
    { t: 1 * DAY, o: 104, h: 106, l: 101 },   // does NOT reach 100
    { t: 2 * DAY, o: 105, h: 107, l: 103 },
    { t: 3 * DAY, o: 106, h: 108, l: 99.5 },  // reaches 100 -> anchor 0 revisited at lag 3
    { t: 4 * DAY, o: 107, h: 109, l: 106 },
  ];
  const nk = nakedStats(rec);
  assert.equal(nk[0].rev[1], false, "not revisited next session");
  assert.equal(nk[0].rev[3], true, "revisited within 3");
  assert.equal(nk[0].rev[5], null, "5-session horizon lacks full forward coverage -> null, not a hopeful partial");
  assert.equal(nk[4].rev[1], null, "the last anchor has no forward sessions at any horizon");
  assert.deepEqual(NAKED_HORIZONS, [1, 3, 5, 10], "horizon ladder pinned");
});

test("brief: renderer ships two messages, omits every block whose data is absent, never fakes one", () => {
  const C = require("../src/compute");
  const full = BRIEF_CTX();
  const r = C.renderBrief(full, { story: "Semis carried it.", closing: "Nothing is resolved." });
  assert.equal(r.messages.length, 2, "market first, calendar and conclusions second");
  assert.ok(/MORNING BRIEF/.test(r.messages[0]) && /THE STORY/.test(r.messages[0]));
  for (const h of ["INDICES", "SECTORS", "MOVERS", "REGIME"]) assert.ok(r.messages[0].includes(h), `missing block: ${h}`);
  for (const h of ["POSITIONING", "EARNINGS", "MACRO", "WHAT MATTERED", "FINAL THOUGHTS"]) assert.ok(r.messages[1].includes(h), `missing block: ${h}`);
  assert.ok(!/FILINGS/i.test(r.messages.join("")), "filings are deliberately not in the brief");
  // A server with no FRED key, no listed index and no news must not emit empty headings.
  const bare = Object.assign(BRIEF_CTX(), { indices: [], commodities: [], fx: [], baskets: [], news: [],
    macro: { next: [], rates: [], data: [] }, earnings: { printed: [], today: [], tomorrow: [] } });
  const rb = C.renderBrief(bare, null);
  const txt = rb.messages.join("\n");
  for (const h of ["INDICES", "MACRO", "WHAT MATTERED", "EARNINGS"]) assert.ok(!txt.includes(h), `absent data must drop its heading, not print it empty: ${h}`);
  assert.ok(!/THE STORY|FINAL THOUGHTS/.test(txt), "no prose sections when the model produced none");
  assert.ok(/MOVERS/.test(txt), "the mechanical brief still ships without the model");
});

test("brief: VIX renders as a level, everything else as a signed percentage", () => {
  const C = require("../src/compute");
  const ctx = Object.assign(BRIEF_CTX(), { indices: [{ t: "SPX", d1: 0.4 }, { t: "VIX", px: 14.23, d1: -0.8, level: 1 }] });
  const m = C.renderBrief(ctx, null).messages[0];
  const rows = (m.match(/<code>[^<]*<\/code>/g) || []).map((x) => x.replace(/<\/?code>/g, "").replace(/\u2007/g, " "));
  assert.ok(rows.some((r) => /VIX\s+14\.2\b/.test(r)), "a volatility index is a level; a % move reads as a price change");
  assert.ok(rows.some((r) => /SPX\s+\+0\.4/.test(r)));
  assert.ok(m.includes("<code>") && !m.includes("<pre>"), "monospace via <code>, never <pre>");
  assert.ok(!/[\u2591\u2592\u2593]/.test(m), "shade glyphs are not in every device font");
});

test("brief: the budget ladder keeps a pathological day inside Telegram's ceiling", () => {
  const C = require("../src/compute");
  const big = BRIEF_CTX();
  // A heavy day: every block at maximum, prose at its full allowance.
  big.news = ["Semis", "Energy", "Financials", "Health"].map((sector) => ({ sector,
    items: [0, 1, 2].map((i) => ({ t: "AAA", h: "A materially long headline about something that happened " + i + " " + "x".repeat(50) })) }));
  big.sectors = big.sectors.concat([...Array(8)].map((_, i) => ({ name: "SEC" + i, label: "Sector " + i, med: -i, n: 5, up: 20 })));
  const prose = { story: ("A ".repeat(1600)).trim(), closing: ("B ".repeat(1400)).trim() };
  const r = C.renderBrief(big, prose);
  for (const m of r.messages) assert.ok(C.briefVisibleLen(m) <= C.BRIEF_TG_LIMIT,
    `over the ceiling at ${C.briefVisibleLen(m)} \u2014 Telegram hard-fails the send, it does not truncate`);
  assert.ok(r.dropped.length, "a day this heavy must record which ladder steps fired");
  // Prose is the least compressible thing in the message: the ladder must exhaust every mechanical
  // block before it touches either written section.
  const mech = C.BRIEF_LADDER.findIndex((x) => x.sec === "story" || x.sec === "closing");
  for (let i = 0; i < mech; i++) assert.ok(!["story", "closing"].includes(C.BRIEF_LADDER[i].sec), "prose must sacrifice last");
});

test("brief: the ladder is measured on ENTITY-PARSED length, so markup is free", () => {
  const C = require("../src/compute");
  assert.equal(C.briefVisibleLen("<b>abc</b>"), 3, "tags do not count against Telegram's limit");
  assert.equal(C.briefVisibleLen("plain"), 5);
  // Guard the real failure this prevents: a brief that fits, refused because we measured the markup.
  const heavy = "<b>x</b>".repeat(400);
  assert.ok(C.briefVisibleLen(heavy) < heavy.length / 2);
});

test("brief validator: rejects invented numbers, unlisted names, advice and markup; passes grounded prose", () => {
  const C = require("../src/compute");
  const ctx = BRIEF_CTX();
  const good = { story: "Breadth closed at 48% while the index added 0.4%, and ten of the fourteen movers were semis.",
    closing: "TECH is carrying it. Nothing is resolved until the print." };
  assert.ok(C.validateBriefProse(good, ctx).ok, "grounded prose must pass: " + JSON.stringify(C.validateBriefProse(good, ctx)));
  const bad = (o) => C.validateBriefProse(Object.assign({ story: "Breadth closed at 48%.", closing: "Nothing is resolved." }, o), ctx);
  assert.match(bad({ story: "The 10-year sits at 7.77% this morning." }).error, /number not in context/);
  assert.match(bad({ closing: "PLTR is the tell here." }).error, /name not in context/);
  assert.match(bad({ closing: "You should buy the dip in semis." }).error, /directional instruction/);
  // 2026.08.03-01: the U.S/EV screenshots — a dotted "U.S." tokenizes as "U.S" and must resolve
  // through the dot-stripped whitelist form; "EV" is ordinary market prose. Either one previously
  // discarded the ENTIRE commentary and the reader got a warning line instead of a brief.
  assert.ok(C.validateBriefProse({ story: "The U.S. tape leaned risk-off while EV names lagged.",
    closing: "Nothing is resolved." }, ctx).ok, "U.S. and EV are prose, not fabricated instruments");
  assert.equal(typeof C.briefNameOk, "function", "normalized name check exported");
  assert.ok(C.briefNameOk("U.S", new Set()) && C.briefNameOk("U.K", new Set()) && C.briefNameOk("EV", new Set()));
  assert.ok(!C.briefNameOk("ZZZZ", new Set()), "a genuinely unknown name still rejects — the gate is normalized, not disarmed");
  assert.match(C.validateBriefProse({ story: "Breadth closed at 48%.", closing: "QQQQ is the tell here." }, ctx).error,
    /name not in context/, "fabricated tickers still die at the gate after the U.S/EV fix");
  assert.match(bad({ story: "Breadth <b>48%</b>." }).error, /markup/);
  assert.match(bad({ closing: "" }).error, /closing missing/);
  assert.match(bad({ story: "x".repeat(C.BRIEF_PROSE_MAX.story + 1) }).error, /over budget/);
  // Small counts are prose, not claims — a model writing "four sessions running" is doing its job.
  assert.ok(C.validateBriefProse({ story: "Four sessions running, eight of eleven sectors closed red.",
    closing: "Nothing is resolved." }, ctx).ok, "spelled-out and small counts must not trip the numeric gate");
});

test("prose salvage 2026.08.03-01: one bad token costs the sentence, never the commentary", () => {
  const C = require("../src/compute");
  const ctx = BRIEF_CTX();
  // The proportionality complaint: three clean sentences must survive one fabricated name.
  const s = C.briefSalvageProse(
    "Breadth closed soft. QQQQ led the tape lower. Semis carried what strength there was.\n\nNothing else moved.", ctx);
  assert.equal(s.cut, 1, "exactly the offending sentence is cut");
  assert.ok(!/QQQQ/.test(s.text) && /Breadth closed soft/.test(s.text) && /Semis carried/.test(s.text)
    && /Nothing else moved/.test(s.text), "every clean sentence survives, in place");
  assert.match(s.why, /name not in context: QQQQ/, "the cut is attributable, not silent");
  // Salvaged output must pass the SAME validator that rejected the original — one code path.
  assert.ok(C.validateBriefProse({ story: s.text, closing: "Nothing is resolved." }, ctx).ok,
    "salvage and validation judge by the identical gate");
  // Invented figures ride the same rung.
  const n = C.briefSalvageProse("The tape held. Inflation ran 7.77 percent. Risk stayed on.", ctx);
  assert.equal(n.cut, 1); assert.match(n.why, /number not in context/);
  // Advice is NOT salvageable — a misbehaving model still hard-fails, per-sentence mercy is for
  // vocabulary misses only. briefTextViolation carries no advice gate; the validator's does.
  assert.match(C.validateBriefProse({ story: "You should buy the dip.", closing: "x" }, ctx).error,
    /directional instruction/);
  assert.equal(typeof C.briefTextViolation, "function", "shared gate exported");
  // Landscape renderer discloses a cut ALONGSIDE the prose (previously proseErr only rendered
  // when prose was absent entirely).
  const lctx = Object.assign({}, ctx, { proseErr: "1 sentence(s) withheld \u2014 name not in context: QQQQ" });
  const r = C.renderLandscape(lctx, { story: "First paragraph here.\n\nSecond paragraph here.", refs: [] });
  assert.ok(/withheld/.test(r.message) && /First paragraph here/.test(r.message),
    "the reader gets the commentary AND the disclosure, not one or the other");
});

test("brief: movers carry both legs, and the relative leg is absent rather than wrong without a benchmark", () => {
  const C = require("../src/compute");
  const rows = [{ t: "MU", d1: 4.8 }, { t: "AVGO", d1: 3.1 }, { t: "NVDA", d1: 2.4 }, { t: "PFE", d1: -2.1 }, { t: "XOM", d1: -2.9 }, { t: "ENPH", d1: -5.2 }];
  const m = C.briefMovers(rows, 0.4, 3);
  assert.deepEqual(m.up.map((r) => r.t), ["MU", "AVGO", "NVDA"]);
  assert.deepEqual(m.down.map((r) => r.t), ["ENPH", "XOM", "PFE"], "losers lead with the worst");
  assert.equal(m.up[0].rel, 4.4, "the relative leg is the move against the book's own benchmark");
  const noBench = C.briefMovers(rows, null, 3);
  assert.equal(noBench.up[0].rel, null, "a relative column computed against a missing benchmark would be a fabrication");
  // Fewer names than the cap must not put the same row in both lists.
  const thin = C.briefMovers([{ t: "A", d1: 1 }, { t: "B", d1: -1 }], 0, 3);
  assert.equal(thin.up.filter((r) => thin.down.includes(r)).length, 0);
  // Partition on sign, not head-and-tail of one list. With fewer names than twice the cap the
  // old slice put losers inside the winners column, where they rendered red under a green heading.
  const few = C.briefMovers([{ t: "A", d1: 6.1 }, { t: "B", d1: 1.9 }, { t: "C", d1: -6.9 },
    { t: "D", d1: -7.6 }, { t: "E", d1: -8.4 }], 0, 3);
  assert.deepEqual(few.up.map((r) => r.t), ["A", "B"], "winners are names that went up, or there are none");
  assert.deepEqual(few.down.map((r) => r.t), ["E", "D", "C"], "losers lead with the worst");
  assert.ok(few.up.every((r) => r.d1 > 0) && few.down.every((r) => r.d1 < 0));
  const allGreen = C.briefMovers([{ t: "A", d1: 1 }, { t: "B", d1: 2 }], 0, 3);
  assert.equal(allGreen.down.length, 0, "a day with no losers has an empty losers list, not a fabricated one");
});

test("brief: sector groups use the median and drop thin ones rather than ranking on two names", () => {
  const C = require("../src/compute");
  const g = C.briefRankGroups([
    { name: "TECH", vals: [1, 2, 30] },              // median 2, not the 11 a mean would claim
    { name: "THIN", vals: [9, 9] },                  // under the floor
    { name: "ENERGY", vals: [-1, -2, -3] }], 3);
  assert.deepEqual(g.map((x) => x.name), ["TECH", "ENERGY"], "thin groups are dropped, not shipped on two names");
  assert.equal(g[0].med, 2, "one earnings gap must not decide what a sector did");
  assert.equal(g[0].up, 100);
});

test("brief: breadth is share-green, deliberately not benchmark-relative", () => {
  const C = require("../src/compute");
  assert.equal(C.briefBreadth([1, 1, -1, -1]), 50);
  assert.equal(C.briefBreadth([-1, -1, -1, 1]), 25);
  assert.equal(C.briefBreadth([]), null, "no data is null, never zero");
});

// ===================== macro calendar (build -17) =====================
test("macro: FOMC decision table pins the published Fed schedule through Jan 2028", () => {
  const { FOMC_DECISIONS } = require("../src/compute");
  // 8 decisions in 2026, 8 in 2027, 1 in Jan 2028 — federalreserve.gov/monetarypolicy/fomccalendars.htm
  assert.equal(FOMC_DECISIONS.length, 17);
  const y26 = FOMC_DECISIONS.filter((f) => f.d.startsWith("2026")), y27 = FOMC_DECISIONS.filter((f) => f.d.startsWith("2027"));
  assert.equal(y26.length, 8); assert.equal(y27.length, 8);
  // spot-pins against the published schedule
  assert.ok(FOMC_DECISIONS.some((f) => f.d === "2026-07-29" && f.sep === false), "Jul 29 2026 decision (no SEP)");
  assert.ok(FOMC_DECISIONS.some((f) => f.d === "2026-09-16" && f.sep === true), "Sep 16 2026 is a SEP meeting");
  assert.ok(FOMC_DECISIONS.some((f) => f.d === "2027-06-09" && f.sep === true), "Jun 9 2027 (tentative) is a SEP meeting");
  assert.ok(FOMC_DECISIONS.some((f) => f.d === "2028-01-26"), "Jan 26 2028 decision");
  // SEP rides Mar/Jun/Sep/Dec — exactly 4 per full year
  assert.equal(y26.filter((f) => f.sep).length, 4);
  assert.equal(y27.filter((f) => f.sep).length, 4);
  // strictly ascending, all valid dates
  for (let i = 0; i < FOMC_DECISIONS.length; i++) {
    assert.match(FOMC_DECISIONS[i].d, /^\d{4}-\d{2}-\d{2}$/);
    if (i) assert.ok(FOMC_DECISIONS[i].d > FOMC_DECISIONS[i - 1].d, "table must stay date-sorted");
  }
});

test("macro: FRED release-name resolution is exact-match-or-absent, never a guess", () => {
  const { parseFredReleases, parseFredReleasesDates, MACRO_RELEASES } = require("../src/compute");
  const feed = { releases: [
    { id: 10, name: "Consumer Price Index" },
    { id: 50, name: "Employment Situation" },
    { id: 53, name: "Gross Domestic Product" },
    { id: 46, name: "producer price index" },            // case-insensitive match
    { id: 999, name: "Consumer Price Index Research" },  // near-name must NOT hijack CPI
    { id: 9, name: "Advance Monthly Sales for Retail and Food Services" },
  ] };
  const ids = parseFredReleases(feed, MACRO_RELEASES);
  assert.equal(ids.get("CPI"), 10);
  assert.equal(ids.get("NFP"), 50);
  assert.equal(ids.get("GDP"), 53);
  assert.equal(ids.get("PPI"), 46);
  assert.equal(ids.get("RETAIL"), 9);
  assert.equal(ids.get("PCE"), undefined, "a release FRED renamed resolves to nothing — absent, never guessed");
  // dates: filtered to OUR ids, deduped, malformed dropped
  const idToK = new Map([[10, "CPI"], [50, "NFP"]]);
  const out = parseFredReleasesDates({ release_dates: [
    { release_id: 10, date: "2026-08-12" }, { release_id: 10, date: "2026-08-12" },
    { release_id: 50, date: "2026-08-07" }, { release_id: 46, date: "2026-08-13" },
    { release_id: 10, date: "garbage" },
  ] }, idToK);
  assert.deepEqual(out, [{ k: "CPI", d: "2026-08-12" }, { k: "NFP", d: "2026-08-07" }]);
  assert.deepEqual(parseFredReleasesDates({}, idToK), [], "missing array is empty, not a throw");
});

test("macro: buildMacroEntries merges the FOMC table with FRED dates inside the window, date-sorted", () => {
  const { buildMacroEntries } = require("../src/compute");
  // now = Mon Jul 27 2026, 16:00Z. Window +14d back 2d contains the Jul 29 FOMC decision.
  const now = Date.UTC(2026, 6, 27, 16, 0);
  const ent = buildMacroEntries([
    { k: "NFP", d: "2026-08-07" }, { k: "CPI", d: "2026-08-05" },
    { k: "CPI", d: "2026-08-12" },                                  // 16d out — beyond +14d
    { k: "RETAIL", d: "2026-07-24" },                               // -3d — beyond the 2d back window
  ], now, 14, 2);
  assert.deepEqual(ent.map((e) => e.k + "|" + e.d),
    ["FOMC|2026-07-29", "CPI|2026-08-05", "NFP|2026-08-07"]);
  const fomc = ent[0];
  assert.equal(fomc.tEt, "14:00");
  assert.equal(fomc.sep, false);
  assert.equal(fomc.d1, "2026-07-28", "day one of the two-day meeting rides the entry for display");
  assert.equal(ent[1].tEt, "08:30");
  assert.equal(ent[2].label, "Nonfarm payrolls");
});

test("macro: macroEntryState flips on the ET clock or actual-presence — the single arbiter", () => {
  const { macroEntryState } = require("../src/compute");
  const S = macroEntryState;
  const fomc = { d: "2026-07-29", tEt: "14:00" }, cpi = { d: "2026-08-12", tEt: "08:30" };
  // July = EDT (UTC-4): 13:00 ET = 17:00Z, 14:00 ET = 18:00Z
  assert.equal(S(fomc, Date.UTC(2026, 6, 29, 17, 0)), "upcoming", "13:00 ET on decision day — statement not out");
  assert.equal(S(fomc, Date.UTC(2026, 6, 29, 18, 0)), "released", "14:00 ET sharp — out");
  assert.equal(S(fomc, Date.UTC(2026, 6, 28, 12, 0)), "upcoming", "day before");
  assert.equal(S(fomc, Date.UTC(2026, 6, 30, 12, 0)), "released", "day after");
  assert.equal(S(cpi, Date.UTC(2026, 7, 12, 12, 29)), "upcoming", "8:29 ET");
  assert.equal(S(cpi, Date.UTC(2026, 7, 12, 12, 30)), "released", "8:30 ET sharp");
  assert.equal(S({ d: "2026-08-12", tEt: "08:30", actual: { yoy: 2.4 } }, Date.UTC(2026, 7, 1)), "released",
    "an actual present overrides the clock");
});

test("macro: stat reducers demand exact-period matches — null over approximation", () => {
  const { yoyPct, momPct, momDelta, lastObs, macroExpectedObsMonth } = require("../src/compute");
  const idx = []; // 14 months of a clean index: Jun 2025 .. Jul 2026
  for (let i = 0; i < 14; i++) {
    const y = 2025 + Math.floor((5 + i) / 12), m = ((5 + i) % 12) + 1;
    idx.push([`${y}-${String(m).padStart(2, "0")}-01`, 100 * Math.pow(1.002, i)]);
  }
  const yy = yoyPct(idx);
  assert.equal(yy.m, "2026-07");
  assert.ok(Math.abs(yy.v - 2.4) < 0.1, "12 months of 0.2%/mo compounds to ~2.4% YoY, got " + yy.v);
  // a gap at the 12-back month yields null, never a nearest-neighbor read
  const gappy = idx.filter((o) => o[0] !== "2025-07-01");
  assert.equal(yoyPct(gappy), null);
  const mm = momPct([["2026-06-01", 100], ["2026-07-01", 100.6]]);
  assert.ok(Math.abs(mm.v - 0.6) < 0.001 && mm.m === "2026-07");
  assert.equal(momPct([["2026-05-01", 100], ["2026-07-01", 100.6]]), null, "non-adjacent months refuse to pretend");
  const jd = momDelta([["2026-06-01", 159800], ["2026-07-01", 159947]]);
  assert.equal(jd.v, 147);
  assert.equal(lastObs([["2026-07-24", 3.75]]).v, 3.75);
  // reference periods: monthlies cover the prior month; GDP the latest COMPLETE quarter
  assert.equal(macroExpectedObsMonth("CPI", "2026-08-12"), "2026-07");
  assert.equal(macroExpectedObsMonth("GDP", "2026-07-30"), "2026-04", "July release = Q2 advance, obs at quarter start");
  assert.equal(macroExpectedObsMonth("GDP", "2026-08-27"), "2026-04", "August second estimate still covers Q2");
  assert.equal(macroExpectedObsMonth("GDP", "2026-10-29"), "2026-07", "late-Oct release = Q3 advance");
  assert.equal(macroExpectedObsMonth("GDP", "2026-02-26"), "2025-10", "Feb release covers Q4 of the prior year");
  assert.equal(macroExpectedObsMonth("FOMC", "2026-07-29"), null);
});

test("macro: macroWithin returns upcoming events inside a horizon, day-granular like the earnings guard", () => {
  const { macroWithin } = require("../src/compute");
  const now = Date.UTC(2026, 6, 27, 16, 0);   // Mon Jul 27, noon ET
  const DAY = 24 * 3600 * 1000;
  const ents = [
    { k: "FOMC", label: "FOMC rate decision", d: "2026-07-29", tEt: "14:00", sep: false },
    { k: "NFP", label: "Nonfarm payrolls", d: "2026-08-07", tEt: "08:30" },
    { k: "RETAIL", label: "Retail sales", d: "2026-07-24", tEt: "08:30" },   // released — out
  ];
  const w = macroWithin(ents, now, 8 * DAY);
  assert.deepEqual(w.map((m) => m.k), ["FOMC"], "8d horizon contains the decision (2d) but not NFP (11d)");
  assert.equal(w[0].days, 2);
  assert.deepEqual(macroWithin(ents, now, 12 * DAY).map((m) => m.k), ["FOMC", "NFP"]);
});

// ===== macro class + earnings calendar leg (build 2026.07.28-08) ================================
// Two gaps closed at once. The FRED/FOMC calendar had no push class at all — it reached the board,
// the arming banner and the AI report context, but never a transport, so "enable FOMC alerts" was
// selecting something that did not exist. And the earnings class was scoped so hard (open ANNOUNCED
// claim only) that a subscriber holding nothing got permanent silence from a subscribed class,
// which reads exactly like a broken wire. The scoping was right; the missing piece was the
// calendar itself, which is now one batched message a day rather than a dozen interruptions.

test("macro is a real, selectable, opt-in push class", () => {
  const C = require("../src/compute");
  assert.ok(C.PUSH_CLASSES.includes("macro"), "the class must exist before a chip can subscribe to it");
  assert.ok(!C.PUSH_DEFAULT_CLASSES.includes("macro"),
    "opt-in until its measured rate is known — adding a class never retroactively subscribes anyone");
  assert.ok(!C.PUSH_ADMIN_CLASSES.includes("macro"), "a CPI print is not server plumbing");
  assert.equal(C.pushEligible({ kind: "macro", k: "CPI" }, {}), false, "an unchosen subscription does not inherit it");
  assert.equal(C.pushEligible({ kind: "macro", k: "CPI" }, { classes: ["macro"] }), true, "…but choosing it works");
  assert.equal(C.pushEligible({ kind: "macro", k: "CPI" }, { classes: ["macro"], muted: true }), false, "muting still wins");
});

test("macro messages: no ticker required, prior is never dressed as consensus, a pending actual says so", () => {
  const C = require("../src/compute");
  // The coin guard exists to drop malformed events. Macro has no coin BY CONSTRUCTION — a CPI
  // print moves the whole board — so it has to be let through explicitly, not by accident.
  const ahead = C.pushFmt({ kind: "macro", k: "CPI", label: "CPI", sub: "ahead", d: "2026-08-12",
    tEt: "08:30", prior: { yoy: 2.9, core: 3.1, m: "2026-06" } }, {});
  assert.ok(ahead && /CPI/.test(ahead), "a ticker-less macro event still formats");
  assert.ok(/tomorrow/.test(ahead) && /08:30 ET/.test(ahead), "the day-ahead leg says when");
  assert.ok(/prior/.test(ahead) && /2\.9% YoY/.test(ahead) && /core 3\.1%/.test(ahead));
  assert.ok(/no street consensus/.test(ahead),
    "FRED carries no estimates — calling the prior an expectation would be the single most misleading thing this channel could do");
  assert.ok(!/beat|miss/.test(ahead), "and nothing here may read as a beat or a miss");

  const imm = C.pushFmt({ kind: "macro", k: "NFP", label: "Nonfarm payrolls", sub: "imminent", mins: 23,
    d: "2026-08-07", tEt: "08:30", prior: { chgK: 147, unemp: 4.1, m: "2026-06" } }, {});
  assert.ok(/in 23 min/.test(imm) && /\+147k/.test(imm) && /unemployment 4\.1%/.test(imm));

  const res = C.pushFmt({ kind: "macro", k: "CPI", label: "CPI", sub: "result", d: "2026-08-12",
    prior: { yoy: 2.9, core: 3.1, m: "2026-06" }, actual: { yoy: 2.6, core: 3.0, m: "2026-07" } }, {});
  assert.ok(/actual/.test(res) && /2\.6% YoY/.test(res) && /prior/.test(res) && /2\.9% YoY/.test(res),
    "the result leg reads prior -> actual, both from the SAME structured objects the calendar tab renders");
  assert.ok(/Jul 2026/.test(res), "and states the reference period, not the release date");

  // A passed release clock with no series behind it is the honest-null case: the poller does not
  // emit a result leg at all, but a hand-built one must still refuse to invent a number.
  const pend = C.pushFmt({ kind: "macro", k: "CPI", label: "CPI", sub: "result", d: "2026-08-12", prior: { yoy: 2.9, m: "2026-06" } }, {});
  assert.ok(/hasn/.test(pend) && !/actual  /.test(pend), "no actual means the message says so rather than shipping a blank row");

  const fomc = C.pushFmt({ kind: "macro", k: "FOMC", label: "FOMC rate decision", sub: "result",
    d: "2026-07-29", tEt: "14:00", prior: { lo: 3.75, hi: 4.0 }, actual: { lo: 3.5, hi: 3.75 } }, {});
  assert.ok(/3\.50\u20133\.75%/.test(fomc) && /cut/.test(fomc), "a lower range is a cut, derived from the numbers, never from a label");
  const held = C.pushFmt({ kind: "macro", k: "FOMC", label: "FOMC rate decision", sub: "result",
    d: "2026-07-29", prior: { lo: 3.75, hi: 4.0 }, actual: { lo: 3.75, hi: 4.0 } }, {});
  assert.ok(/held/.test(held), "an unchanged range is HELD — not a 0bp 'hike'");
  const sep = C.pushFmt({ kind: "macro", k: "FOMC", label: "FOMC rate decision", sub: "ahead",
    d: "2026-09-16", tEt: "14:00", sep: true, prior: { lo: 3.5, hi: 3.75 } }, {});
  assert.ok(/dot plot/.test(sep), "the projection meetings are the ones worth standing aside for");
});

test("macroStatText: one reducer per release, honest null over a fabricated number", () => {
  const C = require("../src/compute");
  assert.equal(C.macroStatText("CPI", { yoy: 2.9, core: 3.1 }), "2.9% YoY \u00b7 core 3.1%");
  assert.equal(C.macroStatText("CPI", { yoy: 2.9 }), "2.9% YoY", "a missing core is dropped, not zeroed");
  assert.equal(C.macroStatText("NFP", { chgK: -12, unemp: 4.3 }), "-12k \u00b7 unemployment 4.3%");
  assert.equal(C.macroStatText("RETAIL", { mom: 0.6 }), "+0.6% MoM");
  assert.equal(C.macroStatText("GDP", { qoq: 3 }), "3.0% QoQ ann.");
  assert.equal(C.macroStatText("PPI", {}), null, "an empty stat is null — never 'NaN%' on a lock screen");
  assert.equal(C.macroStatText("CPI", null), null);
  assert.equal(C.macroStatText("FOMC", { lo: 3.75, hi: 4 }), "3.75\u20134.00%");
  assert.equal(C.macroMonthText("2026-07"), "Jul 2026");
  assert.equal(C.macroMonthText("garbage"), null);
});

test("earnings: what was expected, what printed, and what the tape did", () => {
  const C = require("../src/compute");
  const D = 24 * 3600e3, d0 = Date.parse("2026-07-27T00:00:00Z");
  const daily = [{ t: d0, c: 100 }, { t: d0 + D, c: 100 }, { t: d0 + 2 * D, c: 102.4 }];

  // Re-baselined (AMC timing fix): a 16:05 ET AMC print sits INSIDE its own UTC-day bar, whose
  // 00:00Z close is hours after the print. The reaction is therefore the print day's own bar vs the
  // bar before — the same definition the reaction study uses, so the brief and the study can never
  // disagree. The old "next session" rule measured from a reference close that was already
  // post-print. `now` is pinned so "closed" means closed on the test's clock, not the wall clock.
  // (re-pinned -106) ONE window: the last cash close before the print -> the first cash close after
  // it. An AMC print on Wed 07-29 reacts in Thursday's session: the 07-28 session bar -> 07-30's.
  daily.push({ t: d0 + 3 * D, c: 104 });
  const now = d0 + 4 * D + 3600e3;
  const amc = C.earnPrintRow({ t: "msft", s: "AMC", d: "2026-07-29", eps: 3.12, epsA: 3.31 }, daily, null, null, now);
  assert.equal(amc.verdict, "beat");
  assert.equal(amc.surprisePct, 6.1);
  assert.equal(amc.reactionPct, 4, "last close BEFORE the print (07-28 bar) to the first close AFTER it (07-30, the reaction session)");
  assert.equal(amc.reactionSrc, "daily", "and the row says which tier measured it");

  const bmo = C.earnPrintRow({ t: "x", s: "BMO", d: "2026-07-29", eps: 1, epsA: 0.9 }, daily, null, null, now);
  assert.equal(bmo.verdict, "miss");
  assert.equal(bmo.reactionPct, 2.4, "a BMO print trades on its own day");
  assert.equal(C.earnPrintRow({ t: "y", s: "AMC", d: "2026-07-30", eps: 1, epsA: 1.2 }, daily, null, null, now).reactionPct, null,
    "an AMC print from this afternoon with no bar and no mark HAS no reaction yet, and says so");
  assert.equal(C.earnPrintRow({ t: "y", s: "AMC", d: "2026-07-30", eps: 1, epsA: 1.2 }, daily, 104.96, null, now).reactionPct, 2.5,
    "with a live mark it is a forming number against the last close before the print");

  // Every field independently nullable — a feed that shipped a date without an estimate produces a
  // visibly incomplete row, never a confident wrong one.
  const noEst = C.earnPrintRow({ t: "z", s: "BMO", d: "2026-07-29", eps: null, epsA: 2.2 }, daily);
  assert.equal(noEst.verdict, null);
  assert.equal(noEst.surprisePct, null);
  assert.equal(C.earnPrintRow({ t: "w", s: "BMO", d: "2026-07-29", eps: 0, epsA: 0.1 }, daily).surprisePct, null,
    "surprise against a zero estimate is undefined, not infinite");
  // Regression: `+null` is 0, so a bare Number.isFinite(+x) coerced a MISSING estimate into a zero
  // one — and against zero every actual is a "beat" with an undefined surprise. Absence and zero
  // are different facts and the row has to keep them apart.
  assert.equal(C.earnPrintRow({ t: "n", s: "BMO", d: "2026-07-29", eps: null, epsA: 2.2 }, daily).eps, null);
  assert.equal(C.earnPrintRow({ t: "n", s: "BMO", d: "2026-07-29", eps: "", epsA: 2.2 }, daily).eps, null);
  assert.equal(C.earnPrintRow({ t: "n", s: "BMO", d: "2026-07-29", eps: 0, epsA: 2.2 }, daily).eps, 0,
    "…while a genuine zero estimate is still a zero");
  assert.equal(C.earnPrintRow({ t: "q", s: "BMO", d: "2026-07-29", eps: 2, epsA: 2 }, daily).verdict, "in line");
});

test("the earnings block prints the numbers, and fits the column budget", () => {
  const C = require("../src/compute");
  const rows = C.briefEarnRows({
    printed: [{ t: "MSFT", s: "AMC", eps: 3.12, epsA: 3.31, verdict: "beat", surprisePct: 6.1, reactionPct: 2.4 },
      { t: "V", s: "AMC", eps: 2.95, epsA: 2.9, verdict: "miss", surprisePct: -1.7, reactionPct: -0.8 },
      { t: "XOM", s: "BMO", eps: 1.2, epsA: null, verdict: null, surprisePct: null, reactionPct: null }],
    today: [{ t: "AAPL", s: "AMC", eps: 1.42 }],
    tomorrow: [{ t: "BA", s: "BMO", eps: 0.31 }, { t: "NVDA", s: "TBD", eps: null }] });
  const txt = rows.join("\n");
  assert.ok(/3\.31\/3\.12/.test(txt), "print vs expected — the thing the old block never showed");
  assert.ok(/beat/.test(txt) && /miss/.test(txt));
  assert.ok(/\+2\.4%/.test(txt) && /-0\.8%/.test(txt), "and the market reaction");
  assert.ok(/est 1\.42/.test(txt), "upcoming rows carry the estimate");
  assert.ok(/est \u2014/.test(txt), "…and say so when the feed has none");
  // Audit regression: padR SLICES to width, and a numeric field must never be sliced — the first
  // cut rendered "-12.34" as "-12.3" and "9999.99" as "999", a wrong number displayed as truth
  // (the NFLX 2dp lesson, one layer up). Extreme pairs now size their column and the block drops
  // the reaction COLUMN, uniformly, rather than any number losing a digit.
  const hostile = C.briefEarnRows({ printed: [
    { t: "GOOGL", s: "AMC", eps: -12.34, epsA: -10.05, verdict: "beat", reactionPct: -12.4 },
    { t: "BRKB", s: "BMO", eps: 9999.99, epsA: 10000.01, verdict: "beat", reactionPct: 100 }],
    today: [{ t: "GOOGL", s: "DMH", eps: -1234.56 }], tomorrow: [] });
  const htxt = hostile.join("\n");
  assert.ok(/-10\.05\/-12\.34/.test(htxt) && /10000\.01\/9999\.99/.test(htxt) && /est -1234\.56/.test(htxt),
    "every digit survives, whatever the value");
  assert.ok(!/12\.4%/.test(htxt), "the reaction column gave way for the whole block");
  for (const r of hostile) assert.ok(r.length <= C.BRIEF_COLS, "and every row still fits: " + r.length);
  assert.ok(/post-close/.test(txt) && /pre-mkt/.test(txt) && /time TBD/.test(txt),
    "sessions in English — AMC is feed jargon");
  for (const r of rows) assert.ok(r.length <= C.BRIEF_COLS,
    `every row must fit ${C.BRIEF_COLS} columns or it wraps into noise on a phone: ${r.length} "${r}"`);
  assert.equal(C.briefEarnRows({}).length, 0, "an empty calendar renders nothing, and the block drops");
});

// ===== bug-review pins (post-audit review of build 2026.07.28-18) ==============================
// Four bugs found by hostile review after the first audit. Each pin states the failure it locks out.

test("a malformed source URL degrades one headline to plain text — never the whole brief", () => {
  const C = require("../src/compute");
  // Two clusters of two: the block renders only the first TWO items per cluster, so a one-cluster
  // fixture would leave half these cases untested (the review's own first draft made that mistake).
  const ctx = { at: Date.parse("2026-07-29T10:00:00Z"), tz: 0, news: [
    { sector: "X", items: [
      { t: "A", h: "good link", u: "https://ex.com/ok?a=1&b=2" },
      { t: "B", h: "quote bomb", u: 'https://ex.com/x"onclick' }] },
    { sector: "Y", items: [
      { t: "C", h: "spacey", u: "https://ex.com/a b" },
      { t: "D", h: "not a url", u: "javascript:alert(1)" }] }] };
  const txt = C.renderBrief(ctx, null).messages.join("\n");
  // tgEscape does not escape quotes; a raw quote inside href breaks the attribute, Telegram
  // rejects the parse, and one junk headline would have cost the ENTIRE message.
  assert.ok(/<a href="https:\/\/ex\.com\/ok\?a=1&amp;b=2">/.test(txt), "a sane URL links, ampersand escaped");
  assert.ok(/quote bomb/.test(txt) && !/onclick/.test(txt), "a quoted URL is not linked at all");
  assert.ok(/spacey/.test(txt) && !/href="https:\/\/ex\.com\/a b"/.test(txt));
  assert.ok(/not a url/.test(txt) && !/javascript:/.test(txt), "non-http schemes never reach an href");
});

// ===== THE LANDSCAPE as a registered scheduled send (build 2026.07.28-19) ======================
// The point of the sched registry, cashed in: the landscape arrives as a second registered kind
// and every recipient row grows a second hour+days chip with zero new panel machinery. Mon/Wed/Fri
// 11:00 UTC by default, per-recipient overridable through the identical validated route.

test("the landscape registers Mon/Wed/Fri 11:00 UTC, and default days yield to any explicit choice", () => {
  const C = require("../src/compute");
  const k = C.SCHED_KINDS.find((x) => x.k === "landscape");
  assert.ok(k, "it is in the registry — that is what makes it schedulable at all");
  assert.equal(k.defaultHour, 11, "an hour after the brief");
  assert.deepEqual(k.defaultDays, [1, 3, 5]);

  const res = C.schedResolve(undefined, k);
  assert.deepEqual(res, { hour: 11, days: [1, 3, 5], isDefault: true },
    "a never-configured recipient rides M/W/F at 11:00 UTC");
  const mon = Date.parse("2026-07-27T11:00:00Z"), tue = Date.parse("2026-07-28T11:00:00Z");
  assert.equal(C.schedDueAt(res, mon, 0), "2026-07-27", "due Monday");
  assert.equal(C.schedDueAt(res, tue, 0), null, "silent Tuesday — the day set gates the default too");

  // An explicit choice replaces the default days entirely, including choosing daily.
  assert.deepEqual(C.schedResolve({ set: 1, h: 9, days: [2, 4] }, k).days, [2, 4]);
  assert.equal(C.schedResolve({ set: 1, h: 9 }, k).days, null,
    "a configured recipient with no day set is DAILY — registry defaults never leak into an explicit schedule");
  assert.equal(C.schedResolve({ set: 1, h: null }, k).hour, null, "and off is off");
  // The brief keeps no default days: registering one kind's days must not change another's.
  assert.equal(C.schedResolve(undefined, C.SCHED_KINDS.find((x) => x.k === "brief")).days, null);
});

test("landscape render: sources footer, URL guard, honest degradation, shed order", () => {
  const C = require("../src/compute");
  const ctx = { at: Date.parse("2026-07-29T11:00:00Z"), tz: 0, news: [{ sector: "X", items: [
    { id: "h1", t: "ASML", h: "China DUV push", u: "https://ex.com/1" },
    { id: "h2", t: "MU", h: "quote bomb", u: 'https://ex.com/x"onclick' }] }] };
  const r = C.renderLandscape(ctx, { story: "Para one.\n\nPara two.", refs: ["h1", "h2"] });
  assert.ok(/THE LANDSCAPE/.test(r.message) && /Para one\./.test(r.message));
  assert.ok(/<a href="https:\/\/ex\.com\/1">/.test(r.message), "a cited headline with a sane URL links");
  assert.ok(/quote bomb/.test(r.message) && !/onclick/.test(r.message),
    "the brief's URL guard applies here too — one junk URL must not cost the whole message");
  assert.equal(r.sources, 2);

  const d = C.renderLandscape({ at: Date.now(), tz: 0, proseErr: "landscape-daily-cap" }, null);
  assert.ok(/commentary unavailable/.test(d.message) && /landscape-daily-cap/.test(d.message),
    "no mechanical fallback exists, so a failed generation says so instead of going silent");

  const many = { sector: "X", items: [] };
  for (let i = 0; i < 12; i++) many.items.push({ id: "h" + i, t: "T" + i, h: "H".repeat(300) + i, u: "https://ex.com/" + i });
  const big = C.renderLandscape({ at: Date.now(), tz: 0, news: [many] },
    { story: "A".repeat(1900) + ".\n\n" + "B".repeat(1900) + ".", refs: many.items.map((x) => x.id) });
  assert.ok(C.briefVisibleLen(big.message) <= C.BRIEF_TG_LIMIT, "the message fits Telegram's limit");
  assert.ok(big.dropped.includes("source"), "citations shed before prose");

  // Pathological single over-long paragraph: sources+paragraph shedding can't help (one paragraph,
  // no \n\n), so the final clip backstop trims it to fit. The commentary still ships — never the
  // "unavailable" placeholder, and never an over-limit body the Telegram send would bounce.
  const huge = C.renderLandscape({ at: Date.now(), tz: 0, news: [{ sector: "X", items: [{ id: "h1", t: "T", h: "h", u: "https://ex.com/1" }] }] },
    { story: "z".repeat(9000), refs: ["h1"] });
  assert.ok(C.briefVisibleLen(huge.message) <= C.BRIEF_TG_LIMIT, "a single over-long paragraph is clipped to fit the ceiling");
  assert.ok(huge.dropped.includes("clip"), "the final backstop engages when shedding alone cannot fit");
  assert.ok(!/commentary unavailable/.test(huge.message) && /THE LANDSCAPE/.test(huge.message),
    "an over-long story still delivers the commentary, not the unavailable line");
});

test("earnings reaction: an AMC print whose reaction session has not closed still yields a number", () => {
  const C = require("../src/compute");
  // Re-pinned (build 2026.09.24-106): ONE window — the last cash close before the print -> the first
  // cash close after it. A Wednesday AMC print reacts in THURSDAY's session, so the live case is the
  // evening of the print (and all of Thursday) before that session's close. Fixed clock (the old
  // version rode Date.now(), so a weekend run changed which session a print reacted in).
  const DAY = 86400000, HOUR = 3600e3, day0 = Date.UTC(2026, 8, 16), now = day0 + 21 * HOUR;   // Wed 2026-09-16, 17:00 ET
  const dstr = (t) => new Date(t).toISOString().slice(0, 10);
  // Daily series ending YESTERDAY (Fri 09-11 .. Tue 09-15, weekend bars included) — the live shape
  // when the brief runs in the evening of the print day before the day's bar has been pulled.
  const daily = [];
  for (let k = 5; k >= 1; k--) daily.push({ t: day0 - k * DAY, c: 100 });
  // The original single-tier version asked for a closed candle and returned null — which is why
  // ARM, HOOD, META and MSFT all showed a dash on one brief.
  const rx = C.earnPrintReaction({ t: "ARM", d: dstr(day0), s: "AMC" }, daily, 106, null, now);
  assert.ok(rx, "an AMC print from this afternoon must not be unmeasurable");
  assert.equal(rx.state, "forming");
  assert.equal(rx.pct, 6, "the live mark against the last close before the print");
  // The print day's own bar present: still forming — the reaction session is Thursday's.
  const open = daily.concat([{ t: day0, c: 104 }]);
  assert.equal(C.earnPrintReaction({ t: "ARM", d: dstr(day0), s: "AMC" }, open, 106, null, now).state, "forming");
  assert.equal(C.earnPrintReaction({ t: "ARM", d: dstr(day0), s: "AMC" }, open, 106, null, now).pct, 6, "the reference is Tuesday's close, never the print day's post-print 20:00 ET close");
  // Once the reaction session's bar CLOSES, closed-bar arithmetic takes over and the live mark is
  // ignored — the number must not keep drifting after it is final.
  const thu = open.concat([{ t: day0 + DAY, c: 104 }]);
  const fin = C.earnPrintReaction({ t: "ARM", d: dstr(day0), s: "AMC" }, thu, 999, null, day0 + 2 * DAY + HOUR);
  assert.equal(fin.state, "final");
  assert.equal(fin.pct, 4, "a settled reaction ignores the live mark entirely");
  // A Monday BMO reads Friday's close -> Monday's close.
  assert.equal(C.earnPrintReaction({ t: "X", d: dstr(day0 - 2 * DAY), s: "BMO" }, open, 999, null, now).state, "final");
  // A print older than the retained window stays absent rather than being invented.
  assert.equal(C.earnPrintReaction({ t: "X", d: "2019-01-01", s: "BMO" }, open, 100, null, now), null);
  // With an HOURLY spine the exact cash anchors resolve: reference = Wednesday's 16:00 ET close,
  // reaction = Thursday's 16:00 ET close once printed, forming against the mark until then.
  const t16 = C.etWallToUtc(2026, 9, 16, 16, 0);
  const hs = []; for (let t = t16 - 30 * HOUR; t < t16 + 30 * HOUR; t += HOUR) hs.push([t, 100, 100, 100, t + HOUR <= t16 ? 100 : 110, 1]);
  const hRx = C.earnPrintReaction({ t: "ARM", d: dstr(day0), s: "AMC" }, daily, 108, hs, t16 + 3 * HOUR);
  assert.deepEqual(hRx, { pct: 8, state: "forming", src: "cash" }, "hourly anchor: mark vs the 16:00 ET close, not the UTC-day close");
  assert.deepEqual(C.earnPrintReaction({ t: "ARM", d: dstr(day0), s: "AMC" }, daily, 108, hs, t16 + 25 * HOUR), { pct: 10, state: "final", src: "cash" }, "Thursday's 16:00 ET close settles it");
  // And the row carries the tier so the renderer can label it.
  const row = C.earnPrintRow({ t: "ARM", d: dstr(day0), s: "AMC", eps: 0.41, epsA: 0.45 }, daily, 106, null, now);
  assert.equal(row.verdict, "beat");
  assert.equal(row.reactionState, "forming");
  const rendered = C.renderBrief({ at: now, earnings: { printed: [row], today: [], tomorrow: [] } }, null)
    .messages.join("\n").replace(/\u2007/g, " ");
  assert.ok(rendered.includes("+6.0%~"), "a forming reaction is marked, not passed off as settled");
  assert.ok(rendered.includes("move so far, candle open"), "and the mark is explained");
});

test("prose gate: context values are citable at their own precision, and one bad half keeps the other", () => {
  const C = require("../src/compute");
  const ctx = { regime: { stocks: { disp: 4.587792771657628 } } };
  // The exact live failure: the model quoted its context verbatim and was rejected for inventing
  // a number that was sitting in the context it was handed.
  assert.ok(C.briefContextNumbers(ctx).has("4.587792771657628"),
    "a value present in the context must be citable at the precision it was presented at");
  const ok = C.validateBriefProse({ story: "Dispersion sat at 4.587792771657628 across the book.",
    closing: "Breadth stays thin." }, ctx);
  assert.ok(ok.ok, "faithful quotation must not be treated as fabrication: " + ok.error);
  // Fabrication is still caught — the gate must not have been loosened into uselessness.
  const bad = C.validateBriefProse({ story: "Dispersion sat at 7.77 across the book.", closing: "Fine." }, ctx);
  assert.ok(!bad.ok && /7\.77/.test(bad.error), "an invented figure is still rejected");
  // Per-section: a fabricated closing must not cost a clean story.
  const per = C.validateBriefSections({ story: "Dispersion sat at 4.59 across the book.",
    closing: "Nonsense at 9.99 per cent." }, ctx);
  assert.ok(per.story.ok, "the clean section survives its sibling's failure");
  assert.ok(!per.closing.ok, "the dirty one does not");
  assert.ok(/9\.99/.test(per.closing.error));
  // A missing section reports as its own, never as the other one's failure.
  const half = C.validateBriefSections({ story: "Breadth thin.", closing: "" }, ctx);
  assert.ok(half.story.ok);
  assert.ok(!half.closing.ok && /closing/.test(half.closing.error));
});

test("brief: a partial prose pass ships the clean half and discloses the withheld one", () => {
  const C = require("../src/compute");
  const msgs = C.renderBrief({ at: Date.now(), proseErr: "closing withheld \u2014 number not in context: 7.77" },
    { story: "Breadth is thin and narrowing.", closing: null }).messages.join("\n");
  assert.ok(msgs.includes("THE STORY"), "the clean section ships");
  assert.ok(msgs.includes("Breadth is thin and narrowing."));
  assert.ok(!msgs.includes("FINAL THOUGHTS"), "the withheld one does not");
  // Silence about the withholding would read as a model that had nothing to add.
  assert.ok(msgs.includes("commentary unavailable"), "and the reader is told why");
  assert.ok(msgs.includes("closing withheld"));
});

// ===== build 2026.08.05-01: the calendar alert can no longer fabricate a print ===============
// Live 2026-08-05: SNDK "EPS 0.00 vs 35.14 est · miss" and WDC "0.00 vs 3.33 · miss" on the
// Telegram calendar. The parser's placeholder scrub was fine — epsA arrived null — but the
// composer gated on Number.isFinite(+e.epsA), and +null === 0, so a missing actual coerced into
// a real-looking 0.00 and MANUFACTURED a miss verdict next to the day move. Behavioral: the
// composer is executed against the exact live shapes, not string-pinned (the -84 lesson).
test("earnings preview composer: a null or placeholder-zero actual is 'not in the feed yet', never a 0.00 miss", () => {
  const C = require("../src/compute");
  const msg = (reported) => C.pushFmt({ kind: "earnings", sub: "preview", d: "2026-08-05",
    tomorrow: [{ t: "DKNG", s: "AMC", eps: 0.03 }], reported }, {});
  // null actual (the live SNDK/WDC shape): no EPS number, no verdict, day move intact
  const m1 = msg([{ t: "WDC", s: "BMO", eps: 3.33, epsA: null, d1: -14.6 }]);
  assert.ok(/WDC \u2014 actual not in the feed yet \u00b7 day -14\.6%/.test(m1),
    "null actual reads as absent with the day move, got: " + m1);
  assert.ok(!/0\.00/.test(m1) && !/miss/.test(m1), "no fabricated 0.00, no fabricated verdict");
  // literal-zero actual (pre-scrub persisted garbage): same doctrine as the parser — absent
  const m2 = msg([{ t: "SNDK", s: "BMO", eps: 35.14, epsA: 0, d1: -7.0 }]);
  assert.ok(/actual not in the feed yet/.test(m2) && !/miss/.test(m2),
    "a composer-reaching zero actual is the placeholder, never a verdict");
  // a REAL print still renders in full — the fix must not eat genuine verdicts
  const m3 = msg([{ t: "LLY", s: "BMO", eps: 6.07, epsA: 8.38, d1: 3.8 }]);
  assert.ok(/LLY \u2014 EPS 8\.38 vs 6\.07 est \u00b7 beat \u00b7 day \+3\.8%/.test(m3), "real beat intact: " + m3);
  // null estimate on the tomorrow leg: no "est 0.00" either (+null hits eps the same way)
  const m4 = C.pushFmt({ kind: "earnings", sub: "preview", d: "2026-08-05",
    tomorrow: [{ t: "XYZ", s: "AMC", eps: null }], reported: [] }, {});
  assert.ok(/XYZ \u2014 after close$/m.test(m4) && !/est 0\.00/.test(m4), "missing estimate renders nothing, not est 0.00");
  // wiring pin: the composer's gates require presence before coercion, actual additionally != 0
  const cmp = require("fs").readFileSync(require("path").join(__dirname, "..", "src", "compute.js"), "utf8");
  assert.ok(cmp.includes("const fin = (x) => x != null && Number.isFinite(+x);")
    && cmp.includes("const hasA = (x) => fin(x) && +x !== 0;"), "presence-gated helpers pinned in the preview block");
});

test("focus -01: selection caps at 6 seats, 2 per cluster, and discloses why each cut fell", () => {
  const mk = (t, gapS, rvol, clu) => ({ ticker: t, gapPct: gapS, gapSigma: gapS, rvol, oiDelta: null, ern: 0, news24: 0, cluster: clu });
  // Four SEMI names loudest of all: only two may seat; the third and fourth are cluster cuts
  // even though they outrank every non-SEMI candidate.
  const cands = [
    mk("NVDA", 3.0, 4.0, "Semis"), mk("MU", 2.8, 3.5, "Semis"), mk("AMD", 2.6, 3.0, "Semis"), mk("SMCI", 2.4, 2.8, "Semis"),
    mk("LLY", 2.0, 2.5, "Pharma"), mk("TSLA", 1.5, 2.0, "Autos"), mk("XOM", 1.2, 1.8, "Energy"),
    mk("JPM", 1.0, 1.5, "Banks"), mk("COIN", 0.9, 1.4, "Capital Markets"), mk("PLTR", 0.8, 1.3, "Software"),
  ];
  const sel = focusSelect(cands);
  assert.equal(sel.picks.length, FOCUS_CAP, "exactly six seats");
  const semis = sel.picks.filter((p) => p.cluster === "Semis").map((p) => p.ticker);
  assert.deepEqual(semis, ["NVDA", "MU"], "the two loudest SEMI names take the cluster's only seats");
  assert.deepEqual(sel.picks.map((p) => p.ticker), ["NVDA", "MU", "LLY", "TSLA", "XOM", "JPM"], "seats walk loudest-first past the blocked cluster");
  const amd = sel.cuts.find((c) => c.ticker === "AMD"), pltr = sel.cuts.find((c) => c.ticker === "PLTR");
  assert.equal(amd && amd.why, "cluster", "AMD outranks four seated names but is a CLUSTER cut, not a rank cut");
  assert.ok(sel.cuts.find((c) => c.ticker === "SMCI" && c.why === "cluster"), "fourth SEMI also a cluster cut");
  assert.equal(pltr && pltr.why, "rank", "PLTR is a plain rank cut");
  assert.equal(sel.cuts.length, 4, "cut line disclosure is capped");
  // determinism: identical input twice -> byte-identical seat order (ties break on ticker)
  assert.deepEqual(focusSelect(cands).picks.map((p) => p.ticker), sel.picks.map((p) => p.ticker), "stamped order is reproducible");
});

test("focus -01: null cluster never blocks a seat, nulls contribute zero loudness, degenerates degrade", () => {
  const cands = [
    { ticker: "A", gapSigma: 2, rvol: 3, cluster: null }, { ticker: "B", gapSigma: 2, rvol: 3, cluster: null },
    { ticker: "C", gapSigma: 2, rvol: 3, cluster: null }, { ticker: "D", gapSigma: 1, rvol: 2, cluster: "X" },
  ];
  const sel = focusSelect(cands);
  assert.equal(sel.picks.length, 4, "three unknown-cluster names all seat — an unproven grouping never eats a quota");
  // nulls contribute nothing: a candidate with only an earnings flag scores exactly the flat boost
  assert.equal(focusScore({ ticker: "E", ern: "amc" }), 1.5, "ern alone = 1.5, missing fields are zero not NaN");
  assert.equal(focusScore({ ticker: "F" }), 0, "all-null candidate scores zero");
  assert.deepEqual(focusSelect([{ nope: 1 }, null, { ticker: "" }]).picks, [], "malformed candidates are dropped, never thrown on");
});

test("focus -01: firstHourStats measures exact geometry on archive bars and refuses partial hours", () => {
  const M5 = 5 * 60 * 1000, open = Date.UTC(2026, 7, 14, 13, 30);   // 09:30 ET in UTC ms (EDT)
  const bar = (i, o, h, l, c, v) => [open + i * M5, o, h, l, c, v];
  const bars = [];
  for (let i = 0; i < 12; i++) {
    if (i === 2) bars.push(bar(i, 101, 106, 100.5, 105, 2000));     // the hour's high, on volume
    else if (i === 8) bars.push(bar(i, 103, 103.5, 98, 99, 3000));  // the hour's low
    else bars.push(bar(i, 100 + i * 0.1, 102, 99.5, 101, 1000));
  }
  bars.push(bar(12, 101, 120, 90, 100, 5000));                       // 10:30 bar — OUTSIDE the hour, must not leak in
  bars.unshift([open - M5, 95, 96, 94, 95, 800]);                    // pre-open bar — outside too
  const fh = fhStats(bars, open, open + 3600 * 1000);
  assert.ok(fh, "twelve in-window bars are a record");
  assert.equal(fh.bars, 12, "exactly the in-window bars counted");
  assert.equal(fh.hi, 106, "high is the true bar extreme, not a close");
  assert.equal(fh.lo, 98, "low is the true bar extreme");
  assert.equal(fh.openPx, 100, "open = the FIRST in-window bar's open, never the pre-open bar");
  assert.equal(fh.lastPx, 101, "last = the FINAL in-window bar's close (the 11:25-open bar), never the 10:30 bar");
  // vwap: exact hand computation of sum(typical*v)/sum(v) over the in-window bars
  let pv = 0, vv = 0;
  for (const k of bars) { if (k[0] < open || k[0] >= open + 3600e3) continue; pv += (k[2] + k[3] + k[4]) / 3 * k[5]; vv += k[5]; }
  assert.equal(fh.vwap, +(pv / vv).toPrecision(8), "vwap reproduces the definition to the bit");
  // honesty gates
  assert.equal(fhStats(bars.slice(0, 5), open, open + 3600e3), null, "a spine-gap hour (<6 bars) is not a record");
  assert.equal(fhStats(null, open, open + 3600e3), null, "null degrades");
  assert.equal(fhStats(bars, open, open), null, "empty window degrades");
  const noVol = bars.map((k) => [k[0], k[1], k[2], k[3], k[4], 0]);
  const fz = fhStats(noVol, open, open + 3600e3);
  assert.ok(fz && fz.vwap === null && fz.hi === 106, "zero volume: extremes stay real, VWAP is a null — never a fabricated average");
});

test("focus -01: gap σ and level distance obey their sample floors and stay in own-name units", () => {
  assert.equal(focusGapSigma([1, -1, 2]), null, "below the 10-sample floor no σ is claimed");
  const gaps = [1, -1, 2, -2, 1.5, -0.5, 0.8, -1.2, 0.3, 1.1, -0.7, 0.9];
  assert.ok(focusGapSigma(gaps) > 0, "enough samples -> a real dispersion");
  assert.equal(focusGapSigma([1, NaN, null, 2]), null, "junk never counts toward the floor");
  // level distance: 40 flat completed days at 100 with one 30d high at 110, live px 105 —
  // the high is 5/ sd above; the forming day's fake 200 print must never become the extreme.
  const HOURa = 3600 * 1000, DAYa = 24 * HOURa, now = Date.UTC(2026, 7, 14, 15, 0);
  const day0 = Math.floor(now / DAYa) * DAYa - 40 * DAYa;
  const hs = [];
  for (let d = 0; d < 40; d++) for (let h = 0; h < 24; h += 4) {
    const base = 100 + Math.sin(d) * 1.2;                       // gentle wiggle so daily σ is nonzero
    const hi = d === 35 ? 110 : base + 0.5;
    hs.push([day0 + d * DAYa + h * HOURa, base, hi, base - 0.5, base + Math.cos(d) * 0.8, 100]);
  }
  hs.push([Math.floor(now / DAYa) * DAYa + HOURa, 105, 200, 50, 105, 100]);   // forming day: ignored
  const lvl = focusLevelDist(hs, 105, now);
  assert.ok(lvl && lvl.side === "above", "the 30d high overhead is the nearer extreme");
  const closes = new Map();
  for (const k of hs) { const t = k[0]; if (t >= Math.floor(now / DAYa) * DAYa) continue; closes.set(Math.floor(t / DAYa) * DAYa, k[4]); }
  const cl = [...closes.entries()].sort((a, b) => a[0] - b[0]).map((e) => e[1]).slice(-31);
  const rets = []; for (let i = 1; i < cl.length; i++) rets.push((cl[i] / cl[i - 1] - 1) * 100);
  const sd = require("../src/compute").retStd ? null : null;    // retStd is not exported; reproduce via the public result instead:
  assert.ok(lvl.distSd > 0 && isFinite(lvl.distSd), "distance is a positive σ figure");
  assert.equal(focusLevelDist(hs, 0, now), null, "no price, no claim");
  assert.equal(focusLevelDist(hs.slice(0, 10), 105, now), null, "too little spine, no claim");
});

test("focus -02: TG lane weighs into loudness exactly as disclosed, count-capped, null-safe", () => {
  // headlines: 0.25 each capped at 3 counted; TG <4h: 0.5 each capped at 2 counted (max +1.0)
  assert.equal(focusScore({ ticker: "A", news24: 4, tg4h: 3 }), 0.25 * 3 + 0.5 * 2, "both lanes hit their caps");
  assert.equal(focusScore({ ticker: "B", news24: 1, tg4h: 1 }), 0.25 + 0.5, "one wire + one fresh TG item");
  assert.equal(focusScore({ ticker: "C", tg4h: 1 }), 0.5, "a TG item with no 24h wire count still weighs");
  assert.equal(focusScore({ ticker: "D", news24: 2 }), 0.5, "no tg4h field -> the lane contributes zero, never NaN");
  // a fresh TG mention can flip an ordering the wire count alone would not
  const a = { ticker: "AA", gapSigma: 1.0, news24: 3 }, b = { ticker: "BB", gapSigma: 1.0, news24: 0, tg4h: 2 };
  assert.ok(focusScore(b) > focusScore(a), "two fresh TG items outrank three stale wire headlines");
});

test("focus -02: the preview pool is top-10 by the SAME loudness with NO cluster gate", () => {
  const mk = (t, g, clu) => ({ ticker: t, gapSigma: g, cluster: clu });
  // gap σ values stay UNDER the score's |gapσ| cap of 4 — at or above it, loudness ties and the
  // ticker tiebreak takes over (that capping is itself covered by the ordering assertions below).
  const cands = [mk("N", 3.9, "SEMI"), mk("M", 3.6, "SEMI"), mk("A", 3.3, "SEMI"), mk("S", 3.0, "SEMI"),
    mk("L", 2.7, "PH"), mk("T", 2.4, "AU"), mk("X", 2, "EN"), mk("J", 1.5, "BK"), mk("C", 1, "CM"),
    mk("P", 0.5, "SW"), mk("Q", 0.4, "SW"), mk("R", 0.3, "SW")];
  const pv = focusPreview(cands);
  assert.equal(pv.length, FOCUS_PREVIEW_N, "exactly ten");
  assert.deepEqual(pv.slice(0, 4).map((x) => x.ticker), ["N", "M", "A", "S"], "all four SEMI names present — the prep pool ignores the cap the stamp will apply");
  assert.ok(!pv.find((x) => x.ticker === "Q") && !pv.find((x) => x.ticker === "R"), "eleventh and twelfth stay out");
  assert.ok(pv.every((x) => typeof x.score === "number"), "scores ride along for the rank read");
  assert.deepEqual(focusPreview(cands, 3).map((x) => x.ticker), ["N", "M", "A"], "n is honored");
  assert.deepEqual(focusPreview(null), [], "null degrades");
});

test("focus -02: the stamp-vs-preview diff is exact set math", () => {
  const d = focusDiff(["NVDA", "MU", "LLY", "TSLA", "COIN", "PLTR"], ["NVDA", "MU", "LLY", "TSLA", "XOM", "COIN"]);
  assert.deepEqual(d.added, ["XOM"], "the seat XOM took is disclosed");
  assert.deepEqual(d.dropped, ["PLTR"], "the seat PLTR lost is disclosed");
  assert.deepEqual(focusDiff(["A"], ["A"]), { added: [], dropped: [] }, "a matching stamp discloses an empty diff, not silence");
  assert.deepEqual(focusDiff(null, ["A"]), { added: ["A"], dropped: [] }, "no preview -> everything reads as added, nothing throws");
});

// ===== 13F whale lane (build 2026.08.16-01) =====================================================
// The FUNDS tab end to end. Pure layer first (parser, book aggregation, delta classes, name
// normalization, filing-window arithmetic, season aggregation), then the poller lane through the
// REAL fetch/ingest/poll paths against an injected transport (the -84/-87 doctrine: behavioral
// tests on real code paths, fixtures on the wire, no harness patches masking production logic),
// then the wiring manifest.

test("whale pure: infotable parses bare + namespaced, book aggregates on cusip|put, PRN poisons shares honestly", () => {
  const C = require("../src/compute");
  const xml = `<edgarSubmission>
    <ns1:infoTable><ns1:nameOfIssuer>APPLE INC</ns1:nameOfIssuer><ns1:titleOfClass>COM</ns1:titleOfClass><ns1:cusip>037833100</ns1:cusip><ns1:value>1000</ns1:value>
      <ns1:shrsOrPrnAmt><ns1:sshPrnamt>10</ns1:sshPrnamt><ns1:sshPrnamtType>SH</ns1:sshPrnamtType></ns1:shrsOrPrnAmt></ns1:infoTable>
    <ns1:infoTable><ns1:nameOfIssuer>APPLE INC</ns1:nameOfIssuer><ns1:cusip>037833100</ns1:cusip><ns1:value>500</ns1:value>
      <ns1:shrsOrPrnAmt><ns1:sshPrnamt>5</ns1:sshPrnamt><ns1:sshPrnamtType>SH</ns1:sshPrnamtType></ns1:shrsOrPrnAmt></ns1:infoTable>
    <infoTable><nameOfIssuer>ALIBABA GROUP HLDG</nameOfIssuer><cusip>01609W102</cusip><value>300</value>
      <shrsOrPrnAmt><sshPrnamt>3</sshPrnamt><sshPrnamtType>SH</sshPrnamtType></shrsOrPrnAmt><putCall>Put</putCall></infoTable>
    <infoTable><nameOfIssuer>BOND THING</nameOfIssuer><cusip>999999999</cusip><value>200</value>
      <shrsOrPrnAmt><sshPrnamt>200000</sshPrnamt><sshPrnamtType>PRN</sshPrnamtType></shrsOrPrnAmt></infoTable>
  </edgarSubmission>`;
  const p = C.parse13FInfotable(xml);
  assert.equal(p.n, 4, "all four filed rows parse, prefixed and bare alike");
  const b = C.whaleBook(p);
  assert.equal(b.total, 2000, "total is the sum of filed values, verbatim");
  assert.equal(b.n, 3, "two AAPL rows joined on cusip; the BABA PUT stays its own position");
  const aapl = b.positions.find((x) => x.cusip === "037833100");
  assert.equal(aapl.value, 1500); assert.equal(aapl.shares, 15, "SH rows sum");
  assert.ok(Math.abs(aapl.pct - 75) < 1e-9, "pct = value / filing total");
  const baba = b.positions.find((x) => x.put === "put");
  assert.ok(baba, "putCall rows keep their put identity — never merged into a common line");
  const prn = b.positions.find((x) => x.cusip === "999999999");
  assert.equal(prn.shares, null, "a PRN row's aggregate claims NO share count — honest null, value still real");
  assert.equal(prn.value, 200);
  assert.equal(C.parse13FInfotable("<x>no tables</x>"), null, "zero holdings -> null, never an empty book");
});

test("whale pure: delta classes — new/add/trim/exit/flat, value-only when shares aren't comparable, no-prev claims nothing", () => {
  const C = require("../src/compute");
  const P = (cusip, value, shares, put) => ({ cusip, put: put || null, name: cusip, cls: null, value, shares, pct: null });
  const cur = { total: 100, n: 4, positions: [P("AAA", 40, 40), P("BBB", 30, 10), P("CCC", 20, null), P("DDD", 10, 10)] };
  const prev = { total: 90, n: 4, positions: [P("AAA", 35, 30), P("BBB", 40, 20), P("CCC", 25, null), P("EEE", 5, 5)] };
  const d = C.whaleDelta(cur, prev);
  assert.equal(d.rows.find((r) => r.cusip === "AAA").d.cls, "add");
  assert.equal(d.rows.find((r) => r.cusip === "AAA").d.dSh, 10, "share delta claimed when both legs are SH");
  assert.equal(d.rows.find((r) => r.cusip === "BBB").d.cls, "trim");
  const ccc = d.rows.find((r) => r.cusip === "CCC").d;
  assert.equal(ccc.dSh, null, "no share delta across incomparable legs");
  assert.equal(ccc.cls, "trim", "value moved -> still classed, by value");
  assert.equal(d.rows.find((r) => r.cusip === "DDD").d.cls, "new");
  assert.equal(d.lanes.exited.length, 1); assert.equal(d.lanes.exited[0].cusip, "EEE");
  assert.equal(d.flows.opened, 10); assert.equal(d.flows.exited, -5);
  const noPrev = C.whaleDelta(cur, null);
  assert.equal(noPrev.hasPrev, false);
  assert.ok(noPrev.rows.every((r) => r.d.cls === "na"), "without a prior filing NOTHING is classed new — no delta is claimed");
  // Mark-to-market drift with unchanged shares is not a trade.
  const flat = C.whaleDelta({ total: 50, n: 1, positions: [P("AAA", 50, 30)] }, { total: 40, n: 1, positions: [P("AAA", 40, 30)] });
  assert.equal(flat.rows[0].d.cls, "flat", "same shares, different mark -> flat, not 'add'");
});

test("whale pure: name normalization is symmetric and conservative; filing window rolls weekend deadlines only", () => {
  const C = require("../src/compute");
  assert.equal(C.whaleNameKey("ALIBABA GROUP HLDG ADR"), C.whaleNameKey("Alibaba Group Holding Limited"));
  assert.equal(C.whaleNameKey("OCCIDENTAL PETE"), C.whaleNameKey("Occidental Petroleum Corp"));
  assert.equal(C.whaleNameKey("BERKSHIRE HATHAWAY INC CL B"), "BERKSHIRE HATHAWAY", "class suffixes strip, trailing single letters strip");
  assert.notEqual(C.whaleNameKey("MICRON TECHNOLOGY"), C.whaleNameKey("MICRO TECHNOLOGY"), "no fuzzy matching — near-names stay distinct");
  const w = C.whaleWindow(Date.UTC(2026, 7, 16));   // Aug 16 2026: Q2 deadline (Aug 14, a Friday) just passed
  assert.equal(w.cur.q, "Q2 2026"); assert.equal(w.state, "closed");
  assert.equal(new Date(w.cur.deadline).getUTCDay(), 5, "Jun 30 + 45d lands Fri Aug 14 — no roll needed");
  const w3 = C.whaleWindow(Date.UTC(2026, 9, 20));  // Oct 20: Q3 window open; Sep 30 + 45d = Sat Nov 14 -> rolls to Mon
  assert.equal(w3.cur.q, "Q3 2026"); assert.equal(w3.state, "open");
  assert.equal(new Date(w3.cur.deadline).getUTCDay(), 1, "weekend due date rolls to Monday");
  assert.equal(C.whaleQOfPeriod("2026-06-30"), "Q2 2026");
});

test("whale pure: season lanes carry per-fund legs, domPct discloses single-whale consensus, crowding states per fund", () => {
  const C = require("../src/compute");
  const P = (cusip, value, shares) => ({ cusip, put: null, name: cusip + " CORP", cls: null, value, shares, pct: null });
  const A = { key: "A", cur: { total: 1000, n: 2, positions: [P("NVDA1", 900, 90), P("UNH1", 100, 10)] },
              prev: { total: 800, n: 1, positions: [P("NVDA1", 800, 80)] } };
  const B = { key: "B", cur: { total: 100, n: 1, positions: [P("NVDA1", 100, 11)] },
              prev: { total: 95, n: 1, positions: [P("NVDA1", 95, 10)] } };
  const s = C.whaleSeason([A, B]);
  assert.equal(s.nFunds, 2);
  const nv = s.bought.find((r) => r.cusip === "NVDA1");
  assert.ok(nv, "both funds added NVDA1 -> most-bought lane");
  assert.equal(nv.legs.length, 2, "per-fund legs ride the row verbatim");
  assert.ok(nv.domPct > 90, "one whale is ~95% of the flow and the row SAYS so");
  const op = s.opens.find((r) => r.cusip === "UNH1");
  assert.ok(op && op.n === 1 && op.funds[0].key === "A", "opens lane: who opened, with size");
  const cr = s.crowd.find((r) => r.cusip === "NVDA1");
  assert.ok(cr && cr.held === 2, "crowding: held by both");
  assert.equal(cr.state.A, "add"); assert.equal(cr.state.B, "add");
});

test("focus -17.03: foldLiveMark widens extremes with the mark and never touches VWAP", () => {
  const base = { hi: 105, lo: 99, vwap: 102.5, openPx: 100, lastPx: 104, bars: 4 };
  const up = foldLiveMark(base, 107);
  assert.equal(up.hi, 107, "a mark above the closed-bar high widens it");
  assert.equal(up.lo, 99, "…without touching the low");
  assert.equal(up.lastPx, 107, "last is the mark");
  assert.equal(up.vwap, 102.5, "VWAP is untouched — a mark has no volume, folding it would fabricate weight");
  assert.equal(up.openPx, 100, "openPx stays archive-only");
  const inside = foldLiveMark(base, 101);
  assert.equal(inside.hi, 105, "an inside mark widens nothing");
  assert.equal(inside.lastPx, 101, "…but still refreshes last");
  const bare = foldLiveMark(null, 88);
  assert.deepEqual(bare, { hi: 88, lo: 88, vwap: null, openPx: null, lastPx: 88, bars: 0 },
    "no closed bars yet: the mark alone is the forming read, VWAP/open honestly null");
  assert.equal(foldLiveMark(base, null), base, "no mark -> the stats pass through untouched");
  assert.equal(foldLiveMark(null, null), null, "nothing in, nothing out");
});

test("focus -17.03: a partial forming window is a real read at minBars=1", () => {
  const M5 = 5 * 60 * 1000, open = Date.UTC(2026, 7, 17, 13, 30);
  const bars = [[open, 100, 101.5, 99.5, 101, 500], [open + M5, 101, 102, 100.8, 101.7, 400]];
  const g = fhStats(bars, open, open + 12 * 60 * 1000, 1);
  assert.ok(g && g.bars === 2 && g.hi === 102 && g.lo === 99.5, "two closed bars form a read under minBars=1");
  assert.ok(g.vwap != null, "volume present -> a forming VWAP exists");
  assert.equal(fhStats([], open, open + M5, 1), null, "zero closed bars is still no read — the fold supplies the mark-only case");
});

test("focus -04: the limits sanitizer clamps to the backstop — a bad write can loosen nothing", () => {
  assert.deepEqual(focusLimits(null), { vol: FOCUS_HARD_VOL, oi: FOCUS_HARD_OI }, "absent config = the hard backstop, never an open wall");
  assert.deepEqual(focusLimits({}), { vol: FOCUS_HARD_VOL, oi: FOCUS_HARD_OI }, "empty object degrades the same way");
  assert.deepEqual(focusLimits({ vol: 5e6, oi: 750000 }), { vol: 5e6, oi: 750000 }, "an honest pair passes through");
  assert.deepEqual(focusLimits({ vol: "5000000", oi: "750000" }), { vol: 5e6, oi: 750000 }, "numeric strings (a JSON round-trip, a form post) coerce");
  // THE FAILURE MODE THIS CLAMP EXISTS FOR: NaN comparisons are all false, so a NaN floor would
  // have passed EVERY name and silently disabled the wall rather than tightening it.
  assert.deepEqual(focusLimits({ vol: NaN, oi: NaN }), { vol: FOCUS_HARD_VOL, oi: FOCUS_HARD_OI }, "NaN degrades to the backstop, never to an open wall");
  assert.deepEqual(focusLimits({ vol: "abc", oi: {} }), { vol: FOCUS_HARD_VOL, oi: FOCUS_HARD_OI }, "garbage degrades identically");
  assert.deepEqual(focusLimits({ vol: -1, oi: -1 }), { vol: FOCUS_HARD_VOL, oi: FOCUS_HARD_OI }, "negatives cannot dig under the backstop");
  assert.deepEqual(focusLimits({ vol: 1000, oi: 0 }), { vol: FOCUS_HARD_VOL, oi: FOCUS_HARD_OI }, "a floor BELOW the backstop resolves to the backstop — effective floor is max(hard, yours)");
  assert.equal(focusLimits({ vol: 5e6 + 0.7 }).vol, 5000001, "floors are whole dollars");
  assert.deepEqual(focusLimits(focusLimits({ vol: 5e6, oi: 750000 })), { vol: 5e6, oi: 750000 }, "idempotent — re-sanitizing a sanitized pair is a no-op");
});

test("focus -04: a missing OI read never fails the OI floor — refusing on a number we do not have is fabrication", () => {
  const L = { vol: 1e6, oi: 1e6 };
  assert.equal(focusFloorFail({ ticker: "A", vol: 9e6, oi: 9e6 }, L), null, "clears both");
  assert.equal(focusFloorFail({ ticker: "B", vol: 1e5, oi: 9e6 }, L), "vol", "thin tape");
  assert.equal(focusFloorFail({ ticker: "C", vol: 9e6, oi: 1e5 }, L), "oi", "thin book");
  assert.equal(focusFloorFail({ ticker: "D", vol: 1e5, oi: 1e5 }, L), "both", "both walls, disclosed as both");
  // The honest-null contract, matching the OI Δ column: absent is not zero.
  assert.equal(focusFloorFail({ ticker: "E", vol: 9e6, oi: null }, L), null, "null OI CLEARS the OI wall — the volume wall still judges it");
  assert.equal(focusFloorFail({ ticker: "F", vol: 9e6 }, L), null, "an absent oi field behaves the same as an explicit null");
  assert.equal(focusFloorFail({ ticker: "G", vol: 1e5, oi: null }, L), "vol", "…and a null-OI name can still fail on volume alone, never 'both'");
  assert.equal(focusFloorFail({ ticker: "H", vol: 9e6, oi: NaN }, L), null, "an unusable OI number is an absence, not a zero");
  // Boundary: the floor is a floor, not a strict inequality — a name AT the wall clears it.
  assert.equal(focusFloorFail({ ticker: "I", vol: 1e6, oi: 1e6 }, L), null, "exactly at both walls clears");
  assert.equal(focusFloorFail({ ticker: "J", vol: 1e6 - 1, oi: 1e6 }, L), "vol", "one dollar under does not");
  // A candidate with no volume at all is refused, not admitted by an undefined comparison.
  assert.equal(focusFloorFail({ ticker: "K" }, L), "vol", "a name with no volume read is refused on volume");
});

test("focus -04: focusGate splits cleared from refused, loudest-first, with the multiple the floor must fall by", () => {
  const mk = (t, vol, oi, gs) => ({ ticker: t, vol, oi, gapSigma: gs, cluster: "X" });
  const cands = [mk("PASS1", 9e6, 9e6, 1), mk("QUIET", 1e5, 9e6, 0.2), mk("LOUD", 1e5, 9e6, 3.5),
    mk("BOOK", 9e6, 1e5, 1.5), mk("NOOI", 9e6, null, 2), mk("BOTH", 5e5, 5e5, 2.5)];
  const g = focusGate(cands, { vol: 1e6, oi: 1e6 });
  assert.deepEqual(g.pass.map((c) => c.ticker), ["PASS1", "NOOI"], "cleared keeps candidate order — the caller ranks, the gate does not");
  assert.equal(g.scanned, 6, "scanned counts the whole field the wall judged");
  assert.equal(g.belowN, 4, "belowN is the TRUE refused count, not the disclosed slice");
  // Loudest-first is the whole point: the top row is the loudest thing the wall is refusing.
  assert.deepEqual(g.below.map((c) => c.ticker), ["LOUD", "BOTH", "BOOK", "QUIET"], "refused set is ordered by loudness, not alphabetically");
  const by = (t) => g.below.find((c) => c.ticker === t);
  assert.equal(by("LOUD").why, "vol"); assert.equal(by("BOOK").why, "oi"); assert.equal(by("BOTH").why, "both");
  assert.equal(by("LOUD").need, 10, "the volume floor would have to fall 10× to admit LOUD");
  assert.equal(by("BOOK").need, 10, "the OI floor would have to fall 10× to admit BOOK");
  assert.equal(by("BOTH").need, 2, "a both-fail reports the BINDING wall (the larger drop), never the easier one");
  assert.ok(g.below.every((c) => typeof c.score === "number"), "loudness rides along so the roster can show what it is refusing");
  assert.deepEqual(g.limits, { vol: 1e6, oi: 1e6 }, "the gate reports the wall it actually applied");
  // The disclosed roster is capped; the count is not.
  const many = Array.from({ length: 40 }, (_, i) => mk("T" + String(i).padStart(2, "0"), 1e5, 9e6, 1));
  const g2 = focusGate(many, { vol: 1e6, oi: 0 });
  assert.equal(g2.below.length, FOCUS_BELOW_N, "roster discloses the loudest N");
  assert.equal(g2.belowN, 40, "…while the count stays honest about the whole tail");
  assert.equal(focusGate(many, { vol: 1e6, oi: 0 }, 3).below.length, 3, "N is honoured");
  // Degenerates: a gate is a filter, never a thrower.
  assert.deepEqual(focusGate(null, null).pass, [], "null candidate list degrades");
  assert.deepEqual(focusGate([{ nope: 1 }, null, { ticker: "" }], null).pass, [], "malformed candidates are dropped, never thrown on");
  // No floors set (the backstop only) must still refuse a genuinely untradeable name.
  const g3 = focusGate([mk("DUST", 1000, 1000, 3)], null);
  assert.equal(g3.pass.length, 0, "the backstop still bites when no operator floor is set");
});

// ============================================================================================
// FOCUS -05 (build 2026.08.18-04): the opening hour on 1m, a capture lane the seats own, and a
// dash that states its own cause. The defect this replaces: four of six seats reached 10:37 with
// zero bars, and foldLiveMark turned the mark into hi = lo = last, so the board printed a flat
// line at the current price that was indistinguishable from a real first-hour measurement.
// ============================================================================================

test("focus -05: a seat with no bars produces NO record — the mark can widen a measurement, never be one", () => {
  const { firstHourStats, foldLiveMark } = require("../src/compute");
  const open = Date.UTC(2026, 7, 18, 13, 30);
  // THE REGRESSION, stated as an assertion. foldLiveMark(null, px) still synthesises a
  // single-point record — that behaviour is correct and load-bearing for a hour that HAS bars but
  // whose latest extreme is the live mark. What changed is that the forming builder no longer
  // feeds it a null: with zero bars there is nothing to widen and no record is published.
  const synth = foldLiveMark(null, 20.127);
  assert.deepEqual([synth.hi, synth.lo, synth.lastPx, synth.bars], [20.127, 20.127, 20.127, 0],
    "the fold's null path still fabricates a flat point — which is exactly why it must not be reached with zero bars");
  assert.equal(synth.vwap, null, "…and it cannot claim a VWAP, which is how the screenshot's dashed sVWAP sat beside numeric HI/LO");
  assert.equal(firstHourStats([], open, open + 3600e3, 1), null, "no bars in the window -> no stats, at any minBars");
  // A real one-bar hour is still a real read: the fix must not throw the honest single-bar case out.
  const one = firstHourStats([[open, 100, 101, 99, 100.5, 5000]], open, open + 3600e3, 1);
  assert.ok(one && one.bars === 1 && one.hi === 101, "one closed 1m bar is a measurement and stays one");
  const widened = foldLiveMark(one, 103);
  assert.equal(widened.hi, 103, "the mark widens the extreme");
  assert.equal(widened.vwap, one.vwap, "…and never touches VWAP — a mark carries no volume");
});

test("focus -05: sessionCloseStats is bounded by the window at BOTH ends", () => {
  const { sessionCloseStats } = require("../src/compute");
  const M = 60000, O = 1000000, C = O + 10 * M;
  const bars = [];
  for (let i = -5; i < 15; i++) bars.push([O + i * M, 10 + i, 11 + i, 9 + i, 10 + i, 100]);
  const s = sessionCloseStats(bars, O, C);
  assert.equal(s.closePx, 19, "the last bar INSIDE the window (t = close - 1m), not the tape beyond it");
  assert.equal(s.openPx, 10, "the first bar inside it, not the pre-market ones before");
  assert.equal(s.bars, 10, "exactly the ten in-window bars");
  assert.equal(s.slopMs, M, "one bar of slop on a complete window");
  // Unsorted input must not change the answer — the archive is not guaranteed ordered.
  const shuffled = bars.slice().reverse();
  assert.equal(sessionCloseStats(shuffled, O, C).closePx, 19, "order of the input does not decide the close");
  assert.equal(sessionCloseStats([], O, C), null, "no bars -> null, never a zero");
  assert.equal(sessionCloseStats(bars, C, O), null, "an inverted window is refused rather than guessed");
  // A window whose last bar sits well short of the close reports the gap rather than hiding it.
  const short = bars.filter((b) => b[0] < C - 4 * M);
  assert.equal(sessionCloseStats(short, O, C).slopMs, 5 * M, "the slop is the evidence the close is not the close");
});

test("congress -04: PTR parsing — real PDF bytes, subset fonts, wrapped assets, bands never midpointed", () => {
  const { pdfTextRuns, ptrRows, parsePtr, ptrBand, ptrTicker } = require("../src/compute");
  const HEAD = [[60, 700, "ID"], [250, 700, "Asset"], [365, 700, "Transaction Type"], [425, 700, "Date"], [500, 700, "Notification Date"], [560, 700, "Amount"]];
  const body = [
    [60, 680, "SP"], [90, 680, "Apple Inc. (AAPL) [ST]"], [365, 680, "P"], [425, 680, "08/13/2026"], [500, 680, "08/14/2026"], [560, 680, "$1,001 - $15,000"],
    [90, 660, "Lockheed Martin Corp (LMT) [ST]"], [365, 660, "S"], [425, 660, "07/22/2026"], [500, 660, "07/25/2026"], [560, 660, "$50,001 - $100,000"],
    [60, 640, "DC"], [90, 640, "Microsoft Corp (MSFT) [ST]"], [365, 640, "S (partial)"], [425, 640, "02/11/2026"], [500, 640, "02/12/2026"], [560, 640, "$250,001 - $500,000"],
    [90, 620, "Extremely Long Fund Name With Many"], [365, 620, "P"], [425, 620, "01/05/2026"], [500, 620, "01/07/2026"], [560, 620, "Over $50,000,000"],
    [90, 606, "Words Series B Interest (BIGF)"],                    // the wrap, no band and no date
    [90, 400, "Footer note far below — must not attach"],       // too far below to be a wrap
  ];
  // Plain and Flate-compressed content streams must produce identical results.
  for (const flate of [false, true]) {
    const out = parsePtr(ptrRows(pdfTextRuns(_mkPtrPdf(HEAD.concat(body), { flate }))));
    assert.equal(out.tx.length, 4, "four transactions, header and footer are not trades (flate=" + flate + ")");
    const [aapl, lmt, msft, big] = out.tx;
    assert.equal(aapl.owner, "spouse", "the SP owner code is read, not swallowed into the asset");
    assert.equal(aapl.ticker, "AAPL");
    assert.equal(aapl.act, "buy");
    assert.equal(aapl.txDate, "2026-08-13");
    assert.equal(aapl.notified, "2026-08-14", "both clocks are kept — the legal one starts at notification");
    assert.deepEqual([aapl.loAmt, aapl.hiAmt], [1001, 15000], "BOTH band ends stored; no midpoint exists anywhere");
    assert.equal(lmt.owner, "self", "a row with no owner code is the member's own trade");
    assert.equal(lmt.act, "sell");
    assert.equal(msft.owner, "dependent");
    assert.equal(msft.act, "sell-partial", "a partial sale is not rounded up into a full exit");
    assert.ok(/Extremely Long Fund Name With Many Words Series B Interest/.test(big.asset),
      "a wrapped asset name is rejoined from the continuation line");
    assert.equal(big.ticker, "BIGF", "and the ticker hiding on the continuation line is recovered");
    assert.deepEqual([big.loAmt, big.hiAmt], [50000000, null], "an open-ended top band has no upper bound to invent");
    assert.ok(!out.tx.some((t) => /Footer note/.test(t.asset)), "a distant line is never glued onto a trade");
  }
  // Subset font: the content stream carries glyph indices; only /ToUnicode says what they mean.
  const alpha = " ()$,-./0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";
  const code = new Map(); alpha.split("").forEach((ch, i) => code.set(ch, i + 1));
  const sub = parsePtr(ptrRows(pdfTextRuns(_mkPtrPdf([
    [90, 680, "Nvidia Corp (NVDA)"], [365, 680, "P"], [425, 680, "08/13/2026"], [500, 680, "08/14/2026"], [560, 680, "$1,000,001 - $5,000,000"],
  ], { subset: true, code }))));
  assert.equal(sub.tx.length, 1, "a subset-font filing parses rather than yielding garbage");
  assert.equal(sub.tx[0].ticker, "NVDA");
  assert.deepEqual([sub.tx[0].loAmt, sub.tx[0].hiAmt], [1000001, 5000000]);
  // A scanned filing has no text operators at all — detectable, not guessable.
  assert.equal(pdfTextRuns(Buffer.from("%PDF-1.4\n1 0 obj\n<< /Type /Catalog >>\nendobj\n%%EOF", "latin1")).length, 0,
    "an image-only filing yields zero runs, which is how the queue knows it is permanently unreadable");
  // Bands and tickers on their own.
  assert.deepEqual(ptrBand("$15,001 - $50,000"), { lo: 15001, hi: 50000 });
  assert.deepEqual(ptrBand("$50,000,000 +"), { lo: 50000000, hi: null });
  assert.equal(ptrBand("no amount here"), null, "an unreadable band is null, never a zero and never a guess");
  assert.equal(ptrTicker("Some Private LLC Interest"), null, "no parenthetical ticker means unresolved, not fuzzy-matched");
  assert.equal(ptrTicker("Berkshire Hathaway (BRK.B)"), "BRK.B", "a dotted class ticker survives");
  assert.equal(ptrTicker("Something (N/A)"), null, "a placeholder is not a ticker");
});

test("congress -31: the checkbox form is a wall, and it is recognised as one", () => {
  // The end of the OCR road, established from a real filing rather than reasoned about. diag ran
  // OCR on a scanned PTR and returned 1331 characters — so the engine reads it fine — including:
  //   "Exceed. Partial $1001. | 515001 | $50,001 |$100,00- |S250001 | $500.001 | $1,000,001"
  // Those tiers are COLUMN HEADERS. On this layout the filer ticks a box beneath the right one, so
  // the amount is never printed on the row. No recognition quality recovers it: the value is the
  // x-position of a pencil mark on a skewed bilevel scan. Reading that needs mark detection against
  // column geometry, and getting it wrong means printing a number nobody wrote.
  const { ocrPtrRows, ocrCheckboxForm } = require("../src/compute");
  const real = [
    "NAME. RoR: Khanna P { 8 8",
    "Cr TI re Ts Te Tel Ue [ow IT TT 5] \"x |",
    "Exceed. Partial $1001. | 515001 | $50,001 |$100,00- |S250001 | $500.001 | $1,000,001 | $5000.00",
    "5% 01/01/27 1) 07/08/26 08/03/26",
    "CMN 07/27/26] _ 08/03/26",
  ].join("\n");
  assert.ok(ocrCheckboxForm(real), "the header band of tier boundaries identifies the layout");
  const r = ocrPtrRows(real, { filed: "2026-08-24" });
  assert.equal(r.rows.length, 0, "nothing is recovered, because nothing recoverable is present");
  assert.ok(r.checkbox, "and it is reported as a LAYOUT wall, not as a validation failure");
  assert.ok(/ticked box/.test(r.dropped[0].why), "with a reason that says why no retry will help");
  // A typed scan is a different document and must still go down the normal path. These forms write
  // two-digit years, which costs nothing to accept and is unambiguous inside this data set.
  const typed = ocrPtrRows("SP Apple Inc. (AAPL) [ST] P 08/13/26 08/14/26 $1,001 - $15,000",
    { filed: "2026-08-24", known: () => true });
  assert.equal(typed.rows.length, 1, "a typed scan still yields its row");
  assert.equal(typed.rows[0].txDate, "2026-08-13", "07/08/26 style dates resolve inside the data set's range");
  assert.ok(!typed.checkbox);
});

test("congress -25: the OCR gate rejects what OCR gets wrong", () => {
  // Measured, not assumed. A PTR table was rendered and photographed, then read by the engine that
  // would do this in production. What came back, verbatim:
  //   'SP Apple Inc. (AAPL) [ST] P 08/13/2026 08/1472026 $1,001 - $15,000'   <- notification mangled
  //   'NVIDIA Corporation (NVDA) [ST] s 07/22/2026 077252026 $15,001 - $50,000'  <- lowercase s
  //   'JT Microsoft Corp (MSFT) [ST] 3 06/02/2026 06/03/2026 $250,001 - $500,000' <- P read as 3
  // Amounts, tickers and trade dates survived exactly; a transaction TYPE did not. Since a misread
  // digit inside an amount is indistinguishable from a real one, nothing here is repaired: a field
  // is unambiguously well-formed or its row is dropped and counted.
  const { ocrPtrRows } = require("../src/compute");
  const known = (t) => ["AAPL", "NVDA", "MSFT"].includes(t);
  const r = ocrPtrRows([
    "SP Apple Inc. (AAPL) [ST] P 08/13/2026 08/1472026 $1,001 - $15,000",
    "NVIDIA Corporation (NVDA) [ST] s 07/22/2026 077252026 $15,001 - $50,000",
    "JT Microsoft Corp (MSFT) [ST] 3 06/02/2026 06/03/2026 $250,001 - $500,000",
    "SP Fake Corp (FAKE) [ST] P 05/01/2026 05/02/2026 $16,001 - $50,000",
  ].join("\n"), { filed: "2026-08-24", known });
  assert.equal(r.rows.length, 2, "two of the four lines are trustworthy");
  assert.equal(r.rows[0].ticker, "AAPL");
  assert.deepEqual([r.rows[0].loAmt, r.rows[0].hiAmt], [1001, 15000]);
  assert.equal(r.rows[0].owner, "spouse");
  assert.equal(r.rows[1].act, "sell", "a lowercase s is a FONT, not an ambiguity — that row is real");
  assert.equal(r.rows[0].notified, null, "notification dates are never trusted from OCR: two of three were mangled");
  assert.ok(r.rows.every((x) => x.src === "ocr"), "and every row is marked as OCR-derived");
  const why = r.dropped.map((d) => d.why);
  assert.ok(why.some((w) => /transaction type/.test(w)),
    "'3' is not a transaction type, and guessing which letter it was is how a sale becomes a purchase");
  assert.ok(why.some((w) => /not one of the disclosed tiers/.test(w)),
    "$16,001 is not a band that exists — a misread digit must not pass as the tier next to it");
  // A trade dated after its own filing is rejected here too, at the source rather than in the panel.
  const late = ocrPtrRows("SP Apple Inc. (AAPL) [ST] P 12/26/2026 12/27/2026 $1,001 - $15,000",
    { filed: "2026-02-09", known });
  assert.equal(late.rows.length, 0);
  assert.ok(/after the filing/.test(late.dropped[0].why));
  // An unverifiable ticker is not invented: OCR turns O into 0 and I into 1.
  const unk = ocrPtrRows("Some Corp (ZZZZ) [ST] P 08/13/2026 08/14/2026 $1,001 - $15,000",
    { filed: "2026-08-24", known });
  assert.equal(unk.rows.length, 1, "the row is still real");
  assert.equal(unk.rows[0].ticker, null, "but a ticker the universe cannot confirm stays unresolved");
});

test("congress -24: image data is not text — a scan was masquerading as an unparseable layout", () => {
  // congress diag khanna, on production: 475KB, /BitsPerComponent, 38 streams, and SEVEN text runs
  // of binary garbage at the origin. The document is a photograph. My test for "this stream has
  // text" was whether it contained the two bytes "BT", which a 475KB JPEG contains by chance — so
  // image data got parsed as PostScript, emitted noise, and because runs.length > 0 the
  // scanned-image detector never ran. 148 filings were filed under "read but no rows recognized"
  // when the truth was "there is nothing here to read".
  const { pdfTextRuns } = require("../src/compute");
  const noise = Buffer.alloc(4000);
  for (let i = 0; i < noise.length; i++) noise[i] = (i * 77) % 256;
  noise.write("BT", 100); noise.write("(garbage)", 300); noise.write("BT", 900);
  const dict = "<< /Type /XObject /Subtype /Image /Width 1700 /Height 2200 /BitsPerComponent 8"
    + " /Filter /DCTDecode /Length " + noise.length + " >>";
  const scan = Buffer.concat([
    Buffer.from("%PDF-1.5\n1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n"
      + "2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n"
      + "3 0 obj\n<< /Type /Page /Parent 2 0 R /Contents 4 0 R >>\nendobj\n4 0 obj\n" + dict + "\nstream\n", "latin1"),
    noise,
    Buffer.from("\nendstream\nendobj\ntrailer\n<< /Size 5 /Root 1 0 R >>\n%%EOF\n", "latin1"),
  ]);
  assert.equal(pdfTextRuns(scan).length, 0,
    "a photographed filing yields NO text, so the queue can call it a scan instead of a layout it failed to read");
  // And a real text filing is untouched by the exclusion.
  const ok = _encPdf({ aes: false });
  assert.ok(pdfTextRuns(ok).length > 0, "an actual text filing still parses");
});

test("congress -19: the alert actually formats — a ticker-less event was dying silently", () => {
  // The whole alert lane was inert and nothing said so. pushFmt returns null for any event with no
  // ticker, so a congress alert entered the trigger ring and then vanished between there and the
  // wire: starred, fired, formatted to nothing, never delivered. A subject that is a PERSON rather
  // than a symbol has to be exempted explicitly, the way regime and macro already are.
  const { pushFmt, pushEligible, PUSH_CLASSES } = require("../src/compute");
  // ONE LINE PER TRADE. The first cut aggregated — "3 transactions · 2 buy · 1 sell" — which reads
  // as informative and tells you nothing you can act on: not which name was bought, not which was
  // sold, not for how much. A PTR's value is per-instrument, so that is the unit.
  const ev = { kind: "congress", member: "Pelosi, Nancy", dist: "CA-11",
    filed: "2026-08-24", traded: "2026-08-13",
    rows: [
      { name: "NVDA", act: "buy", lo: 1000001, hi: 5000000, date: "2026-08-13", owner: "spouse" },
      { name: "AAPL", act: "buy", lo: 1001, hi: 15000, date: "2026-08-17", owner: "self" },
      { name: "BE", act: "sell-partial", lo: 500001, hi: 1000000, date: "2026-07-28", partial: true, owner: "self" },
    ],
    url: "https://disclosures-clerk.house.gov/public_disc/ptr-pdfs/2026/20033725.pdf" };
  const msg = pushFmt(ev, { baseUrl: "https://example.test" });
  assert.ok(msg, "a congress event formats at all — this is the assertion that was false");
  assert.ok(/Pelosi, Nancy/.test(msg) && /CA-11/.test(msg), "who filed, and from where");
  assert.ok(/NVDA/.test(msg) && /\$1,000,001.\$5,000,000/.test(msg), "each ticker carries its OWN amount");
  assert.ok(/AAPL/.test(msg) && /\$1,001.\$15,000/.test(msg), "including the small one");
  assert.ok(/BE/.test(msg) && /SELL/.test(msg) && /part/.test(msg), "and the direction of each, partials marked");
  assert.ok(/3 trades/.test(msg), "the count is a header, not a substitute for the detail");
  assert.ok(/filed 2026-08-24/.test(msg) && /11d after the trade/.test(msg), "with the lag stated once");
  // A long filing must not exceed Telegram's hard 4096 limit, and must say what it dropped.
  const many = { kind: "congress", member: "Prolific Filer", filed: "2026-08-24", traded: "2026-08-13",
    rows: Array.from({ length: 60 }, (_, i) => ({ name: "TICK" + i, act: "buy", lo: 1000001, hi: 5000000, date: "2026-08-13" })) };
  const big = pushFmt(many, {});
  assert.ok(big.length < 4096, "a fifty-line filing still fits the wire: " + big.length);
  assert.ok(/\+ 46 more on the filing/.test(big), "and says how many it could not show, rather than looking complete");
  assert.ok(/ptr-pdfs\/2026\/20033725\.pdf/.test(msg), "and the source document");
  assert.ok(PUSH_CLASSES.includes("congress"));
  assert.equal(pushEligible(ev, { classes: ["congress"] }, {}) !== false, true,
    "and it survives the eligibility gate without a ticker to threshold on");
});

test("congress -13: the real filing shape — flipped page, and a transaction split across rows", () => {
  // Everything here comes from one production diag, and none of it was guessable:
  //   1. these pages draw through a FLIP, so raw text y grows DOWNWARD. Read naively, every row
  //      ordered bottom-to-top and a transaction's continuation line sorted ABOVE its trade.
  //   2. a transaction is a GROUP of rows. The trade line runs out of width, so the amount band is
  //      split ("$250,001 -" on the trade line, "$500,000" beneath it) and the asset's tail — a
  //      maturity date, the asset-type code — continues underneath.
  // Requiring a complete band on one row found nothing in documents that were parsing perfectly.
  const { pdfTextRuns, ptrRows, parsePtr } = require("../src/compute");
  const mk = (lines) => {
    let c = "q\n1 0 0 -1 0 792 cm\nBT\n/F1 9 Tf\n";          // the flip these filings use
    for (const [x, y, t] of lines) c += `1 0 0 1 ${x} ${y} Tm\n(${t.replace(/([()\\])/g, "\\$1")}) Tj\n`;
    c += "ET\nQ\n";
    const objs = ["<< /Type /Catalog /Pages 2 0 R >>", "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
      "<< /Type /Page /Parent 2 0 R /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>", null,
      "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>"];
    let out = "%PDF-1.4\n";
    objs.forEach((d, i) => { const n = i + 1;
      if (n === 4) out += `${n} 0 obj\n<< /Length ${c.length} >>\nstream\n${c}\nendstream\nendobj\n`;
      else out += `${n} 0 obj\n${d}\nendobj\n`; });
    return Buffer.from(out + "trailer\n<< /Size 6 /Root 1 0 R >>\n%%EOF\n", "latin1");
  };
  const rows = ptrRows(pdfTextRuns(mk([
    [128, 46, "P"], [286, 46, "T"], [508, 46, "R"],                     // the letter-spaced title
    [63, 97, "Clerk of the House of Representatives"],
    [30, 300, "JT"], [70, 300, "Washington ST 5% Go Utx Due"], [330, 300, "P"],
    [380, 300, "08/07/2026"], [460, 300, "08/07/2026"], [545, 300, "$250,001 -"],
    [70, 312, "08/01/30"], [250, 312, "[GS]"], [545, 312, "$500,000"],   // the continuation
    [30, 340, "SP"], [70, 340, "Nvidia Corp (NVDA) [ST]"], [330, 340, "S"],
    [380, 340, "07/22/2026"], [460, 340, "07/25/2026"], [545, 340, "$15,001 - $50,000"],
  ])));
  assert.ok(/P \| T \| R/.test(rows[0].cells.map((c) => c.text).join(" | ")),
    "the page title sorts FIRST — the flip is honoured, so rows read top to bottom");
  const out = parsePtr(rows);
  assert.equal(out.tx.length, 2, "both trades are found");
  const muni = out.tx[0];
  assert.equal(muni.owner, "joint");
  assert.deepEqual([muni.loAmt, muni.hiAmt], [250001, 500000],
    "the band's two halves are rejoined across the row break — the whole reason this filing parsed to nothing before");
  assert.equal(muni.atype, "GS", "the asset-type code is captured, not stripped as noise");
  assert.equal(muni.ticker, null, "a municipal bond has no ticker in existence, and none is invented");
  assert.ok(/Washington ST 5% Go Utx Due/.test(muni.asset));
  assert.equal(out.tx[1].ticker, "NVDA");
  assert.equal(out.tx[1].atype, "ST");
  // A band whose halves are separated by a maturity date must not read that date as its upper end.
  const { ptrBand } = require("../src/compute");
  assert.equal(ptrBand("$250,001 - 08/01/30 [GS]"), null,
    "an unterminated band is null rather than a band ending at 8");
  assert.deepEqual(ptrBand("$250,001 - $500,000"), { lo: 250001, hi: 500000 });
});

test("congress -10: an encrypted PTR is decrypted, not mistaken for a scan", () => {
  const { pdfTextRuns, ptrRows, parsePtr, pdfObjects } = require("../src/compute");
  for (const aes of [false, true]) {
    const buf = _encPdf({ aes });
    const objs = pdfObjects(buf);
    assert.ok(objs.encryption, "the encrypt dictionary is detected (" + (aes ? "AES" : "RC4") + ")");
    assert.equal(objs.encryption.aes, aes);
    const runs = pdfTextRuns(buf);
    assert.ok(runs.length > 0, "text comes out of an encrypted filing (" + (aes ? "AES-128" : "RC4-128") + ")");
    const out = parsePtr(ptrRows(runs));
    assert.equal(out.tx.length, 1);
    assert.equal(out.tx[0].ticker, "NVDA");
    assert.deepEqual([out.tx[0].loAmt, out.tx[0].hiAmt], [1000001, 5000000]);
  }
  // The delimiter EOL before "endstream" is NOT stream data. Including it is invisible to a stream
  // cipher — zlib ignores one trailing byte — but it makes an AES ciphertext length indivisible by
  // 16, so the block cipher refuses it and a perfectly readable document reads as unparseable.
  // /Length is authoritative and is what settles it.
  const aesBuf = _encPdf({ aes: true });
  const objs2 = pdfObjects(aesBuf);
  assert.ok(objs2.get(4) && objs2.get(4).data && objs2.get(4).data.length > 0,
    "the content stream survives decryption — the byte-exact length is what makes that possible");
  // AES-256 is not implemented; it must be REPORTED, never silently mishandled.
  const v5 = Buffer.from(String(_encPdf({}).toString("latin1")).replace("/V 2 /R 3", "/V 5 /R 6"), "latin1");
  const objs3 = pdfObjects(v5);
  assert.ok(objs3.encryption && /not implemented/.test(objs3.encryption.unsupported || ""),
    "an unimplemented encryption revision says so rather than pretending the file is empty");
});

test("fomcResult: the decision is the first observation AFTER decision day, the prior the range in force ON it", () => {
  const C = require("../src/compute");
  // The 2026-09-16 hike as FRED's daily target series shows it: the decision-day observation
  // still carries the range going in; the new range takes effect the next day.
  const hist = [
    { d: "2026-09-14", lo: 3.5, hi: 3.75 }, { d: "2026-09-15", lo: 3.5, hi: 3.75 }, { d: "2026-09-16", lo: 3.5, hi: 3.75 },
  ];
  assert.equal(C.fomcResult(hist, "2026-09-16"), null, "decision day itself: nothing published for after the meeting — pend, never 'held'");
  hist.push({ d: "2026-09-17", lo: 3.75, hi: 4.0 });
  assert.deepEqual(C.fomcResult(hist, "2026-09-16"), { actual: { lo: 3.75, hi: 4.0 }, prior: { lo: 3.5, hi: 3.75 } }, "a hike reads as a hike, against the range held going in");
  // A genuine hold: the prior is the range on decision day, NOT the last distinct range months
  // back (which would have printed a stale 'cut').
  const hold = [{ d: "2026-07-28", lo: 4.0, hi: 4.25 }, { d: "2026-07-29", lo: 4.0, hi: 4.25 }, { d: "2026-07-30", lo: 3.75, hi: 4.0 },
    { d: "2026-09-16", lo: 3.75, hi: 4.0 }, { d: "2026-09-17", lo: 3.75, hi: 4.0 }];
  assert.deepEqual(C.fomcResult(hold, "2026-09-16"), { actual: { lo: 3.75, hi: 4.0 }, prior: { lo: 3.75, hi: 4.0 } });
  assert.deepEqual(C.fomcResult(hold, "2026-07-29"), { actual: { lo: 3.75, hi: 4.0 }, prior: { lo: 4.0, hi: 4.25 } }, "the July cut, read the same way");
  // Junk and gaps: a row without both bounds is skipped; no history is null; strings coerce.
  assert.equal(C.fomcResult(null, "2026-09-16"), null);
  assert.equal(C.fomcResult([{ d: "2026-09-17", lo: null, hi: 4 }], "2026-09-16"), null);
  assert.deepEqual(C.fomcResult([{ d: "2026-09-17", lo: "3.75", hi: "4.00" }], "2026-09-16"), { actual: { lo: 3.75, hi: 4 }, prior: { lo: 3.75, hi: 4 } }, "no observation on or before: the prior falls back to the result itself rather than inventing");
  // The message built from that result says hiked, not held.
  const msg = C.pushFmt({ kind: "macro", k: "FOMC", label: "FOMC rate decision", sub: "result", d: "2026-09-16", tEt: "14:00", sep: true,
    prior: { lo: 3.5, hi: 3.75 }, actual: { lo: 3.75, hi: 4.0 } }, {});
  assert.ok(/hiked/.test(msg) && !/held/.test(msg), msg);
});
