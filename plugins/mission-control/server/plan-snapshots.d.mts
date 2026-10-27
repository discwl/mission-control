import type { Decision } from "../shared/decisions";
import type { DecisionPlan } from "../shared/plan-approval";
type PlanInput = { taskFolder: string; runFolder: string; decision: Decision };
export function capturePlanSnapshot(input: { taskFolder: string; runFolder: string; taskId: string; runId: string; decisionId: string; requestedAt: string; brief: unknown }): Promise<NonNullable<Decision["plan"]>>;
export function readPlanSnapshot(input: PlanInput): Promise<DecisionPlan>;
export function verifyPlanApproval(input: PlanInput, expectedPlanRevision?: string): Promise<DecisionPlan>;
