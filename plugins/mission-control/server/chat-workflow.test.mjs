import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
const require = createRequire(import.meta.url); const ts = require("typescript");
require.extensions[".ts"] = (module, file) => module._compile(ts.transpileModule(readFileSync(file, "utf8"), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText, file);
const { registerChatWorkflow } = require("./chat-workflow.ts");
const names = require("./agent-names.ts"), bindings = require("./orchestrator.ts"), transport = require("./chat-transport.ts");
const sha = "a".repeat(40), revision = "b".repeat(64);
const brief = { goal: "Prevent duplicate escrow numbers", before: "Duplicate values can be saved", after: "Duplicates show an error", included: ["Server validation"], deferred: ["Existing data cleanup"], affected: ["Real estate saves"], approach: ["Normalize and check the number"], successChecks: ["Test duplicate, edit and unique saves"], risks: ["Existing duplicates require correction"], scopeChange: "No additional scope", authorization: "Implementation only", changesSincePrevious: [] };
const entry = () => ({ revision: "request1", summary: "Validate escrow numbers", taskTitle: "CDR-1316 · Duplicate escrow number", projectId: "p", findings: [], resolvedFindings: [], unverifiedFindings: 0, decision: { schemaVersion: 1, decisionId: "decision_a", taskId: "task_a", runId: "run_a", serverId: "local", workspaceId: "w", agentId: "worker", kind: "plan", status: "open", question: "Approve the plan?", requestedAt: "2026-10-28T00:00:00Z", gitHead: sha, gitDirty: false, evidence: [], findingIds: [], resolvedAt: null, note: null, resume: null, candidate: { head: sha, tree: sha }, plain: null } });
async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "mc-chat-flow-")); const previous = process.env.PASEO_HOME; process.env.PASEO_HOME = root;
  t.after(async () => { if (previous === undefined) delete process.env.PASEO_HOME; else process.env.PASEO_HOME = previous; await rm(root, { recursive: true, force: true }); });
  t.mock.method(names, "daemonServerId", async () => "local"); t.mock.method(bindings, "readOrchestratorBindings", async () => ({ bindings: {}, problems: {} }));
  const calls = [], handlers = new Map(), hooks = new Map(); let current = entry(); let canApprove = true;
  const plan = { taskTitle: current.taskTitle, forge: "github", repository: "owner/repo", webUrl: "https://github.com/owner/repo", remote: "https://github.com/owner/repo.git", targetBranch: "main", taskBranch: "task/escrow", worktreeDirectory: "C:/fixture", worktreeWorkspaceId: "w", uncommittedFiles: [], uncommittedCount: 0, undoneFiles: [], undoneCount: 0, commitMessage: "Fix escrow", commitsAhead: 1, pushCommit: sha, title: "Fix duplicate escrow numbers", body: "Adds validation and tests.", template: null, templateText: null, workItem: null, commands: [], fingerprint: "exact-tree-and-text" };
  const deps = { decisions: { list: async () => ({ open: current.decision.status === "open" ? [structuredClone(current)] : [], recent: current.decision.status === "open" ? [] : [structuredClone(current)] }), plan: async () => ({ source: "snapshot", revision, documentRevision: revision, requestedAt: current.decision.requestedAt, markdown: "# Plan", brief, previous: null, currentMatch: canApprove, canApprove, warning: canApprove ? null : "Plan changed" }), resolve: async input => {
    if (input.expectedRevision !== current.revision) throw new Error("The request changed");
    if (input.outcome === "approved" && input.expectedPlanRevision !== revision) throw new Error("Wrong plan revision");
    calls.push({ operation: "decision", input }); current.decision.status = input.outcome; return structuredClone(current);
  } }, questions: { list: async () => ({ questions: [], taskTitles: {} }) }, pullRequests: { check: async () => ({ taskId: "task_a", applies: true, ready: true, checks: [], plan }), start: async input => { calls.push({ operation: "PR", input }); return { outcome: "opened", forge: "github", url: "https://github.com/owner/repo/pull/1", number: 1, committed: null, pushed: sha, steps: [] }; } } };
  registerChatWorkflow({ handle: (contract, fn) => handlers.set(contract.name, fn), on: (name, fn) => hooks.set(name, fn) }, deps);
  const paseo = { agents: { ref: id => ({ refresh: async () => ({ agent: { id, workspaceId: "w", archivedAt: null } }) }) } };
  return { command: (text, extra = {}) => handlers.get("chat.command")({ agentId: "coordinator", text, ...extra }, { paseo }), handlers, calls, deps, current, canApprove: value => { canApprove = value; }, paseo, root };
}
test("chat uses the saved brief and exact revision; plan approval never publishes", async t => {
  const f = await fixture(t); const shown = await f.command("plan CDR-1316");
  for (const value of [brief.goal, brief.before, brief.after, ...brief.included, ...brief.deferred, ...brief.successChecks, ...brief.risks]) assert.ok(shown.text.includes(value));
  assert.equal(f.calls.length, 0);
  const result = await f.command(`yes approve ${shown.offerId}`); assert.match(result.text, /Approved/);
  assert.equal(f.calls.length, 1); assert.equal(f.calls[0].operation, "decision"); assert.equal(f.calls[0].input.expectedPlanRevision, revision); assert.equal(f.calls[0].input.expectedRevision, "request1");
  await f.command(`yes approve ${shown.offerId}`); assert.equal(f.calls.length, 1);
});
test("explicitly viewed tasks appear only in that conversation's menu and retain receipt identity", async t => {
  const f = await fixture(t), scope = { conversationId: "telegram:topic2:owner" };
  t.mock.method(bindings, "readOrchestratorBindings", async () => ({ bindings: { w: { serverId: "local", label: "AACN" } }, problems: {} }));
  await f.command("plan CDR-1316", scope);
  const needs = await f.command("needs", scope);
  assert.equal(needs.context.type, "summary"); assert.equal(needs.context.taskId, undefined);
  assert.ok(needs.actions.some(a => a.command === "plan decision_a"));
  const other = await f.command("needs", { conversationId: "telegram:topic17:owner" });
  assert.ok(!other.actions?.some(a => a.command === "plan decision_a"));
  const proposal = await f.command("plan CDR-1316", scope);
  assert.equal(proposal.context.taskId, "task_a"); assert.equal(proposal.context.waitingOn, "You");
  const receipt = await f.command(`yes approve ${proposal.offerId}`, scope);
  assert.equal(receipt.context.type, "receipt"); assert.equal(receipt.context.taskId, "task_a");
  assert.deepEqual((await f.command(`yes approve ${proposal.offerId}`, scope)).context, receipt.context);
  const refreshed = await f.command("decision status task_a", scope);
  assert.equal(refreshed.context.type, "receipt");
  assert.equal(f.calls.length, 1);
});

