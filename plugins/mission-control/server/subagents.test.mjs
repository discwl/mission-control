import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { test } from "node:test";

const require = createRequire(import.meta.url);
const ts = require("typescript");
require.extensions[".ts"] = (module, file) => module._compile(ts.transpileModule(readFileSync(file, "utf8"), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText, file);
const { createHelperService, liveNow } = require("./subagents.ts");

const serverId = "srv_local";
const reply = (parentAgentId, ...ids) => ({ parentAgentId, error: null, subagents: ids.map(id => ({ id, parentAgentId, title: "Explore", description: `Helper ${id}`, status: "running", createdAt: "2026-09-28T10:00:00.000Z", updatedAt: "2026-09-28T10:00:00.000Z" })) });

const record = (status, extra = {}) => ({ agent: { id: "x", status, ...extra }, project: null });

function harness(replies, overrides = {}) {
  const clock = { now: 0 };
  const calls = [];
  const statusCalls = [];
  // Paseo's current record for each agent; every agent is idle unless a test says otherwise.
  const statuses = overrides.statuses ?? {};
  const source = {
    async status(ids) {
      statusCalls.push(ids);
      if (overrides.statusError) throw overrides.statusError;
      return new Map(ids.map(id => [id, id in statuses ? statuses[id] : record("idle")]));
    },
    async list(ids) {
      calls.push(ids);
      if (typeof replies === "function") return replies(ids);
      return new Map(ids.map(id => [id, replies[id]]));
    },
    async messages() { return overrides.messages ?? { error: null, rows: [] }; },
  };
  const service = createHelperService({ source, localServerId: overrides.localServerId ?? (async () => serverId), ttlMs: 10_000, now: () => clock.now });
  return { service, calls, statusCalls, clock, statuses };
}

test("helpers are listed for each parent and cached briefly", async () => {
  const { service, calls, clock } = harness({ p1: reply("p1", "h1"), p2: reply("p2", "h2", "h3") });
  const first = await service.list({ serverId, parentAgentIds: ["p1", "p2", "p1"] });
  assert.equal(first.available, true);
  assert.deepEqual(first.helpers.map(helper => helper.id), ["h1", "h2", "h3"]);
  clock.now = 9_000;
  await service.list({ serverId, parentAgentIds: ["p2"] });
  assert.deepEqual(calls, [["p1", "p2"]]);
  clock.now = 10_500;
  await service.list({ serverId, parentAgentIds: ["p1", "p2"] });
  assert.deepEqual(calls, [["p1", "p2"], ["p1", "p2"]]);
});

test("requests arriving together share one daemon read", async () => {
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const { service, calls } = harness(async ids => { await gate; return new Map(ids.map(id => [id, reply(id, `${id}-helper`)])); });
  const both = Promise.all([service.list({ serverId, parentAgentIds: ["p1"] }), service.list({ serverId, parentAgentIds: ["p1"] })]);
  release();
  const [first, second] = await both;
  assert.equal(calls.length, 1);
  assert.deepEqual(first, second);
});

test("helpers are unavailable when the daemon can't be reached or doesn't support them", async () => {
  const unreachable = harness(async () => { throw new Error("connect ECONNREFUSED 127.0.0.1:6767"); });
  assert.deepEqual(await unreachable.service.list({ serverId, parentAgentIds: ["p1"] }), { available: false, helpers: [] });
  // An older daemon answers every request with an error.
  const unsupported = harness({ p1: { error: "Unknown request type", subagents: [] }, p2: new Error("Request timed out") });
  assert.deepEqual(await unsupported.service.list({ serverId, parentAgentIds: ["p1", "p2"] }), { available: false, helpers: [] });
  // The failure is cached too, so refreshing views don't retry at once.
  await unsupported.service.list({ serverId, parentAgentIds: ["p1", "p2"] });
  assert.equal(unsupported.calls.length, 1);
});

test("one parent's failure hides only its own helpers", async () => {
  const { service } = harness({ p1: reply("p1", "h1"), p2: new Error("timed out") });
  assert.deepEqual((await service.list({ serverId, parentAgentIds: ["p1", "p2"] })).helpers.map(helper => helper.id), ["h1"]);
});

test("helpers are listed only for this Mission Control's own host", async () => {
  const { service, calls } = harness({ p1: reply("p1", "h1") });
  assert.deepEqual(await service.list({ serverId: "srv_other", parentAgentIds: ["p1"] }), { available: false, helpers: [] });
  const noId = harness({ p1: reply("p1", "h1") }, { localServerId: async () => { throw new Error("no server ID"); } });
  assert.deepEqual(await noId.service.list({ serverId, parentAgentIds: ["p1"] }), { available: false, helpers: [] });
  assert.deepEqual(await service.list({ serverId, parentAgentIds: [] }), { available: false, helpers: [] });
  assert.equal(calls.length, 0);
});

test("a helper's messages are read on request, and a failure hides them", async () => {
  const { service } = harness({}, { messages: { error: null, rows: [{ item: { type: "user_message", text: "Fresh review of task 23" }, timestamp: "t1" }] } });
  assert.deepEqual(await service.messages({ serverId, parentAgentId: "p1", helperId: "h1" }), { available: true, messages: [{ role: "user", text: "Fresh review of task 23", timestamp: "t1" }] });
  const failing = harness({}, { messages: { error: "Unknown sub-agent", rows: [] } });
  assert.deepEqual(await failing.service.messages({ serverId, parentAgentId: "p1", helperId: "h1" }), { available: false, messages: [] });
  assert.deepEqual(await service.messages({ serverId: "srv_other", parentAgentId: "p1", helperId: "h1" }), { available: false, messages: [] });
});

test("the lookup's reply says whether an agent may be asked about now", () => {
  assert.equal(liveNow(record("running")), true);
  assert.equal(liveNow(record("initializing")), true);
  assert.equal(liveNow(record("idle")), true);
  assert.equal(liveNow(record("closed")), false);
  assert.equal(liveNow(record("error")), false);
  assert.equal(liveNow(record("idle", { archivedAt: "2026-09-29T10:00:00.000Z" })), false);
  assert.equal(liveNow(record("idle", { providerUnavailable: true })), false);
  // Paseo doesn't know the agent: nothing to ask about.
  assert.equal(liveNow(null), false);
  // The lookup failed or its reply changed shape: unknown.
  assert.equal(liveNow(new Error("Request timed out")), null);
  assert.equal(liveNow({ agent: { id: "x" } }), null);
  assert.equal(liveNow("nonsense"), null);
});

test("after a daemon restart, agents the view still thinks are live are checked again and not asked about", async () => {
  // Paseo closed every agent on shutdown; the view's roster from before the restart still lists them as live.
  const { service, calls, statusCalls } = harness({ p1: reply("p1", "h1"), p2: reply("p2", "h2") }, {
    statuses: { p1: record("closed"), p2: record("closed"), p3: record("running") },
  });
  const result = await service.list({ serverId, parentAgentIds: ["p1", "p2", "p3"] });
  assert.deepEqual(statusCalls, [["p1", "p2", "p3"]]);
  // Only the agent that is live now is asked for its helpers.
  assert.deepEqual(calls, [["p3"]]);
  assert.equal(result.available, true);
  assert.deepEqual(result.helpers, []);
});

test("in the Tasks view, an agent that closed since the last read isn't asked again", async () => {
  // That view has no live updates, so its roster can show a just-closed agent as idle for up to 20 s.
  const { service, calls, statuses, clock } = harness({ p1: reply("p1", "h1") });
  assert.deepEqual((await service.list({ serverId, parentAgentIds: ["p1"] })).helpers.map(helper => helper.id), ["h1"]);
  statuses.p1 = record("closed");
  clock.now = 10_500;
  const later = await service.list({ serverId, parentAgentIds: ["p1"] });
  assert.deepEqual(calls, [["p1"]]);
  assert.deepEqual(later, { available: true, helpers: [] });
});

test("when the status can't be read, no helpers are asked for and the list is unavailable", async () => {
  const failed = harness({ p1: reply("p1", "h1") }, { statusError: new Error("connect ECONNREFUSED 127.0.0.1:6767") });
  assert.deepEqual(await failed.service.list({ serverId, parentAgentIds: ["p1"] }), { available: false, helpers: [] });
  assert.deepEqual(failed.calls, []);
  const timedOut = harness({ p1: reply("p1", "h1"), p2: reply("p2", "h2") }, { statuses: { p1: new Error("Request timed out") } });
  const partial = await timedOut.service.list({ serverId, parentAgentIds: ["p1", "p2"] });
  assert.deepEqual(timedOut.calls, [["p2"]]);
  assert.deepEqual(partial.helpers.map(helper => helper.id), ["h2"]);
});
