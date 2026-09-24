"use strict";
// usage-digest.js — the weekly operator usage digest and the opt-in lapsed-member nudge
// (build 2026.09.24-113, roadmap item 3). Pure functions only: the week arithmetic (ET), the
// schedule, the digest text (Telegram HTML, or plain for the admin fold's preview), the nudge
// eligibility rules and the nudge text. The data comes from accounts.js (usageDigestData,
// usageNudgeInputs); delivery and the persisted dedupe live in server.js (usageDigestTick).
//
// Days are ET calendar days as 'YYYY-MM-DD' strings, UTC-anchored for arithmetic (the same
// convention as accounts.js usageDayShift), so a DST change can never produce a half day. The
// weekday numbering is etParts' (0 = Sunday .. 6 = Saturday), the one the heatmap keys use.
const { etDayStr, briefVisibleLen } = require("./compute");

const DAY_MS = 864e5;
const DIGEST_DAY_NAMES = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const DIGEST_TG_LIMIT = 3900;   // Telegram hard-fails over 4096 visible chars; a margin for the part marker-free single send
const NUDGE_DEFAULT_TEXT = "Haven’t seen you in a week — here’s what moved:";
const NUDGE_TEXT_MAX = 300;
// The rules (ET days): a member whose LAST active day (≥ a minute on screen) is 8..14 days before
// today — active in the prior 14 days, then 7 full days with none — is a candidate. At most one
// nudge per NUDGE_EVERY_DAYS, never to a paused, disabled or operator account, never to someone
// the server saw inside the last 7 days, and only over a channel they already have.
const NUDGE_QUIET_DAYS = 7, NUDGE_RECENT_DAYS = 14, NUDGE_EVERY_DAYS = 30;

const dayNum = (d) => Date.UTC(+d.slice(0, 4), +d.slice(5, 7) - 1, +d.slice(8, 10)) / DAY_MS;
const dayShift = (d, n) => new Date((dayNum(d) + n) * DAY_MS).toISOString().slice(0, 10);
const dayWd = (d) => new Date(dayNum(d) * DAY_MS).getUTCDay();   // 0 = Sunday
const mondayOf = (d) => dayShift(d, -((dayWd(d) + 6) % 7));
// ISO-8601 week of an ET day: the week (Monday..Sunday) belongs to the year its Thursday is in.
function digestWeekKey(d) {
  const thu = dayShift(mondayOf(d), 3), y = +thu.slice(0, 4);
  const wk = Math.floor((dayNum(thu) - dayNum(y + "-01-01")) / 7) + 1;
  return y + "-W" + String(wk).padStart(2, "0");
}
// When this ISO week's digest is due: on the configured ET weekday, once the morning brief's
// default send moment for that date (briefHour:00 UTC) has passed — alongside/after the brief. A
// missed day (the server was down) catches up later in the same week, never in the next one: the
// dedupe is per ISO week. `day` is the scheduled ET day; the digest always covers the 7 complete
// ET days before it against the 7 before those, whenever it actually goes out.
function digestSchedule(now, cfgDay, briefHour) {
  const today = etDayStr(now), mon = mondayOf(today);
  const wd = Number.isInteger(cfgDay) && cfgDay >= 0 && cfgDay <= 6 ? cfgDay : 1;
  const day = dayShift(mon, (wd + 6) % 7);
  const h = Number.isFinite(briefHour) ? Math.min(23, Math.max(0, Math.trunc(briefHour))) : 10;
  const at = dayNum(day) * DAY_MS + h * 3600e3;
  const due = today > day || (today === day && now >= at);
  return { today, day, week: digestWeekKey(day), at, due };
}
// The windows a digest for scheduled day D covers: this week = D-7..D-1, last week = D-14..D-8.
function digestWindows(D) {
  return { a: { from: dayShift(D, -7), to: dayShift(D, -1) }, b: { from: dayShift(D, -14), to: dayShift(D, -8) } };
}

