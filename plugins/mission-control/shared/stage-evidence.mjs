import { z } from "zod";

export const executionSchema = z.object({
  assignmentId: z.string().uuid(), policyRevision: z.string().min(1),
  role: z.enum(["planner", "builder", "validator", "reviewer", "reviewer2"]),
  profileId: z.string().min(1), profileName: z.string().min(1), provider: z.string().min(1), model: z.string().min(1),
});
export const coverageSchema = z.array(z.object({ path: z.string().min(1), status: z.string().min(1), outcome: z.enum(["reviewed", "skipped"]), reason: z.string().default("") })).max(5000);
export const reviewFindingSchema = z.object({ title: z.string().min(1).max(300), severity: z.enum(["high", "medium", "low"]), detail: z.string().min(1).max(4000), file: z.string().max(500).nullable().default(null) });
export const ocrEvidenceSchema = z.object({
  manifest: z.string().min(1), coverage: coverageSchema, excluded: z.number().int().nonnegative(),
  findings: z.array(reviewFindingSchema).max(50),
});

export function verifyCoverage(files, coverage, passing) {
  const key = item => JSON.stringify([item.path, item.status]);
  const expected = new Set(files.map(key)); const seen = new Set();
  for (const item of coverage) {
    const id = key(item);
    if (!expected.has(id) || seen.has(id)) throw new Error("OCR coverage contains an unexpected or duplicate file/status entry.");
    if (item.outcome === "skipped" && !item.reason.trim()) throw new Error("Skipped files need a concrete reason.");
    seen.add(id);
  }
  if (seen.size !== expected.size) throw new Error("OCR coverage must account for every selected file and status.");
  if (passing && coverage.some(item => item.outcome !== "reviewed")) throw new Error("A passing review cannot have skipped reviewable files.");
}

// Only exact duplicates collapse. Different explanations/severities remain visible; one model cannot erase another's concern.
export function combineReviewFindings(reviews) {
  const found = new Map();
  for (const review of reviews) for (const item of review.ocr?.findings ?? []) {
    const key = JSON.stringify([item.file, item.title.trim().toLowerCase(), item.detail.trim(), item.severity]);
    const prior = found.get(key);
    const author = { agentId: review.agentId, model: review.execution?.model ?? "unknown" };
    if (prior) prior.reviewers.push(author); else found.set(key, { ...item, reviewers: [author] });
  }
  return [...found.values()];
}
