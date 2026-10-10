import assert from "node:assert/strict";
import { test } from "node:test";
import {
  nativeQuestions, emptyAnswer, selectQuestionOption, selectCustomAnswer, writeQuestionAnswer,
  questionAnswered, questionResponse, dismissQuestionResponse, questionRequestVersion, respondToNativeQuestion,
} from "./permission-questions.ts";

const question = (overrides = {}) => ({ header: "Direction", question: "Which approach?", options: [{ label: "Small", description: "Keep the scope small." }, { label: "Full" }], multiSelect: false, isOther: true, ...overrides });
const request = (questions = [question()]) => ({ id: "req-1", provider: "codex", kind: "question", name: "request_user_input_async", input: { questions, providerMetadata: { token: "preserve-me" } } });

test("normalized questions preserve native choices, descriptions and question-specific flags", () => {
  const [single, multi, free] = nativeQuestions(request([question(), question({ header: "Checks", multiSelect: true, isOther: false, allowOther: true }), question({ header: "Notes", options: [], allowEmpty: true, placeholder: "Optional context", dismissLabel: "Skip" })]));
  assert.equal(single.multiSelect, false); assert.equal(single.allowOther, true);
  assert.equal(single.options[0].description, "Keep the scope small.");
  assert.equal(multi.multiSelect, true); assert.equal(multi.allowOther, true);
  assert.equal(free.allowEmpty, true); assert.equal(free.placeholder, "Optional context"); assert.equal(free.dismissLabel, "Skip");
});

test("single choice is exclusive; a custom answer replaces it and choosing again clears custom text", () => {
  const [q] = nativeQuestions(request());
  let answer = selectQuestionOption(q, emptyAnswer(), 0);
  answer = selectQuestionOption(q, answer, 1);
  assert.deepEqual(answer.selected, [1]);
  answer = selectCustomAnswer(q, answer);
  assert.deepEqual(answer.selected, []); assert.equal(questionAnswered(q, answer), false);
  answer = writeQuestionAnswer(q, answer, "Something else");
  assert.equal(questionAnswered(q, answer), true);
  answer = selectQuestionOption(q, answer, 0);
  assert.deepEqual(answer, { selected: [0], custom: false, text: "" });
});

test("checkboxes toggle independently and retain custom text alongside selected labels", () => {
  const req = request([question({ multiSelect: true })]), [q] = nativeQuestions(req);
  let answer = selectQuestionOption(q, emptyAnswer(), 0);
  answer = selectQuestionOption(q, answer, 1);
  answer = writeQuestionAnswer(q, answer, " Additional check ");
  assert.deepEqual(questionResponse(req, [q], { 0: answer }).updatedInput.answers, { Direction: "Small, Full, Additional check" });
  answer = selectQuestionOption(q, answer, 0);
  assert.deepEqual(answer.selected, [1]); assert.equal(answer.text, " Additional check ");
  answer = selectCustomAnswer(q, answer);
  assert.equal(answer.text, ""); assert.deepEqual(answer.selected, [1]);
});

test("choice-only, free-text and optional prompts enforce their own answer rules", () => {
  const [choiceOnly, text, optional] = nativeQuestions(request([
    question({ isOther: false }), question({ header: "Text", options: [], isOther: false }), question({ header: "Optional", options: [], allowEmpty: true }),
  ]));
  assert.deepEqual(writeQuestionAnswer(choiceOnly, emptyAnswer(), "no"), emptyAnswer());
  assert.deepEqual(selectCustomAnswer(choiceOnly, emptyAnswer()), emptyAnswer());
  assert.equal(questionAnswered(text), false);
  assert.equal(questionAnswered(text, writeQuestionAnswer(text, emptyAnswer(), "  ")), false);
  assert.equal(questionAnswered(text, writeQuestionAnswer(text, emptyAnswer(), "Context")), true);
  assert.equal(questionAnswered(optional), true);
  assert.equal(questionAnswered(choiceOnly, { selected: [0, 1], text: "", custom: false }), false);
  assert.equal(questionAnswered(choiceOnly, { selected: [99], text: "", custom: false }), false);
});

test("one complete native response uses exact headers and preserves provider input", () => {
  const req = request([question(), question({ header: "Checks", multiSelect: true }), question({ header: "Notes", options: [], allowEmpty: true })]);
  const qs = nativeQuestions(req);
  const draft = { 0: selectQuestionOption(qs[0], emptyAnswer(), 1), 1: writeQuestionAnswer(qs[1], selectQuestionOption(qs[1], emptyAnswer(), 0), "Runtime") };
  assert.throws(() => questionResponse(req, qs, { 0: draft[0] }), /Answer every question/);
  assert.deepEqual(questionResponse(req, qs, draft), { behavior: "allow", updatedInput: { ...req.input, answers: { Direction: "Full", Checks: "Small, Runtime", Notes: "" } } });
  assert.equal(req.input.answers, undefined);
});

