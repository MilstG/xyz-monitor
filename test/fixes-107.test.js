"use strict";
// ===== build 2026.09.24-107: reviewer-confirmed fixes ============================================
// Each block below is a reviewer's repro turned into a regression test: it failed on -106 and
// passes on -107. The Telegram "edit/delete before the send is confirmed" case lives with the rest
// of the sync's server tests (test/telegram-sync.test.js), which own the stubbed Bot API server.
const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs"), path = require("path"), os = require("os");
const { freshAccounts, _btHarness } = require("./_shared");
const C = require("../src/compute");

const DAY = 86400e3, HOUR = 3600e3, MIN = 60e3;
const src = (rel) => fs.readFileSync(path.join(__dirname, "..", rel), "utf8");
const withNow = (t, fn) => { const o = Date.now; Date.now = () => t; try { return fn(); } finally { Date.now = o; } };
async function seedTwo(A) {
  const g = (await A.bootstrap("gustavo", "correct-horse-battery")).user;
  const l = (await A.redeem(A.mintInvite(g.uid, "x", 7, "join").invite.code, "lena", "another-long-password")).user;
  return { g, l };
}
const stubStore = () => {
  let saved = null;
  return { loadAll: () => new Map(), loadRegime: () => [], loadLedger: () => null, saveLedger: () => {}, insert: () => {}, saveRegime: () => {},
    loadTriggers: () => null, saveTriggers: () => {}, savePush: (d) => { saved = d; }, loadPush: () => saved, loadFeatures: () => null, saveFeatures: () => {} };
};

// ---- 1. targetSweep waits for the bell bar --------------------------------------------------------
test("-107 targets: a miss waits until the archive holds the bar ending at the deadline (or the grace passes), and prices at the bell", async () => {
  const marks = { "xyz:HOOD": 100, "xyz:AMD": 100 };
  const A = freshAccounts(marks);
  try {
    const { g, l } = await seedTwo(A);
    const T = A.threadFor(g.uid, l.uid, true).id;
    const resolve = (x) => (marks["xyz:" + x] ? "xyz:" + x : null);
    const bars = {};
    A.setBarSource((c, f, t) => (bars[c] || []).filter((b) => b[0] >= f && b[0] <= t));
    A.setPxHistory(() => null);
    const day = new Date(Date.now() + 20 * DAY).toISOString().slice(0, 10);
    const m = A.send(g.uid, null, "$HOOD to 125 by " + day, resolve, { thread: T }).message;
    const by = m.call.tg.by;
    // The lane has stored up to the 15:50 bar (closes 15:55); the 15:55 bar — the one touching 126 — is not in yet.
    bars["xyz:HOOD"] = [];
    for (let t = by - 60 * MIN; t < by - 5 * MIN; t += 5 * MIN) bars["xyz:HOOD"].push([t, 110, 112, 109, 111]);
    marks["xyz:HOOD"] = 118;
    assert.deepEqual(A.targetSweep(by + MIN), [], "no miss while the bell bar is still missing from the archive");
    bars["xyz:HOOD"].push([by - 5 * MIN, 111, 126, 110, 120]);
    const r = A.targetSweep(by + 6 * MIN);
    assert.ok(r.length === 1 && r[0].res === "hit" && r[0].at === by - 5 * MIN, "the late bar's touch is a hit: " + JSON.stringify(r));
    // A clean miss prices at the close of the bar ending AT the deadline, not a later/earlier one.
    const m2 = A.send(g.uid, null, "$AMD to 150 by " + day, resolve, { thread: T }).message;
    bars["xyz:AMD"] = [[by - 10 * MIN, 100, 101, 99, 100], [by - 5 * MIN, 100, 105, 99, 104], [by, 104, 106, 103, 99]];
    const r2 = A.targetSweep(by + 6 * MIN);
    assert.ok(r2.length === 1 && r2[0].id === m2.id && r2[0].res === "miss" && r2[0].px === 104, "miss at the bell's 104: " + JSON.stringify(r2));
    // Past the grace (two lane stale windows) the miss resolves even with no archive at all.
    const m3 = A.send(g.uid, null, "$HOOD to 140 by " + day, resolve, { thread: T }).message;
    delete bars["xyz:HOOD"];
    A.setPxHistory((c, at) => (c === "xyz:HOOD" && at === by ? 117 : null));
    assert.deepEqual(A.targetSweep(by + 19 * MIN), [], "inside the grace: held");
    const r3 = A.targetSweep(by + 21 * MIN);
    assert.ok(r3.length === 1 && r3[0].id === m3.id && r3[0].res === "miss" && r3[0].px === 117, JSON.stringify(r3));
  } finally { A.close(); }
});

