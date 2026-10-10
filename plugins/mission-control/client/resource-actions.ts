import type { getPaseoClient } from "@getpaseo/plugin/client";

export type ResourceTarget = {
  kind: "workspace" | "agent" | "terminal";
  id: string;
  serverId: string;
  hostLabel: string;
  name: string;
  workspaceId?: string;
};

export async function performResourceAction(paseo: ReturnType<typeof getPaseoClient>, target: ResourceTarget): Promise<void> {
  if (target.kind === "workspace") {
    const result = await paseo.workspaces.ref(target.id).archive();
    // The SDK can resolve with an error or with no archive timestamp.
    if (result.error || !result.archivedAt) throw new Error(result.error || "Paseo did not confirm that this workspace was archived.");
  } else if (target.kind === "agent") {
    const result = await paseo.agents.ref(target.id).archive();
    if (!result.archivedAt) throw new Error("Paseo did not confirm that this agent was archived.");
  } else {
    await paseo.terminals.ref(target.id).kill();
  }
}
