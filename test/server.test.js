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
process.env.TRUST_PROXY = "1";   // -116: unset now means off away from Railway; these tests exercise the edge-appended XFF path
process.env.XYZ_NO_NET = "1";
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
test.before(async () => {
  app = await buildServer();
  // A route that fails the way a driver failure does — registered on the TEST instance only, so
  // the error handler's contract (no driver text on the wire) is pinned as behaviour.
  app.get("/__test/throw", () => { throw new Error("Provided value cannot be bound to SQLite parameter"); });
});
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
  // gus is the operator (account #1): the volume path is admin-only since 2026.09.20 — the member
  // view is pinned in the security batch below.
  const gus = jar(); gus.absorb(await post("/login", { handle: "gus", password: "a-long-password-12" }));
  const rich = JSON.parse((await get("/api/health", gus)).body);
  assert.ok(rich.volume && rich.loop, "an operator gets the diagnostics");
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

test("csp: every HTML page carries a report-only policy whose nonce is stamped on its inline scripts; reports land on health", async () => {
  // The signed-out login page and the signed-in shell are the two HTML shapes the server emits.
  const gus = jar(); gus.absorb(await post("/login", { handle: "gus", password: "a-long-password-12" }));
  for (const res of [await get("/"), await get("/", gus)]) {
    const csp = res.headers["content-security-policy-report-only"];
    assert.ok(csp, "report-only header present");
    assert.equal(res.headers["content-security-policy"], undefined, "report-only: nothing is enforced by default");
    // CSP_ENFORCE=1 sends the SAME policy text as Content-Security-Policy (one policy, two headers),
    // so what was observed clean under report-only is exactly what enforcement blocks.
    const srvSrc = require("fs").readFileSync(require("path").join(__dirname, "..", "server.js"), "utf8");
    assert.ok(srvSrc.includes('const CSP_HEADER = CSP_ENFORCE ? "content-security-policy" : "content-security-policy-report-only";'), "the enforce switch picks the header, never a second policy");
    assert.ok(srvSrc.includes("reply.header(CSP_HEADER, cspPolicy(nonce));"), "one header site, driven by the switch");
    const nonce = (csp.match(/'nonce-([^']+)'/) || [])[1];
    assert.ok(nonce && nonce.length >= 16, "the policy names a nonce");
    assert.ok(!res.body.includes("{{csp-nonce}}"), "no slot survives to the browser");
    const inline = [...res.body.matchAll(/<script(?![^>]*\bsrc=)([^>]*)>/g)].map((m) => m[1]);
    assert.ok(inline.length >= 2, "both pages carry inline scripts");
    for (const attrs of inline) assert.match(attrs, new RegExp('nonce="' + nonce.replace(/[+/=]/g, "\\$&") + '"'), "every inline script carries this response's nonce");
    assert.match(csp, /report-uri \/api\/csp-report/); assert.match(csp, /frame-ancestors 'none'/);
    assert.equal(res.headers["reporting-endpoints"], 'csp="/api/csp-report"');
  }
  // Two responses, two nonces: a nonce that repeats is a hash with extra steps.
  const a = (await get("/", gus)).headers["content-security-policy-report-only"], b = (await get("/", gus)).headers["content-security-policy-report-only"];
  assert.notEqual(a, b);
  // JSON never grows a policy header (nothing inline to nonce), static assets neither.
  assert.equal((await get("/api/health")).headers["content-security-policy-report-only"], undefined);
  assert.equal((await get("/styles.css", gus)).headers["content-security-policy-report-only"], undefined);
  // A browser's report, in both wire shapes, no session required, is counted and summarized for the operator.
  const legacy = await app.inject({ method: "POST", url: "/api/csp-report", headers: { "content-type": "application/csp-report" },
    payload: JSON.stringify({ "csp-report": { "effective-directive": "script-src", "blocked-uri": "inline", "source-file": "https://x/app.js", "line-number": 12 } }) });
  assert.equal(legacy.statusCode, 204);
  const modern = await app.inject({ method: "POST", url: "/api/csp-report", headers: { "content-type": "application/reports+json" },
    payload: JSON.stringify([{ type: "csp-violation", body: { effectiveDirective: "img-src", blockedURL: "http://evil/x.png" } }]) });
  assert.equal(modern.statusCode, 204);
  assert.equal((await app.inject({ method: "POST", url: "/api/csp-report", headers: { "content-type": "application/csp-report" }, payload: "not json" })).statusCode, 204, "garbage is dropped, never a 500");
  const h = JSON.parse((await get("/api/health", gus)).body);
  assert.ok(h.csp && h.csp.reports >= 2, JSON.stringify(h.csp));
  assert.ok(h.csp.recent.some((r) => r.directive === "script-src" && r.line === 12) && h.csp.recent.some((r) => r.directive === "img-src"));
  assert.ok(!h.csp.recent.some((r) => "key" in r), "the dedupe key is internal");
  assert.equal(JSON.parse((await get("/api/health")).body).csp, undefined, "the ledger is diagnostics: signed-in only");
});

test("prefs: /api/prefs is an account surface — 401 signed out, round-trips per member, stale stamps report stored:false", async () => {
  assert.equal((await get("/api/prefs")).statusCode, 401);
  const gus = jar(); gus.absorb(await post("/login", { handle: "gus", password: "a-long-password-12" }));
  assert.deepEqual(JSON.parse((await get("/api/prefs", gus)).body), { ok: true, prefs: {} });
  const w = await post("/api/prefs", { key: "watch", value: ["xyz:NVDA"], ts: 5000, tab: "t1" }, gus);
  assert.equal(w.statusCode, 200, w.body); assert.deepEqual(JSON.parse(w.body), { ok: true, stored: true, ts: 5000 });
  assert.deepEqual(JSON.parse((await post("/api/prefs", { key: "watch", value: [], ts: 4000 }, gus)).body), { ok: true, stored: false, ts: 5000 });
  assert.deepEqual(JSON.parse((await get("/api/prefs", gus)).body).prefs.watch, { v: ["xyz:NVDA"], ts: 5000 });
  const bad = await post("/api/prefs", { key: "font", value: 3, ts: 1 }, gus);
  assert.equal(bad.statusCode, 400);
  assert.equal((await get("/api/prefs", gus)).headers["cache-control"], "no-store");
});

test("positions: the wallet is an account surface — validated, one per member, the read kicks the lane and never blocks on it", async () => {
  assert.equal((await get("/api/positions")).statusCode, 401);
  const gus = jar(); gus.absorb(await post("/login", { handle: "gus", password: "a-long-password-12" }));
  assert.deepEqual(JSON.parse((await get("/api/positions", gus)).body), { ok: true, wallet: null, positions: [], summary: null, ts: 0, pending: false, err: null });
  const bad = await post("/api/positions", { addr: "0x1234" }, gus);
  assert.equal(bad.statusCode, 400); assert.match(JSON.parse(bad.body).error, /EVM address/);
  const addr = "0xABCDEF0123456789abcdef0123456789ABCDEF01";
  const ok = JSON.parse((await post("/api/positions", { addr, label: "  main book  " }, gus)).body);
  assert.equal(ok.ok, true); assert.equal(ok.wallet.addr, addr.toLowerCase(), "stored lowercase"); assert.equal(ok.wallet.label, "main book");
  const first = JSON.parse((await get("/api/positions", gus)).body);
  assert.equal(first.wallet.addr, addr.toLowerCase()); assert.equal(first.pending, true, "first read: the lane has nothing yet and is kicked");
  await new Promise((r) => setTimeout(r, 30));
  const second = JSON.parse((await get("/api/positions", gus)).body);
  assert.equal(second.pending, false); assert.match(second.err, /XYZ_NO_NET/, "the kicked read failed fast and said why"); assert.deepEqual(second.positions, []);
  // Another member sees nothing of it.
  const cara = jar(); cara.absorb(await post("/login", { handle: "cara", password: "yet-another-long-pw" }));
  assert.equal(JSON.parse((await get("/api/positions", cara)).body).wallet, null);
  assert.deepEqual(JSON.parse((await post("/api/positions", { remove: true }, gus)).body), { ok: true, wallet: null });
  assert.equal(JSON.parse((await get("/api/positions", gus)).body).wallet, null);
});

