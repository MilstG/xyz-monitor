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

// Request weights, per Hyperliquid's documented formula: candleSnapshot costs 20 + ceil(bars/60)
// and fundingHistory 20 + ceil(items/20). The old flat per-lane constants were tuned when every
// pull was small, then the windows deepened (90d hourly, 370d daily, 60d funding, 17d of 5m) and the
// constants never followed — a 2160-bar hourly pull was charged 35 against a real 56, and a 1440-row
// funding pull 20 against 92, so the ledger under-counted by ~2-4x on exactly the heaviest calls
// and the "4% headroom" under the 1200 cap was fiction. Callers derive the bar count from the span
// they actually ask for; the server clips to 5000 bars, so the charge is capped there too.
const CANDLE_MAX_BARS = 5000;
function candleWeight(bars) {
  const b = Math.min(CANDLE_MAX_BARS, Math.max(1, Math.ceil(Number.isFinite(bars) ? bars : 1)));
  return 20 + Math.ceil(b / 60);
}
function fundingWeight(items) {
  const n = Math.min(CANDLE_MAX_BARS, Math.max(1, Math.ceil(Number.isFinite(items) ? items : 1)));
  return 20 + Math.ceil(n / 20);
}

// Sliding-window weight ledger (build 2026.09.24-101). The limiter used to rebuild its event array
// with filter() and re-sum it with reduce() on EVERY grant check — O(events in the last minute),
// i.e. a few hundred allocations per pump under load. Grants are stamped with Date.now(), so the
// array is in time order and expiry is always a prefix: pop expired events off the front and keep
// a running sum. An out-of-order stamp (a wall-clock step backwards) is inserted in order, so the
// set of live events — and therefore used() — is exactly what the filter+reduce computed: an event
// is live iff now - t < windowMs.
function usageWindow(windowMs) {
  let ev = [], head = 0, sum = 0;
  function expire(now) {
    while (head < ev.length && !(now - ev[head].t < windowMs)) { sum -= ev[head].w; head++; }
    if (head === ev.length) { ev = []; head = 0; sum = 0; }   // empty: reset (and shed any float drift)
    else if (head > 512 && head * 2 > ev.length) { ev = ev.slice(head); head = 0; }   // amortized compaction
  }
  return {
    push(t, w) {
      const e = { t, w };
      if (ev.length === head || ev[ev.length - 1].t <= t) ev.push(e);
      else { let i = ev.length; while (i > head && ev[i - 1].t > t) i--; ev.splice(i, 0, e); }
      sum += w;
    },
    used(now) { expire(now); return sum; },
    oldest() { return head < ev.length ? ev[head].t : null; },
    size() { return ev.length - head; },
  };
}

const limiter = (() => {
  const MAX = 1150;
  const win = usageWindow(60000);
  // A 429 from Hyperliquid pauses EVERY caller, not just the one that saw it: with 4% headroom
  // under the 1200 cap, one caller backing off while the rest keep firing at full budget is how
  // a blip turned into a minute of 429s. Retry-After when they send one, a growing pause if not.
  let pausedUntil = 0;
  // FIFO queue of waiters. The old acquire was "whoever polls first wins": every waiter slept its
  // own timer and re-checked, so a 92-weight cold pull could sit behind an endless stream of
  // 21-weight tail pulls that each fit in the gap it was waiting for — the tail names of the 5m
  // lane and the funding backfill starved for exactly as long as the small callers kept coming.
  // Now the HEAD of the queue is the only request that can be granted, so a big request holds its
  // place and the small ones queue behind it. `priority` inserts ahead of the plain waiters (behind
  // earlier priority waiters): the universe poll carries membership for every other lane and must
  // not queue behind a minute of candle pulls.
  const queue = [];   // { w, prio, resolve }
  let timer = null;
  function usedNow(now) { return win.used(now); }
  function pump() {
    if (timer) { clearTimeout(timer); timer = null; }
    while (queue.length) {
      const now = Date.now();
      if (now < pausedUntil) { timer = setTimeout(pump, Math.min(pausedUntil - now, 5000)); return; }
      const head = queue[0];
      if (usedNow(now) + head.w <= MAX) { win.push(now, head.w); queue.shift(); head.resolve(); continue; }
      const oldest = win.oldest();
      const wait = oldest != null ? 60000 - (now - oldest) + 40 : 120;
      timer = setTimeout(pump, Math.max(wait, 120) + Math.floor(Math.random() * 200));
      return;
    }
  }
  return {
    acquire(w, opts) {
      w = Math.min(Math.max(0, w || 0), MAX);   // a weight above the window could never be granted
      return new Promise((resolve) => {
        const ent = { w, prio: !!(opts && opts.priority), resolve };
        if (ent.prio) { let i = 0; while (i < queue.length && queue[i].prio) i++; queue.splice(i, 0, ent); }
        else queue.push(ent);
        pump();
      });
    },
    pause(ms) { pausedUntil = Math.max(pausedUntil, Date.now() + ms); },
    queued() { return queue.length; },
    usage() {
      const now = Date.now();
      const used = win.used(now);
      return { used, max: MAX, pct: Math.round((100 * used) / MAX), pausedMs: Math.max(0, pausedUntil - now), queued: queue.length };
    },
  };
})();
function limiterUsage() { return limiter.usage(); }

