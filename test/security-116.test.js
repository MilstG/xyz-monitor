"use strict";
// Security pass (build 2026.09.25-116): regression tests for the route audit's findings.
const test = require("node:test");
const assert = require("node:assert/strict");
const { freshAccounts } = require("./_shared");

async function desk() {
  const A = freshAccounts();
  const g = (await A.bootstrap("gus", "correct-horse-battery")).user;
  const mk = async (h) => (await A.redeem(A.mintInvite(g.uid, null, 7, "join").invite.code, h, "another-long-password")).user;
  return { A, g, l: await mk("lena"), m: await mk("marco") };
}
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(64)]);

test("-116 web push: only real push-service hosts, and an endpoint never re-binds to another account", async () => {
  const { A, g, l } = await desk();
  const keys = { p256dh: "a", auth: "b" };
  for (const bad of ["https://10.0.0.5:8443/admin", "https://127.0.0.1/x", "https://localhost/x", "https://169.254.169.254/latest",
    "https://evil.example/fcm.googleapis.com", "https://fcm.googleapis.com.evil.example/x", "https://fcm.googleapis.com:8443/x",
    "https://user:pw@fcm.googleapis.com/x", "https://[::1]/x"])
    assert.equal(A.webPushAdd(g.uid, { endpoint: bad, keys }, "").ok, false, bad);
  for (const ok of ["https://fcm.googleapis.com/fcm/send/abc", "https://updates.push.services.mozilla.com/wpush/v2/x",
    "https://wns2-par02p.notify.windows.com/w/?token=x", "https://web.push.apple.com/QK", "https://fcm.googleapis.com:443/fcm/send/d"])
    assert.equal(A.webPushAdd(g.uid, { endpoint: ok, keys }, "").ok, true, ok);
  // lena presents gus's endpoint: it stays his
  const ep = "https://fcm.googleapis.com/fcm/send/abc";
  A.webPushAdd(l.uid, { endpoint: ep, keys: { p256dh: "x", auth: "y" } }, "");
  assert.ok(A.webPushFor(g.uid).some((s) => s.endpoint === ep && s.keys.p256dh === "a"), "the holder keeps it, keys untouched");
  assert.ok(!A.webPushFor(l.uid).some((s) => s.endpoint === ep), "never re-bound to the presenter");
});

test("-116 uploads: a per-member budget (count and bytes per 10 minutes)", async () => {
  const { A, g, l, m } = await desk();
  const T = A.createGroup(g.uid, "desk", [l.uid, m.uid]).thread;
  let last;
  for (let i = 0; i < 31; i++) last = A.putFile(g.uid, T, "c" + i + ".png", PNG);
  assert.equal(last.ok, false, "the 31st upload in the window is refused");
  assert.equal(last.retry, true);
  assert.ok(A.putFile(l.uid, T, "mine.png", PNG).ok, "the budget is per member");
});

test("-116 departed members: no edits and no call moves in a room they left; deleting their own words stays allowed", async () => {
  const { A, g, l, m } = await desk();
  const T = A.createGroup(g.uid, "desk", [l.uid, m.uid]).thread;
  const msg = A.send(l.uid, null, "hello desk", null, { thread: T }).message;
  assert.ok(A.leaveGroup(l.uid, T).ok);
  const e = A.edit(l.uid, msg.id, "rewritten after leaving");
  assert.equal(e.ok, false);
  assert.match(e.error, /no longer in that conversation/);
  assert.equal(A.callClose(l.uid, msg.id).ok, false);
  assert.equal(A.callExtend(l.uid, msg.id, 3).ok, false);
  assert.ok(A.drop(l.uid, msg.id).ok, "a member may still delete their own message after leaving");
  // the operator's moderation path is unaffected
  const msg2 = A.send(m.uid, null, "still here", null, { thread: T }).message;
  assert.ok(A.edit(g.uid, msg2.id, "moderated", true).ok);
});

test("-116 reset codes: the guess budget is per hour, not per code — a re-send never refills it", async () => {
  const { A } = await desk();
  const first = A.otpRequest("lena");
  assert.ok(first.sent);
  for (let i = 0; i < 5; i++) assert.equal((await A.otpVerify("lena", "000000", "brand-new-password-1")).ok, false);
  const again = A.otpRequest("lena");
  assert.equal(again.sent, false, "five wrong guesses in the window: no fresh code, no fresh guesses");
  assert.equal(again.throttled, true);
  assert.equal((await A.otpVerify("lena", first.code, "brand-new-password-1")).ok, false, "the spent code stays dead");
});

test("-116 telegram adopt: the guess budget survives a re-send, and a spent chat stays locked for the window", () => {
  const { createPoller } = require("../src/poller");
  const store = { loadAll: () => new Map(), loadRegime: () => [], loadLedger: () => null, saveLedger: () => {},
    insert: () => {}, saveRegime: () => {}, loadTriggers: () => null, saveTriggers: () => {}, savePush: () => {},
    loadPush: () => ({ recipients: [{ chat: "555", owner: "", admin: false }] }) };
  const p = createPoller({ dex: "xyz", store, log: () => {}, version: "test", crypto: false });
  p.hydratePushNow();
  const r1 = p.pushAdoptRequest("555", "mallory");
  assert.ok(r1.ok);
  for (let i = 0; i < 3; i++) assert.equal(p.pushAdoptVerify("555", "mallory", "x").ok, false);
  const r2 = p.pushAdoptRequest("555", "mallory");
  assert.ok(r2.ok, "a re-send inside the cap is allowed");
  for (let i = 0; i < 3; i++) assert.equal(p.pushAdoptVerify("555", "mallory", "x").ok, false);
  assert.equal(p.pushAdoptVerify("555", "mallory", r2.code).ok, false, "past five guesses in total, even the right code is refused");
  assert.equal(p.pushAdoptRequest("555", "mallory").error, "throttled", "and no fresh code (or guesses) until the window lapses");
});

