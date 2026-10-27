import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import vm from "node:vm";
import { planBrief } from "../server/plan-test-data.mjs";
import { planBriefFields } from "../shared/plan-brief.mjs";
const require = createRequire(import.meta.url), ts = require("typescript");
require.extensions[".ts"] = (module, file) => module._compile(ts.transpileModule(readFileSync(file, "utf8"), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText, file);
const model = require("./decision-card-model.ts"), noteModel = require("./decision-note.ts");
const compile = name => ts.transpileModule(readFileSync(new URL(name, import.meta.url), "utf8"), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX } }).outputText;
const entry = () => ({ decision: { decisionId: "decision_aaaa", taskId: "task_aaaa", runId: "run_bbbb", workspaceId: "wks_cns", serverId: "srv_cns", agentId: null, kind: "plan", status: "open", question: "Approve prevention first?", requestedAt: "2026-10-26T10:00:00Z", evidence: [], findingIds: [], plain: { built: "Prevent new full discounts; defer cleanup.", found: "", recommendation: { action: "accept", reason: "Keep existing orders safe." } }, gitDirty: false }, revision: "request-v1", summary: "Technical note.", taskTitle: "Discount prevention", projectId: "prj_cns", findings: [], unverifiedFindings: 0, resolvedFindings: [] });
const proposal = () => ({ source: "snapshot", revision: "a".repeat(64), documentRevision: "b".repeat(64), requestedAt: "2026-10-26T10:00:00Z", markdown: "# Saved proposal\n\nLeave existing orders untouched.", brief: structuredClone(planBrief), previous: null, currentMatch: true, canApprove: true, warning: null });
function nodes(tree) { return tree == null ? [] : Array.isArray(tree) ? tree.flatMap(nodes) : typeof tree === "object" ? [tree, ...nodes(tree.props?.children)] : []; }
const text = tree => tree == null ? "" : Array.isArray(tree) ? tree.map(text).join(" ") : typeof tree === "object" ? text(tree.props?.children) : String(tree);
function harness(file, mocks) {
  const state = [], exports = {}; let cursor = 0;
  const jsx = (type, props) => ({ type, props });
  vm.runInNewContext(compile(file), { exports, require: name => {
    if (name === "react/jsx-runtime") return { jsx, jsxs: jsx, Fragment: "Fragment" };
    if (name === "react") return { useState: initial => { const index = cursor++; if (!(index in state)) state[index] = typeof initial === "function" ? initial() : initial; return [state[index], value => { state[index] = typeof value === "function" ? value(state[index]) : value; }]; } };
    if (name === "react-native") return { Text: "Text", View: "View", TextInput: "TextInput", Pressable: "Pressable" };
    if (name in mocks) return mocks[name];
    throw new Error(`Unexpected client dependency ${name}`);
  } });
  return { exports, render(name, props) { cursor = 0; return exports[name](props); } };
}
function cardHarness() {
  const e = entry(), calls = [], query = { data: proposal(), isPending: false, isError: false };
  const memory = require("./page-memory.ts").createPageMemory(), storage = new Map();
  const drafts = harness("./decision-draft.ts", {
    zod: require("zod"), "./decision-card-model": model,
    "./page-memory": { pageMemory: memory, pageKey: (...parts) => JSON.stringify(parts) },
    "./page-state": { usePageState: (key, initial) => [memory.read(key, initial)] },
    "./web": { readClientStorage: key => storage.get(key) ?? null, writeClientStorage: (key, value) => { if (value === null) storage.delete(key); else storage.set(key, value); return true; } },
  }).exports;
  const h = harness("./decision-card.tsx", {
    "./host-rpc": { useRpc: () => async input => { calls.push(input); return { decision: { resume: { phase: "sent" } } }; } },
    "@getpaseo/plugin/client/react-native": { useToast: () => ({ show() {} }) },
    "@tanstack/react-query": { useQueryClient: () => ({ invalidateQueries: async () => {} }) },
    "../shared/decisions": { decisionsKey: id => ["decisions", id], resolveDecision: {} },
    "./decision-card-model": model, "./decision-note": noteModel, "./decision-draft": drafts,
    "./date-time": { formatDateTime: value => value },
    "./attention-model": { decisionNeed: () => "Approve the plan", decisionWhere: () => ({ source: "generic", text: "Plan" }), latestAgentQuote: () => null, mayReadChat: () => false },
    "./attention-card": { useTimeline: () => ({ data: [] }), TaskHeader: "TaskHeader", WhereLine: "WhereLine", NeedLine: "NeedLine", CardFooter: "CardFooter" },
    "./plan-approval": { usePlanApproval: () => query, PlanApprovalView: "PlanApprovalView", readablePlanRequest: "Provide a readable, versioned proposal; keep cleanup deferred." },
    "./compact-link": { CompactLink: "CompactLink" },
  });
  return { entry: e, calls, query, drafts, render: () => h.render("DecisionCard", { entry: e, serverId: "srv_cns", hostLabel: "CNS", colors: {}, actions: { describe: () => null, openAgent() {} } }) };
}
const button = (tree, label) => nodes(tree).find(node => node.props?.label === label);

