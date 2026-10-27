import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import ts from "typescript";

function render(waiting = []) {
  const jsx = (type, props, key) => ({ type, props, key });
  const exports = {};
  const js = ts.transpileModule(fs.readFileSync(new URL("./fleet-task.tsx", import.meta.url), "utf8"), { compilerOptions: { jsx: ts.JsxEmit.ReactJSX, module: ts.ModuleKind.CommonJS } }).outputText;
  vm.runInNewContext(js + "\nexports.attention = TaskAttention;", { exports, require(name) {
    if (name === "react/jsx-runtime") return { jsx, jsxs: jsx };
    if (name === "react") return { useState: initial => [initial, () => {}] };
    if (name === "react-native") return { View: "View", Text: "Text" };
    if (name === "@getpaseo/plugin/client") return { useHosts: () => [{ serverId: "remote", label: "Remote", status: "online" }] };
    if (name === "@tanstack/react-query") return { useQuery: () => ({ data: { agents: [] }, isPending: false }) };
    if (name === "./roster") return { useLiveRoster() {}, rosterQuery() {} };
    if (name === "./attention-model") return { pendingPrompts: () => [], waitingCards: () => waiting };
    if (name === "./decision-queue") return { DecisionQueue: "DecisionQueue" };
    if (name === "./compact-link") return { CompactLink: "Link" };
    if (name === "./attention-card") return { WaitingCardView: "WaitingCard" };
    return {};
  } });
  const question = { questionId: "q", status: "open", agentId: "worker", question: "Which billing rule should apply?", plain: { status: "Waiting for a business rule" } };
  const opened = [];
  const tree = exports.attention({ entry: { task: { taskId: "t", title: "Task" }, questions: [{ question }], decisions: [] }, host: { serverId: "remote" }, workers: [], colors: {}, openAgent: (...args) => opened.push(args) });
  const find = node => Array.isArray(node) ? node.flatMap(find) : node && typeof node === "object" ? [node, ...find(node.props?.children)] : [];
  return { queue: find(tree).find(node => node.type === "DecisionQueue"), opened, find };
}

test("a recorded unmatched question remains visible without enabling a reply", () => {
  const { queue, opened, find } = render();
  assert.equal(queue.props.items.length, 1);
  const item = queue.props.items[0];
  assert.equal(item.key, "question:q"); assert.equal(item.title, "Recorded question");
  assert.match(JSON.stringify(item.content), /Which billing rule/);
  const actions = find(item.content).filter(node => node.type === "Link");
  assert.equal(actions.length, 1); assert.deepEqual(opened, []);
  actions[0].props.onPress(); assert.deepEqual(opened, [["remote", "worker"]]);
});
test("a matched question has one queue item with the same identity", () => {
  const { queue } = render([{ key: "waiting-worker", question: { question: { questionId: "q" } } }]);
  assert.equal(queue.props.items.length, 1);
  assert.equal(queue.props.items[0].key, "question:q");
  assert.equal(queue.props.items[0].content.type, "WaitingCard");
});
