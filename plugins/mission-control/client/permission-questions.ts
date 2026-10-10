import type { PaseoAgentPermissionResponse, PaseoApi } from "@getpaseo/client";
import type { PermissionRequest } from "./permission-detail";

export type NativeQuestion = {
  header: string;
  question: string;
  options: { label: string; description?: string }[];
  multiSelect: boolean;
  allowOther: boolean;
  allowEmpty: boolean;
  placeholder?: string;
  dismissLabel?: string;
};
export type QuestionAnswer = { selected: number[]; custom: boolean; text: string };
export type QuestionDraft = Record<number, QuestionAnswer>;

const object = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
export const emptyAnswer = (): QuestionAnswer => ({ selected: [], custom: false, text: "" });

/** Paseo normalizes provider questions into request.input; answers are keyed by header. */
export function nativeQuestions(request: PermissionRequest): NativeQuestion[] | null {
  if (request.kind !== "question" || !object(request.input) || !Array.isArray(request.input.questions) || !request.input.questions.length) return null;
  const result: NativeQuestion[] = [];
  const headers = new Set<string>();
  for (const raw of request.input.questions) {
    if (!object(raw) || typeof raw.question !== "string" || !raw.question.trim() || typeof raw.header !== "string" || !raw.header.trim() || headers.has(raw.header) || !Array.isArray(raw.options)) return null;
    const options: NativeQuestion["options"] = [];
    for (const option of raw.options) {
      if (!object(option) || typeof option.label !== "string" || !option.label.trim()) return null;
      options.push({ label: option.label, ...(typeof option.description === "string" ? { description: option.description } : {}) });
    }
    headers.add(raw.header);
    result.push({
      header: raw.header, question: raw.question, options,
      multiSelect: raw.multiSelect === true,
      allowOther: raw.allowOther === true || raw.isOther === true,
      allowEmpty: raw.allowEmpty === true,
      ...(typeof raw.placeholder === "string" ? { placeholder: raw.placeholder } : {}),
      ...(typeof raw.dismissLabel === "string" ? { dismissLabel: raw.dismissLabel } : {}),
    });
  }
  return result;
}

export function selectQuestionOption(question: NativeQuestion, answer: QuestionAnswer, option: number): QuestionAnswer {
  if (!Number.isInteger(option) || !question.options[option]) return answer;
  if (!question.multiSelect) return { selected: [option], custom: false, text: "" };
  return { ...answer, selected: answer.selected.includes(option) ? answer.selected.filter(index => index !== option) : [...answer.selected, option] };
}

export function selectCustomAnswer(question: NativeQuestion, answer: QuestionAnswer): QuestionAnswer {
  if (question.options.length && !question.allowOther) return answer;
  if (!question.multiSelect) return { ...answer, selected: [], custom: true };
  return { ...answer, custom: !answer.custom, text: answer.custom ? "" : answer.text };
}

export function writeQuestionAnswer(question: NativeQuestion, answer: QuestionAnswer, text: string): QuestionAnswer {
  if (question.options.length && !question.allowOther) return answer;
  return { selected: question.multiSelect ? answer.selected : [], custom: true, text };
}

export function questionAnswered(question: NativeQuestion, answer = emptyAnswer()): boolean {
  const selected = answer.selected.filter(index => Number.isInteger(index) && Boolean(question.options[index]));
  if (selected.length !== answer.selected.length || new Set(selected).size !== selected.length || (!question.multiSelect && selected.length > 1)) return false;
  const textActive = question.options.length === 0 || (question.allowOther && answer.custom);
  if (textActive && (answer.text.trim() || question.allowEmpty)) return true;
  return selected.length > 0;
}

export function questionResponse(request: PermissionRequest, questions: NativeQuestion[], draft: QuestionDraft): PaseoAgentPermissionResponse {
  if (!questions.length || !questions.every((question, index) => questionAnswered(question, draft[index]))) throw new Error("Answer every question before submitting.");
  const answers = Object.fromEntries(questions.map((question, index) => {
    const answer = draft[index] ?? emptyAnswer();
    const labels = answer.selected.map(option => question.options[option].label);
    const text = (question.options.length === 0 || (question.allowOther && answer.custom)) ? answer.text.trim() : "";
    return [question.header, text ? (question.multiSelect ? [...labels, text].join(", ") : text) : labels.join(", ")];
  }));
  return { behavior: "allow", updatedInput: { ...request.input, answers } };
}

export function dismissQuestionResponse(request: PermissionRequest, questions: NativeQuestion[]): PaseoAgentPermissionResponse {
  // Native free-text prompts may explicitly treat dismissal as an empty answer.
  if (questions.length && questions.every(question => question.allowEmpty && question.options.length === 0)) return questionResponse(request, questions, {});
  return { behavior: "deny", message: "Dismissed by user" };
}

export function questionRequestVersion(request: PermissionRequest): string {
  return JSON.stringify([request.id, request.kind, request.name, request.input]);
}

const submissions = new Set<string>();
/** Recheck the actual host/agent request, including replies made in native chat or another surface. */
export async function respondToNativeQuestion(paseo: PaseoApi, serverId: string, agentId: string, request: PermissionRequest, response: PaseoAgentPermissionResponse): Promise<void> {
  const key = JSON.stringify([serverId, agentId, request.id]);
  if (submissions.has(key)) throw new Error("An answer is already being sent for this question.");
  submissions.add(key);
  try {
    const agent = paseo.agents.ref(agentId);
    const current = (await agent.refresh())?.agent;
    if (!current || current.archivedAt || current.status === "closed") throw new Error("This agent is unavailable. Open the agent to check its questions.");
    const pending = current.pendingPermissions.find(item => item.id === request.id);
    if (!pending) throw new Error("This question is no longer waiting for an answer. It may have been answered in chat.");
    if (questionRequestVersion(pending) !== questionRequestVersion(request)) throw new Error("The questions changed. Review the updated questions before submitting.");
    await agent.respondToPermission({ requestId: request.id, response });
  } finally { submissions.delete(key); }
}
