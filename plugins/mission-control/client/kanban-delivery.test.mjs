import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
const compiled = ts.transpileModule(readFileSync(new URL('./kanban-detail.tsx', import.meta.url), 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX } }).outputText;
const nodes = node => !node || typeof node !== 'object' ? [] : Array.isArray(node) ? node.flatMap(nodes) : [node, ...nodes(node.props?.children)];
const model = { exports: {} };
const modelCode = ts.transpileModule(readFileSync(new URL('./kanban-model.ts', import.meta.url), 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
runInNewContext(modelCode, { exports: model.exports });
function render({ kind = 'code', online = true, builders = 1, stale = false, question = false, workflow, tierOnHost, runMode, projection = true, delivered = false, supported = true, tab = 'Delivery', followUp, related, hookState = [], navigation = {} } = {}) {
  const jsx = (type, props) => ({ type, props });
  const row = { key: 'remote:task', serverId: 'remote', hostLabel: 'CNS', state: online ? 'Needs you' : 'Unconfirmed', staleReview: stale,
    entry: { task: { taskId: 'task', title: 'Keep invoice dates consistent', acceptanceCriteria: ['Preserve the selected date'] }, run: { runId: 'run', workspaceId: 'workspace', agentId: 'reviewer' }, decisions: question ? [{ decision: { kind: 'review', status: 'open' } }] : [], questions: question ? [{ question: { status: 'open', question: 'Which date should be preserved?' } }] : [], pipeline: { runId: 'run', workflowMode: 'automatic', deliveryKind: kind, stage: 'delivery', mode: 'ready' } },
    host: { workspaces: [{ id: 'workspace', name: 'Invoice dates', projectName: 'Billing' }], complete: true },
    workers: Array.from({ length: builders }, (_, i) => ({ id: 'builder-' + i, workspaceId: 'workspace', archivedAt: null, labels: { 'mission-control.task-id': 'task', 'mission-control.role': 'builder' } })).concat([{ id: 'reviewer', workspaceId: 'workspace', archivedAt: null, labels: { 'mission-control.task-id': 'task', 'mission-control.role': 'reviewer' } }]), coordinators: [], queue: [] };
  row.entry.run.workflowMode = runMode;
  row.entry.runWorkflow = tierOnHost;
  if (projection) row.entry.pipeline.workflow = workflow; else delete row.entry.pipeline;
  if (delivered) Object.assign(row.entry.task, { status: 'delivered', worktree: { sourceWorkspaceId: 'source' }, assignments: [{ serverId: 'remote', workspaceId: 'source' }], pullRequest: { number: 13, repository: 'billing', url: 'https://example.test/pr/13', mergedAt: 'today' }, deliveryHistory: [{ reopenedAt: 'yesterday', reason: 'Test failed', pullRequest: { number: 12, repository: 'billing', url: 'https://example.test/pr/12' } }] });
  if (delivered === 'unverified') delete row.entry.task.pullRequest.mergedAt;
  if (followUp) {
    row.entry.run = followUp.run ?? null;
    delete row.entry.pipeline;
    row.entry.task.status = 'in_review';
    row.workflow = { stage: 'Your review', evidence: 'No run evidence recorded' };
    row.workers = [];
  }
  if (related) Object.assign(row.entry.task, { handledUnder: related.link, updatedAt: related.updatedAt });
  let cursor = 0;
  const modules = {
    react: { useState(initial) { const i = cursor++; if (!(i in hookState)) hookState[i] = typeof initial === 'function' ? initial() : initial; return [hookState[i], value => { hookState[i] = value; }]; } },
    'react/jsx-runtime': { jsx, jsxs: jsx, Fragment: 'Fragment' }, 'react-native': { ScrollView: 'ScrollView', Text: 'Text', View: 'View' },
    '@getpaseo/plugin/client': { useHosts: () => [{ serverId: 'remote', status: online ? 'online' : 'offline' }] },
    '../shared/tasks': { reopenDeliveredTask: { name: 'tasks.reopen-delivered' } },
    '../shared/decision-receipt': { decisionReceipt: () => null },
    './compact-link': { CompactLink: 'Link', CompactExternalLink: 'ExternalLink' }, './reopen-delivered-task': { ReopenDeliveredTask: 'Reopen' }, './host-rpc': { HostRpcProvider: 'HostScope', useMissionControlCopy: () => ({ copy: { id: 'remote-copy', supports: () => supported } }) },
    './fleet-task': { FleetWorkerTree: 'Workers', TaskAttention: 'Attention', TaskDelivery: 'Publish', TaskPlan: 'Plan' },
    './mission-review': { MissionReview: 'CodeReview' }, './review-report': { ReviewReport: 'LegacyReview' }, './review-readiness': { ReviewReadiness: 'LegacyReadiness' },
    './final-change-request': { FinalChangeRequest: 'RequestFixes' },
    './pipeline-review': { PipelineReviewEvidence: 'AutomaticEvidence' }, './action-delivery': { ActionDeliveryCard: 'ActionReview' }, './task-flow': { TaskFlowDetail: 'Evidence' },
    './mission-control-v2-model': { v2Workspace: () => 'workspace' },
    './kanban-model': { ...model.exports, kanbanCanAct: (_row, live) => live, kanbanHasRequest: () => question, kanbanGuidance: followUp ? model.exports.kanbanGuidance : () => ({ title: 'Review the completed work', why: 'The agents have finished their checks.', tab: 'Delivery', action: 'Review result', after: 'Choose whether to publish.', steps: [] }) },
    './task-links': { PrimaryTaskLink: 'PrimaryTaskLink', TaskLinkEditor: 'TaskLinkEditor' },
    './kanban-origin': { navigateFromKanban: (_server, act) => act() },
  };
  const module = { exports: {} }; runInNewContext(compiled, { exports: module.exports, require: name => { if (!(name in modules)) throw Error(name); return modules[name]; } });
  const item = followUp ? model.exports.kanbanTask(row) : { row, lane: 'attention', tab: question === true ? 'Decision' : tab, label: 'Ready to publish', needsYou: true };
  return module.exports.KanbanDetail({ item, tasks: related?.tasks ?? [], openTask: related?.openTask ?? (() => {}), snapshot: { serverId: followUp?.installation ?? 'personal', coordinators: followUp?.coordinators ?? [], state: { pipelines: [], revision: 1 } }, colors: {}, compact: false, height: 900, navigation, close() {}, refresh() {} });
}
test('unowned review card explains the missing request and opens only the correct host orchestrator', () => {
  const coordinator = (agentId, remoteServerId, archivedAt = null) => ({ agentId, remoteServerId, name: agentId, agent: { archivedAt } });
  const opened = [];
  const navigation = { openAgent: target => opened.push([target.serverId, target.agentId]) };
  const tree = render({ followUp: { coordinators: [coordinator('wrong-host', 'elsewhere'), coordinator('old-chat', 'remote', 'yesterday'), coordinator('cns-chat', 'remote')] }, navigation });
  const links = nodes(tree).filter(node => node.type === 'Link');
  assert.match(JSON.stringify(tree), /No action needed from you/);
  assert.ok(links.some(node => node.props.label === 'Next step' && node.props.selected));
  assert.ok(!links.some(node => node.props.label === 'Find owner in workspace'));
  links.find(node => node.props.label === 'Open CNS orchestrator').props.onPress();
  assert.deepEqual(opened, [['personal', 'cns-chat']]);
});

test('handled-under links use the exact host and task even when ticket keys collide, preserving any open question', () => {
  const primary = serverId => ({ row: { key: `${serverId}:primary`, serverId, entry: { task: { taskId: 'primary', ticket: { key: 'A-1' } } } } });
  const local = primary('remote');
  const related = { link: { serverId: 'remote', taskId: 'primary' }, tasks: [primary('elsewhere'), local] };
  const tree = render({ followUp: {}, related });
  assert.equal(nodes(tree).find(n => n.type === 'PrimaryTaskLink').props.primary, local);
  assert.match(JSON.stringify(tree), /Follow the primary task/);
  const standalone = render({ followUp: {}, related: { ...related, tasks: [primary('elsewhere')] } });
  assert.equal(nodes(standalone).find(n => n.type === 'PrimaryTaskLink').props.primary, undefined);
  assert.doesNotMatch(JSON.stringify(standalone), /Follow the primary task/);
  assert.ok(nodes(render({ question: true, related })).find(n => n.type === 'Attention'));
});

test('a confirmed link removal replaces an older snapshot immediately and yields to newer host data', () => {
  const related = { link: { serverId: 'remote', taskId: 'primary' }, tasks: [], updatedAt: '2026-11-17T03:00:00Z' };
  const hookState = [], draw = () => nodes(render({ related, hookState }));
  const findLink = () => draw().find(node => node.type === 'PrimaryTaskLink');
  assert.ok(findLink());
  draw().find(node => node.type === 'TaskLinkEditor').props.onSaved({ taskId: 'task', updatedAt: '2026-11-17T03:01:00Z' });
  assert.equal(findLink(), undefined);
  related.updatedAt = '2026-11-17T03:02:00Z';
  assert.ok(findLink());
});

test('host-local follow-up without a coordinator shows the saved handoff and opens the task workspace', () => {
  const opened = [];
  const run = { runId: 'run', workspaceId: 'workspace', updatedAt: '2026-11-02T00:00:00Z', nextAction: 'Waiting for QA to confirm the deployment.' };
  const tree = render({ followUp: { installation: 'remote', run }, navigation: { openWorkspace: target => opened.push([target.serverId, target.workspaceId]) } });
  assert.match(JSON.stringify(tree), /Last saved handoff/);
  assert.match(JSON.stringify(tree), /Waiting for QA to confirm the deployment/);
  const links = nodes(tree).filter(node => node.type === 'Link');
  assert.ok(!links.some(node => /orchestrator/i.test(node.props.label)));
  links.find(node => node.props.label === 'Open workspace on CNS').props.onPress();
  assert.deepEqual(opened, [['remote', 'workspace']]);
});

test('Ready to publish includes the existing code review and comments component on the owning host', () => {
  const tree = render(); const all = nodes(tree); const review = all.find(node => node.type === 'CodeReview');
  assert.ok(review); assert.equal(review.props.serverId, 'remote'); assert.equal(review.props.workspace.id, 'workspace');
  assert.equal(review.props.agentId, 'builder-0'); assert.equal(review.props.requireAgentSelection, true);
  assert.ok(all.find(node => node.type === 'Publish')); assert.ok(all.indexOf(review) < all.findIndex(node => node.type === 'Publish'));
  const brief = review.props.brief({ head: 'head' }, false, () => {});
  assert.ok(nodes(brief).some(node => node.type === 'AutomaticEvidence'));
  assert.equal(nodes(brief).some(node => node.type === 'LegacyReview'), false);
  assert.equal(review.props.readiness({}, false), null);
});
test('workflow appears beside status and the plan and review instructions match the selected level', () => {
  for (const [workflow, label, plan, review] of [['standard', 'Standard workflow', /One independent reviewer/, /builder’s validation/], ['advanced', 'Advanced workflow', /different model checks/, /both independent review reports/]]) {
    const screen = nodes(render({ workflow, tab: 'Plan' }));
    assert.ok(screen.some(node => node.props.children === label));
    assert.match(JSON.stringify(screen), plan);
    assert.match(JSON.stringify(nodes(render({ workflow }))), review);
    assert.ok(nodes(render({ tierOnHost: workflow, projection: false })).some(node => node.props.children === label));
  }
  for (const [runMode, label] of [['manual', 'Manual workflow'], ['automatic', 'Automatic workflow']]) {
    assert.ok(nodes(render({ runMode, projection: false })).some(node => node.props.children === label));
  }
  assert.doesNotMatch(JSON.stringify(nodes(render({ projection: false }))), /Workflow not recorded|Standard workflow|Advanced workflow/);
  assert.match(JSON.stringify(nodes(render({ projection: false, tab: 'Evidence' }))), /The saved run does not identify its workflow/);
});
test('historical approval evidence identifies Manual only on the exact run with no automatic ownership', () => {
  const run = { taskId: 't', serverId: 's', workspaceId: 'w', runId: 'r' };
  const entry = { task: { taskId: 't', status: 'in_progress' }, run, decisions: [] };
  const decide = overrides => ({ decision: { ...run, kind: 'review', status: 'approved', ...overrides } });
  const resolve = (decisions, overrides = {}) => model.exports.kanbanWorkflow({ ...entry, decisions, ...overrides });
  assert.equal(resolve([decide({})]), 'manual');
  for (const key of ['taskId', 'serverId', 'workspaceId', 'runId']) assert.equal(resolve([decide({ [key]: 'other' })]), 'unknown');
  assert.equal(resolve([decide({ status: 'superseded' })]), 'unknown');
  assert.equal(resolve([decide({})], { pipeline: { runId: 'r', workflow: 'advanced' } }), 'advanced');
  assert.equal(resolve([decide({})], { run: { ...run, workflowMode: 'automatic' } }), 'automatic');
  for (const status of ['delivered', 'in_progress', 'closed']) assert.equal(resolve([], { run: null, task: { status } }), 'noRun');
  for (const status of ['inbox', 'ready']) assert.equal(resolve([], { run: null, task: { status } }), 'unselected');
  for (const requestedWorkflow of ['standard', 'advanced', 'manual']) {
    assert.equal(resolve([], { run: null, task: { status: 'inbox', requestedWorkflow } }), requestedWorkflow);
    assert.equal(resolve([], { task: { ...entry.task, requestedWorkflow } }), 'unknown');
  }
  assert.equal(resolve([], { run: null, task: { status: 'ready' }, problem: 'Read failed' }), 'unknown');
  assert.equal(model.exports.kanbanWorkflow({ ...entry, run: null }, { workflowMode: 'automatic', workflow: 'standard' }), 'standard');
});
test('reopen targets the source workspace on its owning host and keeps earlier PRs visible offline', () => {
  const tree = nodes(render({ delivered: true }));
  const reopen = tree.find(node => node.type === 'Reopen');
  assert.equal(reopen.props.workspaceId, 'source'); assert.equal(reopen.props.serverId, 'remote');
  assert.equal(tree.some(node => node.type === 'Publish'), false);
  assert.equal(nodes(render({ delivered: 'unverified' })).some(node => node.type === 'Reopen'), false);
  const followUp = nodes(render({ delivered: true, question: 'follow-up', tab: 'Evidence' }));
  assert.ok(followUp.some(node => node.props.children === 'Which date should be preserved?'));
  assert.ok(followUp.some(node => node.props.label === 'View open question'));
  const older = nodes(render({ delivered: true, supported: false }));
  assert.equal(older.some(node => node.type === 'Reopen'), false);
  assert.match(JSON.stringify(older), /Update Mission Control/);
  const offline = nodes(render({ delivered: true, online: false }));
  assert.equal(offline.some(node => node.type === 'Reopen'), false);
  assert.deepEqual(offline.filter(node => node.type === 'ExternalLink').map(node => node.props.href), ['https://example.test/pr/13', 'https://example.test/pr/12']);
});
test('multiple builders require an explicit comment recipient instead of choosing the last reviewer', () => {
  const review = nodes(render({ builders: 2 })).find(node => node.type === 'CodeReview');
  assert.equal(review.props.agentId, undefined); assert.equal(review.props.requireAgentSelection, true);
});
test('prepared actions use their exact action authorization without code or PR controls', () => {
  const all = nodes(render({ kind: 'actions' })); const actions = all.find(node => node.type === 'ActionReview');
  assert.equal(actions.props.serverId, 'remote'); assert.equal(actions.props.actorId, 'human-ui');
  assert.equal(all.some(node => ['CodeReview', 'Publish'].includes(node.type)), false);
});
test('a stale review cannot hide a current question or expose its old approval', () => {
  const attention = nodes(render({ stale: true, question: true })).find(node => node.type === 'Attention');
  assert.ok(attention); assert.equal(attention.props.entry.questions.length, 1); assert.equal(attention.props.entry.decisions.length, 0);
});
test('offline tasks remove review actions and publication controls; stale reviews cannot publish', () => {
  assert.equal(nodes(render({ online: false })).some(node => ['CodeReview', 'Publish', 'ActionReview'].includes(node.type)), false);
  assert.equal(nodes(render({ stale: true })).some(node => node.type === 'Publish'), false);
});
