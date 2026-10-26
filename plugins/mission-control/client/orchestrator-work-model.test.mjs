import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { test } from "node:test";
const require = createRequire(import.meta.url);
const ts = require("typescript");
require.extensions[".ts"] = (module, file) => module._compile(ts.transpileModule(readFileSync(file, "utf8"), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText, file);
const { agentActivityAt, linkedWorkers, scopedReviews } = require("./orchestrator-work-model.ts");
const { hostReviewItems } = require("./host-review-model.ts");
const at = hour => `2026-10-23T${hour}:00:00Z`;
const agent = (id, workspaceId, extra = {}) => ({ id, workspaceId, status: "idle", archivedAt: null, parentAgentId: null, updatedAt: at("20"), lastUserMessageAt: null, activeTurnStartedAt: null, attentionTimestamp: null, ...extra });
const link = (id, workspaceId) => ({ serverId: "local", agentId: "chat", remoteServerId: "remote", remoteAgentId: id, remoteWorkspaceId: workspaceId, taskId: null, linkedAt: at("10") });
const work = id => ({ id, labels: ["Review"], activityAt: at("23") });

test("activity excludes metadata updates and rejects invalid timestamps", () => {
  assert.equal(agentActivityAt(agent("a", "w")), null);
  assert.equal(agentActivityAt(agent("a", "w", { lastUserMessageAt: at("10"), activeTurnStartedAt: at("11"), attentionTimestamp: "invalid" })), at("11"));
});
test("only explicit workers and descendants belong to a chat, even in shared workspaces", () => {
  const agents = [agent("root", "w"), agent("child", "w", { parentAgentId: "root" }), agent("unrelated", "w"), agent("cycle1", "x", { parentAgentId: "cycle2" }), agent("cycle2", "x", { parentAgentId: "cycle1" })];
  const links = [link("root", "w")];
  assert.deepEqual([...linkedWorkers(agents, links)], ["root", "child"]);
  const result = scopedReviews(hostReviewItems([work("w"), work("x")], agents).ready, agents, links, true, "activity");
  assert.deepEqual(result.map(item => item.workspace.id), ["w"]);
  assert.deepEqual(result[0].agents.map(a => a.id).sort(), ["child", "root"]);
});
test("a moved worker follows its current workspace; a missing worker retains its recorded workspace", () => {
  const agents = [agent("moved", "new")];
  const items = hostReviewItems([work("old"), work("new"), work("finished")], agents).ready;
  assert.deepEqual(scopedReviews(items, agents, [link("moved", "old"), link("gone", "finished")], true, "activity").map(item => item.workspace.id), ["finished", "new"]);
});
test("recency uses scoped agents, with separate activity and metadata sorting and stable ties", () => {
  const agents = [agent("a", "a", { lastUserMessageAt: at("10"), updatedAt: at("22") }), agent("b", "b", { lastUserMessageAt: at("12"), updatedAt: at("13") }), agent("other", "a", { lastUserMessageAt: at("23") })];
  const items = hostReviewItems([work("a"), work("b")], agents).ready;
  const links = [link("a", "a"), link("b", "b")];
  assert.deepEqual(scopedReviews(items, agents, links, true, "activity").map(item => item.workspace.id), ["b", "a"]);
  assert.deepEqual(scopedReviews(items, agents, links, true, "updated").map(item => item.workspace.id), ["a", "b"]);
  assert.equal(scopedReviews(items, agents, [], true, "activity").length, 0);
  assert.equal(scopedReviews(items, agents, [], false, "activity").length, 2);
});
test("an unrelated running worker still prevents a shared changed workspace being called stopped", () => {
  const agents = [agent("mine", "w"), agent("other", "w", { status: "running" })];
  assert.equal(hostReviewItems([{ id: "w", labels: [], dirty: true }], agents).changed.length, 0);
});
