import type { PaseoApi } from "@getpaseo/client";
import type { DecisionEntry } from "../shared/decisions";
import type { QuestionEntry } from "../shared/questions";
import { needsYouTimelineKind, type NeedsYouTimeline } from "../shared/needs-you-timeline";

/** Reconciled by the always-on Mission header poll, even when Attention has never been opened. */
export function createNeedsYouTimeline(localServerId: () => Promise<string>) {
  const published = new Set<string>();
  const pending = new Map<string, Promise<void>>();

  async function publish(data: NeedsYouTimeline, askedAt: string, paseo: PaseoApi) {
    const id = `needs-you:${data.kind}:${data.requestId}`;
    const key = `${data.serverId}:${data.agentId}:${id}`;
    if (published.has(key)) return;
    if (pending.has(key)) return pending.get(key);
    const operation = (async () => {
      try {
        if (data.serverId !== await localServerId()) return;
        const agent = (await paseo.agents.ref(data.agentId).refresh())?.agent;
        if (!agent || agent.archivedAt || agent.status === "closed" || agent.workspaceId !== data.workspaceId) return;
        if (data.kind === "question" && (agent.pendingPermissions.length || (agent.lastUserMessageAt && Date.parse(agent.lastUserMessageAt) > Date.parse(askedAt)))) return;
        // Append is display-only: never send a prompt, resume the agent, or read its provider history.
        await paseo.agents.ref(data.agentId).timeline.append({ type: "plugin", id, kind: needsYouTimelineKind, version: 1, data });
        published.add(key);
      } catch (error) {
        // An unavailable/older client must not break the original Attention or workspace request.
        console.warn("[mission-control] Could not publish Needs you to chat:", error instanceof Error ? error.message : String(error));
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
