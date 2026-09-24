"use strict";
// usage-gate.js — the usage beacon's rate gate (build 2026.09.24-110 follow-up).
//
// Before: one accepted beacon per MEMBER per 30s, and anything earlier got a 429 and was dropped.
// The browser's pagehide flush has to bypass its own 30s gap (the page is going away), and
// sendBeacon cannot see a 429 — so a closing page's last minutes were lost, and two tabs or two
// devices of one member dropped each other's beacons.
//
// Now the gate is keyed per (member, page session): the client sends `s`, a random id minted once
// per page load. For each session:
//   * a beacon at least `minGapMs` after that session's last ACCEPTED one is accepted;
//   * an earlier one is HELD (the request still gets 204) and merged into the session's next
//     accepted beacon — or, if none follows (the page closed), released by `sweep`, which the
//     server runs on its regular 60s usage flush;
//   * whatever is accepted is clamped to the wall time since the session's last accepted beacon
//     (at most `maxFlushMs`), so holding and merging never grows a claim.
// Abuse stays bounded however many session ids a client invents: per MEMBER, accepted screen time
// draws on one budget that refills at `uidRate` × wall time (2 = two devices at once) up to
// `uidRate` × `maxFlushMs`, starting at `maxFlushMs`. Total screen time a member can be credited
// is therefore at most maxFlushMs + uidRate × (wall time elapsed). A member keeps at most
// `maxSids` sessions (the least recently accepted is evicted; its held payload is released
// first), and at most `maxHeld` payloads are held server-wide (beyond that: 429, the old answer).
// Everything is in memory: a restart forgets the gates, which loosens at most one beacon.
//
// (build 2026.09.24-111) Two more fields ride through:
//   hrs   the beacon's minutes per clock hour ({UTC hour index -> ms}; ET hours are whole UTC hours).
//         At accept, only hours overlapping THIS accept's wall-time window survive — from the
//         session's last accepted beacon (at most maxFlushMs back) to now, widened by hrSlackMs on
//         both sides for a browser clock that is a little off — and they are scaled down to the
//         accepted screen time. What they leave uncovered lands in the arrival hour (accounts.js).
//   load  "this is the page load's first beacon": let through once per page session.
//
// (build 2026.09.24-112) Three sitewide fields ride through too (stored without the uid):
//   tr    tab→tab transition counts. Merged per key (≤ maxTrN each, ≤ maxTrKeys keys); at accept the
//         TOTAL is clamped to what the accepted wall time allows — a transition needs its destination
//         held for trDwellMs, so a window of W ms holds at most floor(W / trDwellMs) + 1 of them.
//   en    the page load's entry tab: let through once per page session, like load.
//   ctl   control-use counts, merged per key (≤ maxCtlN each, ≤ maxCtlKeys keys).

const DEF = { minGapMs: 30000, maxFlushMs: 120000, uidRate: 2, maxSids: 8, maxHeld: 5000, idleMs: 15 * 60000, maxActs: 50, maxErrs: 5, hrSlackMs: 60000, maxHrs: 8,
  trDwellMs: 2000, maxTrN: 30, maxTrKeys: 40, maxCtlN: 20, maxCtlKeys: 40 };   // (build 2026.09.24-112)
// (-112) Add counts `b` into a copy of `a`, per key, capped per key and in key count. Null-prototype
// objects: the keys were validated upstream, and a copy never inherits anything either way.
function addCounts(a, b, perKey, maxKeys) {
  const out = Object.assign(Object.create(null), a || {});
  let n = Object.keys(out).length;
  for (const [k, v] of Object.entries(b || {})) {
    if (k in out) out[k] = Math.min(perKey, out[k] + v);
    else if (n < maxKeys) { out[k] = Math.min(perKey, v); n++; }
  }
  return out;
}

