import { randomUUID } from "node:crypto";
import type { FleetAgent, FleetCoordinator, FleetSnapshot } from "../shared/fleet";
import { chooseNextTask, managedWorkerIds, taskFingerprint } from "../shared/fleet-model";
import { fleetEvent, type FleetStore } from "./fleet-store";

type Dependencies = {
  store: FleetStore; snapshot(): Promise<FleetSnapshot>;
  coordinator(id: string): Promise<FleetAgent | null>;
  revalidate(coordinator: FleetCoordinator, taskId: string, fingerprint: string): Promise<boolean>;
  send(id: string, prompt: string, requestId: string): Promise<void>;
  now?: () => number;
};
const canWake = (agent: FleetAgent | null) => agent && !agent.archivedAt && agent.status === "idle"
  && !agent.pendingPermissions && !agent.error && (!agent.attention || agent.attentionReason === "finished");

/** Advances only explicitly queued work. Never resolves decisions or performs delivery. */
export function createFleetSupervisor(deps: Dependencies) {
  const now = deps.now ?? Date.now;
  let running: Promise<void> | null = null; let stopped = false;
  async function cycle() {
    let state = await deps.store.read();
    if (stopped || state.paused || !state.coordinators.some(entry => entry.enabled && !entry.pending && (!entry.nextCheckAt || Date.parse(entry.nextCheckAt) <= now()))) return;
    const snapshot = await deps.snapshot();
    if (snapshot.warnings.length) return;
    const dispatchedHosts = new Set(snapshot.coordinators.filter(coordinator => ["running", "initializing"].includes(coordinator.agent.status)).map(coordinator => coordinator.remoteServerId));
    for (const coordinator of snapshot.coordinators) {
      const host = snapshot.hosts.find(host => host.serverId === coordinator.remoteServerId)?.snapshot;
      const ids = host ? managedWorkerIds(snapshot.serverId, coordinator, host.agents) : new Set<string>();
      if (host?.agents.some(agent => ids.has(agent.id) && ["running", "initializing"].includes(agent.status))) dispatchedHosts.add(coordinator.remoteServerId);
    }
    for (const coordinator of snapshot.coordinators) {
      if (stopped || dispatchedHosts.size >= 2) break;
      state = await deps.store.read();
      if (state.paused) break;
      const setting = state.coordinators.find(entry => entry.agentId === coordinator.agentId && entry.remoteServerId === coordinator.remoteServerId);
      if (!setting?.enabled || setting.pending || (setting.nextCheckAt && Date.parse(setting.nextCheckAt) > now())) continue;
      const at = new Date(now()).toISOString(); const date = at.slice(0, 10);
      let reason = "No eligible queued work. Waiting for a change.";
      const host = snapshot.hosts.find(host => host.serverId === coordinator.remoteServerId);
      const live = await deps.coordinator(coordinator.agentId);
      const busyHost = dispatchedHosts.has(coordinator.remoteServerId) || snapshot.coordinators.some(other => other.remoteServerId === coordinator.remoteServerId && ["running", "initializing"].includes(other.agent.status));
      let next = null;
      if (!host?.snapshot || host.error) reason = host?.error || "Host unavailable";
      else if (Date.parse(host.snapshot.observedAt) < now() - 60_000) reason = "Host state is stale; waiting for a fresh observation.";
      else if (!canWake(live)) reason = "Coordinator is busy or needs your attention.";
      else if (state.stoppedAgentIds.includes(coordinator.agentId)) reason = "You stopped this coordinator. Resume it explicitly.";
      else if (busyHost || state.coordinators.some(entry => entry.remoteServerId === coordinator.remoteServerId && entry.pending)) reason = "Another coordinator on this host is working or has an unconfirmed dispatch.";
      else if (setting.date === date && setting.wakeups >= setting.maxWakeupsPerDay) reason = "Daily wake-up limit reached. Waiting until tomorrow (UTC).";
      else next = chooseNextTask(snapshot.serverId, coordinator, host.snapshot, state.queue);
      const fingerprint = next ? taskFingerprint(next.entry) : null;
      if (fingerprint && setting.lastFingerprint === fingerprint && setting.unchangedAttempts >= 3) {
        reason = "Three wake-ups without new task evidence. Inspect this task before continuing."; next = null;
      }
      if (!next || !fingerprint) {
        await deps.store.update(current => {
          const entry = current.coordinators.find(entry => entry.agentId === coordinator.agentId);
          if (!entry) return;
          if (entry.message !== reason) fleetEvent(current, { coordinatorId: coordinator.agentId, remoteServerId: coordinator.remoteServerId, taskId: null, kind: "blocked", message: reason }, at);
          entry.message = reason; entry.lastCheckedAt = at;
          entry.nextCheckAt = new Date(now() + entry.intervalMinutes * 60_000).toISOString();
        });
        continue;
      }
      const task = next.entry.task; const requestId = `mc-supervisor-${randomUUID()}`;
      // Persist intent before send; a crash or lost acknowledgement is not permission to retry.
      const reserved = await deps.store.update(current => {
        const entry = current.coordinators.find(entry => entry.agentId === coordinator.agentId && entry.remoteServerId === coordinator.remoteServerId);
        if (stopped || current.paused || !entry?.enabled || entry.pending) throw new Error("Supervisor changed before dispatch.");
        if (!current.queue.some(item => item.coordinatorId === coordinator.agentId && item.remoteServerId === coordinator.remoteServerId && item.taskId === task.taskId && item.enabled)) throw new Error("Task left the automatic queue.");
        entry.pending = { requestId, taskId: task.taskId, fingerprint, attemptedAt: at }; entry.lastCheckedAt = at;
      }, state.revision);
      const prompt = [
        `[Mission Control heartbeat ${requestId}]`,
        `Continue only queued task ${task.taskId} on ${coordinator.hostLabel} (${coordinator.remoteServerId}).`,
        `Stage: ${next.workflow.stage}. Next action: ${next.workflow.next}`,
        `Workspace: ${next.entry.run?.workspaceId || task.worktree?.workspaceId || task.assignments.find(item => item.serverId === coordinator.remoteServerId)?.workspaceId}.`,
        "First reread mission-control-flow.md and reconcile this exact task, run, worker, decisions and questions through mc status/context. This heartbeat is not plan approval, review acceptance or delivery permission.",
        "Use the existing worker through mc start; do not duplicate it. Honor approved scope and host provider rules. Without an approved plan, only prepare the plan and request approval. Stop for questions, permissions, blocked or paused work.",
        "Never push, publish or merge PRs, post Jira/ADO comments, update external trackers, deploy, or perform other external writes from this heartbeat. Prepare exact drafts and wait for explicit user approval.",
        "Finished turns do not prove completion. Check validation and independent review evidence before user review. Preserve native worker identities and callbacks. Never register Personal remotely.",
        "Record actual progress or the blocker, then return control. Do not poll or start other tasks in this turn.",
      ].join("\n");
      try {
        const stillEligible = await deps.revalidate(coordinator, task.taskId, fingerprint);
        const before = await deps.coordinator(coordinator.agentId);
        const current = await deps.store.read();
        if (stopped || !stillEligible || !canWake(before) || current.paused || current.revision !== reserved.revision || !current.coordinators.some(entry => entry.enabled && entry.pending?.requestId === requestId)) {
          await deps.store.update(current => { const entry = current.coordinators.find(entry => entry.pending?.requestId === requestId); if (entry) { entry.pending = null; entry.message = "State changed before dispatch; no message sent."; } });
          continue;
        }
        await deps.send(coordinator.agentId, prompt, requestId);
        await deps.store.update(current => {
          const entry = current.coordinators.find(entry => entry.pending?.requestId === requestId); if (!entry) return;
          entry.pending = null; entry.wakeups = entry.date === date ? entry.wakeups + 1 : 1; entry.date = date;
          entry.unchangedAttempts = entry.lastFingerprint === fingerprint ? entry.unchangedAttempts + 1 : 1;
          entry.lastFingerprint = fingerprint; entry.lastSentAt = at;
          entry.nextCheckAt = new Date(now() + entry.intervalMinutes * 60_000).toISOString();
          entry.message = `Asked the coordinator to continue ${task.title}`;
          fleetEvent(current, { coordinatorId: coordinator.agentId, remoteServerId: coordinator.remoteServerId, taskId: task.taskId, kind: "dispatch", message: entry.message }, at);
        });
        dispatchedHosts.add(coordinator.remoteServerId);
      } catch {
        await deps.store.update(current => {
          const entry = current.coordinators.find(entry => entry.pending?.requestId === requestId);
          if (entry) { entry.enabled = false; entry.message = "Dispatch acknowledgement is uncertain. Inspect the coordinator before reconciling this attempt."; }
          fleetEvent(current, { coordinatorId: coordinator.agentId, remoteServerId: coordinator.remoteServerId, taskId: task.taskId, kind: "blocked", message: "Dispatch uncertain; automatic retries stopped." }, at);
        });
      }
    }
  }
  return {
    tick(): Promise<void> { if (stopped) return Promise.resolve(); if (!running) running = cycle().finally(() => { running = null; }); return running; },
    stop() { stopped = true; },
  };
}