test("-116 filed PDFs: a deflate bomb is capped, never inflated in full", () => {
  const C = require("../src/compute");
  const zlib = require("zlib");
  const bomb = zlib.deflateSync(Buffer.alloc(48 * 1024 * 1024));   // ~48 MB of zeros in ~50 KB
  const pdf = Buffer.concat([Buffer.from("%PDF-1.4\n1 0 obj\n<< /Length " + bomb.length + " /Filter /FlateDecode >>\nstream\n", "latin1"),
    bomb, Buffer.from("\nendstream\nendobj\n%%EOF\n", "latin1")]);
  const objs = C.pdfObjects(pdf);
  const o = objs.get(1);
  assert.ok(o, "the object parses");
  assert.ok(o.data == null || o.data.length <= 32 * 1024 * 1024, "the stream is dropped at the 32 MB cap, not decoded to 48 MB");
});

test("-116 EDGAR pull-throughs: cache misses share a per-minute budget; the cache evicts oldest-first", async () => {
  const { createPoller } = require("../src/poller");
  const store = { loadAll: () => new Map(), loadRegime: () => [], loadLedger: () => null, saveLedger: () => {},
    insert: () => {}, saveRegime: () => {}, loadTriggers: () => null, saveTriggers: () => {} };
  let fetches = 0;
  const extFetch = async () => { fetches++; return { ok: false, status: 503, headers: { get: () => null } }; };
  const p = createPoller({ dex: "xyz", store, log: () => {}, version: "test", crypto: false, extFetch });
  const out = [];
  for (let i = 0; i < 22; i++) out.push(await p.fundamentals("SYM" + String.fromCharCode(65 + i)));
  assert.ok(out.slice(0, 20).every((r) => !r.retry), "the first 20 misses in a minute go out");
  assert.ok(out.slice(20).every((r) => r.retry === true), "the 21st is refused with a retry hint (429 on the wire)");
  const before = fetches;
  await p.fundamentals("SYMA");
  assert.equal(fetches, before, "a cached answer is free — it never touches the budget or the network");
});

test("-116 DM cursor: a member's sync and history cursors are their OWN newest message, never the site-wide count", async () => {
  const { A, g, l, m } = await desk();
  const gl = A.threadFor(g.uid, l.uid, true).id, gm = A.threadFor(g.uid, m.uid, true).id;
  const mine = A.send(g.uid, null, "hi lena", null, { thread: gl }).message;
  const c0 = A.sync(l.uid, 0).cursor;
  assert.equal(c0, mine.id);
  for (let i = 0; i < 5; i++) A.send(g.uid, null, "private to marco " + i, null, { thread: gm });
  assert.equal(A.sync(l.uid, c0).cursor, c0, "five DMs between two other people move nothing lena can see");
  assert.equal(A.msgSeqFor(l.uid), mine.id);
  assert.ok(A.msgSeq() > A.msgSeqFor(l.uid), "the global counter still exists server-side, it just never reaches her");
  assert.equal(A.history(l.uid, gl).cursor, mine.id);
  const next = A.send(g.uid, null, "again", null, { thread: gl }).message;
  const s = A.sync(l.uid, c0);
  assert.deepEqual(s.messages.map((x) => x.id), [next.id], "a new message in her thread still arrives");
  assert.equal(s.cursor, next.id);
});

test("-116 API reference: every route the server registers is in the manual's HTTP API section", () => {
  const fs = require("fs"), path = require("path");
  const srv = fs.readFileSync(path.join(__dirname, "..", "server.js"), "utf8");
  const docs = fs.readFileSync(path.join(__dirname, "..", "public", "docs.html"), "utf8");
  const api = docs.slice(docs.indexOf('<section id="api">'), docs.indexOf("</section>", docs.indexOf('<section id="api">')));
  // Documented paths: every <code> in the section, methods dropped, query dropped, and a final
  // segment written a|b|c expanded into its alternatives.
  const documented = new Set();
  for (const m of api.matchAll(/<code>([^<]+)<\/code>/g)) {
    let t = m[1].replace(/&amp;/g, "&").trim().replace(/^(?:GET|POST)(?:\|(?:GET|POST))*\s+/, "");
    if (!t.startsWith("/")) continue;
    t = t.split("?")[0];
    const i = t.lastIndexOf("/");
    const head = t.slice(0, i + 1), tail = t.slice(i + 1);
    for (const alt of tail.split("|")) documented.add(head + alt);
  }
  const routes = [...srv.matchAll(/fastify\.(?:get|post|put|delete|patch)\("([^"]+)"/g)].map((m) => m[1]);
  const missing = [...new Set(routes)].filter((r) => !documented.has(r));
  assert.deepEqual(missing, [], "undocumented routes — add them to public/docs.html § HTTP API");
});
