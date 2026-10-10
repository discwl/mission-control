import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, realpath, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import vm from "node:vm";
import { createWorkflowInstructionsStore } from "../plugins/mission-control/server/workflow-instructions-store.mjs";

const cli = join(dirname(fileURLToPath(import.meta.url)), "dev-flow.mjs");
const taskId = "task_aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa";
const serverId = "srv_test";
const workspaceId = "wks_test";
const projectId = "prj_test";
const testRoot = join(tmpdir(), "development-flow-cli-tests");

function record(fields, body = "# Record") {
  return `---\n${Object.entries(fields).map(([key, value]) => `${key}: ${JSON.stringify(value)}`).join("\n")}\n---\n\n${body}\n`;
}

async function fixture(t) {
  await mkdir(testRoot, { recursive: true });
  const base = await mkdtemp(join(testRoot, "case-"));
  t.after(async () => {
    const resolvedRoot = await realpath(testRoot);
    const resolvedBase = await realpath(base);
    const remainder = relative(resolvedRoot, resolvedBase);
    if (!remainder.startsWith("case-") || remainder.includes("..")) throw new Error("Refusing test cleanup outside its own case directory.");
    await rm(resolvedBase, { recursive: true, force: true });
  });
  const vault = join(base, "vault");
  const repo = join(base, "repo");
  const folder = join(vault, "Tasks", taskId);
  await mkdir(folder, { recursive: true });
  await mkdir(join(vault, "Projects"));
  await mkdir(repo);
  execFileSync("git", ["init", "-q", repo]);
  await writeFile(join(vault, "host.json"), JSON.stringify({ schemaVersion: 1, hostId: "personal", serverId }));
  await writeFile(join(vault, "Projects", "sample.md"), record({ schemaVersion: 1, hostId: "personal", projectId, repository: repo, kitRoot: dirname(dirname(cli)) }));
  await writeFile(join(folder, "task.md"), record({
    schemaVersion: 1, taskId, hostId: "personal", projectId, title: "Pilot", acceptanceCriteria: "A recorded handoff survives resume.",
    status: "ready", source: "manual", assignments: [{ serverId, workspaceId }], createdAt: "2026-09-23T00:00:00Z", updatedAt: "2026-09-23T00:00:00Z",
  }));
  function run(command, extras = []) {
    return spawnSync(process.execPath, [cli, command, "--task", taskId, "--server", serverId, "--workspace", workspaceId, ...extras], {
      cwd: repo, env: { ...process.env, PASEO_AGENT_ID: "", DEV_VAULT_ROOT: vault }, encoding: "utf8",
    });
  }
  return { base, vault, repo, folder, run };
}

// Execute the real adapter against controlled client boundaries; no daemon or label files are touched.
const labelSource = await readFile(cli, "utf8");
const labelStart = labelSource.indexOf("const workspaceStatusColors =");
const labelEnd = labelSource.indexOf("\nasync function workspaceLabel(args)", labelStart);
assert.ok(labelStart >= 0 && labelEnd > labelStart);
const labelFunctions = vm.runInNewContext(`${labelSource.match(/function required\(value, label\) \{[\s\S]*?\n\}/)[0]}\n${labelSource.match(/function agentIdOf\(args\) \{[\s\S]*?\n\}/)[0]}\n${labelSource.slice(labelStart, labelEnd)}\n({applyWorkspaceLabel, guardWorkspaceStatus})`, { process: { env: {} }, realpath: async path => path });

function labelFixture() {
  const bound = { task: { taskId, projectId, status: "ready", title: "Pilot" }, host: { serverId }, workspaceId, git: { root: "/repo" }, latestRun: null, decisions: [] };
  let tasks = [bound.task];
  const workspace = { id: workspaceId, projectId, workspaceDirectory: "/repo", labels: ["In Progress", "Priority"], archivingAt: null };
  const catalog = { labels: [{ name: "In Progress", color: "sky" }, { name: "Priority", color: "pink" }] };
  const daemon = { serverId, version: "0.10.2" };
  const calls = [];
  const clone = value => JSON.parse(JSON.stringify(value));
  const client = {
    getDaemonStatus: async () => clone(daemon),
    listWorkspaceLabels: async () => clone(catalog),
    setWorkspaceLabel: async request => {
      calls.push(clone(request));
      if (request.assigned) {
        if (!catalog.labels.some(label => label.name === request.label.name)) catalog.labels.push(clone(request.label));
        if (!workspace.labels.includes(request.label.name)) workspace.labels.push(request.label.name);
      } else workspace.labels = workspace.labels.filter(name => name !== request.label.name);
    },
  };
  const agents = { entries: [], pageInfo: { hasMore: false, nextCursor: null } };
  const api = { workspaces: { ref: id => { assert.equal(id, workspaceId); return { refresh: async () => clone(workspace) }; } }, agents: { list: async () => clone(agents) } };
  const run = (args = {}) => labelFunctions.applyWorkspaceLabel(bound, args, client, api, async () => clone(tasks));
  return { bound, workspace, catalog, daemon, calls, client, api, agents, run, setTasks: value => { tasks = value; } };
}

