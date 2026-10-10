import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { test } from "node:test";

const require = createRequire(import.meta.url);
const ts = require("typescript");
const compiled = ts.transpileModule(readFileSync(new URL("./review-actions.ts", import.meta.url), "utf8"), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
}).outputText;
const loaded = { exports: {} };
async function git(root, args, allowed = [0]) {
  const result = spawnSync("git", args, { cwd: root, encoding: "utf8", windowsHide: true });
  if (result.error) throw result.error;
  assert.ok(allowed.includes(result.status), result.stderr || `git failed: ${args[0]}`);
  return result.stdout;
}
new Function("require", "module", "exports", compiled)(specifier => specifier === "./review"
  ? { runGit: git, workspaceDirectory: () => { throw new Error("Not used by discard tests"); } }
  : require(specifier), loaded, loaded.exports);
const { planReviewDiscard, applyReviewDiscard } = loaded.exports;

async function fixture(t, files) {
  const parent = resolve(tmpdir());
  const root = mkdtempSync(join(parent, "mc-discard-literal-"));
  t.after(() => {
    assert.equal(dirname(resolve(root)), parent);
    assert.ok(root.split(/[\\/]/).at(-1).startsWith("mc-discard-literal-"));
    rmSync(root, { recursive: true, force: true });
  });
  await git(root, ["init", "-b", "main"]);
  await git(root, ["config", "user.name", "Discard test"]);
  await git(root, ["config", "user.email", "discard-test@example.invalid"]);
  await git(root, ["config", "core.autocrlf", "false"]);
  for (const file of files) {
    mkdirSync(dirname(join(root, file)), { recursive: true });
    writeFileSync(join(root, file), "base\n");
  }
  await git(root, ["add", "."]);
  await git(root, ["commit", "-m", "fixture"]);
  return root;
}

async function unrelatedChanges(root, file) {
  writeFileSync(join(root, file), "staged unrelated\n");
  await git(root, ["--literal-pathspecs", "add", "--", file]);
  writeFileSync(join(root, file), "unstaged unrelated\n");
  return await git(root, ["--literal-pathspecs", "ls-files", "--stage", "-z", "--", file]);
}

async function assertUnrelated(root, file, indexBefore) {
  assert.equal(readFileSync(join(root, file), "utf8"), "unstaged unrelated\n");
  assert.equal(await git(root, ["--literal-pathspecs", "ls-files", "--stage", "-z", "--", file]), indexBefore);
}

test("discarding an untracked bracket filename leaves unrelated staged and working files intact", async t => {
  const root = await fixture(t, ["a.txt", "b.txt"]);
  const indexBefore = await unrelatedChanges(root, "a.txt");
  writeFileSync(join(root, "[ab].txt"), "remove just this\n");
  const plan = await planReviewDiscard(root, "[ab].txt", false);
  assert.deepEqual(plan.paths, ["[ab].txt"]);
  assert.deepEqual(plan.removePaths, ["[ab].txt"]);
  await applyReviewDiscard(root, "[ab].txt", false, plan.token);
  assert.equal(existsSync(join(root, "[ab].txt")), false);
  await assertUnrelated(root, "a.txt", indexBefore);
  assert.equal(readFileSync(join(root, "b.txt"), "utf8"), "base\n");
});

test("discarding a tracked bracket filename restores only that literal file", async t => {
  const root = await fixture(t, ["[ab].txt", "a.txt"]);
  const indexBefore = await unrelatedChanges(root, "a.txt");
  writeFileSync(join(root, "[ab].txt"), "staged target\n");
  await git(root, ["--literal-pathspecs", "add", "--", "[ab].txt"]);
  writeFileSync(join(root, "[ab].txt"), "unstaged target\n");
  const plan = await planReviewDiscard(root, "[ab].txt", false);
  assert.deepEqual(plan.removePaths, []);
  await applyReviewDiscard(root, "[ab].txt", false, plan.token);
  assert.equal(readFileSync(join(root, "[ab].txt"), "utf8"), "base\n");
  assert.equal(await git(root, ["--literal-pathspecs", "diff", "HEAD", "--", "[ab].txt"]), "");
  await assertUnrelated(root, "a.txt", indexBefore);
});

test("discarding a bracket folder restores and deletes its files without touching another folder", async t => {
  const root = await fixture(t, ["[ab]/inside.txt", "a/inside.txt"]);
  const indexBefore = await unrelatedChanges(root, "a/inside.txt");
  writeFileSync(join(root, "[ab]/inside.txt"), "changed target\n");
  writeFileSync(join(root, "[ab]/new.txt"), "new target\n");
  const plan = await planReviewDiscard(root, "[ab]", true);
  assert.deepEqual(plan.paths, ["[ab]/inside.txt", "[ab]/new.txt"]);
  await applyReviewDiscard(root, "[ab]", true, plan.token);
  assert.equal(readFileSync(join(root, "[ab]/inside.txt"), "utf8"), "base\n");
  assert.equal(existsSync(join(root, "[ab]/new.txt")), false);
  await assertUnrelated(root, "a/inside.txt", indexBefore);
});
