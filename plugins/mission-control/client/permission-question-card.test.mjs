import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { test } from "node:test";
import * as questions from "./permission-questions.ts";
import * as detail from "./permission-detail.ts";

const require = createRequire(import.meta.url), ts = require("typescript");
const flush = () => new Promise(resolve => setImmediate(resolve));
const q = (overrides = {}) => ({ header: "Scope", question: "Which scope?", options: [{ label: "Small", description: "One change" }, { label: "Full" }], isOther: true, ...overrides });
const request = (items = [q()]) => ({ id: "request-1", kind: "question", provider: "codex", name: "request_user_input_async", input: { questions: items, providerKey: "keep" } });
const props = (req = request()) => ({ serverId: "remote-host", agentId: "agent-1", agentName: "Builder", request: req, colors: { accent: "blue", accentForeground: "white", foreground: "black", foregroundMuted: "gray", border: "silver", surface1: "white", surface2: "whitesmoke", statusWarning: "orange", statusDanger: "red" } });

function runtime(file = "permission-question-card.tsx", handlers = {}) {
  const states = [], refs = [], effects = [], changes = [], calls = [], nodes = [];
  let si = 0, ri = 0, Component, currentProps, tree, cleanup;
  const react = {
    useState(initial) { const index = si++; if (!(index in states)) states[index] = initial; return [states[index], next => { states[index] = typeof next === "function" ? next(states[index]) : next; changes.push([index, states[index]]); }]; },
    useRef(initial) { const index = ri++; return refs[index] ??= { current: initial }; },
    useEffect(effect) { effects.push(effect); },
  };
  const jsx = (type, props, key) => ({ type, props, key });
  const api = { agents: { ref(agentId) { calls.push(["ref", agentId]); return {
    async refresh() { calls.push(["refresh"]); return handlers.refresh ? handlers.refresh() : { agent: { status: "idle", pendingPermissions: [currentProps.request] } }; },
    async respondToPermission(value) { calls.push(["respond", value]); return handlers.respond?.(value); },
  }; } } };
  const compiled = ts.transpileModule(readFileSync(new URL(file, import.meta.url), "utf8"), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX } }).outputText;
  const module = { exports: {} };
  new Function("require", "module", "exports", compiled)(id => {
    if (id === "react") return react;
    if (id === "react/jsx-runtime") return { jsx, jsxs: jsx, Fragment: "Fragment" };
    if (id === "react-native") return { View: "View", Text: "Text", TextInput: "TextInput", Pressable: "Pressable" };
    if (id === "@getpaseo/plugin/client") return { getPaseoClient(serverId) { calls.push(["host", serverId]); return api; } };
    if (id === "@tanstack/react-query") return { useQueryClient: () => ({ invalidateQueries: value => calls.push(["invalidate", value]) }) };
    if (id === "./permission-questions") return questions;
    if (id === "./permission-detail") return detail;
    if (id === "./permission-question-card") return { PermissionQuestionCard: "QuestionForm" };
    if (id === "./compact-link") return { CompactLink: "CompactLink" };
    if (id === "./attention-model") return { latestAgentQuote: () => "Ready for your choice.", permissionCard: () => ({ task: { title: "Task" }, badge: "PERMISSION" }) };
    if (id === "./attention-card") return { CardFooter: "CardFooter", TaskHeader: "TaskHeader", WhereLine: "WhereLine", NeedLine: "NeedLine", useTimeline: () => ({ data: [] }) };
    throw new Error(`Unexpected import ${id}`);
  }, module, module.exports);
  Component = module.exports.PermissionQuestionCard ?? module.exports.PermissionCard;
  function render(next = currentProps) {
    currentProps = next; si = 0; ri = 0; nodes.length = 0; effects.length = 0;
    tree = Component(next);
    const visit = node => { if (node == null || typeof node === "boolean") return; if (Array.isArray(node)) return node.forEach(visit); nodes.push(node); if (typeof node === "object") visit(node.props?.children); };
    visit(tree); return tree;
  }
  function control(label) { const node = nodes.find(item => item.type === "Pressable" && item.props.accessibilityLabel === label); assert.ok(node, `Missing control: ${label}`); return node.props; }
  return { calls, changes, nodes, render, control,
    mount(value) { render(value); cleanup = effects[0]?.(); }, unmount() { cleanup?.(); },
    press(label) { const item = control(label); assert.equal(item.disabled, false, `${label} is disabled`); item.onPress(); render(); },
    input(value) { const field = nodes.find(item => item.type === "TextInput"); assert.ok(field); assert.equal(field.props.editable, true); field.props.onChangeText(value); render(); },
    field() { return nodes.find(item => item.type === "TextInput")?.props; },
    text() { return nodes.filter(item => typeof item === "string" || typeof item === "number").join(" ").replace(/\s+/g, " "); },
  };
}

