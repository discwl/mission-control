import test from "node:test";
import assert from "node:assert/strict";
import { makeReviewBaseline, compareReviewBaseline, restoreReviewBaseline } from "./review-changes-model.ts";
const file = (path, ids, extra = {}) => ({ path, oldPath: null, change: "modified", reviewIds: ids, additions: 1, deletions: 0, truncated: false, ...extra });
const snapshot = (files, extra = {}) => ({ fingerprint: "first", generatedAt: "2026-10-27T00:00:00Z", repoRoot: "C:/repo", branch: "task", head: "abc", base: "since", fromCommit: null, sinceCommit: { sha: "base" }, baseWarning: null, omittedFiles: 0, files, ...extra });
const identity = JSON.stringify(["CNS", "workspace", "coordinator/task"]);

test("repeat review identifies new, changed, removed and unchanged file parts without reading code", () => {
  const baseline = makeReviewBaseline(identity, snapshot([file("same.ts", ["a"]), file("changed.ts", ["b", "c"]), file("removed.ts", ["d"])]));
  const result = compareReviewBaseline(baseline, identity, snapshot([file("same.ts", ["a"]), file("changed.ts", ["b", "new"]), file("new.ts", ["z"])]));
  assert.deepEqual(result.added, ["new.ts"]);
  assert.deepEqual(result.changed, ["changed.ts"]);
  assert.deepEqual(result.removed, ["removed.ts"]);
  assert.equal(result.unchanged, 1);
  assert.equal(result.newParts, 2);
  assert.equal(JSON.stringify(baseline).includes("lines"), false);
});
test("host, workspace, chat/task and persisted identity never cross review baselines", () => {
  const baseline = makeReviewBaseline(identity, snapshot([]));
  assert.equal(restoreReviewBaseline(baseline, "other-host-or-task"), null);
  assert.equal(compareReviewBaseline(baseline, "other-host-or-task", snapshot([])).state, "missing");
  assert.equal(restoreReviewBaseline({ ...baseline, version: 2 }, identity), null);
});
test("scope changes refuse a misleading file comparison while stable branch-point reviews can advance HEAD", () => {
  const first = snapshot([file("a.ts", ["a"])]);
  const baseline = makeReviewBaseline(identity, first);
  assert.equal(compareReviewBaseline(baseline, identity, { ...first, head: "new" }).state, "comparable");
  for (const changed of [{ repoRoot: "other" }, { branch: "other" }, { sinceCommit: { sha: "other" } }, { base: "head" }]) {
    assert.equal(compareReviewBaseline(baseline, identity, { ...first, ...changed }).state, "scope-changed");
  }
  const head = { ...first, base: "head", sinceCommit: null };
  assert.equal(compareReviewBaseline(makeReviewBaseline(identity, head), identity, { ...head, head: "new" }).state, "scope-changed");
});
test("unchanged content IDs survive reordering and line shifts; renames remain visible", () => {
  const first = snapshot([file("a.ts", ["one", "two"], { hunks: [{ header: "@@ 1" }] })]);
  const baseline = makeReviewBaseline(identity, first);
  assert.equal(compareReviewBaseline(baseline, identity, snapshot([file("a.ts", ["two", "one"], { hunks: [{ header: "@@ 9" }] })])).unchanged, 1);
  assert.deepEqual(compareReviewBaseline(baseline, identity, snapshot([file("renamed.ts", ["x"], { oldPath: "a.ts", change: "renamed" })])).added, ["renamed.ts"]);
});
test("omitted and truncated evidence is explicitly partial even when the shown parts match", () => {
  const first = snapshot([file("large.ts", ["one"], { truncated: true })]);
  assert.equal(compareReviewBaseline(makeReviewBaseline(identity, first), identity, first).partial, true);
  const omitted = snapshot([], { omittedFiles: 3 });
  assert.equal(makeReviewBaseline(identity, omitted).partial, true);
});
