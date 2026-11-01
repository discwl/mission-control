import { z } from "zod";
export type ReviewContext = { baseCommit: string; candidate: { head: string | null; tree: string }; reviewers: { agentId: string; model: string; report: string }[] };
export const reviewContextSchema: z.ZodType<ReviewContext>;
export function normalizeReviewContext(input: unknown, candidate: ReviewContext["candidate"] | null, evidence: string[]): ReviewContext | null;