// ---- 8. every open target is swept, not the oldest 500 --------------------------------------------
test("-107 targets: the sweep pages through every open target (no LIMIT 500 starvation)", async () => {
  const marks = { HOOD: 100 };
  const A = freshAccounts(marks);
  try {
    const { g, l } = await seedTwo(A);
    const T = A.threadFor(g.uid, l.uid, true).id;
    A.setPxHistory(() => null);
    const bars = [];
    A.setBarSource((c, f, t) => bars.filter((b) => b[0] >= f && b[0] <= t));
    const m = A.send(g.uid, null, "$HOOD to 125 in 2w", (x) => (marks[x] ? x : null), { thread: T }).message;
    const ins = A._db.prepare("INSERT INTO dm_msg (thread, sender, ts, body, ref, refPx, side, callH, tgPx) SELECT thread, sender, ts, body, ref, refPx, side, callH, tgPx FROM dm_msg WHERE id = ?");
    for (let i = 0; i < 620; i++) ins.run(m.id);
    bars.push([m.ts + 5 * MIN, 100, 130, 99, 128]);
    const out = A.targetSweep(m.ts + HOUR);
    assert.equal(out.length, 621, "all 621 open targets resolved in one sweep");
    assert.equal(A._db.prepare("SELECT COUNT(*) n FROM dm_msg WHERE tgPx IS NOT NULL AND tgRes IS NULL").get().n, 0);
  } finally { A.close(); }
});

// ---- 2. single-flight Telegram getUpdates ----------------------------------------------------------
test("-107 telegram: an updates tick that overlaps a slow download is skipped — each update once, in order", async () => {
  process.env.TG_BOT_TOKEN = "t";
  try {
    const { createPoller } = require("../src/poller");
    const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]), Buffer.alloc(64, 7)]);
    const chat = { id: 77, type: "private" };
    const all = [
      { update_id: 1, message: { message_id: 13, chat, photo: [{ file_id: "p", file_size: 100 }] } },
      { update_id: 2, message: { message_id: 14, chat, text: "hello after the photo" } }];
    let release; const slow = new Promise((r) => { release = r; });
    let getUpdates = 0;
    const stub = async (url, opts) => {
      const u = String(url);
      if (/\/file\/bot/.test(u)) { await slow; return { ok: true, status: 200, arrayBuffer: async () => PNG.buffer.slice(PNG.byteOffset, PNG.byteOffset + PNG.length) }; }
      const method = u.slice(u.lastIndexOf("/") + 1), body = JSON.parse((opts && opts.body) || "{}");
      const J = (b) => ({ ok: true, status: 200, json: async () => b });
      if (method === "getUpdates") { getUpdates++; return J({ ok: true, result: all.filter((x) => x.update_id >= (body.offset || 0)) }); }
      if (method === "getFile") return J({ ok: true, result: { file_path: "a.jpg" } });
      return J({ ok: true, result: { message_id: 1 } });
    };
    const store = stubStore();
    const p = createPoller({ dex: "xyz", store, log: () => {}, version: "t", crypto: false, pushFetch: stub });
    p.pushBindNow(p.pushMintCode("own-a", false).code, 77, "a");
    const got = [];
    p.setDmBridge((c, text, o) => { got.push(o && o.file ? "[file]" : text); return { ok: true }; });
    const t1 = p.pushUpdatesNow();
    await new Promise((r) => setTimeout(r, 30));
    assert.ok(store.loadPush() && store.loadPush().offset === 2, "the cursor is persisted before the slow download");
    await p.pushUpdatesNow();                              // the next 20s tick while the first is still downloading
    assert.equal(getUpdates, 1, "the overlapping tick never asked Telegram again");
    release(); await t1;
    assert.deepEqual(got, ["[file]", "hello after the photo"], "each update once, in order");
    await p.pushUpdatesNow();
    assert.deepEqual(got, ["[file]", "hello after the photo"], "nothing replays");
  } finally { delete process.env.TG_BOT_TOKEN; }
});

