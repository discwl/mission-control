import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { test } from "node:test";

const require = createRequire(import.meta.url);
const ts = require("typescript");
require.extensions[".ts"] = (module, file) => module._compile(ts.transpileModule(readFileSync(file, "utf8"), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText, file);
const { agentsForTask, contextLineFor, findAgent, lookUpMissingParents, missingParentIds, PARENT_LOOKUPS, subagentContextOf, toAgent } = require("./roster-model.ts");
const { subagentContextLine } = require("../shared/subagents.ts");

const coordinator = "32a4f8db-c0b5-445f-ac5d-c27df91a7996";
const snapshot = overrides => ({
  id: "a1", provider: "codex", cwd: "C:\\Code\\development-flow", workspaceId: "wks_main", model: null,
  createdAt: "2026-09-26T04:00:00.000Z", updatedAt: "2026-09-26T04:10:00.000Z", lastUserMessageAt: null,
  status: "idle", title: "Needs You Smoke Test", labels: {}, pendingPermissions: [], ...overrides,
});
const agent = overrides => ({ ...toAgent(snapshot({})), ...overrides });
const workspaces = [
  { id: "wks_main", projectId: "prj_1", projectName: "development-flow", name: "main", status: "idle", activityAt: null, labels: [] },
  { id: "wks_task23", projectId: "prj_1", projectName: "development-flow", name: "23-follow-paseo-json", status: "idle", activityAt: null, labels: [] },
];

test("reasoning uses the effective setting, falls back to the selected setting, and never guesses a default", () => {
  assert.equal(toAgent(snapshot({ thinkingOptionId: "low", effectiveThinkingOptionId: "xhigh" })).reasoningLevel, "Extra high");
  for (const [id, label] of [["medium", "Medium"], ["high", "High"], ["max", "Max"], ["ultra", "Ultra"], ["none", "None"]]) {
    assert.equal(toAgent(snapshot({ thinkingOptionId: id, effectiveThinkingOptionId: null })).reasoningLevel, label);
  }
  assert.equal(toAgent(snapshot({ effectiveThinkingOptionId: "provider-custom" })).reasoningLevel, "provider-custom");
  assert.equal(toAgent(snapshot({ thinkingOptionId: null, effectiveThinkingOptionId: null })).reasoningLevel, null);
  assert.equal(toAgent(snapshot({})).reasoningLevel, null);
});

test("an agent keeps its labels, and its own summary when the daemon sends one", () => {
  assert.deepEqual(toAgent(snapshot({ labels: { "mission-control.role": "builder" } })).labels, { "mission-control.role": "builder" });
  assert.equal(toAgent(snapshot({})).summary, null);
  assert.equal(toAgent(snapshot({ summary: "  Writing tests  " })).summary, "Writing tests");
});

test("a child agent's parent and task come from Paseo's labels", () => {
  const child = toAgent(snapshot({ labels: { "paseo.parent-agent-id": coordinator, "mission-control.task-id": "task_5af3", "mission-control.role": "builder" } }));
  assert.equal(child.parentAgentId, coordinator);
  assert.equal(child.taskId, "task_5af3");
  assert.equal(child.role, "builder");
  assert.equal(toAgent(snapshot({})).parentAgentId, null);
});

test("parents missing from the list are looked up once each", () => {
  assert.deepEqual(missingParentIds([
    { id: "a", parentAgentId: coordinator }, { id: "b", parentAgentId: "a" }, { id: "c", parentAgentId: coordinator }, { id: "d", parentAgentId: "gone" },
  ]), [coordinator, "gone"]);
});

test("the context line names a parent in another workspace", () => {
  const roster = {
    workspaces,
    agents: [agent({ id: coordinator, name: "Review Names Control", workspaceId: "wks_main" }), agent({ id: "child", workspaceId: "wks_task23", parentAgentId: coordinator })],
    outsideParents: [],
  };
  assert.equal(subagentContextLine(subagentContextOf(roster, coordinator)), "Sub-agent of Review Names Control · development-flow / main");
});

test("the context line names an archived parent and its task", () => {
  const roster = {
    workspaces,
    agents: [agent({ id: "child", parentAgentId: "d725da0b" })],
    outsideParents: [agent({ id: "d725da0b", name: "Task 23 builder", workspaceId: "wks_task23", archivedAt: "2026-09-28T01:00:00.000Z", taskId: "task_de2cb4a8" })],
  };
  const titles = { task_de2cb4a8: "23 · Follow paseo.json for commit messages and PR text" };
  assert.equal(findAgent(roster, "d725da0b")?.name, "Task 23 builder");
  assert.equal(subagentContextLine(subagentContextOf(roster, "d725da0b", titles)),
    "Sub-agent of Task 23 builder (archived) · 23 · Follow paseo.json for commit messages and PR text · development-flow / 23-follow-paseo-json");
  // A parent that can't be found at all still gets a line.
  assert.equal(subagentContextLine(subagentContextOf(roster, "unknown", titles)), "Sub-agent of an agent that is gone");
  assert.equal(subagentContextOf(roster, "unknown", titles).parentName, null);
});

test("an archived parent missing from the agent list is looked up by ID", async () => {
  const child = agent({ id: "smoke-test", parentAgentId: coordinator });
  const requested = [];
  const { parents, unread } = await lookUpMissingParents([child, agent({ id: "solo" })], async id => {
    requested.push(id);
    return snapshot({ id, title: "Review Names Control", archivedAt: "2026-09-28T01:00:00.000Z", labels: { "mission-control.task-id": "task_coord" } });
  });
  assert.deepEqual(requested, [coordinator]);
  assert.deepEqual(unread, []);
  assert.equal(parents.length, 1);
  assert.equal(parents[0].name, "Review Names Control");
  assert.equal(parents[0].archivedAt, "2026-09-28T01:00:00.000Z");
  const roster = { workspaces, agents: [child], outsideParents: parents };
  assert.equal(contextLineFor(roster, child, { task_coord: "Coordinator task" }), "Sub-agent of Review Names Control (archived) · Coordinator task · development-flow / main");
});

test("a parent that is gone is left out; one that can't be read, or is over the lookup cap, can't be found", async () => {
  const children = Array.from({ length: PARENT_LOOKUPS + 3 }, (_, index) => agent({ id: `child-${index}`, parentAgentId: `parent-${index}` }));
  const requested = [];
  const { parents, unread } = await lookUpMissingParents(children, async id => {
    requested.push(id);
    if (id === "parent-0") return null;
    if (id === "parent-1") throw new Error("connection closed");
    return snapshot({ id, title: id });
  });
  assert.equal(requested.length, PARENT_LOOKUPS);
  assert.deepEqual(parents.map(parent => parent.id), requested.slice(2));
  assert.deepEqual(unread.sort(), ["parent-1", `parent-${PARENT_LOOKUPS}`, `parent-${PARENT_LOOKUPS + 1}`, `parent-${PARENT_LOOKUPS + 2}`].sort());
  const roster = { workspaces, agents: children, outsideParents: parents, unreadParents: unread };
  assert.equal(contextLineFor(roster, children[0]), "Sub-agent of an agent that is gone");
  assert.equal(contextLineFor(roster, children[1]), "Sub-agent of an agent that can't be found");
  assert.equal(contextLineFor(roster, children[PARENT_LOOKUPS + 2]), "Sub-agent of an agent that can't be found");
  assert.deepEqual(await lookUpMissingParents([agent({ id: "solo" })], async () => { throw new Error("not called"); }), { parents: [], unread: [] });
  assert.equal(contextLineFor({ workspaces, agents: [], outsideParents: [] }, agent({ id: "solo" })), null);
});

test("a task's agents leave out the ones another of its agents started", () => {
  const agents = [
    agent({ id: "builder", taskId: "task_23" }),
    agent({ id: "helper-agent", taskId: "task_23", parentAgentId: "builder" }),
    agent({ id: "resumed", taskId: "task_23", parentAgentId: coordinator }),
    agent({ id: "other", taskId: "task_24" }),
  ];
  assert.deepEqual(agentsForTask(agents, "task_23").map(entry => entry.id), ["builder", "resumed"]);
});
