"use strict";
// ===== build 2026.09.24-99: Telegram sync — edits, deletions, reactions and attachments ==========
// The sync mirrored new lines both ways and nothing else: an edit, a delete or a reaction on either
// side never reached the other, and an attachment arrived as its name. These pin each direction
// against a stubbed Bot API — no network: every call is recorded, every answer is scripted.
const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs"), path = require("path"), os = require("os");

// Environment is read at require time, so it is set before server.js loads, once for the file.
const DATA = fs.mkdtempSync(path.join(os.tmpdir(), "xyz-tgsync-"));
process.env.DATA_DIR = DATA;
process.env.SITE_PASSWORD = "shared-door-pw";
process.env.SITE_USER = "friend";
process.env.ADMIN_PASSWORD = "break-glass-pw-1";
process.env.XYZ_QUIET = "1";
process.env.XYZ_NO_NET = "1";
process.env.TG_BOT_TOKEN = "test-token";
delete process.env.FINNHUB_TOKEN; delete process.env.FRED_KEY;

const { freshAccounts } = require("./_shared");
const { tgReactOut, tgReactIn, TG_REACT_OUT } = require("../src/compute");
const { REACTIONS } = (() => { const A = freshAccounts(); const r = { REACTIONS: A.REACTIONS }; A.close(); return r; })();

// A PNG by magic bytes — the store sniffs the first bytes, never the name.
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]), Buffer.alloc(64, 7)]);

// ---- the stubbed Bot API ------------------------------------------------------------------------
// Answers by method: sends get a fresh message_id, housekeeping gets `true`, getUpdates replays a
// scripted list, getFile resolves a path and the file URL serves bytes. `fail` scripts a one-shot
// refusal for a method (optionally for one chat).
function botApi() {
  const calls = [];
  const state = { next: 500, updates: [], fail: [], file: PNG };
  const answer = (status, body) => ({ ok: status >= 200 && status < 300, status, json: async () => body,
    arrayBuffer: async () => { throw new Error("not a file"); } });
  const stub = async (url, opts) => {
    const u = String(url);
    if (!/api\.telegram\.org/.test(u)) throw new Error("outbound network disabled in this suite: " + u);
    if (/\/file\/bot/.test(u)) {
      calls.push({ method: "download", url: u });
      const b = state.file;
      return { ok: true, status: 200, json: async () => ({}), arrayBuffer: async () => b.buffer.slice(b.byteOffset, b.byteOffset + b.length) };
    }
    const method = u.slice(u.lastIndexOf("/") + 1);
    let body = {};
    const raw = opts && opts.body;
    if (raw instanceof FormData) { for (const [k, v] of raw.entries()) body[k] = v; body.__multipart = true; }
    else body = JSON.parse(raw || "{}");
    calls.push({ method, body });
    const fi = state.fail.findIndex((f) => f.method === method && (f.chat == null || String(f.chat) === String(body.chat_id)));
    if (fi >= 0) { const f = state.fail.splice(fi, 1)[0]; return answer(f.status, { ok: false, description: f.description }); }
    if (method === "getUpdates") { const r = state.updates.splice(0); return answer(200, { ok: true, result: r }); }
    if (method === "getFile") return answer(200, { ok: true, result: { file_id: body.file_id, file_path: "photos/file_1.jpg" } });
    if (/^send/.test(method)) { calls[calls.length - 1].id = ++state.next; return answer(200, { ok: true, result: { message_id: state.next, chat: { id: +body.chat_id } } }); }
    return answer(200, { ok: true, result: true });
  };
  return { calls, state, stub };
}
async function drainAll(P) {
  for (let i = 0; i < 200 && P.pushStateNow().queue > 0; i++) { P.pushUnholdNow(); await P.pushDrainNow(); }
  assert.equal(P.pushStateNow().queue, 0, "the outbox drains");
}