// ---- 3. a disabled account cannot edit or react through a linked Telegram -------------------------
test("-107 telegram: a disabled account's bridge edit and reaction are refused like its text", async () => {
  const A = freshAccounts();
  try {
    const g = (await A.bootstrap("gus", "correct-horse-battery")).user;
    const l = (await A.redeem(A.mintInvite(g.uid, null, 7, "join").invite.code, "lena", "another-long-password")).user;
    const dm = A.threadFor(g.uid, l.uid, true).id;
    A.setTgSync(l.uid, dm, true);
    const typed = A.bridgeSyncText(l.uid, "from the phone");
    A.tgMapAdd("900", 42, [typed.id], l.uid, "in", 0);
    const other = A.send(g.uid, l.uid, "gus line");
    A.setDisabled(l.uid, true);
    assert.equal(A.bridgeSyncText(l.uid, "x").ok, false);
    assert.equal(A.bridgeEdit(l.uid, "900", 42, "rewritten by a disabled account").ok, false, "edit refused");
    assert.equal(A.reactApply(l.uid, other.id, ["\u{1F525}"], []).ok, false, "reaction refused");
    assert.equal(A._db.prepare("SELECT body FROM dm_msg WHERE id = ?").get(typed.id).body, "from the phone");
    assert.equal(A._db.prepare("SELECT COUNT(*) n FROM dm_reaction WHERE msg = ?").get(other.id).n, 0);
    assert.ok(src("server.js").includes("if (!me || me.disabledAt) return { ok: false, error: \"This chat is not linked to an account.\" };"), "the shared bridge door checks it too");
  } finally { A.close(); }
});

// ---- 5. deleteGroup takes the sync map rows ---------------------------------------------------------
test("-107 groups: deleting a group removes its dm_tg rows", async () => {
  const A = freshAccounts();
  try {
    const { g, l } = await seedTwo(A);
    const gr = A.createGroup(g.uid, "desk", [l.uid]);
    const T = gr.thread || (gr.group && gr.group.id) || gr.id;
    const m = A.send(g.uid, null, "hello group", null, { thread: T }).message;
    A.tgMapAdd("900", 5, [m.id], l.uid, "out", 0);
    assert.equal(A.tgMapFor(m.id).length, 1);
    assert.ok(A.deleteGroup(g.uid, T).ok);
    assert.equal(A._db.prepare("SELECT COUNT(*) n FROM dm_tg WHERE msg = ?").get(m.id).n, 0, "no orphaned sync-map rows");
  } finally { A.close(); }
});

