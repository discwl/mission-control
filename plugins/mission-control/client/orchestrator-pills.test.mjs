import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { test } from "node:test";

const require = createRequire(import.meta.url);
const ts = require("typescript");
require.extensions[".ts"] = (module, file) => module._compile(ts.transpileModule(readFileSync(file, "utf8"), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText, file);
require.extensions[".tsx"] = module => { module.exports = { createOrchestratorDialogIcon: (binding, initial, openDestination) => props => ({ binding, initial, openDestination, props }) }; };
const { startOrchestratorPills } = require("./orchestrator-pills.ts");
const { createBindingLookup } = require("./orchestrator-bindings.ts");
const { takeHostDialogRequest, takeHostReviewRequest, takeHostDestination } = require("./host-review-request.ts");
const { orchestratorDialogKey, isOrchestratorDialogOpen, setOrchestratorDialogOpen } = require("./orchestrator-dialog-request.ts");
const turn = () => new Promise(resolve => setImmediate(resolve));

async function fixture(t) {
  let tick;
  t.mock.method(globalThis, "setInterval", callback => { tick = callback; return 1; });
  t.mock.method(globalThis, "clearInterval", () => {});
  let clock = 0;
  const state = {
    agents: [
      { id: "orch", workspaceId: "orch-ws", status: "idle", archivedAt: null },
      { id: "dev", workspaceId: "dev-ws", status: "running", archivedAt: null },
    ],
    bindings: { "orch-ws": { label: "Acme", serverId: "srv_acme" } },
    host: {
      workspaces: [
        { id: "r1", name: "r1", projectName: "web", labels: ["Review"], activityAt: null, diffStat: null },
        { id: "c1", name: "c1", projectName: "web", labels: [], activityAt: null, dirty: true },
      ],
      agents: [
        // Finished and unread: Paseo flags it, but nothing blocks it.
        { id: "x", workspaceId: "r1", status: "idle", updatedAt: "2026-10-07T00:00:00Z", archivedAt: null, requiresAttention: true, attentionReason: "finished", permissions: [] },
        { id: "w", workspaceId: "c1", status: "running", updatedAt: "2026-10-07T00:00:00Z", archivedAt: null, requiresAttention: true, attentionReason: "permission", permissions: [{ id: "perm-1" }] },
      ],
    },
    attention: { questions: [], openDecisions: 2 },
    hostFails: false,
    attentionFails: false,
  };
  const pills = new Map(), opens = [], hostReads = [];
  const client = {
    paseo: { agents: { list: async () => ({ entries: state.agents.map(agent => ({ agent })) }) } },
    addComposerPill: contribution => {
      const pill = { contribution, label: contribution.button.label, removed: false };
      pills.set(contribution.id, pill);
      return { update: patch => { if (patch.label) pill.label = patch.label; }, remove: () => { pill.removed = true; pills.delete(contribution.id); } };
    },
    openPanel: (...args) => opens.push(args),
  };
  const lookUp = async ids => new Map(ids.flatMap(id => state.bindings[id] ? [[id, state.bindings[id]]] : []));
  const readHost = async serverId => { hostReads.push(serverId); if (state.hostFails) throw new Error("relay down"); return state.host; };
  const readAttention = async () => { if (state.attentionFails) throw new Error("no copy"); return state.attention; };
  const stop = startOrchestratorPills(client, { lookUp, readHost, readAttention, now: () => clock });
  t.after(stop);
  await turn(); await turn();
  return { state, pills, opens, hostReads, stop, advance: ms => { clock += ms; }, tick: async () => { await tick(); await turn(); await turn(); } };
}

test("an orchestrator chat gets the host's Agents, Review and Attention bubbles with its counts", async t => {
  const f = await fixture(t);
  assert.deepEqual([...f.pills.keys()].sort(), ["host-agents-orch", "host-attention-orch", "host-review-orch"]);
  assert.equal(f.pills.get("host-agents-orch").label, "Acme agents · 1 running");
  // One permission prompt and two open decisions; the finished agent doesn't count.
  assert.equal(f.pills.get("host-attention-orch").label, "Attention · 3");
  assert.equal(f.pills.get("host-attention-orch").contribution.button.icon({}).initial, "attention");
  assert.equal(f.pills.get("host-review-orch").label, "Review");
  assert.equal(f.pills.get("host-review-orch").contribution.workspaceId, "orch-ws");
  assert.deepEqual(f.hostReads, ["srv_acme"]);
});

test("Attention and Review open in the chat; only Agents or an explicit destination opens a panel", async t => {
  const f = await fixture(t);
  for (const kind of ["review", "attention"]) {
    const behavior = f.pills.get(`host-${kind}-orch`).contribution.button.behavior;
    assert.equal(behavior.kind, "action");
    behavior.onPress();
    const key = orchestratorDialogKey("orch-ws", "orch", "srv_acme", kind);
    assert.equal(isOrchestratorDialogOpen(key), true);
    assert.equal(isOrchestratorDialogOpen(orchestratorDialogKey("orch-ws", "another-chat", "srv_acme", kind)), false);
    setOrchestratorDialogOpen(key, false);
    const content = f.pills.get(`host-${kind}-orch`).contribution.button.icon({ context: "agent", workspaceId: "orch-ws", agentId: "orch" });
    assert.equal(content.initial, kind);
    assert.equal(content.binding.serverId, "srv_acme");
    assert.equal(f.opens.length, 0);
    assert.equal(takeHostDialogRequest("orch-ws"), null);
  }
  const content = f.pills.get("host-review-orch").contribution.button.icon({});
  content.openDestination("orch-ws", "srv_acme", "agent", "worker");
  assert.deepEqual(f.opens.at(-1), ["host-agents", { workspaceId: "orch-ws", location: "workspace" }]);
  assert.deepEqual(takeHostDestination("orch-ws", "srv_acme"), { serverId: "srv_acme", kind: "agent", id: "worker" });
  assert.equal(takeHostDestination("orch-ws", "srv_acme"), null);
  f.pills.get("host-agents-orch").contribution.button.behavior.onPress();
  assert.equal(f.opens.length, 2);
});

test("the Attention bubble shows only while something waits, and counts prompts when Mission Control can't be asked", async t => {
  const f = await fixture(t);
  f.advance(60_000); f.state.attention = { questions: [], openDecisions: 0 }; f.state.host.agents[1].permissions = [];
  await f.tick();
  assert.equal(f.pills.has("host-attention-orch"), false);
  f.advance(60_000); f.state.attentionFails = true; f.state.host.agents[1].permissions = [{ id: "perm-2" }, { id: "perm-3" }];
  await f.tick();
  assert.equal(f.pills.get("host-attention-orch").label, "Attention · 2");
  f.advance(60_000); f.state.attentionFails = false; f.state.attention = { questions: [], openDecisions: 1 };
  await f.tick();
  assert.equal(f.pills.get("host-attention-orch").label, "Attention · 3");
});

test("the host is read at most once a minute, and an unreachable host keeps its last counts", async t => {
  const f = await fixture(t);
  await f.tick();
  assert.equal(f.hostReads.length, 1);
  f.advance(60_000); f.state.hostFails = true;
  await f.tick();
  assert.equal(f.hostReads.length, 2);
  assert.equal(f.pills.get("host-review-orch").label, "Review");
  f.state.hostFails = false; f.state.host = { workspaces: [], agents: [] };
  await f.tick();
  assert.equal(f.pills.get("host-review-orch").label, "Review");
  assert.equal(f.pills.get("host-agents-orch").label, "Acme agents");
  assert.equal(f.pills.get("host-attention-orch").label, "Attention · 2", "the open decisions still wait");
});

test("bubbles go when the chat closes or the folder stops naming a host, and on disposal", async t => {
  const f = await fixture(t);
  f.state.bindings = {};
  await f.tick();
  assert.equal(f.pills.size, 0);
  f.state.bindings = { "orch-ws": { label: "Acme", serverId: "srv_acme" } };
  await f.tick();
  assert.equal(f.pills.size, 3);
  f.state.agents[0].status = "closed";
  await f.tick();
  assert.equal(f.pills.size, 0);
  f.state.agents[0].status = "idle";
  await f.tick();
  f.stop();
  assert.equal(f.pills.size, 0);
});

test("registration removal clears dialog state, while stale clicks cannot reopen it", async t => {
  const f = await fixture(t);
  const attentionKey = orchestratorDialogKey("orch-ws", "orch", "srv_acme", "attention");
  const reviewKey = orchestratorDialogKey("orch-ws", "orch", "srv_acme", "review");
  const clickReview = f.pills.get("host-review-orch").contribution.button.behavior.onPress;
  f.pills.get("host-attention-orch").contribution.button.behavior.onPress();
  assert.equal(isOrchestratorDialogOpen(attentionKey), true);
  f.advance(60_000); f.state.attention = { questions: [], openDecisions: 0 }; f.state.host.agents[1].permissions = [];
  await f.tick();
  assert.equal(f.pills.has("host-attention-orch"), false);
  assert.equal(isOrchestratorDialogOpen(attentionKey), false);
  clickReview();
  assert.equal(isOrchestratorDialogOpen(reviewKey), true);
  f.stop();
  assert.equal(isOrchestratorDialogOpen(reviewKey), false);
  clickReview();
  assert.equal(isOrchestratorDialogOpen(reviewKey), false);
});

test("binding lookups are cached for a minute and keep the last answer when a read fails", async () => {
  let clock = 0, calls = 0, fail = false;
  const client = { rpc: async (contract, input) => {
    calls++;
    assert.equal(contract.name, "orchestrator.bindings");
    if (fail) throw new Error("plugin restarting");
    return { bindings: Object.fromEntries(input.workspaceIds.filter(id => id === "orch").map(id => [id, { label: "Acme", serverId: "srv_acme" }])), problems: {} };
  } };
  const lookUp = createBindingLookup(client, { now: () => clock });
  assert.deepEqual([...(await lookUp(["orch", "dev"])).keys()], ["orch"]);
  await lookUp(["orch", "dev"]);
  assert.equal(calls, 1);
  clock = 60_000; fail = true;
  assert.deepEqual([...(await lookUp(["orch", "new"])).keys()], ["orch"]);
  assert.equal(calls, 2);
});
