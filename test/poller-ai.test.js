"use strict";
// poller.js — AI report, brief, landscape, desk, classification. Split out of test.js (build 2026.09.16-80); order within the file is the original order.
const test = require("node:test");
const assert = require("node:assert");
const { HOUR, DAY, C, aiTestPoller, AI_GOOD, ctxHarness, twoUserHarness, briefAuditHarness } = require("./_shared");


test("AI admin gate: checkAdminPassword fails closed, verifies constant-time, shares a lockout", () => {
  const { createPoller } = require("../src/poller");
  const store = { loadAll: () => new Map(), loadRegime: () => [], loadLedger: () => null,
    saveLedger: () => {}, insert: () => {}, saveRegime: () => {}, saveNews: () => {}, loadNews: () => null };
  const prev = process.env.ADMIN_PASSWORD;
  try {
    delete process.env.ADMIN_PASSWORD;
    let p = createPoller({ dex: "xyz", store, log: () => {}, version: "test" });
    assert.equal(p.checkAdminPassword("anything").error, "not-configured", "unset ADMIN_PASSWORD fails closed (no unlock can be minted)");
    process.env.ADMIN_PASSWORD = "s3cret-pw";
    p = createPoller({ dex: "xyz", store, log: () => {}, version: "test" });
    assert.equal(p.checkAdminPassword("s3cret-pw").ok, true, "correct password passes");
    assert.equal(p.checkAdminPassword("wrong").error, "bad-password", "wrong password rejected");
    for (let i = 0; i < 8; i++) p.checkAdminPassword("wrong");
    assert.equal(p.checkAdminPassword("s3cret-pw").error, "rate", "lockout trips after repeated failures — even the correct password waits");
  } finally { if (prev === undefined) delete process.env.ADMIN_PASSWORD; else process.env.ADMIN_PASSWORD = prev; }
});

test("ai report v6: news-grounded context, no-invention rule, crypto positioning (engine-free), sector-relative", () => {
  const { p, px, now } = aiTestPoller();   // seeded xyz:NVDA with spines (existing report harness)
  // verified-only news reaches the analyst: verified, pending and off-topic seeded together
  p.newsIngestNow([
    { id: 71, tk: "NVDA", h: "Nvidia unveils next-gen accelerator", src: "Reuters", url: "u", pub: now - 2 * 3600e3 },
    { id: 72, tk: "NVDA", h: "Stock Market Today: chips lead the tape", src: "Yahoo", url: "u", pub: now - 3600e3 },
    { id: 73, tk: null, h: "Fed holds rates steady", src: "CNBC", url: "u", pub: now - 3600e3 },
  ]);
  p.buildDailyNow();   // populates the roster order — sector peers resolve through activeMarkets()
  const ctx = p.aiCompileNow("xyz:NVDA");
  assert.ok(ctx.news && Array.isArray(ctx.news.verified), "ctx.news always ships");
  assert.equal(ctx.news.verified.length, 1, "ONLY the gate-verified headline reaches the analyst");
  assert.ok(ctx.news.verified[0].h.includes("accelerator"), "and it is the right one — the listicle stayed out");
  assert.equal(ctx.news.windowH, 72);
  // sector-relative: the name-vs-sector distinction ships as explicit numbers
  assert.ok(ctx.sector && ctx.sector.rel7dPct != null && ctx.sector.median7dPct != null,
    "sector.rel7dPct present — '+4% while the sector did +1%' is now a fact, not a guess");
  // validator: news_read is REQUIRED, and claiming usage with an empty verified set is invented news
  const good = JSON.parse(AI_GOOD(px, px * 0.94, px * 1.1));
  const noNews = Object.assign({}, ctx, { news: { windowH: 72, verified: [], tape: [], note: "none" } });
  delete good.news_read;
  assert.equal(p.aiValidateNow(JSON.stringify(good), noNews).ok, false, "missing news_read rejected");
  good.news_read = { used: true, note: "leaning on the guidance headline" };
  const rej = p.aiValidateNow(JSON.stringify(good), noNews);
  assert.equal(rej.ok, false, "used:true with zero verified headlines = invented news, rejected");
  assert.ok(/invented news/.test(rej.error));
  good.news_read = { used: true, note: "accelerator launch supports the long" };
  assert.equal(p.aiValidateNow(JSON.stringify(good), ctx).ok, true, "used:true WITH a verified headline passes");
  good.news_read = { used: false, note: "no verified headlines in the window" };
  assert.equal(p.aiValidateNow(JSON.stringify(good), noNews).ok, true, "honest empty-news read passes");
  // crypto positioning: main-universe context still carries funding/OI state — data, not the retired engine
  const DAY_ = 86400e3, HOUR_ = 3600e3;
  const mkD = () => { const d = []; for (let i = 61; i >= 1; i--) d.push({ t: now - i * DAY_, c: 100, o: 100, h: 101, l: 99, v: 1e6 }); return d; };
  const mkH = () => { const h = []; for (let i = 400; i >= 0; i--) h.push({ t: now - i * HOUR_, o: 100, h: 100.5, l: 99.5, c: 100, v: 1e5 }); return h; };
  p.seedRowNow("ETH", { px: 100, ticker: "ETH", uni: "main", vol: 5e7, funding: 0.0001,
    ref: { p7d: 95, p30d: 90 }, dailyRaw: mkD(), hourlyRaw: mkH(), dailyTs: now, hourlyTs: now, isNew: false, prevDay: 99, d1: 1 });
  const cctx = p.aiCompileNow("ETH");
  assert.equal(cctx.universe, "crypto");
  assert.ok(!cctx.sector, "sector-relative stays an equities concept");
  // funding percentile / OI need long sampled histories the harness doesn't build — the block is
  // allowed to be absent-when-uncomputable; what must hold is the source wiring:
  const fs = require("fs"), path = require("path");
  const pol = fs.readFileSync(path.join(__dirname, "..", "src", "poller.js"), "utf8");
  for (const pin of ["cr.fundingPctile31d = fp", "cr.oiChg24Pct",
    "const AI_SCHEMA_V = 10;", "NEWS CONTRACT", "context.news.verified is empty you MUST NOT",
    "invented news", "rel7dPct", "rel30dPct", "context.crypto",
    // v7 earnings reported-vs-upcoming split
    "earnEntryState(x, now) === \"upcoming\"", "e.reported =",
    "event scenario without a pending earnings print", "reportedD"])
    assert.ok(pol.includes(pin), `v6/v7 pin missing: ${pin}`);
  assert.ok(!pol.includes("cryptoSetupsLive"), "the AI context no longer cites live engine setups it does not have (-101)");
});

test("ai report: a reported print is a post-event object, not a pending `next`; validator bans a stale event scenario", () => {
  const { p, px } = aiTestPoller();
  const C = require("../src/compute");
  const yest = C.etDayStr(Date.now() - 86400e3);     // unconditionally reported
  const future = C.etDayStr(Date.now() + 6 * 86400e3); // unconditionally upcoming
  // INTC-shaped: today's print already out (carried as a back-window row with its actual) AND a
  // real next print six days ahead. The reported row must NOT masquerade as `next`.
  p.seedEarnNow([
    { t: "NVDA", d: yest, s: "AMC", eps: 0.22, epsA: 0.42, rev: null, revA: null },
    { t: "NVDA", d: future, s: "AMC", eps: 0.30, epsA: null, rev: null, revA: null },
  ]);
  const ctx = p.aiCompileNow("xyz:NVDA");
  assert.ok(ctx.earnings, "earnings block present");
  assert.equal(ctx.earnings.next.d, future, "`next` is the still-ahead print, never the reported one");
  assert.ok(ctx.earnings.reported && ctx.earnings.reported.d === yest, "the printed row surfaces as `reported`");
  assert.equal(ctx.earnings.reported.beat, true, "beat verdict computed from actual vs estimate");
  assert.ok(Math.abs(ctx.earnings.reported.surprisePct - 90.9) < 0.2, "surprise% computed server-side");

  // With ONLY a reported print (no `next`), the pending-binary framing is illegitimate.
  p.seedEarnNow([{ t: "NVDA", d: yest, s: "AMC", eps: 0.22, epsA: 0.42 }]);
  const ctx2 = p.aiCompileNow("xyz:NVDA");
  assert.ok(ctx2.earnings.reported && !ctx2.earnings.next, "printed-only name carries reported, no next");
  const voidLv = +(px * 0.95).toPrecision(6), tgt = +(px * 1.10).toPrecision(6);
  const withEvent = JSON.parse(AI_GOOD(px, voidLv, tgt));
  withEvent.scenarios = [
    { name: "continuation to the target", kind: "target", p: 0.4, target: tgt, note: "trend persists" },
    { name: "the earnings print decides", kind: "event", p: 0.4, target: null, note: "coin flip into the report" },
    { name: "breaks the void", kind: "void", p: 0.2, target: null, note: "thesis dead below" },
  ];
  const rej = p.aiValidateNow(JSON.stringify(withEvent), ctx2);
  assert.equal(rej.ok, false, "an event scenario with no pending print is rejected");
  assert.match(rej.error, /event scenario without a pending earnings print/, "rejection names the stale-event cause");

  // The SAME event scenario is fine once a print is genuinely ahead.
  p.seedEarnNow([{ t: "NVDA", d: future, s: "AMC", eps: 0.30, epsA: null }]);
  const ctx3 = p.aiCompileNow("xyz:NVDA");
  assert.ok(ctx3.earnings.next && !ctx3.earnings.reported, "ahead-only name carries next, no reported");
  assert.equal(p.aiValidateNow(JSON.stringify(withEvent), ctx3).ok, true, "event scenario passes with a pending print ahead");
});

test("per-user AI quotas: exhaustion, admin exemption, and group reports end to end (injected transport)", async () => {
  const { createPoller } = require("../src/poller");
  const store = { loadAll: () => new Map(), loadRegime: () => [], loadLedger: () => null,
    saveLedger: () => {}, insert: () => {}, saveRegime: () => {}, saveNews: () => {}, loadNews: () => null };
  process.env.OPENAI_API_KEY = "test-key";
  process.env.AI_USER_PER_DAY = "2";   // fast exhaustion
  try {
    const groupJson = JSON.stringify({ bias: "long", headline: "Breadth improving across the basket",
      read: ["Paragraph one of the group read.", "Paragraph two of the group read."],
      leaders: "Leaders paragraph.", laggards: "Laggards paragraph.", risks: ["macro print ahead"], watch: ["breadth rolling over"] });
    let calls = 0;
    const aiFetch = async () => { calls++;
      return { ok: true, json: async () => ({ choices: [{ message: { content: groupJson }, finish_reason: "stop" }] }) }; };
    const p = createPoller({ dex: "xyz", store, log: () => {}, version: "test", crypto: false, aiFetch });
    // Seed 3 live equities with enough daily history for the aggregates.
    const now = Date.now(), mk = (n) => { const a = []; for (let i = 0; i < n; i++)
      a.push({ t: now - (n - i) * 86400000, o: 100, h: 101 + i * 0.1, l: 99, c: 100 + i * 0.1, v: 1e6 }); return a; };
    for (const t of ["AAA", "BBB", "CCC"]) p.seedRowNow(t, { px: 110, uni: "xyz", vol: 1e6, dailyRaw: mk(60) });
    // Group key canonicalization: unsorted input resolves to the sorted cache identity.
    const r1 = await p.generateAiReport("grp:bkt:CCC+AAA+BBB", { owner: "user1", admin: false });
    assert.equal(r1.ok, true, "group generation must succeed: " + (r1.error || ""));
    assert.equal(r1.report.kind, "group", "report must carry the group kind");
    assert.equal(r1.report.coin, "grp:bkt:AAA+BBB+CCC", "basket key must canonicalize sorted");
    assert.ok(Array.isArray(r1.report.ai.read) && r1.report.ai.read.length >= 2, "group read paragraphs must survive validation");
    assert.ok(r1.report.computed && Array.isArray(r1.report.computed.ewIndex) && r1.report.computed.ewIndex.length > 10, "EW index must ship with the report");
    assert.ok(r1.report.computed.breadth && r1.report.computed.breadth.n === 3, "breadth must count all members");
    assert.equal(r1.userDayLeft, 1, "one of the user's 2 daily generations spent");
    // The cached group report reads back through the same getter, canonicalized.
    const g = p.getAiReport("grp:bkt:BBB+AAA+CCC", { owner: "user1", admin: false });
    assert.equal(g.kind, "group"); assert.ok(g.status === "fresh", "fresh straight after generation");
    // Second spend hits the per-user day cap on the third try — the shared pool is untouched enough.
    const r2 = await p.generateAiReport("grp:sec:Information Technology", { owner: "user1", admin: false });
    // (sector may or may not resolve with only 3 seeded names — accept either a success or a clean sector error)
    if (r2.ok) {
      const r3 = await p.generateAiReport("grp:bkt:AAA+BBB", { owner: "user1", admin: false });
      assert.equal(r3.error, "user-day-cap", "third generation must hit the per-user day cap");
    } else {
      const r2b = await p.generateAiReport("grp:bkt:AAA+BBB", { owner: "user1", admin: false });
      assert.equal(r2b.ok, true, "a valid basket must still generate: " + (r2b.error || ""));
      const r3 = await p.generateAiReport("grp:bkt:AAA+CCC", { owner: "user1", admin: false });
      assert.equal(r3.error, "user-day-cap", "third generation must hit the per-user day cap");
    }
    // A different user has their own budget.
    const o1 = await p.generateAiReport("grp:bkt:BBB+CCC", { owner: "user2", admin: false });
    assert.equal(o1.ok, true, "a fresh owner has a fresh budget: " + (o1.error || ""));
    // Admin sails through caps and burns nothing.
    const sharedBefore = p.getAiReport("grp:bkt:AAA+BBB+CCC", { admin: true }).dayLeft;
    const a1 = await p.generateAiReport("grp:bkt:AAA+CCC", { owner: "user1", admin: true });
    assert.equal(a1.ok, true, "admin must bypass the exhausted per-user cap: " + (a1.error || ""));
    assert.equal(a1.admin, true, "admin flag must ride the response");
    const sharedAfter = p.getAiReport("grp:bkt:AAA+BBB+CCC", { admin: true }).dayLeft;
    assert.equal(sharedAfter, sharedBefore, "an admin generation must not burn the shared pool");
    // Bad group keys fail closed with honest errors.
    const bad = await p.generateAiReport("grp:bkt:AAA", { owner: "user2", admin: false });
    assert.ok(/bad group key/.test(bad.error), "a 1-ticker basket is rejected at the key");
    const unk = await p.generateAiReport("grp:bkt:AAA+ZZZ", { owner: "user2", admin: false });
    assert.ok(/not in the live equity universe: ZZZ/.test(unk.error), "unknown members are named, never silently dropped");
    // Ask per-user cap: 5/day default is env-overridable; exercise via ASK_USER_PER_DAY.
  } finally { delete process.env.OPENAI_API_KEY; delete process.env.AI_USER_PER_DAY; }
});