// ---- 6 + 7. deadlines: refuse a passed date; snap relative/extended session deadlines to the close --
test("-107 call targets: a date whose close already passed is refused (not a silent 1-day horizon); relative and extended session deadlines end at a cash close", async () => {
  const eomAfter = Date.parse("2026-09-30T21:00:00Z"), friAfter = Date.parse("2026-09-25T21:00:00Z");
  const e = C.callTarget("$HOOD to 125 eom", "HOOD", 100, eomAfter, null, true);
  assert.ok(e && e.ok === false && /2026-09-30 close has already passed/.test(e.error), JSON.stringify(e));
  const f = C.callTarget("$HOOD to 125 by friday", "HOOD", 100, friAfter, null, true);
  assert.ok(f && f.ok === false && /already passed/.test(f.error), JSON.stringify(f));
  const ec = C.callTarget("$BTC to 125k eom", "BTC", 100000, eomAfter, null, false);
  assert.ok(ec.ok && ec.by === Date.UTC(2026, 9, 1), "crypto keeps 24:00 UTC of the date, still ahead");
  // Relative: "in 3w" on a session name ends at 16:00 ET of the day it lands on; crypto is exact.
  const now = Date.parse("2026-09-22T17:37:00Z");
  const s3 = C.callTarget("$HOOD to 125 in 3w", "HOOD", 100, now, null, true), et = C.etParts(s3.by);
  assert.deepEqual([et.mo, et.d, et.h, et.mi], [10, 13, 16, 0], "Tue Oct 13 16:00 ET");
  assert.equal(C.callTarget("$BTC to 125k in 3w", "BTC", 100000, now, null, false).by, now + 21 * DAY);
  const sat = C.callTarget("$HOOD to 125 in 4d", "HOOD", 100, now, null, true);   // Sat Sep 26 -> Friday's close
  assert.deepEqual([C.etParts(sat.by).d, C.etParts(sat.by).h], [25, 16]);
  const hol = C.callSessionClose(Date.parse("2026-11-27T15:00:00Z"));   // Friday after Thanksgiving: 13:00 ET
  assert.equal(C.etParts(hol).h, 13);
  // The client preview reads the same (parity on the session-rule path).
  const app = src("public/js/messages.js");
  const cut = app.slice(app.indexOf("const CALL_SHORT_BEFORE="), app.indexOf("// The composer's preview:"));
  const clientTarget = new Function(cut + "\nreturn dmCallTarget;")();
  for (const [t, at, sr] of [["$HOOD to 125 eom", eomAfter, true], ["$HOOD to 125 by friday", friAfter, true], ["$HOOD to 125 in 3w", now, true], ["$HOOD to 125 in 4d", now, true],
    ["$HOOD to 125 by Nov 27", now, true], ["$HOOD to 125 by Nov 26", now, true], ["$HOOD to 125 by 2026-10-17 stop 90", now, true], ["$BTC to 125k eom", eomAfter, false], ["$HOOD to 125 in 10d", now, false]]) {
    const sym = /BTC/.test(t) ? "BTC" : "HOOD", mk = sym === "BTC" ? 100000 : 100;
    assert.deepEqual(clientTarget(t, sym, mk, at, null, sr), C.callTarget(t, sym, mk, at, null, sr), "parity: " + t);
  }
  // Server: the send stores no target for a passed date; an extended session target ends at a close.
  const marks = { "xyz:HOOD": 100 };
  const A = freshAccounts(marks);
  try {
    const { g, l } = await seedTwo(A);
    const T = A.threadFor(g.uid, l.uid, true).id;
    const rs = (x) => (marks["xyz:" + x] ? "xyz:" + x : null);
    const m = A.send(g.uid, null, "$HOOD to 125 in 2w", rs, { thread: T }).message;
    const et2 = C.etParts(m.call.tg.by);
    assert.ok((et2.h === 16 || et2.h === 13) && et2.mi === 0, "relative target ends at a cash close: " + JSON.stringify(et2));
    const x = A.callExtend(g.uid, m.id, 30);
    assert.ok(x.ok, JSON.stringify(x));
    const et3 = C.etParts(x.message.call.tg.by);
    assert.ok((et3.h === 16 || et3.h === 13) && et3.mi === 0, "the extended deadline is a cash close too: " + JSON.stringify(et3));
  } finally { A.close(); }
});

// ---- 9. retest-study validators never collide across processes -----------------------------------
test("-107 retest-study: the body key carries the build and a per-boot nonce (two boots, same data, different keys)", () => {
  const { createPoller } = require("../src/poller");
  const mk = () => createPoller({ dex: "xyz", store: stubStore(), log: () => {}, version: "2026.09.24-107", crypto: false });
  const a = mk().getD1Retest("stocks", "board", 5), b = mk().getD1Retest("stocks", "board", 5);
  assert.ok(a.key.includes("2026.09.24-107"), a.key);
  assert.notEqual(a.key, b.key, "a restart can never 304 a client onto a different body");
  assert.ok(src("server.js").includes("'W/\"rt-' + VERSION + \"-\" + BOOT_NONCE + \"-\" + body.key + '\"'"));
});

