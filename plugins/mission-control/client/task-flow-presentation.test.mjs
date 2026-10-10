import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { test } from "node:test";
const require = createRequire(import.meta.url), ts = require("typescript");
require.extensions[".ts"] = (module, file) => module._compile(ts.transpileModule(readFileSync(file, "utf8"), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText, file);
const { resolveEvidence, eventSummary, activityTitle, activityBody, artifactLabel, artifactPreview } = require("./task-flow-presentation.ts");
const taskId = "task_abc-123", report = { name: "report.md", content: "# Report" };
test("absolute evidence resolves only within the selected task, including Windows casing", () => {
 for (const name of ["report.md", "./report.md", `C:\\dev-vault\\Tasks\\${taskId}\\report.md`, `/vault/Tasks/${taskId}/report.md`, `C:\\VAULT\\TASKS\\${taskId.toUpperCase()}\\REPORT.MD`]) assert.equal(resolveEvidence(name, [report], taskId).kind, "document", name);
 for (const name of ["../report.md", "missing.md", "/other/report.md", `C:\\vault\\Tasks\\task_other\\report.md`, `C:\\vault\\Tasks\\${taskId}\\..\\report.md`]) assert.equal(resolveEvidence(name, [report], taskId).kind, "unavailable", name);
 assert.equal(resolveEvidence("report.md", [report, report], taskId).kind, "unavailable");
});
test("command results and working notes are statements rather than missing documents", () => {
 for (const value of ["git status --porcelain: empty at 9c9ae7a", "checklist: report.md sections 1, 2", "task.md working rules (plan approval pre-granted)"]) assert.equal(resolveEvidence(value, [report], taskId).kind, "statement");
});
test("friendly labels and previews preserve source records", () => {
 const document = { name: "runs/run_bbb/run.md", content: "---\nrunId: run_bbb\n---\n# Run run_bbb\nActual summary" }, before = document.content;
 assert.equal(artifactLabel(report), "Report"); assert.equal(artifactLabel(document), "Run summary");
 assert.match(artifactPreview(document), /# Run summary/); assert.equal(document.content, before);
});
test("activity titles describe recorded stages without claiming validation passed or review approval", () => {
 assert.equal(activityTitle({ stage: "handoff", outcome: "completed" }), "Handoff completed");
 assert.equal(activityTitle({ stage: "validate", outcome: "completed" }), "Validation completed");
 assert.equal(activityTitle({ stage: "plan", outcome: "waiting" }), "Planning waiting");
});
test("activity prose hides only matching generated evidence while preserving other evidence discussion", () => {
 const event = { stage: "review", outcome: "completed", evidence: ["report.md"], body: "# review: completed\nActual summary\n\n## Evidence\n- report.md\n\n## Notes\nKeep this note." };
 assert.doesNotMatch(activityBody(event), /report.md/); assert.match(activityBody(event), /Keep this note/);
 assert.match(activityBody({ ...event, body: "Actual summary\n\n## Evidence\nDiscussion of results." }), /Discussion of results/);
 assert.match(activityBody({ ...event, body: "Actual summary\n\n## Evidence\n- other.md" }), /other.md/);
});
test("summaries remove only generated headings and keep recorded prose", () => {
 assert.equal(eventSummary({ stage: "review", outcome: "completed", body: "# review: completed\nActual summary\n\n- Checks passed." }), "Actual summary\n\n- Checks passed.");
 assert.equal(eventSummary({ stage: "review", outcome: "completed", body: "# Other heading\nActual summary" }), "# Other heading\nActual summary");
});
