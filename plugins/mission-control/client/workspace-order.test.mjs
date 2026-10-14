import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import vm from 'node:vm';
import ts from 'typescript';
import { mergeHostOrder, moveVisibleHost } from './host-order.ts';
import { projectDropTarget } from './project-order.ts';
const require = createRequire(import.meta.url);
const React = require('react');
function fixture(scope) {
  const states = []; let cursor = 0;
  const saves = [];
  const values = { projectOrder: { host: ['project'] }, workspaceOrder: { '["host","project"]': ['a', 'hidden', 'b'], '["other","project"]': ['x'] }, hostOrder: ['host'], collapsedProjects: ['keep'], missionSectionOrder: ['tasks'] };
  const exports = {};
  const code = ts.transpileModule(readFileSync(new URL('./project-list.tsx', import.meta.url), 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX } }).outputText;
  vm.runInNewContext(code, { exports, setInterval, clearInterval, require(name) {
    if (name === 'react') return { ...React, useEffect() {}, useRef: value => ({ current: value }), useState(value) { const i = cursor++; if (!(i in states)) states[i] = value; return [states[i], next => { states[i] = typeof next === 'function' ? next(states[i]) : next; }]; } };
    if (name === 'react/jsx-runtime') return require(name);
    if (name === '@getpaseo/plugin/client') return { useSettings: () => ({ status: 'ready', saving: false, values, revision: 'rev', save: async (next, revision) => { saves.push({ next, revision }); return true; } }) };
    if (name === 'react-native') return { View: 'View', Text: 'Text', Pressable: 'Pressable' };
    if (name === './host-order') return { mergeHostOrder, moveVisibleHost };
    if (name === './project-order') return { projectDropTarget };
    if (name === './host-list') return { DragHandle: 'DragHandle' };
    if (name === './app-modal') return { AppModal: Object.assign(() => {}, { Content: 'Content' }) };
    if (name === './compact-link') return { CompactLink: 'CompactLink' };
    if (name === '../shared/preferences') return { missionPreferences: {} };
    throw new Error(name);
  }});
  const render = () => { cursor = 0; return exports.ProjectList({ serverId: 'host', workspaceScope: scope, projects: [{ id: 'a', name: 'A' }, { id: 'hidden', name: 'Hidden' }, { id: 'b', name: 'B' }], visibleIds: ['a', 'b'], colors: {}, scrollRef: { current: null }, scrollState: { current: { offset: 0 } }, renderProject: (item, handle) => handle }); };
  return { render, saves, values };
}
function walk(node, predicate) {
  if (!node || typeof node !== 'object') return null;
  if (predicate(node)) return node;
  for (const child of React.Children.toArray(node.props?.children)) { const found = walk(child, predicate); if (found) return found; }
  return null;
}
test('workspace movement saves only its host/project order and retains hidden slots and preferences', async () => {
  const h = fixture('project');
  walk(h.render(), n => n.type === 'DragHandle' && n.props.label === 'B workspace').props.open();
  walk(h.render(), n => n.type === 'Pressable' && n.props.accessibilityLabel === 'Move B earlier').props.onPress();
  await Promise.resolve();
  assert.equal(h.saves.length, 1);
  const { next, revision } = h.saves[0];
  assert.equal(revision, 'rev');
  assert.deepEqual(Array.from(next.workspaceOrder['["host","project"]']), ['b', 'hidden', 'a']);
  assert.equal(next.workspaceOrder['["other","project"]'], h.values.workspaceOrder['["other","project"]']);
  for (const key of ['projectOrder', 'hostOrder', 'collapsedProjects', 'missionSectionOrder']) assert.equal(next[key], h.values[key]);
});
test('existing project movement retains project storage and workspace preferences', async () => {
  const h = fixture(undefined);
  walk(h.render(), n => n.type === 'DragHandle' && n.props.label === 'B project').props.open();
  walk(h.render(), n => n.type === 'Pressable' && n.props.accessibilityLabel === 'Move B earlier').props.onPress();
  await Promise.resolve();
  assert.equal(h.saves.length, 1);
  assert.equal(h.saves[0].next.workspaceOrder, h.values.workspaceOrder);
  assert.deepEqual(Array.from(h.saves[0].next.projectOrder.host), ['project', 'b', 'hidden', 'a']);
});
