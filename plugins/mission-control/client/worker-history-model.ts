import { z } from "zod";
import type { OrchestratorWork } from "../shared/orchestrator-work";
import { agentActivityAt, workerRelationship, type WorkerOwner } from "./orchestrator-work-model";
import type { Agent, Workspace } from "./roster-model";

export const workerGroups = ["Active", "Needs you", "Idle", "Completed", "Archived"] as const;
export type WorkerGroup = typeof workerGroups[number];
export const workerHistorySchema = z.object({
  version: z.literal(1), owner: z.string(),
  workers: z.array(z.object({
    serverId: z.string(), agentId: z.string(), workspaceId: z.string().nullable(),
    name: z.string().max(500), hostLabel: z.string().max(500), workspaceName: z.string().max(1000),
    status: z.string(), group: z.enum(workerGroups), activityAt: z.string().nullable(), finishedAt: z.string().nullable().default(null),
    outcome: z.string().max(500).nullable(), relationship: z.string(), observedAt: z.string(),
  })).max(1000),
});
export type WorkerRecord = z.infer<typeof workerHistorySchema>["workers"][number];
export type WorkerRow = WorkerRecord & { available: boolean };
export const workerOwnerKey = (owner: { serverId: string; agentId: string }) => JSON.stringify([owner.serverId, owner.agentId]);
export const workerKey = (worker: Pick<WorkerRecord, "serverId" | "agentId">) => JSON.stringify([worker.serverId, worker.agentId]);
export function restoreWorkerHistory(value: unknown, owner: string): WorkerRecord[] {
  const parsed = workerHistorySchema.safeParse(value);
  return parsed.success && parsed.data.owner === owner ? parsed.data.workers : [];
}
export function workerGroup(agent: Agent): WorkerGroup {
  if (agent.archivedAt) return "Archived";
  if (agent.permissions.length || agent.status === "error" || agent.lastError || (agent.requiresAttention && agent.attentionReason !== "finished")) return "Needs you";
  if (agent.activeTurn || agent.status === "running" || agent.status === "initializing") return "Active";
  return agent.attentionReason === "finished" ? "Completed" : "Idle";
}
export type WorkerObservation = {
  serverId: string; hostLabel: string; agents: readonly Agent[]; workspaces: readonly Workspace[];
  links: readonly OrchestratorWork[]; linksKnown: boolean; complete: boolean; current: boolean; observedAt: string;
};
/** Follow exact (server, agent) edges, including a worker's children on another host. */
function ownedWorkerKeys(observations: readonly WorkerObservation[], owner: { serverId: string; agentId: string }, verified: boolean): Set<string> {
  const root = workerKey({ serverId: owner.serverId, agentId: owner.agentId });
  const ids = new Set([root]);
  for (const observation of observations) if (!verified || observation.current && observation.linksKnown) {
    for (const link of observation.links) if (link.serverId === owner.serverId && link.agentId === owner.agentId && link.remoteServerId === observation.serverId) ids.add(workerKey({ serverId: observation.serverId, agentId: link.remoteAgentId }));
  }
  let added = true;
  while (added) {
    added = false;
    for (const observation of observations) if (!verified || observation.current) for (const agent of observation.agents) {
      const parentId = agent.labels?.["paseo.parent-agent-id"]?.trim() || agent.parentAgentId;
      const parentServer = agent.labels?.["paseo.parent-server-id"]?.trim() || observation.serverId;
      const key = workerKey({ serverId: observation.serverId, agentId: agent.id });
      if (parentId && ids.has(workerKey({ serverId: parentServer, agentId: parentId })) && !ids.has(key)) { ids.add(key); added = true; }
    }
  }
  ids.delete(root);
  return ids;
}
/** Cached rows are history, never proof of current ownership or permission to navigate. */
export function mergeWorkerHistory(previous: readonly WorkerRecord[], observations: readonly WorkerObservation[], owner: { serverId: string; agentId: string }): WorkerRow[] {
  const rows = new Map(previous.map(row => [workerKey(row), { ...row, available: false }]));
  const ids = ownedWorkerKeys(observations, owner, false);
  const verifiedIds = ownedWorkerKeys(observations, owner, true);
  const complete = observations.length > 0 && observations.every(item => item.current && item.complete && item.linksKnown)
    && previous.every(row => observations.some(item => item.serverId === row.serverId));
  for (const observation of observations) {
    const binding: WorkerOwner = { ...owner, remoteServerId: observation.serverId };
    for (const agent of observation.agents) {
      const key = workerKey({ serverId: observation.serverId, agentId: agent.id });
      if (!ids.has(key)) {
        // A verified detach/unlink must remove this chat's row. A partial read cannot prove it.
        if (complete) rows.delete(key);
        continue;
      }
      const previous = rows.get(key);
      const activityAt = agentActivityAt(agent);
      const lastActivity = [previous?.activityAt, activityAt].filter((value): value is string => Boolean(value)).sort((a, b) => (Date.parse(b) || 0) - (Date.parse(a) || 0))[0] ?? null;
      const finishedAt = agent.attentionReason === "finished" ? agent.attentionTimestamp || previous?.finishedAt || observation.observedAt : previous?.finishedAt ?? null;
      const newTurn = Boolean(finishedAt && [agent.lastUserMessageAt, agent.activeTurnStartedAt].some(value => value && Date.parse(value) > Date.parse(finishedAt)));
      const group = workerGroup(agent);
      rows.set(key, {
        serverId: observation.serverId, agentId: agent.id, workspaceId: agent.workspaceId,
        name: agent.name.slice(0, 500), hostLabel: observation.hostLabel.slice(0, 500),
        workspaceName: (observation.workspaces.find(workspace => workspace.id === agent.workspaceId)?.name ?? "Workspace unavailable").slice(0, 1000),
        status: agent.status, group: group === "Idle" && finishedAt && !newTurn ? "Completed" : group, activityAt: lastActivity, finishedAt,
        outcome: agent.summary?.trim().slice(0, 500) || null, relationship: workerRelationship(agent, observation.links, binding),
        observedAt: observation.observedAt, available: observation.current && verifiedIds.has(key),
      });
    }
  }
  return [...rows.values()].sort((a, b) => (Date.parse(b.activityAt ?? "") || 0) - (Date.parse(a.activityAt ?? "") || 0) || workerKey(a).localeCompare(workerKey(b))).slice(0, 1000);
}
