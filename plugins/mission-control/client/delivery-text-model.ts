import type { DeliveryInstructions, DeliveryText, DeliveryTextRequest } from "../shared/paseo-metadata";

// The text Merge's and Open PR's confirmations show and send: Mission Control's defaults, replaced by what a small
// model writes from the repository's paseo.json instructions, and by anything the user types. Nothing is committed
// until the user confirms, and the run uses exactly the text shown.

export type TextField = "commitMessage" | "title" | "body";
export type TextValues = Partial<Record<TextField, string>>;
// commit: the run commits the task's uncommitted work; pullRequest: it opens a pull request.
export type TextNeeds = { commit: boolean; pullRequest: boolean };

export type DraftState =
  | { phase: "reading" }
  // The defaults apply: no instructions for what this run needs, or paseo.json couldn't be used or read.
  | { phase: "defaults"; reason: string }
  | { phase: "writing"; path: string }
  | { phase: "written"; path: string; model: string; text: DeliveryText }
  | { phase: "failed"; path: string; error: string }
  // The user chose the defaults instead of waiting.
  | { phase: "skipped" };

export const fieldLabels: Record<TextField, string> = { commitMessage: "Commit message", title: "Pull request title", body: "Pull request description" };

/** The fields this run needs, with Mission Control's default text in each. */
export function defaultText(needs: TextNeeds, plan: { commitMessage: string; title?: string; body?: string }): TextValues {
  return {
    ...(needs.commit ? { commitMessage: plan.commitMessage } : {}),
    ...(needs.pullRequest ? { title: plan.title ?? "", body: plan.body ?? "" } : {}),
  };
}

/**
 * What the model is asked to write for this run; null when paseo.json has no instructions for any of it. `template`
 * is the repository's pull request template (from Open PR's plan), sent only with pull request instructions.
 */
export function textRequest(info: DeliveryInstructions, needs: TextNeeds, template: string | null = null): DeliveryTextRequest | null {
  const commitInstructions = needs.commit ? info.instructions.commitMessage : null;
  const pullRequestInstructions = needs.pullRequest ? info.instructions.pullRequest : null;
  if (!commitInstructions && !pullRequestInstructions) return null;
  return {
    title: info.title, ticketKey: info.ticket?.key ?? null, summary: info.summary, commitInstructions, pullRequestInstructions,
    pullRequestTemplate: pullRequestInstructions ? template : null,
  };
}

const parts = (needs: TextNeeds) => needs.commit && needs.pullRequest ? "commit message or pull request" : needs.commit ? "commit message" : "pull request";

/** The state once paseo.json was read: writing when it has instructions for this run, else the defaults and why. */
export function stateAfterReading(info: DeliveryInstructions, needs: TextNeeds): DraftState {
  const { instructions } = info;
  if (instructions.problem) return { phase: "defaults", reason: `${instructions.problem} This is Mission Control's default text.` };
  if (!instructions.path) return { phase: "defaults", reason: "This repository has no paseo.json, so this is Mission Control's default text." };
  if (!textRequest(info, needs)) return { phase: "defaults", reason: `${instructions.path} has no ${parts(needs)} instructions, so this is Mission Control's default text.` };
  return { phase: "writing", path: instructions.path };
}

/** The text shown in each field: the user's edit, else what the model wrote, else the default. */
export function shownText(defaults: TextValues, state: DraftState, edits: TextValues): TextValues {
  const written: DeliveryText = state.phase === "written" ? state.text : {};
  const shown: TextValues = {};
  for (const field of Object.keys(defaults) as TextField[]) shown[field] = edits[field] ?? written[field] ?? defaults[field];
  return shown;
}

/** Confirm waits while paseo.json is read or the model writes, so the text can't change under the user's tap. */
export const isWaiting = (state: DraftState) => state.phase === "reading" || state.phase === "writing";

/** One line under the fields: where their text comes from. */
export function draftNote(state: DraftState, defaults: TextValues): string {
  switch (state.phase) {
    case "reading": return "Reading the repository's paseo.json…";
    case "defaults": return state.reason;
    case "writing": return `Writing this from ${state.path} with a small model…`;
    case "skipped": return "Using Mission Control's default text.";
    case "failed": return `Couldn't write this from ${state.path}: ${state.error} This is Mission Control's default text.`;
    case "written": {
      const missing = (Object.keys(defaults) as TextField[]).filter(field => !state.text[field]).map(field => fieldLabels[field].toLowerCase());
      return `Written by ${state.model} following ${state.path}. Edit it if needed.${missing.length ? ` The ${missing.join(" and ")} ${missing.length === 1 ? "is" : "are"} Mission Control's default.` : ""}`;
    }
  }
}

/** Why the shown text can't be sent; null when it can. */
export function textProblem(shown: TextValues): string | null {
  if (shown.commitMessage !== undefined && !shown.commitMessage.trim()) return "Write a commit message.";
  if (shown.title !== undefined && !shown.title.trim()) return "Write a pull request title.";
  if (shown.title !== undefined && /[\r\n]/.test(shown.title)) return "Keep the pull request title on one line.";
  return null;
}
