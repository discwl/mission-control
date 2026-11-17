import { z } from "zod";
import { ticketSchema, type TaskRecord, type Ticket } from "./tasks";

// One current-sprint work item as the Morning check read it from Jira or Azure DevOps.
// Keep in step with the item checks in scripts/morning-check.mjs.
export const trackerItemSchema = ticketSchema.extend({
  title: z.string().trim().min(1).max(300),
  description: z.string().max(20_000).default(""),
  acceptanceCriteria: z.string().max(20_000).default(""),
  status: z.string().max(100).default(""),
  sprint: z.string().max(200).default(""),
});
export type TrackerItem = z.infer<typeof trackerItemSchema>;

export const ticketSystemLabels: Record<Ticket["system"], string> = { jira: "Jira", "azure-devops": "Azure DevOps" };

/** Tickets match on system and key; keys compare case-insensitively (abc-1 is ABC-1). */
export function ticketIdentity(ticket: Pick<Ticket, "system" | "key">): string {
  return `${ticket.system}:${ticket.key.trim().toUpperCase()}`;
}

export type TicketComparison<Item> = {
  missing: Item[];
  imported: { item: Item; taskIds: string[] }[];
};

/** Splits tracker items into those no task carries yet and those already imported, keeping item order. */
export function compareTrackerItems<Item extends Pick<Ticket, "system" | "key">>(
  items: readonly Item[],
  tasks: readonly { taskId: TaskRecord["taskId"]; ticket?: Pick<Ticket, "system" | "key">; groupedTickets?: Pick<Ticket, "system" | "key">[] }[],
): TicketComparison<Item> {
  const taskIds = new Map<string, string[]>();
  for (const task of tasks) {
    const identities = new Set((task.groupedTickets ?? []).map(ticketIdentity));
    if (task.ticket) identities.add(ticketIdentity(task.ticket));
    for (const identity of identities) taskIds.set(identity, [...taskIds.get(identity) ?? [], task.taskId]);
  }
  const seen = new Set<string>();
  const result: TicketComparison<Item> = { missing: [], imported: [] };
  for (const item of items) {
    const identity = ticketIdentity(item);
    if (seen.has(identity)) continue;
    seen.add(identity);
    const matches = taskIds.get(identity);
    if (matches) result.imported.push({ item, taskIds: matches });
    else result.missing.push(item);
  }
  return result;
}

// Include the tracker instance and the project. Azure DevOps work item IDs alone give no project information.
function trackerProject(item: TrackerItem) {
  const url = new URL(item.url);
  if (item.system === "jira") {
    const project = /^([A-Z][A-Z0-9_]*)-\d+$/i.exec(item.key)?.[1];
    const context = /^(.*?)\/browse\//i.exec(url.pathname)?.[1];
    if (!project || context === undefined) throw new Error(`Cannot verify the Jira project for ${item.key}. Use its project issue link.`);
    return `jira:${url.origin}${context}/${project.toUpperCase()}`;
  }
  const project = /^(\/.+?)\/_workitems\/edit\/\d+\/?$/i.exec(url.pathname)?.[1];
  if (!project || (url.hostname === "dev.azure.com" && project.split("/").length < 3)) throw new Error(`Cannot verify the Azure DevOps project for ${item.key}. Use its project work item link.`);
  return `azure-devops:${url.origin}${project.toLowerCase()}`;
}

export function groupedTaskFields(items: TrackerItem[], title: string) {
  if (items.length < 2 || new Set(items.map(ticketIdentity)).size !== items.length) throw new Error("Select at least two distinct tickets for a group.");
  if (new Set(items.map(trackerProject)).size !== 1) throw new Error("Choose tickets from the same tracker project for a shared task.");
  const groupedTickets = items.map(item => ({
    ...importedTaskFields(item).ticket, title: item.title, acceptanceCriteria: item.acceptanceCriteria.trim() || item.description.trim(),
  }));
  const criteria = groupedTickets.map(item => `${item.key} · ${item.title}\n${item.url}\n${item.acceptanceCriteria || "Acceptance criteria to confirm at intake."}`).join("\n\n");
  const acceptanceCriteria = criteria.length <= criteriaLimit ? criteria : `Meet the acceptance criteria for all ${items.length} linked tickets. See groupedTickets in task.md for each source and its full criteria.`;
  return { title, acceptanceCriteria, groupedTickets, ticket: importedTaskFields(items[0]).ticket };
}

const criteriaLimit = 4000;

/** The new task's fields for an imported item: its ticket, a keyed title, and criteria within the task limit. */
export function importedTaskFields(item: TrackerItem): { title: string; acceptanceCriteria: string; ticket: Ticket } {
  const source = `Imported from ${ticketSystemLabels[item.system]} ${item.key}: ${item.url}`;
  const body = (item.acceptanceCriteria.trim() || item.description.trim());
  const room = criteriaLimit - source.length - 2;
  const trimmed = body.length > room ? `${body.slice(0, Math.max(0, room - 40)).trimEnd()}\n\n… (shortened; see the ticket)` : body;
  const title = `${item.key} · ${item.title}`.replace(/[\r\n]+/g, " ");
  return {
    title: title.length > 200 ? `${title.slice(0, 199)}…` : title,
    acceptanceCriteria: trimmed ? `${trimmed}\n\n${source}` : source,
    ticket: { system: item.system, key: item.key, url: item.url, ...(item.type ? { type: item.type } : {}) },
  };
}
