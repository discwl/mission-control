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
  tasks: readonly { taskId: TaskRecord["taskId"]; ticket?: Pick<Ticket, "system" | "key"> }[],
): TicketComparison<Item> {
  const taskIds = new Map<string, string[]>();
  for (const task of tasks) {
    if (!task.ticket) continue;
    const identity = ticketIdentity(task.ticket);
    taskIds.set(identity, [...taskIds.get(identity) ?? [], task.taskId]);
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
