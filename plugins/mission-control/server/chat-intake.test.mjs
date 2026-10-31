import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { test } from "node:test";
const require = createRequire(import.meta.url), ts = require("typescript");
const compile = source => ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
require.extensions[".ts"] = (module, file) => module._compile(compile(readFileSync(file, "utf8")), file);
const context = { local: "personal", target: "remote", agentId: "coordinator", label: "Remote", orchestrator: true };
function fixture() {
  const calls = [], now = new Date().toISOString();
  const host = { serverId: "remote", observedAt: now, complete: true, warnings: [], agents: [], tasks: [], stoppedAgentIds: [], workspaces: [{ id: "w1", name: "Main", projectName: "One", branch: null, status: "idle" }, { id: "w2", name: "Main", projectName: "Two", branch: null, status: "idle" }] };
  const status = { report: null, reportError: null, missing: [], imported: [], launch: null, agent: null };
  const api = { providers: { listAvailable: async () => ({ providers: [{ provider: "codex", available: true }, { provider: "copilot", available: true }] }), listModels: async () => ({ models: [{ id: "model", label: "Model", isDefault: true }] }) }, dispose() {} };
  const invoke = async (serverId, method, input) => {
    calls.push({ serverId, method, input });
    if (method === "orchestrator.host.snapshot") return host;
    if (method === "morning.status") return status;
    if (method === "morning.start") return status;
    if (method === "intake.capture") return { taskId: `task_${input.requestId}`, title: input.title, action: input.action, completed: true, message: "Saved" };
    if (method === "intake.route") return { taskId: input.taskId, title: "Saved task", action: input.action, completed: true, message: "Planning requested" };
    throw new Error(`Unexpected operation: ${method}`);
  };
  const module = { exports: {} };
  new Function("require", "module", "exports", compile(readFileSync(new URL("./chat-intake.ts", import.meta.url), "utf8")))(name => name === "@getpaseo/client" ? { createPaseoApi: () => api } : name === "./chat-transport" ? { invokeChatHost: invoke, withChatHost: async (server, action) => { assert.equal(server, "remote"); return action({}); } } : require(name), module, module.exports);
  return { host, status, calls, api, command: (text, overrides) => module.exports.manageIntakeChat(text, { ...context, ...overrides }) };
}
test("discovery asks for an exact workspace and provider instead of guessing", async () => {
  const f = fixture();
  assert.match((await f.command("discover")).text, /Choose where Discovery/);
  assert.match((await f.command("discover Main")).text, /Choose where Discovery/);
  assert.match((await f.command("discover w1")).text, /Choose a provider/);
  assert.ok(!f.calls.some(call => call.method === "morning.start"));
});
test("chat Discovery starts on the bound host with explicit workspace/provider and never imports", async () => {
  const f = fixture(); const result = await f.command("discover One / Main using copilot");
  assert.match(result.text, /read-only tracker scan/);
  const start = f.calls.at(-1); assert.equal(start.serverId, "remote"); assert.equal(start.method, "morning.start");
  assert.deepEqual(start.input, { serverId: "remote", workspaceId: "w1", provider: "copilot/model", fixture: false });
  assert.ok(!f.calls.some(call => /import|capture|queue|pipeline/.test(call.method)));
});
test("using-provider shorthand works when there is one workspace", async () => {
  const f = fixture(); f.host.workspaces.pop();
  await f.command("discover using copilot"); assert.equal(f.calls.at(-1).method, "morning.start");
  assert.equal(f.calls.at(-1).input.provider, "copilot/model");
});
test("running or unconfirmed Discovery cannot be started again", async () => {
  const f = fixture();
  f.status.launch = { launchId: "11111111-0000-4000-8000-000000000001", agentId: "a", serverId: "remote", workspaceId: "w1", provider: "copilot/model", fixture: false, phase: "sending", createdAt: "now", updatedAt: "now", error: "lost reply" };
  assert.match((await f.command("discover w1 using copilot")).text, /unconfirmed/);
  assert.ok(!f.calls.some(call => call.method === "morning.start"));
});
test("described task commands share one deterministic request across retries and schedule choices", async () => {
  const f = fixture();
  await f.command("save task in w1 | Fix invoices | No duplicates");
  await f.command("queue task in w1 | Fix invoices | No duplicates");
  await f.command("plan task in w1 | Fix invoices | No duplicates");
  const writes = f.calls.filter(call => call.method === "intake.capture");
  assert.deepEqual(writes.map(call => call.input.action), ["backlog", "queue", "plan"]);
  assert.equal(new Set(writes.map(call => call.input.requestId)).size, 1);
  assert.ok(writes.every(call => call.serverId === "personal" && call.input.remoteServerId === "remote" && call.input.coordinatorId === "coordinator"));
});
test("intake is refused in unbound chats and ambiguous destinations create nothing", async () => {
  const f = fixture();
  assert.match((await f.command("discover", { orchestrator: false })).text, /coordinator chat/); assert.equal(f.calls.length, 0);
  assert.match((await f.command("save task in Main | Fix | Works")).text, /nothing was created/);
  assert.ok(!f.calls.some(call => call.method === "intake.capture"));
  assert.equal(await f.command("approve"), null);
});
test("a saved task can enter planning without recreating it", async () => {
  const f = fixture(); await f.command("plan task task_abc");
  assert.equal(f.calls.at(-1).method, "intake.route"); assert.equal(f.calls.at(-1).input.taskId, "task_abc");
});
