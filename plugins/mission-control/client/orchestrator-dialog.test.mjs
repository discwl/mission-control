import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { test } from "node:test";
const require = createRequire(import.meta.url);
const ts = require("typescript");
const compile = source => ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX } }).outputText;
require.extensions[".ts"] = (module, file) => module._compile(compile(readFileSync(file, "utf8")), file);
const requests = require("./orchestrator-dialog-request.ts");
const worker = (id, workspaceId) => ({ id, workspaceId, name: id, status: "idle", archivedAt: null, lastUserMessageAt: "2026-10-23T10:00:00Z", parentAgentId: null, updatedAt: "2026-10-23T11:00:00Z" });
const workspace = id => ({ id, name: id, projectName: "project", labels: ["Review"] });

function harness(kind, compact = false) {
  const states = []; let cursor = 0;
  const calls = [], keys = [], cleanups = [];
  const roster = { workspaces: [workspace("mine"), workspace("other")], agents: [worker("worker", "mine"), worker("other-worker", "other")], hasMore: false };
  const links = { links: [{ serverId: "local", agentId: "chat", remoteServerId: "remote", remoteAgentId: "worker", remoteWorkspaceId: "mine", linkedAt: "now", taskId: null }] };
  const jsx = (type, props) => typeof type === "function" ? type(props) : ({ type, props });
  const modal = Object.assign(props => ({ type: "Modal", props }), { Content: "ModalContent" });
  const mocks = {
    react: { useState: initial => { const index = cursor++; if (!(index in states)) states[index] = initial; return [states[index], value => { states[index] = value; }]; }, useEffect: effect => { const cleanup = effect(); if (cleanup) cleanups.push(cleanup); }, useSyncExternalStore: (_subscribe, snapshot) => snapshot() },
    "react/jsx-runtime": { jsx, jsxs: jsx, Fragment: "Fragment" },
    "react-native": { Text: "Text", View: "View", TextInput: "TextInput" },
    "@getpaseo/plugin/client": { useHosts: () => [{ serverId: "remote", status: "online", label: "Remote" }], useRpc: contract => async input => { calls.push([contract.name, input]); return links; } },
    "@getpaseo/plugin/client/react-native": { Icon: "Icon" },
    "@tanstack/react-query": { useQuery: options => { keys.push(options.queryKey); return { data: options.queryKey[1] === "orchestrator-work" ? links : roster, isPending: false, refetch: async () => {} }; }, useQueryClient: () => ({ setQueryData: () => {} }) },
    "./app-modal": { AppModal: modal }, "./attention": { Attention: "Attention" }, "./compact-link": { CompactLink: "Link" },
    "./date-time": { formatDateTime: value => value }, "./host-agents-panel": { ReviewSections: "ReviewSections" },
    "./host-rpc": { HostRpcProvider: "HostRpcProvider", useMissionControlCopy: () => ({ copy: { serverId: "remote" } }) },
    "./mission-docs": { MissionDocs: "MissionDocs" }, "./mission-review": { MissionReview: "MissionReview" },
    "./roster": { useLiveRoster: () => {}, rosterQuery: () => ({ queryKey: ["mission-control", "roster"] }) },
  };
  const mod = { exports: {} };
  new Function("require", "module", "exports", compile(readFileSync(new URL("./orchestrator-dialog.tsx", import.meta.url), "utf8")))(name => mocks[name] ?? require(`${name}.ts`), mod, mod.exports);
  const Icon = mod.exports.createOrchestratorDialogIcon({ serverId: "remote", label: "Remote" }, kind, (...args) => calls.push(["navigate", ...args]));
  const key = requests.orchestratorDialogKey("folder", "chat", "remote", kind);
  requests.setOrchestratorDialogOpen(key, true);
  const render = () => { cursor = 0; return Icon({ context: "agent", workspaceId: "folder", agentId: "chat", host: { id: "local" }, theme: { colors: {} }, layout: { compact, platform: "web" }, size: 16, color: "white" }); };
  return { render, calls, keys, key, links, roster, unmount: () => { for (const cleanup of cleanups.splice(0)) cleanup(); states.length = 0; } };
}
function nodes(node, type) {
  if (!node || typeof node !== "object") return [];
  if (Array.isArray(node)) return node.flatMap(child => nodes(child, type));
  return [...(node.type === type ? [node] : []), ...nodes(node.props?.children, type)];
}
test("native children appear without links and another server's same chat ID is excluded", () => {
  for (const compact of [false, true]) {
    const f = harness("review", compact);
    f.links.links = [];
    f.roster.agents[0].labels = { "paseo.parent-agent-id": "chat", "paseo.parent-server-id": "local" };
    f.roster.agents[1].labels = { "paseo.parent-agent-id": "chat", "paseo.parent-server-id": "other-origin" };
    let tree = f.render();
    assert.deepEqual(nodes(tree, "ReviewSections")[0].props.ready.map(x => x.workspace.id), ["mine"]);
    assert.match(JSON.stringify(tree), /Native child/);
    nodes(tree, "Link").find(n => n.props.label === "All host work").props.onPress();
    tree = f.render();
    assert.equal(nodes(tree, "ReviewSections")[0].props.ready.length, 2);
    nodes(tree, "Link").find(n => n.props.label === "This chat's work").props.onPress();
    assert.equal(nodes(f.render(), "ReviewSections")[0].props.ready.length, 1);
    f.roster.agents[0].labels = {};
    assert.equal(nodes(f.render(), "ReviewSections").length, 0);
    f.unmount(); requests.setOrchestratorDialogOpen(f.key, false);
  }
});

