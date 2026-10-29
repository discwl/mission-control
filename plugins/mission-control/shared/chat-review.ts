import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";
import { resolveDecision } from "./decisions";

export const resolveChatReview = defineRpc({
  name: "chat.review.resolve",
  input: resolveDecision.input.extend({ expectedCandidate: z.object({ head: z.string().regex(/^[a-f0-9]{40}$/).nullable(), tree: z.string().regex(/^[a-f0-9]{40}$/) }) }),
  output: resolveDecision.output,
});