test("malformed questions and duplicate headers cannot silently approve or overwrite answers", () => {
  for (const questions of [[], [null], [question({ options: null })], [question({ question: "" })], [question({ header: "" })], [question({ options: [{ label: 3 }] })], [question(), question()]]) {
    assert.equal(nativeQuestions(request(questions)), null);
  }
  assert.equal(nativeQuestions({ ...request(), kind: "tool" }), null);
});

test("dismissal matches native optional-text semantics and otherwise denies the question request", () => {
  const req = request();
  assert.deepEqual(dismissQuestionResponse(req, nativeQuestions(req)), { behavior: "deny", message: "Dismissed by user" });
  const optional = request([question({ options: [], allowEmpty: true })]);
  assert.deepEqual(dismissQuestionResponse(optional, nativeQuestions(optional)).updatedInput.answers, { Direction: "" });
});

function client(req, handlers = {}) {
  const calls = [];
  return { calls, api: { agents: { ref(id) { calls.push(["ref", id]); return {
    async refresh() { calls.push(["refresh"]); return handlers.refresh ? handlers.refresh() : { agent: { pendingPermissions: [req], status: "idle" } }; },
    async respondToPermission(value) { calls.push(["respond", value]); return handlers.respond?.(value); },
  }; } } } };
}

test("submission rechecks the exact agent before delivering the native answer", async () => {
  const req = request(), state = client(req), response = { behavior: "allow", updatedInput: { ...req.input, answers: { Direction: "Small" } } };
  await respondToNativeQuestion(state.api, "remote-host", "remote-agent", req, response);
  assert.deepEqual(state.calls, [["ref", "remote-agent"], ["refresh"], ["respond", { requestId: req.id, response }]]);
});

test("answers made in chat, changed questions and unavailable agents reject stale submissions", async () => {
  const req = request();
  for (const [agent, message] of [
    [{ pendingPermissions: [], status: "idle" }, /no longer waiting/],
    [{ pendingPermissions: [request([question({ options: [{ label: "Changed" }] })])], status: "idle" }, /questions changed/],
    [{ pendingPermissions: [req], status: "closed" }, /unavailable/],
    [{ pendingPermissions: [req], archivedAt: "yesterday" }, /unavailable/],
    [null, /unavailable/],
  ]) {
    const state = client(req, { refresh: async () => ({ agent }) });
    await assert.rejects(respondToNativeQuestion(state.api, "host", "agent", req, { behavior: "allow" }), message);
    assert.equal(state.calls.some(([kind]) => kind === "respond"), false);
  }
});

test("overlapping surfaces cannot submit twice, and identical IDs on other hosts stay independent", async () => {
  const req = request(); let finish;
  const first = client(req, { refresh: () => new Promise(resolve => { finish = resolve; }) });
  const pending = respondToNativeQuestion(first.api, "host-A", "agent", req, { behavior: "deny" });
  const second = client(req);
  await assert.rejects(respondToNativeQuestion(second.api, "host-A", "agent", req, { behavior: "deny" }), /already being sent/);
  assert.equal(second.calls.length, 0);
  await respondToNativeQuestion(second.api, "host-B", "agent", req, { behavior: "deny" });
  finish({ agent: { pendingPermissions: [req], status: "idle" } }); await pending;
  assert.equal(first.calls.filter(([kind]) => kind === "respond").length, 1);
});

test("a transport failure releases the submission guard for a checked retry", async () => {
  const req = request(), failure = client(req, { respond: () => { throw new Error("Offline"); } });
  await assert.rejects(respondToNativeQuestion(failure.api, "host", "agent", req, { behavior: "deny" }), /Offline/);
  const retry = client(req);
  await respondToNativeQuestion(retry.api, "host", "agent", req, { behavior: "deny" });
  assert.equal(retry.calls.filter(([kind]) => kind === "respond").length, 1);
});

test("polling keeps draft identity stable while a changed request changes identity", () => {
  const req = request();
  assert.equal(questionRequestVersion(req), questionRequestVersion(structuredClone(req)));
  assert.notEqual(questionRequestVersion(req), questionRequestVersion({ ...req, id: "req-2" }));
  assert.notEqual(questionRequestVersion(req), questionRequestVersion(request([question({ multiSelect: true })])));
});
