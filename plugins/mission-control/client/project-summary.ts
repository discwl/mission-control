export type SummaryAgent = {
  workspaceId: string | null;
  provider: string;
  status: string;
  updatedAt: string;
  requiresAttention: boolean;
  attentionReason: string | null;
};

export type SummaryWorkspace = { id: string; activityAt: string | null };

export type ProjectAgentSummary = {
  total: number;
  running: number;
  idle: number;
  needsYou: number;
  errored: number;
  providers: string[];
  lastActivityAt: string | null;
};

// Each agent lands in one bucket: errors first, then anything waiting on the user.
export function summarizeProjectAgents(workspaces: readonly SummaryWorkspace[], agents: readonly SummaryAgent[]): ProjectAgentSummary {
  const ids = new Set(workspaces.map(workspace => workspace.id));
  const summary: ProjectAgentSummary = { total: 0, running: 0, idle: 0, needsYou: 0, errored: 0, providers: [], lastActivityAt: null };
  let latest = Number.NEGATIVE_INFINITY;
  const track = (value: string | null) => {
    const time = value ? Date.parse(value) : Number.NaN;
    if (value && time > latest) { latest = time; summary.lastActivityAt = value; }
  };
  for (const workspace of workspaces) track(workspace.activityAt);
  for (const agent of agents) {
    if (!agent.workspaceId || !ids.has(agent.workspaceId)) continue;
    summary.total++;
    if (agent.status === "error" || agent.attentionReason === "error") summary.errored++;
    else if (agent.requiresAttention) summary.needsYou++;
    else if (agent.status === "running" || agent.status === "initializing") summary.running++;
    else if (agent.status === "idle") summary.idle++;
    const provider = agent.provider.trim();
    if (provider && !summary.providers.some(value => value.toLowerCase() === provider.toLowerCase())) summary.providers.push(provider);
    track(agent.updatedAt);
  }
  return summary;
}

export function projectCollapseKey(serverId: string, projectId: string): string {
  return JSON.stringify([serverId, projectId]);
}

/** Returns a new list with the keys added or removed; unrelated keys keep their order. */
export function setProjectsCollapsed(current: readonly string[], keys: readonly string[], collapsed: boolean): string[] {
  const targets = new Set(keys);
  const rest = current.filter(key => !targets.has(key));
  return collapsed ? [...rest, ...keys.filter((key, index) => keys.indexOf(key) === index)] : rest;
}

export type CollapseChange = { id: number; keys: readonly string[]; collapse: boolean };

/** Replays pending collapse/expand operations onto the stored list, in order. */
export function applyCollapseChanges(stored: readonly string[], changes: readonly CollapseChange[]): string[] {
  return changes.reduce<string[]>((list, change) => setProjectsCollapsed(list, change.keys, change.collapse), [...stored]);
}

export function describeProjectSummary(summary: ProjectAgentSummary): string {
  const parts = summary.total === 0 ? ["no agents"] : [
    ...([[summary.running, "running"], [summary.idle, "idle"], [summary.needsYou, "need you"], [summary.errored, "errored"]] as const)
      .filter(([count]) => count > 0).map(([count, label]) => `${count} ${label}`),
  ];
  if (summary.total > 0 && parts.length === 0) parts.push(`${summary.total} closed`);
  if (summary.providers.length > 0) parts.push(`providers ${summary.providers.join(", ")}`);
  return parts.join(", ");
}

export function sameKeys(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) return false;
  const set = new Set(a);
  return b.every(key => set.has(key));
}
