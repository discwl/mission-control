import type { PaseoApi } from "@getpaseo/client";
import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";
import { hideCredentials } from "./secret-mask";
import { askSmallModel, extractJson, resolveSmallModel } from "./small-model";

// A repository's own conventions for generated text, from its paseo.json: the instructions Paseo's own Commit
// button follows. Mission Control only reads paseo.json; it never writes it.

export const paseoConfigFile = "paseo.json";
// Each instruction is clipped to this length before a model sees it.
export const maxInstructionChars = 4_000;

// The part of Paseo's paseo-config-schema (@getpaseo/protocol) Mission Control reads, as leniently as Paseo reads it:
// an entry of the wrong shape is ignored rather than making the whole file unusable. Mirrored here because
// @getpaseo/protocol isn't a direct dependency of this plugin.
const entrySchema = z.object({ instructions: z.string().optional() }).passthrough().catch({});
const metadataSchema = z.object({
  branchName: entrySchema.optional(),
  commitMessage: entrySchema.optional(),
  pullRequest: entrySchema.optional(),
}).passthrough().catch({});
export const paseoConfigSchema = z.object({ metadataGeneration: metadataSchema.optional() }).passthrough().catch({});

export const paseoInstructionsSchema = z.object({
  commitMessage: z.string().nullable(),
  pullRequest: z.string().nullable(),
  branchName: z.string().nullable(),
  // The paseo.json the instructions came from; null when none was found.
  path: z.string().nullable(),
  // worktree: the task's worktree; source: the checkout it was made from (an uncommitted paseo.json isn't copied into worktrees).
  where: z.enum(["worktree", "source"]).nullable(),
  // Why the paseo.json found can't be used, such as invalid JSON; its instructions are then all null.
  problem: z.string().nullable(),
});
export type PaseoInstructions = z.infer<typeof paseoInstructionsSchema>;
export const noInstructions: PaseoInstructions = { commitMessage: null, pullRequest: null, branchName: null, path: null, where: null, problem: null };

const instruction = (entry: { instructions?: string } | undefined) => {
  const text = entry?.instructions?.trim();
  return text ? text.slice(0, maxInstructionChars) : null;
};

/** The instructions in a paseo.json's text; a file that isn't JSON gets `problem` and no instructions. */
export function instructionsFromText(text: string, path: string, where: PaseoInstructions["where"]): PaseoInstructions {
  let parsed: unknown;
  try { parsed = JSON.parse(text.replace(/^﻿/, "")); }
  catch (error) { return { ...noInstructions, path, where, problem: `${path} isn't valid JSON (${error instanceof Error ? error.message : String(error)}), so its instructions aren't used.` }; }
  const metadata = paseoConfigSchema.parse(parsed).metadataGeneration ?? {};
  return {
    commitMessage: instruction(metadata.commitMessage), pullRequest: instruction(metadata.pullRequest), branchName: instruction(metadata.branchName),
    path, where, problem: null,
  };
}

// ---------- the text a small model writes from the instructions ----------

// Everything the model is told about the task. The only file content it gets is the repository's pull request
// template, trimmed and with key-like strings hidden, and only with pull request instructions; never diffs or other files.
export type DeliveryTextContext = { title: string; ticketKey: string | null; summary: string | null };
export type DeliveryTextRequest = DeliveryTextContext & { commitInstructions: string | null; pullRequestInstructions: string | null; pullRequestTemplate?: string | null };
export type DeliveryText = { commitMessage?: string; title?: string; body?: string };

export const DELIVERY_TEXT_ROLE = "delivery-writer";
// A pull request template is cut to this length, at a line end, before a model sees it.
export const maxTemplateChars = 6_000;

export const DELIVERY_TEXT_SYSTEM_PROMPT = [
  "You write a Git commit message and pull request text for a finished task, following the repository's own instructions.",
  "Reply only with JSON matching the requested schema; do not use tools, read files, or change anything.",
  "Follow the repository's instructions exactly. Use only the task information given; don't invent changes, file names, tests or links.",
  "When a pull request template is given, the description keeps its sections and headings in order, filled in from the task information; leave a section's placeholder text out when the task says nothing about it.",
].join("\n");