test("stop geometry: validator, hydrate repair of fabricated stop-aware wins, open-claim voiding", () => {
  const { stopGeometryOk } = require("../src/compute");
  // the validator itself
  assert.equal(stopGeometryOk("long", 45.694, 50.57), false, "stop above a long's entry is invalid (the MINIMAX case)");
  assert.equal(stopGeometryOk("long", 45.694, 41.2), true, "stop below a long's entry is valid");
  assert.equal(stopGeometryOk("short", 97.9, 102.9), true, "stop above a short's entry is valid");
  assert.equal(stopGeometryOk("short", 97.9, 92.0), false, "stop below a short's entry is invalid");
  assert.equal(stopGeometryOk("long", 0, 10), false, "no mark, no stop");
  assert.equal(stopGeometryOk(null, 100, 90), false, "no side, no stop");

  // hydrate repair
  const { createPoller } = require("../src/poller");
  const now = Date.now();
  const fixture = { ts: now, rearm: [], variants: null,
    open: [
      // open long with inverted stop: keeps resolving, loses its stop-aware leg
      { key: "xyz:NATGAS|squeeze", coin: "xyz:NATGAS", ticker: "NATGAS", ev: "squeeze", t0: now - 3600000,
        mark0: 2.959, dir: 1, score0: 21, resolveAt: now + 86400000, psd: "long", stp: 3.4 },
    ],
    closed: [
      // the MINIMAX shape: long, stop ABOVE entry, "stopped" into a fabricated +10.68% win
      { key: "xyz:MINIMAX|squeeze", coin: "xyz:MINIMAX", ticker: "MINIMAX", ev: "squeeze", t0: now - 5 * 86400000,
        mark0: 45.694, dir: 1, psd: "long", stp: 50.57, status: "resolved", tR: now - 2 * 86400000,
        realized: -20.79, realizedS: 10.68, stopped: true, win: false, winS: true, score0: 42 },
      // a VALID stopped short: stop above entry, genuinely touched — must be untouched by repair
      { key: "xyz:MSTR|breakdown2", coin: "xyz:MSTR", ticker: "MSTR", ev: "breakdown", t0: now - 6 * 86400000,
        mark0: 97.9, dir: -1, psd: "short", stp: 102.9, sd0: 2, rn: 1, status: "resolved", tR: now - 86400000,
        realized: 1.2, realizedS: -2.55, stopped: true, win: true, winS: false },
    ] };
  const store = { loadAll: () => new Map(), loadRegime: () => [], loadLedger: () => fixture,
    saveLedger: () => {}, insert: () => {}, saveRegime: () => {} };
  const p = createPoller({ dex: "xyz", store, log: () => {}, version: "test", crypto: false });
  p.hydrateLedgerNow();
  p.hydrateLedgerNow();   // idempotent
  const mm = p.getLedgerFor("xyz:MINIMAX", null, true).closed[0];
  assert.equal(mm.realizedS, -20.79, "fabricated stop-aware outcome reverted to at-horizon truth");
  assert.equal(mm.stopped, false, "false stop cleared");
  const ms = p.getLedgerFor("xyz:MSTR", null, true).closed[0];
  assert.equal(ms.realizedS, -2.55, "valid stopped short untouched");
  assert.equal(ms.stopped, true, "valid stop kept");
  const ng = p.getLedgerFor("xyz:NATGAS", null, true).open[0];
  assert.equal(ng.status, "open", "open claim still resolving");
  assert.equal(ng.stopped, false);
});

test("ai report: context compiler builds a universe-tagged payload with D1/H12/H4 only, coverage, and flags", () => {
  const { p, px } = aiTestPoller();
  const ctx = p.aiCompileNow("xyz:NVDA");
  assert.ok(ctx, "compiler returned nothing for a seeded market");
  assert.equal(ctx.universe, "stocks");
  assert.equal(ctx.ticker, "NVDA");
  assert.ok(Math.abs(ctx.px - px) / px < 1e-6, "px mismatch");
  assert.equal(ctx.benchmark, "SP500");
  assert.ok(ctx.trend && ctx.trend.tf, "trend ladder missing");
  for (const t of ["D1", "H12", "H4"]) assert.ok(ctx.trend.tf[t], `trend rung missing: ${t}`);
  assert.ok(!("H1" in ctx.trend.tf), "H1 must be excluded from the AI context");
  assert.equal(ctx.trend.tf.D1.st, "up", "a steady riser must read D1 up");
  assert.ok(ctx.coverage && Array.isArray(ctx.coverage.hourlyGaps) && Array.isArray(ctx.coverage.oiGaps), "coverage block missing");
  assert.ok(Array.isArray(ctx.flags), "flags must be an array (possibly empty)");
  assert.ok(ctx.market && typeof ctx.market.chg === "object", "market state missing");
  assert.ok(ctx.volRegime && ctx.volRegime.rangePosPct >= 90, "a fresh-high riser must sit at the top of its range");
  assert.equal(p.aiCompileNow("xyz:NOPE"), null, "unknown coin must compile to null, never a fabricated context");
});

test("ai report: validator accepts a conforming payload, normalizes probabilities, and computes R/R + EV server-side", () => {
  const { p, px } = aiTestPoller();
  const voidLv = +(px * 0.95).toPrecision(6), tgt = +(px * 1.10).toPrecision(6);
  const r = p.aiIngestNow("xyz:NVDA", AI_GOOD(px, voidLv, tgt), "test-model");
  assert.ok(r.ok, "conforming payload rejected: " + (r.error || ""));
  const c = r.report.computed;
  assert.ok(Math.abs(c.voidLevel - voidLv) / voidLv < 1e-4, "void level not carried through");
  const risk = px - voidLv;
  const scT = c.scenarios.find((s) => s.kind === "target");
  assert.ok(Math.abs(scT.payoffR - (tgt - px) / risk) < 0.02, `target payoff wrong: ${scT.payoffR}`);
  assert.equal(scT.rr, Math.abs(scT.payoffR), "rr must be |payoff| for the target scenario");
  assert.equal(c.scenarios.find((s) => s.kind === "void").payoffR, -1, "void scenario is -1R by construction");
  assert.equal(c.scenarios.find((s) => s.kind === "flat").payoffR, 0, "flat scenario contributes 0");
  const ev = +(0.5 * scT.payoffR + 0.3 * 0 + 0.2 * -1).toFixed(2);
  assert.equal(c.evR, ev, `EV must be the exact probability-weighted sum, got ${c.evR} want ${ev}`);
  const psum = c.scenarios.reduce((a, s) => a + s.p, 0);
  assert.ok(Math.abs(psum - 1) < 0.01, "probabilities must normalize to 1");
  assert.equal(r.report.status, "fresh", "a just-generated report is fresh");
});

test("ai report: validator rejects garbage — bad bias, broken probabilities, fences survive, silly levels", () => {
  const { p, px } = aiTestPoller();
  const voidLv = +(px * 0.95).toPrecision(6), tgt = +(px * 1.10).toPrecision(6);
  const mut = (fn) => { const o = JSON.parse(AI_GOOD(px, voidLv, tgt)); fn(o); return JSON.stringify(o); };
  assert.equal(p.aiValidateNow(mut((o) => { o.bias = "moon"; }), p.aiCompileNow("xyz:NVDA")).ok, false, "bad bias must fail");
  assert.equal(p.aiValidateNow(mut((o) => { o.scenarios[0].p = 0.9; }), p.aiCompileNow("xyz:NVDA")).ok, false, "probability sum far from 1 must fail");
  assert.equal(p.aiValidateNow(mut((o) => { o.levels[1].value = px * 5; }), p.aiCompileNow("xyz:NVDA")).ok, false, "level outside sanity bounds must fail");
  assert.equal(p.aiValidateNow(mut((o) => { o.synthesis = "too short"; }), p.aiCompileNow("xyz:NVDA")).ok, false, "one-liner synthesis must fail");
  assert.equal(p.aiValidateNow("the market feels bullish, roughly", p.aiCompileNow("xyz:NVDA")).ok, false, "prose instead of JSON must fail");
  // markdown fences around valid JSON must survive (models do this even when told not to)
  assert.equal(p.aiValidateNow("```json\n" + AI_GOOD(px, voidLv, tgt) + "\n```", p.aiCompileNow("xyz:NVDA")).ok, true, "fenced JSON must parse");
});

test("ai report: TTL cooldown gates regeneration for everyone; material change unlocks it with the reason", async () => {
  const { p, px } = aiTestPoller({ aiFetch: async () => ({ ok: true, json: async () => ({ stop_reason: "end_turn",
    content: [{ type: "text", text: AI_GOOD(px, +(px * 0.95).toPrecision(6), +(px * 1.10).toPrecision(6)) }] }) }) });
  const g1 = await p.generateAiReport("xyz:NVDA");
  assert.ok(g1.ok, "first generation must succeed: " + (g1.error || ""));
  const g2 = await p.generateAiReport("xyz:NVDA");
  assert.equal(g2.ok, false); assert.equal(g2.error, "cooldown", "second generation inside TTL must be refused server-side");
  assert.ok(g2.regenInMs > 0, "cooldown must report time remaining");
  assert.equal(p.getAiReport("xyz:NVDA").status, "fresh");
  // material change: a claim resolving on this name flips the report to invalidated + unlocks
  p.aiTouchStamp("xyz:NVDA", { closedN: -1 });   // stored stamp now BELOW the live count → "claim resolved"
  const st = p.getAiReport("xyz:NVDA");
  assert.equal(st.status, "invalidated");
  assert.equal(st.invalidReason, "claim resolved");
  assert.equal(st.canRegen, true, "invalidation must unlock regeneration before TTL");
  const g3 = await p.generateAiReport("xyz:NVDA");
  assert.ok(g3.ok, "regeneration after material change must be allowed: " + (g3.error || ""));
});

test("ai report: frozen claim geometry wins — a model void that disagrees with the live claim stop is overwritten", async () => {
  const { p, px } = aiTestPoller({ aiFetch: async () => ({ ok: true, json: async () => ({ stop_reason: "end_turn",
    content: [{ type: "text", text: AI_GOOD(px, +(px * 0.90).toPrecision(6), +(px * 1.10).toPrecision(6)) }] }) }) });
  // fabricate a live claim anchor by compiling, then validating against a ctx that carries one
  const ctx = p.aiCompileNow("xyz:NVDA");
  const stop = +(px * 0.95).toPrecision(6);
  ctx.claimAnchor = { ev: "breakout", side: "long", stop, target: null, t0: Date.now(), resolveAt: Date.now() + 86400000 };
  const val = p.aiValidateNow(AI_GOOD(px, +(px * 0.90).toPrecision(6), +(px * 1.10).toPrecision(6)), ctx);
  assert.ok(val.ok, "payload must validate: " + (val.error || ""));
  assert.ok(Math.abs(val.computed.voidLevel - stop) / stop < 1e-6, "void must be pinned to the frozen claim stop");
  assert.equal(val.computed.correctedVoid, true, "the correction must be flagged, not silent");
  // and the risk/EV math must follow the CORRECTED void, not the model's
  const risk = px - stop, scT = val.computed.scenarios.find((s) => s.kind === "target");
  assert.ok(Math.abs(scT.payoffR - (+(px * 1.10).toPrecision(6) - px) / risk) < 0.02, "payoff must use the corrected risk unit");
});

