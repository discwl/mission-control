import { createHash, randomUUID } from "node:crypto";
import { lstat, mkdir, open, readFile, readdir, realpath, unlink, writeFile } from "node:fs/promises";
import { rename } from "./retrying-rename";
import { isAbsolute, join, relative } from "node:path";
import { z } from "zod";
import {
  pullRequestRecordSchema,
  taskDocumentNameSchema,
  taskSchema,
  ticketSchema,
  type PullRequestRecord,
  type TaskFileProblem,
  type TaskRecord,
  type TaskWorktree,
  type Ticket,
} from "../shared/tasks";

import { defaultVaultPath } from "../shared/vault";
import { summarizeTasks } from "../shared/task-summary";

const vaultRoot = defaultVaultPath;
const maxDocumentBytes = 200_000;
const taskIdPattern = /^task_[a-f0-9-]+$/;
const runIdPattern = /^run_[a-f0-9-]+$/;
const eventFilePattern = /^event_[a-f0-9-]+\.md$/;

function inside(root: string, candidate: string): boolean {
  const remainder = relative(root, candidate);
  return remainder === "" || (remainder !== ".." && !remainder.startsWith("..\\") && !remainder.startsWith("../") && !isAbsolute(remainder));
}
async function withTaskWriteLock<T>(folder: string, action: () => Promise<T>): Promise<T> {
  const lockPath = join(folder, ".mission-control-write.lock");
  let lock;
  try { lock = await open(lockPath, "wx"); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") throw new Error("This task is being updated. Reload and retry.");
    throw error;
  }
  try { return await action(); }
  finally { await lock.close(); await unlink(lockPath); }
}

const hostProfileSchema = z.object({
  schemaVersion: z.literal(1),
  hostId: z.string().min(1),
  serverId: z.string().min(1),
});

type TaskLocation = { directory: string; hostId: string };
export type TaskSource = { task: TaskRecord; folder: string | null; file: string };

async function taskLocation(serverId: string): Promise<TaskLocation> {
  const root = await realpath(vaultRoot);
  const profile = hostProfileSchema.parse(JSON.parse(await readFile(join(root, "host.json"), "utf8")));
  if (profile.serverId !== serverId) {
    throw new Error("This workspace belongs to another host. Install its own vault adapter there.");
  }
  const directory = await realpath(join(root, "Tasks"));
  const inside = relative(root, directory);
  if (inside === ".." || inside.startsWith(`..\\`) || inside.startsWith("../") || isAbsolute(inside)) {
    throw new Error("Tasks must stay inside the Host Brain vault.");
  }
  return { directory, hostId: profile.hostId };
}

export async function localServerId(): Promise<string> {
  const root = await realpath(vaultRoot);
  const profile = hostProfileSchema.parse(JSON.parse(await readFile(join(root, "host.json"), "utf8")));
  return profile.serverId;
}

function parseTask(markdown: string): TaskRecord {
  const frontmatter = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(markdown);
  if (!frontmatter) throw new Error("Task record has no frontmatter.");
  const fields: Record<string, unknown> = {};
  for (const line of frontmatter[1].split(/\r?\n/)) {
    const separator = line.indexOf(":");
    if (separator < 1) throw new Error("Task record has invalid frontmatter.");
    fields[line.slice(0, separator)] = JSON.parse(line.slice(separator + 1).trim());
  }
  return taskSchema.parse(fields);
}

/** Why a task file was skipped, readable on one line: each schema problem as "field: message". */
function problemOf(error: unknown): string {
  if (error instanceof z.ZodError) return error.issues.map(issue => `${issue.path.length ? `${issue.path.join(".")}: ` : ""}${issue.message}`).join("; ");
  return error instanceof Error ? error.message : String(error);
}

/**
 * A skipped task file that carries a tracker ticket. `ticket` is null when the file clearly has one
 * but it can't be read, so a caller that must not duplicate it (the Morning import) can refuse.
 */
export type SkippedTicket = { taskId: string; file: string; title: string | null; ticket: Pick<Ticket, "system" | "key"> | null };

const ticketIdentitySchema = ticketSchema.pick({ system: true, key: true });
const systemsByLabel: Record<string, Ticket["system"]> = { "Jira": "jira", "Azure DevOps": "azure-devops" };

/**
 * The ticket an invalid task file still carries, read leniently: each frontmatter line on its own, then
 * the "Imported from Jira ABC-1: <url>" line every Morning import writes into the criteria.
 * Returns null when the file shows no sign of a ticket.
 */
