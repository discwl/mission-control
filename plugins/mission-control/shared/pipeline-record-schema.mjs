import { z } from "zod";
import { executionSchema, ocrEvidenceSchema, planReviewEvidenceSchema, artifactReviewEvidenceSchema } from "./stage-evidence.mjs";
export const candidateSchema = z.object({ head: z.string().regex(/^[a-f0-9]{40,64}$/).nullable(), tree: z.string().regex(/^[a-f0-9]{40,64}$/) });
export const checkpointSchema = z.object({
  schemaVersion: z.literal(1), id: z.string().uuid(), taskId: z.string(), runId: z.string(), serverId: z.string(), workspaceId: z.string(),
  stage: z.enum(["plan-review", "execute", "fix", "validate", "review"]), verdict: z.enum(["pass", "repair", "blocked"]), scope: z.enum(["approved", "needs_plan"]),
  deliveryKind: z.enum(["code", "actions", "report"]).default("code"),
  agentId: z.string().min(1), implementationAgentId: z.string().min(1), candidate: candidateSchema,
  planRevision: z.string().regex(/^[a-f0-9]{64}$/), createdAt: z.string().datetime(), summary: z.string().trim().min(1).max(800),
  evidence: z.array(z.object({ path: z.string().min(1), sha256: z.string().regex(/^[a-f0-9]{64}$/), bytes: z.number().int().min(1).max(5_000_000) })).min(1).max(10),
  execution: executionSchema.optional(), ocr: ocrEvidenceSchema.optional(),
  planReview: planReviewEvidenceSchema.optional(), artifactReview: artifactReviewEvidenceSchema.optional(),
});
