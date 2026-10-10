import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";

const taskId = z.string().regex(/^task_[a-f0-9-]+$/);
const runId = z.string().regex(/^run_[a-f0-9-]+$/);
const decisionId = z.string().regex(/^decision_[a-f0-9-]+$/);
const findingId = z.string().regex(/^finding_[a-f0-9-]+$/);

// Only the user moves a finding out of `open`; agents report fixes as
// `awaiting_verification`, and only review evidence marks one `resolved`.
export const findingStatusSchema = z.enum(["open", "submitted", "awaiting_verification", "resolved", "dismissed"]);

// Plain-language fields for a busy product owner (dev-flow request-decision validates the same limits,
// plus no IDs, hashes or paths). They are optional: older records have none and render a generic line.
export const plainLimits = { built: 800, found: 800, reason: 300, description: 200, impact: 300 } as const;
const plainText = (max: number) => z.string().trim().min(1).max(max);
export const findingPlainSchema = z.object({
  description: plainText(plainLimits.description),
  // What happens if the finding is skipped.
  impact: plainText(plainLimits.impact),
  recommend: z.enum(["fix", "skip"]),
});
export type FindingPlain = z.infer<typeof findingPlainSchema>;
export const decisionPlainSchema = z.object({
  // What was built (review) or planned (plan).
  built: plainText(plainLimits.built),
  // What the review found; plans may leave it empty.
  found: z.string().trim().max(plainLimits.found).default(""),
  recommendation: z.object({ action: z.enum(["accept", "fix", "stop"]), reason: plainText(plainLimits.reason) }),
});
export type DecisionPlain = z.infer<typeof decisionPlainSchema>;

export const findingSchema = z.object({
  findingId,
  decisionId,
  title: z.string().min(1).max(300),
  severity: z.enum(["high", "medium", "low"]),
  detail: z.string().max(4000),
  file: z.string().max(500).nullable(),
  status: findingStatusSchema,
  updatedAt: z.string(),
  evidence: z.array(z.string().max(1000)).max(20),
  // A malformed block falls back to the generic rendering instead of hiding every decision.
  plain: findingPlainSchema.nullable().catch(null),
});
export type Finding = z.infer<typeof findingSchema>;
export const findingsFileSchema = z.object({ schemaVersion: z.literal(1), runId, findings: z.array(findingSchema) });

// Resume delivery is separate from the decision: a saved decision may not have reached the agent yet.
export const resumeSchema = z.object({
  phase: z.enum(["pending", "sending", "sent"]),
  error: z.string().nullable(),
  updatedAt: z.string(),
});
export const decisionSchema = z.object({
  schemaVersion: z.literal(1),
  decisionId,
  taskId,
  runId,
  serverId: z.string().min(1),
  workspaceId: z.string().min(1),
  agentId: z.string().nullable(),
  kind: z.enum(["plan", "review"]),
  status: z.enum(["open", "approved", "changes_requested", "blocked"]),
  question: z.string().min(1).max(500),
  requestedAt: z.string(),
  gitHead: z.string().nullable(),
  gitDirty: z.boolean(),
  evidence: z.array(z.string().max(1000)).max(20),
  findingIds: z.array(findingId).max(50),
  resolvedAt: z.string().nullable(),
  note: z.string().nullable(),
  resume: resumeSchema.nullable(),
  // What a review covered: HEAD plus the tree of every working-tree change, untracked files included
  // (dev-flow request-decision). Older decisions have none, so they can't be merged from Attention.
  candidate: z.object({ head: z.string().regex(/^[0-9a-f]{40}$/).nullable(), tree: z.string().regex(/^[0-9a-f]{40}$/) }).nullable().default(null),
  plain: decisionPlainSchema.nullable().catch(null),
});
export type Decision = z.infer<typeof decisionSchema>;

export const decisionEntrySchema = z.object({
  decision: decisionSchema,
  summary: z.string(),
  taskTitle: z.string(),
  projectId: z.string(),
  findings: z.array(findingSchema),
  // Findings from earlier rounds of this run that still await a fix or verification.
  unverifiedFindings: z.number().int().nonnegative(),
  // Findings from earlier rounds of this run that a fresh review verified as fixed.
  resolvedFindings: z.array(findingSchema).default([]),
  revision: z.string(),
});
export type DecisionEntry = z.infer<typeof decisionEntrySchema>;

export const decisionRefSchema = z.object({ serverId: z.string().min(1), workspaceId: z.string().min(1), taskId, runId, decisionId });

export const listDecisions = defineRpc({
  name: "decisions.list",
  input: z.object({ serverId: z.string().min(1) }),
  output: z.object({ open: z.array(decisionEntrySchema), recent: z.array(decisionEntrySchema) }),
});

export const resolveDecision = defineRpc({
  name: "decisions.resolve",
  input: decisionRefSchema.extend({
    expectedRevision: z.string(),
    outcome: z.enum(["approved", "changes_requested", "blocked"]),
    note: z.string().max(2000),
    submitFindingIds: z.array(findingId).max(50),
  }),
  output: decisionEntrySchema,
});

export const resendDecision = defineRpc({
  name: "decisions.resend",
  input: decisionRefSchema.extend({ expectedRevision: z.string() }),
  output: decisionEntrySchema,
});

export const decisionsKey = (serverId: string) => ["mission-control", "decisions", serverId] as const;
