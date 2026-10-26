import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";

// Stored on the orchestrator's daemon, keyed by both host and chat identity.
export const orchestratorOwnerSchema = z.object({
  serverId: z.string().min(1), agentId: z.string().min(1), remoteServerId: z.string().min(1),
});
export const orchestratorWorkSchema = orchestratorOwnerSchema.extend({
  remoteAgentId: z.string().min(1), remoteWorkspaceId: z.string().min(1),
  taskId: z.string().min(1).nullable(), linkedAt: z.string(),
});
export type OrchestratorOwner = z.infer<typeof orchestratorOwnerSchema>;
export type OrchestratorWork = z.infer<typeof orchestratorWorkSchema>;
export const listOrchestratorWork = defineRpc({
  name: "orchestrator.work.list", input: orchestratorOwnerSchema,
  output: z.object({ links: z.array(orchestratorWorkSchema) }),
});
export const setOrchestratorWork = defineRpc({
  name: "orchestrator.work.set",
  input: orchestratorWorkSchema.omit({ linkedAt: true }).extend({ linked: z.boolean() }),
  output: z.object({ links: z.array(orchestratorWorkSchema) }),
});

export function sameOwner(link: OrchestratorOwner, owner: OrchestratorOwner): boolean {
  return link.serverId === owner.serverId && link.agentId === owner.agentId && link.remoteServerId === owner.remoteServerId;
}
