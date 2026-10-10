import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { test } from "node:test";

const require = createRequire(import.meta.url);
const ts = require("typescript");
require.extensions[".ts"] = (module, file) => module._compile(ts.transpileModule(readFileSync(file, "utf8"), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText, file);
const { missingRunIssues, recentActivity } = require("./task-flow-model.ts");

const taskId = "task_abc-123";
function eventDocument(runId, eventId) {
  const fields = { schemaVersion: 1, taskId, runId, eventId, agentId: null, stage: "validate", outcome: "completed", at: "2026-09-29T12:00:00Z", evidence: [`runs/${runId}/run.md`], gitHead: null, gitDirty: false, gitChanges: [], omittedChanges: 0 };
  return { name: `runs/${runId}/events/${eventId}.md`, revision: "r1", updatedAt: fields.at, editable: false, content: "---\n" + Object.entries(fields).map(([key, value]) => `${key}: ${JSON.stringify(value)}`).join("\n") + "\n---\n# Recorded validation" };
}

test("an event with no returned run keeps its evidence and reports an unverified snapshot", () => {
  const activity = recentActivity([eventDocument("run_bbb", "event_aaa")], taskId);
  const before = structuredClone(activity);
  const issues = missingRunIssues(activity.events, [{ runId: "run_ccc" }]);
  assert.equal(issues.length, 1);
  assert.equal(issues[0].source, "runs/run_bbb/events/event_aaa.md");
  assert.match(issues[0].reason, /not included.*snapshot is unverified/);
  assert.deepEqual(activity, before);
  assert.deepEqual(activity.events[0].evidence, ["runs/run_bbb/run.md"]);
});

test("unavailable run data differs from a successfully returned empty list", () => {
  const { events } = recentActivity([eventDocument("run_bbb", "event_aaa")], taskId);
  assert.deepEqual(missingRunIssues(events, undefined), []);
  assert.equal(missingRunIssues(events, []).length, 1);
});

test("reconciliation checks each event's run without inferring any stage completion", () => {
  const { events } = recentActivity([eventDocument("run_bbb", "event_aaa"), eventDocument("run_ccc", "event_bbb")], taskId);
  assert.deepEqual(missingRunIssues(events, [{ runId: "run_bbb" }, { runId: "run_ccc" }]), []);
  assert.deepEqual(missingRunIssues(events, [{ runId: "run_bbb" }]).map(issue => issue.source), ["runs/run_ccc/events/event_bbb.md"]);
});
