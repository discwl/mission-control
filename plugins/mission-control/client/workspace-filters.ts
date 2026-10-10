export type WorkspaceFilterItem = {
  projectId: string;
  projectName: string;
  name: string;
  labels: readonly string[];
};

export type WorkspaceFilterOptions = {
  search: string;
  /** An empty selection includes all projects. */
  projectIds: readonly string[];
  label: string;
};

export function filterWorkspaceEntries<T extends WorkspaceFilterItem>(
  workspaces: readonly T[],
  options: WorkspaceFilterOptions,
  matchesOtherFilters: (workspace: T) => boolean,
): T[] {
  const search = options.search.trim().toLowerCase();
  const label = options.label.toLowerCase();
  return workspaces.filter(workspace => {
    if (search && !`${workspace.name} ${workspace.projectName}`.toLowerCase().includes(search)) return false;
    if (options.projectIds.length && !options.projectIds.includes(workspace.projectId)) return false;
    if (label !== "all" && !workspace.labels.some(value => value.toLowerCase() === label)) return false;
    return matchesOtherFilters(workspace);
  });
}
