import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import type { PluginHandlerContext, PluginServerContext } from "@getpaseo/plugin/server";
import { agentCleanupSettings, archiveAgentCleanup, cleanupHistorySchema, listAgentCleanupHistory, scanAgentCleanup, type CleanupHistory, type CleanupScope } from "../shared/agent-cleanup";
import { createAgentCleanupEngine, type CleanupAgent, type CleanupSnapshot } from "./agent-cleanup-engine";
import { daemonServerId } from "./agent-names";
import { localServerId, scanTaskSources } from "./tasks";
import { runRecordsOf } from "./runs";
import type { createDecisionStore } from "./decisions";
import type { createQuestionStore } from "./questions";
import type { createPullRequestService } from "./pull-request";
import { createHelperService } from "./subagents";

type Api = PluginHandlerContext["paseo"];
const errorText = (error: unknown) => error instanceof Error ? error.message : String(error);
const relevant = new Set(["user_message", "assistant_message", "reasoning", "tool_call"]);
const directory = join(process.env.PASEO_HOME || join(homedir(), ".paseo"), "plugin-data", "mission-control", "agent-cleanup");
const historyFile = join(directory, "history.json");

async function readHistory(): Promise<CleanupHistory[]> {
  try { return cleanupHistorySchema.array().parse(JSON.parse(await readFile(historyFile, "utf8"))); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return []; throw new Error(`Cleanup history is unreadable: ${errorText(error)}`); }
}
async function record(entry: CleanupHistory) {
  const entries = [...await readHistory(), entry].slice(-500);
  await mkdir(directory, { recursive: true });
  const temporary = join(directory, `${randomUUID()}.tmp`);
  await writeFile(temporary, JSON.stringify(entries, null, 2) + "\n", { mode: 0o600, flag: "wx" });
  await rename(temporary, historyFile);
}
async function allAgents(paseo: Api, includeArchived = false) {
  const agents: Awaited<ReturnType<Api["agents"]["list"]>>["entries"][number]["agent"][] = [];
  let cursor: string | undefined;
  const seen = new Set<string>();
  for (let pageNumber = 0; pageNumber < 100; pageNumber++) {
    const page = await paseo.agents.list({ filter: { includeArchived }, page: { limit: 200, ...(cursor ? { cursor } : {}) } });
    agents.push(...page.entries.map(entry => entry.agent));
    if (!page.pageInfo.hasMore) return agents;
    const next = page.pageInfo.nextCursor;
    if (!next || seen.has(next)) throw new Error("The agent directory is incomplete. Cleanup is unavailable.");
    seen.add(next); cursor = next;
  }
  throw new Error("The agent directory exceeds the cleanup scan limit. Nothing will be archived.");
}
async function allWorkspaces(paseo: Api) {
  const workspaces: Awaited<ReturnType<Api["workspaces"]["list"]>>["entries"] = [];
  let cursor: string | undefined;
  const seen = new Set<string>();
  for (let pageNumber = 0; pageNumber < 100; pageNumber++) {
    const page = await paseo.workspaces.list({ page: { limit: 200, ...(cursor ? { cursor } : {}) } });
    workspaces.push(...page.entries);
    if (!page.pageInfo.hasMore) return workspaces;
    const next = page.pageInfo.nextCursor;
    if (!next || seen.has(next)) throw new Error("The workspace directory is incomplete. Cleanup is unavailable.");
    seen.add(next); cursor = next;
  }
  throw new Error("The workspace directory exceeds the cleanup scan limit. Nothing will be archived.");
}
function toAgent(agent: Awaited<ReturnType<typeof allAgents>>[number]): CleanupAgent {
  return { id: agent.id, title: agent.title, workspaceId: agent.workspaceId, status: agent.status, createdAt: agent.createdAt, updatedAt: agent.updatedAt,
    archivedAt: agent.archivedAt, activeTurn: agent.activeTurn, pendingPermissions: agent.pendingPermissions, requiresAttention: agent.requiresAttention,
    labels: agent.labels, parentAgentId: (agent as typeof agent & { parentAgentId?: string | null }).parentAgentId,
    lastUserMessageAt: agent.lastUserMessageAt, providerUnavailable: agent.providerUnavailable };
}
const familyParent = (agent: CleanupAgent) => agent.parentAgentId || agent.labels?.["paseo.parent-agent-id"] || agent.labels?.["mission-control.parent-agent-id"];

