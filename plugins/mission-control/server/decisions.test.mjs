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
const { createDecisionStore, parseRecord, markdownRecord } = require("./decisions.ts");
import { capturePlanSnapshot } from "./plan-snapshots.mjs";
import { planBrief } from "./plan-test-data.mjs";

const markdown = (fields, body) => `---\n${Object.entries(fields).map(([key, value]) => `${key}: ${JSON.stringify(value)}`).join("\n")}\n---\n\n${body}\n`;
const ids = {
  serverId: "srv_test", workspaceId: "wks_test",
  taskId: "task_aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa", runId: "run_bbbbbbbb-bbbb-4bbb-bbbb-bbbbbbbbbbbb",
  decisionId: "decision_cccccccc-cccc-4ccc-cccc-cccccccccccc",
};
const finding = (suffix, status, decisionId = ids.decisionId) => ({
  findingId: `finding_${suffix}`, decisionId, title: `Finding ${suffix}`, severity: "medium", detail: "", file: null, status, updatedAt: "2026-09-25T00:00:00Z", evidence: [],
});

async function fixture(t, { kind = "review", findings = [finding("11111111", "open"), finding("22222222", "open")], earlier = [], plain } = {}) {
  const root = await mkdtemp(join(tmpdir(), "mission-decisions-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const folder = join(root, ids.taskId);
  const runFolder = join(folder, "runs", ids.runId);
  await mkdir(join(runFolder, "decisions"), { recursive: true });
  const task = { taskId: ids.taskId, projectId: "prj_test", title: "Decision proof", assignments: [{ serverId: ids.serverId, workspaceId: ids.workspaceId }] };
  await writeFile(join(runFolder, "decisions", `${ids.decisionId}.md`), markdown({
    schemaVersion: 1, ...ids, agentId: "agent-1", kind, status: "open", question: "Fix these?", requestedAt: "2026-09-25T00:00:00Z",
    gitHead: null, gitDirty: true, evidence: ["review.md"], findingIds: findings.map(item => item.findingId), resolvedAt: null, note: null, resume: null,
    ...(plain === undefined ? {} : { plain }),
  }, "Two issues found."));
  if (findings.length || earlier.length) await writeFile(join(runFolder, "findings.json"), JSON.stringify({ schemaVersion: 1, runId: ids.runId, findings: [...earlier, ...findings] }));
  const agent = { id: "agent-1", workspaceId: ids.workspaceId, status: "idle", activeTurn: null, pendingPermissions: [], archivedAt: null };
  const sent = [];
  const state = { failSend: false };
  const paseo = { agents: { ref: id => ({
    refresh: async () => { assert.equal(id, "agent-1"); return { agent: { ...agent } }; },
    send: async (text, options) => { if (state.failSend) throw Error("socket closed"); sent.push({ text, options }); },
  }) } };
  const store = createDecisionStore({ sources: async serverId => { assert.equal(serverId, ids.serverId); return [{ task, folder, file: join(folder, "task.md") }]; }, kitRoot: async () => "C:\\kit" });
  const findingsOnDisk = async () => JSON.parse(await readFile(join(runFolder, "findings.json"), "utf8")).findings;
  return { store, paseo, agent, sent, state, findingsOnDisk, folder, runFolder };
}

test("request changes submits chosen findings, dismisses the rest with a note, and resumes the agent once", async t => {
  const { store, paseo, sent, findingsOnDisk } = await fixture(t);
  const { open } = await store.list(ids.serverId);
  assert.equal(open.length, 1);
  const [entry] = open;
  assert.equal(entry.findings.length, 2);
  const base = { ...ids, expectedRevision: entry.revision, outcome: "changes_requested", submitFindingIds: ["finding_11111111"] };

  await assert.rejects(store.resolve({ ...base, note: "" }, paseo), /dismissed/);
  await assert.rejects(store.resolve({ ...base, expectedRevision: "stale", note: "ok" }, paseo), /changed since/);
  const resolved = await store.resolve({ ...base, note: "Typo is fine." }, paseo);
  assert.equal(resolved.decision.status, "changes_requested");
  assert.equal(resolved.decision.resume.phase, "sent");
  assert.deepEqual((await findingsOnDisk()).map(item => item.status), ["submitted", "dismissed"]);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].options.messageId, ids.decisionId);
  assert.match(sent[0].text, /CHANGES REQUESTED/);
  assert.match(sent[0].text, /finding_11111111/);
  assert.doesNotMatch(sent[0].text, /finding_22222222/);
  assert.match(sent[0].text, /C:\\kit/);

  await assert.rejects(store.resolve({ ...base, expectedRevision: resolved.revision, note: "again" }, paseo), /already made/);
  const lists = await store.list(ids.serverId);
  assert.equal(lists.open.length, 0);
  assert.equal(lists.recent[0].decision.decisionId, ids.decisionId);
});

