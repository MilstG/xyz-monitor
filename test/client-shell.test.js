"use strict";
// The shell and the scale (build 2026.09.23-93): one row of chrome, one meta line, one control
// base, and the tokens that are the ONLY sizes the site may use. These pins are what keeps the
// scale from drifting back a tab at a time — which is exactly how it drifted out.
const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs"), path = require("path");
const read = (...p) => fs.readFileSync(path.join(__dirname, "..", ...p), "utf8");

test("scale: the tokens exist, and no rule or renderer names a literal size or radius any more", () => {
  const css = read("public", "styles.css");
  for (const t of ["--fs-2xs:10px", "--fs-xs:11px", "--fs-sm:12px", "--fs-md:13px", "--fs-lg:15px", "--fs-xl:20px", "--sp-1:4px", "--sp-2:8px", "--sp-3:12px", "--sp-4:20px", "--r-1:4px", "--r-2:7px", "--r-3:10px", "--ctl-h:28px"])
    assert.ok(css.includes(t), `token missing from :root: ${t}`);
  // font sizes: only the tokens. font-size:0 (a hide) is the one literal allowed.
  const lits = css.match(/font-size:\d*\.?\d+px/g) || [];
  assert.deepEqual(lits.filter((x) => x !== "font-size:0px"), [], "styles.css names a literal font size — use a --fs-* token");
  assert.deepEqual(css.match(/font:\d*\.?\d+px /g) || [], [], "styles.css uses the font shorthand with a literal size");
  // radii: 2–12px map onto the three tokens; pills (≥13px) and 50% stay literal on purpose.
  const radii = (css.match(/border-radius:[^;}!]+/g) || []).flatMap((v) => v.match(/\b(\d+)px/g) || []).map((x) => parseInt(x, 10)).filter((n) => n >= 2 && n <= 12);
  assert.deepEqual(radii, [], "styles.css names a literal radius in the token range — use --r-1/2/3");
  // the client: every inline size is a token too (computed sizes like ${sizePx}px are not literals)
  for (const f of fs.readdirSync(path.join(__dirname, "..", "public", "js")).filter((f) => f.endsWith(".js"))) {
    const js = read("public", "js", f);
    assert.deepEqual(js.match(/font-size:\d*\.?\d+px/g) || [], [], `${f} hard-codes a font size inline — use a --fs-* token`);
  }
  const html = read("public", "index.html");
  assert.deepEqual(html.match(/font-size:\d*\.?\d+px/g) || [], [], "index.html hard-codes a font size inline");
});

test("shell: one row of chrome (mark · nav · scope · session), one meta line, the regime strip inside Markets", () => {
  const html = read("public", "index.html"), css = read("public", "styles.css");
  const header = html.match(/<header>[\s\S]*?<\/header>/);
  assert.ok(header, "header missing");
  assert.ok(/<nav class="tabs"/.test(header[0]), "the nav lives inside the header row");
  assert.ok(!/class="sub"/.test(header[0]) && !/<div class="stats">/.test(header[0]), "the tagline and the header stats left the header");
  assert.ok(/<div class="statusline">\s*<span class="stats">/.test(html), "the three stats open the meta line");
  assert.ok(/header\{[^}]*height:44px/.test(css), "the shell row is 44px");
  assert.ok(/\.wordmark\{[^}]*font-size:var\(--fs-lg\)/.test(css), "the mark is a mark, not a 30px wordmark");
  // DOM order untouched (scope first, spacer, buttons) — the visual order is CSS order
  const nav = header[0].match(/<nav class="tabs"[\s\S]*?<\/nav>/)[0];
  assert.ok(nav.indexOf('class="scopeseg"') < nav.indexOf('data-view="markets"') && nav.indexOf('id="tabSpacer"') < nav.indexOf('id="helpBtn"'), "nav DOM order is unchanged");
  assert.ok(css.includes(".tabs .tabspacer{order:1}") && css.includes(".tabs .scopeseg{order:2}") && css.includes(".tabs .tabbtn{order:3}"), "tabs · spacer · scope · buttons is CSS order");
  assert.ok(/<div id="view-markets">\s*<div class="regimestrip" id="regime" hidden>/.test(html), "the regime strip is the first line of Markets, not site chrome");
  assert.ok(!/<\/nav>\s*<div class="macrostrip"[^>]*>\s*<div class="regimestrip"/.test(html), "…and no longer sits under the nav");
});

test("controls: one base (.btn and .seg share height, radius, size), every family mapped, rows in zones", () => {
  const css = read("public", "styles.css"), html = read("public", "index.html");
  assert.ok(/\.btn\{[^}]*min-height:var\(--ctl-h\)[^}]*border-radius:var\(--r-2\)/.test(css), ".btn on the base");
  assert.ok(/\.seg\{[^}]*border-radius:var\(--r-2\)[^}]*min-height:var\(--ctl-h\)/.test(css), ".seg on the base");
  assert.ok(/\.seg button\{[^}]*height:calc\(var\(--ctl-h\) - 6px\)/.test(css), "segment buttons fill the base");
  assert.ok(css.includes("ONE CONTROL BASE, EVERY TAB"), "the unification block exists");
  const block = css.slice(css.indexOf("ONE CONTROL BASE, EVERY TAB"));
  for (const fam of [".clockseg", ".cdtf-seg", ".focch-tf", ".cg-seg", ".chseg", ".chtfs", ".adm-seg", ".cg-pill", ".tma-chip", ".whl-btn", ".nt-btn", ".clocksel", ".chtb>button", ".chip", ".cg-chip", ".sig-chip", ".tagchip", ".drillchip", ".s-ctrls", ".cg-ctrls", ".rt-ctrls"])
    assert.ok(block.includes(fam), `family not mapped onto the base: ${fam}`);
  assert.ok(block.indexOf(".s-ctrls,.cg-ctrls,.rt-ctrls") > 0 && css.lastIndexOf(".s-ctrls{") < css.indexOf("ONE CONTROL BASE"), "the block sits after the family rules, so it wins at equal specificity");
  // zones: what · cut · actions on every static row that has a cut or an action
  assert.ok(css.includes('.controls .zone.cut::before{content:"";width:1px') && css.includes(".controls .zone.act{margin-left:auto}"), "zone rules");
  for (const id of ["grpseg", "sectgrp", "corrn", "corrtop"]) {
    const i = html.indexOf(`id="${id}"`);
    assert.ok(html.lastIndexOf('<div class="zone cut">', i) > html.lastIndexOf('<div class="controls"', i), `${id} sits in a cut zone`);
  }
  for (const id of ["mktExport", "sectExport", "corrExport", "rvd-csv", "act-sortreset"]) {
    const src = id === "rvd-csv" ? read("public", "js", "drawdown.js") : html;
    const i = src.indexOf(`id="${id}"`);
    assert.ok(src.lastIndexOf('class="zone act"', i) > src.lastIndexOf('class="controls"', i) || src.lastIndexOf('<div class="zone act">', i) > src.lastIndexOf('class="controls"', i), `${id} sits in the actions zone`);
  }
  assert.ok(!html.includes('id="refresh" style="margin-left:auto"') && !html.includes('id="sectExport" title="Download the sector board as CSV" style="margin-left:auto"'), "no per-button right-floats: the actions zone does it");
});
