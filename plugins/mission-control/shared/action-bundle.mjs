import { z } from "zod";

const text = z.string().trim().min(1).max(8000);
// Commands and script contents are immutable review material, never an execution API.
export const actionBundleSchema = z.object({
  kind: z.enum(["actions", "report"]),
  summary: z.string().trim().min(1).max(4000),
  environment: z.string().trim().min(1).max(1000),
  prerequisites: z.array(text).max(30),
  steps: z.array(z.object({ instruction: z.string().trim().min(1).max(32000), effect: text }).strict()).max(50),
  verification: z.array(text).min(1).max(30),
  rollback: text,
  report: z.string().max(100000).optional(),
}).strict().superRefine((bundle, ctx) => {
  if (bundle.kind === "actions" && !bundle.steps.length) ctx.addIssue({ code: "custom", path: ["steps"], message: "An action bundle must specify the exact actions." });
  if (bundle.kind === "report" && !bundle.report?.trim()) ctx.addIssue({ code: "custom", path: ["report"], message: "A report must contain its reviewed result." });
  if (bundle.kind === "report" && bundle.steps.length) ctx.addIssue({ code: "custom", path: ["steps"], message: "A read-only report cannot include actions to execute." });
});
export const actionIdentitySchema = z.object({
  taskId: z.string().regex(/^task_[a-f0-9-]+$/), runId: z.string().regex(/^run_[a-f0-9-]+$/),
  serverId: z.string().min(1), workspaceId: z.string().min(1),
}).strict();
export const actionSnapshotSchema = actionIdentitySchema.extend({
  schemaVersion: z.literal(1), projectId: z.string().min(1), planRevision: z.string().min(1), scopeRevision: z.string().regex(/^[a-f0-9]{64}$/),
  revision: z.string().regex(/^[a-f0-9]{64}$/), createdAt: z.string().datetime(), bundle: actionBundleSchema,
}).strict();
export const actionAuthorizationSchema = actionIdentitySchema.extend({
  schemaVersion: z.literal(1), revision: z.string().regex(/^[a-f0-9]{64}$/), fingerprint: z.string().regex(/^[a-f0-9]{64}$/),
  planRevision: z.string().min(1), policyRevision: z.string().min(1), actorId: z.string().min(1), authorizedAt: z.string().datetime(),
  agentId: z.string().min(1), resumeState: z.enum(["pending", "sending", "sent", "uncertain", "completed"]),
  completion: z.object({ completedAt: z.string().datetime(), summary: text, reconciledFrom: z.enum(["sending", "uncertain"]).optional(), evidence: z.array(z.object({ path: z.string().min(1), sha256: z.string().regex(/^[a-f0-9]{64}$/), bytes: z.number().int().positive() }).strict()).min(1).max(30) }).strict().optional(),
}).strict().superRefine((receipt, ctx) => {
  if ((receipt.resumeState === "completed") !== Boolean(receipt.completion)) ctx.addIssue({ code: "custom", path: ["completion"], message: "Completed actions require actual execution evidence." });
});
export const reportCompletionSchema = actionIdentitySchema.extend({
  schemaVersion: z.literal(1), revision: z.string().regex(/^[a-f0-9]{64}$/), fingerprint: z.string().regex(/^[a-f0-9]{64}$/),
  planRevision: z.string().min(1), policyRevision: z.string().min(1), completedAt: z.string().datetime(),
  checkpointDigest: z.string().regex(/^[a-f0-9]{64}$/), checkpointIds: z.array(z.string().uuid()).min(5),
}).strict();