test("workspace labels create readable definitions, verify assignments and preserve unrelated tags", async () => {
  const f = labelFixture();
  const assigned = await f.run({ action: "assign", label: " Ready ", color: "emerald" });
  assert.equal(assigned.verified, true);
  assert.deepEqual(assigned.before, ["In Progress", "Priority"]);
  assert.deepEqual(assigned.after, ["In Progress", "Priority", "Ready"]);
  assert.deepEqual(f.calls[0], { workspaceId, label: { name: "Ready", color: "emerald" }, assigned: true });
  const removed = await f.run({ action: "remove", label: "ready" });
  assert.equal(removed.verified, true);
  assert.deepEqual(removed.after, ["In Progress", "Priority"]);
  assert.ok(f.catalog.labels.some(label => label.name === "Ready"), "detaching does not delete a shared definition");
});

test("get and repeated assignments are idempotent and do not mutate task state", async () => {
  const f = labelFixture();
  const before = JSON.stringify(f.bound);
  const read = await f.run();
  assert.equal(read.serverId, serverId);
  assert.equal(read.tasks[0].taskId, taskId);
  await f.run({ action: "assign", label: "in   progress" });
  await f.run({ action: "remove", label: "Absent" });
  assert.equal(f.calls.length, 0);
  assert.equal(JSON.stringify(f.bound), before);
});

for (const [name, change, pattern] of [
  ["host", f => { f.daemon.serverId = "srv_other"; }, /does not match the task host/],
  ["workspace", f => { f.workspace.id = "wks_other"; }, /Live workspace/],
  ["project", f => { f.workspace.projectId = "prj_other"; }, /another project/],
  ["directory", f => { f.workspace.workspaceDirectory = "/other"; }, /does not match the task checkout/],
  ["archiving workspace", f => { f.workspace.archivingAt = "2026-10-01"; }, /archiving/],
  ["unavailable labels", f => { f.catalog.labels = null; }, /API is unavailable/],
]) test(`workspace label mutation refuses the wrong ${name}`, async () => {
  const f = labelFixture(); change(f);
  await assert.rejects(f.run({ action: "assign", label: "Ready" }), pattern);
  assert.equal(f.calls.length, 0);
});

test("labels never recolor or choose an ambiguous existing definition", async () => {
  const f = labelFixture();
  await assert.rejects(f.run({ action: "assign", label: "In Progress", color: "red" }), /must not recolor/);
  f.catalog.labels.push({ name: "in progress", color: "red" });
  await assert.rejects(f.run({ action: "assign", label: "In Progress" }), /ambiguous/);
  assert.equal(f.calls.length, 0);
});

test("status replaces only recorded workflow tags in a dedicated workspace", async () => {
  const f = labelFixture();
  const result = await f.run({ action: "status", label: "Ready", reason: "Approved and ready to start." });
  assert.equal(result.verified, true);
  assert.deepEqual(result.after, ["Priority", "Ready"]);
  assert.deepEqual(f.calls.map(call => [call.label.name, call.assigned]), [["Ready", true], ["In Progress", false]]);
  assert.equal(f.bound.task.status, "ready");
});

test("one task cannot replace a shared workspace's overall status", async () => {
  const f = labelFixture();
  f.setTasks([f.bound.task, { ...f.bound.task, taskId: "task_bbbbbbbb", status: "in_review" }]);
  await assert.rejects(f.run({ action: "status", label: "Ready", reason: "Ready." }), /Shared workspace/);
  assert.equal(f.calls.length, 0);
  assert.equal((await f.run({ action: "assign", label: "Topic", color: "orange" })).verified, true, "explicit coordinator assignment is still available");
});

test("waiting and completed handoffs do not establish Blocked or Done", async () => {
  const f = labelFixture();
  f.bound.latestRun = { stage: "handoff", outcome: "waiting" };
  await assert.rejects(f.run({ action: "status", label: "Blocked", reason: "Waiting for an answer." }), /waiting is not blocked/);
  f.bound.latestRun.outcome = "completed";
  await assert.rejects(f.run({ action: "status", label: "Done", reason: "Handoff recorded." }), /recorded delivery/);
  assert.equal(f.calls.length, 0);
});

