"use strict";
// Persistent open-interest history WITHOUT native dependencies.
// OI accrues over time and can't be re-fetched, so every sample is appended to a plain
// NDJSON-ish log on the mounted volume. On boot we read it back into memory; a daily
// compaction rewrites the file with only the last 31 days. No build toolchain required.
const fs = require("fs");
const path = require("path");

function openStore(dataDir) {
  fs.mkdirSync(dataDir, { recursive: true });
  const file = path.join(dataDir, "oi.log");
  let buf = [];

  function flush() {
    if (!buf.length) return;
    try { fs.appendFileSync(file, buf.join("")); buf = []; }
    catch (_) { /* keep buffer for next attempt */ }
  }

  return {
    insert(coin, ts, oi) {
      buf.push(coin + "\t" + ts + "\t" + oi + "\n");
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
          const i1 = ln.indexOf("\t"), i2 = ln.indexOf("\t", i1 + 1);
          if (i1 < 0 || i2 < 0) continue;
          const coin = ln.slice(0, i1), ts = +ln.slice(i1 + 1, i2), oi = +ln.slice(i2 + 1);
          if (!Number.isFinite(ts) || !Number.isFinite(oi) || ts < since) continue;
          let a = m.get(coin);
          if (!a) { a = []; m.set(coin, a); }
          a.push([ts, oi]);
        }
        for (const a of m.values()) a.sort((x, y) => x[0] - y[0]);
      } catch (_) {}
      return m;
    },
    close() { flush(); },
  };
}

module.exports = { openStore };
