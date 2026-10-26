import type { PaseoApi, PaseoAgent, PaseoWorkspace } from "@getpaseo/client";
import type { DecisionEntry } from "../shared/decisions";
import type { QuestionEntry } from "../shared/questions";
import type { FleetAgent, FleetHost } from "../shared/fleet";
import { agentPageOrder, listIncludingBackground } from "../shared/background";
import { agentDisplayName } from "../shared/agent-names";
import { hideSecrets } from "../shared/secret-mask";
import { scanTaskSources } from "./tasks";
import { runRecordsOf } from "./runs";

export function toFleetAgent(agent: PaseoAgent): FleetAgent {
  const dates = [agent.lastUserMessageAt, agent.activeTurn?.startedAt, agent.attentionTimestamp].filter((date): date is string => Boolean(date)).sort();
  return {
    id: agent.id, name: agentDisplayName(agent), workspaceId: agent.workspaceId ?? null,
    status: agent.status, archivedAt: agent.archivedAt ?? null, labels: { ...agent.labels }, updatedAt: agent.updatedAt,
    activityAt: dates.at(-1) ?? null, pendingPermissions: agent.pendingPermissions?.length ?? 0,
    attention: agent.requiresAttention === true, attentionReason: agent.attentionReason ?? null,
    error: agent.lastError ? hideSecrets(agent.lastError) : null,
    inputTokens: agent.lastUsage?.inputTokens ?? null, outputTokens: agent.lastUsage?.outputTokens ?? null,
  };
}

export async function fleetDirectory(paseo: PaseoApi, serverId: string) {
  const agents: PaseoAgent[] = []; const workspaces: PaseoWorkspace[] = []; let complete = true;
  let cursor: string | undefined;
  for (let page = 0; page < 5; page++) {
    const result = await listIncludingBackground(serverId, {}, filter => paseo.agents.list({ filter, sort: agentPageOrder, page: { limit: 200, ...(cursor ? { cursor } : {}) } }));
    agents.push(...result.entries.map(entry => entry.agent));
    cursor = result.pageInfo.hasMore ? result.pageInfo.nextCursor ?? undefined : undefined;
    if (!result.pageInfo.hasMore) break;
    if (!cursor || page === 4) { complete = false; break; }
  }
  cursor = undefined;
  for (let page = 0; page < 5; page++) {
    const result = await listIncludingBackground(serverId, {}, filter => paseo.workspaces.list({ filter, page: { limit: 200, ...(cursor ? { cursor } : {}) } }));
    workspaces.push(...result.entries);
    cursor = result.pageInfo.hasMore ? result.pageInfo.nextCursor ?? undefined : undefined;
    if (!result.pageInfo.hasMore) break;
    if (!cursor || page === 4) { complete = false; break; }
  }
  return { agents, workspaces, complete };
}

export type FleetHostDeps = {
  decisions(serverId: string): Promise<{ open: DecisionEntry[]; recent: DecisionEntry[] }>;
  questions(serverId: string): Promise<{ questions: QuestionEntry[] }>;
  stoppedAgents(): Promise<string[]>;
};

export async function collectFleetHost(paseo: PaseoApi, serverId: string, deps: FleetHostDeps): Promise<FleetHost> {
  const [directory, scan, decisions, waiting, stoppedAgentIds] = await Promise.all([
    fleetDirectory(paseo, serverId), scanTaskSources(serverId), deps.decisions(serverId), deps.questions(serverId), deps.stoppedAgents(),
  ]);
  const warnings = scan.problems.map(problem => `${problem.file}: ${problem.problem}`);
  if (!directory.complete) warnings.push("The host roster is truncated; automatic dispatch is disabled.");
  if (scan.sources.length > 300) warnings.push("More than 300 tasks exist on this host; automatic dispatch is disabled until scope is narrowed.");
  const allDecisions = [...decisions.open, ...decisions.recent];
  const tasks = await Promise.all(scan.sources.slice(0, 300).map(async source => {
    let run = null; let problem: string | null = null;
    try { run = (await runRecordsOf(source, serverId))[0] ?? null; }
    catch (error) { problem = hideSecrets(error instanceof Error ? error.message : String(error)); }
    return { task: source.task, run, problem,
      decisions: allDecisions.filter(entry => entry.decision.taskId === source.task.taskId),
      questions: waiting.questions.filter(entry => entry.question.taskId === source.task.taskId),
    };
  }));
  return { serverId, observedAt: new Date().toISOString(), agents: directory.agents.map(toFleetAgent), tasks,
    workspaces: directory.workspaces.map(workspace => ({ id: workspace.id, name: workspace.title || workspace.name,
      projectName: workspace.projectCustomName || workspace.projectDisplayName, branch: workspace.gitRuntime?.currentBranch ?? null, labels: workspace.labels ?? [], status: workspace.status })),
    warnings, complete: directory.complete && scan.sources.length <= 300 && scan.problems.length === 0, stoppedAgentIds,
  };
}
