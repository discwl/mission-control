import { configureSupervisor, readFleet, readFleetHost, setFleetQueue } from "../shared/fleet";
import { setOrchestratorWork } from "../shared/orchestrator-work";
import { invokeChatHost } from "./chat-transport";

import { managePipelineChat } from "./chat-pipeline";

export async function manageChatCommand(command: string, context: { local: string; target: string; agentId: string; label: string; orchestrator: boolean }): Promise<{ text: string } | null> {
  const pipeline = await managePipelineChat(command, context); if (pipeline) return pipeline;
  const adopt = /^adopt\s+(task_[a-f0-9-]+)(?:\s+worker\s+(\S+))?$/i.exec(command);
  const queue = /^(queue|unqueue)\s+(task_[a-f0-9-]+)(?:\s+priority\s+([0-9]))?$/i.exec(command);
  const heartbeat = /^(?:(pause|resume) )?heartbeat$/i.exec(command);
  if (!adopt && !queue && !heartbeat) return null;
  const { local, target, agentId, label } = context;
  if (!context.orchestrator) return { text: "Open this command in a coordinator chat whose workspace has its host.json binding." };
  if (adopt) {
    const host = readFleetHost.output.parse(await invokeChatHost(target, readFleetHost.name, { serverId: target }));
    if (!host.complete || host.serverId !== target) throw new Error("A complete, current host snapshot is needed before linking existing work.");
    const entry = host.tasks.find(entry => entry.task.taskId === adopt[1]);
    if (!entry || entry.problem || ["closed", "delivered"].includes(entry.task.status)) return { text: "That task is unavailable, completed, or has unreadable records. No worker was linked or resumed." };
    // A closed worker is resting (Paseo 0.14 releases idle agents) and can still be linked and resumed.
    const candidates = host.agents.filter(worker => !worker.archivedAt && worker.workspaceId && (worker.id === entry.run?.agentId || worker.labels["mission-control.task-id"] === entry.task.taskId));
    const matches = adopt[2] ? candidates.filter(worker => worker.id === adopt[2]) : candidates;
    if (matches.length !== 1) return { text: matches.length ? `${label} · ${entry.task.title}\nChoose the worker explicitly:\n${matches.map(worker => `adopt ${entry.task.taskId} worker ${worker.id} — ${worker.name}`).join("\n")}` : "No active worker with an exact task association was found. The task was preserved; open it in Mission Control to select or resume its worker." };
    const worker = matches[0];
    const input = setOrchestratorWork.input.parse({ serverId: local, agentId, remoteServerId: target, remoteAgentId: worker.id, remoteWorkspaceId: worker.workspaceId, taskId: entry.task.taskId, linked: true });
    setOrchestratorWork.output.parse(await invokeChatHost(local, setOrchestratorWork.name, input));
    return { text: `${label} · ${entry.task.title}\nLinked ${worker.name} to this coordinator. The task ID, workspace, code, reviews and history are preserved. Linking has not resumed work or enrolled it for heartbeat dispatch.` };
  }
  const fleet = readFleet.output.parse(await invokeChatHost(local, readFleet.name, { refresh: true }));
  const coordinator = fleet.coordinators.find(item => item.agentId === agentId && item.remoteServerId === target);
  if (!coordinator) throw new Error("This coordinator no longer belongs to that host folder.");
  const current = fleet.state.coordinators.find(item => item.agentId === agentId);
  if (heartbeat) {
    const runner = fleet.state.pipelines.find(row => row.coordinatorId === agentId && row.remoteServerId === target && !["done", "stopped"].includes(row.mode));
    if (!heartbeat[1]) return { text: `${label} · Heartbeat\n${!fleet.state.paused && (current?.enabled || runner && ["running", "waiting", "ready"].includes(runner.mode)) ? "Enabled" : "Paused or not enrolled"}\n${runner ? `Task runner: ${runner.title} · ${runner.stage} · ${runner.mode}\n${runner.message}\n` : ""}${current?.message ?? "General queue not enrolled"}\nInterval: ${current?.intervalMinutes ?? 5} minutes\nWakeups today: ${current?.wakeups ?? 0}/${current?.maxWakeupsPerDay ?? 24}\nOnly explicitly queued tasks can advance. Plan/review decisions and external publication still wait for you.` };
    const enabled = heartbeat[1].toLowerCase() === "resume";
    if (enabled && fleet.state.paused) return { text: "The whole fleet is paused. Resume the fleet in Orchestrator first; this command will not resume other coordinators." };
    const input = configureSupervisor.input.parse({ agentId, remoteServerId: target, enabled, intervalMinutes: current?.intervalMinutes ?? 5, maxWakeupsPerDay: current?.maxWakeupsPerDay ?? 24, expectedRevision: fleet.state.revision });
    configureSupervisor.output.parse(await invokeChatHost(local, configureSupervisor.name, input));
    return { text: `${label} · Heartbeat ${enabled ? "resumed for this coordinator's queued work" : "paused for this coordinator"}${runner ? "; its task runner was checked too" : ""}. Running turns are not canceled. Approval requirements are unchanged.` };
  }
  const task = fleet.hosts.find(host => host.serverId === target)?.snapshot?.tasks.find(entry => entry.task.taskId === queue![2]);
  if (!task) throw new Error("Task is unavailable on this host.");
  const input = setFleetQueue.input.parse({ coordinatorId: agentId, remoteServerId: target, taskId: queue![2], enabled: queue![1].toLowerCase() === "queue", priority: Number(queue![3] ?? 5), expectedRevision: fleet.state.revision });
  setFleetQueue.output.parse(await invokeChatHost(local, setFleetQueue.name, input));
  return { text: `${label} · ${task.task.title}\n${input.enabled ? `Queued with priority ${input.priority}` : "Removed from automatic work"}. Approval gates remain in place. Use ‘heartbeat’ to check whether this coordinator is enrolled.` };
}
