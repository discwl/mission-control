import assert from "node:assert/strict";
import { test } from "node:test";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
const require = createRequire(import.meta.url); const ts = require("typescript");
require.extensions[".ts"] = (module, file) => module._compile(ts.transpileModule(readFileSync(file, "utf8"), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText, file);
const { resolveOcrScope, executeOcr } = require("./ocr-execution.ts"); const processes = require("./process-tree.ts");
const head = "a".repeat(40); const base = "b".repeat(40); const parent = "c".repeat(40); const candidate = { head, tree: "d".repeat(40) };
test("shared checkout needs explicit review scope; invalid or unrelated bases fail instead of downgrading to workspace-only", async t => {
  await assert.rejects(resolveOcrScope("cwd", candidate, null, { from: null, since: null, branchBase: null }), /starting commit/);
  await assert.rejects(resolveOcrScope("cwd", candidate, "--unsafe", { from: null, since: null, branchBase: null }), /commit ID/);
  t.mock.method(processes, "runProcess", async (_file, args) => args.includes("rev-parse") ? { code: 0, stdout: base } : { code: 1, stdout: "" });
  await assert.rejects(resolveOcrScope("cwd", candidate, base, { from: null, since: null, branchBase: null }), /ancestor/);
});
test("scope preserves task baseline, inclusive first commit, and root commit semantics", async t => {
  t.mock.method(processes, "runProcess", async (_file, args) => ({ code: 0, stdout: args.includes("rev-list") ? `${base} ${parent}` : args.includes("rev-parse") ? base : "" }));
  const task = await resolveOcrScope("cwd", candidate, base, { from: head, since: null, branchBase: null }); assert.equal(task.base, base); assert.equal(task.source, "task");
  const from = await resolveOcrScope("cwd", candidate, null, { from: base, since: null, branchBase: null }); assert.equal(from.base, parent); assert.equal(from.rootCommit, null);
  t.mock.method(processes, "runProcess", async () => ({ code: 0, stdout: base }));
  const root = await resolveOcrScope("cwd", candidate, null, { from: base, since: null, branchBase: null }); assert.equal(root.rootCommit, base); assert.equal(root.base, base);
});
test("OCR executes workspace, committed range and rules with shell-free arguments and refuses incomplete rules", async t => {
  const calls = []; let emptyRules = false;
  t.mock.method(processes, "runProcess", async (_file, args) => {
    calls.push(args);
    const body = args.includes("--version") ? "1.13.3" : args.includes("preview") ? JSON.stringify({ schema_version: "1", mode: "workspace", reviewable_files: [{ path: "file with spaces.ts", status: "modified" }], excluded_files: [] }) : JSON.stringify({ schema_version: "1", groups: emptyRules ? [] : [{ files: ["file with spaces.ts"], rule: "Check correctness" }] });
    return { code: 0, stdout: body, stderr: "" };
  });
  const result = await executeOcr("cwd", { base, rootCommit: null }, candidate, "assignment");
  assert.equal(result.previews.length, 2); assert.equal(result.files.length, 1); assert.ok(calls.some(args => args.includes("file with spaces.ts"))); assert.ok(calls.some(args => args.includes("--from") && args.includes(base)));
  emptyRules = true; await assert.rejects(executeOcr("cwd", { base, rootCommit: null }, candidate, "assignment"), /every reviewable/);
});
