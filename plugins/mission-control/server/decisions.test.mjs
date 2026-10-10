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
const { createDecisionStore } = require("./decisions.ts");

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
  return { store, paseo, agent, sent, state, findingsOnDisk };
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
  const { store, paseo, agent, sent } = await fixture(t, { kind: "plan", findings: [] });
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

test("an unconfirmed send is never retried automatically", async t => {
  const { store, paseo, state } = await fixture(t, { kind: "plan", findings: [] });
  const [entry] = (await store.list(ids.serverId)).open;
  state.failSend = true;
  const saved = await store.resolve({ ...ids, expectedRevision: entry.revision, outcome: "blocked", note: "Wait for API keys.", submitFindingIds: [] }, paseo);
  assert.equal(saved.decision.resume.phase, "sending");
  assert.match(saved.decision.resume.error, /socket closed/);
  await assert.rejects(store.resend({ ...ids, expectedRevision: saved.revision }, paseo), /unconfirmed/);
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
