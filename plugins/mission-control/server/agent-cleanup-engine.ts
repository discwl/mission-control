import { createHash, randomUUID } from "node:crypto";
import type { AgentCleanupResult, CleanupHistory, CleanupPolicy, CleanupRow, CleanupScan, CleanupScope } from "../shared/agent-cleanup";
import type { TrackedPullRequest } from "../shared/pull-request";

export interface CleanupAgent {
  id: string; title: string | null; workspaceId?: string; status: string; createdAt: string; updatedAt: string;
  archivedAt?: string | null; activeTurn?: unknown; pendingPermissions?: readonly unknown[] | null;
  lastUserMessageAt?: string | null; providerUnavailable?: boolean;
  requiresAttention?: boolean; labels?: Record<string, string> | null; parentAgentId?: string | null;
}
export interface CleanupTask {
  id: string; title: string; status: string; updatedAt: string; agentIds: string[]; workspaceIds: string[];
  newerRun: boolean; hasPullRequest: boolean;
}
export interface CleanupSnapshot {
  agents: CleanupAgent[]; workspaces: { id: string; pinned: boolean }[]; tasks: CleanupTask[];
  pendingAgentIds: string[]; pendingTaskIds: string[]; policy: CleanupPolicy;
  activity: Record<string, { at: string | null; basis: "conversation" | "upper-bound" }>;
  warnings: string[]; recordsComplete: boolean; mergedPullRequests: TrackedPullRequest[];
  busyHelperAgentIds?: string[]; unknownHelperAgentIds?: string[];
}
const DAY = 86_400_000;
const TTL = 5 * 60_000;
const parent = (agent: CleanupAgent) => agent.parentAgentId?.trim() || agent.labels?.["paseo.parent-agent-id"]?.trim() || agent.labels?.["mission-control.parent-agent-id"]?.trim() || null;
const nativeParent = (agent: CleanupAgent) => agent.labels?.["paseo.parent-agent-id"]?.trim() || null;
const timestamp = (value: string | null | undefined) => value ? Date.parse(value) : NaN;
const terminal = (task: CleanupTask) => task.status === "delivered" || task.status === "closed";
const message = (error: unknown) => error instanceof Error ? error.message : String(error);

/** Inspect the complete family even when Paseo would detach or leave some descendants alone. */
function familyOf(agents: CleanupAgent[], id: string) {
  const seen = new Set([id]);
  const family = agents.filter(agent => agent.id === id);
  for (let i = 0; i < family.length; i++) {
    for (const child of agents.filter(agent => parent(agent) === family[i].id)) {
      if (!seen.has(child.id)) { seen.add(child.id); family.push(child); }
    }
  }
  return family;
}
function rootOf(agent: CleanupAgent, agents: Map<string, CleanupAgent>) {
  const seen = new Set<string>();
  while (parent(agent)) {
    if (seen.has(agent.id)) return { root: agent, problem: "The family links contain a cycle." };
    seen.add(agent.id);
    const next = agents.get(parent(agent)!);
    if (!next || next.archivedAt) return { root: agent, problem: "The parent is unavailable or archived; the whole family cannot be verified." };
    agent = next;
  }
  return { root: agent, problem: null };
}
function consequences(family: CleanupAgent[], root: CleanupAgent) {
  const archiveIds = [root.id], detachedIds: string[] = [], untouchedIds: string[] = [];
  const archived = new Set(archiveIds);
  for (const child of family.filter(agent => agent.id !== root.id)) {
    if (nativeParent(child) && archived.has(nativeParent(child)!)) {
      if (child.workspaceId !== root.workspaceId || child.labels?.[`paseo.open-agent-tab.${child.id}`] === "true") detachedIds.push(child.id);
      else { archived.add(child.id); archiveIds.push(child.id); }
    } else untouchedIds.push(child.id);
  }
  return { archiveIds, detachedIds, untouchedIds };
}

