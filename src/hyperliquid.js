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

// ---- WebSocket trades feed (flows) -----------------------------------------------------
// Second socket, dedicated to public `trades` subscriptions for the monitored coins in BOTH
// universes (main-dex coins are bare, xyz coins carry the dex prefix — the exact strings the
// meta universe returns). sync(coins) reconciles the live subscription set against the desired
// one with sub/unsub diffs; a reconnect resubscribes everything. Budget: hard-capped at 400
// coin subscriptions — well inside the 1000-per-IP limit shared with the universe socket.
// Trades are DATA ONLY here: batches are forwarded raw to onTrades and all interpretation
// (TWAP detection, whale harvesting) lives in the poller/compute layer.
function createFlowSocket({ onTrades, log }) {
  if (typeof globalThis.WebSocket !== "function") {
    log("Flow socket unavailable (needs Node >= 22) — TWAP/liquidation tape disabled");
    return { enabled: false, healthy: () => false, status: () => ({ enabled: false }), sync() {}, close() {} };
  }
  const MAX_SUBS = 400;
  let ws = null, pingT = null, closed = false;
  let desired = new Set(), live = new Set();
  let lastMsg = 0, batches = 0, trades = 0, reconnects = 0, backoff = 1000, loggedUp = false;

  function sendSub(method, coin) {
    try { if (ws && ws.readyState === 1) { ws.send(JSON.stringify({ method, subscription: { type: "trades", coin } })); return true; } } catch (_) {}
    return false;
  }
  // Reconcile live vs desired. Called on sync() and on (re)open; paced in one pass — the server
  // allows 2000 WS messages/min, and a full cold sync is ~150 subs, well under it.
  function reconcile() {
    if (!ws || ws.readyState !== 1) return;
    for (const c of live) if (!desired.has(c)) { if (sendSub("unsubscribe", c)) live.delete(c); }
    for (const c of desired) if (!live.has(c)) { if (sendSub("subscribe", c)) live.add(c); }
  }
  function connect() {
    if (closed) return;
    try { ws = new WebSocket(WS_URL); } catch (_) { retry(); return; }
    ws.onopen = () => {
      backoff = 1000; live = new Set();   // server-side subs died with the old connection
      reconcile();
      clearInterval(pingT);
      pingT = setInterval(() => { try { if (ws && ws.readyState === 1) ws.send('{"method":"ping"}'); } catch (_) {} }, 45000);
    };
    ws.onmessage = (ev) => {
      let m; try { m = JSON.parse(ev.data); } catch (_) { return; }
      if (!m || typeof m !== "object") return;
      if (m.channel === "pong" || m.channel === "subscriptionResponse") { lastMsg = Date.now(); return; }
      if (m.channel !== "trades" || !Array.isArray(m.data)) return;
      lastMsg = Date.now(); batches++; trades += m.data.length;
      if (!loggedUp) { loggedUp = true; log("Flow socket LIVE — public trades tape streaming (TWAP + whale detection armed)"); }
      try { onTrades(m.data); } catch (_) {}
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
  log("Flow socket: connecting to " + WS_URL);
  return {
    enabled: true,
    sync(coins) {
      desired = new Set((coins || []).filter((c) => typeof c === "string" && c).slice(0, MAX_SUBS));
      reconcile();
    },
    healthy: () => batches > 0 && Date.now() - lastMsg < 90000,
    status: () => ({
      enabled: true,
      connected: !!(ws && ws.readyState === 1),
      subs: live.size, wanted: desired.size,
      lastMsgAgoS: lastMsg ? Math.round((Date.now() - lastMsg) / 1000) : null,
      batches, trades, reconnects,
    }),
    close() { closed = true; clearInterval(pingT); try { if (ws) ws.close(); } catch (_) {} },
  };
}

module.exports = { infoPost, fetchMetaAndCtxs, fetchCandles, fetchFundingHistory, sleep, limiterUsage, createUniverseSocket, createFlowSocket };
