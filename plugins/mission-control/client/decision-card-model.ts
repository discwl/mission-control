import type { DecisionEntry, Finding } from "../shared/decisions";

export type Choice = "fix" | "skip";
export type Choices = Record<string, Choice>;
export type ButtonId = "accept" | "fix" | "change" | "stop";
export type CardButton = { id: ButtonId; label: string; primary: boolean };

// Prefilled so a required note never blocks a one-click answer; the user can edit either.
export const skipNote = "Skipped for now; track as a follow-up.";
export const stopNote = "Stopped for now. Record where things stand and wait for me.";

const count = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;
const severityWord = { high: "Serious", medium: "Moderate", low: "Minor" } as const;

export function openFindings(entry: DecisionEntry) {
  return entry.findings.filter(finding => finding.status === "open");
}

/** Each open finding starts on the agent's recommendation, or Fix now when it gave none. */
export function initialChoices(findings: Finding[]): Choices {
  return Object.fromEntries(findings.filter(finding => finding.status === "open").map(finding => [finding.findingId, finding.plain?.recommend ?? "fix"]));
}

export function fixIds(entry: DecisionEntry, choices: Choices) {
  return openFindings(entry).filter(finding => (choices[finding.findingId] ?? "fix") === "fix").map(finding => finding.findingId);
}

/** The one or two sentences at the top of the card; decisions without plain fields get a generic line. */
export function plainLines(entry: DecisionEntry): { built: string; found: string | null; generic: boolean } {
  const { plain, kind } = entry.decision;
  if (plain) return { built: plain.built, found: plain.found || null, generic: false };
  const open = openFindings(entry).length;
  if (kind === "plan") return { built: "The agent has a plan ready and needs your go-ahead before it starts building.", found: null, generic: true };
  return { built: "The work is done and has been reviewed.", found: open ? `The review found ${count(open, "issue")} for you to decide on.` : "The review found no issues.", generic: true };
}

/** Buttons named for what they do, following the per-finding choices. */
export function buttonLabels(kind: "plan" | "review", open: number, fix: number) {
  if (kind === "plan") return { accept: "Approve plan", fix: null, change: "Change the plan", stop: "Stop" };
  return {
    // Accepting skips every open finding, whatever it is marked.
    accept: open ? `Accept, skipping ${open}` : "Accept",
    fix: fix ? `Fix ${count(fix, "issue")} first` : null,
    // A clean review can still be sent back, with a note saying what to change.
    change: open ? null : "Ask for changes",
    stop: "Stop",
  };
}

export function recommendation(entry: DecisionEntry): { label: string; reason: string; button: ButtonId } | null {
  const { plain, kind } = entry.decision;
  if (!plain) return null;
  const { action, reason } = plain.recommendation;
  if (action === "stop") return { label: "Stop", reason, button: "stop" };
  if (action === "accept") return { label: kind === "plan" ? "Approve plan" : "Accept", reason, button: "accept" };
  if (kind === "plan") return { label: "Change the plan", reason, button: "change" };
  const fix = Object.values(initialChoices(entry.findings)).filter(choice => choice === "fix").length;
  return fix ? { label: `Fix ${count(fix, "issue")} first`, reason, button: "fix" } : { label: "Ask for changes", reason, button: "change" };
}

export function cardButtons(entry: DecisionEntry, choices: Choices): CardButton[] {
  const { kind } = entry.decision;
  const open = openFindings(entry).length;
  const fix = fixIds(entry, choices).length;
  const labels = buttonLabels(kind, open, fix);
  const recommended = recommendation(entry)?.button;
  const shown: CardButton[] = [{ id: "accept", label: labels.accept, primary: false }];
  if (labels.fix) shown.push({ id: "fix", label: labels.fix, primary: false });
  if (labels.change) shown.push({ id: "change", label: labels.change, primary: false });
  shown.push({ id: "stop", label: labels.stop, primary: false });
  // The recommended button leads; without one, fixing leads while something is marked Fix now.
  const lead = shown.find(button => button.id === recommended) ?? shown.find(button => button.id === "fix") ?? shown[0];
  return shown.map(button => ({ ...button, primary: button === lead }));
}

/** The note an answer needs when the user hasn't written one, or "" when none is required. */
export function defaultNote(kind: "plan" | "review", outcome: "approved" | "changes_requested" | "blocked", open: number, fix: number) {
  if (outcome === "blocked") return stopNote;
  if (kind === "plan") return "";
  const skipped = outcome === "approved" ? open : open - fix;
  return skipped > 0 ? skipNote : "";
}

export type NoteState = { text: string; edited: boolean };

/** The note field starts with the skip note while any finding is marked Skip, until the user edits it. */
export function shownNote(kind: "plan" | "review", open: number, fix: number, note: NoteState) {
  return note.edited ? note.text : defaultNote(kind, "changes_requested", open, fix);
}

/** The note an answer carries: the user's own once edited, otherwise the default for that answer. */
export function noteToSend(kind: "plan" | "review", outcome: "approved" | "changes_requested" | "blocked", open: number, fix: number, note: NoteState) {
  return note.edited ? note.text : defaultNote(kind, outcome, open, fix);
}

