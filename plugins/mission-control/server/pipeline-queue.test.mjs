import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { automaticFixture } from "./automatic-pipeline-fixture.mjs";
const require = createRequire(import.meta.url); const ts = require("typescript");
require.extensions[".ts"] = (module, file) => module._compile(ts.transpileModule(readFileSync(file, "utf8"), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText, file);
const { createPipelineEngine } = require("./pipeline-engine.ts");
const { createFleetStore } = require("./fleet-store.ts");
const { sharedCheckoutMessage } = require("../shared/pipeline-model.ts");

const at = "2026-11-09T12:00:00.000Z";
const agent = (id, extra = {}) => ({ id, name: id, workspaceId: "work", status: "idle", archivedAt: null, labels: {}, updatedAt: at, activityAt: at, pendingPermissions: 0, attention: false, attentionReason: null, error: null, inputTokens: null, outputTokens: null, ...extra });

/** An automatic code task: with a run it is ready to build; without one it still needs its own worktree and a plan. */
function automaticTask(taskId, { run = true, worktree = true } = {}) {
  const { facts, row } = automaticFixture();
  facts.entry.task.taskId = taskId; facts.entry.task.title = `Task ${taskId}`;
  if (!worktree) delete facts.entry.task.worktree;
  if (run) {
    facts.entry.run.taskId = taskId; facts.entry.run.agentId = `worker-${taskId}`;
    facts.checkpoints = facts.checkpoints.filter(item => item.stage === "plan-review").map(item => ({ ...item, taskId }));
  } else {
    facts.entry.run = null; facts.planRevision = null; facts.submittedPlan = null; facts.checkpoints = []; facts.candidate = null;
  }
  return { facts, row: { ...row, id: randomUUID(), taskId, title: facts.entry.task.title, stage: run ? "execute" : "plan", runId: run ? facts.entry.run.runId : null } };
}

/** Hosts by server ID, each with its own coordinator chat and its tasks' runners in enrollment order. */
async function fleet(t, layout) {
  const directory = await mkdtemp(join(tmpdir(), "mc-queue-")); t.after(() => rm(directory, { recursive: true, force: true }));
  const store = createFleetStore(join(directory, "fleet.json"));
  let clock = Date.parse(at);
  const facts = new Map(); const hosts = new Map(); const coordinators = [];
  for (const [serverId, tasks] of Object.entries(layout)) {
    const host = { serverId, observedAt: at, agents: [], workspaces: [{ id: "work", name: "Work", projectName: "Project", labels: [], status: "idle" }], tasks: [], warnings: [], complete: true, stoppedAgentIds: [] };
    const coordinator = { agentId: `coord-${serverId}`, workspaceId: `folder-${serverId}`, name: "Coordinator", remoteServerId: serverId, hostLabel: serverId, agent: agent(`coord-${serverId}`, { workspaceId: `folder-${serverId}` }), links: [] };
    for (const { taskId, ...options } of tasks) {
      const made = automaticTask(taskId, options);
      made.facts.entry.task.assignments = [{ serverId, workspaceId: "work" }];
      if (made.facts.entry.run) made.facts.entry.run.serverId = serverId;
      host.tasks.push(made.facts.entry); facts.set(taskId, made.facts);
      if (made.facts.entry.run) {
        host.agents.push(agent(`worker-${taskId}`));
        coordinator.links.push({ serverId: "personal", agentId: coordinator.agentId, remoteServerId: serverId, remoteAgentId: `worker-${taskId}`, remoteWorkspaceId: "work", taskId, linkedAt: at });
      }
      await store.update(state => { state.pipelines.push({ ...made.row, coordinatorId: coordinator.agentId, remoteServerId: serverId }); });
    }
    hosts.set(serverId, host); coordinators.push(coordinator);
  }
  const dispatched = []; const prepared = [];
  const deps = {
    store, now: () => clock,
    snapshot: async () => ({ serverId: "personal", observedAt: new Date(clock).toISOString(), coordinators, warnings: [], state: await store.read(),
      hosts: [...hosts.values()].map(host => ({ serverId: host.serverId, label: host.serverId, snapshot: { ...host, observedAt: new Date(clock).toISOString() }, error: null })) }),
    inspect: async row => structuredClone(facts.get(row.taskId)),
    dispatch: async row => { dispatched.push(row.taskId); return { agentId: `stage-${row.taskId}`, runId: "run_a" }; },
    send: async () => { throw new Error("automatic runners never prompt the coordinator"); },
    prepare: async () => {},
    prepareWorktree: async row => { prepared.push(row.taskId); return { phase: "creating", message: "Creating the task's worktree." }; },
  };
  const engine = createPipelineEngine(deps); t.after(() => engine.stop());
  const row = async taskId => (await store.read()).pipelines.find(item => item.taskId === taskId);
  return { store, engine, deps, hosts, coordinators, facts, dispatched, prepared, row, advance: minutes => { clock += minutes * 60_000; } };
}

test("hosts run in parallel: one stage dispatch per host in the same cycle, with no fleet-wide cap", async t => {
  const f = await fleet(t, { a: [{ taskId: "task_a1" }], b: [{ taskId: "task_b1" }], c: [{ taskId: "task_c1" }] });
  await f.engine.tick();
  assert.deepEqual(f.dispatched.sort(), ["task_a1", "task_b1", "task_c1"]);
});

test("a host runs one stage at a time and serves its queue in enrollment order", async t => {
  const f = await fleet(t, { a: [{ taskId: "task_first" }, { taskId: "task_second" }] });
  await f.engine.tick();
  assert.deepEqual(f.dispatched, ["task_first"], "only the first-enrolled task starts this cycle");
  // While a stage worker runs on the host, nothing else is dispatched there.
  f.hosts.get("a").agents.push(agent("stage-task_first", { status: "running", labels: { "paseo.parent-agent-id": "coord-a", "paseo.parent-server-id": "personal" } }));
  f.advance(1); await f.engine.tick();
  assert.deepEqual(f.dispatched, ["task_first"]);
  f.hosts.get("a").agents.pop();
  f.advance(1); await f.engine.tick();
  assert.deepEqual(f.dispatched, ["task_first", "task_second"], "the next queued task takes the free host");
});

test("an uncertain dispatch holds its host for the rest of the cycle, so no second stage starts there", async t => {
  const f = await fleet(t, { a: [{ taskId: "task_first" }, { taskId: "task_second" }], b: [{ taskId: "task_other" }] });
  f.deps.dispatch = async row => { f.dispatched.push(row.taskId); if (row.taskId === "task_first") throw new Error("Plugin RPC timed out"); return { agentId: `stage-${row.taskId}`, runId: "run_a" }; };
  await f.engine.tick();
  assert.deepEqual(f.dispatched.sort(), ["task_first", "task_other"], "the second task on host a waits; host b is unaffected");
  const first = await f.row("task_first");
  assert.equal(first.mode, "blocked"); assert.ok(first.pending, "the uncertain dispatch stays recorded for inspection");
});

test("a new automatic code task gets its own worktree first; creation never reserves a dispatch or counts a wake-up", async t => {
  const f = await fleet(t, { a: [{ taskId: "task_new", run: false, worktree: false }] });
  // Agents working in the project checkout don't hold back worktree creation, which only reads it.
  f.hosts.get("a").agents.push(agent("user-chat", { status: "running" }));
  await f.engine.tick();
  assert.deepEqual(f.prepared, ["task_new"]); assert.deepEqual(f.dispatched, []);
  let saved = await f.row("task_new");
  assert.equal(saved.pending, null); assert.equal(saved.wakeups, 0); assert.equal(saved.mode, "running"); assert.equal(saved.message, "Creating the task's worktree.");
  f.deps.prepareWorktree = async row => { f.prepared.push(row.taskId); return { phase: "failed", message: "The branch exists." }; };
  await f.engine.tick();
  saved = await f.row("task_new");
  assert.equal(saved.mode, "blocked"); assert.equal(saved.pending, null); assert.match(saved.message, /couldn't be created: The branch exists\. Resume to try again/);
});

test("once the worktree exists the plan stage is dispatched there, whatever runs in the project checkout", async t => {
  const f = await fleet(t, { a: [{ taskId: "task_new", run: false, worktree: false }] });
  const host = f.hosts.get("a");
  host.workspaces.push({ id: "wt-task-new", name: "Task worktree", projectName: "Project", labels: [], status: "idle" });
  // Someone is working in the shared project checkout the whole time.
  host.agents.push(agent("user-chat", { status: "running", workspaceId: "work" }));
  f.deps.prepareWorktree = async () => ({ phase: "ready", workspaceId: "wt-task-new", branch: "feature/task-new" });
  await f.engine.tick();
  assert.match((await f.row("task_new")).message, /ready on branch feature\/task-new/);
  assert.deepEqual(f.dispatched, []);
  f.facts.get("task_new").entry.task.worktree = { workspaceId: "wt-task-new", branch: "feature/task-new", baseCommit: "f".repeat(40), sourceWorkspaceId: "work", createdAt: at };
  host.tasks[0] = f.facts.get("task_new").entry;
  await f.engine.tick();
  assert.deepEqual(f.dispatched, ["task_new"], "the stage targets the task's own worktree, not the busy project checkout");
  // Work in the task's own worktree does hold it back: the runner isn't even evaluated (it would otherwise be marked
  // blocked for stopping without a new checkpoint).
  host.agents.push(agent("stray", { status: "running", workspaceId: "wt-task-new" }));
  f.advance(10); await f.engine.tick();
  assert.deepEqual(f.dispatched, ["task_new"]);
  assert.equal((await f.row("task_new")).mode, "running");
});

test("an automatic code run in the shared project checkout is blocked without reserving a dispatch", async t => {
  const f = await fleet(t, { a: [{ taskId: "task_shared", run: true, worktree: false }] });
  await f.engine.tick();
  const saved = await f.row("task_shared");
  assert.equal(saved.mode, "blocked"); assert.equal(saved.message, sharedCheckoutMessage); assert.equal(saved.pending, null);
  assert.deepEqual(f.dispatched, []); assert.deepEqual(f.prepared, []);
});

test("a switched task's retired workers, even missing or errored ones, no longer hold back its stages", async t => {
  const f = await fleet(t, { a: [{ taskId: "task_old" }] });
  const host = f.hosts.get("a"); const coordinator = f.coordinators[0];
  // The old builder was archived (missing from the roster) and an old reviewer errored.
  host.agents = host.agents.filter(item => item.id !== "worker-task_old");
  host.agents.push(agent("old-reviewer", { status: "error", error: "Usage limit", labels: { "mission-control.task-id": "task_old" } }));
  coordinator.links.push({ serverId: "personal", agentId: coordinator.agentId, remoteServerId: "a", remoteAgentId: "old-reviewer", remoteWorkspaceId: "work", taskId: "task_old", linkedAt: at });
  await f.engine.tick();
  assert.deepEqual(f.dispatched, [], "an ordinary runner still waits for the missing and errored workers");
  await f.store.update(state => { state.pipelines[0].retiredWorkerIds = ["old-reviewer", "worker-task_old"]; });
  await f.engine.tick();
  assert.deepEqual(f.dispatched, ["task_old"]);
});
