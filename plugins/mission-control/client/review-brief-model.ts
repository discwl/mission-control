import type { FleetTask } from "../shared/fleet";
import type { ReviewSnapshot } from "../shared/review";

export function reviewBrief(entry: FleetTask, serverId: string, workspaceId: string, snapshot: ReviewSnapshot | null, stale: boolean) {
  const reviews = entry.decisions.filter(item => item.decision.kind === "review" && item.decision.taskId === entry.task.taskId && item.decision.serverId === serverId && item.decision.workspaceId === workspaceId && Boolean(entry.run) && item.decision.runId === entry.run!.runId);
  const review = [...reviews].sort((a, b) => Date.parse(b.decision.requestedAt) - Date.parse(a.decision.requestedAt))[0];
  const criteria = entry.task.acceptanceCriteria;
  const outcome = (Array.isArray(criteria) ? criteria.join("\n") : criteria)?.trim();
  const findings = review?.findings.filter(item => item.status !== "resolved" && item.status !== "dismissed") ?? [];
  const findingsFiles = new Set(findings.map(item => item.file?.replaceAll("\\", "/")));
  const rank = { high: 0, medium: 1, low: 2, info: 3 };
  const files = [...(snapshot?.files ?? [])].sort((a, b) => Number(findingsFiles.has(b.path)) - Number(findingsFiles.has(a.path)) || rank[a.severity] - rank[b.severity] || a.path.localeCompare(b.path)).slice(0, 5);
  const mismatch = Boolean(review && snapshot && review.decision.gitHead !== snapshot.head);
  return {
    outcome: outcome || "The task does not have acceptance criteria yet.",
    summary: review?.decision.plain?.built || null,
    found: review?.decision.plain?.found || null,
    requestedAt: review?.decision.requestedAt ?? null,
    warning: !review ? "No review request for this task's current run and workspace. Ask the worker for a review summary when the work is ready."
      : stale || mismatch ? "This summary may describe an older revision. Check the current changes and review evidence before accepting."
      : review.decision.gitDirty ? "The review included uncommitted changes. Matching commits alone do not prove the current files were reviewed."
      : "This is the agent's recorded summary. Use the checklist and diff to verify it.",
    remaining: review ? `${findings.length} unresolved findings in this review; ${review.unverifiedFindings} from earlier rounds awaiting verification.` : "Remaining work has not been reported in a review request.",
    problem: entry.problem,
    files,
    totalFiles: snapshot?.files.length ?? 0,
  };
}
