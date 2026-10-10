import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { test } from "node:test";

const require = createRequire(import.meta.url);
const ts = require("typescript");
require.extensions[".ts"] = (module, file) => module._compile(ts.transpileModule(readFileSync(file, "utf8"), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText, file);
const {
  agentState, archiveOutcome, buildAgentTree, canDetach, collapseTree, confirmCopy, formatAge, helperState, nodeKey, oneLine, permissionCopy, subAgentsOf,
  summarizeTree, waitingByAgent, whereItsAt,
} = require("./agent-tree.ts");

const HERE = "wks_here";
let clock = 0;
const agent = (id, overrides = {}) => ({
  id, workspaceId: HERE, parentAgentId: null, name: id, provider: "claude", model: "opus", status: "idle",
  createdAt: new Date(Date.UTC(2026, 8, 29, 10, 0, clock++)).toISOString(), updatedAt: "2026-09-29T10:00:00.000Z", archivedAt: null,
  requiresAttention: false, attentionReason: null, attentionTimestamp: null, activeTurnStartedAt: null,
  permissions: [], lastError: null, labels: {}, taskId: null, role: null, ...overrides,
});
const helper = (id, parentAgentId, status = "running", overrides = {}) => ({
  id, parentAgentId, title: "Explore", description: `Look into ${id}`, status, createdAt: "2026-09-29T10:00:00.000Z", updatedAt: "2026-09-29T10:05:00.000Z", ...overrides,
});
// [key, depth] per row, plus a flag for dimmed context rows.
const rows = nodes => nodes.map(node => node.kind === "agent" ? [node.agent.id, node.depth, ...node.contextOnly ? ["dim"] : []] : [nodeKey(node), node.depth]);

test("children sit under their parents, at any depth, with descendant counts", () => {
  const nodes = buildAgentTree([
    agent("coordinator"), agent("builder", { parentAgentId: "coordinator" }), agent("tester", { parentAgentId: "builder" }),
    agent("reviewer", { parentAgentId: "coordinator" }), agent("solo"),
  ], HERE);
  assert.deepEqual(rows(nodes), [["coordinator", 0], ["builder", 1], ["tester", 2], ["reviewer", 1], ["solo", 0]]);
  assert.deepEqual(nodes.map(node => node.descendants), [3, 1, 0, 0, 0]);
  assert.ok(nodes.every(node => node.member && !node.parentOutside));
});

test("a sub-agent working in another workspace stays in its crew; unrelated agents there are left out", () => {
  const nodes = buildAgentTree([
    agent("coordinator"),
    agent("worktree-builder", { parentAgentId: "coordinator", workspaceId: "wks_task" }),
    agent("its-helper-agent", { parentAgentId: "worktree-builder", workspaceId: "wks_other" }),
    agent("stranger", { workspaceId: "wks_task" }),
    agent("strangers-child", { parentAgentId: "stranger", workspaceId: "wks_task" }),
  ], HERE);
  assert.deepEqual(rows(nodes), [["coordinator", 0], ["worktree-builder", 1], ["its-helper-agent", 2]]);
  assert.ok(nodes.every(node => node.member && !node.contextOnly));
  const summary = summarizeTree(nodes, HERE);
  assert.equal(summary.agents, 3);
  assert.equal(summary.elsewhere, 2);
  assert.equal(summary.crews, 1);
});

test("ancestors from another workspace are dimmed context; their other branches are pruned", () => {
  const nodes = buildAgentTree([
    agent("main-coordinator", { workspaceId: "wks_main" }),
    agent("task-lead", { workspaceId: "wks_main", parentAgentId: "main-coordinator" }),
    agent("other-lead", { workspaceId: "wks_main", parentAgentId: "main-coordinator" }),
    agent("local-builder", { parentAgentId: "task-lead" }),
    agent("local-tester", { parentAgentId: "local-builder" }),
  ], HERE);
  assert.deepEqual(rows(nodes), [["main-coordinator", 0, "dim"], ["task-lead", 1, "dim"], ["local-builder", 2], ["local-tester", 3]]);
  const [coordinator, lead, builder, tester] = nodes;
  assert.equal(coordinator.member, false);
  assert.equal(lead.member, false);
  // The local agent under a dimmed ancestor still says whose it is; its own child doesn't need to.
  assert.equal(builder.parentOutside, true);
  assert.equal(tester.parentOutside, false);
  // Counts cover the workspace's crew only; dimmed ancestors count only the members below them.
  assert.equal(coordinator.descendants, 2);
  const summary = summarizeTree(nodes, HERE);
  assert.equal(summary.agents, 2);
  // The crew started from another workspace still counts as one crew.
  assert.equal(summary.crews, 1);
});

test("archived agents are left out; a child of an archived parent becomes a top row that says whose it is", () => {
  const nodes = buildAgentTree([
    agent("archived-parent", { archivedAt: "2026-09-28T00:00:00.000Z" }),
    agent("orphan", { parentAgentId: "archived-parent" }),
    agent("archived-child", { parentAgentId: "orphan", archivedAt: "2026-09-28T00:00:00.000Z" }),
    agent("gone-parent-child", { parentAgentId: "never-listed" }),
  ], HERE);
  assert.deepEqual(rows(nodes), [["orphan", 0], ["gone-parent-child", 0]]);
  assert.ok(nodes.every(node => node.parentOutside));
  assert.equal(nodes[0].descendants, 0);
});

test("parent cycles are bounded: every agent is listed once", () => {
  const nodes = buildAgentTree([
    agent("a", { parentAgentId: "b" }), agent("b", { parentAgentId: "a" }), agent("self", { parentAgentId: "self" }),
    // A local agent whose foreign ancestors loop.
    agent("local", { parentAgentId: "f1" }), agent("f1", { workspaceId: "wks_x", parentAgentId: "f2" }), agent("f2", { workspaceId: "wks_x", parentAgentId: "f1" }),
  ], HERE);
  const ids = rows(nodes).map(([id]) => id);
  assert.equal(new Set(ids).size, ids.length);
  assert.deepEqual(ids.filter(id => !id.startsWith("f")).sort(), ["a", "b", "local", "self"]);
  // The local agent still sits under a dimmed ancestor from the loop, and says whose it is.
  const local = nodes.findIndex(node => node.agent.id === "local");
  assert.equal(nodes[local].depth, 1);
  assert.deepEqual(rows([nodes[local - 1]]), [["f1", 0, "dim"]]);
  assert.equal(nodes[local].parentOutside, true);
});

test("state precedence: Failed, Needs input, Working, Ready, Closed, Idle", () => {
  const permission = [{ id: "p1" }];
  assert.equal(agentState(agent("x", { status: "error", permissions: permission })), "failed");
  assert.equal(agentState(agent("x", { status: "idle", requiresAttention: true, attentionReason: "error" })), "failed");
  assert.equal(agentState(agent("x", { status: "running", permissions: permission })), "needs-input");
  assert.equal(agentState(agent("x", { status: "idle", attentionReason: "permission" })), "needs-input");
  // Open decisions and recorded questions count as Needs input too.
  assert.equal(agentState(agent("x", { status: "running" }), 1), "needs-input");
  assert.equal(agentState(agent("x", { status: "running" })), "working");
  assert.equal(agentState(agent("x", { status: "initializing" })), "working");
  assert.equal(agentState(agent("x", { status: "closed", requiresAttention: true, attentionReason: "finished" })), "ready");
  assert.equal(agentState(agent("x", { status: "closed" })), "closed");
  assert.equal(agentState(agent("x")), "idle");
  assert.deepEqual(["running", "finished", "error", "stopped", "idle"].map(status => helperState({ status })), ["working", "closed", "failed", "closed", "idle"]);
});

test("All sorts by the displayed activity age before status or creation date", () => {
  const common = { attentionTimestamp: null, activeTurnStartedAt: null, requiresAttention: false, permissions: [] };
  const agents = [
    agent("working-five", { ...common, status: "running", activeTurnStartedAt: "2026-10-02T11:55:00Z", updatedAt: "2026-10-02T12:00:00Z" }),
    agent("failed-day", { ...common, status: "error", updatedAt: "2026-10-01T12:00:00Z" }),
    agent("ready-thirty-two", { ...common, requiresAttention: true, attentionReason: "finished", attentionTimestamp: "2026-10-02T11:28:00Z", updatedAt: "2026-10-02T12:00:00Z" }),
    agent("idle-nine", { ...common, createdAt: "2026-10-02T11:00:00Z", updatedAt: "2026-10-02T11:51:00Z" }),
    agent("idle-now", { ...common, createdAt: "2026-09-01T12:00:00Z", updatedAt: "2026-10-02T12:00:00Z" }),
  ];
  assert.deepEqual(rows(buildAgentTree(agents, HERE)), [
    ["idle-now", 0], ["working-five", 0], ["idle-nine", 0], ["ready-thirty-two", 0], ["failed-day", 0],
  ]);
  assert.deepEqual(rows(buildAgentTree(agents, HERE, { state: "idle" })), [["idle-now", 0], ["idle-nine", 0]]);
  agents[3].updatedAt = "2026-10-02T12:01:00Z";
  assert.equal(buildAgentTree(agents, HERE)[0].agent.id, "idle-nine");
});

test("recent activity sorts sibling sub-agents while preserving their parent group", () => {
  const common = { attentionTimestamp: null, activeTurnStartedAt: null, requiresAttention: false, permissions: [] };
  const agents = [
    agent("lead", { ...common, status: "running", updatedAt: "2026-10-02T11:55:00Z" }),
    agent("older-child", { ...common, parentAgentId: "lead", updatedAt: "2026-10-02T11:51:00Z" }),
    agent("recent-child", { ...common, parentAgentId: "lead", updatedAt: "2026-10-02T12:00:00Z" }),
    agent("solo", { ...common, updatedAt: "2026-10-02T11:58:00Z" }),
  ];
  assert.deepEqual(rows(buildAgentTree(agents, HERE)), [["solo", 0], ["lead", 0], ["recent-child", 1], ["older-child", 1]]);
  assert.deepEqual(rows(buildAgentTree(agents, HERE, { state: "idle" })), [["solo", 0], ["lead", 0, "dim"], ["recent-child", 1], ["older-child", 1]]);
});

test("the chips count every agent and helper by state, and equal-activity siblings sort by what needs you first", () => {
  const agents = [
    agent("lead"),
    agent("idle-child", { parentAgentId: "lead" }),
    agent("failed-child", { parentAgentId: "lead", status: "error" }),
    agent("waiting-child", { parentAgentId: "lead", status: "running", permissions: [{ id: "p" }] }),
    agent("decision-child", { parentAgentId: "lead" }),
    agent("done", { requiresAttention: true, attentionReason: "finished" }),
    agent("closed", { status: "closed" }),
    agent("busy", { status: "running" }),
  ];
  const helpers = new Map([["lead", [helper("h1", "lead"), helper("h2", "lead", "finished"), helper("h3", "lead", "error")]]]);
  const waiting = waitingByAgent([{ agentId: "decision-child" }, { agentId: null }]);
  const nodes = buildAgentTree(agents, HERE, { helpers, waiting });
  const summary = summarizeTree(nodes, HERE, helpers);
  assert.deepEqual(summary.counts, { "needs-input": 2, failed: 2, working: 2, ready: 1, idle: 2, closed: 2 });
  assert.equal(summary.agents, 8);
  assert.equal(summary.helpers, 3);
  assert.equal(summary.runningHelpers, 1);
  assert.equal(summary.crews, 1);
  const lead = nodes.find(node => node.kind === "agent" && node.agent.id === "lead");
  assert.deepEqual([lead.descendants, lead.helpers, lead.runningHelpers], [4, 3, 1]);
  const children = nodes.filter(node => node.kind === "agent" && node.agent.parentAgentId === "lead").map(node => node.agent.id);
  assert.deepEqual(children, ["waiting-child", "decision-child", "failed-child", "idle-child"]);
  assert.equal(nodes.find(node => node.agent?.id === "decision-child").waiting, 1);
});

test("a state filter keeps matching agents and, dimmed, the parents above them", () => {
  const agents = [agent("lead"), agent("child", { parentAgentId: "lead", status: "error" }), agent("other"), agent("sibling", { parentAgentId: "lead" })];
  const failed = buildAgentTree(agents, HERE, { state: "failed" });
  assert.deepEqual(rows(failed), [["lead", 0, "dim"], ["child", 1]]);
  assert.deepEqual(rows(buildAgentTree(agents, HERE, { state: "closed" })), []);
});

test("search covers title, ID, provider, model, task, workspace, role and labels", () => {
  const agents = [
    agent("a1b2c3", { name: "Release builder", provider: "codex", model: "gpt-6", taskId: "task_26", role: "builder", labels: { "paseo.parent-agent-id": "x", team: "Payments" } }),
    agent("elsewhere-child", { parentAgentId: "a1b2c3", workspaceId: "wks_task" }),
    agent("quiet"),
  ];
  const options = { taskTitles: { task_26: "26 · Agents panel" }, workspaceNames: new Map([["wks_task", "task-26-worktree"]]) };
  const find = query => rows(buildAgentTree(agents, HERE, { ...options, query })).filter(row => row[2] !== "dim").map(([id]) => id);
  assert.deepEqual(find("RELEASE"), ["a1b2c3"]);
  assert.deepEqual(find("a1b2"), ["a1b2c3"]);
  assert.deepEqual(find("codex"), ["a1b2c3"]);
  assert.deepEqual(find("gpt-6"), ["a1b2c3"]);
  assert.deepEqual(find("agents panel"), ["a1b2c3"]);
  assert.deepEqual(find("task_26"), ["a1b2c3"]);
  assert.deepEqual(find("task-26-worktree"), ["elsewhere-child"]);
  assert.deepEqual(find("builder"), ["a1b2c3"]);
  assert.deepEqual(find("payments"), ["a1b2c3"]);
  assert.deepEqual(find("team"), ["a1b2c3"]);
  assert.deepEqual(find("nothing like it"), []);
  // A match below keeps its parent, dimmed.
  assert.deepEqual(rows(buildAgentTree(agents, HERE, { ...options, query: "task-26-worktree" })), [["a1b2c3", 0, "dim"], ["elsewhere-child", 1]]);
});

test("helpers sit under their parent, marked as helpers; finished ones fold into a count until opened", () => {
  const agents = [agent("lead"), agent("child", { parentAgentId: "lead" })];
  const helpers = new Map([["lead", [helper("h-run", "lead"), helper("h-done", "lead", "finished"), helper("h-stop", "lead", "stopped")]]]);
  const nodes = buildAgentTree(agents, HERE, { helpers });
  assert.deepEqual(rows(nodes), [["lead", 0], ["helper:lead:h-run", 1], ["finished:lead", 1], ["child", 1]]);
  const running = nodes[1];
  assert.equal(running.kind, "helper");
  assert.equal(running.label, "helper inside lead's turn");
  assert.equal(running.state, "working");
  assert.deepEqual([nodes[2].count, nodes[2].open], [2, false]);
  const open = buildAgentTree(agents, HERE, { helpers, openFinished: new Set(["lead"]) });
  assert.deepEqual(rows(open), [["lead", 0], ["helper:lead:h-run", 1], ["finished:lead", 1], ["helper:lead:h-done", 1], ["helper:lead:h-stop", 1], ["child", 1]]);
  // With a filter, matching helpers are listed one by one and keep their parent.
  assert.deepEqual(rows(buildAgentTree(agents, HERE, { helpers, state: "closed" })), [["lead", 0, "dim"], ["helper:lead:h-done", 1], ["helper:lead:h-stop", 1]]);
  assert.deepEqual(rows(buildAgentTree(agents, HERE, { helpers, query: "h-run" })), [["lead", 0, "dim"], ["helper:lead:h-run", 1]]);
  // Collapsing the parent hides its helpers and sub-agents.
  assert.deepEqual(rows(collapseTree(nodes, new Set(["lead"]))), [["lead", 0]]);
});

test("a dimmed ancestor from another workspace doesn't list its helpers", () => {
  const agents = [agent("foreign", { workspaceId: "wks_main" }), agent("local", { parentAgentId: "foreign" })];
  const helpers = new Map([["foreign", [helper("h1", "foreign")]], ["local", [helper("h2", "local")]]]);
  const nodes = buildAgentTree(agents, HERE, { helpers });
  assert.deepEqual(rows(nodes), [["foreign", 0, "dim"], ["local", 1], ["helper:local:h2", 2]]);
  assert.equal(summarizeTree(nodes, HERE, helpers).helpers, 1);
});

test("collapsing a parent hides everything below it and nothing else", () => {
  const nodes = buildAgentTree([agent("p"), agent("c", { parentAgentId: "p" }), agent("g", { parentAgentId: "c" }), agent("q")], HERE);
  assert.deepEqual(rows(collapseTree(nodes, new Set(["c"]))), [["p", 0], ["c", 1], ["q", 0]]);
  assert.deepEqual(rows(collapseTree(nodes, new Set(["p"]))), [["p", 0], ["q", 0]]);
  // A leaf can't collapse.
  assert.deepEqual(rows(collapseTree(nodes, new Set(["q"]))), rows(nodes));
});

test("every action is confirmed in plain words", () => {
  assert.deepEqual(confirmCopy("redirect", { name: "Builder", state: "working" }), {
    title: "Interrupt and redirect Builder?",
    body: "Builder is working. Sending this stops its current turn now, and it starts on your message instead. Anything that turn hadn't finished is left as it is.",
    confirm: "Stop the turn and send",
  });
  assert.deepEqual(confirmCopy("reply", { name: "Builder", state: "idle" }), {
    title: "Reply to Builder", body: "Builder gets your message as its next prompt and starts on it now.", confirm: "Send reply",
  });
  assert.deepEqual(confirmCopy("reply", { name: "Builder", state: "needs-input", permissions: 1 }), {
    title: "Reply to Builder?",
    body: "Builder is waiting for you to allow or deny a request. Sending a message dismisses that request, and it starts on your message instead.",
    confirm: "Dismiss the request and send",
  });
  assert.equal(confirmCopy("reply", { name: "Builder", state: "needs-input" }).body,
    "Builder gets your message as its next prompt and starts on it now. A message doesn't answer its open decision or question; answer those in Attention.");
  assert.deepEqual(confirmCopy("detach", { name: "Tester", state: "idle", parentName: "Builder", subAgents: 2 }), {
    title: "Detach Tester?",
    body: "Tester stops being a sub-agent of Builder and carries on as an agent of its own, and its 2 sub-agents go with it. Nothing is stopped or archived.",
    confirm: "Detach",
  });
  assert.equal(confirmCopy("detach", { name: "Tester", state: "idle", subAgents: 1 }).body,
    "Tester stops being a sub-agent of its parent and carries on as an agent of its own, and its 1 sub-agent goes with it. Nothing is stopped or archived.");
  assert.deepEqual(confirmCopy("archive", { name: "Lead", state: "working", archivedWithIt: 2, detachedFromIt: 1, runningHelpers: 3 }), {
    title: "Archive Lead?",
    body: "This stops Lead, including any work it is doing now, and removes it from the list. Its 2 sub-agents in the same workspace are archived with it. Its 1 sub-agent in other workspaces or open in its own tab is detached and keeps running. The 3 helpers running inside its turn stop with it. Its workspace and Mission Control records are kept.",
    confirm: "Archive",
  });
  assert.equal(confirmCopy("archive", { name: "Lead", state: "idle", archivedWithIt: 1, untouched: 1 }).body,
    "This stops Lead, including any work it is doing now, and removes it from the list. Its 1 sub-agent in the same workspace is archived with it. Its 1 sub-agent linked the older way is left as it is and keeps running. Its workspace and Mission Control records are kept.");
  assert.equal(confirmCopy("archive", { name: "Lead", state: "idle", untouched: 2 }).body,
    "This stops Lead, including any work it is doing now, and removes it from the list. Its 2 sub-agents linked the older way are left as they are and keep running. Its workspace and Mission Control records are kept.");
  assert.equal(confirmCopy("archive", { name: "Solo", state: "idle" }).body,
    "This stops Solo, including any work it is doing now, and removes it from the list. It has no sub-agents. Its workspace and Mission Control records are kept.");
  assert.equal(confirmCopy("archive", { name: "Lead", state: "idle", detachedFromIt: 2, runningHelpers: 1 }).body,
    "This stops Lead, including any work it is doing now, and removes it from the list. Its 2 sub-agents in other workspaces or open in their own tabs are detached and keep running. The 1 helper running inside its turn stops with it. Its workspace and Mission Control records are kept.");
  assert.deepEqual(permissionCopy("Builder", "Run npm ci"), {
    title: "Permission request from Builder",
    body: "Builder asks: Run npm ci. Allow lets it go ahead with this request. Deny tells it no, and it carries on without it.",
    confirm: "Allow", deny: "Deny",
  });
});

test("where it's at: the agent's own summary, else its run's next step, else its latest message, in one trimmed line", () => {
  const run = { stage: "execute", outcome: "in_progress", nextAction: "Write the tree tests." };
  assert.equal(whereItsAt({ summary: "  Writing **tests**\nfor the tree ", run, message: "ignored" }), "Writing tests for the tree");
  assert.equal(whereItsAt({ run, message: "ignored" }), "Build · next: Write the tree tests.");
  assert.equal(whereItsAt({ run: { ...run, stage: "plan", outcome: "waiting" } }), "Plan · waiting · next: Write the tree tests.");
  assert.equal(whereItsAt({ run: { ...run, nextAction: " " }, message: "## Done\n\nAll `380` tests pass." }), "Done All 380 tests pass.");
  assert.equal(whereItsAt({}), null);
  assert.equal(oneLine("x".repeat(200)).length, 160);
  assert.ok(oneLine("x".repeat(200)).endsWith("…"));
  assert.equal(oneLine("```\ncode\n```\n  "), null);
});

test("open decisions and questions are counted per agent", () => {
  assert.deepEqual([...waitingByAgent([{ agentId: "a" }, { agentId: "a" }, { agentId: null }], [{ agentId: "b" }])], [["a", 2], ["b", 1]]);
});

test("an agent's sub-agents are found at any depth, in any workspace, without archived ones or cycles", () => {
  const agents = [
    agent("lead"), agent("c1", { parentAgentId: "lead" }), agent("c2", { parentAgentId: "lead", workspaceId: "wks_x" }),
    agent("g1", { parentAgentId: "c2", workspaceId: "wks_x" }), agent("archived", { parentAgentId: "lead", archivedAt: "2026-09-28" }),
    agent("loop", { parentAgentId: "g1" }), agent("lead-again", { id: "lead", parentAgentId: "loop" }),
  ];
  assert.deepEqual(subAgentsOf(agents, "lead").map(entry => entry.id).sort(), ["c1", "c2", "g1", "loop"]);
});

// A child linked the way Paseo links it: its parent in Paseo's own label.
const child = (id, parentAgentId, overrides = {}) => agent(id, { parentAgentId, ...overrides, labels: { "paseo.parent-agent-id": parentAgentId, ...overrides.labels } });

test("archiving follows Paseo's cascade: same-workspace children are archived, others are detached with their own sub-agents", () => {
  const agents = [
    agent("lead"),
    child("here-child", "lead"),
    child("here-grandchild", "here-child"),
    child("grandchild-elsewhere", "here-child", { workspaceId: "wks_x" }),
    child("away-child", "lead", { workspaceId: "wks_x" }),
    child("away-grandchild", "away-child", { workspaceId: "wks_x" }),
    child("tab-child", "lead", { labels: { "paseo.open-agent-tab.desktop-client": "true" } }),
    child("closed-tab-child", "lead", { labels: { "paseo.open-agent-tab.desktop-client": "false" } }),
    child("archived-child", "lead", { archivedAt: "2026-09-28" }),
    // Linked only by Mission Control's older label: Paseo's cascade doesn't see it.
    agent("older-link", { parentAgentId: "lead", labels: { "mission-control.parent-agent-id": "lead" } }),
    child("older-links-child", "older-link"),
  ];
  // Archived: here-child, here-grandchild, closed-tab-child. Detached: grandchild-elsewhere, away-child, tab-child. Untouched: older-link.
  assert.deepEqual(archiveOutcome(agents, "lead"), { archived: 3, detached: 3, untouched: 1 });
  assert.deepEqual(archiveOutcome(agents, "here-grandchild"), { archived: 0, detached: 0, untouched: 0 });
  // A child without a workspace follows its parent.
  assert.deepEqual(archiveOutcome([agent("p"), child("c", "p", { workspaceId: null })], "p"), { archived: 1, detached: 0, untouched: 0 });
});

test("only a child linked by Paseo's own label can be detached", () => {
  assert.equal(canDetach(child("c", "p")), true);
  assert.equal(canDetach(agent("c", { parentAgentId: "p", labels: { "mission-control.parent-agent-id": "p" } })), false);
  // A parentAgentId field alone (newer SDKs) with no label: Paseo's detach removes the label, so there's nothing to detach.
  assert.equal(canDetach(agent("c", { parentAgentId: "p" })), false);
  assert.equal(canDetach(agent("solo")), false);
});

test("ages read as now, minutes, hours or days", () => {
  const now = Date.parse("2026-09-29T12:00:00.000Z");
  assert.equal(formatAge(0, now), "");
  assert.equal(formatAge(now - 30_000, now), "now");
  assert.equal(formatAge(now - 5 * 60_000, now), "5m");
  assert.equal(formatAge(now - 3 * 3_600_000, now), "3h");
  assert.equal(formatAge(now - 2 * 86_400_000, now), "2d");
});
