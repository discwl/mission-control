import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import vm from 'node:vm';
const require = createRequire(import.meta.url), ts = require('typescript');
const jsx = (type, props) => ({ type, props });
const source = ts.transpileModule(readFileSync(new URL('./markdown-preview.tsx', import.meta.url), 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX, target: ts.ScriptTarget.ES2022 } }).outputText;
const exports = {};
const model = {};
vm.runInNewContext(ts.transpileModule(readFileSync(new URL('./document-link-model.ts', import.meta.url), 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText, { exports: model });
vm.runInNewContext(source, { exports, require: name => name === 'react/jsx-runtime' ? { jsx, jsxs: jsx } : name === 'react-native' ? { Text: 'Text', View: 'View', ScrollView: 'ScrollView' } : name === './document-link-model' ? model : name === './document-links' ? { DocumentLinkText: 'DocumentLinkText' } : name === './date-time' ? { formatDateTime: value => new Date(value).toLocaleString('en-US') } : require(name) });
const colors = { foreground: 'white', foregroundMuted: 'gray', accent: 'green', border: 'gray', surface0: 'black', surface2: '#222' };
const render = content => exports.MarkdownPreview({ content, colors, documentPath: 'Projects/development-flow.md' });
function nodes(value) { return !value || typeof value !== 'object' ? [] : Array.isArray(value) ? value.flatMap(nodes) : [value, ...nodes(value.props?.children)]; }
function text(value) { return value == null ? '' : typeof value === 'string' ? value : Array.isArray(value) ? value.map(text).join('') : text(value.props?.children); }
test('tables render headers, inline formatting and alignment in a horizontal scroll container', () => {
 const tree = render('| Finding | Count |\n| :--- | ---: |\n| **Fixed** | 3 |\n| `code` | 4 |\n\nAfter'), all = nodes(tree);
 assert.equal(all.filter(node => node.type === 'ScrollView').length, 1);
 assert.equal(all.find(node => node.type === 'ScrollView').props.horizontal, true);
 assert.equal(all.filter(node => node.props?.accessibilityRole === 'header').length, 2);
 assert.ok(all.some(node => node.props?.style?.fontWeight === '700' && text(node) === 'Fixed'));
 assert.ok(all.some(node => Array.isArray(node.props?.style) && node.props.style[1].textAlign === 'right'));
 assert.equal(text(tree), 'FindingCountFixed3code4 After');
});
test('escaped pipes and optional outer pipes work', () => {
 const tree = render('Name | Value\n--- | ---\nA\\|B | Yes');
 assert.equal(nodes(tree).filter(node => node.type === 'ScrollView').length, 1);
 assert.equal(text(tree), 'NameValueA|BYes');
});
test('fenced code and invalid delimiters remain literal', () => {
 const tree = render('```md\n| A | B |\n| --- | --- |\n| 1 | 2 |\n```');
 assert.equal(nodes(tree).filter(node => node.type === 'ScrollView').length, 0);
 assert.ok(text(tree).includes('| --- | --- |'));
 assert.equal(nodes(render('| A | B |\n| bad | --- |')).filter(node => node.type === 'ScrollView').length, 0);
});
test('wiki aliases hide task IDs and preserve exact navigation targets', () => {
 const tree = exports.MarkdownPreview({ content: '[[task_264d8373-7966-46ee-a208-659751e753bc|Prove the agent task bridge on personal]]', colors, documentPath: 'Projects/development-flow.md' });
 const link = nodes(tree).find(node => node.type === 'DocumentLinkText');
 assert.equal(link.props.link.label, 'Prove the agent task bridge on personal');
 assert.equal(link.props.link.target, 'task_264d8373-7966-46ee-a208-659751e753bc');
 assert.equal(link.props.sourcePath, 'Projects/development-flow.md');
 assert.ok(!text(tree).includes('task_264'));
});
test('table aliases and inline-code pipes do not create extra columns', () => {
 const tree = render('| Task | Evidence |\n| --- | --- |\n| [[Tasks/task_abc/task|Readable task]] | `a|b` |');
 assert.equal(nodes(tree).filter(node => node.props?.accessibilityRole === 'header').length, 2);
 assert.equal(nodes(tree).filter(node => node.type === 'DocumentLinkText').length, 1);
 assert.equal(nodes(tree).find(node => node.type === 'DocumentLinkText').props.link.label, 'Readable task');
 assert.ok(text(tree).includes('a|b'));
});
test('wiki syntax in fenced and inline code remains literal; external links stay text', () => {
 const tree = render('`[[task_abc|Code]]`\n```md\n[[task_abc|Fenced]]\n```\n[External](https://example.com)\n[Relative](../report.md)');
 const links = nodes(tree).filter(node => node.type === 'DocumentLinkText');
 assert.equal(links.length, 1); assert.equal(links[0].props.link.target, '../report.md'); assert.equal(links[0].props.link.relative, true);
 assert.ok(text(tree).includes('[[task_abc|Code]]')); assert.ok(text(tree).includes('[[task_abc|Fenced]]')); assert.ok(text(tree).includes('External'));
});
test('handoff entries separate title, recorded metadata and exact handoff link; summaries indent', () => {
 const tree = render('- [[Tasks/task_abc/task|5 · Fresh worktrees]] · 2026-09-26T06:52:05.470Z · handoff waiting · [[Tasks/task_abc/runs/run_def/handoff|handoff]]\n  - Summary with **important** details\n    - Next action');
 const links = nodes(tree).filter(node => node.type === 'DocumentLinkText');
 assert.equal(links.length, 2); assert.equal(links[1].props.link.label, 'View handoff'); assert.equal(links[1].props.link.target, 'Tasks/task_abc/runs/run_def/handoff');
 assert.ok(text(tree).includes('Recorded')); assert.ok(text(tree).includes('handoff waiting')); assert.ok(!text(tree).includes('2026-09-26T'));
 assert.ok(nodes(tree).some(node => node.type === 'View' && node.props?.style?.marginLeft === 16));
 assert.ok(nodes(tree).some(node => node.type === 'View' && node.props?.style?.marginLeft === 32));
});
test('relative repository links without vault source context remain text instead of opening unrelated vault notes', () => {
 const tree = exports.MarkdownPreview({ content: '[Readme](README.md)', colors });
 assert.equal(nodes(tree).filter(node => node.type === 'DocumentLinkText').length, 0); assert.ok(text(tree).includes('Readme'));
});
test('multi-backtick inline code preserves nested backticks and wiki syntax literally', () => {
 const tree = render('`` `[[task_abc|Literal]]` ``');
 assert.equal(nodes(tree).filter(node => node.type === 'DocumentLinkText').length, 0);
 assert.ok(text(tree).includes('`[[task_abc|Literal]]`'));
});
