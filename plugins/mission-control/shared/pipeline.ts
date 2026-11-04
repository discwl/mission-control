import { z } from "zod";
import { defineRpc } from "@getpaseo/plugin";
import { candidateSchema, checkpointSchema } from "./pipeline-record-schema.mjs";
import { pipelineSchema, workflowModeSchema, deliveryKindSchema } from "./pipeline-state";
import { fleetTaskSchema } from "./fleet";
import { resolvedPolicySchema } from "./agent-policy";
import { deliveryFeedbackSchema } from "./delivery-feedback";
export const pipelineInspectionSchema = z.object({
  version: z.literal(1), entry: fleetTaskSchema, candidate: candidateSchema.nullable(), planRevision: z.string().nullable(),
  checkpoints: z.array(checkpointSchema), problem: z.string().nullable(),
  agentPolicy: resolvedPolicySchema.nullable().optional(),
  deliveryFeedback: deliveryFeedbackSchema.nullable().optional(),
  workflowMode: workflowModeSchema.optional(), deliveryKind: deliveryKindSchema.optional(),
  submittedPlan: z.object({ revision: z.string(), scopeRevision: z.string(), plannerAgentId: z.string(), plannerModel: z.string(), policyRevision: z.string(), createdAt: z.string() }).nullable().optional(),
  actionBundle: z.object({ revision: z.string(), kind: z.enum(["actions", "report"]), summary: z.string(), createdAt: z.string() }).nullable().optional(),
  reportCompletion: z.object({ revision: z.string(), planRevision: z.string(), policyRevision: z.string(), completedAt: z.string() }).nullable().optional(),
  actionAuthorization: z.object({ phase: z.enum(["sent", "uncertain", "completed"]), bundleRevision: z.string() }).nullable().optional(),
  assignments: z.array(z.object({ assignmentId: z.string().optional(), requestId: z.string().optional(), agentId: z.string(), stage: z.string(), model: z.string(), createdAt: z.string() })).optional(),
});
export type PipelineInspection = z.infer<typeof pipelineInspectionSchema>;
export const pipelineCapabilities = defineRpc({ name: "pipeline.capabilities", input: z.object({ serverId: z.string() }), output: z.object({ serverId: z.string(), version: z.literal(1), idempotentIntake: z.literal(true), automaticWorkflow: z.literal(true).optional(), actionBundles: z.literal(true).optional() }) });
export const intakePipeline = defineRpc({ name: "pipeline.intake", input: z.object({ requestId: z.string().uuid(), coordinatorId: z.string(), remoteServerId: z.string(), workspaceId: z.string(), title: z.string().trim().min(1).max(200).regex(/^[^\r\n]+$/), acceptanceCriteria: z.string().trim().min(1).max(4000), workflowMode: workflowModeSchema.default("manual"), deliveryKind: deliveryKindSchema.default("code"), expectedRevision: z.number().int() }), output: pipelineSchema });
export const inspectPipeline = defineRpc({ name: "pipeline.inspect", input: z.object({ serverId: z.string(), workspaceId: z.string(), taskId: z.string(), workflowMode: workflowModeSchema.optional() }), output: pipelineInspectionSchema });
export const readPipelineEvidence = defineRpc({ name: "pipeline.evidence.read", input: inspectPipeline.input, output: pipelineInspectionSchema });
export const startPipeline = defineRpc({ name: "pipeline.start", input: z.object({ coordinatorId: z.string(), remoteServerId: z.string(), taskId: z.string(), workflowMode: workflowModeSchema.default("manual"), deliveryKind: deliveryKindSchema.default("code"), expectedRevision: z.number().int() }), output: pipelineSchema });
export const controlPipeline = defineRpc({ name: "pipeline.control", input: z.object({ id: z.string().uuid(), action: z.enum(["pause", "resume", "stop", "acknowledge", "adopt-automatic"]), expectedRevision: z.number().int(), requestId: z.string().optional(), delivery: z.enum(["sent", "not_sent"]).optional() }), output: pipelineSchema });
