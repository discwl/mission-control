import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

const require = createRequire(import.meta.url);
const ts = require("typescript");
require.extensions[".ts"] = (module, file) => module._compile(ts.transpileModule(readFileSync(file, "utf8"), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText, file);
const { agentRuns, createClaimHandler, fileClaimStore } = require("./agents-panel.ts");
const { latestRunByAgent, unclaimedWorkspaces } = require("../shared/agents-panel.ts");

function memoryStore(initial = []) {
  let ids = new Set(initial);
  return { saves: 0, async load() { return new Set(ids); }, async save(next) { this.saves++; ids = new Set(next); } };
}

test("each new workspace is claimed once, in order, without repeats", async () => {
  assert.deepEqual(unclaimedWorkspaces(new Set(["w1"]), ["w2", "w1", "w3", "w2"]), ["w2", "w3"]);
  const store = memoryStore(["w1"]);
  const claim = createClaimHandler(store);
  assert.deepEqual(await claim({ workspaceIds: ["w1", "w2"] }), { claimed: ["w2"] });
  assert.deepEqual(await claim({ workspaceIds: ["w2"] }), { claimed: [] });
  assert.equal(store.saves, 1);
});

test("claims made at the same time don't both open the same workspace", async () => {
  const claim = createClaimHandler(memoryStore());
  const results = await Promise.all([claim({ workspaceIds: ["w1", "w2"] }), claim({ workspaceIds: ["w2", "w3"] })]);
  assert.deepEqual(results, [{ claimed: ["w1", "w2"] }, { claimed: ["w3"] }]);
});

test("a failed claim doesn't block the next one", async () => {
  const store = memoryStore();
  let fail = true;
  const claim = createClaimHandler({ load: () => fail ? Promise.reject(new Error("disk busy")) : store.load(), save: next => store.save(next) });
  await assert.rejects(claim({ workspaceIds: ["w1"] }), /disk busy/);
  fail = false;
  assert.deepEqual(await claim({ workspaceIds: ["w1"] }), { claimed: ["w1"] });
});

test("the claim file survives reloads and refuses anything but workspace IDs", async () => {
  const folder = await mkdtemp(join(tmpdir(), "mc-agents-panel-"));
  try {
    const file = join(folder, "nested", "agents-auto-open.json");
    const store = fileClaimStore(file);
    assert.deepEqual([...await store.load()], []);
    await createClaimHandler(store)({ workspaceIds: ["w1", "w2"] });
    assert.deepEqual(JSON.parse(await readFile(file, "utf8")), ["w1", "w2"]);
    assert.deepEqual(await createClaimHandler(fileClaimStore(file))({ workspaceIds: ["w2", "w3"] }), { claimed: ["w3"] });
    await writeFile(file, JSON.stringify(["w1", 7]), "utf8");
    await assert.rejects(fileClaimStore(file).load(), /array of workspace IDs/);
  } finally {
    await rm(folder, { recursive: true, force: true });
  }
});

const run = (agentId, taskId, updatedAt, extra = {}) => ({ agentId, taskId, stage: "execute", outcome: "in_progress", nextAction: `Next for ${taskId}`, updatedAt, ...extra });

test("each agent's newest run is its summary; runs without an agent are ignored", () => {
  assert.deepEqual(latestRunByAgent([
    run("a1", "task_1", "2026-09-29T10:00:00.000Z"), run("a1", "task_2", "2026-09-29T11:00:00.000Z"), run(null, "task_3", "2026-09-29T12:00:00.000Z"),
    run("a2", "task_1", "2026-09-29T09:00:00.000Z"),
  ]), {
    a1: { taskId: "task_2", stage: "execute", outcome: "in_progress", nextAction: "Next for task_2", updatedAt: "2026-09-29T11:00:00.000Z" },
    a2: { taskId: "task_1", stage: "execute", outcome: "in_progress", nextAction: "Next for task_1", updatedAt: "2026-09-29T09:00:00.000Z" },
  });
});

test("a task whose runs can't be read is skipped", async () => {
  const sources = [{ task: { taskId: "task_ok" } }, { task: { taskId: "task_bad" } }];
  const runs = await agentRuns(sources, async source => {
    if (source.task.taskId === "task_bad") throw new Error("Run identity does not match");
    return [{ ...run("a1", "task_ok", "2026-09-29T10:00:00.000Z"), runId: "run_1", schemaVersion: 1 }];
  });
  assert.deepEqual(Object.keys(runs), ["a1"]);
  assert.equal(runs.a1.nextAction, "Next for task_ok");
});
