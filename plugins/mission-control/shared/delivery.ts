import { defineRpc, defineSettings } from "@getpaseo/plugin";
import { z } from "zod";
import { branchSlug, branchTypeFor, ticketTitle } from "./branch-names";
import { forgeHostPattern, forges, forgeWebHostPattern, type ForgeOptions } from "./forges";
import type { TaskRecord } from "./tasks";

// How a finished task is delivered: merged into the main checkout (personal projects), or pushed and opened
// as a draft pull request (work repositories). A host default, with optional overrides per Paseo project ID.
export const deliveryModes = ["merge", "pull-request"] as const;
export type DeliveryMode = (typeof deliveryModes)[number];
export const deliveryModeLabels: Record<DeliveryMode, string> = { merge: "Merge", "pull-request": "Pull request" };

export const defaultPullRequestTitle = "{ticket}: {title}";

const templateSchema = z.string().max(200);
export const deliverySettings = defineSettings({
  id: "delivery",
  scope: "host",
  version: 1,
  schema: z.object({
    mode: z.enum(deliveryModes).default("merge"),
    // Empty means the default, "{ticket}: {title}".
    titleTemplate: templateSchema.default(""),
    // forge: overrides detection for this project's origin (for a host detection and the custom hosts don't know).
    projects: z.record(z.string().min(1), z.object({ mode: z.enum(deliveryModes).optional(), titleTemplate: templateSchema.optional(), forge: z.enum(forges).optional() })).default({}),
    // Custom domains and SSH host aliases, each mapped to a forge; see ForgeHostMapping.
    forgeHosts: z.array(z.object({
      match: z.string().trim().regex(forgeHostPattern, "Use a host name or SSH alias, such as github.example.com or github-work."),
      forge: z.enum(forges),
      // The forge's web address when it differs: a host, host:port, or a base URL such as http://tfs.corp:8080.
      host: z.string().trim().refine(value => !value || forgeWebHostPattern.test(value), "Use a host name, host:port, or a base URL such as http://tfs.corp:8080.").default(""),
    })).max(50).default([]),
  }),
});
export type DeliverySettings = z.infer<typeof deliverySettings.schema>;

/**
 * A project's delivery: its override, else the host's; an empty title template falls back the same way. `forge`
 * is what forge detection uses: the host's custom hosts, and the project's forge override if it has one.
 */
export function deliveryFor(settings: DeliverySettings, projectId: string): { mode: DeliveryMode; titleTemplate: string; modeSource: "project" | "host"; forge: ForgeOptions } {
  const project = settings.projects[projectId];
  return {
    mode: project?.mode ?? settings.mode,
    titleTemplate: project?.titleTemplate?.trim() || settings.titleTemplate.trim() || defaultPullRequestTitle,
    modeSource: project?.mode ? "project" : "host",
    forge: { hosts: settings.forgeHosts ?? [], ...(project?.forge ? { override: project.forge } : {}) },
  };
}

// Each Git project's origin URL (user name and password removed), so Settings → Delivery can show its forge with the
// settings being edited. null: no origin; error: why it couldn't be read.
export const projectRemoteSchema = z.object({ projectId: z.string(), name: z.string(), remote: z.string().nullable(), error: z.string().nullable() });
export type ProjectRemote = z.infer<typeof projectRemoteSchema>;
export const listProjectRemotes = defineRpc({
  name: "delivery.remotes",
  input: z.object({}),
  output: z.object({ projects: z.array(projectRemoteSchema) }),
});

const tokenPattern = /\{(ticket|title|slug|type|id)\}/g;

/** Why a title template can't be saved; null when it is empty (the default) or usable. */
export function pullRequestTitleProblem(template: string): string | null {
  const text = template.trim();
  if (!text) return null;
  const rest = text.replace(tokenPattern, "");
  const unknown = /\{[^{}]*\}/.exec(rest);
  if (unknown) return `${unknown[0]} isn't a token. Use {ticket}, {title}, {slug}, {type} or {id}.`;
  if (/[{}]/.test(rest)) return "Write each token with both braces, for example {title}.";
  if (!/\{(title|slug)\}/.test(text)) return "Include {title} or {slug} so each pull request says what it does.";
  if (/[\r\n]/.test(text)) return "Keep the title on one line.";
  return null;
}

// Separators left at either end when a token is empty, such as ": " when a task has no ticket.
const looseEnds = /^[\s:·|–—\-/]+|[\s:·|–—\-/]+$/g;

/**
 * A pull request's title from `template`: {ticket} is the ticket key, {title} the ticket's (or task's) title,
 * and {slug}, {type} and {id} are as in branch names. A token with no value is dropped with its separator.
 */
export function pullRequestTitle(template: string, task: Pick<TaskRecord, "taskId" | "title" | "ticket">): string {
  const text = template.trim() || defaultPullRequestTitle;
  const title = ticketTitle(task);
  const values: Record<string, string> = {
    ticket: task.ticket?.key.trim() ?? "", title, slug: branchSlug(title), type: task.ticket ? branchTypeFor(task.ticket.type) ?? "" : "", id: task.taskId.replace(/^task_/, "").slice(0, 8),
  };
  const rendered = text.replace(tokenPattern, (_, token: string) => values[token]).replace(/\s{2,}/g, " ").replace(looseEnds, "").trim() || title;
  return rendered.length > 200 ? `${rendered.slice(0, 199)}…` : rendered;
}

/** The template filled with example values, as settings show it. */
export function examplePullRequestTitle(template: string) {
  return pullRequestTitle(template, { taskId: "task_1234abcd", title: "ABC-123 · Add login retry", ticket: { system: "jira", key: "ABC-123", url: "https://example.atlassian.net/browse/ABC-123", type: "Story" } });
}
