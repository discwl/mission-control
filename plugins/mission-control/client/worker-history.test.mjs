import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { test } from "node:test";
import vm from "node:vm";
const require = createRequire(import.meta.url);
const ts = require("typescript");
require.extensions[".ts"] = (module, file) => module._compile(ts.transpileModule(readFileSync(file, "utf8"), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText, file);
const { mergeWorkerHistory, restoreWorkerHistory, workerGroup, workerOwnerKey } = require("./worker-history-model.ts");
const owner = { serverId: "personal", agentId: "coordinator" };
const at = "2026-10-27T00:00:00Z";
const agent = (id, extra = {}) => ({ id, name: id, workspaceId: "w", status: "idle", archivedAt: null, permissions: [], lastError: null, requiresAttention: false, activeTurn: false, lastUserMessageAt: at, activeTurnStartedAt: null, attentionTimestamp: null, summary: null, parentAgentId: "coordinator", labels: { "paseo.parent-agent-id": "coordinator", "paseo.parent-server-id": "personal" }, ...extra });
const observation = (agents, extra = {}) => ({ serverId: "CNS", hostLabel: "CNS", agents, workspaces: [{ id: "w", name: "Search API" }], links: [], linksKnown: true, complete: true, current: true, observedAt: at, ...extra });
const link = (id, extra = {}) => ({ serverId: "personal", agentId: "coordinator", remoteServerId: "CNS", remoteAgentId: id, ...extra });

test("completed and archived workers remain visible across serialization and repeated reads", () => {
  const agents = [agent("test", { archivedAt: at }), agent("completed", { attentionReason: "finished" })];
  const rows = mergeWorkerHistory([], [observation(agents)], owner);
  assert.deepEqual(rows.map(row => row.group).sort(), ["Archived", "Completed"]);
  const restored = restoreWorkerHistory(JSON.parse(JSON.stringify({ version: 1, owner: workerOwnerKey(owner), workers: rows })), workerOwnerKey(owner));
  assert.equal(restored.length, 2);
  assert.equal("available" in restored[0], false);
  assert.deepEqual(mergeWorkerHistory(restored, [observation(agents)], owner), rows);
  assert.deepEqual(restoreWorkerHistory({ version: 1, owner: "another", workers: rows }, workerOwnerKey(owner)), []);
});
test("reading a completion does not erase completed history or move activity backwards", () => {
  const finished = agent("done", { attentionReason: "finished", attentionTimestamp: "2026-10-27T01:00:00Z" });
  const first = mergeWorkerHistory([], [observation([finished])], owner);
  const read = mergeWorkerHistory(first, [observation([agent("done")])], owner);
  assert.equal(read[0].group, "Completed");
  assert.equal(read[0].activityAt, "2026-10-27T01:00:00Z");
  const newTurn = mergeWorkerHistory(read, [observation([agent("done", { lastUserMessageAt: "2026-10-27T02:00:00Z" })])], owner);
  assert.equal(newTurn[0].group, "Idle");
});
test("ownership uses exact host and chat; unrelated agents in the same workspace never leak", () => {
  const agents = [agent("mine"), agent("wrong-server", { labels: { "paseo.parent-agent-id": "coordinator", "paseo.parent-server-id": "other" } }), agent("wrong-chat", { parentAgentId: "other", labels: { "paseo.parent-agent-id": "other", "paseo.parent-server-id": "personal" } }), agent("ambiguous", { labels: { "paseo.parent-agent-id": "coordinator" } }), agent("unrelated", { labels: {}, parentAgentId: null })];
  const rows = mergeWorkerHistory([], [observation(agents, { links: [link("unrelated", { agentId: "other" })] })], owner);
  assert.deepEqual(rows.map(row => row.agentId), ["mine"]);
});
test("descendants cross hosts without treating same IDs on other hosts as parents", () => {
  const root = observation([agent("root")]);
  const remote = observation([agent("grandchild", { parentAgentId: "root", labels: { "paseo.parent-agent-id": "root", "paseo.parent-server-id": "CNS" } }), agent("foreign", { parentAgentId: "root", labels: { "paseo.parent-agent-id": "root", "paseo.parent-server-id": "other" } })], { serverId: "AACN", hostLabel: "AACN" });
  assert.deepEqual(mergeWorkerHistory([], [root, remote], owner).map(row => row.agentId).sort(), ["grandchild", "root"]);
});
test("an offline ancestor host cannot erase a cached cross-host descendant", () => {
  const ancestor = observation([agent("root")]);
  const child = observation([agent("child", { parentAgentId: "root", labels: { "paseo.parent-agent-id": "root", "paseo.parent-server-id": "CNS" } })], { serverId: "AACN", hostLabel: "AACN" });
  const first = mergeWorkerHistory([], [ancestor, child], owner);
  const offline = mergeWorkerHistory(first, [child], owner);
  assert.deepEqual(offline.map(row => row.agentId).sort(), ["child", "root"]);
  assert.equal(offline.every(row => !row.available), true);
});
test("offline, missing and stale-link history is unavailable; verified unlink removes it", () => {
  const worker = agent("linked", { parentAgentId: null, labels: {} });
  const first = mergeWorkerHistory([], [observation([worker], { links: [link("linked")] })], owner);
  assert.equal(first[0].available, true);
  assert.equal(mergeWorkerHistory(first, [], owner)[0].available, false);
  assert.equal(mergeWorkerHistory(first, [observation([], { current: false })], owner).length, 1);
  assert.equal(mergeWorkerHistory(first, [observation([worker], { links: [link("linked")], linksKnown: false })], owner)[0].available, false);
  assert.equal(mergeWorkerHistory(first, [observation([worker])], owner).length, 0);
});
test("idle, closed and an agent summary do not imply task completion", () => {
  assert.equal(workerGroup(agent("idle", { summary: "Done" })), "Idle");
  assert.equal(workerGroup(agent("closed", { status: "closed" })), "Idle");
  assert.equal(workerGroup(agent("done", { attentionReason: "finished", requiresAttention: true })), "Completed");
  assert.equal(workerGroup(agent("permission", { permissions: [{}], status: "running" })), "Needs you");
  assert.equal(workerGroup(agent("running", { activeTurn: true })), "Active");
});
test("archived host reads retain pagination and always request archived agents", async () => {
  const calls = []; const module = { exports: {} };
  const source = ts.transpileModule(readFileSync(new URL("./worker-roster.ts", import.meta.url), "utf8"), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  const api = { agents: { list: async options => { calls.push(options); const second = options.page.cursor === "older"; return { entries: [{ agent: { id: second ? "archived" : "new" } }], pageInfo: { hasMore: !second, nextCursor: second ? null : "older" } }; } }, workspaces: { list: async () => ({ entries: [], pageInfo: { hasMore: false } }) } };
  new vm.Script(source).runInNewContext({ module, exports: module.exports, Date, require: name => name === "@getpaseo/plugin/client" ? { getPaseoClient: () => api } : name === "../shared/background" ? { agentPageOrder: [], listIncludingBackground: (_id, filter, list) => list(filter) } : { toAgent: value => value, toWorkspace: value => value } });
  const result = await module.exports.readWorkerRoster("CNS");
  assert.deepEqual(Array.from(result.agents, row => row.id), ["new", "archived"]);
  assert.equal(calls.every(call => call.filter.includeArchived === true), true);
  assert.equal(result.hasMore, false);
});
