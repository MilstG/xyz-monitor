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
// Zombie-socket watchdog threshold: a half-open TCP connection (peer gone, no FIN ever
// arrives) fires NO onclose, so the reconnect path never runs — the socket sits "open" and
// mute forever while REST quietly carries the load. The subscription pushes sub-second and
// pongs answer within the 45s ping cadence, so 120s of total silence on a socket that claims
// to be open is not a quiet market — it is a dead peer. The ping tick force-closes it, which
// routes into the normal onclose -> backoff -> reconnect path.
const WS_STALE_MS = 120000;
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
      lastMsg = Date.now();   // arm the watchdog at open, so a socket that never delivers a single message is also caught
      try { ws.send(JSON.stringify({ method: "subscribe", subscription: { type: "allDexsAssetCtxs" } })); } catch (_) {}
      clearInterval(pingT);
      pingT = setInterval(() => {
        // Watchdog first: total silence past the threshold means the peer is gone even though
        // the socket claims open — force-close so onclose fires and the backoff reconnect runs.
        // Repeat fires while CLOSING are harmless (close() no-ops / throws into the catch).
        if (Date.now() - lastMsg > WS_STALE_MS) { try { ws.close(); } catch (_) {} return; }
        try { if (ws && ws.readyState === 1) ws.send('{"method":"ping"}'); } catch (_) {}
      }, 45000);
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

// ---- Coinalyze client -----------------------------------------------------------------
// Aggregated CEX derivatives context (liquidations + open interest) for the crypto universe.
// Coinalyze's limit is 40 API calls/min where EACH SYMBOL in a batched request consumes one
// call — a 20-symbol batch costs 20 units. We cap at 38 units/min, which naturally paces a
// 60-name sweep at ~2 batch requests per minute (~3 min per full sweep). Same event-window
// limiter shape as the Hyperliquid one above; 429s additionally honor Retry-After.
const CZ_API = "https://api.coinalyze.net/v1";
const czLimiter = (() => {
  const MAX = 38;
  let ev = [];
  return {
    async acquire(u) {
      for (;;) {
        const now = Date.now();
        ev = ev.filter((e) => now - e.t < 60000);
        const used = ev.reduce((s, e) => s + e.u, 0);
        if (used + u <= MAX) { ev.push({ t: now, u }); return; }
        await sleep(Math.max(60000 - (now - ev[0].t) + 40, 250));
      }
    },
    usage() {
      const now = Date.now();
      ev = ev.filter((e) => now - e.t < 60000);
      return { used: ev.reduce((s, e) => s + e.u, 0), max: MAX };
    },
  };
})();
function createCoinalyze({ key, log }) {
  if (!key) return null;
  async function czGet(path, params, units) {
    await czLimiter.acquire(units);
    const qs = new URLSearchParams(params).toString();
    const url = CZ_API + path + (qs ? "?" + qs : "");
    let lastErr;
    for (let a = 0; a < 3; a++) {
      try {
        const ctrl = new AbortController();
        const to = setTimeout(() => ctrl.abort(), 25000);
        let res;
        try { res = await fetch(url, { headers: { api_key: key }, signal: ctrl.signal }); }
        finally { clearTimeout(to); }
        if (res.status === 429) {
          const ra = Math.min(60, Math.max(2, parseInt(res.headers.get("retry-after"), 10) || 5));
          await sleep(ra * 1000); continue;
        }
        if (res.status === 401) throw Object.assign(new Error("invalid Coinalyze API key"), { fatal: true });
        if (!res.ok) throw new Error("HTTP " + res.status);
        return await res.json();
      } catch (e) {
        if (e && e.fatal) throw e;
        lastErr = e;
        await sleep(900 * (a + 1));
      }
    }
    throw lastErr || new Error("coinalyze request failed");
  }
  return {
    exchanges: () => czGet("/exchanges", {}, 1),
    futureMarkets: () => czGet("/future-markets", {}, 1),
    // Batched histories: symbols is an array (<= 20), each costing one call-unit.
    // USD conversion is done source-side (convert_to_usd) — stored as-received, labeled as such.
    liqHistory: (symbols, interval, from, to) =>
      czGet("/liquidation-history", { symbols: symbols.join(","), interval,
        from: Math.floor(from / 1000), to: Math.floor(to / 1000), convert_to_usd: "true" }, symbols.length),
    oiHistory: (symbols, interval, from, to) =>
      czGet("/open-interest-history", { symbols: symbols.join(","), interval,
        from: Math.floor(from / 1000), to: Math.floor(to / 1000), convert_to_usd: "true" }, symbols.length),
    usage: () => czLimiter.usage(),
  };
}

module.exports = { infoPost, fetchMetaAndCtxs, fetchCandles, fetchFundingHistory, sleep, limiterUsage, createUniverseSocket, createCoinalyze };
