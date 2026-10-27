import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative } from "node:path";
import { capturePlanSnapshot, readPlanSnapshot } from "./plan-snapshots.mjs";
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

test("references to another decision never substitute a saved plan", async t => {
  const f = await fixture(t), plan = await capturePlanSnapshot(f.input);
  const decision = { ...f.input, status: "open", plan: { ...plan, path: plan.path.replace("decision_cccc", "decision_dddd") } };
  await assert.rejects(readPlanSnapshot({ ...f, decision }), /does not match this decision/);
});
