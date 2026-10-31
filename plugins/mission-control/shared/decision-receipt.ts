import type { DecisionEntry } from "./decisions";
import type { ChatMessageContext } from "./chat-message";

/** The same saved-decision receipt is used by chat, Telegram and the V2 preview. */
export function decisionReceipt(entry: DecisionEntry, host: string, records: DecisionEntry[] = []) {
  const d = entry.decision, phase = d.resume?.phase;
  const newer = records.filter(row => row.decision.taskId === d.taskId && row.decision.requestedAt > d.requestedAt).sort((a, b) => b.decision.requestedAt.localeCompare(a.decision.requestedAt))[0];
  const status = d.status === "approved" ? (d.kind === "plan" ? "Approved plan" : "Accepted code") : d.status === "changes_requested" ? "Changes requested" : "Stop requested";
  const delivery = phase === "sent" ? "Sent to worker" : phase === "sending" ? "Delivery unconfirmed" : phase === "pending" ? "Saved; waiting for worker" : "Saved; delivery not requested";
  const waitingOn = newer ? (newer.decision.status === "open" ? "You — a newer request is waiting" : "The newer saved decision") : phase === "sent" ? "Worker" : phase === "pending" ? "Worker availability" : "Delivery inspection";
  const nextStep = newer ? `Open the latest ${newer.decision.kind} for this task. This receipt records only your earlier choice; it does not approve the newer request`
    : phase === "sending" ? "Inspect the worker before retrying; this request is not automatically resent"
    : phase === "pending" ? "Delivery requires an idle worker and passing saved-version checks; no repeat approval is needed"
    : d.status === "changes_requested" ? (d.kind === "plan" ? "Worker revises the plan for fresh approval" : "Worker addresses your note, then validates and gets a fresh review")
    : d.status === "blocked" ? "Worker records the stop and handoff" : "Worker continues within the approved scope";
  const context: ChatMessageContext = { host, title: entry.taskTitle, taskId: d.taskId, type: "receipt", stage: d.kind === "plan" ? "Planning" : "Code review", status: `${newer ? "Earlier decision: " : ""}${status} · ${delivery}`, waitingOn, nextStep,
    actionNeeded: newer?.decision.status === "open" ? "Read the newer request in What needs me" : phase === "sending" ? "Inspect delivery" : "No repeat approval needed",
    observedAt: d.resume?.updatedAt ?? d.resolvedAt ?? d.requestedAt, evidence: "saved_record" };
  return { context, text: `${host} · ${entry.taskTitle}\nDecision receipt\n${status}. ${delivery}.\n${d.note ? `\nYour note\n${d.note}\n` : ""}${d.resume?.error ? `\nDelivery detail\n${d.resume.error}\n` : ""}\n${nextStep}.\nNo additional publishing or deployment was authorized.` };
}
