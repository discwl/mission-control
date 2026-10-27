import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import vm from "node:vm";
const require = createRequire(import.meta.url); const ts = require("typescript");
function render(binding) {
  const queries = []; const module = { exports: {} };
  const source = ts.transpileModule(readFileSync(new URL("./worker-history.tsx", import.meta.url), "utf8"), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX } }).outputText;
  const jsx = (type, props) => ({ type, props });
  const dependencies = {
    "react/jsx-runtime": { jsx, jsxs: jsx }, "react-native": { Text: "Text", View: "View", TextInput: "TextInput" },
    react: { useState: value => [typeof value === "function" ? value() : value, () => {}], useRef: value => ({ current: value }), useEffect: () => {} },
    "@getpaseo/plugin/client": { useHosts: () => [{ serverId: "CNS", label: "CNS", status: "online" }, { serverId: "AACN", label: "AACN", status: "online" }] },
    "@tanstack/react-query": { useQuery: () => ({ data: { bindings: binding ? { workspace: binding } : {} }, isSuccess: true, isError: false, isFetching: false }), useQueries: ({ queries: options }) => { queries.push(options); return options.map(() => ({ isFetching: false, isError: false, isSuccess: false })); } },
    "./host-rpc": { useMissionControlCopy: () => ({ copy: {} }), HostRpcProvider: "Provider", useRpc: () => async () => { throw new Error("No RPC should execute during render"); } },
    "./page-state": { PageScrollView: "ScrollView", usePageState: (_key, value) => [value, () => {}] },
    "./web": { readClientStorage: () => null },
    "./worker-history-model": { workerOwnerKey: () => "owner", restoreWorkerHistory: () => [], mergeWorkerHistory: () => [], workerGroups: ["Active", "Completed", "Archived"] },
    "./compact-link": { CompactLink: "Link" },
  };
  new vm.Script(source).runInNewContext({ module, exports: module.exports, JSON, Map, Set, require: name => dependencies[name] ?? {} });
  const props = { host: { id: "personal", label: "Personal" }, params: { agentId: "chat", workspaceId: "workspace" }, theme: { colors: {} }, layout: { compact: false } };
  const entry = module.exports.WorkerHistoryScreen(props);
  assert.notEqual(entry.type, "Provider", "installation-local RPCs must not be routed through the remote bridge");
  entry.type(entry.props);
  return queries;
}
test("the worker shortcut binds its origin host before opening and needs no render-time navigation", () => {
  const module = { exports: {} }; let command; const opened = [];
  const source = ts.transpileModule(readFileSync(new URL("./worker-history.tsx", import.meta.url), "utf8"), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX } }).outputText;
  new vm.Script(source).runInNewContext({ module, exports: module.exports, Map, Set, setInterval: () => 0, clearInterval: () => {}, require: name => name === "../shared/background" ? { ownHost: "local", listIncludingBackground: (_id, filter, list) => list(filter) } : {} });
  const client = { addScreen: () => () => {}, addCommandCenterItem: value => { command = value; return () => {}; }, openScreen: input => opened.push(input), paseo: { agents: { ref: id => ({ address: { serverId: "personal", agentId: id } }), list: async () => ({ entries: [], pageInfo: { hasMore: false } }) } } };
  const dispose = module.exports.registerWorkerHistory(client);
  command.onSelect({ agent: { id: "chat", workspaceId: "workspace", title: "CNS coordinator" } });
  assert.equal(opened[0].params.serverId, "personal");
  assert.equal(opened[0].params.agentId, "chat");
  assert.equal(opened[0].params.workspaceId, "workspace");
  dispose();
});
test("ordinary chats discover native children without querying bound-host-only worker links", () => {
  const [rosters, links] = render(null);
  assert.equal(rosters.filter(query => query.enabled).length, 3);
  assert.equal(links.some(query => query.enabled), false);
});
test("orchestrators query saved links only for the host declared by their workspace binding", () => {
  const [, links] = render({ serverId: "CNS", label: "CNS" });
  assert.deepEqual(Array.from(links.filter(query => query.enabled), query => query.queryKey.at(-1)), ["CNS"]);
});
