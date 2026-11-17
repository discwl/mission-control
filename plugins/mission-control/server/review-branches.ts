import { createHash } from "node:crypto";
import { realpath } from "node:fs/promises";
import type { ReviewSnapshot } from "../shared/review";
import { resolveDefaultBranch } from "./project-git";
import { checkReviewPath, previewReviewBytes } from "./review-actions";
import { diffReviewObjects, readGitBlobPrefix, runGit } from "./review";
import { severityRank } from "./review-rules";

const localPrefix = "refs/heads/";
const remotePrefix = "refs/remotes/";
const nameOf = (ref: string) => ref.replace(/^refs\/(heads|remotes)\//, "");

async function refsForReview(cwd: string, configured?: string) {
  const [refs, current, setting] = await Promise.all([
    runGit(cwd, ["for-each-ref", "--sort=-committerdate", "--format=%(refname)%00%(objectname)%00%(symref)%00%(worktreepath)%00%(upstream)", localPrefix, remotePrefix]),
    runGit(cwd, ["symbolic-ref", "--quiet", "HEAD"], [0, 1]),
    resolveDefaultBranch(cwd, configured, false),
  ]);
  const rows = refs.trimEnd().split("\n").filter(Boolean).map(line => {
    const [ref, head, symref, worktree, upstream] = line.split("\0");
    return { ref, head, symref, worktree, upstream };
  });
  const branches = rows.filter(row => !row.symref);
  // A clone whose sole remote is named upstream can still advertise its default branch.
  const heads = rows.filter(row => row.ref.startsWith(remotePrefix) && row.ref.endsWith("/HEAD") && row.symref);
  const remote = heads.length === 1 ? heads[0].ref.slice(0, -"HEAD".length) : `${remotePrefix}origin/`;
  const advertised = heads.length === 1 && heads[0].symref.startsWith(remote) ? heads[0].symref.slice(remote.length) : undefined;
  const name = setting?.branch ?? advertised ?? ["main", "master"].find(n => branches.some(b => b.ref === localPrefix + n || b.ref === remote + n));
  const base = name && (branches.find(b => b.ref === `${remotePrefix}origin/${name}`) ?? branches.find(b => b.ref === remote + name) ?? branches.find(b => b.ref === localPrefix + name));
  return { name, base: base || null, branches, currentRef: current.trim() || null };
}

export async function listReviewBranches(cwd: string, configured?: string) {
  const { name, base, branches, currentRef } = await refsForReview(cwd, configured);
  const available = base ? new Set((await runGit(cwd, ["for-each-ref", `--no-merged=${base.head}`, "--format=%(refname)", localPrefix, remotePrefix])).trimEnd().split("\n")) : new Set<string>();
  const choices = branches.filter(b => available.has(b.ref) && b.ref !== localPrefix + name)
    .map(b => ({ ref: b.ref, name: nameOf(b.ref), remote: b.ref.startsWith(remotePrefix) }));
  return { defaultBranch: base ? nameOf(base.ref) : null, currentRef, branches: [...choices.filter(b => !b.remote), ...choices.filter(b => b.remote)] };
}

export async function branchReviewTarget(cwd: string, ref: string, configured?: string) {
  const { base, branches } = await refsForReview(cwd, configured);
  if (!base) throw new Error("Set this project's default branch to review a branch.");
  const target = branches.find(b => b.ref === ref);
  if (!target) throw new Error("This branch is no longer available on the workspace host.");
  const tracking = branches.filter(b => b.upstream === ref && b.worktree);
  const worker = tracking.find(b => b.head === target.head) ?? (tracking.length === 1 ? tracking[0] : null);
  const worktree = target.worktree || worker?.worktree || null;
  return { base, target, worktree };
}

export async function branchReviewSnapshot(cwd: string, ref: string, configured?: string): Promise<ReviewSnapshot> {
  const { base, target, worktree } = await branchReviewTarget(cwd, ref, configured);
  const [root, mergeBase] = await Promise.all([
    runGit(cwd, ["rev-parse", "--show-toplevel"]),
    runGit(cwd, ["merge-base", base.head, target.head], [0, 1]),
  ]);
  const baseCommit = mergeBase.trim();
  if (!baseCommit) throw new Error("These branches do not share a Git history.");
  const repoRoot = await realpath(root.trim());
  const files = await diffReviewObjects(repoRoot, baseCommit, target.head);
  return {
    fingerprint: createHash("sha256").update(JSON.stringify([ref, base.ref, baseCommit, target.head])).digest("hex"), generatedAt: new Date().toISOString(),
    repoRoot, branch: nameOf(ref), head: target.head, base: "branch", comparison: { ref, baseRef: nameOf(base.ref), baseCommit, worktree },
    fromCommit: null, sinceCommit: null, baseWarning: null, omittedFiles: 0,
    files: files.sort((a, b) => severityRank(b.severity) - severityRank(a.severity) || a.path.localeCompare(b.path)),
  };
}

export async function readReviewBranchBlob(cwd: string, commit: string, path: string) {
  const bytes = await readGitBlobPrefix(cwd, commit, checkReviewPath(path), 2 * 1024 * 1024 + 1);
  return previewReviewBytes(bytes);
}

/** Separate comments and marks for every branch, including two refs that currently share a tip. */
export function reviewScopeId(workspaceId: string, branchRef?: string) {
  return branchRef ? `branch-${createHash("sha256").update(JSON.stringify([workspaceId, branchRef])).digest("hex")}` : workspaceId;
}
