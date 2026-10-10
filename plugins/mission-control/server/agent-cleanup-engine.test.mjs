import assert from "node:assert/strict";
import { test } from "node:test";
import { cleanupCandidates, createAgentCleanupEngine } from "./agent-cleanup-engine.ts";

const scope = { serverId: "host-a", workspaceId: "ws-a" };
const old = "2026-09-01T12:00:00.000Z";
const now = Date.parse("2026-10-03T12:00:00.000Z");
const agent = (id = "a", extra = {}) => ({ id, title: id, workspaceId: "ws-a", status: "idle", createdAt: old, updatedAt: old,
  lastUserMessageAt: old, pendingPermissions: [], labels: {}, ...extra });
const delivered = (id = "task-a", extra = {}) => ({ id, title: id, status: "delivered", updatedAt: old, agentIds: ["a"], workspaceIds: ["ws-a"], newerRun: false, hasPullRequest: false, ...extra });
function snapshot(extra = {}) {
  return { agents: [agent()], workspaces: [{ id: "ws-a", pinned: false }, { id: "ws-b", pinned: false }], tasks: [delivered()],
    pendingAgentIds: [], pendingTaskIds: [], policy: { deliveredDays: 7, unlinkedDays: 14 }, activity: { a: { at: old, basis: "conversation" } },
    warnings: [], recordsComplete: true, mergedPullRequests: [], ...extra };
}
function fixture(state = snapshot()) {
  const f = { state, now, calls: [], receipts: [], archive: async id => { f.calls.push(id); return [id]; }, read: async () => structuredClone(f.state) };
  f.engine = createAgentCleanupEngine({ localServerId: async () => "host-a", snapshot: (...args) => f.read(...args), archive: (...args) => f.archive(...args),
    record: async entry => f.receipts.push(entry), now: () => f.now });
  return f;
}
const row = state => cleanupCandidates(state, scope, now)[0];
const selection = (scan, ids = ["a"]) => ({ ...scope, scanId: scan.scanId, agentIds: ids });

test("a preview is read-only; eligible delivered families archive only after explicit selection and retain receipts", async () => {
  const f = fixture();
  const scan = await f.engine.scan(scope);
  assert.equal(scan.rows[0].disposition, "eligible");
  assert.equal(f.calls.length, 0);
  const result = await f.engine.execute(selection(scan));
  assert.equal(result.results[0].outcome, "archived");
  assert.deepEqual(f.calls, ["a"]);
  assert.deepEqual(f.receipts.map(entry => entry.outcome), ["started", "archived"]);
  await assert.rejects(f.engine.execute(selection(scan)), /expired/);
});

test("idle and closed agents with unfinished tasks are kept, regardless of age", () => {
  for (const status of ["inbox", "ready", "in_progress", "blocked", "in_review"]) {
    for (const agentStatus of ["idle", "closed"]) assert.equal(row(snapshot({ agents: [agent("a", { status: agentStatus })], tasks: [delivered("task-a", { status })] })).disposition, "keep");
  }
});

test("every linked task and old run binding matters, rather than only the latest task", () => {
  const r = row(snapshot({ tasks: [delivered(), delivered("other", { status: "in_review" })] }));
  assert.equal(r.disposition, "keep");
  assert.match(r.reason, /other/);
});

test("a missing labeled task and incomplete record scan are unknown, never eligible", () => {
  assert.equal(row(snapshot({ agents: [agent("a", { labels: { "mission-control.task-id": "missing" } })] })).disposition, "unknown");
  assert.equal(row(snapshot({ recordsComplete: false })).disposition, "unknown");
});

test("all pending question and decision forms keep the family, including task-only decisions", () => {
  assert.equal(row(snapshot({ pendingAgentIds: ["a"] })).disposition, "keep");
  assert.equal(row(snapshot({ pendingTaskIds: ["task-a"] })).disposition, "keep");
  for (const extra of [{ requiresAttention: true }, { pendingPermissions: [{}] }, { status: "error" }, { activeTurn: { id: "turn" } }, { status: "initializing" }])
    assert.equal(row(snapshot({ agents: [agent("a", extra)] })).disposition, "keep");
  assert.equal(row(snapshot({ agents: [agent("a", { pendingPermissions: null })] })).disposition, "unknown");
});

