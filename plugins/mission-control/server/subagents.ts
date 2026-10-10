import { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import { daemonServerId, daemonWsUrl } from "./agent-names";
import { mayQueryAgent, parseHelperList, parseHelperMessages, type Helper, type HelperMessage } from "../shared/subagents";

/** Raw daemon replies; the service parses them, so a changed reply shape hides helpers instead of failing. */
export type HelperSource = {
  // Each agent's current record from Paseo's agent lookup, which doesn't load (and so doesn't restart)
  // a stored agent: its reply, null when Paseo doesn't know it, or the error the request ended with.
  status(agentIds: string[]): Promise<Map<string, unknown>>;
  // One reply per parent, or the error that parent's request ended with.
  list(parentAgentIds: string[]): Promise<Map<string, unknown>>;
  messages(parentAgentId: string, helperId: string): Promise<unknown>;
};

type HelperDeps = { source?: HelperSource; localServerId?: () => Promise<string>; ttlMs?: number; now?: () => number };
type Listed = { available: boolean; helpers: Helper[] };

const requestTimeoutMs = 8_000;

/**
 * INTERNAL PASEO API: PaseoApi 0.9.1 can't list the helpers that run inside an agent's turn
 * (Claude Code's Agent tool), so this opens a short-lived DaemonClient to the local daemon, as
 * setAgentNameViaDaemon does. It may break when Paseo changes @getpaseo/client/internal/daemon-client;
 * the service then reports helpers as unavailable.
 */
async function withDaemon<T>(work: (client: DaemonClient) => Promise<T>): Promise<T> {
  const client = new DaemonClient({
    url: await daemonWsUrl(),
    clientId: `plugin-mission-control-subagents-${process.pid}`,
    clientType: "cli",
    connectTimeoutMs: 5_000,
    reconnect: { enabled: false },
  });
  try {
    await client.connect();
    return await work(client);
  } finally {
    await client.close().catch(() => {});
  }
}

export const daemonHelperSource: HelperSource = {
  status: agentIds => withDaemon(async client => {
    const replies = await Promise.all(agentIds.map(id => client.fetchAgent(id, { timeout: requestTimeoutMs }).catch((error: unknown) => error)));
    return new Map(agentIds.map((id, index) => [id, replies[index]]));
  }),
  list: parentAgentIds => withDaemon(async client => {
    if (typeof client.listProviderSubagents !== "function") throw new Error("This Paseo can't list helpers.");
    const replies = await Promise.all(parentAgentIds.map(id => client.listProviderSubagents(id, { timeout: requestTimeoutMs }).catch((error: unknown) => error)));
    return new Map(parentAgentIds.map((id, index) => [id, replies[index]]));
  }),
  messages: (parentAgentId, helperId) => withDaemon(async client => {
    if (typeof client.fetchProviderSubagentTimeline !== "function") throw new Error("This Paseo can't read helper messages.");
    return client.fetchProviderSubagentTimeline(parentAgentId, helperId, { direction: "tail", limit: 40, timeout: requestTimeoutMs });
  }),
};

/**
 * Whether the agent lookup's reply shows an agent that may be asked about now (mayQueryAgent). The
 * view's roster can be seconds old, so this is checked again just before listing helpers: listing a
 * stopped agent's helpers restarts it. Null means the lookup failed; false covers an agent Paseo no
 * longer knows, or one that has stopped.
 */
export function liveNow(reply: unknown): boolean | null {
  if (reply === null) return false;
  if (reply instanceof Error || !reply || typeof reply !== "object") return null;
  const agent = (reply as { agent?: unknown }).agent;
  if (!agent || typeof agent !== "object") return null;
  const { status, archivedAt, providerUnavailable } = agent as { status?: unknown; archivedAt?: unknown; providerUnavailable?: unknown };
  if (typeof status !== "string") return null;
  return mayQueryAgent({ status, archivedAt: typeof archivedAt === "string" ? archivedAt : null, providerUnavailable: providerUnavailable === true });
}

/**
 * Lists helpers for this host's agents. Each parent's list is cached for ttlMs, a failed read too,
 * so views refreshing together share one daemon request. Any failure means "unavailable", never an error.
 * Just before asking Paseo, each parent's current status is read again, and a parent that isn't live now
 * is skipped with no helpers, so a view's stale roster (after a daemon restart, or in a view without
 * live updates) can't restart a stopped agent.
 */
export function createHelperService({ source = daemonHelperSource, localServerId = daemonServerId, ttlMs = 10_000, now: nowMs = Date.now }: HelperDeps = {}) {
  // Null records a parent whose list couldn't be read.
  const cache = new Map<string, { at: number; helpers: Helper[] | null }>();
  const inFlight = new Map<string, Promise<void>>();

  async function isLocal(serverId: string) {
    try { return serverId === await localServerId(); } catch { return false; }
  }

  async function readLive(parentAgentIds: string[]): Promise<string[]> {
    let statuses: Map<string, unknown>;
    try { statuses = await source.status(parentAgentIds); }
    catch { statuses = new Map(); }
    const live: string[] = [];
    for (const id of parentAgentIds) {
      const state = liveNow(statuses.has(id) ? statuses.get(id) : new Error("No status"));
      if (state) live.push(id);
      // A stopped agent has no helpers to show; one whose status couldn't be read counts as unavailable.
      else cache.set(id, { at: nowMs(), helpers: state === false ? [] : null });
    }
    return live;
  }

  function fetchLists(parentAgentIds: string[]): Promise<void> {
    const batch = readLive(parentAgentIds).then(async live => {
      if (!live.length) return;
      try {
        const replies = await source.list(live);
        for (const id of live) cache.set(id, { at: nowMs(), helpers: parseHelperList(replies.get(id), id) });
      } catch {
        for (const id of live) cache.set(id, { at: nowMs(), helpers: null });
      }
    }).finally(() => { for (const id of parentAgentIds) inFlight.delete(id); });
    for (const id of parentAgentIds) inFlight.set(id, batch);
    return batch;
  }

  async function list({ serverId, parentAgentIds }: { serverId: string; parentAgentIds: string[] }): Promise<Listed> {
    const ids = [...new Set(parentAgentIds)];
    if (!ids.length || !await isLocal(serverId)) return { available: false, helpers: [] };
    const at = nowMs();
    for (const [id, entry] of cache) if (at - entry.at > ttlMs * 6) cache.delete(id);
    const stale = ids.filter(id => !inFlight.has(id) && !(at - (cache.get(id)?.at ?? -Infinity) < ttlMs));
    if (stale.length) void fetchLists(stale);
    await Promise.all(ids.map(id => inFlight.get(id)));
    const lists = ids.map(id => cache.get(id)?.helpers ?? null);
    // Unavailable only when no parent's list could be read: the daemon is unreachable or doesn't support helpers.
    if (lists.every(helpers => helpers === null)) return { available: false, helpers: [] };
    return { available: true, helpers: lists.flatMap(helpers => helpers ?? []) };
  }

  async function messages({ serverId, parentAgentId, helperId }: { serverId: string; parentAgentId: string; helperId: string }): Promise<{ available: boolean; messages: HelperMessage[] }> {
    if (!await isLocal(serverId)) return { available: false, messages: [] };
    try {
      const parsed = parseHelperMessages(await source.messages(parentAgentId, helperId));
      return parsed ? { available: true, messages: parsed } : { available: false, messages: [] };
    } catch {
      return { available: false, messages: [] };
    }
  }

  return { list, messages };
}