function lenientTicket(taskId: string, file: string, markdown: string): SkippedTicket | null {
  const fields = new Map<string, unknown>();
  for (const line of (/^---\r?\n([\s\S]*?)\r?\n---/.exec(markdown)?.[1] ?? "").split(/\r?\n/)) {
    const at = line.indexOf(":");
    if (at < 1) continue;
    try { fields.set(line.slice(0, at), JSON.parse(line.slice(at + 1).trim())); }
    catch { fields.set(line.slice(0, at), undefined); }
  }
  const imported = /Imported from (Jira|Azure DevOps) ([^\s:][^\r\n:]*): /.exec(markdown);
  if (!fields.has("ticket") && !imported) return null;
  const title = typeof fields.get("title") === "string" && fields.get("title") ? fields.get("title") as string : null;
  const read = ticketIdentitySchema.safeParse(fields.get("ticket"));
  const ticket = read.success ? { system: read.data.system, key: read.data.key }
    : imported ? { system: systemsByLabel[imported[1]], key: imported[2].trim() } : null;
  return { taskId, file, title, ticket };
}

/**
 * Every task on this host, and the task files that were skipped because they are invalid. One bad
 * file must not hide the others, so each is read on its own and reported with its vault path.
 */
export async function scanTaskSources(serverId: string): Promise<{ sources: TaskSource[]; problems: TaskFileProblem[]; skipped: SkippedTicket[] }> {
  const { directory } = await taskLocation(serverId);
  const names = await readdir(directory);
  const sources: TaskSource[] = [];
  const problems: TaskFileProblem[] = [];
  const skipped: SkippedTicket[] = [];
  for (const name of names) {
    const folderName = taskIdPattern.test(name);
    const legacyName = /^task_[a-f0-9-]+\.md$/.test(name);
    if (!folderName && !legacyName) continue;
    const entry = join(directory, name);
    const folder = folderName ? entry : null;
    const file = folder ? join(folder, "task.md") : entry;
    const taskId = folderName ? name : name.slice(0, -3);
    let markdown: string | null = null;
    try {
      const kind = await lstat(entry);
      if (folderName && !kind.isDirectory()) throw new Error("The task path is not a folder.");
      if (legacyName && !kind.isFile()) throw new Error("The task path is not a regular file.");
      const fileKind = await lstat(file);
      if (!fileKind.isFile()) throw new Error("The task record is not a regular file.");
      markdown = await readFile(file, "utf8");
      const task = parseTask(markdown);
      if (task.taskId !== taskId) throw new Error(`Its taskId ${task.taskId} doesn't match its path.`);
      sources.push({ task, folder, file });
    } catch (error) {
      const path = ["Tasks", ...(folder ? [name, "task.md"] : [name])].join("/");
      problems.push({ taskId, file: path, problem: problemOf(error) });
      const ticket = markdown === null ? null : lenientTicket(taskId, path, markdown);
      if (ticket) skipped.push(ticket);
    }
  }
  // A folder is canonical if a legacy flat record also exists during migration.
  const unique = [...new Map(sources.sort((a, b) => Number(Boolean(a.folder)) - Number(Boolean(b.folder))).map(source => [source.task.taskId, source])).values()];
  return { sources: unique, problems: problems.sort((a, b) => a.file.localeCompare(b.file)), skipped };
}

/** Every valid task on this host; invalid task files are skipped (scanTaskSources names them). */
export async function taskSources(serverId: string): Promise<TaskSource[]> {
  return (await scanTaskSources(serverId)).sources;
}

export async function assignedTask(serverId: string, workspaceId: string, taskId: string): Promise<TaskSource> {
  if (!taskIdPattern.test(taskId)) throw new Error("Invalid task ID.");
  const { sources, problems } = await scanTaskSources(serverId);
  const source = sources.find(item => item.task.taskId === taskId);
  const problem = problems.find(item => item.taskId === taskId);
  if (!source && problem) throw new Error(`The task file ${problem.file} is invalid: ${problem.problem}`);
  if (!source || !source.task.assignments.some(a => a.serverId === serverId && a.workspaceId === workspaceId)) {
    throw new Error("Task is not assigned to this workspace.");
  }
  return source;
}

export async function readTaskSummary(serverId: string) {
  const { sources, problems } = await scanTaskSources(serverId);
  return summarizeTasks(sources.map(source => source.task), serverId, problems);
}

