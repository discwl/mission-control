import type { KanbanTask } from "./kanban-model";

export const attentionSections = [
  { id: "questions", title: "Questions", description: "Your answer will let the task continue." },
  { id: "publish", title: "Ready to publish", description: "Review the changes and results before authorizing publication." },
  { id: "execute", title: "Ready to execute", description: "Inspect prepared actions or read a completed report before the final decision." },
  { id: "intervention", title: "Needs intervention", description: "Something prevents the task from continuing or its status cannot be confirmed." },
  { id: "manual", title: "Manual approvals", description: "These tasks still use the manual workflow and need your plan or code-review decision." },
] as const;
export type AttentionSection = typeof attentionSections[number]["id"];
export type AttentionTask = { item: KanbanTask; section: AttentionSection; label: string; why: string; action: string; requestedAt: string };

/** Display routing only. The task detail rechecks live authority before any action. */
export function attentionTask(item: KanbanTask): AttentionTask | null {
  const { row } = item;
  const make = (section: AttentionSection, label: string, why: string, action: string, requestedAt = row.updatedAt): AttentionTask => ({ item, section, label, why, action, requestedAt });
  if (row.state === "Unconfirmed" || row.limited) return make("intervention", "Status needs checking", `${row.hostLabel} has not returned a fresh, complete task update. Saved details may be out of date.`, "Check connection and task");
  if (row.entry.problem) return make("intervention", "Task could not be read", "Some task information could not be read. Check the task before continuing.", "Inspect task details");
  const question = row.entry.questions.filter(entry => entry.question.status === "open").sort((a, b) => a.question.askedAt.localeCompare(b.question.askedAt))[0];
  if (question) return make("questions", "Answer needed", question.question.plain?.need || question.question.question, "Answer question", question.question.askedAt);
  if (row.workers.some(worker => !worker.archivedAt && worker.pendingPermissions > 0)) return make("questions", "Permission needed", "A task worker is waiting for permission to continue. Read the requested action before deciding.", "Review permission");
  const decision = row.entry.decisions.filter(entry => entry.decision.status === "open").sort((a, b) => a.decision.requestedAt.localeCompare(b.decision.requestedAt))[0];
  if (decision && !row.staleReview) return make("manual", decision.decision.kind === "plan" ? "Plan approval needed" : "Code-review decision needed", decision.decision.kind === "plan" ? "This task is waiting for your decision on its saved plan." : "This task is waiting for your decision on its reviewed changes.", decision.decision.kind === "plan" ? "Read and decide on plan" : "Review changes and decide", decision.decision.requestedAt);
  if (item.needsYou && item.tab === "Delivery" && row.workflow.actor === "you") {
    const kind = row.entry.pipeline?.deliveryKind ?? row.entry.run?.deliveryKind ?? "code";
    return kind === "code" ? make("publish", "Final review needed", "The task has reached its publication decision. Inspect the results and changes; the final check verifies the current version again.", "Review changes and publish")
      : kind === "report" ? make("execute", "Report ready to finish", "Read the final report and its checks. Finishing a report does not run commands or publish changes.", "Read final report")
      : make("execute", "Actions ready for your decision", "Inspect exactly what will run, where it will run, its effects, checks and recovery steps before authorizing it.", "Review prepared actions");
  }
  if (row.staleReview) return make("intervention", "Review needs refreshing", "The changes no longer match the saved review. Ask the task worker to validate and review the current version.", "Inspect changed work");
  if (item.needsYou || row.state === "Blocked" || row.workflow.actor === "dependency") return make("intervention", "Task cannot continue", "Check the saved explanation and the task conversation to resolve what is blocking progress.", "Inspect blocker");
  return null;
}

export function attentionTasks(items: readonly KanbanTask[], host = "all", search = ""): AttentionTask[] {
  const selected = new Map<string, KanbanTask>();
  for (const item of items) if (!selected.has(item.row.key) || selected.get(item.row.key)!.row.updatedAt < item.row.updatedAt) selected.set(item.row.key, item);
  const query = search.trim().toLowerCase();
  return [...selected.values()].map(attentionTask).filter((task): task is AttentionTask => Boolean(task))
    .filter(task => (host === "all" || task.item.row.serverId === host) && (!query || [task.item.row.entry.task.title, task.item.row.entry.task.ticket?.key, task.item.row.hostLabel, task.label, task.why].join(" ").toLowerCase().includes(query)))
    .sort((a, b) => a.requestedAt.localeCompare(b.requestedAt) || a.item.row.key.localeCompare(b.item.row.key));
}
