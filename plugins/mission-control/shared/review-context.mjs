import { z } from "zod";

const sha = z.string().regex(/^[a-f0-9]{40}$/);
// Reported provenance is deliberately separate from managed checkpoint verification.
// A coordinator can relay a review; neither its identity nor a prose report verifies the reviewer.
export const reviewContextSchema = z.object({
  baseCommit: sha,
  candidate: z.object({ head: sha.nullable(), tree: sha }).strict(),
  reviewers: z.array(z.object({
    agentId: z.string().uuid(),
    model: z.string().trim().min(1).max(200),
    report: z.string().trim().min(1).max(1000),
  }).strict()).min(1).max(2),
}).strict();

export function normalizeReviewContext(input, candidate, evidence) {
  if (input == null) return null;
  const context = reviewContextSchema.parse(input);
  if (!candidate || context.candidate.head !== candidate.head || context.candidate.tree !== candidate.tree) throw new Error("Reported review candidate does not match the current frozen candidate. Obtain a fresh review; do not relabel an older report.");
  if (new Set(context.reviewers.map(reviewer => reviewer.agentId)).size !== context.reviewers.length) throw new Error("Report each reviewer only once.");
  if (context.reviewers.some(reviewer => !evidence.includes(reviewer.report))) throw new Error("Each reported reviewer needs a report in this decision's evidence.");
  return context;
}