test("radio choices and custom text are exclusive, with no implicit answer or submit", () => {
  const ui = runtime(); ui.mount(props());
  assert.equal(ui.control("Submit answer").disabled, true);
  assert.equal(ui.control("Small").accessibilityRole, "radio");
  assert.equal(ui.control("Small").accessibilityHint, "One change");
  assert.equal(ui.control("Small").accessibilityState.checked, false);
  ui.press("Small"); ui.press("Full");
  assert.equal(ui.control("Small").accessibilityState.checked, false);
  assert.equal(ui.control("Full").accessibilityState.checked, true);
  ui.press("Write my own answer");
  assert.equal(ui.control("Full").accessibilityState.checked, false);
  assert.equal(ui.control("Submit answer").disabled, true);
  ui.input("Custom scope"); assert.equal(ui.control("Submit answer").disabled, false);
  ui.press("Small"); assert.equal(ui.field(), undefined);
  assert.deepEqual(ui.calls, []);
});

test("Next and Back preserve each question; submit sends all answers once to the selected host", async () => {
  const req = request([q(), q({ header: "Checks", question: "Which checks?", multiSelect: true }), q({ header: "Notes", question: "Anything else?", options: [], placeholder: "More context" })]);
  const ui = runtime(); ui.mount({ ...props(req), brief: true, compact: true, task: { title: "Implement feature", place: "Project" } });
  assert.equal(ui.control("Next").disabled, true);
  ui.press("Small"); ui.press("Next");
  assert.match(ui.text(), /Question 2 of 3/);
  assert.equal(ui.control("Small").accessibilityRole, "checkbox");
  ui.press("Small"); ui.press("Full"); ui.press("Write my own answer"); ui.input("Runtime");
  ui.press("Back"); assert.equal(ui.control("Small").accessibilityState.checked, true);
  ui.press("Next"); assert.equal(ui.field().value, "Runtime");
  assert.equal(ui.control("Small").accessibilityState.checked, true);
  assert.equal(ui.control("Full").accessibilityState.checked, true);
  ui.press("Next"); assert.equal(ui.field().placeholder, "More context");
  assert.equal(ui.control("Submit answers").disabled, true);
  ui.input("Ship after review");
  assert.deepEqual(ui.calls, []);
  const click = ui.control("Submit answers").onPress; click(); click(); await flush(); ui.render();
  assert.deepEqual(ui.calls.filter(([name]) => name === "host"), [["host", "remote-host"]]);
  assert.deepEqual(ui.calls.filter(([name]) => name === "ref"), [["ref", "agent-1"]]);
  assert.deepEqual(ui.calls.filter(([name]) => name === "respond"), [["respond", { requestId: req.id, response: { behavior: "allow", updatedInput: { ...req.input, answers: { Scope: "Small", Checks: "Small, Full, Runtime", Notes: "Ship after review" } } } }]]);
  assert.match(ui.text(), /Answers sent/);
  assert.equal(ui.control("Submit answers").disabled, true);
});