export async function listTaskRecords(serverId: string, workspaceId: string): Promise<{ tasks: TaskRecord[]; problems: TaskFileProblem[] }> {
  const { sources, problems } = await scanTaskSources(serverId);
  const tasks = sources
    .map(source => source.task)
    .filter(task => task.assignments.some(a => a.serverId === serverId && a.workspaceId === workspaceId))
    .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
  return { tasks, problems };
}

export async function createTaskRecord(
  input: { serverId: string; workspaceId: string; title: string; acceptanceCriteria: string; ticket?: Ticket },
  projectId: string,
): Promise<TaskRecord> {
  const { directory, hostId } = await taskLocation(input.serverId);
  const now = new Date().toISOString();
  const task = taskSchema.parse({
    schemaVersion: 1,
    taskId: `task_${randomUUID()}`,
    hostId,
    projectId,
    title: input.title.trim(),
    acceptanceCriteria: input.acceptanceCriteria.trim(),
    status: "inbox",
    source: "manual",
    assignments: [{ serverId: input.serverId, workspaceId: input.workspaceId }],
    createdAt: now,
    updatedAt: now,
    ...(input.ticket ? { ticket: input.ticket } : {}),
  });
  const folder = join(directory, task.taskId);
  await mkdir(folder);
  await writeFile(join(folder, "status.md"), `# Status log\n\nCreated ${now}. Initial state: inbox. See task.md for the current state.\n`, { flag: "wx" });
  await writeFile(join(folder, "notes.md"), "# Notes\n\n", { flag: "wx" });
  await mkdir(join(folder, "attachments"));
  const frontmatter = Object.entries(task).map(([key, value]) => `${key}: ${JSON.stringify(value)}`).join("\n");
  await writeFile(join(folder, "task.md"), `---\n${frontmatter}\n---\n\n# ${task.title}\n\n## Acceptance criteria\n\n${task.acceptanceCriteria}\n`, { flag: "wx" });
  return task;
}

export async function updateTaskStatusRecord(input: {
  serverId: string;
  workspaceId: string;
  taskId: string;
  status: TaskRecord["status"];
  expectedUpdatedAt: string;
}): Promise<TaskRecord> {
  const source = await assignedTask(input.serverId, input.workspaceId, input.taskId);
  const lockFolder = source.folder ?? (await taskLocation(input.serverId)).directory;
  return withTaskWriteLock(lockFolder, async () => {
    const markdown = await readFile(source.file, "utf8");
    const current = parseTask(markdown);
    if (current.updatedAt !== input.expectedUpdatedAt) {
      throw new Error("Task changed since it was loaded. Refresh tasks before changing its status.");
    }
    if (current.status === input.status) return current;
    const frontmatter = /^---(\r?\n)([\s\S]*?)(\r?\n)---(?=\r?\n|$)/.exec(markdown);
    if (!frontmatter) throw new Error("Task record has no frontmatter.");
    const newline = frontmatter[1];
    let statusLines = 0;
    let updatedLines = 0;
    const lines = frontmatter[2].split(/\r?\n/).map(line => {
      if (line.startsWith("status:")) { statusLines++; return `status: ${JSON.stringify(input.status)}`; }
      if (line.startsWith("updatedAt:")) { updatedLines++; return `updatedAt: ${JSON.stringify(new Date().toISOString())}`; }
      return line;
    });
    if (statusLines !== 1 || updatedLines !== 1) throw new Error("Task status fields are missing or duplicated.");
    const nextMarkdown = `---${newline}${lines.join(newline)}${frontmatter[3]}---${markdown.slice(frontmatter[0].length)}`;
    const next = parseTask(nextMarkdown);
    const temporary = join(lockFolder, `.${input.taskId}.${randomUUID()}.tmp`);
    try {
      await writeFile(temporary, nextMarkdown, { flag: "wx" });
      await rename(temporary, source.file);
    } catch (error) {
      await unlink(temporary).catch(() => {});
      throw error;
    }
    return next;
  });
}

