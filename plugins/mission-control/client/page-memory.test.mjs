import { test } from "node:test";
import assert from "node:assert/strict";
import { createPageMemory, pageKey } from "./page-memory.ts";

test("returning after the surface unsubscribes retains the last page and filters", () => {
  const memory = createPageMemory();
  const key = pageKey("personal", "surface");
  const initial = { view: "workspaces", search: "" };
  assert.deepEqual(memory.read(key, initial), initial);
  let renders = 0;
  const leave = memory.subscribe(key, () => renders++);
  const position = { view: "attention", search: "Globex", selection: { serverId: "globex", workspaceId: "w1" } };
  memory.write(key, position);
  leave();
  assert.equal(renders, 1);
  assert.equal(memory.read(key, initial), position);
  memory.write(key, { ...position, search: "Claude" });
  assert.equal(renders, 1);
});

test("equal workspace and file names on different hosts keep separate state", () => {
  const memory = createPageMemory();
  const personal = pageKey("personal", "same-workspace", "tasks");
  const globex = pageKey("globex", "same-workspace", "tasks");
  memory.write(personal, "board");
  assert.equal(memory.read(globex, "list"), "list");
  assert.equal(memory.read(personal, "list"), "board");
  assert.notEqual(pageKey("a:b", "c"), pageKey("a", "b:c"));
});

test("initializers run once and falsy selections survive returning", () => {
  const memory = createPageMemory();
  let initializations = 0;
  const initial = () => { initializations++; return true; };
  memory.read("filter", initial);
  memory.write("filter", false);
  assert.equal(memory.read("filter", initial), false);
  assert.equal(initializations, 1);
  memory.write("selection", null);
  assert.equal(memory.read("selection", "default"), null);
});

test("another client session starts independently", () => {
  const desktop = createPageMemory();
  const mobile = createPageMemory();
  desktop.write("page", "docs");
  assert.equal(mobile.read("page", "workspaces"), "workspaces");
  assert.equal(desktop.read("page", "workspaces"), "docs");
});
