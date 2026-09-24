"use strict";
// poller.js — signal engine, ledger, levels, actionable, trend. Split out of test.js (build 2026.09.16-80); order within the file is the original order.
const test = require("node:test");
const assert = require("node:assert");
const { classify, median, playbook, HOUR, DAY, C, blendClosed, aiTestPoller, AI_GOOD, aiLevelPoller, levelOutcomes, levelStudy, sessionRecords, anatomyEnrich, mondayStats, nakedStats, anatomyPool, ctxHarness, trendHarness, clOf, settledPoller } = require("./_shared");


test("fire-time stamps F5/vr: a breakout claim carries ib (intrabar) and vr (vol-regime) at fire", async () => {
  const { createPoller } = require("../src/poller");
  const store = { loadAll: () => new Map(), loadRegime: () => [], loadLedger: () => null,
    saveLedger: () => {}, insert: () => {}, saveRegime: () => {}, archiveClosed: () => {} };
  const p = createPoller({ dex: "xyz", store, log: () => {}, version: "test", crypto: false });
  // 230 UTC-day bars = ~160 US sessions (>=140 so the coil/vr percentile computes; a gentle wave
  // keeps a real 30-session high). The signal loop reads the SESSION view (-105), so the prior-30
  // high is taken over the closed session bars exactly as the loop folds them.
  const daily = [];
  for (let i = 0; i < 230; i++) { const c = 100 + Math.sin(i / 5) * 1.5;
    daily.push({ t: (Math.floor(Date.now() / DAY) - 230 + i) * DAY, c, l: c * 0.98, h: c * 1.02 }); }
  const sess = C.sessionFold(daily, C.sessOffFn("US")).filter((b) => !b.f);
  const hi30 = Math.max(...sess.slice(-31, -1).map((d) => d.c));
  const hourly = []; for (let i = 0; i < 48; i++) hourly.push({ t: (Math.floor(Date.now() / HOUR) - 48 + i) * HOUR, o: 100, h: 100, l: 100, c: 100, v: 1 });
  // Build 1: mark just BELOW the prior-30d high — no breakout, but the pass-2 block stamps r._vr.
  const r = p.seedRowNow("VRSIG", { px: hi30 * 0.99, ticker: "VRSIG", uni: "xyz", vol: 1e6, dailyRaw: daily, hourlyRaw: hourly });
  p.buildDailyNow();
  await p.buildSignalsNow();
  // (-105: the swing shadows now read the fixture's true lows, so an invisible swpull may open here)
  assert.ok(![...p.ledgerOpenNow().keys()].some((k) => k.startsWith("VRSIG|breakout")), "no breakout yet — mark is under the high");
  // Build 2: push the mark above the high. The last COMPLETED daily close is still ~100 (< the
  // high), so the cross is intrabar (ib=1); r._vr is already present from build 1, so it stamps.
  r.px = hi30 * 1.03;
  await p.buildSignalsNow();
  const e = p.ledgerOpenNow().get("VRSIG|breakout");
  assert.ok(e, "breakout claim opened on the intrabar cross");
  assert.equal(e.ib, 1, "ib=1: only the live mark cleared the high, the last completed close had not");
  assert.ok(Number.isFinite(e.vr) && e.vr >= 0 && e.vr <= 100, "vr stamped as a 0..100 vol-regime percentile");
});

test("ledger unit repair + getLedgerFor: R-normalization, idempotency, shadow exclusion", () => {
  const { createPoller } = require("../src/poller");
  const now = Date.now();
  const fixture = { ts: now, rearm: [], variants: null,
    open: [
      { key: "xyz:AAPL|breakout", coin: "xyz:AAPL", ticker: "AAPL", ev: "breakout", t0: now - 3600000,
        mark0: 200, dir: 1, score0: 61, sd0: 1.8, resolveAt: now + 86400000, psd: "long", bt: 1 },
      { key: "xyz:AAPL|bigmove#1", coin: "xyz:AAPL", ticker: "AAPL", ev: "bigmove", t0: now - 3600000,
        mark0: 200, dir: 1, score0: 0, sd0: 1.8, resolveAt: now + 86400000, vi: 1 },   // shadow — must never surface
    ],
    closed: [
      // breakdown resolved pre-fix: raw % despite sd0 stamped -> must repair to R (-4.4/2.2 = -2)
      { key: "xyz:AAPL|breakdown", coin: "xyz:AAPL", ticker: "AAPL", ev: "breakdown", t0: now - 5 * 86400000,
        mark0: 210, dir: -1, score0: 55, sd0: 2.2, status: "resolved", tR: now - 86400000,
        realized: -4.4, realizedS: -4.4, win: false, winS: false, psd: "short" },
      // stopped oiflush pre-fix: realized and the stop-capped leg both repair independently
      { key: "xyz:AAPL|oiflush", coin: "xyz:AAPL", ticker: "AAPL", ev: "oiflush", t0: now - 9 * 86400000,
        mark0: 190, dir: 1, score0: 48, sd0: 3, status: "resolved", tR: now - 4 * 86400000,
        realized: 6.6, realizedS: -3, stopped: true, win: true, winS: false },
      // breakout resolved under the OLD code: already R, no rn stamp -> must NOT be touched
      { key: "xyz:AAPL|breakout", coin: "xyz:AAPL", ticker: "AAPL", ev: "breakout", t0: now - 12 * 86400000,
        mark0: 180, dir: 1, score0: 70, sd0: 2, status: "resolved", tR: now - 7 * 86400000,
        realized: 1.5, realizedS: 1.5, win: true, winS: true, psd: "long" },
      // pre-sigma-epoch breakdown (no sd0): untouched, surfaces as legacy %
      { key: "xyz:AAPL|breakdown#old", coin: "xyz:AAPL", ticker: "AAPL", ev: "breakdown", t0: now - 40 * 86400000,
        mark0: 250, dir: -1, score0: 40, status: "resolved", tR: now - 35 * 86400000,
        realized: 3.1, realizedS: 3.1, win: true, winS: true },
      // different coin — must not leak into AAPL's history
      { key: "xyz:NVDA|breakdown", coin: "xyz:NVDA", ticker: "NVDA", ev: "breakdown", t0: now - 5 * 86400000,
        mark0: 100, dir: -1, score0: 50, sd0: 2, status: "resolved", tR: now - 86400000,
        realized: -2, realizedS: -2, win: false, winS: false },
    ] };
  const store = { loadAll: () => new Map(), loadRegime: () => [], loadLedger: () => fixture,
    saveLedger: () => {}, insert: () => {}, saveRegime: () => {} };
  const p = createPoller({ dex: "xyz", store, log: () => {}, version: "test", crypto: false });
  p.hydrateLedgerNow();
  p.hydrateLedgerNow();   // idempotency: the rn stamp must make a second pass a no-op
  const h = p.getLedgerFor("xyz:AAPL", null, true);
  assert.equal(h.open.length, 1, "shadow-variant claims never surface");
  assert.equal(h.open[0].status, "open");
  assert.ok(h.open[0].resolveAt > now, "open claim carries its horizon");
  assert.equal(h.open[0].boot, true, "first-build-after-restart flag surfaces");
  assert.equal(h.open[0].mark0, 200, "per-instance trigger mark surfaces");
  assert.equal(h.closed.length, 4, "only this coin's visible closed claims");
  const by = {}; for (const e of h.closed) by[e.ev + (e.legacy ? ":legacy" : "")] = e;
  assert.equal(by.breakdown.realized, -2, "raw-% breakdown repaired to R (-4.4/2.2)");
  assert.equal(by.breakdown.realizedS, -2, "non-stopped stop-aware leg tracks the repaired outcome");
  assert.equal(by.breakdown.unit, "R");
  assert.equal(by.oiflush.realized, 2.2, "stopped oiflush repaired (6.6/3)");
  assert.equal(by.oiflush.realizedS, -1, "stop-capped leg repaired independently (-3/3)");
  assert.equal(by.oiflush.stopped, true);
  assert.equal(by.breakout.realized, 1.5, "already-normalized original-three entry untouched");
  assert.equal(by["breakdown:legacy"].realized, 3.1, "pre-sigma-epoch entry untouched");
  assert.equal(by["breakdown:legacy"].unit, "%", "legacy entry labeled in its true unit");
  assert.equal(by["breakdown:legacy"].legacy, true);
  assert.equal(p.getLedgerFor("xyz:NVDA", null, true).closed.length, 1, "history is per-coin");
  assert.equal(p.getLedgerFor("", null, true).open.length, 0, "no filter -> empty history");
  const byEv = p.getLedgerFor("", "breakdown", true);
  assert.equal(byEv.closed.length, 3, "event filter crosses tickers (2 AAPL + 1 NVDA)");
  assert.ok(byEv.closed.every(e => e.ev === "breakdown"), "event filter is exact");
  assert.ok(byEv.closed.some(e => e.tk === "NVDA"), "cross-ticker rows carry their ticker");
  assert.equal(p.getLedgerFor("xyz:AAPL", "breakdown", true).closed.length, 2, "coin+event filters combine");
  assert.equal(p.getLedgerFor("xyz:AAPL", "breakdown", true).open.length, 0, "combined filter excludes other events\' open claims");
});

test("blend F1: evidence reads the firing claim's OWN universe record, never the mixed pot", () => {
  const { createPoller } = require("../src/poller");
  // Equity breakout record is COLD (avg -1R); crypto breakout record is HOT (avg +1R). A study
  // that itself reads +0.5R should be pulled DOWN for an equity fire and UP for a crypto fire —
  // if the blend were still cross-universe, both would see the same (near-zero) mixed record.
  // Real universe convention: equities are "xyz:TICK" (has ":", universe x), crypto is a bare perp
  // id WITHOUT ":" (universe m). uniOf keys on the colon.
  const fixture = { ts: Date.now(), rearm: [], variants: null, open: [], closed: [
    ...blendClosed("xyz:AAA", "breakout", 40, -1),          // equity: cold (universe x)
    ...blendClosed("BTCP", "breakout", 40, 1),              // crypto: hot (universe m)
  ] };
  const store = { loadAll: () => new Map(), loadRegime: () => [], loadLedger: () => fixture,
    saveLedger: () => {}, insert: () => {}, saveRegime: () => {}, archiveClosed: () => {} };
  const p = createPoller({ dex: "xyz", store, log: () => {}, version: "test", crypto: true });
  p.hydrateLedgerNow();
  p.recomputeRecordNow();
  const xRec = p.recForNow("xyz"), mRec = p.recForNow("main");
  assert.ok(xRec.breakout && xRec.breakout.avg < 0, "equity scoped record is the cold one");
  assert.ok(mRec.breakout && mRec.breakout.avg > 0, "crypto scoped record is the hot one");
  const study = { n: 12, hit: 0.55, med: 0.5, avg: 0.5 };
  const eqEv = p.evidenceNow(study, "breakout", null, "R", "xyz");
  const cxEv = p.evidenceNow(study, "breakout", null, "R", "main");
  // Same study, opposite universes -> the cold record must drag the equity score strictly below
  // the crypto score. A cross-universe blend would make these equal.
  assert.ok(cxEv.pts > eqEv.pts + 1, "hot-universe fire outscores cold-universe fire on the SAME study");
  assert.ok(eqEv.liveW > 0 && cxEv.liveW > 0, "both blended against a live record (>=5 resolutions)");
});

test("blend F2: trust migrates at tape-DAY speed (cl), not raw claim count", () => {
  const { createPoller } = require("../src/poller");
  // Two universes, identical n and identical live avg, but one record fired all on ONE day
  // (cl=1) and the other across distinct days (cl=n). The clustered record must earn far less
  // blend weight — forty longs into one green day are one draw, not forty.
  // Clustered record = crypto, all n on ONE post-epoch day (cl=1). Spread record = equity, n across
  // n distinct days (cl=n). Same n, same +1R avg -> only cl differs, so only liveW should differ.
  const fixture = { ts: Date.now(), rearm: [], variants: null, open: [], closed: [
    ...blendClosed("SOLP", "bigmove", 40, 1, { spreadDays: false }),      // crypto, cl=1
    ...blendClosed("xyz:CCC", "bigmove", 40, 1, { spreadDays: true }),    // equity, cl=40
  ] };
  const store = { loadAll: () => new Map(), loadRegime: () => [], loadLedger: () => fixture,
    saveLedger: () => {}, insert: () => {}, saveRegime: () => {}, archiveClosed: () => {} };
  const p = createPoller({ dex: "xyz", store, log: () => {}, version: "test", crypto: true });
  p.hydrateLedgerNow(); p.recomputeRecordNow();
  assert.equal(p.recForNow("main").bigmove.cl, 1, "same-day crypto record collapses to cl=1");
  assert.equal(p.recForNow("xyz").bigmove.cl, 40, "spread equity record keeps cl=n");
  const study = { n: 12, hit: 0.5, med: 0, avg: 0 };   // neutral study so liveW drives the gap
  const clustered = p.evidenceNow(study, "bigmove", null, "R", "main");
  const spread = p.evidenceNow(study, "bigmove", null, "R", "xyz");
  assert.ok(spread.liveW > clustered.liveW + 20,
    "the independent-day record earns much more live weight than the one-day cluster");
});

test("confluence F8: the earned bonus scales on R lift and requires both lifts non-negative", () => {
  const { createPoller } = require("../src/poller");
  const now = Date.now();
  // Confluence entries need conf:true/false, win, realized, and an R-united ev. Build two regimes.
  function set(coin, ev, i, conf, realized) {
    return { key: coin + "|" + ev + "#" + (conf ? "c" : "s") + i, coin, ticker: coin.split(":").pop(), ev,
      t0: now - (40 - (i % 40)) * 86400000 - i * 1000, mark0: 100, dir: 1, sd0: 2,
      status: "resolved", tR: now - i * 1000, realized, realizedS: realized, win: realized > 0, winS: realized > 0,
      psd: "long", pn: 1, conf };
  }
  // Regime 1: with-company firings genuinely better on BOTH hit and avg-R. 20 conf @ +1R (all win),
  // 20 solo @ -0.5R half / +0.5R half (hit 0.5, avg 0). Both lifts positive -> bonus = round(avgLift*20).
  const closed = [];
  for (let i = 0; i < 20; i++) closed.push(set("xyz:AAA", "breakout", i, true, 1));       // conf: hit 1.0, avg +1R
  for (let i = 0; i < 10; i++) closed.push(set("xyz:AAA", "breakout", 100 + i, false, 0.5));
  for (let i = 0; i < 10; i++) closed.push(set("xyz:AAA", "breakout", 200 + i, false, -0.5)); // solo: hit 0.5, avg 0
  const store = { loadAll: () => new Map(), loadRegime: () => [], loadLedger: () => ({ ts: now, rearm: [], variants: null, open: [], closed }),
    saveLedger: () => {}, insert: () => {}, saveRegime: () => {}, archiveClosed: () => {} };
  const p = createPoller({ dex: "xyz", store, log: () => {}, version: "test", crypto: false });
  p.hydrateLedgerNow(); p.recomputeRecordNow();
  const c = p.confCacheNow();
  assert.ok(c.confAvg > c.soloAvg, "confluence raised avg R");
  assert.ok(c.confHit >= c.soloHit, "confluence did not lower hit");
  assert.equal(c.bonus, Math.max(0, Math.round((c.confAvg - c.soloAvg) * 20)), "bonus scales on the R lift");
  assert.ok(c.bonus > 8, "a real R lift earns more than the flat default");
});

test("confluence F8: a hit gain bought with expectancy loss earns zero", () => {
  const { createPoller } = require("../src/poller");
  const now = Date.now();
  function set(coin, ev, i, conf, realized) {
    return { key: coin + "|" + ev + "#" + (conf ? "c" : "s") + i, coin, ticker: coin.split(":").pop(), ev,
      t0: now - (40 - (i % 40)) * 86400000 - i * 1000, mark0: 100, dir: 1, sd0: 2,
      status: "resolved", tR: now - i * 1000, realized, realizedS: realized, win: realized > 0, winS: realized > 0,
      psd: "long", pn: 1, conf };
  }
  // Confluence wins MORE often but each win is tiny and its losses are brutal -> higher hit, lower
  // avg R. F8 must refuse the bonus (avgLift < 0), where the old hit-only rule would have paid.
  const closed = [];
  for (let i = 0; i < 16; i++) closed.push(set("xyz:BBB", "breakout", i, true, 0.1));   // conf wins small
  for (let i = 0; i < 4; i++) closed.push(set("xyz:BBB", "breakout", 50 + i, true, -3)); // conf losses huge -> hit 0.8, avg -0.52
  for (let i = 0; i < 10; i++) closed.push(set("xyz:BBB", "breakout", 100 + i, false, 0.6));
  for (let i = 0; i < 10; i++) closed.push(set("xyz:BBB", "breakout", 200 + i, false, -0.4)); // solo hit 0.5, avg +0.1
  const store = { loadAll: () => new Map(), loadRegime: () => [], loadLedger: () => ({ ts: now, rearm: [], variants: null, open: [], closed }),
    saveLedger: () => {}, insert: () => {}, saveRegime: () => {}, archiveClosed: () => {} };
  const p = createPoller({ dex: "xyz", store, log: () => {}, version: "test", crypto: false });
  p.hydrateLedgerNow(); p.recomputeRecordNow();
  const c = p.confCacheNow();
  assert.ok(c.confHit > c.soloHit, "confluence raised hit rate");
  assert.ok(c.confAvg < c.soloAvg, "but confluence LOWERED avg R");
  assert.equal(c.bonus, 0, "a hit gain bought with expectancy loss earns zero bonus (F8)");
});

test("fire-time context stamp: computable fields frozen at openLedger, absent fields stay honestly absent", () => {
  const { createPoller } = require("../src/poller");
  const store = { loadAll: () => new Map(), loadRegime: () => [], loadLedger: () => null,
    saveLedger: () => {}, insert: () => {}, saveRegime: () => {} };
  const p = createPoller({ dex: "xyz", store, log: () => {}, version: "test", crypto: false });
  const now = Date.now(), HOURMS = 3600 * 1000;
  // benchmark row for the crypto universe: mktR must read BTC's 24h move
  p.seedRowNow("BTC", { px: 100000, d1: 2.5 });
  // target: main-universe coin with a funding history rich enough to clear the >=96-sample
  // percentile floor, a 30d range, and a live rate sitting at a known rank in its own history
  const fundH = new Map();
  for (let i = 0; i < 100; i++) fundH.set(now - (100 - i) * HOURMS, (i + 1) / 1e6);   // ranks 1..100
  p.seedRowNow("ETH", { px: 3000, funding: 75 / 1e6, fundH, feat: { hi30: 3200, lo30: 2800 } });
  // Crypto signal claims open again (2026.07.26-08). The blanket refusal is replaced by the
  // MAIN_EVS whitelist, so an enrolled event ledgers and a non-enrolled one still cannot.
  const e = p.openLedgerNow("ETH", "bigmove", { score: 10, reading: "" }, 1, { sd0: 2 });
  assert.ok(e, "an enrolled crypto event ledgers — the whitelist admits bigmove");
  assert.equal(p.openLedgerNow("ETH", "prem", { score: 10, reading: "" }, 1, { sd0: 2 }), null,
    "a non-enrolled crypto event is still refused — the gate is a whitelist, not a re-opening");
  assert.equal(e.fnd, 75 / 1e6, "funding rate frozen at fire");
  assert.ok(e.fndP >= 73 && e.fndP <= 77, `funding percentile ~75 from the seeded ranks, got ${e.fndP}`);
  assert.equal(e.rngP, 0.5, "px 3000 sits exactly mid-range 2800..3200");
  assert.equal(e.mktR, 2.5, "benchmark 24h move stamped from BTC for a main-universe coin");
  assert.ok(Number.isInteger(e.dow) && e.dow >= 0 && e.dow <= 6, "UTC day-of-week always stamped");
  assert.equal(e.ses, undefined, "session bucket is xyz-only — absent on crypto, not null-padded");
  assert.ok(["asia", "eu", "us", "late"].includes(e.hod),
    `crypto carries a UTC hour-of-day bucket in place of the session it cannot have, got ${e.hod}`);
  assert.equal(e.oi5, undefined, "no OI history -> oi5 honestly absent");
  assert.equal(e.sd0, 2, "extra fields untouched by the stamp");
  // xyz claim: session bucket present and valid; thin row -> everything else absent except dow
  p.seedRowNow("xyz:ACME", { px: 50, ticker: "ACME" });
  const e2 = p.openLedgerNow("xyz:ACME", "breakout", { score: 5, reading: "" }, 1, { sd0: 1.5 });
  assert.ok(["rth", "on", "wknd"].includes(e2.ses), `xyz claim carries a session bucket, got ${e2.ses}`);
  assert.equal(e2.hod, undefined, "hour-of-day bucket is crypto-only — xyz has real sessions, not a liquidity clock");
  assert.equal(e2.fnd, undefined, "no funding -> absent");
  assert.equal(e2.rngP, undefined, "no features -> absent");
  assert.ok(Number.isInteger(e2.dow), "dow stamped");
  // shadow claims get the same stamp — variant slices need identical features
  const e3 = p.openLedgerNow("ETH", "bigmove", { score: 0, reading: "" }, 1, { sd0: 2 }, 1);
  assert.ok(e3 && e3.vi === 1 && e3.fnd === 75 / 1e6 && Number.isInteger(e3.dow), "shadow claim carries the stamp too");
  // stamped claims surface in the export with a coverage epoch once closed
  const x = p.getLedgerExport(true);
  assert.equal(x.meta.counts.open, 3);
  assert.ok(x.open.every(o => Number.isInteger(o.dow)), "export ships the raw stamped fields");
});

