import type { DecisionEntry } from "../shared/decisions";
import type { QuestionEntry } from "../shared/questions";
import { pendingPrompts, waitingCards, type AttentionRoster } from "./attention-model";

// What blocks an agent on an orchestrated host, for its Attention bubble and dialog. It counts the cards the dialog
// shows: permission prompts, unanswered questions, agent errors, and open plan and review decisions. An agent that
// only finished and waits to be looked at doesn't count.

/** The host's own Mission Control reads; null when it couldn't be asked (not installed, older, or offline). */
export type HostAttentionReads = { questions: readonly QuestionEntry[] | null; openDecisions: number | null };

export const noAttentionReads: HostAttentionReads = { questions: null, openDecisions: null };

export function hostAttentionCount({ serverId, label, roster, reads }: { serverId: string; label: string; roster: AttentionRoster; reads: HostAttentionReads }): number {
  const hosts = [{ serverId, label, status: "online" }];
  const rosters = [{ data: roster }];
  return pendingPrompts(hosts, rosters).length
    + waitingCards({ hosts, rosters, localServerId: serverId, questions: reads.questions ?? undefined }).length
    + (reads.openDecisions ?? 0);
}

/** The bubble's label; there is no bubble while nothing is waiting. */
export function hostAttentionLabel(count: number): string {
  return `Attention · ${count}`;
}

type Copy = { supports(name: string): boolean; rpc(name: string, input: unknown): Promise<unknown> };

/** Asks the host's Mission Control copy for its open questions and decisions. A failed read is null, not zero. */
export async function readHostAttention(serverId: string, copy: Copy | null): Promise<HostAttentionReads> {
  if (!copy) return noAttentionReads;
  const [questions, decisions] = await Promise.all([
    copy.supports("attention.waiting") ? copy.rpc("attention.waiting", { serverId }).then(result => (result as { questions: QuestionEntry[] }).questions, () => null) : null,
    copy.supports("decisions.list") ? copy.rpc("decisions.list", { serverId }).then(result => (result as { open: DecisionEntry[] }).open.length, () => null) : null,
  ]);
  return { questions, openDecisions: decisions };
}