/** The repository's pull request template as a model may see it: key-like strings hidden, cut at a line end. */
export function templateForModel(text: string | null | undefined): string | null {
  const clean = hideCredentials((text ?? "").replace(/\r\n/g, "\n")).trim();
  if (!clean) return null;
  if (clean.length <= maxTemplateChars) return clean;
  const cut = clean.lastIndexOf("\n", maxTemplateChars);
  return `${clean.slice(0, cut > maxTemplateChars / 2 ? cut : maxTemplateChars).trimEnd()}\n…`;
}

/** Which parts the model writes: a commit message when there is work to commit, and a pull request's title and body. */
export function wantedParts(request: DeliveryTextRequest) {
  return { commitMessage: request.commitInstructions !== null, pullRequest: request.pullRequestInstructions !== null };
}

export function buildDeliveryTextPrompt(request: DeliveryTextRequest): string {
  const want = wantedParts(request);
  const task = { title: request.title, ticket: request.ticketKey, handoffSummary: request.summary };
  const template = want.pullRequest ? templateForModel(request.pullRequestTemplate) : null;
  const instructions = {
    ...(want.commitMessage ? { commitMessage: request.commitInstructions } : {}),
    ...(want.pullRequest ? { pullRequest: request.pullRequestInstructions } : {}),
    ...(template ? { pullRequestTemplate: template } : {}),
  };
  const shape = [
    want.commitMessage ? `"commitMessage":"<the whole commit message>"` : "",
    want.pullRequest ? `"title":"<one-line pull request title>","body":"<pull request description in Markdown>"` : "",
  ].filter(Boolean).join(",");
  return `Write ${[want.commitMessage ? "the commit message" : "", want.pullRequest ? "the pull request's title and body" : ""].filter(Boolean).join(" and ")} for this task, following the repository's instructions.\n`
    + `Reply with only this JSON object, nothing else: {${shape}}\n\n${JSON.stringify({ task, repositoryInstructions: instructions }, null, 2)}`;
}

export function deliveryTextOutputSchema(request: DeliveryTextRequest) {
  const want = wantedParts(request);
  const properties: Record<string, { type: "string" }> = {};
  if (want.commitMessage) properties.commitMessage = { type: "string" };
  if (want.pullRequest) { properties.title = { type: "string" }; properties.body = { type: "string" }; }
  return { type: "object", additionalProperties: false, required: Object.keys(properties), properties };
}

const answerSchema = z.object({
  commitMessage: z.string().optional(), commit_message: z.string().optional(), message: z.string().optional(),
  title: z.string().optional(), body: z.string().optional(), description: z.string().optional(),
}).passthrough();

/**
 * Removes one code fence or one pair of quotes a model sometimes wraps around the whole text, and nothing else: a
 * closing quote, backtick or fence that belongs to the text stays. A fence only counts when it wraps everything (no
 * other fence inside), and quotes only when the same mark opens and closes the text and appears nowhere between.
 */
export function unwrap(value: string): string {
  let text = value.trim();
  const fenced = /^```[a-z]*\r?\n([\s\S]*?)\r?\n```$/i.exec(text);
  if (fenced && !fenced[1].includes("```")) text = fenced[1].trim();
  const mark = text[0];
  if (text.length >= 2 && (mark === "\"" || mark === "'" || mark === "`") && text.endsWith(mark) && !text.slice(1, -1).includes(mark)) text = text.slice(1, -1).trim();
  return text;
}

/**
 * The parts of a model's answer that were asked for and are usable. Small models vary the keys (commit_message,
 * description), so those are accepted. A part that is missing or empty is left out; its default applies.
 */
export function parseDeliveryText(answer: unknown, request: DeliveryTextRequest): DeliveryText {
  const parsed = answerSchema.safeParse(answer);
  if (!parsed.success) throw new Error("The model's answer did not match the expected format.");
  const want = wantedParts(request);
  const result: DeliveryText = {};
  const commit = unwrap(parsed.data.commitMessage ?? parsed.data.commit_message ?? parsed.data.message ?? "").replace(/\r\n/g, "\n");
  if (want.commitMessage && commit) result.commitMessage = commit.slice(0, maxCommitMessageChars);
  if (want.pullRequest) {
    const title = oneLine(unwrap(parsed.data.title ?? ""));
    const body = unwrap(parsed.data.body ?? parsed.data.description ?? "").replace(/\r\n/g, "\n");
    if (title) result.title = withTicketKey(title, request.ticketKey);
    if (body) result.body = body.slice(0, maxBodyChars);
  }
  return result;
}

