import type { FleetAgent, FleetTask } from "../shared/fleet";
import { taskWorkflow } from "../shared/fleet-model";

export type TaskTab = "Overview" | "Plan" | "Needs you" | "Review" | "Evidence" | "Delivery";
export const hasOpenPlan = (entry: FleetTask) => entry.decisions.some(item => item.decision.kind === "plan" && item.decision.status === "open");

/** Presentation only: does not alter scheduler eligibility or ownership. */
export function taskDestination(entry: FleetTask, workers: readonly FleetAgent[]): { tab: TaskTab; label: string } {
  if (workers.some(worker => worker.pendingPermissions > 0)) return { tab: "Needs you", label: "Answer request" };
  if (hasOpenPlan(entry)) return { tab: "Plan", label: "Review plan" };
  if (entry.decisions.some(item => item.decision.kind === "plan" && item.decision.status === "approved" && (!entry.run || item.decision.runId === entry.run.runId) && item.decision.resume && item.decision.resume.phase !== "sent")) return { tab: "Plan", label: "Inspect plan delivery" };
  if (entry.questions.some(item => item.question.status === "open")) return { tab: "Needs you", label: "Answer question" };
  if (entry.decisions.some(item => item.decision.kind === "review" && item.decision.status === "open")) return { tab: "Needs you", label: "Review result" };
  const workflow = taskWorkflow(entry, workers);
  if (workflow.stage === "Delivery approval") return { tab: "Delivery", label: "Review delivery" };
  if (["Code review", "Your review"].includes(workflow.stage)) return { tab: "Review", label: "Review code" };
  if (workflow.stage === "Planning") return { tab: "Plan", label: "View plan" };
  if (["you", "dependency"].includes(workflow.actor)) return { tab: "Needs you", label: "Inspect blocker" };
  return { tab: "Overview", label: "Open task" };
}
