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
const { buildV2Tasks, retainV2Hosts } = load('./mission-control-v2-model.ts');
const { kanbanTask, filterKanban, kanbanCounts, kanbanCanAct, kanbanLayout, kanbanLanes, kanbanGuidance, kanbanHasRequest } = load('./kanban-model.ts');
const at = '2026-10-30T16:00:00.000Z', now = Date.parse(at), head = 'a'.repeat(40);
const task = (id = 'task_a') => ({ schemaVersion: 1, taskId: id, hostId: 'h', projectId: 'p', title: 'Fix date boundary', acceptanceCriteria: 'Preserve dates.', status: 'in_progress', source: 'manual', assignments: [{ serverId: 'remote', workspaceId: 'owned' }], createdAt: at, updatedAt: at });
const entry = (id = 'task_a') => ({ task: task(id), run: null, decisions: [], questions: [], problem: null });
const worker = (status = 'running') => ({ id: 'worker', name: 'Boundary fix worker', workspaceId: 'owned', status, archivedAt: null, labels: { 'mission-control.task-id': 'task_a' }, updatedAt: at, activityAt: at, pendingPermissions: 0, attention: false, attentionReason: null, error: null, inputTokens: null, outputTokens: null });
const run = (stage = 'plan') => ({ schemaVersion: 1, runId: 'run_a', taskId: 'task_a', hostId: 'h', projectId: 'p', serverId: 'remote', workspaceId: 'owned', stage, outcome: 'completed', createdAt: at, updatedAt: at, nextAction: 'Continue task', agentId: 'worker', gitHead: head, gitDirty: false, gitChanges: [], omittedChanges: 0 });
function decision(kind = 'plan', overrides = {}) {
  return { decision: { schemaVersion: 1, decisionId: 'decision_' + kind, taskId: 'task_a', runId: 'run_a', serverId: 'remote', workspaceId: 'owned', agentId: 'worker', kind, status: 'open', question: 'Inspect this revision', requestedAt: at, gitHead: head, gitDirty: false, evidence: [], findingIds: [], resolvedAt: null, note: null, resume: null, candidate: { head, tree: 'b'.repeat(40) }, plain: null, ...overrides }, summary: 'Saved evidence', taskTitle: 'Fix date boundary', projectId: 'p', findings: [], unverifiedFindings: 0, resolvedFindings: [], revision: 'revision' };
}
function snapshot(entries = [entry()]) {
  return { serverId: 'personal', observedAt: at, coordinators: [], hosts: [{ serverId: 'remote', label: 'CNS', error: null, snapshot: { serverId: 'remote', observedAt: at, agents: [], workspaces: [], tasks: entries, warnings: [], complete: true, stoppedAgentIds: [] } }], state: { queue: [], pipelines: [], events: [], coordinators: [], paused: true }, warnings: [] };
}
const cards = (s, options = {}) => buildV2Tasks(s, { now, ...options }).map(kanbanTask);
const { kanbanSidebarCounts } = load('./kanban-model.ts');

test('saved decisions route pending and unconfirmed worker delivery to their receipt', () => {
  for (const phase of ['pending', 'sending']) {
    const e = entry(); e.run = run();
    e.decisions = [decision('plan', { status: 'approved', resume: { phase } })];
    const s = snapshot([e]); const card = cards(s)[0];
    assert.equal(card.tab, 'Receipt', phase);
    assert.equal(card.lane, 'attention', phase);
    assert.equal(card.needsYou, phase === 'sending');
    assert.match(card.label, phase === 'sending' ? /unconfirmed/ : /pending/);
    assert.match(kanbanGuidance(card).after, /Do not approve.*blindly resend/);
    e.decisions.push(decision('plan', { decisionId: 'new-plan', requestedAt: '2026-10-30T16:01:00Z' }));
    assert.equal(cards(s)[0].tab, 'Plan', 'a newer open request takes precedence');
  }
});

