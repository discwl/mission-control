import assert from "node:assert/strict";
import { test } from "node:test";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { automaticFixture } from "./automatic-pipeline-fixture.mjs";
const require = createRequire(import.meta.url), ts = require("typescript");
require.extensions[".ts"] = (module, file) => module._compile(ts.transpileModule(readFileSync(file, "utf8"), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText, file);
const { hasAutomaticAssignment, createAutomaticInspectionScope } = require("./pipeline-inspect.ts");
const hostModule = require("./fleet-host.ts"), tasks = require("./tasks.ts");

async function fixture(t) {
  const folder = await mkdtemp(join(tmpdir(), "mc-inspect-")); t.after(() => rm(folder, { recursive: true, force: true }));
  const { facts } = automaticFixture(); const source = { folder, task: facts.entry.task };
  const runFolder = join(folder, "runs", facts.entry.run.runId); await mkdir(join(runFolder, "stage-assignments"), { recursive: true });
  const cp = facts.checkpoints[0], id = randomUUID();
  const assignment = { ...cp, id, stage: "plan", agentId: "planner-agent", planRevision: null, candidate: null, workflowMode: "automatic", deliveryKind: "code", reviewCount: 2, manifest: null, execution: { ...cp.execution, assignmentId: id, role: "planner", model: "planner-model", profileId: "planner", profileName: "planner" } };
  return { source, run: facts.entry.run, entry: facts.entry, assignment, save: value => writeFile(join(runFolder, "stage-assignments", `${id}.json`), JSON.stringify(value)) };
}

test("cheap discriminator skips legacy absent workspaces and requires exact managed automatic evidence", async t => {
  const f = await fixture(t); const legacy = { ...f.run }; delete legacy.workflowMode;
  assert.equal(await hasAutomaticAssignment(f.source, legacy), false);
  await assert.rejects(hasAutomaticAssignment(f.source, f.run), /no matching managed assignment/);
  await f.save(f.assignment); assert.equal(await hasAutomaticAssignment(f.source, f.run), true);
  await f.save({ ...f.assignment, taskId: "task_elsewhere" }); await assert.rejects(hasAutomaticAssignment(f.source, f.run), /another task|identity/);
});

test("request scoped inspection scans host once and never opens a legacy workspace", async t => {
  const f = await fixture(t); delete f.entry.run.workflowMode; let scans = 0;
  t.mock.method(hostModule, "collectFleetHost", async () => { scans++; return { tasks: [f.entry, { ...f.entry, task: { ...f.entry.task, taskId: "task_no_run" }, run: null }], agents: [], complete: true, warnings: [] }; });
  t.mock.method(tasks, "assignedTask", async () => f.source);
  const scoped = createAutomaticInspectionScope("remote", {}, {}, {});
  assert.equal(await scoped("task_a"), null); assert.equal(await scoped("task_no_run"), null); assert.equal(scans, 1);
  const nextRequest = createAutomaticInspectionScope("remote", {}, {}, {}); await nextRequest("task_no_run"); assert.equal(scans, 2, "no cache survives the request scope");
});

test("active automatic workspace fails before provider lookup or Git inspection", async t => {
  const f = await fixture(t); await f.save(f.assignment);
  t.mock.method(hostModule, "collectFleetHost", async () => ({ tasks: [f.entry], agents: [{ workspaceId: "work", status: "running", pendingPermissions: 0 }], complete: true, warnings: [] }));
  t.mock.method(tasks, "assignedTask", async () => f.source);
  const scoped = createAutomaticInspectionScope("remote", {}, {}, {});
  await assert.rejects(scoped("task_a"), /active worker/);
});
