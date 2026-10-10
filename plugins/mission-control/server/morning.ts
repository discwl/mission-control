import { randomUUID } from "node:crypto";
import { lstat, mkdir, open, readFile, readdir, realpath, unlink, writeFile } from "node:fs/promises";
import { rename } from "./retrying-rename";
import { isAbsolute, join, relative } from "node:path";
import type { PaseoApi, PaseoAgent } from "@getpaseo/client";
import type { PluginServerContext } from "@getpaseo/plugin/server";
import {
  getMorningStatus,
  importMorningItems,
  morningLaunchSchema,
  morningReportIdSchema,
  morningReportSchema,
  startMorningCheck,
  type MorningLaunch,
  type MorningReport,
  type MorningStatus,
  type MorningTaskBrief,
} from "../shared/morning";
import { compareTrackerItems, importedTaskFields, ticketIdentity } from "../shared/tickets";
import { defaultVaultPath } from "../shared/vault";
import { workflowInstructionsPrompt } from "../shared/workflow-instructions.mjs";
import { createWorkflowInstructionsStore } from "./workflow-instructions-store.mjs";
import { profileKitRoot } from "./decisions";
import { createTaskRecord, scanTaskSources, type SkippedTicket, type TaskSource } from "./tasks";

const reportFilePattern = /^morning-\d{4}-\d{2}-\d{2}-\d{6}(?:-\d+)?\.md$/;
const launchFile = ".morning-check-launch.json";

type Deps = {
  vaultRoot: string;
  // Every valid task, plus the invalid task files that carry a ticket: those count as imported too.
  sources: (serverId: string) => Promise<{ sources: TaskSource[]; skipped: SkippedTicket[] }>;
  createTask: typeof createTaskRecord;
  kitRoot: (projectId: string) => Promise<string | null>;
};

/** Invalid task files whose ticket was read, as tasks carrying that ticket, so they count as imported. */
const ticketsOf = (skipped: readonly SkippedTicket[]) => skipped.flatMap(entry => entry.ticket ? [{ taskId: entry.taskId, ticket: entry.ticket }] : []);

function inside(root: string, candidate: string) {
  const path = relative(root, candidate);
  return path === "" || (path !== ".." && !path.startsWith("..\\") && !path.startsWith("../") && !isAbsolute(path));
}

function parseReport(markdown: string): { fields: MorningReport; body: string } {
  const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(markdown);
  if (!match) throw new Error("The Morning check report has no frontmatter.");
  const fields: Record<string, unknown> = {};
  for (const line of match[1].split(/\r?\n/)) {
    const at = line.indexOf(":");
    if (at < 1 || Object.hasOwn(fields, line.slice(0, at))) throw new Error("The Morning check report has invalid frontmatter.");
    fields[line.slice(0, at)] = JSON.parse(line.slice(at + 1).trim());
  }
  return { fields: morningReportSchema.parse(fields), body: markdown.slice(match[0].length).trim() };
}

async function refreshAgent(paseo: PaseoApi, agentId: string): Promise<PaseoAgent | null> {
  try { return (await paseo.agents.ref(agentId).refresh())?.agent ?? null; }
  catch (error) {
    // SDK 0.9.1 throws for an absent agent. Other errors must surface.
    if (error instanceof Error && error.message === `Agent not found: ${agentId}`) return null;
    throw error;
  }
}

// An agent that ended in error or was closed is finished, even before anyone archives it.
function busy(agent: PaseoAgent) {
  return agent.status === "initializing" || agent.status === "running" || Boolean(agent.activeTurn) || agent.pendingPermissions.length > 0;
}

// Exclusive across RPC calls and clients (desktop and phone), released even when the action fails.
async function withLock<T>(folder: string, name: string, busyMessage: string, action: () => Promise<T>): Promise<T> {
  const lockPath = join(folder, name);
  let lock;
  try { lock = await open(lockPath, "wx"); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") throw new Error(busyMessage);
    throw error;
  }
  try { return await action(); }
  finally { await lock.close(); await unlink(lockPath); }
}

export function morningPrompt(input: { hostId: string; serverId: string; agentId: string; kitRoot: string; fixture: boolean; workflowInstructions?: string }) {
  return [
    `Run the Mission Control Morning check for host ${input.hostId} (server ${input.serverId}).`,
    `Read ${join(input.kitRoot, "skills", "morning-check", "SKILL.md")} and follow it. The report script is ${join(input.kitRoot, "scripts", "morning-check.mjs")}.`,
    input.fixture
      ? "Tracker: use the test fixture. Run the report with --tracker fixture and do not read Jira or Azure DevOps or consult external systems, even when custom guidance names them."
      : "Tracker: read the user's current-sprint items with the Jira or Azure DevOps MCP tools this session has. If it has none, say so and run the report with --tracker unavailable.",
    "Read only: never create, edit, transition, assign or comment on anything in Jira or Azure DevOps. Don't create tasks or change task status; the user picks imports in Mission Control.",
    `Your Paseo agent ID is ${input.agentId}; pass it to the report with --agent.`,
    input.workflowInstructions ?? "",
  ].filter(Boolean).join("\n");
}

