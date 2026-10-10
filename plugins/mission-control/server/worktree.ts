import { realpath } from "node:fs/promises";
import type { PaseoApi } from "@getpaseo/client";
import type { TaskRecord } from "../shared/tasks";
import { taskStartingPoint } from "./project-git";
import { runGit } from "./review";

export type CreatedWorktree = { workspaceId: string; branch: string; baseCommit: string; directory: string };

/** Branch names are fixed per task, so an interrupted start finds its worktree again. */
export function taskBranchName(task: Pick<TaskRecord, "taskId" | "title">) {
  const id = task.taskId.replace(/^task_/, "").slice(0, 8);
  const words = task.title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40).replace(/-+$/, "");
  const slug = words ? `${id}-${words}` : id;
  return { branch: `task/${slug}`, slug };
}

/** A folder name for a templated branch: the short task ID keeps it unique, then the branch in lowercase words. */
export function worktreeSlugFor(task: Pick<TaskRecord, "taskId">, branch: string) {
  const id = task.taskId.replace(/^task_/, "").slice(0, 8);
  const words = branch.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  const slug = words.includes(id) ? words : `${id}-${words}`;
  return slug.slice(0, 60).replace(/-+$/, "");
}

/** Entries from `git worktree list --porcelain`. */
export function parseWorktreeList(porcelain: string): { path: string; head: string | null; branch: string | null }[] {
  return porcelain.split(/\r?\n\r?\n/).map(block => {
    const lines = block.split(/\r?\n/);
    const value = (key: string) => lines.find(line => line.startsWith(`${key} `))?.slice(key.length + 1) ?? null;
    return { path: value("worktree") ?? "", head: value("HEAD"), branch: value("branch") };
  }).filter(entry => entry.path);
}

const samePath = (a: string, b: string) => (process.platform === "win32" ? a.toLowerCase() === b.toLowerCase() : a === b);

/**
 * Why a templated name can't be this task's new branch: it already exists, or is checked out, and
 * isn't this task's own worktree. A template can produce the name of a branch someone made by hand
 * (ABC-123-add-login-retry), and a task must never take over that branch or its checkout.
 * This task's worktree from an interrupted start (its folder is named by worktreeSlugFor) is fine.
 */
export async function templatedBranchConflict(sourceCwd: string, task: Pick<TaskRecord, "taskId">, branch: string): Promise<string | null> {
  const cwd = await realpath(sourceCwd);
  const entry = parseWorktreeList(await runGit(cwd, ["worktree", "list", "--porcelain"])).find(item => item.branch === `refs/heads/${branch}`);
  if (entry) {
    const folder = entry.path.replace(/[\\/]+$/, "").split(/[\\/]/).pop() ?? "";
    const directory = await realpath(entry.path).catch(() => entry.path);
    if (samePath(folder, worktreeSlugFor(task, branch)) && !samePath(directory, cwd)) return null;
    return `A branch named ${branch} is already checked out in ${directory}. Mission Control won't take it over; rename that branch or change the template.`;
  }
  if ((await runGit(cwd, ["rev-parse", "--verify", "--quiet", `refs/heads/${branch}`], [0, 1])).trim()) {
    return `A branch named ${branch} already exists in this repository. Mission Control won't take it over; rename or delete that branch, or change the template.`;
  }
  return null;
}

async function findWorkspace(paseo: PaseoApi, directory: string) {
  const { entries } = await paseo.workspaces.list({ page: { limit: 200 } });
  for (const workspace of entries) {
    if (!workspace.workspaceDirectory || workspace.archivingAt) continue;
    try { if (samePath(await realpath(workspace.workspaceDirectory), directory)) return workspace.id; }
    catch { /* A workspace whose folder is gone cannot be this worktree. */ }
  }
  return null;
}

/** The oldest entry in a branch's reflog: the commit it was created at, if Git still has that log. */
async function branchCreationPoint(cwd: string, branch: string) {
  const entries = (await runGit(cwd, ["reflog", "show", "--format=%H", `refs/heads/${branch}`, "--"], [0, 128])).trim().split(/\r?\n/);
  const oldest = entries[entries.length - 1];
  return /^[0-9a-f]{40}$/.test(oldest) ? oldest : null;
}