// ---- 10. no "final" off a stale hourly anchor ------------------------------------------------------
test("-107 earnings: a reaction is final only off an exact anchor — an hourly close up to 3h early reads forming, then the daily path", () => {
  const p = { t: "X", d: "2026-09-15", s: "BMO" };
  const w = C.earnReactWindow(p);
  const hs = [];
  for (let t = w.pre - 48 * HOUR; t < w.post - HOUR; t += HOUR) { const px = t >= w.pre ? 110 : 100; hs.push([t, px, px, px, px, 1]); }   // the 15:00-16:00 bar not yet ingested
  const daily = []; for (let d = Math.floor(w.pre / DAY) - 30; d <= Math.floor(w.post / DAY); d++) daily.push({ t: d * DAY, c: 100 });
  const now = w.post + MIN;
  assert.deepEqual(C.earnPrintReaction(p, daily, 120, hs, now), { pct: 20, state: "forming", src: "cash" }, "not final off the 15:00 close");
  assert.equal(C.earnReactionsFor([p], daily, now, hs, {}), null, "and not pooled as a cash reaction");
  hs.push([w.post - HOUR, 110, 125, 110, 121, 1]);                                                             // the bell bar lands
  // (build 2026.09.25-122) ...but as the spine's LAST row it may be the forming candle: still forming
  assert.deepEqual(C.earnPrintReaction(p, daily, 120, hs, now), { pct: 20, state: "forming", src: "cash" }, "the bell bar as the last row is not proof it closed");
  assert.equal(C.earnReactionsFor([p], daily, now, hs, {}), null);
  hs.push([w.post, 121, 121, 121, 121, 1]);                                                                   // a row at/after the bell: the fetch ran after it
  assert.deepEqual(C.earnPrintReaction(p, daily, 120, hs, now + 10 * MIN), { pct: 21, state: "final", src: "cash" });
  assert.equal(C.earnReactionsFor([p], daily, now + 10 * MIN, hs, {}).cashN, 1);
});

// ---- 11. AMC on session bars is a two-session window: labelled, not pooled -------------------------
test("-107 earnings: a daily-tier AMC reaction is labelled wide (client == server) and excluded from the pooled study", () => {
  const d0 = Date.UTC(2026, 6, 20), daily = [100, 101, 104, 103, 124.8, 125, 126, 127, 128, 129, 130].map((c, i) => ({ t: d0 + i * DAY, c }));
  const now = d0 + 12 * DAY, off = C.sessOffFn("US");
  const amc = { t: "A", s: "AMC", d: "2026-07-23" }, bmo = { t: "B", s: "BMO", d: "2026-07-22" };
  const app = src("public/js/notes.js"), i0 = app.indexOf("function earnReactPct(");
  const body = app.slice(i0, app.indexOf("\nfunction ", i0 + 10));
  const clientRx = new Function("DAY", body + "; return earnReactPct;")(DAY);
  const s = C.earnPrintReaction(amc, daily, 131, null, now, { off });
  assert.equal(s.wide, true); assert.deepEqual(clientRx(amc, daily, 131, now, off), s);
  assert.equal(C.earnPrintReaction(bmo, daily, 131, null, now, { off }).wide, undefined, "a BMO window is one session");
  const st = C.earnReactionsFor([amc, bmo], daily, now, null, { off });
  assert.ok(st.n === 1 && st.amcWideN === 1 && st.dailyN === 1, JSON.stringify(st));
  assert.ok(app.includes("after-close print") && app.includes("(2 sessions)"), "the tab labels both");
});

