import { readFleet } from "../shared/fleet";
import { startPipeline, controlPipeline } from "../shared/pipeline";
import { invokeChatHost } from "./chat-transport";
export const PIPELINE_CHAT_HELP = "run to draft PR <task ID> — manage one task through the approval gates\npipeline <task ID> — show its stage and next action\npause pipeline <task ID> | resume pipeline <task ID> | stop pipeline <task ID> — control future stages";
export async function managePipelineChat(command: string, context: { local: string; target: string; agentId: string; label: string; orchestrator: boolean }): Promise<{ text: string } | null> {
  const start = /^run to draft pr\s+(task_[a-f0-9-]+)$/i.exec(command);
  const control = /^(?:(pause|resume|stop)\s+)?pipeline\s+(task_[a-f0-9-]+)$/i.exec(command);
  if (!start && !control) return null;
  if (!context.orchestrator) return { text: "Use this in the coordinator chat whose workspace has the host folder binding." };
  const fleet = readFleet.output.parse(await invokeChatHost(context.local, readFleet.name, { refresh: true }));
  if (!fleet.coordinators.some(item => item.agentId === context.agentId && item.remoteServerId === context.target)) throw new Error("This chat no longer manages that host.");
  const taskId = start?.[1] ?? control![2];
  if (start) {
    const existing = fleet.state.pipelines.find(row => row.coordinatorId === context.agentId && row.remoteServerId === context.target && row.taskId === taskId && !["done", "stopped"].includes(row.mode));
    if (existing) return { text: `${context.label} · ${existing.title}\nAlready enrolled · ${existing.stage} · ${existing.mode}\n${existing.message}\nUse pipeline ${taskId} to inspect it.` };
    const result = startPipeline.output.parse(await invokeChatHost(context.local, startPipeline.name, { coordinatorId: context.agentId, remoteServerId: context.target, taskId, expectedRevision: fleet.state.revision }));
    return { text: `${context.label} · ${result.title}\nRun to draft PR enrolled.\nPlan → Your approval → Build → Checks → Independent review → Your code review → Draft PR preview → Your publication approval.\nThe task, run and existing work are preserved. No plan, code or external action was approved.\nStatus: pipeline ${taskId}` };
  }
  const row = [...fleet.state.pipelines].reverse().find(row => row.coordinatorId === context.agentId && row.remoteServerId === context.target && row.taskId === taskId);
  if (!row) return { text: "No runner for that task in this chat. Use run to draft PR <task ID> to enroll it." };
  const action = control?.[1]?.toLowerCase() as "pause" | "resume" | "stop" | undefined;
  const result = action ? controlPipeline.output.parse(await invokeChatHost(context.local, controlPipeline.name, { id: row.id, action, expectedRevision: fleet.state.revision })) : row;
  return { text: `${context.label} · ${result.title}\n${result.stage} · ${result.mode}\n${result.message}\nRepair attempts: ${result.repairs}/2\n${result.pending ? "This dispatch is unconfirmed. Inspect the coordinator and acknowledge its delivery in Orchestrator → Run to draft PR before resuming." : "Questions and plan/code approvals remain in Mission Control. Publishing still requires the exact draft PR proposal."}` };
}
