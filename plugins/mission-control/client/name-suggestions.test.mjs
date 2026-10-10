import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { test } from "node:test";

const require = createRequire(import.meta.url);
const ts = require("typescript");
require.extensions[".ts"] = (module, file) => module._compile(ts.transpileModule(readFileSync(file, "utf8"), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText, file);
const { buildNamingPrompt, cleanName, contextAgents, parseSuggestions, pickMessages, pickNamingModel, readUserMessages, suggestionIds } = require("./name-suggestions.ts");

const workspace = {
  id: "wks_1", currentName: "New workspace", projectName: "development-flow", suggest: true,
  tasks: [{ title: "Rename workspaces from chat", status: "ready" }],
  agents: [
    { id: "agent_1", name: "Claude agent", suggest: true, messages: ["Add rename suggestions to Mission Control"] },
    { id: "agent_2", name: "Tests", suggest: false, messages: [] },
  ],
};

test("keeps the first and latest prompts, trimmed and without repeats", () => {
  const messages = ["  first\n goal ", "second", "second", "third", "fourth", "fifth", "sixth"];
  assert.deepEqual(pickMessages(messages), ["first goal", "second", "third", "fifth", "sixth"]);
  assert.equal(pickMessages(["x".repeat(900)])[0].length, 600);
});

test("the prompt carries titles, tasks, user prompts and which names to suggest", () => {
  const prompt = buildNamingPrompt([workspace]);
  assert.match(prompt, /"id": "wks_1"/);
  const data = JSON.parse(prompt.split("\n\n").at(-1));
  assert.deepEqual(data.workspaces[0].tasks, [{ title: "Rename workspaces from chat", status: "ready", ticket: null }]);
  assert.match(prompt, /Add rename suggestions to Mission Control/);
  assert.match(prompt, /"id": "agent_2",\s*"suggestName": false/);
  assert.deepEqual(suggestionIds([workspace]), ["wks_1", "agent_1"]);
  assert.deepEqual(suggestionIds([{ ...workspace, suggest: false }]), ["agent_1"]);
});

test("workspace naming carries exact Jira and ADO identities without inventing a ticket for manual tasks", () => {
  const tasks = [
    { title: "Fix login", status: "ready", ticket: { system: "jira", key: "APP-123", url: "https://tracker.example/APP-123" } },
    { title: "Update export", status: "in_progress", ticket: { system: "azure-devops", key: "12345", url: "https://tracker.example/12345" } },
    { title: "Local improvement", status: "ready" },
  ];
  const prompt = buildNamingPrompt([{ ...workspace, tasks }]);
  const data = JSON.parse(prompt.split("\n\n").at(-1));
  assert.deepEqual(data.workspaces[0].tasks, [
    { title: "Fix login", status: "ready", ticket: { system: "jira", key: "APP-123" } },
    { title: "Update export", status: "in_progress", ticket: { system: "azure-devops", key: "12345" } },
    { title: "Local improvement", status: "ready", ticket: null },
  ]);
  for (const name of ["APP-123 · Fix Login Timeout", "12345 · Update Export Format"]) {
    assert.equal(parseSuggestions(JSON.stringify({ suggestions: [{ id: workspace.id, name }] }), [workspace.id]).get(workspace.id).name, name);
  }
});

test("reads a long chat's first prompts from the start of the timeline and its latest from the end", async () => {
  const user = text => ({ item: { type: "user_message", text } });
  const calls = [];
  const timeline = {
    async refetch(options) {
      calls.push(options.direction);
      return options.direction === "after"
        ? { hasNewer: true, entries: [user("first"), { item: { type: "assistant_message", text: "reply" } }, user("second")] }
        : { hasNewer: false, entries: [user("latest")] };
    },
  };
  assert.deepEqual(await readUserMessages(timeline), ["first", "second", "latest"]);
  assert.deepEqual(calls, ["after", "tail"]);
  const short = { async refetch() { return { hasNewer: false, entries: [user("only")] }; } };
  assert.deepEqual(await readUserMessages(short), ["only"]);
});

test("reads only the most recent agents plus the ones being renamed", () => {
  const agents = Array.from({ length: 9 }, (_, index) => ({ id: `a${index}`, updatedAt: new Date(2026, 8, 1 + index).toISOString() }));
  const chosen = contextAgents(agents, new Set(["a0"]), 6).map(agent => agent.id);
  assert.deepEqual(chosen, ["a0", "a3", "a4", "a5", "a6", "a7", "a8"]);
  assert.equal(contextAgents(agents, new Set()).length, 6);
});

test("parses fenced JSON and drops unknown, empty and duplicate ids", () => {
  const text = "```json\n" + JSON.stringify({ suggestions: [
    { id: "wks_1", name: " \"Chat-Based Renaming.\" ", reason: "Matches the task" },
    { id: "wks_1", name: "Second pick", reason: "" },
    { id: "wks_2", name: "   ", reason: "empty" },
    { id: "wks_other", name: "Not asked", reason: "" },
  ] }) + "\n```";
  const result = parseSuggestions(text, ["wks_1", "wks_2"]);
  assert.deepEqual([...result.entries()], [["wks_1", { name: "Chat-Based Renaming", reason: "Matches the task" }]]);
});

test("accepts the bare array and suggestedName shape Haiku returns when the schema isn't enforced", () => {
  const text = "```json\n" + JSON.stringify([{ id: "agent_1", suggestedName: "Autoharness Evaluation" }, { id: "agent_2", name: "Plugin Update Check" }]) + "\n```";
  const result = parseSuggestions(text, ["agent_1", "agent_2"]);
  assert.deepEqual([...result.entries()], [["agent_1", { name: "Autoharness Evaluation", reason: "" }], ["agent_2", { name: "Plugin Update Check", reason: "" }]]);
});

test("rejects answers that are not the expected JSON", () => {
  assert.throws(() => parseSuggestions("I could not decide.", ["wks_1"]), /did not return JSON/);
  assert.throws(() => parseSuggestions('{"names": []}', ["wks_1"]), /expected format/);
});

test("cleanName strips quotes, trailing dots and extra spaces", () => {
  assert.equal(cleanName("  ‘Task   Bridge’. "), "Task Bridge");
});

test("prefers Haiku, then Luna on low effort, and never a large model", () => {
  const claude = { provider: "claude", models: [{ id: "claude-opus-5-5", label: "Opus 5.5" }, { id: "claude-haiku-4-5", label: "Haiku 4.5" }] };
  const codex = { provider: "codex", models: [{ id: "gpt-6-astra", label: "GPT-6 Astra" }, { id: "gpt-6-luna", label: "GPT-6 Luna", thinkingOptions: [{ id: "low" }, { id: "high" }] }] };
  assert.deepEqual(pickNamingModel([claude, codex]), { provider: "claude/claude-haiku-4-5", label: "Haiku 4.5" });
  assert.deepEqual(pickNamingModel([{ provider: "claude", models: [] }, codex]), { provider: "codex/gpt-6-luna", label: "GPT-6 Luna (low)", thinkingOptionId: "low" });
  assert.equal(pickNamingModel([{ provider: "codex", models: [{ id: "gpt-6-astra", label: "GPT-6 Astra" }] }]), null);
});
