import type { PaseoApi } from "@getpaseo/client";
import { hideCredentials } from "../shared/secret-mask";

type Parent = { serverId: string; agentId: string };
/** Remote parents are validated by the caller on the origin host before dispatch.
 * Never connect back to that host: native parent metadata supports one-way fleets.
 * Same-host callers can still validate the parent directly without a fleet connection.
 */
export async function requireLaunchParent(parent: Parent, paseo: PaseoApi) {
  if (!paseo.hosts?.client) throw new Error("Native worker parents require Paseo 0.13 or newer.");
  const handle = paseo.agents.ref(parent.agentId);
  if (handle.address.serverId !== parent.serverId) return;
  const agent = (await handle.refresh())?.agent;
  // A closed chat is resting (Paseo 0.14 releases idle agents); a worker's finish notice resumes it.
  if (!agent || agent.archivedAt) throw new Error("The orchestrator chat is unavailable.");
}
export async function probeLaunchParent(parent: Parent, paseo: PaseoApi) {
  try { await requireLaunchParent(parent, paseo); return { supported: true }; }
  catch (error) { return { supported: false, reason: hideCredentials(error instanceof Error ? error.message : String(error)) }; }
}
