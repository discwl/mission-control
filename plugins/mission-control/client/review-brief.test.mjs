import test from "node:test";
import assert from "node:assert/strict";
import { reviewBrief } from "./review-brief-model.ts";

function request(overrides = {}) {
  return { decision: { kind: "review", taskId: "t", runId: "r", serverId: "remote", workspaceId: "w", requestedAt: "2026-10-26T09:00:00Z", gitHead: "abc", gitDirty: false, plain: { built: "Add a customer filter", found: "The old search still works" }, ...overrides }, findings: [], unverifiedFindings: 0 };
}
const task = (decisions = [request()]) => ({ task: { taskId: "t", acceptanceCriteria: ["Find customers by name"] }, run: { runId: "r" }, decisions, problem: null });
const snapshot = { head: "abc", files: [] };
const brief = (entry, snap = snapshot, stale = false) => reviewBrief(entry, "remote", "w", snap, stale);

test("review brief uses authored evidence and criteria, not a generated verdict", () => {
  const result = brief(task());
  assert.equal(result.outcome, "Find customers by name");
  assert.equal(result.summary, "Add a customer filter");
  assert.equal(result.found, "The old search still works");
  assert.match(result.warning, /agent's recorded summary/);
});
test("foreign task, run, workspace and host cannot supply the summary", () => {
  for (const override of [{ taskId: "other" }, { runId: "other" }, { workspaceId: "other" }, { serverId: "personal" }, { kind: "plan" }]) {
    assert.equal(brief(task([request(override)])).summary, null);
  }
  assert.equal(brief({ ...task(), run: null }).summary, null);
});
test("latest request uses absolute time and never falls back to an older plain summary", () => {
  const result = brief(task([request(), request({ requestedAt: "2026-10-26T03:00:00-07:00", plain: null })]));
  assert.equal(result.summary, null);
  assert.equal(result.requestedAt, "2026-10-26T03:00:00-07:00");
});
test("mismatched or stale revisions and dirty trees never imply evidence is current", () => {
  assert.match(brief(task(), { ...snapshot, head: "new" }).warning, /older revision/);
  assert.match(brief(task(), snapshot, true).warning, /older revision/);
  assert.match(brief(task([request({ gitDirty: true })])).warning, /Matching commits alone/);
});
test("missing evidence remains unknown and unresolved findings guide file navigation", () => {
  assert.match(brief(task([])).remaining, /not been reported/);
  const entry = request();
  entry.unverifiedFindings = 2;
  entry.findings = [{ file: "src\\a.ts", status: "awaiting_verification" }, { file: "z.ts", status: "resolved" }];
  const files = [{ path: "z.ts", severity: "high" }, { path: "src/a.ts", severity: "low" }, { path: "b.ts", severity: "medium" }];
  const result = brief(task([entry]), { ...snapshot, files });
  assert.deepEqual(result.files.map(item => item.path), ["src/a.ts", "z.ts", "b.ts"]);
  assert.match(result.remaining, /^1 unresolved.*2 from earlier/);
  assert.equal(files[0].path, "z.ts");
});
