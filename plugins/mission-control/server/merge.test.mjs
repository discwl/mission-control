import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { chmod, mkdir, mkdtemp, readFile, readdir, realpath, rm, utimes, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const require = createRequire(import.meta.url);
const ts = require("typescript");
require.extensions[".ts"] = (module, file) => module._compile(ts.transpileModule(readFileSync(file, "utf8"), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText, file);
const { createMergeService, localFilesInTheWay, reviewCandidate, startingBranch } = require("./merge.ts");
const { deliverTaskSource } = require("./tasks.ts");
const { mergeReadyTaskSchema, mergeReplySchema, mergeResultSchema, mergeStatusSchema } = require("../shared/merge.ts");
const { deliveryResultSchema } = require("../shared/pull-request.ts");
const { createDeliveryResults } = require("./delivery-results.ts");
const { killTree, processTreeTesting } = require("./process-tree.ts");
const { decisionSchema } = require("../shared/decisions.ts");

const cli = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "scripts", "dev-flow.mjs");
const serverId = "srv_test";
const taskId = "task_1234abcd-0000-4000-8000-000000000000";
const runId = "run_1234abcd-0000-4000-8000-000000000000";
const decisionId = "decision_1234abcd-0000-4000-8000-000000000000";
const branch = "task/1234abcd-add-greeting";
const markdown = fields => `---\n${Object.entries(fields).map(([key, value]) => `${key}: ${JSON.stringify(value)}`).join("\n")}\n---\n\n# Add greeting\n`;

/**
 * A scratch repository on master with a task worktree branched off it, a task folder in a scratch
 * vault, and stand-ins for Paseo and the decision store. `review()` records a review decision of the
 * worktree as it is at that moment, the way dev-flow request-decision does.
 */
async function scenario(t, { agentStatus = "idle", writeTimeoutMs, beforeMerge, afterBranchRead, replyWithinMs, deliver = deliverTaskSource, archive, deliveryMode } = {}) {
  const base = await realpath(await mkdtemp(join(tmpdir(), "mission-merge-")));
  // A stopped hook or merge driver can hold the folder open for a moment on Windows.
  t.after(() => rm(base, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 }));
  const repo = join(base, "repo");
  const worktree = join(base, "worktrees", "1234abcd-add-greeting");
  execFileSync("git", ["init", "-q", "-b", "master", repo]);
  const git = (cwd, ...args) => execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8" }).trim();
  git(repo, "config", "user.name", "Test"); git(repo, "config", "user.email", "test@example.com"); git(repo, "config", "core.autocrlf", "false");
  await writeFile(join(repo, "base.txt"), "base\n");
  await writeFile(join(repo, ".gitignore"), "*.env\nbuild/\n");
  git(repo, "add", "."); git(repo, "commit", "-q", "-m", "base");
  const baseCommit = git(repo, "rev-parse", "HEAD");
  git(repo, "worktree", "add", "-q", "-b", branch, worktree, "master");

  const vault = join(base, "vault");
  const folder = join(vault, "Tasks", taskId);
  await mkdir(folder, { recursive: true });
  const task = {
    schemaVersion: 1, taskId, hostId: "personal", projectId: "prj_test", title: "Add greeting", acceptanceCriteria: "Works.", status: "in_review", source: "manual",
    assignments: [{ serverId, workspaceId: "wks_main" }, { serverId, workspaceId: "wks_task" }], createdAt: "2026-09-20T00:00:00Z", updatedAt: "2026-09-20T00:00:00Z",
    worktree: { workspaceId: "wks_task", branch, baseCommit, sourceWorkspaceId: "wks_main", createdAt: "2026-09-20T00:00:00Z" },
  };
  await writeFile(join(folder, "task.md"), markdown(task));
  await writeFile(join(folder, "status.md"), "# Status log\n\nCreated 2026-09-20T00:00:00Z. Initial state: ready.\n");
  const source = { task, folder, file: join(folder, "task.md") };
  let run = {
    schemaVersion: 1, runId, taskId, hostId: "personal", projectId: "prj_test", serverId, workspaceId: "wks_task", stage: "handoff", outcome: "completed",
    createdAt: "2026-09-21T00:00:00Z", updatedAt: "2026-09-22T00:00:00Z", nextAction: "Merge.", agentId: "agent-1", gitHead: baseCommit, gitDirty: true, gitChanges: [], omittedChanges: 0,
  };
  const decisions = { open: [], recent: [] };
  const entry = (decision, findings = []) => ({ decision, summary: "", taskTitle: task.title, projectId: "prj_test", findings, unverifiedFindings: 0, revision: "r" });
  // A review decision of the worktree as it is now, resolved with `status`.
  async function review(status = "approved", { findings = [], candidate } = {}) {
    const decision = decisionSchema.parse({
      schemaVersion: 1, decisionId, taskId, runId, serverId, workspaceId: "wks_task", agentId: "agent-1", kind: "review", status,
      question: "Approve?", requestedAt: "2026-09-22T00:00:00Z", gitHead: git(worktree, "rev-parse", "HEAD"), gitDirty: true, evidence: [], findingIds: findings.map(item => item.findingId),
      resolvedAt: status === "open" ? null : "2026-09-22T01:00:00Z", note: null, resume: null,
      candidate: candidate === undefined ? await reviewCandidate(worktree) : candidate,
    });
    decisions.open = status === "open" ? [entry(decision, findings)] : [];
    decisions.recent = status === "open" ? [] : [entry(decision, findings)];
  }

  const events = [];
  const agent = { status: agentStatus, activeTurn: agentStatus === "running" ? { startedAt: "x" } : null, pendingPermissions: [], archivedAt: null };
  const paseo = {
    agents: { ref: id => ({
      refresh: async () => { if (id !== "agent-1") throw new Error(`Agent not found: ${id}`); return { agent }; },
      send: async text => { events.push(["send", text]); },
    }) },
    // Like Paseo, archiving a worktree workspace removes its worktree.
    workspaces: { ref: id => ({ archive: async () => { events.push(["archive", id]); if (archive) return archive(); git(repo, "worktree", "remove", worktree); return { archivedAt: "2026-09-26T00:00:00Z", error: null }; } }) },
  };
  // Attention's result cards, kept in this scenario's own file.
  const results = createDeliveryResults({ file: join(base, "delivery-results.json") });
  const service = createMergeService({
    results, deliveryMode,
    sources: async () => [source],
    decisions: async () => decisions,
    runs: async () => [run],
    projectRoot: async () => repo,
    clearReviewMarks: async workspaceId => { events.push(["marks", workspaceId]); },
    deliver: async (item, line) => { events.push(["deliver"]); return deliver(item, line); },
    now: () => new Date("2026-09-26T12:00:00Z"),
    writeTimeoutMs, beforeMerge, afterBranchRead, replyWithinMs,
  });
  const check = async () => mergeStatusSchema.parse(await service.check({ serverId, taskId }, paseo));
  // text: what the user confirmed in the dialog, such as { commitMessage }.
  const merge = async (fingerprint, text = {}) => mergeResultSchema.parse(await service.merge({ serverId, taskId, fingerprint, ...text }, paseo));
  const start = async (fingerprint, text = {}) => mergeReplySchema.parse(await service.start({ serverId, taskId, fingerprint, ...text }, paseo));
  const setRun = next => { run = next; };
  return { base, vault, repo, worktree, folder, task, git, check, merge, start, service, results, review, events, baseCommit, decisions, entry, run: () => run, setRun };
}

