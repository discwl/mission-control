import { randomUUID } from "node:crypto";
import type { PluginServerContext } from "@getpaseo/plugin/server";
import type { FleetSnapshot } from "../shared/fleet";
import { inspectPipeline, startPipeline, controlPipeline, pipelineInspectionSchema, pipelineCapabilities } from "../shared/pipeline";
import { pipelineSchema, type Pipeline } from "../shared/pipeline-state";
import { inspectPipelineTask } from "./pipeline-inspect";
import { invokeChatHost } from "./chat-transport";
import { createPipelineEngine } from "./pipeline-engine";
import { registerPipelineIntake } from "./pipeline-intake";
import { registerIntake } from "./intake";
import { collectFleetHost, type FleetHostDeps } from "./fleet-host";
import { managedTasks } from "../shared/fleet-model";
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
    prepare: async (agentId, taskId, deliveryKind = "code") => {
      const result = await withFleetConnection(async (_paseo, origin) => origin.invokePluginRpc("mission-control", "chat.native-command", { agentId, text: `${deliveryKind === "code" ? "draft PR" : "actions"} ${taskId}` })) as { offerId?: string; state?: string; text?: string; completed?: boolean; authorized?: boolean };
      if (deliveryKind === "report" && result.completed) return { completed: true };
      if (deliveryKind === "actions" && result.authorized) return { authorized: true };
      if (!result.offerId || result.state !== "pending") throw new Error(result.text || "The final delivery preview is not ready.");
    },
  });
  server.handle(inspectPipeline, (input, { paseo }) => inspectLocal(input, paseo));
  server.handle(readPipelineEvidence, async (input, { paseo }) => input.serverId === await daemonServerId() ? inspectLocal(input, paseo) : pipelineInspectionSchema.parse(await invokeChatHost(input.serverId, inspectPipeline.name, input)));
  server.handle(startPipeline, async input => {
    input = startPipeline.input.parse(input);
    if (input.deliveryKind !== "code" && input.workflowMode !== "automatic") throw new Error("Non-code delivery requires the automatic workflow.");
    const current = await snapshot();
    const coordinator = current.coordinators.find(item => item.agentId === input.coordinatorId && item.remoteServerId === input.remoteServerId);
    const host = current.hosts.find(item => item.serverId === input.remoteServerId)?.snapshot;
    const task = host?.tasks.find(item => item.task.taskId === input.taskId);
    if (!coordinator || !host?.complete || host.warnings.length || current.warnings.length || !task) throw new Error("Choose a connected host with a complete current task snapshot.");
    if (task.run && !managedTasks(current.serverId, coordinator, host).some(item => item.task.taskId === input.taskId)) throw new Error("Adopt this task's existing worker into this coordinator before starting its runner.");
    if (["closed", "delivered"].includes(task.task.status) || task.task.pullRequest) throw new Error("This task already has delivery recorded. Continue with its existing PR.");
    if (task.run && input.workflowMode !== (task.run.workflowMode ?? "manual")) throw new Error("This task already has a run. Start its runner with the existing workflow. To change a manual run, pause its runner and explicitly switch to automatic checks; existing approvals are preserved.");
    if (task.run && input.deliveryKind !== (task.run.deliveryKind ?? "code")) throw new Error("An existing run must keep its recorded deliverable. Create a new task for a different deliverable.");
    if (input.workflowMode === "automatic") {
      const capability = pipelineCapabilities.output.parse(await invokeChatHost(input.remoteServerId, pipelineCapabilities.name, { serverId: input.remoteServerId }));
      if (!capability.automaticWorkflow || input.deliveryKind !== "code" && !capability.actionBundles) throw new Error("Update this host's Mission Control before using automatic workflow.");
    }
    const row = pipelineSchema.parse({ id: randomUUID(), ...input, title: task.task.title, mode: "running", stage: "plan", runId: task.run?.runId ?? null, message: "Enrolled. Checking saved plan and stage evidence.", updatedAt: new Date().toISOString(), repairs: 0, repairIds: [], lastDispatch: null, lastSentAt: null, date: "", wakeups: 0, pending: null });
    await store.update(state => {
      if (state.paused) throw new Error("Resume fleet wake-ups before starting a task runner.");
      if (state.pipelines.some(item => !["stopped", "done"].includes(item.mode) && (item.remoteServerId === input.remoteServerId || item.coordinatorId === input.coordinatorId || item.taskId === input.taskId))) throw new Error("A runner already owns this host, coordinator or task. Inspect it before starting another.");
      for (const queued of state.queue.filter(item => item.taskId === row.taskId && item.remoteServerId === row.remoteServerId)) queued.enabled = false;
      state.pipelines.push(row); fleetEvent(state, { coordinatorId: row.coordinatorId, remoteServerId: row.remoteServerId, taskId: row.taskId, kind: "settings", message: row.workflowMode === "automatic" ? "Automatic workflow enrolled. Plan checking and two independent reviews precede exact human delivery authorization." : "Run to draft PR enrolled. Human plan, code and publication gates remain active." });
    }, input.expectedRevision);
    invalidate(); return row;
  });
  server.handle(controlPipeline, async input => {
    let adoption: Pipeline | undefined;
    if (input.action === "adopt-automatic") {
      const current = await snapshot();
      adoption = current.state.pipelines.find(item => item.id === input.id);
      if (!adoption || adoption.workflowMode === "automatic" || adoption.pending || !["paused", "waiting", "blocked"].includes(adoption.mode)) throw new Error("Pause the manual runner and inspect any pending dispatch before adopting automatic workflow.");
      const host = current.hosts.find(item => item.serverId === adoption!.remoteServerId)?.snapshot;
      const task = host?.tasks.find(item => item.task.taskId === adoption!.taskId);
      if (current.warnings.length || !host?.complete || host.warnings.length || !task) throw new Error("A complete current task snapshot is required before changing its workflow.");
      if (task.decisions.some(item => item.decision.status === "open")) throw new Error("Resolve the existing human decisions explicitly before changing this task's workflow.");
      const currentDecisions = task.decisions.filter(item => !task.run || item.decision.runId === task.run.runId).sort((a, b) => b.decision.requestedAt.localeCompare(a.decision.requestedAt));
      if (["plan", "review"].some(kind => ["changes_requested", "blocked"].includes(currentDecisions.find(item => item.decision.kind === kind)?.decision.status ?? ""))) throw new Error("This manual run still has a human stop or change request. Complete and approve its revised manual plan/review, or start a fresh manual run, before adopting automatic workflow. Existing decisions will not be overridden.");
      const workspaceId = task.run?.workspaceId ?? task.task.worktree?.workspaceId ?? task.task.assignments.find(item => item.serverId === adoption!.remoteServerId)?.workspaceId;
      if (host.agents.some(item => item.workspaceId === workspaceId && (["running", "initializing"].includes(item.status) || item.pendingPermissions))) throw new Error("Wait for the current worker or permission request before changing its workflow.");
      const capability = pipelineCapabilities.output.parse(await invokeChatHost(adoption.remoteServerId, pipelineCapabilities.name, { serverId: adoption.remoteServerId }));
      if (!capability.automaticWorkflow) throw new Error("Update this host before adopting automatic workflow.");
    }
    let result: Pipeline | undefined;
    await store.update(state => {
      const row = state.pipelines.find(item => item.id === input.id); if (!row) throw new Error("Runner no longer exists.");
      if (input.action === "adopt-automatic") {
        if (!adoption || row.updatedAt !== adoption.updatedAt || row.pending || row.workflowMode === "automatic") throw new Error("The runner changed during workflow adoption.");
        row.workflowMode = "automatic"; row.mode = "running"; row.stage = "plan"; row.runId = null;
        row.planRepairs = 0; row.planRepairIds = []; row.repairs = 0; row.repairIds = []; row.lastDispatch = null; row.lastSentAt = null;
        row.message = "Automatic workflow explicitly adopted. Existing decisions are preserved; a fresh independent plan check is required.";
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
    }, input.expectedRevision);
    invalidate();
    if (input.action === "resume" && result?.intake?.phase === "pending") return finishIntake(result);
    return result!;
  });
  return engine;
}
