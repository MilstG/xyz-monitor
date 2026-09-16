"use strict";
// poller.js — FOCUS lane. Split out of test.js (build 2026.09.16-80); order within the file is the original order.
const test = require("node:test");
const assert = require("node:assert");
const { HOUR, focus07LaneRig, FOCUS_HARD_VOL, FOCUS_HARD_OI, focus04Rig, FOCUS04_FULL, FOCUS04_GRADED, focus05CloseRig } = require("./_shared");


test("focus -01: engine harness — a booting universe never mints a stamp, hydrate rolls prior days to yesterday", () => {
  const { createPoller } = require("../src/poller");
  const { etDayStr: etDS } = require("../src/compute");
  const base = { loadAll: () => new Map(), loadRegime: () => [], loadLedger: () => null,
    saveLedger: () => {}, insert: () => {}, saveRegime: () => {}, saveNews: () => {}, loadNews: () => null };
  // 1) empty universe + an injected trading-day clock past the open: stampFocus defers on the
  //    candidate floor — the tick is a no-op, never a six-seat list of nothing.
  let saved = null;
  const store1 = { ...base, saveFocus: (d) => { saved = d; }, loadFocus: () => null };
  const p1 = createPoller({ dex: "xyz", store: store1, log: () => {}, version: "test" });
  p1.focusTickNow(Date.UTC(2026, 7, 14, 15, 0));    // Fri 2026-08-14 11:00 ET — session open, universe empty
  assert.equal(saved, null, "no candidates -> no stamp persisted");
  assert.equal(p1.getFocus().today, null, "payload carries no phantom list");
  p1.focusTickNow(Date.UTC(2026, 7, 15, 15, 0));    // Saturday — no session, must be a silent no-op
  assert.equal(saved, null, "weekend tick is a no-op");
  // 2) hydrate: a saved list for TODAY restores as today's; a saved PRIOR day rolls to yesterday.
  // 2026.08.18-02: hydrate rolls on the UTC boundary, so a fixture's frozenAt is load-bearing —
  // it is what a pre-utcDay blob's shelf life is derived from. `frozenAt: 3` (the epoch) used to
  // be harmless filler here and is now a lie about when the list was stamped.
  const NOWMS = Date.now(), today = etDS(NOWMS), utcOf = (t) => new Date(t).toISOString().slice(0, 10);
  // open/close are real session bounds, not sentinels (2026.08.18-07). `open: 1, close: 2` alongside
  // a live frozenAt describes a record stamped decades after its own session closed — the exact
  // shape the boot repair now refuses. Filler in a fixture is still a claim about the record.
  const mkState = (day, frozenAt) => ({ day, utcDay: utcOf(frozenAt), open: frozenAt,
    close: frozenAt + 6.5 * 3600e3, frozenAt, late: 0, rows: [{ ticker: "NVDA" }], cuts: [], filledAt: 0 });
  const boot = (state) => { const p = createPoller({ dex: "xyz", store: { ...base, saveFocus: () => {}, loadFocus: () => ({ state, prev: null }) }, log: () => {}, version: "test" });
    p.hydrateFocusNow(); return p.getFocus(); };
  const p2 = createPoller({ dex: "xyz", store: { ...base, saveFocus: () => {}, loadFocus: () => ({ state: mkState(today, NOWMS), prev: null }) }, log: () => {}, version: "test" });
  assert.equal(p2.hydrateFocusNow(), true, "hydrate reports a restore");
  const f2 = p2.getFocus();
  assert.ok(f2.today && f2.today.day === today && f2.today.rows.length === 1, "same-day state restores verbatim");
  const f3 = boot(mkState("2020-01-02", Date.UTC(2020, 0, 2, 14, 0)));
  assert.equal(f3.today, null, "a stale day never masquerades as today's stamp");
  assert.ok(f3.prev && f3.prev.day === "2020-01-02", "…it rolls to the prior-list slot instead");
  // Migration: a blob written before this build carries no utcDay. Its shelf life is derived from
  // frozenAt, so a restart across the boundary retires exactly what the running process would have.
  const legacyFresh = mkState(today, NOWMS); delete legacyFresh.utcDay;
  assert.ok(boot(legacyFresh).today, "legacy blob stamped this UTC day survives the restart");
  const legacyOld = mkState(today, NOWMS - 30 * 3600e3); delete legacyOld.utcDay;
  const f5 = boot(legacyOld);
  assert.equal(f5.today, null, "a legacy blob whose ET day still reads as today but was stamped BEFORE the last 00:00 UTC is retired, not resurrected");
  assert.ok(f5.prev, "…and lands in the prior-list slot, reachable by the toggle");
});

test("focus -02: engine harness — no phantom preview on a booting universe, weekends clear the pool", () => {
  const { createPoller } = require("../src/poller");
  const base = { loadAll: () => new Map(), loadRegime: () => [], loadLedger: () => null,
    saveLedger: () => {}, insert: () => {}, saveRegime: () => {}, saveNews: () => {}, loadNews: () => null,
    saveFocus: () => {}, loadFocus: () => null };
  const p = createPoller({ dex: "xyz", store: base, log: () => {}, version: "test" });
  p.focusTickNow(Date.UTC(2026, 7, 14, 13, 10));   // Fri 09:10 ET — inside the preview window, universe empty
  assert.equal(p.getFocus().preview, null, "below the candidate floor no preview is minted — a prep list of nothing is not shown");
  p.focusTickNow(Date.UTC(2026, 7, 15, 13, 10));   // Saturday — silent no-op
  assert.equal(p.getFocus().preview, null, "weekend keeps the pool clear");
});

