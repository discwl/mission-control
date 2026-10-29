import { realpath } from "node:fs/promises";
import { isAbsolute, join, relative } from "node:path";
import type { PaseoApi } from "@getpaseo/client";
import type { FleetTask } from "../shared/fleet";
import type { PipelineInspection } from "../shared/pipeline";
import { assignedTask } from "./tasks";
import { readPipelineCheckpoints } from "./pipeline-records.mjs";
import { verifyPlanApproval } from "./plan-snapshots.mjs";
import { reviewCandidate } from "./merge";

export async function inspectPipelineTask(serverId: string, workspaceId: string, taskId: string, entry: FleetTask, paseo: PaseoApi): Promise<PipelineInspection> {
  const source = await assignedTask(serverId, workspaceId, taskId);
  if (entry.task.taskId !== taskId || entry.task.hostId !== source.task.hostId) throw new Error("Pipeline task identity changed.");
  const run = entry.run;
  if (!run) return { version: 1, entry, candidate: null, planRevision: null, checkpoints: [], problem: entry.problem };
  if (run.serverId !== serverId || run.workspaceId !== workspaceId || !source.folder) throw new Error("Pipeline run belongs to another workspace.");
  const workspace = await paseo.workspaces.ref(workspaceId).refresh();
  if (!workspace?.workspaceDirectory || workspace.archivingAt) throw new Error("Pipeline workspace is unavailable.");
  const taskFolder = await realpath(source.folder); const runFolder = await realpath(join(taskFolder, "runs", run.runId));
  const rel = relative(taskFolder, runFolder);
  if (!rel || isAbsolute(rel) || rel === ".." || rel.startsWith("..\\") || rel.startsWith("../")) throw new Error("Pipeline run escapes its task.");
  const candidate = await reviewCandidate(workspace.workspaceDirectory);
  const checkpoints = await readPipelineCheckpoints(runFolder, { taskId, runId: run.runId, serverId, workspaceId });
  const plan = entry.decisions.filter(item => item.decision.runId === run.runId && item.decision.kind === "plan").sort((a, b) => b.decision.requestedAt.localeCompare(a.decision.requestedAt))[0]?.decision;
  let planRevision: string | null = null; let problem = entry.problem;
  if (plan?.status === "approved") {
    try {
      if (plan.resume && plan.resume.phase !== "sent") throw new Error("Plan approval delivery to the worker is not confirmed.");
      const saved = await verifyPlanApproval({ taskFolder, runFolder, decision: plan }, plan.plan?.revision);
      planRevision = saved.revision;
    } catch (error) { problem = error instanceof Error ? error.message : String(error); }
  }
  const after = await reviewCandidate(workspace.workspaceDirectory);
  if (candidate.head !== after.head || candidate.tree !== after.tree) throw new Error("Code changed during checkpoint inspection; retry after the worker finishes.");
  return { version: 1, entry, candidate, planRevision, checkpoints, problem };
}
