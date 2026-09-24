"use strict";
// ===== build 2026.09.24-101: performance — backups off the event loop, async persistence ========
// Behaviour pins for the -101 pass: the VACUUM INTO copies run in a worker thread (with an
// in-process fallback), the features blob skips unchanged writes and writes asynchronously on one
// serialized chain, the ledger's periodic persist goes through the async fsync twin, the
// Hyperliquid limiter's running-sum window equals the old filter+reduce, the zip ingest honours
// backpressure, and the sync-heavy timers are phase-staggered without changing cadence.
const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs"), path = require("path"), os = require("os");
const tmpdir = (p) => fs.mkdtempSync(path.join(os.tmpdir(), p));
const src = (f) => fs.readFileSync(path.join(__dirname, "..", f), "utf8");

test("perf -101: vacuumIntoAsync copies in a worker; a worker that cannot start runs the sync fallback", async (t) => {
  let DatabaseSync;
  try { ({ DatabaseSync } = require("node:sqlite")); } catch (_) { return t.skip("node:sqlite unavailable"); }
  const { vacuumIntoAsync } = require("../src/vacuum");
  const dir = tmpdir("xyz-vac-");
  const file = path.join(dir, "live.db");
  const db = new DatabaseSync(file);
  db.exec("PRAGMA journal_mode = WAL; CREATE TABLE t (a INTEGER); INSERT INTO t VALUES (1), (2), (3);");
  let fell = 0;
  const r = await vacuumIntoAsync(file, path.join(dir, "copy.db"), () => { fell++; });
  assert.deepEqual(r, { worker: true }, "the copy ran in the worker");
  assert.equal(fell, 0);
  db.exec("INSERT INTO t VALUES (4);");   // the live connection is untouched and still writable
  const c = new DatabaseSync(path.join(dir, "copy.db"), { readOnly: true });
  assert.equal(c.prepare("SELECT COUNT(*) n FROM t").get().n, 3, "a consistent copy of the state at copy time");
  c.close();
  // A worker script that cannot load: the fallback runs in-process instead of the backup vanishing.
  const r2 = await vacuumIntoAsync(file, path.join(dir, "copy2.db"), () => { fell++; db.exec("VACUUM INTO '" + path.join(dir, "copy2.db").replace(/'/g, "''") + "'"); },
    { workerFile: path.join(dir, "missing-worker.js") });
  assert.deepEqual(r2, { worker: false });
  assert.equal(fell, 1);
  assert.ok(fs.existsSync(path.join(dir, "copy2.db")));
  // A VACUUM that fails in the worker rejects (no silent fallback that would fail the same way).
  fs.mkdirSync(path.join(dir, "blocked.db"));
  await assert.rejects(vacuumIntoAsync(file, path.join(dir, "blocked.db"), () => { fell++; }));
  assert.equal(fell, 1, "a VACUUM error is not a start failure");
  db.close();
});

test("perf -101: snapshotCandlesAsync keeps the .tmp/rename contract and a failure leaves the previous .bak intact", async (t) => {
  const { openStore } = require("../src/store");
  const dir = tmpdir("xyz-snapa-");
  const st = openStore(dir);
  if (!st.candlesEnabled()) return t.skip("node:sqlite unavailable in this runtime");
  const t0 = Math.floor(Date.now() / 300000) * 300000 - 100 * 300000;
  st.insertCandles("xyz:A", [[t0, 1, 2, 0.5, 1.5, 10], [t0 + 300000, 1.5, 2, 1, 1.2, 11]]);
  const bak = path.join(dir, "candles.db.bak");
  assert.equal(await st.snapshotCandlesAsync(), true);
  assert.ok(fs.existsSync(bak) && !fs.existsSync(bak + ".tmp"));
  const { DatabaseSync } = require("node:sqlite");
  const copy = new DatabaseSync(bak, { readOnly: true });
  assert.equal(copy.prepare("SELECT COUNT(*) n FROM candles_5m").get().n, 2);
  copy.close();
  const before = fs.readFileSync(bak);
  fs.mkdirSync(bak + ".tmp");
  assert.equal(await st.snapshotCandlesAsync(), false, "a failing VACUUM reports failure");
  assert.ok(Buffer.compare(fs.readFileSync(bak), before) === 0, "the previous .bak is byte-identical");
  fs.rmSync(bak + ".tmp", { recursive: true });
  // The worker-can't-start path still lands a snapshot (in-process fallback).
  st.insertCandles("xyz:A", [[t0 + 600000, 1.2, 2, 1, 1.3, 12]]);
  assert.equal(await st.snapshotCandlesAsync(null, { workerFile: path.join(dir, "nope.js") }), true);
  const c2 = new DatabaseSync(bak, { readOnly: true });
  assert.equal(c2.prepare("SELECT COUNT(*) n FROM candles_5m").get().n, 3);
  c2.close();
  st.close();
  const pol = src("src/poller.js");
  assert.ok(pol.includes("if (store.snapshotCandlesAsync) store.snapshotCandlesAsync().then(done, () => {});"), "the daily snapshot takes the worker path");
});

test("perf -101: accounts backupAsync — worker copy, same rotation and result shape, serialized", async () => {
  const { openAccounts } = require("../src/accounts");
  const { DatabaseSync } = require("node:sqlite");
  const dir = tmpdir("xyz-acc-bka-");
  const A = openAccounts(dir, { sessionDays: 1 });
  assert.ok((await A.bootstrap("gus", "a-long-password-12")).ok);
  // Two overlapping calls: serialized on one chain, both land, rotation keeps the newest two.
  const [r1, r2] = await Promise.all([A.backupAsync(null, 2), A.backupAsync(null, 2)]);
  assert.ok(r1.ok && r2.ok && r1.bytes > 0, JSON.stringify([r1, r2]));
  const r3 = await A.backupAsync(null, 2);
  assert.ok(r3.ok && r3.kept === 2);
  const left = fs.readdirSync(path.join(dir, "backups")).filter((f) => f.endsWith(".db"));
  assert.equal(left.length, 2, "rotation keeps the newest two");
  assert.ok(!left.some((f) => f.endsWith(".tmp")));
  const copy = new DatabaseSync(r3.file, { readOnly: true });
  assert.equal(copy.prepare("SELECT count(*) AS n FROM user").get().n, 1, "the copy carries the data");
  copy.close();
  assert.equal(A.lastBackup().file, r3.file);
  // Fallback when the worker cannot start.
  const r4 = await A.backupAsync(null, 2, { workerFile: path.join(dir, "nope.js") });
  assert.ok(r4.ok, "the in-process copy still lands");
  // A failure is reported, not thrown.
  const blocker = path.join(dir, "notadir");
  fs.writeFileSync(blocker, "x");
  const bad = await A.backupAsync(blocker, 2);
  assert.equal(bad.ok, false); assert.ok(bad.error);
  A.close();
  assert.ok(/ACCOUNTS\.backupAsync\(process\.env\.ACCOUNTS_BACKUP_DIR \|\| null, 7\)/.test(src("server.js")), "the schedule uses the async path");
});

test("perf -101: saveFeaturesAsync serializes writes, never interleaves, and a sync save supersedes an in-flight one", async () => {
  const { openStore } = require("../src/store");
  const dir = tmpdir("xyz-feat-");
  const st = openStore(dir);
  const big = (n) => ({ ts: n, markets: { A: { daily: Array.from({ length: 20000 }, (_, i) => [i, n]) } } });
  // Fire several overlapping writes; each must resolve true and the LAST one must be the file.
  const ps = [1, 2, 3, 4, 5].map((n) => st.saveFeaturesAsync(big(n)));
  const res = await Promise.all(ps);
  assert.deepEqual(res, [true, true, true, true, true]);
  assert.equal(st.loadFeatures().ts, 5, "writes land in call order — the last call wins");
  assert.ok(!fs.readdirSync(dir).some((f) => /features\.json\.a?tmp/.test(f)), "no temp files left behind");
  // An async write in flight, then a synchronous (shutdown) save: the older blob must not land over it.
  const inflight = st.saveFeaturesAsync(big(6));
  st.saveFeatures(big(7));
  assert.equal(await inflight, false, "superseded");
  assert.equal(st.loadFeatures().ts, 7);
  // Serialized: at most one write in flight — observe via a wrapped fs.promises.writeFile.
  const orig = fs.promises.writeFile;
  let live = 0, peak = 0;
  fs.promises.writeFile = async (...a) => { live++; peak = Math.max(peak, live); try { await new Promise((r) => setTimeout(r, 5)); return await orig.apply(fs.promises, a); } finally { live--; } };
  try { await Promise.all([8, 9, 10].map((n) => st.saveFeaturesAsync(big(n)))); }
  finally { fs.promises.writeFile = orig; }
  assert.equal(peak, 1, "never two writes in flight");
  assert.equal(st.loadFeatures().ts, 10);
  st.close();
});

test("perf -101: persistFeaturesAsync skips when nothing it reads changed, and writes when anything does", async () => {
  const { createPoller } = require("../src/poller");
  const writes = [];
  const store = { loadAll: () => new Map(), loadRegime: () => [], loadLedger: () => null, saveLedger: () => {}, insert: () => {}, saveRegime: () => {},
    loadFeatures: () => null, saveFeatures: (d) => writes.push(["sync", d]),
    saveFeaturesAsync: (d) => { writes.push(["async", d]); return Promise.resolve(true); } };
  const p = createPoller({ dex: "xyz", store, log: () => {}, version: "test", crypto: false });
  p.seedRowNow("xyz:F1", { ticker: "F1", px: 10, feat: { a: 1 }, dailyRaw: [{ t: 1, c: 10 }], dailyTs: 5 });
  p.seedRowNow("xyz:F2", { ticker: "F2", px: 10, feat: { a: 2 } });
  assert.equal(await p.persistFeaturesAsync(), "written");
  assert.equal(writes.length, 1); assert.equal(writes[0][0], "async");
  assert.ok(writes[0][1].markets["xyz:F1"] && writes[0][1].markets["xyz:F2"]);
  assert.equal(await p.persistFeaturesAsync(), "skipped", "unchanged inputs: no serialize, no write");
  assert.equal(writes.length, 1);
  // A replaced feat object (what refreshHourly does) is a change.
  p.rowNow("xyz:F2").feat = { a: 3 };
  assert.equal(await p.persistFeaturesAsync(), "written");
  assert.equal(writes[1][1].markets["xyz:F2"].feat.a, 3);
  // An in-place premium sample (samplePrem pushes) is a change.
  const r1 = p.rowNow("xyz:F1"); r1.premH = [[1000, 1]];
  assert.equal(await p.persistFeaturesAsync(), "written");
  r1.premH.push([2000, 2]);
  assert.equal(await p.persistFeaturesAsync(), "written");
  assert.equal(await p.persistFeaturesAsync(), "skipped");
  // Daily spine replaced; funding-backfill stamp; a delisting (the market leaves the blob).
  r1.dailyRaw = [{ t: 1, c: 10 }, { t: 2, c: 11 }];
  assert.equal(await p.persistFeaturesAsync(), "written");
  r1.fundBackfilled = true;
  assert.equal(await p.persistFeaturesAsync(), "written");
  p.rowNow("xyz:F2").delisted = true;
  assert.equal(await p.persistFeaturesAsync(), "written");
  assert.equal(writes[writes.length - 1][1].markets["xyz:F2"], undefined);
  // A failed write does not advance the signature: the next tick retries.
  store.saveFeaturesAsync = () => Promise.resolve(false);
  r1.feat = { a: 9 };
  assert.equal(await p.persistFeaturesAsync(), "failed");
  store.saveFeaturesAsync = (d) => { writes.push(["async", d]); return Promise.resolve(true); };
  assert.equal(await p.persistFeaturesAsync(), "written", "retried");
  // The sync path (shutdown) always writes and advances the signature.
  const n = writes.length;
  p.persistFeatures();
  assert.equal(writes.length, n + 1); assert.equal(writes[n][0], "sync");
  assert.equal(await p.persistFeaturesAsync(), "skipped");
  const pol = src("src/poller.js");
  assert.ok(pol.includes('staggered(() => { persistFeaturesAsync().catch((e) => log("features persist failed (isolated): " + (e && e.message))); }, 120 * 1000, 11 * 1000);'), "the 120s timer takes the async path, same cadence");
  const srv = src("server.js");
  assert.ok((srv.match(/try \{ poller\.persistFeatures\(\); \} catch \(_\) \{\}/g) || []).length === 2, "shutdown and crash keep the synchronous write");
});

test("perf -101: saveLedgerAsync — same durable sequence, serialized, .bak kept, superseded by a sync save", async () => {
  const { openStore } = require("../src/store");
  const dir = tmpdir("xyz-ledg-");
  const st = openStore(dir);
  const lf = path.join(dir, "ledger.json");
  assert.equal(await st.saveLedgerAsync({ ts: 1, open: [], closed: [] }), true);
  assert.equal(JSON.parse(fs.readFileSync(lf, "utf8")).ts, 1);
  const res = await Promise.all([2, 3, 4].map((ts) => st.saveLedgerAsync({ ts, open: [], closed: [] })));
  assert.deepEqual(res, [true, true, true]);
  assert.equal(JSON.parse(fs.readFileSync(lf, "utf8")).ts, 4, "call order preserved");
  assert.equal(JSON.parse(fs.readFileSync(lf + ".bak", "utf8")).ts, 3, "the previous version is the .bak");
  const inflight = st.saveLedgerAsync({ ts: 5, open: [], closed: [] });
  st.saveLedger({ ts: 6, open: [], closed: [] });   // the shutdown export
  assert.equal(await inflight, false);
  assert.equal(st.loadLedger().ts, 6, "the older async blob never lands over the shutdown write");
  assert.ok(!fs.existsSync(lf + ".atmp") && !fs.existsSync(lf + ".tmp"));
  const cyc = {}; cyc.self = cyc;
  assert.equal(await st.saveLedgerAsync(cyc), false, "an unserializable blob resolves false, never throws");
  st.close();
  const sto = src("src/store.js");
  assert.ok(/await fh\.writeFile\(body\); await fh\.sync\(\);/.test(sto) && /await dh\.sync\(\)/.test(sto), "FileHandle write + fsync, then the directory fsync");
  const pol = src("src/poller.js");
  assert.ok(pol.includes("ledgerT = null; persistLedgerAsync().catch("), "the ~2s batch timer takes the async path");
});

test("perf -101: the limiter's running-sum window equals the old filter+reduce on random traffic", () => {
  const { usageWindow } = require("../src/hyperliquid");
  let seed = 11; const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
  for (const W of [60000, 1000]) {
    const win = usageWindow(W);
    let ref = [], now = 1_700_000_000_000;
    for (let i = 0; i < 20000; i++) {
      // Mostly forward time; occasionally a small step backwards (a wall-clock correction).
      now += rnd() < 0.03 ? -Math.floor(rnd() * 500) : Math.floor(rnd() * (W / 40));
      if (rnd() < 0.6) { const w = 1 + Math.floor(rnd() * 90); win.push(now, w); ref.push({ t: now, w }); }
      if (rnd() < 0.5) {
        ref = ref.filter((e) => now - e.t < W);
        const used = ref.reduce((s, e) => s + e.w, 0);
        assert.equal(win.used(now), used, "step " + i);
        assert.equal(win.size(), ref.length);
        assert.equal(win.oldest(), ref.length ? Math.min(...ref.map((e) => e.t)) : null);
      }
    }
  }
  const hl = src("src/hyperliquid.js");
  const lim = hl.slice(hl.indexOf("const limiter = (() => {"), hl.indexOf("function limiterUsage()"));
  assert.ok(lim.includes("const win = usageWindow(60000);") && !/\.filter\(|\.reduce\(/.test(lim), "no per-grant filter/reduce left in the Hyperliquid limiter");
});

test("perf -101: webBodyToFile waits for 'drain' instead of buffering the whole download", async () => {
  const { webBodyToFile } = require("../src/poller");
  const dir = tmpdir("xyz-zip-");
  const file = path.join(dir, "big.bin");
  const chunk = Buffer.alloc(256 * 1024, 7), N = 40;
  let pulled = 0;
  const body = new ReadableStream({ pull(ctrl) { if (pulled >= N) { ctrl.close(); return; } pulled++; ctrl.enqueue(new Uint8Array(chunk)); } }, { highWaterMark: 0 });
  // Watch the write stream's buffered bytes while it runs: with backpressure honoured it never
  // holds more than one chunk past its 16 KB highWaterMark.
  const origCreate = fs.createWriteStream;
  let peak = 0;
  fs.createWriteStream = (...a) => { const w = origCreate(...a); const ow = w.write.bind(w); w.write = (b) => { const r = ow(b); peak = Math.max(peak, w.writableLength); return r; }; return w; };
  try { await webBodyToFile(body, file); } finally { fs.createWriteStream = origCreate; }
  assert.equal(fs.statSync(file).size, chunk.length * N, "every byte landed");
  assert.ok(peak <= chunk.length * 2, "buffered at most ~one chunk ahead (peak " + peak + ")");
  // A write error surfaces as a rejection (not an unhandled 'error' event) and cancels the body.
  let cancelled = false;
  const body2 = new ReadableStream({ pull(ctrl) { ctrl.enqueue(new Uint8Array(16)); }, cancel() { cancelled = true; } });
  await assert.rejects(webBodyToFile(body2, path.join(dir, "no", "such", "dir", "f.bin")));
  assert.ok(cancelled, "the download is cancelled on a write error");
  const pol = src("src/poller.js");
  assert.equal((pol.match(/await webBodyToFile\(res\.body, tmpZip\);/g) || []).length, 2, "both zip ingests use it");
  assert.ok(!/w\.write\(Buffer\.from\(value\)\); \}/.test(pol), "no blind write loop left");
});

test("perf -101: sync-heavy periodic jobs are phase-staggered, cadences unchanged", () => {
  const pol = src("src/poller.js");
  assert.ok(pol.includes("const staggered = (fn, ms, phaseMs) => setTimeout(() => setInterval(fn, ms), phaseMs);"));
  const jobs = [
    ['setInterval(safeTick(buildSnapshot, "buildSnapshot"), 15 * 1000);', 15, 0],
    ['staggered(() => store.flush(), 30 * 1000, 3 * 1000);', 30, 3],
    ['staggered(signalsThenActionable, 10 * 60 * 1000, 5 * 1000);', 600, 5],
    ['staggered(safeTick(buildDaily, "buildDaily"), 60 * 1000, 8 * 1000);', 60, 8],
    ['staggered(() => { persistFeaturesAsync()', 120, 11],
  ];
  for (const [pin] of jobs) assert.ok(pol.includes(pin), "missing: " + pin);
  // No two of them ever fire in the same second over a day: fire times are phase + k*period.
  const seen = new Map();
  for (const [pin, per, ph] of jobs) for (let t = ph + per; t < 86400; t += per) {
    assert.ok(!seen.has(t), pin + " collides with " + seen.get(t) + " at t=" + t);
    seen.set(t, pin);
  }
});

test("perf -101: README documents the pass", () => {
  assert.ok(src("README.md").includes("**Performance (build 2026.09.24-101).**"), "README entry");
});

// ===== build 2026.09.24-102: skip unchanged builds, memoized funding/OI windows, incremental =====
// history thinning, byte-bounded LRU, and the shutdown rename race left by -101. Every memo is
// pinned against its fresh computation on the same inputs at the same clock.
const HOUR_ = 3600e3, DAY_ = 86400e3;
const mkStubStore = () => ({ loadAll: () => new Map(), loadRegime: () => [], loadLedger: () => null, saveLedger: () => {}, insert: () => {}, saveRegime: () => {},
  loadFeatures: () => null, saveFeatures: () => {} });
const newPoller = () => require("../src/poller").createPoller({ dex: "xyz", store: mkStubStore(), log: () => {}, version: "test", crypto: false });
const withNow = (t, fn) => { const o = Date.now; Date.now = () => t; try { return fn(); } finally { Date.now = o; } };
let seedP = 11; const prng = () => (seedP = (seedP * 16807) % 2147483647) / 2147483647;

test("perf -102: a sync save that lands while an async rename is in flight is re-landed — the older copy never wins", async () => {
  const { openStore } = require("../src/store");
  const dir = tmpdir("xyz-race-");
  const st = openStore(dir);
  const lf = path.join(dir, "ledger.json");
  const orig = fs.promises.rename;
  // The worst interleaving: the async path passed its generation check and queued its rename; the
  // sync (shutdown) save runs to completion first; only then does the threadpool rename land.
  const racing = (syncSave) => { fs.promises.rename = async (a, b) => { fs.promises.rename = orig; syncSave(); return orig.call(fs.promises, a, b); }; };
  try {
    racing(() => st.saveFeatures({ ts: 2, markets: {} }));
    assert.equal(await st.saveFeaturesAsync({ ts: 1, markets: {} }), false, "reported superseded");
    assert.equal(st.loadFeatures().ts, 2, "the newer sync features blob is the file");
    racing(() => st.saveLedger({ ts: 20, open: [], closed: [] }));
    assert.equal(await st.saveLedgerAsync({ ts: 10, open: [], closed: [] }), false);
    assert.equal(st.loadLedger().ts, 20, "the newer sync ledger is the file");
    // No overlap: nothing to re-land, the async write stands.
    assert.equal(await st.saveLedgerAsync({ ts: 30, open: [], closed: [] }), true);
    assert.equal(st.loadLedger().ts, 30);
    assert.ok(!fs.readdirSync(dir).some((f) => /\.a?tmp/.test(f)), "no temp files left behind");
    assert.ok(!fs.existsSync(lf + ".atmp"));
  } finally { fs.promises.rename = orig; }
  // drainWrites: settles the queues; bounded by its timeout.
  const origW = fs.promises.writeFile; let release, entered;
  const inWrite = new Promise((r) => { entered = r; });
  fs.promises.writeFile = (...a) => new Promise((r) => { release = () => r(origW.apply(fs.promises, a)); entered(); });
  try {
    const w = st.saveFeaturesAsync({ ts: 3, markets: {} });
    await inWrite;   // the write is in flight and held
    assert.equal(await st.drainWrites(30), false, "a stuck write times out instead of holding the exit");
    release();
    assert.equal(await w, true);
    assert.equal(await st.drainWrites(1000), true);
    assert.equal(st.loadFeatures().ts, 3);
  } finally { fs.promises.writeFile = origW; }
  st.close();
  const srv = src("server.js");
  const sd = srv.slice(srv.indexOf("async function shutdown()"), srv.indexOf("process.exit(0);"));
  assert.ok(sd.indexOf("await store.drainWrites(5000)") > 0 && sd.indexOf("await store.drainWrites(5000)") < sd.indexOf("poller.persistFeatures()"),
    "graceful shutdown awaits in-flight async writes before its final sync saves");
});

test("perf -102: fundSet keeps getFunding's memo equal to a fresh sorted rebuild, without re-sorting", () => {
  const p = newPoller();
  const r = p.seedRowNow("xyz:FS", { ticker: "FS", px: 10, funding: 1e-5 });
  const P = p.perfNow;
  const fresh = () => { const cut = Date.now() - 60 * DAY_, out = []; for (const [t, v] of r.fundH) if (t >= cut && Number.isFinite(v)) out.push([t, v]); return out.sort((a, b) => a[0] - b[0]); };
  let now = Math.floor(Date.now() / HOUR_) * HOUR_;
  for (let h = 70 * 24; h > 0; h--) r.fundH.set(now - h * HOUR_, (prng() - 0.5) * 1e-4);
  r._fVer = (r._fVer || 0) + 1;
  withNow(now + 1000, () => assert.deepEqual(P.getFunding("xyz:FS"), fresh()));
  const origSort = Array.prototype.sort; let sorts = 0;
  for (let k = 0; k < 400; k++) {
    now += 30e3 * (1 + Math.floor(prng() * 20));   // polls, sometimes rolling the hour
    withNow(now, () => {
      const t = Math.floor(now / HOUR_) * HOUR_;
      const v = prng() < 0.1 ? r.fundH.get(t) : (prng() < 0.03 ? NaN : (prng() - 0.5) * 1e-4);   // unchanged values and non-finite rates too
      const before = r._fVer;
      if (v !== undefined) P.fundSet(r, t, v);
      if (v !== undefined && Object.is(r.fundH.get(t), v) && before === r._fVer) assert.ok(true);
      Array.prototype.sort = function (...a) { sorts++; return origSort.apply(this, a); };
      let got; try { got = P.getFunding("xyz:FS"); } finally { Array.prototype.sort = origSort; }
      assert.deepEqual(got, fresh(), "step " + k);
    });
  }
  assert.ok(sorts < 60, "the forward-fill path does not re-sort per poll (sorts: " + sorts + ")");
  // An out-of-order (older-hour) write falls back to the full rebuild and stays exact.
  withNow(now, () => { P.fundSet(r, Math.floor(now / HOUR_) * HOUR_ - 5 * HOUR_, 7e-5); assert.deepEqual(P.getFunding("xyz:FS"), fresh()); });
  const same = r._fVer; withNow(now, () => P.fundSet(r, Math.floor(now / HOUR_) * HOUR_ - 5 * HOUR_, 7e-5));
  assert.equal(r._fVer, same, "rewriting the same value is not a change");
});

test("perf -102: fundPctOf equals the full scan across writes, rate changes and the moving 31d cut", () => {
  const p = newPoller();
  const r = p.seedRowNow("xyz:FP", { ticker: "FP", px: 10, funding: 2e-5 });
  const P = p.perfNow;
  const scan = () => { if (r.funding == null || !isFinite(r.funding) || !r.fundH.size) return null;
    const cut = Date.now() - 31 * DAY_; let n = 0, le = 0;
    for (const [t, rate] of r.fundH) { if (t < cut || !isFinite(rate)) continue; n++; if (rate <= r.funding) le++; }
    return n >= 96 ? Math.round((100 * le) / n) : null; };
  let now = Math.floor(Date.now() / HOUR_) * HOUR_;
  for (let h = 40 * 24; h > 0; h--) r.fundH.set(now - h * HOUR_, (prng() - 0.5) * 1e-4);
  r._fVer = (r._fVer || 0) + 1;
  for (let k = 0; k < 500; k++) {
    now += 15e3 * (1 + Math.floor(prng() * 30));
    withNow(now, () => {
      const x = prng();
      if (x < 0.3) P.fundSet(r, Math.floor(now / HOUR_) * HOUR_, (prng() - 0.5) * 1e-4);
      else if (x < 0.4) r.funding = (prng() - 0.5) * 1e-4;
      else if (x < 0.42) { r.fundH.set(now - 20 * DAY_ + Math.floor(prng() * 1e6), 1e-4); }   // a test-style raw write: the size guard catches it
      assert.equal(P.fundPctOf(r), scan(), "step " + k);
    });
  }
  // few samples: an honest null, exactly as the scan
  const q = p.seedRowNow("xyz:FQ", { ticker: "FQ", px: 1, funding: 1e-5 });
  q.fundH.set(now - HOUR_, 1e-5);
  assert.equal(P.fundPctOf(q), null);
  const pol = src("src/poller.js");
  assert.ok((pol.match(/fundPctOf\(r\)/g) || []).length >= 3, "snapshot, duel and earnings setups share the one memoized definition");
});

test("perf -102: computeFundWin — the memoized d7/d30 legs equal fresh fundingAvg at the same clock; short legs always fresh", () => {
  const { fundingAvg } = require("../src/compute");
  const p = newPoller();
  const r = p.seedRowNow("xyz:FW", { ticker: "FW", px: 10 });
  const now0 = Math.floor(Date.now() / 60000) * 60000;
  const h = []; for (let t = now0 - 32 * DAY_; t <= now0; t += 4.5 * 60e3) h.push([t, 1e6, (prng() - 0.5) * 1e-4]);
  p.seedHistNow("xyz:FW", h);
  const TF = { h1: HOUR_, h4: 4 * HOUR_, d1: DAY_, d7: 7 * DAY_, d30: 30 * DAY_ };
  const fresh = () => { const o = {}; for (const k in TF) o[k] = fundingAvg(h, TF[k]); return o; };
  let t = now0;
  withNow(t, () => assert.deepEqual(p.perfNow.computeFundWin(r), fresh()));
  withNow(t + 30e3, () => { const got = p.perfNow.computeFundWin(r), f = fresh();
    assert.equal(got.h1, f.h1); assert.equal(got.h4, f.h4); assert.equal(got.d1, f.d1); });   // same minute: long legs memoized, short legs fresh
  t += 60e3; withNow(t, () => assert.deepEqual(p.perfNow.computeFundWin(r), fresh(), "a new minute recomputes"));
  h.push([t + 1, 1e6, 5e-4]);
  withNow(t + 2, () => assert.deepEqual(p.perfNow.computeFundWin(r), fresh(), "a new sample recomputes within the minute"));
});

test("perf -102: incremental thinning equals the daily batch thin; oiDailySeriesM and getSeries equal their fresh twins", () => {
  const p = newPoller();
  const P = p.perfNow, coin = "xyz:TH";
  p.seedRowNow(coin, { ticker: "TH", px: 10 });
  const FULL = 31 * DAY_, RET = 365 * DAY_;
  let now = Math.floor(Date.now() / HOUR_) * HOUR_;
  // 60 days at ~4.5 min (never thinned yet): the shape oi.log hands back before a maintenance pass
  const h = []; for (let t = now - 60 * DAY_; t <= now; t += 4.5 * 60e3 + Math.floor(prng() * 20e3)) h.push([t, 1e6 * (1 + prng()), prng() < 0.05 ? null : (prng() - 0.5) * 1e-4]);
  p.seedHistNow(coin, h);
  // maintenance's batch rule, verbatim
  const batch = (arr, full) => { const out = []; let lastHb = -1;
    for (const k of arr) { if (k[0] >= full) { out.push(k); continue; } const hb = Math.floor(k[0] / HOUR_); if (hb !== lastHb) { out.push(k); lastHb = hb; } }
    return out; };
  const series = () => { const oi = [], funding = []; for (const s of h) { oi.push([s[0], s[1]]); if (s[2] != null) funding.push([s[0], s[2]]); } return { oi, funding }; };
  let prevMut = P.histMut(h);
  for (let k = 0; k < 2000; k++) {
    now += 4.5 * 60e3 + Math.floor(prng() * 30e3);
    const ref = h.slice();
    h.push([now, 1e6 * (1 + prng()), (prng() - 0.5) * 1e-4]); ref.push(h[h.length - 1]);
    P.histRetain(coin, h, now, now - RET);
    // the invariant: whatever has been thinned so far is exactly the batch thin at SOME cut <= now-FULL,
    // and forcing the pass now gives the batch thin at now-FULL
    if (k % 97 === 0) {
      P.histThinTo(h, now - FULL);
      assert.deepEqual(h, batch(ref, now - FULL), "step " + k);
    }
    assert.ok(h.every((s, i) => i === 0 || s[0] > h[i - 1][0]), "ascending");
    if (h.length !== ref.length) { assert.ok(P.histMut(h) > prevMut, "a thin bumps the mutation count"); prevMut = P.histMut(h); }
    if (k % 13 === 0) {
      assert.deepEqual(P.oiDailySeriesM(coin), P.oiDailySeries(coin), "oiDailySeriesM step " + k);
      assert.deepEqual(P.getSeries(coin), series(), "getSeries step " + k);
    }
  }
  // no full-resolution sample older than the window + an hour of slack survives past a push
  assert.ok(h.filter((s) => s[0] < now - FULL - 2 * HOUR_).every((s, i, a) => i === 0 || Math.floor(s[0] / HOUR_) !== Math.floor(a[i - 1][0] / HOUR_)), "aged samples are hourly");
  // memo identity: repeated calls with nothing new return the same arrays
  assert.strictEqual(P.getSeries(coin), P.getSeries(coin));
  assert.strictEqual(P.oiDailySeriesM(coin), P.oiDailySeriesM(coin));
  // front trim: one splice, same result as the old shift loop
  const trimmed = h.filter((s) => s[0] >= now - 40 * DAY_);
  P.histRetain(coin, h, now, now - 40 * DAY_);
  assert.deepEqual(h, trimmed);
  assert.deepEqual(P.oiDailySeriesM(coin), P.oiDailySeries(coin), "after a front trim");
  // crypto keeps its flat window (only the retention trim runs)
  const c = []; for (let t = now - 40 * DAY_; t <= now; t += 4.5 * 60e3) c.push([t, 1, 1e-5]);
  const n0 = c.length; P.histRetain("CRY", c, now, now - RET);
  assert.equal(c.length, n0, "crypto series are not thinned here");
  const pol = src("src/poller.js");
  assert.ok(!/while \(h\.length && h\[0\]\[0\] < cut\) h\.shift\(\);/.test(pol), "no shift loop left in sampleOI");
});

// Two pollers seeded identically: A builds repeatedly through its memos while the inputs move; B is
// built once, cold, at the end. The payloads must be the same bytes.
function seedTwin(p, now) {
  seedP = 101;
  const mkH = (px) => { const a = []; let c = px; for (let i = 20 * 24; i > 0; i--) { const o = c; c *= 1 + (prng() - 0.5) * 0.01; a.push([now - i * HOUR_, o, Math.max(o, c), Math.min(o, c), c, 1000 + prng() * 5000]); } return a; };
  const mkD = (px, full) => { const a = []; let c = px; for (let i = 60; i > 0; i--) { const o = c; c *= 1 + (prng() - 0.5) * 0.03; a.push(full ? { t: Math.floor(now / DAY_) * DAY_ - i * DAY_, o, h: Math.max(o, c), l: Math.min(o, c), c, v: 1e5 } : { t: Math.floor(now / DAY_) * DAY_ - i * DAY_, c }); } return a; };
  for (let i = 0; i < 6; i++) {
    const px = 20 + prng() * 100, fh = new Map();
    for (let h = 40 * 24; h > 0; h--) fh.set(Math.floor(now / HOUR_) * HOUR_ - h * HOUR_, (prng() - 0.5) * 1e-4);
    p.seedRowNow("xyz:T" + i, { px, ticker: "T" + i, uni: "xyz", vol: 1e6, oi: 1e6, oiBase: 1e5 * (1 + prng()), funding: (prng() - 0.5) * 1e-4, fundH: fh, prevDay: px * 0.99,
      hourlyRaw: mkH(px), hourlyTs: now, dailyRaw: i % 3 === 2 ? null : mkD(px, i % 3 === 0), dailyTs: now, feat: { volH: 1, volD: 2 }, ref: { p1h: px, p4h: px, p7d: px, p30d: px } });
    const hs = []; let oi = 1e6; for (let t = now - 35 * DAY_; t <= now; t += 4.5 * 60e3) { oi *= 1 + (prng() - 0.5) * 0.002; hs.push([t, oi, (prng() - 0.5) * 1e-4]); }
    p.seedHistNow("xyz:T" + i, hs);
  }
}
test("perf -102: buildDaily — the signature pass returns the same object when nothing moved, and a memoized rebuild is byte-equal to a cold one", () => {
  const now = Math.floor(Date.now() / 60000) * 60000;
  withNow(now, () => {
    const A = newPoller(); seedTwin(A, now);
    A.buildDailyNow(); const d0 = A.getDaily();
    A.buildDailyNow(); assert.strictEqual(A.getDaily(), d0, "unchanged: same object, same ETag");
    // move inputs: a funding forward-fill, an appended OI sample into a new day, a replaced daily spine
    const r1 = A.rowNow("xyz:T1"); A.perfNow.fundSet(r1, Math.floor(now / HOUR_) * HOUR_, 3e-5);
    A.buildDailyNow(); assert.strictEqual(A.getDaily(), d0, "a funding write alone never busted the daily signature (unchanged behaviour)");
    const hs0 = A.histNow("xyz:T0"); hs0.push([Math.floor(now / DAY_) * DAY_ + DAY_ + 60e3, 2e6, 1e-5]);
    const r2 = A.rowNow("xyz:T3"); r2.dailyRaw = r2.dailyRaw.concat([{ t: Math.floor(now / DAY_) * DAY_, o: 1, h: 2, l: 1, c: 1.5, v: 1e5 }]);
    A.buildDailyNow(); const dA = A.getDaily();
    assert.notStrictEqual(dA, d0);
    const B = newPoller(); seedTwin(B, now);
    B.perfNow.fundSet(B.rowNow("xyz:T1"), Math.floor(now / HOUR_) * HOUR_, 3e-5);
    B.histNow("xyz:T0").push([Math.floor(now / DAY_) * DAY_ + DAY_ + 60e3, 2e6, 1e-5]);
    const b2 = B.rowNow("xyz:T3"); b2.dailyRaw = b2.dailyRaw.concat([{ t: Math.floor(now / DAY_) * DAY_, o: 1, h: 2, l: 1, c: 1.5, v: 1e5 }]);
    B.buildDailyNow(); const dB = B.getDaily();
    const strip = (d) => JSON.stringify({ ...d, ts: 0, dataTs: 0 });
    assert.equal(strip(dA), strip(dB), "memoized build == cold build");
    assert.ok(Object.keys(dA.oi).length && Object.keys(dA.funding).length && Object.keys(dA.daily).length, "fixture exercises every series");
  });
});

test("perf -102: buildSnapshot — memoized fundPct/fund windows/trims and the cached signature strings give the cold build's bytes", () => {
  const now = Math.floor(Date.now() / 60000) * 60000;
  withNow(now, () => {
    const A = newPoller(); seedTwin(A, now);
    A.buildSnapshotNow(); const s0 = A.getSnapshot();
    A.buildSnapshotNow(); assert.strictEqual(A.getSnapshot(), s0, "unchanged: same object");
    A.rowNow("xyz:T2").funding = 9e-5;
    A.buildSnapshotNow(); const sA = A.getSnapshot();
    assert.notStrictEqual(sA, s0, "a moved rate busts the signature (fundPct/funding ride it)");
    A.rowNow("xyz:T4").ref = { p1h: 1, p4h: 2, p7d: 3, p30d: 4 };
    A.buildSnapshotNow(); const sA2 = A.getSnapshot();
    assert.notStrictEqual(sA2, sA, "a replaced ref busts it (identity-cached JSON)");
    const B = newPoller(); seedTwin(B, now);
    B.rowNow("xyz:T2").funding = 9e-5; B.rowNow("xyz:T4").ref = { p1h: 1, p4h: 2, p7d: 3, p30d: 4 };
    B.buildSnapshotNow(); const sB = B.getSnapshot();
    const strip = (s) => JSON.stringify((s.markets || []).map((m) => ({ ...m, p5m: undefined, p15m: undefined })));   // the 5m/15m ring grows per build by design
    assert.equal(strip(sA2), strip(sB), "memoized snapshot rows == cold rows");
    assert.ok(sB.markets.some((m) => m.fundPct != null) && sB.markets.some((m) => m.fundByWin && m.fundByWin.d30 != null), "fixture exercises fundPct and the long windows");
  });
});

test("perf -102: keyed cache — byte-bounded LRU, hits refresh recency, slots replace their previous version, gzip bytes counted", () => {
  const { _makeKeyedCache, KEYED_MAX_BYTES, KEYED_MAX_ENTRIES } = require("../server.js");
  assert.equal(KEYED_MAX_BYTES, 64 * 1024 * 1024); assert.equal(KEYED_MAX_ENTRIES, 800);
  const c = _makeKeyedCache(1000, 5);
  const s = (n) => "x".repeat(n);
  c.put("a", s(300)); c.put("b", s(300)); c.put("c", s(300));
  assert.deepEqual(c.stats(), { entries: 3, bytes: 900, slots: 0 });
  c.get("a");   // a is now most recent
  c.put("d", s(300));   // over 1000 bytes: evicts the LEAST recently used (b), not the oldest inserted (a)
  assert.deepEqual(c.keys(), ["c", "a", "d"]);
  assert.equal(c.stats().bytes, 900);
  const e = c.get("d"); c.addGz(e, Buffer.alloc(200));
  assert.deepEqual(c.keys(), ["a", "d"], "the gzip Buffer counts: c evicted to fit it");
  assert.equal(c.stats().bytes, 800);
  // slots: a new version of the same payload replaces the old one
  c.put("chart|1", s(10), "chart"); c.put("chart|2", s(10), "chart");
  assert.ok(!c.keys().includes("chart|1") && c.keys().includes("chart|2"));
  assert.equal(c.stats().slots, 1);
  // entry cap still holds
  for (let i = 0; i < 10; i++) c.put("k" + i, s(1));
  assert.ok(c.stats().entries <= 5);
  // a dropped entry's late gzip does not corrupt the account
  const x = c.put("late", s(10)); c.put("late2", s(995));   // evicts "late"
  assert.ok(!c.keys().includes("late"));
  const before = c.stats().bytes; c.addGz(x, Buffer.alloc(50));
  assert.equal(c.stats().bytes, before);
  const srv = src("server.js");
  assert.ok(!/keyedCache\.size > 800/.test(srv), "entry-count-only eviction is gone");
  assert.ok(srv.includes('slot = "candles|" + coin + "|tf:" + String(tf).toLowerCase() + cpair;') && srv.includes("key = slot + \"|\" + cs.st + \"|\" + bucket;"), "tf candles keep the price bucket in the key, one live version per chart");
});

test("perf -102: README documents the pass", () => {
  assert.ok(src("README.md").includes("**Performance (build 2026.09.24-102).**"), "README entry");
});