// ---- the digest text ----------------------------------------------------------------------------
const tgEsc = (s) => String(s == null ? "" : s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const clip = (s, n) => { const a = Array.from(String(s == null ? "" : s).replace(/[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2066-\u2069]/g, " ").replace(/\s+/g, " ").trim()); return a.length > n ? a.slice(0, n - 1).join("") + "…" : a.join(""); };
const pct = (x) => (x == null || !Number.isFinite(x) ? "—" : (x >= 0 ? "+" : "−") + Math.round(Math.abs(x) * 100) + "%");
const hrs = (ms) => { const h = (+ms || 0) / 3600e3; return h < 1 ? Math.round((+ms || 0) / 60000) + "m" : (h < 10 ? h.toFixed(1) : String(Math.round(h))) + "h"; };
const fmtDay = (d) => { try { return new Date(d + "T12:00:00Z").toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" }); } catch (_) { return d; } };
const range = (w) => fmtDay(w.from) + "–" + (w.from.slice(0, 7) === w.to.slice(0, 7) ? String(+w.to.slice(8, 10)) : fmtDay(w.to));
const shortBuild = (b) => { const m = /-(\d+)$/.exec(String(b || "")); return m ? "-" + m[1] : String(b || "?"); };
function verdictWord(v) {
  if (!v) return null;
  const b = "build " + shortBuild(v.build);
  if (v.state === "regression") return b + ": REGRESSION — " + (v.conds || []).map((c) => c.kind === "new-errors" ? (c.n || 0) + " new error" + (c.n === 1 ? "" : "s")
    : c.kind === "err-rate" ? "errors/load " + (+c.x || 0).toFixed(1) + "×" : c.kind === "perf" ? "p75 paint +" + Math.round(((+c.p75 || 0) / (+c.p75Prev || 1) - 1) * 100) + "%" : String(c.kind)).join(", ");
  if (v.state === "ok") return b + ": OK" + (v.prev ? " vs " + shortBuild(v.prev) : "");
  if (v.state === "no-baseline") return b + ": OK (no earlier build to compare)";
  if (v.state === "collecting") return b + ": collecting (" + (+v.loads || 0) + " page loads so far)";
  return b + ": not checked";
}
// data: accounts.js usageDigestData. o: { html (default true), names, errLines, quietN }.
function digestLines(data, o) {
  const d = data || {}, html = o.html !== false;
  const E = html ? tgEsc : (s) => String(s == null ? "" : s);
  const B = (s) => (html ? "<b>" + s + "</b>" : s), I = (s) => (html ? "<i>" + s + "</i>" : s);
  const M = d.members || {}, L = [];
  const who = (list) => {
    const a = list || [], n = o.names;
    if (!a.length) return "";
    if (n <= 0) return "";
    const shown = a.slice(0, n).map((x) => E(clip(x.display || x.handle, 24)));
    return ": " + shown.join(", ") + (a.length > n ? " +" + (a.length - n) + " more" : "");
  };
  L.push("📊 " + B("WEEKLY USAGE"));
  if (d.a && d.b) L.push(I(E(range(d.a) + " vs " + range(d.b) + " (ET)")));
  L.push("");
  L.push("👥 " + B("MEMBERS"));
  const act = +M.active || 0, prev = +M.activePrev || 0, dAct = act - prev;
  L.push("active " + act + " (last week " + prev + ", " + (dAct >= 0 ? "+" : "−") + Math.abs(dAct) + ") · stickiness " + (M.stickiness == null ? "—" : Math.round(M.stickiness * 100) + "%"));
  const lap = d.lapsed || [], ret = d.returning || [];
  L.push("newly lapsed " + lap.length + who(lap));
  L.push("returning " + ret.length + who(ret));
  const extra = [];
  if (M.newJoined) extra.push(M.newJoined + " joined (" + (+M.newActive || 0) + " active)");
  if (M.paused) extra.push(M.paused + " paused");
  if (extra.length) L.push(extra.join(" · "));
  const T = d.tabs || {};
  const top = T.top || [];
  if (top.length || T.mover || (T.quiet || []).length) {
    L.push("");
    L.push("🗂 " + B("TABS"));
    top.forEach((t, i) => L.push((i + 1) + ". " + E(clip(t.label, 24)) + " " + hrs(t.ms) + " (" + (t.prevMs > 0 ? pct((t.ms - t.prevMs) / t.prevMs) : "new") + ")"));
    if (T.mover) {
      const m = T.mover, dm = m.ms - m.prevMs;
      L.push("biggest mover: " + E(clip(m.label, 24)) + " " + (dm >= 0 ? "+" : "−") + hrs(Math.abs(dm)) + " (" + (m.prevMs > 0 ? pct(dm / m.prevMs) : "new") + ")");
    }
    const q = T.quiet || [];
    if (q.length && o.quietN > 0) L.push(E("quiet (<10% reach): ") + q.slice(0, o.quietN).map((t) => E(clip(t.label, 20))).join(", ") + (q.length > o.quietN ? " +" + (q.length - o.quietN) + " more" : ""));
    else if (q.length) L.push(E("quiet (<10% reach): " + q.length + " tabs"));
  }
  const R = d.errors || {}, ne = R.fresh || [], rg = R.regressed || [];
  L.push("");
  L.push("🐞 " + B("ERRORS"));
  L.push(ne.length + " new · " + rg.length + " regressed" + (R.open != null ? " · " + R.open + " open in triage" : ""));
  const eLine = (tag, e) => tag + ": " + E(clip(e.loc, 40)) + (e.msg ? " · " + E(clip(e.msg, 70)) : "") + " (" + (+e.members || 0) + " member" + (e.members === 1 ? "" : "s") + ")";
  for (const e of rg.slice(0, o.errLines)) L.push(eLine("regressed", e));
  for (const e of ne.slice(0, o.errLines)) L.push(eLine("new", e));
  const vw = verdictWord(d.verdict);
  if (vw) { L.push(""); L.push("🚦 " + B("LAST BUILD") + " " + E(vw)); }
  return L;
}
// The ladder: names 10 → 5 → 2 → counts only, error lines 2 → 1 → 0, quiet tabs 6 → 3 → a count.
// Whatever still does not fit loses whole lines from the end (tags are balanced per line, so a cut
// can never leave half an element) and says so.
const DIGEST_LADDER = [{ names: 10, errLines: 2, quietN: 6 }, { names: 5, errLines: 1, quietN: 3 }, { names: 2, errLines: 0, quietN: 0 }, { names: 0, errLines: 0, quietN: 0 }];
function digestText(data, opts) {
  const o = opts || {}, html = o.html !== false, limit = o.limit || DIGEST_TG_LIMIT;
  const vis = (s) => (html ? briefVisibleLen(s) : s.length);
  let lines = null;
  for (const step of DIGEST_LADDER) {
    lines = digestLines(data, Object.assign({ html }, step));
    const text = lines.join("\n");
    if (vis(text) <= limit) return text;
  }
  const tail = html ? "<i>… (cut to fit)</i>" : "… (cut to fit)";
  while (lines.length > 1 && vis(lines.join("\n") + "\n" + tail) > limit) lines.pop();
  const text = lines.join("\n") + "\n" + tail;
  if (vis(text) > limit) return Array.from(text.replace(/<[^>]*>/g, "")).slice(0, limit - 1).join("") + "…";   // a single monster line: plain, cut
  return text;
}

// ---- the lapsed-member nudge -------------------------------------------------------------------
// m: { disabled, paused, admin, lastActive ('YYYY-MM-DD' | null), lastSeen (ms), lastNudgeAt (ms | null),
//      hasTg, hasPush }. Returns { ok, via } or { ok: false, why }.
function nudgeCheck(m, now) {
  const t = now != null ? now : Date.now(), today = etDayStr(t);
  if (!m) return { ok: false, why: "unknown" };
  if (m.disabled) return { ok: false, why: "disabled" };
  if (m.paused) return { ok: false, why: "paused" };
  if (m.admin) return { ok: false, why: "operator" };
  if (!m.lastActive) return { ok: false, why: "not-active-recently" };
  const gap = dayNum(today) - dayNum(m.lastActive);
  if (gap > NUDGE_RECENT_DAYS) return { ok: false, why: "not-active-recently" };
  if (gap <= NUDGE_QUIET_DAYS) return { ok: false, why: "active-this-week" };
  if (m.lastSeen && t - m.lastSeen < NUDGE_QUIET_DAYS * DAY_MS) return { ok: false, why: "seen-this-week" };
  if (m.lastNudgeAt && t - m.lastNudgeAt < NUDGE_EVERY_DAYS * DAY_MS) return { ok: false, why: "nudged-recently" };
  if (m.hasTg) return { ok: true, via: "telegram" };
  if (m.hasPush) return { ok: true, via: "push" };
  return { ok: false, why: "no-channel" };
}
// The admin's lead line: one line of plain text, control characters and runs of space collapsed,
// at most NUDGE_TEXT_MAX characters; blank means the default.
function nudgeTextClean(s) {
  const t = clip(s, NUDGE_TEXT_MAX + 1);
  if (!t) return NUDGE_DEFAULT_TEXT;
  return Array.from(t).length > NUDGE_TEXT_MAX ? null : t;
}
// Two or three market lines from the brief's own context (buildBriefCtx) — the benchmarks' day
// and the day's biggest stock mover each way. Market data only: nothing about the member.
function nudgeLines(ctx) {
  const c = ctx || {}, out = [];
  const p = (v) => (v == null || !Number.isFinite(+v) ? null : (+v >= 0 ? "+" : "−") + Math.abs(+v).toFixed(1) + "%");
  const b = c.bench || {}, bl = [];
  for (const x of [b.stocks, b.crypto]) if (x && x.t && p(x.d1)) bl.push(clip(x.t, 10) + " " + p(x.d1));
  if (bl.length) out.push(bl.join(" · ") + " (24h)");
  const mv = (c.movers || {}).stocks || {};
  const up = (mv.up || [])[0], dn = (mv.down || [])[0];
  if (up && up.t && p(up.d1)) out.push("top gainer: " + clip(up.t, 10) + " " + p(up.d1));
  if (dn && dn.t && p(dn.d1)) out.push("top loser: " + clip(dn.t, 10) + " " + p(dn.d1));
  return out.slice(0, 3);
}
const NUDGE_FOOT = "One reminder at most; pause usage under Messages → Your usage and you won’t get one.";
function nudgeMessage(lead, lines, html) {
  const L = lines || [];
  if (html === false) return { title: "Milst Screener", body: [lead].concat(L.length ? [L.join(" · ")] : []).join(" ") };
  return [tgEsc(lead)].concat(L.map(tgEsc)).concat(["<i>" + tgEsc(NUDGE_FOOT) + "</i>"]).join("\n");
}

module.exports = { digestWeekKey, digestSchedule, digestWindows, digestText, digestLines, DIGEST_LADDER, DIGEST_TG_LIMIT, DIGEST_DAY_NAMES,
  nudgeCheck, nudgeTextClean, nudgeLines, nudgeMessage, NUDGE_DEFAULT_TEXT, NUDGE_TEXT_MAX, NUDGE_FOOT,
  NUDGE_QUIET_DAYS, NUDGE_RECENT_DAYS, NUDGE_EVERY_DAYS, dayShift: dayShift, mondayOf };
