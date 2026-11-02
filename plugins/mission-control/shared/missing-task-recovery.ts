import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";
import { taskSchema } from "./tasks";

const digest = z.string().regex(/^[a-f0-9]{64}$/);
export const missingTaskInput = z.object({
  serverId: z.string().min(1), workspaceId: z.string().min(1), projectId: z.string().min(1),
  taskId: z.string().regex(/^task_[a-f0-9-]+$/), runId: z.string().regex(/^run_[a-f0-9-]+$/),
  backupContent: z.string().min(1).max(200_000), expectedBackupRevision: digest,
  provenanceContent: z.string().min(1).max(200_000), expectedProvenanceRevision: digest,
}).strict();
export type MissingTaskInput = z.infer<typeof missingTaskInput>;
export const missingTaskApplyInput = missingTaskInput.extend({
  expectedInspectionRevision: digest, confirmation: z.literal("restore-original-record"),
  actor: z.string().trim().min(1).max(300), reason: z.string().trim().min(1).max(2000),
  authorizationEvidence: z.string().trim().min(1).max(4000),
}).strict();
export const inspectMissingTask = defineRpc({
  name: "tasks.missing-record.inspect", input: missingTaskInput,
  output: z.object({ task: taskSchema, inspectionRevision: digest, backupRevision: digest,
    provenanceRevision: digest, targetAbsent: z.literal(true), runIds: z.array(z.string()) }),
});
export const restoreMissingTask = defineRpc({
  name: "tasks.missing-record.apply", input: missingTaskApplyInput,
  output: z.object({ applied: z.literal(true), task: taskSchema, revision: digest,
    inspectionRevision: digest, auditPath: z.string(), warnings: z.array(z.string()) }),
});
