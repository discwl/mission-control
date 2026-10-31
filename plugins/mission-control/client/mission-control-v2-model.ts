import type { FleetAgent, FleetCoordinator, FleetHost, FleetQueueEntry, FleetSnapshot, FleetTask } from "../shared/fleet";
import { managedTasks, taskWorkers, taskWorkflow, type Workflow } from "../shared/fleet-model";

export const missionControlV2ScreenId = "mission-control-v2";
export type V2View = "Needs you" | "Work" | "Up next";
export type V2State = "Needs you" | "Working" | "Waiting on worker" | "Blocked" | "Unconfirmed" | "Queued" | "Delivered";
export type V2Task = {
  key: string; serverId: string; hostLabel: string; host: FleetHost; entry: FleetTask;
  coordinators: FleetCoordinator[]; workers: FleetAgent[]; queue: FleetQueueEntry[];
  workflow: Workflow; state: V2State; next: string; waitingOn: string;
  observedAt: string; updatedAt: string; priority: number; staleReview: boolean; limited: boolean;
};

/** Keep known records visible during an outage, always labelled unconfirmed. Never retain removed hosts. */
export function retainV2Hosts(current: FleetSnapshot, previous?: FleetSnapshot | null): FleetSnapshot {
  return { ...current, hosts: current.hosts.map(host => {
    if (host.snapshot) return host;
    const last = previous?.hosts.find(item => item.serverId === host.serverId)?.snapshot;
    return last ? { ...host, snapshot: last, error: host.error || "No current host snapshot; showing last confirmed records." } : host;
  }) };
}

/** Host + task identity prevents duplicate cards when several coordinators own the same task. */
export function buildV2Tasks(snapshot: FleetSnapshot, options: { unconfirmed?: boolean; now?: number } = {}): V2Task[] {
  const rows = new Map<string, V2Task>();
  const now = options.now ?? Date.now();
  for (const remote of snapshot.hosts) {
    const host = remote.snapshot;
    if (!host) continue;
    const age = now - Date.parse(host.observedAt);
    const unconfirmed = Boolean(options.unconfirmed || remote.error || !Number.isFinite(age) || age > 90_000);
    const coordinators = snapshot.coordinators.filter(item => item.remoteServerId === remote.serverId);
    const ownership = new Map(coordinators.map(item => [item.agentId, new Set(managedTasks(snapshot.serverId, item, host).map(row => row.task.taskId))]));
    for (const entry of host.tasks) {
      const key = `${remote.serverId}:${entry.task.taskId}`;
      const updatedAt = entry.run?.updatedAt ?? entry.task.updatedAt;
      if (rows.has(key) && rows.get(key)!.updatedAt >= updatedAt) continue;
      const queue = snapshot.state.queue.filter(item => item.remoteServerId === remote.serverId && item.taskId === entry.task.taskId && item.enabled);
      const owners = coordinators.filter(item => ownership.get(item.agentId)?.has(entry.task.taskId)
        || queue.some(q => q.coordinatorId === item.agentId)
        || snapshot.state.pipelines.some(p => p.remoteServerId === remote.serverId && p.taskId === entry.task.taskId && p.coordinatorId === item.agentId));
      const workers = taskWorkers(entry, host, new Set(host.agents.map(agent => agent.id)), owners.flatMap(owner => owner.links));
      const workflow = taskWorkflow(entry, workers.filter(agent => !agent.archivedAt));
      const decisions = [...entry.decisions].sort((a, b) => b.decision.requestedAt.localeCompare(a.decision.requestedAt));
      const open = decisions.find(item => item.decision.status === "open");
      const question = entry.questions.find(item => item.question.status === "open");
      const reviewedHead = open?.decision.candidate?.head ?? open?.decision.gitHead;
      const staleReview = Boolean(open?.decision.kind === "review" && entry.run &&
        (open.decision.runId !== entry.run.runId || (reviewedHead && entry.run.gitHead && reviewedHead !== entry.run.gitHead)));
      const unresolvedDelivery = decisions.find(item => item.decision.status !== "open" && item.decision.resume && item.decision.resume.phase !== "sent");
      const running = workers.some(agent => ["running", "initializing", "starting"].includes(agent.status) && !agent.archivedAt);
      let state: V2State, next = workflow.next, waitingOn: string;
      if (unconfirmed) { state = "Unconfirmed"; waitingOn = "Host connection"; next = "Reconnect and refresh before relying on these last-known records."; }
      else if (workflow.actor === "done") { state = "Delivered"; waitingOn = "No action recorded"; }
      else if (entry.problem) { state = "Blocked"; waitingOn = "Record recovery"; next = entry.problem; }
      else if (workers.some(agent => !agent.archivedAt && agent.pendingPermissions > 0) || question || (open && (!staleReview || open.decision.kind === "plan"))) {
        state = "Needs you"; waitingOn = "You";
        if (question) next = question.question.plain?.need ?? question.question.question;
        else if (open) next = open.decision.kind === "plan" ? "Inspect the saved plan and approval request." : "Inspect the saved review and candidate evidence.";
      } else if (staleReview) { state = "Blocked"; waitingOn = "Fresh worker evidence"; next = "The saved run changed after this review. A fresh review is required."; }
      else if (unresolvedDelivery && !open) {
        const newer = decisions.some(item => item.decision.requestedAt > unresolvedDelivery.decision.requestedAt);
        if (!newer && unresolvedDelivery.decision.resume?.phase === "pending") { state = "Waiting on worker"; waitingOn = "Worker availability"; next = "Decision saved; worker delivery is pending. No repeat approval is needed."; }
        else if (!newer) { state = "Needs you"; waitingOn = "Delivery inspection"; next = "Delivery is unconfirmed. Inspect the worker before retrying."; }
        else { state = workflow.actor === "you" ? "Needs you" : running ? "Working" : "Waiting on worker"; waitingOn = workflow.actor === "you" ? "You" : "Worker"; }
      } else if (entry.problem || workflow.actor === "dependency") { state = "Blocked"; waitingOn = "Recorded blocker"; }
      else if (workflow.actor === "you") { state = "Needs you"; waitingOn = "You"; }
      else if (running) { state = "Working"; waitingOn = "Worker"; }
      else if (queue.length) { state = "Queued"; waitingOn = "Coordinator eligibility check"; }
      else { state = "Waiting on worker"; waitingOn = "Worker"; }
      rows.set(key, { key, serverId: remote.serverId, hostLabel: remote.label, host, entry, coordinators: owners, workers, queue, workflow, state, next, waitingOn, observedAt: host.observedAt, updatedAt, priority: Math.max(0, ...queue.map(item => item.priority)), staleReview, limited: !host.complete });
    }
  }
  return [...rows.values()];
}