test("swing shadow setups: detectors, geometry, fundflip stop, gapfade wiring, EV_META horizons", () => {
  const C = require("../src/compute");
  // ---- 50d-MA pullback: build an uptrend, then place the mark exactly at the MA
  const now = Date.now(), closes = [];
  for (let i = 0; i < 70; i++) closes.push([now - (70 - i) * DAY, 100 * Math.pow(1.004, i)]);
  const c = closes.map((k) => k[1]);
  const m0 = c.slice(-50).reduce((a, b) => a + b, 0) / 50;
  const mp = C.detectMAPull(closes, m0 * 1.005, 2);
  assert.ok(mp, "rising-MA pullback fires when the mark sits at the MA");
  assert.ok(Math.abs(mp.ma - m0) / m0 < 1e-5, "MA frozen as computed (6-sig-fig quantized)");
  assert.ok(mp.stop < m0 * 1.005 && mp.target > m0 * 1.005, "tradeable geometry: stop below, target above");
  assert.ok(Math.abs(mp.stop - m0 * 0.98) / m0 < 1e-5, "stop is 1σ(30d) below the MA");
  assert.equal(C.detectMAPull(closes, m0 * 1.05, 2), null, "mark far above the MA: no pullback, no fire");
  assert.equal(C.detectMAPull(closes, m0 * 0.97, 2), null, "mark through the MA: broken, not touching");
  const down = closes.map((k, i) => [k[0], 100 * Math.pow(0.996, i)]);
  assert.equal(C.detectMAPull(down, down[down.length - 1][1], 2), null, "falling MA50 never fires");
  assert.equal(C.detectMAPull(closes.slice(-40), m0, 2), null, "under 60 closes: honest null");
  // ---- failed-breakdown reclaim: flat range, fresh 3-session flush below the 30d low, mark back above
  const flat = []; for (let i = 0; i < 45; i++) flat.push([now - (45 - i) * DAY, 100 + ((i * 7) % 5) * 0.3]);
  const lo = Math.min(...flat.slice(-33, -3).map((k) => k[1]));
  flat[flat.length - 3][1] = lo - 2; flat[flat.length - 2][1] = lo - 3; flat[flat.length - 1][1] = lo - 1;
  const rc = C.detectReclaim(flat, lo + 0.4);
  assert.ok(rc, "fresh break + mark back above the level fires");
  assert.equal(rc.level, +lo.toPrecision(6), "level is the pre-flush 30d closing low");
  assert.equal(rc.stop, +(lo - 3).toPrecision(6), "stop is the flush low");
  assert.ok(Math.abs(rc.target - (lo + 3)) < 1e-9, "target is the measured move: level + (level - flush)");
  assert.equal(C.detectReclaim(flat, lo - 0.5), null, "mark still below the level: no reclaim");
  const stale = flat.map((k) => [k[0], k[1]]);
  stale[stale.length - 2][1] = lo + 1; stale[stale.length - 1][1] = lo + 1;   // break aged out: last two closes back above
  assert.equal(C.detectReclaim(stale, lo + 0.4), null, "an old wound is not a fresh trap");
  // ---- intraday liquidity sweep (5m): prior-session low pierced, rejected inside the bar, reclaim holds
  const FIVE = 5 * 60 * 1000;
  const mkTail = () => { const a = []; for (let i = 0; i < 30; i++) a.push([now - (30 - i) * FIVE, 100, 100.2, 99.8, 100, 10]); return a; };
  const swLo = mkTail(); swLo[27] = [swLo[27][0], 99.6, 99.8, 98.5, 99.5, 25];   // wick to 98.5 below dayLo=99, closes back at 99.5
  const sw = C.detectSweep(swLo, 101, 99, 99.3, 0.25);
  assert.ok(sw && sw.side === "long", "a rejected pierce of the prior-session low fires long");
  assert.equal(sw.level, 99, "level is the swept prior-session low");
  assert.equal(sw.stop, 98.5, "void is the sweep extreme (the wick low)");
  assert.ok(Math.abs(sw.target - 99.5) < 1e-9, "target is the measured move: level + (level - sweep low)");
  assert.ok(sw.stop < 99.3 && sw.target > 99.3, "tradeable geometry: stop below the mark, target above");
  const swHi = mkTail(); swHi[27] = [swHi[27][0], 100.4, 101.5, 100.2, 100.5, 25];
  const ss = C.detectSweep(swHi, 101, 99, 100.7, 0.25);
  assert.ok(ss && ss.side === "short", "a rejected pierce of the prior-session high fires short");
  assert.equal(ss.stop, 101.5, "short void is the sweep high");
  assert.ok(Math.abs(ss.target - 100.5) < 1e-9, "short target is level - (sweep high - level)");
  assert.equal(C.detectSweep(swLo, 101, 95, 99.3, 0.25), null, "a wick that never reaches the level is not a sweep");
  const graze = mkTail(); graze[27] = [graze[27][0], 99.6, 99.8, 98.95, 99.5, 25];   // pierces by 0.05 < 0.25*median
  assert.equal(C.detectSweep(graze, 101, 99, 99.3, 0.25), null, "a shallow graze under the min-depth floor doesn't count");
  const noRcl = mkTail(); noRcl[27] = [noRcl[27][0], 99.6, 99.8, 98.5, 98.7, 25];   // closes BELOW the level — not rejected in-bar
  assert.equal(C.detectSweep(noRcl, 101, 99, 99.3, 0.25), null, "no in-bar rejection: the level wasn't reclaimed");
  const broke = mkTail(); broke[27] = [broke[27][0], 99.6, 99.8, 98.5, 99.5, 25]; broke[29] = [broke[29][0], 99, 99.1, 98.6, 98.8, 10];
  assert.equal(C.detectSweep(broke, 101, 99, 99.3, 0.25), null, "a later close back through the level breaks the reclaim");
  assert.equal(C.detectSweep(swLo, 101, 99, 98.8, 0.25), null, "mark not back above the swept low: no live reclaim");
  assert.equal(C.detectSweep(swLo.slice(-8), 101, 99, 99.3, 0.25), null, "under 12 bars: honest null");
  const strTail = swLo.map((k) => [k[0], String(k[1]), String(k[2]), String(k[3]), String(k[4]), k[5]]);
  let strSw; assert.doesNotThrow(() => { strSw = C.detectSweep(strTail, 101, 99, 99.3, 0.25); }, "string OHLC from the archive must never throw");
  assert.ok(strSw && strSw.side === "long", "string coercion still detects the sweep");
  // ---- fundflip playbook stop (ops item 3): 1σ against the flip; legacy no-ctx shape unchanged
  const ffL = C.playbook("fundflip", { dir: 1, px: 100, sd30: 2 });
  assert.equal(ffL.side, "long"); assert.equal(ffL.stop, 98);
  const ffS = C.playbook("fundflip", { dir: -1, px: 100, sd30: 2 });
  assert.equal(ffS.side, "short"); assert.equal(ffS.stop, 102);
  assert.equal(C.playbook("fundflip", { dir: -1 }).stop, null, "no px/σ context: legacy null stop");
  // ---- EV_META: swing horizons + gapfade on the gap calendar
  assert.equal(C.EV_META.reclaim.horizonMs, 5 * DAY);
  assert.equal(C.EV_META.mapull.horizonMs, 10 * DAY);
  assert.equal(C.EV_META.sweep.horizonMs, DAY, "the 5m sweep resolves at a 1d horizon");
  assert.equal(C.EV_META.gapfade.horizonMs, null, "gapfade resolves at the next session close, like gap");
  // ---- wiring pins: the fire sites and calendar branch exist in the poller
  const fs = require("fs"), path = require("path");
  const pol = fs.readFileSync(path.join(__dirname, "..", "src", "poller.js"), "utf8");
  assert.ok(pol.includes('openLedger(r, "gapfade"'), "gapfade shadow fire site present");
  assert.ok(pol.includes("[1, 1.5].forEach"), "both void widths ledger");
  assert.ok(pol.includes('ev === "gap" || ev === "gapfade"'), "gapfade rides the gap resolution calendar");
  assert.ok(pol.includes('openLedger(r, "reclaim"') && pol.includes('openLedger(r, "mapull"'), "swing shadow fire sites present");
  assert.ok(pol.includes('openLedger(r, "sweep"'), "5m sweep shadow fire site present");
  assert.ok(pol.includes('const tail5 = store.readCandles(r.coin, now - SWEEP_LOOK_MS, now);') &&
    pol.includes('detectSweep(tail5, dayHi, dayLo, r.px, SWEEP_FRAC)'),
    "sweep reads the 5m archive tail (hoisted since -02 so dip-reclaim shares the read), prior-session levels from dailyRaw");
  assert.ok(pol.includes('r.uni === "xyz" && store.candlesEnabled'), "sweep is gated xyz-only and behind the optional 5m archive");
  assert.ok(pol.includes('playbook("fundflip", { logGeo: r.uni === "main", dir: s0, px: r.px, sd30 })'),
    "fundflip call site feeds the stop context AND the universe's geometry mode");
});

test("strategy shadows: stop-aware resolution in R for vi-stamped claims, invisible to getLedgerFor", async () => {
  const { createPoller } = require("../src/poller");
  const now = Date.now();
  const mk = (coin, stp) => ({ key: coin + "|reclaim#0", coin, ticker: coin, ev: "reclaim", t0: now - 6 * DAY,
    mark0: 100, dir: 1, score0: 0, sd0: 2, psd: "long", pn: 1, stp, vi: 0, resolveAt: now - DAY });
  const fixture = { ts: now, rearm: [], variants: null, closed: [],
    open: [mk("xyz:CLEAN", 95), mk("xyz:STOPPED", 99)] };
  const store = { loadAll: () => new Map(), loadRegime: () => [], loadLedger: () => fixture,
    saveLedger: () => {}, insert: () => {}, saveRegime: () => {} };
  const p = createPoller({ dex: "xyz", store, log: () => {}, version: "test", crypto: false });
  p.hydrateLedgerNow();
  // hourly spines covering fire -> horizon: CLEAN never nears its stop and drifts to 104;
  // STOPPED dips through 99 mid-window before closing at 104 — the touch must cap its leg
  const spine = (dip) => { const hs = []; for (let i = 160; i >= 0; i--) {
    const t = now - i * 3600e3; let px = 100 + (160 - i) * 0.025;
    if (dip && i > 60 && i < 70) px = 98.5;
    hs.push({ t, o: px, h: px + 0.2, l: px - 0.2, c: px, v: 1 }); } return hs; };
  p.seedRowNow("xyz:CLEAN", { px: 104, hourlyRaw: spine(false), hourlyTs: now });
  p.seedRowNow("xyz:STOPPED", { px: 104, hourlyRaw: spine(true), hourlyTs: now });
  await p.buildSignalsNow();   // runs resolveLedger
  const x = p.getLedgerExport(true);
  const done = Object.fromEntries(x.closed.filter((e) => e.ev === "reclaim").map((e) => [e.coin, e]));
  assert.ok(done["xyz:CLEAN"] && done["xyz:CLEAN"].status === "resolved", "clean claim resolved");
  assert.ok(done["xyz:CLEAN"].rn === 1 && Math.abs(done["xyz:CLEAN"].realized - 1.5) < 0.3, `resolved in R (spine drifts ~3% over the hold / σ2 ≈ 1.5R), got ${done["xyz:CLEAN"].realized}`);
  assert.equal(done["xyz:CLEAN"].stopped, false, "stop never touched");
  assert.ok(Math.abs(done["xyz:CLEAN"].realizedS - done["xyz:CLEAN"].realized) < 1e-9, "untouched stop: legs coincide");
  assert.ok(done["xyz:STOPPED"] && done["xyz:STOPPED"].stopped === true, "dip through the void marks the claim stopped");
  assert.ok(done["xyz:STOPPED"].realizedS < 0 && done["xyz:STOPPED"].realized > 0,
    "stop-aware leg caps at the void while at-horizon rides to the target — the exact honesty split");
  assert.equal(p.getLedgerFor("xyz:CLEAN", null, true).closed.length, 0, "strategy shadows never surface in the claim browser");
});

test("ledger archive: overflow is appended to the volume before the retention trim", () => {
  const fs = require("fs"), path = require("path"), os = require("os");
  const { openStore } = require("../src/store");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "xyzarc-"));
  const s = openStore(dir);
  s.archiveClosed([{ key: "A|gap", realized: 1 }, { key: "B|gap", realized: -1 }]);
  s.archiveClosed([{ key: "C|prem", realized: 2 }]);
  s.archiveClosed([]);   // empty append is a no-op, not a blank line
  const lines = fs.readFileSync(path.join(dir, "ledger-archive.jsonl"), "utf8").trim().split("\n");
  assert.equal(lines.length, 3, "one JSON line per archived entry, append-only across calls");
  assert.equal(JSON.parse(lines[2]).key, "C|prem", "order preserved");
  // wiring pins: both trim sites archive first, guarded for mocks without the method
  const pol = fs.readFileSync(path.join(__dirname, "..", "src", "poller.js"), "utf8");
  assert.equal((pol.match(/store\.archiveClosed\(/g) || []).length >= 2 && pol.includes("if (store.archiveClosed)"), true,
    "resolver + hydrate trims archive before slicing, guarded");
});

test("HTF shadow batch 2: failbrk mirror, pead reaction gate, fundext restored as a crypto-native event", () => {
  const C = require("../src/compute");
  const now = Date.now();
  // ---- failed-breakout fade: exact mirror of the reclaim trap
  const flat = []; for (let i = 0; i < 45; i++) flat.push([now - (45 - i) * DAY, 100 + ((i * 7) % 5) * 0.3]);
  const hi = Math.max(...flat.slice(-33, -3).map((k) => k[1]));
  flat[flat.length - 3][1] = hi + 2; flat[flat.length - 2][1] = hi + 3; flat[flat.length - 1][1] = hi + 1;
  const fb = C.detectFailBrk(flat, hi - 0.4);
  assert.ok(fb, "fresh break above + mark back below the level fires");
  assert.equal(fb.level, +hi.toPrecision(6), "level is the pre-flush 30d closing high");
  assert.equal(fb.stop, +(hi + 3).toPrecision(6), "stop is the flush high");
  assert.ok(Math.abs(fb.target - (hi - 3)) < 1e-9, "target is the inverted measured move");
  assert.equal(C.detectFailBrk(flat, hi + 0.5), null, "mark still above the level: no fade");
  const stale = flat.map((k) => [k[0], k[1]]);
  stale[stale.length - 2][1] = hi - 1; stale[stale.length - 1][1] = hi - 1;
  assert.equal(C.detectFailBrk(stale, hi - 0.4), null, "an aged-out break never fires");
  // ---- pead: completed outsized reaction drifts; AMC convention matches earnReactionsFor
  const dayOf = (t) => { const x = new Date(t); return x.getUTCFullYear() + "-" + String(x.getUTCMonth() + 1).padStart(2, "0") + "-" + String(x.getUTCDate()).padStart(2, "0"); };
  const daily = []; for (let i = 0; i < 30; i++) daily.push({ t: now - (30 - i) * DAY, c: 100, o: 100 });
  daily[27].c = 106;   // +6% reaction bar
  daily[28].c = 106.5; daily[29].c = 107;   // reaction session complete, drift underway
  const printsB = [{ t: "X", d: dayOf(daily[27].t), s: "BMO" }];
  const pd = C.detectPead(printsB, daily, 107, 2);
  assert.ok(pd && pd.side === "long", "BMO reaction bar is the print day itself");
  assert.equal(pd.mv, 6, "reaction magnitude frozen");
  assert.ok(pd.stop < 107 && pd.target > 107, "long geometry: stop below, target above");
  assert.ok(Math.abs(pd.stop - 106 * 0.98) < 1e-6, "stop 1σ back through the reaction close");
  assert.ok(Math.abs(pd.target - 107 * 1.03) < 1e-6, "target = half the reaction further from the mark");
  // Re-baselined (AMC timing fix): a 16:05 ET AMC print sits inside its own UTC-day bar, so the print
  // day's bar IS the reaction bar for AMC too — same convention as earnReactionsFor.
  const printsA = [{ t: "X", d: dayOf(daily[27].t), s: "AMC" }];
  assert.ok(C.detectPead(printsA, daily, 107, 2), "AMC books the print day's OWN bar as the reaction — same convention as earnReactionsFor");
  assert.equal(C.detectPead([{ t: "X", d: dayOf(daily[26].t), s: "AMC" }], daily, 107, 2), null, "dating the print a day early reads a flat bar: no reaction");
  assert.equal(C.detectPead(printsB, daily, 107, 5), null, "a reaction under 1.5σ is noise, not a REACTION");
  const incomplete = daily.slice(0, 28);   // reaction bar is the LAST bar — session not complete
  assert.equal(C.detectPead(printsB, incomplete, 106, 2), null, "no entry until the reaction session is complete");
  const old = [{ t: "X", d: dayOf(daily[20].t), s: "BMO" }];
  assert.equal(C.detectPead(old, daily, 107, 2), null, "a print older than 3 sessions has drifted without us — no chase");
  // ---- EV_META + wiring pins
  assert.equal(C.EV_META.failbrk.horizonMs, 5 * DAY);
  assert.equal(C.EV_META.pead.horizonMs, 10 * DAY);
  assert.ok(C.EV_META.fundext && C.EV_META.fundext.horizonMs === 2 * 86400e3,
    "fundext carries a meta again, on the crypto 2d horizon");
  assert.ok(!C.EV_META.liqflush, "liqflush stays retired — cascade exhaustion replaced it with observed-price geometry");
  assert.ok(C.EV_META.casc && C.EV_META.casc.horizonMs === 12 * 3600e3, "cascade exhaustion is a 12h claim");
  const fs = require("fs"), path = require("path");
  const pol = fs.readFileSync(path.join(__dirname, "..", "src", "poller.js"), "utf8");
  for (const pin of ['openLedger(r, "failbrk"', 'openLedger(r, "pead"',
    'r.uni === "xyz" && r.dailyRaw', "function fundPctileNow"])
    assert.ok(pol.includes(pin), `poller wiring pin missing: ${pin}`);
  // fundext has a fire site again, gated to crypto and carrying its episode floor; liqflush does
  // not — cascade exhaustion replaced it with geometry taken from prices the tape printed.
  assert.ok(pol.includes('openLedger(r, "fundext"'), "the fundext fire site is restored");
  assert.ok(pol.includes('openLedger(r, "casc"'), "the cascade-exhaustion fire site exists");
  assert.ok(!pol.includes('openLedger(r, "liqflush"'), "liqflush stays removed");
  assert.ok(pol.includes("const FUNDEXT_HOURS = 24;") && pol.includes("held >= FUNDEXT_MIN_SAMPLES"),
    "fundext carries a persistence floor — a percentile extreme is a PERSISTENT condition, and without an episode definition one episode serially re-opens claims and reports n=40 for a single observation");
  // the fire-time context stamp and the AI crypto read still share ONE percentile code path
  assert.ok((pol.match(/fundPctileNow\(/g) || []).length >= 3, "fireCtx and the AI crypto block both route through the shared percentile helper");
});

test("-80 regression: string-typed closes can't kill the board — detectors coerce, shadows are isolated", () => {
  const C = require("../src/compute");
  const now = Date.now();
  // the exact -79 outage shape: every close a string (Hyperliquid serves prices as strings
  // on some paths). Before the fix, detectFailBrk reached `hi.toPrecision` on a string and
  // the throw took down the entire signals build, every 10 minutes, board blank.
  const strs = []; for (let i = 0; i < 45; i++) strs.push([now - (45 - i) * DAY, String(100 + ((i * 7) % 5) * 0.3)]);
  const hi = Math.max(...strs.slice(-33, -3).map((k) => +k[1]));
  strs[strs.length - 3][1] = String(hi + 2); strs[strs.length - 2][1] = String(hi + 3); strs[strs.length - 1][1] = String(hi + 1);
  let fb;
  assert.doesNotThrow(() => { fb = C.detectFailBrk(strs, hi - 0.4); }, "string closes must never throw");
  assert.ok(fb && typeof fb.level === "number" && typeof fb.stop === "number",
    "coercion makes string closes WORK, not just fail closed — the setup still fires with numeric geometry");
  assert.equal(fb.stop, +(hi + 3).toPrecision(6));
  assert.doesNotThrow(() => C.detectReclaim(strs, hi - 0.4), "reclaim: same coercion");
  const strTrend = []; for (let i = 0; i < 70; i++) strTrend.push([now - (70 - i) * DAY, String(100 * Math.pow(1.004, i))]);
  assert.doesNotThrow(() => C.detectMAPull(strTrend, 130, 2), "mapull: same coercion");
  // pure garbage fails CLOSED (null), never open
  const junk = strs.map((k) => [k[0], "not-a-price"]);
  assert.equal(C.detectFailBrk(junk, 100), null);
  assert.equal(C.detectReclaim(junk, 100), null);
  // blast-radius pins: both strategy-shadow blocks are try/catch-isolated with once-per-build
  // logging — shadow bookkeeping can never take down the visible signal engine again
  const fs = require("fs"), path = require("path");
  const pol = fs.readFileSync(path.join(__dirname, "..", "src", "poller.js"), "utf8");
  assert.equal((pol.match(/swingFails\+\+; swingErr = \(e && e\.message\) \|\| String\(e\); \}/g) || []).length, 3,
    "swing, gapfade AND cascade blocks each catch into the per-build counter (the cascade lane reads an optional external feed)");
  assert.ok(pol.includes("let swingFails = 0, swingErr = null;"), "counters reset per build");
  assert.ok(pol.includes("strategy shadows failed on ${swingFails} market(s)"), "failures log once per build, visibly");
  const cmp = fs.readFileSync(path.join(__dirname, "..", "src", "compute.js"), "utf8");
  assert.equal((cmp.match(/closes\.map\(\(k\) => \+k\[1\]\)/g) || []).length, 8, "every daily-close detector coerces (reclaim, failbrk, mapull, roundfr, swpull/basebrk/regime200 + emabrk since -28)");
});

test("warm-boot signals cadence: 2-min builds for the first 20 minutes, then the steady 10", () => {
  const fs = require("fs"), path = require("path");
  const pol = fs.readFileSync(path.join(__dirname, "..", "src", "poller.js"), "utf8");
  for (const pin of ['staggered(signalsThenActionable, 10 * 60 * 1000, 5 * 1000);',
    'setTimeout(safeTick(buildSignals, "buildSignals"), 45 * 1000);',
    'if (Date.now() - bootT > 20 * 60 * 1000) clearInterval(earlyIv);',
    'signals warm-boot build:'])
    assert.ok(pol.includes(pin), 'warm-boot cadence pin missing: ' + pin);
});

test("play-signed results: fadeStats, resolver sign, and hydrate repair of inverted fader claims", () => {
  const { fadeStats } = require("../src/compute");
  const st = { n: 20, med: -0.9, avg: -0.62, hit: 0.28, unit: "%" };
  const f = fadeStats(st);
  assert.deepEqual([f.med, f.avg, f.hit, f.fade, f.n], [0.9, 0.62, 0.72, true, 20], "fadeStats flips into play units");
  assert.equal(st.med, -0.9, "source study never mutated");

  const { createPoller } = require("../src/poller");
  const now = Date.now();
  const fixture = { ts: now, rearm: [], variants: null,
    open: [
      // legacy open fader: claim med must flip; outcome sign comes from psd at resolution
      { key: "xyz:MSTR|gap", coin: "xyz:MSTR", ticker: "MSTR", ev: "gap", t0: now - 3600000, mark0: 100,
        dir: 1, psd: "short", score0: 30, resolveAt: now + 86400000, claim: { n: 12, med: -0.8 } },
    ],
    closed: [
      // the observed shape: up-gap (dir +1), FADE play (psd short), stopped, event-signed
      // realizedS +0.73 displayed as a green stop-aware "win" — in play units this fade LOST
      { key: "xyz:MSTR|gap#c", coin: "xyz:MSTR", ticker: "MSTR", ev: "gap", t0: now - 5 * 86400000, mark0: 100,
        dir: 1, psd: "short", stp: 101.2, status: "resolved", tR: now - 4 * 86400000,
        realized: 0.73, realizedS: 0.73, stopped: true, win: true, winS: true, claim: { n: 12, med: -0.8 } },
      // aligned continuation gap (psd long, dir +1): must be untouched
      { key: "xyz:COIN|gap", coin: "xyz:COIN", ticker: "COIN", ev: "gap", t0: now - 6 * 86400000, mark0: 50,
        dir: 1, psd: "long", status: "resolved", tR: now - 5 * 86400000,
        realized: 1.4, realizedS: 1.4, win: true, winS: true, claim: { n: 15, med: 0.6 } },
    ] };
  const store = { loadAll: () => new Map(), loadRegime: () => [], loadLedger: () => fixture,
    saveLedger: () => {}, insert: () => {}, saveRegime: () => {} };
  const p = createPoller({ dex: "xyz", store, log: () => {}, version: "test", crypto: false });
  p.hydrateLedgerNow();
  p.hydrateLedgerNow();   // idempotent — pn guards the second pass
  const mm = p.getLedgerFor("xyz:MSTR", null, true);
  const cl = mm.closed[0];
  assert.equal(cl.realized, -0.73, "failed fade now a LOSS in play units");
  assert.equal(cl.win, false, "win flag follows the play");
  assert.equal(cl.realizedS, -0.73, "stop-aware leg flipped too");
  assert.equal(cl.claimMed, 0.8, "claim median flipped into play units");
  assert.equal(mm.open[0].claimMed, 0.8, "open fader claim median flipped");
  const co = p.getLedgerFor("xyz:COIN", null, true).closed[0];
  assert.equal(co.realized, 1.4, "aligned claim untouched");
  assert.equal(co.win, true);
});

test("trend board ships width + retest volume (rrv) end to end via the seed harness", () => {
  const { createPoller } = require("../src/poller");
  const store = { loadAll: () => new Map(), loadRegime: () => [], loadLedger: () => null,
    saveLedger: () => {}, insert: () => {}, saveRegime: () => {} };
  const p = createPoller({ dex: "xyz", store, log: () => {}, version: "test", crypto: false });
  const now = Date.now(), endH = Math.floor(now / HOUR);
  // 16 days of hourly bars: enough for >=26 H12 buckets AND a ~15-day clock-matched RVOL
  // baseline. Gently rising closes, unit volume — except the last 24 COMPLETED hours, which
  // trade 2x. Lows are shallow so no intraday rung fires the retest; the D1 wick below owns it.
  const N = 16 * 24, hourly = [];
  for (let i = 0; i < N; i++) {
    const t = (endH - N + i) * HOUR, c = 100 * Math.pow(1.0005, i);
    hourly.push({ t, o: c, h: c * 1.001, l: c * 0.999, c, v: i >= N - 24 ? 2 : 1 });
  }
  const px = hourly[N - 1].c * 1.0005;
  // 60 daily bars rising 1%/day with deep lows: the recent daily wicks probe the D1 ribbon
  // while price holds above EMA21 — the canonical D1 RETEST.
  const daily = [];
  for (let i = 0; i < 60; i++)
    daily.push({ t: (Math.floor(now / DAY) - 60 + i) * DAY, c: px * Math.pow(1.01, i - 59), l: px * Math.pow(1.01, i - 59) * 0.90, h: px * Math.pow(1.01, i - 59) * 1.002 });
  p.seedRowNow("TREND1", { px, uni: "xyz", vol: 1e6, hourlyRaw: hourly, dailyRaw: daily });
  p.buildTrendNow();
  const row = p.getTrend().long.stocks.find((e) => e.coin === "TREND1");
  assert.ok(row, "seeded market reaches the long board");
  assert.ok(row.score >= 3, `score qualifies for a retest read, got ${row.score}`);
  assert.equal(row.retest, "D1", "the deep daily wick owns the retest (highest TF reported first)");
  assert.ok(row.width != null && row.width > 0, `width ships and is positive, got ${row.width}`);
  assert.ok(Math.abs(row.width - +((100 * row.strength) / row.score).toFixed(2)) < 0.011,
    "shipped width is the shipped strength normalized per aligned rung");
  assert.ok(row.rrv != null && row.rrv > 1.6 && row.rrv < 2.6,
    `retest volume reads ~2x for a doubled final day, got ${row.rrv}`);
  for (const e of p.getTrend().long.stocks) if (!e.retest) assert.ok(e.rrv == null, "rrv only rides a retest");
});

test("getTrendPair: validates the pickable set, passes the default through to the shared board", () => {
  const { createPoller } = require("../src/poller");
  const store = { loadAll: () => new Map(), loadRegime: () => [], loadLedger: () => null,
    saveLedger: () => {}, insert: () => {}, saveRegime: () => {} };
  const p = createPoller({ dex: "xyz", store, log: () => {}, version: "test", crypto: false });
  const now = Date.now(), endH = Math.floor(now / HOUR), N = 16 * 24, hourly = [];
  for (let i = 0; i < N; i++) { const t = (endH - N + i) * HOUR, c = 100 * Math.pow(1.0005, i); hourly.push({ t, o: c, h: c * 1.001, l: c * 0.999, c, v: 1 }); }
  const px = hourly[N - 1].c * 1.0005, daily = [];
  for (let i = 0; i < 60; i++) daily.push({ t: (Math.floor(now / DAY) - 60 + i) * DAY, c: px * Math.pow(1.01, i - 59), l: px * Math.pow(1.01, i - 59) * 0.99, h: px * Math.pow(1.01, i - 59) * 1.002 });
  p.seedRowNow("TP1", { px, uni: "xyz", vol: 1e6, hourlyRaw: hourly, dailyRaw: daily });
  p.buildTrendNow();
  assert.equal(p.getTrendPair(13, 21), p.getTrend(), "the default pair returns the canonical shared board");
  assert.equal(p.getTrendPair(9, 50), null, "a span outside the pickable set is rejected");
  assert.equal(p.getTrendPair(50, 50), null, "a pair must be two distinct MAs");
  const board = p.getTrendPair(200, 50);   // unordered input normalises to fast<slow
  assert.ok(board && board.params, "a valid custom pair builds a board");
  assert.deepEqual(board.params.ema, [50, 200], "the built board reports its normalised pair");
  assert.deepEqual(board.params.pickable, [13, 21, 50, 200], "the board advertises the pickable set");
});

