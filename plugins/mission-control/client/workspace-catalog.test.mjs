import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import vm from 'node:vm';
const require = createRequire(import.meta.url), ts = require('typescript');
const jsx = (type, props) => ({ type, props });
const nodes = value => !value || typeof value !== 'object' ? [] : Array.isArray(value) ? value.flatMap(nodes) : [value, ...nodes(value.props?.children)];
const text = value => value == null ? '' : typeof value === 'string' ? value : Array.isArray(value) ? value.map(text).join('') : text(value.props?.children);
function harness(surface, { host = 'remote', workspace = 'w1', cwd = 'C:/work/one', workspaceError = null, resolved = true, archived = false } = {}) {
  const queries = [], calls = [], exports = {};
  const api = serverId => ({
    workspaces: { ref: id => ({ refresh: async () => { calls.push({ kind: 'workspace', serverId, id }); return { workspaceDirectory: cwd, archivingAt: archived ? 'now' : null }; } }) },
    providers: {
      listAvailable: async () => ({ providers: [{ provider: 'opencode', available: true }] }),
      listModels: async (provider, options) => { calls.push({ kind: 'models', serverId, provider, options }); return { models: [] }; },
      listModes: async (provider, options) => { calls.push({ kind: 'modes', serverId, provider, options }); return { modes: [] }; },
    },
  });
  const code = ts.transpileModule(readFileSync(new URL(`./${surface}.tsx`, import.meta.url), 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX, target: ts.ScriptTarget.ES2022 } }).outputText;
  vm.runInNewContext(code, { exports, require: name => {
    if (name === 'react/jsx-runtime') return { jsx, jsxs: jsx };
    if (name === 'react') return { useRef: initial => ({ current: initial }), useState: initial => [initial, () => {}] };
    if (name === '@getpaseo/plugin/client') return { getPaseoClient: api, useHosts: () => [{ serverId: host, status: 'online' }], useRpc: () => async () => ({}) };
    if (name === './host-rpc') return { useRpc: () => async () => ({}) };
    if (name === '@tanstack/react-query') return { useQueryClient: () => ({ invalidateQueries() {} }), useQuery: query => {
      queries.push(query); const key = query.queryKey[1];
      const result = { data: undefined, error: null, isError: false, isPending: false, isFetching: false, refetch() {} };
      if (key === 'catalog-workspace') return { ...result, data: resolved ? cwd : undefined, error: workspaceError, isError: Boolean(workspaceError), isPending: !resolved && !workspaceError };
      if (key.endsWith('-providers')) return { ...result, data: { providers: [{ provider: 'opencode', available: true }] } };
      if (key.endsWith('-models')) return { ...result, data: query.enabled ? { models: [{ id: 'JCI/model', label: 'Model', thinkingOptions: [] }] } : undefined };
      if (key.endsWith('-modes')) return { ...result, data: { modes: [] } };
      return { ...result, data: key === 'launch' ? { action: 'start', message: 'Ready', canIsolate: false } : { missing: [] } };
    } };
    if (name === 'react-native') return { Pressable: 'Pressable', ScrollView: 'ScrollView', Text: 'Text', TextInput: 'TextInput', View: 'View' };
    if (name === './roster') return { useRoster: () => ({}), findAgent() {} };
    if (name === './subagents') return { useTaskTitles: () => ({}) };
    if (name === './date-time') return { formatDateTime: String };
    if (name === '../shared/task-summary') return { taskSummaryKey: id => [id] };
    if (name === '../shared/tickets') return { ticketSystemLabels: {}, ticketIdentity: () => '' };
    return {};
  } });
  const tree = surface === 'task-launcher'
    ? exports.TaskLauncher({ binding: { serverId: host, workspaceId: workspace, taskId: 'task' }, colors: {} })
    : exports.MorningCheck({ ownServerId: host, host: { serverId: host, status: 'online', label: 'Host' }, workspace: { id: workspace, name: 'Workspace' }, colors: {} });
  return { tree, calls, queries, query: suffix => queries.find(q => q.queryKey[1].endsWith(suffix)) };
}
for (const surface of ['task-launcher', 'morning-check']) {
  test(`${surface}: resolves the exact host/workspace and scopes catalog requests`, async () => {
    const h = harness(surface);
    assert.equal(await h.query('catalog-workspace').queryFn(), 'C:/work/one');
    assert.deepEqual(h.calls[0], { kind: 'workspace', serverId: 'remote', id: 'w1' });
    for (const q of h.queries.filter(q => /-(models|modes)$/.test(q.queryKey[1]))) {
      assert.equal(q.enabled, true); await q.queryFn();
      const call = h.calls.at(-1);
      assert.equal(call.serverId, 'remote'); assert.equal(call.provider, 'opencode'); assert.equal(call.options.cwd, 'C:/work/one');
    }
  });
  test(`${surface}: separates hosts, workspace IDs and directories in catalog caches`, () => {
    const first = harness(surface).query('-models').queryKey;
    for (const options of [{ host: 'another' }, { workspace: 'w2' }, { cwd: 'C:/work/two' }]) {
      assert.notEqual(JSON.stringify(harness(surface, options).query('-models').queryKey), JSON.stringify(first));
    }
  });
  test(`${surface}: does not discover against the default location while workspace is missing`, () => {
    for (const options of [{ resolved: false }, { workspaceError: new Error('Workspace disconnected') }]) {
      const h = harness(surface, options);
      assert.equal(h.query('-models').enabled, false);
      if (surface === 'task-launcher') assert.equal(h.query('-modes').enabled, false);
      const label = surface === 'task-launcher' ? 'Start task' : 'Run Discovery';
      const button = nodes(h.tree).find(n => n.type === 'Pressable' && text(n) === label);
      assert.equal(button.props.disabled, true);
      if (options.workspaceError) assert.match(text(h.tree), /Workspace disconnected/);
    }
  });
  test(`${surface}: rejects an unavailable or archiving workspace`, async () => {
    for (const options of [{ cwd: '' }, { archived: true }]) {
      const h = harness(surface, options);
      await assert.rejects(h.query('catalog-workspace').queryFn(), /workspace is unavailable/i);
      assert.equal(h.calls.some(c => c.kind === 'models' || c.kind === 'modes'), false);
    }
  });
}