export function v2Workspace(row: V2Task): string | null {
  const assignments = row.entry.task.assignments.filter(item => item.serverId === row.serverId);
  if (row.entry.run?.serverId === row.serverId && assignments.some(item => item.workspaceId === row.entry.run!.workspaceId)) return row.entry.run.workspaceId;
  const worktree = row.entry.task.worktree?.workspaceId;
  return assignments.find(item => item.workspaceId === worktree)?.workspaceId ?? assignments[0]?.workspaceId ?? null;
}

export function v2TasksForView(rows: readonly V2Task[], view: V2View, host = "all", search = ""): V2Task[] {
  const query = search.trim().toLowerCase();
  return rows.filter(row => (host === "all" || row.serverId === host)
    && (view === "Needs you" ? row.state === "Needs you" : view === "Up next" ? row.queue.length > 0 && row.state !== "Delivered" : true)
    && (!query || [row.entry.task.title, row.entry.task.ticket?.key, row.hostLabel, row.entry.task.taskId, row.state, row.next].join(" ").toLowerCase().includes(query)))
    .sort((a, b) => view === "Up next" ? b.priority - a.priority || a.updatedAt.localeCompare(b.updatedAt)
      : view === "Needs you" ? requestAt(a).localeCompare(requestAt(b)) || a.key.localeCompare(b.key)
      : b.updatedAt.localeCompare(a.updatedAt) || a.key.localeCompare(b.key));
}

function requestAt(row: V2Task): string {
  return [...row.entry.decisions.filter(item => item.decision.status === "open").map(item => item.decision.requestedAt),
    ...row.entry.questions.filter(item => item.question.status === "open").map(item => item.question.askedAt)].sort()[0] ?? row.updatedAt;
}