test('receipt routing never uses another run, task, host or workspace delivery', () => {
  for (const field of ['runId', 'taskId', 'serverId', 'workspaceId']) {
    const e = entry(); e.run = run();
    e.decisions = [decision('plan', { status: 'approved', resume: { phase: 'sending' }, [field]: 'foreign' })];
    assert.notEqual(cards(snapshot([e]))[0].tab, 'Receipt', field);
  }
  const e = entry(); e.run = run(); e.decisions = [decision('plan', { status: 'approved', resume: { phase: 'sent' } })];
  assert.notEqual(cards(snapshot([e]))[0].tab, 'Receipt', 'confirmed delivery no longer needs inspection');
});

test('sidebar counts live agents including unbound coordinators, once per host and agent', () => {
  const s = snapshot();
  s.hosts[0].snapshot.agents = [worker(), worker(), { ...worker(), id: 'coordinator', labels: {} }, { ...worker(), id: 'permission', pendingPermissions: 1 }, { ...worker(), id: 'archived', archivedAt: at }, { ...worker('idle'), id: 'idle' }];
  const other = structuredClone(s.hosts[0]); other.serverId = 'other'; other.snapshot.agents = [worker()]; s.hosts.push(other);
  assert.equal(kanbanSidebarCounts(s, cards(s), now).runningAgents, 3);
});

test('local coordinator activity is fresh independently of its offline remote host', () => {
  const s = snapshot(); s.hosts[0].error = 'offline';
  s.coordinators = [{ agentId: 'coordinator', remoteServerId: 'remote', agent: { ...worker(), id: 'coordinator' }, links: [] }];
  const counts = kanbanSidebarCounts(s, [], now);
  assert.equal(counts.runningAgents, 1); assert.equal(counts.unavailableHosts, 1);
  assert.equal(kanbanSidebarCounts(s, [], now + 91_000).runningAgents, 0);
  assert.equal(kanbanSidebarCounts(s, [], now, true).runningAgents, 0);
});

test('sidebar excludes unavailable, expired and partial host activity and approvals', () => {
  const e = entry(); e.run = run(); e.decisions = [decision()];
  for (const mode of ['offline', 'old', 'partial', 'invalid', 'failed']) {
    const s = snapshot([e]); s.hosts[0].snapshot.agents = [worker()];
    if (mode === 'offline') s.hosts[0].error = 'offline';
    if (mode === 'old') s.hosts[0].snapshot.observedAt = '2026-10-30T15:00:00Z';
    if (mode === 'partial') s.hosts[0].snapshot.complete = false;
    if (mode === 'invalid') s.hosts[0].snapshot.observedAt = 'unknown';
    const counts = kanbanSidebarCounts(s, cards(s), now, mode === 'failed');
    assert.equal(counts.runningAgents, 0, mode); assert.equal(counts.ready, 0, mode); assert.equal(counts.unavailableHosts, 1, mode);
  }
});

test('sidebar finished turns are not completed tasks or ready reviews; saved requests are', () => {
  const e = entry(); e.run = run('execute'); e.decisions = [decision('plan', { status: 'approved' })];
  const s = snapshot([e]); s.hosts[0].snapshot.agents = [worker('idle')];
  assert.equal(kanbanSidebarCounts(s, cards(s), now).ready, 0);
  e.decisions.push(decision('review'));
  assert.equal(kanbanSidebarCounts(s, cards(s), now).reviews, 1);
  e.decisions = [decision('plan')];
  assert.equal(kanbanSidebarCounts(s, cards(s), now).plans, 1);
  e.questions = [{ question: { status: 'open', question: 'Which environment?' } }];
  const blocked = kanbanSidebarCounts(s, cards(s), now);
  assert.equal(blocked.input, 1); assert.equal(blocked.ready, 0);
  e.task.status = 'delivered';
  assert.equal(kanbanSidebarCounts(s, cards(s), now).input, 0);
});

