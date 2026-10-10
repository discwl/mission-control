import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

const require = createRequire(import.meta.url);
const ts = require("typescript");
require.extensions[".ts"] = (module, file) => module._compile(ts.transpileModule(readFileSync(file, "utf8"), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText, file);
const { desiredWorkspaceStatuses, parseWorkspaceStatus, statusForTask, workspaceStatusChanges } = require("../shared/workspace-status.ts");
const { createWorkspaceLabelSync, readAppliedStatuses, writeAppliedStatuses } = require("./workspace-labels.ts");

const serverId = "srv_here";
const task = (taskId, status, extra = {}) => ({
  schemaVersion: 1, taskId, hostId: "host", projectId: "prj", title: taskId, acceptanceCriteria: "Done.", status, source: "manual",
  assignments: [{ serverId, workspaceId: "wks_main" }], createdAt: "2026-10-01T00:00:00Z", updatedAt: "2026-10-01T00:00:00Z", ...extra,
});
const worktree = workspaceId => ({ worktree: { workspaceId, branch: "b", baseCommit: "0".repeat(40), sourceWorkspaceId: "wks_main", createdAt: "x" }, assignments: [{ serverId, workspaceId: "wks_main" }, { serverId, workspaceId }] });

test("task states map to status labels; inbox has none", () => {
  assert.deepEqual(["inbox", "ready", "in_progress", "blocked", "in_review", "delivered", "closed"].map(statusForTask),
    [null, "ready", "in-progress", "blocked", "review", "done", "done"]);
});

test("agent label values are read loosely; unknown values are ignored", () => {
  assert.equal(parseWorkspaceStatus("Review"), "review");
  assert.equal(parseWorkspaceStatus("in_progress"), "in-progress");
  assert.equal(parseWorkspaceStatus("In Progress"), "in-progress");
  assert.equal(parseWorkspaceStatus("in-review"), "review");
  assert.equal(parseWorkspaceStatus("none"), null);
  assert.equal(parseWorkspaceStatus("later"), undefined);
  assert.equal(parseWorkspaceStatus(""), undefined);
});

const plain = map => [...map].map(([id, { status, from }]) => [id, status, from]).sort();

test("a task with a worktree labels only that worktree; others label their assigned workspaces on this host", () => {
  const desired = desiredWorkspaceStatuses({ serverId, agents: [], tasks: [
    task("task_a", "in_review", worktree("wks_a")),
    task("task_b", "in_progress", { assignments: [{ serverId, workspaceId: "wks_b" }, { serverId: "srv_other", workspaceId: "wks_far" }] }),
    task("task_c", "inbox", { assignments: [{ serverId, workspaceId: "wks_c" }] }),
  ] });
  assert.deepEqual(plain(desired), [["wks_a", "review", "task"], ["wks_b", "in-progress", "task"]]);
});

test("a workspace shared by several active tasks is left to its coordinator", () => {
  const desired = desiredWorkspaceStatuses({ serverId, agents: [], tasks: [task("task_a", "closed"), task("task_b", "in_review"), task("task_c", "in_progress")] });
  assert.equal(desired.has("wks_main"), false);
  assert.equal(desiredWorkspaceStatuses({ serverId, agents: [], tasks: [task("task_a", "closed"), task("task_b", "blocked")] }).get("wks_main").status, "blocked");
});

test("Done needs every linked task finished and no running agent", () => {
  const tasks = [task("task_a", "closed"), task("task_b", "delivered")];
  assert.equal(desiredWorkspaceStatuses({ serverId, agents: [], tasks }).get("wks_main").status, "done");
  assert.equal(desiredWorkspaceStatuses({ serverId, agents: [{ workspaceId: "wks_main", status: "running" }], tasks }).has("wks_main"), false);
  assert.equal(desiredWorkspaceStatuses({ serverId, agents: [{ workspaceId: "wks_main", status: "idle" }], tasks }).get("wks_main").status, "done");
});

test("an agent's status label overrides tasks, and the latest agent wins", () => {
  const label = value => ({ "mission-control.workspace-status": value });
  const desired = desiredWorkspaceStatuses({ serverId, tasks: [task("task_a", "in_progress")], agents: [
    { workspaceId: "wks_main", updatedAt: "2026-10-09T10:00:00Z", labels: label("blocked") },
    { workspaceId: "wks_main", updatedAt: "2026-10-09T11:00:00Z", labels: label("review") },
    { workspaceId: "wks_x", updatedAt: "2026-10-09T11:00:00Z", labels: label("none") },
    { workspaceId: "wks_y", updatedAt: "2026-10-09T11:00:00Z", labels: label("someday") },
    { workspaceId: null, labels: label("done") },
  ] });
  assert.deepEqual(plain(desired), [["wks_main", "review", "agent"], ["wks_x", null, "agent"]]);
});

test("only changes since the last applied status are planned", () => {
  const entry = status => ({ status, from: "task" });
  const desired = new Map([["a", entry("review")], ["b", entry("done")], ["c", entry(null)], ["d", entry("ready")]]);
  assert.deepEqual(workspaceStatusChanges(desired, { a: "review", b: "in-progress", c: null }).map(change => [change.workspaceId, change.status]), [["b", "done"], ["d", "ready"]]);
});

function fakeDaemon({ labels = [], active = { wks_main: [], wks_a: [] }, agents = [], failOn = null, listError = null } = {}) {
  const calls = [];
  return {
    calls,
    client: {
      async listLabels() { if (listError) throw new Error(listError); return labels; },
      async activeWorkspaces() { return new Map(Object.entries(active)); },
      async agents() { return agents; },
      async setLabel(workspaceId, label, assigned) { if (workspaceId === failOn) throw new Error("boom"); calls.push(`${workspaceId} ${assigned ? "+" : "-"}${label.name}:${label.color}`); },
      async close() { calls.push("close"); },
    },
  };
}

function sync(daemon, tasks, applied = {}) {
  const state = { applied, writes: 0, logs: [] };
  const service = createWorkspaceLabelSync({
    connect: async () => daemon.client, serverId: async () => serverId, tasks: async () => tasks,
    readApplied: async () => state.applied, writeApplied: async next => { state.applied = next; state.writes++; }, log: message => state.logs.push(message),
  });
  return { service, state };
}

test("a sync sets one status label, clears the others and reuses an existing label's color", async () => {
  const daemon = fakeDaemon({ labels: [{ name: "review", color: "pink" }] });
  const { service, state } = sync(daemon, [task("task_a", "in_review")]);
  assert.deepEqual(await service.sync(), { changed: 1, failed: 0 });
  assert.deepEqual(daemon.calls, ["wks_main -Ready:teal", "wks_main -In Progress:sky", "wks_main -Blocked:red", "wks_main -Done:emerald", "wks_main +review:pink", "close"]);
  assert.deepEqual(state.applied, { wks_main: "review" });
});

test("an unchanged status leaves a hand-edited label alone, and archived workspaces are skipped and forgotten", async () => {
  const daemon = fakeDaemon({ active: { wks_main: [] } });
  const { service, state } = sync(daemon, [task("task_a", "in_review"), task("task_b", "ready", worktree("wks_gone"))], { wks_main: "review", wks_gone: "ready" });
  assert.deepEqual(await service.sync(), { changed: 0, failed: 0 });
  assert.deepEqual(daemon.calls, ["close"]);
  assert.deepEqual(state.applied, { wks_main: "review" });
});

test("a failed workspace is retried next time; the rest still apply", async () => {
  const daemon = fakeDaemon({ failOn: "wks_a" });
  const { service, state } = sync(daemon, [task("task_a", "blocked", worktree("wks_a")), task("task_b", "ready")]);
  assert.deepEqual(await service.sync(), { changed: 1, failed: 1 });
  assert.deepEqual(state.applied, { wks_main: "ready" });
  assert.match(state.logs[0], /wks_a/);
});

test("a paused workspace keeps its labels against task changes, but an agent's status label still applies", async () => {
  const daemon = fakeDaemon({ active: { wks_main: ["paused"], wks_a: ["Paused"] }, agents: [{ workspaceId: "wks_a", updatedAt: "2026-10-09T11:00:00Z", labels: { "mission-control.workspace-status": "review" } }] });
  const { service, state } = sync(daemon, [task("task_a", "in_review"), task("task_b", "ready", worktree("wks_a"))]);
  assert.deepEqual(await service.sync(), { changed: 1, failed: 0 });
  assert.deepEqual(state.applied, { wks_a: "review" });
  assert.ok(daemon.calls.includes("wks_a +Review:violet"));
  assert.ok(!daemon.calls.some(call => call.startsWith("wks_main")));
});

test("a daemon without workspace labels turns the sync off", async () => {
  const daemon = fakeDaemon({ listError: "Unknown message type: workspace.label.list.request" });
  const { service, state } = sync(daemon, [task("task_a", "ready")]);
  assert.deepEqual(await service.sync(), { skipped: "unsupported" });
  assert.deepEqual(await service.sync(), { skipped: "unsupported" });
  assert.equal(state.logs.length, 1);
});

test("overlapping syncs share one run", async () => {
  const daemon = fakeDaemon();
  const { service } = sync(daemon, [task("task_a", "ready")]);
  const [first, second] = await Promise.all([service.sync(), service.sync()]);
  assert.deepEqual(first, { changed: 1, failed: 0 });
  assert.deepEqual(second, { skipped: "running" });
});

test("applied statuses round-trip through the plugin data file and ignore unknown values", async () => {
  const folder = await mkdtemp(join(tmpdir(), "mc-labels-"));
  try {
    const file = join(folder, "nested", "workspace-status-labels.json");
    assert.deepEqual(await readAppliedStatuses(file), {});
    await writeAppliedStatuses({ a: "review", b: null }, file);
    assert.deepEqual(await readAppliedStatuses(file), { a: "review", b: null });
    const raw = JSON.parse(await readFile(file, "utf8"));
    raw.workspaces.c = "someday";
    await writeAppliedStatuses(raw.workspaces, file);
    assert.deepEqual(await readAppliedStatuses(file), { a: "review", b: null });
  } finally { await rm(folder, { recursive: true, force: true }); }
});
