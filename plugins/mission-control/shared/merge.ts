import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";
import { maxCommitMessageChars } from "./paseo-metadata";

const taskId = z.string().regex(/^task_[a-f0-9-]+$/);
const sha = z.string().regex(/^[0-9a-f]{40}$/);

// Each safety check the Merge action runs before changing anything. All must pass.
export const mergeCheckSchema = z.object({
  id: z.enum(["task", "review", "agent", "main-checkout", "local-files", "in-progress", "work"]),
  label: z.string(),
  ok: z.boolean(),
  detail: z.string(),
});
export type MergeCheck = z.infer<typeof mergeCheckSchema>;

// Exactly what a merge will do, shown in the confirmation dialog.
export const mergePlanSchema = z.object({
  taskTitle: z.string(),
  mainCheckout: z.string(),
  targetBranch: z.string(),
  taskBranch: z.string(),
  worktreeDirectory: z.string().nullable(),
  worktreeWorkspaceId: z.string(),
  uncommittedFiles: z.array(z.string()).max(50),
  uncommittedCount: z.number().int().nonnegative(),
  commitsAhead: z.number().int().nonnegative(),
  commitMessage: z.string(),
  // Files Git lists as changed whose content matches the task branch, such as a staged change that was
  // undone in the files. They aren't merged; without other uncommitted work, the merge unstages them.
  undoneFiles: z.array(z.string()).max(50),
  undoneCount: z.number().int().nonnegative(),
  mergeMessage: z.string(),
  // The agent that gets a short note after the merge; null when it no longer exists.
  agentId: z.string().nullable(),
  // Both HEADs and the worktree's changes when checked; the merge refuses if any moved.
  fingerprint: z.string(),
});
export type MergePlan = z.infer<typeof mergePlanSchema>;

export const mergeStatusSchema = z.object({
  taskId,
  ready: z.boolean(),
  checks: z.array(mergeCheckSchema),
  plan: mergePlanSchema.nullable(),
});
export type MergeStatus = z.infer<typeof mergeStatusSchema>;

export const mergeStepSchema = z.object({ label: z.string(), state: z.enum(["done", "skipped", "failed"]), detail: z.string() });
export type MergeStep = z.infer<typeof mergeStepSchema>;

export const mergeResultSchema = z.discriminatedUnion("outcome", [
  z.object({ outcome: z.literal("merged"), mergeCommit: sha, targetBranch: z.string(), committed: sha.nullable(), steps: z.array(mergeStepSchema) }),
  // "Merge needs you". state: aborted (the main checkout is as it was), not-restored (it isn't back where it was),
  // or unknown (Git couldn't be confirmed stopped, so nothing was undone). Older results have no state.
  z.object({ outcome: z.literal("conflict"), files: z.array(z.string()), committed: sha.nullable(), detail: z.string(), state: z.enum(["aborted", "not-restored", "unknown"]).optional() }),
  z.object({ outcome: z.literal("refused"), reason: z.string(), checks: z.array(mergeCheckSchema) }),
]);
export type MergeResult = z.infer<typeof mergeResultSchema>;

// merge.run's reply: the result, or, for a merge that outlasts the reply, that it is still running.
export const mergeReplySchema = z.discriminatedUnion("outcome", [
  ...mergeResultSchema.options,
  // resultId is the Attention card that follows the merge until it is dismissed.
  z.object({ outcome: z.literal("running"), resultId: z.string(), taskId, step: z.string(), startedAt: z.string() }),
]);
export type MergeReply = z.infer<typeof mergeReplySchema>;

// A task whose latest review is approved, for Attention's Ready list. delivery says whether its project merges
// locally or opens a pull request (Settings → Delivery); the matching action's own checks decide the rest.
export const mergeReadyTaskSchema = z.object({ taskId, title: z.string(), workspaceId: z.string(), approvedAt: z.string().nullable(), delivery: z.enum(["merge", "pull-request"]) });
export type MergeReadyTask = z.infer<typeof mergeReadyTaskSchema>;

export const checkMerge = defineRpc({
  name: "merge.check",
  input: z.object({ serverId: z.string().min(1), taskId }),
  output: mergeStatusSchema,
});

// The commit message the user confirmed for the task's uncommitted work; without it, the plan's default is used.
export const confirmedCommitMessage = z.string().trim().min(1, "The commit message is empty.").max(maxCommitMessageChars);

export const runMerge = defineRpc({
  name: "merge.run",
  input: z.object({ serverId: z.string().min(1), taskId, fingerprint: z.string().min(1), commitMessage: confirmedCommitMessage.optional() }),
  output: mergeReplySchema,
});

export const listMergeReady = defineRpc({
  name: "merge.ready",
  input: z.object({ serverId: z.string().min(1) }),
  // warning: why every task is treated as Merge right now (Delivery settings can't be read), or null.
  output: z.object({ tasks: z.array(mergeReadyTaskSchema), warning: z.string().nullable().default(null) }),
});

export const mergeCheckKey = (serverId: string, taskId: string) => ["mission-control", "merge", serverId, taskId] as const;
export const mergeReadyKey = (serverId: string) => ["mission-control", "merge-ready", serverId] as const;
