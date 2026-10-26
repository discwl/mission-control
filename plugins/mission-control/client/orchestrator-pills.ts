import type { PluginButtonRegistration, PluginClientContext } from "@getpaseo/plugin/client";
import { listIncludingBackground, ownHost } from "../shared/background";
import { hostAttentionCount, hostAttentionLabel, noAttentionReads, type HostAttentionReads } from "./host-attention";
import { hostAgentsLabel, runningAgentsCount } from "./host-review-model";
import { requestHostDestination, takeHostDestination } from "./host-review-request";
import { createOrchestratorDialogIcon } from "./orchestrator-dialog";
import { orchestratorDialogKey, setOrchestratorDialogOpen } from "./orchestrator-dialog-request";
import type { BindingLookup } from "./orchestrator-bindings";
import { hostAgentsPanelId } from "./panel-ids";
import type { Agent, Workspace } from "./roster-model";

type HostActivity = { workspaces: Workspace[]; agents: Agent[] };
type HostCounts = { at: number; running: number; attention: number };
type Entry = {
  workspaceId: string;
  serverId: string;
  hostLabel: string;
  agents: { registration: PluginButtonRegistration; label: string };
  review: { registration: PluginButtonRegistration; label: string };
  // Only while something on the host waits for the user.
  attention: { registration: PluginButtonRegistration; label: string } | null;
  agentId: string;
};

/**
 * In a workspace that orchestrates a remote host (its folder has a host file), each active chat gets
 * bubbles: "<host> agents" opens the Host agents tab, Review opens this chat's review dialog, and
 * "Attention · N", shown only while something blocks an agent there, opens its Attention dialog. Their counts
 * come from the remote host, read at most once a minute; an unreachable host keeps its last counts.
 */