test("native and legacy descendants in any workspace must be checked for running work", () => {
  for (const label of ["paseo.parent-agent-id", "mission-control.parent-agent-id"]) {
    const state = snapshot({ agents: [agent(), agent("b", { workspaceId: "ws-b", status: "running", labels: { [label]: "a" } })], activity: { a: { at: old, basis: "conversation" }, b: { at: old, basis: "conversation" } } });
    assert.equal(row(state).disposition, "keep");
  }
});

test("internal running helpers and unavailable helper checks prevent archive", () => {
  assert.equal(row(snapshot({ busyHelperAgentIds: ["a"] })).disposition, "keep");
  assert.equal(row(snapshot({ unknownHelperAgentIds: ["a"] })).disposition, "unknown");
  assert.equal(row(snapshot({ agents: [agent("a", { providerUnavailable: true })] })).disposition, "unknown");
});

test("open tabs, keep labels and pinned workspaces protect agents", () => {
  for (const labels of [{ "paseo.open-agent-tab.a": "true" }, { "mission-control.cleanup.keep": "true" }])
    assert.equal(row(snapshot({ agents: [agent("a", { labels })] })).disposition, "keep");
  assert.equal(row(snapshot({ workspaces: [{ id: "ws-a", pinned: true }] })).disposition, "keep");
});

test("age starts after the newest conversation or task update, with configurable thresholds", () => {
  const recent = new Date(now - 2 * 86_400_000).toISOString();
  assert.equal(row(snapshot({ tasks: [delivered("task-a", { updatedAt: recent })] })).disposition, "keep");
  assert.equal(row(snapshot({ activity: { a: { at: recent, basis: "conversation" } } })).disposition, "keep");
  assert.equal(row(snapshot({ activity: { a: { at: recent, basis: "conversation" } }, policy: { deliveredDays: 1, unlinkedDays: 14 } })).disposition, "eligible");
});

test("unlinked old conversations are manual choices, and unfinished workspace tasks protect them", () => {
  let r = row(snapshot({ tasks: [] }));
  assert.equal(r.disposition, "eligible"); assert.equal(r.manualOnly, true);
  r = row(snapshot({ tasks: [delivered("active", { agentIds: ["other"], status: "in_progress" })] }));
  assert.equal(r.disposition, "keep");
});

test("invalid, missing and future dates cannot make an agent eligible", () => {
  for (const at of [null, "bad-date", new Date(now + 1000).toISOString()])
    assert.equal(row(snapshot({ activity: { a: { at, basis: "upper-bound" } } })).disposition, "unknown");
  assert.equal(row(snapshot({ tasks: [delivered("task-a", { updatedAt: "bad-date" })] })).disposition, "unknown");
});

test("family preview reflects native cascade, cross-workspace detach and untouched legacy members", () => {
  const state = snapshot({ agents: [agent(), agent("b", { labels: { "paseo.parent-agent-id": "a" } }),
    agent("c", { workspaceId: "ws-b", labels: { "paseo.parent-agent-id": "a" } }), agent("d", { labels: { "mission-control.parent-agent-id": "a" } })],
    activity: Object.fromEntries(["a", "b", "c", "d"].map(id => [id, { at: old, basis: "conversation" }])) });
  const r = row(state);
  assert.deepEqual(r.archiveIds, ["a", "b"]); assert.deepEqual(r.detachedIds, ["c"]); assert.deepEqual(r.untouchedIds, ["d"]);
  assert.equal(cleanupCandidates(state, { ...scope, agentId: "b" }, now)[0].agentId, "a");
});

