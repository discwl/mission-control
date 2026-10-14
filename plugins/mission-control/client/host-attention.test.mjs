import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { test } from "node:test";

const require = createRequire(import.meta.url);
const ts = require("typescript");
require.extensions[".ts"] = (module, file) => module._compile(ts.transpileModule(readFileSync(file, "utf8"), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText, file);
const { hostAttentionCount, hostAttentionLabel, noAttentionReads, readHostAttention } = require("./host-attention.ts");

const serverId = "srv_acme";
const agent = (id, extra = {}) => ({ id, workspaceId: "w1", name: id, status: "idle", archivedAt: null, requiresAttention: false, attentionReason: null, attentionTimestamp: null, lastUserMessageAt: null, permissions: [], taskId: null, ...extra });
const roster = agents => ({ workspaces: [{ id: "w1", name: "ABC-1", projectName: "web" }], agents });
const question = (agentId, extra = {}) => ({ question: { questionId: `q-${agentId}`, status: "open", serverId, agentId, workspaceId: "w1", askedAt: "2026-10-14T10:00:00Z", ...extra }, taskTitle: "ABC-1", projectId: "p" });

test("prompts, open questions, agent errors and open decisions count; a finished agent doesn't", () => {
  const host = roster([
    agent("prompt", { status: "running", requiresAttention: true, attentionReason: "permission", permissions: [{ id: "p1" }, { id: "p2" }] }),
    agent("asking", { requiresAttention: true }),
    agent("failed", { requiresAttention: true, attentionReason: "error", attentionTimestamp: "2026-10-14T09:00:00Z" }),
    agent("finished", { requiresAttention: true, attentionReason: "finished" }),
    agent("answered", { lastUserMessageAt: "2026-10-14T11:00:00Z" }),
  ]);
  const reads = { questions: [question("asking"), question("answered"), question("gone")], openDecisions: 3 };
  // 2 prompts + 1 question (the answered one and the gone agent's don't count) + 1 error + 3 decisions.
  assert.equal(hostAttentionCount({ serverId, label: "Acme", roster: host, reads }), 7);
  assert.equal(hostAttentionCount({ serverId, label: "Acme", roster: host, reads: noAttentionReads }), 3, "without Mission Control: prompts and errors");
  assert.equal(hostAttentionCount({ serverId, label: "Acme", roster: roster([agent("finished", { requiresAttention: true, attentionReason: "finished" })]), reads: noAttentionReads }), 0);
  assert.equal(hostAttentionLabel(4), "Attention · 4");
});

test("reads ask the host's copy, and a failed or unsupported read is null rather than zero", async () => {
  const calls = [];
  const copy = (fail = new Set(), missing = new Set()) => ({
    supports: name => !missing.has(name),
    rpc: async (name, input) => {
      calls.push([name, input]);
      if (fail.has(name)) throw new Error("offline");
      return name === "decisions.list" ? { open: [{}, {}], recent: [] } : { questions: [question("a")], taskTitles: {} };
    },
  });
  assert.deepEqual(await readHostAttention(serverId, null), noAttentionReads);
  const both = await readHostAttention(serverId, copy());
  assert.equal(both.openDecisions, 2);
  assert.equal(both.questions.length, 1);
  assert.deepEqual(calls.map(([name, input]) => [name, input.serverId]).sort(), [["attention.waiting", serverId], ["decisions.list", serverId]]);
  assert.deepEqual(await readHostAttention(serverId, copy(new Set(["decisions.list"]))), { questions: [question("a")], openDecisions: null });
  assert.deepEqual(await readHostAttention(serverId, copy(new Set(), new Set(["attention.waiting"]))), { questions: null, openDecisions: 2 });
});