export function startOrchestratorPills(client: Pick<PluginClientContext, "paseo" | "addComposerPill" | "openPanel">, { lookUp, readHost, readAttention = async () => noAttentionReads, intervalMs = 30_000, hostRefreshMs = 60_000, now = Date.now }: {
  lookUp: BindingLookup;
  readHost: (serverId: string) => Promise<HostActivity>;
  // The host's own Mission Control: its open questions and decisions.
  readAttention?: (serverId: string) => Promise<HostAttentionReads>;
  intervalMs?: number;
  hostRefreshMs?: number;
  now?: () => number;
}): () => void {
  const entries = new Map<string, Entry>();
  const counts = new Map<string, HostCounts>();
  const reading = new Set<string>();
  let stopped = false;
  let running = false;

  function openDialog(workspaceId: string, agentId: string, serverId: string, kind: "review" | "attention") {
    const entry = entries.get(agentId);
    if (stopped || entry?.workspaceId !== workspaceId || entry.serverId !== serverId) return;
    setOrchestratorDialogOpen(orchestratorDialogKey(workspaceId, agentId, serverId, kind), true);
  }

  function labels(entry: Pick<Entry, "serverId" | "hostLabel">) {
    const host = counts.get(entry.serverId);
    return {
      agents: hostAgentsLabel(entry.hostLabel, host?.running ?? null),
      // The dialog defaults to this chat's links; don't put a host-wide count on that button.
      review: "Review",
      attention: host?.attention ? hostAttentionLabel(host.attention) : null,
    };
  }

  function openDestination(workspaceId: string, serverId: string, kind: "agent" | "workspace", id: string) {
    requestHostDestination(workspaceId, { serverId, kind, id });
    try { client.openPanel(hostAgentsPanelId, { workspaceId, location: "workspace" }); }
    catch (error) { takeHostDestination(workspaceId, serverId); throw error; }
  }

  function attentionPill(entry: Pick<Entry, "agentId" | "workspaceId" | "hostLabel" | "serverId">, label: string) {
    return { label, registration: client.addComposerPill({
      id: `host-attention-${entry.agentId}`, workspaceId: entry.workspaceId, agentId: entry.agentId,
      button: { title: `What ${entry.hostLabel}'s agents are waiting on you for`, label,
        icon: createOrchestratorDialogIcon({ serverId: entry.serverId, label: entry.hostLabel }, "attention", openDestination),
        behavior: { kind: "action", onPress: () => openDialog(entry.workspaceId, entry.agentId, entry.serverId, "attention") } },
    }) };
  }

  function relabel(entry: Entry) {
    const next = labels(entry);
    if (entry.agents.label !== next.agents) { entry.agents.registration.update({ label: next.agents }); entry.agents.label = next.agents; }
    if (entry.review.label !== next.review) { entry.review.registration.update({ label: next.review }); entry.review.label = next.review; }
    if (!next.attention) {
      setOrchestratorDialogOpen(orchestratorDialogKey(entry.workspaceId, entry.agentId, entry.serverId, "attention"), false);
      entry.attention?.registration.remove(); entry.attention = null;
    }
    else if (!entry.attention) entry.attention = attentionPill(entry, next.attention);
    else if (entry.attention.label !== next.attention) { entry.attention.registration.update({ label: next.attention }); entry.attention.label = next.attention; }
  }

  function add(agentId: string, workspaceId: string, serverId: string, hostLabel: string): Entry {
    const next = labels({ serverId, hostLabel });
    const openTab = () => client.openPanel(hostAgentsPanelId, { workspaceId, location: "workspace" });
    return {
      workspaceId, serverId, hostLabel, agentId,
      attention: next.attention ? attentionPill({ agentId, workspaceId, hostLabel, serverId }, next.attention) : null,
      agents: { label: next.agents, registration: client.addComposerPill({
        id: `host-agents-${agentId}`, workspaceId, agentId,
        button: { title: `${hostLabel}'s workspaces and agents`, label: next.agents, icon: "Server", behavior: { kind: "action", onPress: openTab } },
      }) },
      review: { label: next.review, registration: client.addComposerPill({
        id: `host-review-${agentId}`, workspaceId, agentId,
        button: { title: `Review this chat's work on ${hostLabel}`, label: next.review,
          icon: createOrchestratorDialogIcon({ serverId, label: hostLabel }, "review", openDestination),
          behavior: { kind: "action", onPress: () => openDialog(workspaceId, agentId, serverId, "review") } },
      }) },
    };
  }

  function remove(agentId: string) {
    const entry = entries.get(agentId);
    if (entry) for (const kind of ["review", "attention"] as const) setOrchestratorDialogOpen(orchestratorDialogKey(entry.workspaceId, entry.agentId, entry.serverId, kind), false);
    entry?.agents.registration.remove();
    entry?.review.registration.remove();
    entry?.attention?.registration.remove();
    entries.delete(agentId);
  }

  async function refreshHost(serverId: string) {
    const known = counts.get(serverId);
    if (stopped || reading.has(serverId) || (known && now() - known.at < hostRefreshMs)) return;
    reading.add(serverId);
    try {
      const [host, reads] = await Promise.all([readHost(serverId), readAttention(serverId).catch(() => noAttentionReads)]);
      const label = [...entries.values()].find(entry => entry.serverId === serverId)?.hostLabel ?? serverId;
      counts.set(serverId, {
        at: now(), running: runningAgentsCount(host.agents),
        attention: hostAttentionCount({ serverId, label, roster: host, reads }),
      });
      if (!stopped) for (const entry of entries.values()) if (entry.serverId === serverId) relabel(entry);
    } catch {
      // Offline or unreachable: keep the last counts; the next poll tries again.
    } finally { reading.delete(serverId); }
  }

  async function sync() {
    if (running || stopped) return;
    running = true;
    try {
      // Chats in a background workspace (Paseo 0.12) get bubbles too; they're left out of lists unless asked for.
      const { entries: listed } = await listIncludingBackground(ownHost, {}, filter => client.paseo.agents.list({ filter, page: { limit: 200 } }));
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
