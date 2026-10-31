import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { test } from "node:test";
const require = createRequire(import.meta.url), ts = require("typescript");
require.extensions[".ts"] = (module, file) => module._compile(ts.transpileModule(readFileSync(file, "utf8"), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText, file);
const { registerIntake } = require("./intake.ts"), transport = require("./chat-transport.ts");
const { captureIntake, routeIntake } = require("../shared/intake.ts");
const request = { requestId: "11111111-0000-4000-8000-000000000001", coordinatorId: "coordinator", remoteServerId: "remote", workspaceId: "work", title: "Fix invoices", acceptanceCriteria: "No duplicates", action: "backlog" };
function fixture(t) {
  const now = new Date().toISOString(), handlers = new Map(), calls = [], created = new Map();
  const host = { serverId: "remote", observedAt: now, complete: true, warnings: [], workspaces: [{ id: "work", name: "Work", projectName: "Project", status: "idle" }], tasks: [] };
  const state = { schemaVersion: 1, revision: 7, paused: true, coordinators: [], queue: [], pipelines: [], events: [], seen: {}, stoppedAgentIds: [] };
  const fleet = { serverId: "personal", coordinators: [{ agentId: "coordinator", remoteServerId: "remote" }], hosts: [{ serverId: "remote", snapshot: host, error: null }], state };
  let invalidated = 0, drop = false, capability = true, scheduleError = false;
  registerIntake({ handle: (contract, handler) => handlers.set(contract.name, handler) }, async () => fleet, () => invalidated++);
  t.mock.method(transport, "invokeChatHost", async (serverId, method, input) => {
    calls.push({ serverId, method, input });
    if (method === "pipeline.capabilities") return { serverId, version: 1, idempotentIntake: capability };
    if (method === "tasks.create") {
      assert.equal(serverId, "remote");
      if (!created.has(input.requestId)) {
        const task = { schemaVersion: 1, taskId: `task_${input.requestId}`, hostId: "remote", projectId: "project", title: input.title, acceptanceCriteria: input.acceptanceCriteria, status: "ready", source: "manual", assignments: [{ serverId, workspaceId: input.workspaceId }], createdAt: now, updatedAt: now };
        created.set(input.requestId, task); host.tasks.push({ task, run: null, problem: null });
      }
      if (drop) { drop = false; throw new Error("Connection lost after creation"); }
      return created.get(input.requestId);
    }
    assert.equal(serverId, "personal");
    if (scheduleError) throw new Error("Fleet revision changed");
    if (method === "orchestrator.queue.set") { assert.equal(input.expectedRevision, 7); return state; }
    throw new Error(`Unexpected operation ${method}`);
  });
  return { host, fleet, state, calls, created, capture: input => handlers.get(captureIntake.name)(captureIntake.input.parse(input)), route: input => handlers.get(routeIntake.name)(routeIntake.input.parse(input)), loseReply: () => { drop = true; }, oldHost: () => { capability = false; }, failScheduling: () => { scheduleError = true; }, invalidated: () => invalidated };
}
test("backlog intake creates on the exact host without enrolling work or changing pause state", async t => {
  const f = fixture(t), result = await f.capture(request);
  assert.equal(result.completed, true); assert.equal(result.taskId, `task_${request.requestId}`);
  assert.deepEqual(f.calls.map(c => c.method), ["pipeline.capabilities", "tasks.create"]);
  assert.equal(f.state.paused, true); assert.equal(f.state.queue.length, 0); assert.ok(f.invalidated());
});
test("lost creation response retries the same request and leaves one task", async t => {
  const f = fixture(t); f.loseReply();
  await assert.rejects(f.capture(request), /Connection lost/);
  const result = await f.capture(request);
  assert.equal(f.created.size, 1); assert.equal(result.taskId, `task_${request.requestId}`);
  assert.equal(new Set(f.calls.filter(c => c.method === "tasks.create").map(c => c.input.requestId)).size, 1);
});
test("queue uses current revision and explicitly reports a paused heartbeat", async t => {
  const f = fixture(t), result = await f.capture({ ...request, action: "queue" });
  assert.equal(result.completed, true); assert.match(result.message, /paused or not enrolled/);
  assert.equal(f.calls.at(-1).method, "orchestrator.queue.set"); assert.equal(f.state.paused, true);
  assert.ok(!f.calls.some(c => /configure|pause|resolve|agent/.test(c.method)));
});
test("scheduling failure preserves the created task and returns an incomplete receipt", async t => {
  const f = fixture(t); f.failScheduling();
  const result = await f.capture({ ...request, action: "plan" });
  assert.equal(result.completed, false); assert.equal(f.created.size, 1); assert.match(result.message, /scheduling is not confirmed/);
  assert.equal(result.taskId, `task_${request.requestId}`); assert.equal(f.calls.at(-1).method, "pipeline.start");
});
test("an existing paused runner is reported without launching or resuming another", async t => {
  const f = fixture(t), saved = await f.capture(request); f.calls.length = 0;
  f.state.pipelines.push({ remoteServerId: "remote", taskId: saved.taskId, mode: "paused", stage: "plan", message: "Paused by user" });
  const result = await f.route({ coordinatorId: request.coordinatorId, remoteServerId: request.remoteServerId, taskId: saved.taskId, action: "plan" });
  assert.match(result.message, /paused/); assert.equal(f.calls.length, 0);
});
test("wrong host, coordinator, stale records and missing workspaces stop before writes", async t => {
  const f = fixture(t);
  for (const input of [{ ...request, remoteServerId: "other" }, { ...request, coordinatorId: "other" }, { ...request, workspaceId: "other" }]) await assert.rejects(f.capture(input));
  f.host.observedAt = "2020-01-01T00:00:00Z"; await assert.rejects(f.capture(request), /Refresh/);
  assert.equal(f.calls.length, 0);
});
test("old host and tasks past planning are never silently restarted", async t => {
  const f = fixture(t); f.oldHost(); await assert.rejects(f.capture(request), /Update Mission Control/);
  assert.equal(f.created.size, 0);
  f.host.tasks.push({ task: { taskId: "task_a", title: "Done", status: "delivered" }, problem: null, run: null });
  await assert.rejects(f.route({ coordinatorId: "coordinator", remoteServerId: "remote", taskId: "task_a", action: "plan" }), /progressed beyond intake/);
});
