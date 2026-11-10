import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { test } from "node:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
const require = createRequire(import.meta.url); const ts = require("typescript");
require.extensions[".ts"] = (module, file) => module._compile(ts.transpileModule(readFileSync(file, "utf8"), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText, file);
const { findCoordinatingFleet } = require("./coordinating-fleet.ts");
const { createFleetStore } = require("../server/fleet-store.ts");
// A real, empty fleet state, so snapshots pass the same schema the bridge answer is checked against.
const state = await createFleetStore(join(mkdtempSync(join(tmpdir(), "mc-coordinating-")), "fleet.json")).read();

const at = "2026-11-10T00:00:00.000Z";
const agent = id => ({ id, workspaceId: "folder", name: id, status: "idle", archivedAt: null, labels: {}, updatedAt: at, activityAt: at, pendingPermissions: 0, attention: false, attentionReason: null, error: null, inputTokens: null, outputTokens: null, providerUnavailable: false });
const coordinator = remoteServerId => ({ agentId: `chat-${remoteServerId}`, workspaceId: "folder", name: "Orchestrator", remoteServerId, hostLabel: remoteServerId, agent: agent(`chat-${remoteServerId}`), links: [] });
const fleet = (serverId, managed = []) => ({ serverId, observedAt: at, coordinators: managed.map(coordinator), hosts: [], warnings: [],
  state });
const copy = (serverId, answer, calls = []) => ({ protocol: 1, version: "test", serverId, supports: () => true,
  rpc: async (name, input) => { calls.push([serverId, name, input]); if (answer instanceof Error) throw answer; return answer; } });

test("this copy's own orchestrator manages the host: start here", async () => {
  const result = await findCoordinatingFleet("remote", async () => fleet("personal", ["remote"]), []);
  assert.equal(result.copy, null); assert.equal(result.managed, true);
});

test("a host's own Tasks view finds the coordinating computer's copy through the bridge", async () => {
  const calls = [];
  const coordinating = copy("personal", fleet("personal", ["remote", "other"]), calls);
  const result = await findCoordinatingFleet("remote", async () => fleet("remote"), [copy("remote", fleet("remote")), coordinating]);
  assert.equal(result.copy, coordinating); assert.equal(result.managed, true);
  assert.deepEqual(calls.map(call => call[1]), ["orchestrator.fleet.read"], "the task's own host copy is not asked again");
});

test("the coordinating computer's own tasks keep the manual start without asking other copies", async () => {
  const calls = [];
  const result = await findCoordinatingFleet("personal", async () => fleet("personal", ["remote"]), [copy("remote", fleet("remote"), calls)]);
  assert.equal(result.managed, false); assert.equal(result.copy, null); assert.deepEqual(calls, []);
});

test("a standalone computer with no orchestrator anywhere starts manually", async () => {
  const result = await findCoordinatingFleet("alone", async () => fleet("alone"), [copy("alone", fleet("alone"))]);
  assert.equal(result.managed, false);
});

test("a failed lookup is an error, never a silent manual fallback", async () => {
  await assert.rejects(findCoordinatingFleet("remote", async () => { throw new Error("offline"); }, []), /offline/);
  await assert.rejects(findCoordinatingFleet("remote", async () => fleet("remote"), [copy("personal", new Error("RPC timed out"))]), /Couldn't check whether an orchestrator manages this host \(personal: RPC timed out\)/);
});
