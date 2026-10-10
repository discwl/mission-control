import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";
import { taskFileProblemSchema, type TaskFileProblem, type TaskRecord } from "./tasks";

export const taskCountsSchema = z.object({ total: z.number().int().nonnegative(), active: z.number().int().nonnegative() });
export type TaskCounts = z.infer<typeof taskCountsSchema>;
export const taskSummarySchema = z.object({
  serverId: z.string().min(1),
  observedAt: z.string(),
  counts: taskCountsSchema,
  workspaces: z.array(taskCountsSchema.extend({ workspaceId: z.string() })),
  projects: z.array(taskCountsSchema.extend({ projectId: z.string() })),
  // Invalid task files that the counts skip.
  problems: z.array(taskFileProblemSchema),
});
export type TaskSummary = z.infer<typeof taskSummarySchema>;
export const getTaskSummary = defineRpc({
  name: "tasks.summary",
  input: z.object({ serverId: z.string().min(1) }),
  output: taskSummarySchema,
});
export const taskSummaryKey = (serverId: string) => ["mission-control", "task-summary", serverId] as const;

/** Host and project totals count each task once, even when assigned to several workspaces. */
export function summarizeTasks(tasks: readonly TaskRecord[], serverId: string, problems: readonly TaskFileProblem[] = []): TaskSummary {
  const counts: TaskCounts = { total: 0, active: 0 };
  const workspaces = new Map<string, TaskCounts>();
  const projects = new Map<string, TaskCounts>();
  const seen = new Set<string>();
  const add = (target: TaskCounts, active: boolean) => { target.total++; if (active) target.active++; };
  const group = (map: Map<string, TaskCounts>, id: string, active: boolean) => {
    const count = map.get(id) ?? { total: 0, active: 0 };
    add(count, active); map.set(id, count);
  };
  for (const task of tasks) {
    const assigned = new Set(task.assignments.filter(a => a.serverId === serverId).map(a => a.workspaceId));
    if (!assigned.size || seen.has(task.taskId)) continue;
    seen.add(task.taskId);
    const active = task.status !== "delivered" && task.status !== "closed";
    add(counts, active);
    group(projects, task.projectId, active);
    for (const workspaceId of assigned) group(workspaces, workspaceId, active);
  }
  return { serverId, observedAt: new Date().toISOString(), counts,
    workspaces: [...workspaces].map(([workspaceId, count]) => ({ workspaceId, ...count })),
    projects: [...projects].map(([projectId, count]) => ({ projectId, ...count })),
    problems: [...problems],
  };
}

/** Undefined means unknown. Only a complete matching host summary can establish zero. */
export function selectTaskCounts(summary: TaskSummary | undefined, serverId: string, scope?: { workspaceId: string } | { projectId: string }): TaskCounts | undefined {
  if (!summary || summary.serverId !== serverId) return undefined;
  if (!scope) return summary.counts;
  const count = "workspaceId" in scope ? summary.workspaces.find(entry => entry.workspaceId === scope.workspaceId) : summary.projects.find(entry => entry.projectId === scope.projectId);
  return count ?? { total: 0, active: 0 };
}
export function hasMatchingTasks(counts: TaskCounts | undefined, activeOnly: boolean) {
  return counts !== undefined && (activeOnly ? counts.active : counts.total) > 0;
}
