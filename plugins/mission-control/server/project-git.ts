import { lstat, realpath, stat } from "node:fs/promises";
import { resolve } from "node:path";
import type { PaseoApi } from "@getpaseo/client";
import type { PluginServerContext } from "@getpaseo/plugin/server";
import { getProjectGitStatus, projectGitSettings, pullProjectLatest, type ProjectGitStatus } from "../shared/project-git";
import { ProcessStopped, runProcess } from "./process-tree";
import { runGit } from "./review";

const networkTimeout = 90_000;
// Fetches and fast-forwards are serialized per repository across module reloads.
const stateKey = Symbol.for("mission-control.project-git");
const runtime = globalThis as typeof globalThis & { [stateKey]?: { tails: Map<string, Promise<void>>; fetchedAt: Map<string, number>; originHeads: Map<string, string> } };
const state = runtime[stateKey] ??= { tails: new Map(), fetchedAt: new Map(), originHeads: new Map() };

/** Fetch and ls-remote can wait on the network or a credential helper, so they get a time limit. */
async function networkGit(cwd: string, args: string[]): Promise<string> {
  let result;
  try {
    result = await runProcess("git", ["-c", `safe.directory=${cwd}`, "-c", `safe.directory=${cwd.replaceAll("\\", "/")}`, "-C", cwd, ...args], {
      env: { ...process.env, GIT_TERMINAL_PROMPT: "0" }, timeoutMs: networkTimeout, maxBuffer: 1_000_000,
    });
  } catch (error) {
    // A stopped fetch ends with every process it started (the git.exe launcher's child, credential helpers).
    throw new Error(error instanceof ProcessStopped ? `timed out after ${networkTimeout / 1000} s` : error instanceof Error ? error.message : String(error));
  }
  if (result.code !== 0) throw new Error(result.stderr.trim() || `git ${args[0]} failed`);
  return result.stdout;
}

async function repositoryKey(cwd: string) {
  const common = await realpath(resolve(cwd, (await runGit(cwd, ["rev-parse", "--git-common-dir"])).trim()));
  return process.platform === "win32" ? common.toLowerCase() : common;
}

/** Runs `work` after earlier Git work on the same repository (any of its worktrees) has settled. */
export async function withRepository<T>(cwd: string, work: () => Promise<T>): Promise<T> {
  const key = await repositoryKey(cwd);
  const next = (state.tails.get(key) ?? Promise.resolve()).then(work);
  const tail = next.then(() => {}, () => {});
  state.tails.set(key, tail);
  try { return await next; } finally { if (state.tails.get(key) === tail) state.tails.delete(key); }
}

export async function hasOrigin(cwd: string) {
  return (await runGit(cwd, ["remote"])).split(/\r?\n/).some(name => name.trim() === "origin");
}

/** `git fetch origin`, skipped when this repository was fetched within `maxAgeMs`. Call inside withRepository. */
export async function fetchOrigin(cwd: string, maxAgeMs = 0) {
  const key = await repositoryKey(cwd);
  if (maxAgeMs > 0 && Date.now() - (state.fetchedAt.get(key) ?? 0) < maxAgeMs) return;
  try { await networkGit(cwd, ["fetch", "--quiet", "origin"]); }
  catch (error) { throw new Error(`Couldn't fetch origin: ${error instanceof Error ? error.message : String(error)}`); }
  state.fetchedAt.set(key, Date.now());
}

async function lastFetch(cwd: string) {
  const at = state.fetchedAt.get(await repositoryKey(cwd));
  return at ? new Date(at).toISOString() : null;
}

/**
 * Origin's HEAD branch. When `network`, ask origin, because a plain fetch never updates the local
 * origin/HEAD symref. Otherwise use origin's last answer, then that local symref.
 */
export async function originHeadBranch(cwd: string, network: boolean): Promise<string | null> {
  const key = await repositoryKey(cwd);
  if (network) {
    const match = /^ref: refs\/heads\/(\S+)\tHEAD$/m.exec(await networkGit(cwd, ["ls-remote", "--symref", "origin", "HEAD"]).catch(() => ""));
    if (match) state.originHeads.set(key, match[1]);
  }
  const remembered = state.originHeads.get(key);
  if (remembered) return remembered;
  const local = (await runGit(cwd, ["symbolic-ref", "--quiet", "--short", "refs/remotes/origin/HEAD"], [0, 1, 128])).trim();
  return local.startsWith("origin/") ? local.slice("origin/".length) : null;
}

export async function resolveDefaultBranch(cwd: string, configured: string | undefined, network: boolean): Promise<{ branch: string; source: "setting" | "origin" } | null> {
  if (configured) {
    const checked = (await runGit(cwd, ["check-ref-format", "--branch", configured], [0, 1, 128])).trim();
    if (checked !== configured) throw new Error(`"${configured}" is not a valid branch name. Change this project's default branch in Mission Control.`);
    return { branch: configured, source: "setting" };
  }
  const branch = await originHeadBranch(cwd, network);
  return branch ? { branch, source: "origin" } : null;
}

