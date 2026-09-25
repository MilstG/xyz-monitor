"use strict";
// EMA Touch tab (build 2026.09.25-115): the 50 / 200 touch feed on H4 + D1, its episode cooldown,
// the ma50 close-confirmed lane and the opt-in intrabar touch classes.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs"), path = require("path");
const { maDaily } = require("./_shared");
const C = require("../src/compute");

const DAY = 86400e3, HOUR = 3600e3;
const t0 = Date.UTC(2025, 6, 1);

function harness(recipients, restore) {
  const { createPoller } = require("../src/poller");
  let trig = null;
  const store = { loadAll: () => new Map(), loadRegime: () => [], loadLedger: () => null, saveLedger: () => {},
    insert: () => {}, saveRegime: () => {}, loadTriggers: () => restore || null, saveTriggers: (d) => { trig = d; },
    saveRules: () => {}, loadRules: () => null, savePush: () => {},
    loadPush: () => (recipients ? { recipients } : null) };
  const p = createPoller({ dex: "xyz", store, log: () => {}, version: "test", crypto: false });
  if (recipients) p.hydratePushNow();
  return { p, saved: () => trig };
}
// A crypto name (calendar days, no session fold) whose 50-EMA sits near 100 and whose last close
// sits above it: approaches read "from above" (support tests).
function seedName(p, px, extra) {
  const n = 120;
  const daily = maDaily(n, 100, { 0: { c: 101.5, h: 101.6, l: 101.4 } }, t0);
  p.seedRowNow("EMA", Object.assign({ ticker: "EMAT", px, uni: "main", dailyRaw: daily, hourlyRaw: [] }, extra || {}));
  return { daily, dEnd: t0 + n * DAY };
}
const touches = (p) => p.getEmaFeed().cards.filter((c) => c.k === "touch");

test("ema feed: seeds silently, near band, one card per candle, resolves at the close, folds until re-armed", () => {
  const { p } = harness();
  const { daily, dEnd } = seedName(p, 103);
  p.emaScanNow(dEnd + HOUR);
  assert.equal(p.getEmaFeed().cards.length, 0, "the first look records, never announces");
  p.emaPrimeNow();

  p.seedRowNow("EMA", { px: 100.4 });
  p.emaScanNow(dEnd + 2 * HOUR);
  const f1 = p.getEmaFeed();
  assert.deepEqual(f1.cards.map((c) => c.k), ["near"], "inside 0.5 sigma, not touching: a near entry");
  assert.equal(f1.near.length, 1, "the D1 EMA50 line is on deck (the 200 cannot seed on 120 bars)");
  assert.equal(f1.near[0].n, 50); assert.equal(f1.near[0].tf, "D1"); assert.equal(f1.near[0].from, "above");
  assert.ok(f1.near[0].inBand && !f1.near[0].touching);

  p.seedRowNow("EMA", { px: 99.9 });
  p.emaScanNow(dEnd + 3 * HOUR);
  assert.equal(touches(p).length, 1, "the forming bar reached the line: one touch card");
  const c = touches(p)[0];
  assert.equal(c.st, "live"); assert.equal(c.from, "above"); assert.equal(c.barT, dEnd); assert.equal(c.closeAt, dEnd + DAY);
  assert.equal(p.getEmaFeed().near[0].open, c.id, "the on-deck row points at its live card");

  p.seedRowNow("EMA", { px: 101 }); p.emaScanNow(dEnd + 4 * HOUR);
  p.seedRowNow("EMA", { px: 99.8 }); p.emaScanNow(dEnd + 5 * HOUR);
  assert.equal(touches(p).length, 1, "same candle: never a second card");
  assert.equal(touches(p)[0].retouch, 0, "and not a retouch either");

  // The day closes back above the line: the card resolves in place as held.
  const d2 = daily.concat([{ t: dEnd, c: 100.8, h: 103, l: 99.8 }]);
  p.seedRowNow("EMA", { dailyRaw: d2, px: 100.8 });
  p.emaScanNow(dEnd + DAY + 60e3);
  assert.equal(touches(p).length, 1);
  assert.equal(touches(p)[0].st, "held");
  assert.ok(touches(p)[0].close === 100.8 && touches(p)[0].lineC > 0 && touches(p)[0].resAt === dEnd + DAY + 60e3);
  assert.equal(p.getEmaFeed().near[0].open, null, "a resolved card is not an open one");

  // Next candle touches again, but no close cleared the line: folded into the card, once per candle.
  p.seedRowNow("EMA", { px: 99.7 }); p.emaScanNow(dEnd + DAY + HOUR);
  p.seedRowNow("EMA", { px: 99.6 }); p.emaScanNow(dEnd + DAY + 2 * HOUR);
  assert.equal(touches(p).length, 1, "same episode: no new card");
  assert.equal(touches(p)[0].retouch, 1, "counted once for the candle");

  // A close well clear of the line (>= 1 sigma) re-arms it; the next touch is a new card, and a
  // close on the far side resolves it as closed through.
  const d3 = d2.concat([{ t: dEnd + DAY, c: 103, h: 103.2, l: 99.6 }]);
  p.seedRowNow("EMA", { dailyRaw: d3, px: 103 }); p.emaScanNow(dEnd + 2 * DAY + 60e3);
  p.seedRowNow("EMA", { px: 99.5 }); p.emaScanNow(dEnd + 2 * DAY + HOUR);
  assert.equal(touches(p).length, 2, "re-armed by the clear close: a fresh card");
  const d4 = d3.concat([{ t: dEnd + 2 * DAY, c: 98.5, h: 103, l: 98.4 }]);
  p.seedRowNow("EMA", { dailyRaw: d4, px: 98.5 }); p.emaScanNow(dEnd + 3 * DAY + 60e3);
  assert.equal(touches(p)[0].st, "thru", "newest first: closed below the line it came down to");
  const cnt = p.getEmaFeed().counts;
  assert.equal(cnt.touches24, 1, "counts ride the scan clock"); assert.equal(cnt.thru24, 1);
});

