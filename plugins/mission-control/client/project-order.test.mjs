import assert from "node:assert/strict";
import test from "node:test";
import { projectDropTarget } from "./project-order.ts";
import { mergeHostOrder, moveVisibleHost } from "./host-order.ts";

test("dragging variable-height project groups uses their measured headings in either direction", () => {
  const ids = ["small", "expanded", "last"];
  const tops = new Map([["small", 0], ["expanded", 100], ["last", 1100]]);
  assert.equal(projectDropTarget(ids, tops, "small", 90), "expanded");
  assert.equal(projectDropTarget(ids, tops, "small", 1000), "last");
  assert.equal(projectDropTarget(ids, tops, "last", -1000), "expanded");
  assert.equal(projectDropTarget(ids, tops, "last", -1100), "small");
  assert.equal(projectDropTarget(ids, tops, "last", 30), "last");
  assert.equal(projectDropTarget(ids, new Map(), "last", -500), "last");
});

test("project reorder retains filtered and absent slots, appending newly discovered projects", () => {
  const saved = ["a", "hidden", "b", "absent", "c"];
  const order = mergeHostOrder(saved, ["a", "b", "c", "new"]);
  const moved = moveVisibleHost(order, ["a", "b", "c"], "c", "a");
  assert.deepEqual(moved, ["c", "hidden", "a", "absent", "b", "new"]);
  assert.deepEqual(mergeHostOrder(moved, ["a", "b", "c", "hidden", "absent", "new"]), moved);
  assert.deepEqual(saved, ["a", "hidden", "b", "absent", "c"]);
});
