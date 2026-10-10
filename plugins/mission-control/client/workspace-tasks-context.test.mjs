import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import ts from "typescript";

function loadEditor(workspacePanel = false) {
  const workspace = { projectId: "project-a", title: "Workspace A", status: "idle" };
  const element = (type, props) => ({ type, props });
  const state = initial => [typeof initial === "function" ? initial() : initial, () => {}];
  const sdk = {
    useWorkspace: (_id, select) => {
      if (!workspacePanel) throw new Error("Plugin state hooks must run inside a workspace panel");
      return select(workspace);
    },
    useHosts: () => [{ serverId: "host-a", status: "online" }],
    useRpc: () => async () => ({}),
  };
  const defaults = new Proxy({}, { get: (_target, name) => {
    if (name === "usePageState") return (_key, initial) => state(initial);
    if (name === "pageKey") return (...parts) => parts.join(":");
    if (name === "useRoster") return () => ({ data: undefined });
    if (name === "useHelpers") return () => [];
    if (name === "useTaskTitles") return () => ({});
    return () => null;
  } });
  const source = fs.readFileSync(new URL("./workspace-tasks.tsx", import.meta.url), "utf8");
  const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX } }).outputText;
  const exports = {};
  vm.runInNewContext(compiled, { exports, require: name => {
    if (name === "react/jsx-runtime") return { jsx: element, jsxs: element };
    if (name === "react") return { useState: state };
    if (name === "@getpaseo/plugin/client") return sdk;
    if (name === "@tanstack/react-query") return { useQueryClient: () => ({}), useQuery: () => ({ data: { tasks: [] }, refetch: async () => {} }) };
    return defaults;
  } });
  return exports;
}

const props = { theme: { colors: {} }, host: { id: "host-a", label: "Host A" }, layout: { compact: false }, workspaceId: "workspace-a", workspaceName: "Workspace A", projectName: "Project A", workspaceStatus: "idle", projectId: "project-a" };

test("surface task editor renders without calling workspace-panel-only hooks", () => {
  const { MissionTasksEditor } = loadEditor();
  assert.ok(MissionTasksEditor({ ...props, embedded: true }));
});

test("workspace panel forwards its project ID to the shared task editor", () => {
  const { WorkspaceTasks } = loadEditor(true);
  const editor = WorkspaceTasks(props);
  assert.equal(editor.props.projectId, "project-a");
});
