import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { test } from "node:test";
const require = createRequire(import.meta.url), ts = require("typescript");
function runtime(result = {}) {
  const calls = [], queries = [], values = []; let index = 0;
  const jsx = (type, props) => ({ type, props });
  const compiled = ts.transpileModule(readFileSync(new URL("./review-file-preview.tsx", import.meta.url), "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX },
  }).outputText;
  const module = { exports: {} };
  new Function("require", "module", "exports", compiled)(id => {
    if (id === "react") return { useState(initial) { const slot = index++; if (!(slot in values)) values[slot] = initial; return [values[slot], value => { values[slot] = value; }]; } };
    if (id === "react/jsx-runtime") return { jsx, jsxs: jsx };
    if (id === "react-native") return { Image: "Image", Text: "Text" };
    if (id === "@getpaseo/plugin/client/react-native") return { ScrollView: "ScrollView" };
    if (id === "@getpaseo/plugin/client" || id === "./host-rpc") return { useRpc: name => async input => { calls.push({ name, input }); return result.data; } };
    if (id === "@tanstack/react-query") return { useQuery: options => { queries.push(options); return result; } };
    if (id === "../shared/review") return { readReviewWorkingFile: "working-file", isMarkdownPath: path => /\.md$/i.test(path) };
    if (id === "./app-modal") return { AppModal: Object.assign(() => null, { Content: "Content" }) };
    if (id === "./markdown-preview") return { MarkdownPreview: "MarkdownPreview" };
    if (id === "./review-ui") return { mono: {} };
    throw new Error(`Unexpected import ${id}`);
  }, module, module.exports);
  return { calls, queries, render(props) { index = 0; return module.exports.ReviewFilePreview(props); } };
}
function nodes(root) {
  if (!root || typeof root !== "object") return [];
  if (Array.isArray(root)) return root.flatMap(nodes);
  return [root, ...nodes(root.props?.children)];
}
const props = { serverId: "remote-host", workspaceId: "exact-workspace", path: "docs/my image.png", online: true, colors: {}, compact: false, onClose() {} };

test("PNG preview renders bytes as an image and binds the read to the selected host/workspace", async () => {
  const state = runtime({ data: { text: "", truncated: false, image: { mimeType: "image/png", base64: "aW1hZ2U=" } } });
  const tree = state.render(props), image = nodes(tree).find(node => node.type === "Image");
  assert.deepEqual(image.props.source, { uri: "data:image/png;base64,aW1hZ2U=" });
  assert.equal(image.props.resizeMode, "contain");
  assert.equal(image.props.accessibilityLabel, "Preview of docs/my image.png");
  assert.equal(nodes(tree).filter(node => node.type === "MarkdownPreview").length, 0);
  await state.queries[0].queryFn();
  assert.deepEqual(state.calls, [{ name: "working-file", input: { serverId: "remote-host", workspaceId: "exact-workspace", path: "docs/my image.png" } }]);
  assert.equal(state.queries[0].enabled, true);
  assert.equal(state.queries[0].gcTime, 0);
  state.render({ ...props, serverId: "other-host", workspaceId: "other-workspace" });
  assert.notDeepEqual(state.queries[0].queryKey, state.queries[1].queryKey);
});

test("preview supports text, Markdown and bounded content in its own closable dialog", () => {
  let closed = 0;
  const state = runtime({ data: { text: "# Heading", truncated: true } });
  const tree = state.render({ ...props, path: "README.md", onClose: () => closed++ });
  assert.equal(tree.props.title, "File preview");
  assert.equal(nodes(tree).find(node => node.type === "MarkdownPreview").props.content, "# Heading");
  assert.ok(JSON.stringify(tree).includes("Only the first 512 KB"));
  tree.props.onOpenChange(false); assert.equal(closed, 1);
  const text = state.render({ ...props, path: "src/code.ts" });
  assert.ok(nodes(text).some(node => node.type === "ScrollView" && node.props.horizontal));
  assert.ok(nodes(text).some(node => node.type === "Text" && node.props.selectable && node.props.children === "# Heading"));
});

test("offline/error/loading/decode failures produce feedback without showing a misleading preview", () => {
  const offline = runtime({ data: { text: "cached unrelated text", image: { mimeType: "image/png", base64: "cached" } }, isPending: true });
  const tree = offline.render({ ...props, online: false });
  assert.equal(offline.queries[0].enabled, false);
  assert.equal(nodes(tree).some(node => node.type === "Image"), false);
  assert.ok(JSON.stringify(tree).includes("Connect to the workspace host"));
  assert.ok(!JSON.stringify(tree).includes("Loading file"));
  assert.ok(JSON.stringify(runtime({ isPending: true }).render(props)).includes("Loading file"));
  assert.ok(JSON.stringify(runtime({ isError: true, error: new Error("File no longer exists") }).render(props)).includes("File no longer exists"));
  const corrupt = runtime({ data: { image: { mimeType: "image/png", base64: "invalid" } } });
  nodes(corrupt.render(props)).find(node => node.type === "Image").props.onError();
  const failed = corrupt.render(props);
  assert.equal(nodes(failed).some(node => node.type === "Image"), false);
  assert.ok(JSON.stringify(failed).includes("This image could not be displayed"));
});

test("compact image preview fits the sheet and an empty file is identified", () => {
  const state = runtime({ data: { image: { mimeType: "image/png", base64: "bytes" } } });
  const image = nodes(state.render({ ...props, compact: true })).find(node => node.type === "Image");
  assert.deepEqual(image.props.style, { width: "100%", height: 300 });
  assert.ok(JSON.stringify(runtime({ data: { text: "", truncated: false } }).render({ ...props, path: "empty.txt" })).includes("This file is empty."));
});
