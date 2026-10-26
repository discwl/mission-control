import type { FleetAgent, FleetCoordinator, FleetHost, FleetQueueEntry, FleetTask } from "./fleet";
import type { OrchestratorWork } from "./orchestrator-work";

/** A coordinator can itself have been created by a setup agent in a different workspace. */
export function coordinatorCandidates(agents: readonly FleetAgent[]): FleetAgent[] {
  return agents.filter(agent => !agent.archivedAt && agent.workspaceId && !agents.some(parent => parent.id === agent.labels["paseo.parent-agent-id"] && parent.workspaceId === agent.workspaceId));
}

export const workflowStages = ["Intake", "Planning", "Ready", "Implementing", "Validating", "Code review", "Your review", "Delivery approval", "Delivered"] as const;
export type WorkflowStage = typeof workflowStages[number] | "Blocked";
export type Workflow = { stage: WorkflowStage; actor: "agent" | "you" | "dependency" | "done"; next: string; evidence: string };

export function managedWorkerIds(serverId: string, coordinator: FleetCoordinator, agents: readonly FleetAgent[]): Set<string> {
  const owned = coordinator.links.filter(link => link.serverId === serverId && link.agentId === coordinator.agentId && link.remoteServerId === coordinator.remoteServerId);
  const ids = new Set(owned.map(link => link.remoteAgentId));
  for (const agent of agents) if (agent.labels["paseo.parent-agent-id"] === coordinator.agentId
    && (agent.labels["paseo.parent-server-id"] || coordinator.remoteServerId) === serverId) ids.add(agent.id);
  let added = true;
  while (added) {
    added = false;
    for (const agent of agents) {
      const parent = agent.labels["paseo.parent-agent-id"];
      if (parent && ids.has(parent) && !ids.has(agent.id)
        && (agent.labels["paseo.parent-server-id"] || coordinator.remoteServerId) === coordinator.remoteServerId) {
        ids.add(agent.id); added = true;
      }
    }
  }
  return ids;
}

export function managedTasks(serverId: string, coordinator: FleetCoordinator, host: FleetHost): FleetTask[] {
  if (host.serverId !== coordinator.remoteServerId) return [];
  const ids = managedWorkerIds(serverId, coordinator, host.agents);
  const taskIds = new Set(coordinator.links.filter(link => link.serverId === serverId && link.agentId === coordinator.agentId && link.remoteServerId === host.serverId).flatMap(link => link.taskId ? [link.taskId] : []));
  for (const agent of host.agents) if (ids.has(agent.id) && agent.labels["mission-control.task-id"]) taskIds.add(agent.labels["mission-control.task-id"]);
  return host.tasks.filter(entry => taskIds.has(entry.task.taskId) || Boolean(entry.run?.agentId && ids.has(entry.run.agentId)));
}

export function taskWorkers(entry: FleetTask, host: FleetHost, allowed: ReadonlySet<string>, links: readonly OrchestratorWork[] = []): FleetAgent[] {
  const linked = new Set(links.filter(link => link.remoteServerId === host.serverId && link.taskId === entry.task.taskId).map(link => link.remoteAgentId));
  for (const agent of host.agents) if (allowed.has(agent.id) && (agent.id === entry.run?.agentId || agent.labels["mission-control.task-id"] === entry.task.taskId)) linked.add(agent.id);
  let added = true;
  while (added) {
    added = false;
    for (const agent of host.agents) if (allowed.has(agent.id) && !linked.has(agent.id) && linked.has(agent.labels["paseo.parent-agent-id"])
      && (!agent.labels["mission-control.task-id"] || agent.labels["mission-control.task-id"] === entry.task.taskId)
      && (agent.labels["paseo.parent-server-id"] || host.serverId) === host.serverId) { linked.add(agent.id); added = true; }
  }
  return host.agents.filter(agent => allowed.has(agent.id) && linked.has(agent.id));
}

