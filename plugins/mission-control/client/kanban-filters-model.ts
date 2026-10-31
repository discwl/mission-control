import type { FleetSnapshot } from "../shared/fleet";
import type { KanbanTask } from "./kanban-model";

export type KanbanScope = { hosts: string[]; projects: string[]; workspaces: string[] };
export type ScopeKind = keyof KanbanScope;
export type FilterOption = { id: string; label: string; detail: string; count: number };
export const emptyKanbanScope = (): KanbanScope => ({ hosts: [], projects: [], workspaces: [] });
export const scopeKey = (host: string, id: string | null) => JSON.stringify([host, id]);

/** Use saved task assignments, never a coordinator's chat workspace. */
export function taskWorkspaceKeys(item: KanbanTask): string[] {
  const ids = [...new Set(item.row.entry.task.assignments.filter(a => a.serverId === item.row.serverId).map(a => a.workspaceId))];
  return ids.length ? ids.map(id => scopeKey(item.row.serverId, id)) : [scopeKey(item.row.serverId, null)];
}
export function matchesKanbanScope(item: KanbanTask, scope: KanbanScope): boolean {
  return (!scope.hosts.length || scope.hosts.includes(item.row.serverId))
    && (!scope.projects.length || scope.projects.includes(scopeKey(item.row.serverId, item.row.entry.task.projectId)))
    && (!scope.workspaces.length || taskWorkspaceKeys(item).some(id => scope.workspaces.includes(id)));
}
/** Changing a parent clears its children; refresh never silently broadens a selection. */
export function changeKanbanScope(scope: KanbanScope, kind: ScopeKind, ids: string[]): KanbanScope {
  return kind === "hosts" ? { hosts: ids, projects: [], workspaces: [] }
    : kind === "projects" ? { ...scope, projects: ids, workspaces: [] } : { ...scope, workspaces: ids };
}
export function kanbanFilterOptions(tasks: KanbanTask[], hosts: FleetSnapshot["hosts"], scope: KanbanScope): Record<ScopeKind, FilterOption[]> {
  const hostOptions = hosts.map(host => ({ id: host.serverId, label: host.label,
    detail: host.error || !host.snapshot ? "Unavailable · counts may be incomplete" : !host.snapshot.complete ? "Partial snapshot" : tasks.some(item => item.row.serverId === host.serverId) ? "Managed tasks" : "No managed tasks returned · other work may exist",
    count: tasks.filter(item => item.row.serverId === host.serverId).length }));
  const projects = new Map<string, FilterOption>();
  const projectNames = new Map<string, Set<string>>();
  const workspaces = new Map<string, FilterOption>();
  for (const item of tasks) {
    const row = item.row;
    if (scope.hosts.length && !scope.hosts.includes(row.serverId)) continue;
    const project = scopeKey(row.serverId, row.entry.task.projectId);
    const option = projects.get(project) ?? { id: project, label: row.entry.task.projectId, detail: row.hostLabel, count: 0 };
    option.count++; projects.set(project, option);
    const names = projectNames.get(project) ?? new Set<string>();
    for (const assignment of row.entry.task.assignments.filter(a => a.serverId === row.serverId)) {
      const name = row.host.workspaces.find(w => w.id === assignment.workspaceId)?.projectName;
      if (name?.trim()) names.add(name);
    }
    projectNames.set(project, names);
    if (scope.projects.length && !scope.projects.includes(project)) continue;
    for (const id of taskWorkspaceKeys(item)) {
      const [, workspaceId] = JSON.parse(id) as [string, string | null];
      const workspace = row.host.workspaces.find(w => w.id === workspaceId);
      const entry = workspaces.get(id) ?? { id, label: workspace?.name ?? workspaceId ?? "No workspace assigned",
        detail: [row.hostLabel, workspace?.projectName ?? row.entry.task.projectId, workspace?.branch].filter(Boolean).join(" · "), count: 0 };
      entry.count++; workspaces.set(id, entry);
    }
  }
  for (const [id, names] of projectNames) {
    const option = projects.get(id)!;
    if (names.size === 1) option.label = [...names][0];
    else if (names.size > 1) option.detail += ` · ${[...names].sort().join(" / ")}`;
  }
  const sorted = (values: FilterOption[]) => values.sort((a, b) => a.label.localeCompare(b.label) || a.detail.localeCompare(b.detail) || a.id.localeCompare(b.id));
  return { hosts: sorted(hostOptions), projects: sorted([...projects.values()]), workspaces: sorted([...workspaces.values()]) };
}
export function searchFilterOptions(options: FilterOption[], query: string): FilterOption[] {
  const needle = query.trim().toLowerCase();
  return options.filter(option => !needle || `${option.label} ${option.detail}`.toLowerCase().includes(needle));
}
