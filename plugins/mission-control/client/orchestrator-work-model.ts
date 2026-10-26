import type { OrchestratorWork } from "../shared/orchestrator-work";
import type { Agent } from "./roster-model";
import type { ReviewItem } from "./host-review-model";

export type ReviewSort = "activity" | "updated";
const time = (value: string | null | undefined) => value && Number.isFinite(Date.parse(value)) ? Date.parse(value) : 0;
export function latestTime(values: readonly (string | null | undefined)[]): string | null {
  return values.filter((value): value is string => Boolean(time(value))).sort((a, b) => time(b) - time(a))[0] ?? null;
}
// updatedAt can be a rename or label edit. Keep it separate from known conversation activity.
export function agentActivityAt(agent: Agent): string | null {
  return latestTime([agent.lastUserMessageAt, agent.activeTurnStartedAt, agent.attentionTimestamp]);
}
export function compareAgents(a: Agent, b: Agent, sort: ReviewSort = "activity"): number {
  const at = (agent: Agent) => sort === "updated" ? agent.updatedAt : agentActivityAt(agent);
  return time(at(b)) - time(at(a)) || a.id.localeCompare(b.id);
}

export type WorkerOwner = { serverId: string; agentId: string; remoteServerId: string };

/** Missing parent server labels mean same-host only, never an inferred remote parent. */
export function isNativeWorker(agent: Agent, owner: WorkerOwner): boolean {
  const parentId = agent.labels?.["paseo.parent-agent-id"]?.trim();
  const parentServerId = agent.labels?.["paseo.parent-server-id"]?.trim() || owner.remoteServerId;
  return Boolean(owner.agentId && parentId === owner.agentId && parentServerId === owner.serverId);
}

function ownedLinks(links: readonly OrchestratorWork[], owner?: WorkerOwner): readonly OrchestratorWork[] {
  return owner ? links.filter(link => link.serverId === owner.serverId && link.agentId === owner.agentId && link.remoteServerId === owner.remoteServerId) : links;
}

export function workerRelationship(agent: Agent, links: readonly OrchestratorWork[], owner: WorkerOwner): string {
  if (isNativeWorker(agent, owner)) return "Native child";
  return ownedLinks(links, owner).some(link => link.remoteAgentId === agent.id) ? "Linked worker" : "Descendant";
}

/** Explicit links, native children of this exact chat, and their local descendants. */
export function linkedWorkers(agents: readonly Agent[], links: readonly OrchestratorWork[], owner?: WorkerOwner): Set<string> {
  const ids = new Set(ownedLinks(links, owner).map(link => link.remoteAgentId));
  if (owner) for (const agent of agents) if (isNativeWorker(agent, owner)) ids.add(agent.id);
  let added = true;
  while (added) {
    added = false;
    for (const agent of agents) if (agent.parentAgentId && ids.has(agent.parentAgentId) && !ids.has(agent.id)
      && (!owner || !agent.labels?.["paseo.parent-server-id"]?.trim() || agent.labels["paseo.parent-server-id"].trim() === owner.remoteServerId)) {
      ids.add(agent.id); added = true;
    }
  }
  return ids;
}

export function scopedReviews(items: readonly ReviewItem[], agents: readonly Agent[], links: readonly OrchestratorWork[], onlyLinked: boolean, sort: ReviewSort, owner?: WorkerOwner): ReviewItem[] {
  links = ownedLinks(links, owner);
  const ids = linkedWorkers(agents, links, owner);
  // Keep a finished/missing worker's recorded workspace. A known moved worker follows its current workspace.
  const workspaces = new Set(links.map(link => agents.find(agent => agent.id === link.remoteAgentId)?.workspaceId || link.remoteWorkspaceId));
  for (const agent of agents) if (ids.has(agent.id) && agent.workspaceId) workspaces.add(agent.workspaceId);
  const selected = items.filter(item => !onlyLinked || workspaces.has(item.workspace.id)).map(item => ({
    ...item, agents: item.agents.filter(agent => !onlyLinked || ids.has(agent.id)).sort((a, b) => compareAgents(a, b, sort)),
  }));
  const at = (item: ReviewItem) => latestTime(item.agents.map(agent => sort === "updated" ? agent.updatedAt : agentActivityAt(agent)));
  return selected.sort((a, b) => time(at(b)) - time(at(a)) || a.workspace.id.localeCompare(b.workspace.id));
}