export const maxCommitMessageChars = 10_000;
export const maxTitleChars = 200;
export const maxBodyChars = 60_000;

/** The first line of `text`, cut to a pull request title's length. */
export function oneLine(text: string) {
  const line = text.split(/\r?\n/).map(part => part.trim()).find(Boolean) ?? "";
  return line.length > maxTitleChars ? `${line.slice(0, maxTitleChars - 1)}…` : line;
}

/** A pull request title keeps the task's ticket key: when the text lacks it, it goes in front ("ABC-123: …"). */
export function withTicketKey(title: string, ticketKey: string | null) {
  const key = ticketKey?.trim();
  if (!key || title.toLowerCase().includes(key.toLowerCase())) return title;
  return oneLine(`${key}: ${title}`);
}

/** The lines every Mission Control pull request body ends with: the ticket link and where it came from. */
type FooterTask = { taskId: string; ticket?: { key: string; url: string } | null };
export function pullRequestFooter(task: FooterTask): string[] {
  return [
    ...(task.ticket ? [`Ticket: [${task.ticket.key}](${task.ticket.url})`] : []),
    `Opened as a draft by Mission Control for task ${task.taskId}.`,
  ];
}

/** A generated body with Mission Control's footer, leaving out a ticket link the text already has. */
export function finishGeneratedBody(body: string, task: FooterTask) {
  const footer = pullRequestFooter(task).filter(line => !(line.startsWith("Ticket: ") && task.ticket && body.includes(task.ticket.url)));
  return [body.trim(), ...footer].filter(Boolean).join("\n\n");
}

/**
 * Asks the small model (Haiku, else GPT-6-Luna on low; see shared/small-model) for the text, in a short-lived agent in
 * the task's worktree workspace. It is given only the task's title, ticket key, handoff summary and the instructions.
 */
export async function writeDeliveryText(paseo: PaseoApi, workspaceId: string, request: DeliveryTextRequest, task: FooterTask): Promise<{ model: string; text: DeliveryText }> {
  const model = await resolveSmallModel(paseo);
  const answer = await askSmallModel(paseo, workspaceId, model, {
    title: "Commit and pull request text", role: DELIVERY_TEXT_ROLE, noun: "writing agent", timeoutMs: 90_000,
    systemPrompt: DELIVERY_TEXT_SYSTEM_PROMPT, prompt: buildDeliveryTextPrompt(request), outputSchema: deliveryTextOutputSchema(request),
  });
  const text = parseDeliveryText(extractJson(answer), request);
  if (text.body) text.body = finishGeneratedBody(text.body, task);
  if (!Object.keys(text).length) throw new Error("The model's answer had none of the text asked for.");
  return { model: model.label, text };
}

// ---------- RPCs ----------

const taskId = z.string().regex(/^task_[a-f0-9-]+$/);

// What Merge's and Open PR's confirmations need to write their text: the task's paseo.json instructions and the
// only task facts a model is given.
export const getDeliveryInstructions = defineRpc({
  name: "delivery.instructions",
  input: z.object({ serverId: z.string().min(1), taskId }),
  output: z.object({
    instructions: paseoInstructionsSchema,
    title: z.string(),
    ticket: z.object({ key: z.string(), url: z.string() }).nullable(),
    summary: z.string().nullable(),
  }),
});
export type DeliveryInstructions = z.infer<typeof getDeliveryInstructions.output>;

// Settings → Branch names: each Git project's paseo.json branch name guidance, shown beside its template.
export const listBranchGuidance = defineRpc({
  name: "branch-names.guidance",
  input: z.object({}),
  output: z.object({ projects: z.array(z.object({ projectId: z.string(), guidance: z.string().nullable(), path: z.string().nullable(), problem: z.string().nullable() })) }),
});

export const deliveryInstructionsKey = (serverId: string, taskId: string) => ["mission-control", "delivery-instructions", serverId, taskId] as const;