test('planning and a human plan approval are distinct, even with a running worker', () => {
  const e = entry(); e.run = run(); const s = snapshot([e]); s.hosts[0].snapshot.agents = [worker()];
  assert.equal(cards(s)[0].lane, 'planning');
  e.decisions = [decision()];
  const card = cards(s)[0]; assert.equal(card.lane, 'plan'); assert.equal(card.tab, 'Plan'); assert.equal(card.needsYou, true);
  assert.equal(kanbanCounts([card]).plans, 1);
});

test('independent review is work; a saved open review is a human decision', () => {
  const e = entry(); e.run = run('review'); e.decisions = [decision('plan', { status: 'approved' })];
  const s = snapshot([e]); s.hosts[0].snapshot.agents = [worker()];
  assert.equal(cards(s)[0].lane, 'progress'); assert.equal(cards(s)[0].label, 'Independent reviewer working');
  e.decisions.push(decision('review', { requestedAt: '2026-10-30T16:01:00.000Z' }));
  assert.equal(cards(s)[0].lane, 'review'); assert.equal(cards(s)[0].tab, 'Code review');
});

test('a completed run or idle agent cannot mark a task done', () => {
  const e = entry(); e.run = run('execute'); e.decisions = [decision('plan', { status: 'approved' })];
  const s = snapshot([e]); s.hosts[0].snapshot.agents = [worker('idle')];
  assert.equal(cards(s)[0].lane, 'progress');
  e.task.status = 'delivered'; assert.equal(cards(s)[0].lane, 'done');
});

test('accepted code waits for separate delivery, requested changes return to implementation', () => {
  const e = entry(); e.run = run('review'); e.decisions = [decision('review', { status: 'approved' })];
  assert.equal(cards(snapshot([e]))[0].lane, 'delivery');
  e.decisions[0].decision.status = 'changes_requested';
  assert.equal(cards(snapshot([e]))[0].lane, 'progress');
});

test('known stale reviews leave the approval lane and retain the reason', () => {
  const e = entry(); e.run = run('review'); e.decisions = [decision('review', { gitHead: 'c'.repeat(40), candidate: { head: 'c'.repeat(40) } })];
  const card = cards(snapshot([e]))[0];
  assert.equal(card.lane, 'attention'); assert.equal(card.label, 'Fresh review required'); assert.equal(card.tab, 'Code review');
  assert.equal(kanbanCounts([card]).reviews, 0);
});

test('worker questions and permissions take precedence over a pending review', () => {
  const e = entry(); e.run = run('review'); e.decisions = [decision('review')];
  const s = snapshot([e]); const a = worker(); a.pendingPermissions = 1; s.hosts[0].snapshot.agents = [a];
  assert.equal(cards(s)[0].tab, 'Decision'); assert.equal(cards(s)[0].lane, 'attention');
  a.archivedAt = at; assert.equal(cards(s)[0].lane, 'review');
  e.questions = [{ question: { questionId: 'q', status: 'open', question: 'Which environment?' } }];
  assert.equal(cards(s)[0].lane, 'attention');
});

test('pending delivery never asks for the same plan approval again', () => {
  const e = entry(); e.run = run(); e.decisions = [decision('plan', { status: 'approved', resume: { phase: 'pending', error: null } })];
  const card = cards(snapshot([e]))[0];
  assert.equal(card.lane, 'attention'); assert.equal(card.label, 'Decision saved; delivery pending'); assert.equal(card.needsYou, false);
  assert.equal(kanbanCounts([card]).plans, 0);
});

test('same task ID on two hosts remains two cards; multiple workers remain one card', () => {
  const s = snapshot(); const second = structuredClone(s.hosts[0]); second.serverId = 'other'; second.label = 'AACN'; second.snapshot.serverId = 'other'; s.hosts.push(second);
  s.hosts[0].snapshot.agents = [worker(), { ...worker(), id: 'worker2' }];
  const result = cards(s); assert.equal(result.length, 2); assert.notEqual(result[0].row.key, result[1].row.key); assert.equal(result[0].row.workers.length, 2);
  assert.equal(filterKanban(result, 'other', 'all', '', 'All work').length, 1);
  assert.equal(filterKanban(result, 'remote', 'all', 'Boundary fix worker', 'All work').length, 1);
});

