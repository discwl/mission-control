import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import vm from 'node:vm';
const require = createRequire(import.meta.url), ts = require('typescript');
const source = ts.transpileModule(readFileSync(new URL('./linked-tasks.tsx', import.meta.url), 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX, target: ts.ScriptTarget.ES2022 } }).outputText;
function harness(tasks) {
 const state = [], exports = {}; let cursor = 0, viewed = 0;
 const jsx = (type, props) => ({ type, props });
 const modal = Object.assign(() => {}, { Content: 'ModalContent' });
 vm.runInNewContext(source, { exports, require: name => {
  if (name === 'react') return { useState: initial => { const index = cursor++; if (!(index in state)) state[index] = initial; return [state[index], value => { state[index] = value; }]; } };
  if (name === 'react/jsx-runtime') return { jsx, jsxs: jsx };
  if (name === 'react-native') return { Text: 'Text', View: 'View', Pressable: 'Pressable' };
  if (name.includes('react-native')) return { Icon: 'Icon' };
  if (name === './compact-link') return { CompactLink: 'CompactLink' };
  if (name === './copy-task-id') return { CopyTaskId: 'CopyTaskId' };
  if (name === './app-modal') return { AppModal: modal };
  if (name === './task-flow') return { TaskFlowDetail: 'TaskFlowDetail' };
  throw new Error(name);
 } });
 const props = { tasks, colors: {}, serverId: 'server', workspaceId: 'workspace', hostLabel: 'Personal', online: true, openAgent() {}, viewAll() { viewed++; } };
 return { render() { cursor = 0; return exports.LinkedTasks(props); }, viewed: () => viewed, modal };
}
function nodes(value) { return !value || typeof value !== 'object' ? [] : Array.isArray(value) ? value.flatMap(nodes) : [value, ...nodes(value.props?.children)]; }
function text(value) { return value == null ? '' : typeof value === 'string' || typeof value === 'number' ? String(value) : Array.isArray(value) ? value.map(text).join('') : text(value.props?.children); }
const task = (id, status) => ({ taskId: `task-private-${id}`, title: `Task ${id}`, status });
test('active tasks are bounded and completed history is collapsed with no visible IDs', () => {
 const h = harness([...Array.from({ length: 7 }, (_, i) => task(i, 'in_review')), ...Array.from({ length: 8 }, (_, i) => task(i + 10, i % 2 ? 'closed' : 'delivered'))]);
 let tree = h.render();
 assert.equal(nodes(tree).filter(n => n.type === 'Pressable').length, 5);
 assert.ok(text(tree).includes('Showing 5 of 7 active tasks'));
 assert.ok(!text(tree).includes('task-private'));
 assert.ok(!text(tree).includes('Task 10'));
 const toggle = nodes(tree).find(n => n.props?.label === 'Completed tasks · 8');
 assert.equal(toggle.props.expanded, false); toggle.props.onPress(); tree = h.render();
 assert.equal(nodes(tree).filter(n => n.type === 'Pressable').length, 10);
 assert.ok(text(tree).includes('Showing 5 of 8 completed tasks'));
 nodes(tree).find(n => n.props?.label === 'View all tasks').props.onPress(); assert.equal(h.viewed(), 1);
});
test('row opens the exact task detail binding and modal closes', () => {
 const h = harness([task(1, 'blocked'), task(2, 'delivered')]);
 nodes(h.render()).find(n => n.type === 'Pressable').props.onPress();
 let tree = h.render(); const detail = nodes(tree).find(n => n.type === 'TaskFlowDetail');
 assert.equal(detail.props.task.taskId, 'task-private-1');
 assert.equal(detail.props.binding.serverId, 'server'); assert.equal(detail.props.binding.workspaceId, 'workspace'); assert.equal(detail.props.binding.taskId, 'task-private-1');
 nodes(tree).find(n => n.type === h.modal).props.onOpenChange(false);
 assert.ok(!nodes(h.render()).some(n => n.type === 'TaskFlowDetail'));
});
test('completed-only workspace shows no active tasks without expanding history', () => {
 const tree = harness([task(1, 'delivered')]).render();
 assert.ok(text(tree).includes('No active linked tasks.'));
 assert.equal(nodes(tree).filter(n => n.type === 'Pressable').length, 0);
});
