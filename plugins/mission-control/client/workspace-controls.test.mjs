import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import vm from "node:vm";
import ts from "typescript";
import { mergeHostOrder, moveVisibleHost } from "./host-order.ts";
import { projectDropTarget } from "./project-order.ts";

function component(file, imports = {}) {
  const slots = [];
  let cursor = 0;
  let effects = [];
  const hooks = {
    useState(initial) {
      const index = cursor++;
      if (!(index in slots)) slots[index] = typeof initial === "function" ? initial() : initial;
      return [slots[index], value => { slots[index] = typeof value === "function" ? value(slots[index]) : value; }];
    },
    useRef(initial) { const [ref] = hooks.useState(() => ({ current: initial })); return ref; },
    useEffect(effect, deps) {
      const index = cursor++;
      if (!slots[index] || deps.some((dep, i) => dep !== slots[index][i])) effects.push(effect);
      slots[index] = deps;
    },
  };
  const defaults = new Proxy({}, { get: (_, name) => name });
  const exports = {};
  const source = ts.transpileModule(fs.readFileSync(new URL(file, import.meta.url), "utf8"), { compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX } }).outputText;
  vm.runInNewContext(source, { exports, setInterval: () => 1, clearInterval() {}, require(name) {
    if (name === "react") return hooks;
    if (name === "react/jsx-runtime") return { jsx: (type, props, key) => ({ type, props, key }), jsxs: (type, props, key) => ({ type, props, key }) };
    return imports[name] ?? defaults;
  } });
  return (name, props) => {
    cursor = 0;
    effects = [];
    const tree = exports[name](props);
    for (const effect of effects) effect();
    return tree;
  };
}
function nodes(tree) {
  if (!tree || typeof tree !== "object") return [];
  if (Array.isArray(tree)) return tree.flatMap(nodes);
  if (typeof tree.type === "function") return nodes(tree.type(tree.props));
  return [tree, ...nodes(tree.props?.children)];
}
const find = (tree, label) => nodes(tree).find(node => node.props?.accessibilityLabel === label || node.props?.label === label);
const plain = value => JSON.parse(JSON.stringify(value));

test("project checklist keeps both selections, toggles one off, and resets to all", () => {
  const render = component("./workspace-filter-bar.tsx");
  const props = { colors: {}, search: "", show: "all", label: "all", labels: ["Review"], projectIds: [], projects: [{ id: "a", name: "Alpha" }, { id: "b", name: "Beta" }], shown: 2, total: 2,
    onProjects(value) { props.projectIds = value; }, onShow() {}, onLabel() {}, onSearch() {} };
  let tree = render("WorkspaceFilterBar", props);
  find(tree, "Filter projects: All projects").props.onPress();
  tree = render("WorkspaceFilterBar", props);
  find(tree, "Alpha").props.onPress();
  tree = render("WorkspaceFilterBar", props);
  find(tree, "Beta").props.onPress();
  tree = render("WorkspaceFilterBar", props);
  assert.deepEqual(plain(props.projectIds), ["a", "b"]);
  assert.equal(find(tree, "Filter projects: 2 projects").props.accessibilityState.expanded, true);
  assert.equal(find(tree, "Alpha").props.accessibilityState.checked, true);
  find(tree, "Alpha").props.onPress();
  tree = render("WorkspaceFilterBar", props);
  assert.deepEqual(plain(props.projectIds), ["b"]);
  find(tree, "All projects").props.onPress();
  assert.deepEqual(plain(props.projectIds), []);
});

