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
  const others = []; const snapshot = async () => ({ serverId: "personal", observedAt: at, coordinators: [coordinator, ...others], hosts: [{ serverId: "remote", label: "Remote", snapshot: host, error: null }], state: await store.read(), warnings: [] });
  const deps = { decisions: async () => ({ open: [], recent: [] }), questions: async () => ({ questions: [] }), stoppedAgents: async () => [] };
  const engine = registerPipelineRuntime({ handle: (contract, handler) => handlers.set(contract.name, handler) }, store, deps, snapshot, async (...args) => calls.push(args), () => {}); t.after(() => engine.stop());
  t.mock.method(names, "daemonServerId", async () => "personal");
  const invoke = async (method, input) => handlers.get(method)(input);
  return { file, store, task, host, coordinator, others, snapshot, calls, invoke };
}
function bindExistingRun(f, extra = {}) {
  f.task.run = { schemaVersion: 1, runId: "run_11111111-0000-4000-8000-000000000002", taskId, hostId: "remote", projectId: "project", serverId: "remote", workspaceId: "work", stage: "execute", outcome: "completed", createdAt: at, updatedAt: at, nextAction: "Continue the approved scope", agentId: "worker", gitHead: null, gitDirty: false, gitChanges: [], omittedChanges: 0, ...extra };
  f.host.agents.push(agent("worker", "work"));
  f.coordinator.links.push({ serverId: "personal", agentId: "coordinator", remoteServerId: "remote", remoteAgentId: "worker", remoteWorkspaceId: "work", taskId, linkedAt: at });
}

test("starting an existing manual run cannot opt it into automatic or change its deliverable", async t => {
  const f = await fixture(t); bindExistingRun(f);
  f.task.decisions = [{ decision: { kind: "plan", status: "approved", runId: f.task.run.runId, plan: { revision: "approved-plan" } } }];
  const original = structuredClone(f.task); const remote = [];
  t.mock.method(transport, "invokeChatHost", async (_host, method) => { remote.push(method); throw new Error("No capability lookup expected for refused transition"); });
  const input = { coordinatorId: "coordinator", remoteServerId: "remote", taskId, expectedRevision: 0 };
  await assert.rejects(f.invoke("pipeline.start", { ...input, workflowMode: "automatic", deliveryKind: "code" }), /switch a manual run to automatic checks in one step/);
  await assert.rejects(f.invoke("pipeline.start", { ...input, workflowMode: "automatic", deliveryKind: "actions" }), /existing workflow/);
  assert.equal((await f.store.read()).pipelines.length, 0); assert.deepEqual(f.task, original); assert.equal(remote.length, 0);
  const row = await f.invoke("pipeline.start", input);
  assert.equal(row.workflowMode, "manual"); assert.equal(row.deliveryKind, "code"); assert.equal(row.runId, f.task.run.runId); assert.deepEqual(f.task, original);
});

test("automatic starts still work for new tasks and preserve already automatic runs", async t => {
  for (const existing of [false, true]) {
    const f = await fixture(t); if (existing) bindExistingRun(f, { workflowMode: "automatic", deliveryKind: "actions" });
    t.mock.method(transport, "invokeChatHost", async serverId => ({ serverId, version: 1, idempotentIntake: true, automaticWorkflow: true, actionBundles: true }));
    const input = { coordinatorId: "coordinator", remoteServerId: "remote", taskId, expectedRevision: 0, workflowMode: "automatic", deliveryKind: "actions" };
    if (existing) {
      await assert.rejects(f.invoke("pipeline.start", { ...input, deliveryKind: "code" }), /recorded deliverable/);
      await assert.rejects(f.invoke("pipeline.start", { ...input, workflowMode: "manual", deliveryKind: "code" }), /existing workflow/);
    }
    const row = await f.invoke("pipeline.start", input); assert.equal(row.workflowMode, "automatic"); assert.equal(row.deliveryKind, "actions");
  }
});