// ---- pure: the reaction vocabulary ---------------------------------------------------------------
test("tg sync -99: every site reaction has one Telegram stand-in from the Bot API's list, and the way back is total on them", () => {
  // The Bot API's ReactionTypeEmoji list, the subset this mapping may use.
  const TG_OK = ["\u{1F44D}", "\u{1F44E}", "\u{1F440}", "\u{1F525}", "\u{1F44C}", "\u{1F914}", "\u{1F3C6}", "\u{1F494}", "\u{1F4AF}", "\u{1F91D}", "\u{1F928}", "⚡", "❤", "\u{1F44F}"];
  assert.deepEqual(Object.keys(TG_REACT_OUT).sort(), REACTIONS.slice().sort(), "the whole site vocabulary, nothing more");
  for (const e of REACTIONS) {
    const tg = tgReactOut(e);
    assert.ok(TG_OK.includes(tg), e + " maps onto an allowed Telegram reaction, got " + tg);
    assert.equal(tgReactIn(tg), e, "and comes back as itself");
  }
  assert.equal(new Set(REACTIONS.map(tgReactOut)).size, REACTIONS.length, "no two site reactions share a stand-in");
  assert.equal(tgReactIn("❤️"), "\u{1F44D}", "a variation selector is not meaning");
  assert.equal(tgReactIn("\u{1F921}"), null, "a reaction with no meaning here is ignored, not guessed");
  assert.equal(tgReactOut("nope"), null);
});

// ---- accounts: the map, the bridge's edit/file/reaction doors ------------------------------------
test("tg sync -99 accounts: the map finds both sides, edits go through edit(), files through putFile, reactions add/drop", async () => {
  const A = freshAccounts();
  try {
    const g = (await A.bootstrap("gus", "correct-horse-battery")).user;
    const l = (await A.redeem(A.mintInvite(g.uid, null, 7, "join").invite.code, "lena", "another-long-password")).user;
    const dm = A.threadFor(g.uid, l.uid, true).id;
    assert.ok(A.setTgSync(l.uid, dm, true).ok);
    const a = A.send(g.uid, l.uid, "one"), b = A.send(g.uid, l.uid, "two");
    // One Telegram message carrying two rows (a packed burst), and one line typed at the bot.
    assert.equal(A.tgMapAdd("900", 41, [a.id, b.id], l.uid, "out", 0), 2);
    assert.equal(A.tgMapAdd("900", 41, [a.id], l.uid, "out", 0), 0, "idempotent");
    assert.equal(A.tgMapAdd("900", 0, [a.id], l.uid, "out", 0), 0, "no Telegram id, no row");
    const typed = A.bridgeSyncText(l.uid, "from the phone");
    assert.ok(typed.ok && typed.id);
    A.tgMapAdd("900", 42, [typed.id], l.uid, "in", 0);
    assert.deepEqual(A.tgMapPack("900", 41).map((x) => x.msg), [a.id, b.id]);
    assert.deepEqual(A.tgMapFor(typed.id).map((x) => [x.chat, x.tgId, x.dir]), [["900", 42, "in"]]);

    // An edit in Telegram: only the member's own mapped line, through edit() and its rules.
    assert.deepEqual(A.bridgeEdit(l.uid, "900", 41, "hijack"), { ok: false, error: "not-mapped", silent: true }, "a mirrored line is not theirs to edit from the phone");
    assert.equal(A.bridgeEdit(g.uid, "900", 42, "not yours").error, "not-mapped", "the map is per member");
    const ed = A.bridgeEdit(l.uid, "900", 42, "from the phone, fixed");
    assert.ok(ed.ok && ed.message.body === "from the phone, fixed" && ed.message.edited, JSON.stringify(ed));
    // Moderation shows through the mirror's rows by name.
    assert.ok(A.edit(g.uid, typed.id, "moderated words", true).ok);
    const rows = A.mirrorRowsById(g.uid, [typed.id, a.id]);
    assert.deepEqual(rows.map((r) => [r.body, r.edited, r.editedBy, r.deleted]), [["moderated words", true, "gus", false], ["one", false, "", false]]);
    assert.ok(A.drop(g.uid, a.id).ok);
    assert.equal(A.mirrorRowsById(l.uid, [a.id])[0].deleted, true, "a tombstone is flagged for the repaint, not dropped");

    // Reactions: explicit add/drop, the site vocabulary only, and the bot's one pick.
    assert.equal(A.reactTop(b.id), null);
    let r = A.reactApply(l.uid, b.id, ["\u{1F525}", "\u{1F921}"], []);
    assert.ok(r.ok && r.changed === 1, "an off-vocabulary reaction is not stored");
    assert.equal(A.reactApply(l.uid, b.id, ["\u{1F525}"], []).changed, 0, "adding what is there is a no-op");
    A.react(g.uid, b.id, "✅"); A.react(g.uid, b.id, "\u{1F525}");
    A._db.prepare("UPDATE dm_reaction SET at = CASE emoji WHEN ? THEN 1 ELSE 2 END WHERE msg = ?").run("✅", b.id);
    assert.equal(A.reactTop(b.id), "\u{1F525}", "most-used wins");
    r = A.reactApply(l.uid, b.id, [], ["\u{1F525}"]);
    assert.equal(r.changed, 1);
    assert.equal(A.reactTop(b.id), "\u{1F525}", "a tie goes to the most recent");
    assert.equal(A.reactApply(l.uid, a.id, ["\u{1F525}"], []).ok, false, "a deleted row takes no reactions");

    // Files from the phone ride the composer's own door: sniffed, capped, refused with a reason.
    const f = A.bridgeSyncFile(l.uid, "shot.png", PNG, "look");
    assert.ok(f.ok && f.message.file && f.message.file.mime === "image/png" && f.message.body === "look", JSON.stringify(f));
    assert.equal(f.message.file.inline, true);
    const bad = A.bridgeSyncFile(l.uid, "run.exe", Buffer.from("MZ\x00\x01binary"), "");
    assert.ok(!bad.ok && /only images/.test(bad.error), "the type allowlist is the store's");
    const big = A.bridgeSyncFile(l.uid, "big.png", Buffer.concat([PNG, Buffer.alloc(8 * 1024 * 1024)]), "");
    assert.ok(!big.ok && /too large/.test(big.error), "and so is the size cap");
    A.setTgSync(l.uid, dm, false);
    assert.deepEqual(A.bridgeSyncFile(l.uid, "shot.png", PNG, ""), { ok: false, error: "not-synced", silent: true });

    // Retention takes the map rows with the messages.
    A._db.prepare("UPDATE dm_msg SET ts = 1 WHERE id = ?").run(typed.id);
    assert.ok(A.sweepRetention() >= 1);
    assert.deepEqual(A.tgMapFor(typed.id), [], "the map does not outlive the row");
  } finally { A.close(); fs.rmSync(A._dir, { recursive: true, force: true }); }
});

