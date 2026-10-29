import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
const require = createRequire(import.meta.url); const ts = require("typescript");
require.extensions[".ts"] = (module, file) => module._compile(ts.transpileModule(readFileSync(file, "utf8"), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText, file);
const { registerPipelineRuntime } = require("./pipeline-runtime.ts");
const { createFleetStore } = require("./fleet-store.ts");
const transport = require("./chat-transport.ts");
const names = require("./agent-names.ts");
const { managePipelineChat } = require("./chat-pipeline.ts");
const at = "2026-10-29T03:00:00.000Z";
const taskId = "task_11111111-0000-4000-8000-000000000001";
const agent = (id, workspaceId) => ({ id, workspaceId, name: id, status: "idle", archivedAt: null, labels: {}, updatedAt: at, activityAt: at, pendingPermissions: 0, attention: false, attentionReason: null, error: null, inputTokens: null, outputTokens: null });
async function fixture(t) {
  const dir = await mkdtemp(join(tmpdir(), "mc-pipeline-rpc-")); t.after(() => rm(dir, { recursive: true, force: true }));
  const file = join(dir, "fleet.json"); const store = createFleetStore(file); const handlers = new Map(); const calls = [];
  const task = { task: { schemaVersion: 1, taskId, hostId: "remote", projectId: "project", title: "Example", acceptanceCriteria: "Works", status: "ready", source: "manual", assignments: [{ serverId: "remote", workspaceId: "work" }], createdAt: at, updatedAt: at }, run: null, decisions: [], questions: [], problem: null };
  const host = { serverId: "remote", observedAt: at, agents: [], workspaces: [{ id: "work", name: "Work", projectName: "Project", branch: null, labels: [], status: "idle" }], tasks: [task], warnings: [], complete: true, stoppedAgentIds: [] };
  const coordinator = { agentId: "coordinator", workspaceId: "folder", name: "Coordinator", remoteServerId: "remote", hostLabel: "Remote", agent: agent("coordinator", "folder"), links: [] };
  const snapshot = async () => ({ serverId: "personal", observedAt: at, coordinators: [coordinator], hosts: [{ serverId: "remote", label: "Remote", snapshot: host, error: null }], state: await store.read(), warnings: [] });
  const deps = { decisions: async () => ({ open: [], recent: [] }), questions: async () => ({ questions: [] }), stoppedAgents: async () => [] };
  const engine = registerPipelineRuntime({ handle: (contract, handler) => handlers.set(contract.name, handler) }, store, deps, snapshot, async (...args) => calls.push(args), () => {}); t.after(() => engine.stop());
  t.mock.method(names, "daemonServerId", async () => "personal");
  const invoke = async (method, input) => handlers.get(method)(input);
  return { file, store, task, host, coordinator, snapshot, calls, invoke };
}
test("runner enrollment and controls are revision-bound and do not approve or interrupt work", async t => {
  const f = await fixture(t); const input = { coordinatorId: "coordinator", remoteServerId: "remote", taskId, expectedRevision: 0 };
  await assert.rejects(f.invoke("pipeline.start", { ...input, remoteServerId: "other" }), /connected host/);
  const row = await f.invoke("pipeline.start", input); assert.equal(row.mode, "running");
  await assert.rejects(f.invoke("pipeline.start", { ...input, expectedRevision: 1 }), /already owns/);
  const paused = await f.invoke("pipeline.control", { id: row.id, action: "pause", expectedRevision: 1 }); assert.equal(paused.mode, "paused");
  await assert.rejects(f.invoke("pipeline.control", { id: row.id, action: "resume", expectedRevision: 1 }), /changed/);
  const resumed = await f.invoke("pipeline.control", { id: row.id, action: "resume", expectedRevision: 2 }); assert.equal(resumed.mode, "running");
  await f.invoke("pipeline.control", { id: row.id, action: "stop", expectedRevision: 3 });
  await assert.rejects(f.invoke("pipeline.control", { id: row.id, action: "resume", expectedRevision: 4 }), /finished/);
  assert.equal(f.calls.length, 0); assert.deepEqual(f.task.decisions, []);
});
test("uncertain dispatch needs inspection of its exact request and stays paused after acknowledgment", async t => {
  const f = await fixture(t); const row = await f.invoke("pipeline.start", { coordinatorId: "coordinator", remoteServerId: "remote", taskId, expectedRevision: 0 });
  await f.store.update(state => { state.pipelines[0].pending = { requestId: "attempt-one", fingerprint: "exact-stage", stage: "execute", attemptedAt: at }; state.pipelines[0].mode = "blocked"; });
  await assert.rejects(f.invoke("pipeline.control", { id: row.id, action: "resume", expectedRevision: 2 }), /acknowledge/);
  await assert.rejects(f.invoke("pipeline.control", { id: row.id, action: "acknowledge", requestId: "wrong", delivery: "sent", expectedRevision: 2 }), /exact pending/);
  const checked = await f.invoke("pipeline.control", { id: row.id, action: "acknowledge", requestId: "attempt-one", delivery: "sent", expectedRevision: 2 });
  assert.equal(checked.mode, "paused"); assert.equal(checked.pending, null); assert.equal(checked.lastDispatch, "exact-stage");
});
test("intake saves intent first and a lost remote reply retries the same task", async t => {
  const f = await fixture(t); const created = new Map(); const requests = []; let drop = true;
  t.mock.method(transport, "invokeChatHost", async (serverId, method, input) => {
    assert.equal(serverId, "remote");
    if (method === "pipeline.capabilities") return { serverId, version: 1, idempotentIntake: true };
    assert.equal(method, "tasks.create"); assert.equal((await f.store.read()).pipelines[0].intake.phase, "pending"); requests.push(input.requestId);
    if (!created.has(input.requestId)) created.set(input.requestId, { ...f.task.task, taskId: `task_${input.requestId}`, title: input.title, acceptanceCriteria: input.acceptanceCriteria });
    if (drop) { drop = false; throw new Error("Lost reply after creation"); }
    return created.get(input.requestId);
  });
  const input = { requestId: "22222222-0000-4000-8000-000000000002", coordinatorId: "coordinator", remoteServerId: "remote", workspaceId: "work", title: "Safe intake", acceptanceCriteria: "Only one task", expectedRevision: 0 };
  const unknown = await f.invoke("pipeline.intake", input); assert.equal(unknown.mode, "blocked"); assert.equal(created.size, 1);
  const retried = await f.invoke("pipeline.intake", input); assert.equal(retried.intake.phase, "created"); assert.equal(created.size, 1); assert.equal(new Set(requests).size, 1);
  await assert.rejects(f.invoke("pipeline.intake", { ...input, title: "Different work" }), /different details/);
  assert.equal((await createFleetStore(f.file).read()).pipelines[0].taskId, `task_${input.requestId}`);
});
test("intake refuses an old host capability or unavailable workspace before creating anything", async t => {
  const f = await fixture(t); const methods = [];
  t.mock.method(transport, "invokeChatHost", async (_serverId, method) => { methods.push(method); throw new Error("RPC not found: pipeline.capabilities"); });
  const input = { requestId: "33333333-0000-4000-8000-000000000003", coordinatorId: "coordinator", remoteServerId: "remote", workspaceId: "work", title: "Safe intake", acceptanceCriteria: "Only one task", expectedRevision: 0 };
  await assert.rejects(f.invoke("pipeline.intake", input), /RPC not found/); assert.deepEqual(methods, ["pipeline.capabilities"]); assert.equal((await f.store.read()).pipelines.length, 0);
  await assert.rejects(f.invoke("pipeline.intake", { ...input, workspaceId: "missing" }), /available project workspace/); assert.equal(methods.length, 1);
});
test("chat status and controls never select another coordinator or host", async t => {
  const f = await fixture(t); const input = { coordinatorId: "coordinator", remoteServerId: "remote", taskId, expectedRevision: 0 }; await f.invoke("pipeline.start", input);
  t.mock.method(transport, "invokeChatHost", async (serverId, method, body) => { assert.equal(serverId, "personal"); if (method === "orchestrator.fleet.read") return f.snapshot(); return f.invoke(method, body); });
  const context = { local: "personal", target: "remote", agentId: "coordinator", label: "Remote", orchestrator: true };
  const status = await managePipelineChat(`pipeline ${taskId}`, context); assert.match(status.text, /Example/);
  const other = await managePipelineChat(`pipeline ${taskId}`, { ...context, orchestrator: false }); assert.match(other.text, /coordinator chat/);
  await assert.rejects(managePipelineChat(`stop pipeline ${taskId}`, { ...context, agentId: "someone-else" }), /no longer manages/);
  assert.equal((await f.store.read()).pipelines[0].mode, "running");
  await managePipelineChat(`pause pipeline ${taskId}`, context); assert.equal((await f.store.read()).pipelines[0].mode, "paused");
});
