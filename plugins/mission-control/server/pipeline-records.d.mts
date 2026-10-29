import type { z } from "zod";
import type { PipelineCandidate, PipelineCheckpoint } from "../shared/pipeline-record-schema.mjs";
export type { PipelineCandidate, PipelineCheckpoint } from "../shared/pipeline-record-schema.mjs";
export const candidateSchema: z.ZodType<PipelineCandidate>;
export const checkpointSchema: z.ZodType<PipelineCheckpoint>;
export function writePipelineCheckpoint(runFolder: string, identity: Pick<PipelineCheckpoint, "taskId" | "runId" | "serverId" | "workspaceId" | "agentId" | "implementationAgentId" | "candidate">, input: Record<string, unknown>): Promise<PipelineCheckpoint>;
export const preparePipelineCheckpoint: typeof writePipelineCheckpoint;
export function savePipelineCheckpoint(runFolder: string, checkpoint: PipelineCheckpoint): Promise<PipelineCheckpoint>;
export function readPipelineCheckpoints(runFolder: string, identity: Pick<PipelineCheckpoint, "taskId" | "runId" | "serverId" | "workspaceId">): Promise<PipelineCheckpoint[]>;
