import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import ts from "typescript";

function mount() {
  let state, initialized = false, effects = [];
  const react = { useState(initial) { if (!initialized) { state = typeof initial === "function" ? initial() : initial; initialized = true; } return [state, next => { state = next; }]; }, useEffect(fn) { effects.push(fn); } };
  const jsx = (type, props, key) => ({ type, props, key });
  const exports = {};
  const js = ts.transpileModule(fs.readFileSync(new URL("./decision-queue.tsx", import.meta.url), "utf8"), { compilerOptions: { jsx: ts.JsxEmit.ReactJSX, module: ts.ModuleKind.CommonJS } }).outputText;
  vm.runInNewContext(js, { exports, require(name) { if (name === "react") return react; if (name === "./page-state") return { usePageState: (_key, initial) => react.useState(initial) }; if (name === "react/jsx-runtime") return { jsx, jsxs: jsx }; if (name === "react-native") return { View: "View", Text: "Text" }; if (name === "./compact-link") return { CompactLink: "Link" }; throw new Error(name); } });
  return { render(items, nextTask) { effects = []; const result = exports.DecisionQueue({ items, nextTask, colors: {}, memoryKey: "test-task" }); effects.forEach(fn => fn()); return result; } };
}
function nodes(tree) { return Array.isArray(tree) ? tree.flatMap(nodes) : tree && typeof tree === "object" ? [tree, ...nodes(tree.props?.children)] : []; }
function click(tree, label) { const link = nodes(tree).find(node => node.props?.label === label); assert.ok(link, label); link.props.onPress(); }
const items = [{ key: "plan:a", title: "Plan approval", next: "Build after approval", content: "PLAN_CONTROLS" }, { key: "review:b", title: "Code review", next: "Separate delivery", content: "REVIEW_CONTROLS" }];
const contains = (tree, value) => JSON.stringify(tree).includes(value);

test("queue requires explicit navigation and retains identity when refreshed", () => {
  const queue = mount(); let tree = queue.render(items);
  assert.ok(contains(tree, "PLAN_CONTROLS")); assert.ok(!contains(tree, "REVIEW_CONTROLS"));
  tree = queue.render([...items].reverse());
  assert.ok(contains(tree, "PLAN_CONTROLS"));
  tree = queue.render(items.slice(1));
  assert.ok(!contains(tree, "REVIEW_CONTROLS")); assert.ok(contains(tree, "no longer waiting"));
  click(tree, "Next decision"); tree = queue.render(items.slice(1));
  assert.ok(contains(tree, "REVIEW_CONTROLS"));
});
test("asynchronously loaded first request stays selected after it disappears", () => {
  const queue = mount(); queue.render([]); queue.render(items);
  const tree = queue.render(items.slice(1));
  assert.ok(contains(tree, "no longer waiting")); assert.ok(!contains(tree, "REVIEW_CONTROLS"));
});
test("next task runs only on click and previous returns without sending", () => {
  const queue = mount(); let calls = 0; const nextTask = () => calls++;
  let tree = queue.render(items, nextTask); click(tree, "Next decision");
  tree = queue.render(items, nextTask); assert.equal(calls, 0);
  click(tree, "Previous decision"); tree = queue.render(items, nextTask);
  assert.ok(contains(tree, "PLAN_CONTROLS"));
  click(tree, "Next decision"); tree = queue.render(items, nextTask); click(tree, "Next task needing you");
  assert.equal(calls, 1);
});
