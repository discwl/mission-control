import type { PluginServerContext } from "@getpaseo/plugin/server";
import { branchNameSettings, templateBranch } from "../shared/branch-names";
import type { BranchPreview } from "../shared/launch";
import type { TaskRecord } from "../shared/tasks";
import { taskSources } from "./tasks";
import { taskBranchName, templatedBranchConflict } from "./worktree";

/**
 * The branch a task's first start in its own worktree creates: the template's name (one per type when
 * the user picks feature or bugfix), else task/<id>-<slug>. `taken` maps branches other tasks of the
 * same project already record to those tasks' titles.
 */
export function branchPreview(task: Pick<TaskRecord, "taskId" | "title" | "ticket">, template: string | undefined, taken: ReadonlyMap<string, string>): BranchPreview {
  const planned = templateBranch(task, template);
  if (planned.kind === "default") {
    return {
      source: "default", problem: null, options: [{ type: null, name: taskBranchName(task).branch, problem: null }],
      note: planned.reason === "no-ticket" ? "This task has no ticket, so it keeps Mission Control's task/… name." : null,
    };
  }
  const type = planned.typeFromTicket ? planned.options[0].type : null;
  return {
    source: "template", problem: null,
    note: type ? `${type === "bugfix" ? "Bugfix" : "Feature"}, from the ticket's type (${task.ticket?.type}).` : null,
    options: planned.options.map(option => {
      const owner = taken.get(option.name);
      return { ...option, problem: option.problem ?? (owner !== undefined ? `The task "${owner}" already uses this branch.` : null) };
    }),
  };
}

/** Registers the branch-name settings; `preview` feeds Start task and the worktree it creates. */
export function registerBranchNames(server: Pick<PluginServerContext, "registerSettings">, sources: typeof taskSources = taskSources) {
  const settings = server.registerSettings(branchNameSettings);
  async function templateFor(projectId: string) {
    const current = await settings.read();
    if (current.status !== "ready") throw new Error(`Mission Control's branch name settings can't be read: ${current.error}`);
    return current.values.projects[projectId]?.trim() || current.values.template.trim() || undefined;
  }
  /** `sourceCwd` is the checkout the worktree would branch from; Git's own branches there are checked too. */
  async function preview(task: TaskRecord, serverId: string, sourceCwd: string): Promise<BranchPreview> {
    const taken = new Map<string, string>();
    for (const source of await sources(serverId)) {
      const other = source.task;
      if (other.taskId !== task.taskId && other.projectId === task.projectId && other.worktree) taken.set(other.worktree.branch, other.title);
    }
    const planned = branchPreview(task, await templateFor(task.projectId), taken);
    if (planned.source !== "template") return planned;
    const options = [];
    for (const option of planned.options) options.push({ ...option, problem: option.problem ?? await templatedBranchConflict(sourceCwd, task, option.name) });
    return { ...planned, options };
  }
  return { preview };
}
