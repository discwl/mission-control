import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

const require = createRequire(import.meta.url);
const ts = require("typescript");
require.extensions[".ts"] = (module, file) => module._compile(ts.transpileModule(readFileSync(file, "utf8"), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText, file);
const { createTaskWorktree, parseWorktreeList, taskBranchName, templatedBranchConflict, worktreeSlugFor } = require("./worktree.ts");
const { branchPreview, registerBranchNames } = require("./branch-names.ts");
const { branchNameSettings } = require("../shared/branch-names.ts");
const { collectSnapshot } = require("./review.ts");

const task = { taskId: "task_1234abcd-0000-4000-8000-000000000000", title: "Fix the Review badge!", projectId: "prj_test" };

test("task branch names are fixed per task and safe for Git", () => {
  assert.deepEqual(taskBranchName(task), { branch: "task/1234abcd-fix-the-review-badge", slug: "1234abcd-fix-the-review-badge" });
  assert.deepEqual(taskBranchName({ taskId: "task_ffffeeee-1", title: "!!!" }), { branch: "task/ffffeeee", slug: "ffffeeee" });
});

test("templated branches get a unique folder name led by the short task ID", () => {
  assert.equal(worktreeSlugFor(task, "feature/ABC-123-add-login-retry"), "1234abcd-feature-abc-123-add-login-retry");
  assert.equal(worktreeSlugFor(task, "ABC-123/1234abcd-add-login-retry"), "abc-123-1234abcd-add-login-retry");
  assert.equal(worktreeSlugFor(task, `ABC-123-${"long-".repeat(20)}`).length <= 60, true);
});

test("worktree lists parse paths and branches", () => {
  const list = parseWorktreeList("worktree C:/repo\nHEAD abc\nbranch refs/heads/master\n\nworktree C:/wt\nHEAD def\nbranch refs/heads/task/x\n\nworktree C:/detached\nHEAD 123\ndetached\n");
  assert.deepEqual(list.map(entry => [entry.path, entry.branch]), [["C:/repo", "refs/heads/master"], ["C:/wt", "refs/heads/task/x"], ["C:/detached", null]]);
});

async function repository(t) {
  const base = await realpath(await mkdtemp(join(tmpdir(), "mission-worktree-")));
  t.after(() => rm(base, { recursive: true, force: true }));
  const repo = join(base, "repo");
  execFileSync("git", ["init", "-q", "-b", "master", repo]);
  const git = (cwd, ...args) => execFileSync("git", ["-C", cwd, "-c", "user.name=Test", "-c", "user.email=test@example.com", ...args], { encoding: "utf8" }).trim();
  await writeFile(join(repo, "base.txt"), "base\n");
  git(repo, "add", "."); git(repo, "commit", "-q", "-m", "base");
  // A stand-in for Paseo that creates worktrees with plain Git.
  const registered = [];
  const calls = [];
  const paseo = { workspaces: {
    list: async () => ({ entries: registered }),
    open: async ({ cwd }) => { const workspace = { id: `wks_opened${registered.length}`, workspaceDirectory: cwd, archivingAt: null }; registered.push(workspace); return { id: workspace.id }; },
    create: async options => {
      calls.push(options);
      const source = options.source;
      // Like Paseo, the worktree's folder is named by its slug.
      const directory = join(base, "worktrees", source.worktreeSlug);
      if (source.action === "checkout") git(source.cwd, "worktree", "add", "-q", directory, source.refName);
      else git(source.cwd, "worktree", "add", "-q", "-b", source.branchName, directory, source.baseBranch ?? "HEAD");
      const workspace = { id: `wks_new${registered.length}`, workspaceDirectory: directory, archivingAt: null };
      registered.push(workspace);
      return { id: workspace.id, directory, refresh: async () => workspace };
    },
  } };
  return { base, repo, git, paseo, calls, registered };
}

test("a task worktree branches from the current branch and is found again after an interrupted start", async t => {
  const { repo, git, paseo, calls } = await repository(t);
  const head = git(repo, "rev-parse", "HEAD");
  const first = await createTaskWorktree({ task, sourceCwd: repo }, paseo);
  assert.equal(first.branch, "task/1234abcd-fix-the-review-badge");
  assert.equal(first.baseCommit, head);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].source.action, "branch-off");
  assert.equal(calls[0].source.baseBranch, "master");
  assert.equal(calls[0].idempotencyKey, `mission-control-worktree-${task.taskId}`);
  // New commits on the source branch do not move the task's branch point.
  await writeFile(join(repo, "later.txt"), "later\n");
  git(repo, "add", "."); git(repo, "commit", "-q", "-m", "later");
  const again = await createTaskWorktree({ task, sourceCwd: repo }, paseo);
  assert.equal(again.workspaceId, first.workspaceId);
  assert.equal(again.baseCommit, head);
  assert.equal(calls.length, 1, "an existing worktree is reused, not recreated");
});