test("pre-upgrade offers gain metadata while preserving the exact proposal ID and expiry", async t => {
  const f = await fixture(t), { createChatActions } = require("./chat-actions.ts");
  const actions = createChatActions(join(f.root, "legacy-offers.json"));
  const input = { owner: "topic2", target: "local", title: "Task", kind: "plan", text: "Exact saved plan", input: { taskId: "task_a", expectedRevision: "one" } };
  const legacy = await actions.prepare(input);
  const upgraded = await actions.prepare({ ...input, context: { host: "AACN", taskId: "task_a", type: "plan", observedAt: "2026-10-28T00:00:00Z", evidence: "saved_record" } });
  assert.equal(upgraded.id, legacy.id); assert.equal(upgraded.expiresAt, legacy.expiresAt);
  assert.equal(upgraded.state, "pending"); assert.equal(upgraded.context.taskId, "task_a");
  assert.deepEqual(upgraded.input, legacy.input);
});

test("an earlier receipt points to a newer request without approving it or promising a stale retry", () => {
  const { decisionReceipt } = require("./chat-message.ts");
  const old = entry(); old.decision.status = "changes_requested"; old.decision.resume = { phase: "pending", updatedAt: "2026-10-28T01:00:00Z", error: null };
  const newer = entry(); newer.decision.decisionId = "decision_new"; newer.decision.requestedAt = "2026-10-28T02:00:00Z";
  const result = decisionReceipt(old, "AACN", [old, newer]);
  assert.match(result.context.status, /Earlier decision/);
  assert.match(result.context.waitingOn, /newer request/);
  assert.match(result.context.actionNeeded, /newer request/);
  assert.doesNotMatch(result.context.nextStep, /retried|Worker continues/);
  assert.equal(newer.decision.status, "open");
});

