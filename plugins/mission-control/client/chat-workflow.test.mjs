import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire, Module } from "node:module";
import { fileURLToPath } from "node:url";
const require = createRequire(import.meta.url);
const ts = require("typescript");
function load(relative, overrides) {
  const filename = fileURLToPath(new URL(relative, import.meta.url));
  const mod = new Module(filename); mod.filename = filename; mod.paths = require.resolve.paths("typescript");
  mod.require = id => overrides(id) ?? require(id);
  const compiled = ts.transpileModule(readFileSync(filename, "utf8"), { fileName: filename, compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX } });
  mod._compile(compiled.outputText, filename); return mod.exports;
}
function clientFixture() {
  const { registerChatClient } = load("./chat-workflow.tsx", id => id === "react-native" ? { View: "View", Text: "Text" } : id === "../shared/chat-workflow" ? { chatNativeCommand: { name: "chat.native-command" } } : undefined);
  let command, screen; const opened = [], removed = [], calls = [];
  const dispose = registerChatClient({
    addTimelineRenderer: () => () => removed.push("renderer"),
    addScreen: value => { screen = value; return () => removed.push("screen"); },
    addSlashCommand: value => { command = value; return () => removed.push("command"); },
    openScreen: value => opened.push(value),
  });
  return { command, screen, opened, removed, calls, dispose };
}
test("native slash command uses the plugin server receipt endpoint without client append or model prompts", async () => {
  const f = clientFixture();
  await f.command.onSubmit({ args: " needs ", agent: { id: "coordinator" }, rpc: async (...args) => { f.calls.push(args); return { text: "Waiting work" }; } });
  assert.equal(f.calls[0][0].name, "chat.native-command");
  assert.deepEqual(f.calls[0][1], { agentId: "coordinator", text: "needs" });
  assert.deepEqual(f.opened, []);
  f.dispose(); assert.deepEqual(f.removed.sort(), ["command", "renderer", "screen"]);
});
test("an unconfirmed native action shows an error and never sends an approval to the agent", async () => {
  const f = clientFixture();
  await f.command.onSubmit({ args: "yes approve abcdef1234", agent: { id: "coordinator" }, rpc: async () => { throw new Error("connection lost"); } });
  assert.deepEqual(f.opened, [{ screenId: "chat-request-error" }]);
  const output = JSON.stringify(f.screen.Component({ theme: { colors: {} } }));
  assert.match(output, /could not confirm/); assert.match(output, /connection lost/); assert.match(output, /already completed/);
});
test("native receipt is appended by the plugin server session and preserves display-only data", async () => {
  const contracts = new Map();
  const contract = name => { if (!contracts.has(name)) contracts.set(name, { name }); return contracts.get(name); };
  const exports = {
    chatNativeCommand: contract("chat.native-command"), chatCommand: contract("chat.command"), chatInbox: contract("chat.inbox"), CHAT_HELP: "Mission Control help",
    daemonServerId: async () => "local",
    createChatActions: () => ({}), createOrchestratorWorkStore: () => ({}),
    readOrchestratorBindings: async () => ({ bindings: {}, problems: {} }),
  };
  const { registerChatWorkflow } = load("../server/chat-workflow.ts", id => id.startsWith(".") ? new Proxy({}, { get: (_target, key) => exports[key] ?? contract(String(key)) }) : undefined);
  const handlers = new Map(), appended = [];
  registerChatWorkflow({ handle: (contract, run) => handlers.set(contract.name, run), on() {} }, { decisions: {}, questions: {}, pullRequests: {} });
  const context = { paseo: { agents: { ref: id => ({ refresh: async () => ({ agent: { id, workspaceId: "workspace" } }), timeline: { append: async item => { appended.push({ id, item }); } } }) } } };
  const result = await handlers.get("chat.native-command")({ agentId: "coordinator", text: "help" }, context);
  assert.equal(result.text, "Mission Control help"); assert.equal(appended.length, 1);
  assert.equal(appended[0].id, "coordinator"); assert.equal(appended[0].item.type, "plugin");
  assert.equal(appended[0].item.kind, "chat-workflow"); assert.equal(appended[0].item.data.text, result.text);
});