export function taskWorkflow(entry: FleetTask, agents: readonly FleetAgent[]): Workflow {
  const { task, run } = entry;
  const evidence = run ? `${run.stage}: ${run.outcome} · ${run.gitHead?.slice(0, 8) ?? "revision unknown"}${run.gitDirty ? " + working changes" : ""}` : "No run evidence recorded";
  const result = (stage: WorkflowStage, actor: Workflow["actor"], next: string) => ({ stage, actor, next, evidence });
  if (task.status === "closed" || task.status === "delivered") return result("Delivered", "done", task.pullRequest ? "Delivery recorded · inspect PR status" : "Delivery recorded");
  if (entry.problem) return result("Blocked", "dependency", entry.problem);
  if (agents.some(agent => agent.pendingPermissions > 0)) return result("Blocked", "you", "Answer the worker's permission request");
  if (entry.questions.some(entry => entry.question.status === "open")) return result("Blocked", "you", "Answer the task's question");
  const decisions = [...entry.decisions].sort((a, b) => b.decision.requestedAt.localeCompare(a.decision.requestedAt));
  const open = decisions.find(entry => entry.decision.status === "open");
  if (open) return result(open.decision.kind === "plan" ? "Planning" : "Your review", "you", open.decision.kind === "plan" ? "Approve the implementation plan" : "Review the result and evidence");
  const current = decisions.filter(entry => !run || entry.decision.runId === run.runId);
  const review = current.find(entry => entry.decision.kind === "review");
  const plan = current.find(entry => entry.decision.kind === "plan");
  if (current.some(entry => entry.decision.status === "blocked")) return result("Blocked", "you", "Resolve the blocked decision");
  if (review?.decision.status === "approved") return result("Delivery approval", "you", task.pullRequest ? "Review PR follow-up · external changes need approval" : "Approve the exact PR or delivery action");
  if (agents.some(agent => agent.status === "error" || agent.error)) return result("Blocked", "you", "Inspect the worker error before retrying");
  if (task.status === "blocked" || run?.outcome === "blocked" || run?.outcome === "waiting") return result("Blocked", "you", run?.nextAction || "Resolve the recorded blocker");
  if (review?.decision.status === "changes_requested") return result("Implementing", "agent", "Address requested changes, validate, and request fresh review");
  if (task.status === "in_review") return result("Your review", "you", "Inspect review evidence before accepting work");
  if (!run) return result("Intake", "agent", "Prepare task context and a plan");
  if (run.stage === "intake") return result("Intake", "agent", run.nextAction || "Clarify scope and acceptance criteria");
  if (run.stage === "plan" && plan?.decision.status !== "approved") return result("Planning", "agent", "Prepare the plan and request your approval");
  if (plan?.decision.status !== "approved") return result("Blocked", "you", "A current approved plan is required to continue implementation");
  if (run.stage === "plan") return result("Ready", "agent", "Start approved implementation");
  if (run.stage === "execute" || run.stage === "fix") return result("Implementing", "agent", run.nextAction || "Continue approved work");
  if (run.stage === "validate") return result("Validating", "agent", run.nextAction || "Run checks and record revision-specific evidence");
  if (run.stage === "review") return result("Code review", "agent", run.nextAction || "Complete independent review and record findings");
  return result("Your review", "you", "Review the handoff and required evidence");
}

export function taskFingerprint(entry: FleetTask): string {
  return JSON.stringify([entry.task.taskId, entry.task.updatedAt, entry.run?.runId, entry.run?.updatedAt,
    entry.run?.stage, entry.run?.outcome, entry.run?.gitHead, entry.run?.gitChanges,
    entry.decisions.map(item => [item.decision.decisionId, item.revision]),
    entry.questions.map(item => [item.question.questionId, item.question.status])]);
}

export function chooseNextTask(serverId: string, coordinator: FleetCoordinator, host: FleetHost, queue: readonly FleetQueueEntry[]): { entry: FleetTask; workflow: Workflow } | null {
  if (!host.complete || host.warnings.length) return null;
  const ids = managedWorkerIds(serverId, coordinator, host.agents);
  const workers = host.agents.filter(agent => ids.has(agent.id));
  // One active task per coordinator; never steer an active worker from a timer.
  if (workers.some(agent => agent.status === "running" || agent.status === "initializing")) return null;
  const tasks = managedTasks(serverId, coordinator, host);
  for (const item of queue.filter(item => item.enabled && item.coordinatorId === coordinator.agentId && item.remoteServerId === host.serverId).sort((a, b) => b.priority - a.priority || a.updatedAt.localeCompare(b.updatedAt))) {
    const entry = tasks.find(entry => entry.task.taskId === item.taskId);
    if (!entry) continue;
    const assigned = taskWorkers(entry, host, ids, coordinator.links);
    const workspaceId = entry.run?.workspaceId || entry.task.worktree?.workspaceId || entry.task.assignments.find(item => item.serverId === host.serverId)?.workspaceId;
    const workspace = host.workspaces.find(item => item.id === workspaceId);
    if (!workspace || ["archiving", "archived", "failed"].includes(workspace.status) || workspace.labels.some(label => ["paused", "done", "blocked"].includes(label.toLowerCase()))) continue;
    if (host.agents.some(agent => (agent.workspaceId === workspaceId || agent.labels["mission-control.task-id"] === entry.task.taskId) && ["running", "initializing"].includes(agent.status))) continue;
    if (coordinator.links.some(link => link.taskId === entry.task.taskId && !host.agents.some(agent => agent.id === link.remoteAgentId))) continue;
    if (assigned.some(agent => host.stoppedAgentIds.includes(agent.id) || (agent.attention && agent.attentionReason !== "finished") || agent.pendingPermissions || agent.error || agent.status === "error" || agent.archivedAt)) continue;
    const workflow = taskWorkflow(entry, assigned);
    if (workflow.actor === "agent") return { entry, workflow };
  }
  return null;
}

export function workerDepth(agent: FleetAgent, agents: readonly FleetAgent[]): number {
  const seen = new Set([agent.id]); let parent = agent.labels["paseo.parent-agent-id"]; let depth = 0;
  while (parent && !seen.has(parent)) {
    const found = agents.find(item => item.id === parent); if (!found) break;
    seen.add(parent); depth++; parent = found.labels["paseo.parent-agent-id"];
  }
  return Math.min(depth, 6);
}
