import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import ts from "typescript";

const source = fs.readFileSync(new URL("./kanban-model.ts", import.meta.url), "utf8");
const code = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
const module = { exports: {} };
new Function("require", "exports", "module", code)(() => new Proxy({}, { get: (_, key) => String(key) }), module.exports, module);
const { filterKanban, kanbanCounts } = module.exports;

function task(id, options = {}) {
  const { serverId = "cns", projectId = "one", state = "Ready", limited = false, needsYou = true, running = 0, lane = "attention", tab = "Workers", decisions = [], workers = [], priority = 0, updatedAt = "2026-11-04T08:00:00Z" } = options;
  return { needsYou, running, lane, tab, label: id, row: { key: `${serverId}:${id}`, serverId, hostLabel: serverId, state, limited, staleReview: false, priority, updatedAt, next: "Check this task", workers, entry: { task: { taskId: id, title: id, projectId }, decisions } } };
}
const decision = kind => ({ decision: { kind, status: "open" } });

test("Needs you counts final actions, interventions and unconfirmed work as well as manual requests", () => {
  const items = [
    task("manual-plan", { tab: "Plan", decisions: [decision("plan")] }),
    task("manual-review", { tab: "Code review", decisions: [decision("review")] }),
    task("question", { workers: [{ name: "Builder" }, { name: "Reviewer" }] }),
    task("ready-to-publish", { tab: "Delivery" }),
    task("ready-to-execute", { tab: "Delivery" }),
    task("needs-intervention"),
    task("unconfirmed-host", { needsYou: false, state: "Unconfirmed", tab: "Plan", decisions: [decision("plan")] }),
    task("partial-host", { needsYou: false, limited: true }),
    task("routine-review", { needsYou: false, lane: "working" }),
  ];
  assert.deepEqual(filterKanban(items, "all", "all", "", "Needs you").map(item => item.row.entry.task.taskId).sort(), ["manual-plan", "manual-review", "question", "ready-to-publish", "ready-to-execute", "needs-intervention", "unconfirmed-host", "partial-host"].sort());
  assert.equal(kanbanCounts(items).needsYou, 8, "each selected task counts once, regardless of worker count");
  assert.equal(kanbanCounts(items).plans, 1, "confirmed manual approval counters retain their meaning");
  assert.equal(kanbanCounts(items).reviews, 1);
  assert.equal(kanbanCounts(items).unconfirmed, 1);
});

test("Running count follows its existing filter without changing which cards it selects", () => {
  const items = [task("live", { running: 1, lane: "working" }), task("unconfirmed", { running: 1, state: "Unconfirmed" }), task("done-with-active-worker", { running: 1, lane: "done" }), task("idle", { running: 0 })];
  assert.deepEqual(filterKanban(items, "all", "all", "", "Running").map(item => item.row.entry.task.taskId).sort(), ["live", "unconfirmed", "done-with-active-worker"].sort());
  assert.equal(kanbanCounts(items).running, 3);
});

test("filter counts respect the same scoped and searched task set supplied by the board", () => {
  const items = [task("selected-task", { running: 1 }), task("other-project", { projectId: "two" }), task("other-host", { serverId: "jci" }), task("other-search")];
  const scoped = filterKanban(items, "cns", "one", "selected-task", "All work");
  assert.deepEqual(scoped.map(item => item.row.key), ["cns:selected-task"]);
  assert.equal(kanbanCounts(scoped).needsYou, 1);
  assert.equal(kanbanCounts(scoped).running, 1);
});

test("Done lists the most recently updated work first; the other lanes keep priority, then the longest waiting", () => {
  const items = [
    task("done-oldest", { lane: "done", needsYou: false, updatedAt: "2026-10-20T23:44:00.000Z" }),
    task("queued-newest", { lane: "queue", needsYou: false, updatedAt: "2026-11-02T08:00:00.000Z" }),
    task("done-newest", { lane: "done", needsYou: false, updatedAt: "2026-10-28T15:22:00.000Z" }),
    task("queued-oldest", { lane: "queue", needsYou: false, updatedAt: "2026-11-01T08:00:00.000Z" }),
    task("done-middle", { lane: "done", needsYou: false, updatedAt: "2026-10-27T16:54:00.000Z", priority: 5 }),
    task("queued-urgent", { lane: "queue", needsYou: false, updatedAt: "2026-11-03T08:00:00.000Z", priority: 9 }),
  ];
  const lane = id => filterKanban(items, "all", "all", "", "All work").filter(item => item.lane === id).map(item => item.row.entry.task.taskId);
  assert.deepEqual(lane("done"), ["done-newest", "done-middle", "done-oldest"]);
  assert.deepEqual(lane("queue"), ["queued-urgent", "queued-oldest", "queued-newest"]);
});
