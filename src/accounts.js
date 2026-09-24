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
const { vacuumIntoAsync } = require("./vacuum");

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
// ASYNC on purpose: crypto.scrypt runs on libuv's threadpool, so a sign-in attempt no longer holds
// the event loop for the ~30-50ms the derivation costs. The sync version did — and /login is the
// one route an unauthenticated caller can drive as fast as they like, so every wrong password was
// 30-50ms in which no snapshot, no SSE frame and no other request moved. The on-disk format is
// byte-for-byte the same, so every existing row verifies unchanged (pinned by a test that hashes
// with the sync path and verifies with this one).
const SCRYPT_N = 16384, SCRYPT_KEYLEN = 64;
const PW_MIN = 12;
const scryptAsync = require("util").promisify(crypto.scrypt);
// The pre-async hasher. Kept for exactly two callers: the decoy hashed once at open (openAccounts
// is synchronous, and one derivation at boot is not a latency problem) and the format-compat
// test. Not a hot path, and never called with a caller-supplied password from a route.
function hashPwSync(pw) {
  const salt = crypto.randomBytes(16).toString("base64url");
  const h = crypto.scryptSync(String(pw), salt, SCRYPT_KEYLEN, { N: SCRYPT_N, r: 8, p: 1 }).toString("base64url");
  return "scrypt$" + SCRYPT_N + "$" + salt + "$" + h;
}
async function hashPw(pw) {
  const salt = crypto.randomBytes(16).toString("base64url");
  const h = (await scryptAsync(String(pw), salt, SCRYPT_KEYLEN, { N: SCRYPT_N, r: 8, p: 1 })).toString("base64url");
  return "scrypt$" + SCRYPT_N + "$" + salt + "$" + h;
}
async function verifyPw(pw, stored) {
  try {
    const p = String(stored || "").split("$");
    if (p.length !== 4 || p[0] !== "scrypt") return false;
    const N = Number(p[1]);
    if (!Number.isFinite(N) || N < 1024) return false;
    const want = Buffer.from(p[3], "base64url");
    const got = await scryptAsync(String(pw), p[2], want.length, { N, r: 8, p: 1 });
    return want.length === got.length && crypto.timingSafeEqual(want, got);
  } catch (_) { return false; }
}
// The uid a redeem/claim/bootstrap may ADOPT from the caller's prior signed alert-owner handle.
// ensureOwner mints randomBytes(12).base64url — 16 chars of [A-Za-z0-9_-] — and that is the only
// shape a handle has ever had. Anything else is a forged cookie: the legacy owner MAC is derived
// from SITE_PASSWORD, which every shared-password member knows, so before this check an invitee
// could sign any string they liked and CHOOSE their uid — "legacy-admin" (the audit attribution
// for break-glass reads), a `|`-bearing string that lands inside another derivation label, or an
// id that collides with a row some other table already keys. A rejected handle just means a
// fresh uid: nothing is refused, only the adoption.
const UID_ADOPT_RE = /^[A-Za-z0-9_-]{12,32}$/;
const UID_RESERVED = new Set(["legacy-admin"]);
function adoptableUid(v) {
  return typeof v === "string" && UID_ADOPT_RE.test(v) && !UID_RESERVED.has(v) ? v : "";
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
const DM_CMD_MAX = 160;                       // a command label; the OUTPUT is the body and takes the body cap
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

const { callRead, callTarget, callBarReaches, inCashSession, marketSessions, callSessionClose, etDayStr } = require("./compute");
const { homeMkt } = require("./sectors");

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
  disabledAt INTEGER,
  usagePaused INTEGER NOT NULL DEFAULT 0   -- (build 2026.09.24-109) 1 = this member paused the usage beacon
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
  kind TEXT NOT NULL DEFAULT 'dm',        -- 'dm' | 'group' | 'board' (an open topic anyone may join)
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
  card TEXT,                       -- a shared screener card (JSON, validated by compute.validateCard); body holds its text rendering
  callH INTEGER,                   -- a call's horizon in ms (NULL = the 7d default); the author may extend it while open
  closedAt INTEGER,                -- an EARLY close by the author, at closePx; otherwise a call closes at its horizon's daily close
  closePx REAL,
  pinnedAt INTEGER,                -- a desk channel wants the current levels at the top
  pinnedBy TEXT,
  replyTo INTEGER,                 -- quoted message id, same thread — threading without threads
  cmd TEXT,                        -- the terminal command this body is the output of ("top funding 5"), else NULL
  cmdAi INTEGER,                   -- 1 when that output came back from the AI fallback rather than the local grammar; NULL/0 otherwise
  editedBy TEXT,                   -- moderation (build 2026.09.23-94): the operator who rewrote somebody else's message, else NULL
  deletedBy TEXT,                  -- the operator who removed somebody else's message, else NULL
  callDroppedBy TEXT,              -- the operator who struck this row's call from the record, else NULL (the words stay)
  -- Call targets (build 2026.09.24-95): "$INTC to 32 by Oct 15". The deadline is NOT its own column:
  -- it is the lifecycle's horizon (ts + callH), so extending a target moves its deadline by construction.
  tgPx REAL,                       -- the target level; the side follows from it unless the words said otherwise
  tgStop REAL,                     -- the optional invalidation level ("unless 27"), else NULL
  tgRes TEXT,                      -- 'hit' | 'wrong' | 'miss' | 'early', written ONCE; NULL while open
  tgAt INTEGER,                    -- when it resolved; closePx carries the price it resolved at
  tgSeen INTEGER                   -- the resolver's 5m-bar cursor: bars opening at/before this were already scanned
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
  hiddenUpTo INTEGER NOT NULL DEFAULT 0,      -- closed: off the rail until a message id passes this
  clearedUpTo INTEGER NOT NULL DEFAULT 0,     -- history cleared: this viewer never sees ids at or under
  boardNotify INTEGER NOT NULL DEFAULT 0,     -- boards only: 1 = full Telegram digests (default is mentions/watched only)
  tgSync INTEGER NOT NULL DEFAULT 0,          -- 1 = this member's Telegram chat mirrors this conversation, both ways (one per member)
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

-- Telegram sync (build 2026.09.24-99): which Telegram message carries which message here, per
-- chat. An edit, a delete or a reaction on either side needs the other side's id, and Telegram
-- has no lookup by content. One Telegram message can carry SEVERAL rows (the mirror packs a burst
-- into one send), so the key is the triple. dir 'out' = the bot's mirror post; 'in' = the member's
-- own line typed at the bot, which became the row. media = a photo/document post, whose words are
-- a caption (editMessageCaption), not a text (editMessageText).
CREATE TABLE IF NOT EXISTS dm_tg (
  chat TEXT NOT NULL,
  tgId INTEGER NOT NULL,
  msg INTEGER NOT NULL,
  uid TEXT NOT NULL,
  dir TEXT NOT NULL,
  media INTEGER NOT NULL DEFAULT 0,
  at INTEGER NOT NULL,
  PRIMARY KEY (chat, tgId, msg)
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

-- Browser push subscriptions, one row per (endpoint); a member may hold several (phone + laptop).
-- The endpoint IS the identity a push service hands out, so it is the key; a dead endpoint is
-- dropped the moment the push service 404/410s it.
-- Per-account UI state that used to live only in localStorage: the markets watchlist and the
-- saved table layouts. One row per (account, key), last-writer-wins on the client's own stamp so
-- a phone and a desktop converge on whichever change was made later, never on whichever tab
-- happened to sync first. The value is opaque JSON the client owns; the server validates shape
-- and size, never meaning.
CREATE TABLE IF NOT EXISTS user_pref (
  uid TEXT NOT NULL,
  key TEXT NOT NULL,
  json TEXT NOT NULL,
  ts INTEGER NOT NULL,
  PRIMARY KEY (uid, key)
) STRICT;

-- One Hyperliquid wallet per account, for the positions overlay. Read-only by construction: an
-- address is public information and the API it feeds is the public /info endpoint — nothing here
-- can sign, and nothing here is a secret worth more than the watchlist next to it.
CREATE TABLE IF NOT EXISTS user_wallet (
  uid TEXT PRIMARY KEY,
  addr TEXT NOT NULL,
  label TEXT,
  addedAt INTEGER NOT NULL
) STRICT;

CREATE TABLE IF NOT EXISTS dm_webpush (
  endpoint TEXT PRIMARY KEY,
  uid TEXT NOT NULL,
  p256dh TEXT NOT NULL,
  auth TEXT NOT NULL,
  ua TEXT,
  addedAt INTEGER NOT NULL
) STRICT;

-- Usage (build 2026.09.24-109): DAILY AGGREGATES, never an event log. One row per (ET calendar
-- day, member, kind, key): kind 'tab' = visible ms on that tab (n = beacons that carried it), kind
-- 'dev' = the coarse device class the beacons came from (desktop | mobile | tablet, '-pwa' when
-- installed; never the raw UA). uid '0' is the sitewide bucket: per-member rows older than the
-- retention window fold into it (summed per day/kind/key) and are deleted, so the long-run tab
-- trend survives and the per-person history does not. No free text, no tickers, no filters.
CREATE TABLE IF NOT EXISTS usage_day (
  day TEXT NOT NULL,
  uid TEXT NOT NULL,
  kind TEXT NOT NULL,
  key TEXT NOT NULL,
  n INTEGER NOT NULL DEFAULT 0,
  ms INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (day, uid, kind, key)
) STRICT, WITHOUT ROWID;
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
    user: [["usagePaused", "INTEGER NOT NULL DEFAULT 0"]],   // (build 2026.09.24-109)
    dm_thread: [["kind", "TEXT NOT NULL DEFAULT 'dm'"], ["pairKey", "TEXT"], ["title", "TEXT"], ["createdBy", "TEXT"]],
    dm_msg: [["sys", "TEXT"], ["fileId", "TEXT"], ["via", "TEXT"], ["pinnedAt", "INTEGER"], ["pinnedBy", "TEXT"], ["replyTo", "INTEGER"], ["side", "TEXT"],
      ["cmd", "TEXT"], ["cmdAi", "INTEGER"], ["card", "TEXT"], ["callH", "INTEGER"], ["closedAt", "INTEGER"], ["closePx", "REAL"],
      ["editedBy", "TEXT"], ["deletedBy", "TEXT"], ["callDroppedBy", "TEXT"],
      ["tgPx", "REAL"], ["tgStop", "REAL"], ["tgRes", "TEXT"], ["tgAt", "INTEGER"], ["tgSeen", "INTEGER"]],
    dm_read: [["hiddenUpTo", "INTEGER NOT NULL DEFAULT 0"], ["clearedUpTo", "INTEGER NOT NULL DEFAULT 0"],
      ["boardNotify", "INTEGER NOT NULL DEFAULT 0"], ["tgSync", "INTEGER NOT NULL DEFAULT 0"]],
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
CREATE INDEX IF NOT EXISTS dm_tg_msg ON dm_tg(msg);
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
    userRename: db.prepare("UPDATE user SET display = ? WHERE uid = ?"),
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
    thrInsBoard: db.prepare("INSERT INTO dm_thread (kind, title, createdBy, createdAt) VALUES ('board',?,?,?)"),
    thrRename: db.prepare("UPDATE dm_thread SET title = ? WHERE id = ? AND kind IN ('group','board')"),
    thrBoards: db.prepare("SELECT * FROM dm_thread WHERE kind = 'board' ORDER BY lastAt DESC, createdAt DESC LIMIT 100"),
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

    msgIns: db.prepare("INSERT INTO dm_msg (thread, sender, ts, body, ref, refPx, side, sys, fileId, via, replyTo, cmd, cmdAi, card, callH, tgPx, tgStop) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)"),
    callSetH: db.prepare("UPDATE dm_msg SET callH = ? WHERE id = ? AND sender = ?"),
    // An early close on a target is also its resolution ('early'): neither a hit nor a miss, and
    // guarded on tgRes IS NULL so a close racing the resolver cannot overwrite a hit.
    callClose: db.prepare("UPDATE dm_msg SET closedAt = ?, closePx = ?, tgRes = CASE WHEN tgPx IS NULL THEN NULL ELSE 'early' END, tgAt = CASE WHEN tgPx IS NULL THEN NULL ELSE ? END WHERE id = ? AND sender = ? AND closedAt IS NULL AND tgRes IS NULL"),
    // The target resolver (build 2026.09.24-95): the open targets, oldest first, and one guarded
    // write per resolution — written once, never revised, exactly like the stamp.
    // (build 2026.09.24-107) Keyset-paged (id > ?) so a sweep reaches every open target, not the
    // oldest 500 forever.
    tgOpen: db.prepare("SELECT * FROM dm_msg WHERE tgPx IS NOT NULL AND tgRes IS NULL AND closedAt IS NULL AND ref IS NOT NULL AND refPx IS NOT NULL AND id > ? ORDER BY id LIMIT 500"),
    tgResolve: db.prepare("UPDATE dm_msg SET tgRes = ?, tgAt = ?, closePx = ? WHERE id = ? AND tgRes IS NULL AND closedAt IS NULL"),
    tgSeenSet: db.prepare("UPDATE dm_msg SET tgSeen = ? WHERE id = ?"),
    msgById: db.prepare("SELECT * FROM dm_msg WHERE id = ?"),
    msgEdit: db.prepare("UPDATE dm_msg SET body = ?, ref = ?, editedAt = ? WHERE id = ? AND sender = ? AND deletedAt IS NULL"),
    msgDrop: db.prepare("UPDATE dm_msg SET deletedAt = ?, body = '', fileId = NULL, card = NULL WHERE id = ? AND sender = ?"),
    // Moderation (build 2026.09.23-94): the operator's variants bind no sender — the route gates
    // them, and the row remembers who acted so the room is told. Striking a call clears every
    // column the record reads (the stamp, its side, its horizon, an early close) and nothing else:
    // the words stand, and retainSweep now ages the row like any other prose.
    msgEditAdm: db.prepare("UPDATE dm_msg SET body = ?, editedAt = ?, editedBy = ? WHERE id = ? AND deletedAt IS NULL"),
    msgDropAdm: db.prepare("UPDATE dm_msg SET deletedAt = ?, deletedBy = ?, body = '', fileId = NULL, card = NULL WHERE id = ?"),
    callDrop: db.prepare("UPDATE dm_msg SET ref = NULL, refPx = NULL, side = NULL, callH = NULL, closedAt = NULL, closePx = NULL, tgPx = NULL, tgStop = NULL, tgRes = NULL, tgAt = NULL, tgSeen = NULL, callDroppedBy = ? WHERE id = ?"),
    msgPage: db.prepare("SELECT * FROM dm_msg WHERE thread = ? AND id < ? AND id > ? ORDER BY id DESC LIMIT ?"),
    msgSince: db.prepare("SELECT * FROM dm_msg WHERE thread = ? AND id > ? ORDER BY id LIMIT ?"),
    msgLast: db.prepare("SELECT * FROM dm_msg WHERE thread = ? ORDER BY id DESC LIMIT 1"),
    msgUnread: db.prepare("SELECT COUNT(*) AS n FROM dm_msg WHERE thread = ? AND id > ? AND sender <> ? AND deletedAt IS NULL AND sys IS NULL"),
    msgBurst: db.prepare("SELECT COUNT(*) AS n FROM dm_msg WHERE sender = ? AND ts > ?"),
    msgMaxId: db.prepare("SELECT COALESCE(MAX(id), 0) AS m FROM dm_msg"),
    // Search is scoped by a JOIN on membership, never by a thread id the caller supplied: the
    // filter IS the authorization, so there is no way to phrase a query that reaches outside it.
    msgSearch: db.prepare(`SELECT s.* FROM dm_msg s JOIN dm_member m ON m.thread = s.thread
      LEFT JOIN dm_read rd ON rd.thread = s.thread AND rd.uid = m.uid
      WHERE m.uid = ? AND m.leftAt IS NULL AND s.deletedAt IS NULL AND s.sys IS NULL
        AND s.id > COALESCE(rd.clearedUpTo, 0)
        AND (? IS NULL OR s.thread = ?)
        AND s.body LIKE ? ESCAPE '\\' ORDER BY s.id DESC LIMIT ?`),

    wpAdd: db.prepare(`INSERT INTO dm_webpush (endpoint, uid, p256dh, auth, ua, addedAt) VALUES (?,?,?,?,?,?)
      ON CONFLICT(endpoint) DO UPDATE SET uid = excluded.uid, p256dh = excluded.p256dh, auth = excluded.auth, ua = excluded.ua`),
    wpDrop: db.prepare("DELETE FROM dm_webpush WHERE endpoint = ?"),
    wpDropMine: db.prepare("DELETE FROM dm_webpush WHERE endpoint = ? AND uid = ?"),
    wpFor: db.prepare("SELECT * FROM dm_webpush WHERE uid = ?"),

    walletGet: db.prepare("SELECT addr, label, addedAt FROM user_wallet WHERE uid = ?"),
    walletPut: db.prepare("INSERT INTO user_wallet (uid, addr, label, addedAt) VALUES (?,?,?,?) ON CONFLICT(uid) DO UPDATE SET addr = excluded.addr, label = excluded.label, addedAt = excluded.addedAt"),
    walletDrop: db.prepare("DELETE FROM user_wallet WHERE uid = ?"),
    walletAll: db.prepare("SELECT w.uid, w.addr FROM user_wallet w JOIN user u ON u.uid = w.uid WHERE u.disabledAt IS NULL"),

    prefAll: db.prepare("SELECT key, json, ts FROM user_pref WHERE uid = ?"),
    prefOne: db.prepare("SELECT ts FROM user_pref WHERE uid = ? AND key = ?"),
    prefPut: db.prepare("INSERT INTO user_pref (uid, key, json, ts) VALUES (?,?,?,?) ON CONFLICT(uid, key) DO UPDATE SET json = excluded.json, ts = excluded.ts"),

    readGet: db.prepare("SELECT * FROM dm_read WHERE thread = ? AND uid = ?"),
    readUp: db.prepare(`INSERT INTO dm_read (thread, uid, readMsgId) VALUES (?,?,?)
      ON CONFLICT(thread, uid) DO UPDATE SET readMsgId = MAX(readMsgId, excluded.readMsgId)`),
    readMute: db.prepare(`INSERT INTO dm_read (thread, uid, muted) VALUES (?,?,?)
      ON CONFLICT(thread, uid) DO UPDATE SET muted = excluded.muted`),
    readNotified: db.prepare(`INSERT INTO dm_read (thread, uid, notifiedMsgId) VALUES (?,?,?)
      ON CONFLICT(thread, uid) DO UPDATE SET notifiedMsgId = MAX(notifiedMsgId, excluded.notifiedMsgId)`),
    readHide: db.prepare(`INSERT INTO dm_read (thread, uid, hiddenUpTo) VALUES (?,?,?)
      ON CONFLICT(thread, uid) DO UPDATE SET hiddenUpTo = excluded.hiddenUpTo`),
    readBoardNotify: db.prepare(`INSERT INTO dm_read (thread, uid, boardNotify) VALUES (?,?,?)
      ON CONFLICT(thread, uid) DO UPDATE SET boardNotify = excluded.boardNotify`),
    // Telegram sync is ONE conversation per member (a bot chat is one conversation), so turning it
    // on anywhere clears it everywhere else for that member first — the pair is one transaction.
    readSyncClear: db.prepare("UPDATE dm_read SET tgSync = 0 WHERE uid = ? AND tgSync = 1"),
    readSync: db.prepare(`INSERT INTO dm_read (thread, uid, tgSync) VALUES (?,?,1)
      ON CONFLICT(thread, uid) DO UPDATE SET tgSync = 1`),
    readSyncOf: db.prepare("SELECT thread FROM dm_read WHERE uid = ? AND tgSync = 1 LIMIT 1"),
    readSyncAll: db.prepare("SELECT thread, uid, notifiedMsgId FROM dm_read WHERE tgSync = 1"),
    // Clearing also reads and closes up to the same point: cleared history must not keep counting
    // as unread or keep the row on the rail with a preview of text this viewer chose to forget.
    readClearAll: db.prepare(`INSERT INTO dm_read (thread, uid, clearedUpTo, readMsgId, hiddenUpTo) VALUES (?,?,?,?,?)
      ON CONFLICT(thread, uid) DO UPDATE SET clearedUpTo = MAX(clearedUpTo, excluded.clearedUpTo),
        readMsgId = MAX(readMsgId, excluded.readMsgId), hiddenUpTo = excluded.hiddenUpTo`),

    // Retention: candidates past their window, oldest first, capped per sweep so one tick never
    // stalls on a huge backlog. Pinned rows are exempt by the WHERE, not by caller discipline.
    // Two exemptions with different lifetimes: PINS are exempt only while LIVE (a deleted-while-
    // pinned row is just a tombstone and ages out), but PRICED CALLS (ref + refPx) are exempt
    // even as tombstones — the record is delete-proof by design: an author deleting a bad call
    // removes the body, never the stamp, so a track record cannot be scrubbed. Everything else
    // ages out.
    retainSweep: db.prepare(`SELECT m.id, m.fileId FROM dm_msg m JOIN dm_thread t ON t.id = m.thread
      WHERE ((m.pinnedAt IS NULL OR m.deletedAt IS NOT NULL) AND (m.ref IS NULL OR m.refPx IS NULL))
        AND m.ts < CASE WHEN t.kind = 'dm' THEN ? ELSE ? END
      ORDER BY m.id LIMIT 500`),
    retainDrop: db.prepare("DELETE FROM dm_msg WHERE id = ?"),
    reactPurge: db.prepare("DELETE FROM dm_reaction WHERE msg = ?"),

    reactAdd: db.prepare("INSERT OR IGNORE INTO dm_reaction (msg, uid, emoji, at) VALUES (?,?,?,?)"),
    reactDrop: db.prepare("DELETE FROM dm_reaction WHERE msg = ? AND uid = ? AND emoji = ?"),
    reactOf: db.prepare("SELECT * FROM dm_reaction WHERE msg = ?"),
    reactMine: db.prepare("SELECT 1 AS x FROM dm_reaction WHERE msg = ? AND uid = ? AND emoji = ?"),

    tgMapIns: db.prepare("INSERT OR IGNORE INTO dm_tg (chat, tgId, msg, uid, dir, media, at) VALUES (?,?,?,?,?,?,?)"),
    tgMapOfMsg: db.prepare("SELECT * FROM dm_tg WHERE msg = ? ORDER BY chat, tgId"),
    tgMapOfTg: db.prepare("SELECT * FROM dm_tg WHERE chat = ? AND tgId = ? ORDER BY msg"),
    tgMapPurge: db.prepare("DELETE FROM dm_tg WHERE msg = ?"),

    fileIns: db.prepare("INSERT INTO dm_file (id, thread, uid, name, mime, size, inline, createdAt) VALUES (?,?,?,?,?,?,?,?)"),
    fileById: db.prepare("SELECT * FROM dm_file WHERE id = ?"),
    fileDrop: db.prepare("DELETE FROM dm_file WHERE id = ?"),
    // Uploaded, then never sent — the person picked a file and changed their mind. Nothing points
    // at these rows, so without a sweep they and their bytes sit on the volume forever.
    fileOrphans: db.prepare(`SELECT f.id FROM dm_file f
      WHERE f.createdAt < ? AND NOT EXISTS (SELECT 1 FROM dm_msg m WHERE m.fileId = f.id) LIMIT 500`),

    pinSet: db.prepare("UPDATE dm_msg SET pinnedAt = ?, pinnedBy = ? WHERE id = ?"),
    pinsOf: db.prepare("SELECT * FROM dm_msg WHERE thread = ? AND pinnedAt IS NOT NULL AND deletedAt IS NULL ORDER BY pinnedAt DESC LIMIT 20"),
    pinsCount: db.prepare("SELECT COUNT(*) AS n FROM dm_msg WHERE thread = ? AND pinnedAt IS NOT NULL AND deletedAt IS NULL"),
    readAllOf: db.prepare("SELECT uid, readMsgId FROM dm_read WHERE thread = ?"),

    watchAdd: db.prepare("INSERT OR IGNORE INTO dm_watch (uid, coin, at) VALUES (?,?,?)"),
    watchDrop: db.prepare("DELETE FROM dm_watch WHERE uid = ? AND coin = ?"),
    watchOf: db.prepare("SELECT coin FROM dm_watch WHERE uid = ? ORDER BY coin"),
    watchHas: db.prepare("SELECT 1 AS x FROM dm_watch WHERE uid = ? AND coin = ?"),

    // Every stamped message, newest first. This is the record the price stamp exists to build.
    // The by-filter lives in the SQL, not JS-after-LIMIT: filtering the newest N overall meant a
    // person whose calls were all older than the window came back as an empty record. Tombstones
    // are INCLUDED: deleting a call removes its body, never its score — see retainSweep.
    callsAll: db.prepare(`SELECT * FROM dm_msg WHERE ref IS NOT NULL AND refPx IS NOT NULL
      AND (? IS NULL OR sender = ?) ORDER BY id DESC LIMIT ?`),
    callsMine: db.prepare(`SELECT m.* FROM dm_msg m JOIN dm_member mem ON mem.thread = m.thread
      WHERE mem.uid = ? AND mem.leftAt IS NULL AND m.ref IS NOT NULL AND m.refPx IS NOT NULL
      AND (? IS NULL OR m.sender = ?) ORDER BY m.id DESC LIMIT ?`),

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

  // Keyed derivation for other secrets that must not be guessable. server.js used to derive its
  // legacy session and alert-owner secrets from SITE_PASSWORD, which is a public constant when the
  // password is unset — so a forged legacy token could reach /claim and the AI-cost routes on an
  // open deployment. Deriving them from THIS random key keeps "rotate the password → invalidate"
  // semantics (the label can carry the password) without a guessable fallback.
  function deriveKey(label) {
    return crypto.createHmac("sha256", sessionSecret).update("derive|" + String(label)).digest();
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

  // One scrypt per sign-in attempt whatever the handle: an unknown handle verifies against a decoy
  // hashed ONCE at open (the old code hashed a fresh decoy AND verified it — two scrypts — so an
  // unknown handle took twice as long as a wrong password), and a disabled account is verified and
  // then refused with the same words as a wrong password rather than short-circuiting with a
  // distinct message in microseconds. Tell a disabled member out of band; the door must not.
  const DECOY_PW = hashPwSync(crypto.randomBytes(24).toString("base64url"));
  async function login(handle, password) {
    const u = getUserByHandle(handle);
    const bad = { ok: false, error: "wrong handle or password" };
    if (!u) { await verifyPw(String(password || ""), DECOY_PW); return bad; }
    const okPw = await verifyPw(password, u.pw);
    if (!okPw || u.disabledAt) return bad;
    try { S.userSeen.run(Date.now(), u.uid); u.lastSeen = Date.now(); } catch (_) {}
    return { ok: true, user: pub(u), token: tokenFor(u, options.sessionDays || 30) };
  }

  // The operator renames a member's DISPLAY name — how they read everywhere — while the sign-in
  // handle (and @mentions, which key on it) stays exactly what it was. The uid never changes and
  // names resolve live at read, so one row update re-titles every message, conversation and call.
  // A display is looser than a handle (spaces are fine: "El Vaquero"), but it must not collide
  // with anyone else's display OR handle, and the reserved names stay reserved — a member reading
  // as "admin" is a phishing surface whatever field it came from.
  function renameUser(uid, raw) {
    const u = users.get(uid);
    if (!u) return { ok: false, error: "no such account" };
    let display = "";
    for (const ch of String(raw == null ? "" : raw)) {
      const c = ch.codePointAt(0);
      if (c < 32 || c === 127) continue;
      display += ch;
    }
    display = display.replace(/\s+/g, " ").trim().slice(0, 24);
    if (display.length < 2) return { ok: false, error: "a name needs 2 characters or more" };
    const lc = display.toLowerCase();
    if (HANDLE_RESERVED.has(lc)) return { ok: false, error: "that name is reserved — pick another" };
    for (const o of users.values())
      if (o.uid !== uid && (String(o.display || "").toLowerCase() === lc || o.handle === lc))
        return { ok: false, error: "another member already reads as that — pick something distinct" };
    S.userRename.run(display, uid);
    hydrate();
    return { ok: true, user: pub(users.get(uid)) };
  }

  async function setPassword(uid, password) {
    const bad = pwError(password);
    if (bad) return { ok: false, error: bad };
    if (!users.get(uid)) return { ok: false, error: "no such account" };
    const hash = await hashPw(password);
    // Re-read after the await: the row may have been removed while the hash ran.
    if (!users.get(uid)) return { ok: false, error: "no such account" };
    S.userPw.run(hash, uid);
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
  // Every hash is computed BEFORE the transaction opens: an await inside BEGIN IMMEDIATE would let
  // any other request's write interleave with the half-done invite burn.
  async function redeem(rawCode, handle, password, priorOwner) {
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
      const newHash = await hashPw(password);
      db.exec("BEGIN IMMEDIATE");
      try {
        if (S.invBurn.run(target.uid, Date.now(), code).changes !== 1)
          throw new Error("raced");
        S.userPw.run(newHash, target.uid);
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

    // Reuse the caller's signed alert-owner handle as the uid when they have one, it has the
    // minted shape, and it is free.
    let uid = adoptableUid(priorOwner) && !users.get(priorOwner) ? priorOwner : "";
    if (!uid) uid = crypto.randomBytes(12).toString("base64url");
    const pwHash = await hashPw(password);
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
      S.userIns.run(uid, lc, display, pwHash, first ? 1 : 0, now, inv.createdBy || null, now);
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
  async function otpVerify(handle, code, password) {
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
    return await setPassword(u.uid, password);   // bumps the epoch, so every other device signs out
  }

  // Bootstrap: the operator holding ADMIN_PASSWORD creates account #1 with no invite, because there
  // is nobody yet who could have issued one. Refuses the moment any account exists.
  async function bootstrap(handle, password, priorOwner) {
    if (countUsers() > 0) return { ok: false, error: "accounts already exist — sign in instead" };
    const hBad = handleError(handle); if (hBad) return { ok: false, error: hBad, field: "handle" };
    const pBad = pwError(password); if (pBad) return { ok: false, error: pBad, field: "password" };
    const display = String(handle).trim().slice(0, 24), lc = display.toLowerCase();
    let uid = adoptableUid(priorOwner) && !users.get(priorOwner) ? priorOwner : "";
    if (!uid) uid = crypto.randomBytes(12).toString("base64url");
    const now = Date.now();
    const pw = await hashPw(password);
    // The count and the insert are one transaction: two concurrent bootstraps must not both win.
    try {
      db.exec("BEGIN IMMEDIATE");
      try {
        if (S.userCount.get().n > 0) { db.exec("ROLLBACK"); return { ok: false, error: "accounts already exist — sign in instead" }; }
        S.userIns.run(uid, lc, display, pw, 1, now, null, now);
        db.exec("COMMIT");
      } catch (e) { try { db.exec("ROLLBACK"); } catch (_) {} throw e; }
    } catch (_) { return { ok: false, error: "that handle is taken — pick another", field: "handle" }; }
    hydrate();
    const nu = users.get(uid);
    return { ok: true, user: pub(nu), token: tokenFor(nu, options.sessionDays || 30) };
  }

  // Claim: an existing member arriving with a valid legacy shared-password session. Same account
  // creation as redeem, no invite required, available only while the operator leaves the legacy
  // door open. This is what stops the accounts migration logging the whole group out for good.
  async function claim(handle, password, priorOwner) {
    const hBad = handleError(handle); if (hBad) return { ok: false, error: hBad, field: "handle" };
    const pBad = pwError(password); if (pBad) return { ok: false, error: pBad, field: "password" };
    const display = String(handle).trim().slice(0, 24), lc = display.toLowerCase();
    if (getUserByHandle(lc)) return { ok: false, error: "that handle is taken — pick another", field: "handle" };
    const pwHash = await hashPw(password);
    let uid = adoptableUid(priorOwner) && !users.get(priorOwner) ? priorOwner : "";
    if (!uid) uid = crypto.randomBytes(12).toString("base64url");
    // NEVER admin: account #1 is the operator's, minted through /bootstrap with ADMIN_PASSWORD.
    // "First to claim becomes operator" handed the panel to whichever shared-password holder
    // posted first on the deploy that introduced accounts, and two concurrent claims could both
    // read a zero count.
    const now = Date.now();
    try { S.userIns.run(uid, lc, display, pwHash, 0, now, null, now); }
    catch (_) { return { ok: false, error: "that handle is taken — pick another", field: "handle" }; }
    hydrate();
    const nu = users.get(uid);
    return { ok: true, user: pub(nu), token: tokenFor(nu, options.sessionDays || 30), adopted: uid === priorOwner };
  }

  // ---- direct messages -------------------------------------------------------------------------
  // Direction of a stamped call, read from the words AROUND the ticker — deliberately dumb and
  // documented rather than clever: short/sell/fade in the 24 chars before the ticker, or
  // short/puts in the 12 after, makes it a short; everything else is a long. One word fixes a
  // miscall; a smarter parser fixes nothing and surprises everyone.
  // The direction and the horizon come from one reader shared with the composer's preview
  // (compute.callRead): the words are listed there, and the client shows which one it used.
  const callSide = (text, sym) => callRead(text, sym).side;

  // markFor(coin) -> number|null is injected by the server so this module never reaches into the
  // poller. It reads the same row object the snapshot ships, so a stamped price is by construction
  // the price the sender was looking at.
  let markFor = options.markFor || (() => null);
  function setMarkSource(fn) { if (typeof fn === "function") markFor = fn; }
  // pxHistory(coin, atTs) -> the first daily close printed at/after atTs, or null while that
  // close is still in the future — the fixed-horizon leg of the calls scoreboard.
  let pxHistory = options.pxHistory || (() => null);
  function setPxHistory(fn) { if (typeof fn === "function") pxHistory = fn; }
  // tweetFor(body, thread) -> preview|{ok:false}|null is injected the same way: the server owns
  // the oEmbed cache and the network; this module only asks "does this body have a card yet".
  let tweetFor = options.tweetFor || (() => null);
  function setTweetSource(fn) { if (typeof fn === "function") tweetFor = fn; }

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

  // A thread's name depends on who is looking: a pair is "the other person", a group or a board
  // is its title.
  function threadName(t, uid) {
    if (t.kind === "group" || t.kind === "board") return t.title || "untitled";
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

  // ---- topic boards ----------------------------------------------------------------------------
  // A board is a group whose door is open: same thread row, same membership table, same messages —
  // the ONE difference is that any member of the terminal may join it themselves, so it behaves
  // like a standing channel for a topic ("$HOOD thesis", "macro week") rather than an invite list.
  // Reads and writes still go through membership: joining is what grants them, exactly as a group,
  // so no authorization path had to learn a new case.
  function createBoard(uid, title) {
    if (!users.get(uid)) return { ok: false, error: "not signed in" };
    const name = String(title == null ? "" : title).replace(/\s+/g, " ").trim().slice(0, GROUP_TITLE_MAX);
    if (!name) return { ok: false, error: "give the topic a name" };
    const now = Date.now();
    let id;
    db.exec("BEGIN IMMEDIATE");
    try {
      id = Number(S.thrInsBoard.run(name, uid, now).lastInsertRowid);
      S.memAdd.run(id, uid, now, 1);
      db.exec("COMMIT");
    } catch (e) { try { db.exec("ROLLBACK"); } catch (_) {} return { ok: false, error: "could not create the topic" }; }
    sysMessage(id, uid, "created", name);
    return { ok: true, thread: id };
  }
  function joinBoard(uid, threadId) {
    const who = users.get(uid);
    if (!who || who.disabledAt) return { ok: false, error: "not signed in" };
    const t = S.thrById.get(+threadId);
    if (!t || t.kind !== "board") return { ok: false, error: "no such topic" };
    if (isMember(t.id, uid)) return { ok: true, thread: t.id, already: true };
    if (memberUids(t.id).length >= GROUP_MAX_MEMBERS) return { ok: false, error: "this topic is full" };
    S.memAdd.run(t.id, uid, Date.now(), 0);
    seedRead(t.id, uid);
    sysMessage(t.id, uid, "joined", who.display);
    return { ok: true, thread: t.id };
  }
  // Every board, joined or not: the whole point of a board is being discoverable. Previews are not
  // a leak — a board is desk-public by construction, which is what separates it from a group.
  function listBoards(uid) {
    return S.thrBoards.all().map((t) => {
      const last = S.msgLast.get(t.id);
      const joined = isMember(t.id, uid);
      const rd = joined ? (S.readGet.get(t.id, uid) || { readMsgId: 0 }) : null;
      return { id: t.id, title: t.title || "untitled", members: memberUids(t.id).length,
        joined, lastAt: t.lastAt,
        unread: joined ? S.msgUnread.get(t.id, rd.readMsgId, uid).n : 0,
        preview: last ? String(last.sys ? sysLine(last) : last.deletedAt ? "message deleted"
          : last.cmd ? "▸ " + last.cmd : (last.body || "attachment")).slice(0, 90) : "no posts yet" };
    });
  }

  // System lines are ordinary rows with `sys` set. They ride the same cursor as everything else, so
  // "gustavo added lena" arrives through the same sync a message does — no second channel, and no
  // way for the membership story to drift from the message history.
  function sysMessage(threadId, actor, kind, detail) {
    const now = Date.now();
    const id = Number(S.msgIns.run(+threadId, actor || "", now, String(detail || ""), null, null, null, kind, null, null, null, null, null, null, null).lastInsertRowid);
    S.thrTouch.run(id, now, +threadId);
    return id;
  }

  // `asAdmin` lets the terminal's operator manage any group THEY ARE IN without being its owner —
  // membership is still required, so this is moderation of rooms they can already read as members,
  // not a management path into conversations they are outside of.
  function groupGuard(threadId, uid, needOwner, asAdmin) {
    const t = S.thrById.get(+threadId);
    if (!t) return { ok: false, error: "no such conversation" };
    if (t.kind !== "group" && t.kind !== "board") return { ok: false, error: "that is a direct message, not a group" };
    const m = S.memGet.get(+threadId, uid);
    if (!m || m.leftAt) return { ok: false, error: "no such conversation" };
    if (needOwner && !m.owner && !asAdmin) return { ok: false, error: "only the person who made this group can do that" };
    return { ok: true, thread: t, member: m };
  }
  function addMembers(uid, threadId, uids, asAdmin) {
    const g = groupGuard(threadId, uid, true, asAdmin);
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
  function removeMember(uid, threadId, target, asAdmin) {
    const g = groupGuard(threadId, uid, true, asAdmin);
    if (!g.ok) return g;
    if (target === uid) return { ok: false, error: "leave the group instead" };
    if (!isMember(threadId, target)) return { ok: false, error: "they are not in this group" };
    S.memLeave.run(Date.now(), +threadId, target);
    sysMessage(threadId, uid, "removed", (users.get(target) || {}).display || "someone");
    return { ok: true, thread: +threadId };
  }
  // Deleting a group or topic is FOR EVERYONE and forever — rows, reactions, attachment bytes,
  // membership, the thread row itself. Owner or operator, and distinct from "close" on purpose:
  // close is a per-viewer tidy-up that keeps everything; this is the shredder, behind its own
  // button and its own confirm. The member list is collected first so the caller can wake the
  // people whose rail just changed; the act lands in the admin audit log.
  function deleteGroup(uid, threadId, asAdmin) {
    const g = groupGuard(threadId, uid, true, asAdmin);
    if (!g.ok) return g;
    const t = g.thread;
    const peers = memberUids(t.id);
    const files = db.prepare("SELECT fileId FROM dm_msg WHERE thread = ? AND fileId IS NOT NULL").all(t.id).map((r) => r.fileId);
    db.exec("BEGIN IMMEDIATE");
    try {
      db.prepare("DELETE FROM dm_reaction WHERE msg IN (SELECT id FROM dm_msg WHERE thread = ?)").run(t.id);
      db.prepare("DELETE FROM dm_tg WHERE msg IN (SELECT id FROM dm_msg WHERE thread = ?)").run(t.id);   // (build 2026.09.24-107) the sync map too
      db.prepare("DELETE FROM dm_msg WHERE thread = ?").run(t.id);
      db.prepare("DELETE FROM dm_member WHERE thread = ?").run(t.id);
      db.prepare("DELETE FROM dm_read WHERE thread = ?").run(t.id);
      db.prepare("DELETE FROM dm_thread WHERE id = ?").run(t.id);
      db.exec("COMMIT");
    } catch (e) { try { db.exec("ROLLBACK"); } catch (_) {} return { ok: false, error: "could not delete it" }; }
    for (const f of files) removeFile(f);
    adminAudit(uid, "delete-group", +threadId, (t.title || "") + " (" + peers.length + " member(s))");
    return { ok: true, deleted: +threadId, peers, title: t.title || "" };
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
  function renameGroup(uid, threadId, title, asAdmin) {
    const g = groupGuard(threadId, uid, true, asAdmin);
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
  // The uploader's claimed content type is never trusted, and the ALLOWLIST is now the policy: a
  // desk chat shares screenshots and plain-text notes, so only the four raster formats we can
  // verify by magic bytes (rendered inline — none can carry script) and .txt that actually
  // validates as text are accepted. Everything else — video, archives, PDFs, SVG above all, which
  // is a document with a <script> element in it — is REFUSED at upload rather than quarantined as
  // a download: a file type nobody here should be sharing does not get a second-class lane.
  const FILE_MAX = 8 * 1024 * 1024;
  const fileDir = path.join(dataDir, "dm-files");
  // Text is bytes that read as text: NUL or any control byte other than tab/LF/CR fails it, over
  // the WHOLE file — a zip renamed .txt fails on its first few bytes, a binary tail on its last.
  function looksLikeText(buf) {
    for (let i = 0; i < buf.length; i++) {
      const c = buf[i];
      if (c === 9 || c === 10 || c === 13) continue;
      if (c < 32 || c === 127) return false;
    }
    return true;
  }
  function safeMime(buf, name) {
    const b = buf;
    const startsWith = (...bytes) => bytes.every((v, i) => b[i] === v);
    if (startsWith(0x89, 0x50, 0x4E, 0x47)) return { mime: "image/png", inline: 1 };
    if (startsWith(0xFF, 0xD8, 0xFF)) return { mime: "image/jpeg", inline: 1 };
    if (startsWith(0x47, 0x49, 0x46, 0x38)) return { mime: "image/gif", inline: 1 };
    if (startsWith(0x52, 0x49, 0x46, 0x46) && b.length > 11 &&
        b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50) return { mime: "image/webp", inline: 1 };
    // .txt by name AND text by bytes — the extension alone is a claim, and claims are not evidence.
    if (/\.txt$/i.test(String(name || "")) && looksLikeText(b)) return { mime: "text/plain; charset=utf-8", inline: 0 };
    // Voice notes: the three containers the composer's recorder can produce, verified by magic
    // bytes and capped hard at AUDIO_MAX below — the small cap is what keeps this from becoming
    // the video lane through the back door.
    if (startsWith(0x1A, 0x45, 0xDF, 0xA3) && /\.(webm|weba)$/i.test(String(name || ""))) return { mime: "audio/webm", inline: 0, audio: 1 };
    if (startsWith(0x4F, 0x67, 0x67, 0x53)) return { mime: "audio/ogg", inline: 0, audio: 1 };
    if (b.length > 11 && b[4] === 0x66 && b[5] === 0x74 && b[6] === 0x79 && b[7] === 0x70
        && b[8] === 0x4D && b[9] === 0x34 && b[10] === 0x41) return { mime: "audio/mp4", inline: 0, audio: 1 };
    return null;   // refused
  }
  const AUDIO_MAX = 3 * 1024 * 1024;   // ~3 minutes of opus — a voice note, not a podcast
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
    if (!sniff) return { ok: false, error: "only images (png, jpeg, gif, webp), .txt files and voice notes can be shared here" };
    if (sniff.audio && buf.length > AUDIO_MAX) return { ok: false, error: "voice notes cap at 3 MB — keep it under ~3 minutes" };
    const id = crypto.randomBytes(16).toString("hex");
    try {
      fs.mkdirSync(fileDir, { recursive: true });
      const tmp = path.join(fileDir, id + ".tmp");
      fs.writeFileSync(tmp, buf);
      fs.renameSync(tmp, path.join(fileDir, id));
    } catch (_) { return { ok: false, error: "could not store that file" }; }
    // The row is what the sweeper sees: a throw here (a STRICT type error on an odd threadId) used
    // to strand up to 8 MB on disk forever.
    try { S.fileIns.run(id, Math.trunc(+threadId), uid, fileNameClean(name), sniff.mime, buf.length, sniff.inline, Date.now()); }
    catch (_) { try { fs.unlinkSync(path.join(fileDir, id)); } catch (_) {} return { ok: false, error: "could not store that file" }; }
    return { ok: true, file: S.fileById.get(id) };
  }
  // ---- retention --------------------------------------------------------------------------------
  // Messages age out: 30 days in a 1-to-1, 7 in groups and topics — rows and attachment bytes,
  // actually deleted, not hidden. PINNED messages are exempt, or every board's standing post would
  // self-destruct in a week; unpinning re-enters a message into its window. Note the calls record
  // reads live messages, so a stamped call only counts while its message is retained.
  const RETAIN_DM_MS = 30 * 86400e3, RETAIN_GROUP_MS = 7 * 86400e3;
  function sweepRetention(nowOpt) {
    const now = Number.isFinite(+nowOpt) ? +nowOpt : Date.now();
    const rows = S.retainSweep.all(now - RETAIN_DM_MS, now - RETAIN_GROUP_MS);
    if (!rows.length) return 0;
    db.exec("BEGIN IMMEDIATE");
    try {
      for (const r of rows) { S.reactPurge.run(r.id); S.tgMapPurge.run(r.id); S.retainDrop.run(r.id); }
      db.exec("COMMIT");
    } catch (e) { try { db.exec("ROLLBACK"); } catch (_) {} return 0; }
    // File bytes go after the rows are committed gone — a crash mid-sweep leaves an orphaned file
    // for the abandoned-upload sweeper, never a message pointing at deleted bytes.
    for (const r of rows) if (r.fileId) removeFile(r.fileId);
    return rows.length;
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
  // A reply carries a one-level preview of what it quotes, resolved at read: the quote renders
  // without a second fetch, and a quoted message later deleted honestly says so instead of
  // resurrecting its text.
  function replyPreview(id, uid) {
    const q = S.msgById.get(+id);
    if (!q) return null;
    // The viewer's cleared floor applies to the quote too: history, sync, search and export all
    // honor clearedUpTo, and a reply must not resurrect a body its reader chose to forget.
    const cf = uid ? ((S.readGet.get(q.thread, uid) || {}).clearedUpTo || 0) : 0;
    const gone = !!q.deletedAt || q.id <= cf;
    return { id: q.id, senderUid: q.sender || null,
      sender: q.sender ? ((users.get(q.sender) || {}).display || "—") : "",
      body: gone ? "" : (q.cmd ? "▸ " + q.cmd : String(q.body || (q.fileId ? "sent a file" : ""))).slice(0, 120),
      ref: gone ? null : (q.ref || null), deleted: gone };
  }
  const cardParse = (j) => { try { const c = JSON.parse(j); return c && typeof c === "object" ? c : null; } catch (_) { return null; } };
  // ---- the call lifecycle (build 2026.09.22-88) ----------------------------------------------------
  // A call is open from the moment it is stamped until its HORIZON — seven days by default, or the
  // number of days written after the ticker ("$HOOD 30d") — at which point the first daily close
  // at or past the horizon becomes its final score and it stops moving with the mark. The author
  // may close it early at the live mark, or extend it while it is still open. Before this, a call
  // was scored live forever and the record read as a lifetime of moving numbers.
  const CALL_DAY = 86400e3, CALL_DEFAULT_H = 7 * CALL_DAY, CALL_MAX_D = 365;
  const callHorizonOf = (m) => (m.callH > 0 ? m.callH : CALL_DEFAULT_H);
  // "$HOOD 30d" → 30 days; only when the word sits right after the ticker, so "$HOOD ran 3d in a
  // row" stays prose. Bounded: a horizon past a year is a thesis, not a call.
  const callHorizonFromText = (text, sym) => callRead(text, sym).horizonMs;
  // The state of one stamped row, decided at read: closed early (closedAt/closePx on the row), or
  // closed at the horizon once that daily close has printed, or open with the close still ahead.
  function callState(m) {
    if (!m || !m.ref || !(m.refPx > 0)) return null;
    const h = callHorizonOf(m), hzTs = m.ts + h;
    if (m.closedAt) return { closed: true, early: true, closeTs: m.closedAt, closePx: m.closePx > 0 ? m.closePx : null, horizonMs: h };
    // A resolved target (build 2026.09.24-95) closed where it resolved: at the target (hit), at the
    // stop (wrong) or at the deadline's close (miss). Only the resolver writes these; until it has,
    // a target past its deadline reads exactly as a plain call at its horizon — the same close.
    if (m.tgRes === "hit" || m.tgRes === "wrong" || m.tgRes === "miss")
      return { closed: true, early: false, closeTs: m.tgAt || hzTs, closePx: m.closePx > 0 ? m.closePx : null, horizonMs: h };
    const p = pxHistory(m.ref, hzTs);
    if (p != null && isFinite(p) && p > 0) return { closed: true, early: false, closeTs: hzTs, closePx: p, horizonMs: h };
    return { closed: false, early: false, closeTs: hzTs, closePx: null, horizonMs: h };
  }
  const callAdj = (m, px) => (px > 0 && m.refPx > 0 ? ((m.side === "short" ? -1 : 1) * (px / m.refPx - 1)) : null);
  function callWire(m) {
    const st = callState(m);
    if (!st) return null;
    return { h: Math.round(st.horizonMs / CALL_DAY), closed: st.closed, early: st.early, closeTs: st.closeTs, closePx: st.closePx,
      final: st.closed ? callAdj(m, st.closePx) : null, tg: tgWire(m) };
  }
  // ---- call targets (build 2026.09.24-95) --------------------------------------------------------
  // "$INTC to 32 by Oct 15, wrong under 27": a call with more said. Same row, same stamp, same
  // record — the target, its optional stop and its resolution are three more columns beside the
  // lifecycle, and the lifecycle's horizon IS the deadline (extend moves it; close early resolves
  // it as 'early', which is neither a hit nor a miss). The wire carries the level, the stop, the
  // deadline and the resolution; progress and time used are derived at read, on the client, from
  // the same sent/now marks the stamp already shows — nothing that moves is stored.
  function tgWire(m) {
    if (!(m.tgPx > 0)) return null;
    return { px: m.tgPx, stop: m.tgStop > 0 ? m.tgStop : null, by: m.ts + callHorizonOf(m), res: m.tgRes || null, at: m.tgAt || null };
  }
  // bars5m(coin, fromTs, toTs) -> [[ts, o, h, l, c, ...]] is injected by the server (the 5m
  // archive the level scanner and the sweep detector already read); this module never opens it.
  let bars5m = options.bars5m || (() => []);
  function setBarSource(fn) { if (typeof fn === "function") bars5m = fn; }
  const TG_BAR_MS = 5 * 60e3, TG_SCAN_MS = 3 * CALL_DAY, TG_SCAN_PASS = 10;
  const tgTk = (ref) => String(ref || "").replace(/^xyz:/, "");
  // Session names (build 2026.09.24-104): the ET-anchored xyz roster — US equities, indices and the
  // rest the gap engine anchors on the US session. Crypto (main dex) and a foreign-home listing
  // (KRX/TSE/HKEX/SSE — its cash session is not the US one) keep 24:00 UTC and any touch.
  const tgSessionRule = (ref) => /^xyz:/.test(String(ref || "")) && !homeMkt(tgTk(ref), "xyz");
  const tgNum = (v) => String(+(+v).toPrecision(6));
  const tgDay = (ts) => { try { return new Date(ts).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" }); } catch (_) { return ""; } };
  const tgPct = (v) => (v >= 0 ? "+" : "\u2212") + Math.abs(v * 100).toFixed(1) + "%";
  // The line a resolution posts under its author's name — hit, wrong or missed, with the numbers
  // that make it checkable: where it was sent, where it closed, the raw move, and for a miss how
  // much of the way it got (the % record gives partial credit; the binary record never does).
  function tgLine(m, res, at, px) {
    const tk = "$" + tgTk(m.ref), short = m.side === "short", raw = px / m.refPx - 1;
    const sent = "sent " + tgNum(m.refPx) + " on " + tgDay(m.ts);
    if (res === "hit") {
      const early = Math.floor((m.ts + callHorizonOf(m) - at) / CALL_DAY);
      return "\ud83c\udfaf " + tk + (short ? " short" : "") + " hit " + tgNum(m.tgPx) + " \u2014 target reached"
        + (early >= 1 ? " " + early + " day" + (early === 1 ? "" : "s") + " early" : " on its last day") + " \u00b7 " + sent + ", " + tgPct(raw) + " \u00b7 the call closed at the target";
    }
    if (res === "wrong")
      return "\u2717 " + tk + (short ? " short" : "") + " wrong \u2014 " + tgNum(m.tgStop) + " printed before " + tgNum(m.tgPx) + " \u00b7 " + sent
        + " \u00b7 closed at the stop, " + tgPct(raw) + (callAdj(m, px) < 0 ? " against" : "");
    const got = Math.max(0, Math.min(1, (px - m.refPx) / (m.tgPx - m.refPx)));
    return "\u231b " + tk + (short ? " short" : "") + " missed " + tgNum(m.tgPx) + " \u2014 the " + tgDay(m.ts + callHorizonOf(m)) + " deadline passed at " + tgNum(px)
      + ", " + Math.round(got * 100) + "% of the way \u00b7 " + sent + " \u00b7 closed at the deadline\u2019s close, " + tgPct(raw);
  }
  // The resolver. Hits are intraday and misses are at the close: a target is a LEVEL, and levels
  // are touched, not closed through — so a hit (or the stop) is decided on the 5-minute bars that
  // opened after the send and before the deadline, then on the live mark for the bar still
  // forming; the deadline is a DATE, and dates end at the close, so a miss waits for the first
  // daily close at or past it (the same close a plain call's horizon reads). A bar that touches
  // both the stop and the target cannot say which printed first; it resolves 'wrong', the reading
  // that does not flatter the author. The bar cursor (tgSeen) makes a sweep O(new bars), and the
  // archive makes a restart lose nothing: bars printed while the server was down are scanned on
  // the next pass. Returns what resolved, with the line to post; the server posts it (the /alert
  // road: a command result under the author's name, in the conversation the call was made in).
  // (build 2026.09.24-107) The 5m lane stores CLOSED bars only and visits a coin every 5 minutes
  // at best (15 on backoff), so for a while after the deadline the archive can still lack the bars
  // that close at it. A miss (and the scan's "nothing touched") holds until the archive holds a bar
  // ending at or past the deadline, or TG_BELL_GRACE (two lane stale windows) has passed.
  const TG_BELL_GRACE = 20 * 60e3;
  function tgOpenAll() {
    const rows = [];
    for (let after = 0; ;) {
      const page = S.tgOpen.all(after);
      rows.push(...page);
      if (page.length < 500) return rows;
      after = page[page.length - 1].id;
    }
  }
  function targetSweep(nowMs) {
    const now = Number.isFinite(+nowMs) ? +nowMs : Date.now();
    const out = [];
    for (const m of tgOpenAll()) {
      const long = m.side !== "short", by = m.ts + callHorizonOf(m), upTo = Math.min(now, by);
      const stop = m.tgStop > 0 ? m.tgStop : null, sr = tgSessionRule(m.ref);
      let res = null, at = null, px = null, seen = m.tgSeen || 0;
      // The archive is read in TG_SCAN_MS windows, at most TG_SCAN_PASS of them per target per
      // pass, so a year-long target first scanned after an outage costs a month of bars a minute
      // rather than 100k rows at once. The live and deadline legs wait until the scan has caught
      // up: neither may overrule a bar not yet read.
      let caughtUp = false;
      for (let k = 0; k < TG_SCAN_PASS && !res && !caughtUp; k++) {
        // A window that would end inside the last day takes the rest of the way at once (it is at
        // most a day of bars), so the cursor rule below never has to wait on a young stretch.
        let scanTo = Math.min(upTo, Math.max(m.ts, seen) + TG_SCAN_MS);
        if (scanTo > now - CALL_DAY) scanTo = upTo;
        caughtUp = scanTo >= upTo;
        let bars;
        try { bars = bars5m(m.ref, Math.max(m.ts, seen + 1), scanTo) || []; } catch (_) { bars = []; }
        const ses = sr && bars.length ? marketSessions(Math.max(m.ts, seen + 1), scanTo) : null;
        for (const b of bars) {
          const ts = +b[0], hi = +b[2], lo = +b[3];
          // Only bars that OPENED after the send: the bar the call was sent inside carries prices
          // from before it. The live-mark leg below covers that sliver.
          if (!(ts >= m.ts) || ts <= seen || ts > scanTo || !(hi > 0) || !(lo > 0)) continue;
          // (build 2026.09.24-104) Session names: a touch counts in the US cash session, off-hours
          // only a 5m CLOSE through the level — so an off-hours bar is judged once it has closed.
          if (sr && ts + TG_BAR_MS > now && !inCashSession(ts, ses)) continue;
          if (stop != null && callBarReaches(b, stop, !long, sr, ses)) { res = "wrong"; at = ts; px = stop; break; }
          if (callBarReaches(b, m.tgPx, long, sr, ses)) { res = "hit"; at = ts; px = m.tgPx; break; }
          if (ts + TG_BAR_MS <= now) seen = ts;
        }
        // A stretch the archive has nothing for (a coin the 5m lane does not keep, a gap) is
        // passed once scanned — it is over a day old by construction, and the lane would have
        // written it by then — so the cursor never sticks.
        if (!res && !caughtUp) seen = Math.max(seen, scanTo);
      }
      // The live mark is an unclosed bar: for a session name it only counts inside the cash session
      // (off-hours the closed 5m bars decide, a minute later at most).
      if (!res && caughtUp && now <= by && (!sr || inCashSession(now, marketSessions(now, now)))) {
        const live = markFor(m.ref);
        if (live > 0) {
          if (stop != null && (long ? live <= stop : live >= stop)) { res = "wrong"; at = now; px = stop; }
          else if (long ? live >= m.tgPx : live <= m.tgPx) { res = "hit"; at = now; px = m.tgPx; }
        }
      }
      if (!res && caughtUp && now > by) {
        // (build 2026.09.24-107) The bell bar must be in the archive before the scan counts as
        // complete — else hold (bounded by TG_BELL_GRACE).
        let bell = now > by + TG_BELL_GRACE;
        if (!bell) { let bs; try { bs = bars5m(m.ref, by - TG_BAR_MS, now) || []; } catch (_) { bs = []; }
          for (const b of bs) if (+b[0] + TG_BAR_MS >= by) { bell = true; break; } }
        // A session name's deadline IS a cash close: the miss prices at the close of the 5m bar
        // ending at it (the tape at the bell; the last one before it only across an archive gap),
        // else the first daily close past it as before.
        if (bell) {
          let p = null;
          if (sr) { let bs; try { bs = bars5m(m.ref, by - 6 * 3600e3, by) || []; } catch (_) { bs = []; }
            let bt = -Infinity;
            for (const b of bs) if (+b[0] + TG_BAR_MS <= by && +b[0] > bt && +b[4] > 0) { bt = +b[0]; p = +b[4]; } }
          if (!(p > 0)) p = pxHistory(m.ref, by);
          if (p != null && isFinite(p) && p > 0) { res = "miss"; at = by; px = p; }
        }
      }
      if (res) {
        if (S.tgResolve.run(res, at, px, m.id).changes)
          out.push({ id: m.id, thread: m.thread, sender: m.sender, ref: m.ref, side: long ? "long" : "short", res, at, px, text: tgLine(m, res, at, px) });
      } else if (seen > (m.tgSeen || 0)) S.tgSeenSet.run(seen, m.id);
    }
    return out;
  }
  function callClose(uid, id) {
    const m = S.msgById.get(+id);
    if (!m || m.sender !== uid) return { ok: false, error: "that isn't your call" };
    if (!m.ref || !(m.refPx > 0)) return { ok: false, error: "that message carries no call" };
    if (m.deletedAt) return { ok: false, error: "that message was deleted — its call runs to its horizon" };
    const st = callState(m);
    if (st.closed) return { ok: false, error: st.early ? "already closed" : "that call closed at its horizon" };
    const px = markFor(m.ref);
    if (!(px > 0)) return { ok: false, error: "no live mark for " + m.ref + " right now" };
    const now = Date.now();
    S.callClose.run(now, px, now, +id, uid);
    return { ok: true, thread: m.thread, message: wire(S.msgById.get(+id), uid) };
  }
  function callExtend(uid, id, days) {
    const m = S.msgById.get(+id);
    if (!m || m.sender !== uid) return { ok: false, error: "that isn't your call" };
    if (!m.ref || !(m.refPx > 0)) return { ok: false, error: "that message carries no call" };
    if (m.deletedAt) return { ok: false, error: "that message was deleted — its call runs to its horizon" };
    const d = Math.trunc(+days);
    if (!(d >= 1 && d <= CALL_MAX_D)) return { ok: false, error: "a horizon is 1 to " + CALL_MAX_D + " days" };
    const st = callState(m);
    if (st.closed) return { ok: false, error: st.early ? "already closed" : "that call closed at its horizon" };
    // Extend means extend: a shorter horizon would re-score the call against a close it has
    // already lived past. Shortening is what "close early" is for.
    // (build 2026.09.24-107) A session name's TARGET ends at a cash close, extended or not: the
    // new deadline is the close of the day d days after the send (not the send's minute of day).
    if (d * CALL_DAY <= st.horizonMs) return { ok: false, error: "that is not longer than the current " + Math.round(st.horizonMs / CALL_DAY) + "-day horizon" };
    const hzTs = m.tgPx > 0 && tgSessionRule(m.ref) ? callSessionClose(m.ts + d * CALL_DAY) : m.ts + d * CALL_DAY;
    if (hzTs - m.ts <= st.horizonMs) return { ok: false, error: "that is not longer than the current " + Math.round(st.horizonMs / CALL_DAY) + "-day horizon" };
    const p = pxHistory(m.ref, hzTs);
    if (p != null && isFinite(p) && p > 0) return { ok: false, error: "a " + d + "-day horizon has already passed for this call" };
    S.callSetH.run(hzTs - m.ts, +id, uid);
    return { ok: true, thread: m.thread, message: wire(S.msgById.get(+id), uid) };
  }
  const modName = (uid) => (uid ? ((users.get(uid) || {}).display || uid) : null);
  function wire(m, uid) {
    return { id: m.id, thread: m.thread, mine: m.sender === uid,
      replyTo: m.replyTo || null, reply: m.replyTo ? replyPreview(m.replyTo, uid) : null,
      tweet: (m.deletedAt || m.sys) ? null : tweetFor(m.body, m.thread),
      senderUid: m.sender || null,
      sender: m.sender ? ((users.get(m.sender) || {}).display || "—") : "",
      ts: m.ts, body: m.deletedAt ? "" : m.body,
      ref: m.ref || null, refPx: m.refPx == null ? null : m.refPx,
      side: m.side || null,
      px: m.ref ? markFor(m.ref) : null,          // live mark, derived at read — never stored
      edited: !!m.editedAt, deleted: !!m.deletedAt,
      // Moderation leaves a name on the row: "edited by gus" / "removed by gus" / "call removed
      // by gus" — the operator who did it, never a bare "the operator". A person whose message
      // was changed by somebody else is owed the who as much as the fact.
      editedBy: modName(m.editedBy), deletedBy: modName(m.deletedBy), callDropped: modName(m.callDroppedBy),
      sys: m.sys || null, via: m.via || null, pinned: !!m.pinnedAt,
      // A command result names the command it answers and which engine answered it. The client
      // renders the pair as a monospace block under a "▸ cmd" header with a computed/AI badge —
      // the same two badges the terminal panel wears, so a reader knows what to trust.
      cmd: m.cmd || null, cmdAi: !!m.cmdAi,
      // A shared screener card (build 2026.09.21-84): the client renders it from the JSON; the
      // body is its text rendering, which is what search, export and the phone read.
      card: (m.deletedAt || !m.card) ? null : cardParse(m.card),
      // The call's lifecycle: horizon in days, open or closed (early or at the horizon), the
      // close price and the final direction-adjusted result. Survives a delete: the stamp stands.
      call: m.ref ? callWire(m) : null,
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
    // A terminal command's output, posted into the conversation (build 2026.09.11-69). The command
    // travels as its own short field rather than a "▸ top funding" first line of the body, so the
    // renderer, the digest and an export can all tell a computed table from prose without parsing
    // it back out. Capped hard: it is a label, and a label that needs 4000 characters is a body.
    const cmd = o.cmd == null ? null : cleanBody(String(o.cmd)).replace(/\s+/g, " ").trim().slice(0, DM_CMD_MAX) || null;
    const cmdAi = cmd && o.cmdAi ? 1 : null;
    // A card arrives already validated (compute.validateCard, at the route) and is stored as
    // JSON beside its text body. It never carries a command or a quote.
    const cardJson = o.card && typeof o.card === "object" ? JSON.stringify(o.card) : null;
    // A command result quotes nothing (it is the board's output under the sender's name, not a
    // reply) but MAY carry an attachment: /ratio posts its chart as a PNG. replyTo is dropped
    // rather than erred — the client never sends it.
    const file = o.fileId ? S.fileById.get(o.fileId) : null;
    // (build 2026.09.24-107) A named attachment that does not exist is refused, not dropped: a chart
    // card with a bogus fileId used to post as a caption with no picture under it.
    if (o.fileId && !file) return { ok: false, error: "that attachment is no longer stored" };
    if (!text && !file) return { ok: false, error: "write something first" };
    if (file && (file.thread !== t.id || file.uid !== fromUid)) return { ok: false, error: "that attachment is not yours" };
    if (o.card && o.card.kind === "chart" && !(file && file.inline && /^image\//.test(String(file.mime || ""))))
      return { ok: false, error: "a chart card needs its picture (an image uploaded into this conversation)" };
    if (S.msgBurst.get(fromUid, Date.now() - DM_BURST_MS).n >= DM_BURST_N)
      return { ok: false, error: "slow down — too many messages at once", retry: true };

    // No price stamp on a command result. The stamp is a CALL — "I said this at 113.90" — and a
    // screen dump or an AI paragraph that happens to spell $NVDA is nobody's call; stamping it
    // would seed the calls record with rows nobody made.
    // A card names its ticker outright, so the stamp comes from that name when the sender asked
    // for it ("quote as a call"), never from a $WORD scan over a table of numbers.
    const sym = cmd ? null : (cardJson ? (o.stampSym ? String(o.stampSym) : null) : firstTickerRef(text));
    let ref = null, refPx = null, side = null;
    if (sym) {
      // No resolver (the Telegram bridge path) means NO stamp — falling back to the raw symbol
      // stamped every bridged $WORD as an unresolvable ref that sat in the calls record as a
      // permanent dead row with no price and no live mark.
      const coin = coinResolve ? coinResolve(sym) : null;
      if (coin) { ref = coin; const px = markFor(coin); refPx = Number.isFinite(px) && px > 0 ? px : null;
        // An explicit reading from the sender (the composer's applied AI chip) beats the words —
        // it is still the sender's choice, made before the send, and still bounded here.
        side = o.callSide === "short" || o.callSide === "long" ? o.callSide : callSide(text, sym); }
    }
    // A quote binds only inside its own conversation: a replyTo naming another thread's message is
    // dropped, not erred — the message still says what it says without the quote.
    let replyTo = null;
    if (o.replyTo != null && !cmd && !cardJson) {
      const rm = S.msgById.get(+o.replyTo);
      if (rm && rm.thread === t.id && !rm.sys && !rm.deletedAt) replyTo = rm.id;
    }
    const now = Date.now();
    const oDays = Math.trunc(+o.callDays);
    // A target (build 2026.09.24-95) is read off the same words, against the same stamped mark, and
    // only on a typed message — a card's body is a table, not a sentence. Its deadline becomes the
    // horizon and its side the call's side (an applied reading still decides the side, and a
    // target that disagrees with it is dropped). Anything the grammar cannot read, or reads and
    // refuses, stays a plain call: never a wrong target.
    // (build 2026.09.24-104) A DATE deadline ends at that date's US cash close for a session name
    // (24:00 UTC for crypto) — exact, not rounded up to whole days from the send.
    // (build 2026.09.24-107) callTarget decides it (`by`): a date whose close already passed is
    // refused (the send stays a plain call) instead of becoming a silent one-day horizon, and a
    // relative "in 3w" on a session name ends at that day's cash close.
    const tg = ref && sym && refPx > 0 && !cardJson ? callTarget(text, sym, refPx, now, o.callSide === "short" || o.callSide === "long" ? o.callSide : null, tgSessionRule(ref)) : null;
    const tgOk = tg && tg.ok ? tg : null;
    if (tgOk) side = tgOk.side;
    const callH = ref && sym ? (tgOk ? tgOk.by - now : oDays >= 1 && oDays <= CALL_MAX_D ? oDays * CALL_DAY : callHorizonFromText(text, sym)) : null;
    const id = Number(S.msgIns.run(t.id, fromUid, now, text, ref, refPx, side, null, file ? file.id : null, o.via || null, replyTo, cmd, cmdAi, cardJson, callH,
      tgOk ? tgOk.px : null, tgOk ? tgOk.stop : null).lastInsertRowid);
    S.thrTouch.run(id, now, t.id);
    S.readUp.run(t.id, fromUid, id);            // your own message is read by definition
    return { ok: true, id, thread: t.id, message: wire(S.msgById.get(id), fromUid) };
  }

  // Moderation (build 2026.09.23-94): `asAdmin` lets the operator edit or delete ANYBODY's
  // message, in any conversation — the same reach the read-through already grants, and gated at
  // the route the same way. The row keeps the operator's name (the room sees "edited by gus"),
  // the act lands in the audit log with what the words were, and the author's own path is
  // untouched: an operator acting on their own message is just an author.
  function edit(uid, id, body, asAdmin) {
    const m = S.msgById.get(+id);
    const mod = !!asAdmin && !!m && m.sender !== uid;
    if (!m || (m.sender !== uid && !mod) || m.sys) return { ok: false, error: "that isn't your message" };
    if (m.deletedAt) return { ok: false, error: "that message was deleted" };
    // A command result is the board's output under your name, not your prose: rewording it would
    // put a "computed" badge on words nobody computed. Delete it and run the command again.
    if (m.cmd) return { ok: false, error: "a command result can't be edited — delete it and run the command again" };
    if (m.card) return { ok: false, error: "a shared card can't be edited — delete it and share again" };
    const text = cleanBody(body);
    if (!text) return { ok: false, error: "write something first" };
    // The stamp is immutable under an edit — exactly what the composer promises ("the original
    // timestamp and price stamp stand"). The old code re-derived ref from the rewritten body:
    // editing the ticker out silently removed the call from the record (and stranded refPx on a
    // ref-less row), while editing an unresolved $WORD in stamped a raw symbol as a dead ref.
    if (mod) {
      S.msgEditAdm.run(text, Date.now(), uid, +id);
      adminAudit(uid, "edit-message", m.thread, modName(m.sender) + ": “" + m.body.slice(0, 64) + "” → “" + text.slice(0, 64) + "”");
    } else S.msgEdit.run(text, m.ref || null, Date.now(), +id, uid);
    return { ok: true, thread: m.thread, moderated: mod || undefined, message: wire(S.msgById.get(+id), uid) };
  }
  function drop(uid, id, asAdmin) {
    const m = S.msgById.get(+id);
    const mod = !!asAdmin && !!m && m.sender !== uid;
    if (!m || (m.sender !== uid && !mod) || m.sys) return { ok: false, error: "that isn't your message" };
    if (m.deletedAt) return { ok: false, error: "that message was already deleted" };
    // Tombstone the ROW, never delete it: the id is a cursor position on the other side, and
    // removing it would make their next sync silently skip a beat. The ATTACHMENT is a different
    // matter — it must actually go, row and bytes, or "delete" is a rendering change and anyone who
    // still holds the id can keep downloading it.
    if (mod) {
      S.msgDropAdm.run(Date.now(), uid, +id);
      adminAudit(uid, "delete-message", m.thread, modName(m.sender) + ": “" + (m.cmd ? "▸ " + m.cmd : m.body).slice(0, 64) + "”");
    } else S.msgDrop.run(Date.now(), +id, uid);
    removeFile(m.fileId);
    return { ok: true, thread: m.thread, moderated: mod || undefined, message: wire(S.msgById.get(+id), uid) };
  }
  // Strike a call from the record altogether (build 2026.09.23-94). The record is delete-proof
  // against its AUTHOR by design — deleting the message keeps the stamp — so this is the one
  // door, and it is the operator's: a mis-stamped $WORD, a joke that resolved to a real ticker,
  // a row somebody asked to have taken down. The words stay (deleted or not); the stamp, its
  // side, its horizon and any early close go, so the row leaves the board, the summary and the
  // digest at once. Irreversible, and audited with what was struck.
  function callDrop(uid, id, asAdmin) {
    if (!asAdmin) return { ok: false, error: "operator only" };
    const m = S.msgById.get(+id);
    if (!m || m.sys) return { ok: false, error: "no such message" };
    if (!m.ref || !(m.refPx > 0)) return { ok: false, error: "that message carries no call" };
    const st = callState(m);
    S.callDrop.run(uid, +id);
    adminAudit(uid, "delete-call", m.thread, "$" + m.ref + " " + (m.side === "short" ? "short" : "long") + " @ " + m.refPx
      + (st && st.closed ? " (closed)" : " (open)") + " by " + modName(m.sender) + (m.deletedAt ? " (message deleted)" : ""));
    return { ok: true, thread: m.thread, message: wire(S.msgById.get(+id), uid) };
  }

  // ---- reading ----------------------------------------------------------------------------------
  function threadInfo(t, uid) {
    const rd = S.readGet.get(t.id, uid) || { readMsgId: 0, muted: 0 };
    const last = S.msgLast.get(t.id);
    const mem = S.memOf.all(t.id);
    const me = S.memGet.get(t.id, uid);
    // A preview of text this viewer cleared would un-forget it in the rail.
    const preview = (last && last.id > (rd.clearedUpTo || 0))
      ? (last.sys ? sysLine(last) : last.deletedAt ? "message deleted"
        // A command result previews as the command: "▸ top funding 5" says what happened; the
        // first 90 characters of a padded table say nothing at rail width.
        : last.cmd ? "▸ " + last.cmd
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
      lastAt: t.lastAt, muted: !!rd.muted, boardNotify: !!rd.boardNotify, tgSync: !!rd.tgSync,
      // What the OTHER side has read, so "did my call land" is answerable. The data was already
      // being stored for unread counts; showing it costs a lookup.
      // One query for the whole thread's read cursors, not one per member: threads() runs this
      // for every thread on every sync, and a 50-member board was fifty statements a thread.
      seen: (() => { const rd2 = new Map(S.readAllOf.all(t.id).map((r) => [r.uid, r.readMsgId]));
        return mem.filter((x) => x.uid !== uid).map((x) => ({
          uid: x.uid, handle: (users.get(x.uid) || {}).display || "—", readMsgId: rd2.get(x.uid) || 0 })); })(),
      pins: S.pinsCount.get(t.id).n,
      unread: S.msgUnread.get(t.id, Math.max(rd.readMsgId || 0, rd.clearedUpTo || 0), uid).n,
      // Closed for this viewer: off the rail until a newer message id passes the watermark.
      hidden: (rd.hiddenUpTo || 0) > 0 && (rd.hiddenUpTo || 0) >= (t.lastMsgId || 0),
      // The viewer's own read watermark, so the client can draw the "new messages" line exactly
      // where they left off rather than guessing from the unread count.
      myRead: rd.readMsgId || 0,
      preview: String(preview).slice(0, 90),
    };
  }
  const sysLine = (m) => {
    const who = (users.get(m.sender) || {}).display || "someone";
    if (m.sys === "created") return who + " created “" + m.body + "”";
    if (m.sys === "added") return who + " added " + m.body;
    if (m.sys === "removed") return who + " removed " + m.body;
    if (m.sys === "left") return m.body + " left";
    if (m.sys === "joined") return m.body + " joined";
    if (m.sys === "renamed") return who + " renamed this to “" + m.body + "”";
    return "";
  };
  // Hidden (closed) threads STAY in the list, flagged — the client folds them into a "closed"
  // section with a reopen, because a closed group has no other road back: nobody can re-open it
  // from a picker the way a 1-to-1 reappears when you message the person again.
  function threads(uid) { return S.thrMine.all(uid).map((t) => threadInfo(t, uid)); }

  function history(uid, threadId, before, limit) {
    const t = S.thrById.get(+threadId);
    if (!t || !isMember(t.id, uid)) return { ok: false, error: "no such conversation" };
    const b = Number.isFinite(+before) && +before > 0 ? +before : Number.MAX_SAFE_INTEGER;
    const n = Math.trunc(Math.min(Math.max(+limit || 50, 1), 200));
    const cf = (S.readGet.get(t.id, uid) || {}).clearedUpTo || 0;
    const rows = S.msgPage.all(t.id, b, cf, n).reverse().map((m) => wire(m, uid));
    return { ok: true, thread: t.id, info: threadInfo(t, uid), messages: rows,
      more: rows.length === n, cursor: S.msgMaxId.get().m };
  }

  // The SSE-triggered pull. One cursor across every thread the caller is in, which is why the
  // message id is global rather than per-thread: a single `since` answers "what did I miss".
  function sync(uid, since, limit) {
    const s = Number.isFinite(+since) && +since >= 0 ? +since : 0;
    const n = Math.trunc(Math.min(Math.max(+limit || 200, 1), 500));
    const out = [];
    for (const t of S.thrMine.all(uid)) {
      const cf = (S.readGet.get(t.id, uid) || {}).clearedUpTo || 0;
      // n+1, not n: a single thread holding exactly n new messages would otherwise fill the
      // slice without ever tripping the truncation check below.
      for (const m of S.msgSince.all(t.id, Math.max(s, cf), n + 1)) out.push(wire(m, uid));
    }
    out.sort((a, b) => a.id - b.id);
    // The cursor must never claim messages the slice dropped: advancing to the global max while
    // truncating meant everything past the Nth message was skipped forever ("the client's cursor
    // is authoritative" is only true if it is honest). When truncated, the cursor stops at the
    // last id actually delivered and `more` tells the client to come straight back for the rest.
    const truncated = out.length > n;
    const sliced = truncated ? out.slice(0, n) : out;
    return { ok: true,
      cursor: truncated ? sliced[sliced.length - 1].id : S.msgMaxId.get().m,
      more: truncated || undefined,
      messages: sliced, threads: threads(uid) };
  }

  // Search runs over the caller's own membership by JOIN, so the scope IS the authorization — there
  // is no thread id to tamper with. LIKE rather than FTS5: no extension dependency, and at a desk's
  // volume of messages the scan is far cheaper than the index would be to maintain.
  function search(uid, q, limit, threadId) {
    const raw = String(q == null ? "" : q).trim();
    if (raw.length < 2) return { ok: true, q: raw, results: [] };
    const esc = raw.replace(/[\\%_]/g, (c) => "\\" + c);
    const n = Math.trunc(Math.min(Math.max(+limit || 50, 1), 100));
    // An optional thread scope: the JOIN already guarantees membership, so scoping is a WHERE
    // clause, never a second authorization path.
    const th = Number.isFinite(+threadId) && +threadId > 0 ? +threadId : null;
    const rows = S.msgSearch.all(uid, th, th, "%" + esc + "%", n);
    return { ok: true, q: raw, results: rows.map((m) => {
      const t = S.thrById.get(m.thread);
      return Object.assign(wire(m, uid), { threadName: t ? threadName(t, uid) : "—", kind: t ? t.kind : "dm" });
    }) };
  }

  // ---- close & clear ----------------------------------------------------------------------------
  // Both are PER-VIEWER. Closing takes the row off YOUR rail until a newer message id passes the
  // watermark — talk to the same person later and the whole backscroll is right there. Clearing
  // forgets the backscroll for YOU alone: the other side keeps their record, and the operator
  // read-through still sees everything, which is this deployment's stated posture.
  function closeThread(uid, threadId) {
    const t = S.thrById.get(+threadId);
    if (!t || !isMember(t.id, uid)) return { ok: false, error: "no such conversation" };
    S.readHide.run(t.id, uid, t.lastMsgId || 0);
    return { ok: true, closed: t.id };
  }
  function reopenThread(uid, threadId) {
    const t = S.thrById.get(+threadId);
    if (!t || !isMember(t.id, uid)) return { ok: false, error: "no such conversation" };
    S.readHide.run(t.id, uid, 0);
    return { ok: true, reopened: t.id };
  }
  function clearHistory(uid, threadId) {
    const t = S.thrById.get(+threadId);
    if (!t || !isMember(t.id, uid)) return { ok: false, error: "no such conversation" };
    const last = t.lastMsgId || 0;
    S.readClearAll.run(t.id, uid, last, last, last);
    return { ok: true, cleared: t.id };
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
  // Boards default QUIET on Telegram — mentions and watched tickers only. This is the opt-in to
  // full digests, per member per board: a busy topic should not page the whole desk by default.
  function setBoardNotify(uid, threadId, on) {
    const t = S.thrById.get(+threadId);
    if (!t || t.kind !== "board" || !isMember(t.id, uid)) return { ok: false, error: "no such topic" };
    S.readBoardNotify.run(t.id, uid, on ? 1 : 0);
    return { ok: true, thread: t.id, boardNotify: !!on };
  }
  // ---- Telegram sync (build 2026.09.21-83) --------------------------------------------------------
  // A member's linked Telegram chat can MIRROR one conversation: every message posted here goes to
  // the chat as it happens (not the 5-minute offline digest), and plain text typed in the chat posts
  // here under their name. ONE conversation per member, by construction: a bot chat is a single
  // stream with no way to say which of several threads a bare line was meant for, and guessing
  // would post it under the sender's name somewhere they did not intend. Switching is a click.
  // The mirror's cursor is the same notifiedMsgId the escalation uses ("highest id already
  // delivered to Telegram"), so the two paths can never deliver the same message twice: what the
  // mirror sends the digest sees as handled, and vice versa. Enabling seeds the cursor at the
  // thread's current last id — sync starts from NOW; the backscroll is not replayed into the chat.
  function setTgSync(uid, threadId, on) {
    const t = S.thrById.get(+threadId);
    if (!t || !isMember(t.id, uid)) return { ok: false, error: "no such conversation" };
    db.exec("BEGIN IMMEDIATE");
    try {
      S.readSyncClear.run(uid);
      if (on) {
        S.readSync.run(t.id, uid);
        const last = (S.msgLast.get(t.id) || { id: 0 }).id;
        if (last) S.readNotified.run(t.id, uid, last);
      }
      db.exec("COMMIT");
    } catch (e) { try { db.exec("ROLLBACK"); } catch (_) {} return { ok: false, error: "could not change sync" }; }
    return { ok: true, thread: t.id, tgSync: !!on, name: threadName(t, uid), kind: t.kind };
  }
  // The conversation a member's chat mirrors, or 0. Membership is re-checked at read time so a
  // flag left behind by leaving a group (or being removed from one) is inert, never a back door.
  function tgSyncThread(uid) {
    const r = S.readSyncOf.get(uid);
    if (!r) return 0;
    const t = S.thrById.get(r.thread);
    return t && isMember(t.id, uid) ? t.id : 0;
  }
  // Every live (thread, member) mirror: the safety sweep's worklist.
  function tgSyncAll() {
    const out = [];
    for (const r of S.readSyncAll.all()) {
      const u = users.get(r.uid);
      if (!u || u.disabledAt) continue;
      const t = S.thrById.get(r.thread);
      if (t && isMember(t.id, r.uid)) out.push({ uid: r.uid, thread: t.id });
    }
    return out;
  }
  // Rows above this member's delivery cursor on the conversation they mirror, oldest first, with
  // the rendering already decided (sender name, system line, command header, attachment stub).
  // Bounded: a mirror that was unreachable for a day (chat blocked, quiet hours) catches up with
  // the LAST `limit` rows and a count of what it skipped, not a thousand Telegram messages.
  // The caller advances the cursor with markEscalated once the rows are actually enqueued.
  function mirrorRows(uid, threadId, limit) {
    const t = S.thrById.get(+threadId);
    if (!t || !isMember(t.id, uid)) return null;
    const rd = S.readGet.get(t.id, uid);
    if (!rd || !rd.tgSync) return null;
    const floor = Math.max(rd.notifiedMsgId || 0, rd.clearedUpTo || 0);
    const n = Math.trunc(Math.min(Math.max(+limit || 10, 1), 50));
    // upTo is the last row ABOVE the floor, deleted or not: a tombstone is handled by being
    // skipped, and a cursor that stopped short of one would re-read it on every sweep forever.
    const raw = S.msgSince.all(t.id, floor, 500);
    const all = raw.filter((m) => !m.deletedAt);
    if (!raw.length) return { thread: t.id, name: threadName(t, uid), kind: t.kind, rows: [], skipped: 0, upTo: 0 };
    const rows = all.slice(-n);
    return { thread: t.id, name: threadName(t, uid), kind: t.kind, skipped: all.length - rows.length,
      upTo: raw[raw.length - 1].id,
      rows: rows.map((m) => mirrorRow(m, uid)) };
  }
  // One row in the mirror's shape. The attachment rides as its id and sniffed type too (build
  // 2026.09.24-99): the mirror uploads the bytes to the chat rather than naming the file.
  function mirrorRow(m, uid) {
    const f = m.fileId && !m.deletedAt ? S.fileById.get(m.fileId) : null;
    return { id: m.id, sender: m.sender || "", mine: m.sender === uid, via: m.via || null,
      who: m.sender ? ((users.get(m.sender) || {}).display || "—") : "",
      sys: m.sys ? sysLine(m) : "",
      cmd: m.cmd || "", body: m.body || "", ref: m.ref || null, card: !!m.card,
      file: m.fileId ? ((f || {}).name || "attachment") : "",
      fileId: f ? f.id : null, fileMime: f ? f.mime : null, fileInline: f ? !!f.inline : false,
      edited: !!m.editedAt, editedBy: m.editedBy ? ((users.get(m.editedBy) || {}).display || "—") : "",
      deleted: !!m.deletedAt,
      reply: m.replyTo ? replyPreview(m.replyTo, uid) : null };
  }
  // ---- Telegram sync: edits, deletions, reactions, attachments (build 2026.09.24-99) ------------
  // The map from a message here to the Telegram message(s) carrying it, per chat. Written by the
  // wire once Telegram has answered a send with its message_id (out), or when a line typed at the
  // bot becomes a row (in). Read to repaint, delete or react on the other side.
  function tgMapAdd(chat, tgId, msgIds, uid, dir, media) {
    const id = Math.trunc(+tgId);
    if (!chat || !(id > 0)) return 0;
    let n = 0;
    for (const m of [].concat(msgIds || [])) {
      if (!(+m > 0)) continue;
      try { n += Number(S.tgMapIns.run(String(chat), id, Math.trunc(+m), String(uid || ""), dir === "in" ? "in" : "out", media ? 1 : 0, Date.now()).changes); } catch (_) {}
    }
    return n;
  }
  const tgMapFor = (msgId) => S.tgMapOfMsg.all(Math.trunc(+msgId) || 0);
  const tgMapPack = (chat, tgId) => S.tgMapOfTg.all(String(chat), Math.trunc(+tgId) || 0);
  // The rows one Telegram message carries, in the mirror's shape, deleted ones flagged rather than
  // dropped: the repaint decides whether the message shrinks or goes. Membership is re-checked —
  // a member removed from a group keeps their old chat, but it stops being repainted from here.
  function mirrorRowsById(uid, ids) {
    const out = [];
    for (const id of [].concat(ids || [])) {
      const m = S.msgById.get(+id);
      if (!m || !isMember(m.thread, uid)) continue;
      out.push(mirrorRow(m, uid));
    }
    return out;
  }
  // A file sent at the bot, into the synced conversation, through the SAME door the composer's
  // upload uses: the magic-byte sniff, the type allowlist and the 8 MB / 3 MB caps are putFile's,
  // not re-implemented for Telegram. A refused file posts nothing and says why.
  function bridgeSyncFile(uid, name, buf, caption) {
    const who = users.get(uid);
    if (!who || who.disabledAt) return { ok: false, error: "that chat is not linked to an account" };
    const thread = tgSyncThread(uid);
    if (!thread) return { ok: false, error: "not-synced", silent: true };
    const f = putFile(uid, thread, name, buf);
    if (!f.ok) return f;
    const r = send(uid, null, String(caption == null ? "" : caption).trim(), null, { thread, via: "telegram", fileId: f.file.id });
    if (!r.ok) removeFile(f.file.id);
    return r;
  }
  // An edit made in Telegram to a line that came in over the bridge. Only the member's OWN line,
  // found by the map (chat + Telegram id + 'in'), and through edit() itself: the same "not a
  // command result, not a card, not deleted" rules and the same editedAt the composer sets. An
  // edit to anything else in that chat (a /command, a line from before sync) is silently inert.
  function bridgeEdit(uid, chat, tgId, text) {
    // (build 2026.09.24-107) A disabled account acts through no door, the phone included.
    const who = users.get(uid);
    if (!who || who.disabledAt) return { ok: false, error: "that chat is not linked to an account" };
    const hit = tgMapPack(chat, tgId).find((x) => x.dir === "in" && x.uid === uid);
    if (!hit) return { ok: false, error: "not-mapped", silent: true };
    return edit(uid, hit.msg, text, false);
  }
  // A reaction change from Telegram, already translated into the site's vocabulary: the emoji the
  // member added and the ones they took away. Explicit add/drop rather than "set to exactly this",
  // because Telegram only knows the reactions made THERE — a set would wipe the ones made here.
  function reactApply(uid, msgId, add, dropList) {
    const who = users.get(uid);
    if (!who || who.disabledAt) return { ok: false, error: "that chat is not linked to an account" };   // (build 2026.09.24-107)
    const m = S.msgById.get(+msgId);
    if (!m || !isMember(m.thread, uid)) return { ok: false, error: "no such message" };
    if (m.deletedAt || m.sys) return { ok: false, error: "that message was deleted" };
    let changed = 0;
    for (const e of [].concat(dropList || [])) if (REACTIONS.includes(e) && S.reactMine.get(m.id, uid, e)) { S.reactDrop.run(m.id, uid, e); changed++; }
    for (const e of [].concat(add || [])) if (REACTIONS.includes(e) && !S.reactMine.get(m.id, uid, e)) { S.reactAdd.run(m.id, uid, e, Date.now()); changed++; }
    return { ok: true, thread: m.thread, id: m.id, changed };
  }
  // The one reaction a bot may show on a message: the most-used here, the most recent on a tie.
  // null when nothing (or nothing live) is left, which the wire turns into clearing the reaction.
  function reactTop(msgId) {
    const m = S.msgById.get(+msgId);
    if (!m || m.deletedAt) return null;
    const by = new Map();
    for (const r of S.reactOf.all(m.id)) {
      const e = by.get(r.emoji) || { n: 0, at: 0 };
      e.n++; e.at = Math.max(e.at, r.at || 0); by.set(r.emoji, e);
    }
    let best = null;
    for (const [emoji, e] of by) if (!best || e.n > best.n || (e.n === best.n && e.at > best.at)) best = { emoji, n: e.n, at: e.at };
    return best ? best.emoji : null;
  }
  // Plain text typed in a synced chat. Silent no-op when nothing is synced: stray text at the bot
  // has never posted anywhere, and an opt-in elsewhere must not change that for a chat that did
  // not opt in. `not-synced` lets the wire tell the two cases apart without replying to either.
  function bridgeSyncText(uid, text) {
    const who = users.get(uid);
    if (!who || who.disabledAt) return { ok: false, error: "that chat is not linked to an account" };
    const thread = tgSyncThread(uid);
    if (!thread) return { ok: false, error: "not-synced", silent: true };
    const raw = String(text == null ? "" : text).trim();
    if (!raw) return { ok: false, error: "nothing to send" };
    return send(uid, null, raw, null, { thread, via: "telegram" });
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

  // ---- synced UI prefs (watchlist, layouts) --------------------------------------------------------
  // The client stamps every write with ITS clock and the server keeps the newest stamp per key.
  // Clock skew between two devices costs at most one lost edit inside the skew window — the same
  // cost as two people editing a shared doc offline — and never a corrupted value.
  const PREF_KEYS = new Set(["watch", "layouts"]);
  const PREF_MAX = 64 * 1024;   // a watchlist is tens of coins, a layout list is a few KB
  function prefsGet(uid) {
    const out = {};
    for (const r of S.prefAll.all(uid)) { let v = null; try { v = JSON.parse(r.json); } catch (_) {} out[r.key] = { v, ts: r.ts }; }
    return out;
  }
  function prefsPut(uid, key, value, ts) {
    if (!PREF_KEYS.has(key)) return { ok: false, error: "unknown pref" };
    const stamp = Number(ts);
    if (!Number.isFinite(stamp) || stamp <= 0) return { ok: false, error: "bad stamp" };
    if (key === "watch") {
      if (!Array.isArray(value) || value.length > 500 || !value.every((c) => typeof c === "string" && c.length <= 32)) return { ok: false, error: "watch must be a short list of coins" };
    } else if (!value || typeof value !== "object" || Array.isArray(value) || !value.list || typeof value.list !== "object" || Array.isArray(value.list)
      || Object.keys(value.list).length > 50 || Object.keys(value.list).some((n) => n.length > 24)) return { ok: false, error: "layouts must be {list:{name:layout}}" };
    const json = JSON.stringify(value);
    if (json.length > PREF_MAX) return { ok: false, error: "too large" };
    const cur = S.prefOne.get(uid, key);
    if (cur && cur.ts >= stamp) return { ok: true, stored: false, ts: cur.ts };   // a stale write loses, quietly
    S.prefPut.run(uid, key, json, stamp);
    return { ok: true, stored: true, ts: stamp };
  }

  // ---- wallet (positions overlay) ------------------------------------------------------------------
  const walletGet = (uid) => S.walletGet.get(uid) || null;
  function walletSet(uid, addr, label) {
    const a = String(addr || "").trim();
    if (!/^0x[0-9a-fA-F]{40}$/.test(a)) return { ok: false, error: "that isn't an EVM address (0x + 40 hex)" };
    const l = String(label || "").trim().slice(0, 24);
    S.walletPut.run(uid, a.toLowerCase(), l || null, Date.now());
    return { ok: true, wallet: walletGet(uid) };
  }
  function walletDrop(uid) { S.walletDrop.run(uid); return { ok: true, wallet: null }; }
  const walletsAll = () => S.walletAll.all();   // a disabled account's wallet is not polled

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
    const n = Math.trunc(Math.min(Math.max(+o.limit || 200, 1), 500));
    const by = o.by || null;
    const rows = o.all ? S.callsAll.all(by, by, n) : S.callsMine.all(uid, by, by, n);
    // The caller's own cleared floor holds here exactly as it does in history/sync/search: a
    // member who cleared a thread must not get its stamped bodies re-delivered by the record.
    // The operator's all-view is the separate, audited read-through surface and stays unfiltered.
    const cfCache = new Map();
    const floor = (th) => { if (!cfCache.has(th)) cfCache.set(th, (S.readGet.get(th, uid) || {}).clearedUpTo || 0); return cfCache.get(th); };
    const out = [];
    const DAY = 86400e3;
    for (const m of rows) {
      if (!o.all && m.id <= floor(m.thread)) continue;
      const t = S.thrById.get(m.thread);
      const live = markFor(m.ref);
      const at = m.refPx;
      const has = at != null && isFinite(at) && at > 0;
      const ok = has && live != null && isFinite(live) && live > 0;
      // Direction-adjusted move: positive = the CALL is right. A short that falls 2% scores +2%.
      const side = m.side === "short" ? "short" : "long";
      const adjOf = (c) => (c == null ? null : (side === "short" ? -c : c));
      // Fixed horizons: the first daily close printed at/after t+1d and t+7d. Null while that
      // close is still in the future — "how is it doing" and "how did it do" are different
      // questions, and the horizon columns only ever answer the second.
      const hz = (msFwd) => { if (!has) return null;
        const p = pxHistory(m.ref, m.ts + msFwd);
        return p != null && isFinite(p) && p > 0 ? p / at - 1 : null; };
      const chg1 = hz(DAY), chg7 = hz(7 * DAY);
      // Lifecycle: an open call moves with the mark; a closed one is frozen at its close price,
      // and `chg`/`adj`/`px` read that close, so the row and the record stop drifting.
      const st = has ? callState(m) : null;
      const closed = !!(st && st.closed), endPx = closed ? st.closePx : (ok ? live : null);
      const chgNow = endPx > 0 ? endPx / at - 1 : null;
      out.push({
        id: m.id, thread: m.thread, ts: m.ts,
        senderUid: m.sender, sender: (users.get(m.sender) || {}).display || "—",
        threadName: t ? threadName(t, uid) : "—", kind: t ? t.kind : "dm",
        body: m.deletedAt ? "" : m.body, deleted: !!m.deletedAt,
        ref: m.ref, refPx: has ? at : null, px: endPx > 0 ? endPx : null, livePx: ok ? live : null, side,
        chg: chgNow, adj: adjOf(chgNow),
        chg1, adj1: adjOf(chg1), chg7, adj7: adjOf(chg7),
        closed, early: !!(st && st.early), closeTs: st ? st.closeTs : null, horizonD: st ? Math.round(st.horizonMs / DAY) : null,
        ageMs: Date.now() - m.ts,
        // A target (build 2026.09.24-95): the level, the stop, the deadline, the resolution, and how
        // far along it is — (end − sent) / (target − sent) against the same mark the move column
        // reads, clamped to [−1, 1]: the one number the board and the digest both print.
        tg: has && m.tgPx > 0 ? Object.assign(tgWire(m), { prog: endPx > 0 ? Math.max(-1, Math.min(1, (endPx - at) / (m.tgPx - at))) : null }) : null,
      });
    }
    // The summary is per person, because "who is right" is the only question a call record
    // answers — scored on the DIRECTION-ADJUSTED move. The headline record is the LIVE one (sent
    // price against the current mark: the same number the row's move column shows), and the
    // fixed 1d/7d yardsticks ride beside it as h1/h7 over the calls whose close has printed. The
    // first build scored the headline on the 1d close once it existed, which read as a
    // contradiction the moment it happened: two longs up 20% and 10% since sent showed as
    // "50% right, avg -0.2%" because both had dipped on their first daily close. A fixed horizon
    // is a fair yardstick for comparing people; it is not what "right" means to the person reading
    // the row, so it no longer replaces the live read — it sits next to it, labelled.
    // The RECORD is the closed calls (build 2026.09.22-88): a call counts once it has closed,
    // at its final result, inside `windowMs` when the caller gives one (the digest asks for the
    // last 30 days; the board reads the lifetime). Open calls are counted, not scored — "running"
    // is the honest word for a number that is still moving. The fixed 1d/7d yardsticks stay
    // beside it over every call whose close has printed.
    const winMs = Number.isFinite(+o.windowMs) && +o.windowMs > 0 ? +o.windowMs : null;
    const nowTs = Date.now();
    const byWho = new Map();
    const tally = (e, k, v) => { if (v == null) return; const b = e[k]; b.n++; if (v > 0) b.up++; b.sum += v; };
    for (const c of out) {
      const e = byWho.get(c.senderUid) || { uid: c.senderUid, who: c.sender, open: 0, closed: { n: 0, up: 0, sum: 0 }, best: null, worst: null, h1: { n: 0, up: 0, sum: 0 }, h7: { n: 0, up: 0, sum: 0 },
        tg: { hit: 0, miss: 0, wrong: 0, open: 0, hitD: [] } };
      // The second, binary record (build 2026.09.24-95): hit / miss / wrong per person over the
      // targets resolved inside the window, and the median days from send to hit. An early close is
      // neither and is left out; the % record above already scores it.
      if (c.tg) {
        const r = c.tg.res;
        if (r === "hit" || r === "miss" || r === "wrong") {
          if (!winMs || (c.tg.at || 0) >= nowTs - winMs) { e.tg[r]++; if (r === "hit") e.tg.hitD.push((c.tg.at - c.ts) / DAY); }
        } else if (!r && !c.closed) e.tg.open++;
      }
      if (c.closed && c.adj != null && (!winMs || c.closeTs >= nowTs - winMs)) {
        tally(e, "closed", c.adj);
        if (!e.best || c.adj > e.best.adj) e.best = { ref: c.ref, adj: c.adj };
        if (!e.worst || c.adj < e.worst.adj) e.worst = { ref: c.ref, adj: c.adj };
      } else if (!c.closed && c.refPx != null) e.open++;
      tally(e, "h1", c.adj1); tally(e, "h7", c.adj7);
      byWho.set(c.senderUid, e);
    }
    const rec = (b) => (b.n ? { n: b.n, upPct: b.up / b.n, avg: b.sum / b.n } : null);
    const summary = [...byWho.values()].map((e) => {
      const cl = rec(e.closed);
      const hd = e.tg.hitD.sort((a, b) => a - b), mid = hd.length >> 1;
      const tg = e.tg.hit + e.tg.miss + e.tg.wrong + e.tg.open ? { hit: e.tg.hit, miss: e.tg.miss, wrong: e.tg.wrong, open: e.tg.open,
        medHitD: hd.length ? (hd.length % 2 ? hd[mid] : (hd[mid - 1] + hd[mid]) / 2) : null } : null;
      return { uid: e.uid, who: e.who, open: e.open, n: cl ? cl.n : 0, upPct: cl ? cl.upPct : null, avg: cl ? cl.avg : null,
        best: e.best, worst: e.worst, h1: rec(e.h1), h7: rec(e.h7), tg };
    }).filter((e) => e.n || e.open).sort((a, b) => (b.n - a.n) || (b.open - a.open));
    return { ok: true, calls: out, summary, windowMs: winMs, defaultHorizonD: CALL_DEFAULT_H / DAY };
  }

  // ---- export ---------------------------------------------------------------------------------------
  // If messages carry trade calls they are a record, and a record you cannot get out of the system
  // is a record you do not really have.
  function exportThread(uid, threadId) {
    const t = S.thrById.get(+threadId);
    if (!t || !isMember(t.id, uid)) return { ok: false, error: "no such conversation" };
    // An export honors the caller's own clear: history they chose to forget is not theirs to
    // re-download. The operator read-through keeps the full record, as disclosed.
    const cf = (S.readGet.get(t.id, uid) || {}).clearedUpTo || 0;
    const rows = db.prepare("SELECT * FROM dm_msg WHERE thread = ? AND id > ? ORDER BY id").all(t.id, cf);
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
    return S.thrAll.all(Math.trunc(Math.min(Math.max(+limit || 200, 1), 500))).map((t) => {
      const mem = S.memAll.all(t.id);
      const last = S.msgLast.get(t.id);
      return { id: t.id, kind: t.kind, title: t.title || null, lastAt: t.lastAt,
        members: mem.map((m) => ({ handle: (users.get(m.uid) || {}).display || m.uid, left: !!m.leftAt })),
        n: db.prepare("SELECT COUNT(*) AS n FROM dm_msg WHERE thread = ?").get(t.id).n,
        preview: last ? String(last.sys ? sysLine(last) : last.deletedAt ? "message deleted" : last.cmd ? "▸ " + last.cmd : last.body).slice(0, 90) : "" };
    });
  }
  function adminHistory(adminUid, threadId, before, limit) {
    const t = S.thrById.get(+threadId);
    if (!t) return { ok: false, error: "no such conversation" };
    const b = Number.isFinite(+before) && +before > 0 ? +before : Number.MAX_SAFE_INTEGER;
    const n = Math.trunc(Math.min(Math.max(+limit || 100, 1), 300));
    const rows = S.msgPage.all(t.id, b, 0, n).reverse();   // read-through: no per-viewer clear floor
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
    const n = Math.trunc(Math.min(Math.max(+limit || 100, 1), 200));
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
  const adminAuditLog = (limit) => S.auditList.all(Math.trunc(Math.min(Math.max(+limit || 100, 1), 500)))
    .map((r) => ({ at: r.at, who: (users.get(r.uid) || {}).display || r.uid, action: r.action, thread: r.thread, detail: r.detail }));

  // ---- offline escalation ----------------------------------------------------------------------
  // Returns one digest per (recipient, thread) for messages that are still unread, older than
  // `delayMs`, not muted, and not already escalated. The delay is the whole feature: without it two
  // people typing at each other would generate a push per line.
  //
  // isOnline(uid) is supplied by the server from its live SSE connection map — a member with the
  // terminal open is by definition not missing anything.
  // "@handle" in a body, as a word: preceded by start or a non-handle character, and not running
  // into more handle characters — so @lena matches for lena but @lena2 does not.
  function mentionRe(handle) {
    const h = String(handle || "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    return new RegExp("(^|[^A-Za-z0-9._-])@" + h + "(?![A-Za-z0-9._-])", "i");
  }
  // isMirrored(uid) says the member has a live Telegram to mirror into: a synced conversation is
  // then delivered by the mirror as it happens, and the digest would only repeat it five minutes
  // later. With no reachable chat the mirror cannot run, so the digest (and the browser push
  // beside it) stays the fallback exactly as for an unsynced thread.
  function pendingEscalations(delayMs, isOnline, isMirrored) {
    const now = Date.now(), cut = now - (delayMs == null ? 5 * 60000 : delayMs);
    const out = [];
    for (const t of S.thrActive.all()) {
      for (const uid of memberUids(t.id)) {
        const u = users.get(uid);
        if (!u || u.disabledAt) continue;
        if (isOnline && isOnline(uid)) continue;
        const rd = S.readGet.get(t.id, uid) || { readMsgId: 0, muted: 0, notifiedMsgId: 0 };
        if (rd.tgSync && isMirrored && isMirrored(uid)) continue;
        const floor = Math.max(rd.readMsgId || 0, rd.notifiedMsgId || 0);
        const fresh = S.msgSince.all(t.id, floor, 50)
          .filter((m) => m.sender !== uid && !m.deletedAt && !m.sys);
        // Two things jump the queue — out immediately, and through a muted thread: a ticker you
        // asked to hear about, and YOUR OWN handle. Muting a busy group should not be the same as
        // asking not to be told when somebody watches your name or calls it directly.
        const mre = mentionRe(u.handle);
        const hot = fresh.filter((m) => (m.ref && watches(uid, m.ref)) || mre.test(m.body || ""));
        // Boards digest only for members who opted in; mentions and watched tickers reach
        // everyone regardless — that is what makes the quiet default safe.
        const digestOk = t.kind === "board" ? (!rd.muted && rd.boardNotify === 1) : !rd.muted;
        const rows = hot.length ? hot : (digestOk ? fresh.filter((m) => m.ts <= cut) : []);
        if (!rows.length) continue;
        out.push({ uid, thread: t.id, kind: t.kind,
          from: t.kind === "group" ? threadName(t, uid)
            : ((users.get(rows[rows.length - 1].sender) || {}).display || "someone"),
          n: rows.length, upTo: rows[rows.length - 1].id, hot: hot.length > 0,
          lines: rows.slice(-3).map((m) => ((m.ref ? "$" + m.ref + " · " : "")
            // A command result digests as the command, not its first 90 characters of table:
            // "▸ top funding 5" says what was asked; a padded header row says nothing on a phone.
            + (m.cmd ? "▸ " + m.cmd : (m.body || (m.fileId ? "sent a file" : "")))).slice(0, 90)) });
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

  // The global message sequence alone — what an SSE poke needs. stats() also scans the invite
  // table and was being called on every typing keystroke, fanned out to every peer.
  function msgSeq() { return S.msgMaxId.get().m; }
  function stats() {
    return { users: users.size, admins: [...users.values()].filter((u) => u.isAdmin && !u.disabledAt).length,
      invitesOpen: S.invList.all().filter((i) => inviteState(i, Date.now()) === "open").length,
      messages: S.msgMaxId.get().m };
  }

  // ---- usage: daily aggregates behind the admin Usage fold (build 2026.09.24-109) ----------------
  // The beacon (POST /api/usage) lands here as an in-memory increment — the request path never
  // touches SQLite. usageFlush writes the pending map in ONE transaction of prepared upserts, every
  // 60s from the server and once more from close() on the way out, and bumps a generation the
  // admin payload's cache key is built on. Retention: USAGE_KEEP_DAYS ET days per member, then the
  // rows fold into uid '0' (sitewide) and the per-member rows go.
  const USAGE_KEEP_DAYS = 30;
  const USAGE_SITE = "0";   // no real uid is one character (adoptableUid wants 12+), so it can never collide
  const US = {
    up: db.prepare(`INSERT INTO usage_day (day, uid, kind, key, n, ms) VALUES (?,?,?,?,?,?)
      ON CONFLICT(day, uid, kind, key) DO UPDATE SET n = n + excluded.n, ms = ms + excluded.ms`),
    range: db.prepare("SELECT * FROM usage_day WHERE day >= ? AND day <= ?"),
    rangeOf: db.prepare("SELECT * FROM usage_day WHERE uid = ? AND day >= ? AND day <= ?"),
    // WHERE ... GROUP BY: the SELECT needs its WHERE for SQLite to parse the upsert's ON CONFLICT
    fold: db.prepare(`INSERT INTO usage_day (day, uid, kind, key, n, ms)
      SELECT day, '${USAGE_SITE}', kind, key, SUM(n), SUM(ms) FROM usage_day WHERE day < ? AND uid <> '${USAGE_SITE}' GROUP BY day, kind, key
      ON CONFLICT(day, uid, kind, key) DO UPDATE SET n = n + excluded.n, ms = ms + excluded.ms`),
    drop: db.prepare(`DELETE FROM usage_day WHERE day < ? AND uid <> '${USAGE_SITE}'`),
    pause: db.prepare("UPDATE user SET usagePaused = ? WHERE uid = ?"),
  };
  let usagePend = new Map(), usageGeneration = 0;
  // Calendar arithmetic on the ET day STRING (UTC-anchored, so DST can never skip or repeat a day).
  const usageDayShift = (d, n) => new Date(Date.UTC(+d.slice(0, 4), +d.slice(5, 7) - 1, +d.slice(8, 10)) + n * 864e5).toISOString().slice(0, 10);
  const usageToday = (now) => etDayStr(now != null ? now : Date.now());
  const usagePaused = (uid) => !!((users.get(uid) || {}).usagePaused);
  function usageAdd(uid, day, kind, key, n, ms) {
    const k = day + "\u0001" + uid + "\u0001" + kind + "\u0001" + key;
    const cur = usagePend.get(k);
    if (cur) { cur.n += n; cur.ms += ms; } else usagePend.set(k, { day, uid, kind, key, n, ms });
  }
  // One accepted beacon: {tab -> ms} already validated and clamped by the server, plus the device.
  function usageRecord(uid, tabs, dev, now) {
    const u = users.get(uid);
    if (!u || u.disabledAt || u.usagePaused) return { ok: true, stored: false };
    const day = usageToday(now);
    let tot = 0;
    for (const [k, ms] of Object.entries(tabs)) { if (ms > 0) { usageAdd(uid, day, "tab", k, 1, ms); tot += ms; } }
    if (tot > 0 && dev) usageAdd(uid, day, "dev", dev, 1, tot);
    return { ok: true, stored: tot > 0, ms: tot };
  }
  function usageFlush() {
    if (!usagePend.size) return 0;
    const rows = [...usagePend.values()];
    usagePend = new Map();
    db.exec("BEGIN IMMEDIATE");
    try {
      for (const r of rows) US.up.run(r.day, r.uid, r.kind, r.key, r.n, Math.round(r.ms));
      db.exec("COMMIT");
    } catch (e) {
      try { db.exec("ROLLBACK"); } catch (_) {}
      // put them back: a failed flush must not lose the minute it was carrying
      for (const r of rows) usageAdd(r.uid, r.day, r.kind, r.key, r.n, r.ms);
      throw e;
    }
    usageGeneration++;
    return rows.length;
  }
  // Fold everything older than the window into the sitewide bucket, then drop the per-member rows.
  function usageRetain(now) {
    usageFlush();
    const cut = usageDayShift(usageToday(now), -(USAGE_KEEP_DAYS - 1));   // oldest day still kept per member
    db.exec("BEGIN IMMEDIATE");
    let dropped;
    try { US.fold.run(cut); dropped = Number(US.drop.run(cut).changes || 0); db.exec("COMMIT"); }
    catch (e) { try { db.exec("ROLLBACK"); } catch (_) {} throw e; }
    if (dropped) usageGeneration++;
    return { ok: true, cut, dropped };
  }
  function setUsagePaused(uid, on) {
    const u = users.get(uid);
    if (!u) return { ok: false, error: "no such account" };
    US.pause.run(on ? 1 : 0, uid); u.usagePaused = on ? 1 : 0;
    // What was recorded before the click stays (it ages out with the window like anything else);
    // pausing stops the recording from here on — the server refuses, the client stops sending.
    usageGeneration++;
    return { ok: true, paused: !!on };
  }
  // tabs: [{key, label, gate}] (the feature manifest's tabs, resolved by the server). online: Set of uids.
  const usageMed = (a) => { if (!a.length) return null; const s = [...a].sort((x, y) => x - y), m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };
  const USAGE_ACTIVE_MS = 60000;   // "active" = at least a minute on screen that ET day
  function usageDays(today, r) { const out = []; for (let i = r - 1; i >= 0; i--) out.push(usageDayShift(today, -i)); return out; }
  function usageSummary(opts) {
    usageFlush();
    const o = opts || {}, now = o.now != null ? o.now : Date.now();
    const r = Math.max(1, Math.min(USAGE_KEEP_DAYS, Math.trunc(+o.r || 7)));
    const today = usageToday(now), days = usageDays(today, r);
    const pFrom = usageDayShift(days[0], -r);   // the prior range runs pFrom .. the day before days[0]
    const keepFrom = usageDayShift(today, -(USAGE_KEEP_DAYS - 1));
    const priorKept = pFrom >= keepFrom;   // the prior range is still per-member (else only uid '0' totals survive)
    const inRange = new Set(days);
    const online = o.online || new Set();
    const tabs = o.tabs || [];
    // per (uid, day) screen ms; per (uid, tab) ms; per tab totals; per (uid, dev) ms — current and prior
    const dayMs = new Map(), uTab = new Map(), tabMs = new Map(), tabPrev = new Map(), uDev = new Map(), uPrev = new Map();
    const bump = (m, k, v) => m.set(k, (m.get(k) || 0) + v);
    for (const row of US.range.all(pFrom, today)) {
      const cur = inRange.has(row.day);
      if (row.kind === "tab") {
        if (cur) bump(tabMs, row.key, row.ms); else bump(tabPrev, row.key, row.ms);
        if (row.uid === USAGE_SITE) continue;
        if (cur) { bump(dayMs, row.uid + "|" + row.day, row.ms); bump(uTab, row.uid + "|" + row.key, row.ms); }
        else bump(uPrev, row.uid, row.ms);
      } else if (row.kind === "dev" && cur && row.uid !== USAGE_SITE) bump(uDev, row.uid + "|" + row.key, row.ms);
    }
    const activeOn = new Map();   // day -> Set(uid)
    const uActive = new Map();    // uid -> {days, ms}
    for (const [k, ms] of dayMs) {
      if (ms < USAGE_ACTIVE_MS) continue;
      const [uid, day] = k.split("|");
      if (!activeOn.has(day)) activeOn.set(day, new Set());
      activeOn.get(day).add(uid);
      const a = uActive.get(uid) || { days: 0, ms: 0 };
      a.days++; a.ms += ms; uActive.set(uid, a);
    }
    const series = days.map((d) => ({ day: d, n: activeOn.has(d) ? activeOn.get(d).size : 0 }));
    const activeRange = uActive.size;
    const meanDaily = series.reduce((s, x) => s + x.n, 0) / days.length;
    const memberDayMin = [];
    for (const [k, ms] of dayMs) if (ms >= USAGE_ACTIVE_MS && inRange.has(k.split("|")[1])) memberDayMin.push(ms / 60000);
    const members = [...users.values()].filter((u) => !u.disabledAt);
    const newMembers = members.filter((u) => etDayStr(u.createdAt) >= days[0]);
    const tabRows = tabs.map((t) => {
      const who = [];
      for (const uid of uActive.keys()) { const ms = uTab.get(uid + "|" + t.key) || 0; if (ms > 0) who.push(ms / 60000); }
      const ms = tabMs.get(t.key) || 0, prev = tabPrev.get(t.key) || 0;
      return { key: t.key, label: t.label, gate: t.gate, users: who.length,
        reach: activeRange ? who.length / activeRange : null, ms, medMin: usageMed(who),
        prevMs: prev, delta: prev > 0 ? (ms - prev) / prev : null };
    }).filter((t) => t.ms > 0 || t.prevMs > 0 || t.gate !== "off");
    const TEN_DAYS = 10 * 864e5;
    const memberRows = members.map((u) => {
      const base = { handle: u.handle, display: u.display, admin: !!u.isAdmin, createdAt: u.createdAt,
        lastSeen: u.lastSeen || 0, online: online.has(u.uid), paused: !!u.usagePaused };
      base.lapsed = !base.online && now - Math.max(base.lastSeen, 0) > TEN_DAYS && now - (u.createdAt || 0) > TEN_DAYS;
      if (u.usagePaused) return Object.assign(base, { days: null, minPerDay: null, top: [], dev: null, trend: null });
      const a = uActive.get(u.uid) || { days: 0, ms: 0 };
      const top = tabs.map((t) => [t.label, uTab.get(u.uid + "|" + t.key) || 0]).filter((x) => x[1] > 0)
        .sort((x, y) => y[1] - x[1]).slice(0, 3).map((x) => x[0]);
      let dev = null, devMs = 0;
      for (const [k, ms] of uDev) { const i = k.indexOf("|"); if (k.slice(0, i) === u.uid && ms > devMs) { dev = k.slice(i + 1); devMs = ms; } }
      let curMs = 0; for (const t of tabs) curMs += uTab.get(u.uid + "|" + t.key) || 0;
      const prev = uPrev.get(u.uid) || 0;
      return Object.assign(base, { days: a.days, minPerDay: a.days ? a.ms / a.days / 60000 : 0, top, dev,
        trend: priorKept && prev > 0 ? (curMs - prev) / prev : null });
    });
    return { ok: true, r, today, days, keepDays: USAGE_KEEP_DAYS, priorKept, gen: usageGeneration,
      kpi: { online: members.filter((u) => online.has(u.uid)).length,
        activeToday: activeOn.has(today) ? activeOn.get(today).size : 0,
        activeRange, members: members.length,
        stickiness: activeRange ? meanDaily / activeRange : null,
        medMinPerDay: usageMed(memberDayMin),
        newMembers: newMembers.length, newActive: newMembers.filter((u) => uActive.has(u.uid)).length },
      series, tabs: tabRows, members: memberRows };
  }
  // One member's last USAGE_KEEP_DAYS days: minutes per day, tab mix, device mix. Shared by the
  // member's own card (usageMine) and the operator's drill-in (usageMember, which AUDITS).
  function usageDetail(u, tabs, now) {
    const today = usageToday(now), days = usageDays(today, USAGE_KEEP_DAYS);
    const label = new Map((tabs || []).map((t) => [t.key, t.label]));
    const perDay = new Map(), tab = new Map(), dev = new Map();
    const pend = [...usagePend.values()].filter((r) => r.uid === u.uid);
    for (const r of US.rangeOf.all(u.uid, days[0], today).concat(pend)) {
      if (r.kind === "tab") { perDay.set(r.day, (perDay.get(r.day) || 0) + r.ms); tab.set(r.key, (tab.get(r.key) || 0) + r.ms); }
      else if (r.kind === "dev") dev.set(r.key, (dev.get(r.key) || 0) + r.ms);
    }
    const total = [...tab.values()].reduce((s, v) => s + v, 0);
    return { handle: u.handle, display: u.display, createdAt: u.createdAt,
      invitedBy: u.invitedBy ? ((users.get(u.invitedBy) || {}).display || null) : null,
      paused: !!u.usagePaused, keepDays: USAGE_KEEP_DAYS, days,
      minutes: days.map((d) => Math.round((perDay.get(d) || 0) / 6000) / 10),
      activeDays: days.filter((d) => (perDay.get(d) || 0) >= USAGE_ACTIVE_MS).length,
      ms: total,
      tabs: [...tab].sort((a, b) => b[1] - a[1]).map(([k, ms]) => ({ key: k, label: label.get(k) || k, ms, share: total ? ms / total : 0 })),
      devices: [...dev].sort((a, b) => b[1] - a[1]).map(([k, ms]) => ({ key: k, ms })) };
  }
  function usageMine(uid, tabs, now) {
    const u = users.get(uid);
    if (!u) return { ok: false, error: "no such account" };
    return Object.assign({ ok: true }, usageDetail(u, tabs, now));
  }
  function usageMember(adminUid, handle, tabs, now) {
    const u = getUserByHandle(handle);
    if (!u) return { ok: false, error: "no such member" };
    // Every drill-in is written down, paused or not — the same rule as the message read-through.
    adminAudit(adminUid, "view-usage", null, u.handle);
    const d = usageDetail(u, tabs, now);
    if (u.usagePaused) return { ok: true, handle: d.handle, display: d.display, createdAt: d.createdAt, invitedBy: d.invitedBy, paused: true, keepDays: USAGE_KEEP_DAYS };
    return Object.assign({ ok: true }, d);
  }

  // ---- backup + close --------------------------------------------------------------------------
  // accounts.db is the one file on the volume with no other copy anywhere: users, password hashes,
  // invites, every message and every attachment. VACUUM INTO writes a consistent, compacted copy
  // while the database stays live (WAL readers keep reading, writers keep writing), into a rotated
  // set beside the database — or into ACCOUNTS_BACKUP_DIR when the operator mounts a second
  // volume, which is what turns "survives a bad migration" into "survives losing the volume".
  // Deliberately NOT the GitHub ledger backup: this file carries PII.
  let lastBackup = null;
  // Split in three (build 2026.09.24-101) so the scheduled path can run the copy off the event
  // loop: plan (names, dir), copy (VACUUM INTO — in-process here, in a worker in backupAsync),
  // land (rename over, stat, rotate). Same names, same rotation, same result shape either way.
  function backupPlan(dir, keep) {
    const out = dir || path.join(dataDir, "backups");
    const n = Number.isFinite(keep) && keep >= 1 ? Math.floor(keep) : 7;
    fs.mkdirSync(out, { recursive: true });
    const stamp = new Date().toISOString().replace(/[-:]/g, "").replace("T", "-").slice(0, 15);
    const file = path.join(out, `accounts-${stamp}-${Date.now() % 100000}.db`);
    const tmp = file + ".tmp";
    // (build 2026.09.24-107) A copy a kill interrupted (SIGTERM mid-VACUUM) left its .tmp behind
    // and nothing ever removed it. Backups are serialized, so at the start of one no other copy of
    // this process is writing — every accounts-*.db.tmp here is litter.
    try { for (const f of fs.readdirSync(out)) if (/^accounts-\d{8}-\d{6}-\d+\.db\.tmp$/.test(f)) { try { fs.unlinkSync(path.join(out, f)); } catch (_) {} } } catch (_) {}
    return { out, n, file, tmp };
  }
  const backupCopySync = (tmp) => { try { fs.unlinkSync(tmp); } catch (_) {} db.exec("VACUUM INTO '" + tmp.replace(/'/g, "''") + "'"); };
  function backupLand({ out, n, file, tmp }) {
    fs.renameSync(tmp, file);
    const bytes = fs.statSync(file).size;
    // Rotate: newest n stay, the rest go. Names sort chronologically by construction.
    const old = fs.readdirSync(out).filter((f) => /^accounts-\d{8}-\d{6}-\d+\.db$/.test(f)).sort();
    for (const f of old.slice(0, Math.max(0, old.length - n))) { try { fs.unlinkSync(path.join(out, f)); } catch (_) {} }
    lastBackup = { at: Date.now(), file, bytes };
    return { ok: true, file, bytes, kept: Math.min(n, old.length) };
  }
  // Synchronous: tests, and the fallback shape. The daily schedule uses backupAsync.
  function backup(dir, keep) {
    let plan = null;
    try {
      plan = backupPlan(dir, keep);
      backupCopySync(plan.tmp);
      return backupLand(plan);
    } catch (e) {
      if (plan) { try { fs.unlinkSync(plan.tmp); } catch (_) {} }
      return { ok: false, error: (e && e.message) || String(e) };
    }
  }
  // The scheduled path (build 2026.09.24-101): the VACUUM runs in a worker thread on its own
  // connection to accounts.db (WAL: a concurrent reader is fine), so the copy of every message and
  // attachment no longer stalls the server. A worker that cannot start runs backupCopySync instead.
  // Serialized: an overlapping call (boot timer racing the daily one) waits for the running copy.
  let backupChain = Promise.resolve(), backupTmpLive = null;
  function backupAsync(dir, keep, opts) {
    const run = async () => {
      let plan = null;
      try {
        plan = backupPlan(dir, keep);
        backupTmpLive = plan.tmp;
        await vacuumIntoAsync(file, plan.tmp, () => backupCopySync(plan.tmp), opts);
        return backupLand(plan);
      } catch (e) {
        if (plan) { try { fs.unlinkSync(plan.tmp); } catch (_) {} }
        return { ok: false, error: (e && e.message) || String(e) };
      } finally { backupTmpLive = null; }
    };
    const p = backupChain.then(run, run);
    backupChain = p.catch(() => {});
    return p;
  }
  // (build 2026.09.24-107) Shutdown: give a running backup a moment to land (bounded — never holds
  // the exit). true = idle, false = still copying at the deadline (close() then removes its .tmp).
  function backupDrain(timeoutMs) {
    let t;
    const to = new Promise((r) => { t = setTimeout(() => r(false), timeoutMs > 0 ? timeoutMs : 0); });
    return Promise.race([backupChain.then(() => true, () => true), to]).finally(() => clearTimeout(t));
  }
  function close() {
    // (build 2026.09.24-109) the last minute of usage lands before the handle closes
    try { usageFlush(); } catch (_) {}
    // A copy still running is abandoned with the process: its partial file goes now (the worker
    // may still hold it open — unlinking an open file is fine), not at the next boot's backup.
    if (backupTmpLive) { try { fs.unlinkSync(backupTmpLive); } catch (_) {} }
    try { db.exec("PRAGMA wal_checkpoint(TRUNCATE);"); } catch (_) {}
    try { db.close(); } catch (_) {}
  }

  return {
    // identity
    signSession, sessionUser, tokenFor, countUsers, getUser, getUserByHandle, listUsers, pub, deriveKey,
    backup, backupAsync, backupDrain, close, lastBackup: () => lastBackup, msgSeq,
    login, setPassword, signOutEverywhere, setDisabled, setAdmin, renameUser, touch, hydrate,
    // invites
    mintInvite, readInvite, revokeInvite, listInvites, redeem, bootstrap, claim, inviteState,
    otpRequest, otpVerify,
    // messages
    setMarkSource, threadFor, threadPeers, isMember, memberUids, send, edit, drop,
    threads, history, sync, search, markRead, setMuted, setBoardNotify,
    setTgSync, tgSyncThread, tgSyncAll, mirrorRows, bridgeSyncText,
    tgMapAdd, tgMapFor, tgMapPack, mirrorRowsById, bridgeSyncFile, bridgeEdit, reactApply, reactTop,
    closeThread, reopenThread, clearHistory,
    createGroup, addMembers, removeMember, leaveGroup, renameGroup, deleteGroup,
    createBoard, joinBoard, listBoards, setTweetSource,
    react, REACTIONS, putFile, readFile, removeFile, sweepFiles, sweepRetention, bridgeReply,
    watchList, setWatch, pin, pinsOf, calls, callClose, callExtend, callDrop, exportThread,
    targetSweep, setBarSource,
    prefsGet, prefsPut,
    walletGet, walletSet, walletDrop, walletsAll,
    adminThreads, adminHistory, adminSearch, adminAuditLog,
    // usage (build 2026.09.24-109)
    usageRecord, usageFlush, usageRetain, usageSummary, usageMine, usageMember, usagePaused, setUsagePaused,
    usageGen: () => usageGeneration, usagePending: () => usagePend.size, USAGE_KEEP_DAYS,
    pendingEscalations, markEscalated,
    setPxHistory,
    // browser push subscriptions — stored here, delivered by the server (which holds the keys)
    webPushAdd: (uid, sub, ua) => {
      const e = sub && sub.endpoint, k = sub && sub.keys;
      if (typeof e !== "string" || !/^https:\/\//.test(e) || e.length > 1024) return { ok: false, error: "bad endpoint" };
      if (!k || typeof k.p256dh !== "string" || typeof k.auth !== "string" || k.p256dh.length > 256 || k.auth.length > 128)
        return { ok: false, error: "bad keys" };
      S.wpAdd.run(e, uid, k.p256dh, k.auth, String(ua || "").slice(0, 120), Date.now());
      return { ok: true };
    },
    webPushDrop: (uid, endpoint) => { S.wpDropMine.run(String(endpoint || ""), uid); return { ok: true }; },
    webPushDropDead: (endpoint) => { try { S.wpDrop.run(String(endpoint || "")); } catch (_) {} },
    webPushFor: (uid) => S.wpFor.all(uid).map((r) => ({ endpoint: r.endpoint, keys: { p256dh: r.p256dh, auth: r.auth } })),
    stats,
    // testing seams
    _db: db,
  };
}

module.exports = { openAccounts, mintCode, normCode, handleError, pwError, hashPw, hashPwSync, verifyPw, adoptableUid,
  cleanBody, firstTickerRef, CODE_ALPHABET, DM_MAX_LEN, PW_MIN, FILE_MAX: 8 * 1024 * 1024 };
