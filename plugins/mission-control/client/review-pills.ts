import type { PluginButtonRegistration, PluginClientContext } from "@getpaseo/plugin/client";
import { getReviewCounts } from "../shared/review";

import { agentReviewPanelId } from "./panel-ids";

export { agentReviewPanelId, reviewPanelId } from "./panel-ids";

// Always shown for Git workspaces so Review stays one tap away, even after a commit.
export function pillLabel(count: { files: number; toReview: number } | null | undefined): string | null {
  if (!count) return null;
  if (count.files === 0) return "Review";
  return count.toReview ? `Review · ${count.toReview} to review` : `Review · ✓ ${count.files} reviewed`;
}

/**
 * Keeps one Review bubble above each active local agent's workspace chat.
 * Paseo registers bubbles per agent, so this polls and reconciles.
 * orchestrators names the workspaces that drive a remote host: their chats get the host's Review bubble
 * instead, because their own folder has nothing to review. An answer slower than 3 seconds counts as none.
 */
export function startReviewPills(client: PluginClientContext, intervalMs = 30_000, orchestrators?: (workspaceIds: string[]) => Promise<ReadonlySet<string>>): () => void {
  const pills = new Map<string, { registration: PluginButtonRegistration; label: string; workspaceId: string }>();
  const noOrchestrators: ReadonlySet<string> = new Set();
  async function orchestratorWorkspaces(workspaceIds: string[]): Promise<ReadonlySet<string>> {
    if (!orchestrators || !workspaceIds.length) return noOrchestrators;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        orchestrators(workspaceIds).catch(() => noOrchestrators),
        new Promise<ReadonlySet<string>>(resolve => { timer = setTimeout(() => resolve(noOrchestrators), 3_000); }),
      ]);
    } finally { clearTimeout(timer); }
  }
  let stopped = false;
  let running = false;
  let counting = false;

  async function refreshCounts(workspaceIds: string[]) {
    if (stopped || counting || !workspaceIds.length) return;
    counting = true;
    const requested = [...pills.entries()].filter(([, pill]) => workspaceIds.includes(pill.workspaceId));
    try {
      let counts: Record<string, { files: number; toReview: number } | null> = {};
      let pending: string[] = [];
      let unavailable = false;
      try { ({ counts, pending = [] } = await client.rpc(getReviewCounts, { workspaceIds })); }
      catch { unavailable = true; }
      if (stopped) return;
      for (const [agentId, pill] of requested) {
        // A move or disposal makes the original registration's counts stale.
        if (pills.get(agentId) !== pill) continue;
        const label = unavailable ? "Review · unavailable"
          : pending.includes(pill.workspaceId) ? "Review · counting…"
          : pillLabel(counts[pill.workspaceId]) || "Review";
        if (pill.label !== label) { pill.registration.update({ label }); pill.label = label; }
      }
    } finally { counting = false; }
  }

  async function sync() {
    if (running || stopped) return;
    running = true;
    try {
      const { entries } = await client.paseo.agents.list({ page: { limit: 200 } });
      const open = entries.map(entry => entry.agent)
        .filter(agent => agent.workspaceId && !("archivedAt" in agent && agent.archivedAt) && agent.status !== "closed");
      const hostViews = await orchestratorWorkspaces([...new Set(open.map(agent => agent.workspaceId!))].slice(0, 100));
      const active = open.filter(agent => !hostViews.has(agent.workspaceId!));
      const workspaceIds = [...new Set(active.map(agent => agent.workspaceId!))].slice(0, 50);
      // Navigation must be available before repository counts finish loading.
      if (stopped) return;
      const seen = new Set<string>();
      for (const agent of active) {
        const agentId = agent.id;
        const workspaceId = agent.workspaceId!;
        const previous = pills.get(agentId);
        const label = previous?.workspaceId === workspaceId ? previous.label : "Review";
        seen.add(agentId);
        const existing = pills.get(agentId);
        if (existing?.workspaceId === workspaceId) {
          if (existing.label !== label) { existing.registration.update({ label }); existing.label = label; }
          continue;
        }
        // Registration targets are immutable; moving an agent needs a new pill.
        existing?.registration.remove();
        pills.delete(agentId);
        const registration = client.addComposerPill({
          id: `review-${agentId}`, workspaceId, agentId,
          button: {
            title: "Review this workspace's changes", label, icon: "FileDiff",
            // Navigation belongs to the press action, never a popover mount/effect.
            behavior: { kind: "action", onPress: async () => {
              if (stopped) return;
              // Resolve the current chat's workspace again, including moves between polls.
              const current = (await client.paseo.agents.ref(agentId).refresh())?.agent;
              if (current?.id !== agentId || !current.workspaceId || current.archivedAt || current.status === "closed") {
                throw new Error("This agent no longer has an active workspace. Reopen Review from the current chat.");
              }
              if (stopped) return;
              client.openPanel(agentReviewPanelId, { workspaceId: current.workspaceId, agentId, location: "workspace" });
            } },
          },
        });
        pills.set(agentId, { registration, label, workspaceId });
      }
      for (const [agentId, pill] of pills) if (!seen.has(agentId)) { pill.registration.remove(); pills.delete(agentId); }
      // A pending count request must not block the next agent reconciliation.
      void refreshCounts(workspaceIds);
    } catch {
      // Keep the current bubbles; the next poll retries. Review itself reports errors.
    } finally { running = false; }
  }

  void sync();
  const timer = setInterval(() => void sync(), intervalMs);
  return () => {
    stopped = true;
    clearInterval(timer);
    for (const pill of pills.values()) pill.registration.remove();
    pills.clear();
  };
}
