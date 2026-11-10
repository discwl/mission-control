import type { Pipeline } from "./pipeline-state";
import type { PipelineInspection } from "./pipeline";
import { modelIdentity } from "./agent-policy";
const currentKind = (facts: PipelineInspection) => facts.deliveryKind ?? "code";
const sameCandidate = (item: PipelineInspection["checkpoints"][number], facts: PipelineInspection) => item.runId === facts.entry.run?.runId && item.planRevision === facts.planRevision && item.candidate.head === facts.candidate?.head && item.candidate.tree === facts.candidate?.tree && (item.deliveryKind ?? "code") === currentKind(facts);
const assignedExecution = (item: PipelineInspection["checkpoints"][number], facts: PipelineInspection, role?: string) => Boolean(item.execution && item.execution.policyRevision === facts.agentPolicy?.revision && (!role || item.execution.role === role) && facts.agentPolicy?.profiles.some(profile => profile.role === item.execution!.role && profile.id === item.execution!.profileId && profile.provider === item.execution!.provider && profile.model === item.execution!.model));
export function verifiedReviews(facts: PipelineInspection, since = "") {
  const policy = facts.agentPolicy;
  const implementers = new Set([facts.entry.run?.agentId, ...facts.checkpoints.filter(item => ["execute", "fix"].includes(item.stage)).map(item => item.agentId)]);
  return facts.checkpoints.filter(item => item.stage === "review" && item.createdAt >= since && afterDeliveryFeedback(item, facts) && sameCandidate(item, facts) && !implementers.has(item.agentId) && (!policy || Boolean((currentKind(facts) === "code" ? item.ocr : item.artifactReview?.revision === facts.candidate?.tree) && assignedExecution(item, facts) && ["reviewer", "reviewer2"].includes(item.execution!.role)))).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}