test("parametric chart parity: pair board ships EMAs + rrv/swing, and the deeper H1 series reproduces its EMAs", () => {
  const { createPoller } = require("../src/poller");
  const { emaLast } = require("../src/compute");
  const store = { loadAll: () => new Map(), loadRegime: () => [], loadLedger: () => null,
    saveLedger: () => {}, insert: () => {}, saveRegime: () => {} };
  const p = createPoller({ dex: "xyz", store, log: () => {}, version: "test", crypto: false });
  const now = Date.now(), endH = Math.floor(now / HOUR), N = 16 * 24, hourly = [];
  for (let i = 0; i < N; i++) { const t = (endH - N + i) * HOUR, c = 100 * Math.pow(1.0005, i); hourly.push({ t, o: c, h: c * 1.001, l: c * 0.999, c, v: i >= N - 24 ? 2 : 1 }); }
  const px = hourly[N - 1].c * 1.0005, daily = [];
  // 80 UTC days = ~56 US sessions: the D1 rung is the session view (-105) and must seed EMA50
  for (let i = 0; i < 80; i++) daily.push({ t: (Math.floor(now / DAY) - 80 + i) * DAY, c: px * Math.pow(1.01, i - 79), l: px * Math.pow(1.01, i - 79) * 0.90, h: px * Math.pow(1.01, i - 79) * 1.002 });
  p.seedRowNow("PARITY", { px, uni: "xyz", vol: 1e6, hourlyRaw: hourly, dailyRaw: daily });
  // 13/50: D1 (~56 sessions) + H4 (96 buckets) + H1 (280 bars) seed EMA50; H12 (32 buckets) can't → grey
  const board = p.getTrendPair(13, 50);
  const row = board.long.stocks.find((e) => e.coin === "PARITY");
  assert.ok(row, "the pair row reaches the long board");
  assert.equal(row.tf.H12.st, "nodata", "H12 can't seed EMA50 on 32 buckets -> grey rung");
  assert.equal(row.tf.H12.e21, null, "a nodata rung ships no EMA");
  assert.equal(row.avail, 3, "scored out of the three rungs that seeded");
  assert.ok(row.tf.D1.e13 > 0 && row.tf.D1.e21 > 0, "computed rungs ship the pair's EMA values for the modal's zone band");
  assert.equal(row.retest, "D1", "the deep daily wick owns the retest");
  assert.ok(/EMA50/.test(row.read) && !/EMA21/.test(row.read), "the read names the active slow MA (EMA50), not a hardcoded 21");
  assert.ok(row.rrv != null && row.rrv > 1.5, `rrv is computed for the pair board (parity), got ${row.rrv}`);
  assert.ok("swing" in row, "the swing target is evaluated for the pair board (parity) — null here since a monotonic climb has no overhead swing");
  // the pair chart widens the H1 feed to match the board and reproduces its H1 EMAs bit-for-bit
  const res = p.getTfCandles("PARITY", "1h", 13, 50);
  assert.ok(res.candles.length > 96, `pair chart widens the H1 feed past 96, got ${res.candles.length}`);
  const closes = res.candles.map((k) => +k[4]); closes[closes.length - 1] = res.px;   // same live-mark-drives-the-forming-bar rule
  const rel = (a, b) => Math.abs(a - b) / Math.abs(b);
  assert.ok(rel(emaLast(closes, 13), row.tf.H1.e13) < 1e-6 && rel(emaLast(closes, 50), row.tf.H1.e21) < 1e-6,
    "the plotted pair ribbon reproduces the board's H1 EMAs — the modal cannot disagree with the pair board");
  // a plain 2-arg candle fetch (no pair) is unchanged — the canonical chart still reads 96 bars
  assert.ok(p.getTfCandles("PARITY", "1h").candles.length <= 96, "the default chart feed is untouched");
});

test("trend retest -> ledger signal: the board's badge fires a claim with frozen ladder geometry", async () => {
  // The RETEST badge promoted to the ledger. Contract under test, end to end: the condition IS
  // the board (score >= 3, board-visible, retest set by trendRead's own gate); the claim's void
  // is the retesting rung's OWN EMA21 as shipped on the trend payload; the target is the
  // rung-series prior swing, also shipped (the modal's target line and the ledger freeze are the
  // same number); side/geometry are valid; horizon is 5d; features (rung, board score, rrv,
  // age) are recorded on the entry — recorded, not gated.
  const { createPoller } = require("../src/poller");
  const store = { loadAll: () => new Map(), loadRegime: () => [], loadLedger: () => null,
    saveLedger: () => {}, insert: () => {}, saveRegime: () => {} };
  const p = createPoller({ dex: "xyz", store, log: () => {}, version: "test", crypto: false });
  const now = Date.now(), endH = Math.floor(now / HOUR);
  const N = 16 * 24, hourly = [];
  for (let i = 0; i < N; i++) {
    const t = (endH - N + i) * HOUR, c = 100 * Math.pow(1.0005, i);
    hourly.push({ t, o: c, h: c * 1.001, l: c * 0.999, c, v: 1 });
  }
  const px = hourly[N - 1].c * 1.0005;
  // rising dailies whose recent LOWS probe the D1 EMA13 (the retest) while closes hold the
  // stack, with one prior swing spike ABOVE the mark so a valid target exists
  const daily = [];
  for (let i = 0; i < 60; i++) {
    const c = px * Math.pow(1.01, i - 59);
    daily.push({ t: (Math.floor(now / DAY) - 60 + i) * DAY, c, l: c * 0.90, h: c * (i === 50 ? 1.15 : 1.002) });
  }
  p.seedRowNow("TRSIG", { px, ticker: "TRSIG", uni: "xyz", vol: 1e6, hourlyRaw: hourly, dailyRaw: daily });
  p.buildTrendNow();
  const row = p.getTrend().long.stocks.find((e) => e.coin === "TRSIG");
  assert.ok(row && row.retest, "fixture produces a board-visible retest");
  assert.ok(row.score >= 3, "retest rows carry trendRead's own >=3/4 gate");
  assert.ok(row.swing != null && row.swing > px, "prior swing ships on the payload and sits on the profit side of the mark");
  const zone = row.tf[row.retest];
  assert.ok(zone && zone.e21 > 0 && zone.e21 < px, "retesting rung's EMA21 shipped, below the mark for a long");
  await p.buildSignalsNow();
  const sigs = p.getSignals(true);
  const s = sigs && sigs.signals ? sigs.signals.find((g) => g.coin === "TRSIG" && g.ev === "tretest") : null;
  assert.ok(s, "tretest signal is visible in the signals payload");
  assert.equal(s.play.side, "long", "play side follows the board side");
  const rel = (a, b) => Math.abs(a - b) / Math.abs(b);
  assert.ok(rel(s.play.stop, zone.e21) < 1e-5, "frozen void IS the ladder's own EMA21 for the retesting rung");
  assert.ok(rel(s.play.target, row.swing) < 1e-5, "frozen target IS the shipped prior-swing level");
  assert.ok(s.reading.includes(row.retest), "reading names the retesting rung");
  const led = p.getLedgerFor("TRSIG", "tretest", true);
  assert.equal(led.open.length, 1, "exactly one open claim — the episode gate holds");
  const e = led.open[0];
  assert.equal(e.side, "long", "claim side is play-signed");
  assert.ok(Math.abs(e.resolveAt - e.t0 - 5 * DAY) < 1000, "5d horizon");
  assert.ok(e.mv != null && e.mv > 0, "mv (target distance) stamped for the move-filtered record");
  // second build inside the same episode: no serial re-open (the pseudo-replication guard)
  await p.buildSignalsNow();
  assert.equal(p.getLedgerFor("TRSIG", "tretest", true).open.length, 1, "same episode never opens a second claim");
  // and the short mirror stays silent on a long-side retest
  assert.equal(p.getLedgerFor("TRSIG", "tretestdn", true).open.length, 0, "no phantom short claim");
});

test("poller score duel: one snapshot per UTC day, IC lands when the next day's prices do, state persists and hydrates", () => {
  const { createPoller } = require("../src/poller");
  let saved = null;
  const store = { loadAll: () => new Map(), loadRegime: () => [], loadLedger: () => null,
    saveLedger: () => {}, insert: () => {}, saveRegime: () => {}, saveNews: () => {}, loadNews: () => null,
    saveDuel: (d) => { saved = JSON.parse(JSON.stringify(d)); }, loadDuel: () => saved };
  const p = createPoller({ dex: "xyz", store, log: () => {}, version: "test", crypto: false });
  const DAY = 86400000;
  const mkRow = (i, px) => ({ coin: "xyz:T" + i, ticker: "T" + i, delisted: false, uni: "xyz",
    px, d1: (i - 4.5) * 2,   // spread of returns so scores rank cleanly
    ref: { p1h: px * 0.999, p4h: px * 0.998, p7d: px / (1 + (i - 4.5) * 0.05), p30d: px / (1 + (i - 4.5) * 0.08) },
    feat: { volH: 0.004, volD: 0.02, hi30: px * 1.1, lo30: px * 0.85 }, funding: 0.00001 });
  const day1 = 20000, now1 = day1 * DAY + 3600000;
  const rows1 = []; for (let i = 0; i < 10; i++) rows1.push(mkRow(i, 100));
  p.duelTickNow(now1, { xyz: rows1, main: [] });
  assert.ok(saved && saved.snaps[day1] && Object.keys(saved.snaps[day1].xyz).length === 10, "day-1 snapshot lands and persists");
  assert.equal(saved.ic.length, 0, "no IC yet — one day is not a record");
  // same day, later tick: the one-key guard must not double-snap or rewrite
  const before = JSON.stringify(saved.snaps[day1]);
  p.duelTickNow(now1 + 7200000, { xyz: rows1.map((r) => Object.assign({}, r, { px: 999 })), main: [] });
  assert.equal(JSON.stringify(saved.snaps[day1]), before, "second tick on the same day is a no-op");
  // next day: returns proportional to score rank -> IC near +1 for both columns
  const rows2 = []; for (let i = 0; i < 10; i++) rows2.push(mkRow(i, 100 * (1 + i * 0.01)));
  p.duelTickNow((day1 + 1) * DAY + 3600000, { xyz: rows2, main: [] });
  assert.equal(saved.ic.length, 1, "exactly one IC row per scope per day pair");
  const row = saved.ic[0];
  assert.equal(row.d, day1); assert.equal(row.u, "xyz"); assert.equal(row.n, 10);
  assert.ok(row.a > 0.9 && row.b > 0.9, "rank-aligned returns -> IC near +1 for both scores");
  assert.ok(!saved.snaps[day1 - 5], "stale snapshots pruned");
  // the served payload carries the record + gate
  const duel = p.getDuel();
  assert.equal(duel.scopes.xyz.ic.length, 1);
  assert.equal(duel.scopes.xyz.stats.n, 1);
  assert.equal(duel.scopes.xyz.stats.verdict, false, "one day never unlocks a verdict");
  assert.ok(duel.minN >= 60, "verdict gate shipped to the client");
  assert.ok(duel.dataTs > 0, "dataTs moves with content so the ETag works");
  // a fresh poller hydrates the same record off the (stubbed) volume
  const p2 = createPoller({ dex: "xyz", store, log: () => {}, version: "test", crypto: false });
  p2.hydrateDuelNow();
  assert.equal(p2.getDuel().scopes.xyz.ic.length, 1, "record survives a redeploy");
  // boot mid-day with a cold universe must NOT burn the day: below the name floor, no snap
  let saved3 = null;
  const store3 = Object.assign({}, store, { saveDuel: (d) => { saved3 = d; }, loadDuel: () => null });
  const p3 = createPoller({ dex: "xyz", store: store3, log: () => {}, version: "test", crypto: false });
  p3.duelTickNow(now1, { xyz: rows1.slice(0, 3), main: [] });
  assert.equal(saved3, null, "under 8 snappable names the day stays unclaimed for a later retry");
});

test("levels -09: ctx.levels always ships — populated where structure exists, explicitly empty with a note where it doesn't", () => {
  const { p } = aiLevelPoller();
  const ctx = p.aiCompileNow("xyz:NVDA");
  assert.ok(ctx.levels && Array.isArray(ctx.levels.items), "ctx.levels must ALWAYS ship — the snap rule binds to it, so absent and empty must not be the same thing");
  assert.ok(ctx.levels.items.length >= 2, "the zigzag has structure the detector should find");
  assert.ok(ctx.levels.tauPct > 0, "tau ships so the validator can size its snap tolerance from the same number");
  assert.ok(ctx.levels.items.every((l) => l.v > 0 && l.n >= 2 && typeof l.side === "string"), "every shipped level carries price, touches and a side");
  // the monotone harness: no confirmed pivots anywhere, and the note says so rather than shipping nothing
  const mono = aiTestPoller().p.aiCompileNow("xyz:NVDA");
  assert.equal(mono.levels.n, 0);
  assert.deepEqual(mono.levels.items, []);
  assert.ok(/insufficient daily history/.test(mono.levels.note), "the empty case explains itself: " + mono.levels.note);
});

test("levels -09: a non-anchored directional void must sit on detected structure — off-level reads are rejected, near-misses snap", () => {
  const { p, px } = aiLevelPoller();
  const ctx = () => p.aiCompileNow("xyz:NVDA");
  const c0 = ctx();
  const below = c0.levels.items.filter((l) => l.v < px).sort((a, b) => b.v - a.v);
  assert.ok(below.length, "harness must offer at least one level under the mark");
  const lv = below[0].v, tgt = +(px * 1.09).toPrecision(6);
  // a void copied verbatim off ctx.levels passes untouched
  const ok = p.aiValidateNow(AI_GOOD(px, lv, tgt), c0);
  assert.ok(ok.ok, "a void ON a detected level must pass: " + (ok.error || ""));
  assert.ok(Math.abs(ok.computed.voidLevel / lv - 1) < 1e-6, "and must not be moved");
  // the whole point: a plausible round number backed by nothing is refused, not quietly used
  const tol = c0.levels.tauPct * 0.5 / 100;
  const bogus = +(lv * (1 - 12 * tol)).toPrecision(6);
  const bad = p.aiValidateNow(AI_GOOD(px, bogus, tgt), c0);
  assert.equal(bad.ok, false, "an off-structure void must fail");
  assert.ok(/does not sit on any detected structural level/.test(bad.error), bad.error);
  // within tolerance the value is snapped exactly onto the level, and the report says it was
  const near = +(lv * (1 + tol * 0.4)).toPrecision(6);
  const sn = p.aiValidateNow(AI_GOOD(px, near, tgt), c0);
  assert.ok(sn.ok, "a near-miss must snap, not fail: " + (sn.error || ""));
  assert.ok(Math.abs(sn.computed.voidLevel / lv - 1) < 1e-6, "snapped onto the detected price, so the chart line and the ledger stop agree with the detector");
  assert.equal(sn.computed.correctedVoid, true, "a moved void must be flagged corrected, exactly like the claim-anchor path");
  // and the money math is computed off the SNAPPED void, never the model's original number
  const risk = px - sn.computed.voidLevel;
  const scT = sn.computed.scenarios.find((s) => s.kind === "target");
  assert.ok(Math.abs(scT.payoffR - (tgt - px) / risk) < 0.02, "R is measured from the snapped void");
});

test("levels -09: the snap rule yields to frozen claim geometry, exempts neutral reads, and stands down with no structure", () => {
  const { p, px } = aiLevelPoller();
  const c0 = p.aiCompileNow("xyz:NVDA");
  const tol = c0.levels.tauPct * 0.5 / 100;
  const lv = c0.levels.items.filter((l) => l.v < px).sort((a, b) => b.v - a.v)[0].v;
  const offLevel = +(lv * (1 - 12 * tol)).toPrecision(6), tgt = +(px * 1.09).toPrecision(6);
  // 1. a frozen claim outranks the detector — the ledger's stop is the void, structure or not
  const anchored = Object.assign({}, c0, { claimAnchor: { ev: "breakout", side: "long",
    stop: offLevel, target: null, t0: Date.now(), resolveAt: Date.now() + 86400000 } });
  const a = p.aiValidateNow(AI_GOOD(px, offLevel, tgt), anchored);
  assert.ok(a.ok, "claim geometry must still win outright: " + (a.error || ""));
  assert.ok(Math.abs(a.computed.voidLevel / offLevel - 1) < 1e-6, "and the claim stop is used verbatim, never snapped away from the ledger");
  // 2. a neutral read carries no void and is not subject to the rule
  const neutral = JSON.parse(AI_GOOD(px, lv, tgt));
  neutral.bias = "neutral"; neutral.levels = []; neutral.action = { stance: "wait", entry: null, note: "no directional edge here" };
  neutral.scenarios = [{ name: "chop", kind: "flat", p: 0.6, target: null }, { name: "resolves up", kind: "target", p: 0.4, target: tgt }];
  assert.equal(p.aiValidateNow(JSON.stringify(neutral), c0).ok, true, "neutral reads are exempt");
  // 3. no confirmed structure -> the rule stands down entirely, or a young listing could never
  // get a directional read at all
  const bare = Object.assign({}, c0, { levels: { n: 0, items: [], note: "insufficient daily history for confirmed pivots" } });
  assert.equal(p.aiValidateNow(AI_GOOD(px, offLevel, tgt), bare).ok, true, "empty levels must not block a report");
  const gone = Object.assign({}, c0); delete gone.levels;
  assert.equal(p.aiValidateNow(AI_GOOD(px, offLevel, tgt), gone).ok, true, "a context predating the field degrades, never throws");
});

test("levels study -10: poller wiring manifest — section, scope, source, memo, sig", () => {
  const fs = require("fs"), path = require("path");
  const pol = fs.readFileSync(path.join(__dirname, "..", "src", "poller.js"), "utf8");
  for (const pin of [
    "function buildLevelsStudy(U)",
    "levels: lvSt,",                                          // sections wired to the ONE precomputed study
    'const lvSt = on("structure") ? buildLevelsStudy(U) : DISABLED;',   // -19: built only when the universe publishes Structure                      // computed before the sig so ETag and payload agree
    "const LVL_MIN_EQ = 5;",
    "const LVL_STRIDE = 5, LVL_HORIZON = 10, LVL_MINBARS = 60, LVL_CELL_FLOOR = 20;",
    "const db = bucketsFor(r, 24);",                          // spine-derived OHLC dailies — NOT dailyRaw (closes-only after a warm boot would blind the low-side touch test)
    "const bars = db.slice(0, -1);",                          // forming UTC day excluded — closed bars only
    "r._lvSrc !== db",                                        // memo on the bucket array's own freshness contract
    "detectLevels, levelOutcomes, levelStudy,",               // engine imported alongside the detector it audits
  ]) assert.ok(pol.includes(pin), `poller.js missing -10 wiring pin: ${pin}`);
  // scope (-17): the study reads the universe descriptor's roster + eligibility, not a hardcoded
  // xyz-equity filter — one code path, two universes. Stocks eligibility is still equity-only.
  assert.ok(/buildLevelsStudy\(U\) \{\s*\n\s*U = U \|\| analyticsUniverse\("stocks"\);\s*\n\s*const eq = U\.roster\(\)\.filter\(\(r\) => U\.studyEligible\(r\)\)/.test(pol),
    "the study must scope through the universe descriptor (U.roster + U.studyEligible)");
  assert.ok(/studyEligible: \(r\) => r && !r\.delisted && classifyCached\(r\.ticker\)\.assetClass === "Equity"/.test(pol),
    "stocks universe still gates studies to equities");
  // the analytics sig must move when the study moves
  assert.ok(pol.includes('const lvSig = lvSt.disabled ? "off" : (lvSt.pending ?') && /const sig = `\$\{U\.scope\}[^`]*\$\{lvSig\}/.test(pol),
    "levels study signature must feed the /api/analytics ETag");
  assert.ok(!pol.includes("levels: buildLevelsStudy(),"), "sections must reuse lvSt, never a second computation that could disagree with the sig");
});

