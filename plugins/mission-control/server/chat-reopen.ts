import { readFleet, readFleetHost } from "../shared/fleet";
import { startReopenedPipeline } from "../shared/pipeline";
import { reopenDeliveredTask } from "../shared/tasks";
import { invokeChatHost } from "./chat-transport";

type ChatHost = { local: string; target: string; agentId: string; label: string; orchestrator: boolean };
const message = (cause: unknown) => cause instanceof Error ? cause.message : String(cause);

export async function reopenFromChat(command: string, context: ChatHost) {
  const match = /^reopen\s+(task_[a-f0-9-]+)\s+([\s\S]+)$/i.exec(command.trim());
  if (!match) return { text: "Use /mc reopen <task ID> <what needs fixing>. Copy the task ID from All work." };
  const taskId = match[1], reason = match[2].trim();
  const { local, target, agentId, label } = context;
  const readCoordinators = async () => {
    const fleet = readFleet.output.parse(await invokeChatHost(local, readFleet.name, {}));
    if (fleet.serverId !== local) throw new Error("The coordinating computer returned a different host identity.");
    const coordinators = fleet.coordinators.filter(item => item.remoteServerId === target);
    if (context.orchestrator && !coordinators.some(item => item.agentId === agentId)) throw new Error("This chat no longer coordinates that host.");
    return { fleet, coordinators };
  };
  // A host binding and a currently registered coordinator must agree before a remote task is changed.
  if (context.orchestrator) await readCoordinators();
  else if (local !== target) throw new Error("Open this task on its owning host or in its coordinator chat.");
  const host = readFleetHost.output.parse(await invokeChatHost(target, readFleetHost.name, { serverId: target }));
  if (!host.complete || host.serverId !== target) throw new Error("A complete snapshot from the owning host is needed to reopen this task.");
  const entry = host.tasks.find(row => row.task.taskId === taskId);
  if (!entry || entry.problem) return { text: `Open All work on ${label} and check the task ID and its records.` };
  const { task } = entry;
  const assignments = task.assignments.filter(a => a.serverId === target);
  const workspaceId = task.worktree?.sourceWorkspaceId ?? assignments[0]?.workspaceId;
  if (!workspaceId || !assignments.some(a => a.workspaceId === workspaceId)) throw new Error("The task's source workspace does not belong to this host.");
  let fix = task;
  if (task.status === "delivered" && task.pullRequest?.mergedAt) {
    const input = reopenDeliveredTask.input.parse({ serverId: target, workspaceId, taskId, expectedUpdatedAt: task.updatedAt, reason });
    try { fix = reopenDeliveredTask.output.parse(await invokeChatHost(target, reopenDeliveredTask.name, input)); }
    catch (error) { return { text: `Reopen could not be confirmed on ${label}. ${message(error)}\nRefresh All work. If the task is Delivered, check that Mission Control on its host supports Reopen and retry. If it is Ready, select Start fix.` }; }
    const delivery = fix.deliveryHistory?.at(-1);
    if (fix.taskId !== taskId || fix.projectId !== task.projectId || fix.hostId !== task.hostId || delivery?.previousRevision !== task.updatedAt || delivery.reason !== reason) throw new Error("The host returned a different task or delivery revision. Refresh All work before starting a fix.");
  } else if (!task.deliveryHistory?.length || task.deliveryHistory.at(-1)?.reason !== reason || task.status !== "ready" || task.pullRequest) {
    return { text: `Open ${task.title} in All work. Reopen requires a Delivered task with a confirmed PR merge. To retry an existing fix, use its original reason or select Start fix.` };
  }
  const reopenedAt = fix.deliveryHistory?.at(-1)?.reopenedAt;
  if (fix.status !== "ready" || !reopenedAt || !fix.worktree || fix.worktree.sourceWorkspaceId !== workspaceId || !fix.assignments.some(a => a.serverId === target && a.workspaceId === fix.worktree!.workspaceId)) throw new Error("Refresh All work to confirm the saved fix workspace before starting it.");
  const ready = `${label} · ${fix.title}\nTask reopened on ${fix.worktree.branch}.`;
  try {
    const { fleet, coordinators } = await readCoordinators();
    const previous = [...fleet.state.pipelines].reverse().find(row => row.taskId === taskId && row.remoteServerId === target && coordinators.some(c => c.agentId === row.coordinatorId));
    const coordinatorId = context.orchestrator ? agentId : previous?.coordinatorId ?? (coordinators.length === 1 ? coordinators[0].agentId : undefined);
    if (!coordinatorId || fleet.state.paused) return { text: `${ready} ${fleet.state.paused ? "The fleet is paused." : "Choose the orchestrator for this fix."} Select Start fix in All work when ready.` };
    const input = startReopenedPipeline.input.parse({ coordinatorId, remoteServerId: target, taskId, reopenedAt, expectedRevision: fleet.state.revision });
    const row = startReopenedPipeline.output.parse(await invokeChatHost(local, startReopenedPipeline.name, input));
    if (row.taskId !== taskId || row.coordinatorId !== coordinatorId || row.remoteServerId !== target || row.reopenedAt !== reopenedAt) throw new Error("The runner receipt does not match this fix.");
    return { text: `${ready} Standard fix enrolled. Follow its runner in Orchestrator.` };
  } catch (error) { return { text: `${ready} Enrollment could not be confirmed. ${message(error)}\nCheck its runner in All work, then select Start fix to retry.` }; }
}
