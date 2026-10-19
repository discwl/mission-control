import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { test } from "node:test";

const require = createRequire(import.meta.url);
const ts = require("typescript");
require.extensions[".ts"] = (module, file) => module._compile(ts.transpileModule(readFileSync(file, "utf8"), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText, file);
const { agentMessageHeadline, agentMessageOf, firstPromptText, promptText } = require("./agent-messages.ts");

// A row as Paseo 0.12 projects an agent message.
const fromAgent = (event, text, title = "Planner") => ({
  type: "tool_call", callId: `paseo-agent-message:${event}`, name: "agent_message", status: "completed", error: null,
  agentMessage: { event, sender: { id: "agent-parent", ...(title ? { title } : {}) }, text },
  detail: { type: "plain_text", text, icon: "bot" },
});

test("an agent message is read from its row; other rows and malformed ones are not", () => {
  assert.deepEqual(agentMessageOf(fromAgent("message", "Review task 23")), { event: "message", sender: { id: "agent-parent", title: "Planner" }, text: "Review task 23" });
  assert.equal(agentMessageOf(fromAgent("message", "x", "")).sender.title, null, "an empty title is no title");
  assert.equal(agentMessageOf({ type: "tool_call", name: "shell", detail: { type: "shell", command: "ls" } }), null);
  assert.equal(agentMessageOf({ type: "user_message", text: "Hello" }), null);
  assert.equal(agentMessageOf({ ...fromAgent("message", "x"), agentMessage: { event: "unknown", sender: { id: "a" }, text: "x" } }), null);
  assert.equal(agentMessageOf({ ...fromAgent("message", "x"), agentMessage: { event: "message", sender: {}, text: "x" } }), null);
  assert.equal(agentMessageOf(null), null);
});

test("an agent's first prompt is its first user message, or on Paseo 0.12 the first message another agent sent", () => {
  assert.equal(firstPromptText([{ type: "assistant_message", text: "Hi" }, { type: "user_message", text: "Fix the parser" }, fromAgent("message", "Later")]), "Fix the parser");
  assert.equal(firstPromptText([fromAgent("finished", "Child done"), fromAgent("message", "Review task 23"), { type: "user_message", text: "Later" }]), "Review task 23", "notices are not prompts");
  assert.equal(firstPromptText([{ type: "assistant_message", text: "Hi" }]), null);
  assert.equal(promptText(fromAgent("errored", "Child failed")), null);
  assert.equal(promptText({ type: "user_message", text: "Go" }), "Go");
});

test("headlines name the sender, or say another agent when it has no title", () => {
  assert.equal(agentMessageHeadline(agentMessageOf(fromAgent("message", "x"))), "Message from Planner");
  assert.equal(agentMessageHeadline(agentMessageOf(fromAgent("message", "x", null))), "Message from another agent");
  assert.equal(agentMessageHeadline(agentMessageOf(fromAgent("finished", "x"))), "Planner finished");
  assert.equal(agentMessageHeadline(agentMessageOf(fromAgent("errored", "x", null))), "An agent stopped with an error");
  assert.equal(agentMessageHeadline(agentMessageOf(fromAgent("permission-required", "x"))), "Planner needs permission");
  assert.equal(agentMessageHeadline(agentMessageOf(fromAgent("closed", "x"))), "Planner closed");
});
