"use strict";
// accounts.js — identity, invites, messages. Split out of test.js (build 2026.09.16-80); order within the file is the original order.
const test = require("node:test");
const assert = require("node:assert");
const { HOUR, C, freshAccounts } = require("./_shared");

// The account-creating fixtures live here now, not in _shared.js: hashPw runs on the threadpool
// (security batch 2026.09.20), so bootstrap/redeem/claim/login/setPassword/otpVerify are async and
// every seed has to be awaited. TODO(_shared.js owner): seedTwo/seedDesk there are the pre-async
// copies and nothing imports them any more — delete them or make them await these calls.
async function seedTwo(A) {
  const g = await A.bootstrap("gustavo", "correct-horse-battery");
  const code = A.mintInvite(g.user.uid, "for lena", 7, "join").invite.code;
  const l = await A.redeem(code, "lena", "another-long-password");
  return { g: g.user, l: l.user, gTok: g.token, lTok: l.token };
}
async function seedDesk(marks) {
  const A = freshAccounts(marks);
  const g = (await A.bootstrap("gus", "correct-horse-battery")).user;
  const mk = async (h) => (await A.redeem(A.mintInvite(g.uid, null, 7, "join").invite.code, h, "another-long-password")).user;
  return { A, g, l: await mk("lena"), m: await mk("marco"), d: await mk("dan") };
}


test("accounts: the first account is the operator, and bootstrap closes behind it", async () => {
  const A = freshAccounts();
  assert.equal(A.countUsers(), 0, "a fresh volume has no accounts");
  const first = await A.bootstrap("gustavo", "correct-horse-battery");
  assert.ok(first.ok && first.user.isAdmin, "account #1 is the operator — otherwise a fresh deploy has nobody who can invite");
  assert.ok(!(await A.bootstrap("someone", "correct-horse-battery")).ok, "bootstrap must refuse once any account exists");
  // Handle rules: the identity is lowercase, the display keeps what was typed, reserved names are out.
  const code = A.mintInvite(first.user.uid, null, 7, "join").invite.code;
  assert.ok(!(await A.redeem(code, "Admin", "another-long-password")).ok, "reserved handles are refused — 'admin' in a DM list is a phishing surface");
  assert.ok(!(await A.redeem(code, "x", "another-long-password")).ok, "a one-character handle is refused");
  assert.ok(!(await A.redeem(code, "lena", "short")).ok, "a short password is refused");
  assert.equal(A.readInvite(code).state, "open", "a REFUSED attempt must not burn the invite — otherwise a typo costs a link");
  const good = await A.redeem(code, "Lena", "another-long-password");
  assert.ok(good.ok && good.user.display === "Lena" && good.user.handle === "lena",
    "display keeps its case, the handle is the lowercase identity");
});

test("invites: single-use is enforced by the write, not the check", async () => {
  const A = freshAccounts();
  const g = await A.bootstrap("gustavo", "correct-horse-battery");
  const code = A.mintInvite(g.user.uid, "for lena", 7, "join").invite.code;
  // Both callers read `usedBy IS NULL` before either writes — which is exactly the race the
  // transaction exists for. The second must lose, and must lose with a message, not a crash.
  assert.ok((await A.redeem(code, "lena", "another-long-password")).ok);
  const second = await A.redeem(code, "marco", "another-long-password");
  assert.ok(!second.ok && /already been used/.test(second.error), "the loser gets 'already used', not a duplicate account");
  assert.equal(A.countUsers(), 2, "exactly one account came out of one invite");
  assert.equal(A.readInvite(code).state, "used");

  // Expiry and revocation are separate exits, and neither deletes the row: "who let whom in" has
  // to stay answerable a year later.
  const dead = A.mintInvite(g.user.uid, null, 7, "join").invite.code;
  assert.ok(A.revokeInvite(dead).ok);
  assert.equal(A.readInvite(dead).state, "revoked");
  assert.ok(!(await A.redeem(dead, "zed", "another-long-password")).ok, "a revoked link stops working immediately");
  assert.ok(!A.revokeInvite(code).ok, "an already-spent invite cannot be revoked");
  assert.ok(A.listInvites().length >= 2, "spent and revoked rows are kept as the audit trail");
});

test("invites: a code survives being read down a phone line", () => {
  const { mintCode, normCode } = require("../src/accounts");
  const c = mintCode();
  assert.ok(/^MILST(-[0-9A-HJKMNP-TV-Z]{4}){3}$/.test(c), "Crockford base32 in four groups, no I/L/O/U");
  assert.equal(normCode(c.toLowerCase()), c, "lowercase is accepted");
  assert.equal(normCode(c.replace(/-/g, " ")), c, "spaces for dashes are accepted");
  assert.equal(normCode("milst-OIOI-2345-6789"), "MILST-0101-2345-6789", "O and I are coerced to 0 and 1, which is why they are not in the alphabet");
  assert.equal(normCode("nonsense"), "", "a malformed code is rejected, not guessed at");
});

test("accounts: an invite adopts the browser's existing alert handle as the uid", async () => {
  // This is the whole migration. Every alert recipient and every alert rule is keyed by the signed
  // xyzown handle; reusing it as the account id carries them across with no rewrite at all. Get
  // this wrong and every early member silently loses their Telegram links.
  const A = freshAccounts();
  const g = await A.bootstrap("gustavo", "correct-horse-battery");
  const code = A.mintInvite(g.user.uid, null, 7, "join").invite.code;
  const PRIOR = "aLegacyOwnerHandle";
  const r = await A.redeem(code, "lena", "another-long-password", PRIOR);
  assert.ok(r.ok && r.adopted, "redeem reports that it carried the handle over");
  assert.equal(r.user.uid, PRIOR, "the uid IS the old handle — nothing to migrate");

  // But never at the cost of colliding with an account that already holds it.
  const code2 = A.mintInvite(g.user.uid, null, 7, "join").invite.code;
  const r2 = await A.redeem(code2, "marco", "another-long-password", PRIOR);
  assert.ok(r2.ok && r2.user.uid !== PRIOR, "a taken handle falls back to a fresh id instead of colliding");
});

test("sessions: the epoch field is the whole revocation story", async () => {
  const A = freshAccounts();
  const { l } = await seedTwo(A);
  const tok = (await A.login("lena", "another-long-password")).token;
  assert.ok(A.sessionUser(tok), "a fresh token verifies");
  assert.equal(A.sessionUser(tok.slice(0, -2) + "xy"), null, "a tampered mac is refused");
  assert.equal(A.sessionUser("nonsense"), null, "garbage is refused");
  assert.equal(A.sessionUser(""), null, "an empty token is refused");

  A.signOutEverywhere(l.uid);
  assert.equal(A.sessionUser(tok), null, "signing out everywhere kills outstanding tokens — stateless, but revocable");
  const tok2 = (await A.login("lena", "another-long-password")).token;
  assert.ok(A.sessionUser(tok2), "and a fresh sign-in works immediately after");

  A.setDisabled(l.uid, true);
  assert.equal(A.sessionUser(tok2), null, "a disabled account's live sessions stop verifying");
  assert.ok(!(await A.login("lena", "another-long-password")).ok, "and it cannot sign back in");
  A.setDisabled(l.uid, false);
  assert.ok((await A.login("lena", "another-long-password")).ok, "re-enabling restores it");

  // Changing a password must invalidate everything else, or it is not a reset.
  const before = (await A.login("lena", "another-long-password")).token;
  await A.setPassword(l.uid, "brand-new-password-9");
  assert.equal(A.sessionUser(before), null, "a password change signs out every other device");
  assert.ok(!(await A.login("lena", "another-long-password")).ok, "the old password is dead");
  assert.ok((await A.login("lena", "brand-new-password-9")).ok, "the new one works");
});

test("rename: display only — every surface follows, the sign-in handle never moves", async () => {
  const A = freshAccounts();
  const { g, l } = await seedTwo(A);
  const T = A.threadFor(g.uid, l.uid, true).id;
  A.send(l.uid, null, "call me maybe", null, { thread: T });
  const tok = (await A.login("lena", "another-long-password")).token;

  assert.ok(!A.renameUser(l.uid, "admin").ok, "reserved names stay reserved, display or not");
  assert.ok(!A.renameUser(l.uid, "Gustavo").ok, "another member's handle is not available as a display");
  assert.ok(!A.renameUser(l.uid, "x").ok, "too short is too short");
  assert.ok(!A.renameUser("nobody", "fine name").ok, "no such account is an error, not a create");

  const r = A.renameUser(l.uid, "  El   Vaquero 🤠 ");
  assert.ok(r.ok, r.error);
  assert.equal(r.user.display, "El Vaquero 🤠", "a display is looser than a handle — spaces collapse, typing survives");
  assert.equal(r.user.handle, "lena", "the sign-in handle is UNTOUCHED");

  assert.ok(!A.renameUser(g.uid, "el vaquero 🤠").ok, "two members must not read identically");
  assert.equal(A.sessionUser(tok).uid, l.uid, "her sessions survive");
  assert.equal(A.history(g.uid, T).messages.find((m) => !m.sys && !m.mine).sender, "El Vaquero 🤠",
    "old messages attribute to the new display — names resolve at read, never stored");
  assert.equal(A.threads(g.uid).find((t) => t.id === T).name, "El Vaquero 🤠", "the conversation retitles for the other side");
  assert.ok((await A.login("lena", "another-long-password")).ok, "she still signs in as lena, same password");
});

test("revocation costs nobody else anything", async () => {
  // The point of the whole exercise. Under the shared password, removing one person meant rotating
  // SITE_PASSWORD — which also re-derived OWNER_SECRET and orphaned EVERY member's alert links.
  const A = freshAccounts();
  const { g, l } = await seedTwo(A);
  const gTok = (await A.login("gustavo", "correct-horse-battery")).token;
  A.setDisabled(l.uid, true);
  assert.ok(A.sessionUser(gTok), "disabling one member leaves everyone else signed in");
  assert.equal(A.getUser(g.uid).epoch, 1, "and does not touch anybody else's epoch");
});

test("messages: a message carries the mark it was sent at", async () => {
  // The one thing Telegram cannot do, and the reason this tab exists at all.
  const marks = { PLTR: 113.9 };
  const A = freshAccounts(marks);
  const { g, l } = await seedTwo(A);
  const resolve = (sym) => (marks[sym] ? sym : null);
  const sent = A.send(g.uid, l.uid, "funding on $PLTR just flipped hard", resolve);
  assert.ok(sent.ok);
  assert.equal(sent.message.ref, "PLTR");
  assert.equal(sent.message.refPx, 113.9, "the stamp is the mark at send");

  // The move since is DERIVED at read, never stored — otherwise it would need a write every 15s.
  marks.PLTR = 118.5;
  const read = A.sync(l.uid, 0).messages[0];
  assert.equal(read.refPx, 113.9, "the stamp never moves");
  assert.equal(read.px, 118.5, "the live mark is read fresh");

  // An edit rewrites the body and nothing else: the claim was made at that price.
  A.edit(g.uid, sent.id, "funding on $PLTR flipped, taking the other side");
  const edited = A.sync(l.uid, 0).messages[0];
  assert.equal(edited.refPx, 113.9, "editing does not relocate the claim");
  assert.ok(edited.edited, "but the rewrite is disclosed");

  // A symbol the server does not know stays plain text rather than being stamped with nothing.
  const plain = A.send(g.uid, l.uid, "what about $NOTACOIN", resolve);
  assert.equal(plain.message.ref, null, "an unknown symbol is not stamped");
  assert.equal(A.send(g.uid, l.uid, "it cost $5", resolve).message.ref, null, "a dollar amount is not a ticker");
});

test("messages: a thread belongs to exactly two people and nobody else", async () => {
  const A = freshAccounts();
  const { g, l } = await seedTwo(A);
  const m = (await A.redeem(A.mintInvite(g.uid, null, 7, "join").invite.code, "marco", "another-long-password")).user;
  const sent = A.send(g.uid, l.uid, "between us");
  const tid = sent.thread;

  assert.equal(A.threadFor(g.uid, l.uid, false).id, A.threadFor(l.uid, g.uid, false).id,
    "canonical pair ordering means one thread per pair, whichever way round you ask");
  assert.equal(A.threads(m.uid).length, 0, "a third party sees no thread");
  assert.ok(!A.history(m.uid, tid).ok, "cannot read it by id");
  assert.ok(!A.markRead(m.uid, tid, 1).ok, "cannot mark it read");
  assert.ok(!A.setMuted(m.uid, tid, true).ok, "cannot mute it");
  assert.equal(A.sync(m.uid, 0).messages.length, 0, "and sync hands them nothing");
  assert.ok(!A.edit(l.uid, sent.id, "hijacked").ok, "cannot edit somebody else's message");
  assert.ok(!A.drop(l.uid, sent.id).ok, "cannot delete somebody else's message");
  assert.ok(!A.send(g.uid, g.uid, "hello me").ok, "cannot message yourself");
});

test("messages: delete is a tombstone, because the id is the other side's cursor", async () => {
  const A = freshAccounts();
  const { g, l } = await seedTwo(A);
  const a = A.send(g.uid, l.uid, "first");
  const b = A.send(g.uid, l.uid, "second");
  A.drop(g.uid, a.id);
  const seen = A.sync(l.uid, 0).messages;
  assert.equal(seen.length, 2, "the row survives — removing it would make their next sync skip a beat");
  assert.ok(seen[0].deleted && seen[0].body === "", "the body is gone but the position is not");
  assert.equal(seen[1].id, b.id);
});

test("messages: the sync cursor is authoritative, so a dropped frame costs nothing", async () => {
  const A = freshAccounts();
  const { g, l } = await seedTwo(A);
  A.send(g.uid, l.uid, "one"); A.send(g.uid, l.uid, "two");
  const first = A.sync(l.uid, 0);
  assert.equal(first.messages.length, 2);
  assert.ok(first.messages.every((m, i, arr) => i === 0 || arr[i - 1].id < m.id), "ordered by the global id");
  assert.equal(A.sync(l.uid, first.cursor).messages.length, 0, "nothing new past the cursor");
  A.send(g.uid, l.uid, "three");
  assert.equal(A.sync(l.uid, first.cursor).messages.length, 1, "a client that missed a push catches up from its own cursor");
});

