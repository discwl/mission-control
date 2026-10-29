import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { createRequire, Module } from "node:module";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
const require = createRequire(import.meta.url), ts = require("typescript"), cache = new Map();
function load(relative, from = fileURLToPath(import.meta.url)) {
  let file = resolve(dirname(from), relative); if (!existsSync(file)) file += ".ts";
  if (cache.has(file)) return cache.get(file).exports;
  const mod = new Module(file); mod.filename = file; cache.set(file, mod);
  mod.require = id => id === "@getpaseo/plugin" ? { defineRpc: value => value } : id.startsWith(".") ? load(id, file) : require(id);
  mod._compile(ts.transpileModule(readFileSync(file, "utf8"), { fileName: file, compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText, file);
  return mod.exports;
}
const { reviewSummary } = load("./review-summary.ts");
const { chatReview, chatReviewDetails } = load("./chat-presentations.ts");
const { decisionPlainSchema } = load("./decisions.ts");
const plain = { built: "The application uses the correct billing account.", found: "No actionable issues were reported.", checks: ["The build and focused tests passed."], limitations: ["Live financial results have not been verified."], recommendation: { action: "accept", reason: "The requested code change was checked." } };
function entry(overrides = {}) { return { taskTitle: "CN-42 · Correct billing account", summary: "TECHNICAL_REPORT " + "x".repeat(5000), findings: [], unverifiedFindings: 0, decision: { taskId: "task_a", plain, question: "TECHNICAL_QUESTION", candidate: { head: "a".repeat(40), tree: "b".repeat(40) }, evidence: ["C:\\private\\technical-evidence.json"] }, ...overrides }; }
test("default review is the saved human brief and preserves material limitations", () => {
  const value = chatReview(entry(), "CNS");
  assert.match(value, /correct billing account/); assert.match(value, /Live financial results have not been verified/);
  assert.doesNotMatch(value, /TECHNICAL_REPORT|TECHNICAL_QUESTION|[ab]{40}|private|technical-evidence/);
  assert.match(value, /review details task_a/); assert.match(value, /separate approval/);
  assert.ok(value.length < 1600);
});
test("full technical review remains available only when explicitly requested", () => {
  const value = chatReviewDetails(entry(), "CNS");
  assert.match(value, /TECHNICAL_REPORT/); assert.match(value, /a{40}/); assert.match(value, /technical-evidence/);
});
test("legacy briefs never invent successful checks or complete financial verification", () => {
  const value = reviewSummary(entry({ decision: { plain: null } }));
  assert.match(value, /not supplied/); assert.match(value, /not listed/); assert.match(value, /Do not assume/);
  assert.doesNotMatch(value, /tests passed|no limitations/i);
});
test("unverified earlier fixes and undisplayed findings stay visible", () => {
  const findings = Array.from({ length: 7 }, (_, index) => ({ status: "open", severity: index === 6 ? "high" : "low", plain: { description: `Issue ${index}`, impact: "Billing could be incorrect." } }));
  const value = chatReview(entry({ findings, unverifiedFindings: 2 }), "CNS");
  assert.match(value, /7 open/); assert.match(value, /HIGH · Issue 6/); assert.match(value, /More issues/); assert.match(value, /2 earlier fixes/); assert.match(value, /acceptance is blocked/);
});
test("brief schema remains compatible and rejects oversized check lists", () => {
  assert.deepEqual(decisionPlainSchema.parse(plain).limitations, plain.limitations);
  assert.equal(decisionPlainSchema.safeParse({ ...plain, checks: Array(6).fill("Checked") }).success, false);
  assert.equal(decisionPlainSchema.safeParse({ ...plain, limitations: ["x".repeat(241)] }).success, false);
  const { checks, limitations, ...legacy } = plain; assert.equal(decisionPlainSchema.safeParse(legacy).success, true);
});
