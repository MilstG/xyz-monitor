"use strict";
// ===== accounts, invites and direct messages ====================================================
// Everything that needs a "who" lives here, in ONE SQLite file on the volume, deliberately outside
// poller.js: none of it is market data, none of it is on the 15s path, and all of it wants
// transactions rather than the whole-file tmp+rename discipline the JSON caches use.
//
// Why SQLite and not another notes.json: notes.json works because it is tens of rows rewritten
// rarely, and every write rewrites the WHOLE book. A message log is append-only and unbounded, so
// that pattern is O(history) per message. It also cannot express the one guarantee an invite needs
// — burn-exactly-once under concurrent redemption — which is a transaction, not a check.
//
// The uid trick that makes migration free: a signed `xyzown` handle already keys every alert
// recipient and every alert rule. So when a browser holding one claims an account, that handle
// BECOMES the uid rather than being replaced by a fresh id. Nothing is rewritten, nothing is
// adopted, and an existing member keeps their Telegram links and rules by construction. A fresh
// visitor with no handle just gets a random uid of the same shape.
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

// ---- code alphabet -----------------------------------------------------------------------------
// Crockford base32: no I, L, O or U, so a code survives being read down a phone line and typed back.
// 12 chars = 60 bits. Brute force is not the threat model here (an invite is short-lived, single-use
// and low-privilege); the alphabet is chosen for transcription, not entropy.
const CODE_ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const CODE_PREFIX = "MILST";

function mintCode() {
  const buf = crypto.randomBytes(12);
  let s = "";
  for (let i = 0; i < 12; i++) s += CODE_ALPHABET[buf[i] % 32];
  return CODE_PREFIX + "-" + s.slice(0, 4) + "-" + s.slice(4, 8) + "-" + s.slice(8, 12);
}
// Accepts what a human retypes: lowercase, missing dashes, O/I typed for 0/1, stray spaces.
function normCode(raw) {
  let s = String(raw == null ? "" : raw).toUpperCase().replace(/[^0-9A-Z]/g, "");
  if (s.startsWith(CODE_PREFIX)) s = s.slice(CODE_PREFIX.length);
  s = s.replace(/O/g, "0").replace(/[IL]/g, "1").replace(/U/g, "V");
  if (s.length !== 12) return "";
  for (const ch of s) if (CODE_ALPHABET.indexOf(ch) < 0) return "";
  return CODE_PREFIX + "-" + s.slice(0, 4) + "-" + s.slice(4, 8) + "-" + s.slice(8, 12);
}

// ---- handles -----------------------------------------------------------------------------------
// Lowercase is the identity; the display form keeps whatever case was typed. Reserved names are
// refused because a member called "admin" in the DM directory is a phishing surface, not a joke.
const HANDLE_RESERVED = new Set(["admin", "administrator", "operator", "system", "milst", "screener",
  "root", "support", "help", "bot", "server", "everyone", "all", "me", "you"]);
const HANDLE_RE = /^[a-z0-9][a-z0-9._-]{1,23}$/;
function handleError(raw) {
  const h = String(raw == null ? "" : raw).trim();
  if (!h) return "pick a handle";
  const lc = h.toLowerCase();
  if (lc.length < 2) return "handle is too short (2 characters minimum)";
  if (lc.length > 24) return "handle is too long (24 characters maximum)";
  if (!HANDLE_RE.test(lc)) return "handles use letters, numbers, dot, dash and underscore, starting with a letter or number";
  if (HANDLE_RESERVED.has(lc)) return "that handle is reserved — pick another";
  return "";
}

// ---- passwords ---------------------------------------------------------------------------------
// scrypt, per-password salt, stored as scrypt$N$salt$hash. No dependency, and the cost parameter
// travels with the hash so it can be raised later without stranding existing rows.
const SCRYPT_N = 16384, SCRYPT_KEYLEN = 64;
const PW_MIN = 12;
function hashPw(pw) {
  const salt = crypto.randomBytes(16).toString("base64url");
  const h = crypto.scryptSync(String(pw), salt, SCRYPT_KEYLEN, { N: SCRYPT_N, r: 8, p: 1 }).toString("base64url");
  return "scrypt$" + SCRYPT_N + "$" + salt + "$" + h;
}
function verifyPw(pw, stored) {
  try {
    const p = String(stored || "").split("$");
    if (p.length !== 4 || p[0] !== "scrypt") return false;
    const N = Number(p[1]);
    if (!Number.isFinite(N) || N < 1024) return false;
    const want = Buffer.from(p[3], "base64url");
    const got = crypto.scryptSync(String(pw), p[2], want.length, { N, r: 8, p: 1 });
    return want.length === got.length && crypto.timingSafeEqual(want, got);
  } catch (_) { return false; }
}
function pwError(pw) {
  const s = String(pw == null ? "" : pw);
  if (s.length < PW_MIN) return `password needs ${PW_MIN} characters or more`;
  if (s.length > 200) return "password is too long (200 characters maximum)";
  if (/^\s+$/.test(s)) return "password cannot be only whitespace";
  return "";
}