test("focus -03 (2026.08.18-02): the day's list retires at 00:00 UTC — weekends included, prior list kept", () => {
  const { createPoller } = require("../src/poller");
  const base = { loadAll: () => new Map(), loadRegime: () => [], loadLedger: () => null,
    saveLedger: () => {}, insert: () => {}, saveRegime: () => {}, saveNews: () => {}, loadNews: () => null };
  const FRI = { day: "2026-08-14", utcDay: "2026-08-14", open: Date.UTC(2026, 7, 14, 13, 30),
    close: Date.UTC(2026, 7, 14, 20, 0), prevCloseT: Date.UTC(2026, 7, 13, 20, 0),
    frozenAt: Date.UTC(2026, 7, 14, 13, 30), late: 0, rows: [{ ticker: "NVDA" }, { ticker: "MU" }],
    cuts: [], filledAt: 0, fillNote: null, pvDiff: null };
  const boot = () => { let saved = null;
    const p = createPoller({ dex: "xyz", version: "test", log: () => {},
      store: { ...base, saveFocus: (d) => { saved = d; }, loadFocus: () => ({ state: JSON.parse(JSON.stringify(FRI)), prev: null }) } });
    p.hydrateFocusNow(Date.UTC(2026, 7, 14, 18, 0));   // boot inside the stamp's own UTC day
    return { p, saved: () => saved };
  };

  // Inside the same UTC day — including after the 16:00 ET cash close — the list stands.
  const a = boot();
  const T_CLOSE = Date.UTC(2026, 7, 14, 20, 30);     // 16:30 ET Fri, still 2026-08-14 UTC
  a.p.focusTickNow(T_CLOSE);
  assert.ok(a.p.getFocus(T_CLOSE).today, "the close does NOT retire the list — the boundary is 00:00 UTC, four hours later");
  // The tick legitimately writes here (the +1h fill lands an hour after the open) — what matters
  // is that the write still carries a live state rather than a retirement.
  assert.ok(!a.saved() || a.saved().state, "any write in-day still carries the stamp, not a retirement");

  // 00:00 UTC crosses (20:00 ET Friday): the list retires and the tab goes empty.
  const T_AFTER = Date.UTC(2026, 7, 15, 0, 1);
  a.p.focusTickNow(T_AFTER);
  const f = a.p.getFocus(T_AFTER);
  assert.equal(f.today, null, "the day's list is gone");
  assert.ok(f.prev && f.prev.day === "2026-08-14", "retired, not deleted — it lands behind the yesterday toggle");
  assert.deepEqual(f.prev.rows.map((r) => r.ticker), ["NVDA", "MU"], "…verbatim, exactly as stamped");
  assert.ok(a.saved() && a.saved().prev && !a.saved().state, "the retirement persisted, so a redeploy can't resurrect it");
  assert.equal(f.state, "cleared", "a stamped-then-retired day reads CLEARED, not 'stamping on the next tick'");

  // THE WEEKEND REGRESSION. Retirement runs before the session gate; the old tick returned early
  // on a day with no session, so a Friday list survived until Monday's stamp.
  const b = boot();
  const T_SAT = Date.UTC(2026, 7, 16, 3, 0);       // Sat 23:00 ET — no cash session that ET day
  b.p.focusTickNow(T_SAT);
  assert.equal(b.p.getFocus(T_SAT).today, null, "a no-session day still retires the previous list");
  assert.ok(b.p.getFocus(T_SAT).prev, "…keeping it reachable");

  // Re-ticking after retirement is idempotent: nothing left to retire, prev is not overwritten.
  const before = b.saved();
  const T_SAT2 = Date.UTC(2026, 7, 16, 4, 0);
  b.p.focusTickNow(T_SAT2);
  assert.equal(b.saved(), before, "no second write — retirement fires once per stamp, not once per tick");
  assert.ok(b.p.getFocus(T_SAT2).prev.day === "2026-08-14", "and the prior list is not clobbered by an empty one");
});

// ============================================================================================
// FOCUS -07 (build 2026.08.18-07): the 00:00 UTC retirement must not re-stamp, and the +1h freeze
// must not race the 1m writer.
//
// WHY THE -02 SUITE MISSED THIS. The retirement test above is behavioural and it passes — but its
// fixture universe is EMPTY (`loadAll: () => new Map()`, no seeded rows). At the boundary tick the
// retirement fires, the stamp gate is reached on the same tick with a null state, and stampFocus
// then returns on the candidate floor because there is nothing to stamp. The adjacent path was
// exercised and proved nothing. In production the universe holds 65 names and the identical tick
// minted a second FROZEN @ OPEN record from the 20:00 ET tape, over the top of the real 09:30 one.
// So the seeded rig is not incidental here: it IS the test.
// ============================================================================================
test("focus -07: the 00:00 UTC retirement retires and stops — it must never re-stamp from the evening tape", () => {
  const { p, OPEN, saved } = focus04Rig(FOCUS04_FULL);
  const CLOSE = Date.UTC(2026, 7, 14, 20, 0);          // Fri 2026-08-14 16:00 ET
  p.focusTickNow(OPEN + 60000);
  const real = p.getFocus(OPEN + 60000).today;
  assert.ok(real && real.rows.length, "the genuine 09:30 stamp lands first");
  assert.equal(real.frozenAt, OPEN + 60000, "…stamped at the open, not later");
  assert.equal(real.late, 0);

  // 00:00 UTC Saturday IS 20:00 ET Friday: focusRetire nulls the state, and the ET session for that
  // ET day opened ten and a half hours ago. This is the exact production tick.
  const BOUNDARY = Date.UTC(2026, 7, 15, 0, 1);
  assert.ok(BOUNDARY > CLOSE, "the retirement boundary sits AFTER the cash close — that is the hazard");
  p.focusTickNow(BOUNDARY);
  const f = p.getFocus(BOUNDARY);
  assert.equal(f.today, null, "no second record is minted from the evening tape");
  assert.equal(f.state, "cleared", "the day reads CLEARED — the state -02 introduced was unreachable until now");
  assert.ok(f.prev && f.prev.frozenAt === OPEN + 60000, "the genuine open stamp is what survives behind the toggle");
  assert.deepEqual(f.prev.rows.map((r) => r.ticker), real.rows.map((r) => r.ticker), "…verbatim, not re-selected");
  assert.ok(saved() && saved().prev && !saved().state, "and that is what persisted, so a redeploy cannot resurrect it");

  // Re-ticking through the rest of the ET day keeps refusing. A bound that only holds for one tick
  // is not a bound.
  for (const t of [BOUNDARY + 30 * 60000, BOUNDARY + 3 * 3600e3]) {
    p.focusTickNow(t);
    assert.equal(p.getFocus(t).today, null, "still refused at " + new Date(t).toISOString());
  }
});

