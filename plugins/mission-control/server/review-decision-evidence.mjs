import { readStageAssignments } from "./stage-records.mjs";
import { readPipelineCheckpoints } from "./pipeline-records.mjs";
import { combineReviewFindings } from "../shared/stage-evidence.mjs";
import { verifyNativeStageAgent } from "./native-stage-identity.mjs";

/** Legacy decisions retain their history. A run with managed assignments must present all assigned reviews. */
export async function verifyManagedReviewDecision(folder, identity, candidate, proposedFindings, approvedPlanRevision, { verifyAgent = verifyNativeStageAgent } = {}) {
  const assignments = await readStageAssignments(folder, identity);
  if (!assignments.length) return null;
  const latest = assignments[0];
  const revision = await approvedPlanRevision?.();
  if (!revision || revision !== latest.planRevision) throw new Error("Managed review evidence must match the currently approved saved plan.");
  const checkpoints = await readPipelineCheckpoints(folder, identity);
  const implementers = new Set(assignments.filter(item => ["execute", "fix"].includes(item.stage)).map(item => item.agentId));
  const validation = checkpoints.find(item => item.stage === "validate" && item.verdict === "pass" && item.scope === "approved" && item.planRevision === revision && item.candidate.head === candidate.head && item.candidate.tree === candidate.tree);
  if (!validation) throw new Error("Validate the current code before requesting its human review.");
  const reviews = [];
  for (const role of latest.reviewCount === 2 ? ["reviewer", "reviewer2"] : ["reviewer"]) {
    const assigned = assignments.find(item => item.stage === "review" && item.execution.role === role && item.execution.policyRevision === latest.execution.policyRevision && item.planRevision === latest.planRevision && item.candidate?.head === candidate.head && item.candidate?.tree === candidate.tree);
    const review = assigned && checkpoints.find(item => item.execution?.assignmentId === assigned.id && item.agentId === assigned.agentId && item.stage === "review" && item.scope === "approved" && item.createdAt >= validation.createdAt && item.ocr && item.verdict !== "blocked" && item.planRevision === revision && item.candidate.head === candidate.head && item.candidate.tree === candidate.tree && !implementers.has(item.agentId));
    if (!review) throw new Error(`The ${role} has not completed a verified OCR review of this candidate.`);
    await verifyAgent(assigned);
    reviews.push(review);
  }
  const modelKey = model => model.toLowerCase().split("/").at(-1).replace(/[._-]/g, "").replace(/(?:latest|\d{8})$/, "");
  if (reviews.length === 2 && (reviews[0].agentId === reviews[1].agentId || modelKey(reviews[0].execution.model) === modelKey(reviews[1].execution.model))) throw new Error("Two-model review needs distinct agents and models.");
  const combined = combineReviewFindings(reviews);
  if (combined.some(item => !proposedFindings.some(proposed => proposed.title.trim() === item.title.trim() && proposed.detail.trim() === item.detail.trim() && proposed.file === item.file && proposed.severity === item.severity))) throw new Error("Keep every reviewer's unresolved findings in the human review decision. Duplicate findings may be combined, but disagreements cannot be omitted.");
  return { reviewers: reviews.map(item => ({ agentId: item.agentId, model: item.execution.model, profile: item.execution.profileName, checkpointId: item.id, reviewed: item.ocr.coverage.filter(file => file.outcome === "reviewed").length, selected: item.ocr.coverage.length, excluded: item.ocr.excluded })), findings: combined.length };
}