// ---- message bodies ----------------------------------------------------------------------------
const DM_MAX_LEN = 4000;
const DM_BURST_N = 20, DM_BURST_MS = 10000;   // 20 messages / 10s per sender
function cleanBody(raw) {
  // Control characters out, CRLF normalised, runs of blank lines collapsed. Deliberately NOT
  // HTML-escaped here: escaping belongs at render, and storing pre-escaped text means every other
  // consumer (the Telegram digest, a future export) has to un-escape it first.
  // Control characters are filtered by code point rather than by a regex class: the class is
  // easy to get subtly wrong, and a stray literal control byte in the source is invisible in
  // review. Newline survives because a message is allowed to have paragraphs.
  let s = String(raw == null ? "" : raw).replace(/\r\n?/g, "\n");
  let out = "";
  for (const ch of s) {
    const c = ch.codePointAt(0);
    if (ch !== "\n" && (c < 32 || c === 127)) continue;
    out += ch;
  }
  return out.replace(/\n{4,}/g, "\n\n\n").trim().slice(0, DM_MAX_LEN);
}
// $TICKER in the body marks a reference. First one wins — a message is one claim, and a card per
// symbol would turn a sentence into a table.
function firstTickerRef(body) {
  const m = /(?:^|[\s(])\$([A-Za-z][A-Za-z0-9:._-]{0,15})/.exec(String(body || ""));
  return m ? m[1].toUpperCase() : "";
}

function openAccounts(dataDir, opts) {
  const options = opts || {};
  fs.mkdirSync(dataDir, { recursive: true });
  const file = path.join(dataDir, "accounts.db");
  const { DatabaseSync } = require("node:sqlite");
  const db = new DatabaseSync(file);
  db.exec("PRAGMA journal_mode = WAL;");
  db.exec("PRAGMA foreign_keys = ON;");
  db.exec(`
CREATE TABLE IF NOT EXISTS user (
  uid TEXT PRIMARY KEY,
  handle TEXT NOT NULL,            -- lowercase, unique: the identity
  display TEXT NOT NULL,           -- as typed, for rendering
  pw TEXT NOT NULL,
  epoch INTEGER NOT NULL DEFAULT 1,-- bump to kill every outstanding session for this user
  isAdmin INTEGER NOT NULL DEFAULT 0,
  createdAt INTEGER NOT NULL,
  invitedBy TEXT,
  lastSeen INTEGER NOT NULL DEFAULT 0,
  disabledAt INTEGER
) STRICT;
CREATE UNIQUE INDEX IF NOT EXISTS user_handle ON user(handle);

CREATE TABLE IF NOT EXISTS invite (
  code TEXT PRIMARY KEY,
  kind TEXT NOT NULL,              -- 'join' | 'reset'
  label TEXT,                      -- operator's own note; never shown to the invitee
  targetUid TEXT,                  -- kind='reset' only
  createdBy TEXT NOT NULL,
  createdAt INTEGER NOT NULL,
  expiresAt INTEGER NOT NULL,
  usedBy TEXT,
  usedAt INTEGER,
  revokedAt INTEGER
) STRICT;
CREATE INDEX IF NOT EXISTS invite_created ON invite(createdAt);

CREATE TABLE IF NOT EXISTS dm_thread (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  a TEXT NOT NULL,                 -- canonical ordering: a < b, so a pair has exactly one thread
  b TEXT NOT NULL,
  createdAt INTEGER NOT NULL,
  lastMsgId INTEGER NOT NULL DEFAULT 0,
  lastAt INTEGER NOT NULL DEFAULT 0
) STRICT;
CREATE UNIQUE INDEX IF NOT EXISTS dm_pair ON dm_thread(a, b);

CREATE TABLE IF NOT EXISTS dm_msg (
  id INTEGER PRIMARY KEY AUTOINCREMENT,   -- global monotonic: this IS the sync cursor
  thread INTEGER NOT NULL,
  sender TEXT NOT NULL,
  ts INTEGER NOT NULL,
  body TEXT NOT NULL,
  ref TEXT,                        -- $TICKER coin id, when the message carried one
  refPx REAL,                      -- the mark at send. Written once, never revised.
  editedAt INTEGER,
  deletedAt INTEGER
) STRICT;
CREATE INDEX IF NOT EXISTS dm_by_thread ON dm_msg(thread, id);

CREATE TABLE IF NOT EXISTS dm_read (
  thread INTEGER NOT NULL,
  uid TEXT NOT NULL,
  readMsgId INTEGER NOT NULL DEFAULT 0,
  muted INTEGER NOT NULL DEFAULT 0,
  notifiedMsgId INTEGER NOT NULL DEFAULT 0,   -- highest id already escalated to Telegram
  PRIMARY KEY (thread, uid)
) STRICT, WITHOUT ROWID;
`);

  // ---- statements ------------------------------------------------------------------------------
  const S = {
    userByUid: db.prepare("SELECT * FROM user WHERE uid = ?"),
    userByHandle: db.prepare("SELECT * FROM user WHERE handle = ?"),
    userAll: db.prepare("SELECT * FROM user ORDER BY createdAt"),
    userCount: db.prepare("SELECT COUNT(*) AS n FROM user"),
    userIns: db.prepare("INSERT INTO user (uid, handle, display, pw, epoch, isAdmin, createdAt, invitedBy, lastSeen) VALUES (?,?,?,?,1,?,?,?,?)"),
    userPw: db.prepare("UPDATE user SET pw = ?, epoch = epoch + 1 WHERE uid = ?"),
    userBump: db.prepare("UPDATE user SET epoch = epoch + 1 WHERE uid = ?"),
    userDisable: db.prepare("UPDATE user SET disabledAt = ?, epoch = epoch + 1 WHERE uid = ?"),
    userEnable: db.prepare("UPDATE user SET disabledAt = NULL WHERE uid = ?"),
    userAdmin: db.prepare("UPDATE user SET isAdmin = ? WHERE uid = ?"),
    userSeen: db.prepare("UPDATE user SET lastSeen = ? WHERE uid = ?"),

    invByCode: db.prepare("SELECT * FROM invite WHERE code = ?"),
    invIns: db.prepare("INSERT INTO invite (code, kind, label, targetUid, createdBy, createdAt, expiresAt) VALUES (?,?,?,?,?,?,?)"),
    invBurn: db.prepare("UPDATE invite SET usedBy = ?, usedAt = ? WHERE code = ? AND usedBy IS NULL AND revokedAt IS NULL"),
    invRevoke: db.prepare("UPDATE invite SET revokedAt = ? WHERE code = ? AND usedBy IS NULL"),
    invList: db.prepare("SELECT * FROM invite ORDER BY createdAt DESC LIMIT 200"),

    thrFind: db.prepare("SELECT * FROM dm_thread WHERE a = ? AND b = ?"),
    thrById: db.prepare("SELECT * FROM dm_thread WHERE id = ?"),
    thrIns: db.prepare("INSERT INTO dm_thread (a, b, createdAt) VALUES (?,?,?)"),
    thrMine: db.prepare("SELECT * FROM dm_thread WHERE a = ? OR b = ? ORDER BY lastAt DESC"),
    thrTouch: db.prepare("UPDATE dm_thread SET lastMsgId = ?, lastAt = ? WHERE id = ?"),

    msgIns: db.prepare("INSERT INTO dm_msg (thread, sender, ts, body, ref, refPx) VALUES (?,?,?,?,?,?)"),
    msgById: db.prepare("SELECT * FROM dm_msg WHERE id = ?"),
    msgEdit: db.prepare("UPDATE dm_msg SET body = ?, ref = ?, editedAt = ? WHERE id = ? AND sender = ? AND deletedAt IS NULL"),
    msgDrop: db.prepare("UPDATE dm_msg SET deletedAt = ?, body = '' WHERE id = ? AND sender = ?"),
    msgPage: db.prepare("SELECT * FROM dm_msg WHERE thread = ? AND id < ? ORDER BY id DESC LIMIT ?"),
    msgSince: db.prepare("SELECT * FROM dm_msg WHERE thread = ? AND id > ? ORDER BY id LIMIT ?"),
    msgLast: db.prepare("SELECT * FROM dm_msg WHERE thread = ? ORDER BY id DESC LIMIT 1"),
    msgUnread: db.prepare("SELECT COUNT(*) AS n FROM dm_msg WHERE thread = ? AND id > ? AND sender <> ? AND deletedAt IS NULL"),
    msgBurst: db.prepare("SELECT COUNT(*) AS n FROM dm_msg WHERE sender = ? AND ts > ?"),
    msgMaxId: db.prepare("SELECT COALESCE(MAX(id), 0) AS m FROM dm_msg"),

    readGet: db.prepare("SELECT * FROM dm_read WHERE thread = ? AND uid = ?"),
    readUp: db.prepare(`INSERT INTO dm_read (thread, uid, readMsgId) VALUES (?,?,?)
      ON CONFLICT(thread, uid) DO UPDATE SET readMsgId = MAX(readMsgId, excluded.readMsgId)`),
    readMute: db.prepare(`INSERT INTO dm_read (thread, uid, muted) VALUES (?,?,?)
      ON CONFLICT(thread, uid) DO UPDATE SET muted = excluded.muted`),
    readNotified: db.prepare(`INSERT INTO dm_read (thread, uid, notifiedMsgId) VALUES (?,?,?)
      ON CONFLICT(thread, uid) DO UPDATE SET notifiedMsgId = MAX(notifiedMsgId, excluded.notifiedMsgId)`),
  };

  // ---- in-memory user index --------------------------------------------------------------------
  // Session verification needs the epoch and the disabled flag on EVERY request, so the table is
  // held in memory and refreshed on write — the same shape pushRecipients already uses. This is the
  // one place the otherwise-stateless session token touches server state, and it is the price of
  // being able to revoke one person without rotating a secret on everyone.
  let users = new Map();
  function hydrate() {
    const m = new Map();
    for (const r of S.userAll.all()) m.set(r.uid, r);
    users = m;
    return users.size;
  }
  hydrate();

  const pub = (u) => u && ({ uid: u.uid, handle: u.handle, display: u.display, isAdmin: !!u.isAdmin,
    createdAt: u.createdAt, lastSeen: u.lastSeen, disabled: !!u.disabledAt });

  // ---- sessions --------------------------------------------------------------------------------
  // The signing secret is generated once and persisted BESIDE the database rather than derived from
  // any password. Deriving it from SITE_PASSWORD (as the shared-password build did) means rotating
  // one person's credential either invalidates everyone or nobody — both wrong once accounts exist.
  const secretFile = path.join(dataDir, "session-secret");
  let sessionSecret;
  try {
    sessionSecret = Buffer.from(fs.readFileSync(secretFile, "utf8").trim(), "base64");
    if (sessionSecret.length < 32) throw new Error("short");
  } catch (_) {
    sessionSecret = crypto.randomBytes(48);
    const tmp = secretFile + ".tmp";
    fs.writeFileSync(tmp, sessionSecret.toString("base64"), { mode: 0o600 });
    fs.renameSync(tmp, secretFile);
  }

  function signSession(uid, epoch, expMs) {
    const mac = crypto.createHmac("sha256", sessionSecret)
      .update("s2|" + uid + "|" + epoch + "|" + expMs).digest("base64url");
    return uid + "." + epoch + "." + expMs + "." + mac;
  }
  // Returns the live user row, or null. Four independent reasons to refuse, in cost order.
  function sessionUser(tok) {
    if (!tok || typeof tok !== "string" || tok.length > 300) return null;
    const p = tok.split(".");
    if (p.length !== 4) return null;
    const [uid, ep, exp] = p;
    const expMs = Number(exp);
    if (!Number.isFinite(expMs) || expMs < Date.now()) return null;
    let ok = false;
    try {
      const want = Buffer.from(signSession(uid, ep, exp));
      const got = Buffer.from(tok);
      ok = want.length === got.length && crypto.timingSafeEqual(want, got);
    } catch (_) { ok = false; }
    if (!ok) return null;
    const u = users.get(uid);
    if (!u || u.disabledAt || String(u.epoch) !== String(ep)) return null;
    return u;
  }
  function tokenFor(u, days) {
    return signSession(u.uid, u.epoch, Date.now() + Math.max(1, days) * 86400e3);
  }

  // ---- users -----------------------------------------------------------------------------------
  function countUsers() { return S.userCount.get().n; }
  function getUser(uid) { return users.get(uid) || null; }
  function getUserByHandle(h) {
    const lc = String(h || "").trim().toLowerCase();
    for (const u of users.values()) if (u.handle === lc) return u;
    return null;
  }
  function listUsers() { return [...users.values()].map(pub); }

  function login(handle, password) {
    const u = getUserByHandle(handle);
    // Hash a decoy anyway so a wrong handle and a wrong password cost the same wall time; without
    // it the response time alone enumerates which handles exist.
    if (!u) { verifyPw(String(password || ""), hashPw("decoy-" + Math.random())); return { ok: false, error: "wrong handle or password" }; }
    if (u.disabledAt) return { ok: false, error: "this account is disabled — ask the operator" };
    if (!verifyPw(password, u.pw)) return { ok: false, error: "wrong handle or password" };
    try { S.userSeen.run(Date.now(), u.uid); u.lastSeen = Date.now(); } catch (_) {}
    return { ok: true, user: pub(u), token: tokenFor(u, options.sessionDays || 30) };
  }

  function setPassword(uid, password) {
    const bad = pwError(password);
    if (bad) return { ok: false, error: bad };
    const u = users.get(uid);
    if (!u) return { ok: false, error: "no such account" };
    S.userPw.run(hashPw(password), uid);
    hydrate();
    const nu = users.get(uid);
    return { ok: true, user: pub(nu), token: tokenFor(nu, options.sessionDays || 30) };
  }

  function signOutEverywhere(uid) {
    if (!users.get(uid)) return { ok: false, error: "no such account" };
    S.userBump.run(uid); hydrate();
    return { ok: true };
  }
  function setDisabled(uid, off) {
    const u = users.get(uid);
    if (!u) return { ok: false, error: "no such account" };
    if (off) S.userDisable.run(Date.now(), uid); else S.userEnable.run(uid);
    hydrate();
    return { ok: true, user: pub(users.get(uid)) };
  }
  function setAdmin(uid, on) {
    const u = users.get(uid);
    if (!u) return { ok: false, error: "no such account" };
    S.userAdmin.run(on ? 1 : 0, uid); hydrate();
    return { ok: true, user: pub(users.get(uid)) };
  }
  function touch(uid) {
    const u = users.get(uid);
    if (!u) return;
    const now = Date.now();
    if (now - (u.lastSeen || 0) < 60000) return;   // one write a minute is plenty for "last seen"
    try { S.userSeen.run(now, uid); u.lastSeen = now; } catch (_) {}
  }

  // ---- invites ---------------------------------------------------------------------------------
  const INVITE_TTL_DAYS = [1, 7, 30];
  function mintInvite(createdBy, label, days, kind, targetUid) {
    const k = kind === "reset" ? "reset" : "join";
    const d = INVITE_TTL_DAYS.includes(+days) ? +days : 7;
    if (k === "reset" && !users.get(targetUid)) return { ok: false, error: "no such account" };
    const now = Date.now();
    // Collision is a 60-bit coincidence, but retrying costs nothing and a PRIMARY KEY violation
    // thrown at an operator mid-mint would be an absurd way to find that out.
    for (let i = 0; i < 5; i++) {
      const code = mintCode();
      if (S.invByCode.get(code)) continue;
      S.invIns.run(code, k, label ? String(label).slice(0, 64) : null, k === "reset" ? targetUid : null,
        createdBy, now, now + d * 86400e3);
      return { ok: true, invite: S.invByCode.get(code) };
    }
    return { ok: false, error: "could not mint a code — try again" };
  }

  // One place decides whether a code is usable, so /join's GET, its POST and the admin list can
  // never disagree about what "expired" means.
  function inviteState(inv, now) {
    if (!inv) return "unknown";
    if (inv.usedBy) return "used";
    if (inv.revokedAt) return "revoked";
    if (inv.expiresAt < (now || Date.now())) return "expired";
    return "open";
  }
  function readInvite(rawCode) {
    const code = normCode(rawCode);
    if (!code) return { ok: false, state: "unknown" };
    const inv = S.invByCode.get(code);
    const state = inviteState(inv, Date.now());
    if (state !== "open") return { ok: false, state, invite: inv || null };
    const by = inv.createdBy ? users.get(inv.createdBy) : null;
    return { ok: true, state, invite: inv, inviter: by ? by.display : "the operator",
      target: inv.kind === "reset" ? pub(users.get(inv.targetUid)) : null };
  }
  function revokeInvite(code) {
    const c = normCode(code);
    if (!c) return { ok: false, error: "no such invite" };
    const r = S.invRevoke.run(Date.now(), c);
    return r.changes === 1 ? { ok: true } : { ok: false, error: "that invite is already used or revoked" };
  }
  function listInvites() {
    const now = Date.now();
    return S.invList.all().map((i) => ({
      code: i.code, kind: i.kind, label: i.label, state: inviteState(i, now),
      createdAt: i.createdAt, expiresAt: i.expiresAt, usedAt: i.usedAt,
      createdBy: (users.get(i.createdBy) || {}).display || "—",
      usedBy: i.usedBy ? (users.get(i.usedBy) || {}).display || "—" : null,
      targetUid: i.targetUid || null,
      target: i.targetUid ? (users.get(i.targetUid) || {}).display || "—" : null,
    }));
  }

  // Redeem: the ONLY path that creates an account. Everything irreversible happens inside one
  // transaction, because two people opening the same link both read usedBy IS NULL and both proceed
  // — the guard has to live in the write, not the check.
  //
  // priorOwner is the caller's existing signed xyzown handle, if they have one. Using it as the uid
  // is what carries their alert recipients and rules across for free.
  function redeem(rawCode, handle, password, priorOwner) {
    const code = normCode(rawCode);
    if (!code) return { ok: false, error: "that invite code isn't valid" };
    const inv0 = S.invByCode.get(code);
    const st = inviteState(inv0, Date.now());
    if (st !== "open") return { ok: false, error: st === "used" ? "this invite has already been used"
      : st === "expired" ? "this invite has expired" : st === "revoked" ? "this invite was revoked"
      : "that invite code isn't valid", state: st };

    // A reset link sets a new password on an existing account and burns the same way a join does.
    if (inv0.kind === "reset") {
      const bad = pwError(password);
      if (bad) return { ok: false, error: bad };
      const target = users.get(inv0.targetUid);
      if (!target) return { ok: false, error: "that account no longer exists" };
      db.exec("BEGIN IMMEDIATE");
      try {
        if (S.invBurn.run(target.uid, Date.now(), code).changes !== 1)
          throw new Error("raced");
        S.userPw.run(hashPw(password), target.uid);
        db.exec("COMMIT");
      } catch (e) {
        try { db.exec("ROLLBACK"); } catch (_) {}
        return { ok: false, error: e.message === "raced" ? "this invite has already been used" : "could not complete the reset" };
      }
      hydrate();
      const nu = users.get(target.uid);
      return { ok: true, reset: true, user: pub(nu), token: tokenFor(nu, options.sessionDays || 30) };
    }

    const hBad = handleError(handle);
    if (hBad) return { ok: false, error: hBad, field: "handle" };
    const pBad = pwError(password);
    if (pBad) return { ok: false, error: pBad, field: "password" };
    const display = String(handle).trim().slice(0, 24);
    const lc = display.toLowerCase();
    if (getUserByHandle(lc)) return { ok: false, error: "that handle is taken — pick another", field: "handle" };

    // Reuse the caller's signed alert-owner handle as the uid when they have one and it is free.
    let uid = (priorOwner && typeof priorOwner === "string" && !users.get(priorOwner)) ? priorOwner : "";
    if (!uid) uid = crypto.randomBytes(12).toString("base64url");
    const now = Date.now();
    const first = countUsers() === 0;

    db.exec("BEGIN IMMEDIATE");
    try {
      // Re-read inside the write lock: the state check above raced anyone who got here first.
      const inv = S.invByCode.get(code);
      if (inviteState(inv, now) !== "open") throw new Error("raced");
      if (S.userByHandle.get(lc)) throw new Error("handle-taken");
      // The first account minted is the operator — otherwise a fresh deployment has invites but
      // nobody with the authority to issue the next one.
      S.userIns.run(uid, lc, display, hashPw(password), first ? 1 : 0, now, inv.createdBy || null, now);
      if (S.invBurn.run(uid, now, code).changes !== 1) throw new Error("raced");
      db.exec("COMMIT");
    } catch (e) {
      try { db.exec("ROLLBACK"); } catch (_) {}
      if (e.message === "handle-taken") return { ok: false, error: "that handle is taken — pick another", field: "handle" };
      if (e.message === "raced") return { ok: false, error: "this invite has already been used", state: "used" };
      return { ok: false, error: "could not create the account" };
    }
    hydrate();
    const nu = users.get(uid);
    return { ok: true, user: pub(nu), token: tokenFor(nu, options.sessionDays || 30), adopted: uid === priorOwner };
  }

  // Bootstrap: the operator holding ADMIN_PASSWORD creates account #1 with no invite, because there
  // is nobody yet who could have issued one. Refuses the moment any account exists.
  function bootstrap(handle, password, priorOwner) {
    if (countUsers() > 0) return { ok: false, error: "accounts already exist — sign in instead" };
    const hBad = handleError(handle); if (hBad) return { ok: false, error: hBad, field: "handle" };
    const pBad = pwError(password); if (pBad) return { ok: false, error: pBad, field: "password" };
    const display = String(handle).trim().slice(0, 24), lc = display.toLowerCase();
    let uid = (priorOwner && typeof priorOwner === "string" && !users.get(priorOwner)) ? priorOwner : "";
    if (!uid) uid = crypto.randomBytes(12).toString("base64url");
    const now = Date.now();
    try { S.userIns.run(uid, lc, display, hashPw(password), 1, now, null, now); }
    catch (_) { return { ok: false, error: "that handle is taken — pick another", field: "handle" }; }
    hydrate();
    const nu = users.get(uid);
    return { ok: true, user: pub(nu), token: tokenFor(nu, options.sessionDays || 30) };
  }

  // Claim: an existing member arriving with a valid legacy shared-password session. Same account
  // creation as redeem, no invite required, available only while the operator leaves the legacy
  // door open. This is what stops the accounts migration logging the whole group out for good.
  function claim(handle, password, priorOwner) {
    const hBad = handleError(handle); if (hBad) return { ok: false, error: hBad, field: "handle" };
    const pBad = pwError(password); if (pBad) return { ok: false, error: pBad, field: "password" };
    const display = String(handle).trim().slice(0, 24), lc = display.toLowerCase();
    if (getUserByHandle(lc)) return { ok: false, error: "that handle is taken — pick another", field: "handle" };
    let uid = (priorOwner && typeof priorOwner === "string" && !users.get(priorOwner)) ? priorOwner : "";
    if (!uid) uid = crypto.randomBytes(12).toString("base64url");
    const now = Date.now(), first = countUsers() === 0;
    try { S.userIns.run(uid, lc, display, hashPw(password), first ? 1 : 0, now, null, now); }
    catch (_) { return { ok: false, error: "that handle is taken — pick another", field: "handle" }; }
    hydrate();
    const nu = users.get(uid);
    return { ok: true, user: pub(nu), token: tokenFor(nu, options.sessionDays || 30), adopted: uid === priorOwner };
  }

  // ---- direct messages -------------------------------------------------------------------------
  // markFor(coin) -> number|null is injected by the server so this module never reaches into the
  // poller. It reads the same row object the snapshot ships, so a stamped price is by construction
  // the price the sender was looking at.
  let markFor = options.markFor || (() => null);
  function setMarkSource(fn) { if (typeof fn === "function") markFor = fn; }

  const pair = (x, y) => (x < y ? [x, y] : [y, x]);
  function threadFor(uidA, uidB, create) {
    const [a, b] = pair(uidA, uidB);
    let t = S.thrFind.get(a, b);
    if (!t && create) {
      try { S.thrIns.run(a, b, Date.now()); } catch (_) {}
      t = S.thrFind.get(a, b);
    }
    return t || null;
  }
  const inThread = (t, uid) => !!t && (t.a === uid || t.b === uid);
  // Who to wake when this thread moves. Used by the SSE fan-out so a poke reaches the two people in
  // the conversation and nobody else.
  function threadPeers(id) { const t = S.thrById.get(+id); return t ? [t.a, t.b] : []; }
  const peerOf = (t, uid) => (t.a === uid ? t.b : t.a);

  function wire(m, uid) {
    return { id: m.id, thread: m.thread, mine: m.sender === uid,
      sender: (users.get(m.sender) || {}).display || "—",
      ts: m.ts, body: m.deletedAt ? "" : m.body,
      ref: m.ref || null, refPx: m.refPx == null ? null : m.refPx,
      px: m.ref ? markFor(m.ref) : null,          // live mark, derived at read — never stored
      edited: !!m.editedAt, deleted: !!m.deletedAt };
  }

  function send(fromUid, toUid, body, coinResolve) {
    const from = users.get(fromUid), to = users.get(toUid);
    if (!from) return { ok: false, error: "not signed in" };
    if (!to || to.disabledAt) return { ok: false, error: "no such member" };
    if (to.uid === from.uid) return { ok: false, error: "you can't message yourself" };
    const text = cleanBody(body);
    if (!text) return { ok: false, error: "write something first" };
    if (S.msgBurst.get(fromUid, Date.now() - DM_BURST_MS).n >= DM_BURST_N)
      return { ok: false, error: "slow down — too many messages at once", retry: true };

    const t = threadFor(fromUid, toUid, true);
    if (!t) return { ok: false, error: "could not open that conversation" };
    // The stamp: resolve $TICKER to a coin id the snapshot knows, then read its mark. A symbol the
    // server doesn't recognise is left as plain text rather than stamped with nothing.
    const sym = firstTickerRef(text);
    let ref = null, refPx = null;
    if (sym) {
      const coin = coinResolve ? coinResolve(sym) : sym;
      if (coin) { ref = coin; const px = markFor(coin); refPx = Number.isFinite(px) && px > 0 ? px : null; }
    }
    const now = Date.now();
    const r = S.msgIns.run(t.id, fromUid, now, text, ref, refPx);
    const id = Number(r.lastInsertRowid);
    S.thrTouch.run(id, now, t.id);
    S.readUp.run(t.id, fromUid, id);            // your own message is read by definition
    const msg = S.msgById.get(id);
    return { ok: true, id, thread: t.id, peer: toUid, message: wire(msg, fromUid) };
  }

  function edit(uid, id, body) {
    const m = S.msgById.get(+id);
    if (!m || m.sender !== uid) return { ok: false, error: "that isn't your message" };
    if (m.deletedAt) return { ok: false, error: "that message was deleted" };
    const text = cleanBody(body);
    if (!text) return { ok: false, error: "write something first" };
    // The reference can move with an edit, but refPx deliberately does NOT: the claim was made at
    // that price. Same discipline notes apply to a rewritten body.
    const sym = firstTickerRef(text);
    S.msgEdit.run(text, sym ? (m.ref || sym) : null, Date.now(), +id, uid);
    return { ok: true, thread: m.thread, message: wire(S.msgById.get(+id), uid) };
  }
  function drop(uid, id) {
    const m = S.msgById.get(+id);
    if (!m || m.sender !== uid) return { ok: false, error: "that isn't your message" };
    // Tombstone, never a delete: the row's id is a cursor position on the other side, and removing
    // it would make their next sync silently skip a beat.
    S.msgDrop.run(Date.now(), +id, uid);
    return { ok: true, thread: m.thread, message: wire(S.msgById.get(+id), uid) };
  }

  function threads(uid) {
    const out = [];
    for (const t of S.thrMine.all(uid, uid)) {
      const peer = users.get(peerOf(t, uid));
      if (!peer) continue;
      const rd = S.readGet.get(t.id, uid) || { readMsgId: 0, muted: 0 };
      const last = S.msgLast.get(t.id);
      out.push({
        id: t.id, peer: peer.uid, handle: peer.display, disabled: !!peer.disabledAt,
        lastAt: t.lastAt, muted: !!rd.muted,
        unread: S.msgUnread.get(t.id, rd.readMsgId, uid).n,
        preview: last ? (last.deletedAt ? "message deleted"
          : (last.ref ? "$" + last.ref + " · " + last.body : last.body)).slice(0, 90) : "",
      });
    }
    return out;
  }

  function history(uid, threadId, before, limit) {
    const t = S.thrById.get(+threadId);
    if (!inThread(t, uid)) return { ok: false, error: "no such conversation" };
    const b = Number.isFinite(+before) && +before > 0 ? +before : Number.MAX_SAFE_INTEGER;
    const n = Math.min(Math.max(+limit || 50, 1), 200);
    const rows = S.msgPage.all(t.id, b, n).reverse().map((m) => wire(m, uid));
    return { ok: true, thread: t.id, peer: peerOf(t, uid), messages: rows,
      more: rows.length === n, cursor: S.msgMaxId.get().m };
  }

  // The SSE-triggered pull. One cursor across every thread the caller is in, which is why the
  // message id is global rather than per-thread: a single `since` answers "what did I miss".
  function sync(uid, since, limit) {
    const s = Number.isFinite(+since) && +since >= 0 ? +since : 0;
    const n = Math.min(Math.max(+limit || 200, 1), 500);
    const out = [];
    for (const t of S.thrMine.all(uid, uid)) {
      for (const m of S.msgSince.all(t.id, s, n)) out.push(wire(m, uid));
    }
    out.sort((a, b) => a.id - b.id);
    return { ok: true, cursor: S.msgMaxId.get().m, messages: out.slice(0, n), threads: threads(uid) };
  }

  function markRead(uid, threadId, upTo) {
    const t = S.thrById.get(+threadId);
    if (!inThread(t, uid)) return { ok: false, error: "no such conversation" };
    // Clamp to what actually exists. An unclamped cursor from the client would let a caller mark
    // itself read PAST messages not yet sent, permanently zeroing its own unread count and
    // silencing every future escalation on the thread — a read receipt for the future.
    const last = (S.msgLast.get(t.id) || { id: 0 }).id;
    const want = Number.isFinite(+upTo) && +upTo > 0 ? +upTo : last;
    const to = Math.min(want, last);
    S.readUp.run(t.id, uid, to);
    return { ok: true, thread: t.id, readMsgId: to };
  }
  function setMuted(uid, threadId, on) {
    const t = S.thrById.get(+threadId);
    if (!inThread(t, uid)) return { ok: false, error: "no such conversation" };
    S.readMute.run(t.id, uid, on ? 1 : 0);
    return { ok: true, thread: t.id, muted: !!on };
  }

  // ---- offline escalation ----------------------------------------------------------------------
  // Returns one digest per (recipient, sender) for messages that are still unread, older than
  // `delayMs`, not muted, and not already escalated. The delay is the whole feature: without it two
  // people typing at each other would generate a push per line.
  //
  // isOnline(uid) is supplied by the server from its live SSE connection map — a member with the
  // terminal open is by definition not missing anything.
  function pendingEscalations(delayMs, isOnline) {
    const now = Date.now(), cut = now - (delayMs == null ? 5 * 60000 : delayMs);
    const out = [];
    for (const t of db.prepare("SELECT * FROM dm_thread WHERE lastAt > 0").all()) {
      for (const uid of [t.a, t.b]) {
        const u = users.get(uid);
        if (!u || u.disabledAt) continue;
        if (isOnline && isOnline(uid)) continue;
        const rd = S.readGet.get(t.id, uid) || { readMsgId: 0, muted: 0, notifiedMsgId: 0 };
        if (rd.muted) continue;
        const floor = Math.max(rd.readMsgId || 0, rd.notifiedMsgId || 0);
        const rows = S.msgSince.all(t.id, floor, 50)
          .filter((m) => m.sender !== uid && !m.deletedAt && m.ts <= cut);
        if (!rows.length) continue;
        const from = users.get(peerOf(t, uid));
        out.push({ uid, thread: t.id, from: from ? from.display : "someone",
          n: rows.length, upTo: rows[rows.length - 1].id,
          lines: rows.slice(-3).map((m) => (m.ref ? "$" + m.ref + " · " : "") + m.body.slice(0, 90)) });
      }
    }
    return out;
  }
  function markEscalated(uid, threadId, upTo) {
    try { S.readNotified.run(+threadId, uid, +upTo || 0); } catch (_) {}
  }

  function stats() {
    return { users: users.size, admins: [...users.values()].filter((u) => u.isAdmin && !u.disabledAt).length,
      invitesOpen: S.invList.all().filter((i) => inviteState(i, Date.now()) === "open").length,
      messages: S.msgMaxId.get().m };
  }

  return {
    // identity
    signSession, sessionUser, tokenFor, countUsers, getUser, getUserByHandle, listUsers, pub,
    login, setPassword, signOutEverywhere, setDisabled, setAdmin, touch, hydrate,
    // invites
    mintInvite, readInvite, revokeInvite, listInvites, redeem, bootstrap, claim, inviteState,
    // messages
    setMarkSource, threadFor, threadPeers, send, edit, drop, threads, history, sync, markRead, setMuted,
    pendingEscalations, markEscalated,
    stats,
    // testing seams
    _db: db,
  };
}

module.exports = { openAccounts, mintCode, normCode, handleError, pwError, hashPw, verifyPw,
  cleanBody, firstTickerRef, CODE_ALPHABET, DM_MAX_LEN, PW_MIN };
