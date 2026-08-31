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

-- One table for both shapes (build 2026.08.31-47). A 1-to-1 is not a special case of a group here,
-- it is a group whose membership is frozen at two and whose identity is the PAIR — which is what
-- pairKey encodes: the two uids sorted and joined, UNIQUE, so "open a DM with X" stays one index
-- hit and stays idempotent. A group carries NULL there (SQLite lets a UNIQUE index hold many NULLs,
-- which is exactly the semantics wanted: groups are never deduplicated by membership).
-- Self-serve password reset, delivered to the member's own linked Telegram. One live code per
-- account: requesting again replaces the previous one, which is both the rate-limit anchor and the
-- reason an old code in somebody's chat history stops working the moment a new one is asked for.
--
-- Stored in the clear, for the same reason invite codes are: anyone who can read this volume also
-- holds the session secret and can mint a session for any uid directly, so hashing a 6-digit code
-- protects nothing they do not already have. The defences that matter are the short TTL, the
-- attempt ceiling and the send ceiling below.
CREATE TABLE IF NOT EXISTS otp (
  uid TEXT PRIMARY KEY,
  code TEXT NOT NULL,
  createdAt INTEGER NOT NULL,
  expiresAt INTEGER NOT NULL,
  tries INTEGER NOT NULL DEFAULT 0,
  sends INTEGER NOT NULL DEFAULT 0,       -- within the current window
  windowStart INTEGER NOT NULL
) STRICT, WITHOUT ROWID;

CREATE TABLE IF NOT EXISTS dm_thread (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  kind TEXT NOT NULL DEFAULT 'dm',        -- 'dm' | 'group'
  pairKey TEXT,                           -- 'uidA|uidB' for a dm, NULL for a group
  title TEXT,                             -- groups only
  createdBy TEXT,
  createdAt INTEGER NOT NULL,
  lastMsgId INTEGER NOT NULL DEFAULT 0,
  lastAt INTEGER NOT NULL DEFAULT 0
) STRICT;

-- Membership is a table, not two columns, which is the whole reason groups are possible at all.
-- leftAt rather than a delete: a departed member's messages stay attributed, and their name still
-- resolves when somebody scrolls back through the conversation they were part of.
CREATE TABLE IF NOT EXISTS dm_member (
  thread INTEGER NOT NULL,
  uid TEXT NOT NULL,
  joinedAt INTEGER NOT NULL,
  leftAt INTEGER,
  owner INTEGER NOT NULL DEFAULT 0,       -- group creator: can rename, add, remove
  PRIMARY KEY (thread, uid)
) STRICT, WITHOUT ROWID;

CREATE TABLE IF NOT EXISTS dm_msg (
  id INTEGER PRIMARY KEY AUTOINCREMENT,   -- global monotonic: this IS the sync cursor
  thread INTEGER NOT NULL,
  sender TEXT NOT NULL,
  ts INTEGER NOT NULL,
  body TEXT NOT NULL,
  ref TEXT,                        -- $TICKER coin id, when the message carried one
  refPx REAL,                      -- the mark at send. Written once, never revised.
  editedAt INTEGER,
  deletedAt INTEGER,
  sys TEXT,                        -- system event ('added'/'removed'/'left'/'renamed'), else NULL
  fileId TEXT,                     -- attachment, when the message carried one
  via TEXT,                        -- 'telegram' when it came in over the bridge, else NULL
  pinnedAt INTEGER,                -- a desk channel wants the current levels at the top
  pinnedBy TEXT
) STRICT;

-- Tickers a member wants to hear about even when they are not looking. A message carrying one of
-- these as its $TICKER reference escalates IMMEDIATELY and pierces a muted thread: "tell me when
-- anyone mentions PLTR" is worthless if it waits five minutes or is silenced by the mute you set
-- on a busy group. Deliberately its own list rather than the markets-table watchlist, which lives
-- in localStorage and the server has never seen.
CREATE TABLE IF NOT EXISTS dm_watch (
  uid TEXT NOT NULL,
  coin TEXT NOT NULL,
  at INTEGER NOT NULL,
  PRIMARY KEY (uid, coin)
) STRICT, WITHOUT ROWID;

-- Every operator read of a conversation they are not in. An operator who can read everything is a
-- decision the owner made; a record of when they did is what keeps it accountable rather than
-- silent. Append-only, never served to non-admins.
CREATE TABLE IF NOT EXISTS dm_audit (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  uid TEXT NOT NULL,
  action TEXT NOT NULL,
  thread INTEGER,
  detail TEXT,
  at INTEGER NOT NULL
) STRICT;
CREATE INDEX IF NOT EXISTS dm_audit_at ON dm_audit(at);

CREATE TABLE IF NOT EXISTS dm_read (
  thread INTEGER NOT NULL,
  uid TEXT NOT NULL,
  readMsgId INTEGER NOT NULL DEFAULT 0,
  muted INTEGER NOT NULL DEFAULT 0,
  notifiedMsgId INTEGER NOT NULL DEFAULT 0,   -- highest id already escalated to Telegram
  PRIMARY KEY (thread, uid)
) STRICT, WITHOUT ROWID;

-- Reactions are (message, person, emoji) and nothing else. No free text: a reaction is a fixed
-- vocabulary, or it is a message wearing a smaller font.
CREATE TABLE IF NOT EXISTS dm_reaction (
  msg INTEGER NOT NULL,
  uid TEXT NOT NULL,
  emoji TEXT NOT NULL,
  at INTEGER NOT NULL,
  PRIMARY KEY (msg, uid, emoji)
) STRICT, WITHOUT ROWID;