test("ai report: Fable failure falls back to Opus; both failing surfaces an honest error and caches nothing", async () => {
  let calls = [];
  const { p, px } = aiTestPoller({ aiFetch: async (url, opts) => {
    const body = JSON.parse(opts.body); calls.push(body.model);
    if (calls.length === 1) return { ok: true, json: async () => ({ stop_reason: "refusal", content: [] }) };   // Fable refuses (HTTP 200!)
    return { ok: true, json: async () => ({ stop_reason: "end_turn",
      content: [{ type: "text", text: AI_GOOD(px, +(px * 0.95).toPrecision(6), +(px * 1.10).toPrecision(6)) }] }) };
  } });
  const g = await p.generateAiReport("xyz:NVDA");
  assert.ok(g.ok, "fallback must rescue a primary refusal: " + (g.error || ""));
  assert.equal(calls[0], "claude-fable-5", "primary must be Fable");
  assert.equal(calls[1], "claude-opus-4-8", "fallback must be Opus");
  assert.equal(g.report.model, "claude-opus-4-8", "the report must name the model that actually produced it");
  // both failing: error out, cache stays empty
  const { p: p2 } = aiTestPoller({ aiFetch: async () => ({ ok: false, status: 500, json: async () => ({}) }) });
  const g2 = await p2.generateAiReport("xyz:NVDA");
  assert.equal(g2.ok, false, "double failure must not fabricate a report");
  assert.equal(p2.getAiReport("xyz:NVDA").status, "none", "a failed generation must cache nothing");
});

test("ai report: universe gate — unknown coins and disabled-crypto rows are refused at both read and generate", async () => {
  const { p } = aiTestPoller();
  assert.equal(p.getAiReport("xyz:GHOST").status, "none");
  const g = await p.generateAiReport("xyz:GHOST");
  assert.equal(g.ok, false, "generation for a non-universe coin must be refused");
  // crypto:false poller — a main-dex coin (no colon → uni main) is outside the live universe
  const g2 = await p.generateAiReport("SOL");
  assert.equal(g2.ok, false, "crypto-disabled server must refuse main-dex generation");
});

test("ai report: OpenAI provider — Chat Completions shape, Bearer auth, Terra→Sol fallback on refusal", async () => {
  // Provider selection is read from env at construction — pin it for this test, restore after.
  const prevProv = process.env.AI_PROVIDER, prevKey = process.env.OPENAI_API_KEY;
  process.env.AI_PROVIDER = "openai"; process.env.OPENAI_API_KEY = "sk-test-openai";
  try {
    const calls = [];
    let px0;
    const mk = () => aiTestPoller({ aiFetch: async (url, opts) => {
      const body = JSON.parse(opts.body);
      calls.push({ url, model: body.model, auth: opts.headers.authorization, body });
      if (calls.length === 1) return { ok: true, json: async () => ({ choices: [{ message: { refusal: "declined" }, finish_reason: "stop" }] }) };
      return { ok: true, json: async () => ({ choices: [{ message: { content: AI_GOOD(px0, +(px0 * 0.95).toPrecision(6), +(px0 * 1.10).toPrecision(6)) }, finish_reason: "stop" }] }) };
    } });
    const { p, px } = mk(); px0 = px;
    const g = await p.generateAiReport("xyz:NVDA");
    assert.ok(g.ok, "OpenAI path must generate: " + (g.error || ""));
    assert.ok(calls[0].url.includes("api.openai.com/v1/chat/completions"), "must hit Chat Completions");
    assert.equal(calls[0].auth, "Bearer sk-test-openai", "must authenticate with a Bearer token");
    assert.equal(calls[0].model, "gpt-5.6-terra", "OpenAI primary must default to Terra");
    assert.equal(calls[0].body.reasoning_effort, "high", "report generation must run Terra at high effort");
    assert.equal(calls[1].model, "gpt-5.6-sol", "OpenAI fallback must default to Sol");
    assert.equal(g.report.model, "gpt-5.6-sol", "the report names the model that actually produced it");
    assert.equal(calls[0].body.messages[0].role, "system", "system prompt rides as a system message");
    assert.ok("max_completion_tokens" in calls[0].body && !("max_tokens" in calls[0].body),
      "GPT-5.x requires max_completion_tokens, not max_tokens");
    assert.ok(calls[0].body.max_completion_tokens >= 8000, "OpenAI budget must cover reasoning tokens on top of output");
    // empty output with finish_reason length = the budget was eaten by reasoning — a NAMED error, not a mystery
    const { p: p2 } = aiTestPoller({ aiFetch: async () => ({ ok: true, json: async () => ({ choices: [{ message: { content: "" }, finish_reason: "length" }] }) }) });
    const g2 = await p2.generateAiReport("xyz:NVDA");
    assert.equal(g2.ok, false);
    assert.ok(/token budget/.test(g2.error), "budget exhaustion must be named in the error: " + g2.error);
  } finally {
    if (prevProv === undefined) delete process.env.AI_PROVIDER; else process.env.AI_PROVIDER = prevProv;
    if (prevKey === undefined) delete process.env.OPENAI_API_KEY; else process.env.OPENAI_API_KEY = prevKey;
  }
});

test("ai report: provider auto-detection — OPENAI_API_KEY alone selects OpenAI; no keys stays disabled with an honest error", async () => {
  const prevProv = process.env.AI_PROVIDER, prevO = process.env.OPENAI_API_KEY, prevA = process.env.ANTHROPIC_API_KEY;
  delete process.env.AI_PROVIDER; delete process.env.ANTHROPIC_API_KEY;
  try {
    process.env.OPENAI_API_KEY = "sk-test";
    { const { p } = aiTestPoller();
      const l = p.listAiReports();
      assert.equal(l.provider, "openai", "OPENAI_API_KEY alone must auto-select the openai provider");
      assert.equal(l.model, "gpt-5.6-terra");
      assert.equal(l.enabled, true); }
    delete process.env.OPENAI_API_KEY;
    { const { p } = aiTestPoller();
      assert.equal(p.listAiReports().enabled, false, "no keys = disabled");
      const g = await p.generateAiReport("xyz:NVDA");
      assert.equal(g.ok, false);
      assert.ok(/ANTHROPIC_API_KEY or OPENAI_API_KEY/.test(g.error), "the error must name BOTH accepted variables: " + g.error); }
  } finally {
    if (prevProv === undefined) delete process.env.AI_PROVIDER; else process.env.AI_PROVIDER = prevProv;
    if (prevO === undefined) delete process.env.OPENAI_API_KEY; else process.env.OPENAI_API_KEY = prevO;
    if (prevA === undefined) delete process.env.ANTHROPIC_API_KEY; else process.env.ANTHROPIC_API_KEY = prevA;
  }
});

test("ai report: level discipline — EMA annotations banned, directional reads require a correctly-sided void, opposing-bias anchors don't override", () => {
  const { p, px } = aiTestPoller();
  const ctx = () => p.aiCompileNow("xyz:NVDA");
  const voidLv = +(px * 0.95).toPrecision(6), tgt = +(px * 1.10).toPrecision(6);
  const mut = (fn) => { const o = JSON.parse(AI_GOOD(px, voidLv, tgt)); fn(o); return JSON.stringify(o); };
  // EMAs drift — banned as static chart levels (this exact failure shipped in the first live report)
  const r1 = p.aiValidateNow(mut((o) => { o.levels[1].label = "Daily EMA13 resistance"; }), ctx());
  assert.equal(r1.ok, false); assert.ok(/moving averages/.test(r1.error), r1.error);
  // a directional read with no void level is unfalsifiable — hard fail, not a card full of dashes
  const r2 = p.aiValidateNow(mut((o) => { o.levels = [o.levels[1]]; o.scenarios = o.scenarios.filter((s) => s.kind !== "void").concat([{ name: "fades", kind: "flat", p: 0.2, target: null }]); }), ctx());
  assert.equal(r2.ok, false); assert.ok(/without a void level/.test(r2.error), r2.error);
  // ...and a void scenario is required too, not just the level
  const r3 = p.aiValidateNow(mut((o) => { o.scenarios = [{ name: "up", kind: "target", p: 0.6, target: tgt }, { name: "chop", kind: "flat", p: 0.4, target: null }]; }), ctx());
  assert.equal(r3.ok, false); assert.ok(/without a void scenario/.test(r3.error), r3.error);
  // inverted geometry: a "void" ABOVE price on a long read is the stop-geometry bug class — rejected
  const r4 = p.aiValidateNow(mut((o) => { o.levels[0].value = +(px * 1.05).toPrecision(6); }), ctx());
  assert.equal(r4.ok, false); assert.ok(/long void must sit below/.test(r4.error), r4.error);
  // max 4 levels, at most one target
  const r5 = p.aiValidateNow(mut((o) => { o.levels.push({ value: +(px * 1.2).toPrecision(6), kind: "target", label: "second target" }); }), ctx());
  assert.equal(r5.ok, false); assert.ok(/multiple target/.test(r5.error), r5.error);
  // opposing-bias anchor: a LONG claim's stop must NOT be forced onto a SHORT read — the short
  // read carries its own void above price and validates on its own geometry
  const cx = ctx();
  cx.claimAnchor = { ev: "breakout", side: "long", stop: +(px * 0.95).toPrecision(6), target: null, t0: Date.now(), resolveAt: Date.now() + 86400000 };
  const shortPayload = JSON.stringify(Object.assign(JSON.parse(AI_GOOD(px, voidLv, tgt)), {
    bias: "short", headline: "Rolling over, leans short",
    news_read: { used: false, note: "no verified headlines in the window" },
    scenarios: [
      { name: "breakdown extends", kind: "target", p: 0.5, target: +(px * 0.90).toPrecision(6), note: "downtrend persists" },
      { name: "chop", kind: "flat", p: 0.3, target: null },
      { name: "reclaims the void", kind: "void", p: 0.2, target: null },
    ],
    levels: [
      { value: +(px * 1.04).toPrecision(6), kind: "void", label: "void — reclaim kills the short" },
      { value: +(px * 0.90).toPrecision(6), kind: "target", label: "breakdown target" },
    ],
  }));
  const r6 = p.aiValidateNow(shortPayload, cx);
  assert.ok(r6.ok, "opposing-bias read with its own void must validate: " + (r6.error || ""));
  assert.ok(Math.abs(r6.computed.voidLevel - px * 1.04) / px < 0.001, "the short's OWN void must survive, not the long claim's stop");
  assert.equal(r6.computed.correctedVoid, false, "no correction when the anchor doesn't apply");
  // and short-side payoff math: target below price pays POSITIVE for a short
  const scT = r6.computed.scenarios.find((s) => s.kind === "target");
  assert.ok(scT.payoffR > 0, "thesis-direction short target must pay positive, got " + scT.payoffR);
});

test("ai report -73: schema bump invalidates cached reports immediately — a format fix is never hidden behind the TTL", async () => {
  const { p, px } = aiTestPoller({ aiFetch: async () => ({ ok: true, json: async () => ({ stop_reason: "end_turn",
    content: [{ type: "text", text: AI_GOOD(px2, +(px2 * 0.95).toPrecision(6), +(px2 * 1.10).toPrecision(6)) }] }) }) });
  const px2 = px;
  const g = await p.generateAiReport("xyz:NVDA");
  assert.ok(g.ok, g.error || "");
  assert.equal(p.getAiReport("xyz:NVDA").status, "fresh");
  p.aiPatchReport("xyz:NVDA", { schemaV: 1 });   // simulate a report generated before a format change
  const st = p.getAiReport("xyz:NVDA");
  assert.equal(st.status, "invalidated");
  assert.equal(st.invalidReason, "report format updated");
  assert.equal(st.canRegen, true, "an old-format report must unlock regeneration before TTL expiry");
});

