import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { test } from "node:test";

const require = createRequire(import.meta.url);
const ts = require("typescript");
require.extensions[".ts"] = (module, file) => module._compile(ts.transpileModule(readFileSync(file, "utf8"), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText, file);
const {
  childStatus, firstLine, flattenAgentTree, groupAgents, helperQueryPlan, helperStatus, helpersByParent, mayQueryAgent, paseoParentOf, parentAgentIdOf, readablePurpose,
  parseHelperList, parseHelperMessages, subagentContextLine, subagentKindLabel, subagentSummary,
} = require("./subagents.ts");

const coordinator = "32a4f8db-c0b5-445f-ac5d-c27df91a7996";

test("the parent comes from the parentAgentId field when the SDK has it, then Paseo's label, then Mission Control's older label", () => {
  assert.equal(parentAgentIdOf({ labels: { "paseo.parent-agent-id": "label" }, parentAgentId: " field " }), "field");
  assert.equal(parentAgentIdOf({ labels: { "paseo.parent-agent-id": coordinator, "mission-control.parent-agent-id": "other" }, parentAgentId: "  " }), coordinator);
  assert.equal(parentAgentIdOf({ labels: { "paseo.parent-agent-id": coordinator, "mission-control.parent-agent-id": "other" } }), coordinator);
  assert.equal(parentAgentIdOf({ labels: { "mission-control.parent-agent-id": " older " } }), "older");
  assert.equal(parentAgentIdOf({ labels: {}, parentAgentId: "field" }), "field");
  assert.equal(parentAgentIdOf({ labels: { "paseo.parent-agent-id": "  " } }), null);
  assert.equal(parentAgentIdOf({}), null);
});

test("helper and child statuses map to plain words", () => {
  assert.deepEqual(["running", "completed", "failed", "canceled", "something-new"].map(helperStatus), ["running", "finished", "error", "stopped", "idle"]);
  assert.deepEqual(["initializing", "running", "idle", "error", "closed", "unknown"].map(childStatus), ["running", "running", "idle", "error", "finished", "idle"]);
});

test("the helper list is read from the daemon's reply, running helpers first", () => {
  // The coordinator's reply as seen on pc-864 on 28 Sep 2026, plus a running helper.
  const helpers = parseHelperList({
    requestId: "r1", parentAgentId: coordinator, error: null,
    subagents: [
      { id: "toolu_01Ddo2XhavMwBAjKcBXoMvBQ", parentAgentId: coordinator, provider: "claude", title: "Explore", description: "Analyze Review Deck implementation", status: "completed", createdAt: "2026-09-26T00:18:26.230Z", updatedAt: "2026-09-26T00:20:00.000Z", toolCallId: "toolu_01Ddo2XhavMwBAjKcBXoMvBQ" },
      { id: "toolu_2", parentAgentId: coordinator, provider: "claude", title: "general-purpose", description: "  Check the tests  ", status: "running", createdAt: "2026-09-26T00:10:00.000Z", updatedAt: "2026-09-26T00:11:00.000Z", toolCallId: null },
    ],
  }, coordinator);
  assert.deepEqual(helpers, [
    { id: "toolu_2", parentAgentId: coordinator, title: "general-purpose", description: "Check the tests", status: "running", createdAt: "2026-09-26T00:10:00.000Z", updatedAt: "2026-09-26T00:11:00.000Z" },
    { id: "toolu_01Ddo2XhavMwBAjKcBXoMvBQ", parentAgentId: coordinator, title: "Explore", description: "Analyze Review Deck implementation", status: "finished", createdAt: "2026-09-26T00:18:26.230Z", updatedAt: "2026-09-26T00:20:00.000Z" },
  ]);
});

test("malformed helpers and helpers of another parent are skipped", () => {
  const helpers = parseHelperList({ error: null, subagents: [
    null, "text", { id: "", status: "running" }, { id: "no-status" },
    { id: "elsewhere", parentAgentId: "another", status: "running" },
    { id: "bare", status: "failed", title: 7, updatedAt: "2026-09-26T00:00:00.000Z" },
  ] }, coordinator);
  assert.deepEqual(helpers, [{ id: "bare", parentAgentId: coordinator, title: null, description: null, status: "error", createdAt: "2026-09-26T00:00:00.000Z", updatedAt: "2026-09-26T00:00:00.000Z" }]);
});

test("a reply with an error, or without a list, is unavailable rather than empty", () => {
  assert.equal(parseHelperList({ error: "Provider does not support sub-agents", subagents: [] }, coordinator), null);
  assert.equal(parseHelperList({ error: null }, coordinator), null);
  assert.equal(parseHelperList(new Error("timed out"), coordinator), null);
  assert.equal(parseHelperList(undefined, coordinator), null);
  assert.deepEqual(parseHelperList({ error: null, subagents: [] }, coordinator), []);
});

test("a helper's last messages keep only user and assistant text", () => {
  const long = "x".repeat(700);
  const messages = parseHelperMessages({ error: null, rows: [
    { item: { type: "user_message", text: "Review task 23" }, timestamp: "t1" },
    { item: { type: "tool_call", name: "Read" }, timestamp: "t2" },
    { item: { type: "assistant_message", text: "Reading the diff." }, timestamp: "t3" },
    { item: { type: "reasoning", text: "hidden" }, timestamp: "t4" },
    { item: { type: "assistant_message", text: long }, timestamp: "t5" },
    { item: { type: "assistant_message", text: "   " }, timestamp: "t6" },
  ] }, 2);
  assert.deepEqual(messages, [
    { role: "assistant", text: "Reading the diff.", timestamp: "t3" },
    { role: "assistant", text: `${"x".repeat(600)}…`, timestamp: "t5" },
  ]);
  assert.equal(parseHelperMessages({ error: "Unknown sub-agent", rows: [] }), null);
  assert.equal(parseHelperMessages({ rows: "none" }), null);
});

test("a first prompt becomes one line", () => {
  assert.equal(firstLine("\n\n  Work on   Mission Control task 5:  Verify Needs You.\nMore detail"), "Work on Mission Control task 5: Verify Needs You.");
  assert.equal(firstLine("  \n "), null);
  assert.equal(firstLine("a".repeat(10), 4), "aaaa…");
});

const agent = (id, parentAgentId = null) => ({ id, parentAgentId });
const shape = nodes => nodes.map(node => ({ id: node.agent.id, outside: node.parentOutside, children: shape(node.children) }));

test("children sit under their parents in list order", () => {
  const nodes = groupAgents([agent("child", "parent"), agent("solo"), agent("parent"), agent("grandchild", "child"), agent("second", "parent")]);
  assert.deepEqual(shape(nodes), [
    { id: "solo", outside: false, children: [] },
    { id: "parent", outside: false, children: [
      { id: "child", outside: false, children: [{ id: "grandchild", outside: false, children: [] }] },
      { id: "second", outside: false, children: [] },
    ] },
  ]);
  assert.deepEqual(flattenAgentTree(nodes[1]).map(entry => [entry.agent.id, entry.nested]), [["parent", false], ["child", true], ["grandchild", true], ["second", true]]);
});

test("a child whose parent is archived or in another workspace stays in the list and is marked", () => {
  // The workspace list holds only this workspace's live agents: an archived parent, or one elsewhere, isn't in it.
  const nodes = groupAgents([agent("smoke-test", coordinator), agent("reviewer")]);
  assert.deepEqual(shape(nodes), [{ id: "smoke-test", outside: true, children: [] }, { id: "reviewer", outside: false, children: [] }]);
});

test("agents whose parents point at each other are still listed once", () => {
  const nodes = groupAgents([agent("a", "b"), agent("b", "a"), agent("self", "self")]);
  const ids = nodes.flatMap(node => flattenAgentTree(node)).map(entry => entry.agent.id);
  assert.deepEqual(ids.sort(), ["a", "b", "self"]);
});

test("the context line names the parent, its task and where it works", () => {
  assert.equal(subagentContextLine({ parentName: "Review Names Control", taskTitle: "23 · Follow paseo.json for commit messages", projectName: "development-flow", workspaceName: "main" }),
    "Sub-agent of Review Names Control · 23 · Follow paseo.json for commit messages · development-flow / main");
  assert.equal(subagentContextLine({ parentName: "Review Names Control", projectName: "development-flow", workspaceName: null }), "Sub-agent of Review Names Control · development-flow");
});

test("the context line leaves out a task that repeats the parent's name and marks an archived parent", () => {
  assert.equal(subagentContextLine({ parentName: "23 · Follow paseo.json", parentArchived: true, taskTitle: "23 · follow paseo.json", projectName: null, workspaceName: null }), "Sub-agent of 23 · Follow paseo.json (archived)");
  assert.equal(subagentContextLine({ parentName: null, parentArchived: true, projectName: "development-flow" }), "Sub-agent of an agent that is gone · development-flow");
});

test("a parent that only couldn't be read is one that can't be found, not one that is gone", () => {
  assert.equal(subagentContextLine({ parentName: null, parentUnread: true }), "Sub-agent of an agent that can't be found");
  assert.equal(subagentContextLine({ parentName: null, parentUnread: false }), "Sub-agent of an agent that is gone");
  assert.equal(subagentContextLine({ parentName: "Coordinator", parentUnread: true }), "Sub-agent of Coordinator");
});

test("a stopped agent's chat is read only when the user asks, since reading it starts the agent", () => {
  for (const status of ["running", "initializing", "idle"]) assert.equal(mayQueryAgent({ status }), true, status);
  for (const status of ["closed", "error"]) {
    assert.equal(mayQueryAgent({ status }), false, status);
    assert.equal(mayQueryAgent({ status }, true), true, `${status}, asked`);
  }
  assert.equal(mayQueryAgent({ status: "idle", archivedAt: "2026-09-28T00:00:00.000Z" }), false);
  assert.equal(mayQueryAgent({ status: "idle", providerUnavailable: true }), false);
});

test("a purpose line names a Mission Control task by its number and title, not its ID", () => {
  const titles = { "task_5af3eb14-1111-2222-3333-444455556666": "5 · Verify Needs You" };
  assert.equal(readablePurpose("Work on Mission Control task task_5af3eb14-1111-2222-3333-444455556666: 5 · Verify Needs You.", titles), "Work on task 5 · Verify Needs You");
  // Unknown to this vault: the title the prompt carries.
  assert.equal(readablePurpose("Work on Mission Control task task_700b9ce2-aaaa: 26 · Agents panel.", {}), "Work on task 26 · Agents panel");
  assert.equal(readablePurpose("Work on Mission Control task task_700b9ce2-aaaa:", {}), "Work on task 700b9ce2");
  assert.equal(readablePurpose("Review task task_5af3eb14-1111-2222-3333-444455556666 and report", titles), "Review task 5 · Verify Needs You and report");
  assert.equal(readablePurpose("Check task_deadbeef-0000 again", {}), "Check task deadbeef again");
  assert.equal(readablePurpose("Look into the flaky merge test", titles), "Look into the flaky merge test");
});

test("Paseo's own parent link is its label; the older label and the field don't count", () => {
  assert.equal(paseoParentOf({ labels: { "paseo.parent-agent-id": " p1 " } }), "p1");
  assert.equal(paseoParentOf({ labels: { "mission-control.parent-agent-id": "p1" } }), null);
  assert.equal(paseoParentOf({ labels: null }), null);
});

test("helpers are hidden when the list is missing or unavailable", () => {
  const helper = { id: "h1", parentAgentId: "p1", title: null, description: null, status: "running", createdAt: "", updatedAt: "" };
  assert.equal(helpersByParent(undefined).size, 0);
  assert.equal(helpersByParent({ available: false, helpers: [helper] }).size, 0);
  const grouped = helpersByParent({ available: true, helpers: [helper, { ...helper, id: "h2" }, { ...helper, id: "h3", parentAgentId: "p2" }] });
  assert.deepEqual([...grouped].map(([id, list]) => [id, list.map(entry => entry.id)]), [["p1", ["h1", "h2"]], ["p2", ["h3"]]]);
});

const live = id => ({ id, status: "idle" });

test("helpers are asked for only on this Mission Control's own host, while it is online", () => {
  const local = "srv_yom2uemk7M7e";
  assert.deepEqual(helperQueryPlan(local, local, [live("b"), live("a"), live("b")], true), { enabled: true, ids: ["a", "b"] });
  assert.equal(helperQueryPlan("srv_other", local, [live("a")], true).enabled, false);
  assert.equal(helperQueryPlan(local, local, [live("a")], false).enabled, false);
  assert.equal(helperQueryPlan(local, local, [], true).enabled, false);
  // No host selected yet: both IDs empty must not count as "this host".
  assert.equal(helperQueryPlan("", "", [live("a")], true).enabled, false);
  assert.equal(helperQueryPlan(local, local, Array.from({ length: 150 }, (_, index) => live(`agent-${String(index).padStart(3, "0")}`)), true).ids.length, 100);
});

test("a stopped agent is never asked for its helpers, since asking restarts it", () => {
  const local = "srv_yom2uemk7M7e";
  const parents = [
    { id: "running", status: "running" }, { id: "starting", status: "initializing" }, { id: "idle", status: "idle" },
    { id: "closed", status: "closed" }, { id: "failed", status: "error" },
    { id: "archived", status: "idle", archivedAt: "2026-09-28T00:00:00.000Z" }, { id: "no-provider", status: "idle", providerUnavailable: true },
  ];
  assert.deepEqual(helperQueryPlan(local, local, parents, true), { enabled: true, ids: ["idle", "running", "starting"] });
  // Only stopped agents: nothing is asked at all.
  assert.deepEqual(helperQueryPlan(local, local, parents.slice(3), true), { enabled: false, ids: [] });
});

test("the summary counts separate agents, running helpers and finished helpers", () => {
  assert.equal(subagentSummary({ children: 1, running: 2, finished: 3 }), "1 separate agent · 2 helpers running · 3 finished helpers");
  assert.equal(subagentSummary({ children: 2, running: 1, finished: 1 }), "2 separate agents · 1 helper running · 1 finished helper");
  assert.equal(subagentSummary({ children: 0, running: 0, finished: 0 }), "");
  assert.equal(subagentKindLabel("separate"), "separate agent");
  assert.equal(subagentKindLabel("helper"), "helper inside this agent's turn");
  assert.equal(subagentKindLabel("helper", "Builder"), "helper inside Builder's turn");
});