test("plan approval sends the exact displayed plan and decision versions to the exact remote host", async () => {
  const h = cardHarness();
  button(h.render(), "Approve this plan").props.onPress();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(h.calls.length, 1);
  assert.equal(h.calls[0].serverId, "srv_cns");
  assert.equal(h.calls[0].workspaceId, "wks_cns");
  assert.equal(h.calls[0].expectedPlanRevision, "a".repeat(64));
  assert.equal(h.calls[0].expectedRevision, "request-v1");
});

test("background refresh does not silently replace a plan version in an open confirmation", async () => {
  const h = cardHarness();
  button(h.render(), "More").props.onPress();
  nodes(h.render()).find(node => node.type === "TextInput").props.onChangeText("Prevention only; keep cleanup deferred.");
  button(h.render(), "Less").props.onPress();
  button(h.render(), "Approve this plan").props.onPress();
  assert.equal(h.calls.length, 0, "a hidden user note is confirmed before sending");
  h.entry.revision = "request-v2";
  h.query.data.revision = "c".repeat(64);
  const confirm = nodes(h.render()).find(node => node.type?.name === "ActionButton" && node.props.tone === "primary");
  assert.equal(confirm.props.disabled, true);
  confirm.props.onPress();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(h.calls.length, 0);
  const saved = h.drafts.useDecisionDraft(h.entry, "srv_cns").draft.confirm;
  assert.equal(saved.requestRevision, "request-v1");
  assert.equal(saved.planRevision, "a".repeat(64));
});

test("legacy or unavailable proposals cannot approve, and requesting a readable plan does not send without confirmation", async () => {
  const h = cardHarness();
  h.query.data = undefined; h.query.isError = true;
  assert.equal(button(h.render(), "Approve this plan").props.disabled, true);
  button(h.render(), "Request readable plan").props.onPress();
  assert.equal(h.calls.length, 0);
  assert.match(nodes(h.render()).find(node => node.type === "TextInput").props.value, /readable, versioned proposal/);
});

test("a request-changes draft survives a background refresh without being sent", () => {
  const h = cardHarness();
  button(h.render(), "Change the plan").props.onPress();
  nodes(h.render()).find(node => node.type === "TextInput").props.onChangeText("Keep cleanup deferred and add an example.");
  h.entry.revision = "refreshed-request";
  h.query.data = proposal();
  assert.equal(nodes(h.render()).find(node => node.type === "TextInput").props.value, "Keep cleanup deferred and add an example.");
  assert.equal(h.calls.length, 0);
  button(h.render(), "Cancel").props.onPress();
  assert.equal(nodes(h.render()).find(node => node.type === "TextInput").props.value, "Keep cleanup deferred and add an example.");
  assert.equal(h.calls.length, 0);
});

test("the plan view shows scope reduction, behavior, success checks, and full saved Markdown without inferring missing content", () => {
  const e = entry(), query = { data: proposal(), isPending: false, isError: false };
  const h = harness("./plan-approval.tsx", {
    "@tanstack/react-query": { useQuery: options => { query.options = options; return query; } },
    "../shared/plan-approval": { readDecisionPlan: {} }, "../shared/plan-brief.mjs": { planBriefFields },
    "./host-rpc": { useRpc: () => input => input }, "./compact-link": { CompactLink: "CompactLink" },
    "./markdown-preview": { MarkdownPreview: "MarkdownPreview" }, "./date-time": { formatDateTime: value => value },
  });
  const render = () => h.render("PlanApprovalView", { entry: e, query, colors: {} });
  let tree = render();
  assert.match(text(tree), /The original request included cleanup/);
  assert.match(text(tree), /Lower discounts still work/);
  assert.match(text(tree), /Existing free subscriptions remain/);
  button(tree, "Read full saved plan").props.onPress();
  assert.equal(nodes(render()).find(node => node.type === "MarkdownPreview").props.content, query.data.markdown);
  const previousBrief = structuredClone(planBrief);
  previousBrief.goal = "Remove every existing discount.";
  query.data.previous = { revision: "d".repeat(64), documentRevision: "e".repeat(64), requestedAt: "2026-10-25T10:00:00Z", brief: previousBrief };
  tree = render();
  assert.match(text(tree), /full plan document also changed/);
  button(tree, "Compare previous wording").props.onPress();
  assert.match(text(render()), /Previously:\s+Remove every existing discount/);
  h.exports.usePlanApproval(e, "srv_other");
  assert.equal(query.options.queryKey[2], "srv_other");
  assert.equal(query.options.queryKey.at(-1), e.revision);
  assert.equal(query.options.queryFn().serverId, "srv_other");
  query.data = { ...proposal(), source: "current", revision: null, brief: null, canApprove: false, warning: "Older request has no saved version." };
  tree = render();
  assert.match(text(tree), /structured approval brief was not provided/);
  assert.doesNotMatch(text(tree), /The original request included cleanup/);
  assert.match(text(tree), /not captured when this request was made/);
});
