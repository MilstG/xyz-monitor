"use strict";
// Thin wrapper around the Hyperliquid public REST /info endpoint, with the same
// weight-based rate limiter the original client used (1200 weight/min/IP; we cap at 1150).
const API = "https://api.hyperliquid.xyz/info";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const limiter = (() => {
  const MAX = 1150;
  let ev = [];
  return {
    async acquire(w) {
      for (;;) {
        const now = Date.now();
        ev = ev.filter((e) => now - e.t < 60000);
        const used = ev.reduce((s, e) => s + e.w, 0);
        if (used + w <= MAX) { ev.push({ t: now, w }); return; }
        await sleep(Math.max(60000 - (now - ev[0].t) + 40, 120));
      }
    },
  };
})();

async function infoPost(payload, weight) {
  await limiter.acquire(weight);
  let lastErr;
  for (let a = 0; a < 3; a++) {
    try {
      const ctrl = new AbortController();
      const to = setTimeout(() => ctrl.abort(), 20000);
      let res;
      try {
        res = await fetch(API, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload),
          signal: ctrl.signal,
        });
      } finally { clearTimeout(to); }
      if (res.status === 429) { await sleep(2500 * (a + 1)); continue; }
      if (!res.ok) throw new Error("HTTP " + res.status);
      return await res.json();
    } catch (e) {
      lastErr = e;
      await sleep(700 * (a + 1));
    }
  }
  throw lastErr || new Error("request failed");
}

function fetchMetaAndCtxs(dex) {
  return infoPost({ type: "metaAndAssetCtxs", dex }, 20);
}
function fetchCandles(coin, interval, startTime, endTime, weight) {
  return infoPost({ type: "candleSnapshot", req: { coin, interval, startTime, endTime } }, weight);
}
function fetchFundingHistory(coin, startTime, endTime, weight) {
  return infoPost({ type: "fundingHistory", coin, startTime, endTime }, weight);
}

module.exports = { infoPost, fetchMetaAndCtxs, fetchCandles, fetchFundingHistory, sleep };
