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
    ['staggered(safeTick(buildSignals, "buildSignals"), 10 * 60 * 1000, 5 * 1000);', 600, 5],
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
