import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import vm from "node:vm";
import ts from "typescript";

function load(file, imports = {}) {
  const slots = [];
  let cursor = 0;
  const state = initial => {
    const index = cursor++;
    if (!(index in slots)) slots[index] = typeof initial === "function" ? initial() : initial;
    return [slots[index], value => { slots[index] = typeof value === "function" ? value(slots[index]) : value; }];
  };
  const element = (type, props) => ({ type, props });
  const defaults = new Proxy({}, { get: (_, name) => name });
  const exports = {};
  const source = ts.transpileModule(fs.readFileSync(new URL(file, import.meta.url), "utf8"), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX } }).outputText;
  vm.runInNewContext(source, { exports, require(name) {
    if (name === "react/jsx-runtime") return { jsx: element, jsxs: element };
    if (name === "react") return { useState: state, useRef: initial => state(() => ({ current: initial }))[0] };
    // Shared views take useRpc from ./host-rpc, which routes to another host's copy; it behaves like the SDK's here.
    if (name === "./host-rpc") return imports["@getpaseo/plugin/client"] ?? defaults;
    return imports[name] ?? defaults;
  } });
  return { render(name, props, descend = false) {
    cursor = 0;
    const root = exports[name](props);
    return descend && root ? root.type(root.props) : root;
  } };
}
function nodes(tree) {
  if (!tree || typeof tree !== "object") return [];
  if (Array.isArray(tree)) return tree.flatMap(nodes);
  return [tree, ...nodes(tree.props?.children)];
}
const find = (tree, label) => nodes(tree).find(node => node.props?.accessibilityLabel === label || node.props?.label === label);
const plain = value => JSON.parse(JSON.stringify(value));
const flush = () => new Promise(resolve => setImmediate(resolve));

function namesFixture({ agentId, status = "online", local = "host-a", stale = false, tasks = [], agents } = {}) {
  const calls = { rename: [], workspace: [], suggestions: [], invalidations: [] };
  const renameRpc = {};
  let workspaceTitle = "Workspace";
  const client = {
    agents: { ref: id => ({ timeline: { id } }) },
    workspaces: { ref: id => ({ refresh: async () => ({ title: workspaceTitle }), setTitle: async title => { workspaceTitle = title; calls.workspace.push({ id, title }); return { title }; } }) },
  };
  const module = load("./review-names.tsx", {
    "@getpaseo/plugin/client": { getPaseoClient: () => client, useRpc: contract => contract === renameRpc ? async input => {
      calls.rename.push(plain(input));
      if (stale) throw new Error("The agent name changed since you reviewed it.");
      return { title: input.name };
    } : async () => ({ tasks }) },
    "@getpaseo/plugin/client/react-native": { Icon: "Icon", useToast: () => ({ show() {} }) },
    "@tanstack/react-query": { useQueryClient: () => ({ invalidateQueries: input => calls.invalidations.push(plain(input)) }) },
    "./app-modal": { AppModal: { Content: "ModalContent" } },
    "../shared/agent-names": { renameAgent: renameRpc }, "../shared/tasks": { listTasks: {} },
    "../shared/naming": { nameWarnings: () => [], renameConflict: (expected, current) => expected === current ? null : "The workspace name changed since review." },
    "../shared/paseo-metadata": { DELIVERY_TEXT_ROLE: "delivery-text" },
    "../shared/subagents": { groupAgents: agents => agents.map(agent => ({ agent })), flattenAgentTree: node => [{ agent: node.agent, nested: !!node.agent.parentAgentId }] },
    "./name-suggestions": { NAMER_ROLE: "name-helper", SUGGESTION_BATCH: 8, contextAgents: (agents, ids) => agents.filter(agent => ids.has(agent.id)),
      readUserMessages: async () => ["Implement the agent sidebar"], resolveNamingModel: async () => ({ label: "Configured naming model" }),
      suggestNames: async (_client, workspaceId, _model, contexts) => { calls.suggestions.push(plain({ workspaceId, contexts })); return new Map(contexts.flatMap(context => [...(context.suggest ? [[context.id, { name: "Better Workspace", reason: "Uses the workspace goal" }]] : []), ...context.agents.filter(agent => agent.suggest).map(agent => [agent.id, { name: `Better ${agent.name}`, reason: "Uses the task's goal" }])])); } },
  });
  const props = { host: { serverId: "host-a", label: "Personal", status }, taskHostId: local, workspace: { id: "workspace-a", name: "Workspace", projectName: "Project" },
    agents: agents ?? [{ id: "a", name: "Alpha" }, { id: "b", name: "Beta", parentAgentId: "a" }, { id: "helper", name: "Temporary namer", role: "name-helper" }, { id: "delivery", name: "Temporary delivery", role: "delivery-text" }], colors: {}, agentId };
  return { calls, render: (name = "RenameAgents") => module.render(name, props, true) };
}

