import { createHash, randomUUID } from "node:crypto";
import { lstat, mkdir, open, readFile, realpath, unlink } from "node:fs/promises";
import { join, resolve } from "node:path";
import { isDeepStrictEqual } from "node:util";
import type { PluginServerContext } from "@getpaseo/plugin/server";
import type { PaseoApi } from "@getpaseo/client";
import { z } from "zod";
import { taskSchema } from "../shared/tasks";
import { defaultVaultPath } from "../shared/vault";
import { inspectTaskStatusRecovery, recoverTaskStatus, statusRecoveryInput, statusRecoveryRef, type StatusRecoveryRef } from "../shared/task-status-recovery";
import { rename } from "./retrying-rename";

const hash = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
const samePath = (a: string, b: string) => process.platform === "win32" ? a.toLowerCase() === b.toLowerCase() : a === b;
const hostSchema = z.object({ schemaVersion: z.literal(1), hostId: z.string().min(1), serverId: z.string().min(1) });
const missing = (error: unknown) => (error as NodeJS.ErrnoException).code === "ENOENT";

/** Separate recovery parser. Never broadens the normal task reader. */
function candidate(bytes: Buffer, ref: StatusRecoveryRef, hostId: string) {
  const markdown = bytes.toString("utf8");
  if (!Buffer.from(markdown).equals(bytes)) throw new Error("Task must be valid UTF-8.");
  const front = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(markdown);
  if (!front) throw new Error("Task record has no frontmatter.");
  const fields: Record<string, unknown> = Object.create(null);
  for (const line of front[1].split(/\r?\n/)) {
    const match = /^([a-zA-Z][a-zA-Z0-9]*):[ \t]*(.+)$/.exec(line);
    if (!match || Object.hasOwn(fields, match[1])) throw new Error("Task metadata is malformed or duplicated.");
    fields[match[1]] = JSON.parse(match[2]);
  }
  if (typeof fields.status !== "string" || !fields.status.length || fields.status.length > 200) throw new Error("Only an invalid status string can be recovered.");
  // Parse every other field strictly. Comparing the full parsed shape also rejects
  // unknown nested keys that Zod's ordinary object schemas would otherwise strip.
  const normalized = { ...fields, status: "closed" };
  const task = taskSchema.strict().parse(normalized);
  if (!isDeepStrictEqual(task, normalized)) throw new Error("Unknown or noncanonical task metadata; status-only recovery refused.");
  if (task.taskId !== ref.taskId || task.hostId !== hostId || task.projectId !== ref.projectId || !task.assignments.some(a => a.serverId === ref.serverId && a.workspaceId === ref.workspaceId)) throw new Error("Task identity or assignment does not match recovery request.");
  const recoverable = !taskSchema.shape.status.safeParse(fields.status).success;
  return { markdown, front, task, recordedStatus: fields.status, recoverable };
}