// ---- 12. backtest: the held position and its score describe one decision ---------------------------
test("-107 backtest: under next-bar fills curW/curScore are the SAME decision and the unfilled one rides as pending", () => {
  const { api, state, restore } = _btHarness();
  try {
    state.backtest.picks = ["NVDA"]; state.backtest.entry = 0; state.backtest.cadence = 1; state.backtest.lag = "next";
    let flips = 0, runs = 0;
    for (let L = 5; L <= 40; L++) {
      state.backtest.lookback = L;
      const r = api.btRun();
      if (!r || !r.ok) continue;
      assert.ok(r.pending, "L=" + L + ": the last decision is pending under next-bar fills");
      if (!Number.isFinite(r.pending.score)) continue;   // a lookback the fixture's tail cannot score
      runs++;
      if (r.curW !== 0) assert.equal(Math.sign(r.curW), Math.sign(r.curScore), "L=" + L + ": the held side is the side its score chose");
      if (r.pending.w !== 0) assert.equal(Math.sign(r.pending.w), Math.sign(r.pending.score));
      if (r.pending.w !== r.curW) flips++;
    }
    assert.ok(runs > 10 && flips > 0, "the fixture exercises a pending flip (" + flips + " of " + runs + ")");
    state.backtest.lag = "same";
    assert.equal(api.btRun().pending, null, "same-bar fills leave nothing pending");
    const bt = src("public/js/backtest.js");
    assert.ok(bt.includes("fills at next close") && bt.includes("pending:pend?{ w:pend.nw, score:pend.score, z:pend.z }:null"), "the panel says so");
  } finally { restore(); }
});

// ---- 13. two-way clustered SE ----------------------------------------------------------------------
test("-107 retest: the mean's SE is two-way clustered (name × date, Cameron-Gelbach-Miller) on a hand-checked fixture", () => {
  // x = 1..4, names a,a,b,b, dates x,y,x,y; mean 2.5, deviations -1.5 -.5 .5 1.5
  // V_name = 2/1·((-2)²+2²)/16 = 1; V_date = 2/1·((-1)²+1²)/16 = .25; V_both = 4/3·5/16 = .41667
  const r = C.twoWayClusterMeanSE([1, 2, 3, 4], ["a", "a", "b", "b"], ["x", "y", "x", "y"]);
  assert.equal(r.mean, 2.5); assert.equal(r.G, 2); assert.equal(r.GA, 2);
  assert.ok(Math.abs(r.se - Math.sqrt(1 + 0.25 - 5 / 12)) < 1e-12, "√(V_name + V_date − V_name∩date), got " + r.se);
  // One name: reduces to the date-clustered SE; one date AND one name: none.
  assert.equal(C.twoWayClusterMeanSE([1, 2, 3, 4], ["a", "a", "a", "a"], ["x", "x", "y", "y"]).se, C.clusterMeanSE([1, 2, 3, 4], ["x", "x", "y", "y"]).se);
  assert.equal(C.twoWayClusterMeanSE([1, 2], ["a", "a"], ["x", "x"]).se, null);
  // A negative combined variance falls back to the larger one-way variance.
  const neg = C.twoWayClusterMeanSE([1, -1, -1, 1], ["a", "a", "b", "b"], ["x", "y", "y", "x"]);
  assert.ok(neg.se >= 0 && Number.isFinite(neg.se));
});