export function cleanupCandidates(snapshot: CleanupSnapshot, scope: CleanupScope, now: number): CleanupRow[] {
  const byId = new Map(snapshot.agents.map(agent => [agent.id, agent]));
  const members = snapshot.agents.filter(agent => !agent.archivedAt && agent.workspaceId === scope.workspaceId && (!scope.agentId || agent.id === scope.agentId));
  if (scope.agentId && !members.length) throw new Error("This agent is no longer in the selected workspace. Scan again.");
  const roots = new Map<string, ReturnType<typeof rootOf>>();
  for (const agent of members) { const result = rootOf(agent, byId); roots.set(result.root.id, result); }
  return [...roots.values()].map(({ root, problem }) => {
    const family = familyOf(snapshot.agents, root.id);
    const ids = new Set(family.map(agent => agent.id));
    const taskIds = new Set(family.flatMap(agent => agent.labels?.["mission-control.task-id"] ? [agent.labels["mission-control.task-id"]] : []));
    const tasks = snapshot.tasks.filter(task => taskIds.has(task.id) || task.agentIds.some(id => ids.has(id)));
    const times = family.map(agent => timestamp(snapshot.activity[agent.id]?.at));
    const last = Math.max(...times);
    const row: CleanupRow = {
      agentId: root.id, title: root.title || root.id, disposition: "keep", reason: "", lastActivityAt: Number.isFinite(last) ? new Date(last).toISOString() : null,
      activityBasis: family.some(agent => snapshot.activity[agent.id]?.basis !== "conversation") ? "upper-bound" : "conversation",
      taskTitles: tasks.map(task => task.title), ...consequences(family, root), manualOnly: tasks.length === 0,
    };
    const keep = (reason: string, unknown = false) => ({ ...row, disposition: unknown ? "unknown" as const : "keep" as const, reason });
    if (problem) return keep(problem, true);
    if (root.workspaceId !== scope.workspaceId) return keep("The family owner is in another workspace. Check cleanup there.");
    if (family.some(agent => agent.status === "running" || agent.status === "initializing" || agent.activeTurn || snapshot.busyHelperAgentIds?.includes(agent.id))) return keep("This family has work running.");
    if (family.some(agent => agent.pendingPermissions?.length || agent.requiresAttention || agent.status === "error")) return keep("This family needs permission, attention or error recovery.");
    if (family.some(agent => agent.providerUnavailable || snapshot.unknownHelperAgentIds?.includes(agent.id))) return keep("A family member's provider or internal helpers could not be verified.", true);
    if (family.some(agent => agent.pendingPermissions == null)) return keep("Permission state could not be verified.", true);
    if (family.some(agent => agent.labels?.[`paseo.open-agent-tab.${agent.id}`] === "true" || agent.labels?.["mission-control.cleanup.keep"] === "true")) return keep("A family member is open in its own tab or marked to keep.");
    if (family.some(agent => snapshot.workspaces.find(workspace => workspace.id === agent.workspaceId)?.pinned)) return keep("A family member belongs to a pinned workspace.");
    if (family.some(agent => !snapshot.workspaces.some(workspace => workspace.id === agent.workspaceId))) return keep("A family member's workspace could not be verified.", true);
    if (!snapshot.recordsComplete) return keep("Task or Needs you records could not be fully verified. Nothing will be archived.", true);
    if ([...taskIds].some(id => !tasks.some(task => task.id === id))) return keep("A linked task record is missing.", true);
    if (snapshot.pendingAgentIds.some(id => ids.has(id)) || tasks.some(task => snapshot.pendingTaskIds.includes(task.id))) return keep("A question or plan/review decision is waiting for you.");
    const unfinished = tasks.find(task => !terminal(task) || task.newerRun);
    if (unfinished) return keep(`Task still needs work or delivery: ${unfinished.title}.`);
    if (tasks.some(task => task.status === "closed" && task.hasPullRequest)) return keep("A closed task still has a pull request record. Verify its delivery in Attention first.");
    if (!tasks.length && snapshot.tasks.some(task => !terminal(task) && task.workspaceIds.some(id => family.some(agent => agent.workspaceId === id)))) return keep("There is unfinished work in this workspace, and this agent has no task link.");
    if (times.some(time => !Number.isFinite(time)) || last > now || tasks.some(task => !Number.isFinite(timestamp(task.updatedAt)) || timestamp(task.updatedAt) > now)) return keep("Activity or task dates could not be verified.", true);
    const since = Math.max(last, ...tasks.map(task => timestamp(task.updatedAt)));
    const days = tasks.length ? snapshot.policy.deliveredDays : snapshot.policy.unlinkedDays;
    if (now - since < days * DAY) return keep(`Keep until ${days} days have passed since the latest activity or task update.`);
    return { ...row, disposition: "eligible" as const, reason: tasks.length
      ? `All linked tasks are delivered or closed; no activity or task update for at least ${days} days.`
      : `No linked task and inactive for at least ${days} days. Select manually only if this conversation is finished.` };
  }).sort((a, b) => a.title.localeCompare(b.title));
}
function fingerprint(snapshot: CleanupSnapshot, row: CleanupRow) {
  const family = familyOf(snapshot.agents, row.agentId);
  const ids = new Set(family.map(agent => agent.id));
  const linked = new Set(family.flatMap(agent => agent.labels?.["mission-control.task-id"] ? [agent.labels["mission-control.task-id"]] : []));
  const relevantTasks = snapshot.tasks.filter(task => linked.has(task.id) || task.agentIds.some(id => ids.has(id)) || task.workspaceIds.some(id => family.some(agent => agent.workspaceId === id)));
  const ordered = <T extends { id: string }>(items: T[]) => [...items].sort((a, b) => a.id.localeCompare(b.id));
  return createHash("sha256").update(JSON.stringify({ row, family: ordered(family), tasks: ordered(relevantTasks), policy: snapshot.policy,
    pendingAgents: snapshot.pendingAgentIds.filter(id => ids.has(id)).sort(), pendingTasks: snapshot.pendingTaskIds.filter(id => relevantTasks.some(task => task.id === id)).sort(),
    workspaces: ordered(snapshot.workspaces.filter(workspace => family.some(agent => agent.workspaceId === workspace.id))) })).digest("hex");
}

