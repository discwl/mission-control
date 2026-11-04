import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import ts from "typescript";

// Controlled filter results isolate the board's lane selection from the model's filtering tests.
const lanes = [
  { id: "queue", title: "Up next" }, { id: "working", title: "Working" },
  { id: "attention", title: "Needs you" }, { id: "done", title: "Done" },
];
const tasks = lanes.slice(0, 3).map(lane => ({ lane: lane.id, row: { key: lane.id } }));
function fixture(compact) {
  const state = []; let cursor = 0;
  const jsx = (type, props) => ({ type, props: props ?? {} });
  const query = { tasks, data: { hosts: [], warnings: [], serverId: "local" }, isPending: false, isFetching: false, isError: false, refetch() {} };
  const dependencies = {
    react: {
      useState(initial) { const i = cursor++; if (!(i in state)) state[i] = typeof initial === "function" ? initial() : initial; return [state[i], next => { state[i] = typeof next === "function" ? next(state[i]) : next; }]; },
      useEffect() {}, useMemo: compute => compute(), useRef: initial => ({ current: initial }),
    },
    "react/jsx-runtime": { jsx, jsxs: jsx, Fragment: "Fragment" },
    "react-native": { View: "View", Text: "Text", TextInput: "TextInput", ScrollView: "ScrollView", FlatList: "FlatList", Pressable: "Pressable" },
    "./kanban-data": { useKanbanData: () => query },
    "./kanban-model": {
      kanbanLanes: lanes, kanbanLayout: () => ({ singleLane: compact, laneWidth: 300 }),
      filterKanban: (items, _host, _lane, _search, focus) => items.filter(item => focus === "Needs you" ? item.lane === "attention" : focus === "Running" ? item.lane === "working" : true),
      kanbanCounts: items => ({ needsYou: items.filter(item => item.lane === "attention").length, running: items.filter(item => item.lane === "working").length, unconfirmed: 0 }),
    },
    "./kanban-filters-model": {
      emptyKanbanScope: () => ({ hosts: [], projects: [], workspaces: [] }), matchesKanbanScope: () => true,
      kanbanFilterOptions: () => ({ hosts: [], projects: [], workspaces: [] }), changeKanbanScope: (current, kind, ids) => ({ ...current, [kind]: ids }),
    },
  };
  const source = fs.readFileSync(new URL("./kanban.tsx", import.meta.url), "utf8");
  const code = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX, target: ts.ScriptTarget.ES2022 } }).outputText;
  const module = { exports: {} };
  new Function("require", "exports", "module", code)(name => dependencies[name] ?? new Proxy({}, { get: (_, key) => String(key) }), module.exports, module);
  const render = () => { cursor = 0; return module.exports.Kanban({ theme: { colors: {} }, host: { id: "local" }, layout: { compact }, navigation: {}, params: {} }); };
  return { render, press(prefix) { const button = nodes(render()).find(node => node.props.label?.startsWith(prefix)); assert.ok(button, `missing control: ${prefix}`); button.props.onPress(); } };
}
function nodes(node) {
  if (!node || typeof node !== "object") return [];
  if (Array.isArray(node)) return node.flatMap(nodes);
  return [node, ...nodes(node.props?.children), ...nodes(node.props?.ListHeaderComponent)];
}
const mobileData = tree => nodes(tree).find(node => node.props.testID === "kanban-mobile-list").props.data.map(item => item.row.key);

test("compact focus controls immediately show matching Needs you and Running cards with empty lanes enabled", () => {
  const view = fixture(true);
  assert.deepEqual(mobileData(view.render()), ["queue"]);
  view.press("Needs you ·");
  assert.deepEqual(mobileData(view.render()), ["attention"]);
  view.press("Running ·");
  assert.deepEqual(mobileData(view.render()), ["working"]);
});

test("compact automatic lane choice does not override a lane explicitly selected by the user", () => {
  const view = fixture(true);
  view.press("Needs you ·");
  view.press("Up next ·");
  assert.deepEqual(mobileData(view.render()), []);
  assert.equal(nodes(view.render()).find(node => node.props.label?.startsWith("Up next ·")).props.selected, true);
  view.press("All work");
  view.press("Working ·");
  assert.deepEqual(mobileData(view.render()), ["working"]);
  assert.deepEqual(mobileData(view.render()), ["working"]);
});

test("desktop focus filtering retains all visible lanes and their filtered cards", () => {
  const view = fixture(false);
  view.press("Needs you ·");
  const rendered = nodes(view.render());
  assert.equal(rendered.some(node => node.props.testID === "kanban-mobile-list"), false);
  const columns = rendered.filter(node => node.type?.name === "Lane");
  assert.deepEqual(columns.map(node => node.props.lane.id), lanes.map(lane => lane.id));
  assert.deepEqual(columns.flatMap(node => node.props.tasks.map(item => item.row.key)), ["attention"]);
});