test("ema feed: the touch classes only enter the stream for an opted-in operator; state and cards persist", () => {
  // No recipient wants touch50: the card exists, the alert stream stays clean.
  const a = harness();
  const s1 = seedName(a.p, 103); a.p.emaScanNow(s1.dEnd + HOUR); a.p.emaPrimeNow();
  a.p.seedRowNow("EMA", { px: 99.9 }); a.p.emaScanNow(s1.dEnd + 2 * HOUR);
  assert.equal(touches(a.p).length, 1);
  assert.equal(a.p.getTriggers(0, null, true).events.filter((e) => /^touch/.test(e.kind)).length, 0);

  // An operator recipient opted into touch50 (and a member who asked for it, who cannot have it).
  const b = harness([{ chat: "1", admin: true, classes: ["touch50"] }, { chat: "2", owner: "u2", admin: false, classes: ["touch200"] }]);
  const s2 = seedName(b.p, 103); b.p.emaScanNow(s2.dEnd + HOUR); b.p.emaPrimeNow();
  b.p.seedRowNow("EMA", { px: 99.9 }); b.p.emaScanNow(s2.dEnd + 2 * HOUR);
  const ev = b.p.getTriggers(0, null, true).events.filter((e) => e.kind === "touch50");
  assert.equal(ev.length, 1);
  assert.equal(ev[0].tf, "D1"); assert.equal(ev[0].from, "above"); assert.equal(ev[0].side, "long");
  assert.equal(ev[0].closeAt, s2.dEnd + DAY);
  assert.equal(b.p.getTriggers(0, null, false).events.filter((e) => e.kind === "touch50").length, 0,
    "operator-only in the feed while the tab soaks");

  // A fresh process restored from the saved triggers file re-announces nothing and keeps the card.
  const snap = JSON.parse(JSON.stringify(b.saved()));
  assert.ok(Array.isArray(snap.episodes.ema) && Array.isArray(snap.episodes.emaCards));
  const c = harness([{ chat: "1", admin: true, classes: ["touch50"] }], snap);
  seedName(c.p, 99.8);
  assert.equal(c.p.hydrateTriggersNow(), true);
  c.p.emaScanNow(s2.dEnd + 3 * HOUR);
  assert.equal(touches(c.p).length, 1, "the card survives the redeploy");
  assert.equal(c.p.getTriggers(0, null, true).events.filter((e) => e.kind === "touch50" && e.at === s2.dEnd + 3 * HOUR).length, 0,
    "the restored episode is still disarmed: the standing touch is not announced again");
});