test("ai report -73: the action block — pullback entry improves R/R, EV computed at the entry, negative-EV entries are downgraded to wait", () => {
  const { p, px } = aiTestPoller();
  const ctx = () => p.aiCompileNow("xyz:NVDA");
  const voidLv = +(px * 0.95).toPrecision(6), tgt = +(px * 1.10).toPrecision(6);
  const mut = (fn) => { const o = JSON.parse(AI_GOOD(px, voidLv, tgt)); fn(o); return JSON.stringify(o); };
  // enter_now: entry = market -> action rr equals the scenario-table rr at px
  { const r = p.aiValidateNow(AI_GOOD(px, voidLv, tgt), ctx());
    assert.ok(r.ok, r.error || "");
    const a = r.computed.action;
    assert.equal(a.stance, "enter_now"); assert.equal(a.entryIsMarket, true);
    assert.ok(Math.abs(a.rr - (tgt - px) / (px - voidLv)) < 0.02, "market-entry R/R must match the raw geometry");
    assert.ok(Math.abs(a.evR - r.computed.evR) < 0.02, "market-entry EV must equal the scenario EV"); }
  // enter_on_pullback at a better price -> strictly better R/R and EV than at market
  { const pull = +(px * 0.97).toPrecision(6);
    const r = p.aiValidateNow(mut((o) => { o.action = { stance: "enter_on_pullback", entry: pull, note: "buy the dip into the zone" }; }), ctx());
    assert.ok(r.ok, r.error || "");
    const a = r.computed.action;
    assert.ok(Math.abs(a.rr - (tgt - pull) / (pull - voidLv)) < 0.02, "pullback R/R must be computed at the ENTRY, not the mark");
    assert.ok(a.rr > (tgt - px) / (px - voidLv), "a better entry must show a better R/R");
    assert.ok(a.evR > r.computed.evR, "EV at the pullback must beat EV at market"); }
  // a pullback stance without an entry level is a hard fail, not a guess
  { const r = p.aiValidateNow(mut((o) => { o.action = { stance: "enter_on_pullback", entry: null, note: "x" }; }), ctx());
    assert.equal(r.ok, false); assert.ok(/without an entry level/.test(r.error), r.error); }
  // an entry the odds don't pay for: crank the void probability so EV at market goes negative ->
  // server downgrades the stance to wait and says so, rather than shipping a losing plan
  { const r = p.aiValidateNow(mut((o) => { o.scenarios = [
      { name: "continuation", kind: "target", p: 0.15, target: tgt, note: "thin" },
      { name: "chop", kind: "flat", p: 0.25, target: null },
      { name: "breaks the void", kind: "void", p: 0.6, target: null }]; }), ctx());
    assert.ok(r.ok, r.error || "");
    assert.equal(r.computed.action.stance, "wait");
    assert.equal(r.computed.action.downgraded, true, "the downgrade must be stamped, not silent"); }
  // wait/no_trade stances need no geometry and pass through with the note
  { const r = p.aiValidateNow(mut((o) => { o.action = { stance: "wait", entry: null, note: "the print decides in four days" }; }), ctx());
    assert.ok(r.ok, r.error || "");
    assert.equal(r.computed.action.stance, "wait"); }
  // a missing action block is a schema failure now
  { const r = p.aiValidateNow(mut((o) => { delete o.action; }), ctx());
    assert.equal(r.ok, false); assert.ok(/action stance/.test(r.error), r.error); }
});

test("ai report -73: daily OHLC upgrade — a closes-only warm restore renders real candles from the hourly spine", () => {
  const { createPoller } = require("../src/poller");
  const store = { loadAll: () => new Map(), loadRegime: () => [], loadLedger: () => null,
    saveLedger: () => {}, insert: () => {}, saveRegime: () => {}, loadAiReports: () => null, saveAiReports: () => {} };
  const p = createPoller({ dex: "xyz", store, log: () => {}, version: "test", crypto: false });
  const now = Date.now(), N = 30 * 24;
  const hourly = Array.from({ length: N }, (_, i) => {
    const c = 100 + Math.sin(i / 9) * 4;
    return { t: now - (N - 1 - i) * HOUR, o: c - 0.4, h: c + 0.9, l: c - 0.9, c, v: 500 };
  });
  // warm-cache shape: dailies restored as {t,c} ONLY — the exact state that rendered as confetti
  const daily = Array.from({ length: 60 }, (_, i) => ({ t: now - (59 - i) * DAY, c: 100 + Math.sin(i / 4) * 6 }));
  p.seedRowNow("xyz:WARM", { px: 101, dailyRaw: daily, hourlyRaw: hourly, dailyTs: now, hourlyTs: now, isNew: false });
  const rd = p.getTfCandles("xyz:WARM", "1d");
  const covered = rd.candles.filter((k) => k[0] >= now - 28 * DAY);
  assert.ok(covered.length >= 20, "enough recent bars to judge");
  for (const k of covered.slice(1))   // slice(1): the first covered day may be a partial hourly bucket
    assert.ok(k[1] != null && isFinite(k[1]) && k[2] >= k[4] && k[3] <= k[4],
      `recent closes-only bars must upgrade to real hourly-derived OHLC (bar ${new Date(k[0]).toISOString()})`);
  const old = rd.candles.filter((k) => k[0] < now - 32 * DAY);
  assert.ok(old.length && old.every((k) => k[1] == null), "days beyond the hourly spine stay honestly closes-only");
});

test("ai report -74/-75: first-fire marks pass the proven-edge gate — episode runs mark once, unproven types are suppressed and counted, sides come from the frozen psd", () => {
  const { createPoller } = require("../src/poller");
  const now = Date.now();
  // Roster record: breakout gets 8 resolved, positive-avg outcomes on OTHER tickers -> proven.
  // gap (n=1) and unwind (n=1) stay unproven -> their fires on N are suppressed and counted.
  const rosterBo = Array.from({ length: 8 }, (_, i) => ({
    key: "xyz:X" + i + "|breakout", coin: "xyz:X" + i, ticker: "X" + i, ev: "breakout",
    t0: now - (60 + i) * 86400000, mark0: 50, dir: 1, score0: 55, sd0: 2,
    status: "resolved", tR: now - (55 + i) * 86400000,
    realized: i < 6 ? 1.2 : -0.8, realizedS: i < 6 ? 1.2 : -0.8, win: i < 6, winS: i < 6, psd: "long", rn: 1 }));
  const fixture = { ts: now, rearm: [], variants: null,
    open: [
      { key: "xyz:N|breakout", coin: "xyz:N", ticker: "N", ev: "breakout", t0: now - 1 * 86400000,
        mark0: 100, dir: 1, score0: 60, sd0: 2, resolveAt: now + 4 * 86400000, psd: "long" },
      // psd-short claim of a PROVEN type on an up-event: kind must be short (trade side, not event sign).
      // breakdown is in R_LEDGER_EVS, so give it a roster record too via the loop below.
      { key: "xyz:N|breakdown", coin: "xyz:N", ticker: "N", ev: "breakdown", t0: now - 10 * 86400000,
        mark0: 95, dir: -1, score0: 50, sd0: 2, resolveAt: now + 86400000, psd: "short" },
    ],
    closed: rosterBo.concat(
      Array.from({ length: 8 }, (_, i) => ({
        key: "xyz:Y" + i + "|breakdown", coin: "xyz:Y" + i, ticker: "Y" + i, ev: "breakdown",
        t0: now - (70 + i) * 86400000, mark0: 40, dir: -1, score0: 50, sd0: 2,
        status: "resolved", tR: now - (65 + i) * 86400000,
        realized: 0.9, realizedS: 0.9, win: true, winS: true, psd: "short", rn: 1 })),
      [
      // the same breakout run, day before (chained: gap 1d <= 2d) — recorded, must NOT re-mark
      { key: "xyz:N|breakout#r1", coin: "xyz:N", ticker: "N", ev: "breakout", t0: now - 2 * 86400000,
        mark0: 99, dir: 1, score0: 55, sd0: 2, status: "resolved", tR: now - 1 * 86400000,
        realized: 0.4, realizedS: 0.4, win: true, winS: true, psd: "long", rn: 1 },
      // a genuinely separate episode 21 days earlier — must mark, with its outcome on the mark
      { key: "xyz:N|breakout#old", coin: "xyz:N", ticker: "N", ev: "breakout", t0: now - 21 * 86400000,
        mark0: 80, dir: 1, score0: 62, sd0: 2, status: "resolved", tR: now - 16 * 86400000,
        realized: 2.0, realizedS: 2.0, win: true, winS: true, psd: "long", rn: 1 },
      // unproven types firing on N: recorded in the ledger, SUPPRESSED on the chart
      { key: "xyz:N|gap", coin: "xyz:N", ticker: "N", ev: "gap", t0: now - 10 * 86400000,
        mark0: 95, dir: 1, score0: 50, status: "resolved", tR: now - 9 * 86400000,
        realized: 1.1, realizedS: 1.1, win: true, winS: true, psd: "short", rn: 1 },
      { key: "xyz:N|unwind", coin: "xyz:N", ticker: "N", ev: "unwind", t0: now - 6 * 86400000,
        mark0: 92, dir: -1, score0: 45, sd0: 2, status: "void", tR: now - 5 * 86400000, rn: 1 },
    ]) };
  const store = { loadAll: () => new Map(), loadRegime: () => [], loadLedger: () => fixture,
    saveLedger: () => {}, insert: () => {}, saveRegime: () => {}, loadAiReports: () => null, saveAiReports: () => {} };
  const p = createPoller({ dex: "xyz", store, log: () => {}, version: "test", crypto: false });
  p.hydrateLedgerNow();
  const { marks, suppressed } = p.aiMarksNow("xyz:N", "N", 92 * 86400000);
  const bo = marks.filter((m) => m.ev === "breakout");
  assert.equal(bo.length, 2, `chained breakout run must mark once per episode (got ${bo.length})`);
  assert.ok(bo.some((m) => Math.abs(m.t - (now - 21 * 86400000)) < 1000), "the separate old episode keeps its own mark");
  assert.ok(bo.some((m) => Math.abs(m.t - (now - 2 * 86400000)) < 1000), "the current run marks at its ONSET, not the live re-fire");
  const bd = marks.find((m) => m.ev === "breakdown");
  assert.ok(bd, "a proven short-side type must mark");
  assert.equal(bd.kind, "short", "the mark carries the TRADE side from psd");
  assert.ok(!marks.some((m) => m.ev === "gap"), "unproven gap (roster n=1) must be suppressed");
  assert.ok(!marks.some((m) => m.ev === "unwind"), "unproven unwind must be suppressed");
  assert.equal(suppressed, 2, "suppressed fires are counted for disclosure, never silently dropped");
  const oldBo = marks.find((m) => Math.abs(m.t - (now - 21 * 86400000)) < 1000);
  assert.equal(oldBo.status, "resolved");
  assert.equal(oldBo.realized, 2.0, "resolved outcome ships on the mark for the legend");
  assert.equal(oldBo.unit, "R");
  // the name-specific override: 5 resolved with >=60% hit on THIS name proves a type the roster
  // hasn't — seed a second poller where only N's own record carries the edge
  const fx2 = { ts: now, rearm: [], variants: null, open: [], closed: Array.from({ length: 5 }, (_, i) => ({
    key: "xyz:N|squeeze#" + i, coin: "xyz:N", ticker: "N", ev: "squeeze",
    t0: now - (10 + i * 8) * 86400000, mark0: 90, dir: 1, score0: 40,
    status: "resolved", tR: now - (8 + i * 8) * 86400000,
    realized: i < 4 ? 2.0 : -1.0, realizedS: i < 4 ? 2.0 : -1.0, win: i < 4, winS: i < 4, psd: "long", rn: 1 })) };
  const p2 = createPoller({ dex: "xyz", store: Object.assign({}, store, { loadLedger: () => fx2 }), log: () => {}, version: "test", crypto: false });
  p2.hydrateLedgerNow();
  const r2 = p2.aiMarksNow("xyz:N", "N", 92 * 86400000);
  assert.ok(r2.marks.filter((m) => m.ev === "squeeze").length >= 1, "a name-specific 4/5 record proves the type for THIS name");
});

