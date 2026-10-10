import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";
import { branchTypeSchema } from "./branch-names";
import { runSchema } from "./runs";

export const taskBindingSchema = z.object({
  serverId: z.string().min(1),
  workspaceId: z.string().min(1),
  taskId: z.string().regex(/^task_[a-f0-9-]+$/),
});
export type TaskBinding = z.infer<typeof taskBindingSchema>;

// A dispatch receipt is separate from run evidence: accepting a prompt is not progress.
export const launchRecordSchema = taskBindingSchema.extend({
  launchId: z.string().uuid(),
  agentId: z.string().min(1),
  runId: z.string().regex(/^run_[a-f0-9-]+$/),
  provider: z.string().min(1),
  // Permission mode and effort for a new agent; null or absent means the provider default.
  modeId: z.string().nullable().optional(),
  thinkingOptionId: z.string().nullable().optional(),
  creatingAgent: z.boolean(),
  phase: z.enum(["preparing", "sending", "sent"]),
  createdAt: z.string(),
  updatedAt: z.string(),
  runUpdatedAt: z.string().nullable(),
  lastUserMessageAt: z.string().nullable(),
  error: z.string().nullable(),
});
export type LaunchRecord = z.infer<typeof launchRecordSchema>;

// The branch a first start in its own worktree would create. `problem` means it can't be worked out;
// an option's problem means Git or another task rules that name out.
export const branchPreviewSchema = z.object({
  source: z.enum(["template", "default"]),
  note: z.string().nullable(),
  problem: z.string().nullable(),
  // One name, or a feature and a bugfix name for the user to pick.
  options: z.array(z.object({ type: branchTypeSchema.nullable(), name: z.string(), problem: z.string().nullable() })),
});
export type BranchPreview = z.infer<typeof branchPreviewSchema>;

export const launchStatusSchema = z.object({
  revision: z.string(),
  // starting: a launch from any client is still running on the server; the status refresh shows its progress.
  action: z.enum(["start", "resume", "recover", "open", "blocked", "starting"]),
  message: z.string(),
  launch: launchRecordSchema.nullable(),
  run: runSchema.nullable(),
  agent: z.object({ id: z.string(), name: z.string(), status: z.string(), provider: z.string(), updatedAt: z.string() }).nullable(),
  // The task's own worktree workspace, once it has one.
  worktree: z.object({ workspaceId: z.string(), branch: z.string(), baseCommit: z.string() }).nullable(),
  // A first start may create that worktree (the project is a Git repository with a commit).
  canIsolate: z.boolean(),
  // Set while canIsolate.
  branch: branchPreviewSchema.nullable(),
});
export type LaunchStatus = z.infer<typeof launchStatusSchema>;

export const getTaskLaunch = defineRpc({
  name: "tasks.launch.status", input: taskBindingSchema, output: launchStatusSchema,
});
export const launchTask = defineRpc({
  name: "tasks.launch.dispatch",
  input: taskBindingSchema.extend({
    expectedRevision: z.string(), provider: z.string().max(300).optional(), isolate: z.boolean().optional(),
    modeId: z.string().min(1).max(100).optional(), thinkingOptionId: z.string().min(1).max(100).optional(),
    // With isolate: the previewed branch, and feature or bugfix when the preview offered both.
    branch: z.string().max(300).optional(), branchType: branchTypeSchema.optional(),
  }),
  output: launchStatusSchema,
});
