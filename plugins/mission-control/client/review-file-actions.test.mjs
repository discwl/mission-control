import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { test } from "node:test";
const require = createRequire(import.meta.url), ts = require("typescript"), flush = () => new Promise(resolve => setImmediate(resolve));
function runtime(handlers = {}) {
  const values = [], refs = [], effects = [], calls = [], buttons = [], changes = [], binds = [];
  let stateIndex = 0, refIndex = 0;
  const jsx = (type, props) => ({ type, props });
  const react = {
    useState(initial) { const index = stateIndex++; if (!(index in values)) values[index] = initial; return [values[index], value => { values[index] = value; changes.push(value); }]; },
    useRef(value) { const index = refIndex++; return refs[index] ??= { current: value }; },
    useEffect(effect) { effects.push(effect); },
  };
  const compiled = ts.transpileModule(readFileSync(new URL("./review-file-actions.tsx", import.meta.url), "utf8"), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX } }).outputText;
  const module = { exports: {} };
  new Function("require", "module", "exports", compiled)(id => {
    if (id === "react") return react;
    if (id === "react/jsx-runtime") return { jsx, jsxs: jsx };
    if (id === "react-native") return { Modal: "Modal", View: "View", Text: "Text", Pressable: "Pressable", ScrollView: "ScrollView", Platform: { OS: "web" } };
    if (id === "@getpaseo/plugin/client" || id === "./host-rpc") return { useRpc: name => async input => { calls.push({ name, input }); return handlers[name]?.(input); } };
    if (id === "../shared/review") return { prepareReviewDiscard: "prepare", discardReviewChanges: "discard", revealReviewItem: "reveal", resolveReviewItemPath: "resolvePath" };
    if (id === "@getpaseo/plugin/client/react-native") return { Icon: "Icon", copyText: async text => { calls.push({ name: "copy", text }); return handlers.copy?.(text); } };
    if (id === "./app-modal") return { AppModal: Object.assign(() => null, { Content: "ModalContent" }) };
    if (id === "./web") return { bindReviewContextMenu(node, open) { binds.push({ node, open }); return () => binds.push("removed"); } };
    throw new Error(`Unexpected import ${id}`);
  }, module, module.exports);
  function render(Component, props) {
    stateIndex = 0; refIndex = 0; buttons.length = 0;
    const visit = node => { if (!node || typeof node !== "object") return; if (Array.isArray(node)) return node.forEach(visit); if (node.type === "Pressable") buttons.push(node.props); visit(node.props?.children); };
    visit(Component(props));
  }
  return { ...module.exports, render, calls, changes, values, refs, effects, binds, buttons,
    press(label) { const button = buttons.find(item => item.accessibilityLabel === label); assert.ok(button, `missing ${label}`); assert.notEqual(button.disabled, true); button.onPress(); },
  };
}
const defaults = () => ({ target: { path: "src/file.txt", directory: false }, serverId: "personal", workspaceId: "development-flow", online: true, colors: {}, onClose() {}, onOpenFile() {}, onDiscarded() {} });

test("Explorer failures stay visible in the menu; successful requests use the exact workspace", async () => {
  for (const fails of [true, false]) {
    let closed = 0;
    const state = runtime({ reveal: async () => { if (fails) throw new Error("Could not open Windows Explorer: access denied"); return { ok: true }; } });
    const props = { ...defaults(), onClose: () => closed++ };
    state.render(state.ReviewFileMenu, props); state.effects[0](); state.press("Reveal in Windows Explorer"); await flush();
    assert.deepEqual(state.calls, [{ name: "reveal", input: { serverId: "personal", workspaceId: "development-flow", path: "src/file.txt", directory: false } }]);
    assert.equal(closed, fails ? 0 : 1);
    if (fails) assert.ok(state.changes.includes("Could not open Windows Explorer: access denied"));
  }
});

test("Copy path resolves the selected host/workspace and copies the exact absolute path", async () => {
  const path = "C:\\Code\\project with spaces\\src\\file.txt";
  const state = runtime({ resolvePath: async () => ({ path }) });
  let closed = 0; const props = { ...defaults(), onClose: () => closed++ };
  state.render(state.ReviewFileMenu, props); state.effects[0]();
  state.press("Copy path"); state.press("Copy path"); await flush();
  assert.deepEqual(state.calls, [
    { name: "resolvePath", input: { serverId: "personal", workspaceId: "development-flow", path: "src/file.txt", directory: false } },
    { name: "copy", text: path },
  ]);
  assert.ok(state.changes.includes("path")); assert.equal(closed, 0);
});

test("relative paths copy unchanged while offline for files, folders and deleted files", async () => {
  for (const target of [{ path: "src/my file.txt", directory: false }, { path: "src/folder", directory: true }, { path: "removed.txt", directory: false, deleted: true }]) {
    const state = runtime(), props = { ...defaults(), online: false, target };
    state.render(state.ReviewFileMenu, props); state.effects[0]();
    assert.equal(state.buttons.find(button => button.accessibilityLabel === "Copy path").disabled, true);
    state.press("Copy relative path"); await flush();
    assert.deepEqual(state.calls, [{ name: "copy", text: target.path }]);
    assert.ok(state.changes.includes("relative"));
  }
});

