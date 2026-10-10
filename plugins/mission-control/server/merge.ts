import { createHash } from "node:crypto";
import { copyFile, lstat, mkdtemp, realpath, rename, rm, stat, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { PaseoApi } from "@getpaseo/client";
import type { DecisionEntry } from "../shared/decisions";
import type { MergeCheck, MergePlan, MergeReadyTask, MergeReply, MergeResult, MergeStatus, MergeStep } from "../shared/merge";
import type { RunRecord } from "../shared/runs";
import { createDeliveryResults, type DeliveryResults } from "./delivery-results";
import { ProcessStopped, runProcess } from "./process-tree";
import { operationInProgress, withRepository } from "./project-git";
import { runRecordsOf } from "./runs";
import type { TaskSource } from "./tasks";
import { parseWorktreeList } from "./worktree";

type Git = { code: number; stdout: string; stderr: string };
type GitOptions = { acceptable?: number[]; trim?: boolean; env?: Record<string, string>; timeout?: number; input?: string };

/**
 * Git ran past its time limit and was stopped. `confirmed`: Git and every process it started are known to have
 * ended. When false, Git may still be working, so nothing it left (locks, a half-done merge) may be undone.
 */
export class GitStopped extends Error {
  constructor(message: string, readonly confirmed: boolean) { super(message); }
}

const readTimeout = 60_000;

/**
 * Git with its exit code and error text; writes (commit, merge) need both. Optional locks are off, so
 * Attention's background checks never take index.lock from a commit or merge running beside them.
 */
export async function git(cwd: string, args: string[], options: GitOptions = {}): Promise<Git> {
  const timeout = options.timeout ?? readTimeout;
  try {
    // At the time limit the whole process tree ends (Git's cmd\git.exe launcher, the real git, hooks and
    // merge drivers) before this returns, so the repository checks that follow see Git's final state.
    const result = await runProcess("git", ["-c", `safe.directory=${cwd}`, "-c", `safe.directory=${cwd.replaceAll("\\", "/")}`, "-c", "core.quotePath=false", "-C", cwd, ...args], {
      env: { ...process.env, GIT_TERMINAL_PROMPT: "0", GIT_EDITOR: "true", GIT_MERGE_AUTOEDIT: "no", GIT_OPTIONAL_LOCKS: "0", ...options.env },
      timeoutMs: timeout, input: options.input,
    });
    return { ...result, stderr: result.stderr.trim() };
  } catch (error) {
    if (error instanceof ProcessStopped) {
      throw new GitStopped(`git ${args[0]} took longer than ${Math.round(timeout / 1000)} s and was stopped${error.confirmed ? "" : ", but Mission Control couldn't confirm that Git and the processes it started have ended"}`, error.confirmed);
    }
    throw error;
  }
}

async function gitOut(cwd: string, args: string[], options: GitOptions = {}) {
  const result = await git(cwd, args, options);
  if (!(options.acceptable ?? [0]).includes(result.code)) throw new Error(result.stderr || `git ${args[0]} failed`);
  return options.trim === false ? result.stdout : result.stdout.trim();
}

// Porcelain status keeps its leading spaces (" M file"), so it is never trimmed.
const statusOf = (cwd: string, untracked: "no" | "normal" | "all") => gitOut(cwd, ["status", "--porcelain", "-z", `--untracked-files=${untracked}`], { trim: false });
const nulList = (text: string) => text.split("\0").filter(Boolean);

const samePath = (a: string, b: string) => (process.platform === "win32" ? a.toLowerCase() === b.toLowerCase() : a === b);
const short = (commit: string) => commit.slice(0, 7);
const plural = (count: number, word: string) => `${count} ${word}${count === 1 ? "" : "s"}`;
const listed = (paths: readonly string[], max = 20) => paths.length > max ? `${paths.slice(0, max).join(", ")} and ${paths.length - max} more` : paths.join(", ");
const failure = (error: unknown) => error instanceof Error ? error.message : String(error);

/** Paths from `git status --porcelain -z`; a rename's second entry is its old path and is skipped. */
function changedPaths(porcelain: string) {
  const entries = porcelain.split("\0");
  const paths: string[] = [];
  for (let index = 0; index < entries.length; index++) {
    const entry = entries[index];
    if (entry.length < 4) continue;
    paths.push(entry.slice(3));
    if (entry[0] === "R" || entry[0] === "C") index++;
  }
  return paths;
}

/**
 * The reviewed candidate of a checkout: HEAD plus the tree of the whole working tree as `git add -A`
 * would stage it (untracked files included, ignored files not). It is built in a temporary copy of the
 * index, so the checkout's own index and refs are untouched. dev-flow request-decision records the same
 * pair on every review decision; keep both implementations in step.
 */
export async function reviewCandidate(cwd: string): Promise<{ head: string | null; tree: string }> {
  const head = await gitOut(cwd, ["rev-parse", "--verify", "--quiet", "HEAD"], { acceptable: [0, 1] }) || null;
  const folder = await mkdtemp(join(tmpdir(), "mission-candidate-"));
  try {
    const index = join(folder, "index");
    const env = { GIT_INDEX_FILE: index };
    try { await copyFile(resolve(cwd, await gitOut(cwd, ["rev-parse", "--git-path", "index"])), index); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      await gitOut(cwd, ["read-tree", head ? "HEAD" : "--empty"], { env });
    }
    await gitOut(cwd, ["add", "-A"], { env });
    return { head, tree: await gitOut(cwd, ["write-tree"], { env }) };
  } finally { await rm(folder, { recursive: true, force: true }); }
}

/**
 * Paths the merge would write that already exist in the main checkout without being tracked there,
 * such as ignored local files. `git status` can't see ignored files and `git merge` overwrites them, so
 * these must be moved first. Parent folders count when they exist as a file. When a written file
 * replaces a folder, every untracked or ignored file inside that folder counts, because the merge
 * removes the folder with them in it.
 */
export async function localFilesInTheWay(main: string, mergeBase: string, tree: string): Promise<string[]> {
  const written = nulList(await gitOut(main, ["diff", "--name-only", "-z", "--no-renames", "--no-ext-diff", "--diff-filter=d", mergeBase, tree]));
  const candidates = new Map<string, boolean>();
  for (const path of written) {
    candidates.set(path, true);
    const parts = path.split("/");
    for (let depth = 1; depth < parts.length; depth++) { const prefix = parts.slice(0, depth).join("/"); if (!candidates.has(prefix)) candidates.set(prefix, false); }
  }
  const entries = [...candidates];
  const existing: string[] = [];
  const replacedFolders: string[] = [];
  let next = 0;
  async function worker() {
    while (next < entries.length) {
      const [path, full] = entries[next++];
      const entry = await lstat(join(main, path)).catch(() => null);
      if (!entry) continue;
      // A written file where a folder is: what's inside the folder decides.
      if (full && entry.isDirectory()) replacedFolders.push(path);
      // A folder where a parent folder is needed is fine; anything else at a written path is in the way.
      else if (full || !entry.isDirectory()) existing.push(path);
    }
  }
  await Promise.all(Array.from({ length: Math.min(32, entries.length) }, worker));
  if (!existing.length && !replacedFolders.length) return [];
  // On a case-insensitive file system (core.ignorecase), a case-only rename finds the tracked file under
  // its old name, so tracked paths match regardless of case.
  const ignoreCase = (await gitOut(main, ["config", "--bool", "core.ignorecase"], { acceptable: [0, 1] })) === "true";
  const fold = (path: string) => ignoreCase ? path.toLowerCase() : path;
  // Git refuses the global literal and icase settings together, so each path carries its own magic.
  const listFiles = async (options: string[], paths: string[]) => {
    const found: string[] = [];
    for (let index = 0; index < paths.length; index += 100) {
      const batch = paths.slice(index, index + 100);
      const args = ignoreCase ? batch.map(path => `:(literal,icase)${path}`) : batch;
      found.push(...nulList(await gitOut(main, ["ls-files", "-z", ...options, "--", ...args], ignoreCase ? {} : { env: { GIT_LITERAL_PATHSPECS: "1" } })));
    }
    return found;
  };
  const tracked = new Set((await listFiles([], existing)).map(fold));
  const isTracked = (path: string) => tracked.has(fold(path)) || [...tracked].some(file => file.startsWith(`${fold(path)}/`));
  // --others without exclude options lists every untracked file, ignored ones included.
  const inFolders = replacedFolders.length ? await listFiles(["--others"], replacedFolders) : [];
  return [...new Set([...existing.filter(path => !isTracked(path)), ...inFolders])].sort();
}

/**
 * The branch a task branch was created from, from the oldest entry in its reflog: "Created from
 * refs/heads/master" is master, and "origin/main" is main. Null when Git no longer logs it or it
 * started from a bare commit or HEAD.
 */
export async function startingBranch(cwd: string, branch: string): Promise<string | null> {
  const entries = (await gitOut(cwd, ["reflog", "show", "--format=%gs", `refs/heads/${branch}`, "--"], { acceptable: [0, 128] })).split(/\r?\n/).filter(Boolean);
  const from = /^branch: Created from (\S+)$/.exec(entries[entries.length - 1] ?? "")?.[1];
  if (!from || from === "HEAD" || /^[0-9a-f]{7,40}$/.test(from)) return null;
  if (from.startsWith("refs/heads/")) return from.slice("refs/heads/".length);
  const remotes = (await gitOut(cwd, ["remote"])).split(/\r?\n/).map(name => name.trim()).filter(Boolean);
  const remote = from.startsWith("refs/remotes/") ? from.slice("refs/remotes/".length) : from;
  const owner = remotes.find(name => remote.startsWith(`${name}/`));
  if (owner && (from.startsWith("refs/remotes/") || !(await gitOut(cwd, ["rev-parse", "--verify", "--quiet", `refs/heads/${from}`], { acceptable: [0, 1] })))) {
    return remote.slice(owner.length + 1);
  }
  return from;
}

/** Removes index.lock when a Git process this merge stopped left it behind (it is no older than the step). */
async function releaseStaleLock(cwd: string, since: number) {
  const lock = resolve(cwd, await gitOut(cwd, ["rev-parse", "--git-path", "index.lock"]));
  const entry = await stat(lock).catch(() => null);
  if (entry && entry.mtimeMs >= since - 2_000) await unlink(lock).catch(() => {});
}

/** Git's temporary merge files (.merge_file_XXXXXX) that a merge this step stopped left in the checkout. */
async function removeMergeTempFiles(cwd: string, since: number) {
  for (const path of nulList(await gitOut(cwd, ["ls-files", "--others", "--exclude-standard", "-z"]))) {
    if (!/(^|\/)\.merge_file_[A-Za-z0-9]{6}$/.test(path)) continue;
    const entry = await stat(join(cwd, path)).catch(() => null);
    if (entry?.isFile() && entry.mtimeMs >= since - 2_000) await unlink(join(cwd, path)).catch(() => {});
  }
}

/**
 * Commits a worktree's uncommitted work (`git add -A`, then commit with `message`); on any failure or time-out
 * the index is restored byte for byte. The commit must hold exactly `tree`, the checked (and reviewed) files.
 * `nothingDone` ends each refusal, such as "Nothing was merged."
 */
export async function commitTaskWork(directory: string, options: { message: string; branch: string; tree: string; timeoutMs: number; nothingDone: string }): Promise<{ committed: string } | { refused: string }> {
  const { message, branch, tree, timeoutMs, nothingDone } = options;
  const before = await gitOut(directory, ["rev-parse", "HEAD"]);
  // The worktree's staging area, byte for byte, so a failed commit can put it back exactly.
  const index = resolve(directory, await gitOut(directory, ["rev-parse", "--git-path", "index"]));
  const saved = await mkdtemp(join(tmpdir(), "mission-index-"));
  const copy = join(saved, "index");
  const hadIndex = await copyFile(index, copy).then(() => true, error => { if ((error as NodeJS.ErrnoException).code === "ENOENT") return false; throw error; });
  try {
    const started = Date.now();
    let failed: string | null = null;
    try {
      const added = await git(directory, ["add", "-A"], { timeout: timeoutMs });
      const commit = added.code === 0 ? await git(directory, ["commit", "--quiet", "-m", message], { timeout: timeoutMs }) : added;
      if (commit.code !== 0) failed = `Couldn't commit the task's uncommitted work: ${commit.stderr || commit.stdout.trim() || "git commit failed"}.`;
    } catch (error) {
      if (!(error instanceof GitStopped)) throw error;
      // Git may still be running: its lock and the staging area are left exactly as they are.
      if (!error.confirmed) return { refused: `Committing the task's uncommitted work stopped: ${error.message}. The worktree's state is unknown, so nothing was undone: its index.lock and staging area are left as they are. Check ${directory} before trying again. ${nothingDone}` };
      await releaseStaleLock(directory, started);
      failed = `Committing the task's uncommitted work stopped: ${error.message}. Check the repository's commit hooks.`;
    }
    // Read again only now: a stopped Git and everything it started have ended, so this is the final state.
    const head = await gitOut(directory, ["rev-parse", "HEAD"]);
    if (failed) {
      if (head !== before) {
        // The commit was made before Git stopped, so the index already matches it.
        return { refused: `${failed} Git made the commit ${short(head)} before it stopped; it stays on ${branch}, and your files are unchanged. ${nothingDone}` };
      }
      // Put the staging area back exactly as it was (written beside it, then renamed over it).
      if (hadIndex) {
        const staged = `${index}.mission-${Date.now()}`;
        await copyFile(copy, staged);
        await rename(staged, index);
      } else await unlink(index).catch(() => {});
      return { refused: `${failed} The staging area was put back exactly as it was, and your files are unchanged. ${nothingDone}` };
    }
    // The commit must hold exactly the checked (and reviewed) files.
    if ((await gitOut(directory, ["rev-parse", `${head}^{tree}`])) !== tree) {
      return { refused: `The task's files changed while they were being committed, so the commit ${short(head)} on ${branch} doesn't match what was checked. ${nothingDone} Ask for a fresh review.` };
    }
    return { committed: head };
  } finally { await rm(saved, { recursive: true, force: true }); }
}

const parentsOf = async (cwd: string, commit: string) => (await gitOut(cwd, ["rev-list", "--parents", "-n", "1", commit])).split(" ").slice(1);

type AgentLookup = { found: false } | { found: true; idle: boolean; archived: boolean; detail: string };

async function lookupAgent(paseo: PaseoApi, agentId: string): Promise<AgentLookup> {
  let agent;
  try { agent = (await paseo.agents.ref(agentId).refresh())?.agent ?? null; }
  catch (error) {
    if (!(error instanceof Error && error.message === `Agent not found: ${agentId}`)) throw error;
    agent = null;
  }
  if (!agent) return { found: false };
  if (agent.archivedAt || agent.status === "closed") return { found: true, idle: true, archived: true, detail: "The task's agent is archived, so it can't be working. No note will be sent." };
  if (agent.pendingPermissions.length) return { found: true, idle: false, archived: false, detail: "The task's agent is waiting on a permission prompt." };
  if (agent.status !== "idle" || agent.activeTurn) return { found: true, idle: false, archived: false, detail: `The task's agent is ${agent.status === "idle" ? "in a turn" : agent.status}. Wait until it's idle.` };
  return { found: true, idle: true, archived: false, detail: "The task's agent is idle." };
}

type Decisions = { open: DecisionEntry[]; recent: DecisionEntry[] };
// commitMessage: the message the user confirmed for the uncommitted work; the plan's default when left out.
type MergeInput = { serverId: string; taskId: string; fingerprint: string; commitMessage?: string };

/** The newest review decision of a task's run, open or answered. */
const newestReview = (decisions: Decisions, taskId: string, runId: string) => [...decisions.open, ...decisions.recent]
  .filter(entry => entry.decision.taskId === taskId && entry.decision.runId === runId && entry.decision.kind === "review")
  .sort((a, b) => b.decision.requestedAt.localeCompare(a.decision.requestedAt))[0];

// Paseo's client gives up on a plugin RPC after about 30 s; reply before then and finish in the background.
export const replyWithinMs = 20_000;

type Deps = {
  // Where Attention's result cards are kept until dismissed; in memory only when not given.
  results?: DeliveryResults;
  // The project's delivery (Settings → Delivery); a pull-request project gets Open PR instead of Merge.
  deliveryMode?: (projectId: string) => Promise<"merge" | "pull-request">;
  sources: (serverId: string) => Promise<TaskSource[]>;
  // Every decision on this host; the latest review of the task's latest run must be approved.
  decisions: (serverId: string) => Promise<Decisions>;
  runs?: (source: TaskSource, serverId: string) => Promise<RunRecord[]>;
  // The project's main checkout folder.
  projectRoot: (projectId: string, paseo: PaseoApi) => Promise<string>;
  clearReviewMarks: (workspaceId: string) => Promise<unknown>;
  deliver: (source: TaskSource, line: string) => Promise<unknown>;
  now?: () => Date;
  // How long a commit or merge may run before it is stopped and undone.
  writeTimeoutMs?: number;
  // How long start() waits for the merge before replying that it is still running.
  replyWithinMs?: number;
  // Tests only: runs after the checks and any commit, just before `git merge`.
  beforeMerge?: () => Promise<void>;
  // Tests only: runs in the checks right after the task branch's head is read.
  afterBranchRead?: () => Promise<void>;
};

const checkOrder: MergeCheck["id"][] = ["task", "review", "agent", "main-checkout", "local-files", "in-progress", "work"];

/**
 * What the checks read. Open PR runs the same checks without the main-checkout ones, then builds its own plan.
 * undone: paths Git lists as changed in the worktree whose content matches the task branch.
 */
export type Evaluation = {
  status: MergeStatus; source: TaskSource | null; mainHead: string | null; taskHead: string | null; tree: string | null; dirty: boolean; undone: string[];
  // The task worktree (null when the branch isn't checked out anywhere), the main checkout, and the uncommitted files.
  taskDirectory: string | null; main: string | null; files: string[];
  // Commits the target lacks, the message a commit of uncommitted work gets, and the agent to tell (null: none).
  ahead: number; commitMessage: string; agentId: string | null;
};
/** Merge's checks, or Open PR's: the same without the main checkout's, and "work" measured against origin's target branch. */
export type EvaluateMode = { kind: "merge" } | { kind: "pull-request"; targetBranch: string };

/**
 * The Attention tab's Merge action for a task that ran in its own worktree: read-only checks first, then
 * commit the task branch's uncommitted work, merge it into the main checkout with --no-ff, and clean up.
 * It never pushes, forces, rebases, stashes, resets branches or touches other branches.
 */
export function createMergeService(deps: Deps) {
  const readRuns = deps.runs ?? runRecordsOf;
  const writeTimeout = deps.writeTimeoutMs ?? 120_000;
  const replyWithin = deps.replyWithinMs ?? replyWithinMs;
  const results = deps.results ?? createDeliveryResults();
  const running = new Set<string>();
  // Also a merge, pull request or cleanup of the task that is still running in the background.
  const merging = (taskId: string) => running.has(taskId) || results.running(taskId);
  /** Whether a kept Merge or Open PR result says Mission Control made `commit` for the task (its message may be any the user confirmed). */
  const recordedCommit = async (taskId: string, commit: string) => (await results.list())
    .some(entry => entry.taskId === taskId && entry.result !== null && "committed" in entry.result && entry.result.committed === commit);
  /** The project's delivery; Merge, with a warning, when the Delivery settings can't be read, so Merge keeps working. */
  async function deliveryOf(projectId: string): Promise<{ mode: "merge" | "pull-request"; warning: string | null }> {
    try { return { mode: (await deps.deliveryMode?.(projectId)) ?? "merge", warning: null }; }
    catch (error) { return { mode: "merge", warning: `Delivery settings can't be read (${failure(error)}), so every task is offered Merge until they're fixed in Settings → Delivery.` }; }
  }

  async function evaluate(serverId: string, taskId: string, paseo: PaseoApi, mode: EvaluateMode = { kind: "merge" }): Promise<Evaluation> {
    const forMerge = mode.kind === "merge";
    const verb = forMerge ? "merge" : "deliver";
    const checks: MergeCheck[] = [];
    const add = (id: MergeCheck["id"], label: string, ok: boolean, detail: string) => { checks.push({ id, label, ok, detail }); return ok; };
    const result = (source: TaskSource | null = null, plan: MergePlan | null = null, extra: Partial<Evaluation> = {}): Evaluation => ({
      status: { taskId, ready: plan !== null && checks.every(check => check.ok), checks: checks.sort((a, b) => checkOrder.indexOf(a.id) - checkOrder.indexOf(b.id)), plan },
      source, mainHead: null, taskHead: null, tree: null, dirty: false, undone: [], taskDirectory: null, main: null, files: [], ahead: 0, commitMessage: "", agentId: null, ...extra,
    });

    const source = (await deps.sources(serverId)).find(item => item.task.taskId === taskId) ?? null;
    const task = source?.task;
    const worktree = task?.worktree;
    if (!source || !task || !task.assignments.some(item => item.serverId === serverId)) { add("task", "Task", false, "This task isn't on this host."); return result(); }
    if (!source.folder) { add("task", "Task", false, "This task has no task folder."); return result(source); }
    if (!worktree) { add("task", "Task", false, `This task didn't run in its own worktree, so there is no task branch to ${verb}.`); return result(source); }
    if (task.status === "delivered" || task.status === "closed") { add("task", "Task", false, `This task is already ${task.status}.`); return result(source); }
    if (forMerge && task.pullRequest) { add("task", "Task", false, `This task was delivered as the pull request ${task.pullRequest.url}; Attention's Pull requests list follows it.`); return result(source); }
    if (forMerge && (await deliveryOf(task.projectId)).mode === "pull-request") {
      add("task", "Task", false, "This project delivers by pull request (Settings → Delivery), so it gets Open PR instead of Merge.");
      return result(source);
    }
    add("task", "Task", true, `Runs in its own worktree on ${worktree.branch}.`);

    // Review: the latest run's newest review decision is approved, and nothing is left open.
    const runs = await readRuns(source, serverId);
    const run = runs[0] ?? null;
    const decisions = await deps.decisions(serverId);
    const own = (entry: DecisionEntry) => entry.decision.taskId === taskId;
    const open = decisions.open.find(own);
    const review = run ? newestReview(decisions, taskId, run.runId) : undefined;
    const unresolved = review ? review.findings.filter(finding => ["open", "submitted", "awaiting_verification"].includes(finding.status)).length + review.unverifiedFindings : 0;
    let reviewOk = false;
    if (!run) add("review", "Review approved", false, "The task has no run.");
    else if (open) add("review", "Review approved", false, `A ${open.decision.kind} decision is still waiting for your answer.`);
    else if (!review) add("review", "Review approved", false, "The latest run has no review decision.");
    else if (review.decision.status !== "approved") add("review", "Review approved", false, `The latest review decision is ${review.decision.status.replaceAll("_", " ")}, not approved.`);
    else if (unresolved) add("review", "Review approved", false, `${plural(unresolved, "finding")} ${unresolved === 1 ? "is" : "are"} still open or awaiting a fix.`);
    else if (!review.decision.candidate) add("review", "Review approved", false, "This review didn't record what it covered (it was requested before Mission Control did that), so its approval can't be matched to the task's files. Ask for a fresh review.");
    else reviewOk = true;

    // Agent: idle, or no longer there.
    const agentId = run?.agentId ?? null;
    let notify: string | null = null;
    if (!agentId) add("agent", "Agent idle", true, "No agent is linked to the run. No note will be sent.");
    else {
      try {
        const agent = await lookupAgent(paseo, agentId);
        if (!agent.found) add("agent", "Agent idle", true, "The task's agent no longer exists. No note will be sent.");
        else { add("agent", "Agent idle", agent.idle, agent.detail); if (!agent.archived) notify = agentId; }
      } catch (error) { add("agent", "Agent idle", false, `Couldn't read the task's agent: ${failure(error)}`); }
    }

    // Git: the main checkout and the task branch.
    const root = await realpath(await deps.projectRoot(task.projectId, paseo));
    const worktrees = parseWorktreeList(await gitOut(root, ["worktree", "list", "--porcelain"]));
    const main = await realpath(worktrees[0]?.path ?? root).catch(() => worktrees[0]?.path ?? root);
    const entry = worktrees.find(item => item.branch === `refs/heads/${worktree.branch}`);
    const taskDirectory = entry ? await realpath(entry.path).catch(() => entry.path) : null;
    const workLabel = forMerge ? "Work to merge" : "Work to deliver";
    const taskHead = await gitOut(main, ["rev-parse", "--verify", "--quiet", `refs/heads/${worktree.branch}^{commit}`], { acceptable: [0, 1] });
    if (!taskHead) { add("work", workLabel, false, `The task branch ${worktree.branch} doesn't exist.`); return result(source); }
    if (forMerge && taskDirectory && samePath(taskDirectory, main)) { add("main-checkout", "Main checkout", false, `The main checkout has the task branch ${worktree.branch} checked out.`); return result(source); }
    if (taskDirectory) {
      const onBranch = await gitOut(taskDirectory, ["symbolic-ref", "--quiet", "--short", "HEAD"], { acceptable: [0, 1, 128] });
      if (onBranch !== worktree.branch) { add("work", workLabel, false, `The task worktree is on ${onBranch || "a detached HEAD"}, not ${worktree.branch}.`); return result(source); }
    }

    // The task as it is now: its branch plus the worktree's uncommitted work, in one tree. The candidate
    // must sit on the branch head read above, so both come from one moment; otherwise check again.
    await deps.afterBranchRead?.();
    const headTree = await gitOut(main, ["rev-parse", `${taskHead}^{tree}`]);
    const current = taskDirectory ? await reviewCandidate(taskDirectory) : { head: taskHead, tree: headTree };
    if (current.head !== taskHead) {
      add("work", workLabel, false, `The task branch moved from ${short(taskHead)} to ${current.head ? short(current.head) : "no commit"} while it was being checked. Check again.`);
      return result(source);
    }
    // Uncommitted work is whatever the candidate holds beyond the branch head.
    const dirty = current.tree !== headTree;
    const commitMessage = `${task.title} (${task.taskId})`;
    const reviewed = review?.decision.candidate;
    if (reviewOk && reviewed) {
      // The same files as reviewed, on the reviewed commit or on Mission Control's own commit of them
      // directly on top (left by an earlier attempt that hit a conflict or a failed push). Its own commit has
      // the default message, or is the one a kept result recorded (a message written from paseo.json or edited).
      const sameFiles = current.tree === reviewed.tree;
      const sameHead = taskHead === reviewed.head || (sameFiles && reviewed.head !== null && (await parentsOf(main, taskHead)).join(" ") === reviewed.head
        && ((await gitOut(main, ["log", "-1", "--format=%s", taskHead])) === commitMessage || await recordedCommit(taskId, taskHead)));
      if (!sameFiles) {
        const changed = nulList(await gitOut(main, ["diff", "--name-only", "-z", "--no-renames", "--no-ext-diff", reviewed.tree, current.tree]));
        add("review", "Review approved", false, `The task changed after its review was requested: ${changed.length ? `${plural(changed.length, "file")} differ (${listed(changed, 10)})` : "its files differ"}. Ask for a fresh review.`);
      } else if (!sameHead) {
        add("review", "Review approved", false, `The task branch moved from ${reviewed.head ? short(reviewed.head) : "no commit"} to ${short(taskHead)} after its review was requested. Ask for a fresh review.`);
      } else add("review", "Review approved", true, `Review approved${review?.decision.resolvedAt ? ` ${review.decision.resolvedAt.slice(0, 10)}` : ""} for exactly these files, no open findings.`);
    }

    // The main checkout's own checks are Merge's alone: Open PR never touches the main checkout.
    let mainHead: string | null = null;
    let target: string | null = null;
    let targetRef: string | null = null;
    if (forMerge) {
      const mainBranch = await gitOut(main, ["symbolic-ref", "--quiet", "--short", "HEAD"], { acceptable: [0, 1, 128] });
      mainHead = await gitOut(main, ["rev-parse", "--verify", "--quiet", "HEAD"], { acceptable: [0, 1] }) || null;
      const from = await startingBranch(main, worktree.branch);
      const mainChanges = changedPaths(await statusOf(main, "normal")).length;
      const contains = mainHead ? (await git(main, ["merge-base", "--is-ancestor", worktree.baseCommit, mainHead])).code === 0 : false;
      target = from ?? mainBranch;
      if (!mainBranch || !mainHead) add("main-checkout", "Main checkout", false, `The main checkout ${main} isn't on a branch.`);
      else if (from && mainBranch !== from) add("main-checkout", "Main checkout", false, `The main checkout is on ${mainBranch}, but the task branch started from ${from}.`);
      else if (!contains) add("main-checkout", "Main checkout", false, `${mainBranch} doesn't contain the task's base commit ${short(worktree.baseCommit)}, so it isn't the branch the task started from.`);
      else if (mainChanges) add("main-checkout", "Main checkout", false, `The main checkout has ${plural(mainChanges, "uncommitted change")} (including untracked files). Commit or move them first.`);
      else add("main-checkout", "Main checkout", true, `${main} is clean and on ${mainBranch}${from ? ", where the task started" : ""}.`);

      // Local files the merge would overwrite, ignored ones included.
      const mergeBase = mainHead ? await gitOut(main, ["merge-base", mainHead, taskHead], { acceptable: [0, 1] }) : "";
      if (mergeBase) {
        const inTheWay = await localFilesInTheWay(main, mergeBase, current.tree);
        if (inTheWay.length) add("local-files", "No local files in the way", false, `The merge would overwrite ${plural(inTheWay.length, "local file")} in the main checkout that ${inTheWay.length === 1 ? "isn't" : "aren't"} tracked there (ignored or untracked): ${listed(inTheWay, 50)}. Move or delete ${inTheWay.length === 1 ? "it" : "them"} first.`);
        else add("local-files", "No local files in the way", true, "No ignored or untracked file in the main checkout would be overwritten.");
      }
      targetRef = mainHead;
    } else {
      // Measured against origin's target branch as last fetched; the push itself never needs it.
      target = mode.targetBranch;
      targetRef = await gitOut(main, ["rev-parse", "--verify", "--quiet", `refs/remotes/origin/${mode.targetBranch}^{commit}`], { acceptable: [0, 1] }) || null;
    }

    const busy = [forMerge ? await operationInProgress(main).then(label => label && `The main checkout has ${label} in progress.`) : null,
      taskDirectory ? await operationInProgress(taskDirectory).then(label => label && `The task worktree has ${label} in progress.`) : null].filter(Boolean);
    add("in-progress", "No merge or rebase in progress", busy.length === 0, busy.length ? busy.join(" ") : "Nothing is in progress.");

    // Work: commits the target lacks, or uncommitted changes in the worktree. The file list comes from the
    // same trees as the candidate, so it can't disagree with it.
    const files = dirty ? nulList(await gitOut(main, ["diff", "--name-only", "-z", "--no-renames", "--no-ext-diff", headTree, current.tree])) : [];
    // Git can still list a file whose content matches the branch, such as a staged change that was undone in
    // the files. It isn't part of the merge; without other uncommitted work, the merge unstages it.
    const undone = taskDirectory ? changedPaths(await statusOf(taskDirectory, "all")).filter(path => !files.includes(path)) : [];
    const undoneNote = undone.length ? ` Git also lists ${listed(undone, 10)} as changed, but ${undone.length === 1 ? "its content matches" : "their content matches"} ${worktree.branch} (for example a staged change that was undone in the files), so ${undone.length === 1 ? "it isn't" : "they aren't"} part of the ${forMerge ? "merge" : "pull request"}.` : "";
    const ahead = targetRef ? Number(await gitOut(main, ["rev-list", "--count", `${targetRef}..${taskHead}`])) || 0 : 0;
    if (!forMerge && !targetRef) add("work", workLabel, false, `origin/${target} isn't known here, so the task's commits can't be compared with it. Pull latest on the Workspaces tab, or change this project's default branch.`);
    else if (!ahead && !dirty) add("work", workLabel, false, `${worktree.branch} has no commits or uncommitted changes that ${forMerge ? target || "the main checkout" : `origin/${target}`} lacks.${undoneNote}`);
    else add("work", workLabel, true, [ahead ? plural(ahead, "commit") : "", files.length ? plural(files.length, "uncommitted file") : ""].filter(Boolean).join(" and ") + ` to ${verb}.${undoneNote}`);

    const extra: Partial<Evaluation> = { taskHead, mainHead, tree: current.tree, dirty, undone, taskDirectory, main, files, ahead, commitMessage, agentId: notify };
    if (!forMerge || !target || !mainHead) return result(source, null, extra);
    const plan: MergePlan = {
      taskTitle: task.title, mainCheckout: main, targetBranch: target, taskBranch: worktree.branch, worktreeDirectory: taskDirectory, worktreeWorkspaceId: worktree.workspaceId,
      uncommittedFiles: files.slice(0, 50), uncommittedCount: files.length, commitsAhead: ahead, commitMessage,
      // With uncommitted work, its commit takes these along; without, the merge unstages them.
      undoneFiles: undone.slice(0, 50), undoneCount: undone.length,
      mergeMessage: `Merge ${worktree.branch}: ${task.title}`, agentId: notify,
      fingerprint: createHash("sha256").update(`${mainHead}\0${taskHead}\0${current.tree}`).digest("hex"),
    };
    return result(source, plan, extra);
  }

  async function check(input: { serverId: string; taskId: string }, paseo: PaseoApi): Promise<MergeStatus> {
    // Mid-merge the worktree and branches are in between; checking them would only report noise.
    if (merging(input.taskId)) return { taskId: input.taskId, ready: false, checks: [{ id: "task", label: "Task", ok: false, detail: "This task is being merged or delivered now. Attention shows its progress." }], plan: null };
    return (await evaluate(input.serverId, input.taskId, paseo)).status;
  }

  async function merge(input: MergeInput, paseo: PaseoApi): Promise<MergeResult> {
    if (merging(input.taskId)) return { outcome: "refused", reason: "This task is already being merged or delivered.", checks: [] };
    return run(input, paseo, () => {});
  }

  // Callers check merging() first, in the same tick, so two merges of one task never overlap.
  async function run(input: MergeInput, paseo: PaseoApi, report: (step: string) => void): Promise<MergeResult> {
    running.add(input.taskId);
    try {
      const source = (await deps.sources(input.serverId)).find(item => item.task.taskId === input.taskId);
      if (!source) return { outcome: "refused", reason: "This task isn't on this host.", checks: [] };
      const root = await realpath(await deps.projectRoot(source.task.projectId, paseo));
      return await withRepository(root, () => mergeLocked(input, paseo, report));
    } finally { running.delete(input.taskId); }
  }

  /**
   * Runs a merge and replies with its result, or, when it outlasts replyWithinMs, replies that it is still
   * running and finishes in the background. Either way Attention keeps its result card until it is dismissed.
   */
  async function start(input: MergeInput, paseo: PaseoApi): Promise<MergeReply> {
    if (merging(input.taskId)) return { outcome: "refused", reason: "This task is already being merged or delivered. Attention shows its progress.", checks: [] };
    const title = async () => (await deps.sources(input.serverId)).find(item => item.task.taskId === input.taskId)?.task.title ?? input.taskId;
    const started = await results.start("merge", input.taskId, title, report => run(input, paseo, report), replyWithin);
    return started.done ? started.result : { outcome: "running", resultId: started.resultId, taskId: input.taskId, step: started.step, startedAt: started.startedAt };
  }

  /**
   * Tasks on this host that ran in their own worktree, whose latest run's newest review decision is
   * approved and that have no open decision and no pull request yet: the ones Merge and Open PR are for.
   * Their own checks decide whether each can be delivered now.
   */
  async function ready(serverId: string): Promise<{ tasks: MergeReadyTask[]; warning: string | null }> {
    const [sources, decisions] = await Promise.all([deps.sources(serverId), deps.decisions(serverId)]);
    const tasks: MergeReadyTask[] = [];
    let warning: string | null = null;
    for (const source of sources) {
      const { task } = source;
      const worktree = task.worktree;
      // Only a task that ran in its own worktree has a branch to merge; the others could never pass the checks.
      if (!worktree || task.pullRequest || task.status === "delivered" || task.status === "closed" || !task.assignments.some(item => item.serverId === serverId)) continue;
      const own = (entry: DecisionEntry) => entry.decision.taskId === task.taskId;
      // Reading runs costs a folder scan, so only tasks with an approved review read them.
      if (decisions.open.some(own) || !decisions.recent.some(entry => own(entry) && entry.decision.kind === "review" && entry.decision.status === "approved")) continue;
      const run = (await readRuns(source, serverId))[0];
      const review = run ? newestReview(decisions, task.taskId, run.runId) : undefined;
      if (!run || review?.decision.status !== "approved") continue;
      const delivery = await deliveryOf(task.projectId);
      warning ??= delivery.warning;
      tasks.push({ taskId: task.taskId, title: task.title, workspaceId: worktree.workspaceId, approvedAt: review.decision.resolvedAt, delivery: delivery.mode });
    }
    return { tasks: tasks.sort((a, b) => (a.approvedAt ?? "").localeCompare(b.approvedAt ?? "")), warning };
  }

  const commitWork = (directory: string, plan: MergePlan, tree: string, message: string) => commitTaskWork(directory, { message, branch: plan.taskBranch, tree, timeoutMs: writeTimeout, nothingDone: "Nothing was merged." });

  async function mergeLocked(input: MergeInput, paseo: PaseoApi, report: (step: string) => void): Promise<MergeResult> {
    const evaluation = await evaluate(input.serverId, input.taskId, paseo);
    const { status, source } = evaluation;
    const plan = status.plan;
    if (!status.ready || !plan || !source || !evaluation.tree) return { outcome: "refused", reason: status.checks.find(item => !item.ok)?.detail ?? "The merge checks didn't pass.", checks: status.checks };
    if (plan.fingerprint !== input.fingerprint) return { outcome: "refused", reason: "The main checkout or the task changed since you opened the merge. Check what will happen again.", checks: status.checks };
    const main = plan.mainCheckout;

    // 1. Commit the worktree's uncommitted work on the task branch.
    let committed: string | null = null;
    if (evaluation.dirty && plan.worktreeDirectory) {
      report("Committing the task's uncommitted work");
      const commit = await commitWork(plan.worktreeDirectory, plan, evaluation.tree, input.commitMessage ?? plan.commitMessage);
      if ("refused" in commit) return { outcome: "refused", reason: commit.refused, checks: status.checks };
      committed = commit.committed;
    } else if (evaluation.undone.length && plan.worktreeDirectory) {
      // Nothing to commit, but Git still lists changes whose content matches the branch, such as a staged
      // change that was undone in the files. Unstage them so the worktree is clean; no file changes.
      report("Unstaging changes that were undone in the files");
      try {
        for (let index = 0; index < evaluation.undone.length; index += 100) {
          await gitOut(plan.worktreeDirectory, ["reset", "--quiet", "--", ...evaluation.undone.slice(index, index + 100)], { acceptable: [0, 1], env: { GIT_LITERAL_PATHSPECS: "1" }, timeout: writeTimeout });
        }
      } catch (error) {
        return { outcome: "refused", reason: `Couldn't unstage ${listed(evaluation.undone, 10)}, whose content already matches ${plan.taskBranch}: ${failure(error)}. Your files are unchanged. Nothing was merged.`, checks: status.checks };
      }
    }

    // 2. Merge into the main checkout; on any failure or time-out, abort and leave it as it was.
    const before = evaluation.mainHead!;
    const tip = committed ?? evaluation.taskHead!;
    // Recheck right before merging: the commit to merge must hold exactly the checked (and reviewed) files.
    if ((await gitOut(main, ["rev-parse", `${tip}^{tree}`])) !== evaluation.tree) {
      return { outcome: "refused", reason: `The commit to merge (${short(tip)}) doesn't hold the files that were checked, so the task changed while it was being merged. Nothing was merged; check again.`, checks: status.checks };
    }
    report(`Merging into ${plan.targetBranch}`);
    const started = Date.now();
    let merged: Git | null = null;
    let stopped: GitStopped | null = null;
    await deps.beforeMerge?.();
    // The exact commit the checks approved, not the branch name: a commit added to the branch since then isn't merged.
    try { merged = await git(main, ["merge", "--no-ff", "--no-edit", "--no-autostash", "-m", plan.mergeMessage, "-m", `Task ${input.taskId}.`, tip], { timeout: writeTimeout }); }
    catch (error) {
      if (!(error instanceof GitStopped)) throw error;
      stopped = error;
      // Git may still be merging: don't release its lock, abort or reset on a guess. Report the state as unknown.
      if (!error.confirmed) {
        return { outcome: "conflict", state: "unknown", files: [], committed, detail: `Merging ${plan.taskBranch} into ${plan.targetBranch} stopped: ${error.message}. The main checkout's state is unknown, so nothing was aborted, reset or unlocked. Check ${main} (git status) before doing anything else.${committed ? ` The task's uncommitted work stays committed on ${plan.taskBranch} as ${short(committed)}.` : ""}` };
      }
      await releaseStaleLock(main, started);
    }
    const after = await gitOut(main, ["rev-parse", "HEAD"]);
    const mergeHead = await gitOut(main, ["rev-parse", "--verify", "--quiet", "MERGE_HEAD"], { acceptable: [0, 1] });
    // A merge commit of exactly the target and the task branch counts, even if Git was stopped after making it.
    const done = !mergeHead && after !== before && (await parentsOf(main, after)).join(" ") === `${before} ${tip}`;
    if (!done) {
      const files = nulList(await gitOut(main, ["diff", "--name-only", "--diff-filter=U", "-z"]));
      if (mergeHead) await git(main, ["merge", "--abort"], { timeout: writeTimeout });
      // Git stopped mid-merge before recording it: the checkout was clean, so its changes are the merge's own.
      else if (stopped && after === before && (await statusOf(main, "no"))) await git(main, ["reset", "--merge", "--quiet"], { timeout: writeTimeout });
      if (stopped) await removeMergeTempFiles(main, started);
      const restored = (await gitOut(main, ["rev-parse", "HEAD"])) === before && !(await statusOf(main, "normal"));
      const kept = committed ? ` The task's uncommitted work stays committed on ${plan.taskBranch} as ${short(committed)}.` : "";
      const reason = stopped ? `Merging ${plan.taskBranch} into ${plan.targetBranch} stopped: ${stopped.message}.`
        : files.length ? `Merging ${plan.taskBranch} into ${plan.targetBranch} conflicts in ${plural(files.length, "file")}.`
          : `Git couldn't merge ${plan.taskBranch}: ${merged?.stderr || merged?.stdout.trim() || "unknown error"}.`;
      const detail = restored ? `${reason} The merge was aborted and ${plan.targetBranch} is as it was.${kept}`
        : `${reason} The main checkout isn't back to where it was (${short(before)}, clean). Check it before doing anything else.${kept}`;
      return { outcome: "conflict", state: restored ? "aborted" : "not-restored", files, committed, detail };
    }

    // 3. Clean up. The merge stands, so each step reports instead of throwing.
    const steps: MergeStep[] = [];
    const step = async (label: string, work: () => Promise<string | { skipped: string }>) => {
      try {
        const outcome = await work();
        steps.push(typeof outcome === "string" ? { label, state: "done", detail: outcome } : { label, state: "skipped", detail: outcome.skipped });
      } catch (error) { steps.push({ label, state: "failed", detail: failure(error) }); }
    };
    const day = (deps.now?.() ?? new Date()).toISOString().slice(0, 10);
    // Commits added to the branch after the checks weren't merged; keep the worktree and branch that hold them.
    const branchNow = await gitOut(main, ["rev-parse", "--verify", "--quiet", `refs/heads/${plan.taskBranch}`], { acceptable: [0, 1] });
    const newer = branchNow && branchNow !== tip ? Number(await gitOut(main, ["rev-list", "--count", `${tip}..${branchNow}`])) || 0 : 0;
    const moved = newer ? `${plan.taskBranch} gained ${plural(newer, "commit")} after the checks (now ${short(branchNow)}); only the checked commit ${short(tip)} was merged, so` : "";
    report("Cleaning up");
    await step("Clear Review marks", async () => { await deps.clearReviewMarks(plan.worktreeWorkspaceId); return "Cleared the worktree workspace's Review marks."; });
    await step("Mark delivered", async () => {
      await deps.deliver(source, `- ${day}: Delivered. Merged ${plan.taskBranch} into ${plan.targetBranch} as ${short(after)} from Mission Control${committed ? `, after committing its uncommitted work as ${short(committed)}` : ""}.`);
      return "Set the task to delivered and added a status.md line.";
    });
    // Archiving the workspace closes its agents, so the note goes before it. It states only what has
    // happened, and what comes next as a plan, so it stays true if a later step fails.
    await step("Tell the agent", async () => {
      if (!plan.agentId) return { skipped: "No live agent to tell." };
      const delivered = steps.find(item => item.label === "Mark delivered")?.state === "done"
        ? "The task is marked delivered." : "Marking the task delivered didn't work; Mission Control's merge result says why.";
      const next = moved
        ? `${plan.taskBranch} gained ${plural(newer, "commit")} after the checks that ${newer === 1 ? "wasn't" : "weren't"} merged, so this worktree workspace and its branch are kept.`
        : `Next, Mission Control will archive this worktree workspace, which closes this agent, and delete ${plan.taskBranch}; its merge result shows how that went.`;
      await paseo.agents.ref(plan.agentId).send(`Mission Control merged task ${input.taskId} (${plan.taskTitle}) into ${plan.targetBranch} as ${short(after)}. ${delivered} ${next} Nothing more is needed; please don't change anything.`, { messageId: `merge-${input.taskId}-${after}` });
      return "Sent a short note that the task was merged.";
    });
    await step("Archive worktree workspace", async () => {
      if (moved) return { skipped: `${moved} the worktree workspace was kept.` };
      const archived = await paseo.workspaces.ref(plan.worktreeWorkspaceId).archive();
      if (archived.error || !archived.archivedAt) throw new Error(archived.error || "Paseo did not confirm that the workspace was archived.");
      return "Archived the worktree workspace.";
    });
    await step("Delete merged branch", async () => {
      const exists = await gitOut(main, ["rev-parse", "--verify", "--quiet", `refs/heads/${plan.taskBranch}`], { acceptable: [0, 1] });
      if (!exists) return "The branch was already deleted.";
      if (moved) return { skipped: `${moved} the branch was kept.` };
      const holder = parseWorktreeList(await gitOut(main, ["worktree", "list", "--porcelain"])).find(item => item.branch === `refs/heads/${plan.taskBranch}`);
      if (holder) return { skipped: `${plan.taskBranch} is still checked out in ${holder.path}, so it was kept.` };
      // -d, not -D: Git refuses unless the branch is merged.
      await gitOut(main, ["branch", "-d", "--", plan.taskBranch]);
      return `Deleted ${plan.taskBranch}.`;
    });
    return { outcome: "merged", mergeCommit: after, targetBranch: plan.targetBranch, committed, steps };
  }

  return { check, merge, start, ready, evaluate };
}
