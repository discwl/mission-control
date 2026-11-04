import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import ts from "typescript";

function render(warnings) {
  const query = {
    data: { hosts: [], warnings, observedAt: "2026-11-04T08:00:00Z" },
    tasks: [], now: Date.parse("2026-11-04T08:00:00Z"),
    isPending: false, isError: false, isFetching: false, refetch() {},
  };
  const jsx = (type, props) => ({ type, props: props ?? {} });
  const dependencies = {
    react: { useState: initial => [initial, () => {}] },
    "react/jsx-runtime": { jsx, jsxs: jsx, Fragment: "Fragment" },
    "react-native": { View: "View", Text: "Text", TextInput: "TextInput", ScrollView: "ScrollView" },
    "./kanban-data": { useKanbanData: () => query },
    "./needs-you-model": { attentionTasks: () => [], attentionSections: [] },
    "./date-time": { formatDateTime: value => value },
  };
  const source = fs.readFileSync(new URL("./mission-control-v2.tsx", import.meta.url), "utf8");
  const code = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX, target: ts.ScriptTarget.ES2022 } }).outputText;
  const module = { exports: {} };
  new Function("require", "exports", "module", code)(name => dependencies[name] ?? new Proxy({}, { get: (_, key) => String(key) }), module.exports, module);
  return module.exports.MissionControlV2({ theme: { colors: {} }, host: { id: "local" }, layout: { compact: true }, navigation: {} });
}

function visibleText(node) {
  if (node == null || typeof node === "boolean") return "";
  if (Array.isArray(node)) return node.map(visibleText).join(" ");
  if (typeof node !== "object") return String(node);
  return visibleText(node.props?.children);
}

test("Needs you visibly reports missing-host and truncated-roster warnings even with no host rows", () => {
  for (const warning of ["CNS coordinator binding could not be resolved.", "The coordinator roster was truncated; more hosts may exist."]) {
    const text = visibleText(render([warning]));
    assert.match(text, /Some tasks could not be checked/);
    assert.match(text, /Hosts that need checking/);
    assert.match(text, /Some hosts or tasks may be missing from this view/);
    assert.ok(text.includes(warning), "the warning is visible without opening technical details");
    assert.doesNotMatch(text, /No tasks need you right now/);
  }
});

test("Needs you retains its clear state when the empty fleet has no warnings", () => {
  const text = visibleText(render([]));
  assert.match(text, /No tasks need you right now/);
  assert.doesNotMatch(text, /Hosts that need checking/);
});
