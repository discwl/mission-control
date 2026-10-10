import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";

const taskId = z.string().regex(/^task_[a-f0-9-]+$/);
const runId = z.string().regex(/^run_[a-f0-9-]+$/);
const questionId = z.string().regex(/^question_[a-f0-9-]+$/);

// An ordinary question an agent recorded with `dev-flow.mjs ask` when it stopped for the user. The CLI
// validates the same limits (keep questionLimits there in step), plus no IDs, hashes or paths.
export const questionLimits = { question: 500, status: 400, need: 200, recommendation: 300, answer: 4000 } as const;
export const questionPlainSchema = z.object({
  // Where things stand, in at most about three sentences.
  status: z.string().trim().min(1).max(questionLimits.status),
  // What the agent needs from the user, in one sentence.
  need: z.string().trim().min(1).max(questionLimits.need),
  recommendation: z.string().trim().max(questionLimits.recommendation).nullable().default(null),
});
export type QuestionPlain = z.infer<typeof questionPlainSchema>;

export const questionSchema = z.object({
  schemaVersion: z.literal(1),
  questionId,
  taskId,
  runId,
  serverId: z.string().min(1),
  workspaceId: z.string().min(1),
  agentId: z.string().min(1),
  // A newer question from the same run replaces an open one.
  status: z.enum(["open", "answered", "replaced"]),
  question: z.string().min(1).max(questionLimits.question),
  askedAt: z.string(),
  answeredAt: z.string().nullable(),
  answer: z.string().max(questionLimits.answer).nullable(),
  // Reserved before sending. A lost acknowledgement must not allow a different answer or a blind resend.
  delivery: z.object({ text: z.string().max(questionLimits.answer), attemptedAt: z.string() }).nullable().optional(),
  // A malformed block falls back to quoting the agent's chat instead of hiding the question.
  plain: questionPlainSchema.nullable().catch(null),
});
export type Question = z.infer<typeof questionSchema>;

export const questionEntrySchema = z.object({ question: questionSchema, taskTitle: z.string(), projectId: z.string() });
export type QuestionEntry = z.infer<typeof questionEntrySchema>;

export const questionRefSchema = z.object({ serverId: z.string().min(1), workspaceId: z.string().min(1), taskId, runId, questionId });
export type QuestionRef = z.infer<typeof questionRefSchema>;

/**
 * What Attention reads from this installation's vault besides decisions: the open questions, and every
 * task's title by ID, so a card can name the task an agent's mission-control.task-id label points to.
 */
export const listWaiting = defineRpc({
  name: "attention.waiting",
  input: z.object({ serverId: z.string().min(1) }),
  output: z.object({ questions: z.array(questionEntrySchema), taskTitles: z.record(z.string(), z.string()) }),
});

// Sends the user's reply to the question's agent on this host, then records it as the answer.
export const replyToQuestion = defineRpc({
  name: "attention.questions.reply",
  input: questionRefSchema.extend({ text: z.string().trim().min(1).max(questionLimits.answer) }),
  output: z.object({ question: questionSchema }),
});

export const waitingKey = (serverId: string) => ["mission-control", "waiting", serverId] as const;