test("messages: unread counting, and a read cursor that cannot run into the future", async () => {
  const A = freshAccounts();
  const { g, l } = await seedTwo(A);
  A.send(g.uid, l.uid, "one"); A.send(g.uid, l.uid, "two");
  assert.equal(A.threads(l.uid)[0].unread, 2, "the recipient has two unread");
  assert.equal(A.threads(g.uid)[0].unread, 0, "your own messages are read by definition");

  // An unclamped cursor from the client would let a caller mark itself read PAST messages that do
  // not exist yet — permanently zeroing its own unread count and silencing every future escalation.
  A.markRead(l.uid, A.threads(l.uid)[0].id, 999999);
  assert.equal(A.threads(l.uid)[0].unread, 0);
  A.send(g.uid, l.uid, "three");
  assert.equal(A.threads(l.uid)[0].unread, 1, "a read receipt for the future must not suppress real messages");
});

test("messages: escalation waits, skips whoever is online, and never repeats", async () => {
  const A = freshAccounts();
  const { g, l } = await seedTwo(A);
  A.send(g.uid, l.uid, "are you there");
  const nobodyOnline = () => false;

  assert.equal(A.pendingEscalations(60000, nobodyOnline).length, 0,
    "the delay IS the feature — without it two people typing at each other push per line");
  const due = A.pendingEscalations(0, nobodyOnline).filter((e) => e.uid === l.uid);
  assert.equal(due.length, 1, "past the delay it is due");
  assert.equal(due[0].n, 1);
  assert.ok(due[0].lines[0].includes("are you there"), "the digest carries the text, truncated");

  assert.ok(A.pendingEscalations(0, (uid) => uid === l.uid).every((e) => e.uid !== l.uid),
    "somebody with the terminal open is not missing anything");

  due.forEach((e) => A.markEscalated(e.uid, e.thread, e.upTo));
  assert.ok(A.pendingEscalations(0, nobodyOnline).every((e) => e.uid !== l.uid), "and it never fires twice for the same messages");

  A.setMuted(l.uid, A.threads(l.uid)[0].id, true);
  A.send(g.uid, l.uid, "still here");
  assert.ok(A.pendingEscalations(0, nobodyOnline).every((e) => e.uid !== l.uid), "a muted thread never escalates");
});

test("messages: bodies are cleaned at the write and never stored pre-escaped", () => {
  const { cleanBody, DM_MAX_LEN } = require("../src/accounts");
  assert.equal(cleanBody("a" + String.fromCharCode(7) + "b"), "ab", "control characters are stripped");
  assert.equal(cleanBody("one\r\ntwo"), "one\ntwo", "CRLF is normalised");
  assert.equal(cleanBody("one\n\n\n\n\n\ntwo"), "one\n\n\ntwo", "runs of blank lines collapse but paragraphs survive");
  assert.equal(cleanBody("x".repeat(99999)).length, DM_MAX_LEN, "bodies are capped");
  // Escaping belongs at render. Storing pre-escaped text means every other consumer — the Telegram
  // digest, a future export — has to un-escape it first, and one of them will forget.
  assert.equal(cleanBody("<b>not markup</b>"), "<b>not markup</b>", "markup is stored verbatim, escaped by the renderer");
});

test("topic boards: open threads anyone can discover, join and post in", async () => {
  const A = freshAccounts({ "xyz:HOOD": 113.2 });
  const { g, l } = await seedTwo(A);

  const b = A.createBoard(g.uid, "  HOOD   thesis  ");
  assert.ok(b.ok, "the operator opens a topic");
  assert.ok(!A.createBoard(g.uid, "   ").ok, "a topic needs a name");

  // Discoverable before joining — that is what separates a board from a group…
  const seen = A.listBoards(l.uid).find((x) => x.id === b.thread);
  assert.ok(seen && seen.title === "HOOD thesis" && seen.joined === false, "everyone sees the board, whitespace collapsed");
  // …but reading and writing still ride membership, exactly like a group: joining GRANTS them, so
  // no authorization path learned a new case.
  assert.ok(!A.history(l.uid, b.thread).ok, "no read before joining");
  assert.ok(!A.send(l.uid, "", "hi there", null, { thread: b.thread }).ok, "no write before joining");

  assert.ok(A.joinBoard(l.uid, b.thread).ok, "anyone may join themselves");
  assert.ok(A.joinBoard(l.uid, b.thread).already, "joining twice is a no-op, not an error");
  const s = A.send(l.uid, "", "I think $HOOD runs", (x) => "xyz:" + x, { thread: b.thread });
  assert.ok(s.ok && s.message.refPx === 113.2, "a post stamps its mark like any message");
  const h = A.history(l.uid, b.thread);
  assert.ok(h.ok && h.messages.some((m) => m.sys === "joined"), "the join is on the record as a system line");
  assert.equal(A.listBoards(l.uid).find((x) => x.id === b.thread).members, 2, "the member count moves");
  assert.ok(A.renameGroup(g.uid, b.thread, "HOOD thesis v2").ok, "the creator can rename a board like a group");

  // A DM can never be joined through this door.
  const dm = A.threadFor(g.uid, l.uid, true);
  assert.ok(!A.joinBoard(g.uid, dm.id).ok, "joinBoard refuses anything that is not a board");
});

test("groups: membership is a table, and it is the authorization", async () => {
  const { A, g, l, m, d } = await seedDesk();
  const T = A.createGroup(g.uid, "  Desk   Chat ", [l.uid, m.uid]).thread;
  assert.equal(A.history(g.uid, T).info.title, "Desk Chat", "whitespace in a title is normalised at the write");
  assert.ok(!A.createGroup(g.uid, "alone", []).ok, "a group needs somebody else in it");
  assert.ok(!A.createGroup(g.uid, "  ", [l.uid]).ok, "a group needs a name");

  // The outsider checks are the whole feature: a thread id is a row name, never a grant.
  assert.ok(!A.history(d.uid, T).ok, "an outsider cannot read it");
  assert.ok(!A.send(d.uid, null, "hi", null, { thread: T }).ok, "an outsider cannot post to it");
  assert.ok(!A.markRead(d.uid, T, 1).ok, "an outsider cannot mark it read");
  assert.ok(!A.setMuted(d.uid, T, true).ok, "an outsider cannot mute it");
  assert.equal(A.sync(d.uid, 0).messages.filter((x) => x.thread === T).length, 0, "and sync hands them nothing from it");

  const sent = A.send(g.uid, null, "morning all", null, { thread: T });
  assert.ok(sent.ok, sent.error);
  assert.ok(A.sync(m.uid, 0).messages.some((x) => x.id === sent.id), "every member receives it");
});

test("groups: only the owner manages, and ownership is never stranded", async () => {
  const { A, g, l, m, d } = await seedDesk();
  const T = A.createGroup(g.uid, "Desk", [l.uid, m.uid]).thread;
  assert.ok(!A.addMembers(l.uid, T, [d.uid]).ok, "a member cannot add");
  assert.ok(!A.removeMember(l.uid, T, m.uid).ok, "a member cannot remove");
  assert.ok(!A.renameGroup(l.uid, T, "hijack").ok, "a member cannot rename");
  assert.ok(A.addMembers(g.uid, T, [d.uid]).ok, "the owner can");
  assert.ok(!A.removeMember(g.uid, T, g.uid).ok, "the owner cannot remove themselves — that is what leaving is");

  // Membership changes are ordinary rows with `sys` set, so they ride the same cursor a message
  // does. A second channel for them would be a second thing to keep in sync.
  assert.ok(A.history(g.uid, T).messages.some((x) => x.sys === "added" && x.body.includes("dan")),
    "adding somebody is recorded in the conversation itself");
  assert.equal(A.threads(d.uid).find((t) => t.id === T).unread, 0,
    "arriving in a group does not open on a wall of unread backscroll");
  assert.ok(A.history(d.uid, T).messages.some((x) => x.body === "morning all") ||
            A.history(d.uid, T).ok, "but the backscroll is readable");

  A.removeMember(g.uid, T, d.uid);
  assert.ok(!A.history(d.uid, T).ok, "a removed member loses the thread entirely");
  A.leaveGroup(g.uid, T);
  // WHICH member inherits is deliberately not asserted — it is the longest-standing one, and with
  // a tie at group creation that is arbitrary. What must always hold is that somebody has it.
  const survivors = A.history(l.uid, T);
  assert.ok(survivors.ok, "the group outlives its creator");
  assert.ok(survivors.info.members.some((x) => x.owner),
    "the last owner leaving hands ownership on, so a group is never unmanageable");
  assert.ok(!A.renameGroup(g.uid, A.threadFor(g.uid, l.uid, true).id, "no").ok, "a direct message is not a group");
});

test("reactions: a fixed vocabulary, and it names who", async () => {
  const { A, g, l, m } = await seedDesk();
  const s = A.send(g.uid, l.uid, "the print was ugly");
  const r = A.react(l.uid, s.id, "\u{1F44D}");
  assert.ok(r.ok, r.error);
  assert.equal(r.message.reactions["\u{1F44D}"].n, 1);
  assert.equal(r.message.reactions["\u{1F44D}"].mine, true);
  assert.equal(r.message.reactions["\u{1F44D}"].who[0], "lena", "a count alone is a vote; who reacted is the information");
  assert.equal(A.react(l.uid, s.id, "\u{1F44D}").message.reactions, null, "reacting again toggles it off");
  // Free text here would be a second, worse message field: unbounded and rendered where there is
  // no room for it.
  assert.ok(!A.react(l.uid, s.id, "<script>alert(1)</script>").ok, "arbitrary text is not a reaction");
  assert.ok(!A.react(l.uid, s.id, "").ok, "nor is nothing");
  assert.ok(!A.react(m.uid, s.id, "\u{1F44D}").ok, "somebody outside the thread cannot react to it");
});

test("attachments: the type comes from OUR sniff, and svg never renders inline", async () => {
  const { A, g, l, m } = await seedDesk();
  const T = A.threadFor(g.uid, l.uid, true).id;
  const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4E, 0x47, 13, 10, 26, 10]), Buffer.alloc(32)]);

  const good = A.putFile(g.uid, T, "chart.png", png);
  assert.ok(good.ok && good.file.mime === "image/png" && good.file.inline === 1, "a real png renders inline");

  // The allowlist IS the policy now: images and .txt only, everything else refused at upload —
  // an SVG (a document with a <script> element in it), a lying extension, a zip, a video: no
  // second-class download lane, just a no.
  const svg = A.putFile(g.uid, T, "logo.svg", Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>'));
  assert.ok(!svg.ok, "svg is refused outright");
  const liar = A.putFile(g.uid, T, "totally.png", Buffer.from("<html><script>alert(1)</script></html>"));
  assert.ok(!liar.ok, "a lying extension buys nothing — the bytes decide");
  assert.ok(!A.putFile(g.uid, T, "clip.zip", Buffer.from([0x50, 0x4B, 0x03, 0x04, 1, 2, 3])).ok, "archives are refused");
  assert.ok(!A.putFile(g.uid, T, "doc.pdf", Buffer.from("%PDF-1.4 whatever")).ok, "PDFs are refused too");
  const note = A.putFile(g.uid, T, "levels.TXT", Buffer.from("HOOD 113.90 entry\nstop 109\n"));
  assert.ok(note.ok && note.file.mime.startsWith("text/plain") && note.file.inline === 0,
    "a real .txt is accepted, typed text/plain, and downloads rather than rendering");
  assert.ok(!A.putFile(g.uid, T, "fake.txt", Buffer.from([0x00, 0x01, 0x02, 65, 66])).ok,
    "binary bytes named .txt are refused — the extension is a claim, not evidence");

  // Voice notes: the recorder's containers by magic bytes, hard-capped small — the cap is what
  // keeps audio from becoming the video lane through the back door.
  const ogg = Buffer.concat([Buffer.from("OggS"), Buffer.alloc(64)]);
  const voice = A.putFile(g.uid, T, "voice-1201.ogg", ogg);
  assert.ok(voice.ok && voice.file.mime === "audio/ogg", "an ogg voice note is accepted and typed audio");
  const webm = Buffer.concat([Buffer.from([0x1A, 0x45, 0xDF, 0xA3]), Buffer.alloc(64)]);
  assert.equal(A.putFile(g.uid, T, "voice.webm", webm).file.mime, "audio/webm", "webm by magic bytes AND extension");
  assert.ok(!A.putFile(g.uid, T, "clip.mov", webm).ok, "EBML bytes without the audio extension stay refused — a renamed video buys nothing");
  assert.ok(!A.putFile(g.uid, T, "long.ogg", Buffer.concat([Buffer.from("OggS"), Buffer.alloc(4 * 1024 * 1024)])).ok,
    "audio past 3 MB is refused");

  assert.ok(A.putFile(g.uid, T, "../../etc/passwd", png).file.name.indexOf("/") < 0,
    "a filename is a label, and cannot contain a path separator");
  assert.ok(!A.putFile(g.uid, T, "x", Buffer.alloc(0)).ok, "an empty file is refused");
  assert.ok(!A.putFile(g.uid, T, "x", Buffer.alloc(9 * 1024 * 1024)).ok, "an oversized file is refused");
  assert.ok(!A.putFile(m.uid, T, "x", png).ok, "somebody outside the thread cannot upload into it");

  // Reading is a membership check, never a "knows the id" check: a forwarded link is not a grant.
  assert.ok(A.readFile(l.uid, good.file.id).ok, "the other member can read it");
  assert.ok(!A.readFile(m.uid, good.file.id).ok, "an outsider cannot, even holding the id");
  assert.ok(!A.send(l.uid, null, "mine now", null, { thread: T, fileId: good.file.id }).ok,
    "and cannot attach somebody else's upload to their own message");

  const msg = A.send(g.uid, null, "here", null, { thread: T, fileId: good.file.id });
  assert.equal(msg.message.file.name, "chart.png");
  A.drop(g.uid, msg.id);
  assert.equal(A.history(l.uid, T).messages.find((x) => x.id === msg.id).file, null,
    "deleting a message takes its attachment off the wire with it");
});