test("recorded blockers and review checkpoints are required", async () => {
  const f = labelFixture();
  await assert.rejects(f.run({ action: "status", label: "Review", reason: "Looks finished." }), /recorded review checkpoint/);
  f.bound.latestRun = { stage: "execute", outcome: "blocked" };
  assert.equal((await f.run({ action: "status", label: "Blocked", reason: "Required service is unavailable." })).verified, true);
});

test("Ready does not bypass open decisions, and status requires a reason", async () => {
  const f = labelFixture();
  f.bound.decisions = [{ status: "open" }];
  await assert.rejects(f.run({ action: "status", label: "Ready", reason: "Plan drafted." }), /no open decision/);
  await assert.rejects(f.run({ action: "status", label: "In Progress" }), /requires a workflow label and --reason/);
  await assert.rejects(f.run({ action: "assign", label: "Topic", color: "unknown" }), /Unknown label color/);
  assert.equal(f.calls.length, 0);
});

test("Ready refuses unapproved plans and terminal tasks, and accepts only applicable plan approval", async () => {
  const f = labelFixture();
  f.bound.task.status = "inbox";
  f.bound.latestRun = { runId: "run_plan", stage: "plan", outcome: "completed" };
  await assert.rejects(f.run({ action: "status", label: "Ready", reason: "Plan written." }), /approved plan/);
  assert.equal(f.calls.length, 0);
  const approval = { runId: "run_plan", taskId, serverId, workspaceId, kind: "plan", status: "approved", requestedAt: "2026-10-01T10:00:00Z" };
  for (const override of [{ runId: "run_old" }, { workspaceId: "wks_other" }, { serverId: "srv_other" }, { status: "changes_requested" }]) {
    f.bound.decisions = [{ ...approval, ...override }];
    await assert.rejects(f.run({ action: "status", label: "Ready", reason: "Ready." }), /approved plan/);
  }
  f.bound.decisions = [approval];
  for (const status of ["delivered", "closed"]) {
    f.bound.task.status = status;
    await assert.rejects(f.run({ action: "status", label: "Ready", reason: "Old plan." }), /active task/);
  }
  assert.equal(f.calls.length, 0);
  f.bound.task.status = "inbox";
  assert.equal((await f.run({ action: "status", label: "Ready", reason: "Plan approved." })).verified, true);
});

test("a newer rejected plan supersedes earlier approval for Ready", async () => {
  const f = labelFixture();
  f.bound.decisions = [
    { kind: "plan", status: "approved", requestedAt: "2026-10-01T10:00:00Z" },
    { kind: "plan", status: "changes_requested", requestedAt: "2026-10-01T11:00:00Z" },
  ];
  await assert.rejects(f.run({ action: "status", label: "Ready", reason: "Earlier approval." }), /approved plan/);
  assert.equal(f.calls.length, 0);
});

test("Done requires recorded closure, a complete agent roster and no other active agent", async () => {
  const f = labelFixture();
  f.bound.task.status = "delivered";
  f.agents.entries = [{ agent: { id: "agent-other", workspaceId, status: "running" } }];
  await assert.rejects(f.run({ action: "status", label: "Done", reason: "Delivered." }), /no other active/);
  assert.equal(f.calls.length, 0);
  f.agents.entries = [];
  f.agents.pageInfo.hasMore = true;
  await assert.rejects(f.run({ action: "status", label: "Done", reason: "Delivered." }), /complete agent roster/);
  f.agents.pageInfo.hasMore = false;
  f.agents.entries = [{ agent: { id: "coordinator", workspaceId, status: "running" } }];
  assert.equal((await f.run({ action: "status", label: "Done", reason: "Delivery verified; final coordinator update.", agent: "coordinator" })).verified, true);
});

test("a lost mutation reply is unconfirmed and can be reconciled with get", async () => {
  const f = labelFixture();
  const write = f.client.setWorkspaceLabel;
  f.client.setWorkspaceLabel = async request => { await write(request); throw new Error("Reply timed out"); };
  await assert.rejects(f.run({ action: "assign", label: "Ready" }), /may have applied; run workspace-label --action get before retrying/);
  assert.equal(f.calls.length, 1, "no blind retry or rollback");
  assert.ok((await f.run()).labels.includes("Ready"), "the live result can be reconciled");
});

test("successful RPC replies alone do not prove assignment or preservation", async () => {
  const f = labelFixture();
  f.client.setWorkspaceLabel = async () => {};
  await assert.rejects(f.run({ action: "assign", label: "Ready" }), /Live assignment verification failed/);
  const g = labelFixture();
  const write = g.client.setWorkspaceLabel;
  g.client.setWorkspaceLabel = async request => { await write(request); g.workspace.labels = g.workspace.labels.filter(name => name !== "Priority"); };
  await assert.rejects(g.run({ action: "assign", label: "Ready" }), /another writer changed/);
});

