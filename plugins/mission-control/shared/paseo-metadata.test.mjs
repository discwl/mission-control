import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { test } from "node:test";

const require = createRequire(import.meta.url);
const ts = require("typescript");
require.extensions[".ts"] = (module, file) => module._compile(ts.transpileModule(readFileSync(file, "utf8"), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText, file);
const {
  buildDeliveryTextPrompt, DELIVERY_TEXT_SYSTEM_PROMPT, deliveryTextOutputSchema, finishGeneratedBody, instructionsFromText, maxTemplateChars, parseDeliveryText, pullRequestFooter,
  templateForModel, unwrap, withTicketKey, writeDeliveryText,
} = require("./paseo-metadata.ts");
const { runMerge } = require("./merge.ts");
const { runPullRequest } = require("./pull-request.ts");
const { extractJson } = require("./small-model.ts");

const request = {
  title: "ABC-7 · Add greeting", ticketKey: "ABC-7", summary: "Adds a greeting file.",
  commitInstructions: "Use Conventional Commits.", pullRequestInstructions: "Start the body with ## Why.",
};
const taskId = "task_1234abcd-0000-4000-8000-000000000000";

test("the prompt holds only the task's title, ticket key, handoff summary and the instructions", () => {
  const prompt = buildDeliveryTextPrompt(request);
  const data = JSON.parse(prompt.slice(prompt.indexOf("\n\n") + 2));
  assert.deepEqual(data, {
    task: { title: "ABC-7 · Add greeting", ticket: "ABC-7", handoffSummary: "Adds a greeting file." },
    repositoryInstructions: { commitMessage: "Use Conventional Commits.", pullRequest: "Start the body with ## Why." },
  });
  assert.match(prompt, /^Write the commit message and the pull request's title and body/);
  assert.deepEqual(deliveryTextOutputSchema(request).required, ["commitMessage", "title", "body"]);
  // Only what paseo.json has instructions for is asked for.
  const commitOnly = { ...request, pullRequestInstructions: null };
  assert.deepEqual(JSON.parse(buildDeliveryTextPrompt(commitOnly).split("\n\n").slice(1).join("\n\n")).repositoryInstructions, { commitMessage: "Use Conventional Commits." });
  assert.deepEqual(deliveryTextOutputSchema(commitOnly).required, ["commitMessage"]);
});

test("the answer's parts are cleaned, and a small model's variant keys are accepted", () => {
  assert.deepEqual(parseDeliveryText(extractJson('```json\n{"commitMessage":"feat: add greeting\\r\\n\\nBody.","title":"feat: add greeting\\nsecond line","body":"## Why\\n\\nGreets."}\n```'), request), {
    commitMessage: "feat: add greeting\n\nBody.", title: "ABC-7: feat: add greeting", body: "## Why\n\nGreets.",
  });
  assert.deepEqual(parseDeliveryText({ commit_message: "\"fix: quote\"", description: "Text" }, request), { commitMessage: "fix: quote", body: "Text" });
  // Parts not asked for are dropped; an empty part is left to its default.
  assert.deepEqual(parseDeliveryText({ commitMessage: "feat: x", title: "t", body: "b" }, { ...request, pullRequestInstructions: null }), { commitMessage: "feat: x" });
  assert.deepEqual(parseDeliveryText({ commitMessage: "   ", title: "" }, request), {});
  assert.throws(() => parseDeliveryText("text", request), /did not match/);
});

/** A stand-in Paseo with Haiku, whose agent answers `answer` and records what it was given. */
function fakePaseo(answer, { models = [{ id: "claude-haiku-4-5", label: "Haiku 4.5" }], status = "idle" } = {}) {
  const seen = { created: null, archived: false, workspaceId: null };
  const paseo = {
    providers: {
      listModels: async provider => ({ models: provider === "claude" ? models : [] }),
      listModes: async () => ({ modes: [{ id: "default" }, { id: "read-only" }] }),
    },
    workspaces: { ref: workspaceId => ({ agents: { create: async options => {
      seen.workspaceId = workspaceId; seen.created = options;
      return { waitForFinish: async () => ({ status, lastMessage: answer, error: null }), timeline: { refetch: async () => ({ entries: [] }) }, archive: async () => { seen.archived = true; } };
    } } }) },
  };
  return { paseo, seen };
}

test("writing the text runs one read-only small-model agent in the task's workspace, given only the allowed facts", async () => {
  const ticket = { key: "ABC-7", url: "https://example.atlassian.net/browse/ABC-7" };
  const { paseo, seen } = fakePaseo('{"commitMessage":"feat: add greeting","title":"feat: add greeting","body":"## Why\\n\\nGreets."}');
  const written = await writeDeliveryText(paseo, "wks_task", request, { taskId, ticket });
  assert.deepEqual(written, {
    model: "Haiku 4.5",
    text: { commitMessage: "feat: add greeting", title: "ABC-7: feat: add greeting", body: `## Why\n\nGreets.\n\nTicket: [ABC-7](${ticket.url})\n\nOpened as a draft by Mission Control for task ${taskId}.` },
  });
  assert.equal(seen.workspaceId, "wks_task");
  assert.equal(seen.created.config.provider, "claude/claude-haiku-4-5");
  assert.equal(seen.created.config.modeId, "read-only");
  assert.equal(seen.created.labels["mission-control.role"], "delivery-writer");
  assert.equal(seen.created.prompt, buildDeliveryTextPrompt(request));
  assert.equal(seen.archived, true);
});

test("writing fails clearly without a small model, on a permission request, or with nothing usable, and the agent is archived", async () => {
  await assert.rejects(writeDeliveryText(fakePaseo("{}", { models: [{ id: "claude-opus", label: "Opus" }] }).paseo, "wks", request, { taskId }), /No small model is available/);
  const asked = fakePaseo("{}", { status: "permission" });
  await assert.rejects(writeDeliveryText(asked.paseo, "wks", request, { taskId }), /writing agent asked for a permission/);
  assert.equal(asked.seen.archived, true);
  await assert.rejects(writeDeliveryText(fakePaseo('{"commitMessage":""}').paseo, "wks", request, { taskId }), /none of the text asked for/);
  await assert.rejects(writeDeliveryText(fakePaseo("Sure! Here's a commit message.").paseo, "wks", request, { taskId }), /did not return JSON/);
});

test("only a fence or quotes wrapping the whole text are removed; closing marks that belong to it stay (review finding)", () => {
  assert.equal(unwrap('Revert "feat: add greeting"'), 'Revert "feat: add greeting"');
  assert.equal(unwrap("Rename `foo`"), "Rename `foo`");
  assert.equal(unwrap("`foo` is renamed"), "`foo` is renamed");
  const body = "## How to test\n\n```sh\nnpm test\n```";
  assert.equal(unwrap(body), body, "a body ending in a code block keeps its closing fence");
  const twoBlocks = "```sh\nnpm ci\n```\n\nThen:\n\n```sh\nnpm test\n```";
  assert.equal(unwrap(twoBlocks), twoBlocks, "two code blocks aren't one wrapping fence");
  assert.equal(unwrap('"fix: quote"'), "fix: quote");
  assert.equal(unwrap("'fix: quote'"), "fix: quote");
  assert.equal(unwrap('"a" and "b"'), '"a" and "b"');
  assert.equal(unwrap("```text\nfeat: add greeting\n\nBody.\n```"), "feat: add greeting\n\nBody.");
  assert.equal(unwrap('```\n"feat: x"\n```'), "feat: x");
  assert.deepEqual(parseDeliveryText({ commitMessage: 'Revert "feat: add greeting"', title: "Rename `foo`", body }, request), {
    commitMessage: 'Revert "feat: add greeting"', title: "ABC-7: Rename `foo`", body,
  });
});

test("the repository's pull request template goes to the model only with pull request instructions, trimmed and with keys hidden", () => {
  const template = "## What changed\n\n## How to test\n";
  const withTemplate = { ...request, pullRequestTemplate: template };
  const data = prompt => JSON.parse(prompt.slice(prompt.indexOf("\n\n") + 2));
  assert.equal(data(buildDeliveryTextPrompt(withTemplate)).repositoryInstructions.pullRequestTemplate, "## What changed\n\n## How to test");
  assert.match(DELIVERY_TEXT_SYSTEM_PROMPT, /template is given, the description keeps its sections and headings/);
  // Without pull request instructions (commit only), the template isn't sent.
  assert.equal(data(buildDeliveryTextPrompt({ ...withTemplate, pullRequestInstructions: null })).repositoryInstructions.pullRequestTemplate, undefined);
  assert.equal(data(buildDeliveryTextPrompt({ ...request, pullRequestTemplate: "   " })).repositoryInstructions.pullRequestTemplate, undefined);
  // Key-like strings and URL credentials are hidden.
  const secret = "ghp_" + "A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8";
  const masked = templateForModel(`## Notes\n\nToken: ${secret}\nMirror: https://bot:hunter2secret@example.com/repo.git\n`);
  assert.ok(!masked.includes(secret) && !masked.includes("hunter2secret"), masked);
  // A long template is cut at a line end, marked with an ellipsis.
  const long = Array.from({ length: 400 }, (_, index) => `- item ${index} with some words`).join("\n");
  const cut = templateForModel(long);
  assert.ok(cut.length <= maxTemplateChars + 2, String(cut.length));
  assert.match(cut, /with some words\n…$/);
  assert.equal(templateForModel(null), null);
});

test("a pull request title keeps the ticket key", () => {
  assert.equal(withTicketKey("Add greeting", "ABC-7"), "ABC-7: Add greeting");
  assert.equal(withTicketKey("feat(abc-7): add greeting", "ABC-7"), "feat(abc-7): add greeting");
  assert.equal(withTicketKey("Add greeting", null), "Add greeting");
  assert.equal(withTicketKey("x".repeat(250), "ABC-7").length, 200);
});

test("a generated body ends with the ticket link and Mission Control's line, without repeating a link it has", () => {
  const ticket = { key: "ABC-7", url: "https://example.atlassian.net/browse/ABC-7" };
  assert.deepEqual(pullRequestFooter({ taskId, ticket }), [`Ticket: [ABC-7](${ticket.url})`, `Opened as a draft by Mission Control for task ${taskId}.`]);
  assert.equal(finishGeneratedBody("## Why\n\nGreets.\n", { taskId, ticket }), `## Why\n\nGreets.\n\nTicket: [ABC-7](${ticket.url})\n\nOpened as a draft by Mission Control for task ${taskId}.`);
  assert.equal(finishGeneratedBody(`Fixes ${ticket.url}`, { taskId, ticket }), `Fixes ${ticket.url}\n\nOpened as a draft by Mission Control for task ${taskId}.`);
  assert.equal(finishGeneratedBody("Body", { taskId, ticket: null }), `Body\n\nOpened as a draft by Mission Control for task ${taskId}.`);
});

test("instructions come from paseo.json's metadataGeneration, trimmed", () => {
  const read = instructionsFromText(JSON.stringify({ metadataGeneration: { commitMessage: { instructions: " a " }, pullRequest: {}, title: { instructions: "not ours" } } }), "C:\\repo\\paseo.json", "source");
  assert.deepEqual(read, { commitMessage: "a", pullRequest: null, branchName: null, path: "C:\\repo\\paseo.json", where: "source", problem: null });
});

test("the confirmed text is checked before a run: not empty, and a one-line title", () => {
  const base = { serverId: "srv", taskId, fingerprint: "f" };
  assert.equal(runMerge.input.parse({ ...base, commitMessage: " feat: x \n" }).commitMessage, "feat: x");
  assert.equal(runMerge.input.safeParse({ ...base, commitMessage: "   " }).success, false);
  assert.equal(runMerge.input.parse(base).commitMessage, undefined);
  assert.equal(runPullRequest.input.safeParse({ ...base, title: "one\ntwo" }).success, false);
  assert.equal(runPullRequest.input.safeParse({ ...base, title: "x".repeat(201) }).success, false);
  assert.equal(runPullRequest.input.parse({ ...base, title: "ABC-7: ok", body: "" }).body, "");
});
