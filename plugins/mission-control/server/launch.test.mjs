import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import fsPromises, { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

const require = createRequire(import.meta.url);
const ts = require("typescript");
require.extensions[".ts"] = (module, file) => module._compile(ts.transpileModule(readFileSync(file, "utf8"), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText, file);
const { createTaskLauncher } = require("./launch.ts");
const { taskPromptText } = require("./runs.ts");
const parse = text => Object.fromEntries(/^---\n([\s\S]*?)\n---/.exec(text)[1].split("\n").map(line => [line.slice(0, line.indexOf(":")), JSON.parse(line.slice(line.indexOf(":") + 1))]));
const markdown = fields => `---\n${Object.entries(fields).map(([key, value]) => `${key}: ${JSON.stringify(value)}`).join("\n")}\n---\n`;

async function fixture(t) {
  const folder = await mkdtemp(join(tmpdir(), "mission-launch-"));
  t.after(() => rm(folder, { recursive: true, force: true }));
  const input = { taskId: "task_aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa", serverId: "personal", workspaceId: "workspace" };
  const task = { ...input, hostId: "personal", projectId: "project", title: "Launch proof", status: "ready", updatedAt: "2026-09-23T00:00:00Z", assignments: [{ serverId: input.serverId, workspaceId: input.workspaceId }] };
  const agents = new Map();
  const state = { creates: 0, createCalls: 0, sends: 0, prompts: [], configs: [], loseCreateResponse: false, loseSendResponse: false, rejectCreate: false, refreshError: null, denyContext: false };
  async function run() {
    let names;
    try { names = (await readdir(join(folder, "runs"))).filter(name => /^run_[a-f0-9-]+$/.test(name)); }
    catch (error) { if (error.code === "ENOENT") return null; throw error; }
    if (!names.length) return null;
    assert.equal(names.length, 1, "one run per launch attempt");
    return parse(await readFile(join(folder, "runs", names[0], "run.md"), "utf8"));
  }
  const deps = {
    loadContext: async binding => {
      assert.deepEqual({ ...binding, expectedRevision: undefined, provider: undefined, modeId: undefined, thinkingOptionId: undefined }, { ...input, expectedRevision: undefined, provider: undefined, modeId: undefined, thinkingOptionId: undefined });
      if (state.denyContext) throw Error("Project profile mismatch");
      return { folder, task, cwd: folder, kitRoot: folder, git: { head: null, dirty: false, changes: [], omittedChanges: 0 }, run: await run() };
    },
    taskAgentPrompt: async (workspaceId, taskId) => ({ title: task.title, prompt: `Bound task ${taskId} on ${workspaceId}` }),
  };
  const paseo = {
    workspaces: { ref: id => ({ agents: { create: async options => {
      assert.equal(id, input.workspaceId);
      assert.equal(options.prompt, undefined, "creation must not dispatch work");
      state.createCalls++;
      state.configs.push(options.config);
      if (state.rejectCreate) throw Error("Provider unavailable");
      if (!agents.has(options.agentId)) {
        state.creates++;
        agents.set(options.agentId, { id: options.agentId, title: task.title, provider: "codex", cwd: folder, workspaceId: id, status: "idle", activeTurn: null, pendingPermissions: [], lastUserMessageAt: null, updatedAt: "2026-09-23T00:00:00Z", archivedAt: null });
      }
      if (state.loseCreateResponse) { state.loseCreateResponse = false; throw Error("Creation response lost"); }
      return { id: options.agentId };
    } } }) },
    agents: { ref: id => ({
      refresh: async () => {
        if (state.refreshError) throw Error(state.refreshError);
        if (!agents.has(id)) throw Error(`Agent not found: ${id}`);
        return { agent: { ...agents.get(id) } };
      },
      send: async (prompt, options) => {
        const current = await run();
        assert.equal(current.agentId, id, "run must be persisted before dispatch");
        assert.ok(prompt.includes(current.runId));
        assert.ok(prompt.includes(input.taskId));
        assert.ok(prompt.includes(input.workspaceId));
        assert.ok(options.messageId);
        state.sends++; state.prompts.push(prompt);
        Object.assign(agents.get(id), { status: "running", activeTurn: { turnId: "turn", startedAt: new Date().toISOString() }, lastUserMessageAt: new Date().toISOString(), updatedAt: new Date().toISOString() });
        if (state.loseSendResponse) throw Error("Send response lost");
      },
    }) },
  };
  const launcher = createTaskLauncher(deps);
  const start = async () => launcher.dispatch({ ...input, expectedRevision: (await launcher.status(input, paseo)).revision, provider: "codex/model" }, paseo);
  return { input, task, state, agents, deps, paseo, launcher, start, run, folder };
}

test("recovery fails closed on malformed or mismatched exact-ID responses", async t => {
  for (const response of [undefined, {}, { agent: { id: "different-agent" } }]) {
    const f = await fixture(t);
    f.state.rejectCreate = true;
    await assert.rejects(f.start(), /Provider unavailable/);
    const before = await f.launcher.status(f.input, f.paseo), original = f.paseo.agents.ref;
    f.paseo.agents.ref = () => ({ refresh: async () => response });
    await assert.rejects(f.launcher.dispatch({ ...f.input, expectedRevision: before.revision }, f.paseo), /lookup was not confirmed/);
    f.paseo.agents.ref = original;
    assert.deepEqual((await f.launcher.status(f.input, f.paseo)).launch, before.launch);
    assert.equal(f.state.createCalls, 1);
    assert.equal(f.state.sends, 0);
  }
});

test("an absent reserved worker cannot silently change configuration or creation identity", async t => {
  const f = await fixture(t);
  f.state.rejectCreate = true;
  await assert.rejects(f.start(), /Provider unavailable/);
  const before = await f.launcher.status(f.input, f.paseo), run = await f.run();
  await assert.rejects(f.launcher.dispatch({ ...f.input, expectedRevision: before.revision, provider: "opencode/go/model", modeId: "build", thinkingOptionId: "max" }, f.paseo), /absent worker cannot be reconfigured/);
  assert.deepEqual((await f.launcher.status(f.input, f.paseo)).launch, before.launch);
  assert.deepEqual(await f.run(), run);
  assert.equal(f.state.createCalls, 1);
  assert.equal(f.state.sends, 0);
});

test("native worker parent survives preparation recovery and is passed to the single task agent", async t => {
  const f = await fixture(t), parent = { serverId: "orchestrator-host", agentId: "orchestrator-chat" }, parents = [];
  const originalContext = f.deps.loadContext;
  f.deps.loadContext = ({ parent: ignored, ...binding }) => originalContext(binding);
  const originalRef = f.paseo.workspaces.ref;
  f.paseo.workspaces.ref = id => ({ agents: { create: options => { parents.push(options.parent); return originalRef(id).agents.create(options); } } });
  const originalAgentRef = f.paseo.agents.ref;
  f.paseo.agents.ref = id => ({ ...originalAgentRef(id), address: { serverId: f.input.serverId, agentId: id } });
  f.paseo.hosts = { client: async () => { throw Error("Reverse host connections are forbidden"); } };
  const launcher = createTaskLauncher(f.deps);
  f.state.rejectCreate = true;
  await assert.rejects(launcher.dispatch({ ...f.input, parent, expectedRevision: (await launcher.status(f.input, f.paseo)).revision, provider: "codex/model" }, f.paseo), /Provider unavailable/);
  const failed = await launcher.status(f.input, f.paseo);
  assert.deepEqual(failed.launch.parent, parent);
  assert.equal(failed.action, "recover");
  f.state.rejectCreate = false;
  const recovered = await launcher.dispatch({ ...f.input, parent: { serverId: "other", agentId: "other" }, expectedRevision: failed.revision }, f.paseo);
  assert.equal(f.state.creates, 1); assert.equal(f.state.sends, 1);
  assert.deepEqual(parents, [parent, parent]);
  assert.deepEqual(recovered.launch.parent, parent);
});

test("missing reserved agents recover after definite create failure without swallowing connection errors", async t => {
  const f = await fixture(t);
  f.state.rejectCreate = true;
  await assert.rejects(f.start(), /Provider unavailable/);
  const reserved = await f.run();
  assert.equal(f.agents.size, 0);
  const reloaded = createTaskLauncher(f.deps);
  const recovery = await reloaded.status(f.input, f.paseo);
  assert.equal(recovery.action, "recover");
  assert.equal(recovery.agent, null);
  f.state.refreshError = "Connection closed";
  await assert.rejects(reloaded.status(f.input, f.paseo), /Connection closed/);
  f.state.refreshError = null;
  f.state.rejectCreate = false;
  await reloaded.dispatch({ ...f.input, expectedRevision: recovery.revision }, f.paseo);
  assert.equal(f.state.creates, 1);
  assert.equal(f.state.sends, 1);
  assert.equal((await f.run()).agentId, reserved.agentId);
  assert.equal((await f.run()).runId, reserved.runId);
});

test("the chosen permission mode and effort reach the new agent, including after a recovered launch", async t => {
  const f = await fixture(t);
  // loadContext only checks the task binding, so leave the agent settings out of it.
  const launcher = createTaskLauncher({ ...f.deps, loadContext: ({ modeId, thinkingOptionId, ...binding }, paseo) => f.deps.loadContext(binding, paseo) });
  f.state.rejectCreate = true;
  const choice = { provider: "claude/opus", modeId: "bypassPermissions", thinkingOptionId: "high" };
  await assert.rejects(launcher.dispatch({ ...f.input, expectedRevision: (await launcher.status(f.input, f.paseo)).revision, ...choice }, f.paseo), /Provider unavailable/);
  f.state.rejectCreate = false;
  const recovery = await launcher.status(f.input, f.paseo);
  assert.equal(recovery.action, "recover");
  await launcher.dispatch({ ...f.input, expectedRevision: recovery.revision }, f.paseo);
  assert.deepEqual(f.state.configs, [choice, choice]);
  assert.equal(f.state.sends, 1);
});

test("a launch without a mode or effort leaves both to the provider default", async t => {
  const f = await fixture(t);
  await f.start();
  assert.deepEqual(f.state.configs, [{ provider: "codex/model" }]);
});

test("interrupted run publication stays invisible to real run readers and can recover", async t => {
  const f = await fixture(t);
  const originalRename = fsPromises.rename;
  const rename = t.mock.method(fsPromises, "rename", async (from, to) => {
    if (from.includes(".preparing-run_") && /[\\/]run_[a-f0-9-]+$/.test(to)) throw Error("Interrupted before run publication");
    return originalRename(from, to);
  });
  await assert.rejects(f.start(), /Interrupted before run publication/);
  rename.mock.restore();
  assert.equal(await f.run(), null);
  const taskModule = require("./tasks.ts");
  const { listRunRecords } = require("./runs.ts");
  t.mock.method(taskModule, "assignedTask", async () => ({ folder: f.folder, task: f.task }));
  assert.deepEqual(await listRunRecords(f.input.serverId, f.input.workspaceId, f.input.taskId), []);
  const recovery = await f.launcher.status(f.input, f.paseo);
  assert.equal(recovery.action, "recover");
  await f.launcher.dispatch({ ...f.input, expectedRevision: recovery.revision }, f.paseo);
  const runs = await listRunRecords(f.input.serverId, f.input.workspaceId, f.input.taskId);
  assert.equal(runs.length, 1);
  assert.equal(runs[0].runId, recovery.launch.runId);
  assert.equal(f.state.sends, 1);
});

test("a leftover lock file cannot block a fresh runtime and module reloads share active exclusion", async t => {
  const f = await fixture(t);
  await writeFile(join(f.folder, ".mission-control-launch.lock"), "old process");
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  let entered;
  const atCreate = new Promise(resolve => { entered = resolve; });
  const originalRef = f.paseo.workspaces.ref;
  f.paseo.workspaces.ref = id => {
    const workspace = originalRef(id);
    const create = workspace.agents.create;
    workspace.agents.create = async options => { entered(); await gate; return create(options); };
    return workspace;
  };
  const pending = f.start();
  await atCreate;
  try {
    delete require.cache[require.resolve("./launch.ts")];
    const reloaded = require("./launch.ts").createTaskLauncher(f.deps);
    const current = await reloaded.status(f.input, f.paseo);
    await assert.rejects(reloaded.dispatch({ ...f.input, expectedRevision: current.revision }, f.paseo), /already in progress/);
  } finally { release(); }
  await pending;
  assert.equal(f.state.creates, 1);
  assert.equal(f.state.sends, 1);
});

test("a failed inactive turn can resume without fabricating progress or changing its configuration", async t => {
  const f = await fixture(t);
  await f.start();
  const worker = f.agents.get((await f.run()).agentId);
  Object.assign(worker, { status: "idle", activeTurn: null, attentionReason: "error" });
  // Even an unchanged message timestamp must not hide a terminal error.
  const launch = (await f.launcher.status(f.input, f.paseo)).launch;
  worker.lastUserMessageAt = launch.lastUserMessageAt;
  const failed = await f.launcher.status(f.input, f.paseo);
  assert.equal(failed.action, "resume");
  assert.match(failed.message, /failed/);
  await assert.rejects(f.launcher.dispatch({ ...f.input, expectedRevision: failed.revision, provider: "codex/new-model" }, f.paseo), /not applied/);
  assert.equal(f.state.sends, 1);
  await f.launcher.dispatch({ ...f.input, expectedRevision: failed.revision }, f.paseo);
  assert.equal(f.state.sends, 2);
  assert.equal(f.state.creates, 1);
});

test("start persists an exact run before sending, and busy agents only offer Open", async t => {
  const f = await fixture(t);
  const result = await f.start();
  assert.equal(result.action, "open");
  assert.equal(result.launch.phase, "sent");
  assert.equal(result.run.agentId, result.agent.id);
  assert.equal(f.state.creates, 1); assert.equal(f.state.sends, 1);
  await assert.rejects(f.launcher.dispatch({ ...f.input, expectedRevision: result.revision }, f.paseo), /active/);
});

test("separate clients cannot dispatch the same task revision twice", async t => {
  const f = await fixture(t);
  const revision = (await f.launcher.status(f.input, f.paseo)).revision;
  const request = { ...f.input, expectedRevision: revision, provider: "codex/model" };
  const other = createTaskLauncher(f.deps);
  const results = await Promise.allSettled([f.launcher.dispatch(request, f.paseo), other.dispatch(request, f.paseo)]);
  assert.equal(results.filter(result => result.status === "fulfilled").length, 1);
  assert.equal(f.state.creates, 1); assert.equal(f.state.sends, 1);
});

test("stale task revisions and failed context checks never launch an agent", async t => {
  const f = await fixture(t);
  const revision = (await f.launcher.status(f.input, f.paseo)).revision;
  f.task.updatedAt = "2026-09-24T00:00:00Z";
  await assert.rejects(f.launcher.dispatch({ ...f.input, expectedRevision: revision, provider: "codex/model" }, f.paseo), /changed/);
  f.state.denyContext = true;
  await assert.rejects(f.start(), /profile mismatch/);
  assert.equal(f.state.creates, 0); assert.equal(f.state.sends, 0);
});

test("resume after reload keeps the same run and linked agent", async t => {
  const f = await fixture(t);
  const first = await f.start();
  const current = await f.run();
  await writeFile(join(f.folder, "runs", current.runId, "run.md"), markdown({ ...current, stage: "plan", outcome: "waiting", nextAction: "Review the plan", updatedAt: "2026-09-25T00:00:00Z" }));
  Object.assign(f.agents.get(first.agent.id), { status: "idle", activeTurn: null, attentionReason: "finished" });
  const reloaded = createTaskLauncher(f.deps);
  const status = await reloaded.status(f.input, f.paseo);
  assert.equal(status.action, "resume");
  const next = await reloaded.dispatch({ ...f.input, expectedRevision: status.revision }, f.paseo);
  assert.equal(next.run.runId, first.run.runId);
  assert.equal(next.agent.id, first.agent.id);
  assert.equal(f.state.creates, 1); assert.equal(f.state.sends, 2);
});

test("a moved or archived agent cannot be resumed", async t => {
  const f = await fixture(t);
  const first = await f.start();
  const agent = f.agents.get(first.agent.id);
  agent.workspaceId = "another-workspace";
  await assert.rejects(f.launcher.status(f.input, f.paseo), /another workspace/);
  agent.workspaceId = f.input.workspaceId; agent.archivedAt = "2026-09-24T00:00:00Z";
  assert.equal((await f.launcher.status(f.input, f.paseo)).action, "blocked");
  assert.equal(f.state.sends, 1);
});

test("preparation recovery reuses the reserved agent id and run", async t => {
  const f = await fixture(t);
  f.state.loseCreateResponse = true;
  await assert.rejects(f.start(), /Creation response lost/);
  const before = await f.run();
  const reloaded = createTaskLauncher(f.deps);
  const status = await reloaded.status(f.input, f.paseo);
  assert.equal(status.action, "recover");
  const result = await reloaded.dispatch({ ...f.input, expectedRevision: status.revision }, f.paseo);
  assert.equal(result.run.runId, before.runId);
  assert.equal(f.state.creates, 1); assert.equal(f.state.sends, 1);
});

test("uncertain prompt delivery stays visible across reload and is never auto-retried", async t => {
  const f = await fixture(t);
  f.state.loseSendResponse = true;
  await assert.rejects(f.start(), /Send response lost/);
  const reloaded = createTaskLauncher(f.deps);
  const status = await reloaded.status(f.input, f.paseo);
  assert.equal(status.action, "blocked"); assert.equal(status.launch.phase, "sending");
  assert.match(status.message, /unconfirmed/);
  await assert.rejects(reloaded.dispatch({ ...f.input, expectedRevision: status.revision }, f.paseo), /unconfirmed/);
  assert.equal(f.state.creates, 1); assert.equal(f.state.sends, 1);
});

test("a first start can create the task's own worktree and runs the agent there", async t => {
  const f = await fixture(t);
  let worktree = null;
  const created = [];
  const prompts = [];
  const calls = { worktrees: 0 };
  const paseo = {
    workspaces: { ref: id => ({ agents: { create: async options => {
      created.push(id);
      f.agents.set(options.agentId, { id: options.agentId, title: f.task.title, provider: "codex", cwd: f.folder, workspaceId: id, status: "idle", activeTurn: null, pendingPermissions: [], lastUserMessageAt: null, updatedAt: "2026-09-23T00:00:00Z", archivedAt: null });
      return { id: options.agentId };
    } } }) },
    agents: { ref: id => ({
      refresh: async () => { if (!f.agents.has(id)) throw Error(`Agent not found: ${id}`); return { agent: { ...f.agents.get(id) } }; },
      send: async prompt => { prompts.push(prompt); Object.assign(f.agents.get(id), { status: "running", activeTurn: { turnId: "t", startedAt: new Date().toISOString() } }); },
    }) },
  };
  const launcher = createTaskLauncher({
    taskAgentPrompt: async (workspaceId, taskId) => ({ title: f.task.title, prompt: `Bound task ${taskId} on ${workspaceId}` }),
    loadContext: async binding => {
      const run = await f.run();
      const task = worktree ? { ...f.task, worktree, assignments: [...f.task.assignments, { serverId: binding.serverId, workspaceId: worktree.workspaceId }] } : f.task;
      return { folder: f.folder, task, cwd: f.folder, kitRoot: f.folder, git: { head: "b".repeat(40), dirty: false, changes: [], omittedChanges: 0 }, run, workspaceId: worktree?.workspaceId ?? binding.workspaceId, canIsolate: !worktree && !run };
    },
    createWorktree: async ({ sourceCwd }) => {
      calls.worktrees++;
      assert.equal(sourceCwd, f.folder);
      return { workspaceId: "worktree-ws", branch: "task/aaaaaaaa-launch-proof", baseCommit: "c".repeat(40), directory: f.folder };
    },
    attachWorktree: async ({ worktree: next }) => { assert.equal(next.sourceWorkspaceId, f.input.workspaceId); worktree = next; },
  });
  const before = await launcher.status(f.input, paseo);
  assert.equal(before.canIsolate, true);
  assert.equal(before.worktree, null);
  await launcher.dispatch({ ...f.input, expectedRevision: before.revision, provider: "codex/model", isolate: true }, paseo);
  assert.equal(calls.worktrees, 1);
  assert.deepEqual(created, ["worktree-ws"], "the agent is created in the worktree workspace");
  assert.equal((await f.run()).workspaceId, "worktree-ws");
  assert.match(prompts[0], /on worktree-ws/);
  // Opened again from the source workspace, the task still resolves to its worktree.
  const after = await launcher.status(f.input, paseo);
  assert.deepEqual(after.worktree, { workspaceId: "worktree-ws", branch: "task/aaaaaaaa-launch-proof", baseCommit: "c".repeat(40) });
  assert.equal(after.canIsolate, false);
  assert.equal(after.launch.workspaceId, "worktree-ws");
});

test("isolation is refused when the task cannot start in its own worktree", async t => {
  const f = await fixture(t);
  const launcher = createTaskLauncher({
    ...f.deps,
    loadContext: async binding => ({ ...(await f.deps.loadContext({ serverId: binding.serverId, workspaceId: binding.workspaceId, taskId: binding.taskId })), canIsolate: false }),
    createWorktree: async () => { throw Error("must not create a worktree"); },
  });
  const status = await launcher.status(f.input, f.paseo);
  assert.equal(status.canIsolate, false);
  await assert.rejects(launcher.dispatch({ ...f.input, expectedRevision: status.revision, provider: "codex/model", isolate: true }, f.paseo), /can't start in its own worktree/);
  assert.equal(f.state.creates, 0);
});

// A launcher whose task can start in its own worktree; `preview` stands in for the branch-name settings.
async function isolatedLauncher(t, preview) {
  const f = await fixture(t);
  const requested = [];
  const launcher = createTaskLauncher({
    ...f.deps,
    loadContext: async binding => ({ ...(await f.deps.loadContext({ serverId: binding.serverId, workspaceId: binding.workspaceId, taskId: binding.taskId })), workspaceId: binding.workspaceId, canIsolate: true }),
    branchPreview: async (task, serverId) => { assert.equal(task.taskId, f.input.taskId); assert.equal(serverId, f.input.serverId); return preview.current(); },
    createWorktree: async input => { requested.push(input.branch); throw Error("stop after the worktree request"); },
  });
  const start = async (extra = {}) => launcher.dispatch({ ...f.input, expectedRevision: (await launcher.status(f.input, f.paseo)).revision, provider: "codex/model", isolate: true, ...extra }, f.paseo);
  return { f, launcher, requested, start };
}
const choosable = { source: "template", note: null, problem: null, options: [
  { type: "feature", name: "feature/ABC-123-add-login-retry", problem: null },
  { type: "bugfix", name: "bugfix/ABC-123-add-login-retry", problem: null },
] };

test("the default launcher previews task/<id>-<slug> and keeps that name for the worktree", async t => {
  const f = await fixture(t);
  const requested = [];
  const launcher = createTaskLauncher({
    ...f.deps,
    loadContext: async binding => ({ ...(await f.deps.loadContext({ serverId: binding.serverId, workspaceId: binding.workspaceId, taskId: binding.taskId })), workspaceId: binding.workspaceId, canIsolate: true }),
    createWorktree: async input => { requested.push(input); throw Error("stop after the worktree request"); },
  });
  const status = await launcher.status(f.input, f.paseo);
  assert.deepEqual(status.branch, { source: "default", note: null, problem: null, options: [{ type: null, name: "task/aaaaaaaa-launch-proof", problem: null }] });
  await assert.rejects(launcher.dispatch({ ...f.input, expectedRevision: status.revision, provider: "codex/model", isolate: true, branch: "task/aaaaaaaa-launch-proof" }, f.paseo), /stop after/);
  assert.equal(Object.hasOwn(requested[0], "branch"), false, "the default name is left to createTaskWorktree");
});

test("a templated start creates the previewed branch for the chosen type", async t => {
  const { f, launcher, requested, start } = await isolatedLauncher(t, { current: () => choosable });
  assert.deepEqual((await launcher.status(f.input, f.paseo)).branch, choosable);
  await assert.rejects(start(), /Choose Feature or Bugfix/);
  await assert.rejects(start({ branchType: "bugfix", branch: "feature/ABC-123-add-login-retry" }), /branch name changed/);
  assert.deepEqual(requested, []);
  await assert.rejects(start({ branchType: "bugfix", branch: "bugfix/ABC-123-add-login-retry" }), /stop after/);
  assert.deepEqual(requested, ["bugfix/ABC-123-add-login-retry"]);
  assert.equal(f.state.creates, 0);
});

test("a changed template, an invalid name, or unreadable settings stop the worktree start", async t => {
  const preview = { current: () => ({ source: "template", note: null, problem: null, options: [{ type: null, name: "ABC-123-add-login-retry", problem: null }] }) };
  const { f, launcher, requested } = await isolatedLauncher(t, preview);
  const seen = await launcher.status(f.input, f.paseo);
  preview.current = () => ({ source: "template", note: null, problem: null, options: [{ type: null, name: "feature/ABC-123-add-login-retry", problem: null }] });
  await assert.rejects(launcher.dispatch({ ...f.input, expectedRevision: seen.revision, provider: "codex/model", isolate: true, branch: "ABC-123-add-login-retry" }, f.paseo), /changed\. Refresh/);
  preview.current = () => ({ source: "template", note: null, problem: null, options: [{ type: null, name: "ABC 123-x", problem: "It can't contain spaces." }] });
  let status = await launcher.status(f.input, f.paseo);
  await assert.rejects(launcher.dispatch({ ...f.input, expectedRevision: status.revision, provider: "codex/model", isolate: true }, f.paseo), /ABC 123-x can't be used: It can't contain spaces/);
  preview.current = () => { throw Error("branch name settings can't be read"); };
  status = await launcher.status(f.input, f.paseo);
  assert.deepEqual(status.branch, { source: "template", note: null, problem: "branch name settings can't be read", options: [] });
  await assert.rejects(launcher.dispatch({ ...f.input, expectedRevision: status.revision, provider: "codex/model", isolate: true }, f.paseo), /settings can't be read/);
  assert.deepEqual(requested, []);
  assert.equal(f.state.creates, 0);
});

test("a task that can't isolate gets no branch preview", async t => {
  const f = await fixture(t);
  const launcher = createTaskLauncher({ ...f.deps, branchPreview: async () => { throw Error("must not preview"); } });
  assert.equal((await launcher.status(f.input, f.paseo)).branch, null);
});

async function untilSettled(launcher, input, paseo) {
  for (let tries = 0; tries < 200; tries++) {
    const current = await launcher.status(input, paseo);
    if (current.action !== "starting") return current;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  throw new Error("The launch never finished.");
}

test("a launch that outlasts the reply reports it's starting, then shows its result", async t => {
  const f = await fixture(t);
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const originalRef = f.paseo.workspaces.ref;
  f.paseo.workspaces.ref = id => {
    const workspace = originalRef(id);
    const create = workspace.agents.create;
    workspace.agents.create = async options => { await gate; return create(options); };
    return workspace;
  };
  const launcher = createTaskLauncher({ ...f.deps, replyWithinMs: 20 });
  const reply = await launcher.dispatch({ ...f.input, expectedRevision: (await launcher.status(f.input, f.paseo)).revision, provider: "codex/model" }, f.paseo);
  assert.equal(reply.action, "starting");
  assert.match(reply.message, /Starting the task/);
  assert.equal((await launcher.status(f.input, f.paseo)).action, "starting");
  await assert.rejects(launcher.dispatch({ ...f.input, expectedRevision: reply.revision, provider: "codex/model" }, f.paseo), /already in progress/);
  release();
  const done = await untilSettled(launcher, f.input, f.paseo);
  assert.equal(done.action, "open");
  assert.equal(done.launch.phase, "sent");
  assert.equal(f.state.sends, 1);
});

test("a quick launch still replies with its final status, and a quick failure is still an error", async t => {
  const f = await fixture(t);
  f.state.rejectCreate = true;
  await assert.rejects(f.start(), /Provider unavailable/);
  f.state.rejectCreate = false;
  const status = await f.launcher.status(f.input, f.paseo);
  assert.equal(status.action, "recover");
  for (const override of [{ provider: "codex/other" }, { modeId: "other-mode" }, { thinkingOptionId: "other-effort" }]) {
    await assert.rejects(f.launcher.dispatch({ ...f.input, expectedRevision: status.revision, ...override }, f.paseo), /not applied/);
  }
  const done = await f.launcher.dispatch({ ...f.input, expectedRevision: status.revision }, f.paseo);
  assert.equal(done.action, "open");
});

test("a worktree failure after the reply shows on the next status", async t => {
  const f = await fixture(t);
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const launcher = createTaskLauncher({
    ...f.deps, replyWithinMs: 20,
    loadContext: async binding => ({ ...(await f.deps.loadContext({ serverId: binding.serverId, workspaceId: binding.workspaceId, taskId: binding.taskId })), git: { head: "b".repeat(40), dirty: false, changes: [], omittedChanges: 0 }, workspaceId: binding.workspaceId, canIsolate: true }),
    createWorktree: async () => { await gate; throw Error("Disk full"); },
    attachWorktree: async () => { throw Error("never attached"); },
  });
  const before = await launcher.status(f.input, f.paseo);
  const reply = await launcher.dispatch({ ...f.input, expectedRevision: before.revision, provider: "codex/model", isolate: true }, f.paseo);
  assert.equal(reply.action, "starting");
  release();
  const done = await untilSettled(launcher, f.input, f.paseo);
  assert.equal(done.action, "start");
  assert.match(done.message, /The last start didn't finish: Disk full/);
  assert.equal(await f.run(), null, "no run was published");
});

test("a slow retry of an interrupted launch doesn't show the previous attempt's error", async t => {
  const f = await fixture(t);
  f.state.rejectCreate = true;
  await assert.rejects(f.start(), /Provider unavailable/);
  f.state.rejectCreate = false;
  const recovery = await f.launcher.status(f.input, f.paseo);
  assert.equal(recovery.action, "recover");
  assert.equal(recovery.launch.error, "Provider unavailable");
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const originalRef = f.paseo.workspaces.ref;
  f.paseo.workspaces.ref = id => {
    const workspace = originalRef(id);
    const create = workspace.agents.create;
    workspace.agents.create = async options => { await gate; return create(options); };
    return workspace;
  };
  const launcher = createTaskLauncher({ ...f.deps, replyWithinMs: 20 });
  const reply = await launcher.dispatch({ ...f.input, expectedRevision: recovery.revision }, f.paseo);
  assert.equal(reply.action, "starting");
  assert.equal(reply.launch.error, null, "the retry cleared the old error when it started");
  release();
  const done = await untilSettled(launcher, f.input, f.paseo);
  assert.equal(done.action, "open");
  assert.equal(done.launch.error, null);
});

const busy = () => Object.assign(new Error("EPERM: operation not permitted, rename"), { code: "EPERM" });

test("saving a launch record retries a rename Windows briefly refuses", async t => {
  const f = await fixture(t);
  const originalRename = fsPromises.rename;
  let refused = 0;
  t.mock.method(fsPromises, "rename", async (from, to) => {
    if (to.endsWith(".mission-control-launch.json") && refused < 2) { refused++; throw busy(); }
    return originalRename(from, to);
  });
  const result = await f.start();
  assert.equal(refused, 2);
  assert.equal(result.action, "open");
  assert.equal(result.launch.phase, "sent");
  assert.equal(f.state.sends, 1);
  assert.deepEqual((await readdir(f.folder)).filter(name => name.endsWith(".tmp")), [], "no temporary record is left behind");
});

test("publishing a prepared run folder retries a rename Windows briefly refuses", async t => {
  const f = await fixture(t);
  const originalRename = fsPromises.rename;
  let refused = 0;
  t.mock.method(fsPromises, "rename", async (from, to) => {
    // An indexer or virus scanner holding run.md blocks renaming its folder.
    if (/[\\/]\.preparing-run_[^\\/]+$/.test(from) && refused < 3) { refused++; throw busy(); }
    return originalRename(from, to);
  });
  const result = await f.start();
  assert.equal(refused, 3);
  assert.equal(result.launch.phase, "sent");
  assert.deepEqual((await readdir(join(f.folder, "runs"))).filter(name => name.startsWith(".preparing-")), [], "no staging folder is left behind");
});

test("saving a launch record gives up after the last retry, and other errors aren't retried", async t => {
  const f = await fixture(t);
  const originalRename = fsPromises.rename;
  let attempts = 0;
  let failure = busy;
  t.mock.method(fsPromises, "rename", async (from, to) => {
    if (to.endsWith(".mission-control-launch.json")) { attempts++; throw failure(); }
    return originalRename(from, to);
  });
  await assert.rejects(f.start(), { code: "EPERM" });
  assert.equal(attempts, 15);
  assert.equal(f.state.createCalls, 0, "nothing launches without a saved record");
  assert.deepEqual((await readdir(f.folder)).filter(name => name.endsWith(".tmp")), []);
  attempts = 0;
  failure = () => Object.assign(new Error("ENOENT: no such file or directory, rename"), { code: "ENOENT" });
  await assert.rejects(f.start(), { code: "ENOENT" });
  assert.equal(attempts, 1);
});

// The automatic runner's first step for a code task: its own worktree, created like Start's, before any agent exists.
async function preparingLauncher(t, { preview = choosable, createWorktree, replyWithinMs = 2_000, canIsolate = true } = {}) {
  const f = await fixture(t);
  const created = []; const attached = [];
  const launcher = createTaskLauncher({
    ...f.deps, replyWithinMs,
    loadContext: async binding => ({ ...(await f.deps.loadContext({ serverId: binding.serverId, workspaceId: binding.workspaceId, taskId: binding.taskId })), workspaceId: binding.workspaceId, canIsolate }),
    branchPreview: async () => preview,
    createWorktree: createWorktree ?? (async input => { created.push(input); return { workspaceId: "worktree-1", branch: input.branch ?? "task/aaaaaaaa-launch-proof", baseCommit: "f".repeat(40), directory: "C:\\worktrees\\one" }; }),
    attachWorktree: async input => { attached.push(input); f.task.worktree = input.worktree; },
  });
  return { f, launcher, created, attached };
}

test("prepareWorktree creates the feature branch of a two-type template and attaches it, without creating an agent", async t => {
  const { f, launcher, created, attached } = await preparingLauncher(t);
  const result = await launcher.prepareWorktree(f.input, f.paseo);
  assert.deepEqual(result, { phase: "ready", workspaceId: "worktree-1", branch: "feature/ABC-123-add-login-retry" });
  assert.deepEqual(created.map(item => item.branch), ["feature/ABC-123-add-login-retry"]);
  assert.equal(attached[0].worktree.sourceWorkspaceId, f.input.workspaceId);
  // The shared attach step (the one Start uses) records the branch point as the review base.
  assert.deepEqual([attached[0].worktree.workspaceId, attached[0].worktree.branch, attached[0].worktree.baseCommit], ["worktree-1", "feature/ABC-123-add-login-retry", "f".repeat(40)]);
  assert.equal(f.state.createCalls, 0); assert.equal(f.state.sends, 0);
  assert.deepEqual(await launcher.prepareWorktree(f.input, f.paseo), result, "a repeat reports the attached worktree");
  assert.equal(created.length, 1, "no second worktree");
});

test("prepareWorktree replies while a slow creation continues, holds the launch lock, and reports a late failure once", async t => {
  let finish; const gate = new Promise((resolve, reject) => { finish = { resolve, reject }; });
  const { f, launcher } = await preparingLauncher(t, { replyWithinMs: 20, createWorktree: async () => gate });
  assert.deepEqual(await launcher.prepareWorktree(f.input, f.paseo), { phase: "creating", message: "Creating the task's worktree. A large repository can take a minute." });
  assert.equal((await launcher.prepareWorktree(f.input, f.paseo)).phase, "creating", "a repeat while creating starts nothing new");
  assert.equal((await launcher.status(f.input, f.paseo)).action, "starting", "Start sees the same lock");
  finish.reject(new Error("git fetch failed"));
  await new Promise(resolve => setTimeout(resolve, 10));
  assert.deepEqual(await launcher.prepareWorktree(f.input, f.paseo), { phase: "failed", message: "git fetch failed" });
});

test("prepareWorktree refuses a project without Git history or a branch-name problem, and changes nothing", async t => {
  const plain = await preparingLauncher(t, { canIsolate: false });
  assert.match((await plain.launcher.prepareWorktree(plain.f.input, plain.f.paseo)).message, /Git repository with at least one commit/);
  const broken = await preparingLauncher(t, { preview: { source: "template", note: null, problem: "The template has no ticket key.", options: [] } });
  const result = await broken.launcher.prepareWorktree(broken.f.input, broken.f.paseo);
  assert.equal(result.phase, "failed"); assert.match(result.message, /branch name can't be used: The template has no ticket key\./);
  assert.equal(plain.created.length + broken.created.length, 0);
});

test("the task prompt tells the agent to record its questions for Attention", () => {
  const prompt = taskPromptText({ serverId: "srv_test", workspaceId: "wks_test", taskId: "task_aaaa", title: "24 · Cards", projectId: "prj_test", file: "C:\\dev-vault\\Tasks\\task_aaaa\\task.md" });
  assert.match(prompt, /^Work on Mission Control task task_aaaa: 24 · Cards\.\nThis task belongs to server srv_test, workspace wks_test, and project prj_test\./);
  assert.match(prompt, /Whenever you stop to ask the user something that isn't a plan or review decision, first record it with the kit's scripts\/dev-flow\.mjs ask command/);
});