test("running managed workers remain visible without review-ready workspaces", () => {
  const h = harness("review");
  h.roster.workspaces.forEach(workspace => workspace.labels = []);
  h.roster.agents[0].status = "running";
  let tree = h.render();
  assert.match(JSON.stringify(tree), /Managed workers/);
  assert.match(JSON.stringify(tree), /running/);
  assert.equal(nodes(tree, "ReviewSections").length, 0);
  const review = nodes(tree, "Link").find(node => node.props.label === "Review workspace");
  assert.ok(review); review.props.onPress(); tree = h.render();
  assert.equal(nodes(tree, "MissionReview")[0].props.workspace.id, "mine");
  assert.equal(nodes(tree, "MissionReview")[0].props.sessionId, "local:chat");
  h.unmount(); requests.setOrchestratorDialogOpen(h.key, false);
});

test("both dialogs survive Paseo replacing the clicked icon with its pending spinner", () => {
  for (const kind of ["attention", "review"]) for (const compact of [false, true]) {
    const f = harness(kind, compact);
    requests.setOrchestratorDialogOpen(f.key, false);
    assert.equal(nodes(f.render(), "Modal").length, 0);
    // Paseo runs onPress, temporarily unmounts ButtonIcon while pending, then mounts it again.
    requests.setOrchestratorDialogOpen(f.key, true);
    f.unmount();
    assert.equal(requests.isOrchestratorDialogOpen(f.key), true, `${kind}: pending spinner must not dismiss`);
    const tree = f.render();
    assert.equal(nodes(tree, "Modal").length, 1);
    assert.equal(f.calls.length, 0, "opening must not navigate to Host Agents");
    nodes(tree, "Modal")[0].props.onOpenChange(false);
    assert.equal(requests.isOrchestratorDialogOpen(f.key), false);
    f.unmount();
  }
});