/**
 * Creates (or finds again) the Paseo worktree workspace for a task: a `task/…` branch off the freshly
 * fetched `origin/<default branch>` (`defaultBranch`, else origin's HEAD branch). A repository without
 * an origin remote branches off the source checkout's current branch. Uncommitted changes in the
 * source are not carried over. `branch` is the name from the branch-name template, else task/<id>-<slug>.
 */
export async function createTaskWorktree(input: { task: TaskRecord; sourceCwd: string; defaultBranch?: string; branch?: string }, paseo: PaseoApi): Promise<CreatedWorktree> {
  const cwd = await realpath(input.sourceCwd);
  const head = (await runGit(cwd, ["rev-parse", "--verify", "--quiet", "HEAD"], [0, 1])).trim();
  if (!head) throw new Error("Make a first commit before starting a task in its own worktree.");
  const { branch, slug } = input.branch ? { branch: input.branch, slug: worktreeSlugFor(input.task, input.branch) } : taskBranchName(input.task);
  if ((await runGit(cwd, ["check-ref-format", "--branch", branch], [0, 1, 128])).trim() !== branch) {
    throw new Error(`Git won't accept the branch name "${branch}". Change the branch name template in Mission Control's settings, or start the task in this workspace instead.`);
  }
  if (input.branch) {
    const conflict = await templatedBranchConflict(cwd, input.task, branch);
    if (conflict) throw new Error(conflict);
  }
  let workspaceId: string | null = null;
  let directory: string | null = null;
  let start: { baseBranch: string | null; ref: string } | null = null;
  const existing = parseWorktreeList(await runGit(cwd, ["worktree", "list", "--porcelain"])).find(entry => entry.branch === `refs/heads/${branch}`);
  if (existing) {
    directory = await realpath(existing.path);
    workspaceId = await findWorkspace(paseo, directory) ?? (await paseo.workspaces.open({ cwd: directory })).id;
  } else {
    // A kept branch without a worktree (for example after an archive) is checked out, not recreated.
    const branchExists = (await runGit(cwd, ["rev-parse", "--verify", "--quiet", `refs/heads/${branch}`], [0, 1])).trim() !== "";
    // Only a new branch needs origin; finding a task's branch again works offline.
    if (!branchExists) start = await taskStartingPoint(cwd, input.defaultBranch);
    const handle = await paseo.workspaces.create({
      idempotencyKey: `mission-control-worktree-${input.task.taskId}`,
      title: input.task.title,
      source: branchExists
        ? { kind: "worktree", cwd, projectId: input.task.projectId, action: "checkout", refName: branch, worktreeSlug: slug }
        : { kind: "worktree", cwd, projectId: input.task.projectId, action: "branch-off", ...(start?.baseBranch ? { baseBranch: start.baseBranch } : {}), branchName: branch, worktreeSlug: slug },
    });
    workspaceId = handle.id;
    const refreshed = await handle.refresh();
    const folder = refreshed?.workspaceDirectory ?? handle.directory;
    directory = folder ? await realpath(folder) : null;
  }
  if (!workspaceId || !directory) throw new Error("Paseo did not report the new worktree's folder.");
  // Paseo's idempotency key can return this task's earlier worktree, for example after a retry with a different branch type.
  const checkedOut = (await runGit(directory, ["symbolic-ref", "--quiet", "--short", "HEAD"], [0, 1, 128])).trim();
  if (checkedOut !== branch) throw new Error(`The task's worktree ${directory} is on ${checkedOut || "a detached HEAD"}, not ${branch}. Archive that worktree workspace, or choose the same branch type as before.`);
  // The branch point: where the task branch left the branch it started from. A branch found again
  // uses the commit Git logged when creating it, else the source checkout's HEAD.
  const baseRef = start?.ref ?? await branchCreationPoint(cwd, branch) ?? head;
  const baseCommit = (await runGit(directory, ["merge-base", "HEAD", baseRef])).trim();
  if (!/^[0-9a-f]{40}$/.test(baseCommit)) throw new Error("Could not find where the task branch starts.");
  return { workspaceId, branch, baseCommit, directory };
}
