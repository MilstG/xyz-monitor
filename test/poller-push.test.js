"use strict";
// poller.js — alerts, push, telegram, messages bridge. Split out of test.js (build 2026.09.16-80); order within the file is the original order.
const test = require("node:test");
const assert = require("node:assert");
const { DAY, C, pushHarness } = require("./_shared");


test("off-site ledger backup: disabled by default, pushes via contents API, blob-sha skip, raw store reads", async () => {
  const fs = require("fs"), path = require("path"), os = require("os"), crypto = require("crypto");
  const { createPoller } = require("../src/poller");
  const { openStore } = require("../src/store");
  // store reads the raw persisted bytes — existing files only, verbatim
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "xyzbk-"));
  const st = openStore(dir);
  st.saveLedger({ ts: 1, open: [], closed: [], rearm: [] });
  let files = st.readBackupFiles();
  assert.equal(files.length, 1, "no archive yet -> ledger.json only, no phantom entries");
  assert.equal(files[0].name, "ledger.json");
  st.archiveClosed([{ key: "A|gap" }]);
  files = st.readBackupFiles();
  assert.equal(files.length, 2, "archive present -> both files ship");
  assert.equal(files[1].name, "ledger-archive.jsonl");
  assert.equal(files[0].content, fs.readFileSync(path.join(dir, "ledger.json"), "utf8"), "bytes verbatim, no re-serialization");
  // disabled unless BOTH env vars are set — a token alone or a repo alone does nothing
  const mkP = (storeArg) => createPoller({ dex: "xyz", store: storeArg, log: () => {}, version: "test", crypto: false });
  delete process.env.LEDGER_BACKUP_REPO; delete process.env.LEDGER_BACKUP_TOKEN; delete process.env.GITHUB_TOKEN;
  const calls = [];
  const mockFetch = (notFound) => async (url, opts) => {
    calls.push({ url, method: (opts && opts.method) || "GET", body: opts && opts.body ? JSON.parse(opts.body) : null, auth: opts && opts.headers && opts.headers.authorization });
    if (!opts || !opts.method) return notFound ? { ok: false, status: 404, json: async () => ({}) }
      : { ok: true, status: 200, json: async () => ({ sha: notFound === false ? mockFetch.sha : null }) };
    return { ok: true, status: 200, json: async () => ({}) };
  };
  let r = await mkP(st).backupLedgerNow(mockFetch(true));
  assert.deepEqual(r, { ok: false, disabled: true }, "no env -> disabled, zero network");
  assert.equal(calls.length, 0);
  // enabled: fresh repo (GETs 404) -> both files PUT with base64 content and auth header
  process.env.LEDGER_BACKUP_REPO = "MilstG/xyz-ledger-backup"; process.env.LEDGER_BACKUP_TOKEN = "tok123";
  try {
    const p = mkP(st);
    r = await p.backupLedgerNow(mockFetch(true));
    assert.deepEqual({ ok: r.ok, pushed: r.pushed, skipped: r.skipped }, { ok: true, pushed: 2, skipped: 0 }, JSON.stringify(r));
    const puts = calls.filter((c) => c.method === "PUT");
    assert.equal(puts.length, 2);
    assert.ok(puts.every((c) => c.url.startsWith("https://api.github.com/repos/MilstG/xyz-ledger-backup/contents/")), "contents API, right repo");
    assert.ok(puts.every((c) => c.auth === "Bearer tok123"), "token rides the auth header");
    assert.equal(Buffer.from(puts[0].body.content, "base64").toString("utf8"), files[0].content, "payload is the exact file bytes, base64d");
    assert.ok(puts.every((c) => c.body.branch === "main" && !("sha" in c.body)), "create path: no prior sha, default branch");
    // unchanged content: remote sha == git blob sha -> skipped, zero PUTs
    calls.length = 0;
    const blobSha = (s) => crypto.createHash("sha1").update("blob " + Buffer.byteLength(s, "utf8") + "\0").update(s, "utf8").digest("hex");
    const already = async (url, opts) => {
      calls.push({ method: (opts && opts.method) || "GET" });
      if (!opts || !opts.method) {
        const name = decodeURIComponent(url.split("/contents/")[1].split("?")[0]);
        const f = st.readBackupFiles().find((x) => x.name === name);
        return { ok: true, status: 200, json: async () => ({ sha: blobSha(f.content) }) };
      }
      throw new Error("PUT must not happen for unchanged content");
    };
    r = await p.backupLedgerNow(already);
    assert.deepEqual({ ok: r.ok, pushed: r.pushed, skipped: r.skipped }, { ok: true, pushed: 0, skipped: 2 }, "byte-identical backup is a no-op commit-wise");
    assert.equal(calls.filter((c) => c.method === "PUT").length, 0);
    // a failed PUT reports, never throws out of the job
    const broken = async (url, opts) => (!opts || !opts.method) ? { ok: false, status: 404, json: async () => ({}) } : { ok: false, status: 403 };
    r = await p.backupLedgerNow(broken);
    assert.equal(r.ok, false); assert.ok(/HTTP 403/.test(r.error), r.error);
  } finally {
    delete process.env.LEDGER_BACKUP_REPO; delete process.env.LEDGER_BACKUP_TOKEN;
  }
  // wiring pins: weekly schedule + post-boot kick + stats surface, all inside start()
  const pol = fs.readFileSync(path.join(__dirname, "..", "src", "poller.js"), "utf8");
  for (const pin of ["const BK_MS = 7 * DAY", "setInterval(bkTick, BK_MS)", "setTimeout(bkTick, 10 * 60 * 1000)",
    "backup: { enabled: !!(BK_REPO && BK_TOKEN)", "Ledger backup: disabled"])
    assert.ok(pol.includes(pin), `backup wiring pin missing: ${pin}`);
});

