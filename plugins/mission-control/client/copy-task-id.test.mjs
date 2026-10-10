import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import vm from 'node:vm';
const require = createRequire(import.meta.url), ts = require('typescript');
const source = ts.transpileModule(readFileSync(new URL('./copy-task-id.tsx', import.meta.url), 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX, target: ts.ScriptTarget.ES2022 } }).outputText;
function harness(copyText) {
 const state = [], refs = [], exports = {}, errors = [], timers = new Map(); let cursor = 0, refCursor = 0, cleanup, mounted = false;
 const jsx = (type, props) => ({ type, props });
 vm.runInNewContext(source, { exports, setTimeout: fn => { timers.set(1, fn); return 1; }, clearTimeout: id => timers.delete(id), require: name => {
  if (name === 'react/jsx-runtime') return { jsx, jsxs: jsx };
  if (name === 'react') return { useState: initial => { const index = cursor++; if (!(index in state)) state[index] = initial; return [state[index], value => { state[index] = value; }]; }, useRef: initial => { const index = refCursor++; return refs[index] ??= { current: initial }; }, useEffect: fn => { if (!mounted) { cleanup = fn(); mounted = true; } } };
  if (name === 'react-native') return { Pressable: 'Pressable', Platform: { OS: 'web' } };
  return { copyText, Icon: 'Icon', useToast: () => ({ error: message => errors.push(message) }) };
 } });
 return { render() { cursor = 0; refCursor = 0; return exports.CopyTaskId({ taskId: 'task_exact-id', colors: {} }); }, expire() { timers.get(1)?.(); }, unmount() { cleanup(); }, errors };
}
test('icon copies the full ID only, stops row navigation and confirms success briefly', async () => {
 const copied = [], h = harness(async value => copied.push(value)); let stopped = false;
 let button = h.render();
 assert.equal(button.props.accessibilityLabel, 'Copy task ID'); assert.equal(button.props.title, 'Copy task ID');
 assert.equal(button.props.children.type, 'Icon'); assert.equal(button.props.children.props.name, 'Copy');
 button.props.onPress({ stopPropagation() { stopped = true; } });
 await new Promise(resolve => setImmediate(resolve)); button = h.render();
 assert.equal(stopped, true); assert.deepEqual(copied, ['task_exact-id']);
 assert.equal(button.props.children.props.name, 'Check'); assert.equal(button.props.accessibilityLabel, 'Task ID copied');
 h.expire(); assert.equal(h.render().props.children.props.name, 'Copy'); h.unmount();
});
test('clipboard rejection shows an error without a false checkmark', async () => {
 const h = harness(async () => { throw new Error('denied'); });
 h.render().props.onPress({ stopPropagation() {} }); await new Promise(resolve => setImmediate(resolve));
 assert.equal(h.render().props.children.props.name, 'Copy'); assert.equal(h.errors.length, 1); h.unmount();
});
test('a clipboard completion after unmount does not update feedback', async () => {
 let resolve; const h = harness(() => new Promise(done => { resolve = done; }));
 h.render().props.onPress({ stopPropagation() {} }); h.unmount(); resolve();
 await new Promise(done => setImmediate(done)); assert.equal(h.render().props.children.props.name, 'Copy');
});