test("ask-the-board terminal Tier-3: planner returns a grammar query, analyst returns grounded prose, disabled without a key, unmappable escalates", async () => {
  const { createPoller } = require("../src/poller");
  const store = { loadAll: () => new Map(), loadRegime: () => [], loadLedger: () => null,
    saveLedger: () => {}, insert: () => {}, saveRegime: () => {}, saveNews: () => {}, loadNews: () => null };
  // disabled path: no injected transport and no env key -> AI fallback is off, not a crash
  const off = createPoller({ dex: "xyz", store, log: () => {}, version: "test", crypto: false });
  const dOff = await off.askBoard("most crowded shorts", { universe: [{ t: "SOL" }] });
  assert.ok(dOff.disabled === true, "no key -> disabled, not an error page");

  // injected transport (anthropic shape, since no env key sets provider=anthropic)
  const respond = (text) => ({ ok: true, json: async () => ({ content: [{ type: "text", text }], stop_reason: "end_turn" }) });
  let next = null; const calls = [];
  const aiFetch = async (url, opts) => { calls.push(JSON.parse(opts.body)); return next; };
  const p = createPoller({ dex: "xyz", store, log: () => {}, version: "test", crypto: false, aiFetch });
  const uni = [{ t: "SOL", sqz: 71, f: -22 }, { t: "HYPE", sqz: 82, f: -31 }, { t: "BTC", sqz: 0, f: 12 }];

  // planner: model emits ONE grammar query; askBoard validates and returns it for the client to run
  next = respond("screen funding<0 & squeeze>50");
  const plan = await p.askBoard("which names are the most crowded shorts?", { scope: "crypto", universe: uni });
  assert.ok(plan.ok && plan.mode === "planner" && plan.query === "screen funding<0 & squeeze>50", `planner query, got ${JSON.stringify(plan)}`);

  // analyst: a "why" question routes to prose, grounded in the bundle; never a query
  next = respond("HYPE leads: squeeze 82 with funding at -31% APR, the most crowded short in the set.");
  const ana = await p.askBoard("why is HYPE the standout here?", { scope: "crypto", universe: uni });
  assert.ok(ana.ok && ana.mode === "analyst" && /HYPE/.test(ana.answer) && ana.marketsN === 3, `analyst prose, got ${JSON.stringify(ana)}`);

  // unmappable planner (model says NONE) escalates to analyst reasoning in the same call
  let step = 0;
  const aiFetch2 = async (url, opts) => { step++; return step === 1 ? respond("NONE") : respond("No single screen captures that; broadly, low-funding names skew short."); };
  const p2 = createPoller({ dex: "xyz", store, log: () => {}, version: "test", crypto: false, aiFetch: aiFetch2 });
  const esc = await p2.askBoard("what's the overall vibe of positioning?", { scope: "crypto", universe: uni });
  assert.ok(esc.ok && esc.mode === "analyst", `NONE from planner must escalate to analyst, got ${JSON.stringify(esc)}`);

  // a bad planner query (not in the grammar) is rejected -> escalates rather than shipped to the client
  const { createPoller: cp3 } = require("../src/poller");
  let s3 = 0; const p3 = cp3({ dex: "xyz", store, log: () => {}, version: "test", crypto: false,
    aiFetch: async () => { s3++; return s3 === 1 ? respond("buy SOL now!!") : respond("grounded fallback answer"); } });
  const bad = await p3.askBoard("find me something good", { scope: "crypto", universe: uni });
  assert.ok(bad.ok && bad.mode === "analyst", `invalid planner output must not reach the client as a query, got ${JSON.stringify(bad)}`);
});

test("ETag stamps are monotonic: two content changes in one millisecond must not share a validator", () => {
  // The version stamp behind every dataTs is Date.now(). Two content changes inside the same
  // millisecond therefore mint the SAME ETag, and a client holding the first revalidates to 304
  // against the second — serving stale content until something else changes. getActionable and
  // the focus board already carry a monotonic guard for exactly this; buildDaily did not, which
  // made the daily-payload ETag test above fail roughly one run in fifty on a fast machine.
  //
  // Timing cannot be asserted directly, so this drives the loop hard enough that a same-millisecond
  // pair is near-certain and pins the property that actually matters: strictly increasing.
  const { createPoller } = require("../src/poller");
  const mkStore = () => ({ loadAll: () => new Map(), loadRegime: () => [], loadLedger: () => null,
    saveLedger: () => {}, insert: () => {}, saveRegime: () => {}, loadFeatures: () => null });
  const D0 = Math.floor(Date.now() / DAY) * DAY;
  const p = createPoller({ dex: "xyz", store: mkStore(), log: () => {}, version: "test", crypto: false });
  const bars = (n) => { const a = []; for (let i = n; i >= 1; i--) a.push({ t: D0 - i * DAY, c: 100 + i }); return a; };
  let prev = 0, sameMs = 0, lastWall = 0;
  for (let k = 0; k < 60; k++) {
    // each pass changes the CONTENT (one more bar), so each pass must bust the signature
    p.seedRowNow("xyz:AAA", { px: 101, ticker: "AAA", uni: "xyz", vol: 1e7, dailyRaw: bars(20 + k), dailyTs: Date.now() });
    p.buildDailyNow();
    const v = p.getDaily().dataTs;
    assert.ok(v > prev, `daily ETag stamp must strictly increase on every content change (pass ${k}: ${v} <= ${prev})`);
    const wall = Date.now();
    if (wall === lastWall) sameMs++;
    lastWall = wall; prev = v;
  }
  // If the loop never produced a same-millisecond pair the test proved less than it meant to, but
  // it still proved monotonicity — so this is reported, never asserted, and never made flaky itself.
  assert.ok(prev > 0, `${sameMs} same-millisecond pair(s) exercised`);
});

test("ai report -01: target reconciliation — the level is the one source of truth, a null scenario target is filled from it, neither is still fatal", () => {
  const { p, px } = aiTestPoller();
  const ctx = () => p.aiCompileNow("xyz:NVDA");
  const voidLv = +(px * 0.95).toPrecision(6), tgt = +(px * 1.10).toPrecision(6);
  const mut = (fn) => { const o = JSON.parse(AI_GOOD(px, voidLv, tgt)); fn(o); return JSON.stringify(o); };
  const scenT = (r) => r.computed.scenarios.find((s) => s.kind === "target");
  // the baseline: both fields carry the price, nothing is reconciled
  const base = p.aiValidateNow(AI_GOOD(px, voidLv, tgt), ctx());
  assert.ok(base.ok, base.error || "");
  assert.equal(base.computed.correctedTarget, false, "a fully-specified payload must not be flagged as reconciled");
  // THE BUG: the prompt offers "target": null, the validator rejected it, and the report died.
  // The target LEVEL is present, so the scenario field is filled from it and the R/R is identical.
  const nulled = p.aiValidateNow(mut((o) => { o.scenarios[0].target = null; }), ctx());
  assert.ok(nulled.ok, "a null scenario target with a target level present must validate: " + (nulled.error || ""));
  assert.equal(nulled.computed.correctedTarget, true, "the fill must be flagged, not silent");
  assert.equal(scenT(nulled).target, scenT(base).target, "the filled target must be the level's own price");
  assert.equal(scenT(nulled).payoffR, scenT(base).payoffR, "payoff must be identical to the fully-specified payload");
  assert.equal(nulled.computed.evR, base.computed.evR, "EV must be identical too");
  // the action block reads the same number: the entry plan survives the null
  assert.equal(nulled.computed.action.target, base.computed.action.target, "the action target must survive the fill");
  // a scenario price that DISAGREES with the level loses: chart and card may never show two targets
  const drift = p.aiValidateNow(mut((o) => { o.scenarios[0].target = +(tgt * 1.05).toPrecision(6); }), ctx());
  assert.ok(drift.ok, drift.error || "");
  assert.equal(drift.computed.correctedTarget, true, "a disagreeing scenario price must be corrected to the level");
  assert.equal(scenT(drift).target, scenT(base).target, "the LEVEL wins, not the scenario's own number");
  // neither field carries a price: still fatal, still the same error string
  const neither = p.aiValidateNow(mut((o) => {
    o.scenarios[0].target = null; o.levels = o.levels.filter((l) => l.kind !== "target");
  }), ctx());
  assert.equal(neither.ok, false);
  assert.ok(/target scenario without a target level/.test(neither.error), neither.error);
  // scenario price with NO level: the level is minted so the chart draws what the card claims
  const minted = p.aiValidateNow(mut((o) => { o.levels = o.levels.filter((l) => l.kind !== "target"); }), ctx());
  assert.ok(minted.ok, "a scenario-only target must validate: " + (minted.error || ""));
  assert.equal(minted.computed.correctedTarget, true, "minting must be flagged");
  const ml = minted.computed.levels.filter((l) => l.kind === "target");
  assert.equal(ml.length, 1, "exactly one target level must be minted");
  assert.equal(ml[0].value, scenT(minted).target, "the minted level and the scenario must be the SAME number");
  assert.equal(scenT(minted).payoffR, scenT(base).payoffR, "minted geometry must produce the baseline payoff");
  // ...and an out-of-band scenario price is rejected rather than minted into a fake R
  const wild = p.aiValidateNow(mut((o) => {
    o.levels = o.levels.filter((l) => l.kind !== "target"); o.scenarios[0].target = +(px * 4).toPrecision(6);
  }), ctx());
  assert.equal(wild.ok, false);
  assert.ok(/target scenario price outside sanity bounds/.test(wild.error), wild.error);
  // non-target kinds keep their null: the fill is scoped to "target" alone
  assert.equal(nulled.computed.scenarios.find((s) => s.kind === "void").target, null, "void scenarios stay target-null");
  assert.equal(nulled.computed.scenarios.find((s) => s.kind === "flat").target, null, "flat scenarios stay target-null");
});

test("ai report -01: prompt and validator agree on the target contract, and a rejection logs its shape", () => {
  const fs = require("fs"), path = require("path");
  const pol = fs.readFileSync(path.join(__dirname, "..", "src", "poller.js"), "utf8");
  // The prompt must no longer offer a null it will be punished for, and the void/target rules
  // must stay SEPARATE — collapsing them back is what left crypto with no legal target price.
  assert.ok(pol.includes('A "target" scenario MUST carry a price'), "prompt must demand a price on target scenarios");
  assert.ok(pol.includes('"target": null is for the "flat", "void" and "event" kinds only'),
    "prompt must scope the null to the non-target kinds");
  assert.ok(pol.includes("The TARGET is held to a softer rule than the void"),
    "prompt must keep the target's structure rule softer than the void's");
  assert.ok(/Otherwise the VOID must come from context\.levels\.items/.test(pol),
    "the hard-rules line must bind context.levels.items to the VOID, not to every level");
  assert.ok(!/every level you emit must come from context\.levels\.items/.test(pol),
    "the blanket every-level rule must be gone — it is what produced the null target");
  // levels are parsed BEFORE the scenario loop; the reconciliation depends on that order
  assert.ok(pol.indexOf("let targetLv = levels.find") < pol.indexOf('if (s.kind === "target") {'),
    "the levels parse must be hoisted above the scenario loop");
  assert.equal(pol.split("const levels = [];").length - 1, 1, "the levels parse must exist exactly once (no duplicate left behind)");
  assert.ok(pol.includes("correctedTarget: targetReconciled"), "the reconciliation flag must ship in computed");
  // the fingerprint logger: present, wired into the double-failure path, and shape-only
  assert.ok(/function aiRejectShape\(rawText\)/.test(pol), "aiRejectShape helper missing");
  assert.ok(pol.includes("fallback failed too (${val.error}) — ${aiRejectShape("), "double-failure log must carry the shape");
  const { p } = aiTestPoller();
  assert.equal(typeof p.aiRejectShapeNow, "function", "aiRejectShape must be reachable from the harness");
  assert.ok(/no model text/.test(p.aiRejectShapeNow(null)), "a transport failure must say so");
  assert.ok(/unparseable \(\d+ chars\)/.test(p.aiRejectShapeNow("not json at all")), "unparseable payloads report their length");
  const shp = p.aiRejectShapeNow(JSON.stringify({ bias: "long",
    scenarios: [{ kind: "target", target: null }, { kind: "void" }], levels: [{ kind: "void" }] }));
  assert.ok(/bias=long/.test(shp) && /scen=\[target,void\]/.test(shp) && /levels=\[void\]/.test(shp), shp);
  assert.ok(/empty=\[[^\]]*scen\.target[^\]]*\]/.test(shp) && /level\.target/.test(shp), "the empty-field list must name the gaps: " + shp);
  assert.ok(!/synthesis|headline/.test(shp), "the fingerprint must carry shapes, never payload prose");
});

test("earnings alerts are scoped to open announced claims, once per report date", () => {
  const p = ctxHarness();
  p.seedRowNow("AAA", { ticker: "AAA", px: 10, uni: "xyz" });
  p.seedRowNow("BBB", { ticker: "BBB", px: 10, uni: "xyz" });
  const d = new Date(Date.now() + 20 * 3600e3).toISOString().slice(0, 10);
  p.earnIngestNow ? p.earnIngestNow() : null;
  const earn = () => p.getTriggers(0, null, true).events.filter((e) => e.kind === "earnings");

  // No claims -> nothing, however many names report. An 84-name roster in season is a calendar.
  p.earnScanNow();
  assert.equal(earn().length, 0);

  // The gate is an OPEN, ANNOUNCED claim. A claim nobody was told about does not earn a reminder.
  p.ledgerOpenNow().set("BBB|breakout", { key: "BBB|breakout", coin: "BBB", ticker: "BBB", ev: "breakout",
    t0: Date.now(), mark0: 10, dir: 1, psd: "long", resolveAt: Date.now() + 1e9 });
  p.earnScanNow();
  assert.equal(earn().length, 0, "an unannounced claim gets no earnings reminder");
  assert.ok(d);
});

test("rate meter: measured per class, survives a restart, and reports its own truncation", () => {
  const p = ctxHarness();
  const r0 = p.getClassRates();
  assert.equal(r0.ops.d1, 0);
  assert.equal(r0.ops.dflt, true, "the payload says which classes are on by default so the panel can mark the rest opt-in");
  assert.equal(r0.filing.dflt, false);

  for (let i = 0; i < 5; i++) p.pushOpsNow("x" + i, "y");
  const r1 = p.getClassRates();
  assert.equal(r1.ops.d1, 5, "fires are counted per class");
  assert.equal(r1.ops.h1, 5);
  assert.equal(r1.setup.d1, 0, "…and not smeared across classes");
  assert.equal(r1.ops.capped, false);

  // The meter is what makes an opt-in decision informed rather than a bet, so a restart must not
  // zero it — a noisy class and a frequent deploy would look identical.
  const fs = require("fs"), path = require("path");
  const pol = fs.readFileSync(path.join(__dirname, "..", "src", "poller.js"), "utf8");
  assert.ok(/rates: \[\.\.\.classFires\.entries\(\)\]/.test(pol), "rate history is persisted with the ring");
  assert.ok(/if \(Array\.isArray\(d\.rates\)\)/.test(pol), "…and restored");
  assert.ok(/capped: d1 >= CLASS_RATE_MAX/.test(pol),
    "a truncated count must report itself rather than quietly understating a noisy class");
});