test("task changes detected after a status write are reported without undoing other work", async () => {
  const f = labelFixture();
  const write = f.client.setWorkspaceLabel;
  f.client.setWorkspaceLabel = async request => { await write(request); f.setTasks([{ ...f.bound.task, status: "closed" }]); };
  await assert.rejects(f.run({ action: "status", label: "Ready", reason: "Ready." }), /Task binding\/status changed.*may have applied/);
  assert.ok(f.workspace.labels.includes("Ready"));
});

test("workspace-label CLI rejects unassigned workspaces and wrong host bindings before connecting", async t => {
  const { run } = await fixture(t);
  const workspace = run("workspace-label", ["--workspace", "wks_other", "--url", "ws://127.0.0.1:1/ws"]);
  assert.notEqual(workspace.status, 0);
  assert.match(workspace.stderr, /not assigned/);
  const host = run("workspace-label", ["--server", "srv_other", "--url", "ws://127.0.0.1:1/ws"]);
  assert.notEqual(host.status, 0);
  assert.match(host.stderr, /does not belong to this host adapter/);
});

test("context loads fresh host and project workflow instructions and refuses malformed notes", async t => {
  const f = await fixture(t);
  const store = createWorkflowInstructionsStore(f.vault);
  let snapshot = await store.read({ serverId, projectId: null });
  await store.save({ serverId, projectId: null, expectedRevision: snapshot.revision, values: { intake: "Ask about unclear ticket criteria.", planning: "Read Confluence first." } });
  snapshot = await store.read({ serverId, projectId });
  const saved = await store.save({ serverId, projectId, expectedRevision: snapshot.revision, values: { intake: "", planning: "Check the reporting database read-only.", intakeMode: "inherit", planningMode: "append" } });
  const result = f.run("context");
  assert.equal(result.status, 0, result.stderr);
  const context = JSON.parse(result.stdout);
  assert.equal(context.workflowInstructions.revision, saved.revision);
  assert.equal(context.workflowInstructions.effective.intake, "Ask about unclear ticket criteria.");
  assert.match(context.workflowInstructions.prompt, /Read Confluence first\.[\s\S]*Check the reporting database read-only\./);
  await writeFile(saved.paths.project, "broken note");
  const broken = f.run("context");
  assert.notEqual(broken.status, 0);
  assert.match(broken.stderr, /invalid frontmatter/);
});

test("context selects one assigned task and reports an unborn Git branch honestly", async t => {
  const { run } = await fixture(t);
  const result = run("context");
  assert.equal(result.status, 0, result.stderr);
  const context = JSON.parse(result.stdout);
  assert.equal(context.task.taskId, taskId);
  assert.equal(context.git.head, null);
  assert.equal(context.latestRun, null);
  const wrong = run("context", ["--workspace", "wks_other"]);
  assert.notEqual(wrong.status, 0);
  assert.match(wrong.stderr, /not assigned/);
});

test("run events and handoff survive a fresh context read", async t => {
  const { base, folder, run } = await fixture(t);
  const started = run("start", ["--agent", "agent-test-1"]);
  assert.equal(started.status, 0, started.stderr);
  const runRecord = JSON.parse(started.stdout).run;
  const runId = runRecord.runId;
  assert.equal(runRecord.agentId, "agent-test-1");
  const input = join(base, "event.json");
  await writeFile(input, JSON.stringify({ stage: "handoff", outcome: "waiting", summary: "Plan drafted; waiting for scope decision.", nextAction: "Review plan.md and decide scope.", evidence: ["plan.md"] }));
  const saved = run("record", ["--run", runId, "--input", input]);
  assert.equal(saved.status, 0, saved.stderr);
  assert.equal((await readdir(join(folder, "runs", runId, "events"))).length, 1);
  assert.match(await readFile(join(folder, "runs", runId, "handoff.md"), "utf8"), /Review plan\.md/);
  const resumed = run("context");
  assert.equal(resumed.status, 0, resumed.stderr);
  const context = JSON.parse(resumed.stdout);
  assert.equal(context.latestRun.runId, runId);
  assert.equal(context.latestRun.stage, "handoff");
  assert.match(context.handoff, /Plan drafted/);
  const before = await readFile(join(folder, "runs", runId, "run.md"), "utf8");
  await writeFile(input, JSON.stringify({ stage: "invented", outcome: "completed", summary: "Wrong", nextAction: "None", evidence: [] }));
  const invalid = run("record", ["--run", runId, "--input", input]);
  assert.notEqual(invalid.status, 0);
  assert.equal(await readFile(join(folder, "runs", runId, "run.md"), "utf8"), before);
  await writeFile(input, JSON.stringify({ stage: "review", outcome: "completed", summary: "Looks good", nextAction: "Deliver", evidence: [] }));
  const unsupported = run("record", ["--run", runId, "--input", input]);
  assert.notEqual(unsupported.status, 0);
  assert.match(unsupported.stderr, /require evidence/);
  assert.equal(await readFile(join(folder, "runs", runId, "run.md"), "utf8"), before);
});