test("copy failures report feedback without claiming success or closing the modal", async () => {
  for (const failure of ["resolve", "clipboard"]) {
    let closed = 0;
    const state = runtime({
      resolvePath: async () => { if (failure === "resolve") throw new Error("Workspace unavailable"); return { path: "C:\\project\\file.txt" }; },
      copy: async () => { throw new Error("Clipboard denied"); },
    });
    const props = { ...defaults(), onClose: () => closed++ };
    state.render(state.ReviewFileMenu, props); state.effects[0](); state.press("Copy path"); await flush();
    assert.ok(state.changes.includes(failure === "resolve" ? "Workspace unavailable" : "Could not copy the path. Try again."));
    assert.ok(!state.changes.includes("path")); assert.equal(closed, 0);
    if (failure === "resolve") assert.equal(state.calls.filter(call => call.name === "copy").length, 0);
  }
});

test("a late path response after unmount cannot overwrite the clipboard", async () => {
  let finish;
  const state = runtime({ resolvePath: () => new Promise(resolve => { finish = resolve; }) });
  state.render(state.ReviewFileMenu, defaults()); const cleanup = state.effects[0](); state.press("Copy path"); await flush();
  cleanup(); const changes = state.changes.slice(); finish({ path: "C:\\old-workspace\\file.txt" }); await flush();
  assert.equal(state.calls.filter(call => call.name === "copy").length, 0);
  assert.deepEqual(state.changes, changes);
});

test("menu mount and remount do not navigate, reveal or discard", () => {
  const state = runtime(), props = defaults();
  state.render(state.ReviewFileMenu, props); state.effects[0]();
  state.render(state.ReviewFileMenu, props);
  assert.deepEqual(state.calls, []);
});

test("file actions omit Go to file and clearly label the existing dialog preview", () => {
  const state = runtime(), seen = [], props = { ...defaults(), onOpenFile: path => seen.push(["file", path]), onClose: () => seen.push("close") };
  state.render(state.ReviewFileMenu, props);
  assert.ok(!state.buttons.some(button => button.accessibilityLabel === "Go to file" || button.accessibilityLabel === "Open file"));
  state.press("Preview file");
  assert.deepEqual(seen, [["file", "src/file.txt"], "close"]);
  assert.deepEqual(state.calls, []);
});

test("discard requires exact prepare/confirm plan and retains server/workspace context", async () => {
  const plan = { paths: ["src/file.txt"], removePaths: [], token: "a".repeat(64) };
  const state = runtime({ prepare: async () => plan, discard: async () => ({ ok: true }) });
  let refreshed = 0, closed = 0; const props = { ...defaults(), onDiscarded: () => refreshed++, onClose: () => closed++ };
  state.render(state.ReviewFileMenu, props); state.effects[0](); state.press("Discard changes…"); await flush();
  assert.deepEqual(state.calls, [{ name: "prepare", input: { serverId: "personal", workspaceId: "development-flow", path: "src/file.txt", directory: false } }]);
  assert.equal(refreshed, 0);
  state.render(state.ReviewFileMenu, props); state.press("Discard 1 file"); state.press("Discard 1 file"); await flush();
  assert.equal(state.calls.filter(call => call.name === "discard").length, 1);
  assert.deepEqual(state.calls[1].input, { ...state.calls[0].input, token: plan.token }); assert.equal(refreshed, 1); assert.equal(closed, 1);
});

test("an unmounted menu ignores delayed prepare results from its previous workspace", async () => {
  let finish; const state = runtime({ prepare: () => new Promise(resolve => { finish = resolve; }) }), props = defaults();
  state.render(state.ReviewFileMenu, props); const cleanup = state.effects[0](); state.press("Discard changes…"); await flush(); cleanup();
  const before = state.changes.slice(); finish({ paths: ["src/file.txt"], removePaths: [], token: "a".repeat(64) }); await flush();
  assert.deepEqual(state.changes, before); assert.equal(state.calls.length, 1);
});

test("offline menu can close; folders and deleted files do not offer file opening", () => {
  const state = runtime(), props = defaults(); state.render(state.ReviewFileMenu, { ...props, online: false });
  assert.equal(state.buttons.find(button => button.accessibilityLabel === "Discard changes…").disabled, true); state.press("Close");
  state.render(state.ReviewFileMenu, { ...props, target: { path: "src", directory: true } });
  assert.ok(state.buttons.some(button => button.accessibilityLabel === "Open folder in Windows Explorer"));
  assert.ok(!state.buttons.some(button => button.accessibilityLabel === "Preview file"));
  state.render(state.ReviewFileMenu, { ...props, target: { ...props.target, deleted: true } });
  assert.ok(!state.buttons.some(button => button.accessibilityLabel === "Preview file"));
});

test("right-click binding has an accessible alternative and removes its listener on unmount", () => {
  const state = runtime(), seen = [], target = { path: "src", directory: true };
  state.render(state.ReviewItemActions, { children: null, target, colors: {}, onOpen: item => seen.push(item) });
  const cleanup = state.effects[0](); state.binds[0].open(); state.press("Actions for folder src"); cleanup();
  assert.deepEqual(seen, [target, target]); assert.equal(state.binds.at(-1), "removed");
});
