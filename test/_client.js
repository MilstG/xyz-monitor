"use strict";
// The client is ES modules under public/js (build 2026.09.16-80). Tests that read "the client
// source" — to pin a string, grab a function body, or EXECUTE the whole client in a sandbox — get
// the concatenation of every module in load order plus the entry, with the module syntax removed:
// imports and export lists dropped, `export function __boot_*` made plain. What remains is exactly
// what the single app.js used to be: every declaration in one scope, then the boot statements in
// their original order (the entry's calls come last), under "use strict".
const fs = require("fs"), path = require("path");
const CLIENT_MODULES = ["core", "base", "data", "markets", "corr", "drawer", "prefs", "alerts", "admin", "positioning", "backtest", "charts",
  "triggers", "actionable", "calendar", "notes", "trend", "sectors", "share", "nav", "terminal", "report", "focus", "funds", "insiders", "messages", "access"];
function declassify(js) {
  return js.split("\n").filter((l) => !/^import (\{[^}]*\} from )?"\.\/(js\/)?[a-z]+\.js";$/.test(l) && !/^export \{ [^}]* \};$/.test(l))
    .map((l) => l.replace(/^export function __boot_/, "function __boot_")).join("\n");
}
let memo = null;
function clientSource() {
  if (memo) return memo;
  const parts = CLIENT_MODULES.map((m) => declassify(fs.readFileSync(path.join(__dirname, "..", "public", "js", m + ".js"), "utf8")));
  parts.push(declassify(fs.readFileSync(path.join(__dirname, "..", "public", "app.js"), "utf8")));
  return (memo = '"use strict";\n' + parts.join("\n"));
}
module.exports = { clientSource, CLIENT_MODULES, declassify };
