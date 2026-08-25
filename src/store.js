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
  const navGrpFile = path.join(dataDir, "navgroups.json");   // renameable ribbon menu labels
  const regimeFile = path.join(dataDir, "regime.json");
  const hourlyFile = path.join(dataDir, "hourly.ndjson");
  const hourlyJsonFile = path.join(dataDir, "hourly.json");   // legacy whole-object format; read once as a bridge, then retired
  const ledgerFile = path.join(dataDir, "ledger.json");
  const archiveFile = path.join(dataDir, "ledger-archive.jsonl");
  const earnFile = path.join(dataDir, "earnings.json");
  const macroFile = path.join(dataDir, "macro.json");
  const housingFile = path.join(dataDir, "housing.json");
  const liqFile = path.join(dataDir, "liquidity.json");
  const newsFile = path.join(dataDir, "news.json");
  const fundFile = path.join(dataDir, "fundamentals.json");
  const tgFile = path.join(dataDir, "tgchannels.json");
  const trigFile = path.join(dataDir, "triggers.json");
  const pushFile = path.join(dataDir, "alertpush.json");   // telegram recipients + delivery cursor
  const rulesFile = path.join(dataDir, "alertrules.json");  // user-authored metric rules (group-shared)
  const basketsFile = path.join(dataDir, "baskets.json");   // user-defined custom baskets (group-shared CONFIG)
  const sectorAuditFile = path.join(dataDir, "sector-audit.json");   // weekly classification audit record log (CONFIG-grade)
  const beatFile = path.join(dataDir, "volume-heartbeat.json");
  const aiFile = path.join(dataDir, "ai-reports.json");
  const flagsFile = path.join(dataDir, "flags.json");     // admin feature-visibility overrides
  const duelFile = path.join(dataDir, "duel.json");         // score-duel daily snapshots + rank-IC series
  const derivFile = path.join(dataDir, "derivs.log");        // Coinalyze 15-min rows: coin\tts\tlongLiq\tshortLiq\toi
  const derivMapFile = path.join(dataDir, "derivmap.json");  // resolved base-asset -> Coinalyze symbol map
  const focusFile = path.join(dataDir, "focus.json");        // FOCUS tab: today's frozen list + yesterday's, verbatim
  const notesFile = path.join(dataDir, "notes.json");      // per-ticker written notes (group-shared CONFIG)
  const whaleFile = path.join(dataDir, "whale.json");        // 13F watchlist + cached quarterly books + unseen state + season builds
  let dbuf = [];
  let dPruning = false;   // hold deriv appends in dbuf during the streaming rewrite, same as the OI prune
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
  const t13fFile = path.join(dataDir, "whale13f.db");   // market-wide 13F holder index — separate, droppable, rebuildable
  const congressFile = path.join(dataDir, "congress.db");   // congressional disclosure index — same posture: separate, droppable, rebuildable
  let t13f = null, congress = null;
  let cdb = null, cInsert = null, cRange = null, cEvict = null, cCov = null, cCount = null;
  let mInsert = null, mRange = null, mEvict = null, mCov = null;   // 1m opening-hour archive (2026.08.18-04)
  const deepStmt = {};   // "12h" / "1d" -> { ins, rng, cov } — deep-history archive (2026.08.21-01)
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
    // ---- 1-minute OPENING-HOUR archive (build 2026.08.18-04) ------------------------------
    // A SEPARATE TABLE, deliberately. Writing 1m bars into candles_5m would put timestamps off
    // the 5-minute grid into a series four other consumers range-read as 5m (the sweep detector,
    // dip-reclaim, the crypto correlation matrix, the FOCUS chart) — every one of them would
    // silently start reading a mixed-resolution series with no way to tell which rows were which.
    // Tiny by construction: ~6 seats x 60 bars a day, retained 30d, so the whole table is smaller
    // than one market-day of the 5m archive.
    cdb.exec("CREATE TABLE IF NOT EXISTS candles_1m (coin TEXT NOT NULL, ts INTEGER NOT NULL, o REAL, h REAL, l REAL, c REAL, v REAL, PRIMARY KEY (coin, ts)) STRICT, WITHOUT ROWID;");
    mInsert = cdb.prepare("INSERT INTO candles_1m (coin, ts, o, h, l, c, v) VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT(coin, ts) DO UPDATE SET o=excluded.o, h=excluded.h, l=excluded.l, c=excluded.c, v=excluded.v");
    mRange = cdb.prepare("SELECT ts, o, h, l, c, v FROM candles_1m WHERE coin = ? AND ts >= ? AND ts <= ? ORDER BY ts");
    mEvict = cdb.prepare("DELETE FROM candles_1m WHERE ts < ?");
    mCov = cdb.prepare("SELECT MIN(ts) AS mn, MAX(ts) AS mx, COUNT(*) AS n FROM candles_1m WHERE coin = ? AND ts >= ? AND ts <= ?");
    // ---- DEEP-HISTORY archive: 12h + 1d (build 2026.08.21-01) -----------------------------
    // The ~17d ceiling that forced the 5m lane build-forward is a 5m problem: candleSnapshot's
    // 5000-bar window is ~6.8 YEARS at 12h and ~13.7 at 1d, so deep history is seedable BACKWARD
    // in one pull per market and these tables are as old as each listing from day one. SEPARATE
    // tables per interval, same doctrine as candles_1m: mixing widths into one series would hand
    // every range-reader a mixed-resolution tape with no way to tell which rows are which. No
    // retention/evict lane — depth is the entire point, the native window bounds what can ever
    // seed, and forward capture adds ~9 rows/market/day across the three tables combined.
    // 4h joined at 2026.08.21-03: the CHARTS 4H pane read the 20d intraday base (120 bars), which
    // cannot carry an EMA200 by construction — at 4h the native window is ~2.3 YEARS, so the pane
    // moves onto this lane instead of stretching the raw-5m fetch past its cap.
    for (const iv of ["4h", "12h", "1d"]) {
      const tbl = "candles_" + iv;
      cdb.exec(`CREATE TABLE IF NOT EXISTS ${tbl} (coin TEXT NOT NULL, ts INTEGER NOT NULL, o REAL, h REAL, l REAL, c REAL, v REAL, PRIMARY KEY (coin, ts)) STRICT, WITHOUT ROWID;`);
      deepStmt[iv] = {
        ins: cdb.prepare(`INSERT INTO ${tbl} (coin, ts, o, h, l, c, v) VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT(coin, ts) DO UPDATE SET o=excluded.o, h=excluded.h, l=excluded.l, c=excluded.c, v=excluded.v`),
        rng: cdb.prepare(`SELECT ts, o, h, l, c, v FROM ${tbl} WHERE coin = ? AND ts >= ? AND ts <= ? ORDER BY ts`),
        cov: cdb.prepare(`SELECT MIN(ts) AS mn, MAX(ts) AS mx, COUNT(*) AS n FROM ${tbl} WHERE coin = ?`),
      };
    }
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
    // Score-duel state (MOM vs MOM+ daily snapshots + rank-IC series). Same atomic write
    // discipline as the ledger blob: tmp + rename, so a crash mid-write never truncates the
    // only copy of an accruing out-of-sample record.
    saveDuel(data) {
      try {
        const tmp = duelFile + ".tmp";
        fs.writeFileSync(tmp, JSON.stringify(data));
        fs.renameSync(tmp, duelFile);
      } catch (_) {}
    },
    loadDuel() {
      try { return JSON.parse(fs.readFileSync(duelFile, "utf8")); } catch (_) { return null; }
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
    // Trigger-alert state: which setups have already been announced, plus the emitted event log
    // and its sequence high-water mark. Persisted for one reason — without it, every redeploy
    // re-announces the entire live board, which is exactly the failure that makes an alerting
    // feature get switched off on day two. A missing file is a FIRST BOOT and is handled by the
    // caller as a silent seed, never as "nothing has fired yet".
    // Telegram push: linked recipients, their per-class subscriptions, the stream cursor and the
    // getUpdates offset. Recipients are CONFIG (they cost a human a phone interaction to recreate),
    // and the cursor is state — but they must be written together or a crash between two files
    // could leave a recipient whose cursor says "you're caught up" and silently eat their backlog.
    // One atomic file, same tmp+rename discipline as the ledger.
    // User-authored metric rules. CONFIG in the strongest sense — somebody sat and typed these —
    // so they get their own file: a corrupt delivery blob or a trimmed cache must never be able to
    // take the rule list with it. Same tmp+rename discipline as the ledger.
    saveRules(data) {
      try {
        const tmp = rulesFile + ".tmp";
        fs.writeFileSync(tmp, JSON.stringify(data));
        fs.renameSync(tmp, rulesFile);
      } catch (_) {}
    },
    loadRules() {
      try { if (fs.existsSync(rulesFile)) return JSON.parse(fs.readFileSync(rulesFile, "utf8")); }
      catch (_) {}
      return null;
    },
    // Custom baskets: CONFIG like the rules above — somebody sat and typed a membership — so they
    // get their own file with the same tmp+rename discipline; a corrupt cache can never take the
    // registry with it. Built-in sector baskets are DERIVED at read time and never persisted here.
    saveBaskets(data) {
      try {
        const tmp = basketsFile + ".tmp";
        fs.writeFileSync(tmp, JSON.stringify(data));
        fs.renameSync(tmp, basketsFile);
        return true;
      } catch (_) { return false; }
    },
    loadBaskets() {
      try { if (fs.existsSync(basketsFile)) return JSON.parse(fs.readFileSync(basketsFile, "utf8")); }
      catch (_) {}
      return null;
    },
    // Per-ticker notes (build 2026.08.24-01). The highest-value CONFIG on the volume: a note is
    // prose somebody sat and typed about a name, and unlike a basket it cannot be reconstructed
    // from anything the server knows. Same tmp+rename discipline for exactly that reason — a
    // half-written file must never be able to eat the only copy of a thesis.
    saveNotes(data) {
      try {
        const tmp = notesFile + ".tmp";
        fs.writeFileSync(tmp, JSON.stringify(data));
        fs.renameSync(tmp, notesFile);
        return true;
      } catch (_) { return false; }
    },
    loadNotes() {
      try { if (fs.existsSync(notesFile)) return JSON.parse(fs.readFileSync(notesFile, "utf8")); }
      catch (_) {}
      return null;
    },
    // Weekly sector-audit record log (build 2026.08.05-02). Append-only in content, atomic in
    // write — CONFIG-grade like rules/baskets: an applied graduation is a classification the whole
    // board depends on, so a corrupt cache must never take it. Records are validated at fold time
    // (compute.mergeSectorAudit), so a bad line loses that line, never the file.
    saveSectorAudit(data) {
      try {
        const tmp = sectorAuditFile + ".tmp";
        fs.writeFileSync(tmp, JSON.stringify(data));
        fs.renameSync(tmp, sectorAuditFile);
        return true;
      } catch (_) { return false; }
    },
    loadSectorAudit() {
      try { if (fs.existsSync(sectorAuditFile)) return JSON.parse(fs.readFileSync(sectorAuditFile, "utf8")); }
      catch (_) {}
      return null;
    },
    savePush(data) {
      try {
        const tmp = pushFile + ".tmp";
        fs.writeFileSync(tmp, JSON.stringify(data));
        fs.renameSync(tmp, pushFile);
      } catch (_) {}
    },
    loadPush() {
      try { if (fs.existsSync(pushFile)) return JSON.parse(fs.readFileSync(pushFile, "utf8")); }
      catch (_) {}
      return null;
    },
    saveTriggers(data) {
      try {
        const tmp = trigFile + ".tmp";
        fs.writeFileSync(tmp, JSON.stringify(data));
        fs.renameSync(tmp, trigFile);
      } catch (_) {}
    },
    loadTriggers() {
      try { return JSON.parse(fs.readFileSync(trigFile, "utf8")); } catch (_) { return null; }
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
    // Fundamentals warm cache (Finnhub basic financials + profile2): a redeploy serves the last
    // cached company numbers instead of a blank drawer panel while the slow rotation re-warms.
    saveFund(data) {
      try {
        const tmp = fundFile + ".tmp";
        fs.writeFileSync(tmp, JSON.stringify(data));
        fs.renameSync(tmp, fundFile);
      } catch (_) {}
    },
    loadFund() {
      try { if (fs.existsSync(fundFile)) return JSON.parse(fs.readFileSync(fundFile, "utf8")); }
      catch (_) {}
      return null;
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
    // Macro calendar warm cache (FOMC + FRED): same contract as earnings — a redeploy inside
    // the 6h refresh window serves the last good entries/stats instead of blanking the banner
    // and the calendar's macro rows until FRED answers.
    saveMacro(data) {
      try {
        const tmp = macroFile + ".tmp";
        fs.writeFileSync(tmp, JSON.stringify(data));
        fs.renameSync(tmp, macroFile);
      } catch (_) {}
    },
    loadMacro() {
      try { if (fs.existsSync(macroFile)) return JSON.parse(fs.readFileSync(macroFile, "utf8")); }
      catch (_) {}
      return null;
    },
    saveHousing(data) {
      try {
        const tmp = housingFile + ".tmp";
        fs.writeFileSync(tmp, JSON.stringify(data));
        fs.renameSync(tmp, housingFile);
      } catch (_) {}
    },
    loadHousing() {
      try { if (fs.existsSync(housingFile)) return JSON.parse(fs.readFileSync(housingFile, "utf8")); }
      catch (_) {}
      return null;
    },
    saveLiquidity(data) {
      try {
        const tmp = liqFile + ".tmp";
        fs.writeFileSync(tmp, JSON.stringify(data));
        fs.renameSync(tmp, liqFile);
      } catch (_) {}
    },
    loadLiquidity() {
      try { if (fs.existsSync(liqFile)) return JSON.parse(fs.readFileSync(liqFile, "utf8")); }
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
    // Feature-visibility overrides set from the admin panel: { "<featureKey>": "public"|"admin"|"off" }.
    // Tiny and rewritten whole, but atomic like everything else on the volume — a truncated write here
    // would resolve every key back to its manifest default on the next boot, silently reopening
    // whatever had been closed. Absent file is the normal first-boot state, not an error: the
    // manifest defaults ARE the initial configuration.
    // Nav group labels — {groupKey: label} overrides only, written atomically like the flags file.
    saveNavGroups(obj) {
      try {
        const tmp = navGrpFile + ".tmp";
        fs.writeFileSync(tmp, JSON.stringify(obj || {}));
        fs.renameSync(tmp, navGrpFile);
        return true;
      } catch (_) { return false; }
    },
    loadNavGroups() {
      try { if (fs.existsSync(navGrpFile)) return JSON.parse(fs.readFileSync(navGrpFile, "utf8")); }
      catch (_) {}
      return null;
    },
    saveFlags(obj) {
      try {
        const tmp = flagsFile + ".tmp";
        fs.writeFileSync(tmp, JSON.stringify(obj || {}));
        fs.renameSync(tmp, flagsFile);
        return true;
      } catch (_) { return false; }
    },
    loadFlags() {
      try { if (fs.existsSync(flagsFile)) return JSON.parse(fs.readFileSync(flagsFile, "utf8")); }
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
    // ---- 1m opening-hour archive (build 2026.08.18-04) -----------------------------------
    // Same shape and same idempotent-upsert discipline as the 5m API, against its own table.
    // Callers gate on candlesEnabled() exactly as they do for 5m — one flag, one sub-store.
    insertCandles1m(coin, rows) {
      if (!cdb || !Array.isArray(rows) || !rows.length) return 0;
      let n = 0;
      try {
        cdb.exec("BEGIN");
        for (const k of rows) {
          if (!Array.isArray(k)) continue;
          const t = +k[0], c = +k[4];
          if (!Number.isFinite(t) || !Number.isFinite(c)) continue;
          const o = +k[1], h = +k[2], l = +k[3], v = +k[5];
          mInsert.run(coin, Math.trunc(t), Number.isFinite(o) ? o : c, Number.isFinite(h) ? h : c, Number.isFinite(l) ? l : c, c, Number.isFinite(v) ? v : 0);
          n++;
        }
        cdb.exec("COMMIT");
      } catch (_) { try { cdb.exec("ROLLBACK"); } catch (_) {} return 0; }
      return n;
    },
    readCandles1m(coin, from, to) {
      if (!cdb) return [];
      try {
        const out = [];
        for (const r of mRange.all(coin, Math.trunc(+from), Math.trunc(+to))) out.push([r.ts, r.o, r.h, r.l, r.c, r.v]);
        return out;
      } catch (_) { return []; }
    },
    evictCandles1m(before) {
      if (!cdb) return 0;
      try { return Number(mEvict.run(Math.trunc(+before)).changes) || 0; } catch (_) { return 0; }
    },
    // Windowed coverage: how many 1m bars exist for one coin over one span. This is the number the
    // FOCUS record discloses per seat — "zero bars" has to be a statement the board can make, not
    // an absence the renderer papers over with the mark.
    candleCoverage1m(coin, from, to) {
      if (!cdb) return { min: null, max: null, count: 0 };
      try { const r = mCov.get(coin, Math.trunc(+from), Math.trunc(+to));
        return { min: r && r.mn != null ? r.mn : null, max: r && r.mx != null ? r.mx : null, count: r ? Number(r.n) || 0 : 0 }; }
      catch (_) { return { min: null, max: null, count: 0 }; }
    },
    // ---- deep 12h/1d archive (build 2026.08.21-01) ---------------------------------------
    // Same shape and same idempotent-upsert discipline as the 5m/1m APIs, keyed by interval so
    // one call surface serves both tables. An unknown interval is a hard no (empty/zero return),
    // never a silent write into the wrong series. Callers gate on candlesEnabled() as everywhere.
    insertCandlesDeep(iv, coin, rows) {
      const st = deepStmt[iv];
      if (!cdb || !st || !Array.isArray(rows) || !rows.length) return 0;
      let n = 0;
      try {
        cdb.exec("BEGIN");
        for (const k of rows) {
          if (!Array.isArray(k)) continue;
          const t = +k[0], c = +k[4];
          if (!Number.isFinite(t) || !Number.isFinite(c)) continue;
          const o = +k[1], h = +k[2], l = +k[3], v = +k[5];
          st.ins.run(coin, Math.trunc(t), Number.isFinite(o) ? o : c, Number.isFinite(h) ? h : c, Number.isFinite(l) ? l : c, c, Number.isFinite(v) ? v : 0);
          n++;
        }
        cdb.exec("COMMIT");
      } catch (_) { try { cdb.exec("ROLLBACK"); } catch (_) {} return 0; }
      return n;
    },
    readCandlesDeep(iv, coin, from, to) {
      const st = deepStmt[iv];
      if (!cdb || !st) return [];
      try {
        const out = [];
        for (const r of st.rng.all(coin, Math.trunc(+from), Math.trunc(+to))) out.push([r.ts, r.o, r.h, r.l, r.c, r.v]);
        return out;
      } catch (_) { return []; }
    },
    candleCoverageDeep(iv, coin) {
      const st = deepStmt[iv];
      if (!cdb || !st) return { min: null, max: null, count: 0 };
      try { const r = st.cov.get(coin); return { min: r && r.mn != null ? r.mn : null, max: r && r.mx != null ? r.mx : null, count: r ? Number(r.n) || 0 : 0 }; }
      catch (_) { return { min: null, max: null, count: 0 }; }
    },
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
    // ---- Coinalyze deriv-context history ------------------------------------------------
    // Same append-log discipline as oi.log: Coinalyze deletes intraday history daily (~15-20d
    // window at 15min), so OUR log is the only place percentile/cascade baselines can grow.
    // Every sweep appends only rows newer than what's already on disk (the poller gates that).
    insertDeriv(coin, ts, ll, sl, oi) {
      dbuf.push(coin + "\t" + ts + "\t" + (ll == null ? "" : ll) + "\t" + (sl == null ? "" : sl) + "\t" + (oi == null ? "" : oi) + "\n");
      if (dbuf.length >= 200) this.flushDerivs();
    },
    flushDerivs() {
      if (!dbuf.length || dPruning) return;
      try { fs.appendFileSync(derivFile, dbuf.join("")); dbuf = []; }
      catch (_) { if (dbuf.length > MAX_BUF) dbuf = dbuf.slice(dbuf.length >> 1); }
    },
    loadDerivs(since) {
      const m = new Map();
      try {
        if (!fs.existsSync(derivFile)) return m;
        const lines = fs.readFileSync(derivFile, "utf8").split("\n");
        for (const ln of lines) {
          if (!ln) continue;
          const p = ln.split("\t");
          if (p.length < 5) continue;
          const ts = +p[1];
          if (!Number.isFinite(ts) || ts < since) continue;
          const row = [ts, p[2] === "" ? null : +p[2], p[3] === "" ? null : +p[3], p[4] === "" ? null : +p[4]];
          let a = m.get(p[0]);
          if (!a) { a = new Map(); m.set(p[0], a); }
          a.set(ts, row);   // dedupe by ts, LAST write wins — a re-persisted grown boundary bucket supersedes its first observation
        }
        for (const [coin, a] of m) m.set(coin, [...a.values()].sort((x, y) => x[0] - y[0]));
      } catch (_) {}
      return m;
    },
    // Flat-cutoff streaming prune (no thinning band — 15-min resolution IS the product here),
    // atomic rename, appends buffered during the rewrite. Async: callers should await it.
    async pruneDerivs(before) {
      if (dPruning) return 0;
      this.flushDerivs();
      if (!fs.existsSync(derivFile)) return 0;
      dPruning = true;
      const tmp = derivFile + ".tmp";
      let removed = 0;
      try {
        await new Promise((resolve, reject) => {
          const input = fs.createReadStream(derivFile, { encoding: "utf8" });
          const output = fs.createWriteStream(tmp);
          const rl = readline.createInterface({ input, crlfDelay: Infinity });
          rl.on("line", (ln) => {
            if (!ln) return;
            const i1 = ln.indexOf("\t"), i2 = ln.indexOf("\t", i1 + 1);
            if (i1 < 0 || i2 < 0) return;
            const t = +ln.slice(i1 + 1, i2);
            if (!Number.isFinite(t) || t < before) { removed++; return; }
            output.write(ln + "\n");
          });
          rl.on("close", () => output.end());
          rl.on("error", reject);
          output.on("finish", resolve);
          output.on("error", reject);
        });
        fs.renameSync(tmp, derivFile);
      } catch (_) {
        try { fs.unlinkSync(tmp); } catch (_) {}
        removed = 0;
      } finally {
        dPruning = false;
        this.flushDerivs();
      }
      return removed;
    },
    // Resolved symbol map (base asset -> {sym, venue}) — config-grade, atomic like the rest,
    // so a boot never has to re-spend call budget re-resolving an unchanged universe.
    // FOCUS list (build 2026.08.15-01): { state, prev } — today's frozen 6-seat list and the
    // prior day's, exactly as stamped. Atomic tmp+rename like every other config-grade write, so
    // a mid-write crash can never leave a half list that a boot would then serve as truth.
    saveFocus(data) {
      try {
        const tmp = focusFile + ".tmp";
        fs.writeFileSync(tmp, JSON.stringify(data));
        fs.renameSync(tmp, focusFile);
      } catch (_) {}
    },
    loadFocus() {
      try { if (fs.existsSync(focusFile)) return JSON.parse(fs.readFileSync(focusFile, "utf8")); }
      catch (_) {}
      return null;
    },
    // 13F whale lane (build 2026.08.16-01). One JSON blob: watchlist entries, the cached quarterly
    // books per CIK (full aggregated positions — capping them would fake exits at the cap line),
    // unseen-filing state and persisted season builds. Same tmp+rename atomicity as every other
    // config-grade file; a torn write can never half-replace the watchlist.
    saveWhale(data) {
      try {
        const tmp = whaleFile + ".tmp";
        fs.writeFileSync(tmp, JSON.stringify(data));
        fs.renameSync(tmp, whaleFile);
      } catch (_) {}
    },
    loadWhale() {
      try { if (fs.existsSync(whaleFile)) return JSON.parse(fs.readFileSync(whaleFile, "utf8")); }
      catch (_) {}
      return null;
    },
    // ---- market-wide 13F holder index (build 2026.08.21-05) -----------------------------------
    // A SEPARATE SQLite file (whale13f.db) holding the SEC quarterly Form 13F structured data
    // set, boiled down to option C of the design fork: per (quarter, cusip) an exact aggregate
    // row (how many filers hold it, total common-line value) plus the top-N holders by value —
    // N capped (default 500) because nobody queries holder #501 and the cap saves ~40% of a
    // full two-quarter index. Two quarters kept (current + prior, for share-delta QoQ); older
    // quarters deleted at finalize. Separate file on purpose: droppable and rebuildable without
    // ever breathing near candles.db. Store owns schema + statements (the candle-archive
    // precedent); the poller owns download, unzip, parsing and the scale/dedupe rules.
    open13F() {
      if (t13f) return t13f;
      try {
        const { DatabaseSync } = require("node:sqlite");
        t13f = new DatabaseSync(t13fFile);
        t13f.exec("PRAGMA journal_mode=WAL; PRAGMA auto_vacuum=INCREMENTAL;");
        t13f.exec(`CREATE TABLE IF NOT EXISTS meta(k TEXT PRIMARY KEY, v TEXT);
CREATE TABLE IF NOT EXISTS agg(q TEXT, cusip TEXT, nFilers INTEGER, totVal REAL, PRIMARY KEY(q,cusip)) WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS top(q TEXT, cusip TEXT, rk INTEGER, cik INTEGER, name TEXT, value REAL, shares REAL, shOk INTEGER, PRIMARY KEY(q,cusip,rk)) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS top_cik ON top(q, cusip, cik);`);
        return t13f;
      } catch (_) { t13f = null; return null; }
    },
    t13fReady() { try { return !!this.open13F(); } catch (_) { return false; } },
    t13fMeta(k) { const d = this.open13F(); if (!d) return null;
      try { const r = d.prepare("SELECT v FROM meta WHERE k=?").get(String(k)); return r ? r.v : null; } catch (_) { return null; } },
    t13fMetaSet(k, v) { const d = this.open13F(); if (!d) return;
      try { d.prepare("INSERT INTO meta(k,v) VALUES(?,?) ON CONFLICT(k) DO UPDATE SET v=excluded.v").run(String(k), String(v)); } catch (_) {} },
    // Ingest staging: rebuilt fresh per run; a crashed ingest leaves only a dead staging table
    // that the next run drops — agg/top for already-finalized quarters are never touched mid-run.
    t13fIngestStart() { const d = this.open13F(); if (!d) return false;
      d.exec("DROP TABLE IF EXISTS stage; DROP TABLE IF EXISTS smult; DROP TABLE IF EXISTS snames; DROP TABLE IF EXISTS schosen;");
      d.exec(`CREATE TABLE stage(acc TEXT, cusip TEXT, value REAL, shares REAL, sh INTEGER, put INTEGER);
CREATE TABLE smult(acc TEXT PRIMARY KEY, mult REAL) WITHOUT ROWID;
CREATE TABLE snames(cik INTEGER PRIMARY KEY, name TEXT) WITHOUT ROWID;
CREATE TABLE schosen(acc TEXT PRIMARY KEY, cik INTEGER) WITHOUT ROWID;`);
      return true; },
    t13fStageRows(rows) { const d = this.open13F(); if (!d || !rows.length) return;
      const st = d.prepare("INSERT INTO stage VALUES(?,?,?,?,?,?)");
      d.exec("BEGIN");
      try { for (const r of rows) st.run(r.acc, r.cusip, r.value, r.shares, r.sh, r.put); d.exec("COMMIT"); }
      catch (e) { d.exec("ROLLBACK"); throw e; } },
    t13fStageMeta(mults, names, chosen) { const d = this.open13F(); if (!d) return;
      const sm = d.prepare("INSERT OR REPLACE INTO smult VALUES(?,?)");
      const sn = d.prepare("INSERT OR REPLACE INTO snames VALUES(?,?)");
      const sc = d.prepare("INSERT OR REPLACE INTO schosen VALUES(?,?)");
      d.exec("BEGIN");
      try {
        for (const [acc, m] of mults) sm.run(acc, m);
        for (const [cik, nm] of names) sn.run(+cik, String(nm).slice(0, 60));
        for (const [acc, cik] of chosen) sc.run(acc, +cik);
        d.exec("COMMIT");
      } catch (e) { d.exec("ROLLBACK"); throw e; } },
    // Pass 2 in SQL: chosen accessions only, common lines only (put=0 — an options desk must not
    // outrank a real owner), per-filer thousands correction via the mult join, exact aggregates
    // over ALL holders, then the capped rank table. Old quarters beyond keep-2 deleted, space
    // reclaimed via incremental vacuum.
    t13fFinalize(q, cap) { const d = this.open13F(); if (!d) return { ok: false, error: "sqlite unavailable" };
      try {
        d.exec("BEGIN");
        d.prepare("DELETE FROM agg WHERE q=?").run(q);
        d.prepare("DELETE FROM top WHERE q=?").run(q);
        d.prepare(`INSERT INTO agg
          SELECT ?, s.cusip, COUNT(DISTINCT c.cik), SUM(s.value*m.mult)
          FROM stage s JOIN schosen c ON c.acc=s.acc JOIN smult m ON m.acc=s.acc
          WHERE s.put=0 GROUP BY s.cusip`).run(q);
        d.prepare(`INSERT INTO top
          SELECT ?, cusip, rk, cik, name, val, CASE WHEN ok=1 THEN sh ELSE NULL END, ok FROM (
            SELECT s.cusip cusip, c.cik cik, COALESCE(n.name,'CIK '||c.cik) name,
                   SUM(s.value*m.mult) val, SUM(s.shares) sh, MIN(s.sh) ok,
                   ROW_NUMBER() OVER (PARTITION BY s.cusip ORDER BY SUM(s.value*m.mult) DESC) rk
            FROM stage s JOIN schosen c ON c.acc=s.acc JOIN smult m ON m.acc=s.acc
                 LEFT JOIN snames n ON n.cik=c.cik
            WHERE s.put=0 GROUP BY s.cusip, c.cik
          ) WHERE rk<=?`).run(q, cap);
        d.exec("DROP TABLE IF EXISTS stage; DROP TABLE IF EXISTS smult; DROP TABLE IF EXISTS snames; DROP TABLE IF EXISTS schosen;");
        // keep-2: every quarter beyond the two newest by label-encoded date goes.
        const qs = d.prepare("SELECT DISTINCT q FROM agg").all().map((r) => r.q)
          .sort((a, b) => (b.slice(3) + b.slice(1, 2)).localeCompare(a.slice(3) + a.slice(1, 2)));
        for (const old of qs.slice(2)) { d.prepare("DELETE FROM agg WHERE q=?").run(old); d.prepare("DELETE FROM top WHERE q=?").run(old); }
        d.exec("COMMIT");
        d.exec("PRAGMA incremental_vacuum;");
        return { ok: true, quarters: qs.slice(0, 2) };
      } catch (e) { try { d.exec("ROLLBACK"); } catch (_) {} return { ok: false, error: String(e && e.message).slice(0, 200) }; } },
    t13fQuarters() { const d = this.open13F(); if (!d) return [];
      try { return d.prepare("SELECT DISTINCT q FROM agg").all().map((r) => r.q)
        .sort((a, b) => (b.slice(3) + b.slice(1, 2)).localeCompare(a.slice(3) + a.slice(1, 2))); } catch (_) { return []; } },
    t13fAgg(q, cusip) { const d = this.open13F(); if (!d) return null;
      try { return d.prepare("SELECT nFilers, totVal FROM agg WHERE q=? AND cusip=?").get(q, cusip) || null; } catch (_) { return null; } },
    t13fTop(q, cusip, lim) { const d = this.open13F(); if (!d) return [];
      try { return d.prepare("SELECT rk, cik, name, value, shares, shOk FROM top WHERE q=? AND cusip=? ORDER BY rk LIMIT ?").all(q, cusip, lim | 0); } catch (_) { return []; } },
    t13fHolderRow(q, cusip, cik) { const d = this.open13F(); if (!d) return null;
      try { return d.prepare("SELECT value, shares, shOk FROM top WHERE q=? AND cusip=? AND cik=?").get(q, cusip, +cik) || null; } catch (_) { return null; } },

    // ---- congressional disclosure index (build 2026.08.24-02) ---------------------------------
    // Phase 1 of the CONGRESS lane. A THIRD sqlite file, separate from whale13f.db for exactly the
    // reason that one is separate from candles.db: droppable and rebuildable without breathing near
    // anything expensive to refill. This phase stores the House Clerk's FILING INDEX only — who
    // filed what, when, and where the source document lives. No transaction is parsed out of a PTR
    // yet; that is phase 2, and `parsed`/`nTx` are carried NOW so phase 2 needs no migration.
    // Two deliberate departures from the 13F index:
    //   - no keep-N eviction. A decade of every member's filings is megabytes, and the history IS
    //     the product here (a 13F index only ever gets asked about the newest two quarters).
    //   - re-ingest never clobbers parse state. The Clerk republishes the same annual ZIP daily, so
    //     the upsert refreshes index fields and leaves `parsed`/`nTx` alone — otherwise every daily
    //     sync would silently reset phase 2's work back to the queue.
    openCongress() {
      if (congress) return congress;
      try {
        const { DatabaseSync } = require("node:sqlite");
        congress = new DatabaseSync(congressFile);
        congress.exec("PRAGMA journal_mode=WAL; PRAGMA auto_vacuum=INCREMENTAL;");
        congress.exec(`CREATE TABLE IF NOT EXISTS meta(k TEXT PRIMARY KEY, v TEXT);
CREATE TABLE IF NOT EXISTS filing(
  id TEXT PRIMARY KEY, chamber TEXT, docId TEXT, yr INTEGER,
  member TEXT, lname TEXT, fname TEXT, suffix TEXT, state TEXT, dist TEXT,
  type TEXT, typeRaw TEXT, filed TEXT, url TEXT, amends TEXT,
  parsed INTEGER, nTx INTEGER) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS fil_dt ON filing(filed);
CREATE INDEX IF NOT EXISTS fil_ty ON filing(type, filed);
CREATE TABLE IF NOT EXISTS tx(
  fid TEXT, ln INTEGER, owner TEXT, asset TEXT, ticker TEXT, act TEXT,
  txDate TEXT, notified TEXT, loAmt REAL, hiAmt REAL, PRIMARY KEY(fid, ln)) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS tx_tk ON tx(ticker, txDate);
CREATE TABLE IF NOT EXISTS watch(member TEXT PRIMARY KEY, at INTEGER, notify INTEGER) WITHOUT ROWID;`);
        // Phase 2 adds a retry counter to a table that already holds rows in production, so the
        // migration is an ALTER that is allowed to fail: on a fresh database the column comes from
        // the CREATE above once this line has run, and on an existing one it is added in place.
        try { congress.exec("ALTER TABLE filing ADD COLUMN tries INTEGER"); } catch (_) {}
        // Why a filing failed, so "222 unreadable" can be broken down instead of believed.
        try { congress.exec("ALTER TABLE filing ADD COLUMN pnote TEXT"); } catch (_) {}
        // How a ticker was arrived at: "form" (the parenthetical the filer wrote) or "name"
        // (resolved from the issuer name against the universe). Two different strengths of claim,
        // so they are stored apart and rendered apart rather than blurred into one column.
        try { congress.exec("ALTER TABLE tx ADD COLUMN tkSrc TEXT"); } catch (_) {}
        // The form's own asset-type code: what kind of thing was traded, and therefore whether a
        // ticker could exist for it at all.
        try { congress.exec("ALTER TABLE tx ADD COLUMN atype TEXT"); } catch (_) {}
        return congress;
      } catch (_) { congress = null; return null; }
    },
    congressReady() { try { return !!this.openCongress(); } catch (_) { return false; } },
    congressMeta(k) { const d = this.openCongress(); if (!d) return null;
      try { const r = d.prepare("SELECT v FROM meta WHERE k=?").get(String(k)); return r ? r.v : null; } catch (_) { return null; } },
    congressMetaSet(k, v) { const d = this.openCongress(); if (!d) return;
      try { d.prepare("INSERT INTO meta(k,v) VALUES(?,?) ON CONFLICT(k) DO UPDATE SET v=excluded.v").run(String(k), String(v)); } catch (_) {} },
    // Idempotent by doc id: the SAME index re-ingested changes nothing but the refreshed columns.
    // parsed/nTx are pointedly absent from the DO UPDATE list — see the note above.
    congressUpsertFilings(rows) { const d = this.openCongress(); if (!d || !rows || !rows.length) return { seen: 0, added: 0 };
      const ins = d.prepare(`INSERT INTO filing(id,chamber,docId,yr,member,lname,fname,suffix,state,dist,type,typeRaw,filed,url,amends,parsed,nTx)
VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
ON CONFLICT(id) DO UPDATE SET member=excluded.member, lname=excluded.lname, fname=excluded.fname,
  suffix=excluded.suffix, state=excluded.state, dist=excluded.dist, type=excluded.type,
  typeRaw=excluded.typeRaw, url=excluded.url,
  -- a re-sync must never DOWNGRADE a date: if today's index row has an unreadable FilingDate but
  -- a previous run read one, the good value stands rather than being blanked.
  filed=CASE WHEN excluded.filed<>'' THEN excluded.filed ELSE filing.filed END`);
      const had = d.prepare("SELECT 1 FROM filing WHERE id=?");
      let added = 0;
      d.exec("BEGIN");
      try {
        for (const r of rows) {
          if (!had.get(r.id)) added++;
          ins.run(r.id, r.chamber, r.docId, r.yr | 0, r.member, r.lname, r.fname, r.suffix || "",
            r.state || "", r.dist || "", r.type, r.typeRaw || "", r.filed, r.url == null ? null : r.url,
            r.amends || null, r.parsed == null ? null : r.parsed | 0, r.nTx == null ? null : r.nTx | 0);
        }
        d.exec("COMMIT");
      } catch (e) { try { d.exec("ROLLBACK"); } catch (_) {} throw e; }
      return { seen: rows.length, added };
    },
    congressCounts() { const d = this.openCongress(); if (!d) return null;
      try {
        const a = d.prepare("SELECT COUNT(*) n, COUNT(DISTINCT member) members, MIN(filed) first, MAX(filed) last FROM filing").get() || {};
        const p = d.prepare("SELECT COUNT(*) n FROM filing WHERE type='ptr'").get() || {};
        const q = d.prepare("SELECT COUNT(*) n FROM filing WHERE type='ptr' AND parsed=0").get() || {};
        // Blank filing dates are a real condition in the live index, so they get a number rather
        // than showing up only as a dash where the earliest filing should be.
        const nd = d.prepare("SELECT COUNT(*) n FROM filing WHERE filed IS NULL OR filed=''").get() || {};
        const f2 = d.prepare("SELECT MIN(filed) first FROM filing WHERE filed<>''").get() || {};
        return { n: a.n || 0, members: a.members || 0, first: f2.first || null, last: a.last || null,
          ptr: p.n || 0, pending: q.n || 0, noDate: nd.n || 0 };
      } catch (_) { return null; } },
    congressYears() { const d = this.openCongress(); if (!d) return [];
      try { return d.prepare("SELECT yr, COUNT(*) n FROM filing GROUP BY yr ORDER BY yr DESC").all(); } catch (_) { return []; } },
    // ---- phase 2: the parse queue and what comes out of it ------------------------------------
    // parsed: 0 pending · 1 parsed · 2 unreadable (permanent — a scanned filing never becomes
    // readable by trying again). `tries` counts TRANSIENT failures only, so a network blip retries
    // and a scan does not burn fetches forever.
    congressQueue(limit, maxTries) { const d = this.openCongress(); if (!d) return [];
      try { return d.prepare("SELECT id, yr, url, member FROM filing WHERE type='ptr' AND parsed=0 AND url IS NOT NULL"
        + " AND (tries IS NULL OR tries < ?) ORDER BY filed DESC, id DESC LIMIT ?")
        .all(maxTries == null ? 5 : maxTries | 0, Math.max(1, Math.min(500, limit | 0 || 25))); } catch (_) { return []; } },
    congressSaveTx(fid, rows) { const d = this.openCongress(); if (!d) return 0;
      const del = d.prepare("DELETE FROM tx WHERE fid=?");
      const ins = d.prepare("INSERT INTO tx(fid,ln,owner,asset,ticker,act,txDate,notified,loAmt,hiAmt,tkSrc,atype) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)");
      const mark = d.prepare("UPDATE filing SET parsed=1, nTx=?, tries=0 WHERE id=?");
      d.exec("BEGIN");
      try {
        del.run(String(fid));                          // re-parsing a filing replaces its rows wholesale
        rows.forEach((r, i) => ins.run(String(fid), i, r.owner, String(r.asset).slice(0, 160), r.ticker,
          r.act, r.txDate, r.notified, r.loAmt == null ? null : +r.loAmt, r.hiAmt == null ? null : +r.hiAmt,
          r.tkSrc || (r.ticker ? "form" : null), r.atype || null));
        mark.run(rows.length, String(fid));
        d.exec("COMMIT");
      } catch (e) { try { d.exec("ROLLBACK"); } catch (_) {} throw e; }
      return rows.length; },
    congressMarkUnreadable(fid, note) { const d = this.openCongress(); if (!d) return;
      try { d.prepare("UPDATE filing SET parsed=2, nTx=0, pnote=? WHERE id=?").run(note || null, String(fid)); } catch (_) {} },
    congressNote(fid, note) { const d = this.openCongress(); if (!d) return;
      try { d.prepare("UPDATE filing SET pnote=? WHERE id=?").run(note || null, String(fid)); } catch (_) {} },
    // Undo a verdict. A filing marked unreadable by a BUG must be able to come back — otherwise a
    // classification mistake is permanent, which is exactly the trap 222 "scans" walked into.
    congressRequeue(which) { const d = this.openCongress(); if (!d) return 0;
      try {
        const sql = which === "all"
          ? "UPDATE filing SET parsed=0, tries=0, pnote=NULL WHERE type='ptr' AND (parsed<>1 OR COALESCE(nTx,0)=0)"
          : "UPDATE filing SET parsed=0, tries=0, pnote=NULL WHERE type='ptr' AND parsed=2";
        const r = d.prepare(sql).run();
        return r && r.changes != null ? r.changes : 0;
      } catch (_) { return 0; } },
    // The failure breakdown. "unreadable" is a verdict, not a reason; this is the reason.
    congressNotes() { const d = this.openCongress(); if (!d) return [];
      try { return d.prepare("SELECT CASE WHEN instr(pnote,':')>0 THEN substr(pnote,1,instr(pnote,':')-1) ELSE pnote END note,"
        + " COUNT(*) n, MAX(pnote) sample FROM filing"
        + " WHERE type='ptr' AND pnote IS NOT NULL GROUP BY note ORDER BY n DESC LIMIT 8").all(); } catch (_) { return []; } },
    congressBumpTry(fid) { const d = this.openCongress(); if (!d) return;
      try { d.prepare("UPDATE filing SET tries=COALESCE(tries,0)+1 WHERE id=?").run(String(fid)); } catch (_) {} },
    // The feed: transactions newest-FILED first, because the filing date is when the market learned.
    congressFeed(opt) { const d = this.openCongress(); if (!d) return [];
      const o = opt || {}, where = ["f.parsed=1"], args = [];
      if (o.ticker) { where.push("t.ticker=?"); args.push(String(o.ticker).toUpperCase()); }
      if (o.since) { where.push("f.filed>=?"); args.push(String(o.since)); }
      // Search runs in SQL, over every parsed transaction. Filtering the loaded page in the browser
      // silently scoped every search to the most recent few hundred rows — so a member whose
      // filings sat outside that window read as "not in the tool" rather than "not on this page".
      if (o.q) { const like = "%" + String(o.q).replace(/[%_]/g, "") + "%";
        where.push("(f.member LIKE ? OR t.asset LIKE ? OR t.ticker LIKE ?)");
        args.push(like, like, like.toUpperCase()); }
      const lim = Math.max(1, Math.min(500, o.limit | 0 || 50));
      const off = Math.max(0, o.offset | 0);
      // Sort in SQL, from a WHITELIST: a header click has to order the whole result set, not the
      // page that happens to be loaded — paginating a browser-sorted page would show a different
      // "top" on every page. The map is closed, so a sort key can never reach the query as text.
      const SORTS = { filed: "f.filed", lag: "(julianday(f.filed) - julianday(t.txDate))",
        member: "f.member", asset: "t.asset", ticker: "t.ticker", act: "t.act",
        band: "t.loAmt", traded: "t.txDate", notified: "t.notified", atype: "t.atype",
        owner: "t.owner", dist: "(f.state || f.dist)" };
      const col = SORTS[o.sort] || SORTS.filed;
      const dir = (o.dir == null || Number.isNaN(+o.dir) ? -1 : +o.dir) < 0 ? "DESC" : "ASC";
      try { return d.prepare(`SELECT f.filed, f.member, f.state, f.dist, f.url, t.fid, t.ln, t.owner, t.asset,
        t.ticker, t.act, t.txDate, t.notified, t.loAmt, t.hiAmt, t.tkSrc, t.atype
        FROM tx t JOIN filing f ON f.id=t.fid WHERE ${where.join(" AND ")}
        ORDER BY ${col} ${dir}, f.filed DESC, t.fid DESC, t.ln LIMIT ? OFFSET ?`)
        .all(...args, lim, off); } catch (_) { return []; } },
    // The row count behind the current filter, so the pager says "of N" honestly rather than
    // implying the loaded page is everything there is.
    congressFeedCount(opt) { const d = this.openCongress(); if (!d) return 0;
      const o = opt || {}, where = ["f.parsed=1"], args = [];
      if (o.ticker) { where.push("t.ticker=?"); args.push(String(o.ticker).toUpperCase()); }
      if (o.since) { where.push("f.filed>=?"); args.push(String(o.since)); }
      if (o.q) { const like = "%" + String(o.q).replace(/[%_]/g, "") + "%";
        where.push("(f.member LIKE ? OR t.asset LIKE ? OR t.ticker LIKE ?)");
        args.push(like, like, like.toUpperCase()); }
      try { const r = d.prepare(`SELECT COUNT(*) n FROM tx t JOIN filing f ON f.id=t.fid
        WHERE ${where.join(" AND ")}`).get(...args);
        return (r && r.n) || 0; } catch (_) { return 0; } },
    // "Why can't I find this member?" answered from the INDEX rather than from the parsed subset:
    // the index knows about every filer, so it can distinguish "never filed" from "filed, not read
    // yet" from "filed on paper, and this lane has no OCR". Those are three different answers and
    // the tool was giving the same silence to all of them.
    // Starred members. Keyed on the member string exactly as the Clerk's index spells it, which is
    // the only identifier a filing actually carries — there is no CIK here, and normalising the
    // name would invent an identity the source does not have.
    congressWatchList() { const d = this.openCongress(); if (!d) return [];
      try { return d.prepare("SELECT member, at, notify FROM watch ORDER BY member").all(); } catch (_) { return []; } },
    congressWatchSet(member, on, notify) { const d = this.openCongress(); if (!d) return false;
      const m = String(member || "").trim();
      if (!m) return false;
      try {
        if (on) d.prepare("INSERT INTO watch(member,at,notify) VALUES(?,?,?) ON CONFLICT(member) DO UPDATE SET notify=excluded.notify")
          .run(m, Date.now(), notify === false ? 0 : 1);
        else d.prepare("DELETE FROM watch WHERE member=?").run(m);
        return true;
      } catch (_) { return false; } },
    congressWatched(member) { const d = this.openCongress(); if (!d) return null;
      try { return d.prepare("SELECT member, notify FROM watch WHERE member=?").get(String(member || "")) || null; } catch (_) { return null; } },
    congressFilerSearch(q) { const d = this.openCongress(); if (!d) return [];
      const like = "%" + String(q || "").replace(/[%_]/g, "") + "%";
      try { return d.prepare(`SELECT member, COUNT(*) n,
        SUM(CASE WHEN parsed=1 THEN 1 ELSE 0 END) done,
        SUM(CASE WHEN parsed=0 THEN 1 ELSE 0 END) queued,
        SUM(CASE WHEN parsed=2 THEN 1 ELSE 0 END) unreadable,
        MAX(filed) last, MIN(yr) yr0, MAX(yr) yr1
        FROM filing WHERE type='ptr' AND member LIKE ? GROUP BY member ORDER BY n DESC LIMIT 12`).all(like); }
      catch (_) { return []; } },
    // Per-ticker roll-up. Every sum is over the band FLOOR and is therefore a hard lower bound —
    // the caller renders it with a ≥, and no midpoint is computed anywhere in this lane.
    congressTickerRoll(ticker) { const d = this.openCongress(); if (!d) return null;
      const tk = String(ticker || "").toUpperCase();
      try {
        const rows = d.prepare(`SELECT f.member, f.state, f.dist, f.filed, t.act, t.txDate, t.loAmt
          FROM tx t JOIN filing f ON f.id=t.fid WHERE t.ticker=? AND f.parsed=1
          ORDER BY f.filed DESC`).all(tk);
        if (!rows.length) return null;
        const by = new Map();
        for (const r of rows) {
          let m = by.get(r.member);
          if (!m) { m = { member: r.member, state: r.state, dist: r.dist, n: 0, buys: 0, sells: 0,
            floor: 0, lags: [], last: r.filed }; by.set(r.member, m); }
          m.n++;
          if (/^buy/.test(r.act)) m.buys++; else if (/^sell/.test(r.act)) m.sells++;
          m.floor += r.loAmt || 0;
          if (r.filed && r.txDate) m.lags.push(Math.round((Date.parse(r.filed) - Date.parse(r.txDate)) / 86400000));
        }
        const med = (a) => { if (!a.length) return null; const b = a.slice().sort((x, y) => x - y);
          return b.length % 2 ? b[(b.length - 1) / 2] : Math.round((b[b.length / 2 - 1] + b[b.length / 2]) / 2); };
        const members = [...by.values()].map((m) => ({ ...m, medLag: med(m.lags), lags: undefined }))
          .sort((a, b) => b.floor - a.floor || b.n - a.n);
        return { ticker: tk, filings: rows.length, members,
          buys: rows.filter((r) => /^buy/.test(r.act)).length,
          sells: rows.filter((r) => /^sell/.test(r.act)).length,
          floor: rows.reduce((s2, r) => s2 + (r.loAmt || 0), 0) };
      } catch (_) { return null; } },
    // The two rates that have to be printed on the panel before the admin gate can come off.
    congressParseStats() { const d = this.openCongress(); if (!d) return null;
      try {
        const p = d.prepare("SELECT COUNT(*) n FROM filing WHERE type='ptr' AND parsed=1").get() || {};
        const u = d.prepare("SELECT COUNT(*) n FROM filing WHERE type='ptr' AND parsed=2").get() || {};
        const q = d.prepare("SELECT COUNT(*) n FROM filing WHERE type='ptr' AND parsed=0").get() || {};
        const t = d.prepare("SELECT COUNT(*) n, SUM(CASE WHEN ticker IS NULL THEN 0 ELSE 1 END) got,"
          + " SUM(CASE WHEN tkSrc='n/a' THEN 1 ELSE 0 END) na FROM tx").get() || {};
        return { parsed: p.n || 0, unreadable: u.n || 0, pending: q.n || 0,
          tx: t.n || 0, resolved: t.got || 0, noTicker: t.na || 0, notes: this.congressNotes() };
      } catch (_) { return null; } },
    congressFilings(opt) { const d = this.openCongress(); if (!d) return [];
      const o = opt || {};
      const where = [], args = [];
      if (o.type) { where.push("type=?"); args.push(String(o.type)); }
      if (o.since) { where.push("filed>=?"); args.push(String(o.since)); }
      const lim = Math.max(1, Math.min(500, o.limit | 0 || 50));
      try { return d.prepare("SELECT id, member, state, dist, type, filed, url, parsed FROM filing"
        + (where.length ? " WHERE " + where.join(" AND ") : "") + " ORDER BY filed DESC, id DESC LIMIT ?").all(...args, lim); }
      catch (_) { return []; } },
    saveDerivMap(data) {
      try {
        const tmp = derivMapFile + ".tmp";
        fs.writeFileSync(tmp, JSON.stringify(data));
        fs.renameSync(tmp, derivMapFile);
      } catch (_) {}
    },
    loadDerivMap() {
      try { if (fs.existsSync(derivMapFile)) return JSON.parse(fs.readFileSync(derivMapFile, "utf8")); }
      catch (_) {}
      return null;
    },
    close() { flush(); this.flushDerivs(); try { if (cdb) cdb.close(); } catch (_) {} },
  };
}

module.exports = { openStore };
