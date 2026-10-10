import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import vm from 'node:vm';
import test from 'node:test';
import ts from 'typescript';
const require = createRequire(import.meta.url);
const React = require('react');
const jsx = require('react/jsx-runtime');
function harness({ width = 1200, height = 900, os = 'web' } = {}) {
  let context;
  const sdk = Object.assign(() => {}, { Content: () => {} });
  const exports = {};
  const code = ts.transpileModule(readFileSync(new URL('./app-modal.tsx', import.meta.url), 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX } }).outputText;
  vm.runInNewContext(code, { exports, require(name) {
    if (name === 'react') return { ...React, useContext: () => context };
    if (name === 'react/jsx-runtime') return jsx;
    if (name === 'react-native') return { Modal: 'NativeModal', View: 'View', Pressable: 'Pressable', Text: 'Text', ScrollView: 'ScrollView', Platform: { OS: os }, useWindowDimensions: () => ({ width, height }) };
    if (name === '@getpaseo/plugin/client/react-native') return { Modal: sdk };
    if (name === './compact-link') return { CompactLink: 'CompactLink' };
    throw new Error(name);
  }});
  const Modal = exports.AppModal;
  const changes = [];
  const render = (extra = {}) => {
    const provider = Modal({ colors: { surface1: 'surface', border: 'border', foreground: 'text' }, title: 'Task', open: true, onOpenChange: value => changes.push(value), children: jsx.jsx(Modal.Content, { children: 'body' }), ...extra });
    context = provider.props.value;
    return provider.props.children;
  };
  return { Modal, sdk, render, changes };
}
test('compact web and native retain SDK adaptive content and caller styling', () => {
  for (const options of [{ width: 600 }, { os: 'ios' }]) {
    const h = harness(options);
    assert.equal(h.render().type, h.sdk);
    const style = { flex: 1 };
    const content = h.Modal.Content({ children: 'body', style, scrollable: false });
    assert.equal(content.type, h.sdk.Content);
    assert.equal(content.props.style, style);
    assert.equal(content.props.scrollable, false);
  }
});
test('desktop dismissal paths close explicitly and backdrop is a card sibling', () => {
  const h = harness();
  const modal = h.render();
  assert.equal(modal.type, 'NativeModal');
  assert.equal(modal.props.visible, true);
  const [backdrop, card] = modal.props.children.props.children;
  assert.equal(backdrop.type, 'Pressable');
  assert.equal(card.type, 'View');
  modal.props.onRequestClose();
  backdrop.props.onPress();
  card.props.children[0].props.children[2].props.onPress();
  assert.deepEqual(h.changes, [false, false, false]);
});
test('desktop dimensions fit viewport and preserve explicit sizing', () => {
  const h = harness({ width: 800, height: 600 });
  const card = h.render().props.children.props.children[1];
  assert.equal(card.props.style.maxWidth, 752);
  assert.equal(card.props.style.maxHeight, 510);
  const custom = h.render({ maxWidth: 560, maxHeight: 400 }).props.children.props.children[1];
  assert.equal(custom.props.style.maxWidth, 560);
  assert.equal(custom.props.style.maxHeight, 400);
});
test('bounded content fits height without a second scroll container', () => {
  const h = harness();
  const child = jsx.jsx(h.Modal.Content, { scrollable: false, children: 'body' });
  const card = h.render({ children: child }).props.children.props.children[1];
  assert.equal(card.props.style.height, 765);
  assert.equal(h.Modal.Content(child.props).type, 'View');
  const scrolling = h.Modal.Content({ children: 'body', contentContainerStyle: { padding: 8 } });
  assert.equal(scrolling.type, 'ScrollView');
  assert.equal(scrolling.props.contentContainerStyle[1].padding, 8);
});
