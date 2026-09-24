"use strict";
// npm run bench [markets] — how long the poller's synchronous builds hold the event loop on a
// synthetic book (31d hourly + 370d daily spines per market, no network). This is the measurement
// the worker-thread question turns on: the loop histogram on /api/health says what production
// sees, this says what each build costs in isolation. Read together with the tick durations there.
//
// Since build 2026.09.24-101 it also times the features persist (sync vs the skip/async path) and
// the loop delay while the candles.db VACUUM INTO runs in-process vs in the worker thread.
//
// Reference run (150 markets, this container, build 2026.09.16-80): featuresFromHourly ~0.9ms per
// market; buildSnapshot 12–35ms warm, ~200ms cold; buildDaily 17–37ms warm, ~460ms cold; buildTrend
// 20–46ms; buildSignals ~2.3s but cooperative (it yields); loop p99 16ms under a 200ms build
// cadence. Shipping a market's 370 daily bars to a worker (structured clone) costs more than the
// level-map work on them, so the snapshot build stays on the loop until these numbers say otherwise.
const { openStore } = require("../src/store");
const { createPoller } = require("../src/poller");
const { featuresFromHourly } = require("../src/compute");
const fs = require("fs"), path = require("path"), os = require("os");
const { monitorEventLoopDelay } = require("perf_hooks");
const HOUR = 3600e3, DAY = 86400e3;
const N = +process.argv[2] || 150;
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "xyzbench-"));
const p = createPoller({ dex: "xyz", store: openStore(dir), log: () => {}, version: "bench", crypto: false });
const now = Math.floor(Date.now() / HOUR) * HOUR;
let seed = 7; const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
const mkHourly = (px) => { const a = []; let c = px; for (let i = 31 * 24; i > 0; i--) { const o = c; c = c * (1 + (rnd() - 0.5) * 0.01); a.push({ t: now - i * HOUR, o, h: Math.max(o, c) * 1.002, l: Math.min(o, c) * 0.998, c, v: 1000 + rnd() * 5000 }); } return a; };
const mkDaily = (px) => { const a = []; let c = px; for (let i = 370; i > 0; i--) { const o = c; c = c * (1 + (rnd() - 0.5) * 0.03); a.push({ t: Math.floor(now / DAY) * DAY - i * DAY, o: String(o), h: String(Math.max(o, c) * 1.01), l: String(Math.min(o, c) * 0.99), c: String(c), v: String(1e5 + rnd() * 1e6) }); } return a; };
const t0 = Date.now();
for (let i = 0; i < N; i++) { const px = 50 + rnd() * 400; const fh = new Map(); for (let h = 31 * 24; h > 0; h--) fh.set(now - h * HOUR, (rnd() - 0.5) * 1e-4);
  p.seedRowNow("xyz:S" + i, { px, ticker: "S" + i, uni: "xyz", vol: 1e6 + rnd() * 5e7, oi: 1e6 + rnd() * 2e7, funding: 1e-5, fundH: fh, hourlyRaw: mkHourly(px), hourlyTs: now, dailyRaw: mkDaily(px), dailyTs: now, prevDay: px }); }
