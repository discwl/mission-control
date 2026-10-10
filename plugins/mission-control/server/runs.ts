import { readFile, readdir, realpath } from "node:fs/promises";
import { isAbsolute, join, relative } from "node:path";
import { runSchema, type RunRecord } from "../shared/runs";
import { assignedTask, localServerId, type TaskSource } from "./tasks";
import { defaultVaultPath } from "../shared/vault";
import { workflowInstructionsPrompt } from "../shared/workflow-instructions.mjs";
import { createWorkflowInstructionsStore } from "./workflow-instructions-store.mjs";

const runIdPattern = /^run_[a-f0-9-]+$/;

function inside(root: string, candidate: string): boolean {
  const remainder = relative(root, candidate);
  return remainder === "" || (remainder !== ".." && !remainder.startsWith("..\\") && !remainder.startsWith("../") && !isAbsolute(remainder));
}

function parseRun(markdown: string): RunRecord {
  const frontmatter = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(markdown);
  if (!frontmatter) throw new Error("Run record has no frontmatter.");
  const fields: Record<string, unknown> = {};
  for (const line of frontmatter[1].split(/\r?\n/)) {
    const separator = line.indexOf(":");
    if (separator < 1) throw new Error("Run record has invalid frontmatter.");
    const key = line.slice(0, separator);
    if (Object.hasOwn(fields, key)) throw new Error(`Run record repeats ${key}.`);
    fields[key] = JSON.parse(line.slice(separator + 1).trim());
  }
  return runSchema.parse(fields);
}

export async function listRunRecords(serverId: string, workspaceId: string, taskId: string): Promise<RunRecord[]> {
  return runRecordsOf(await assignedTask(serverId, workspaceId, taskId), serverId);
}

/** A task's runs on this host, newest first. */
export async function runRecordsOf(source: TaskSource, serverId: string): Promise<RunRecord[]> {
  const taskId = source.task.taskId;
  if (!source.folder) return [];
  const taskFolder = await realpath(source.folder);
  let names: string[];
  try { names = await readdir(join(taskFolder, "runs")); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return []; throw error; }
  const runsRoot = await realpath(join(taskFolder, "runs"));
  if (!inside(taskFolder, runsRoot)) throw new Error("Runs folder escapes the task.");
  const runs: RunRecord[] = [];
  for (const name of names.filter(value => runIdPattern.test(value))) {
    const folder = await realpath(join(runsRoot, name));
    if (!inside(runsRoot, folder)) throw new Error("Run folder escapes the task.");
    const runFile = await realpath(join(folder, "run.md"));
    if (!inside(folder, runFile)) throw new Error("Run record escapes its folder.");
    const run = parseRun(await readFile(runFile, "utf8"));
    // A run may belong to any of the task's workspaces, such as its own worktree.
    const assigned = source.task.assignments.some(item => item.serverId === run.serverId && item.workspaceId === run.workspaceId);
    if (run.runId !== name || run.taskId !== taskId || run.serverId !== serverId || !assigned || run.hostId !== source.task.hostId || run.projectId !== source.task.projectId) {
      throw new Error("Run identity does not match its task and workspace.");
    }
    runs.push(run);
  }
  return runs.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

/** The summary of the run's latest handoff: the text between "# Handoff" and the next heading. */
export async function handoffSummary(source: TaskSource, run: RunRecord | undefined): Promise<string | null> {
  if (!source.folder || !run) return null;
  const markdown = await readFile(join(source.folder, "runs", run.runId, "handoff.md"), "utf8").catch(() => null);
  if (!markdown) return null;
  const body = markdown.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, "");
  const match = /^# Handoff\s*\r?\n([\s\S]*?)(?=^## |$(?![\s\S]))/m.exec(body);
  const text = (match?.[1] ?? "").trim();
  return text ? text.slice(0, 8_000) : null;
}

export async function taskAgentPrompt(workspaceId: string, taskId: string) {
  const serverId = await localServerId();
  const source = await assignedTask(serverId, workspaceId, taskId);
  const instructions = await createWorkflowInstructionsStore(defaultVaultPath).read({ serverId, hostId: source.task.hostId, projectId: source.task.projectId });
  return { title: source.task.title, prompt: taskPromptText({
    workflowInstructions: workflowInstructionsPrompt(instructions), serverId, workspaceId, taskId, title: source.task.title, projectId: source.task.projectId, file: source.file, dueDate: source.task.dueDate }) };
}

/** The working rules Start task, Resume and /mission-task give a task's agent. */
export function taskPromptText({ serverId, workspaceId, taskId, title, projectId, file, workflowInstructions = "", dueDate }: { serverId: string; workspaceId: string; taskId: string; title: string; projectId: string; file: string; workflowInstructions?: string; dueDate?: string }) {
  return [
    `Work on Mission Control task ${taskId}: ${title}.`,
    `This task belongs to server ${serverId}, workspace ${workspaceId}, and project ${projectId}.`,
    dueDate ? `It is due ${dueDate}. Plan to finish, validate and hand off before then; if that isn't feasible, say so early and explain what would fit.` : "",
    `Its record is ${file}. Use the installed check-environment skill to load and verify that exact task before planning or editing.`,
    "Follow the Development Flow plan, execute, validate, fresh review, and handoff skills. Save run evidence in the task folder.",
    "A displayed task status is not an approval or validation result. Preserve the existing decision and delivery permissions.",
    "Whenever you stop to ask the user something that isn't a plan or review decision, first record it with the kit's scripts/dev-flow.mjs ask command (its help lists the short plain fields: where things stand and what you need). Mission Control's Attention tab shows it with a Reply box.",
    "Read workflowInstructions from dev-flow context on every start and resume. Apply the effective Intake and Planning guidance in its respective stage; resolve missing requirements before implementation.",
    workflowInstructions,
  ].filter(Boolean).join("\n");
}