test("legacy or changed plan cannot create an approvable proposal", async t => {
  const f = await fixture(t); f.canApprove(false); const shown = await f.command("plan CDR-1316");
  assert.equal(shown.offerId, undefined); assert.match(shown.text, /fresh readable proposal/);
  await f.command("yes approve"); assert.equal(f.calls.length, 0);
});
test("changed decision after display is refused, and another conversation cannot consume it", async t => {
  const f = await fixture(t); const shown = await f.command("plan CDR-1316", { conversationId: "telegram:topic2:owner" });
  await f.command(`yes approve ${shown.offerId}`, { conversationId: "telegram:topic17:owner" }); assert.equal(f.calls.length, 0);
  f.current.revision = "request2";
  const reply = await f.command(`yes approve ${shown.offerId}`, { conversationId: "telegram:topic2:owner" }); assert.equal(reply.state, "uncertain"); assert.equal(f.calls.length, 0);
});
test("draft PR has a separate exact preview and confirmation; generic approval cannot publish", async t => {
  const f = await fixture(t); const shown = await f.command("draft PR task_a"); assert.match(shown.text, /task\/escrow → main/);
  await f.command(`yes approve ${shown.offerId}`); assert.equal(f.calls.length, 0);
  const reply = await f.command(`open draft PR ${shown.offerId}`); assert.match(reply.text, /Draft PR #1 opened/);
  assert.equal(f.calls.length, 1); assert.equal(f.calls[0].operation, "PR"); assert.equal(f.calls[0].input.fingerprint, "exact-tree-and-text"); assert.equal(f.calls[0].input.dryRun, false);
});
test("fresh readable plan request revises the same task without approving it", async t => {
  const f = await fixture(t); await f.command("refresh plan CDR-1316");
  assert.equal(f.calls[0].input.taskId, "task_a"); assert.equal(f.calls[0].input.outcome, "changes_requested"); assert.match(f.calls[0].input.note, /Wait for my approval/);
});
test("blocking question answers go to the exact question and are not plan approvals", async t => {
  const f = await fixture(t);
  const question = { schemaVersion: 1, questionId: "question_a", taskId: "task_a", runId: "run_a", serverId: "local", workspaceId: "w", agentId: "worker", status: "open", question: "Should existing duplicates be preserved?", askedAt: "2026-10-28T00:00:00Z", answeredAt: null, answer: null, plain: null };
  f.deps.questions.list = async () => ({ questions: [{ question, taskTitle: f.current.taskTitle, projectId: "p" }], taskTitles: {} });
  const answers = []; f.deps.questions.reply = async input => { answers.push(input); return { question: { ...question, status: "answered", answer: input.text } }; };
  const shown = await f.command("question task_a"); await f.command("yes approve", { offerId: shown.offerId }); assert.equal(answers.length, 0);
  const reply = await f.command("answer: Preserve existing duplicates", { offerId: shown.offerId });
  assert.match(reply.text, /Answer recorded/); assert.equal(answers[0].questionId, "question_a"); assert.equal(answers[0].text, "Preserve existing duplicates"); assert.equal(f.calls.length, 0);
});
test("automatic inbox shows only linked current decisions and creates no approvals", async t => {
  const f = await fixture(t); f.current.decision.serverId = "remote";
  t.mock.method(bindings, "readOrchestratorBindings", async () => ({ bindings: { w: { serverId: "remote", label: "CNS" } }, problems: {} }));
  const { createOrchestratorWorkStore } = require("./orchestrator-work.ts");
  await createOrchestratorWorkStore().set({ serverId: "local", agentId: "coordinator", remoteServerId: "remote", remoteAgentId: "worker", remoteWorkspaceId: "w", taskId: "task_a", linked: true });
  const other = entry(); Object.assign(other.decision, { taskId: "task_b", decisionId: "decision_b", agentId: "unrelated", serverId: "remote" }); other.taskTitle = "Unrelated task";
  t.mock.method(transport, "invokeChatHost", async (host, method, input) => {
    assert.equal(host, "remote"); assert.equal(input.serverId, "remote");
    if (method === "decisions.list") return { open: [f.current, other], recent: [] };
    if (method === "attention.waiting") return { questions: [], taskTitles: {} };
    if (method === "decisions.plan") return f.deps.decisions.plan(input);
    assert.fail(`Unexpected mutation ${method}`);
  });
  const read = () => f.handlers.get("chat.inbox")({ agentId: "coordinator", conversationId: "telegram:topic2:owner" }, { paseo: f.paseo });
  const one = await read(), two = await read();
  assert.equal(one.entries.length, 1); assert.match(one.entries[0].text, /Prevent duplicate escrow/); assert.equal(one.entries[0].id, two.entries[0].id); assert.equal(f.calls.length, 0);
});
test("review approval checks the current working tree and refuses changed code", async t => {
  const f = await fixture(t); f.current.decision.kind = "review";
  const merge = require("./merge.ts"); let actual = { head: sha, tree: "c".repeat(40) };
  t.mock.method(merge, "reviewCandidate", async path => { assert.equal(path, "C:/fixture"); return actual; });
  f.paseo.workspaces = { ref: id => ({ refresh: async () => ({ workspaceDirectory: "C:/fixture", archivingAt: null }) }) };
  let resolves = 0; f.deps.decisions.resolve = async input => { resolves++; return { ...f.current, decision: { ...f.current.decision, status: input.outcome } }; };
  const shown = await f.command("review task_a"); const refused = await f.command(`yes approve ${shown.offerId}`);
  assert.match(refused.text, /code changed/); assert.equal(refused.state, "rejected"); assert.equal(resolves, 0);
  const reopened = await f.command("review task_a");
  assert.equal(reopened.state, "rejected"); assert.equal(reopened.offerId, undefined);
  assert.equal(reopened.context.status, "Review out of date"); assert.match(reopened.context.waitingOn, /Worker/);
  assert.doesNotMatch(reopened.text, /yes approve|Could not confirm/);
  assert.match((await f.command("needs")).text, /Waiting on: Worker — fresh review required/);
  await f.command(`yes approve ${shown.offerId}`); assert.equal(resolves, 0);
  t.mock.method(bindings, "readOrchestratorBindings", async () => ({ bindings: { w: { serverId: "local", label: "CNS" } }, problems: {} }));
  t.mock.method(transport, "invokeChatHost", async (_host, method) => method === "decisions.list" ? f.deps.decisions.list("local") : { questions: [], taskTitles: {} });
  const inbox = await f.handlers.get("chat.inbox")({ agentId: "coordinator" }, { paseo: f.paseo });
  assert.equal(inbox.entries.length, 1); assert.equal(inbox.entries[0].offerId, undefined);
  assert.equal(inbox.entries[0].proposalKind, undefined); assert.equal(inbox.entries[0].context.type, "blocker");
  // A new saved review is required; changing code back cannot revive the rejected card.
  actual = { head: sha, tree: sha }; f.current.revision = "request2";
  const fresh = await f.command("review task_a"); assert.equal(fresh.state, "pending");
  await f.command(`yes approve ${fresh.offerId}`); assert.equal(resolves, 1);
});
