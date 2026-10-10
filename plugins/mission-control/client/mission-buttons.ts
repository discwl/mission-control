import type { PluginButtonRegistration, PluginClientContext } from "@getpaseo/plugin/client";
import { getMissionSummary } from "../shared/mission";
import { listWaiting } from "../shared/questions";
import { waitingCards } from "./attention-model";
import { toAgent } from "./roster-model";
import { missionPanelId } from "./panel-ids";

export const missionButtonId = (workspaceId: string) => `mission-${workspaceId.toLowerCase().replace(/[^a-z0-9-]/g, "-")}`;

export function missionLabel(needs: number): string | null {
  return needs > 0 ? `${needs} need${needs === 1 ? "s" : ""} you` : null;
}

/**
 * Adds a Mission button to the header of each local workspace with active agents. It opens the
 * Mission panel on the right and shows how many permission prompts and decisions are waiting.
 */
export function startMissionButtons(client: PluginClientContext, intervalMs = 15_000): () => void {
  const buttons = new Map<string, { registration: PluginButtonRegistration; label: string | null; needs: number }>();
  let stopped = false;
  let running = false;

  function add(workspaceId: string, label: string | null) {
    return client.addHeaderButton({
      // Button IDs allow only letters, digits and hyphens; workspace IDs contain an underscore.
      id: missionButtonId(workspaceId), workspaceId,
      button: {
        title: label ? `Mission: ${label}` : "Mission: tasks, decisions, review and agents", icon: "PanelsTopLeft",
        ...(label ? { label } : {}),
        behavior: { kind: "action", onPress: () => client.openPanel(missionPanelId, { workspaceId, location: "explorer" }) },
      },
    });
  }

  async function sync() {
    if (running || stopped) return;
    running = true;
    try {
      const { entries } = await client.paseo.agents.list({ page: { limit: 200 } });
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
      for (const workspaceId of workspaceIds) {
        const existing = buttons.get(workspaceId);
        const known = (permissions.get(workspaceId) ?? 0) + (summaries[workspaceId]?.openDecisions ?? 0) + (extra.get(workspaceId) ?? 0);
        const needs = incomplete ? Math.max(known, existing?.needs ?? 0) : known;
        const label = incomplete ? (needs ? `${needs}+ need${needs === 1 ? "s" : ""} you` : "Needs you unavailable") : missionLabel(needs);
        if (existing && existing.label === label) continue;
        // Re-register rather than patch, so going back to icon-only reliably drops the label.
        existing?.registration.remove();
        buttons.set(workspaceId, { registration: add(workspaceId, label), label, needs });
      }
      for (const [workspaceId, button] of buttons) {
        if (!permissions.has(workspaceId)) { button.registration.remove(); buttons.delete(workspaceId); }
      }
    } catch (error) {
      // Keep the current buttons; the next poll retries. Logged so a rejected registration is visible.
      console.warn("[mission-control] Mission header buttons:", error);
    } finally { running = false; }
  }

  void sync();
  const timer = setInterval(() => void sync(), intervalMs);
  return () => {
    stopped = true;
    clearInterval(timer);
    for (const button of buttons.values()) button.registration.remove();
    buttons.clear();
  };
}
