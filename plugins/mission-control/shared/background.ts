// Paseo 0.12 leaves background workspaces, and every agent in them, out of agent and workspace lists unless the
// filter sets includeBackground. Hosts before 0.12 don't know the field and drop it. A 0.12 client refuses it for
// an older host instead ("Update the host to use background workspaces."), so that host is asked again without
// it, and not asked with it for the next ten minutes.

const retryAfterMs = 10 * 60_000;
const refusedAt = new Map<string, number>();

/** The refusal key for lists through the installation's own host: the client's `paseo`, or a handler's. */
export const ownHost = "own-host";

/**
 * The order agent lists are paged in. An agent's creation time never changes, so between pages no agent can move past
 * the cursor and be skipped or listed twice. Paseo 0.12 pages its own agent lists this way.
 */
export const agentPageOrder: { key: "created_at"; direction: "desc" }[] = [{ key: "created_at", direction: "desc" }];

export function refusesBackground(error: unknown): boolean {
  return /update the host to use background workspaces/i.test(error instanceof Error ? error.message : String(error));
}

/**
 * Runs one list call with `filter` plus includeBackground, or with `filter` alone for a host that refuses the field.
 * `host` keys the refusal: a server ID, or any fixed name for the installation's own host.
 */
export async function listIncludingBackground<Filter extends object, Result>(host: string, filter: Filter, list: (filter: Filter) => Promise<Result>, now: () => number = Date.now): Promise<Result> {
  const refused = refusedAt.get(host);
  if (refused !== undefined && now() - refused < retryAfterMs) return list(filter);
  // Filter is generic, so the added field needs the cast.
  try { return await list({ ...filter, includeBackground: true } as Filter); }
  catch (error) {
    if (!refusesBackground(error)) throw error;
    refusedAt.set(host, now());
    return list(filter);
  }
}

type AgentPage<Entry> = { entries: Entry[]; pageInfo?: { hasMore?: boolean; nextCursor?: string | null } | null };

/**
 * Reads an agent list page by page, newest first (pass agentPageOrder as the sort), up to `maxPages` pages, each through
 * listIncludingBackground. `hasMore` says the cap cut the list short.
 */
export async function listAgentPages<Filter extends object, Entry>(host: string, filter: Filter, list: (filter: Filter, cursor: string | undefined) => Promise<AgentPage<Entry>>, maxPages = 5): Promise<{ entries: Entry[]; hasMore: boolean }> {
  const entries: Entry[] = [];
  let cursor: string | undefined;
  for (let page = 0; page < maxPages; page++) {
    const result = await listIncludingBackground(host, filter, next => list(next, cursor));
    entries.push(...result.entries);
    cursor = result.pageInfo?.hasMore ? result.pageInfo.nextCursor ?? undefined : undefined;
    if (!cursor) return { entries, hasMore: false };
  }
  return { entries, hasMore: true };
}

/** One change from an agent list subscription: an agent added or changed, an agent gone, or a fresh snapshot (`null`). */
export type AgentListChange = { kind: "upsert"; agent: { id: string; workspaceId?: string | null; archivedAt?: string | null; status?: string; updatedAt?: string | null } } | { kind: "remove"; agentId: string } | null;

type AgentListSubscription = { subscribe(observer: { snapshot(snapshot: unknown): void; update(message: unknown): void }): () => void; release(): Promise<void> };

function readAgentUpdate(message: unknown): AgentListChange | undefined {
  const update = message as { type?: unknown; payload?: { kind?: unknown; agent?: { id?: unknown }; agentId?: unknown } } | null;
  if (update?.type !== "agent_update" || !update.payload) return undefined;
  const { kind, agent, agentId } = update.payload;
  if (kind === "upsert" && agent && typeof agent.id === "string") return { kind, agent: agent as Extract<AgentListChange, { kind: "upsert" }>["agent"] };
  if (kind === "remove" && typeof agentId === "string") return { kind, agentId };
  return undefined;
}

/**
 * Follows a host's agent list through Paseo's list subscription (one per caller, no per-agent subscriptions) and passes
 * each change on. A client or host without list subscriptions passes nothing, so callers keep a poll as the backstop.
 * Returns the stop function.
 */
export function watchAgentList<Filter extends object>(host: string, subscribe: (filter: Filter) => Promise<{ subscription?: AgentListSubscription | null }>, changed: (change: AgentListChange) => void): () => void {
  let stopped = false;
  let cleanup = () => {};
  void listIncludingBackground(host, {} as Filter, subscribe).then(({ subscription }) => {
    if (!subscription) return;
    if (stopped) { void subscription.release().catch(() => {}); return; }
    const remove = subscription.subscribe({
      snapshot: () => changed(null),
      update: message => { const change = readAgentUpdate(message); if (change !== undefined) changed(change); },
    });
    cleanup = () => { remove(); void subscription.release().catch(() => {}); };
  }).catch(() => { /* The poll still runs. */ });
  return () => { stopped = true; cleanup(); };
}

// A chat Paseo released after an idle hour (status "closed") still exists, and a message wakes it, so it keeps its chat
// buttons; one that has rested this long doesn't. Paseo's button store copies every registration and notifies every
// listener on each change, so hundreds of long-idle chats with buttons would make every change slow.
export const chatButtonWindowMs = 14 * 24 * 60 * 60_000;

/** Whether an unarchived chat keeps its chat buttons: it isn't resting, or it rested only recently. */
export function keepsChatButtons(agent: { status?: string; updatedAt?: string | null }, now = Date.now()): boolean {
  if (agent.status !== "closed") return true;
  const updated = agent.updatedAt ? Date.parse(agent.updatedAt) : NaN;
  return Number.isFinite(updated) && now - updated < chatButtonWindowMs;
}

/**
 * Calls `resync` shortly after the installation's own agent list changes in a way that matters to `known`: the chats
 * the caller has buttons on, by agent ID to workspace ID (undefined for none). A chat gaining or losing its claim to
 * buttons matters (a new chat, a move, an archive, a removal, or, with `include`, a long-resting chat woken by a
 * message); other status changes, which come often while a chat works, don't. Changes within `delayMs` share one call.
 * The first snapshot is the caller's own first read; a later one (after a reconnect) counts. A chat the caller still
 * leaves out after a resync (past its cap, or an orchestrator chat) doesn't ask again until it changes again.
 */
export function followAgentList<Filter extends object>(subscribe: (filter: Filter) => Promise<{ subscription?: AgentListSubscription | null }>, known: (agentId: string) => string | undefined, resync: () => void, options: { delayMs?: number; include?: (agent: Extract<AgentListChange, { kind: "upsert" }>["agent"]) => boolean } = {}): () => void {
  const { delayMs = 500, include = () => true } = options;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let snapshots = 0;
  let stopped = false;
  const asked = new Map<string, string | undefined>();
  const soon = () => {
    if (stopped || timer !== undefined) return;
    timer = setTimeout(() => { timer = undefined; if (!stopped) resync(); }, delayMs);
  };
  const stopWatching = watchAgentList(ownHost, subscribe, change => {
    if (change === null) { if (snapshots++) soon(); return; }
    const id = change.kind === "remove" ? change.agentId : change.agent.id;
    const was = known(id);
    const now = change.kind === "upsert" && change.agent.workspaceId && !change.agent.archivedAt && include(change.agent) ? change.agent.workspaceId : undefined;
    if (now === was) { asked.delete(id); return; }
    if (asked.has(id) && asked.get(id) === now) return;
    asked.set(id, now);
    soon();
  });
  return () => { stopped = true; clearTimeout(timer); stopWatching(); };
}
