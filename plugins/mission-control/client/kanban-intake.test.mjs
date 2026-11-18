import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
const require = createRequire(import.meta.url), ts = require("typescript");
const compile = source => ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX } }).outputText;
require.extensions[".ts"] = (module, file) => module._compile(compile(readFileSync(file, "utf8")), file);
const contracts = require("../shared/intake.ts");
const jsx = (type, props) => ({ type, props });
function fixture() {
  const state = new Map(), hooks = [], calls = []; let cursor = 0, fail = false;
  const prefix = "kanban-intake:personal";
  for (const [key, value] of Object.entries({ mode: "describe", host: "remote", workspace: "work", title: "Fix invoices", requirements: "No duplicates", action: "backlog" })) state.set(`${prefix}:${key}`, value);
  const snapshot = { serverId: "personal", coordinators: [{ agentId: "coordinator", remoteServerId: "remote" }], hosts: [{ serverId: "remote", label: "Remote", error: null, snapshot: { complete: true, observedAt: new Date().toISOString(), warnings: [], workspaces: [{ id: "work", name: "Main", projectName: "Project", status: "idle" }] } }] };
  const module = { exports: {} }, deps = {
    'react/jsx-runtime': { jsx, jsxs: jsx },
    'react': { useState: initial => { const id = cursor++; if (!(id in hooks)) hooks[id] = initial; return [hooks[id], value => hooks[id] = typeof value === 'function' ? value(hooks[id]) : value]; } },
    'react-native': Object.fromEntries(['Pressable','ScrollView','Text','TextInput','View'].map(name => [name,name])),
    '@getpaseo/plugin/client': { useHosts: () => [{ serverId: 'remote', status: 'online', label: 'Remote' }], useRpc: contract => async input => { calls.push({ method: contract.name, input }); if (fail) { fail = false; throw new Error('Lost reply'); } return { taskId: `task_${input.requestId}`, title: input.title, action: input.action, completed: true, message: 'Saved to backlog' }; } },
    '@getpaseo/plugin/client/ui': { Icon: 'Icon' },
    '../shared/intake': contracts,
    './compact-link': { CompactLink: 'CompactLink' },
    './morning-check': { MorningCheck: 'MorningCheck' },
    './page-state': { usePageState: (key, initial) => { if (!state.has(key)) state.set(key, initial); return [state.get(key), value => state.set(key, typeof value === 'function' ? value(state.get(key)) : value)]; } },
  };
  new Function('require','module','exports',compile(readFileSync(new URL('./kanban-intake.tsx',import.meta.url),'utf8')))(name => deps[name] ?? require(name),module,module.exports);
  function render() { cursor = 0; const tree = module.exports.KanbanIntake({ snapshot, colors: {}, navigation: {}, close() {}, refresh() {}, openTask() {} }); const nodes = []; const walk = node => { if (!node || typeof node !== 'object') return; if (Array.isArray(node)) return node.forEach(walk); nodes.push(node); walk(node.props?.children); }; walk(tree); return nodes; }
  return { state, snapshot, calls, render, remount: () => { hooks.length = 0; }, failOnce: () => { fail = true; } };
}
const settle = () => new Promise(resolve => setImmediate(resolve));
test('Describe defaults to backlog, sends exact host identity and retains the request through a lost reply', async () => {
  const f = fixture(); f.failOnce();
  let tree = f.render(); const button = tree.find(node => node.type === 'CompactLink' && node.props.label === 'Save to backlog');
  assert.equal(button.props.disabled, false); button.props.onPress(); await settle();
  const pending = f.state.get('kanban-intake:personal:pending'); assert.ok(pending.requestId);
  tree = f.render(); assert.ok(tree.find(node => node.props?.accessibilityLabel === 'Task title').props.editable === false);
  tree.find(node => node.props?.label === 'Retry saved request').props.onPress(); await settle();
  assert.equal(f.calls.length, 2); assert.deepEqual(f.calls[0], f.calls[1]);
  assert.equal(f.calls[0].input.remoteServerId, 'remote'); assert.equal(f.calls[0].input.workspaceId, 'work'); assert.equal(f.calls[0].input.action, 'backlog');
  assert.equal(f.calls[0].input.requestedWorkflow, 'standard');
  assert.equal(f.state.get('kanban-intake:personal:pending'), null); assert.equal(f.state.get('kanban-intake:personal:receipts').length, 1);
});
test('Discovery receives the selected remote coordinator and workspace, not Personal', () => {
  const f = fixture(); f.state.set('kanban-intake:personal:mode', 'discover');
  const discovery = f.render().find(node => node.type === 'MorningCheck');
  assert.equal(discovery.props.ownServerId, 'remote'); assert.equal(discovery.props.coordinatorId, 'coordinator'); assert.equal(discovery.props.workspace.id, 'work');
  assert.equal(discovery.props.requestedWorkflow, 'standard');
  discovery.props.onImported([{ taskId: `task_${randomUUID()}`, title: 'Selected ticket', requestedWorkflow: 'standard' }]);
  assert.equal(f.state.get('kanban-intake:personal:receipts')[0].requestedWorkflow, 'standard');
  assert.equal(f.calls.length, 0); assert.equal(f.state.get('kanban-intake:personal:receipts')[0].action, 'backlog');
});
const link = (f, label) => f.render().find(node => node.type === 'CompactLink' && node.props.label === label);

