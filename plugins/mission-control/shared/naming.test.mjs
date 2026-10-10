import assert from "node:assert/strict";
import { test } from "node:test";
import { nameWarnings, renameConflict } from "./naming.ts";

test("workspace ticket prefixes do not count toward descriptive word limits", () => {
  for (const prefix of ["APP-123", "12345", "APP-123, APP-456"]) {
    assert.deepEqual(nameWarnings(`${prefix} · Fix Login Session Timeout Handling`), []);
    assert.match(nameWarnings(`${prefix} · Fix Login Session Timeout Handling Today`)[0], /this has 6/);
  }
  assert.match(nameWarnings("APP-123 · Fix Login Session Timeout Handling", "Workspace")[0], /Aim for/);
});

test("short purpose names pass", () => {
  assert.deepEqual(nameWarnings("Label Filters", "Mission Control"), []);
});

test("empty, long, and workspace-prefixed names are flagged", () => {
  assert.deepEqual(nameWarnings("   "), ["Enter a name."]);
  assert.match(nameWarnings("can we please implement this new thing")[0], /2–5 words/);
  assert.match(nameWarnings("Mission Control: Label Filters", "Mission Control")[0], /workspace name/);
});

test("a rename made after review blocks the stale apply", () => {
  assert.equal(renameConflict("Old name", "Old name"), null);
  assert.match(renameConflict("Old name", "Newer manual name"), /Newer manual name/);
});
