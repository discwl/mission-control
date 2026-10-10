import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { test } from "node:test";
const require = createRequire(import.meta.url), ts = require("typescript");
const jsx = (type, props) => ({ type, props });
const query = data => ({ data, isSuccess: true, isPending: false, isError: false });
const colors = { foreground: "fg", foregroundMuted: "muted", border: "border", surface0: "surface" };
const props = { theme: { colors }, host: { id: "test-host", label: "Test host" }, workspaceId: "test-workspace", navigation: {}, layout: { compact: false } };
function render(file, exportName) {
  const imports = {
    "react": { useState: initial => [typeof initial === "function" ? initial() : initial, () => {}], useRef: initial => ({ current: initial }) },
    "react/jsx-runtime": { jsx, jsxs: jsx, Fragment: "Fragment" }, "react-native": { View: "View", Text: "Text", ScrollView: "ScrollView" },
    "@getpaseo/plugin/client": { useHosts: () => [{ serverId: props.host.id, status: "online" }], useRpc: () => () => { throw new Error("No RPC should run while rendering a heading"); }, useSettings: () => ({ status: "ready", values: { missionSectionOrder: ["agents"] }, revision: "test-revision", saving: false }) },
    "@tanstack/react-query": { useQueries: () => [], useQuery: options => {
      if (options.queryKey.includes("workspace")) return query({ id: props.workspaceId, title: "Test workspace" });
      if (options.queryKey.includes("mission-summary")) return query({ serverId: props.host.id });
      if (options.queryKey.includes("mission-agents")) return query([]);
      if (options.queryKey.includes("tasks")) return query({ tasks: [] });
      if (options.queryKey.includes("review-counts")) return query({ counts: {} });
      throw new Error(`Unexpected query ${options.queryKey}`);
    } },
    "./compact-link": { CompactLink: "CompactLink" }, "./agent-tree": { AgentTree: "AgentTree", treeSummaryLine: () => "0 agents" },
    "./app-modal": { AppModal: Object.assign("Modal", { Content: "ModalContent" }) }, "./copy-task-id": { CopyTaskId: "CopyTaskId" }, "./breadcrumbs": { Breadcrumbs: "Breadcrumbs" }, "./project-git": { ProjectGit: "ProjectGit" }, "./task-flow": { TaskFlowSummary: "TaskFlowSummary", TaskFlowDetail: "TaskFlowDetail" },
    "../shared/preferences": { missionPreferences: {} }, "../shared/mission-sections": { missionSections: ["agents"], missionSectionLabels: { agents: "Agents" }, normalizeMissionSections: () => ["agents"] },
    "../shared/mission": { getMissionSummary: {} }, "../shared/review": { getReviewCounts: {} }, "../shared/runs": { listTaskRuns: {} }, "../shared/tasks": { listTasks: {} },
    "./date-time": {}, "./decision-card": { DecisionCard: "DecisionCard" }, "./attention-card": { useWaiting: () => query({ questions: [] }), WaitingCardView: "WaitingCard" }, "./attention-model": { waitingCards: () => [] }, "./needs-you": { useDecisions: () => query({ open: [] }) },
    "./permissions": { PermissionCard: "PermissionCard" }, "./plugin-client": { pluginClient: () => null }, "./review-comments": { useReviewComments: () => ({ comments: [] }) }, "./panel-ids": {}, "./roster": { useRoster: () => query({ agents: [] }), agentsForTask: () => [] },
    "../shared/subagents": {}, "../shared/agents-panel": {}, "./subagents": { useHelpers: () => [], useTaskTitles: () => ({}) },
  };
  const code = ts.transpileModule(readFileSync(new URL(file, import.meta.url), "utf8"), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX } }).outputText;
  const module = { exports: {} };
  new Function("require", "module", "exports", code)(id => { if (id in imports) return imports[id]; throw new Error(`Unexpected import ${id}`); }, module, module.exports);
  return module.exports[exportName](props);
}
function nodes(root) {
  const result = [];
  const walk = node => { if (!node || typeof node !== "object") return; if (Array.isArray(node)) return node.forEach(walk); result.push(node); walk(node.props?.children); };
  walk(root); return result;
}
for (const [file, exportName] of [["./mission-panel.tsx", "MissionPanel"], ["./agents-panel.tsx", "AgentsPanel"]]) {
  test(`${exportName} includes the shared pencil/broom controls beside refresh`, () => {
    const tree = nodes(render(file, exportName)).find(node => node.type === "AgentTree"); assert.ok(tree);
    const controls = jsx("SyntheticPencilAndBroom", {}), refreshed = [];
    const heading = nodes(tree.props.heading({ agents: 0 }, { renameAll: controls, refreshing: false, refresh: () => refreshed.push(true) }));
    assert.ok(heading.includes(controls), "shared cleanup controls must not be discarded by the parent heading");
    const refresh = heading.find(node => node.type === "CompactLink" && node.props.label === "Refresh"); assert.ok(refresh);
    refresh.props.onPress(); assert.deepEqual(refreshed, [true]);
    const busyHeading = nodes(tree.props.heading({ agents: 0 }, { renameAll: controls, refreshing: true, refresh: () => {} }));
    assert.equal(busyHeading.find(node => node.type === "CompactLink" && node.props.label.startsWith("Refreshing")).props.disabled, true);
  });
}

test("the workspace page forwards its shared controls and lets the heading wrap", () => {
  const text = readFileSync(new URL("./mission-control.tsx", import.meta.url), "utf8");
  const source = ts.createSourceFile("mission-control.tsx", text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  let callback;
  function find(node) {
    if (ts.isJsxSelfClosingElement(node) && node.tagName.getText(source) === "AgentTree") {
      const attribute = node.attributes.properties.find(item => ts.isJsxAttribute(item) && item.name.getText(source) === "heading");
      if (attribute && ts.isJsxExpression(attribute.initializer)) callback = attribute.initializer.expression.getText(source);
    }
    ts.forEachChild(node, find);
  }
  find(source); assert.ok(callback);
  // Execute the actual JSX callback with its parent bindings, without launching other page queries.
  const code = ts.transpileModule(`export const heading = ${callback};`, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX } }).outputText;
  const module = { exports: {} };
  new Function("require", "module", "exports", "View", "Text", "CompactLink", "InfoTip", "colors", "treeSummaryLine", "agentsHeadingWidth", "setAgentsHeadingWidth", code)(id => { assert.equal(id, "react/jsx-runtime"); return { jsx, jsxs: jsx }; }, module, module.exports, "View", "Text", "CompactLink", "InfoTip", colors, () => "0 agents", 390, () => {});
  const controls = jsx("SyntheticPencilAndBroom", {}), refreshed = [];
  const heading = nodes(module.exports.heading({ agents: 0 }, { renameAll: controls, refreshing: false, refresh: () => refreshed.push(true) }));
  assert.ok(heading.includes(controls)); assert.ok(heading.some(node => node.props?.style?.flexWrap === "wrap"));
  const refresh = heading.find(node => node.type === "CompactLink" && node.props.accessibilityLabel === "Refresh agents");
  refresh.props.onPress(); assert.deepEqual(refreshed, [true]);
});