test('offline cached tasks and expired observations cannot look ready for approval', () => {
  const e = entry(); e.decisions = [decision()]; const before = snapshot([e]);
  const outage = snapshot([]); outage.hosts[0].error = 'offline'; outage.hosts[0].snapshot = null;
  const result = cards(retainV2Hosts(outage, before));
  assert.equal(result.length, 1); assert.equal(result[0].label, 'Host unconfirmed'); assert.equal(kanbanCounts(result).plans, 0);
  assert.equal(kanbanCanAct(result[0].row, true), false);
  assert.equal(cards(before, { now: now + 91_000 })[0].lane, 'attention');
  assert.equal(cards(before, { unconfirmed: true })[0].row.state, 'Unconfirmed');
});

test('partial or failed task records and disconnected hosts disable actions', () => {
  const s = snapshot(); let row = cards(s)[0].row;
  assert.equal(kanbanCanAct(row, true), true); assert.equal(kanbanCanAct(row, false), false);
  s.hosts[0].snapshot.complete = false; row = cards(s)[0].row; assert.equal(kanbanCanAct(row, true), false);
  s.hosts[0].snapshot.complete = true; s.hosts[0].snapshot.tasks[0].problem = 'Cannot read run'; row = cards(s)[0].row; assert.equal(kanbanCanAct(row, true), false);
});

test('queue priority and filters are task based, including projects and human focus', () => {
  const s = snapshot([entry('task_a'), entry('task_b')]); s.hosts[0].snapshot.tasks[1].task.projectId = 'other-project';
  s.state.queue = [{ coordinatorId: 'c', remoteServerId: 'remote', taskId: 'task_a', enabled: true, priority: 2 }, { coordinatorId: 'c', remoteServerId: 'remote', taskId: 'task_b', enabled: true, priority: 9 }];
  const result = cards(s); assert.deepEqual(result.map(item => item.lane), ['queue', 'queue']);
  assert.equal(filterKanban(result, 'all', 'all', '', 'All work')[0].row.entry.task.taskId, 'task_b');
  assert.equal(filterKanban(result, 'all', 'other-project', '', 'All work').length, 1);
  assert.equal(filterKanban(result, 'all', 'all', '', 'Needs you').length, 0);
});

test('compact layout uses one readable lane, desktop keeps bounded lane widths', () => {
  assert.deepEqual(kanbanLayout(390, false), { singleLane: true, laneWidth: 366 });
  assert.equal(kanbanLayout(1200, true).singleLane, true);
  assert.equal(kanbanLayout(1400, false).singleLane, false);
  assert.ok(kanbanLayout(1400, false).laneWidth <= 350);
});

test('lanes follow lifecycle order after the exception lane', () => {
  assert.deepEqual(kanbanLanes.map(lane => lane.id), ['attention', 'queue', 'planning', 'plan', 'progress', 'review', 'delivery', 'done']);
});

test('a blocked handoff without an open request routes to a conversation, not an empty decision', () => {
  const s = snapshot(); s.hosts[0].snapshot.agents = [worker('idle')];
  const row = { ...cards(s)[0].row, state: 'Blocked', next: 'Approve and publish everything', workflow: { stage: 'Blocked' } };
  const item = kanbanTask(row);
  assert.equal(item.tab, 'Workers'); assert.equal(kanbanHasRequest(row), false);
  const guide = kanbanGuidance(item);
  assert.match(guide.why, /no open approval/i); assert.doesNotMatch(JSON.stringify(guide), /Approve and publish everything/);
  const rendered = renderDetail(item, 'Next step');
  const chat = rendered.nodes.find(node => node.props?.label === 'Open worker conversation');
  chat.props.onPress(); assert.deepEqual(rendered.navigation, [{ serverId: 'remote', agentId: 'worker' }]);
  assert.equal(rendered.nodes.some(node => node.props?.label === 'Decision'), false);
  assert.equal(renderDetail(item, 'Decision').nodes.some(node => node.type === 'TaskAttention'), false);
});

