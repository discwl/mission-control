import { randomUUID } from "node:crypto";
import type { PluginServerContext } from "@getpaseo/plugin/server";
import type { FleetSnapshot } from "../shared/fleet";
import { inspectPipeline, startPipeline, controlPipeline, pipelineInspectionSchema, pipelineCapabilities, prepareTaskWorktree } from "../shared/pipeline";
import { pipelineSchema, type Pipeline } from "../shared/pipeline-state";
import { supersedeDecisions } from "../shared/decisions";
import { inspectPipelineTask } from "./pipeline-inspect";
import { invokeChatHost } from "./chat-transport";
import { createPipelineEngine } from "./pipeline-engine";
import { registerPipelineIntake } from "./pipeline-intake";
import { registerIntake } from "./intake";
import { collectFleetHost, type FleetHostDeps } from "./fleet-host";
import { managedTasks, managedWorkerIds, taskWorkers } from "../shared/fleet-model";
import { sharedCheckoutMessage } from "../shared/pipeline-model";
import { daemonServerId } from "./agent-names";
import { withFleetConnection } from "./fleet-transport";
import { fleetEvent, type FleetStore } from "./fleet-store";
import { registerAgentPolicies, effectiveAgentPolicy } from "./agent-policy";
import { launchPipelineStage } from "../shared/stage-launch";
import { launchManagedStage } from "./stage-launch";
import type { PaseoApi } from "@getpaseo/client";
import { readPipelineEvidence } from "../shared/pipeline";

