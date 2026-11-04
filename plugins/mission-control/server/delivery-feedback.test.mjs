import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { readFileSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";
import { automaticFixture } from "./automatic-pipeline-fixture.mjs";
const require = createRequire(import.meta.url), ts = require("typescript");
require.extensions[".ts"] = (module, file) => module._compile(ts.transpileModule(readFileSync(file, "utf8"), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText, file);
const { createDeliveryFeedbackService, readDeliveryFeedback } = require("./delivery-feedback.ts");
const { automaticDeliveryReadiness } = require("../shared/pipeline-model.ts");
const { withRepository } = require("./project-git.ts");
const exec = promisify(execFile);
async function fixture(t) {
  const { facts } = automaticFixture(), task = facts.entry.task, run = facts.entry.run;
  const root = await mkdtemp(join(tmpdir(), "mc-delivery-feedback-")); t.after(() => rm(root, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 }));
  const repo = join(root, "repo"); await mkdir(repo); await exec("git", ["init", repo]);
  const taskFolder = join(root, task.taskId), runFolder = join(taskFolder, "runs", run.runId); await mkdir(runFolder, { recursive: true });
  const identity = { taskId: task.taskId, runId: run.runId, serverId: run.serverId, workspaceId: run.workspaceId };
  const args = { taskFolder, runFolder, task, identity }, source = { task, folder: taskFolder, file: join(taskFolder, "task.md") };
  let failInspect = false;
  const deps = { sources: async () => [source], projectRoot: async () => repo, reviewFingerprint: async () => "displayed-review", inspect: async () => { if (failInspect) throw new Error("worker now busy"); facts.deliveryFeedback = await readDeliveryFeedback(args); return facts; } };
  const service = createDeliveryFeedbackService(deps), input = { ...identity, requestId: randomUUID(), expectedCandidate: { ...facts.candidate }, expectedPlanRevision: facts.planRevision, expectedReviewFingerprint: "displayed-review", note: "Fix the missing empty-state handling.", actorId: "human-ui" };
  return { root, repo, facts, args, source, service, input, setBusy: () => { failInspect = true; } };
}

test("explicit final feedback is durable, blocks publication, and retries return its receipt", async t => {
  const f = await fixture(t), receipt = await f.service.request(f.input, {});
  assert.equal(receipt.id, f.input.requestId); assert.equal(receipt.scopeRevision, f.facts.submittedPlan.scopeRevision);
  assert.equal(receipt.policyRevision, f.facts.agentPolicy.revision); assert.deepEqual(receipt.candidate, f.input.expectedCandidate);
  f.facts.deliveryFeedback = await readDeliveryFeedback(f.args);
  assert.equal(automaticDeliveryReadiness(f.facts).ready, false);
  f.setBusy(); assert.deepEqual(await f.service.request(f.input, {}), receipt);
  const saved = JSON.parse(await readFile(join(f.args.runFolder, "delivery-feedback.json"), "utf8")); assert.equal(saved.requests.length, 1);
  await assert.rejects(f.service.request({ ...f.input, note: "Changed request under same ID" }, {}), /different feedback/);
});

test("request fixes rejects stale candidates, stale plans and incomplete final review", async t => {
  const f = await fixture(t);
  await assert.rejects(f.service.request({ ...f.input, expectedCandidate: { ...f.input.expectedCandidate, tree: "e".repeat(40) } }, {}), /candidate changed/);
  await assert.rejects(f.service.request({ ...f.input, expectedPlanRevision: "old-plan" }, {}), /candidate changed/);
  await assert.rejects(f.service.request({ ...f.input, expectedReviewFingerprint: undefined }, {}), /displayed code comparison/);
  await assert.rejects(f.service.request({ ...f.input, expectedReviewFingerprint: "old-comparison" }, {}), /displayed code comparison/);
  f.facts.checkpoints = f.facts.checkpoints.filter(item => item.execution.role !== "reviewer2");
  await assert.rejects(f.service.request(f.input, {}), /review/i);
  assert.equal(await readDeliveryFeedback(f.args), null);
  f.facts.workflowMode = "manual"; await assert.rejects(f.service.request(f.input, {}), /automatic task/);
});

test("a saved request blocks a second stale final request without coordinator writes", async t => {
  const f = await fixture(t); await f.service.request(f.input, {});
  await assert.rejects(f.service.request({ ...f.input, requestId: randomUUID() }, {}), /feedback|fix|implementation|request/i);
  assert.equal(JSON.parse(await readFile(join(f.args.runFolder, "delivery-feedback.json"), "utf8")).requests.length, 1);
});

test("request fixes shares publication serialization and rejects a task published while queued", async t => {
  const f = await fixture(t); let unlock, entered;
  const inside = new Promise(resolve => { entered = resolve; }), gate = new Promise(resolve => { unlock = resolve; });
  const publication = withRepository(f.repo, async () => { entered(); await gate; f.source.task.pullRequest = { url: "https://example.test/pr/1" }; });
  await inside;
  const queued = f.service.request(f.input, {}); unlock(); await publication;
  await assert.rejects(queued, /already been published/); assert.equal(await readDeliveryFeedback(f.args), null);
});

test("feedback history rejects foreign identity and run path traversal", async t => {
  const f = await fixture(t); await f.service.request(f.input, {});
  const file = join(f.args.runFolder, "delivery-feedback.json"), saved = JSON.parse(await readFile(file, "utf8"));
  saved.requests[0].workspaceId = "other"; await writeFile(file, JSON.stringify(saved));
  await assert.rejects(readDeliveryFeedback(f.args), /identity/);
  await assert.rejects(f.service.request({ ...f.input, runId: "../outside" }, {}));
});
