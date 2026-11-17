import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';

const source = readFileSync(new URL('./reopen-delivered-task.tsx', import.meta.url), 'utf8');
const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX } }).outputText;
const nodes = value => Array.isArray(value) ? value.flatMap(nodes) : value && typeof value === 'object' ? [value, ...nodes(value.props.children)] : [];
test('an offline coordinator leaves the fix ready and Start fix retries only enrollment on the correct host', async () => {
  const state = [], refs = [], reopens = [], starts = [];
  let cursor = 0, reachable = false, refreshes = 0;
  const jsx = (type, props) => ({ type, props });
  const reopenedAt = '2026-11-17T18:20:00.000Z';
  const fleet = { coordinators: [{ remoteServerId: 'remote', agentId: 'owner' }], state: { pipelines: [], revision: 12 } };
  const rpc = async (name, input) => { starts.push([name, JSON.parse(JSON.stringify(input))]); return { mode: 'running' }; };
  const modules = {
    react: { useState(initial) { const i = cursor++; return [i in state ? state[i] : initial, value => { state[i] = value; }]; }, useRef(initial) { const i = cursor++; return refs[i] ??= { current: initial }; } },
    'react/jsx-runtime': { jsx, jsxs: jsx, Fragment: 'Fragment' }, 'react-native': { View: 'View', Text: 'Text', TextInput: 'Input' },
    '@getpaseo/plugin/client': { useRpc: () => () => assert.fail('routed to the local host') },
    './host-rpc': { useRpc: () => async input => { reopens.push(JSON.parse(JSON.stringify(input))); return { ...task, status: 'ready', deliveryHistory: [{ reopenedAt }] }; } },
    './compact-link': { CompactLink: 'Link' }, './host-bridge': { listCopies: () => [] },
    './coordinating-fleet': { findCoordinatingFleet: async () => ({ managed: reachable, fleet, copy: { supports: () => true, rpc } }) },
    '../shared/tasks': { reopenDeliveredTask: {} }, '../shared/fleet': { readFleet: {} }, '../shared/pipeline': { startReopenedPipeline: { name: 'pipeline.reopened.start' } },
  };
  const module = { exports: {} }; runInNewContext(compiled, { exports: module.exports, require: path => modules[path] });
  const task = { taskId: 'task', status: 'delivered', updatedAt: 'revision' };
  function render() {
    cursor = 0;
    return nodes(module.exports.ReopenDeliveredTask({ task, serverId: 'remote', workspaceId: 'source', colors: {}, refresh() { refreshes++; } }));
  }
  const press = label => render().find(node => node.props.label === label).props.onPress();
  press('Reopen to fix…'); render().find(node => node.type === 'Input').props.onChangeText('  Barcode misprints  ');
  const submit = render().find(node => node.props.label === 'Reopen and start Standard fix').props.onPress;
  submit(); submit(); await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(reopens, [{ serverId: 'remote', workspaceId: 'source', taskId: 'task', expectedUpdatedAt: 'revision', reason: 'Barcode misprints' }]);
  assert.equal(starts.length, 0); assert.ok(render().some(node => String(node.props.children).includes('Reconnect the coordinating computer')));
  reachable = true; press('Start fix'); await new Promise(resolve => setImmediate(resolve));
  assert.equal(reopens.length, 1); assert.deepEqual(starts, [['pipeline.reopened.start', { coordinatorId: 'owner', remoteServerId: 'remote', taskId: 'task', reopenedAt, expectedRevision: 12 }]]);
  assert.equal(refreshes, 2);
});