test('guidance covers every lane without turning in-progress work into an approval', () => {
  const base = cards(snapshot())[0];
  for (const [lane, tab, expected] of [['queue','Workers','priority'], ['planning','Plan','plan'], ['plan','Plan','approve'], ['progress','Workers','waiting'], ['review','Code review','accept'], ['delivery','Delivery','delivery'], ['done','Evidence','outcome']]) {
    const guide = kanbanGuidance({ ...base, lane, tab, running: 0 });
    assert.match(guide.title.toLowerCase(), new RegExp(expected)); assert.ok(guide.steps.length >= 2); assert.ok(guide.after);
  }
  assert.match(kanbanGuidance({ ...base, lane: 'planning', tab: 'Plan', running: 0 }).why, /no open plan approval/);
});

test('pending receipt, stale review and unavailable records keep their specific recovery paths', () => {
  const e = entry(); e.run = run(); e.decisions = [decision('plan', { status: 'approved', resume: { phase: 'pending', error: null } })];
  const pending = cards(snapshot([e]))[0]; assert.equal(pending.tab, 'Receipt');
  assert.match(kanbanGuidance(pending).after, /Do not approve/);
  assert.equal(kanbanGuidance({ ...pending, row: { ...pending.row, staleReview: true } }).action, 'Inspect changed revision');
  const offline = { ...pending, row: { ...pending.row, state: 'Unconfirmed' } };
  assert.match(kanbanGuidance(offline).title, /Reconnect/);
  assert.equal(renderDetail(offline, 'Next step', false).nodes.some(node => node.type === 'TaskAttention'), false);
});

test('multiple workers require a choice and archived workers are not chosen automatically', () => {
  const s = snapshot(); s.hosts[0].snapshot.agents = [worker('idle'), { ...worker('idle'), id: 'second' }];
  const row = { ...cards(s)[0].row, state: 'Blocked', workflow: { stage: 'Blocked' } };
  assert.ok(renderDetail(kanbanTask(row), 'Next step').nodes.some(node => node.props?.label === 'Choose a conversation'));
  row.workers[0].archivedAt = at;
  const rendered = renderDetail(kanbanTask(row), 'Next step');
  rendered.nodes.find(node => node.props?.label === 'Open worker conversation').props.onPress();
  assert.deepEqual(rendered.navigation, [{ serverId: 'remote', agentId: 'second' }]);
});

function renderDetail(item, tab, online = true) {
  const copies = [], navigation = [];
  const components = Object.fromEntries(['TaskPlan', 'TaskAttention', 'TaskDelivery', 'FleetWorkerTree', 'MissionReview', 'ReviewBrief', 'ReviewReadiness', 'TaskFlowDetail', 'CompactLink', 'HostRpcProvider'].map(name => [name, name]));
  let hook = 0;
  const mocks = {
    '@getpaseo/plugin/client': { useHosts: () => [{ serverId: item.row.serverId, status: online ? 'online' : 'offline' }] },
    'react': { useState: initial => [hook++ === 0 ? tab : initial, () => {}] },
    'react-native': { ScrollView: 'ScrollView', Text: 'Text', View: 'View' },
    'react/jsx-runtime': { jsx: (type, props) => ({ type, props }), jsxs: (type, props) => ({ type, props }) },
    './host-rpc': { ...components, useMissionControlCopy: id => { copies.push(id); return { copy: { serverId: id } }; } },
    './mission-control-v2-model': load('./mission-control-v2-model.ts'), './kanban-model': load('./kanban-model.ts'),
    '../shared/decision-receipt': load('../shared/decision-receipt.ts'),
  };
  const source = readFileSync(new URL('./kanban-detail.tsx', import.meta.url), 'utf8');
  const code = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX, target: ts.ScriptTarget.ES2022 } }).outputText;
  const module = { exports: {} };
  new Function('require', 'module', 'exports', code)(name => mocks[name] ?? components, module, module.exports);
  const tree = module.exports.KanbanDetail({ item, snapshot: snapshot(), colors: {}, compact: false, height: 900, navigation: { openAgent: input => navigation.push(input) }, close() {}, refresh() {} });
  const nodes = [];
  function visit(node) { if (Array.isArray(node)) return node.forEach(visit); if (!node || typeof node !== 'object') return; nodes.push(node); visit(node.props?.children); }
  visit(tree);
  return { nodes, copies, navigation };
}

