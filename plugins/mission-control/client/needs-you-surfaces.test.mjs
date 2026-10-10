import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
const require = createRequire(import.meta.url);
const ts = require("typescript");
require.extensions[".ts"] = (module, file) => module._compile(ts.transpileModule(readFileSync(file, "utf8"), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText, file);
const model = require("./attention-model.ts");
const sections = require("../shared/mission-sections.ts");
const jsx = (type, props, key) => ({ type, props: props ?? {}, key });
const ok = data => ({ data, isSuccess: true, isPending: false, isError: false });
const agent = (overrides = {}) => ({ id: "agent", workspaceId: "work", name: "Written help", status: "idle", archivedAt: null, permissions: [], ...overrides });
const question = (overrides = {}) => ({ taskTitle: "Written help", projectId: "project", question: { questionId: "question-1", serverId: "local", workspaceId: "work", agentId: "agent", status: "open", askedAt: "2026-10-01T10:00:00Z", ...overrides } });
const props = { host: { id: "local", label: "Personal" }, agentId: "agent", workspaceId: "work", theme: { colors: {} }, layout: { compact: true, platform: "ios" }, item: { data: { serverId: "local", workspaceId: "work", agentId: "agent", requestId: "question-1", kind: "question" } } };
function runtime() {
  const state = { online: true, local: true, waiting: ok({ questions: [question()] }), decisions: ok({ open: [] }), roster: ok({ agents: [agent()], workspaces: [], outsideParents: [] }), queries: [], enabled: [] };
  let hook = 0;
  const values = [];
  const react = { useState(value) { const index = hook++; if (!(index in values)) values[index] = typeof value === "function" ? value() : value; return [values[index], update => { values[index] = typeof update === "function" ? update(values[index]) : update; }]; }, useRef: value => ({ current: value }) };
  const mocks = {
    "react": react, "react/jsx-runtime": { jsx, jsxs: jsx, Fragment: "Fragment" },
    "react-native": { Text: "Text", View: "View", ScrollView: "ScrollView" },
    "@getpaseo/plugin/client": { useHosts: () => [{ serverId: "local", status: state.online ? "online" : "offline" }], useSettings: () => ({ status: "loading" }), useRpc: () => () => { throw new Error("No automatic RPC in render"); } },
    "@tanstack/react-query": { useQueries: () => [], useQuery: options => { state.queries.push(options); const kind = options.queryKey[1]; return ok(kind === "mission-summary" ? { serverId: state.local ? "local" : "other" } : kind === "mission-agents" ? state.roster.data?.agents ?? [] : kind === "tasks" ? { tasks: [] } : kind === "review-counts" ? { counts: {} } : null); } },
    "./attention-model": model,
    "./attention-card": { useWaiting: (id, enabled) => { state.enabled.push(["waiting", id, enabled]); return state.waiting; }, WaitingCardView: "WaitingCardView" },
    "./needs-you": { useDecisions: (id, enabled) => { state.enabled.push(["decisions", id, enabled]); return state.decisions; } },
    "./decision-card": { DecisionCard: "DecisionCard" },
    "./roster": { useRoster: () => state.roster, agentsForTask: () => [] },
    "./plugin-client": { pluginClient: () => null },
    "./review-comments": { useReviewComments: () => ({ comments: [] }) },
    "./subagents": { useTaskTitles: () => ({}), useHelpers: () => ({}) },
    "../shared/mission-sections": sections,
  };
  function load(file) {
    const url = new URL(file, import.meta.url);
    const compiled = ts.transpileModule(readFileSync(url, "utf8"), { fileName: fileURLToPath(url), compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX } }).outputText;
    const loaded = { exports: {} };
    new Function("require", "module", "exports", compiled)(id => mocks[id] ?? new Proxy({}, { get: (_, name) => name }), loaded, loaded.exports);
    return loaded.exports;
  }
  const Panel = load("./mission-panel.tsx").MissionPanel;
  const Chat = load("./needs-you-timeline.tsx").NeedsYouTimelineCard;
  function render(Component, input = props) { hook = 0; return flatten(Component(input)); }
  function flatten(node) {
    if (node == null || node === false) return [];
    if (Array.isArray(node)) return node.flatMap(flatten);
    if (typeof node !== "object") return [node];
    if (typeof node.type === "function") return flatten(node.type(node.props));
    return [node, ...flatten(node.props.children)];
  }
  return { state, panel: input => render(Panel, input), chat: input => render(Chat, input) };
}
const cards = nodes => nodes.filter(node => node?.type === "WaitingCardView");
const count = nodes => nodes.find(node => node?.props?.accessibilityLabel?.endsWith(" needs you"))?.props.children;