test("a kept task branch without a worktree is checked out instead of recreated", async t => {
  const { repo, git, paseo, calls } = await repository(t);
  const first = await createTaskWorktree({ task, sourceCwd: repo }, paseo);
  git(repo, "worktree", "remove", "--force", first.directory);
  const again = await createTaskWorktree({ task, sourceCwd: repo }, paseo);
  assert.equal(calls.length, 2);
  assert.equal(calls[1].source.action, "checkout");
  assert.equal(calls[1].source.refName, first.branch);
  assert.equal(again.branch, first.branch);
});

test("a templated branch is created exactly as previewed and found again", async t => {
  const { repo, git, paseo, calls } = await repository(t);
  const ticketed = { ...task, title: "ABC-123 · Add login retry", ticket: { system: "jira", key: "ABC-123", url: "https://example.atlassian.net/browse/ABC-123" } };
  for (const [template, expected] of [
    ["{ticket}-{slug}", "ABC-123-add-login-retry"],
    ["feature/{ticket}-{slug}", "feature/ABC-123-add-login-retry"],
    ["bugfix/{ticket}-{slug}", "bugfix/ABC-123-add-login-retry"],
  ]) assert.deepEqual(branchPreview(ticketed, template, new Map()).options.map(option => option.name), [expected]);
  const preview = branchPreview(ticketed, "{type}/{ticket}-{slug}", new Map());
  const bugfix = preview.options.find(option => option.type === "bugfix");
  const created = await createTaskWorktree({ task: ticketed, sourceCwd: repo, branch: bugfix.name }, paseo);
  assert.equal(created.branch, "bugfix/ABC-123-add-login-retry");
  assert.equal(git(created.directory, "symbolic-ref", "--short", "HEAD"), bugfix.name);
  assert.equal(calls[0].source.branchName, bugfix.name);
  assert.equal(calls[0].source.worktreeSlug, "1234abcd-bugfix-abc-123-add-login-retry");
  const again = await createTaskWorktree({ task: ticketed, sourceCwd: repo, branch: bugfix.name }, paseo);
  assert.equal(again.workspaceId, created.workspaceId);
  assert.equal(calls.length, 1);
  // Another task can't take the same branch.
  assert.match(branchPreview({ ...ticketed, taskId: "task_ffffeeee-1" }, "{type}/{ticket}-{slug}", new Map([[bugfix.name, ticketed.title]])).options[1].problem, /already uses this branch/);
});

test("without a template or a ticket the preview keeps task/<id>-<slug>", () => {
  const ticketed = { ...task, ticket: { system: "jira", key: "ABC-123", url: "https://example.atlassian.net/browse/ABC-123" } };
  assert.deepEqual(branchPreview(ticketed, undefined, new Map()).options, [{ type: null, name: "task/1234abcd-fix-the-review-badge", problem: null }]);
  const noTicket = branchPreview(task, "{ticket}-{slug}", new Map());
  assert.equal(noTicket.source, "default");
  assert.deepEqual(noTicket.options.map(option => option.name), ["task/1234abcd-fix-the-review-badge"]);
  assert.match(noTicket.note, /no ticket/);
});