// Every ATTEMPT is charged to the limiter — the weight is spent on the wire whether or not the
// reply is usable, and charging once for up to three sends was how retries overshot the cap. A
// 4xx other than 429/408 is the request's fault and is not retried; the last failure does not
// sleep before throwing.
const RETRYABLE = (status) => status === 429 || status === 408 || status >= 500;
async function infoPost(payload, weight, fetchImpl, opts) {
  const doFetch = fetchImpl || fetch;
  let lastErr;
  for (let a = 0; a < 3; a++) {
    await limiter.acquire(weight, opts);
    try {
      const ctrl = new AbortController();
      const to = setTimeout(() => ctrl.abort(), 20000);
      let res;
      try {
        res = await doFetch(API, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload),
          signal: ctrl.signal,
        });
      } finally { clearTimeout(to); }
      if (res.status === 429) {
        const ra = parseInt(res.headers && res.headers.get && res.headers.get("retry-after"), 10);
        limiter.pause(Number.isFinite(ra) && ra > 0 ? Math.min(60, ra) * 1000 : 2500 * (a + 1));
        lastErr = new Error("HTTP 429");
        continue;
      }
      if (!res.ok) {
        const err = new Error("HTTP " + res.status);
        if (!RETRYABLE(res.status)) throw Object.assign(err, { fatal: true });
        throw err;
      }
      return await res.json();
    } catch (e) {
      if (e && e.fatal) throw e;
      lastErr = e;
      if (a < 2) await sleep(700 * (a + 1) + Math.floor(Math.random() * 300));
    }
  }
  throw lastErr || new Error("request failed");
}

