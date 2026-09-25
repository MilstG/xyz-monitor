"use strict";
// Security pass, round two (build 2026.09.25-117): the audit's remaining low findings.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs"), path = require("path");

function poller(extra) {
  const { createPoller } = require("../src/poller");
  const store = Object.assign({ loadAll: () => new Map(), loadRegime: () => [], loadLedger: () => null, saveLedger: () => {},
    insert: () => {}, saveRegime: () => {}, loadTriggers: () => null, saveTriggers: () => {}, saveRules: () => {}, loadRules: () => null,
    saveNotes: () => {}, loadNotes: () => null }, extra || {});
  return createPoller({ dex: "xyz", store, log: () => {}, version: "test", crypto: false });
}

test("-117 snapshot: note digests reach only callers the Notes tab is open to", () => {
  const p = poller();
  p.seedRowNow("xyz:AAA", { ticker: "AAA", px: 10, uni: "xyz" });
  assert.ok(p.createNote("xyz:AAA", "operator's private read", true).ok);
  p.buildSnapshotNow();
  const full = p.getSnapshot();
  const row = full.markets.find((m) => m.coin === "xyz:AAA");
  assert.ok(row && row.nt && row.nt.n === 1, "the operator's snapshot carries the digest");
  const nn = p.getSnapshotNoNotes();
  assert.ok(nn.markets.every((m) => !("nt" in m)), "the member copy carries none");
  assert.equal(nn.dataTs, full.dataTs, "same freshness clock — the client's logic is untouched");
  assert.ok(full.markets.find((m) => m.coin === "xyz:AAA").nt, "stripping never mutates the shared body");
  assert.equal(p.getSnapshotNoNotes(), nn, "memoized per snapshot object");
  const srv = fs.readFileSync(path.join(__dirname, "..", "server.js"), "utf8");
  assert.ok(/featureVisible\(poller\.getFlags\(\), "notes", isAdmin\(req\)\)/.test(srv) && srv.includes("'W/\"' + b.dataTs + '-nn\"'"),
    "the route picks the copy by the notes gate, under its own validator");
});

test("-117 alerts: rule ceiling, bounded link codes, per-caller test cooldown", () => {
  const p = poller();
  p.seedRowNow("xyz:AAA", { ticker: "AAA", px: 10, uni: "xyz" });
  // link codes: a 4th retires the caller's oldest
  const codes = [1, 2, 3, 4].map(() => p.pushMintCode("mallory", false).code);
  const alive = p.getPush("mallory", false).code;
  assert.ok(alive && alive.code === codes[3], "the newest is the live one");
  const src = fs.readFileSync(path.join(__dirname, "..", "src", "poller.js"), "utf8");
  assert.ok(src.includes("while (mine.length >= 3) pushCodes.delete(mine.shift()[0]);") && src.includes('if (pushCodes.size >= 500) return { ok: false, error: "busy" };'));
  assert.ok(src.includes('if (alertRules.length >= RULE_GLOBAL_MAX) return { ok: false, error: "full" };') && src.includes("const RULE_GLOBAL_MAX = 2000;"));
  assert.ok(src.includes('const tk = isAdmin ? "@admin" : String(owner || "");') && src.includes("pushTestAt.set(tk, now);"), "the test cooldown is keyed per caller");
});

test("-117 chat: 'alert …' and 'target …' labels are the server's alone", () => {
  const srv = fs.readFileSync(path.join(__dirname, "..", "server.js"), "utf8");
  const i0 = srv.indexOf('if (typeof b.cmd === "string") {');
  const route = srv.slice(i0, srv.indexOf("r = ACCOUNTS.send(me.uid, String(b.to", i0));
  assert.ok(/\(\?:alert\|alerts\|target\|targets\)/.test(route) && route.includes("reserved for posts the server makes"));
  // the server's own posts still carry them (they go straight to ACCOUNTS.send, never through the route)
  assert.ok(srv.includes('cmd: "alert " + ids + " fired"') && srv.includes('cmd: "target $"'));
});

test("-117 CSP reports: per-IP budget and foreign documents never reach the ledger", () => {
  const srv = fs.readFileSync(path.join(__dirname, "..", "server.js"), "utf8");
  const fn = srv.slice(srv.indexOf("function cspRecord("), srv.indexOf("// JSON destined for the inside of an inline <script>"));
  assert.ok(fn.includes("if (mine > CSP_PER_IP_MIN) { CSP_REPORTS.dropped++; continue; }") && srv.includes("const CSP_PER_IP_MIN = 10;"));
  assert.ok(fn.includes("if (h !== host) { CSP_REPORTS.foreign++; continue; }"));
  assert.ok(srv.includes("cspRecord(req.body, clientIp(req), host)"));
});
