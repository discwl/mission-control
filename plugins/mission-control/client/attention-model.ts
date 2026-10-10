import type { DecisionEntry } from "../shared/decisions";
import type { QuestionEntry, QuestionRef } from "../shared/questions";
import { hideCredentials } from "../shared/secret-mask";
import type { PermissionRequest } from "./permission-detail";

// What Attention's Needs you cards say. Every line is the agent's own words (a decision's or question's
// plain fields, or a quote from its chat) or a fixed sentence about the kind of request; nothing is generated.

export type RosterAgent = {
  id: string;
  workspaceId: string | null;
  name: string;
  // The mission-control.task-id label Start task gives a task's agent.
  taskId?: string | null;
  status: string;
  archivedAt: string | null;
  permissions: PermissionRequest[];
  requiresAttention?: boolean;
  attentionReason?: string | null;
  attentionTimestamp?: string | null;
  lastUserMessageAt?: string | null;
  lastError?: string | null;
};
export type RosterWorkspace = { id: string; name: string; projectName: string };
export type AttentionRoster = { workspaces: RosterWorkspace[]; agents: RosterAgent[] };
export type AttentionHost = { serverId: string; label: string; status: string };

export type TaskLine = { title: string; place: string };
export type Where = { text: string; source: "agent" | "chat" | "generic" };
export type CardModel = { badge: string; task: TaskLine; where: Where | null; need: string; recommendation: string | null };

const count = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;
export const flatten = (text: string) => text.replace(/\s+/g, " ").trim();

export function clip(text: string, max: number): string {
  const flat = flatten(text);
  return flat.length > max ? `${flat.slice(0, max - 1).trimEnd()}…` : flat;
}

// Chat text can echo a key, as agent errors can; hide it the way the roster hides lastError, before any trimming
// or Markdown stripping (which would drop a provider's "****" and leave the rest of a masked key unrecognised).
const masked = (text: string, max: number) => clip(hideCredentials(text), max);

/** The task's number and title when the agent's task label names one of this host's tasks, else the agent's title; then where it runs. */
export function taskLine({ taskId, agentName, taskTitles, hostLabel, workspace }: {
  taskId?: string | null; agentName: string; taskTitles?: Readonly<Record<string, string>>; hostLabel: string; workspace?: RosterWorkspace | null;
}): TaskLine {
  const title = (taskId && taskTitles?.[taskId]) || agentName;
  return { title, place: [hostLabel, workspace?.projectName, workspace?.name].filter(Boolean).join(" / ") };
}

// ——— Reading the chat, the way name suggestions do: Paseo's projected timeline, no model involved. ———

export type TimelineItem = { type: string; text?: string; name?: string; status?: string; detail?: unknown; message?: string; level?: string };
export const QUOTE_SENTENCES = 3;
export const QUOTE_CHARS = 400;

