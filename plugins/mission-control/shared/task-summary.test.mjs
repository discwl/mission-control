import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { test } from "node:test";

const require = createRequire(import.meta.url);
const ts = require("typescript");
require.extensions[".ts"] = (module, file) => module._compile(ts.transpileModule(readFileSync(file, "utf8"), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText, file);
const { summarizeTasks, selectTaskCounts, hasMatchingTasks, taskSummarySchema } = require("./task-summary.ts");
const task = (taskId, status = "inbox", assignments = [{ serverId: "personal", workspaceId: "work" }], projectId = "project") => ({ taskId, status, assignments, projectId });

test("host/project totals deduplicate tasks and workspace assignments without crossing hosts", () => {
  const shared = task("one", "blocked", [
    { serverId: "personal", workspaceId: "work" },
    { serverId: "personal", workspaceId: "work" },
    { serverId: "personal", workspaceId: "other" },
    { serverId: "Globex", workspaceId: "remote" },
  ]);
  const summary = taskSummarySchema.parse(summarizeTasks([shared, shared, task("two", "delivered"), task("three", "inbox", [{ serverId: "Globex", workspaceId: "work" }])], "personal"));
  assert.deepEqual(summary.counts, { total: 2, active: 1 });
  assert.deepEqual(selectTaskCounts(summary, "personal", { projectId: "project" }), { projectId: "project", total: 2, active: 1 });
  assert.equal(selectTaskCounts(summary, "personal", { workspaceId: "work" }).total, 2);
  assert.equal(selectTaskCounts(summary, "personal", { workspaceId: "other" }).total, 1);
  assert.deepEqual(selectTaskCounts(summary, "personal", { workspaceId: "remote" }), { total: 0, active: 0 });
});

test("all unfinished statuses count as active; delivered and closed remain in history", () => {
  const statuses = ["inbox", "ready", "in_progress", "blocked", "in_review", "delivered", "closed"];
  const summary = summarizeTasks(statuses.map((status, i) => task(String(i), status)), "personal");
  assert.deepEqual(summary.counts, { total: 7, active: 5 });
  const completed = summarizeTasks([task("done", "delivered"), task("closed", "closed")], "personal");
  assert.equal(hasMatchingTasks(completed.counts, false), true);
  assert.equal(hasMatchingTasks(completed.counts, true), false);
});

test("unknown summaries and another host never become zero counts", () => {
  const empty = summarizeTasks([], "personal");
  assert.deepEqual(selectTaskCounts(empty, "personal"), { total: 0, active: 0 });
  assert.deepEqual(selectTaskCounts(empty, "personal", { workspaceId: "new" }), { total: 0, active: 0 });
  assert.equal(selectTaskCounts(undefined, "personal"), undefined);
  assert.equal(selectTaskCounts(empty, "Globex"), undefined);
  assert.equal(selectTaskCounts(empty, "Globex", { workspaceId: "work" }), undefined);
  assert.equal(hasMatchingTasks(undefined, false), false);
  assert.equal(hasMatchingTasks(undefined, true), false);
  assert.equal(hasMatchingTasks(empty.counts, false), false);
});

test("workspace filters select task-bearing workspaces and active subsets independently", () => {
  const summary = summarizeTasks([
    task("old", "closed", [{ serverId: "personal", workspaceId: "history" }], "old-project"),
    task("new", "ready", [{ serverId: "personal", workspaceId: "current" }], "new-project"),
  ], "personal");
  const workspaces = ["empty", "history", "current"];
  const filtered = active => workspaces.filter(workspaceId => hasMatchingTasks(selectTaskCounts(summary, "personal", { workspaceId }), active));
  assert.deepEqual(filtered(false), ["history", "current"]);
  assert.deepEqual(filtered(true), ["current"]);
  assert.equal(selectTaskCounts(summary, "personal", { projectId: "old-project" }).active, 0);
});
