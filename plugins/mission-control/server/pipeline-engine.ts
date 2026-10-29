import { randomUUID } from "node:crypto";
import type { FleetSnapshot } from "../shared/fleet";
import type { Pipeline } from "../shared/pipeline-state";
import type { PipelineInspection } from "../shared/pipeline";
import { nextPipelineStep, pipelineFingerprint, type PipelineStep } from "../shared/pipeline-model";
import { managedTasks, managedWorkerIds, taskWorkers } from "../shared/fleet-model";
import { fleetEvent, type FleetStore } from "./fleet-store";

type Deps = { store: FleetStore; snapshot(): Promise<FleetSnapshot>; inspect(row: Pipeline, snapshot: FleetSnapshot): Promise<PipelineInspection>;
  send(id: string, prompt: string, requestId: string): Promise<void>; prepare(id: string, taskId: string): Promise<void>; now?: () => number };
const active = (row: Pipeline) => ["running", "waiting", "ready"].includes(row.mode);
export function pipelinePrompt(row: Pipeline, facts: PipelineInspection, next: PipelineStep): string {
  return ["Mission Control — Run to draft PR", `Task ${row.taskId}; host ${row.remoteServerId}; run ${facts.entry.run?.runId ?? "start one for this existing task"}.`,
    `This wake-up authorizes only the ${next.stage} stage: ${next.message}`,
    "Use this coordinator's existing one-way registered host connection and native linked workers. Do not recreate pairing URLs or register Personal remotely.",
    "Keep this task, run and assigned workspace identity. Read context and the latest handoff. Existing work must be inspected and reused; do not create a duplicate task or PR.",
    next.stage === "plan" ? "Use intake/check-environment/plan-task as applicable. Save plan.md, a versioned readable planBrief and a Mission Control plan decision. Stop for human approval; do not implement." :
    next.stage === "review" ? "Start a fresh independent Reviewer agent, distinct from every implementer/fixer. Use review-changes and its OCR/Gortex workflow. It must inspect the exact current candidate and save actual findings. Never review your own work or treat a review worker's final text as evidence." :
    next.stage === "validate" ? "Use validate-changes for the approved implementation. Run the relevant checks, save actual output and report failures honestly. Do not edit code in this stage." :
    next.stage === "fix" ? "Use fix-findings for the recorded issues within the approved scope only. Material scope changes require a revised plan. Do not hide failing checks or unresolved findings." :
    "Use execute-task for the approved scope. For existing completed work, inspect it and save an implementation checkpoint; do not redo it merely because it predates this runner.",
    "At the end of execute/fix/validate/review, save a unique evidence report inside this exact run and call dev-flow.mjs checkpoint --task <this task> --server <this host> --workspace <run workspace> --run <this run> --agent <actual author's ID> --input <JSON file>.",
    'Checkpoint JSON: {"stage":"execute|fix|validate|review","verdict":"pass|repair|blocked","scope":"approved|needs_plan","summary":"actual result","evidence":["saved report path"]}. Choose actual enum values. A repair verdict must describe a substantiated, in-scope fix. Use blocked for dependencies, permissions or uncertain results.',
    "For a passing independent review, also request the human review decision with plain built/found/checks/limitations and findings. Acceptance and findings remain in Mission Control. Do not resolve or simulate any human decision.",
    `Saved plan version: ${facts.planRevision ?? "not approved"}; candidate: ${JSON.stringify(facts.candidate)}. Recheck these before changing code.`,
    `Recent saved stage reports (paths are relative to this exact run folder; read the reports before acting): ${JSON.stringify(facts.checkpoints.slice(0, 3).map(item => ({ stage: item.stage, verdict: item.verdict, scope: item.scope, author: item.agentId, summary: item.summary, evidence: item.evidence.map(file => file.path) })))}`,
    "Stop after this stage. The durable controller will choose the next step from saved checkpoints. No commit, push, PR publication, merge, deployment, Jira/ADO comments or other external updates are authorized by this wake-up.",
  ].join("\n\n");
}
export function createPipelineEngine(deps: Deps) {
  const now = deps.now ?? Date.now; let running = false; let stopped = false;
  async function set(id: string, patch: Partial<Pipeline>) { return deps.store.update(state => { const row = state.pipelines.find(item => item.id === id); if (!row || !active(row) || state.paused) return; Object.assign(row, patch, { updatedAt: new Date(now()).toISOString() }); }); }
  function permitted(row: Pipeline, snapshot: FleetSnapshot) {
    const coordinator = snapshot.coordinators.find(item => item.agentId === row.coordinatorId && item.remoteServerId === row.remoteServerId);
    const host = snapshot.hosts.find(item => item.serverId === row.remoteServerId)?.snapshot;
    if (snapshot.state.paused || snapshot.warnings.length || !coordinator || !host?.complete || host.serverId !== row.remoteServerId || host.warnings.length || now() - Date.parse(host.observedAt) > 90_000) return false;
    if (snapshot.state.stoppedAgentIds.includes(coordinator.agentId) || coordinator.agent.status !== "idle" || coordinator.agent.pendingPermissions || coordinator.agent.error || coordinator.agent.archivedAt || (coordinator.agent.attention && coordinator.agent.attentionReason !== "finished")) return false;
    const selected = host.tasks.find(item => item.task.taskId === row.taskId);
    if (!selected || (selected.run && !managedTasks(snapshot.serverId, coordinator, host).some(item => item.task.taskId === row.taskId))) return false;
    const ids = managedWorkerIds(snapshot.serverId, coordinator, host.agents);
    if (host.agents.some(agent => ids.has(agent.id) && ["running", "initializing"].includes(agent.status))) return false;
    if (coordinator.links.some(link => link.taskId === row.taskId && !host.agents.some(agent => agent.id === link.remoteAgentId))) return false;
    if (taskWorkers(selected, host, ids, coordinator.links).some(agent => agent.status === "error" || agent.pendingPermissions || agent.error || agent.archivedAt || host.stoppedAgentIds.includes(agent.id) || (agent.attention && agent.attentionReason !== "finished"))) return false;
    const task = host.tasks.find(item => item.task.taskId === row.taskId);
    const workspaceId = task?.run?.workspaceId ?? task?.task.worktree?.workspaceId ?? task?.task.assignments.find(item => item.serverId === row.remoteServerId)?.workspaceId;
    const workspace = host.workspaces.find(item => item.id === workspaceId);
    return !!workspace && !["archiving", "archived", "failed"].includes(workspace.status) && !workspace.labels.some(label => ["paused", "done"].includes(label.toLowerCase())) &&
      !host.agents.some(agent => agent.workspaceId === workspaceId && (["running", "initializing"].includes(agent.status) || agent.pendingPermissions));
  }
  async function cycle() {
    const snapshot = await deps.snapshot();
    if (snapshot.state.paused) return;
    const busyHosts = new Set(snapshot.coordinators.filter(coordinator => {
      if (["running", "initializing"].includes(coordinator.agent.status)) return true;
      const host = snapshot.hosts.find(item => item.serverId === coordinator.remoteServerId)?.snapshot; if (!host) return false;
      const ids = managedWorkerIds(snapshot.serverId, coordinator, host.agents);
      return host.agents.some(agent => ids.has(agent.id) && ["running", "initializing"].includes(agent.status));
    }).map(coordinator => coordinator.remoteServerId));
    let dispatched = 0;
    for (const initial of snapshot.state.pipelines) {
      if (stopped || dispatched >= 2) return;
      let row = (await deps.store.read()).pipelines.find(item => item.id === initial.id)!;
      if (!row || !active(row) || row.intake?.phase === "pending") continue;
      if (row.pending) { await set(row.id, { mode: "blocked", message: "A dispatch has no confirmed receipt. Inspect the coordinator's last message before acknowledging it; it will not be replayed." }); continue; }
      if (busyHosts.size >= 2 || !permitted(row, snapshot)) continue;
      let facts: PipelineInspection;
      try { facts = await deps.inspect(row, snapshot); }
      catch (error) { await set(row.id, { mode: "blocked", message: `Cannot verify stage evidence: ${error instanceof Error ? error.message : String(error)}` }); continue; }
      if (row.runId && row.runId !== facts.entry.run?.runId) { await set(row.id, { mode: "blocked", message: "The task's active run changed. Inspect it and explicitly resume to adopt the current run." }); continue; }
      const next = nextPipelineStep(row, facts); const fingerprint = pipelineFingerprint(facts, next);
      const prepare = next.mode === "ready" && row.lastDispatch !== fingerprint;
      if (row.stage !== next.stage || row.mode !== next.mode || row.message !== next.message || row.runId !== (facts.entry.run?.runId ?? null)) await set(row.id, { stage: next.stage, mode: next.mode, message: next.message, runId: facts.entry.run?.runId ?? null });
      if (!next.dispatch && !prepare) continue;
      if (row.lastSentAt && now() - Date.parse(row.lastSentAt) < 5 * 60_000) continue;
      if (row.lastDispatch === fingerprint) {
        await set(row.id, { mode: "blocked", message: "The worker stopped without a new stage checkpoint. Inspect its conversation and saved evidence before resuming." }); continue;
      }
      const date = new Date(now()).toISOString().slice(0, 10); const wakeups = row.date === date ? row.wakeups : 0;
      if (wakeups >= 24) { await set(row.id, { mode: "blocked", message: "The daily limit of 24 stage dispatches was reached. Inspect progress before resuming." }); continue; }
      const requestId = `mc-pipeline-${randomUUID()}`; const pending = { requestId, fingerprint, stage: next.stage, attemptedAt: new Date(now()).toISOString() };
      const before = await deps.store.read();
      await deps.store.update(state => {
        const current = state.pipelines.find(item => item.id === row.id);
        if (!current || !active(current) || current.pending || state.paused) throw new Error("Pipeline changed before dispatch.");
        current.pending = pending;
      }, before.revision);
      try {
        const fresh = await deps.snapshot(); const verified = await deps.inspect(row, fresh);
        const latestState = await deps.store.read(); const latest = latestState.pipelines.find(item => item.id === row.id);
        if (latestState.paused || !latest || !active(latest) || latest.pending?.requestId !== requestId || !permitted(latest, fresh) || pipelineFingerprint(verified, nextPipelineStep(latest, verified)) !== fingerprint) {
          await deps.store.update(state => { const current = state.pipelines.find(item => item.id === row.id); if (current?.pending?.requestId === requestId) current.pending = null; }); continue;
        }
        if (prepare) await deps.prepare(row.coordinatorId, row.taskId); else await deps.send(row.coordinatorId, pipelinePrompt(row, verified, next), requestId);
      } catch (error) {
        await set(row.id, { mode: "blocked", message: `Dispatch outcome is unconfirmed; it will not be replayed. Inspect the coordinator: ${error instanceof Error ? error.message : String(error)}` }); continue;
      }
      await deps.store.update(state => {
        const current = state.pipelines.find(item => item.id === row.id); if (current?.pending?.requestId !== requestId) return;
        current.pending = null; current.lastDispatch = fingerprint; current.lastSentAt = new Date(now()).toISOString(); current.date = date; current.wakeups = wakeups + 1;
        if (next.failureId) { current.repairIds.push(next.failureId); current.repairs++; }
        current.updatedAt = new Date(now()).toISOString();
        fleetEvent(state, { coordinatorId: row.coordinatorId, remoteServerId: row.remoteServerId, taskId: row.taskId, kind: "dispatch", message: prepare ? "Draft PR preview prepared. Waiting for exact publication approval." : `Run to draft PR: ${next.stage} stage dispatched.` });
      });
      dispatched++; busyHosts.add(row.remoteServerId);
    }
  }
  return { async tick() { if (running || stopped) return; running = true; try { await cycle(); } finally { running = false; } }, stop() { stopped = true; } };
}
