import { createHash, randomUUID } from "node:crypto";
import { lstat, mkdir, readFile, readdir, realpath, unlink, writeFile } from "node:fs/promises";
import { rename } from "./retrying-rename";
import { isAbsolute, join, relative } from "node:path";
import type { PaseoApi, PaseoAgent } from "@getpaseo/client";
import { z } from "zod";
import type { BranchType } from "../shared/branch-names";
import { launchRecordSchema, type BranchPreview, type LaunchRecord, type LaunchStatus, type TaskBinding } from "../shared/launch";
import { runSchema, type RunRecord } from "../shared/runs";
import { defaultVaultPath } from "../shared/vault";
import type { TaskRecord, TaskWorktree } from "../shared/tasks";
import { assignedTask, attachTaskWorktree, localServerId } from "./tasks";
import { projectProfileFile } from "./decisions";
import { branchPreview } from "./branch-names";
import { listRunRecords, taskAgentPrompt } from "./runs";
import { createTaskWorktree, type CreatedWorktree } from "./worktree";
import { ProcessStopped, runProcess } from "./process-tree";
import { hideCredentials } from "../shared/secret-mask";

// Paseo owns one RPC server per host. Share exclusion across module reloads and
// launcher instances; a process exit releases it without leaving a stale file.
const locksKey = Symbol.for("mission-control.task-launch-locks");
const runtime = globalThis as typeof globalThis & { [locksKey]?: Set<string> };
const launchLocks = runtime[locksKey] ??= new Set<string>();
// Why a launch that outlived its reply failed before it wrote a launch record, by lock key.
const failuresKey = Symbol.for("mission-control.task-launch-failures");
const failureRuntime = globalThis as typeof globalThis & { [failuresKey]?: Map<string, string> };
const launchFailures = failureRuntime[failuresKey] ??= new Map<string, string>();
// Counts finished launches, so a status read during a launch's last steps can tell its view is stale.
const endsKey = Symbol.for("mission-control.task-launch-ends");
const endsRuntime = globalThis as typeof globalThis & { [endsKey]?: { count: number } };
const launchEnds = endsRuntime[endsKey] ??= { count: 0 };
// Paseo's client gives up on a plugin RPC after 30 s; reply before then and let the status refresh show the rest.
const replyWithinMs = 20_000;
const profileSchema = z.object({ projectId: z.string(), kitRoot: z.string().min(1) });
const contextSchema = z.object({
  profile: z.object({ kitRoot: z.string(), repository: z.string() }),
  git: z.object({ head: z.string().nullable(), dirty: z.boolean(), changes: z.array(z.string()), omittedChanges: z.number() }),
});
// workspaceId is where the task runs: its own worktree when it has one, otherwise the requested workspace.
type Context = { folder: string; task: TaskRecord; cwd: string; kitRoot: string; run: RunRecord | null; git: z.infer<typeof contextSchema>["git"]; workspaceId: string; canIsolate: boolean };