-- The row is the record; the bytes live on the volume under dm-files/<id>. mime is what WE sniffed
-- from the first bytes, never what the uploader claimed — see safeMime.
CREATE TABLE IF NOT EXISTS dm_file (
  id TEXT PRIMARY KEY,
  thread INTEGER NOT NULL,
  uid TEXT NOT NULL,
  name TEXT NOT NULL,
  mime TEXT NOT NULL,
  size INTEGER NOT NULL,
  inline INTEGER NOT NULL DEFAULT 0,      -- 1 only for image types we verified by magic bytes
  createdAt INTEGER NOT NULL
) STRICT;
`);

  // ---- migration from the pair-columns schema --------------------------------------------------
  // Phase 1 shipped dm_thread(a, b). This lifts such a database onto the membership table in place,
  // once, idempotently. It is a no-op on a fresh volume — but a schema change that silently drops
  // conversations is not something to find out about in production.
  // CREATE TABLE IF NOT EXISTS does nothing to a table that already exists, so every column added
  // after a table shipped has to be added by hand. Table-driven rather than a list of one-off
  // ALTERs: the next column added to the schema above only has to be named here, and forgetting is
  // what produced "table dm_msg has no column named sys" the first time round.
  const ADDED_COLUMNS = {
    dm_thread: [["kind", "TEXT NOT NULL DEFAULT 'dm'"], ["pairKey", "TEXT"], ["title", "TEXT"], ["createdBy", "TEXT"]],
    dm_msg: [["sys", "TEXT"], ["fileId", "TEXT"], ["via", "TEXT"], ["pinnedAt", "INTEGER"], ["pinnedBy", "TEXT"]],
  };
  for (const [table, cols] of Object.entries(ADDED_COLUMNS)) {
    const have = db.prepare("PRAGMA table_info(" + table + ")").all().map((c) => c.name);
    if (!have.length) continue;
    for (const [name, decl] of cols)
      if (!have.includes(name)) db.exec("ALTER TABLE " + table + " ADD COLUMN " + name + " " + decl);
  }
  (() => {
    const cols = db.prepare("PRAGMA table_info(dm_thread)").all().map((c) => c.name);
    if (!cols.includes("a")) return;
    db.exec("BEGIN IMMEDIATE");
    try {
      for (const t of db.prepare("SELECT id, a, b, createdAt FROM dm_thread WHERE a IS NOT NULL").all()) {
        const [x, y] = t.a < t.b ? [t.a, t.b] : [t.b, t.a];
        db.prepare("UPDATE dm_thread SET kind='dm', pairKey=? WHERE id=?").run(x + "|" + y, t.id);
        for (const uid of [t.a, t.b])
          db.prepare("INSERT OR IGNORE INTO dm_member (thread, uid, joinedAt) VALUES (?,?,?)").run(t.id, uid, t.createdAt);
      }
      db.exec("COMMIT");
    } catch (e) { try { db.exec("ROLLBACK"); } catch (_) {} throw e; }
  })();

  // Indexes last: on a migrated database the columns they cover only exist as of the block above.
  db.exec(`
