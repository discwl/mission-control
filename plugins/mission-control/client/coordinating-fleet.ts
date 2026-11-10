import { readFleet, type FleetSnapshot } from "../shared/fleet";
import { startPipeline } from "../shared/pipeline";
import type { MissionControlCopy } from "./host-bridge";

/**
 * Where a task's new automatic runner can be started from:
 * - `copy: null`: this copy's own fleet (an orchestrator here manages the host, or nothing does: manual start);
 * - `copy`: another Mission Control copy in this app whose orchestrator manages the host (the coordinating computer).
 * `managed` says whether an orchestrator manages the host at all.
 */
export type CoordinatingFleet = { fleet: FleetSnapshot; copy: MissionControlCopy | null; managed: boolean };

const manages = (fleet: FleetSnapshot, serverId: string) => fleet.coordinators.some(item => item.remoteServerId === serverId);

/**
 * Finds the Mission Control copy whose orchestrator chats manage `serverId`. A host's own Tasks view is drawn by that
 * host's copy, which has no orchestrators: the coordinating computer's copy runs in the same app and answers through
 * the bridge. A coordinating computer's own tasks (it manages other hosts, not itself) keep the manual start.
 * A failed lookup is an error, never a silent fallback to the manual start.
 */
export async function findCoordinatingFleet(serverId: string, readLocal: () => Promise<FleetSnapshot>, copies: readonly MissionControlCopy[]): Promise<CoordinatingFleet> {
  const local = await readLocal();
  if (manages(local, serverId)) return { fleet: local, copy: null, managed: true };
  if (local.coordinators.length) return { fleet: local, copy: null, managed: false };
  const failures: string[] = [];
  for (const copy of copies) {
    if (copy.serverId === local.serverId || !copy.supports(readFleet.name) || !copy.supports(startPipeline.name)) continue;
    try {
      const fleet = readFleet.output.parse(await copy.rpc(readFleet.name, {}));
      if (manages(fleet, serverId)) return { fleet, copy, managed: true };
    } catch (error) { failures.push(`${copy.serverId}: ${error instanceof Error ? error.message : String(error)}`); }
  }
  if (failures.length) throw new Error(`Couldn't check whether an orchestrator manages this host (${failures.join("; ")}). Refresh to try again.`);
  return { fleet: local, copy: null, managed: false };
}