test("chat starts preserve legacy manual runs and only default new tasks to automatic", async t => {
  for (const existing of [false, true]) {
    const f = await fixture(t); if (existing) bindExistingRun(f);
    const requests = [];
    t.mock.method(transport, "invokeChatHost", async (serverId, method, input) => {
      if (method === "orchestrator.fleet.read") return f.snapshot();
      if (method === "pipeline.capabilities") return { serverId, version: 1, idempotentIntake: true, automaticWorkflow: true, actionBundles: true, taskWorktrees: true, supersedeDecisions: true };
      requests.push(input); return f.invoke(method, input);
    });
    const response = await managePipelineChat(`run to draft PR ${taskId}`, { local: "personal", target: "remote", agentId: "coordinator", label: "Remote", orchestrator: true });
    assert.equal(requests[0].workflowMode, existing ? "manual" : "automatic"); assert.equal(requests[0].deliveryKind, "code");
    assert.match(response.text, existing ? /keeps its human plan and code-review approvals/ : /Independent plan check/);
  }
});

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
test("automatic enrollment requires host support and manual non-code is rejected before mutation", async t => {
  const f = await fixture(t); const input = { coordinatorId: "coordinator", remoteServerId: "remote", taskId, expectedRevision: 0 };
  const remote = [];
  t.mock.method(transport, "invokeChatHost", async (serverId, method) => { remote.push(method); return { serverId, version: 1, idempotentIntake: true }; });
  await assert.rejects(f.invoke("pipeline.start", { ...input, workflowMode: "manual", deliveryKind: "actions" }), /Non-code/);
  await assert.rejects(f.invoke("pipeline.intake", { ...input, requestId: "33333333-0000-4000-8000-000000000003", workspaceId: "work", title: "Actions", acceptanceCriteria: "Exact bundle", workflowMode: "manual", deliveryKind: "report" }), /Non-code/);
  assert.equal(remote.length, 0);
  await assert.rejects(f.invoke("pipeline.start", { ...input, workflowMode: "automatic", deliveryKind: "code" }), /Update this host/);
  assert.equal((await f.store.read()).pipelines.length, 0);
});

const fullCapability = serverId => ({ serverId, version: 1, idempotentIntake: true, automaticWorkflow: true, actionBundles: true, taskWorktrees: true, supersedeDecisions: true });

test("legacy runner remains manual until explicit paused adoption, which retires its open requests without approving them", async t => {
  const f = await fixture(t); const input = { coordinatorId: "coordinator", remoteServerId: "remote", taskId, expectedRevision: 0 };
  const row = await f.invoke("pipeline.start", input); assert.equal(row.workflowMode, "manual");
  const adopt = revision => f.invoke("pipeline.control", { id: row.id, action: "adopt-automatic", expectedRevision: revision });
  await assert.rejects(adopt(1), /Pause the manual/);
  await f.invoke("pipeline.control", { id: row.id, action: "pause", expectedRevision: 1 });
  f.host.agents.push({ ...agent("busy", "work"), pendingPermissions: 1 });
  await assert.rejects(adopt(2), /current worker or permission/); f.host.agents = [];
  const remote = [];
  t.mock.method(transport, "invokeChatHost", async (serverId, method, body) => { remote.push([method, body]); return method === "decisions.supersede" ? { superseded: [] } : { serverId, version: 1, idempotentIntake: true, automaticWorkflow: true, actionBundles: true }; });
  f.task.decisions = [{ decision: { decisionId: "decision_open-plan", kind: "plan", status: "open", runId: "run-x", requestedAt: at } }];
  await assert.rejects(adopt(2), /Update this host/, "a host that can't retire requests is refused before anything changes");
  assert.ok(!remote.some(([method]) => method === "decisions.supersede"));
  remote.length = 0;
  t.mock.method(transport, "invokeChatHost", async (serverId, method, body) => { remote.push([method, body]); return method === "decisions.supersede" ? { superseded: [] } : fullCapability(serverId); });
  await assert.rejects(adopt(1), /changed/);
  const automatic = await adopt(2); assert.equal(automatic.workflowMode, "automatic"); assert.equal(automatic.deliveryKind, "code"); assert.equal(automatic.stage, "plan"); assert.equal(automatic.lastDispatch, null);
  const retire = remote.find(([method]) => method === "decisions.supersede");
  assert.deepEqual(retire[1].decisionIds, ["decision_open-plan"]); assert.equal(retire[1].taskId, taskId); assert.match(retire[1].note, /Not approved/);
  assert.ok(!remote.some(([method]) => method === "decisions.resolve"), "nothing is approved or resolved"); assert.equal(f.calls.length, 0);
  assert.deepEqual(automatic.retiredWorkerIds, []);
});

test("one-step adoption switches a manual run without ever enrolling a manual runner", async t => {
  const f = await fixture(t); bindExistingRun(f);
  f.task.task.worktree = { workspaceId: "work", branch: "feature/example", baseCommit: "a".repeat(40), sourceWorkspaceId: "project", createdAt: at };
  f.task.decisions = [{ decision: { decisionId: "decision_open-review", kind: "review", status: "open", runId: f.task.run.runId, requestedAt: at } }];
  f.coordinator.links.push({ serverId: "personal", agentId: "coordinator", remoteServerId: "remote", remoteAgentId: "archived-reviewer", remoteWorkspaceId: "work", taskId, linkedAt: at });
  const remote = [];
  t.mock.method(transport, "invokeChatHost", async (serverId, method, body) => { remote.push([method, body]); return method === "decisions.supersede" ? { superseded: [] } : fullCapability(serverId); });
  const input = { coordinatorId: "coordinator", remoteServerId: "remote", taskId, workflowMode: "automatic", deliveryKind: "code", adoptExisting: true };
  await assert.rejects(f.invoke("pipeline.start", { ...input, expectedRevision: 5 }), /fleet changed/);
  const row = await f.invoke("pipeline.start", { ...input, expectedRevision: 0 });
  assert.equal(row.workflowMode, "automatic"); assert.equal(row.mode, "running"); assert.equal(row.runId, null);
  assert.deepEqual(row.retiredWorkerIds, ["archived-reviewer", "worker"], "earlier workers, including a missing one, no longer gate stages");
  assert.deepEqual(remote.find(([method]) => method === "decisions.supersede")[1].decisionIds, ["decision_open-review"]);
  const state = await f.store.read(); assert.equal(state.pipelines.length, 1); assert.equal(state.pipelines[0].workflowMode, "automatic");
  await assert.rejects(f.invoke("pipeline.start", { ...input, expectedRevision: state.revision }), /already owns this task/);
});