test("ma50 lane: the ma200 shapes on the 50, close-confirmed, seeded silently, once per closed bar", () => {
  const { p } = harness();
  const n = 120;
  const below = {}; for (let k = 0; k < 8; k++) below[k] = { c: 96, h: 96, l: 96 };
  const daily = maDaily(n, 100, below, t0);
  const dEnd = t0 + n * DAY;
  p.seedRowNow("EMA", { ticker: "EMAT", px: 96, uni: "main", dailyRaw: daily, hourlyRaw: [] });
  p.emaScanNow(dEnd + HOUR); p.emaPrimeNow();
  const evs = () => p.getTriggers(0, null, true).events.filter((e) => e.kind === "ma50");
  p.seedRowNow("EMA", { px: 104 }); p.emaScanNow(dEnd + 5 * HOUR);
  assert.equal(evs().length, 0, "an intrabar reclaim is a sighting, never an alert");
  const d2 = daily.concat([{ t: dEnd, c: 104, h: 104.5, l: 95.8 }]);
  p.seedRowNow("EMA", { dailyRaw: d2, px: 104 });
  p.emaScanNow(dEnd + DAY + 60e3);
  const e = evs();
  assert.equal(e.length, 1);
  assert.equal(e[0].sub, "reclaim"); assert.equal(e[0].side, "long"); assert.equal(e[0].tf, "D1");
  assert.equal(e[0].confAt, dEnd + DAY); assert.equal(e[0].seenAt, dEnd + 5 * HOUR);
  assert.match(e[0].title, /EMA50 reclaim/);
  p.emaScanNow(dEnd + DAY + 10 * 60e3);
  assert.equal(evs().length, 1, "the same closed bar never announces twice");
  assert.equal(p.getTriggers(0, null, true).events.filter((x) => x.kind === "ma200").length, 0, "the 200 lane is untouched");
});

test("ema classes: separate, opt-in, operator-only; the wire formats each", () => {
  for (const k of ["ma50", "touch200", "touch50"]) {
    assert.ok(C.PUSH_CLASSES.includes(k), k);
    assert.ok(!C.PUSH_DEFAULT_CLASSES.includes(k), k + " is opt-in");
    assert.ok(C.PUSH_ADMIN_CLASSES.includes(k), k + " soaks operator-only");
  }
  assert.ok(!C.PUSH_ADMIN_CLASSES.includes("ma200"), "the existing 200 lane keeps its audience");
  const t = { kind: "touch50", coin: "SOL", t: "SOL", side: "long", tf: "H4", px: 148.2, ema: 148.05, dist: 0.1,
    closeAt: 1e12 + 72 * 60000, at: 1e12, title: "H4 touching EMA50", text: "support test", stacked: 1 };
  assert.equal(C.pushEligible(t, { admin: true, classes: ["touch50"] }), true);
  assert.equal(C.pushEligible(t, { admin: true, classes: ["touch200"] }), false, "50 and 200 are chosen separately");
  assert.equal(C.pushEligible(t, { admin: false, classes: ["touch50"] }), false);
  assert.equal(C.pushEligible(t, { admin: true }), false, "never in anyone's default set");
  const m = C.pushFmt(t);
  assert.ok(m.includes("EMA50") && m.includes("1h 12m") && m.includes("same level"), m);
  const m50 = C.pushFmt({ kind: "ma50", coin: "SOL", t: "SOL", side: "long", sub: "reclaim", tf: "D1", px: 150, ema: 148, dist: 1.3, held: 9, title: "D1 EMA50 reclaim" });
  assert.ok(m50.includes("EMA50") && !m50.includes("EMA200") && m50.includes("9 D1 bars"), m50);
  const m200 = C.pushFmt({ kind: "ma200", coin: "SOL", t: "SOL", side: "long", sub: "reclaim", tf: "D1", px: 150, ema: 148, dist: 1.3, held: 9, title: "D1 EMA200 reclaim" });
  assert.ok(m200.includes("EMA200"), "the 200 message is unchanged");
});

