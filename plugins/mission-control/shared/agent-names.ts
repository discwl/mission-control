import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";

/** The name Mission Control shows for an agent; the stale-name guard compares this. */
export function agentDisplayName(agent: { title?: string | null; provider: string }): string {
  return agent.title || `${agent.provider} agent`;
}

// Renames an agent on this installation's host only. Paseo's plugin API has no agent
// rename, so the server uses Paseo's internal DaemonClient (see server/agent-names.ts).
export const renameAgent = defineRpc({
  name: "agents.rename",
  input: z.object({
    serverId: z.string().min(1),
    agentId: z.string().min(1),
    // The name shown when the user reviewed it; the rename is refused if it changed since.
    expected: z.string(),
    name: z.string().trim().min(1).max(200),
  }),
  output: z.object({ title: z.string() }),
});
