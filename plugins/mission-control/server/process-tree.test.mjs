import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

const require = createRequire(import.meta.url);
const ts = require("typescript");
require.extensions[".ts"] = (module, file) => module._compile(ts.transpileModule(readFileSync(file, "utf8"), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText, file);
const { ProcessStopped, killTree, processTreeTesting, runProcess } = require("./process-tree.ts");

const pause = ms => new Promise(done => setTimeout(done, ms));

async function folder(t) {
  const base = await mkdtemp(join(tmpdir(), "mission-tree-"));
  t.after(() => rm(base, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 }));
  return base;
}

test("runProcess returns the exit code and output, and passes input", async () => {
  const ok = await runProcess(process.execPath, ["-e", "process.stdout.write('out'); process.stderr.write('err')"], { timeoutMs: 10_000 });
  assert.deepEqual(ok, { code: 0, stdout: "out", stderr: "err" });
  const failed = await runProcess(process.execPath, ["-e", "process.exit(3)"], { timeoutMs: 10_000 });
  assert.equal(failed.code, 3);
  const echoed = await runProcess(process.execPath, ["-e", "process.stdin.pipe(process.stdout)"], { timeoutMs: 10_000, input: "protocol=https\nhost=example.org\n\n" });
  assert.equal(echoed.stdout, "protocol=https\nhost=example.org\n\n");
  await assert.rejects(runProcess(join(tmpdir(), "no-such-program.exe"), [], { timeoutMs: 10_000 }), error => (error.code === "ENOENT"));
});

// Like Git's cmd\git.exe: a launcher that starts the real program as a child and waits for it. The
// child (and anything it starts) must end with the launcher, or it carries on after the time limit.
test("a timed-out launcher ends with the child it started, so the child never finishes its work", async t => {
  const base = await folder(t);
  const marker = join(base, "written-late.txt");
  const child = join(base, "child.cjs");
  const launcher = join(base, "launcher.cjs");
  await writeFile(child, `setTimeout(() => require("fs").writeFileSync(${JSON.stringify(marker)}, "too late"), 5000);\n`);
  // The launcher gives the child its own handles, so the launcher's pipes close as soon as it is ended. On
  // Windows, Node keeps its children in a job object that ends them with it; git.exe's launcher doesn't, so
  // the child breaks away (detached) to behave like the real git. Elsewhere it stays in the launcher's group.
  await writeFile(launcher, `const { spawn } = require("child_process");\nconst child = spawn(process.execPath, [${JSON.stringify(child)}], { stdio: "ignore", detached: process.platform === "win32" });\nchild.on("exit", code => process.exit(code ?? 1));\n`);
  const started = Date.now();
  await assert.rejects(runProcess(process.execPath, [launcher], { timeoutMs: 400 }), error => error instanceof ProcessStopped && error.confirmed && /took longer than 0 s and was stopped$/.test(error.message));
  assert.ok(Date.now() - started < 4500, "it replies after the time limit, before the child would have finished");
  // Past the moment the child would have written its file.
  await pause(Math.max(0, started + 6000 - Date.now()));
  assert.equal(existsSync(marker), false, "the launcher's child was ended too");
});

test("a process that writes too much is stopped", async () => {
  await assert.rejects(runProcess(process.execPath, ["-e", "process.stdout.write('x'.repeat(4096))"], { timeoutMs: 10_000, maxBuffer: 1024 }), /more than 0 MB of output/);
});

test("a stop whose tree kill can't be confirmed is reported as unconfirmed", async t => {
  // The tree really ends, but the kill reports failure, as when taskkill can't find or end part of the tree.
  processTreeTesting.kill = async pid => { await killTree(pid); return false; };
  t.after(() => { processTreeTesting.kill = null; });
  await assert.rejects(runProcess(process.execPath, ["-e", "setTimeout(() => {}, 10000)"], { timeoutMs: 300 }),
    error => error instanceof ProcessStopped && error.confirmed === false && /couldn't confirm that it and the processes it started have ended/.test(error.message));
});
