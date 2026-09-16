"use strict";
// Flat config. Three worlds share this repo: the Node server (CommonJS), the browser client (a
// classic script until the module split lands, then ES modules) and the service worker. Each gets
// its own globals so `no-undef` means something in all three.
const js = require("@eslint/js");
const globals = require("globals");

const shared = {
  // The codebase's idiom is `try { ... } catch (_) {}` — an empty catch is a decision, not an
  // accident — so the rule keeps its teeth everywhere except there.
  "no-empty": ["error", { allowEmptyCatch: true }],
  "no-unused-vars": ["warn", { args: "none", caughtErrors: "none", varsIgnorePattern: "^_" }],
  "no-cond-assign": ["error", "except-parens"],
  // Dead stores are worth a look, not a red build: most here are `let x = null` defaults.
  "no-useless-assignment": "warn",
  // Test regexes match literal runs of spaces in rendered text on purpose.
  "no-regex-spaces": "off",
  "no-useless-escape": "off",
  "no-control-regex": "off",
  "no-prototype-builtins": "off",
  "no-inner-declarations": "off",
};

module.exports = [
  { ignores: ["node_modules/**", "data/**", "docs/**", "public/vendor/**"] },
  js.configs.recommended,
  {
    files: ["server.js", "src/**/*.js", "test/**/*.js", "eslint.config.js", "scripts/**/*.js"],
    languageOptions: { ecmaVersion: 2024, sourceType: "commonjs", globals: { ...globals.node } },
    rules: shared,
  },
  {
    files: ["public/**/*.js"],
    ignores: ["public/sw.js"],
    languageOptions: { ecmaVersion: 2024, sourceType: "script", globals: { ...globals.browser } },
    rules: shared,
  },
  {
    files: ["public/sw.js"],
    languageOptions: { ecmaVersion: 2024, sourceType: "script", globals: { ...globals.serviceworker } },
    rules: shared,
  },
];
