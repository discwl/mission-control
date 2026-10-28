import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { runInNewContext } from "node:vm";
import { connectRegisteredHost, usage } from "./remote.mjs";

function fixture({ hosts = [{ serverId: "srv_remote", label: "Remote", enabled: true, status: "online" }], actual = "srv_remote", connectError, identityError, closeError, directoryError, factoryError } = {}) {
  const calls = [];
  const origin = {
    async listHosts() { calls.push("list"); if (directoryError) throw directoryError; return { hosts }; },
    async close() { calls.push("origin.close"); },
  };
  const remote = {
    async connect() { calls.push("remote.connect"); if (connectError) throw connectError; },
    async invokePluginRpc(...args) {
      calls.push(args);
      if (args[1] === "host.identity") { if (identityError) throw identityError; return { serverId: actual }; }
      return { tasks: [] };
    },
    async close() { calls.push("remote.close"); if (closeError) throw closeError; },
  };
  const create = serverId => { calls.push(["create", serverId]); if (factoryError) throw factoryError; return remote; };
  return { calls, origin, create };
}

test("registered host routing verifies the exact destination before sending a task command", async () => {
  const f = fixture();
  const connection = await connectRegisteredHost("srv_remote", f.origin, f.create);
  assert.deepEqual(f.calls, ["list", ["create", "srv_remote"], "remote.connect", ["mission-control", "host.identity", {}]]);
  assert.deepEqual(await connection.invokePluginRpc("mission-control", "tasks.summary", { serverId: "srv_remote" }), { tasks: [] });
  await connection.close();
  await connection.close();
  assert.deepEqual(f.calls.slice(-3), [["mission-control", "tasks.summary", { serverId: "srv_remote" }], "remote.close", "origin.close"]);
});

test("a missing registration never creates a connection or falls back to Personal", async () => {
  const f = fixture({ hosts: [{ serverId: "srv_personal", label: "Remote", enabled: true, status: "online" }] });
  await assert.rejects(connectRegisteredHost("srv_remote", f.origin, f.create), /not registered.*do not recreate pairing files or register Personal remotely/);
  assert.deepEqual(f.calls, ["list", "origin.close"]);
});

for (const state of [{ enabled: false, status: "online" }, { enabled: true, status: "offline" }, { enabled: true, status: "connecting" }]) {
  test(`a ${!state.enabled ? "disabled" : state.status} destination fails without opening another connection`, async () => {
    const f = fixture({ hosts: [{ serverId: "srv_remote", label: "Remote", ...state }] });
    await assert.rejects(connectRegisteredHost("srv_remote", f.origin, f.create), /do not regenerate pairing files or change registrations/);
    assert.deepEqual(f.calls, ["list", "origin.close"]);
  });
}

test("a wrong destination identity closes both connections before any task command", async () => {
  const f = fixture({ actual: "srv_personal" });
  await assert.rejects(connectRegisteredHost("srv_remote", f.origin, f.create), /Host identity mismatch.*No task command was sent/);
  assert.deepEqual(f.calls.slice(-2), ["remote.close", "origin.close"]);
  assert.equal(f.calls.filter(Array.isArray).filter(call => call[0] === "mission-control").length, 1);
});

for (const failure of ["connectError", "identityError", "directoryError", "factoryError"]) {
  test(`${failure} releases the local connection and preserves the failure`, async () => {
    const error = new Error(failure);
    const f = fixture({ [failure]: error });
    await assert.rejects(connectRegisteredHost("srv_remote", f.origin, f.create), value => value === error);
    assert.equal(f.calls.at(-1), "origin.close");
    assert.equal(f.calls.filter(call => call === "origin.close").length, 1);
  });
}

test("remote cleanup failure still releases the origin and does not replace a routing failure", async () => {
  const f = fixture({ actual: "srv_wrong", closeError: new Error("cleanup") });
  await assert.rejects(connectRegisteredHost("srv_remote", f.origin, f.create), /Host identity mismatch/);
  assert.equal(f.calls.at(-1), "origin.close");
});

test("opening parent and link connections keeps the original remote route alive", async () => {
  const source = (await readFile(new URL("./remote.mjs", import.meta.url), "utf8"))
    .replace(/^import .*;\r?\n/gm, "")
    .replace(/export /g, "")
    .replace(/await import\(/g, "await importModule(")
    .split("if (import.meta.url ===")[0];
  const peers = new Map();
  const created = [];
  class DaemonClient {
    constructor(config) { this.config = config; this.route = config.transportFactory?.(); this.connected = false; created.push(this); }
    async connect() {
      const key = `${this.route?.serverId ?? "local"}:${this.config.clientId}`;
      const previous = peers.get(key);
      if (previous) previous.connected = false; // Paseo replaces a session reusing this client identity.
      peers.set(key, this);
      this.connected = true;
    }
    async close() { this.connected = false; }
    check() { if (!this.connected || (this.route && !this.route.origin.connected)) throw new Error("Transport not connected"); }
    async listHosts() { this.check(); return { hosts: [{ serverId: "srv_remote", label: "Remote", enabled: true, status: "online" }] }; }
    async invokePluginRpc(_plugin, method) { this.check(); return method === "host.identity" ? { serverId: this.route?.serverId ?? "srv_personal" } : { linked: true }; }
  }
  const sandbox = {
    process: { pid: 42, env: {} }, join, homedir: () => "/test-home", readFile: async () => '{"listen":"127.0.0.1:6767"}',
    importModule: async name => {
      if (name === "@getpaseo/client/internal/daemon-client") return { DaemonClient };
      if (name === "@getpaseo/client/node") return { createHostChannelTransport: (origin, serverId) => () => ({ origin, serverId }) };
      throw new Error(`Unexpected import ${name}`);
    },
  };
  runInNewContext(`${source}\nglobalThis.openConnection = connect;`, sandbox);
  const remote = await sandbox.openConnection({ server: "srv_remote" });
  const parent = await sandbox.openConnection({ local: true });
  const link = await sandbox.openConnection({ local: true });
  try {
    assert.equal((await parent.invokePluginRpc("mission-control", "host.identity", {})).serverId, "srv_personal");
    assert.equal((await link.invokePluginRpc("mission-control", "orchestrator.work.set", {})).linked, true);
    assert.equal((await remote.invokePluginRpc("mission-control", "host.identity", {})).serverId, "srv_remote");
    assert.equal(created.length, 4);
    assert.equal(new Set(created.map(client => client.config.clientId)).size, created.length);
  } finally { await link.close(); await parent.close(); await remote.close(); }
  assert.ok(created.every(client => !client.connected));
});

test("the command line refuses conflicting or missing selectors before connecting", () => {
  const script = fileURLToPath(new URL("./remote.mjs", import.meta.url));
  for (const args of [[], ["--server", "srv_remote", "--local"], ["--server", "srv_remote", "--offer-file", "missing"], ["--local", "--offer-file", "missing"]]) {
    const result = spawnSync(process.execPath, [script, ...args, "identity"], { encoding: "utf8", timeout: 10_000 });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /Choose exactly one connection/);
  }
  const empty = spawnSync(process.execPath, [script, "--server", " ", "identity"], { encoding: "utf8", timeout: 10_000 });
  assert.equal(empty.status, 1);
  assert.match(empty.stderr, /non-empty destination server ID/);
  assert.match(usage, /--server <serverId>/);
});
