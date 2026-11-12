import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { test } from "node:test";

const require = createRequire(import.meta.url);
const ts = require("typescript");
require.extensions[".ts"] = (module, file) => module._compile(ts.transpileModule(readFileSync(file, "utf8"), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText, file);
const { resolveSmallModel, askSmallModel } = require("./small-model.ts");
const { writeDeliveryText } = require("./paseo-metadata.ts");
const { resolveNamingModel } = require("../client/name-suggestions.ts");

function fakePaseo({ missing = false, refuse = () => null } = {}) {
  const calls = { models: [], modes: [], refreshed: [], created: [], archived: [] };
  const directories = { first: "C:/work/first", second: "C:/work/second" };
  const paseo = {
    providers: {
      listModels: async (provider, options) => {
        calls.models.push({ provider, options });
        return { models: provider === "claude" ? [{ id: `haiku-${options?.cwd?.split("/").at(-1) ?? "host"}`, label: "Haiku" }] : [] };
      },
      listModes: async (provider, options) => {
        calls.modes.push({ provider, options });
        assert.ok(options?.cwd, "mode discovery must use the agent's workspace");
        return { modes: [{ id: "read-only" }] };
      },
    },
    workspaces: { ref: workspaceId => ({
      directory: directories[workspaceId] ?? null,
      refresh: async () => { calls.refreshed.push(workspaceId); return missing ? null : { id: workspaceId }; },
      agents: { create: async options => {
        calls.created.push({ workspaceId, options });
        const refusal = refuse(options);
        if (refusal) throw new Error(refusal);
        return { waitForFinish: async () => ({ status: "idle", lastMessage: '{"commitMessage":"fix: use workspace models"}' }), archive: async () => {} };
      } },
    }) },
    agents: { ref: agentId => ({ archive: async () => { calls.archived.push(agentId); } }) },
  };
  return { paseo, calls };
}

const helper = { title: "Test", role: "namer", systemPrompt: "", prompt: "", outputSchema: {}, noun: "naming agent" };

test("a helper agent runs in the background on Paseo 0.16, and as an ordinary agent where that's refused", async () => {
  const { paseo, calls } = fakePaseo();
  assert.match(await askSmallModel(paseo, "first", { provider: "claude/haiku" }, helper), /commitMessage/);
  assert.deepEqual(calls.created.map(call => call.options.background), [true]);
  // A 0.16 client refuses before sending for an older host; a 0.15 host refuses before creating anything.
  for (const message of ["Update the host to use background agents.", "background is workspace creation intent; configure the selected workspace at creation."]) {
    const older = fakePaseo({ refuse: options => options.background ? message : null });
    assert.match(await askSmallModel(older.paseo, "first", { provider: "claude/haiku" }, helper), /commitMessage/);
    assert.deepEqual(older.calls.created.map(call => call.options.background), [true, undefined]);
    assert.notEqual(older.calls.created[0].options.agentId, older.calls.created[1].options.agentId, "the retry uses a new agent ID");
    assert.deepEqual(older.calls.archived, [older.calls.created[0].options.agentId]);
  }
  // Any other failure is reported as before, without a second agent.
  const failing = fakePaseo({ refuse: () => "Provider unavailable" });
  await assert.rejects(askSmallModel(failing.paseo, "first", { provider: "claude/haiku" }, helper), /Provider unavailable/);
  assert.equal(failing.calls.created.length, 1);
});

test("model discovery stays host-wide only when no workspace was supplied", async () => {
  const { paseo, calls } = fakePaseo();
  assert.equal((await resolveSmallModel(paseo)).provider, "claude/haiku-host");
  assert.deepEqual(calls.models, [
    { provider: "claude", options: undefined }, { provider: "codex", options: undefined },
  ]);
  assert.deepEqual(calls.refreshed, []);
});

test("different workspace catalogs are resolved independently, including naming's alias", async () => {
  const { paseo, calls } = fakePaseo();
  assert.equal((await resolveSmallModel(paseo, "first")).provider, "claude/haiku-first");
  assert.equal((await resolveNamingModel(paseo, "second")).provider, "claude/haiku-second");
  assert.deepEqual(calls.models, [
    { provider: "claude", options: { cwd: "C:/work/first" } }, { provider: "codex", options: { cwd: "C:/work/first" } },
    { provider: "claude", options: { cwd: "C:/work/second" } }, { provider: "codex", options: { cwd: "C:/work/second" } },
  ]);
});

test("delivery text uses the owning workspace for both catalogs and agent mode", async () => {
  const { paseo, calls } = fakePaseo();
  await writeDeliveryText(paseo, "second", { title: "Fix discovery", ticketKey: null, summary: null, commitInstructions: "Use Conventional Commits", pullRequestInstructions: null }, { taskId: "task-test" });
  assert.ok(calls.models.every(call => call.options?.cwd === "C:/work/second"));
  assert.deepEqual(calls.modes, [{ provider: "claude", options: { cwd: "C:/work/second" } }]);
  assert.equal(calls.created.length, 1);
  assert.equal(calls.created[0].workspaceId, "second");
  assert.equal(calls.created[0].options.config.provider, "claude/haiku-second");
  assert.equal(calls.created[0].options.config.modeId, "read-only");
});

test("an unavailable or directory-less workspace cannot fall through to host discovery or launch", async () => {
  for (const [options, workspaceId] of [[{ missing: true }, "first"], [{}, "unknown"]]) {
    const { paseo, calls } = fakePaseo(options);
    await assert.rejects(resolveSmallModel(paseo, workspaceId), /selected workspace is unavailable/);
    await assert.rejects(askSmallModel(paseo, workspaceId, { provider: "claude/haiku" }, { title: "Test", role: "namer", systemPrompt: "", prompt: "", outputSchema: {}, noun: "naming agent" }), /selected workspace is unavailable/);
    assert.deepEqual(calls.models, []);
    assert.deepEqual(calls.modes, []);
    assert.deepEqual(calls.created, []);
  }
});
