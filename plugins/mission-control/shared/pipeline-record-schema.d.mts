import type { z } from "zod";
export type PipelineCandidate = { head: string | null; tree: string };
export type PipelineCheckpoint = {
  schemaVersion: 1; id: string; taskId: string; runId: string; serverId: string; workspaceId: string;
  stage: "execute" | "fix" | "validate" | "review"; verdict: "pass" | "repair" | "blocked"; scope: "approved" | "needs_plan";
  agentId: string; implementationAgentId: string; candidate: PipelineCandidate; planRevision: string; createdAt: string; summary: string;
  evidence: { path: string; sha256: string; bytes: number }[];
};
export const candidateSchema: z.ZodType<PipelineCandidate>;
export const checkpointSchema: z.ZodType<PipelineCheckpoint>;
