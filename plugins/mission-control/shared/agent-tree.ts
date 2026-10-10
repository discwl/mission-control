// The Agents panel's tree, states, search and confirmation wording, without React or the Paseo client.
// The tree builder is adapted from Agent Crew's client/crew.ts (MIT, Copyright (c) 2026 Omer Cohen);
// see THIRD_PARTY_NOTICES.md.
import { paseoParentOf, subagentKindLabel, type Helper } from "./subagents";

/** The fields of an agent the tree reads; the roster's Agent has all of them. */
export type TreeAgent = {
  id: string;
  workspaceId: string | null;
  parentAgentId: string | null;
  name: string;
  provider: string;
  model: string | null;
  status: string;
  createdAt: string;
  updatedAt: string;
  archivedAt: string | null;
  requiresAttention: boolean;
  attentionReason: string | null;
  attentionTimestamp: string | null;
  activeTurnStartedAt: string | null;
  permissions: readonly unknown[];
  lastError: string | null;
  labels: Readonly<Record<string, string>>;
  taskId: string | null;
  role: string | null;
};

export type AgentState = "needs-input" | "failed" | "working" | "ready" | "idle" | "closed";

// The filter chips' order.
export const AGENT_STATES: readonly AgentState[] = ["needs-input", "failed", "working", "ready", "idle", "closed"];

export const AGENT_STATE_LABELS: Record<AgentState, string> = {
  "needs-input": "Needs input",
  failed: "Failed",
  working: "Working",
  ready: "Ready",
  idle: "Idle",
  closed: "Closed",
};

// When activity timestamps tie, siblings sort by what most likely needs you first.
const SORT_ORDER: Record<AgentState, number> = { "needs-input": 0, failed: 1, ready: 2, working: 3, idle: 4, closed: 5 };

/**
 * One agent's state. Precedence: Failed, Needs input, Working, Ready, Closed, Idle. An agent that
 * failed is never shown as one that can simply resume. waiting counts what Mission Control holds for
 * it: open decisions and, once task 24 merges, recorded questions.
 */
export function agentState(agent: Pick<TreeAgent, "status" | "requiresAttention" | "attentionReason" | "permissions">, waiting = 0): AgentState {
  if (agent.status === "error" || (agent.requiresAttention && agent.attentionReason === "error")) return "failed";
  if (agent.permissions.length > 0 || agent.attentionReason === "permission" || waiting > 0) return "needs-input";
  if (agent.status === "running" || agent.status === "initializing") return "working";
  if (agent.requiresAttention || agent.attentionReason === "finished") return "ready";
  if (agent.status === "closed") return "closed";
  return "idle";
}

/** A helper's state; a finished or stopped helper is closed. */
export function helperState(helper: Pick<Helper, "status">): AgentState {
  if (helper.status === "running") return "working";
  if (helper.status === "error") return "failed";
  if (helper.status === "idle") return "idle";
  return "closed";
}

export function isWorking(agent: Pick<TreeAgent, "status">): boolean {
  return agent.status === "running" || agent.status === "initializing";
}

/** What each agent is waiting on in Mission Control: open decisions by agent, plus recorded questions. */
export function waitingByAgent(decisions: readonly { agentId: string | null }[], questions: readonly { agentId: string | null }[] = []): Map<string, number> {
  const counts = new Map<string, number>();
  for (const entry of [...decisions, ...questions]) if (entry.agentId) counts.set(entry.agentId, (counts.get(entry.agentId) ?? 0) + 1);
  return counts;
}

