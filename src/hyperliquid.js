"use strict";
// Thin wrapper around the Hyperliquid public REST /info endpoint, with the same
// weight-based rate limiter the original client used (1200 weight/min/IP; we cap at 1150).
// Also hosts the optional WebSocket universe feed (allDexsAssetCtxs): a zero-weight,
// sub-second push of the same per-asset contexts the REST universe poll returns. It is an
// ACCELERATOR, not a replacement — REST remains the source of truth for universe
// membership (names, new listings, delistings) and the fallback whenever the socket is
// unhealthy. Requires the global WebSocket client (Node >= 22); degrades to pure REST
// silently on older runtimes.
const API = "https://api.hyperliquid.xyz/info";
const WS_URL = "wss://api.hyperliquid.xyz/ws";
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
    usage() {
      const now = Date.now();
      ev = ev.filter((e) => now - e.t < 60000);
      const used = ev.reduce((s, e) => s + e.w, 0);
      return { used, max: MAX, pct: Math.round((100 * used) / MAX) };
    },
  };
})();
function limiterUsage() { return limiter.usage(); }

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

// ---- WebSocket universe feed ----------------------------------------------------------
// Subscribes to { type: "allDexsAssetCtxs" }. Events arrive as
//   { channel: "allDexsAssetCtxs", data: { ctxs: [[dexName, PerpAssetCtx[]], ...] } }
// where each ctx array is index-aligned with that dex's universe order (same alignment as
// metaAndAssetCtxs). Handles the server's 60s idle timeout with a ping, reconnects with
// exponential backoff, and validates message shape before forwarding — a schema change on
// Hyperliquid's side degrades to REST rather than corrupting rows.
function createUniverseSocket({ onCtxs, log }) {
  if (typeof globalThis.WebSocket !== "function") {
    log("WebSocket client unavailable (needs Node >= 22) — universe stays on the 30s REST cadence");
    return { enabled: false, healthy: () => false, status: () => ({ enabled: false }), close() {} };
  }
  let ws = null, pingT = null, closed = false;
  let lastMsg = 0, msgs = 0, reconnects = 0, backoff = 1000, loggedUp = false;

  function connect() {
    if (closed) return;
    try { ws = new WebSocket(WS_URL); } catch (_) { retry(); return; }
    ws.onopen = () => {
      backoff = 1000;
      try { ws.send(JSON.stringify({ method: "subscribe", subscription: { type: "allDexsAssetCtxs" } })); } catch (_) {}
      clearInterval(pingT);
      pingT = setInterval(() => { try { if (ws && ws.readyState === 1) ws.send('{"method":"ping"}'); } catch (_) {} }, 45000);
    };
    ws.onmessage = (ev) => {
      let m; try { m = JSON.parse(ev.data); } catch (_) { return; }
      if (!m || typeof m !== "object") return;
      if (m.channel === "pong" || m.channel === "subscriptionResponse") { lastMsg = Date.now(); return; }
      if (m.channel !== "allDexsAssetCtxs" || !m.data || !Array.isArray(m.data.ctxs)) return;
      lastMsg = Date.now(); msgs++;
      if (!loggedUp) { loggedUp = true; log("WebSocket universe feed LIVE (allDexsAssetCtxs) — prices now push in real time; REST drops to a slow reconciliation poll"); }
      try { onCtxs(m.data.ctxs); } catch (_) {}
    };
    ws.onclose = () => { clearInterval(pingT); retry(); };
    ws.onerror = () => { try { ws.close(); } catch (_) {} };
  }
  function retry() {
    if (closed) return;
    reconnects++;
    setTimeout(connect, backoff);
    backoff = Math.min(backoff * 2, 60000);
  }
  connect();
  log("WebSocket universe feed: connecting to " + WS_URL);
  return {
    enabled: true,
    // healthy = we've decoded at least one ctxs event and heard from the server recently
    healthy: () => msgs > 0 && Date.now() - lastMsg < 90000,
    status: () => ({
      enabled: true,
      connected: !!(ws && ws.readyState === 1),
      lastMsgAgoS: lastMsg ? Math.round((Date.now() - lastMsg) / 1000) : null,
      events: msgs, reconnects,
    }),
    close() { closed = true; clearInterval(pingT); try { if (ws) ws.close(); } catch (_) {} },
  };
}

module.exports = { infoPost, fetchMetaAndCtxs, fetchCandles, fetchFundingHistory, sleep, limiterUsage, createUniverseSocket };
