import type { Agent, Workspace, WorkspacePullRequest } from "./roster-model";

// What an orchestrator workspace shows about its remote host, without the Paseo client, so tests can load it.

export type ReviewItem = {
  workspace: Workspace;
  // The workspace's agents that aren't archived, newest activity first.
  agents: Agent[];
  working: boolean;
};

const REVIEW_LABELS = new Set(["review", "in review", "ready for review"]);
const SETTLED_LABELS = new Set(["done", "paused"]);
const hasLabel = (workspace: Pick<Workspace, "labels">, names: ReadonlySet<string>) => workspace.labels.some(label => names.has(label.trim().toLowerCase()));
const time = (value: string | null | undefined) => (value ? Date.parse(value) : Number.NaN) || 0;

/** Uncommitted changes, a diff against its base, or commits not yet pushed. */
export function hasChanges(workspace: Workspace): boolean {
  const diff = workspace.diffStat;
  return Boolean((diff && diff.additions + diff.deletions > 0) || workspace.dirty || (workspace.aheadOfOrigin ?? 0) > 0);
}

/**
 * What a host has for the user to review, newest first. Ready: workspaces labelled Review. Changed:
 * other workspaces with changes whose agents have all stopped, leaving out ones labelled Done or Paused.
 */
export function hostReviewItems(workspaces: readonly Workspace[], agents: readonly Agent[]): { ready: ReviewItem[]; changed: ReviewItem[] } {
  const ready: ReviewItem[] = [];
  const changed: ReviewItem[] = [];
  for (const workspace of workspaces) {
    const own = agents.filter(agent => agent.workspaceId === workspace.id && !agent.archivedAt).sort((a, b) => time(b.updatedAt) - time(a.updatedAt));
    const working = own.some(agent => agent.status === "running" || agent.status === "initializing");
    if (hasLabel(workspace, REVIEW_LABELS)) ready.push({ workspace, agents: own, working });
    else if (!working && hasChanges(workspace) && !hasLabel(workspace, SETTLED_LABELS)) changed.push({ workspace, agents: own, working });
  }
  const newest = (a: ReviewItem, b: ReviewItem) => time(b.workspace.activityAt) - time(a.workspace.activityAt);
  return { ready: ready.sort(newest), changed: changed.sort(newest) };
}

/** Agents waiting on the user: permission prompts, questions and errors that Paseo flags. */
export function needsYouCount(agents: readonly Pick<Agent, "requiresAttention" | "archivedAt">[]): number {
  return agents.filter(agent => agent.requiresAttention && !agent.archivedAt).length;
}

export function hostAgentsLabel(label: string, needs: number | null): string {
  return needs ? `${label} agents · ${needs} need${needs === 1 ? "s" : ""} you` : `${label} agents`;
}

export function hostReviewLabel(counts: { ready: number; changed: number } | null): string {
  if (counts?.ready) return `Review · ${counts.ready} ready`;
  return counts?.changed ? `Review · ${counts.changed} changed` : "Review";
}

/** "+120 −30 · uncommitted · 2 to push", or null when Paseo reported no changes. */
export function changeSummary(workspace: Workspace): string | null {
  const diff = workspace.diffStat;
  return [
    diff && diff.additions + diff.deletions > 0 ? `+${diff.additions} −${diff.deletions}` : null,
    workspace.dirty ? "uncommitted" : null,
    workspace.aheadOfOrigin ? `${workspace.aheadOfOrigin} to push` : null,
  ].filter(Boolean).join(" · ") || null;
}

/** "PR #701 · draft · checks failing · changes requested". */
export function pullRequestSummary(pr: WorkspacePullRequest): string {
  const state = pr.merged ? "merged" : pr.draft ? "draft" : pr.state.toLowerCase();
  const checks = pr.checks === "success" ? "checks passing" : pr.checks === "failure" ? "checks failing" : pr.checks === "pending" ? "checks running" : null;
  const review = pr.reviewDecision === "approved" ? "approved" : pr.reviewDecision === "changes_requested" ? "changes requested" : pr.reviewDecision === "pending" ? "review pending" : null;
  return [pr.number ? `PR #${pr.number}` : "PR", state, checks, review].filter(Boolean).join(" · ");
}
