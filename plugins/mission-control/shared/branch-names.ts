import { defineSettings } from "@getpaseo/plugin";
import { z } from "zod";
import type { TaskRecord } from "./tasks";

export const branchTypeSchema = z.enum(["feature", "bugfix"]);
export type BranchType = z.infer<typeof branchTypeSchema>;

// Task branch templates: one for the host, and optional overrides keyed by Paseo project ID.
// An empty template means Mission Control's own task/{id}-{slug}. Templates are checked on save
// and again when a task starts, so a hand-edited value can't create a bad branch.
export const branchNameSettings = defineSettings({
  id: "branch-names",
  scope: "host",
  version: 1,
  schema: z.object({
    template: z.string().max(200).default(""),
    projects: z.record(z.string().min(1), z.string().max(200)).default({}),
  }),
});

export const branchTokens = ["ticket", "slug", "type", "id"] as const;
type TokenValues = Record<(typeof branchTokens)[number], string>;
const tokenPattern = /\{(ticket|slug|type|id)\}/g;

/** What `git check-ref-format --branch` would reject, in words; null when the name is allowed. */
export function gitBranchNameProblem(name: string): string | null {
  if (!name) return "It is empty.";
  if (name.length > 200) return "It is longer than 200 characters.";
  if (name.startsWith("-")) return "It can't start with a hyphen.";
  if (name === "HEAD" || name === "@") return `"${name}" is reserved by Git.`;
  if (/[\x00-\x20\x7f~^:?*[\\]/.test(name)) return "It can't contain spaces, control characters, or any of ~ ^ : ? * [ \\.";
  if (name.includes("..")) return "It can't contain \"..\".";
  if (name.includes("@{")) return "It can't contain \"@{\".";
  if (name.startsWith("/") || name.endsWith("/") || name.includes("//")) return "Each / must sit between two non-empty parts.";
  if (name.endsWith(".")) return "It can't end with \".\".";
  for (const part of name.split("/")) {
    if (part.startsWith(".")) return `A part can't start with "." (${part}).`;
    if (part.endsWith(".lock")) return `A part can't end with ".lock" (${part}).`;
  }
  return null;
}

function render(template: string, values: TokenValues) {
  return template.replace(tokenPattern, (_, token: keyof TokenValues) => values[token]);
}

/** The template filled with example values, as settings show it. */
export function exampleBranchName(template: string) {
  return render(template.trim(), { ticket: "ABC-123", slug: "add-login-retry", type: "feature", id: "1234abcd" });
}

/** Why a template can't be saved; null when it is empty or usable. */
export function branchTemplateProblem(template: string): string | null {
  const text = template.trim();
  if (!text) return null;
  const rest = text.replace(tokenPattern, "");
  const unknown = /\{[^{}]*\}/.exec(rest);
  if (unknown) return `${unknown[0]} isn't a token. Use {ticket}, {slug}, {type} or {id}.`;
  if (/[{}]/.test(rest)) return "Write each token with both braces, for example {ticket}.";
  if (!/\{(ticket|id)\}/.test(text)) return "Include {ticket} or {id} so each task gets its own branch.";
  const sample = exampleBranchName(text);
  const problem = gitBranchNameProblem(sample);
  return problem ? `It makes branch names Git won't accept, such as ${sample}: ${problem}` : null;
}

/** A short description for a branch: lowercase words joined by hyphens, cut at a word within `max` characters. */
export function branchSlug(text: string, max = 40) {
  const words = text.normalize("NFKD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  if (words.length <= max) return words;
  const cut = words.lastIndexOf("-", max);
  return (cut > max / 2 ? words.slice(0, cut) : words.slice(0, max)).replace(/-+$/, "");
}

const escapeRegExp = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** The ticket's title: an imported task is titled "<KEY> · <ticket title>", so the key is dropped. */
export function ticketTitle(task: Pick<TaskRecord, "title" | "ticket">) {
  if (!task.ticket) return task.title;
  const stripped = task.title.replace(new RegExp(`^\\s*${escapeRegExp(task.ticket.key.trim())}\\s*(?:[·:|–—-]\\s*)?`, "i"), "").trim();
  return stripped || task.title;
}

/** feature or bugfix from a tracker's work item type (Bug, Defect, Story, …); null when unknown. */
export function branchTypeFor(ticketType: string | undefined): BranchType | null {
  const type = ticketType?.trim();
  if (!type) return null;
  return /bug|defect|hotfix|incident/i.test(type) ? "bugfix" : "feature";
}

export type TemplateBranch = {
  kind: "template";
  // One name, or a feature and a bugfix name when the template uses {type} and the ticket doesn't say.
  options: { type: BranchType | null; name: string; problem: string | null }[];
  typeFromTicket: boolean;
};
export type DefaultBranch = { kind: "default"; reason: "no-template" | "no-ticket" };

/**
 * The branch a task's new worktree gets from `template` (the project's override, else the host's).
 * Without a template, or for a task without a ticket, callers keep task/<id>-<slug>.
 */
export function templateBranch(task: Pick<TaskRecord, "taskId" | "title" | "ticket">, template: string | undefined): TemplateBranch | DefaultBranch {
  const text = template?.trim() ?? "";
  if (!text) return { kind: "default", reason: "no-template" };
  if (!task.ticket) return { kind: "default", reason: "no-ticket" };
  const templateProblem = branchTemplateProblem(text);
  const values = { ticket: task.ticket.key.trim(), slug: branchSlug(ticketTitle(task)), id: task.taskId.replace(/^task_/, "").slice(0, 8) };
  const known = branchTypeFor(task.ticket.type);
  const usesType = /\{type\}/.test(text);
  const types: (BranchType | null)[] = !usesType ? [null] : known ? [known] : ["feature", "bugfix"];
  const options = types.map(type => {
    const name = render(text, { ...values, type: type ?? "" });
    return { type, name, problem: templateProblem ?? gitBranchNameProblem(name) };
  });
  return { kind: "template", options, typeFromTicket: usesType && Boolean(known) };
}