test("levels study -10: end-to-end through the poller — seeded equities produce a served study, thin books stay pending", async () => {
  const { openStore } = require("../src/store");
  const { createPoller } = require("../src/poller");
  const fs = require("fs"), path = require("path"), os = require("os");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "xyzlvl-"));
  try {
    const store = openStore(dir);
    const p = createPoller({ dex: "xyz", store, log: () => {}, version: "test", crypto: false });
    const HOUR = 3600 * 1000, now = Math.floor(Date.now() / HOUR) * HOUR;
    // 130 UTC days of hourly bars per name — enough closed daily buckets past minBars+horizon.
    const spine = (seed) => {
      let s = seed; const rnd = () => { s = (s * 1103515245 + 12345) & 0x7fffffff; return s / 0x7fffffff; };
      const nrm = () => { let u = 0, v = 0; while (!u) u = rnd(); while (!v) v = rnd(); return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v); };
      const out = []; let px = 100; const N = 130 * 24;
      for (let i = 0; i < N; i++) {
        px *= 1 + nrm() * 0.004;
        const h = px * (1 + Math.abs(nrm()) * 0.002), l = px * (1 - Math.abs(nrm()) * 0.002);
        out.push([now - (N - i) * HOUR, px, Math.max(h, px), Math.min(l, px), px, 1000]);
      }
      return out;
    };
    // AAPL/MSFT/NVDA-class tickers classify as Equity through the real classifier.
    const names = ["AAPL", "MSFT", "NVDA", "AMZN", "GOOGL", "META"];
    names.forEach((t, i) => p.seedRowNow("xyz:" + t, { px: 100, ticker: t, hourlyRaw: spine(97 + i * 13), hourlyTs: now }));
    await p.buildAnalyticsNow();
    const a = p.getAnalytics();
    assert.ok(a && a.sections && a.sections.levels, "sections.levels served");
    const lv = a.sections.levels;
    assert.ok(!lv.pending, `study live with ${names.length} seeded equities, got ${JSON.stringify({ pending: lv.pending, count: lv.count })}`);
    assert.ok(lv.n > 50, `pooled events across the seeded book (${lv.n})`);
    assert.equal(lv.coverage.tickers, names.length, "every seeded equity contributes");
    assert.equal(lv.horizon, 10);
    assert.ok(Array.isArray(lv.buckets) && lv.buckets.length === 7, "distance buckets served");
    assert.ok(lv.overall.touchRate == null || Number.isFinite(lv.overall.baseline), "overall control rides along");
    // ETag: the analytics version must move when the study first lands (sig includes lvSig)
    const v1 = a.dataTs;
    assert.ok(v1 > 0, "analytics ETag version stamped");
    // memo: a second build with an unchanged spine must NOT recompute (events array identity survives)
    await p.buildAnalyticsNow();
    const b = p.getAnalytics();
    assert.equal(b.dataTs, v1, "unchanged content -> unchanged ETag version (levels sig is stable)");
    // pending path: a fresh poller with too few equities reports the honest gate
    const p2 = createPoller({ dex: "xyz", store, log: () => {}, version: "test", crypto: false });
    p2.seedRowNow("xyz:AAPL", { px: 100, ticker: "AAPL", hourlyRaw: spine(5), hourlyTs: now });
    await p2.buildAnalyticsNow();
    const lv2 = p2.getAnalytics().sections.levels;
    assert.ok(lv2.pending, "one equity -> pending, never a study on a two-name class");
    assert.equal(lv2.need, 5);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test("anatomy -11: poller wiring manifest — section, scope, memo, sig", () => {
  const fs = require("fs"), path = require("path");
  const pol = fs.readFileSync(path.join(__dirname, "..", "src", "poller.js"), "utf8");
  for (const pin of [
    "function buildAnatomy(U)",
    "anatomy: anSt,",
    "const anSt = buildAnatomy(U);",
    "const ANAT_MIN_EQ = 5, ANAT_MIN_SESS = 20, ANAT_MIN_CROSS = 3;",
    "r._anSrc !== hs",                                        // memo on the spine's own identity
    "sessionRecords, anatomyEnrich, mondayStats, nakedStats, anatomyPool,",
  ]) assert.ok(pol.includes(pin), `poller.js missing -11 wiring pin: ${pin}`);
  assert.ok(/buildAnatomy\(U\) \{\s*\n\s*U = U \|\| analyticsUniverse\("stocks"\);\s*\n\s*const eq = U\.roster\(\)\.filter\(\(r\) => U\.studyEligible\(r\)\)/.test(pol),
    "anatomy scopes through the universe descriptor (U.roster + U.studyEligible)");
  assert.ok(pol.includes("const anSig = anSt.pending ?") && /const sig = `\$\{U\.scope\}[^`]*\$\{anSig\}`/.test(pol),
    "anatomy signature must feed the /api/analytics ETag");
  assert.ok(!pol.includes("anatomy: buildAnatomy(),"), "sections must reuse anSt — one computation, sig and payload agree");
});

test("anatomy -11: end-to-end through the poller — served study, stable ETag, honest pending", async () => {
  const { openStore } = require("../src/store");
  const { createPoller } = require("../src/poller");
  const fs = require("fs"), path = require("path"), os = require("os");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "xyzanat-"));
  try {
    const store = openStore(dir);
    const p = createPoller({ dex: "xyz", store, log: () => {}, version: "test", crypto: false });
    const HOUR = 3600 * 1000, now = Math.floor(Date.now() / HOUR) * HOUR;
    const spine = (seed) => {
      let s = seed; const rnd = () => { s = (s * 1103515245 + 12345) & 0x7fffffff; return s / 0x7fffffff; };
      const nrm = () => { let u = 0, v = 0; while (!u) u = rnd(); while (!v) v = rnd(); return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v); };
      const out = []; let px = 100; const N = 130 * 24;
      for (let i = 0; i < N; i++) {
        px *= 1 + nrm() * 0.004;
        const h = px * (1 + Math.abs(nrm()) * 0.002), l = px * (1 - Math.abs(nrm()) * 0.002);
        out.push([now - (N - i) * HOUR, px, Math.max(h, px), Math.min(l, px), px, 1000]);
      }
      return out;
    };
    const names = ["AAPL", "MSFT", "NVDA", "AMZN", "GOOGL", "META"];
    names.forEach((t, i) => p.seedRowNow("xyz:" + t, { px: 100, ticker: t, hourlyRaw: spine(41 + i * 17), hourlyTs: now }));
    await p.buildAnalyticsNow();
    const a = p.getAnalytics();
    const an = a.sections && a.sections.anatomy;
    assert.ok(an && !an.pending, `anatomy live, got ${JSON.stringify(an && { pending: an.pending, count: an.count })}`);
    assert.equal(an.tickers, names.length);
    assert.ok(an.days >= 120, `~129 complete UTC sessions expected, got ${an.days}`);
    assert.ok(an.mfe.medUpSd > 0, "sd-scored excursion medians served");
    assert.ok(an.monday.weeks >= 15, `pooled weeks served (${an.monday.weeks})`);
    assert.ok(an.naked.revisit.every((x) => x == null || (x >= 0 && x <= 1)), "revisit rates are probabilities");
    const v1 = a.dataTs;
    await p.buildAnalyticsNow();
    assert.equal(p.getAnalytics().dataTs, v1, "unchanged spine -> memo holds, ETag stable");
    const p2 = createPoller({ dex: "xyz", store, log: () => {}, version: "test", crypto: false });
    p2.seedRowNow("xyz:AAPL", { px: 100, ticker: "AAPL", hourlyRaw: spine(5), hourlyTs: now });
    await p2.buildAnalyticsNow();
    const an2 = p2.getAnalytics().sections.anatomy;
    assert.ok(an2.pending && an2.need === 5, "thin book reports the honest gate");
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test("-13 end-to-end: byTicker scopes, candles and pivots ride the served anatomy payload", async () => {
  const { openStore } = require("../src/store");
  const { createPoller } = require("../src/poller");
  const fs = require("fs"), path = require("path"), os = require("os");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "xyzsc-"));
  try {
    const store = openStore(dir);
    const p = createPoller({ dex: "xyz", store, log: () => {}, version: "test", crypto: false });
    const HOUR = 3600 * 1000, now = Math.floor(Date.now() / HOUR) * HOUR;
    const spine = (seed) => {
      let s = seed; const rnd = () => { s = (s * 1103515245 + 12345) & 0x7fffffff; return s / 0x7fffffff; };
      const nrm = () => { let u = 0, v = 0; while (!u) u = rnd(); while (!v) v = rnd(); return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v); };
      const out = []; let px = 100; const N = 130 * 24;
      for (let i = 0; i < N; i++) {
        px *= 1 + nrm() * 0.004;
        const h = px * (1 + Math.abs(nrm()) * 0.002), l = px * (1 - Math.abs(nrm()) * 0.002);
        out.push([now - (N - i) * HOUR, px, Math.max(h, px), Math.min(l, px), px, 1000]);
      }
      return out;
    };
    const names = ["AAPL", "MSFT", "NVDA", "AMZN", "GOOGL", "META"];
    names.forEach((t, i) => p.seedRowNow("xyz:" + t, { px: 100, ticker: t, hourlyRaw: spine(61 + i * 19), hourlyTs: now }));
    await p.buildAnalyticsNow();
    const secs = p.getAnalytics().sections;
    const an = secs.anatomy, lv = secs.levels;
    assert.ok(an && !an.pending && lv && !lv.pending);
    assert.equal(Object.keys(an.byTicker).length, names.length, "every equity gets an anatomy scope entry");
    const one = an.byTicker["xyz:NVDA"];
    assert.equal(one.ticker, "NVDA");
    assert.ok(one.sessions >= 120 && one.quartiles.length === 4 && one.candles.doji !== undefined,
      "per-name summary carries sessions, quartiles and candle types");
    assert.ok(Object.keys(lv.byTicker).length >= 1, "levels scope entries served where events exist");
    for (const k in lv.byTicker) {
      const v = lv.byTicker[k];
      assert.ok(Number.isFinite(v.n) && v.overall, "per-name levels shape: n + overall + byTouches");
      // -14: buckets ship per name so the chart follows the scope selector — same aggregator,
      // same floor (thin per-name cells arrive dim, disclosing their n, never silently dropped).
      assert.ok(Array.isArray(v.buckets) && v.buckets.length && Number.isFinite(v.cellFloor),
        "per-name distance buckets + cellFloor served (chart follows the selector)");
      for (const b of v.buckets) assert.ok(Number.isFinite(b.n), "each per-name bucket discloses its n");
    }
    assert.ok(an.candles && an.candles.n > 300 && an.candles.types.length === 6, "candle behaviour served");
    assert.ok(Math.abs(an.pivots.hi.share.reduce((a, b) => a + b, 0) - 1) < 0.01, "pivot histogram served, sums to 1");
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test("-17 crypto analytics build: every applicable study lives on a 90d crypto universe, independent of the xyz build", async () => {
  const { openStore } = require("../src/store");
  const { createPoller } = require("../src/poller");
  const fs = require("fs"), path = require("path"), os = require("os");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "xyz17-"));
  try {
    const store = openStore(dir);
    const p = createPoller({ dex: "xyz", store, log: () => {}, version: "test", crypto: true });
    const HOUR = 3600 * 1000, now = Math.floor(Date.now() / HOUR) * HOUR;
    const spine = (seed) => {
      let s = seed; const rnd = () => { s = (s * 1103515245 + 12345) & 0x7fffffff; return s / 0x7fffffff; };
      const nrm = () => { let u = 0, v = 0; while (!u) u = rnd(); while (!v) v = rnd(); return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v); };
      const out = []; let px = 100; const N = 90 * 24, t0 = now - N * HOUR;
      for (let i = 0; i < N; i++) { const o = px, c = o * (1 + nrm() * 0.006); out.push([t0 + i * HOUR, o, Math.max(o, c) * (1 + Math.abs(nrm()) * 0.004), Math.min(o, c) * (1 - Math.abs(nrm()) * 0.004), c, 1000 + Math.abs(nrm()) * 5000]); px = c; }
      return out;
    };
    // 8 crypto perps (no colon -> uni "main"), each with a 90d spine + funding history
    ["BTC", "ETH", "SOL", "AVAX", "LINK", "DOGE", "ARB", "OP"].forEach((t, i) => {
      const r = p.seedRowNow(t, { px: 100 + i, hourlyRaw: spine(7 + i * 13), hourlyTs: now });
      for (let h = 0; h < 90 * 24; h += 8) r.fundH.set(now - h * HOUR, (Math.sin(h / 24) * 5) / 1e6);
      r._fVer = (r._fVer || 0) + 1;
    });
    // one xyz equity, so the stocks build is independently exercised and must stay pending (n=1)
    p.seedRowNow("xyz:NVDA", { px: 120, ticker: "NVDA", hourlyRaw: spine(999), hourlyTs: now });

    await p.buildAnalyticsNow("crypto");
    await p.buildAnalyticsNow("stocks");
    const cr = p.getAnalytics("crypto"), st = p.getAnalytics("stocks");

    // the two payloads are distinct objects with the right universe tags and window depths
    assert.ok(cr && st && cr !== st, "separate per-universe caches");
    assert.equal(cr.scope, "crypto"); assert.equal(cr.tz, "UTC"); assert.equal(cr.isCrypto, true);
    assert.equal(st.scope, "stocks"); assert.equal(st.tz, "ET"); assert.equal(st.isCrypto, false);
    assert.equal(cr.window.hourlyDays, 90, "crypto studies run on the 90d spine");
    assert.equal(st.window.hourlyDays, 180, "xyz studies keep the 180d spine");

    const sec = cr.sections;
    // session decomposition: crypto legs are utcday + weekend, NEVER cash/overnight
    assert.ok(sec.sessionDecomp && !sec.sessionDecomp.pending, "crypto session decomposition lives");
    const legs = Object.keys(sec.sessionDecomp.sessions);
    assert.deepEqual(legs.sort(), ["utcday", "weekend"].sort(), "crypto decomposition: UTC-day + weekend, no cash leg");
    assert.equal(sec.sessionDecomp.isCrypto, true);
    // -19 dropped Clocks/Week/Structure from crypto; -27 restored STRUCTURE (the level + EMA200
    // studies are price-structure claims — a 200-EMA pullback/breakdown/reclaim is as native to a
    // perp as to any equity; stocks-only was a wiring accident). Still not computed on crypto:
    // hour/day grids, seasonality, and clusters — clusters consume the hour clocks crypto does
    // not publish, and must ship {disabled:true}, never an eternal pending row.
    assert.deepEqual(cr.groups, ["positioning", "holds", "structure"], "crypto publishes positioning + holds + structure");
    for (const k of ["hourClock", "dow", "clusters", "seasonality"])
      assert.equal(sec[k] && sec[k].disabled, true, `crypto ${k} must be disabled, not built`);
    assert.ok(sec.levels && !sec.levels.disabled, "crypto structural levels study must BUILD since -27");
    assert.ok(sec.ema200 && !sec.ema200.disabled, "crypto ema200 study must BUILD since -27");
    // and the ones it DOES publish are real (no disabled leaking into the Holds group)
    for (const k of ["sessionDecomp", "anatomy"])
      assert.ok(sec[k] && !sec[k].disabled, `crypto ${k} must still be built`);
    // anatomy + candle behaviour + pivots all live off the same record pass
    assert.ok(sec.anatomy && !sec.anatomy.pending, "anatomy lives");
    assert.ok(sec.anatomy.candles && sec.anatomy.candles.n > 0, "candle behaviour served for crypto");
    assert.ok(sec.anatomy.pivots && sec.anatomy.pivots.hi.nDays > 0, "time pivots served for crypto");
    assert.equal(Object.keys(sec.anatomy.byTicker).length, 8, "per-name anatomy scope for every perp");
    // stocks still publishes all five groups — the gating is per-universe, not global
    assert.deepEqual(st.groups, ["positioning", "holds", "clocks", "week", "structure"], "xyz keeps every group");

    // the xyz build with a single seeded equity stays honestly pending — universes don't cross-contaminate
    assert.ok(st.sections.sessionDecomp.pending && st.sections.anatomy.pending, "xyz build independent (1 equity -> pending)");
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test("actionable -06: the CONFIRMED gate drops negative-expectancy setups instead of demoting them", () => {
  const { setupEV, netRR } = require("../src/compute");
  const fs = require("fs"), path = require("path");
  const pol = fs.readFileSync(path.join(__dirname, "..", "src", "poller.js"), "utf8");
  // The gate is a single function so there is exactly one place that decides what gets suggested.
  assert.ok(/function actConfirm\(rec, evR, rr, ev\)/.test(pol), "actConfirm gate missing");
  // thinRR left this list deliberately: freezing R:R at fire exposed that sigma-built setups
  // (target = study median vs a 1-sigma void) run 0.5-1.0x BY CONSTRUCTION, so a 2:1 gate deleted
  // that whole family the moment the ratio stopped being drift-inflated. The floor is a row CLASS
  // now — 'rr' clears it, 'ev' rides on positive expectancy — and the client's checkboxes pick
  // which families show. EV>0 stays the hard gate for both.
  assert.ok(!pol.includes('"thinRR"'), "thinRR fully retired from the gate and the tallies");
  assert.ok(pol.includes('function actClass(rr) { return rr && rr.gross >= ACT_MIN_RR ? "rr" : "ev"; }'),
    "the floor classifies instead of rejecting");
  assert.ok(pol.includes("shadow, cls: actClass(rr),"), "and every row carries its class to the client");
  for (const cond of ['return "norecord"', 'return "negexp"', 'return "negev"', 'return "noedge"'])
    assert.ok(pol.includes(cond), `gate must reject with a named reason: ${cond}`);
  // Both expectancy tests are required and they are NOT the same test. avg is retrospective (did
  // this family pay); EV is prospective on this instance (does it still pay from here).
  // Field name pinned deliberately: actRecord returns avgR, and an earlier cut of the gate read
  // rec.avg — undefined, which failed the comparison and rejected EVERY setup as negative-
  // expectancy. A silent empty board is the worst possible failure mode for this feature.
  assert.ok(/if \(!\(rec\.avgR > 0\)\) return "negexp";/.test(pol), "the gate must read rec.avgR, the field actRecord actually returns");
  assert.ok(/if \(evR == null \|\| !\(evR > 0\)\) return "negev";/.test(pol), "a negative-EV entry must be dropped even if the family's average is positive");
  assert.ok(/ACT_MIN_RR = 2\.0;/.test(pol), "the suggestion floor must be R:R 2.0");
  // Gate BEFORE merge: otherwise an unconfirmed candidate could win a name+side on a flattering
  // EV and then be rejected, silently losing a confirmed row that was behind it.
  const gi = pol.indexOf("const why = actConfirm("), mi = pol.indexOf("mergeActionable(cands)");
  assert.ok(gi > 0 && mi > 0 && gi < mi, "the gate must run before the merge");
  // Nothing is demoted to a second section — the payload is one flat list of confirmed rows.
  assert.ok(!/unproven: shadow/.test(pol), "the proven/unproven split must be gone from the row builder");
  assert.ok(/rows: board, count: board\.length/.test(pol), "payload must be one flat confirmed list");
  // The arithmetic the gate leans on, pinned directly: a losing family can still look fine on a
  // single instance's geometry, which is exactly why avg > 0 is checked separately.
  assert.ok(setupEV(0.35, 2.5, 20, 8) > 0, "a 35% hit at 2.5R models positive on this instance...");
  const rr = netRR({ side: "long", entry: 100, stop: 95, target: 115 });
  assert.equal(rr.gross, 3, "...while the geometry check stays independent of the record");
}, );

test("actionable -07: the board reads the ledger's frozen geometry and never re-derives a level", async () => {
  const { createPoller } = require("../src/poller");
  const HOUR = 3600e3, DAY = 86400e3;
  const store = { loadAll: () => new Map(), loadRegime: () => [], loadLedger: () => null,
    saveLedger: () => {}, insert: () => {}, saveRegime: () => {} };
  const p = createPoller({ dex: "xyz", store, log: () => {}, version: "test", crypto: false });
  const now = Date.now(), endH = Math.floor(now / HOUR), N = 16 * 24, hourly = [];
  for (let i = 0; i < N; i++) { const t = (endH - N + i) * HOUR, c = 100 * Math.pow(1.0005, i);
    hourly.push({ t, o: c, h: c * 1.001, l: c * 0.999, c, v: 1 }); }
  const px = hourly[N - 1].c * 1.0005, daily = [];
  for (let i = 0; i < 60; i++) { const c = px * Math.pow(1.002, i - 59);
    daily.push({ t: (Math.floor(now / DAY) - 60 + i) * DAY, c, l: c * 0.97, h: c * (i === 50 ? 1.35 : 1.002) }); }
  p.seedRowNow("TRSIG", { px, ticker: "TRSIG", uni: "xyz", vol: 1e6, funding: 0.00005, hourlyRaw: hourly, dailyRaw: daily });
  p.buildTrendNow(); await p.buildSignalsNow(); await p.buildActionableNow();
  const a = p.getActionable(true);
  // A brand-new event has no record, so it is NOT suggested — the whole point of the gate. It is
  // dropped with a named reason rather than shown with a blank expectancy.
  assert.equal(a.count, 0, "an event with no resolved fires is not suggested");
  assert.ok(Array.isArray(a.rows) && a.rows.length === 0, "the payload is one flat list, and it is empty");
  assert.equal(a.coverage.norecord, 1, "and the drop is counted against a named reason");
  assert.ok(a.coverage.openClaims >= 1, "coverage discloses how many open claims were scanned");
  assert.equal(a.params.netOfCarry, true, "the payload declares that R:R is net of carry");
  assert.equal(a.params.recMinN, 8, "and discloses the record floor");
  assert.equal(a.params.gate, "confirmed", "and names the gate it applied");
  assert.deepEqual(a.params.requires, ["n>=8", "avgR>0", "EV>0", "R:R<=20", "!noedge"], "the gate's conditions ship with the payload — the 2:1 floor left them because it no longer rejects anything, while the R:R<=20 ceiling stays: an absurd ratio is still an artifact");
  assert.equal(a.params.rrFloor, 2, "the floor ships separately, as the family boundary");
  // Nothing confirmed means nothing announced — the stream inherits the gate by construction.
  assert.equal(p.getTriggers(null, null, true).seq, 0, "an unconfirmed setup never reaches the trigger stream");
  // Swing gate is by horizon, so short-horizon events can never leak onto a swing board.
  const { EV_META } = require("../src/compute");
  for (const r of a.rows)
    assert.ok(EV_META[r.ev].horizonMs >= 3 * DAY, `sub-3d event on the swing board: ${r.ev}`);
});

test("actionable -08: geometry that is no longer tradeable is counted, and the claim survives it", async () => {
  const { createPoller } = require("../src/poller");
  const HOUR = 3600e3, DAY = 86400e3;
  const store = { loadAll: () => new Map(), loadRegime: () => [], loadLedger: () => null,
    saveLedger: () => {}, insert: () => {}, saveRegime: () => {}, saveTriggers: () => {}, loadTriggers: () => null };
  const p = createPoller({ dex: "xyz", store, log: () => {}, version: "test", crypto: false });
  const now = Date.now(), endH = Math.floor(now / HOUR), N = 16 * 24, hourly = [];
  for (let i = 0; i < N; i++) { const t = (endH - N + i) * HOUR, c = 100 * Math.pow(1.0005, i);
    hourly.push({ t, o: c, h: c * 1.001, l: c * 0.999, c, v: 1 }); }
  const px = hourly[N - 1].c * 1.0005, daily = [];
  for (let i = 0; i < 60; i++) { const c = px * Math.pow(1.002, i - 59);
    daily.push({ t: (Math.floor(now / DAY) - 60 + i) * DAY, c, l: c * 0.97, h: c * (i === 50 ? 1.35 : 1.002) }); }
  p.seedRowNow("xyz:TRSIG", { px, ticker: "TRSIG", uni: "xyz", vol: 1e6, funding: 0.00005, hourlyRaw: hourly, dailyRaw: daily });
  p.buildTrendNow(); await p.buildSignalsNow(); await p.buildActionableNow();
  const a1 = p.getActionable(true);
  assert.equal(a1.coverage.norecord, 1, "the claim is scanned and rejected on record, with geometry still intact");
  // Walk the mark down through the frozen void. netRR now returns null, so the rejection reason
  // changes from "no record" to "no tradeable geometry" — the row is gone for a different reason,
  // and which reason it was stays visible.
  const led = [...(p.trigStateNow() ? [1] : [])];
  p.seedRowNow("xyz:TRSIG", { px: px * 0.5 });
  await p.buildActionableNow();
  const a2 = p.getActionable(true);
  assert.equal(a2.count, 0, "still nothing suggested");
  assert.ok(a2.coverage.untakeable >= 1,
    "and the reason is its own counter now: a claim can be perfectly framed at fire and already dead at the live mark, which is a different fact from the frozen geometry never having made sense");
  assert.ok(a2.coverage.openClaims >= 1, "the underlying claim is still open in the ledger — the board dropped it, the record did not");
  assert.equal(a2.coverage.confirmed, 0, "confirmed count is explicit, not inferred from an empty array");
});

test("actionable -10: the gate rejects each way independently, and never silently empties the board", async () => {
  const HOUR = 3600e3, DAY = 86400e3;
  const { createPoller } = require("../src/poller");
  const COIN = "xyz:GATE";
  const mk = async (closed) => {
    const store = { loadAll: () => new Map(), loadRegime: () => [], insert: () => {}, saveRegime: () => {},
      saveLedger: () => {}, loadLedger: () => ({ ts: Date.now(), open: [], closed }),
      saveTriggers: () => {}, loadTriggers: () => null };
    const p = createPoller({ dex: "xyz", store, log: () => {}, version: "test", crypto: false });
    const now = Date.now(), endH = Math.floor(now / HOUR), N = 16 * 24, hourly = [];
    for (let i = 0; i < N; i++) { const t = (endH - N + i) * HOUR, c = 100 * Math.pow(1.0005, i);
      hourly.push({ t, o: c, h: c * 1.001, l: c * 0.999, c, v: 1 }); }
    const px = hourly[N - 1].c * 1.0005, daily = [];
    for (let i = 0; i < 60; i++) { const c = px * Math.pow(1.002, i - 59);
      daily.push({ t: (Math.floor(now / DAY) - 60 + i) * DAY, c, l: c * 0.97, h: c * (i === 50 ? 1.35 : 1.002) }); }
    p.seedRowNow(COIN, { px, ticker: "GATE", uni: "xyz", vol: 1e6, funding: 0.00005, hourlyRaw: hourly, dailyRaw: daily });
    p.hydrateLedgerNow(); p.buildTrendNow(); await p.buildSignalsNow(); await p.buildActionableNow();
    return p.getActionable(true);
  };
  const rec = (n, realized) => { const o = []; for (let i = 0; i < n; i++)
    o.push({ key: COIN + "|tretest#h" + i, coin: COIN, ticker: "GATE", ev: "tretest", status: "resolved",
      realized, t0: Date.now() - (60 + i) * DAY, tR: Date.now() - (55 + i) * DAY, psd: "long", pn: 1 }); return o; };

  // Winning record, enough of it: suggested.
  const good = await mk(rec(10, 1.4));
  assert.equal(good.count, 1, "a family with 10 resolved winners IS suggested");
  assert.equal(good.rows[0].rec.n, 10);
  assert.ok(good.rows[0].evR > 0, "and carries a positive expectancy");
  assert.ok(good.rows[0].rr.gross >= 2.0, "and clears the R:R floor");

  // Same edge, too few fires: the record cannot speak yet.
  assert.equal((await mk(rec(7, 1.4))).coverage.norecord, 1, "7 resolved fires is below the floor");
  assert.equal((await mk(rec(7, 1.4))).count, 0, "and it is dropped, not shown with a blank EV");

  // Enough fires, but the family LOST money: this is the case the first cut got wrong.
  const losing = await mk(rec(12, -0.6));
  assert.equal(losing.count, 0, "a negative-expectancy family is never suggested");
  assert.equal(losing.coverage.negexp, 1, "and the reason is named");

  // Break-even is not positive: the boundary is > 0, not >= 0.
  assert.equal((await mk(rec(12, 0))).coverage.negexp, 1, "a flat record is not an edge");

  // Coverage always accounts for every scanned claim, so an empty board can always be explained.
  for (const a of [good, await mk(rec(7, 1.4)), losing]) {
    const c = a.coverage, dropped = c.expired + c.noGeometry + (c.degenerate || 0) + (c.untakeable || 0) + c.norecord + c.negexp + c.negev + c.noedge;
    assert.equal(c.confirmed + dropped, 1, "every scanned claim is either confirmed or counted against a reason");
    assert.ok(c.openClaims >= 1, "and the open-claim count is always disclosed");
  }
});

test("buildActionable: the noGeom crash cannot return, and horizons follow the universe", async () => {
  // Regression guard for a live bug this build fixed: the reject counter was an undeclared
  // `noGeom`, so under "use strict" any open claim lacking a stamped stop or target distance threw
  // a ReferenceError straight out of the build. getActionable swallows and logs it, so the only
  // symptom was an Actionable board that went silently stale for a memo window at a time —
  // fundflip stamps a null target BY DESIGN and clears the swing floor, which is enough to trip it.
  const { createPoller } = require("../src/poller");
  const store = { loadAll: () => new Map(), loadRegime: () => [], loadLedger: () => null,
    saveLedger: () => {}, insert: () => {}, saveRegime: () => {} };
  const logs = [];
  const p = createPoller({ dex: "xyz", store, log: (m) => logs.push(m), version: "test", crypto: true });
  p.seedRowNow("xyz:ZZZ", { px: 100, ticker: "ZZZ", uni: "xyz" });
  p.openLedgerNow("xyz:ZZZ", "fundflip", { score: 1, reading: "", play: { side: "long", target: null, stop: 99 } }, 1, { sd0: 1 });
  await p.buildActionableNow();
  const a = p.getActionable(true);
  assert.equal(logs.filter((m) => /buildActionable error/.test(m)).length, 0,
    "a geometry-less claim must be COUNTED, not thrown on: " + logs.filter((m) => /buildActionable error/.test(m)).join(" | "));
  assert.equal(a.coverage.noGeometry, 1, "and it lands in the reject tally where it can be seen");
  const fs = require("fs"), path = require("path");
  const pol = fs.readFileSync(path.join(__dirname, "..", "src", "poller.js"), "utf8");
  assert.ok(!/[^.\w]noGeom\+\+/.test(pol), "the undeclared counter must never come back");
  // horizon meta follows the universe, or every crypto setup is priced against an equity clock
  assert.ok(pol.includes("const meta = evMeta(e.ev, r.uni);"), "actionable reads universe-scoped meta");
  assert.ok(pol.includes("const minHz = r.uni === \"main\" ? ACT_MIN_HZ_MAIN : ACT_MIN_HZ;"),
    "and a per-universe swing floor: at the equity 3d floor almost the whole crypto roster would be excluded and the board would ship permanently empty for a reason nobody could see");
  // the row lookup must precede the meta read, or r is undefined at the meta line
  assert.ok(pol.indexOf("const r = rows.get(e.coin);") < pol.indexOf("const meta = evMeta(e.ev, r.uni);"),
    "the row is resolved before the meta that depends on it");
});

test("crypto claim geometry: no path stamps a level the gate refuses, shadows included", () => {
  // openLedger has two ways in — the visible path reads sigEntry.play, the shadow fire sites hand
  // their stop and target distance through `extra`, which lands PAST the visible path's gate. Both
  // are covered, because "the gate exists" and "the gate cannot be bypassed" are different claims.
  const { createPoller } = require("../src/poller");
  const store = { loadAll: () => new Map(), loadRegime: () => [], loadLedger: () => null,
    saveLedger: () => {}, insert: () => {}, saveRegime: () => {} };
  const p = createPoller({ dex: "xyz", store, log: () => {}, version: "test", crypto: true });
  p.seedRowNow("MEME", { px: 0.5, ticker: "MEME", uni: "main" });
  // visible path, artifact levels: void 5000x below price, target 40x above
  const e1 = p.openLedgerNow("MEME", "breakout", { score: 5, reading: "", play: { side: "long", stop: 0.0001, target: 20 } }, 1, { sd0: 12 });
  assert.ok(e1, "the claim still OPENS — refusing the level is the degradation, refusing the claim would hide the event");
  assert.equal(e1.stp, undefined, "no artifact void stamped");
  assert.equal(e1.mv, undefined, "no artifact target distance stamped");
  assert.equal(e1.gv, 1, "and the refusal is marked for the audit — distinguishes 'this event has no void' from 'this claim's void was an artifact'");
  // shadow path, same artifact levels arriving through extra
  const e2 = p.openLedgerNow("MEME", "reclaim", { score: 0, reading: "" }, 1,
    { sd0: 12, psd: "long", pn: 1, stp: 0.0001, mv: 4000 }, 0);
  assert.ok(e2, "the shadow claim opens");
  assert.equal(e2.stp, undefined, "the shadow's artifact void is scrubbed too — extra is not a way around the gate");
  // a sane crypto claim keeps both levels
  p.seedRowNow("SOL", { px: 200, ticker: "SOL", uni: "main" });
  const e3 = p.openLedgerNow("SOL", "breakout", { score: 5, reading: "", play: { side: "long", stop: 188, target: 232 } }, 1, { sd0: 6 });
  assert.equal(e3.stp, 188, "sane void stamped");
  assert.equal(e3.mv, 16, "sane target distance stamped");
  assert.equal(e3.gv, undefined, "and nothing is marked as refused");
  // the equity rule is UNTOUCHED: a hair-thin void still stamps there
  p.seedRowNow("xyz:ACME", { px: 100, ticker: "ACME", uni: "xyz" });
  const e4 = p.openLedgerNow("xyz:ACME", "breakout", { score: 5, reading: "", play: { side: "long", stop: 99.98, target: 103 } }, 1, { sd0: 1.5 });
  assert.equal(e4.stp, 99.98, "xyz keeps the loss-side-only rule so its existing record stays comparable");
  // ...while the identical shape on crypto is refused
  p.seedRowNow("DOGE", { px: 100, ticker: "DOGE", uni: "main" });
  const e5 = p.openLedgerNow("DOGE", "breakout", { score: 5, reading: "", play: { side: "long", stop: 99.98, target: 103 } }, 1, { sd0: 1.5 });
  assert.equal(e5.stp, undefined, "the same hair-thin void is refused on crypto");
});

test("degenerate void: a stop that lands on the entry cannot reach the board, however good the ratio looks", async () => {
  // Real board row, 2026-07-27. PALLADIUM short, unwind on D1: fired 1287.40, void 1287.85,
  // target 1109.61. The void is 45 cents on a 1287 instrument — 0.035% — while the target is
  // 13.81% away, so the ratio comes out at 395:1 and setupEV turns a 60% hit rate into an
  // expectancy of +236R. Nothing about that is a trade. Risk is the denominator, and when the
  // void collapses onto the mark the ratio measures the collapse, not the setup.
  //
  // The unwind and squeeze playbooks are the structural source: their voids are a fixed fraction
  // of the 30d range (hi30 - 0.25 x range) regardless of where price actually sits in that range.
  // Reverse the levels here and the range is 1169.76-1327.22 with price at 1287.40 — 75% of the
  // way up, which is exactly where that formula puts the void. The trigger is supposed to fire
  // near the range LOWS; it fired at three-quarters, and the void landed on the entry.
  const { netRR } = require("../src/compute");
  const rr = netRR({ side: "short", entry: 1287.40, stop: 1287.85, target: 1109.61 });
  assert.ok(rr.gross > 390, `the artifact is reproducible: ${rr.gross}`);
  assert.ok(rr.riskPct < 0.04, `and it comes from a void 0.035% away, got ${rr.riskPct}%`);

  const { createPoller } = require("../src/poller");
  const store = { loadAll: () => new Map(), loadRegime: () => [], loadLedger: () => null,
    saveLedger: () => {}, insert: () => {}, saveRegime: () => {} };
  const p2 = createPoller({ dex: "xyz", store, log: () => {}, version: "test", crypto: false });
  p2.seedRowNow("xyz:PALLADIUM", { px: 1287.20, ticker: "PALLADIUM", uni: "xyz" });
  const e = p2.openLedgerNow("xyz:PALLADIUM", "unwind",
    { score: 9, reading: "", play: { side: "short", stop: 1287.85, target: 1109.61 } }, -1, { sd0: 1.2 });
  assert.ok(e && e.stp === 1287.85, "the claim itself still opens and still records — this guard is the BOARD's, not the ledger's");
  await p2.buildActionableNow();
  const a = p2.getActionable(true);
  assert.equal(a.rows.length, 0, "and it never reaches the board");
  assert.equal(a.coverage.degenerate, 1, "counted under its own reason, so an empty board can always say why");

  // the three checks are independent — each must reject on its own
  const p3 = createPoller({ dex: "xyz", store, log: () => {}, version: "test", crypto: false });
  p3.seedRowNow("xyz:AAA", { px: 100, ticker: "AAA", uni: "xyz" });
  // no sd0 stamped: the absolute 5bp floor has to carry it alone
  p3.openLedgerNow("xyz:AAA", "unwind", { score: 9, reading: "", play: { side: "short", stop: 100.02, target: 90 } }, -1, {});
  await p3.buildActionableNow();
  assert.equal(p3.getActionable(true).coverage.degenerate, 1, "a 2bp void is refused with no volatility stamp to judge it by");

  // a legitimately tight-but-real setup survives: 0.9% void on a 1.2% sigma name, ratio 3.3
  const p4 = createPoller({ dex: "xyz", store, log: () => {}, version: "test", crypto: false });
  p4.seedRowNow("xyz:BBB", { px: 100, ticker: "BBB", uni: "xyz" });
  p4.openLedgerNow("xyz:BBB", "breakout", { score: 9, reading: "", play: { side: "long", stop: 99.1, target: 103 } }, 1, { sd0: 1.2 });
  await p4.buildActionableNow();
  assert.equal(p4.getActionable(true).coverage.degenerate, 0,
    "a real void at 0.75 sigma is NOT degenerate — this guard must not become a filter on tight setups");
});

test("ledger alerts: only announced claims get a death notice, and each level fires exactly once", () => {
  const { createPoller } = require("../src/poller");
  const store = { loadAll: () => new Map(), loadRegime: () => [], loadLedger: () => null, saveLedger: () => {},
    insert: () => {}, saveRegime: () => {}, loadTriggers: () => null, saveTriggers: () => {},
    savePush: () => {}, loadPush: () => null };
  const p = createPoller({ dex: "xyz", store, log: () => {}, version: "test", crypto: false });
  p.seedRowNow("AAA", { ticker: "AAA", px: 42, uni: "xyz" });
  p.seedRowNow("BBB", { ticker: "BBB", px: 42, uni: "xyz" });
  const open = p.ledgerOpenNow();
  const mk = (coin, extra) => Object.assign({ key: coin + "|breakout", coin, ticker: coin, ev: "breakout",
    t0: Date.now() - 3600e3, mark0: 42, dir: 1, psd: "long", stp: 40, tgt: 47, resolveAt: Date.now() + 1e9 }, extra);
  open.set("AAA|breakout", mk("AAA", { alo: 1 }));    // announced
  open.set("BBB|breakout", mk("BBB"));                // never announced

  const ledgerEvents = () => p.getTriggers(0, null, true).events.filter((e) => e.kind === "ledger");

  p.seedRowNow("AAA", { px: 42 }); p.seedRowNow("BBB", { px: 42 });
  p.levelScanNow();
  assert.equal(ledgerEvents().length, 0, "a claim sitting between its levels says nothing");

  // Both breach. Only the announced one is entitled to speak.
  p.seedRowNow("AAA", { px: 39.5 }); p.seedRowNow("BBB", { px: 39.5 });
  p.levelScanNow();
  const evs = ledgerEvents();
  assert.equal(evs.length, 1, "a claim nobody was told about does not get a death notice");
  assert.equal(evs[0].coin, "AAA");
  assert.equal(evs[0].sub, "stop");
  assert.equal(evs[0].level, 40);
  assert.equal(evs[0].side, "long");
  assert.ok(evs[0].held, "how long it was open is part of the story");

  // Repeat scans must not re-announce: price stays below the void for hours.
  p.levelScanNow(); p.levelScanNow();
  assert.equal(ledgerEvents().length, 1, "the void is taken ONCE — a level that stays breached is not news every 30 seconds");
  assert.equal(open.get("AAA|breakout").als, 1, "the stamp lives on the claim, so a restart cannot re-announce it");

  // A dead claim has nothing to say about its target, even if price later runs there.
  p.seedRowNow("AAA", { px: 48 });
  p.levelScanNow();
  assert.equal(ledgerEvents().length, 1, "a stopped-out claim does not later report reaching its target");
  assert.equal(open.get("AAA|breakout").alt, 1, "the void hit retires the target in the same breath, not just for the rest of this scan");
});

test("ledger alerts: target fires independently, and the void takes precedence in one scan", () => {
  const { createPoller } = require("../src/poller");
  const store = { loadAll: () => new Map(), loadRegime: () => [], loadLedger: () => null, saveLedger: () => {},
    insert: () => {}, saveRegime: () => {}, loadTriggers: () => null, saveTriggers: () => {} };
  const p = createPoller({ dex: "xyz", store, log: () => {}, version: "test", crypto: false });
  p.seedRowNow("CCC", { ticker: "CCC", px: 42, uni: "xyz" });
  p.ledgerOpenNow().set("CCC|breakout", { key: "CCC|breakout", coin: "CCC", ticker: "CCC", ev: "breakout",
    t0: Date.now() - 7200e3, mark0: 42, dir: 1, psd: "long", stp: 40, tgt: 47, alo: 1, resolveAt: Date.now() + 1e9 });

  p.seedRowNow("CCC", { px: 47.5 });
  p.levelScanNow();
  const evs = p.getTriggers(0, null, true).events.filter((e) => e.kind === "ledger");
  assert.equal(evs.length, 1);
  assert.equal(evs[0].sub, "target");
  assert.equal(evs[0].level, 47);

  // A shadow-variant claim is internal bookkeeping and never surfaces to a transport.
  p.ledgerOpenNow().set("CCC|bigmove#1", { key: "CCC|bigmove#1", coin: "CCC", ticker: "CCC", ev: "bigmove",
    t0: Date.now(), mark0: 42, dir: 1, psd: "long", stp: 46, alo: 1, vi: 1, resolveAt: Date.now() + 1e9 });
  p.levelScanNow();
  assert.equal(p.getTriggers(0, null, true).events.filter((e) => e.kind === "ledger").length, 1,
    "shadow variants ledger silently — they must never reach an alert channel");
});

test("ledger alerts: resolution is emitted from the resolver's own close path", () => {
  const { createPoller } = require("../src/poller");
  const store = { loadAll: () => new Map(), loadRegime: () => [], loadLedger: () => null, saveLedger: () => {},
    insert: () => {}, saveRegime: () => {}, loadTriggers: () => null, saveTriggers: () => {}, archiveClosed: () => {} };
  const p = createPoller({ dex: "xyz", store, log: () => {}, version: "test", crypto: false });
  const pol = require("fs").readFileSync(require("path").join(__dirname, "..", "src", "poller.js"), "utf8");
  // Pinned structurally: emitted INSIDE the resolver, so the number in the message is the number
  // that entered the record. A separate scan over the closed list could disagree with it.
  assert.ok(/e\.status = "resolved"[\s\S]{0,700}emitLedgerEvent\(e, "resolved"/.test(pol),
    "the resolution notice must be emitted from the resolver's close path, not reconstructed later");
  assert.ok(/if \(e\.alo === 1 && e\.vi == null\) emitLedgerEvent/.test(pol),
    "only announced, non-shadow claims resolve out loud");
  assert.ok(p.resolveLedgerNow);
});

test("ledger alerts: detection is armed regardless of whether a transport is configured", () => {
  const fs = require("fs"), path = require("path");
  const pol = fs.readFileSync(path.join(__dirname, "..", "src", "poller.js"), "utf8");
  // Slice A armed the level scan and the health watchdog inside the token check, which let a
  // transport's configuration silently decide what the canonical stream was allowed to contain.
  // The scan and the watchdog must sit OUTSIDE the `if (pushOn())` block.
  const boot = pol.slice(pol.indexOf("alert detection + transports"), pol.indexOf("AI reports: ${AI_KEY()"));
  const gateAt = boot.indexOf("if (pushOn())");
  assert.ok(gateAt > 0, "the delivery gate still exists");
  const before = boot.slice(0, gateAt);
  assert.ok(before.includes("levelScan"), "the level scan is armed unconditionally");
  assert.ok(before.includes("pushHealthTick"), "the health watchdog is armed unconditionally");
  assert.ok(before.includes('pushOps("deploy"'), "the deploy notice reaches the in-app log with no bot configured");
  const after = boot.slice(gateAt);
  for (const f of ["pushUpdatesTick", "pushDrain", "pushStreamTick"])
    assert.ok(after.includes(f), `${f} is outbound and must stay behind the token gate`);
  assert.ok(!before.includes("pushDrain("), "nothing outbound may run without a token");
});

test("ledger alerts: the target level is FROZEN on the claim, not reconstructed from mv", () => {
  const fs = require("fs"), path = require("path");
  const pol = fs.readFileSync(path.join(__dirname, "..", "src", "poller.js"), "utf8");
  assert.ok(pol.includes("tgt0 != null && vi == null ? { tgt: tgt0 } : null"),
    "the absolute target is stamped at fire — mv is a rounded distance and cannot be turned back into a price");
  assert.ok(/tgt: "playbook target level frozen at fire/.test(pol), "the export glossary documents the new stamp");
  for (const k of ["alo:", "als:", "alt:"]) assert.ok(pol.includes(k), `glossary entry missing for ${k}`);
});

test("fast lane: level alerts run on the socket tick, metric rules deliberately do not", () => {
  const fs = require("fs"), path = require("path");
  const pol = fs.readFileSync(path.join(__dirname, "..", "src", "poller.js"), "utf8");
  const ws = pol.slice(pol.indexOf("function applyWsCtxs(tuples)"), pol.indexOf("function applyWsCtxs(tuples)") + 4000);
  assert.ok(/levelScan\(\)/.test(ws), "a void being taken is the one alert where 2s vs 30s changes whether you can act");
  assert.ok(!/ruleScan\(\)/.test(ws), "metric rules must NOT run here — they read the snapshot and cannot outrun it without disagreeing with it");
  assert.ok(/isolated/.test(ws.slice(ws.indexOf("levelScan()") - 200, ws.indexOf("levelScan()") + 200)),
    "the fast-lane call must be isolated — a throw here would kill the WebSocket fold");
});

test("regime + coverage are episode-gated: one alert per episode, seeded at boot", () => {
  const p = ctxHarness();
  const regs = () => p.getTriggers(0, null, true).events.filter((e) => e.kind === "regime");
  const covs = () => p.getTriggers(0, null, true).events.filter((e) => e.kind === "coverage");

  // Coverage is scoped to open ANNOUNCED claims: a gap on a name nobody is watching is a
  // maintenance item, not an interruption.
  p.seedRowNow("AAA", { ticker: "AAA", px: 10, uni: "xyz", hourlyTs: Date.now() - 4 * 3600e3 });
  p.coverageScanNow();
  assert.equal(covs().length, 0, "no claim, no coverage alert");

  p.ledgerOpenNow().set("AAA|breakout", { key: "AAA|breakout", coin: "AAA", ticker: "AAA", ev: "breakout",
    t0: Date.now(), mark0: 10, dir: 1, psd: "long", alo: 1, resolveAt: Date.now() + 1e9 });
  p.coverageScanNow();
  assert.equal(covs().length, 0, "a gap already in force at first sight is seeded, not announced");
  p.coverageScanNow();
  assert.equal(covs().length, 0, "…and it does not accumulate on repeat scans — this is a persistent condition, not an event");

  // It re-arms only once the condition genuinely lapses — and (2026.07.29-03) only after the
  // spine has been continuously fresh for a full COVERAGE_REARM_FRESH_MS window. A flap around
  // the stale line is one episode, not one alert per crossing.
  const t0 = Date.now();
  p.seedRowNow("AAA", { hourlyTs: t0 });
  p.coverageScanNow(t0);                       // fresh observed: the re-arm clock starts here…
  p.seedRowNow("AAA", { hourlyTs: t0 - 4 * 3600e3 });
  p.coverageScanNow(t0 + 60e3);
  assert.equal(covs().length, 0, "a flap (fresh for one scan, stale a minute later) does NOT re-arm — this was the many-messages failure mode");
  p.seedRowNow("AAA", { hourlyTs: t0 + 60e3 });
  p.coverageScanNow(t0 + 2 * 60e3);            // fresh again: a NEW fresh stretch, its own clock
  p.coverageScanNow(t0 + 35 * 60e3);           // …sustained past the window: re-armed
  p.seedRowNow("AAA", { hourlyTs: t0 - 4 * 3600e3 });
  p.coverageScanNow(t0 + 36 * 60e3);
  assert.equal(covs().length, 1, "a genuinely new episode (sustained-fresh, then stale) fires exactly once");
  p.coverageScanNow(t0 + 37 * 60e3); p.coverageScanNow(t0 + 38 * 60e3);
  assert.equal(covs().length, 1, "and stays quiet while it persists");
  assert.ok(/no fetch failures recorded/.test(covs()[0].text), "the alert text discloses the WHY: hFail=0 here, so it names queue/budget contention");

  const fs = require("fs"), path = require("path");
  const pol = fs.readFileSync(path.join(__dirname, "..", "src", "poller.js"), "utf8");
  assert.ok(/regimeArmed/.test(pol) && /coverageArmed/.test(pol), "both classes carry re-arm state");
  assert.ok(/in force at boot: seeded, not announced/.test(pol));
  assert.ok(regs().length >= 0);
});

// ===== Trend class, ops gating, message look, panel density (build 2026.07.27-11) ===============

test("trend metrics ride the same board the Trend tab renders, signed to cover both sides", () => {
  const C = require("../src/compute");
  const keys = C.RULE_METRICS.map((m) => m.k);
  assert.ok(keys.includes("tscore") && keys.includes("e21d"));
  // Signed so ONE metric asks the question people actually ask: abs> 3 is "strongly trending either
  // way", and > 3 is "strongly trending up". Two separate long/short metrics could not express the
  // first without a second rule.
  assert.equal(C.RULE_BY_K.tscore.get({ tscore: -4 }), -4);
  assert.equal(C.ruleEval({ metric: "tscore", op: "abs>", value: 3 }, { tscore: -4 }, true), "fire");
  assert.equal(C.ruleEval({ metric: "tscore", op: ">", value: 3 }, { tscore: -4 }, true), "hold");
  // A name the board never scored is null, not 0 — "no trend read" and "neutral" are different.
  assert.equal(C.ruleEval({ metric: "tscore", op: "<", value: 1 }, { coin: "X" }, true), null);
  assert.equal(C.RULE_BY_K.e21d.get({ e21d: -0.4 }), -0.4);

  const fs = require("fs"), path = require("path");
  const pol = fs.readFileSync(path.join(__dirname, "..", "src", "poller.js"), "utf8");
  assert.ok(/trendByCoin = new Map\(\);/.test(pol) && /trendByCoin\.get\(r\.coin\)/.test(pol),
    "the stamp must read one index built where the board is built");
  assert.ok(/\(m\.tscore == null \? "" : m\.tscore\)/.test(pol),
    "the stamp must ride the content signature, or a frozen snapshot serves a stale trend score");
});

test("trend events: close-confirmed on the closed ladder, seeded on the first pass", () => {
  const fs = require("fs"), path = require("path");
  const pol = fs.readFileSync(path.join(__dirname, "..", "src", "poller.js"), "utf8");
  const fn = pol.slice(pol.indexOf("function trendScan(tNow)"), pol.indexOf("function pushTest("));
  // H12/H4 crossings at ~144 names would be a feed, not an alert. Stated where it is decided.
  assert.ok(/D1 only/.test(pol.slice(pol.indexOf("trend class: full stacks"), pol.indexOf("const trendState"))));
  // The load-bearing change of -25: every transition is judged on the CLOSED ladder — the live
  // board read (tb) supplies sighting stamps and message dressing, never a transition. An event
  // can only come into existence at a candle close; the close IS the confirmation.
  assert.ok(/const cl = trendClosed\(coin, tb, now\);/.test(fn), "the closed ladder is the transition's only truth source");
  assert.ok(/if \(!cl\) continue;/.test(fn), "no closed read means silence, never a guess at a confirmation");
  assert.ok(/closedLadder\(\{/.test(pol) && /closedBars\(trendD1\(r, r\.dailyRaw, null, now\), DAY, now\)/.test(pol),
    "trendClosed feeds compute.closedLadder with period-trimmed series — same rung sourcing as the board");
  assert.ok(!/TREND_CROSS_CONFIRM/.test(pol),
    "the scan-count debounce is GONE — closed state cannot revert between closes, so counting scans would only add lag");
  assert.ok(/score >= 4 && prev\.score < 4/.test(fn), "only the ARRIVAL at 4/4 fires — on closed rungs");
  // The COPPER double (-16): every gate must sit ON the fire condition, not near it. Boundary
  // flap ACROSS closes is still real (H1 closes hourly), so the episode gates survive -25.
  assert.ok(/prev\.below \|\| 0\) >= TREND_REARM_SCANS/.test(fn),
    "a stack only fires after the drop HELD — a one-scan dip through 3/4 is the same episode");
  assert.ok(/now - \(prev\.stackAt \|\| 0\) >= TREND_STACK_CD/.test(fn),
    "…and never twice per name inside the cooldown, however legitimate the re-cross");
  assert.ok(/sign !== 0 && prev\.sign !== 0 && sign !== prev\.sign/.test(fn),
    "a closed D1 flip announces at its close; an unknown ribbon (sign 0) is not a flip");
  assert.ok(/\} else if \(sign !== 0\) next\.sign = sign;/.test(fn),
    "a flip out of 0 is adoption, not a flip — it confirms silently");
  assert.ok(/if \(!trendPrimed \|\| !prev \|\| !prev\.tfSt\) \{/.test(fn),
    "the first pass seeds silently — and a prev restored from a pre-close-confirm build (live-measured score, no tfSt) reseeds instead of firing against a different ruler");
  assert.ok(/below: score < 4 \? TREND_REARM_SCANS : 0/.test(fn),
    "a name seeded below 4 is armed — the hold kills re-fires of a known stack, not a new name's first arrival");
  // Every fire carries its confirming close; the sighting stamp only ships when it truly preceded it.
  assert.ok((fn.match(/confTf/g) || []).length >= 6, "confTf/confAt ride all three sub-events");
  assert.ok(/at < \+confAt \? at : undefined/.test(fn), "seenAt is disclosed only when it preceded the confirming close");
  assert.ok(/for \(const c of \[\.\.\.trendState\.keys\(\)\]\) if \(!trendByCoin\.has\(c\)\) trendState\.delete\(c\);/.test(fn),
    "a name leaving the board drops its state, so a return is a genuinely new episode");
  assert.ok(/continue;   \/\/ one event per name per scan/.test(fn));
});

test("retest confirms on its own rung's close, and carries it", () => {
  const p = trendHarness();
  const rts = () => p.getTriggers(0, null, true).events.filter((e) => e.kind === "trend" && e.sub === "retest");
  const M = 60e3, t0 = Date.UTC(2026, 6, 27, 12, 0, 0);
  const seed = (retest, liveRetest, t) => { p.seedTrendNow("CU", { side: "long", uni: "stocks", score: 3,
    retest: liveRetest, e13: 6.38, e21: 6.33, age: 2, closed: clOf(3, t, { retest }) }); p.trendScanNow(t); };
  seed(null, null, t0);                        // seeded
  seed(null, "H4", t0 + 5 * M);                // the badge flickers on the live bar mid-period
  assert.equal(rts().length, 0, "a live-bar badge is not a closed badge — nothing fires");
  seed("H4", "H4", t0 + 10 * M);               // the H4 close holds the zone — the badge is real
  assert.equal(rts().length, 1);
  assert.equal(rts()[0].confTf, "H4", "the retesting rung's own close is the confirmation");
  assert.equal(rts()[0].confAt, t0 + 10 * M - 60e3);
  assert.equal(rts()[0].seenAt, t0 + 5 * M, "the live sighting preceding the close is disclosed");
  seed("H4", "H4", t0 + 15 * M);
  assert.equal(rts().length, 1, "the badge persisting says nothing new");
});

test("trend state restored from a pre-close-confirm build reseeds silently, never fires against a different ruler", () => {
  const p = trendHarness();
  const stacks = () => p.getTriggers(0, null, true).events.filter((e) => e.kind === "trend" && e.sub === "stack").length;
  const M = 60e3, t0 = Date.UTC(2026, 6, 27, 12, 0, 0);
  // A -24 process persisted score/sign measured against the LIVE bar (plus pend fields the new
  // code ignores). Judged against closed truth those numbers are a different ruler: the only safe
  // move is one silent reseed — a boundary name must not fire a "stack arrival" on deploy.
  p.hydrateTriggersNow({ seq: 0, seen: [], events: [], episodes: { trend: [["CU", { score: 3, sign: 1, retest: null, pendSign: 0, pendRun: 0 }]] } });
  const seed = (score, t) => { p.seedTrendNow("CU", { side: "long", uni: "stocks", score, retest: null,
    e13: 6.38, e21: 6.33, age: 2, closed: clOf(score, t) }); p.trendScanNow(t); };
  seed(4, t0);
  assert.equal(stacks(), 0, "missing tfSt marks the old shape — reseeded silently, it does not throw and it does not fire");
  seed(3, t0 + 5 * M); seed(3, t0 + 10 * M); seed(3, t0 + 15 * M);
  seed(4, t0 + 20 * M);
  assert.equal(stacks(), 1, "…and three held scans later the same rise fires on the closed ladder");
});

test("claiming an unowned recipient moves it into the claiming browser's panel", () => {
  process.env.TG_BOT_TOKEN = "test-token";
  const { createPoller } = require("../src/poller");
  let saved = { ts: Date.now(), offset: 0, recipients: [
    { chat: "9990001111", name: "Milst", since: Date.now(), cur: 0, classes: null, trig: {}, muted: false }] };
  const store = { loadAll: () => new Map(), loadRegime: () => [], loadLedger: () => null, saveLedger: () => {},
    insert: () => {}, saveRegime: () => {}, loadTriggers: () => null, saveTriggers: () => {},
    savePush: (d) => { saved = d; }, loadPush: () => saved };
  const p = createPoller({ dex: "xyz", store, log: () => {}, version: "test", crypto: false });
  p.hydratePushNow();

  // A row with no owner is invisible to every browser's own panel — which is exactly the state that
  // left three linked accounts with no class chips anywhere after -11.
  assert.equal(p.getPush("own-a", false).recipients.length, 0, "unowned rows belong to no browser");
  const adminView = p.getPush("own-a", true);
  assert.equal(adminView.recipients.length, 1);
  assert.equal(adminView.recipients[0].owned, false, "…and the admin roster marks them unclaimed");
  assert.equal(adminView.recipients[0].admin, true, "a pre-ownership link keeps operator privileges");

  assert.equal(p.pushClaim("9990001111", "own-a", true).ok, true);
  const after = p.getPush("own-a", false);
  assert.equal(after.recipients.length, 1, "after claiming it appears in that browser's own panel");
  assert.equal(after.recipients[0].mine, true, "…with full controls, not read-only");
  assert.equal(p.pushClaim("9990001111", "own-c", true).error, "already-owned", "and it cannot be claimed twice");
  delete process.env.TG_BOT_TOKEN;
});

// ===== Episode persistence, retest alerts, admin editing, catalog gaps (2026.07.27-13) ==========

test("episode state survives a restart — the fix that makes trend/regime/coverage real", () => {
  process.env.TG_BOT_TOKEN = "test-token";
  const { createPoller } = require("../src/poller");
  let trigBlob = null;
  const store = { loadAll: () => new Map(), loadRegime: () => [], loadLedger: () => null, saveLedger: () => {},
    insert: () => {}, saveRegime: () => {}, loadTriggers: () => trigBlob, saveTriggers: (d) => { trigBlob = d; } };
  const mk = () => createPoller({ dex: "xyz", store, log: () => {}, version: "test", crypto: false });

  // Process 1 seeds a coverage episode (stale spine on an announced claim) and dies.
  const p1 = mk(); p1.hydrateTriggersNow && p1.hydrateTriggersNow();
  p1.seedRowNow("AAA", { ticker: "AAA", px: 10, uni: "xyz", hourlyTs: Date.now() - 4 * 3600e3 });
  p1.ledgerOpenNow().set("AAA|breakout", { key: "AAA|breakout", coin: "AAA", ticker: "AAA", ev: "breakout",
    t0: Date.now(), mark0: 10, dir: 1, psd: "long", alo: 1, resolveAt: Date.now() + 1e9 });
  p1.coverageScanNow();   // seeds (in force at first sight), persists
  assert.ok(trigBlob && trigBlob.episodes && Array.isArray(trigBlob.episodes.coverage) && trigBlob.episodes.coverage.length,
    "episode maps are persisted with the ring — this app deploys once per pushed FILE, and unpersisted seeds meant every deploy re-muted every scan");

  // Process 2 boots, restores the seed, and the STILL-stale market must not re-announce…
  const p2 = mk(); p2.hydrateTriggersNow && p2.hydrateTriggersNow();
  p2.seedRowNow("AAA", { ticker: "AAA", px: 10, uni: "xyz", hourlyTs: Date.now() - 5 * 3600e3 });
  p2.ledgerOpenNow().set("AAA|breakout", { key: "AAA|breakout", coin: "AAA", ticker: "AAA", ev: "breakout",
    t0: Date.now(), mark0: 10, dir: 1, psd: "long", alo: 1, resolveAt: Date.now() + 1e9 });
  p2.coverageScanNow();
  const covs = p2.getTriggers(0, null, true).events.filter((e) => e.kind === "coverage");
  assert.equal(covs.length, 0, "a restored seed is a seed — the restart is not a new episode");

  // …but a transition that spans the restart DOES fire: recovery in p2 — sustained past the
  // 2026.07.29-03 re-arm window, a flap is deliberately not a recovery — then stale again.
  const tR = Date.now();
  p2.seedRowNow("AAA", { hourlyTs: tR }); p2.coverageScanNow(tR);
  p2.coverageScanNow(tR + 31 * 60e3);
  p2.seedRowNow("AAA", { hourlyTs: tR - 4 * 3600e3 }); p2.coverageScanNow(tR + 32 * 60e3);
  assert.equal(p2.getTriggers(0, null, true).events.filter((e) => e.kind === "coverage").length, 1,
    "the transition fires exactly once, across as many deploys as it spans");

  const fs = require("fs"), path = require("path");
  const pol = fs.readFileSync(path.join(__dirname, "..", "src", "poller.js"), "utf8");
  assert.ok(/if \(trendState\.size\) trendPrimed = true;/.test(pol) && /if \(filingSeen\.size\) filingPrimed = true;/.test(pol),
    "restored state IS the seed — keeping the priming delay after a restore would only eat real transitions");
  delete process.env.TG_BOT_TOKEN;
});

test("retest-badge arrivals are trend events — visible before the ledger family earns its record", () => {
  const fs = require("fs"), path = require("path");
  const pol = fs.readFileSync(path.join(__dirname, "..", "src", "poller.js"), "utf8");
  const fn = pol.slice(pol.indexOf("function trendScan(tNow)"), pol.indexOf("function pushTest("));
  assert.ok(/if \(retest && !prev\.retest\)/.test(fn), "the CLOSED badge APPEARING fires; the badge persisting does not");
  assert.ok(/sub: "retest"/.test(fn));
  // The load-bearing comment: the ledger's setup alert for tretest waits on a proven record
  // (n >= 8 resolved). Until then the badge arrival is the only path a retest has to a phone,
  // which is why "trend retests are nonexistent" was true before this.
  assert.ok(/waits for the event family to prove a record/.test(fn));
  const C = require("../src/compute");
  const m = C.pushFmt({ kind: "trend", coin: "N", t: "NVDA", side: "long", sub: "retest", score: 3,
    tf: "H12", px: 120, e21: 118, title: "H12 retest of the 13/21 zone", text: "pullback into the ribbon" }, {});
  assert.ok(m.includes("H12 retest") && /^tf\s+H12$/m.test(m.slice(m.indexOf("<pre>") + 5, m.indexOf("</pre>"))));
});

test("settled -15: an episode opens at first appearance, flicker folds instead of duplicating, and the payload ships the record", async () => {
  const { p, COIN, px } = await settledPoller();
  const a = p.getActionable(true);
  assert.equal(a.count, 1, "precondition: the seeded setup confirms onto the board");
  assert.ok(a.rows[0].k && a.rows[0].k.startsWith(COIN + "|"), "board rows must carry their claim key");
  let st = p.boardEpStateNow();
  assert.equal(st.open.length, 1, "first appearance opens exactly one episode");
  assert.ok(st.since > 0, "the record stamps its own out-of-sample epoch");
  const ep = st.open[0];
  assert.equal(ep.k, a.rows[0].k);
  assert.ok(ep.markShow > 0 && ep.fired > 0 && ep.void > 0 && ep.target > 0 && ep.tShow > 0, "the show stamp freezes marks and geometry");
  assert.ok(ep.cls === "rr" || ep.cls === "ev", "the episode carries the board's own class tag (the 2+1 / grinders split)");
  // Payload shape: settled rides the actionable payload, per-universe, class-split.
  assert.ok(a.settled && a.settled.perUni && a.settled.perUni.stocks, "settled block missing from the payload");
  assert.equal(a.settled.perUni.stocks.open, 1);
  assert.equal(a.settled.perUni.stocks.all.n, 0, "nothing resolved yet — the record starts at zero, no backfill");
  // Flicker: walk the mark through the void (untakeable), rebuild, restore, rebuild — SAME episode.
  p.seedRowNow(COIN, { px: px * 0.5 }); await p.buildActionableNow();
  st = p.boardEpStateNow();
  assert.equal(st.open.length, 1, "a dropped row does not resolve or delete its episode");
  assert.ok(st.open[0].off > 0, "the drop is marked");
  p.seedRowNow(COIN, { px }); await p.buildActionableNow();
  st = p.boardEpStateNow();
  assert.equal(st.open.length, 1, "reappearance is the SAME episode — oscillation never manufactures sample size");
  assert.equal(st.open[0].flick, 1, "…and the fold is counted");
  assert.equal(st.open[0].tShow, ep.tShow, "the original show stamp stands");
  const a2 = p.getActionable(true);
  assert.equal(a2.settled.perUni.stocks.flick, 1, "the fold is disclosed on the payload");
});

test("settled -15: resolution is inherited from the claim — target touch, both-touch pessimism, and the spine-gap approx label", async () => {
  const C = require("../src/compute");
  // epResolve unit truths first: the walk, the pessimism, the honesty flag.
  const H = 3600e3, t0 = 1000 * H;
  const mkC = (i, o, h, l, c) => [t0 + i * H, o, h, l, c, 1];
  { const r = C.epResolve([mkC(1, 100, 101, 99, 100), mkC(2, 100, 111, 99.5, 110)], t0, t0 + 5 * H, "long", 95, 110);
    assert.equal(r.kind, "target"); assert.equal(r.tHit, t0 + 2 * H); }
  { const r = C.epResolve([mkC(1, 100, 112, 94, 100)], t0, t0 + 5 * H, "long", 95, 110);
    assert.equal(r.kind, "void", "a candle spanning BOTH levels scores pessimistically as the void — an unseen intrabar sequence is never scored as the win"); }
  { const r = C.epResolve([mkC(1, 100, 101, 99, 100)], t0, t0 + 5 * H, "long", 95, 110);
    assert.equal(r.kind, "expired"); assert.equal(r.approx, false); }
  { const r = C.epResolve([], t0, t0 + 5 * H, "long", 95, 110);
    assert.equal(r.kind, "expired"); assert.equal(r.approx, true, "no candles in the window: touch state unknowable, and the flag says so"); }
  { const r = C.epResolve([mkC(1, 100, 101, 89, 92)], t0, t0 + 5 * H, "short", 105, 90);
    assert.equal(r.kind, "target", "short side mirrors: target below, void above"); }
  // epScore: void is exactly -1R at ANY basis; target pays the frozen distance in the basis's risk unit.
  assert.equal(C.epScore("long", 100, 95, 110, "void", null), -1);
  assert.equal(C.epScore("long", 100, 95, 110, "target", null), 2);
  assert.equal(C.epScore("long", 102, 95, 110, "target", null), +((110 - 102) / 7).toFixed(2), "the shown-mark basis prices the same exit against its own risk");
  assert.equal(C.epScore("long", 100, 95, 110, "expired", 103), 0.6);
  assert.equal(C.epScore("short", 100, 105, 90, "expired", 97), 0.6);
  assert.equal(C.epScore("long", 100, 95, 110, "expired", null), null, "no exit price at expiry -> unscoreable, never guessed");
  // Now the machinery end-to-end: extend the spine past the show stamp with a target-touch candle,
  // close the claim, and sweep.
  const { p, COIN, px, hourly, HOUR_, endH } = await settledPoller();
  const ep = p.boardEpStateNow().open[0];
  const tgt = ep.target;
  const later = hourly.concat([{ t: (endH + 2) * HOUR_, o: px, h: tgt * 1.01, l: px * 0.999, c: tgt, v: 1 }]);
  p.seedRowNow(COIN, { px, hourlyRaw: later });
  assert.ok(p.ledgerCloseNow(ep.k, { realized: 2.1, tR: (endH + 4) * HOUR_ }), "harness close must find the open claim");
  await p.buildActionableNow();
  const st = p.boardEpStateNow();
  assert.equal(st.open.length, 0, "the resolved claim's episode leaves the open set");
  assert.equal(st.closed.length, 1, "…and enters the settled record — ON or OFF the board, once shown always scored");
  const done = st.closed[0];
  assert.equal(done.kind, "target");
  assert.ok(!done.approx, "spine covered the window — no approx label");
  assert.ok(Math.abs(done.rE - (tgt - done.fired) / Math.abs(done.fired - done.void)) < 0.02, "R@fire is the frozen distance over the frozen risk");
  assert.ok(Math.abs(done.rM - (tgt - done.markShow) / Math.abs(done.markShow - done.void)) < 0.02, "R@shown prices the same exit against the first-shown basis");
  assert.ok(done.held > 0 && done.tRes > done.tShow, "held runs from first show to the deciding touch");
  const a = p.getActionable(true);
  const u = a.settled.perUni.stocks;
  assert.equal(u.all.n, 1); assert.equal(u.all.t, 1);
  const bucket = u.cls[done.cls === "ev" ? "ev" : "rr"];
  assert.equal(bucket.n, 1, "the episode lands in its OWN class bucket — the 2+1/grinders split includes every outcome, level touches and all");
  assert.equal(u.all.hit, 1); assert.ok(u.all.avgE > 0 && u.all.avgM > 0);
  assert.ok(u.lat != null, "lateness (avg@fire - avg@shown) ships computed server-side");
});

test("settled -15: the record persists inside the ledger blob and survives a restart; the ETag moves on a resolution", async () => {
  const { p, COIN, px, hourly, saved, HOUR_, endH } = await settledPoller();
  const sig0 = p.getActionable(true).dataTs;
  const ep = p.boardEpStateNow().open[0];
  const later = hourly.concat([{ t: (endH + 2) * HOUR_, o: px, h: px * 1.001, l: ep.void * 0.99, c: ep.void, v: 1 }]);
  p.seedRowNow(COIN, { px, hourlyRaw: later });
  p.ledgerCloseNow(ep.k, { realized: -1.2, tR: (endH + 4) * HOUR_ });
  await p.buildActionableNow();
  assert.equal(p.boardEpStateNow().closed[0].kind, "void");
  assert.equal(p.boardEpStateNow().closed[0].rE, -1, "a void exit is exactly -1R");
  assert.ok(p.getActionable(true).dataTs !== sig0, "a resolution with an unchanged live board must still bust the ETag");
  p.persistLedger();
  const blob = saved[saved.length - 1];
  assert.ok(blob.board && Array.isArray(blob.board.closed) && blob.board.closed.length === 1 && blob.board.since > 0,
    "the episode log rides the ledger blob — no new storage surface");
  // Restart: a fresh poller hydrating that blob carries the record forward.
  const { createPoller } = require("../src/poller");
  const store2 = { loadAll: () => new Map(), loadRegime: () => [], insert: () => {}, saveRegime: () => {},
    saveLedger: () => {}, loadLedger: () => blob, saveTriggers: () => {}, loadTriggers: () => null };
  const p2 = createPoller({ dex: "xyz", store: store2, log: () => {}, version: "test", crypto: false });
  p2.hydrateLedgerNow();
  const st2 = p2.boardEpStateNow();
  assert.equal(st2.closed.length, 1, "resolved episodes survive the restart");
  assert.equal(st2.closed[0].kind, "void");
  assert.equal(st2.since, blob.board.since, "the out-of-sample epoch survives too — a deploy is not a reset");
  // A pre-episode blob (no `board`) hydrates exactly as before.
  const store3 = Object.assign({}, store2, { loadLedger: () => ({ ts: Date.now(), open: [], closed: [] }) });
  const p3 = createPoller({ dex: "xyz", store: store3, log: () => {}, version: "test", crypto: false });
  p3.hydrateLedgerNow();
  assert.equal(p3.boardEpStateNow().closed.length, 0);
  assert.equal(p3.boardEpStateNow().since, 0);
});

// ===== settled honesty fixes (build 2026.07.29-02) ============================================
// Born from the record's own first cohort: four correlated fundext expiries read as "100% hit"
// with no visible exit price, green lateness, and a shown stamp that was the feature's boot.
// These tests pin the corrections — hit is level-touched only, expiries split by sign at the
// SHOWN basis and carry their exit price, lateness is a red-when-positive cost computed only
// over trustworthy stamps, and correlated same-build clusters are tagged so n cannot inflate.

test("settled -02: an expiry records its exit price, splits by sign at shown, and NEVER counts as a hit", async () => {
  const { p, COIN, px, hourly, HOUR_, endH } = await settledPoller();
  const ep = p.boardEpStateNow().open[0];
  // Extend the spine past the show stamp with candles that touch NEITHER frozen level.
  const flat = hourly.concat([1, 2, 3].map((i) => ({ t: (endH + i) * HOUR_, o: px, h: px * 1.0005, l: px * 0.9995, c: px, v: 1 })));
  p.seedRowNow(COIN, { px, hourlyRaw: flat });
  assert.ok(p.ledgerCloseNow(ep.k, { realized: 0.1, tR: (endH + 3) * HOUR_ }), "harness close must find the open claim");
  await p.buildActionableNow();
  const done = p.boardEpStateNow().closed[0];
  assert.equal(done.kind, "expired");
  assert.ok(Number.isFinite(done.exitPx) && done.exitPx > 0, "the price the expiry was scored at is part of the score — recorded, not implied");
  assert.ok(Math.abs(done.exitPx - px) / px < 0.01, "exit price is the mark at horizon from the spine");
  const u = p.getActionable(true).settled.perUni.stocks;
  assert.equal(u.all.n, 1); assert.equal(u.all.x, 1);
  assert.equal(u.all.hit, null, "hit is level-touched ONLY — a record of pure expiries claims NO hit rate, never 100%");
  assert.equal((u.all.xp || 0) + (u.all.xn || 0), 1, "the expiry lands in the signed split at the SHOWN basis");
  const shipped = p.getActionable(true).settled.episodes[0];
  assert.ok(Number.isFinite(shipped.exitPx), "exitPx ships on the payload — the client renders it, never re-derives it");
});

test("settled -02: boot-stamped episodes are excluded from lateness, first-cohort blobs are repaired, clusters are tagged", async () => {
  const { createPoller } = require("../src/poller");
  const S = Date.now() - 3 * 86400e3, H_ = 3600e3;
  const mkEp = (i, o) => Object.assign({ k: "xyz:B" + i + "|fundext", coin: "xyz:B" + i, t: "B" + i, uni: "stocks",
    ev: "fundext", label: "funding extreme", cls: "rr", side: "short", tShow: S + 6 * H_, markShow: 10,
    fired: 10.5, void: 11, target: 9, rr: 3, evR: 0.4, rec: { n: 9, hit: 0.6 }, tFire: S + 5 * H_,
    flick: 0, tRes: S + 20 * H_, kind: "expired", exitPx: 9.9, rE: 1.2, rM: 0.1, held: 14 * H_ }, o || {});
  const closed = [
    // first-cohort shape: stamped ON the epoch, claim fired 12h earlier — must be retro-marked bt
    mkEp(1, { tShow: S, tFire: S - 12 * H_ }),
    // trustworthy stamp — the ONLY episode the lateness number may use
    mkEp(2, {}),
    // correlated pair: same family, same side, same tShow — one condition, tagged, still counted
    mkEp(3, { tShow: S + 9 * H_ }), mkEp(4, { tShow: S + 9 * H_ }),
  ];
  const blob = { ts: Date.now(), open: [], closed: [], board: { since: S, dropped: 0, open: [], closed } };
  const store = { loadAll: () => new Map(), loadRegime: () => [], insert: () => {}, saveRegime: () => {},
    saveLedger: () => {}, loadLedger: () => blob, saveTriggers: () => {}, loadTriggers: () => null };
  const p = createPoller({ dex: "xyz", store, log: () => {}, version: "test", crypto: false });
  p.hydrateLedgerNow();
  const st = p.boardEpStateNow();
  assert.equal(st.closed.find((e) => e.k.includes("B1")).bt, 1, "first-cohort repair: tShow === epoch with a long-fired claim is retro-stamped bt");
  assert.ok(!st.closed.find((e) => e.k.includes("B2")).bt, "an episode stamped after the epoch keeps its trustworthy stamp");
  await p.buildActionableNow();
  const s = p.getActionable(true).settled, u = s.perUni.stocks;
  assert.equal(u.btN, 1, "the excluded boot-stamped count is disclosed");
  assert.equal(u.latN, 3, "lateness runs over the trustworthy stamps only");
  assert.ok(Math.abs(u.lat - 1.1) < 0.01, "lat = avg(rE - rM) over non-bt episodes — the bt artifact never inflates the cost");
  assert.equal(u.clus, 1, "the same-build same-family pair is one correlated cluster");
  const cors = s.episodes.filter((e) => e.cor === 2).map((e) => e.k).sort();
  assert.deepEqual(cors, ["xyz:B3|fundext", "xyz:B4|fundext"], "each clustered episode ships its cluster size; the others ship untagged");
  // Aggregate honesty on this fixture: four expiries, zero level touches.
  assert.equal(u.all.hit, null); assert.equal(u.all.x, 4); assert.equal(u.all.xp, 4);
});

test("settled -02: server invariants — bt stamping window, shown-basis pf, and the exit price on the sweep", () => {
  const fs = require("fs"), path = require("path");
  const pol = fs.readFileSync(path.join(__dirname, "..", "src", "poller.js"), "utf8");
  assert.ok(/BOARD_EP_BT_MS = 30 \* 60 \* 1000/.test(pol), "the bt window is one pinned constant");
  assert.ok(pol.includes("if (boardEpBoot && Number.isFinite(rw.t0) && now - rw.t0 > BOARD_EP_BT_MS) nu.bt = 1;"),
    "bt stamps only on the first scan, only for claims fired before the window — a fresh fire on the boot build stays trustworthy");
  assert.ok(pol.includes("boardEpBoot = false;"), "the boot flag clears after one scan");
  assert.ok(pol.includes("b.hit = (b.t + b.v) ? +(b.t / (b.t + b.v)).toFixed(3) : null;"), "hit is level-touched only, server-side");
  assert.ok(pol.includes("if (e.rM > 0) b._gw += e.rM; else b._gl += -e.rM;"), "profit factor prices the SHOWN basis");
  assert.ok(pol.includes('done.exitPx = sig(exitPx, 9)'), "the sweep records the expiry's exit mark on the episode");
  assert.ok(pol.includes("first-cohort episode(s) retro-stamped bt"), "hydrate repairs the first cohort, logged");
});

test("swing -20: resolver end-to-end — early target touch, stop-out, still-live, timeout MTM", async () => {
  const { createPoller } = require("../src/poller");
  const now = Date.now(), H = 3600e3, DAY_ = 86400e3;
  const mk = (coin, extra) => Object.assign({ key: coin + "|swpull#0", coin, ticker: coin, ev: "swpull",
    t0: now - 6 * DAY_, mark0: 100, dir: 1, score0: 0, sd0: 2, psd: "long", pn: 1,
    stp: 97, tgt: 106, tm: 1, vi: 0, resolveAt: now + 24 * DAY_ }, extra || {});
  const fixture = { ts: now, rearm: [], variants: null, closed: [],
    open: [mk("xyz:TGT"), mk("xyz:STP"), mk("xyz:LIVE"), mk("xyz:MTM", { resolveAt: now - DAY_ })] };
  const store = { loadAll: () => new Map(), loadRegime: () => [], loadLedger: () => fixture,
    saveLedger: () => {}, insert: () => {}, saveRegime: () => {} };
  const p = createPoller({ dex: "xyz", store, log: () => {}, version: "test", crypto: false });
  p.hydrateLedgerNow();
  // spines: 160h of hourly bars; shape(h) returns [px, hi, lo] for the bar h hours ago
  const spine = (shape) => { const hs = []; for (let i = 160; i >= 0; i--) {
    const [px, hi, lo] = shape(i); hs.push({ t: now - i * H, o: px, h: hi, l: lo, c: px, v: 1 }); } return hs; };
  const flat = (i) => [101, 101.4, 100.6];                                        // touches nothing, ever
  p.seedRowNow("xyz:TGT",  { px: 105, hourlyTs: now, hourlyRaw: spine((i) => i === 50 ? [105.5, 106.3, 104.8] : [100, 100.4, 99.6]) });
  p.seedRowNow("xyz:STP",  { px: 100, hourlyTs: now, hourlyRaw: spine((i) => i === 70 ? [97.5, 100.1, 96.8] : [100, 100.3, 99.7]) });
  p.seedRowNow("xyz:LIVE", { px: 101, hourlyTs: now, hourlyRaw: spine(flat) });
  p.seedRowNow("xyz:MTM",  { px: 101, hourlyTs: now, hourlyRaw: spine(flat) });
  await p.buildSignalsNow();
  const x = p.getLedgerExport(true);
  const done = Object.fromEntries(x.closed.filter((e) => e.ev === "swpull").map((e) => [e.coin, e]));
  const open = Object.fromEntries(x.open.filter((e) => e.ev === "swpull").map((e) => [e.coin, e]));
  // TGT: resolved EARLY (resolveAt is 24d away), at the target, in R, tracks coinciding
  assert.ok(done["xyz:TGT"] && done["xyz:TGT"].status === "resolved", "target claim resolved 24d before its timeout");
  assert.equal(done["xyz:TGT"].rb, "t", "bracket outcome: target first");
  assert.ok(Math.abs(done["xyz:TGT"].realized - 3) < 0.15, `resolved AT the frozen target: (106/100-1)/sigma2 = 3R, got ${done["xyz:TGT"].realized}`);
  assert.equal(done["xyz:TGT"].stopped, false, "not stopped");
  assert.ok(Math.abs(done["xyz:TGT"].realizedB - done["xyz:TGT"].realized) < 1e-9, "touch claims: bracket === realized by construction");
  // STP: resolved early at the void, negative, stopped
  assert.ok(done["xyz:STP"] && done["xyz:STP"].rb === "s" && done["xyz:STP"].stopped === true, "void first-touch");
  assert.ok(Math.abs(done["xyz:STP"].realized - (-1.5)) < 0.15, `resolved AT the frozen void: (97/100-1)/sigma2 = -1.5R, got ${done["xyz:STP"].realized}`);
  // LIVE: nothing touched, timeout far away -> still open, scanned but untouched
  assert.ok(open["xyz:LIVE"] && !done["xyz:LIVE"], "untouched claim with a live timeout stays open");
  // MTM: nothing touched, timeout passed -> at-horizon mark, the honest 'went nowhere'
  assert.ok(done["xyz:MTM"] && done["xyz:MTM"].rb === "m", "timeout resolves mark-to-market");
  assert.ok(Math.abs(done["xyz:MTM"].realized) < 0.2, `flat tape MTM outcome ~0R, got ${done["xyz:MTM"].realized}`);
});

test("swing -20: the symmetric bracket track exposes the old one-sided bias on fixed-horizon claims", async () => {
  const { createPoller } = require("../src/poller");
  const now = Date.now(), H = 3600e3, DAY_ = 86400e3;
  // a NON-touch claim (reclaim, 5d convention) carrying both frozen levels: price rides through
  // the target mid-window and gives most of it back by horizon. The at-horizon leg books the
  // fade; the bracket leg books the touch — the exact bias the old record carried.
  const fixture = { ts: now, rearm: [], variants: null, closed: [],
    open: [{ key: "xyz:BIAS|reclaim#0", coin: "xyz:BIAS", ticker: "xyz:BIAS", ev: "reclaim",
      t0: now - 6 * DAY_, mark0: 100, dir: 1, score0: 0, sd0: 2, psd: "long", pn: 1,
      stp: 95, tgt: 103, vi: 0, resolveAt: now - DAY_ }] };
  const store = { loadAll: () => new Map(), loadRegime: () => [], loadLedger: () => fixture,
    saveLedger: () => {}, insert: () => {}, saveRegime: () => {} };
  const p = createPoller({ dex: "xyz", store, log: () => {}, version: "test", crypto: false });
  p.hydrateLedgerNow();
  const hs = []; for (let i = 160; i >= 0; i--) {
    let px = 100, hi = 100.4, lo = 99.6;
    if (i <= 80 && i > 60) { px = 103.5; hi = 104.2; lo = 102.8; }      // the ride through 103
    if (i <= 60) { px = 100.5; hi = 100.9; lo = 100.1; }                // the fade into horizon
    hs.push({ t: now - i * H, o: px, h: hi, l: lo, c: px, v: 1 });
  }
  p.seedRowNow("xyz:BIAS", { px: 100.5, hourlyTs: now, hourlyRaw: hs });
  await p.buildSignalsNow();
  const e = p.getLedgerExport(true).closed.find((k) => k.coin === "xyz:BIAS");
  assert.ok(e && e.status === "resolved", "claim resolved at its fixed horizon as always");
  assert.equal(e.rb, "t", "bracket walk saw the target touched first");
  assert.ok(Math.abs(e.realized - 0.25) < 0.15, `at-horizon leg books the fade (~0.25R), got ${e.realized}`);
  assert.ok(Math.abs(e.realizedB - 1.5) < 0.15, `bracket leg books the touch ((103/100-1)/sigma2 = 1.5R), got ${e.realizedB}`);
  assert.ok(e.realizedB > e.realized, "the symmetric track recovers what the one-sided cap threw away");
  assert.equal(e.stopped, false, "void never touched — the stop-aware leg still coincides with at-horizon");
});

test("levels -22: poller end-to-end — profile rides the chart payload, memo holds, dex caveat flagged", () => {
  const { createPoller } = require("../src/poller");
  const now = Date.now(), DAY_ = 86400e3, H = 3600e3;
  const store = { loadAll: () => new Map(), loadRegime: () => [], loadLedger: () => null,
    saveLedger: () => {}, insert: () => {}, saveRegime: () => {} };
  const p = createPoller({ dex: "xyz", store, log: () => {}, version: "test", crypto: false });
  const dailyRaw = []; for (let i = 90; i >= 1; i--) dailyRaw.push({ t: now - i * DAY_, c: 100 + (i % 7), h: 101 + (i % 7), v: 1000 + (i % 3) * 200 });
  const hourlyRaw = []; for (let i = 200; i >= 0; i--) { const c = 100 + (i % 5); hourlyRaw.push({ t: now - i * H, o: c, h: c + 0.5, l: c - 0.5, c, v: 12 }); }
  p.seedRowNow("xyz:VPX", { px: 103, dailyRaw, hourlyRaw, hourlyTs: now });
  const d = p.getTfCandles("xyz:VPX", "1d");
  assert.ok(d && d.vp && Array.isArray(d.vp.bins) && d.vp.bins.length >= 8, "volume profile ships with the chart payload");
  assert.equal(d.dexVol, true, "xyz payload carries the dex-volume caveat flag");
  assert.ok(d.vp.poc > 99 && d.vp.poc < 108, `POC inside the traded range, got ${d.vp.poc}`);
  const d2 = p.getTfCandles("xyz:VPX", "4h");
  assert.ok(d2.vp && d2.vp.poc === d.vp.poc, "same memoized profile object across tf calls — histogram and map cannot disagree");
});

test("ema200 -26: end-to-end through the analytics build — the section publishes off seeded rows", async () => {
  const { createPoller } = require("../src/poller");
  const now = Date.now(), DAY_ = 86400e3, H = 3600e3;
  const store = { loadAll: () => new Map(), loadRegime: () => [], loadLedger: () => null,
    saveLedger: () => {}, insert: () => {}, saveRegime: () => {} };
  const p = createPoller({ dex: "xyz", store, log: () => {}, version: "test", crypto: false });
  // six names, each with 320d of dailies crossing the EMA once and 200 spine hours (H4 stays
  // thin on purpose — the D1 lane alone must be able to publish)
  // real equity tickers: the stocks universe's studyEligible gates on assetClass === "Equity"
  const TKS = ["AAPL", "MSFT", "NVDA", "AMZN", "META", "GOOG"];
  for (let m = 0; m < 6; m++) {
    const coin = "xyz:" + TKS[m], dailyRaw = [], hourlyRaw = [];
    // 400 UTC days ≈ 275 US sessions: the D1 lane walks the SESSION view (-105) and needs 226
    for (let i = 400; i >= 1; i--) {
      const j = 400 - i;
      const c = j < 340 ? 100 - j * 0.03 + m * 0.1 : (89.8 + m * 0.1) + (j - 340) * 0.4;
      dailyRaw.push({ t: now - i * DAY_, c, h: c + 0.5, v: 500 });
    }
    for (let i = 200; i >= 0; i--) { const c = 110 + (i % 3); hourlyRaw.push({ t: now - i * H, o: c, h: c + 0.4, l: c - 0.4, c, v: 5 }); }
    p.seedRowNow(coin, { ticker: TKS[m], px: 112, dailyRaw, hourlyRaw, hourlyTs: now });
  }
  const a = await p.buildAnalyticsNow();
  const em = a && a.sections && a.sections.ema200;
  assert.ok(em && !em.pending, `section published (got ${JSON.stringify(em && em.pending)})`);
  const d1 = em.tf["1d"];
  assert.ok(d1 && d1.contributing >= 5 && d1.n >= 5, `>=5 names contributed D1 cross events (n=${d1 && d1.n})`);
  assert.ok(d1.cross.up.raw && d1.cross.up.raw.n >= 5, "the up-cross every tape carried was detected per name");
  assert.ok(d1.retest && d1.retest.n > 0, "the retest audit accrued events through the injectable loop");
  assert.equal(em.horizons["1d"], 14, "D1 horizon rides the agreed 14 bars");
  assert.equal(em.horizons["4h"], 84, "H4 horizon rides 84 bars (14 sessions of six H4 bars)");
});

test("ema200 shadows -28: EV_META convention, wiring manifest, panel rows, closed-bar trim", () => {
  const C = require("../src/compute");
  const DAY_ = 86400e3;
  for (const ev of ["emabrk", "emarts"]) {
    assert.equal(C.EV_META[ev].resolve, "touch", `${ev} resolves by first touch`);
    assert.equal(C.EV_META[ev].horizonMs, 30 * DAY_, `${ev} 30d equity timeout`);
  }
  const fs = require("fs"), path = require("path");
  const cmp = fs.readFileSync(path.join(__dirname, "..", "src", "compute.js"), "utf8");
  for (const pin of [
    'emabrk:   { horizonMs: 15 * DAY,  horizon: "first touch of target/void within 15d, off the buffered EMA200 close-cross" },',
    'emarts:   { horizonMs: 15 * DAY,  horizon: "first touch of target/void within 15d, off the held EMA200 retest" },',
  ]) assert.ok(cmp.includes(pin), `EV_META_MAIN override pin missing: ${pin}`);
  for (const f of ["detectEmaBreak", "detectEmaRetest"])
    assert.equal((cmp.match(new RegExp("^function " + f + "\\(", "mg")) || []).length, 1, `exactly one ${f} definition`);
  const pol = fs.readFileSync(path.join(__dirname, "..", "src", "poller.js"), "utf8");
  for (const pin of [
    'openLedger(r, "emabrk"', 'openLedger(r, "emarts"',
    "stp: eb.stop, tgt: eb.target, tm: 1",                        // touch mode + frozen absolute levels
    "stp: er.stop, tgt: er.target, tm: 1",
    "const ccl = closes.length && +closes[closes.length - 1][0] + DAY > nowD ? closes.slice(0, -1) : closes;",   // the forming day never reaches the detector
    "detectEmaRetest(closedBars(sessDailyBars(r), DAY, nowD), r.px, sd30, lvlBars)",                          // true lows for the touch, forming day trimmed
    '"emabrk", "emarts",',                                        // MAIN_EVS: crypto fires these too
    'ev: "emabrk", uni: "both"', 'ev: "emarts", uni: "both"',     // shadow panel rows, both universes
  ]) assert.ok(pol.includes(pin), `poller.js missing -28 pin: ${pin}`);
});

test("ema200 shadows -28: end-to-end — the breakout fires as an invisible touch-mode claim with frozen geometry", async () => {
  const { createPoller } = require("../src/poller");
  const now = Date.now(), DAY_ = 86400e3, H = 3600e3;
  const store = { loadAll: () => new Map(), loadRegime: () => [], loadLedger: () => null,
    saveLedger: () => {}, insert: () => {}, saveRegime: () => {} };
  const p = createPoller({ dex: "xyz", store, log: () => {}, version: "test", crypto: false });
  // dailies: ~100 flat for the EMA anchor, four closes below, then the buffered cross — all
  // CLOSED (t + DAY <= now); pivot highs at 118 give the structural target. Two pivots, k=3.
  // (-105) the signal loop reads SESSION bars, so the fixture is laid on US trading days only
  // (the fold is then the identity and the cross sits exactly where the fixture puts it,
  // whatever weekday the suite runs on)
  const off = C.sessOffFn("US"), sDays = [];
  for (let d = Math.floor((now - H) / DAY_) - 1; sDays.length < 302; d--) if (!off(d)) sDays.unshift(d);
  const dailyRaw = [];
  const nD = 302;
  for (let i = 0; i < nD; i++) {
    const t = sDays[i] * DAY_;   // every bar closed (its day has ended)
    let c = 100, h = 100.4;
    if (i === 60 || i === 90) h = 118;
    if (i >= nD - 5 && i < nD - 1) { c = 98; h = 98.4; }
    if (i === nD - 1) { c = 104; h = 104.4; }
    dailyRaw.push({ t, c, h, v: 500 });
  }
  const hourlyRaw = [];
  for (let i = 200; i >= 0; i--) { const c = 104 + (i % 3) * 0.1; hourlyRaw.push({ t: now - i * H, o: c, h: c + 0.3, l: c - 0.3, c, v: 5 }); }
  p.seedRowNow("xyz:EMB", { ticker: "EMB", px: 104.5, dailyRaw, hourlyRaw, hourlyTs: now });
  p.buildDailyNow();
  await p.buildSignalsNow();
  const x = p.getLedgerExport(true);
  const e = x.open.find((k) => k.coin === "xyz:EMB" && k.ev === "emabrk");
  assert.ok(e, "the breakout shadow opened");
  assert.equal(e.vi, 0, "invisible — a shadow earning its record, never a live signal");
  assert.equal(e.tm, 1, "touch-mode claim");
  assert.ok(e.stp > 0 && e.tgt > 0 && e.stp < e.mark0 && e.mark0 < e.tgt, `frozen bracket around the mark (${e.stp} < ${e.mark0} < ${e.tgt})`);
  assert.ok(Math.abs(e.tgt - 118) < 1.5, `target is the structural level, got ${e.tgt}`);
  assert.equal(e.psd, "long", "long side only at stage two");
});

test("ema200 shadows -28: crypto depth regression — a main-universe row's detectors see all 370d, not the wire's 94", async () => {
  // The bug this pins: dc.daily (the /api/daily payload) was also the signal loop's input, and
  // the -20 wire cap silently starved every crypto detector needing >92 closes. This builds a
  // crypto poller, seeds a 300d spine-backed daily series with an armed EMA200 cross, and
  // requires the shadow to OPEN — which is only possible if the loop read past the cap.
  const { createPoller } = require("../src/poller");
  const now = Date.now(), DAY_ = 86400e3, H = 3600e3;
  const store = { loadAll: () => new Map(), loadRegime: () => [], loadLedger: () => null,
    saveLedger: () => {}, insert: () => {}, saveRegime: () => {} };
  const p = createPoller({ dex: "xyz", store, log: () => {}, version: "test", crypto: true });
  const nD = 302, dailyRaw = [];
  for (let i = 0; i < nD; i++) {
    const t = now - (nD - i) * DAY_ - H;
    let c = 100, h = 100.4;
    if (i === 60 || i === 90) h = 118;
    if (i >= nD - 5 && i < nD - 1) { c = 98; h = 98.4; }
    if (i === nD - 1) { c = 104; h = 104.4; }
    dailyRaw.push({ t, c, h, v: 500 });
  }
  const hourlyRaw = [];
  for (let i = 220; i >= 0; i--) { const c = 104 + (i % 3) * 0.1; hourlyRaw.push({ t: now - i * H, o: c, h: c + 0.3, l: c - 0.3, c, v: 5 }); }
  p.seedRowNow("MAINEMA", { uni: "main", ticker: "MAINEMA", px: 104.5, dailyRaw, hourlyRaw, hourlyTs: now });
  p.buildDailyNow();
  await p.buildSignalsNow();
  const x = p.getLedgerExport(true);
  const e = x.open.find((k) => k.coin === "MAINEMA" && k.ev === "emabrk");
  assert.ok(e, "the crypto breakout shadow opened — the loop read full depth past the wire cap");
  // and the wire itself must STILL be capped — the fix must not have bloated the payload
  const d = p.getDaily();
  const wired = d && d.daily && d.daily["MAINEMA"];
  assert.ok(Array.isArray(wired) && wired.length <= 94, `wire payload stays capped (got ${wired && wired.length})`);
  // the crypto claim rides the compressed clock: 15d touch timeout, not the equity 30d
  assert.ok(e.resolveAt - e.t0 <= 15.5 * DAY_, "crypto emabrk timeout rides the 15d EV_META_MAIN override");
});

// ================================================================================================
// post-resolution disclosure (build 2026.07.27-31): a signal whose episode already scored used to
// render "now —" — technically honest, practically a hole, because the ledger HOLDS the answer.
// The re-arm-parked signal now ships its resolution stub, the client says "scored +x.xR" instead
// of nothing, and the ★ prime emphasis is withdrawn from what is, trade-wise, a corpse.
// ================================================================================================

test("postres -31: a re-arm-parked signal ships its resolution stub, loses prime, and re-claims only after a genuine lapse", async () => {
  const { createPoller } = require("../src/poller");
  const DAY_ = 86400e3, HOUR_ = 3600e3, now = Date.now();
  // The resolved claim that parked the key, exactly as the resolver would have left it.
  const fixture = { ts: now, rearm: ["xyz:NVDA|bigmove"], variants: null,
    open: [],
    closed: [
      { key: "xyz:NVDA|bigmove", coin: "xyz:NVDA", ticker: "NVDA", ev: "bigmove", t0: now - 3 * DAY_,
        tR: now - 6 * HOUR_, mark0: 100, dir: 1, sd0: 2, psd: "long", pn: 1, rn: 1,
        status: "resolved", realized: 1.3, realizedS: 1.3, win: true, winS: true },
      // an OLDER episode of the same key — resolution TIME must pick the newer one
      { key: "xyz:NVDA|bigmove", coin: "xyz:NVDA", ticker: "NVDA", ev: "bigmove", t0: now - 30 * DAY_,
        tR: now - 27 * DAY_, mark0: 80, dir: 1, sd0: 2, psd: "long", pn: 1, rn: 1,
        status: "resolved", realized: -0.7, realizedS: -0.7, win: false, winS: false },
    ] };
  const store = { loadAll: () => new Map(), loadRegime: () => [], loadLedger: () => fixture,
    saveLedger: () => {}, insert: () => {}, saveRegime: () => {}, saveNews: () => {}, loadNews: () => null };
  const p = createPoller({ dex: "xyz", store, log: () => {}, version: "test", crypto: false });
  p.hydrateLedgerNow();
  const mkD = () => { const d = []; for (let i = 61; i >= 1; i--) d.push({ t: now - i * DAY_, c: 100 * Math.pow(1.0005, 61 - i), o: 100, h: 103, l: 98, v: 1e6 }); return d; };
  const mkH = () => { const h = []; for (let i = 400; i >= 0; i--) { const c = 100 + Math.sin(i / 9); h.push({ t: now - i * HOUR_, o: c, h: c + 0.7, l: c - 0.7, c, v: 1e5 }); } return h; };
  const fire = async () => { p.seedRowNow("xyz:NVDA", { px: 112, ticker: "NVDA", uni: "xyz", vol: 1e7,
    dailyRaw: mkD(), hourlyRaw: mkH(), dailyTs: now, hourlyTs: now, isNew: false, prevDay: 100, d1: 12 });
    p.buildDailyNow(); await p.buildSignalsNow(); };
  await fire();
  const g1 = (p.getSignals(true).signals || []).find((g) => g.coin === "xyz:NVDA" && g.ev === "bigmove");
  assert.ok(g1, "the bigmove condition fires on the seeded tape");
  assert.ok(!g1.claim0, "the re-arm gate refuses a serial re-claim, so no open claim ships");
  assert.equal((p.getLedgerFor("xyz:NVDA", null, true).open || []).filter((e) => e.ev === "bigmove").length, 0,
    "…and the ledger really holds no open bigmove claim");
  assert.equal(g1.postres, true, "the signal is stamped post-resolution");
  assert.ok(g1.scored, "the resolution stub ships instead of nothing");
  assert.equal(g1.scored.realized, 1.3, "the NEWER episode's outcome — chosen by resolution time, never by array position");
  assert.equal(g1.scored.unit, "R", "outcome carries its unit");
  assert.equal(g1.scored.voided, false);
  assert.equal(g1.scored.tR, now - 6 * HOUR_, "the resolution time ships for the 'ago' readout");
  assert.ok(!g1.prime, "★ prime is withdrawn on a scored episode — the badge may not invite entry into a banked claim");
  // the ETag signature must distinguish claim-backed from post-resolution at the same score
  const fs = require("fs"), path = require("path");
  const pol = fs.readFileSync(path.join(__dirname, "..", "src", "poller.js"), "utf8");
  assert.ok(pol.includes('(g.claim0 ? "c" + g.claim0.t : g.postres ? "p" : "")'),
    "the signals ETag carries claim/postres state — a claim resolving into the stub busts the cache even at an unchanged score");
  assert.ok(/if \(g\.prime\) \{ g\.prime = false; g\.score = Math\.max\(0, g\.score - 6\); \}/.test(pol),
    "prime withdrawal also returns the +6 emphasis bonus it granted");
  assert.ok(pol.includes("if (g.postres && g.scored) it.episodeScored ="),
    "the AI report context states the episode outcome — the model must not read a claimless live condition as 'not yet claimed'");
  // lapse: the condition clears for a build → the key re-arms
  p.seedRowNow("xyz:NVDA", { px: 100, ticker: "NVDA", uni: "xyz", vol: 1e7,
    dailyRaw: (() => { const d = []; for (let i = 61; i >= 1; i--) d.push({ t: now - i * DAY_, c: 100, o: 100, h: 100.5, l: 99.5, v: 1e6 }); return d; })(),
    hourlyRaw: mkH(), dailyTs: now, hourlyTs: now, isNew: false, prevDay: 100, d1: 0 });
  p.buildDailyNow(); await p.buildSignalsNow();
  assert.ok(!(p.getSignals(true).signals || []).some((g) => g.coin === "xyz:NVDA" && g.ev === "bigmove"),
    "flat tape: the condition genuinely lapses");
  // refire: a genuinely new episode opens a FRESH claim and the stub is gone
  await fire();
  const g2 = (p.getSignals(true).signals || []).find((g) => g.coin === "xyz:NVDA" && g.ev === "bigmove");
  assert.ok(g2, "the new episode fires");
  assert.ok(g2.claim0, "…and opens a fresh claim — the gate parks episodes, it does not retire the event");
  assert.ok(!g2.scored && !g2.postres, "the resolution stub belongs to the parked episode only, never to a live claim");
});

test("structural void -01: EV_META convention, wiring manifest, panel rows, duel isolation pins", () => {
  const C = require("../src/compute");
  const DAY_ = 86400e3;
  for (const ev of ["lvlhold", "lvlrej"]) {
    assert.equal(C.EV_META[ev].resolve, "touch", `${ev} resolves by first touch`);
    assert.equal(C.EV_META[ev].horizonMs, 30 * DAY_, `${ev} 30d equity timeout`);
    assert.equal(C.evMeta(ev, "main").horizonMs, 15 * DAY_, `${ev} runs the compressed crypto clock`);
  }
  // the twins ride the incumbents' EXACT clock — a twin on a different horizon is not a duel
  for (const [tw, inc] of [["unwind2", "unwind"], ["squeeze2", "squeeze"]]) {
    assert.equal(C.EV_META[tw].horizonMs, C.EV_META[inc].horizonMs, `${tw} must resolve on ${inc}'s clock`);
    assert.ok(!C.EV_META[tw].resolve, `${tw} is at-horizon like its incumbent, never touch-mode`);
  }
  for (const f of ["detectLvlTouch", "structVoid", "nearestLevelBelow"])
    assert.equal((require("fs").readFileSync(require("path").join(__dirname, "..", "src", "compute.js"), "utf8")
      .match(new RegExp("^function " + f + "\\(", "mg")) || []).length, 1, `exactly one ${f} definition`);
  const fs = require("fs"), path = require("path");
  const pol = fs.readFileSync(path.join(__dirname, "..", "src", "poller.js"), "utf8");
  for (const pin of [
    'openLedger(r, "lvlhold"', 'openLedger(r, "lvlrej"',
    "stp: lhT.stop, tgt: lhT.target, tm: 1",                     // touch mode + frozen absolute levels
    "stp: lrT.stop, tgt: lrT.target, tm: 1",
    "lvn: lhT.n, lva: lhT.ageD", "lvn: lrT.n, lva: lrT.ageD",    // cluster features recorded, not gated
    "const cdbT = closedBars(mergedDailyBars(r), DAY, nowD);",   // true highs/lows, forming day trimmed
    '"lvlhold", "lvlrej",',                                      // MAIN_EVS: crypto fires these too
    '"squeeze", "unwind", "squeeze2", "unwind2"]);',             // twins stay xyz-only with their incumbents
    'ev: "lvlhold", uni: "both"', 'ev: "lvlrej", uni: "both"',   // shadow panel rows
    'ev: "squeeze2", uni: "xyz"', 'ev: "unwind2", uni: "xyz"',
    'lvn: "structural-void families',                            // export glossary documents the stamps
    'lva: "structural-void families',
  ]) assert.ok(pol.includes(pin), `poller.js missing 07.28-01 pin: ${pin}`);
  // Duel isolation, pinned at the fire sites: the twins read the incumbent play's target
  // VERBATIM and open only inside the incumbent's own visible-fire branch. Recomputing a target
  // here would quietly turn a one-variable experiment into a two-variable one.
  assert.ok(pol.includes('const sv = structVoid(closedBars(mergedDailyBars(r), DAY, now), r.px, sd30, "long");'),
    "squeeze2 derives its void from merged closed bars at the fire");
  assert.ok(pol.includes('const sv = structVoid(closedBars(mergedDailyBars(r), DAY, now), r.px, sd30, "short");'),
    "unwind2 likewise");
  assert.ok(pol.includes("Number.isFinite(sig.play.target) && sig.play.target > r.px ? sig.play.target : null"),
    "squeeze2's target IS the incumbent's play target, read verbatim");
  assert.ok(pol.includes("sig.play.target > 0 && sig.play.target < r.px ? sig.play.target : null"),
    "unwind2's target likewise (with the positive-price guard the short side needs)");
  const uq = pol.indexOf('openLedger(r, "unwind", sig, -1);'), u2 = pol.indexOf('openLedger(r, "unwind2"');
  assert.ok(uq > 0 && u2 > uq, "the twin opens after — and only alongside — the visible unwind fire");
});