test("search: the scope is the authorization", async () => {
  const { A, g, l, m } = await seedDesk();
  A.send(g.uid, l.uid, "the funding print was ugly");
  A.send(g.uid, m.uid, "a different conversation entirely");
  assert.equal(A.search(l.uid, "funding").results.length, 1, "finds your own messages");
  assert.ok(A.search(l.uid, "funding").results[0].threadName, "and says which conversation they were in");
  assert.equal(A.search(m.uid, "funding").results.length, 0, "and cannot reach a thread you are not in");
  assert.equal(A.search(l.uid, "f").results.length, 0, "a one-character query is not a search");

  // LIKE means the wildcards are live unless escaped — a query of "%" would otherwise return
  // every message the caller can see.
  A.send(g.uid, l.uid, "100% sure");
  assert.equal(A.search(l.uid, "100%").results.length, 1, "a percent sign is a literal");
  assert.equal(A.search(l.uid, "%").results.length, 0, "a bare wildcard matches nothing, rather than everything");
  assert.equal(A.search(l.uid, "a_b").results.length, 0, "an underscore is a literal too");
  const del = A.send(g.uid, l.uid, "forget I said this");
  A.drop(g.uid, del.id);
  assert.equal(A.search(l.uid, "forget I said").results.length, 0, "a deleted message is not searchable");
});

test("the telegram bridge is command-only, and cannot reach a thread you left", async () => {
  const { A, g, l, m } = await seedDesk();
  const T = A.createGroup(g.uid, "Desk", [l.uid, m.uid]).thread;
  const dm = A.threadFor(g.uid, l.uid, true).id;

  const byHandle = A.bridgeReply(l.uid, "@gus from my phone", 0);
  assert.ok(byHandle.ok, byHandle.error);
  assert.equal(byHandle.message.via, "telegram", "a bridged message says where it came from");
  assert.ok(!A.bridgeReply(l.uid, "@nobody hello", 0).ok, "an unknown handle is refused");
  // Without a handle and without context there is nothing to answer — and guessing would be the
  // worst possible failure, since the message posts under the sender's name.
  assert.ok(!A.bridgeReply(l.uid, "just talking to myself", 0).ok, "no target means no send");
  assert.ok(A.bridgeReply(l.uid, "in context", dm).ok, "with context it answers that thread");
  assert.ok(!A.bridgeReply(l.uid, "   ", dm).ok, "an empty body is refused");

  A.leaveGroup(m.uid, T);
  assert.ok(!A.bridgeReply(m.uid, "still here?", T).ok, "a stale context cannot reach a thread you have left");
  A.setDisabled(l.uid, true);
  assert.ok(!A.bridgeReply(l.uid, "@gus hello", 0).ok, "a disabled account cannot send over the bridge");
});

test("the pair schema migrates onto the membership table without losing a conversation", () => {
  // Phase 1 shipped dm_thread(a, b). A schema change that silently drops conversations is not
  // something to discover in production, so the lift is exercised on a database built the old way.
  const fs = require("fs"), os = require("os"), path = require("path");
  const { DatabaseSync } = require("node:sqlite");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "acct-mig-"));
  const db = new DatabaseSync(path.join(dir, "accounts.db"));
  db.exec(`CREATE TABLE user (uid TEXT PRIMARY KEY, handle TEXT NOT NULL, display TEXT NOT NULL,
    pw TEXT NOT NULL, epoch INTEGER NOT NULL DEFAULT 1, isAdmin INTEGER NOT NULL DEFAULT 0,
    createdAt INTEGER NOT NULL, invitedBy TEXT, lastSeen INTEGER NOT NULL DEFAULT 0, disabledAt INTEGER) STRICT;
    CREATE TABLE dm_thread (id INTEGER PRIMARY KEY AUTOINCREMENT, a TEXT NOT NULL, b TEXT NOT NULL,
      createdAt INTEGER NOT NULL, lastMsgId INTEGER NOT NULL DEFAULT 0, lastAt INTEGER NOT NULL DEFAULT 0) STRICT;
    CREATE TABLE dm_msg (id INTEGER PRIMARY KEY AUTOINCREMENT, thread INTEGER NOT NULL, sender TEXT NOT NULL,
      ts INTEGER NOT NULL, body TEXT NOT NULL, ref TEXT, refPx REAL, editedAt INTEGER, deletedAt INTEGER) STRICT;
    CREATE TABLE dm_read (thread INTEGER NOT NULL, uid TEXT NOT NULL, readMsgId INTEGER NOT NULL DEFAULT 0,
      muted INTEGER NOT NULL DEFAULT 0, notifiedMsgId INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (thread, uid)) STRICT, WITHOUT ROWID;`);
  const now = Date.now();
  // Rows built the old way, hashed the old way: hashPwSync is the pre-async hasher, byte-identical.
  const { hashPwSync } = require("../src/accounts");
  for (const [uid, h] of [["uidA", "ann"], ["uidB", "bo"]])
    db.prepare("INSERT INTO user (uid, handle, display, pw, createdAt) VALUES (?,?,?,?,?)").run(uid, h, h, hashPwSync("another-long-password"), now);
  db.prepare("INSERT INTO dm_thread (a, b, createdAt, lastMsgId, lastAt) VALUES (?,?,?,?,?)").run("uidB", "uidA", now, 1, now);
  db.prepare("INSERT INTO dm_msg (thread, sender, ts, body) VALUES (1,'uidA',?, 'said before the migration')").run(now);
  db.close();

  const { openAccounts } = require("../src/accounts");
  const A = openAccounts(dir, {});
  const t = A.threads("uidA");
  assert.equal(t.length, 1, "the conversation survived");
  assert.equal(t[0].name, "bo", "and still knows who it is with");
  assert.equal(A.threadFor("uidA", "uidB", false).id, 1, "the pair still resolves to the same thread, in either order");
  assert.ok(A.history("uidB", 1).messages.some((x) => x.body === "said before the migration"), "with its messages");
  assert.ok(A.send("uidA", null, "and after", null, { thread: 1 }).ok, "and it still works");
  fs.rmSync(dir, { recursive: true, force: true });
});

// ===== self-serve password reset by one-time code (build 2026.09.03-50) ========================
// No mail server exists here and adding one for a ten-person desk is not worth it — but the
// Telegram outbox already does delivery, with recipients, quiet hours and caps. These cover the
// half that is ours: issuing, throttling, and refusing.
test("reset codes: issued, single-use, and they sign out every other device", async () => {
  // Each concern gets its own account: three sends an hour is a real ceiling, and sharing one
  // account across the assertions would spend it before the interesting ones ran.
  const { A, l, m, d } = await seedDesk();
  const r = A.otpRequest("lena");
  assert.ok(r.sent && /^\d{6}$/.test(r.code), "a six-digit code is issued");
  assert.equal(r.uid, l.uid, "bound to the account, not to whatever the form says later");
  assert.ok(A.otpRequest("MARCO").sent, "the handle is matched case-insensitively");

  // One live code per account: asking again replaces the last one, so a stale code sitting in
  // somebody's chat history stops working the moment a new one is requested.
  const first = A.otpRequest("dan"), second = A.otpRequest("dan");
  assert.ok(!(await A.otpVerify("dan", first.code, "brand-new-password-1")).ok, "the superseded code is dead");
  const done = await A.otpVerify("dan", second.code, "brand-new-password-1");
  assert.ok(done.ok, done.error);
  assert.ok(!(await A.login("dan", "another-long-password")).ok, "the old password is gone");
  assert.ok((await A.login("dan", "brand-new-password-1")).ok, "the new one works");
  assert.ok(!(await A.otpVerify("dan", second.code, "brand-new-password-2")).ok, "and the code is burned");

  const tok = (await A.login("marco", "another-long-password")).token;
  const again = A.otpRequest("marco");
  assert.ok(again.sent, "marco still has sends left");
  await A.otpVerify("marco", again.code, "brand-new-password-3");
  assert.equal(A.sessionUser(tok), null, "a reset that leaves the old sessions alive is not a reset");
});

test("reset codes: a six-digit secret needs the ceilings around it", async () => {
  const { A } = await seedDesk();
  // 1e6 is small. The attempt ceiling is what makes it safe, not the length.
  const c = A.otpRequest("lena");
  for (let i = 0; i < 5; i++) assert.ok(!(await A.otpVerify("lena", "000000", "brand-new-password-1")).ok);
  assert.ok(!(await A.otpVerify("lena", c.code, "brand-new-password-1")).ok,
    "five wrong guesses kill the code, even though the sixth attempt is correct");

  let sent = 0;
  for (let i = 0; i < 6; i++) if (A.otpRequest("marco").sent) sent++;
  assert.equal(sent, 3, "three sends an hour, so this cannot be used to spam somebody's phone");
  assert.ok(A.otpRequest("marco").ok, "and being throttled still looks like success from outside");

  // Enumeration: an unknown handle must be indistinguishable from a known one.
  const ghost = A.otpRequest("nobody-at-all");
  assert.deepEqual({ ok: ghost.ok, sent: ghost.sent }, { ok: true, sent: false },
    "an unknown handle answers exactly as a known one does");
  assert.ok(!ghost.code, "and no code comes back for it");

  const dis = (await seedDesk()).A; const disabled = dis.getUserByHandle("lena");
  dis.setDisabled(disabled.uid, true);
  assert.ok(!dis.otpRequest("lena").sent, "a disabled account cannot request a code");
  assert.ok(!(await dis.otpVerify("lena", "123456", "brand-new-password-1")).ok, "nor verify one");
});

test("reset codes: expiry, and a typo in the password does not cost you the code", async () => {
  const { A, l } = await seedDesk();
  const c = A.otpRequest("lena");
  A._db.prepare("UPDATE otp SET expiresAt = ? WHERE uid = ?").run(Date.now() - 1, l.uid);
  assert.ok(!(await A.otpVerify("lena", c.code, "brand-new-password-1")).ok, "an expired code is refused");

  // The password is checked only after the code is proved, so a weak-password error cannot be used
  // to confirm a guessed code — and the code survives, because a short password is the user's own
  // typo rather than an attack.
  const c2 = A.otpRequest("lena");
  const weak = await A.otpVerify("lena", c2.code, "short");
  assert.ok(!weak.ok && weak.field === "password", "a weak password is refused on its own terms");
  assert.equal(weak.codeOk, true, "and the caller is told the code was fine");
  assert.ok((await A.otpVerify("lena", c2.code, "brand-new-password-9")).ok, "so the same code still works");
});

// ===== messages v3: the deletion fix, the calls record, watch, receipts, read-through ==========
test("deleting a message takes its attachment with it", async () => {
  // The first version nulled fileId on the message and stopped there, leaving the row AND the bytes
  // behind — and because the download route authorizes on thread membership rather than on a live
  // reference, anyone in the thread who still held the id could keep fetching the attachment of a
  // "deleted" message. Deleting is not a rendering change.
  const fs = require("fs"), path = require("path");
  const A = freshAccounts();
  const { g, l } = await seedTwo(A);
  const T = A.threadFor(g.uid, l.uid, true).id;
  const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4E, 0x47, 13, 10, 26, 10]), Buffer.alloc(16)]);
  const f = A.putFile(g.uid, T, "chart.png", png).file;
  const bytes = () => fs.existsSync(path.join(A._dir, "dm-files", f.id));
  const msg = A.send(g.uid, null, "here", null, { thread: T, fileId: f.id });
  assert.ok(A.readFile(l.uid, f.id).ok && bytes(), "readable while the message stands");

  A.drop(g.uid, msg.id);
  assert.ok(!A.readFile(l.uid, f.id).ok, "and NOT readable once the message is deleted");
  assert.ok(!A.readFile(g.uid, f.id).ok, "not even by the person who sent it");
  assert.ok(!bytes(), "the bytes are off the volume");
  const row = A.history(l.uid, T).messages.find((m) => m.id === msg.id);
  assert.ok(row && row.deleted && row.file === null, "the row survives as a tombstone, carrying no attachment");
});

test("abandoned uploads are swept, referenced ones never are", async () => {
  const fs = require("fs"), path = require("path");
  const A = freshAccounts();
  const { g, l } = await seedTwo(A);
  const T = A.threadFor(g.uid, l.uid, true).id;
  const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4E, 0x47, 13, 10, 26, 10]), Buffer.alloc(16)]);
  const orphan = A.putFile(g.uid, T, "changed-my-mind.png", png).file;
  const used = A.putFile(g.uid, T, "sent.png", png).file;
  A.send(g.uid, null, "with a file", null, { thread: T, fileId: used.id });
  const on = (id) => fs.existsSync(path.join(A._dir, "dm-files", id));

  // The grace window matters: a file uploaded milliseconds before its message must not be swept
  // out from under it.
  assert.equal(A.sweepFiles(), 0, "a fresh orphan is inside the grace window");
  assert.equal(A.sweepFiles(0), 1, "past it, the abandoned upload goes");
  assert.ok(!on(orphan.id), "and its bytes with it");
  assert.ok(on(used.id) && A.readFile(l.uid, used.id).ok, "a referenced file is never touched");
});

test("a watched ticker jumps the queue and pierces mute", async () => {
  const marks = { PLTR: 113.9 };
  const A = freshAccounts(marks);
  const { g, l } = await seedTwo(A);
  const T = A.threadFor(g.uid, l.uid, true).id;
  const resolve = (x) => (marks[x] ? x : null);
  const nobody = () => false;

  assert.ok(!A.setWatch(l.uid, "  ", true).ok, "an empty ticker is not a ticker");
  A.setWatch(l.uid, "pltr", true);
  assert.deepEqual(A.watchList(l.uid), ["PLTR"], "stored upper-case, however it was typed");

  A.setMuted(l.uid, T, true);
  A.send(g.uid, null, "just chatter", resolve, { thread: T });
  assert.ok(A.pendingEscalations(0, nobody).every((e) => e.uid !== l.uid), "a muted thread stays silent");

  A.send(g.uid, null, "look at $PLTR", resolve, { thread: T });
  const hot = A.pendingEscalations(60000, nobody).filter((e) => e.uid === l.uid);
  assert.equal(hot.length, 1, "a watched ticker does not wait out the delay");
  assert.equal(hot[0].hot, true, "and gets through the mute");
  assert.ok(A.pendingEscalations(0, (u) => u === l.uid).every((e) => e.uid !== l.uid),
    "but somebody with the terminal open is still not interrupted");
});

