import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
const require = createRequire(import.meta.url);
const ts = require("typescript");
require.extensions[".ts"] = (module, file) => module._compile(ts.transpileModule(readFileSync(file, "utf8"), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText, file);
const { coordinatorCandidates, managedWorkerIds, managedTasks, taskWorkers, taskWorkflow, chooseNextTask, taskFingerprint } = require("../shared/fleet-model.ts");
const { createFleetStore, fleetEvent } = require("./fleet-store.ts");
const { createFleetSupervisor } = require("./fleet-supervisor.ts");
const { supervisorEntrySchema } = require("../shared/fleet.ts");
const at = "2026-10-26T12:00:00.000Z";
const agent = (id, extra = {}) => ({ id, name: id, workspaceId: "work", status: "idle", archivedAt: null, labels: {}, updatedAt: at, activityAt: at, pendingPermissions: 0, attention: false, attentionReason: null, error: null, inputTokens: null, outputTokens: null, ...extra });
const link = (extra = {}) => ({ serverId: "personal", agentId: "coordinator", remoteServerId: "remote", remoteAgentId: "worker", remoteWorkspaceId: "work", taskId: "task_a", linkedAt: at, ...extra });
const coordinator = (extra = {}) => ({ agentId: "coordinator", workspaceId: "folder", name: "Coordinator", remoteServerId: "remote", hostLabel: "Remote", agent: agent("coordinator", { workspaceId: "folder" }), links: [link()], ...extra });
const task = (extra = {}) => ({ task: { schemaVersion: 1, taskId: "task_a", hostId: "remote", projectId: "project", title: "Improve review", acceptanceCriteria: "The right worker opens", status: "ready", source: "manual", assignments: [{ serverId: "remote", workspaceId: "work" }], createdAt: at, updatedAt: at }, run: null, decisions: [], questions: [], problem: null, ...extra });
const run = (extra = {}) => ({ schemaVersion: 1, taskId: "task_a", runId: "run_a", hostId: "remote", projectId: "project", serverId: "remote", workspaceId: "work", stage: "execute", outcome: "in_progress", createdAt: at, updatedAt: at, nextAction: "Implement the approved plan", agentId: "worker", gitHead: "a".repeat(40), gitDirty: false, gitChanges: [], omittedChanges: 0, ...extra });
const decision = (kind, status, extra = {}) => ({ decision: { decisionId: `${kind}_a`, taskId: "task_a", runId: "run_a", kind, status, requestedAt: at, ...extra }, revision: `${kind}-${status}` });
const host = (extra = {}) => ({ serverId: "remote", observedAt: at, agents: [agent("worker")], workspaces: [{ id: "work", name: "Work", projectName: "Project", branch: "task", labels: [], status: "idle" }], tasks: [task()], complete: true, warnings: [], stoppedAgentIds: [], ...extra });
const queue = (extra = {}) => ({ coordinatorId: "coordinator", remoteServerId: "remote", taskId: "task_a", enabled: true, priority: 5, updatedAt: at, ...extra });

async function fixture(t, extra = {}) {
  const directory = await mkdtemp(join(tmpdir(), "mc-fleet-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const file = join(directory, "fleet.json"); const store = createFleetStore(file);
  await store.update(state => { state.coordinators.push(supervisorEntrySchema.parse({ agentId: "coordinator", remoteServerId: "remote", enabled: true })); state.queue.push(queue()); });
  let clock = Date.parse(at); const sent = []; let currentHost = host(); let local = agent("coordinator"); let valid = true;
  const current = { serverId: "personal", observedAt: at, coordinators: [coordinator()], hosts: [{ serverId: "remote", label: "Remote", snapshot: currentHost, error: null }], warnings: [] };
  const deps = { store, now: () => clock, snapshot: async () => ({ ...current, hosts: current.hosts.map(item => ({ ...item, snapshot: item.snapshot ? { ...item.snapshot, observedAt: new Date(clock).toISOString() } : null })), state: await store.read() }), coordinator: async () => local, revalidate: async () => valid,
    send: async (...args) => { sent.push(args); }, ...extra };
  const engine = createFleetSupervisor(deps); t.after(() => engine.stop());
  return { file, store, engine, deps, sent, current, currentHost, local, setValid: value => { valid = value; }, advance: (minutes = 6) => { clock += minutes * 60_000; }, change: fn => store.update(fn) };
}

test("coordinators created by setup agents remain visible; same-workspace helpers do not become coordinators", () => {
  const agents = [agent("setup", { workspaceId: "development" }), agent("coordinator", { workspaceId: "folder", labels: { "paseo.parent-agent-id": "setup" } }), agent("helper", { workspaceId: "folder", labels: { "paseo.parent-agent-id": "coordinator" } }), agent("archived", { archivedAt: at })];
  assert.deepEqual(coordinatorCandidates(agents).map(agent => agent.id), ["setup", "coordinator"]);
});

test("task workers include native descendants without task labels and respect their permissions", () => {
  const remote = host({ agents: [agent("worker"), agent("child", { pendingPermissions: 1, labels: { "paseo.parent-agent-id": "worker" } })] });
  const ids = managedWorkerIds("personal", coordinator(), remote.agents);
  assert.deepEqual(taskWorkers(task(), remote, ids, coordinator().links).map(agent => agent.id), ["worker", "child"]);
  assert.equal(chooseNextTask("personal", coordinator(), remote, [queue()]), null);
});

test("native parent identities and explicit links isolate coordinators and remote hosts", () => {
  const own = coordinator({ links: [link(), link({ agentId: "other", remoteAgentId: "wrong" }), link({ remoteServerId: "elsewhere", remoteAgentId: "wrong-host" })] });
  const agents = [agent("native", { labels: { "paseo.parent-agent-id": "coordinator", "paseo.parent-server-id": "personal" } }), agent("child", { labels: { "paseo.parent-agent-id": "native", "paseo.parent-server-id": "remote" } }), agent("foreign", { labels: { "paseo.parent-agent-id": "coordinator", "paseo.parent-server-id": "someone-else" } }), agent("cycle", { labels: { "paseo.parent-agent-id": "cycle" } })];
  assert.deepEqual([...managedWorkerIds("personal", own, agents)].sort(), ["child", "native", "worker"]);
  assert.equal(managedTasks("personal", own, host({ tasks: [task(), task({ task: { ...task().task, taskId: "task_b" } })] })).length, 1);
  assert.equal(managedTasks("personal", own, host({ serverId: "wrong" })).length, 0);
});

test("workflow separates plan, review and delivery approvals and never treats a finished turn as delivered", () => {
  assert.equal(taskWorkflow(task(), []).stage, "Intake");
  assert.equal(taskWorkflow(task({ run: run({ stage: "plan" }), decisions: [decision("plan", "open")] }), []).actor, "you");
  assert.equal(taskWorkflow(task({ run: run({ stage: "plan" }), decisions: [decision("plan", "approved")] }), []).stage, "Ready");
  assert.equal(taskWorkflow(task({ run: run(), decisions: [] }), []).stage, "Blocked");
  assert.equal(taskWorkflow(task({ run: run(), decisions: [decision("plan", "approved")] }), []).stage, "Implementing");
  assert.equal(taskWorkflow(task({ run: run({ stage: "review", outcome: "completed" }), decisions: [decision("plan", "approved")] }), []).stage, "Code review");
  assert.equal(taskWorkflow(task({ run: run(), decisions: [decision("plan", "approved"), decision("review", "approved")] }), []).stage, "Delivery approval");
  assert.equal(taskWorkflow(task({ run: run(), decisions: [decision("review", "changes_requested")] }), []).stage, "Implementing");
  assert.equal(taskWorkflow(task({ questions: [{ question: { status: "open" } }] }), []).actor, "you");
});

test("only opted-in owned tasks are eligible; finished attention can advance but permissions cannot", () => {
  assert.equal(chooseNextTask("personal", coordinator(), host(), []), null);
  assert.equal(chooseNextTask("personal", coordinator(), host(), [queue({ coordinatorId: "other" })]), null);
  assert.equal(chooseNextTask("personal", coordinator(), host(), [queue({ remoteServerId: "other" })]), null);
  assert.ok(chooseNextTask("personal", coordinator(), host({ agents: [agent("worker", { attention: true, attentionReason: "finished" })] }), [queue()]));
  assert.equal(chooseNextTask("personal", coordinator(), host({ agents: [agent("worker", { pendingPermissions: 1 })] }), [queue()]), null);
});

test("paused, missing, shared busy, stopped and incomplete workspaces cannot dispatch", () => {
  const cases = [host({ complete: false }), host({ warnings: ["truncated"] }), host({ agents: [] }), host({ stoppedAgentIds: ["worker"] }), host({ workspaces: [] }), host({ workspaces: [{ ...host().workspaces[0], labels: ["Paused"] }] }), host({ agents: [agent("worker"), agent("unrelated", { status: "running" })] })];
  for (const item of cases) assert.equal(chooseNextTask("personal", coordinator(), item, [queue()]), null);
});

test("a blocked task does not prevent another eligible task on the same coordinator", () => {
  const second = task({ task: { ...task().task, taskId: "task_b" } });
  const own = coordinator({ links: [link(), link({ taskId: "task_b", remoteAgentId: "worker2" })] });
  const remote = host({ tasks: [task({ questions: [{ question: { status: "open" } }] }), second], agents: [agent("worker"), agent("worker2")] });
  assert.equal(chooseNextTask("personal", own, remote, [queue({ priority: 9 }), queue({ taskId: "task_b" })]).entry.task.taskId, "task_b");
});

test("durable state survives reopening; CAS, corruption and write locks fail closed", async t => {
  const f = await fixture(t); const restored = createFleetStore(f.file);
  assert.equal((await restored.read()).coordinators[0].enabled, true);
  await assert.rejects(restored.update(state => { state.paused = true; }, 0), /changed/);
  await writeFile(`${f.file}.lock`, "another writer");
  await assert.rejects(restored.update(state => { state.paused = true; }), /locked/);
  await rm(`${f.file}.lock`);
  await writeFile(f.file, "broken");
  await assert.rejects(restored.update(() => {}), /cannot be read/);
  assert.equal(await readFile(f.file, "utf8"), "broken");
});

test("one wake-up reserves intent, keeps external approval instructions, and cannot duplicate concurrent ticks", async t => {
  const f = await fixture(t);
  await Promise.all([f.engine.tick(), f.engine.tick(), f.engine.tick()]);
  assert.equal(f.sent.length, 1);
  assert.match(f.sent[0][1], /Never push, publish or merge PRs/);
  assert.match(f.sent[0][1], /Never register Personal remotely/);
  assert.match(f.sent[0][1], /This heartbeat is not plan approval/);
  assert.match(f.sent[0][2], /^mc-supervisor-/);
  const state = await f.store.read();
  assert.equal(state.coordinators[0].pending, null);
  assert.equal(state.coordinators[0].wakeups, 1);
  await f.engine.tick(); assert.equal(f.sent.length, 1);
});

test("two supervisor instances cannot both reserve the same task", async t => {
  const f = await fixture(t);
  const second = createFleetSupervisor({ ...f.deps, store: createFleetStore(f.file) }); t.after(() => second.stop());
  await Promise.allSettled([f.engine.tick(), second.tick()]);
  assert.equal(f.sent.length, 1);
});

test("uncertain send is persisted and never resent after plugin restart", async t => {
  let attempts = 0;
  const f = await fixture(t, { send: async () => { attempts++; throw new Error("ack lost"); } });
  await f.engine.tick();
  let setting = (await f.store.read()).coordinators[0]; assert.ok(setting.pending); assert.equal(setting.enabled, false);
  const next = createFleetSupervisor({ ...f.deps, store: createFleetStore(f.file) }); t.after(() => next.stop());
  f.advance(60); await next.tick(); assert.equal(attempts, 1);
  setting = (await createFleetStore(f.file).read()).coordinators[0]; assert.ok(setting.pending);
});

test("pause, opt-out, user stop, busy coordinator and human decisions each block sends", async t => {
  for (const change of [state => { state.paused = true; }, state => { state.coordinators[0].enabled = false; }, state => { state.stoppedAgentIds.push("coordinator"); }, state => { state.queue[0].enabled = false; }]) {
    const f = await fixture(t); await f.change(change); await f.engine.tick(); assert.equal(f.sent.length, 0);
  }
  const busy = await fixture(t); busy.local.status = "running"; await busy.engine.tick(); assert.equal(busy.sent.length, 0);
  const approval = await fixture(t); approval.currentHost.tasks[0].decisions.push(decision("plan", "open")); await approval.engine.tick(); assert.equal(approval.sent.length, 0);
});

test("revalidation prevents dispatch when ownership, revision, question or host state changes", async t => {
  const f = await fixture(t); f.setValid(false); await f.engine.tick();
  assert.equal(f.sent.length, 0); assert.equal((await f.store.read()).coordinators[0].pending, null);
});

test("pause during revalidation cancels the reserved send", async t => {
  const f = await fixture(t);
  const engine = createFleetSupervisor({ ...f.deps, revalidate: async () => { await f.change(state => { state.paused = true; }); return true; } }); t.after(() => engine.stop());
  await engine.tick(); assert.equal(f.sent.length, 0); assert.equal((await f.store.read()).coordinators[0].pending, null);
});

test("daily wake-up cap and repeated unchanged evidence stop loops", async t => {
  const f = await fixture(t); await f.change(state => { state.coordinators[0].maxWakeupsPerDay = 2; });
  await f.engine.tick(); f.advance(); await f.engine.tick(); f.advance(); await f.engine.tick(); assert.equal(f.sent.length, 2);
  assert.match((await f.store.read()).coordinators[0].message, /Daily/);
  f.advance(24 * 60); await f.engine.tick(); assert.equal(f.sent.length, 3);
  f.advance(); await f.engine.tick(); assert.equal(f.sent.length, 3); assert.match((await f.store.read()).coordinators[0].message, /Three wake-ups/);
  f.currentHost.tasks[0].task.updatedAt = "2026-10-28T00:00:00Z"; f.advance(); await f.engine.tick(); assert.equal(f.sent.length, 4);
});

test("global concurrency counts existing active hosts, and failures on one host allow another", async t => {
  const f = await fixture(t);
  f.current.coordinators.push(coordinator({ agentId: "busy-a", remoteServerId: "host-a", agent: agent("busy-a", { status: "running" }) }), coordinator({ agentId: "busy-b", remoteServerId: "host-b", agent: agent("busy-b", { status: "running" }) }));
  await f.engine.tick(); assert.equal(f.sent.length, 0);
  f.current.coordinators.splice(1); f.current.hosts.push({ serverId: "offline", label: "Offline", snapshot: null, error: "offline" });
  await f.engine.tick(); assert.equal(f.sent.length, 1);
});

test("global concurrency includes active descendants of idle workers", async t => {
  const f = await fixture(t);
  for (const suffix of ["a", "b"]) {
    const serverId = `remote-${suffix}`; const agentId = `coordinator-${suffix}`; const workerId = `worker-${suffix}`;
    f.current.coordinators.push(coordinator({ agentId, remoteServerId: serverId, agent: agent(agentId), links: [link({ agentId, remoteServerId: serverId, remoteAgentId: workerId })] }));
    f.current.hosts.push({ serverId, label: suffix, error: null, snapshot: host({ serverId, agents: [agent(workerId), agent(`child-${suffix}`, { status: "running", labels: { "paseo.parent-agent-id": workerId, "paseo.parent-server-id": serverId } })] }) });
  }
  await f.engine.tick(); assert.equal(f.sent.length, 0);
});

test("a stopped supervisor never sends and event history is bounded", async t => {
  const f = await fixture(t); f.engine.stop(); await f.engine.tick(); assert.equal(f.sent.length, 0);
  await f.change(state => { for (let index = 0; index < 600; index++) fleetEvent(state, { coordinatorId: null, remoteServerId: null, taskId: null, kind: "progress", message: String(index) }); });
  const state = await f.store.read(); assert.equal(state.events.length, 500); assert.equal(state.events[0].message, "599");
  assert.notEqual(taskFingerprint(task()), taskFingerprint(task({ run: run() })));
});
