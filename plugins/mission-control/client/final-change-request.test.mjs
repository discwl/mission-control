import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
const compiled = ts.transpileModule(readFileSync(new URL('./final-change-request.tsx', import.meta.url), 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX } }).outputText;
function fixture({ fail = false, stale = false } = {}) {
  const slots = []; let cursor = 0; const effects = []; const calls = []; let notifications = 0;
  const facts = { workflowMode: 'automatic', entry: { task: { taskId: 'task' }, run: { runId: 'run', workspaceId: 'workspace', serverId: 'remote' } }, candidate: { head: 'a'.repeat(40), tree: 'b'.repeat(40) }, planRevision: 'plan' };
  const read = async () => facts;
  const save = async input => { calls.push(input); if (fail) throw Error('Reply lost'); return { id: input.requestId }; };
  const jsx = (type, props) => ({ type, props });
  const modules = {
    react: { useState(value) { const i = cursor++; if (!(i in slots)) slots[i] = typeof value === 'function' ? value() : value; return [slots[i], next => { slots[i] = typeof next === 'function' ? next(slots[i]) : next; }]; }, useRef(value) { const i = cursor++; return slots[i] ??= { current: value }; }, useEffect(fn, deps) { const i = cursor++; if (!slots[i] || deps.some((value, index) => value !== slots[i][index])) { slots[i] = deps; effects.push(fn); } } },
    'react/jsx-runtime': { jsx, jsxs: jsx, Fragment: 'Fragment' }, 'react-native': { Text: 'Text', TextInput: 'Input', View: 'View' },
    './host-rpc': { useRpc: name => name === 'read' ? read : save }, '../shared/pipeline': { readPipelineEvidence: 'read' }, '../shared/delivery-feedback': { finalReviewChanges: 'save' },
    './review-comments': { useReviewComments: () => ({ comments: [{ status: 'open', path: 'invoice.ts', body: 'Preserve the original timezone.' }] }) }, './compact-link': { CompactLink: 'Link' },
  };
  const module = { exports: {} }; runInNewContext(compiled, { exports: module.exports, crypto: { randomUUID: () => 'fixed-request-id' }, require: name => { if (!(name in modules)) throw Error(name); return modules[name]; } });
  const props = { serverId: 'remote', workspaceId: 'workspace', taskId: 'task', runId: 'run', stale, reviewFingerprint: 'displayed-version', colors: {}, onSaved: () => notifications++ }; let tree;
  const nodes = node => !node || typeof node !== 'object' ? [] : Array.isArray(node) ? node.flatMap(nodes) : [node, ...nodes(node.props?.children)];
  function render() { cursor = 0; tree = module.exports.FinalChangeRequest(props); for (const effect of effects.splice(0)) effect(); }
  function button(label) { return nodes(tree).find(node => node.type === 'Link' && node.props.label === label)?.props; }
  function input() { return nodes(tree).find(node => node.type === 'Input')?.props; }
  async function settle() { await new Promise(resolve => setImmediate(resolve)); render(); }
  async function open() { button('Request fixes before continuing').onPress(); render(); await settle(); }
  render(); return { props, facts, calls, button, input, render, open, settle, notifications: () => notifications };
}
test('saved comments are not change requests until the user explicitly submits the reviewed note', async () => {
  const f = fixture(); await f.open(); assert.equal(f.calls.length, 0); assert.equal(f.button('Request these fixes').disabled, true);
  f.button('Use 1 open workspace comment').onPress(); f.render(); assert.match(f.input().value, /invoice.ts: Preserve/); assert.equal(f.calls.length, 0);
  const submit = f.button('Request these fixes'); submit.onPress(); submit.onPress(); await f.settle();
  assert.equal(f.calls.length, 1); assert.equal(f.calls[0].serverId, 'remote'); assert.equal(f.calls[0].expectedCandidate.tree, 'b'.repeat(40)); assert.equal(f.calls[0].expectedPlanRevision, 'plan'); assert.equal(f.calls[0].expectedReviewFingerprint, 'displayed-version'); assert.equal(f.calls[0].actorId, 'human-ui'); assert.equal(f.notifications(), 1);
});
test('a lost reply retries the same request identity and exact note rather than creating a second repair', async () => {
  const f = fixture({ fail: true }); await f.open(); f.input().onChangeText('Correct the date boundary.'); f.render(); f.button('Request these fixes').onPress(); await f.settle();
  assert.equal(f.input().editable, false); f.button('Retry the same request').onPress(); await f.settle();
  assert.equal(f.calls.length, 2); assert.equal(f.calls[0].requestId, f.calls[1].requestId); assert.equal(f.calls[0].note, f.calls[1].note); assert.equal(f.notifications(), 0);
});
test('action feedback is pinned to the displayed bundle and never silently adopts a newer one', async () => {
  const f = fixture(); f.props.reviewFingerprint = undefined;
  f.props.artifact = { taskId: 'task', runId: 'run', workspaceId: 'workspace', revision: 'b'.repeat(40), planRevision: 'plan' };
  await f.open(); f.input().onChangeText('Check the rollback command.'); f.render(); f.button('Request these fixes').onPress(); await f.settle();
  assert.equal(f.calls[0].expectedCandidate.head, null); assert.equal(f.calls[0].expectedCandidate.tree, f.props.artifact.revision); assert.equal(f.calls[0].expectedPlanRevision, f.props.artifact.planRevision);
  const changed = fixture(); changed.props.artifact = { ...f.props.artifact }; changed.facts.candidate.tree = 'c'.repeat(40);
  await changed.open(); changed.input().onChangeText('Fix the displayed steps.'); changed.render(); assert.equal(changed.button('Request these fixes').disabled, true); changed.button('Request these fixes').onPress(); await changed.settle(); assert.equal(changed.calls.length, 0);
});
test('stale displayed code and mismatched task evidence cannot submit a request', async () => {
  for (const mismatch of ['stale', 'run']) {
    const f = fixture({ stale: mismatch === 'stale' }); if (mismatch === 'run') f.facts.entry.run.runId = 'other'; await f.open(); f.input().onChangeText('Fix this.'); f.render();
    assert.equal(f.button('Request these fixes').disabled, true); f.button('Request these fixes').onPress(); await f.settle(); assert.equal(f.calls.length, 0);
  }
});
