import { createHash } from "node:crypto";
import { join } from "node:path";
import type { PaseoApi } from "@getpaseo/client";
import type { PipelineInspection } from "../shared/pipeline";
import type { ActionDeliveryPlan } from "../shared/action-delivery";
import { automaticDeliveryReadiness } from "../shared/pipeline-model";
import { readActionBundle, readActionAuthorization, saveActionAuthorization, saveReportCompletion, reportEvidenceRevision } from "./action-bundles.mjs";
import { withRunLock } from "./decisions";
import type { TaskSource } from "./tasks";

type Ref = { serverId: string; taskId: string };
type Deps = { sources(serverId: string): Promise<TaskSource[]>; inspect(serverId: string, taskId: string, paseo: PaseoApi): Promise<PipelineInspection | null> };
export function createActionDeliveryService(deps: Deps) {
  async function prepare(ref: Ref, paseo: PaseoApi) {
    const source = (await deps.sources(ref.serverId)).find(item => item.task.taskId === ref.taskId);
    if (!source?.folder) throw new Error("The action task folder is unavailable.");
    const facts = await deps.inspect(ref.serverId, ref.taskId, paseo);
    if (!facts) throw new Error("This run has not adopted the automatic workflow.");
    const readiness = automaticDeliveryReadiness(facts);
    if (!readiness.ready) throw new Error(readiness.reason);
    if (!facts.entry.run || !facts.planRevision || !facts.agentPolicy || !["actions", "report"].includes(facts.deliveryKind ?? "code")) throw new Error("This task does not have a reviewed non-code delivery.");
    const run = facts.entry.run;
    const identity = { serverId: ref.serverId, taskId: ref.taskId, workspaceId: run.workspaceId, runId: run.runId };
    const args = { taskFolder: source.folder, runFolder: join(source.folder, "runs", run.runId), task: source.task, identity, planRevision: facts.planRevision, policyRevision: facts.agentPolicy.revision, checkpointDigest: reportEvidenceRevision(facts.checkpoints) };
    const snapshot = await readActionBundle(args);
    if (!snapshot || snapshot.kind !== facts.deliveryKind || facts.candidate?.head !== null || facts.candidate.tree !== snapshot.revision) throw new Error("The reviewed action bundle changed. Validate and review the current bundle.");
    const builder = [...(facts.assignments ?? [])].filter(item => ["execute", "fix"].includes(item.stage)).sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
    if (!builder) throw new Error("The assigned builder is unavailable for delivery.");
    const base = { taskId: ref.taskId, runId: run.runId, workspaceId: run.workspaceId, title: source.task.title, kind: snapshot.kind, revision: snapshot.revision, planRevision: facts.planRevision, policyRevision: facts.agentPolicy.revision, agentId: builder.agentId, bundle: snapshot.bundle };
    const fingerprint = createHash("sha256").update(JSON.stringify({ ...base, evidence: facts.checkpoints })).digest("hex");
    return { args, checkpointIds: facts.checkpoints.map(item => item.id), plan: { ...base, fingerprint } satisfies ActionDeliveryPlan };
  }
  async function check(ref: Ref, paseo: PaseoApi) {
    try {
      const { args, plan } = await prepare(ref, paseo);
      if (plan.kind === "report") return await withRunLock(args.runFolder, async () => {
        const current = await prepare(ref, paseo);
        await saveReportCompletion(current.args, { revision: current.plan.revision, fingerprint: current.plan.fingerprint, planRevision: current.plan.planRevision, policyRevision: current.plan.policyRevision, checkpointDigest: current.args.checkpointDigest, checkpointIds: current.checkpointIds, completedAt: new Date().toISOString() });
        return { ready: true, reason: "The read-only report passed validation and both independent reviews; its exact completion receipt is saved.", plan: current.plan, completed: true };
      });
      const prior = await readActionAuthorization(args);
      if (prior) {
        const same = prior.revision === plan.revision && prior.fingerprint === plan.fingerprint;
        if (same && prior.resumeState === "completed") return { ready: false, reason: `The authorized actions completed with verified execution evidence: ${prior.completion!.summary}`, plan: null, completed: true, authorized: true };
        return { ready: false, reason: same && prior.resumeState === "sent" ? "The authorized worker was resumed. Inspect its results before any further action." : "An earlier authorization may have reached the worker. Reconcile it before retrying or replacing the authorized bundle.", plan: null, completed: false, authorized: same && prior.resumeState === "sent" };
      }
      return { ready: true, reason: "The exact actions passed validation and both independent reviews. Human authorization is required before execution.", plan, completed: false };
    } catch (error) { return { ready: false, reason: error instanceof Error ? error.message : String(error), plan: null, completed: false }; }
  }
  async function authorize(input: Ref & { fingerprint: string; actorId: string }, paseo: PaseoApi) {
    let revision: string | null = null;
    try {
      const initial = await prepare(input, paseo);
      return await withRunLock(initial.args.runFolder, async () => {
        const { args, plan } = await prepare(input, paseo); revision = plan.revision;
        if (plan.kind !== "actions" || plan.fingerprint !== input.fingerprint) return { outcome: "refused" as const, reason: "The exact action preview changed. Read and authorize a fresh preview.", revision };
        const prior = await readActionAuthorization(args);
        if (prior) {
          if (prior.revision !== plan.revision || prior.fingerprint !== plan.fingerprint) return { outcome: "refused" as const, reason: "An earlier bundle was authorized. Reconcile its execution before replacing it.", revision: prior.revision };
          if (prior.resumeState === "completed") return { outcome: "refused" as const, reason: "These authorized actions already have verified completion evidence. Nothing was resumed again.", revision };
          return { outcome: (prior.resumeState === "sent" ? "resumed" : "uncertain") as "resumed" | "uncertain", reason: "This authorization was already recorded; no message was sent again.", revision };
        }
        const agent = (await paseo.agents.ref(plan.agentId).refresh())?.agent;
        if (!agent || agent.archivedAt || agent.workspaceId !== plan.workspaceId || agent.activeTurn || agent.pendingPermissions.length || !["idle", "closed"].includes(agent.status)) return { outcome: "refused" as const, reason: "The assigned worker is unavailable, busy, or waiting for permission.", revision };
        const value = { revision: plan.revision, fingerprint: plan.fingerprint, planRevision: plan.planRevision, policyRevision: plan.policyRevision, actorId: input.actorId, authorizedAt: new Date().toISOString(), agentId: plan.agentId, resumeState: "sending" as const };
        await saveActionAuthorization(args, value);
        const message = `Mission Control recorded explicit human authorization for action bundle ${plan.revision}. Task ${plan.taskId}, run ${plan.runId}. Authorization receipt: ${join(args.runFolder, "actions", "authorization.json")}\nRead the immutable bundle at ${join(args.runFolder, "actions", `bundle-${plan.revision}.json`)} and verify its revision, accepted plan and environment still match before any action. Execute only its exact reviewed steps, prerequisites and verification. Stop on changed facts, missing authority, unexpected effects or material scope changes. This does not authorize additional publication, deployment or production operations beyond the exact bundle. Save the actual execution and verification report inside this run folder, then use the task-bound Development Flow CLI record command with the same task/run/server/workspace and your agent identity. Its input must contain stage:'delivery', outcome:'completed', actionRevision:'${plan.revision}', a summary of actual results, nextAction, and nonempty evidence paths to those reports inside the run. The record command validates this exact authorization and stores a completion receipt. If execution fails or is incomplete, record the blocker instead; never submit completed. Record actual results and limitations in the task handoff. Never claim completion merely because authorization was received.\nExact authorized bundle:\n${JSON.stringify(plan.bundle, null, 2)}`;
        try {
          await paseo.agents.ref(plan.agentId).send(message, { messageId: `actions-${plan.fingerprint}` });
          await saveActionAuthorization(args, { ...value, resumeState: "sent" });
          return { outcome: "resumed" as const, reason: "Exact action authorization was recorded and the assigned worker was resumed. Execution results remain to be verified.", revision };
        } catch (error) {
          await saveActionAuthorization(args, { ...value, resumeState: "uncertain" }).catch(() => {});
          return { outcome: "uncertain" as const, reason: "Authorization was recorded, but delivery of the resume message is uncertain. Inspect the existing worker before retrying; nothing was automatically resent.", revision };
        }
      });
    } catch (error) { return { outcome: "refused" as const, reason: error instanceof Error ? error.message : String(error), revision }; }
  }
  return { check, authorize };
}