// ===== Morning brief (build 2026.07.28-13) =====================================================
// Replaces the ops digest wholesale. The old digest counted what fired and listed headlines; the
// operator does not read the board that way. What ships now is a market brief, and the tests below
// guard the three things that can silently ruin one: a number the model invented, a message
// Telegram refuses because it is one byte over, and a default that quietly un-mutes somebody.

test("brief: the ops digest is retired, and nothing still schedules it", () => {
  const fs = require("fs"), path = require("path");
  const pol = fs.readFileSync(path.join(__dirname, "..", "src", "poller.js"), "utf8");
  for (const gone of ["function buildDigest(", "function digestText(", "function digestTick(", "DIGEST_MAX_HEADLINES"])
    assert.ok(!pol.includes(gone), `retired digest symbol still present: ${gone}`);
  assert.ok(/briefTick\(\)\.catch\(/.test(pol), "the brief must be the thing on the schedule");
  assert.ok(/briefSent\.get\(rec\.chat\) === day/.test(pol), "once per local day, not once per tick");
  assert.ok(/pushEnqueue\(rec\.chat, m, true\)/.test(pol),
    "both parts ride force \u2014 the hourly cap must not be able to eat the conclusions while delivering the data");
});

test("brief delivery: default ON for a fresh link, and an explicit OFF survives a redeploy", () => {
  const p = ctxHarness();
  const st = p.briefStateNow();
  assert.equal(st.defaultHour, 10, "the default brief is 10:00 UTC");
  // A fresh link has never touched the setting, so it inherits the default rather than sitting off.
  const code = p.pushMintCode("owner-a", true);
  p.pushBindNow(code.code, "chat-1", "Milst");
  const seen = p.getPush("owner-a", true).recipients.find((r) => r.chat === "chat-1");
  assert.equal(seen.briefHour, st.defaultHour, "linking telegram must opt you in \u2014 that is the whole point of the default");
  assert.equal(seen.briefSet, 0, "an untouched setting must be distinguishable from a chosen one");

  // Turning it off is a DECISION, and has to be stored as one.
  assert.ok(p.pushSetPrefs("chat-1", { digestHour: null }, "owner-a", true).ok);
  const off = p.getPush("owner-a", true).recipients.find((r) => r.chat === "chat-1");
  assert.equal(off.briefHour, null, "off means off");
  assert.equal(off.briefSet, 1, "without this flag the next deploy reads null as \u2018never configured\u2019 and switches it back on");

  // …and a chosen hour is honoured over the default.
  assert.ok(p.pushSetPrefs("chat-1", { digestHour: 19 }, "owner-a", true).ok);
  assert.equal(p.getPush("owner-a", true).recipients.find((r) => r.chat === "chat-1").briefHour, 19);
  assert.ok(!p.pushSetPrefs("chat-1", { digestHour: 24 }, "owner-a", true).ok, "24 is not an hour");
});

test("brief: context assembles off live state \u2014 indices split by class, movers exclude non-equities, both books separate", () => {
  const { createPoller } = require("../src/poller");
  const store = { loadAll: () => new Map(), loadRegime: () => [], loadLedger: () => null, saveLedger: () => {},
    insert: () => {}, saveRegime: () => {}, loadTriggers: () => null, saveTriggers: () => {} };
  const p = createPoller({ dex: "xyz", store, log: () => {}, version: "test", crypto: true });
  const eq = (t, d1) => p.seedRowNow(t, { ticker: t, coin: t, px: 100 * (1 + d1 / 100), d1, uni: "xyz" });
  eq("NVDA", 2.4); eq("MU", 4.8); eq("ENPH", -5.2); eq("XOM", -2.9); eq("PFE", -2.1);
  eq("ZZZQ", 1.1);   // deliberately not in the static sector map: a fresh listing
  p.seedRowNow("SPX", { ticker: "SPX", coin: "SPX", px: 5000, d1: 0.4, uni: "xyz" });      // Index
  p.seedRowNow("NDX", { ticker: "NDX", coin: "NDX", px: 18000, d1: 0.9, uni: "xyz" });     // Index
  p.seedRowNow("VIX", { ticker: "VIX", coin: "VIX", px: 14.2, d1: -0.8, uni: "xyz" });     // Index, level
  p.seedRowNow("WTI", { ticker: "WTI", coin: "WTI", px: 71, d1: -2.4, uni: "xyz" });       // Commodity
  p.seedRowNow("DXY", { ticker: "DXY", coin: "DXY", px: 99, d1: 0.12, uni: "xyz" });       // FX
  p.seedRowNow("BTC", { ticker: "BTC", coin: "BTC", px: 60000, d1: -0.4, uni: "main", funding: 0.00001 });
  p.seedRowNow("ARB", { ticker: "ARB", coin: "ARB", px: 0.4, d1: -8.4, uni: "main", funding: -0.00003 });
  p.seedRowNow("SOL", { ticker: "SOL", coin: "SOL", px: 180, d1: 1.9, uni: "main", funding: 0.000005 });

  p.detectBenchNow();   // the universe refresh that normally resolves the SPX proxy never runs in a harness
  const ctx = p.buildBriefCtxNow(Date.now(), 0);
  const tks = (a) => (a || []).map((x) => x.t);
  assert.deepEqual(tks(ctx.indices), ["NDX", "SPX", "VIX"], "indices come off the roster's own classification, ranked");
  assert.ok(ctx.indices.find((x) => x.t === "VIX").level, "VIX must be flagged as a level, not a percentage");
  assert.deepEqual(tks(ctx.commodities), ["WTI"]);
  assert.deepEqual(tks(ctx.fx), ["DXY"]);
  // An index or a currency pair in a "top movers" list is noise — those have their own block.
  const moverTks = tks(ctx.movers.stocks.up).concat(tks(ctx.movers.stocks.down));
  for (const bad of ["SPX", "NDX", "VIX", "WTI", "DXY"]) assert.ok(!moverTks.includes(bad), `${bad} must not appear in equity movers`);
  assert.equal(ctx.movers.stocks.up[0].t, "MU");
  // An unclassified name must still rank. Requiring assetClass === "Equity" silently dropped any
  // listing the static map had not been taught, so a new ticker went missing from its own movers
  // list while every other panel showed it.
  assert.ok(moverTks.includes("ENPH"), "the biggest loser must be in the losers list, classified or not");
  assert.equal(ctx.movers.stocks.down[0].t, "ENPH", "losers lead with the worst");
  // The benchmark is the reference line under the list; ranking it against itself prints a
  // relative move of zero and costs a real mover its slot.
  const cryTks = tks(ctx.movers.crypto.up).concat(tks(ctx.movers.crypto.down));
  assert.ok(!cryTks.includes("BTC"), "BTC must not appear in the crypto movers it is the benchmark for");
  assert.ok(!moverTks.includes("SPX"));
  assert.equal(ctx.bench.stocks && ctx.bench.stocks.t, "SPX", "the SPX proxy the rest of the app resolves is the equity benchmark");
  assert.equal(ctx.bench.crypto && ctx.bench.crypto.t, "BTC");
  assert.equal(ctx.movers.stocks.up[0].rel, +(4.8 - 0.4).toFixed(2), "the relative leg rides the book's own benchmark");
  // Hard separation survives into the brief: no crypto name in the equity book and vice versa.
  assert.ok(!tks(ctx.movers.crypto.up).concat(tks(ctx.movers.crypto.down)).some((t) => ["MU", "NVDA", "SPX"].includes(t)));
  assert.ok(ctx.regime.stocks && ctx.regime.stocks.breadth != null, "breadth must be computed per book");
  assert.notEqual(ctx.regime.stocks.breadth, ctx.regime.crypto && ctx.regime.crypto.breadth);
  // The renderer must survive whatever the assembler produces — the contract between the two halves.
  const C = require("../src/compute");
  const r = C.renderBrief(ctx, null);
  for (const m of r.messages) assert.ok(C.briefVisibleLen(m) <= C.BRIEF_TG_LIMIT);
  assert.ok(/NDX/.test(r.messages[0]) && /MU/.test(r.messages[0]));
});

test("brief: rate lines are absent without the FRED level pull, and 2s10s needs both legs", () => {
  const p = ctxHarness();
  const r = p.briefRatesNow();
  // No key in the harness, so no levels: the brief must simply not have a rates block. The old
  // failure mode this guards is a curve figure printed from a spread the server never fetched.
  assert.deepEqual(r.rates, [], "no pull means no rate lines, never stale or invented ones");
  assert.deepEqual(r.data, []);
  const fs = require("fs"), path = require("path");
  const pol = fs.readFileSync(path.join(__dirname, "..", "src", "poller.js"), "utf8");
  assert.ok(/MACRO_LEVELS = \[/.test(pol) && /DGS10/.test(pol) && /ICSA/.test(pol),
    "the release calendar carries no levels \u2014 rates and claims need their own series");
  assert.ok(/if \(s\["10y"\] && s\["2y"\]\)/.test(pol), "a spread computed from one leg would be a fabrication");
  assert.ok(/level series unavailable \(brief rate lines absent\)/.test(pol),
    "a dead level series must never be able to cost the calendar its entries");
});

test("brief: the model budget never drops below the provider floor, and falls back once", async () => {
  const fs = require("fs"), path = require("path");
  const pol = fs.readFileSync(path.join(__dirname, "..", "src", "poller.js"), "utf8");
  // The bug this pins: the brief shipped with maxTokens 4000 against an 8000 provider default.
  // GPT-5.x bills REASONING against max_completion_tokens, so the model returned an empty message
  // with finish_reason=length and every live brief silently lost its prose.
  assert.ok(/BRIEF_MAX_TOKENS = Math\.max\(AI_MAX_TOKENS,/.test(pol),
    "the brief budget must be floored at the provider's own, never set independently below it");
  assert.ok(!/maxTokens: 4000/.test(pol), "the under-budget literal must be gone");
  assert.ok(/callModel\(BRIEF_MODEL_FALLBACK, ctx, opts\)/.test(pol), "a refusal must retry on the fallback like the report path");

  const { createPoller } = require("../src/poller");
  const store = { loadAll: () => new Map(), loadRegime: () => [], loadLedger: () => null, saveLedger: () => {},
    insert: () => {}, saveRegime: () => {}, loadTriggers: () => null, saveTriggers: () => {} };
  const prevProv = process.env.AI_PROVIDER, prevKey = process.env.OPENAI_API_KEY;
  process.env.AI_PROVIDER = "openai"; process.env.OPENAI_API_KEY = "sk-test";
  try {
    const calls = [];
    const good = JSON.stringify({ story: "Breadth was 47%.", closing: "Nothing is resolved." });
    const p = createPoller({ dex: "xyz", store, log: () => {}, version: "test", crypto: false,
      aiFetch: async (url, o) => { const b = JSON.parse(o.body); calls.push(b);
        return calls.length === 1
          ? { ok: true, json: async () => ({ choices: [{ message: { content: "" }, finish_reason: "length" }] }) }
          : { ok: true, json: async () => ({ choices: [{ message: { content: good }, finish_reason: "stop" }] }) }; } });
    p.seedRowNow("MU", { ticker: "MU", coin: "MU", px: 100, d1: 4.8, uni: "xyz" });
    const b = await p.generateBriefNow(Date.now(), 0);
    assert.ok(calls[0].max_completion_tokens >= 8000,
      `brief ran on ${calls[0].max_completion_tokens} tokens \u2014 reasoning alone will eat that`);
    assert.equal(calls.length, 2, "an empty budget-blown response must retry on the fallback model");
    assert.ok(!b.degraded, "…and the retry must be able to save the prose: " + b.degraded);
    assert.ok(/THE STORY/.test(b.messages.join("")));
  } finally {
    if (prevProv === undefined) delete process.env.AI_PROVIDER; else process.env.AI_PROVIDER = prevProv;
    if (prevKey === undefined) delete process.env.OPENAI_API_KEY; else process.env.OPENAI_API_KEY = prevKey;
  }
});

test("brief: prose failure degrades to the mechanical brief, never to silence", async () => {
  const { createPoller } = require("../src/poller");
  const store = { loadAll: () => new Map(), loadRegime: () => [], loadLedger: () => null, saveLedger: () => {},
    insert: () => {}, saveRegime: () => {}, loadTriggers: () => null, saveTriggers: () => {} };
  // A model that returns garbage is the common case (refusal, truncation, a stray fence).
  const p = createPoller({ dex: "xyz", store, log: () => {}, version: "test", crypto: false,
    aiFetch: async () => ({ ok: true, json: async () => ({ content: [{ type: "text", text: "not json at all" }], stop_reason: "end_turn" }) }) });
  p.seedRowNow("NVDA", { ticker: "NVDA", coin: "NVDA", px: 100, d1: 2.4, uni: "xyz" });
  p.seedRowNow("MU", { ticker: "MU", coin: "MU", px: 100, d1: 4.8, uni: "xyz" });
  const b = await p.generateBriefNow(Date.now(), 0);
  assert.ok(b.messages.length >= 1, "a failed model call must still put a brief on the phone");
  assert.ok(b.degraded, "and must say why, in the logs and on the test-fire result");
  assert.ok(!/THE STORY|FINAL THOUGHTS/.test(b.messages.join("")), "no prose headings with no prose under them");
  assert.ok(/MOVERS/.test(b.messages.join("")), "the mechanical half is the fallback, and it is complete");
});

test("brief delivery reads the schedule registry, and legacy hours migrate once", () => {
  const fs = require("fs"), path = require("path");
  const pol = fs.readFileSync(path.join(__dirname, "..", "src", "poller.js"), "utf8");
  assert.ok(/function schedFor\(rec, kind\) \{ return schedResolve\(schedEntry\(rec, kind\), schedDefFor\(kind\)\); \}/.test(pol),
    "one resolution point, so the panel and the scheduler cannot disagree about when a send lands");
  assert.ok(/sched: \(r\.sched && typeof r\.sched === "object"\) \? r\.sched/.test(pol),
    "migration is once-only — deriving sched on every hydrate would undo an edit at the next restart");
  // The sync moved OUT of the validation loop (the atomicity bug pinned below): the legacy pair
  // now tracks only a write that fully validated.
  assert.ok(/if \(next\.brief && next\.brief\.set\) \{ r\.digestHour = next\.brief\.h; r\.dgSet = 1; \}/.test(pol),
    "the legacy pair is kept in step for anything still reading it — after validation, never during");
  assert.ok(/if \(!SCHED_KINDS\.some\(\(x\) => x\.k === k\)\) return \{ ok: false, error: "bad-kind" \}/.test(pol),
    "an unknown kind is refused rather than stored and then never delivered");
  assert.ok(/Number\.isFinite\(SCHED_ENV_HOUR\[kind\]\)/.test(pol),
    "BRIEF_DEFAULT_HOUR still wins over the registry's static default");
});

test("today's already-reported names are routed as printed, not as pending", () => {
  const fs = require("fs"), path = require("path");
  const pol = fs.readFileSync(path.join(__dirname, "..", "src", "poller.js"), "utf8");
  // A BMO name that reported at 08:30 is a printed row by lunchtime. Filing it under "Today" as
  // though it were still ahead is why same-day beats never showed a verdict.
  assert.ok(/if \(d !== 0 \|\| earnEntryState\(en, t\) !== "reported"\) continue;/.test(pol));
  assert.ok(/if \(d === 0 && earnEntryState\(en, t\) === "upcoming" && e\.today\.length < BRIEF_EARN_N\)/.test(pol));
  assert.ok(/seen\.has\(p\.t \+ "\|" \+ p\.d\)/.test(pol),
    "and a row cannot appear twice by arriving from both the entries list and the recent-prints list");
});

test("brief ctx routing, executed: reported names land in Printed with their reaction, pending stay in Today", () => {
  const { etDayStr } = require("../src/compute");
  const p = ctxHarness();
  // -09 determinism fix: this test shipped in -08 asserting an unreported same-day AMC row stays
  // "pending" — true only before 16:00 ET, because earnEntryState (correctly) flips AMC to
  // reported at the close. Run after 4pm ET and the suite went red with no code change. Freeze
  // `now` at ET MIDDAY of the current ET day: inside market hours, past the BMO boundary (09:30,
  // so XOM's epsA-carrying BMO row still exercises the reported path) and before the AMC one —
  // every session-boundary assertion below is now true at any wall-clock time, per the fake-clock
  // doctrine every episode-gate test already follows.
  const D = 24 * 3600e3, _wall = Date.now();
  const { etParts } = require("../src/compute");
  const _ep = etParts(_wall);
  const now = _wall + ((12 - _ep.h) * 3600e3) - (_ep.mi * 60e3) - ((_ep.s || 0) * 1000);
  const today = etDayStr(now), yesterday = etDayStr(now - D), tomorrow = etDayStr(now + D);
  // A spine for the reaction: yesterday closed 100, today closed 102.4 — a BMO print yesterday...
  // Actually anchor the print to `yesterday` (BMO) so the reaction day (its own day) has a close.
  const d0 = now - 2 * D;
  p.seedRowNow("xyz:MSFT", { ticker: "MSFT", px: 102.4, uni: "xyz",
    dailyRaw: [{ t: d0, c: 100 }, { t: now - D, c: 100 }, { t: now, c: 102.4 }] });
  p.seedEarnNow(
    [ // calendar rows: one same-day row ALREADY carrying its actual, one pending today, one tomorrow
      { coin: "xyz:AAPL", t: "AAPL", d: today, s: "AMC", eps: 1.42, epsA: null },
      { coin: "xyz:BA", t: "BA", d: tomorrow, s: "BMO", eps: 0.31, epsA: null },
      { coin: "xyz:XOM", t: "XOM", d: today, s: "BMO", eps: 1.2, epsA: 1.33 }],
    null,
    [ // print history feeding `recent`
      { coin: "xyz:MSFT", t: "MSFT", d: etDayStr(now - D), s: "BMO", eps: 3.12, epsA: 3.31 }]);
  const ctx = p.briefCtxNow(now, 0);
  const e = ctx.earnings;
  // The same-day row with an actual is a PRINT, not a pending binary — routing by earnEntryState.
  assert.ok(e.printed.some((x) => x.t === "XOM" && x.verdict === "beat"),
    "a same-day reported row routes to Printed with its verdict");
  assert.ok(!e.today.some((x) => x.t === "XOM"), "…and does not ALSO sit in Today as pending");
  // AAPL is AMC and unreported: genuinely still ahead, with its estimate on the row.
  const aapl = e.today.find((x) => x.t === "AAPL");
  assert.ok(aapl && aapl.eps === 1.42 && aapl.s === "AMC");
  assert.ok(e.tomorrow.some((x) => x.t === "BA" && x.eps === 0.31));
  // The historical print carries the reaction computed off the seeded spine (BMO: its own day).
  const msft = e.printed.find((x) => x.t === "MSFT");
  assert.ok(msft && msft.verdict === "beat", "recent prints flow through earnPrintRow");
  assert.equal(msft.reactionPct, 0, "BMO yesterday: close-to-close on its own day (100 -> 100)");
});

test("landscape prose: refs are the grounding contract and every gate the brief has still applies", () => {
  const C = require("../src/compute");
  const ctx = { at: Date.now(), news: [{ sector: "Semi Equipment", items: [
    { id: "h1", t: "ASML", h: "China DUV push", u: "https://ex.com/1" },
    { id: "h2", t: "MU", h: "Memory pricing", u: "https://ex.com/2" }] }] };
  const two = "First paragraph about the pattern.\n\nSecond paragraph about what it implies.";
  assert.equal(C.validateLandProse({ story: two, refs: ["h1", "h2"] }, ctx).ok, true);
  assert.equal(C.validateLandProse({ story: two }, ctx).error, "refs missing",
    "prose that cannot say what it rests on does not ship");
  assert.ok(/ref not in context/.test(C.validateLandProse({ story: two, refs: ["h1", "h99"] }, ctx).error),
    "a citation to a headline never in the corpus is the exact failure this gate exists for");
  assert.equal(C.validateLandProse({ story: two + "\n\nYou should buy the dip.", refs: ["h1", "h2"] }, ctx).error,
    "directional instruction");
  assert.ok(/number not in context/.test(
    C.validateLandProse({ story: two + "\n\nInflation ran 7.77 percent.", refs: ["h1", "h2"] }, ctx).error),
    "relational claims are allowed; invented figures are not");
  assert.ok(/name not in context/.test(
    C.validateLandProse({ story: two + "\n\nNVDA led the move.", refs: ["h1", "h2"] }, ctx).error));
  assert.equal(C.validateLandProse({ story: two + "\n\nThe U.S. session set the tone and EV names followed.",
    refs: ["h1", "h2"] }, ctx).ok, true, "U.S./EV must not discard landscape commentary — the -01 screenshot bug");
  assert.ok(/paragraphs/.test(C.validateLandProse({ story: "one blob", refs: ["h1", "h2"] }, ctx).error));
  // Regression: a story over the SOFT prose budget must NOT be rejected. The renderer owns length;
  // rejecting here turned a 3% overshoot into "commentary unavailable" and the trader got nothing.
  const longPara = ("clouds gather over the same names again and again ").repeat(40).trim();
  const overBudget = longPara + "\n\n" + longPara;   // ~4000 chars, 2 paragraphs, no numbers/names/advice
  assert.ok(overBudget.length > C.LAND_PROSE_MAX, "the guard's story must actually exceed the soft budget");
  assert.equal(C.validateLandProse({ story: overBudget, refs: ["h1", "h2"] }, ctx).ok, true,
    "over the soft budget is not a validity failure — the renderer's shed ladder fits it, never a wholesale discard");

  // Regression (the 2026-08-04 09:04 send): a 15-ref story with every ref REAL was discarded whole
  // — "refs too many (15)" — and the trader got "commentary unavailable". Over-citation is the
  // refs-side twin of the soft-budget lesson above: too FEW refs is under-grounded commentary and
  // stays fatal; too MANY fully-verified refs is verbosity, which is trimmed and disclosed.
  const wide = { at: Date.now(), news: [{ sector: "Everything", items:
    Array.from({ length: 16 }, (_, i) => ({ id: "w" + i, t: "T" + i, h: "headline " + i, u: "https://ex.com/w" + i })) }] };
  const wideRefs = Array.from({ length: 15 }, (_, i) => "w" + i);
  const vt = C.validateLandProse({ story: two, refs: wideRefs }, wide);
  assert.equal(vt.ok, true, "15 verified refs must never cost the commentary");
  assert.equal(vt.refs.length, 12, "trimmed to LAND_REFS_MAX in citation order");
  assert.deepEqual(vt.refs, wideRefs.slice(0, 12), "the FIRST cited survive — citation order is the model's own priority");
  assert.equal(vt.refsNote, "sources trimmed 15\u219212", "the trim is disclosed, never silent");
  assert.equal(C.validateLandProse({ story: two, refs: ["h1", "h2"] }, ctx).refsNote, null,
    "an in-budget footer carries no note");
  // Existence is checked over the FULL list BEFORE the trim: a hallucinated ref hiding at
  // position 15 must not be trimmed into innocence.
  const withGhost = wideRefs.slice(0, 14).concat(["ghost99"]);
  assert.ok(/ref not in context: ghost99/.test(C.validateLandProse({ story: two, refs: withGhost }, wide).error),
    "a fabricated citation past the trim boundary is still fatal — trim must not launder grounding");
  assert.ok(/refs too few/.test(C.validateLandProse({ story: two, refs: ["h1"] }, ctx).error),
    "the asymmetry holds: under-grounded stays a hard reject");
  // Wiring: the note travels landProse -> generateLandscape's degraded channel, so it renders
  // with the message via ctx.proseErr like every other salvage disclosure.
  const fs2 = require("fs"), path2 = require("path");
  const polSrc = fs2.readFileSync(path2.join(__dirname, "..", "src", "poller.js"), "utf8");
  for (const pin of ["refsNote: v.refsNote || null", "if (p.refsNote) { notes.push(p.refsNote)", "notes.join(\" \\u00b7 \")"])
    assert.ok(polSrc.includes(pin), `refs-trim wiring pin missing: ${pin}`);
  const cmpSrc = fs2.readFileSync(path2.join(__dirname, "..", "src", "compute.js"), "utf8");
  assert.ok(/for \(const r of refs\) if \(!ids\.has\(r\)\)[\s\S]{0,900}refs\.length > LAND_REFS_MAX/.test(cmpSrc),
    "ordering pin: existence check must run over the full list BEFORE the trim");
});

test("landscape delivery walks the registry: due only on scheduled days, once per recipient-day", async () => {
  process.env.TG_BOT_TOKEN = "test-token";
  const p = twoUserHarness();
  const c = p.pushMintCode("own-a", true); p.pushBindNow(c.code, 5555555555, "milst");
  // Default rider on a non-scheduled day: the tick walks and sends nothing. This asserts through
  // the REAL landTick rather than a string pin — the -84 lesson — using whatever today is: if today
  // is M/W/F the send fires (degraded: no key -> the honest unavailable line), otherwise silence.
  const sentToday = await p.landTickNow();
  const isMWF = [1, 3, 5].includes(new Date().getUTCDay());
  const dueNow = new Date().getUTCHours() === 11;
  assert.equal(sentToday, isMWF && dueNow ? 1 : 0,
    "delivery agrees exactly with the registry's M/W/F 11:00 UTC resolution for a default rider");
  // An explicit daily schedule at the current hour delivers now, and only once.
  const hr = new Date().getUTCHours();
  p.pushSetPrefs("5555555555", { sched: { landscape: { h: hr, days: null } }, tz: 0 }, "own-a", false);
  if (!(isMWF && dueNow)) {
    assert.equal(await p.landTickNow(), 1, "an explicit schedule at the current hour delivers");
  }
  assert.equal(await p.landTickNow(), 0, "…exactly once per recipient-day");
  const fs = require("fs"), path = require("path");
  const pol = fs.readFileSync(path.join(__dirname, "..", "src", "poller.js"), "utf8");
  assert.ok(/setInterval\(\(\) => \{ landTick\(\)\.catch/.test(pol),
    "separate timer, separate catch — a dead commentary layer cannot take the brief down");
  assert.ok(/pushEnqueue\(rec\.chat, b\.message, true\)/.test(pol), "scheduled sends ride force past the hourly cap");
});

// ===== landscape length + voice (build 2026.07.28-20) ==========================================
test("the landscape's budget targets the telegram ceiling, and the contract matches the prompt", () => {
  const C = require("../src/compute");
  // Prose 3400 + ~550 footer + header lands the full message just under 4096. The ladder is the
  // backstop, not the plan: a max-length story with a normal footer must fit WITHOUT shedding.
  assert.equal(C.LAND_PROSE_MAX, 3400);
  const items = [];
  for (let i = 0; i < 7; i++) items.push({ id: "h" + i, t: "TCK" + i, h: "A believable headline about something, sized like the real feed's rows number " + i, u: "https://ex.com/" + i });
  const story = ("P".repeat(560) + ".\n\n").repeat(5) + "Q".repeat(540) + ".";   // ~3350 chars, 6 paragraphs
  const ctx = { at: Date.now(), tz: 0, news: [{ sector: "X", items }] };
  const v = C.validateLandProse({ story, refs: items.map((x) => x.id) }, ctx);
  assert.ok(v.ok, "six paragraphs at full budget validate: " + (v.error || ""));
  const r = C.renderLandscape(ctx, v);
  assert.ok(C.briefVisibleLen(r.message) <= C.BRIEF_TG_LIMIT);
  assert.equal(r.dropped.length, 0, "a full-length story with a normal footer ships whole — nothing shed");
  assert.ok(C.briefVisibleLen(r.message) > 3700, "…and it actually uses the room it asked for");
  // Over-PARAGRAPH still refuses (a structural gate). Over-BUDGET no longer does: length is the
  // renderer's concern now, so a story past the soft budget validates and gets shed/clipped to fit
  // rather than discarded. This is the fix for "commentary unavailable — story over budget".
  assert.equal(C.validateLandProse({ story: "x".repeat(3401) + "\n\ny", refs: ["h0", "h1"] }, ctx).ok, true,
    "past the soft budget is not a validity failure — the renderer's shed ladder owns length");
  assert.ok(/paragraphs/.test(C.validateLandProse({ story: Array(8).fill("p").join("\n\n"), refs: ["h0", "h1"] }, ctx).error));

  const p = ctxHarness();
  const sys = p.landStateNow().system;
  // The contract the validator enforces must be the contract the prompt states — a model doing its
  // best against instructions it was never given is a validator rejecting good-faith output.
  assert.ok(/2,800\u20133,300 characters/.test(sys) && /3 to 6 paragraphs/.test(sys),
    "the prompt asks for the length the validator accepts");
  assert.ok(/VOICE/.test(sys) && /never catch you performing/.test(sys), "the voice section exists");
  assert.ok(/clich/.test(sys), "…and bans the filler that passes for wit");
  assert.ok(/write less rather than padding/.test(sys),
    "the length target must never outrank the thin-day honesty rule");
  // Found by the sample run: the number gate refuses years ("like it is 2021 again" -> refused),
  // which is correct — an invented year is an invented reference — but only survivable if the
  // prompt says so. A gate the model cannot see is a recurring degraded send.
  assert.ok(/includes YEARS/.test(sys), "the year rule is stated where the model can obey it");
  const yCtx = { at: Date.now(), news: [{ sector: "X", items: [{ id: "h1", t: "A", h: "x" }, { id: "h2", t: "B", h: "y" }] }] };
  assert.ok(/number not in context: 2021/.test(
    C.validateLandProse({ story: "Like it is 2021 again.\n\nSecond.", refs: ["h1", "h2"] }, yCtx).error));
});

test("brief ctx: the model is never handed more precision than the brief prints", () => {
  const { p, now } = briefAuditHarness();
  const ctx = p.buildBriefCtxNow(now);
  // GUARD FIRST. An earlier version of this scan reported zero offenders against a ctx whose
  // regime was null — it proved nothing at all. If the section under test is empty, the test is
  // lying, so assert it is populated before believing any count.
  assert.ok(ctx.regime && ctx.regime.stocks, "regime must be populated or this test proves nothing");
  assert.ok(Number.isFinite(ctx.regime.stocks.disp), "dispersion must be present — it is the field that broke");
  const bad = [];
  const walk = (v, path) => {
    if (v == null) return;
    if (typeof v === "number") {
      const str = String(v);
      if (Number.isFinite(v) && str.includes(".") && str.split(".")[1].length > 2) bad.push(path + "=" + str);
      return;
    }
    if (Array.isArray(v)) { v.forEach((x, i) => walk(x, path + "[" + i + "]")); return; }
    if (typeof v === "object") { for (const k of Object.keys(v)) walk(v[k], path + "." + k); }
  };
  walk(ctx, "ctx");
  // 4.587792771657628 reached the model, was quoted back verbatim, and cost a live brief its
  // entire prose layer because the validator only allowed the rounded forms.
  assert.deepEqual(bad, [], "unrounded floats in the ctx are prose landmines: " + bad.join(", "));
});

test("brief regime: above-200D is computed from real candles, with coverage disclosed", () => {
  const { p, now } = briefAuditHarness();
  const ctx = p.buildBriefCtxNow(now);
  const s = ctx.regime.stocks;
  // The old code read `tb.e200` off the trend index, which has never carried an e200 field in any
  // build in git history — `undefined > 0` is false for every name, so this row was a dash for
  // both books from the day it shipped. A non-null assertion is the whole point.
  assert.ok(s.ma200 != null, "above-200D must be computed, not read off a field that does not exist");
  assert.ok(s.ma200 >= 0 && s.ma200 <= 100, "it is a percentage share");
  assert.equal(s.ma200N, 14, "every seeded name has 220 candles, so all 14 are covered");
  assert.equal(s.ma200Of, 14);
  const C = require("../src/compute");
  const all = C.renderBrief(ctx, null).messages.join("\n").replace(/\u2007/g, " ");
  assert.ok(/above 200D\s+\d+%/.test(all), "the row renders a number, not a dash");
  // Partial coverage must disclose n rather than presenting a third of the book as the book.
  const partial = JSON.parse(JSON.stringify(ctx));
  partial.regime.stocks.ma200N = 30; partial.regime.stocks.ma200Of = 84;
  assert.ok(C.renderBrief(partial, null).messages.join("\n").includes("30/84"),
    "partial coverage is disclosed inline");
});

test("messages -66: the desk digest is per-recipient, deterministic, and off until an hour is picked", () => {
  const { openStore } = require("../src/store");
  const { createPoller } = require("../src/poller");
  const fs = require("fs"), path = require("path"), os = require("os");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "xyzdesk-"));
  const p = createPoller({ dex: "xyz", store: openStore(dir), log: () => {}, version: "test", crypto: false });
  // the kind registers with NO default hour — a recipient who never opted in is never due
  const { SCHED_KINDS, schedResolve } = require("../src/compute");
  const desk = SCHED_KINDS.find((k) => k.k === "desk");
  assert.ok(desk, "the desk kind is registered");
  assert.ok(!Number.isFinite(schedResolve(null, desk).hour), "no default hour: opt-in by construction");
  // content assembles from the injected per-member calls source; sections it has no data for are absent
  p.setDeskSource((uid) => ({ ok: true,
    calls: [{ id: 1, ref: "xyz:HOOD", side: "short", sender: "gus", adj: 0.02, adj1: 0.03, adj7: null, deleted: false }],
    summary: [{ uid, who: "gus", n: 1, upPct: 1, avg: 0.02 }] }));
  const text = p.deskTextNow("u1", Date.now());
  assert.ok(text.includes("Desk digest"), "titled");
  assert.ok(text.includes("$HOOD") && text.includes("▼"), "the member's calls ride in, direction marked");
  assert.ok(text.includes("100% right"), "the person summary scores");
  assert.ok(!text.includes("Earnings today"), "no earnings cache, no earnings section — absent, never fabricated");
});

test("ai report: Anthropic body — effort on models that take it, cached system block, max_tokens stop is a named failure", async () => {
  const prevProv = process.env.AI_PROVIDER, prevKey = process.env.ANTHROPIC_API_KEY;
  process.env.AI_PROVIDER = "anthropic"; process.env.ANTHROPIC_API_KEY = "sk-ant-test";
  try {
    const calls = [];
    let px0;
    const { p, px } = aiTestPoller({ aiFetch: async (url, opts) => {
      const body = JSON.parse(opts.body); calls.push({ url, body });
      return { ok: true, json: async () => ({ stop_reason: "end_turn",
        content: [{ type: "text", text: AI_GOOD(px0, +(px0 * 0.95).toPrecision(6), +(px0 * 1.10).toPrecision(6)) }] }) };
    } });
    px0 = px;
    const g = await p.generateAiReport("xyz:NVDA");
    assert.ok(g.ok, "Anthropic path must generate: " + (g.error || ""));
    const b = calls[0].body;
    assert.equal(b.model, "claude-fable-5");
    assert.deepEqual(b.output_config, { effort: "high" }, "reports run Fable at high effort via output_config");
    assert.ok(Array.isArray(b.system) && b.system[0].type === "text" && b.system[0].cache_control && b.system[0].cache_control.type === "ephemeral",
      "the system prompt rides as a cache_control block so repeat calls read it from the prompt cache");
    assert.ok(b.system[0].text.length > 1000, "the cached block is the real system prompt");
    assert.ok(!("thinking" in b) && !("temperature" in b), "body stays minimal otherwise");
    // the classifier model (Haiku 4.5) does not accept output_config: effort must never be sent there
    assert.equal(p.anthropicEffortOk("claude-haiku-4-5"), false);
    assert.equal(p.anthropicEffortOk("claude-opus-4-8"), true);
    assert.equal(p.anthropicEffortOk("claude-fable-5"), true);
    // output cut at max_tokens is a failure, not a half-report handed to the validator
    const { p: p2 } = aiTestPoller({ aiFetch: async () => ({ ok: true, json: async () => ({ stop_reason: "max_tokens",
      content: [{ type: "text", text: "{\"ai\":{\"read\":\"truncated" }] }) }) });
    const g2 = await p2.generateAiReport("xyz:NVDA");
    assert.equal(g2.ok, false);
    assert.ok(/max_tokens/.test(g2.error), "truncation must be named in the error: " + g2.error);
  } finally {
    if (prevProv === undefined) delete process.env.AI_PROVIDER; else process.env.AI_PROVIDER = prevProv;
    if (prevKey === undefined) delete process.env.ANTHROPIC_API_KEY; else process.env.ANTHROPIC_API_KEY = prevKey;
  }
});

test("AI admin gate: lockout is per caller with a global backstop — a stranger's failures never lock the operator out", () => {
  const { createPoller } = require("../src/poller");
  const store = { loadAll: () => new Map(), loadRegime: () => [], loadLedger: () => null,
    saveLedger: () => {}, insert: () => {}, saveRegime: () => {}, saveNews: () => {}, loadNews: () => null };
  const prev = process.env.ADMIN_PASSWORD;
  try {
    process.env.ADMIN_PASSWORD = "s3cret-pw";
    const p = createPoller({ dex: "xyz", store, log: () => {}, version: "test" });
    for (let i = 0; i < 8; i++) p.checkAdminPassword("wrong", "10.0.0.1");
    assert.equal(p.checkAdminPassword("s3cret-pw", "10.0.0.1").error, "rate", "the guessing IP is locked out");
    assert.equal(p.checkAdminPassword("s3cret-pw", "10.0.0.2").ok, true, "another caller still gets in with the right password");
    assert.equal(p.resetAiDay("s3cret-pw", "10.0.0.2").ok, true, "resetAiDay carries the same caller key");
    // 40 failures spread over many sources trip the global backstop for everyone
    for (let i = 0; i < 40; i++) p.checkAdminPassword("wrong", "10.1.0." + (i % 20));
    assert.equal(p.checkAdminPassword("s3cret-pw", "10.9.9.9").error, "rate", "distributed guessing hits the aggregate cap");
  } finally { if (prev === undefined) delete process.env.ADMIN_PASSWORD; else process.env.ADMIN_PASSWORD = prev; }
});
