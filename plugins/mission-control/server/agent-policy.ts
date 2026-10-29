import { createHash } from "node:crypto";
import { z } from "zod";
import type { PaseoApi } from "@getpaseo/client";
import type { PluginServerContext } from "@getpaseo/plugin/server";
import { nativeProfileSchema, readAgentPolicy, saveAgentPolicy, resolveRolePolicy, type ResolvedPolicy } from "../shared/agent-policy";
import { daemonServerId } from "./agent-names";
import { invokeChatHost } from "./chat-transport";
import type { FleetStore } from "./fleet-store";

export async function nativeProfiles(paseo: PaseoApi) {
  const response = await paseo.config.get();
  return z.array(nativeProfileSchema).parse((response.config as { agentProfiles?: unknown }).agentProfiles ?? []);
}
export async function effectiveAgentPolicy(store: FleetStore, paseo: PaseoApi, projectId: string | null, taskId: string | null): Promise<ResolvedPolicy | null> {
  const policy = resolveRolePolicy((await store.read()).agentPolicies, await nativeProfiles(paseo), projectId, taskId);
  if (policy) policy.revision = createHash("sha256").update(policy.revision).digest("hex");
  return policy;
}
export async function verifyProfileAvailability(paseo: PaseoApi, policy: ResolvedPolicy) {
  const available = await paseo.providers.listAvailable();
  for (const profile of policy.profiles) {
    if (!available.providers.some(entry => entry.provider === profile.provider && entry.available)) throw new Error(`${profile.name}: provider ${profile.provider} is unavailable on this host.`);
    const catalog = await paseo.providers.listModels(profile.provider);
    if (catalog.error) throw new Error(`${profile.name}: ${catalog.error}`);
    const model = catalog.models?.find(item => item.id === profile.model);
    if (!model) throw new Error(`${profile.name}: model ${profile.model} is unavailable. Update the native Paseo profile.`);
    if (profile.thinkingOptionId && !model.thinkingOptions?.some(item => item.id === profile.thinkingOptionId)) throw new Error(`${profile.name}: its saved reasoning setting is unavailable for this model.`);
    if (profile.modeId) {
      const modes = await paseo.providers.listModes(profile.provider);
      if (modes.error || !modes.modes?.some(item => item.id === profile.modeId)) throw new Error(`${profile.name}: its saved permission mode is unavailable.`);
    }
  }
}
export function registerAgentPolicies(server: PluginServerContext, store: FleetStore) {
  server.handle(readAgentPolicy, async (input, { paseo }) => {
    if (input.serverId !== await daemonServerId()) return readAgentPolicy.output.parse(await invokeChatHost(input.serverId, readAgentPolicy.name, input));
    const state = await store.read(); const profiles = await nativeProfiles(paseo);
    let effective: ResolvedPolicy | null = null; let problem: string | null = null;
    try { effective = await effectiveAgentPolicy(store, paseo, input.projectId, input.taskId); }
    catch (error) { problem = error instanceof Error ? error.message : String(error); }
    return { revision: state.revision, profiles, policies: state.agentPolicies, effective, problem };
  });
  server.handle(saveAgentPolicy, async (input, { paseo }) => {
    if (input.serverId !== await daemonServerId()) return saveAgentPolicy.output.parse(await invokeChatHost(input.serverId, saveAgentPolicy.name, input));
    if (input.taskId && !input.projectId) throw new Error("Task settings need their exact project.");
    const state = await store.read();
    const policies = state.agentPolicies.filter(item => item.projectId !== input.projectId || item.taskId !== input.taskId);
    if (input.mapping) policies.push({ projectId: input.projectId, taskId: input.taskId, mapping: input.mapping, updatedAt: new Date().toISOString() });
    const resolved = resolveRolePolicy(policies, await nativeProfiles(paseo), input.projectId, input.taskId);
    if (resolved) await verifyProfileAvailability(paseo, resolved);
    const saved = await store.update(current => { current.agentPolicies = policies; }, input.expectedRevision);
    return { revision: saved.revision };
  });
}
