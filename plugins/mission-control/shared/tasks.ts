import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";

// A work item in an external tracker. Its system and key identify it; the link opens it.
export const ticketSchema = z.object({
  system: z.enum(["jira", "azure-devops"]),
  key: z.string().trim().min(1).max(100).regex(/^[^\r\n]+$/),
  url: z.string().max(2000).regex(/^https?:\/\/[^\s]+$/i),
  // The tracker's work item type (Bug, Story, …) when the import knew it. Branch names use it for {type}.
  type: z.string().trim().min(1).max(100).regex(/^[^\r\n]+$/).optional(),
});
export type Ticket = z.infer<typeof ticketSchema>;

// A draft pull request Mission Control opened for the task: where, which branches, and the commit it pushed.
export const pullRequestRecordSchema = z.object({
  forge: z.enum(["github", "azure-devops", "bitbucket"]),
  url: z.string().max(2000).regex(/^https?:\/\/[^\s]+$/i),
  number: z.number().int().positive(),
  repository: z.string().min(1).max(300),
  targetBranch: z.string().min(1).max(200),
  taskBranch: z.string().min(1).max(200),
  head: z.string().regex(/^[0-9a-f]{40}$/),
  createdAt: z.string().min(1),
  // Azure DevOps only: what az --organization takes (a Server collection included).
  organizationUrl: z.string().max(2000).regex(/^https?:\/\/[^\s]+$/i).optional(),
  // The task worktree the pull request was opened from; Clean up checks it for uncommitted work even after the branch is gone.
  worktreeDirectory: z.string().min(1).max(1000).optional(),
});
export type PullRequestRecord = z.infer<typeof pullRequestRecordSchema>;

// A calendar day (YYYY-MM-DD) on the user's local calendar, not an instant.
export const dueDateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine(value => {
  const [year, month, day] = value.split("-").map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
}, "Use a real date as YYYY-MM-DD.");

export const taskSchema = z.object({
  schemaVersion: z.literal(1),
  taskId: z.string().min(1),
  hostId: z.string().min(1),
  projectId: z.string().min(1),
  title: z.string().min(1).regex(/^[^\r\n]+$/),
  acceptanceCriteria: z.string().min(1).max(4000),
  status: z.enum(["inbox", "ready", "in_progress", "blocked", "in_review", "delivered", "closed"]),
  source: z.literal("manual"),
  assignments: z.array(z.object({ serverId: z.string().min(1), workspaceId: z.string().min(1) })).min(1),
  createdAt: z.string().min(1),
  updatedAt: z.string().min(1),
  // Set when the task runs in its own Git worktree workspace. That workspace is also in assignments.
  worktree: z.object({
    workspaceId: z.string().min(1),
    branch: z.string().min(1),
    baseCommit: z.string().regex(/^[0-9a-f]{40}$/),
    sourceWorkspaceId: z.string().min(1),
    createdAt: z.string().min(1),
  }).optional(),
  // Set when the task was imported from Jira or Azure DevOps. Tasks without it stay valid.
  ticket: ticketSchema.optional(),
  // Set when Mission Control opened the task's draft pull request (Open PR in Attention).
  pullRequest: pullRequestRecordSchema.optional(),
  // When the task is due; tasks without one have no deadline.
  dueDate: dueDateSchema.optional(),
});
export type TaskWorktree = NonNullable<TaskRecord["worktree"]>;

export type TaskRecord = z.infer<typeof taskSchema>;

// A task file that was skipped because it is invalid; `file` is relative to the vault.
export const taskFileProblemSchema = z.object({ taskId: z.string(), file: z.string(), problem: z.string() });
export type TaskFileProblem = z.infer<typeof taskFileProblemSchema>;

export const listTasks = defineRpc({
  name: "tasks.list",
  input: z.object({ serverId: z.string().min(1), workspaceId: z.string().min(1) }),
  // Problems cover the whole host: a file that can't be read can't say which workspace it belongs to.
  output: z.object({ tasks: z.array(taskSchema), problems: z.array(taskFileProblemSchema) }),
});

/** One warning line per skipped task file, naming the file and the problem. */
export const taskProblemLine = (problem: TaskFileProblem) => `Skipped ${problem.file}: ${problem.problem}`;

export const createTask = defineRpc({
  name: "tasks.create",
  input: z.object({
    serverId: z.string().min(1),
    workspaceId: z.string().min(1),
    title: z.string().trim().min(1).max(200).regex(/^[^\r\n]+$/),
    acceptanceCriteria: z.string().trim().min(1).max(4000),
  }),
  output: taskSchema,
});

export const taskDocumentNameSchema = z.string().regex(/^[a-z0-9][a-z0-9_-]*\.md$/);
const runEvidenceNameSchema = z.string().regex(/^runs\/run_[a-f0-9-]+\/(?:run\.md|handoff\.md|events\/event_[a-f0-9-]+\.md)$/);

export const taskDocumentSchema = z.object({
  name: z.union([taskDocumentNameSchema, runEvidenceNameSchema]),
  content: z.string(),
  revision: z.string(),
  updatedAt: z.string(),
  editable: z.boolean(),
});

const taskDocumentAddressSchema = z.object({
  serverId: z.string().min(1),
  workspaceId: z.string().min(1),
  taskId: z.string().regex(/^task_[a-f0-9-]+$/),
});

export const updateTaskStatus = defineRpc({
  name: "tasks.status.update",
  input: z.object({
    serverId: z.string().min(1),
    workspaceId: z.string().min(1),
    taskId: z.string().regex(/^task_[a-f0-9-]+$/),
    status: taskSchema.shape.status,
    expectedUpdatedAt: z.string().min(1),
  }),
  output: taskSchema,
});

// Sets the task's due date, or clears it with null.
export const updateTaskDueDate = defineRpc({
  name: "tasks.due.update",
  input: z.object({
    serverId: z.string().min(1),
    workspaceId: z.string().min(1),
    taskId: z.string().regex(/^task_[a-f0-9-]+$/),
    dueDate: dueDateSchema.nullable(),
    expectedUpdatedAt: z.string().min(1),
  }),
  output: taskSchema,
});

export const listTaskDocuments = defineRpc({
  name: "tasks.documents.list",
  input: taskDocumentAddressSchema,
  output: z.object({ documents: z.array(taskDocumentSchema) }),
});

export const saveTaskDocument = defineRpc({
  name: "tasks.documents.save",
  input: taskDocumentAddressSchema.extend({
    name: taskDocumentNameSchema,
    content: z.string().max(200_000),
    revision: z.string().nullable(),
  }),
  output: taskDocumentSchema,
});