CREATE UNIQUE INDEX IF NOT EXISTS dm_pairkey ON dm_thread(pairKey);
CREATE INDEX IF NOT EXISTS dm_member_uid ON dm_member(uid, leftAt);
CREATE INDEX IF NOT EXISTS dm_by_thread ON dm_msg(thread, id);
CREATE INDEX IF NOT EXISTS dm_by_sender ON dm_msg(sender, ts);
CREATE INDEX IF NOT EXISTS dm_reaction_msg ON dm_reaction(msg);
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

    otpGet: db.prepare("SELECT * FROM otp WHERE uid = ?"),
    otpPut: db.prepare(`INSERT INTO otp (uid, code, createdAt, expiresAt, tries, sends, windowStart)
      VALUES (?,?,?,?,0,?,?) ON CONFLICT(uid) DO UPDATE SET code = excluded.code,
      createdAt = excluded.createdAt, expiresAt = excluded.expiresAt, tries = 0,
      sends = excluded.sends, windowStart = excluded.windowStart`),
    otpTry: db.prepare("UPDATE otp SET tries = tries + 1 WHERE uid = ?"),
    otpBurn: db.prepare("DELETE FROM otp WHERE uid = ?"),

    thrByPair: db.prepare("SELECT * FROM dm_thread WHERE pairKey = ?"),
    thrById: db.prepare("SELECT * FROM dm_thread WHERE id = ?"),
    thrInsDm: db.prepare("INSERT INTO dm_thread (kind, pairKey, createdAt) VALUES ('dm',?,?)"),
    thrInsGroup: db.prepare("INSERT INTO dm_thread (kind, title, createdBy, createdAt) VALUES ('group',?,?,?)"),
    thrRename: db.prepare("UPDATE dm_thread SET title = ? WHERE id = ? AND kind = 'group'"),
    thrTouch: db.prepare("UPDATE dm_thread SET lastMsgId = ?, lastAt = ? WHERE id = ?"),
    thrMine: db.prepare(`SELECT t.* FROM dm_thread t JOIN dm_member m ON m.thread = t.id
      WHERE m.uid = ? AND m.leftAt IS NULL ORDER BY t.lastAt DESC`),
    thrActive: db.prepare("SELECT * FROM dm_thread WHERE lastAt > 0"),

    memAdd: db.prepare("INSERT INTO dm_member (thread, uid, joinedAt, owner) VALUES (?,?,?,?) ON CONFLICT(thread, uid) DO UPDATE SET leftAt = NULL, joinedAt = excluded.joinedAt"),
    memGet: db.prepare("SELECT * FROM dm_member WHERE thread = ? AND uid = ?"),
    // Ordered, not incidental: leaveGroup promotes the first row when the last owner walks out, so
    // an unordered read would hand ownership to an arbitrary member and do it differently each run.
    memOf: db.prepare("SELECT * FROM dm_member WHERE thread = ? AND leftAt IS NULL ORDER BY joinedAt, uid"),
    memAll: db.prepare("SELECT * FROM dm_member WHERE thread = ?"),
    memLeave: db.prepare("UPDATE dm_member SET leftAt = ? WHERE thread = ? AND uid = ? AND leftAt IS NULL"),

    msgIns: db.prepare("INSERT INTO dm_msg (thread, sender, ts, body, ref, refPx, sys, fileId, via) VALUES (?,?,?,?,?,?,?,?,?)"),
    msgById: db.prepare("SELECT * FROM dm_msg WHERE id = ?"),
    msgEdit: db.prepare("UPDATE dm_msg SET body = ?, ref = ?, editedAt = ? WHERE id = ? AND sender = ? AND deletedAt IS NULL"),
    msgDrop: db.prepare("UPDATE dm_msg SET deletedAt = ?, body = '', fileId = NULL WHERE id = ? AND sender = ?"),
    msgPage: db.prepare("SELECT * FROM dm_msg WHERE thread = ? AND id < ? ORDER BY id DESC LIMIT ?"),
    msgSince: db.prepare("SELECT * FROM dm_msg WHERE thread = ? AND id > ? ORDER BY id LIMIT ?"),
    msgLast: db.prepare("SELECT * FROM dm_msg WHERE thread = ? ORDER BY id DESC LIMIT 1"),
    msgUnread: db.prepare("SELECT COUNT(*) AS n FROM dm_msg WHERE thread = ? AND id > ? AND sender <> ? AND deletedAt IS NULL AND sys IS NULL"),
    msgBurst: db.prepare("SELECT COUNT(*) AS n FROM dm_msg WHERE sender = ? AND ts > ?"),
    msgMaxId: db.prepare("SELECT COALESCE(MAX(id), 0) AS m FROM dm_msg"),
    // Search is scoped by a JOIN on membership, never by a thread id the caller supplied: the
    // filter IS the authorization, so there is no way to phrase a query that reaches outside it.
    msgSearch: db.prepare(`SELECT s.* FROM dm_msg s JOIN dm_member m ON m.thread = s.thread
      WHERE m.uid = ? AND m.leftAt IS NULL AND s.deletedAt IS NULL AND s.sys IS NULL
        AND s.body LIKE ? ESCAPE '\\' ORDER BY s.id DESC LIMIT ?`),

    readGet: db.prepare("SELECT * FROM dm_read WHERE thread = ? AND uid = ?"),
    readUp: db.prepare(`INSERT INTO dm_read (thread, uid, readMsgId) VALUES (?,?,?)
      ON CONFLICT(thread, uid) DO UPDATE SET readMsgId = MAX(readMsgId, excluded.readMsgId)`),
    readMute: db.prepare(`INSERT INTO dm_read (thread, uid, muted) VALUES (?,?,?)
      ON CONFLICT(thread, uid) DO UPDATE SET muted = excluded.muted`),
    readNotified: db.prepare(`INSERT INTO dm_read (thread, uid, notifiedMsgId) VALUES (?,?,?)
      ON CONFLICT(thread, uid) DO UPDATE SET notifiedMsgId = MAX(notifiedMsgId, excluded.notifiedMsgId)`),

    reactAdd: db.prepare("INSERT OR IGNORE INTO dm_reaction (msg, uid, emoji, at) VALUES (?,?,?,?)"),
    reactDrop: db.prepare("DELETE FROM dm_reaction WHERE msg = ? AND uid = ? AND emoji = ?"),
    reactOf: db.prepare("SELECT * FROM dm_reaction WHERE msg = ?"),
    reactMine: db.prepare("SELECT 1 AS x FROM dm_reaction WHERE msg = ? AND uid = ? AND emoji = ?"),

    fileIns: db.prepare("INSERT INTO dm_file (id, thread, uid, name, mime, size, inline, createdAt) VALUES (?,?,?,?,?,?,?,?)"),
    fileById: db.prepare("SELECT * FROM dm_file WHERE id = ?"),
    fileDrop: db.prepare("DELETE FROM dm_file WHERE id = ?"),
    // Uploaded, then never sent — the person picked a file and changed their mind. Nothing points
    // at these rows, so without a sweep they and their bytes sit on the volume forever.
    fileOrphans: db.prepare(`SELECT f.id FROM dm_file f
      WHERE f.createdAt < ? AND NOT EXISTS (SELECT 1 FROM dm_msg m WHERE m.fileId = f.id) LIMIT 500`),

    pinSet: db.prepare("UPDATE dm_msg SET pinnedAt = ?, pinnedBy = ? WHERE id = ?"),
    pinsOf: db.prepare("SELECT * FROM dm_msg WHERE thread = ? AND pinnedAt IS NOT NULL AND deletedAt IS NULL ORDER BY pinnedAt DESC LIMIT 20"),

    watchAdd: db.prepare("INSERT OR IGNORE INTO dm_watch (uid, coin, at) VALUES (?,?,?)"),
    watchDrop: db.prepare("DELETE FROM dm_watch WHERE uid = ? AND coin = ?"),
    watchOf: db.prepare("SELECT coin FROM dm_watch WHERE uid = ? ORDER BY coin"),
    watchHas: db.prepare("SELECT 1 AS x FROM dm_watch WHERE uid = ? AND coin = ?"),

    // Every stamped message, newest first. This is the record the price stamp exists to build.
    callsAll: db.prepare(`SELECT * FROM dm_msg WHERE ref IS NOT NULL AND deletedAt IS NULL
      ORDER BY id DESC LIMIT ?`),
    callsMine: db.prepare(`SELECT m.* FROM dm_msg m JOIN dm_member mem ON mem.thread = m.thread
      WHERE mem.uid = ? AND mem.leftAt IS NULL AND m.ref IS NOT NULL AND m.deletedAt IS NULL
      ORDER BY m.id DESC LIMIT ?`),

    auditAdd: db.prepare("INSERT INTO dm_audit (uid, action, thread, detail, at) VALUES (?,?,?,?,?)"),
    auditList: db.prepare("SELECT * FROM dm_audit ORDER BY id DESC LIMIT ?"),

    thrAll: db.prepare("SELECT * FROM dm_thread ORDER BY lastAt DESC LIMIT ?"),
    msgSearchAll: db.prepare(`SELECT * FROM dm_msg WHERE deletedAt IS NULL AND sys IS NULL
      AND body LIKE ? ESCAPE '\\' ORDER BY id DESC LIMIT ?`),
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

  // ---- self-serve reset by one-time code -------------------------------------------------------
  // There is no mail server here and adding one for a ten-person desk is not worth it. There IS a
  // delivery wire already: the Telegram outbox, with recipients, quiet hours and caps. So the code
  // goes there — and because a reset code is not an alert, it is sent with the cap and the quiet
  // window bypassed. Delivery itself is the CALLER's job: this module returns the code and never
  // learns that Telegram exists.
  const OTP_TTL_MS = 10 * 60 * 1000;
  const OTP_MAX_TRIES = 5;               // per code, then it dies — 6 digits is 1e6, not enough alone
  const OTP_MAX_SENDS = 3;               // per hour, per account
  const OTP_WINDOW_MS = 60 * 60 * 1000;
  function otpRequest(handle) {
    const u = getUserByHandle(handle);
    // A missing or disabled account is reported as "nothing to send" rather than an error: the
    // caller shows one message either way, so a stranger cannot use this to enumerate handles.
    if (!u || u.disabledAt) return { ok: true, sent: false };
    const now = Date.now();
    const prev = S.otpGet.get(u.uid);
    let sends = 1, windowStart = now;
    if (prev && now - prev.windowStart < OTP_WINDOW_MS) {
      if (prev.sends >= OTP_MAX_SENDS) return { ok: true, sent: false, throttled: true, uid: u.uid };
      sends = prev.sends + 1; windowStart = prev.windowStart;
    }
    // randomInt is uniform; a modulo of random bytes would not be, and a 6-digit space is small
    // enough for the bias to be worth avoiding.
    const code = String(crypto.randomInt(0, 1000000)).padStart(6, "0");
    S.otpPut.run(u.uid, code, now, now + OTP_TTL_MS, sends, windowStart);
    return { ok: true, sent: true, uid: u.uid, code, display: u.display, ttlMin: Math.round(OTP_TTL_MS / 60000) };
  }
  function otpVerify(handle, code, password) {
    const u = getUserByHandle(handle);
    const bad = { ok: false, error: "that code is wrong or has expired" };
    if (!u || u.disabledAt) return bad;
    const row = S.otpGet.get(u.uid);
    if (!row) return bad;
    if (row.expiresAt < Date.now()) { S.otpBurn.run(u.uid); return bad; }
    if (row.tries >= OTP_MAX_TRIES) { S.otpBurn.run(u.uid); return bad; }
    // Count the attempt BEFORE comparing, so a crash or a race cannot hand out a free guess.
    S.otpTry.run(u.uid);
    const given = String(code == null ? "" : code).replace(/\s/g, "");
    let match = false;
    try {
      const a = Buffer.from(given), b = Buffer.from(row.code);
      match = a.length === b.length && crypto.timingSafeEqual(a, b);
    } catch (_) { match = false; }
    if (!match) return bad;
    // The password is validated only AFTER the code is proved, so a weak-password error cannot be
    // used to confirm that a guessed code was right.
    const pwBad = pwError(password);
    if (pwBad) return { ok: false, error: pwBad, field: "password", codeOk: true };
    S.otpBurn.run(u.uid);
    return setPassword(u.uid, password);   // bumps the epoch, so every other device signs out
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

  // ---- threads: one shape for a pair, one for a group ------------------------------------------
  const pairKeyOf = (x, y) => (x < y ? x + "|" + y : y + "|" + x);
  function threadFor(uidA, uidB, create) {
    const key = pairKeyOf(uidA, uidB);
    let t = S.thrByPair.get(key);
    if (!t && create) {
      const now = Date.now();
      db.exec("BEGIN IMMEDIATE");
      try {
        // Re-check inside the lock: two people opening each other simultaneously would otherwise
        // both insert, and the UNIQUE index would surface as a crash rather than one thread.
        t = S.thrByPair.get(key);
        if (!t) {
          const r = S.thrInsDm.run(key, now);
          const id = Number(r.lastInsertRowid);
          S.memAdd.run(id, uidA, now, 0);
          S.memAdd.run(id, uidB, now, 0);
        }
        db.exec("COMMIT");
      } catch (e) { try { db.exec("ROLLBACK"); } catch (_) {} }
      t = S.thrByPair.get(key);
    }
    return t || null;
  }
  // Joining a conversation marks whatever was already said as read. The backscroll stays fully
  // readable — this is a small desk, not a compliance boundary — but being added to a group with
  // 500 messages in it should not open on "500 unread". You are not behind; you just arrived.
  function seedRead(threadId, uid) {
    const last = S.msgLast.get(+threadId);
    if (last) S.readUp.run(+threadId, uid, last.id);
  }
  const isMember = (threadId, uid) => {
    const m = S.memGet.get(+threadId, uid);
    return !!m && !m.leftAt;
  };
  const memberUids = (threadId) => S.memOf.all(+threadId).map((m) => m.uid);
  function threadPeers(id) { return memberUids(id); }
  const peerOf = (t, uid) => memberUids(t.id).find((u) => u !== uid) || "";

  // A thread's name depends on who is looking: a pair is "the other person", a group is its title.
  function threadName(t, uid) {
    if (t.kind === "group") return t.title || "untitled group";
    const p = users.get(peerOf(t, uid));
    return p ? p.display : "—";
  }

  const GROUP_TITLE_MAX = 48, GROUP_MAX_MEMBERS = 50;
  function createGroup(uid, title, uids) {
    if (!users.get(uid)) return { ok: false, error: "not signed in" };
    const name = String(title == null ? "" : title).replace(/\s+/g, " ").trim().slice(0, GROUP_TITLE_MAX);
    if (!name) return { ok: false, error: "give the group a name" };
    const want = [...new Set([uid].concat(Array.isArray(uids) ? uids : []))]
      .filter((u) => users.get(u) && !users.get(u).disabledAt);
    if (want.length < 2) return { ok: false, error: "a group needs somebody else in it" };
    if (want.length > GROUP_MAX_MEMBERS) return { ok: false, error: "that is too many people for one group" };
    const now = Date.now();
    let id;
    db.exec("BEGIN IMMEDIATE");
    try {
      id = Number(S.thrInsGroup.run(name, uid, now).lastInsertRowid);
      for (const u of want) S.memAdd.run(id, u, now, u === uid ? 1 : 0);
      db.exec("COMMIT");
    } catch (e) { try { db.exec("ROLLBACK"); } catch (_) {} return { ok: false, error: "could not create the group" }; }
    sysMessage(id, uid, "created", name);
    return { ok: true, thread: id };
  }

  // System lines are ordinary rows with `sys` set. They ride the same cursor as everything else, so
  // "gustavo added lena" arrives through the same sync a message does — no second channel, and no
  // way for the membership story to drift from the message history.
  function sysMessage(threadId, actor, kind, detail) {
    const now = Date.now();
    const id = Number(S.msgIns.run(+threadId, actor || "", now, String(detail || ""), null, null, kind, null, null).lastInsertRowid);
    S.thrTouch.run(id, now, +threadId);
    return id;
  }

  function groupGuard(threadId, uid, needOwner) {
    const t = S.thrById.get(+threadId);
    if (!t) return { ok: false, error: "no such conversation" };
    if (t.kind !== "group") return { ok: false, error: "that is a direct message, not a group" };
    const m = S.memGet.get(+threadId, uid);
    if (!m || m.leftAt) return { ok: false, error: "no such conversation" };
    if (needOwner && !m.owner) return { ok: false, error: "only the person who made this group can do that" };
    return { ok: true, thread: t, member: m };
  }
  function addMembers(uid, threadId, uids) {
    const g = groupGuard(threadId, uid, true);
    if (!g.ok) return g;
    const now = Date.now(), added = [];
    for (const u of (Array.isArray(uids) ? uids : [])) {
      const who = users.get(u);
      if (!who || who.disabledAt || isMember(threadId, u)) continue;
      if (memberUids(threadId).length >= GROUP_MAX_MEMBERS) break;
      S.memAdd.run(+threadId, u, now, 0);
      seedRead(threadId, u);
      added.push(who.display);
    }
    if (!added.length) return { ok: false, error: "nobody to add" };
    sysMessage(threadId, uid, "added", added.join(", "));
    return { ok: true, thread: +threadId, added };
  }
  function removeMember(uid, threadId, target) {
    const g = groupGuard(threadId, uid, true);
    if (!g.ok) return g;
    if (target === uid) return { ok: false, error: "leave the group instead" };
    if (!isMember(threadId, target)) return { ok: false, error: "they are not in this group" };
    S.memLeave.run(Date.now(), +threadId, target);
    sysMessage(threadId, uid, "removed", (users.get(target) || {}).display || "someone");
    return { ok: true, thread: +threadId };
  }
  function leaveGroup(uid, threadId) {
    const g = groupGuard(threadId, uid, false);
    if (!g.ok) return g;
    S.memLeave.run(Date.now(), +threadId, uid);
    sysMessage(threadId, uid, "left", (users.get(uid) || {}).display || "someone");
    // The last owner out hands ownership to whoever has been there longest, so a group can never
    // end up with members and nobody who can manage it.
    const left = S.memOf.all(+threadId);
    if (left.length && !left.some((m) => m.owner))
      db.prepare("UPDATE dm_member SET owner = 1 WHERE thread = ? AND uid = ?").run(+threadId, left[0].uid);
    return { ok: true, thread: +threadId };
  }
  function renameGroup(uid, threadId, title) {
    const g = groupGuard(threadId, uid, true);
    if (!g.ok) return g;
    const name = String(title == null ? "" : title).replace(/\s+/g, " ").trim().slice(0, GROUP_TITLE_MAX);
    if (!name) return { ok: false, error: "give the group a name" };
    S.thrRename.run(name, +threadId);
    sysMessage(threadId, uid, "renamed", name);
    return { ok: true, thread: +threadId, title: name };
  }

  // ---- reactions --------------------------------------------------------------------------------
  // A fixed vocabulary on purpose. Free text here would be a second, worse message field: unbounded,
  // unsearchable, and rendered in a place with no room for it.
  const REACTIONS = ["\u{1F44D}", "\u{1F44E}", "\u{1F440}", "\u{1F525}", "✅", "\u{1F914}", "\u{1F4C8}", "\u{1F4C9}"];
  function react(uid, msgId, emoji) {
    const m = S.msgById.get(+msgId);
    if (!m || !isMember(m.thread, uid)) return { ok: false, error: "no such message" };
    if (m.deletedAt) return { ok: false, error: "that message was deleted" };
    if (!REACTIONS.includes(String(emoji))) return { ok: false, error: "not a reaction" };
    const had = S.reactMine.get(+msgId, uid, String(emoji));
    if (had) S.reactDrop.run(+msgId, uid, String(emoji));
    else S.reactAdd.run(+msgId, uid, String(emoji), Date.now());
    return { ok: true, thread: m.thread, message: wire(S.msgById.get(+msgId), uid) };
  }
  // {emoji: {n, mine, who}} — `who` is what makes a reaction accountable rather than a vote count.
  function reactionsOf(msgId, uid) {
    const rows = S.reactOf.all(+msgId);
    if (!rows.length) return null;
    const out = {};
    for (const r of rows) {
      const e = out[r.emoji] || (out[r.emoji] = { n: 0, mine: false, who: [] });
      e.n++;
      if (r.uid === uid) e.mine = true;
      if (e.who.length < 8) e.who.push((users.get(r.uid) || {}).display || "—");
    }
    return out;
  }

  // ---- attachments ------------------------------------------------------------------------------
  // The uploader's claimed content type is never trusted. We sniff the first bytes ourselves and
  // render INLINE only for the four raster formats that cannot carry script. Everything else —
  // including SVG, which is a document with a <script> element in it — is served as a download.
  const FILE_MAX = 8 * 1024 * 1024;
  const fileDir = path.join(dataDir, "dm-files");
  function safeMime(buf, name) {
    const b = buf;
    const startsWith = (...bytes) => bytes.every((v, i) => b[i] === v);
    if (startsWith(0x89, 0x50, 0x4E, 0x47)) return { mime: "image/png", inline: 1 };
    if (startsWith(0xFF, 0xD8, 0xFF)) return { mime: "image/jpeg", inline: 1 };
    if (startsWith(0x47, 0x49, 0x46, 0x38)) return { mime: "image/gif", inline: 1 };
    if (startsWith(0x52, 0x49, 0x46, 0x46) && b.length > 11 &&
        b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50) return { mime: "image/webp", inline: 1 };
    if (startsWith(0x25, 0x50, 0x44, 0x46)) return { mime: "application/pdf", inline: 0 };
    // Unknown bytes: octet-stream and a forced download. Naming it by extension would hand an
    // attacker the content type, which is the whole hole this closes.
    return { mime: "application/octet-stream", inline: 0 };
  }
  // Filtered by code point, like cleanBody, and for the same reason. Path separators go too:
  // the stored filename is only ever a LABEL — the bytes live under a random id — but a name
  // that can contain a slash is one refactor away from being joined to a path.
  function fileNameClean(raw) {
    let out = "";
    for (const ch of String(raw == null ? "" : raw)) {
      const c = ch.codePointAt(0);
      if (c < 32 || c === 127) continue;
      if (ch === "/" || ch === "\\") continue;
      out += ch;
    }
    return out.trim().slice(0, 120) || "file";
  }
  function putFile(uid, threadId, name, buf) {
    if (!isMember(threadId, uid)) return { ok: false, error: "no such conversation" };
    if (!buf || !buf.length) return { ok: false, error: "that file is empty" };
    if (buf.length > FILE_MAX) return { ok: false, error: "that file is too large (8 MB maximum)" };
    const sniff = safeMime(buf, name);
    const id = crypto.randomBytes(16).toString("hex");
    try {
      fs.mkdirSync(fileDir, { recursive: true });
      const tmp = path.join(fileDir, id + ".tmp");
      fs.writeFileSync(tmp, buf);
      fs.renameSync(tmp, path.join(fileDir, id));
    } catch (_) { return { ok: false, error: "could not store that file" }; }
    S.fileIns.run(id, +threadId, uid, fileNameClean(name), sniff.mime, buf.length, sniff.inline, Date.now());
    return { ok: true, file: S.fileById.get(id) };
  }
  // Reading a file is a membership check, never a "knows the id" check: an id in a URL is not a
  // capability, and a forwarded link must not become an access grant.
  function readFile(uid, fileId) {
    const f = S.fileById.get(String(fileId || ""));
    if (!f || !isMember(f.thread, uid)) return { ok: false, error: "no such file" };
    const p = path.join(fileDir, f.id);
    if (!fs.existsSync(p)) return { ok: false, error: "that file is no longer stored" };
    return { ok: true, file: f, path: p };
  }
  // A missing row is the normal state for an attachment whose message was deleted, so it reports
  // "no attachment" rather than a dangling reference the client would render as a broken chip.
  const fileWire = (id) => {
    if (!id) return null;
    const f = S.fileById.get(id);
    return f ? { id: f.id, name: f.name, mime: f.mime, size: f.size, inline: !!f.inline } : null;
  };

  // ---- the wire shape ---------------------------------------------------------------------------
  function wire(m, uid) {
    return { id: m.id, thread: m.thread, mine: m.sender === uid,
      senderUid: m.sender || null,
      sender: m.sender ? ((users.get(m.sender) || {}).display || "—") : "",
      ts: m.ts, body: m.deletedAt ? "" : m.body,
      ref: m.ref || null, refPx: m.refPx == null ? null : m.refPx,
      px: m.ref ? markFor(m.ref) : null,          // live mark, derived at read — never stored
      edited: !!m.editedAt, deleted: !!m.deletedAt,
      sys: m.sys || null, via: m.via || null, pinned: !!m.pinnedAt,
      file: m.deletedAt ? null : fileWire(m.fileId),
      reactions: m.deletedAt ? null : reactionsOf(m.id, uid) };
  }

  // ---- sending ----------------------------------------------------------------------------------
  // One path for a pair and a group: `to` is either a uid (opening or reusing the pair thread) or a
  // thread id. Two entry points would be two places for the membership check to be wrong.
  function send(fromUid, target, body, coinResolve, opts) {
    const o = opts || {};
    const from = users.get(fromUid);
    if (!from) return { ok: false, error: "not signed in" };
    let t = null;
    if (o.thread) {
      t = S.thrById.get(+o.thread);
      if (!t || !isMember(t.id, fromUid)) return { ok: false, error: "no such conversation" };
    } else {
      const to = users.get(String(target || ""));
      if (!to || to.disabledAt) return { ok: false, error: "no such member" };
      if (to.uid === from.uid) return { ok: false, error: "you can't message yourself" };
      t = threadFor(fromUid, to.uid, true);
      if (!t) return { ok: false, error: "could not open that conversation" };
    }
    const text = cleanBody(body);
    const file = o.fileId ? S.fileById.get(o.fileId) : null;
    if (!text && !file) return { ok: false, error: "write something first" };
    if (file && (file.thread !== t.id || file.uid !== fromUid)) return { ok: false, error: "that attachment is not yours" };
    if (S.msgBurst.get(fromUid, Date.now() - DM_BURST_MS).n >= DM_BURST_N)
      return { ok: false, error: "slow down — too many messages at once", retry: true };

    const sym = firstTickerRef(text);
    let ref = null, refPx = null;
    if (sym) {
      const coin = coinResolve ? coinResolve(sym) : sym;
      if (coin) { ref = coin; const px = markFor(coin); refPx = Number.isFinite(px) && px > 0 ? px : null; }
    }
    const now = Date.now();
    const id = Number(S.msgIns.run(t.id, fromUid, now, text, ref, refPx, null, file ? file.id : null, o.via || null).lastInsertRowid);
    S.thrTouch.run(id, now, t.id);
    S.readUp.run(t.id, fromUid, id);            // your own message is read by definition
    return { ok: true, id, thread: t.id, message: wire(S.msgById.get(id), fromUid) };
  }

  function edit(uid, id, body) {
    const m = S.msgById.get(+id);
    if (!m || m.sender !== uid || m.sys) return { ok: false, error: "that isn't your message" };
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
    if (!m || m.sender !== uid || m.sys) return { ok: false, error: "that isn't your message" };
    // Tombstone the ROW, never delete it: the id is a cursor position on the other side, and
    // removing it would make their next sync silently skip a beat. The ATTACHMENT is a different
    // matter — it must actually go, row and bytes, or "delete" is a rendering change and anyone who
    // still holds the id can keep downloading it.
    S.msgDrop.run(Date.now(), +id, uid);
    removeFile(m.fileId);
    return { ok: true, thread: m.thread, message: wire(S.msgById.get(+id), uid) };
  }

  // ---- reading ----------------------------------------------------------------------------------
  function threadInfo(t, uid) {
    const rd = S.readGet.get(t.id, uid) || { readMsgId: 0, muted: 0 };
    const last = S.msgLast.get(t.id);
    const mem = S.memOf.all(t.id);
    const me = S.memGet.get(t.id, uid);
    const preview = last
      ? (last.sys ? sysLine(last) : last.deletedAt ? "message deleted"
        : ((last.ref ? "$" + last.ref + " · " : "") + (last.body || (last.fileId ? "sent a file" : ""))))
      : "";
    return {
      id: t.id, kind: t.kind, title: t.title || null,
      name: threadName(t, uid),
      peer: t.kind === "dm" ? peerOf(t, uid) : null,
      handle: threadName(t, uid),
      members: mem.map((m) => ({ uid: m.uid, display: (users.get(m.uid) || {}).display || "—", owner: !!m.owner })),
      owner: !!(me && me.owner),
      disabled: t.kind === "dm" ? !!(users.get(peerOf(t, uid)) || {}).disabledAt : false,
      lastAt: t.lastAt, muted: !!rd.muted,
      // What the OTHER side has read, so "did my call land" is answerable. The data was already
      // being stored for unread counts; showing it costs a lookup.
      seen: mem.filter((x) => x.uid !== uid).map((x) => ({
        uid: x.uid, handle: (users.get(x.uid) || {}).display || "—",
        readMsgId: (S.readGet.get(t.id, x.uid) || { readMsgId: 0 }).readMsgId })),
      pins: S.pinsOf.all(t.id).length,
      unread: S.msgUnread.get(t.id, rd.readMsgId, uid).n,
      preview: String(preview).slice(0, 90),
    };
  }
  const sysLine = (m) => {
    const who = (users.get(m.sender) || {}).display || "someone";
    if (m.sys === "created") return who + " created “" + m.body + "”";
    if (m.sys === "added") return who + " added " + m.body;
    if (m.sys === "removed") return who + " removed " + m.body;
    if (m.sys === "left") return m.body + " left";
    if (m.sys === "renamed") return who + " renamed this to “" + m.body + "”";
    return "";
  };
  function threads(uid) { return S.thrMine.all(uid).map((t) => threadInfo(t, uid)); }

  function history(uid, threadId, before, limit) {
    const t = S.thrById.get(+threadId);
    if (!t || !isMember(t.id, uid)) return { ok: false, error: "no such conversation" };
    const b = Number.isFinite(+before) && +before > 0 ? +before : Number.MAX_SAFE_INTEGER;
    const n = Math.min(Math.max(+limit || 50, 1), 200);
    const rows = S.msgPage.all(t.id, b, n).reverse().map((m) => wire(m, uid));
    return { ok: true, thread: t.id, info: threadInfo(t, uid), messages: rows,
      more: rows.length === n, cursor: S.msgMaxId.get().m };
  }

  // The SSE-triggered pull. One cursor across every thread the caller is in, which is why the
  // message id is global rather than per-thread: a single `since` answers "what did I miss".
  function sync(uid, since, limit) {
    const s = Number.isFinite(+since) && +since >= 0 ? +since : 0;
    const n = Math.min(Math.max(+limit || 200, 1), 500);
    const out = [];
    for (const t of S.thrMine.all(uid)) {
      for (const m of S.msgSince.all(t.id, s, n)) out.push(wire(m, uid));
    }
    out.sort((a, b) => a.id - b.id);
    return { ok: true, cursor: S.msgMaxId.get().m, messages: out.slice(0, n), threads: threads(uid) };
  }

  // Search runs over the caller's own membership by JOIN, so the scope IS the authorization — there
  // is no thread id to tamper with. LIKE rather than FTS5: no extension dependency, and at a desk's
  // volume of messages the scan is far cheaper than the index would be to maintain.
  function search(uid, q, limit) {
    const raw = String(q == null ? "" : q).trim();
    if (raw.length < 2) return { ok: true, q: raw, results: [] };
    const esc = raw.replace(/[\\%_]/g, (c) => "\\" + c);
    const n = Math.min(Math.max(+limit || 50, 1), 100);
    const rows = S.msgSearch.all(uid, "%" + esc + "%", n);
    return { ok: true, q: raw, results: rows.map((m) => {
      const t = S.thrById.get(m.thread);
      return Object.assign(wire(m, uid), { threadName: t ? threadName(t, uid) : "—", kind: t ? t.kind : "dm" });
    }) };
  }

  function markRead(uid, threadId, upTo) {
    const t = S.thrById.get(+threadId);
    if (!t || !isMember(t.id, uid)) return { ok: false, error: "no such conversation" };
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
    if (!t || !isMember(t.id, uid)) return { ok: false, error: "no such conversation" };
    S.readMute.run(t.id, uid, on ? 1 : 0);
    return { ok: true, thread: t.id, muted: !!on };
  }

  // ---- attachment lifecycle ----------------------------------------------------------------------
  // Deleting a message has to take its attachment with it. The first version nulled fileId on the
  // message and stopped there, which left the row AND the bytes behind — and because /api/dm/file
  // authorizes on thread membership rather than on a live reference, anyone in the thread who still
  // had the id in their client cache could keep downloading the attachment of a "deleted" message.
  // Deleting is not a rendering change.
  function removeFile(id) {
    if (!id) return;
    try { fs.unlinkSync(path.join(fileDir, String(id))); } catch (_) {}
    try { S.fileDrop.run(String(id)); } catch (_) {}
  }
  // An upload only becomes reachable when a message references it, so anything unreferenced and
  // older than the grace window was abandoned mid-compose. The window matters: a file uploaded
  // milliseconds before its message must not be swept out from under it.
  const FILE_ORPHAN_GRACE_MS = 30 * 60 * 1000;
  function sweepFiles(graceMs) {
    const cut = Date.now() - (graceMs == null ? FILE_ORPHAN_GRACE_MS : graceMs);
    const gone = S.fileOrphans.all(cut);
    for (const f of gone) removeFile(f.id);
    return gone.length;
  }

  // ---- ticker watch --------------------------------------------------------------------------------
  function watchList(uid) { return S.watchOf.all(uid).map((r) => r.coin); }
  function setWatch(uid, coin, on) {
    const c = String(coin || "").trim().toUpperCase();
    if (!c || c.length > 24) return { ok: false, error: "that isn't a ticker" };
    if (on) S.watchAdd.run(uid, c, Date.now()); else S.watchDrop.run(uid, c);
    return { ok: true, watching: watchList(uid) };
  }
  const watches = (uid, coin) => !!(coin && S.watchHas.get(uid, String(coin).toUpperCase()));

  // ---- pins ----------------------------------------------------------------------------------------
  function pin(uid, id, on) {
    const m = S.msgById.get(+id);
    if (!m || !isMember(m.thread, uid)) return { ok: false, error: "no such message" };
    if (m.deletedAt || m.sys) return { ok: false, error: "that message cannot be pinned" };
    S.pinSet.run(on ? Date.now() : null, on ? uid : null, +id);
    return { ok: true, thread: m.thread, message: wire(S.msgById.get(+id), uid) };
  }
  const pinsOf = (threadId, uid) => S.pinsOf.all(+threadId).map((m) => wire(m, uid));

  // ---- the calls record ----------------------------------------------------------------------------
  // A stamped message is a dated, priced claim with an author — the same shape as a note, which is
  // why it can be promoted into one. This is what the stamp was for: without somewhere to read them
  // together, every call dies in the conversation it was made in.
  function calls(uid, opts) {
    const o = opts || {};
    const n = Math.min(Math.max(+o.limit || 200, 1), 500);
    const rows = o.all ? S.callsAll.all(n) : S.callsMine.all(uid, n);
    const out = [];
    for (const m of rows) {
      if (o.by && m.sender !== o.by) continue;
      const t = S.thrById.get(m.thread);
      const live = markFor(m.ref);
      const at = m.refPx;
      const has = at != null && isFinite(at) && at > 0;
      const ok = has && live != null && isFinite(live) && live > 0;
      out.push({
        id: m.id, thread: m.thread, ts: m.ts,
        senderUid: m.sender, sender: (users.get(m.sender) || {}).display || "—",
        threadName: t ? threadName(t, uid) : "—", kind: t ? t.kind : "dm",
        body: m.body, ref: m.ref, refPx: has ? at : null, px: ok ? live : null,
        chg: ok ? live / at - 1 : null,
      });
    }
    // The summary is per person, because "who is right" is the only question a call record answers.
    const byWho = new Map();
    for (const c of out) {
      if (c.chg == null) continue;
      const e = byWho.get(c.senderUid) || { uid: c.senderUid, who: c.sender, n: 0, up: 0, sum: 0 };
      e.n++; if (c.chg > 0) e.up++; e.sum += c.chg;
      byWho.set(c.senderUid, e);
    }
    const summary = [...byWho.values()].map((e) => ({
      uid: e.uid, who: e.who, n: e.n, upPct: e.n ? e.up / e.n : null, avg: e.n ? e.sum / e.n : null,
    })).sort((a, b) => b.n - a.n);
    return { ok: true, calls: out, summary };
  }

  // ---- export ---------------------------------------------------------------------------------------
  // If messages carry trade calls they are a record, and a record you cannot get out of the system
  // is a record you do not really have.
  function exportThread(uid, threadId) {
    const t = S.thrById.get(+threadId);
    if (!t || !isMember(t.id, uid)) return { ok: false, error: "no such conversation" };
    const rows = db.prepare("SELECT * FROM dm_msg WHERE thread = ? ORDER BY id").all(t.id);
    return { ok: true, thread: t.id, kind: t.kind, name: threadName(t, uid),
      exportedAt: Date.now(),
      members: S.memAll.all(t.id).map((m) => ({ handle: (users.get(m.uid) || {}).display || m.uid,
        joinedAt: m.joinedAt, leftAt: m.leftAt || null })),
      messages: rows.map((m) => ({ id: m.id, ts: m.ts,
        from: m.sender ? ((users.get(m.sender) || {}).display || m.sender) : null,
        body: m.deletedAt ? null : m.body, deleted: !!m.deletedAt, edited: !!m.editedAt,
        sys: m.sys || null, via: m.via || null,
        ref: m.ref || null, refPx: m.refPx == null ? null : m.refPx,
        file: m.fileId ? (fileWire(m.fileId) || { id: m.fileId, missing: true }) : null })) };
  }

  // ---- operator read-through -------------------------------------------------------------------------
  // The owner decided an operator may read every message on this terminal. It is a SEPARATE surface
  // from the member API on purpose: folding an admin bypass into the membership filter would mean
  // one bug in that filter hands a member the same reach. These functions never consult membership,
  // and nothing else in the module calls them.
  function adminAudit(uid, action, thread, detail) {
    try { S.auditAdd.run(uid, action, thread == null ? null : +thread, detail || null, Date.now()); } catch (_) {}
  }
  function adminThreads(limit) {
    return S.thrAll.all(Math.min(Math.max(+limit || 200, 1), 500)).map((t) => {
      const mem = S.memAll.all(t.id);
      const last = S.msgLast.get(t.id);
      return { id: t.id, kind: t.kind, title: t.title || null, lastAt: t.lastAt,
        members: mem.map((m) => ({ handle: (users.get(m.uid) || {}).display || m.uid, left: !!m.leftAt })),
        n: db.prepare("SELECT COUNT(*) AS n FROM dm_msg WHERE thread = ?").get(t.id).n,
        preview: last ? String(last.sys ? sysLine(last) : last.deletedAt ? "message deleted" : last.body).slice(0, 90) : "" };
    });
  }
  function adminHistory(adminUid, threadId, before, limit) {
    const t = S.thrById.get(+threadId);
    if (!t) return { ok: false, error: "no such conversation" };
    const b = Number.isFinite(+before) && +before > 0 ? +before : Number.MAX_SAFE_INTEGER;
    const n = Math.min(Math.max(+limit || 100, 1), 300);
    const rows = S.msgPage.all(t.id, b, n).reverse();
    adminAudit(adminUid, "read-thread", t.id, "" + rows.length + " message(s)");
    return { ok: true, thread: t.id, kind: t.kind,
      name: t.kind === "group" ? (t.title || "untitled group")
        : S.memAll.all(t.id).map((m) => (users.get(m.uid) || {}).display || m.uid).join(" ↔ "),
      members: S.memAll.all(t.id).map((m) => ({ uid: m.uid, handle: (users.get(m.uid) || {}).display || m.uid, left: !!m.leftAt })),
      messages: rows.map((m) => Object.assign(wire(m, adminUid), {
        // wire() marks `mine` against the reader; for an operator looking into somebody else's
        // conversation that is meaningless, so the sender is named explicitly instead.
        mine: false, sender: m.sender ? ((users.get(m.sender) || {}).display || "—") : "" })),
      more: rows.length === n };
  }
  function adminSearch(adminUid, q, limit) {
    const raw = String(q == null ? "" : q).trim();
    if (raw.length < 2) return { ok: true, q: raw, results: [] };
    const esc = raw.replace(/[\\%_]/g, (c) => "\\" + c);
    const n = Math.min(Math.max(+limit || 100, 1), 200);
    const rows = S.msgSearchAll.all("%" + esc + "%", n);
    adminAudit(adminUid, "search", null, raw.slice(0, 64) + " (" + rows.length + " hit(s))");
    return { ok: true, q: raw, results: rows.map((m) => {
      const t = S.thrById.get(m.thread);
      return { id: m.id, thread: m.thread, ts: m.ts, body: m.body,
        sender: (users.get(m.sender) || {}).display || "—",
        threadName: t ? (t.kind === "group" ? (t.title || "untitled group")
          : S.memAll.all(t.id).map((x) => (users.get(x.uid) || {}).display || x.uid).join(" ↔ ")) : "—" };
    }) };
  }
  const adminAuditLog = (limit) => S.auditList.all(Math.min(Math.max(+limit || 100, 1), 500))
    .map((r) => ({ at: r.at, who: (users.get(r.uid) || {}).display || r.uid, action: r.action, thread: r.thread, detail: r.detail }));

  // ---- offline escalation ----------------------------------------------------------------------
  // Returns one digest per (recipient, thread) for messages that are still unread, older than
  // `delayMs`, not muted, and not already escalated. The delay is the whole feature: without it two
  // people typing at each other would generate a push per line.
  //
  // isOnline(uid) is supplied by the server from its live SSE connection map — a member with the
  // terminal open is by definition not missing anything.
  function pendingEscalations(delayMs, isOnline) {
    const now = Date.now(), cut = now - (delayMs == null ? 5 * 60000 : delayMs);
    const out = [];
    for (const t of S.thrActive.all()) {
      for (const uid of memberUids(t.id)) {
        const u = users.get(uid);
        if (!u || u.disabledAt) continue;
        if (isOnline && isOnline(uid)) continue;
        const rd = S.readGet.get(t.id, uid) || { readMsgId: 0, muted: 0, notifiedMsgId: 0 };
        const floor = Math.max(rd.readMsgId || 0, rd.notifiedMsgId || 0);
        const fresh = S.msgSince.all(t.id, floor, 50)
          .filter((m) => m.sender !== uid && !m.deletedAt && !m.sys);
        // A ticker you asked to hear about jumps the queue: it goes out immediately rather than
        // waiting out the delay, and it pierces a muted thread. Muting a busy group should not be
        // the same as asking not to be told when somebody mentions the name you are watching.
        const hot = fresh.filter((m) => m.ref && watches(uid, m.ref));
        const rows = hot.length ? hot : (rd.muted ? [] : fresh.filter((m) => m.ts <= cut));
        if (!rows.length) continue;
        out.push({ uid, thread: t.id, kind: t.kind,
          from: t.kind === "group" ? threadName(t, uid)
            : ((users.get(rows[rows.length - 1].sender) || {}).display || "someone"),
          n: rows.length, upTo: rows[rows.length - 1].id, hot: hot.length > 0,
          lines: rows.slice(-3).map((m) => ((m.ref ? "$" + m.ref + " · " : "")
            + (m.body || (m.fileId ? "sent a file" : ""))).slice(0, 90)) });
      }
    }
    return out;
  }
  function markEscalated(uid, threadId, upTo) {
    try { S.readNotified.run(+threadId, uid, +upTo || 0); } catch (_) {}
  }

  // ---- the Telegram bridge ----------------------------------------------------------------------
  // Inbound replies are DELIBERATELY command-only. A bare message arriving at the bot must never
  // become a DM: people already send /start, /stop and stray text to that chat, and turning any of
  // it into a message posted under their name is the kind of surprise you cannot take back.
  //   /r <text>            -> the thread the last digest to that chat was about
  //   /r @handle <text>    -> that person, explicitly
  function bridgeReply(uid, text, lastThread) {
    const who = users.get(uid);
    if (!who || who.disabledAt) return { ok: false, error: "that chat is not linked to an account" };
    const raw = String(text == null ? "" : text).trim();
    if (!raw) return { ok: false, error: "nothing to send" };
    const at = /^@([A-Za-z0-9._-]{2,24})\s+([\s\S]+)$/.exec(raw);
    if (at) {
      const target = getUserByHandle(at[1]);
      if (!target) return { ok: false, error: "no member called @" + at[1] };
      return send(uid, target.uid, at[2], null, { via: "telegram" });
    }
    if (!lastThread || !isMember(lastThread, uid))
      return { ok: false, error: "reply to a message notification first, or use /r @handle your text" };
    return send(uid, null, raw, null, { thread: lastThread, via: "telegram" });
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
    otpRequest, otpVerify,
    // messages
    setMarkSource, threadFor, threadPeers, isMember, memberUids, send, edit, drop,
    threads, history, sync, search, markRead, setMuted,
    createGroup, addMembers, removeMember, leaveGroup, renameGroup,
    react, REACTIONS, putFile, readFile, removeFile, sweepFiles, bridgeReply,
    watchList, setWatch, pin, pinsOf, calls, exportThread,
    adminThreads, adminHistory, adminSearch, adminAuditLog,
    pendingEscalations, markEscalated,
    stats,
    // testing seams
    _db: db,
  };
}

module.exports = { openAccounts, mintCode, normCode, handleError, pwError, hashPw, verifyPw,
  cleanBody, firstTickerRef, CODE_ALPHABET, DM_MAX_LEN, PW_MIN, FILE_MAX: 8 * 1024 * 1024 };
