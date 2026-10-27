import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import ts from "typescript";

const source = ts.transpileModule(fs.readFileSync(new URL("review-scroll.tsx", import.meta.url), "utf8"), { compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX } }).outputText;
function mount(memory, key, callbacks = {}) {
  const module = { exports: {} };
  vm.runInNewContext(source, { module, exports: module.exports, require(name) {
    if (name === "react") return { useRef: current => ({ current }) };
    if (name === "react-native") return { FlatList: "FlatList" };
    if (name === "react/jsx-runtime") return { jsx: (type, props) => ({ type, props }) };
    if (name === "./page-memory") return { pageMemory: { read: (k, fallback) => memory.get(k) ?? fallback, write: (k, value) => memory.set(k, value) } };
    throw new Error(name);
  }});
  const { props } = module.exports.ReviewDiffList({ memoryKey: key, ...callbacks });
  const restored = [];
  props.ref.current = { scrollToOffset: value => restored.push(value.offset) };
  return { props, restored };
}
const scroll = (y, height = 400) => ({ nativeEvent: { contentOffset: { y }, layoutMeasurement: { height } } });
const layout = height => ({ nativeEvent: { layout: { height } } });

test("restores after either layout/content order and ignores premature zero offsets", () => {
  for (const contentFirst of [true, false]) {
    const memory = new Map([["host/workspace/file/block", 250]]);
    const { props, restored } = mount(memory, "host/workspace/file/block");
    assert.equal(props.contentOffset.y, 250);
    props.onScroll(scroll(0));
    assert.equal(memory.get("host/workspace/file/block"), 250);
    if (contentFirst) { props.onContentSizeChange(700, 1000); props.onLayout(layout(400)); }
    else { props.onLayout(layout(400)); props.onContentSizeChange(700, 1000); }
    assert.deepEqual(restored, [250]);
    props.onScroll(scroll(250));
    props.onScroll(scroll(360));
    assert.equal(mount(memory, "host/workspace/file/block").props.contentOffset.y, 360);
    assert.equal(mount(memory, "other-host/workspace/file/block").props.contentOffset.y, 0);
  }
});

test("waits for virtualized content and lets an intentional drag replace a saved offset", () => {
  const memory = new Map([["review", 800]]);
  const { props, restored } = mount(memory, "review");
  props.onLayout(layout(400));
  props.onContentSizeChange(700, 500);
  assert.deepEqual(restored, []);
  props.onContentSizeChange(700, 1300);
  assert.deepEqual(restored, [800]);
  props.onScrollBeginDrag({});
  props.onScroll(scroll(100));
  assert.equal(memory.get("review"), 100);
  props.onContentSizeChange(700, 1500);
  assert.deepEqual(restored, [800]);
});

test("preserves caller callbacks and does not store unmeasured scroll events", () => {
  const calls = [];
  const memory = new Map();
  const { props } = mount(memory, "review", { onScroll: () => calls.push("scroll"), onLayout: () => calls.push("layout"), onContentSizeChange: () => calls.push("content"), onScrollBeginDrag: () => calls.push("drag") });
  props.onScroll(scroll(40, 0));
  assert.equal(memory.has("review"), false);
  props.onLayout(layout(400));
  props.onContentSizeChange(700, 1000);
  props.onScrollBeginDrag({});
  assert.deepEqual(calls, ["scroll", "layout", "content", "drag"]);
});
