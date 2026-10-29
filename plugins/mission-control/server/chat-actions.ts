import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

export type ChatOffer = {
  id: string; owner: string; target: string; title: string; kind: "plan" | "review" | "draft-pr" | "question";
  text: string; input: Record<string, unknown>; expiresAt: number;
  state: "pending" | "executing" | "complete" | "uncertain"; receipt?: string;
};
type State = { version: 1; offers: ChatOffer[] };
export type ChatAnswer = { text: string; offerId?: string; state?: ChatOffer["state"] };

// Only the native /mc command and the authenticated connector call this layer. Model output,
// worker completions, quoted text and timeline replay must never be interpreted as consent.
export function parseChatConsent(text: string, kind: ChatOffer["kind"], id: string) {
  const value = text.trim();
  if (value.length > 2100) return null;
  if (kind === "question") { const answer = /^answer:\s*(\S[\s\S]*)$/i.exec(value.endsWith(` ${id}`) ? value.slice(0, -(id.length + 1)) : value); return answer ? { outcome: "answered" as const, note: answer[1] } : null; }
  // Notes may span paragraphs; only standalone approval and publication phrases are consent.
  const noteChanges = /^(?:change(?:s)? requested|request changes|change the plan|changes):\s*(\S[\s\S]*)$/i.exec(value);
  if (noteChanges && kind !== "draft-pr") return { outcome: "changes_requested" as const, note: noteChanges[1] };
  const noteStop = /^stop:\s*(\S[\s\S]*)$/i.exec(value);
  if (noteStop && kind !== "draft-pr") return { outcome: "blocked" as const, note: noteStop[1] };
  if (value.includes("\n")) return null;
  const suffix = ` ${id}`;
  const normalized = (value.endsWith(suffix) ? value.slice(0, -suffix.length) : value).toLowerCase();
  if (kind !== "draft-pr" && /^(yes[, ]+)?(approve|approve (this |the )?plan|accept (this |the )?review|accept review)$/.test(normalized)) return { outcome: "approved" as const, note: "" };
  if (kind === "draft-pr" && value.toLowerCase() === `open draft pr ${id}`) return { outcome: "publish" as const, note: "" };
  const approval = /^approve:\s*(\S.*)$/i.exec(value);
  if (approval && kind !== "draft-pr") return { outcome: "approved" as const, note: approval[1] };
  return null;
}

export function createChatActions(file: string, now = Date.now) {
  let chain: Promise<unknown> = Promise.resolve();
  async function load(): Promise<State> {
    try {
      const value = JSON.parse(await readFile(file, "utf8"));
      if (value.version !== 1 || !Array.isArray(value.offers)) throw new Error("Chat action storage is invalid; no actions were changed.");
      return value;
    } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return { version: 1, offers: [] }; throw error; }
  }
  async function save(state: State) {
    await mkdir(dirname(file), { recursive: true });
    const temporary = `${file}.${randomUUID()}.tmp`;
    await writeFile(temporary, `${JSON.stringify(state, null, 2)}\n`, "utf8");
    await rename(temporary, file);
  }
  function serialized<T>(run: () => Promise<T>): Promise<T> {
    const result = chain.then(run, run); chain = result.catch(() => {}); return result;
  }
  return {
    prepare(input: Omit<ChatOffer, "id" | "state" | "expiresAt">): Promise<ChatOffer> {
      return serialized(async () => {
        const state = await load();
        const same = state.offers.find(offer => offer.owner === input.owner && offer.target === input.target && offer.kind === input.kind && offer.title === input.title && offer.text === input.text && JSON.stringify(offer.input) === JSON.stringify(input.input) && offer.state === "pending" && offer.expiresAt > now());
        if (same) return same;
        // A newly displayed revision supersedes only that task's earlier proposal.
        state.offers = state.offers.filter(offer => !(offer.owner === input.owner && offer.target === input.target && offer.input.taskId === input.input.taskId && offer.kind === input.kind && offer.state === "pending"));
        const offer: ChatOffer = { ...input, id: createHash("sha256").update(randomUUID()).digest("hex").slice(0, 10), state: "pending", expiresAt: now() + 24 * 60 * 60 * 1000 };
        state.offers.push(offer); await save(state); return offer;
      });
    },
    async details(owner: string, id: string): Promise<ChatOffer | undefined> { await chain; return (await load()).offers.find(x => x.owner === owner && x.id === id && x.expiresAt > now()); },
    async pending(owner: string): Promise<ChatOffer[]> { await chain; return (await load()).offers.filter(x => x.owner === owner && x.state === "pending" && x.expiresAt > now()); },
    answer(owner: string, text: string, execute: (offer: ChatOffer, consent: NonNullable<ReturnType<typeof parseChatConsent>>) => Promise<string>, offerId?: string): Promise<ChatAnswer> {
      return serialized(async () => {
        const state = await load();
        const candidates = state.offers.filter(x => x.owner === owner && (offerId ? x.id === offerId : text.trim().endsWith(` ${x.id}`)));
        let offer = candidates.length === 1 ? candidates[0] : undefined;
        if (!offer) {
          const pending = state.offers.filter(x => x.owner === owner && x.state === "pending" && x.expiresAt > now());
          if (offerId || candidates.length > 1 || pending.length !== 1) return { text: "Choose the exact proposal first. Show its plan/review again, or include its proposal code in your reply. Nothing was approved." };
          offer = pending[0];
        }
        if (offer.state === "complete") return { text: offer.receipt!, offerId: offer.id, state: offer.state };
        if (offer.state !== "pending") return { text: "This action may already have run. Check its task and delivery result before retrying; it will not be sent again automatically.", offerId: offer.id, state: offer.state };
        if (offer.expiresAt <= now()) return { text: "This proposal expired. Ask for a fresh plan/review or draft PR preview; nothing was approved." };
        const consent = parseChatConsent(text, offer.kind, offer.id);
        if (!consent) return { text: offer.kind === "question" ? "Reply: answer: <your answer>. This answers the displayed blocking question only." : offer.kind === "draft-pr" ? `To authorize the displayed commit, push and draft PR, reply: open draft PR ${offer.id}` : `Reply “yes approve ${offer.id}”, “request changes: <what to change>”, or “stop: <reason>”.`, offerId: offer.id };
        offer.state = "executing"; await save(state);
        try {
          offer.receipt = await execute(offer, consent); offer.state = "complete"; await save(state);
          return { text: offer.receipt, offerId: offer.id, state: offer.state };
        } catch (error) {
          // A timeout may occur after the remote action committed. Never retry the mutation blindly.
          offer.state = "uncertain"; offer.receipt = `Could not confirm the result: ${error instanceof Error ? error.message : String(error)}. Refresh the task before trying another action.`;
          await save(state); return { text: offer.receipt, offerId: offer.id, state: offer.state };
        }
      });
    },
  };
}
