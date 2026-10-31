import type { FleetTask } from "../shared/fleet";
import type { ReviewSnapshot } from "../shared/review";
import type { FlowEvent } from "./task-flow-model";

/** Only evidence belonging to this task's owning host, workspace and current run is eligible. */
export function reviewReportModel(entry: FleetTask, serverId: string, workspaceId: string, snapshot: ReviewSnapshot | null, stale: boolean, events: readonly FlowEvent[] = []) {
  const run = entry.run;
  const ownsRun = !!run && run.taskId === entry.task.taskId && run.serverId === serverId && run.workspaceId === workspaceId;
  const reviews = ownsRun ? entry.decisions.filter(({ decision: d }) => d.kind === "review" && d.taskId === entry.task.taskId && d.runId === run.runId && d.serverId === serverId && d.workspaceId === workspaceId && Number.isFinite(Date.parse(d.requestedAt))).sort((a, b) => Date.parse(b.decision.requestedAt) - Date.parse(a.decision.requestedAt)) : [];
  const review = reviews[0] ?? null;
  const scopedEvents = ownsRun ? events.filter(event => event.taskId === entry.task.taskId && event.runId === run.runId && (!event.serverId || event.serverId === serverId) && (!event.workspaceId || event.workspaceId === workspaceId)).sort((a, b) => Date.parse(b.at) - Date.parse(a.at)) : [];
  const validation = scopedEvents.find(event => event.stage === "validate") ?? null;
  const implementation = scopedEvents.find(event => event.stage === "execute" || event.stage === "fix");
  const mismatch = !!review && !!snapshot && review.decision.gitHead !== snapshot.head;
  const changedAfter = !!review && !!implementation && Date.parse(implementation.at) > Date.parse(review.decision.requestedAt);
  const validationStale = stale || !snapshot || !!validation && (validation.gitHead !== snapshot.head || !!implementation && Date.parse(implementation.at) > Date.parse(validation.at));
  const rank = { high: 0, medium: 1, low: 2 };
  const unresolved = (status: string) => status !== "resolved" && status !== "dismissed";
  const findings = review ? [...review.findings].filter(f => f.decisionId === review.decision.decisionId).sort((a, b) => Number(unresolved(b.status)) - Number(unresolved(a.status)) || rank[a.severity] - rank[b.severity]) : [];
  return {
    review, findings, validation, validationStale,
    canDecide: !!review && review.decision.status === "open" && !!snapshot && !stale && !mismatch && !changedAfter,
    warning: !review ? "No saved review request matches this task's current run and workspace. Ask the worker to record its review before deciding."
      : stale || mismatch || changedAfter ? "This review is out of date or the current code cannot be verified. Refresh the evidence or ask for a fresh review before deciding."
      : !snapshot ? "Waiting for the current code snapshot. Review decisions are unavailable until it loads."
      : "These are saved review results. Matching commits alone do not verify working-file contents; accepting code checks the exact candidate again on the owning host.",
  };
}

export function findingDiffPath(file: string | null, snapshot: ReviewSnapshot | null): string | null {
  if (!file || !snapshot) return null;
  const path = file.replaceAll("\\", "/").replace(/^\.\//, "").replace(/(?::\d+(?::\d+)?|#L\d+(?:-L?\d+)?)$/, "");
  return snapshot.files.some(item => item.path === path) ? path : null;
}