test("a busy agent keeps the saved decision pending until it is resent", async t => {
  const { store, paseo, agent, sent } = await fixture(t, { kind: "review", findings: [] });
  const [entry] = (await store.list(ids.serverId)).open;
  agent.status = "running";
  const saved = await store.resolve({ ...ids, expectedRevision: entry.revision, outcome: "approved", note: "", submitFindingIds: [] }, paseo);
  assert.equal(saved.decision.status, "approved");
  assert.equal(saved.decision.resume.phase, "pending");
  assert.match(saved.decision.resume.error, /busy/);
  assert.equal(sent.length, 0);
  agent.status = "idle";
  const delivered = await store.resend({ ...ids, expectedRevision: saved.revision }, paseo);
  assert.equal(delivered.decision.resume.phase, "sent");
  assert.equal(sent.length, 1);
  await assert.rejects(store.resend({ ...ids, expectedRevision: delivered.revision }, paseo), /already sent/);
});

test("saved decisions retry once after idle, including concurrent scans", async t => {
  const f = await fixture(t, { findings: [] });
  const [entry] = (await f.store.list(ids.serverId)).open;
  f.agent.status = "running";
  await f.store.resolve({ ...ids, expectedRevision: entry.revision, outcome: "changes_requested", note: "Fix the transaction", submitFindingIds: [] }, f.paseo);
  await f.store.retryPending(ids.serverId, f.paseo); assert.equal(f.sent.length, 0);
  f.agent.status = "idle";
  f.agent.pendingPermissions = [{ id: "p" }];
  await f.store.retryPending(ids.serverId, f.paseo); assert.equal(f.sent.length, 0);
  f.agent.pendingPermissions = []; f.agent.workspaceId = "wrong";
  await f.store.retryPending(ids.serverId, f.paseo); assert.equal(f.sent.length, 0);
  f.agent.workspaceId = ids.workspaceId;
  await Promise.all([f.store.retryPending(ids.serverId, f.paseo), f.store.retryPending(ids.serverId, f.paseo)]);
  assert.equal(f.sent.length, 1); assert.equal(f.sent[0].options.messageId, ids.decisionId);
  await f.store.retryPending(ids.serverId, f.paseo); assert.equal(f.sent.length, 1);
});

test("a newer request prevents an old pending decision from automatically resuming work", async t => {
  const f = await fixture(t, { findings: [] });
  const [entry] = (await f.store.list(ids.serverId)).open; f.agent.status = "running";
  await f.store.resolve({ ...ids, expectedRevision: entry.revision, outcome: "approved", note: "", submitFindingIds: [] }, f.paseo);
  const next = { ...entry.decision, decisionId: "decision_dddddddd-dddd-4ddd-dddd-dddddddddddd", requestedAt: "2026-09-26T00:00:00Z" };
  await writeFile(join(f.runFolder, "decisions", `${next.decisionId}.md`), markdownRecord(next, "New scope"));
  f.agent.status = "idle"; await f.store.retryPending(ids.serverId, f.paseo);
  assert.equal(f.sent.length, 0);
});

test("automatic delivery of accepted code rechecks the exact reviewed candidate", async t => {
  const f = await fixture(t, { findings: [] });
  const file = join(f.runFolder, "decisions", `${ids.decisionId}.md`);
  const saved = parseRecord(await readFile(file, "utf8"));
  const candidate = { head: "a".repeat(40), tree: "b".repeat(40) };
  await writeFile(file, markdownRecord({ ...saved.fields, candidate }, saved.body));
  const [entry] = (await f.store.list(ids.serverId)).open;
  f.agent.status = "running";
  await f.store.resolve({ ...ids, expectedRevision: entry.revision, outcome: "approved", note: "", submitFindingIds: [] }, f.paseo);
  f.agent.status = "idle";
  f.paseo.workspaces = { ref: () => ({ refresh: async () => ({ workspaceDirectory: f.folder }) }) };
  const merge = require("./merge.ts"); let current = { ...candidate, tree: "c".repeat(40) };
  t.mock.method(merge, "reviewCandidate", async () => current);
  const [blocked] = await f.store.retryPending(ids.serverId, f.paseo);
  assert.equal(blocked.decision.resume.phase, "pending"); assert.match(blocked.decision.resume.error, /code changed/);
  assert.equal(f.sent.length, 0);
  current = candidate; await f.store.retryPending(ids.serverId, f.paseo); assert.equal(f.sent.length, 1);
});

