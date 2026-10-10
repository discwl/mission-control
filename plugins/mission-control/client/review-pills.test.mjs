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
const loaded = { exports: {} };
new Function("require", "module", "exports", compiled)(specifier => {
  if (specifier === "../shared/review") return { getReviewCounts: "review.counts" };
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
  const registrations = [];
  const opened = [];
  const refreshes = [];
  t.mock.method(globalThis, "setInterval", callback => { poll = callback; return 1; });
  t.mock.method(globalThis, "clearInterval", () => {});
  const client = {
    paseo: { agents: {
      list: async () => ({ entries: agents.map(agent => ({ agent })) }),
      ref: agentId => ({ refresh: async () => {
        refreshes.push(agentId);
        if (refreshError) throw refreshError;
        const agent = agents.find(candidate => candidate.id === agentId);
        return agent ? { agent, project: null } : null;
      } }),
    } },
    rpc: async () => {
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
    registrations, opened, refreshes, stop,
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

test("an unavailable or inactive chat cannot navigate to its old workspace", async t => {
  const state = await harness(t, [agent("current-agent", "development-flow")], { "development-flow": count });
  const press = state.registrations[0].contribution.button.behavior.onPress;
  state.setAgents([]);
  await assert.rejects(press, /no longer has an active workspace/);
  for (const update of [
    { workspaceId: null }, { status: "closed" }, { archivedAt: "2026-09-29T00:00:00Z" },
  ]) {
    state.setAgents([{ ...agent("current-agent", "development-flow"), ...update }]);
    await assert.rejects(press, /no longer has an active workspace/);
  }
  assert.deepEqual(state.opened, []);
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
