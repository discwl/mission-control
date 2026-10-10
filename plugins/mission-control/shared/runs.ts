import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";

export const runSchema = z.object({
  schemaVersion: z.literal(1),
  runId: z.string().regex(/^run_[a-f0-9-]+$/),
  taskId: z.string().regex(/^task_[a-f0-9-]+$/),
  hostId: z.string().min(1),
  projectId: z.string().min(1),
  serverId: z.string().min(1),
  workspaceId: z.string().min(1),
  stage: z.enum(["intake", "plan", "execute", "validate", "review", "fix", "delivery", "handoff"]),
  outcome: z.enum(["in_progress", "completed", "blocked", "waiting"]),
  createdAt: z.string().min(1),
  updatedAt: z.string().min(1),
  nextAction: z.string(),
  agentId: z.string().nullable().default(null),
  gitHead: z.string().nullable(),
  gitDirty: z.boolean(),
  gitChanges: z.array(z.string()),
  omittedChanges: z.number().int().nonnegative(),
});

export type RunRecord = z.infer<typeof runSchema>;

export const listTaskRuns = defineRpc({
  name: "tasks.runs.list",
  input: z.object({
    serverId: z.string().min(1),
    workspaceId: z.string().min(1),
    taskId: z.string().regex(/^task_[a-f0-9-]+$/),
  }),
  output: z.object({ runs: z.array(runSchema) }),
});

export const resolveTaskPrompt = defineRpc({
  name: "tasks.agent.prompt",
  input: z.object({
    workspaceId: z.string().min(1),
    taskId: z.string().regex(/^task_[a-f0-9-]+$/),
  }),
  output: z.object({ title: z.string(), prompt: z.string() }),
});
