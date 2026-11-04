import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative } from "node:path";
import { capturePlanSnapshot, readPlanSnapshot, saveAutomaticPlan, readAutomaticPlan, verifyAutomaticPlanAcceptance } from "./plan-snapshots.mjs";
import { assignmentSchema, checkpointStageEvidence } from "./stage-records.mjs";
import { writePipelineCheckpoint } from "./pipeline-records.mjs";
import { randomUUID } from "node:crypto";
import { normalizePlanBrief } from "../shared/plan-brief.mjs";
import { planBrief } from "./plan-test-data.mjs";

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "mc-plans-"));
  t.after(async () => { const target = await realpath(root), rel = relative(await realpath(tmpdir()), target); if (!rel.startsWith("mc-plans-") || rel.includes("..") || isAbsolute(rel)) throw new Error("Unsafe test cleanup"); await rm(target, { recursive: true, force: true }); });
  const taskFolder = join(root, "task_aaaa"), runFolder = join(taskFolder, "runs", "run_bbbb");
  await mkdir(join(runFolder, "decisions"), { recursive: true });
  await writeFile(join(taskFolder, "plan.md"), "# Prevention\n\nKeep existing orders unchanged.\n");
  const input = { taskFolder, runFolder, taskId: "task_aaaa", runId: "run_bbbb", decisionId: "decision_cccc", requestedAt: "2026-10-26T10:00:00Z", brief: planBrief };
  const publish = async (input, plan) => writeFile(join(runFolder, "decisions", `${input.decisionId}.md`), `---\n${Object.entries({ schemaVersion: 1, taskId: input.taskId, runId: input.runId, decisionId: input.decisionId, requestedAt: input.requestedAt, kind: "plan", plan }).map(([key,value]) => `${key}: ${JSON.stringify(value)}`).join("\n")}\n---\n`);
  return { root, taskFolder, runFolder, input, publish };
}

test("the brief requires explicit scope, checks and risks; it never fills missing sections", () => {
  assert.equal(normalizePlanBrief(null), null);
  for (const change of [{ successChecks: [] }, { scopeChange: "" }, { risks: [] }, { goal: "x".repeat(601) }, { included: Array(9).fill("Too many") }]) assert.throws(() => normalizePlanBrief({ ...planBrief, ...change }));
  assert.deepEqual(normalizePlanBrief(planBrief), planBrief);
});

test("unpublished snapshots are excluded from revision history", async t => {
  const f = await fixture(t);
  const first = await capturePlanSnapshot(f.input);
  const orphanInput = { ...f.input, decisionId: "decision_dddd", requestedAt: "2026-10-26T11:00:00Z" };
  const orphan = await capturePlanSnapshot(orphanInput);
  assert.equal(JSON.parse(await readFile(join(f.runFolder, orphan.path), "utf8")).previous, null);
  await f.publish(f.input, first);
  const nextInput = { ...f.input, decisionId: "decision_eeee", requestedAt: "2026-10-26T12:00:00Z", brief: { ...planBrief, after: "New orders and renewals reject a full discount.", changesSincePrevious: ["Added renewal coverage."] } };
  const next = await capturePlanSnapshot(nextInput);
  const saved = JSON.parse(await readFile(join(f.runFolder, next.path), "utf8"));
  assert.equal(saved.previous.revision, first.revision);
  assert.notEqual(saved.previous.revision, orphan.revision);
  assert.equal(saved.previous.brief.after, planBrief.after);
});

test("plan snapshots refuse path escapes and directory junctions", async t => {
  const f = await fixture(t);
  await assert.rejects(capturePlanSnapshot({ ...f.input, decisionId: "../escaped" }), /Invalid plan identity/);
  const outside = join(f.root, "outside");
  await mkdir(outside);
  await symlink(outside, join(f.runFolder, "plans"), "junction");
  await assert.rejects(capturePlanSnapshot(f.input), /escape/);
  assert.deepEqual(await readdir(outside), []);
});

async function automaticFixture(t) {
  const f = await fixture(t); const identity = { taskId: f.input.taskId, runId: f.input.runId, serverId: "server", workspaceId: "workspace" };
  const task = { taskId: identity.taskId, hostId: "host", projectId: "project", title: "Prevent full discounts", acceptanceCriteria: ["Existing orders remain unchanged"] };
  const id = randomUUID();
  const assignment = assignmentSchema.parse({ id, ...identity, agentId: "planner", stage: "plan", workflowMode: "automatic", deliveryKind: "code", execution: { assignmentId: id, policyRevision: "policy", role: "planner", profileId: "planner", profileName: "Planner", provider: "claude", model: "fable" }, planRevision: null, candidate: null, createdAt: "2026-01-01T00:00:00Z", reviewCount: 2, manifest: null });
  await mkdir(join(f.runFolder, "stage-assignments")); await writeFile(join(f.runFolder, "stage-assignments", `${id}.json`), JSON.stringify(assignment));
  return { ...f, identity, task, assignment, brief: planBrief, policyRevision: "policy" };
}