const failing = status => status.checks.filter(item => !item.ok).map(item => item.id);
const detail = (status, id) => status.checks.find(item => item.id === id).detail;

test("a clean merge commits the worktree, merges with --no-ff and cleans up", async t => {
  const { repo, worktree, folder, git, check, merge, review, events, baseCommit } = await scenario(t);
  await writeFile(join(worktree, "greeting.txt"), "hello\n");
  await writeFile(join(worktree, "base.txt"), "base\nmore\n");
  await review();

  const status = await check();
  assert.deepEqual(failing(status), []);
  assert.equal(status.ready, true);
  assert.equal(status.plan.targetBranch, "master");
  assert.equal(status.plan.taskBranch, branch);
  assert.deepEqual([...status.plan.uncommittedFiles].sort(), ["base.txt", "greeting.txt"]);
  assert.equal(status.plan.commitMessage, `Add greeting (${taskId})`);
  assert.equal(status.plan.agentId, "agent-1");

  const result = await merge(status.plan.fingerprint);
  assert.equal(result.outcome, "merged", JSON.stringify(result));
  assert.deepEqual(result.steps.map(step => [step.label, step.state]), [
    ["Clear Review marks", "done"], ["Mark delivered", "done"], ["Tell the agent", "done"], ["Archive worktree workspace", "done"], ["Delete merged branch", "done"],
  ]);
  // A real merge commit on master, whose second parent is the task's commit of its uncommitted work.
  assert.equal(git(repo, "rev-parse", "HEAD"), result.mergeCommit);
  assert.equal(git(repo, "rev-parse", "HEAD^1"), baseCommit);
  assert.equal(git(repo, "rev-parse", "HEAD^2"), result.committed);
  assert.equal(git(repo, "log", "-1", "--format=%s", result.committed), `Add greeting (${taskId})`);
  assert.equal(git(repo, "log", "-1", "--format=%s", "HEAD"), `Merge ${branch}: Add greeting`);
  assert.equal(await readFile(join(repo, "greeting.txt"), "utf8"), "hello\n");
  assert.equal(git(repo, "status", "--porcelain"), "");
  // The note goes before the archive, which closes the workspace's agents, and after the steps it reports.
  assert.deepEqual(events.map(event => event[0]), ["marks", "deliver", "send", "archive"]);
  assert.match(events[2][1], /merged task .* into master as .*\. The task is marked delivered\. Next, Mission Control will archive this worktree workspace, which closes this agent, and delete task\/1234abcd-add-greeting; its merge result shows how that went\./);
  assert.equal(existsSync(worktree), false);
  assert.equal(git(repo, "branch", "--list", branch), "");
  assert.match(await readFile(join(folder, "task.md"), "utf8"), /^status: "delivered"$/m);
  assert.match(await readFile(join(folder, "status.md"), "utf8"), new RegExp(`\\n\\n- 2026-09-26: Delivered\\. Merged ${branch} into master as ${result.mergeCommit.slice(0, 7)} from Mission Control, after committing its uncommitted work as ${result.committed.slice(0, 7)}\\.\\n$`));
});

test("a merge conflict is aborted cleanly and reported with its files", async t => {
  const { repo, worktree, folder, git, check, merge, review, events } = await scenario(t);
  // Uncommitted work in the task worktree conflicts with a later commit on master.
  await writeFile(join(worktree, "base.txt"), "task version\n");
  await review();
  await writeFile(join(repo, "base.txt"), "master version\n");
  git(repo, "commit", "-q", "-am", "master change");
  const mainHead = git(repo, "rev-parse", "HEAD");

  const status = await check();
  assert.equal(status.ready, true, JSON.stringify(status.checks));
  const result = await merge(status.plan.fingerprint);
  assert.equal(result.outcome, "conflict", JSON.stringify(result));
  assert.deepEqual(result.files, ["base.txt"]);
  assert.match(result.detail, /aborted and master is as it was/);
  // The main checkout is exactly as before: same HEAD, clean, no merge in progress.
  assert.equal(git(repo, "rev-parse", "HEAD"), mainHead);
  assert.equal(git(repo, "status", "--porcelain"), "");
  assert.equal(existsSync(join(repo, ".git", "MERGE_HEAD")), false);
  assert.equal(await readFile(join(repo, "base.txt"), "utf8"), "master version\n");
  // The worktree's files are untouched and nothing was cleaned up.
  assert.equal(await readFile(join(worktree, "base.txt"), "utf8"), "task version\n");
  assert.deepEqual(events, []);
  assert.match(await readFile(join(folder, "task.md"), "utf8"), /^status: "in_review"$/m);
  assert.notEqual(git(repo, "branch", "--list", branch), "");
  // A retry still counts the review: the files are the same, on Mission Control's own commit of them.
  const again = await check();
  assert.deepEqual(failing(again), []);
});

test("the commit message confirmed in the dialog is the one committed; checking commits nothing", async t => {
  const { repo, worktree, git, check, merge, review } = await scenario(t);
  await writeFile(join(worktree, "greeting.txt"), "hello\n");
  await review();
  const status = await check();
  assert.equal(status.plan.commitMessage, `Add greeting (${taskId})`, "the default, shown until a message is written or typed");
  // Checking twice commits nothing: the task branch is still at master, with its work uncommitted.
  await check();
  assert.equal(git(worktree, "rev-parse", "HEAD"), git(repo, "rev-parse", "master"));
  assert.match(git(worktree, "status", "--porcelain"), /greeting\.txt/);

  const message = "feat(greeting): add a greeting file\n\nWritten from paseo.json, then edited.";
  const result = await merge(status.plan.fingerprint, { commitMessage: message });
  assert.equal(result.outcome, "merged", JSON.stringify(result));
  assert.equal(git(repo, "log", "-1", "--format=%B", result.committed), message);
  assert.equal(git(repo, "log", "-1", "--format=%s", "HEAD"), `Merge ${branch}: Add greeting`, "the merge commit's message is unchanged");
});

