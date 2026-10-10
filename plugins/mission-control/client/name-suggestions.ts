import type { PaseoApi } from "@getpaseo/client";
import { z } from "zod";
import type { Ticket } from "../shared/tasks";
import { askSmallModel, extractJson, pickSmallModel, resolveSmallModel, type SmallModel } from "../shared/small-model";

// Name suggestions from chat context. Policy: docs/agent-workflow.md#naming-checkpoints.
// The prompt holds only titles, linked task titles/ticket identities and user prompts; never replies or tool output.
// The naming agent runs through shared/small-model, whose caveats apply.

export type AgentContext = { id: string; name: string; messages: string[]; suggest: boolean };
export type WorkspaceContext = {
  id: string;
  currentName: string;
  projectName: string;
  suggest: boolean;
  tasks: { title: string; status: string; ticket?: Pick<Ticket, "system" | "key"> | null }[];
  agents: AgentContext[];
};
export type NameSuggestion = { name: string; reason: string };
export type NamingModel = SmallModel;

export const NAMER_ROLE = "namer";
export const SUGGESTION_BATCH = 8;
export const MAX_CONTEXT_AGENTS = 6;
const MAX_MESSAGE_CHARS = 600;

export const NAMING_INSTRUCTIONS = [
  "You name Paseo workspaces and agents. Reply only with JSON matching the requested schema; do not use tools, read files, or change anything.",
  "Return one entry for every workspace and agent whose suggestName is true, using its id.",
  "A workspace title has 2–5 descriptive words, excluding any ticket prefix, describing its overall goal based on its tasks and the users' first prompts.",
  "When a workspace relates to a Jira issue or Azure DevOps work item, prefix its title with the exact issue key or work-item number followed by ' · ': for example, 'APP-123 · Fix Login Timeout' or '12345 · Update Export Format'. Use the linked task's ticket.system and ticket.key when available; otherwise use a ticket explicitly identified as this workspace's work in its current name or user prompts. Never invent a ticket, infer one from unrelated examples, or use Mission Control task IDs as ticket numbers. If several tickets clearly define the workspace's scope, include their distinct keys/numbers separated by commas before the title; do not guess an association.",
  "An agent name has 2–5 words describing that agent's job, based on its own prompts. Do not repeat the workspace or project name.",
  "Use title case for descriptive words and preserve ticket keys/numbers exactly. No status words (Review, Blocked, Done, WIP), dates, quotes, emoji, or trailing punctuation. No IDs except the workspace ticket prefix described above; do not add ticket prefixes to agent names.",
  "Keep the current name if it already fits. Give a one-line reason for each suggestion.",
].join("\n");

export const suggestionOutputSchema = {
  type: "object",
  additionalProperties: false,
  required: ["suggestions"],
  properties: {
    suggestions: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["id", "name", "reason"],
        properties: { id: { type: "string" }, name: { type: "string" }, reason: { type: "string" } },
      },
    },
  },
};

// Paseo's Claude provider doesn't enforce outputSchema, and small models vary the shape (a bare
// array, `suggestedName` instead of `name`), so accept those common variants.
const entrySchema = z.object({
  id: z.string(),
  name: z.string().optional(),
  suggestedName: z.string().optional(),
  suggested_name: z.string().optional(),
  newName: z.string().optional(),
  reason: z.string().optional(),
}).transform(entry => ({ id: entry.id, name: entry.name ?? entry.suggestedName ?? entry.suggested_name ?? entry.newName ?? "", reason: entry.reason }));
const responseSchema = z.union([
  z.object({ suggestions: z.array(entrySchema) }).transform(value => value.suggestions),
  z.array(entrySchema),
]);

function clip(text: string, limit: number): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > limit ? `${flat.slice(0, limit - 1)}…` : flat;
}

/** The first prompts say what the work is for; the latest ones show where it went. */
export function pickMessages(messages: string[], first = 3, last = 2): string[] {
  const unique = [...new Set(messages.map(message => clip(message, MAX_MESSAGE_CHARS)).filter(Boolean))];
  if (unique.length <= first + last) return unique;
  return [...unique.slice(0, first), ...unique.slice(-last)];
}

/**
 * The agents whose chats are read: the most recently updated few for workspace context,
 * plus every agent being renamed. Chosen before any timeline is fetched.
 */
