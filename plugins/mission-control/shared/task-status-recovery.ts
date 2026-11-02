import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";
import { taskSchema } from "./tasks";

const revision = z.string().regex(/^[a-f0-9]{64}$/);
export const statusRecoveryRef = z.object({
  serverId: z.string().min(1), workspaceId: z.string().min(1),
  projectId: z.string().min(1), taskId: z.string().regex(/^task_[a-f0-9-]+$/),
}).strict();
export const inspectTaskStatusRecovery = defineRpc({
  name: "tasks.status-recovery.inspect", input: statusRecoveryRef,
  output: z.object({ ...statusRecoveryRef.shape, revision, title: z.string(),
    recordedStatus: z.string(), recoverable: z.boolean() }),
});
export const statusRecoveryInput = statusRecoveryRef.extend({
  expectedRevision: revision, targetStatus: taskSchema.shape.status,
  // Caller declaration, not an authenticated identity or approval override.
  actor: z.string().trim().min(1).max(200),
  reason: z.string().trim().min(1).max(2000),
  authorizationEvidence: z.string().trim().min(1).max(2000),
}).strict();
export const recoverTaskStatus = defineRpc({
  name: "tasks.status-recovery.apply", input: statusRecoveryInput,
  output: z.object({ task: taskSchema, previousRevision: revision, revision,
    auditPath: z.string(), applied: z.literal(true), warnings: z.array(z.string()) }),
});
export type StatusRecoveryRef = z.infer<typeof statusRecoveryRef>;
export type StatusRecoveryInput = z.infer<typeof statusRecoveryInput>;