export type AgentTreeNode<T extends TreeAgent> = {
  kind: "agent";
  agent: T;
  depth: number;
  state: AgentState;
  // Open decisions and questions for this agent.
  waiting: number;
  // Sub-agents below it in this tree, at any depth; helpers are counted apart.
  descendants: number;
  // Helpers inside its turns, and how many of them are running.
  helpers: number;
  runningHelpers: number;
  // Part of this workspace's crews. False for an ancestor from another workspace shown only to explain a member.
  member: boolean;
  // Dimmed: an ancestor from elsewhere, or a row kept only because something below it matches the filter.
  contextOnly: boolean;
  // Its parent isn't a crew row above it: a dimmed ancestor from elsewhere, archived, or not found.
  parentOutside: boolean;
};
export type HelperTreeNode = { kind: "helper"; helper: Helper; parentId: string; parentName: string; depth: number; state: AgentState; label: string };
// "N finished helpers": a fold that lists them when open.
export type FinishedHelpersNode = { kind: "finished-helpers"; parentId: string; depth: number; count: number; open: boolean };
export type TreeNode<T extends TreeAgent> = AgentTreeNode<T> | HelperTreeNode | FinishedHelpersNode;

export type AgentTreeOptions = {
  state?: AgentState | null;
  query?: string;
  workspaceNames?: ReadonlyMap<string, string>;
  taskTitles?: Readonly<Record<string, string>>;
  waiting?: ReadonlyMap<string, number>;
  helpers?: ReadonlyMap<string, readonly Helper[]>;
  // Parents whose finished helpers are listed one by one instead of as a count.
  openFinished?: ReadonlySet<string>;
};

export const nodeKey = <T extends TreeAgent>(node: TreeNode<T>): string =>
  node.kind === "agent" ? node.agent.id : node.kind === "helper" ? `helper:${node.parentId}:${node.helper.id}` : `finished:${node.parentId}`;

const lower = (value: string | null | undefined) => (value ?? "").toLowerCase();

/** Whether an agent matches the search: title, ID, provider, model, task, workspace, role and labels. */
export function agentMatches(agent: TreeAgent, query: string, options: Pick<AgentTreeOptions, "workspaceNames" | "taskTitles"> = {}): boolean {
  const needle = query.trim().toLowerCase();
  if (!needle) return true;
  const values = [
    agent.name, agent.id, agent.provider, agent.model, agent.role, agent.taskId,
    agent.taskId ? options.taskTitles?.[agent.taskId] : null,
    agent.workspaceId ? options.workspaceNames?.get(agent.workspaceId) : null,
    ...Object.entries(agent.labels).flatMap(([key, value]) => [key, value]),
  ];
  return values.some(value => lower(value).includes(needle));
}

export function helperMatches(helper: Helper, query: string): boolean {
  const needle = query.trim().toLowerCase();
  return !needle || [helper.title, helper.description, helper.id, "helper"].some(value => lower(value).includes(needle));
}

/**
 * The workspace's crews in display order: every non-archived agent in the workspace, with its
 * sub-agents at any depth even when they work in another workspace, and the ancestors from other
 * workspaces needed to explain a local agent (dimmed, open-only). Unrelated branches are pruned,
 * archived agents are left out, and malformed parent cycles are bounded. With a state or search
 * filter, a row that doesn't match stays, dimmed, only when something below it matches.
 */
