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
import { readAutomaticPlan, verifyAutomaticPlanAcceptance } from "./plan-snapshots.mjs";
import { readActionBundle } from "./action-bundles.mjs";
import type { z } from "zod";

export async function launchManagedStage(input: z.infer<typeof launchPipelineStage.input>, facts: PipelineInspection, paseo: PaseoApi, store: FleetStore) {
  if (input.row.remoteServerId !== input.serverId || input.parent.agentId !== input.row.coordinatorId) throw new Error("Stage host or coordinator changed.");
  const next = nextPipelineStep(input.row, facts);
  if (!next.dispatch || !["plan", "plan-review", "execute", "fix", "validate", "review"].includes(next.stage) || pipelineFingerprint(facts, next) !== input.fingerprint) throw new Error("Stage changed before launch.");
  const source = await assignedTask(input.serverId, input.workspaceId, input.row.taskId);
  if (!source.folder) throw new Error("A task folder is required.");
  const policy = await effectiveAgentPolicy(store, paseo, source.task.projectId, source.task.taskId, input.row.workflowMode ?? "manual");
  if (!policy || policy.revision !== facts.agentPolicy?.revision) throw new Error("Choose native agent profiles on this host before launching a managed stage.");
  await verifyProfileAvailability(paseo, policy);
  await requireLaunchParent(input.parent, paseo);
  const workspace = await paseo.workspaces.ref(input.workspaceId).refresh();
  if (!workspace?.workspaceDirectory || workspace.archivingAt || workspace.projectId !== source.task.projectId) throw new Error("Stage workspace is unavailable.");
  const cwd = await realpath(workspace.workspaceDirectory);
  const workflowMode = input.row.workflowMode ?? "manual"; const deliveryKind = input.row.deliveryKind ?? "code";
  const identity = facts.entry.run ? { taskId: source.task.taskId, runId: facts.entry.run.runId, serverId: input.serverId, workspaceId: input.workspaceId } : null;
  let submittedPlan = null;
  if (workflowMode === "automatic" && next.stage !== "plan") {
    if (!identity) throw new Error("Automatic stage requires an existing run.");
    const planInput = { taskFolder: source.folder, runFolder: join(source.folder, "runs", identity.runId), task: source.task, identity, policyRevision: policy.revision };
    submittedPlan = next.stage === "plan-review" ? await readAutomaticPlan(planInput) : await verifyAutomaticPlanAcceptance(planInput);
    if (!submittedPlan?.currentMatch || !submittedPlan.scopeMatch || !submittedPlan.policyMatch || submittedPlan.revision !== facts.planRevision) throw new Error("The submitted plan changed before stage launch.");
  }
  const preparingBundle = ["plan", "plan-review", "execute", "fix"].includes(next.stage);
  const savedBundle = deliveryKind !== "code" && identity && facts.planRevision ? await readActionBundle({ taskFolder: source.folder, runFolder: join(source.folder, "runs", identity.runId), task: source.task, identity, ...(preparingBundle ? { allowStaleScope: true } : { planRevision: facts.planRevision }) }) : null;
  const bundle = savedBundle?.scopeMatch !== false && savedBundle?.planRevision === facts.planRevision ? savedBundle : null;
  if (deliveryKind !== "code" && !preparingBundle && !bundle) throw new Error("Validation and review require an action bundle for the current plan and scope.");
  const candidate = next.stage === "plan-review" ? { head: null, tree: facts.planRevision! } : deliveryKind === "code" ? await reviewCandidate(cwd) : bundle ? { head: null, tree: bundle.revision } : null;
  if (next.stage !== "plan-review" && facts.candidate && JSON.stringify(candidate) !== JSON.stringify(facts.candidate)) throw new Error("The candidate changed before stage launch.");
  const role = next.stage === "plan" ? "planner" : next.stage === "plan-review" ? "planReviewer" : next.stage === "validate" ? "validator" : next.stage === "review" ? missingReviewRole(facts, facts.checkpoints.find(item => item.stage === "validate" && item.verdict === "pass")?.createdAt) : "builder";
  if (!role) throw new Error("Independent reviews are complete. The coordinator must prepare the human decision.");
  const profile = policy.profiles.find(item => item.role === role);
  if (!profile) throw new Error(`Choose a native profile for ${role} before launching.`);
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
    if (next.stage === "review" && deliveryKind === "code") {
      if (!candidate) throw new Error("Code review requires a candidate.");
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
    const assignment = assignmentSchema.parse({ id, agentId, requestId: input.requestId, taskId: source.task.taskId, runId, serverId: input.serverId, workspaceId: input.workspaceId, stage: next.stage, execution, workflowMode, deliveryKind, planScopeRevision: submittedPlan?.scopeRevision ?? null, planRevision: facts.planRevision, candidate, createdAt: new Date().toISOString(), reviewCount: workflowMode === "automatic" ? 2 : policy.reviewCount, manifest });
    await writeFile(join(actual, `${id}.json`), JSON.stringify(assignment, null, 2), { flag: "wx" });
    agent ??= await createAgent();
    const { prompt } = await taskAgentPrompt(input.workspaceId, source.task.taskId);
    const stageInstructions = workflowMode === "automatic" ? [
      "This task explicitly uses the automatic workflow. This verified task policy supersedes generic profile notes requesting human plan or code-review approval; scope, Gortex and outward-action restrictions remain in effect. Submit a versioned plan and independent machine checkpoints; do not request or fabricate human plan/code approval. Existing human decisions still block work. Ask a genuine question when requirements or authority are missing. Publishing, push, draft PRs, tracker changes, deployments, production operations and executing prepared action bundles require final explicit user authorization.",
      next.stage === "plan" ? `Use check-environment and plan-task. Investigate requirements and repository evidence through Gortex. Save a readable plan.md with scope, behavior, steps, checks, risks, non-goals and deferred work. Submit it with dev-flow submit-plan --task ${source.task.taskId} --run ${runId} --server ${input.serverId} --workspace ${input.workspaceId} --agent ${agentId} --input <plan-brief.json>. The input contains planBrief with the same readable sections as the manual plan snapshot. Record material revisions in changesSincePrevious. The separate plan reviewer will accept it or request concrete repairs; stop after submission.` : "",
      next.stage === "plan-review" ? `You are the independent PLAN reviewer, not a code reviewer. Your role-specific instructions take precedence over any code-review wording in the selected profile. Do not invoke review-changes or OCR for this stage. Read the immutable submitted plan at ${submittedPlan ? join(folder, submittedPlan.path) : "the current plan snapshot"}, revision ${facts.planRevision}, and the task's acceptance criteria. Use Gortex to check material assumptions against the existing implementation and relevant requirements. Pass a sufficient plan; do not invent improvements, request stylistic rewrites, or expand the task. Request repair only for a concrete requirement, correctness, feasibility, validation, authority or scope defect. Use blocked only for a genuine question or missing authority. Do not edit the plan or implementation. Save your report and a dev-flow checkpoint for stage plan-review with verdict pass|repair|blocked, scope approved|needs_plan, and findings:[{title,severity,detail,file?}]. A pass requires no unresolved findings. The checkpoint binds this exact plan and scope; stop after saving it.` : "",
      deliveryKind !== "code" && ["execute", "fix"].includes(next.stage) ? `This is a ${deliveryKind} task. Prepare the exact action/report bundle without executing its external or production actions. Save it with dev-flow save-actions --task ${source.task.taskId} --run ${runId} --server ${input.serverId} --workspace ${input.workspaceId} --agent ${agentId} --input <bundle.json>. Include kind, summary, environment, prerequisites, ordered steps with instruction and effect, verification, rollback, and report when applicable. Use check-environment and execute-task (or fix-findings). A checkpoint records the saved artifact revision; no Git revision or fake code change is required.` : "",
      deliveryKind !== "code" && next.stage === "validate" ? `Validate the exact saved action/report bundle ${bundle?.revision}. Read the immutable bundle at ${join(folder, "actions", `bundle-${bundle?.revision}.json`)}. Check target/environment, prerequisites, commands or scripts, expected effects, verification and rollback against task requirements. Run only authorized safe local checks; do not execute the prepared actions. Report checks actually run and limitations. Save a validate checkpoint against this artifact; pass only when required checks are satisfied.` : "",
      deliveryKind !== "code" && next.stage === "review" ? `Independently review every step and claim in the exact saved action/report bundle ${bundle?.revision}. Read the immutable bundle at ${join(folder, "actions", `bundle-${bundle?.revision}.json`)}. Check requirements, target/environment, side effects, prerequisites, command correctness, verification and rollback with Gortex and relevant source evidence. OCR is for code changes and is not required for this artifact review. Do not read another reviewer's report or verdict until your own report/checkpoint is saved. Do not execute actions or change the bundle. Save a review checkpoint with findings:[{title,severity,detail,file?}]; pass requires no unresolved findings. The coordinator combines both independent reviews before final user authorization.` : "",
    ].filter(Boolean).join("\n\n") : "";
    const instructions = [prompt, pipelinePrompt(input.row, facts, next), stageInstructions,
      `You ARE the assigned ${role}, agent ${agentId}, in existing run ${runId}. Do not create another worker or run. Use ${join(kitRoot, "skills")} for the stage skill.`,
      "Stay within the approved acceptance criteria and explicit non-goals. Reuse the repository's existing patterns and dependencies. Choose the smallest useful change. Do not add speculative abstractions, infrastructure or unrelated cleanup. Ask for a revised plan if the required scope changes.",
      "Write every checkpoint summary, plan, report and question for the person using Mission Control. Lead with what changed or was checked, the practical result, actual checks and limitations, and the concrete next action or decision. Use ordinary language; explain necessary technical terms. Keep agent IDs, revision hashes, file paths and raw command output in a separate technical evidence section. Never invent a successful check, result or reassuring summary.",
      "Stop after your assigned stage, including when a later human approval arrives. The runner launches the next role; approval does not turn this agent into the next role.",
      manifest ? `OCR has already run. Read ${join(folder, manifest)} for the exact file/status checklist, exclusions, rules and scope. Inspect every selected diff with those rules. Do not read another reviewer's report until your own review is saved. For your checkpoint include coverage:[{path,status,outcome:"reviewed"|"skipped",reason:""}] and findings:[{title,severity:"high"|"medium"|"low",detail,file}]. Account for EVERY selected file/status pair. A skipped reviewable file or unresolved finding prevents a passing review. Explicitly disclose excluded files and any acceptance-criteria gaps. Save your own report; the coordinator combines both reviewers and prepares the final authorization checkpoint. Do not request the human review decision yourself.` : "",
    ].filter(Boolean).join("\n\n");
    await agent.send(instructions, { messageId: input.requestId });
    return { agentId, runId };
  } finally { await lock.close(); await unlink(lockPath); }
}
