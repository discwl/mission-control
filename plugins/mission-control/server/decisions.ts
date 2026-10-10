import { createHash, randomUUID } from "node:crypto";
import { lstat, open, readFile, readdir, realpath, unlink, writeFile } from "node:fs/promises";
import { rename } from "./retrying-rename";
import { isAbsolute, join, relative } from "node:path";
import type { PaseoApi } from "@getpaseo/client";
import {
  decisionSchema,
  findingsFileSchema,
  type Decision,
  type DecisionEntry,
  type Finding,
} from "../shared/decisions";
import type { TaskSource } from "./tasks";

type Ref = { serverId: string; workspaceId: string; taskId: string; runId: string; decisionId: string };
type ResolveInput = Ref & { expectedRevision: string; outcome: "approved" | "changes_requested" | "blocked"; note: string; submitFindingIds: string[] };
type Loaded = { decision: Decision; body: string; findings: Finding[]; revision: string; runFolder: string; decisionFile: string; findingsFile: string; source: TaskSource };

const runIdPattern = /^run_[a-f0-9-]+$/;
const decisionFilePattern = /^decision_[a-f0-9-]+\.md$/;

export function inside(root: string, candidate: string) {
  const path = relative(root, candidate);
  return path === "" || (path !== ".." && !path.startsWith("..\\") && !path.startsWith("../") && !isAbsolute(path));
}

export function parseRecord(markdown: string) {
  const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(markdown);
  if (!match) throw new Error("Vault record has no frontmatter.");
  const fields: Record<string, unknown> = {};
  for (const line of match[1].split(/\r?\n/)) {
    const at = line.indexOf(":");
    if (at < 1 || Object.hasOwn(fields, line.slice(0, at))) throw new Error("Vault record has invalid frontmatter.");
    fields[line.slice(0, at)] = JSON.parse(line.slice(at + 1).trim());
  }
  return { fields, body: markdown.slice(match[0].length).trim() };
}

export function markdownRecord(fields: Record<string, unknown>, body: string) {
  return `---\n${Object.entries(fields).map(([key, value]) => `${key}: ${JSON.stringify(value)}`).join("\n")}\n---\n\n${body.trim()}\n`;
}

export async function regularFile(file: string) {
  const stat = await lstat(file);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("Vault records must be regular files.");
  return readFile(file, "utf8");
}

