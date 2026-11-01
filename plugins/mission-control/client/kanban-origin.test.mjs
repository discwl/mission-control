import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import ts from 'typescript';

function fixture(storageWorks = true) {
  let saved = null, copy = { missing: 'none' };
  const imports = {
    react: { useState: initial => [initial, () => {}] },
    'react-native': { View: 'View', Text: 'Text' },
    'react/jsx-runtime': { jsx: (type, props) => ({ type, props }), jsxs: (type, props) => ({ type, props }) },
    './compact-link': { CompactLink: 'CompactLink' },
    './web': { readClientStorage: () => storageWorks ? saved : null, writeClientStorage: (_, value) => { if (storageWorks) saved = value; return storageWorks; } },
    './host-bridge': { findCopy: serverId => { assert.equal(serverId, 'srv_origin'); return copy; } },
  };
  delete globalThis['mission-control:kanban-origin:v1'];
  const code = ts.transpileModule(readFileSync(new URL('./kanban-origin.tsx', import.meta.url), 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX } }).outputText;
  const module = { exports: {} };
  new Function('require', 'module', 'exports', code)(name => { assert.ok(name in imports, name); return imports[name]; }, module, module.exports);
  return { ...module.exports, setCopy: value => { copy = value; } };
}
for (const storageWorks of [true, false]) test(`return retains origin and rolls back failed navigation (${storageWorks ? 'web' : 'native'})`, () => {
  const f = fixture(storageWorks), calls = [];
  f.navigateFromKanban('srv_origin', () => calls.push('remote worker'));
  assert.equal(f.readKanbanOrigin(), 'srv_origin');
  assert.throws(() => f.navigateFromKanban('srv_other', () => { throw Error('offline'); }), /offline/);
  assert.equal(f.readKanbanOrigin(), 'srv_origin');
  assert.throws(() => f.returnToKanban('srv_origin'), /original board/);
  f.setCopy({ copy: { rpc() { throw Error('must not mutate or invoke RPC'); } } });
  assert.throws(() => f.returnToKanban('srv_origin'), /needs an update/);
  f.setCopy({ copy: { openKanban: () => calls.push('original board') } });
  f.returnToKanban('srv_origin');
  assert.deepEqual(calls, ['remote worker', 'original board']);
});
