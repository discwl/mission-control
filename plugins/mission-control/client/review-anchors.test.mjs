import assert from "node:assert/strict";
import { test } from "node:test";
import { anchorFor, anchorKey, placeComments, rowKeys } from "./review-anchors.ts";

const hunk = (contentId, lines) => ({ contentId, lines });
const file = hunks => ({ path: "src/a.ts", hunks });
const comment = (commentId, anchor, status = "open") => ({ commentId, path: "src/a.ts", anchor, status, body: "x" });
const line = (kind, old, next, text) => ({ kind, old, new: next, text });

test("comments stay on their line, follow moved text, and report outdated anchors", () => {
  const current = file([hunk("h1", [line("context", 10, 12, "keep()"), line("add", null, 13, "added()")]), hunk("h2", [line("del", 40, null, "gone()")])]);
  const exact = comment("c1", { side: "new", line: 13, contentId: "h1", text: "added()" });
  const moved = comment("c2", { side: "new", line: 5, contentId: "h1", text: "keep()" });
  const removed = comment("c3", { side: "old", line: 40, contentId: "h2", text: "gone()" });
  const outdated = comment("c4", { side: "new", line: 20, contentId: "zz", text: "rewritten()" });
  const whole = comment("c5", null);
  const done = comment("c6", { side: "new", line: 13, contentId: "h1", text: "added()" }, "resolved");
  const placed = placeComments(current, [exact, moved, removed, outdated, whole, done]);
  assert.deepEqual(placed.byLine.get(anchorKey("new", 13)).map(c => c.commentId), ["c1"]);
  assert.deepEqual(placed.byLine.get(anchorKey("new", 12)).map(c => c.commentId), ["c2"], "follows its text to the new line number");
  assert.deepEqual(placed.byLine.get(anchorKey("old", 40)).map(c => c.commentId), ["c3"]);
  assert.deepEqual(placed.outdated.map(c => c.commentId), ["c4"]);
  assert.deepEqual(placed.fileLevel.map(c => c.commentId), ["c5"]);
});

test("anchors pick the right side and rows expose both sides for context lines", () => {
  assert.deepEqual(anchorFor(line("del", 7, null, "x"), "h"), { side: "old", line: 7, contentId: "h", text: "x" });
  assert.deepEqual(anchorFor(line("context", 7, 9, "y"), "h"), { side: "new", line: 9, contentId: "h", text: "y" });
  assert.deepEqual(anchorFor(line("context", 7, 9, "y"), "h", "old"), { side: "old", line: 7, contentId: "h", text: "y" });
  assert.deepEqual(rowKeys(line("context", 7, 9, "y")), ["old:7", "new:9"]);
  assert.deepEqual(rowKeys(line("context", 7, 9, "y"), "new"), ["new:9"]);
  assert.deepEqual(rowKeys(line("meta", null, null, "No newline")), []);
});