/** Scan activity without waking closed/error/archived agents. A stopped agent's update is a conservative upper bound. */
export async function cleanupActivity(paseo: Api, agent: CleanupAgent) {
  const bounds = [agent.updatedAt, agent.lastUserMessageAt, agent.createdAt].filter((value): value is string => Boolean(value)).map(value => Date.parse(value));
  const upper = { at: bounds.length && bounds.every(Number.isFinite) ? new Date(Math.max(...bounds)).toISOString() : null, basis: "upper-bound" as const };
  if (agent.status !== "idle" || agent.archivedAt || agent.activeTurn || agent.pendingPermissions?.length || agent.providerUnavailable) return upper;
  try {
    const page = await paseo.agents.ref(agent.id).timeline.refetch({ direction: "tail", limit: 50 });
    const activity = page.entries.filter(entry => relevant.has(entry.item.type)).map(entry => Date.parse(entry.timestamp));
    if (!activity.length || activity.some(value => !Number.isFinite(value))) return upper;
    return { at: new Date(Math.max(...activity, Date.parse(agent.lastUserMessageAt || agent.createdAt))).toISOString(), basis: "conversation" as const };
  } catch { return { at: null, basis: "upper-bound" as const }; }
}

export function registerAgentCleanup(server: PluginServerContext, deps: {
  decisions: ReturnType<typeof createDecisionStore>; questions: ReturnType<typeof createQuestionStore>; pullRequests: ReturnType<typeof createPullRequestService>;
}) {
  const settings = server.registerSettings(agentCleanupSettings);
  const helpers = createHelperService({ ttlMs: 0 });
  // Handlers supply the one host-owned API. Do not open another client or act on a different daemon.
  let api: Api | null = null;
  const currentApi = () => { if (!api) throw new Error("Cleanup host connection is unavailable."); return api; };
  async function identity() {
    const [actual, vault] = await Promise.all([daemonServerId(), localServerId()]);
    if (actual !== vault) throw new Error("This vault belongs to another host. Fix Setup before cleanup.");
    return actual;
  }
  async function snapshot(scope: CleanupScope): Promise<CleanupSnapshot> {
    const paseo = currentApi();
    const state = await settings.read();
    if (state.status !== "ready") throw new Error("Cleanup settings cannot be read. Fix them in Settings before cleanup.");
    const [agents, workspaces] = await Promise.all([allAgents(paseo), allWorkspaces(paseo)]);
    if (!workspaces.some(workspace => workspace.id === scope.workspaceId)) throw new Error("The selected workspace is unavailable on this host.");
    const result: CleanupSnapshot = { agents: agents.map(toAgent), workspaces: workspaces.map(workspace => ({ id: workspace.id, pinned: Boolean(workspace.pinnedAt) })),
      tasks: [], pendingAgentIds: [], pendingTaskIds: [], policy: state.values, activity: {}, warnings: [], recordsComplete: true, mergedPullRequests: [] };
    try {
      const scan = await scanTaskSources(scope.serverId);
      if (scan.problems.length) throw new Error(scan.problems.map(problem => `${problem.file}: ${problem.problem}`).join("; "));
      for (const source of scan.sources) {
        const runs = await runRecordsOf(source, scope.serverId);
        const task = source.task;
        result.tasks.push({ id: task.taskId, title: task.title, status: task.status, updatedAt: task.updatedAt,
          agentIds: [...new Set(runs.flatMap(run => run.agentId ? [run.agentId] : []))],
          workspaceIds: task.assignments.filter(item => item.serverId === scope.serverId).map(item => item.workspaceId),
          newerRun: Boolean(runs[0] && Date.parse(runs[0].updatedAt) > Date.parse(task.updatedAt)), hasPullRequest: Boolean(task.pullRequest) });
      }
      const [decisions, questions] = await Promise.all([deps.decisions.list(scope.serverId, Infinity), deps.questions.list(scope.serverId)]);
      result.pendingAgentIds = [...decisions.open.flatMap(entry => entry.decision.agentId ? [entry.decision.agentId] : []), ...questions.questions.map(entry => entry.question.agentId)];
      result.pendingTaskIds = [...decisions.open.map(entry => entry.decision.taskId), ...questions.questions.map(entry => entry.question.taskId)];
    } catch (error) { result.recordsComplete = false; result.warnings.push(`Task/Needs you checks incomplete: ${errorText(error)}`); }
    try {
      const prs = await deps.pullRequests.list({ serverId: scope.serverId, read: true });
      result.mergedPullRequests = prs.pullRequests.filter(pr => pr.state === "merged" && !pr.error);
      if (prs.pullRequests.some(pr => pr.error)) result.warnings.push("Some pull requests could not be checked. Their tasks are kept until delivery is verified.");
    } catch { result.warnings.push("Pull request states could not be checked. Use Attention to verify delivery."); }
    // Bound concurrency, and read only this workspace's families instead of every chat on a host.
    const needed = new Set(agents.filter(agent => agent.workspaceId === scope.workspaceId).map(agent => agent.id));
    for (let changed = true; changed;) {
      changed = false;
      for (const agent of result.agents) {
        const owner = familyParent(agent);
        if ((needed.has(agent.id) && owner && !needed.has(owner)) || (owner && needed.has(owner) && !needed.has(agent.id))) {
          if (owner) needed.add(owner); needed.add(agent.id); changed = true;
        }
      }
    }
    const members = result.agents.filter(agent => needed.has(agent.id));
    for (let index = 0; index < members.length; index += 4) {
      await Promise.all(members.slice(index, index + 4).map(async agent => {
        result.activity[agent.id] = await cleanupActivity(paseo, agent);
        if (agent.status === "idle" && !agent.archivedAt && !agent.activeTurn) {
          const checked = await helpers.list({ serverId: scope.serverId, parentAgentIds: [agent.id] });
          if (!checked.available) (result.unknownHelperAgentIds ??= []).push(agent.id);
          else if (checked.helpers.some(helper => helper.status === "running")) (result.busyHelperAgentIds ??= []).push(agent.id);
        }
      }));
    }
    return result;
  }
  const engine = createAgentCleanupEngine({ localServerId: identity, snapshot, record,
    async archive(agentId, expectedFamily) {
      const paseo = currentApi();
      const latest = (await allAgents(paseo)).map(toAgent);
      const included = new Set([agentId]);
      for (let changed = true; changed;) {
        changed = false;
        for (const agent of latest) if (familyParent(agent) && included.has(familyParent(agent)!) && !included.has(agent.id)) { included.add(agent.id); changed = true; }
      }
      const freshFamily = latest.filter(agent => included.has(agent.id));
      const ordered = (family: CleanupAgent[]) => [...family].sort((a, b) => a.id.localeCompare(b.id));
      if (JSON.stringify(ordered(freshFamily)) !== JSON.stringify(ordered(expectedFamily))) throw new Error("The family changed immediately before archive. Nothing was archived; scan again.");
      const response = await paseo.agents.ref(agentId).archive();
      if (!response?.archivedAt) throw new Error("Paseo did not confirm the archive. Check the agent before trying again.");
      try { return (await allAgents(paseo, true)).filter(agent => included.has(agent.id) && agent.archivedAt).map(agent => agent.id); }
      catch { throw new Error("The archive may have succeeded, but its family result could not be verified. Check Paseo; this preview will not retry."); }
    },
  });
  server.handle(scanAgentCleanup, (input, { paseo }) => { api = paseo; return engine.scan(input); });
  server.handle(archiveAgentCleanup, (input, { paseo }) => { api = paseo; return engine.execute(input); });
  server.handle(listAgentCleanupHistory, async (input, { paseo }) => {
    api = paseo;
    if (input.serverId !== await identity()) throw new Error("Cleanup history belongs to another host.");
    return { entries: (await readHistory()).filter(entry => entry.serverId === input.serverId && entry.workspaceId === input.workspaceId).slice(-30).reverse() };
  });
}
