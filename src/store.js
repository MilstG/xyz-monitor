"use strict";
// Persistent open-interest history WITHOUT native dependencies.
// OI accrues over time and can't be re-fetched, so every sample is appended to a plain
// NDJSON-ish log on the mounted volume. On boot we read it back into memory; a daily
// compaction rewrites the file with only the last 31 days. No build toolchain required.
const fs = require("fs");
const path = require("path");
const readline = require("readline");

const MAX_BUF = 50000; // hard cap on unflushed lines if the volume is unwritable

function openStore(dataDir) {
  fs.mkdirSync(dataDir, { recursive: true });
  const file = path.join(dataDir, "oi.log");
  const featFile = path.join(dataDir, "features.json");
  const regimeFile = path.join(dataDir, "regime.json");
  const hourlyFile = path.join(dataDir, "hourly.json");
  const ledgerFile = path.join(dataDir, "ledger.json");
  const beatFile = path.join(dataDir, "volume-heartbeat.json");
  let buf = [];
  let pruning = false;   // while true, hold appends in `buf` so we never touch the file mid-rewrite

  function flush() {
    if (!buf.length || pruning) return;
    try { fs.appendFileSync(file, buf.join("")); buf = []; }
    catch (_) {
      // Keep the buffer for the next attempt, but don't let it grow without bound if the
      // volume is detached/full — drop the oldest half so memory stays bounded.
      if (buf.length > MAX_BUF) buf = buf.slice(buf.length >> 1);
    }
  }

  return {
    insert(coin, ts, oi, funding) {
      buf.push(coin + "\t" + ts + "\t" + oi + "\t" + (funding == null ? "" : funding) + "\n");
      if (buf.length >= 200) flush();
    },
    flush,
    // Daily compaction. Streams the log to a temp file line-by-line (so it never loads the
    // whole thing into memory or blocks the event loop) and atomically renames it into place
    // (so a crash mid-prune can't leave a half-written log). Appends are held in `buf` while
    // this runs and flushed to the new file afterward. Async: callers should await it.
    // Two-tier retention: everything newer than keepFullAfter stays at full (~5 min) resolution;
    // between `before` and keepFullAfter one sample per (coin, hour) survives; older than
    // `before` is dropped. A year of positioning history at ~30x less disk/RAM than full res —
    // this is what the squeeze/fundflip studies and OI-conditioned branches feed on.
    async prune(before, keepFullAfter, shortFn, shortBefore) {
      if (pruning) return 0;
      flush();                              // fold buffered samples into the file first
      if (!fs.existsSync(file)) return 0;
      pruning = true;
      const tmp = file + ".tmp";
      let removed = 0;
      const full = Number.isFinite(keepFullAfter) ? keepFullAfter : before;
      const lastHour = new Map();           // coin -> last hourly bucket kept in the thinned band
      try {
        await new Promise((resolve, reject) => {
          const input = fs.createReadStream(file, { encoding: "utf8" });
          const output = fs.createWriteStream(tmp);
          const rl = readline.createInterface({ input, crlfDelay: Infinity });
          rl.on("line", (ln) => {
            if (!ln) return;
            const i1 = ln.indexOf("\t"), i2 = ln.indexOf("\t", i1 + 1);
            if (i1 < 0 || i2 < 0) return;
            const t = +ln.slice(i1 + 1, i2);
            if (!Number.isFinite(t)) { removed++; return; }
            const coin = ln.slice(0, i1);
            if (shortFn && shortFn(coin)) {   // short-retention universe: flat cutoff, full resolution, no thinning band
              if (t < (Number.isFinite(shortBefore) ? shortBefore : before)) removed++;
              else output.write(ln + "\n");
              return;
            }
            if (t < before) { removed++; return; }
            if (t >= full) { output.write(ln + "\n"); return; }
            const hb = Math.floor(t / 3600000);
            if (lastHour.get(coin) === hb) { removed++; return; }
            lastHour.set(coin, hb);
            output.write(ln + "\n");
          });
          rl.on("close", () => output.end());
          rl.on("error", reject);
          output.on("finish", resolve);
          output.on("error", reject);
        });
        fs.renameSync(tmp, file);           // atomic swap
      } catch (_) {
        try { fs.unlinkSync(tmp); } catch (_) {}
        removed = 0;                        // prune failed — leave the original untouched
      } finally {
        pruning = false;
        flush();                            // write anything buffered while we were pruning
      }
      return removed;
    },
    loadAll(since) {
      const m = new Map();
      try {
        if (!fs.existsSync(file)) return m;
        const lines = fs.readFileSync(file, "utf8").split("\n");
        for (const ln of lines) {
          if (!ln) continue;
          const parts = ln.split("\t");
          if (parts.length < 3) continue;
          const coin = parts[0], ts = +parts[1], oi = +parts[2];
          const f = parts.length >= 4 && parts[3] !== "" ? +parts[3] : null;
          if (!Number.isFinite(ts) || !Number.isFinite(oi) || ts < since) continue;
          let a = m.get(coin);
          if (!a) { a = []; m.set(coin, a); }
          a.push([ts, oi, Number.isFinite(f) ? f : null]);
        }
        for (const a of m.values()) a.sort((x, y) => x[0] - y[0]);
      } catch (_) {}
      return m;
    },
    // Written atomically (temp + rename): the warm cache exists so redeploys serve instantly,
    // so a crash mid-write must never be able to leave a truncated features.json behind —
    // that would silently cost a cold-start, the exact failure this file prevents.
    saveFeatures(data) {
      try {
        const tmp = featFile + ".tmp";
        fs.writeFileSync(tmp, JSON.stringify(data));
        fs.renameSync(tmp, featFile);
      } catch (_) {}
    },
    loadFeatures() {
      try { if (fs.existsSync(featFile)) return JSON.parse(fs.readFileSync(featFile, "utf8")); }
      catch (_) {}
      return null;
    },
    // Rolling market-wide regime history ([[ts, corr], ...]) — small, rewritten whole on each sample.
    loadRegime(since) {
      try {
        if (fs.existsSync(regimeFile)) {
          const a = JSON.parse(fs.readFileSync(regimeFile, "utf8"));
          if (Array.isArray(a)) return a.filter((x) => Array.isArray(x) && Number.isFinite(x[0]) && x[0] >= since);
        }
      } catch (_) {}
      return [];
    },
    // Volume heartbeat: increments a counter file on every boot. The definitive persistence
    // test — if the boot log ever reports "boot #1" twice, the data dir is ephemeral (wrong
    // DATA_DIR, or the volume isn't attached), no interpretation of cache sizes required.
    heartbeat() {
      let d = null;
      try { d = JSON.parse(fs.readFileSync(beatFile, "utf8")); } catch (_) {}
      const now = Date.now();
      const out = { boots: (d && Number.isFinite(d.boots) ? d.boots : 0) + 1,
        firstBoot: d && Number.isFinite(d.firstBoot) ? d.firstBoot : now, lastBoot: now };
      try {
        const tmp = beatFile + ".tmp";
        fs.writeFileSync(tmp, JSON.stringify(out));
        fs.renameSync(tmp, beatFile);
      } catch (_) {}
      return out;
    },
    // Signal ledger: every fired signal + its resolved out-of-sample outcome. Written atomically —
    // this file IS the track record; a truncated write would silently erase the honesty loop.
    saveLedger(data) {
      try {
        const tmp = ledgerFile + ".tmp";
        fs.writeFileSync(tmp, JSON.stringify(data));
        fs.renameSync(tmp, ledgerFile);
      } catch (_) {}
    },
    loadLedger() {
      try { return JSON.parse(fs.readFileSync(ledgerFile, "utf8")); } catch (_) { return null; }
    },
    saveRegime(arr) {
      try {
        const tmp = regimeFile + ".tmp";
        fs.writeFileSync(tmp, JSON.stringify(arr));
        fs.renameSync(tmp, regimeFile);
      } catch (_) {}
    },
    // Raw 60d hourly OHLCV spine — large, so written atomically (temp + rename) on a slow cadence so a
    // crash or redeploy mid-write can never corrupt the live file. Restored on boot so the session
    // analytics come back warm instead of blanking for minutes while the workers re-fetch candles.
    saveHourly(data) {
      try {
        const tmp = hourlyFile + ".tmp";
        fs.writeFileSync(tmp, JSON.stringify(data));
        fs.renameSync(tmp, hourlyFile);
      } catch (_) {}
    },
    loadHourly() {
      try { if (fs.existsSync(hourlyFile)) return JSON.parse(fs.readFileSync(hourlyFile, "utf8")); }
      catch (_) {}
      return null;
    },
    close() { flush(); },
  };
}

module.exports = { openStore };