test("one-step adoption refuses a shared-checkout run, a missing worktree, a human stop and another coordinator's task before retiring anything", async t => {
  const f = await fixture(t); bindExistingRun(f);
  const remote = [];
  t.mock.method(transport, "invokeChatHost", async (serverId, method, body) => { remote.push(method); return fullCapability(serverId); });
  const input = { coordinatorId: "coordinator", remoteServerId: "remote", taskId, workflowMode: "automatic", deliveryKind: "code", adoptExisting: true, expectedRevision: 0 };
  await assert.rejects(f.invoke("pipeline.start", input), /shared project checkout/);
  f.task.task.worktree = { workspaceId: "gone", branch: "feature/example", baseCommit: "a".repeat(40), sourceWorkspaceId: "project", createdAt: at };
  await assert.rejects(f.invoke("pipeline.start", input), /worktree workspace gone is missing/);
  f.task.task.worktree = { workspaceId: "work", branch: "feature/example", baseCommit: "a".repeat(40), sourceWorkspaceId: "project", createdAt: at };
  f.task.decisions = [{ decision: { decisionId: "decision_stop", kind: "plan", status: "blocked", runId: f.task.run.runId, requestedAt: at } }];
  await assert.rejects(f.invoke("pipeline.start", input), /your stop or change request/);
  f.task.decisions = [];
  // Another orchestrator chat on the same host already manages the task through its own link.
  f.others.push({ ...f.coordinator, agentId: "rival", agent: agent("rival", "folder"), links: [{ serverId: "personal", agentId: "rival", remoteServerId: "remote", remoteAgentId: "worker", remoteWorkspaceId: "work", taskId, linkedAt: at }] });
  await assert.rejects(f.invoke("pipeline.start", input), /Another coordinator manages this task/);
  assert.ok(!remote.includes("decisions.supersede"));
  assert.equal((await f.store.read()).pipelines.length, 0);
});

test("switching a waiting manual runner pauses it first, then writes against the latest revision after retiring requests", async t => {
  const f = await fixture(t); const row = await f.invoke("pipeline.start", { coordinatorId: "coordinator", remoteServerId: "remote", taskId, expectedRevision: 0 });
  await f.store.update(state => { state.pipelines[0].mode = "waiting"; });
  const before = await f.store.read();
  const seen = [];
  t.mock.method(transport, "invokeChatHost", async (serverId, method) => {
    if (method === "decisions.supersede") {
      // By the time requests are retired, the runner is paused, so the engine can't serve the manual flow meanwhile.
      seen.push((await f.store.read()).pipelines[0].mode);
      // Another fleet write lands between retiring the requests and switching the runner.
      await f.store.update(state => { state.events = state.events ?? []; });
      return { superseded: [] };
    }
    return fullCapability(serverId);
  });
  f.task.decisions = [{ decision: { decisionId: "decision_open", kind: "plan", status: "open", runId: "run-x", requestedAt: at } }];
  const switched = await f.invoke("pipeline.control", { id: row.id, action: "adopt-automatic", expectedRevision: before.revision });
  assert.deepEqual(seen, ["paused"]);
  assert.equal(switched.workflowMode, "automatic"); assert.equal(switched.mode, "running");
});