export function buildAgentTree<T extends TreeAgent>(agents: readonly T[], workspaceId: string, options: AgentTreeOptions = {}): TreeNode<T>[] {
  const byId = new Map(agents.filter(agent => !agent.archivedAt).map(agent => [agent.id, agent]));
  const waiting = options.waiting ?? new Map<string, number>();
  const stateOf = (agent: T) => agentState(agent, waiting.get(agent.id) ?? 0);
  // Match the activity age displayed on each row, newest first, while keeping children under parents.
  const compare = (a: T, b: T) =>
    agentAgeTimestamp(b) - agentAgeTimestamp(a) ||
    SORT_ORDER[stateOf(a)] - SORT_ORDER[stateOf(b)] || Date.parse(a.createdAt) - Date.parse(b.createdAt) || a.id.localeCompare(b.id);
  const children = new Map<string, T[]>();
  for (const agent of byId.values()) {
    if (!agent.parentAgentId) continue;
    children.set(agent.parentAgentId, [...children.get(agent.parentAgentId) ?? [], agent]);
  }
  for (const list of children.values()) list.sort(compare);

  // Members: the workspace's own agents and all their sub-agents, wherever they work.
  const local = [...byId.values()].filter(agent => agent.workspaceId === workspaceId);
  const members = new Set(local.map(agent => agent.id));
  const queue = [...members];
  for (let index = 0; index < queue.length; index++) {
    for (const child of children.get(queue[index]) ?? []) {
      if (members.has(child.id)) continue;
      members.add(child.id);
      queue.push(child.id);
    }
  }
  // Context: the ancestors of local agents that aren't members themselves.
  const context = new Set<string>();
  for (const agent of local) {
    const seen = new Set([agent.id]);
    let parentId = agent.parentAgentId;
    while (parentId && !seen.has(parentId)) {
      seen.add(parentId);
      const parent = byId.get(parentId);
      if (!parent) break;
      if (!members.has(parentId)) context.add(parentId);
      parentId = parent.parentAgentId;
    }
  }
  const visible = new Set([...members, ...context]);
  const visibleAgents = [...visible].map(id => byId.get(id)!).sort(compare);

  const query = options.query ?? "";
  const filter = options.state ?? null;
  const filtering = filter !== null || query.trim() !== "";
  const matches = (agent: T) => members.has(agent.id) && (filter === null || stateOf(agent) === filter) && agentMatches(agent, query, options);

  function countDescendants(id: string): number {
    const seen = new Set([id]);
    const pending = [...children.get(id) ?? []];
    let total = 0;
    while (pending.length) {
      const child = pending.pop()!;
      if (seen.has(child.id) || !visible.has(child.id)) continue;
      seen.add(child.id);
      if (members.has(child.id)) total++;
      pending.push(...children.get(child.id) ?? []);
    }
    return total;
  }

  function helperRows(agent: T, depth: number): TreeNode<T>[] {
    if (!members.has(agent.id)) return [];
    const list = options.helpers?.get(agent.id) ?? [];
    const row = (helper: Helper): HelperTreeNode => ({
      kind: "helper", helper, parentId: agent.id, parentName: agent.name, depth, state: helperState(helper),
      label: subagentKindLabel("helper", agent.name),
    });
    if (filtering) {
      return list.filter(helper => (filter === null || helperState(helper) === filter) && helperMatches(helper, query)).map(row);
    }
    const running = list.filter(helper => helper.status === "running");
    const finished = list.filter(helper => helper.status !== "running");
    if (!finished.length) return running.map(row);
    const open = Boolean(options.openFinished?.has(agent.id));
    return [...running.map(row), { kind: "finished-helpers", parentId: agent.id, depth, count: finished.length, open }, ...open ? finished.map(row) : []];
  }

  const emitted = new Set<string>();
  function visit(agent: T, depth: number, path: ReadonlySet<string>, parentOutside: boolean): TreeNode<T>[] {
    if (path.has(agent.id) || emitted.has(agent.id)) return [];
    const nextPath = new Set(path).add(agent.id);
    const helpers = helperRows(agent, depth + 1);
    // A child under a dimmed ancestor from elsewhere still says whose it is.
    const below = (children.get(agent.id) ?? []).flatMap(child => visible.has(child.id) ? visit(child, depth + 1, nextPath, !members.has(agent.id)) : []);
    const self = matches(agent);
    if (!self && !helpers.length && !below.length) return [];
    emitted.add(agent.id);
    const list = options.helpers?.get(agent.id) ?? [];
    return [{
      kind: "agent", agent, depth, state: stateOf(agent), waiting: waiting.get(agent.id) ?? 0,
      descendants: countDescendants(agent.id),
      helpers: members.has(agent.id) ? list.length : 0,
      runningHelpers: members.has(agent.id) ? list.filter(helper => helper.status === "running").length : 0,
      member: members.has(agent.id), contextOnly: !self, parentOutside,
    }, ...helpers, ...below];
  }

  const nodes: TreeNode<T>[] = [];
  for (const agent of visibleAgents) {
    if (agent.parentAgentId && agent.parentAgentId !== agent.id && visible.has(agent.parentAgentId)) continue;
    nodes.push(...visit(agent, 0, new Set(), Boolean(agent.parentAgentId)));
  }
  // Agents whose parents only point at each other have no root; list them rather than lose them.
  // Ancestors from elsewhere go first, so a local agent in such a loop still sits under one.
  for (const agent of [...visibleAgents].sort((a, b) => Number(members.has(a.id)) - Number(members.has(b.id)))) {
    if (!emitted.has(agent.id)) nodes.push(...visit(agent, 0, new Set(), Boolean(agent.parentAgentId)));
  }
  return nodes;
}