test("choice-only questions omit custom input while free-text questions render it immediately", () => {
  const choices = runtime(); choices.mount(props(request([q({ isOther: false })])));
  assert.equal(choices.nodes.some(node => node.props?.accessibilityLabel === "Write my own answer"), false);
  assert.equal(choices.field(), undefined);
  const text = runtime(); text.mount(props(request([q({ options: [], allowEmpty: true, dismissLabel: "Skip" })])));
  assert.equal(text.field().value, ""); assert.equal(text.control("Submit answer").disabled, false);
  assert.ok(text.control("Skip"));
});

test("failed submissions retain answers and show the failure for a retry", async () => {
  const ui = runtime(undefined, { respond: () => { throw new Error("Host disconnected"); } }); ui.mount(props());
  ui.press("Write my own answer"); ui.input("My answer"); ui.press("Submit answer"); await flush(); ui.render();
  assert.equal(ui.field().value, "My answer"); assert.match(ui.text(), /Host disconnected/);
  assert.equal(ui.control("Submit answer").disabled, false); assert.doesNotMatch(ui.text(), /Answers sent/);
});

test("a question already answered in native chat is not submitted again", async () => {
  const ui = runtime(undefined, { refresh: async () => ({ agent: { pendingPermissions: [], status: "running" } }) }); ui.mount(props());
  ui.press("Small"); ui.press("Submit answer"); await flush(); ui.render();
  assert.match(ui.text(), /no longer waiting/);
  assert.equal(ui.calls.some(([name]) => name === "respond"), false);
});

test("late responses after leaving the form cannot update another mounted question", async () => {
  let finish;
  const ui = runtime(undefined, { respond: () => new Promise(resolve => { finish = resolve; }) }); ui.mount(props());
  ui.press("Small"); ui.press("Submit answer"); await flush(); ui.unmount();
  const before = ui.changes.slice(); finish(); await flush();
  assert.deepEqual(ui.changes, before);
});

test("malformed questions offer opening the agent without generic allow/deny or raw JSON", () => {
  let opened = 0;
  const ui = runtime(); ui.mount({ ...props(request([q({ options: null })])), openAgent: () => opened++ });
  assert.match(ui.text(), /isn't supported here/); assert.doesNotMatch(ui.text(), /providerKey/);
  assert.equal(ui.nodes.filter(node => node.type === "Pressable").length, 1);
  ui.press("Open agent"); assert.equal(opened, 1); assert.deepEqual(ui.calls, []);
});

test("every PermissionCard layout routes questions to the same form, with isolated draft identity", () => {
  const ui = runtime("permissions.tsx"); const initial = props();
  const first = ui.render(initial);
  assert.equal(first.type, "QuestionForm");
  assert.equal(ui.render({ ...initial, request: structuredClone(initial.request) }).key, first.key);
  for (const override of [{ serverId: "other-host" }, { agentId: "other-agent" }, { request: { ...initial.request, id: "next-request" } }, { request: request([q({ multiSelect: true })]) }]) {
    assert.notEqual(ui.render({ ...initial, ...override }).key, first.key);
  }
  for (const layout of [{ brief: true }, { compact: true }, { brief: false, compact: false }]) {
    const tree = ui.render({ ...initial, ...layout }); assert.equal(tree.type, "QuestionForm"); assert.equal(tree.props.serverId, initial.serverId);
  }
});

test("ordinary tool permissions keep their native action IDs and approval behavior", async () => {
  const ui = runtime("permissions.tsx"), req = { id: "tool-1", kind: "tool", provider: "claude", name: "Bash", title: "Run tests", actions: [{ id: "once", label: "Allow once", behavior: "allow", variant: "primary" }, { id: "reject", label: "Deny", behavior: "deny" }] };
  ui.mount(props(req)); ui.press("Allow once: Run tests"); await flush();
  assert.deepEqual(ui.calls.filter(([name]) => name === "respond"), [["respond", { requestId: req.id, response: { behavior: "allow", selectedActionId: "once" } }]]);
});