test("several automatic runners can queue on one host; a task and a manual runner stay single", async t => {
  const f = await fixture(t);
  const second = structuredClone(f.task); second.task.taskId = "task_11111111-0000-4000-8000-000000000009"; second.task.title = "Second"; f.host.tasks.push(second);
  t.mock.method(transport, "invokeChatHost", async serverId => fullCapability(serverId));
  const first = await f.invoke("pipeline.start", { coordinatorId: "coordinator", remoteServerId: "remote", taskId, workflowMode: "automatic", deliveryKind: "code", expectedRevision: 0 });
  const next = await f.invoke("pipeline.start", { coordinatorId: "coordinator", remoteServerId: "remote", taskId: second.task.taskId, workflowMode: "automatic", deliveryKind: "code", expectedRevision: 1 });
  assert.equal(first.workflowMode, "automatic"); assert.equal(next.workflowMode, "automatic");
  await assert.rejects(f.invoke("pipeline.start", { coordinatorId: "coordinator", remoteServerId: "remote", taskId, workflowMode: "automatic", deliveryKind: "code", expectedRevision: 2 }), /already owns this task/);
  const third = structuredClone(f.task); third.task.taskId = "task_11111111-0000-4000-8000-00000000000a"; f.host.tasks.push(third);
  const manual = await f.invoke("pipeline.start", { coordinatorId: "coordinator", remoteServerId: "remote", taskId: third.task.taskId, expectedRevision: 2 });
  assert.equal(manual.workflowMode, "manual", "a manual runner may join automatic ones");
  const fourth = structuredClone(f.task); fourth.task.taskId = "task_11111111-0000-4000-8000-00000000000b"; f.host.tasks.push(fourth);
  await assert.rejects(f.invoke("pipeline.start", { coordinatorId: "coordinator", remoteServerId: "remote", taskId: fourth.task.taskId, expectedRevision: 3 }), /manual runner already owns/);
  assert.equal((await f.store.read()).pipelines.length, 3);
});

test("adoption rejects unresolved current human stops and resets both budgets only on successful opt-in", async t => {
  const f = await fixture(t); const row = await f.invoke("pipeline.start", { coordinatorId: "coordinator", remoteServerId: "remote", taskId, expectedRevision: 0 });
  await f.store.update(state => { Object.assign(state.pipelines[0], { mode: "paused", repairs: 2, repairIds: ["manual-one", "manual-two"], planRepairs: 1, planRepairIds: ["old-plan"] }); });
  f.task.run = { runId: "run-current" };
  f.task.task.worktree = { workspaceId: "work", branch: "feature/example", baseCommit: "a".repeat(40), sourceWorkspaceId: "project", createdAt: at };
  const adopt = () => f.invoke("pipeline.control", { id: row.id, action: "adopt-automatic", expectedRevision: 2 });
  for (const status of ["changes_requested", "blocked"]) {
    f.task.decisions = [{ decision: { kind: "plan", status, runId: "run-current", requestedAt: "2026-11-03T00:00:01Z" } }];
    await assert.rejects(adopt(), /revised manual plan\/review/); assert.equal((await f.store.read()).pipelines[0].repairs, 2);
  }
  f.task.decisions.push({ decision: { kind: "plan", status: "approved", runId: "run-current", requestedAt: "2026-11-03T00:00:02Z" } });
  f.task.decisions.push({ decision: { kind: "review", status: "changes_requested", runId: "older-run", requestedAt: "2026-11-03T00:00:03Z" } });
  t.mock.method(transport, "invokeChatHost", async serverId => fullCapability(serverId));
  const automatic = await adopt(); assert.equal(automatic.repairs, 0); assert.deepEqual(automatic.repairIds, []); assert.equal(automatic.planRepairs, 0); assert.deepEqual(automatic.planRepairIds, []);
  assert.equal(f.task.decisions.length, 3); assert.equal(f.task.decisions[0].decision.status, "blocked", "historical decision remains intact");
});

test("automate pipeline switches an unenrolled manual run in one step, and points a run-less task to run to draft PR", async t => {
  const f = await fixture(t);
  const remote = [];
  t.mock.method(transport, "invokeChatHost", async (serverId, method, body) => {
    if (method === "orchestrator.fleet.read") return f.snapshot();
    if (method === "pipeline.capabilities") return fullCapability(serverId);
    if (method === "decisions.supersede") { remote.push(body); return { superseded: [] }; }
    return f.invoke(method, body);
  });
  const context = { local: "personal", target: "remote", agentId: "coordinator", label: "Remote", orchestrator: true };
  const runless = await managePipelineChat(`automate pipeline ${taskId}`, context);
  assert.match(runless.text, /no run yet\. Use run to draft PR/); assert.equal((await f.store.read()).pipelines.length, 0);
  bindExistingRun(f); f.task.task.worktree = { workspaceId: "work", branch: "feature/example", baseCommit: "a".repeat(40), sourceWorkspaceId: "project", createdAt: at };
  // Retiring open requests is covered above; the chat path itself must switch in one step.
  const switched = await managePipelineChat(`automate pipeline ${taskId}`, context);
  assert.match(switched.text, /Switched to the automatic workflow/); assert.match(switched.text, /retired without approval/);
  const [row] = (await f.store.read()).pipelines; assert.equal(row.workflowMode, "automatic"); assert.equal(row.mode, "running");
  assert.deepEqual(remote, [], "no open requests, so nothing to retire");
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
