import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { test } from "node:test";
const require = createRequire(import.meta.url);
const ts = require("typescript");
require.extensions[".ts"] = (module, file) => module._compile(ts.transpileModule(readFileSync(file, "utf8"), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText, file);
const { createNeedsYouTimeline } = require("./needs-you-timeline.ts");
const question = (overrides = {}) => ({ question: { serverId: "local", workspaceId: "work", agentId: "agent", questionId: "question-1", status: "open", askedAt: "2026-10-01T10:00:00Z", ...overrides } });
function fixture(overrides = {}) {
  const rows = [], reads = [], appends = [];
  const agent = { workspaceId: "work", status: "idle", pendingPermissions: [], lastUserMessageAt: "2026-10-01T09:00:00Z", ...overrides };
  let fail = false, clock = 0;
  const paseo = { agents: { ref: agentId => ({ refresh: async () => { reads.push(agentId); return { agent }; }, timeline: { append: async row => { appends.push(row.id); if (fail) throw new Error(typeof fail === "string" ? fail : "append unavailable"); rows.push({ agentId, row }); } } }) } };
  return { rows, reads, appends, agent, paseo, service: createNeedsYouTimeline(async () => "local", () => clock), fail: value => { fail = value; }, advance: ms => { clock += ms; } };
}
test("existing questions are published without sending or waking a worker, once across concurrent reads", async () => {
  const f = fixture();
  await Promise.all([f.service.questions([question()], f.paseo), f.service.questions([question()], f.paseo)]);
  await f.service.questions([question()], f.paseo);
  assert.equal(f.rows.length, 1);
  assert.equal(f.reads.length, 1);
  assert.deepEqual(f.rows[0], { agentId: "agent", row: { type: "plugin", id: "needs-you:question:question-1", kind: "needs-you", version: 1, data: { serverId: "local", workspaceId: "work", agentId: "agent", requestId: "question-1", kind: "question" } } });
});
test("reload republishes the same row identity; two requests have distinct rows", async () => {
  const f = fixture();
  await f.service.questions([question()], f.paseo);
  await createNeedsYouTimeline(async () => "local").questions([question()], f.paseo);
  await f.service.questions([question({ questionId: "question-2" })], f.paseo);
  assert.equal(f.rows[0].row.id, f.rows[1].row.id);
  assert.notEqual(f.rows[1].row.id, f.rows[2].row.id);
});
test("wrong host, moved, archived, closed, answered and native permission requests do not get stale question rows", async () => {
  for (const change of [{ workspaceId: "elsewhere" }, { archivedAt: "today" }, { status: "closed" }, { pendingPermissions: [{}] }, { lastUserMessageAt: "2026-10-01T10:01:00Z" }]) {
    const f = fixture(change);
    await f.service.questions([question()], f.paseo);
    assert.deepEqual(f.rows, []);
  }
  const f = fixture();
  await f.service.questions([question({ serverId: "remote" }), question({ status: "answered" })], f.paseo);
  assert.deepEqual(f.reads, []);
});
test("append failures leave Attention usable and are retried after a wait", async t => {
  t.mock.method(console, "warn", () => {});
  const f = fixture(); f.fail(true);
  await f.service.questions([question()], f.paseo);
  f.fail(false);
  await f.service.questions([question()], f.paseo);
  assert.equal(f.rows.length, 0, "not tried again on the next poll");
  f.advance(60_000);
  await f.service.questions([question()], f.paseo);
  assert.equal(f.rows.length, 1);
});
test("an agent Paseo hasn't loaded since a restart is retried after growing waits and logged once", async t => {
  const warnings = [];
  t.mock.method(console, "warn", message => warnings.push(message));
  const f = fixture(); f.fail("Request failed: Unknown agent 'agent' requestType=agent.timeline.append.request code=handler_error");
  // Polls every 15 seconds for 10 minutes: tries at 0, 1, 3 and 7 minutes.
  for (let second = 0; second < 600; second += 15) { await f.service.questions([question()], f.paseo); f.advance(15_000); }
  assert.equal(f.appends.length, 4);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /Unknown agent .* \(trying again in 1 min\)$/);
  // Once someone opens the chat the agent loads, and the next try publishes the row.
  f.fail(false); f.advance(8 * 60_000);
  await f.service.questions([question()], f.paseo);
  assert.equal(f.rows.length, 1);
  assert.equal(warnings.length, 1);
});
test("plan and review use decision identities and never publish resolved or unlinked requests", async () => {
  const f = fixture();
  const decision = { serverId: "local", workspaceId: "work", agentId: "agent", status: "open", requestedAt: "2026-10-01T10:00:00Z" };
  await f.service.decisions([
    { decision: { ...decision, decisionId: "plan-1", kind: "plan" } },
    { decision: { ...decision, decisionId: "review-1", kind: "review" } },
    { decision: { ...decision, decisionId: "resolved", status: "approved" } },
    { decision: { ...decision, decisionId: "unlinked", agentId: null } },
  ], f.paseo);
  assert.deepEqual(f.rows.map(({ row }) => row.id).sort(), ["needs-you:decision:plan-1", "needs-you:decision:review-1"]);
});
