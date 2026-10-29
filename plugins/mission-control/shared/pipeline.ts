import { z } from "zod";
import { defineRpc } from "@getpaseo/plugin";
import { candidateSchema, checkpointSchema } from "./pipeline-record-schema.mjs";
import { pipelineSchema } from "./pipeline-state";
import { fleetTaskSchema } from "./fleet";
import { resolvedPolicySchema } from "./agent-policy";
export const pipelineInspectionSchema = z.object({
  version: z.literal(1), entry: fleetTaskSchema, candidate: candidateSchema.nullable(), planRevision: z.string().nullable(),
  checkpoints: z.array(checkpointSchema), problem: z.string().nullable(),
  agentPolicy: resolvedPolicySchema.nullable().optional(),
  assignments: z.array(z.object({ requestId: z.string().optional(), agentId: z.string(), stage: z.string(), model: z.string(), createdAt: z.string() })).optional(),
});
export type PipelineInspection = z.infer<typeof pipelineInspectionSchema>;
export const pipelineCapabilities = defineRpc({ name: "pipeline.capabilities", input: z.object({ serverId: z.string() }), output: z.object({ serverId: z.string(), version: z.literal(1), idempotentIntake: z.literal(true) }) });
export const intakePipeline = defineRpc({ name: "pipeline.intake", input: z.object({ requestId: z.string().uuid(), coordinatorId: z.string(), remoteServerId: z.string(), workspaceId: z.string(), title: z.string().trim().min(1).max(200).regex(/^[^\r\n]+$/), acceptanceCriteria: z.string().trim().min(1).max(4000), expectedRevision: z.number().int() }), output: pipelineSchema });
export const inspectPipeline = defineRpc({ name: "pipeline.inspect", input: z.object({ serverId: z.string(), workspaceId: z.string(), taskId: z.string() }), output: pipelineInspectionSchema });
export const readPipelineEvidence = defineRpc({ name: "pipeline.evidence.read", input: inspectPipeline.input, output: pipelineInspectionSchema });
export const startPipeline = defineRpc({ name: "pipeline.start", input: z.object({ coordinatorId: z.string(), remoteServerId: z.string(), taskId: z.string(), expectedRevision: z.number().int() }), output: pipelineSchema });
export const controlPipeline = defineRpc({ name: "pipeline.control", input: z.object({ id: z.string().uuid(), action: z.enum(["pause", "resume", "stop", "acknowledge"]), expectedRevision: z.number().int(), requestId: z.string().optional(), delivery: z.enum(["sent", "not_sent"]).optional() }), output: pipelineSchema });