function createUsageGate(opts) {
  const o = Object.assign({}, DEF, opts || {});
  const sess = new Map();     // uid \u0001 sid -> {uid, sid, last, held}
  const byUid = new Map();    // uid -> Set(session key)
  const budget = new Map();   // uid -> {avail, ts}
  let heldN = 0;

  const empty = (p) => !p || (!Object.keys(p.tabs || {}).length && !Object.keys(p.acts || {}).length && p.perf == null && !(p.errs || []).length && !p.load
    && !Object.keys(p.tr || {}).length && !Object.keys(p.ctl || {}).length && !p.en);   // (-112)
  // Merge a newer payload `b` into an older held one `a` (same page session, so the same build).
  function merge(a, b) {
    if (!a) return b;
    const out = { tabs: Object.assign({}, a.tabs), acts: Object.assign({}, a.acts), pwa: b.pwa, dev: b.dev || a.dev,
      build: b.build || a.build, rawBuild: b.rawBuild || a.rawBuild, perf: a.perf != null ? a.perf : b.perf, errs: (a.errs || []).map((e) => Object.assign({}, e)) };
    for (const [k, v] of Object.entries(b.tabs || {})) out.tabs[k] = Math.min(1e9, (out.tabs[k] || 0) + v);
    for (const [k, v] of Object.entries(b.acts || {})) out.acts[k] = Math.min(o.maxActs, (out.acts[k] || 0) + v);
    // (-111) hour buckets add up (bounded to maxHrs hours); a page load stays a page load
    out.hrs = Object.assign({}, a.hrs);
    for (const [k, v] of Object.entries(b.hrs || {})) if (k in out.hrs || Object.keys(out.hrs).length < o.maxHrs) out.hrs[k] = Math.min(1e9, (out.hrs[k] || 0) + v);
    out.load = !!(a.load || b.load);
    // (-112) paths and controls add up; the entry tab is the first one the session named
    out.tr = addCounts(a.tr, b.tr, o.maxTrN, o.maxTrKeys);
    out.ctl = addCounts(a.ctl, b.ctl, o.maxCtlN, o.maxCtlKeys);
    out.en = a.en || b.en || null;
    for (const e of b.errs || []) {
      const x = out.errs.find((y) => y.loc === e.loc && y.msg === e.msg);
      if (x) x.c = Math.min(o.maxActs, x.c + e.c); else if (out.errs.length < o.maxErrs) out.errs.push(Object.assign({}, e));
    }
    if (a.build && b.build && a.build !== b.build) { out.perf = b.perf; out.errs = (b.errs || []).slice(); out.load = !!b.load; }   // never mix builds
    return out;
  }
  // Accept `p` for session `s` at `now`: clamp to the session's wall time and the member's budget.
  function accept(s, p, now) {
    const tabs = Object.assign({}, p.tabs || {});
    let tot = 0; for (const v of Object.values(tabs)) tot += v;
    const sidCap = Math.min(o.maxFlushMs, s.last ? Math.max(0, now - s.last) : o.maxFlushMs);
    let b = budget.get(s.uid);
    if (!b) { b = { avail: o.maxFlushMs, ts: now }; budget.set(s.uid, b); }
    b.avail = Math.min(o.uidRate * o.maxFlushMs, b.avail + o.uidRate * Math.max(0, now - b.ts)); b.ts = now;
    const cap = Math.min(sidCap, b.avail);
    if (tot > cap) { const f = cap / tot; tot = 0; for (const k of Object.keys(tabs)) { tabs[k] = Math.floor(tabs[k] * f); tot += tabs[k]; } }
    b.avail = Math.max(0, b.avail - tot);
    // (-111) the hour buckets: this accept's window only, then no more than the accepted time
    const hrs = {};
    let hs = 0;
    const lo = now - sidCap - o.hrSlackMs, hi = now + o.hrSlackMs;
    for (const [k, v] of Object.entries(p.hrs || {}).slice(0, o.maxHrs)) {
      const h = Number(k);
      if (!Number.isInteger(h) || !(v > 0) || (h + 1) * 3600e3 <= lo || h * 3600e3 > hi) continue;
      hrs[h] = v; hs += v;
    }
    if (hs > tot) { for (const k of Object.keys(hrs)) hrs[k] = Math.floor(hrs[k] * tot / hs); }
    const load = !!p.load && !s.loaded;
    if (load) s.loaded = true;
    // (-112) transitions: no more than the accepted wall time can hold (one per trDwellMs of dwell)
    const tr = Object.create(null);
    let trLeft = Math.floor(sidCap / o.trDwellMs) + 1;
    for (const [k, v] of Object.entries(p.tr || {})) { if (trLeft <= 0) break; const c = Math.min(v, trLeft); tr[k] = c; trLeft -= c; }
    const en = p.en && !s.entered ? p.en : null;
    if (en) s.entered = true;
    const out = Object.assign({}, p, { tabs, hrs, load, tr, en });
    if (!empty(out)) s.last = now;
    return out;
  }
  function drop(k) {
    const s = sess.get(k); if (!s) return;
    if (s.held) heldN--;
    sess.delete(k);
    const set = byUid.get(s.uid); if (set) { set.delete(k); if (!set.size) byUid.delete(s.uid); }
  }
  // One beacon. Returns {accept: payload} (the caller records it), {held: true} or {busy: true}.
  // `release(uid, payload)` receives a held payload that an evicted session was still carrying.
  function offer(uid, sid, p, now, release) {
    const k = uid + "\u0001" + (sid || "");
    let s = sess.get(k);
    if (!s) {
      const set = byUid.get(uid) || new Set();
      while (set.size >= o.maxSids) {
        let old = null;
        for (const x of set) { const y = sess.get(x); if (!old || y.last < sess.get(old).last) old = x; }
        const y = sess.get(old);
        if (y.held && release) { const h = y.held; y.held = null; heldN--; release(uid, accept(y, h, now)); }
        drop(old);
      }
      s = { uid, sid: sid || "", last: 0, held: null, loaded: false, entered: false };
      sess.set(k, s); set.add(k); byUid.set(uid, set);
    }
    if (s.last && now - s.last < o.minGapMs) {
      if (!s.held && heldN >= o.maxHeld) return { busy: true };
      if (!s.held) heldN++;
      s.held = merge(s.held, p);
      return { held: true };
    }
    const m = merge(s.held, p);
    if (s.held) { s.held = null; heldN--; }
    return { accept: accept(s, m, now) };
  }
  // The regular flush: release every held payload whose session is past its gap (a page that closed
  // right after a beacon), and forget sessions and budgets idle for `idleMs`. `all` (shutdown)
  // releases every held payload regardless of its gap.
  function sweep(now, release, all) {
    for (const [k, s] of [...sess]) {
      if (s.held && (all || now - s.last >= o.minGapMs)) { const h = s.held; s.held = null; heldN--; release(s.uid, accept(s, h, now)); }
      if (!s.held && now - s.last > o.idleMs) drop(k);
    }
    for (const [uid, b] of [...budget]) if (!byUid.has(uid) && now - b.ts > o.idleMs) budget.delete(uid);
  }
  // Pausing: held payloads are discarded. The member's budget stays (a pause/resume cycle must not
  // mint a fresh allowance).
  function forget(uid) {
    for (const k of [...(byUid.get(uid) || [])]) drop(k);
  }
  return { offer, sweep, forget, held: () => heldN, sessions: () => sess.size, _opts: o };
}

module.exports = { createUsageGate, USAGE_GATE_DEFAULTS: DEF };
