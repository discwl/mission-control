import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
const require = createRequire(import.meta.url);
const ts = require("typescript");
require.extensions[".ts"] = (module, file) => module._compile(ts.transpileModule(readFileSync(file, "utf8"), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText, file);
const transport = require("./fleet-transport.ts");
const directory = require("./fleet-host.ts");
const bindings = require("./orchestrator.ts");
const names = require("./agent-names.ts");
const { registerFleet } = require("./fleet-runtime.ts");
const { createFleetStore } = require("./fleet-store.ts");
const { readCompatibleFleet } = require("./fleet-compat.ts");
const at = "2026-10-26T12:00:00Z";
const raw = (id, workspaceId, labels = {}) => ({ id, name: id, title: id, workspaceId, labels, status: "idle", archivedAt: null, updatedAt: at });
const remote = () => ({ serverId: "remote", observedAt: at, agents: [], workspaces: [], tasks: [], warnings: [], complete: true, stoppedAgentIds: [] });

test("fleet RPCs discover setup-created coordinators and empty host folders; enrollment is explicit and identity-bound", async t => {
  const folder = await mkdtemp(join(tmpdir(), "mc-fleet-runtime-"));
  const previous = process.env.PASEO_HOME; process.env.PASEO_HOME = folder;
  t.after(async () => { if (previous === undefined) delete process.env.PASEO_HOME; else process.env.PASEO_HOME = previous; await rm(folder, { recursive: true, force: true }); });
  t.mock.method(transport, "withFleetConnection", async action => action({}, {}, "personal"));
  t.mock.method(names, "daemonServerId", async () => "personal");
  let complete = true;
  t.mock.method(transport, "readRemoteFleet", async (_client, serverId) => ({ ...remote(), serverId, complete }));
  t.mock.method(directory, "fleetDirectory", async () => ({ agents: [raw("setup", "development"), raw("coordinator", "folder", { "paseo.parent-agent-id": "setup" }), raw("helper", "folder", { "paseo.parent-agent-id": "coordinator" })], workspaces: [{ id: "folder" }, { id: "empty-folder" }, { id: "development" }], complete: true }));
  // The check hands over the workspace records it already listed, so nothing is looked up again.
  t.mock.method(bindings, "readOrchestratorBindings", async (_api, workspaces) => { assert.ok(workspaces.some(item => typeof item !== "string" && item.id === "empty-folder")); return { bindings: { folder: { serverId: "remote", label: "Remote" }, "empty-folder": { serverId: "empty", label: "Empty" } }, problems: {} }; });
  const handlers = new Map(); const hooks = new Map();
  const stop = registerFleet({ handle: (contract, handler) => handlers.set(contract.name, handler), on: (name, handler) => hooks.set(name, handler) }, { decisions: async () => ({ open: [], recent: [] }), questions: async () => ({ questions: [] }) }); t.after(stop);
  let snapshot = await handlers.get("orchestrator.fleet.read")({ refresh: true });
  assert.deepEqual(snapshot.coordinators.map(item => item.agentId), ["coordinator"]);
  assert.deepEqual(snapshot.hosts.map(item => item.serverId), ["remote", "empty"]);
  assert.equal(snapshot.state.coordinators.length, 0);
  const configure = handlers.get("orchestrator.supervisor.configure");
  const input = { agentId: "coordinator", remoteServerId: "remote", enabled: true, intervalMinutes: 5, maxWakeupsPerDay: 6, expectedRevision: snapshot.state.revision };
  await assert.rejects(configure({ ...input, remoteServerId: "other" }), /no longer belongs/);
  complete = false; await assert.rejects(configure(input), /complete current/); complete = true;
  await assert.rejects(handlers.get("orchestrator.queue.set")({ coordinatorId: "coordinator", remoteServerId: "remote", taskId: "unowned", enabled: true, priority: 5, expectedRevision: snapshot.state.revision }), /not linked/);
  const enabled = await configure(input); assert.equal(enabled.coordinators[0].enabled, true);
  await assert.rejects(configure(input), /changed/);
  const withRunner = await createFleetStore().update(state => state.pipelines.push({ id: "11111111-1111-4111-8111-111111111111", coordinatorId: "coordinator", remoteServerId: "remote", taskId: "task_a", title: "Disposable runner", intake: null, mode: "running", stage: "execute", runId: null, message: "Ready", updatedAt: at, repairs: 0, repairIds: [], lastDispatch: null, lastSentAt: null, date: "", wakeups: 0, pending: null }));
  const paused = await configure({ ...input, enabled: false, expectedRevision: withRunner.revision }); assert.equal(paused.pipelines[0].mode, "paused", "pausing a coordinator pauses its task runner too");
  const resumed = await configure({ ...input, enabled: true, expectedRevision: paused.revision }); assert.equal(resumed.pipelines[0].mode, "running");
  await hooks.get("agent.turn_ended")({ agent: { id: "coordinator" }, outcome: { kind: "canceled", reason: "user" } });
  snapshot = await handlers.get("orchestrator.fleet.read")({ refresh: true });
  assert.equal(snapshot.state.coordinators[0].enabled, false); assert.ok(snapshot.state.stoppedAgentIds.includes("coordinator")); assert.equal(snapshot.state.pipelines[0].mode, "paused");
  await assert.rejects(handlers.get("orchestrator.host.snapshot")({ serverId: "another" }, { paseo: {} }), /different host/);
});

/** A TCP listener that only counts connection attempts, standing in for whatever answers at the address Mission Control would dial. */
async function countingListener(t) {
  const listener = { attempts: 0 };
  const server = createServer(socket => { listener.attempts++; socket.destroy(); });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  listener.port = server.address().port;
  return listener;
}

test("while Paseo is still starting, the orchestrator check doesn't connect, says so once, and resumes when the daemon is ready", async t => {
  const folder = await mkdtemp(join(tmpdir(), "mc-fleet-starting-"));
  const previous = { home: process.env.PASEO_HOME, listen: process.env.PASEO_LISTEN };
  const daemon = await countingListener(t);
  process.env.PASEO_HOME = folder; process.env.PASEO_LISTEN = String(daemon.port);
  t.after(async () => {
    for (const [name, value] of [["PASEO_HOME", previous.home], ["PASEO_LISTEN", previous.listen]]) { if (value === undefined) delete process.env[name]; else process.env[name] = value; }
    await rm(folder, { recursive: true, force: true });
  });
  // Paseo's supervisor (this process stands in for it) holds paseo.pid and adds the listen address once the daemon accepts connections.
  const lock = listen => writeFile(join(folder, "paseo.pid"), JSON.stringify({ pid: process.pid, listen, serverId: listen ? "personal" : null }));
  await writeFile(join(folder, "server-id"), "personal\n");
  await lock(null);
  t.mock.method(directory, "fleetDirectory", async () => ({ agents: [], workspaces: [], complete: true }));
  t.mock.method(bindings, "readOrchestratorBindings", async () => ({ bindings: {}, problems: {} }));
  const warnings = [];
  t.mock.method(console, "warn", message => { if (String(message).startsWith("[mission-control] orchestrator check")) warnings.push(String(message)); });
  const handlers = new Map();
  const stop = registerFleet({ handle: (contract, handler) => handlers.set(contract.name, handler), on: () => {} }, { decisions: async () => ({ open: [], recent: [] }), questions: async () => ({ questions: [] }) }); t.after(stop);
  const check = () => handlers.get("orchestrator.supervisor.check")({});

  // The real connection path: before the fix it dialed the fallback address and failed with "Transport closed (code 1006)".
  await assert.rejects(check(), /Paseo is still starting/);
  await assert.rejects(check(), /Paseo is still starting/);
  assert.equal(daemon.attempts, 0, "nothing dials a daemon that refuses connections");
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /orchestrator check waiting: Paseo is still starting/);

  // Ready: the published address is used, and a stand-in connection lets the check finish.
  const dialed = []; let failure = null;
  t.mock.method(transport, "withFleetConnection", async action => { dialed.push(await names.daemonWsUrl()); if (failure) throw failure; return action({}, {}, "personal"); });
  await lock(`127.0.0.1:${daemon.port}`);
  await check();
  assert.deepEqual(dialed, [`ws://127.0.0.1:${daemon.port}/ws`]);
  assert.equal(warnings.length, 2);
  assert.match(warnings[1], /orchestrator check resumed: Paseo finished starting \(waited \d+ s\)/);
  assert.equal((await handlers.get("orchestrator.fleet.read")({})).heartbeat.error, null);

  // Other failures are still reported on every check.
  failure = new Error("Transport closed (code 1006)");
  await assert.rejects(check(), /code 1006/);
  await assert.rejects(check(), /code 1006/);
  assert.deepEqual(warnings.slice(2), Array(2).fill("[mission-control] orchestrator check stopped: Transport closed (code 1006)"));
});