test("structural void -01: end-to-end — the held support probe fires as an invisible touch-mode claim with tight frozen geometry", async () => {
  const { createPoller } = require("../src/poller");
  const now = Date.now(), DAY_ = 86400e3, H = 3600e3;
  const store = { loadAll: () => new Map(), loadRegime: () => [], loadLedger: () => null,
    saveLedger: () => {}, insert: () => {}, saveRegime: () => {} };
  const p = createPoller({ dex: "xyz", store, log: () => {}, version: "test", crypto: false });
  // dailies (closes+highs; lows fall back to closes in the merge): support cluster at 100 from
  // two pivot-low CLOSES, target cluster at 118 from two pivot highs, alternation for sd30.
  // The probe itself arrives through the HOURLY spine: yesterday's daily bucket carries the true
  // low that dailyRaw structurally lacks — exactly the overlay mergedDailyBars exists for.
  const dayStart = Math.floor(now / DAY_) * DAY_;
  const nD = 302, dailyRaw = [];
  for (let i = 0; i < nD; i++) {
    const t = dayStart - (nD - i) * DAY_;
    let c = 104 + (i >= nD - 40 && i < nD - 1 ? (i % 2 ? 0.4 : -0.4) : 0), h = c + 0.4;
    if (i === 50 || i === 80) { c = 100; h = 100.4; }
    if (i === 60 || i === 90) h = 118;
    if (i === nD - 1) { c = 103; h = 103.4; }   // yesterday — overlaid by the spine bucket below
    dailyRaw.push({ t, c, h, v: 500 });
  }
  const hourlyRaw = [];
  for (let i = 0; i < 24; i++) {   // yesterday, hour by hour: one hour probes 100.2, the day closes 103
    const t = dayStart - DAY_ + i * H;
    const lo = i === 12 ? 100.2 : 102.8, c = i === 23 ? 103 : 103.2;
    hourlyRaw.push({ t, o: 103.2, h: 103.6, l: lo, c, v: 5 });
  }
  for (let t = dayStart; t <= now - H; t += H) hourlyRaw.push({ t, o: 103.5, h: 103.8, l: 103.2, c: 103.5, v: 5 });
  p.seedRowNow("xyz:LVT", { ticker: "LVT", px: 103.5, dailyRaw, hourlyRaw, hourlyTs: now });
  p.buildDailyNow();
  await p.buildSignalsNow();
  const x = p.getLedgerExport(true);
  const e = x.open.find((k) => k.coin === "xyz:LVT" && k.ev === "lvlhold");
  assert.ok(e, "the level-hold shadow opened");
  assert.equal(e.vi, 0, "invisible — a shadow earning its record, never a live signal");
  assert.equal(e.psd, "long", "play-signed long");
  assert.equal(e.tm, 1, "touch-resolved");
  assert.ok(e.stp > 99 && e.stp < 100, `void half a σ behind the 100 level — TIGHT (got ${e.stp})`);
  assert.ok(Math.abs(e.tgt - 118) < 0.5, `target frozen on the 118 cluster (got ${e.tgt})`);
  assert.ok(e.sd0 > 0, "R-united at fire");
  assert.equal(e.lvn, 2, "cluster touch count stamped as a recorded feature");
  assert.ok(e.lva >= 0, "cluster age stamped alongside it");
  assert.ok((e.mark0 - e.stp) / e.mark0 * 100 < 4.5, "risk to void is a few percent of entry — the thesis, frozen into the claim");
});