/** One engine per host. Previews are bounded, expiring, scope-bound and consumed before any writes. */
export function createAgentCleanupEngine(deps: {
  localServerId: () => Promise<string>; snapshot: (scope: CleanupScope) => Promise<CleanupSnapshot>;
  archive: (agentId: string, expectedFamily: CleanupAgent[]) => Promise<string[]>;
  record: (entry: CleanupHistory) => Promise<void>; now?: () => number;
}) {
  const clock = deps.now ?? Date.now;
  const plans = new Map<string, { scope: CleanupScope; scan: CleanupScan; fingerprints: Map<string, string> }>();
  let executing = false;
  async function local(scope: CleanupScope) {
    if (scope.serverId !== await deps.localServerId()) throw new Error("Cleanup must run on the selected agent's host.");
  }
  async function scan(scope: CleanupScope): Promise<CleanupScan> {
    await local(scope);
    const snapshot = await deps.snapshot(scope), now = clock();
    const rows = cleanupCandidates(snapshot, scope, now);
    for (const [id, plan] of plans) if (timestamp(plan.scan.expiresAt) <= now) plans.delete(id);
    while (plans.size >= 30) plans.delete(plans.keys().next().value!);
    const result: CleanupScan = { ...scope, scanId: randomUUID(), scannedAt: new Date(now).toISOString(), expiresAt: new Date(now + TTL).toISOString(),
      policy: snapshot.policy, rows, warnings: snapshot.warnings, mergedPullRequests: snapshot.mergedPullRequests.filter(pr => pr.workspaceId === scope.workspaceId) };
    plans.set(result.scanId, { scope: { ...scope }, scan: result, fingerprints: new Map(rows.map(row => [row.agentId, fingerprint(snapshot, row)])) });
    return result;
  }
  async function execute(input: CleanupScope & { scanId: string; agentIds: string[] }): Promise<{ results: AgentCleanupResult[] }> {
    await local(input);
    if (executing) throw new Error("Another agent cleanup is running on this host. Wait for its result.");
    const plan = plans.get(input.scanId);
    if (!plan || timestamp(plan.scan.expiresAt) <= clock()) throw new Error("This cleanup preview expired. Scan again; nothing was archived.");
    if (plan.scope.serverId !== input.serverId || plan.scope.workspaceId !== input.workspaceId || plan.scope.agentId !== input.agentId) throw new Error("Cleanup scope changed. Scan again.");
    const selected = [...new Set(input.agentIds)];
    if (!selected.length || selected.length > 100 || selected.some(id => !plan.scan.rows.some(row => row.agentId === id && row.disposition === "eligible"))) throw new Error("Select only eligible agents from this preview.");
    executing = true;
    plans.delete(input.scanId);
    const results: AgentCleanupResult[] = [];
    try {
      for (const id of selected) {
        const original = plan.scan.rows.find(row => row.agentId === id)!;
        const result: AgentCleanupResult = { agentId: id, title: original.title, outcome: "skipped", detail: "", archivedIds: [] };
        const record = (outcome: CleanupHistory["outcome"], detail: string) => deps.record({ ...result, outcome, detail, id: randomUUID(), at: new Date(clock()).toISOString(), serverId: input.serverId, workspaceId: input.workspaceId });
        try {
          const fresh = await deps.snapshot(plan.scope);
          const row = cleanupCandidates(fresh, plan.scope, clock()).find(item => item.agentId === id);
          if (!row || row.disposition !== "eligible" || fingerprint(fresh, row) !== plan.fingerprints.get(id)) {
            result.detail = row && row.disposition !== "eligible" ? row.reason : "The agent family or its records changed since the preview. Scan again.";
          } else {
            // Write an intent receipt before the archive. On uncertain delivery we never retry blindly.
            await record("started", "Archiving the confirmed agent family; check Paseo if the final receipt is missing.");
            result.archivedIds = await deps.archive(id, familyOf(fresh.agents, id));
            result.outcome = "archived";
            result.detail = `Archived ${result.archivedIds.length} agent(s). Workspaces, branches and task records were kept.`;
          }
        } catch (error) { result.outcome = "failed"; result.detail = message(error); }
        try { await record(result.outcome, result.detail); }
        catch { result.detail += " Cleanup history could not be saved; check Paseo before any retry."; }
        results.push(result);
      }
      return { results };
    } finally { executing = false; }
  }
  return { scan, execute };
}