test("old-host compatibility reads only managed workspaces and remains ineligible for automation", async t => {
  t.mock.method(directory, "fleetDirectory", async () => ({ agents: [raw("worker", "managed", { "paseo.parent-agent-id": "coordinator", "paseo.parent-server-id": "personal" }), raw("unrelated", "other")], workspaces: [{ id: "managed", name: "Work", projectDisplayName: "Project", labels: [], status: "idle" }, { id: "other", name: "Other", projectDisplayName: "Project", labels: [], status: "idle" }], complete: true }));
  const calls = [];
  const client = { invokePluginRpc: async (pluginId, method, input) => {
    calls.push({ pluginId, method, input });
    if (method === "decisions.list") return { open: [], recent: [] };
    if (method === "attention.waiting") return { questions: [], taskTitles: {} };
    if (method === "tasks.list") return { tasks: [], problems: [] };
    throw new Error(`Unexpected call ${method}`);
  } };
  const result = await readCompatibleFleet({}, client, "remote", { localServerId: "personal", coordinators: [{ agentId: "coordinator", remoteServerId: "remote", links: [] }] });
  assert.equal(result.complete, false); assert.match(result.warnings[0], /update/i);
  assert.deepEqual(calls.filter(item => item.method === "tasks.list").map(item => item.input.workspaceId), ["managed"]);
  assert.ok(calls.every(item => item.pluginId === "mission-control"));
});
