import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

const require = createRequire(import.meta.url);
const ts = require("typescript");
require.extensions[".ts"] = (module, file) => module._compile(ts.transpileModule(readFileSync(file, "utf8"), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText, file);
const { createQuestionStore, replyMessage } = require("./questions.ts");

const markdown = fields => `---\n${Object.entries(fields).map(([key, value]) => `${key}: ${JSON.stringify(value)}`).join("\n")}\n---\n\n# Question\n`;
const ids = {
  serverId: "srv_test", workspaceId: "wks_test",
  taskId: "task_aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa", runId: "run_bbbbbbbb-bbbb-4bbb-bbbb-bbbbbbbbbbbb",
  questionId: "question_cccccccc-cccc-4ccc-cccc-cccccccccccc",
};
const plain = { status: "The pause button works.", need: "Should notes live with the task or the run?", recommendation: "With the task." };

async function fixture(t, { status = "open", agent: agentOverrides = {} } = {}) {
  const root = await mkdtemp(join(tmpdir(), "mission-questions-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const folder = join(root, ids.taskId);
  const questions = join(folder, "runs", ids.runId, "questions");
  await mkdir(questions, { recursive: true });
  const file = join(questions, `${ids.questionId}.md`);
  await writeFile(file, markdown({
    schemaVersion: 1, ...ids, agentId: "agent-1", status, question: "Task or run?", askedAt: "2026-09-28T10:00:00Z", answeredAt: null, answer: null, plain,
  }));
  const tasks = [
    { taskId: ids.taskId, projectId: "prj_test", title: "24 · Attention cards", assignments: [{ serverId: ids.serverId, workspaceId: ids.workspaceId }] },
    { taskId: "task_dddddddd-dddd-4ddd-dddd-dddddddddddd", projectId: "prj_test", title: "25 · Sub-agents", assignments: [{ serverId: ids.serverId, workspaceId: "wks_other" }] },
  ];
  const agent = { id: "agent-1", workspaceId: ids.workspaceId, status: "idle", activeTurn: null, pendingPermissions: [], archivedAt: null, ...agentOverrides };
  const sent = [];
  const paseo = { agents: { ref: id => ({
    refresh: async () => ({ agent: { ...agent, id } }),
    send: async (text, options) => { sent.push({ id, text, options }); },
  }) } };
  const store = createQuestionStore({ sources: async serverId => {
    assert.equal(serverId, ids.serverId);
    return tasks.map(task => ({ task, folder: task.taskId === ids.taskId ? folder : null, file: "task.md" }));
  } });
  return { store, paseo, sent, file };
}

test("open questions are listed with their task, and every task's title is available for task lines", async t => {
  const { store } = await fixture(t);
  const { questions, taskTitles } = await store.list(ids.serverId);
  assert.deepEqual(questions.map(entry => [entry.question.questionId, entry.taskTitle, entry.question.plain.need]), [[ids.questionId, "24 · Attention cards", plain.need]]);
  assert.deepEqual(taskTitles, { [ids.taskId]: "24 · Attention cards", "task_dddddddd-dddd-4ddd-dddd-dddddddddddd": "25 · Sub-agents" });
});

test("answered and replaced questions are not listed", async t => {
  for (const status of ["answered", "replaced"]) {
    const { store } = await fixture(t, { status });
    assert.deepEqual((await store.list(ids.serverId)).questions, []);
  }
});

test("a reply goes to the agent that asked, once, and marks the question answered", async t => {
  const { store, paseo, sent, file } = await fixture(t);
  const { question } = await store.reply({ ...ids, text: "  With the task.  " }, paseo);
  assert.equal(question.status, "answered");
  assert.equal(question.answer, "With the task.");
  assert.deepEqual(sent.map(item => [item.id, item.options]), [["agent-1", { messageId: ids.questionId }]]);
  assert.equal(sent[0].text, replyMessage(question, "With the task."));
  assert.match(sent[0].text, /^Reply from the user in Mission Control to your question question_[\w-]+ \("Task or run\?"\):\nWith the task\.\n/);
  assert.match(await readFile(file, "utf8"), /^status: "answered"$/m);
  assert.deepEqual((await store.list(ids.serverId)).questions, [], "the card clears once answered");
  await assert.rejects(store.reply({ ...ids, text: "Again" }, paseo), /already answered/);
  assert.equal(sent.length, 1);
});

test("a reply is refused, and nothing is sent, when the agent can't take it", async t => {
  for (const [agent, pattern] of [
    [{ archivedAt: "2026-09-28T11:00:00Z" }, /unavailable or archived/],
    [{ workspaceId: "wks_elsewhere" }, /moved to another workspace/],
    [{ status: "running" }, /busy/],
    [{ lastUserMessageAt: "2026-09-28T11:00:00Z" }, /newer message/],
  ]) {
    const { store, paseo, sent, file } = await fixture(t, { agent });
    await assert.rejects(store.reply({ ...ids, text: "Go" }, paseo), pattern);
    assert.equal(sent.length, 0);
    assert.match(await readFile(file, "utf8"), /^status: "open"$/m);
  }
  const { store, paseo } = await fixture(t);
  await assert.rejects(store.reply({ ...ids, workspaceId: "wks_other", text: "Go" }, paseo), /not assigned/);
});

test("simultaneous different replies cannot diverge from the accepted answer", async t => {
  const { store, paseo, sent, file } = await fixture(t);
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  let started;
  const entered = new Promise(resolve => { started = resolve; });
  const original = paseo.agents.ref;
  paseo.agents.ref = id => ({ ...original(id), send: async (text, options) => { await original(id).send(text, options); started(); await gate; } });
  const first = store.reply({ ...ids, text: "FIRST" }, paseo);
  await entered;
  const second = store.reply({ ...ids, text: "SECOND" }, paseo);
  const rejected = assert.rejects(second, /already answered|being updated/);
  release();
  await Promise.all([first, rejected]);
  assert.equal(sent.length, 1);
  assert.match(sent[0].text, /\nFIRST\n/);
  assert.match(await readFile(file, "utf8"), /^answer: "FIRST"$/m);
});

test("a lost send acknowledgement preserves the original text and refuses blind resends", async t => {
  const { store, paseo, sent, file } = await fixture(t);
  const original = paseo.agents.ref;
  paseo.agents.ref = id => ({ ...original(id), send: async (text, options) => { await original(id).send(text, options); throw new Error("ack lost"); } });
  await assert.rejects(store.reply({ ...ids, text: "FIRST" }, paseo), /delivery is unconfirmed/);
  await assert.rejects(store.reply({ ...ids, text: "SECOND" }, paseo), /delivery is unconfirmed/);
  await assert.rejects(store.reply({ ...ids, text: "FIRST" }, paseo), /delivery is unconfirmed/);
  assert.equal(sent.length, 1);
  assert.match(await readFile(file, "utf8"), /^status: "open"$/m);
  const { questions } = await store.list(ids.serverId);
  assert.equal(questions[0].question.delivery.text, "FIRST");
});