/** Sets or clears a task's due date. Like a status change, it refuses a task that changed since it was loaded. */
export async function updateTaskDueDateRecord(input: {
  serverId: string;
  workspaceId: string;
  taskId: string;
  dueDate: string | null;
  expectedUpdatedAt: string;
}): Promise<TaskRecord> {
  const source = await assignedTask(input.serverId, input.workspaceId, input.taskId);
  const lockFolder = source.folder ?? (await taskLocation(input.serverId)).directory;
  return withTaskWriteLock(lockFolder, async () => {
    const markdown = await readFile(source.file, "utf8");
    const current = parseTask(markdown);
    if (current.updatedAt !== input.expectedUpdatedAt) {
      throw new Error("Task changed since it was loaded. Refresh tasks before changing its due date.");
    }
    if ((current.dueDate ?? null) === input.dueDate) return current;
    const frontmatter = /^---(\r?\n)([\s\S]*?)(\r?\n)---(?=\r?\n|$)/.exec(markdown);
    if (!frontmatter) throw new Error("Task record has no frontmatter.");
    const newline = frontmatter[1];
    let updatedLines = 0;
    const lines = frontmatter[2].split(/\r?\n/).filter(line => !line.startsWith("dueDate:")).map(line => {
      if (line.startsWith("updatedAt:")) { updatedLines++; return `updatedAt: ${JSON.stringify(new Date().toISOString())}`; }
      return line;
    });
    if (updatedLines !== 1) throw new Error("Task updatedAt field is missing or duplicated.");
    if (input.dueDate) lines.push(`dueDate: ${JSON.stringify(input.dueDate)}`);
    const nextMarkdown = `---${newline}${lines.join(newline)}${frontmatter[3]}---${markdown.slice(frontmatter[0].length)}`;
    const next = parseTask(nextMarkdown);
    const temporary = join(lockFolder, `.${input.taskId}.${randomUUID()}.tmp`);
    try {
      await writeFile(temporary, nextMarkdown, { flag: "wx" });
      await rename(temporary, source.file);
    } catch (error) {
      await unlink(temporary).catch(() => {});
      throw error;
    }
    return next;
  });
}

