import { defineRpc, defineSettings } from "@getpaseo/plugin";
import { z } from "zod";

export const agentsPanelId = "agents";

// Settings → Agents panel. Off by default: nothing opens until the user turns it on.
export const agentsPanelSettings = defineSettings({
  id: "agents-panel",
  scope: "host",
  version: 1,
  schema: z.object({ autoOpen: z.boolean().default(false) }),
});

export const MAX_CLAIM_BATCH = 1000;

// Records workspaces the Agents panel has opened for; returns the ones not opened before, so each opens once.
export const claimAgentsPanelWorkspaces = defineRpc({
  name: "agents-panel.auto-open.claim",
  input: z.object({ workspaceIds: z.array(z.string().min(1)).min(1).max(MAX_CLAIM_BATCH) }),
  output: z.object({ claimed: z.array(z.string()) }),
});

/** The candidates not opened before, each once, in order. */
export function unclaimedWorkspaces(opened: ReadonlySet<string>, candidates: readonly string[]): string[] {
  return [...new Set(candidates)].filter(id => !opened.has(id));
}

export const agentRunSchema = z.object({
  taskId: z.string(),
  stage: z.string(),
  outcome: z.string(),
  nextAction: z.string(),
  updatedAt: z.string(),
});
export type AgentRun = z.infer<typeof agentRunSchema>;

// Each agent's latest Dev Flow run on this Mission Control's host, for its "where it's at" line.
export const listAgentRuns = defineRpc({
  name: "agents-panel.runs",
  input: z.object({ serverId: z.string().min(1) }),
  output: z.object({ runs: z.record(z.string(), agentRunSchema) }),
});

/** The newest run per agent. */
export function latestRunByAgent(runs: readonly (AgentRun & { agentId: string | null })[]): Record<string, AgentRun> {
  const latest: Record<string, AgentRun> = {};
  for (const { agentId, ...run } of runs) {
    if (!agentId) continue;
    if (!latest[agentId] || latest[agentId].updatedAt < run.updatedAt) latest[agentId] = run;
  }
  return latest;
}