test("replies quote one level, inside their own conversation only", async () => {
  const A = freshAccounts();
  const { g, l } = await seedTwo(A);
  const T = A.threadFor(g.uid, l.uid, true).id;
  const orig = A.send(g.uid, null, "entry at 113.90, stop under 110", null, { thread: T });

  const rep = A.send(l.uid, null, "took it", null, { thread: T, replyTo: orig.id });
  assert.equal(rep.message.replyTo, orig.id, "the reply names what it answers");
  assert.equal(rep.message.reply.sender, "gustavo", "the quote carries who said it");
  assert.ok(rep.message.reply.body.startsWith("entry at 113.90"), "and what they said");

  // A replyTo pointing outside the conversation is dropped, never an error and never a leak.
  const code = A.mintInvite(g.uid, null, 7, "join").invite.code;
  const m = (await A.redeem(code, "marco", "another-long-password")).user;
  const T2 = A.threadFor(g.uid, m.uid, true).id;
  const secret = A.send(g.uid, null, "private to marco", null, { thread: T2 });
  const cross = A.send(l.uid, null, "quoting across", null, { thread: T, replyTo: secret.id });
  assert.equal(cross.message.replyTo, null, "a cross-thread quote does not bind");

  // A quoted message deleted later says so at read instead of resurrecting its text.
  A.drop(g.uid, orig.id);
  const read = A.history(l.uid, T).messages.find((x) => x.id === rep.id);
  assert.equal(read.reply.deleted, true, "the preview is honest about the deletion");
  assert.equal(read.reply.body, "", "and carries none of the deleted text");
});

test("an @mention does not wait out the delay and pierces a mute, like a watched ticker", async () => {
  const A = freshAccounts();
  const { g, l } = await seedTwo(A);
  const T = A.threadFor(g.uid, l.uid, true).id;
  const nobody = () => false;

  A.setMuted(l.uid, T, true);
  A.send(g.uid, null, "just chatter, ping @lenathings", null, { thread: T });
  assert.ok(A.pendingEscalations(0, nobody).every((e) => e.uid !== l.uid),
    "@lena running into a longer handle is not a mention, and a muted thread stays silent");

  A.send(g.uid, null, "@lena what do you make of this", null, { thread: T });
  const hot = A.pendingEscalations(60000, nobody).filter((e) => e.uid === l.uid);
  assert.equal(hot.length, 1, "your own handle does not wait out the delay");
  assert.equal(hot[0].hot, true, "and gets through the mute");
  assert.ok(A.pendingEscalations(60000, nobody).every((e) => e.uid !== g.uid),
    "the mention is lena's, not everyone's");
});

test("close hides a conversation for you until somebody writes; clear forgets it for you alone", async () => {
  const A = freshAccounts();
  const { g, l } = await seedTwo(A);
  const T = A.threadFor(g.uid, l.uid, true).id;
  A.send(g.uid, null, "first", null, { thread: T });
  A.send(l.uid, null, "second", null, { thread: T });

  assert.ok(A.closeThread(l.uid, T).ok, "lena closes it");
  assert.equal(A.threads(l.uid).find((t) => t.id === T).hidden, true, "flagged closed on HER rail — listed, so it can always be reopened, never deleted");
  assert.equal(A.threads(g.uid).find((t) => t.id === T).hidden, false, "open as ever on gustavo's — closing is per-viewer");
  assert.ok(A.reopenThread(l.uid, T).ok && A.threads(l.uid).find((t) => t.id === T).hidden === false,
    "and she can reopen it herself, without waiting for a message");
  A.closeThread(l.uid, T);

  A.send(g.uid, null, "you there?", null, { thread: T });
  const back = A.threads(l.uid).find((t) => t.id === T);
  assert.ok(back && !back.hidden, "a new message brings it back");
  assert.equal(A.history(l.uid, T).messages.filter((m) => !m.sys).length, 3, "with the whole backscroll intact");

  assert.ok(A.clearHistory(l.uid, T).ok, "lena clears the history");
  assert.equal(A.history(l.uid, T).messages.length, 0, "her view starts empty");
  assert.equal(A.threads(l.uid).find((t) => t.id === T).hidden, true, "and the row folds closed on her rail");
  assert.ok(A.history(g.uid, T).messages.filter((m) => !m.sys).length >= 3, "gustavo's record is untouched");
  assert.ok(A.search(l.uid, "first").results.every((m) => m.thread !== T), "cleared history stops matching her search");
  assert.ok(A.search(g.uid, "first").results.some((m) => m.thread === T), "but still matches his");

  const again = A.send(g.uid, null, "fresh start", null, { thread: T });
  assert.ok(again.ok, "talking again just works");
  const hist = A.history(l.uid, T).messages;
  assert.equal(hist.length, 1, "she sees only what came after the clear");
  assert.equal(hist[0].body, "fresh start");
  assert.equal(A.exportThread(l.uid, T).messages.length, 1, "her export honors the clear too");
});

test("tweet links: the id is spotted, the oEmbed answer parses, and the card rides the wire", async () => {
  const { tweetLinkId, tweetFromOembed } = require("../src/compute");
  assert.equal(tweetLinkId("look https://x.com/zerohedge/status/1833629471000000000 wild"), "1833629471000000000");
  assert.equal(tweetLinkId("https://twitter.com/a_b/statuses/12345678"), "12345678", "old-form twitter.com works");
  assert.equal(tweetLinkId("https://mobile.twitter.com/i/web/status/987654321"), "987654321");
  assert.equal(tweetLinkId("https://x.com/zerohedge"), null, "a profile link is not a tweet");
  assert.equal(tweetLinkId("x.com/a/status/123"), null, "no scheme, no match — the body is not re-guessed");

  const j = { author_name: "zerohedge", author_url: "https://twitter.com/zerohedge",
    html: '<blockquote class="twitter-tweet"><p lang="en" dir="ltr">$HOOD up 8% &amp; squeezing<br>after S&amp;P inclusion &lt;wild&gt; <a href="https://t.co/x">pic.twitter.com/aB3cD</a></p>&mdash; zerohedge (@zerohedge) <a href="https://twitter.com/zerohedge/status/1">September 10, 2025</a></blockquote>' };
  const t = tweetFromOembed(j, "1");
  assert.equal(t.author, "zerohedge");
  assert.equal(t.handle, "zerohedge");
  assert.equal(t.text, "$HOOD up 8% & squeezing\nafter S&P inclusion <wild>", "entities decoded once, <br> becomes a newline, raw angle brackets survive as text, the pic link is stripped");
  assert.equal(t.media, true, "the pic link becomes a media flag instead of a URL stub");
  assert.equal(t.when, "September 10, 2025");
  assert.equal(t.url, "https://x.com/zerohedge/status/1");
  assert.equal(tweetFromOembed({ author_name: "a", author_url: "", html: "<p>plain words</p>" }, "2").media, false,
    "no pic link, no media flag");
  assert.equal(tweetFromOembed({}, "1"), null, "an empty answer is null, not a blank card");

  // The wire attachment: injected source, exactly like the price mark.
  const A = freshAccounts();
  const { g, l } = await seedTwo(A);
  const T = A.threadFor(g.uid, l.uid, true).id;
  A.setTweetSource((body) => tweetLinkId(body) ? { ok: true, author: "zh", handle: "zh", text: "hi", when: "", url: "https://x.com/zh/status/9" } : null);
  const withLink = A.send(g.uid, null, "see https://x.com/zh/status/900001", null, { thread: T });
  assert.equal(withLink.message.tweet.author, "zh", "a message with a status link carries the card");
  const plain = A.send(g.uid, null, "no links here", null, { thread: T });
  assert.equal(plain.message.tweet, null, "a plain message carries none");
});

test("deleting a group removes it for everyone; close never does", async () => {
  const { A, g, l, m } = await seedDesk();
  const T = A.createGroup(g.uid, "shreddable", [l.uid, m.uid]).thread;
  A.send(l.uid, null, "this will vanish", null, { thread: T });

  assert.ok(!A.deleteGroup(l.uid, T).ok, "a plain member cannot delete it");
  const dm = A.threadFor(g.uid, l.uid, true).id;
  assert.ok(!A.deleteGroup(g.uid, dm).ok, "a 1-to-1 cannot be deleted — clear covers the personal case");

  const r = A.deleteGroup(g.uid, T);
  assert.ok(r.ok, "the owner can");
  assert.deepEqual(r.peers.sort(), [g.uid, l.uid, m.uid].sort(), "and gets the member list to wake");
  assert.ok(A.threads(l.uid).every((t) => t.id !== T), "gone from every rail — not flagged, GONE");
  assert.ok(!A.history(l.uid, T).ok, "the history is not readable by anyone");
  assert.ok(A.search(l.uid, "vanish").results.every((x) => x.thread !== T), "and not searchable");
  assert.ok(A.adminAuditLog(10).some((e) => e.action === "delete-group"), "the shredding itself is on the record");
});

test("the terminal operator can manage a group they are in without owning it", async () => {
  const A = freshAccounts();
  const { g, l } = await seedTwo(A);
  const code = A.mintInvite(g.uid, null, 7, "join").invite.code;
  const m = (await A.redeem(code, "marco", "another-long-password")).user;
  // lena (not an admin) creates the group; gustavo (admin flag, first account) is a member.
  const grp = A.createGroup(l.uid, "desk", [g.uid]);
  assert.ok(!A.addMembers(g.uid, grp.thread, [m.uid]).ok, "a plain member cannot add");
  assert.ok(A.addMembers(g.uid, grp.thread, [m.uid], true).ok, "the operator can");
  assert.ok(A.removeMember(g.uid, grp.thread, m.uid, true).ok, "and remove");
  assert.ok(!A.addMembers(m.uid, grp.thread, [m.uid], true).ok, "but only from inside: a non-member stays refused even asAdmin");
});

test("retention: 30 days for a 1-to-1, 7 for groups and topics, pins and priced calls exempt", async () => {
  const marks = { "xyz:HOOD": 113.2 };
  const { A, g, l, m } = await seedDesk(marks);
  const DM = A.threadFor(g.uid, l.uid, true).id;
  const GR = A.createGroup(g.uid, "desk", [l.uid, m.uid]).thread;
  const dmsg = A.send(g.uid, null, "dm line", null, { thread: DM });
  const gmsg = A.send(g.uid, null, "group line", null, { thread: GR });
  const keep = A.send(g.uid, null, "the standing levels", null, { thread: GR });
  A.pin(g.uid, keep.id, true);
  const call = A.send(g.uid, null, "long $HOOD here", (x) => marks["xyz:" + x] ? "xyz:" + x : null, { thread: GR });
  assert.ok(call.message.refPx === 113.2, "the call is priced");

  const now = Date.now();
  assert.equal(A.sweepRetention(now), 0, "nothing in-window is touched");

  const n8 = A.sweepRetention(now + 8 * 86400e3);
  assert.ok(n8 >= 1, "at day 8 the group backlog goes");
  assert.ok(A.history(g.uid, GR).messages.every((x) => x.id !== gmsg.id), "the group line is gone — row deleted, not hidden");
  assert.ok(A.history(g.uid, GR).messages.some((x) => x.id === keep.id), "the pinned message stays");
  assert.ok(A.history(g.uid, DM).messages.some((x) => x.id === dmsg.id), "the 1-to-1 line is still inside its 30 days");

  A.sweepRetention(now + 31 * 86400e3);
  assert.ok(A.history(g.uid, DM).messages.every((x) => x.id !== dmsg.id), "at day 31 the 1-to-1 line goes too");
  assert.ok(A.history(g.uid, GR).messages.some((x) => x.id === keep.id), "the pin still stays");
  assert.ok(A.history(g.uid, GR).messages.some((x) => x.id === call.id),
    "and so does the priced call — a track record that self-destructs is not a track record");
  assert.ok(A.calls(g.uid, {}).calls.some((c) => c.id === call.id), "the calls record still counts it");

  // The permanence guarantee, pinned well past the 90-day floor the desk asked for: a call is not
  // "retained 90 days", it is exempt from retention entirely — a sweep four months on must not
  // touch it, and the record must still score it.
  A.sweepRetention(now + 120 * 86400e3);
  assert.ok(A.history(g.uid, GR).messages.some((x) => x.id === call.id), "at day 120 the call is still there");
  assert.ok(A.calls(g.uid, {}).calls.some((c) => c.id === call.id), "and still on the record");
});

// ===== messages -65: the double-check batch =====================================================
// Defects found reviewing the module end to end: the sync cursor lied under truncation, cleared
// history resurfaced through the calls record and reply quotes, an edit re-derived the stamp it
// promises not to touch, the bridge stamped raw symbols as dead refs, tombstoned calls were
// retained forever, and the calls by-filter ran after the LIMIT.
test("messages -65: sync never advances past undelivered messages, and says when to come back", async () => {
  const { A, g, l } = await seedDesk();
  const dm = A.threadFor(g.uid, l.uid, true).id;
  for (let i = 0; i < 31; i++) A.send(i % 2 ? l.uid : g.uid, null, "m" + i, null, { thread: dm });
  let cursor = 0, got = 0, rounds = 0;
  for (; rounds < 20; rounds++) {
    const r = A.sync(l.uid, cursor, 5);
    assert.ok(r.messages.every((m) => m.id > cursor), "no re-delivery below the cursor");
    got += r.messages.length;
    cursor = r.cursor;
    if (!r.more) break;
  }
  assert.ok(got >= 31, "every message arrived through sync alone (got " + got + " in " + (rounds + 1) + " rounds)");
});

test("messages -65: cleared history stays cleared — calls record and reply quotes included", async () => {
  const marks = { "xyz:HOOD": 113.2 };
  const { A, g, l } = await seedDesk(marks);
  const resolve = (s) => (marks["xyz:" + s] ? "xyz:" + s : null);
  const dm = A.threadFor(g.uid, l.uid, true).id;
  const call = A.send(g.uid, null, "long $HOOD 113.20", resolve, { thread: dm });
  assert.equal(call.message.refPx, 113.2, "the call is priced");
  A.clearHistory(l.uid, dm);
  assert.equal(A.history(l.uid, dm).messages.length, 0, "history is gone for the clearer");
  assert.ok(!A.calls(l.uid, {}).calls.some((c) => c.id === call.message.id),
    "the calls record does not resurrect it for her");
  assert.ok(A.calls(g.uid, {}).calls.some((c) => c.id === call.message.id), "the author keeps his record");
  const rep = A.send(g.uid, null, "still watching this", null, { thread: dm, replyTo: call.message.id });
  const hers = A.history(l.uid, dm).messages.find((m) => m.id === rep.message.id);
  assert.ok(hers.reply && hers.reply.deleted && !hers.reply.body, "the quote is blanked for the clearer");
  const his = A.history(g.uid, dm).messages.find((m) => m.id === rep.message.id);
  assert.ok(his.reply.body.includes("long $HOOD"), "and intact for everyone else");
});

