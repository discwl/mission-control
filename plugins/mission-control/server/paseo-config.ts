import { readFile, realpath } from "node:fs/promises";
import { join } from "node:path";
import type { PaseoApi } from "@getpaseo/client";
import { instructionsFromText, noInstructions, paseoConfigFile, type DeliveryInstructions, type PaseoInstructions } from "../shared/paseo-metadata";
import type { RunRecord } from "../shared/runs";
import { git } from "./merge";
import { handoffSummary, runRecordsOf } from "./runs";
import type { TaskSource } from "./tasks";
import { parseWorktreeList } from "./worktree";

type Place = { directory: string | null; where: NonNullable<PaseoInstructions["where"]> };

/**
 * A repository's paseo.json instructions, read only: from the first place that has a paseo.json. The task worktree
 * comes first, then the checkout it was made from, because an uncommitted paseo.json isn't copied into worktrees.
 * A paseo.json that can't be read or isn't JSON stops the search and is reported; its instructions aren't used.
 */
export async function readPaseoInstructions(places: readonly Place[]): Promise<PaseoInstructions> {
  for (const { directory, where } of places) {
    if (!directory) continue;
    const path = join(directory, paseoConfigFile);
    let text: string;
    try { text = await readFile(path, "utf8"); }
    catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "ENOENT" || code === "ENOTDIR") continue;
      return { ...noInstructions, path, where, problem: `${path} can't be read (${error instanceof Error ? error.message : String(error)}), so its instructions aren't used.` };
    }
    return instructionsFromText(text, path, where);
  }
  return noInstructions;
}

type Deps = {
  sources: (serverId: string) => Promise<TaskSource[]>;
  projectRoot: (projectId: string, paseo: PaseoApi) => Promise<string>;
  runs?: (source: TaskSource, serverId: string) => Promise<RunRecord[]>;
};

/** delivery.instructions and branch-names.guidance: what paseo.json asks for, and the only task facts a model is given. */
export function createPaseoInstructions(deps: Deps) {
  const readRuns = deps.runs ?? runRecordsOf;

  /** The task's worktree (where its branch is checked out) and the main checkout, from Git's own list. */
  async function taskPlaces(source: TaskSource, paseo: PaseoApi): Promise<Place[]> {
    const root = await realpath(await deps.projectRoot(source.task.projectId, paseo));
    const listed = await git(root, ["worktree", "list", "--porcelain"]);
    const worktrees = listed.code === 0 ? parseWorktreeList(listed.stdout) : [];
    const branch = source.task.worktree ? `refs/heads/${source.task.worktree.branch}` : null;
    const worktree = branch ? worktrees.find(item => item.branch === branch)?.path ?? null : null;
    return [{ directory: worktree, where: "worktree" }, { directory: worktrees[0]?.path ?? root, where: "source" }];
  }

  async function forTask(input: { serverId: string; taskId: string }, paseo: PaseoApi): Promise<DeliveryInstructions> {
    const source = (await deps.sources(input.serverId)).find(item => item.task.taskId === input.taskId);
    if (!source || !source.task.assignments.some(item => item.serverId === input.serverId)) throw new Error("This task isn't on this host.");
    const { task } = source;
    const [instructions, runs] = await Promise.all([taskPlaces(source, paseo).then(readPaseoInstructions), readRuns(source, input.serverId)]);
    return {
      instructions,
      title: task.title,
      ticket: task.ticket ? { key: task.ticket.key, url: task.ticket.url } : null,
      summary: await handoffSummary(source, runs[0]),
    };
  }

  /** Each Git project's paseo.json branch name guidance, from its checkout. */
  async function branchGuidance(paseo: Pick<PaseoApi, "projects">) {
    const projects = (await paseo.projects.list()).projects.filter(project => project.projectKind === "git");
    return {
      projects: await Promise.all(projects.map(async project => {
        const read = await realpath(project.projectRootPath)
          .then(directory => readPaseoInstructions([{ directory, where: "source" }]))
          .catch(error => ({ ...noInstructions, problem: `The project's folder can't be read: ${error instanceof Error ? error.message : String(error)}` }));
        return { projectId: project.projectId, guidance: read.branchName, path: read.path, problem: read.problem };
      })),
    };
  }

  return { forTask, branchGuidance };
}