console.log(`seeded ${N} markets in ${Date.now() - t0}ms`);
const time = (name, fn, reps = 3) => { const out = []; for (let k = 0; k < reps; k++) { const a = process.hrtime.bigint(); fn(); out.push(Number(process.hrtime.bigint() - a) / 1e6); } console.log(name.padEnd(28), out.map((x) => x.toFixed(1) + "ms").join("  ")); };
(async () => {
  // features from a 31d hourly spine, per market (what refreshHourly runs after each fetch)
  const hs = p.seedRowNow("xyz:S0", {}).hourlyRaw;
  const obj = hs.map((k) => ({ t: k[0], o: k[1], h: k[2], l: k[3], c: k[4], v: k[5] }));
  time("featuresFromHourly x1", () => featuresFromHourly(obj, now, HOUR, DAY), 5);
  time(`featuresFromHourly x${N}`, () => { for (let i = 0; i < N; i++) featuresFromHourly(obj, now, HOUR, DAY); }, 2);
  time("buildDaily", () => p.buildDailyNow());
  time("buildSnapshot (cold)", () => p.buildSnapshotNow(), 1);
  time("buildSnapshot (warm)", () => p.buildSnapshotNow(), 4);
  time("buildTrend", () => p.buildTrendNow());
  const a = Date.now(); await p.buildSignalsNow(); console.log("buildSignals (async)".padEnd(28), (Date.now() - a) + "ms");
  const b = Date.now(); await p.buildAnalyticsNow(); console.log("buildAnalytics (async)".padEnd(28), (Date.now() - b) + "ms");
  time("buildSnapshot (after all)", () => p.buildSnapshotNow(), 3);
  // event-loop delay under a steady snapshot cadence: what a client-facing request waits behind
  const h = monitorEventLoopDelay({ resolution: 5 }); h.enable();
  const iv = setInterval(() => p.buildSnapshotNow(), 200); await new Promise((r) => setTimeout(r, 3000)); clearInterval(iv); h.disable();
  console.log("loop delay under 200ms snapshot cadence: p50", (h.percentile(50) / 1e6).toFixed(1), "ms  p99", (h.percentile(99) / 1e6).toFixed(1), "ms  max", (h.max / 1e6).toFixed(1), "ms");
  // Persistence + backup paths (build 2026.09.24-101). persistFeatures: the full sync write (what
  // shutdown still does) vs the 120s timer's path, which skips on an unchanged signature and
  // otherwise writes through fs.promises. VACUUM INTO: loop delay while the candles.db off-copy
  // runs in-process (the old daily path) vs in the worker thread (the new one), on a synthetic
  // archive of N markets x 3000 5m bars.
  time("persistFeatures (sync)", () => p.persistFeatures(), 3);
  { const a = process.hrtime.bigint(); const r = await p.persistFeaturesAsync(); console.log(("persistFeaturesAsync " + r).padEnd(28), (Number(process.hrtime.bigint() - a) / 1e6).toFixed(1) + "ms (unchanged inputs)"); }
  { p.seedRowNow("xyz:S0", { feat: { bench: Date.now() } }); const a = process.hrtime.bigint(); const r = await p.persistFeaturesAsync(); console.log(("persistFeaturesAsync " + r).padEnd(28), (Number(process.hrtime.bigint() - a) / 1e6).toFixed(1) + "ms wall (one market changed; disk time off-loop)"); }
  const st = openStore(dir);
  if (st.candlesEnabled && st.candlesEnabled()) {
    const t5 = Math.floor(now / 300000) * 300000;
    for (let i = 0; i < N; i++) { const rows = []; let c = 100; for (let k = 3000; k > 0; k--) { const o = c; c = c * (1 + (rnd() - 0.5) * 0.004); rows.push([t5 - k * 300000, o, Math.max(o, c), Math.min(o, c), c, rnd() * 1e4]); } st.insertCandles("xyz:S" + i, rows); }
    const loopDuring = async (label, fn) => {
      const h = monitorEventLoopDelay({ resolution: 5 }); h.enable();
      await new Promise((r) => setTimeout(r, 30));   // let the sampler arm before the measured work
      const a = Date.now(); await fn(); const ms = Date.now() - a;
      await new Promise((r) => setTimeout(r, 20)); h.disable();
      console.log(label.padEnd(28), ms + "ms wall  loop p99", (h.percentile(99) / 1e6).toFixed(1), "ms  max", (h.max / 1e6).toFixed(1), "ms");
    };
    console.log(`candles.db: ${N * 3000} 5m bars, ${(fs.statSync(path.join(dir, "candles.db")).size / 1048576).toFixed(1)} MB`);
    await loopDuring("VACUUM INTO (in-process)", async () => { st.snapshotCandles(); });
    await loopDuring("VACUUM INTO (worker)", () => st.snapshotCandlesAsync());
    st.close();
  }
  fs.rmSync(dir, { recursive: true, force: true }); process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