test("focus -07: a phantom record is repaired at boot, and the real stamp is recovered rather than guessed", () => {
  const { createPoller } = require("../src/poller");
  const base = { loadAll: () => new Map(), loadRegime: () => [], loadLedger: () => null,
    saveLedger: () => {}, insert: () => {}, saveRegime: () => {}, saveNews: () => {}, loadNews: () => null };
  const OPEN = Date.UTC(2026, 7, 14, 13, 30), CLOSE = Date.UTC(2026, 7, 14, 20, 0);
  const mk = (frozenAt, utcDay, tick, open) => ({ day: "2026-08-14", utcDay, open: open || OPEN, close: CLOSE,
    prevCloseT: Date.UTC(2026, 7, 13, 20, 0), frozenAt, late: frozenAt - OPEN > 90000 ? 1 : 0,
    rows: [{ ticker: tick }], cuts: [], filledAt: frozenAt, fillNote: null, pvDiff: null });
  const REAL = mk(OPEN + 11000, "2026-08-14", "NBIS");
  const PHANTOM = mk(Date.UTC(2026, 7, 15, 0, 0, 17), "2026-08-15", "SNDK");   // stamped 4h after its own close
  const NOW = Date.UTC(2026, 7, 15, 2, 0);      // Fri 22:00 ET — inside the phantom's UTC day, so it would otherwise be kept
  const boot = (blob) => { const p = createPoller({ dex: "xyz", version: "test", log: () => {},
    store: { ...base, saveFocus: () => {}, loadFocus: () => JSON.parse(JSON.stringify(blob)) } });
    p.hydrateFocusNow(NOW); return p.getFocus(NOW); };

  const a = boot({ state: PHANTOM, prev: REAL });
  assert.equal(a.today, null, "the phantom is never served as today's list");
  assert.ok(a.prev && a.prev.rows[0].ticker === "NBIS", "the genuine open stamp is promoted back out of the prior slot");
  assert.equal(a.prev.frozenAt, OPEN + 11000, "…the real one, identified by its own frozenAt, not by position");

  // Nothing to recover: the phantom still dies, and NO substitute is invented for it.
  const b = boot({ state: PHANTOM, prev: null });
  assert.equal(b.today, null, "the phantom dies whether or not a real record survives");
  assert.equal(b.prev, null, "an unrecoverable day stays a hole — never back-filled with the phantom itself");

  // A prior record from a DIFFERENT session is not the missing stamp. The hard case is one that
  // claims the same ET day and is still inside the current UTC day, so a day-string match would
  // promote it and it would render as today's list: recovery keys on the session's own `open`, and
  // only an exact match is the record the phantom was written over.
  const OTHER = mk(OPEN + 20000, "2026-08-15", "WDC", OPEN + 1);
  const c = boot({ state: PHANTOM, prev: OTHER });
  assert.equal(c.today, null, "a record for another session is never promoted into today's slot");
  assert.ok(c.prev && c.prev.rows[0].ticker === "WDC", "…it is left exactly where it was found");

  // A clean blob is untouched by the repair — it must not fire on honest records.
  const d = boot({ state: mk(OPEN + 11000, "2026-08-15", "NBIS"), prev: null });
  assert.ok(d.today && d.today.rows[0].ticker === "NBIS", "an in-day honest stamp still hydrates as today's list");
});

test("focus -07: the +1h freeze holds for the last 1m bar instead of freezing a 59-minute hour", () => {
  const { p, OPEN, M, lane } = focus07LaneRig();
  assert.ok(p.getFocus(OPEN + 5 * M).today, "the stamp lands");

  p.focusTickNow(OPEN + 61 * M);
  assert.equal(p.getFocus(OPEN + 61 * M).today.filledAt, 0,
    "a 59-of-60 hour does NOT freeze — the writer is one bar behind, which is not the same as done");
  assert.ok(p.getFocus(OPEN + 61 * M).forming, "…and the columns keep reading FORMING while it waits");

  lane.posted = 60;                       // the 10:29 bar lands
  p.focusTickNow(OPEN + 62 * M);
  const rec = p.getFocus(OPEN + 62 * M).today;
  assert.ok(rec.filledAt, "the freeze lands once the hour is complete");
  assert.equal(rec.fillNote, null, "a complete hour claims no shortfall");
  for (const r of rec.rows) {
    assert.equal(r.h1.bars, 60, "the frozen geometry is measured over all sixty minutes");
    assert.equal(r.h1cov.inWin, 60, "…and the record says so, per seat");
    assert.equal(r.h1cov.mins, 60);
  }
});

test("focus -07: the grace is bounded — a lane that never completes still freezes, and discloses", () => {
  const { p, OPEN, M, lane } = focus07LaneRig();
  assert.equal(lane.posted, 59, "the writer stalls one bar short for good");
  p.focusTickNow(OPEN + 61 * M);
  assert.equal(p.getFocus(OPEN + 61 * M).today.filledAt, 0, "held inside the grace");
  p.focusTickNow(OPEN + 66 * M);          // past +1h +5m
  const rec = p.getFocus(OPEN + 66 * M).today;
  assert.ok(rec.filledAt, "the wait is bounded — the record freezes rather than staying forming all day");
  assert.match(rec.fillNote, /short of 60 1m bars/, "…and states the shortfall instead of implying a full hour");
  for (const r of rec.rows) assert.equal(r.h1cov.inWin, 59, "the per-seat count is the honest one");
});

test("focus -03: 'cleared' and 'pending' are different claims and must not collapse", () => {
  const { createPoller } = require("../src/poller");
  const { etDayStr: etDS } = require("../src/compute");
  const base = { loadAll: () => new Map(), loadRegime: () => [], loadLedger: () => null,
    saveLedger: () => {}, insert: () => {}, saveRegime: () => {}, saveNews: () => {}, loadNews: () => null };
  const NOW = Date.UTC(2026, 7, 14, 22, 0);   // 18:00 ET Friday: after the close, BEFORE the 00:00 UTC boundary
  const today = etDS(NOW);
  const mk = (day, utcDay) => ({ day, utcDay, open: 1, close: 2, prevCloseT: 0, frozenAt: NOW - 40 * 3600e3,
    late: 0, rows: [{ ticker: "NVDA" }], cuts: [], filledAt: 0 });
  // A record for TODAY'S session that has already been retired: nothing more is coming today.
  const p = createPoller({ dex: "xyz", version: "test", log: () => {},
    store: { ...base, saveFocus: () => {}, loadFocus: () => ({ state: null, prev: mk(today, "1970-01-01") }) } });
  p.hydrateFocusNow(NOW);
  assert.equal(p.getFocus(NOW).state, "cleared",
    "today was stamped and retired — saying 'stamping on the next tick' would promise a list that is never coming");
  // No record at all for today: the open may genuinely still be pending.
  const q = createPoller({ dex: "xyz", version: "test", log: () => {},
    store: { ...base, saveFocus: () => {}, loadFocus: () => ({ state: null, prev: mk("2020-01-02", "2020-01-02") }) } });
  q.hydrateFocusNow(NOW);
  assert.notEqual(q.getFocus(NOW).state, "cleared", "a prior day's record must not make TODAY look already-retired");
});

test("focus -03: retirement is one producer and runs ahead of the session gate", () => {
  const fs = require("fs"), path = require("path");
  const pol = fs.readFileSync(path.join(__dirname, "..", "src", "poller.js"), "utf8");
  const fn = pol.slice(pol.indexOf("function focusTick(nowInj)"));
  const body = fn.slice(0, fn.indexOf("\n  function getFocus"));
  const retireAt = body.indexOf("focusRetire(now)"), sessAt = body.indexOf("if (!sess)");
  assert.ok(retireAt > 0 && sessAt > 0 && retireAt < sessAt,
    "retirement must precede the no-session early return, or a Friday list survives the whole weekend");
  assert.ok(!/focusPrev = focusState/.test(pol.slice(pol.indexOf("function stampFocus("), pol.indexOf("function fillFocus("))),
    "stampFocus no longer rolls the list — focusRetire is the single producer of retirement");
  assert.equal(pol.split("focusPrev = focusState;").length - 1, 1, "exactly one place in the file retires a stamp");
  assert.ok(/utcDay: focusUtcDayStr\(now\)/.test(pol), "the stamp records the UTC day it belongs to");
  assert.ok(/\(st && st\.utcDay\) \|\| \(st \? focusUtcDayStr\(st\.frozenAt \|\| st\.open\) : null\)/.test(pol),
    "pre-build blobs derive their shelf life from frozenAt — the migration, pinned");
});

