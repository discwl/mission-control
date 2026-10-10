import { z } from "zod";

// Only an identity goes into history. The renderer re-reads the live request before offering actions.
export const needsYouTimelineKind = "needs-you";
export const needsYouTimelineSchema = z.object({
  serverId: z.string().min(1), workspaceId: z.string().min(1), agentId: z.string().min(1),
  requestId: z.string().min(1), kind: z.enum(["question", "decision"]),
});
export type NeedsYouTimeline = z.infer<typeof needsYouTimelineSchema>;
