import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { test } from "node:test";
const require = createRequire(import.meta.url), ts = require("typescript");
require.extensions[".ts"] = (module, file) => module._compile(ts.transpileModule(readFileSync(file, "utf8"), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText, file);
const { manageChatCommand } = require("./chat-management.ts"), transport = require("./chat-transport.ts");
const context = { local: "personal", target: "CNS", agentId: "coordinator", label: "CNS", orchestrator: true };
const worker = { id: "worker", name: "CN-123 worker", workspaceId: "w", status: "idle", archivedAt: null, labels: { "mission-control.task-id": "task_a" }, updatedAt: "now", activityAt: null, pendingPermissions: 0, attention: false, attentionReason: null, error: null, inputTokens: null, outputTokens: null };
const task = { schemaVersion: 1, taskId: "task_a", hostId: "CNS", projectId: "p", title: "CN-123 · Fix discount", acceptanceCriteria: "Prevent duplicate", status: "ready", source: "manual", assignments: [{ serverId: "CNS", workspaceId: "w" }], createdAt: "now", updatedAt: "now" };
const host = () => ({ serverId: "CNS", observedAt: "now", agents: [structuredClone(worker)], workspaces: [], tasks: [{ task: structuredClone(task), run: null, decisions: [], questions: [], problem: null }], warnings: [], complete: true, stoppedAgentIds: [] });
const reopenedAt = "2026-11-17T20:12:00.000Z";
const mergedPR = { forge: "github", repository: "example/repo", url: "https://example.test/pr/4", number: 4, targetBranch: "main", taskBranch: "fix", head: "a".repeat(40), createdAt: "then", mergedAt: reopenedAt };
function reopenFixture(t) {
  const current = host(), original = current.tasks[0].task;
  original.status = "delivered"; original.pullRequest = mergedPR;
  const owner = { agentId: context.agentId, workspaceId: "orchestrator", name: "Coordinator", remoteServerId: "CNS", hostLabel: "CNS", agent: worker, links: [] };
  const fleet = { serverId: "personal", observedAt: "now", coordinators: [owner], hosts: [], warnings: [], state: { schemaVersion: 1, revision: 7, paused: false, coordinators: [], queue: [], events: [], stoppedAgentIds: [], seen: {}, pipelines: [] } };
  const calls = [];
  t.mock.method(transport, "invokeChatHost", async (server, name, input) => {
    calls.push({ server, name, input });
    if (name === "orchestrator.host.snapshot") return current;
    if (name === "orchestrator.fleet.read") return fleet;
    if (name === "tasks.reopen-delivered") {
      const fix = { ...original, status: "ready", pullRequest: undefined, assignments: [...original.assignments, { serverId: "CNS", workspaceId: "new-worktree" }],
        worktree: { sourceWorkspaceId: "w", workspaceId: "new-worktree", branch: "fix/2", baseCommit: "b".repeat(40), createdAt: reopenedAt }, updatedAt: reopenedAt,
        deliveryHistory: [{ pullRequest: mergedPR, reason: input.reason, reopenedAt, previousRevision: original.updatedAt }] };
      current.tasks[0].task = fix;
      return fix;
    }
    assert.equal(name, "pipeline.reopened.start");
    return { ...input, id: "12345678-1234-4123-8123-123456789012", mode: "running", stage: "plan", workflow: "standard", workflowMode: "automatic", title: original.title, runId: null, message: "Starting fix", updatedAt: reopenedAt, repairs: 0, repairIds: [], lastDispatch: null, lastSentAt: null, date: "", wakeups: 0, pending: null };
  });
  return { current, original, fleet, calls };
}

test("reopen in a bound coordinator chat verifies the owner revision, starts the exact reopening and retries enrollment without reopening again", async t => {
  const f = reopenFixture(t);
  const result = await manageChatCommand("reopen task_a QA found a rounding error", context);
  assert.match(result.text, /Standard fix enrolled/);
  assert.deepEqual(f.calls.find(c => c.name === "tasks.reopen-delivered"), { server: "CNS", name: "tasks.reopen-delivered", input: { serverId: "CNS", workspaceId: "w", taskId: "task_a", expectedUpdatedAt: "now", reason: "QA found a rounding error" } });
  assert.deepEqual(f.calls.at(-1), { server: "personal", name: "pipeline.reopened.start", input: { coordinatorId: context.agentId, remoteServerId: "CNS", taskId: "task_a", reopenedAt, expectedRevision: 7 } });
  f.calls.length = 0;
  assert.match((await manageChatCommand("reopen task_a QA found a rounding error", context)).text, /enrolled/);
  assert.ok(!f.calls.some(c => c.name === "tasks.reopen-delivered"));
  f.calls.length = 0;
  assert.match((await manageChatCommand("reopen task_a another issue", context)).text, /existing fix/);
  assert.ok(f.calls.every(c => c.name.startsWith("orchestrator.")));
});

test("host-local reopen retains a ready fix when its coordinator is unreachable and stale bindings cannot mutate another host", async t => {
  const f = reopenFixture(t);
  f.fleet.coordinators = [];
  await assert.rejects(manageChatCommand("reopen task_a found a bug", context), /no longer coordinates/);
  assert.ok(f.calls.every(c => c.name === "orchestrator.fleet.read"));
  f.fleet.serverId = "CNS";
  const receipt = await manageChatCommand("reopen task_a found a bug", { ...context, orchestrator: false, local: "CNS" });
  assert.match(receipt.text, /Task reopened.*Start fix/);
  assert.ok(!f.calls.some(c => c.name === "pipeline.reopened.start"));
});

test("adopt keeps task identity and only links an exactly associated existing worker", async t => {
  const current = host(), calls = [];
  t.mock.method(transport, "invokeChatHost", async (serverId, method, input) => {
    calls.push({ serverId, method, input });
    if (method === "orchestrator.host.snapshot") return current;
    assert.equal(serverId, "personal"); assert.equal(method, "orchestrator.work.set");
    return { links: [{ ...input, linkedAt: "now" }] };
  });
  const result = await manageChatCommand("adopt task_a", context); assert.match(result.text, /Linked CN-123 worker/);
  assert.equal(calls[1].input.taskId, "task_a"); assert.equal(calls[1].input.remoteAgentId, "worker"); assert.equal(calls[1].input.agentId, "coordinator");
  current.agents[0].archivedAt = "yesterday"; calls.length = 0;
  const retired = await manageChatCommand("adopt task_a", context); assert.match(retired.text, /No active worker/); assert.equal(calls.length, 1);
});
test("adopt never guesses among multiple task workers or revives completed tasks", async t => {
  const current = host(); current.agents.push({ ...worker, id: "worker2" }); let writes = 0;
  t.mock.method(transport, "invokeChatHost", async (_server, method) => { if (method !== "orchestrator.host.snapshot") writes++; return current; });
  assert.match((await manageChatCommand("adopt task_a", context)).text, /Choose the worker/); assert.equal(writes, 0);
  current.tasks[0].task.status = "delivered";
  assert.match((await manageChatCommand("adopt task_a worker worker", context)).text, /completed/); assert.equal(writes, 0);
});