test("automatic submissions preserve readable versions without a human approval and reject changed scope, policy, or document", async t => {
  const f = await automaticFixture(t), saved = await saveAutomaticPlan(f);
  assert.deepEqual(await readdir(join(f.runFolder, "decisions")), []);
  const current = await readAutomaticPlan(f); assert.equal(current.revision, saved.revision); assert.equal(current.currentMatch, true); assert.equal(current.scopeMatch, true);
  assert.equal((await readAutomaticPlan({ ...f, task: { ...f.task, acceptanceCriteria: ["Different scope"] } })).scopeMatch, false);
  assert.equal((await readAutomaticPlan({ ...f, policyRevision: "other" })).policyMatch, false);
  await assert.rejects(verifyAutomaticPlanAcceptance(f), /passing independent model critique/);
  await writeFile(join(f.taskFolder, "plan.md"), "# Revised plan\nChanged behavior.\n");
  assert.equal((await readAutomaticPlan(f)).currentMatch, false);
  await assert.rejects(saveAutomaticPlan(f), /changesSincePrevious/);
  const revised = await saveAutomaticPlan({ ...f, brief: { ...planBrief, changesSincePrevious: ["Narrowed behavior"] } });
  assert.equal(revised.previousRevision, saved.revision); assert.notEqual(revised.revision, saved.revision);
  const path = join(f.runFolder, revised.path); await writeFile(path, (await readFile(path, "utf8")) + " ");
  await assert.rejects(readAutomaticPlan(f), /snapshot changed/);
});

test("automatic implementation requires a passing exact-plan critic from a distinct model and agent", async t => {
  const f = await automaticFixture(t), plan = await saveAutomaticPlan(f); const candidate = { head: null, tree: plan.revision };
  async function review(model, agentId, verdict = "pass", findings = []) {
    const id = randomUUID(); const assignment = assignmentSchema.parse({ ...f.assignment, id, agentId, stage: "plan-review", planRevision: plan.revision, planScopeRevision: plan.scopeRevision, candidate, execution: { ...f.assignment.execution, assignmentId: id, role: "planReviewer", model, profileId: "critic", profileName: "Critic" } });
    await writeFile(join(f.runFolder, "stage-assignments", `${id}.json`), JSON.stringify(assignment));
    const report = `critic-${id}.md`; await writeFile(join(f.runFolder, report), `# Verdict\n${verdict}\n`);
    const input = await checkpointStageEvidence(f.runFolder, { ...f.identity, agentId, candidate }, { stage: "plan-review", verdict, scope: "approved", planRevision: plan.revision, summary: "Grounded independent critique", evidence: [report], findings }, { verifyAgent: async () => {} });
    return writePipelineCheckpoint(f.runFolder, { ...f.identity, agentId, candidate, implementationAgentId: "planner" }, input);
  }
  await review("fable", "critic"); await assert.rejects(verifyAutomaticPlanAcceptance(f), /passing independent model critique/);
  await review("opus", "planner"); await assert.rejects(verifyAutomaticPlanAcceptance(f), /passing independent model critique/);
  await review("opus", "critic-2"); assert.equal((await verifyAutomaticPlanAcceptance(f)).revision, plan.revision);
  await assert.rejects(review("opus", "critic-3", "pass", [{ title: "Missing check", severity: "high", detail: "Acceptance criterion is untested" }]), /cannot leave findings/);
  await review("opus", "critic-4", "repair", [{ title: "Missing check", severity: "high", detail: "Acceptance criterion is untested" }]);
  await assert.rejects(verifyAutomaticPlanAcceptance(f), /passing independent model critique/);
});

test("artifact review records the exact bundle and never claims OCR coverage", async t => {
  const f = await automaticFixture(t); const id = randomUUID(), candidate = { head: null, tree: "b".repeat(64) };
  const assignment = assignmentSchema.parse({ ...f.assignment, id, stage: "review", agentId: "reviewer", planRevision: "a".repeat(64), candidate, deliveryKind: "actions", execution: { ...f.assignment.execution, assignmentId: id, role: "reviewer" } });
  await writeFile(join(f.runFolder, "stage-assignments", `${id}.json`), JSON.stringify(assignment));
  const input = { stage: "review", verdict: "pass", planRevision: assignment.planRevision, evidence: ["review.md"], findings: [] };
  const result = await checkpointStageEvidence(f.runFolder, { ...f.identity, agentId: "reviewer", candidate }, input, { verifyAgent: async () => {} });
  assert.equal(result.ocr, undefined); assert.deepEqual(result.artifactReview, { revision: candidate.tree, findings: [] });
  assert.equal(result.deliveryKind, "actions");
  await assert.rejects(checkpointStageEvidence(f.runFolder, { ...f.identity, agentId: "reviewer", candidate: { head: null, tree: "c".repeat(64) } }, input, { verifyAgent: async () => {} }), /changed since/);
});

test("references to another decision never substitute a saved plan", async t => {
  const f = await fixture(t), plan = await capturePlanSnapshot(f.input);
  const decision = { ...f.input, status: "open", plan: { ...plan, path: plan.path.replace("decision_cccc", "decision_dddd") } };
  await assert.rejects(readPlanSnapshot({ ...f, decision }), /does not match this decision/);
});
