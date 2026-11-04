import { realpath } from "node:fs/promises";
import { isAbsolute, join, relative } from "node:path";
import type { PaseoApi } from "@getpaseo/client";
import type { FleetTask, FleetHost } from "../shared/fleet";
import type { PipelineInspection } from "../shared/pipeline";
import { assignedTask, type TaskSource } from "./tasks";
import { readPipelineCheckpoints } from "./pipeline-records.mjs";
import { verifyPlanApproval, readAutomaticPlan } from "./plan-snapshots.mjs";
import { reviewCandidate } from "./merge";
import { readStageAssignments } from "./stage-records.mjs";
import { readActionBundle, readActionAuthorization, readReportCompletion, reportEvidenceRevision } from "./action-bundles.mjs";
import { collectFleetHost, type FleetHostDeps } from "./fleet-host";
import { effectiveAgentPolicy } from "./agent-policy";
import type { FleetStore } from "./fleet-store";
import { readDeliveryFeedback } from "./delivery-feedback";

export async function inspectPipelineTask(serverId: string, workspaceId: string, taskId: string, entry: FleetTask, paseo: PaseoApi, policyRevision?: string): Promise<PipelineInspection> {
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
  const identity = { taskId, runId: run.runId, serverId, workspaceId };
  const savedAssignments = await readStageAssignments(runFolder, identity);
  const newest = [...savedAssignments].sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
  const workflowMode = newest?.workflowMode ?? "manual";
  const deliveryKind = newest?.deliveryKind ?? "code";
  const checkpoints = await readPipelineCheckpoints(runFolder, identity);
  const deliveryFeedback = workflowMode === "automatic" ? await readDeliveryFeedback({ taskFolder, runFolder, task: source.task, identity }) : null;
  const assignments = savedAssignments.map(item => ({ assignmentId: item.id, requestId: item.requestId, agentId: item.agentId, stage: item.stage, model: item.execution.model, createdAt: item.createdAt }));
  let planRevision: string | null = null; let problem = entry.problem;
  let submittedPlan: PipelineInspection["submittedPlan"] = null;
  if (workflowMode === "automatic") {
    const submitted = await readAutomaticPlan({ taskFolder, runFolder, task: source.task, identity, policyRevision });
    if (submitted?.currentMatch && submitted.scopeMatch && submitted.policyMatch) {
      const { revision, scopeRevision, plannerAgentId, plannerModel, policyRevision: savedPolicy, createdAt } = submitted;
      submittedPlan = { revision, scopeRevision, plannerAgentId, plannerModel, policyRevision: savedPolicy, createdAt }; planRevision = revision;
    }
  } else {
    const plan = entry.decisions.filter(item => item.decision.runId === run.runId && item.decision.kind === "plan").sort((a, b) => b.decision.requestedAt.localeCompare(a.decision.requestedAt))[0]?.decision;
    if (plan?.status === "approved") {
      try {
        if (plan.resume && plan.resume.phase !== "sent") throw new Error("Plan approval delivery to the worker is not confirmed.");
        const saved = await verifyPlanApproval({ taskFolder, runFolder, decision: plan }, plan.plan?.revision);
        planRevision = saved.revision;
      } catch (error) { problem = error instanceof Error ? error.message : String(error); }
    }
  }
  if (deliveryKind !== "code") {
    if (workflowMode !== "automatic") throw new Error("Action bundles require the automatic workflow.");
    const savedBundle = planRevision ? await readActionBundle({ taskFolder, runFolder, task: source.task, identity, allowStaleScope: true }) : null;
    const bundle = savedBundle?.planRevision === planRevision && savedBundle.scopeMatch !== false ? savedBundle : null;
    if (bundle && bundle.kind !== deliveryKind) throw new Error("The saved action bundle belongs to another delivery kind.");
    const actionBundle = bundle ? { revision: bundle.revision, kind: bundle.kind, summary: bundle.summary, createdAt: bundle.createdAt } : null;
    const candidate = bundle ? { head: null, tree: bundle.revision } : null;
    const receipt = await readActionAuthorization({ taskFolder, runFolder, task: source.task, identity });
    if (receipt && (!bundle || receipt.revision !== bundle.revision || receipt.planRevision !== planRevision || receipt.policyRevision !== policyRevision && policyRevision)) throw new Error("The authorized action bundle, plan or policy changed. Reconcile its execution receipt before preparing further actions.");
    const actionAuthorization = receipt ? { phase: receipt.resumeState === "completed" ? "completed" as const : receipt.resumeState === "sent" ? "sent" as const : "uncertain" as const, bundleRevision: receipt.revision } : null;
    const report = deliveryKind === "report" && bundle ? await readReportCompletion({ taskFolder, runFolder, task: source.task, identity, planRevision: planRevision!, policyRevision, checkpointDigest: reportEvidenceRevision(checkpoints) }) : null;
    const reportCompletion = report ? { revision: report.revision, planRevision: report.planRevision, policyRevision: report.policyRevision, completedAt: report.completedAt } : null;
    return { version: 1, entry, candidate, planRevision, checkpoints, assignments, problem, workflowMode, deliveryKind, submittedPlan, deliveryFeedback, actionBundle, actionAuthorization, reportCompletion };
  }
  const candidate = await reviewCandidate(workspace.workspaceDirectory);
  const after = await reviewCandidate(workspace.workspaceDirectory);
  if (candidate.head !== after.head || candidate.tree !== after.tree) throw new Error("Code changed during checkpoint inspection; retry after the worker finishes.");
  return { version: 1, entry, candidate, planRevision, checkpoints, assignments, problem, workflowMode, deliveryKind, submittedPlan, deliveryFeedback };
}

