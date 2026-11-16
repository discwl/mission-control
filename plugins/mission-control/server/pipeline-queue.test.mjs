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

test("a runner held by a failed turn says which agent failed and why, and goes on once the error clears", async t => {
  const f = await fleet(t, { a: [{ taskId: "task_a1" }] });
  const coordinator = f.coordinators[0];
  // Paseo 0.16: a turn stopped by a usage limit ends failed and keeps its error and error attention until the next turn.
  coordinator.agent = { ...coordinator.agent, error: "Usage limit reached", attention: true, attentionReason: "error" };
  await f.engine.tick();
  assert.deepEqual(f.dispatched, []);
  assert.match((await f.row("task_a1")).message, /^Waiting: the coordinator coord-a's last turn failed \(Usage limit reached\)\. Automatic work continues once its next turn starts/);
  // Messaging it starts a new turn, which clears the error and makes the host busy: the note goes straight away.
  coordinator.agent = { ...coordinator.agent, status: "running", error: null, attention: false, attentionReason: null };
  f.advance(1); await f.engine.tick();
  assert.deepEqual(f.dispatched, []);
  assert.equal((await f.row("task_a1")).message, "Waiting for the coordinator, the task's workers and its workspace to be free.");
  // A task worker's failed turn holds it the same way.
  coordinator.agent = { ...coordinator.agent, status: "idle" };
  const worker = f.hosts.get("a").agents.find(item => item.id === "worker-task_a1");
  Object.assign(worker, { error: "Invalid API key", attention: true, attentionReason: "error" });
  f.advance(1); await f.engine.tick();
  assert.deepEqual(f.dispatched, []);
  assert.match((await f.row("task_a1")).message, /^Waiting: the task worker worker-task_a1's last turn failed \(Invalid API key\)/);
  // Cleared, but still held by something else: the stale note goes.
  Object.assign(worker, { error: null, attention: false, attentionReason: null });
  f.hosts.get("a").agents.push(agent("user-chat", { status: "running" }));
  f.advance(1); await f.engine.tick();
  assert.deepEqual(f.dispatched, []);
  assert.equal((await f.row("task_a1")).message, "Waiting for the coordinator, the task's workers and its workspace to be free.");
  f.hosts.get("a").agents.pop();
  f.advance(1); await f.engine.tick();
  assert.deepEqual(f.dispatched, ["task_a1"]);
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

test("a host whose Mission Control is restarting holds the runner instead of blocking it", async t => {
  const f = await fleet(t, { a: [{ taskId: "task_restart" }] });
  const inspect = f.deps.inspect; let down = true;
  f.deps.inspect = async (...args) => { if (down) throw new Error("Request failed: Plugin is not available: mission-control requestType=plugin.rpc.invoke.request code=handler_error"); return inspect(...args); };
  await f.engine.tick();
  let row = await f.row("task_restart");
  assert.equal(row.mode, "running");
  assert.match(row.message, /^Waiting for a to answer: its Mission Control was restarting\./);
  assert.equal(row.pending, null);
  assert.deepEqual(f.dispatched, []);
  down = false; f.advance(1);
  await f.engine.tick();
  assert.deepEqual(f.dispatched, ["task_restart"], "the stage starts once the host answers again");
});

test("transient evidence errors block the runner after 30 minutes without an answer", async t => {
  const f = await fleet(t, { a: [{ taskId: "task_slow" }] });
  f.deps.inspect = async () => { throw new Error("Request failed: Plugin RPC timed out: mission-control.invoke"); };
  // Every check fails, a few minutes apart, as when each cycle's inspection times out.
  for (let minute = 0; minute <= 28; minute += 4) { await f.engine.tick(); assert.equal((await f.row("task_slow")).mode, "running", `still waiting at ${minute} min`); f.advance(4); }
  await f.engine.tick();
  const row = await f.row("task_slow");
  assert.equal(row.mode, "blocked");
  assert.match(row.message, /^Cannot verify stage evidence: Request failed: Plugin RPC timed out/);
});

test("a transient wait that wasn't renewed for a while starts over, so one old hiccup can't block the next at once", async t => {
  const f = await fleet(t, { a: [{ taskId: "task_slept" }] });
  f.deps.inspect = async () => { throw new Error("Request failed: Plugin is not available: mission-control"); };
  await f.engine.tick();
  // The host sleeps: its fleet read carries a warning, so the runner is skipped before inspection for two hours.
  f.hosts.get("a").warnings = ["Host asleep"];
  for (let minute = 0; minute < 120; minute += 30) { f.advance(30); await f.engine.tick(); }
  f.hosts.get("a").warnings = [];
  f.advance(1); await f.engine.tick();
  const row = await f.row("task_slept");
  assert.equal(row.mode, "running", "the first hiccup after the gap starts a new 30-minute wait");
  assert.match(row.message, /^Waiting for a to answer/);
});

test("a definite evidence error still blocks the runner at once", async t => {
  const f = await fleet(t, { a: [{ taskId: "task_gone" }] });
  f.deps.inspect = async () => { throw new Error("Task not found on this host."); };
  await f.engine.tick();
  const row = await f.row("task_gone");
  assert.equal(row.mode, "blocked");
  assert.equal(row.message, "Cannot verify stage evidence: Task not found on this host.");
});

test("a failed recheck after reserving a dispatch releases the reservation instead of leaving it unconfirmed", async t => {
  const f = await fleet(t, { a: [{ taskId: "task_recheck" }] });
  const inspect = f.deps.inspect; let calls = 0;
  f.deps.inspect = async (...args) => { if (++calls === 2) throw new Error("Paseo is still starting (its daemon accepts connections once every plugin has loaded)."); return inspect(...args); };
  await f.engine.tick();
  let row = await f.row("task_recheck");
  assert.equal(row.pending, null, "nothing was sent, so nothing waits for confirmation");
  assert.equal(row.mode, "running");
  assert.match(row.message, /Paseo was starting/);
  assert.deepEqual(f.dispatched, []);
  f.advance(1); await f.engine.tick();
  assert.deepEqual(f.dispatched, ["task_recheck"]);
});

const { recordDispatch } = require("./pipeline-engine.ts");
const receipt = (requestId, phase, step = "accepted", extra = {}) => ({ requestId, phase, step, agentId: null, runId: null, error: null, startedAt: at, updatedAt: at, ...extra });
/** A host that keeps stage start receipts. Unknown request IDs read as cancelled, as cancelIfMissing reports them. */
function withReceipts(f) {
  const receipts = new Map(); const sent = [];
  f.deps.launchReceipts = async () => true;
  f.deps.launchStatus = async (_row, requestId) => receipts.get(requestId) ?? receipt(requestId, "cancelled", "accepted", { error: "The stage start was cancelled before it reached this host." });
  return { receipts, sent, answer: reply => { f.deps.dispatch = async (row, _facts, _fingerprint, requestId, acceptPending) => { sent.push({ requestId, acceptPending }); f.dispatched.push(row.taskId); return reply(requestId); }; } };
}

test("a slow stage start on a host with receipts is followed to its worker, not shown as unconfirmed", async t => {
  const f = await fleet(t, { a: [{ taskId: "task_slow_start" }] }); const host = withReceipts(f);
  host.answer(requestId => { const running = receipt(requestId, "running", "agent", { agentId: "stage-worker" }); host.receipts.set(requestId, running); return { receipt: running }; });
  await f.engine.tick();
  let row = await f.row("task_slow_start");
  assert.equal(host.sent[0].acceptPending, true);
  assert.equal(row.pending.launch, "awaiting"); assert.equal(row.mode, "running");
  assert.ok("failureId" in row.pending && "planFailureId" in row.pending, "repair accounting is saved with the reservation");
  assert.match(row.message, /^Starting the execute stage on a \(creating its worker\)\./);
  host.receipts.set(host.sent[0].requestId, receipt(host.sent[0].requestId, "done", "sent", { agentId: "stage-worker", runId: "run_a" }));
  f.advance(1); await f.engine.tick();
  row = await f.row("task_slow_start");
  assert.equal(row.pending, null);
  assert.deepEqual(row.lastWorker, { agentId: "stage-worker", runId: "run_a" });
  assert.equal(row.wakeups, 1); assert.ok(row.lastDispatch);
  assert.equal(row.message, "The execute stage started on a.", "no lasting Starting note once the start is confirmed");
  assert.deepEqual(f.dispatched, ["task_slow_start"], "the stage was sent once");
});

test("a dispatch error on a followed host is settled from the receipt; a start that never arrived is retried three times at most", async t => {
  const f = await fleet(t, { a: [{ taskId: "task_lost" }] }); withReceipts(f);
  const attempts = [];
  f.deps.dispatch = async (_row, _facts, _fingerprint, requestId) => { attempts.push(requestId); throw new Error("Request failed: Plugin RPC timed out: mission-control.invoke"); };
  for (let attempt = 1; attempt <= 3; attempt++) {
    await f.engine.tick();
    let row = await f.row("task_lost");
    assert.equal(row.pending.launch, "awaiting"); assert.match(row.message, /^Confirming the execute stage start with a/);
    f.advance(1); await f.engine.tick();
    row = await f.row("task_lost");
    assert.equal(row.pending, null);
    if (attempt < 3) { assert.equal(row.mode, "running"); assert.match(row.message, /didn't start on a \(the request never reached a \(Request failed: Plugin RPC timed out: mission-control\.invoke\)\)\. The runner checks again\./); }
    else { assert.equal(row.mode, "blocked"); assert.match(row.message, /couldn't start on a: the request never reached a \(Request failed: Plugin RPC timed out: mission-control\.invoke\)\. Nothing was started there\. Resume to try again\./); }
    f.advance(1);
  }
  assert.equal(attempts.length, 3);
});

test("a start that failed after creating its worker blocks and keeps the dispatch for a person to check", async t => {
  const f = await fleet(t, { a: [{ taskId: "task_partial" }] }); const host = withReceipts(f);
  host.answer(requestId => ({ receipt: receipt(requestId, "failed", "run", { agentId: "stage-worker", error: "Task run could not start." }) }));
  await f.engine.tick();
  const row = await f.row("task_partial");
  assert.equal(row.mode, "blocked"); assert.equal(row.pending.launch, "awaiting");
  assert.match(row.message, /started only partly on a \(starting its run, worker stage-worker\): Task run could not start\. Check that worker/);
});

test("a start that did nothing blocks with a lasting reason, and re-evaluates when only the facts moved", async t => {
  const lasting = await fleet(t, { a: [{ taskId: "task_profiles" }] }); const host = withReceipts(lasting);
  host.answer(requestId => ({ receipt: receipt(requestId, "failed", "accepted", { error: "Choose native agent profiles on this host before launching a managed stage." }) }));
  await lasting.engine.tick();
  let row = await lasting.row("task_profiles");
  assert.equal(row.pending, null); assert.equal(row.mode, "blocked");
  assert.match(row.message, /couldn't start on a: Choose native agent profiles.*Nothing was started there/);
  const moved = await fleet(t, { a: [{ taskId: "task_moved" }] }); const other = withReceipts(moved);
  other.answer(requestId => ({ receipt: receipt(requestId, "failed", "accepted", { error: "Stage changed before launch." }) }));
  await moved.engine.tick();
  row = await moved.row("task_moved");
  assert.equal(row.pending, null); assert.equal(row.mode, "running");
  assert.match(row.message, /didn't start on a \(Stage changed before launch\.\)\. The runner checks again\./);
});

test("a paused runner still following a start is settled from the host's receipt and stays paused", async t => {
  const f = await fleet(t, { a: [{ taskId: "task_paused" }] }); const host = withReceipts(f);
  host.answer(requestId => { const running = receipt(requestId, "running", "sending", { agentId: "stage-worker" }); host.receipts.set(requestId, running); return { receipt: running }; });
  await f.engine.tick();
  await f.store.update(state => { state.pipelines.find(item => item.taskId === "task_paused").mode = "paused"; });
  host.receipts.set(host.sent[0].requestId, receipt(host.sent[0].requestId, "done", "sent", { agentId: "stage-worker", runId: "run_a" }));
  f.advance(1); await f.engine.tick();
  const row = await f.row("task_paused");
  assert.equal(row.mode, "paused"); assert.equal(row.pending, null); assert.deepEqual(row.lastWorker, { agentId: "stage-worker", runId: "run_a" });
});

test("a stage still starting holds its host for runners ahead of it in the order, and blocks after 30 minutes", async t => {
  const f = await fleet(t, { a: [{ taskId: "task_ahead" }, { taskId: "task_starting" }] }); const host = withReceipts(f);
  const requestId = "mc-pipeline-held";
  host.receipts.set(requestId, receipt(requestId, "running", "agent", { agentId: "stage-worker" }));
  await f.store.update(state => { state.pipelines.find(item => item.taskId === "task_starting").pending = { requestId, fingerprint: "fp", stage: "execute", attemptedAt: at, launch: "awaiting", failureId: null, planFailureId: null }; });
  await f.engine.tick();
  assert.deepEqual(f.dispatched, [], "the earlier runner waits while the later one's stage is starting on the same host");
  f.advance(31); await f.engine.tick();
  const row = await f.row("task_starting");
  assert.equal(row.mode, "blocked"); assert.equal(row.pending.requestId, requestId);
  assert.match(row.message, /has been starting on a for over 30 minutes \(creating its worker\)/);
});

test("a host without start receipts keeps today's unconfirmed block on a dispatch error", async t => {
  const f = await fleet(t, { a: [{ taskId: "task_old_host" }] });
  f.deps.launchReceipts = async () => false; f.deps.launchStatus = async () => { throw new Error("must not be asked"); };
  f.deps.dispatch = async () => { throw new Error("Request failed: Plugin RPC timed out: mission-control.invoke"); };
  await f.engine.tick();
  const row = await f.row("task_old_host");
  assert.equal(row.mode, "blocked"); assert.equal(row.pending.launch, undefined);
  assert.match(row.message, /^Dispatch outcome is unconfirmed/);
});

test("a confirmed dispatch counts the repair attempts saved with its reservation", () => {
  const row = { pending: {}, lastDispatch: null, lastSentAt: null, date: "2026-11-08", wakeups: 5, lastWorker: null, runId: null, repairs: 0, repairIds: [], planRepairs: 1, planRepairIds: ["plan_a"], updatedAt: at };
  recordDispatch(row, { requestId: "r", fingerprint: "fp", stage: "fix", attemptedAt: at, failureId: "finding_a", planFailureId: "plan_b" }, Date.parse(at), { agentId: "w", runId: "run_b" });
  assert.equal(row.pending, null); assert.equal(row.lastDispatch, "fp");
  assert.deepEqual([row.repairs, row.repairIds], [1, ["finding_a"]]);
  assert.deepEqual([row.planRepairs, row.planRepairIds], [2, ["plan_a", "plan_b"]]);
  assert.equal(row.wakeups, 1, "a new day starts a new count"); assert.equal(row.runId, "run_b");
});

test("a cancellation long after the attempt may stand in for a pruned receipt, so the runner asks a person", async t => {
  const f = await fleet(t, { a: [{ taskId: "task_pruned" }] }); const host = withReceipts(f);
  const requestId = "mc-pipeline-pruned";
  await f.store.update(state => { state.pipelines.find(item => item.taskId === "task_pruned").pending = { requestId, fingerprint: "fp", stage: "execute", attemptedAt: at, launch: "awaiting", failureId: null, planFailureId: null }; });
  f.advance(40 * 24 * 60);
  host.receipts.set(requestId, receipt(requestId, "cancelled", "accepted", { startedAt: new Date(Date.parse(at) + 40 * 24 * 60 * 60_000).toISOString() }));
  await f.engine.tick();
  const row = await f.row("task_pruned");
  assert.equal(row.mode, "blocked"); assert.equal(row.pending.requestId, requestId);
  assert.match(row.message, /can't be confirmed: the host no longer keeps its receipt/);
});

test("failures in back-to-back inspections keep the 30-minute clock, however long each cycle takes", async t => {
  const f = await fleet(t, { a: [{ taskId: "task_stuck" }] });
  // Each cycle takes 6 minutes inside its inspections, as when many runners' inspections time out one after another;
  // the next cycle starts right after the last one ends.
  f.deps.inspect = async () => { f.advance(6); throw new Error("Request failed: Plugin RPC timed out: mission-control.invoke"); };
  for (let cycle = 0; cycle < 5; cycle++) { await f.engine.tick(); assert.equal((await f.row("task_stuck")).mode, "running", `still waiting after cycle ${cycle + 1}`); }
  await f.engine.tick();
  const row = await f.row("task_stuck");
  assert.equal(row.mode, "blocked", "the stuck host's runner asks a person after 30 minutes");
});

test("pausing a runner or the fleet starts any transient wait afresh when it resumes", async t => {
  for (const pause of ["runner", "fleet"]) {
    const f = await fleet(t, { a: [{ taskId: `task_paused_${pause}` }] });
    f.deps.inspect = async () => { throw new Error("Request failed: Plugin is not available: mission-control"); };
    await f.engine.tick();
    const set = value => f.store.update(state => { if (pause === "fleet") state.paused = value; else state.pipelines[0].mode = value ? "paused" : "running"; });
    await set(true);
    for (let minute = 0; minute < 40; minute += 10) { f.advance(10); await f.engine.tick(); }
    await set(false);
    f.advance(1); await f.engine.tick();
    const row = await f.row(`task_paused_${pause}`);
    assert.equal(row.mode, "running", `after a ${pause} pause the first hiccup starts a new wait`);
    assert.match(row.message, /^Waiting for a to answer/);
  }
});

test("after a gap with no pass through the runners (this computer slept), a hiccup starts a new wait", async t => {
  const f = await fleet(t, { a: [{ taskId: "task_asleep" }] });
  f.deps.inspect = async () => { throw new Error("Request failed: Plugin is not available: mission-control"); };
  await f.engine.tick();
  f.advance(60); // asleep for an hour: no cycle runs
  await f.engine.tick();
  const row = await f.row("task_asleep");
  assert.equal(row.mode, "running"); assert.match(row.message, /^Waiting for a to answer/);
});

test("a failed check of whether the host keeps receipts waits and asks again instead of sending unfollowed", async t => {
  const f = await fleet(t, { a: [{ taskId: "task_capability" }] }); withReceipts(f);
  let down = true;
  f.deps.launchReceipts = async () => { if (down) throw new Error("Request failed: Plugin RPC timed out: mission-control.invoke"); return true; };
  await f.engine.tick();
  let row = await f.row("task_capability");
  assert.equal(row.pending, null, "nothing was sent, so nothing waits for confirmation");
  assert.equal(row.mode, "running"); assert.match(row.message, /^Waiting for a to answer: it answered too slowly/);
  assert.deepEqual(f.dispatched, []);
  down = false; f.advance(1); await f.engine.tick();
  assert.deepEqual(f.dispatched, ["task_capability"]);
  row = await f.row("task_capability");
  assert.equal(row.pending, null, "the default dispatch answered with its worker");
});

test("a dispatch that failed before calling the host releases the reservation and says why", async t => {
  const f = await fleet(t, { a: [{ taskId: "task_local" }] }); withReceipts(f);
  f.deps.dispatch = async () => { throw Object.assign(new Error("Task workspace is unavailable."), { notSent: true }); };
  await f.engine.tick();
  const row = await f.row("task_local");
  assert.equal(row.pending, null); assert.equal(row.mode, "blocked");
  assert.equal(row.message, "The execute stage couldn't start: Task workspace is unavailable. Nothing was sent. Resume to try again.");
});

test("a start that never reached its host keeps the dispatch error as its reason", async t => {
  const f = await fleet(t, { a: [{ taskId: "task_reason" }] }); withReceipts(f);
  f.deps.dispatch = async () => { throw new Error("Request failed: Plugin mission-control is not available on the route"); };
  await f.engine.tick(); f.advance(1); await f.engine.tick();
  const row = await f.row("task_reason");
  assert.match(row.message, /didn't start on a \(the request never reached a \(Request failed: Plugin mission-control is not available on the route\)\)/);
});
