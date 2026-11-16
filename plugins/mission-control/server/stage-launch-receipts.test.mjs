import assert from "node:assert/strict";
import { mkdtemp, readdir, rm, utimes, writeFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
const require = createRequire(import.meta.url); const ts = require("typescript");
require.extensions[".ts"] = (module, file) => module._compile(ts.transpileModule(readFileSync(file, "utf8"), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText, file);
const { createLaunchReceipts } = require("./stage-launch-receipts.ts");
const { launchHadEffects } = require("../shared/stage-launch.ts");

async function folder(t) { const dir = await mkdtemp(join(tmpdir(), "mc-launch-receipts-")); t.after(() => rm(dir, { recursive: true, force: true })); return dir; }

test("a request ID starts only once: a second claim returns the first start's receipt", async t => {
  const receipts = createLaunchReceipts(await folder(t));
  const first = await receipts.claim("mc-pipeline-one");
  assert.equal(first.created, true); assert.deepEqual([first.receipt.phase, first.receipt.step], ["running", "accepted"]);
  await receipts.step("mc-pipeline-one", "agent", { agentId: "worker" });
  const again = await receipts.claim("mc-pipeline-one");
  assert.equal(again.created, false);
  assert.deepEqual([again.receipt.phase, again.receipt.step, again.receipt.agentId], ["running", "agent", "worker"]);
  await receipts.finish("mc-pipeline-one", { phase: "done", agentId: "worker", runId: "run_a" });
  const done = await receipts.status("mc-pipeline-one");
  assert.deepEqual([done.phase, done.step, done.agentId, done.runId], ["done", "sent", "worker", "run_a"]);
});

test("a start that was running when Mission Control restarted reads as interrupted at its last step", async t => {
  const dir = await folder(t);
  const before = createLaunchReceipts(dir);
  await before.claim("mc-pipeline-two"); await before.step("mc-pipeline-two", "agent", { agentId: "worker" });
  const after = createLaunchReceipts(dir);
  const receipt = await after.status("mc-pipeline-two");
  assert.equal(receipt.phase, "failed"); assert.equal(receipt.step, "agent");
  assert.match(receipt.error, /restarted while the stage was starting \(last step: agent\)/);
  assert.equal(launchHadEffects(receipt), true, "a worker may exist, so a person checks it");
  const early = createLaunchReceipts(dir); await early.claim("mc-pipeline-three");
  assert.equal(launchHadEffects(await createLaunchReceipts(dir).status("mc-pipeline-three")), false, "interrupted before any step did nothing");
});

test("cancelling a request that never arrived stops it for good, and never hides one that did", async t => {
  const receipts = createLaunchReceipts(await folder(t));
  const cancelled = await receipts.cancelIfMissing("mc-pipeline-late");
  assert.equal(cancelled.phase, "cancelled");
  const late = await receipts.claim("mc-pipeline-late");
  assert.equal(late.created, false); assert.equal(late.receipt.phase, "cancelled", "the late request finds the cancellation and starts nothing");
  await receipts.claim("mc-pipeline-real");
  assert.equal((await receipts.cancelIfMissing("mc-pipeline-real")).phase, "running", "an existing start is reported, not cancelled");
});

test("an unreadable receipt counts as a start that may have done anything", async t => {
  const dir = await folder(t); const receipts = createLaunchReceipts(dir);
  await receipts.claim("mc-pipeline-seed");
  await writeFile(join(dir, "mc-pipeline-bad.json"), "{ not json");
  const receipt = await receipts.status("mc-pipeline-bad");
  assert.notEqual(receipt, null); assert.notEqual(receipt.phase, "cancelled");
  assert.equal(launchHadEffects(receipt), true);
});

test("old finished receipts are pruned; running ones and invalid IDs are handled safely", async t => {
  const dir = await folder(t); const receipts = createLaunchReceipts(dir);
  await receipts.claim("mc-pipeline-old"); await receipts.finish("mc-pipeline-old", { phase: "failed", error: "x" });
  await receipts.claim("mc-pipeline-live");
  const month = new Date(Date.now() - 40 * 24 * 60 * 60_000);
  for (const name of ["mc-pipeline-old.json", "mc-pipeline-live.json"]) await utimes(join(dir, name), month, month);
  await receipts.prune();
  assert.deepEqual((await readdir(dir)).sort(), ["mc-pipeline-live.json"]);
  await assert.rejects(receipts.claim("../escape"), /Invalid stage start request ID/);
});

test("a finishing start is never read as interrupted while its final receipt is written", async t => {
  const receipts = createLaunchReceipts(await folder(t));
  for (let attempt = 0; attempt < 25; attempt++) {
    const id = `mc-pipeline-race-${attempt}`;
    await receipts.claim(id);
    const finishing = receipts.finish(id, { phase: "done", agentId: "worker", runId: "run_a" });
    const seen = await Promise.all([receipts.status(id), receipts.status(id), finishing.then(() => receipts.status(id))]);
    for (const receipt of seen) assert.notEqual(receipt.phase, "failed", `attempt ${attempt}: a successful start read as ${receipt.phase}: ${receipt.error}`);
    assert.equal(seen[2].phase, "done");
  }
});

test("replacing a receipt retries while Windows briefly refuses the rename", async t => {
  const promises = require("node:fs/promises"); const original = promises.rename; let refusals = 0;
  t.mock.method(promises, "rename", async (...args) => { if (refusals < 2) { refusals++; throw Object.assign(new Error("EPERM: operation not permitted, rename"), { code: "EPERM" }); } return original(...args); });
  const receipts = createLaunchReceipts(await folder(t));
  await receipts.claim("mc-pipeline-busy");
  await receipts.step("mc-pipeline-busy", "agent", { agentId: "worker" });
  assert.equal(refusals, 2);
  assert.equal((await receipts.status("mc-pipeline-busy")).step, "agent");
});