export function registerPipelineRuntime(server: PluginServerContext, store: FleetStore, hostDeps: FleetHostDeps,
  snapshot: () => Promise<FleetSnapshot>, send: (id: string, prompt: string, requestId: string) => Promise<void>, invalidate: () => void) {
  const finishIntake = registerPipelineIntake(server, store, snapshot, invalidate);
  registerIntake(server, snapshot, invalidate);
  registerAgentPolicies(server, store);
  async function inspectLocal(input: { serverId: string; workspaceId: string; taskId: string; workflowMode?: "manual" | "automatic" }, paseo: PaseoApi) {
    if (input.serverId !== await daemonServerId()) throw new Error("This vault belongs to a different host.");
    const host = await collectFleetHost(paseo, input.serverId, hostDeps);
    if (!host.complete || host.warnings.length) throw new Error("A complete task snapshot is required.");
    const entry = host.tasks.find(item => item.task.taskId === input.taskId);
    if (!entry) throw new Error("Task not found on this host.");
    let policy = await effectiveAgentPolicy(store, paseo, entry.task.projectId, entry.task.taskId, input.workflowMode ?? "manual");
    let facts = await inspectPipelineTask(input.serverId, input.workspaceId, input.taskId, entry, paseo, policy?.revision);
    if (!input.workflowMode && facts.workflowMode === "automatic") {
      policy = await effectiveAgentPolicy(store, paseo, entry.task.projectId, entry.task.taskId, "automatic");
      facts = await inspectPipelineTask(input.serverId, input.workspaceId, input.taskId, entry, paseo, policy?.revision);
    }
    facts.agentPolicy = policy;
    for (const checkpoint of facts.checkpoints.filter(item => item.execution?.policyRevision === facts.agentPolicy?.revision && item.execution)) {
      const agent = (await paseo.agents.ref(checkpoint.agentId).refresh())?.agent;
      if (!agent || agent.workspaceId !== input.workspaceId || agent.provider !== checkpoint.execution!.provider || agent.model !== checkpoint.execution!.model) throw new Error("A stage agent's actual provider/model no longer matches its saved assignment. Inspect it before continuing.");
    }
    return facts;
  }
  server.handle(launchPipelineStage, async (input, { paseo }) => {
    const facts = await inspectLocal({ ...input, taskId: input.row.taskId, workflowMode: input.row.workflowMode }, paseo);
    const host = await collectFleetHost(paseo, input.serverId, hostDeps);
    if (host.agents.some(agent => agent.workspaceId === input.workspaceId && (["running", "initializing"].includes(agent.status) || agent.pendingPermissions))) throw new Error("Another agent is active in this workspace.");
    return launchManagedStage(input, facts, paseo, store);
  });
  const engine = createPipelineEngine({ store, snapshot, send,
    dispatch: async (row, facts, fingerprint, requestId) => {
      const current = await snapshot();
      const workspaceId = facts.entry.run?.workspaceId ?? facts.entry.task.worktree?.workspaceId ?? facts.entry.task.assignments.find(item => item.serverId === row.remoteServerId)?.workspaceId;
      if (!workspaceId) throw new Error("Task workspace is unavailable.");
      return launchPipelineStage.output.parse(await invokeChatHost(row.remoteServerId, launchPipelineStage.name, { serverId: row.remoteServerId, workspaceId, row, fingerprint, requestId, parent: { serverId: current.serverId, agentId: row.coordinatorId } }));
    },
    inspect: async (row, current) => {
      const task = current.hosts.find(host => host.serverId === row.remoteServerId)?.snapshot?.tasks.find(entry => entry.task.taskId === row.taskId);
      const workspaceId = task?.run?.workspaceId ?? task?.task.worktree?.workspaceId ?? task?.task.assignments.find(item => item.serverId === row.remoteServerId)?.workspaceId;
      if (!workspaceId) throw new Error("Pipeline workspace is unavailable.");
      return pipelineInspectionSchema.parse(await invokeChatHost(row.remoteServerId, inspectPipeline.name, { serverId: row.remoteServerId, workspaceId, taskId: row.taskId, workflowMode: row.workflowMode }));
    },
    prepareWorktree: async (row, facts) => {
      // The worktree branches off the project workspace the task was assigned to.
      const workspaceId = facts.entry.task.assignments.find(item => item.serverId === row.remoteServerId)?.workspaceId;
      if (!workspaceId) throw new Error("The task has no project workspace on this host.");
      return prepareTaskWorktree.output.parse(await invokeChatHost(row.remoteServerId, prepareTaskWorktree.name, { serverId: row.remoteServerId, workspaceId, taskId: row.taskId }));
    },
    prepare: async (agentId, taskId, deliveryKind = "code") => {
      const result = await withFleetConnection(async (_paseo, origin) => origin.invokePluginRpc("mission-control", "chat.native-command", { agentId, text: `${deliveryKind === "code" ? "draft PR" : "actions"} ${taskId}` })) as { offerId?: string; state?: string; text?: string; completed?: boolean; authorized?: boolean };
      if (deliveryKind === "report" && result.completed) return { completed: true };
      if (deliveryKind === "actions" && result.authorized) return { authorized: true };
      if (!result.offerId || result.state !== "pending") throw new Error(result.text || "The final delivery preview is not ready.");
    },
  });
  server.handle(inspectPipeline, (input, { paseo }) => inspectLocal(input, paseo));
  server.handle(readPipelineEvidence, async (input, { paseo }) => input.serverId === await daemonServerId() ? inspectLocal(input, paseo) : pipelineInspectionSchema.parse(await invokeChatHost(input.serverId, inspectPipeline.name, input)));
  /**
   * Checks shared by both ways of switching a manual run to the automatic workflow. Returns the open plan/review requests
   * to retire and the task's earlier workers, which stop gating stages once the runner owns the task.
   */
  async function adoptionPlan(current: FleetSnapshot, input: { coordinatorId: string; remoteServerId: string; taskId: string; deliveryKind: Pipeline["deliveryKind"] }, allowWithoutRun = false) {
    const coordinator = current.coordinators.find(item => item.agentId === input.coordinatorId && item.remoteServerId === input.remoteServerId);
    const host = current.hosts.find(item => item.serverId === input.remoteServerId)?.snapshot;
    const task = host?.tasks.find(item => item.task.taskId === input.taskId);
    if (!coordinator || current.warnings.length || !host?.complete || host.warnings.length || !task) throw new Error("A complete current task snapshot is required before changing its workflow.");
    const run = task.run;
    // A manual runner whose task never started has nothing to retire; the engine gives a code task its worktree first.
    if (!run && !allowWithoutRun) throw new Error("This task has no run yet. Start it with the automatic workflow instead.");
    if (run && (run.workflowMode ?? "manual") === "automatic") throw new Error("This task already uses the automatic workflow.");
    if (["closed", "delivered"].includes(task.task.status) || task.task.pullRequest) throw new Error("This task already has delivery recorded. Continue with its existing PR.");
    if (run && input.deliveryKind !== (run.deliveryKind ?? "code")) throw new Error("An existing run must keep its recorded deliverable. Create a new task for a different deliverable.");
    if (current.coordinators.some(other => other.remoteServerId === input.remoteServerId && other.agentId !== input.coordinatorId && managedTasks(current.serverId, other, host).some(item => item.task.taskId === input.taskId))) {
      throw new Error("Another coordinator manages this task. Switch it from that coordinator's chat.");
    }
    if (input.deliveryKind === "code" && (run || task.task.worktree)) {
      if (!task.task.worktree) throw new Error(sharedCheckoutMessage);
      const worktree = host.workspaces.find(item => item.id === task.task.worktree!.workspaceId);
      if (!worktree || ["archiving", "archived", "failed"].includes(worktree.status)) throw new Error(`The task's worktree workspace ${task.task.worktree.workspaceId} is ${worktree?.status ?? "missing"}. Restore it before switching this task.`);
    }
    const latest = run ? task.decisions.filter(item => item.decision.runId === run.runId).sort((a, b) => b.decision.requestedAt.localeCompare(a.decision.requestedAt)) : [];
    if (["plan", "review"].some(kind => ["changes_requested", "blocked"].includes(latest.find(item => item.decision.kind === kind)?.decision.status ?? ""))) {
      throw new Error("This manual run still has your stop or change request. Complete and approve its revised manual plan/review, or start a fresh manual run, before switching it. Your earlier decisions are never overridden.");
    }
    const ids = managedWorkerIds(current.serverId, coordinator, host.agents);
    const workers = new Set([...taskWorkers(task, host, ids, coordinator.links).map(agent => agent.id), ...(run?.agentId ? [run.agentId] : []),
      ...coordinator.links.filter(link => link.remoteServerId === input.remoteServerId && link.taskId === input.taskId).map(link => link.remoteAgentId),
      ...host.agents.filter(agent => agent.labels["mission-control.task-id"] === input.taskId).map(agent => agent.id)]);
    const workspaceId = run?.workspaceId ?? task.task.worktree?.workspaceId ?? task.task.assignments.find(item => item.serverId === input.remoteServerId)?.workspaceId;
    if (host.agents.some(agent => (workers.has(agent.id) || agent.workspaceId === workspaceId) && (["running", "initializing"].includes(agent.status) || agent.pendingPermissions))) {
      throw new Error("Wait for the task's current worker or permission request before changing its workflow.");
    }
    const capability = pipelineCapabilities.output.parse(await invokeChatHost(input.remoteServerId, pipelineCapabilities.name, { serverId: input.remoteServerId }));
    if (!capability.automaticWorkflow || !capability.supersedeDecisions || input.deliveryKind === "code" && !capability.taskWorktrees || input.deliveryKind !== "code" && !capability.actionBundles) {
      throw new Error("Update this host's Mission Control before switching tasks to the automatic workflow.");
    }
    return { title: task.task.title, openDecisionIds: task.decisions.filter(item => item.decision.status === "open").map(item => item.decision.decisionId), retiredWorkerIds: [...workers].sort() };
  }
  /** Retires open old-flow requests on the task's host. Nothing is approved and nothing is sent to the old worker. */
  async function retireOpenRequests(remoteServerId: string, taskId: string, decisionIds: string[]) {
    if (!decisionIds.length) return;
    const day = new Date().toISOString().slice(0, 10);
    supersedeDecisions.output.parse(await invokeChatHost(remoteServerId, supersedeDecisions.name, { serverId: remoteServerId, taskId, decisionIds,
      note: `Retired on ${day} when this task switched to the automatic workflow. Not approved: a fresh independent plan check, validation and two independent reviews replace this request.` }));
  }
  const adoptedMessage = "Switched to the automatic workflow. Open old-flow requests were retired without approval; a fresh independent plan check comes next.";
  server.handle(startPipeline, async input => {
    input = startPipeline.input.parse(input);
    if (input.deliveryKind !== "code" && input.workflowMode !== "automatic") throw new Error("Non-code delivery requires the automatic workflow.");
    if (input.adoptExisting) {
      if (input.workflowMode !== "automatic") throw new Error("Switching an existing run requires the automatic workflow.");
      const before = await store.read();
      if (before.revision !== input.expectedRevision) throw new Error("The fleet changed. Refresh before switching this task.");
      if (before.paused) throw new Error("Resume fleet wake-ups before starting a task runner.");
      if (before.pipelines.some(item => !["stopped", "done"].includes(item.mode) && item.taskId === input.taskId)) throw new Error("A runner already owns this task. Inspect it there, or stop it before switching.");
      const plan = await adoptionPlan(await snapshot(), input);
      await retireOpenRequests(input.remoteServerId, input.taskId, plan.openDecisionIds);
      const row = pipelineSchema.parse({ id: randomUUID(), coordinatorId: input.coordinatorId, remoteServerId: input.remoteServerId, taskId: input.taskId, workflowMode: "automatic", deliveryKind: input.deliveryKind,
        title: plan.title, mode: "running", stage: "plan", runId: null, message: adoptedMessage, updatedAt: new Date().toISOString(), repairs: 0, repairIds: [], planRepairs: 0, planRepairIds: [],
        lastDispatch: null, lastSentAt: null, date: "", wakeups: 0, pending: null, retiredWorkerIds: plan.retiredWorkerIds });
      // The requests are already retired, so write against the latest revision; the task check below is the guard.
      await store.update(state => {
        if (state.paused) throw new Error("Resume fleet wake-ups before starting a task runner.");
        if (state.pipelines.some(item => !["stopped", "done"].includes(item.mode) && item.taskId === input.taskId)) throw new Error("A runner already owns this task. Its open requests were retired; inspect that runner.");
        for (const queued of state.queue.filter(item => item.taskId === row.taskId && item.remoteServerId === row.remoteServerId)) queued.enabled = false;
        state.pipelines.push(row);
        fleetEvent(state, { coordinatorId: row.coordinatorId, remoteServerId: row.remoteServerId, taskId: row.taskId, kind: "settings", message: `${adoptedMessage}${plan.openDecisionIds.length ? ` Retired requests: ${plan.openDecisionIds.length}.` : ""}` });
      });
      invalidate(); return row;
    }
    const current = await snapshot();
    const coordinator = current.coordinators.find(item => item.agentId === input.coordinatorId && item.remoteServerId === input.remoteServerId);
    const host = current.hosts.find(item => item.serverId === input.remoteServerId)?.snapshot;
    const task = host?.tasks.find(item => item.task.taskId === input.taskId);
    if (!coordinator || !host?.complete || host.warnings.length || current.warnings.length || !task) throw new Error("Choose a connected host with a complete current task snapshot.");
    if (task.run && !managedTasks(current.serverId, coordinator, host).some(item => item.task.taskId === input.taskId)) throw new Error("Adopt this task's existing worker into this coordinator before starting its runner.");
    if (["closed", "delivered"].includes(task.task.status) || task.task.pullRequest) throw new Error("This task already has delivery recorded. Continue with its existing PR.");
    if (task.run && input.workflowMode !== (task.run.workflowMode ?? "manual")) throw new Error(`This task already has a run. Start its runner with the existing workflow, or switch a manual run to automatic checks in one step with "automate pipeline ${input.taskId}"; its open requests are retired without approval.`);
    if (task.run && input.deliveryKind !== (task.run.deliveryKind ?? "code")) throw new Error("An existing run must keep its recorded deliverable. Create a new task for a different deliverable.");
    if (input.workflowMode === "automatic") {
      const capability = pipelineCapabilities.output.parse(await invokeChatHost(input.remoteServerId, pipelineCapabilities.name, { serverId: input.remoteServerId }));
      if (!capability.automaticWorkflow || input.deliveryKind !== "code" && !capability.actionBundles || input.deliveryKind === "code" && !task.run && !capability.taskWorktrees) throw new Error("Update this host's Mission Control before using automatic workflow.");
    }
    const row = pipelineSchema.parse({ id: randomUUID(), ...input, title: task.task.title, mode: "running", stage: "plan", runId: task.run?.runId ?? null, message: "Enrolled. Checking saved plan and stage evidence.", updatedAt: new Date().toISOString(), repairs: 0, repairIds: [], lastDispatch: null, lastSentAt: null, date: "", wakeups: 0, pending: null });
    await store.update(state => {
      if (state.paused) throw new Error("Resume fleet wake-ups before starting a task runner.");
      const active = state.pipelines.filter(item => !["stopped", "done"].includes(item.mode));
      if (active.some(item => item.taskId === input.taskId)) throw new Error("A runner already owns this task. Inspect it before starting another.");
      // Automatic runners queue per host. A manual runner drives the coordinator chat, so it stays alone.
      if (input.workflowMode !== "automatic" && active.some(item => item.workflowMode !== "automatic" && (item.remoteServerId === input.remoteServerId || item.coordinatorId === input.coordinatorId))) throw new Error("A manual runner already owns this host or coordinator. Inspect it before starting another.");
      for (const queued of state.queue.filter(item => item.taskId === row.taskId && item.remoteServerId === row.remoteServerId)) queued.enabled = false;
      state.pipelines.push(row); fleetEvent(state, { coordinatorId: row.coordinatorId, remoteServerId: row.remoteServerId, taskId: row.taskId, kind: "settings", message: row.workflowMode === "automatic" ? "Automatic workflow enrolled. Plan checking and two independent reviews precede exact human delivery authorization." : "Run to draft PR enrolled. Human plan, code and publication gates remain active." });
    }, input.expectedRevision);
    invalidate(); return row;
  });
  server.handle(controlPipeline, async input => {
    let adoption: Pipeline | undefined;
    let retired: string[] | undefined;
    if (input.action === "adopt-automatic") {
      const current = await snapshot();
      adoption = current.state.pipelines.find(item => item.id === input.id);
      if (!adoption || adoption.workflowMode === "automatic" || adoption.pending || !["paused", "waiting", "blocked"].includes(adoption.mode)) throw new Error("Pause the manual runner and inspect any pending dispatch before adopting automatic workflow.");
      if (current.state.revision !== input.expectedRevision) throw new Error("The fleet changed. Refresh before switching this task.");
      const plan = await adoptionPlan(current, adoption, true);
      // A waiting manual runner is still served by the engine; pause it before its requests are retired.
      if (adoption.mode === "waiting") {
        const waiting = adoption;
        await store.update(state => {
          const row = state.pipelines.find(item => item.id === waiting.id);
          if (!row || row.updatedAt !== waiting.updatedAt || row.pending || row.mode !== "waiting") throw new Error("The runner changed during workflow adoption. Refresh and try again.");
          row.mode = "paused"; row.message = "Pausing to switch this task to the automatic workflow."; row.updatedAt = new Date().toISOString();
          adoption = { ...row };
        });
      }
      await retireOpenRequests(adoption.remoteServerId, adoption.taskId, plan.openDecisionIds);
      retired = plan.retiredWorkerIds;
    }
    let result: Pipeline | undefined;
    await store.update(state => {
      const row = state.pipelines.find(item => item.id === input.id); if (!row) throw new Error("Runner no longer exists.");
      if (input.action === "adopt-automatic") {
        if (!adoption || row.updatedAt !== adoption.updatedAt || row.pending || row.workflowMode === "automatic") throw new Error("The runner changed during workflow adoption.");
        row.workflowMode = "automatic"; row.mode = "running"; row.stage = "plan"; row.runId = null;
        row.planRepairs = 0; row.planRepairIds = []; row.repairs = 0; row.repairIds = []; row.lastDispatch = null; row.lastSentAt = null;
        row.retiredWorkerIds = retired ?? [];
        row.message = adoptedMessage;
      } else if (input.action === "acknowledge") {
        if (!row.pending || row.pending.requestId !== input.requestId || !input.delivery) throw new Error("Inspect the exact pending dispatch and identify whether it was delivered.");
        row.lastDispatch = input.delivery === "sent" ? row.pending.fingerprint : null; row.pending = null; row.mode = "paused";
        row.message = "Dispatch inspected by you. Resume when ready.";
      } else {
        if (input.action === "resume" && row.pending) throw new Error("Inspect and acknowledge the uncertain dispatch before resuming.");
        if (input.action === "resume" && ["done", "stopped"].includes(row.mode)) throw new Error("This runner is finished. Start a new runner for a new attempt.");
        if (input.action === "resume") { state.stoppedAgentIds = state.stoppedAgentIds.filter(id => id !== row.coordinatorId); row.runId = null; if (row.message.startsWith("The worker stopped without")) row.lastDispatch = null; }
        row.mode = input.action === "pause" ? "paused" : input.action === "stop" ? "stopped" : "running";
        row.message = input.action === "resume" ? "Resumed. Rechecking the current task and revision before any work." : "Future stages stopped. Active worker turns keep their current state.";
      }
      row.updatedAt = new Date().toISOString(); result = { ...row };
      fleetEvent(state, { coordinatorId: row.coordinatorId, remoteServerId: row.remoteServerId, taskId: row.taskId, kind: "settings", message: row.message });
    // After retiring requests the fleet revision has moved on; the runner's updatedAt check above guards the switch.
    }, input.action === "adopt-automatic" ? undefined : input.expectedRevision);
    invalidate();
    if (input.action === "resume" && result?.intake?.phase === "pending") return finishIntake(result);
    return result!;
  });
  return engine;
}
