import test from "node:test";
import assert from "node:assert/strict";
import { mergeHostOrder, moveVisibleHost } from "./host-order.ts";
import { formatDateTime } from "./date-time.ts";
import { performResourceAction } from "./resource-actions.ts";

test("reordering filtered hosts keeps hidden and temporarily absent hosts in place", () => {
  const saved = ["personal", "offline", "Globex", "not-paired-here", "Initech"];
  const order = mergeHostOrder(saved, ["personal", "Globex", "Initech", "new-host"]);
  assert.deepEqual(moveVisibleHost(order, ["personal", "Globex", "Initech"], "Initech", "personal"),
    ["Initech", "offline", "personal", "not-paired-here", "Globex", "new-host"]);
  assert.deepEqual(saved, ["personal", "offline", "Globex", "not-paired-here", "Initech"]);
});

test("reordering can move down, ignores stale targets, and appends new hosts once", () => {
  const order = mergeHostOrder(["Globex", "Globex", "personal"], ["personal", "Globex", "new", "new"]);
  assert.deepEqual(order, ["Globex", "personal", "new"]);
  assert.deepEqual(moveVisibleHost(order, order, "Globex", "new"), ["personal", "new", "Globex"]);
  assert.deepEqual(moveVisibleHost(order, order, "Globex", "gone"), order);
});

test("timestamps have padded dates, short years and no seconds in local time", () => {
  assert.equal(formatDateTime(new Date(2026, 8, 10, 13, 5, 59).toISOString()), "09/10/26, 1:05 PM");
  assert.equal(formatDateTime("unavailable"), "unavailable");
});

const target = { kind: "workspace", id: "workspace-a", serverId: "host-a", hostLabel: "Personal", name: "Test workspace" };
function api(result) {
  const calls = [];
  return { calls, workspaces: { ref: id => ({ archive: async () => { calls.push(["workspace", id]); return result; } }) },
    agents: { ref: id => ({ archive: async () => { calls.push(["agent", id]); return { archivedAt: "now" }; } }) },
    terminals: { ref: id => ({ kill: async () => { calls.push(["terminal", id]); } }) } };
}

test("workspace archive reports resolved SDK errors and missing confirmation", async () => {
  await assert.rejects(performResourceAction(api({ error: "Uncommitted changes", archivedAt: null }), target), /Uncommitted changes/);
  await assert.rejects(performResourceAction(api({ error: null, archivedAt: null }), target), /did not confirm/);
  await assert.rejects(performResourceAction(api({ error: "Cleanup failed", archivedAt: "now" }), target), /Cleanup failed/);
});

test("each action uses the selected resource ID and only its matching API", async () => {
  const client = api({ error: null, archivedAt: "now" });
  await performResourceAction(client, target);
  await performResourceAction(client, { ...target, kind: "agent", id: "agent-b" });
  await performResourceAction(client, { ...target, kind: "terminal", id: "terminal-c" });
  assert.deepEqual(client.calls, [["workspace", "workspace-a"], ["agent", "agent-b"], ["terminal", "terminal-c"]]);
});

test("terminal and agent failures propagate without a false success", async () => {
  const client = api({});
  client.terminals.ref = () => ({ kill: async () => { throw new Error("Host offline"); } });
  client.agents.ref = () => ({ archive: async () => ({ archivedAt: null }) });
  await assert.rejects(performResourceAction(client, { ...target, kind: "terminal" }), /Host offline/);
  await assert.rejects(performResourceAction(client, { ...target, kind: "agent" }), /did not confirm/);
});