test("a retry after a conflict still counts Mission Control's own commit when its message was written or edited", async t => {
  // start() replies with the result, not "running", however slow this host is.
  const { repo, worktree, git, check, start, review } = await scenario(t, { replyWithinMs: 600_000 });
  await writeFile(join(worktree, "base.txt"), "task version\n");
  await review();
  await writeFile(join(repo, "base.txt"), "master version\n");
  git(repo, "commit", "-q", "-am", "master change");

  const status = await check();
  // Through Attention (start), the result card records the commit Mission Control made.
  const result = await start(status.plan.fingerprint, { commitMessage: "fix: task version of base" });
  assert.equal(result.outcome, "conflict", JSON.stringify(result));
  assert.equal(git(repo, "log", "-1", "--format=%s", result.committed), "fix: task version of base");
  assert.deepEqual(failing(await check()), [], "the same files, on Mission Control's recorded commit");

  // A commit with another message that no result recorded is not Mission Control's: the branch moved.
  git(worktree, "reset", "-q", "--soft", "HEAD~1");
  git(worktree, "commit", "-q", "-m", "someone else's commit");
  const other = await check();
  assert.deepEqual(failing(other), ["review"]);
  assert.match(detail(other, "review"), /moved from .* after its review was requested/);
});

test("a dirty main checkout is refused and nothing changes", async t => {
  const { repo, worktree, git, check, merge, review, events } = await scenario(t);
  await writeFile(join(worktree, "greeting.txt"), "hello\n");
  await review();
  await writeFile(join(repo, "notes.txt"), "mine\n");
  const mainHead = git(repo, "rev-parse", "HEAD");

  const status = await check();
  assert.equal(status.ready, false);
  assert.deepEqual(failing(status), ["main-checkout"]);
  assert.match(detail(status, "main-checkout"), /1 uncommitted change/);
  const result = await merge(status.plan.fingerprint);
  assert.equal(result.outcome, "refused");
  assert.equal(git(repo, "rev-parse", "HEAD"), mainHead);
  assert.equal(git(worktree, "status", "--porcelain"), "?? greeting.txt");
  assert.deepEqual(events, []);
});