test('new tasks default to Standard; an override survives a draft, capture, retry and scheduling', async () => {
  for (const [label, workflow, action] of [['Advanced', 'advanced', 'plan'], ['Manual', 'manual', 'queue']]) {
    const f = fixture();
    link(f, label).props.onPress();
    f.remount();
    assert.equal(link(f, label).props.selected, true);
    f.failOnce();
    link(f, 'Save to backlog').props.onPress(); await settle();
    f.remount();
    assert.equal(link(f, label).props.disabled, true);
    link(f, 'Retry saved request').props.onPress(); await settle();
    assert.deepEqual(f.calls[0], f.calls[1]);
    assert.equal(f.calls[0].input.requestedWorkflow, workflow);
    assert.equal(link(f, 'Standard').props.selected, true);
    link(f, action === 'plan' ? 'Plan now' : 'Queue for planning').props.onPress(); await settle();
    assert.equal(f.calls[2].input.requestedWorkflow, workflow);
    assert.equal(f.calls[2].input.action, action);
  }
});

test('leaving an empty form discards its choice, typing into that form saves it with the draft', () => {
  const f = fixture();
  for (const key of ['title', 'requirements']) f.state.set(`kanban-intake:personal:${key}`, '');
  link(f, 'Advanced').props.onPress();
  f.remount();
  assert.equal(link(f, 'Standard').props.selected, true);
  link(f, 'Manual').props.onPress();
  f.render().find(node => node.props?.accessibilityLabel === 'Task title').props.onChangeText('New task');
  f.remount();
  assert.equal(link(f, 'Manual').props.selected, true);
});

test('routing an older saved receipt preserves its original workflow behavior', async () => {
  const f = fixture();
  f.state.set('kanban-intake:personal:receipts', [{ taskId: `task_${randomUUID()}`, title: 'Older task', serverId: 'remote', coordinatorId: 'coordinator', action: 'backlog', completed: true }]);
  link(f, 'Advanced').props.onPress();
  link(f, 'Plan now').props.onPress(); await settle();
  assert.equal('requestedWorkflow' in f.calls[0].input, false);
});

test('stale host and ambiguous coordinators disable creation; invalid details stay editable', async () => {
  const f = fixture(); f.snapshot.hosts[0].snapshot.observedAt = '2020-01-01';
  assert.equal(f.render().find(node => node.props?.label === 'Save to backlog').props.disabled, true);
  f.snapshot.hosts[0].snapshot.observedAt = new Date().toISOString(); f.snapshot.coordinators.push({ agentId: 'other', remoteServerId: 'remote' });
  assert.equal(f.render().find(node => node.props?.label === 'Save to backlog').props.disabled, true);
  f.snapshot.coordinators.pop(); f.state.set('kanban-intake:personal:title', 'Invalid\nTitle');
  f.render().find(node => node.props?.label === 'Save to backlog').props.onPress(); await settle();
  assert.equal(f.calls.length, 0); assert.equal(f.state.get('kanban-intake:personal:pending'), null);
});
