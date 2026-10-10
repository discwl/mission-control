import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import vm from 'node:vm';
const require = createRequire(import.meta.url), ts = require('typescript');
const compile = file => ts.transpileModule(readFileSync(new URL(file, import.meta.url), 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX, target: ts.ScriptTarget.ES2022 } }).outputText;
const jsx = (type, props) => ({ type, props });
function hooks() {
 const values = [], effects = [], cleanups = []; let cursor = 0;
 return { react: {
  useState(initial) { const index = cursor++; if (!(index in values)) values[index] = typeof initial === 'function' ? initial() : initial; return [values[index], next => { values[index] = typeof next === 'function' ? next(values[index]) : next; }]; },
  useRef(initial) { const index = cursor++; return values[index] ??= { current: initial }; },
  useEffect(fn, deps) { const index = cursor++, old = values[index]; if (!old || deps.some((value, i) => value !== old[i])) { values[index] = deps; effects.push(() => { cleanups[index]?.(); cleanups[index] = fn(); }); } },
  createContext(initial) { return { Provider: 'Provider', current: initial }; }, useContext(context) { return context.current; }
 }, render(fn) { cursor = 0; const result = fn(); while (effects.length) effects.shift()(); return result; }, unmount() { cleanups.forEach(fn => fn?.()); } };
}
function loadDocs(draft = false) {
 const hook = hooks(), exports = {};
 vm.runInNewContext(compile('./mission-docs.tsx'), { exports, require: name => {
  if (name === 'react') return hook.react;
  if (name === 'react/jsx-runtime') return { jsx, jsxs: jsx };
  if (name === '@getpaseo/plugin/client' || name === './host-rpc') return { useRpc: () => async () => ({}) };
  if (name === '@getpaseo/plugin/client/react-native') return { Icon: 'Icon', TextInput: 'TextInput' };
  if (name === '@tanstack/react-query') return { useQueryClient: () => ({ invalidateQueries() {} }), useQuery: ({ queryKey }) => ({ data: queryKey[1] === 'vault-status' ? { exists: true, root: 'C:/dev-vault', name: 'dev-vault', initialized: true, obsidianRegistered: true } : queryKey[1] === 'vault-file' ? { path: queryKey[3], revision: 'v1' } : { entries: [] }, refetch() {}, isPending: false }) };
  if (name === 'react-native') return { Linking: {}, Platform: { OS: 'web' }, Pressable: 'Pressable', Text: 'Text', View: 'View' };
  if (name === '../shared/vault') return { defaultVaultPath: 'C:/dev-vault' };
  if (name === './page-memory') return { pageKey: (...parts) => parts.join(':') };
  if (name === './page-state') return { PageScrollView: 'ScrollView', usePageState: (key, initial) => hook.react.useState(() => key.endsWith(':selection') ? { path: 'Projects/development-flow.md', kind: 'file' } : typeof initial === 'function' ? initial() : initial) };
  if (name === './vault-editor') return { hasVaultDraft: () => draft, VaultEditor: 'VaultEditor', VaultButton: 'VaultButton', discardVaultDraft: () => true, vaultError: String };
  if (name === './app-modal') return { AppModal: Object.assign(() => {}, { Content: 'ModalContent' }) };
  if (name === './document-links') return { VaultDocumentLinks: 'VaultDocumentLinks' };
  if (name === './vault-tree') return { VaultTree: 'VaultTree' };
  if (name === './breadcrumbs') return { Breadcrumbs: 'Breadcrumbs' };
  throw new Error(name);
 } });
 const props = { theme: { colors: {} }, host: { id: 'personal-owner' }, hostLabel: 'Personal', layout: { compact: true } };
 return { render(extra = {}) { return hook.render(() => exports.MissionDocs({ ...props, ...extra })); }, unmount: hook.unmount };
}
function nodes(value) { return !value || typeof value !== 'object' ? [] : Array.isArray(value) ? value.flatMap(nodes) : [value, ...nodes(value.props?.children)]; }
function text(value) { return value == null ? '' : typeof value === 'string' ? value : Array.isArray(value) ? value.map(text).join('') : text(value.props?.children); }
test('Docs selects an exact handoff path on the owning host and consumes the request', () => {
 const h = loadDocs(), path = 'Tasks/task_abc/runs/run_def/handoff.md'; let handled = 0;
 h.render({ initialDocument: { path, requestId: 1 }, onDocumentHandled() { handled++; } });
 const tree = h.render(), editor = nodes(tree).find(node => node.type === 'VaultEditor');
 assert.equal(editor.props.file.path, path); assert.equal(editor.props.serverId, 'personal-owner'); assert.equal(handled, 1);
 assert.equal(tree.props.serverId, 'personal-owner');
 tree.props.onOpen('Tasks/task_abc/task.md');
 assert.equal(nodes(h.render()).find(node => node.type === 'VaultEditor').props.file.path, 'Tasks/task_abc/task.md'); h.unmount();
});
test('following a link preserves an unsaved draft and explains the blocked navigation', () => {
 const h = loadDocs(true); h.render().props.onOpen('Tasks/task_abc/task.md');
 const tree = h.render(); assert.equal(nodes(tree).find(node => node.type === 'VaultEditor').props.file.path, 'Projects/development-flow.md');
 assert.ok(text(tree).includes('Save or discard')); h.unmount();
});
const model = {}; vm.runInNewContext(compile('./document-link-model.ts'), { exports: model });
function providerHarness(read = async ({ path }) => ({ path })) {
 const hook = hooks(), exports = {}, rpcCalls = [], opened = [];
 const defs = Object.fromEntries(['getVaultStatus', 'listVaultFolder', 'locateTaskInVault', 'readVaultFile'].map(name => [name, name]));
 vm.runInNewContext(compile('./document-links.tsx'), { exports, require: name => {
  if (name === 'react') return hook.react;
  if (name === 'react/jsx-runtime') return { jsx, jsxs: jsx };
  if (name === 'react-native') return { Platform: { OS: 'web' }, Text: 'Text' };
  if (name === '@getpaseo/plugin/client/react-native') return { useToast: () => ({ error() {} }) };
  if (name === '@getpaseo/plugin/client' || name === './host-rpc') return { useRpc: rpc => async input => { rpcCalls.push([rpc, input]); if (rpc === 'getVaultStatus') return { root: 'C:/dev-vault', exists: true }; if (rpc === 'locateTaskInVault') return { path: `Tasks/${input.taskId}/task.md` }; if (rpc === 'readVaultFile') return read(input); return { entries: [] }; } };
  if (name === '../shared/vault') return defs;
  if (name === './document-link-model') return model;
  throw new Error(name);
 } });
 return { render(scope = 'personal:development-flow') { return hook.render(() => exports.VaultDocumentLinks({ serverId: 'personal-owner', scope, onOpen: path => opened.push(path), children: null })); }, unmount: hook.unmount, opened, rpcCalls };
}
test('provider validates the exact file before routing to Docs without opening chat or workspace', async () => {
 const h = providerHarness();
 await h.render().props.value({ target: 'task_abc', label: 'Task', relative: false });
 assert.deepEqual(h.opened, ['Tasks/task_abc/task.md']);
 assert.deepEqual(h.rpcCalls.map(call => call[0]), ['getVaultStatus', 'locateTaskInVault', 'readVaultFile']); h.unmount();
});
test('pending navigation is canceled when workspace context changes; missing files do not navigate', async () => {
 let finish; const h = providerHarness(() => new Promise(resolve => { finish = resolve; }));
 const pending = h.render().props.value({ target: 'task_abc', label: 'Task', relative: false });
 await new Promise(resolve => setImmediate(resolve)); h.render('personal:other-workspace'); finish({ path: 'Tasks/task_abc/task.md' }); await pending;
 assert.equal(h.opened.length, 0); h.unmount();
 const missing = providerHarness(async () => { throw new Error('ENOENT'); });
 await assert.rejects(missing.render().props.value({ target: 'task_abc', label: 'Task', relative: false }), /ENOENT/);
 assert.equal(missing.opened.length, 0); missing.unmount();
});
test('inline document link has an accessible readable label and reports resolution failure', async () => {
 const hook = hooks(), exports = {}, errors = []; let target;
 const react = { ...hook.react, useContext: () => async link => { target = link.target; throw new Error('That document was not found in this vault.'); } };
 vm.runInNewContext(compile('./document-links.tsx'), { exports, require: name => {
  if (name === 'react') return react;
  if (name === 'react/jsx-runtime') return { jsx, jsxs: jsx };
  if (name === 'react-native') return { Platform: { OS: 'web' }, Text: 'Text' };
  if (name === '@getpaseo/plugin/client/react-native') return { useToast: () => ({ error: message => errors.push(message) }) };
  if (name === './document-link-model') return model;
  return {};
 } });
 const render = () => hook.render(() => exports.DocumentLinkText({ link: { target: 'Tasks/task_abc/task', label: 'Readable task title', relative: false }, colors: {} }));
 const link = render(); assert.equal(link.props.accessibilityRole, 'link'); assert.equal(link.props.accessibilityLabel, 'Readable task title'); assert.equal(link.props.children, 'Readable task title'); assert.equal(link.props.tabIndex, 0);
 link.props.onPress(); await new Promise(resolve => setImmediate(resolve));
 assert.equal(target, 'Tasks/task_abc/task'); assert.deepEqual(errors, ['That document was not found in this vault.']); assert.equal(render().props.accessibilityState.disabled, false); hook.unmount();
});