// ---- 14. webBodyToFile never hangs; busy flags are released ------------------------------------------
test("-107 downloads: webBodyToFile rejects (never hangs) when the file side errors mid-stream, and the ingests release their busy flag", async () => {
  const { webBodyToFile } = require("../src/poller");
  const settle = (p) => Promise.race([p.then(() => "resolved", (e) => "rejected " + e.code), new Promise((r) => setTimeout(() => r("HANG"), 3000))]);
  let i = 0;
  const slow = new ReadableStream({ async pull(c) { await new Promise((r) => setTimeout(r, 20)); if (i++ < 5) c.enqueue(new Uint8Array(1 << 20)); else c.close(); } });
  assert.equal(await settle(webBodyToFile(slow, "/nonexistent-dir-xyz/a.zip")), "rejected ENOENT");
  if (fs.existsSync("/dev/full")) {
    let k = 0;
    const small = new ReadableStream({ async pull(c) { await new Promise((r) => setTimeout(r, 5)); if (k++ < 200) c.enqueue(new Uint8Array(4096)); else c.close(); } });
    assert.equal(await settle(webBodyToFile(small, "/dev/full")), "rejected ENOSPC", "a full disk under small slow chunks");
  }
  const pol = src("src/poller.js");
  assert.ok(pol.includes("await pipeline(Readable.fromWeb(body), fsm.createWriteStream(file));"));
  assert.ok(pol.includes("} finally { t13fBusy = false; t13fProgress = null; }") && pol.includes("} finally { congressBusy = false; congressProgress = null; }"));
});

// ---- 15. actionable runs after signals every cycle -----------------------------------------------------
test("-107 timers: the 10-minute cycle enqueues buildSignals THEN buildActionable on the build chain", () => {
  const pol = src("src/poller.js");
  assert.ok(pol.includes('const signalsThenActionable = () => { safeTick(buildSignals, "buildSignals")(); safeTick(buildActionable, "buildActionable")(); };'));
  assert.ok(pol.includes("staggered(signalsThenActionable, 10 * 60 * 1000, 5 * 1000);"));
  assert.ok(!pol.includes('setInterval(safeTick(buildActionable, "buildActionable"), 10 * 60 * 1000);'), "no free-running actionable interval to drift ahead of signals");
  assert.ok(pol.indexOf("async function buildSignals()") > 0 && pol.indexOf("async function buildActionable()") > 0, "both are chained (async) builds");
});

// ---- 16. stale temp files --------------------------------------------------------------------------
test("-107 temp files: a backup clears stale accounts-*.db.tmp; the store sweeps *.atmp* at open and writes one fixed .atmp", async () => {
  const A = freshAccounts();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "xyz-bk-"));
  try {
    await A.bootstrap("gus", "correct-horse-battery");
    const stale = path.join(dir, "accounts-20260924-173516-16956.db.tmp");
    fs.writeFileSync(stale, "half a vacuum");
    const r = await A.backupAsync(dir, 7);
    assert.ok(r.ok, JSON.stringify(r));
    assert.ok(!fs.existsSync(stale), "the killed copy's tmp is gone");
    assert.equal(await A.backupDrain(1000), true);
  } finally { A.close(); fs.rmSync(dir, { recursive: true, force: true }); }
  const { openStore } = require("../src/store");
  const sd = fs.mkdtempSync(path.join(os.tmpdir(), "xyz-st-"));
  fs.writeFileSync(path.join(sd, "features.json.atmp7"), "x"); fs.writeFileSync(path.join(sd, "ledger.json.atmp"), "x");
  const st = openStore(sd);
  try {
    assert.ok(!fs.readdirSync(sd).some((f) => /\.atmp/.test(f)), "swept at open");
    assert.ok(src("src/store.js").includes('const gen = featGen, tmp = featFile + ".atmp";'), "one fixed name");
    assert.equal(await st.saveFeaturesAsync({ ts: 1, markets: {} }), true);
    assert.ok(!fs.readdirSync(sd).some((f) => /\.atmp/.test(f)));
  } finally { st.close(); fs.rmSync(sd, { recursive: true, force: true }); }
});

// ---- 17. crash save vs an in-flight async rename ------------------------------------------------------
test("-107 crash path: a sync save during an outstanding async rename wins WITHOUT the async continuation (crashFlush exits synchronously)", async () => {
  const { openStore } = require("../src/store");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "xyz-crash-"));
  const st = openStore(dir);
  const orig = fs.promises.rename;
  let atRename = null;
  try {
    // The rename is on the threadpool when the crash save runs; read the file the instant the
    // rename settles — before any continuation of the async path could re-land anything.
    fs.promises.rename = async (a, b) => {
      fs.promises.rename = orig;
      st.saveFeatures({ ts: 2, markets: {} });
      try { return await orig.call(fs.promises, a, b); }
      finally { atRename = JSON.parse(fs.readFileSync(path.join(dir, "features.json"), "utf8")).ts; }
    };
    assert.equal(await st.saveFeaturesAsync({ ts: 1, markets: {} }), false);
    assert.equal(atRename, 2, "the older async copy never landed, even for a moment");
    assert.equal(st.loadFeatures().ts, 2);
  } finally { fs.promises.rename = orig; st.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});

