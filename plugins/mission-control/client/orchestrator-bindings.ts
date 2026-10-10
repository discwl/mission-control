import type { PluginClientContext } from "@getpaseo/plugin/client";
import { getOrchestratorBindings, type OrchestratorBinding } from "../shared/orchestrator";

export type BindingLookup = (workspaceIds: readonly string[]) => Promise<Map<string, OrchestratorBinding>>;

/**
 * Which local workspaces orchestrate a remote host, shared by the chat bubbles. Answers are kept for a
 * minute; a failed read keeps the last answer, and a workspace never read counts as not an orchestrator.
 */
export function createBindingLookup(client: Pick<PluginClientContext, "rpc">, { ttlMs = 60_000, now = Date.now } = {}): BindingLookup {
  const known = new Map<string, { at: number; binding: OrchestratorBinding | null }>();
  let reading: Promise<void> = Promise.resolve();

  async function refresh(workspaceIds: readonly string[]) {
    const stale = workspaceIds.filter(id => { const entry = known.get(id); return !entry || now() - entry.at >= ttlMs; }).slice(0, 200);
    if (!stale.length) return;
    try {
      const { bindings } = await client.rpc(getOrchestratorBindings, { workspaceIds: stale });
      const at = now();
      for (const id of stale) known.set(id, { at, binding: bindings?.[id] ?? null });
    } catch {
      // Keep what was known; the next poll asks again.
    }
  }

  return async workspaceIds => {
    // One read at a time, so two bubble polls don't ask for the same workspaces together.
    reading = reading.then(() => refresh(workspaceIds));
    await reading;
    return new Map(workspaceIds.flatMap(id => { const binding = known.get(id)?.binding; return binding ? [[id, binding] as const] : []; }));
  };
}
