"use strict";
// VACUUM INTO off the event loop (build 2026.09.24-101). The daily candles.db off-copy and the
// accounts.db backups used to run `VACUUM INTO` on the MAIN connection — a full read of the
// archive plus a full write of the copy, synchronously, holding every request, SSE frame and
// poll tick behind it for as long as the disk took (seconds on a large archive). Both databases
// run in WAL mode, which permits a concurrent reader on another connection, so the copy is taken
// by a worker_threads Worker that opens its OWN DatabaseSync on the same file and runs the VACUUM
// there. The live connection keeps serving; the snapshot is the worker's read transaction, which
// is exactly as consistent as the old in-process copy.
//
// Contract: vacuumIntoAsync(src, dest, syncFallback) resolves when `dest` holds the copy and
// rejects with the VACUUM's error. If the worker cannot START (no worker_threads, node:sqlite not
// loadable in the worker, the script missing, a spawn error) it runs `syncFallback()` — the old
// in-process path — so a runtime quirk degrades to the previous behaviour, never to no backup.
// node:sqlite's async backup() was considered: it is a page copy (no compaction), and VACUUM INTO
// is the documented format of these files, so the worker keeps the bytes identical to before.
const path = require("path");
const { isMainThread, parentPort, workerData } = require("worker_threads");

if (!isMainThread && workerData && workerData.__xyzVacuum) {
  // ---- worker side ------------------------------------------------------------------------------
  const openDb = () => {
    try {
      const { DatabaseSync } = require("node:sqlite");
      const d = new DatabaseSync(workerData.src);
      // A writer on the main connection can hold the lock briefly (checkpoint); wait, don't fail.
      try { d.exec("PRAGMA busy_timeout = 5000;"); } catch (_) {}
      return d;
    } catch (e) {
      parentPort.postMessage({ ok: false, stage: "open", error: (e && e.message) || String(e) });
      return null;
    }
  };
  const db = openDb();
  if (db) {
    try {
      db.exec("VACUUM INTO '" + String(workerData.dest).replace(/'/g, "''") + "'");
      parentPort.postMessage({ ok: true });
    } catch (e) {
      parentPort.postMessage({ ok: false, stage: "vacuum", error: (e && e.message) || String(e) });
    }
    try { db.close(); } catch (_) {}
  }
} else {
  // ---- main side --------------------------------------------------------------------------------
  const WORKER_FILE = __filename;
  function vacuumIntoAsync(src, dest, syncFallback, opts) {
    const file = (opts && opts.workerFile) || WORKER_FILE;
    return new Promise((resolve, reject) => {
      let settled = false;
      const fallback = () => {
        if (settled) return; settled = true;
        try { if (syncFallback) syncFallback(); else throw new Error("vacuum worker unavailable"); resolve({ worker: false }); }
        catch (e) { reject(e); }
      };
      let w;
      try {
        const { Worker } = require("worker_threads");
        w = new Worker(file, { workerData: { __xyzVacuum: 1, src: path.resolve(src), dest: path.resolve(dest) } });
      } catch (_) { fallback(); return; }
      w.on("message", (m) => {
        if (settled) return;
        if (m && m.ok) { settled = true; resolve({ worker: true }); return; }
        if (m && m.stage === "open") { fallback(); return; }   // the worker could not open the db: in-process path
        settled = true; reject(new Error((m && m.error) || "VACUUM INTO failed"));
      });
      // An error event or an exit before the worker posted a result is a start failure (missing
      // script, a throw at load, a killed thread): fall back. After a result both are ignored.
      // The fallback owns clearing any partial `dest` the worker left (VACUUM INTO refuses one).
      w.on("error", fallback);
      w.on("exit", fallback);
    });
  }
  module.exports = { vacuumIntoAsync };
}
