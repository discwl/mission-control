import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, writeFile, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { assignmentSchema } from "./stage-records.mjs";
import { readActionBundle, saveActionBundle, readActionAuthorization, saveActionAuthorization } from "./action-bundles.mjs";

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "mc-actions-")); t.after(() => rm(root, { recursive: true, force: true }));
  const identity = { taskId: "task_1234abcd", runId: "run_1234abcd", serverId: "srv_test", workspaceId: "wks_test" };
  const taskFolder = join(root, identity.taskId), runFolder = join(taskFolder, "runs", identity.runId); await mkdir(runFolder, { recursive: true });
  const task = { taskId: identity.taskId, projectId: "project", title: "Update staging switch", acceptanceCriteria: "Only the specified staging setting changes.", assignments: [{ serverId: identity.serverId, workspaceId: identity.workspaceId }] };
  const input = { kind: "actions", summary: "Set the staging feature switch.", environment: "staging", prerequisites: ["Confirm staging account"], steps: [{ instruction: "service-cli set feature true --environment staging", effect: "Enable the staging feature" }], verification: ["service-cli get feature --environment staging"], rollback: "Restore the previously recorded switch value." };
  const assignment = assignmentSchema.parse({ ...identity, id: "00000000-0000-4000-8000-000000000001", agentId: "builder", workflowMode: "automatic", deliveryKind: "actions", execution: { assignmentId: "00000000-0000-4000-8000-000000000001", role: "builder", policyRevision: "policy-1", profileId: "builder", profileName: "Builder", provider: "test", model: "builder-model" }, stage: "execute", planRevision: "plan-1", candidate: null, createdAt: new Date().toISOString(), reviewCount: 2, manifest: null });
  return { root, identity, taskFolder, runFolder, task, input, assignment };
}

test("action snapshot is immutable, repeatable, and bound to scope and accepted plan", async t => {
  const args = await fixture(t); assert.equal(await readActionBundle(args), null);
  const first = await saveActionBundle(args), second = await saveActionBundle(args);
  assert.equal(first.revision, second.revision); assert.equal(first.createdAt, second.createdAt);
  assert.deepEqual((await readActionBundle({ ...args, planRevision: "plan-1" })).bundle, args.input);
  await assert.rejects(readActionBundle({ ...args, planRevision: "plan-2" }), /different plan/);
  await assert.rejects(readActionBundle({ ...args, task: { ...args.task, acceptanceCriteria: "Changed scope" } }), /scope changed/);
  await assert.rejects(readActionBundle({ ...args, identity: { ...args.identity, serverId: "other" } }), /assignment/);
  const changed = await saveActionBundle({ ...args, input: { ...args.input, environment: "qa" } });
  assert.notEqual(changed.revision, first.revision);
  assert.equal(JSON.parse(await readFile(join(args.runFolder, "actions", `bundle-${first.revision}.json`), "utf8")).revision, first.revision);
});

test("tampered snapshot and escaping pointer cannot be reviewed as current evidence", async t => {
  const args = await fixture(t), snapshot = await saveActionBundle(args);
  const file = join(args.runFolder, "actions", `bundle-${snapshot.revision}.json`), raw = JSON.parse(await readFile(file, "utf8"));
  raw.bundle.environment = "production"; await writeFile(file, JSON.stringify(raw));
  await assert.rejects(readActionBundle(args), /does not match its revision/);
  await writeFile(join(args.runFolder, "actions", "current.json"), JSON.stringify({ revision: "../../foreign" }));
  await assert.rejects(readActionBundle(args), /pointer is invalid/);
});

test("manual or wrong-role workers cannot create deliverable actions; reports cannot hide actions", async t => {
  const args = await fixture(t);
  await assert.rejects(saveActionBundle({ ...args, assignment: { ...args.assignment, workflowMode: "manual" } }), /assigned automatic builder/);
  await assert.rejects(saveActionBundle({ ...args, assignment: { ...args.assignment, execution: { ...args.assignment.execution, role: "reviewer" } } }), /assigned automatic builder/);
  await assert.rejects(saveActionBundle({ ...args, assignment: { ...args.assignment, taskId: "task_abcd" } }), /assignment does not match/);
  await assert.rejects(saveActionBundle({ ...args, assignment: { ...args.assignment, deliveryKind: "report" }, input: { ...args.input, kind: "report", report: "Results" } }), /cannot include actions/);
  const report = await saveActionBundle({ ...args, assignment: { ...args.assignment, deliveryKind: "report" }, input: { ...args.input, kind: "report", report: "Read-only investigation results.", steps: [] } });
  assert.equal(report.kind, "report");
});

test("authorization binds exact bundle and retains uncertain delivery rather than authorizing replacement", async t => {
  const args = await fixture(t), snapshot = await saveActionBundle(args);
  const value = { revision: snapshot.revision, fingerprint: "a".repeat(64), planRevision: "plan-1", policyRevision: "policy-1", actorId: "human-chat", authorizedAt: new Date().toISOString(), agentId: "builder", resumeState: "sending" };
  await saveActionAuthorization(args, value); await saveActionAuthorization(args, { ...value, resumeState: "uncertain" });
  assert.equal((await readActionAuthorization(args)).resumeState, "uncertain");
  await assert.rejects(saveActionAuthorization(args, { ...value, fingerprint: "b".repeat(64) }), /earlier action authorization/);
  const changed = await saveActionBundle({ ...args, input: { ...args.input, environment: "qa" } });
  assert.notEqual(changed.revision, snapshot.revision);
  await assert.rejects(saveActionAuthorization(args, value), /changed before authorization/);
});

test("action directory symlinks cannot redirect evidence outside the run", async t => {
  const args = await fixture(t), outside = join(args.root, "outside"); await mkdir(outside);
  try { await symlink(outside, join(args.runFolder, "actions"), "junction"); } catch (error) { if (["EPERM", "EACCES"].includes(error.code)) { t.skip("Creating symlinks is unavailable"); return; } throw error; }
  await assert.rejects(saveActionBundle(args), /ordinary files/);
});