test("an unconfirmed send is never retried automatically", async t => {
  const { store, paseo, state, sent } = await fixture(t, { kind: "plan", findings: [] });
  const [entry] = (await store.list(ids.serverId)).open;
  state.failSend = true;
  const saved = await store.resolve({ ...ids, expectedRevision: entry.revision, outcome: "blocked", note: "Wait for API keys.", submitFindingIds: [] }, paseo);
  assert.equal(saved.decision.resume.phase, "sending");
  assert.match(saved.decision.resume.error, /socket closed/);
  await assert.rejects(store.resend({ ...ids, expectedRevision: saved.revision }, paseo), /unconfirmed/);
  state.failSend = false; await store.retryPending(ids.serverId, paseo); assert.equal(sent.length, 0);
});

test("approving a review waits for earlier findings to be verified and a block needs a note", async t => {
  const other = "decision_dddddddd-dddd-4ddd-dddd-dddddddddddd";
  const { store, paseo } = await fixture(t, { findings: [], earlier: [finding("33333333", "awaiting_verification", other)] });
  const [entry] = (await store.list(ids.serverId)).open;
  assert.equal(entry.unverifiedFindings, 1);
  await assert.rejects(store.resolve({ ...ids, expectedRevision: entry.revision, outcome: "approved", note: "", submitFindingIds: [] }, paseo), /not verified yet/);
  await assert.rejects(store.resolve({ ...ids, expectedRevision: entry.revision, outcome: "blocked", note: " ", submitFindingIds: [] }, paseo), /note/);
});

test("plain fields and verified fixes reach the card and survive an answer", async t => {
  const plain = { built: "Tasks can be paused.", found: "Two small problems.", recommendation: { action: "fix", reason: "Both are quick." } };
  const findingPlain = { description: "Pausing twice loses a note.", impact: "Notes can disappear.", recommend: "fix" };
  const other = "decision_dddddddd-dddd-4ddd-dddd-dddddddddddd";
  const { store, paseo, findingsOnDisk } = await fixture(t, {
    plain,
    findings: [{ ...finding("11111111", "open"), plain: findingPlain }, finding("22222222", "open")],
    earlier: [finding("33333333", "resolved", other), finding("44444444", "dismissed", other)],
  });
  const [entry] = (await store.list(ids.serverId)).open;
  assert.deepEqual(entry.decision.plain, plain);
  assert.deepEqual(entry.findings.map(item => item.plain), [findingPlain, null]);
  assert.deepEqual(entry.resolvedFindings.map(item => item.findingId), ["finding_33333333"]);
  assert.equal(entry.unverifiedFindings, 0);

  const resolved = await store.resolve({ ...ids, expectedRevision: entry.revision, outcome: "changes_requested", note: "Skipped for now; track as a follow-up.", submitFindingIds: ["finding_11111111"] }, paseo);
  assert.deepEqual(resolved.decision.plain, plain, "the decision record keeps its plain fields");
  const stored = await findingsOnDisk();
  assert.deepEqual(stored.find(item => item.findingId === "finding_11111111").plain, findingPlain, "findings.json keeps them too");
  assert.equal(stored.find(item => item.findingId === "finding_11111111").status, "submitted");
});

test("an older decision without plain fields, or with a malformed block, still lists", async t => {
  const { store } = await fixture(t, { plain: { built: "", recommendation: { action: "maybe" } } });
  const [entry] = (await store.list(ids.serverId)).open;
  assert.equal(entry.decision.plain, null);
  assert.deepEqual(entry.findings.map(item => item.plain), [null, null]);
  assert.deepEqual(entry.resolvedFindings, []);
});

async function versionedPlan(t) {
  const f = await fixture(t, { kind: "plan", findings: [] });
  await writeFile(join(f.folder, "plan.md"), "# Plan\n\nPrevent new full discounts. Leave existing orders untouched.\n");
  const file = join(f.runFolder, "decisions", `${ids.decisionId}.md`);
  const record = parseRecord(await readFile(file, "utf8"));
  const plan = await capturePlanSnapshot({ taskFolder: f.folder, runFolder: f.runFolder, ...ids, requestedAt: record.fields.requestedAt, brief: planBrief });
  await writeFile(file, markdownRecord({ ...record.fields, plan }, record.body));
  const [entry] = (await f.store.list(ids.serverId)).open;
  return { ...f, file, entry, plan, input: { ...ids, expectedRevision: entry.revision, expectedPlanRevision: plan.revision, outcome: "approved", note: "", submitFindingIds: [] } };
}

