import type { TaskRecord } from "./tasks";

// Mission Control keeps one status label on each workspace that has work: a Paseo workspace label such as "Review",
// which the workspace lists, their label filter and the host Review bubble read. It comes from the workspace's tasks,
// or from an agent label an orchestrator or agent sets (WORKSPACE_STATUS_AGENT_LABEL).

export const workspaceStatuses = ["ready", "in-progress", "review", "blocked", "done"] as const;
export type WorkspaceStatus = (typeof workspaceStatuses)[number];

export type WorkspaceLabelColor = "violet" | "sky" | "emerald" | "orange" | "pink" | "indigo" | "teal" | "red" | "amber" | "blue";

/** Each status's Paseo workspace label. The color is used only when the label doesn't exist on the host yet. */
export const workspaceStatusLabels: Record<WorkspaceStatus, { name: string; color: WorkspaceLabelColor }> = {
  ready: { name: "Ready", color: "teal" },
  "in-progress": { name: "In Progress", color: "sky" },
  review: { name: "Review", color: "violet" },
  blocked: { name: "Blocked", color: "red" },
  done: { name: "Done", color: "emerald" },
};

/** The agent label that sets its workspace's status, e.g. `mission-control.workspace-status=review`; `none` clears it. */
export const WORKSPACE_STATUS_AGENT_LABEL = "mission-control.workspace-status";

const fromTask: Record<TaskRecord["status"], WorkspaceStatus | null> = {
  inbox: null,
  ready: "ready",
  in_progress: "in-progress",
  blocked: "blocked",
  in_review: "review",
  delivered: "done",
  closed: "done",
};

export function statusForTask(status: TaskRecord["status"]): WorkspaceStatus | null {
  return fromTask[status];
}

/** An agent label's value as a status: null to clear, undefined when it isn't one. */
export function parseWorkspaceStatus(value: string | null | undefined): WorkspaceStatus | null | undefined {
  const key = value?.trim().toLowerCase().replace(/[\s_]+/g, "-");
  if (!key) return undefined;
  if (key === "none" || key === "clear") return null;
  if (key === "in-review") return "review";
  return (workspaceStatuses as readonly string[]).includes(key) ? key as WorkspaceStatus : undefined;
}

export type StatusAgent = { workspaceId?: string | null; status?: string | null; updatedAt?: string | null; labels?: Readonly<Record<string, string>> | null };

/** Where a desired status came from: the workspace's task, or an agent's explicit status label. */
export type DesiredStatus = { status: WorkspaceStatus | null; from: "task" | "agent" };

const finished = (status: TaskRecord["status"]) => status === "delivered" || status === "closed";

/**
 * The status each workspace should show; workspaces without an opinion are left out. It follows the workflow's label
 * policy (docs/user-guide, "Workspace labels and the agent workflow"):
 * - A task labels its own worktree workspace when it has one, else the workspaces it's assigned to on this host.
 * - A workspace with one active task shows that task's status. With several, its coordinator owns the label.
 * - Done needs every linked task finished and no running agent in the workspace.
 * - An agent's status label overrides the tasks; the most recently updated agent wins.
 */
export function desiredWorkspaceStatuses(input: { serverId: string; tasks: readonly TaskRecord[]; agents: readonly StatusAgent[] }): Map<string, DesiredStatus> {
  const linked = new Map<string, TaskRecord[]>();
  for (const task of input.tasks) {
    const targets = task.worktree
      ? [task.worktree.workspaceId]
      : task.assignments.filter(assignment => assignment.serverId === input.serverId).map(assignment => assignment.workspaceId);
    for (const workspaceId of new Set(targets)) linked.set(workspaceId, [...(linked.get(workspaceId) ?? []), task]);
  }
  const running = new Set(input.agents.filter(agent => agent.status === "running" && agent.workspaceId).map(agent => agent.workspaceId!));
  const desired = new Map<string, DesiredStatus>();
  for (const [workspaceId, tasks] of linked) {
    const active = tasks.filter(task => !finished(task.status));
    const status = active.length === 1 ? statusForTask(active[0].status)
      : active.length === 0 && !running.has(workspaceId) ? "done"
      : null;
    if (status) desired.set(workspaceId, { status, from: "task" });
  }
  const latest = new Map<string, { at: number; status: WorkspaceStatus | null }>();
  for (const agent of input.agents) {
    const status = parseWorkspaceStatus(agent.labels?.[WORKSPACE_STATUS_AGENT_LABEL]);
    if (status === undefined || !agent.workspaceId) continue;
    const at = Date.parse(agent.updatedAt ?? "") || 0;
    const seen = latest.get(agent.workspaceId);
    if (!seen || at > seen.at) latest.set(agent.workspaceId, { at, status });
  }
  for (const [workspaceId, { status }] of latest) desired.set(workspaceId, { status, from: "agent" });
  return desired;
}

/**
 * The workspaces whose status changed since Mission Control last set it. Only changes are applied, so a label someone
 * changes by hand, or a coordinator sets, stays until the workspace's work moves on.
 */
export function workspaceStatusChanges(desired: ReadonlyMap<string, DesiredStatus>, applied: Readonly<Record<string, WorkspaceStatus | null>>): { workspaceId: string; status: WorkspaceStatus | null; from: DesiredStatus["from"] }[] {
  return [...desired].filter(([workspaceId, { status }]) => !(workspaceId in applied) || applied[workspaceId] !== status)
    .map(([workspaceId, { status, from }]) => ({ workspaceId, status, from }));
}

/** A workspace you paused keeps its labels until you resume it; only an agent's explicit status label still applies. */
export const PAUSED_LABEL = "Paused";