test("screenshot regression: an ordinary question appears in the workspace with count 1 and reply controls", () => {
  const f = runtime(); const nodes = f.panel();
  assert.equal(count(nodes), 1); assert.equal(cards(nodes).length, 1);
  assert.equal(nodes.includes("Nothing needs you right now."), false);
  assert.equal(cards(nodes)[0].props.card.question.question.questionId, "question-1");
  cards(nodes)[0].props.onReplied(cards(nodes)[0].props.card);
  assert.equal(count(f.panel()), 0);
  assert.deepEqual(f.state.queries.find(query => query.queryKey[1] === "mission-summary").queryKey, ["mission-control", "mission-summary", "local", "work"]);
});
test("workspace errors count too; native permission wins without duplicating the question", () => {
  const f = runtime(); f.state.waiting = ok({ questions: [] });
  f.state.roster.data.agents = [agent({ attentionReason: "error", requiresAttention: true })];
  assert.equal(count(f.panel()), 1);
  assert.equal(cards(f.panel())[0].props.card.kind, "error");
  f.state.waiting = ok({ questions: [question()] });
  f.state.roster.data.agents = [agent({ permissions: [{ id: "native-question" }] })];
  assert.equal(count(f.panel()), 1); assert.equal(cards(f.panel()).length, 0);
});
test("workspace never displays another workspace/host question, moved agent, or cached offline requests", () => {
  for (const override of [{ workspaceId: "other" }, { serverId: "remote" }, { agentId: "another" }]) {
    const f = runtime(); f.state.waiting.data.questions = [question(override)];
    assert.equal(cards(f.panel()).length, 0);
  }
  const f = runtime(); f.state.online = false;
  assert.equal(cards(f.panel()).length, 0); assert.equal(f.panel().includes("Nothing needs you right now."), false);
  f.state.online = true; f.state.local = false;
  assert.equal(cards(f.panel()).length, 0);
});
test("loading and failed request reads do not claim Nothing needs you or a zero count", () => {
  for (const query of [{ isPending: true }, { isError: true }]) {
    const f = runtime(); f.state.waiting = query;
    const nodes = f.panel();
    assert.equal(count(nodes), undefined); assert.equal(nodes.includes("Nothing needs you right now."), false);
  }
});
test("native chat embeds the same question card on desktop and compact clients, and hides it after reply", () => {
  for (const compact of [true, false]) {
    const f = runtime(); const input = { ...props, layout: { ...props.layout, compact } };
    const card = cards(f.chat(input))[0]; assert.ok(card); assert.equal(card.props.inChat, true);
    card.props.onReplied(); assert.equal(cards(f.chat(input)).length, 0);
  }
});
test("chat checks host, agent, workspace and current status before showing actions", () => {
  for (const override of [{ serverId: "remote" }, { agentId: "another" }, { workspaceId: "elsewhere" }]) {
    const f = runtime(); assert.equal(cards(f.chat({ ...props, item: { data: { ...props.item.data, ...override } } })).length, 0);
  }
  const f = runtime(); f.state.online = false;
  assert.equal(cards(f.chat()).length, 0);
  f.state.online = true; f.state.roster.data.agents[0].lastUserMessageAt = "2026-10-01T11:00:00Z";
  assert.equal(cards(f.chat()).length, 0);
});
test("chat uses current decision revision and removes resolved decisions", () => {
  const f = runtime(); const input = { ...props, item: { data: { ...props.item.data, kind: "decision", requestId: "decision-1" } } };
  f.state.decisions.data.open = [{ revision: "rev-2", decision: { serverId: "local", workspaceId: "work", agentId: "agent", decisionId: "decision-1" } }];
  const card = f.chat(input).find(node => node?.type === "DecisionCard");
  assert.equal(card.props.entry.revision, "rev-2"); assert.equal(card.props.inChat, true);
  f.state.decisions.data.open = []; assert.equal(f.chat(input).some(node => node?.type === "DecisionCard"), false);
});