/** Root is server-owned. Tests supply an isolated fixture; RPC input cannot choose it. */
export function createTaskStatusRecovery(rootPath = defaultVaultPath) {
  const root = resolve(rootPath);
  async function checked(path: string, directory: boolean) {
    const stat = await lstat(path);
    if (stat.isSymbolicLink() || (directory ? !stat.isDirectory() : !stat.isFile()) || !samePath(await realpath(path), path) || (!directory && stat.nlink !== 1)) throw new Error("Recovery requires real, unlinked task paths.");
    return stat;
  }
  async function locate(ref: StatusRecoveryRef) {
    await checked(root, true);
    await checked(join(root, "host.json"), false);
    const host = hostSchema.parse(JSON.parse(await readFile(join(root, "host.json"), "utf8")));
    if (host.serverId !== ref.serverId) throw new Error("Recovery request belongs to another host.");
    const tasks = join(root, "Tasks"); await checked(tasks, true);
    // A legacy record alongside the folder makes authority ambiguous, even if invalid.
    try { await lstat(join(tasks, `${ref.taskId}.md`)); throw new Error("Legacy or duplicate task record; recovery refused."); }
    catch (error) { if (!missing(error)) throw error; }
    const folder = join(tasks, ref.taskId); await checked(folder, true);
    const file = join(folder, "task.md");
    const stat = await checked(file, false);
    if (stat.size > 200_000) throw new Error("Task record exceeds recovery size limit.");
    return { folder, file, hostId: host.hostId };
  }
  async function load(ref: StatusRecoveryRef) {
    const location = await locate(ref);
    const bytes = await readFile(location.file);
    if (bytes.length > 200_000) throw new Error("Task record exceeds recovery size limit.");
    return { ...location, bytes, revision: hash(bytes), ...candidate(bytes, ref, location.hostId) };
  }
  async function inspect(raw: StatusRecoveryRef) {
    const ref = statusRecoveryRef.parse(raw), current = await load(ref);
    return { ...ref, revision: current.revision, title: current.task.title, recordedStatus: current.recordedStatus, recoverable: current.recoverable };
  }
  async function writeNew(file: string, bytes: string | Buffer) {
    const handle = await open(file, "wx");
    try { await handle.writeFile(bytes); await handle.sync(); } finally { await handle.close(); }
  }
  async function apply(raw: z.infer<typeof statusRecoveryInput>) {
    const input = statusRecoveryInput.parse(raw);
    const ref = statusRecoveryRef.parse({ serverId: input.serverId, workspaceId: input.workspaceId, projectId: input.projectId, taskId: input.taskId });
    const location = await locate(ref);
    const lockPath = join(location.folder, ".mission-control-write.lock");
    let lock;
    try { lock = await open(lockPath, "wx"); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "EEXIST") throw new Error("Task is being updated; recovery did not run. Never remove another writer's lock."); throw error; }
    // Compare path stats to path stats: Windows handle.stat().dev and lstat().dev differ.
    const token = randomUUID();
    let owned: { dev: bigint; ino: bigint } | undefined;
    const warnings: string[] = [];
    let result: { task: z.infer<typeof taskSchema>; previousRevision: string; revision: string; auditPath: string; applied: true; warnings: string[] } | undefined;
    async function assertOwner() {
      const stat = await lstat(lockPath, { bigint: true });
      if (!owned || !stat.isFile() || stat.isSymbolicLink() || stat.dev !== owned.dev || stat.ino !== owned.ino || await readFile(lockPath, "utf8") !== token) throw new Error("Recovery lock ownership changed; stop and inspect the public record.");
    }
    try {
      owned = await lstat(lockPath, { bigint: true });
      await lock.writeFile(token); await lock.sync();
      const before = await load(ref);
      if (before.revision !== input.expectedRevision) throw new Error("Task changed since inspection; recovery did not run.");
      if (!before.recoverable) throw new Error("Task status is valid; use the normal status workflow.");
      const at = new Date().toISOString();
      // Advance updatedAt so an older normal status editor cannot overwrite this correction.
      const header = before.front[0].replace(/^status:[^\r\n]*/m, `status: ${JSON.stringify(input.targetStatus)}`)
        .replace(/^updatedAt:[^\r\n]*/m, `updatedAt: ${JSON.stringify(at)}`);
      const afterBytes = Buffer.from(header + before.markdown.slice(before.front[0].length));
      const after = candidate(afterBytes, ref, before.hostId);
      const task = taskSchema.parse({ ...after.task, status: input.targetStatus });
      const revision = hash(afterBytes);
      const auditName = `.mission-control-recovery-${randomUUID()}`;
      const audit = join(before.folder, auditName);
      await mkdir(audit);
      await writeNew(join(audit, "before.md"), before.bytes);
      // A prepared journal is an intention, not proof of application after a crash.
      await writeNew(join(audit, "prepared.json"), JSON.stringify({ schemaVersion: 1, ...input, at,
        actorAttribution: "caller-declared", previousStatus: before.recordedStatus, revision, backup: "before.md" }, null, 2) + "\n");
      const temporary = join(before.folder, `.${input.taskId}.${token}.tmp`);
      try {
        await writeNew(temporary, afterBytes);
        await assertOwner();
        const latest = await load(ref);
        if (latest.file !== before.file || latest.revision !== before.revision) throw new Error("Task changed during recovery preparation; no replacement applied.");
        await rename(temporary, before.file);
      } finally { await unlink(temporary).catch(error => { if (!missing(error)) warnings.push("Recovery temporary-file cleanup failed; do not delete locks or retry blindly."); }); }
      const readback = await load(ref);
      if (readback.revision !== revision || readback.recoverable) throw new Error(`Recovery replacement was attempted but readback changed; inspect the record and ${auditName}. Do not retry automatically.`);
      const auditPath = `Tasks/${input.taskId}/${auditName}`;
      result = { task, previousRevision: before.revision, revision, auditPath, applied: true, warnings };
      try { await writeNew(join(audit, "applied.json"), JSON.stringify({ at: new Date().toISOString(), revision, applied: true }) + "\n"); }
      catch { warnings.push("Task correction read back successfully, but final audit receipt write failed. Retain the prepared journal and backup."); }
    } finally {
      // Existing or replaced locks are never taken over, aged out, or removed.
      try { await assertOwner(); await lock.close(); await unlink(lockPath); }
      catch { await lock.close().catch(() => {}); warnings.push("Recovery lock cleanup was not confirmed. Inspect current state; do not remove the lock or replay the mutation."); }
    }
    return result!;
  }
  return { inspect, apply };
}

export function registerTaskStatusRecovery(server: PluginServerContext) {
  const recovery = createTaskStatusRecovery();
  async function verifyWorkspace(input: StatusRecoveryRef, paseo: PaseoApi) {
    const workspace = await paseo.workspaces.ref(input.workspaceId).refresh();
    if (!workspace || workspace.projectId !== input.projectId) throw new Error("Workspace/project is unavailable or changed on this host.");
  }
  server.handle(inspectTaskStatusRecovery, async (input, { paseo }) => { await verifyWorkspace(input, paseo); return recovery.inspect(input); });
  server.handle(recoverTaskStatus, async (input, { paseo }) => { await verifyWorkspace(input, paseo); return recovery.apply(input); });
}