test('rendered detail uses the owning host for the provider, plan and worker navigation', () => {
  const e = entry(); e.run = run(); e.decisions = [decision()]; const item = cards(snapshot([e]))[0];
  const rendered = renderDetail(item, 'Plan');
  assert.deepEqual(rendered.copies, ['remote']);
  assert.equal(rendered.nodes.find(node => node.type === 'HostRpcProvider').props.copy.serverId, 'remote');
  const plan = rendered.nodes.find(node => node.type === 'TaskPlan');
  assert.equal(plan.props.entry.task.taskId, 'task_a'); assert.equal(plan.props.host.serverId, 'remote');
  plan.props.openAgent('remote', 'worker'); assert.deepEqual(rendered.navigation, [{ serverId: 'remote', agentId: 'worker' }]);
  assert.ok(rendered.nodes.some(node => node.props?.label === 'Open saved plan documents'));
});

test('rendered details remove action components for offline, partial or unconfirmed tasks', () => {
  const item = cards(snapshot())[0];
  for (const variant of [renderDetail(item, 'Decision', false), renderDetail({ ...item, row: { ...item.row, limited: true } }, 'Plan'), renderDetail({ ...item, row: { ...item.row, state: 'Unconfirmed' } }, 'Delivery')]) {
    assert.equal(variant.nodes.some(node => ['HostRpcProvider', 'TaskPlan', 'TaskAttention', 'TaskDelivery'].includes(node.type)), false);
  }
});

test('review details pass the owning workspace to live readiness and suppress a known stale decision', () => {
  const e = entry(); e.run = run('review'); e.decisions = [decision('review')]; const s = snapshot([e]);
  s.hosts[0].snapshot.workspaces = [{ id: 'owned', name: 'Task checkout' }]; const item = cards(s)[0];
  const review = renderDetail(item, 'Code review').nodes.find(node => node.type === 'MissionReview');
  assert.equal(review.props.serverId, 'remote'); assert.equal(review.props.workspace.id, 'owned');
  const readiness = review.props.readiness({ marker: 'live' }, true);
  assert.equal(readiness.props.serverId, 'remote'); assert.equal(readiness.props.workspaceId, 'owned'); assert.equal(readiness.props.stale, true);
  assert.equal(renderDetail({ ...item, row: { ...item.row, staleReview: true } }, 'Decision').nodes.some(node => node.type === 'TaskAttention'), false);
});

test('new surface routes actions through existing host guards and disposes registrations', () => {
  const screen = readFileSync(new URL('./kanban.tsx', import.meta.url), 'utf8');
  const detail = readFileSync(new URL('./kanban-detail.tsx', import.meta.url), 'utf8');
  const data = readFileSync(new URL('./kanban-data.ts', import.meta.url), 'utf8');
  assert.match(screen, /trailing=\{trailing\}/); assert.match(screen, /removers\.forEach\(remove => remove\(\)\)/);
  assert.match(detail, /<HostRpcProvider copy=\{bridge\.copy\}>/);
  assert.match(detail, /<TaskPlan /); assert.match(detail, /<TaskAttention /); assert.match(detail, /<ReviewReadiness /);
  assert.match(detail, /kanbanCanAct\(row, online\)/); assert.match(detail, /tab === "Decision" && !row\.staleReview/);
  assert.match(data, /retainV2Hosts\(await read/); assert.match(data, /clearInterval\(timer\)/);
  assert.doesNotMatch(screen + detail + data, /\.agents\.(create|ref)\(|resolveDecision\(|\.send\(/);
});