test("Show and Label pills expose selection and clear filters resets every control", () => {
  const render = component("./workspace-filter-bar.tsx");
  const props = { colors: {}, search: "invoice", show: "all", label: "review", labels: ["Review"], projectIds: ["a"], projects: [], shown: 1, total: 2,
    onProjects(value) { props.projectIds = value; }, onShow(value) { props.show = value; }, onLabel(value) { props.label = value; }, onSearch(value) { props.search = value; } };
  let tree = render("WorkspaceFilterBar", props);
  assert.equal(find(tree, "Review").props.accessibilityState.selected, true);
  find(tree, "Running agent").props.onPress();
  tree = render("WorkspaceFilterBar", props);
  assert.equal(find(tree, "Running agent").props.accessibilityState.selected, true);
  assert.equal(find(tree, "All workspaces").props.accessibilityState.selected, false);
  find(tree, "Clear filters").props.onPress();
  assert.equal(props.search, "");
  assert.equal(props.show, "all");
  assert.equal(props.label, "all");
  assert.deepEqual(plain(props.projectIds), []);
});

function projectFixture(saveResult = true) {
  const calls = [];
  const settings = { status: "ready", saving: false, revision: "rev-1", values: { hostOrder: ["host-a"], collapsedProjects: ["keep"], projectOrder: { "host-a": ["a", "hidden", "b"], "host-b": ["b", "a"] } },
    async save(values, revision) { calls.push({ values: plain(values), revision }); if (saveResult) { settings.values = values; settings.revision = "rev-2"; } return saveResult; } };
  const renderComponent = component("./project-list.tsx", {
    "@getpaseo/plugin/client": { useSettings: () => settings },
    "./host-order": { mergeHostOrder, moveVisibleHost }, "./project-order": { projectDropTarget },
    "./app-modal": { AppModal: Object.assign(() => null, { Content: "ModalContent" }) },
  });
  const props = { serverId: "host-a", colors: {}, projects: [{ id: "a", name: "Alpha" }, { id: "b", name: "Beta" }], visibleIds: ["a", "b"],
    scrollRef: { current: { getNativeScrollRef: () => ({ measureInWindow: callback => callback(0, 100, 600, 800) }) } }, scrollState: { current: { offset: 0, height: 800, contentHeight: 1600 } },
    renderProject: (project, handle) => ({ type: "Project", props: { id: project.id, children: handle } }) };
  const render = () => renderComponent("ProjectList", props);
  return { calls, render };
}

test("project drag saves the owning host only with the current revision and preserves other layout settings", async () => {
  const fixture = projectFixture();
  const tree = fixture.render();
  const rows = nodes(tree).filter(node => node.props?.onLayout);
  rows[0].props.onLayout({ nativeEvent: { layout: { y: 0 } } });
  rows[1].props.onLayout({ nativeEvent: { layout: { y: 500 } } });
  const handle = find(tree, "Beta project");
  handle.props.begin({ y0: 700 });
  handle.props.move({ dy: -500, moveY: 200 });
  handle.props.finish();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(fixture.calls.length, 1);
  assert.deepEqual(fixture.calls[0], { revision: "rev-1", values: { hostOrder: ["host-a"], collapsedProjects: ["keep"], projectOrder: { "host-a": ["b", "hidden", "a"], "host-b": ["b", "a"] } } });
  assert.deepEqual(nodes(fixture.render()).filter(node => node.type === "Project").map(node => node.props.id), ["b", "a"]);
});

test("a rejected project-order write rolls back and presents a reload action", async () => {
  const fixture = projectFixture(false);
  const tree = fixture.render();
  const rows = nodes(tree).filter(node => node.props?.onLayout);
  rows[0].props.onLayout({ nativeEvent: { layout: { y: 0 } } });
  rows[1].props.onLayout({ nativeEvent: { layout: { y: 100 } } });
  const handle = find(tree, "Beta project");
  handle.props.begin({ y0: 250 });
  handle.props.move({ dy: -100, moveY: 150 });
  handle.props.finish();
  await new Promise(resolve => setImmediate(resolve));
  const result = fixture.render();
  assert.deepEqual(nodes(result).filter(node => node.type === "Project").map(node => node.props.id), ["a", "b"]);
  assert.ok(find(result, "Reload project order"));
});
