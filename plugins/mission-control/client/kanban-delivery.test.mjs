import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
const compiled = ts.transpileModule(readFileSync(new URL('./kanban-detail.tsx', import.meta.url), 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX } }).outputText;
const nodes = node => !node || typeof node !== 'object' ? [] : Array.isArray(node) ? node.flatMap(nodes) : [node, ...nodes(node.props?.children)];
function render({ kind = 'code', online = true, builders = 1, stale = false, question = false } = {}) {
  const jsx = (type, props) => ({ type, props });
  const row = { key: 'remote:task', serverId: 'remote', hostLabel: 'CNS', state: online ? 'Needs you' : 'Unconfirmed', staleReview: stale,
    entry: { task: { taskId: 'task', title: 'Keep invoice dates consistent', acceptanceCriteria: ['Preserve the selected date'] }, run: { runId: 'run', workspaceId: 'workspace', agentId: 'reviewer' }, decisions: question ? [{ decision: { kind: 'review', status: 'open' } }] : [], questions: question ? [{ question: { status: 'open', question: 'Which date should be preserved?' } }] : [], pipeline: { runId: 'run', workflowMode: 'automatic', deliveryKind: kind, stage: 'delivery', mode: 'ready' } },
    host: { workspaces: [{ id: 'workspace', name: 'Invoice dates', projectName: 'Billing' }], complete: true },
    workers: Array.from({ length: builders }, (_, i) => ({ id: 'builder-' + i, workspaceId: 'workspace', archivedAt: null, labels: { 'mission-control.task-id': 'task', 'mission-control.role': 'builder' } })).concat([{ id: 'reviewer', workspaceId: 'workspace', archivedAt: null, labels: { 'mission-control.task-id': 'task', 'mission-control.role': 'reviewer' } }]), coordinators: [], queue: [] };
  const modules = {
    react: { useState: value => [typeof value === 'function' ? value() : value, () => {}] },
    'react/jsx-runtime': { jsx, jsxs: jsx, Fragment: 'Fragment' }, 'react-native': { ScrollView: 'ScrollView', Text: 'Text', View: 'View' },
    '@getpaseo/plugin/client': { useHosts: () => [{ serverId: 'remote', status: online ? 'online' : 'offline' }] },
    '../shared/decision-receipt': { decisionReceipt: () => null },
    './compact-link': { CompactLink: 'Link' }, './host-rpc': { HostRpcProvider: 'HostScope', useMissionControlCopy: () => ({ copy: { id: 'remote-copy' } }) },
    './fleet-task': { FleetWorkerTree: 'Workers', TaskAttention: 'Attention', TaskDelivery: 'Publish', TaskPlan: 'Plan' },
    './mission-review': { MissionReview: 'CodeReview' }, './review-report': { ReviewReport: 'LegacyReview' }, './review-readiness': { ReviewReadiness: 'LegacyReadiness' },
    './final-change-request': { FinalChangeRequest: 'RequestFixes' },
    './pipeline-review': { PipelineReviewEvidence: 'AutomaticEvidence' }, './action-delivery': { ActionDeliveryCard: 'ActionReview' }, './task-flow': { TaskFlowDetail: 'Evidence' },
    './mission-control-v2-model': { v2Workspace: () => 'workspace' },
    './kanban-model': { kanbanCanAct: (_row, live) => live, kanbanHasRequest: () => question, kanbanGuidance: () => ({ title: 'Review the completed work', why: 'The agents have finished their checks.', tab: 'Delivery', action: 'Review result', after: 'Choose whether to publish.', steps: [] }) },
    './kanban-origin': { navigateFromKanban: (_server, act) => act() },
  };
  const module = { exports: {} }; runInNewContext(compiled, { exports: module.exports, require: name => { if (!(name in modules)) throw Error(name); return modules[name]; } });
  return module.exports.KanbanDetail({ item: { row, lane: 'attention', tab: question ? 'Decision' : 'Delivery', label: 'Ready to publish', needsYou: true }, snapshot: { serverId: 'personal', state: { pipelines: [], revision: 1 } }, colors: {}, compact: false, height: 900, navigation: {}, close() {}, refresh() {} });
}
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
