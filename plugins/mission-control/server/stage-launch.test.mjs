import assert from "node:assert/strict";
import { test } from "node:test";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { mkdtemp, mkdir, rm, readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
const require = createRequire(import.meta.url); const ts = require("typescript");
require.extensions[".ts"] = (module, file) => module._compile(ts.transpileModule(readFileSync(file, "utf8"), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText, file);
const { launchManagedStage } = require("./stage-launch.ts");
const { pipelineFingerprint, nextPipelineStep } = require("../shared/pipeline-model.ts");
const { resolveRolePolicy } = require("../shared/agent-policy.ts");
const policies = require("./agent-policy.ts"); const tasks = require("./tasks.ts"); const runs = require("./runs.ts"); const decisions = require("./decisions.ts"); const parent = require("./launch-parent.ts"); const merge = require("./merge.ts"); const ocr = require("./ocr-execution.ts"); const processTree = require("./process-tree.ts");
async function fixture(t, automatic = false) {
  const temporary = await mkdtemp(join(tmpdir(), "mc-stage-launch-")); t.after(() => rm(temporary, { recursive: true, force: true }));
  const root = join(temporary, "task_a"); await mkdir(root);
  const runId = `run_${randomUUID()}`; await mkdir(join(root, "runs", runId), { recursive: true });
  const candidate = { head: "a".repeat(40), tree: "b".repeat(40) }; const planRevision = "c".repeat(64);
  const task = { taskId: "task_a", projectId: "project", title: "Example", status: "ready", assignments: [{ serverId: "remote", workspaceId: "work" }] };
  const profiles = ["planner", "builder", "reviewer", "reviewer2"].map((id, i) => ({ id, name: id, provider: "provider", model: `model-${i}`, modeId: "safe", thinkingOptionId: "high", featureValues: { fast: false } }));
  const policy = resolveRolePolicy([{ projectId: null, taskId: null, updatedAt: "now", mapping: { planner: "planner", builder: "builder", validator: null, reviewer: "reviewer", reviewer2: "reviewer2", reviewCount: 2 } }], profiles, null, null, automatic ? "automatic" : "manual");
  const facts = { entry: { task, run: { runId, agentId: "old-worker", outcome: "completed" }, decisions: [], questions: [] }, candidate, planRevision, checkpoints: [], agentPolicy: policy, problem: null };
  const row = { workflowMode: automatic ? "automatic" : "manual", deliveryKind: "code", taskId: task.taskId, coordinatorId: "coordinator", remoteServerId: "remote", stage: "execute", repairs: 0, repairIds: [] };
  const created = []; const sent = []; const calls = []; const catalogCalls = [];
  const paseo = { workspaces: { ref: () => ({ refresh: async () => ({ workspaceDirectory: root, projectId: "project" }), agents: { create: async input => { created.push(input); return { send: async (...args) => sent.push(args) }; } } }) } };
  t.mock.method(tasks, "assignedTask", async () => ({ task, folder: root }));
  t.mock.method(policies, "effectiveAgentPolicy", async () => policy); t.mock.method(policies, "verifyProfileAvailability", async (...args) => { catalogCalls.push(args); });
  t.mock.method(parent, "requireLaunchParent", async value => calls.push(value));
  t.mock.method(merge, "reviewCandidate", async () => candidate); t.mock.method(decisions, "profileKitRoot", async () => root); t.mock.method(runs, "taskAgentPrompt", async () => ({ prompt: "Exact task" }));
  t.mock.method(ocr, "executeOcr", async (_cwd, _base, _candidate, assignmentId) => ({ assignmentId, candidate, files: [], excluded: [], previews: [], rules: [], version: "test" }));
  t.mock.method(ocr, "resolveOcrScope", async () => ({ base: candidate.head, rootCommit: null, source: "task", from: null, since: candidate.head }));
  t.mock.method(require("./review-marks.ts"), "createReviewMarkStore", () => ({ read: async () => ({ from: null, since: null, branchBase: null }) }));
  const input = () => ({ serverId: "remote", workspaceId: "work", row, parent: { serverId: "personal", agentId: "coordinator" }, fingerprint: pipelineFingerprint(facts, nextPipelineStep(row, facts)), requestId: `mc-${randomUUID()}` });
  return { root, runId, facts, row, paseo, input, created, sent, calls, catalogCalls };
}
test("native stage launch copies the entire selected profile and keeps the original parent, task and run", async t => {
  const f = await fixture(t); const result = await launchManagedStage(f.input(), f.facts, f.paseo, {});
  assert.equal(result.runId, f.runId); assert.equal(f.created.length, 1);
  assert.equal(f.catalogCalls.length, 1); assert.equal(f.catalogCalls[0][2], f.root);
  assert.deepEqual(f.created[0].config, { provider: "provider/model-1", modeId: "safe", thinkingOptionId: "high", featureValues: { fast: false } });
  assert.deepEqual(f.created[0].parent, { serverId: "personal", agentId: "coordinator" });
  assert.equal(f.created[0].labels["mission-control.task-id"], "task_a");
  assert.match(f.sent[0][0], /smallest useful change/); assert.match(f.sent[0][0], /Do not create another worker or run/);
  const directory = join(f.root, "runs", f.runId, "stage-assignments"); const record = JSON.parse(await readFile(join(directory, (await readdir(directory))[0]), "utf8"));
  assert.equal(record.agentId, result.agentId); assert.equal(record.execution.model, "model-1");
});
test("automatic planner submits evidence and a different-model critic reviews the exact plan without requesting human approval", async t => {
  const f = await fixture(t, true); f.facts.planRevision = null; f.facts.workflowMode = "automatic"; f.facts.deliveryKind = "code";
  await launchManagedStage(f.input(), f.facts, f.paseo, {});
  assert.equal(f.created[0].labels["mission-control.role"], "planner");
  assert.match(f.sent[0][0], /dev-flow submit-plan/); assert.match(f.sent[0][0], /supersedes generic profile notes/);
  const folder = join(f.root, "runs", f.runId), directory = join(folder, "stage-assignments");
  const assignment = JSON.parse(await readFile(join(directory, (await readdir(directory))[0]), "utf8"));
  assert.equal(assignment.workflowMode, "automatic"); assert.equal(assignment.reviewCount, 2);
  await writeFile(join(f.root, "plan.md"), "# Plan\nA scoped implementation and meaningful validation.\n");
  const { saveAutomaticPlan } = await import("./plan-snapshots.mjs"); const { planBrief } = await import("./plan-test-data.mjs");
  const plan = await saveAutomaticPlan({ taskFolder: f.root, runFolder: folder, task: f.facts.entry.task, identity: { taskId: f.row.taskId, runId: f.runId, serverId: "remote", workspaceId: "work" }, assignment, brief: planBrief });
  f.facts.planRevision = plan.revision; f.facts.submittedPlan = plan;
  await launchManagedStage(f.input(), f.facts, f.paseo, {});
  assert.equal(f.created[1].labels["mission-control.role"], "planReviewer"); assert.notEqual(f.created[1].config.provider, f.created[0].config.provider);
  assert.match(f.sent[1][0], /Pass a sufficient plan/); assert.match(f.sent[1][0], /Do not invoke review-changes or OCR/);
  assert.match(f.sent[1][0], /Do not edit the plan or implementation/);
  assert.match(f.sent[1][0], /scope approved\|needs_plan/); assert.doesNotMatch(f.sent[1][0], /needs-approval/);
  const records = await Promise.all((await readdir(directory)).map(async name => JSON.parse(await readFile(join(directory, name), "utf8"))));
  const critic = records.find(record => record.stage === "plan-review"); assert.deepEqual(critic.candidate, { head: null, tree: plan.revision }); assert.equal(critic.planScopeRevision, plan.scopeRevision);
  await writeFile(join(f.root, "plan.md"), "# Changed without submitting\n");
  await assert.rejects(launchManagedStage(f.input(), f.facts, f.paseo, {}), /submitted plan changed/);
  assert.equal(f.created.length, 2);
});

test("a new automatic code task never plans in a shared checkout: without its own worktree the launch refuses before any worker exists", async t => {
  const f = await fixture(t, true);
  Object.assign(f.facts, { workflowMode: "automatic", deliveryKind: "code", planRevision: null, candidate: null });
  f.facts.entry.run = null;
  await assert.rejects(launchManagedStage(f.input(), f.facts, f.paseo, {}), /no worktree of its own yet/);
  assert.equal(f.created.length, 0); assert.equal(f.sent.length, 0);
});

for (const kind of ["actions", "report"]) test(`a revised ${kind} plan can replace an old bundle without allowing stale validation or review`, async t => {
  const f = await fixture(t, true);
  Object.assign(f.facts, { workflowMode: "automatic", deliveryKind: kind, planRevision: null, candidate: null, actionBundle: null });
  f.row.deliveryKind = kind;
  const folder = join(f.root, "runs", f.runId), directory = join(folder, "stage-assignments");
  const identity = { taskId: f.row.taskId, runId: f.runId, serverId: "remote", workspaceId: "work" };
  const args = { taskFolder: f.root, runFolder: folder, task: f.facts.entry.task, identity };
  const assignments = async () => Promise.all((await readdir(directory)).map(async name => JSON.parse(await readFile(join(directory, name), "utf8"))));
  const { saveAutomaticPlan } = await import("./plan-snapshots.mjs");
  const { planBrief } = await import("./plan-test-data.mjs");
  const { saveActionBundle, readActionBundle } = await import("./action-bundles.mjs");
  await launchManagedStage(f.input(), f.facts, f.paseo, {});
  const planner = (await assignments()).find(item => item.stage === "plan");
  await writeFile(join(f.root, "plan.md"), "# Original plan\nPrepare the original artifact.\n");
  const original = await saveAutomaticPlan({ ...args, assignment: planner, brief: planBrief });
  const previousBuilderProfile = f.facts.agentPolicy.profiles.find(item => item.role === "builder"), previousBuilderId = randomUUID();
  const previousBuilder = { ...planner, id: previousBuilderId, agentId: randomUUID(), stage: "execute", planRevision: original.revision, planScopeRevision: original.scopeRevision, execution: { ...planner.execution, assignmentId: previousBuilderId, role: "builder", profileId: previousBuilderProfile.id, profileName: previousBuilderProfile.name, provider: previousBuilderProfile.provider, model: previousBuilderProfile.model } };
  const oldBundle = await saveActionBundle({ ...args, assignment: previousBuilder, input: { kind, summary: "Original prepared result", environment: "Local fixture only", prerequisites: ["Read the plan"], steps: kind === "report" ? [] : [{ instruction: "Inspect the local fixture", effect: "No external changes" }], verification: ["Check the local result"], rollback: "No external changes to reverse", ...(kind === "report" ? { report: "Original read-only findings" } : {}) } });
  const oldPath = join(folder, "actions", `bundle-${oldBundle.revision}.json`), oldBytes = await readFile(oldPath);
  await writeFile(join(f.root, "plan.md"), "# Revised plan\nPrepare a corrected artifact with revised checks.\n");
  const revised = await saveAutomaticPlan({ ...args, assignment: planner, brief: { ...planBrief, changesSincePrevious: ["Clarify the checks"] } });
  f.facts.planRevision = revised.revision; f.facts.submittedPlan = revised;
  assert.notEqual(revised.revision, original.revision);
  await assert.rejects(readActionBundle({ ...args, planRevision: revised.revision }), /plan/i);
  assert.equal(nextPipelineStep(f.row, f.facts).stage, "plan-review");
  await launchManagedStage(f.input(), f.facts, f.paseo, {});
  const critic = (await assignments()).find(item => item.stage === "plan-review");
  assert.deepEqual(critic.candidate, { head: null, tree: revised.revision });
  assert.equal(f.created[1].labels["mission-control.role"], "planReviewer");
  await writeFile(join(folder, "plan-review.md"), "The revised scope and checks are sufficient.\n");
  const { checkpointStageEvidence } = await import("./stage-records.mjs");
  const { preparePipelineCheckpoint, savePipelineCheckpoint } = await import("./pipeline-records.mjs");
  const context = { ...identity, agentId: critic.agentId, candidate: critic.candidate };
  const stageInput = await checkpointStageEvidence(folder, context, { stage: "plan-review", verdict: "pass", scope: "approved", summary: "Revised plan is sufficient", evidence: ["plan-review.md"], findings: [], planRevision: revised.revision }, { verifyAgent: async assigned => { assert.equal(assigned.id, critic.id); } });
  const accepted = await savePipelineCheckpoint(folder, await preparePipelineCheckpoint(folder, { ...context, implementationAgentId: planner.agentId }, stageInput));
  f.facts.checkpoints = [accepted];
  assert.equal(nextPipelineStep(f.row, f.facts).stage, "execute");
  await launchManagedStage(f.input(), f.facts, f.paseo, {});
  const builder = (await assignments()).find(item => item.stage === "execute");
  assert.equal(f.created[2].labels["mission-control.role"], "builder"); assert.equal(builder.candidate, null);
  assert.deepEqual(await readFile(oldPath), oldBytes);
  assert.equal((await readActionBundle({ ...args, planRevision: original.revision })).revision, oldBundle.revision);
  // Recheck the disk artifact even if an earlier inspection claimed a current candidate.
  f.facts.candidate = { head: null, tree: oldBundle.revision }; f.facts.actionBundle = { revision: oldBundle.revision, kind };
  const base = { runId: f.runId, planRevision: revised.revision, candidate: f.facts.candidate, deliveryKind: kind, verdict: "pass", scope: "approved", agentId: builder.agentId };
  f.facts.checkpoints.push({ ...base, id: "execute", stage: "execute", createdAt: new Date(Date.now() + 1000).toISOString(), execution: builder.execution });
  assert.equal(nextPipelineStep(f.row, f.facts).stage, "validate");
  await assert.rejects(launchManagedStage(f.input(), f.facts, f.paseo, {}), /plan/i);
  const validator = f.facts.agentPolicy.profiles.find(item => item.role === "validator");
  f.facts.checkpoints.push({ ...base, id: "validate", stage: "validate", createdAt: new Date(Date.now() + 2000).toISOString(), execution: { ...builder.execution, role: "validator", profileId: validator.id, provider: validator.provider, model: validator.model } });
  assert.equal(nextPipelineStep(f.row, f.facts).stage, "review");
  await assert.rejects(launchManagedStage(f.input(), f.facts, f.paseo, {}), /plan/i);
  assert.equal(f.created.length, 3); assert.equal(f.sent.length, 3);
});

test("stage discovery rejects a missing or foreign workspace before consulting provider catalogs", async t => {
  const f = await fixture(t);
  for (const workspace of [null, { workspaceDirectory: f.root, projectId: "other" }, { workspaceDirectory: f.root, projectId: "project", archivingAt: "now" }]) {
    f.paseo.workspaces.ref = () => ({ refresh: async () => workspace });
    await assert.rejects(launchManagedStage(f.input(), f.facts, f.paseo, {}), /Stage workspace is unavailable/);
  }
  assert.equal(f.catalogCalls.length, 0); assert.equal(f.created.length, 0);
});
test("failed worker creation cannot leave a new run pointing to a nonexistent worker", async t => {
  const f = await fixture(t); f.facts.entry.run = null; f.facts.planRevision = null;
  f.paseo.workspaces.ref = () => ({ refresh: async () => ({ workspaceDirectory: f.root, projectId: "project" }), agents: { create: async () => { throw new Error("provider unavailable"); } } });
  const start = t.mock.method(processTree, "runProcess", async () => { throw new Error("must not create a run"); });
  await assert.rejects(launchManagedStage(f.input(), f.facts, f.paseo, {}), /provider unavailable/);
  assert.equal(start.mock.callCount(), 0); assert.equal(f.sent.length, 0);
});
test("review does not start if OCR fails or the exact stage fingerprint changes", async t => {
  const f = await fixture(t);
  const base = { runId: f.runId, candidate: f.facts.candidate, planRevision: f.facts.planRevision, verdict: "pass", scope: "approved", agentId: "old-worker" };
  f.facts.checkpoints = [{ ...base, id: "execute", stage: "execute", createdAt: "1" }, { ...base, id: "validate", stage: "validate", createdAt: "2" }];
  t.mock.method(ocr, "executeOcr", async () => { throw new Error("OCR unavailable"); });
  await assert.rejects(launchManagedStage(f.input(), f.facts, f.paseo, {}), /OCR unavailable/);
  assert.equal(f.created.length, 0);
  await assert.rejects(launchManagedStage({ ...f.input(), fingerprint: "old" }, f.facts, f.paseo, {}), /Stage changed/);
});
