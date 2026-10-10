import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { test } from "node:test";

const require = createRequire(import.meta.url);
const ts = require("typescript");
require.extensions[".ts"] = (module, file) => module._compile(ts.transpileModule(readFileSync(file, "utf8"), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText, file);
const { defaultText, draftNote, isWaiting, shownText, stateAfterReading, textProblem, textRequest } = require("./delivery-text-model.ts");

const path = "C:\\repo\\paseo.json";
const info = (instructions = {}) => ({
  title: "ABC-7 · Add greeting", ticket: { key: "ABC-7", url: "https://example.atlassian.net/browse/ABC-7" }, summary: "Adds a greeting file.",
  instructions: { commitMessage: null, pullRequest: null, branchName: null, path, where: "source", problem: null, ...instructions },
});
const mergeNeeds = { commit: true, pullRequest: false };
const prNeeds = { commit: true, pullRequest: true };
const plan = { commitMessage: "Add greeting (task_1)", title: "ABC-7: Add greeting", body: "## What changed\n\nTicket: …" };

test("the confirmation shows the default at once, then the text written from paseo.json, before anything is committed", () => {
  const defaults = defaultText(mergeNeeds, plan);
  assert.deepEqual(defaults, { commitMessage: "Add greeting (task_1)" });
  // Reading paseo.json: the default shows and Confirm waits.
  assert.deepEqual(shownText(defaults, { phase: "reading" }, {}), defaults);
  assert.equal(isWaiting({ phase: "reading" }), true);
  const writing = stateAfterReading(info({ commitMessage: "Use Conventional Commits." }), mergeNeeds);
  assert.deepEqual(writing, { phase: "writing", path });
  assert.equal(isWaiting(writing), true);
  assert.equal(draftNote(writing, defaults), `Writing this from ${path} with a small model…`);
  // Written: the generated text replaces the default, and Confirm is enabled with exactly that text.
  const written = { phase: "written", path, model: "Claude Haiku 4.5", text: { commitMessage: "feat: add greeting" } };
  assert.deepEqual(shownText(defaults, written, {}), { commitMessage: "feat: add greeting" });
  assert.equal(isWaiting(written), false);
  assert.equal(draftNote(written, defaults), `Written by Claude Haiku 4.5 following ${path}. Edit it if needed.`);
  // The user's edit wins, even over text written after it.
  assert.deepEqual(shownText(defaults, written, { commitMessage: "feat: add a friendly greeting" }), { commitMessage: "feat: add a friendly greeting" });
});

test("without instructions for this run, the defaults stay and the note says why", () => {
  const defaults = defaultText(prNeeds, plan);
  const none = stateAfterReading({ ...info(), instructions: { ...info().instructions, path: null, where: null } }, prNeeds);
  assert.deepEqual(none, { phase: "defaults", reason: "This repository has no paseo.json, so this is Mission Control's default text." });
  assert.deepEqual(shownText(defaults, none, {}), { commitMessage: plan.commitMessage, title: plan.title, body: plan.body });
  assert.equal(isWaiting(none), false);
  // paseo.json exists, but only with branch guidance.
  assert.deepEqual(stateAfterReading(info({ branchName: "feature/<slug>" }), prNeeds), { phase: "defaults", reason: `${path} has no commit message or pull request instructions, so this is Mission Control's default text.` });
  // Pull request instructions don't apply to Merge.
  assert.equal(stateAfterReading(info({ pullRequest: "Start with ## Why." }), mergeNeeds).phase, "defaults");
  assert.equal(textRequest(info({ pullRequest: "Start with ## Why." }), mergeNeeds), null);
  // An invalid paseo.json.
  const invalid = stateAfterReading(info({ problem: `${path} isn't valid JSON (Unexpected end), so its instructions aren't used.` }), prNeeds);
  assert.equal(invalid.phase, "defaults");
  assert.match(invalid.reason, /isn't valid JSON .* This is Mission Control's default text\.$/);
});

test("when writing fails, or the user stops waiting, the defaults are used", () => {
  const defaults = defaultText(prNeeds, plan);
  const failed = { phase: "failed", path, error: "No small model is available on this host." };
  assert.deepEqual(shownText(defaults, failed, {}), defaults);
  assert.equal(draftNote(failed, defaults), `Couldn't write this from ${path}: No small model is available on this host. This is Mission Control's default text.`);
  assert.deepEqual(shownText(defaults, { phase: "skipped" }, {}), defaults);
  assert.equal(isWaiting({ phase: "skipped" }), false);
});

test("the model is asked only for what this run needs, and parts it didn't write keep their default", () => {
  const request = textRequest(info({ commitMessage: "Conventional.", pullRequest: "## Why first." }), { commit: false, pullRequest: true });
  assert.deepEqual(request, { title: "ABC-7 · Add greeting", ticketKey: "ABC-7", summary: "Adds a greeting file.", commitInstructions: null, pullRequestInstructions: "## Why first.", pullRequestTemplate: null });
  // Open PR's template goes along with pull request instructions, and not with commit instructions alone.
  assert.equal(textRequest(info({ pullRequest: "## Why first." }), prNeeds, "## What changed").pullRequestTemplate, "## What changed");
  assert.equal(textRequest(info({ commitMessage: "Conventional." }), prNeeds, "## What changed").pullRequestTemplate, null);
  const defaults = defaultText({ commit: false, pullRequest: true }, plan);
  assert.deepEqual(Object.keys(defaults), ["title", "body"]);
  const written = { phase: "written", path, model: "Haiku", text: { title: "ABC-7: feat: add greeting" } };
  assert.deepEqual(shownText(defaults, written, {}), { title: "ABC-7: feat: add greeting", body: plan.body });
  assert.match(draftNote(written, defaults), /The pull request description is Mission Control's default\.$/);
});

test("empty text can't be confirmed", () => {
  assert.equal(textProblem({ commitMessage: "  " }), "Write a commit message.");
  assert.equal(textProblem({ title: "", body: "" }), "Write a pull request title.");
  assert.equal(textProblem({ title: "a\nb" }), "Keep the pull request title on one line.");
  assert.equal(textProblem({ commitMessage: "feat: x", title: "t", body: "" }), null);
});