export function contextAgents<T extends { id: string; updatedAt?: string }>(agents: T[], renaming: ReadonlySet<string>, limit = MAX_CONTEXT_AGENTS): T[] {
  const time = (agent: T) => Date.parse(agent.updatedAt ?? "") || 0;
  const recent = new Set([...agents].sort((a, b) => time(b) - time(a)).slice(0, limit));
  return agents.filter(agent => renaming.has(agent.id) || recent.has(agent));
}

export function buildNamingPrompt(workspaces: WorkspaceContext[]): string {
  const data = workspaces.map(workspace => ({
    id: workspace.id,
    suggestName: workspace.suggest,
    currentName: workspace.currentName,
    project: workspace.projectName,
    tasks: workspace.tasks.map(task => ({ title: clip(task.title, 200), status: task.status, ticket: task.ticket ? { system: task.ticket.system, key: task.ticket.key } : null })),
    agents: workspace.agents.map(agent => ({ id: agent.id, suggestName: agent.suggest, currentName: agent.name, userPrompts: pickMessages(agent.messages) })),
  }));
  return `Suggest names for the workspaces and agents marked suggestName. Return one entry per id.\nReply with only this JSON object, nothing else: {"suggestions":[{"id":"<id>","name":"<2-5 descriptive words, with ticket prefix for related workspaces>","reason":"<one line>"}]}\n\n${JSON.stringify({ workspaces: data }, null, 2)}`;
}

/** The ids the model must answer for. */
export function suggestionIds(workspaces: WorkspaceContext[]): string[] {
  return workspaces.flatMap(workspace => [
    ...(workspace.suggest ? [workspace.id] : []),
    ...workspace.agents.filter(agent => agent.suggest).map(agent => agent.id),
  ]);
}

export function cleanName(name: string): string {
  return name.replace(/\s+/g, " ").trim().replace(/^["'“”‘’`]+|["'“”‘’`.]+$/g, "").trim().slice(0, 80);
}

/** Keeps only suggestions for the requested ids, with a usable name. */
export function parseSuggestions(text: string, ids: string[]): Map<string, NameSuggestion> {
  const parsed = responseSchema.safeParse(extractJson(text));
  if (!parsed.success) throw new Error("The model's answer did not match the expected format.");
  const wanted = new Set(ids);
  const result = new Map<string, NameSuggestion>();
  for (const entry of parsed.data) {
    const name = cleanName(entry.name);
    if (!wanted.has(entry.id) || !name || result.has(entry.id)) continue;
    result.set(entry.id, { name, reason: clip(entry.reason ?? "", 200) });
  }
  return result;
}

export const pickNamingModel = pickSmallModel;
export const resolveNamingModel = resolveSmallModel;

type TimelinePage = { hasNewer: boolean; entries: { item: { type: string; text?: string } }[] };
type TimelineReader = { refetch(options: { direction: "after" | "tail"; limit: number; projection: "projected" }): Promise<TimelinePage> };

function userTexts(page: TimelinePage): string[] {
  return page.entries.flatMap(({ item }) => item.type === "user_message" && typeof item.text === "string" ? [item.text] : []);
}

/**
 * User prompts from the start and the end of an agent's timeline, oldest first.
 * "after" without a cursor reads from the first retained entry, so long chats still
 * give their first prompts. On short chats the two pages overlap; pickMessages dedupes.
 */
export async function readUserMessages(timeline: TimelineReader): Promise<string[]> {
  const head = await timeline.refetch({ direction: "after", limit: 150, projection: "projected" });
  if (!head.hasNewer) return userTexts(head);
  const tail = await timeline.refetch({ direction: "tail", limit: 100, projection: "projected" });
  return [...userTexts(head), ...userTexts(tail)];
}

/** Runs one short-lived agent in `hostWorkspaceId`, reads its JSON answer, then archives it. */
export async function suggestNames(paseo: PaseoApi, hostWorkspaceId: string, model: NamingModel, workspaces: WorkspaceContext[]): Promise<Map<string, NameSuggestion>> {
  const text = await askSmallModel(paseo, hostWorkspaceId, model, {
    title: "Name suggestions", role: NAMER_ROLE, noun: "naming agent",
    systemPrompt: NAMING_INSTRUCTIONS, prompt: buildNamingPrompt(workspaces), outputSchema: suggestionOutputSchema,
  });
  return parseSuggestions(text, suggestionIds(workspaces));
}
