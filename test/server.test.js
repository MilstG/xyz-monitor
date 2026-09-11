"use strict";
// HTTP-level tests: server.js built as a module and driven through fastify.inject(). The suite in
// test.js pins source text; these pin BEHAVIOUR at the auth boundaries — the gate, the cookies,
// the admin lease, the body limits — which is the only way a hook that double-sends, a redirect
// whose argument order changed, or a cookie that outlives its account can be caught before deploy.
const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs"), path = require("path"), os = require("os");

// Environment is read at require time, so it is set before server.js loads, once for the file.
const DATA = fs.mkdtempSync(path.join(os.tmpdir(), "xyz-srv-"));
process.env.DATA_DIR = DATA;
process.env.SITE_PASSWORD = "shared-door-pw";
process.env.SITE_USER = "friend";
process.env.ADMIN_PASSWORD = "break-glass-pw-1";
process.env.XYZ_QUIET = "1";
delete process.env.TG_BOT_TOKEN; delete process.env.FINNHUB_TOKEN; delete process.env.FRED_KEY;
const { buildServer } = require("../server.js");

const JSONH = { "content-type": "application/json" };
// Cookie jar over inject(): the set-cookie header is an array of "name=value; attrs" strings.
function jar() {
  const c = new Map();
  return {
    absorb(res) {
      const sc = res.headers["set-cookie"];
      for (const line of Array.isArray(sc) ? sc : (sc ? [sc] : [])) {
        const [nv, ...attrs] = line.split(";");
        const i = nv.indexOf("="), name = nv.slice(0, i).trim(), val = nv.slice(i + 1).trim();
        const dead = attrs.some((a) => /max-age=0/i.test(a));
        if (dead || val === "x") c.delete(name); else c.set(name, val);
      }
      return res;
    },
    header() { return [...c].map(([k, v]) => k + "=" + v).join("; "); },
    get(name) { return c.get(name) || null; },
  };
}

let app;
test.before(async () => { app = await buildServer(); });
test.after(async () => { await app.close(); });

const post = (url, body, j, extra) => app.inject({ method: "POST", url, headers: Object.assign({}, JSONH, j ? { cookie: j.header() } : {}, extra || {}), payload: body == null ? undefined : JSON.stringify(body) });
const get = (url, j, extra) => app.inject({ method: "GET", url, headers: Object.assign({}, j ? { cookie: j.header() } : {}, extra || {}) });

test("gate: signed-out callers get the login page for pages and 401 JSON for the API; health stays open", async () => {
  const r = await get("/");
  assert.equal(r.statusCode, 401);
  assert.match(r.headers["content-type"], /text\/html/);
  assert.match(r.body, /<form|authInit|password/i);
  assert.equal(r.headers["cache-control"], "no-store");
  const a = await get("/api/snapshot");
  assert.equal(a.statusCode, 401);
  assert.deepEqual(JSON.parse(a.body), { error: "unauthorized" });
  assert.equal((await get("/api/health")).statusCode, 200);
  // The hardening headers ride every response, including the 401s.
  for (const res of [r, a]) {
    assert.equal(res.headers["x-frame-options"], "DENY");
    assert.equal(res.headers["x-content-type-options"], "nosniff");
    assert.equal(res.headers["referrer-policy"], "same-origin");
  }
  // The async hook returns the reply: exactly one response, no double-send (the bug the comments describe).
  assert.ok(!/unauthorized.*unauthorized/s.test(a.body));
});

test("gate: Basic auth needs the real shared password; the AI-cost routes are 401 without it", async () => {
  const bad = await get("/api/snapshot", null, { authorization: "Basic " + Buffer.from("friend:nope").toString("base64") });
  assert.equal(bad.statusCode, 401);
  const ok = await get("/api/health", null, { authorization: "Basic " + Buffer.from("friend:shared-door-pw").toString("base64") });
  assert.equal(ok.statusCode, 200);
  const ai = await post("/api/ask", { q: "hi" });
  assert.equal(ai.statusCode, 401, "unauthenticated AI spend is refused before any route runs");
});

