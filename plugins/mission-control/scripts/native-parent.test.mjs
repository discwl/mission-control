import assert from "node:assert/strict";
import { test } from "node:test";
import { runCommand } from "./remote.mjs";
const parent = { serverId: "origin", agentId: "this-chat" };
const values = { workspace: "task-workspace", task: "task_aaaa", provider: "codex/model", parent };
const status = { action: "start", revision: "exact-revision", canIsolate: false, message: "", launch: null, run: null, agent: null, worktree: null };
function fixture(check = { supported: true }, failure) {
  const dispatched = [], probes = [];
  const rpc = async (method, input) => {
    if (method === "host.identity") return { serverId: "remote" };
    if (method === "tasks.launch.status") return status;
    if (method === "tasks.launch.parent") { probes.push(input); if (check instanceof Error) throw check; return check; }
    if (method === "tasks.launch.dispatch") { dispatched.push(input); if (failure) throw failure; return { ...status, action: "open", launch: { parent: input.parent } }; }
    throw Error(method);
  };
  return { rpc, dispatched, probes };
}
test("new task launch requests the validated native parent without creating a separate worker", async () => {
  const f = fixture(); const result = await runCommand("start", values, f.rpc);
  assert.deepEqual(f.probes, [parent]); assert.equal(f.dispatched.length, 1);
  assert.deepEqual(f.dispatched[0].parent, parent); assert.equal(f.dispatched[0].expectedRevision, "exact-revision");
  assert.equal(result.nativeParent.linked, true);
});
test("old or disconnected hosts keep normal task launch and report that native linkage is absent", async () => {
  for (const check of [{ supported: false, reason: "host_offline" }, Error("no handler")]) {
    const f = fixture(check); const result = await runCommand("start", values, f.rpc);
    assert.equal(f.dispatched.length, 1); assert.equal(f.dispatched[0].parent, undefined);
    assert.equal(result.started, true); assert.equal(result.nativeParent.linked, false); assert.ok(result.nativeParent.reason);
  }
});
test("lost dispatch response is surfaced once and never retried as a second launch", async () => {
  const f = fixture({ supported: true }, Error("outcome unknown"));
  await assert.rejects(runCommand("start", values, f.rpc), /outcome unknown/);
  assert.equal(f.dispatched.length, 1);
});
