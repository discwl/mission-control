import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import ts from 'typescript';
const jsx = (type, props) => ({ type, props });
const lanes = [{ id: 'attention', title: 'Needs attention', icon: 'TriangleAlert', description: 'Questions' }];
const tasks = Array.from({ length: 30 }, (_, i) => ({ lane: 'attention', label: 'Needs an answer', action: 'Open conversation', row: { key: `host:${i}`, hostLabel: 'Host', state: 'Needs you', workers: [], queue: [], entry: { task: { title: `Task ${i}`, projectId: 'project' } } } }));
function fixture(compact, failure = false) {
  const states = []; let index = 0;
  const imports = {
    'react/jsx-runtime': { jsx, jsxs: jsx, Fragment: 'Fragment' },
    react: { useState: initial => { const n = index++; if (!(n in states)) states[n] = typeof initial === 'function' ? initial() : initial; return [states[n], value => { states[n] = typeof value === 'function' ? value(states[n]) : value; }]; }, useEffect() {}, useMemo: f => f(), useRef: () => ({ current: null }) },
    'react-native': Object.fromEntries(['ActivityIndicator', 'FlatList', 'Pressable', 'ScrollView', 'Text', 'TextInput', 'View'].map(x => [x, x]).concat([['Platform', { OS: 'ios' }]])),
    '@getpaseo/plugin/client/ui': { Icon: 'Icon', SidebarRow: 'SidebarRow' },
    './compact-link': { CompactLink: 'CompactLink' }, './date-time': { formatDateTime: () => 'Today' },
    './kanban-data': { useKanbanData: () => ({ tasks: failure ? [] : tasks, data: failure ? null : { hosts: [], warnings: [] }, isError: failure, isPending: false, refetch() {} }) },
    './kanban-detail': { KanbanDetail: 'KanbanDetail' }, './kanban-intake': { KanbanIntake: 'KanbanIntake' }, './kanban-filter-menu': { KanbanFilterMenu: 'KanbanFilterMenu' },
    './kanban-model': { kanbanLanes: lanes, kanbanLayout: (_, small) => ({ singleLane: small, laneWidth: small ? 366 : 340 }), filterKanban: rows => rows, kanbanCounts: () => ({ plans: 0, reviews: 0, needsYou: 30, running: 0 }), kanbanSidebarCounts: () => ({}), kanbanScreenId: 'kanban' },
    './kanban-filters-model': { emptyKanbanScope: () => ({ hosts: [], projects: [], workspaces: [] }), matchesKanbanScope: () => true, kanbanFilterOptions: () => ({ hosts: [], projects: [], workspaces: [] }), changeKanbanScope: (scope, kind, ids) => ({ ...scope, [kind]: ids }) },
  };
  const code = ts.transpileModule(readFileSync(new URL('./kanban.tsx', import.meta.url), 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX, target: ts.ScriptTarget.ES2022 } }).outputText;
  const module = { exports: {} };
  new Function('require', 'module', 'exports', code)(name => { assert.ok(name in imports, name); return imports[name]; }, module, module.exports);
  return { render: () => { index = 0; return module.exports.Kanban({ theme: { colors: {} }, host: { id: 'personal' }, layout: { compact }, navigation: {}, params: {} }); } };
}
function nodes(tree) {
  if (!tree || typeof tree !== 'object') return [];
  if (Array.isArray(tree)) return tree.flatMap(nodes);
  if (typeof tree.type === 'function') return nodes(tree.type(tree.props));
  return [tree, ...nodes(tree.props?.children)];
}
test('compact board gives controls and every card one bounded vertical list', () => {
  const f = fixture(true); const tree = f.render(); const list = nodes(tree).find(n => n.type === 'FlatList');
  assert.equal(tree.props.style.flex, 1); assert.equal(list.props.style.flex, 1);
  assert.equal(nodes(tree).filter(n => n.type === 'FlatList').length, 1);
  const header = nodes(list.props.ListHeaderComponent);
  assert.ok(header.some(n => n.props?.accessibilityLabel === 'Search Kanban tasks'));
  assert.equal(header.filter(n => n.type === 'KanbanFilterMenu').length, 3);
  assert.ok(header.filter(n => n.type === 'ScrollView').every(n => n.props.horizontal));
  assert.equal(header.filter(n => n.type === 'FlatList').length, 0);
  assert.equal(list.props.data.length, 30); assert.ok(list.props.contentContainerStyle.paddingBottom >= 24);
  const last = nodes(list.props.renderItem({ item: list.props.data.at(-1) }));
  assert.ok(last.some(n => n.props?.children === 'Open conversation'));
  last.find(n => n.type === 'Pressable').props.onPress();
  assert.equal(nodes(f.render()).find(n => n.type === 'KanbanDetail').props.item.row.key, 'host:29');
});
test('compact load errors and retry controls stay inside the same scroll owner', () => {
  const list = nodes(fixture(true, true).render()).find(n => n.type === 'FlatList');
  assert.equal(list.props.data.length, 0);
  assert.ok(nodes(list.props.ListHeaderComponent).some(n => n.props?.label === 'Refresh'));
  assert.ok(nodes(list.props.ListEmptyComponent).some(n => String(n.props?.children).includes('The board could not load')));
});
test('desktop retains a fixed toolbar and independent lane scrolling', () => {
  const all = nodes(fixture(false).render());
  assert.ok(all.some(n => n.props?.accessibilityLabel === 'Search Kanban tasks'));
  const board = all.find(n => n.type === 'ScrollView' && n.props.contentContainerStyle?.flexDirection === 'row');
  assert.equal(board.props.horizontal, true);
  const laneList = nodes(board).find(n => n.type === 'FlatList');
  assert.equal(laneList.props.ListHeaderComponent, undefined); assert.equal(laneList.props.data.length, 30);
  assert.equal(all.some(n => n.props?.testID === 'kanban-mobile-list'), false);
});