test("tg sync -99 accounts: a volume from before the map gains it on open, with nothing else touched", async () => {
  const { openAccounts } = require("../src/accounts");
  const A = freshAccounts();
  const g = (await A.bootstrap("gus", "correct-horse-battery")).user;
  A._db.exec("DROP INDEX dm_tg_msg; DROP TABLE dm_tg");
  A.close();
  const B = openAccounts(A._dir, { markFor: () => null, sessionDays: 30 });
  try {
    assert.ok(B.getUser(g.uid), "accounts survive the reopen");
    const cols = B._db.prepare("PRAGMA table_info(dm_tg)").all().map((c) => c.name);
    assert.deepEqual(cols, ["chat", "tgId", "msg", "uid", "dir", "media", "at"]);
    assert.ok(B._db.prepare("PRAGMA index_list(dm_tg)").all().some((i) => i.name === "dm_tg_msg"));
  } finally { B.close(); fs.rmSync(A._dir, { recursive: true, force: true }); }
});

// ---- poller: the wire ----------------------------------------------------------------------------
function tgPoller(api) {
  const { createPoller } = require("../src/poller");
  let saved = null;
  const store = { loadAll: () => new Map(), loadRegime: () => [], loadLedger: () => null, saveLedger: () => {},
    insert: () => {}, saveRegime: () => {}, loadTriggers: () => null, saveTriggers: () => {},
    savePush: (d) => { saved = d; }, loadPush: () => saved };
  const logs = [];
  const p = createPoller({ dex: "xyz", store, log: (s) => logs.push(s), version: "test", crypto: false, pushFetch: api.stub });
  return { p, logs };
}