function inside(root: string, candidate: string) {
  const path = relative(root, candidate);
  return path === "" || (path !== ".." && !path.startsWith("..\\") && !path.startsWith("../") && !isAbsolute(path));
}
async function safeFile(file: string) {
  const stat = await lstat(file);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("Launch records must be regular files.");
  return readFile(file, "utf8");
}
function frontmatter(markdown: string): Record<string, unknown> {
  const match = /^---\r?\n([\s\S]*?)\r?\n---/.exec(markdown);
  if (!match) throw new Error("Project profile has no frontmatter.");
  const fields: Record<string, unknown> = {};
  for (const line of match[1].split(/\r?\n/)) {
    const at = line.indexOf(":");
    if (at < 1 || Object.hasOwn(fields, line.slice(0, at))) throw new Error("Invalid project profile.");
    fields[line.slice(0, at)] = JSON.parse(line.slice(at + 1));
  }
  return fields;
}
async function loadContext(input: TaskBinding, paseo: PaseoApi): Promise<Context> {
  if (await localServerId() !== input.serverId) throw new Error("Choose a task on this Mission Control host.");
  const source = await assignedTask(input.serverId, input.workspaceId, input.taskId);
  if (!source.folder) throw new Error("This legacy task needs a task folder before it can be launched.");
  // A task with its own worktree always runs there, whichever of its workspaces it was opened from.
  const workspaceId = source.task.worktree?.workspaceId ?? input.workspaceId;
  const workspace = await paseo.workspaces.ref(workspaceId).refresh();
  if (!workspace || workspace.archivingAt || workspace.projectId !== source.task.projectId) {
    throw new Error(source.task.worktree ? "The task's worktree workspace is unavailable; it may have been archived." : "Task project does not match an available workspace.");
  }
  const cwd = await realpath(workspace.workspaceDirectory || workspace.projectRootPath);
  const root = await realpath(defaultVaultPath);
  const projects = await realpath(join(root, "Projects"));
  if (!inside(root, projects)) throw new Error("Project profiles must stay inside dev-vault.");
  const profiles = [];
  for (const name of await readdir(projects)) {
    if (!projectProfileFile.test(name)) continue;
    const fields = frontmatter(await safeFile(join(projects, name)));
    if (fields.projectId === source.task.projectId) profiles.push(profileSchema.parse(fields));
  }
  if (profiles.length !== 1) throw new Error("Add one project profile in dev-vault before starting this task.");
  if (!isAbsolute(profiles[0].kitRoot)) throw new Error("The project profile needs an absolute kitRoot.");
  const realKit = await realpath(profiles[0].kitRoot);
  const cli = await realpath(join(realKit, "scripts", "dev-flow.mjs"));
  if (!inside(realKit, cli)) throw new Error("The task bridge must stay inside kitRoot.");
  // Agents get kitRoot as the profile writes it: the stable kit link keeps working when an update replaces the install.
  const kitRoot = profiles[0].kitRoot;
  // dev-flow runs git itself; at the time limit the whole tree ends, git (and Git's cmd\git.exe launcher) included.
  const context = await runProcess(process.execPath, [cli, "context", "--task", input.taskId, "--server", input.serverId, "--workspace", workspaceId, "--cwd", cwd], {
    cwd, timeoutMs: 30_000, maxBuffer: 1_000_000, env: { ...process.env, DEV_VAULT_ROOT: root },
  }).catch(error => { throw error instanceof ProcessStopped ? new Error(`dev-flow context ${error.message.replace(/^\S+ /, "")}.`) : error; });
  if (context.code !== 0) throw new Error(`dev-flow context failed: ${hideCredentials(context.stderr.trim() || `exit code ${context.code}`)}`);
  const checked = contextSchema.parse(JSON.parse(context.stdout));
  const run = (await listRunRecords(input.serverId, input.workspaceId, input.taskId))[0] ?? null;
  const done = source.task.status === "delivered" || source.task.status === "closed";
  // Only a first start can create the worktree, and it needs a commit to branch from.
  const canIsolate = !source.task.worktree && !run && !done && checked.git.head !== null;
  return { folder: await realpath(source.folder), task: source.task, cwd, kitRoot, git: checked.git, run, workspaceId, canIsolate };
}
async function readLaunch(folder: string, input: TaskBinding) {
  let text;
  try { text = await safeFile(join(folder, ".mission-control-launch.json")); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return null; throw error; }
  const record = launchRecordSchema.parse(JSON.parse(text));
  if (record.taskId !== input.taskId || record.serverId !== input.serverId || record.workspaceId !== input.workspaceId) throw new Error("Launch identity does not match this task.");
  return record;
}
async function saveLaunch(folder: string, record: LaunchRecord) {
  const temp = join(folder, `.mission-control-launch-${randomUUID()}.tmp`);
  try {
    await writeFile(temp, JSON.stringify(record, null, 2), { flag: "wx" });
    // On Windows a status refresh reading the record briefly blocks replacing it; rename retries.
    await rename(temp, join(folder, ".mission-control-launch.json"));
  } finally { await unlink(temp).catch(() => {}); }
}
async function ensureRun(context: Context, record: LaunchRecord) {
  const runs = join(context.folder, "runs");
  await mkdir(runs, { recursive: true });
  if (!inside(context.folder, await realpath(runs))) throw new Error("Runs folder escapes the task.");
  // Publish only a complete run. Run readers ignore staging directories.
  const folder = join(runs, `.preparing-${record.runId}`);
  await mkdir(folder, { recursive: true });
  if (!inside(runs, await realpath(folder))) throw new Error("Run folder escapes the task.");
  await mkdir(join(folder, "events"), { recursive: true });
  const run = runSchema.parse({
    schemaVersion: 1, runId: record.runId, taskId: record.taskId, hostId: context.task.hostId,
    projectId: context.task.projectId, serverId: record.serverId, workspaceId: record.workspaceId, agentId: record.agentId,
    stage: "intake", outcome: "in_progress", createdAt: record.createdAt, updatedAt: record.createdAt,
    nextAction: "Confirm scope and write a plan.", gitHead: context.git.head, gitDirty: context.git.dirty,
    gitChanges: context.git.changes, omittedChanges: context.git.omittedChanges,
  });
  const text = `---\n${Object.entries(run).map(([key, value]) => `${key}: ${JSON.stringify(value)}`).join("\n")}\n---\n\n# Run ${run.runId}\n\nTask: [[../../task|${context.task.title}]]\n`;
  const temporary = join(folder, `.${randomUUID()}.tmp`);
  try {
    await writeFile(temporary, text, { flag: "wx" });
    await rename(temporary, join(folder, "run.md"));
    await rename(folder, join(runs, record.runId));
  } finally { await unlink(temporary).catch(() => {}); }
  return run;
}
async function refreshAgent(paseo: PaseoApi, agentId: string) {
  try { return (await paseo.agents.ref(agentId).refresh())?.agent ?? null; }
  catch (error) {
    // SDK 0.9.1 throws for an absent reserved agent. Other errors must surface.
    if (error instanceof Error && error.message === `Agent not found: ${agentId}`) return null;
    throw error;
  }
}
function agentUsable(agent: PaseoAgent | null, input: TaskBinding, cwd: string) {
  if (!agent || agent.archivedAt || agent.status === "closed") return false;
  if (agent.workspaceId !== input.workspaceId) throw new Error("The linked agent moved to another workspace.");
  if (relative(cwd, agent.cwd).replaceAll("\\", "/") !== "") throw new Error("The linked agent directory does not match the workspace.");
  return true;
}

