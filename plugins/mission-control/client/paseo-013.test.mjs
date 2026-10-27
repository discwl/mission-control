import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { test } from "node:test";
const require = createRequire(import.meta.url), ts = require("typescript"), z = require("zod").z;
const jsx = (type, props) => ({ type, props });
function load(path, mocks = {}) {
  const exports = {};
  const source = ts.transpileModule(readFileSync(new URL(path, import.meta.url), "utf8"), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX } }).outputText;
  new Function("require", "exports", source)(id => id in mocks ? mocks[id] : require(id), exports);
  return exports;
}
const review = load("../shared/review.ts", { "@getpaseo/plugin": { defineRpc: value => value } });
const defaults = identity => ({ version: 1, identity, selectedPath: "src/a.ts", filter: "high", mode: "full", layout: "unified", pane: "files", fileView: "tree", blockIndex: 2, showDetail: true, showReviewed: false, showResolved: false, showPreview: false, agentChoice: "worker", draft: { path: "src/a.ts", anchor: { side: "old", line: 4, contentId: "aaaaaaaaaaaaaaaa", text: "original" }, body: "Please preserve this note" } });
function memoryRuntime() {
  const states = [], refs = []; let s = 0, r = 0; const cleanup = [];
  const module = load("./review-session.ts", { "../shared/review": review, "./web": { readClientStorage: () => null, writeClientStorage: () => true }, react: {
    useState(initial) { const i = s++; if (!(i in states)) states[i] = typeof initial === "function" ? initial() : initial; return [states[i], value => states[i] = value]; },
    useRef(initial) { return refs[r++] ??= { current: initial }; },
    useEffect(effect) { const done = effect(); if (done) cleanup.push(done); },
  } });
  return { ...module, render(identity, tab) { s = 0; r = 0; return module.useReviewSession(identity, tab); }, cleanup };
}
test("review state restores draft text and original anchor only for its exact identity", () => {
  const { restoreReviewSession } = memoryRuntime(); const state = defaults("host/workspace/chat");
  assert.deepEqual(restoreReviewSession(state, state.identity), state);
  for (const identity of ["other/workspace/chat", "host/other/chat", "host/workspace/other"]) assert.equal(restoreReviewSession(state, identity), null);
  assert.equal(restoreReviewSession({ ...state, version: 2 }, state.identity), null);
  assert.equal(restoreReviewSession({ ...state, blockIndex: -1 }, state.identity), null);
});
test("tab persistence survives a remount and writes do not loop on equivalent renders", () => {
  const writes = [], modified = []; const tab = { state: undefined, setState(value) { this.state = value; writes.push(value); }, setModified(value) { modified.push(value); } };
  const first = memoryRuntime(); const state = defaults("remote/workspace/chat");
  first.render(state.identity, tab).save(state);
  first.render(state.identity, tab).save(state);
  assert.equal(writes.length, 1);
  assert.deepEqual(memoryRuntime().render(state.identity, tab).initial, state);
  first.cleanup.forEach(fn => fn()); assert.equal(modified.at(-1), false);
});
test("returning to a review keeps its pinned snapshot in memory without persisting code", () => {
  const m = memoryRuntime(), writes = [], tab = { state: undefined, setState: value => writes.push(value), setModified() {} };
  const first = m.render("host/workspace/chat", tab), snapshot = { fingerprint: "saved-code-version", files: [{ path: "src/a.ts" }] };
  first.rememberSnapshot(snapshot);
  assert.equal(m.render("host/workspace/chat", tab).snapshot, snapshot);
  assert.equal(m.render("other/workspace/chat", tab).snapshot, null);
  assert.equal(writes.length, 0);
});

test("legacy file route retains the exact remote host/workspace and special path characters", () => {
  const opened = [];
  const module = load("./review-file-screen.tsx", { "react/jsx-runtime": { jsx, jsxs: jsx }, "react-native": { Text: "Text", View: "View" }, "@getpaseo/plugin/client": { useHosts: () => [{ serverId: "remote", label: "WestCap", status: "online" }] }, "./host-rpc": { useMissionControlCopy: id => ({ copy: { serverId: id } }), HostRpcProvider: "Provider" }, "./review-file-preview": { ReviewFilePreview: "File" }, "./compact-link": { CompactLink: "Link" }, "./plugin-client": { pluginClient: () => ({ openScreen: input => opened.push(input) }) } });
  const path = "docs/a #1 (draft).md";
  module.openReviewFile("remote", "exact-workspace", path);
  assert.deepEqual(opened, [{ screenId: "review-file", params: { serverId: "remote", workspaceId: "exact-workspace", path } }]);
  const rendered = module.ReviewFileScreen({ params: opened[0].params, host: { id: "local" }, theme: { colors: {} }, layout: { compact: true } });
  const provider = rendered.props.children.find(node => node.type === "Provider");
  assert.equal(provider.props.copy.serverId, "remote");
  assert.equal(provider.props.children.props.workspaceId, "exact-workspace");
  assert.equal(provider.props.children.props.path, path);
});
test("Paseo 0.13 compact Explorer is used while older clients keep their tab fallback", () => {
  const { panelLocation, setUnifiedExplorer } = load("./layout.ts");
  const compact = { compact: () => true };
  assert.equal(panelLocation(compact), "workspace");
  setUnifiedExplorer(true); assert.equal(panelLocation(compact), "explorer");
  setUnifiedExplorer(false); assert.equal(panelLocation(compact), "workspace");
});
test("native parent preflight supports one-way fleets without connecting back to the origin", async () => {
  const { probeLaunchParent } = load("../server/launch-parent.ts", { "../shared/secret-mask": { hideCredentials: text => text } });
  const parent = { serverId: "origin", agentId: "chat" }; let connections = 0, refreshes = 0;
  const paseo = {
    hosts: { client: async () => { connections++; throw Error("Reverse connection forbidden"); } },
    agents: { ref: agentId => ({ address: { serverId: "worker", agentId }, refresh: async () => { refreshes++; throw Error("Parent is not a local agent"); } }) },
  };
  assert.deepEqual(await probeLaunchParent(parent, paseo), { supported: true });
  assert.equal(connections, 0); assert.equal(refreshes, 0);
  assert.equal((await probeLaunchParent(parent, {})).supported, false);
});
test("same-host native parents must still exist and remain available", async () => {
  const { probeLaunchParent } = load("../server/launch-parent.ts", { "../shared/secret-mask": { hideCredentials: text => text } });
  const parent = { serverId: "local", agentId: "chat" };
  for (const agent of [{ status: "idle", archivedAt: null }, null, { status: "closed" }, { status: "idle", archivedAt: "2026-10-26" }]) {
    const paseo = { hosts: { client: async () => { throw Error("Must not connect"); } }, agents: { ref: id => ({ address: { serverId: "local", agentId: id }, refresh: async () => ({ agent }) }) } };
    assert.equal((await probeLaunchParent(parent, paseo)).supported, agent?.status === "idle" && !agent.archivedAt);
  }
});