export async function atomicWrite(file: string, content: string) {
  const temporary = `${file}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, content, { flag: "wx" });
    await rename(temporary, file);
  } finally { await unlink(temporary).catch(() => {}); }
}

// Shared with dev-flow.mjs, so the CLI and plugin never write a run at the same time.
export async function withRunLock<T>(runFolder: string, action: () => Promise<T>): Promise<T> {
  const lockPath = join(runFolder, ".write.lock");
  let lock;
  for (let attempt = 0; ; attempt++) {
    try { lock = await open(lockPath, "wx"); break; }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST" || attempt >= 20) {
        if ((error as NodeJS.ErrnoException).code === "EEXIST") throw new Error("This run is being updated. Retry in a moment.");
        throw error;
      }
      await new Promise(resolve => setTimeout(resolve, 50));
    }
  }
  try { return await action(); }
  finally { await lock.close(); await unlink(lockPath); }
}

function revisionOf(decisionText: string, findingsText: string) {
  return createHash("sha256").update(decisionText).update("\0").update(findingsText).digest("hex");
}

function toEntry(loaded: Loaded): DecisionEntry {
  const own = new Set(loaded.decision.findingIds);
  return {
    decision: loaded.decision,
    summary: loaded.body.slice(0, 8000),
    taskTitle: loaded.source.task.title,
    projectId: loaded.source.task.projectId,
    findings: loaded.findings.filter(finding => own.has(finding.findingId)),
    unverifiedFindings: loaded.findings.filter(finding => !own.has(finding.findingId) && ["submitted", "awaiting_verification"].includes(finding.status)).length,
    resolvedFindings: loaded.findings.filter(finding => !own.has(finding.findingId) && finding.status === "resolved"),
    revision: loaded.revision,
  };
}

/** Project profiles are read only from files named like this; Setup flags any other note that looks like one. */
export const projectProfileFile = /^[a-z0-9][a-z0-9_-]*\.md$/;

/** kitRoot of the task's project profile, for the CLI path in the resume message. */
export async function profileKitRoot(vaultRoot: string, projectId: string): Promise<string | null> {
  const root = await realpath(vaultRoot);
  const projects = await realpath(join(root, "Projects"));
  if (!inside(root, projects)) return null;
  const matches: string[] = [];
  for (const name of await readdir(projects)) {
    if (!projectProfileFile.test(name)) continue;
    try {
      const { fields } = parseRecord(await regularFile(join(projects, name)));
      if (fields.projectId === projectId && typeof fields.kitRoot === "string" && isAbsolute(fields.kitRoot)) matches.push(fields.kitRoot);
    } catch { /* Other notes in Projects are not profiles. */ }
  }
  return matches.length === 1 ? matches[0] : null;
}

export function decisionMessage(decision: Decision, findings: Finding[], kitRoot: string | null): string {
  const verdict = decision.status === "approved" ? "APPROVED" : decision.status === "changes_requested" ? "CHANGES REQUESTED" : "BLOCKED";
  const submitted = findings.filter(finding => decision.findingIds.includes(finding.findingId) && finding.status === "submitted");
  const cli = kitRoot ? join(kitRoot, "scripts", "dev-flow.mjs") : "dev-flow.mjs";
  return [
    `Mission Control decision ${decision.decisionId} on your ${decision.kind} for task ${decision.taskId}, run ${decision.runId}: ${verdict} by the user.`,
    decision.note ? `User note: ${decision.note}` : "No note was added.",
    submitted.length ? `Findings to fix:\n${submitted.map(finding => `- ${finding.findingId} [${finding.severity}] ${finding.title}`).join("\n")}` : "",
    `Read the full record with: node ${cli} decision --task ${decision.taskId} --run ${decision.runId} --decision ${decision.decisionId} --server ${decision.serverId} --workspace ${decision.workspaceId}`,
    decision.status === "approved"
      ? "Continue to the next Development Flow stage within the approved scope."
      : decision.status === "changes_requested"
        ? "Use the fix-findings skill. Mark each fixed finding awaiting_verification with evidence; the fix itself never resolves a finding. Then validate and get a fresh review. When that review confirms a fix, mark the finding resolved with the review artifact as evidence (as review-changes says) before requesting the next decision; Mission Control won't accept an approval while earlier findings are unverified."
        : "Stop work on this task. Record a blocked handoff explaining what is needed to continue.",
    "This decision grants no new commit, push, merge, or deployment permission.",
  ].filter(Boolean).join("\n");
}

export function createDecisionStore(deps: { sources: (serverId: string) => Promise<TaskSource[]>; kitRoot?: (source: TaskSource) => Promise<string | null> }) {
  async function runFolderOf(source: TaskSource, runId: string) {
    if (!source.folder || !runIdPattern.test(runId)) throw new Error("Invalid run.");
    const taskFolder = await realpath(source.folder);
    const runs = await realpath(join(taskFolder, "runs"));
    const folder = await realpath(join(runs, runId));
    if (!inside(taskFolder, runs) || !inside(runs, folder)) throw new Error("Run folder escapes the task.");
    return folder;
  }

  async function readFindings(runFolder: string, runId: string) {
    const file = join(runFolder, "findings.json");
    let text = "";
    try { text = await regularFile(file); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    if (!text) return { file, text, findings: [] as Finding[] };
    const parsed = findingsFileSchema.parse(JSON.parse(text));
    if (parsed.runId !== runId) throw new Error("Findings belong to another run.");
    return { file, text, findings: parsed.findings };
  }

  async function load(source: TaskSource, runFolder: string, runId: string, name: string): Promise<Loaded> {
    const decisionFile = join(runFolder, "decisions", name);
    const text = await regularFile(decisionFile);
    const { fields, body } = parseRecord(text);
    const decision = decisionSchema.parse(fields);
    const { task } = source;
    if (`${decision.decisionId}.md` !== name || decision.runId !== runId || decision.taskId !== task.taskId
      || !task.assignments.some(item => item.serverId === decision.serverId && item.workspaceId === decision.workspaceId)) {
      throw new Error(`Decision ${name} does not match its task and run.`);
    }
    const findings = await readFindings(runFolder, runId);
    return { decision, body, findings: findings.findings, revision: revisionOf(text, findings.text), runFolder, decisionFile, findingsFile: findings.file, source };
  }

  async function locate(ref: Ref) {
    const source = (await deps.sources(ref.serverId)).find(item => item.task.taskId === ref.taskId);
    if (!source || !source.task.assignments.some(item => item.serverId === ref.serverId && item.workspaceId === ref.workspaceId)) {
      throw new Error("Task is not assigned to this workspace.");
    }
    const runFolder = await runFolderOf(source, ref.runId);
    return { source, runFolder, reload: () => load(source, runFolder, ref.runId, `${ref.decisionId}.md`) };
  }

  async function list(serverId: string, recentLimit = 10) {
    const all: Loaded[] = [];
    for (const source of await deps.sources(serverId)) {
      if (!source.folder) continue;
      let runNames: string[];
      try { runNames = await readdir(join(source.folder, "runs")); }
      catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") continue; throw error; }
      for (const runId of runNames.filter(name => runIdPattern.test(name))) {
        const runFolder = await runFolderOf(source, runId);
        let names: string[];
        try { names = await readdir(join(runFolder, "decisions")); }
        catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") continue; throw error; }
        for (const name of names.filter(value => decisionFilePattern.test(value))) all.push(await load(source, runFolder, runId, name));
      }
    }
    const open = all.filter(item => item.decision.status === "open").sort((a, b) => a.decision.requestedAt.localeCompare(b.decision.requestedAt));
    const recent = all.filter(item => item.decision.status !== "open").sort((a, b) => (b.decision.resolvedAt ?? "").localeCompare(a.decision.resolvedAt ?? "")).slice(0, recentLimit);
    return { open: open.map(toEntry), recent: recent.map(toEntry) };
  }

  async function writeDecision(loaded: Loaded, decision: Decision) {
    await atomicWrite(loaded.decisionFile, markdownRecord(decision, loaded.body));
  }

  async function deliver(ref: Ref, paseo: PaseoApi): Promise<DecisionEntry> {
    const { source, runFolder, reload } = await locate(ref);
    const sending = await withRunLock(runFolder, async () => {
      const loaded = await reload();
      const { decision } = loaded;
      if (decision.resume?.phase !== "pending") return null;
      const fail = async (error: string) => { await writeDecision(loaded, { ...decision, resume: { phase: "pending", error, updatedAt: new Date().toISOString() } }); return null; };
      if (!decision.agentId) return fail("No agent is linked to this run. Open the task and resume it.");
      let agent;
      try { agent = (await paseo.agents.ref(decision.agentId).refresh())?.agent ?? null; }
      catch (error) {
        if (!(error instanceof Error && error.message === `Agent not found: ${decision.agentId}`)) throw error;
        agent = null;
      }
      if (!agent || agent.archivedAt || agent.status === "closed") return fail("The run's agent is unavailable or archived. Resume the task from its handoff.");
      if (agent.workspaceId !== decision.workspaceId) return fail("The run's agent moved to another workspace.");
      if (agent.status !== "idle" || agent.activeTurn || agent.pendingPermissions.length) return fail("The agent is busy or waiting on a permission. Send the decision when it is idle.");
      const next = { ...decision, resume: { phase: "sending" as const, error: null, updatedAt: new Date().toISOString() } };
      await writeDecision(loaded, next);
      return { decision: next, findings: loaded.findings };
    });
    if (sending) {
      const kitRoot = deps.kitRoot ? await deps.kitRoot(source).catch(() => null) : null;
      let error: string | null = null;
      try { await paseo.agents.ref(sending.decision.agentId!).send(decisionMessage(sending.decision, sending.findings, kitRoot), { messageId: sending.decision.decisionId }); }
      catch (cause) { error = cause instanceof Error ? cause.message : String(cause); }
      await withRunLock(runFolder, async () => {
        const loaded = await reload();
        // A failed send stays `sending`: the agent may have accepted it before the error.
        await writeDecision(loaded, { ...loaded.decision, resume: { phase: error ? "sending" : "sent", error, updatedAt: new Date().toISOString() } });
      });
    }
    return toEntry(await reload());
  }

  async function resolve(input: ResolveInput, paseo: PaseoApi): Promise<DecisionEntry> {
    const { runFolder, reload } = await locate(input);
    await withRunLock(runFolder, async () => {
      const loaded = await reload();
      const { decision } = loaded;
      if (decision.status !== "open") throw new Error("This decision was already made. Refresh Needs you.");
      if (loaded.revision !== input.expectedRevision) throw new Error("The request changed since you opened it. Refresh and review it again.");
      const note = input.note.trim();
      const own = loaded.findings.filter(finding => decision.findingIds.includes(finding.findingId));
      const submit = new Set(input.submitFindingIds);
      if ([...submit].some(id => !own.some(finding => finding.findingId === id && finding.status === "open"))) throw new Error("Only this request's open findings can be sent for fixing.");
      if (decision.kind === "plan" && submit.size) throw new Error("Plan decisions have no findings.");
      if (input.outcome === "changes_requested" && decision.kind === "review" && own.length && !submit.size) throw new Error("Select at least one finding to fix.");
      if (input.outcome !== "changes_requested" && submit.size) throw new Error("Findings are only sent when requesting changes.");
      const dismissed = own.filter(finding => finding.status === "open" && !submit.has(finding.findingId));
      if (input.outcome === "blocked" && !note) throw new Error("Add a note explaining the block.");
      if (input.outcome === "changes_requested" && decision.kind === "plan" && !note) throw new Error("Describe the plan changes you want.");
      if (input.outcome !== "blocked" && dismissed.length && !note) throw new Error(`Add a note explaining why ${dismissed.length} finding${dismissed.length === 1 ? " is" : "s are"} dismissed.`);
      if (input.outcome === "approved" && decision.kind === "review") {
        const pending = loaded.findings.filter(finding => !decision.findingIds.includes(finding.findingId) && ["submitted", "awaiting_verification"].includes(finding.status));
        if (pending.length) throw new Error(`${pending.length} earlier finding${pending.length === 1 ? " is" : "s are"} not verified yet. Request a fresh review first.`);
      }
      const now = new Date().toISOString();
      if (input.outcome !== "blocked" && own.some(finding => finding.status === "open")) {
        const findings = loaded.findings.map(finding => !decision.findingIds.includes(finding.findingId) || finding.status !== "open" ? finding
          : { ...finding, status: submit.has(finding.findingId) ? "submitted" as const : "dismissed" as const, updatedAt: now });
        await atomicWrite(loaded.findingsFile, `${JSON.stringify({ schemaVersion: 1, runId: decision.runId, findings }, null, 2)}\n`);
      }
      await writeDecision(loaded, { ...decision, status: input.outcome, resolvedAt: now, note: note || null, resume: { phase: "pending", error: null, updatedAt: now } });
    });
    return deliver(input, paseo);
  }

  async function resend(input: Ref & { expectedRevision: string }, paseo: PaseoApi) {
    const loaded = await (await locate(input)).reload();
    if (loaded.revision !== input.expectedRevision) throw new Error("The decision changed. Refresh Needs you.");
    if (loaded.decision.resume?.phase !== "pending") throw new Error("This decision was already sent or delivery is unconfirmed. Open the agent to check.");
    return deliver(input, paseo);
  }

  return { list, resolve, resend };
}
