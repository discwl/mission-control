import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";

// Paseo labels an agent started by another agent (create_agent) with its parent's ID.
export const PARENT_AGENT_LABEL = "paseo.parent-agent-id";
// Mission Control's own earlier label for the same link; still read so older agents keep their parent.
const LEGACY_PARENT_LABEL = "mission-control.parent-agent-id";
// Set on agents Mission Control starts for a task.
export const TASK_LABEL = "mission-control.task-id";

/** Plain-word status for a sub-agent, whichever kind it is. */
export type SubagentStatus = "running" | "finished" | "idle" | "error" | "stopped";

const text = (value: unknown) => typeof value === "string" && value.trim() ? value.trim() : null;

/**
 * The agent that started this one: the parentAgentId field when the daemon sends it (newer SDKs),
 * else Paseo's label, else Mission Control's older label.
 */
export function parentAgentIdOf(agent: { labels?: Record<string, string> | null; parentAgentId?: unknown }): string | null {
  return text(agent.parentAgentId) ?? text(agent.labels?.[PARENT_AGENT_LABEL]) ?? text(agent.labels?.[LEGACY_PARENT_LABEL]);
}

/** Paseo's own parent link: the label its Detach, and its Archive cascade, follow. */
export function paseoParentOf(agent: { labels?: Record<string, string> | null }): string | null {
  return text(agent.labels?.[PARENT_AGENT_LABEL]);
}

export type QueryableAgent = { id: string; status: string; archivedAt?: string | null; providerUnavailable?: boolean };

/**
 * Whether Mission Control may ask Paseo about an agent without the user asking: read its chat, or list
 * the helpers inside its turns. To answer either, Paseo loads a stored agent, which restarts one that
 * has stopped. So a closed or errored agent, an archived one, or one whose provider is unavailable, is
 * asked about only when the user asks (askedByUser).
 *
 * Used by: the agent tree's latest-message line, the "started for" line (PurposeLine and the task
 * cards' sub-agent entries), and every helper list, through helperQueryPlan (the tree and task 25's
 * task cards) and again on the server just before it asks Paseo (server/subagents.ts). Not used by
 * name suggestions, which read chats only when the user presses Suggest; that is a tracked follow-up.
 *
 * Known gap: Paseo lists a stored agent with its last recorded status. After an unclean daemon exit, or
 * a close that timed out, a stopped agent can still be recorded as idle or running. This rule then lets
 * it be asked about, which restarts it. Nothing in the agent list tells such an agent apart from a
 * loaded one.
 */
export function mayQueryAgent(agent: Omit<QueryableAgent, "id">, askedByUser = false): boolean {
  if (askedByUser) return true;
  if (agent.archivedAt || agent.providerUnavailable) return false;
  return agent.status === "running" || agent.status === "initializing" || agent.status === "idle";
}

const TASK_PROMPT = /^Work on Mission Control task (task_[a-f0-9-]+):\s*(.*?)\.?$/;

/**
 * A first prompt's line with Mission Control task IDs replaced by the task's number and title, such as
 * "Work on task 26 · Agents panel" for Mission Control's own task prompt. An unknown task shows the
 * start of its ID.
 */
export function readablePurpose(line: string, taskTitles: Record<string, string> = {}): string {
  const own = TASK_PROMPT.exec(line);
  if (own) return `Work on task ${taskTitles[own[1]] ?? (own[2] || own[1].slice(5, 13))}`;
  return line.replace(/\b(?:task )?(task_[a-f0-9]{8}[a-f0-9-]*)/g, (_match, id: string) => `task ${taskTitles[id] ?? id.slice(5, 13)}`);
}

/** A helper's status (Paseo reports running, completed, failed or canceled) in plain words. */
export function helperStatus(status: string): SubagentStatus {
  if (status === "running") return "running";
  if (status === "completed") return "finished";
  if (status === "failed") return "error";
  if (status === "canceled") return "stopped";
  return "idle";
}

/** A separate agent's Paseo status (initializing, idle, running, error, closed) in plain words. */
export function childStatus(status: string): SubagentStatus {
  if (status === "running" || status === "initializing") return "running";
  if (status === "error") return "error";
  if (status === "closed") return "finished";
  return "idle";
}

