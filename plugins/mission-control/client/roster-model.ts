import type { PaseoAgent, PaseoWorkspace } from "@getpaseo/client";
import { agentDisplayName } from "../shared/agent-names";
import { hideSecrets } from "../shared/secret-mask";
import { parentAgentIdOf, subagentContextLine, TASK_LABEL, type SubagentContext } from "../shared/subagents";
import type { PermissionRequest } from "./permissions";

// The roster's shapes and the rules that read it, without the Paseo client, so tests can load them.

export type Project = { id: string; name: string };
export type Workspace = {
  id: string;
  projectId: string;
  projectName: string;
  name: string;
  status: string;
  activityAt: string | null;
  labels: string[];
  // From Paseo's own Git and forge reads on the workspace's host, when it has them.
  branch?: string | null;
  diffStat?: { additions: number; deletions: number } | null;
  dirty?: boolean | null;
  aheadOfOrigin?: number | null;
  pullRequest?: WorkspacePullRequest | null;
};
export type WorkspacePullRequest = {
  number: number | null;
  url: string;
  title: string;
  state: string;
  draft: boolean;
  merged: boolean;
  checks: string | null;
  reviewDecision: string | null;
};
export type Agent = {
  id: string;
  workspaceId: string | null;
  name: string;
  focus: string | null;
  provider: string;
  model: string | null;
  reasoningLevel: string | null;
  status: string;
  createdAt: string;
  updatedAt: string;
  lastUserMessageAt: string | null;
  role: string | null;
  parentAgentId: string | null;
  // The Mission Control task the agent was started for.
  taskId: string | null;
  requiresAttention: boolean;
  attentionReason: string | null;
  attentionTimestamp: string | null;
  permissions: PermissionRequest[];
  activeTurn: boolean;
  activeTurnStartedAt: string | null;
  archivedAt: string | null;
  providerUnavailable: boolean;
  lastError: string | null;
  contextUsedPct: number | null;
  labels: Record<string, string>;
  // The agent's own summary of its work, when the daemon sends one (0.9.1 doesn't).
  summary: string | null;
};
export type Roster = {
  projects: Project[];
  workspaces: Workspace[];
  agents: Agent[];
  // Parents of listed agents that the list itself leaves out: archived, or past the page limit.
  outsideParents: Agent[];
  // Parents that couldn't be read (the lookup failed or was over its cap); they may still exist.
  unreadParents?: string[];
  observedAt: string;
  hasMore: boolean;
};

/** The agent's own summary, from a field newer daemons may send. */
function ownSummary(agent: PaseoAgent): string | null {
  const value: unknown = (agent as unknown as { summary?: unknown }).summary;
  return typeof value === "string" && value.trim() ? hideSecrets(value.trim()) : null;
}

/** Prefer the daemon's effective level; an absent value must not become a guessed model default. */
function reasoningLevelOf(agent: PaseoAgent): string | null {
  const id = agent.effectiveThinkingOptionId?.trim() || agent.thinkingOptionId?.trim();
  if (!id) return null;
  const labels: Record<string, string> = { none: "None", off: "Off", minimal: "Minimal", low: "Low", medium: "Medium", high: "High", xhigh: "Extra high", "extra-high": "Extra high", extra_high: "Extra high", max: "Max", ultra: "Ultra", adaptive: "Adaptive" };
  return labels[id.toLowerCase()] ?? id;
}

export function toAgent(agent: PaseoAgent): Agent {
  return {
    id: agent.id,
    workspaceId: agent.workspaceId ?? null,
    name: agentDisplayName(agent),
    focus: agent.title || null,
    provider: agent.provider,
    model: agent.model,
    reasoningLevel: reasoningLevelOf(agent),
    status: agent.status,
    createdAt: agent.createdAt,
    updatedAt: agent.updatedAt,
    lastUserMessageAt: agent.lastUserMessageAt,
    role: agent.labels["mission-control.role"] || null,
    parentAgentId: parentAgentIdOf(agent),
    taskId: agent.labels[TASK_LABEL] || null,
    // Paseo's attention flag can stay false while a permission prompt waits, so count prompts too.
    requiresAttention: agent.requiresAttention === true || (agent.pendingPermissions?.length ?? 0) > 0,
    attentionReason: agent.pendingPermissions?.length ? "permission" : agent.attentionReason ?? null,
    attentionTimestamp: agent.attentionTimestamp ?? null,
    permissions: agent.pendingPermissions ?? [],
    activeTurn: Boolean(agent.activeTurn),
    activeTurnStartedAt: agent.activeTurn?.startedAt ?? null,
    archivedAt: agent.archivedAt ?? null,
    providerUnavailable: agent.providerUnavailable === true,
    // Providers echo part of a rejected key in their errors; every screen reads agent errors from here.
    lastError: agent.lastError ? hideSecrets(agent.lastError) : null,
    contextUsedPct: agent.lastUsage?.contextWindowUsedTokens !== undefined && agent.lastUsage.contextWindowMaxTokens
      ? Math.round(agent.lastUsage.contextWindowUsedTokens / agent.lastUsage.contextWindowMaxTokens * 100) : null,
    labels: { ...agent.labels },
    summary: ownSummary(agent),
  };
}

