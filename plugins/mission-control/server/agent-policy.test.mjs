import assert from "node:assert/strict";
import { test } from "node:test";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { checkpointStageEvidence } from "./stage-records.mjs";
import { verifyCoverage, combineReviewFindings } from "../shared/stage-evidence.mjs";
import { writePipelineCheckpoint } from "./pipeline-records.mjs";
import { verifyManagedReviewDecision } from "./review-decision-evidence.mjs";
const require = createRequire(import.meta.url); const ts = require("typescript");
require.extensions[".ts"] = (module, file) => module._compile(ts.transpileModule(readFileSync(file, "utf8"), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText, file);
const { roleMappingSchema, resolveRolePolicy } = require("../shared/agent-policy.ts");
const { nextPipelineStep, missingReviewRole } = require("../shared/pipeline-model.ts");
const { pipelinePrompt } = require("./pipeline-engine.ts");
const profiles = ["planner", "builder", "reviewer", "reviewer2"].map((id, i) => ({ id, name: id, provider: "provider", model: `model-${i}`, modeId: "safe", thinkingOptionId: "high", featureValues: { fast: false } }));
const mapping = roleMappingSchema.parse({ planner: "planner", builder: "builder", reviewer: "reviewer", reviewer2: "reviewer2", reviewCount: 2 });
const policy = (overrides = {}) => ({ projectId: null, taskId: null, mapping, updatedAt: "now", ...overrides });
test("native profiles resolve host/project/task precedence and validator inherits builder without losing runtime settings", () => {
  const policies = [policy(), policy({ projectId: "project", mapping: { ...mapping, planner: "builder" } }), policy({ projectId: "project", taskId: "task", mapping: { ...mapping, planner: "reviewer" } })];
  assert.equal(resolveRolePolicy(policies, profiles, "project", "task").source, "task");
  assert.equal(resolveRolePolicy(policies, profiles, "project", "other").profiles[0].id, "builder");
  const resolved = resolveRolePolicy(policies, profiles, "other", "task");
  assert.equal(resolved.source, "host"); assert.equal(resolved.profiles.find(item => item.role === "validator").id, "builder");
  assert.deepEqual(resolved.profiles[0].featureValues, { fast: false });
  assert.equal(resolveRolePolicy([], profiles, null, null), null);
});
test("missing profiles, automatic models, and aliases of one model cannot satisfy two-model review", () => {
  assert.throws(() => resolveRolePolicy([policy()], profiles.slice(0, 2), null, null), /available native/);
  assert.throws(() => resolveRolePolicy([policy()], profiles.map(item => ({ ...item, model: "auto" })), null, null), /explicit model/);
  assert.throws(() => resolveRolePolicy([policy()], profiles.map(item => item.id === "reviewer2" ? { ...item, provider: "other", model: "vendor/model-2" } : item), null, null), /different underlying/);
});
test("OCR coverage uses file/status identity and refuses omissions, duplicates and unexplained skips", () => {
  const files = [{ path: "x.ts", status: "deleted" }, { path: "x.ts", status: "added" }];
  const coverage = files.map(item => ({ ...item, outcome: "reviewed", reason: "" }));
  verifyCoverage(files, coverage, true);
  assert.throws(() => verifyCoverage(files, coverage.slice(0, 1), true), /every selected/);
  assert.throws(() => verifyCoverage(files, [coverage[0], coverage[0]], true), /duplicate/);
  assert.throws(() => verifyCoverage(files, [{ ...coverage[0], outcome: "skipped" }, coverage[1]], false), /concrete reason/);
  assert.throws(() => verifyCoverage(files, [{ ...coverage[0], outcome: "skipped", reason: "unreadable" }, coverage[1]], true), /passing review/);
});
const candidate = { head: "a".repeat(40), tree: "b".repeat(40) }; const planRevision = "c".repeat(64);
const identity = { taskId: "task_a", runId: "run_a", serverId: "remote", workspaceId: "work" };
const verifiedRuntime = { verifyAgent: async () => ({ verifiedAt: new Date().toISOString() }) };
const approvedRevision = async () => planRevision;
const execution = (role, assignmentId = randomUUID()) => ({ assignmentId, policyRevision: "policy", role, profileId: role, profileName: role, provider: "provider", model: profiles.find(item => item.id === role)?.model ?? "builder" });
const checkpoint = (stage, extra = {}) => ({ ...identity, id: randomUUID(), agentId: stage === "review" ? "reviewer" : "builder", implementationAgentId: "builder", stage, verdict: "pass", scope: "approved", candidate, planRevision, createdAt: stage === "execute" ? "2026-10-29T00:00:01.000Z" : stage === "validate" ? "2026-10-29T00:00:02.000Z" : "2026-10-29T00:00:03.000Z", summary: "Checked", evidence: [], ...extra });
function facts() { return { entry: { task: { taskId: "task_a", status: "ready" }, run: { runId: "run_a", agentId: "original", outcome: "completed" }, decisions: [], questions: [], problem: null }, candidate, planRevision, checkpoints: [checkpoint("execute"), checkpoint("validate")], problem: null, agentPolicy: { ...resolveRolePolicy([policy()], profiles, null, null), revision: "policy" } }; }
const row = { stage: "review", repairs: 0, repairIds: [] };
test("two-model pipeline requires both current independent reviewers and retains a repair even if the other passes", () => {
  const f = facts(); const first = checkpoint("review", { execution: execution("reviewer"), ocr: { coverage: [], findings: [], excluded: 0 } }); f.checkpoints.push(first);
  assert.equal(missingReviewRole(f), "reviewer2"); assert.equal(nextPipelineStep(row, f).stage, "review");
  const second = checkpoint("review", { agentId: "second", execution: execution("reviewer2"), ocr: { coverage: [], findings: [], excluded: 0 }, createdAt: "2026-10-29T00:00:04.000Z" }); f.checkpoints.unshift(second);
  assert.equal(missingReviewRole(f), null); const next = nextPipelineStep(row, f);
  assert.match(pipelinePrompt(row, f, next), /configured independent reviews are complete/);
  first.verdict = "repair"; assert.equal(nextPipelineStep(row, f).stage, "fix");
  first.scope = "needs_plan"; assert.equal(nextPipelineStep(row, f).stage, "plan");
  f.checkpoints = f.checkpoints.filter(item => item !== second); assert.equal(nextPipelineStep(row, f).stage, "plan", "scope change stops before starting the second reviewer");
  f.checkpoints.unshift(second); first.scope = "approved";
  first.verdict = "pass"; second.agentId = first.agentId; assert.equal(missingReviewRole(f), "reviewer2");
  second.agentId = "builder"; assert.equal(missingReviewRole(f), "reviewer2");
  second.agentId = "second"; second.candidate = { ...candidate, tree: "d".repeat(40) }; assert.equal(missingReviewRole(f), "reviewer2");
});
test("exact duplicate findings retain both authors while different severities/details are preserved", () => {
  const finding = { title: "Missing check", detail: "Input can be absent", file: "x.ts", severity: "high" };
  const reviews = ["a", "b"].map(agentId => ({ agentId, execution: { model: agentId }, ocr: { findings: [finding] } }));
  assert.equal(combineReviewFindings(reviews).length, 1); assert.equal(combineReviewFindings(reviews)[0].reviewers.length, 2);
  reviews[1].ocr.findings = [{ ...finding, severity: "low" }]; assert.equal(combineReviewFindings(reviews).length, 2);
});
async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "mc-stage-evidence-")); t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, "stage-assignments")); await writeFile(join(root, "report.md"), "actual checks");
  async function assign(role, agentId = role) {
    const id = randomUUID(); const manifest = `ocr-${id}.json`;
    const assigned = { ...identity, id, agentId, stage: "review", execution: execution(role, id), planRevision, candidate, createdAt: new Date().toISOString(), reviewCount: 2, manifest };
    await writeFile(join(root, "stage-assignments", `${id}.json`), JSON.stringify(assigned));
    await writeFile(join(root, manifest), JSON.stringify({ assignmentId: id, candidate, files: [{ path: "x.ts", status: "added" }], excluded: [] }));
    return assigned;
  }
  return { root, assign };
}
test("managed checkpoint binds the real assignment, requires OCR ledger and hashes its machine-captured manifest", async t => {
  const { root, assign } = await fixture(t); const assigned = await assign("reviewer");
  const input = { stage: "review", verdict: "pass", scope: "approved", summary: "checked", evidence: ["report.md"], planRevision, coverage: [{ path: "x.ts", status: "added", outcome: "reviewed", reason: "" }] };
  await assert.rejects(checkpointStageEvidence(root, { ...identity, agentId: "impostor", candidate }, input), /no assignment/);
  await assert.rejects(checkpointStageEvidence(root, { ...identity, agentId: "reviewer", candidate: { ...candidate, tree: "e".repeat(40) } }, input, verifiedRuntime), /Code changed/);
  await assert.rejects(checkpointStageEvidence(root, { ...identity, agentId: "reviewer", candidate }, input, { verifyAgent: async () => { throw new Error("Runtime model changed"); } }), /Runtime model changed/);
  const enriched = await checkpointStageEvidence(root, { ...identity, agentId: "reviewer", candidate }, input, verifiedRuntime);
  assert.equal(enriched.execution.assignmentId, assigned.id); assert.ok(enriched.evidence.includes(assigned.manifest));
  const saved = await writePipelineCheckpoint(root, { ...identity, agentId: "reviewer", implementationAgentId: "builder", candidate }, enriched);
  assert.equal(saved.evidence.length, 3); assert.equal(saved.ocr.coverage.length, 1);
});
test("human decision requires both completed reviews; legacy runs keep their history", async t => {
  const { root, assign } = await fixture(t);
  assert.equal(await verifyManagedReviewDecision(root, identity, candidate, []), null);
  await writePipelineCheckpoint(root, { ...identity, agentId: "validator", implementationAgentId: "builder", candidate }, { stage: "validate", verdict: "pass", scope: "approved", summary: "checks passed", evidence: ["report.md"], planRevision });
  async function complete(role, scope = "approved") {
    await assign(role);
    const input = await checkpointStageEvidence(root, { ...identity, agentId: role, candidate }, { stage: "review", verdict: "pass", scope, summary: "checked", evidence: ["report.md"], planRevision, coverage: [{ path: "x.ts", status: "added", outcome: "reviewed", reason: "" }] }, verifiedRuntime);
    await writePipelineCheckpoint(root, { ...identity, agentId: role, implementationAgentId: "builder", candidate }, input);
  }
  await complete("reviewer"); await assert.rejects(verifyManagedReviewDecision(root, identity, candidate, [], approvedRevision, verifiedRuntime), /reviewer2/);
  await complete("reviewer2"); assert.equal((await verifyManagedReviewDecision(root, identity, candidate, [], approvedRevision, verifiedRuntime)).reviewers.length, 2);
  await assert.rejects(verifyManagedReviewDecision(root, identity, candidate, [], async () => "different-plan", verifiedRuntime), /currently approved/);
  await assert.rejects(verifyManagedReviewDecision(root, identity, candidate, [], approvedRevision, { verifyAgent: async () => { throw new Error("Runtime model changed"); } }), /Runtime model changed/);
  await complete("reviewer2", "needs_plan");
  await assert.rejects(verifyManagedReviewDecision(root, identity, candidate, [], approvedRevision, verifiedRuntime), /reviewer2/);
});
