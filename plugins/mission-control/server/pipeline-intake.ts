import type { PluginServerContext } from "@getpaseo/plugin/server";
import type { FleetSnapshot } from "../shared/fleet";
import { createTask } from "../shared/tasks";
import { intakePipeline, pipelineCapabilities } from "../shared/pipeline";
import { pipelineSchema, type Pipeline } from "../shared/pipeline-state";
import { invokeChatHost } from "./chat-transport";
import { daemonServerId } from "./agent-names";
import { fleetEvent, type FleetStore } from "./fleet-store";

export function registerPipelineIntake(server: PluginServerContext, store: FleetStore, snapshot: () => Promise<FleetSnapshot>, invalidate: () => void) {
  server.handle(pipelineCapabilities, async ({ serverId }) => { if (serverId !== await daemonServerId()) throw new Error("Wrong host."); return { serverId, version: 1 as const, idempotentIntake: true as const }; });
  async function verify(row: Pipeline) {
    const current = await snapshot();
    if (current.warnings.length || !current.coordinators.some(item => item.agentId === row.coordinatorId && item.remoteServerId === row.remoteServerId)) throw new Error("This coordinator's host binding changed.");
    const host = current.hosts.find(item => item.serverId === row.remoteServerId)?.snapshot;
    const workspace = host?.workspaces.find(item => item.id === row.intake?.workspaceId);
    if (!host?.complete || host.warnings.length || !workspace || ["archiving", "archived", "failed"].includes(workspace.status)) throw new Error("Choose an available project workspace on a connected, fully updated host.");
    const capability = pipelineCapabilities.output.parse(await invokeChatHost(row.remoteServerId, pipelineCapabilities.name, { serverId: row.remoteServerId }));
    if (capability.serverId !== row.remoteServerId || !capability.idempotentIntake) throw new Error("Update this host's Mission Control before creating a task runner.");
  }
  async function finish(row: Pipeline): Promise<Pipeline> {
    if (!row.intake || row.intake.phase !== "pending") return row;
    try {
      await verify(row);
      const task = createTask.output.parse(await invokeChatHost(row.remoteServerId, createTask.name, { serverId: row.remoteServerId, workspaceId: row.intake.workspaceId, title: row.title, acceptanceCriteria: row.intake.acceptanceCriteria, requestId: row.intake.requestId }));
      if (task.taskId !== row.taskId || !task.assignments.some(item => item.serverId === row.remoteServerId && item.workspaceId === row.intake!.workspaceId)) throw new Error("Intake receipt identity mismatch. Inspect the host before retrying.");
      await store.update(state => {
        const current = state.pipelines.find(item => item.id === row.id); if (!current?.intake || current.intake.phase !== "pending") return;
        current.intake.phase = "created"; current.updatedAt = new Date().toISOString();
        if (current.mode === "running") current.message = "Task created. Preparing its readable plan for your approval.";
        else if (current.mode === "blocked") current.message = "Intake confirmed. Resume this runner when ready to prepare its plan.";
        fleetEvent(state, { coordinatorId: row.coordinatorId, remoteServerId: row.remoteServerId, taskId: task.taskId, kind: "progress", message: "Intake saved in the existing Mission Control task store. Plan approval is next." });
      });
    } catch (error) {
      await store.update(state => { const current = state.pipelines.find(item => item.id === row.id); if (!current || ["stopped", "paused"].includes(current.mode)) return;
        current.mode = "blocked"; current.message = `Intake is not confirmed. Resume to check the same request safely; no duplicate task will be created. ${error instanceof Error ? error.message : String(error)}`; current.updatedAt = new Date().toISOString(); });
    }
    invalidate(); return (await store.read()).pipelines.find(item => item.id === row.id)!;
  }
  server.handle(intakePipeline, async input => {
    const state = await store.read();
    const existing = state.pipelines.find(item => item.id === input.requestId);
    if (existing) {
      if (existing.coordinatorId !== input.coordinatorId || existing.remoteServerId !== input.remoteServerId || existing.title !== input.title || existing.intake?.workspaceId !== input.workspaceId || existing.intake.acceptanceCriteria !== input.acceptanceCriteria) throw new Error("This intake request ID belongs to different details.");
      return existing.intake.phase === "created" || ["paused", "stopped"].includes(existing.mode) ? existing : finish(existing);
    }
    const row = pipelineSchema.parse({ id: input.requestId, coordinatorId: input.coordinatorId, remoteServerId: input.remoteServerId, taskId: `task_${input.requestId.toLowerCase()}`, title: input.title,
      intake: { requestId: input.requestId, workspaceId: input.workspaceId, acceptanceCriteria: input.acceptanceCriteria, phase: "pending" }, mode: "running", stage: "plan", runId: null,
      message: "Saving task intake.", updatedAt: new Date().toISOString(), repairs: 0, repairIds: [], lastDispatch: null, lastSentAt: null, date: "", wakeups: 0, pending: null });
    await verify(row);
    await store.update(current => {
      if (current.paused) throw new Error("Resume fleet wake-ups before starting a task runner.");
      if (current.pipelines.some(item => !["done", "stopped"].includes(item.mode) && (item.remoteServerId === row.remoteServerId || item.coordinatorId === row.coordinatorId))) throw new Error("A task runner already owns this coordinator or host.");
      current.pipelines.push(row); fleetEvent(current, { coordinatorId: row.coordinatorId, remoteServerId: row.remoteServerId, taskId: row.taskId, kind: "settings", message: "New task intake requested. Publishing remains separately gated." });
    }, input.expectedRevision);
    return finish(row);
  });
  return finish;
}
