import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

const require = createRequire(import.meta.url);
const ts = require("typescript");
require.extensions[".ts"] = (module, file) => module._compile(ts.transpileModule(readFileSync(file, "utf8"), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText, file);
const { existingFiles, projectGitStatus, pullLatest, registerProjectGit, taskStartingPoint } = require("./project-git.ts");
const { getProjectGitStatus, projectGitSettings, pullProjectLatest } = require("../shared/project-git.ts");

// origin (bare, default branch main), a clone that is the project's main checkout, and an upstream clone that pushes.
async function fixture(t) {
  const base = await realpath(await mkdtemp(join(tmpdir(), "mission-project-git-")));
  t.after(() => rm(base, { recursive: true, force: true }));
  const git = (cwd, ...args) => execFileSync("git", ["-C", cwd, "-c", "user.name=Test", "-c", "user.email=test@example.com", ...args], { encoding: "utf8", stdio: "pipe" }).trim();
  const origin = join(base, "origin.git");
  const upstream = join(base, "upstream");
  const repo = join(base, "repo");
  execFileSync("git", ["init", "-q", "--bare", "-b", "main", origin]);
  execFileSync("git", ["init", "-q", "-b", "main", upstream]);
  const commit = async (cwd, file) => {
    await writeFile(join(cwd, file), `${file}\n`);
    git(cwd, "add", "."); git(cwd, "commit", "-q", "-m", file);
    return git(cwd, "rev-parse", "HEAD");
  };
  await commit(upstream, "base.txt");
  git(upstream, "remote", "add", "origin", origin); git(upstream, "push", "-q", "origin", "main");
  execFileSync("git", ["clone", "-q", origin, repo], { stdio: "pipe" });
  const advance = async (file = "upstream.txt", branch = "main") => {
    git(upstream, "fetch", "-q", "origin", branch); git(upstream, "switch", "-q", "-C", branch, "FETCH_HEAD");
    const sha = await commit(upstream, file);
    git(upstream, "push", "-q", "origin", branch);
    return sha;
  };
  // Everything Pull latest must never touch.
  const snapshot = () => ({
    head: git(repo, "rev-parse", "HEAD"), at: git(repo, "rev-parse", "--abbrev-ref", "HEAD"),
    status: git(repo, "status", "--porcelain", "--untracked-files=all"), stashes: git(repo, "stash", "list"),
    branches: git(repo, "for-each-ref", "--format=%(refname) %(objectname)", "refs/heads"),
  });
  return { base, origin, upstream, repo, git, commit, advance, snapshot };
}

test("settings default to origin's branch with auto-fetch off and survive a save and load", () => {
  const { schema } = projectGitSettings;
  assert.equal(projectGitSettings.id, "project-git");
  assert.deepEqual(schema.parse({}), { projects: {} });
  const saved = schema.parse({ projects: { prj_a: { defaultBranch: " release/2026 " }, prj_b: { autoFetch: true } } });
  assert.deepEqual(saved, { projects: { prj_a: { defaultBranch: "release/2026", autoFetch: false }, prj_b: { autoFetch: true } } });
  assert.deepEqual(schema.parse(JSON.parse(JSON.stringify(saved))), saved);
  for (const bad of ["-f", "a..b", "HEAD", "with space", "x.lock", "/main", "main/", ""]) {
    assert.equal(schema.safeParse({ projects: { prj_a: { defaultBranch: bad } } }).success, false, bad);
  }
});

test("pull latest fast-forwards a clean default branch that is behind", async t => {
  const { repo, git, advance } = await fixture(t);
  const fresh = await advance();
  const result = await pullLatest(repo, undefined);
  assert.equal(result.outcome, "updated");
  assert.match(result.message, /Fast-forwarded main by 1 commit to origin\/main/);
  assert.equal(git(repo, "rev-parse", "HEAD"), fresh);
  assert.equal(git(repo, "status", "--porcelain"), "");
  assert.deepEqual({ ...result.status, fetchedAt: null }, { hasOrigin: true, defaultBranch: "main", defaultSource: "origin", branch: "main", ahead: 0, behind: 0, fetchedAt: null, fetchError: null });
  assert.equal((await pullLatest(repo, undefined)).outcome, "current");
});

const unsafe = {
  "uncommitted changes": { setup: async ({ repo }) => writeFile(join(repo, "base.txt"), "edited\n"), message: /1 uncommitted change .*nothing changed/ },
  "untracked files": { setup: async ({ repo }) => writeFile(join(repo, "new.txt"), "new\n"), message: /1 uncommitted change \(including untracked files\)/ },
  "another branch": { setup: async ({ repo, git }) => git(repo, "switch", "-q", "-c", "feature"), message: /on feature, not main, so nothing changed/ },
  "a detached HEAD": { setup: async ({ repo, git }) => git(repo, "switch", "-q", "--detach"), message: /isn't on a branch \(detached HEAD\)/ },
  "diverged history": { setup: async ({ repo, commit }) => commit(repo, "local.txt"), message: /1 commit that origin doesn't and is 1 commit behind, so it can't fast-forward/ },
  "a merge in progress": { setup: async ({ repo, git }) => git(repo, "update-ref", "MERGE_HEAD", git(repo, "rev-parse", "HEAD")), message: /a merge in progress, so nothing changed/ },
};
for (const [name, { setup, message }] of Object.entries(unsafe)) {
  test(`pull latest fetches but changes nothing with ${name}`, async t => {
    const context = await fixture(t);
    const { repo, git, advance, snapshot } = context;
    const fresh = await advance();
    await setup(context);
    const before = snapshot();
    const edited = await readFile(join(repo, "base.txt"), "utf8");
    const result = await pullLatest(repo, undefined);
    assert.equal(result.outcome, "unchanged");
    assert.match(result.message, message);
    assert.deepEqual(snapshot(), before);
    assert.equal(await readFile(join(repo, "base.txt"), "utf8"), edited);
    assert.equal(git(repo, "rev-parse", "refs/remotes/origin/main"), fresh, "origin was still fetched");
  });
}

test("pull latest never overwrites an ignored file that upstream starts tracking", async t => {
  const { repo, upstream, git, commit, snapshot } = await fixture(t);
  await writeFile(join(upstream, ".gitignore"), "local.cfg\n");
  git(upstream, "add", "."); git(upstream, "commit", "-q", "-m", "ignore"); git(upstream, "push", "-q", "origin", "main");
  assert.equal((await pullLatest(repo, undefined)).outcome, "updated");
  await writeFile(join(repo, "local.cfg"), "mine\n");
  await writeFile(join(upstream, "local.cfg"), "upstream\n");
  git(upstream, "add", "--force", "local.cfg"); await commit(upstream, "other.txt"); git(upstream, "push", "-q", "origin", "main");
  const before = snapshot();
  const result = await pullLatest(repo, undefined);
  assert.equal(result.outcome, "unchanged");
  assert.match(result.message, /refused to fast-forward main, so nothing changed/);
  assert.equal(await readFile(join(repo, "local.cfg"), "utf8"), "mine\n");
  assert.deepEqual(snapshot(), before);
});

test("a fast-forward that stops partway lists exactly the files to restore or delete, sparing ignored files", async t => {
  const { repo, upstream, git } = await fixture(t);
  const write = (text, ...files) => Promise.all(files.map(file => writeFile(join(upstream, file), text)));
  await write("1\n", "a.txt", "b.txt", "c.txt"); await write("*.local\n", ".gitignore");
  git(upstream, "add", "."); git(upstream, "commit", "-q", "-m", "files"); git(upstream, "push", "-q", "origin", "main");
  assert.equal((await pullLatest(repo, undefined)).outcome, "updated");
  // A folder that holds only the user's ignored file, until origin starts tracking a file in it.
  await mkdir(join(repo, "a-tools")); await writeFile(join(repo, "a-tools", "my.local"), "mine\n");
  await mkdir(join(upstream, "a-tools")); await write("2\n", "a-new.txt", join("a-tools", "build.sh"), "a.txt", "b.txt", "c.txt");
  git(upstream, "add", "."); git(upstream, "commit", "-q", "-m", "change"); git(upstream, "push", "-q", "origin", "main");
  // A smudge filter that fails on b.txt stands in for a file another program holds open. Git
  // writes a-new.txt, a-tools/build.sh and a.txt first.
  await writeFile(join(repo, ".git", "info", "attributes"), "b.txt filter=boom\n");
  git(repo, "config", "filter.boom.smudge", "false"); git(repo, "config", "filter.boom.clean", "cat"); git(repo, "config", "filter.boom.required", "true");
  const head = git(repo, "rev-parse", "HEAD");
  const result = await pullLatest(repo, undefined);
  assert.equal(result.outcome, "failed");
  assert.match(result.message, /stopped partway through fast-forwarding main.*still points at [0-9a-f]{7}, but Git already wrote some files/s);
  assert.match(result.message, /Changed: a\.txt, b\.txt\. New files from origin: a-new\.txt, a-tools\/build\.sh\./);
  assert.doesNotMatch(result.message, /a-tools\/[ ,.]|nothing changed/);
  assert.match(result.message, /none of your work.*git restore --staged --worktree.*delete exactly those new files \(not their folders.*then pull again/s);
  assert.equal(git(repo, "rev-parse", "HEAD"), head);
  // Following the advice recovers without touching the ignored file.
  await rm(join(repo, ".git", "info", "attributes"));
  git(repo, "restore", "--staged", "--worktree", "--", "a.txt", "b.txt");
  await rm(join(repo, "a-new.txt")); await rm(join(repo, "a-tools", "build.sh"));
  assert.equal((await pullLatest(repo, undefined)).outcome, "updated");
  assert.equal(await readFile(join(repo, "a-tools", "my.local"), "utf8"), "mine\n");
});

// Makes checking out `path` fail, standing in for a file another program holds open.
function failCheckout(repo, git, path) {
  return writeFile(join(repo, ".git", "info", "attributes"), `${path} filter=boom\n`).then(() => {
    git(repo, "config", "filter.boom.smudge", "false"); git(repo, "config", "filter.boom.clean", "cat"); git(repo, "config", "filter.boom.required", "true");
  });
}

test("a partial fast-forward that wrote only ignored files is reported as a failure, not 'nothing changed'", async t => {
  const { repo, upstream, git } = await fixture(t);
  // The user's own exclude rule hides .vscode/ from git status.
  await writeFile(join(repo, ".git", "info", "exclude"), ".vscode/\n");
  await mkdir(join(upstream, ".vscode"));
  await writeFile(join(upstream, ".vscode", "a.json"), "{}\n"); await writeFile(join(upstream, ".vscode", "b.json"), "{}\n");
  git(upstream, "add", "."); git(upstream, "commit", "-q", "-m", "editor settings"); git(upstream, "push", "-q", "origin", "main");
  await failCheckout(repo, git, ".vscode/b.json");
  const head = git(repo, "rev-parse", "HEAD");
  const result = await pullLatest(repo, undefined);
  assert.equal(git(repo, "status", "--porcelain"), "", "status can't see what Git wrote");
  assert.equal(result.outcome, "failed");
  assert.match(result.message, /Git already wrote some files\..*New files from origin: \.vscode\/a\.json/s);
  assert.doesNotMatch(result.message, /nothing changed|Changed:/);
  assert.equal(git(repo, "rev-parse", "HEAD"), head);
  // Following the advice lets the next pull succeed.
  await rm(join(repo, ".git", "info", "attributes"));
  for (const file of ["a.json", "b.json"]) await rm(join(repo, ".vscode", file), { force: true });
  assert.equal((await pullLatest(repo, undefined)).outcome, "updated");
});

test("in a sparse checkout, an existing ignored file at a path origin adds is never listed to delete", async t => {
  const { repo, upstream, git } = await fixture(t);
  await writeFile(join(upstream, ".gitignore"), "*.local\n"); await writeFile(join(upstream, "b.txt"), "1\n");
  git(upstream, "add", "."); git(upstream, "commit", "-q", "-m", "files"); git(upstream, "push", "-q", "origin", "main");
  assert.equal((await pullLatest(repo, undefined)).outcome, "updated");
  // Only top-level files are checked out; docs/ is outside the sparse set and holds the user's ignored notes.
  git(repo, "sparse-checkout", "init", "--cone");
  await mkdir(join(repo, "docs")); await writeFile(join(repo, "docs", "notes.local"), "mine\n");
  await mkdir(join(upstream, "docs")); await writeFile(join(upstream, "docs", "notes.local"), "upstream\n");
  await writeFile(join(upstream, "a-new.txt"), "new\n"); await writeFile(join(upstream, "b.txt"), "2\n");
  git(upstream, "add", "--force", "."); git(upstream, "commit", "-q", "-m", "notes"); git(upstream, "push", "-q", "origin", "main");
  await failCheckout(repo, git, "b.txt");
  const result = await pullLatest(repo, undefined);
  assert.equal(result.outcome, "failed");
  assert.match(result.message, /New files from origin: a-new\.txt\./);
  assert.doesNotMatch(result.message, /notes\.local/);
  assert.equal(await readFile(join(repo, "docs", "notes.local"), "utf8"), "mine\n");
  // Following the advice keeps the user's file.
  await rm(join(repo, ".git", "info", "attributes"));
  git(repo, "restore", "--staged", "--worktree", "--", "b.txt"); await rm(join(repo, "a-new.txt"));
  assert.equal((await pullLatest(repo, undefined)).outcome, "updated");
  assert.equal(await readFile(join(repo, "docs", "notes.local"), "utf8"), "mine\n");
});

test("origin's current default branch wins over a stale local origin/HEAD after fetching", async t => {
  const { origin, repo, git, advance } = await fixture(t);
  const trunk = await advance("trunk.txt", "main");
  execFileSync("git", ["-C", origin, "branch", "trunk", trunk]);
  execFileSync("git", ["-C", origin, "symbolic-ref", "HEAD", "refs/heads/trunk"]);
  assert.equal(git(repo, "symbolic-ref", "--short", "refs/remotes/origin/HEAD"), "origin/main", "the clone's record is now stale");
  assert.equal((await projectGitStatus(repo, undefined, true)).defaultBranch, "trunk");
  assert.deepEqual(await taskStartingPoint(repo, undefined), { baseBranch: "origin/trunk", ref: "refs/remotes/origin/trunk" });
  // Local-only reads keep origin's last answer rather than the stale symref.
  assert.equal((await projectGitStatus(repo, undefined, false)).defaultBranch, "trunk");
});

test("pull latest reports local-only commits as up to date and leaves them", async t => {
  const { repo, commit, snapshot } = await fixture(t);
  await commit(repo, "local.txt");
  const before = snapshot();
  const result = await pullLatest(repo, undefined);
  assert.equal(result.outcome, "current");
  assert.match(result.message, /Already up to date with origin\/main\. main also has 1 commit that origin doesn't/);
  assert.deepEqual(snapshot(), before);
});

test("pull latest without origin, or when fetching fails, changes nothing", async t => {
  const { base, repo, git, snapshot } = await fixture(t);
  git(repo, "remote", "set-url", "origin", join(base, "missing.git"));
  const before = snapshot();
  const failed = await pullLatest(repo, undefined);
  assert.equal(failed.outcome, "failed");
  assert.match(failed.message, /Couldn't fetch origin.*Nothing changed/s);
  assert.ok(failed.status.fetchError);
  git(repo, "remote", "remove", "origin");
  const none = await pullLatest(repo, undefined);
  assert.equal(none.outcome, "unchanged");
  assert.match(none.message, /no origin remote/);
  assert.equal(none.status.hasOrigin, false);
  assert.deepEqual(snapshot(), before);
});

test("pull latest follows a configured default branch and explains a missing one", async t => {
  const { repo, git, advance } = await fixture(t);
  git(repo, "switch", "-q", "-c", "release");
  git(repo, "push", "-q", "origin", "release");
  const fresh = await advance("release.txt", "release");
  // origin's own default is main, so without the setting the checkout is on "another branch".
  assert.match((await pullLatest(repo, undefined)).message, /on release, not main/);
  const result = await pullLatest(repo, "release");
  assert.equal(result.outcome, "updated");
  assert.equal(git(repo, "rev-parse", "HEAD"), fresh);
  assert.equal(result.status.defaultSource, "setting");
  const missing = await pullLatest(repo, "nope");
  assert.equal(missing.outcome, "unchanged");
  assert.match(missing.message, /it has no branch "nope"/);
});

test("status counts how far behind only after fetching, and finds origin's HEAD without a local origin/HEAD", async t => {
  const { repo, git, advance } = await fixture(t);
  git(repo, "remote", "set-head", "origin", "--delete");
  await advance("one.txt"); await advance("two.txt");
  const local = await projectGitStatus(repo, undefined, false);
  assert.equal(local.defaultBranch, null, "no network lookup without fetching");
  assert.equal(local.fetchedAt, null);
  const fetched = await projectGitStatus(repo, undefined, true);
  assert.equal(fetched.defaultBranch, "main");
  assert.equal(fetched.defaultSource, "origin");
  assert.equal(fetched.behind, 2);
  assert.equal(fetched.ahead, 0);
  assert.ok(fetched.fetchedAt);
  // The looked-up branch is remembered for later local-only reads.
  assert.equal((await projectGitStatus(repo, undefined, false)).defaultBranch, "main");
});

test("concurrent fetches and pulls on one repository are serialized", async t => {
  const { repo, git, advance } = await fixture(t);
  const fresh = await advance();
  const [status, pulled, again] = await Promise.all([projectGitStatus(repo, undefined, true), pullLatest(repo, undefined), pullLatest(repo, undefined)]);
  assert.equal(status.fetchError, null);
  assert.deepEqual([pulled.outcome, again.outcome].sort(), ["current", "updated"]);
  assert.equal(git(repo, "rev-parse", "HEAD"), fresh);
});

test("the RPCs resolve the project's root and apply its saved default branch", async t => {
  const { repo, git, advance } = await fixture(t);
  git(repo, "switch", "-q", "-c", "release"); git(repo, "push", "-q", "origin", "release");
  const fresh = await advance("release.txt", "release");
  const handlers = new Map();
  let values = { projects: { prj_git: { defaultBranch: "release", autoFetch: false } } };
  const server = {
    registerSettings: definition => { assert.equal(definition, projectGitSettings); return { read: async () => ({ status: "ready", revision: "1", values }) }; },
    handle: (contract, handler) => handlers.set(contract.name, handler),
  };
  const paseo = { projects: { list: async () => ({ projects: [
    { projectId: "prj_git", projectRootPath: repo, projectKind: "git" },
    { projectId: "prj_dir", projectRootPath: repo, projectKind: "directory" },
  ] }) } };
  const projectGit = registerProjectGit(server);
  assert.equal(await projectGit.defaultBranchFor("prj_git"), "release");
  assert.equal(await projectGit.defaultBranchFor("prj_other"), undefined);
  const status = await handlers.get(getProjectGitStatus.name)({ projectId: "prj_git", fetch: true }, { paseo });
  assert.equal(status.defaultBranch, "release");
  assert.equal(status.behind, 1);
  const pulled = await handlers.get(pullProjectLatest.name)({ projectId: "prj_git" }, { paseo });
  assert.equal(pulled.outcome, "updated");
  assert.equal(git(repo, "rev-parse", "HEAD"), fresh);
  await assert.rejects(handlers.get(pullProjectLatest.name)({ projectId: "prj_dir" }, { paseo }), /isn't a Git repository/);
  await assert.rejects(handlers.get(pullProjectLatest.name)({ projectId: "prj_gone" }, { paseo }), /isn't on this host/);
  values = { projects: {} };
  assert.equal(await projectGit.defaultBranchFor("prj_git"), undefined);
});

test("checking a very large list of new files runs bounded parallel lookups and finishes", async () => {
  const paths = Array.from({ length: 150_000 }, (_, index) => `folder/file-${index}.txt`);
  let active = 0;
  let peak = 0;
  const isFile = async path => {
    active++; peak = Math.max(peak, active);
    await new Promise(resolve => setImmediate(resolve));
    active--;
    return /file-\d*[02468]\.txt$/.test(path);
  };
  const { existing, unchecked } = await existingFiles("C:\\repo", paths, { isFile, budgetMs: 60_000 });
  assert.equal(peak, 32, "lookups run 32 at a time");
  assert.equal(unchecked.size, 0);
  assert.equal(existing.size, 75_000);
  assert.ok(existing.has("folder/file-0.txt") && !existing.has("folder/file-1.txt"));
});

test("lookups that outlast their budget come back unchecked instead of blocking", async () => {
  const paths = Array.from({ length: 100 }, (_, index) => `file-${index}`);
  // Some lookups never answer, like a file on an unreachable network drive.
  const isFile = path => /file-[0-4]$/.test(path) ? new Promise(() => {}) : Promise.resolve(true);
  const started = Date.now();
  const { existing, unchecked } = await existingFiles("C:\\repo", paths, { isFile, concurrency: 4, budgetMs: 50 });
  assert.ok(Date.now() - started < 2_000);
  assert.ok(unchecked.has("file-0"));
  for (const path of existing) assert.ok(!unchecked.has(path));
});

test("a pull whose new-file list is too large to read, or whose lookups run out of time, still fast-forwards", async t => {
  const { repo, upstream, git, advance } = await fixture(t);
  for (let index = 0; index < 50; index++) await writeFile(join(upstream, `new-${index}.txt`), `${index}\n`);
  git(upstream, "add", "."); git(upstream, "commit", "-q", "-m", "many files"); git(upstream, "push", "-q", "origin", "main");
  const unreadable = await pullLatest(repo, undefined, { maxListBytes: 16 });
  assert.equal(unreadable.outcome, "updated");
  assert.equal((await readFile(join(repo, "new-49.txt"), "utf8")).trim(), "49");
  await advance("later.txt");
  const slow = await pullLatest(repo, undefined, { lookup: { budgetMs: 0, isFile: () => new Promise(() => {}) } });
  assert.equal(slow.outcome, "updated");
  assert.equal(git(repo, "rev-parse", "HEAD"), git(repo, "rev-parse", "refs/remotes/origin/main"));
});

test("when the new files can't be listed, a partial fast-forward never claims nothing changed or lists files to delete", async t => {
  const { repo, upstream, git } = await fixture(t);
  await writeFile(join(repo, ".git", "info", "exclude"), ".vscode/\n");
  await mkdir(join(upstream, ".vscode"));
  await writeFile(join(upstream, ".vscode", "a.json"), "{}\n"); await writeFile(join(upstream, ".vscode", "b.json"), "{}\n");
  git(upstream, "add", "."); git(upstream, "commit", "-q", "-m", "editor settings"); git(upstream, "push", "-q", "origin", "main");
  await failCheckout(repo, git, ".vscode/b.json");
  const result = await pullLatest(repo, undefined, { maxListBytes: 16 });
  assert.equal(result.outcome, "failed");
  assert.match(result.message, /couldn't list origin's new files/);
  assert.doesNotMatch(result.message, /nothing changed|New files from origin/);
});
