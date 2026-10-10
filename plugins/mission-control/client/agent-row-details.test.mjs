import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import vm from "node:vm";
import ts from "typescript";

const element = (type, props) => ({ type, props });
const exports = {};
const defaults = new Proxy({}, { get: (_, name) => name });
const source = ts.transpileModule(fs.readFileSync(new URL("./agent-tree.tsx", import.meta.url), "utf8"), {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX },
}).outputText;
vm.runInNewContext(`${source}\nexports.AgentMetadata = AgentMetadata; exports.AgentStateLabel = AgentStateLabel;`, {
  exports, require(name) {
    if (name === "react/jsx-runtime") return { jsx: element, jsxs: element };
    if (name === "../shared/agent-tree") return { AGENT_STATE_LABELS: { working: "Working", ready: "Ready", idle: "Idle", failed: "Failed", "needs-input": "Needs input", closed: "Closed" } };
    return defaults;
  },
});
function nodes(tree) {
  if (!tree || typeof tree !== "object") return [];
  if (Array.isArray(tree)) return tree.flatMap(nodes);
  return [tree, ...nodes(tree.props?.children)];
}
function text(value) {
  if (Array.isArray(value)) return value.map(text).join("");
  if (typeof value === "string" || typeof value === "number") return String(value);
  return value?.props ? text(value.props.children) : "";
}
const colors = { foreground: "neutral", foregroundMuted: "muted", accent: "accent", statusSuccess: "green" };
const agent = { provider: "codex", model: "test-model", reasoningLevel: "Extra high", workspaceId: "current" };
const metadata = changes => exports.AgentMetadata({ agent: { ...agent, ...changes }, workspaceId: "current", workspaceNames: new Map([["current", "Mission Control"], ["other", "Other Project"]]), colors });

test("current workspace metadata shows the model and reasoning without repeating its workspace", () => {
  const tree = metadata({});
  assert.match(text(tree), /codex\/test-model· Extra high/);
  assert.doesNotMatch(text(tree), /Mission Control|Elsewhere/);
  assert.ok(nodes(tree).some(node => node.props?.accessibilityLabel === "Reasoning level: Extra high"));
});

test("cross-workspace agents keep their location and unknown reasoning stays absent", () => {
  assert.match(text(metadata({ workspaceId: "other" })), /Elsewhere: Other Project/);
  assert.match(text(metadata({ workspaceId: "unlisted" })), /Elsewhere/);
  assert.match(text(metadata({ workspaceId: null })), /No workspace/);
  assert.equal(text(metadata({ reasoningLevel: null })), "codex/test-model");
});

test("Working animates in the theme accent and Ready has a success checkmark", () => {
  const working = exports.AgentStateLabel({ state: "working", colors, online: true });
  assert.equal(working.props.accessibilityState.busy, true);
  assert.ok(nodes(working).some(node => node.type === "ActivityIndicator" && node.props.color === colors.accent));
  assert.equal(text(working), "Working");
  const ready = exports.AgentStateLabel({ state: "ready", colors, online: true });
  assert.equal(ready.props.accessibilityState.busy, false);
  assert.ok(nodes(ready).some(node => node.type === "Icon" && node.props.name === "Check" && node.props.color === colors.statusSuccess));
  assert.equal(nodes(ready).some(node => node.type === "ActivityIndicator"), false);
  assert.equal(text(ready), "Ready");
});

test("offline snapshots, context parents and idle agents do not imply live work", () => {
  for (const props of [{ state: "working", online: false }, { state: "working", online: true, contextOnly: true }, { state: "idle", online: true }]) {
    const tree = exports.AgentStateLabel({ ...props, colors });
    assert.equal(tree.props.accessibilityState.busy, false);
    assert.equal(nodes(tree).some(node => node.type === "ActivityIndicator" || node.props?.name === "Check"), false);
    if (props.contextOnly) assert.equal(text(tree), "Context");
  }
});
