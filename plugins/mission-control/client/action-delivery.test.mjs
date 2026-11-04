import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { runInNewContext } from "node:vm";
import test from "node:test";
const require = createRequire(import.meta.url); const ts = require("typescript");
const compiled = ts.transpileModule(readFileSync(new URL("./action-delivery.tsx", import.meta.url), "utf8"), { compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX } }).outputText;
function fixture({ kind = "actions", ready = true, fail = false } = {}) {
  const slots = []; let cursor = 0; const effects = []; const calls = []; const checks = [];
  const response = { ready, reason: ready ? "Two reviews passed" : "Review is stale", completed: kind === "report", plan: { taskId: "task_123", kind, revision: "a".repeat(64), fingerprint: "b".repeat(64), bundle: { summary: "Restart test service", environment: "test", prerequisites: ["Maintenance window"], steps: [{ instruction: "restart test-service", effect: "Brief test outage" }], verification: ["Health probe"], rollback: "Restore the previous instance", ...(kind === "report" ? { report: "No changes needed" } : {}) } } };
  const check = async input => { checks.push(input); return response; };
  const authorize = async input => { calls.push(input); if (fail) throw new Error("Connection lost"); return { outcome: "resumed", reason: "Authorized steps sent", revision: response.plan.revision }; };
  const jsx = (type, props) => ({ type, props });
  const modules = {
    react: {
      useState(initial) { const i = cursor++; if (!(i in slots)) slots[i] = typeof initial === "function" ? initial() : initial; return [slots[i], value => { slots[i] = typeof value === "function" ? value(slots[i]) : value; }]; },
      useRef(initial) { const i = cursor++; return slots[i] ??= { current: initial }; },
      useEffect(effect, deps) { const i = cursor++; if (!slots[i] || deps.some((v, n) => !Object.is(v, slots[i][n]))) { slots[i] = deps; effects.push(effect); } },
    },
    "react/jsx-runtime": { jsx, jsxs: jsx, Fragment: "Fragment" }, "react-native": { Text: "Text", View: "View" },
    "./host-rpc": { useRpc: name => name === "check" ? check : authorize, HostRpcProvider: "HostScope", useMissionControlCopy: serverId => ({ copy: { serverId } }) },
    "@getpaseo/plugin/client": { useHosts: () => [{ serverId: "host", status: "online" }] },
    "../shared/action-delivery": { checkActionDelivery: "check", authorizeActionDelivery: "authorize" }, "./compact-link": { CompactLink: "Link" },
  };
  const module = { exports: {} }; runInNewContext(compiled, { exports: module.exports, require: name => { if (!(name in modules)) throw new Error(name); return modules[name]; } });
  let tree; const props = { serverId: "host", taskId: "task_123", actorId: "coordinator", colors: {} };
  function render() { cursor = 0; tree = module.exports.ActionDeliveryCard(props); for (const effect of effects.splice(0)) effect(); return tree; }
  function nodes(node) { return !node || typeof node !== "object" ? [] : Array.isArray(node) ? node.flatMap(n => nodes(n)) : [node, ...nodes(node.props?.children)]; }
  function button(label) { return nodes(tree).find(node => node.type === "Link" && node.props.label === label)?.props; }
  async function settle() { await new Promise(resolve => setImmediate(resolve)); render(); }
  async function expand() { button("Review final actions or report").onPress(); render(); await settle(); }
  render(); return { calls, checks, response, props, render, button, settle, expand, remote: () => module.exports.RemoteActionDeliveryCard(props), text: () => JSON.stringify(tree) };
}
test("runner-board action previews explicitly select the owning host's plugin copy", () => {
  const f = fixture(); const remote = f.remote(); assert.equal(remote.type, "HostScope"); assert.equal(remote.props.copy.serverId, "host"); assert.equal(remote.props.children.props.serverId, "host"); assert.equal(f.calls.length, 0);
});
test("repair form receives only the displayed ready action bundle and disappears after authorization", async () => {
  const f = fixture(); const seen = []; f.props.renderFeedback = plan => { seen.push(plan); return "Repair"; }; await f.expand();
  assert.equal(seen.length, 1); assert.equal(seen[0], f.response.plan);
  f.button("Authorize these actions").onPress(); await f.settle(); assert.equal(seen.length, 1);
  const report = fixture({ kind: "report" }); report.props.renderFeedback = () => { throw Error("Reports cannot request action repairs"); }; await report.expand();
  const blocked = fixture({ ready: false }); blocked.props.renderFeedback = () => { throw Error("An unready preview cannot request repairs"); }; await blocked.expand();
});
test("final action preview is read-only until the user authorizes its exact fingerprint", async () => {
  const f = fixture(); assert.equal(f.checks.length, 0); assert.equal(f.calls.length, 0);
  await f.expand(); assert.equal(f.checks.length, 1); assert.equal(f.calls.length, 0);
  assert.match(f.text(), /Brief test outage/); assert.match(f.text(), /Restore the previous instance/);
  const button = f.button("Authorize these actions"); assert.equal(button.disabled, false);
  button.onPress(); button.onPress(); await f.settle();
  assert.equal(f.calls.length, 1); assert.deepEqual(JSON.parse(JSON.stringify(f.calls[0])), { serverId: "host", taskId: "task_123", actorId: "coordinator", fingerprint: "b".repeat(64) });
});
test("stale review evidence disables action authorization", async () => {
  const f = fixture({ ready: false }); await f.expand(); const button = f.button("Authorize these actions"); assert.equal(button.disabled, true); button.onPress(); await f.settle(); assert.equal(f.calls.length, 0);
});
test("reports show the reviewed content without an execute control", async () => {
  const f = fixture({ kind: "report" }); await f.expand(); assert.equal(f.button("Authorize these actions"), undefined); assert.match(f.text(), /No changes needed/); assert.equal(f.calls.length, 0);
});
test("an uncertain transport result cannot be resent by refreshing the card", async () => {
  const f = fixture({ fail: true }); await f.expand(); f.button("Authorize these actions").onPress(); await f.settle(); assert.match(f.text(), /Check the worker before retrying/);
  f.button("Refresh delivery status").onPress(); f.render(); await f.settle();
  const button = f.button("Authorization requested — check status"); assert.equal(button.disabled, true); button.onPress(); await f.settle(); assert.equal(f.calls.length, 1);
});
test("a previous task preview cannot authorize a newly selected task", async () => {
  const f = fixture(); await f.expand(); f.props.taskId = "task_456"; f.render(); f.button("Authorize these actions").onPress(); await f.settle(); assert.equal(f.calls.length, 0);
});
