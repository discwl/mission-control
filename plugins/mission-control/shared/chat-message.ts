import { z } from "zod";

// Structured facts only. A coordinator's free-form text is never used to infer task identity or consent.
export const chatMessageContext = z.object({
  host: z.string(), title: z.string().optional(), taskId: z.string().optional(),
  type: z.enum(["update", "discussion", "summary", "plan", "review", "question", "blocker", "delivery", "receipt", "completion"]),
  stage: z.string().optional(), status: z.string().optional(), waitingOn: z.string().optional(),
  nextStep: z.string().optional(), actionNeeded: z.string().optional(),
  observedAt: z.string(), evidence: z.enum(["saved_record", "agent_report", "unavailable"]),
});
export type ChatMessageContext = z.infer<typeof chatMessageContext>;
// Navigation opens fresh records; it cannot express a decision or publication consent.
export const chatReadAction = z.object({ label: z.string(), command: z.string().regex(/^(?:all needs|needs|(?:plan|review|question|review details|decision status|draft pr) [\w-]+)$/i) });
export type ChatReadAction = z.infer<typeof chatReadAction>;
