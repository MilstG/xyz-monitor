"use strict";
// Persistent open-interest history WITHOUT native dependencies.
// OI accrues over time and can't be re-fetched, so every sample is appended to a plain
// NDJSON-ish log on the mounted volume. On boot we read it back into memory; a daily
// compaction rewrites the file with only the last 31 days. No build toolchain required.
const fs = require("fs");
const path = require("path");

const MAX_BUF = 50000; // hard cap on unflushed lines if the volume is unwritable

function openStore(dataDir) {
  fs.mkdirSync(dataDir, { recursive: true });
  const file = path.join(dataDir, "oi.log");
  const featFile = path.join(dataDir, "features.json");
  let buf = [];

  function flush() {
    if (!buf.length) return;
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
    prune(before) {
      flush();
      let removed = 0;
      try {
        if (!fs.existsSync(file)) return 0;
        const lines = fs.readFileSync(file, "utf8").split("\n");
        const keep = [];
        for (const ln of lines) {
          if (!ln) continue;
          const i1 = ln.indexOf("\t"), i2 = ln.indexOf("\t", i1 + 1);
          if (i1 < 0 || i2 < 0) continue;
          const ts = +ln.slice(i1 + 1, i2);
          if (Number.isFinite(ts) && ts >= before) keep.push(ln); else removed++;
        }
        fs.writeFileSync(file, keep.length ? keep.join("\n") + "\n" : "");
      } catch (_) {}
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
    saveFeatures(data) {
      try { fs.writeFileSync(featFile, JSON.stringify(data)); } catch (_) {}
    },
    loadFeatures() {
      try { if (fs.existsSync(featFile)) return JSON.parse(fs.readFileSync(featFile, "utf8")); }
      catch (_) {}
      return null;
    },
    close() { flush(); },
  };
}

module.exports = { openStore };
