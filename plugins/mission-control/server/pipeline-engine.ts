import { randomUUID } from "node:crypto";
import type { FleetSnapshot } from "../shared/fleet";
import type { Pipeline } from "../shared/pipeline-state";
import { isQuiet } from "../shared/agent-tree";
import type { PipelineInspection } from "../shared/pipeline";
import { nextPipelineStep, pipelineFingerprint, missingReviewRole, type PipelineStep } from "../shared/pipeline-model";
import { managedTasks, managedWorkerIds, taskWorkers } from "../shared/fleet-model";
import { fleetEvent, type FleetStore } from "./fleet-store";

type Deps = { store: FleetStore; snapshot(): Promise<FleetSnapshot>; inspect(row: Pipeline, snapshot: FleetSnapshot): Promise<PipelineInspection>;
  dispatch?(row: Pipeline, facts: PipelineInspection, fingerprint: string, requestId: string): Promise<{ agentId: string; runId: string }>;
  send(id: string, prompt: string, requestId: string): Promise<void>; prepare(id: string, taskId: string, deliveryKind: Pipeline["deliveryKind"]): Promise<void | { completed?: boolean; authorized?: boolean }>; now?: () => number };
const active = (row: Pipeline) => ["running", "waiting", "ready"].includes(row.mode);
export function pipelinePrompt(row: Pipeline, facts: PipelineInspection, next: PipelineStep): string {
  if (row.workflowMode === "automatic") return automaticPipelinePrompt(row, facts, next);
  const readyForHuman = next.stage === "review" && Boolean(facts.agentPolicy) && !missingReviewRole(facts, facts.checkpoints.find(item => item.stage === "validate" && item.verdict === "pass")?.createdAt);
  return ["Mission Control — Run to draft PR", `Task ${row.taskId}; host ${row.remoteServerId}; run ${facts.entry.run?.runId ?? "start one for this existing task"}.`,
    `This wake-up authorizes only the ${next.stage} stage: ${next.message}`,
    "Use this coordinator's existing one-way registered host connection and native linked workers. Do not recreate pairing URLs or register Personal remotely.",
    "Keep this task, run and assigned workspace identity. Read context and the latest handoff. Existing work must be inspected and reused; do not create a duplicate task or PR.",
    next.stage === "plan" ? "Use intake/check-environment/plan-task as applicable. Save plan.md, a versioned readable planBrief and a Mission Control plan decision. Stop for human approval; do not implement." :
    readyForHuman ? "The configured independent reviews are complete. Read their saved reports and combine exact duplicate findings while retaining every model's concerns and provenance. Request the human code-review decision with a readable summary. Do not launch another reviewer or resolve any human decision." :
    next.stage === "review" ? "Use a fresh independent Reviewer agent, distinct from every implementer/fixer. Use review-changes and its OCR/Gortex workflow. Inspect the exact current candidate and save actual findings. Never review your own work or treat a review worker's final text as evidence." :
    next.stage === "validate" ? "Use validate-changes for the approved implementation. Run the relevant checks, save actual output and report failures honestly. Do not edit code in this stage." :
    next.stage === "fix" ? "Use fix-findings for the recorded issues within the approved scope only. Material scope changes require a revised plan. Do not hide failing checks or unresolved findings." :
    "Use execute-task for the approved scope. For existing completed work, inspect it and save an implementation checkpoint; do not redo it merely because it predates this runner.",
    "At the end of execute/fix/validate/review, save a unique evidence report inside this exact run and call dev-flow.mjs checkpoint --task <this task> --server <this host> --workspace <run workspace> --run <this run> --agent <actual author's ID> --input <JSON file>.",
    'Checkpoint JSON: {"stage":"execute|fix|validate|review","verdict":"pass|repair|blocked","scope":"approved|needs_plan","summary":"actual result","evidence":["saved report path"]}. Choose actual enum values. A repair verdict must describe a substantiated, in-scope fix. Use blocked for dependencies, permissions or uncertain results.',
    "For a passing independent review, also request the human review decision with plain built/found/checks/limitations and findings. Acceptance and findings remain in Mission Control. Do not resolve or simulate any human decision.",
    `Saved plan version: ${facts.planRevision ?? "not approved"}; candidate: ${JSON.stringify(facts.candidate)}. Recheck these before changing code.`,
    `Recent saved stage reports (paths are relative to this exact run folder; read the reports before acting): ${JSON.stringify(facts.checkpoints.filter(item => readyForHuman || next.stage !== "review" || item.stage !== "review").slice(0, readyForHuman ? 6 : 3).map(item => ({ stage: item.stage, verdict: item.verdict, scope: item.scope, author: item.agentId, model: item.execution?.model, summary: item.summary, evidence: item.evidence.map(file => file.path) })))}`,
    "Use existing project patterns and dependencies. Implement only the approved acceptance criteria. Avoid speculative abstractions and unrelated cleanup; material scope changes need a revised plan.",
    "Stop after this stage. The durable controller will choose the next step from saved checkpoints. No commit, push, PR publication, merge, deployment, Jira/ADO comments or other external updates are authorized by this wake-up.",
  ].join("\n\n");
}
function automaticPipelinePrompt(row: Pipeline, facts: PipelineInspection, next: PipelineStep): string {
  const nonCode = row.deliveryKind !== "code";
  const instruction = next.stage === "plan" ? "Use check-environment and plan-task. Save the readable plan and structured planBrief, then submit-plan under this managed assignment. Do not request or simulate human plan approval. Address concrete previous plan findings, if any; do not implement yet." :
    next.stage === "plan-review" ? "Independently check the immutable submitted plan, task requirements and repository evidence. Use a fresh plan-checker session with the assigned distinct model. Look for concrete correctness gaps, missing checks, unjustified scope and needless complexity. A sufficient plan should pass: do not invent changes or demand stylistic rewrites. Save planReview with its exact scopeRevision and findings; pass requires no unresolved findings. Ask a specific question for missing authority or material ambiguity." :
    next.stage === "review" ? nonCode ? "Review the exact saved action/report bundle independently. Examine scope, script behavior, targets, environment, preconditions, reversibility and safe checks. Record artifactReview with the exact bundle revision and concrete findings. Do not execute the proposed external actions. Do not read the other current reviewer's reports before saving your own judgment." : "Use a fresh independent Reviewer session and review-changes with OCR selection/rules plus Gortex repository evidence. Review the exact validated candidate. Save actual findings and complete OCR evidence. Do not read the other current reviewer's reports before saving your own judgment. Do not request a human code-review decision." :
    next.stage === "validate" ? "Use validate-changes. Run the relevant permitted checks against the exact candidate and save real output, limitations and failures. For scripts/actions, inspect and use safe local checks or dry runs only; external mutations still need final authorization. Do not edit in this stage." :
    next.stage === "fix" ? "Use fix-findings to repair only substantiated in-scope findings. Preserve all concerns from both reviews while combining exact duplicates. Save a new candidate checkpoint. Both validation and independent reviews must run again after a change." :
    nonCode ? "Prepare the exact action/report bundle from the checked plan. Save scripts, precise targets and environments, preconditions, expected effects and recovery steps using submit-action-bundle. Do not perform external mutations or production actions. Record preparation evidence." : "Use execute-task to implement the independently checked plan. Inspect and reuse existing work. Save actual implementation evidence for the exact candidate.";
  const reports = facts.checkpoints.filter(item => next.stage !== "review" || item.stage !== "review").slice(0, 6).map(item => ({ stage: item.stage, verdict: item.verdict, scope: item.scope, summary: item.summary, evidence: item.evidence.map(file => file.path) }));
  return ["Mission Control — automatic checked workflow", `Task ${row.taskId}; host ${row.remoteServerId}; run ${facts.entry.run?.runId ?? "start the managed run"}; delivery ${row.deliveryKind}.`,
    `This dispatch authorizes only ${next.stage}: ${next.message}`, instruction,
    "Use the owning workspace and task-bound Development Flow skills. Preserve user changes. Use Gortex for indexed evidence, follow existing patterns and choose the smallest maintainable change. No speculative abstractions, unrelated cleanup or features outside the acceptance criteria.",
    `Exact submitted plan: ${facts.planRevision ?? "not submitted"}; plan scope: ${facts.submittedPlan?.scopeRevision ?? "not submitted"}; candidate: ${JSON.stringify(next.stage === "plan-review" ? { head: null, tree: facts.planRevision } : facts.candidate)}.`,
    `Relevant saved reports: ${JSON.stringify(reports)}`,
    ...(facts.deliveryFeedback ? [`Explicit final change request ${facts.deliveryFeedback.id}: ${facts.deliveryFeedback.note}\nKeep this work within the existing checked scope. If the request changes scope or authority, save a specific question and stop. New implementation, validation and both reviews must address this request; prior evidence cannot clear it.`] : []),
    "After plan-review/execute/fix/validate/review, save a unique evidence report and record a checkpoint using this managed assignment. Record pass only for actual verified results; repair means a concrete in-scope defect; blocked means a missing prerequisite, authority or unresolved question. A plan-review checkpoint uses the plan artifact candidate and planReview.scopeRevision.",
    "Routine plan and code-review decisions are machine evidence, never fabricated human approvals. Ask the user only a concrete unresolved question, blocker or material scope decision. Commit, push, PR publication, tracker updates, merges, deployments and prepared external actions require separate exact final authorization.",
    "Stop after this assigned stage. The controller will choose the next step from saved evidence; do not launch additional stages yourself.",
  ].join("\n\n");
}
export function createPipelineEngine(deps: Deps) {
  const now = deps.now ?? Date.now; let running = false; let stopped = false;
  async function set(id: string, patch: Partial<Pipeline>) { return deps.store.update(state => { const row = state.pipelines.find(item => item.id === id); if (!row || !active(row) || state.paused) return; Object.assign(row, patch, { updatedAt: new Date(now()).toISOString() }); }); }
  function permitted(row: Pipeline, snapshot: FleetSnapshot) {
    const coordinator = snapshot.coordinators.find(item => item.agentId === row.coordinatorId && item.remoteServerId === row.remoteServerId);
    const host = snapshot.hosts.find(item => item.serverId === row.remoteServerId)?.snapshot;
    if (snapshot.state.paused || snapshot.warnings.length || !coordinator || !host?.complete || host.serverId !== row.remoteServerId || host.warnings.length || now() - Date.parse(host.observedAt) > 90_000) return false;
    if (snapshot.state.stoppedAgentIds.includes(coordinator.agentId) || !isQuiet(coordinator.agent) || coordinator.agent.pendingPermissions || coordinator.agent.error || coordinator.agent.archivedAt || (coordinator.agent.attention && coordinator.agent.attentionReason !== "finished")) return false;
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
      if (row.pending) { await set(row.id, { mode: "blocked", message: "A dispatch has no confirmed receipt. Inspect its remote stage worker under Reviewers and evidence or native Subagents; legacy messages and draft PR previews go to the coordinator. It will not be replayed." }); continue; }
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
      let worker: { agentId: string; runId: string } | null = null;
      let delivery: void | { completed?: boolean; authorized?: boolean };
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
        if (prepare) delivery = await deps.prepare(row.coordinatorId, row.taskId, row.deliveryKind);
        else if (verified.agentPolicy && deps.dispatch && (next.stage !== "review" || missingReviewRole(verified, verified.checkpoints.find(item => item.stage === "validate" && item.verdict === "pass")?.createdAt))) worker = await deps.dispatch(row, verified, fingerprint, requestId);
        else await deps.send(row.coordinatorId, pipelinePrompt(row, verified, next), requestId);
      } catch (error) {
        await set(row.id, { mode: "blocked", message: `Dispatch outcome is unconfirmed; it will not be replayed. Check its remote stage worker and coordinator before acknowledging delivery: ${error instanceof Error ? error.message : String(error)}` }); continue;
      }
      await deps.store.update(state => {
        const current = state.pipelines.find(item => item.id === row.id); if (current?.pending?.requestId !== requestId) return;
        current.pending = null; current.lastDispatch = fingerprint; current.lastSentAt = new Date(now()).toISOString(); current.date = date; current.wakeups = wakeups + 1;
        if (worker) { current.lastWorker = worker; current.runId = worker.runId; }
        if (next.failureId) { current.repairIds.push(next.failureId); current.repairs++; }
        if (next.planFailureId) { current.planRepairIds.push(next.planFailureId); current.planRepairs++; }
        if (delivery?.completed) { current.mode = "done"; current.message = "The reviewed report and final receipt are saved."; }
        else if (delivery?.authorized) { current.mode = "waiting"; current.message = "Exact action authorization is recorded. Waiting for actual execution results from the existing worker."; }
        current.updatedAt = new Date(now()).toISOString();
        fleetEvent(state, { coordinatorId: row.coordinatorId, remoteServerId: row.remoteServerId, taskId: row.taskId, kind: "dispatch", message: prepare ? delivery?.completed ? "Reviewed report completed." : row.deliveryKind === "code" ? "Draft PR preview prepared. Waiting for exact publication approval." : "Reviewed action bundle prepared. Waiting for exact action authorization." : `Managed workflow: ${next.stage} stage dispatched.` });
      });
      dispatched++; busyHosts.add(row.remoteServerId);
    }
  }
  return { async tick() { if (running || stopped) return; running = true; try { await cycle(); } finally { running = false; } }, stop() { stopped = true; } };
}