test("an unapproved review, or one that didn't record what it covered, is refused", async t => {
  const finding = { findingId: "finding_1234abcd-0000-4000-8000-000000000000", decisionId, title: "Bug", severity: "high", detail: "", file: null, status: "awaiting_verification", updatedAt: "x", evidence: [] };
  for (const [status, options, reason] of [
    ["changes_requested", {}, /changes requested, not approved/],
    ["open", {}, /still waiting for your answer/],
    ["approved", { findings: [finding] }, /1 finding is still open/],
    // A decision from before dev-flow recorded the reviewed candidate.
    ["approved", { candidate: null }, /didn't record what it covered/],
  ]) {
    const { repo, worktree, git, check, merge, review, events } = await scenario(t);
    await writeFile(join(worktree, "greeting.txt"), "hello\n");
    await review(status, options);
    const mainHead = git(repo, "rev-parse", "HEAD");
    const checked = await check();
    assert.equal(checked.ready, false);
    assert.deepEqual(failing(checked), ["review"]);
    assert.match(detail(checked, "review"), reason);
    const result = await merge(checked.plan.fingerprint);
    assert.equal(result.outcome, "refused");
    assert.match(result.reason, reason);
    assert.equal(git(repo, "rev-parse", "HEAD"), mainHead);
    assert.equal(git(worktree, "rev-parse", "HEAD"), mainHead);
    assert.deepEqual(events, []);
  }
});

test("changes made after the review was requested are refused", async t => {
  // An edit to a reviewed file, a new untracked file, and a new commit each count.
  for (const [change, reason] of [
    [async ({ worktree }) => writeFile(join(worktree, "greeting.txt"), "hello, edited\n"), /1 file differ \(greeting\.txt\)/],
    [async ({ worktree }) => writeFile(join(worktree, "extra.txt"), "not reviewed\n"), /1 file differ \(extra\.txt\)/],
    [async ({ worktree, git }) => { git(worktree, "add", "-A"); git(worktree, "commit", "-q", "-m", "someone's commit"); }, /branch moved from .* after its review was requested/],
  ]) {
    const s = await scenario(t);
    await writeFile(join(s.worktree, "greeting.txt"), "hello\n");
    await s.review();
    assert.deepEqual(failing(await s.check()), []);
    await change(s);
    const status = await s.check();
    assert.deepEqual(failing(status), ["review"]);
    assert.match(detail(status, "review"), reason);
    assert.equal((await s.merge(status.plan.fingerprint)).outcome, "refused");
    assert.deepEqual(s.events, []);
  }
});

test("ignored or untracked local files the merge would overwrite are refused and listed", async t => {
  const { repo, worktree, git, check, merge, review, events } = await scenario(t);
  // The task adds tracked files where the main checkout has ignored ones, and one where a parent is a file.
  await writeFile(join(worktree, "local.env"), "from the task\n");
  git(worktree, "add", "-f", "local.env");
  await mkdir(join(worktree, "build"), { recursive: true });
  await writeFile(join(worktree, "build", "out.txt"), "task\n");
  git(worktree, "add", "-f", "build/out.txt");
  await mkdir(join(worktree, "conf.env"), { recursive: true });
  await writeFile(join(worktree, "conf.env", "guide.md"), "guide\n");
  git(worktree, "add", "-f", "conf.env/guide.md");
  await writeFile(join(worktree, "greeting.txt"), "hello\n");
  await review();
  await writeFile(join(repo, "local.env"), "my secret\n");
  await mkdir(join(repo, "build"), { recursive: true });
  await writeFile(join(repo, "build", "out.txt"), "my build\n");
  // An ignored file where the task needs a folder.
  await writeFile(join(repo, "conf.env"), "a file, not a folder\n");
  assert.equal(git(repo, "status", "--porcelain"), "", "git status can't see any of them");

  const status = await check();
  assert.deepEqual(failing(status), ["local-files"]);
  assert.match(detail(status, "local-files"), /overwrite 3 local files .*: build\/out\.txt, conf\.env, local\.env\. Move or delete them first\./);
  assert.equal((await merge(status.plan.fingerprint)).outcome, "refused");
  assert.equal(await readFile(join(repo, "local.env"), "utf8"), "my secret\n");
  assert.equal(await readFile(join(repo, "build", "out.txt"), "utf8"), "my build\n");
  assert.deepEqual(events, []);
  // Once they're moved, the merge can go ahead.
  await rm(join(repo, "local.env")); await rm(join(repo, "build"), { recursive: true }); await rm(join(repo, "conf.env"));
  assert.deepEqual(failing(await check()), []);
  assert.deepEqual(await localFilesInTheWay(repo, git(repo, "rev-parse", "HEAD"), git(repo, "rev-parse", "HEAD^{tree}")), []);
});

test("background checks never write the index or take index.lock", async t => {
  const { repo, worktree, git, check, review } = await scenario(t);
  await writeFile(join(worktree, "greeting.txt"), "hello\n");
  git(worktree, "add", "greeting.txt");
  await review();
  const indexes = [join(repo, ".git", "index"), git(worktree, "rev-parse", "--path-format=absolute", "--git-path", "index")];
  // New timestamps on unchanged tracked files make git status refresh and rewrite the index, unless optional locks are off.
  const later = new Date(Date.now() + 60_000);
  await utimes(join(repo, "base.txt"), later, later);
  await utimes(join(worktree, "base.txt"), later, later);
  const before = await Promise.all(indexes.map(file => readFile(file)));
  const status = await check();
  assert.deepEqual(failing(status), []);
  const after = await Promise.all(indexes.map(file => readFile(file)));
  assert.ok(before.every((bytes, index) => bytes.equals(after[index])), "the index files are byte-for-byte unchanged");
  assert.equal(git(worktree, "diff", "--cached", "--name-only"), "greeting.txt", "the worktree's staging is kept");
});

test("a commit that fails or times out puts the staging area back exactly and merges nothing", async t => {
  for (const [hookBody, reason] of [
    ["#!/bin/sh\necho 'lint failed' >&2\nexit 1\n", /Couldn't commit the task's uncommitted work: lint failed\. The staging area was put back exactly as it was, and your files are unchanged\. Nothing was merged\./],
    ["#!/bin/sh\nsleep 4\n", /Committing the task's uncommitted work stopped: git commit took longer than 1 s and was stopped\. Check the repository's commit hooks\. The staging area was put back exactly as it was, and your files are unchanged\. Nothing was merged\./],
  ]) {
    const { repo, worktree, git, check, merge, review, events } = await scenario(t, { writeTimeoutMs: 1_000 });
    const hook = join(repo, ".git", "hooks", "pre-commit");
    await writeFile(hook, hookBody);
    await chmod(hook, 0o755);
    // Partial staging: a staged version that differs from the file on disk, a staged new file, and an untracked file.
    await writeFile(join(worktree, "base.txt"), "base\nstaged\n");
    await writeFile(join(worktree, "staged-new.txt"), "new\n");
    git(worktree, "add", "base.txt", "staged-new.txt");
    await writeFile(join(worktree, "base.txt"), "base\nstaged\nunstaged\n");
    await writeFile(join(worktree, "greeting.txt"), "hello\n");
    await review();
    const index = git(worktree, "rev-parse", "--path-format=absolute", "--git-path", "index");
    const indexBefore = await readFile(index);
    const statusBefore = git(worktree, "status", "--porcelain");
    const mainHead = git(repo, "rev-parse", "HEAD");
    const status = await check();
    assert.deepEqual(failing(status), []);
    const result = await merge(status.plan.fingerprint);
    assert.equal(result.outcome, "refused", JSON.stringify(result));
    assert.match(result.reason, reason);
    // The staging area is byte-for-byte what it was, so the message is true.
    assert.ok((await readFile(index)).equals(indexBefore), "the index file is restored exactly");
    assert.equal(git(worktree, "status", "--porcelain"), statusBefore);
    assert.equal(git(worktree, "show", ":base.txt"), "base\nstaged");
    assert.equal(await readFile(join(worktree, "base.txt"), "utf8"), "base\nstaged\nunstaged\n");
    assert.equal(git(worktree, "rev-parse", "HEAD"), mainHead);
    assert.equal(existsSync(`${index}.lock`), false);
    assert.equal(git(repo, "rev-parse", "HEAD"), mainHead);
    assert.deepEqual(events, []);
  }
});

test("a merge that times out is aborted and the main checkout is as it was", t => mergeTimesOut(t));

// Git for Windows puts cmd\git.exe on PATH: a launcher that runs the real git as its child. Stopping only the
// launcher at the time limit left the real git to finish the merge afterwards (task 20), so these run through it.
const gitLauncher = process.env.ProgramFiles ? join(process.env.ProgramFiles, "Git", "cmd", "git.exe") : null;
test("through Git's cmd\\git.exe launcher, a timed-out merge or commit ends the real git too", {
  skip: process.platform !== "win32" || !gitLauncher || !existsSync(gitLauncher) ? "needs Git for Windows' cmd\\git.exe launcher" : false,
}, async t => {
  const path = process.env.PATH;
  process.env.PATH = `${dirname(gitLauncher)};${path}`;
  t.after(() => { process.env.PATH = path; });
  const first = process.env.PATH.split(";").map(folder => join(folder, "git.exe")).find(file => existsSync(file));
  assert.equal(first?.toLowerCase(), gitLauncher.toLowerCase(), "git resolves to the launcher");
  await mergeTimesOut(t);
  await commitTimesOut(t);
});

async function commitTimesOut(t) {
  const { repo, worktree, git, check, merge, review, events } = await scenario(t, { writeTimeoutMs: 1_000 });
  await writeFile(join(repo, ".git", "hooks", "pre-commit"), "#!/bin/sh\nsleep 4\ntouch hook-finished.txt\n");
  await chmod(join(repo, ".git", "hooks", "pre-commit"), 0o755);
  await writeFile(join(worktree, "greeting.txt"), "hello\n");
  await review();
  const mainHead = git(repo, "rev-parse", "HEAD");
  const status = await check();
  assert.deepEqual(failing(status), []);
  const result = await merge(status.plan.fingerprint);
  assert.equal(result.outcome, "refused", JSON.stringify(result));
  assert.match(result.reason, /Committing the task's uncommitted work stopped: git commit took longer than 1 s and was stopped/);
  await new Promise(done => setTimeout(done, 5_000));
  // The hook was ended with git, so it never finished, and no commit appeared after the reply.
  assert.equal(existsSync(join(worktree, "hook-finished.txt")), false);
  assert.equal(git(worktree, "rev-parse", "HEAD"), mainHead);
  assert.equal(existsSync(git(worktree, "rev-parse", "--path-format=absolute", "--git-path", "index.lock")), false);
  assert.deepEqual(events, []);
}

async function mergeTimesOut(t) {
  const { repo, worktree, git, check, merge, review, events } = await scenario(t, { writeTimeoutMs: 1_000 });
  // A merge driver that hangs, so Git is stopped in the middle of the merge.
  await writeFile(join(repo, ".gitattributes"), "base.txt merge=slow\n");
  git(repo, "add", ".gitattributes"); git(repo, "commit", "-q", "-m", "slow merges");
  git(repo, "config", "merge.slow.driver", "sleep 4; exit 1");
  git(worktree, "merge", "-q", "master");
  await writeFile(join(worktree, "base.txt"), "task version\n");
  git(worktree, "commit", "-q", "-am", "task change");
  await writeFile(join(repo, "base.txt"), "master version\n");
  git(repo, "commit", "-q", "-am", "master change");
  await review();
  const mainHead = git(repo, "rev-parse", "HEAD");
  const status = await check();
  assert.deepEqual(failing(status), []);
  const result = await merge(status.plan.fingerprint);
  assert.equal(result.outcome, "conflict", JSON.stringify(result));
  assert.match(result.detail, /stopped: git merge took longer than 1 s and was stopped\. The merge was aborted and master is as it was\./);
  assert.equal(result.state, "aborted");
  assert.equal(git(repo, "rev-parse", "HEAD"), mainHead);
  assert.equal(git(repo, "status", "--porcelain"), "");
  assert.equal(existsSync(join(repo, ".git", "MERGE_HEAD")), false);
  assert.equal(existsSync(join(repo, ".git", "index.lock")), false);
  assert.equal(await readFile(join(repo, "base.txt"), "utf8"), "master version\n");
  assert.deepEqual(events, []);
  // Nothing of the stopped merge carries on after the reply: after the driver's own 4 s it's still as it was.
  await new Promise(done => setTimeout(done, 5_000));
  assert.equal(existsSync(join(repo, ".git", "MERGE_HEAD")), false);
  assert.equal(git(repo, "rev-parse", "HEAD"), mainHead);
  assert.equal(git(repo, "status", "--porcelain"), "");
}

test("a busy agent, a moved checkout and an empty branch are refused", async t => {
  const busy = await scenario(t, { agentStatus: "running" });
  await writeFile(join(busy.worktree, "greeting.txt"), "hello\n");
  await busy.review();
  assert.deepEqual(failing(await busy.check()), ["agent"]);

  const empty = await scenario(t);
  await empty.review();
  assert.deepEqual(failing(await empty.check()), ["work"]);

  // The user confirmed one state, then the main checkout moved: the merge refuses.
  const moved = await scenario(t);
  await writeFile(join(moved.worktree, "greeting.txt"), "hello\n");
  await moved.review();
  const confirmed = await moved.check();
  await writeFile(join(moved.repo, "other.txt"), "other\n");
  moved.git(moved.repo, "add", "."); moved.git(moved.repo, "commit", "-q", "-m", "other");
  const result = await moved.merge(confirmed.plan.fingerprint);
  assert.equal(result.outcome, "refused");
  assert.match(result.reason, /changed since you opened the merge/);
  assert.equal(moved.events.length, 0);
});

test("a review recorded by dev-flow request-decision matches the merge's own fingerprint", async t => {
  const s = await scenario(t);
  await writeFile(join(s.vault, "host.json"), JSON.stringify({ schemaVersion: 1, hostId: "personal", serverId }));
  await mkdir(join(s.vault, "Projects"));
  await writeFile(join(s.vault, "Projects", "test.md"), markdown({ schemaVersion: 1, hostId: "personal", projectId: "prj_test", repository: s.repo, kitRoot: s.repo }));
  const cliRun = (command, extras) => spawnSync(process.execPath, [cli, command, "--task", taskId, "--server", serverId, "--workspace", "wks_task", "--cwd", s.worktree, ...extras], {
    env: { ...process.env, DEV_VAULT_ROOT: s.vault, PASEO_AGENT_ID: "agent-1" }, encoding: "utf8",
  });
  // Staged, unstaged and untracked work, plus an ignored file that isn't part of the review.
  await writeFile(join(s.worktree, "base.txt"), "base\nstaged\n");
  s.git(s.worktree, "add", "base.txt");
  await writeFile(join(s.worktree, "base.txt"), "base\nstaged\nunstaged\n");
  await writeFile(join(s.worktree, "greeting.txt"), "hello\n");
  await writeFile(join(s.worktree, "local.env"), "ignored\n");
  const started = cliRun("start", []);
  assert.equal(started.status, 0, started.stderr);
  const cliRunRecord = JSON.parse(started.stdout).run;
  const input = join(s.base, "decision.json");
  await writeFile(input, JSON.stringify({ kind: "review", question: "Approve?", summary: "Clean." }));
  const requested = cliRun("request-decision", ["--run", cliRunRecord.runId, "--input", input]);
  assert.equal(requested.status, 0, requested.stderr);
  const folder = join(s.folder, "runs", cliRunRecord.runId, "decisions");
  const [name] = await readdir(folder);
  const text = await readFile(join(folder, name), "utf8");
  const fields = Object.fromEntries(/^---\r?\n([\s\S]*?)\r?\n---/.exec(text)[1].split(/\r?\n/).map(line => [line.slice(0, line.indexOf(":")), JSON.parse(line.slice(line.indexOf(":") + 1))]));
  const decision = decisionSchema.parse({ ...fields, status: "approved", resolvedAt: "2026-09-26T00:00:00Z" });
  assert.deepEqual(decision.candidate, await reviewCandidate(s.worktree));

  s.setRun({ ...cliRunRecord, stage: "handoff", outcome: "completed" });
  s.decisions.open = [];
  s.decisions.recent = [s.entry(decision)];
  assert.deepEqual(failing(await s.check()), []);
  await writeFile(join(s.worktree, "greeting.txt"), "hello again\n");
  assert.deepEqual(failing(await s.check()), ["review"]);
});

test("the starting branch comes from the task branch's reflog", async t => {
  const { repo, git } = await scenario(t);
  assert.equal(await startingBranch(repo, branch), "master");
  git(repo, "remote", "add", "origin", repo);
  git(repo, "fetch", "-q", "origin");
  git(repo, "branch", "task/from-origin", "origin/master");
  assert.equal(await startingBranch(repo, "task/from-origin"), "master");
  git(repo, "branch", "task/from-commit", git(repo, "rev-parse", "HEAD"));
  assert.equal(await startingBranch(repo, "task/from-commit"), null);
});

test("the merge takes the exact commit the checks approved, even if the branch moves before it", async t => {
  let worktreeDir;
  let gitRun;
  // Someone commits on the task branch after the checks, just before git merge runs.
  const s = await scenario(t, { beforeMerge: async () => {
    await writeFile(join(worktreeDir, "late.txt"), "not reviewed\n");
    gitRun(worktreeDir, "add", "late.txt");
    gitRun(worktreeDir, "-c", "user.name=Other", "commit", "-q", "-m", "late commit");
  } });
  worktreeDir = s.worktree;
  gitRun = s.git;
  await writeFile(join(s.worktree, "greeting.txt"), "hello\n");
  s.git(s.worktree, "add", "greeting.txt");
  s.git(s.worktree, "commit", "-q", "-m", "greeting");
  const checked = s.git(s.worktree, "rev-parse", "HEAD");
  await s.review();
  const status = await s.check();
  assert.deepEqual(failing(status), []);

  const result = await s.merge(status.plan.fingerprint);
  assert.equal(result.outcome, "merged", JSON.stringify(result));
  // Only the checked commit is merged; the late commit is not in master.
  assert.equal(s.git(s.repo, "rev-parse", "HEAD^2"), checked);
  assert.equal(existsSync(join(s.repo, "greeting.txt")), true);
  assert.equal(existsSync(join(s.repo, "late.txt")), false);
  // The worktree and branch that hold the late commit are kept, and the steps say why.
  const steps = Object.fromEntries(result.steps.map(step => [step.label, step]));
  assert.equal(steps["Archive worktree workspace"].state, "skipped");
  assert.match(steps["Archive worktree workspace"].detail, /gained 1 commit after the checks .*only the checked commit .* was merged, so the worktree workspace was kept/);
  assert.equal(steps["Delete merged branch"].state, "skipped");
  assert.equal(existsSync(s.worktree), true);
  assert.equal(s.git(s.repo, "log", "-1", "--format=%s", branch), "late commit");
  assert.equal(s.events.some(event => event[0] === "archive"), false);
  // The agent is told what actually happens: its workspace and branch are kept, not archived.
  const note = s.events.find(event => event[0] === "send")[1];
  assert.match(note, /gained 1 commit after the checks that wasn't merged, so this worktree workspace and its branch are kept\./);
  assert.doesNotMatch(note, /archived/);
});

test("a case-only rename isn't a local file in the way on a case-insensitive file system", async t => {
  const { repo, worktree, git, check, merge, review } = await scenario(t);
  if (git(repo, "config", "--bool", "core.ignorecase") !== "true") return t.skip("The file system here is case-sensitive.");
  git(worktree, "mv", "base.txt", "Base.txt");
  await review();
  const status = await check();
  assert.deepEqual(failing(status), [], JSON.stringify(status.checks));
  assert.match(detail(status, "local-files"), /No ignored or untracked file/);
  // An ignored file whose name differs only by case from a new tracked path is still in the way.
  const ignored = await scenario(t);
  await writeFile(join(ignored.worktree, "Notes.env"), "task\n");
  ignored.git(ignored.worktree, "add", "-f", "Notes.env");
  await ignored.review();
  await writeFile(join(ignored.repo, "notes.env"), "mine\n");
  const blocked = await ignored.check();
  assert.deepEqual(failing(blocked), ["local-files"]);
  assert.match(detail(blocked, "local-files"), /Notes\.env/);

  const result = await merge(status.plan.fingerprint);
  assert.equal(result.outcome, "merged", JSON.stringify(result));
  assert.equal(git(repo, "ls-files"), ".gitignore\nBase.txt");
});

test("ignored files inside a folder the merge replaces with a file are refused and listed", async t => {
  const { repo, worktree, git, check, merge, review, events } = await scenario(t);
  // master has a tracked folder lib/; the task turns it into a file named lib.
  await mkdir(join(repo, "lib"));
  await writeFile(join(repo, "lib", "a.js"), "a\n");
  git(repo, "add", "lib"); git(repo, "commit", "-q", "-m", "lib folder");
  git(worktree, "merge", "-q", "--ff-only", "master");
  git(worktree, "rm", "-q", "-r", "lib");
  await writeFile(join(worktree, "lib"), "now a file\n");
  git(worktree, "add", "lib");
  await review();
  // Ignored files inside the main checkout's lib/, which the merge would delete with the folder.
  await writeFile(join(repo, "lib", "cache.env"), "keep me\n");
  await mkdir(join(repo, "lib", "build"));
  await writeFile(join(repo, "lib", "build", "out.txt"), "keep me too\n");
  assert.equal(git(repo, "status", "--porcelain"), "", "git status can't see them");

  const status = await check();
  assert.deepEqual(failing(status), ["local-files"]);
  assert.match(detail(status, "local-files"), /overwrite 2 local files .*: lib\/build\/out\.txt, lib\/cache\.env\. Move or delete them first\./);
  assert.equal((await merge(status.plan.fingerprint)).outcome, "refused");
  assert.equal(await readFile(join(repo, "lib", "cache.env"), "utf8"), "keep me\n");
  assert.deepEqual(events, []);
  // Once they're moved, the folder holds only tracked files and the merge replaces it.
  await rm(join(repo, "lib", "cache.env")); await rm(join(repo, "lib", "build"), { recursive: true });
  const ready = await check();
  assert.deepEqual(failing(ready), []);
  assert.equal((await merge(ready.plan.fingerprint)).outcome, "merged");
  assert.equal(await readFile(join(repo, "lib"), "utf8"), "now a file\n");
});

test("the branch head and the task's files come from one moment, or the merge refuses", async t => {
  let armed = false;
  let s;
  // Someone commits the reviewed work right after the checks read the branch head.
  s = await scenario(t, { afterBranchRead: async () => {
    if (!armed) return;
    armed = false;
    s.git(s.worktree, "add", "-A");
    s.git(s.worktree, "commit", "-q", "-m", "committed meanwhile");
  } });
  await writeFile(join(s.worktree, "greeting.txt"), "hello\n");
  await s.review();
  const status = await s.check();
  assert.deepEqual(failing(status), []);
  const mainHead = s.git(s.repo, "rev-parse", "HEAD");
  armed = true;
  const result = await s.merge(status.plan.fingerprint);
  assert.equal(result.outcome, "refused", JSON.stringify(result));
  assert.match(result.reason, /The task branch moved from .* to .* while it was being checked\. Check again\./);
  assert.equal(s.git(s.repo, "rev-parse", "HEAD"), mainHead);
  assert.deepEqual(s.events, []);
});

test("a staged change that was undone in the files doesn't block the merge and is named", async t => {
  const { repo, worktree, git, check, merge, review } = await scenario(t);
  await writeFile(join(worktree, "greeting.txt"), "hello\n");
  git(worktree, "add", "greeting.txt");
  git(worktree, "commit", "-q", "-m", "greeting");
  // Stage a change, then undo it in the file: Git still lists base.txt, but its content matches the branch.
  await writeFile(join(worktree, "base.txt"), "changed\n");
  git(worktree, "add", "base.txt");
  await writeFile(join(worktree, "base.txt"), "base\n");
  assert.equal(git(worktree, "status", "--porcelain"), "MM base.txt");
  await review();

  const status = await check();
  assert.deepEqual(failing(status), [], JSON.stringify(status.checks));
  assert.doesNotMatch(detail(status, "work"), /Check again/);
  assert.match(detail(status, "work"), /1 commit to merge\. Git also lists base\.txt as changed, but its content matches .*, so it isn't part of the merge\./);
  assert.deepEqual(status.plan.uncommittedFiles, []);
  assert.deepEqual(status.plan.undoneFiles, ["base.txt"]);

  const result = await merge(status.plan.fingerprint);
  assert.equal(result.outcome, "merged", JSON.stringify(result));
  // Nothing was committed for it, master has the reviewed file, and the worktree was clean to archive.
  assert.equal(result.committed, null);
  assert.equal(await readFile(join(repo, "base.txt"), "utf8"), "base\n");
  assert.deepEqual(result.steps.filter(step => step.state !== "done"), []);
});

test("with only an undone staged change there is nothing to merge, and the check says so exactly", async t => {
  const { worktree, git, check, review } = await scenario(t);
  await writeFile(join(worktree, "base.txt"), "changed\n");
  git(worktree, "add", "base.txt");
  await writeFile(join(worktree, "base.txt"), "base\n");
  await review();

  const status = await check();
  assert.deepEqual(failing(status), ["work"]);
  assert.match(detail(status, "work"), /has no commits or uncommitted changes that master lacks\. Git also lists base\.txt as changed, but its content matches/);
});

test("the note to the agent only states what has happened, so a later failure can't make it untrue", async t => {
  const { worktree, check, merge, review, events } = await scenario(t, {
    deliver: async () => { throw new Error("The task file is locked."); },
    archive: async () => ({ archivedAt: null, error: "Paseo couldn't archive it." }),
  });
  await writeFile(join(worktree, "greeting.txt"), "hello\n");
  await review();
  const status = await check();
  const result = await merge(status.plan.fingerprint);
  assert.equal(result.outcome, "merged", JSON.stringify(result));
  const steps = Object.fromEntries(result.steps.map(step => [step.label, step.state]));
  assert.equal(steps["Mark delivered"], "failed");
  assert.equal(steps["Archive worktree workspace"], "failed");
  const note = events.find(event => event[0] === "send")[1];
  // Delivery failed before the note, so the note says so; the archive comes after it, so it is only a plan.
  assert.match(note, /Marking the task delivered didn't work; Mission Control's merge result says why\./);
  assert.doesNotMatch(note, /is delivered|marked delivered\.|is being archived|was archived/);
  assert.match(note, /Next, Mission Control will archive this worktree workspace/);
});

test("a slow merge replies early, finishes in the background and keeps its result card until dismissed", async t => {
  let release;
  const held = new Promise(done => { release = done; });
  const s = await scenario(t, { replyWithinMs: 50, beforeMerge: () => held });
  await writeFile(join(s.worktree, "greeting.txt"), "hello\n");
  await s.review();
  const status = await s.check();
  assert.equal(status.ready, true);

  const reply = await s.start(status.plan.fingerprint);
  assert.equal(reply.outcome, "running", JSON.stringify(reply));
  // Meanwhile the checks say it's being merged, a second start is refused, and progress shows the step.
  const during = await s.check();
  assert.equal(during.ready, false);
  assert.match(detail(during, "task"), /being merged or delivered now/);
  assert.equal((await s.start(status.plan.fingerprint)).outcome, "refused");
  // The merge is held just before `git merge`, so its card reaches that step and stays there.
  const card = async () => (await s.results.list()).map(entry => deliveryResultSchema.parse(entry)).find(entry => entry.resultId === reply.resultId);
  let running;
  for (let attempt = 0; attempt < 400 && running?.step !== "Merging into master"; attempt++) {
    await new Promise(done => setTimeout(done, 25));
    running = await card();
  }
  assert.equal(running.kind, "merge");
  assert.equal(running.state, "running");
  assert.equal(running.taskTitle, "Add greeting");
  assert.equal(running.step, "Merging into master");
  // A running card can't be dismissed.
  assert.equal(await s.results.dismiss(reply.resultId), false);

  release();
  let entry;
  for (let attempt = 0; attempt < 400 && entry?.state !== "finished"; attempt++) {
    await new Promise(done => setTimeout(done, 25));
    entry = await card();
  }
  assert.equal(entry.state, "finished", JSON.stringify(entry));
  assert.equal(entry.result.outcome, "merged");
  assert.deepEqual(entry.result.steps.map(step => step.state), ["done", "done", "done", "done", "done"]);
  assert.equal(s.git(s.repo, "rev-parse", "HEAD"), entry.result.mergeCommit);
  // The task is delivered (it leaves Ready), but the card stays, on disk too, until it is dismissed.
  assert.match(readFileSync(join(s.folder, "task.md"), "utf8"), /status: "delivered"/);
  // The file is written after the card changes in memory (writes are queued), so wait for it to catch up.
  let saved = null;
  for (let attempt = 0; attempt < 200 && saved?.result?.outcome !== "merged"; attempt++) {
    if (attempt) await new Promise(done => setTimeout(done, 25));
    saved = JSON.parse(readFileSync(join(s.base, "delivery-results.json"), "utf8")).find(item => item.resultId === reply.resultId);
  }
  assert.equal(saved.result.outcome, "merged");
  assert.equal(await s.results.dismiss(reply.resultId), true);
  assert.equal(await card(), undefined);
});

test("a merge that finishes before the reply returns its result and keeps its card until dismissed", async t => {
  const s = await scenario(t);
  await writeFile(join(s.worktree, "greeting.txt"), "hello\n");
  await s.review();
  const status = await s.check();
  const reply = await s.start(status.plan.fingerprint);
  assert.equal(reply.outcome, "merged", JSON.stringify(reply));
  const cards = await s.results.list();
  assert.equal(cards.length, 1);
  assert.equal(cards[0].result.mergeCommit, reply.mergeCommit);
  assert.equal(await s.results.dismiss(cards[0].resultId), true);
  assert.deepEqual(await s.results.list(), []);
});

test("a result card still running when the plugin's process ended shows as interrupted", async t => {
  const base = await realpath(await mkdtemp(join(tmpdir(), "mission-results-")));
  t.after(() => rm(base, { recursive: true, force: true }));
  const file = join(base, "delivery-results.json");
  await writeFile(file, JSON.stringify([{ kind: "merge", resultId: "earlier-process", taskId, taskTitle: "Add greeting", startedAt: "2026-09-26T10:00:00Z", step: "Merging into master", state: "running", finishedAt: null, error: null, result: null }]));
  const [entry] = await createDeliveryResults({ file }).list();
  assert.equal(entry.state, "failed");
  assert.match(entry.error, /Mission Control restarted while this was at "Merging into master"/);
  assert.equal(await createDeliveryResults({ file }).dismiss("earlier-process"), true);
});

test("Merge refuses a pull-request project and a task that already has a pull request", async t => {
  const s = await scenario(t, { deliveryMode: async () => "pull-request" });
  await writeFile(join(s.worktree, "greeting.txt"), "hello\n");
  await s.review();
  const status = await s.check();
  assert.deepEqual(failing(status), ["task"]);
  assert.match(detail(status, "task"), /delivers by pull request/);
  assert.equal((await s.service.ready(serverId)).tasks[0].delivery, "pull-request");

  const recorded = await scenario(t);
  recorded.task.pullRequest = { forge: "github", url: "https://github.com/o/r/pull/7", number: 7, repository: "o/r", targetBranch: "master", taskBranch: branch, head: recorded.baseCommit, createdAt: "2026-09-26T00:00:00Z" };
  await recorded.review();
  assert.match(detail(await recorded.check(), "task"), /pull request https:\/\/github.com\/o\/r\/pull\/7/);
  assert.deepEqual((await recorded.service.ready(serverId)).tasks, []);
});

test("Ready to merge lists tasks whose latest run's review is approved, and nothing else", async t => {
  const s = await scenario(t);
  await writeFile(join(s.worktree, "greeting.txt"), "hello\n");
  await s.review("open");
  assert.deepEqual((await s.service.ready(serverId)).tasks, []);
  await s.review("changes_requested");
  assert.deepEqual((await s.service.ready(serverId)).tasks, []);
  await s.review("approved");
  const { tasks } = await s.service.ready(serverId);
  assert.deepEqual(tasks.map(task => mergeReadyTaskSchema.parse(task)), [{ taskId, title: "Add greeting", workspaceId: "wks_task", approvedAt: "2026-09-22T01:00:00Z", delivery: "merge" }]);
  // A newer run's approval is what counts; the old run's approval says nothing about new work.
  s.setRun({ ...s.run(), runId: "run_99999999-0000-4000-8000-000000000000", stage: "execute", outcome: "in_progress" });
  assert.deepEqual((await s.service.ready(serverId)).tasks, []);
});

test("Ready to merge leaves out approved tasks that didn't run in their own worktree", async t => {
  const s = await scenario(t);
  await writeFile(join(s.worktree, "greeting.txt"), "hello\n");
  await s.review("approved");
  assert.equal((await s.service.ready(serverId)).tasks.length, 1);
  // The same approved task without a worktree has no branch to merge, so it isn't listed (nor counted in Attention).
  delete s.task.worktree;
  assert.deepEqual((await s.service.ready(serverId)).tasks, []);
  assert.match(detail(await s.check(), "task"), /didn't run in its own worktree/);
});

test("a stopped merge or commit that can't be confirmed gone is reported as unknown, and nothing is undone on a guess", async t => {
  processTreeTesting.kill = async pid => { await killTree(pid); return false; };
  t.after(() => { processTreeTesting.kill = null; });
  // The merge: Git is stopped in its merge driver.
  const s = await scenario(t, { writeTimeoutMs: 1_000 });
  await writeFile(join(s.repo, ".gitattributes"), "base.txt merge=slow\n");
  s.git(s.repo, "add", ".gitattributes"); s.git(s.repo, "commit", "-q", "-m", "slow merges");
  s.git(s.repo, "config", "merge.slow.driver", "sleep 4; exit 1");
  s.git(s.worktree, "merge", "-q", "master");
  await writeFile(join(s.worktree, "base.txt"), "task version\n");
  s.git(s.worktree, "commit", "-q", "-am", "task change");
  await writeFile(join(s.repo, "base.txt"), "master version\n");
  s.git(s.repo, "commit", "-q", "-am", "master change");
  await s.review();
  const mainHead = s.git(s.repo, "rev-parse", "HEAD");
  const result = await s.merge((await s.check()).plan.fingerprint);
  assert.equal(result.outcome, "conflict", JSON.stringify(result));
  assert.match(result.detail, /couldn't confirm .* The main checkout's state is unknown, so nothing was aborted, reset or unlocked\. Check .* \(git status\)/);
  // The card's summary follows this state, so it never says "aborted" here.
  assert.equal(result.state, "unknown");
  assert.equal(s.git(s.repo, "rev-parse", "HEAD"), mainHead);
  assert.deepEqual(s.events, []);

  // The commit: Git is stopped in a pre-commit hook; the staging area isn't restored on a guess.
  const c = await scenario(t, { writeTimeoutMs: 1_000 });
  await writeFile(join(c.repo, ".git", "hooks", "pre-commit"), "#!/bin/sh\nsleep 4\n");
  await chmod(join(c.repo, ".git", "hooks", "pre-commit"), 0o755);
  await writeFile(join(c.worktree, "greeting.txt"), "hello\n");
  await c.review();
  const refused = await c.merge((await c.check()).plan.fingerprint);
  assert.equal(refused.outcome, "refused", JSON.stringify(refused));
  assert.match(refused.reason, /The worktree's state is unknown, so nothing was undone: its index\.lock and staging area are left as they are/);
  assert.deepEqual(c.events, []);
});

test("two merges started at the same moment: one runs, the other is refused", async t => {
  const s = await scenario(t);
  await writeFile(join(s.worktree, "greeting.txt"), "hello\n");
  await s.review();
  const { fingerprint } = (await s.check()).plan;
  const replies = await Promise.all([s.start(fingerprint), s.start(fingerprint)]);
  assert.deepEqual(replies.map(reply => reply.outcome).sort(), ["merged", "refused"], JSON.stringify(replies));
  assert.match(replies.find(reply => reply.outcome === "refused").reason, /already being merged or delivered/);
  assert.equal((await s.results.list()).length, 1);
});
