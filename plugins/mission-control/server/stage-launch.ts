import { randomUUID } from "node:crypto";
import { mkdir, open, realpath, unlink, writeFile } from "node:fs/promises";
import { join, relative, isAbsolute } from "node:path";
import type { PaseoApi, PaseoAgentHandle } from "@getpaseo/client";
import type { PipelineInspection } from "../shared/pipeline";
import { launchPipelineStage } from "../shared/stage-launch";
import { missingReviewRole, nextPipelineStep, pipelineFingerprint } from "../shared/pipeline-model";
import { pipelinePrompt } from "./pipeline-engine";
import { type FleetStore } from "./fleet-store";
import { effectiveAgentPolicy, verifyProfileAvailability } from "./agent-policy";
import { assignedTask } from "./tasks";
import { taskAgentPrompt } from "./runs";
import { profileKitRoot } from "./decisions";
import { defaultVaultPath } from "../shared/vault";
import { requireLaunchParent } from "./launch-parent";
import { reviewCandidate } from "./merge";
import { runProcess } from "./process-tree";
import { executeOcr, resolveOcrScope } from "./ocr-execution";
import { createReviewMarkStore } from "./review-marks";
import { assignmentSchema } from "./stage-records.mjs";
import type { z } from "zod";

export async function launchManagedStage(input: z.infer<typeof launchPipelineStage.input>, facts: PipelineInspection, paseo: PaseoApi, store: FleetStore) {
  if (input.row.remoteServerId !== input.serverId || input.parent.agentId !== input.row.coordinatorId) throw new Error("Stage host or coordinator changed.");
  const next = nextPipelineStep(input.row, facts);
  if (!next.dispatch || !["plan", "execute", "fix", "validate", "review"].includes(next.stage) || pipelineFingerprint(facts, next) !== input.fingerprint) throw new Error("Stage changed before launch.");
  const source = await assignedTask(input.serverId, input.workspaceId, input.row.taskId);
  if (!source.folder) throw new Error("A task folder is required.");
  const policy = await effectiveAgentPolicy(store, paseo, source.task.projectId, source.task.taskId);
  if (!policy || policy.revision !== facts.agentPolicy?.revision) throw new Error("Choose native agent profiles on this host before launching a managed stage.");
  await verifyProfileAvailability(paseo, policy);
  await requireLaunchParent(input.parent, paseo);
  const workspace = await paseo.workspaces.ref(input.workspaceId).refresh();
  if (!workspace?.workspaceDirectory || workspace.archivingAt || workspace.projectId !== source.task.projectId) throw new Error("Stage workspace is unavailable.");
  const cwd = await realpath(workspace.workspaceDirectory);
  const candidate = await reviewCandidate(cwd);
  if (facts.candidate && JSON.stringify(candidate) !== JSON.stringify(facts.candidate)) throw new Error("Code changed before stage launch.");
  const role = next.stage === "plan" ? "planner" : next.stage === "validate" ? "validator" : next.stage === "review" ? missingReviewRole(facts, facts.checkpoints.find(item => item.stage === "validate" && item.verdict === "pass")?.createdAt) : "builder";
  if (!role) throw new Error("Independent reviews are complete. The coordinator must prepare the human decision.");
  const profile = policy.profiles.find(item => item.role === role)!;
  const root = await realpath(source.folder); const lockPath = join(root, ".stage-launch.lock");
  const lock = await open(lockPath, "wx");
  try {
    const agentId = randomUUID(); const id = randomUUID();
    const createAgent = () => paseo.workspaces.ref(input.workspaceId).agents.create({ agentId, idempotencyKey: input.requestId, parent: input.parent, title: `${source.task.title} · ${role}`, labels: { "mission-control.task-id": source.task.taskId, "mission-control.role": role },
      config: { provider: `${profile.provider}/${profile.model}`, ...(profile.modeId ? { modeId: profile.modeId } : {}), ...(profile.thinkingOptionId ? { thinkingOptionId: profile.thinkingOptionId } : {}), ...(profile.featureValues ? { featureValues: profile.featureValues } : {}) } });
    let agent: PaseoAgentHandle | undefined;
    let runId = facts.entry.run?.runId;
    const kitRoot = await profileKitRoot(defaultVaultPath, source.task.projectId);
    if (!kitRoot) throw new Error("Project kitRoot is required.");
    if (!runId) {
      if (next.stage !== "plan") throw new Error("Start with planning for this task.");
      // A new run must never point at a worker that failed to be created. Creation alone sends no task prompt.
      agent = await createAgent();
      const result = await runProcess(process.execPath, [join(kitRoot, "scripts", "dev-flow.mjs"), "start", "--task", source.task.taskId, "--server", input.serverId, "--workspace", input.workspaceId, "--cwd", cwd, "--agent", agentId], { cwd, timeoutMs: 20_000 });
      if (result.code) throw new Error(`Task run could not start: ${result.stderr.slice(-1500)}`);
      runId = JSON.parse(result.stdout).run.runId as string;
    }
    const folder = await realpath(join(root, "runs", runId)); const rel = relative(root, folder);
    if (!rel || isAbsolute(rel) || rel.startsWith("..")) throw new Error("Run folder escapes this task.");
    const directory = join(folder, "stage-assignments"); await mkdir(directory, { recursive: true });
    const actual = await realpath(directory); if (relative(folder, actual) !== "stage-assignments") throw new Error("Stage folder escapes its run.");
    let manifest: string | null = null;
    if (next.stage === "review") {
      const saved = await createReviewMarkStore(defaultVaultPath).read(input.workspaceId);
      const scope = await resolveOcrScope(cwd, candidate, source.task.worktree?.baseCommit ?? null, saved);
      const captured = await executeOcr(cwd, scope, candidate, id);
      if (JSON.stringify(await reviewCandidate(cwd)) !== JSON.stringify(candidate)) throw new Error("Code changed during OCR selection. No reviewer was started.");
      manifest = `ocr-${id}.json`;
      const content = JSON.stringify(captured, null, 2);
      if (Buffer.byteLength(content) > 5_000_000) throw new Error("OCR evidence exceeds the review report limit. Narrow the approved task's scope before continuing.");
      await writeFile(join(folder, manifest), content, { flag: "wx" });
    }
    const execution = { assignmentId: id, policyRevision: policy.revision, role: profile.role, profileId: profile.id, profileName: profile.name, provider: profile.provider, model: profile.model };
    const assignment = assignmentSchema.parse({ id, agentId, requestId: input.requestId, taskId: source.task.taskId, runId, serverId: input.serverId, workspaceId: input.workspaceId, stage: next.stage, execution, planRevision: facts.planRevision, candidate, createdAt: new Date().toISOString(), reviewCount: policy.reviewCount, manifest });
    await writeFile(join(actual, `${id}.json`), JSON.stringify(assignment, null, 2), { flag: "wx" });
    agent ??= await createAgent();
    const { prompt } = await taskAgentPrompt(input.workspaceId, source.task.taskId);
    const instructions = [prompt, pipelinePrompt(input.row, facts, next),
      `You ARE the assigned ${role}, agent ${agentId}, in existing run ${runId}. Do not create another worker or run. Use ${join(kitRoot, "skills")} for the stage skill.`,
      "Stay within the approved acceptance criteria and explicit non-goals. Reuse the repository's existing patterns and dependencies. Choose the smallest useful change. Do not add speculative abstractions, infrastructure or unrelated cleanup. Ask for a revised plan if the required scope changes.",
      "Stop after your assigned stage, including when a later human approval arrives. The runner launches the next role; approval does not turn this agent into the next role.",
      manifest ? `OCR has already run. Read ${join(folder, manifest)} for the exact file/status checklist, exclusions, rules and scope. Inspect every selected diff with those rules. Do not read another reviewer's report until your own review is saved. For your checkpoint include coverage:[{path,status,outcome:"reviewed"|"skipped",reason:""}] and findings:[{title,severity:"high"|"medium"|"low",detail,file}]. Account for EVERY selected file/status pair. A skipped reviewable file or unresolved finding prevents a passing review. Explicitly disclose excluded files and any acceptance-criteria gaps. Save your own report; the coordinator combines both reviewers and requests human approval. Do not request the human review decision yourself.` : "",
    ].filter(Boolean).join("\n\n");
    await agent.send(instructions, { messageId: input.requestId });
    return { agentId, runId };
  } finally { await lock.close(); await unlink(lockPath); }
}