type LauncherDeps = {
  loadContext: typeof loadContext;
  taskAgentPrompt: typeof taskAgentPrompt;
  // `branch` is a templated name; without it the worktree gets task/<id>-<slug>.
  createWorktree: (input: { task: TaskRecord; sourceCwd: string; branch?: string }, paseo: PaseoApi) => Promise<CreatedWorktree>;
  attachWorktree: (input: { serverId: string; taskId: string; worktree: TaskWorktree }) => Promise<unknown>;
  branchPreview: (task: TaskRecord, serverId: string, sourceCwd: string) => Promise<BranchPreview>;
  // How long dispatch waits for the launch before replying with its progress.
  replyWithinMs: number;
};

const lockKeyFor = (folder: string) => process.platform === "win32" ? folder.toLowerCase() : folder;

export function createTaskLauncher(overrides: Partial<LauncherDeps> = {}) {
  const deps: LauncherDeps = {
    loadContext, taskAgentPrompt, createWorktree: createTaskWorktree, attachWorktree: attachTaskWorktree,
    branchPreview: async task => branchPreview(task, undefined, new Map()), replyWithinMs, ...overrides,
  };
  async function inspect(input: TaskBinding, paseo: PaseoApi) {
    const loaded = await deps.loadContext(input, paseo);
    const context = { ...loaded, workspaceId: loaded.workspaceId || input.workspaceId, canIsolate: loaded.canIsolate ?? false };
    // Launch records, agents and prompts all use the workspace the task runs in.
    const bound: TaskBinding = { ...input, workspaceId: context.workspaceId };
    const launch = await readLaunch(context.folder, bound);
    if (launch && context.run && launch.runId !== context.run.runId) throw new Error("A different run was started outside the launcher. Open its agent and reconcile the task first.");
    const agentId = context.run?.agentId ?? launch?.agentId;
    const snapshot = agentId ? await refreshAgent(paseo, agentId) : null;
    const usable = agentUsable(snapshot, bound, context.cwd);
    let action: LaunchStatus["action"] = "start";
    let message = "Start an agent in this workspace with the task and project context.";
    if (["delivered", "closed"].includes(context.task.status)) {
      action = "blocked"; message = "This task is complete. Reopen it before starting more work.";
    } else if (launch?.phase === "sending") {
      action = "blocked"; message = "Prompt delivery is unconfirmed. Open the agent to check; this launch will not be sent again automatically.";
    } else if (launch?.phase === "preparing") {
      action = "recover"; message = launch.error || "A launch was interrupted before sending. Continue its preparation.";
    } else if (context.run || launch) {
      if (!usable) { action = "blocked"; message = "The linked agent is unavailable or archived. Its run is preserved; continue from the handoff in a workspace agent."; }
      else if (snapshot!.status !== "idle" || snapshot!.activeTurn || snapshot!.pendingPermissions.length) { action = "open"; message = "This agent is active or needs a response. Open it to continue."; }
      else if (launch && context.run?.updatedAt === launch.runUpdatedAt && !(snapshot!.lastUserMessageAt !== launch.lastUserMessageAt && ["finished", "error"].includes(snapshot!.attentionReason ?? ""))) {
        action = "open"; message = "Prompt accepted. Waiting for the agent to record progress.";
      } else { action = "resume"; message = "Resume the linked agent using the latest task context and handoff."; }
    }
    const canIsolate = context.canIsolate && action === "start";
    let branch: BranchPreview | null = null;
    if (canIsolate) {
      try { branch = await deps.branchPreview(context.task, input.serverId, context.cwd); }
      catch (error) { branch = { source: "template", note: null, options: [], problem: error instanceof Error ? error.message : String(error) }; }
    }
    // The branch preview is part of the revision, so a start never creates a name the user didn't see.
    const revision = createHash("sha256").update(JSON.stringify([context.task.updatedAt, context.run, launch, snapshot?.updatedAt, snapshot?.status, snapshot?.activeTurn, snapshot?.pendingPermissions, branch])).digest("hex");
    const worktree = context.task.worktree ? { workspaceId: context.task.worktree.workspaceId, branch: context.task.worktree.branch, baseCommit: context.task.worktree.baseCommit } : null;
    const status: LaunchStatus = {
      revision, action, message, launch, run: context.run,
      agent: usable && snapshot ? { id: snapshot.id, name: snapshot.title || "Task agent", status: snapshot.status, provider: snapshot.provider, updatedAt: snapshot.updatedAt } : null,
      worktree, canIsolate, branch,
    };
    return { context, snapshot, status, bound };
  }
  async function status(input: TaskBinding, paseo: PaseoApi): Promise<LaunchStatus> {
    for (let attempt = 1; ; attempt++) {
      const ended = launchEnds.count;
      const { context, status: current } = await inspect(input, paseo);
      const key = lockKeyFor(context.folder);
      if (launchLocks.has(key)) {
        // Until this attempt saves its own record, any error there belongs to an earlier attempt.
        const record = current.launch ? { ...current.launch, error: null } : null;
        return { ...current, action: "starting", message: "Starting the task. Creating its worktree and agent can take a minute; this updates on its own.", canIsolate: false, branch: null, launch: record };
      }
      // A launch finished while this was read, so it may show a step in between. Read it again.
      if (launchEnds.count !== ended && attempt < 3) continue;
      const failure = launchFailures.get(key);
      return failure && current.action === "start" ? { ...current, message: `The last start didn't finish: ${failure}` } : current;
    }
  }
  type DispatchInput = TaskBinding & { expectedRevision: string; provider?: string; isolate?: boolean; modeId?: string; thinkingOptionId?: string; branch?: string; branchType?: BranchType };
  /** Launches, replying with the final status or, when the launch outlasts replyWithinMs, the status so far. */
  async function dispatch(input: DispatchInput, paseo: PaseoApi) {
    const replyBy = Date.now() + deps.replyWithinMs;
    const before = await inspect(input, paseo);
    const lockKey = lockKeyFor(before.context.folder);
    if (launchLocks.has(lockKey)) throw new Error("A launch is already in progress. Refresh this task.");
    launchLocks.add(lockKey);
    launchFailures.delete(lockKey);
    let replied = false;
    const work = launch(input, paseo).finally(() => { launchLocks.delete(lockKey); launchEnds.count++; });
    // After the reply, a failure can only reach the user through the next status.
    work.catch(error => { if (replied) launchFailures.set(lockKey, error instanceof Error ? error.message : String(error)); });
    let timer: ReturnType<typeof setTimeout> | undefined;
    const late = new Promise<void>(done => { timer = setTimeout(() => { replied = true; done(); }, Math.max(0, replyBy - Date.now())); });
    try { await Promise.race([work, late]); }
    finally { clearTimeout(timer); }
    return await status(input, paseo);
  }
  async function launch(input: DispatchInput, paseo: PaseoApi) {
    let { context, snapshot, status: current, bound } = await inspect(input, paseo);
    if (current.revision !== input.expectedRevision) throw new Error("Task or agent changed. Refresh before starting it.");
    if (!["start", "resume", "recover"].includes(current.action)) throw new Error(current.message);
    if (input.isolate && current.action === "start") {
      if (!context.canIsolate) throw new Error("This task can't start in its own worktree. Start it in this workspace instead.");
      const preview = current.branch;
      if (!preview || preview.problem) throw new Error(preview?.problem ?? "The task's branch name is unknown. Refresh this task.");
      const option = preview.options.length === 1 ? preview.options[0] : preview.options.find(entry => entry.type === input.branchType);
      if (!option) throw new Error("Choose Feature or Bugfix for the task's branch.");
      if (option.problem) throw new Error(`The branch ${option.name} can't be used: ${option.problem}`);
      if (input.branch !== undefined && input.branch !== option.name) throw new Error("The task's branch name changed. Refresh before starting it.");
      // Create (or find again) the task's worktree, record it on the task, then start there.
      const created = await deps.createWorktree({ task: context.task, sourceCwd: context.cwd, ...(preview.source === "template" ? { branch: option.name } : {}) }, paseo);
      await deps.attachWorktree({
        serverId: input.serverId, taskId: input.taskId,
        worktree: { workspaceId: created.workspaceId, branch: created.branch, baseCommit: created.baseCommit, sourceWorkspaceId: context.workspaceId, createdAt: new Date().toISOString() },
      });
      ({ context, snapshot, status: current, bound } = await inspect(input, paseo));
      if (current.action !== "start") throw new Error(current.message);
    }
    const now = new Date().toISOString();
    let record: LaunchRecord;
    // A retry starts clean: the previous attempt's error would otherwise show while this one runs.
    if (current.action === "recover") record = { ...current.launch!, error: null, updatedAt: now };
    else {
      const creatingAgent = !context.run;
      if (creatingAgent && !input.provider?.includes("/")) throw new Error("Choose a provider and model.");
      record = { ...bound, launchId: randomUUID(), agentId: context.run?.agentId || randomUUID(), runId: context.run?.runId || `run_${randomUUID()}`, provider: input.provider || snapshot?.provider || "unknown", modeId: creatingAgent ? input.modeId ?? null : null, thinkingOptionId: creatingAgent ? input.thinkingOptionId ?? null : null, creatingAgent, phase: "preparing", createdAt: now, updatedAt: now, runUpdatedAt: context.run?.updatedAt ?? null, lastUserMessageAt: snapshot?.lastUserMessageAt ?? null, error: null };
    }
    record = launchRecordSchema.parse(record);
    await saveLaunch(context.folder, record);
    try {
      let run = context.run;
      if (!run) run = await ensureRun(context, record);
      if (run.runId !== record.runId || run.agentId !== record.agentId) throw new Error("Launch and run agent identities do not match.");
      if (record.creatingAgent) {
        const config = { provider: record.provider, ...(record.modeId ? { modeId: record.modeId } : {}), ...(record.thinkingOptionId ? { thinkingOptionId: record.thinkingOptionId } : {}) };
        await paseo.workspaces.ref(bound.workspaceId).agents.create({ agentId: record.agentId, idempotencyKey: record.launchId, config, title: context.task.title, labels: { "mission-control.task-id": input.taskId, "mission-control.role": "builder" } });
      }
      const agent = paseo.agents.ref(record.agentId);
      const refreshed = await refreshAgent(paseo, record.agentId);
      if (!agentUsable(refreshed, bound, context.cwd) || refreshed!.status !== "idle" || refreshed!.activeTurn || refreshed!.pendingPermissions.length) throw new Error("Agent is not idle and ready. Open it before resuming.");
      const { prompt } = await deps.taskAgentPrompt(bound.workspaceId, input.taskId);
      const message = [prompt,
        `Your Paseo agent ID is ${record.agentId}. Continue existing run ${record.runId}; do not call start to create another run.`,
        `Read ${join(context.kitRoot, "skills", "check-environment", "SKILL.md")}. The other Development Flow skills are in ${join(context.kitRoot, "skills")}.`,
        "Run context again and reconcile the latest handoff with the working tree. Record actual progress in this run. Start/resume authorizes work within the task's existing scope; it grants no new commit, push, merge, or deployment permission.",
      ].join("\n");
      record = { ...record, phase: "sending", runUpdatedAt: run.updatedAt, lastUserMessageAt: refreshed!.lastUserMessageAt, error: null, updatedAt: new Date().toISOString() };
      await saveLaunch(context.folder, record);
      await agent.send(message, { messageId: record.launchId });
      record = { ...record, phase: "sent", updatedAt: new Date().toISOString() };
      await saveLaunch(context.folder, record);
    } catch (error) {
      // 'sending' is deliberately not reset: a timeout may have accepted the prompt.
      record = { ...record, error: error instanceof Error ? error.message : String(error), updatedAt: new Date().toISOString() };
      await saveLaunch(context.folder, record);
      throw error;
    }
  }
  return { status, dispatch };
}
