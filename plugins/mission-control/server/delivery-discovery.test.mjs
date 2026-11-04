import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { test } from "node:test";
import { automaticFixture } from "./automatic-pipeline-fixture.mjs";
const require = createRequire(import.meta.url), ts = require("typescript");
require.extensions[".ts"] = (module, file) => module._compile(ts.transpileModule(readFileSync(file, "utf8"), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText, file);
const { createMergeService } = require("./merge.ts");
function fixture() {
  const { facts } = automaticFixture();
  const source = id => ({ folder: `C:/vault/${id}`, file: `C:/vault/${id}/task.md`, task: { ...facts.entry.task, taskId: id, title: id, worktree: { workspaceId: "work", branch: id, baseCommit: "a".repeat(40) } } });
  let rows = ["task_a", "task_b", "task_c", "task_d", "task_e", "task_f"].map(source), scopes = 0, calls = [];
  const deps = {
    sources: async () => rows,
    decisions: async () => ({ open: [], recent: [{ decision: { taskId: "task_b", runId: facts.entry.run.runId, kind: "review", status: "approved", requestedAt: "2026-11-03", resolvedAt: "2026-11-03" } }] }),
    runs: async item => { if (item.task.taskId === "task_f") throw new Error("Unreadable legacy run"); return item.task.taskId === "task_d" ? [] : [{ ...facts.entry.run, taskId: item.task.taskId, outcome: item.task.taskId === "task_e" ? "in_progress" : "completed" }]; },
    automaticMode: async item => item.task.taskId !== "task_b",
    automaticInspection: async () => { throw new Error("Wait for active worker"); },
    automaticInspectionScope: () => { scopes++; return async id => { calls.push(id); if (id === "task_c") throw new Error("Wait for active worker"); return facts; }; },
    projectRoot: async () => { throw new Error("Discovery must not request a checkout for unchanged candidates"); }, clearReviewMarks: async () => {}, deliver: async () => {},
  };
  return { deps, scopes: () => scopes, calls, select: next => { rows = next.map(source); } };
}
test("delivery discovery isolates a broken or active task and shares one request-scoped inspection", async () => {
  const f = fixture(), result = await createMergeService(f.deps).ready("remote", {});
  assert.deepEqual(result.tasks.map(item => item.taskId).sort(), ["task_a", "task_b"]);
  assert.match(result.warning, /task_c: Wait for active worker/); assert.match(result.warning, /task_f: Unreadable legacy run/);
  assert.equal(f.scopes(), 1); assert.deepEqual(f.calls, ["task_a", "task_c"]);
});
test("legacy and unfinished automatic candidates never trigger a live host scan", async () => {
  const f = fixture(); f.select(["task_b", "task_d", "task_e"]);
  const result = await createMergeService(f.deps).ready("remote", {});
  assert.deepEqual(result.tasks.map(item => item.taskId), ["task_b"]); assert.equal(f.scopes(), 0); assert.deepEqual(f.calls, []);
});
test("exact delivery converts automatic inspection failure to a refused check", async () => {
  const f = fixture(), result = await createMergeService(f.deps).evaluate("remote", "task_c", {}, { kind: "pull-request", targetBranch: "main" });
  assert.equal(result.status.ready, false); assert.equal(result.status.checks[0].ok, false); assert.match(result.status.checks[0].detail, /Wait for active worker/);
});