test("decision requests wait for the user and agents cannot resolve their own findings", async t => {
  const { base, folder, run } = await fixture(t);
  const started = run("start", ["--agent", "agent-test-1"]);
  assert.equal(started.status, 0, started.stderr);
  const runId = JSON.parse(started.stdout).run.runId;
  const runFolder = join(folder, "runs", runId);
  const input = join(base, "decision.json");

  await writeFile(input, JSON.stringify({ kind: "plan", question: "Approve?", summary: "Plan", findings: [{ title: "x", severity: "low" }] }));
  const planWithFindings = run("request-decision", ["--run", runId, "--input", input]);
  assert.notEqual(planWithFindings.status, 0);
  assert.match(planWithFindings.stderr, /no findings/);

  await writeFile(input, JSON.stringify({
    kind: "review", question: "Fix these findings?", summary: "Two issues found.", evidence: ["review.md"],
    findings: [{ title: "Unsaved draft lost", severity: "high", detail: "Switching tabs drops edits.", file: "client/docs.tsx" }, { title: "Typo", severity: "low" }],
  }));
  const requested = run("request-decision", ["--run", runId, "--input", input]);
  assert.equal(requested.status, 0, requested.stderr);
  const { decision, findings } = JSON.parse(requested.stdout);
  assert.equal(decision.status, "open");
  assert.equal(decision.agentId, "agent-test-1");
  assert.equal(findings.length, 2);
  assert.equal(JSON.parse(run("context").stdout).latestRun.outcome, "waiting");

  const second = run("request-decision", ["--run", runId, "--input", input]);
  assert.notEqual(second.status, 0);
  assert.match(second.stderr, /still open/);

  const [first] = findings;
  const early = run("finding", ["--run", runId, "--finding", first.findingId, "--status", "awaiting_verification", "--evidence", "fixed"]);
  assert.notEqual(early.status, 0, "open findings need the user's decision first");
  assert.match(early.stderr, /Only the user/);

  // Mission Control marks findings submitted when the user requests changes.
  const file = join(runFolder, "findings.json");
  const stored = JSON.parse(await readFile(file, "utf8"));
  stored.findings[0].status = "submitted";
  await writeFile(file, JSON.stringify(stored));
  assert.notEqual(run("finding", ["--run", runId, "--finding", first.findingId, "--status", "resolved", "--evidence", "trust me"]).status, 0);
  assert.notEqual(run("finding", ["--run", runId, "--finding", first.findingId, "--status", "awaiting_verification"]).status, 0, "a fix needs evidence");
  const fixed = run("finding", ["--run", runId, "--finding", first.findingId, "--status", "awaiting_verification", "--evidence", "Draft kept in page state; test added."]);
  assert.equal(fixed.status, 0, fixed.stderr);
  const verified = run("finding", ["--run", runId, "--finding", first.findingId, "--status", "resolved", "--evidence", "Fresh review round 2 verified."]);
  assert.equal(verified.status, 0, verified.stderr);
  assert.deepEqual(JSON.parse(verified.stdout).finding.evidence, ["Draft kept in page state; test added.", "Fresh review round 2 verified."]);

  const shown = run("decision", ["--run", runId, "--decision", decision.decisionId]);
  assert.equal(shown.status, 0, shown.stderr);
  assert.equal(JSON.parse(shown.stdout).body, "Two issues found.");
  const context = JSON.parse(run("context").stdout);
  assert.equal(context.decisions.length, 1);
  assert.equal(context.findings.find(item => item.findingId === first.findingId).status, "resolved");
});