/** Hides the rows below each collapsed agent. */
export function collapseTree<T extends TreeAgent>(nodes: readonly TreeNode<T>[], collapsed: ReadonlySet<string>): TreeNode<T>[] {
  const shown: TreeNode<T>[] = [];
  let hiddenBelow: number | null = null;
  for (const node of nodes) {
    if (hiddenBelow !== null && node.depth > hiddenBelow) continue;
    hiddenBelow = null;
    shown.push(node);
    if (node.kind === "agent" && collapsed.has(node.agent.id) && (node.descendants > 0 || node.helpers > 0)) hiddenBelow = node.depth;
  }
  return shown;
}

export type TreeSummary = { agents: number; helpers: number; runningHelpers: number; crews: number; elsewhere: number; counts: Record<AgentState, number> };

/**
 * Counts for the header and the filter chips, from an unfiltered tree. Chips count agents and
 * helpers by state; a crew is a top row with sub-agents.
 */
export function summarizeTree<T extends TreeAgent>(nodes: readonly TreeNode<T>[], workspaceId: string, allHelpers?: ReadonlyMap<string, readonly Helper[]>): TreeSummary {
  const counts: Record<AgentState, number> = { "needs-input": 0, failed: 0, working: 0, ready: 0, idle: 0, closed: 0 };
  let agents = 0, crews = 0, elsewhere = 0, helpers = 0, runningHelpers = 0;
  for (const node of nodes) {
    if (node.kind !== "agent") continue;
    // A crew is a top row with sub-agents, even a dimmed ancestor from elsewhere that started this workspace's agents.
    if (node.depth === 0 && node.descendants > 0) crews++;
    if (!node.member) continue;
    agents++;
    counts[node.state]++;
    if (node.agent.workspaceId !== workspaceId) elsewhere++;
    // Every helper of a member, including finished ones folded into a count.
    for (const helper of allHelpers?.get(node.agent.id) ?? []) {
      helpers++;
      counts[helperState(helper)]++;
      if (helper.status === "running") runningHelpers++;
    }
  }
  return { agents, helpers, runningHelpers, crews, elsewhere, counts };
}

/** Every sub-agent below an agent, at any depth, in or out of its workspace; archived agents excluded. */
export function subAgentsOf<T extends TreeAgent>(agents: readonly T[], agentId: string): T[] {
  const found: T[] = [];
  const seen = new Set([agentId]);
  const pending = [agentId];
  while (pending.length) {
    const id = pending.pop()!;
    for (const agent of agents) {
      if (agent.archivedAt || agent.parentAgentId !== id || seen.has(agent.id)) continue;
      seen.add(agent.id);
      found.push(agent);
      pending.push(agent.id);
    }
  }
  return found;
}

// Paseo marks an agent open in a client's tab with this label prefix and the value "true".
const OPEN_TAB_LABEL = "paseo.open-agent-tab.";
const openInTab = (labels: Readonly<Record<string, string>>) => Object.entries(labels).some(([key, value]) => key.startsWith(OPEN_TAB_LABEL) && value === "true");

