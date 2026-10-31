import type { DecisionEntry } from "../shared/decisions";
import type { ChatMessageContext } from "../shared/chat-message";

export function decisionContext(entry: DecisionEntry, host: string): ChatMessageContext {
  const d = entry.decision;
  return { host, title: entry.taskTitle, taskId: d.taskId, type: d.kind,
    stage: d.kind === "plan" ? "Planning" : "Code review", status: "Awaiting your decision",
    waitingOn: "You", actionNeeded: d.kind === "plan" ? "Read this plan, then approve or request changes" : "Accept this code or request changes",
    nextStep: d.kind === "plan" ? "Implementation after approval" : "Delivery preview after code acceptance",
    observedAt: d.requestedAt, evidence: "saved_record" };
}
export { decisionReceipt } from "../shared/decision-receipt";