// The universe poll jumps the limiter queue: it is the one call every other lane depends on for
// membership, it is small (20), and it must not wait out a minute of queued candle pulls.
function fetchMetaAndCtxs(dex) {
  return infoPost({ type: "metaAndAssetCtxs", dex }, 20, null, { priority: true });
}
function fetchCandles(coin, interval, startTime, endTime, weight) {
  return infoPost({ type: "candleSnapshot", req: { coin, interval, startTime, endTime } }, weight);
}
// A wallet's open perp positions on ONE dex. HIP-3 dexes keep their own clearinghouse, so the
// xyz book and the main-dex book are two calls; `dex` empty = the main perp universe. Weight 2.
function fetchClearinghouseState(user, dex, fetchImpl) {
  return infoPost(Object.assign({ type: "clearinghouseState", user }, dex ? { dex } : {}), 2, fetchImpl);
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
// `wsImpl` / `pingMs` / `staleMs` / `backoffMs` are harness seams: production passes none of them and
// gets the global WebSocket on the 45s ping / 120s stale / 1s backoff cadence.
function createUniverseSocket({ onCtxs, log, wsImpl, pingMs, staleMs, backoffMs }) {
  const WS = wsImpl || globalThis.WebSocket;
  const PING_MS = pingMs || 45000, STALE_MS = staleMs || WS_STALE_MS, BACKOFF0 = backoffMs || 1000;
  if (typeof WS !== "function") {
    log("WebSocket client unavailable (needs Node >= 22) — universe stays on the 30s REST cadence");
    return { enabled: false, healthy: () => false, status: () => ({ enabled: false }), close() {} };
  }
  let ws = null, pingT = null, closed = false;
  // lastMsg: anything from the peer (pongs included) — proves the socket is alive.
  // lastData: a ctxs event — proves the SUBSCRIPTION is alive. Health and the watchdog read the
  // second: pongs kept a dead subscription looking healthy, REST dropped to its slow reconcile
  // cadence, and the board went 150s stale while status said "connected".
  let lastMsg = 0, lastData = 0, msgs = 0, reconnects = 0, backoff = BACKOFF0, loggedUp = false, gotData = false;

  // Watchdog recovery. The first version force-closed the zombie and relied on ws.close() to fire
  // onclose, which then ran retry(). On undici a mute-but-open peer can sit in CLOSING forever — the
  // close handshake needs the peer to answer, and a peer that has stopped answering is the entire
  // diagnosis — so onclose never fired, the ping timer kept force-closing a socket already CLOSING,
  // and the feed stayed dead while status said "connected". Now the watchdog does not wait for the
  // socket's opinion: it detaches every handler (a late onclose from the abandoned socket must not
  // trigger a SECOND retry), drops the reference, stops the ping timer and enters the backoff path
  // itself. The abandoned socket is closed best-effort and left to the GC.
  function abandon() {
    const dead = ws;
    ws = null;
    clearInterval(pingT); pingT = null;
    if (dead) {
      try { dead.onopen = null; dead.onmessage = null; dead.onclose = null; dead.onerror = null; } catch (_) {}
      try { dead.close(); } catch (_) {}
    }
    retry();
  }
  function connect() {
    if (closed) return;
    try { ws = new WS(WS_URL); } catch (_) { retry(); return; }
    ws.onopen = () => {
      gotData = false;   // backoff resets on the first DATA event, not here (accept-then-close must not loop at 1s)
      lastMsg = Date.now(); lastData = lastMsg;   // arm the watchdog at open, so a socket that never delivers a single message is also caught
      try { ws.send(JSON.stringify({ method: "subscribe", subscription: { type: "allDexsAssetCtxs" } })); } catch (_) {}
      clearInterval(pingT);
      pingT = setInterval(() => {
        // Watchdog first: total DATA silence past the threshold means the peer or the subscription
        // is gone even though the socket claims open — abandon it and reconnect on our own clock
        // (see abandon(): waiting for the zombie's onclose is what left the feed dead before).
        if (Date.now() - lastData > STALE_MS) { abandon(); return; }   // no DATA — dead peer or dead subscription, same cure
        try { if (ws && ws.readyState === 1) ws.send('{"method":"ping"}'); } catch (_) {}
      }, PING_MS);
    };
    ws.onmessage = (ev) => {
      let m; try { m = JSON.parse(ev.data); } catch (_) { return; }
      if (!m || typeof m !== "object") return;
      if (m.channel === "pong" || m.channel === "subscriptionResponse") { lastMsg = Date.now(); return; }
      if (m.channel !== "allDexsAssetCtxs" || !m.data || !Array.isArray(m.data.ctxs)) return;
      lastData = Date.now();
      if (!gotData) { gotData = true; backoff = BACKOFF0; }
      lastMsg = Date.now(); msgs++;
      if (!loggedUp) { loggedUp = true; log("WebSocket universe feed LIVE (allDexsAssetCtxs) — prices now push in real time; REST drops to a slow reconciliation poll"); }
      try { onCtxs(m.data.ctxs); } catch (_) {}
    };
    ws.onclose = () => { clearInterval(pingT); retry(); };
    ws.onerror = () => { try { if (ws) ws.close(); } catch (_) {} };
  }
  function retry() {
    if (closed) return;
    reconnects++;
    setTimeout(connect, backoff + Math.floor(Math.random() * backoff * 0.4));   // jitter: a fleet reconnecting in lockstep is its own outage
    backoff = Math.min(backoff * 2, 60000);
  }
  connect();
  log("WebSocket universe feed: connecting to " + WS_URL);
  return {
    enabled: true,
    // healthy = we've decoded at least one ctxs event and heard from the server recently
    healthy: () => msgs > 0 && Date.now() - lastData < 90000,
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
// `sleep429CapMs` is a harness seam (production: 60s).
function createCoinalyze({ key, log, sleep429CapMs }) {
  if (!key) return null;
  // Every ATTEMPT is charged: the units are spent on the wire whether or not the reply is usable,
  // and charging once for up to three sends let retries overshoot the 40/min ceiling — the same
  // bug the Hyperliquid limiter had. The 429 sleeps are capped in TOTAL per call (60s): three
  // Retry-After headers at the 60s clamp were three minutes of one lane holding its worker.
  const CZ_429_SLEEP_CAP = sleep429CapMs || 60000;
  async function czGet(path, params, units) {
    const qs = new URLSearchParams(params).toString();
    const url = CZ_API + path + (qs ? "?" + qs : "");
    let lastErr, slept429 = 0;
    for (let a = 0; a < 3; a++) {
      await czLimiter.acquire(units);
      try {
        const ctrl = new AbortController();
        const to = setTimeout(() => ctrl.abort(), 25000);
        let res;
        try { res = await fetch(url, { headers: { api_key: key }, signal: ctrl.signal }); }
        finally { clearTimeout(to); }
        if (res.status === 429) {
          const ra = Math.min(60, Math.max(2, parseInt(res.headers.get("retry-after"), 10) || 5)) * 1000;
          lastErr = new Error("HTTP 429");
          if (slept429 + ra > CZ_429_SLEEP_CAP) break;   // this call's waiting budget is spent — fail it; the sweep retries on its own cadence
          slept429 += ra;
          await sleep(ra); continue;
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

module.exports = { usageWindow, infoPost, fetchMetaAndCtxs, fetchCandles, fetchFundingHistory, fetchClearinghouseState, sleep, limiterUsage, limiter, candleWeight, fundingWeight, CANDLE_MAX_BARS, createUniverseSocket, createCoinalyze };
