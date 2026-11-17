import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const require = createRequire(import.meta.url);
const ts = require("typescript");
const source = readFileSync(new URL("./review-pills.ts", import.meta.url), "utf8");
const compiled = ts.transpileModule(source, {
  fileName: fileURLToPath(new URL("./review-pills.ts", import.meta.url)),
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText;
const background = { exports: {} };
new Function("require", "module", "exports", ts.transpileModule(readFileSync(new URL("../shared/background.ts", import.meta.url), "utf8"), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText)(require, background, background.exports);
const loaded = { exports: {} };
new Function("require", "module", "exports", compiled)(specifier => {
  if (specifier === "../shared/review") return { getReviewCounts: "review.counts" };
  if (specifier === "../shared/background") return background.exports;
  if (specifier === "./panel-ids") return { agentReviewPanelId: "agent-review", reviewPanelId: "workspace-review" };
  throw new Error(`Unexpected import: ${specifier}`);
}, loaded, loaded.exports);
const { startReviewPills } = loaded.exports;
const flush = () => new Promise(resolve => setImmediate(resolve));

async function harness(t, initialAgents, initialCounts, initialPending = [], orchestrators = undefined) {
  let agents = initialAgents;
  let counts = initialCounts;
  let pending = initialPending;
  let poll;
  let refreshError = null;
  let pageSize = Infinity;
  let observer = null;
  let released = false;
  const registrations = [];
  const opened = [];
  const refreshes = [];
  const countRequests = [];
  const listCalls = [];
  t.mock.method(globalThis, "setInterval", callback => { poll = callback; return 1; });
  t.mock.method(globalThis, "clearInterval", () => {});
  const client = {
    paseo: { agents: {
      list: async (options = {}) => {
        if (options.subscribe) return { entries: [], subscription: { subscribe(next) { observer = next; return () => { observer = null; }; }, release: async () => { released = true; } } };
        listCalls.push(options);
        const start = options.page?.cursor ? Number(options.page.cursor) : 0;
        const end = Math.min(agents.length, start + pageSize);
        return { entries: agents.slice(start, end).map(agent => ({ agent })), pageInfo: { hasMore: end < agents.length, nextCursor: end < agents.length ? String(end) : null } };
      },
      ref: agentId => ({ refresh: async () => {
        refreshes.push(agentId);
        if (refreshError) throw refreshError;
        const agent = agents.find(candidate => candidate.id === agentId);
        return agent ? { agent, project: null } : null;
      } }),
    } },
    rpc: async (_method, input) => {
      countRequests.push(input.workspaceIds);
      if (counts instanceof Error) throw counts;
      return { counts: await counts, pending };
    },
    addComposerPill: contribution => {
      const registration = { contribution, removed: false, patches: [] };
      registrations.push(registration);
      return {
        update(patch) { registration.patches.push(patch); Object.assign(contribution.button, patch); },
        remove() { registration.removed = true; },
      };
    },
    openPanel: (panelId, target) => opened.push({ panelId, ...target }),
  };
  const stop = startReviewPills(client, undefined, orchestrators);
  t.after(stop);
  await flush();
  for (const registration of registrations) {
    assert.equal(registration.contribution.button.behavior.kind, "action");
    assert.equal("Content" in registration.contribution.button.behavior, false);
  }
  assert.deepEqual(opened, [], "registering a pill must never navigate");
  return {
    registrations, opened, refreshes, stop, countRequests, listCalls,
    get observer() { return observer; },
    get released() { return released; },
    setPageSize(next) { pageSize = next; },
    setAgents(next) { agents = next; },
    setCounts(next) { counts = next; },
    setPending(next) { pending = next; },
    setRefreshError(error) { refreshError = error; },
    async sync() { poll(); await flush(); },
  };
}

const agent = (id, workspaceId) => Object.freeze({ id, workspaceId, status: "idle", archivedAt: null });
const count = { files: 2, toReview: 2 };

test("Review pills keep different chats and projects isolated", async t => {
  const state = await harness(t, [agent("development-agent", "development-flow"), agent("transcribe-agent", "transcribe")], {
    "development-flow": count, transcribe: count,
  });
  for (const registration of state.registrations) await registration.contribution.button.behavior.onPress();
  assert.deepEqual(state.opened, [
    { panelId: "agent-review", workspaceId: "development-flow", agentId: "development-agent", location: "workspace" },
    { panelId: "agent-review", workspaceId: "transcribe", agentId: "transcribe-agent", location: "workspace" },
  ]);
});

test("switching away or closing Review stays put through badge updates and polling", async t => {
  const state = await harness(t, [agent("current-agent", "development-flow")], { "development-flow": count });
  const press = state.registrations[0].contribution.button.behavior.onPress;
  await press();
  assert.equal(state.opened.length, 1, "one press opens the workspace tab directly");

  // Neither a tab switch nor closing Review dispatches another pill press.
  // The background updates that follow must not reassert navigation.
  state.setCounts({ "development-flow": { files: 2, toReview: 0 } });
  await state.sync();
  await state.sync();
  assert.equal(state.opened.length, 1);
  assert.equal(state.registrations.length, 1);
  assert.equal(state.registrations[0].contribution.button.behavior.onPress, press);

  await press();
  assert.equal(state.opened.length, 2, "a deliberate later press can reopen Review");
  assert.equal(state.opened[1].location, "workspace");
});

test("moving an agent re-registers its pill even when counts and labels do not change", async t => {
  const state = await harness(t, [agent("current-agent", "transcribe")], { transcribe: count, "development-flow": count });
  state.setAgents([agent("current-agent", "development-flow")]);
  await state.sync();
  assert.equal(state.registrations[0].removed, true);
  assert.equal(state.registrations[1].contribution.workspaceId, "development-flow");
  await state.registrations[1].contribution.button.behavior.onPress();
  assert.equal(state.opened[0].workspaceId, "development-flow");
});

test("a move between polls resolves the agent's current workspace before navigation", async t => {
  const state = await harness(t, [agent("current-agent", "transcribe")], { transcribe: count });
  state.setAgents([agent("current-agent", "development-flow")]);
  await state.registrations[0].contribution.button.behavior.onPress();
  assert.deepEqual(state.opened, [
    { panelId: "agent-review", workspaceId: "development-flow", agentId: "current-agent", location: "workspace" },
  ]);
  assert.deepEqual(state.refreshes, ["current-agent"]);
});

test("a label refresh preserves the same chat target and registration", async t => {
  const state = await harness(t, [agent("current-agent", "development-flow")], { "development-flow": count });
  state.setCounts({ "development-flow": { files: 2, toReview: 0 } });
  await state.sync();
  assert.equal(state.registrations.length, 1);
  assert.equal(state.registrations[0].contribution.button.label, "Review · ✓ 2 reviewed");
  await state.registrations[0].contribution.button.behavior.onPress();
  assert.equal(state.opened[0].agentId, "current-agent");
});

test("an unavailable, archived or unplaced chat cannot navigate to its old workspace", async t => {
  const state = await harness(t, [agent("current-agent", "development-flow")], { "development-flow": count });
  const press = state.registrations[0].contribution.button.behavior.onPress;
  state.setAgents([]);
  await assert.rejects(press, /no longer has an active workspace/);
  for (const update of [
    { workspaceId: null }, { archivedAt: "2026-09-29T00:00:00Z" },
  ]) {
    state.setAgents([{ ...agent("current-agent", "development-flow"), ...update }]);
    await assert.rejects(press, /no longer has an active workspace/);
  }
  assert.deepEqual(state.opened, []);
});

const hoursAgo = hours => new Date(Date.now() - hours * 3_600_000).toISOString();
const resting = (id, workspaceId, updatedAt) => Object.freeze({ id, workspaceId, status: "closed", archivedAt: null, updatedAt });

test("a chat Paseo released after an idle hour keeps its Review bubble, and pressing it opens Review", async t => {
  const state = await harness(t, [resting("resting", "development-flow", hoursAgo(2))], { "development-flow": count });
  assert.equal(state.registrations.length, 1);
  assert.equal(state.registrations[0].contribution.agentId, "resting");
  assert.equal(state.registrations[0].contribution.button.label, "Review · 2 to review");
  await state.registrations[0].contribution.button.behavior.onPress();
  assert.deepEqual(state.opened, [{ panelId: "agent-review", workspaceId: "development-flow", agentId: "resting", location: "workspace" }]);
});

test("a chat resting for over a day shows plain Review and its workspace isn't counted", async t => {
  const state = await harness(t, [resting("old", "old-ws", hoursAgo(30)), resting("recent", "recent-ws", hoursAgo(3)), agent("open", "open-ws")], {
    "old-ws": count, "recent-ws": count, "open-ws": count,
  });
  assert.deepEqual([...state.countRequests[0]].sort(), ["open-ws", "recent-ws"]);
  const label = id => state.registrations.find(registration => registration.contribution.agentId === id).contribution.button.label;
  assert.equal(label("old"), "Review");
  assert.equal(label("recent"), "Review · 2 to review");
  assert.equal(label("open"), "Review · 2 to review");
  await state.registrations.find(registration => registration.contribution.agentId === "old").contribution.button.behavior.onPress();
  assert.equal(state.opened[0].workspaceId, "old-ws");
});

test("a chat resting for over 14 days has no bubble, and gets it back within a moment when a message wakes it", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const old = resting("old", "old-ws", hoursAgo(15 * 24));
  const state = await harness(t, [old, resting("recent", "recent-ws", hoursAgo(13 * 24))], {});
  assert.deepEqual(state.registrations.map(registration => registration.contribution.agentId), ["recent"]);
  // Another update of the old chat while it still rests changes nothing.
  state.observer.update({ type: "agent_update", payload: { kind: "upsert", agent: old } });
  t.mock.timers.tick(1_000); await flush(); await flush();
  const lists = state.listCalls.length;
  assert.equal(state.registrations.length, 1);
  // A message wakes it: its status changes, and that alone is reason to list again.
  const woken = { ...old, status: "running", updatedAt: new Date().toISOString() };
  state.setAgents([woken, resting("recent", "recent-ws", hoursAgo(13 * 24))]);
  state.observer.update({ type: "agent_update", payload: { kind: "upsert", agent: woken } });
  t.mock.timers.tick(1_000); await flush(); await flush();
  assert.equal(state.listCalls.length, lists + 1);
  assert.deepEqual(state.registrations.map(registration => registration.contribution.agentId), ["recent", "old"]);
});

test("at most 300 bubbles, for the most recently updated chats", async t => {
  const minutesAgo = minutes => new Date(Date.now() - minutes * 60_000).toISOString();
  const many = Array.from({ length: 305 }, (_, index) => ({ ...agent(`agent-${index}`, `ws-${index}`), updatedAt: minutesAgo(index) }));
  const state = await harness(t, many.slice().reverse(), {});
  const ids = state.registrations.map(registration => registration.contribution.agentId);
  assert.equal(ids.length, 300);
  assert.ok(ids.includes("agent-0") && ids.includes("agent-299"));
  assert.ok(!ids.includes("agent-300") && !ids.includes("agent-304"), "the oldest are left out");
});

test("a chat that stops being counted drops its last count", async t => {
  const state = await harness(t, [agent("a", "w")], { w: count });
  assert.equal(state.registrations[0].contribution.button.label, "Review · 2 to review");
  state.setAgents([resting("a", "w", hoursAgo(25))]);
  await state.sync();
  assert.equal(state.registrations.length, 1);
  assert.equal(state.registrations[0].contribution.button.label, "Review");
});

test("chats past the first page of the agent list get bubbles too", async t => {
  const many = Array.from({ length: 5 }, (_, index) => agent(`agent-${index}`, `ws-${index}`));
  const state = await harness(t, [], {});
  state.setPageSize(2);
  state.setAgents(many);
  await state.sync();
  assert.deepEqual(state.registrations.map(registration => registration.contribution.agentId), many.map(item => item.id));
  assert.deepEqual(state.listCalls.slice(-3).map(call => call.page.cursor ?? null), [null, "2", "4"]);
  assert.deepEqual(state.listCalls.at(-1).sort, [{ key: "created_at", direction: "desc" }]);
});

test("a new chat gets its bubble from the agent list subscription, without waiting for the poll", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const state = await harness(t, [agent("a", "w")], { w: count, other: count });
  assert.ok(state.observer, "the pills follow the agent list");
  state.observer.snapshot({});
  const fresh = agent("b", "other");
  state.setAgents([agent("a", "w"), fresh]);
  // A status change of a listed chat isn't a reason to list again.
  state.observer.update({ type: "agent_update", payload: { kind: "upsert", agent: { ...agent("a", "w"), status: "running" } } });
  t.mock.timers.tick(1_000);
  await flush(); await flush();
  assert.equal(state.registrations.length, 1);
  const lists = state.listCalls.length;
  state.observer.update({ type: "agent_update", payload: { kind: "upsert", agent: fresh } });
  state.observer.update({ type: "agent_update", payload: { kind: "upsert", agent: fresh } });
  t.mock.timers.tick(1_000);
  await flush(); await flush();
  assert.equal(state.listCalls.length, lists + 1, "changes close together share one list");
  assert.deepEqual(state.registrations.map(registration => registration.contribution.agentId), ["a", "b"]);

  state.setAgents([agent("a", "w")]);
  state.observer.update({ type: "agent_update", payload: { kind: "remove", agentId: "b" } });
  t.mock.timers.tick(1_000);
  await flush(); await flush();
  assert.equal(state.registrations[1].removed, true);
  state.stop();
  assert.equal(state.released, true);
});

test("a failed refresh reports the error without falling back to the registered workspace", async t => {
  const state = await harness(t, [agent("current-agent", "development-flow")], { "development-flow": count });
  state.setRefreshError(new Error("Host disconnected"));
  await assert.rejects(state.registrations[0].contribution.button.behavior.onPress, /Host disconnected/);
  assert.deepEqual(state.opened, []);
});

test("a first count request can stay pending while Review opens the workspace tab", async t => {
  let resolve;
  const h = await harness(t, [agent("a", "w")], new Promise(done => { resolve = done; }));
  assert.equal(h.registrations.length, 1);
  assert.equal(h.registrations[0].contribution.button.label, "Review");
  await h.registrations[0].contribution.button.behavior.onPress();
  assert.equal(h.opened[0].workspaceId, "w");
  assert.equal(h.opened[0].location, "workspace");
  resolve({ w: count });
  await flush();
  assert.equal(h.registrations[0].contribution.button.label, "Review · 2 to review");
  assert.equal(h.opened.length, 1, "count completion must not navigate");
});

test("a workspace whose first scan is still running shows counting, then its count", async t => {
  const h = await harness(t, [agent("a", "w")], {}, ["w"]);
  const button = h.registrations[0].contribution.button;
  assert.equal(button.label, "Review · counting…");
  h.setPending([]);
  h.setCounts({ w: count });
  await h.sync();
  assert.equal(button.label, "Review · 2 to review");
  assert.equal(h.registrations.length, 1);
});

test("failed and missing counts keep Review available, then recover in the same registration", async t => {
  const h = await harness(t, [agent("a", "w")], new Error("counts unavailable"));
  const registration = h.registrations[0];
  assert.equal(registration.contribution.button.label, "Review · unavailable");
  await registration.contribution.button.behavior.onPress();
  assert.equal(h.opened[0].location, "workspace");
  h.setCounts({ w: null });
  await h.sync();
  assert.equal(registration.contribution.button.label, "Review");
  assert.equal(registration.removed, false);
  h.setCounts({ w: count });
  await h.sync();
  assert.equal(registration.contribution.button.label, "Review · 2 to review");
  assert.equal(h.registrations.length, 1);
});

test("pending counts do not block new chats or moves, and cannot update replacement pills", async t => {
  let resolve;
  const h = await harness(t, [agent("a", "old")], new Promise(done => { resolve = done; }));
  const original = h.registrations[0];
  h.setAgents([agent("a", "new"), agent("b", "other")]);
  await h.sync();
  assert.equal(original.removed, true);
  assert.equal(h.registrations.length, 3);
  assert.equal(h.registrations[1].contribution.workspaceId, "new");
  assert.equal(h.registrations[2].contribution.agentId, "b");
  resolve({ old: count, new: { files: 99, toReview: 99 } });
  await flush();
  assert.equal(h.registrations[1].contribution.button.label, "Review");
  assert.deepEqual(h.registrations[1].patches, []);
  h.setCounts({ new: count, other: count });
  await h.sync();
  assert.equal(h.registrations[1].contribution.button.label, "Review · 2 to review");
});

test("count completion after disposal cannot update or recreate Review", async t => {
  let resolve;
  const h = await harness(t, [agent("a", "w")], new Promise(done => { resolve = done; }));
  const registration = h.registrations[0];
  h.stop();
  resolve({ w: count });
  await flush();
  assert.equal(registration.removed, true);
  assert.deepEqual(registration.patches, []);
  assert.equal(h.registrations.length, 1);
  assert.deepEqual(h.opened, []);
});

test("removing or disposing the plugin removes stale pills and prevents navigation", async t => {
  const state = await harness(t, [agent("current-agent", "development-flow")], { "development-flow": count });
  const press = state.registrations[0].contribution.button.behavior.onPress;
  state.setAgents([]);
  await state.sync();
  assert.equal(state.registrations[0].removed, true);
  state.stop();
  await press();
  assert.deepEqual(state.opened, []);
});

test("orchestrator chats get the host's bubbles instead of a Review pill for their own folder", async t => {
  let hostViews = new Set(["orchestrator"]);
  const asked = [];
  const state = await harness(t, [agent("acme-orchestrator", "orchestrator"), agent("developer", "development-flow")], { "development-flow": count }, [],
    async workspaceIds => { asked.push(workspaceIds); return hostViews; });
  assert.deepEqual(asked[0], ["orchestrator", "development-flow"]);
  assert.deepEqual(state.registrations.map(registration => registration.contribution.workspaceId), ["development-flow"]);

  hostViews = new Set();
  await state.sync();
  assert.deepEqual(state.registrations.filter(registration => !registration.removed).map(registration => registration.contribution.workspaceId), ["development-flow", "orchestrator"]);

  hostViews = new Set(["orchestrator"]);
  await state.sync();
  assert.equal(state.registrations.find(registration => registration.contribution.workspaceId === "orchestrator").removed, true);
});

test("a failed orchestrator lookup leaves every chat its Review pill", async t => {
  const state = await harness(t, [agent("acme-orchestrator", "orchestrator")], {}, [], async () => { throw new Error("plugin restarting"); });
  assert.deepEqual(state.registrations.map(registration => registration.contribution.workspaceId), ["orchestrator"]);
});
