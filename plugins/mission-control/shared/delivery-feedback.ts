import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";
const candidate = z.object({ head: z.string().regex(/^[a-f0-9]{40}$/).nullable(), tree: z.string().regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/) });
const identity = z.object({ serverId: z.string().min(1), workspaceId: z.string().min(1), taskId: z.string().regex(/^task_[a-f0-9-]+$/), runId: z.string().regex(/^run_[a-f0-9-]+$/) });
export const deliveryFeedbackSchema = identity.extend({ schemaVersion: z.literal(1), id: z.string().uuid(), candidate, planRevision: z.string().min(1), policyRevision: z.string().min(1), scopeRevision: z.string().regex(/^[a-f0-9]{64}$/), reviewFingerprint: z.string().min(1).optional(), note: z.string().trim().min(1).max(8000), requestedAt: z.string().datetime(), requestedBy: z.string().min(1) }).strict();
export type DeliveryFeedback = z.infer<typeof deliveryFeedbackSchema>;
// Human UI/native connector only. Draft annotations never call this contract implicitly.
export const finalReviewChanges = defineRpc({ name: "delivery.request-changes", input: identity.extend({ requestId: z.string().uuid(), expectedCandidate: candidate, expectedPlanRevision: z.string().min(1), expectedReviewFingerprint: z.string().min(1).optional(), note: z.string().trim().min(1).max(8000), actorId: z.string().min(1) }).strict(), output: deliveryFeedbackSchema });