async function refExists(cwd: string, ref: string) {
  return (await runGit(cwd, ["rev-parse", "--quiet", "--verify", `${ref}^{commit}`], [0, 1, 128])).trim() !== "";
}

/**
 * Where a new task branch starts. With an origin remote: fetch it, then the remote default branch
 * (`origin/<branch>`). Without one: the source checkout's current branch, as before.
 */
export async function taskStartingPoint(cwd: string, configured: string | undefined): Promise<{ baseBranch: string | null; ref: string }> {
  if (!(await hasOrigin(cwd))) {
    const head = (await runGit(cwd, ["rev-parse", "--verify", "--quiet", "HEAD"], [0, 1])).trim();
    const current = (await runGit(cwd, ["symbolic-ref", "--quiet", "--short", "HEAD"], [0, 1])).trim() || null;
    return { baseBranch: current, ref: head };
  }
  await withRepository(cwd, () => fetchOrigin(cwd)).catch(error => {
    throw new Error(`${error instanceof Error ? error.message : String(error)}. The task's worktree was not created; check the connection, or start the task in this workspace instead.`);
  });
  const target = await resolveDefaultBranch(cwd, configured, true);
  if (!target) throw new Error("Origin's default branch is unknown. Set a default branch for this project on Mission Control's Workspaces tab.");
  const ref = `refs/remotes/origin/${target.branch}`;
  if (!(await refExists(cwd, ref))) throw new Error(`Origin has no branch "${target.branch}". Change this project's default branch on Mission Control's Workspaces tab.`);
  return { baseBranch: `origin/${target.branch}`, ref };
}

export async function operationInProgress(cwd: string) {
  const heads: [string, string][] = [["MERGE_HEAD", "a merge"], ["CHERRY_PICK_HEAD", "a cherry-pick"], ["REVERT_HEAD", "a revert"], ["REBASE_HEAD", "a rebase"]];
  for (const [ref, label] of heads) if (await refExists(cwd, ref)) return label;
  for (const folder of ["rebase-merge", "rebase-apply"]) {
    const path = resolve(cwd, (await runGit(cwd, ["rev-parse", "--git-path", folder])).trim());
    if (await stat(path).then(() => true, () => false)) return "a rebase";
  }
  return null;
}

async function inspect(cwd: string, configured: string | undefined, network: boolean, fetchError: string | null = null): Promise<ProjectGitStatus> {
  const empty: ProjectGitStatus = { hasOrigin: false, defaultBranch: null, defaultSource: null, branch: null, ahead: null, behind: null, fetchedAt: null, fetchError };
  if (!(await hasOrigin(cwd))) return empty;
  const target = await resolveDefaultBranch(cwd, configured, network);
  const branch = (await runGit(cwd, ["symbolic-ref", "--quiet", "--short", "HEAD"], [0, 1, 128])).trim() || null;
  let ahead: number | null = null;
  let behind: number | null = null;
  if (target && await refExists(cwd, "HEAD") && await refExists(cwd, `refs/remotes/origin/${target.branch}`)) {
    const [left, right] = (await runGit(cwd, ["rev-list", "--left-right", "--count", `HEAD...refs/remotes/origin/${target.branch}`])).trim().split(/\s+/).map(Number);
    ahead = left; behind = right;
  }
  return { ...empty, hasOrigin: true, defaultBranch: target?.branch ?? null, defaultSource: target?.source ?? null, branch, ahead, behind, fetchedAt: await lastFetch(cwd) };
}

/** The main checkout's position against origin, optionally fetching first (at most once a minute). */
export async function projectGitStatus(cwd: string, configured: string | undefined, fetch: boolean): Promise<ProjectGitStatus> {
  let fetchError: string | null = null;
  if (fetch && await hasOrigin(cwd)) {
    try { await withRepository(cwd, () => fetchOrigin(cwd, 60_000)); }
    catch (error) { fetchError = error instanceof Error ? error.message : String(error); }
  }
  return inspect(cwd, configured, fetch && !fetchError, fetchError);
}

const commits = (count: number) => `${count} commit${count === 1 ? "" : "s"}`;

/**
 * The files `to` adds since `from`, or null when Git can't list them in time. The list only guides
 * recovery advice, so it has its own limits and never stops a pull.
 */