test("messages -65: the stamp is immutable under edit, and the bridge never stamps raw symbols", async () => {
  const marks = { "xyz:HOOD": 113.2 };
  const { A, g, l } = await seedDesk(marks);
  const resolve = (s) => (marks["xyz:" + s] ? "xyz:" + s : null);
  const dm = A.threadFor(g.uid, l.uid, true).id;
  const call = A.send(g.uid, null, "long $HOOD here", resolve, { thread: dm });
  A.edit(g.uid, call.message.id, "long here (ticker withdrawn)");
  let read = A.history(g.uid, dm).messages.find((m) => m.id === call.message.id);
  assert.equal(read.ref, "xyz:HOOD", "editing the ticker out does not remove the call");
  assert.equal(read.refPx, 113.2, "refPx survives with it");
  const plain = A.send(g.uid, null, "no ticker", null, { thread: dm });
  A.edit(g.uid, plain.message.id, "now with $GARBAGE");
  read = A.history(g.uid, dm).messages.find((m) => m.id === plain.message.id);
  assert.equal(read.ref, null, "an edit cannot mint a ref");
  const br = A.bridgeReply(l.uid, "@gus check $HOOD from my phone", 0);
  assert.ok(br.ok, br.error);
  assert.equal(br.message.ref, null, "the bridge has no resolver — a $WORD stays plain text, never a dead ref");
});

test("messages -66: the record is delete-proof — a dropped call loses its body, never its score", async () => {
  const marks = { "xyz:HOOD": 113.2 };
  const { A, g, l } = await seedDesk(marks);
  const resolve = (s) => (marks["xyz:" + s] ? "xyz:" + s : null);
  const dm = A.threadFor(g.uid, l.uid, true).id;
  const call = A.send(g.uid, null, "long $HOOD", resolve, { thread: dm });
  const plain = A.send(g.uid, null, "just words", null, { thread: dm });
  A.drop(g.uid, call.message.id);
  A.drop(g.uid, plain.message.id);
  marks["xyz:HOOD"] = 110;
  const rec = A.calls(g.uid, {}).calls.find((c) => c.id === call.message.id);
  assert.ok(rec, "the dropped call is still on the record");
  assert.ok(rec.deleted && rec.body === "", "flagged deleted, body gone");
  assert.ok(Math.abs(rec.chg - (110 / 113.2 - 1)) < 1e-9, "and still scored");
  A.sweepRetention(Date.now() + 40 * 86400e3);
  assert.ok(A.calls(g.uid, {}).calls.some((c) => c.id === call.message.id),
    "retention keeps the stamped tombstone — the record cannot be scrubbed by deleting");
  assert.ok(A.history(g.uid, dm).messages.every((m) => m.id !== plain.message.id),
    "while an ordinary tombstone ages out with its window");
});

test("messages -66: call direction — parsed at send, immutable, and the scoreboard scores the CALL", async () => {
  const marks = { "xyz:HOOD": 100 };
  const { A, g, l } = await seedDesk(marks);
  const resolve = (s) => (marks["xyz:" + s] ? "xyz:" + s : null);
  const dm = A.threadFor(g.uid, l.uid, true).id;
  const sh = A.send(g.uid, null, "short $HOOD into the print", resolve, { thread: dm });
  const lg = A.send(g.uid, null, "long $HOOD off the base", resolve, { thread: dm });
  const puts = A.send(g.uid, null, "$HOOD puts here", resolve, { thread: dm });
  const bare = A.send(g.uid, null, "$HOOD looks heavy", resolve, { thread: dm });
  assert.equal(sh.message.side, "short", "short before the ticker");
  assert.equal(puts.message.side, "short", "puts after the ticker");
  assert.equal(lg.message.side, "long", "long is long");
  assert.equal(bare.message.side, "long", "no direction word defaults to long");
  marks["xyz:HOOD"] = 98;   // price fell 2%
  const rec = A.calls(g.uid, {});
  const byId = new Map(rec.calls.map((c) => [c.id, c]));
  assert.ok(byId.get(sh.message.id).adj > 0, "the short is RIGHT when price falls");
  assert.ok(byId.get(lg.message.id).adj < 0, "the long is wrong on the same move");
  assert.ok(Math.abs(byId.get(sh.message.id).chg - byId.get(lg.message.id).chg) < 1e-12, "raw move identical for both");
  // fixed horizons ride the injected daily-close reader; null until a close has printed
  assert.equal(byId.get(sh.message.id).adj1, null, "no 1d close yet — no 1d score");
  A.setPxHistory((coin, ts) => 97);
  const rec2 = A.calls(g.uid, {});
  const s2 = rec2.calls.find((c) => c.id === sh.message.id);
  assert.ok(Math.abs(s2.chg1 - (97 / 100 - 1)) < 1e-9 && s2.adj1 > 0, "the 1d horizon scores off the printed close, direction-adjusted");
  // the summary scores the person on the adjusted 1d yardstick
  const me = rec2.summary.find((x) => x.uid === g.uid);
  assert.equal(me.n, 4, "all four calls counted");
});

test("messages -66: search takes an optional thread scope — membership still the only authorization", async () => {
  const { A, g, l, m } = await seedDesk();
  const dm = A.threadFor(g.uid, l.uid, true).id;
  const gr = A.createGroup(g.uid, "desk", [l.uid]).thread;
  A.send(g.uid, null, "needle in the dm", null, { thread: dm });
  A.send(g.uid, null, "needle in the group", null, { thread: gr });
  assert.equal(A.search(g.uid, "needle", 50).results.length, 2, "unscoped finds both");
  assert.equal(A.search(g.uid, "needle", 50, dm).results.length, 1, "scoped finds one");
  assert.equal(A.search(m.uid, "needle", 50, gr).results.length, 0, "a non-member's scope hands them nothing — the JOIN is the gate");
});

test("messages -66: web push subscriptions — stored per account, validated, dead endpoints dropped", async () => {
  const { A, g, l } = await seedDesk();
  assert.ok(!A.webPushAdd(g.uid, { endpoint: "http://insecure/x", keys: { p256dh: "a", auth: "b" } }, "").ok, "plain-http endpoints are refused");
  assert.ok(!A.webPushAdd(g.uid, { endpoint: "https://push/x" }, "").ok, "keys are required");
  assert.ok(A.webPushAdd(g.uid, { endpoint: "https://push.svc/one", keys: { p256dh: "a", auth: "b" } }, "ua").ok);
  assert.ok(A.webPushAdd(g.uid, { endpoint: "https://push.svc/two", keys: { p256dh: "c", auth: "d" } }, "ua").ok);
  assert.equal(A.webPushFor(g.uid).length, 2, "a member may hold several devices");
  A.webPushDrop(l.uid, "https://push.svc/one");
  assert.equal(A.webPushFor(g.uid).length, 2, "another account cannot remove your subscription");
  A.webPushDrop(g.uid, "https://push.svc/one");
  A.webPushDropDead("https://push.svc/two");
  assert.equal(A.webPushFor(g.uid).length, 0, "owner-drop and dead-drop both land");
});

test("messages -65: the calls by-filter runs in SQL, before the LIMIT", async () => {
  const marks = { "xyz:HOOD": 113.2 };
  const { A, g, l } = await seedDesk(marks);
  const resolve = (s) => (marks["xyz:" + s] ? "xyz:" + s : null);
  const dm = A.threadFor(g.uid, l.uid, true).id;
  const hers = A.send(l.uid, null, "early $HOOD call", resolve, { thread: dm });
  for (let i = 0; i < 12; i++) A.send(g.uid, null, "later $HOOD " + i, resolve, { thread: dm });
  const r = A.calls(g.uid, { by: l.uid, limit: 10 });
  assert.ok(r.calls.some((c) => c.id === hers.message.id),
    "her call is found even though newer calls fill the window");
  assert.ok(r.calls.every((c) => c.senderUid === l.uid), "and only hers");
});

test("boards are quiet on Telegram by default — digests are the opt-in, mentions always land", async () => {
  const A = freshAccounts();
  const { g, l } = await seedTwo(A);
  const B = A.createBoard(g.uid, "macro week").thread;
  A.joinBoard(l.uid, B);
  const nobody = () => false;

  A.send(g.uid, null, "ordinary board chatter", null, { thread: B });
  assert.ok(A.pendingEscalations(0, nobody).every((e) => e.uid !== l.uid),
    "a board digest does not page a member who never opted in");

  A.send(g.uid, null, "@lena what say you", null, { thread: B });
  assert.ok(A.pendingEscalations(60000, nobody).some((e) => e.uid === l.uid && e.hot),
    "but her own handle still reaches her, immediately");
  A.pendingEscalations(0, nobody).forEach((e) => A.markEscalated(e.uid, e.thread, e.upTo));

  assert.ok(!A.setBoardNotify(l.uid, A.threadFor(g.uid, l.uid, true).id, true).ok, "the toggle is board-only");
  assert.ok(A.setBoardNotify(l.uid, B, true).ok, "she opts in");
  A.send(g.uid, null, "more chatter", null, { thread: B });
  assert.ok(A.pendingEscalations(0, nobody).some((e) => e.uid === l.uid),
    "and now the digest reaches her like a group's would");
});

test("read receipts, pins and export", async () => {
  const A = freshAccounts();
  const { g, l, } = await seedTwo(A);
  const T = A.threadFor(g.uid, l.uid, true).id;
  const sent = A.send(g.uid, null, "did this land", null, { thread: T });

  const before = A.threads(g.uid).find((t) => t.id === T).seen.find((s) => s.uid === l.uid);
  assert.ok(before.readMsgId < sent.id, "the sender can see it has not been read");
  assert.equal(before.handle, "lena", "and by whom");
  A.markRead(l.uid, T);
  assert.ok(A.threads(g.uid).find((t) => t.id === T).seen.find((s) => s.uid === l.uid).readMsgId >= sent.id,
    "and sees it once it has");

  assert.ok(A.pin(g.uid, sent.id, true).ok);
  assert.equal(A.threads(g.uid).find((t) => t.id === T).pins, 1, "the pin count rides the thread list");
  const m = (await A.redeem(A.mintInvite(g.uid, null, 7, "join").invite.code, "marco", "another-long-password")).user;
  assert.ok(!A.pin(m.uid, sent.id, true).ok, "somebody outside the thread cannot pin into it");
  A.pin(g.uid, sent.id, false);
  assert.equal(A.pinsOf(T, g.uid).length, 0);

  const ex = A.exportThread(g.uid, T);
  assert.ok(ex.ok && ex.messages.length >= 1 && ex.members.length === 2, "a member can take the record out");
  assert.ok(!A.exportThread(m.uid, T).ok, "an outsider cannot");
});

test("the calls record scores what the price stamp was for", async () => {
  const marks = { PLTR: 100, CRCL: 200 };
  const A = freshAccounts(marks);
  const { g, l } = await seedTwo(A);
  const T = A.threadFor(g.uid, l.uid, true).id;
  const resolve = (x) => (marks[x] ? x : null);
  A.send(g.uid, null, "long $PLTR", resolve, { thread: T });
  A.send(l.uid, null, "short $CRCL", resolve, { thread: T });
  A.send(g.uid, null, "no ticker in this one", resolve, { thread: T });

  marks.PLTR = 110; marks.CRCL = 180;
  const rec = A.calls(g.uid, {});
  assert.equal(rec.calls.length, 2, "only stamped messages are calls");
  const pl = rec.calls.find((c) => c.ref === "PLTR");
  assert.equal(pl.refPx, 100, "the stamp is what it was sent at");
  assert.ok(Math.abs(pl.chg - 0.1) < 1e-9, "and the move since is measured against it, live");
  assert.ok(pl.threadName, "each call says which conversation it was made in");

  const mine = rec.summary.find((x) => x.who === "gustavo");
  assert.equal(mine.n, 1);
  assert.equal(mine.upPct, 1, "a per-person record is the only question a call log answers");
  assert.ok(rec.summary.find((x) => x.who === "lena"), "everyone in the thread is scored");
  assert.ok(A.calls(g.uid, { by: l.uid }).calls.every((c) => c.senderUid === l.uid), "filterable by author");

  const m = (await A.redeem(A.mintInvite(g.uid, null, 7, "join").invite.code, "marco", "another-long-password")).user;
  assert.equal(A.calls(m.uid, {}).calls.length, 0, "and it never reaches a conversation you are not in");
});

