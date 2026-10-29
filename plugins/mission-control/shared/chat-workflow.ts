import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";

export const chatCommand = defineRpc({
  name: "chat.command",
  input: z.object({ agentId: z.string().min(1), conversationId: z.string().min(1).max(300).optional(), text: z.string().trim().min(1).max(4000), offerId: z.string().regex(/^[a-f0-9]{10}$/).optional() }),
  output: z.object({ text: z.string(), offerId: z.string().optional(), state: z.enum(["pending", "executing", "complete", "uncertain"]).optional() }),
});

export const chatInbox = defineRpc({
  name: "chat.inbox",
  input: z.object({ agentId: z.string().min(1), conversationId: z.string().min(1).max(300).optional() }),
  output: z.object({ entries: z.array(z.object({ id: z.string(), text: z.string(), offerId: z.string().optional() })) }),
});

// Native chat receipts must be appended by the plugin server session.
export const chatNativeCommand = defineRpc({ name: "chat.native-command", input: chatCommand.input.pick({ agentId: true, text: true }), output: chatCommand.output });

export const CHAT_HELP = "Mission Control chat commands:\nneeds — what needs you in this chat's work\nall needs — pending decisions across this host\nplan <ticket or task ID> — show the saved approval plan\nreview <ticket or task ID> — show the review decision\ndraft PR <task ID> — prepare the exact commit/push/draft PR preview\nyes approve <proposal code> — approve a displayed plan/review\nrequest changes: <note> — request a revision\nstop: <reason> — stop the displayed task\nopen draft PR <proposal code> — authorize the displayed delivery\nquestion <ticket or question ID> — read a blocking question\nanswer: <your answer> — answer the displayed question\nadopt <task ID> — link its existing worker to this coordinator\nrefresh plan <ticket> — ask its existing worker for a fresh readable plan\nheartbeat | pause heartbeat | resume heartbeat — control this coordinator\nqueue <task ID> priority <0–9> | unqueue <task ID> — manage automatic work\nA plan/review approval does not authorize publishing, merges, deployments or tracker updates.";