// Daemon and model calls are recording doubles; no existing agent is renamed by these tests.
test("one-agent rename edits only that agent; Apply and Undo retain exact identity and expected name", async () => {
  const fixture = namesFixture({ agentId: "b" });
  find(fixture.render(), "Rename Beta").props.onPress();
  let tree = fixture.render();
  assert.deepEqual(nodes(tree).filter(node => node.type === "TextInput").map(node => node.props.accessibilityLabel), ["New name for Beta"]);
  assert.deepEqual(fixture.calls.rename, []);
  find(tree, "New name for Beta").props.onChangeText("Agent Sidebar");
  tree = fixture.render();
  find(tree, "Apply selected names").props.onPress();
  await flush();
  assert.deepEqual(fixture.calls.rename, [{ serverId: "host-a", agentId: "b", expected: "Beta", name: "Agent Sidebar" }]);
  assert.deepEqual(fixture.calls.workspace, []);
  assert.deepEqual(fixture.calls.invalidations, [{ queryKey: ["mission-control", "roster", "host-a"] }]);
  find(fixture.render(), "Undo rename to Beta").props.onPress();
  await flush();
  assert.deepEqual(fixture.calls.rename[1], { serverId: "host-a", agentId: "b", expected: "Agent Sidebar", name: "Beta" });
});

test("rename-all includes sub-agents, excludes internal helpers, and suggestions wait for Apply", async () => {
  const fixture = namesFixture();
  find(fixture.render(), "Rename workspace and agents in Workspace").props.onPress();
  let tree = fixture.render();
  assert.deepEqual(nodes(tree).filter(node => node.type === "TextInput").map(node => node.props.accessibilityLabel), ["New name for Workspace", "New name for Alpha", "New name for Beta"]);
  find(tree, "Suggest all names").props.onPress();
  await flush();
  tree = fixture.render();
  assert.equal(fixture.calls.suggestions.length, 1, nodes(tree).filter(node => node.props?.accessibilityRole === "alert").map(node => node.props.children).join("; "));
  assert.equal(fixture.calls.suggestions[0].contexts[0].suggest, true);
  assert.deepEqual(fixture.calls.suggestions[0].contexts[0].agents.map(agent => agent.id), ["a", "b"]);
  assert.deepEqual(fixture.calls.rename, []);
  find(tree, "Apply selected names").props.onPress();
  await flush();
  assert.deepEqual(fixture.calls.rename.map(input => input.agentId), ["a", "b"]);
  assert.deepEqual(fixture.calls.workspace, [{ id: "workspace-a", title: "Better Workspace" }]);
});

test("the top pencil can rename only the workspace and undo it, refreshing the panel heading both times", async () => {
  const fixture = namesFixture();
  find(fixture.render(), "Rename workspace and agents in Workspace").props.onPress();
  find(fixture.render(), "New name for Workspace").props.onChangeText("APP-123 · Fix Login Timeout");
  find(fixture.render(), "Apply selected names").props.onPress();
  await flush();
  assert.deepEqual(fixture.calls.workspace, [{ id: "workspace-a", title: "APP-123 · Fix Login Timeout" }]);
  assert.deepEqual(fixture.calls.rename, []);
  const headingRefreshes = () => fixture.calls.invalidations.filter(item => item.queryKey[1] === "workspace");
  assert.deepEqual(headingRefreshes(), [{ queryKey: ["mission-control", "workspace", "host-a", "workspace-a"] }]);
  find(fixture.render(), "Undo rename to Workspace").props.onPress();
  await flush();
  assert.deepEqual(fixture.calls.workspace[1], { id: "workspace-a", title: "Workspace" });
  assert.equal(headingRefreshes().length, 2);
  assert.deepEqual(fixture.calls.rename, []);
});

