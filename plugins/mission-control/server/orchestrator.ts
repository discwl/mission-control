import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { PaseoApi } from "@getpaseo/client";
import type { PluginServerContext } from "@getpaseo/plugin/server";
import { getHostIdentity, getOrchestratorBindings, ORCHESTRATOR_HOST_FILE, parseOrchestratorHostFile, type OrchestratorBinding } from "../shared/orchestrator";
import { daemonServerId } from "./agent-names";

type WorkspaceReader = Pick<PaseoApi, "workspaces">;

/**
 * The remote host each of these workspaces orchestrates, read from the host file in the workspace's
 * folder. Unknown, archived and unbound workspaces are left out; unreadable files become problems.
 */
export async function readOrchestratorBindings(paseo: WorkspaceReader, workspaceIds: readonly string[], deps: {
  localServerId: () => Promise<string>;
  readText?: (path: string) => Promise<string>;
}) {
  const readText = deps.readText ?? (path => readFile(path, "utf8"));
  const bindings: Record<string, OrchestratorBinding> = {};
  const problems: Record<string, string> = {};
  const local = await deps.localServerId();
  await Promise.all([...new Set(workspaceIds)].map(async workspaceId => {
    const workspace = await paseo.workspaces.ref(workspaceId).refresh().catch(() => null);
    if (!workspace || workspace.archivingAt) return;
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