test("a shared task assignment cannot substitute another decision host or workspace", async t => {
  const f = await versionedPlan(t);
  const task = { taskId: ids.taskId, projectId: "prj_test", title: "Shared assignment", assignments: [
    { serverId: ids.serverId, workspaceId: ids.workspaceId },
    { serverId: ids.serverId, workspaceId: "wks_other" },
    { serverId: "srv_other", workspaceId: ids.workspaceId },
  ] };
  const store = createDecisionStore({ sources: async () => [{ task, folder: f.folder, file: join(f.folder, "task.md") }] });
  for (const ref of [{ ...f.input, workspaceId: "wks_other" }, { ...f.input, serverId: "srv_other" }]) {
    await assert.rejects(store.plan(ref), /another host or workspace/);
    await assert.rejects(store.resolve(ref, f.paseo), /another host or workspace/);
  }
  assert.equal(f.sent.length, 0);
  assert.equal((await f.store.list(ids.serverId)).open.length, 1);
});

test("plan approval binds the full saved document and human brief to the exact decision", async t => {
  const f = await versionedPlan(t);
  const view = await f.store.plan({ ...ids, expectedRevision: f.entry.revision });
  assert.equal(view.canApprove, true);
  assert.equal(view.source, "snapshot");
  assert.equal(view.revision, f.plan.revision);
  assert.equal(view.brief.scopeChange, planBrief.scopeChange);
  assert.match(view.markdown, /Leave existing orders untouched/);
  const approved = await f.store.resolve(f.input, f.paseo);
  assert.equal(approved.decision.status, "approved");
  assert.equal(f.sent.length, 1);
  assert.match(f.sent[0].text, new RegExp(f.plan.revision));
  assert.match(f.sent[0].text, /Follow that approved snapshot/);
  assert.match(f.sent[0].text, /no new commit, push, merge, deployment, Jira\/ADO/);
});

test("a changed plan is rejected even when the decision record itself is unchanged", async t => {
  const f = await versionedPlan(t);
  await assert.rejects(f.store.resolve({ ...f.input, expectedPlanRevision: "0".repeat(64) }, f.paseo), /Read the saved plan/);
  await writeFile(join(f.folder, "plan.md"), "# Expanded plan\n\nRemove existing discounts too.\n");
  assert.equal((await f.store.list(ids.serverId)).open[0].revision, f.entry.revision);
  const view = await f.store.plan({ ...ids, expectedRevision: f.entry.revision });
  assert.equal(view.canApprove, false);
  assert.match(view.warning, /changed after/);
  assert.match(view.markdown, /Leave existing orders untouched/);
  await assert.rejects(f.store.resolve(f.input, f.paseo), /changed after/);
  assert.equal(f.sent.length, 0);
  assert.equal((await f.store.list(ids.serverId)).open.length, 1);
  await f.store.resolve({ ...f.input, outcome: "changes_requested", note: "Keep existing orders untouched and explain the revision." }, f.paseo);
  assert.match(f.sent[0].text, /Revise plan.md and its human-readable planBrief/);
  assert.doesNotMatch(f.sent[0].text, /Use the fix-findings skill/);
});

test("an older plan remains readable and changeable, but cannot receive a blind approval", async t => {
  const f = await fixture(t, { kind: "plan", findings: [] });
  await writeFile(join(f.folder, "plan.md"), "# Current plan\n\nCurrent contents are not a request-time snapshot.\n");
  const [entry] = (await f.store.list(ids.serverId)).open;
  const input = { ...ids, expectedRevision: entry.revision, outcome: "approved", note: "", submitFindingIds: [] };
  const view = await f.store.plan(input);
  assert.equal(view.source, "current");
  assert.equal(view.canApprove, false);
  assert.equal(view.brief, null);
  assert.match(view.warning, /older request/);
  await assert.rejects(f.store.resolve(input, f.paseo), /saved plan version/);
  await f.store.resolve({ ...input, outcome: "changes_requested", note: "Please provide a readable, versioned proposal." }, f.paseo);
  assert.equal(f.sent.length, 1);
});

test("saved plan delivery is rechecked after a busy agent becomes idle", async t => {
  const f = await versionedPlan(t);
  f.agent.status = "running";
  const approved = await f.store.resolve(f.input, f.paseo);
  assert.equal(approved.decision.resume.phase, "pending");
  await writeFile(join(f.folder, "plan.md"), "# New scope\n");
  f.agent.status = "idle";
  const [result] = await f.store.retryPending(ids.serverId, f.paseo);
  assert.equal(result.decision.resume.phase, "pending");
  assert.match(result.decision.resume.error, /changed after/);
  assert.equal(f.sent.length, 0);
});

test("altered snapshots and stale decision revisions never approve or resume work", async t => {
  const f = await versionedPlan(t);
  await assert.rejects(f.store.plan({ ...ids, expectedRevision: "old" }), /request changed/);
  const snapshotFile = join(f.runFolder, f.plan.path);
  await writeFile(snapshotFile, (await readFile(snapshotFile, "utf8")).replace("Prevent accidental", "Allow accidental"));
  await assert.rejects(f.store.resolve(f.input, f.paseo), /Saved plan changed/);
  assert.equal(f.sent.length, 0);
});