/** Cheap mode discrimination: no workspace access, Git process or inferred human approval. */
export async function hasAutomaticAssignment(source: TaskSource, run: FleetTask["run"]): Promise<boolean> {
  if (!run) return false;
  if (!source.folder) { if (run.workflowMode === "automatic") throw new Error("The automatic run folder is unavailable."); return false; }
  const assignments = await readStageAssignments(join(source.folder, "runs", run.runId), { taskId: source.task.taskId, runId: run.runId, serverId: run.serverId, workspaceId: run.workspaceId });
  if (assignments[0]?.workflowMode === "automatic") return true;
  if (run.workflowMode === "automatic") throw new Error("The automatic run has no matching managed assignment. Restore its evidence before delivery.");
  return false;
}

/** Rebuild final readiness from local records and live identities; callers cannot assert acceptance. */
async function inspectAutomaticEntry(serverId: string, taskId: string, paseo: PaseoApi, store: FleetStore, host: FleetHost, entry: FleetTask): Promise<PipelineInspection | null> {
  if (!entry.run) return null;
  const workspaceId = entry.run.workspaceId;
  const source = await assignedTask(serverId, workspaceId, taskId);
  if (!await hasAutomaticAssignment(source, entry.run)) return null;
  if (!host.complete || host.warnings.length) throw new Error("A complete current host snapshot is required for automatic delivery.");
  if (host.agents.some(item => item.workspaceId === workspaceId && (["running", "initializing"].includes(item.status) || item.pendingPermissions))) throw new Error("Wait for the workspace's active worker or permission request before preparing delivery.");
  const policy = await effectiveAgentPolicy(store, paseo, entry.task.projectId, taskId, "automatic");
  const facts = await inspectPipelineTask(serverId, workspaceId, taskId, entry, paseo, policy?.revision);
  if (facts.workflowMode !== "automatic") throw new Error("The managed workflow changed during delivery inspection.");
  facts.agentPolicy = policy;
  for (const checkpoint of facts.checkpoints.filter(item => item.execution?.policyRevision === policy?.revision && item.execution)) {
    const actual = (await paseo.agents.ref(checkpoint.agentId).refresh())?.agent;
    if (!actual || actual.workspaceId !== workspaceId || actual.provider !== checkpoint.execution!.provider || actual.model !== checkpoint.execution!.model) throw new Error("A saved review or validation agent no longer matches its recorded model and workspace.");
  }
  if (facts.submittedPlan) {
    const planner = (await paseo.agents.ref(facts.submittedPlan.plannerAgentId).refresh())?.agent;
    const selected = policy?.profiles.find(item => item.role === "planner");
    if (!planner || planner.workspaceId !== workspaceId || planner.model !== facts.submittedPlan.plannerModel || selected?.model !== planner.model || selected.provider !== planner.provider) throw new Error("The saved planner identity no longer matches the selected model and workspace.");
  }
  return facts;
}

/** Reuse one roster/vault scan only within a single ready-list request. */
export function createAutomaticInspectionScope(serverId: string, paseo: PaseoApi, store: FleetStore, deps: FleetHostDeps): (taskId: string) => Promise<PipelineInspection | null> {
  let host: Promise<FleetHost> | undefined;
  return async taskId => {
    const current = await (host ??= collectFleetHost(paseo, serverId, deps));
    const entry = current.tasks.find(item => item.task.taskId === taskId);
    if (!entry) throw new Error("The task is unavailable on this host.");
    return inspectAutomaticEntry(serverId, taskId, paseo, store, current, entry);
  };
}
export async function inspectAutomaticTask(serverId: string, taskId: string, paseo: PaseoApi, store: FleetStore, deps: FleetHostDeps): Promise<PipelineInspection | null> {
  return createAutomaticInspectionScope(serverId, paseo, store, deps)(taskId);
}
