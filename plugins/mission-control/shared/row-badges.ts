import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";
import type { FleetSnapshot } from "./fleet";
import { buildV2Tasks, type V2State, type V2Task } from "./mission-control-v2-model";

const rowBadgeSchema = z.object({ workspaceId: z.string(), label: z.string(), tone: z.enum(["muted", "success", "warning", "danger", "info"]), icon: z.string().optional(), accessibilityLabel: z.string() });
export type RowBadgeTone = z.infer<typeof rowBadgeSchema>["tone"];
export type RowBadge = Omit<z.infer<typeof rowBadgeSchema>, "workspaceId">;
/**
 * The sidebar badges for this host's own workspace rows, computed on the host from the snapshot its 30-second check
 * already read. A device fetches only this short list, never the whole fleet snapshot.
 */
export const readRowBadges = defineRpc({ name: "orchestrator.row-badges", input: z.object({}), output: z.object({ badges: z.array(rowBadgeSchema) }) });

// Most urgent wins when several tasks share a workspace (report tasks share their project checkout).
const urgency: Record<V2State, number> = { "Needs you": 4, Blocked: 3, Working: 2, "Waiting on worker": 2, Queued: 1, Delivered: 0, Unconfirmed: 0 };

function taskBadge(task: V2Task): RowBadge | null {
  const title = task.entry.task.title;
  switch (task.state) {
    case "Needs you": return { label: "Needs you", tone: "warning", icon: "CircleHelp", accessibilityLabel: `${title} needs you: ${task.next}` };
    case "Blocked": return { label: "Blocked", tone: "danger", icon: "TriangleAlert", accessibilityLabel: `${title} is blocked: ${task.next}` };
    case "Working": case "Waiting on worker": return { label: task.workflow.stage, tone: "info", accessibilityLabel: `${title}: ${task.workflow.stage}` };
    case "Queued": return { label: "Queued", tone: "muted", accessibilityLabel: `${title} is queued` };
    // Delivered tasks need nothing; unconfirmed ones would show last-known state as if current.
    default: return null;
  }
}

/** The workspace a task's work happens in on its own host: its run, then its worktree, then its assignment. */
function taskWorkspace(task: V2Task): string | null {
  const { entry, serverId } = task;
  return entry.run?.workspaceId ?? entry.task.worktree?.workspaceId ?? entry.task.assignments.find(item => item.serverId === serverId)?.workspaceId ?? null;
}

/**
 * Badges for the sidebar rows of `hostId`'s own workspaces, from that host's fleet snapshot (the same model as All work
 * and Needs you). A task's workspace shows its most urgent state. On a coordinating computer, a workspace holding
 * orchestrator chats shows how many of their hosts' tasks need you. A coordinating computer's own tasks aren't in its
 * fleet snapshot, so they get no badge.
 */
export function rowBadges(snapshot: FleetSnapshot, hostId: string, now: number): Map<string, RowBadge> {
  const tasks = buildV2Tasks(snapshot, { now });
  const best = new Map<string, { urgency: number; badge: RowBadge }>();
  for (const task of tasks) {
    if (task.serverId !== hostId) continue;
    const badge = taskBadge(task); const workspaceId = taskWorkspace(task);
    if (!badge || !workspaceId) continue;
    const current = best.get(workspaceId);
    if (!current || urgency[task.state] > current.urgency) best.set(workspaceId, { urgency: urgency[task.state], badge });
  }
  if (snapshot.serverId === hostId) {
    const hostsByWorkspace = new Map<string, Set<string>>();
    for (const coordinator of snapshot.coordinators) {
      const hosts = hostsByWorkspace.get(coordinator.workspaceId) ?? new Set<string>();
      hosts.add(coordinator.remoteServerId); hostsByWorkspace.set(coordinator.workspaceId, hosts);
    }
    for (const [workspaceId, hosts] of hostsByWorkspace) {
      const waiting = tasks.filter(task => hosts.has(task.serverId) && task.state === "Needs you").length;
      if (!waiting || best.has(workspaceId)) continue;
      best.set(workspaceId, { urgency: urgency["Needs you"], badge: { label: `${waiting} need${waiting === 1 ? "s" : ""} you`, tone: "warning", icon: "CircleHelp",
        accessibilityLabel: `${waiting} task${waiting === 1 ? "" : "s"} on this orchestrator's host${hosts.size === 1 ? "" : "s"} need${waiting === 1 ? "s" : ""} you` } });
    }
  }
  return new Map([...best].map(([workspaceId, value]) => [workspaceId, value.badge]));
}
