import type { PluginButtonRegistration, PluginClientContext } from "@getpaseo/plugin/client";
import { hostAgentsLabel, hostReviewItems, hostReviewLabel, needsYouCount } from "./host-review-model";
import { requestHostReview } from "./host-review-request";
import type { BindingLookup } from "./orchestrator-bindings";
import { hostAgentsPanelId } from "./panel-ids";
import type { Agent, Workspace } from "./roster-model";

type HostActivity = { workspaces: Workspace[]; agents: Agent[] };
type HostCounts = { at: number; needs: number; ready: number; changed: number };
type Entry = {
  workspaceId: string;
  serverId: string;
  hostLabel: string;
  agents: { registration: PluginButtonRegistration; label: string };
  review: { registration: PluginButtonRegistration; label: string };
};

/**
 * In a workspace that orchestrates a remote host (its folder has a host file), each active chat gets two
 * bubbles: "<host> agents" opens the Host agents tab, and Review opens that tab's review list. Their
 * counts come from the remote host, read at most once a minute; an unreachable host keeps its last counts.
 */
export function startOrchestratorPills(client: Pick<PluginClientContext, "paseo" | "addComposerPill" | "openPanel">, { lookUp, readHost, intervalMs = 30_000, hostRefreshMs = 60_000, now = Date.now }: {
  lookUp: BindingLookup;
  readHost: (serverId: string) => Promise<HostActivity>;
  intervalMs?: number;
  hostRefreshMs?: number;
  now?: () => number;
}): () => void {
  const entries = new Map<string, Entry>();
  const counts = new Map<string, HostCounts>();
  const reading = new Set<string>();
  let stopped = false;
  let running = false;

  function labels(entry: Pick<Entry, "serverId" | "hostLabel">) {
    const host = counts.get(entry.serverId);
    return { agents: hostAgentsLabel(entry.hostLabel, host?.needs ?? null), review: hostReviewLabel(host ?? null) };
  }

  function relabel(entry: Entry) {
    const next = labels(entry);
    if (entry.agents.label !== next.agents) { entry.agents.registration.update({ label: next.agents }); entry.agents.label = next.agents; }
    if (entry.review.label !== next.review) { entry.review.registration.update({ label: next.review }); entry.review.label = next.review; }
  }

  function add(agentId: string, workspaceId: string, serverId: string, hostLabel: string): Entry {
    const next = labels({ serverId, hostLabel });
    const openTab = () => client.openPanel(hostAgentsPanelId, { workspaceId, location: "workspace" });
    return {
      workspaceId, serverId, hostLabel,
      agents: { label: next.agents, registration: client.addComposerPill({
        id: `host-agents-${agentId}`, workspaceId, agentId,
        button: { title: `${hostLabel}'s workspaces and agents`, label: next.agents, icon: "Server", behavior: { kind: "action", onPress: openTab } },
      }) },
      review: { label: next.review, registration: client.addComposerPill({
        id: `host-review-${agentId}`, workspaceId, agentId,
        button: { title: `What ${hostLabel}'s agents have ready to review`, label: next.review, icon: "FileDiff", behavior: { kind: "action", onPress: () => { requestHostReview(workspaceId); openTab(); } } },
      }) },
    };
  }

  function remove(agentId: string) {
    const entry = entries.get(agentId);
    entry?.agents.registration.remove();
    entry?.review.registration.remove();
    entries.delete(agentId);
  }

  async function refreshHost(serverId: string) {
    const known = counts.get(serverId);
    if (stopped || reading.has(serverId) || (known && now() - known.at < hostRefreshMs)) return;
    reading.add(serverId);
    try {
      const host = await readHost(serverId);
      const review = hostReviewItems(host.workspaces, host.agents);
      counts.set(serverId, { at: now(), needs: needsYouCount(host.agents), ready: review.ready.length, changed: review.changed.length });
      if (!stopped) for (const entry of entries.values()) if (entry.serverId === serverId) relabel(entry);
    } catch {
      // Offline or unreachable: keep the last counts; the next poll tries again.
    } finally { reading.delete(serverId); }
  }

  async function sync() {
    if (running || stopped) return;
    running = true;
    try {
      const { entries: listed } = await client.paseo.agents.list({ page: { limit: 200 } });
      const active = listed.map(entry => entry.agent).filter(agent => agent.workspaceId && !agent.archivedAt && agent.status !== "closed");
      const bindings = await lookUp([...new Set(active.map(agent => agent.workspaceId!))].slice(0, 100));
      if (stopped) return;
      const seen = new Set<string>();
      for (const agent of active) {
        const binding = bindings.get(agent.workspaceId!);
        if (!binding) continue;
        seen.add(agent.id);
        const existing = entries.get(agent.id);
        if (existing && existing.workspaceId === agent.workspaceId && existing.serverId === binding.serverId && existing.hostLabel === binding.label) { relabel(existing); continue; }
        // A bubble's chat and workspace are fixed when it is added; a moved chat or new host needs new bubbles.
        remove(agent.id);
        entries.set(agent.id, add(agent.id, agent.workspaceId!, binding.serverId, binding.label));
      }
      for (const agentId of [...entries.keys()]) if (!seen.has(agentId)) remove(agentId);
      // Remote reads must not hold up the next reconciliation.
      for (const serverId of new Set([...entries.values()].map(entry => entry.serverId))) void refreshHost(serverId);
    } catch {
      // Keep the current bubbles; the next poll retries.
    } finally { running = false; }
  }

  void sync();
  const timer = setInterval(() => void sync(), intervalMs);
  return () => {
    stopped = true;
    clearInterval(timer);
    for (const agentId of [...entries.keys()]) remove(agentId);
  };
}