test("focus -04: the floors gate a real stamp, and the record freezes the wall that cut it", () => {
  const { p, OPEN } = focus04Rig(FOCUS04_FULL);
  assert.deepEqual(p.setFocusLimits(5e6, 1e6, false), { ok: false, error: "forbidden" }, "a non-admin write is refused outright");
  assert.deepEqual(p.getFocusLimits().limits, { vol: FOCUS_HARD_VOL, oi: FOCUS_HARD_OI }, "…and changes nothing");
  assert.deepEqual(p.setFocusLimits(1000, -5, true).limits, { vol: FOCUS_HARD_VOL, oi: FOCUS_HARD_OI }, "an admin write below the backstop resolves TO the backstop");
  assert.deepEqual(p.setFocusLimits(5e6, 1e6, true).limits, { vol: 5e6, oi: 1e6 }, "an honest write lands");

  p.focusTickNow(OPEN + 60000);
  const f = p.getFocus(OPEN + 60000);
  const rec = f.today;
  assert.ok(rec, "the stamp lands");
  assert.equal(rec.cleared, 8, "eight names cleared the wall");
  assert.equal(rec.scanned, 10, "…out of the ten structurally eligible");
  assert.equal(rec.belowN, 2, "two were refused on size");
  assert.deepEqual(rec.below.map((b) => b.ticker + ":" + b.why), ["COIN:oi", "SNOW:vol"], "each refusal names the wall it hit");
  assert.equal(rec.below.find((b) => b.ticker === "SNOW").need, 16.7, "the roster states how far the floor must fall to admit it");
  // THE OI CONTRACT, end to end: PLTR carries no OI read and seats anyway.
  assert.ok(rec.rows.some((r) => r.ticker === "PLTR"), "a name with no honest OI read takes a seat — it is never refused on a number we do not have");
  assert.ok(!rec.rows.some((r) => r.ticker === "COIN" || r.ticker === "SNOW"), "refused names hold no seat");
  assert.ok(!(rec.cuts || []).some((c) => c.ticker === "COIN" || c.ticker === "SNOW"),
    "…and they are NOT cuts: cuts lost the ranking, these never entered it — collapsing the two would hide which mechanism refused them");
  assert.ok(rec.rows.every((r) => r.oi === null || r.oi >= 1e6), "every seated row carries the OI notional the wall judged");
  assert.deepEqual(rec.limits, { vol: 5e6, oi: 1e6 }, "the wall in force at the stamp is written ONTO the record");

  // IMMUTABILITY: raising the floors afterwards must not rewrite how this list was made.
  p.setFocusLimits(50e6, 40e6, true);
  const f2 = p.getFocus(OPEN + 120000);
  assert.deepEqual(f2.today.limits, { vol: 5e6, oi: 1e6 }, "the frozen record still states the wall it was cut with");
  assert.equal(f2.today.rows.length, 6, "…and still holds its six seats");
  assert.deepEqual(f2.today.below.map((b) => b.ticker), ["COIN", "SNOW"], "…and its refused roster is the one from the stamp, not from today's panel value");
  assert.deepEqual(f2.limits, { vol: 50e6, oi: 40e6 }, "the LIVE wall is a separate field — what the next stamp will use");
  assert.deepEqual(f2.hard, { vol: FOCUS_HARD_VOL, oi: FOCUS_HARD_OI }, "the backstop ships so the panel can state what it cannot go under");
});

test("focus -04: a strict wall stamps SHORT — never padded, never mistaken for a booting universe", () => {
  // THE SPLIT. One count served both roles before this build: the booting check and the seating
  // check. A strict wall was therefore indistinguishable from a cold universe — the tick deferred,
  // the stamp never landed, and the tab read "pending" all day with no statement of why.
  // 1) genuinely booting (five eligible names, pre-floor) -> defer, no record.
  const boot = focus04Rig({ NVDA: [9e6, 9e6], MU: [9e6, 9e6], AMD: [9e6, 9e6], LLY: [9e6, 9e6], TSLA: [9e6, 9e6] });
  boot.p.focusTickNow(boot.OPEN + 60000);
  assert.equal(boot.p.getFocus(boot.OPEN + 60000).today, null, "a booting universe still defers — something IS coming, and a phantom list would deny it");
  assert.equal(boot.saved(), null, "…and nothing is persisted");
  // 2) a full field behind a strict wall -> stamp what cleared, however few. Graded volumes so
  //    the wall genuinely bites: only NVDA/MU/AMD sit above $20M, the rest are ordinary names the
  //    operator's clip cannot work. Ten eligible (past the booting floor), three cleared.
  const strict = focus04Rig(FOCUS04_GRADED);
  strict.p.setFocusLimits(20e6, 4.5e6, true);
  strict.p.focusTickNow(strict.OPEN + 60000);
  const rec = strict.p.getFocus(strict.OPEN + 60000).today;
  assert.ok(rec, "a strict wall does NOT defer — the field is there, the operator's size is the reason it is thin");
  assert.ok(rec.rows.length < 6 && rec.rows.length > 0, "the list is short, not empty and not padded");
  assert.equal(rec.rows.length, rec.cleared, "with fewer cleared names than seats, every cleared name seats");
  assert.equal(rec.scanned, 10, "the record discloses the pre-floor field so 'short' is readable as a choice, not a gap");
  assert.ok(rec.cleared < 6, "…and how few cleared it");
  assert.equal(rec.rows.length, 3, "exactly the three names that clear the wall");
  assert.ok(rec.rows.every((r) => r.vol >= 20e6), "every seat clears the volume wall");
  assert.ok(rec.rows.every((r) => r.oi === null || r.oi >= 4.5e6), "every seat clears the OI wall or carries no OI read");
  // 3) idempotence: the day is stamped, so a later tick must not re-cut it against the same wall.
  const before = JSON.stringify(rec);
  strict.p.focusTickNow(strict.OPEN + 90000);
  assert.equal(JSON.stringify(strict.p.getFocus(strict.OPEN + 90000).today), before, "a stamped day is stamped once — the tick does not re-cut it");
});