/**
 * What archiving an agent does to its sub-agents, as Paseo's daemon cascades it along its own parent
 * label: a child in the same workspace is archived too, and the same then applies to its children; a
 * child in another workspace, or open in its own tab, is detached and keeps running with its own
 * sub-agents. A child linked only by Mission Control's older label is left as it is (untouched).
 */
export function archiveOutcome<T extends TreeAgent>(agents: readonly T[], agentId: string): { archived: number; detached: number; untouched: number } {
  const byId = new Map(agents.map(agent => [agent.id, agent]));
  let archived = 0, detached = 0, untouched = 0;
  const seen = new Set([agentId]);
  const pending = [agentId];
  while (pending.length) {
    const parent = byId.get(pending.pop()!);
    for (const child of agents) {
      if (!parent || child.archivedAt || child.parentAgentId !== parent.id || seen.has(child.id)) continue;
      seen.add(child.id);
      if (paseoParentOf(child) !== parent.id) { untouched++; continue; }
      const elsewhere = Boolean(parent.workspaceId && child.workspaceId && parent.workspaceId !== child.workspaceId);
      if (elsewhere || openInTab(child.labels)) { detached++; continue; }
      archived++;
      pending.push(child.id);
    }
  }
  return { archived, detached, untouched };
}

/** Whether Paseo can detach this agent: only its own parent label can be removed. */
export function canDetach(agent: Pick<TreeAgent, "labels">): boolean {
  return paseoParentOf(agent) !== null;
}

/** When an agent last did something: its attention time, else when its turn started, else its last update. */
export function agentAgeTimestamp(agent: Pick<TreeAgent, "attentionTimestamp" | "activeTurnStartedAt" | "updatedAt">): number {
  const value = Date.parse(agent.attentionTimestamp ?? agent.activeTurnStartedAt ?? agent.updatedAt ?? "");
  return Number.isFinite(value) ? value : 0;
}

export function formatAge(timestamp: number, now: number): string {
  if (timestamp <= 0) return "";
  const seconds = Math.max(0, Math.floor((now - timestamp) / 1000));
  if (seconds < 60) return "now";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  return `${Math.floor(hours / 24)}d`;
}

const STAGES: [string, string[]][] = [["Plan", ["intake", "plan"]], ["Build", ["execute", "fix"]], ["Validate", ["validate"]], ["Review", ["review"]], ["Handoff", ["delivery", "handoff"]]];

/** A Dev Flow run stage in the Mission panel's step names. */
export function runStageLabel(stage: string): string {
  return STAGES.find(([, stages]) => stages.includes(stage))?.[0] ?? stage;
}

