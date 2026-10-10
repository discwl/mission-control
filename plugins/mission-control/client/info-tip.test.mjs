import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import vm from "node:vm";
import ts from "typescript";

function harness(containerWidth) {
  const values = []; let cursor = 0;
  const exports = {};
  const jsx = (type, props) => ({ type, props });
  const code = ts.transpileModule(readFileSync(new URL("./info-tip.tsx", import.meta.url), "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  vm.runInNewContext(code, { exports, require: name => {
    if (name === "react/jsx-runtime") return { jsx, jsxs: jsx };
    if (name === "react") return { useState(initial) { const index = cursor++; if (!(index in values)) values[index] = initial; return [values[index], value => { values[index] = typeof value === "function" ? value(values[index]) : value; }]; } };
    if (name === "react-native") return { Pressable: "Pressable", Text: "Text", View: "View" };
    if (name === "@getpaseo/plugin/client/react-native") return { Icon: "Icon" };
    throw new Error(name);
  } });
  const props = { label: "About the agent tree", text: "Agents can start other agents in another workspace. Helpers appear under their parent.", colors: { foreground: "text", foregroundMuted: "muted", surface2: "raised", border: "border" }, containerWidth };
  return { render(width = props.containerWidth) { cursor = 0; props.containerWidth = width; return exports.InfoTip(props); }, text: props.text };
}

test("Agents tooltip fits the containing header at narrow widths and after resizing", () => {
  for (const [width, anchor] of [[180, 110], [250, 104], [400, 110], [700, 500]]) {
    const h = harness(width);
    let tree = h.render();
    tree.props.onLayout({ nativeEvent: { layout: { x: anchor } } });
    tree.props.children[0].props.onHoverIn();
    tree = h.render();
    const tip = tree.props.children[1];
    const style = tip.props.style;
    const left = anchor + (style.left ?? 44 - style.width - (style.right ?? 0));
    assert.ok(left >= 0, `Tooltip starts outside a ${width}px header`);
    assert.ok(left + style.width <= width, `Tooltip extends beyond a ${width}px header`);
    assert.equal(tip.props.children.props.children, h.text);
    const resized = h.render(160).props.children[1].props.style;
    assert.ok(anchor + resized.left >= 0);
    assert.ok(anchor + resized.left + resized.width <= 160);
  }
});

test("tooltip explanation remains available by keyboard focus and touch", () => {
  const h = harness(280);
  let tree = h.render();
  assert.equal(tree.props.children[1], null);
  tree.props.children[0].props.onFocus();
  tree = h.render();
  assert.equal(tree.props.children[0].props.accessibilityState.expanded, true);
  assert.equal(tree.props.children[0].props.accessibilityHint, h.text);
  assert.equal(tree.props.children[1].props.children.props.children, h.text);
  tree.props.children[0].props.onBlur();
  tree = h.render();
  assert.equal(tree.props.children[1], null);
  tree.props.children[0].props.onPress();
  tree = h.render();
  assert.equal(tree.props.children[0].props.accessibilityState.expanded, true);
  tree.props.children[0].props.onPress();
  assert.equal(h.render().props.children[1], null);
});
