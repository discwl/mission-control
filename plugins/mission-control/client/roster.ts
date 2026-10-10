import type { PaseoAgentListResult } from "@getpaseo/client";
import { getPaseoClient } from "@getpaseo/plugin/client";
import { useQuery, useQueryClient, type QueryClient } from "@tanstack/react-query";
import { useEffect } from "react";
import { createLiveRosters } from "./live-roster";
import { lookUpMissingParents, toAgent, toWorkspace, type Roster } from "./roster-model";

export { agentsForTask, contextLineFor, findAgent, subagentContextOf, type Agent, type Project, type Roster, type Workspace } from "./roster-model";

// Agents are read in pages of 200, up to this many pages.
const AGENT_PAGES = 5;

async function readAgents(paseo: ReturnType<typeof getPaseoClient>) {
  const entries: PaseoAgentListResult["entries"] = [];
  let cursor: string | undefined;
  for (let page = 0; page < AGENT_PAGES; page++) {
    const result = await paseo.agents.list({ page: { limit: 200, ...(cursor ? { cursor } : {}) } });
    entries.push(...result.entries);
    cursor = result.pageInfo.hasMore ? result.pageInfo.nextCursor ?? undefined : undefined;
    if (!cursor) return { entries, hasMore: false };
  }
  return { entries, hasMore: true };
}

export async function readRoster(serverId: string): Promise<Roster> {
  const paseo = getPaseoClient(serverId);
  const [projectResult, workspaceResult, agentResult] = await Promise.all([
    paseo.projects.list(),
    paseo.workspaces.list({ page: { limit: 200 } }),
    readAgents(paseo),
  ]);
  const agents = agentResult.entries.map(({ agent }) => toAgent(agent));
  const outside = await lookUpMissingParents(agents, async id => (await paseo.agents.ref(id).refresh())?.agent ?? null);
  return {
    projects: projectResult.projects.map((project) => ({
      id: project.projectId,
      name: project.projectCustomName || project.projectDisplayName,
    })),
    workspaces: workspaceResult.entries.map(workspace => toWorkspace(workspace, agents)),
    agents,
    outsideParents: outside.parents,
    unreadParents: outside.unread,
    observedAt: new Date().toISOString(),
    hasMore: workspaceResult.pageInfo.hasMore || agentResult.hasMore,
  };
}

/** A host's workspaces and first page of agents, without projects or parent lookups: enough for chat bubbles' counts. */
export async function readHostActivity(serverId: string): Promise<Pick<Roster, "workspaces" | "agents">> {
  const paseo = getPaseoClient(serverId);
  const [workspaceResult, agentResult] = await Promise.all([paseo.workspaces.list({ page: { limit: 200 } }), paseo.agents.list({ page: { limit: 200 } })]);
  const agents = agentResult.entries.map(({ agent }) => toAgent(agent));
  return { workspaces: workspaceResult.entries.map(workspace => toWorkspace(workspace, agents)), agents };
}

export const rosterKey = (serverId: string) => ["mission-control", "roster", serverId] as const;

/** One host's roster query; every view uses these options, so they share one cache and refresh. */
export function rosterQuery(serverId: string, online: boolean) {
  return {
    queryKey: rosterKey(serverId),
    queryFn: () => readRoster(serverId),
    enabled: online,
    staleTime: 10_000,
    refetchInterval: online ? 20_000 : false as const,
    retry: 1,
  };
}

export function useRoster(serverId: string, online: boolean) {
  return useQuery(rosterQuery(serverId, online));
}

/** Starts a host's agent and workspace directory subscriptions; any snapshot or update calls changed. */
function listenToDirectory(serverId: string, changed: () => void): () => void {
  const paseo = getPaseoClient(serverId);
  let closed = false;
  const cleanups: (() => void)[] = [];
  const observe = (start: Promise<{ subscription: { subscribe(observer: { snapshot(): void; update(): void }): () => void; release(): Promise<void> } }>) => {
    void start.then(({ subscription }) => {
      if (closed) { void subscription.release().catch(() => {}); return; }
      const remove = subscription.subscribe({ snapshot: changed, update: changed });
      cleanups.push(() => { remove(); void subscription.release().catch(() => {}); });
    }).catch(() => { /* The query's backstop refresh still runs. */ });
  };
  observe(paseo.agents.list({ subscribe: {} }));
  observe(paseo.workspaces.list({ subscribe: {} }));
  return () => { closed = true; for (const cleanup of cleanups.splice(0)) cleanup(); };
}

let liveQueryClient: QueryClient | null = null;
const retainLiveRoster = createLiveRosters(listenToDirectory, serverId => void liveQueryClient?.invalidateQueries({ queryKey: rosterKey(serverId) }));

/**
 * Keeps a host's roster current from Paseo's agent and workspace subscriptions while the calling view
 * is mounted. Every view shares one subscription per host; there are no per-agent subscriptions.
 */
export function useLiveRoster(serverId: string, online: boolean) {
  const queryClient = useQueryClient();
  liveQueryClient = queryClient;
  useEffect(() => online && serverId ? retainLiveRoster(serverId) : undefined, [serverId, online]);
}