test("ema touch tab: wired end to end — manifest, route, nav, markup, lazy module, dispatch, poll, help, manual, alerts panel", () => {
  const read = (...p) => fs.readFileSync(path.join(__dirname, "..", ...p), "utf8");
  const f = C.FEATURES.find((x) => x.key === "ematouch");
  assert.ok(f && f.kind === "tab" && f.def === "admin" && f.routes.includes("/api/ema-feed"), "admin tab owning its route");
  assert.ok(C.NAV_GROUPS.find((g) => g.key === "signals").views.includes("ematouch"));
  const sv = read("server.js"), html = read("public", "index.html"), docs = read("public", "docs.html");
  assert.ok(sv.includes('fastify.get("/api/ema-feed"') && sv.includes("poller.getEmaFeed()"));
  assert.ok(html.includes('data-view="ematouch"') && html.includes('id="view-ematouch"') && html.includes('id="emt-wrap"'));
  assert.ok(docs.includes('<section id="tab-ematouch" data-feature="ematouch" data-def="admin">'));
  assert.ok(read("public", "js", "core.js").includes('ematouch:()=>import("./ematouch.js")'));
  const app = require("./_client").clientSource();
  assert.ok(app.includes("if(v==='ematouch'){ if(el('view-ematouch')) lazyCall('ematouch','openEmaTouch'); else { showView('markets'); return; } }"));
  assert.ok(app.includes("setHidden('view-ematouch', v!=='ematouch');"));
  assert.ok(app.includes("{ const m=lazyLoaded('ematouch'); if(m) m.pollEmaTouch(); }"), "polls off the snapshot cadence, only once loaded");
  assert.ok(/const HASH_VIEWS=new Set\(\[[^\]]*'ematouch'/.test(app) && /const CRYPTO_VIEWS=new Set\(\[[^\]]*'ematouch'/.test(app));
  assert.ok(app.includes("{v:'ematouch',label:'EMA Touch'}") && app.includes("  ematouch:`<div class=\"hlp-h\">What it is</div>"));
  for (const k of ["ma50", "touch200", "touch50"]) assert.ok(new RegExp("\\n  " + k + ":\\{toast:").test(app) && new RegExp("\\n      " + k + ":'").test(app), "alert matrix + class tip: " + k);
  assert.ok(app.includes("if(k==='touch200'||k==='touch50')"), "bell text for touches");
  const pol = read("src", "poller.js");
  assert.ok(/setInterval\(safeTick\(emaScan, "emaScan"\), 60 \* 1000\);/.test(pol) && /emaPrimed = true; log\("ema touch feed primed"\)/.test(pol));
  assert.ok(pol.includes("loadMap(ep.ema, emaSt);") && pol.includes("ema: [...emaSt.entries()].slice(-800),"));
  assert.ok(pol.includes('const src = tf === "D1" ? sessDailyBars(r) : bucketsFor(r, 4);'), "D1 is the session series");
});

test("ema touch tab client: renders both panes from a payload, filters by scope/tf/EMA, near entries opt-in", () => {
  const src = fs.readFileSync(path.join(__dirname, "..", "public", "js", "ematouch.js"), "utf8");
  assert.ok(!/\bema\s*\(|\bemaLast\b/.test(src), "the browser never recomputes an EMA — the server's line is the line");
  // emtPass is pure over EMT + state.scope: exercise it in a tiny sandbox.
  const vm = require("vm");
  const body = src.split("\n").filter((l) => !/^import /.test(l) && !/^export /.test(l)).join("\n");
  const ctx = { state: { scope: "stocks" }, store: { get: () => null, set: () => {} }, el: () => null, esc: (s) => String(s), fmtPrice: (v) => String(v),
    fetchJSON: async () => ({}), openDetail: () => {}, Date, JSON, Math, String };
  vm.createContext(ctx);
  vm.runInContext(body + "\nthis.emtPass=emtPass; this.EMT=EMT;", ctx);
  const x = { uni: "stocks", tf: "H4", n: 50 };
  assert.equal(ctx.emtPass(x), true);
  ctx.EMT.tf = "D1"; assert.equal(ctx.emtPass(x), false);
  ctx.EMT.tf = "all"; ctx.EMT.n = "200"; assert.equal(ctx.emtPass(x), false);
  ctx.EMT.n = "all"; ctx.state.scope = "crypto"; assert.equal(ctx.emtPass(x), false, "follows the Stocks|Crypto switcher");
});

test("ma200 lane -115: D1 on a stock is the SESSION series — a weekend UTC bar never closes a candle of its own", () => {
  const { createPoller } = require("../src/poller");
  const store = { loadAll: () => new Map(), loadRegime: () => [], loadLedger: () => null, saveLedger: () => {},
    insert: () => {}, saveRegime: () => {}, loadTriggers: () => null, saveTriggers: () => {}, saveRules: () => {}, loadRules: () => null };
  const p = createPoller({ dex: "xyz", store, log: () => {}, version: "test", crypto: false });
  // 300 weekday sessions ending on Friday 2026-09-18, alternating around 100; the last 8 at 96
  // (below the 200, armed for a reclaim).
  const fri = Date.UTC(2026, 8, 18);
  const days = [];
  for (let t = fri; days.length < 300; t -= DAY) { const wd = new Date(t).getUTCDay(); if (wd !== 0 && wd !== 6) days.unshift(t); }
  const daily = days.map((t, i) => { const c = i >= 292 ? 96 : 100 * (1 + (i % 2 ? 0.004 : -0.004)); return { t, c, h: c, l: c }; });
  p.seedRowNow("xyz:EMAS", { ticker: "EMAS", px: 96, uni: "xyz", dailyRaw: daily, hourlyRaw: [] });
  p.ma200ScanNow(fri + DAY + HOUR); p.ma200PrimeNow();
  const evs = () => p.getTriggers(0, null, true).events.filter((e) => e.kind === "ma200");
  // Saturday's perp prints close above the line at Sunday 00:00 UTC — a UTC-day series would call
  // that a closed D1 reclaim. On sessions it is Monday's forming bar: nothing yet.
  const sat = fri + DAY;
  p.seedRowNow("xyz:EMAS", { dailyRaw: daily.concat([{ t: sat, c: 104, h: 104.5, l: 96 }]), px: 104 });
  p.ma200ScanNow(sat + DAY + 60e3);
  assert.equal(evs().length, 0, "a weekend is not a session: no close, no event");
  // Monday's session closes above: the reclaim exists now, on Monday's session bar.
  const mon = fri + 3 * DAY;
  p.seedRowNow("xyz:EMAS", { dailyRaw: daily.concat([{ t: sat, c: 104, h: 104.5, l: 96 }, { t: sat + DAY, c: 104, h: 104, l: 103.8 }, { t: mon, c: 104, h: 104.2, l: 103.5 }]), px: 104 });
  p.ma200ScanNow(mon + DAY + 60e3);
  const e = evs();
  assert.equal(e.length, 1, "the session close confirms it");
  assert.equal(e[0].sub, "reclaim"); assert.equal(e[0].confAt, mon + DAY, "confirmed at Monday's session close");
});