// ---- 18. "vs cash close" refreshes once the bell bar lands ---------------------------------------------
test("-107 daily: the cash-close anchor is re-read once the spine refreshes past the close (not frozen at the pre-close price)", () => {
  const { createPoller } = require("../src/poller");
  const close = C.etWallToUtc(2026, 9, 23, 16, 0), now = close + 10 * MIN;
  withNow(now, () => {
    const p = createPoller({ dex: "xyz", store: stubStore(), log: () => {}, version: "t", crypto: false });
    const hs = []; for (let t = close - 30 * HOUR; t < close - HOUR; t += HOUR) hs.push([t, 100, 101, 99, 100, 1000]);   // up to the 14:00-15:00 bar
    const D0 = Math.floor(now / DAY) * DAY, daily = []; for (let i = 40; i >= 1; i--) daily.push({ t: D0 - i * DAY, o: 100, h: 101, l: 99, c: 100, v: 1e5 });
    p.seedRowNow("xyz:HOOD", { px: 110, ticker: "HOOD", uni: "xyz", vol: 1e7, hourlyRaw: hs, hourlyTs: close - 20 * MIN, dailyRaw: daily, dailyTs: now });
    p.buildDailyNow();
    const d0 = p.getDaily();
    assert.deepEqual(d0.cashClose["xyz:HOOD"], [close, 100], "before the bell bar: the stale 15:00 price");
    const r = p.rowNow("xyz:HOOD");
    r.hourlyRaw = hs.concat([[close - HOUR, 100, 108, 100, 107, 1000]]); r.hourlyTs = close + 5 * MIN;
    p.buildDailyNow();
    const d1 = p.getDaily();
    assert.notStrictEqual(d1, d0, "the signature moved when the spine refreshed past the close");
    assert.deepEqual(d1.cashClose["xyz:HOOD"], [close, 107], "the bell's price");
    assert.equal(d1.liveClose["xyz:HOOD"], 107, "liveClose too");
  });
});

// ---- 19. chart card with a bogus file ----------------------------------------------------------------
test("-107 share: a chart card is refused when its picture is missing, in another thread, or not an inline image", async () => {
  const A = freshAccounts();
  try {
    const { g, l } = await seedTwo(A);
    const T = A.threadFor(g.uid, l.uid, true).id;
    const card = { kind: "chart", title: "HOOD / QQQ", t: "HOOD", cols: [], rows: [] };
    assert.match(A.send(g.uid, null, "chart", null, { thread: T, card, fileId: "no-such-file" }).error, /no longer stored/);
    const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]), Buffer.alloc(64, 7)]);
    const txt = A.putFile(g.uid, T, "notes.txt", Buffer.from("levels\n"));
    assert.ok(txt.ok, JSON.stringify(txt));
    assert.match(A.send(g.uid, null, "chart", null, { thread: T, card, fileId: txt.file.id }).error, /needs its picture/);
    const other = A.createGroup(g.uid, "elsewhere", [l.uid]);
    const T2 = other.thread || (other.group && other.group.id) || other.id;
    const png2 = A.putFile(g.uid, T2, "c.png", PNG);
    assert.match(A.send(g.uid, null, "chart", null, { thread: T, card, fileId: png2.file.id }).error, /not yours/);
    const png = A.putFile(g.uid, T, "c.png", PNG);
    assert.ok(A.send(g.uid, null, "chart", null, { thread: T, card, fileId: png.file.id }).ok, "the real thing still posts");
  } finally { A.close(); }
});