test("focus -04: preview and stamp meet the IDENTICAL wall, and a floor change busts the preview", () => {
  const { p, OPEN } = focus04Rig(FOCUS04_GRADED);
  p.setFocusLimits(5e6, 1e6, true);
  const PRE = OPEN - 15 * 60 * 1000;              // 09:15 ET — inside the preview lead
  p.focusTickNow(PRE);
  const pv = p.getFocus(PRE).preview;
  assert.ok(pv, "the prep pool builds");
  assert.ok(!pv.rows.some((r) => r.ticker === "COIN" || r.ticker === "SNOW"),
    "the pool is gated by the SAME wall the stamp will use — prepping against names the bell will refuse is the drift this prevents");
  assert.ok(pv.rows.some((r) => r.ticker === "PLTR"), "…including the missing-OI rule");
  assert.equal(pv.cleared, 8, "the pool discloses how many cleared");
  assert.equal(pv.scanned, 10, "…out of how many were eligible");
  assert.deepEqual(pv.below.map((b) => b.ticker), ["COIN", "SNOW"], "…and which names it is refusing, live");
  assert.deepEqual(pv.limits, { vol: 5e6, oi: 1e6 }, "the pool states the wall it applied");
  // A floor change must republish the pool even if the visible ten survive it: the ETag rides a
  // signature, and a wall the payload does not mention is a wall the client cannot show.
  const ver = p.getFocusStamp();
  p.setFocusLimits(20e6, 4.5e6, true);
  assert.notEqual(p.getFocusStamp(), ver, "the write bumps the stamp so the client's poll picks the new wall up");
  assert.equal(p.getFocus(PRE).preview, null, "the write drops the stale pool rather than serving one gated on the old wall");
  p.focusTickNow(PRE + 30000);
  const pv2 = p.getFocus(PRE + 30000).preview;
  assert.ok(pv2 && pv2.cleared === 3, "…and the next tick rebuilds it against the new one");
  assert.deepEqual(pv2.rows.map((r) => r.ticker), ["AMD", "MU", "NVDA"], "only the names that clear the deeper wall survive the rebuild");
  assert.deepEqual(pv2.limits, { vol: 20e6, oi: 4.5e6 }, "the rebuilt pool states the new wall");
});

test("focus -04: the floors survive a redeploy, and a corrupt blob cannot open the wall", () => {
  const stamp = { day: "2026-08-14", utcDay: "2026-08-14", open: Date.UTC(2026, 7, 14, 13, 30),
    close: Date.UTC(2026, 7, 14, 20, 0), prevCloseT: 0,
    frozenAt: Date.UTC(2026, 7, 14, 13, 30), late: 0, rows: [{ ticker: "NVDA" }], cuts: [], filledAt: 0,
    limits: { vol: 5e6, oi: 1e6 }, scanned: 10, cleared: 8, below: [], belowN: 2 };
  const a = focus04Rig({}, { load: { state: stamp, prev: null, limits: { vol: 5e6, oi: 1e6 } } });
  a.p.hydrateFocusNow(Date.UTC(2026, 7, 14, 18, 0));
  assert.deepEqual(a.p.getFocusLimits().limits, { vol: 5e6, oi: 1e6 }, "the wall rides the same blob as the record — one atomic write, restored together");
  assert.deepEqual(a.p.getFocus(Date.UTC(2026, 7, 14, 18, 0)).today.limits, { vol: 5e6, oi: 1e6 }, "…and the restored record still states its own wall");
  // A hand-edited or truncated blob must fail CLOSED (to the backstop), never open.
  const b = focus04Rig({}, { load: { state: stamp, prev: null, limits: { vol: NaN, oi: "open sesame" } } });
  b.p.hydrateFocusNow(Date.UTC(2026, 7, 14, 18, 0));
  assert.deepEqual(b.p.getFocusLimits().limits, { vol: FOCUS_HARD_VOL, oi: FOCUS_HARD_OI }, "corrupt floors degrade to the backstop, never to no wall at all");
  const c = focus04Rig({}, { load: { state: stamp, prev: null } });
  c.p.hydrateFocusNow(Date.UTC(2026, 7, 14, 18, 0));
  assert.deepEqual(c.p.getFocusLimits().limits, { vol: FOCUS_HARD_VOL, oi: FOCUS_HARD_OI }, "a pre-build blob carries no floors and hydrates to the backstop");
});

test("focus -04: the panel's scan is the ENGINE's eligible field, not a second opinion", () => {
  // One structural predicate (focusEligible) feeds both the expensive candidate assembly and the
  // cheap panel scan. If they could drift, every survivor count the panel prints would be a claim
  // about a different universe than the one the gate actually walks.
  const { p, OPEN } = focus04Rig(FOCUS04_FULL);
  const sc = p.getFocusLimits().scan;
  assert.equal(sc.length, 10, "the scan carries exactly the structurally eligible names");
  assert.ok(sc.every((r) => Array.isArray(r) && r.length === 4), "compact rows: [ticker, vol, oi, cluster]");
  assert.ok(sc[0][1] >= sc[sc.length - 1][1], "sorted by volume so the panel's histogram needs no second sort");
  const noOi = sc.find((r) => r[0] === "PLTR");
  assert.equal(noOi[2], null, "a missing OI read ships as null — the panel must be able to say 'no read', not '$0'");
  p.focusTickNow(OPEN + 60000);
  assert.equal(p.getFocus(OPEN + 60000).today.scanned, sc.length,
    "the stamp's scanned count and the panel's scan length are the same number, because they are the same predicate");
});

test("focus -05: the forming builder publishes coverage for every seat and a record for none that lack bars", () => {
  const { createPoller } = require("../src/poller");
  const base = { loadAll: () => new Map(), loadRegime: () => [], loadLedger: () => null,
    saveLedger: () => {}, insert: () => {}, saveRegime: () => {}, saveNews: () => {}, loadNews: () => null };
  const OPEN = Date.UTC(2026, 7, 14, 13, 30), M = 60000;
  // Two seats: one the lane captured, one it did not. The stub serves 1m bars ONLY for BE.
  const bars = [];
  for (let i = 0; i < 12; i++) bars.push([OPEN + i * M, 100 + i * 0.1, 101 + i * 0.1, 99 + i * 0.1, 100.5 + i * 0.1, 1000]);
  let read5 = 0, read1 = 0;
  const store = { ...base, saveFocus: () => {}, loadFocus: () => null,
    candlesEnabled: () => true,
    readCandles: () => { read5++; return bars; },                      // the 5m archive: must NOT be consulted
    readCandles1m: (coin) => { read1++; return coin === "xyz:BE" ? bars : []; } };
  const p = createPoller({ dex: "xyz", store, log: () => {}, version: "test" });
  const spine = (px) => { const o = []; for (let i = 48; i >= 0; i--) o.push({ t: OPEN - i * 3600e3, o: px, h: px * 1.01, l: px * 0.99, c: px, v: 1e6 }); return o; };
  for (const [t, px] of [["BE", 218.97], ["KORU", 20.127], ["NVDA", 900], ["MU", 100], ["AMD", 150],
    ["LLY", 800], ["TSLA", 300], ["XOM", 110], ["JPM", 200], ["COIN", 250]])
    p.seedRowNow("xyz:" + t, { ticker: t, uni: "xyz", px, vol: 9e6, oi: 9e6, oiBase: 1000, hourlyRaw: spine(px) });
  p.focusTickNow(OPEN + 20 * M);
  const f = p.getFocus(OPEN + 20 * M);
  assert.ok(f.today, "the day stamps");
  assert.ok(read1 > 0, "the forming read consults the 1m archive");
  assert.equal(read5, 0, "…and never the 5m archive — one base for the hour this tab measures");
  const fm = f.forming;
  assert.ok(fm, "a forming edition publishes");
  assert.equal(fm.src, "1m", "the edition states its base resolution");
  if (f.today.rows.some((r) => r.ticker === "BE")) {
    assert.ok(fm.map.BE, "a seat with bars carries a forming record");
    assert.ok(fm.cov.BE && fm.cov.BE.bars === 12, "…and its bar count");
  }
  if (f.today.rows.some((r) => r.ticker === "KORU")) {
    assert.equal(fm.map.KORU, undefined, "a seat with NO bars publishes no forming record — not a flat point built from the mark");
    assert.ok(fm.cov.KORU && fm.cov.KORU.bars === 0, "…but it DOES publish coverage, so the board can say why rather than showing a blank");
    assert.ok(fm.cov.KORU.mins > 0, "…against the elapsed minutes, so 'zero of twenty' is readable");
  }
  assert.ok(fm.next > fm.at, "the edition carries its own next-republish time");
});

