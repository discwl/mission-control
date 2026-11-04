import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { test } from "node:test";
const require = createRequire(import.meta.url);
const ts = require("typescript");
const coordinator = { agentId: "coordinator", remoteServerId: "remote", hostLabel: "Example", name: "Task coordinator" };
const colors = { foreground: "#eeeeee", foregroundMuted: "#bbbbbb", surface1: "#222222", surface2: "#333333", border: "#555555", statusWarning: "#ffaa44", accent: "#77ccff" };
const snapshot = () => ({ serverId: "local", state: { revision: 8, paused: false, pipelines: [] }, coordinators: [coordinator], hosts: [{ serverId: "remote", label: "Example", snapshot: { complete: true, workspaces: [{ id: "workspace", status: "active", projectName: "Project", name: "Work" }], tasks: [{ task: { taskId: "task_one", title: "Fix the behavior", status: "ready" }, run: null }] } }] });
function runtime(file, initialProps, handler = async () => ({}), memory = new Map()) {
  let index = 0; const state = [], nodes = [], calls = [], pending = [], errors = [];
  const useState = initial => { const slot = index++; if (!(slot in state)) state[slot] = typeof initial === "function" ? initial() : initial; return [state[slot], next => { state[slot] = typeof next === "function" ? next(state[slot]) : next; }]; };
  const jsx = (type, props) => ({ type, props });
  const compiled = ts.transpileModule(readFileSync(new URL(file, import.meta.url), "utf8"), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX } }).outputText;
  const module = { exports: {} };
  new Function("require", "module", "exports", compiled)(id => {
    if (id === "react") return { useState };
    if (id === "react/jsx-runtime") return { jsx, jsxs: jsx, Fragment: "Fragment" };
    if (id === "react-native") return { Text: "Text", TextInput: "TextInput", View: "View" };
    if (id === "@getpaseo/plugin/client") return { useRpc: method => async input => { calls.push({ method, input }); return handler(method, input); } };
    if (id === "../shared/pipeline") return { startPipeline: "start", controlPipeline: "control", intakePipeline: "intake" };
    if (id === "../shared/fleet-model") return { managedTasks: () => [] };
    if (id === "./compact-link") return { CompactLink: "CompactLink" };
    if (id === "./pipeline-intake") return { PipelineIntakeForm: "PipelineIntakeForm" };
    if (id === "./date-time") return { formatDateTime: value => value };
    if (id === "./agent-policy") return { AgentPolicyEditor: "AgentPolicyEditor", TaskAgentPolicyEditor: "TaskAgentPolicyEditor" };
    if (id === "./pipeline-review") return { PipelineReviewEvidence: "PipelineReviewEvidence" };
    if (id === "./action-delivery") return { RemoteActionDeliveryCard: "RemoteActionDeliveryCard" };
    if (id === "./page-state") return { usePageState: (key, initial) => { if (!memory.has(key)) memory.set(key, initial); return [memory.get(key), value => memory.set(key, typeof value === "function" ? value(memory.get(key)) : value)]; } };
    throw Error(`Unexpected import: ${id}`);
  }, module, module.exports);
  const props = { colors, busy: false, openAgent() {}, openTask() {}, coordinators: [coordinator], coordinator, act(_key, work) { pending.push(Promise.resolve().then(work).catch(error => errors.push(error))); }, ...initialProps };
  function render() { index = 0; nodes.length = 0; const visit = node => { if (!node || typeof node !== "object") return; if (Array.isArray(node)) return node.forEach(visit); nodes.push(node); visit(node.props?.children); }; visit((module.exports.PipelineBoard ?? module.exports.PipelineIntakeForm)(props)); return nodes; }
  const button = label => { const result = nodes.find(node => node.type === "CompactLink" && node.props.label === label); assert.ok(result, `Missing button: ${label}`); return result.props; };
  const input = label => { const result = nodes.find(node => node.type === "TextInput" && node.props.accessibilityLabel === label); assert.ok(result, `Missing input: ${label}`); return result.props; };
  return { props, calls, nodes, errors, memory, render, button, input, text: () => JSON.stringify(nodes.map(node => node.props?.children)), press(label) { const target = button(label); assert.ok(!target.disabled); target.onPress(); }, settle: () => Promise.all(pending) };
}

test("new starts use automatic review and the selected host/task revision", async () => {
  const r = runtime("./pipelines.tsx", { snapshot: snapshot() }); r.render();
  assert.equal(r.button("Automatic plan check + two reviews").selected, true);
  r.press("Run this task to draft PR"); await r.settle();
  assert.deepEqual(r.calls, [{ method: "start", input: { coordinatorId: "coordinator", remoteServerId: "remote", taskId: "task_one", workflowMode: "automatic", deliveryKind: "code", expectedRevision: 8 } }]);
});

