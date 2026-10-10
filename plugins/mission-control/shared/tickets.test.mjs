import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { test } from "node:test";

const require = createRequire(import.meta.url);
const ts = require("typescript");
require.extensions[".ts"] = (module, file) => module._compile(ts.transpileModule(readFileSync(file, "utf8"), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText, file);
const { taskSchema } = require("./tasks.ts");
const { compareTrackerItems, importedTaskFields, ticketIdentity, trackerItemSchema } = require("./tickets.ts");

const task = (taskId, ticket) => taskSchema.parse({
  schemaVersion: 1, taskId, hostId: "personal", projectId: "prj", title: "A task", acceptanceCriteria: "Done.", status: "inbox", source: "manual",
  assignments: [{ serverId: "srv", workspaceId: "wks" }], createdAt: "2026-09-26T00:00:00Z", updatedAt: "2026-09-26T00:00:00Z",
  ...(ticket ? { ticket } : {}),
});
const jira = key => ({ system: "jira", key, url: `https://example.atlassian.net/browse/${key}` });
const item = (ticket, extra = {}) => trackerItemSchema.parse({ ...ticket, title: `Work on ${ticket.key}`, ...extra });

test("tasks without a ticket stay valid and keep no ticket", () => {
  const parsed = task("task_a");
  assert.equal(parsed.ticket, undefined);
  assert.equal(Object.hasOwn(parsed, "ticket"), false);
});

test("a task keeps a valid Jira or Azure DevOps ticket", () => {
  assert.deepEqual(task("task_a", jira("ABC-1")).ticket, jira("ABC-1"));
  const devops = { system: "azure-devops", key: "48213", url: "https://dev.azure.com/org/project/_workitems/edit/48213" };
  assert.deepEqual(task("task_b", devops).ticket, devops);
});

test("a malformed ticket is rejected", () => {
  for (const ticket of [
    { ...jira("ABC-1"), system: "github" },
    { ...jira("ABC-1"), url: "javascript:alert(1)" },
    { ...jira("ABC-1"), url: "https://example.com/has space" },
    { ...jira("ABC-1"), key: "" },
    { ...jira("ABC-1"), key: "ABC-1\nABC-2" },
    { system: "jira", key: "ABC-1" },
  ]) assert.equal(taskSchema.safeParse({ ...task("task_a"), ticket }).success, false, JSON.stringify(ticket));
});

test("ticket identity ignores key case and surrounding space but not the system", () => {
  assert.equal(ticketIdentity({ system: "jira", key: " abc-1 " }), ticketIdentity({ system: "jira", key: "ABC-1" }));
  assert.notEqual(ticketIdentity({ system: "jira", key: "77" }), ticketIdentity({ system: "azure-devops", key: "77" }));
});

test("items split into missing and imported by system and key", () => {
  const tasks = [
    task("task_one", jira("ABC-1")),
    task("task_two", { system: "azure-devops", key: "77", url: "https://dev.azure.com/o/p/_workitems/edit/77" }),
    task("task_three", jira("abc-1")),
    task("task_plain"),
  ];
  const items = [item(jira("abc-1")), item(jira("ABC-2")), item(jira("77")), item({ system: "azure-devops", key: "77", url: "https://dev.azure.com/o/p/_workitems/edit/77" }), item(jira("ABC-2"), { title: "Duplicate" })];
  const result = compareTrackerItems(items, tasks);
  assert.deepEqual(result.missing.map(entry => ticketIdentity(entry)), ["jira:ABC-2", "jira:77"]);
  assert.equal(result.missing[0].title, "Work on ABC-2");
  assert.deepEqual(result.imported.map(entry => [ticketIdentity(entry.item), entry.taskIds]), [["jira:ABC-1", ["task_one", "task_three"]], ["azure-devops:77", ["task_two"]]]);
});

test("with no tasks every item is missing, and with no items nothing is", () => {
  assert.equal(compareTrackerItems([item(jira("ABC-1"))], []).missing.length, 1);
  assert.deepEqual(compareTrackerItems([], [task("task_one", jira("ABC-1"))]), { missing: [], imported: [] });
});

test("an imported task gets the ticket, a keyed title and criteria that fit the task limits", () => {
  const fields = importedTaskFields(item(jira("ABC-1"), { title: "Fix\nlogin", description: "Description", acceptanceCriteria: "Criteria" }));
  assert.deepEqual(fields.ticket, jira("ABC-1"));
  assert.equal(fields.title, "ABC-1 · Fix login");
  assert.equal(fields.acceptanceCriteria, "Criteria\n\nImported from Jira ABC-1: https://example.atlassian.net/browse/ABC-1");
  assert.equal(importedTaskFields(item(jira("ABC-1"), { description: "Only a description" })).acceptanceCriteria.split("\n\n")[0], "Only a description");
  assert.equal(importedTaskFields(item(jira("ABC-1"))).acceptanceCriteria, "Imported from Jira ABC-1: https://example.atlassian.net/browse/ABC-1");

  const long = importedTaskFields(item(jira("ABC-1"), { title: "x".repeat(300), description: "y".repeat(20_000) }));
  assert.ok(long.title.length <= 200);
  assert.ok(long.acceptanceCriteria.length <= 4000);
  assert.match(long.acceptanceCriteria, /shortened; see the ticket\)\n\nImported from Jira ABC-1: https:\/\/example.atlassian.net\/browse\/ABC-1$/);
  assert.equal(taskSchema.safeParse({ ...task("task_a"), title: long.title, acceptanceCriteria: long.acceptanceCriteria, ticket: long.ticket }).success, true);
});

test("an item's work item type is kept on the imported ticket when known", () => {
  assert.deepEqual(importedTaskFields(item(jira("ABC-1"), { type: "Bug" })).ticket, { ...jira("ABC-1"), type: "Bug" });
  assert.equal(Object.hasOwn(importedTaskFields(item(jira("ABC-1"))).ticket, "type"), false);
  assert.equal(task("task_a", { ...jira("ABC-1"), type: "User Story" }).ticket.type, "User Story");
  assert.equal(taskSchema.safeParse({ ...task("task_a"), ticket: { ...jira("ABC-1"), type: "Bug\nStory" } }).success, false);
});