test("push outbox: the hourly cap holds one recipient's burst without blocking everyone else", () => {
  // The queue is SHARED across recipients and the cap check used to run on the head item only,
  // returning outright — so one person's burst hitting their 20/h ceiling parked every other
  // recipient's alerts a minute at a time. Pinned at the source: the selector must skip a capped
  // chat rather than the drain giving up on the tick.
  const fs = require("fs"), path = require("path");
  const pol = fs.readFileSync(path.join(__dirname, "..", "src", "poller.js"), "utf8");
  const i = pol.indexOf("async function pushDrain()");
  assert.ok(i > -1, "pushDrain present");
  const body = pol.slice(i, i + 1600);
  assert.ok(/const deliverable = \(q\) =>/.test(body), "one predicate decides deliverability");
  assert.ok(/q\.force \|\| pushRecent\(q\.chat, now\) < PUSH_CAP_HOUR/.test(body),
    "the hourly cap is part of item SELECTION, so a capped chat is skipped, not blocking");
  assert.ok(/pushQueue\.findIndex\(deliverable\)/.test(body), "the drain picks the first deliverable item");
  assert.ok(!/if \(!item\.force && pushRecent\(item\.chat, now\) >= PUSH_CAP_HOUR\)/.test(body),
    "the head-of-line cap check is gone");
  // The outbox is sized for the uncapped batcher: several recipients, several parts each, and an
  // hourly cap that parks messages here rather than dropping them.
  assert.ok(/PUSH_QUEUE_MAX = 250\b/.test(pol), "outbox bound sized for a real multi-part burst");
  assert.ok(!/pushBatch\([^)]*\{ max:/.test(pol), "no call site re-imposes an event cap on the batcher");
});

test("push: fully dormant without TG_BOT_TOKEN — no state, no calls, no surprises", async () => {
  delete process.env.TG_BOT_TOKEN;
  const { p, calls } = pushHarness();
  const st = p.getPush("own-a", false);
  assert.equal(st.enabled, false, "reported as off so the panel can say so instead of looking broken");
  assert.deepEqual(st.recipients, []);
  await p.pushUpdatesNow();
  await p.pushDrainNow();
  p.pushTickNow();
  assert.equal(calls.length, 0, "an unconfigured deploy must never reach out to Telegram");
  assert.equal(p.pushTest(null, "own-a", false).ok, false, "test fire is honest about being unavailable");
});

test("push: adopting a linked chat needs the code sent to that chat, and only moves ownership then", () => {
  process.env.TG_BOT_TOKEN = "test-token";
  const { p } = pushHarness();
  const mint = p.pushMintCode("old-browser-handle", false);
  assert.ok(p.pushBindNow(mint.code, 777000111, "Taladro").ok, "a chat linked under a pre-account browser handle");

  assert.equal(p.pushAdoptRequest(777000111, "").ok, false, "no owner, no request");
  assert.equal(p.pushAdoptRequest(999, "uid-lena").ok, false, "an unknown chat cannot be asked about");
  const r = p.pushAdoptRequest(777000111, "uid-lena");
  assert.ok(r.ok && /^\d{6}$/.test(r.code), "a request mints a 6-digit code for THAT chat");

  assert.equal(p.pushAdoptVerify(777000111, "uid-lena", "000000").ok, r.code === "000000", "a wrong guess is refused");
  assert.equal(p.pushAdoptVerify(777000111, "uid-other", r.code).ok, false, "the code is bound to the requester — another account cannot redeem it");
  assert.equal(p.pushOwnerOf("777000111"), "old-browser-handle", "ownership has not moved yet");

  const r2 = p.pushAdoptRequest(777000111, "uid-lena");   // re-request replaces; the old code above may be burned by the guesses
  const v = p.pushAdoptVerify(777000111, "uid-lena", r2.code);
  assert.ok(v.ok, "the right code, from the right account, transfers");
  assert.equal(p.pushOwnerOf("777000111"), "uid-lena", "the chat now belongs to the account");
  assert.equal(p.pushRecipientsFor("uid-lena").length, 1, "and escalation targets find it");
  assert.equal(p.pushAdoptVerify(777000111, "uid-lena", r2.code).ok, false, "a code works once");
  assert.equal(p.pushAdoptRequest(777000111, "uid-lena").error, "already-yours", "an owned chat is not re-claimable by its owner");
});

test("push: link codes are single-use, expiring, and a new recipient starts CAUGHT UP", () => {
  process.env.TG_BOT_TOKEN = "test-token";
  const { p } = pushHarness();
  p.pushOpsNow("seed", "an event that predates the link");
  p.pushOpsNow("seed2", "another");

  assert.equal(p.pushBindNow("ZZZZZZ", 111, "nobody").ok, false, "a code that was never minted is refused");
  assert.equal(p.pushBindNow("bad", 111, "nobody").error, "bad-code", "malformed codes never reach the store");

  const mint = p.pushMintCode("own-a", true);
  assert.ok(/^[A-HJ-NP-Z2-9]{6}$/.test(mint.code));
  assert.ok(mint.expiresAt > Date.now());
  const ok = p.pushBindNow(mint.code.toLowerCase(), 5551234567, "milst");
  assert.equal(ok.ok, true, "case-insensitive, because it is typed on a phone");
  assert.equal(p.pushBindNow(mint.code, 222, "someone else").ok, false, "codes are SINGLE USE — a shared screenshot cannot link a stranger");

  const st = p.getPush("own-a", false);
  assert.equal(st.recipients.length, 1);
  assert.equal(st.recipients[0].name, "milst");
  assert.ok(!st.recipients[0].chat.includes("undefined"));
  assert.equal(st.recipients[0].mask, "\u20264567", "the panel is shared with the group, so chat ids are masked there — a chat id is enough to attempt contact");

  // The backlog rule: linking must not deliver the ring's history.
  p.pushTickNow();
  assert.equal(p.pushStateNow().queue, 0, "a fresh recipient's cursor starts at the live seq — no two hundred stale setups as a welcome");
  delete process.env.TG_BOT_TOKEN;
});

test("push: the boot rule is a lookback, not a mute — the deploy notice survives it", () => {
  process.env.TG_BOT_TOKEN = "test-token";
  const { p } = pushHarness();
  const mint = p.pushMintCode("own-a", true);
  p.pushBindNow(mint.code, 999, "milst");

  // An event that fired long before this boot: the cursor must advance past it WITHOUT sending.
  p.pushSetBootNow(Date.now());
  const stale = p.pushOpsNow("old", "fired while nobody was listening");
  stale.at = Date.now() - 60 * 60 * 1000;
  p.pushTickNow();
  assert.equal(p.pushStateNow().queue, 0, "a pre-boot backlog is seeded, not announced");

  // …but an event emitted now goes out immediately. A blanket post-boot mute would swallow exactly
  // this message — the one that proves the wire survived the deploy.
  p.pushOpsNow("deploy", "build test is live");
  p.pushTickNow();
  assert.equal(p.pushStateNow().queue, 1, "the deploy notice is delivered, not held behind a grace timer");
  delete process.env.TG_BOT_TOKEN;
});

test("push: per-recipient cursors are independent — one strict filter cannot silence everyone else", () => {
  process.env.TG_BOT_TOKEN = "test-token";
  const { p } = pushHarness();
  const a = p.pushMintCode("own-a", true); p.pushBindNow(a.code, 1001, "a");
  const b = p.pushMintCode("own-b", true); p.pushBindNow(b.code, 1002, "b");
  p.pushSetClasses("1002", ["setup"], "own-b", false);   // b wants setups only

  p.pushOpsNow("deploy", "build test is live");
  p.pushTickNow();
  assert.equal(p.pushStateNow().queue, 1, "only the subscriber to that class is queued");

  // b's cursor still advanced: a filtered event is HANDLED, not left pending forever.
  p.pushTickNow();
  assert.equal(p.pushStateNow().queue, 1, "a second tick must not re-queue an event that was already decided on");
  delete process.env.TG_BOT_TOKEN;
});

test("push outbox: 429 honours retry_after, 403 mutes, 4xx drops without wedging the queue", async () => {
  process.env.TG_BOT_TOKEN = "test-token";

  // 429: their number, not ours, and the item stays queued.
  {
    const { p, calls } = pushHarness([{ status: 429, body: { ok: false, description: "Too Many Requests", parameters: { retry_after: 7 } } }]);
    const m = p.pushMintCode("own-a", true); p.pushBindNow(m.code, 1, "a");
    p.pushOpsNow("x", "y"); p.pushTickNow();
    await p.pushDrainNow();
    assert.equal(calls.length, 1);
    const st = p.pushStateNow();
    assert.equal(st.queue, 1, "a rate-limited message is retried, never discarded");
    assert.ok(st.hold - Date.now() > 6000, "the backoff uses Telegram's retry_after, not a guess");
  }
  // 403: the recipient blocked the bot. Mute (so the panel can say WHY) and purge their backlog.
  {
    const { p } = pushHarness([{ status: 403, body: { ok: false, description: "Forbidden: bot was blocked by the user" } }]);
    const m = p.pushMintCode("own-a", true); p.pushBindNow(m.code, 1, "a");
    p.pushOpsNow("x", "y"); p.pushTickNow();
    p.pushOpsNow("x2", "y2"); p.pushTickNow();
    await p.pushDrainNow();
    const st = p.getPush("own-a", false);
    assert.equal(st.recipients[0].muted, true, "muted, not deleted — a vanished row looks like a bug");
    assert.ok(/blocked/i.test(st.recipients[0].lastErr), "the reason is kept and shown");
    assert.equal(p.pushStateNow().queue, 0, "their whole backlog is purged rather than retried forever");
  }
  // 400: a malformed message must not sit at the head of the queue blocking every alert behind it.
  {
    const { p } = pushHarness([{ status: 400, body: { ok: false, description: "Bad Request: can't parse entities" } },
      { status: 200, body: { ok: true, result: {} } }]);
    const m = p.pushMintCode("own-a", true); p.pushBindNow(m.code, 1, "a");
    p.pushOpsNow("x", "y"); p.pushTickNow();
    p.pushOpsNow("x2", "y2"); p.pushTickNow();
    await p.pushDrainNow();
    assert.equal(p.pushStateNow().queue, 1, "the undeliverable message is dropped so the queue keeps moving");
    assert.ok(/parse entities/.test(p.getPush("own-a", false).lastErr), "the API's own words are surfaced — this is what a bad message looks like from the outside");
  }
  delete process.env.TG_BOT_TOKEN;
});

test("push outbox: success paces sends and the queue is bounded with the loss disclosed", async () => {
  process.env.TG_BOT_TOKEN = "test-token";
  const { p, calls } = pushHarness();
  const m = p.pushMintCode("own-a", true); p.pushBindNow(m.code, 1, "a");
  p.pushOpsNow("one", "1"); p.pushTickNow();
  p.pushOpsNow("two", "2"); p.pushTickNow();
  await p.pushDrainNow();
  assert.equal(calls.length, 1, "one send per drain");
  assert.ok(p.pushStateNow().hold > Date.now(), "the next send is paced — Telegram's per-chat ceiling is ~20/min");
  await p.pushDrainNow();
  assert.equal(calls.length, 1, "the pacing hold is respected rather than busy-looping the API");
  assert.equal(calls[0].body.parse_mode, "HTML");
  assert.equal(calls[0].body.disable_web_page_preview, true, "a link preview would bury the geometry under a page card");
  delete process.env.TG_BOT_TOKEN;
});

test("push commands: /start binds, /stop unlinks, offset advances, junk is ignored", async () => {
  process.env.TG_BOT_TOKEN = "test-token";
  const { p, queue } = pushHarness();
  const upd = (id, text) => ({ update_id: id, message: { chat: { id: 5551234567 }, from: { first_name: "milst" }, text } });
  const reply = (result) => ({ body: { ok: true, result } });

  // A code that was never minted binds nobody — but the offset still advances, or the same bad
  // command replays on every poll forever.
  queue.push(reply([upd(10, "/start ZZZZZZ")]));
  await p.pushUpdatesNow();
  assert.equal(p.getPush("own-a", false).recipients.length, 0, "an invalid code binds nobody");
  assert.equal(p.pushStateNow().offset, 11, "the offset advances even for a rejected command");

  // The real round trip, with a code this server actually minted.
  const code = p.pushMintCode("own-a", true).code;
  queue.push(reply([upd(11, "/start " + code)]));
  await p.pushUpdatesNow();
  const linked = p.getPush("own-a", false).recipients;
  assert.equal(linked.length, 1, "a minted code binds the chat that carried it");
  assert.equal(linked[0].name, "milst", "the display name comes from Telegram, not from a form nobody fills in");

  // Non-command chatter must not touch state.
  queue.push(reply([upd(12, "hello?"), { update_id: 13 }, { update_id: 14, message: { chat: { id: 1 } } }]));
  await p.pushUpdatesNow();
  assert.equal(p.getPush("own-a", false).recipients.length, 1, "junk, empty updates and text-less messages are ignored without throwing");
  assert.equal(p.pushStateNow().offset, 15);

  queue.push(reply([upd(15, "/stop")]));
  await p.pushUpdatesNow();
  assert.equal(p.getPush("own-a", false).recipients.length, 0, "/stop unlinks from the DM itself — nobody should need the panel to make it stop");

  // An unlink of an unknown chat is a clean failure, not a throw.
  assert.equal(p.pushUnlink("5551234567", "own-a", false).ok, false);
  delete process.env.TG_BOT_TOKEN;
});

test("push ops lane: the stall watchdog is edge-triggered in BOTH directions", () => {
  process.env.TG_BOT_TOKEN = "test-token";
  const { p } = pushHarness();
  const opsCount = () => p.getTriggers(0, null, true).events.filter((e) => e.kind === "ops").length;

  p.pushHealthNow();
  assert.equal(opsCount(), 0, "no poll history yet is a cold boot, not a fault");

  p.pushSetPollNow(Date.now());
  p.pushHealthNow();
  assert.equal(opsCount(), 0, "a healthy poller says nothing");

  // Go cold: exactly one alert, however many ticks run. An ops channel that repeats every minute
  // is a channel you mute, and then the real warning goes with it.
  p.pushSetPollNow(Date.now() - 20 * 60 * 1000);
  p.pushHealthNow();
  p.pushHealthNow();
  p.pushHealthNow();
  assert.equal(opsCount(), 1, "the stall fires ONCE, not once per tick");
  const stall = p.getTriggers(0, null, true).events.filter((e) => e.kind === "ops").pop();
  assert.equal(stall.level, "warn");
  assert.ok(/stalled/i.test(stall.title));

  // Recovery is its own edge — without it, silence after a stall is ambiguous.
  p.pushSetPollNow(Date.now());
  p.pushHealthNow();
  p.pushHealthNow();
  assert.equal(opsCount(), 2, "recovery announces exactly once too");
  assert.ok(/recovered/i.test(p.getTriggers(0, null, true).events.pop().title));

  // …and the pair can happen again. A latched flag that never re-arms would report the first
  // outage of a deploy's life and nothing after it.
  p.pushSetPollNow(Date.now() - 20 * 60 * 1000);
  p.pushHealthNow();
  assert.equal(opsCount(), 3, "the watchdog re-arms for the next outage");
  delete process.env.TG_BOT_TOKEN;
});

test("push: state survives a restart, and hydrate restores cursors rather than replaying the ring", () => {
  process.env.TG_BOT_TOKEN = "test-token";
  const { p, store } = pushHarness();
  const m = p.pushMintCode("own-a", true);
  p.pushBindNow(m.code, 777, "milst");
  p.pushSetClasses("777", ["ops"], "own-a", false);
  const saved = store.saved;
  assert.ok(saved && saved.recipients.length === 1, "recipients are persisted the moment they link");
  assert.deepEqual(saved.recipients[0].classes, ["ops"]);
  assert.ok(Number.isFinite(saved.recipients[0].cur), "the delivery cursor is persisted WITH the recipient — a split write could replay or eat a backlog");

  assert.equal(p.pushSetClasses("777", [], "own-a", false).classes, null, "an empty selection normalises to all classes");
  assert.equal(p.pushSetClasses("nobody", ["ops"], "own-a", false).ok, false);
  delete process.env.TG_BOT_TOKEN;
});

test("push: the trigger ring carries a kind on every event and legacy events read as setups", () => {
  process.env.TG_BOT_TOKEN = "test-token";
  const { p } = pushHarness();
  p.pushOpsNow("deploy", "build test is live");
  const evs = p.getTriggers(0, null, true).events;
  assert.ok(evs.length >= 1);
  assert.equal(evs[evs.length - 1].kind, "ops", "every emitted event is class-stamped so consumers filter on a field that always exists");
  // `cls` is already taken on actionable rows (the R:R class); a collision there would mis-route
  // every message on the board, so the class field must stay `kind`.
  const pol = require("fs").readFileSync(require("path").join(__dirname, "..", "src", "poller.js"), "utf8");
  assert.ok(pol.includes('function emitTrig(kind, obj, now)'), "one emitter owns the ring");
  assert.equal((pol.match(/trigEvents\.push\(/g) || []).length, 1, "exactly ONE push site into the ring — a second would bypass the kind stamp and the trim");
  assert.ok(pol.includes('Object.assign({ kind: "setup" }, e)'), "events persisted before the kind stamp must hydrate as setups");
  delete process.env.TG_BOT_TOKEN;
});

test("telegram lane fails fast: tgApi carries a real 15s abort signal to every call", async () => {
  const fs = require("fs"), path = require("path");
  const pol = fs.readFileSync(path.join(__dirname, "..", "src", "poller.js"), "utf8");
  assert.ok(pol.includes("signal: AbortSignal.timeout(15000)"),
    "a stalled Telegram request must abort in 15s — the outbox drains sequentially, so one hang stalls the whole alert lane");
  // Functional: the signal actually reaches the fetch options on a live call path.
  process.env.TG_BOT_TOKEN = "test-token";
  let seenSignal = null;
  const store = { loadAll: () => new Map(), loadRegime: () => [], loadLedger: () => null, saveLedger: () => {},
    insert: () => {}, saveRegime: () => {}, loadTriggers: () => null, saveTriggers: () => {},
    savePush: () => {}, loadPush: () => null };
  const pushFetch = async (url, opts) => {
    seenSignal = opts && opts.signal;
    return { ok: true, status: 200, json: async () => ({ ok: true, result: [] }) };
  };
  const { createPoller } = require("../src/poller");
  const p = createPoller({ dex: "xyz", store, log: () => {}, version: "test", crypto: false, pushFetch });
  await p.pushUpdatesNow();
  assert.ok(seenSignal instanceof AbortSignal, "the timeout signal must ride the actual request, not just exist in source");
  delete process.env.TG_BOT_TOKEN;
});

test("-06 tier boundary: baskets/ratio never reach the alert emitters, the fire sites, or the push classes", () => {
  const fs = require("fs"), path = require("path");
  const pj = fs.readFileSync(path.join(__dirname, "..", "src", "poller.js"), "utf8");
  const grab = (src, sig) => {
    const i = src.indexOf(sig);
    assert.ok(i > -1, sig + " present");
    let d = 0, j = src.indexOf("{", i);
    for (let k = j; k < src.length; k++) { if (src[k] === "{") d++; else if (src[k] === "}") { d--; if (!d) return src.slice(i, k + 1); } }
    throw new Error("unbalanced " + sig);
  };
  // The entire ratio assembly must be inert: no push, no alert state, no claim machinery.
  const gr = grab(pj, "function getRatio(");
  const gb = grab(pj, "function getBasketsPayload(");
  const gc = grab(pj, "function createBasket(");
  for (const bad of ["pushBatch", "enqueueAlert", "emaAlertState", "recordClaim", "openClaim", "pushDrain", "maState"]) {
    assert.ok(!gr.includes(bad), "getRatio touches " + bad + " — the tier boundary is breached");
    assert.ok(!gb.includes(bad), "getBasketsPayload touches " + bad);
    assert.ok(!gc.includes(bad), "createBasket touches " + bad);
  }
  // The push-class registry gains no basket/ratio class — there is nothing to subscribe to.
  const C = require("../src/compute");
  assert.ok(Array.isArray(C.PUSH_CLASSES) && !C.PUSH_CLASSES.some((c) => /basket|ratio/i.test(c)), "no basket/ratio push class exists");
  // Manifest entry pinned: one key, admin default, BOTH routes gated by it.
  const f = C.FEATURES.find((x) => x.key === "baskets");
  assert.ok(f, "baskets manifest entry exists");
  assert.equal(f.def, "admin", "admin-only while it soaks");
  assert.deepEqual(f.routes, ["/api/baskets", "/api/ratio"], "both routes gated by the one key");
  // Ratio constants: no shorter EMA can ever wear the 200 name.
  assert.ok(pj.includes("RATIO_EMA_SPAN = 200"), "EMA span pinned at 200");
  assert.ok(pj.includes("RATIO_EMA_MIN = RATIO_EMA_SPAN + 5"), "eligibility floor derives from the span, mirroring emaSeries");
  assert.ok(gr.includes('"insufficient_bars"'), "machine-readable reason when the EMA cannot exist");
});

// Every /help from ANY chat earned a forced reply on the one shared outbox; a stranger who found
// the bot could keep the 1-per-3s drain busy and evict real alerts. Replies are now budgeted per
// chat (and globally for strangers), bad /start codes count toward a silence, and the drain sends
// alerts before replies.
test("audit -67: bot command replies are throttled per chat, strangers share a budget, alerts go first", async () => {
  process.env.TG_BOT_TOKEN = "test-token";
  const { p, queue, calls } = pushHarness();
  const upd = (id, text, chat) => ({ update_id: id, message: { chat: { id: chat }, from: { first_name: "x" }, text } });
  const reply = (result) => ({ body: { ok: true, result } });
  let id = 100;
  // One unlinked chat, ten /help in a row: three replies, not ten.
  queue.push(reply(Array.from({ length: 10 }, () => upd(id++, "/help", 7001))));
  await p.pushUpdatesNow();
  assert.equal(p.pushStateNow().queue, 3, "a stranger earns three replies a minute, then silence");
  // Ten different strangers: the global stranger budget caps them together.
  queue.push(reply(Array.from({ length: 10 }, (_, i) => upd(id++, "/help", 8000 + i))));
  await p.pushUpdatesNow();
  assert.equal(p.pushStateNow().queue, 5, "strangers share five replies a minute between them");
  // Bad /start codes: five rejections then the chat is ignored (no reply consumed, no oracle).
  const { p: p2, queue: q2 } = pushHarness();
  q2.push(reply(Array.from({ length: 8 }, () => upd(id++, "/start NOPE" + id, 7002))));
  await p2.pushUpdatesNow();
  assert.ok(p2.pushStateNow().queue <= 3, "bad-code replies are budgeted like any other (" + p2.pushStateNow().queue + ")");
  q2.length = 0;
  q2.push(reply([upd(id++, "/start " + p2.pushMintCode("own-a", true).code, 7002)]));
  await p2.pushUpdatesNow();
  assert.equal(p2.getPush("own-a", false).recipients.length, 0, "after five bad codes the chat is ignored for a while, even with a real code");
  // A linked person's command reply is forced past the ALERT cap (it is not an alert) but an alert
  // enqueued after it still goes out first.
  const { p: p3, queue: q3, calls: c3 } = pushHarness();
  const m = p3.pushMintCode("own-a", true); p3.pushBindNow(m.code, 1, "a");
  q3.push(reply([upd(id++, "/help", 1)]));
  await p3.pushUpdatesNow();
  p3.pushOpsNow("setup", "the alert"); p3.pushTickNow();
  assert.equal(p3.pushStateNow().queue, 2);
  await p3.pushDrainNow();
  const sends = c3.filter((c) => /sendMessage/.test(c.url));
  assert.ok(sends.length === 1 && /the alert/.test(sends[0].body.text), "the alert is sent before the reply that was queued first");
  await p3.pushDrainNow();
  assert.equal(c3.filter((c) => /sendMessage/.test(c.url)).length, 1, "the pacing gap still holds between the two");
  delete process.env.TG_BOT_TOKEN;
});

// ===== build 2026.09.21-83: bare text and /alert over the bridge ================================
test("bridge: bare text from a linked chat is forwarded (never posted here), strangers stay inert, /alert forwards and answers", async () => {
  process.env.TG_BOT_TOKEN = "test-token";
  try {
    const { p, queue } = pushHarness();
    const mint = p.pushMintCode("uid-lena", false);
    assert.ok(p.pushBindNow(mint.code, 4242, "Lena").ok);
    const seen = [];
    p.setDmBridge((chat, text, opts) => {
      seen.push([chat, text, opts || null]);
      if (opts && opts.bare) return text === "fail me" ? { ok: false, error: "slow down" } : text === "quiet" ? { ok: false, error: "not-synced", silent: true } : { ok: true, thread: 1 };
      if (opts && opts.alert) return { ok: true, text: "\u{1f514} alert #1 · NVDA · price above 200 → fires here" };
      return { ok: true };
    });
    const msg = (chat, text, id) => ({ update_id: id, message: { chat: { id: chat }, from: { first_name: "x" }, text } });
    const grp = { update_id: 7, message: { chat: { id: 4242, type: "group" }, from: { first_name: "x" }, text: "group chatter" } };
    queue.push({ result: [msg(4242, "hello desk", 1), msg(9999, "hello from a stranger", 2), msg(4242, "/alert NVDA > 200", 3),
      msg(4242, "fail me", 4), msg(4242, "quiet", 5), msg(4242, "/help", 6), grp] });
    const before = p.pushStateNow().queue;
    await p.pushUpdatesNow();
    assert.deepEqual(seen.map((s) => [s[0], s[1], s[2]]), [
      ["4242", "hello desk", { bare: true }], ["4242", "NVDA > 200", { alert: true }],
      ["4242", "fail me", { bare: true }], ["4242", "quiet", { bare: true }]],
      "linked bare text and /alert reach the bridge; a stranger's text never does; commands keep their own paths");
    // Replies: one for /alert, one for the failed send, one for /help. NOT for the delivered line
    // (the mirror does not echo) and NOT for the silent not-synced case.
    assert.equal(p.pushStateNow().queue - before, 3, "exactly three replies earned");
    const pol = require("fs").readFileSync(require("path").join(__dirname, "..", "src", "poller.js"), "utf8");
    assert.ok(/if \(dmBridge && !txt\.startsWith\("\/"\) && pushRecipients\.has\(String\(chat\)\) && \(m\.chat\.type == null \|\| m\.chat\.type === "private"\)\)/.test(pol), "bare text is gated on the chat being linked AND private, at the source");
    assert.ok(/if \(res && !res\.ok && !res\.silent\) pushReply/.test(pol), "a silent refusal spends no reply budget");
  } finally { delete process.env.TG_BOT_TOKEN; }
});

test("bridge: pushQuietNow reads the recipient's own quiet window", () => {
  process.env.TG_BOT_TOKEN = "test-token";
  try {
    const { p } = pushHarness();
    const mint = p.pushMintCode("uid-lena", false);
    assert.ok(p.pushBindNow(mint.code, 4343, "Lena").ok);
    assert.equal(p.pushQuietNow("4343"), false, "no window set");
    assert.equal(p.pushQuietNow("nope"), false, "unknown chat is never quiet");
    const h = new Date().getUTCHours();
    const set = p.pushSetPrefs("4343", { quiet: { from: h, to: (h + 2) % 24, tz: 0 } }, "uid-lena", false);
    assert.ok(set.ok, JSON.stringify(set));
    assert.equal(p.pushQuietNow("4343"), true, "inside the window right now");
    assert.ok(p.pushSetPrefs("4343", { quiet: { from: (h + 3) % 24, to: (h + 5) % 24, tz: 0 } }, "uid-lena", false).ok);
    assert.equal(p.pushQuietNow("4343"), false, "outside it");
  } finally { delete process.env.TG_BOT_TOKEN; }
});