test("board promotion path -02: a matured shadow record carries its family onto the actionable board — tight void, correct label, no new machinery", async () => {
  // Phase 4, proven end-to-end: the board's confirmed gate IS the promotion. Eight resolved
  // out-of-sample lvlhold fires with positive expectancy hydrate from the persisted ledger, a
  // fresh live fire opens from the tape, and the row surfaces through the same
  // n>=8 / avgR>0 / EV>0 gate every family faces — flagged `shadow`, labeled from STRAT_DEFS,
  // void frozen half a sigma behind the structural level. This is the PURRDAT fix landing on the
  // board by record, not by argument.
  const { createPoller } = require("../src/poller");
  const now = Date.now(), DAY_ = 86400e3, H = 3600e3;
  const closed = [];
  for (let i = 0; i < 8; i++) closed.push({
    key: "xyz:OLD" + i + "|lvlhold#0", coin: "xyz:OLD" + i, ticker: "OLD" + i, ev: "lvlhold",
    t0: now - (40 - i) * DAY_, tR: now - (10 - i) * DAY_, mark0: 100, dir: 1, psd: "long", pn: 1, vi: 0,
    sd0: 1.2, stp: 99, tgt: 110, tm: 1, mv: 10, status: "resolved",
    realized: i < 6 ? 1.5 : -1, win: i < 6, realizedS: i < 6 ? 1.5 : -1, winS: i < 6, stopped: i >= 6,
  });
  const store = { loadAll: () => new Map(), loadRegime: () => [], saveLedger: () => {}, insert: () => {}, saveRegime: () => {},
    loadLedger: () => ({ ts: now, open: [], closed, rearm: [], variants: null }) };
  const p = createPoller({ dex: "xyz", store, log: () => {}, version: "test", crypto: false });
  p.hydrateLedgerNow();   // start() is never called in the harness — hydrate the persisted record explicitly
  // the -01 e2e tape, verbatim: support cluster at 100 probed through the hourly spine's true low
  const dayStart = Math.floor(now / DAY_) * DAY_;
  const nD = 302, dailyRaw = [];
  for (let i = 0; i < nD; i++) {
    const t = dayStart - (nD - i) * DAY_;
    let c = 104 + (i >= nD - 40 && i < nD - 1 ? (i % 2 ? 0.4 : -0.4) : 0), h = c + 0.4;
    if (i === 50 || i === 80) { c = 100; h = 100.4; }
    if (i === 60 || i === 90) h = 118;
    if (i === nD - 1) { c = 103; h = 103.4; }
    dailyRaw.push({ t, c, h, v: 500 });
  }
  const hourlyRaw = [];
  for (let i = 0; i < 24; i++) {
    const t = dayStart - DAY_ + i * H;
    hourlyRaw.push({ t, o: 103.2, h: 103.6, l: i === 12 ? 100.2 : 102.8, c: i === 23 ? 103 : 103.2, v: 5 });
  }
  for (let t = dayStart; t <= now - H; t += H) hourlyRaw.push({ t, o: 103.5, h: 103.8, l: 103.2, c: 103.5, v: 5 });
  p.seedRowNow("xyz:LVT", { ticker: "LVT", px: 103.5, dailyRaw, hourlyRaw, hourlyTs: now });
  p.buildDailyNow();
  await p.buildSignalsNow();
  await p.buildActionableNow();
  const a = p.getActionable(true);
  const row = a.rows.find((x) => x.coin === "xyz:LVT" && x.ev === "lvlhold");
  assert.ok(row, "the confirmed structural family reaches the board: " + JSON.stringify(a.coverage));
  assert.equal(row.shadow, true, "honestly flagged as a shadow-record family");
  assert.equal(row.label, "structural support hold", "labeled from STRAT_DEFS — one definition, panel and board agree");
  assert.ok(row.void > 99 && row.void < 100, `the board's void IS the structural stop — tight, on the invalidation (got ${row.void})`);
  assert.equal(row.rec.n, 8, "gated on the family's own out-of-sample record");
  assert.ok(row.rec.avgR > 0 && row.evR > 0, "and only because that record models positive from here");
  assert.ok(row.rr && row.rr.gross >= 2, "the tight void is what buys the R:R the sigma constructions never could");
});

