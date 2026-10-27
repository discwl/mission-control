import { getPaseoClient } from "@getpaseo/plugin/client";
import { agentPageOrder, listIncludingBackground } from "../shared/background";
import { toAgent, toWorkspace, type Agent } from "./roster-model";

/** Separate query from the active roster: history explicitly includes archived agents. */
export async function readWorkerRoster(serverId: string) {
  const paseo = getPaseoClient(serverId);
  const agents: Agent[] = [];
  let cursor: string | undefined;
  let hasMore = false;
  for (let page = 0; page < 5; page++) {
    const result = await listIncludingBackground(serverId, { includeArchived: true }, filter => paseo.agents.list({ filter, sort: agentPageOrder, page: { limit: 200, ...(cursor ? { cursor } : {}) } }));
    agents.push(...result.entries.map(({ agent }) => toAgent(agent)));
    hasMore = result.pageInfo.hasMore;
    cursor = hasMore ? result.pageInfo.nextCursor ?? undefined : undefined;
    if (!cursor) break;
  }
  const workspaces = await listIncludingBackground(serverId, {}, filter => paseo.workspaces.list({ filter, page: { limit: 200 } }));
  return { agents, workspaces: workspaces.entries.map(workspace => toWorkspace(workspace, agents)), hasMore: hasMore || workspaces.pageInfo.hasMore, observedAt: new Date().toISOString() };
}
