import type { PaseoApi } from "@getpaseo/client";
import type { DecisionEntry } from "../shared/decisions";
import type { QuestionEntry } from "../shared/questions";
import { needsYouTimelineKind, type NeedsYouTimeline } from "../shared/needs-you-timeline";

// After a daemon restart Paseo lists an idle agent but doesn't load it until someone opens it, and appending to its
// chat fails ("Unknown agent") until then. A row that failed is tried again after a growing wait instead of on every
// poll, and the same failure is logged once.
const firstRetryMs = 60_000;
const longestRetryMs = 30 * 60_000;

/** Reconciled by the always-on Mission header poll, even when Attention has never been opened. */
export function createNeedsYouTimeline(localServerId: () => Promise<string>, now: () => number = Date.now) {
  const published = new Set<string>();
  const pending = new Map<string, Promise<void>>();
  const failures = new Map<string, { until: number; waitMs: number; message: string }>();

  async function publish(data: NeedsYouTimeline, askedAt: string, paseo: PaseoApi) {
    const id = `needs-you:${data.kind}:${data.requestId}`;
    const key = `${data.serverId}:${data.agentId}:${id}`;
    if (published.has(key)) return;
    if (pending.has(key)) return pending.get(key);
    const failure = failures.get(key);
    if (failure && now() < failure.until) return;
    const operation = (async () => {
      try {
        if (data.serverId !== await localServerId()) return;
        const agent = (await paseo.agents.ref(data.agentId).refresh())?.agent;
        // A closed agent (Paseo 0.14 releases idle agents after an hour) can't take a timeline row without being
        // resumed, which isn't worth it for a row. The request stays in Attention, where answering resumes it.
        if (!agent || agent.archivedAt || agent.status === "closed" || agent.workspaceId !== data.workspaceId) return;
        if (data.kind === "question" && (agent.pendingPermissions.length || (agent.lastUserMessageAt && Date.parse(agent.lastUserMessageAt) > Date.parse(askedAt)))) return;
        // Append is display-only: never send a prompt, resume the agent, or read its provider history.
        await paseo.agents.ref(data.agentId).timeline.append({ type: "plugin", id, kind: needsYouTimelineKind, version: 1, data });
        published.add(key);
        failures.delete(key);
      } catch (error) {
        // An unavailable/older client must not break the original Attention or workspace request.
        const message = error instanceof Error ? error.message : String(error);
        const waitMs = failure ? Math.min(failure.waitMs * 2, longestRetryMs) : firstRetryMs;
        failures.set(key, { until: now() + waitMs, waitMs, message });
        if (failure?.message !== message) console.warn(`[mission-control] Could not publish Needs you to chat: ${message} (trying again in ${Math.round(waitMs / 60_000)} min)`);
      }
    })();
    pending.set(key, operation);
    try { await operation; } finally { pending.delete(key); }
  }

  return {
    questions: (entries: readonly QuestionEntry[], paseo: PaseoApi) => Promise.all(entries.filter(entry => entry.question.status === "open").map(({ question }) => publish({
      serverId: question.serverId, workspaceId: question.workspaceId, agentId: question.agentId, requestId: question.questionId, kind: "question",
    }, question.askedAt, paseo))),
    decisions: (entries: readonly DecisionEntry[], paseo: PaseoApi) => Promise.all(entries.filter(entry => entry.decision.status === "open" && entry.decision.agentId).map(({ decision }) => publish({
      serverId: decision.serverId, workspaceId: decision.workspaceId, agentId: decision.agentId!, requestId: decision.decisionId, kind: "decision",
    }, decision.requestedAt, paseo))),
  };
}