export function createMorningStore(overrides: Partial<Deps> = {}) {
  const deps: Deps = {
    vaultRoot: defaultVaultPath, sources: scanTaskSources, createTask: createTaskRecord,
    kitRoot: projectId => profileKitRoot(defaultVaultPath, projectId), ...overrides,
  };

  async function daily() {
    const root = await realpath(deps.vaultRoot);
    const folder = join(root, "Daily");
    await mkdir(folder, { recursive: true });
    const resolved = await realpath(folder);
    if (!inside(root, resolved)) throw new Error("The Daily folder must stay inside dev-vault.");
    return resolved;
  }
  // The vault's host.json names the host this installation serves; other hosts run their own.
  async function localHost(serverId: string) {
    const host = JSON.parse(await readFile(join(await realpath(deps.vaultRoot), "host.json"), "utf8"));
    if (host?.schemaVersion !== 1 || typeof host.hostId !== "string" || host.serverId !== serverId) throw new Error("Open Mission Control on that host to use its Morning check.");
    return { hostId: host.hostId as string, serverId };
  }
  async function readReport(folder: string, name: string) {
    const file = join(folder, name);
    const stat = await lstat(file);
    if (!stat.isFile()) throw new Error(`${name} is not a regular file.`);
    const { fields, body } = parseReport(await readFile(file, "utf8"));
    if (`${fields.reportId}.md` !== name) throw new Error(`${name} has a different report ID.`);
    return { ...fields, file, body };
  }
  async function readLaunch(folder: string): Promise<MorningLaunch | null> {
    try { return morningLaunchSchema.parse(JSON.parse(await readFile(join(folder, launchFile), "utf8"))); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return null; throw error; }
  }
  async function saveLaunch(folder: string, launch: MorningLaunch) {
    const temporary = join(folder, `.morning-check-launch-${randomUUID()}.tmp`);
    try {
      await writeFile(temporary, JSON.stringify(launch, null, 2), { flag: "wx" });
      await rename(temporary, join(folder, launchFile));
    } finally { await unlink(temporary).catch(() => {}); }
  }

  async function status({ serverId }: { serverId: string }, paseo: PaseoApi): Promise<MorningStatus> {
    await localHost(serverId);
    const folder = await daily();
    // Report IDs sort by local time; a same-second repeat (-2, -3…) sorts after its first report.
    const names = (await readdir(folder)).filter(name => reportFilePattern.test(name))
      .map(name => name.slice(0, -3)).sort((a, b) => b.localeCompare(a, undefined, { numeric: true }));
    let report: MorningStatus["report"] = null;
    let reportError: string | null = null;
    if (names.length) {
      try { report = await readReport(folder, `${names[0]}.md`); }
      catch (error) { reportError = `${names[0]}.md: ${error instanceof Error ? error.message : String(error)}`; }
    }
    const { sources, skipped } = await deps.sources(serverId);
    const tasks = sources.map(source => source.task);
    const comparison = compareTrackerItems(report?.items ?? [], [...tasks, ...ticketsOf(skipped)]);
    const briefs = new Map<string, MorningTaskBrief>([
      ...tasks.map(task => [task.taskId, { taskId: task.taskId, title: task.title, status: task.status }] as const),
      ...skipped.map(entry => [entry.taskId, { taskId: entry.taskId, title: `${entry.title ?? entry.taskId} · ${entry.file}`, status: "invalid" }] as const),
    ]);
    const launch = await readLaunch(folder);
    const snapshot = launch ? await refreshAgent(paseo, launch.agentId) : null;
    return {
      report, reportError, missing: comparison.missing,
      imported: comparison.imported.map(({ item, taskIds }) => ({ item, tasks: taskIds.map(id => briefs.get(id)!) })),
      launch,
      agent: snapshot && !snapshot.archivedAt ? { id: snapshot.id, title: snapshot.title || "Morning check", status: snapshot.status, busy: busy(snapshot) } : null,
    };
  }

  async function start(input: { serverId: string; workspaceId: string; provider: string; modeId?: string; thinkingOptionId?: string; fixture: boolean }, paseo: PaseoApi) {
    const { hostId } = await localHost(input.serverId);
    const folder = await daily();
    // Check, journal and agent creation happen under one lock, so two near-simultaneous starts can't both pass the check.
    await withLock(folder, ".morning-start.lock", "A Morning check is starting. Refresh and retry.", async () => {
      const previous = await readLaunch(folder);
      const running = previous ? await refreshAgent(paseo, previous.agentId) : null;
      if (running && !running.archivedAt && busy(running)) throw new Error("A Morning check is still running. Open its agent.");
      const workspace = await paseo.workspaces.ref(input.workspaceId).refresh();
      if (!workspace || workspace.archivingAt) throw new Error("This workspace is unavailable on this host.");
      const kitRoot = await deps.kitRoot(workspace.projectId);
      if (!kitRoot) throw new Error("This workspace's project has no Development Flow profile with a kitRoot. Run the Morning check from a workspace whose project has one.");
      for (const file of [join(kitRoot, "skills", "morning-check", "SKILL.md"), join(kitRoot, "scripts", "morning-check.mjs")]) {
        try { if (!(await lstat(file)).isFile()) throw new Error(); }
        catch { throw new Error(`The Development Flow kit at ${kitRoot} has no Morning check yet (${file} is missing).`); }
      }
      const instructions = await createWorkflowInstructionsStore(deps.vaultRoot).read({ serverId: input.serverId, hostId, projectId: workspace.projectId });
      const guidance = workflowInstructionsPrompt(instructions, ["intake"]);
      const now = new Date().toISOString();
      let launch: MorningLaunch = morningLaunchSchema.parse({
        launchId: randomUUID(), agentId: randomUUID(), serverId: input.serverId, workspaceId: input.workspaceId,
        provider: input.provider, fixture: input.fixture, phase: "sending", createdAt: now, updatedAt: now, error: null,
      });
      await saveLaunch(folder, launch);
      try {
        const config = { provider: input.provider, ...(input.modeId ? { modeId: input.modeId } : {}), ...(input.thinkingOptionId ? { thinkingOptionId: input.thinkingOptionId } : {}) };
        await paseo.workspaces.ref(input.workspaceId).agents.create({
          agentId: launch.agentId, idempotencyKey: launch.launchId, config, title: "Morning check",
          labels: { "mission-control.role": "morning-check" },
          prompt: morningPrompt({ hostId, serverId: input.serverId, agentId: launch.agentId, kitRoot, fixture: input.fixture, workflowInstructions: guidance }),
        });
        launch = { ...launch, phase: "sent", updatedAt: new Date().toISOString() };
      } catch (error) {
        // Leave the phase at 'sending': a lost response may still have started the agent.
        launch = { ...launch, error: error instanceof Error ? error.message : String(error), updatedAt: new Date().toISOString() };
        throw error;
      } finally { await saveLaunch(folder, launch); }
    });
    return status(input, paseo);
  }

  async function importItems(input: { serverId: string; workspaceId: string; reportId: string; items: string[] }, paseo: PaseoApi) {
    await localHost(input.serverId);
    const workspace = await paseo.workspaces.ref(input.workspaceId).refresh();
    if (!workspace || workspace.archivingAt) throw new Error("This workspace is unavailable on this host.");
    const folder = await daily();
    // One import at a time, so a double click can't create the same ticket twice.
    return withLock(folder, ".morning-import.lock", "Another import is running. Refresh and retry.", async () => {
      const report = await readReport(folder, `${morningReportIdSchema.parse(input.reportId)}.md`);
      const byIdentity = new Map(report.items.map(item => [ticketIdentity(item), item]));
      const picked = [...new Set(input.items)].map(identity => {
        const item = byIdentity.get(identity);
        if (!item) throw new Error(`${identity} is not in this report.`);
        return item;
      });
      const { sources, skipped } = await deps.sources(input.serverId);
      // A skipped task file whose ticket can't be read could be any of these items; importing could duplicate it.
      const unknown = skipped.filter(entry => !entry.ticket);
      if (unknown.length) throw new Error(`${unknown.map(entry => entry.file).join(", ")} ${unknown.length === 1 ? "is" : "are"} invalid and ${unknown.length === 1 ? "its ticket" : "their tickets"} can't be read, so importing could create a duplicate. Fix ${unknown.length === 1 ? "that file" : "those files"} in dev-vault first.`);
      const existing = compareTrackerItems(picked, [...sources.map(source => source.task), ...ticketsOf(skipped)]);
      const created = [];
      for (const item of existing.missing) {
        const task = await deps.createTask({ serverId: input.serverId, workspaceId: input.workspaceId, ...importedTaskFields(item) }, workspace.projectId);
        created.push({ taskId: task.taskId, title: task.title, status: task.status, key: item.key });
      }
      return { created, skipped: existing.imported.map(({ item, taskIds }) => ({ key: item.key, taskIds })) };
    });
  }

  return { status, start, importItems };
}

export function registerMorning(server: PluginServerContext) {
  const morning = createMorningStore();
  server.handle(getMorningStatus, (input, { paseo }) => morning.status(input, paseo));
  server.handle(startMorningCheck, (input, { paseo }) => morning.start(input, paseo));
  server.handle(importMorningItems, (input, { paseo }) => morning.importItems(input, paseo));
}