function addedFiles(cwd: string, from: string, to: string, maxBytes: number): Promise<string[] | null> {
  return runProcess("git", ["-c", `safe.directory=${cwd}`, "-c", `safe.directory=${cwd.replaceAll("\\", "/")}`, "-C", cwd, "diff", "--name-only", "--no-renames", "--diff-filter=A", "-z", from, to, "--"], {
    env: { ...process.env, GIT_OPTIONAL_LOCKS: "0", GIT_TERMINAL_PROMPT: "0" }, timeoutMs: 10_000, maxBuffer: maxBytes,
  }).then(result => result.code === 0 ? result.stdout.split("\0").filter(Boolean) : null, () => null);
}

export type FileLookup = { concurrency?: number; budgetMs?: number; isFile?: (path: string) => Promise<boolean> };
const isFileAt = (path: string) => lstat(path).then(entry => !entry.isDirectory(), () => false);

/**
 * Which of `paths` (relative to `cwd`) exist as files, `concurrency` lookups at a time. Best-effort:
 * lookups still running or not started when `budgetMs` runs out come back as unchecked.
 */
export async function existingFiles(cwd: string, paths: readonly string[], { concurrency = 32, budgetMs = 10_000, isFile = isFileAt }: FileLookup = {}) {
  const existing = new Set<string>();
  const checked = new Set<string>();
  let next = 0;
  let stopped = false;
  async function worker() {
    while (!stopped && next < paths.length) {
      const path = paths[next++];
      const found = await isFile(resolve(cwd, path));
      if (stopped) return;
      if (found) existing.add(path);
      checked.add(path);
    }
  }
  let timer: ReturnType<typeof setTimeout> | undefined;
  const outOfTime = new Promise<void>(done => { timer = setTimeout(done, budgetMs); });
  try { await Promise.race([Promise.all(Array.from({ length: Math.min(concurrency, paths.length) }, worker)), outOfTime]); }
  finally { stopped = true; clearTimeout(timer); }
  return { existing, unchecked: new Set(paths.filter(path => !checked.has(path))) };
}

/**
 * Fetches origin, then fast-forwards the checkout only when it is on the default branch, clean, and
 * strictly behind. Every other state is reported unchanged. Never merges, rebases, stashes or discards.
 */