test("action bundles are explicit and changing to manual restores code delivery", async () => {
  const r = runtime("./pipelines.tsx", { snapshot: snapshot() }); r.render();
  r.press("Scripts or actions"); r.render(); r.press("Prepare reviewed actions"); await r.settle();
  assert.equal(r.calls.at(-1).input.deliveryKind, "actions");
  r.press("Human plan and review approvals"); r.render();
  assert.ok(!r.nodes.some(node => node.props?.label === "Scripts or actions"));
  r.press("Run this task to draft PR"); await r.settle();
  assert.equal(r.calls.at(-1).input.workflowMode, "manual"); assert.equal(r.calls.at(-1).input.deliveryKind, "code");
});

test("existing manual workflows change only through the explicit adoption action", async () => {
  const data = snapshot(); data.state.pipelines.push({ id: "runner", coordinatorId: "coordinator", remoteServerId: "remote", taskId: "task_one", title: "Existing task", stage: "plan", mode: "waiting", repairs: 0, updatedAt: "now" });
  const r = runtime("./pipelines.tsx", { snapshot: data }); r.render();
  assert.match(r.text(), /Manual approvals/); assert.equal(r.calls.length, 0);
  r.press("Switch to automatic plan check and two reviews"); await r.settle();
  assert.deepEqual(r.calls, [{ method: "control", input: { id: "runner", action: "adopt-automatic", expectedRevision: 8 } }]);
  data.state.pipelines[0].pending = { requestId: "pending" }; r.render();
  assert.equal(r.button("Switch to automatic plan check and two reviews").disabled, true);
});

test("final action preview stays visible while waiting or blocked and attributes consent to the human UI", () => {
  for (const mode of ["ready", "waiting", "blocked", "done"]) {
    const data = snapshot(); data.state.pipelines.push({ id: "runner", coordinatorId: "coordinator", remoteServerId: "remote", taskId: "task_one", title: "Prepared actions", workflowMode: "automatic", deliveryKind: "actions", stage: "delivery", mode, repairs: 0, updatedAt: "now" });
    const r = runtime("./pipelines.tsx", { snapshot: data }); r.render();
    const preview = r.nodes.find(node => node.type === "RemoteActionDeliveryCard");
    assert.ok(preview, `Missing preview in ${mode}`); assert.equal(preview.props.actorId, "human-ui");
    assert.equal(r.calls.length, 0); if (mode === "done") assert.match(r.text(), /Actions complete/);
  }
});

test("completed reports are labeled complete without suggesting authorization is pending", () => {
  const data = snapshot(); data.state.pipelines.push({ id: "runner", coordinatorId: "coordinator", remoteServerId: "remote", taskId: "task_one", title: "Read-only report", workflowMode: "automatic", deliveryKind: "report", stage: "delivery", mode: "done", repairs: 0, updatedAt: "now" });
  const r = runtime("./pipelines.tsx", { snapshot: data }); r.render(); assert.match(r.text(), /Report complete/);
});

test("intake retry retains its original workflow and deliverable after a lost reply", async () => {
  let fail = true;
  const r = runtime("./pipeline-intake.tsx", { snapshot: snapshot(), workflowMode: "automatic", deliveryKind: "actions" }, async () => { if (fail) throw Error("Connection lost"); return { intake: { phase: "created" } }; });
  r.render(); r.press("Start from a ticket or new task"); r.render(); r.press("Project · Work");
  r.input("New task title").onChangeText("Prepare maintenance"); r.input("Task requirements and success checks").onChangeText("Prepare and review exact actions."); r.render();
  r.press("Create task and prepare its plan"); await r.settle(); r.render();
  assert.equal(r.errors.length, 1); const original = r.calls[0].input;
  r.props.workflowMode = "manual"; r.props.deliveryKind = "code"; r.render(); fail = false;
  assert.equal(r.input("New task title").editable, false);
  r.press("Check and retry this same intake"); await r.settle();
  assert.deepEqual(r.calls[1].input, original); assert.equal(original.workflowMode, "automatic"); assert.equal(original.deliveryKind, "actions");
});

test("cached legacy intake displays manual approval and never silently opts in", async () => {
  const memory = new Map([["pipeline-intake:local:pending", { requestId: "old-request", coordinatorId: "coordinator", remoteServerId: "remote", workspaceId: "workspace", title: "Existing intake", acceptanceCriteria: "Keep its original policy." }]]);
  const r = runtime("./pipeline-intake.tsx", { snapshot: snapshot() }, async () => ({ intake: { phase: "created" } }), memory); r.render();
  assert.match(r.text(), /You approve the plan and review/);
  r.press("Check and retry this same intake"); await r.settle();
  assert.equal(r.calls[0].input.workflowMode, undefined); assert.equal(r.calls[0].input.deliveryKind, undefined);
});
