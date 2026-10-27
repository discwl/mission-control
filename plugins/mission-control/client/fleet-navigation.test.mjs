import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url), ts = require("typescript");
require.extensions[".ts"] = (module, file) => module._compile(ts.transpileModule(readFileSync(file, "utf8"), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText, file);
const { taskDestination, hasOpenPlan } = require("./fleet-navigation.ts");
const { taskWorkflow } = require("../shared/fleet-model.ts");
const entry = () => ({ task: { status: "in_progress" }, run: null, decisions: [], questions: [], problem: null });

test("a plan remains discoverable when an older question also blocks the task", () => {
  const e = entry();
  e.questions.push({ question: { status: "open" } });
  e.decisions.push({ decision: { kind: "plan", status: "open" } });
  assert.equal(hasOpenPlan(e), true);
  assert.deepEqual(taskDestination(e, []), { tab: "Plan", label: "Review plan" });
  assert.equal(taskDestination(e, [{ pendingPermissions: 1 }]).tab, "Needs you", "live permissions stay first");
  e.decisions[0].decision.status = "approved";
  assert.equal(hasOpenPlan(e), false);
  assert.equal(taskDestination(e, []).label, "Answer question");
});

test("review and delivery actions lead to their matching task views", () => {
  const e = entry();
  e.task.status = "in_review";
  assert.equal(taskDestination(e, []).tab, "Review");
  e.decisions.push({ decision: { kind: "review", status: "open", requestedAt: "2026-10-26" } });
  assert.deepEqual(taskDestination(e, []), { tab: "Needs you", label: "Review result" });
  e.decisions[0].decision.status = "approved";
  assert.deepEqual(taskDestination(e, []), { tab: "Delivery", label: "Review delivery" });
  e.task.status = "delivered";
  assert.equal(taskDestination(e, []).tab, "Overview");
});

test("a saved approval cannot authorize automatic continuation before delivery is confirmed", () => {
  const e = entry();
  e.run = { runId: "run_current", stage: "plan", outcome: "completed", gitHead: null, gitDirty: false };
  const decision = { kind: "plan", status: "approved", requestedAt: "2026-10-26", runId: e.run.runId, resume: { phase: "pending", error: "The working plan changed. Request a fresh proposal." } };
  e.decisions.push({ decision });
  assert.equal(taskWorkflow(e, []).actor, "you");
  assert.match(taskWorkflow(e, []).next, /working plan changed/);
  assert.equal(taskDestination(e, []).label, "Inspect plan delivery");
  decision.resume.phase = "sending";
  assert.equal(taskWorkflow(e, []).stage, "Blocked");
  decision.resume.phase = "sent";
  assert.equal(taskWorkflow(e, []).stage, "Ready");
  assert.equal(taskWorkflow(e, []).actor, "agent");
});
