import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { test } from "node:test";

const require = createRequire(import.meta.url);
const ts = require("typescript");
require.extensions[".ts"] = (module, file) => module._compile(ts.transpileModule(readFileSync(file, "utf8"), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText, file);
const { startOrchestratorPills } = require("./orchestrator-pills.ts");
const { createBindingLookup } = require("./orchestrator-bindings.ts");
const { takeHostReviewRequest } = require("./host-review-request.ts");
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
        { id: "r1", labels: ["Review"], activityAt: null, diffStat: null },
        { id: "c1", labels: [], activityAt: null, dirty: true },
      ],
      agents: [{ id: "x", workspaceId: "r1", status: "idle", updatedAt: "2026-10-07T00:00:00Z", archivedAt: null, requiresAttention: true }],
    },
    hostFails: false,
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
  const stop = startOrchestratorPills(client, { lookUp, readHost, now: () => clock });
  t.after(stop);
  await turn(); await turn();
  return { state, pills, opens, hostReads, stop, advance: ms => { clock += ms; }, tick: async () => { await tick(); await turn(); await turn(); } };
}

test("an orchestrator chat gets the host's Agents and Review bubbles with its counts", async t => {
  const f = await fixture(t);
  assert.deepEqual([...f.pills.keys()].sort(), ["host-agents-orch", "host-review-orch"]);
  assert.equal(f.pills.get("host-agents-orch").label, "Acme agents · 1 needs you");
  assert.equal(f.pills.get("host-review-orch").label, "Review · 1 ready");
  assert.equal(f.pills.get("host-review-orch").contribution.workspaceId, "orch-ws");
  assert.deepEqual(f.hostReads, ["srv_acme"]);
});

test("Agents opens the Host agents tab; Review also asks it for the review list", async t => {
  const f = await fixture(t);
  f.pills.get("host-agents-orch").contribution.button.behavior.onPress();
  assert.deepEqual(f.opens.at(-1), ["host-agents", { workspaceId: "orch-ws", location: "workspace" }]);
  assert.equal(takeHostReviewRequest("orch-ws"), false);
  f.pills.get("host-review-orch").contribution.button.behavior.onPress();
  assert.deepEqual(f.opens.at(-1), ["host-agents", { workspaceId: "orch-ws", location: "workspace" }]);
  assert.equal(takeHostReviewRequest("orch-ws"), true);
  assert.equal(takeHostReviewRequest("orch-ws"), false);
});

test("the host is read at most once a minute, and an unreachable host keeps its last counts", async t => {
  const f = await fixture(t);
  await f.tick();
  assert.equal(f.hostReads.length, 1);
  f.advance(60_000); f.state.hostFails = true;
  await f.tick();
  assert.equal(f.hostReads.length, 2);
  assert.equal(f.pills.get("host-review-orch").label, "Review · 1 ready");
  f.state.hostFails = false; f.state.host = { workspaces: [], agents: [] };
  await f.tick();
  assert.equal(f.pills.get("host-review-orch").label, "Review");
  assert.equal(f.pills.get("host-agents-orch").label, "Acme agents");
});

test("bubbles go when the chat closes or the folder stops naming a host, and on disposal", async t => {
  const f = await fixture(t);
  f.state.bindings = {};
  await f.tick();
  assert.equal(f.pills.size, 0);
  f.state.bindings = { "orch-ws": { label: "Acme", serverId: "srv_acme" } };
  await f.tick();
  assert.equal(f.pills.size, 2);
  f.state.agents[0].status = "closed";
  await f.tick();
  assert.equal(f.pills.size, 0);
  f.state.agents[0].status = "idle";
  await f.tick();
  f.stop();
  assert.equal(f.pills.size, 0);
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
