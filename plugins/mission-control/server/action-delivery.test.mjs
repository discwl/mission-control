import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { automaticFixture } from "./automatic-pipeline-fixture.mjs";
import { assignmentSchema } from "./stage-records.mjs";
import { saveActionBundle, readActionAuthorization, completeActionDelivery, readReportCompletion, reportEvidenceRevision } from "./action-bundles.mjs";
const require = createRequire(import.meta.url), ts = require("typescript");
require.extensions[".ts"] = (module, file) => module._compile(ts.transpileModule(readFileSync(file, "utf8"), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText, file);
const { createActionDeliveryService } = require("./action-delivery.ts");
async function fixture(t, kind = "actions", failSend = false) {
  const { facts, at } = automaticFixture(kind), task = facts.entry.task, run = facts.entry.run;
  const root = await mkdtemp(join(tmpdir(), "mc-action-delivery-")); t.after(() => rm(root, { recursive: true, force: true }));
  const taskFolder = join(root, task.taskId), runFolder = join(taskFolder, "runs", run.runId); await mkdir(runFolder, { recursive: true });
  const identity = { taskId: task.taskId, runId: run.runId, serverId: run.serverId, workspaceId: run.workspaceId };
  const args = { taskFolder, runFolder, task, identity, assignment: assignmentSchema.parse({ ...identity, id: "00000000-0000-4000-8000-000000000001", agentId: "builder-agent", workflowMode: "automatic", deliveryKind: kind, execution: { assignmentId: "00000000-0000-4000-8000-000000000001", role: "builder", policyRevision: facts.agentPolicy.revision, profileId: "builder", profileName: "Builder", provider: "provider", model: "builder-model" }, stage: "execute", planRevision: facts.planRevision, candidate: null, createdAt: at(2), reviewCount: 2, manifest: null }), input: { kind, summary: "Exact reviewed staging action", environment: "staging", prerequisites: ["Confirm account"], steps: kind === "actions" ? [{ instruction: "tool set staging value=2", effect: "Set staging value to 2" }] : [], verification: ["Read staging value"], rollback: "Restore previous value", ...(kind === "report" ? { report: "Read-only result with evidence." } : {}) } };
  const bind = snapshot => {
    facts.candidate = { head: null, tree: snapshot.revision }; facts.actionBundle.revision = snapshot.revision;
    for (const checkpoint of facts.checkpoints) if (checkpoint.stage !== "plan-review") { checkpoint.candidate = { ...facts.candidate }; if (checkpoint.artifactReview) checkpoint.artifactReview.revision = snapshot.revision; }
  };
  bind(await saveActionBundle(args));
  facts.assignments = [{ agentId: "builder-agent", stage: "execute", model: "builder-model", createdAt: at(2) }];
  let sent = 0;
  const agent = { status: "idle", workspaceId: run.workspaceId, activeTurn: null, pendingPermissions: [], archivedAt: null };
  const paseo = { agents: { ref: () => ({ refresh: async () => ({ agent }), send: async () => { sent++; if (failSend) throw new Error("transport timeout"); } }) } };
  const deps = { sources: async () => [{ task, folder: taskFolder, file: join(taskFolder, "task.md") }], inspect: async () => facts };
  const service = createActionDeliveryService(deps), ref = { serverId: run.serverId, taskId: task.taskId };
  return { facts, args, bind, deps, service, paseo, ref, agent, sent: () => sent };
}

test("final action authorization requires current exact dual-reviewed preview and resumes once", async t => {
  const f = await fixture(t), preview = await f.service.check(f.ref, f.paseo);
  assert.equal(preview.ready, true, preview.reason); assert.equal(f.sent(), 0);
  const input = { ...f.ref, fingerprint: preview.plan.fingerprint, actorId: "human-ui" };
  assert.equal((await f.service.authorize({ ...input, fingerprint: "0".repeat(64) }, f.paseo)).outcome, "refused");
  const result = await f.service.authorize(input, f.paseo); assert.equal(result.outcome, "resumed", result.reason);
  assert.equal(f.sent(), 1); assert.equal((await readActionAuthorization(f.args)).resumeState, "sent");
  assert.equal((await f.service.authorize(input, f.paseo)).outcome, "resumed"); assert.equal(f.sent(), 1);
  const checked = await f.service.check(f.ref, f.paseo); assert.equal(checked.authorized, true); assert.equal(checked.completed, false);
});

test("changed reviews, bundle, or worker state refuse authorization without sending", async t => {
  const f = await fixture(t), preview = await f.service.check(f.ref, f.paseo), input = { ...f.ref, fingerprint: preview.plan.fingerprint, actorId: "human-ui" };
  f.facts.checkpoints.at(-1).verdict = "changes_requested";
  assert.equal((await f.service.authorize(input, f.paseo)).outcome, "refused");
  f.facts.checkpoints.at(-1).verdict = "pass"; f.agent.activeTurn = {};
  assert.equal((await f.service.authorize(input, f.paseo)).outcome, "refused"); f.agent.activeTurn = null;
  f.bind(await saveActionBundle({ ...f.args, input: { ...f.args.input, environment: "qa" } }));
  assert.equal((await f.service.authorize(input, f.paseo)).outcome, "refused"); assert.equal(f.sent(), 0); assert.equal(await readActionAuthorization(f.args), null);
});

test("uncertain resume survives restart and never repeats external action delivery", async t => {
  const f = await fixture(t, "actions", true), preview = await f.service.check(f.ref, f.paseo), input = { ...f.ref, fingerprint: preview.plan.fingerprint, actorId: "human-chat" };
  assert.equal((await f.service.authorize(input, f.paseo)).outcome, "uncertain");
  const restarted = createActionDeliveryService(f.deps);
  assert.equal((await restarted.authorize(input, f.paseo)).outcome, "uncertain"); assert.equal(f.sent(), 1);
  assert.equal((await restarted.check(f.ref, f.paseo)).authorized, false);
});

test("only the authorized builder's actual hashed execution reports complete actions", async t => {
  const f = await fixture(t), preview = await f.service.check(f.ref, f.paseo);
  const completion = { ...f.args, agentId: "builder-agent", actionRevision: preview.plan.revision, policyRevision: f.facts.agentPolicy.revision, planRevision: f.facts.planRevision, evidence: ["execution.md"], summary: "Executed exact staging action and verified the new value." };
  await writeFile(join(f.args.runFolder, "execution.md"), "Command receipt: staged value set to 2. Verification: value is 2.\n");
  await assert.rejects(completeActionDelivery(completion), /exact recorded authorization/);
  await f.service.authorize({ ...f.ref, fingerprint: preview.plan.fingerprint, actorId: "human-ui" }, f.paseo);
  await assert.rejects(completeActionDelivery({ ...completion, agentId: "other" }), /assigned worker/);
  await assert.rejects(completeActionDelivery({ ...completion, evidence: ["../../escape.md"] }), /inside the current run/);
  const receipt = await completeActionDelivery(completion); assert.equal(receipt.resumeState, "completed");
  assert.equal((await f.service.check(f.ref, f.paseo)).completed, true); assert.equal(f.sent(), 1);
  await writeFile(join(f.args.runFolder, "execution.md"), "Tampered results\n");
  await assert.rejects(readActionAuthorization(f.args), /evidence changed/);
  assert.equal((await f.service.check(f.ref, f.paseo)).completed, false);
});

test("reviewed read-only reports persist exact completion without an execution authorization", async t => {
  const f = await fixture(t, "report"), preview = await f.service.check(f.ref, f.paseo);
  assert.equal(preview.ready, true, preview.reason); assert.equal(preview.completed, true); assert.match(preview.plan.bundle.report, /Read-only/);
  assert.equal((await f.service.authorize({ ...f.ref, fingerprint: preview.plan.fingerprint, actorId: "human-ui" }, f.paseo)).outcome, "refused"); assert.equal(f.sent(), 0);
  const args = { ...f.args, policyRevision: f.facts.agentPolicy.revision, checkpointDigest: reportEvidenceRevision(f.facts.checkpoints) };
  const receipt = await readReportCompletion(args); assert.equal(receipt.fingerprint, preview.plan.fingerprint);
  const restarted = createActionDeliveryService(f.deps); assert.equal((await restarted.check(f.ref, f.paseo)).completed, true);
  assert.equal((await readReportCompletion(args)).completedAt, receipt.completedAt);
  assert.equal(await readReportCompletion({ ...args, policyRevision: "changed" }), null);
  f.bind(await saveActionBundle({ ...f.args, input: { ...f.args.input, report: "Updated report requires fresh review." } }));
  assert.equal(await readReportCompletion(args), null);
  f.facts.checkpoints.pop(); assert.equal((await restarted.check(f.ref, f.paseo)).completed, false);
});

test("uncertain authorization reconciles only actual exact authorized execution evidence without resending", async t => {
  const f = await fixture(t, "actions", true), preview = await f.service.check(f.ref, f.paseo);
  await f.service.authorize({ ...f.ref, fingerprint: preview.plan.fingerprint, actorId: "human-chat" }, f.paseo);
  const completion = { ...f.args, agentId: "builder-agent", actionRevision: preview.plan.revision, policyRevision: f.facts.agentPolicy.revision, planRevision: f.facts.planRevision, evidence: ["execution.md"], summary: "Observed the authorized staging action completed and verified value 2." };
  await assert.rejects(completeActionDelivery({ ...completion, evidence: [] }), /actual execution/);
  await writeFile(join(f.args.runFolder, "execution.md"), "Actual execution receipt and verification: staging value 2.\n");
  await assert.rejects(completeActionDelivery({ ...completion, policyRevision: "changed" }), /Current policy changed/);
  await assert.rejects(completeActionDelivery({ ...completion, planRevision: "changed" }), /accepted plan changed/);
  await assert.rejects(completeActionDelivery({ ...completion, agentId: "other" }), /assigned worker/);
  const receipt = await completeActionDelivery(completion);
  assert.equal(receipt.resumeState, "completed"); assert.equal(receipt.completion.reconciledFrom, "uncertain"); assert.equal(f.sent(), 1);
  assert.equal((await f.service.check(f.ref, f.paseo)).completed, true); assert.equal(f.sent(), 1);
});