test("the operator can read every message, and every read is on the record", async () => {
  // The owner of this deployment decided an operator may read everything. What makes that
  // defensible rather than merely permitted is that it is a separate surface, it is auditable, and
  // the people writing are told — all three are asserted here.
  const A = freshAccounts();
  const { g, l } = await seedTwo(A);
  const m = (await A.redeem(A.mintInvite(g.uid, null, 7, "join").invite.code, "marco", "another-long-password")).user;
  const T = A.threadFor(l.uid, m.uid, true).id;
  A.send(l.uid, null, "something between the two of us", null, { thread: T });

  assert.ok(!A.history(g.uid, T).ok, "the member API still refuses the operator — the bypass is NOT in the membership filter");
  const seen = A.adminHistory(g.uid, T);
  assert.ok(seen.ok && seen.messages.some((x) => x.body.includes("between the two of us")),
    "the admin surface reads it");
  assert.ok(seen.messages.every((x) => x.mine === false), "and never claims the operator wrote any of it");
  assert.ok(A.adminThreads().some((t) => t.id === T), "every conversation is listed");
  assert.equal(A.adminSearch(g.uid, "between the two").results.length, 1, "and searchable");

  const log = A.adminAuditLog();
  assert.ok(log.some((e) => e.action === "read-thread" && e.thread === T), "the read is recorded");
  assert.ok(log.some((e) => e.action === "search" && e.detail.includes("between the two")), "so is the search");
  assert.equal(log[0].who, "gustavo", "with the operator named");

  const fs = require("fs"), path = require("path");
  const srv = fs.readFileSync(path.join(__dirname, "..", "server.js"), "utf8");
  const app = require("./_client").clientSource();
  assert.ok(/fastify\.get\("\/api\/access\/dm"/.test(srv), "read-through lives on its own admin-gated route");
  const block = srv.slice(srv.indexOf("// ===== operator read-through"), srv.indexOf("// ---- the Telegram reply bridge"));
  assert.ok(!/isMember|threadPeers/.test(block), "it must not consult membership — that is the point of separating it");
  assert.equal((block.match(/adminOnly\(req, reply\)/g) || []).length, 4, "every read-through route is gated at the door");
  // People write differently when they believe a message is private. On this deployment it is not,
  // so the tab says so rather than letting the assumption stand.
  assert.ok(/operatorReadsAll: true/.test(srv), "the server states the posture in the payload");
  assert.ok(/The operator of this terminal can read every message here/.test(app),
    "and the Messages tab tells members, in the place where they write");
});

// ===== build 2026.09.11-67: audit fixes ========================================================
// The legacy shared-password secrets were sha256("xyzmon-session|user|password") — a constant anyone
// could recompute once SITE_PASSWORD was unset (the documented open posture). A forged legacy token
// then satisfied sessionOk at /claim (mint an account, the first one admin) and the AI-cost gate,
// and `Basic friend:` passed credsOk outright. Both secrets now key off the random session-secret
// file accounts.js already persists, and an empty password closes every shared-password door.
test("audit -67: legacy secrets key off the random accounts secret and fail closed without a password", () => {
  const fs = require("fs"), path = require("path"), os = require("os");
  const srv = fs.readFileSync(path.join(__dirname, "..", "server.js"), "utf8");
  assert.ok(!/xyzmon-session\|\$\{SITE_USER\}\|\$\{SITE_PASSWORD\}`\)\.digest\(\)/.test(srv),
    "the password-only session derivation is gone");
  assert.ok(/SESSION_SECRET = process\.env\.SESSION_SECRET[\s\S]{0,200}ACCOUNTS\.deriveKey\(`legacy-session\|\$\{SITE_USER\}\|\$\{SITE_PASSWORD\}`\)/.test(srv),
    "the legacy session secret is HMAC-derived from the accounts secret, password folded in as the label");
  assert.ok(/OWNER_SECRET = ACCOUNTS\.deriveKey\("alert-owner"\)/.test(srv), "the owner secret no longer depends on the password");
  assert.ok(/const OWNER_SECRET_LEGACY = SITE_PASSWORD\s*\?/.test(srv) && /for \(const secret of \[OWNER_SECRET, OWNER_SECRET_LEGACY\]\)/.test(srv),
    "existing owner cookies keep verifying while a real password exists, and never without one");
  assert.ok(/const LEGACY_DOOR = !!SITE_PASSWORD && process\.env\.LEGACY_SHARED_PASSWORD !== "0"/.test(srv),
    "no password means no legacy door");
  assert.ok(/function credsOk\(u, p\) \{\n  if \(!SITE_PASSWORD\) return false;/.test(srv), "credsOk refuses when there is no password");

  // deriveKey: deterministic per label, distinct across labels, and not the raw secret.
  const { openAccounts } = require("../src/accounts");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "xyz-acc-"));
  const A = openAccounts(dir, { sessionDays: 1 });
  const k1 = A.deriveKey("legacy-session|friend|"), k2 = A.deriveKey("legacy-session|friend|"), k3 = A.deriveKey("alert-owner");
  assert.equal(k1.length, 32); assert.ok(k1.equals(k2)); assert.ok(!k1.equals(k3));
  const raw = fs.readFileSync(path.join(dir, "session-secret"), "utf8").trim();
  assert.ok(!Buffer.from(raw, "base64").equals(k1), "a derived key is never the secret itself");
  // A second open of the same volume derives the same key: restarts keep everyone signed in.
  const B = openAccounts(dir, { sessionDays: 1 });
  assert.ok(B.deriveKey("alert-owner").equals(k3));
});

// accounts.db — users, password hashes, every message and attachment — had no backup path at all
// (only the ledger is shipped). A VACUUM INTO copy is taken after boot and daily, rotated.
test("audit -67: accounts.db backs up as a consistent rotated copy and closes cleanly", async () => {
  const fs = require("fs"), path = require("path"), os = require("os");
  const { openAccounts } = require("../src/accounts");
  const { DatabaseSync } = require("node:sqlite");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "xyz-acc-bk-"));
  const A = openAccounts(dir, { sessionDays: 1 });
  const b = await A.bootstrap("gus", "a-long-password-12");
  assert.ok(b.ok, "fixture account");
  const r1 = A.backup(null, 2);
  assert.ok(r1.ok && r1.bytes > 0 && r1.file.startsWith(path.join(dir, "backups")), JSON.stringify(r1));
  const copy = new DatabaseSync(r1.file, { readOnly: true });
  assert.equal(copy.prepare("SELECT count(*) AS n FROM user").get().n, 1, "the copy carries the data");
  copy.close();
  const r2 = A.backup(null, 2), r3 = A.backup(null, 2);
  assert.ok(r2.ok && r3.ok);
  const left = fs.readdirSync(path.join(dir, "backups")).filter((f) => f.endsWith(".db"));
  assert.equal(left.length, 2, "rotation keeps the newest two");
  assert.ok(!left.includes(path.basename(r1.file)) && left.includes(path.basename(r3.file)));
  assert.ok(A.lastBackup() && A.lastBackup().file === r3.file);
  const other = fs.mkdtempSync(path.join(os.tmpdir(), "xyz-acc-bk2-"));
  assert.ok(A.backup(other, 7).ok, "an operator-mounted directory works too");
  A.close();
  assert.ok(!fs.existsSync(path.join(dir, "accounts.db-wal")) || fs.statSync(path.join(dir, "accounts.db-wal")).size === 0, "the WAL is checkpointed on close");
  const srv = fs.readFileSync(path.join(__dirname, "..", "server.js"), "utf8");
  assert.ok(/setInterval\(accountsBackup, 24 \* 3600 \* 1000\)/.test(srv), "scheduled daily");
  assert.ok((srv.match(/try \{ ACCOUNTS\.close\(\); \} catch \(_\) \{\}/g) || []).length === 2, "closed on shutdown and on crash");
});

// ===== build 2026.09.11-67: Medium findings ===================================================
test("audit -67: /claim never mints an operator; bootstrap is transactional and one-shot", async () => {
  const fs = require("fs"), path = require("path"), os = require("os");
  const { openAccounts } = require("../src/accounts");
  const A = openAccounts(fs.mkdtempSync(path.join(os.tmpdir(), "xyz-claim-")), { sessionDays: 1 });
  const c = await A.claim("first", "a-long-password-12", null);
  assert.ok(c.ok && c.user.isAdmin === false, "first to claim is NOT admin");
  const A2 = openAccounts(fs.mkdtempSync(path.join(os.tmpdir(), "xyz-claim2-")), { sessionDays: 1 });
  const b = await A2.bootstrap("op", "a-long-password-12", null);
  assert.ok(b.ok && b.user.isAdmin === true, "bootstrap still mints the operator");
  assert.equal((await A2.bootstrap("op2", "a-long-password-12", null)).ok, false, "and closes");
  const src = fs.readFileSync(path.join(__dirname, "..", "src", "accounts.js"), "utf8");
  assert.ok(/db\.exec\("BEGIN IMMEDIATE"\);\s*\n\s*try \{\s*\n\s*if \(S\.userCount\.get\(\)\.n > 0\)/.test(src), "count and insert share a transaction");
});

test("audit -67: sign-in answers every failure with the same words and one scrypt", async () => {
  const fs = require("fs"), path = require("path"), os = require("os");
  const { openAccounts } = require("../src/accounts");
  const A = openAccounts(fs.mkdtempSync(path.join(os.tmpdir(), "xyz-login-")), { sessionDays: 1 });
  await A.bootstrap("gus", "a-long-password-12", null);
  const uid = A.getUserByHandle("gus").uid;
  const e1 = (await A.login("nobody", "whatever-long-pw")).error, e2 = (await A.login("gus", "wrong-long-pw-12")).error;
  A.setDisabled(uid, true);
  const e3 = (await A.login("gus", "a-long-password-12")).error;
  assert.ok(e1 === e2 && e2 === e3 && /wrong handle or password/.test(e1), "unknown, wrong and disabled read identically");
  const src = fs.readFileSync(path.join(__dirname, "..", "src", "accounts.js"), "utf8");
  // Pin updated 2026.09.20: hashPw went async (threadpool scrypt); the decoy is the one boot-time
  // derivation that stays sync, and the decoy verify is awaited like every other.
  assert.ok(/const DECOY_PW = hashPwSync\(crypto\.randomBytes\(24\)/.test(src), "the decoy is hashed once at open, not per attempt");
  assert.ok(/if \(!u\) \{ await verifyPw\(String\(password \|\| ""\), DECOY_PW\); return bad; \}/.test(src));
});

test("audit -67: reset codes still rotate on re-request; msgSeq matches stats", async () => {
  const fs = require("fs"), path = require("path"), os = require("os");
  const { openAccounts } = require("../src/accounts");
  const A = openAccounts(fs.mkdtempSync(path.join(os.tmpdir(), "xyz-otp-")), { sessionDays: 1 });
  await A.bootstrap("gus", "a-long-password-12", null);
  // Replacement on re-request is a documented decision (an old code in a chat history dies the
  // moment a new one is asked for); the denial lever it opens is closed at /reset by the per-IP
  // allowance instead (see server.test.js).
  const r1 = A.otpRequest("gus"), r2 = A.otpRequest("gus");
  assert.ok(r1.sent && r2.sent && r1.code !== r2.code);
  assert.equal(A.msgSeq(), A.stats().messages, "msgSeq is the cheap read of what stats().messages reported");
});

test("chat terminal -69: a command result is a message with cmd, no stamp, no edit; the AI half is admin-locked by default", async () => {
  const fs = require("fs"), path = require("path");
  const C = require("../src/compute");
  // Two switches in the manifest, both act keys, both routeless (the post rides /api/dm and the
  // ask rides /api/ask, which are claimed already): the local grammar ships public because it
  // costs nothing; the AI leg ships admin because it spends budget where a whole thread reads it.
  const term = C.FEATURES.find((f) => f.key === "dm.terminal"), ask = C.FEATURES.find((f) => f.key === "dm.ask");
  assert.ok(term && term.kind === "act" && term.def === "public" && term.routes.length === 0, "dm.terminal: act, public, routeless");
  assert.ok(ask && ask.kind === "act" && ask.def === "admin" && ask.routes.length === 0, "dm.ask: act, ADMIN by default, routeless");
  assert.equal(C.featureVisible({}, "dm.ask", false), false, "a member may not post AI answers into chat until the operator opens it");
  assert.equal(C.featureVisible({}, "dm.ask", true), true, "the operator always may");
  assert.equal(C.featureVisible({}, "dm.terminal", false), true, "the local grammar is open to members out of the box");
  assert.equal(C.featureVisible({ "dm.terminal": "off" }, "dm.terminal", true), false, "off means nobody, operator included");

  // Storage: the command travels as its own field; the body is the output.
  const A = freshAccounts({ "xyz:NVDA": 113.9 });
  const { g, l } = await seedTwo(A);
  const T = A.threadFor(g.uid, l.uid, true).id;
  const resolve = (sym) => (sym === "NVDA" ? "xyz:NVDA" : null);
  const plain = A.send(l.uid, null, "long $NVDA here", resolve, { thread: T });
  assert.equal(plain.message.ref, "xyz:NVDA", "control: an ordinary message with $NVDA is stamped");
  const out = "TOP FUNDING · stocks\n 1 NVDA   +41%  $NVDA is crowded";
  const r = A.send(l.uid, null, out, resolve, { thread: T, cmd: "  top   funding 5 ", cmdAi: false, replyTo: plain.id });
  assert.ok(r.ok, r.error);
  assert.equal(r.message.cmd, "top funding 5", "the command label is whitespace-collapsed and carried on the wire");
  assert.equal(r.message.cmdAi, false);
  assert.equal(r.message.body, out, "the output is the body, verbatim");
  assert.equal(r.message.ref, null, "NO price stamp on a command result — a screen dump that spells $NVDA is nobody's call");
  assert.equal(r.message.replyTo, null, "a command result quotes nothing");
  const ai = A.send(l.uid, null, "NVDA is crowded because …", resolve, { thread: T, cmd: "why is nvda crowded", cmdAi: true });
  assert.equal(ai.message.cmdAi, true, "the AI badge is stored, not inferred at read");
  // The Telegram digest line names the command too (checked before anything marks gus's side read).
  const esc = A.pendingEscalations(0, () => false).find((p) => p.uid === g.uid);
  assert.ok(esc && esc.lines.some((x) => x.includes("▸ top funding 5")), "the digest says what was asked, not the padded header row: " + JSON.stringify(esc && esc.lines));
  assert.equal(A.threads(g.uid).find((t) => t.id === T).preview, "▸ why is nvda crowded", "the rail previews a command result as the command, not the table");
  assert.equal(A.send(l.uid, null, "x", resolve, { thread: T, cmd: "y".repeat(500) }).message.cmd.length, 160, "the label is capped hard; the output takes the body cap");
  assert.equal(A.send(l.uid, null, "x", resolve, { thread: T, cmd: "   " }).message.cmd, null, "a blank label is no label");
  const e = A.edit(l.uid, r.id, "reworded");
  assert.ok(!e.ok && /can't be edited/.test(e.error), "a command result can't be reworded into words nobody computed");
  assert.ok(A.edit(l.uid, plain.id, "reworded").ok, "control: prose still edits");
  const h = A.history(g.uid, T).messages;
  const got = h.find((m) => m.id === r.id);
  assert.equal(got.cmd, "top funding 5"); assert.equal(got.cmdAi, false); assert.equal(got.ref, null);
  assert.equal(h.find((m) => m.id === ai.id).cmdAi, true);
  // Quoting a command result quotes the command, not 120 characters of table.
  const q = A.send(g.uid, null, "nice", resolve, { thread: T, replyTo: r.id });
  assert.equal(q.message.reply.body, "▸ top funding 5");
  // A fresh open of the same volume migrates nothing away: the columns are in ADDED_COLUMNS.
  const src = fs.readFileSync(path.join(__dirname, "..", "src", "accounts.js"), "utf8");
  assert.ok(/\["cmd", "TEXT"\], \["cmdAi", "INTEGER"\]/.test(src), "both columns are in the table-driven migration list — a volume from before -69 must open");
  assert.ok(/S\.msgIns\.run\(\+threadId, actor \|\| "", now, String\(detail \|\| ""\), null, null, null, kind, null, null, null, null, null\)/.test(src), "the system-row insert binds the two new columns too — a positional insert one short binds NULL into the wrong slot next time a column is added");
  assert.ok(/const sym = cmd \? null : firstTickerRef\(text\);/.test(src), "the no-stamp rule is at the ref site, not a post-hoc null");

  // Server: the gate lives in the handlers because the keys own no route.
  const srv = fs.readFileSync(path.join(__dirname, "..", "server.js"), "utf8");
  assert.ok(/if \(typeof b\.cmd === "string"\) \{[\s\S]{0,600}featureVisible\(flags, "dm\.terminal", adm\)[\s\S]{0,200}featureVisible\(flags, "dm\.ask", adm\)/.test(srv), "POST /api/dm gates cmd on dm.terminal and cmdAi on dm.ask");
  assert.ok(/error: "feature-gated", feature: closed/.test(srv), "the refusal names the switch, same shape as the route gate");
  assert.ok(/b\.ctx\.via === "dm" && !featureVisible\(poller\.getFlags\(\), "dm\.ask", isAdmin\(req\)\)/.test(srv), "POST /api/ask applies dm.ask on top of ai.ask for a chat-bound question");
  assert.ok(/cmd: typeof b\.cmd === "string" \? b\.cmd : null, cmdAi: !!b\.cmdAi/.test(srv), "the fields reach the store — a non-string cmd is no cmd, not \"[object Object]\"");

  // Client: one code path — the panel's handlers with the output redirected, the AI leg latched.
  const app = require("./_client").clientSource();
  assert.ok(/let _termSink=null;\nfunction termEmit\(d\)\{ if\(_termSink\)\{ _termSink\.blocks\.push\(d\); return; \}/.test(app), "termEmit is the one door every terminal block goes through");
  for (const fn of ["termOut", "termOutTrans", "termOutAI", "termEcho", "termErr"])
    assert.ok(new RegExp("function " + fn + "\\([^)]*\\)\\{[^\\n]*termEmit\\(d\\);").test(app), fn + " must emit through the sink, not append to the panel directly");
  assert.ok(/if\(_termSink&&!_termSink\.ai\) return termErr\('AI answers are admin-only in chat/.test(app), "termAsk refuses inside a capture whose sink forbids AI — an unknown lens can't sneak a spend");
  assert.ok(/if\(_termSink\) ctx\.via='dm';/.test(app), "a chat-bound ask tells the server so dm.ask applies");
  assert.ok(/const fk=tfield\(fname\); if\(!fk\) return termAsk\(/.test(app), "the unknown-lens escalation is RETURNED so a capture awaits it");
  assert.ok(/if\(!dmState\.editing&&\/\^\\\/\[\^\\\/\\s\]\/\.test\(text\)\) return dmRunCmd\(text\);/.test(app), "dmSend routes /verb to the runner, never an edit");
  assert.ok(/if\(!dmState\.editing&&text\.startsWith\('\/\/'\)\) text=text\.slice\(1\);/.test(app), "// sends a literal slash");
  assert.ok(/function dmHelpCmd\(\)\{/.test(app) && /\/\^\(help\|\\\?\)\$\/i\.test\(line\)\) return dmHelpCmd\(\);/.test(app), "/help is a private card, not a post");
  assert.ok(/'only you see this'/.test(app) || /only you see this<\/span>/.test(app), "private lines say they are private");
  for (const v of ["comp", "basket", "report", "admin", "clear", "stocks", "crypto"]) assert.ok(new RegExp("\\b" + v + ":'").test(app.slice(app.indexOf("const DM_CMD_BLOCKED="), app.indexOf("const DM_CMD_BLOCKED=") + 800)), v + " is refused from chat — it opens a view or changes state");
  assert.ok(/whale:\['add','pick','rm','ingest13f','pull','mute','unmute'\]/.test(app) && /earnings:\['backfill'\]/.test(app), "state-changing subverbs are refused too");
  assert.ok(/function dmAskAllowed\(\)\{ return IS_ADMIN\|\|featureOn\('dm\.ask'\); \}/.test(app), "the client's AI switch reads the resolved flag");
  // Since the module split the sink is a terminal.js let behind termSetSink(): messages.js can only point it, never reach in.
  assert.ok(/const sink=\{blocks:\[\],ai:ai,via:'dm',check:dmCmdCheck\}; termSetSink\(sink\);/.test(app) && /finally\{ termSetSink\(null\); dmState\.cmdBusy=false;/.test(app), "the sink is released on every path, and carries the allowlist");
  assert.ok(/if\(_termSink&&_termSink\.check\)\{ const why=_termSink\.check\(d\.query\); if\(why\) return termErr/.test(app), "an AI-planned query obeys the chat allowlist — it must not navigate the sender away");
  assert.ok(/const shown=line\.replace\(\/\^\(admin\\s\+\(\?:unlock\|reset-reports\)\)/.test(app), "an admin password typed into chat is redacted in the private echo");
  assert.ok(/cmd:line,cmdAi:!cmd\|\|r\.ai/.test(app), "a planner answer (AI planned, board computed) still posts as AI — the badge follows the spend");
  assert.ok(/\(m\.cmd\?'':'<button type="button" class="dm-tool" data-dmedit=/.test(app), "no edit button on a command result");
  assert.ok(/<\/div>'\+dmRatioBlock\(m\)\+'<pre class="dm-cmdout">'\+esc\(m\.body\)\+'<\/pre>/.test(app) && /if\(!ra\) return dmFile\(m\);/.test(app), "the output renders escaped, in a monospace block, with the attachment ABOVE it — the first cut never rendered a command result's attachment, so the chart posted and never drew");
  assert.ok(/\/help for commands\)/.test(app), "the composer placeholder points at /help");
  const css = fs.readFileSync(path.join(__dirname, "..", "public", "styles.css"), "utf8");
  for (const pin of [".dm-b.dm-cmdb{", ".dm-cmdout{", ".dm-local{", ".dm-local.err{", ".dm-localmk{", ".dm-guidebtn{", ".hlp-cmd{", ".hlp-chip.chat{", ".dm-msg.cmd:has(.dm-img){", ".dm-cmdb .dm-img img{width:100%}"]) assert.ok(css.includes(pin), "css pin missing: " + pin);
  // -70: the guide. One data source renders the private card AND the modal, a ? beside the
  // composer opens it, and every verb the chat runner blocks is tagged panel-only in the guide.
  assert.ok(/const DM_CMD_GUIDE=\[/.test(app) && /function openDmGuide\(\)\{/.test(app), "the guide exists");
  assert.ok(/for\(const s of DM_CMD_GUIDE\) for\(const r of s\.rows\)\{\n\s*if\(!r\[2\]\.includes\('c'\)\) continue;/.test(app), "the /help card is derived from the guide's chat rows");
  assert.ok(/id="dm-guide" title="Commands/.test(app) && /e\.target\.closest\('#dm-guide'\)\|\|e\.target\.closest\('\[data-dmguide\]'\)\)\{ openDmGuide\(\); return; \}/.test(app), "the ? beside the composer and the card's link both open the guide");
  assert.ok(/data-dmguide="1">open the full guide/.test(app), "the private card links to the full guide");
  const guideSrc = app.slice(app.indexOf("const DM_CMD_GUIDE=["), app.indexOf("const DM_CMD_EXAMPLES="));
  for (const v of ["comp", "basket", "report", "admin"]) {
    const row = [...guideSrc.matchAll(/\['([^']*)','[^']*','([a-z]+)'\]/g)].find((m) => m[1].split(/[\s|·]/)[0] === v);
    assert.ok(row && row[2].includes("t") && !row[2].includes("c"), "guide row for " + v + " must be tagged panel-only — the chat runner refuses it");
  }
  // -71: every verb handler that fetches must RETURN its promise — the chat capture awaits the verb,
  // and a promise dropped on the floor delivered `/whale season` into the hidden panel after the
  // sink was gone ("nothing to post"). Scan the terminal handler bodies for a bare `fetchJSON(...).then(`.
  const termSrc = app.slice(app.indexOf("//  ASK-THE-BOARD TERMINAL"), app.indexOf("function openDmGuide()"));
  for (const m of termSrc.matchAll(/^(\s*)(fetchJSON|fetch)\(/gm))
    assert.ok(false, "a terminal handler fires a fetch without returning or awaiting it at: " + termSrc.slice(m.index, m.index + 60));
  for (const fn of ["termWhaleList", "termWhaleFund", "termWhaleSeason"])
    assert.ok(new RegExp("function " + fn + "\\([^)]*\\)\\{[\\s\\S]{0,400}?return fetchJSON\\(").test(app), fn + " must return its promise so a chat capture can await it");
  // -72: `screen` parses fields with digits in their names, and a translation-only capture posts nothing.
  const screenRe = /^([a-z][a-z0-9 ]*?)\s*(>=|<=|>|<|=)\s*(-?[\d.]+[kmbt]?)$/i;
  assert.ok(app.includes("c.match(/^([a-z][a-z0-9 ]*?)\\s*(>=|<=|>|<|=)\\s*(-?[\\d.]+[kmbt]?)$/i)"), "screen field class must admit digits");
  for (const [c, f, op, v] of [["vsma200>0", "vsma200", ">", "0"], ["d7 >= 2.5", "d7", ">=", "2.5"], ["vol30<40", "vol30", "<", "40"], ["oi>50m", "oi", ">", "50m"], ["funding > 20", "funding", ">", "20"]]) {
    const m = c.match(screenRe); assert.ok(m, "screen clause must parse: " + c);
    assert.equal(m[1].trim(), f); assert.equal(m[2], op); assert.equal(m[3], v);
  }
  assert.ok(!app.includes("can't parse \"${tesc(c)}\""), "termErr escapes — a pre-escaped clause rendered as &gt; on screen");
  assert.ok(/return \{text:real\?out\.join\('\\n'\):'',errs:errs\.join\('\\n'\),ai:ai\};/.test(app), "a capture with no real output block (translation line only) has nothing to post");
  // -72: /ratio posts the chart as a PNG through the ordinary attachment path; Tab completes.
  assert.ok(/async function dmRatioChart\(args\)\{/.test(app) && /const S=ratioImageSvg\(d,\{scale:'reb',colors,tf\}\);/.test(app), "/ratio renders the static picture builder with the theme's colours passed in as literals");
  {
    // Execute the picture builder against a fixture, as the suite does for ratioSvg: a chart that
    // posts into a chat must carry what hover would otherwise supply.
    const grab2 = (name) => { const i = app.indexOf("function " + name + "("); let depth = 0, j = i; for (; j < app.length; j++) { if (app[j] === "{") depth++; else if (app[j] === "}") { depth--; if (!depth) break; } } return app.slice(i, j + 1); };
    const ratioImageSvg = new Function(grab2("ratioImageSvg") + "\nreturn ratioImageSvg;")();
    const HOUR = 3600e3, t0 = 1700000000000;
    const candles = Array.from({ length: 40 }, (_, i) => { const o = 2 + i * 0.01, c = o + (i % 2 ? 0.02 : -0.015); return { t: t0 + i * 4 * HOUR, o, h: Math.max(o, c) + 0.01, l: Math.min(o, c) - 0.01, c }; });
    const out = ratioImageSvg({ candles, ema200: candles.map((k, i) => (i < 3 ? null : k.c - 0.005)), num: "INTC", den: "NVDA", tf: "4h", emaSpan: 200, bars: 400, shown: 40 }, { scale: "reb" });
    assert.equal((out.svg.match(/class="ri-k"/g) || []).length, 40, "one candle body per bar");
    assert.ok(out.svg.includes('class="ri-ema"') && out.svg.includes(">EMA 200<"), "the EMA is drawn AND named — a picture has no hover to say what the blue line is");
    assert.ok((out.svg.match(/text-anchor="middle">[A-Z][a-z]{2} \d\d \d\dh</g) || []).length >= 5, "a time axis with dated ticks at intraday resolution");
    assert.ok(out.svg.includes("INTC ÷ NVDA") && out.svg.includes("4H candles") && /stroke-dasharray="4 4"/.test(out.svg), "header names the pair and timeframe; the last close is tagged");
    assert.ok(out.svg.startsWith('<svg xmlns="http://www.w3.org/2000/svg"') && !/var\(--/.test(out.svg), "a standalone SVG with literal colours — nothing an <img> can't resolve");
    assert.equal(ratioImageSvg({ candles: [] }, {}).n, 0, "no candles -> nothing, never a fabricated frame");
    const day = ratioImageSvg({ candles: candles.map((k, i) => Object.assign({}, k, { t: t0 + i * 24 * HOUR })), num: "A", den: "B", tf: "1d" }, {});
    assert.ok(!/\d\dh</.test(day.svg), "daily candles label the axis by date only");
  }
  // -74: timeframe pills on a posted ratio chart redraw LIVE for the viewer; the picture stays.
  assert.ok(/const DM_RT_TFS=\['1h','4h','12h','1d'\];/.test(app) && /function dmRatioBlock\(m\)\{/.test(app) && /async function dmRatioSwitch\(mid,tf\)\{/.test(app), "the switch exists");
  assert.ok(/<\/div>'\+dmRatioBlock\(m\)\+'<pre class="dm-cmdout">/.test(app), "a command result renders through dmRatioBlock, which falls back to dmFile for anything that is not a ratio chart");
  assert.ok(/if\(tf===ra\.tf\)\{ dmState\.rtLive\.delete\(mid\); dmRender\(\); return; \}/.test(app), "the posted timeframe restores the posted image");
  assert.ok(!/dmPost\(\{[^}]*rtLive/.test(app) && /Never sent — the posted picture is the record/.test(app), "a timeframe switch never posts");
  assert.ok(/\{ const rt=e\.target\.closest\('\[data-dmrtf\]'\); if\(rt\)\{ dmRatioSwitch\(\+rt\.dataset\.mid, rt\.dataset\.dmrtf\); return; \} \}/.test(app), "pills are wired through the tab's one delegated listener");
  for (const pin of [".dm-rtf{", ".dm-cmdb .dm-rtlive svg{"]) assert.ok(css.includes(pin), "css pin missing: " + pin);
  // -75: BTC joins the stock overlay universe and resolves as a COMP/G row in stocks scope.
  assert.ok(/function compgBtcRow\(\)\{ if\(state\.scope==='crypto'\) return null; const r=state\.rows\.get\('BTC'\); return \(r&&!r\.delisted&&r\.daily&&r\.daily\.length\)\?r:null; \}/.test(app), "BTC bridges only in stocks scope and only with a daily series");
  assert.ok(/if\(compgBtcRow\(\)&&!base\.includes\('BTC'\)\) base\.push\('BTC'\);/.test(app) && /if\(tk==='BTC'\) return compgBtcRow\(\);/.test(app), "the universe and the row lookup agree");
  const pj = fs.readFileSync(path.join(__dirname, "..", "src", "poller.js"), "utf8");
  assert.ok(/const btcBridge = \(l\) => l\.scope === "crypto" && !l\.basket && l\.name === "BTC";/.test(pj) && /if \(A\.scope !== B\.scope && !\(btcBridge\(A\) \|\| btcBridge\(B\)\)\)/.test(pj), "the server wall has exactly one door, and it is BTC");
  assert.ok(/new File\(\[png\],`ratio-\$\{d\.num\}-\$\{d\.den\}-\$\{tf\}\.png`,\{type:'image\/png'\}\)/.test(app), "the chart is a PNG file — the only inline type the upload sniff admits for a drawing");
  assert.ok(/const res=await dmPost\(\{thread:t\.id,body:r\.body,cmd:line,fileId:up\.id\}\);/.test(app), "the chart posts as a command result WITH an attachment");
  assert.ok(!/ratio:'opens the ratio chart'/.test(app), "ratio is no longer refused from chat");
  assert.ok(/function dmComps\(text\)\{/.test(app) && /function dmCmdPop\(ta\)\{/.test(app) && /function dmCompPick\(x\)\{/.test(app), "the completion engine exists");
  assert.ok(/c=c\.filter\(x=>!DM_CMD_BLOCKED\[x\.split\(' '\)\[0\]\]\);\n\s*const extra=\['help','clear','ratio'\]/.test(app), "completions never offer a verb the chat refuses, and the chat's own verbs are added after the filter");
  assert.ok(/if\(!first&&p\[p\.length-1\]===''\) return \[\];/.test(app), "Tab after a finished argument offers nothing rather than rewriting it");
  assert.ok(/if\(e\.key==='Tab'\)\{ e\.preventDefault\(\); const o=opts\[dmState\.compIdx%opts\.length\]; if\(o\)\{ dmCompPick\(o\.dataset\.dmcomp\); \} return; \}/.test(app), "Tab applies the highlighted completion");
  assert.ok(/if\(e\.key==='Enter'&&!e\.shiftKey\)\{ pop\.hidden=true; \}/.test(app), "Enter with completions showing still SENDS — a finished command runs, it does not complete");
  const acc = fs.readFileSync(path.join(__dirname, "..", "src", "accounts.js"), "utf8");
  assert.ok(/const file = o\.fileId \? S\.fileById\.get\(o\.fileId\) : null;/.test(acc), "a command result may carry an attachment (the ratio chart)");
  // -72: opening Messages lands at the bottom. A hidden log measures 0 tall and must read as "at
  // bottom"; the open scrolls once more after layout; late-loading images keep the pin.
  assert.ok(/logAtBottom: log \? \(log\.clientHeight===0 \|\| log\.scrollTop\+log\.clientHeight>=log\.scrollHeight-40\) : true \};/.test(app), "a hidden log reads as at-bottom");
  assert.ok(/requestAnimationFrame\(\(\)=>\{ if\(state\.view==='dm'&&!dmState\.results&&dmState\.mode!=='calls'\)\{ dmScrollBottom\(\); dmPageToComposer\(\); \} \}\);/.test(app), "openDM scrolls the log AND the page to the composer after layout");
  assert.ok(/function dmPageToComposer\(\)\{/.test(app) && /if\(r\.bottom>vh-8\) window\.scrollBy\(/.test(app), "the page scroll fires only when the composer is below the fold — a desktop layout that fits is never yanked");
  assert.ok(/dmState\.sel===id&&!dmState\.results&&dmState\.mode!=='calls'\)\{ dmScrollBottom\(\); dmPageToComposer\(\); \}/.test(app), "opening a thread from the rail lands the same way");
  assert.ok(/function dmPinBottomOnImages\(\)\{/.test(app) && /\n  dmPinBottomOnImages\(\);\n\}/.test(app), "late images keep the reader pinned to the bottom");
  // -72: AI notices (not enabled, busy, capped) never post as AI answers from a chat; `who` yields
  // to the phrasebook unless the next word is a listed name.
  assert.ok(/if\(d&&d\.disabled\) return _termSink\?termErr\("the AI fallback isn't enabled on the server/.test(app), "'AI not enabled' is private in chat");
  assert.ok(/if\(d&&d\.error==='rate'\) return _termSink\?termErr\(/.test(app) && /if\(_termSink&&\(d&&\(d\.error==='ask-user-cap'\|\|d\.error==='ask-daily-cap'\)\)\) return termErr\(/.test(app), "busy and capped are private in chat");
  assert.ok(/if\(head==='holds'\) return !!p\[1\];\n\s*if\(head==='who'\) return p\.length===2&&!!termFind\(p\[1\]\);/.test(app), "'who reports tomorrow' reaches the phrasebook — the grammar claims `who` only for a listed name");
});

// ===== build 2026.09.16-78: account-synced prefs (watchlist + layouts) ==========================
test("prefs: per-account, last-writer-wins on the client's stamp, shape-checked, size-capped", async () => {
  const A = freshAccounts({});
  try {
    const { g, l } = await seedTwo(A);
    assert.deepEqual(A.prefsGet(g.uid), {}, "nothing stored yet");
    const w1 = A.prefsPut(g.uid, "watch", ["xyz:NVDA", "xyz:AAPL"], 1000);
    assert.deepEqual(w1, { ok: true, stored: true, ts: 1000 });
    // A stale stamp loses quietly — the caller learns it lost (stored:false) and pulls, never a 4xx.
    assert.deepEqual(A.prefsPut(g.uid, "watch", ["xyz:HOOD"], 999), { ok: true, stored: false, ts: 1000 });
    assert.deepEqual(A.prefsPut(g.uid, "watch", ["xyz:HOOD"], 1000), { ok: true, stored: false, ts: 1000 }, "an equal stamp is not newer");
    assert.deepEqual(A.prefsGet(g.uid).watch, { v: ["xyz:NVDA", "xyz:AAPL"], ts: 1000 });
    assert.equal(A.prefsPut(g.uid, "watch", ["xyz:HOOD"], 1001).stored, true);
    assert.deepEqual(A.prefsGet(g.uid).watch.v, ["xyz:HOOD"]);
    // Layouts: the list travels, nothing else — and it is keyed per account, so lena sees none of it.
    assert.equal(A.prefsPut(g.uid, "layouts", { list: { swing: { colOrder: ["ticker"], sortKey: "vol" } } }, 5).stored, true);
    assert.deepEqual(Object.keys(A.prefsGet(g.uid)).sort(), ["layouts", "watch"]);
    assert.deepEqual(A.prefsGet(l.uid), {});
    // Shape and size are the server's business; meaning is the client's.
    assert.equal(A.prefsPut(g.uid, "theme", "dark", 7).ok, false, "unknown key");
    assert.equal(A.prefsPut(g.uid, "watch", "xyz:NVDA", 7).ok, false, "watch must be a list");
    assert.equal(A.prefsPut(g.uid, "watch", [1, 2], 7).ok, false, "of strings");
    assert.equal(A.prefsPut(g.uid, "layouts", { active: "x" }, 7).ok, false, "layouts must carry a list object");
    assert.equal(A.prefsPut(g.uid, "layouts", { list: [] }, 7).ok, false);
    assert.equal(A.prefsPut(g.uid, "watch", ["x"], 0).ok, false, "a stamp is required");
    assert.equal(A.prefsPut(g.uid, "watch", ["x"], "soon").ok, false);
    const big = {}; for (let i = 0; i < 40; i++) big["layout" + i] = { colOrder: Array.from({ length: 200 }, (_, k) => "col" + k + "x".repeat(20)) };
    assert.equal(A.prefsPut(g.uid, "layouts", { list: big }, 8).error, "too large");
    assert.equal(A.prefsGet(g.uid).layouts.ts, 5, "a refused write leaves the stored value alone");
  } finally { A.close(); require("fs").rmSync(A._dir, { recursive: true, force: true }); }
});

// ===== security batch 2026.09.20 ===============================================================
test("security -20: passwords hash on the threadpool, and every row hashed by the old sync code still verifies", async () => {
  const { hashPw, hashPwSync, verifyPw } = require("../src/accounts");
  const fs = require("fs"), path = require("path");
  // The on-disk format is the contract: an operator's accounts.db is full of rows the sync code
  // wrote, and a hash that stops verifying is every member locked out on the deploy.
  const legacy = hashPwSync("a-long-password-12");
  assert.match(legacy, /^scrypt\$16384\$[A-Za-z0-9_-]{22}\$[A-Za-z0-9_-]{86}$/, "scrypt$N$salt$hash, base64url");
  assert.equal(await verifyPw("a-long-password-12", legacy), true, "a sync-era hash verifies through the async path");
  assert.equal(await verifyPw("a-long-password-13", legacy), false);
  const fresh = await hashPw("a-long-password-12");
  assert.ok(fresh instanceof Object === false && typeof fresh === "string", "hashPw resolves to the string, never returns a Promise into a row");
  assert.match(fresh, /^scrypt\$16384\$[A-Za-z0-9_-]{22}\$[A-Za-z0-9_-]{86}$/, "same shape from the async path");
  assert.notEqual(fresh, legacy, "per-password salt");
  assert.equal(await verifyPw("a-long-password-12", fresh), true);
  assert.equal(await verifyPw("x", "scrypt$512$salt$hash"), false, "a cost below the floor is refused, never derived");
  assert.equal(await verifyPw("x", "not-a-hash"), false);
  // The hot path is the async one; scryptSync survives only for the boot-time decoy.
  const src = fs.readFileSync(path.join(__dirname, "..", "src", "accounts.js"), "utf8");
  assert.equal((src.match(/crypto\.scryptSync\(/g) || []).length, 1, "exactly one scryptSync call: the sync hasher");
  assert.ok(/async function verifyPw\(/.test(src) && /async function hashPw\(/.test(src) && /await scryptAsync\(/.test(src));
  for (const fn of ["login", "setPassword", "redeem", "otpVerify", "bootstrap", "claim"])
    assert.ok(new RegExp("async function " + fn + "\\(").test(src), fn + " is async — a route must await it");
  // No await inside a transaction: every hash is derived before BEGIN IMMEDIATE.
  for (const m of src.matchAll(/db\.exec\("BEGIN IMMEDIATE"\);([\s\S]*?)db\.exec\("COMMIT"\)/g))
    assert.ok(!/\bawait\b/.test(m[1]), "an await inside a transaction would interleave another request's writes");
  // Behaviour: sign-in, reset and rotate all still work end to end through the async API.
  const A = freshAccounts();
  try {
    const g = await A.bootstrap("gus", "a-long-password-12");
    assert.ok(g.ok && A.sessionUser(g.token));
    assert.ok((await A.login("gus", "a-long-password-12")).ok);
    assert.ok(!(await A.login("gus", "a-long-password-13")).ok);
    const set = await A.setPassword(g.user.uid, "a-long-password-14");
    assert.ok(set.ok && A.sessionUser(set.token) && !A.sessionUser(g.token), "rotate bumps the epoch");
    assert.ok((await A.login("gus", "a-long-password-14")).ok);
  } finally { A.close(); fs.rmSync(A._dir, { recursive: true, force: true }); }
});

test("security -20: a prior owner handle is adopted as the uid only in the minted shape — never a chosen or reserved id", async () => {
  const { adoptableUid } = require("../src/accounts");
  const crypto = require("crypto");
  const minted = crypto.randomBytes(12).toString("base64url");
  assert.equal(minted.length, 16);
  assert.equal(adoptableUid(minted), minted, "the shape ensureOwner mints is adopted");
  assert.equal(adoptableUid("aLegacyOwnerHandle"), "aLegacyOwnerHandle", "12-32 chars of the alphabet");
  for (const bad of ["legacy-admin", "short", "x".repeat(33), "a|b|c|d|e|f|g|h", "with.dots.in.it", "with spaces here", "", null, undefined, 42, ["a".repeat(16)]])
    assert.equal(adoptableUid(bad), "", "refused: " + JSON.stringify(bad));
  // Through the doors: a forged prior never becomes the uid, and the account is still created.
  const A = freshAccounts();
  try {
    const g = await A.bootstrap("gus", "a-long-password-12", "legacy-admin");
    assert.ok(g.ok && g.user.uid !== "legacy-admin" && /^[A-Za-z0-9_-]{16}$/.test(g.user.uid), "bootstrap: the reserved id is not adopted, a fresh uid is minted");
    const code = (h) => A.mintInvite(g.user.uid, null, 7, "join").invite.code;
    const r1 = await A.redeem(code(), "lena", "another-long-password", "admin|1");
    assert.ok(r1.ok && !r1.adopted && r1.user.uid !== "admin|1", "redeem: a `|` id is a forged cookie, not a handle");
    const r2 = await A.redeem(code(), "marco", "another-long-password", "legacy-admin");
    assert.ok(r2.ok && !r2.adopted && r2.user.uid !== "legacy-admin");
    const r3 = await A.redeem(code(), "dan", "another-long-password", minted);
    assert.ok(r3.ok && r3.adopted && r3.user.uid === minted, "and the genuine minted handle still carries over — the migration promise holds");
    const c = await A.claim("eve", "another-long-password", "x".repeat(40));
    assert.ok(c.ok && !c.adopted && c.user.uid.length === 16, "claim: an over-long id is refused the same way");
    const c2 = await A.claim("fay", "another-long-password", "legacy-admin");
    assert.ok(c2.ok && c2.user.uid !== "legacy-admin");
    assert.equal(A.listUsers().length, 6, "every account was still created — only the adoption was refused");
  } finally { A.close(); require("fs").rmSync(A._dir, { recursive: true, force: true }); }
});
