"use strict";
// usage-controls.js — the server's copy of the usage control ALLOWLIST (build 2026.09.24-112).
//
// There is exactly one list: the US_CONTROLS table in public/js/usage.js, the browser module that
// counts the controls. It sits there between two marker comments as strict JSON, and this module
// reads that very text once at boot and parses it — so the browser and the server can never disagree
// about which control keys exist (test/usage-112.test.js pins the parity, and pins the Markets column
// ids against base.js COLS). Shape: { group: { control: [value, ...] } } where a group is a tab id (or
// the two pseudo-groups 'header' = the controls above every tab, 'drawer' = the ticker drawer), and
// an empty value list means the control has no value. Keys: '<group>.<control>' or
// '<group>.<control>=<value>'. Anything that fails to parse or fails the shape check yields an EMPTY
// allowlist: the beacon's control counts are then all dropped (fail closed), and the reason is kept.
const fs = require("fs");
const path = require("path");

const BEGIN = "/*US_CONTROLS{*/", END = "/*}US_CONTROLS*/";
const ID_RE = /^[a-z][a-z0-9-]{0,23}$/, VAL_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,23}$/;

function usageCtlParse(text) {
  const s = String(text || "");
  const a = s.indexOf(BEGIN), b = s.indexOf(END, a + 1);
  if (a < 0 || b < 0) return { table: {}, keys: new Set(), error: "markers not found" };
  let t;
  try { t = JSON.parse(s.slice(a + BEGIN.length, b)); } catch (e) { return { table: {}, keys: new Set(), error: "bad json: " + (e && e.message) }; }
  if (!t || typeof t !== "object" || Array.isArray(t)) return { table: {}, keys: new Set(), error: "not an object" };
  const table = {}, keys = new Set();
  for (const [g, ctrls] of Object.entries(t)) {
    if (!ID_RE.test(g) || !ctrls || typeof ctrls !== "object" || Array.isArray(ctrls)) return { table: {}, keys: new Set(), error: "bad group " + g };
    table[g] = {};
    for (const [c, vals] of Object.entries(ctrls)) {
      if (!ID_RE.test(c) || !Array.isArray(vals) || vals.some((v) => typeof v !== "string" || !VAL_RE.test(v)))
        return { table: {}, keys: new Set(), error: "bad control " + g + "." + c };
      table[g][c] = vals.slice();
      if (!vals.length) keys.add(g + "." + c); else for (const v of vals) keys.add(g + "." + c + "=" + v);
    }
  }
  return { table, keys, error: null };
}

let memo = null;
function usageControls() {
  if (memo) return memo;
  let text = "";
  try { text = fs.readFileSync(path.join(__dirname, "..", "public", "js", "usage.js"), "utf8"); } catch (_) {}
  memo = usageCtlParse(text);
  return memo;
}

module.exports = { usageControls, usageCtlParse, USAGE_CTL_BEGIN: BEGIN, USAGE_CTL_END: END };
