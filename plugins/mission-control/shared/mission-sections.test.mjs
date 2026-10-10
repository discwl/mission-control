import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { test } from "node:test";
const require = createRequire(import.meta.url);
const ts = require("typescript");
require.extensions[".ts"] = (module, file) => module._compile(ts.transpileModule(readFileSync(file, "utf8"), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText, file);
const { missionSections, normalizeMissionSections, moveMissionSection } = require("./mission-sections.ts");
test("existing installations default to all sections in the original order", () => {
  assert.deepEqual(normalizeMissionSections([]), [...missionSections]);
});
test("saved layout drops obsolete and duplicate sections and appends missing sections", () => {
  assert.deepEqual(normalizeMissionSections(["agents", "obsolete", "agents", "review"]), ["agents", "review", "needs-you", "tasks"]);
});
test("moving a section persists through serialization and leaves the original intact", () => {
  const original = [...missionSections];
  const moved = moveMissionSection(original, "agents", -1);
  assert.deepEqual(normalizeMissionSections(JSON.parse(JSON.stringify(moved))), ["needs-you", "tasks", "agents", "review"]);
  assert.deepEqual(original, [...missionSections]);
  assert.deepEqual(moveMissionSection(moved, "agents", 1), original);
});
test("moves at either boundary keep every section exactly once", () => {
  assert.deepEqual(moveMissionSection([], "needs-you", -1), [...missionSections]);
  assert.deepEqual(moveMissionSection([], "agents", 1), [...missionSections]);
});
