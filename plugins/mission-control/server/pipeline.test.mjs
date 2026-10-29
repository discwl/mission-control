import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { writePipelineCheckpoint, readPipelineCheckpoints } from "./pipeline-records.mjs";
const require = createRequire(import.meta.url); const ts = require("typescript");
require.extensions[".ts"] = (module, file) => module._compile(ts.transpileModule(readFileSync(file, "utf8"), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText, file);
const { nextPipelineStep } = require("../shared/pipeline-model.ts");
const { createPipelineEngine } = require("./pipeline-engine.ts");
const { createFleetStore } = require("./fleet-store.ts");
const at = "2026-10-29T03:00:00.000Z"; const candidate = { head: "a".repeat(40), tree: "b".repeat(40) }; const planRevision = "c".repeat(64);
const row = extra => ({ id: randomUUID(), coordinatorId: "coordinator", remoteServerId: "remote", taskId: "task_a", mode: "running", stage: "plan", runId: "run_a", message: "Checking", updatedAt: at, repairs: 0, repairIds: [], lastDispatch: null, lastSentAt: null, date: "", wakeups: 0, pending: null, ...extra });
const agent = (id, extra = {}) => ({ id, name: id, workspaceId: "work", status: "idle", archivedAt: null, labels: {}, updatedAt: at, activityAt: at, pendingPermissions: 0, attention: false, attentionReason: null, error: null, inputTokens: null, outputTokens: null, ...extra });
const entry = () => ({ task: { schemaVersion: 1, taskId: "task_a", hostId: "remote", projectId: "project", title: "Example", acceptanceCriteria: "Works", status: "ready", source: "manual", assignments: [{ serverId: "remote", workspaceId: "work" }], createdAt: at, updatedAt: at }, run: { schemaVersion: 1, taskId: "task_a", runId: "run_a", hostId: "remote", projectId: "project", serverId: "remote", workspaceId: "work", stage: "plan", outcome: "completed", createdAt: at, updatedAt: at, nextAction: "Continue", agentId: "worker", gitHead: candidate.head, gitDirty: false, gitChanges: [], omittedChanges: 0 }, decisions: [], questions: [], problem: null });
const facts = () => ({ version: 1, entry: entry(), candidate: { ...candidate }, planRevision, checkpoints: [], problem: null });
const checkpoint = (stage, extra = {}) => ({ schemaVersion: 1, id: randomUUID(), taskId: "task_a", runId: "run_a", serverId: "remote", workspaceId: "work", stage, verdict: "pass", scope: "approved", agentId: stage === "review" ? "reviewer" : "worker", implementationAgentId: "worker", candidate: { ...candidate }, planRevision, createdAt: stage === "execute" ? "2026-10-29T03:00:01.000Z" : stage === "validate" ? "2026-10-29T03:00:02.000Z" : "2026-10-29T03:00:03.000Z", summary: "Actual recorded result", evidence: [{ path: "report.md", sha256: "d".repeat(64), bytes: 5 }], ...extra });
const decision = (kind, status, extra = {}) => ({ revision: "revision", decision: { decisionId: `${kind}_a`, kind, status, runId: "run_a", requestedAt: at, ...extra } });

test("pipeline advances through implementation, validation, independent review and separate human gates", () => {
  const p = row(); const f = facts(); f.planRevision = null;
  assert.equal(nextPipelineStep(p, f).stage, "plan");
  f.entry.decisions = [decision("plan", "open")]; assert.equal(nextPipelineStep(p, f).mode, "waiting");
  f.entry.decisions = []; f.planRevision = planRevision; assert.equal(nextPipelineStep(p, f).stage, "execute");
  f.checkpoints.push(checkpoint("execute")); assert.equal(nextPipelineStep(p, f).stage, "validate");
  f.checkpoints.push(checkpoint("validate")); assert.equal(nextPipelineStep(p, f).stage, "review");
  f.checkpoints.push(checkpoint("review")); assert.equal(nextPipelineStep(p, f).stage, "review", "still needs a saved human review request");
  f.entry.decisions = [decision("review", "open")]; assert.equal(nextPipelineStep(p, f).mode, "waiting");
  f.entry.decisions = [decision("review", "approved", { candidate })]; assert.equal(nextPipelineStep(p, f).mode, "ready");
  f.entry.task.pullRequest = { url: "https://example.test/pr/1" }; assert.equal(nextPipelineStep(p, f).mode, "done");
});
test("stale code or plan cannot reuse validation, independent review or human acceptance", () => {
  const f = facts(); f.checkpoints = [checkpoint("execute"), checkpoint("validate"), checkpoint("review")]; f.entry.decisions = [decision("review", "approved", { candidate })];
  f.candidate.tree = "e".repeat(40); assert.equal(nextPipelineStep(row(), f).stage, "execute");
  f.candidate = { ...candidate }; f.planRevision = "e".repeat(64); assert.equal(nextPipelineStep(row(), f).stage, "execute");
  f.planRevision = planRevision; f.checkpoints[2].agentId = "worker"; assert.equal(nextPipelineStep(row(), f).stage, "review");
});
test("a changed candidate after the PR preview stops for delivery inspection instead of restarting implementation", () => {
  const f = facts(); f.entry.decisions = [decision("review", "approved", { candidate })]; f.candidate.head = "e".repeat(40);
  const next = nextPipelineStep(row({ stage: "delivery", mode: "ready" }), f);
  assert.equal(next.mode, "blocked"); assert.equal(next.dispatch, false); assert.match(next.message, /delivery result/);
  f.entry.task.pullRequest = { url: "https://example.test/pr/1" }; assert.equal(nextPipelineStep(row({ stage: "delivery", mode: "ready" }), f).mode, "done");
});

test("repair is bounded, scope changes need a new plan and questions stop dispatch", () => {
  const p = row(); const f = facts(); const failure = checkpoint("validate", { verdict: "repair" }); f.checkpoints = [checkpoint("execute"), failure];
  assert.equal(nextPipelineStep(p, f).stage, "fix"); assert.equal(nextPipelineStep(row({ repairs: 2 }), f).mode, "blocked");
  assert.equal(nextPipelineStep(row({ repairs: 1, repairIds: [failure.id] }), f).dispatch, false);
  failure.scope = "needs_plan"; assert.equal(nextPipelineStep(p, f).stage, "plan");
  failure.scope = "approved"; failure.verdict = "blocked"; assert.equal(nextPipelineStep(p, f).mode, "blocked");
  f.entry.questions = [{ question: { status: "open" } }]; assert.equal(nextPipelineStep(p, f).mode, "waiting");
});
test("a completed repair does not keep reapplying the earlier human change request", () => {
  const f = facts(); f.checkpoints = [checkpoint("fix", { createdAt: "2026-10-29T03:00:05.000Z" })]; f.entry.decisions = [decision("review", "changes_requested")];
  assert.equal(nextPipelineStep(row({ repairs: 1, repairIds: ["review_a"] }), f).stage, "validate");
});

async function fixture(t, overrides = {}) {
  const directory = await mkdtemp(join(tmpdir(), "mc-pipeline-")); t.after(() => rm(directory, { recursive: true, force: true }));
  const file = join(directory, "fleet.json"); const store = createFleetStore(file); const p = row(); await store.update(state => state.pipelines.push(p));
  let clock = Date.parse(at); const sent = []; const prepared = []; const f = facts();
  const coordinator = { agentId: "coordinator", workspaceId: "folder", name: "Coordinator", remoteServerId: "remote", hostLabel: "Remote", agent: agent("coordinator", { workspaceId: "folder" }), links: [{ serverId: "personal", agentId: "coordinator", remoteServerId: "remote", remoteAgentId: "worker", remoteWorkspaceId: "work", taskId: "task_a", linkedAt: at }] };
  const host = { serverId: "remote", observedAt: at, agents: [agent("worker")], workspaces: [{ id: "work", name: "Work", projectName: "Project", labels: [], status: "idle" }], tasks: [f.entry], warnings: [], complete: true, stoppedAgentIds: [] };
  const deps = { store, now: () => clock, snapshot: async () => ({ serverId: "personal", observedAt: new Date(clock).toISOString(), coordinators: [coordinator], hosts: [{ serverId: "remote", label: "Remote", snapshot: { ...host, observedAt: new Date(clock).toISOString() }, error: null }], state: await store.read(), warnings: [] }), inspect: async () => structuredClone(f), send: async (...args) => sent.push(args), prepare: async (...args) => prepared.push(args), ...overrides };
  const engine = createPipelineEngine(deps); t.after(() => engine.stop());
  return { file, directory, store, engine, deps, sent, prepared, f, host, coordinator, p, advance: () => { clock += 6 * 60_000; } };
}
test("dispatch intent is durable before send and a no-progress wake-up is never repeated", async t => {
  const f = await fixture(t); f.deps.send = async (...args) => { assert.ok((await f.store.read()).pipelines[0].pending); f.sent.push(args); };
  await f.engine.tick(); assert.equal(f.sent.length, 1); assert.match(f.sent[0][1], /No commit, push, PR publication/);
  await f.engine.tick(); assert.equal(f.sent.length, 1); assert.equal((await f.store.read()).pipelines[0].mode, "running");
  f.advance(); await f.engine.tick(); assert.equal(f.sent.length, 1); assert.equal((await f.store.read()).pipelines[0].mode, "blocked");
});
test("uncertain send survives restart and cannot be replayed", async t => {
  const f = await fixture(t, { send: async () => { throw new Error("Lost acknowledgment"); } }); await f.engine.tick();
  const restored = createFleetStore(f.file); assert.ok((await restored.read()).pipelines[0].pending);
  const sent = []; const restarted = createPipelineEngine({ ...f.deps, store: restored, send: async (...args) => sent.push(args) }); t.after(() => restarted.stop());
  f.advance(); await restarted.tick(); assert.equal(sent.length, 0); assert.equal((await restored.read()).pipelines[0].mode, "blocked");
});
test("pause, worker permissions, wrong host, offline snapshot and changed binding prevent dispatch", async t => {
  for (const change of [f => { f.host.complete = false; }, f => { f.host.serverId = "wrong"; }, f => { f.coordinator.remoteServerId = "wrong"; }, f => { f.host.agents[0].pendingPermissions = 1; }, f => f.store.update(s => { s.paused = true; }), f => f.store.update(s => { s.pipelines[0].mode = "paused"; })]) {
    const f = await fixture(t); await change(f); await f.engine.tick(); assert.equal(f.sent.length, 0);
  }
});
test("attention on another task does not block this task's runner", async t => {
  const f = await fixture(t);
  f.coordinator.links.push({ ...f.coordinator.links[0], remoteAgentId: "other-worker", remoteWorkspaceId: "another-work", taskId: "task_b" });
  f.host.agents.push(agent("other-worker", { workspaceId: "another-work", pendingPermissions: 1, attention: true, attentionReason: "permission" }));
  await f.engine.tick(); assert.equal(f.sent.length, 1);
});

test("pausing during the second evidence check prevents a send", async t => {
  const f = await fixture(t); let checks = 0; f.deps.inspect = async () => { if (++checks === 2) await f.store.update(state => { state.paused = true; }); return structuredClone(f.f); };
  await f.engine.tick(); assert.equal(f.sent.length, 0); assert.equal((await f.store.read()).pipelines[0].pending, null);
});
test("accepted reviewed code only prepares one preview and never publishes", async t => {
  const f = await fixture(t); f.f.checkpoints = [checkpoint("execute"), checkpoint("validate"), checkpoint("review")]; f.f.entry.decisions = [decision("review", "approved", { candidate })];
  await f.engine.tick(); assert.equal(f.prepared.length, 1); assert.equal(f.sent.length, 0); assert.equal((await f.store.read()).pipelines[0].mode, "ready");
  f.advance(); await f.engine.tick(); assert.equal(f.prepared.length, 1);
});
test("run changes stop an existing runner instead of silently adopting a different attempt", async t => {
  const f = await fixture(t); f.f.entry.run.runId = "run_new"; await f.engine.tick(); assert.equal(f.sent.length, 0); assert.match((await f.store.read()).pipelines[0].message, /run changed/);
});

test("disposable task pilot advances saved stages, waits at human review and ends at a PR preview", async t => {
  const f = await fixture(t);
  await f.engine.tick(); assert.match(f.sent[0][1], /only the execute stage/);
  f.f.checkpoints.push(checkpoint("execute")); f.advance(); await f.engine.tick(); assert.match(f.sent[1][1], /only the validate stage/);
  f.f.checkpoints.push(checkpoint("validate")); f.advance(); await f.engine.tick(); assert.match(f.sent[2][1], /only the review stage/);
  f.f.checkpoints.push(checkpoint("review")); f.f.entry.decisions = [decision("review", "open")];
  f.advance(); await f.engine.tick(); assert.equal(f.sent.length, 3); assert.equal((await f.store.read()).pipelines[0].mode, "waiting");
  f.f.entry.decisions = [decision("review", "approved", { candidate })]; f.advance(); await f.engine.tick();
  assert.equal(f.prepared.length, 1); assert.equal(f.sent.length, 3); assert.equal((await f.store.read()).pipelines[0].mode, "ready");
  const restored = createFleetStore(f.file); assert.equal((await restored.read()).pipelines[0].mode, "ready");
});

test("checkpoint receipts hash saved reports and reject changed evidence, wrong identities and self review", async t => {
  const dir = await mkdtemp(join(tmpdir(), "mc-checkpoint-")); t.after(() => rm(dir, { recursive: true, force: true }));
  await writeFile(join(dir, "actual.md"), "Checks actually passed.");
  const identity = { taskId: "task_a", runId: "run_a", serverId: "remote", workspaceId: "work", agentId: "worker", implementationAgentId: "worker", candidate };
  const input = { stage: "execute", verdict: "pass", scope: "approved", planRevision, summary: "Implemented the agreed scope.", evidence: ["actual.md"] };
  const saved = await writePipelineCheckpoint(dir, identity, input); assert.equal((await readPipelineCheckpoints(dir, { taskId: "task_a", runId: "run_a", serverId: "remote", workspaceId: "work" }))[0].id, saved.id);
  await assert.rejects(readPipelineCheckpoints(dir, { ...identity, serverId: "another" }), /another task/);
  await assert.rejects(writePipelineCheckpoint(dir, identity, { ...input, stage: "review" }), /different agent/);
  await assert.rejects(writePipelineCheckpoint(dir, identity, { ...input, evidence: ["../outside.md"] }), /ENOENT|exact run/);
  await writeFile(join(dir, "actual.md"), "Report changed."); await assert.rejects(readPipelineCheckpoints(dir, { taskId: "task_a", runId: "run_a", serverId: "remote", workspaceId: "work" }), /evidence changed/);
});
