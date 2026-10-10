import assert from "node:assert/strict";
import { test } from "node:test";
import { applyCollapseChanges, describeProjectSummary, projectCollapseKey, sameKeys, setProjectsCollapsed, summarizeProjectAgents } from "./project-summary.ts";

const agent = (overrides) => ({ workspaceId: "w1", provider: "claude", status: "idle", updatedAt: "2026-09-20T10:00:00.000Z", requiresAttention: false, attentionReason: null, ...overrides });

test("each agent counts once: errors, then needs-you, then running and idle", () => {
  const summary = summarizeProjectAgents([{ id: "w1", activityAt: null }, { id: "w2", activityAt: null }], [
    agent({ status: "running" }),
    agent({ status: "initializing", workspaceId: "w2" }),
    agent({ status: "idle" }),
    agent({ status: "running", requiresAttention: true, attentionReason: "permission" }),
    agent({ status: "error", requiresAttention: true, attentionReason: "error" }),
    agent({ status: "idle", requiresAttention: true, attentionReason: "error" }),
    agent({ status: "closed" }),
  ]);
  assert.deepEqual({ ...summary, providers: undefined, lastActivityAt: undefined }, { total: 7, running: 2, idle: 1, needsYou: 1, errored: 2, providers: undefined, lastActivityAt: undefined });
});

test("only agents in the given workspaces are counted and providers are unique", () => {
  const summary = summarizeProjectAgents([{ id: "w1", activityAt: null }], [
    agent({ provider: "claude" }), agent({ provider: "Claude" }), agent({ provider: "codex" }),
    agent({ workspaceId: "other", provider: "opencode" }), agent({ workspaceId: null, provider: "pi" }),
  ]);
  assert.equal(summary.total, 3);
  assert.deepEqual(summary.providers, ["claude", "codex"]);
});

test("last activity is the newest workspace activity or agent update", () => {
  const workspaces = [{ id: "w1", activityAt: "2026-09-21T08:00:00.000Z" }, { id: "w2", activityAt: null }];
  assert.equal(summarizeProjectAgents(workspaces, [agent({ updatedAt: "2026-09-20T08:00:00.000Z" })]).lastActivityAt, "2026-09-21T08:00:00.000Z");
  assert.equal(summarizeProjectAgents(workspaces, [agent({ workspaceId: "w2", updatedAt: "2026-09-22T08:00:00.000Z" })]).lastActivityAt, "2026-09-22T08:00:00.000Z");
  assert.equal(summarizeProjectAgents([{ id: "w3", activityAt: null }], []).lastActivityAt, null);
});

test("collapse keys separate hosts and survive separator characters", () => {
  assert.notEqual(projectCollapseKey("a:b", "c"), projectCollapseKey("a", "b:c"));
  assert.notEqual(projectCollapseKey("personal", "p1"), projectCollapseKey("globex", "p1"));
});

test("collapse and expand all only touch the given projects", () => {
  const other = projectCollapseKey("globex", "p9");
  const a = projectCollapseKey("personal", "a");
  const b = projectCollapseKey("personal", "b");
  const collapsed = setProjectsCollapsed([other], [a, b, a], true);
  assert.deepEqual(collapsed, [other, a, b]);
  assert.deepEqual(setProjectsCollapsed(collapsed, [a], true), [other, b, a]);
  assert.deepEqual(setProjectsCollapsed(collapsed, [a, b], false), [other]);
  assert.ok(sameKeys([a, b], [b, a]));
  assert.ok(!sameKeys([a], [b]));
});

test("changes made before settings load are replayed onto the stored list, not replacing it", () => {
  const stored = [projectCollapseKey("globex", "p9"), projectCollapseKey("personal", "a")];
  const b = projectCollapseKey("personal", "b");
  // While loading, the hook shows changes over an empty list.
  assert.deepEqual(applyCollapseChanges([], [{ id: 0, keys: [b], collapse: true }]), [b]);
  // Once ready, the same change keeps every stored entry it did not touch.
  assert.deepEqual(applyCollapseChanges(stored, [{ id: 0, keys: [b], collapse: true }]), [...stored, b]);
  assert.deepEqual(applyCollapseChanges(stored, [
    { id: 0, keys: [b], collapse: true },
    { id: 1, keys: [stored[1], b], collapse: false },
  ]), [stored[0]]);
  assert.deepEqual(applyCollapseChanges(stored, []), stored);
});

test("the spoken summary lists non-zero counts and providers", () => {
  const base = { total: 0, running: 0, idle: 0, needsYou: 0, errored: 0, providers: [], lastActivityAt: null };
  assert.equal(describeProjectSummary(base), "no agents");
  assert.equal(describeProjectSummary({ ...base, total: 4, running: 2, needsYou: 1, errored: 1, providers: ["claude", "codex"] }), "2 running, 1 need you, 1 errored, providers claude, codex");
  assert.equal(describeProjectSummary({ ...base, total: 2, providers: ["pi"] }), "2 closed, providers pi");
});
