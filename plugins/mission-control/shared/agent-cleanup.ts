import { defineRpc, defineSettings } from "@getpaseo/plugin";
import { z } from "zod";
import { trackedPullRequestSchema } from "./pull-request";

export const agentCleanupSettings = defineSettings({
  id: "agent-cleanup", scope: "host", version: 1,
  schema: z.object({
    deliveredDays: z.number().int().min(1).max(365).default(7),
    unlinkedDays: z.number().int().min(1).max(365).default(14),
  }),
});
export type CleanupPolicy = z.infer<typeof agentCleanupSettings.schema>;
export const cleanupScopeSchema = z.object({
  serverId: z.string().min(1), workspaceId: z.string().min(1), agentId: z.string().min(1).optional(),
});
export type CleanupScope = z.infer<typeof cleanupScopeSchema>;
export const cleanupRowSchema = z.object({
  agentId: z.string(), title: z.string(), disposition: z.enum(["eligible", "keep", "unknown"]),
  reason: z.string(), lastActivityAt: z.string().nullable(), activityBasis: z.enum(["conversation", "upper-bound"]),
  taskTitles: z.array(z.string()), archiveIds: z.array(z.string()), detachedIds: z.array(z.string()), untouchedIds: z.array(z.string()),
  manualOnly: z.boolean(),
});
export type CleanupRow = z.infer<typeof cleanupRowSchema>;
export const cleanupScanSchema = z.object({
  scanId: z.string(), serverId: z.string(), workspaceId: z.string(), scannedAt: z.string(), expiresAt: z.string(),
  policy: agentCleanupSettings.schema, rows: z.array(cleanupRowSchema), warnings: z.array(z.string()),
  mergedPullRequests: z.array(trackedPullRequestSchema),
});
export type CleanupScan = z.infer<typeof cleanupScanSchema>;
export const cleanupResultSchema = z.object({
  agentId: z.string(), title: z.string(), outcome: z.enum(["archived", "skipped", "failed"]), detail: z.string(), archivedIds: z.array(z.string()),
});
export type AgentCleanupResult = z.infer<typeof cleanupResultSchema>;
export const scanAgentCleanup = defineRpc({ name: "agents.cleanup.scan", input: cleanupScopeSchema, output: cleanupScanSchema });
export const archiveAgentCleanup = defineRpc({
  name: "agents.cleanup.archive",
  input: cleanupScopeSchema.extend({ scanId: z.string().min(1), agentIds: z.array(z.string().min(1)).min(1).max(100) }),
  output: z.object({ results: z.array(cleanupResultSchema) }),
});
export const cleanupHistorySchema = z.object({
  id: z.string(), at: z.string(), serverId: z.string(), workspaceId: z.string(), agentId: z.string(), title: z.string(),
  outcome: z.enum(["started", "archived", "skipped", "failed"]), detail: z.string(), archivedIds: z.array(z.string()),
});
export type CleanupHistory = z.infer<typeof cleanupHistorySchema>;
export const listAgentCleanupHistory = defineRpc({
  name: "agents.cleanup.history", input: z.object({ serverId: z.string().min(1), workspaceId: z.string().min(1) }),
  output: z.object({ entries: z.array(cleanupHistorySchema) }),
});
