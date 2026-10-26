import type { PaseoApi } from "@getpaseo/client";
import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import type { FleetCoordinator, FleetHost, FleetTask } from "../shared/fleet";
import { managedWorkerIds } from "../shared/fleet-model";
import { listTasks, type TaskRecord } from "../shared/tasks";
import { listTaskRuns } from "../shared/runs";
import { listDecisions } from "../shared/decisions";
import { listWaiting } from "../shared/questions";
import { fleetDirectory, toFleetAgent } from "./fleet-host";
import { hideSecrets } from "../shared/secret-mask";

export type FleetScope = { localServerId: string; coordinators: FleetCoordinator[] };
/** Read-only compatibility for already deployed Mission Control copies. Stop state is unknown. */
export async function readCompatibleFleet(paseo: PaseoApi, client: DaemonClient, serverId: string, scope: FleetScope): Promise<FleetHost> {
  const call = async <T>(contract: { name: string; output: { parse(value: unknown): T } }, input: unknown): Promise<T> => contract.output.parse(await client.invokePluginRpc("mission-control", contract.name, input));
  const [directory, decisions, questions] = await Promise.all([fleetDirectory(paseo, serverId), call(listDecisions, { serverId }), call(listWaiting, { serverId })]);
  const agents = directory.agents.map(toFleetAgent);
  const ids = new Set(scope.coordinators.flatMap(coordinator => [...managedWorkerIds(scope.localServerId, coordinator, agents)]));
  const workspaceIds = [...new Set([...agents.filter(agent => ids.has(agent.id) && agent.workspaceId).map(agent => agent.workspaceId!), ...scope.coordinators.flatMap(coordinator => coordinator.links.map(link => link.remoteWorkspaceId))])];
  const warnings = ["This host uses the previous Mission Control fleet API. Showing managed work through its existing APIs; update its plugin before enabling automatic dispatch. Manual stop history and older decision history are unavailable."];
  if (!directory.complete || workspaceIds.length > 20) warnings.push("Compatibility snapshot is truncated; narrow the managed work or update the host plugin.");
  const tasks = new Map<string, TaskRecord>();
  // Bound load on old hosts whose tasks.list rescans their vault.
  for (let index = 0; index < Math.min(workspaceIds.length, 20); index += 4) {
    const results = await Promise.all(workspaceIds.slice(index, Math.min(index + 4, 20)).map(workspaceId => call(listTasks, { serverId, workspaceId })));
    for (const result of results) { for (const task of result.tasks) tasks.set(task.taskId, task); for (const problem of result.problems) warnings.push(`${problem.file}: ${problem.problem}`); }
  }
  const entries: FleetTask[] = [];
  for (const task of [...tasks.values()].slice(0, 100)) {
    const workspaceId = task.worktree?.workspaceId || task.assignments.find(item => item.serverId === serverId)?.workspaceId;
    let run = null; let problem: string | null = null;
    try { if (workspaceId) run = (await call(listTaskRuns, { serverId, workspaceId, taskId: task.taskId })).runs[0] ?? null; }
    catch (error) { problem = hideSecrets(error instanceof Error ? error.message : String(error)); }
    entries.push({ task, run, problem, decisions: [...decisions.open, ...decisions.recent].filter(entry => entry.decision.taskId === task.taskId), questions: questions.questions.filter(entry => entry.question.taskId === task.taskId) });
  }
  if (tasks.size > 100) warnings.push("Only the first 100 task records were loaded.");
  return { serverId, observedAt: new Date().toISOString(), agents, tasks: entries, warnings, complete: false, stoppedAgentIds: [], workspaces: directory.workspaces.map(workspace => ({ id: workspace.id, name: workspace.title || workspace.name, projectName: workspace.projectCustomName || workspace.projectDisplayName, branch: workspace.gitRuntime?.currentBranch ?? null, labels: workspace.labels ?? [], status: workspace.status })) };
}
