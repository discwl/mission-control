import { z } from "zod";
export const pipelineStageSchema = z.enum(["plan", "plan-review", "execute", "validate", "review", "fix", "approval", "delivery"]);
export const workflowSchema = z.enum(["standard", "advanced"]);
export const workflowModeSchema = z.enum(["manual", "automatic"]);
export const deliveryKindSchema = z.enum(["code", "actions", "report"]);
export const pipelineSchema = z.object({
  id: z.string().uuid(), coordinatorId: z.string(), remoteServerId: z.string(), taskId: z.string(), title: z.string().default("Task runner"),
  mode: z.enum(["running", "paused", "stopped", "waiting", "blocked", "ready", "done"]), stage: pipelineStageSchema,
  workflow: workflowSchema.optional(), workflowMode: workflowModeSchema.default("manual"), deliveryKind: deliveryKindSchema.default("code"),
  // Binds a fix runner to one recorded reopening of the task.
  reopenedAt: z.string().optional(),
  planRepairs: z.number().int().min(0).max(2).default(0), planRepairIds: z.array(z.string()).default([]),
  intake: z.object({ requestId: z.string().uuid(), workspaceId: z.string(), acceptanceCriteria: z.string().min(1).max(4000), phase: z.enum(["pending", "created"]) }).nullable().default(null),
  runId: z.string().nullable(), message: z.string(), updatedAt: z.string(), repairs: z.number().int().min(0).max(2), repairIds: z.array(z.string()),
  lastDispatch: z.string().nullable(), lastSentAt: z.string().nullable(), date: z.string(), wakeups: z.number().int().nonnegative(),
  pending: z.object({ requestId: z.string(), fingerprint: z.string(), stage: pipelineStageSchema, attemptedAt: z.string(),
    // Set before a managed stage start is sent to a host that keeps start receipts: every outcome (an answer, an error,
    // a restart on either side) is then read from the host's receipt instead of being guessed.
    launch: z.literal("awaiting").optional(),
    // The repair attempts this dispatch counts against, saved so a start confirmed in a later cycle still counts them.
    failureId: z.string().nullable().optional(), planFailureId: z.string().nullable().optional() }).nullable(),
  lastWorker: z.object({ agentId: z.string(), runId: z.string() }).nullable().default(null),
  // Set when an existing manual task switched to the automatic workflow: the runner itself records ownership, and these
  // earlier workers (builder, reviewers, helpers, including archived ones) no longer gate its stages.
  retiredWorkerIds: z.array(z.string()).optional(),
});
export type Pipeline = z.infer<typeof pipelineSchema>;

/** A stage start the runner is still following on its host: not something the user needs to check. */
export const isStartingStage = (row: Pick<Pipeline, "pending" | "mode">) =>
  row.pending?.launch === "awaiting" && ["running", "waiting", "ready", "paused"].includes(row.mode);
/** A dispatch whose outcome a person must check: an unconfirmed send, or a start the runner stopped following. */
export const needsDispatchCheck = (row: Pick<Pipeline, "pending" | "mode">) => Boolean(row.pending) && !isStartingStage(row);
