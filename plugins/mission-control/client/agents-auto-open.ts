// Settings → Agents panel → "Open the Agents panel for each new workspace".
// Adapted from Agent Crew's client/auto-open.ts (MIT, Copyright (c) 2026 Omer Cohen); see THIRD_PARTY_NOTICES.md.
import { settingsRpc } from "@getpaseo/plugin";
import type { PluginClientContext } from "@getpaseo/plugin/client";
import { agentsPanelId, agentsPanelSettings, claimAgentsPanelWorkspaces, MAX_CLAIM_BATCH } from "../shared/agents-panel";

const FLUSH_DELAY_MS = 400;
const RETRY_DELAY_MS = 2000;
const SETTINGS_POLL_MS = 15_000;
const PAGE_LIMIT = 200;
const settingsCalls = settingsRpc(agentsPanelSettings.id);

async function knownWorkspaceIds(paseo: PluginClientContext["paseo"]): Promise<Set<string>> {
  const ids = new Set<string>();
  const cursors = new Set<string>();
  let cursor: string | undefined;
  for (;;) {
    const page = await paseo.workspaces.list({ page: { limit: PAGE_LIMIT, ...(cursor ? { cursor } : {}) } });
    for (const workspace of page.entries) ids.add(workspace.id);
    const next = page.pageInfo.hasMore ? page.pageInfo.nextCursor ?? undefined : undefined;
    if (!next || cursors.has(next)) return ids;
    cursors.add(next);
    cursor = next;
  }
}

/**
 * Watches for new workspaces and opens the Agents panel once for each. Workspaces that existed when
 * watching began are left alone. The server records each opened workspace, so reloads and other
 * windows don't open it again. A failed claim is retried once after two seconds, then dropped.
 */
function watchNewWorkspaces(client: PluginClientContext): () => void {
  const pending = new Set<string>();
  const early = new Set<string>();
  const jobs: { ids: string[]; retried: boolean }[] = [];
  let known: Set<string> | null = null;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let release: (() => void) | undefined;
  let pumping = false;
  let closed = false;

  function schedule(delay: number) {
    if (closed || pumping || timer) return;
    timer = setTimeout(() => { timer = undefined; void pump(); }, delay);
  }

  function observe(workspaceId: string) {
    if (!known) { early.add(workspaceId); return; }
    if (known.has(workspaceId)) return;
    known.add(workspaceId);
    pending.add(workspaceId);
    schedule(FLUSH_DELAY_MS);
  }

  async function pump() {
    if (closed || pumping) return;
    pumping = true;
    const ids = [...pending];
    pending.clear();
    for (let index = 0; index < ids.length; index += MAX_CLAIM_BATCH) jobs.push({ ids: ids.slice(index, index + MAX_CLAIM_BATCH), retried: false });
    while (!closed && jobs.length) {
      const job = jobs.shift()!;
      try {
        const { claimed } = await client.rpc(claimAgentsPanelWorkspaces, { workspaceIds: job.ids });
        for (const workspaceId of claimed) {
          try { client.openPanel(agentsPanelId, { workspaceId, location: "explorer" }); }
          catch (error) { console.error(`Mission Control couldn't open the Agents panel for workspace ${workspaceId}`, error); }
        }
      } catch (error) {
        console.error("Mission Control's Agents panel auto-open claim failed", error);
        if (!job.retried) {
          jobs.unshift({ ...job, retried: true });
          pumping = false;
          schedule(RETRY_DELAY_MS);
          return;
        }
      }
    }
    pumping = false;
    if (!closed && pending.size) schedule(FLUSH_DELAY_MS);
  }

  void client.paseo.workspaces.list({ subscribe: {} }).then(({ subscription }) => {
    if (closed) { void subscription.release().catch(() => {}); return; }
    const remove = subscription.subscribe({
      snapshot() {},
      update(message) {
        if (message.type === "workspace_update" && message.payload.kind === "upsert") observe(message.payload.workspace.id);
      },
    });
    release = () => { remove(); void subscription.release().catch(() => {}); };
    return knownWorkspaceIds(client.paseo).then(ids => {
      if (closed) return;
      known = ids;
      for (const id of early) observe(id);
      early.clear();
    });
  }).catch((error: unknown) => { if (!closed) console.error("Mission Control's Agents panel auto-open couldn't watch workspaces", error); });

  return () => {
    closed = true;
    pending.clear();
    early.clear();
    jobs.length = 0;
    clearTimeout(timer);
    release?.();
  };
}

/** Follows the setting: watches while it is on, and stops queued and future opens when it is turned off. */
export function startAgentsAutoOpen(client: PluginClientContext) {
  let enabled = false;
  let stop: (() => void) | undefined;
  let disposed = false;
  let reading = false;
  let generation = 0;

  function apply(next: boolean) {
    if (disposed || next === enabled) return;
    enabled = next;
    stop?.();
    stop = enabled ? watchNewWorkspaces(client) : undefined;
  }

  async function refresh() {
    if (disposed || reading) return;
    reading = true;
    const asked = generation;
    try {
      const result = await client.rpc(settingsCalls.read, {});
      if (disposed || asked !== generation) return;
      const parsed = result.status === "ready" ? agentsPanelSettings.schema.safeParse(result.values) : null;
      apply(parsed?.success ? parsed.data.autoOpen : false);
    } catch (error) {
      if (!disposed && asked === generation) { console.error("Mission Control couldn't read the Agents panel settings", error); apply(false); }
    } finally {
      reading = false;
    }
  }

  const poll = setInterval(() => void refresh(), SETTINGS_POLL_MS);
  void refresh();
  return {
    // The settings screen reports a saved change at once, rather than on the next poll.
    setEnabled(next: boolean) { generation++; apply(next); },
    dispose() { disposed = true; generation++; clearInterval(poll); stop?.(); stop = undefined; },
  };
}
