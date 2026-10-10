import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { test } from "node:test";

const require = createRequire(import.meta.url);
const ts = require("typescript");
require.extensions[".ts"] = (module, file) => module._compile(ts.transpileModule(readFileSync(file, "utf8"), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText, file);
const { toWorkspace } = require("./roster-model.ts");
const { changeSummary, hostAgentsLabel, hostReviewItems, hostReviewLabel, needsYouCount, pullRequestSummary } = require("./host-review-model.ts");

function descriptor(overrides = {}) {
  return {
    id: "w1", projectId: "p1", projectDisplayName: "web-app", projectCustomName: null, name: "main", title: "ABC-1 Subtotals",
    status: "done", statusEnteredAt: "2026-10-07T10:00:00Z", activityAt: null, labels: [], diffStat: null, gitRuntime: null, githubRuntime: null,
    ...overrides,
  };
}
const workspace = overrides => ({ id: "w1", projectId: "p1", projectName: "web-app", name: "ABC-1", status: "done", activityAt: "2026-10-07T10:00:00Z", labels: [], ...overrides });
const agent = overrides => ({ id: "a1", workspaceId: "w1", name: "Implementer", status: "idle", updatedAt: "2026-10-07T10:00:00Z", archivedAt: null, requiresAttention: false, summary: null, ...overrides });

test("a workspace without Paseo's activity time shows its latest agent or status change", () => {
  const agents = [{ workspaceId: "w1", updatedAt: "2026-10-07T12:00:00Z" }, { workspaceId: "other", updatedAt: "2026-10-08T00:00:00Z" }];
  assert.equal(toWorkspace(descriptor(), agents).activityAt, "2026-10-07T12:00:00Z");
  assert.equal(toWorkspace(descriptor(), []).activityAt, "2026-10-07T10:00:00Z");
  assert.equal(toWorkspace(descriptor({ statusEnteredAt: null }), []).activityAt, null);
  assert.equal(toWorkspace(descriptor({ activityAt: "2026-10-01T00:00:00Z" }), agents).activityAt, "2026-10-01T00:00:00Z");
});

test("a workspace keeps Paseo's branch, changes and pull request", () => {
  const result = toWorkspace(descriptor({
    diffStat: { additions: 12, deletions: 3 },
    gitRuntime: { currentBranch: "feature/ABC-1", isDirty: true, aheadOfOrigin: 2 },
    githubRuntime: { pullRequest: { number: 701, url: "https://example.test/pr/701", title: "ABC-1", state: "OPEN", baseRefName: "dev", headRefName: "feature/ABC-1", isMerged: false, isDraft: true, checksStatus: "failure", reviewDecision: "changes_requested" } },
  }), []);
  assert.equal(result.name, "ABC-1 Subtotals");
  assert.deepEqual({ branch: result.branch, diffStat: result.diffStat, dirty: result.dirty, aheadOfOrigin: result.aheadOfOrigin }, { branch: "feature/ABC-1", diffStat: { additions: 12, deletions: 3 }, dirty: true, aheadOfOrigin: 2 });
  assert.equal(changeSummary(result), "+12 −3 · uncommitted · 2 to push");
  assert.equal(pullRequestSummary(result.pullRequest), "PR #701 · draft · checks failing · changes requested");
  assert.equal(changeSummary(toWorkspace(descriptor(), [])), null);
});

test("review lists workspaces labelled Review, then stopped workspaces with changes", () => {
  const workspaces = [
    workspace({ id: "labelled", labels: ["In Review"], activityAt: "2026-10-07T09:00:00Z" }),
    workspace({ id: "labelled-newer", labels: ["Review"], activityAt: "2026-10-07T11:00:00Z" }),
    workspace({ id: "changed", diffStat: { additions: 1, deletions: 0 } }),
    workspace({ id: "running", dirty: true }),
    workspace({ id: "done", labels: ["Done"], dirty: true }),
    workspace({ id: "clean" }),
    workspace({ id: "unpushed", aheadOfOrigin: 1, activityAt: "2026-10-07T12:00:00Z" }),
  ];
  const agents = [
    agent({ id: "old", workspaceId: "labelled", updatedAt: "2026-10-07T08:00:00Z" }),
    agent({ id: "new", workspaceId: "labelled", updatedAt: "2026-10-07T09:00:00Z" }),
    agent({ id: "gone", workspaceId: "labelled", updatedAt: "2026-10-07T10:00:00Z", archivedAt: "2026-10-07T10:00:00Z" }),
    agent({ id: "busy", workspaceId: "running", status: "running" }),
  ];
  const { ready, changed } = hostReviewItems(workspaces, agents);
  assert.deepEqual(ready.map(item => item.workspace.id), ["labelled-newer", "labelled"]);
  assert.deepEqual(ready[1].agents.map(item => item.id), ["new", "old"]);
  assert.deepEqual(changed.map(item => item.workspace.id), ["unpushed", "changed"]);
});

test("bubble labels count what needs the user and what is ready", () => {
  assert.equal(needsYouCount([agent({ requiresAttention: true }), agent({ requiresAttention: true, archivedAt: "x" }), agent()]), 1);
  assert.equal(hostAgentsLabel("Acme", null), "Acme agents");
  assert.equal(hostAgentsLabel("Acme", 1), "Acme agents · 1 needs you");
  assert.equal(hostAgentsLabel("Acme", 3), "Acme agents · 3 need you");
  assert.equal(hostReviewLabel(null), "Review");
  assert.equal(hostReviewLabel({ ready: 2, changed: 5 }), "Review · 2 ready");
  assert.equal(hostReviewLabel({ ready: 0, changed: 5 }), "Review · 5 changed");
  assert.equal(hostReviewLabel({ ready: 0, changed: 0 }), "Review");
  assert.equal(pullRequestSummary({ number: null, url: "u", title: "t", state: "MERGED", draft: false, merged: true, checks: "success", reviewDecision: "approved" }), "PR · merged · checks passing · approved");
});
