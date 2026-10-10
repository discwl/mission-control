import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const require = createRequire(import.meta.url);
const ts = require("typescript");

// Execute the actual Review body with controlled SDK/query boundaries.
// Rendering or remounting a panel must not cause navigation.
function runtime() {
  const effects = [], errors = [], queries = [], reviews = [], requests = [], buttons = [];
  const jsx = (type, props, key) => ({ type, props: props ?? {}, key });
  const react = {
    useEffect(effect) { effects.push(effect); },
    useRef(value) { return { current: value }; },
    useState(value) { return [value, update => errors.push(update)]; },
  };
  function load(name, imports) {
    const url = new URL(name, import.meta.url);
    const compiled = ts.transpileModule(readFileSync(url, "utf8"), {
      fileName: fileURLToPath(url),
      compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX },
    }).outputText;
    const loaded = { exports: {} };
    new Function("require", "module", "exports", compiled)(specifier => {
      if (specifier === "react") return react;
      if (specifier === "react/jsx-runtime") return { jsx, jsxs: jsx, Fragment: "Fragment" };
      if (specifier === "react-native") return { Text: "Text", View: "View", ScrollView: "ScrollView", Pressable: "Pressable" };
      if (specifier in imports) return imports[specifier];
      throw new Error(`Unexpected import: ${specifier}`);
    }, loaded, loaded.exports);
    return loaded.exports;
  }
  const workspaces = {
    "development-flow": { title: "Mission Control", projectDisplayName: "development-flow" },
    transcribe: { title: "Create Navitus interview profile", projectDisplayName: "transcribe" },
  };
  const panel = load("./review-panel.tsx", {
    "@getpaseo/plugin/client": {
      useHosts: () => [{ serverId: "personal", status: "online" }],
      getPaseoClient: serverId => ({ workspaces: { ref: workspaceId => ({ refresh: async () => {
        requests.push({ serverId, workspaceId });
        return workspaces[workspaceId];
      } }) } }),
    },
    "@tanstack/react-query": { useQuery(options) {
      queries.push(options);
      return { data: workspaces[options.queryKey[3]], isError: false };
    } },
    "./mission-review": { MissionReview(props) { reviews.push(props); return null; } },
  });
  function render(node) {
    if (!node || typeof node !== "object") return;
    if (Array.isArray(node)) { node.forEach(render); return; }
    if (typeof node.type === "function") { render(node.type(node.props)); return; }
    if (node.type === "Pressable") buttons.push(node.props);
    render(node.props?.children);
  }
  return { ...panel, effects, errors, queries, reviews, requests, buttons, render };
}

const props = (layout, workspaceId = "development-flow", agentId = "development-agent") => ({
  context: "agent", workspaceId, agentId,
  host: { id: "personal", label: "Personal" },
  theme: { colors: { foreground: "white", foregroundMuted: "gray", statusDanger: "red", surface0: "black" } },
  layout, compact: layout.compact,
});

for (const layout of [
  { platform: "ios", compact: true },
  { platform: "android", compact: true },
  { platform: "ios", compact: false },
  { platform: "web", compact: true },
  { platform: "web", compact: false },
]) {
  test(`Review stays in the pressed chat on ${layout.platform}, compact=${layout.compact}`, async () => {
    const state = runtime();
    const Content = state.WorkspaceReviewContent;
    state.render(Content(props(layout)));
    assert.equal(state.effects.length, 0);
    assert.deepEqual(state.queries[0].queryKey, ["mission-control", "workspace", "personal", "development-flow"]);
    await state.queries[0].queryFn();
    assert.deepEqual(state.requests, [{ serverId: "personal", workspaceId: "development-flow" }]);
    assert.equal(state.reviews[0].agentId, "development-agent");
    assert.equal(state.reviews[0].workspace.name, "Mission Control");
    assert.equal(state.reviews[0].compact, layout.compact);
    assert.equal(state.reviews[0].serverId, "personal");
  });
}

test("switching mobile chats uses each rendered context for Review and its recipient", () => {
  const state = runtime();
  const Content = state.WorkspaceReviewContent;
  const layout = { platform: "ios", compact: true };
  state.render(Content(props(layout, "transcribe", "transcribe-agent")));
  state.render(Content(props(layout)));
  assert.deepEqual(state.reviews.map(review => [review.workspace.id, review.agentId]), [
    ["transcribe", "transcribe-agent"], ["development-flow", "development-agent"],
  ]);
  assert.equal(state.effects.length, 0);
});

test("desktop remounts render Review without navigation effects", () => {
  const state = runtime();
  for (let i = 0; i < 3; i++) state.render(state.WorkspaceReviewContent(props({ platform: "web", compact: false })));
  assert.equal(state.reviews.length, 3);
  assert.equal(state.effects.length, 0);
  assert.equal(state.buttons.length, 0);
});

test("workspace context does not adopt a retained chat's agent", () => {
  const state = runtime();
  state.render(state.WorkspaceReviewContent({ ...props({ platform: "web", compact: false }), context: "workspace" }));
  assert.equal(state.reviews[0].agentId, undefined);
  assert.equal(state.reviews[0].workspace.id, "development-flow");
  assert.equal(state.effects.length, 0);
});
