import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import vm from "node:vm";
const require = createRequire(import.meta.url);
const ts = require("typescript");
function harness(storage = new Map()) {
  const module = { exports: {} };
  const source = ts.transpileModule(readFileSync(new URL("./coordinator-return.tsx", import.meta.url), "utf8"), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX } }).outputText;
  new vm.Script(source).runInNewContext({ module, exports: module.exports, JSON, require: name => name === "zod" ? require("zod") : name === "./web" ? { readClientStorage: key => storage.get(key) ?? null, writeClientStorage: (key, value) => storage.set(key, value) } : name === "../shared/fleet" ? { fleetScreenId: "fleet" } : name === "react" ? { useState: value => [typeof value === "function" ? value() : value, () => {}], useEffect: effect => effect() } : name === "react/jsx-runtime" ? { jsx: (type, props) => ({ type, props }), jsxs: (type, props) => ({ type, props }) } : name === "@getpaseo/plugin/client" ? { useHosts: () => [] } : {} });
  return module.exports;
}
const origin = { version: 1, kind: "chat", serverId: "personal", agentId: "coordinator", workspaceId: "orchestrator", label: "CNS coordinator" };
test("worker navigation saves the exact coordinator and survives a plugin module reload", () => {
  const storage = new Map(); const api = harness(storage); const destinations = [];
  api.navigateWithCoordinatorReturn(origin, () => destinations.push({ serverId: "CNS", agentId: "worker" }));
  assert.equal(destinations.length, 1);
  assert.deepEqual(JSON.parse(JSON.stringify(harness(storage).readCoordinatorOrigin())), origin);
  assert.equal(api.readCoordinatorOrigin().serverId, "personal");
});
test("failed navigation restores the previous return destination", () => {
  const api = harness(); api.rememberCoordinatorOrigin(origin);
  assert.throws(() => api.navigateWithCoordinatorReturn({ ...origin, agentId: "different" }, () => { throw new Error("offline"); }), /offline/);
  assert.equal(api.readCoordinatorOrigin().agentId, "coordinator");
});
test("cached screen remounts and plugin reloads cannot replay a return click", () => {
  const storage = new Map(); const api = harness(storage); api.rememberCoordinatorOrigin(origin);
  let screen; let command; const opened = []; const navigated = [];
  const client = { addScreen: value => { screen = value.Component; return () => {}; }, addSidebarHeaderItem: () => () => {}, addCommandCenterItem: value => { command = value; return () => {}; }, openScreen: input => opened.push(input) };
  api.registerCoordinatorReturn(client);
  command.onSelect();
  const props = { params: opened[0].params, theme: { colors: {} }, host: { id: "personal" }, navigation: { openAgent: input => navigated.push(input) } };
  screen(props); screen(props);
  assert.equal(navigated.length, 1);
  api.rememberCoordinatorOrigin({ ...origin, agentId: "new-coordinator" });
  command.onSelect(); screen({ ...props, params: opened[1].params });
  assert.equal(navigated.at(-1).agentId, "new-coordinator");
  harness(storage).registerCoordinatorReturn(client);
  screen(props);
  assert.equal(navigated.length, 2);
});
test("missing and malformed return state cannot navigate to an invented agent", () => {
  const api = harness();
  assert.equal(api.readCoordinatorOrigin(), null);
  assert.equal(api.restoreCoordinatorOrigin({ ...origin, agentId: "" }), null);
  assert.equal(api.restoreCoordinatorOrigin({ ...origin, version: 2 }), null);
});
