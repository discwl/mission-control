import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import ts from "typescript";

function render(run, workflowMode = "automatic", deliveryKind = "actions") {
  const calls = []; let hook = 0;
  const jsx = (type, props) => ({ type, props });
  const modules = {
    react: { useState: initial => { const index = hook++; return [index === 2 ? workflowMode : index === 3 ? deliveryKind : typeof initial === "function" ? initial() : initial, () => {}]; } },
    "react-native": { Text: "Text", TextInput: "TextInput", View: "View" },
    "react/jsx-runtime": { jsx, jsxs: jsx },
    "@getpaseo/plugin/client": { useRpc: contract => async input => { calls.push({ method: contract.name, input }); return input; } },
    "../shared/pipeline": { startPipeline: { name: "pipeline.start" }, controlPipeline: { name: "pipeline.control" } },
    "../shared/fleet-model": { managedTasks: (_server, _coordinator, host) => host.tasks },
    "./compact-link": { CompactLink: "CompactLink" }, "./pipeline-intake": { PipelineIntakeForm: "PipelineIntakeForm" },
    "./date-time": { formatDateTime: value => value }, "./agent-policy": { AgentPolicyEditor: "AgentPolicyEditor", TaskAgentPolicyEditor: "TaskAgentPolicyEditor" },
    "./pipeline-review": { PipelineReviewEvidence: "PipelineReviewEvidence" }, "./action-delivery": { ActionDeliveryCard: "ActionDeliveryCard" },
  };
  const code = ts.transpileModule(readFileSync(new URL("./pipelines.tsx", import.meta.url), "utf8"), { compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX, target: ts.ScriptTarget.ES2022 } }).outputText;
  const module = { exports: {} }; new Function("require", "module", "exports", code)(name => modules[name] ?? {}, module, module.exports);
  const coordinator = { agentId: "coordinator", remoteServerId: "remote", hostLabel: "Remote", name: "Coordinator" };
  const entry = { task: { taskId: "task_a", title: "Existing task", status: "in_progress" }, run };
  const snapshot = { serverId: "personal", hosts: [{ serverId: "remote", error: null, snapshot: { complete: true, tasks: [entry] } }], state: { pipelines: [], paused: false, revision: 4 } };
  const tree = module.exports.PipelineBoard({ snapshot, coordinators: [coordinator], colors: {}, busy: false, act: (_key, work) => work(), openAgent() {}, openTask() {} });
  const nodes = []; const visit = node => { if (Array.isArray(node)) return node.forEach(visit); if (!node || typeof node !== "object") return; nodes.push(node); visit(node.props?.children); }; visit(tree);
  return { nodes, calls };
}

test("existing manual task button preserves manual code settings despite new-task automatic action selection", async () => {
  const f = render({ runId: "legacy" });
  const button = f.nodes.find(node => node.props?.label === "Continue with human approvals"); assert.ok(button); await button.props.onPress();
  assert.equal(f.calls[0].method, "pipeline.start"); assert.equal(f.calls[0].input.workflowMode, "manual"); assert.equal(f.calls[0].input.deliveryKind, "code");
  assert.equal(f.calls[0].input.expectedRevision, 4);
});

test("existing automatic task retains deliverable and new task uses selected automatic defaults", async () => {
  const existing = render({ runId: "automatic", workflowMode: "automatic", deliveryKind: "report" }, "manual", "code");
  await existing.nodes.find(node => node.props?.label === "Continue existing automatic workflow").props.onPress();
  assert.equal(existing.calls[0].input.workflowMode, "automatic"); assert.equal(existing.calls[0].input.deliveryKind, "report");
  const fresh = render(null); await fresh.nodes.find(node => node.props?.label === "Prepare reviewed actions").props.onPress();
  assert.equal(fresh.calls[0].input.workflowMode, "automatic"); assert.equal(fresh.calls[0].input.deliveryKind, "actions");
});
