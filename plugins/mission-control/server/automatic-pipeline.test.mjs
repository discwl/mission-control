import assert from "node:assert/strict";
import { test } from "node:test";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { automaticFixture } from "./automatic-pipeline-fixture.mjs";
const require = createRequire(import.meta.url), ts = require("typescript");
require.extensions[".ts"] = (module, file) => module._compile(ts.transpileModule(readFileSync(file, "utf8"), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText, file);
const { automaticDeliveryReadiness, nextPipelineStep, missingReviewRole, pipelineFingerprint } = require("../shared/pipeline-model.ts");
const { pipelinePrompt } = require("./pipeline-engine.ts");
const { taskWorkflow, withPipelineProjection } = require("../shared/fleet-model.ts");
const { pipelineSchema } = require("../shared/pipeline-state.ts");
const { resolveRolePolicy } = require("../shared/agent-policy.ts");

function finalFeedback(facts, at) {
  return { schemaVersion: 1, id: "ba155a66-4f85-46e4-80af-668e300f242d", taskId: facts.entry.task.taskId, runId: facts.entry.run.runId, serverId: facts.entry.run.serverId, workspaceId: facts.entry.run.workspaceId, candidate: { ...facts.candidate }, planRevision: facts.planRevision, policyRevision: facts.agentPolicy.revision, scopeRevision: facts.submittedPlan.scopeRevision, note: "Handle the empty response without adding a new abstraction.", requestedAt: at(10), requestedBy: "human" };
}

test("final feedback blocks old acceptance and uses remaining repair budget without fabricated decisions", () => {
  const { row, facts, at } = automaticFixture(); row.stage = "delivery"; row.mode = "ready";
  const before = pipelineFingerprint(facts, nextPipelineStep(row, facts));
  facts.deliveryFeedback = finalFeedback(facts, at); row.repairs = 1;
  assert.equal(automaticDeliveryReadiness(facts).ready, false);
  const next = nextPipelineStep(row, facts);
  assert.equal(next.stage, "fix"); assert.equal(next.dispatch, true); assert.equal(next.failureId, facts.deliveryFeedback.id);
  assert.notEqual(pipelineFingerprint(facts, next), before);
  assert.match(pipelinePrompt(row, facts, next), /empty response/);
  assert.equal(facts.entry.decisions.length, 0); assert.equal(row.repairs, 1);
  row.repairIds.push(facts.deliveryFeedback.id); row.repairs++;
  assert.equal(nextPipelineStep(row, facts).dispatch, false);
  row.repairIds = []; assert.equal(nextPipelineStep(row, facts).mode, "blocked");
  assert.match(nextPipelineStep(row, facts).message, /request is saved and publication is blocked/);
});

test("final feedback needs fresh assigned implementation, validation and both reviews even for unchanged tree", () => {
  for (const kind of ["code", "actions", "report"]) {
    const { row, facts, checkpoint, at } = automaticFixture(kind); facts.deliveryFeedback = finalFeedback(facts, at);
    const add = (stage, role, second) => {
      const evidence = stage === "review" ? kind === "code" ? { ocr: { ...facts.checkpoints.find(item => item.stage === "review").ocr, findings: [] } } : { artifactReview: { revision: facts.candidate.tree, findings: [] } } : {};
      const item = checkpoint(stage, role, second, evidence); facts.checkpoints.unshift(item);
      facts.assignments ??= []; facts.assignments.push({ assignmentId: item.execution.assignmentId, agentId: item.agentId, stage, model: item.execution.model, createdAt: at(second - 1) }); return item;
    };
    add("fix", "builder", 12);
    assert.equal(nextPipelineStep(row, facts).stage, "validate", kind);
    add("validate", "validator", 14); add("review", "reviewer", 16);
    assert.equal(automaticDeliveryReadiness(facts).ready, false, kind);
    assert.equal(missingReviewRole(facts, at(14)), "reviewer2");
    const second = add("review", "reviewer2", 18);
    assert.equal(automaticDeliveryReadiness(facts).ready, true, kind);
    facts.assignments.find(item => item.assignmentId === second.execution.assignmentId).createdAt = at(9);
    assert.equal(automaticDeliveryReadiness(facts).ready, false, "a pre-request reviewer session is not fresh");
  }
});

test("final feedback refuses foreign identity or changed scope, plan, policy and authorized action conflicts", () => {
  for (const field of ["taskId", "runId", "serverId", "workspaceId", "planRevision", "policyRevision", "scopeRevision"]) {
    const { row, facts, at } = automaticFixture(); facts.deliveryFeedback = finalFeedback(facts, at); facts.deliveryFeedback[field] = "foreign";
    assert.equal(automaticDeliveryReadiness(facts).ready, false, field); assert.equal(nextPipelineStep(row, facts).mode, "blocked", field);
  }
  const { row, facts, at } = automaticFixture("actions"); facts.deliveryFeedback = finalFeedback(facts, at); facts.actionAuthorization = { phase: "sent", bundleRevision: facts.candidate.tree };
  assert.equal(nextPipelineStep(row, facts).mode, "blocked");
});

test("automatic flow needs exact independent plan acceptance before implementation and retains legacy manual gates", () => {
  const { row, facts } = automaticFixture();
  assert.equal(automaticDeliveryReadiness(facts).ready, true);
  assert.equal(nextPipelineStep(row, facts).mode, "ready");
  assert.deepEqual(facts.entry.decisions, []);
  const legacy = { ...row }; delete legacy.workflowMode; delete legacy.deliveryKind; delete legacy.planRepairs; delete legacy.planRepairIds;
  const parsed = pipelineSchema.parse(legacy); assert.equal(parsed.workflowMode, "manual"); assert.equal(parsed.deliveryKind, "code");
  assert.equal(nextPipelineStep(parsed, facts).mode, "blocked", "machine acceptance is not human approval");
  facts.submittedPlan = null; facts.planRevision = null; assert.equal(nextPipelineStep(row, facts).stage, "plan");
});

test("a plan critic cannot approve stale scope, the planner's own session or the same underlying model", () => {
  for (const mutate of [f => { f.checkpoints[0].planReview.scopeRevision = "f".repeat(64); }, f => { f.checkpoints[0].agentId = f.submittedPlan.plannerAgentId; }, f => { f.checkpoints[0].execution.model = f.submittedPlan.plannerModel; }, f => { f.submittedPlan.policyRevision = "stale"; }, f => { f.checkpoints[0].candidate.tree = "f".repeat(64); }]) {
    const { row, facts } = automaticFixture(); mutate(facts);
    assert.equal(automaticDeliveryReadiness(facts).ready, false); assert.equal(nextPipelineStep(row, facts).stage, "plan-review");
  }
});

test("plan repairs are separate, bounded and cannot be silently replayed", () => {
  const { row, facts } = automaticFixture(); const critic = facts.checkpoints[0]; critic.verdict = "repair";
  const next = nextPipelineStep(row, facts); assert.equal(next.stage, "plan"); assert.equal(next.planFailureId, critic.id); assert.equal(next.failureId, undefined);
  assert.equal(nextPipelineStep({ ...row, repairs: 2 }, facts).dispatch, true);
  assert.equal(nextPipelineStep({ ...row, planRepairs: 2 }, facts).mode, "blocked");
  assert.equal(nextPipelineStep({ ...row, planRepairIds: [critic.id] }, facts).dispatch, false);
  critic.scope = "needs_plan"; assert.equal(nextPipelineStep(row, facts).mode, "blocked");
});

test("validation precedes both sequential independent model reviews", () => {
  const { row, facts } = automaticFixture(); const all = [...facts.checkpoints]; facts.checkpoints = all.slice(0, 1);
  assert.equal(nextPipelineStep(row, facts).stage, "execute");
  facts.checkpoints.push(all[1]); assert.equal(nextPipelineStep(row, facts).stage, "validate");
  facts.checkpoints.push(all[2]); assert.equal(missingReviewRole(facts), "reviewer");
  facts.checkpoints.push(all[3]); assert.equal(missingReviewRole(facts), "reviewer2");
  all[3].verdict = "repair"; assert.equal(nextPipelineStep(row, facts).stage, "review", "complete second opinion before repair");
  facts.checkpoints.push(all[4]); assert.equal(nextPipelineStep(row, facts).stage, "fix");
  assert.equal(nextPipelineStep({ ...row, repairs: 2 }, facts).mode, "blocked");
  all[3].verdict = "pass"; all[4].createdAt = all[2].createdAt; assert.equal(automaticDeliveryReadiness(facts).ready, false);
});

test("review evidence cannot reuse the same session, implementer, model, policy, or stale candidate", () => {
  for (const mutate of [f => { f.checkpoints[4].agentId = f.checkpoints[3].agentId; }, f => { f.checkpoints[4].agentId = f.checkpoints[1].agentId; }, f => { f.checkpoints[4].execution.model = f.checkpoints[3].execution.model; }, f => { f.checkpoints[4].execution.policyRevision = "stale"; }, f => { f.candidate.tree = "f".repeat(40); }, f => { f.checkpoints[4].ocr = undefined; }, f => { f.checkpoints[4].ocr.findings = [{ title: "Defect", severity: "high", detail: "Actual issue", file: "x.ts" }]; }]) {
    const { facts } = automaticFixture(); mutate(facts); assert.equal(automaticDeliveryReadiness(facts).ready, false);
  }
});

test("a changed fix candidate needs fresh validation and both reviews", () => {
  const { row, facts, checkpoint } = automaticFixture(); facts.candidate = { ...facts.candidate, tree: "f".repeat(40) };
  facts.checkpoints.push(checkpoint("fix", "builder", 6, { candidate: facts.candidate }));
  assert.equal(nextPipelineStep(row, facts).stage, "validate");
  facts.checkpoints.push(checkpoint("validate", "validator", 7, { candidate: facts.candidate }));
  assert.equal(nextPipelineStep(row, facts).stage, "review"); assert.equal(missingReviewRole(facts), "reviewer");
});

test("saved questions and human decisions still block; automatic checking does not overwrite them", () => {
  const { row, facts } = automaticFixture(); facts.entry.questions = [{ question: { status: "open" } }];
  assert.equal(nextPipelineStep(row, facts).mode, "waiting"); assert.equal(automaticDeliveryReadiness(facts).ready, false);
  facts.entry.questions = []; facts.entry.decisions = [{ decision: { kind: "plan", status: "open", runId: facts.entry.run.runId, requestedAt: "a" } }];
  assert.equal(nextPipelineStep(row, facts).mode, "waiting");
  facts.entry.decisions[0].decision.status = "changes_requested"; assert.equal(nextPipelineStep(row, facts).mode, "blocked");
  facts.entry.decisions.push({ decision: { kind: "plan", status: "approved", runId: facts.entry.run.runId, requestedAt: "b" } }); assert.equal(automaticDeliveryReadiness(facts).ready, true);
});

test("non-code artifacts use exact reviewed bundle revisions and no fake OCR evidence", () => {
  for (const kind of ["actions", "report"]) {
    const { row, facts } = automaticFixture(kind); assert.equal(automaticDeliveryReadiness(facts).ready, true);
    assert.equal(nextPipelineStep(row, facts).mode, "ready");
    facts.actionBundle = null; facts.candidate = null; assert.equal(nextPipelineStep(row, facts).stage, "execute");
  }
  const { facts } = automaticFixture("actions"); facts.checkpoints[4].artifactReview.revision = "f".repeat(64); assert.equal(automaticDeliveryReadiness(facts).ready, false);
  const report = automaticFixture("report"); report.facts.reportCompletion = { revision: report.facts.candidate.tree, planRevision: report.facts.planRevision, policyRevision: report.facts.agentPolicy.revision, completedAt: report.at(6) };
  assert.equal(nextPipelineStep(report.row, report.facts).mode, "done"); report.facts.reportCompletion.policyRevision = "stale"; assert.equal(nextPipelineStep(report.row, report.facts).mode, "ready");
});

test("prepared final evidence drift stops, and second-review prompt does not reveal first judgment", () => {
  const { row, facts } = automaticFixture(); facts.checkpoints[3].summary = "SECRET FIRST REVIEW JUDGMENT";
  const prompt = pipelinePrompt(row, facts, { stage: "review", mode: "running", message: "Second review", dispatch: true });
  assert.doesNotMatch(prompt, /SECRET FIRST REVIEW JUDGMENT/); assert.match(prompt, /OCR selection\/rules plus Gortex/); assert.match(prompt, /smallest maintainable/);
  const before = pipelineFingerprint(facts, nextPipelineStep(row, facts)); facts.candidate.tree = "f".repeat(40);
  assert.equal(nextPipelineStep({ ...row, stage: "delivery", mode: "ready" }, facts).mode, "blocked"); assert.notEqual(pipelineFingerprint(facts, nextPipelineStep(row, facts)), before);
});

test("fleet projection shows final authorization, action execution and verified completion from matching runner", () => {
  const { row, facts } = automaticFixture(); const snapshot = { hosts: [{ serverId: "remote", snapshot: { tasks: [facts.entry] } }], state: { pipelines: [{ ...row, stage: "delivery", mode: "ready", message: "Approve exact draft PR" }] } };
  const projected = state => withPipelineProjection(snapshot, state ?? snapshot.state).hosts[0].snapshot.tasks[0];
  assert.equal(taskWorkflow(projected(), []).stage, "Delivery approval"); assert.equal(taskWorkflow(projected(), []).actor, "you");
  const updated = { pipelines: [{ ...snapshot.state.pipelines[0], deliveryKind: "actions", mode: "waiting", message: "Execution results pending" }] };
  assert.equal(taskWorkflow(projected(updated), []).stage, "Implementing"); assert.equal(taskWorkflow(projected(updated), []).actor, "agent");
  updated.pipelines[0].mode = "done"; assert.equal(taskWorkflow(projected(updated), []).stage, "Delivered"); assert.equal(taskWorkflow(projected(updated), []).actor, "done");
  updated.pipelines[0].deliveryKind = "report"; assert.equal(taskWorkflow(projected(updated), []).stage, "Delivered");
  const stale = withPipelineProjection({ ...snapshot, hosts: [{ serverId: "remote", snapshot: { tasks: [projected(updated)] } }] }, { pipelines: [{ ...row, runId: "another-run" }] }).hosts[0].snapshot.tasks[0];
  assert.equal(stale.pipeline, undefined); assert.equal(taskWorkflow(stale, []).stage, "Code review");
  const question = projected(); question.questions = [{ question: { status: "open" } }]; assert.equal(taskWorkflow(question, []).stage, "Blocked");
  assert.equal(taskWorkflow(projected(), [{ pendingPermissions: 1 }]).stage, "Blocked");
});

test("a task switched to automatic shows its queued runner, not the old run's waiting decision or retired workers' errors", () => {
  const { row, facts } = automaticFixture();
  // The old manual run waits for a decision that the switch retired; an old reviewer errored long ago.
  const entry = { ...facts.entry, run: { ...facts.entry.run, workflowMode: undefined, outcome: "waiting", nextAction: "Wait for the user's decision on the plan. Do not continue until it arrives." } };
  const errored = { id: "old-reviewer", status: "error", attentionReason: "error", error: "Usage limit", labels: {}, updatedAt: "2026-11-03T10:00:09.000Z", activityAt: "2026-11-03T10:00:09.000Z", pendingPermissions: 0 };
  const snapshot = { hosts: [{ serverId: "remote", snapshot: { tasks: [entry] } }], state: { pipelines: [] } };
  const switched = { ...row, runId: null, stage: "plan", mode: "running", message: "Switched to the automatic workflow.", retiredWorkerIds: ["old-reviewer"] };
  const before = withPipelineProjection(snapshot, { pipelines: [] }).hosts[0].snapshot.tasks[0];
  assert.equal(taskWorkflow(before, []).actor, "you", "without a runner the old run still waits for the user");
  const after = withPipelineProjection(snapshot, { pipelines: [switched] }).hosts[0].snapshot.tasks[0];
  assert.equal(after.pipeline.runId, entry.run.runId); assert.deepEqual(after.pipeline.retiredWorkerIds, ["old-reviewer"]);
  const workflow = taskWorkflow(after, [errored]);
  assert.equal(workflow.stage, "Planning"); assert.equal(workflow.actor, "agent");
  // A stopped switch no longer speaks for the task.
  const stopped = withPipelineProjection(snapshot, { pipelines: [{ ...switched, mode: "stopped" }] }).hosts[0].snapshot.tasks[0];
  assert.equal(stopped.pipeline, undefined);
  // Once automatic stages have run, a blocker they record shows at once, even while the runner waits for its host.
  const dispatched = { ...switched, runId: entry.run.runId, stage: "execute", lastSentAt: "2026-11-03T10:30:00.000Z", message: "Implementing" };
  const blockedEntry = { ...entry, run: { ...entry.run, outcome: "blocked", nextAction: "Needs the staging database password." } };
  const later = withPipelineProjection({ ...snapshot, hosts: [{ serverId: "remote", snapshot: { tasks: [blockedEntry] } }] }, { pipelines: [dispatched] }).hosts[0].snapshot.tasks[0];
  assert.equal(later.pipeline.freshSwitch, false);
  assert.deepEqual([taskWorkflow(later, []).stage, taskWorkflow(later, []).actor], ["Blocked", "you"]);
});

test("on the task's own host, a run whose latest request was retired by a switch waits for the runner, not for the user", () => {
  const { facts } = automaticFixture();
  const retired = { decision: { decisionId: "decision_a", kind: "plan", status: "superseded", runId: facts.entry.run.runId, requestedAt: "2026-11-03T10:00:08.000Z", resume: null } };
  const entry = { ...facts.entry, run: { ...facts.entry.run, workflowMode: undefined, outcome: "waiting", nextAction: "Wait for the user's decision." }, decisions: [retired] };
  assert.deepEqual([taskWorkflow(entry, []).stage, taskWorkflow(entry, []).actor], ["Ready", "agent"]);
  // A real blocker, or an open request, still needs the user.
  assert.equal(taskWorkflow({ ...entry, run: { ...entry.run, outcome: "blocked" } }, []).actor, "you");
  assert.equal(taskWorkflow({ ...entry, decisions: [{ decision: { ...retired.decision, status: "open" } }] }, []).actor, "you");
});

test("failed authorized action execution becomes a visible blocker without resending or repairing", () => {
  const { row, facts } = automaticFixture("actions");
  row.stage = "delivery"; row.mode = "waiting";
  facts.actionAuthorization = { phase: "sent", revision: facts.candidate.tree };
  facts.entry.run.outcome = "blocked";
  facts.entry.run.nextAction = "The script failed after its first update. Inspect the saved result before any retry.";
  for (let attempt = 0; attempt < 3; attempt++) {
    const next = nextPipelineStep(row, facts);
    assert.equal(next.stage, "delivery"); assert.equal(next.mode, "blocked");
    assert.equal(next.message, facts.entry.run.nextAction);
    assert.equal(next.dispatch, false); assert.equal(next.failureId, undefined);
    assert.equal(next.planFailureId, undefined);
    Object.assign(row, next);
  }
  assert.equal(automaticDeliveryReadiness(facts).ready, false);
});

test("action authorization still waits without replay and preserves uncertain or verified completion states", () => {
  const { row, facts } = automaticFixture("actions");
  row.stage = "delivery"; row.mode = "waiting";
  facts.actionAuthorization = { phase: "sent", revision: facts.candidate.tree };
  let next = nextPipelineStep(row, facts);
  assert.equal(next.mode, "waiting"); assert.equal(next.dispatch, false);
  facts.entry.task.status = "blocked"; facts.entry.run.nextAction = "Confirm what the script changed.";
  next = nextPipelineStep(row, facts);
  assert.equal(next.mode, "blocked"); assert.equal(next.message, facts.entry.run.nextAction); assert.equal(next.dispatch, false);
  facts.actionAuthorization.phase = "uncertain";
  next = nextPipelineStep(row, facts);
  assert.equal(next.mode, "blocked"); assert.match(next.message, /delivery is uncertain/); assert.equal(next.dispatch, false);
  facts.actionAuthorization.phase = "completed";
  next = nextPipelineStep(row, facts);
  assert.equal(next.mode, "done"); assert.match(next.message, /verified completion evidence/); assert.equal(next.dispatch, false);
});

test("persisted in-scope repair outcome still permits second review then bounded repair", () => {
  const { row, facts } = automaticFixture(); facts.entry.run.stage = "review"; facts.entry.run.outcome = "in_progress"; const second = facts.checkpoints.pop(); facts.checkpoints.at(-1).verdict = "repair";
  assert.equal(nextPipelineStep(row, facts).stage, "review"); facts.checkpoints.push(second); assert.equal(nextPipelineStep(row, facts).stage, "fix");
  assert.equal(nextPipelineStep({ ...row, repairs: 2 }, facts).mode, "blocked");
});

test("automatic roles derive from existing mappings while legacy policy revision stays byte-for-byte stable", () => {
  const { facts } = automaticFixture(); const profiles = facts.agentPolicy.profiles.filter(p => p.role !== "planReviewer").map(({ role, ...profile }) => profile);
  const mapping = { planner: "planner", builder: "builder", validator: "validator", reviewer: "reviewer", reviewer2: "reviewer2", reviewCount: 1 };
  const saved = [{ projectId: null, taskId: null, mapping, updatedAt: "unchanged" }];
  const manual = resolveRolePolicy(saved, profiles, null, null);
  assert.equal(manual.revision, JSON.stringify(["unchanged", ["planner", "builder", "validator", "reviewer"].map(role => ({ ...profiles.find(p => p.id === mapping[role]), role }))]));
  const automatic = resolveRolePolicy(saved, profiles, null, null, "automatic"); assert.equal(automatic.reviewCount, 2); assert.equal(automatic.profiles.find(p => p.role === "planReviewer").id, "reviewer");
  assert.equal(resolveRolePolicy(saved, profiles, null, null).revision, manual.revision); assert.equal(mapping.reviewCount, 1);
  assert.throws(() => resolveRolePolicy([{ ...saved[0], mapping: { ...mapping, reviewer2: null } }], profiles, null, null, "automatic"), /reviewer2/);
});
