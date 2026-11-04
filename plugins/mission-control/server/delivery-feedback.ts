import { randomUUID } from "node:crypto";
import { lstat, readFile, realpath, rename, writeFile } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import type { PaseoApi } from "@getpaseo/client";
import { z } from "zod";
import { deliveryFeedbackSchema, type DeliveryFeedback } from "../shared/delivery-feedback";
import type { PipelineInspection } from "../shared/pipeline";
import { automaticDeliveryReadiness } from "../shared/pipeline-model";
import { readActionAuthorization, readReportCompletion } from "./action-bundles.mjs";
import { withRunLock } from "./decisions";
import { withRepository } from "./project-git";
import type { TaskSource } from "./tasks";

type Identity = Pick<DeliveryFeedback, "serverId" | "workspaceId" | "taskId" | "runId">;
type Address = { taskFolder: string; runFolder: string; task: TaskSource["task"]; identity: Identity };
type Request = Identity & { requestId: string; expectedCandidate: DeliveryFeedback["candidate"]; expectedPlanRevision: string; expectedReviewFingerprint?: string; note: string; actorId: string };
type Deps = { sources(serverId: string): Promise<TaskSource[]>; inspect(serverId: string, taskId: string, paseo: PaseoApi): Promise<PipelineInspection | null>; projectRoot(projectId: string, paseo: PaseoApi): Promise<string>; reviewFingerprint(serverId: string, workspaceId: string, paseo: PaseoApi): Promise<string> };
const identitySchema = deliveryFeedbackSchema.pick({ taskId: true, runId: true, serverId: true, workspaceId: true });
const historySchema = z.object({ schemaVersion: z.literal(1), requests: z.array(deliveryFeedbackSchema).max(50) }).strict();
const identityKeys = ["taskId", "runId", "serverId", "workspaceId"] as const;
async function ordinary(path: string, directory: boolean) {
  const stat = await lstat(path);
  if (stat.isSymbolicLink() || (directory ? !stat.isDirectory() : !stat.isFile()) || resolve(await realpath(path)) !== resolve(path)) throw new Error("Delivery feedback must use an ordinary task/run path.");
}
async function history(args: Address): Promise<DeliveryFeedback[]> {
  identitySchema.parse(args.identity);
  if (args.task.taskId !== args.identity.taskId || basename(args.taskFolder) !== args.identity.taskId || resolve(args.runFolder) !== resolve(args.taskFolder, "runs", args.identity.runId) || !args.task.assignments.some(item => item.serverId === args.identity.serverId && item.workspaceId === args.identity.workspaceId)) throw new Error("Delivery feedback does not match the owning task/run.");
  await ordinary(args.taskFolder, true); await ordinary(join(args.taskFolder, "runs"), true); await ordinary(args.runFolder, true);
  const file = join(args.runFolder, "delivery-feedback.json");
  try { await ordinary(file, false); } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return []; throw error; }
  const records = historySchema.parse(JSON.parse(await readFile(file, "utf8"))).requests;
  const ids = new Set<string>();
  for (const record of records) {
    if (identityKeys.some(key => record[key] !== args.identity[key]) || ids.has(record.id)) throw new Error("Delivery feedback identity or request history changed.");
    ids.add(record.id);
  }
  return records;
}
export async function readDeliveryFeedback(args: Address): Promise<DeliveryFeedback | null> { return (await history(args)).at(-1) ?? null; }

/** Called only from the authenticated human UI/native connector. actorId is attribution, not authority. */
export function createDeliveryFeedbackService(deps: Deps) {
  async function request(input: Request, paseo: PaseoApi): Promise<DeliveryFeedback> {
    const initial = (await deps.sources(input.serverId)).find(item => item.task.taskId === input.taskId);
    if (!initial?.folder) throw new Error("The task folder is unavailable.");
    const identity = { taskId: input.taskId, runId: input.runId, serverId: input.serverId, workspaceId: input.workspaceId };
    const runFolder = join(initial.folder, "runs", input.runId);
    await history({ taskFolder: initial.folder, runFolder, task: initial.task, identity });
    const save = () => withRunLock(runFolder, async () => {
      const source = (await deps.sources(input.serverId)).find(item => item.task.taskId === input.taskId);
      if (!source?.folder || resolve(source.folder) !== resolve(initial.folder!)) throw new Error("The owning task changed.");
      const args = { taskFolder: source.folder, runFolder, task: source.task, identity };
      const records = await history(args), prior = records.find(item => item.id === input.requestId);
      if (prior) {
        if (prior.candidate.head !== input.expectedCandidate.head || prior.candidate.tree !== input.expectedCandidate.tree || prior.planRevision !== input.expectedPlanRevision || prior.reviewFingerprint !== input.expectedReviewFingerprint || prior.note !== input.note.trim() || prior.requestedBy !== input.actorId) throw new Error("This request ID already records different feedback.");
        return prior;
      }
      if (records.length >= 50) throw new Error("This run has too many final review requests; investigate it before continuing.");
      if (source.task.pullRequest || ["delivered", "closed"].includes(source.task.status)) throw new Error("This task has already been published or completed.");
      const facts = await deps.inspect(input.serverId, input.taskId, paseo);
      if (!facts || facts.workflowMode !== "automatic" || !facts.entry.run || identityKeys.some(key => facts.entry.run![key] !== identity[key])) throw new Error("This exact automatic task/run is unavailable.");
      const readiness = automaticDeliveryReadiness(facts);
      if (!readiness.ready) throw new Error(readiness.reason);
      if (!facts.candidate || facts.candidate.head !== input.expectedCandidate.head || facts.candidate.tree !== input.expectedCandidate.tree || facts.planRevision !== input.expectedPlanRevision || !facts.submittedPlan || !facts.agentPolicy) throw new Error("The reviewed plan or candidate changed. Reload the final review before requesting fixes.");
      if (facts.deliveryKind === "code") {
        if (!input.expectedReviewFingerprint || await deps.reviewFingerprint(input.serverId, input.workspaceId, paseo) !== input.expectedReviewFingerprint) throw new Error("The displayed code comparison changed. Refresh the review before requesting fixes.");
      } else {
        const bundleArgs = { ...args, planRevision: facts.planRevision };
        if (await readActionAuthorization(bundleArgs) || await readReportCompletion(bundleArgs)) throw new Error("This artifact is already authorized or completed. Investigate its result before requesting new work.");
      }
      const record = deliveryFeedbackSchema.parse({ ...identity, schemaVersion: 1, id: input.requestId, candidate: facts.candidate, planRevision: facts.planRevision, policyRevision: facts.agentPolicy.revision, scopeRevision: facts.submittedPlan.scopeRevision, ...(input.expectedReviewFingerprint ? { reviewFingerprint: input.expectedReviewFingerprint } : {}), note: input.note, requestedBy: input.actorId, requestedAt: new Date().toISOString() });
      const file = join(runFolder, "delivery-feedback.json"), temp = join(runFolder, `.delivery-feedback-${randomUUID()}.tmp`);
      await writeFile(temp, `${JSON.stringify({ schemaVersion: 1, requests: [...records, record] }, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
      await rename(temp, file);
      return record;
    });
    // Serialize with final commit/push/PR creation. A queued publication rechecks this record before mutation.
    if (input.expectedCandidate.tree.length === 40) return withRepository(await realpath(await deps.projectRoot(initial.task.projectId, paseo)), save);
    return save();
  }
  return { request };
}
