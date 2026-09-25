"use strict";
// usage-public.js — cookieless counting of signed-out visitors (build 2026.09.25-117).
//
// Plausible-style: a signed-out page sends the same usage beacon a member's page sends, and carries
// NO identifier of any kind — no cookie, no localStorage, no id. The server derives a visitor key
//
//     key = HMAC-SHA256(dailySalt, ip + '|' + userAgent + '|' + host), truncated
//
// where dailySalt is 32 random bytes minted for the current ET day and held ONLY in this closure: it
// is never returned, logged, written to SQLite or to any file. At ET midnight (lazily, on the first
// request or sweep after it) the salt is replaced and every per-visitor map below is dropped with it,
// so the same browser gets an unrelated key tomorrow and nobody — the operator included — can link
// two days of one visitor. The key itself is never stored either: it lives only in this module's
// in-memory maps (distinct counting, per-visitor caps) and the server's in-memory rate gate, both
// discarded at rotation. The IP and the User-Agent are inputs to the HMAC and nothing else.
//
// A restart mid-day mints a new salt: a visitor who returns later that day is counted again (the
// day's distinct-visitor count can only over-count across a restart, by the returning visitors).
//
// What this module decides, per request and per accepted payload:
//   admit   server-wide caps first — at most maxPerMin public beacons per wall-clock minute, at most
//           maxVisitors distinct visitors per ET day; beyond either the caller answers 204 and the
//           server counts a drop (usage_day kind 'pdrop'); otherwise the visitor's key.
//   note    what an ACCEPTED payload (after the rate gate) adds to today's distinct counts: whether
//           this is the visitor's first stored payload today ('pv'), which tabs this visitor reached
//           for the first time today ('ptr' — reach), and how the visitor's day total moved between
//           the minutes buckets ('pmin' — a histogram, so a median exists without per-visitor rows).
//           Plus the visitor's daily sitewide budget (the same bounds a member has, keyed here).
// accounts.js turns those into uid '-1' aggregate rows; it never sees the key.
const crypto = require("crypto");
const { etDayStr } = require("./compute");

const PUBLIC_DEFAULTS = Object.freeze({ maxVisitors: 20000, maxPerMin: 600, keyLen: 22 });
// Visitor-day minutes buckets (ms lower bounds): the 'pmin' histogram. 0 = under a minute.
const PUB_MIN_BUCKETS = Object.freeze([0, 60e3, 120e3, 300e3, 600e3, 1200e3, 1800e3, 3600e3, 7200e3]);
function pubMinBucket(ms) { let b = 0; for (const x of PUB_MIN_BUCKETS) if (ms >= x) b = x; return b; }

function createUsagePublic(opts) {
  const o = Object.assign({}, PUBLIC_DEFAULTS, opts || {});
  let day = null, salt = null;
  let vis = new Map();          // key -> {counted, ms, bucket, tabs: Set, q: {day, n, en}} — today only
  let minute = -1, perMin = 0;  // the server-wide per-minute beacon count
  // A new ET day: a fresh salt, and everything keyed by yesterday's salt goes with the old one.
  function rotate(now) {
    const d = etDayStr(now);
    if (d === day) return false;
    day = d; salt = crypto.randomBytes(32); vis = new Map();
    return true;
  }
  const stale = (now) => day != null && etDayStr(now) !== day;
  function keyOf(ip, ua, host, now) {
    rotate(now);
    return crypto.createHmac("sha256", salt).update(String(ip || "") + "|" + String(ua || "") + "|" + String(host || ""))
      .digest("base64url").slice(0, o.keyLen);
  }
  // One public beacon request. {key} or {drop: 'rate' | 'visitors'}.
  function admit(ip, ua, host, now) {
    const m = Math.floor(now / 60000);
    if (m !== minute) { minute = m; perMin = 0; }
    if (perMin >= o.maxPerMin) return { drop: "rate" };
    perMin++;
    const key = keyOf(ip, ua, host, now);
    if (!vis.has(key)) {
      if (vis.size >= o.maxVisitors) return { drop: "visitors" };
      vis.set(key, { counted: false, ms: 0, bucket: null, tabs: new Set(), q: { day, n: 0, en: 0 } });
    }
    return { key };
  }
  // One payload the gate accepted for visitor `key`: what it adds to today's distinct counts.
  function note(key, p) {
    let s = vis.get(key);
    if (!s) { s = { counted: false, ms: 0, bucket: null, tabs: new Set(), q: { day, n: 0, en: 0 } }; if (vis.size < o.maxVisitors) vis.set(key, s); }
    let tot = 0;
    const newTabs = [];
    for (const [k, ms] of Object.entries((p && p.tabs) || {})) {
      if (!(ms > 0)) continue;
      tot += ms;
      if (!s.tabs.has(k)) { s.tabs.add(k); newTabs.push(k); }
    }
    const newVisitor = !s.counted;
    s.counted = true;
    const minFrom = s.bucket;
    s.ms += tot;
    s.bucket = pubMinBucket(s.ms);
    // (build 2026.09.25-118) `day`: the ET day this visitor state belongs to — accounts.js files the
    // distinct counts under it, so a payload recorded across midnight can never split a visitor's
    // −1 / +1 minutes-bucket move over two days
    return { newVisitor, newTabs, minFrom, minTo: s.bucket, q: s.q, day };
  }
  return { admit, note, rotate, stale, keyOf, day: () => day, visitors: () => vis.size, counted: () => { let n = 0; for (const s of vis.values()) if (s.counted) n++; return n; },
    perMin: () => perMin, _opts: o };
}

module.exports = { createUsagePublic, PUBLIC_DEFAULTS, PUB_MIN_BUCKETS, pubMinBucket };