/** Text as one line: markdown marks dropped, spaces collapsed, cut at max characters. */
export function oneLine(value: string, max = 160): string | null {
  const line = value.replace(/```[\s\S]*?```/g, " ").replace(/[*`#>]+/g, "").replace(/\s+/g, " ").trim();
  if (!line) return null;
  return line.length > max ? `${line.slice(0, max - 1).trimEnd()}…` : line;
}

export type AgentRunSummary = { stage: string; outcome: string; nextAction: string };

/**
 * "Where it's at" in one line: the agent's own summary, else what its Dev Flow run says it does next,
 * else its latest message.
 */
export function whereItsAt({ summary, run, message }: { summary?: string | null; run?: AgentRunSummary | null; message?: string | null }): string | null {
  const own = summary ? oneLine(summary) : null;
  if (own) return own;
  if (run && run.nextAction.trim()) {
    const outcome = run.outcome === "in_progress" || run.outcome === "completed" ? "" : ` · ${run.outcome.replaceAll("_", " ")}`;
    return oneLine(`${runStageLabel(run.stage)}${outcome} · next: ${run.nextAction}`);
  }
  return message ? oneLine(message) : null;
}

export type ConfirmAction = "reply" | "redirect" | "detach" | "archive";
export type ConfirmCopy = { title: string; body: string; confirm: string };

const count = (value: number, one: string, many: string) => `${value} ${value === 1 ? one : many}`;

/**
 * The plain words each action is confirmed with. subAgents counts every sub-agent below the agent
 * (Detach); archivedWithIt, detachedFromIt and untouched are archiveOutcome's counts (Archive);
 * runningHelpers counts the helpers running inside its turn.
 */
export function confirmCopy(action: ConfirmAction, context: {
  name: string; state: AgentState; permissions?: number; parentName?: string | null;
  subAgents?: number; archivedWithIt?: number; detachedFromIt?: number; untouched?: number; runningHelpers?: number;
}): ConfirmCopy {
  const { name } = context;
  const here = context.archivedWithIt ?? 0;
  const elsewhere = context.detachedFromIt ?? 0;
  const untouched = context.untouched ?? 0;
  const helpers = context.runningHelpers ?? 0;
  if (action === "redirect") {
    return {
      title: `Interrupt and redirect ${name}?`,
      body: `${name} is working. Sending this stops its current turn now, and it starts on your message instead. Anything that turn hadn't finished is left as it is.`,
      confirm: "Stop the turn and send",
    };
  }
  if (action === "reply") {
    if (context.permissions) {
      return {
        title: `Reply to ${name}?`,
        body: `${name} is waiting for you to allow or deny a request. Sending a message dismisses that request, and it starts on your message instead.`,
        confirm: "Dismiss the request and send",
      };
    }
    return {
      title: `Reply to ${name}`,
      body: context.state === "needs-input"
        ? `${name} gets your message as its next prompt and starts on it now. A message doesn't answer its open decision or question; answer those in Attention.`
        : `${name} gets your message as its next prompt and starts on it now.`,
      confirm: "Send reply",
    };
  }
  if (action === "detach") {
    const total = context.subAgents ?? 0;
    return {
      title: `Detach ${name}?`,
      body: `${name} stops being a sub-agent of ${context.parentName ?? "its parent"} and carries on as an agent of its own${total ? `, and its ${count(total, "sub-agent goes", "sub-agents go")} with it` : ""}. Nothing is stopped or archived.`,
      confirm: "Detach",
    };
  }
  const parts = [
    `This stops ${name}, including any work it is doing now, and removes it from the list.`,
    here ? `Its ${count(here, "sub-agent", "sub-agents")} in the same workspace ${here === 1 ? "is" : "are"} archived with it.` : null,
    elsewhere ? `Its ${count(elsewhere, "sub-agent", "sub-agents")} in other workspaces or open in ${elsewhere === 1 ? "its own tab is" : "their own tabs are"} detached and ${elsewhere === 1 ? "keeps" : "keep"} running.` : null,
    untouched ? `Its ${count(untouched, "sub-agent", "sub-agents")} linked the older way ${untouched === 1 ? "is" : "are"} left as ${untouched === 1 ? "it is and keeps" : "they are and keep"} running.` : null,
    helpers ? `The ${count(helpers, "helper", "helpers")} running inside its turn stop${helpers === 1 ? "s" : ""} with it.` : null,
    !here && !elsewhere && !untouched && !helpers ? "It has no sub-agents." : null,
    "Its workspace and Mission Control records are kept.",
  ];
  return { title: `Archive ${name}?`, body: parts.filter(Boolean).join(" "), confirm: "Archive" };
}

/** The permission dialog's plain-word explanation. */
export function permissionCopy(name: string, request: string): ConfirmCopy & { deny: string } {
  return {
    title: `Permission request from ${name}`,
    body: `${name} asks: ${request}. Allow lets it go ahead with this request. Deny tells it no, and it carries on without it.`,
    confirm: "Allow",
    deny: "Deny",
  };
}
