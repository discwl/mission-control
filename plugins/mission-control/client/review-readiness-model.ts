import type { FleetTask } from "../shared/fleet";
import type { ReviewSnapshot } from "../shared/review";
import type { FlowEvent } from "./task-flow-model";

export type ReadinessItem = { id: string; label: string; status: "available" | "recorded" | "missing" | "stale" | "unknown" | "needs you"; detail: string; document?: string };
export function reviewReadiness(entry: FleetTask, snapshot: ReviewSnapshot | null, events: readonly FlowEvent[], unavailable: boolean, snapshotStale: boolean): ReadinessItem[] {
  const ordered = events.filter(event => event.taskId === entry.task.taskId).sort((a, b) => Date.parse(b.at) - Date.parse(a.at));
  const validation = ordered.find(event => event.stage === "validate");
  const review = ordered.find(event => event.stage === "review");
  const implementation = ordered.find(event => ["execute", "fix"].includes(event.stage));
  function recorded(event: FlowEvent | undefined, label: string): ReadinessItem {
    if (unavailable) return { id: label, label, status: "unknown", detail: "Current evidence could not be loaded." };
    if (!event) return { id: label, label, status: "missing", detail: "No matching update was returned in the recent evidence." };
    const changedAfter = implementation && Date.parse(implementation.at) > Date.parse(event.at);
    const oldHead = Boolean(snapshot?.head && event.gitHead && snapshot.head !== event.gitHead);
    const status = snapshotStale || changedAfter || oldHead ? "stale" : event.outcome === "completed" ? "recorded" : "needs you";
    const revision = event.gitHead ? `commit ${event.gitHead.slice(0, 8)}` : "revision not recorded";
    return { id: label, label, status, document: event.source,
      detail: status === "stale" ? `Recorded evidence predates the displayed code or a later implementation update (${revision}).`
        : `Recorded ${event.outcome.replaceAll("_", " ")} on ${revision}${event.gitDirty ? " with working changes" : ""}. ${event.gitDirty || !event.gitHead ? "Exact working-file contents are not verified." : "Matching commit alone does not verify current working changes."}` };
  }
  const reviewItem = recorded(review, "Independent review");
  if (reviewItem.status === "recorded") {
    const implementer = ordered.find(event => ["execute", "fix"].includes(event.stage) && Date.parse(event.at) <= Date.parse(review!.at))?.agentId;
    if (!review?.agentId || !implementer || review.agentId === implementer) {
      reviewItem.status = "unknown";
      reviewItem.detail += " A separate reviewer is not established by these records.";
    } else reviewItem.detail += " The recorded reviewer differs from the implementer.";
  }
  const findings = new Map(entry.decisions.flatMap(item => [...item.findings, ...item.resolvedFindings]).map(finding => [finding.findingId, finding]));
  const unresolved = [...findings.values()].filter(finding => ["open", "submitted", "awaiting_verification"].includes(finding.status));
  const unverified = Math.max(0, ...entry.decisions.map(item => item.unverifiedFindings));
  const reviewDecision = [...entry.decisions].filter(item => item.decision.kind === "review").sort((a, b) => Date.parse(b.decision.requestedAt) - Date.parse(a.decision.requestedAt))[0];
  return [
    { id: "criteria", label: "Acceptance criteria", status: entry.task.acceptanceCriteria.trim() ? "available" : "missing", detail: entry.task.acceptanceCriteria.trim() || "No acceptance criteria recorded." },
    recorded(validation, "Validation"), reviewItem,
    { id: "findings", label: "Unresolved findings", status: unavailable || !reviewDecision ? "unknown" : unresolved.length || unverified ? "needs you" : "recorded", detail: unavailable || !reviewDecision ? "Current findings are not established by the returned review decisions." : `${unresolved.length} unresolved findings visible; ${unverified} earlier fixes awaiting verification. Zero here does not replace reading the full review.`, document: reviewDecision?.decision.evidence[0] },
    { id: "revision", label: "Displayed revision", status: snapshotStale ? "stale" : snapshot ? "available" : "unknown", detail: snapshot ? `${snapshot.head ? `Commit ${snapshot.head.slice(0, 12)}` : "No commit"} · snapshot ${snapshot.fingerprint.slice(0, 12)}${snapshotStale ? ". Workspace changed or cannot be checked; refresh before deciding." : ". Includes the selected review scope."}` : "Waiting for a review snapshot." },
  ];
}
