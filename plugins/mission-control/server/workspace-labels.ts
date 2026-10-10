import { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { TaskRecord } from "../shared/tasks";
import {
  desiredWorkspaceStatuses, PAUSED_LABEL, workspaceStatusChanges, workspaceStatuses, workspaceStatusLabels,
  type StatusAgent, type WorkspaceLabelColor, type WorkspaceStatus,
} from "../shared/workspace-status";
import { daemonServerId, daemonWsUrl } from "./agent-names";

/** The calls the sync needs from a daemon connection. */
export type LabelClient = {
  listLabels(): Promise<{ name: string; color: WorkspaceLabelColor }[]>;
  /** Each active workspace's current label names. */
  activeWorkspaces(): Promise<Map<string, string[]>>;
  agents(): Promise<StatusAgent[]>;
  setLabel(workspaceId: string, label: { name: string; color: WorkspaceLabelColor }, assigned: boolean): Promise<void>;
  close(): Promise<void>;
};

export type WorkspaceLabelSyncDeps = {
  connect(): Promise<LabelClient>;
  serverId(): Promise<string>;
  tasks(serverId: string): Promise<TaskRecord[]>;
  readApplied(): Promise<Record<string, WorkspaceStatus | null>>;
  writeApplied(applied: Record<string, WorkspaceStatus | null>): Promise<void>;
  log(message: string): void;
};

export type SyncResult = { changed: number; failed: number } | { skipped: "running" | "unsupported" };

const sameName = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase();

/** A daemon too old for workspace labels rejects the request type; there's nothing to sync on that host. */
const unsupported = (error: unknown) => /unknown|unsupported|not supported|invalid message|unrecognized/i.test(error instanceof Error ? error.message : String(error));

export function createWorkspaceLabelSync(deps: WorkspaceLabelSyncDeps) {
  let running: Promise<SyncResult> | null = null;
  let disabled = false;

  async function run(): Promise<SyncResult> {
    const client = await deps.connect();
    try {
      let defined: { name: string; color: WorkspaceLabelColor }[];
      try { defined = await client.listLabels(); } catch (error) {
        if (!unsupported(error)) throw error;
        disabled = true;
        deps.log(`Workspace status labels are off: this Paseo version has no workspace labels (${error instanceof Error ? error.message : error}).`);
        return { skipped: "unsupported" };
      }
      const serverId = await deps.serverId();
      const [tasks, agents, active, applied] = await Promise.all([deps.tasks(serverId), client.agents(), client.activeWorkspaces(), deps.readApplied()]);
      const desired = desiredWorkspaceStatuses({ serverId, tasks, agents });
      for (const [workspaceId, { from }] of desired) {
        const labels = active.get(workspaceId);
        if (!labels || (from === "task" && labels.some(name => sameName(name, PAUSED_LABEL)))) desired.delete(workspaceId);
      }
      // Reuse a label's existing color, so a label the user recolored keeps its color.
      const label = (status: WorkspaceStatus) => {
        const wanted = workspaceStatusLabels[status];
        return defined.find(entry => sameName(entry.name, wanted.name)) ?? wanted;
      };
      const next = { ...applied };
      let changed = 0, failed = 0;
      for (const { workspaceId, status } of workspaceStatusChanges(desired, applied)) {
        try {
          // Clear the other status labels first, so the workspace never shows two.
          for (const other of workspaceStatuses) if (other !== status) await client.setLabel(workspaceId, label(other), false);
          if (status) await client.setLabel(workspaceId, label(status), true);
          next[workspaceId] = status;
          changed++;
        } catch (error) {
          failed++;
          deps.log(`Couldn't set ${workspaceId}'s status label: ${error instanceof Error ? error.message : error}`);
        }
      }
      // Forget workspaces that are gone, so the record doesn't grow forever.
      for (const workspaceId of Object.keys(next)) if (!active.has(workspaceId)) delete next[workspaceId];
      if (changed || Object.keys(next).length !== Object.keys(applied).length) await deps.writeApplied(next);
      return { changed, failed };
    } finally {
      await client.close().catch(() => {});
    }
  }

  return {
    /** Brings every workspace's status label up to date. Overlapping calls share one run. */
    sync(): Promise<SyncResult> {
      if (disabled) return Promise.resolve({ skipped: "unsupported" });
      if (running) return running.then(() => ({ skipped: "running" as const }));
      running = run().finally(() => { running = null; });
      return running;
    },
  };
}

const paseoHome = () => process.env.PASEO_HOME?.trim() || join(homedir(), ".paseo");

/** <PASEO_HOME>/plugin-data/mission-control/workspace-status-labels.json: the status Mission Control last set on each workspace. */
export function appliedStatusFile(home = paseoHome()) {
  return join(home, "plugin-data", "mission-control", "workspace-status-labels.json");
}

export async function readAppliedStatuses(file = appliedStatusFile()): Promise<Record<string, WorkspaceStatus | null>> {
  try {
    const parsed = JSON.parse(await readFile(file, "utf8"));
    const entries = Object.entries(parsed?.workspaces ?? {}).filter(([, value]) => value === null || (workspaceStatuses as readonly unknown[]).includes(value));
    return Object.fromEntries(entries) as Record<string, WorkspaceStatus | null>;
  } catch { return {}; }
}

export async function writeAppliedStatuses(applied: Record<string, WorkspaceStatus | null>, file = appliedStatusFile()) {
  await mkdir(dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify({ version: 1, workspaces: applied }, null, 2)}\n`);
  await rename(temporary, file);
}

/**
 * INTERNAL PASEO API: PaseoApi 0.9.1 has no workspace labels, so this opens a short-lived DaemonClient against the
 * local daemon, like the agent rename does. It may break when Paseo changes @getpaseo/client/internal/daemon-client.
 */
export async function connectLabelClient(): Promise<LabelClient> {
  const client = new DaemonClient({
    url: await daemonWsUrl(),
    clientId: `plugin-mission-control-labels-${process.pid}`,
    clientType: "cli",
    connectTimeoutMs: 5_000,
    reconnect: { enabled: false },
  });
  await client.connect();
  return {
    listLabels: async () => (await client.listWorkspaceLabels()).labels,
    async activeWorkspaces() {
      const workspaces = new Map<string, string[]>();
      let cursor: string | undefined;
      do {
        const page = await client.fetchWorkspaces({ page: { limit: 200, ...(cursor ? { cursor } : {}) } });
        for (const entry of page.entries) workspaces.set(entry.id, entry.labels ?? []);
        cursor = page.pageInfo.nextCursor ?? undefined;
      } while (cursor);
      return workspaces;
    },
    async agents() {
      const agents: StatusAgent[] = [];
      let cursor: string | undefined;
      do {
        const page = await client.fetchAgents({ page: { limit: 200, ...(cursor ? { cursor } : {}) } });
        for (const { agent } of page.entries) if (!agent.archivedAt) agents.push({ workspaceId: agent.workspaceId ?? null, status: agent.status, updatedAt: agent.updatedAt, labels: agent.labels });
        cursor = page.pageInfo.nextCursor ?? undefined;
      } while (cursor);
      return agents;
    },
    async setLabel(workspaceId, label, assigned) { await client.setWorkspaceLabel({ workspaceId, label, assigned }); },
    close: () => client.close(),
  };
}

const SYNC_EVERY_MS = 60_000;

/**
 * Keeps this host's workspace status labels in sync: shortly after start, every minute, and when `poke` is called
 * after a task changes. Returns the stop function.
 */
export function startWorkspaceLabelSync(tasks: (serverId: string) => Promise<TaskRecord[]>) {
  const sync = localWorkspaceLabelSync(tasks);
  let lastProblem = "";
  const tick = () => void sync.sync().then(() => { lastProblem = ""; }, error => {
    // The daemon may still be starting; say so once, not every minute.
    const problem = error instanceof Error ? error.message : String(error);
    if (problem !== lastProblem) console.warn(`[mission-control] Workspace status labels: ${problem}`);
    lastProblem = problem;
  });
  const first = setTimeout(tick, 15_000);
  const every = setInterval(tick, SYNC_EVERY_MS);
  first.unref?.(); every.unref?.();
  return { poke: tick, stop: () => { clearTimeout(first); clearInterval(every); } };
}

/** The sync wired to this host's daemon, task records and plugin data. */
export function localWorkspaceLabelSync(tasks: (serverId: string) => Promise<TaskRecord[]>) {
  return createWorkspaceLabelSync({
    connect: connectLabelClient,
    serverId: () => daemonServerId(),
    tasks: serverId => tasks(serverId).catch(() => []),
    readApplied: () => readAppliedStatuses(),
    writeApplied: applied => writeAppliedStatuses(applied),
    log: message => console.warn(`[mission-control] ${message}`),
  });
}
