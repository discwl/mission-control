import type { PluginButtonRegistration, PluginClientContext } from "@getpaseo/plugin/client";
import { listIncludingBackground, ownHost } from "../shared/background";
import { getMissionSummary } from "../shared/mission";
import { listWaiting } from "../shared/questions";
import { waitingCards } from "./attention-model";
import { panelLocation, wideLayout, type Layout } from "./layout";
import { toAgent } from "./roster-model";
import { missionPanelId } from "./panel-ids";

export const missionButtonId = (workspaceId: string) => `mission-${workspaceId.toLowerCase().replace(/[^a-z0-9-]/g, "-")}`;
export const missionPillId = (agentId: string) => `mission-pill-${agentId.toLowerCase().replace(/[^a-z0-9-]/g, "-")}`;

export function missionLabel(needs: number): string | null {
  return needs > 0 ? `${needs} need${needs === 1 ? "s" : ""} you` : null;
}

const missionTitle = (label: string | null) => label ? `Mission: ${label}` : "Mission: tasks, decisions, review and agents";

/**
 * Adds a Mission button to the header of each local workspace with active agents. It opens the Mission panel and
 * shows how many permission prompts and decisions are waiting. Paseo 0.12's compact (phone) layout draws no plugin
 * header buttons, so while `layout` is compact each active chat also gets a Mission bubble above its composer, and
 * the panel opens as a tab: that layout has no Explorer.
 */
export function startMissionButtons(client: PluginClientContext, intervalMs = 15_000, layout: Layout = wideLayout): () => void {
  const buttons = new Map<string, { registration: PluginButtonRegistration; label: string | null; needs: number }>();
  const pills = new Map<string, { registration: PluginButtonRegistration; label: string | null; workspaceId: string }>();
  let stopped = false;
  let running = false;

  // The layout is read on press, so a phone rotated since the button was added still gets the right place.
  const open = (workspaceId: string) => client.openPanel(missionPanelId, { workspaceId, location: panelLocation(layout) });

  function add(workspaceId: string, label: string | null) {
    return client.addHeaderButton({
      // Button IDs allow only letters, digits and hyphens; workspace IDs contain an underscore.
      id: missionButtonId(workspaceId), workspaceId,
      button: {
        title: missionTitle(label), icon: "PanelsTopLeft",
        ...(label ? { label } : {}),
        behavior: { kind: "action", onPress: () => open(workspaceId) },
      },
    });
  }

  /** One bubble per active chat of a workspace that has a header button, while the layout is compact. */
  function syncPills(agents: { id: string; workspaceId?: string | null; archivedAt?: string | null; status: string }[], labels: ReadonlyMap<string, string | null>) {
    const wanted = new Map<string, string>();
    if (layout.compact()) for (const agent of agents) {
      if (agent.workspaceId && labels.has(agent.workspaceId) && !agent.archivedAt && agent.status !== "closed") wanted.set(agent.id, agent.workspaceId);
    }
    for (const [agentId, pill] of pills) {
      // Registration targets are immutable; a chat that moved needs a new bubble.
      if (wanted.get(agentId) !== pill.workspaceId) { pill.registration.remove(); pills.delete(agentId); }
    }
    for (const [agentId, workspaceId] of wanted) {
      const label = labels.get(workspaceId) ?? null;
      const existing = pills.get(agentId);
      if (existing) {
        if (existing.label !== label) { existing.registration.update({ title: missionTitle(label), label: label ?? "Mission" }); existing.label = label; }
        continue;
      }
      const registration = client.addComposerPill({
        id: missionPillId(agentId), workspaceId, agentId,
        button: { title: missionTitle(label), label: label ?? "Mission", icon: "PanelsTopLeft", behavior: { kind: "action", onPress: () => open(workspaceId) } },
      });
      pills.set(agentId, { registration, label, workspaceId });
    }
  }

  async function sync() {
    if (running || stopped) return;
    running = true;
    try {
      // Workspaces in the background (Paseo 0.12) count too; they're left out of lists unless asked for.
      const { entries } = await listIncludingBackground(ownHost, {}, filter => client.paseo.agents.list({ filter, page: { limit: 200 } }));
      const permissions = new Map<string, number>();
      for (const { agent } of entries) {
        if (!agent.workspaceId || agent.archivedAt || agent.status === "closed") continue;
        permissions.set(agent.workspaceId, (permissions.get(agent.workspaceId) ?? 0) + (agent.pendingPermissions?.length ?? 0));
      }
      const workspaceIds = [...permissions.keys()].slice(0, 100);
      // Keep the previous badge if a read fails; missing data must not clear a waiting request.
      let incomplete = false;
      const unavailable = (error: unknown) => { incomplete = true; console.warn("[mission-control] Needs you count incomplete:", error); return null; };
      const summary = workspaceIds.length ? await client.rpc(getMissionSummary, { workspaceIds }).catch(unavailable) : null;
      const summaries = summary?.summaries ?? {};
      const waiting = summary ? await client.rpc(listWaiting, { serverId: summary.serverId }).catch(unavailable) : null;
      const extra = new Map<string, number>();
      if (summary) for (const card of waitingCards({
        hosts: [{ serverId: summary.serverId, label: "", status: "online" }],
        rosters: [{ data: { workspaces: [], agents: entries.map(({ agent }) => toAgent(agent)) } }],
        localServerId: summary.serverId, questions: waiting?.questions,
      })) {
        const workspaceId = card.agent?.workspaceId;
        if (workspaceId) extra.set(workspaceId, (extra.get(workspaceId) ?? 0) + 1);
      }
      if (stopped) return;
      const labels = new Map<string, string | null>();
      for (const workspaceId of workspaceIds) {
        const existing = buttons.get(workspaceId);
        const known = (permissions.get(workspaceId) ?? 0) + (summaries[workspaceId]?.openDecisions ?? 0) + (extra.get(workspaceId) ?? 0);
        const needs = incomplete ? Math.max(known, existing?.needs ?? 0) : known;
        const label = incomplete ? (needs ? `${needs}+ need${needs === 1 ? "s" : ""} you` : "Needs you unavailable") : missionLabel(needs);
        labels.set(workspaceId, label);
        if (existing && existing.label === label) continue;
        // Re-register rather than patch, so going back to icon-only reliably drops the label.
        existing?.registration.remove();
        buttons.set(workspaceId, { registration: add(workspaceId, label), label, needs });
      }
      for (const [workspaceId, button] of buttons) {
        if (!permissions.has(workspaceId)) { button.registration.remove(); buttons.delete(workspaceId); }
      }
      syncPills(entries.map(({ agent }) => agent), labels);
    } catch (error) {
      // Keep the current buttons; the next poll retries. Logged so a rejected registration is visible.
      console.warn("[mission-control] Mission header buttons:", error);
    } finally { running = false; }
  }

  void sync();
  const timer = setInterval(() => void sync(), intervalMs);
  // Crossing the breakpoint (a resized window, a rotated tablet) adds or removes the bubbles without waiting for the poll.
  const stopLayout = layout.subscribe(() => void sync());
  return () => {
    stopped = true;
    clearInterval(timer);
    stopLayout();
    for (const button of buttons.values()) button.registration.remove();
    buttons.clear();
    for (const pill of pills.values()) pill.registration.remove();
    pills.clear();
  };
}
