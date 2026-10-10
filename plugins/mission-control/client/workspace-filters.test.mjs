import assert from "node:assert/strict";
import { test } from "node:test";
import { filterWorkspaceEntries } from "./workspace-filters.ts";

const workspaces = [
  { id: "billing-review", name: "Invoice rounding", projectId: "billing", projectName: "Billing", labels: ["Review", "Focus"], activeTasks: true },
  { id: "billing-done", name: "Tax cleanup", projectId: "billing", projectName: "Billing", labels: ["Done"], activeTasks: false },
  { id: "sales-review", name: "Invoice export", projectId: "sales", projectName: "Sales", labels: ["Review"], activeTasks: true },
];

test("label selection composes with project, search and active-task filters", () => {
  const result = filterWorkspaceEntries(workspaces, { search: "invoice", projectIds: ["billing"], label: "review" }, workspace => workspace.activeTasks);
  assert.deepEqual(result.map(workspace => workspace.id), ["billing-review"]);
});

test("all labels retains the existing filter result and preserves roster order", () => {
  const result = filterWorkspaceEntries(workspaces, { search: "", projectIds: [], label: "all" }, () => true);
  assert.deepEqual(result.map(workspace => workspace.id), ["billing-review", "billing-done", "sales-review"]);
});

test("unknown or absent labels do not match a selected status", () => {
  const result = filterWorkspaceEntries(workspaces, { search: "", projectIds: [], label: "Blocked" }, () => true);
  assert.deepEqual(result, []);
});

test("multiple projects are a union composed with label, search and activity", () => {
  const options = { search: "invoice", projectIds: ["billing", "sales"], label: "REVIEW" };
  assert.deepEqual(filterWorkspaceEntries(workspaces, options, workspace => workspace.activeTasks).map(item => item.id), ["billing-review", "sales-review"]);
  assert.deepEqual(filterWorkspaceEntries(workspaces, { ...options, projectIds: ["sales"] }, () => true).map(item => item.id), ["sales-review"]);
  assert.deepEqual(filterWorkspaceEntries(workspaces, { ...options, projectIds: ["missing"] }, () => true), []);
});