test("login: the ADMIN_PASSWORD break-glass mints a uid-less lease; bootstrap makes account #1 and then closes", async () => {
  const j = jar();
  const wrong = j.absorb(await post("/login", { password: "not-it" }));
  assert.equal(wrong.statusCode, 401);
  assert.equal(j.get("xyzadm"), null);
  const r = j.absorb(await post("/login", { password: "break-glass-pw-1" }));
  assert.equal(r.statusCode, 200);
  assert.deepEqual(JSON.parse(r.body), { ok: true, admin: true, next: "/bootstrap" });
  assert.equal(j.get("xyzadm").split(".").length, 2, "break-glass lease is the uid-less form");
  for (const line of r.headers["set-cookie"]) if (/^xyz(sess|adm)=/.test(line)) assert.match(line, /HttpOnly/), assert.match(line, /SameSite=Lax/);
  assert.equal((await get("/bootstrap", j)).statusCode, 200);
  const b = j.absorb(await post("/bootstrap", { handle: "gus", password: "a-long-password-12" }, j));
  assert.equal(b.statusCode, 200);
  assert.deepEqual(JSON.parse(b.body), { ok: true, next: "/" });
  const closed = await get("/bootstrap", j);
  assert.equal(closed.statusCode, 302);
  assert.equal(closed.headers.location, "/login", "redirect(url, code): the v5 order actually redirects");
  assert.equal((await get("/", j)).statusCode, 200, "signed in, the shell renders");
});

test("admin lease: an account-issued cookie is bound to the account — demotion and disable revoke it, re-promotion revives it", async () => {
  const gus = jar();
  gus.absorb(await post("/login", { handle: "gus", password: "a-long-password-12" }));
  assert.equal(gus.get("xyzadm").split(".").length, 4, "account form carries uid.epoch.exp.mac");
  assert.equal((await get("/api/access", gus)).statusCode, 200);
  // Invite bob through the real door: the code moves into a cookie and the URL is redirected bare.
  const mint = JSON.parse((await post("/api/access", { op: "mint", days: 1 }, gus)).body);
  const code = mint.code || (mint.invite && mint.invite.code);
  assert.ok(code, JSON.stringify(mint));
  const bob = jar();
  const door = bob.absorb(await get("/join/" + code, bob));
  assert.equal(door.statusCode, 302); assert.equal(door.headers.location, "/join");
  assert.ok(bob.get("xyzinv"), "the invite rides an HttpOnly cookie, not the URL");
  const joined = bob.absorb(await post("/join", { handle: "bob", password: "another-long-pw-12" }, bob));
  assert.equal(joined.statusCode, 200, joined.body);
  assert.equal((await get("/api/access", bob)).statusCode, 403, "a member is not an operator");
  const members = JSON.parse((await get("/api/access", gus)).body).members;
  const uid = members.find((m) => m.handle === "bob").uid;
  assert.equal(JSON.parse((await post("/api/access", { op: "admin", uid, on: true }, gus)).body).ok, true);
  bob.absorb(await post("/login", { handle: "bob", password: "another-long-pw-12" }));
  assert.equal(bob.get("xyzadm").split(".").length, 4);
  assert.equal((await get("/api/access", bob)).statusCode, 200, "promoted: the lease works");
  assert.equal(JSON.parse((await post("/api/access", { op: "admin", uid, on: false }, gus)).body).ok, true);
  assert.equal((await get("/api/access", bob)).statusCode, 403, "demoted: the SAME cookie is refused on the next request");
  assert.equal(JSON.parse((await post("/api/access", { op: "admin", uid, on: true }, gus)).body).ok, true);
  assert.equal((await get("/api/access", bob)).statusCode, 200, "re-promoted: revived without a new sign-in");
  assert.equal(JSON.parse((await post("/api/access", { op: "disable", uid }, gus)).body).ok, true);
  assert.equal((await get("/api/access", bob)).statusCode, 401, "disabled: the epoch bump kills the session too");
  // A forged 4-part cookie for gus with the wrong MAC is refused; the audit row names the bound uid.
  const forged = jar(); forged.absorb(await post("/login", { handle: "gus", password: "a-long-password-12" }));
  const parts = forged.get("xyzadm").split("."); parts[3] = parts[3].replace(/./g, "A");
  const f = await get("/api/access", null, { cookie: "xyzadm=" + parts.join(".") });
  assert.equal(f.statusCode, 401);
});

