import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { PaseoApi, PaseoWorkspace } from "@getpaseo/client";
import type { PluginServerContext } from "@getpaseo/plugin/server";
import { listIncludingBackground, ownHost } from "../shared/background";
import { getHostIdentity, getOrchestratorBindings, ORCHESTRATOR_HOST_FILE, parseOrchestratorHostFile, type OrchestratorBinding } from "../shared/orchestrator";
import { daemonServerId } from "./agent-names";

type WorkspaceReader = Pick<PaseoApi, "workspaces">;
/** What a binding needs from a workspace, as Paseo lists it. */
export type WorkspaceRecord = Pick<PaseoWorkspace, "id"> & Partial<Pick<PaseoWorkspace, "workspaceDirectory" | "projectRootPath" | "archivingAt">>;

const MAX_LISTED_PAGES = 10;

/**
 * The records for these workspace IDs. A single ID is looked up directly, and one that can't be read is left unbound.
 * Several share one paged listing, because each direct lookup pages through the host's whole workspace directory to
 * find its one workspace. A failed listing is passed on rather than leaving them all unbound, so a caller can keep
 * what it last knew. Any not reached within the page limit are looked up directly, as before.
 */
async function workspaceRecords(paseo: WorkspaceReader, ids: readonly string[]): Promise<WorkspaceRecord[]> {
  const direct = async (id: string): Promise<WorkspaceRecord[]> => {
    const workspace = await paseo.workspaces.ref(id).refresh().catch(() => null);
    return workspace ? [{ ...workspace, id }] : [];
  };
  if (ids.length <= 1) return ids.length ? direct(ids[0]) : [];
  const wanted = new Set(ids);
  const found: WorkspaceRecord[] = [];
  let cursor: string | undefined;
  for (let page = 0; page < MAX_LISTED_PAGES && wanted.size; page++) {
    const result = await listIncludingBackground(ownHost, {}, filter => paseo.workspaces.list({ filter, page: { limit: 200, ...(cursor ? { cursor } : {}) } }));
    for (const entry of result.entries) if (wanted.delete(entry.id)) found.push(entry);
    // Listed to the end: the rest don't exist.
    if (!result.pageInfo.hasMore) return found;
    cursor = result.pageInfo.nextCursor ?? undefined;
    if (!cursor) break;
  }
  return [...found, ...(await Promise.all([...wanted].map(direct))).flat()];
}

/**
 * The remote host each of these workspaces orchestrates, read from the host file in the workspace's
 * folder. Unknown, archived and unbound workspaces are left out; unreadable files become problems.
 * Pass workspace records the caller already listed to skip the lookup; IDs are looked up.
 */
export async function readOrchestratorBindings(paseo: WorkspaceReader, workspaces: readonly (string | WorkspaceRecord)[], deps: {
  localServerId: () => Promise<string>;
  readText?: (path: string) => Promise<string>;
}) {
  const readText = deps.readText ?? (path => readFile(path, "utf8"));
  const bindings: Record<string, OrchestratorBinding> = {};
  const problems: Record<string, string> = {};
  const local = await deps.localServerId();
  const records = new Map<string, WorkspaceRecord>();
  for (const item of workspaces) if (typeof item !== "string") records.set(item.id, item);
  const ids = [...new Set(workspaces.filter((item): item is string => typeof item === "string" && !records.has(item)))];
  for (const record of await workspaceRecords(paseo, ids)) records.set(record.id, record);
  await Promise.all([...records.entries()].map(async ([workspaceId, workspace]) => {
    if (workspace.archivingAt) return;
    const directory = workspace.workspaceDirectory || workspace.projectRootPath;
    if (!directory) return;
    let text: string;
    try {
      text = await readText(join(directory, ORCHESTRATOR_HOST_FILE));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") problems[workspaceId] = `${ORCHESTRATOR_HOST_FILE} can't be read: ${error instanceof Error ? error.message : String(error)}`;
      return;
    }
    const result = parseOrchestratorHostFile(text, local);
    if (!result) return;
    if ("binding" in result) bindings[workspaceId] = result.binding;
    else problems[workspaceId] = result.problem;
  }));
  return { bindings, problems };
}

export function registerOrchestrator(server: PluginServerContext) {
  server.handle(getOrchestratorBindings, ({ workspaceIds }, { paseo }) => readOrchestratorBindings(paseo, workspaceIds, { localServerId: () => daemonServerId() }));
  server.handle(getHostIdentity, async () => ({ serverId: await daemonServerId() }));
}