/** Sets a task folder's task to delivered and appends `line` to its status.md, under the task's write lock. */
export async function deliverTaskSource(source: TaskSource, line: string): Promise<TaskRecord> {
  const folder = source.folder;
  if (!folder) throw new Error("Only tasks with a task folder can be delivered from Mission Control.");
  return withTaskWriteLock(folder, async () => {
    const markdown = await readFile(source.file, "utf8");
    const current = parseTask(markdown);
    if (current.taskId !== source.task.taskId) throw new Error("Task ID does not match its path.");
    let next = current;
    if (current.status !== "delivered") {
      const frontmatter = /^---(\r?\n)([\s\S]*?)(\r?\n)---(?=\r?\n|$)/.exec(markdown);
      if (!frontmatter) throw new Error("Task record has no frontmatter.");
      let replaced = 0;
      const lines = frontmatter[2].split(/\r?\n/).map(entry => {
        if (entry.startsWith("status:")) { replaced++; return `status: ${JSON.stringify("delivered")}`; }
        if (entry.startsWith("updatedAt:")) { replaced++; return `updatedAt: ${JSON.stringify(new Date().toISOString())}`; }
        return entry;
      });
      if (replaced !== 2) throw new Error("Task status fields are missing or duplicated.");
      const nextMarkdown = `---${frontmatter[1]}${lines.join(frontmatter[1])}${frontmatter[3]}---${markdown.slice(frontmatter[0].length)}`;
      next = parseTask(nextMarkdown);
      const temporary = join(folder, `.${current.taskId}.${randomUUID()}.tmp`);
      try {
        await writeFile(temporary, nextMarkdown, { flag: "wx" });
        await rename(temporary, source.file);
      } catch (error) {
        await unlink(temporary).catch(() => {});
        throw error;
      }
    }
    const statusFile = join(folder, "status.md");
    let log = "# Status log\n";
    try { log = await readFile(statusFile, "utf8"); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    await writeFile(statusFile, `${log.replace(/\s*$/, "")}\n${/\n- /.test(log) ? "" : "\n"}${line}\n`);
    return next;
  });
}

/**
 * Records the draft pull request Mission Control opened for a task, sets the task to in_review and appends
 * `line` to its status.md, under the task's write lock. A task that already records a pull request is refused.
 */
export async function recordTaskPullRequest(source: TaskSource, pullRequest: PullRequestRecord, line: string): Promise<TaskRecord> {
  const folder = source.folder;
  if (!folder) throw new Error("Only tasks with a task folder can record a pull request.");
  return withTaskWriteLock(folder, async () => {
    const markdown = await readFile(source.file, "utf8");
    const current = parseTask(markdown);
    if (current.taskId !== source.task.taskId) throw new Error("Task ID does not match its path.");
    if (current.pullRequest) throw new Error(`This task already records the pull request ${current.pullRequest.url}.`);
    const frontmatter = /^---(\r?\n)([\s\S]*?)(\r?\n)---(?=\r?\n|$)/.exec(markdown);
    if (!frontmatter) throw new Error("Task record has no frontmatter.");
    let replaced = 0;
    const lines = frontmatter[2].split(/\r?\n/).map(entry => {
      if (entry.startsWith("status:")) { replaced++; return `status: ${JSON.stringify("in_review")}`; }
      if (entry.startsWith("updatedAt:")) { replaced++; return `updatedAt: ${JSON.stringify(new Date().toISOString())}`; }
      return entry;
    });
    if (replaced !== 2) throw new Error("Task status fields are missing or duplicated.");
    lines.push(`pullRequest: ${JSON.stringify(pullRequestRecordSchema.parse(pullRequest))}`);
    const nextMarkdown = `---${frontmatter[1]}${lines.join(frontmatter[1])}${frontmatter[3]}---${markdown.slice(frontmatter[0].length)}`;
    const next = parseTask(nextMarkdown);
    const temporary = join(folder, `.${current.taskId}.${randomUUID()}.tmp`);
    try {
      await writeFile(temporary, nextMarkdown, { flag: "wx" });
      await rename(temporary, source.file);
    } catch (error) {
      await unlink(temporary).catch(() => {});
      throw error;
    }
    const statusFile = join(folder, "status.md");
    let log = "# Status log\n";
    try { log = await readFile(statusFile, "utf8"); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    await writeFile(statusFile, `${log.replace(/\s*$/, "")}\n${/\n- /.test(log) ? "" : "\n"}${line}\n`);
    return next;
  });
}

/**
 * Records the task's own worktree workspace and adds it to the assignments, keeping the source
 * workspace so the task stays visible there. Re-attaching the same worktree is a no-op.
 */
export async function attachTaskWorktree(input: { serverId: string; taskId: string; worktree: TaskWorktree }): Promise<TaskRecord> {
  const source = (await taskSources(input.serverId)).find(item => item.task.taskId === input.taskId);
  const folder = source?.folder;
  if (!source || !folder) throw new Error("Only tasks with a task folder can use a worktree.");
  return withTaskWriteLock(folder, async () => {
    const markdown = await readFile(source.file, "utf8");
    const current = parseTask(markdown);
    if (current.worktree) {
      if (current.worktree.workspaceId === input.worktree.workspaceId) return current;
      throw new Error("This task already works in another worktree.");
    }
    const frontmatter = /^---(\r?\n)([\s\S]*?)(\r?\n)---(?=\r?\n|$)/.exec(markdown);
    if (!frontmatter) throw new Error("Task record has no frontmatter.");
    const newline = frontmatter[1];
    const assignment = { serverId: input.serverId, workspaceId: input.worktree.workspaceId };
    const assignments = current.assignments.some(item => item.serverId === assignment.serverId && item.workspaceId === assignment.workspaceId)
      ? current.assignments : [...current.assignments, assignment];
    let replaced = 0;
    const lines = frontmatter[2].split(/\r?\n/).map(line => {
      if (line.startsWith("assignments:")) { replaced++; return `assignments: ${JSON.stringify(assignments)}`; }
      if (line.startsWith("updatedAt:")) { replaced++; return `updatedAt: ${JSON.stringify(new Date().toISOString())}`; }
      return line;
    });
    if (replaced !== 2) throw new Error("Task assignment fields are missing or duplicated.");
    lines.push(`worktree: ${JSON.stringify(input.worktree)}`);
    const nextMarkdown = `---${newline}${lines.join(newline)}${frontmatter[3]}---${markdown.slice(frontmatter[0].length)}`;
    const next = parseTask(nextMarkdown);
    const temporary = join(folder, `.${input.taskId}.${randomUUID()}.tmp`);
    try {
      await writeFile(temporary, nextMarkdown, { flag: "wx" });
      await rename(temporary, source.file);
    } catch (error) {
      await unlink(temporary).catch(() => {});
      throw error;
    }
    return next;
  });
}

function revisionOf(content: Buffer): string {
  return createHash("sha256").update(content).digest("hex");
}

async function readDocument(file: string, name: string, editable: boolean) {
  const kind = await lstat(file);
  if (!kind.isFile()) throw new Error(`${name} is not a regular file.`);
  if (kind.size > maxDocumentBytes) throw new Error(`${name} is too large to display in Mission Control.`);
  const bytes = await readFile(file);
  return {
    name,
    content: bytes.toString("utf8"),
    revision: revisionOf(bytes),
    updatedAt: kind.mtime.toISOString(),
    editable,
  };
}

async function recentRunDocuments(taskFolder: string) {
  const runsPath = join(taskFolder, "runs");
  let runNames: string[];
  try { runNames = (await readdir(runsPath)).filter(name => runIdPattern.test(name)); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return []; throw error; }
  const runsRoot = await realpath(runsPath);
  if (!inside(taskFolder, runsRoot)) throw new Error("Runs folder escapes the task.");
  const runs = await Promise.all(runNames.map(async name => {
    const folder = await realpath(join(runsRoot, name));
    if (!inside(runsRoot, folder)) throw new Error("Run folder escapes the task.");
    const stat = await lstat(join(folder, "run.md"));
    if (!stat.isFile()) throw new Error("Run record is not a regular file.");
    return { name, folder, updatedAt: stat.mtimeMs };
  }));
  runs.sort((a, b) => b.updatedAt - a.updatedAt);
  const documents = [];
  for (const run of runs.slice(0, 3)) {
    documents.push(await readDocument(join(run.folder, "run.md"), `runs/${run.name}/run.md`, false));
    try { documents.push(await readDocument(join(run.folder, "handoff.md"), `runs/${run.name}/handoff.md`, false)); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    const eventsPath = join(run.folder, "events");
    let eventNames: string[];
    try { eventNames = (await readdir(eventsPath)).filter(name => eventFilePattern.test(name)); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") continue; throw error; }
    const eventsRoot = await realpath(eventsPath);
    if (!inside(run.folder, eventsRoot)) throw new Error("Events folder escapes the run.");
    const events = await Promise.all(eventNames.map(async name => ({ name, updatedAt: (await lstat(join(eventsRoot, name))).mtimeMs })));
    events.sort((a, b) => b.updatedAt - a.updatedAt);
    for (const event of events.slice(0, 5)) {
      documents.push(await readDocument(join(eventsRoot, event.name), `runs/${run.name}/events/${event.name}`, false));
    }
  }
  return documents;
}

export async function listTaskDocumentRecords(serverId: string, workspaceId: string, taskId: string) {
  const source = await assignedTask(serverId, workspaceId, taskId);
  if (!source.folder) {
    return { documents: [await readDocument(source.file, "task.md", false)] };
  }
  const preferred = ["task.md", "status.md", "notes.md"];
  const names = (await readdir(source.folder))
    .filter(name => taskDocumentNameSchema.safeParse(name).success)
    .sort((a, b) => {
      const rank = (name: string) => preferred.includes(name) ? preferred.indexOf(name) : preferred.length;
      return rank(a) - rank(b) || a.localeCompare(b);
    });
  if (names.length > 50) throw new Error("This task has too many documents to display.");
  const rootDocuments = await Promise.all(names.map(name => readDocument(join(source.folder!, name), name, name !== "task.md")));
  return { documents: [...rootDocuments, ...await recentRunDocuments(source.folder)] };
}

export async function saveTaskDocumentRecord(input: {
  serverId: string;
  workspaceId: string;
  taskId: string;
  name: string;
  content: string;
  revision: string | null;
}) {
  const name = taskDocumentNameSchema.parse(input.name);
  if (name === "task.md") throw new Error("Task metadata is read-only in Docs.");
  if (Buffer.byteLength(input.content, "utf8") > maxDocumentBytes) throw new Error("Document is too large.");
  const source = await assignedTask(input.serverId, input.workspaceId, input.taskId);
  if (!source.folder) throw new Error("Move this legacy task into a task folder before editing its docs.");
  return withTaskWriteLock(source.folder, async () => {
    const file = join(source.folder!, name);
    if (input.revision === null) {
      await writeFile(file, input.content, { flag: "wx" });
    } else {
      const current = await readDocument(file, name, true);
      if (current.revision !== input.revision) {
        throw new Error("This note changed outside Mission Control. Reload it before saving.");
      }
      const temporary = join(source.folder!, `.${name}.${randomUUID()}.tmp`);
      try {
        await writeFile(temporary, input.content, { flag: "wx" });
        await rename(temporary, file);
      } catch (error) {
        await unlink(temporary).catch(() => {});
        throw error;
      }
    }
    return readDocument(file, name, true);
  });
}