test("a linked worktree of the project repository is accepted, other repositories are not", async t => {
  const { base, repo, run } = await fixture(t);
  const git = (...args) => execFileSync("git", ["-C", repo, "-c", "user.name=Test", "-c", "user.email=test@example.com", ...args]);
  await writeFile(join(repo, "README.md"), "# Repo\n");
  git("add", "."); git("commit", "-q", "-m", "base");
  const worktree = join(base, "task-worktree");
  git("worktree", "add", "-q", "-b", "task/abc-pilot", worktree);
  const inWorktree = run("context", ["--cwd", worktree]);
  assert.equal(inWorktree.status, 0, inWorktree.stderr);
  const context = JSON.parse(inWorktree.stdout);
  assert.equal(context.git.head.length, 40);
  const other = join(base, "other-repo");
  await mkdir(other);
  execFileSync("git", ["init", "-q", other]);
  const outside = run("context", ["--cwd", other]);
  assert.notEqual(outside.status, 0);
  assert.match(outside.stderr, /outside the task's project repository/);
});

test("a review decision records the reviewed candidate without touching the checkout's index", async t => {
  const { base, repo, run } = await fixture(t);
  const git = (cwd, ...args) => execFileSync("git", ["-C", cwd, "-c", "user.name=Test", "-c", "user.email=test@example.com", "-c", "core.autocrlf=false", ...args], { encoding: "utf8" }).trim();
  await writeFile(join(repo, "README.md"), "# Repo\n");
  await writeFile(join(repo, ".gitignore"), "secret.env\n");
  git(repo, "add", "."); git(repo, "commit", "-q", "-m", "base");
  const worktree = join(base, "task-worktree");
  git(repo, "worktree", "add", "-q", "-b", "task/abc-pilot", worktree);
  // A staged edit, an unstaged edit on top of it, a new untracked file and an ignored file.
  await writeFile(join(worktree, "README.md"), "# Repo\nstaged\n");
  git(worktree, "add", "README.md");
  await writeFile(join(worktree, "README.md"), "# Repo\nstaged\nunstaged\n");
  await writeFile(join(worktree, "new.txt"), "new\n");
  await writeFile(join(worktree, "secret.env"), "ignored\n");
  const statusBefore = git(worktree, "status", "--porcelain");
  const stagedBefore = git(worktree, "diff", "--cached", "--name-only");

  const runId = JSON.parse(run("start", ["--cwd", worktree]).stdout).run.runId;
  const input = join(base, "decision.json");
  await writeFile(input, JSON.stringify({ kind: "review", question: "Approve?", summary: "Clean review." }));
  const requested = run("request-decision", ["--run", runId, "--input", input, "--cwd", worktree]);
  assert.equal(requested.status, 0, requested.stderr);
  const { decision } = JSON.parse(requested.stdout);
  assert.equal(decision.candidate.head, git(worktree, "rev-parse", "HEAD"));
  // The checkout's own index and status are exactly as before.
  assert.equal(git(worktree, "status", "--porcelain"), statusBefore);
  assert.equal(git(worktree, "diff", "--cached", "--name-only"), stagedBefore);
  // The tree is what committing everything would record: untracked files in, ignored files out.
  assert.deepEqual(git(worktree, "ls-tree", "-r", "--name-only", decision.candidate.tree).split("\n"), [".gitignore", "README.md", "new.txt"]);
  git(worktree, "add", "-A");
  assert.equal(decision.candidate.tree, git(worktree, "write-tree"));

  // Plan decisions record no candidate.
  const planRun = JSON.parse(run("start", ["--cwd", worktree]).stdout).run.runId;
  await writeFile(input, JSON.stringify({ kind: "plan", question: "Approve the plan?", summary: "Plan." }));
  const plan = run("request-decision", ["--run", planRun, "--input", input, "--cwd", worktree]);
  assert.equal(plan.status, 0, plan.stderr);
  assert.equal(JSON.parse(plan.stdout).decision.candidate, null);
});

test("decision requests store plain-language fields, refuse IDs, hashes, paths and overlong text, and warn about jargon", async t => {
  const { base, folder, run } = await fixture(t);
  const input = join(base, "decision.json");
  const plain = {
    built: "You can now pause a task and pick it up later without losing notes.",
    found: "The review found one problem: pausing twice loses the second note.",
    recommendation: { action: "fix", reason: "It's a quick fix and notes matter." },
  };
  const finding = { title: "Second pause overwrites notes", severity: "medium", detail: "savePause replaces notes.md.", file: "server/pause.ts",
    plain: { description: "Pausing a task twice loses the second note.", impact: "Notes written before the second pause disappear.", recommend: "fix" } };
  const request = async (body, runId) => {
    await writeFile(input, JSON.stringify(body));
    return run("request-decision", ["--run", runId, "--input", input]);
  };
  const newRun = () => JSON.parse(run("start").stdout).run.runId;

  const refusals = [
    [{ ...plain, built: "Saved in C:\\dev-vault\\notes." }, [finding], /plain\.built .*a file path/],
    [{ ...plain, built: "Saved under server\\pause." }, [finding], /a file path/],
    [{ ...plain, found: "The bug is in plugins/mission-control/server/pause.ts." }, [finding], /a file path \("plugins\/mission-control\/server\/pause\.ts"\)/],
    [{ ...plain, found: "Fixed in commit 403504d." }, [finding], /plain\.found .*a commit hash/],
    [{ ...plain, found: "See task_2a613891-066b for details." }, [finding], /an internal ID/],
    [{ ...plain, found: "It was reported in wks_8c7a39817afd39d1." }, [finding], /an internal ID/],
    [{ ...plain, built: "x".repeat(801) }, [finding], /too long/],
    [{ ...plain, recommendation: { action: "ship", reason: "Why not." } }, [finding], /accept, fix or stop/],
    [plain, [{ ...finding, plain: undefined }], /every finding needs plain/],
    [plain, [{ ...finding, plain: { ...finding.plain, recommend: "skip" } }], /at least one finding recommended for fixing/],
    [{ ...plain, recommendation: { action: "accept", reason: "Good enough." } }, [finding], /recommends accepting/],
    [{ ...plain, found: "" }, [finding], /plain\.found is required/],
  ];
  const runId = newRun();
  for (const [candidate, findings, pattern] of refusals) {
    const refused = await request({ kind: "review", question: "Fix it?", summary: "One finding.", plain: candidate, findings }, runId);
    assert.notEqual(refused.status, 0, JSON.stringify(candidate));
    assert.match(refused.stderr, pattern);
  }
  assert.deepEqual(await readdir(join(folder, "runs", runId)).then(names => names.includes("decisions")), false, "a refused request writes nothing");

  const requested = await request({ kind: "review", question: "Fix it?", summary: "One finding.", plain: { ...plain, built: `  ${plain.built}  ` }, findings: [finding] }, runId);
  assert.equal(requested.status, 0, requested.stderr);
  const { decision, findings } = JSON.parse(requested.stdout);
  assert.deepEqual(decision.plain, plain, "plain text is trimmed and stored");
  assert.deepEqual(findings[0].plain, finding.plain);
  const onDisk = await readFile(join(folder, "runs", runId, "decisions", `${decision.decisionId}.md`), "utf8");
  assert.match(onDisk, /^plain: \{"built":"You can now pause/m);

  assert.deepEqual(JSON.parse(requested.stdout).warnings, []);

  // Ordinary text passes untouched; file, code and tool names pass with a warning the agent sees.
  const ordinary = {
    built: "From 26/09/2026 you can read/write/delete notes in Settings/Plugins/Mission Control, 24/7, with and/or without a draft.",
    found: "The review found nothing wrong, e.g. dates, times like 10:30, and prices like $12.50 all look right.",
    recommendation: { action: "accept", reason: "It works as described; accept it." },
  };
  const passed = await request({ kind: "review", question: "Accept?", summary: "Clean.", plain: ordinary }, newRun());
  assert.equal(passed.status, 0, passed.stderr);
  assert.deepEqual(JSON.parse(passed.stdout).warnings, []);
  assert.equal(passed.stderr, "");
  const jargon = { ...ordinary, found: "savePause in pause.ts was checked with tsc; works on Node.js." };
  const warned = await request({ kind: "review", question: "Accept?", summary: "Clean.", plain: jargon }, newRun());
  assert.equal(warned.status, 0, warned.stderr);
  const warnings = JSON.parse(warned.stdout).warnings;
  assert.deepEqual(warnings.map(warning => /may contain (a [a-z ]+) \("([^"]+)"\)/.exec(warning).slice(1)), [["a file name", "pause.ts"], ["a code name", "savePause"], ["a tool name", "tsc"]]);
  assert.match(warned.stderr, /^Warning: plain\.found may contain a file name/m);
  assert.equal(JSON.parse(warned.stdout).decision.plain.found, jargon.found);

  // Plans may leave "found" out; a request without plain fields still works, as older callers send it.
  const plan = await request({ kind: "plan", question: "Approve?", summary: "Plan.", plain: { built: "A pause button for tasks.", recommendation: { action: "accept", reason: "Small and safe." } } }, newRun());
  assert.equal(plan.status, 0, plan.stderr);
  assert.deepEqual(JSON.parse(plan.stdout).decision.plain, { built: "A pause button for tasks.", found: "", recommendation: { action: "accept", reason: "Small and safe." } });
  const old = await request({ kind: "review", question: "Approve?", summary: "Clean.", findings: [{ title: "Typo", severity: "low" }] }, newRun());
  assert.equal(old.status, 0, old.stderr);
  assert.equal(JSON.parse(old.stdout).decision.plain, null);
  assert.equal(JSON.parse(old.stdout).findings[0].plain, null);
});

test("help describes the plain decision fields", () => {
  const shown = spawnSync(process.execPath, [cli, "help"], { encoding: "utf8" });
  assert.equal(shown.status, 0);
  for (const field of ["plain", "built", "found", "recommendation", "description", "impact", "recommend"]) assert.match(shown.stdout, new RegExp(`"${field}"`));
});

test("ask records a plain question for Attention, refuses bad or overlong fields, and replaces the run's earlier question", async t => {
  const { base, folder, run } = await fixture(t);
  const input = join(base, "question.json");
  const ask = async (body, runId, extras = []) => {
    await writeFile(input, JSON.stringify(body));
    return run("ask", ["--run", runId, "--input", input, ...extras]);
  };
  const plain = {
    status: "The pause button works. Resuming still needs a place to keep the agent's notes.",
    need: "Should notes live with the task or with the run?",
    recommendation: "With the task, so they survive a new run.",
  };
  const question = "Store pause notes in task.md or the run folder?";
  const runId = JSON.parse(run("start", ["--agent", "agent-asker"]).stdout).run.runId;

  const refusals = [
    [{ plain }, /question is required/],
    [{ question: "x".repeat(501), plain }, /question is too long \(max 500/],
    [{ question }, /plain must be an object/],
    [{ question, plain: { ...plain, status: "" } }, /plain\.status is required/],
    [{ question, plain: { ...plain, need: undefined } }, /plain\.need is required/],
    [{ question, plain: { ...plain, status: "x".repeat(401) } }, /plain\.status is too long \(max 400/],
    [{ question, plain: { ...plain, need: "x".repeat(201) } }, /plain\.need is too long \(max 200/],
    [{ question, plain: { ...plain, recommendation: "x".repeat(301) } }, /plain\.recommendation is too long \(max 300/],
    [{ question, plain: { ...plain, status: "Notes are in C:\\dev-vault\\notes." } }, /plain\.status .*a file path/],
    [{ question, plain: { ...plain, need: "Is commit 403504d right?" } }, /plain\.need .*a commit hash/],
  ];
  for (const [body, pattern] of refusals) {
    const refused = await ask(body, runId);
    assert.notEqual(refused.status, 0, JSON.stringify(body));
    assert.match(refused.stderr, pattern);
  }
  assert.equal((await readdir(join(folder, "runs", runId))).includes("questions"), false, "a refused question writes nothing");

  const first = await ask({ question, plain }, runId);
  assert.equal(first.status, 0, first.stderr);
  const recorded = JSON.parse(first.stdout);
  assert.deepEqual(recorded.warnings, []);
  assert.equal(recorded.question.status, "open");
  assert.equal(recorded.question.agentId, "agent-asker", "the run's agent receives the reply");
  assert.deepEqual(recorded.question.plain, plain);
  assert.equal(recorded.event.outcome, "waiting");
  assert.match(await readFile(join(folder, "runs", runId, "questions", `${recorded.question.questionId}.md`), "utf8"), /^question: "Store pause notes/m);

  // A later question replaces the open one; the recommendation is optional; long status only warns.
  const second = await ask({ question: "Go ahead?", plain: { status: "One. Two. Three. Four.", need: "May I go ahead?" } }, runId);
  assert.equal(second.status, 0, second.stderr);
  const later = JSON.parse(second.stdout);
  assert.equal(later.question.plain.recommendation, null);
  assert.match(later.warnings.join("\n"), /more than 3 sentences/);
  const context = JSON.parse(run("context").stdout);
  assert.deepEqual(context.questions.map(item => [item.question, item.status]), [[question, "replaced"], ["Go ahead?", "open"]]);
});

test("ask needs an agent to send the reply to", async t => {
  const { base, run } = await fixture(t);
  const runId = JSON.parse(run("start").stdout).run.runId;
  const input = join(base, "question.json");
  await writeFile(input, JSON.stringify({ question: "Which?", plain: { status: "Halfway.", need: "Pick one." } }));
  const refused = run("ask", ["--run", runId, "--input", input]);
  assert.notEqual(refused.status, 0);
  assert.match(refused.stderr, /pass --agent/);
});

test("help describes ask and its plain fields", () => {
  const shown = spawnSync(process.execPath, [cli, "help"], { encoding: "utf8" });
  assert.equal(shown.status, 0);
  assert.match(shown.stdout, /ask --run ID --input JSON/);
  for (const field of ["question", "status", "need", "recommendation"]) assert.match(shown.stdout, new RegExp(`"${field}"`));
});