test("-06 end to end: create/list/drop against a live roster, ratio candles + EMA eligibility + scope walls, registry persists", () => {
  const { createPoller } = require("../src/poller");
  let saved = null;
  const store = { loadAll: () => new Map(), loadRegime: () => [], loadLedger: () => null,
    saveLedger: () => {}, insert: () => {}, saveRegime: () => {}, saveNews: () => {}, loadNews: () => null,
    saveBaskets: (d) => { saved = d; return true; }, loadBaskets: () => null };
  const p = createPoller({ dex: "xyz", store, log: () => {}, version: "test" });
  const HOUR = 3600e3, DAY = 86400e3;
  const now = Math.floor(Date.now() / HOUR) * HOUR;
  // 4 equities with 30 daily closes + 60 hourly closes; one crypto main for the scope wall.
  const seedEq = (tk, base) => {
    const dailyRaw = Array.from({ length: 30 }, (_, i) => ({ t: now - (29 - i) * DAY, c: base * (1 + i * 0.002) }));
    const hourlyRaw = Array.from({ length: 60 }, (_, i) => ({ t: now - (59 - i) * HOUR, c: base * (1 + i * 0.001) }));
    p.seedRowNow("xyz:" + tk, { px: base, dailyRaw, hourlyRaw });
  };
  ["AAA", "BBB", "CCC", "DDD"].forEach((t, i) => seedEq(t, 100 * (i + 1)));
  p.seedRowNow("SOL", { px: 150, hourlyRaw: Array.from({ length: 60 }, (_, i) => ({ t: now - (59 - i) * HOUR, c: 150 + i })) });
  // create: happy path infers the stocks scope and persists
  const c = p.createBasket("mine", ["aaa", "bbb", "ccc"], true);
  assert.ok(c.ok, "create: " + (c.error || "ok"));
  assert.equal(c.basket.scope, "stocks", "scope inferred from members");
  assert.ok(saved && saved.list.length === 1 && saved.list[0].name === "MINE", "registry persisted through the store");
  // refusals, each with a stated reason
  assert.ok(!p.createBasket("SPX", ["AAA", "BBB"], true).ok, "benchmark alias refused");
  assert.ok(!p.createBasket("AAA", ["BBB", "CCC"], true).ok, "listed name refused");
  assert.ok(!p.createBasket("MIXED", ["AAA", "SOL"], true).ok, "cross-universe membership refused — the wall holds at create");
  assert.ok(!p.createBasket("MINE2", ["AAA", "NOPE"], true).ok, "unknown member refused, not silently dropped");
  // payload: the basket rides with a server-synthesized daily series
  const pay = p.getBasketsPayload();
  const mine = pay.baskets.find((b) => b.name === "MINE");
  assert.ok(mine && !mine.builtin && mine.daily.length >= 25, "daily synthesis shipped");
  assert.ok(Math.abs(mine.daily[0][1] - 100) < 1e-6, "seeds at 100");
  assert.equal(mine.cov.n, 3, "full coverage on the latest valid day");
  // ratio: ticker ÷ ticker on a 60-hour spine — candles exist, EMA200 honestly null with the reason
  const r1 = p.getRatio("AAA", "BBB", "4h");
  assert.ok(r1.ok, "ratio ok: " + (r1.error || ""));
  assert.ok(r1.candles.length >= 14, "4h candles from a 60h spine");
  assert.equal(r1.ema200, null, "no EMA200 on a short spine");
  assert.equal(r1.emaReason, "insufficient_bars", "machine-readable reason");
  assert.equal(r1.emaMin, 205);
  // every candle is a real sampled ratio: o/h/l/c all within the hour-sampled ratio envelope
  for (const k of r1.candles) assert.ok(k.h >= Math.max(k.o, k.c) && k.l <= Math.min(k.o, k.c), "OHLC coherent");
  // basket leg ÷ ticker works and carries coverage disclosure
  const r2 = p.getRatio("MINE", "DDD", "1h");
  assert.ok(r2.ok && r2.numBasket && !r2.denBasket, "basket numerator resolves");
  assert.deepEqual(r2.numCov, { n: 3, N: 3 }, "leg coverage shipped for the legend");
  // walls at read time too
  assert.ok(!p.getRatio("AAA", "SOL", "4h").ok, "cross-universe ratio refused");
  // -75: BTC is the one crossing. Seeded as a main-universe row on the same hourly spine.
  p.seedRowNow("BTC", { px: 60000, hourlyRaw: Array.from({ length: 60 }, (_, i) => ({ t: now - (59 - i) * HOUR, c: 60000 + i * 10 })) });
  const rb = p.getRatio("AAA", "BTC", "4h");
  assert.ok(rb.ok, "stock ÷ BTC is allowed: " + (rb.error || ""));
  assert.equal(rb.scope, "stocks", "a bridged pair reports the stock leg's universe");
  assert.ok(p.getRatio("BTC", "AAA", "1h").ok && p.getRatio("MINE", "BTC", "4h").ok, "BTC on either side, and against a basket");
  assert.ok(!p.getRatio("AAA", "SOL", "4h").ok && !p.getRatio("MINE", "SOL", "4h").ok, "no other coin crosses");
  assert.ok(!p.getRatio("AAA", "AAA", "4h").ok, "self-ratio refused");
  assert.ok(!p.getRatio("AAA", "BBB", "7h").ok, "unknown tf refused");
  // drop: custom goes, built-ins (none seeded here) can't, and the stamp moves for the ETag
  const st0 = p.getBasketsStamp();
  assert.ok(p.dropBasket("MINE", true).ok, "drop custom");
  assert.ok(!p.dropBasket("MINE", true).ok, "double-drop refused");
  assert.notEqual(p.getBasketsStamp(), st0, "registry stamp moved — cached /api/baskets keys die with it");
  assert.equal(saved.list.length, 0, "persisted registry reflects the drop");
});