/** The latest of these timestamps, or null when none is set. */
function latestOf(values: readonly (string | null | undefined)[]): string | null {
  let latest: string | null = null;
  for (const value of values) if (value && !Number.isNaN(Date.parse(value)) && (!latest || Date.parse(value) > Date.parse(latest))) latest = value;
  return latest;
}

/**
 * A Paseo workspace for the roster. Paseo can leave activityAt empty (it did for a whole remote host),
 * so the workspace then shows its agents' latest activity, or when it entered its current status.
 */
export function toWorkspace(workspace: PaseoWorkspace, agents: readonly Pick<Agent, "workspaceId" | "updatedAt">[]): Workspace {
  const git = workspace.gitRuntime ?? null;
  const pr = workspace.githubRuntime?.pullRequest ?? null;
  return {
    id: workspace.id,
    projectId: workspace.projectId,
    projectName: workspace.projectCustomName || workspace.projectDisplayName,
    name: workspace.title || workspace.name,
    status: workspace.status,
    activityAt: workspace.activityAt ?? latestOf([...agents.filter(agent => agent.workspaceId === workspace.id).map(agent => agent.updatedAt), workspace.statusEnteredAt]),
    labels: workspace.labels ?? [],
    branch: git?.currentBranch ?? null,
    diffStat: workspace.diffStat ?? null,
    dirty: git?.isDirty ?? null,
    aheadOfOrigin: git?.aheadOfOrigin ?? null,
    pullRequest: pr ? {
      number: pr.number ?? null, url: pr.url, title: pr.title, state: pr.state, draft: pr.isDraft === true, merged: pr.isMerged,
      checks: pr.checksStatus ?? null, reviewDecision: pr.reviewDecision ?? null,
    } : null,
  };
}

/** Parent IDs the agents name that aren't among them, in first-seen order. */
export function missingParentIds(agents: readonly Pick<Agent, "id" | "parentAgentId">[]): string[] {
  const ids = new Set(agents.map(agent => agent.id));
  return [...new Set(agents.flatMap(agent => agent.parentAgentId && !ids.has(agent.parentAgentId) ? [agent.parentAgentId] : []))];
}

// At most this many missing parents are looked up per refresh.
export const PARENT_LOOKUPS = 10;

/**
 * The parents the agent list leaves out (archived, or past its page limit), looked up one by one.
 * A parent Paseo says doesn't exist is left out, and the context line says it is gone. unread lists
 * the ones whose lookup failed or went over the cap: they may exist, so the line says they can't be found.
 */
export async function lookUpMissingParents(agents: readonly Agent[], readAgent: (id: string) => Promise<PaseoAgent | null>): Promise<{ parents: Agent[]; unread: string[] }> {
  const missing = missingParentIds(agents);
  const unread = missing.slice(PARENT_LOOKUPS);
  const found = await Promise.all(missing.slice(0, PARENT_LOOKUPS).map(async id => {
    try { return await readAgent(id); } catch { unread.push(id); return null; }
  }));
  return { parents: found.flatMap(agent => agent ? [toAgent(agent)] : []), unread };
}

/** The agents started for a task, leaving out any that another of them started: those are its sub-agents. */
export function agentsForTask(agents: readonly Agent[], taskId: string): Agent[] {
  const own = agents.filter(agent => agent.taskId === taskId);
  const ids = new Set(own.map(agent => agent.id));
  return own.filter(agent => !agent.parentAgentId || !ids.has(agent.parentAgentId));
}

type ContextRoster = Pick<Roster, "agents" | "outsideParents" | "workspaces" | "unreadParents">;

/** Any agent the roster knows, including parents it looked up separately. */
export function findAgent(roster: Pick<Roster, "agents" | "outsideParents">, id: string): Agent | null {
  return roster.agents.find(agent => agent.id === id) ?? roster.outsideParents.find(agent => agent.id === id) ?? null;
}

/** What the context line says about a child agent: its parent, the parent's task, and where the parent works. */
export function subagentContextOf(roster: ContextRoster, parentAgentId: string, taskTitles: Record<string, string> = {}): SubagentContext {
  const parent = findAgent(roster, parentAgentId);
  const workspace = parent?.workspaceId ? roster.workspaces.find(candidate => candidate.id === parent.workspaceId) : undefined;
  return {
    parentName: parent?.name ?? null,
    parentUnread: !parent && Boolean(roster.unreadParents?.includes(parentAgentId)),
    parentArchived: Boolean(parent?.archivedAt),
    taskTitle: parent?.taskId ? taskTitles[parent.taskId] ?? null : null,
    projectName: workspace?.projectName ?? null,
    workspaceName: workspace?.name ?? null,
  };
}

/** The context line for an agent another agent started; null for an agent nobody started. */
export function contextLineFor(roster: ContextRoster, agent: Pick<Agent, "parentAgentId">, taskTitles: Record<string, string> = {}): string | null {
  return agent.parentAgentId ? subagentContextLine(subagentContextOf(roster, agent.parentAgentId, taskTitles)) : null;
}