test("limits: per-route body limits hold, the feature gate answers 403 only to authenticated callers, dotfiles are never served", async () => {
  const gus = jar(); gus.absorb(await post("/login", { handle: "gus", password: "a-long-password-12" }));
  const big = await post("/api/notes", { coin: "xyz:AAPL", body: "x".repeat(20000) }, gus);
  assert.equal(big.statusCode, 413, "16 KB limit on /api/notes");
  assert.equal((await post("/api/notes", { coin: "xyz:AAPL", body: "x" })).statusCode, 401, "site gate before feature gate");
  assert.ok([403, 404].includes((await get("/.env", gus)).statusCode), "dotfiles: deny (the plugin's default would serve it)");
  assert.equal((await get("/styles.css", gus)).statusCode, 200);
  const tab = await app.inject({ method: "POST", url: "/api/features", headers: { cookie: gus.header(), "content-type": "application/json\t" }, payload: "{}" });
  assert.notEqual(tab.statusCode, 200, "a Content-Type with a trailing tab is not JSON");
});

test("health carries a stale flag; /reset has its own per-IP allowance", async () => {
  const h = JSON.parse((await get("/api/health")).body);
  assert.equal(h.stale, false); assert.equal(h.lastPollAgoMs, null, "no poll has run under test");
  let last = 0;
  for (let i = 0; i < 6; i++) last = (await post("/reset", { handle: "gus" }, null, { "x-forwarded-for": "203.0.113.9" })).statusCode;
  assert.equal(last, 429, "the sixth reset in an hour from one address is refused");
  assert.equal((await post("/reset", { handle: "gus" }, null, { "x-forwarded-for": "203.0.113.10" })).statusCode, 200, "another address is unaffected");
});

test("lows: health hides diagnostics from signed-out callers; operator-only writes answer 403 to members", async () => {
  const anon = JSON.parse((await get("/api/health")).body);
  assert.equal(anon.ok, true); assert.equal(anon.volume, undefined, "the volume path is not for the open internet");
  const gus = jar(); gus.absorb(await post("/login", { handle: "gus", password: "a-long-password-12" }));
  const rich = JSON.parse((await get("/api/health", gus)).body);
  assert.ok(rich.volume && rich.loop, "a signed-in caller gets the diagnostics");
  const bob = jar(); bob.absorb(await post("/login", { handle: "bob", password: "another-long-pw-12" }));
  // bob was disabled by the admin-lease test; a disabled member is 401, an enabled non-admin would be 403 — either way, never 200.
  const v = await post("/api/earnings/void", { t: "AAPL", d: "2026-01-01" }, bob);
  assert.notEqual(v.statusCode, 200);
  const c = await post("/api/news/channels", { channels: ["x"] }, bob);
  assert.notEqual(c.statusCode, 200);
  assert.equal((await get("/join/NOT-A-REAL-CODE-1")).statusCode, 410);
});

