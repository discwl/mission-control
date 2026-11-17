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
const { rowBadges } = load('./row-badges.ts');
const { buildV2Tasks } = load('./mission-control-v2-model.ts');

const at = '2026-11-16T16:00:00.000Z', now = Date.parse(at), head = 'a'.repeat(40);
const task = (id, workspaceId = 'owned', extra = {}) => ({ schemaVersion: 1, taskId: id, hostId: 'h', projectId: 'p', title: `Task ${id}`, acceptanceCriteria: 'Done.', status: 'in_progress', source: 'manual', assignments: [{ serverId: 'remote', workspaceId }], createdAt: at, updatedAt: at, ...extra });
const entry = (id, workspaceId, extra) => ({ task: task(id, workspaceId, extra), run: null, decisions: [], questions: [], problem: null });
const openReview = (taskId, workspaceId = 'owned') => ({ decision: { schemaVersion: 1, decisionId: `decision_${taskId}`, taskId, runId: `run_${taskId}`, serverId: 'remote', workspaceId, agentId: 'worker', kind: 'review', status: 'open', question: 'Review the saved candidate', requestedAt: at, gitHead: head, gitDirty: false, evidence: [], findingIds: [], resolvedAt: null, note: null, resume: null, candidate: { head, tree: 'b'.repeat(40) }, plain: null }, summary: 'Saved review', taskTitle: `Task ${taskId}`, projectId: 'p', findings: [], unverifiedFindings: 0, resolvedFindings: [], revision: 'revision' });
const run = (taskId, workspaceId = 'owned', extra = {}) => ({ schemaVersion: 1, runId: `run_${taskId}`, taskId, hostId: 'h', projectId: 'p', serverId: 'remote', workspaceId, stage: 'execute', outcome: 'running', createdAt: at, updatedAt: at, nextAction: 'Keep building', agentId: 'worker', gitHead: head, gitDirty: false, gitChanges: [], omittedChanges: 0, ...extra });
const hostSnapshot = (entries, observedAt = at) => ({ serverId: 'remote', observedAt, agents: [], workspaces: [], tasks: entries, warnings: [], complete: true, stoppedAgentIds: [] });
/** What a host that coordinates nothing reads about itself ("This computer"). */
const own = (entries, observedAt) => ({ serverId: 'remote', observedAt: at, coordinators: [], hosts: [{ serverId: 'remote', label: 'This computer', error: null, snapshot: hostSnapshot(entries, observedAt) }], state: { queue: [], pipelines: [], events: [], coordinators: [], paused: true }, warnings: [] });
/** What a coordinating computer reads: other hosts, and its orchestrator chats' workspaces. */
const coordinating = (entries, coordinators) => ({ ...own(entries), serverId: 'personal', hosts: [{ serverId: 'remote', label: 'Remote', error: null, snapshot: hostSnapshot(entries) }], coordinators });
const coordinator = (agentId, workspaceId) => ({ agentId, workspaceId, name: agentId, remoteServerId: 'remote', hostLabel: 'Remote', agent: { id: agentId, name: agentId, workspaceId, status: 'idle', archivedAt: null, labels: {}, updatedAt: at, activityAt: at, pendingPermissions: 0, attention: false, attentionReason: null, error: null, inputTokens: null, outputTokens: null }, links: [] });

test('a task waiting on the user shows Needs you on its workspace row, matching All work', () => {
  const waiting = entry('task_a'); waiting.run = run('task_a'); waiting.decisions = [openReview('task_a')];
  const snapshot = own([waiting]);
  assert.equal(buildV2Tasks(snapshot, { now })[0].state, 'Needs you');
  const badge = rowBadges(snapshot, 'remote', now).get('owned');
  assert.equal(badge.label, 'Needs you'); assert.equal(badge.tone, 'warning');
  assert.match(badge.accessibilityLabel, /^Task task_a needs you: /);
});

test('the most urgent state wins when tasks share a workspace, and each badge mirrors its All work state', () => {
  const working = entry('task_work'); working.run = run('task_work');
  const waiting = entry('task_wait'); waiting.run = run('task_wait'); waiting.decisions = [openReview('task_wait')];
  // A planning run with its worker running is "Working" in All work, at stage "Planning".
  const planning = entry('task_other', 'other'); planning.run = run('task_other', 'other', { stage: 'plan' });
  const snapshot = own([working, waiting, planning]);
  snapshot.hosts[0].snapshot.agents = [{ id: 'planner', name: 'planner', workspaceId: 'other', status: 'running', archivedAt: null, labels: { 'mission-control.task-id': 'task_other' }, updatedAt: at, activityAt: at, pendingPermissions: 0, attention: false, attentionReason: null, error: null, inputTokens: null, outputTokens: null }];
  const states = new Map(buildV2Tasks(snapshot, { now }).map(row => [row.entry.task.taskId, row]));
  assert.deepEqual([states.get('task_other').state, states.get('task_other').workflow.stage], ['Working', 'Planning']);
  const badges = rowBadges(snapshot, 'remote', now);
  assert.equal(badges.get('owned').label, 'Needs you', 'Needs you outranks another task in the same workspace');
  assert.deepEqual([badges.get('other').label, badges.get('other').tone], ['Planning', 'info']);
});

test('delivered tasks and hosts whose records are out of date show no badge', () => {
  const delivered = entry('task_done', 'done', { status: 'delivered' });
  assert.equal(rowBadges(own([delivered]), 'remote', now).size, 0);
  const waiting = entry('task_a'); waiting.run = run('task_a'); waiting.decisions = [openReview('task_a')];
  const stale = own([waiting], new Date(now - 5 * 60_000).toISOString());
  assert.equal(buildV2Tasks(stale, { now })[0].state, 'Unconfirmed');
  assert.equal(rowBadges(stale, 'remote', now).size, 0, "last-known state isn't shown as current");
});

test('remote waiting tasks badge their own workspaces and leave the local orchestrator row clear', () => {
  const waiting = entry('task_a'); waiting.run = run('task_a'); waiting.decisions = [openReview('task_a')];
  const second = entry('task_b', 'second'); second.run = run('task_b', 'second'); second.decisions = [openReview('task_b', 'second')];
  const snapshot = coordinating([waiting, second], [coordinator('chat_one', 'orchestrator'), coordinator('chat_two', 'orchestrator')]);
  assert.equal(rowBadges(snapshot, 'personal', now).size, 0);
  const badges = rowBadges(own([waiting, second]), 'remote', now);
  assert.equal(badges.get('owned').label, 'Needs you');
  assert.equal(badges.get('second').label, 'Needs you');
});
