import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { describeLaunch, launchInput, runCommand } from "./remote.mjs";

const binding = { serverId: "srv_x", workspaceId: "wks_a", taskId: "task_1" };
const preview = (options, problem = null) => ({ source: "template", note: null, problem, options });
const status = extra => ({ revision: "r1", action: "start", message: "", launch: null, run: null, agent: null, worktree: null, canIsolate: true, branch: preview([{ type: null, name: "feature/abc-1", problem: null }]), ...extra });

test("a first start works in its own worktree on the previewed branch, like the Start button", () => {
  assert.deepEqual(launchInput(binding, status(), { provider: "codex/gpt-6.1-sol", thinking: "xhigh", mode: "full-access" }),
    { ...binding, expectedRevision: "r1", provider: "codex/gpt-6.1-sol", thinkingOptionId: "xhigh", modeId: "full-access", isolate: true, branch: "feature/abc-1" });
  const two = status({ branch: preview([{ type: "feature", name: "feature/x", problem: null }, { type: "bugfix", name: "bugfix/x", problem: null }]) });
  assert.deepEqual(launchInput(binding, two, {}), { ...binding, expectedRevision: "r1", isolate: true, branch: "feature/x", branchType: "feature" });
  assert.deepEqual(launchInput(binding, two, { "branch-type": "bugfix" }), { ...binding, expectedRevision: "r1", isolate: true, branch: "bugfix/x", branchType: "bugfix" });
  assert.deepEqual(launchInput(binding, status(), { "no-isolate": true }), { ...binding, expectedRevision: "r1", isolate: false });
  assert.deepEqual(launchInput(binding, status(), { branch: "feature/mine" }), { ...binding, expectedRevision: "r1", isolate: true, branch: "feature/mine" });
});

test("a branch problem stops the start; resume and non-Git projects send only the revision", () => {
  assert.throws(() => launchInput(binding, status({ branch: preview([{ type: null, name: "feature/abc-1", problem: "That branch exists." }]) }), {}), /That branch exists\. Pass --branch/);
  assert.deepEqual(launchInput(binding, status({ action: "resume" }), { provider: "codex/x" }), { ...binding, expectedRevision: "r1" });
  assert.deepEqual(launchInput(binding, status({ canIsolate: false, branch: null }), {}), { ...binding, expectedRevision: "r1" });
});

function fakeHost(responses) {
  const calls = [];
  const rpc = async (method, input) => {
    calls.push([method, input]);
    if (method === "host.identity") return { serverId: "srv_x" };
    const response = responses[method];
    if (!response) throw new Error(`unexpected ${method}`);
    return typeof response === "function" ? response(input) : response;
  };
  return { calls, rpc };
}

test("start leaves a running or blocked task alone and reports why", async () => {
  const host = fakeHost({ "tasks.launch.status": status({ action: "open", message: "Its agent is working.", agent: { id: "a1", name: "n", status: "running", provider: "codex", updatedAt: "t" } }) });
  const result = await runCommand("start", { workspace: "wks_a", task: "task_1" }, host.rpc);
  assert.equal(result.started, false);
  assert.equal(result.action, "open");
  assert.ok(!host.calls.some(([method]) => method === "tasks.launch.dispatch"));
});

test("start dispatches with the status's revision and reports the new run", async () => {
  const run = { runId: "run_1", stage: "intake", outcome: "in_progress", nextAction: "Plan", updatedAt: "t", extra: true };
  const host = fakeHost({ "tasks.launch.status": status({ action: "resume" }), "tasks.launch.dispatch": input => ({ ...status({ action: "open" }), run, input }) });
  const result = await runCommand("start", { workspace: "wks_a", task: "task_1" }, host.rpc);
  assert.deepEqual(host.calls.at(-1), ["tasks.launch.dispatch", { ...binding, expectedRevision: "r1" }]);
  assert.deepEqual(result, { started: true, ...describeLaunch({ ...status({ action: "open" }), run }) });
  assert.deepEqual(result.run, { runId: "run_1", stage: "intake", outcome: "in_progress", nextAction: "Plan", updatedAt: "t" });
});

test("import-ticket reads description and criteria from files and fills the tracker item", async () => {
  const folder = await mkdtemp(join(tmpdir(), "mc-remote-"));
  try {
    await writeFile(join(folder, "d.md"), "  The total is wrong.\n");
    const host = fakeHost({ "tasks.import-ticket": { created: { taskId: "task_1", title: "ABC-1 · Fix", status: "inbox" }, existing: [] } });
    await runCommand("import-ticket", { workspace: "wks_a", system: "jira", key: "ABC-1", url: "https://t.example/ABC-1", title: "Fix", "description-file": join(folder, "d.md") }, host.rpc);
    assert.deepEqual(host.calls.at(-1), ["tasks.import-ticket", { serverId: "srv_x", workspaceId: "wks_a", item: {
      system: "jira", key: "ABC-1", url: "https://t.example/ABC-1", title: "Fix", description: "The total is wrong.", acceptanceCriteria: "", status: "", sprint: "",
    } }]);
    await assert.rejects(runCommand("import-ticket", { workspace: "wks_a", system: "jira" }, host.rpc), /Missing --key, --url, --title/);
  } finally { await rm(folder, { recursive: true, force: true }); }
});

test("set-status and due pass the task's current updatedAt; a task elsewhere is refused", async () => {
  const tasks = { tasks: [{ taskId: "task_1", updatedAt: "u1" }], problems: [] };
  const host = fakeHost({ "tasks.list": tasks, "tasks.status.update": input => ({ taskId: input.taskId, status: input.status }), "tasks.due.update": input => ({ taskId: input.taskId, dueDate: input.dueDate }) });
  assert.deepEqual(await runCommand("set-status", { workspace: "wks_a", task: "task_1", to: "in_review" }, host.rpc), { taskId: "task_1", status: "in_review" });
  assert.deepEqual(host.calls.at(-1)[1], { ...binding, status: "in_review", expectedUpdatedAt: "u1" });
  assert.deepEqual(await runCommand("due", { workspace: "wks_a", task: "task_1", clear: true }, host.rpc), { taskId: "task_1", dueDate: null });
  await assert.rejects(runCommand("set-status", { workspace: "wks_a", task: "task_9", to: "ready" }, host.rpc), /isn't assigned to workspace wks_a/);
});

test("docs lists names, or returns one document's text", async () => {
  const host = fakeHost({ "tasks.documents.list": { documents: [{ name: "task.md", updatedAt: "t", content: "T" }, { name: "handoff.md", updatedAt: "t2", content: "H" }] } });
  assert.deepEqual(await runCommand("docs", { workspace: "wks_a", task: "task_1" }, host.rpc), { documents: [{ name: "task.md", updatedAt: "t" }, { name: "handoff.md", updatedAt: "t2" }] });
  assert.deepEqual(await runCommand("docs", { workspace: "wks_a", task: "task_1", name: "handoff.md" }, host.rpc), { name: "handoff.md", updatedAt: "t2", content: "H" });
  await assert.rejects(runCommand("docs", { workspace: "wks_a", task: "task_1", name: "plan.md" }, host.rpc), /isn't one of the task's documents: task\.md, handoff\.md/);
});

test("there is no command for decisions, merges or pull requests", async () => {
  for (const command of ["resolve", "merge", "pr", "rpc"]) await assert.rejects(runCommand(command, {}, fakeHost({}).rpc), /Unknown command/);
});
