export type AnswerInput = {
  kind: "plan" | "review";
  outcome: "approved" | "changes_requested" | "blocked";
  // The decision's open findings, and how many of them are checked to go to the agent.
  openFindings: number;
  selected: number;
  note: string;
};

/**
 * What an answer still needs before the server accepts it, in the server's own words (see resolve in
 * server/decisions.ts), or null. A brief card uses it to open its details instead of failing.
 */
export function answerProblem({ kind, outcome, openFindings, selected, note }: AnswerInput): string | null {
  const written = note.trim().length > 0;
  if (outcome === "changes_requested" && kind === "review" && openFindings > 0 && selected === 0) return "Select at least one finding to fix.";
  if (outcome === "blocked") return written ? null : "Add a note explaining the block.";
  if (outcome === "changes_requested" && kind === "plan" && !written) return "Describe the plan changes you want.";
  const dismissed = outcome === "approved" ? openFindings : openFindings - selected;
  if (dismissed > 0 && !written) return `Add a note explaining why ${dismissed} finding${dismissed === 1 ? " is" : "s are"} dismissed.`;
  return null;
}
