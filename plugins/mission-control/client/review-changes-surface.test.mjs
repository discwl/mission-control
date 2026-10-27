import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import vm from "node:vm";
import * as model from "./review-changes-model.ts";
const require = createRequire(import.meta.url); const ts = require("typescript");
const identity = "exact-host/workspace/task";
const snapshot = fingerprint => ({ fingerprint, generatedAt: "2026-10-27T00:00:00Z", repoRoot: "repo", branch: "task", head: "head", base: "head", fromCommit: null, sinceCommit: null, omittedFiles: 0, baseWarning: null, files: [{ path: "a.ts", oldPath: null, change: "modified", reviewIds: [fingerprint], additions: 1, deletions: 0, truncated: false }] });
function harness(storage = new Map()) {
  const states = []; let cursor = 0; const pages = new Map(); const filters = []; const effects = [];
  const module = { exports: {} }; const jsx = (type, props) => ({ type, props });
  const source = ts.transpileModule(readFileSync(new URL("./review-changes.tsx", import.meta.url), "utf8"), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX } }).outputText;
  const dependencies = {
    react: { useState: initial => { const index = cursor++; if (!(index in states)) states[index] = typeof initial === "function" ? initial() : initial; return [states[index], value => { states[index] = typeof value === "function" ? value(states[index]) : value; }]; }, useEffect: effect => effects.push(effect) },
    "react/jsx-runtime": { jsx, jsxs: jsx }, "react-native": { Text: "Text", View: "View" },
    "./page-state": { usePageState: (key, initial) => { if (!pages.has(key)) pages.set(key, initial); return [pages.get(key), value => pages.set(key, value)]; } },
    "./compact-link": { CompactLink: "Link" }, "./date-time": { formatDateTime: value => value }, "./review-changes-model": model,
    "./web": { readClientStorage: key => storage.get(key) ?? null, writeClientStorage: (key, value) => storage.set(key, value) },
  };
  new vm.Script(source).runInNewContext({ module, exports: module.exports, JSON, require: name => dependencies[name] ?? {} });
  return { storage, filters, render(value, stale = false) { cursor = 0; effects.length = 0; const tree = module.exports.ReviewChanges({ identity, snapshot: value, stale, colors: {}, onSelect: () => {}, onFilter: paths => filters.push(paths) }); for (const effect of effects) effect(); return tree; } };
}
function links(node) { if (!node || typeof node !== "object") return []; if (Array.isArray(node)) return node.flatMap(links); return [...(node.type === "Link" ? [node] : []), ...links(node.props?.children)]; }
const stored = h => JSON.parse([...h.storage.values()][0] ?? "[]")[0];
test("refresh and a panel remount cannot advance a review checkpoint; only its explicit action can", () => {
  const h = harness(); h.render(snapshot("first")); h.render(snapshot("second"));
  assert.equal(stored(h).fingerprint, "first");
  const reopened = harness(h.storage); let tree = reopened.render(snapshot("second"));
  assert.equal(stored(reopened).fingerprint, "first");
  links(tree).find(node => node.props.label === "Changes since review checkpoint").props.onPress();
  tree = reopened.render(snapshot("second"));
  links(tree).find(node => node.props.label === "Save review checkpoint").props.onPress();
  assert.equal(stored(reopened).fingerprint, "second");
});
test("an offline or stale first snapshot never establishes a checkpoint", () => {
  const h = harness(); h.render(snapshot("stale"), true);
  assert.equal(h.storage.size, 0);
  h.render(snapshot("current"), false);
  assert.equal(stored(h).fingerprint, "current");
});
test("changed-file filtering is explicit and retains the full review when scope becomes incomparable", () => {
  const h = harness(); h.render(snapshot("first")); let tree = h.render(snapshot("changed"));
  links(tree).find(node => node.props.label === "Show changed files").props.onPress();
  h.render(snapshot("changed"));
  assert.deepEqual(Array.from(h.filters.at(-1)), ["a.ts"]);
  h.render({ ...snapshot("changed"), branch: "different" });
  assert.equal(h.filters.at(-1), null);
});
