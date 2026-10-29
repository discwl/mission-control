import type { z } from "zod";
import type { Execution } from "../shared/stage-evidence.mjs";
import type { PipelineCandidate } from "../shared/pipeline-record-schema.mjs";
export type StageAssignment = { id: string; taskId: string; runId: string; serverId: string; workspaceId: string; agentId: string; stage: "plan" | "execute" | "fix" | "validate" | "review"; execution: Execution; planRevision: string | null; candidate: PipelineCandidate | null; createdAt: string; reviewCount: 1 | 2; manifest: string | null; requestId?: string };
export const assignmentSchema: z.ZodType<StageAssignment>;
export function readStageJson(root: string, name: string): Promise<any>;
export function readStageAssignments(folder: string, identity: Record<string, string>): Promise<StageAssignment[]>;
export function checkpointStageEvidence(folder: string, identity: Record<string, unknown>, input: Record<string, any>, dependencies?: { verifyAgent: (assignment: StageAssignment) => Promise<unknown> }): Promise<Record<string, any>>;
