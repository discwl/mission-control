import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";
import { forges } from "./forges";
import { confirmedCommitMessage, mergeResultSchema, mergeStepSchema } from "./merge";
import { maxBodyChars, maxTitleChars } from "./paseo-metadata";

const taskId = z.string().regex(/^task_[a-f0-9-]+$/);
const sha = z.string().regex(/^[0-9a-f]{40}$/);
const forge = z.enum(forges);

// The Open PR action's safety checks: Merge's checks without the main-checkout ones, plus the pull request's own.
export const pullRequestCheckSchema = z.object({
  id: z.enum(["delivery", "task", "review", "agent", "in-progress", "work", "forge", "tool", "pull-request"]),
  label: z.string(),
  ok: z.boolean(),
  detail: z.string(),
});
export type PullRequestCheck = z.infer<typeof pullRequestCheckSchema>;

// One command or HTTP request as it will run, for the confirmation and the dry run. Credentials are never in it.
export const deliveryCommandSchema = z.object({ step: z.string(), text: z.string() });
export type DeliveryCommand = z.infer<typeof deliveryCommandSchema>;

// Exactly what Open PR will do, shown in the confirmation dialog.
export const pullRequestPlanSchema = z.object({
  taskTitle: z.string(),
  forge,
  // owner/repo, org/project/repo or workspace/repo.
  repository: z.string(),
  webUrl: z.string(),
  // origin's URL without any user name or password.
  remote: z.string(),
  targetBranch: z.string(),
  taskBranch: z.string(),
  worktreeDirectory: z.string(),
  worktreeWorkspaceId: z.string(),
  uncommittedFiles: z.array(z.string()).max(50),
  uncommittedCount: z.number().int().nonnegative(),
  undoneFiles: z.array(z.string()).max(50),
  undoneCount: z.number().int().nonnegative(),
  commitMessage: z.string(),
  // Commits on the task branch that origin's target branch (as last fetched) doesn't have.
  commitsAhead: z.number().int().nonnegative(),
  // The commit that is pushed; null when it is the commit of the uncommitted work, made first.
  pushCommit: sha.nullable(),
  title: z.string(),
  body: z.string(),
  // The repository's pull request template the body starts with, or null.
  template: z.string().nullable(),
  // That template's text as a model may see it (trimmed, key-like strings hidden): sent with paseo.json's pull request
  // instructions so a written description keeps its sections. Null without a template.
  templateText: z.string().nullable().default(null),
  // The Azure DevOps work item the pull request is linked to, or null.
  workItem: z.string().nullable(),
  commands: z.array(deliveryCommandSchema),
  // The task branch, the worktree's changes, the target and the pull request's text when checked; the run refuses if any moved.
  fingerprint: z.string(),
});
export type PullRequestPlan = z.infer<typeof pullRequestPlanSchema>;

export const pullRequestStatusSchema = z.object({
  taskId,
  // Pull request, not Merge: this project delivers by pull request.
  applies: z.boolean(),
  ready: z.boolean(),
  checks: z.array(pullRequestCheckSchema),
  plan: pullRequestPlanSchema.nullable(),
});
export type PullRequestCheckStatus = z.infer<typeof pullRequestStatusSchema>;

export const pullRequestResultSchema = z.discriminatedUnion("outcome", [
  z.object({ outcome: z.literal("opened"), forge, url: z.string(), number: z.number().int().positive(), committed: sha.nullable(), pushed: sha, steps: z.array(mergeStepSchema) }),
  // Nothing was changed, or only what the steps say (for example the commit, or the push before the forge refused).
  z.object({ outcome: z.literal("failed"), reason: z.string(), committed: sha.nullable(), pushed: sha.nullable(), steps: z.array(mergeStepSchema) }),
  z.object({ outcome: z.literal("refused"), reason: z.string(), checks: z.array(pullRequestCheckSchema) }),
  // A dry run: the checks passed and these are exactly the commands and requests a real run makes. Nothing changed.
  z.object({ outcome: z.literal("dry-run"), commands: z.array(deliveryCommandSchema), notes: z.array(z.string()) }),
]);
export type PullRequestResult = z.infer<typeof pullRequestResultSchema>;

export const pullRequestReplySchema = z.discriminatedUnion("outcome", [
  ...pullRequestResultSchema.options,
  z.object({ outcome: z.literal("running"), resultId: z.string(), taskId, step: z.string(), startedAt: z.string() }),
]);
export type PullRequestReply = z.infer<typeof pullRequestReplySchema>;

// A recorded pull request's state on its forge.
export const pullRequestStates = ["draft", "open", "merged", "closed"] as const;
export type PullRequestState = (typeof pullRequestStates)[number];

