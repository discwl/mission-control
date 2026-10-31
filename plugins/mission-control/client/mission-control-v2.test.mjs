import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import ts from 'typescript';

const require = createRequire(import.meta.url);
const cache = new Map();
function load(relative) {
  const url = new URL(relative, import.meta.url);
  if (cache.has(url.href)) return cache.get(url.href);
  const code = ts.transpileModule(readFileSync(url, 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  const module = { exports: {} }; cache.set(url.href, module.exports);
  new Function('require', 'module', 'exports', code)(name => name.startsWith('.') ? load(new URL(name + '.ts', url).href) : require(name), module, module.exports);
  cache.set(url.href, module.exports); return module.exports;
}
const { buildV2Tasks, retainV2Hosts, v2TasksForView, v2Workspace } = load('./mission-control-v2-model.ts');
const { decisionReceipt } = load('../shared/decision-receipt.ts');
const at = '2026-10-30T04:00:00.000Z', now = Date.parse(at), head = 'a'.repeat(40);
const task = (id = 'task_a') => ({ schemaVersion: 1, taskId: id, hostId: 'h', projectId: 'p', title: 'Fix boundary date', acceptanceCriteria: 'Preserve the date.', status: 'in_progress', source: 'manual', assignments: [{ serverId: 'remote', workspaceId: 'owned' }], createdAt: at, updatedAt: at });
const entry = (id = 'task_a') => ({ task: task(id), run: null, decisions: [], questions: [], problem: null });
const worker = (id = 'worker') => ({ id, name: id, workspaceId: 'owned', status: 'idle', archivedAt: null, labels: { 'mission-control.task-id': 'task_a' }, updatedAt: at, activityAt: at, pendingPermissions: 0, attention: false, attentionReason: null, error: null, inputTokens: null, outputTokens: null });
const run = () => ({ schemaVersion: 1, runId: 'run_a', taskId: 'task_a', hostId: 'h', projectId: 'p', serverId: 'remote', workspaceId: 'owned', stage: 'review', outcome: 'completed', createdAt: at, updatedAt: at, nextAction: 'Inspect review', agentId: 'worker', gitHead: head, gitDirty: false, gitChanges: [], omittedChanges: 0 });
function decision(overrides = {}) {
  return { decision: { schemaVersion: 1, decisionId: 'decision_a', taskId: 'task_a', runId: 'run_a', serverId: 'remote', workspaceId: 'owned', agentId: 'worker', kind: 'review', status: 'open', question: 'Review the saved candidate', requestedAt: at, gitHead: head, gitDirty: false, evidence: [], findingIds: [], resolvedAt: null, note: null, resume: null, candidate: { head, tree: 'b'.repeat(40) }, plain: null, ...overrides }, summary: 'Saved review', taskTitle: 'Fix boundary date', projectId: 'p', findings: [], unverifiedFindings: 0, resolvedFindings: [], revision: 'revision' };
}
function snapshot(entries = [entry()]) {
  return { serverId: 'personal', observedAt: at, coordinators: [], hosts: [{ serverId: 'remote', label: 'CNS', error: null, snapshot: { serverId: 'remote', observedAt: at, agents: [], workspaces: [], tasks: entries, warnings: [], complete: true, stoppedAgentIds: [] } }], state: { queue: [], pipelines: [], events: [], coordinators: [], paused: true }, warnings: [] };
}
const rows = s => buildV2Tasks(s, { now });

test('one task stays one row when multiple coordinators and workers own it', () => {
  const s = snapshot(); s.hosts[0].snapshot.agents = [worker('one'), worker('two')];
  s.coordinators = ['first', 'second'].map(id => ({ agentId: id, workspaceId: 'orchestrator', name: id, remoteServerId: 'remote', hostLabel: 'CNS', agent: worker(id), links: [{ serverId: 'personal', agentId: id, remoteServerId: 'remote', remoteAgentId: 'one', remoteWorkspaceId: 'owned', taskId: 'task_a' }] }));
  const actual = rows(s); assert.equal(actual.length, 1); assert.equal(actual[0].coordinators.length, 2); assert.equal(actual[0].workers.length, 2);
  const distinct = entry('task_b'); distinct.task.title = s.hosts[0].snapshot.tasks[0].task.title; s.hosts[0].snapshot.tasks.push(distinct); assert.equal(rows(s).length, 2);
});

test('only explicit task identity owns workers, never workspace co-location', () => {
  const s = snapshot(); const unrelated = worker('unrelated'); unrelated.labels = {}; s.hosts[0].snapshot.agents = [unrelated];
  assert.equal(rows(s)[0].workers.length, 0);
  s.hosts[0].snapshot.tasks[0].run = run(); assert.equal(v2Workspace(rows(s)[0]), 'owned');
  s.hosts[0].snapshot.tasks[0].task.assignments = [{ serverId: 'other', workspaceId: 'foreign' }]; assert.equal(v2Workspace(rows(s)[0]), null);
});

test('outages preserve last-known work and never imply a clear action queue', () => {
  const prior = snapshot(); prior.hosts[0].snapshot.tasks[0].decisions = [decision()];
  const fresh = snapshot(); fresh.hosts[0].snapshot = null; fresh.hosts[0].error = 'offline';
  const kept = retainV2Hosts(fresh, prior), actual = rows(kept);
  assert.equal(fresh.hosts[0].snapshot, null); assert.equal(actual.length, 1); assert.equal(actual[0].state, 'Unconfirmed'); assert.equal(v2TasksForView(actual, 'Needs you').length, 0);
  assert.equal(retainV2Hosts({ ...fresh, hosts: [] }, prior).hosts.length, 0);
});

test('failed refresh and expired host observations cannot look live', () => {
  const s = snapshot(); s.hosts[0].snapshot.agents = [{ ...worker(), status: 'running' }];
  assert.equal(rows(s)[0].state, 'Working');
  assert.equal(buildV2Tasks(s, { now, unconfirmed: true })[0].state, 'Unconfirmed');
  assert.equal(buildV2Tasks(s, { now: now + 91_000 })[0].state, 'Unconfirmed');
});

test('changed review revision stays blocked, never an approvable request', () => {
  const e = entry(); e.run = run(); e.run.gitHead = 'c'.repeat(40); e.decisions = [decision()];
  const actual = rows(snapshot([e])); assert.equal(actual[0].staleReview, true); assert.equal(actual[0].state, 'Blocked'); assert.equal(v2TasksForView(actual, 'Needs you').length, 0);
  e.run.gitHead = head; e.run.runId = 'run_b'; assert.equal(rows(snapshot([e]))[0].staleReview, true);
});

test('saved decisions, pending delivery and newer requests remain distinct', () => {
  const e = entry(); e.run = run(); e.decisions = [decision({ kind: 'plan', status: 'approved', resume: { phase: 'pending', error: null, updatedAt: at } })];
  assert.equal(rows(snapshot([e]))[0].state, 'Waiting on worker');
  e.decisions[0].decision.resume.phase = 'sending'; assert.equal(rows(snapshot([e]))[0].state, 'Needs you');
  const old = e.decisions[0]; old.decision.requestedAt = '2026-10-30T03:00:00.000Z'; e.decisions.unshift(decision());
  assert.equal(rows(snapshot([e]))[0].state, 'Needs you');
  const receipt = decisionReceipt(old, 'CNS', e.decisions); assert.match(receipt.context.status, /Earlier decision/); assert.match(receipt.text, /does not approve the newer request/);
});

test('recorded priority orders only enabled queue entries and retains holds', () => {
  const a = entry('task_a'), b = entry('task_b'), c = entry('task_c'); c.task.status = 'delivered';
  const s = snapshot([a, b, c]); s.state.queue = [{ coordinatorId: 'c', remoteServerId: 'remote', taskId: 'task_a', enabled: true, priority: 2, updatedAt: at }, { coordinatorId: 'c', remoteServerId: 'remote', taskId: 'task_b', enabled: true, priority: 9, updatedAt: at }, { coordinatorId: 'c', remoteServerId: 'remote', taskId: 'task_c', enabled: true, priority: 8, updatedAt: at }];
  assert.deepEqual(v2TasksForView(rows(s), 'Up next').map(row => row.entry.task.taskId), ['task_b', 'task_a']);
  s.state.queue[0].enabled = false; assert.equal(v2TasksForView(rows(s), 'Up next').length, 1);
});

test('a finished turn is not task delivery and search respects host scope', () => {
  const e = entry(); e.run = run(); const actual = rows(snapshot([e])); assert.notEqual(actual[0].state, 'Delivered');
  assert.equal(v2TasksForView(actual, 'Work', 'foreign').length, 0); assert.equal(v2TasksForView(actual, 'Work', 'remote', 'BOUNDARY').length, 1);
});

test('unreadable records and archived permissions do not become actionable approvals', () => {
  const e = entry(); e.decisions = [decision()]; e.problem = 'Task record needs recovery';
  assert.equal(rows(snapshot([e]))[0].state, 'Blocked');
  const s = snapshot(); s.hosts[0].snapshot.agents = [{ ...worker(), archivedAt: at, pendingPermissions: 1, status: 'error', error: 'old error' }];
  const actual = rows(s); assert.equal(actual[0].workers.length, 1); assert.equal(actual[0].state, 'Waiting on worker');
});

test('native V2 registers separately and contains only read RPCs', () => {
  const source = readFileSync(new URL('./mission-control-v2.tsx', import.meta.url), 'utf8');
  assert.match(source, /title: "Mission Control V2"/); assert.match(source, /Read-only preview/);
  assert.doesNotMatch(source, /\b(resolveDecision|resendDecision|replyToQuestion|setFleetQueue|configureSupervisor|pauseFleet|saveTaskDocument|chatCommand|chatInbox)\b/);
  assert.doesNotMatch(source, /\.send\(|\.approve\(|\.create\(/);
});
