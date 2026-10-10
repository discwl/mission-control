import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { test } from "node:test";
const require = createRequire(import.meta.url);
const ts = require("typescript");
require.extensions[".ts"] = (module, file) => module._compile(ts.transpileModule(readFileSync(file, "utf8"), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText, file);
const { recentActivity, recordedOutcome } = require("./task-flow-model.ts");
const taskId = "task_abc-123";
const metadata = { schemaVersion: 1, eventId: "event_aaa", runId: "run_bbb", taskId, agentId: null, stage: "validate", outcome: "completed", at: "2026-09-29T12:00:00Z", evidence: [], gitHead: null, gitDirty: false, gitChanges: [], omittedChanges: 0 };
function document(fields = {}, name = "runs/run_bbb/events/event_aaa.md") { return { name, revision: "r1", updatedAt: metadata.at, editable: false, content: "---\n" + Object.entries({ ...metadata, ...fields }).map(([key, value]) => `${key}: ${JSON.stringify(value)}`).join("\n") + "\n---\n# validate: completed\nActual summary" }; }
test("only explicit events form recent activity; snapshots and handoffs imply no stage history", () => {
 const result = recentActivity([document(), { ...document(), name: "runs/run_bbb/run.md" }, { ...document(), name: "runs/run_bbb/handoff.md" }], taskId);
 assert.equal(result.events.length, 1); assert.deepEqual(result.events[0].evidence, []);
 assert.equal(recordedOutcome(result.events[0].outcome), "Recorded complete");
 assert.equal(recentActivity([{ ...document(), name: "task.md" }], taskId).events.length, 0);
});
test("identity mismatch rejects the bad record without hiding a valid event", () => {
 for (const changed of [{ taskId: "task_ddd" }, { runId: "run_ddd" }, { eventId: "event_ddd" }]) {
  const result = recentActivity([document(changed), document({ eventId: "event_ccc" }, "runs/run_bbb/events/event_ccc.md")], taskId);
  assert.equal(result.events.length, 1); assert.equal(result.issues.length, 1);
 }
});
test("duplicate keys, malformed JSON and unavailable metadata are visible issues", () => {
 for (const content of [document().content.replace('schemaVersion: 1', 'schemaVersion: 1\nschemaVersion: 1'), document().content.replace('"validate"', 'validate'), '# No metadata', document().content.replace('\n---\n#', '\n#')]) {
  const result = recentActivity([{ ...document(), content }], taskId); assert.equal(result.events.length, 0); assert.equal(result.issues.length, 1);
 }
});
test("invalid dates, stages, outcomes, evidence and Git metadata are rejected", () => {
 for (const changed of [{ at: "yesterday" }, { at: "2026-02-30T12:00:00Z" }, { stage: "finished" }, { outcome: "passed" }, { evidence: "tests" }, { evidence: [""] }, { gitDirty: "false" }, { omittedChanges: -1 }]) {
  const result = recentActivity([document(changed)], taskId); assert.equal(result.events.length, 0); assert.equal(result.issues.length, 1);
 }
});
test("duplicate event identities are ambiguous and rejected", () => { const result = recentActivity([document(), document()], taskId); assert.equal(result.events.length, 0); assert.equal(result.issues.length, 2); });
test("events sort by real timestamps and preserve waiting distinctly from blocked", () => {
 const result = recentActivity([document({ outcome: "waiting" }), document({ eventId: "event_ccc", at: "2026-09-29T13:00:00Z", outcome: "blocked" }, "runs/run_bbb/events/event_ccc.md")], taskId);
 assert.equal(result.events[0].outcome, "blocked"); assert.equal(result.events[1].outcome, "waiting");
});
