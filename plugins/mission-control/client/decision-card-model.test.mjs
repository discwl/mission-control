import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { test } from "node:test";

const require = createRequire(import.meta.url);
const ts = require("typescript");
require.extensions[".ts"] = (module, file) => module._compile(ts.transpileModule(readFileSync(file, "utf8"), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText, file);
const { decisionEntrySchema, decisionSchema } = require("../shared/decisions.ts");
const { answerFor, buttonLabels, decisionCardModel, initialChoices, noteToSend, shownNote, skipNote, stopNote } = require("./decision-card-model.ts");

const sample = decisionEntrySchema.parse(JSON.parse(readFileSync(new URL("./fixtures/sample-decision.json", import.meta.url), "utf8")));
const [notes, label] = sample.findings.map(finding => finding.findingId);
const labels = model => model.buttons.map(button => `${button.label}${button.primary ? " *" : ""}`);

test("the sample decision renders in the new layout", () => {
  const model = decisionCardModel(sample);
  // Collapsed: kind and task, plain sentences, the recommendation, and buttons named for what they do.
  assert.equal(model.kind, "REVIEW");
  assert.equal(model.title, "23 · Pause and resume tasks");
  assert.deepEqual(model.lines, {
    built: "You can now pause a task and pick it up later; the agent saves where it got to and its notes.",
    found: "The review found two problems: one can lose notes, the other is a confusing label.",
    generic: false,
  });
  assert.deepEqual(model.recommendation, { label: "Fix 1 issue first", reason: "Losing notes is worth a quick fix before this ships; the label can wait.", button: "fix" });
  assert.equal(model.unverified, null);
  assert.deepEqual(labels(model), ["Accept, skipping 2", "Fix 1 issue first *", "Stop"]);

  // More: what was built, the verified fix with a tick, each open finding in plain words with its own choice.
  assert.equal(model.more.builtHeading, "What was built");
  assert.deepEqual(model.more.fixed, ["Pausing a task now really stops its agent."]);
  assert.deepEqual(model.more.findings.map(finding => [finding.text, finding.impact, finding.severityLabel, finding.choice]), [
    ["Pausing the same task twice loses the notes from the first pause.", "Anything the agent wrote before the second pause is gone for good.", "Moderate", "fix"],
    ["The button to continue a paused task says Unpause instead of Resume.", "Slightly odd wording; everything still works.", "Minor", "skip"],
  ]);
  assert.deepEqual(model.more.help.map(item => item.label), ["Accept, skipping 2", "Fix 1 issue first", "Stop"]);
  assert.match(model.more.help[0].text, /All 2 open issues are skipped/);
  assert.match(model.more.help[1].text, /Sends the 1 issue marked Fix now back to the agent\. It fixes it, .* The 1 marked Skip is skipped, with your note\./);
  assert.match(model.more.help[2].text, /nothing is thrown away/);

  // Technical details keep today's question, summary, evidence and file references.
  assert.equal(model.technical.question, sample.decision.question);
  assert.equal(model.technical.summary, sample.summary);
  assert.deepEqual(model.technical.evidence, sample.decision.evidence);
  assert.deepEqual(model.technical.findings.map(finding => finding.file), ["plugins/mission-control/server/pause.ts", "plugins/mission-control/client/task-launcher.tsx"]);

  // The plain parts carry none of the technical detail.
  const plainText = JSON.stringify([model.lines, model.recommendation, model.more.fixed, model.more.findings.map(finding => [finding.text, finding.impact]), model.more.help]);
  assert.doesNotMatch(plainText, /pause\.ts|403504d|finding_|decision_|C:\//);
});

test("button labels follow the per-finding choices", () => {
  assert.deepEqual(initialChoices(sample.findings), { [notes]: "fix", [label]: "skip" });
  assert.deepEqual(labels(decisionCardModel(sample, { [notes]: "fix", [label]: "fix" })), ["Accept, skipping 2", "Fix 2 issues first *", "Stop"]);
  // With everything skipped there is nothing to fix, so Accept leads.
  const skipped = decisionCardModel(sample, { [notes]: "skip", [label]: "skip" });
  assert.deepEqual(labels(skipped), ["Accept, skipping 2 *", "Stop"]);
  assert.deepEqual(skipped.more.findings.map(finding => finding.choice), ["skip", "skip"]);

  assert.deepEqual(buttonLabels("review", 0, 0), { accept: "Accept", fix: null, change: "Ask for changes", stop: "Stop" });
  assert.deepEqual(buttonLabels("review", 3, 1), { accept: "Accept, skipping 3", fix: "Fix 1 issue first", change: null, stop: "Stop" });
  assert.deepEqual(buttonLabels("plan", 0, 0), { accept: "Approve plan", fix: null, change: "Change the plan", stop: "Stop" });

  const plan = decisionEntrySchema.parse({ ...sample, findings: [], resolvedFindings: [], decision: { ...sample.decision, kind: "plan", findingIds: [],
    plain: { built: "A pause button for tasks.", recommendation: { action: "accept", reason: "Small and safe." } } } });
  const planModel = decisionCardModel(plan);
  assert.deepEqual(labels(planModel), ["Approve plan *", "Change the plan", "Stop"]);
  assert.equal(planModel.more.builtHeading, "What's planned");
  assert.deepEqual(planModel.recommendation, { label: "Approve plan", reason: "Small and safe.", button: "accept" });
  const stop = decisionCardModel({ ...sample, decision: { ...sample.decision, plain: { ...sample.decision.plain, recommendation: { action: "stop", reason: "The approach is wrong." } } } });
  assert.deepEqual(labels(stop), ["Accept, skipping 2", "Fix 1 issue first", "Stop *"]);
});

test("required notes are prefilled with an editable default", () => {
  const untouched = { text: "", edited: false };
  // The note field shows the skip note while anything is marked Skip.
  assert.equal(shownNote("review", 2, 1, untouched), skipNote);
  assert.equal(shownNote("review", 2, 2, untouched), "");
  assert.equal(shownNote("plan", 0, 0, untouched), "");
  assert.equal(shownNote("review", 2, 1, { text: "Label is fine as is.", edited: true }), "Label is fine as is.");

  assert.equal(noteToSend("review", "approved", 2, 2, untouched), skipNote, "accepting skips every open finding");
  assert.equal(noteToSend("review", "changes_requested", 2, 1, untouched), skipNote);
  assert.equal(noteToSend("review", "changes_requested", 2, 2, untouched), "", "nothing skipped, so no skip note is sent");
  assert.equal(noteToSend("review", "approved", 0, 0, untouched), "");
  assert.equal(noteToSend("plan", "approved", 0, 0, untouched), "");
  assert.equal(noteToSend("plan", "blocked", 0, 0, untouched), stopNote);
  assert.equal(noteToSend("review", "approved", 2, 0, { text: "Both are fine.", edited: true }), "Both are fine.");
  // A cleared note stays cleared, so the server's own check asks for one.
  assert.equal(noteToSend("review", "approved", 2, 0, { text: "", edited: true }), "");
});

test("an answer never sends a note the user hasn't seen", () => {
  const untouched = { text: "", edited: false };
  const allFix = { [notes]: "fix", [label]: "fix" };
  // Everything marked Fix now: the note box is empty, so Accept shows its skip note and action before sending.
  const accept = answerFor(sample, allFix, "accept", untouched, true);
  assert.equal(shownNote("review", 2, 2, untouched), "");
  assert.deepEqual(accept, { outcome: "approved", note: skipNote, confirm: true, prompt: "Accept the work and skip all 2 open issues? This note goes to the agent with it:", sendLabel: "Accept, skipping 2", noteRequired: true });
  // With More closed no note is on screen, so any answer that carries one asks first.
  assert.equal(answerFor(sample, initialChoices(sample.findings), "accept", untouched, false).confirm, true);
  const fixCollapsed = answerFor(sample, initialChoices(sample.findings), "fix", untouched, false);
  assert.deepEqual([fixCollapsed.confirm, fixCollapsed.note, fixCollapsed.prompt, fixCollapsed.sendLabel], [true, skipNote, "Send 1 issue back to be fixed and skip 1? This note goes to the agent with it:", "Fix 1 issue first"]);
  // The note box already shows exactly what is sent, so these go straight out.
  assert.equal(answerFor(sample, initialChoices(sample.findings), "fix", untouched, true).confirm, false);
  assert.equal(answerFor(sample, initialChoices(sample.findings), "accept", untouched, true).confirm, false);
  const edited = { text: "Label is fine as is.", edited: true };
  assert.deepEqual([answerFor(sample, initialChoices(sample.findings), "accept", edited, true).confirm, answerFor(sample, initialChoices(sample.findings), "accept", edited, true).note], [false, "Label is fine as is."]);
  assert.equal(answerFor(sample, initialChoices(sample.findings), "accept", edited, false).confirm, true);
  // Nothing skipped and no note: nothing to show.
  const fixAll = answerFor(sample, allFix, "fix", untouched, false);
  assert.deepEqual([fixAll.confirm, fixAll.note, fixAll.noteRequired], [false, "", false]);
  // Stop and change always ask, with the stop note prefilled and a change note to write.
  assert.deepEqual(answerFor(sample, allFix, "stop", untouched, true), { outcome: "blocked", note: stopNote, confirm: true, prompt: "Stop this task? The agent reads your note.", sendLabel: "Stop the task", noteRequired: true });
  const clean = decisionEntrySchema.parse({ ...sample, findings: [], decision: { ...sample.decision, findingIds: [], plain: { ...sample.decision.plain, recommendation: { action: "accept", reason: "Clean." } } } });
  assert.deepEqual([answerFor(clean, {}, "accept", untouched, false).confirm, answerFor(clean, {}, "accept", untouched, false).note], [false, ""]);
  assert.deepEqual(answerFor(clean, {}, "change", untouched, false), { outcome: "changes_requested", note: "", confirm: true, prompt: "What should change? The agent reads your note.", sendLabel: "Send changes", noteRequired: true });
});

test("an older decision without plain fields renders a generic line with everything under Technical details", () => {
  const { plain: _plain, ...fields } = sample.decision;
  const decision = decisionSchema.parse(fields);
  assert.equal(decision.plain, null);
  const findings = sample.findings.map(({ plain: _findingPlain, ...rest }) => rest);
  const old = decisionEntrySchema.parse({ ...sample, decision, findings, resolvedFindings: undefined, unverifiedFindings: 1 });
  const model = decisionCardModel(old);
  assert.deepEqual(model.lines, { built: "The work is done and has been reviewed.", found: "The review found 2 issues for you to decide on.", generic: true });
  assert.equal(model.recommendation, null);
  assert.match(model.unverified, /^1 earlier fix hasn't been checked by a fresh review yet/);
  // Without recommendations every finding starts on Fix now, and its title stands in for the plain description.
  assert.deepEqual(model.more.findings.map(finding => [finding.text, finding.impact, finding.choice]), [
    ["savePause overwrites notes.md instead of appending", null, "fix"],
    ["Resume button label reads 'Unpause'", null, "fix"],
  ]);
  assert.deepEqual(labels(model), ["Accept, skipping 2", "Fix 2 issues first *", "Stop"]);
  assert.deepEqual(model.more.fixed, []);
  assert.equal(model.technical.summary, sample.summary);

  const clean = decisionCardModel(decisionEntrySchema.parse({ ...old, findings: [], unverifiedFindings: 0, decision: { ...decision, findingIds: [] } }));
  assert.equal(clean.lines.found, "The review found no issues.");
  assert.deepEqual(labels(clean), ["Accept *", "Ask for changes", "Stop"]);
  const plan = decisionCardModel(decisionEntrySchema.parse({ ...old, findings: [], unverifiedFindings: 0, decision: { ...decision, kind: "plan", findingIds: [] } }));
  assert.deepEqual(plan.lines, { built: "The agent has a plan ready and needs your go-ahead before it starts building.", found: null, generic: true });
  assert.deepEqual(labels(plan), ["Approve plan *", "Change the plan", "Stop"]);
});
