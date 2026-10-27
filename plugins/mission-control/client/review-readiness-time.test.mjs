import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import ts from "typescript";
const module = { exports: {} };
vm.runInNewContext(ts.transpileModule(fs.readFileSync(new URL("review-readiness-model.ts", import.meta.url), "utf8"), { compilerOptions: { module: ts.ModuleKind.CommonJS } }).outputText, { module, exports: module.exports });
const { reviewReadiness } = module.exports;
const entry = { task: { taskId: "task", acceptanceCriteria: "Required behavior" }, decisions: [] };
const event = (stage, at, outcome = "completed", agentId = "builder") => ({ taskId: "task", stage, at, outcome, agentId, gitHead: "abc", gitDirty: false, source: at });
const snapshot = { head: "abc", fingerprint: "snapshot" };

test("later implementation invalidates evidence across timezone offsets", () => {
  const items = reviewReadiness(entry, snapshot, [event("validate", "2026-10-26T14:30:00Z"), event("execute", "2026-10-26T08:00:00-07:00")], false, false);
  assert.equal(items.find(item => item.label === "Validation").status, "stale");
});

test("selects chronologically latest evidence and correct earlier implementer", () => {
  const items = reviewReadiness(entry, snapshot, [event("validate", "2026-10-26T14:30:00Z", "in_progress"), event("validate", "2026-10-26T08:00:00-07:00"), event("execute", "2026-10-26T13:00:00Z"), event("review", "2026-10-26T07:30:00-07:00", "completed", "reviewer")], false, false);
  assert.equal(items.find(item => item.label === "Validation").status, "recorded");
  assert.equal(items.find(item => item.label === "Independent review").status, "recorded");
});
