import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
const require = createRequire(import.meta.url);
const ts = require("typescript");
require.extensions[".ts"] = (module, file) => module._compile(ts.transpileModule(readFileSync(file, "utf8"), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText, file);
const { createOrchestratorWorkStore, registerOrchestratorWork } = require("./orchestrator-work.ts");
const { recordStartedWork } = await import("../scripts/remote.mjs");
const owner = { serverId: "local", agentId: "chat1", remoteServerId: "remote" };
const input = (extra = {}) => ({ ...owner, remoteAgentId: "worker", remoteWorkspaceId: "w", taskId: null, linked: true, ...extra });

test("links persist across reloads and isolate chats and hosts; concurrent updates do not lose links", async () => {
  const folder = await mkdtemp(join(tmpdir(), "mc-orchestrator-"));
  try {
    const file = join(folder, "links.json");
    const store = createOrchestratorWorkStore(file);
    await Promise.all([store.set(input()), store.set(input({ agentId: "chat2" })), store.set(input({ remoteServerId: "another" })), store.set(input({ remoteAgentId: "worker2" }))]);
    const loaded = createOrchestratorWorkStore(file);
    assert.deepEqual((await loaded.list(owner)).map(link => link.remoteAgentId), ["worker", "worker2"]);
    assert.equal((await loaded.list({ ...owner, agentId: "chat2" })).length, 1);
    await loaded.set(input({ linked: false }));
    assert.deepEqual((await loaded.list(owner)).map(link => link.remoteAgentId), ["worker2"]);
    assert.equal((await loaded.list({ ...owner, agentId: "chat2" })).length, 1);
    const content = await readFile(file, "utf8");
    assert.equal(JSON.parse(content).length, 3);
    await writeFile(file, "broken");
    await assert.rejects(loaded.set(input()));
    assert.equal(await readFile(file, "utf8"), "broken", "corruption must not erase the old data");
  } finally { await rm(folder, { recursive: true, force: true }); }
});
test("start links the actual worktree and worker, including resumes, without mutating its result", async () => {
  const calls = [];
  const result = { started: true, agent: { id: "worker" }, worktree: { workspaceId: "isolated" } };
  assert.deepEqual(await recordStartedWork(result, { serverId: "remote", workspaceId: "source", taskId: "task" }, async link => calls.push(link)), { linked: true });
  assert.deepEqual(calls, [{ remoteServerId: "remote", remoteAgentId: "worker", remoteWorkspaceId: "isolated", taskId: "task", linked: true }]);
  assert.equal(result.started, true);
  const failure = await recordStartedWork(result, {}, async () => { throw new Error("offline"); });
  assert.equal(failure.linked, false);
  assert.match(failure.warning, /do not repeat Start/);
  assert.equal(result.started, true);
  let called = false;
  const missing = await recordStartedWork({ agent: null }, {}, async () => { called = true; });
  assert.equal(called, false);
  assert.equal(missing.linked, false);
});
test("link RPCs reject a different origin host, missing chat, or mismatched host folder before touching storage", async t => {
  const names = require("./agent-names.ts");
  const bindings = require("./orchestrator.ts");
  t.mock.method(names, "daemonServerId", async () => "local");
  t.mock.method(bindings, "readOrchestratorBindings", async () => ({ bindings: { folder: { serverId: "other" } }, problems: {} }));
  const handlers = new Map();
  registerOrchestratorWork({ handle: (contract, handler) => handlers.set(contract.name, handler) });
  let snapshot = null;
  const paseo = { agents: { ref: () => ({ refresh: async () => snapshot }) } };
  const set = handlers.get("orchestrator.work.set");
  await assert.rejects(set(input({ serverId: "wrong" }), { paseo }), /another host/);
  await assert.rejects(set(input(), { paseo }), /chat is unavailable/);
  snapshot = { agent: { workspaceId: "folder", archivedAt: null } };
  await assert.rejects(set(input(), { paseo }), /host.json does not match/);
  await assert.rejects(handlers.get("orchestrator.work.list")(owner, { paseo }), /host.json does not match/);
});