export const trackedPullRequestSchema = z.object({
  taskId,
  title: z.string(),
  workspaceId: z.string(),
  forge,
  url: z.string(),
  number: z.number().int().positive(),
  targetBranch: z.string(),
  taskBranch: z.string(),
  createdAt: z.string(),
  // Null until read, or when reading failed (see error).
  state: z.enum(pullRequestStates).nullable(),
  checkedAt: z.string().nullable(),
  error: z.string().nullable(),
});
export type TrackedPullRequest = z.infer<typeof trackedPullRequestSchema>;

export const cleanupPlanSchema = z.object({
  taskTitle: z.string(),
  url: z.string(),
  taskBranch: z.string(),
  worktreeWorkspaceId: z.string(),
  // The branch is deleted only while it still points at the commit Clean up checked the merged pull request contained.
  branchDeletable: z.boolean(),
  branchNote: z.string(),
});

export const cleanupResultSchema = z.discriminatedUnion("outcome", [
  z.object({ outcome: z.literal("cleaned"), steps: z.array(mergeStepSchema) }),
  z.object({ outcome: z.literal("refused"), reason: z.string() }),
]);
export type CleanupResult = z.infer<typeof cleanupResultSchema>;
export const cleanupReplySchema = z.discriminatedUnion("outcome", [
  ...cleanupResultSchema.options,
  z.object({ outcome: z.literal("running"), resultId: z.string(), taskId, step: z.string(), startedAt: z.string() }),
]);
export type CleanupReply = z.infer<typeof cleanupReplySchema>;

// ---------- result cards (Merge, Open PR and Clean up), kept until dismissed ----------

const resultBase = {
  resultId: z.string(),
  taskId,
  taskTitle: z.string(),
  startedAt: z.string(),
  step: z.string(),
  state: z.enum(["running", "finished", "failed"]),
  finishedAt: z.string().nullable(),
  error: z.string().nullable(),
};
export const deliveryResultSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("merge"), ...resultBase, result: mergeResultSchema.nullable() }),
  z.object({ kind: z.literal("pull-request"), ...resultBase, result: pullRequestResultSchema.nullable() }),
  z.object({ kind: z.literal("cleanup"), ...resultBase, result: cleanupResultSchema.nullable() }),
]);
export type DeliveryResult = z.infer<typeof deliveryResultSchema>;
export type DeliveryKind = DeliveryResult["kind"];

// ---------- RPCs ----------

export const checkPullRequest = defineRpc({
  name: "pr.check",
  input: z.object({ serverId: z.string().min(1), taskId }),
  output: pullRequestStatusSchema,
});

export const runPullRequest = defineRpc({
  name: "pr.run",
  input: z.object({
    serverId: z.string().min(1), taskId, fingerprint: z.string().min(1), dryRun: z.boolean().default(false),
    // The text the user confirmed; each one left out uses the plan's default.
    commitMessage: confirmedCommitMessage.optional(),
    title: z.string().trim().min(1, "The pull request title is empty.").max(maxTitleChars).refine(text => !/[\r\n]/.test(text), "Keep the pull request title on one line.").optional(),
    body: z.string().max(maxBodyChars).optional(),
  }),
  output: pullRequestReplySchema,
});

export const listPullRequests = defineRpc({
  name: "pr.list",
  // read: ask each forge for its pull request's state now; otherwise the last states read are returned.
  input: z.object({ serverId: z.string().min(1), read: z.boolean().default(false), taskId: taskId.optional() }),
  output: z.object({ pullRequests: z.array(trackedPullRequestSchema) }),
});

export const planCleanup = defineRpc({
  name: "pr.cleanup.plan",
  input: z.object({ serverId: z.string().min(1), taskId }),
  output: z.object({ plan: cleanupPlanSchema.nullable(), reason: z.string().nullable() }),
});

export const runCleanup = defineRpc({
  name: "pr.cleanup.run",
  input: z.object({ serverId: z.string().min(1), taskId }),
  output: cleanupReplySchema,
});

export const listDeliveryResults = defineRpc({
  name: "delivery.results",
  input: z.object({ serverId: z.string().min(1) }),
  output: z.object({ results: z.array(deliveryResultSchema) }),
});

export const dismissDeliveryResult = defineRpc({
  name: "delivery.dismiss",
  input: z.object({ serverId: z.string().min(1), resultId: z.string().min(1) }),
  output: z.object({ dismissed: z.boolean() }),
});

export const pullRequestCheckKey = (serverId: string, taskId: string) => ["mission-control", "pr-check", serverId, taskId] as const;
export const pullRequestsKey = (serverId: string) => ["mission-control", "pull-requests", serverId] as const;
export const deliveryResultsKey = (serverId: string) => ["mission-control", "delivery-results", serverId] as const;
