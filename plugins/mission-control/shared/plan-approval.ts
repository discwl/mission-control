import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";

const text = z.string().trim().min(1).max(600);
const items = z.array(text).min(1).max(8);
export const planBriefSchema = z.object({
  goal: text, before: text, after: text,
  included: items, deferred: items, affected: items, approach: items, successChecks: items, risks: items,
  scopeChange: text, authorization: text, changesSincePrevious: z.array(text).max(8),
});
export type PlanBrief = z.infer<typeof planBriefSchema>;
const revision = z.string().regex(/^[a-f0-9]{64}$/);
export const planReferenceSchema = z.object({
  path: z.string().regex(/^plans\/decision_[a-f0-9-]+\.[a-f0-9]{64}\.json$/),
  revision, documentRevision: revision,
});
export const previousPlanSchema = z.object({ revision, documentRevision: revision, requestedAt: z.string(), brief: planBriefSchema.nullable() });
export const decisionPlanSchema = z.object({
  source: z.enum(["snapshot", "current", "missing"]),
  revision: revision.nullable(), documentRevision: revision.nullable(), requestedAt: z.string(),
  markdown: z.string().max(200_000), brief: planBriefSchema.nullable(), previous: previousPlanSchema.nullable(),
  currentMatch: z.boolean(), canApprove: z.boolean(), warning: z.string().nullable(),
});
export type DecisionPlan = z.infer<typeof decisionPlanSchema>;
export const readDecisionPlan = defineRpc({
  name: "decisions.plan",
  input: z.object({
    serverId: z.string().min(1), workspaceId: z.string().min(1),
    taskId: z.string().regex(/^task_[a-f0-9-]+$/), runId: z.string().regex(/^run_[a-f0-9-]+$/),
    decisionId: z.string().regex(/^decision_[a-f0-9-]+$/), expectedRevision: z.string(),
  }),
  output: decisionPlanSchema,
});
