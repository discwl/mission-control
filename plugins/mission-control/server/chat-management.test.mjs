import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { test } from "node:test";
const require = createRequire(import.meta.url), ts = require("typescript");
require.extensions[".ts"] = (module, file) => module._compile(ts.transpileModule(readFileSync(file, "utf8"), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText, file);
const { manageChatCommand } = require("./chat-management.ts"), transport = require("./chat-transport.ts");
const context = { local: "personal", target: "CNS", agentId: "coordinator", label: "CNS", orchestrator: true };
const worker = { id: "worker", name: "CN-123 worker", workspaceId: "w", status: "idle", archivedAt: null, labels: { "mission-control.task-id": "task_a" }, updatedAt: "now", activityAt: null, pendingPermissions: 0, attention: false, attentionReason: null, error: null, inputTokens: null, outputTokens: null };
const task = { schemaVersion: 1, taskId: "task_a", hostId: "CNS", projectId: "p", title: "CN-123 · Fix discount", acceptanceCriteria: "Prevent duplicate", status: "ready", source: "manual", assignments: [{ serverId: "CNS", workspaceId: "w" }], createdAt: "now", updatedAt: "now" };
const host = () => ({ serverId: "CNS", observedAt: "now", agents: [structuredClone(worker)], workspaces: [], tasks: [{ task: structuredClone(task), run: null, decisions: [], questions: [], problem: null }], warnings: [], complete: true, stoppedAgentIds: [] });
test("adopt keeps task identity and only links an exactly associated existing worker", async t => {
  const current = host(), calls = [];
  t.mock.method(transport, "invokeChatHost", async (serverId, method, input) => {
    calls.push({ serverId, method, input });
    if (method === "orchestrator.host.snapshot") return current;
    assert.equal(serverId, "personal"); assert.equal(method, "orchestrator.work.set");
    return { links: [{ ...input, linkedAt: "now" }] };
  });
  const result = await manageChatCommand("adopt task_a", context); assert.match(result.text, /Linked CN-123 worker/);
  assert.equal(calls[1].input.taskId, "task_a"); assert.equal(calls[1].input.remoteAgentId, "worker"); assert.equal(calls[1].input.agentId, "coordinator");
  current.agents[0].archivedAt = "yesterday"; calls.length = 0;
  const retired = await manageChatCommand("adopt task_a", context); assert.match(retired.text, /No active worker/); assert.equal(calls.length, 1);
});
test("adopt never guesses among multiple task workers or revives completed tasks", async t => {
  const current = host(); current.agents.push({ ...worker, id: "worker2" }); let writes = 0;
  t.mock.method(transport, "invokeChatHost", async (_server, method) => { if (method !== "orchestrator.host.snapshot") writes++; return current; });
  assert.match((await manageChatCommand("adopt task_a", context)).text, /Choose the worker/); assert.equal(writes, 0);
  current.tasks[0].task.status = "delivered";
  assert.match((await manageChatCommand("adopt task_a worker worker", context)).text, /completed/); assert.equal(writes, 0);
});