export function missingReviewRole(facts: PipelineInspection, since = "") {
  const reviews = verifiedReviews(facts, since);
  for (const role of facts.agentPolicy?.reviewCount === 2 ? ["reviewer", "reviewer2"] : ["reviewer"]) if (!reviews.some(item => item.execution?.role === role)) return role;
  if (facts.agentPolicy?.reviewCount === 2) {
    const first = reviews.find(item => item.execution?.role === "reviewer")!; const second = reviews.find(item => item.execution?.role === "reviewer2")!;
    if (first.agentId === second.agentId || modelIdentity(first.execution!.model) === modelIdentity(second.execution!.model) || facts.workflowMode === "automatic" && second.createdAt < first.createdAt) return "reviewer2";
  }
  return null;
}
export type PipelineStep = { stage: Pipeline["stage"]; mode: Pipeline["mode"]; message: string; dispatch: boolean; failureId?: string; planFailureId?: string };
const step = (stage: PipelineStep["stage"], mode: PipelineStep["mode"], message: string, dispatch = false, failureId?: string): PipelineStep => ({ stage, mode, message, dispatch, ...(failureId ? { failureId } : {}) });
function manualPipelineStep(pipeline: Pipeline, facts: PipelineInspection): PipelineStep {
  const { entry, candidate, planRevision } = facts; const run = entry.run;
  if (facts.workflowMode === "automatic") return step(pipeline.stage, "blocked", "This run uses automatic plan checking. Continue its automatic runner or explicitly start a new manual run; machine acceptance is not human approval.");
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
export function automaticPolicyProblem(facts: PipelineInspection): string | null {
  const policy = facts.agentPolicy;
  const planner = policy?.profiles.find(item => item.role === "planner");
  const critic = policy?.profiles.find(item => item.role === "planReviewer");
  const reviewers = ["reviewer", "reviewer2"].map(role => policy?.profiles.find(item => item.role === role));
  if (!policy || !planner || !critic || policy.reviewCount !== 2 || reviewers.some(item => !item)) return "Automatic workflow requires a planner, a plan checker and two configured review models.";
  if (modelIdentity(planner.model) === modelIdentity(critic.model)) return "The plan checker must use a different underlying model from the planner.";
  if (modelIdentity(reviewers[0]!.model) === modelIdentity(reviewers[1]!.model)) return "Automatic workflow requires two different underlying review models.";
  return null;
}
export function verifiedPlanReview(facts: PipelineInspection) {
  const plan = facts.submittedPlan;
  if (!plan || plan.revision !== facts.planRevision || plan.policyRevision !== facts.agentPolicy?.revision) return null;
  return facts.checkpoints.filter(item => item.stage === "plan-review" && item.runId === facts.entry.run?.runId && item.planRevision === plan.revision && item.createdAt >= plan.createdAt && item.agentId !== plan.plannerAgentId && item.execution && modelIdentity(item.execution.model) !== modelIdentity(plan.plannerModel) && item.planReview?.scopeRevision === plan.scopeRevision && item.candidate.head === null && item.candidate.tree === plan.revision && (item.deliveryKind ?? "code") === currentKind(facts) && assignedExecution(item, facts, "planReviewer")).sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0] ?? null;
}
function deliveryFeedbackProblem(facts: PipelineInspection): string | null {
  const request = facts.deliveryFeedback; if (!request) return null;
  const run = facts.entry.run;
  if (!run || request.taskId !== facts.entry.task.taskId || request.runId !== run.runId || request.serverId !== run.serverId || request.workspaceId !== run.workspaceId || request.planRevision !== facts.planRevision || request.scopeRevision !== facts.submittedPlan?.scopeRevision || request.policyRevision !== facts.agentPolicy?.revision) return "The final change request belongs to a different task scope, plan or policy. Reconcile it before continuing.";
  if (facts.actionAuthorization) return "A final change request conflicts with action authorization. Reconcile the existing execution before any further work.";
  return null;
}
function afterDeliveryFeedback(item: PipelineInspection["checkpoints"][number], facts: PipelineInspection): boolean {
  const request = facts.deliveryFeedback;
  return !request || item.createdAt > request.requestedAt && Boolean(facts.assignments?.some(assignment => assignment.assignmentId === item.execution?.assignmentId && assignment.agentId === item.agentId && assignment.createdAt > request.requestedAt));
}
function automaticEvidence(facts: PipelineInspection) {
  const current = facts.checkpoints.filter(item => sameCandidate(item, facts) && afterDeliveryFeedback(item, facts)).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  const implementation = current.find(item => ["execute", "fix"].includes(item.stage) && item.verdict === "pass" && item.scope === "approved" && assignedExecution(item, facts, "builder"));
  const validation = implementation && current.find(item => item.stage === "validate" && item.verdict === "pass" && item.scope === "approved" && item.createdAt >= implementation.createdAt && assignedExecution(item, facts, "validator"));
  const reviews = validation ? verifiedReviews(facts, validation.createdAt) : [];
  return { current, implementation, validation, reviews };
}
/** Machine evidence only; this never supplies human publication or action authorization. */
export function automaticDeliveryReadiness(facts: PipelineInspection): { ready: boolean; reason: string } {
  const refuse = (reason: string) => ({ ready: false, reason });
  if (facts.workflowMode !== "automatic") return refuse("This run has not adopted the automatic workflow.");
  if (facts.problem || facts.entry.problem) return refuse(facts.problem || facts.entry.problem!);
  if (!facts.entry.run || !facts.planRevision || !facts.candidate) return refuse("Current plan, run and candidate evidence are required.");
  if (facts.entry.run.outcome === "blocked" || facts.entry.task.status === "blocked") return refuse("Resolve the recorded task blocker first.");
  const decisions = facts.entry.decisions.filter(item => item.decision.runId === facts.entry.run!.runId).sort((a, b) => b.decision.requestedAt.localeCompare(a.decision.requestedAt));
  if (facts.entry.questions.some(item => item.question.status === "open") || decisions.some(item => item.decision.status === "open") || ["plan", "review"].some(kind => ["blocked", "changes_requested"].includes(decisions.find(item => item.decision.kind === kind)?.decision.status ?? ""))) return refuse("A saved human question or decision still needs resolution.");
  const policyProblem = automaticPolicyProblem(facts); if (policyProblem) return refuse(policyProblem);
  const feedbackProblem = deliveryFeedbackProblem(facts); if (feedbackProblem) return refuse(feedbackProblem);
  const plan = verifiedPlanReview(facts);
  if (!plan || plan.verdict !== "pass" || plan.scope !== "approved" || plan.planReview!.findings.length) return refuse("The current plan needs a passing independent check.");
  if (currentKind(facts) !== "code" && (!facts.actionBundle || facts.actionBundle.revision !== facts.candidate.tree || facts.actionBundle.kind !== currentKind(facts))) return refuse("The current action bundle must match the reviewed candidate.");
  const { validation, reviews } = automaticEvidence(facts);
  if (!validation) return refuse(facts.deliveryFeedback ? "Your final change request requires a fresh implementation and validation before both reviews run again." : "Current implementation and passing validation evidence are required.");
  if (missingReviewRole(facts, validation.createdAt) || reviews.some(item => item.verdict !== "pass" || item.scope !== "approved" || (item.ocr?.findings ?? item.artifactReview?.findings ?? []).length > 0)) return refuse("Two independent reviews must pass for the exact validated candidate.");
  return { ready: true, reason: currentKind(facts) === "code" ? "Validated implementation and both independent reviews passed. Ready for exact draft PR authorization." : currentKind(facts) === "report" ? "The report passed validation and both independent reviews. Ready to save the final report receipt." : "Prepared actions and both independent reviews passed. Ready for your final authorization." };
}
function automaticPipelineStep(pipeline: Pipeline, facts: PipelineInspection): PipelineStep {
  const { entry } = facts; const run = entry.run;
  if (["closed", "delivered"].includes(entry.task.status) || entry.task.pullRequest) return step("delivery", "done", "Delivery is already recorded.");
  if (facts.problem || entry.problem) return step(pipeline.stage, "blocked", facts.problem || entry.problem!);
  if (entry.questions.some(item => item.question.status === "open")) return step(pipeline.stage, "waiting", "Answer the saved task question before work continues.");
  const decisions = entry.decisions.filter(item => !run || item.decision.runId === run.runId).sort((a, b) => b.decision.requestedAt.localeCompare(a.decision.requestedAt));
  if (decisions.some(item => item.decision.status === "open")) return step(pipeline.stage, "waiting", "An existing human decision is still open. Resolve it explicitly; automatic workflow cannot approve it for you.");
  if (["plan", "review"].some(kind => ["blocked", "changes_requested"].includes(decisions.find(item => item.decision.kind === kind)?.decision.status ?? ""))) return step(pipeline.stage, "blocked", "Resolve the existing human stop or change request before continuing automatically.");
  if (currentKind(facts) === "report" && facts.reportCompletion?.revision === facts.candidate?.tree && facts.reportCompletion?.planRevision === facts.planRevision && facts.reportCompletion?.policyRevision === facts.agentPolicy?.revision && automaticDeliveryReadiness(facts).ready) return step("delivery", "done", "The validated report and both reviews are preserved in its verified completion receipt.");
  const feedbackProblem = deliveryFeedbackProblem(facts); if (feedbackProblem) return step(pipeline.stage, "blocked", feedbackProblem);
  if (facts.actionAuthorization) {
    if (facts.actionAuthorization.phase === "completed") return step("delivery", "done", "Actual authorized action execution is recorded with verified completion evidence.");
    if (facts.actionAuthorization.phase !== "sent") return step("delivery", "blocked", "Action authorization delivery is uncertain. Inspect the existing worker and receipt before any further action.");
    if (run?.outcome === "blocked" || entry.task.status === "blocked") return step("delivery", "blocked", run?.nextAction || "Authorized action execution is blocked. Inspect the existing worker's result before continuing; no action is replayed.");
    return step("delivery", "waiting", "Exact actions are authorized. Waiting for actual execution results from the existing worker; no action is replayed.");
  }
  const policyProblem = automaticPolicyProblem(facts); if (policyProblem) return step(pipeline.stage, "blocked", policyProblem);
  if (pipeline.stage === "delivery" && pipeline.mode === "ready" && !(facts.deliveryFeedback && !automaticEvidence(facts).implementation) && !automaticDeliveryReadiness(facts).ready) return step("delivery", "blocked", "The prepared delivery changed. Inspect its current evidence before resuming; no publication or action is retried automatically.");
  if (facts.workflowMode === "automatic" && currentKind(facts) !== pipeline.deliveryKind) return step(pipeline.stage, "blocked", "The recorded delivery kind differs from this runner. Inspect the workflow transition.");
  if (!run || !facts.planRevision || !facts.submittedPlan) return step("plan", "running", "Save a readable versioned plan for an independent model check.", true);
  const checked = verifiedPlanReview(facts);
  if (!checked) return step("plan-review", "running", "Independently check the saved plan for concrete gaps and unnecessary scope. Passing a sufficient plan is expected.", true);
  if (checked.scope === "needs_plan" || checked.verdict === "blocked" || checked.verdict === "pass" && checked.planReview!.findings.length) return step("plan-review", "blocked", checked.summary);
  if (checked.verdict === "repair") {
    if (pipeline.planRepairIds.includes(checked.id)) return step("plan", "running", "Waiting for the planner's revised plan submission.");
    if (pipeline.planRepairs >= 2) return step("plan-review", "blocked", "Two plan repair attempts are used. Resolve the remaining concrete issue before continuing.");
    return { ...step("plan", "running", "Repair the concrete plan findings within the task's existing scope, then submit a new version for independent checking.", true), planFailureId: checked.id };
  }
  if (!facts.candidate || currentKind(facts) !== "code" && !facts.actionBundle) return step(currentKind(facts) === "code" ? pipeline.stage : "execute", currentKind(facts) === "code" ? "blocked" : "running", "Prepare the exact implementation or action bundle and save its evidence.", currentKind(facts) !== "code");
  if (run.outcome === "blocked" || entry.task.status === "blocked") return step(pipeline.stage, "blocked", run.nextAction || "Inspect the recorded blocker.");
  const { current, implementation, validation, reviews } = automaticEvidence(facts);
  const latest = current.find(item => item.stage !== "plan-review");
  if (reviews.some(item => item.scope === "needs_plan") || latest?.scope === "needs_plan") return step(pipeline.stage, "blocked", "The required work changes the task scope. Ask the user the specific scope question before continuing.");
  if (latest?.verdict === "blocked" || reviews.some(item => item.verdict === "blocked")) return step(pipeline.stage, "blocked", reviews.find(item => item.verdict === "blocked")?.summary ?? latest!.summary);
  if (validation && latest?.stage === "review" && missingReviewRole(facts, validation.createdAt)) return step("review", "running", "Complete the second independent model review before combining findings.", true);
  const failed = reviews.find(item => item.verdict === "repair") ?? (latest?.verdict === "repair" ? latest : null);
  if (failed) {
    if (pipeline.repairIds.includes(failed.id)) return step("fix", "running", "Waiting for the dispatched repair and its new evidence.");
    if (pipeline.repairs >= 2) return step("fix", "blocked", "Two repair attempts are used. Resolve the remaining concrete issue before continuing.");
    return step("fix", "running", "Repair substantiated findings, validate the changed candidate and obtain both independent reviews again.", true, failed.id);
  }
  if (!implementation && facts.deliveryFeedback) {
    const request = facts.deliveryFeedback;
    if (pipeline.repairIds.includes(request.id)) return step("fix", "running", "Your requested fixes were dispatched. Waiting for new implementation evidence, validation and both reviews.");
    if (pipeline.repairs >= 2) return step("fix", "blocked", "Your change request is saved and publication is blocked. Both repair attempts are used; resolve the remaining issue explicitly before continuing.");
    return step("fix", "running", "Address the user's final change request within the checked plan. Save fresh implementation evidence, then repeat validation and both independent reviews.", true, request.id);
  }
  if (!implementation) return step("execute", "running", currentKind(facts) === "code" ? "Implement the independently checked plan and record actual evidence." : "Prepare the reviewed plan's exact scripts or actions. External mutations wait for final authorization.", true);
  if (!validation) return step("validate", "running", "Run the relevant permitted checks or safe dry runs and save actual results for this candidate.", true);
  if (missingReviewRole(facts, validation.createdAt)) return step("review", "running", "Run both independent reviews with different models on the exact validated candidate.", true);
  const readiness = automaticDeliveryReadiness(facts);
  return step("delivery", readiness.ready ? "ready" : "blocked", readiness.reason);
}
/** Automatic code work always happens in the task's own worktree: draft PRs are published from its branch. */
export const sharedCheckoutMessage = "This task's run works in the shared project checkout, so it can't publish a draft PR from there. Finish it on the old flow, or close it and start a new automatic task.";
export function nextPipelineStep(pipeline: Pipeline, facts: PipelineInspection): PipelineStep {
  return pipeline.workflowMode === "automatic" ? automaticPipelineStep(pipeline, facts) : manualPipelineStep(pipeline, facts);
}
export function pipelineFingerprint(facts: PipelineInspection, next: PipelineStep): string {
  return JSON.stringify([facts.entry.task.taskId, facts.entry.run?.runId, facts.planRevision, facts.candidate, next.stage, next.failureId ?? null, next.planFailureId ?? null, facts.workflowMode ?? "manual", facts.deliveryKind ?? "code", facts.submittedPlan,
    facts.agentPolicy?.revision, facts.deliveryFeedback ?? null, facts.checkpoints.map(item => item.id), facts.entry.decisions.map(item => [item.decision.decisionId, item.decision.status, item.revision]), facts.entry.questions.map(item => [item.question.questionId, item.question.status])]);
}