test("focus -05: the freeze reads 1m, records per-seat coverage, and stamps the resolution it measured at", () => {
  const { createPoller } = require("../src/poller");
  const base = { loadAll: () => new Map(), loadRegime: () => [], loadLedger: () => null,
    saveLedger: () => {}, insert: () => {}, saveRegime: () => {}, saveNews: () => {}, loadNews: () => null };
  const OPEN = Date.UTC(2026, 7, 14, 13, 30), M = 60000;
  const bars = [];
  for (let i = 0; i < 60; i++) bars.push([OPEN + i * M, 100, 100 + (i === 30 ? 6 : 1), 100 - (i === 45 ? 4 : 1), 100.5, 1000]);
  let saved = null;
  const store = { ...base, saveFocus: (d) => { saved = d; }, loadFocus: () => null,
    candlesEnabled: () => true, readCandles: () => { throw new Error("the freeze must not read the 5m archive"); },
    readCandles1m: (coin) => (coin === "xyz:KORU" ? [] : bars) };
  const p = createPoller({ dex: "xyz", store, log: () => {}, version: "test" });
  const spine = (px) => { const o = []; for (let i = 48; i >= 0; i--) o.push({ t: OPEN - i * 3600e3, o: px, h: px * 1.01, l: px * 0.99, c: px, v: 1e6 }); return o; };
  for (const [t, px] of [["BE", 218.97], ["KORU", 20.127], ["NVDA", 900], ["MU", 100], ["AMD", 150],
    ["LLY", 800], ["TSLA", 300], ["XOM", 110], ["JPM", 200], ["COIN", 250]])
    p.seedRowNow("xyz:" + t, { ticker: t, uni: "xyz", px, vol: 9e6, oi: 9e6, oiBase: 1000, hourlyRaw: spine(px) });
  p.focusTickNow(OPEN + 5 * M);
  p.focusTickNow(OPEN + 61 * M);                       // past +1h: the freeze fires
  const rec = p.getFocus(OPEN + 61 * M).today;
  assert.ok(rec.filledAt, "the record froze");
  assert.equal(rec.h1src, "1m", "the record states the resolution its geometry was measured at");
  assert.equal(p.getFocus(OPEN + 61 * M).forming, null, "the frozen record replaces every forming read");
  for (const seat of rec.rows) {
    assert.ok(seat.h1cov, "every seat carries coverage, present or absent");
    if (seat.ticker === "KORU") {
      assert.equal(seat.h1, null, "a seat the lane never captured freezes as an honest null");
      assert.equal(seat.h1cov.bars, 0, "…with zero recorded, so the dash can name its cause months later");
    } else {
      assert.ok(seat.h1 && seat.h1.bars === 60, "a captured seat freezes 60 one-minute bars");
      assert.equal(seat.h1.hi, 106, "…with the true bar extreme, not a 5m approximation of it");
      assert.equal(seat.h1cov.bars, 60);
    }
  }
  assert.ok(saved && saved.state && saved.state.h1src === "1m", "the resolution persists with the record");
});

test("focus -05: the chart splices 1m over the same window and never counts a trade twice", () => {
  const { createPoller } = require("../src/poller");
  const base = { loadAll: () => new Map(), loadRegime: () => [], loadLedger: () => null,
    saveLedger: () => {}, insert: () => {}, saveRegime: () => {}, saveNews: () => {}, loadNews: () => null };
  const OPEN = Date.UTC(2026, 7, 14, 13, 30), M = 60000, F = 5 * M;
  // The SAME hour in both archives — which is the whole hazard: these are the same trades.
  const b5 = [], b1 = [];
  for (let i = 0; i < 12; i++) b5.push([OPEN + i * F, 100, 102, 98, 101, 5000]);
  for (let i = 0; i < 60; i++) b1.push([OPEN + i * M, 100, 102, 98, 101, 1000]);
  const pre = [];
  for (let i = 12; i >= 1; i--) pre.push([OPEN - i * F, 99, 99.5, 98.5, 99, 4000]);
  const store = { ...base, saveFocus: () => {}, loadFocus: () => null, candlesEnabled: () => true,
    candleCoverage: () => ({ min: OPEN - 12 * F, max: OPEN + 12 * F, count: 24 }),
    readCandles: (c, lo, hi) => [...pre, ...b5].filter((k) => k[0] >= lo && k[0] <= hi),
    readCandles1m: (c, lo, hi) => b1.filter((k) => k[0] >= lo && k[0] <= hi) };
  const p = createPoller({ dex: "xyz", store, log: () => {}, version: "test" });
  const spine = (px) => { const o = []; for (let i = 48; i >= 0; i--) o.push({ t: OPEN - i * 3600e3, o: px, h: px * 1.01, l: px * 0.99, c: px, v: 1e6 }); return o; };
  for (const [t, px] of [["BE", 100], ["NVDA", 900], ["MU", 100], ["AMD", 150], ["LLY", 800],
    ["TSLA", 300], ["XOM", 110], ["JPM", 200], ["COIN", 250], ["PLTR", 60]])
    p.seedRowNow("xyz:" + t, { ticker: t, uni: "xyz", px, vol: 9e6, oi: 9e6, oiBase: 1000, hourlyRaw: spine(px) });
  p.focusTickNow(OPEN + 5 * M);
  const seat = p.getFocus(OPEN + 5 * M).today.rows[0].coin;
  const out = p.getCandles5m(seat, OPEN - 12 * F, OPEN + 12 * F, 6000);
  const inWin = out.candles.filter((k) => k[0] >= OPEN && k[0] < OPEN + 12 * F);
  assert.equal(inWin.length, 12, "the window still yields twelve 5m buckets — the 1m base is rolled UP, not shipped raw");
  // THE DOUBLE-COUNT GUARD. 5 x 1000 = 5000 per bucket, exactly the 5m bar's own volume. Summing
  // both archives would give 10000 and quietly double every volume (and skew every VWAP) in the
  // one window this tab measures most closely.
  assert.ok(inWin.every((k) => k[5] === 5000), "each spliced bucket carries the volume ONCE — overlapping 5m rows are dropped, never added");
  assert.equal(out.candles.filter((k) => k[0] < OPEN).length, 12, "pre-open bars still come from the 5m archive");
  const ts = out.candles.map((k) => k[0]);
  assert.deepEqual(ts, [...ts].sort((a, b) => a - b), "the spliced series stays ordered across the seam");
  assert.equal(new Set(ts).size, ts.length, "no timestamp appears twice — the seam is exact, not overlapping");
  // A coin that never held a seat has no 1m window and is untouched by any of this.
  const other = p.getCandles5m("xyz:NOTASEAT", OPEN - 12 * F, OPEN + 12 * F, 6000);
  assert.ok(other.candles.length > 0, "a non-seat still charts from the 5m archive alone");
});

