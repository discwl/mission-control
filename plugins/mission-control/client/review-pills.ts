import type { PluginButtonRegistration, PluginClientContext } from "@getpaseo/plugin/client";
import { agentPageOrder, followAgentList, keepsChatButtons, listAgentPages, ownHost } from "../shared/background";
import { getReviewCounts } from "../shared/review";

import { agentReviewPanelId } from "./panel-ids";

export { agentReviewPanelId, reviewPanelId } from "./panel-ids";

// Always shown for Git workspaces so Review stays one tap away, even after a commit.
export function pillLabel(count: { files: number; toReview: number } | null | undefined): string | null {
  if (!count) return null;
  if (count.files === 0) return "Review";
  return count.toReview ? `Review · ${count.toReview} to review` : `Review · ✓ ${count.files} reviewed`;
}

// A chat Paseo released (status "closed") still gets its bubble, but its workspace's count is read only while the chat
// was updated this recently; an older resting chat shows a plain "Review", which keeps the count work small.
export const countWindowMs = 24 * 60 * 60_000;

/** Whether a chat's workspace changes are counted for its bubble: it is open, or it rested only recently. */
export function countsReview(agent: { status?: string; updatedAt?: string | null }, now = Date.now()): boolean {
  if (agent.status !== "closed") return true;
  const updated = agent.updatedAt ? Date.parse(agent.updatedAt) : NaN;
  return Number.isFinite(updated) && now - updated < countWindowMs;
}

// At most this many bubbles, the most recently updated chats': Paseo's button store does work in proportion to every
// registration on each change, so hundreds of bubbles at startup would make it quadratic.
export const MAX_PILLS = 300;

/**
 * Keeps one Review bubble above each unarchived local agent's workspace chat, including chats Paseo released after
 * an idle hour (status "closed") in the last 14 days: they still exist, and a message wakes them.
 * Paseo registers bubbles per agent, so this reconciles on every change to the agent list and polls as a backstop.
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
  let again = false;
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

  async function sync(changed = false) {
    if (stopped) return;
    // A list change during a reconciliation runs another one after it; a poll then has nothing to add.
    if (running) { again ||= changed; return; }
    running = true;
    try {
      // Chats in a background workspace (Paseo 0.12) get bubbles too; they're left out of lists unless asked for.
      const { entries } = await listAgentPages(ownHost, {}, (filter, cursor) => client.paseo.agents.list({ filter, sort: agentPageOrder, page: { limit: 200, ...(cursor ? { cursor } : {}) } }));
      // Every chat that isn't resting for long, most recently updated first; see keepsChatButtons.
      const now = Date.now();
      const open = entries.map(entry => entry.agent)
        .filter(agent => agent.workspaceId && !("archivedAt" in agent && agent.archivedAt) && keepsChatButtons(agent, now))
        .sort((a, b) => String(b.updatedAt ?? "").localeCompare(String(a.updatedAt ?? "")));
      const hostViews = await orchestratorWorkspaces([...new Set(open.map(agent => agent.workspaceId!))].slice(0, 200));
      const active = open.filter(agent => !hostViews.has(agent.workspaceId!)).slice(0, MAX_PILLS);
      // The most recently updated workspaces are counted first.
      const workspaceIds = [...new Set(active.filter(agent => countsReview(agent, now)).map(agent => agent.workspaceId!))].slice(0, 50);
      // Navigation must be available before repository counts finish loading.
      if (stopped) return;
      const seen = new Set<string>();
      for (const agent of active) {
        const agentId = agent.id;
        const workspaceId = agent.workspaceId!;
        const previous = pills.get(agentId);
        // A workspace that is no longer counted drops its last count instead of keeping it forever.
        const label = previous?.workspaceId === workspaceId && workspaceIds.includes(workspaceId) ? previous.label : "Review";
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
              // A released (closed) chat still has its workspace; only an archived or unplaced one is refused.
              const current = (await client.paseo.agents.ref(agentId).refresh())?.agent;
              if (current?.id !== agentId || !current.workspaceId || current.archivedAt) {
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
    } finally {
      running = false;
      if (again) { again = false; void sync(true); }
    }
  }

  void sync();
  const timer = setInterval(() => void sync(), intervalMs);
  // A new, moved or archived chat, or a long-resting one woken by a message, updates its bubble within a moment
  // instead of at the next poll.
  const stopFollowing = followAgentList(filter => client.paseo.agents.list({ filter, subscribe: {} }), agentId => pills.get(agentId)?.workspaceId, () => void sync(true), { include: agent => keepsChatButtons(agent) });
  return () => {
    stopped = true;
    clearInterval(timer);
    stopFollowing();
    for (const pill of pills.values()) pill.registration.remove();
    pills.clear();
  };
}
