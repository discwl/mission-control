import type { PluginServerContext } from "@getpaseo/plugin/server";
import type { RpcInput, RpcOutput } from "@getpaseo/plugin";
import { captureIntake, routeIntake, intakeDiscoveryStatus, intakeDiscoveryStart, intakeDiscoveryImport } from "../shared/intake";
import { getMorningStatus, startMorningCheck, importMorningItems } from "../shared/morning";
import { createTask } from "../shared/tasks";
import { setFleetQueue, type FleetSnapshot } from "../shared/fleet";
import { pipelineCapabilities, startPipeline } from "../shared/pipeline";
import { invokeChatHost } from "./chat-transport";

/** Composition of existing guarded task/queue/runner operations; no second task store. */
export function registerIntake(server: PluginServerContext, snapshot: () => Promise<FleetSnapshot>, invalidate: () => void) {
  async function destination(input: { coordinatorId: string; remoteServerId: string }) {
    const fleet = await snapshot();
    const remote = fleet.hosts.find(host => host.serverId === input.remoteServerId);
    const age = remote?.snapshot ? Date.now() - Date.parse(remote.snapshot.observedAt) : NaN;
    if (!fleet.coordinators.some(c => c.agentId === input.coordinatorId && c.remoteServerId === input.remoteServerId)
      || !remote?.snapshot?.complete || remote.error || remote.snapshot.warnings.length || !Number.isFinite(age) || age < 0 || age > 90_000) {
      throw new Error("Refresh and choose a connected host with a complete workspace list and its coordinator.");
    }
    return { fleet, host: remote.snapshot };
  }
  async function route(input: RpcInput<typeof routeIntake>): Promise<RpcOutput<typeof routeIntake>> {
    const { fleet, host } = await destination(input);
    const entry = host.tasks.find(row => row.task.taskId === input.taskId);
    if (!entry || entry.problem) throw new Error("The saved task could not be read on this host. Refresh before continuing.");
    const receipt = (message: string, completed = true) => ({ taskId: entry.task.taskId, title: entry.task.title, action: input.action, completed, message });
    if (input.action === "backlog") return receipt("Task saved. This action did not launch a worker or change scheduling.");
    if (["closed", "delivered"].includes(entry.task.status) || entry.task.pullRequest || entry.run && !["intake", "plan"].includes(entry.run.stage)) throw new Error("This task already progressed beyond intake. Open its existing workflow instead of planning it again.");
    const existing = fleet.state.pipelines.find(row => row.remoteServerId === input.remoteServerId && row.taskId === input.taskId && !["done", "stopped"].includes(row.mode));
    if (existing) return receipt(`Existing runner: ${existing.stage} · ${existing.mode}. ${existing.message} No second runner was started.`);
    try {
      if (input.action === "queue") {
        setFleetQueue.output.parse(await invokeChatHost(fleet.serverId, setFleetQueue.name, { coordinatorId: input.coordinatorId, remoteServerId: input.remoteServerId, taskId: input.taskId, enabled: true, priority: 5, expectedRevision: fleet.state.revision }));
        const enabled = !fleet.state.paused && fleet.state.coordinators.some(c => c.agentId === input.coordinatorId && c.enabled);
        return receipt(`Queued for planning. ${enabled ? "Heartbeat can pick it up when eligible." : "Heartbeat is paused or not enrolled; it will not start automatically until enabled."} Plan approval remains required.`);
      }
      const runner = startPipeline.output.parse(await invokeChatHost(fleet.serverId, startPipeline.name, { coordinatorId: input.coordinatorId, remoteServerId: input.remoteServerId, taskId: input.taskId, expectedRevision: fleet.state.revision }));
      return receipt(`Planning requested. ${runner.message} The managed workflow waits for your plan, code and publication decisions.`);
    } catch (error) {
      return receipt(`Task saved; scheduling is not confirmed. Refresh its queue/runner before retrying. ${error instanceof Error ? error.message : String(error)}`, false);
    } finally { invalidate(); }
  }
  server.handle(intakeDiscoveryStatus, async ({ coordinatorId, ...input }) => {
    await destination({ coordinatorId, remoteServerId: input.serverId });
    return getMorningStatus.output.parse(await invokeChatHost(input.serverId, getMorningStatus.name, input));
  });
  server.handle(intakeDiscoveryStart, async ({ coordinatorId, ...input }) => {
    const { host } = await destination({ coordinatorId, remoteServerId: input.serverId });
    if (!host.workspaces.some(w => w.id === input.workspaceId && !["archived", "archiving", "failed"].includes(w.status))) throw new Error("Choose an available workspace on this host.");
    const status = getMorningStatus.output.parse(await invokeChatHost(input.serverId, getMorningStatus.name, { serverId: input.serverId }));
    if (status.agent?.busy || status.launch?.phase === "sending" && !status.agent) throw new Error("Discovery is running or its previous launch is unconfirmed. Open its agent and refresh before starting another scan.");
    return startMorningCheck.output.parse(await invokeChatHost(input.serverId, startMorningCheck.name, input));
  });
  server.handle(intakeDiscoveryImport, async ({ coordinatorId, ...input }) => {
    await destination({ coordinatorId, remoteServerId: input.serverId });
    try { return importMorningItems.output.parse(await invokeChatHost(input.serverId, importMorningItems.name, input)); }
    finally { invalidate(); }
  });
  server.handle(routeIntake, route);
  server.handle(captureIntake, async input => {
    const { host } = await destination(input);
    if (!host.workspaces.some(w => w.id === input.workspaceId && !["archived", "archiving", "failed"].includes(w.status))) throw new Error("Choose an available workspace on this host.");
    const capability = pipelineCapabilities.output.safeParse(await invokeChatHost(input.remoteServerId, pipelineCapabilities.name, { serverId: input.remoteServerId }));
    if (!capability.success || capability.data.serverId !== input.remoteServerId || !capability.data.idempotentIntake) throw new Error("Update Mission Control on this host before saving intake.");
    const task = createTask.output.parse(await invokeChatHost(input.remoteServerId, createTask.name, { serverId: input.remoteServerId, workspaceId: input.workspaceId, title: input.title, acceptanceCriteria: input.acceptanceCriteria, requestId: input.requestId }));
    if (task.taskId !== `task_${input.requestId.toLowerCase()}` || !task.assignments.some(a => a.serverId === input.remoteServerId && a.workspaceId === input.workspaceId)) throw new Error("Task receipt did not match this intake. Inspect it before retrying.");
    invalidate();
    if (input.action === "backlog") return { taskId: task.taskId, title: task.title, action: input.action, completed: true, message: "Saved to backlog. No worker launched and no automatic work enrolled." };
    try { return await route({ coordinatorId: input.coordinatorId, remoteServerId: input.remoteServerId, taskId: task.taskId, action: input.action }); }
    catch (error) { return { taskId: task.taskId, title: task.title, action: input.action, completed: false, message: `Task saved; ${input.action === "plan" ? "planning" : "queueing"} not confirmed. ${error instanceof Error ? error.message : String(error)}` }; }
  });
}
