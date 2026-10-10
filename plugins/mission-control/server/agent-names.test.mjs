import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

const require = createRequire(import.meta.url);
const ts = require("typescript");
require.extensions[".ts"] = (module, file) => module._compile(ts.transpileModule(readFileSync(file, "utf8"), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText, file);
const { daemonServerId, daemonWsUrl, listenUrl, renameAgentRecord } = require("./agent-names.ts");

function fixture(title) {
  const state = { title, renamed: [] };
  const paseo = {
    agents: {
      ref: () => ({ refresh: async () => ({ agent: { title: state.title, provider: "claude", archivedAt: null } }) }),
    },
  };
  const deps = {
    localServerId: async () => "srv_local",
    setAgentName: async (agentId, name) => { state.renamed.push([agentId, name]); state.title = name; },
  };
  return { state, paseo, deps };
}

test("renames an agent whose name is unchanged since review", async () => {
  const { state, paseo, deps } = fixture("claude agent helper");
  const result = await renameAgentRecord({ serverId: "srv_local", agentId: "a1", expected: "claude agent helper", name: "Rename Suggestions" }, paseo, deps);
  assert.deepEqual(result, { title: "Rename Suggestions" });
  assert.deepEqual(state.renamed, [["a1", "Rename Suggestions"]]);
});

test("an untitled agent is compared by the name Mission Control shows", async () => {
  const { paseo, deps } = fixture(null);
  const result = await renameAgentRecord({ serverId: "srv_local", agentId: "a1", expected: "claude agent", name: "Task Bridge" }, paseo, deps);
  assert.equal(result.title, "Task Bridge");
});

test("a rename made after review blocks the stale apply or undo", async () => {
  const { state, paseo, deps } = fixture("Newer manual name");
  await assert.rejects(renameAgentRecord({ serverId: "srv_local", agentId: "a1", expected: "Old name", name: "Suggested" }, paseo, deps), /Newer manual name/);
  assert.deepEqual(state.renamed, []);
});

test("agents on other hosts are refused", async () => {
  const { state, paseo, deps } = fixture("Old name");
  await assert.rejects(renameAgentRecord({ serverId: "srv_other", agentId: "a1", expected: "Old name", name: "New" }, paseo, deps), /host running this Mission Control/);
  assert.deepEqual(state.renamed, []);
});

async function paseoHome(files) {
  const dir = await mkdtemp(join(tmpdir(), "mc-daemon-"));
  for (const [name, value] of Object.entries(files)) await writeFile(join(dir, name), typeof value === "string" ? value : JSON.stringify(value));
  return dir;
}

test("every Paseo listen form becomes a dialable URL", () => {
  assert.equal(listenUrl("127.0.0.1:6767"), "ws://127.0.0.1:6767/ws");
  assert.equal(listenUrl("0.0.0.0:7000"), "ws://127.0.0.1:7000/ws");
  assert.equal(listenUrl("7100"), "ws://127.0.0.1:7100/ws");
  assert.equal(listenUrl("[::]:7200"), "ws://127.0.0.1:7200/ws");
  assert.equal(listenUrl("[::1]:7300"), "ws://[::1]:7300/ws");
  assert.equal(listenUrl(":7400"), "ws://127.0.0.1:7400/ws");
  assert.equal(listenUrl("localhost:7500"), "ws://localhost:7500/ws");
  for (const socket of ["\\\\.\\pipe\\paseo", "pipe://paseo", "unix:///tmp/paseo.sock", "/tmp/paseo.sock", "~/paseo.sock"]) {
    assert.throws(() => listenUrl(socket), /pipe or socket.*only over TCP/, socket);
  }
  assert.throws(() => listenUrl("C:\\paseo"), /can't read Paseo's listen address/);
});

test("the daemon URL follows the running daemon, then --listen, PASEO_LISTEN, config and PORT", async () => {
  const config = { daemon: { listen: "0.0.0.0:7000" } };
  const running = await paseoHome({ "paseo.pid": { pid: 1, listen: "[::]:7700", serverId: "srv_daemon" }, "config.json": config });
  const configured = await paseoHome({ "config.json": config });
  const stopped = await paseoHome({ "paseo.pid": { pid: 1, listen: null, serverId: null } });
  try {
    const argv = ["node", "daemon", "--listen", "7800"];
    assert.equal(await daemonWsUrl({ home: running, env: { PASEO_LISTEN: "7900" }, argv }), "ws://127.0.0.1:7700/ws");
    assert.equal(await daemonWsUrl({ home: configured, env: { PASEO_LISTEN: "7900" }, argv }), "ws://127.0.0.1:7800/ws");
    assert.equal(await daemonWsUrl({ home: configured, env: {}, argv: ["node", "daemon", "--listen=127.0.0.1:7850"] }), "ws://127.0.0.1:7850/ws");
    assert.equal(await daemonWsUrl({ home: configured, env: { PASEO_LISTEN: "7900" }, argv: [] }), "ws://127.0.0.1:7900/ws");
    assert.equal(await daemonWsUrl({ home: configured, env: {}, argv: [] }), "ws://127.0.0.1:7000/ws");
    assert.equal(await daemonWsUrl({ home: stopped, env: { PORT: "8000" }, argv: [] }), "ws://127.0.0.1:8000/ws");
    assert.equal(await daemonWsUrl({ home: join(stopped, "missing"), env: {}, argv: [] }), "ws://127.0.0.1:6767/ws");
  } finally {
    for (const dir of [running, configured, stopped]) await rm(dir, { recursive: true, force: true });
  }
});

test("the server ID comes from the daemon, and a missing one gets a clear message", async () => {
  const running = await paseoHome({ "paseo.pid": { pid: 1, listen: "127.0.0.1:6767", serverId: "srv_daemon" }, "server-id": "srv_saved\n" });
  const saved = await paseoHome({ "paseo.pid": { pid: 1, listen: null, serverId: null }, "server-id": "srv_saved\n" });
  const none = await paseoHome({});
  try {
    assert.equal(await daemonServerId(running), "srv_daemon");
    assert.equal(await daemonServerId(saved), "srv_saved");
    await assert.rejects(daemonServerId(none), /couldn't find this host's Paseo server ID.*Check that Paseo is running/);
  } finally {
    for (const dir of [running, saved, none]) await rm(dir, { recursive: true, force: true });
  }
});
