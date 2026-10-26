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

/** Explicit links and their known descendants only. Shared task, branch, or folder is not ownership. */
export function linkedWorkers(agents: readonly Agent[], links: readonly OrchestratorWork[]): Set<string> {
  const ids = new Set(links.map(link => link.remoteAgentId));
  let added = true;
  while (added) {
    added = false;
    for (const agent of agents) if (agent.parentAgentId && ids.has(agent.parentAgentId) && !ids.has(agent.id)) {
      ids.add(agent.id); added = true;
    }
  }
  return ids;
}

export function scopedReviews(items: readonly ReviewItem[], agents: readonly Agent[], links: readonly OrchestratorWork[], onlyLinked: boolean, sort: ReviewSort): ReviewItem[] {
  const ids = linkedWorkers(agents, links);
  // Keep a finished/missing worker's recorded workspace. A known moved worker follows its current workspace.
  const workspaces = new Set(links.map(link => agents.find(agent => agent.id === link.remoteAgentId)?.workspaceId || link.remoteWorkspaceId));
  for (const agent of agents) if (ids.has(agent.id) && agent.workspaceId) workspaces.add(agent.workspaceId);
  const selected = items.filter(item => !onlyLinked || workspaces.has(item.workspace.id)).map(item => ({
    ...item, agents: item.agents.filter(agent => !onlyLinked || ids.has(agent.id)).sort((a, b) => compareAgents(a, b, sort)),
  }));
  const at = (item: ReviewItem) => latestTime(item.agents.map(agent => sort === "updated" ? agent.updatedAt : agentActivityAt(agent)));
  return selected.sort((a, b) => time(at(b)) - time(at(a)) || a.workspace.id.localeCompare(b.workspace.id));
}