test("a templated name never takes over a branch or checkout someone made by hand", async t => {
  const { base, repo, git, paseo, calls } = await repository(t);
  const ticketed = { ...task, title: "ABC-123 · Add login retry", ticket: { system: "jira", key: "ABC-123", url: "https://example.atlassian.net/browse/ABC-123" } };
  // Checked out in the source checkout itself.
  git(repo, "switch", "-q", "-c", "ABC-123-add-login-retry");
  assert.match(await templatedBranchConflict(repo, ticketed, "ABC-123-add-login-retry"), /already checked out in .*repo/);
  await assert.rejects(createTaskWorktree({ task: ticketed, sourceCwd: repo, branch: "ABC-123-add-login-retry" }, paseo), /already checked out.*won't take it over/);
  git(repo, "switch", "-q", "master"); git(repo, "branch", "-q", "-D", "ABC-123-add-login-retry");
  // Checked out in a worktree someone else made, and kept without any checkout.
  git(repo, "worktree", "add", "-q", "-b", "feature/ABC-123-add-login-retry", join(base, "mine"));
  await assert.rejects(createTaskWorktree({ task: ticketed, sourceCwd: repo, branch: "feature/ABC-123-add-login-retry" }, paseo), /already checked out in .*mine/);
  git(repo, "branch", "bugfix/ABC-123-add-login-retry");
  await assert.rejects(createTaskWorktree({ task: ticketed, sourceCwd: repo, branch: "bugfix/ABC-123-add-login-retry" }, paseo), /already exists in this repository/);
  assert.equal(calls.length, 0, "no worktree was requested");
  assert.equal(git(repo, "symbolic-ref", "--short", "HEAD"), "master");
  // The task's own worktree from an interrupted start is still found again.
  assert.equal(await templatedBranchConflict(repo, ticketed, "ABC-123-add-login-retry"), null);
  const created = await createTaskWorktree({ task: ticketed, sourceCwd: repo, branch: "ABC-123-add-login-retry" }, paseo);
  assert.equal(await templatedBranchConflict(repo, ticketed, created.branch), null);
  assert.match(await templatedBranchConflict(repo, { taskId: "task_ffffeeee-1" }, created.branch), /already checked out/);
});

test("a worktree Paseo returns on another branch is not recorded as the task's", async t => {
  const { repo, paseo } = await repository(t);
  const first = await createTaskWorktree({ task, sourceCwd: repo, branch: "feature/ABC-123-x" }, paseo);
  // Paseo's idempotency key hands back the task's first worktree for a retry with another name.
  const create = paseo.workspaces.create;
  paseo.workspaces.create = async () => ({ id: first.workspaceId, directory: first.directory, refresh: async () => ({ workspaceDirectory: first.directory }) });
  await assert.rejects(createTaskWorktree({ task, sourceCwd: repo, branch: "bugfix/ABC-123-x" }, paseo), /is on feature\/ABC-123-x, not bugfix\/ABC-123-x/);
  paseo.workspaces.create = create;
});

test("saved templates load with the project override first and other tasks' branches marked", async t => {
  const { repo, git } = await repository(t);
  git(repo, "branch", "ABC-123-x-hand-made");
  const ticketed = { ...task, projectId: "prj_a", title: "ABC-123 · Add login retry", ticket: { system: "jira", key: "ABC-123", url: "https://example.atlassian.net/browse/ABC-123" } };
  const other = (taskId, projectId, branch) => ({ task: { taskId, projectId, title: `Task ${taskId}`, worktree: { branch } } });
  let stored = branchNameSettings.schema.parse(JSON.parse(JSON.stringify({ template: "{ticket}-{slug}", projects: { prj_a: "feature/{ticket}-{slug}" } })));
  assert.deepEqual(stored, { template: "{ticket}-{slug}", projects: { prj_a: "feature/{ticket}-{slug}" } });
  let state = "ready";
  const server = { registerSettings: definition => { assert.equal(definition, branchNameSettings); return { read: async () => state === "ready" ? { status: "ready", revision: "1", values: stored } : { status: "invalid", revision: "1", error: "bad file" } }; } };
  const sources = async serverId => { assert.equal(serverId, "srv"); return [
    { task: ticketed }, other("task_b", "prj_a", "feature/ABC-123-add-login-retry"), other("task_c", "prj_b", "ABC-123-add-login-retry"),
  ]; };
  const names = registerBranchNames(server, sources);
  const withOverride = await names.preview(ticketed, "srv", repo);
  assert.deepEqual(withOverride.options.map(option => [option.name, option.problem]), [["feature/ABC-123-add-login-retry", 'The task "Task task_b" already uses this branch.']]);
  const hostTemplate = await names.preview({ ...ticketed, projectId: "prj_c" }, "srv", repo);
  assert.deepEqual(hostTemplate.options.map(option => [option.name, option.problem]), [["ABC-123-add-login-retry", null]], "a same-named branch in another project is fine");
  // A branch Git already has is flagged before Start, not only when the worktree is created.
  stored = { ...stored, projects: { ...stored.projects, prj_d: "{ticket}-x-hand-made" } };
  const handMade = await names.preview({ ...ticketed, projectId: "prj_d" }, "srv", repo);
  assert.match(handMade.options[0].problem, /ABC-123-x-hand-made already exists/);
  stored = { template: "", projects: {} };
  assert.equal((await names.preview(ticketed, "srv", repo)).options[0].name, "task/1234abcd-abc-123-add-login-retry");
  state = "invalid";
  await assert.rejects(names.preview(ticketed, "srv", repo), /branch name settings can't be read: bad file/);
});

test("Git's rules are checked before any worktree is created", async t => {
  const { repo, paseo, calls } = await repository(t);
  for (const name of ["ABC 123-x", "feature/.hidden", "a..b", "x.lock"]) {
    await assert.rejects(createTaskWorktree({ task, sourceCwd: repo, branch: name }, paseo), /Git won't accept the branch name/);
  }
  assert.equal(calls.length, 0);
});

test("review since the branch point includes the task's commits and uncommitted work", async t => {
  const { repo, git, paseo } = await repository(t);
  const worktree = await createTaskWorktree({ task, sourceCwd: repo }, paseo);
  await writeFile(join(worktree.directory, "feature.txt"), "feature\n");
  git(worktree.directory, "add", "."); git(worktree.directory, "commit", "-q", "-m", "feature");
  await writeFile(join(worktree.directory, "draft.txt"), "draft\n");
  assert.deepEqual((await collectSnapshot(worktree.directory)).files.map(file => file.path), ["draft.txt"]);
  const since = await collectSnapshot(worktree.directory, null, worktree.baseCommit);
  assert.equal(since.base, "since");
  assert.equal(since.sinceCommit.commits, 1);
  assert.deepEqual(since.files.map(file => file.path).sort(), ["draft.txt", "feature.txt"]);
});

// The source gets an origin (without origin/HEAD), moves to a local branch with its own commit,
// and origin then gains a commit the source has not fetched.
async function withOrigin(t) {
  const setup = await repository(t);
  const { base, repo, git } = setup;
  const origin = join(base, "origin.git");
  const upstream = join(base, "upstream");
  execFileSync("git", ["clone", "-q", "--bare", repo, origin], { stdio: "pipe" });
  git(repo, "remote", "add", "origin", origin); git(repo, "fetch", "-q", "origin");
  const localMaster = git(repo, "rev-parse", "master");
  git(repo, "switch", "-q", "-c", "feature");
  await writeFile(join(repo, "local.txt"), "local\n");
  git(repo, "add", "."); git(repo, "commit", "-q", "-m", "local only");
  execFileSync("git", ["clone", "-q", origin, upstream], { stdio: "pipe" });
  const push = async (branch, file) => {
    git(upstream, "switch", "-q", "-C", branch);
    await writeFile(join(upstream, file), `${file}\n`);
    git(upstream, "add", "."); git(upstream, "commit", "-q", "-m", file); git(upstream, "push", "-q", "origin", branch);
    return git(upstream, "rev-parse", "HEAD");
  };
  const fresh = await push("master", "fresh.txt");
  return { ...setup, origin, upstream, push, fresh, localMaster };
}

test("a new task worktree starts from the freshly fetched origin default branch, not the local branch", async t => {
  const { repo, git, paseo, calls, fresh, localMaster } = await withOrigin(t);
  const worktree = await createTaskWorktree({ task, sourceCwd: repo }, paseo);
  assert.equal(calls[0].source.action, "branch-off");
  assert.equal(calls[0].source.baseBranch, "origin/master", "origin's HEAD branch is found without a local origin/HEAD");
  assert.equal(git(worktree.directory, "rev-parse", "HEAD"), fresh);
  assert.equal(worktree.baseCommit, fresh);
  // The source checkout's branches are fetched past, never moved.
  assert.equal(git(repo, "rev-parse", "master"), localMaster);
  assert.equal(git(repo, "symbolic-ref", "--short", "HEAD"), "feature");
  // Everything since the branch point is the task's own work, not upstream or source-only commits.
  await writeFile(join(worktree.directory, "task.txt"), "task\n");
  git(worktree.directory, "add", "."); git(worktree.directory, "commit", "-q", "-m", "task");
  const since = await collectSnapshot(worktree.directory, null, worktree.baseCommit);
  assert.equal(since.sinceCommit.commits, 1);
  assert.deepEqual(since.files.map(file => file.path), ["task.txt"]);
});

test("a configured default branch is fetched and used as the starting point", async t => {
  const { repo, git, paseo, calls, push } = await withOrigin(t);
  const release = await push("release", "release.txt");
  const worktree = await createTaskWorktree({ task, sourceCwd: repo, defaultBranch: "release" }, paseo);
  assert.equal(calls[0].source.baseBranch, "origin/release");
  assert.equal(git(worktree.directory, "rev-parse", "HEAD"), release);
  assert.equal(worktree.baseCommit, release);
});

test("a missing default branch or a failed fetch stops before any worktree is created", async t => {
  const { base, repo, git, paseo, calls } = await withOrigin(t);
  await assert.rejects(createTaskWorktree({ task, sourceCwd: repo, defaultBranch: "nope" }, paseo), /Origin has no branch "nope"/);
  git(repo, "remote", "set-url", "origin", join(base, "missing.git"));
  await assert.rejects(createTaskWorktree({ task, sourceCwd: repo }, paseo), /Couldn't fetch origin.*start the task in this workspace/s);
  assert.equal(calls.length, 0);
});

test("an interrupted start is found again offline and keeps its branch point", async t => {
  const { base, repo, git, paseo, calls, push, fresh } = await withOrigin(t);
  const first = await createTaskWorktree({ task, sourceCwd: repo }, paseo);
  // Origin moves on, then becomes unreachable, and the saved default branch changes.
  await push("master", "later.txt"); await push("release", "release.txt");
  git(repo, "remote", "set-url", "origin", join(base, "missing.git"));
  const again = await createTaskWorktree({ task, sourceCwd: repo, defaultBranch: "release" }, paseo);
  assert.equal(again.workspaceId, first.workspaceId);
  assert.equal(again.baseCommit, fresh);
  // A kept branch whose worktree was removed is checked out again, also without fetching.
  git(repo, "worktree", "remove", "--force", first.directory);
  const restored = await createTaskWorktree({ task, sourceCwd: repo, defaultBranch: "release" }, paseo);
  assert.equal(calls.length, 2);
  assert.equal(calls[1].source.action, "checkout");
  assert.equal(restored.baseCommit, fresh);
});