test("chat terminal -69: a member may post computed results, AI results are admin-locked by default, and /api/ask honours ctx.via", async () => {
  const gus = jar(); gus.absorb(await post("/login", { handle: "gus", password: "a-long-password-12" }));
  // A fresh member through the real door (bob was disabled upstream).
  const mint = JSON.parse((await post("/api/access", { op: "mint", days: 1 }, gus)).body);
  const code = mint.code || (mint.invite && mint.invite.code);
  const cara = jar(); cara.absorb(await get("/join/" + code, cara));
  assert.equal(cara.absorb(await post("/join", { handle: "cara", password: "yet-another-long-pw" }, cara)).statusCode, 200);
  const members = JSON.parse((await get("/api/access", gus)).body).members;
  const caraUid = members.find((m) => m.handle === "cara").uid, gusUid = members.find((m) => m.handle === "gus").uid;
  // Open the pair thread with an ordinary message, then post a computed result into it.
  const first = JSON.parse((await post("/api/dm", { to: gusUid, body: "hi" }, cara)).body);
  assert.ok(first.ok, JSON.stringify(first));
  const T = first.thread;
  const local = await post("/api/dm", { thread: T, body: "TOP FUNDING\n 1 NVDA +41%", cmd: "top funding 5" }, cara);
  assert.equal(local.statusCode, 200, local.body);
  const lm = JSON.parse(local.body).message;
  assert.equal(lm.cmd, "top funding 5"); assert.equal(lm.cmdAi, false); assert.equal(lm.ref, null);
  // The AI half: a member is refused by default, the switch is named; the operator passes.
  const aiPost = await post("/api/dm", { thread: T, body: "because …", cmd: "why is nvda up", cmdAi: true }, cara);
  assert.equal(aiPost.statusCode, 403);
  assert.deepEqual(JSON.parse(aiPost.body), { ok: false, error: "feature-gated", feature: "dm.ask" });
  const aiAsk0 = await post("/api/ask", { q: "why is nvda up", ctx: { via: "dm" } }, cara);
  assert.equal(aiAsk0.statusCode, 403); assert.equal(JSON.parse(aiAsk0.body).feature, "ai.ask", "the route gate stands first");
  // Open the terminal's own AI to members: the chat switch still stands on its own, and refuses
  // the SPEND — the question never reaches the model, let alone the thread.
  assert.equal(JSON.parse((await post("/api/features", { key: "ai.ask", state: "public" }, gus)).body).ok, true);
  const aiAsk = await post("/api/ask", { q: "why is nvda up", ctx: { via: "dm" } }, cara);
  assert.equal(aiAsk.statusCode, 403, aiAsk.body);
  assert.deepEqual(JSON.parse(aiAsk.body), { ok: false, error: "feature-gated", feature: "dm.ask" });
  assert.equal(JSON.parse((await post("/api/features", { key: "ai.ask", state: "admin" }, gus)).body).ok, true);
  const gusAi = await post("/api/dm", { thread: T, body: "because …", cmd: "why is nvda up", cmdAi: true }, gus);
  assert.equal(gusAi.statusCode, 200, gusAi.body);
  assert.equal(JSON.parse(gusAi.body).message.cmdAi, true);
  // Flip the switch and the same member passes; flip the grammar off and even a computed post is refused.
  assert.equal(JSON.parse((await post("/api/features", { key: "dm.ask", state: "public" }, gus)).body).ok, true);
  assert.equal((await post("/api/dm", { thread: T, body: "because …", cmd: "why is nvda up", cmdAi: true }, cara)).statusCode, 200);
  assert.equal(JSON.parse((await post("/api/features", { key: "dm.terminal", state: "admin" }, gus)).body).ok, true);
  const off = await post("/api/dm", { thread: T, body: "x", cmd: "breadth" }, cara);
  assert.equal(off.statusCode, 403); assert.equal(JSON.parse(off.body).feature, "dm.terminal");
  assert.equal((await post("/api/dm", { thread: T, body: "plain prose still sends" }, cara)).statusCode, 200, "the gate is on the cmd field, not on the verb");
  // A command result can't be edited over the wire either.
  const ed = await post("/api/dm", { id: lm.id, body: "reworded" }, cara);
  assert.equal(ed.statusCode, 400); assert.match(JSON.parse(ed.body).error, /can't be edited/);
  assert.equal(JSON.parse((await post("/api/features", { key: "dm.terminal", state: "public" }, gus)).body).ok, true);
  assert.equal(JSON.parse((await post("/api/features", { key: "dm.ask", state: "admin" }, gus)).body).ok, true);
  void caraUid;
});