test("orphan parents, cycles, unknown workspaces and owners elsewhere are not eligible", () => {
  assert.equal(row(snapshot({ agents: [agent("a", { labels: { "paseo.parent-agent-id": "missing" } })] })).disposition, "unknown");
  const cyclic = snapshot({ agents: [agent("a", { labels: { "paseo.parent-agent-id": "b" } }), agent("b", { labels: { "paseo.parent-agent-id": "a" } })] });
  assert.ok(cleanupCandidates(cyclic, scope, now).every(r => r.disposition === "unknown"));
  assert.equal(row(snapshot({ workspaces: [] })).disposition, "unknown");
});

test("a newer run after delivery or a closed task with outstanding PR evidence is kept", () => {
  assert.equal(row(snapshot({ tasks: [delivered("task-a", { newerRun: true })] })).disposition, "keep");
  assert.equal(row(snapshot({ tasks: [delivered("task-a", { status: "closed", hasPullRequest: true })] })).disposition, "keep");
});

test("resumed work, a new permission, task reopen, pin, activity, settings or child change after scan is skipped", async () => {
  const changes = [
    state => { state.agents[0].status = "running"; }, state => { state.agents[0].pendingPermissions = [{}]; },
    state => { state.tasks[0].status = "in_progress"; }, state => { state.workspaces[0].pinned = true; },
    state => { state.activity.a.at = new Date(now - 1000).toISOString(); }, state => { state.policy.deliveredDays = 6; },
    state => { state.agents.push(agent("b", { labels: { "paseo.parent-agent-id": "a" } })); state.activity.b = { at: old, basis: "conversation" }; },
    state => { state.agents[0].title = "renamed"; }, state => { state.pendingTaskIds.push("task-a"); },
  ];
  for (const change of changes) {
    const f = fixture(), scan = await f.engine.scan(scope); change(f.state);
    assert.equal((await f.engine.execute(selection(scan))).results[0].outcome, "skipped");
    assert.equal(f.calls.length, 0);
  }
});

test("expired previews, wrong hosts, changed scope and IDs absent from the preview do no work", async () => {
  const f = fixture(), scan = await f.engine.scan(scope);
  await assert.rejects(f.engine.scan({ ...scope, serverId: "other-host" }), /selected agent's host/);
  await assert.rejects(f.engine.execute({ ...selection(scan), workspaceId: "ws-b" }), /scope changed/);
  await assert.rejects(f.engine.execute(selection(scan, ["other"])), /eligible/);
  f.now += 5 * 60_000;
  await assert.rejects(f.engine.execute(selection(scan)), /expired/);
  assert.equal(f.calls.length, 0);
});

test("one host admits only one archive operation and duplicate selections archive once", async () => {
  const f = fixture(), scan = await f.engine.scan(scope), second = await f.engine.scan(scope);
  let release;
  f.archive = async id => { f.calls.push(id); await new Promise(resolve => { release = resolve; }); return [id]; };
  const first = f.engine.execute(selection(scan, ["a", "a"]));
  while (!release) await new Promise(resolve => setImmediate(resolve));
  await assert.rejects(f.engine.execute(selection(second)), /Another agent cleanup/);
  release(); await first;
  assert.deepEqual(f.calls, ["a"]);
});

test("ambiguous archive failure records a failure and consumes the preview without automatic retry", async () => {
  const f = fixture(), scan = await f.engine.scan(scope);
  f.archive = async id => { f.calls.push(id); throw new Error("Unconfirmed result; check Paseo"); };
  const result = await f.engine.execute(selection(scan));
  assert.equal(result.results[0].outcome, "failed");
  assert.deepEqual(f.receipts.map(entry => entry.outcome), ["started", "failed"]);
  await assert.rejects(f.engine.execute(selection(scan)), /expired/);
  assert.equal(f.calls.length, 1);
});

test("unwritable intent history prevents the archive from starting", async () => {
  const state = snapshot(); let count = 0;
  const engine = createAgentCleanupEngine({ localServerId: async () => scope.serverId, snapshot: async () => state, now: () => now,
    archive: async () => { count++; return ["a"]; }, record: async () => { throw new Error("disk read only"); } });
  const scan = await engine.scan(scope), result = await engine.execute(selection(scan));
  assert.equal(result.results[0].outcome, "failed"); assert.equal(count, 0);
});
