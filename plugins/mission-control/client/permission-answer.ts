import type { PaseoAgentPermissionResponse } from "@getpaseo/client";

type AnsweringAgent = {
  respondToPermission(options: { requestId: string; response: PaseoAgentPermissionResponse }): Promise<void>;
  refresh(): Promise<{ agent: { pendingPermissions?: readonly { id: string }[] | null } } | null>;
};

/** As long as Paseo 0.12's own `paseo permit` waits for an answer to be applied. */
export const answerConfirmMs = 15_000;

export const unconfirmedAnswer = "Paseo hasn't confirmed this answer after 15 seconds, so the prompt may still be waiting. Try again, or open the agent to check.";

/**
 * Sends a permission answer, then reads the agent until the request is no longer pending. Paseo's plugin API only
 * sends the answer and nothing confirms it arrived, so over the relay an answer can be lost while the card shows it
 * as done. "pending" means the request was still waiting when `timeoutMs` ran out.
 */
export async function answerPermission(agent: AnsweringAgent, requestId: string, response: PaseoAgentPermissionResponse, options: {
  timeoutMs?: number; intervalMs?: number; sleep?: (ms: number) => Promise<void>; now?: () => number;
} = {}): Promise<"confirmed" | "pending"> {
  const { timeoutMs = answerConfirmMs, intervalMs = 500, sleep = ms => new Promise(resolve => setTimeout(resolve, ms)), now = Date.now } = options;
  await agent.respondToPermission({ requestId, response });
  const deadline = now() + timeoutMs;
  for (;;) {
    // A failed read proves nothing; an agent that's gone has nothing waiting.
    const read = await agent.refresh().then(result => ({ result }), () => null);
    if (read && !(read.result?.agent.pendingPermissions ?? []).some(item => item.id === requestId)) return "confirmed";
    if (now() >= deadline) return "pending";
    await sleep(intervalMs);
  }
}