export const helperSchema = z.object({
  id: z.string(),
  parentAgentId: z.string(),
  // The helper's kind, such as "Explore"; its description says what it was started for.
  title: z.string().nullable(),
  description: z.string().nullable(),
  status: z.enum(["running", "finished", "idle", "error", "stopped"]),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type Helper = z.infer<typeof helperSchema>;

export const helperMessageSchema = z.object({ role: z.enum(["user", "assistant"]), text: z.string(), timestamp: z.string() });
export type HelperMessage = z.infer<typeof helperMessageSchema>;

const record = (value: unknown): Record<string, unknown> | null => value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;

/**
 * The helpers in a daemon's listProviderSubagents reply, running first, then newest.
 * Null when the reply reports an error or isn't a list; malformed entries are skipped.
 */
export function parseHelperList(payload: unknown, parentAgentId: string): Helper[] | null {
  const body = record(payload);
  if (!body || text(body.error) || !Array.isArray(body.subagents)) return null;
  const helpers: Helper[] = [];
  for (const entry of body.subagents) {
    const item = record(entry);
    const id = text(item?.id);
    if (!item || !id || typeof item.status !== "string") continue;
    // A reply for another parent is not this agent's helper.
    if (text(item.parentAgentId) && item.parentAgentId !== parentAgentId) continue;
    const updatedAt = text(item.updatedAt) ?? text(item.createdAt) ?? "";
    helpers.push({
      id, parentAgentId,
      title: text(item.title), description: text(item.description),
      status: helperStatus(item.status),
      createdAt: text(item.createdAt) ?? updatedAt, updatedAt,
    });
  }
  return helpers.sort((a, b) => Number(b.status === "running") - Number(a.status === "running") || b.updatedAt.localeCompare(a.updatedAt));
}

const MESSAGE_LENGTH = 600;

/** The last `limit` user and assistant messages in a helper's timeline reply; null when it reports an error. */
export function parseHelperMessages(payload: unknown, limit = 3): HelperMessage[] | null {
  const body = record(payload);
  if (!body || text(body.error) || !Array.isArray(body.rows)) return null;
  const messages: HelperMessage[] = [];
  for (const row of body.rows) {
    const item = record(record(row)?.item);
    const message = text(item?.text);
    if (!message || (item!.type !== "user_message" && item!.type !== "assistant_message")) continue;
    messages.push({
      role: item!.type === "user_message" ? "user" : "assistant",
      text: message.length > MESSAGE_LENGTH ? `${message.slice(0, MESSAGE_LENGTH)}…` : message,
      timestamp: text(record(row)?.timestamp) ?? "",
    });
  }
  return messages.slice(-limit);
}

/** A prompt's first non-empty line, with runs of spaces collapsed: one line of "what it was started for". */
export function firstLine(prompt: string, max = 200): string | null {
  const line = prompt.split(/\r?\n/).map(part => part.replace(/\s+/g, " ").trim()).find(Boolean);
  if (!line) return null;
  return line.length > max ? `${line.slice(0, max)}…` : line;
}

export type AgentNode<T> = { agent: T; children: AgentNode<T>[]; parentOutside: boolean };

/**
 * Nests each agent under its parent when the parent is in the same list, keeping list order.
 * An agent whose parent isn't in the list stays at the top with parentOutside set,
 * so the view can say whose it is (an archived parent, or one in another workspace).
 */
export function groupAgents<T extends { id: string; parentAgentId: string | null }>(agents: readonly T[]): AgentNode<T>[] {
  const ids = new Set(agents.map(agent => agent.id));
  const placed = new Set<string>();
  const node = (agent: T): AgentNode<T> => {
    placed.add(agent.id);
    const children = agents.filter(child => child.parentAgentId === agent.id && !placed.has(child.id));
    for (const child of children) placed.add(child.id);
    return { agent, children: children.map(node), parentOutside: false };
  };
  const roots: AgentNode<T>[] = [];
  for (const agent of agents) {
    if (placed.has(agent.id)) continue;
    const parentInList = agent.parentAgentId !== null && agent.parentAgentId !== agent.id && ids.has(agent.parentAgentId);
    if (parentInList) continue;
    roots.push({ ...node(agent), parentOutside: agent.parentAgentId !== null });
  }
  // Agents whose parents only point at each other have no root; list them rather than lose them.
  for (const agent of agents) if (!placed.has(agent.id)) roots.push(node(agent));
  return roots;
}

/** A node and its descendants in display order; nested is true for everything under the node. */
export function flattenAgentTree<T>(node: AgentNode<T>, nested = false): { agent: T; nested: boolean }[] {
  return [{ agent: node.agent, nested }, ...node.children.flatMap(child => flattenAgentTree(child, true))];
}

export type SubagentContext = {
  // Null when the parent isn't known: gone, or (parentUnread) it couldn't be read.
  parentName: string | null;
  parentUnread?: boolean;
  parentArchived?: boolean;
  // The parent's task, such as "23 · Follow paseo.json for commit messages".
  taskTitle?: string | null;
  projectName?: string | null;
  workspaceName?: string | null;
};

/** "Sub-agent of <parent> · <task> · <project / workspace>"; the parts that aren't known, or repeat the parent's name, are left out. */
export function subagentContextLine(context: SubagentContext): string {
  const parent = text(context.parentName);
  const task = text(context.taskTitle);
  const place = [text(context.projectName), text(context.workspaceName)].filter(Boolean).join(" / ");
  return [
    `Sub-agent of ${parent ?? (context.parentUnread ? "an agent that can't be found" : "an agent that is gone")}${parent && context.parentArchived ? " (archived)" : ""}`,
    task && task.toLowerCase() !== parent?.toLowerCase() ? task : null,
    place || null,
  ].filter(Boolean).join(" · ");
}

/**
 * Which parents to ask for helpers, and whether to ask at all. Helpers come from this Mission Control's
 * own server, so only its own host's agents are asked about, while that host is online. Only agents
 * mayQueryAgent allows are asked: listing a stopped agent's helpers would restart it. The server
 * checks each one's current status again before asking, since a view's roster can be seconds old.
 */
export function helperQueryPlan(serverId: string, localServerId: string, parents: readonly QueryableAgent[], online: boolean): { enabled: boolean; ids: string[] } {
  const ids = [...new Set(parents.filter(parent => mayQueryAgent(parent)).map(parent => parent.id))].sort().slice(0, 100);
  return { enabled: online && Boolean(serverId) && serverId === localServerId && ids.length > 0, ids };
}

/** Each parent's helpers; empty when the list is missing or unavailable, so the views leave helpers out. */
export function helpersByParent(result: { available: boolean; helpers: readonly Helper[] } | undefined): Map<string, Helper[]> {
  const byParent = new Map<string, Helper[]>();
  if (!result?.available) return byParent;
  for (const helper of result.helpers) byParent.set(helper.parentAgentId, [...byParent.get(helper.parentAgentId) ?? [], helper]);
  return byParent;
}

const count = (value: number, one: string, many: string) => `${value} ${value === 1 ? one : many}`;

/** The one-line summary beside "Sub-agents (N)": separate agents, running helpers, then finished ones as a count. */
export function subagentSummary({ children, running, finished }: { children: number; running: number; finished: number }): string {
  return [
    children ? count(children, "separate agent", "separate agents") : null,
    running ? `${count(running, "helper", "helpers")} running` : null,
    finished ? count(finished, "finished helper", "finished helpers") : null,
  ].filter(Boolean).join(" · ");
}

/** A sub-agent's kind in plain words; parentName is given when a card has several parents. */
export function subagentKindLabel(kind: "helper" | "separate", parentName?: string | null): string {
  if (kind === "separate") return "separate agent";
  return parentName ? `helper inside ${parentName}'s turn` : "helper inside this agent's turn";
}

// Helpers inside agents' turns, from this Mission Control's own host only. available is false when
// Paseo can't list them (an older daemon, or the call failed); the views then leave helpers out.
export const listHelpers = defineRpc({
  name: "subagents.helpers.list",
  input: z.object({ serverId: z.string().min(1), parentAgentIds: z.array(z.string().min(1)).max(100) }),
  output: z.object({ available: z.boolean(), helpers: z.array(helperSchema) }),
});

// A helper's last few messages, read when its entry is expanded.
export const readHelperMessages = defineRpc({
  name: "subagents.helpers.messages",
  input: z.object({ serverId: z.string().min(1), parentAgentId: z.string().min(1), helperId: z.string().min(1) }),
  output: z.object({ available: z.boolean(), messages: z.array(helperMessageSchema) }),
});

// The titles of this host's tasks, for the context line's task part.
export const listTaskTitles = defineRpc({
  name: "subagents.task-titles",
  input: z.object({ serverId: z.string().min(1) }),
  output: z.object({ titles: z.record(z.string(), z.string()) }),
});
