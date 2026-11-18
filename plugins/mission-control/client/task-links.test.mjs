import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';

const source = readFileSync(new URL('./task-links.tsx', import.meta.url), 'utf8');
const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX } }).outputText;
const jsx = (type, props) => ({ type, props });
const flatten = node => !node || typeof node !== 'object' ? [] : Array.isArray(node) ? node.flatMap(flatten) : [node, ...flatten(node.props.children)];
const makeTask = (serverId, id, ticket, handledUnder) => ({ row: { key: `${serverId}:${id}`, serverId, hostLabel: serverId, entry: { task: { taskId: id, updatedAt: 'v1', ticket: { key: ticket }, title: `${ticket} · task ${id}`, handledUnder } } } });

function fixture() {
  let cursor = 0;
  const state = [], calls = [], opens = [];
  const modules = {
    react: { useState(initial) { const i = cursor++; if (!(i in state)) state[i] = initial; return [state[i], value => { state[i] = value; }]; } },
    'react/jsx-runtime': { jsx, jsxs: jsx, Fragment: 'Fragment' }, 'react-native': { View: 'View', Text: 'Text', TextInput: 'TextInput' },
    '../shared/tasks': { setHandledUnder: { name: 'tasks.handled-under.set', output: { parse: result => result } } }, './compact-link': { CompactLink: 'Link' },
  };
  const exported = {};
  runInNewContext(compiled, { exports: exported, require: id => modules[id] });
  const item = makeTask('CNS', 'child', 'CN2-14617');
  const primary = makeTask('CNS', 'primary', 'CN2-14616');
  const tasks = [item, primary, makeTask('OTHER', 'primary', 'CN2-14616'), makeTask('CNS', 'sibling', 'CN2-14618', { serverId: 'CNS', taskId: 'primary' })];
  const props = { item, tasks, available: true, workspaceId: 'source-workspace', colors: {}, refresh() {}, onSaved(saved) { props.item.row.entry.task = { ...props.item.row.entry.task, ...saved }; }, openTask: key => opens.push(key), copy: {
    serverId: 'CNS', supports: () => true, async rpc(name, input) { calls.push({ name, ...input }); return { task: { taskId: input.taskId, handledUnder: input.targetTaskId ? { serverId: input.serverId, taskId: input.targetTaskId } : undefined } }; },
  } };
  const render = () => { cursor = 0; return flatten(exported.TaskLinkEditor(props)); };
  const button = label => render().find(node => node.type === 'Link' && node.props.label === label)?.props;
  return { props, primary, calls, opens, button, render, primaryLink: primaryTask => exported.PrimaryTaskLink({ ...props, primary: primaryTask, taskId: 'primary' }) };
}

test('explicit selection on the owning host persists the exact task IDs and observed version', async () => {
  const { button, calls } = fixture();
  button('Link to a primary task').onPress();
  assert.equal(button('CN2-14617 · task child'), undefined);
  assert.equal(button('CN2-14618 · task sibling'), undefined);
  button('CN2-14616 · task primary').onPress();
  assert.equal(calls.length, 0);
  button('Save link to CN2-14616').onPress();
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(calls, [{ name: 'tasks.handled-under.set', serverId: 'CNS', workspaceId: 'source-workspace', taskId: 'child', expectedUpdatedAt: 'v1', targetTaskId: 'primary' }]);
});

test('an intervening task update blocks an outdated edit; removal requires saving it', async () => {
  const { props, calls, button } = fixture();
  props.item.row.entry.task.handledUnder = { serverId: 'CNS', taskId: 'primary' };
  button('Edit task link').onPress(); button('Remove link').onPress();
  props.item.row.entry.task.updatedAt = 'v2';
  assert.equal(button('Save removal').disabled, true);
  button('Save removal').onPress();
  assert.equal(calls.length, 0);
  button('Task changed · reload selection').onPress(); button('Remove link').onPress(); button('Save removal').onPress();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(calls[0].targetTaskId, null);
  assert.equal(calls[0].expectedUpdatedAt, 'v2');
});

test('links open exact records in both directions and remain readable on an older host', () => {
  const { props, primary, primaryLink, opens, render, button } = fixture();
  assert.equal(primaryLink(primary).props.label, 'Handled under CN2-14616');
  primaryLink(primary).props.onPress();
  assert.equal(primaryLink(undefined).type, 'Text');
  props.copy.supports = () => false;
  button('Link to a primary task').onPress();
  assert.match(JSON.stringify(render()), /Update Mission Control on CNS/);
  assert.equal(button('Save link'), undefined);
  props.item = primary;
  button('Open CN2-14618').onPress();
  assert.deepEqual(opens, ['CNS:primary', 'CNS:sibling']);
});
