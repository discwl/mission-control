import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { test } from "node:test";

const require = createRequire(import.meta.url);
const ts = require("typescript");
require.extensions[".ts"] = (module, file) => module._compile(ts.transpileModule(readFileSync(file, "utf8"), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText, file);
const { BRIDGE_PROTOCOL, bridgeContracts, copiesRevision, findCopy, registerCopy, startCopyRegistration, subscribeCopies } = require("./host-bridge.ts");
const turn = () => new Promise(resolve => setImmediate(resolve));
const copy = (serverId, protocol = BRIDGE_PROTOCOL) => ({ protocol, version: "test", serverId, supports: () => true, rpc: async () => null });

test("copies register by host, notify listeners, and only their own registration removes them", () => {
  let heard = 0;
  const stop = subscribeCopies(() => heard++);
  const before = copiesRevision();
  const first = copy("srv_acme");
  const unregisterFirst = registerCopy(first);
  assert.equal(findCopy("srv_acme").copy, first);
  const second = copy("srv_acme");
  const unregisterSecond = registerCopy(second);
  unregisterFirst();
  assert.equal(findCopy("srv_acme").copy, second, "a replaced copy's late cleanup leaves the new one");
  unregisterSecond();
  assert.deepEqual(findCopy("srv_acme"), { missing: "none" });
  assert.equal(heard, 3);
  assert.equal(copiesRevision(), before + 3);
  stop();
});

test("a copy on another protocol is reported as older or newer", () => {
  const older = registerCopy(copy("srv_old", BRIDGE_PROTOCOL - 1));
  const newer = registerCopy(copy("srv_new", BRIDGE_PROTOCOL + 1));
  assert.deepEqual(findCopy("srv_old"), { missing: "older" });
  assert.deepEqual(findCopy("srv_new"), { missing: "newer" });
  older(); newer();
});

test("other hosts may call the shared views' contracts, not setup, tools, updates or cleanup", () => {
  for (const name of ["tasks.list", "read-vault-file", "save-vault-file", "review.snapshot", "decisions.list", "attention.waiting"]) assert.ok(bridgeContracts.has(name), name);
  for (const name of ["setup.apply", "plugin-updates.apply", "tools-inventory.apply-toggle", "agents.cleanup.archive", "orchestrator.bindings", "host.identity"]) assert.ok(!bridgeContracts.has(name), name);
});

test("this installation registers under its server ID and answers only allowed calls", async t => {
  const calls = [];
  const contracts = new Map([["tasks.list", { name: "tasks.list" }]]);
  const client = { rpc: async (contract, input) => {
    calls.push([contract.name, input]);
    if (contract.name === "host.identity") return { serverId: "srv_here" };
    return { tasks: [] };
  } };
  const stop = startCopyRegistration(client, { contracts });
  t.after(stop);
  await turn();
  const found = findCopy("srv_here").copy;
  assert.equal(found.protocol, BRIDGE_PROTOCOL);
  assert.equal(found.supports("tasks.list"), true);
  assert.equal(found.supports("setup.apply"), false);
  assert.deepEqual(await found.rpc("tasks.list", { serverId: "srv_here", workspaceId: "w1" }), { tasks: [] });
  assert.deepEqual(calls.at(-1), ["tasks.list", { serverId: "srv_here", workspaceId: "w1" }]);
  await assert.rejects(found.rpc("setup.apply", {}), /doesn't offer setup.apply/);
  stop();
  assert.deepEqual(findCopy("srv_here"), { missing: "none" });
});

test("registration retries until the server says which host it is", async t => {
  let retry;
  t.mock.method(globalThis, "setTimeout", callback => { retry = callback; return 1; });
  t.mock.method(globalThis, "clearTimeout", () => {});
  let fail = true;
  const client = { rpc: async () => { if (fail) throw new Error("plugin starting"); return { serverId: "srv_late" }; } };
  const stop = startCopyRegistration(client, { contracts: new Map() });
  t.after(stop);
  await turn();
  assert.deepEqual(findCopy("srv_late"), { missing: "none" });
  fail = false;
  retry();
  await turn();
  assert.ok(findCopy("srv_late").copy);
});