test("tg sync -99 wire: housekeeping calls ride the outbox, uploads go multipart, refusals are skipped or fall back", async () => {
  const api = botApi();
  const { p, logs } = tgPoller(api);
  p.pushBindNow(p.pushMintCode("own-a", false).code, 77, "a");
  const heard = [];
  p.pushSyncNow("77", "hello", { onSent: (res, it) => heard.push([res.message_id, !!it.file]) });
  p.pushSyncNow("77", "", { method: "editMessageText", payload: { message_id: 9, text: "x", parse_mode: "HTML" } });
  p.pushSyncNow("77", "", { method: "setMessageReaction", payload: { message_id: 9, reaction: [{ type: "emoji", emoji: "\u{1F525}" }] } });
  p.pushSyncNow("77", "📎 shot.png", { method: "sendPhoto", payload: { caption: "<b>gus</b>", parse_mode: "HTML" },
    file: { field: "photo", name: "shot.png", mime: "image/png", load: () => PNG }, onSent: (res, it) => heard.push([res.message_id, !!it.file]) });
  await p.pushDrainNow();
  assert.ok(p.pushStateNow().hold > Date.now(), "the pacing gap applies to sync calls like any send");
  await drainAll(p);
  assert.deepEqual(api.calls.map((c) => c.method), ["sendMessage", "editMessageText", "setMessageReaction", "sendPhoto"]);
  assert.equal(api.calls[1].body.chat_id, "77");
  assert.deepEqual(api.calls[2].body.reaction, [{ type: "emoji", emoji: "\u{1F525}" }]);
  const up = api.calls[3].body;
  assert.ok(up.__multipart && up.chat_id === "77" && up.caption === "<b>gus</b>" && up.parse_mode === "HTML");
  assert.ok(up.photo instanceof Blob && up.photo.size === PNG.length && up.photo.type === "image/png", "the bytes ride as a Blob in FormData");
  assert.equal(up.photo.name, "shot.png");
  assert.deepEqual(heard, [[501, false], [502, true]], "Telegram's message_id reaches the caller, with whether it was an upload");

  // A refused upload degrades to the line; a refused edit is logged and skipped, never the recipient's error.
  api.calls.length = 0; heard.length = 0;
  api.state.fail.push({ method: "sendDocument", status: 400, description: "Bad Request: file is too big" });
  api.state.fail.push({ method: "deleteMessage", status: 400, description: "Bad Request: message can't be deleted for everyone" });
  p.pushSyncNow("77", "📎 notes.txt", { method: "sendDocument", payload: { caption: "c" }, fallback: "📎 notes.txt",
    file: { field: "document", name: "notes.txt", mime: "text/plain", load: () => Buffer.from("hi") }, onSent: (res, it) => heard.push([res.message_id, !!it.file]) });
  p.pushSyncNow("77", "", { method: "deleteMessage", payload: { message_id: 3 } });
  p.pushSyncNow("77", "", { method: "sendPhoto", payload: {}, fallback: "gone", file: { field: "photo", name: "x.png", mime: "image/png", load: () => null } });
  await drainAll(p);
  assert.deepEqual(api.calls.map((c) => c.method), ["sendDocument", "sendMessage", "deleteMessage", "sendMessage"],
    "the refused upload is re-sent as its line; bytes deleted before the drain fall back without a call");
  assert.equal(api.calls[1].body.text, "📎 notes.txt");
  assert.deepEqual(heard, [[503, false]], "the fallback still maps, as a text message");
  const rec = p.getPush("own-a", false).recipients[0];
  assert.ok(!rec.lastErr && !rec.muted, "sync housekeeping never lands in the delivery error slot");
  assert.ok(logs.some((s) => /deleteMessage on .* skipped — Bad Request: message can't be deleted/.test(s)), "but it is logged");
});

test("tg sync -99 wire: edits, reactions and files from a linked private chat reach the bridge; groups and strangers do not", async () => {
  const api = botApi();
  const { p } = tgPoller(api);
  p.pushBindNow(p.pushMintCode("own-a", false).code, 77, "a");
  const got = [];
  p.setDmBridge((chat, text, o) => { got.push([chat, text, o]); return o && o.file ? { ok: false, error: "only images here" } : { ok: true }; }, { fileMax: 1000 });
  const chat = { id: 77, type: "private" };
  api.state.updates.push(
    { update_id: 1, message: { message_id: 10, chat, text: "plain line" } },
    { update_id: 2, edited_message: { message_id: 10, chat, text: "plain line, fixed" } },
    { update_id: 3, edited_message: { message_id: 11, chat, text: "/alert NVDA > 1" } },
    { update_id: 4, edited_message: { message_id: 10, chat: { id: -5, type: "group" }, text: "group edit" } },
    { update_id: 5, message_reaction: { message_id: 12, chat, user: { id: 77 }, date: 1,
      old_reaction: [{ type: "emoji", emoji: "\u{1F44D}" }], new_reaction: [{ type: "emoji", emoji: "\u{1F525}" }, { type: "custom_emoji", custom_emoji_id: "x" }] } },
    { update_id: 6, message_reaction: { message_id: 12, chat: { id: 78, type: "private" }, user: { id: 78 }, date: 1, old_reaction: [], new_reaction: [{ type: "emoji", emoji: "\u{1F525}" }] } },
    { update_id: 7, message: { message_id: 13, chat, caption: "look", photo: [{ file_id: "small", file_size: 100 }, { file_id: "big", file_size: 5000 }] } },
    { update_id: 8, message: { message_id: 14, chat, document: { file_id: "doc", file_size: 999999, file_name: "huge.pdf" } } });
  await p.pushUpdatesNow();
  const gu = api.calls.find((c) => c.method === "getUpdates");
  assert.deepEqual(gu.body.allowed_updates, ["message", "edited_message", "message_reaction"], "reactions must be asked for by name");
  assert.deepEqual(got.map((g) => [g[0], g[1], Object.keys(g[2]).sort().join(",")]), [
    ["77", "plain line", "bare,tgId"],
    ["77", "plain line, fixed", "edit,tgId"],
    ["77", "", "reaction"],
    ["77", "look", "file,tgId"]], "a command edit, a group chat and an unlinked chat never reach the bridge");
  assert.equal(got[0][2].tgId, 10);
  assert.deepEqual(got[2][2].reaction, { tgId: 12, added: ["\u{1F525}"], removed: ["\u{1F44D}"] }, "a diff, custom emoji ignored");
  assert.equal(got[3][2].file.name, "photo-13.jpg");
  assert.deepEqual(got[3][2].file.bytes, PNG, "the largest size under the cap was fetched and handed over");
  assert.deepEqual(api.calls.filter((c) => c.method === "getFile").map((c) => c.body.file_id), ["small"], "the 5000-byte size is over the 1000-byte cap: the small one is fetched, the huge document never is");
  assert.ok(api.calls.some((c) => c.method === "download"));
  await drainAll(p);
  const replies = api.calls.filter((c) => c.method === "sendMessage").map((c) => c.body.text);
  assert.ok(replies.some((t) => /only images here/.test(t)), "a refused file says why");
  assert.ok(replies.some((t) => /too large to sync/.test(t)), "an oversize file is refused from its metadata, before any download");
});

// ---- server: both directions end to end -----------------------------------------------------------
const JSONH = { "content-type": "application/json" };
function jar() {
  const c = new Map();
  return {
    absorb(res) {
      const sc = res.headers["set-cookie"];
      for (const line of Array.isArray(sc) ? sc : (sc ? [sc] : [])) {
        const [nv, ...attrs] = line.split(";");
        const i = nv.indexOf("="), name = nv.slice(0, i).trim(), val = nv.slice(i + 1).trim();
        if (attrs.some((a) => /max-age=0/i.test(a)) || val === "x") c.delete(name); else c.set(name, val);
      }
      return res;
    },
    header() { return [...c].map(([k, v]) => k + "=" + v).join("; "); },
  };
}

test("tg sync -99 server: edits, deletes, reactions and files cross in both directions, packed messages shrink, moderation shows", async () => {
  const api = botApi();
  const realFetch = globalThis.fetch;
  globalThis.fetch = api.stub;
  const { buildServer, _poller } = require("../server.js");
  const app = await buildServer();
  try {
    const post = (url, body, j) => app.inject({ method: "POST", url, headers: Object.assign({}, JSONH, j ? { cookie: j.header() } : {}), payload: JSON.stringify(body) });
    const get = (url, j) => app.inject({ method: "GET", url, headers: j ? { cookie: j.header() } : {} });
    const gus = jar();
    gus.absorb(await post("/login", { password: "break-glass-pw-1" }));
    gus.absorb(await post("/bootstrap", { handle: "gus", password: "a-long-password-12" }, gus));
    gus.absorb(await post("/login", { handle: "gus", password: "a-long-password-12" }));
    const mint = JSON.parse((await post("/api/access", { op: "mint", days: 1 }, gus)).body);
    const cara = jar(); cara.absorb(await get("/join/" + (mint.code || mint.invite.code), cara));
    assert.equal(cara.absorb(await post("/join", { handle: "cara", password: "yet-another-long-pw" }, cara)).statusCode, 200);
    const members = JSON.parse((await get("/api/access", gus)).body).members;
    const gusUid = members.find((m) => m.handle === "gus").uid, caraUid = members.find((m) => m.handle === "cara").uid;

    const P = _poller();
    P.pushBindNow(P.pushMintCode(gusUid, false).code, 7001, "gus");
    P.pushBindNow(P.pushMintCode(caraUid, false).code, 7002, "cara");
    const T = JSON.parse((await post("/api/dm", { to: gusUid, body: "before sync" }, cara)).body).thread;
    assert.equal((await post("/api/dm", { thread: T, tgSync: true }, gus)).statusCode, 200);
    assert.equal((await post("/api/dm", { thread: T, tgSync: true }, cara)).statusCode, 200);
    await drainAll(P);
    const since = () => { const c = api.calls.slice(); api.calls.length = 0; return c.filter((x) => x.method !== "getUpdates"); };
    since();
    const history = async (j) => JSON.parse((await get("/api/dm/" + T, j)).body).messages;

    // ---- site → Telegram: a line, then its edit, reactions and delete ----
    const hello = JSON.parse((await post("/api/dm", { thread: T, body: "hello from the desk" }, gus)).body).message;
    await drainAll(P);
    const sent = since();
    assert.deepEqual(sent.map((c) => [c.method, c.body.chat_id]).sort(), [["sendMessage", "7001"], ["sendMessage", "7002"]]);
    const tgOf = Object.fromEntries(sent.map((x) => [x.body.chat_id, x.id]));   // the ids Telegram "assigned"

    assert.equal((await post("/api/dm", { id: hello.id, body: "hello from the desk (fixed)" }, gus)).statusCode, 200);
    await drainAll(P);
    let c = since().filter((x) => x.method === "editMessageText");
    assert.equal(c.length, 2, "both mirrored copies are repainted");
    for (const e of c) {
      assert.equal(e.body.message_id, tgOf[e.body.chat_id], "on the Telegram message that carries the row");
      assert.match(e.body.text, /hello from the desk \(fixed\)/);
      assert.match(e.body.text, /edited/);
      assert.equal(e.body.parse_mode, "HTML");
    }

    assert.equal((await post("/api/dm", { react: true, id: hello.id, emoji: "✅" }, cara)).statusCode, 200);
    await drainAll(P);
    c = since().filter((x) => x.method === "setMessageReaction");
    assert.equal(c.length, 2);
    assert.deepEqual(c[0].body.reaction, [{ type: "emoji", emoji: "\u{1F44C}" }], "the site's check shows as Telegram's OK hand");
    await post("/api/dm", { react: true, id: hello.id, emoji: "✅" }, cara);
    await drainAll(P);
    c = since().filter((x) => x.method === "setMessageReaction");
    assert.deepEqual(c.map((x) => x.body.reaction), [[], []], "the last reaction taken away clears the bot's");

    // ---- Telegram → site: a typed line, its edit, a reaction, a photo ----
    api.state.updates.push({ update_id: 100, message: { message_id: 900, chat: { id: 7002, type: "private" }, from: { first_name: "cara" }, text: "from the phone" } });
    await P.pushUpdatesNow();
    await drainAll(P);
    let msgs = await history(gus);
    const phone = msgs.find((m) => m.body === "from the phone");
    assert.ok(phone, "the phone's line posted into the conversation");
    c = since().filter((x) => x.method === "sendMessage");
    assert.deepEqual(c.map((x) => x.body.chat_id), ["7001"], "mirrored to gus, not echoed to cara");
    const phoneOnGus = c[0].id;

    api.state.updates.push({ update_id: 101, edited_message: { message_id: 900, chat: { id: 7002, type: "private" }, text: "from the phone, fixed" } });
    await P.pushUpdatesNow();
    await drainAll(P);
    msgs = await history(gus);
    const fixed = msgs.find((m) => m.id === phone.id);
    assert.ok(fixed.body === "from the phone, fixed" && fixed.edited, "the Telegram edit rewrote the row, marked edited");
    c = since().filter((x) => x.method === "editMessageText");
    assert.deepEqual(c.map((x) => [x.body.chat_id, x.body.message_id]), [["7001", phoneOnGus]], "and gus's copy is repainted; cara's own line is hers");

    api.state.updates.push({ update_id: 102, message_reaction: { message_id: tgOf["7002"], chat: { id: 7002, type: "private" }, user: { id: 7002 }, date: 1,
      old_reaction: [], new_reaction: [{ type: "emoji", emoji: "\u{1F525}" }] } });
    await P.pushUpdatesNow();
    await drainAll(P);
    msgs = await history(cara);
    assert.deepEqual(Object.keys(msgs.find((m) => m.id === hello.id).reactions || {}), ["\u{1F525}"], "the Telegram reaction is cara's reaction on the site");
    assert.ok(msgs.find((m) => m.id === hello.id).reactions["\u{1F525}"].mine);
    c = since().filter((x) => x.method === "setMessageReaction");
    assert.deepEqual(c.map((x) => [x.body.chat_id, x.body.reaction[0].emoji]), [["7001", "\u{1F525}"]], "gus's chat shows it; the reacting chat is not echoed");

    api.state.updates.push({ update_id: 103, message: { message_id: 901, chat: { id: 7002, type: "private" }, caption: "chart attached",
      photo: [{ file_id: "ph1", file_size: PNG.length }] } });
    await P.pushUpdatesNow();
    await drainAll(P);
    msgs = await history(gus);
    const pic = msgs.find((m) => m.body === "chart attached");
    assert.ok(pic && pic.file && pic.file.mime === "image/png" && pic.file.inline, "the photo landed in the attachment store, sniffed");
    c = since();
    assert.deepEqual(c.map((x) => x.method), ["getFile", "download", "sendPhoto"], "fetched once, then mirrored to gus as a photo");
    assert.equal(c[2].body.chat_id, "7001");
    assert.ok(c[2].body.photo instanceof Blob && c[2].body.photo.size === PNG.length);
    assert.match(c[2].body.caption, /chart attached/);

    // ---- site → Telegram attachment, and moderation through the mirror ----
    const up = JSON.parse((await post("/api/dm/upload", { thread: T, name: "notes.txt", data: Buffer.from("levels: 180 / 200\n").toString("base64") }, gus)).body);
    assert.ok(up.ok, JSON.stringify(up));
    const doc = JSON.parse((await post("/api/dm", { thread: T, body: "my levels", fileId: up.file.id }, gus)).body).message;
    await drainAll(P);
    c = since().filter((x) => x.method === "sendDocument");
    assert.equal(c.length, 2, "a .txt goes as a document to both chats");
    assert.ok(c.every((x) => x.body.document instanceof Blob && x.body.document.name === "notes.txt" && /my levels/.test(x.body.caption)));
    assert.equal((await post("/api/dm", { id: doc.id, body: "my levels (v2)" }, gus)).statusCode, 200);
    await drainAll(P);
    c = since();
    assert.deepEqual(c.map((x) => x.method), ["editMessageCaption", "editMessageCaption"], "a file's words are its caption");
    assert.match(c[0].body.caption, /my levels \(v2\)/);

    assert.equal((await post("/api/dm", { id: phone.id, body: "moderated" }, gus)).statusCode, 200, "the operator edits cara's line");
    await drainAll(P);
    c = since();
    assert.deepEqual(c.map((x) => [x.method, x.body.chat_id]), [["editMessageText", "7001"]], "a line typed in Telegram cannot be edited there by the bot");
    assert.match(c[0].body.text, /edited by gus/);

    // ---- deletes: a whole message, a line typed at the bot, and a packed message that shrinks ----
    assert.equal((await post("/api/dm", { drop: true, id: hello.id }, gus)).statusCode, 200);
    await drainAll(P);
    c = since();
    assert.deepEqual(c.map((x) => [x.method, x.body.chat_id, x.body.message_id]).sort(), [["deleteMessage", "7001", tgOf["7001"]], ["deleteMessage", "7002", tgOf["7002"]]]);
    assert.equal((await post("/api/dm", { drop: true, id: phone.id }, cara)).statusCode, 200);
    await drainAll(P);
    c = since();
    assert.deepEqual(c.map((x) => [x.method, x.body.chat_id, x.body.message_id]).sort(), [["deleteMessage", "7001", phoneOnGus], ["deleteMessage", "7002", 900]],
      "the bot deletes its copy AND the member's own line in their private chat");

    // A pack: cara's chat is blocked while two lines land, then re-linked; the catch-up is one message.
    api.state.fail.push({ method: "sendMessage", chat: 7002, status: 403, description: "Forbidden: bot was blocked by the user" });
    const l1 = JSON.parse((await post("/api/dm", { thread: T, body: "pack one" }, gus)).body).message;
    await drainAll(P);
    JSON.parse((await post("/api/dm", { thread: T, body: "pack two" }, gus)).body);
    await drainAll(P);
    P.pushBindNow(P.pushMintCode(caraUid, false).code, 7002, "cara");
    since();
    const l3 = JSON.parse((await post("/api/dm", { thread: T, body: "pack three" }, gus)).body).message;
    await drainAll(P);
    c = since().filter((x) => x.body.chat_id === "7002");
    assert.equal(c.length, 1, "the backlog went as ONE packed message");
    assert.ok(/pack two/.test(c[0].body.text) && /pack three/.test(c[0].body.text));
    const packId = c[0].id;
    assert.equal((await post("/api/dm", { drop: true, id: l3.id }, gus)).statusCode, 200);
    await drainAll(P);
    c = since().filter((x) => x.body.chat_id === "7002");
    assert.deepEqual(c.map((x) => [x.method, x.body.message_id]), [["editMessageText", packId]], "a delete inside a pack shrinks it");
    assert.ok(/pack two/.test(c[0].body.text) && !/pack three/.test(c[0].body.text));
    // A reaction on a packed message would claim every line in it: not set.
    await post("/api/dm", { react: true, id: l1.id, emoji: "\u{1F440}" }, cara);
    await drainAll(P);
    assert.ok(!since().some((x) => x.method === "setMessageReaction" && x.body.chat_id === "7002" && x.body.message_id === packId));

    // A refusal from Telegram on an edit is logged and skipped; the chat keeps working.
    api.state.fail.push({ method: "editMessageText", status: 400, description: "Bad Request: message is not modified" });
    const l4 = JSON.parse((await post("/api/dm", { thread: T, body: "four" }, gus)).body).message;
    await drainAll(P);
    await post("/api/dm", { id: l4.id, body: "four!" }, gus);
    await drainAll(P);
    since();
    assert.equal((await post("/api/dm", { thread: T, body: "still flowing" }, gus)).statusCode, 200);
    await drainAll(P);
    assert.equal(since().filter((x) => x.method === "sendMessage").length, 2, "the next line still reaches both chats");

    // ---- (build 2026.09.24-107) an edit or a delete made BEFORE Telegram confirmed the send ----
    // The map row is written only in onSent, so the repaint found nothing and the queued send went
    // out with the words captured at enqueue. The queued part now carries its row ids and is rebuilt
    // from the current rows when the drain reaches it.
    const e1 = JSON.parse((await post("/api/dm", { thread: T, body: "typo'd line" }, gus)).body).message;
    assert.equal((await post("/api/dm", { id: e1.id, body: "fixed line" }, gus)).statusCode, 200);   // still queued
    await drainAll(P);
    c = since();
    assert.deepEqual(c.map((x) => x.method), ["sendMessage", "sendMessage"], "one send per chat, no repaint needed");
    assert.ok(c.every((x) => /fixed line/.test(x.body.text) && !/typo'd/.test(x.body.text) && /edited/.test(x.body.text)), "the current wording goes out");
    const d1 = JSON.parse((await post("/api/dm", { thread: T, body: "regretted line" }, gus)).body).message;
    assert.equal((await post("/api/dm", { drop: true, id: d1.id }, gus)).statusCode, 200);
    await drainAll(P);
    assert.deepEqual(since(), [], "a line deleted before its send never reaches the phone");
    const up2 = JSON.parse((await post("/api/dm/upload", { thread: T, name: "gone.txt", data: Buffer.from("secret levels\n").toString("base64") }, gus)).body);
    const f1 = JSON.parse((await post("/api/dm", { thread: T, body: "file then regret", fileId: up2.file.id }, gus)).body).message;
    assert.equal((await post("/api/dm", { drop: true, id: f1.id }, gus)).statusCode, 200);
    await drainAll(P);
    assert.deepEqual(since(), [], "a deleted attachment is neither uploaded nor replaced by its (deleted) words");
  } finally {
    await app.close();
    globalThis.fetch = realFetch;
  }
});
