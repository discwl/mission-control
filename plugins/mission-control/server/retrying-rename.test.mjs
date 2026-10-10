import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

const require = createRequire(import.meta.url);
const ts = require("typescript");
require.extensions[".ts"] = (module, file) => module._compile(ts.transpileModule(readFileSync(file, "utf8"), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText, file);
const { rename } = require("./retrying-rename.ts");

const failing = (codes, calls) => async () => {
  calls.push(Date.now());
  const code = codes.shift();
  if (code) throw Object.assign(new Error(code), { code });
};

test("a rename blocked briefly by another process is retried until it succeeds", async () => {
  const calls = [];
  await rename("a", "b", { move: failing(["EPERM", "EBUSY", "EACCES"], calls), delayMs: 1 });
  assert.equal(calls.length, 4);
});

test("other errors and holds that outlast the retries fail", async () => {
  const missing = [];
  await assert.rejects(rename("a", "b", { move: failing(["ENOENT"], missing), delayMs: 1 }), { code: "ENOENT" });
  assert.equal(missing.length, 1, "a missing file isn't retried");
  const held = [];
  await assert.rejects(rename("a", "b", { move: failing(Array(5).fill("EPERM"), held), attempts: 3, delayMs: 1 }), { code: "EPERM" });
  assert.equal(held.length, 3);
});

test("a folder is renamed with its files", async t => {
  const root = await mkdtemp(join(tmpdir(), "mission-rename-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, ".preparing-run"));
  await writeFile(join(root, ".preparing-run", "run.md"), "# Run\n");
  await rename(join(root, ".preparing-run"), join(root, "run"));
  assert.equal(await readFile(join(root, "run", "run.md"), "utf8"), "# Run\n");
});
