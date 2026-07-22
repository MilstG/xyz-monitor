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
  const hourlyFile = path.join(dataDir, "hourly.ndjson");
  const hourlyJsonFile = path.join(dataDir, "hourly.json");   // legacy whole-object format; read once as a bridge, then retired
  const ledgerFile = path.join(dataDir, "ledger.json");
  const archiveFile = path.join(dataDir, "ledger-archive.jsonl");
  const earnFile = path.join(dataDir, "earnings.json");
  const newsFile = path.join(dataDir, "news.json");
  const tgFile = path.join(dataDir, "tgchannels.json");
  const beatFile = path.join(dataDir, "volume-heartbeat.json");
  const aiFile = path.join(dataDir, "ai-reports.json");
  let buf = [];
  let pruning = false;   // while true, hold appends in `buf` so we never touch the file mid-rewrite
  let hourlyWriting = false;   // while true, an async hourly NDJSON write is in flight — skip overlapping ticks

  // ---- 5-minute OHLCV candle archive (node:sqlite) -----------------------------------------
  // Build-forward archive. Hyperliquid's candleSnapshot only serves the most recent 5000 candles
  // per interval (~17d at 5m), so anything older than that window exists ONLY here — this file is
  // the sole copy of that history, which is why snapshotCandles exists (copy it off-volume). It is
  // disk-resident and RANGE-QUERIED, never hydrated whole into RAM the way the hourly spine is:
  // 370d x 5m x ~150 markets is ~15M rows, far past what belongs resident, but every read is one
  // ticker over one window. node:sqlite ships in the runtime (Node >= 22.5, --experimental-sqlite),
  // so this adds NO native dependency and NO build toolchain — the same zero-dep rule the NDJSON
  // stores were built around. If the module is unavailable (older runtime, or the flag is off) the
  // whole sub-store degrades to no-ops via candlesEnabled(); nothing else in the app is affected.
  const candleFile = path.join(dataDir, "candles.db");
  let cdb = null, cInsert = null, cRange = null, cEvict = null, cCov = null, cCount = null;
  try {
    const { DatabaseSync } = require("node:sqlite");
    cdb = new DatabaseSync(candleFile);
    cdb.exec("PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL;");
    cdb.exec("CREATE TABLE IF NOT EXISTS candles_5m (coin TEXT NOT NULL, ts INTEGER NOT NULL, o REAL, h REAL, l REAL, c REAL, v REAL, PRIMARY KEY (coin, ts)) STRICT, WITHOUT ROWID;");
    // (coin, ts) PK on a WITHOUT ROWID table clusters each market's series contiguous on disk, so a
    // window read is one seek + sequential scan; the upsert makes every seed / tail / gap-fill pull
    // idempotent, so overlap on re-fetch is absorbed rather than duplicated.
    cInsert = cdb.prepare("INSERT INTO candles_5m (coin, ts, o, h, l, c, v) VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT(coin, ts) DO UPDATE SET o=excluded.o, h=excluded.h, l=excluded.l, c=excluded.c, v=excluded.v");
    cRange = cdb.prepare("SELECT ts, o, h, l, c, v FROM candles_5m WHERE coin = ? AND ts >= ? AND ts <= ? ORDER BY ts");
    cEvict = cdb.prepare("DELETE FROM candles_5m WHERE ts < ?");
    cCov = cdb.prepare("SELECT MIN(ts) AS mn, MAX(ts) AS mx, COUNT(*) AS n FROM candles_5m WHERE coin = ?");
    cCount = cdb.prepare("SELECT COUNT(*) AS n FROM candles_5m");
  } catch (_) { cdb = null; }

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
    // Append-only archive for closed claims aged out of the in-memory retention cap: one JSON
    // line per entry, appended (never rewritten) to ledger-archive.jsonl on the volume. The
    // 4000-entry cap now bounds memory only — the record itself is permanent. Reads happen
    // offline (the analysis pass pulls the file directly); nothing in the app depends on it,
    // so a failed append degrades to the old behavior instead of breaking the resolver.
    archiveClosed(entries) {
      try {
        if (!Array.isArray(entries) || !entries.length) return;
        fs.appendFileSync(archiveFile, entries.map((e) => JSON.stringify(e)).join("\n") + "\n");
      } catch (_) {}
    },
    // Raw persisted ledger files for the off-site backup job: name + content, existing files
    // only. The backup pushes these bytes verbatim — no re-serialization, so the backup can
    // never disagree with what the volume actually holds.
    readBackupFiles() {
      const out = [];
      for (const f of [ledgerFile, archiveFile]) {
        try { out.push({ name: path.basename(f), content: fs.readFileSync(f, "utf8") }); } catch (_) {}
      }
      return out;
    },
    // Telegram channel list: shared group CONFIG (not cache) — its own file so a corrupt or
    // trimmed news cache can never lose the channel list.
    saveTgChannels(data) {
      try {
        const tmp = tgFile + ".tmp";
        fs.writeFileSync(tmp, JSON.stringify(data));
        fs.renameSync(tmp, tgFile);
      } catch (_) {}
    },
    loadTgChannels() {
      try { return JSON.parse(fs.readFileSync(tgFile, "utf8")); } catch (_) { return null; }
    },
    // News feed warm cache (atomic like the rest): a redeploy serves the last fetched
    // headlines instead of a blank tab while the worker's first rotation completes.
    saveNews(data) {
      try {
        const tmp = newsFile + ".tmp";
        fs.writeFileSync(tmp, JSON.stringify(data));
        fs.renameSync(tmp, newsFile);
      } catch (_) {}
    },
    loadNews() {
      try { return JSON.parse(fs.readFileSync(newsFile, "utf8")); } catch (_) { return null; }
    },
    // Earnings calendar warm cache (small, atomic like the rest): a redeploy inside the 6h
    // refresh window serves the last good fetch instead of blanking badges until Finnhub answers.
    saveEarnings(data) {
      try {
        const tmp = earnFile + ".tmp";
        fs.writeFileSync(tmp, JSON.stringify(data));
        fs.renameSync(tmp, earnFile);
      } catch (_) {}
    },
    loadEarnings() {
      try { if (fs.existsSync(earnFile)) return JSON.parse(fs.readFileSync(earnFile, "utf8")); }
      catch (_) {}
      return null;
    },
    // AI analyst report cache: the group-shared reports survive redeploys so the Report tab's
    // recent list (and every cached read) comes back warm instead of blanking until someone
    // regenerates. Small, atomic like the rest.
    saveAiReports(data) {
      try {
        const tmp = aiFile + ".tmp";
        fs.writeFileSync(tmp, JSON.stringify(data));
        fs.renameSync(tmp, aiFile);
      } catch (_) {}
    },
    loadAiReports() {
      try { if (fs.existsSync(aiFile)) return JSON.parse(fs.readFileSync(aiFile, "utf8")); }
      catch (_) {}
      return null;
    },
    saveRegime(arr) {
      try {
        const tmp = regimeFile + ".tmp";
        fs.writeFileSync(tmp, JSON.stringify(arr));
        fs.renameSync(tmp, regimeFile);
      } catch (_) {}
    },
    // Raw hourly OHLCV spine — the biggest cache on the volume (~30 MB at 180d x ~140 markets).
    // Written as NDJSON: a `{meta:1,ts}` header line, then one `["COIN",[[t,o,h,l,c,v],...]]` line
    // per market. Async + streamed (a WriteStream with per-line backpressure, yielding to the event
    // loop every few coins), so the 10-min snapshot no longer does a ~30 MB synchronous
    // JSON.stringify + writeFileSync that froze every in-flight request. Still atomic: written to a
    // temp file and renamed into place, so a crash mid-write can't corrupt the live spine. Guarded
    // against overlap so two persist ticks can't fight over the temp file.
    async saveHourly(data) {
      if (!data || !data.hourly || hourlyWriting) return;
      hourlyWriting = true;
      const tmp = hourlyFile + ".tmp";
      try {
        await new Promise((resolve, reject) => {
          const out = fs.createWriteStream(tmp);
          let erred = false;
          out.on("error", (e) => { erred = true; reject(e); });
          const write = (s) => new Promise((res) => { if (out.write(s)) res(); else out.once("drain", res); });
          (async () => {
            await write(JSON.stringify({ meta: 1, ts: data.ts || Date.now() }) + "\n");
            let i = 0;
            for (const coin in data.hourly) {
              if (erred) return;
              const c = data.hourly[coin];
              if (!Array.isArray(c) || !c.length) continue;
              await write(JSON.stringify([coin, c]) + "\n");
              if ((++i & 7) === 0) await new Promise(setImmediate);   // yield to the event loop every 8 coins
            }
            out.end();
          })().catch(reject);
          out.on("finish", () => { if (!erred) resolve(); });
        });
        fs.renameSync(tmp, hourlyFile);                    // atomic swap
        try { if (fs.existsSync(hourlyJsonFile)) fs.unlinkSync(hourlyJsonFile); } catch (_) {}   // retire the legacy bridge file
      } catch (_) {
        try { fs.unlinkSync(tmp); } catch (_) {}
      } finally {
        hourlyWriting = false;
      }
    },
    // Streaming boot restore: parse the NDJSON one small line at a time via readline (never a single
    // ~30 MB JSON.parse and its RSS spike), invoking onEntry(coin, candles) per market. Falls back to
    // the legacy whole-object hourly.json exactly once so a deploy that predates the NDJSON switch
    // still restores warm. Returns { ts, coins }.
    async streamHourly(onEntry) {
      if (fs.existsSync(hourlyFile)) {
        let ts = 0, coins = 0;
        await new Promise((resolve) => {
          const rl = readline.createInterface({ input: fs.createReadStream(hourlyFile, { encoding: "utf8" }), crlfDelay: Infinity });
          rl.on("line", (ln) => {
            if (!ln) return;
            let v; try { v = JSON.parse(ln); } catch (_) { return; }
            if (Array.isArray(v)) { try { onEntry(v[0], v[1]); coins++; } catch (_) {} }
            else if (v && v.meta) ts = +v.ts || 0;
          });
          rl.on("close", resolve);
          rl.on("error", resolve);
        });
        return { ts, coins };
      }
      // Legacy bridge: the old single-object file. Read once; saveHourly deletes it after the next write.
      try {
        if (fs.existsSync(hourlyJsonFile)) {
          const data = JSON.parse(fs.readFileSync(hourlyJsonFile, "utf8"));
          if (data && data.hourly) { let coins = 0; for (const coin in data.hourly) { try { onEntry(coin, data.hourly[coin]); coins++; } catch (_) {} } return { ts: data.ts || 0, coins }; }
        }
      } catch (_) {}
      return { ts: 0, coins: 0 };
    },
    // ---- 5m candle archive API ----------------------------------------------------------
    // True only when node:sqlite loaded; every candle method below is a safe no-op otherwise, so
    // callers gate on this rather than crashing a runtime without the module/flag.
    candlesEnabled() { return !!cdb; },
    // Idempotent batch upsert of packed [t,o,h,l,c,v] rows for one coin. Wrapped in a single
    // transaction so a partial write can't land and so thousands of bars commit as one fsync.
    insertCandles(coin, rows) {
      if (!cdb || !Array.isArray(rows) || !rows.length) return 0;
      let n = 0;
      try {
        cdb.exec("BEGIN");
        for (const k of rows) {
          if (!Array.isArray(k)) continue;
          const t = +k[0], c = +k[4];
          if (!Number.isFinite(t) || !Number.isFinite(c)) continue;   // a bar with no timestamp/close is not a bar
          const o = +k[1], h = +k[2], l = +k[3], v = +k[5];
          cInsert.run(coin, Math.trunc(t), Number.isFinite(o) ? o : c, Number.isFinite(h) ? h : c, Number.isFinite(l) ? l : c, c, Number.isFinite(v) ? v : 0);
          n++;
        }
        cdb.exec("COMMIT");
      } catch (_) { try { cdb.exec("ROLLBACK"); } catch (_) {} return 0; }
      return n;
    },
    // Range read: packed [t,o,h,l,c,v] rows for one coin over [from,to] inclusive, oldest->newest.
    readCandles(coin, from, to) {
      if (!cdb) return [];
      try {
        const out = [];
        for (const r of cRange.all(coin, Math.trunc(+from), Math.trunc(+to))) out.push([r.ts, r.o, r.h, r.l, r.c, r.v]);
        return out;
      } catch (_) { return []; }
    },
    // Retention: drop every bar older than `before`. One statement over the whole archive.
    evictCandles(before) {
      if (!cdb) return 0;
      try { return Number(cEvict.run(Math.trunc(+before)).changes) || 0; } catch (_) { return 0; }
    },
    // Per-coin coverage for the capture cursor + the UI depth disclosure: {min, max, count}.
    // Because the instruments are 24/7 with no halts, count vs (max-min) span is itself the gap
    // read — a missing bar is a real capture gap, never a market closure, so absent rows are the
    // honest representation and no fill is invented.
    candleCoverage(coin) {
      if (!cdb) return { min: null, max: null, count: 0 };
      try { const r = cCov.get(coin); return { min: r && r.mn != null ? r.mn : null, max: r && r.mx != null ? r.mx : null, count: r ? Number(r.n) || 0 : 0 }; }
      catch (_) { return { min: null, max: null, count: 0 }; }
    },
    candleCount() { if (!cdb) return 0; try { const r = cCount.get(); return r ? Number(r.n) || 0 : 0; } catch (_) { return 0; } },
    // Off-copy for backup: VACUUM INTO writes a clean, defragmented snapshot. This archive is the
    // only copy of anything past the native window, so this is the recovery hedge — the caller
    // schedules it and (ideally) ships the file off-volume. Defaults beside the live db.
    snapshotCandles(dest) {
      if (!cdb) return false;
      const out = dest || (candleFile + ".bak");
      try { fs.unlinkSync(out); } catch (_) {}
      try { cdb.exec("VACUUM INTO '" + String(out).replace(/'/g, "''") + "'"); return true; } catch (_) { return false; }
    },
    closeCandles() { try { if (cdb) cdb.close(); } catch (_) {} cdb = null; },
    close() { flush(); try { if (cdb) cdb.close(); } catch (_) {} },
  };
}

module.exports = { openStore };
