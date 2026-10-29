import type { Pipeline } from "./pipeline-state";
import type { PipelineInspection } from "./pipeline";
import { modelIdentity } from "./agent-policy";
export function verifiedReviews(facts: PipelineInspection, since = "") {
  const policy = facts.agentPolicy;
  const implementers = new Set([facts.entry.run?.agentId, ...facts.checkpoints.filter(item => ["execute", "fix"].includes(item.stage)).map(item => item.agentId)]);
  return facts.checkpoints.filter(item => item.stage === "review" && item.createdAt >= since && item.runId === facts.entry.run?.runId && item.planRevision === facts.planRevision && item.candidate.head === facts.candidate?.head && item.candidate.tree === facts.candidate?.tree && !implementers.has(item.agentId) && (!policy || Boolean(item.ocr && item.execution && item.execution.policyRevision === policy.revision && policy.profiles.some(profile => profile.role === item.execution!.role && profile.id === item.execution!.profileId && profile.provider === item.execution!.provider && profile.model === item.execution!.model))));
}
export function missingReviewRole(facts: PipelineInspection, since = "") {
  const reviews = verifiedReviews(facts, since);
  for (const role of facts.agentPolicy?.reviewCount === 2 ? ["reviewer", "reviewer2"] : ["reviewer"]) if (!reviews.some(item => item.execution?.role === role)) return role;
  if (facts.agentPolicy?.reviewCount === 2) {
    const first = reviews.find(item => item.execution?.role === "reviewer")!; const second = reviews.find(item => item.execution?.role === "reviewer2")!;
    if (first.agentId === second.agentId || modelIdentity(first.execution!.model) === modelIdentity(second.execution!.model)) return "reviewer2";
  }
  return null;
}
export type PipelineStep = { stage: Pipeline["stage"]; mode: Pipeline["mode"]; message: string; dispatch: boolean; failureId?: string };
const step = (stage: PipelineStep["stage"], mode: PipelineStep["mode"], message: string, dispatch = false, failureId?: string): PipelineStep => ({ stage, mode, message, dispatch, ...(failureId ? { failureId } : {}) });
export function nextPipelineStep(pipeline: Pipeline, facts: PipelineInspection): PipelineStep {
  const { entry, candidate, planRevision } = facts; const run = entry.run;
  if (["closed", "delivered"].includes(entry.task.status) || entry.task.pullRequest) return step("delivery", "done", "Delivery is already recorded. Continue with the existing PR.");
  if (facts.problem || entry.problem) return step(pipeline.stage, "blocked", facts.problem || entry.problem!);
  if (entry.questions.some(item => item.question.status === "open")) return step(pipeline.stage, "waiting", "Answer the saved task question before work continues.");
  const decisions = entry.decisions.filter(item => !run || item.decision.runId === run.runId).sort((a, b) => b.decision.requestedAt.localeCompare(a.decision.requestedAt));
  const open = decisions.find(item => item.decision.status === "open");
  if (open) return step(open.decision.kind === "plan" ? "plan" : "approval", "waiting", open.decision.kind === "plan" ? "Read and approve the saved implementation plan, or request changes." : "Review the saved result and code, then accept or request changes.");
  if (decisions.some(item => item.decision.status === "blocked")) return step(pipeline.stage, "blocked", "You stopped this task. Resolve its saved decision before resuming.");
  const reviewDecision = decisions.find(item => item.decision.kind === "review");
  if (pipeline.stage === "delivery" && pipeline.mode === "ready" && (!run || !planRevision || !candidate || reviewDecision?.decision.status === "approved" && (reviewDecision.decision.candidate?.head !== candidate.head || reviewDecision.decision.candidate?.tree !== candidate.tree))) return step("delivery", "blocked", "Code or delivery state changed after the draft PR preview. Inspect the delivery result before resuming; no build or publication will be retried automatically.");
  if (!run || !planRevision) return step("plan", "running", "Prepare a readable plan and wait for your approval.", true);
  if (!candidate) return step(pipeline.stage, "blocked", "The current code revision could not be verified.");
  const current = facts.checkpoints.filter(item => item.runId === run.runId && item.planRevision === planRevision && item.candidate.head === candidate.head && item.candidate.tree === candidate.tree).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  const latest = current[0];
  const validatedAt = current.find(item => item.stage === "validate" && item.verdict === "pass")?.createdAt;
  if (facts.agentPolicy && validatedAt && verifiedReviews(facts, validatedAt).some(item => item.scope === "needs_plan")) return step("plan", "running", "A reviewer found that the required work exceeds the approved scope. Prepare a revised plan and wait for approval.", true);
  if (facts.agentPolicy && latest?.stage === "review" && latest.verdict !== "blocked" && validatedAt && missingReviewRole(facts, validatedAt)) return step("review", "running", "Complete the remaining independent model review before combining findings.", true);
  if (latest?.scope === "needs_plan") return step("plan", "running", "The required work exceeds the saved scope. Prepare a revised plan and wait for approval.", true);
  const failed = facts.agentPolicy && validatedAt ? verifiedReviews(facts, validatedAt).find(item => item.verdict !== "pass") ?? (latest && latest.verdict !== "pass" ? latest : null) : latest && latest.verdict !== "pass" ? latest : null;
  if (failed?.verdict === "blocked") return step(pipeline.stage, "blocked", failed.summary);
  const failureId = failed?.verdict === "repair" ? failed.id : reviewDecision?.decision.status === "changes_requested" && !pipeline.repairIds.includes(reviewDecision.decision.decisionId) ? reviewDecision.decision.decisionId : undefined;
  if (failureId) {
    if (pipeline.repairIds.includes(failureId)) return step("fix", "running", "Waiting for the dispatched repair and its new checkpoint.");
    if (pipeline.repairs >= 2) return step("fix", "blocked", "Two repair attempts are used. Inspect the findings and choose the next action.");
    return step("fix", "running", "Repair the recorded issues within the approved scope, then validate and review again.", true, failureId);
  }
  if (run.outcome === "blocked" || entry.task.status === "blocked") return step(pipeline.stage, "blocked", run.nextAction || "Inspect the recorded blocker.");
  const implementation = current.find(item => ["execute", "fix"].includes(item.stage) && item.verdict === "pass");
  if (!implementation) return step("execute", "running", "Implement the approved scope, or attest the existing implementation with fresh revision-bound evidence.", true);
  const validation = current.find(item => item.stage === "validate" && item.verdict === "pass" && item.createdAt >= implementation.createdAt);
  if (!validation) return step("validate", "running", "Run the project checks against this code revision and save the actual results.", true);
  const implementers = new Set([run.agentId, ...facts.checkpoints.filter(item => item.runId === run.runId && ["execute", "fix"].includes(item.stage)).map(item => item.agentId)].filter(Boolean));
  const review = current.find(item => item.stage === "review" && item.verdict === "pass" && item.createdAt >= validation.createdAt && !implementers.has(item.agentId));
  if (facts.agentPolicy && missingReviewRole(facts, validation.createdAt)) return step("review", "running", `Run ${facts.agentPolicy.reviewCount} independent OCR review${facts.agentPolicy.reviewCount === 2 ? "s with different models" : ""} on this revision.`, true);
  const managedReviews = verifiedReviews(facts, validation.createdAt);
  if (facts.agentPolicy && managedReviews.some(item => item.verdict !== "pass")) return step("review", "blocked", "Reviewers disagree or recorded unresolved findings. Inspect both reports before continuing.");
  if (!review) return step("review", "running", "Start a fresh independent reviewer for this exact revision and save its findings.", true);
  const accepted = reviewDecision?.decision.status === "approved" && reviewDecision.decision.candidate?.head === candidate.head && reviewDecision.decision.candidate?.tree === candidate.tree && (!facts.agentPolicy || managedReviews.every(item => reviewDecision.decision.requestedAt >= item.createdAt)) && (!reviewDecision.decision.resume || reviewDecision.decision.resume.phase === "sent");
  if (accepted) return step("delivery", "ready", "The code review is accepted. Prepare the exact draft PR preview; publication still needs your separate approval.");
  return step("review", "running", "Request your code review with the readable summary, checks, limitations and exact reviewed candidate.", true);
}
export function pipelineFingerprint(facts: PipelineInspection, next: PipelineStep): string {
  return JSON.stringify([facts.entry.task.taskId, facts.entry.run?.runId, facts.planRevision, facts.candidate, next.stage, next.failureId ?? null,
    facts.agentPolicy?.revision, facts.checkpoints.map(item => item.id), facts.entry.decisions.map(item => [item.decision.decisionId, item.decision.status, item.revision]), facts.entry.questions.map(item => [item.question.questionId, item.question.status])]);
}
