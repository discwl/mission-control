import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { test } from "node:test";
const require = createRequire(import.meta.url);
const ts = require("typescript");
require.extensions[".ts"] = (module, file) => module._compile(ts.transpileModule(readFileSync(file, "utf8"), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText, file);
const { startMissionButtons } = require("./mission-buttons.ts");
const turn = () => new Promise(resolve => setImmediate(resolve));
async function fixture(t, initialFailure = false) {
  let tick;
  t.mock.method(globalThis, "setInterval", callback => { tick = callback; return 1; });
  t.mock.method(globalThis, "clearInterval", () => {});
  t.mock.method(console, "warn", () => {});
  const state = { entries: [{ agent: { id: "agent", workspaceId: "work", title: "Written help", provider: "claude", status: "idle", labels: {}, pendingPermissions: [], archivedAt: null } }], questions: [{ question: { serverId: "local", workspaceId: "work", agentId: "agent", questionId: "q1", status: "open", askedAt: "2026-10-01T10:00:00Z" } }], fail: false };
  const buttons = new Map(), reads = [], opens = [];
  const client = {
    paseo: { agents: { list: async () => ({ entries: state.entries }) } },
    rpc: async (contract, input) => {
      reads.push([contract.name, input]); if (state.fail) throw new Error("unavailable");
      if (contract.name === "attention.waiting") return { questions: state.questions };
      return { serverId: "local", summaries: { work: { openDecisions: 0 } } };
    },
    addHeaderButton: contribution => { buttons.set(contribution.workspaceId, contribution); return { remove: () => buttons.delete(contribution.workspaceId) }; },
    openPanel: (...args) => opens.push(args),
  };
  if (initialFailure) { state.fail = true; state.entries[0].agent.pendingPermissions = [{ id: "native" }]; }
  const stop = startMissionButtons(client); t.after(stop); await turn();
  return { state, buttons, reads, opens, stop, tick: async () => { await tick(); await turn(); } };
}
test("header discovers ordinary questions without opening Attention and opens only on press", async t => {
  const f = await fixture(t);
  assert.equal(f.buttons.get("work").button.label, "1 needs you");
  assert.ok(f.reads.some(([name, input]) => name === "attention.waiting" && input.serverId === "local"));
  assert.deepEqual(f.opens, []);
  await f.buttons.get("work").button.behavior.onPress();
  assert.equal(f.opens[0][1].workspaceId, "work");
});
test("header clears the ordinary question after a reply and counts a later error", async t => {
  const f = await fixture(t);
  f.state.entries[0].agent.lastUserMessageAt = "2026-10-01T10:01:00Z";
  await f.tick(); assert.equal(f.buttons.get("work").button.label, undefined);
  Object.assign(f.state.entries[0].agent, { attentionReason: "error", requiresAttention: true, attentionTimestamp: "2026-10-01T10:02:00Z" });
  await f.tick(); assert.equal(f.buttons.get("work").button.label, "1 needs you");
});
test("header scopes questions to this host/workspace and gives native prompts precedence", async t => {
  const f = await fixture(t);
  f.state.questions[0].question.serverId = "remote";
  await f.tick(); assert.equal(f.buttons.get("work").button.label, undefined);
  f.state.questions[0].question.serverId = "local"; f.state.questions[0].question.workspaceId = "other";
  await f.tick(); assert.equal(f.buttons.get("work").button.label, undefined);
  f.state.questions[0].question.workspaceId = "work"; f.state.entries[0].agent.pendingPermissions = [{ id: "p1" }];
  await f.tick(); assert.equal(f.buttons.get("work").button.label, "1 needs you");
});
test("failed reads retain the waiting badge, and disposal removes contributions", async t => {
  const f = await fixture(t);
  f.state.fail = true; await f.tick(); assert.equal(f.buttons.get("work").button.label, "1+ needs you");
  f.stop(); assert.equal(f.buttons.size, 0);
});

test("initial vault failure still provides Mission navigation and live native permission count", async t => {
  const f = await fixture(t, true);
  assert.equal(f.buttons.get("work").button.label, "1+ needs you");
  await f.buttons.get("work").button.behavior.onPress();
  assert.equal(f.opens[0][1].workspaceId, "work");
  f.state.fail = false; await f.tick();
  assert.equal(f.buttons.get("work").button.label, "1 needs you");
});