export type Answer = {
  outcome: "approved" | "changes_requested" | "blocked";
  note: string;
  // Show the confirm row first: its prompt says what will happen and its editable note is exactly what is sent.
  confirm: boolean;
  prompt: string;
  sendLabel: string;
  noteRequired: boolean;
};

/**
 * What pressing a button does. An answer never carries a note the user hasn't seen: it goes straight out
 * only with no note, or with exactly the note the open note box shows; otherwise it asks first.
 */
export function answerFor(entry: DecisionEntry, choices: Choices, id: ButtonId, note: NoteState, moreOpen: boolean): Answer {
  const { kind } = entry.decision;
  const open = openFindings(entry).length;
  const fix = fixIds(entry, choices).length;
  const labels = buttonLabels(kind, open, fix);
  const skipped = open - fix;
  const withNote = "This note goes to the agent with it:";
  if (id === "stop") return { outcome: "blocked", note: stopNote, confirm: true, prompt: "Stop this task? The agent reads your note.", sendLabel: "Stop the task", noteRequired: true };
  if (id === "change") return { outcome: "changes_requested", note: "", confirm: true, prompt: "What should change? The agent reads your note.", sendLabel: "Send changes", noteRequired: true };
  const outcome = id === "accept" ? "approved" : "changes_requested";
  const text = noteToSend(kind, outcome, open, fix, note);
  const visible = moreOpen ? shownNote(kind, open, fix, note) : null;
  const prompt = id === "fix"
    ? `Send ${count(fix, "issue")} back to be fixed${skipped ? ` and skip ${skipped}` : ""}? ${withNote}`
    : kind === "plan" ? `Approve the plan? ${withNote}`
      : open ? `Accept the work and skip all ${count(open, "open issue")}? ${withNote}` : `Accept the work? ${withNote}`;
  return {
    outcome, note: text, confirm: text.trim() !== "" && text !== visible, prompt,
    sendLabel: (id === "fix" ? labels.fix : labels.accept) ?? labels.accept,
    noteRequired: defaultNote(kind, outcome, open, fix) !== "",
  };
}

/** "What each button does", in the order the buttons appear. */
export function buttonHelp(entry: DecisionEntry, choices: Choices): { label: string; text: string }[] {
  const { kind } = entry.decision;
  const open = openFindings(entry).length;
  const fix = fixIds(entry, choices).length;
  const skipped = open - fix;
  const again = "checks its work again and asks you again.";
  const stop = "Stops work on this task. The agent saves where it got to and waits for you; nothing is thrown away.";
  const help: Record<ButtonId, string> = kind === "plan" ? {
    accept: "The agent starts building what the plan describes.",
    fix: "",
    change: "Tell the agent what to change. It revises the plan and asks you again.",
    stop,
  } : {
    accept: open ? `Approves the work as it is. All ${count(open, "open issue")} are skipped, with your note. The task can then be merged.` : "Approves the work as it is. The task can then be merged.",
    fix: `Sends the ${count(fix, "issue")} marked Fix now back to the agent. It fixes ${fix === 1 ? "it" : "them"}, ${again}${skipped ? ` The ${skipped} marked Skip ${skipped === 1 ? "is" : "are"} skipped, with your note.` : ""}`,
    change: `Tell the agent what to change. It makes the changes, ${again}`,
    stop,
  };
  return cardButtons(entry, choices).map(button => ({ label: button.label, text: help[button.id] }));
}

export type CardFinding = { findingId: string; text: string; impact: string | null; severity: Finding["severity"]; severityLabel: string; choice: Choice };

/** Everything the card shows, collapsed and under More, for one set of per-finding choices. */
export function decisionCardModel(entry: DecisionEntry, choices: Choices = initialChoices(entry.findings)) {
  const { decision } = entry;
  const lines = plainLines(entry);
  return {
    kind: decision.kind === "review" ? "REVIEW" : "PLAN",
    title: entry.taskTitle,
    lines,
    recommendation: recommendation(entry),
    // Approval is refused while earlier fixes await a fresh review, so say so before the user tries.
    unverified: entry.unverifiedFindings
      ? `${count(entry.unverifiedFindings, "earlier fix")} ${entry.unverifiedFindings === 1 ? "hasn't" : "haven't"} been checked by a fresh review yet, so accepting will be refused until one has.`
      : null,
    buttons: cardButtons(entry, choices),
    more: {
      builtHeading: decision.kind === "plan" ? "What's planned" : "What was built",
      built: lines.built,
      found: decision.kind === "review" ? lines.found : null,
      fixed: entry.resolvedFindings.map(finding => finding.plain?.description ?? finding.title),
      findings: openFindings(entry).map((finding): CardFinding => ({
        findingId: finding.findingId,
        text: finding.plain?.description ?? finding.title,
        impact: finding.plain?.impact ?? null,
        severity: finding.severity,
        severityLabel: severityWord[finding.severity],
        choice: choices[finding.findingId] ?? "fix",
      })),
      help: buttonHelp(entry, choices),
    },
    technical: {
      question: decision.question,
      summary: entry.summary,
      evidence: decision.evidence,
      findings: entry.findings.map(finding => ({ findingId: finding.findingId, severity: finding.severity, title: finding.title, file: finding.file, detail: finding.detail })),
    },
  };
}
export type DecisionCardModel = ReturnType<typeof decisionCardModel>;