// Markdown markers only change how the text looks; removing them changes no words.
const plainMarkdown = (text: string) => text.replace(/```[a-z]*\n?/gi, " ").replace(/\*\*|__|`/g, "").replace(/^\s{0,3}#{1,6}\s+/gm, "").replace(/^\s*[-*]\s+/gm, "");

/**
 * The end of a message, verbatim: its last few sentences, and at most `max` characters. Anything cut is
 * marked with an ellipsis; no word is added or changed.
 */
export function lastSentences(text: string, sentences = QUOTE_SENTENCES, max = QUOTE_CHARS): string {
  const flat = flatten(plainMarkdown(text));
  const parts = flat.split(/(?<=[.!?])\s+(?=\S)/);
  let quote = parts.slice(-sentences).join(" ");
  let cut = parts.length > sentences;
  if (quote.length > max) {
    const tail = quote.slice(quote.length - max + 1);
    const space = tail.indexOf(" ");
    quote = space > 0 && space < 40 ? tail.slice(space + 1) : tail;
    cut = true;
  }
  return cut ? `…${quote}` : quote;
}

/** The agent's latest chat message, trimmed to its last sentences; null when it hasn't written one. */
export function latestAgentQuote(items: readonly TimelineItem[] | undefined): string | null {
  for (const item of [...(items ?? [])].reverse()) {
    if (item.type === "assistant_message" && typeof item.text === "string" && item.text.trim()) return lastSentences(hideCredentials(item.text));
  }
  return null;
}

export type Step = { kind: "you" | "agent" | "step" | "error"; text: string };
export const STEP_CHARS = 280;

function detailText(detail: unknown): string | null {
  if (!detail || typeof detail !== "object") return null;
  const value = detail as Record<string, unknown>;
  const text = (key: string) => typeof value[key] === "string" && value[key] ? value[key] as string : null;
  switch (value.type) {
    case "shell": return text("command");
    case "read": case "edit": case "write": return text("filePath");
    case "search": return text("query");
    case "fetch": return text("url");
    case "sub_agent": return text("description");
    case "plain_text": return text("label") ?? text("text");
    default: return null;
  }
}

/** The last few messages and steps of the chat, each trimmed. Reasoning, usage and other bookkeeping are left out. */
export function conversationSteps(items: readonly TimelineItem[] | undefined, limit = 8): Step[] {
  const steps: Step[] = [];
  for (const item of items ?? []) {
    if (item.type === "user_message" && item.text?.trim()) steps.push({ kind: "you", text: masked(item.text, STEP_CHARS) });
    else if (item.type === "assistant_message" && item.text?.trim()) steps.push({ kind: "agent", text: clip(plainMarkdown(hideCredentials(item.text)), STEP_CHARS) });
    else if (item.type === "tool_call") {
      const detail = detailText(item.detail);
      const outcome = item.status === "failed" ? " (failed)" : item.status === "canceled" ? " (canceled)" : item.status === "running" ? " (running)" : "";
      steps.push({ kind: "step", text: masked(`${item.name ?? "Tool"}${detail ? `: ${detail}` : ""}${outcome}`, STEP_CHARS) });
    } else if (item.type === "error" && item.message) steps.push({ kind: "error", text: masked(item.message, STEP_CHARS) });
    else if (item.type === "notification" && item.level === "error" && item.message) steps.push({ kind: "error", text: masked(item.message, STEP_CHARS) });
  }
  return steps.slice(-limit);
}

// ——— The cards ———

const chat = (quote: string | null): Where | null => quote ? { text: quote, source: "chat" } : null;

/** A permission request in plain words, after "Wants to:". The full command or input stays under Details. */
export function wantsTo(request: PermissionRequest): string {
  const detail = request.detail;
  const title = request.title || request.name;
  if (request.kind === "plan") return "Start work on the plan it proposed";
  if (request.kind === "mode") return `Change how it asks for permission${request.title ? `: ${request.title}` : ""}`;
  if (detail?.type === "shell") return `Run a command: ${masked(detail.command, 160)}`;
  if (detail?.type === "edit") return `Edit a file: ${detail.filePath}`;
  if (detail?.type === "write") return `Write a file: ${detail.filePath}`;
  if (detail?.type === "read") return `Read a file: ${detail.filePath}`;
  if (detail?.type === "search") return `Search: ${clip(detail.query, 160)}`;
  if (detail?.type === "fetch") return `Open a web page: ${masked(detail.url, 300)}`;
  return clip(title, 160);
}

export function permissionCard(request: PermissionRequest, task: TaskLine, latest: string | null): CardModel {
  return { badge: "PERMISSION", task, where: chat(latest), need: `Wants to: ${wantsTo(request)}`, recommendation: null };
}

/** What a plan or review decision needs, from its kind and open findings. */
export function decisionNeed(entry: DecisionEntry): string {
  if (entry.decision.kind === "plan") return "Approve the plan so the agent can start, or say what to change.";
  const open = entry.findings.filter(finding => finding.status === "open").length;
  return open
    ? `Decide on the ${count(open, "issue")} the review found: fix ${open === 1 ? "it" : "them"} first, or accept the work as it is.`
    : "Accept the work so it can be delivered, or ask for changes.";
}

/**
 * The top of a decision card. Where it's at is the agent's plain summary (what was built or planned, and what
 * the review found); older decisions without one quote the agent's chat, or say only what kind of request it is.
 */
export function decisionWhere(entry: DecisionEntry, latest: string | null, generic: string): Where {
  const plain = entry.decision.plain;
  if (plain) return { text: [plain.built, entry.decision.kind === "review" ? plain.found : ""].filter(Boolean).join(" "), source: "agent" };
  return chat(latest) ?? { text: generic, source: "generic" };
}

export function questionCard(entry: QuestionEntry, task: TaskLine, latest: string | null): CardModel {
  const plain = entry.question.plain;
  return {
    badge: "WAITING FOR YOU",
    task,
    where: plain ? { text: plain.status, source: "agent" } : chat(latest),
    need: plain?.need ?? entry.question.question,
    recommendation: plain?.recommendation || null,
  };
}

/** From Paseo's error message only: reading an errored agent's chat would wake it, so its card never quotes the chat. */
export function errorCard(agent: RosterAgent, task: TaskLine): CardModel {
  return {
    badge: "ERROR",
    task,
    where: null,
    need: `It stopped with an error: ${agent.lastError ? clip(agent.lastError, 200) : "Paseo recorded no details"}`,
    recommendation: null,
  };
}

// ——— Reading the chat without being asked ———

type AgentState = { status: string; archivedAt?: string | null; attentionReason?: string | null };

/**
 * Whether a card may read an agent's chat on its own, to quote where it's at. Reading the chat makes Paseo
 * wake an agent that has stopped, so it's only for an agent known to be live: never a closed, errored or
 * archived one, nor one the roster doesn't show. Conversation still reads the chat when the user opens it.
 */
export function mayReadChat(agent: AgentState | null | undefined): boolean {
  if (!agent || agent.archivedAt) return false;
  return agent.status !== "closed" && agent.status !== "error" && agent.attentionReason !== "error";
}

/**
 * A chat's query key. It sits outside Mission Control's ["mission-control"] keys, so Attention's Refresh and a
 * sent Reply, which invalidate those, never re-read a chat.
 */
export const timelineKey = (serverId: string, agentId: string | null, version: string) => ["attention-chat", serverId, agentId, version] as const;

/**
 * A chat is read when a card first needs it or the user opens Conversation, and never again by itself: not on
 * window focus, reconnect, remount or a timer. Reading could wake an agent that has stopped since.
 */
export const timelineQueryOptions = {
  staleTime: Infinity,
  refetchOnWindowFocus: false,
  refetchOnReconnect: false,
  refetchOnMount: false,
  refetchInterval: false,
  retry: false,
} as const;

/** Whether a Waiting card quotes the chat before Conversation is opened: only a question without the agent's own summary, from a live agent. */
export function waitingCardReadsChat(card: WaitingCard): boolean {
  return card.kind === "question" && !card.question?.question.plain && mayReadChat(card.agent);
}

// ——— Which cards show ———

/** Every pending permission prompt of a live agent on the online hosts, in roster order. */
export function pendingPrompts<H extends AttentionHost, R extends AttentionRoster>(hosts: readonly H[], rosters: readonly { data?: R }[]) {
  return hosts.flatMap((host, index) => {
    const roster = rosters[index]?.data;
    if (host.status !== "online" || !roster) return [];
    return roster.agents.filter(agent => !agent.archivedAt && agent.status !== "closed").flatMap(agent => agent.permissions.map(request => ({ host, roster, agent, request })));
  });
}

export type WaitingCard = {
  key: string;
  kind: "question" | "error";
  serverId: string;
  hostLabel: string;
  agentId: string;
  agent: RosterAgent | null;
  question: QuestionEntry | null;
  task: TaskLine;
  // When it started waiting: the question's time, or Paseo's attention time.
  since: string | null;
};
// When Attention last sent a reply to each agent, by `${serverId}:${agentId}`; hides its card until the roster catches up.
export type Replied = Readonly<Record<string, string>>;

const later = (a: string | null | undefined, b: string | null | undefined) => Boolean(a && b && Date.parse(a) > Date.parse(b));
export const agentKey = (serverId: string, agentId: string) => `${serverId}:${agentId}`;

/**
 * Waiting for you: this host's open questions, and agents Paseo flags with an error on every online host.
 * A card clears once the agent gets a message after it started waiting, whether the reply came from here
 * or the chat. Agents flagged only "finished" are not listed: Paseo can't tell a question from a normal finish.
 * Agents with a pending permission get the permission card instead, and an agent whose question card shows
 * gets no error card. A question whose agent isn't in this host's loaded roster isn't shown.
 */
export function waitingCards({ hosts, rosters, localServerId, questions, taskTitles, replied = {} }: {
  hosts: readonly AttentionHost[]; rosters: readonly { data?: AttentionRoster }[]; localServerId: string;
  questions?: readonly QuestionEntry[]; taskTitles?: Readonly<Record<string, string>>; replied?: Replied;
}): WaitingCard[] {
  const cards: WaitingCard[] = [];
  const localIndex = hosts.findIndex(host => host.serverId === localServerId);
  const local = localIndex >= 0 ? hosts[localIndex] : null;
  const localRoster = local?.status === "online" ? rosters[localIndex]?.data : undefined;
  const asking = new Set<string>();
  for (const entry of questions ?? []) {
    const { question } = entry;
    if (question.status !== "open" || question.serverId !== localServerId) continue;
    const key = agentKey(localServerId, question.agentId);
    // A question answered in the chat stays open on disk; only the agent's later message shows it was
    // answered, so a question is shown only while its agent is in a loaded roster.
    const agent = localRoster?.agents.find(candidate => candidate.id === question.agentId);
    if (!agent || agent.workspaceId !== question.workspaceId || agent.archivedAt || agent.status === "closed" || agent.permissions.length) continue;
    if (later(agent.lastUserMessageAt, question.askedAt) || later(replied[key], question.askedAt)) continue;
    // Only a question on screen stands in for the agent's error card.
    asking.add(key);
    const workspace = localRoster?.workspaces.find(candidate => candidate.id === question.workspaceId) ?? null;
    cards.push({
      key: `question:${question.questionId}`, kind: "question", serverId: localServerId, hostLabel: local?.label ?? "this host", agentId: question.agentId, agent, question: entry,
      task: { title: entry.taskTitle, place: taskLine({ agentName: "", hostLabel: local?.label ?? "this host", workspace }).place }, since: question.askedAt,
    });
  }
  hosts.forEach((host, index) => {
    const roster = rosters[index]?.data;
    if (host.status !== "online" || !roster) return;
    for (const agent of roster.agents) {
      const key = agentKey(host.serverId, agent.id);
      if (agent.attentionReason !== "error" || agent.requiresAttention === false || agent.archivedAt || agent.status === "closed" || agent.permissions.length || asking.has(key)) continue;
      const since = agent.attentionTimestamp ?? null;
      if (later(agent.lastUserMessageAt, since) || (replied[key] && (!since || !later(since, replied[key])))) continue;
      const workspace = roster.workspaces.find(candidate => candidate.id === agent.workspaceId) ?? null;
      cards.push({
        key: `error:${key}`, kind: "error", serverId: host.serverId, hostLabel: host.label, agentId: agent.id, agent, question: null,
        task: taskLine({ taskId: agent.taskId, agentName: agent.name, taskTitles: host.serverId === localServerId ? taskTitles : undefined, hostLabel: host.label, workspace }), since,
      });
    }
  });
  return cards.sort((a, b) => (a.since ?? "").localeCompare(b.since ?? ""));
}

// ——— Reply ———

export type ReplyRoute = { via: "question"; ref: QuestionRef } | { via: "agent"; serverId: string; agentId: string };

/** A question's reply goes through its host's Mission Control, which records the answer; any other goes straight to the agent on its host. */
export function replyRoute(card: WaitingCard): ReplyRoute {
  const question = card.question?.question;
  if (card.kind === "question" && question) {
    return { via: "question", ref: { serverId: question.serverId, workspaceId: question.workspaceId, taskId: question.taskId, runId: question.runId, questionId: question.questionId } };
  }
  return { via: "agent", serverId: card.serverId, agentId: card.agentId };
}

export type ReplyDeps = {
  replyToQuestion: (input: QuestionRef & { text: string }) => Promise<unknown>;
  sendToAgent: (serverId: string, agentId: string, text: string) => Promise<void>;
};

export async function sendReply(card: WaitingCard, text: string, deps: ReplyDeps): Promise<ReplyRoute> {
  const message = text.trim();
  if (!message) throw new Error("Write a reply first.");
  const route = replyRoute(card);
  if (route.via === "question") await deps.replyToQuestion({ ...route.ref, text: message });
  else await deps.sendToAgent(route.serverId, route.agentId, message);
  return route;
}

