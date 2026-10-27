import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url), ts = require("typescript");
require.extensions[".ts"] = (module, file) => module._compile(ts.transpileModule(readFileSync(file, "utf8"), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText, file);
const { reviewReadiness } = require("./review-readiness-model.ts");
const entry = () => ({ task: { taskId: "task-a", acceptanceCriteria: "Ordinary discounts still work." }, decisions: [] });
const snapshot = { head: "a".repeat(40), fingerprint: "b".repeat(64) };
const event = (stage, at, agentId = "implementer") => ({ taskId: "task-a", stage, outcome: "completed", at, agentId, gitHead: snapshot.head, gitDirty: false, source: `runs/run_a/events/event_${stage}.md` });
const item = (items, label) => items.find(item => item.label === label);

test("missing evidence stays missing instead of implying validation or independent review", () => {
  const items = reviewReadiness(entry(), snapshot, [], false, false);
  assert.equal(item(items, "Validation").status, "missing");
  assert.equal(item(items, "Independent review").status, "missing");
  assert.equal(item(items, "Unresolved findings").status, "unknown");
  assert.match(item(items, "Acceptance criteria").detail, /Ordinary discounts/);
});
test("changed commits, later implementation, and a stale displayed snapshot invalidate old results", () => {
  const events = [event("execute", "2026-10-26T10:00:00Z"), event("validate", "2026-10-26T11:00:00Z")];
  assert.equal(item(reviewReadiness(entry(), { ...snapshot, head: "c".repeat(40) }, events, false, false), "Validation").status, "stale");
  events.push(event("fix", "2026-10-26T12:00:00Z"));
  assert.equal(item(reviewReadiness(entry(), snapshot, events, false, false), "Validation").status, "stale");
  assert.equal(item(reviewReadiness(entry(), snapshot, events.slice(0, 2), false, true), "Displayed revision").status, "stale");
});
test("recorded completion is labelled as evidence and reviewer independence is not invented", () => {
  const events = [event("execute", "2026-10-26T10:00:00Z"), event("validate", "2026-10-26T11:00:00Z"), event("review", "2026-10-26T12:00:00Z")];
  let items = reviewReadiness(entry(), snapshot, events, false, false);
  assert.equal(item(items, "Independent review").status, "unknown");
  events[2].agentId = "reviewer";
  items = reviewReadiness(entry(), snapshot, events, false, false);
  assert.equal(item(items, "Independent review").status, "recorded");
  assert.match(item(items, "Validation").detail, /does not verify current working changes/);
  events[1].gitDirty = true;
  assert.match(item(reviewReadiness(entry(), snapshot, events, false, false), "Validation").detail, /Exact working-file contents are not verified/);
});
test("unverified findings and unavailable evidence remain visible", () => {
  const e = entry();
  e.decisions.push({ decision: { kind: "review", requestedAt: "2026-10-26", evidence: ["review.md"] }, findings: [{ findingId: "f-one", status: "submitted" }], resolvedFindings: [], unverifiedFindings: 1 });
  assert.equal(item(reviewReadiness(e, snapshot, [], false, false), "Unresolved findings").status, "needs you");
  assert.equal(item(reviewReadiness(e, snapshot, [], true, false), "Unresolved findings").status, "unknown");
  const foreign = { ...event("validate", "2026-10-26T11:00:00Z"), taskId: "task-other" };
  assert.equal(item(reviewReadiness(e, snapshot, [foreign], false, false), "Validation").status, "missing");
});
