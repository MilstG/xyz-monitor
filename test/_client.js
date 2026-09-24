"use strict";
// The client is ES modules under public/js (build 2026.09.16-80). Tests that read "the client
// source" — to pin a string, grab a function body, or EXECUTE the whole client in a sandbox — get
// the concatenation of every module in load order plus the entry, with the module syntax removed:
// imports and export lists dropped, `export function __boot_*` made plain. What remains is exactly
// what the single app.js used to be: every declaration in one scope, then the boot statements in
// their original order (the entry's calls come last), under "use strict".
const fs = require("fs"), path = require("path");
const CLIENT_MODULES = ["core", "base", "data", "markets", "corr", "drawer", "prefs", "alerts", "admin", "positioning", "backtest", "charts",
  "triggers", "actionable", "calendar", "notes", "trend", "sectors", "drawdown", "retest", "share", "nav", "terminal", "report", "focus", "funds", "insiders", "messages", "access", "usage", "usageadm"];
function declassify(js) {
  return js.split("\n").filter((l) => !/^import (\{[^}]*\} from )?"\.\/(js\/)?[a-z]+\.js";$/.test(l) && !/^export \{ [^}]* \};$/.test(l))
    .map((l) => l.replace(/^export function __boot_/, "function __boot_")).join("\n");
}
let memo = null;
// Tab-only modules the entry no longer imports (build 2026.09.24-103): in the browser core.js
// lazyCall() imports one on first use and runs its __boot_* functions then. The sandbox holds every
// module already, so it models the fully-loaded session: those boots run after the entry's own,
// in the same name order lazyMod uses. Derived from core.js's LAZY_IMPORTERS, never a second list.
function lazyModules() {
  const core = fs.readFileSync(path.join(__dirname, "..", "public", "js", "core.js"), "utf8");
  const blk = core.slice(core.indexOf("const LAZY_IMPORTERS={"), core.indexOf("};", core.indexOf("const LAZY_IMPORTERS={")));
  return [...blk.matchAll(/([a-z]+):\(\)=>import\("\.\/([a-z]+)\.js"\)/g)].map((m) => m[2]);
}
function clientSource() {
  if (memo) return memo;
  const parts = CLIENT_MODULES.map((m) => declassify(fs.readFileSync(path.join(__dirname, "..", "public", "js", m + ".js"), "utf8")));
  parts.push(declassify(fs.readFileSync(path.join(__dirname, "..", "public", "app.js"), "utf8")));
  const boots = [];
  for (const m of lazyModules()) {
    const src = fs.readFileSync(path.join(__dirname, "..", "public", "js", m + ".js"), "utf8");
    for (const b of [...src.matchAll(/^export function (__boot_[a-z0-9_]+)\(/gm)].map((x) => x[1]).sort()) boots.push(b + "();");
  }
  parts.push(boots.join("\n"));
  return (memo = '"use strict";\n' + parts.join("\n"));
}
module.exports = { clientSource, CLIENT_MODULES, declassify, lazyModules };