test("focus -05: the seat lane is scoped to the seats and to the window, and idles the rest of the day", () => {
  const fs = require("fs"), path = require("path");
  const pol = fs.readFileSync(path.join(__dirname, "..", "src", "poller.js"), "utf8");
  // The lane must read the seats from focusState — one producer of "who is seated" — rather than
  // keeping its own list that a late boot stamp could leave stale.
  const w = pol.slice(pol.indexOf("function m1Seats("), pol.indexOf("const need5m ="));
  assert.ok(w.includes("const st = focusState;"), "the lane reads the live stamp, never a copy");
  assert.ok(w.includes("st.day !== etDayStr(now)"), "a stale day's seats are not captured");
  assert.ok(/now < st\.open - M1_PAD \|\| now > st\.open \+ HOUR \+ M1_PAD/.test(w), "the window is the stamped hour plus a pad at both edges");
  assert.ok(w.includes("await sleep(15000); continue;"), "outside the window the lane idles rather than spinning");
  assert.ok(w.includes('inflight.has("m1:"'), "per-coin inflight guard, like every other lane");
  assert.ok(/catch \(_\) \{ \/\* one seat's failure must not cost the other five their window \*\//.test(w),
    "one seat's failure cannot take the window from the rest — the starvation this build exists to fix");
  // The 1m bars must land in their OWN table: candles_5m is range-read as 5m by four other
  // consumers, and mixing off-grid timestamps into it would corrupt all of them silently.
  const sto = fs.readFileSync(path.join(__dirname, "..", "src", "store.js"), "utf8");
  assert.ok(sto.includes("CREATE TABLE IF NOT EXISTS candles_1m"), "1m bars have their own table");
  assert.ok(sto.includes("insertCandles1m(coin, rows)") && sto.includes("readCandles1m(coin, from, to)")
    && sto.includes("evictCandles1m(before)"), "the 1m sub-store carries insert, read and retention");
  assert.ok(!/insertCandles\(coin, rows\)[\s\S]{0,400}candles_1m/.test(sto), "the 5m writer never touches the 1m table");
  assert.ok(pol.includes("store.insertCandles1m(coin, closed)"), "the lane writes only closed bars");
  assert.ok(pol.includes("k[0] + 60000 <= now"), "…on a one-minute closed-bar guard");
});

test("focus -05: the close fills at 16:00 from the session's OWN last bar — never the after-hours tape", () => {
  const { p, OPEN, CLOSE, M } = focus05CloseRig();
  assert.ok(p.getFocus(OPEN + 5 * M).today, "the stamp lands");
  assert.equal(p.getFocus(OPEN + 5 * M).today.closedAt, 0, "nothing is closed at 09:35");
  // Mid-session: the tick runs, and the close still does not exist. This is the whole point of the
  // column — a dash here is the truth, and any number would be a fabrication.
  p.focusTickNow(OPEN + 200 * M);
  const mid = p.getFocus(OPEN + 200 * M).today;
  assert.equal(mid.closedAt, 0, "the close does not fill mid-session");
  for (const r of mid.rows) assert.equal(r.closePx, undefined, "…and no row carries a closePx yet");

  p.focusTickNow(CLOSE + 2 * M);
  const rec = p.getFocus(CLOSE + 2 * M).today;
  assert.ok(rec.closedAt, "the fill lands once the session is over");
  assert.equal(rec.closeNote, null, "a complete lane claims no shortfall");
  for (const r of rec.rows) {
    assert.ok(Math.abs(r.closePx - 138.9) < 1e-6, `the 15:59 print, not the 400 after-hours tape (got ${r.closePx})`);
    assert.equal(r.closeCov.inWin, 390, "measured over the whole cash window");
    assert.equal(r.closeCov.slopMin, 1, "one bar-width of slop on a complete lane");
  }
  // Frozen: a later tick, with the after-hours tape now much longer, must not restate it.
  p.focusTickNow(CLOSE + 55 * M);
  assert.ok(Math.abs(p.getFocus(CLOSE + 55 * M).today.rows[0].closePx - 138.9) < 1e-6,
    "a filled close never moves again — geometry is frozen at the fill, not recomputed per tick");
});

test("focus -05: a lane short of the close HOLDS the fill, and the wait is bounded", () => {
  const a = focus05CloseRig({ posted: 387 });          // writer stalled at 15:56
  a.p.focusTickNow(a.CLOSE + 1 * a.M);
  assert.equal(a.p.getFocus(a.CLOSE + a.M).today.closedAt, 0,
    "a lane four minutes short of 16:00 does NOT close — that print is not the close");
  // The bar lands inside the grace: the fill takes the real one.
  a.lane.posted = 390;
  a.p.focusTickNow(a.CLOSE + 2 * a.M);
  const ok = a.p.getFocus(a.CLOSE + 2 * a.M).today;
  assert.ok(ok.closedAt && ok.closeNote === null, "the wait pays off — a complete close, no disclosure needed");
  assert.ok(Math.abs(ok.rows[0].closePx - 138.9) < 1e-6, "and it is the 15:59 print");

  const b = focus05CloseRig({ posted: 387 });          // writer never recovers
  b.p.focusTickNow(b.CLOSE + 1 * b.M);
  assert.equal(b.p.getFocus(b.CLOSE + b.M).today.closedAt, 0, "held inside the grace");
  b.p.focusTickNow(b.CLOSE + 6 * b.M);                 // past close +5m
  const rec = b.p.getFocus(b.CLOSE + 6 * b.M).today;
  assert.ok(rec.closedAt, "the wait is bounded — the record closes rather than dashing forever");
  assert.match(rec.closeNote, /did not reach the close/, "…and states it instead of implying a 16:00 print");
  assert.equal(rec.rows[0].closeCov.slopMin, 4, "the shortfall rides the row, per seat, forever");
});

test("focus -05: a seat with no bars dashes and does not hold the others hostage", () => {
  const dark = [];
  const { p, OPEN, CLOSE, M } = focus05CloseRig({ dark });
  dark.push(p.getFocus(OPEN + 5 * M).today.rows[0].ticker);   // darken a seat that actually took one
  p.focusTickNow(CLOSE + 1 * M);
  const rec = p.getFocus(CLOSE + M).today;
  assert.ok(rec.closedAt, "an absent lane is not a late one — it must not hold the fill open");
  const dry = rec.rows.filter((r) => r.closePx == null);
  assert.ok(dry.length >= 1 && dry.every((r) => r.closeCov.bars === 0),
    "the dark seat carries an honest null with its coverage attached");
  assert.ok(rec.rows.filter((r) => r.closePx != null).length >= 1, "…while every other seat closed normally");
});

test("focus -05: with the archive disabled the close is refused out loud, never guessed from the mark", () => {
  const { p, CLOSE, M } = focus05CloseRig({ archive: false });
  p.focusTickNow(CLOSE + 1 * M);
  const rec = p.getFocus(CLOSE + M).today;
  assert.ok(rec.closedAt, "the record still closes — the state machine does not stall on a disabled archive");
  assert.match(rec.closeNote, /archive disabled/, "and says why every close is a dash");
  for (const r of rec.rows) assert.equal(r.closePx, null, "not one price is invented from the live mark");
});

// ================================================================================================
// FOCUS: the LATE close fill (build 2026.08.19-06)
// ------------------------------------------------------------------------------------------------
// -05 shipped a close that could only fill while the record sat in the live slot: between 16:00 ET
// and the 00:00 UTC retire — four hours in EDT, three in EST. A deploy inside that window lost the
// session's close permanently, which is exactly what happened on 2026-08-19. The correction is that
// this read was never time-sensitive: it is bounded by the record's own open and close, so taking it
// at 21:00 returns what taking it at 16:01 would have. These tests pin that equivalence directly —
// the late fill must be byte-identical to the on-time one, or the fix is a different measurement.
// ================================================================================================
test("focus -06: a record that retired unfilled still gets its close, and it is the SAME read", () => {
  const M = 60000;
  // On time: the fill lands in the live slot at 16:02.
  const a = focus05CloseRig();
  a.p.focusTickNow(a.CLOSE + 2 * M);
  const onTime = a.p.getFocus(a.CLOSE + 2 * M).today;
  assert.ok(onTime.closedAt, "baseline: the on-time fill lands");
  assert.equal(onTime.closeLate, 0, "and does not claim to be late");

  // Late: nothing ticks until 21:12 ET — past the 00:00 UTC retire, so the record is in `prev`.
  const b = focus05CloseRig();
  const LATE = Date.UTC(2026, 7, 20, 1, 12);          // 2026-08-19 21:12 ET, the screenshot's clock
  assert.ok(LATE > b.CLOSE, "the late tick really is after the close");
  b.p.focusTickNow(LATE);
  const d = b.p.getFocus(LATE);
  assert.equal(d.today, null, "the record has retired out of the live slot");
  assert.ok(d.prev && d.prev.closedAt, "…and the retired record fills anyway — this is the -05 bug");
  assert.ok(d.prev.closeLate > 300, "the record discloses how late the read was taken");
  // THE EQUIVALENCE. Same window, same bars, same answer — the only difference is the disclosure.
  assert.deepEqual(d.prev.rows.map((r) => r.closePx), onTime.rows.map((r) => r.closePx),
    "the late read returns exactly the on-time read — the window is the record's, not the clock's");
  assert.deepEqual(d.prev.rows.map((r) => r.closeCov.inWin), onTime.rows.map((r) => r.closeCov.inWin),
    "…including per-seat coverage");
  assert.deepEqual(d.prev.rows.map((r) => r.closeCov.bars), onTime.rows.map((r) => r.closeCov.bars),
    "…and the RAW read count: a late fill that widened its window to `now` would sweep the "
    + "after-hours tape into the coverage even though the price came out right");
  assert.equal(d.prev.closeNote, null, "a complete lane read late still claims no shortfall");
  // Idempotent: a filled record is never re-read, however many ticks follow.
  const px = d.prev.rows[0].closePx, at = d.prev.closedAt;
  b.p.focusTickNow(LATE + 30 * M);
  const again = b.p.getFocus(LATE + 30 * M).prev;
  assert.equal(again.rows[0].closePx, px, "a filled close never moves again");
  assert.equal(again.closedAt, at, "…and the fill is not re-stamped on every tick");
});

test("focus -06: the late fill runs on weekends — a Friday close missed at 16:00 lands on Saturday", () => {
  const M = 60000;
  const { p, CLOSE } = focus05CloseRig();             // Friday 2026-08-14
  const SAT = Date.UTC(2026, 7, 15, 18, 0);           // Saturday 14:00 ET — no session at all
  p.focusTickNow(SAT);
  const d = p.getFocus(SAT);
  assert.equal(d.state, "offday", "it really is a non-session day");
  assert.ok(d.prev && d.prev.closedAt,
    "the fill runs BEFORE the session lookup returns early — otherwise Friday waits for Monday and dies");
  assert.ok(Math.abs(d.prev.rows[0].closePx - 138.9) < 1e-6, "and it is Friday's 15:59 print");
  assert.ok(d.prev.closeLate > (SAT - CLOSE) / M - 5, "disclosed as the day-late read it is");
});

test("focus -06: the late fill reaches the prior slot ONLY — it never walks back through history", () => {
  const fs = require("fs"), path = require("path");
  const pol = fs.readFileSync(path.join(__dirname, "..", "src", "poller.js"), "utf8");
  const tick = pol.slice(pol.indexOf("function focusTick(nowInj)"), pol.indexOf("function focusTick(nowInj)") + 3000);
  assert.equal((tick.match(/closeFocus\(/g) || []).length, 2, "exactly two fills: the live record and the prior slot");
  assert.ok(tick.includes("closeFocus(focusPrev, now)") && tick.includes("closeFocus(focusState, now)"),
    "one call per slot, each naming its record explicitly");
  assert.ok(!/closedAt\s*&&/.test(tick) && !/!\w+\.closedAt/.test(tick),
    "neither call site re-checks closedAt — the guard lives inside closeFocus, where a test can reach it");
  assert.ok(tick.indexOf("closeFocus(focusPrev, now)") < tick.indexOf("const sess = marketSessions"),
    "the prior-slot fill sits above the session lookup, so a weekend cannot skip it");
  assert.ok(!/focusPrev\s*=\s*\w+\.prev/.test(pol.slice(pol.indexOf("function closeFocus("), pol.indexOf("function closeFocus(") + 2500)),
    "the fill mutates the record it was handed and reaches for no other");
});