export async function pullLatest(cwd: string, configured: string | undefined, options: { maxListBytes?: number; lookup?: FileLookup } = {}) {
  return withRepository(cwd, async () => {
    const result = async (outcome: "updated" | "current" | "unchanged" | "failed", message: string, fetchError: string | null = null) =>
      ({ outcome, message, status: await inspect(cwd, configured, false, fetchError) });
    if (!(await hasOrigin(cwd))) return result("unchanged", "This project has no origin remote, so there is nothing to pull.");
    try { await fetchOrigin(cwd); }
    catch (error) { const reason = error instanceof Error ? error.message : String(error); return result("failed", `${reason}. Nothing changed.`, reason); }
    const target = await resolveDefaultBranch(cwd, configured, true);
    if (!target) return result("unchanged", "Fetched origin, but its default branch is unknown. Set a default branch for this project.");
    const remote = `origin/${target.branch}`;
    if (!(await refExists(cwd, `refs/remotes/${remote}`))) return result("unchanged", `Fetched origin, but it has no branch "${target.branch}". Change this project's default branch.`);
    const branch = (await runGit(cwd, ["symbolic-ref", "--quiet", "--short", "HEAD"], [0, 1, 128])).trim();
    if (!branch) return result("unchanged", `Fetched origin. The main checkout isn't on a branch (detached HEAD), so nothing changed. Switch to ${target.branch} to pull.`);
    if (branch !== target.branch) return result("unchanged", `Fetched origin. The main checkout is on ${branch}, not ${target.branch}, so nothing changed. Switch to ${target.branch} to pull.`);
    if (!(await refExists(cwd, "HEAD"))) return result("unchanged", `Fetched origin. ${branch} has no commits yet, so nothing changed.`);
    const operation = await operationInProgress(cwd);
    if (operation) return result("unchanged", `Fetched origin. The main checkout has ${operation} in progress, so nothing changed.`);
    const changes = (await runGit(cwd, ["status", "--porcelain", "--untracked-files=normal"])).split(/\r?\n/).filter(Boolean).length;
    if (changes) return result("unchanged", `Fetched origin. The main checkout has ${changes} uncommitted change${changes === 1 ? "" : "s"} (including untracked files), so nothing changed. Commit or move them, then pull again.`);
    const [ahead, behind] = (await runGit(cwd, ["rev-list", "--left-right", "--count", `HEAD...refs/remotes/${remote}`])).trim().split(/\s+/).map(Number);
    if (behind === 0) return result("current", ahead ? `Already up to date with ${remote}. ${branch} also has ${commits(ahead)} that origin doesn't.` : `Already up to date with ${remote}.`);
    if (ahead > 0) return result("unchanged", `Fetched origin. ${branch} has ${commits(ahead)} that origin doesn't and is ${commits(behind)} behind, so it can't fast-forward. Nothing changed; Mission Control never merges or rebases.`);
    // `git status` never lists ignored files, so Git must refuse to overwrite them rather than replace them.
    const before = (await runGit(cwd, ["rev-parse", "HEAD"])).trim();
    // Files origin adds, and which of those paths already exist. Neither `git status` nor a sparse
    // checkout covers every path, so only a path that appears during the merge counts as written by Git.
    // Best-effort: a list too large or slow to read leaves the new files unknown, and the fast-forward still runs.
    const incoming = await addedFiles(cwd, before, `refs/remotes/${remote}`, options.maxListBytes ?? 64 * 1024 * 1024);
    const { existing, unchecked } = incoming ? await existingFiles(cwd, incoming, options.lookup) : { existing: new Set<string>(), unchecked: new Set<string>() };
    try { await runGit(cwd, ["merge", "--ff-only", "--no-overwrite-ignore", "--no-autostash", "--quiet", `refs/remotes/${remote}`]); }
    catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      // Git can stop partway, for example at a file another program holds open, after writing other files.
      const after = (await runGit(cwd, ["rev-parse", "HEAD"])).trim();
      const lines = (await runGit(cwd, ["status", "--porcelain", "--untracked-files=normal"])).split(/\r?\n/).filter(Boolean);
      const changed = lines.filter(line => !line.startsWith("??")).map(line => line.slice(3));
      // New files are exactly the ones Git wrote for origin. Status would collapse a new folder to `dir/`,
      // hide ignored files, and that folder can hold the user's own ignored files. A path not checked
      // before the merge might be the user's, so it is never listed.
      const changedSet = new Set(changed);
      const candidates = (incoming ?? []).filter(path => !existing.has(path) && !unchecked.has(path) && !changedSet.has(path));
      const written = await existingFiles(cwd, candidates, options.lookup);
      const added = candidates.filter(path => written.existing.has(path));
      const unlisted = unchecked.size + written.unchecked.size;
      const unknown = incoming === null || unlisted > 0;
      const wrote = after !== before || lines.length > 0 || added.length > 0;
      if (!wrote && !unknown) return result("unchanged", `Fetched origin, but Git refused to fast-forward ${branch}, so nothing changed: ${reason}`);
      const list = (paths: string[]) => paths.length > 10 ? `${paths.slice(0, 10).join(", ")} and ${paths.length - 10} more` : paths.join(", ");
      const where = after === before ? `${branch} still points at ${before.slice(0, 7)}` : `${branch} moved from ${before.slice(0, 7)} to ${after.slice(0, 7)}`;
      return result("failed", [
        `Git stopped partway through fast-forwarding ${branch}: ${reason}. ${where}, ${wrote ? "but Git already wrote some files." : "and Git may have written some of origin's new files."}`,
        changed.length ? `Changed: ${list(changed)}.` : "", added.length ? `New files from origin: ${list(added)}.` : "",
        incoming === null ? "Mission Control couldn't list origin's new files, so any that Git wrote aren't listed."
          : unlisted ? `${unlisted} of origin's new files couldn't be checked in time, so they aren't listed.` : "",
        "It was clean before, so none of your work is in these files. To recover, close any program using them,",
        changed.length ? `run "git restore --staged --worktree -- <changed files>" in the main checkout,` : "",
        added.length ? "delete exactly those new files (not their folders, which may hold your ignored files)," : "", "then pull again.",
      ].filter(Boolean).join(" "));
    }
    return result("updated", `Fast-forwarded ${branch} by ${commits(behind)} to ${remote}.`);
  });
}

export async function projectRoot(paseo: PaseoApi, projectId: string) {
  const project = (await paseo.projects.list()).projects.find(entry => entry.projectId === projectId);
  if (!project) throw new Error("This project isn't on this host.");
  if (project.projectKind !== "git") throw new Error("This project isn't a Git repository.");
  return realpath(project.projectRootPath);
}

/** Registers the per-project Git settings and RPCs; `defaultBranchFor` feeds new task worktrees. */
export function registerProjectGit(server: PluginServerContext) {
  const settings = server.registerSettings(projectGitSettings);
  async function configuredBranch(projectId: string) {
    const current = await settings.read();
    if (current.status !== "ready") throw new Error(`Mission Control's project Git settings are invalid: ${current.error}`);
    return current.values.projects[projectId]?.defaultBranch;
  }
  server.handle(getProjectGitStatus, async ({ projectId, fetch }, { paseo }) => projectGitStatus(await projectRoot(paseo, projectId), await configuredBranch(projectId), fetch));
  server.handle(pullProjectLatest, async ({ projectId }, { paseo }) => pullLatest(await projectRoot(paseo, projectId), await configuredBranch(projectId)));
  return { defaultBranchFor: configuredBranch };
}
