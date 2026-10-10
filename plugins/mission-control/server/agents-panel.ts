// The Agents panel's server side: the once-per-workspace auto-open record, and each agent's latest run.
// The claim store is adapted from Agent Crew's server/auto-open.ts (MIT, Copyright (c) 2026 Omer Cohen);
// see THIRD_PARTY_NOTICES.md.
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { latestRunByAgent, unclaimedWorkspaces, type AgentRun } from "../shared/agents-panel";
import type { RunRecord } from "../shared/runs";
import type { TaskSource } from "./tasks";

export type ClaimStore = { load(): Promise<ReadonlySet<string>>; save(ids: ReadonlySet<string>): Promise<void> };

export function defaultClaimsFile() {
  const paseoHome = process.env.PASEO_HOME?.trim() || join(homedir(), ".paseo");
  return join(paseoHome, "plugin-data", "mission-control", "agents-auto-open.json");
}

/** Workspace IDs in a JSON array file; a missing file is an empty set, anything else malformed is an error. */
export function fileClaimStore(file = defaultClaimsFile()): ClaimStore {
  return {
    async load() {
      let raw: string;
      try { raw = await readFile(file, "utf8"); }
      catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return new Set(); throw error; }
      const parsed: unknown = JSON.parse(raw);
      if (!Array.isArray(parsed) || parsed.some(id => typeof id !== "string" || !id)) throw new Error(`${file} must hold an array of workspace IDs.`);
      return new Set(parsed as string[]);
    },
    async save(ids) {
      await mkdir(dirname(file), { recursive: true });
      const temporary = `${file}.${process.pid}.tmp`;
      await writeFile(temporary, `${JSON.stringify([...ids], null, 2)}\n`, "utf8");
      await rename(temporary, file);
    },
  };
}

/** Claims run one at a time, so two views can't both open the panel for the same new workspace. */
export function createClaimHandler(store: ClaimStore = fileClaimStore()) {
  let chain: Promise<unknown> = Promise.resolve();
  return ({ workspaceIds }: { workspaceIds: string[] }): Promise<{ claimed: string[] }> => {
    const run = async () => {
      const opened = await store.load();
      const claimed = unclaimedWorkspaces(opened, workspaceIds);
      if (claimed.length) await store.save(new Set([...opened, ...claimed]));
      return { claimed };
    };
    const result = chain.then(run, run);
    chain = result.catch(() => {});
    return result;
  };
}

/** Each agent's newest run across this host's tasks. A task whose runs can't be read is skipped. */
export async function agentRuns(sources: readonly TaskSource[], runsOf: (source: TaskSource) => Promise<RunRecord[]>): Promise<Record<string, AgentRun>> {
  const lists = await Promise.all(sources.map(source => runsOf(source).catch(() => [] as RunRecord[])));
  return latestRunByAgent(lists.flat().map(run => ({
    agentId: run.agentId, taskId: run.taskId, stage: run.stage, outcome: run.outcome, nextAction: run.nextAction, updatedAt: run.updatedAt,
  })));
}
