import { z } from "zod";
export const pipelineStageSchema = z.enum(["plan", "execute", "validate", "review", "fix", "approval", "delivery"]);
export const pipelineSchema = z.object({
  id: z.string().uuid(), coordinatorId: z.string(), remoteServerId: z.string(), taskId: z.string(), title: z.string().default("Task runner"),
  mode: z.enum(["running", "paused", "stopped", "waiting", "blocked", "ready", "done"]), stage: pipelineStageSchema,
  intake: z.object({ requestId: z.string().uuid(), workspaceId: z.string(), acceptanceCriteria: z.string().min(1).max(4000), phase: z.enum(["pending", "created"]) }).nullable().default(null),
  runId: z.string().nullable(), message: z.string(), updatedAt: z.string(), repairs: z.number().int().min(0).max(2), repairIds: z.array(z.string()),
  lastDispatch: z.string().nullable(), lastSentAt: z.string().nullable(), date: z.string(), wakeups: z.number().int().nonnegative(),
  pending: z.object({ requestId: z.string(), fingerprint: z.string(), stage: pipelineStageSchema, attemptedAt: z.string() }).nullable(),
});
export type Pipeline = z.infer<typeof pipelineSchema>;