// ===== shadow baskets + corr reorder + 7d overlap floor (folded into build 2026.07.28-11) =======
// Sector AND industry groups become pickable comparison instruments (COMP/G, ratio, matrix) but are
// SHADOW: hidden from the editable Baskets manager. The corr tab reorders to matrix -> strongest
// pairs -> COMP/G -> baskets. And the 7d correlation lookback no longer greys out (the overlap
// floor scales with the window instead of a flat 15-day minimum that a 7d window can't clear).

test("-11 shadow baskets: sectors + industries derive as usable instruments, flagged shadow, curated MAG7 stays shown", () => {
  const { createPoller } = require("../src/poller");
  const store = { loadAll: () => new Map(), loadRegime: () => [], loadLedger: () => null,
    saveLedger() {}, insert() {}, saveRegime() {}, saveNews() {}, loadNews: () => null,
    saveBaskets: () => true, loadBaskets: () => null };
  const p = createPoller({ dex: "xyz", store, log: () => {}, version: "test" });
  const DAY = 86400e3, HOUR = 3600e3, now = Math.floor(Date.now() / HOUR) * HOUR;
  // a memory-complex (industry) inside Info Tech (sector) + MAG7 names
  ["SNDK", "MU", "WDC", "STX", "AAPL", "MSFT", "GOOGL", "AMZN", "NVDA", "META", "TSLA"].forEach((tk) =>
    p.seedRowNow("xyz:" + tk, { px: 100, dailyRaw: Array.from({ length: 20 }, (_, k) => ({ t: now - (19 - k) * DAY, c: 100 + k })),
      hourlyRaw: Array.from({ length: 60 }, (_, k) => ({ t: now - (59 - k) * HOUR, c: 100 })) }));
  const bb = p.getBasketsPayload().baskets.filter((b) => b.builtin);
  const tech = bb.find((b) => b.name === "TECH");
  assert.ok(tech && tech.shadow === true && tech.kind === "sector", "sector basket is shadow");
  const mem = bb.find((b) => b.kind === "industry" && /Memory/.test(b.label || ""));
  assert.ok(mem && mem.shadow === true, "the memory-complex industry derives as a shadow basket");
  assert.ok(/^[A-Z][A-Z0-9]{1,11}$/.test(mem.name), "industry name tokenized to a valid basket name: " + mem.name);
  assert.deepEqual(mem.members, ["MU", "SNDK", "STX", "WDC"], "industry members are the roster intersection");
  const mag = bb.find((b) => b.name === "MAG7");
  assert.ok(mag && !mag.shadow, "curated MAG7 is NOT shadow — it shows in the manager");
  // usable as a ratio instrument, either leg, either order
  assert.ok(p.getRatio(mem.name, "TECH", "1h").ok, "industry ÷ sector ratio resolves");
  assert.ok(p.getRatio("MAG7", mem.name, "1h").ok, "curated ÷ industry ratio resolves");
});

// ===== shadow baskets resolve by typed label, not just the truncated token (build 2026.07.28-11) ==
// The bug: industry names tokenize to <=12 chars, so "Semiconductors" -> SEMICONDUCTO (no trailing
// R). Clicking the COMP/G chip worked (real token), but typing the natural word in `ratio` failed.
// Fix: basketDefByName resolves by token first, then by normalized human LABEL (singular/plural
// tolerant), so `ratio mag7/semiconductor` and `.../semiconductors` both hit the basket.

test("-11 shadow baskets resolve by natural label: ratio accepts the typed industry name, not just the token", () => {
  const { createPoller } = require("../src/poller");
  const store = { loadAll: () => new Map(), loadRegime: () => [], loadLedger: () => null,
    saveLedger() {}, insert() {}, saveRegime() {}, saveNews() {}, loadNews: () => null,
    saveBaskets: () => true, loadBaskets: () => null };
  const p = createPoller({ dex: "xyz", store, log: () => {}, version: "test" });
  const DAY = 86400e3, HOUR = 3600e3, now = Math.floor(Date.now() / HOUR) * HOUR;
  ["NVDA", "AMD", "AVGO", "MRVL", "QCOM", "AAPL", "MSFT", "GOOGL", "AMZN", "META", "TSLA"].forEach((tk) =>
    p.seedRowNow("xyz:" + tk, { px: 100, dailyRaw: Array.from({ length: 20 }, (_, k) => ({ t: now - (19 - k) * DAY, c: 100 + k })),
      hourlyRaw: Array.from({ length: 60 }, (_, k) => ({ t: now - (59 - k) * HOUR, c: 100 })) }));
  // the industry exists and its token is the truncated form
  const semi = p.getBasketsPayload().baskets.find((b) => b.label === "Semiconductors");
  assert.ok(semi, "the Semiconductors industry basket exists");
  assert.equal(semi.name.length, 12, "its token is truncated to 12 chars (the source of the typo trap)");
  // all natural forms resolve to the SAME basket, and the ratio echoes the canonical token
  for (const typed of ["SEMICONDUCTOR", "SEMICONDUCTORS", "semiconductor", semi.name]) {
    const r = p.getRatio("MAG7", typed, "1h");
    assert.ok(r.ok, "ratio resolves '" + typed + "': " + (r.error || ""));
    assert.equal(r.den, semi.name, "echoes the canonical basket token for '" + typed + "'");
  }
  // a genuine non-match still fails cleanly (no over-eager fuzzy hit)
  assert.ok(!p.getRatio("MAG7", "ZZZQQ", "1h").ok, "garbage still refused");
});

test("spine hardening 2026.07.29-03: poller wiring — shared claim predicate, comparator in pick, flat claim backoff, logged failures, health spines", () => {
  const fs = require("fs"), path = require("path");
  const pol = fs.readFileSync(path.join(__dirname, "..", "src", "poller.js"), "utf8");

  // One predicate defines the protected set, and BOTH consumers (fetch priority + coverage alert)
  // read it — this is the one-code-path claim between "what we warn about" and "what we refresh first".
  assert.ok(pol.includes("const isOpenAnnounced = (e) => e.vi == null && e.alo === 1;"), "shared open-claim predicate missing");
  assert.ok((pol.match(/isOpenAnnounced\(e\)/g) || []).length >= 2, "both openClaimCoins and coverageScan must consume the shared predicate");
  assert.ok(!pol.includes("e.vi != null || e.alo !== 1"), "coverageScan's inlined copy of the predicate must be gone — two copies is how they drift");

  // pick() escalation: constant derived from HOURLY_STALE (not a magic number), comparator imported
  // from compute (pure, tested above), claim set computed only on the hourly lane.
  assert.ok(pol.includes("const CLAIM_PRIORITY_AGE = 3 * HOURLY_STALE;"), "escalation age must derive from HOURLY_STALE");
  assert.ok(pol.includes('const { hourlyPickTier, hourlyPickBetter } = require("./compute");'), "comparator must live in compute (pure), not inline in the scheduler");
  assert.ok(pol.includes('const claims = prefix === "h:" ? openClaimCoins() : null;'), "claim escalation is hourly-lane only — daily/5m/funding orderings untouched");
  assert.ok(pol.includes("hourlyPickTier(age, claims.has(r.coin), CLAIM_PRIORITY_AGE)") && pol.includes("if (hourlyPickBetter(key, bestKey)) { best = r; bestKey = key; }"), "pick must route through the pure comparator");
  assert.ok(pol.includes("if (r.coin === benchCoin) return r.coin;"), "benchmark-first is untouched — it still preempts every tier");

  // Flat backoff for claim coins + the catch is no longer silent.
  assert.ok(pol.includes("r.hFailUntil = Date.now() + (claim ? FAIL_BACKOFF : Math.min(FAIL_BACKOFF * r.hFail, 15 * 60 * 1000));"), "claim coins must ride a flat FAIL_BACKOFF, never the 15-min ceiling");
  assert.ok(pol.includes("log(`hourly refresh failed for ${coin}:"), "the hourly fetch failure must reach the log — the silent catch was the observability gap");
  assert.ok(!/catch \(_\) \{\s*\n\s*const r = rows\.get\(coin\);\s*\n\s*if \(r\) \{ r\.hFail =/.test(pol), "the old silent one-line hourly catch must be gone");

  // Coverage hysteresis: fresh-stretch clock starts on observation, dies on any stale scan, and
  // re-arm requires the full window. Ordering pins: the delete must precede the armed checks.
  assert.ok(pol.includes("const COVERAGE_REARM_FRESH_MS = 30 * 60 * 1000;"), "re-arm window constant missing");
  assert.ok(pol.includes("if (!coverageFreshAt.has(key)) coverageFreshAt.set(key, now);"), "fresh stretch must be clocked from first observation");
  assert.ok(pol.includes("now - coverageFreshAt.get(key) >= COVERAGE_REARM_FRESH_MS"), "re-arm must require the sustained window");
  const scan = pol.slice(pol.indexOf("function coverageScan(atNow)"));
  const delAt = scan.indexOf("coverageFreshAt.delete(key);"), armChk = scan.indexOf('if (coverageArmed.get(key) === false) continue;');
  assert.ok(delAt > 0 && armChk > 0 && delAt < armChk, "a stale scan must kill the fresh clock BEFORE the armed checks, or a flap keeps an old clock alive");
  assert.ok(pol.includes("function coverageScan(atNow)"), "coverageScan must accept a fake clock — the hysteresis is untestable on wall time");
  assert.ok(scan.includes("coverageArmed.delete(k); coverageFreshAt.delete(k);"), "dead claims must drop BOTH maps, or freshAt leaks");

  // The alert says WHY: fail state when there is one, honest budget attribution when there isn't.
  assert.ok(pol.includes("fetch failing (${r.hFail} consecutive") && pol.includes("no fetch failures recorded \\u2014 queue/budget contention"), "coverage text must disclose the cause split");

  // Health spines block: stale list rides the SAME threshold the alert uses (one constant), sorted
  // worst-first, capped, carrying the fail state that makes the episode diagnosable from one curl.
  assert.ok(pol.includes("spines: { staleMs: COVERAGE_STALE_MS, stale: staleSp.length,"), "health must expose the spines block on the alert's own threshold");
  assert.ok(pol.includes("staleSp.sort((a, b) => b.ageMin - a.ageMin);") && pol.includes("coins: staleSp.slice(0, 20)"), "worst-first, capped");
  assert.ok(pol.includes("hFail: r.hFail || 0,") && pol.includes("backoffS:"), "per-coin fail state must ride the health entry");
});

test("perf -08 behavior: the chain serializes — actionable's self-heal settles via settleBuildsNow and never interleaves", async () => {
  const { createPoller } = require("../src/poller");
  const store = { loadAll: () => new Map(), loadRegime: () => [], loadLedger: () => null, saveLedger: () => {},
    insert: () => {}, saveRegime: () => {}, saveTriggers: () => {}, loadTriggers: () => null };
  const p = createPoller({ dex: "xyz", store, log: () => {}, version: "test", crypto: false });
  // Cold cache: the getter fires the chained build and serves the fallback THIS call…
  const cold = p.getActionable(true);
  assert.equal(cold.count, 0, "the cold request serves the fallback shape, never blocks on the build");
  await p.settleBuildsNow();
  // …and by the time the chain settles, the cache is real (empty roster -> empty board, but BUILT:
  // params carry the gate disclosure only a completed build stamps).
  const warm = p.getActionable(true);
  assert.equal(warm.params.gate, "confirmed", "the chained self-heal completed and stamped a real payload");
});
