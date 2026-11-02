import { createHash, randomUUID } from "node:crypto";
import { link, lstat, mkdir, open, readFile, readdir, realpath, unlink } from "node:fs/promises";
import { join, resolve } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { z } from "zod";
import type { PaseoApi } from "@getpaseo/client";
import type { PluginServerContext } from "@getpaseo/plugin/server";
import { taskSchema, type TaskRecord } from "../shared/tasks";
import { runSchema } from "../shared/runs";
import { decisionSchema } from "../shared/decisions";
import { defaultVaultPath } from "../shared/vault";
import { inspectMissingTask, restoreMissingTask, missingTaskInput, missingTaskApplyInput, type MissingTaskInput } from "../shared/missing-task-recovery";

const digest = (bytes: string | Buffer) => createHash("sha256").update(bytes).digest("hex");
const missing = (error: unknown) => (error as NodeJS.ErrnoException).code === "ENOENT";
const samePath = (a: string, b: string) => process.platform === "win32" ? a.toLowerCase() === b.toLowerCase() : a === b;
const runName = /^run_[a-f0-9-]+$/;
const hostSchema = z.object({ schemaVersion: z.literal(1), hostId: z.string().min(1), serverId: z.string().min(1) });
type Verify = (task: TaskRecord, ref: MissingTaskInput) => Promise<unknown>;

// Recovery is deliberately stricter than the normal parser; it never normalizes a backup.
function fields(bytes: Buffer) {
  const text = bytes.toString("utf8");
  if (!Buffer.from(text).equals(bytes)) throw new Error("Evidence must be valid UTF-8.");
  const front = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(text);
  if (!front) throw new Error("Evidence has no frontmatter.");
  const result: Record<string, unknown> = Object.create(null);
  for (const line of front[1].split(/\r?\n/)) {
    const match = /^([a-zA-Z][a-zA-Z0-9]*):[ \t]*(.+)$/.exec(line);
    if (!match || Object.hasOwn(result, match[1])) throw new Error("Malformed or duplicate metadata.");
    result[match[1]] = JSON.parse(match[2]);
  }
  return result;
}
async function absent(path: string) {
  try { await lstat(path); } catch (error) { if (missing(error)) return; throw error; }
  throw new Error("Target or legacy task record already exists; never overwrite or replay recovery.");
}
async function checked(path: string, directory: boolean) {
  const stat = await lstat(path, { bigint: true });
  if (stat.isSymbolicLink() || (directory ? !stat.isDirectory() : !stat.isFile()) || !samePath(await realpath(path), path) || (!directory && stat.nlink !== 1n)) throw new Error("Recovery requires real, unlinked paths.");
  return { dev: String(stat.dev), ino: String(stat.ino) };
}
async function writeNew(path: string, bytes: Buffer | string) {
  const file = await open(path, "wx");
  try { await file.writeFile(bytes); await file.sync(); } finally { await file.close(); }
}

// Same lock names as normal task/run writers. Never steal, expire or remove another owner's lock.
async function ownLock(path: string) {
  const file = await open(path, "wx").catch(error => {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") throw new Error("Task/run writer is active; recovery did not run. Do not remove its lock.");
    throw error;
  });
  const token = randomUUID();
  let identity: { dev: string; ino: string };
  try { identity = await checked(path, false); await file.writeFile(token); await file.sync(); }
  catch (error) { await file.close(); throw error; } // retain uncertain lock; no unsafe cleanup
  async function assertOwner() {
    if (!isDeepStrictEqual(await checked(path, false), identity) || await readFile(path, "utf8") !== token) throw new Error("Recovery lock ownership changed; no further publication is allowed.");
  }
  return { assertOwner, async release(warnings: string[]) {
    try { await assertOwner(); await file.close(); await unlink(path); }
    catch { await file.close().catch(() => {}); warnings.push("Lock cleanup unconfirmed; inspect state, do not remove locks or retry automatically."); }
  } };
}

