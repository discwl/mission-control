import { isDeepStrictEqual } from "node:util";
import type { PaseoApi, PaseoAgent } from "@getpaseo/client";
import type { ResolvedProfile } from "../shared/agent-policy";
import { withFleetConnection } from "./fleet-transport";

function matchesSettings(agent: PaseoAgent, profile: ResolvedProfile) {
  return agent.model === profile.model && agent.provider === profile.provider
    && (!profile.modeId || agent.currentModeId === profile.modeId)
    && (!profile.thinkingOptionId || (agent.effectiveThinkingOptionId ?? agent.thinkingOptionId) === profile.thinkingOptionId)
    && Object.entries(profile.featureValues ?? {}).every(([key, value]) => isDeepStrictEqual(agent.features?.find(feature => feature.id === key)?.value, value));
}

/** Reuse only an idle, verified planner. A new builder can pick up its saved plan on any provider. */
export async function transitionPlanner(paseo: PaseoApi, agentId: string, workspaceId: string, planner: ResolvedProfile, builder: ResolvedProfile,
  beforeSwitch: () => Promise<void>) {
  const ref = paseo.agents.ref(agentId);
  const before = (await ref.refresh())?.agent;
  if (!before || before.archivedAt || before.workspaceId !== workspaceId || before.provider !== planner.provider || before.model !== planner.model) throw new Error("The submitted plan's worker identity changed before implementation.");
  if (before.activeTurn || ["running", "initializing"].includes(before.status) || before.pendingPermissions?.length) throw new Error("The planner is still working or awaiting permission.");
  if (planner.provider !== builder.provider || planner.modeId !== builder.modeId || !isDeepStrictEqual(planner.featureValues ?? {}, builder.featureValues ?? {}) || !matchesSettings(before, planner)) return null;
  const effortChanged = planner.thinkingOptionId !== builder.thinkingOptionId;
  if (!effortChanged && matchesSettings(before, builder)) return ref;
  await beforeSwitch();
  try {
    await withFleetConnection(async (_api, client) => {
      if (planner.model !== builder.model) await client.setAgentModel(agentId, builder.model);
      if (effortChanged || planner.model !== builder.model && builder.thinkingOptionId) await client.setAgentThinkingOption(agentId, builder.thinkingOptionId ?? null);
    });
  } catch (error) {
    // Only fall back when the original profile is positively observed. A timeout can leave a late change in flight.
    const actual = (await ref.refresh())?.agent;
    if (actual && matchesSettings(actual, planner) && /unsupported|not supported|cannot change|not available for|unknown model/i.test(error instanceof Error ? error.message : String(error))) return null;
    throw error;
  }
  const after = (await ref.refresh())?.agent;
  if (after && after.model !== builder.model && matchesSettings(after, planner)) return null;
  if (!after || after.archivedAt || after.activeTurn || ["running", "initializing"].includes(after.status) || after.pendingPermissions?.length || after.workspaceId !== workspaceId || after.currentModeId !== before.currentModeId || (effortChanged && !builder.thinkingOptionId && after.thinkingOptionId) || !matchesSettings(after, builder)) throw new Error("The host could not confirm the builder model, reasoning level and permissions after the switch. Inspect the planner chat before continuing.");
  return ref;
}