test("modal input and keyboard events cannot bubble back to the composer action", () => {
  const previousWindow = globalThis.window;
  globalThis.window = {};
  try {
    for (const kind of ["attention", "review"]) for (const compact of [false, true]) {
      const f = harness(kind, compact);
      const tree = f.render();
      const boundary = nodes(tree, "View").find(node => node.props.onClick);
      assert.ok(boundary, "the modal must have a bubble-phase event boundary");
      for (const name of ["onClick", "onKeyDown", "onKeyUp"]) {
        let stopped = false;
        boundary.props[name]({ stopPropagation() { stopped = true; }, preventDefault() { assert.fail("input focus and typing must retain default behavior"); } });
        // Paseo's parent action swaps its icon for a spinner, which resets all editor state.
        if (!stopped) f.unmount();
        assert.equal(stopped, true, `${kind}: ${name} must not reach the composer action`);
        assert.equal(requests.isOrchestratorDialogOpen(f.key), true);
      }
      assert.equal(f.calls.length, 0, "interacting with the modal must not navigate");
      requests.setOrchestratorDialogOpen(f.key, false);
    }
  } finally {
    if (previousWindow === undefined) delete globalThis.window;
    else globalThis.window = previousWindow;
  }
});

test("Attention stays in the chat in wide and compact layouts, and close only dismisses", () => {
  for (const compact of [false, true]) {
    const f = harness("attention", compact);
    const tree = f.render();
    assert.equal(nodes(tree, "Attention")[0].props.serverId, "remote");
    assert.equal(f.calls.length, 0);
    nodes(tree, "Modal")[0].props.onOpenChange(false);
    assert.equal(requests.isOrchestratorDialogOpen(f.key), false);
    assert.equal(f.calls.length, 0);
  }
});
test("switching back to this chat closes the all-host worker picker and removes unrelated results", () => {
  for (const compact of [false, true]) {
    const f = harness("review", compact);
    let tree = f.render();
    nodes(tree, "Link").find(node => node.props.label === "All host work").props.onPress();
    tree = f.render();
    assert.equal(nodes(tree, "ReviewSections")[0].props.ready.length, 2);
    nodes(tree, "Link").find(node => node.props.label === "Link workers").props.onPress();
    tree = f.render();
    assert.equal(nodes(tree, "TextInput").length, 1);
    nodes(tree, "Link").find(node => node.props.label === "This chat's work").props.onPress();
    tree = f.render();
    assert.equal(nodes(tree, "TextInput").length, 0, "all-host picker must close on scope switch");
    assert.deepEqual(nodes(tree, "ReviewSections")[0].props.ready.map(item => item.workspace.id), ["mine"]);
    assert.deepEqual(nodes(tree, "ReviewSections")[0].props.ready.flatMap(item => item.agents.map(agent => agent.id)), ["worker"]);
  }
});

test("a chat with no worker links returns to an honest empty scope after viewing all host work", () => {
  const f = harness("review");
  f.links.links = [];
  let tree = f.render();
  assert.equal(nodes(tree, "ReviewSections").length, 0, "do not show the host-wide 'nothing waiting' message");
  nodes(tree, "Link").find(node => node.props.label === "All host work").props.onPress();
  tree = f.render();
  assert.equal(nodes(tree, "ReviewSections")[0].props.ready.length, 2);
  nodes(tree, "Link").find(node => node.props.label === "This chat's work").props.onPress();
  tree = f.render();
  assert.equal(nodes(tree, "ReviewSections").length, 0);
  assert.ok(nodes(tree, "Text").some(node => String(node.props.children).startsWith("No native children or linked workers")));
});

test("Review defaults to this chat, switches to all work, and reads links using host plus chat identity", () => {
  const f = harness("review");
  let tree = f.render();
  assert.deepEqual(nodes(tree, "ReviewSections")[0].props.ready.map(item => item.workspace.id), ["mine"]);
  assert.ok(f.keys.some(key => JSON.stringify(key) === JSON.stringify(["mission-control", "orchestrator-work", "local", "chat", "remote"])));
  nodes(tree, "Link").find(node => node.props.label === "All host work").props.onPress();
  tree = f.render();
  assert.equal(nodes(tree, "ReviewSections")[0].props.ready.length, 2);
  assert.equal(f.calls.length, 0);
  nodes(tree, "ReviewSections")[0].props.openAgent("worker");
  assert.deepEqual(f.calls, [["navigate", "folder", "remote", "agent", "worker"]]);
  assert.equal(requests.isOrchestratorDialogOpen(f.key), false);
});