test("modules: the entry is a module, every /js module is served stamped, precompressed and immutable at the current stamp", async () => {
  const gus = jar(); gus.absorb(await post("/login", { handle: "gus", password: "a-long-password-12" }));
  const { VERSION } = require("../server.js");
  const shell = (await get("/", gus)).body;
  assert.ok(shell.includes(`<script type="module" src="/app.js?v=${VERSION}"></script>`), "the shell loads the entry as a module, stamped");
  const entry = await get("/app.js?v=" + VERSION, gus);
  assert.equal(entry.statusCode, 200);
  assert.match(entry.headers["cache-control"], /immutable/);
  assert.ok(/import \{ __boot_core_1 \} from "\.\/js\/core\.js\?v=/.test(entry.body), "the entry's imports carry the build stamp: " + entry.body.slice(0, 400));
  assert.ok(!/from "\.\/js\/[a-z]+\.js"/.test(entry.body), "no unstamped import survives");
  const core = await get("/js/core.js?v=" + VERSION, gus);
  assert.equal(core.statusCode, 200); assert.match(core.headers["content-type"], /javascript/); assert.match(core.headers["cache-control"], /immutable/);
  assert.ok(core.headers.etag, "strong content identity on modules too");
  assert.equal((await get("/js/core.js?v=" + VERSION, gus, { "if-none-match": core.headers.etag })).statusCode, 304);
  const br = await get("/js/markets.js?v=" + VERSION, gus, { "accept-encoding": "br" });
  assert.equal(br.headers["content-encoding"], "br", "modules ride the brotli-at-boot path");
  // (build 2026.09.24-108) a stamp from another build is refused outright (409, no-store) — see fixes-108
  const stale = await get("/js/core.js?v=old", gus);
  assert.equal(stale.statusCode, 409); assert.equal(stale.headers["cache-control"], "no-store", "a stale stamp is never answered with this build's bytes, nor cached");
  const raw = require("fs").readFileSync(require("path").join(__dirname, "..", "public", "js", "markets.js"), "utf8");
  assert.ok(/from "\.\/core\.js"/.test(raw), "on disk the modules stay unstamped");
  assert.ok((await get("/js/markets.js", gus)).body.includes(`from "./core.js?v=${VERSION}"`), "and stamped on the wire");
});

test("modules -108: a stamped asset from ANOTHER build is a 409 (no-store); current, unstamped and the worker's cache rule are unchanged", async () => {
  const gus = jar(); gus.absorb(await post("/login", { handle: "gus", password: "a-long-password-12" }));
  const { VERSION } = require("../server.js");
  // The repro: a tab open across a deploy lazily imports charts.js with LAST build's stamp. It used
  // to get THIS build's bytes, whose imports name core.js?v=<new> — a second core.js instance.
  for (const u of ["/js/charts.js?v=2026.09.24-107", "/app.js?v=old", "/styles.css?v=old", "/js/core.js?v=" + VERSION + "&v=x", "/js/core.js?v="]) {
    const r = await get(u, gus);
    assert.equal(r.statusCode, 409, u); assert.equal(r.headers["cache-control"], "no-store", u + " is never cached");
    assert.ok(!/immutable/.test(r.headers["cache-control"]));
  }
  for (const u of ["/js/charts.js?v=" + VERSION, "/app.js?v=" + VERSION, "/styles.css?v=" + VERSION]) {
    const r = await get(u, gus);
    assert.equal(r.statusCode, 200, u); assert.match(r.headers["cache-control"], /immutable/, u);
  }
  for (const u of ["/js/charts.js", "/app.js", "/styles.css", "/js/charts.js?x=1"]) assert.equal((await get(u, gus)).statusCode, 200, "no v, no refusal: " + u);
  // the shell's own stamps are the current build, so a normal load never meets the 409
  const shell = (await get("/", gus)).body;
  const stamps = [...shell.matchAll(/(?:src|href)="[^"]*[?&]v=([^"&]+)"/g)].map((m) => m[1]);
  assert.ok(stamps.length >= 3 && stamps.every((v) => v === VERSION), "every stamp in the shell is current: " + [...new Set(stamps)]);
  // the worker keeps complete 200s only — a 409 passes through uncached
  const sw = (await get("/sw.js", gus)).body;
  assert.ok(sw.includes("if (res && res.status === 200 && res.type === \"basic\")"), "the service worker caches 200s only");
});

test("modules -103: lazy import() specifiers, modulepreload hints and the service worker all carry the build stamp", async () => {
  const gus = jar(); gus.absorb(await post("/login", { handle: "gus", password: "a-long-password-12" }));
  const { VERSION } = require("../server.js");
  const core = (await get("/js/core.js?v=" + VERSION, gus)).body;
  for (const m of ["charts", "drawdown", "funds", "insiders", "positioning"])
    assert.ok(core.includes(`${m}:()=>import("./${m}.js?v=${VERSION}")`), "lazy specifier stamped on the wire: " + m);
  assert.ok(!/import\("\.\/[a-z]+\.js"\)/.test(core), "no unstamped dynamic import survives");
  const entry = (await get("/app.js?v=" + VERSION, gus)).body;
  assert.ok(!entry.includes("/charts.js") && !entry.includes("/insiders.js"), "the entry does not pull the lazy tabs");
  const shell = (await get("/", gus)).body;
  for (const m of ["core", "data", "markets"])
    assert.ok(shell.includes(`<link rel="modulepreload" href="/js/${m}.js?v=${VERSION}">`), "modulepreload stamped: " + m);
  const sw = await get("/sw.js", gus);
  assert.equal(sw.statusCode, 200); assert.equal(sw.headers["cache-control"], "no-cache");
  assert.ok(sw.body.includes(`const BUILD = "${VERSION}";`) && !sw.body.includes("{{build}}"), "the worker knows exactly one cacheable stamp");
  assert.ok(sw.body.includes('addEventListener("push"'), "push handling ships intact");
});

// ===== security batch 2026.09.20 ===============================================================
test("security -20: JSON inside inline scripts is HTML-safe — ?next= and a renamed display cannot close the script tag", async () => {
  // The login page: a ?next= that used to pass safeNext (no whitespace) and land raw inside
  // window.__AUTH. Now refused by the character allow-list AND, belt to braces, escaped on the way in.
  const evil = "/x</script><script>alert(1)</script>";
  const r = await get("/login?next=" + encodeURIComponent(evil));
  assert.equal(r.statusCode, 200);
  assert.ok(!r.body.includes("</script><script>alert"), "no raw </script> from the query survives into the page");
  assert.ok(r.body.includes('window.__AUTH={"action":"/login","mode":"signin","next":null}'), "the tightened safeNext drops it");
  // A legitimate next round-trips, with the JSON-legal escapes a browser parses back to the same characters.
  const ok = await get("/login?next=" + encodeURIComponent("/?tab=markets&t=NVDA#x"));
  assert.ok(ok.body.includes('"next":"/?tab=markets\\u0026t=NVDA#x"'), ok.body.slice(ok.body.indexOf("window.__AUTH"), ok.body.indexOf("window.__AUTH") + 120));
  for (const bad of ["//evil.example", "/x y", "/x\\y", "http://evil", "/" + "a".repeat(200), "/x<y"])
    assert.ok(!(await get("/login?next=" + encodeURIComponent(bad))).body.includes('"next":"' + bad.slice(0, 5)), "refused: " + bad);
  const gus = jar(); gus.absorb(await post("/login", { handle: "gus", password: "a-long-password-12" }));
  assert.deepEqual(JSON.parse((await post("/login", { handle: "gus", password: "a-long-password-12", next: evil })).body), { ok: true, next: "/" });
  // The shell: a display name is member text the operator can set, and it rides window.__ME.
  const members = JSON.parse((await get("/api/access", gus)).body).members;
  const cara = members.find((m) => m.handle === "cara");
  assert.ok(cara, "cara exists from the chat test above");
  const ren = JSON.parse((await post("/api/access", { op: "rename", uid: cara.uid, handle: "</script><script>x" }, gus)).body);
  assert.equal(ren.ok, true, JSON.stringify(ren));
  const cj = jar(); cj.absorb(await post("/login", { handle: "cara", password: "yet-another-long-pw" }));
  const shell = await get("/", cj);
  assert.equal(shell.statusCode, 200);
  assert.ok(!shell.body.includes("</script><script>x"), "the renamed display cannot break out of the boot script");
  assert.ok(shell.body.includes('\\u003c/script\\u003e\\u003cscript\\u003ex'), "it is escaped in place, so the client still reads the name");
  assert.ok(shell.body.includes("window.__ME={"), "and identity still rides the shell");
  assert.equal(JSON.parse((await post("/api/access", { op: "rename", uid: cara.uid, handle: "cara" }, gus)).body).ok, true);
  // Every JSON-in-HTML site goes through the helper: grep the source for the pattern this test guards.
  const srv = require("fs").readFileSync(require("path").join(__dirname, "..", "server.js"), "utf8");
  assert.ok(/function jsonForScript\(v\)/.test(srv) && /\\u003c/.test(srv) && /\\u2028/.test(srv));
  for (const site of ["window.__AUTH=' + jsonForScript(", '"window.__FLAGS=" + jsonForScript(', '";window.__NAVGROUPS=" + jsonForScript(', '";window.__ME=" + jsonForScript('])
    assert.ok(srv.includes(site), "inline-script JSON site missing or not through jsonForScript: " + site);
  assert.ok(!/window\.__(AUTH|FLAGS|NAVGROUPS|ME)=" \+ JSON\.stringify\(/.test(srv) && !/window\.__AUTH=' \+ JSON\.stringify\(/.test(srv), "no JSON.stringify lands in an inline script");
});

test("security -20: HTTP Basic spends the same per-IP damper as /login, counted once per request, keyed on the LAST forwarded hop", async () => {
  const basic = (pw) => ({ authorization: "Basic " + Buffer.from("friend:" + pw).toString("base64") });
  const IP = "198.51.100.7";
  // Seven wrong pairs through the AI-cost path, which asks reqAuthed TWICE per request (its own
  // hook and the site gate) — a per-hook count would lock after four. A spoofed first XFF element
  // changes nothing: the key is the element the edge appended.
  for (let i = 0; i < 7; i++) {
    const r = await post("/api/ask", { q: "hi" }, null, Object.assign({ "x-forwarded-for": "10.0.0." + i + ", " + IP }, basic("nope-" + i)));
    assert.equal(r.statusCode, 401, "wrong pair #" + (i + 1) + ": " + r.body);
  }
  // The eighth wrong pair is a plain 401 — a locked address would already answer 429 — which is
  // what proves the seven above were counted once each, not once per hook. (A CORRECT pair here
  // would clear the counter, exactly as a successful /login does.)
  assert.equal((await get("/api/snapshot", null, Object.assign({ "x-forwarded-for": IP }, basic("nope-8")))).statusCode, 401, "the eighth wrong pair: not locked before it");
  const locked = await get("/api/snapshot", null, Object.assign({ "x-forwarded-for": IP }, basic("shared-door-pw")));
  assert.equal(locked.statusCode, 429, "eight wrong: the RIGHT password is refused from that address");
  assert.ok(Number(locked.headers["retry-after"]) >= 60, "with a Retry-After");
  assert.match(JSON.parse(locked.body).error, /too many attempts/);
  assert.equal(JSON.parse((await get("/api/health", null, Object.assign({ "x-forwarded-for": IP }, basic("shared-door-pw")))).body).loop, undefined, "locked: not even health's member view");
  const other = await get("/api/health", null, Object.assign({ "x-forwarded-for": "198.51.100.8" }, basic("shared-door-pw")));
  assert.ok(JSON.parse(other.body).loop, "another address is unaffected");
  assert.equal((await get("/api/snapshot", null, basic("shared-door-pw"))).statusCode, 401, "the socket address (no XFF) is a third key: 401 claim-account, not 429");
});

test("security -20: at most eight scrypt derivations are in flight; the rest answer 503 with Retry-After", async () => {
  const many = await Promise.all(Array.from({ length: 16 }, () => post("/login", { handle: "gus", password: "a-long-password-12" }, null, { "x-forwarded-for": "198.51.100.9" })));
  const codes = many.map((r) => r.statusCode);
  assert.ok(codes.filter((c) => c === 200).length >= 8, "the first eight are served: " + codes.join(","));
  assert.ok(codes.includes(503), "beyond the cap the caller is told to retry: " + codes.join(","));
  const busy = many.find((r) => r.statusCode === 503);
  assert.equal(busy.headers["retry-after"], "2");
  assert.match(JSON.parse(busy.body).error, /busy/);
  assert.equal((await post("/login", { handle: "gus", password: "a-long-password-12" })).statusCode, 200, "the gate releases: a later sign-in is served");
});

test("security -20: uid-less streams are capped per client IP; members are counted by uid", async () => {
  const http = require("http");
  await app.listen({ port: 0, host: "127.0.0.1" });
  const port = app.server.address().port;
  // Break-glass is the uid-less caller: authenticated by the admin lease, identified by nobody.
  const bg = jar(); bg.absorb(await post("/login", { password: "break-glass-pw-1" }));
  const gus = jar(); gus.absorb(await post("/login", { handle: "gus", password: "a-long-password-12" }));
  const open = (j, ip) => new Promise((resolve, reject) => {
    const req = http.get({ host: "127.0.0.1", port, path: "/api/events", headers: { cookie: j.header(), "x-forwarded-for": ip } }, (res) => {
      if (res.statusCode === 200) return resolve({ req, res, body: "" });
      let body = ""; res.on("data", (d) => { body += d; }); res.on("end", () => resolve({ req, res, body }));
    });
    req.on("error", reject);
  });
  const held = [];
  try {
    for (let i = 0; i < 4; i++) { const c = await open(bg, "198.51.100.20"); assert.equal(c.res.statusCode, 200, "stream #" + (i + 1)); held.push(c); }
    const fifth = await open(bg, "198.51.100.20");
    assert.equal(fifth.res.statusCode, 503); assert.deepEqual(JSON.parse(fifth.body), { error: "sse-per-ip-full" });
    const elsewhere = await open(bg, "198.51.100.21"); assert.equal(elsewhere.res.statusCode, 200, "another address has its own four"); held.push(elsewhere);
    const member = await open(gus, "198.51.100.20"); assert.equal(member.res.statusCode, 200, "a member from the crowded address is counted by uid, not IP"); held.push(member);
    held[0].req.destroy();
    await new Promise((r) => setTimeout(r, 150));   // the server learns of the close from the socket, one turn later
    const again = await open(bg, "198.51.100.20"); assert.equal(again.res.statusCode, 200, "a closed stream frees its slot"); held.push(again);
  } finally { for (const c of held) c.req.destroy(); await new Promise((r) => setTimeout(r, 150)); }
});

test("security -20: a 5xx never carries the driver's words; repeated query keys reach no bind; 4xx keep their shape", async () => {
  const gus = jar(); gus.absorb(await post("/login", { handle: "gus", password: "a-long-password-12" }));
  const boom = await get("/__test/throw", gus);
  assert.equal(boom.statusCode, 500);
  const b = JSON.parse(boom.body);
  assert.equal(b.error, "internal"); assert.match(b.id, /^[0-9a-f]{12}$/, "a log-correlation id, nothing else");
  assert.ok(!/SQLite|bound|Provided value/.test(boom.body), boom.body);
  assert.equal(boom.headers["cache-control"], "no-store");
  const dup = await get("/api/dm/calls?by=a&by=b&limit=5&limit=6", gus);
  assert.equal(dup.statusCode, 200, dup.body);
  assert.ok(!/SQLite|bound/.test(dup.body) && Array.isArray(JSON.parse(dup.body).calls), "an array never reaches a statement");
  assert.equal((await get("/api/dm/search?q=hi&q=there&thread=1&thread=2", gus)).statusCode, 200);
  assert.equal((await get("/api/access/dm/search?q=hi&q=there", gus)).statusCode, 200);
  const arr = await post("/api/dm", { thread: [999999, 1], body: "x", fileId: ["a"], replyTo: [1] }, gus);
  assert.equal(arr.statusCode, 400, "coerced to the first value, then refused by the domain rule — never a 500: " + arr.body);
  assert.match(JSON.parse(arr.body).error, /no such conversation/);
  // 4xx errors keep Fastify's own shape: the client reads these messages.
  const badJson = await app.inject({ method: "POST", url: "/login", headers: JSONH, payload: "{not json" });
  assert.equal(badJson.statusCode, 400); assert.ok(JSON.parse(badJson.body).message, badJson.body);
  assert.equal((await post("/api/notes", { coin: "xyz:AAPL", body: "x".repeat(20000) }, gus)).statusCode, 413);
});

test("security -20: /api/health is three views — open, member, operator", async () => {
  const anon = JSON.parse((await get("/api/health")).body);
  assert.deepEqual(Object.keys(anon).sort(), ["ok", "stale", "ts", "version"]);
  const cara = jar(); cara.absorb(await post("/login", { handle: "cara", password: "yet-another-long-pw" }));
  const member = JSON.parse((await get("/api/health", cara)).body);
  assert.ok(member.ok && member.version && member.loop && "lastPollAgoMs" in member && "stale" in member, "the base fields");
  for (const k of ["volume", "csp", "backup", "rate", "derivs", "spines", "ws", "hourly", "funding", "ledger"])
    assert.equal(member[k], undefined, "a member never sees " + k);
  assert.ok("lastPoll" in member && "failing" in member && "ticks" in member && "earnings" in member && "news" in member, "the freshness tray's inputs");
  assert.deepEqual(Object.keys(member.ai).sort(), ["askDayLeft", "askPerDay", "dayLeft", "enabled", "perDay"], "the ask-budget chip's inputs, no provider or model name");
  assert.deepEqual(Object.keys(member.earnings).sort(), ["asOf", "error"]);
  assert.deepEqual(Object.keys(member.news).sort(), ["error", "fetchedAt", "filings"]);
  const gus = jar(); gus.absorb(await post("/login", { handle: "gus", password: "a-long-password-12" }));
  const op = JSON.parse((await get("/api/health", gus)).body);
  assert.ok(op.volume && op.volume.dataDir && op.csp && "provider" in op.ai && "backup" in op && "rate" in op, "the operator gets the deployment");
});

// build 2026.09.24-101: the anonymous health view (Railway's healthcheck) is answered before
// poller.stats() is built; a signed-in caller still gets the full member/operator views.
test("perf -101: anonymous /api/health never builds poller.stats(); members and operators still do", async () => {
  const { _poller } = require("../server.js");
  const p = _poller(), orig = p.stats;
  let calls = 0;
  p.stats = (...a) => { calls++; return orig.apply(p, a); };
  try {
    const anon = JSON.parse((await get("/api/health")).body);
    assert.deepEqual(Object.keys(anon).sort(), ["ok", "stale", "ts", "version"], "same anonymous shape as before");
    assert.equal(anon.ok, true); assert.equal(typeof anon.stale, "boolean");
    assert.equal(calls, 0, "the healthcheck costs no stats() walk");
    const cara = jar(); cara.absorb(await post("/login", { handle: "cara", password: "yet-another-long-pw" }));
    const member = JSON.parse((await get("/api/health", cara)).body);
    assert.equal(calls, 1, "a member's view is built from the full stats");
    assert.ok(member.loop && "failing" in member && member.volume === undefined, "the member view is unchanged");
    const gus = jar(); gus.absorb(await post("/login", { handle: "gus", password: "a-long-password-12" }));
    const op = JSON.parse((await get("/api/health", gus)).body);
    assert.equal(calls, 2);
    assert.ok(op.volume && op.csp && "backup" in op, "the operator view is unchanged");
  } finally { p.stats = orig; }
});

// build 2026.09.24-101: /api/analytics rides the shared serialize + gzip memo.
test("perf -101: /api/analytics serves through sendCachedBody — scoped ETag, 304, memoized serialize", async () => {
  const gus = jar(); gus.absorb(await post("/login", { handle: "gus", password: "a-long-password-12" }));
  const a = await get("/api/analytics?u=stocks", gus);
  assert.equal(a.statusCode, 200);
  const tag = a.headers.etag;
  assert.match(tag, /^W\/"stocks-/, "scope-prefixed validator kept");
  assert.equal(a.headers["cache-control"], "no-cache");
  assert.ok(JSON.parse(a.body), "a JSON body");
  const b = await get("/api/analytics?u=stocks", gus, { "if-none-match": tag });
  assert.equal(b.statusCode, 304);
  const srv = fs.readFileSync(path.join(__dirname, "..", "server.js"), "utf8");
  const route = srv.slice(srv.indexOf('fastify.get("/api/analytics"'), srv.indexOf('fastify.get("/api/funding"'));
  assert.ok(route.includes("return sendCachedBody(req, reply, body, tag);") && !route.includes("JSON.stringify(body)"), "no per-request stringify");
});

// build 2026.09.24-101: SSE writes respect backpressure.
test("perf -101: an SSE client past the buffer cap is dropped; destroyed sockets are detached, never written", () => {
  const { _sseWriteTo, SSE_MAX_BUFFERED } = require("../server.js");
  assert.equal(SSE_MAX_BUFFERED, 64 * 1024);
  const mk = (over) => Object.assign({ destroyed: false, writableEnded: false, writableLength: 0, wrote: [], killed: false,
    write(f) { this.wrote.push(f); return true; }, destroy() { this.killed = true; this.destroyed = true; } }, over || {});
  const detached = [];
  const detach = (e) => detached.push(e);
  const ok = { res: mk() };
  assert.equal(_sseWriteTo(ok, "data: 1\n\n", detach), true);
  assert.deepEqual(ok.res.wrote, ["data: 1\n\n"]); assert.equal(detached.length, 0);
  const at = { res: mk({ writableLength: SSE_MAX_BUFFERED }) };
  assert.equal(_sseWriteTo(at, "x", detach), true, "exactly at the cap still writes");
  const slow = { res: mk({ writableLength: SSE_MAX_BUFFERED + 1 }) };
  assert.equal(_sseWriteTo(slow, "x", detach), false);
  assert.ok(slow.res.killed && slow.res.wrote.length === 0 && detached.includes(slow), "a stalled reader is detached and destroyed, nothing more buffered");
  const dead = { res: mk({ destroyed: true }) };
  assert.equal(_sseWriteTo(dead, "x", detach), false);
  assert.ok(dead.res.wrote.length === 0 && detached.includes(dead), "a destroyed socket is detached, not written");
  const ended = { res: mk({ writableEnded: true }) };
  assert.equal(_sseWriteTo(ended, "x", detach), false);
  assert.ok(ended.res.wrote.length === 0 && detached.includes(ended));
  const throws = { res: mk({ write() { throw new Error("EPIPE"); } }) };
  assert.equal(_sseWriteTo(throws, "x", detach), false, "a throwing write is contained");
  const srv = fs.readFileSync(path.join(__dirname, "..", "server.js"), "utf8");
  assert.ok(srv.includes("const sseWrite = (entry, frame) => sseWriteTo(entry, frame, sseDetach);"), "every fan-out goes through the guarded writer");
});

test("security -20: the reset step-2 cookie is signed — a hand-set handle spends nobody's guesses", async () => {
  const { DatabaseSync } = require("node:sqlite");
  const gus = jar(); gus.absorb(await post("/login", { handle: "gus", password: "a-long-password-12" }));
  const caraUid = JSON.parse((await get("/api/access", gus)).body).members.find((m) => m.handle === "cara").uid;
  const tries = () => { const db = new DatabaseSync(require("path").join(DATA, "accounts.db"), { readOnly: true });
    try { const r = db.prepare("SELECT tries FROM otp WHERE uid = ?").get(caraUid); return r ? r.tries : null; } finally { db.close(); } };
  const j = jar();
  const ask = j.absorb(await post("/reset", { handle: "cara" }, null, { "x-forwarded-for": "198.51.100.30" }));
  assert.equal(ask.statusCode, 200);
  assert.equal(tries(), 0, "a code was issued for cara");
  const tok = j.get("xyzotp");
  assert.ok(tok && tok.split(".").length >= 3 && !/^cara$/.test(tok), "the cookie is handle.expiry.mac, not the raw handle");
  // Forged: the raw handle, as the old cookie was. Refused before any account is consulted.
  const forged = await post("/reset/code", { code: "000000", password: "brand-new-password-1" }, null, { cookie: "xyzotp=cara", "x-forwarded-for": "198.51.100.31" });
  assert.equal(forged.statusCode, 400); assert.match(JSON.parse(forged.body).error, /start again/);
  assert.equal(tries(), 0, "cara's attempts are untouched");
  // Tampered: a real cookie with the handle swapped, or the mac damaged, or a mac of the wrong length.
  const parts = tok.split(".");
  for (const bad of ["gus." + parts.slice(1).join("."), parts.slice(0, -1).join(".") + "." + parts[parts.length - 1].replace(/./g, "A"), encodeURIComponent("cara") + "." + (Date.now() + 9e5) + ".AAAA"])
    assert.equal((await post("/reset/code", { code: "000000", password: "brand-new-password-1" }, null, { cookie: "xyzotp=" + bad })).statusCode, 400);
  assert.equal(tries(), 0);
  assert.equal((await get("/reset/code", null, { cookie: "xyzotp=cara" })).statusCode, 302, "the page bounces a forged cookie back to /reset");
  assert.equal((await get("/reset/code", j)).statusCode, 200, "and renders for the real one");
  // The legitimate cookie still verifies, and a wrong code through it still counts.
  const wrong = await post("/reset/code", { code: "000000", password: "brand-new-password-1" }, j, { "x-forwarded-for": "198.51.100.32" });
  assert.equal(wrong.statusCode, 400); assert.match(JSON.parse(wrong.body).error, /wrong or has expired/);
  assert.equal(tries(), 1, "the real flow spends a try");
});

test("security -20: cross-site writes are refused at the door; /logout answers POST and same-origin GET only", async () => {
  const gus = jar(); gus.absorb(await post("/login", { handle: "gus", password: "a-long-password-12" }));
  const xs = await post("/api/prefs", { key: "watch", value: ["xyz:NVDA"], ts: 9000 }, gus, { "sec-fetch-site": "cross-site" });
  assert.equal(xs.statusCode, 403); assert.deepEqual(JSON.parse(xs.body), { error: "cross-site request refused" });
  assert.equal((await post("/api/prefs", { key: "watch", value: ["xyz:NVDA"], ts: 9000 }, gus, { "sec-fetch-site": "same-origin" })).statusCode, 200);
  assert.equal((await post("/api/prefs", { key: "watch", value: ["xyz:NVDA"], ts: 9001 }, gus)).statusCode, 200, "no header (scripts, old browsers): the cookie rule decides");
  assert.equal((await get("/api/prefs", gus, { "sec-fetch-site": "cross-site" })).statusCode, 200, "reads are untouched");
  // GET /logout from another site: refused, and no cookie is dropped.
  const x = await get("/logout", gus, { "sec-fetch-site": "cross-site" });
  assert.equal(x.statusCode, 403); assert.equal(x.headers["set-cookie"], undefined);
  assert.equal((await get("/logout", gus, { "sec-fetch-site": "same-site" })).statusCode, 403, "a sibling site is not this origin");
  assert.equal((await get("/api/access", gus)).statusCode, 200, "still signed in");
  // The nav button's navigation (same-origin), a typed URL (none), and a POST all sign out.
  for (const [method, headers] of [["GET", { "sec-fetch-site": "same-origin" }], ["GET", { "sec-fetch-site": "none" }], ["GET", {}], ["POST", { "sec-fetch-site": "same-origin" }], ["POST", {}]]) {
    const j = jar(); j.absorb(await post("/login", { handle: "gus", password: "a-long-password-12" }));
    const out = j.absorb(await app.inject({ method, url: "/logout", headers: Object.assign({ cookie: j.header() }, headers) }));
    assert.equal(out.statusCode, 303, method + " " + JSON.stringify(headers));
    assert.equal(out.headers.location, "/");
    assert.equal(j.get("xyzsess"), null, "session dropped"); assert.equal(j.get("xyzadm"), null, "lease dropped");
  }
  assert.equal((await app.inject({ method: "POST", url: "/logout", headers: { cookie: gus.header(), "sec-fetch-site": "cross-site" } })).statusCode, 403, "a cross-site POST is stopped by the gate");
});

test("docs: the manual is gated, nonce-stamped, build-stamped and audience-specific; the reference pages serve", async () => {
  // Signed out: the login page, exactly like the shell — a manual for a private terminal is not public.
  const out = await get("/docs");
  assert.equal(out.statusCode, 401);
  assert.match(out.headers["content-type"], /text\/html/);
  assert.match(out.body, /authInit/);

  // gus is account #1 (the operator); a fresh member is invited through the real door so the
  // member-side assertions never depend on what an earlier test did to bob.
  const adm = jar(); adm.absorb(await post("/login", { handle: "gus", password: "a-long-password-12" }));
  const mint = JSON.parse((await post("/api/access", { op: "mint", days: 1 }, adm)).body);
  const gus = jar(); gus.absorb(await get("/join/" + (mint.code || (mint.invite && mint.invite.code)), gus));
  assert.equal(gus.absorb(await post("/join", { handle: "docreader", password: "reads-the-manual-12" }, gus)).statusCode, 200);
  assert.equal((await get("/api/access", gus)).statusCode, 403, "the reader is a member, not an operator");
  for (const [j, admin] of [[gus, false], [adm, true]]) {
    for (const url of ["/docs", "/docs.html"]) {
      const r = await get(url, j);
      assert.equal(r.statusCode, 200, url);
      assert.match(r.headers["content-type"], /text\/html/);
      assert.equal(r.headers["cache-control"], "no-store", "audience-specific body, never cached");
      // Every inline script carries the response's nonce; the slot never survives.
      const csp = r.headers["content-security-policy-report-only"];
      const nonce = (csp.match(/'nonce-([^']+)'/) || [])[1];
      assert.ok(nonce, "the policy names a nonce");
      assert.ok(!r.body.includes("{{csp-nonce}}"));
      const inline = [...r.body.matchAll(/<script(?![^>]*\bsrc=)([^>]*)>/g)].map((m) => m[1]);
      assert.ok(inline.length >= 2, "the flag slot and the page script are both inline");
      for (const attrs of inline) assert.match(attrs, new RegExp('nonce="' + nonce.replace(/[+/=]/g, "\\$&") + '"'));
      // Build-stamped, and the audience boot is injected exactly as the shell injects it.
      assert.ok(!r.body.includes("{{build}}"), "the build slot is filled");
      assert.ok(r.body.includes('id="build">2026.'), "the page shows the server build");
      assert.ok(!r.body.includes("window.__FLAGS=null;window.__ADMIN=false;"), "the static placeholder never reaches a browser");
      assert.ok(r.body.includes("window.__ADMIN=" + (admin ? "true" : "false") + ";"), "admin flag matches the caller");
      const flags = JSON.parse((r.body.match(/window\.__FLAGS=(\{.*?\});window\.__ADMIN/) || [])[1]);
      assert.equal(flags.markets, true);
      assert.equal(flags.admin, admin, "the admin tab's section is hidden from members by the injected set");
      // The static fallback must not be what answered: the explicit route owns /docs.html too.
      assert.ok(r.body.includes("<main class=\"doc\""));
    }
  }
  // The reference pages under docs/ serve nonce-stamped through the same gate; unknown names 404 and list what exists.
  for (const page of ["explainer", "howto", "signals", "features", "map", "mechanics"]) {
    const r = await get("/docs/ref/" + page, gus);
    assert.equal(r.statusCode, 200, page);
    assert.match(r.headers["content-type"], /text\/html/);
    assert.ok(!r.body.includes("{{csp-nonce}}"));
    const nonce = (r.headers["content-security-policy-report-only"].match(/'nonce-([^']+)'/) || [])[1];
    for (const attrs of [...r.body.matchAll(/<script(?![^>]*\bsrc=)([^>]*)>/g)].map((m) => m[1]))
      assert.match(attrs, new RegExp('nonce="' + nonce.replace(/[+/=]/g, "\\$&") + '"'), page + ": inline script stamped");
  }
  assert.equal((await get("/docs/ref/signals")).statusCode, 401, "reference pages sit behind the site gate too");
  // The guide screenshots: served from docs/img behind the same gate, strict names, 404 for anything else.
  const firstImg = fs.readdirSync(path.join(__dirname, "..", "docs", "img")).find((f) => /\.jpg$/.test(f));
  assert.ok(firstImg, "the guides ship at least one screenshot");
  const img = await get("/docs/ref/img/" + firstImg, gus);
  assert.equal(img.statusCode, 200);
  assert.equal(img.headers["content-type"], "image/jpeg");
  assert.equal(img.headers["cache-control"], "no-cache");
  assert.equal((await get("/docs/ref/img/" + firstImg)).statusCode, 401, "screenshots sit behind the gate too");
  assert.equal((await get("/docs/ref/img/nope.jpg", gus)).statusCode, 404);
  assert.equal((await get("/docs/ref/img/..%2Fxyz-monitor-explainer.html", gus)).statusCode, 404, "no path characters pass the name pattern");
  assert.equal((await get("/docs/ref/img/shots.json", gus)).statusCode, 404, "only image types are served");
  const nope = await get("/docs/ref/nope", gus);
  assert.equal(nope.statusCode, 404);
  assert.deepEqual(JSON.parse(nope.body).pages.sort(), ["explainer", "features", "howto", "map", "mechanics", "signals"]);
});

// ===== build 2026.09.21-83: Telegram sync verb and /alert over the wire =========================
test("dm: the sync box needs a phone, /alert binds a rule to the conversation it was typed in, and the rules list names it", async () => {
  const gus = jar(); gus.absorb(await post("/login", { handle: "gus", password: "a-long-password-12" }));
  const cara = jar(); cara.absorb(await post("/login", { handle: "cara", password: "yet-another-long-pw" }));
  const members = JSON.parse((await get("/api/access", gus)).body).members;
  const gusUid = members.find((m) => m.handle === "gus").uid;
  const T = JSON.parse((await post("/api/dm", { to: gusUid, body: "sync test" }, cara)).body).thread;
  assert.ok(T > 0);
  // No TG_BOT_TOKEN in this suite, so nobody has a linked chat: on is refused with the reason,
  // off is always allowed, and the flag never lands.
  const on = await post("/api/dm", { thread: T, tgSync: true }, cara);
  assert.equal(on.statusCode, 400); assert.match(JSON.parse(on.body).error, /link a Telegram/);
  const off = JSON.parse((await post("/api/dm", { thread: T, tgSync: false }, cara)).body);
  assert.ok(off.ok && off.tgSync === false, JSON.stringify(off));
  assert.equal(JSON.parse((await get("/api/dm", cara)).body).threads.find((t) => t.id === T).tgSync, false);
  // /alert: help and list are private answers; a definition posts into the thread and is bound to it.
  const help = JSON.parse((await post("/api/dm", { thread: T, alert: "help" }, cara)).body);
  assert.ok(help.ok && help.private && /\/alert list/.test(help.text) && !help.message);
  const list0 = JSON.parse((await post("/api/dm", { thread: T, alert: "list" }, cara)).body);
  assert.ok(list0.ok && /No alerts yet/.test(list0.text));
  const noMkt = await post("/api/dm", { thread: T, alert: "NVDA > 200" }, cara);
  assert.equal(noMkt.statusCode, 400); assert.match(JSON.parse(noMkt.body).error, /no market called NVDA/);
  const bad = await post("/api/dm", { thread: T, alert: "NVDA > abc" }, cara);
  assert.equal(bad.statusCode, 400); assert.match(JSON.parse(bad.body).error, /not a number/);
  const set = JSON.parse((await post("/api/dm", { thread: T, alert: "any rvol > 3 unusual tape" }, cara)).body);
  assert.ok(set.ok && set.rule && set.rule.thread === T, JSON.stringify(set));
  assert.equal(set.thread, T);
  assert.equal(set.message.cmd, "alert any rvol > 3 unusual tape", "the definition posts as a command result under the author");
  assert.match(set.message.body, /alert #\d+ · any market · relative volume above 3 — unusual tape → fires here/);
  const notIn = await post("/api/dm", { thread: T + 1000, alert: "any rvol > 3" }, cara);
  assert.equal(notIn.statusCode, 400);
  // The rules list, for its author, names the conversation; the operator sees the rule without a name they cannot resolve.
  const mine = JSON.parse((await get("/api/alerts/rules", cara)).body);
  const rl = mine.rules.find((r) => r.id === set.rule.id);
  assert.ok(rl && rl.thread === T && rl.threadName === "gus", JSON.stringify(rl));
  const list1 = JSON.parse((await post("/api/dm", { thread: T, alert: "list" }, cara)).body);
  assert.match(list1.text, new RegExp("#" + set.rule.id + " · any market · relative volume above 3 — unusual tape → here"));
  // Someone else cannot remove it; the author can, and the room is told.
  const theirs = await post("/api/dm", { thread: T, alert: "off " + set.rule.id }, gus);
  assert.equal(theirs.statusCode, 400); assert.match(JSON.parse(theirs.body).error, /isn.t yours/);
  const gone = JSON.parse((await post("/api/dm", { thread: T, alert: "off " + set.rule.id }, cara)).body);
  assert.ok(gone.ok && gone.message && gone.message.cmd === "alert off " + set.rule.id, JSON.stringify(gone));
  assert.ok(!JSON.parse((await get("/api/alerts/rules", cara)).body).rules.some((r) => r.id === set.rule.id));
  // The verbs reach a signed-in member only.
  assert.equal((await post("/api/dm", { thread: T, alert: "list" })).statusCode, 401);
  // The panel route cannot bind a rule to a conversation the caller is not in.
  const foreign = await post("/api/alerts/rules", { metric: "px", op: ">", value: 1, thread: T + 1000 }, cara);
  assert.equal(foreign.statusCode, 400);
  const own = JSON.parse((await post("/api/alerts/rules", { metric: "px", op: ">", value: 1, thread: T }, cara)).body);
  assert.ok(own.ok && own.rule.thread === T);
  assert.ok(JSON.parse((await post("/api/alerts/rules", { del: own.rule.id }, cara)).body).ok);
  // Source pins for the wire: what the phone gets back from /alert is escaped for parse_mode HTML
  // (the help text carries literal <ticker> placeholders), fires batch per author, and a member
  // with any chat in quiet hours holds as a whole.
  const srv = fs.readFileSync(path.join(__dirname, "..", "server.js"), "utf8");
  assert.ok(/return a\.ok \? \{ ok: true, text: tgEsc\(a\.text\) \} : \{ ok: false, error: tgEsc\(a\.error\) \};/.test(srv), "/alert replies are escaped at the wire");
  assert.ok(/const key = rule\.thread \+ "\|" \+ \(rule\.owner \|\| ""\);/.test(srv), "fire batches are per author per conversation");
  assert.ok(/if \(!targets\.length \|\| targets\.some\(\(c\) => poller\.pushQuietNow && poller\.pushQuietNow\(c\)\)\) continue;/.test(srv), "quiet hours hold the whole member");
  assert.ok(/poller\.setRuleThread\(id, 0\)/.test(srv), "an author who left the room gets the rule unbound, not dropped");
});

// ===== build 2026.09.21-84: share to chat over the wire =========================================
test("dm: a card posts with a server-rendered body, an optional note behind it, and a stamp only on request", async () => {
  const gus = jar(); gus.absorb(await post("/login", { handle: "gus", password: "a-long-password-12" }));
  const cara = jar(); cara.absorb(await post("/login", { handle: "cara", password: "yet-another-long-pw" }));
  const members = JSON.parse((await get("/api/access", gus)).body).members;
  const gusUid = members.find((m) => m.handle === "gus").uid;
  const card = { kind: "row", scope: "stocks", tf: "1d", cols: [{ k: "px", l: "Price" }, { k: "d1", l: "24h" }],
    rows: [{ coin: "xyz:NVDA", t: "NVDA", px: 176.4, c: [{ s: "176.40", c: "" }, { s: "+1.2%", c: "pos" }] }], at: 1790000000000 };
  // To a person: opens (or reuses) the pair thread, exactly as a plain send does.
  const r1 = JSON.parse((await post("/api/dm", { to: gusUid, card, body: "look at this $NVDA", call: true }, cara)).body);
  assert.ok(r1.ok, JSON.stringify(r1));
  assert.equal(r1.message.card.kind, "row"); assert.equal(r1.message.card.rows[0].c[1].s, "+1.2%");
  assert.ok(r1.message.body.startsWith("\u2934 NVDA \u00b7 row \u00b7 captured 2026-09-21 14:13Z \u00b7 stocks \u00b7 1d\nPrice  176.40"), r1.message.body);
  assert.equal(r1.message.ref, null, "no market called NVDA in this suite, so the stamp is honestly absent even when asked for");
  assert.ok(r1.note && r1.note.body === "look at this $NVDA" && r1.note.thread === r1.thread, "the note follows as an ordinary message");
  // Into a thread, no note: no second message.
  const r2 = JSON.parse((await post("/api/dm", { thread: r1.thread, card }, cara)).body);
  assert.ok(r2.ok && r2.note === undefined, JSON.stringify(r2));
  const hist = JSON.parse((await get("/api/dm/" + r1.thread, cara)).body).messages;
  assert.equal(hist.filter((m) => m.card).length, 2); assert.equal(hist.filter((m) => m.body === "look at this $NVDA").length, 1);
  // A bad card is refused with the reason; a card cannot be edited; a thread you are not in is refused.
  const bad = await post("/api/dm", { thread: r1.thread, card: { kind: "row", cols: [], rows: [] } }, cara);
  assert.equal(bad.statusCode, 400); assert.match(JSON.parse(bad.body).error, /no-columns/);
  const ed = await post("/api/dm", { id: r2.message.id, body: "rewritten" }, cara);
  assert.equal(ed.statusCode, 400); assert.match(JSON.parse(ed.body).error, /can't be edited/);
  assert.equal((await post("/api/dm", { thread: r1.thread + 1000, card }, cara)).statusCode, 400);
  // The client bundle carries the module and the table wiring.
  const nav = fs.readFileSync(path.join(__dirname, "..", "public", "js", "nav.js"), "utf8");
  assert.ok(/shareSetSource\(\(\)=>\(\{rows:sortedRows\(\),cols:visibleCols\(\)\}\)\);/.test(nav) && /shareWireTable\(el\('body'\), visibleCols\);/.test(nav), "the screener hands its rows and columns to the share module");
  const msgs = fs.readFileSync(path.join(__dirname, "..", "public", "js", "messages.js"), "utf8");
  assert.ok(/: m\.card\s*\? cardHtml\(m\.card,m\)/.test(msgs) && /if\(\/\^share\\b\/i\.test\(line\)\)/.test(msgs), "cards render through the share module and /share is a composer verb");
  const srv = fs.readFileSync(path.join(__dirname, "..", "server.js"), "utf8");
  assert.ok(/CLIENT_MODULES = \(\(\) => \{ try \{ return fs\.readdirSync/.test(srv), "modules are discovered from the directory, so share.js ships precompressed and stamped");
});

// ===== build 2026.09.24-98: share to chat everywhere — panels, charts, live screens over the wire ====
test("dm: a panel posts as a card, a chart only as the caption of its own uploaded picture, a live screen keeps its query", async () => {
  const gus = jar(); gus.absorb(await post("/login", { handle: "gus", password: "a-long-password-12" }));
  const cara = jar(); cara.absorb(await post("/login", { handle: "cara", password: "yet-another-long-pw" }));
  const members = JSON.parse((await get("/api/access", gus)).body).members;
  const gusUid = members.find((m) => m.handle === "gus").uid;
  // A drawer section: label/value lines and a spark, the body rendered by the server.
  const panel = { kind: "panel", view: "drawer", title: "Funding APR · last 7d", coin: "xyz:NVDA", t: "NVDA", px: 176.4, cols: [{ k: "v", l: "value" }],
    rows: [{ t: "from", c: [{ s: "4.10", c: "" }] }, { t: "to", c: [{ s: "11.30", c: "" }] }], spark: { v: [4.1, 6, -1, 11.3], l: "Funding APR", z: true }, at: 1790000000000 };
  const p1 = JSON.parse((await post("/api/dm", { to: gusUid, card: panel }, cara)).body);
  assert.ok(p1.ok, JSON.stringify(p1));
  assert.equal(p1.message.card.kind, "panel"); assert.equal(p1.message.card.title, "Funding APR · last 7d");
  assert.deepEqual(p1.message.card.spark.v, [4.1, 6, -1, 11.3]);
  assert.ok(p1.message.body.startsWith("⤴ NVDA · Funding APR · last 7d · captured "), p1.message.body);
  assert.ok(/\nfrom  4\.10\nto    11\.30\n/.test(p1.message.body), "label/value lines, padded: " + p1.message.body);
  // A chart without its picture is refused; an upload into the thread, then the caption naming it, posts.
  const chart = { kind: "chart", view: "charts", title: "4H candles · 90 bars", coin: "xyz:NVDA", t: "NVDA", tf: "4H", cols: [{ k: "v", l: "value" }],
    rows: [{ t: "last", c: [{ s: "176.40", c: "" }] }], at: 1790000000000 };
  const noPic = await post("/api/dm", { thread: p1.thread, card: chart }, cara);
  assert.equal(noPic.statusCode, 400); assert.match(JSON.parse(noPic.body).error, /no-image/);
  const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4E, 0x47, 13, 10, 26, 10]), Buffer.alloc(32)]);
  const up = JSON.parse((await post("/api/dm/upload", { thread: p1.thread, name: "chart-NVDA-4H.png", data: png.toString("base64") }, cara)).body);
  assert.ok(up.ok, JSON.stringify(up));
  const c1 = JSON.parse((await post("/api/dm", { thread: p1.thread, card: chart, fileId: up.file.id }, cara)).body);
  assert.ok(c1.ok, JSON.stringify(c1));
  assert.equal(c1.message.card.kind, "chart"); assert.ok(c1.message.file && c1.message.file.inline, "the picture rides the card's message, inline");
  assert.ok(c1.message.body.includes("(the chart is attached as a picture)"));
  // Somebody else's upload cannot be captioned; a panel never carries a file even when one is named.
  const up2 = JSON.parse((await post("/api/dm/upload", { thread: p1.thread, name: "g.png", data: png.toString("base64") }, gus)).body);
  assert.equal((await post("/api/dm", { thread: p1.thread, card: chart, fileId: up2.file.id }, cara)).statusCode, 400, "the attachment is not yours");
  const p2 = JSON.parse((await post("/api/dm", { thread: p1.thread, card: panel, fileId: up2.file.id }, gus)).body);
  assert.ok(p2.ok && !p2.message.file, "a panel ignores a fileId");
  // A live screen keeps its query as data; the text body says it is live.
  const screen = { kind: "screen", cols: [{ k: "d1", l: "24h" }], rows: [{ coin: "xyz:NVDA", t: "NVDA", c: [{ s: "+1.2%", c: "pos" }] }],
    q: { f: "NV", vmin: 1e6, sk: "d1", sd: "desc", sc: "stocks", grp: ["xyz:NVDA"] }, live: true, at: 1790000000000 };
  const s1 = JSON.parse((await post("/api/dm", { thread: p1.thread, card: screen }, cara)).body);
  assert.ok(s1.ok, JSON.stringify(s1));
  assert.equal(s1.message.card.live, true); assert.equal(s1.message.card.q.f, "NV"); assert.equal(s1.message.card.q.vmin, 1e6);
  assert.ok(s1.message.body.split("\n")[0].includes("· live") && /live: re-runs these filters/.test(s1.message.body), s1.message.body);
});

// ===== build 2026.09.22-88: closing and extending a call over the wire =========================
test("dm: close and extend are the author's verbs on an open call; a stamp needs a live mark to close", async () => {
  const gus = jar(); gus.absorb(await post("/login", { handle: "gus", password: "a-long-password-12" }));
  const cara = jar(); cara.absorb(await post("/login", { handle: "cara", password: "yet-another-long-pw" }));
  const members = JSON.parse((await get("/api/access", gus)).body).members;
  const gusUid = members.find((m) => m.handle === "gus").uid;
  // No markets in this suite, so $NVDA never stamps: the verbs refuse a message that carries no call.
  const plain = JSON.parse((await post("/api/dm", { to: gusUid, body: "long $NVDA 30d" }, cara)).body);
  assert.ok(plain.ok && plain.message.ref === null && plain.message.call === null);
  const noCall = await post("/api/dm", { callClose: plain.message.id }, cara);
  assert.equal(noCall.statusCode, 400); assert.match(JSON.parse(noCall.body).error, /carries no call/);
  const noCall2 = await post("/api/dm", { callExtend: plain.message.id, days: 14 }, cara);
  assert.equal(noCall2.statusCode, 400);
  const theirs = await post("/api/dm", { callClose: plain.message.id }, gus);
  assert.equal(theirs.statusCode, 400); assert.match(JSON.parse(theirs.body).error, /isn.t your call/);
  assert.equal((await post("/api/dm", { callClose: plain.message.id })).statusCode, 401);
  // The calls board reports the lifecycle fields and the default horizon.
  const board = JSON.parse((await get("/api/dm/calls", cara)).body);
  assert.equal(board.defaultHorizonD, 7);
  const srv = fs.readFileSync(path.join(__dirname, "..", "server.js"), "utf8");
  assert.ok(/ACCOUNTS\.calls\(uid, \{ limit: 100, windowMs: 30 \* 86400e3 \}\)/.test(srv), "the digest's record is the last 30 days of closed calls");
  assert.ok(/r = ACCOUNTS\.callClose\(me\.uid, b\.callClose\); if \(r\.ok\) dmPoke\(r\.thread, \{ refresh: Number\(r\.thread\) \}\);/.test(srv), "a close tells the room to re-pull the row");
});

// ===== build 2026.09.22-89: the composer's backup reader over the wire ===========================
test("dm: /api/dm/call-read is gated like an ask from a chat, needs a real market, and a send carries an applied reading", async () => {
  const gus = jar(); gus.absorb(await post("/login", { handle: "gus", password: "a-long-password-12" }));
  const cara = jar(); cara.absorb(await post("/login", { handle: "cara", password: "yet-another-long-pw" }));
  // dm.ask is admin-only by default: a member is refused before anything is spent.
  const member = await post("/api/dm/call-read", { text: "$NVDA looks heavy", sym: "NVDA" }, cara);
  assert.equal(member.statusCode, 403); const mb = JSON.parse(member.body);
  assert.ok(mb.error === "feature-gated" && /^(ai|dm)\.ask$/.test(mb.feature), "refused by whichever ask switch is closed first: " + member.body);
  // The operator passes the gate; with no market on this board the symbol is refused honestly.
  const noMkt = await post("/api/dm/call-read", { text: "$NVDA looks heavy", sym: "NVDA" }, gus);
  assert.equal(noMkt.statusCode, 400); assert.match(JSON.parse(noMkt.body).error, /no market called NVDA/);
  assert.equal((await post("/api/dm/call-read", { text: "x", sym: "NVDA" })).statusCode, 401);
  // A send with an applied reading is accepted; with no market it stamps nothing, so the reading has nothing to bind to.
  const members = JSON.parse((await get("/api/access", gus)).body).members;
  const gusUid = members.find((m) => m.handle === "gus").uid;
  const sent = JSON.parse((await post("/api/dm", { to: gusUid, body: "$NVDA looks heavy into the print", call: { side: "short", days: 14 } }, cara)).body);
  assert.ok(sent.ok && sent.message.ref === null && sent.message.call === null);
  const srv = fs.readFileSync(path.join(__dirname, "..", "server.js"), "utf8");
  assert.ok(/callSide: co && \(co\.side === "long" \|\| co\.side === "short"\) \? co\.side : null, callDays: co && co\.days != null \? \+co\.days : null/.test(srv), "the override is passed through, bounded in accounts.js");
  const app = fs.readFileSync(path.join(__dirname, "..", "public", "js", "messages.js"), "utf8");
  assert.ok(/const ov=\(!dmState\.editing&&dmState\.callOverride&&dmState\.callOverride\.text===ta\.value\.trim\(\)\)/.test(app), "the client sends an override only for the exact (trimmed) text it was applied to");
  assert.ok(/id="dm-callask"/.test(app) && /id="dm-callapply"/.test(app) && /vague&&dmAskAllowed\(\)/.test(app), "the ask is offered only when the words decided nothing, and only where dm.ask allows");
  assert.ok(/const vague=!ov&&!tgOk&&!read\.sideWord&&words>=4;/.test(app), "vague means no direction word (and no target, build 2026.09.24-95)");
  assert.ok(/dmState\.callOverride\.text===ta\.value\.trim\(\)/.test(app), "the override is keyed on the trimmed text on both sides");
  // ai.ask off is the operator's model-spend switch: the reader honours it before dm.ask.
  assert.equal(JSON.parse((await post("/api/features", { key: "ai.ask", state: "off" }, gus)).body).ok, true);
  const killed = await post("/api/dm/call-read", { text: "$NVDA looks heavy", sym: "NVDA" }, gus);
  assert.equal(killed.statusCode, 403); assert.equal(JSON.parse(killed.body).feature, "ai.ask");
  assert.equal(JSON.parse((await post("/api/features", { key: "ai.ask", state: "public" }, gus)).body).ok, true);
});


// ===== build 2026.09.23-94: moderation over the wire ===============================================
test("dm -94: the operator edits and deletes a member's message and strikes a call; a member is refused on every one", async () => {
  const gus = jar(); gus.absorb(await post("/login", { handle: "gus", password: "a-long-password-12" }));
  const cara = jar(); cara.absorb(await post("/login", { handle: "cara", password: "yet-another-long-pw" }));
  const members = JSON.parse((await get("/api/access", gus)).body).members;
  const gusUid = members.find((m) => m.handle === "gus").uid;
  const mine = JSON.parse((await post("/api/dm", { to: gusUid, body: "cara's words" }, cara)).body);
  assert.ok(mine.ok, JSON.stringify(mine));
  const theirs = JSON.parse((await post("/api/dm", { thread: mine.thread, body: "gus's words" }, gus)).body);
  // A member on the operator's message: refused, exactly as before.
  const no1 = await post("/api/dm", { id: theirs.message.id, body: "hijacked" }, cara);
  assert.equal(no1.statusCode, 400); assert.match(JSON.parse(no1.body).error, /isn.t your message/);
  assert.equal((await post("/api/dm", { id: theirs.message.id, drop: true }, cara)).statusCode, 400);
  // The operator on a member's message: the words change, the row names the operator.
  const ed = JSON.parse((await post("/api/dm", { id: mine.message.id, body: "cara's words, moderated" }, gus)).body);
  assert.ok(ed.ok && ed.moderated && ed.message.editedBy === "gus", JSON.stringify(ed));
  const seen = JSON.parse((await get("/api/dm/" + mine.thread, cara)).body).messages.find((m) => m.id === mine.message.id);
  assert.equal(seen.body, "cara's words, moderated"); assert.equal(seen.editedBy, "gus"); assert.ok(seen.mine);
  const dr = JSON.parse((await post("/api/dm", { id: mine.message.id, drop: true }, gus)).body);
  assert.ok(dr.ok && dr.moderated && dr.message.deleted && dr.message.deletedBy === "gus");
  // Striking a call is admin-gated at the route (403, not 400), before the store is asked anything.
  const noCall = await post("/api/dm", { callDrop: theirs.message.id }, cara);
  assert.equal(noCall.statusCode, 403); assert.deepEqual(JSON.parse(noCall.body), { ok: false, error: "forbidden" });
  assert.equal((await post("/api/dm", { callDrop: theirs.message.id })).statusCode, 401);
  // No markets in this suite, so nothing stamps: the operator's strike is refused on the merits, not the gate.
  const noStamp = await post("/api/dm", { callDrop: theirs.message.id }, gus);
  assert.equal(noStamp.statusCode, 400); assert.match(JSON.parse(noStamp.body).error, /carries no call/);
  // The read log carries both acts; the read-through surface still serves the moderated rows.
  const audit = JSON.parse((await get("/api/access/dm/audit?limit=10", gus)).body).entries;
  assert.ok(audit.some((e) => e.action === "edit-message" && e.who === "gus" && /cara/.test(e.detail)), JSON.stringify(audit));
  assert.ok(audit.some((e) => e.action === "delete-message" && e.who === "gus"));
  assert.equal((await get("/api/access/dm/audit", cara)).statusCode, 403);
  const rt = JSON.parse((await get("/api/access/dm/" + mine.thread, gus)).body);
  assert.ok(rt.messages.find((m) => m.id === mine.message.id).deletedBy === "gus", "the read-through names the operator too");
  const srv = fs.readFileSync(path.join(__dirname, "..", "server.js"), "utf8");
  assert.ok(/r = ACCOUNTS\.drop\(me\.uid, b\.id, isAdmin\(req\)\)/.test(srv) && /r = ACCOUNTS\.edit\(me\.uid, b\.id, b\.body, isAdmin\(req\)\)/.test(srv), "authz is decided at the route");
  assert.ok(/if \(r\.ok && r\.moderated\) \{ log\(.*dmPoke\(r\.thread, \{ refresh: Number\(r\.thread\) \}\); \}/.test(srv), "a moderated row tells the room to re-pull it");
});

// ===== build 2026.09.24-95: call targets over the wire ================================================
test("dm -95: /api/dm/targets reads the record narrowed to targets; the operator's resolve-now is admin-only; the resolver is wired", async () => {
  const gus = jar(); gus.absorb(await post("/login", { handle: "gus", password: "a-long-password-12" }));
  const cara = jar(); cara.absorb(await post("/login", { handle: "cara", password: "yet-another-long-pw" }));
  assert.equal((await get("/api/dm/targets")).statusCode, 401);
  const r = await get("/api/dm/targets", cara);
  assert.equal(r.statusCode, 200);
  const d = JSON.parse(r.body);
  assert.ok(d.ok && Array.isArray(d.open) && Array.isArray(d.resolved) && Array.isArray(d.summary), r.body);
  assert.equal(r.headers["cache-control"], "no-store");
  // No markets in this suite, so nothing stamps and no target can exist: a target-shaped send is a plain message.
  const members = JSON.parse((await get("/api/access", gus)).body).members;
  const gusUid = members.find((m) => m.handle === "gus").uid;
  const sent = JSON.parse((await post("/api/dm", { to: gusUid, body: "$NVDA to 250 by Oct 15" }, cara)).body);
  assert.ok(sent.ok && sent.message.call === null);
  // Resolve-now posts under other people's names: the operator's button, not a member's.
  const no = await post("/api/dm/targets", {}, cara);
  assert.equal(no.statusCode, 403); assert.deepEqual(JSON.parse(no.body), { ok: false, error: "forbidden" });
  assert.equal((await post("/api/dm/targets", {})).statusCode, 401);
  const yes = JSON.parse((await post("/api/dm/targets", {}, gus)).body);
  assert.deepEqual(yes, { ok: true, resolved: 0 });
  const srv = fs.readFileSync(path.join(__dirname, "..", "server.js"), "utf8");
  assert.ok(srv.includes("ACCOUNTS.setBarSource((coin, from, to) => (store.readCandles ? store.readCandles(coin, from, to) : []));"), "the resolver reads the 5m archive");
  assert.ok(/setInterval\(\(\) => \{ try \{ targetTick\(\); \}/.test(srv), "the resolver runs on a timer");
  assert.ok(/const post = ACCOUNTS\.send\(r\.sender, null, r\.text, null, \{ thread: r\.thread, cmd: "target \$"/.test(srv) && /dmPoke\(post\.thread\); dmMirror\(post\.thread\);/.test(srv),
    "a resolution posts where the call was made, under its author, as a command result — the /alert road");
});

// ===== build 2026.09.24-96: the D1 retest study over the wire =========================================
test("retest study -96: /api/retest-study rides the Backtest tab's gate, answers the pending body, and 304s on its walk signature", async () => {
  const gus = jar(); gus.absorb(await post("/login", { handle: "gus", password: "a-long-password-12" }));
  const cara = jar(); cara.absorb(await post("/login", { handle: "cara", password: "yet-another-long-pw" }));
  assert.equal((await get("/api/retest-study")).statusCode, 401, "the site gate first");
  assert.equal((await get("/api/retest-study", cara)).statusCode, 403, "a member is refused while Backtest is admin");
  const r = await get("/api/retest-study?u=stocks&def=touch&cd=10", gus);
  assert.equal(r.statusCode, 200);
  const d = JSON.parse(r.body);
  assert.equal(d.pending, true, "no markets in this suite: the study says what it needs");
  assert.equal(d.scope, "stocks"); assert.equal(d.params.def, "touch"); assert.equal(d.params.cd, 10);
  assert.deepEqual(d.params.horizons, [1, 3, 5, 10, 20]);
  // (-107) the build and a per-boot nonce ride the tag: a restart never 304s onto another body
  assert.match(r.headers.etag, /^W\/"rt-2026\.09\.25-121-[0-9a-z]+-stocks-touch-10-0-[0-9a-z]+-[^"]+"$/);
  assert.equal(r.headers["cache-control"], "no-cache");
  assert.equal((await get("/api/retest-study?u=stocks&def=touch&cd=10", gus, { "if-none-match": r.headers.etag })).statusCode, 304);
  const bad = JSON.parse((await get("/api/retest-study?u=moon&def=%3Cx%3E&cd=999", gus)).body);
  assert.ok(bad.scope === "stocks" && bad.params.def === "board" && bad.params.cd === 5, "junk normalises to the defaults");
  const cx = await get("/api/retest-study?u=crypto", gus);
  assert.notEqual(cx.headers.etag, r.headers.etag, "the universes never share a validator");
  const C = require("../src/compute");
  assert.ok(C.FEATURES.find((f) => f.key === "backtest").routes.includes("/api/retest-study"), "the manifest owns the route");
});

// ===== build 2026.09.25-116: security pass — the gates judge the route that will RUN =============
test("-116 gate bypass: a percent-encoded or re-spelled path is gated exactly like the plain one", async () => {
  const cara = jar(); cara.absorb(await post("/login", { handle: "cara", password: "yet-another-long-pw" }));
  // Plain spellings: a member is refused the admin tabs and the admin-only AI routes.
  assert.equal((await get("/api/congress", cara)).statusCode, 403);
  // The router decodes %XX before it matches, so these reach the SAME handlers — and must meet the
  // same gate.
  for (const u of ["/api/%63ongress", "/api/%69nsiders", "/api/%77hale", "/api/ema%2Dfeed", "/api/%68ousing"])
    assert.equal((await get(u, cara)).statusCode, 403, u);
  // The AI routes: the encoded spelling answers exactly what the plain one does for this caller.
  for (const [plain, enc] of [["/api/ask", "/api/%61sk"], ["/api/ai-report", "/api/%61i-report"]]) {
    const a = await post(plain, { q: "x" }, cara), e = await post(enc, { q: "x" }, cara);
    assert.equal(e.statusCode, a.statusCode, enc + " answers like " + plain);
  }
  // Signed out, the AI-cost hook refuses before any handler runs — whichever spelling.
  for (const u of ["/api/ask", "/api/%61sk"]) assert.equal((await post(u, { q: "x" })).statusCode, 401, u);
  assert.equal((await get("/api/%E0%A4%A", cara)).statusCode, 400, "an undecodable path is refused, never guessed");
});

test("-116 hardening over the wire: docs strip gated sections, prototype keys 404, derivs refresh is operator-only, the password check is damped", async () => {
  const gus = jar(); gus.absorb(await post("/login", { handle: "gus", password: "a-long-password-12" }));
  const cara = jar(); cara.absorb(await post("/login", { handle: "cara", password: "yet-another-long-pw" }));
  // A tab the member cannot see is not documented in the markup they receive.
  const dm = (await get("/docs", cara)).body, dg = (await get("/docs", gus)).body;
  assert.ok(!dm.includes('id="tab-ematouch"') && !dm.includes('id="tab-congress"'), "member: operator-only sections are absent");
  assert.ok(dm.includes('id="tab-markets"') || dm.includes('data-feature="markets"'), "member: public sections stay");
  assert.ok(dg.includes('id="tab-ematouch"'), "operator: the section is there");
  for (const k of ["constructor", "__proto__", "toString"]) assert.equal((await get("/docs/ref/" + k, cara)).statusCode, 404, k);
  // derivs refresh: refused to a member however the path is spelled
  for (const u of ["/api/derivs/refresh", "/api/derivs/%72efresh"]) assert.equal((await post(u, { coin: "BTC" }, cara)).statusCode, 403, u);
  // the current-password check spends the login damper
  const H = { "x-forwarded-for": "198.51.100.77" };
  let last;
  for (let i = 0; i < 9; i++) last = (await post("/api/account", { current: "wrong-" + i, password: "whatever-long-pw-1" }, cara, H)).statusCode;
  assert.equal(last, 429, "wrong current passwords lock like wrong logins");
});

test("-117 over the wire: a forged engine label is refused; the member snapshot has its own validator", async () => {
  const gus = jar(); gus.absorb(await post("/login", { handle: "gus", password: "a-long-password-12" }));
  const cara = jar(); cara.absorb(await post("/login", { handle: "cara", password: "yet-another-long-pw" }));
  for (const cmd of ["alert #12 fired", "target $NVDA hit", "  Alerts"]) {
    const r = await post("/api/dm", { to: "gus", body: "totally real", cmd }, cara);
    assert.equal(r.statusCode, 400, cmd);
    assert.match(JSON.parse(r.body).error, /reserved/);
  }
  const m = await get("/api/snapshot", cara), a = await get("/api/snapshot", gus);
  assert.equal(m.statusCode, 200); assert.equal(a.statusCode, 200);
  if (JSON.parse(m.body).dataTs) {
    assert.match(m.headers.etag, /-nn"$/, "the member copy (notes closed) has its own tag");
    assert.notEqual(m.headers.etag, a.headers.etag, "an audience change can never 304 onto the other copy");
  }
});

// ===== build 2026.09.25-115: the EMA Touch feed over the wire ========================================
test("ema feed -115: /api/ema-feed rides the EMA Touch tab's admin gate, serves the empty payload, 304s on dataTs", async () => {
  const gus = jar(); gus.absorb(await post("/login", { handle: "gus", password: "a-long-password-12" }));
  const cara = jar(); cara.absorb(await post("/login", { handle: "cara", password: "yet-another-long-pw" }));
  assert.equal((await get("/api/ema-feed")).statusCode, 401, "the site gate first");
  assert.equal((await get("/api/ema-feed", cara)).statusCode, 403, "a member is refused while the tab soaks admin-only");
  const r = await get("/api/ema-feed", gus);
  assert.equal(r.statusCode, 200);
  const d = JSON.parse(r.body);
  assert.ok(Array.isArray(d.near) && Array.isArray(d.cards) && d.params && d.counts, "the tab's payload shape");
  assert.equal(r.headers["cache-control"], "no-cache");
  assert.equal((await get("/api/ema-feed", gus, { "if-none-match": r.headers.etag })).statusCode, 304);
  // the tab's visibility rides the boot flags: hidden for a member, shown for the operator
  assert.ok((await get("/", cara)).body.includes('"ematouch":false'), "a member's shell hides the tab");
  assert.ok((await get("/", gus)).body.includes('"ematouch":true'), "the operator's shell shows it");
});

test("earnings setups -100: the route is session-gated, serves the empty payload honestly, and revalidates to a 304", async () => {
  assert.equal((await get("/api/earnings/setups")).statusCode, 401, "signed out: 401 like every API read");
  const gus = jar(); gus.absorb(await post("/login", { handle: "gus", password: "a-long-password-12" }));
  const r = await get("/api/earnings/setups", gus);
  assert.equal(r.statusCode, 200);
  const b = JSON.parse(r.body);
  assert.deepEqual(b.cards, []); assert.equal(b.sessions, 5); assert.equal(b.runupD, 7);
  assert.equal(b.error, "earnings calendar not fetched yet", "no calendar under test: the empty strip says why");
  assert.ok(r.headers.etag, "ETag carried");
  const again = await get("/api/earnings/setups", gus, { "if-none-match": r.headers.etag });
  assert.equal(again.statusCode, 304, "unchanged content revalidates");
});
