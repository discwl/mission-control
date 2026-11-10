import { readFleet } from "../shared/fleet";
import { startPipeline, controlPipeline } from "../shared/pipeline";
import { invokeChatHost } from "./chat-transport";
export const PIPELINE_CHAT_HELP = "run to draft PR <task ID> — plan, independent plan check, build, validation and two model reviews; exact publication approval remains. Tasks queue per host; each host runs one stage at a time\npipeline <task ID> — show its stage and next action\npause pipeline <task ID> | resume pipeline <task ID> | stop pipeline <task ID> — control future stages\nautomate pipeline <task ID> — switch a task's manual run to automatic checks; its open plan/review requests are retired without approval";
export async function managePipelineChat(command: string, context: { local: string; target: string; agentId: string; label: string; orchestrator: boolean }): Promise<{ text: string } | null> {
  const start = /^run to draft pr\s+(task_[a-f0-9-]+)$/i.exec(command);
  const control = /^(?:(pause|resume|stop|automate)\s+)?pipeline\s+(task_[a-f0-9-]+)$/i.exec(command);
  if (!start && !control) return null;
  if (!context.orchestrator) return { text: "Use this in the coordinator chat whose workspace has the host folder binding." };
  const fleet = readFleet.output.parse(await invokeChatHost(context.local, readFleet.name, { refresh: true }));
  if (!fleet.coordinators.some(item => item.agentId === context.agentId && item.remoteServerId === context.target)) throw new Error("This chat no longer manages that host.");
  const taskId = start?.[1] ?? control![2];
  if (start) {
    const existing = fleet.state.pipelines.find(row => row.coordinatorId === context.agentId && row.remoteServerId === context.target && row.taskId === taskId && !["done", "stopped"].includes(row.mode));
    if (existing) return { text: `${context.label} · ${existing.title}\nAlready enrolled · ${existing.stage} · ${existing.mode}\n${existing.message}\nUse pipeline ${taskId} to inspect it.` };
    const task = fleet.hosts.find(host => host.serverId === context.target)?.snapshot?.tasks.find(item => item.task.taskId === taskId);
    const workflowMode = task?.run ? task.run.workflowMode ?? "manual" : "automatic";
    const deliveryKind = task?.run?.deliveryKind ?? "code";
    const result = startPipeline.output.parse(await invokeChatHost(context.local, startPipeline.name, { coordinatorId: context.agentId, remoteServerId: context.target, taskId, workflowMode, deliveryKind, expectedRevision: fleet.state.revision }));
    const workflow = result.workflowMode === "automatic" ? "Plan → Independent plan check → Build → Validation → Two independent model reviews → Final authorization." : `This existing run keeps its human plan and code-review approvals. To switch it to automatic checks, pause pipeline ${taskId}, then automate pipeline ${taskId}.`;
    return { text: `${context.label} · ${result.title}\nTask runner enrolled.\n${workflow}\nThe task, run and existing work are preserved. No plan, code or external action was approved.\nStatus: pipeline ${taskId}` };
  }
  const requested = control?.[1]?.toLowerCase();
  const activeRow = fleet.state.pipelines.find(row => row.coordinatorId === context.agentId && row.remoteServerId === context.target && row.taskId === taskId && !["done", "stopped"].includes(row.mode));
  if (requested === "automate" && !activeRow) {
    // No runner yet: switch the manual run in one guarded step, so no manual stage can start in between.
    const task = fleet.hosts.find(host => host.serverId === context.target)?.snapshot?.tasks.find(item => item.task.taskId === taskId);
    if (!task?.run) return { text: `${context.label} · ${task?.task.title ?? taskId}\nThis task has no run yet. Use run to draft PR ${taskId} to start it with the automatic workflow.` };
    const switched = startPipeline.output.parse(await invokeChatHost(context.local, startPipeline.name, { coordinatorId: context.agentId, remoteServerId: context.target, taskId, workflowMode: "automatic", deliveryKind: task.run.deliveryKind ?? "code", expectedRevision: fleet.state.revision, adoptExisting: true }));
    return { text: `${context.label} · ${switched.title}\nSwitched to the automatic workflow.\nOpen old-flow plan or review requests were retired without approval. Next: a fresh independent plan check, then build, validation and two independent reviews. Publishing still needs your exact authorization.\nStatus: pipeline ${taskId}` };
  }
  const row = activeRow ?? [...fleet.state.pipelines].reverse().find(row => row.coordinatorId === context.agentId && row.remoteServerId === context.target && row.taskId === taskId);
  if (!row) return { text: "No runner for that task in this chat. Use run to draft PR <task ID> to enroll it, or automate pipeline <task ID> to switch its manual run." };
  const action = (requested === "automate" ? "adopt-automatic" : requested) as "pause" | "resume" | "stop" | "adopt-automatic" | undefined;
  const result = action ? controlPipeline.output.parse(await invokeChatHost(context.local, controlPipeline.name, { id: row.id, action, expectedRevision: fleet.state.revision })) : row;
  return { text: `${context.label} · ${result.title}\n${result.stage} · ${result.mode}\n${result.message}\nRepairs: implementation ${result.repairs}/2; plan ${result.planRepairs}/2\n${result.pending ? "This dispatch is unconfirmed. Inspect the coordinator and acknowledge its delivery in Orchestrator → Run to draft PR before resuming." : result.workflowMode === "automatic" ? "Questions remain in Mission Control. Planning and both model reviews use saved evidence; publishing or external actions still require exact authorization." : "Questions and plan/code approvals remain in Mission Control. Publishing still requires the exact draft PR proposal."}` };
}