test("the top pencil still edits a workspace with no agents", () => {
  const fixture = namesFixture({ agents: [] });
  const trigger = find(fixture.render(), "Rename workspace and agents in Workspace");
  assert.equal(trigger.props.disabled, false);
  trigger.props.onPress();
  assert.deepEqual(nodes(fixture.render()).filter(node => node.type === "TextInput").map(node => node.props.accessibilityLabel), ["New name for Workspace"]);
});

test("offline and other-host triggers cannot open or rename agents", () => {
  for (const config of [{ status: "offline" }, { local: "other-host" }]) {
    const fixture = namesFixture(config);
    const trigger = find(fixture.render(), "Rename workspace and agents in Workspace");
    assert.equal(trigger.props.disabled, true);
    trigger.props.onPress();
    assert.equal(nodes(fixture.render()).some(node => node.props?.open === true), false);
    assert.deepEqual(fixture.calls.rename, []);
  }
});

test("a stale-name rejection is visible and does not report an undoable success", async () => {
  const fixture = namesFixture({ agentId: "a", stale: true });
  find(fixture.render(), "Rename Alpha").props.onPress();
  find(fixture.render(), "New name for Alpha").props.onChangeText("New Alpha");
  find(fixture.render(), "Apply selected names").props.onPress();
  await flush();
  const tree = fixture.render();
  assert.ok(nodes(tree).some(node => node.props?.accessibilityRole === "alert" && String(node.props.children).includes("The agent name changed since you reviewed it.")));
  assert.equal(find(tree, "Undo rename to Alpha"), undefined);
});

test("workspace suggestions receive linked tracker identity along with task titles", async () => {
  const fixture = namesFixture({ tasks: [
    { title: "Fix Login", status: "ready", ticket: { system: "jira", key: "APP-123", url: "https://tracker.example/APP-123" } },
    { title: "Update Export", status: "ready", ticket: { system: "azure-devops", key: "12345", url: "https://tracker.example/12345" } },
    { title: "Manual work", status: "ready", ticket: null },
  ] });
  find(fixture.render("ReviewNames"), "Review names in Workspace").props.onPress();
  find(fixture.render("ReviewNames"), "Suggest all names").props.onPress();
  await flush();
  assert.deepEqual(fixture.calls.suggestions[0].contexts[0].tasks, [
    { title: "Fix Login", status: "ready", ticket: { system: "jira", key: "APP-123" } },
    { title: "Update Export", status: "ready", ticket: { system: "azure-devops", key: "12345" } },
    { title: "Manual work", status: "ready", ticket: null },
  ]);
  assert.deepEqual(fixture.calls.rename, []);
  assert.deepEqual(fixture.calls.workspace, []);
});

test("existing Review names still includes the workspace and its agents", () => {
  const fixture = namesFixture();
  find(fixture.render("ReviewNames"), "Review names in Workspace").props.onPress();
  assert.deepEqual(nodes(fixture.render("ReviewNames")).filter(node => node.type === "TextInput").map(node => node.props.accessibilityLabel), ["New name for Workspace", "New name for Alpha", "New name for Beta"]);
});

test("refresh icons retain their accessible name, tooltip and callback including during loading", () => {
  const module = load("./compact-link.tsx", { "react-native": { Platform: { OS: "web" }, Pressable: "Pressable", Text: "Text", View: "View" } });
  let presses = 0;
  for (const label of ["Refresh", "Refresh counts", "Refreshing…"]) {
    const tree = module.render("CompactLink", { label, accessibilityLabel: "Refresh agents", colors: {}, onPress: () => presses++ });
    assert.equal(tree.props.accessibilityLabel, "Refresh agents");
    assert.equal(tree.props.title, "Refresh agents");
    assert.equal(nodes(tree).some(node => node.type === "Text"), false);
    tree.props.onPress();
  }
  assert.equal(presses, 3);
  assert.ok(nodes(module.render("CompactLink", { label: "Open Agents", colors: {}, onPress() {} })).some(node => node.type === "Text"));
});