/** Server-owned root and native verifier; RPC callers cannot choose filesystem locations. */
export function createMissingTaskRecovery(rootPath: string, verify: Verify) {
  const root = resolve(rootPath);
  async function load(input: MissingTaskInput) {
    const backup = Buffer.from(input.backupContent), provenance = Buffer.from(input.provenanceContent);
    if (backup.length > 200_000 || provenance.length > 200_000) throw new Error("Recovery evidence exceeds size limit.");
    if (digest(backup) !== input.expectedBackupRevision || digest(provenance) !== input.expectedProvenanceRevision) throw new Error("Backup or provenance hash mismatch.");
    const manifest = JSON.parse(input.provenanceContent);
    if (!manifest || typeof manifest !== "object" || Array.isArray(manifest)) throw new Error("Provenance must be a JSON object; authority remains caller-attested.");
    const parsed = fields(backup), task = taskSchema.strict().parse(parsed);
    if (!isDeepStrictEqual({ ...parsed }, task)) throw new Error("Unknown or noncanonical task metadata; restore refused.");
    const evidence: unknown[] = [input.expectedBackupRevision, input.expectedProvenanceRevision];
    const directory = async (path: string) => { evidence.push([path, await checked(path, true)]); };
    const read = async (path: string) => {
      const identity = await checked(path, false);
      const stat = await lstat(path);
      if (stat.size > 200_000) throw new Error("Surviving record exceeds recovery size limit.");
      const bytes = await readFile(path);
      if (bytes.length > 200_000 || !isDeepStrictEqual(identity, await checked(path, false))) throw new Error("Surviving record changed while reading.");
      evidence.push([path, identity, digest(bytes)]); return bytes;
    };
    await directory(root);
    const host = hostSchema.parse(JSON.parse((await read(join(root, "host.json"))).toString("utf8")));
    if (host.serverId !== input.serverId || task.hostId !== host.hostId || task.taskId !== input.taskId || task.projectId !== input.projectId) throw new Error("Host/task/project identity mismatch.");
    const assignments = new Set(task.assignments.map(a => `${a.serverId}/${a.workspaceId}`));
    if (assignments.size !== task.assignments.length || task.assignments.some(a => a.serverId !== input.serverId) || !assignments.has(`${input.serverId}/${input.workspaceId}`)) throw new Error("Ambiguous or mismatched assignments.");
    if (task.worktree && (task.worktree.workspaceId !== input.workspaceId || !assignments.has(`${input.serverId}/${task.worktree.sourceWorkspaceId}`))) throw new Error("Worktree/source assignments do not match.");
    const tasks = join(root, "Tasks"), folder = join(tasks, input.taskId), file = join(folder, "task.md");
    await directory(tasks); await absent(join(tasks, `${input.taskId}.md`)); await directory(folder); await absent(file);
    const projects = join(root, "Projects"); await directory(projects);
    const profiles: string[] = [];
    for (const name of (await readdir(projects)).filter(n => /^[a-z0-9][a-z0-9_-]*\.md$/.test(n)).sort()) {
      const profile = fields(await read(join(projects, name)));
      if (profile.projectId === input.projectId) {
        if (profile.schemaVersion !== 1 || profile.hostId !== host.hostId || typeof profile.repository !== "string" || !profile.repository) throw new Error("Project profile identity is invalid.");
        profiles.push(name);
      }
    }
    if (profiles.length !== 1) throw new Error("Exactly one matching project profile is required.");
    const runs = join(folder, "runs"); await directory(runs);
    const runIds = (await readdir(runs)).sort();
    if (!runIds.includes(input.runId) || runIds.length > 1000 || runIds.some(n => !runName.test(n))) throw new Error("Missing selected run or ambiguous run history.");
    for (const runId of runIds) {
      const runFolder = join(runs, runId); await directory(runFolder);
      const run = runSchema.parse(fields(await read(join(runFolder, "run.md"))));
      if (run.runId !== runId || run.taskId !== task.taskId || run.hostId !== task.hostId || run.projectId !== task.projectId || !assignments.has(`${run.serverId}/${run.workspaceId}`) || (runId === input.runId && run.workspaceId !== input.workspaceId)) throw new Error("Surviving run identity does not match backup.");
      const decisions = join(runFolder, "decisions");
      try { await lstat(decisions); } catch (error) { if (missing(error)) continue; throw error; }
      await directory(decisions);
      const names = (await readdir(decisions)).sort();
      if (names.length > 1000 || names.some(n => !/^decision_[a-f0-9-]+\.md$/.test(n))) throw new Error("Ambiguous decision history.");
      for (const name of names) {
        const decision = decisionSchema.parse(fields(await read(join(decisions, name))));
        if (`${decision.decisionId}.md` !== name || decision.taskId !== task.taskId || decision.runId !== runId || !assignments.has(`${decision.serverId}/${decision.workspaceId}`)) throw new Error("Surviving decision identity does not match backup.");
        if (decision.resume && decision.resume.phase !== "sent") throw new Error("Pending or uncertain decision delivery must be reconciled before restoration.");
      }
    }
    evidence.push(await verify(task, input));
    return { task, backup, folder, file, runIds, inspectionRevision: digest(JSON.stringify(evidence)) };
  }
  async function inspect(raw: MissingTaskInput) {
    const input = missingTaskInput.parse(raw), state = await load(input);
    return { task: state.task, inspectionRevision: state.inspectionRevision, backupRevision: input.expectedBackupRevision,
      provenanceRevision: input.expectedProvenanceRevision, targetAbsent: true as const, runIds: state.runIds };
  }
  async function apply(raw: z.infer<typeof missingTaskApplyInput>) {
    const input = missingTaskApplyInput.parse(raw), ref = missingTaskInput.parse(Object.fromEntries(Object.keys(missingTaskInput.shape).map(k => [k, input[k as keyof typeof input]])));
    const first = await load(ref), warnings: string[] = [], locks: Awaited<ReturnType<typeof ownLock>>[] = [];
    const assertOwners = async () => { for (const lock of locks) await lock.assertOwner(); };
    let attempted = false;
    try {
      locks.push(await ownLock(join(first.folder, ".mission-control-write.lock")));
      for (const runId of first.runIds) locks.push(await ownLock(join(first.folder, "runs", runId, ".write.lock")));
      const state = await load(ref);
      if (state.inspectionRevision !== input.expectedInspectionRevision || first.inspectionRevision !== state.inspectionRevision) throw new Error("Inspection is stale; nothing restored.");
      const auditName = `.mission-control-restore-${randomUUID()}`, audit = join(state.folder, auditName);
      await mkdir(audit);
      await writeNew(join(audit, "original-task.md"), state.backup);
      await writeNew(join(audit, "provenance.json"), input.provenanceContent);
      await writeNew(join(audit, "prepared.json"), JSON.stringify({ schemaVersion: 1, at: new Date().toISOString(),
        taskId: input.taskId, runId: input.runId, serverId: input.serverId, workspaceId: input.workspaceId, projectId: input.projectId,
        expectedBackupRevision: input.expectedBackupRevision, expectedProvenanceRevision: input.expectedProvenanceRevision,
        expectedInspectionRevision: input.expectedInspectionRevision, actor: input.actor, actorAttribution: "caller-declared",
        reason: input.reason, authorizationEvidence: input.authorizationEvidence, targetWasAbsent: true, applied: false }, null, 2) + "\n");
      const staged = join(audit, "candidate.tmp"); await writeNew(staged, state.backup);
      await assertOwners();
      const latest = await load(ref);
      if (latest.inspectionRevision !== state.inspectionRevision) throw new Error("Evidence changed during preparation; nothing restored.");
      await assertOwners();
      // Atomic no-replace publication: unlike rename, link refuses every existing destination.
      attempted = true;
      await link(staged, state.file);
      try { await unlink(staged); } catch { warnings.push("Restored record retains its staging hard link; preserve evidence and do not repeat apply."); }
      const restored = await readFile(state.file);
      if (!restored.equals(state.backup)) throw new Error("Restored bytes differ on readback.");
      const result = { applied: true as const, task: state.task, revision: digest(restored), inspectionRevision: state.inspectionRevision,
        auditPath: `Tasks/${input.taskId}/${auditName}`, warnings };
      try { await writeNew(join(audit, "applied.json"), JSON.stringify({ applied: true, revision: result.revision, at: new Date().toISOString() }) + "\n"); }
      catch { warnings.push("Restore read back successfully but final audit receipt failed; retain prepared journal and original backup."); }
      return result;
    } catch (error) {
      if (attempted) throw new Error(`Publication was attempted; inspect target and prepared audit before any retry. ${error instanceof Error ? error.message : String(error)}`);
      throw error;
    } finally { for (const lock of locks.reverse()) await lock.release(warnings); }
  }
  return { inspect, apply };
}

export function registerMissingTaskRecovery(server: PluginServerContext) {
  async function store(paseo: PaseoApi) {
    return createMissingTaskRecovery(defaultVaultPath, async task => {
      const identities = [];
      for (const assignment of task.assignments) {
        const workspace = await paseo.workspaces.ref(assignment.workspaceId).refresh();
        if (!workspace || workspace.id !== assignment.workspaceId || workspace.projectId !== task.projectId || workspace.archivingAt || !workspace.workspaceDirectory) throw new Error("Native workspace/project identity is unavailable or changed.");
        identities.push({ serverId: assignment.serverId, workspaceId: workspace.id, projectId: workspace.projectId, directory: workspace.workspaceDirectory });
      }
      return identities;
    });
  }
  server.handle(inspectMissingTask, async (input, { paseo }) => (await store(paseo)).inspect(input));
  server.handle(restoreMissingTask, async (input, { paseo }) => (await store(paseo)).apply(input));
}
